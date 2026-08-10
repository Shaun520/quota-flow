import { useCallback, useEffect, useMemo, useState } from 'react'
import { getProviderService } from '../auth/service'
import { useAuth } from './useAuth'
import { errMsg } from '../utils/error'
import type { ProviderKey, ProviderMeta, QuotaLedgerRow } from '@quota-flow/db-supabase'

export interface BindingView {
  keyId: string
  accountName: string
  authType: string
  health: 'healthy' | 'expiring' | 'expired' | 'unknown'
  expiresAt: number | null
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

function bindHealth(bindings: BindingView[]): ProviderAgg['health'] {
  if (bindings.length === 0) return 'unbound'
  if (bindings.some((b) => b.health === 'expired')) return 'offline'
  if (bindings.some((b) => b.health === 'expiring' || b.health === 'unknown')) return 'degraded'
  return 'online'
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

        // 对已绑定但缺今日 ledger 行的厂商自动初始化额度
        const today = new Date().toISOString().slice(0, 10)
        const boundProviders = new Set(k.map((key) => key.provider_id))
        const existingLedgerProviders = new Set(
          l.filter((row) => row.date === today).map((row) => row.provider_id)
        )
        const toInit = [...boundProviders].filter((pid) => !existingLedgerProviders.has(pid))
        if (toInit.length === 0) return

        const providerMap = new Map(p.map((pr) => [pr.id, pr]))
        Promise.all(
          toInit.map((pid) => {
            const meta = providerMap.get(pid)
            return svc.getOrInitLedger({
              userId: user.id,
              providerId: pid,
              unitName: meta?.unit_name ?? '',
              dailyTotal: Number(meta?.default_daily_quota ?? 0)
            })
          })
        ).then(() => {
          if (!cancelled) setReloadKey((k) => k + 1)
        })
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(errMsg(e))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [user, reloadKey])

  const aggs = useMemo<ProviderAgg[]>(() => {
    const map = new Map<string, BindingView[]>()
    for (const k of keys) {
      const list = map.get(k.provider_id) ?? []
      const ledger =
        ledgers.find((l) => l.provider_id === k.provider_id && (l.account_key_id ?? null) === null) ??
        ledgers.find((l) => l.account_key_id === k.id)
      const dailyTotal = Number(ledger?.daily_total ?? 0)
      const used = Number(ledger?.used ?? 0)
      const defaultTotal = dailyTotal || 0
      list.push({
        keyId: k.id,
        accountName: k.account_name ?? '绑定账号',
        authType: k.auth_type,
        health: k.health_status as BindingView['health'],
        expiresAt: k.cookie_expires_at ? new Date(k.cookie_expires_at).getTime() : null,
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
        health,
        healthLabel: HEALTH_LABEL[health],
        bindings
      }
    })
  }, [providers, keys, ledgers])

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
        await svc.updateHealth(user.id, keyId, res.ok ? res.status : 'unknown')
        reload()
      } catch (e) {
        setError(errMsg(e))
      }
    },
    [user, keys, reload]
  )

  const rename = useCallback(
    async (keyId: string, name: string) => {
      const svc = getProviderService()
      if (!svc || !user) return
      try {
        await svc.updateAccountName(user.id, keyId, name.trim())
        reload()
      } catch (e) {
        setError(errMsg(e))
      }
    },
    [user, reload]
  )

  const unbind = useCallback(
    async (keyId: string) => {
      const svc = getProviderService()
      if (!svc || !user) return
      try {
        await svc.removeProviderKey(user.id, keyId)
        reload()
      } catch (e) {
        setError(errMsg(e))
      }
    },
    [user, reload]
  )

  return { loading, error, aggs, anyBound, totalBound, reload, testHealth, rename, unbind }
}