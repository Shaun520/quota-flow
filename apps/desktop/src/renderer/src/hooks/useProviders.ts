import { useCallback, useEffect, useMemo, useState } from 'react'
import { getProviderService } from '../auth/service'
import { ensureFreshSession, isAuthError } from '../auth/session'
import { useAuth } from './useAuth'
import { errMsg } from '../utils/error'
import type {
  ProviderKey,
  ProviderMeta,
  ProviderService,
  QuotaLedgerRow
} from '@quota-flow/db-supabase'

export interface BindingView {
  keyId: string
  accountName: string
  authType: string
  health: 'healthy' | 'expiring' | 'expired' | 'unknown'
  expiresAt: number | null
  isDefault: boolean
  enabled: boolean
  dailyTotal: number
  used: number
  remaining: number
  encryptedKey: string
}

export interface ProviderAgg {
  providerId: string
  name: string
  logo: string
  authType: string
  unitName: string
  defaultDailyQuota: number
  boundCount: number
  enabledCount: number
  health: 'online' | 'degraded' | 'offline' | 'unbound'
  healthLabel: string
  bindings: BindingView[]
}

const HEALTH_LABEL: Record<ProviderAgg['health'], string> = {
  online: '正常',
  degraded: '部分异常',
  offline: '离线',
  unbound: '未绑定'
}

function todayShanghai(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date())
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

function bindHealth(bindings: BindingView[]): ProviderAgg['health'] {
  if (bindings.length === 0) return 'unbound'
  const active = bindings.filter((b) => b.enabled)
  // 全部停用的厂商不参与调度，状态按离线展示（避免误以为仍可被调度）
  if (active.length === 0) return 'offline'
  if (active.some((b) => b.health === 'expired')) return 'offline'
  if (active.some((b) => b.health === 'expiring' || b.health === 'unknown')) return 'degraded'
  return 'online'
}

/* ================= 健康检查（自动但节流）：与数据加载解耦，避免每次切页开窗口风暴 ================= */

const HEALTH_CHECK_INTERVAL_MS = 10 * 60 * 1000 // 同一账号两次自动检查至少间隔 10 分钟
const HEALTH_CHECK_CONCURRENCY = 2 // 同时最多 2 个隐藏窗口

/** keyId -> 本会话最近一次检查尝试时间戳（防并发重复 + 会话内节流） */
const healthCheckAt = new Map<string, number>()

async function runHealthChecks(
  svc: ProviderService,
  userId: string,
  keys: ProviderKey[],
  onResult: (keyId: string, status: string) => void
): Promise<void> {
  const now = Date.now()
  const due = keys.filter((key) => {
    if (key.health_status !== 'unknown') return false
    const lastAttempt = healthCheckAt.get(key.id) ?? 0
    if (now - lastAttempt < HEALTH_CHECK_INTERVAL_MS) return false
    if (key.last_health_check) {
      const last = new Date(key.last_health_check).getTime()
      if (now - last < HEALTH_CHECK_INTERVAL_MS) return false
    }
    return true
  })
  if (due.length === 0) return
  // 先标记再执行，防止并发 effect / 双实例重复触发同一批检查
  for (const key of due) healthCheckAt.set(key.id, now)

  let i = 0
  const workers = Array.from(
    { length: Math.min(HEALTH_CHECK_CONCURRENCY, due.length) },
    async () => {
      while (i < due.length) {
        const key = due[i++]
        try {
          const res = await window.api.providers.healthCheck(key.provider_id, key.encrypted_key)
          const newStatus = res.ok ? res.status : 'unknown'
          await svc.updateHealth(userId, key.id, newStatus)
          onResult(key.id, newStatus)
        } catch {
          // 单个检查失败忽略，不影响其他账号
        }
      }
    }
  )
  await Promise.all(workers)
}

export interface ProvidersResult {
  loading: boolean
  error: string | null
  aggs: ProviderAgg[]
  anyBound: boolean
  totalBound: number
  reload: () => void
  testHealth: (providerId: string, keyId: string) => Promise<void>
  rename: (keyId: string, name: string) => Promise<void>
  setDefault: (providerId: string, keyId: string) => Promise<void>
  setEnabled: (keyId: string, enabled: boolean) => Promise<void>
  unbind: (keyId: string) => Promise<void>
}

export function useProviders(): ProvidersResult {
  const { user } = useAuth()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [providers, setProviders] = useState<ProviderMeta[]>([])
  const [keys, setKeys] = useState<ProviderKey[]>([])
  const [ledgers, setLedgers] = useState<QuotaLedgerRow[]>([])
  const [reloadKey, setReloadKey] = useState(0)
  // 健康检查结果会话内覆盖：只更新 map，不重建 keys 数组，避免下游 memo / 效应链整体重算
  const [healthOverrides, setHealthOverrides] = useState<Record<string, string>>({})

  const reload = useCallback(() => setReloadKey((k) => k + 1), [])

  useEffect(() => {
    let cancelled = false
    const svc = getProviderService()
    if (!svc || !user) {
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    Promise.all([svc.listProviders(), svc.listProviderKeys(user.id), svc.listLedger(user.id)])
      .then(([p, k, l]) => {
        if (cancelled) return
        setProviders(p)
        setKeys(k)
        setLedgers(l)
        // 全量数据已刷新（健康状态已写库并在本次拉取中带回），作废会话内覆盖
        setHealthOverrides({})

        // 对已绑定但缺今日 ledger 行的账号自动初始化额度（按账号，每天 0 点重置）
        const today = todayShanghai()
        const existingTodayKeys = new Set(
          l.filter((row) => row.date === today && row.account_key_id != null).map((row) => row.account_key_id)
        )
        const toInit = k.filter((key) => !existingTodayKeys.has(key.id))
        if (toInit.length > 0) {
          const providerMap = new Map(p.map((pr) => [pr.id, pr]))
          Promise.all(
            toInit.map((key) => {
              const meta = providerMap.get(key.provider_id)
              return svc.getOrInitLedger({
                userId: user.id,
                providerId: key.provider_id,
                unitName: meta?.unit_name ?? '',
                dailyTotal: Number(meta?.default_daily_quota ?? 0),
                keyId: key.id
              })
            })
          ).then(() => {
            if (!cancelled) setReloadKey((k) => k + 1)
          })
        }

      })
      .catch(async (e: unknown) => {
        if (cancelled) return
        if (isAuthError(e)) {
          const guard = await ensureFreshSession()
          if (cancelled) return
          if (guard.ok && guard.refreshed) {
            // 续期成功：重试一次（刷新过才会重试，避免无限循环）
            setReloadKey((k) => k + 1)
            return
          }
          setError(guard.ok ? errMsg(e) : '登录已过期，请重新登录')
        } else {
          setError(errMsg(e))
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [user?.id, reloadKey])

  // 健康检查：与数据加载解耦，keys 就绪后独立运行（节流 + 并发限制，见 runHealthChecks）
  useEffect(() => {
    if (!user || keys.length === 0) return
    let cancelled = false
    const svc = getProviderService()
    if (!svc) return
    void runHealthChecks(svc, user.id, keys, (keyId, status) => {
      if (!cancelled) {
        setHealthOverrides((prev) => ({ ...prev, [keyId]: status }))
      }
    })
    return () => {
      cancelled = true
    }
  }, [user?.id, keys])

  const aggs = useMemo<ProviderAgg[]>(() => {
    const map = new Map<string, BindingView[]>()
    for (const k of keys) {
      const list = map.get(k.provider_id) ?? []
      // 按账号取今日 ledger 行（listLedger 按日期倒序，首条即今天）
      const ledger = ledgers.find((l) => l.account_key_id === k.id)
      const dailyTotal = Number(ledger?.daily_total ?? 0)
      const used = Number(ledger?.used ?? 0)
      const defaultTotal = dailyTotal || 0
      list.push({
        keyId: k.id,
        accountName: k.account_name ?? '绑定账号',
        authType: k.auth_type,
        health: (healthOverrides[k.id] ?? k.health_status) as BindingView['health'],
        expiresAt: k.cookie_expires_at ? new Date(k.cookie_expires_at).getTime() : null,
        isDefault: !!k.is_default,
        enabled: k.enabled !== false,
        dailyTotal: defaultTotal,
        used,
        remaining: Math.max(defaultTotal - used, 0),
        encryptedKey: k.encrypted_key
      })
      map.set(k.provider_id, list)
    }

    return providers.map((p) => {
      const bindings = map.get(p.id) ?? []
      const health = bindHealth(bindings)
      return {
        providerId: p.id,
        name: p.name,
        logo: p.logo ?? p.name.slice(0, 1),
        authType: p.auth_type,
        unitName: p.unit_name ?? '',
        defaultDailyQuota: Number(p.default_daily_quota ?? 0),
        boundCount: bindings.length,
        enabledCount: bindings.filter((b) => b.enabled).length,
        health,
        healthLabel: HEALTH_LABEL[health],
        bindings
      }
    })
  }, [providers, keys, ledgers, healthOverrides])

  const anyBound = keys.length > 0
  const totalBound = keys.length

  const testHealth = useCallback(
    async (providerId: string, keyId: string) => {
      const svc = getProviderService()
      if (!svc || !user) return
      const key = keys.find((k) => k.id === keyId)
      if (!key) return
      try {
        const res = await window.api.providers.healthCheck(providerId, key.encrypted_key)
        const status = res.ok ? res.status : 'unknown'
        await svc.updateHealth(user.id, keyId, status)
        // 手动测试同样计入节流窗口，避免随后自动检查重复触发
        healthCheckAt.set(keyId, Date.now())
        // 会话内即时覆盖展示，无需全量重拉
        setHealthOverrides((prev) => ({ ...prev, [keyId]: status }))
      } catch (e) {
        setError(errMsg(e))
      }
    },
    [user, keys]
  )

  const rename = useCallback(
    async (keyId: string, name: string) => {
      const svc = getProviderService()
      if (!svc || !user) return
      try {
        const trimmed = name.trim()
        await svc.updateAccountName(user.id, keyId, trimmed)
        setKeys((prev) => prev.map((k) => (k.id === keyId ? { ...k, account_name: trimmed } : k)))
      } catch (e) {
        setError(errMsg(e))
      }
    },
    [user]
  )

  const setDefault = useCallback(
    async (providerId: string, keyId: string) => {
      const svc = getProviderService()
      if (!svc || !user) return
      try {
        await svc.setDefaultKey(user.id, providerId, keyId)
        setKeys((prev) =>
          prev.map((k) => (k.provider_id === providerId ? { ...k, is_default: k.id === keyId } : k))
        )
      } catch (e) {
        setError(errMsg(e))
      }
    },
    [user]
  )

  const setEnabled = useCallback(
    async (keyId: string, enabled: boolean) => {
      const svc = getProviderService()
      if (!svc || !user) return
      try {
        await svc.setEnabled(user.id, keyId, enabled)
        setKeys((prev) => prev.map((k) => (k.id === keyId ? { ...k, enabled } : k)))
      } catch (e) {
        setError(errMsg(e))
      }
    },
    [user]
  )

  const unbind = useCallback(
    async (keyId: string) => {
      const svc = getProviderService()
      if (!svc || !user) return
      try {
        await svc.removeProviderKey(user.id, keyId)
        setKeys((prev) => prev.filter((k) => k.id !== keyId))
      } catch (e) {
        setError(errMsg(e))
      }
    },
    [user]
  )

  return { loading, error, aggs, anyBound, totalBound, reload, testHealth, rename, setDefault, setEnabled, unbind }
}
