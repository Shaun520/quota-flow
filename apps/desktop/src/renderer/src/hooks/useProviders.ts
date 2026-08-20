import { useCallback, useEffect, useMemo, useState } from 'react'
import { getAuthService, getProviderService } from '../auth/service'
import { ensureFreshSession, isAuthError } from '../auth/session'
import { useAuth } from './useAuth'
import { errMsg } from '../utils/error'
import { getHealthCheckIntervalMs } from '../components/Modals'
import { DEFAULT_SUPPORTED_DURATIONS } from '../spec'
import type {
  ProviderKeySummary,
  ProviderMeta,
  ProviderService,
  QuotaLedgerRow,
  ViewScope
} from '@quota-flow/db-supabase'

export interface BindingView {
  keyId: string
  teamId: string | null
  ownerUserId: string
  accountName: string
  authType: string
  health: 'healthy' | 'expiring' | 'expired' | 'unknown'
  expiresAt: number | null
  isDefault: boolean
  enabled: boolean
  dailyTotal: number
  used: number
  remaining: number
}

export interface ProviderAgg {
  providerId: string
  name: string
  logo: string
  authType: string
  enabled: boolean
  unitName: string
  defaultDailyQuota: number
  durations: number[]
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

function supportedDurations(meta: ProviderMeta): number[] {
  const raw = meta.capabilities?.supported_durations
  if (!Array.isArray(raw)) return [...DEFAULT_SUPPORTED_DURATIONS]
  const durations = raw
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n) && n > 0)
  return durations.length > 0 ? durations : [...DEFAULT_SUPPORTED_DURATIONS]
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

const HEALTH_CHECK_CONCURRENCY = 2 // 同时最多 2 个隐藏窗口

/** keyId -> 本会话最近一次检查尝试时间戳（防并发重复 + 会话内节流） */
const healthCheckAt = new Map<string, number>()

/** 健康检查节流记录所属的 user id；账号切换时清空，避免节流记录串号 */
let healthCheckUserId: string | null = null

/* ============ 智谱 consoleJwt 会话自动续期（静默隐式，后台完成，不打扰用户） ============ */

/** keyId -> 该 key 最近一次续期尝试时间戳（后续期失败节流，避免反复开隐藏窗口） */
const zhipuRenewAt = new Map<string, number>()
/** 全局续期进行中标记：控制台会话分区共享，同一时刻只允许一个账号续期，避免隐藏窗口互抢 */
let zhipuRenewInFlight = false
/** 会话状态扫描周期（毫秒） */
const ZHIPU_SESSION_SCAN_MS = 60 * 1000
/** 同一账号两次续期尝试的最小间隔（毫秒）；续期成功或失败都以此节流 */
const ZHIPU_RENEW_RETRY_MS = 3 * 60 * 1000

async function runHealthChecks(
  svc: ProviderService,
  userId: string,
  keys: ProviderKeySummary[],
  onResult: (keyId: string, status: string) => void
): Promise<void> {
  const now = Date.now()
  // 检查频率来自设置（默认每 4 小时），每次运行读取，设置变更即时生效
  // 全部账号都进入周期性检查（不限 unknown）：healthy 的 cookie 也会过期、expired 也可能恢复
  const intervalMs = getHealthCheckIntervalMs()
  const due = keys.filter((key) => {
    const lastAttempt = healthCheckAt.get(key.id) ?? 0
    if (now - lastAttempt < intervalMs) return false
    if (key.last_health_check) {
      const last = new Date(key.last_health_check).getTime()
      if (now - last < intervalMs) return false
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
          const secret = await svc.getProviderKeySecret(userId, key.id)
          if (!secret) continue
          const res = await window.api.providers.healthCheck(key.provider_id, secret.encrypted_key)
          const newStatus = resolveHealthAfterCheck(res.ok ? res.status : 'unknown', key.cookie_expires_at, now)
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

/** Cookie 距过期不足 3 天视为「将过期」；无过期时间的厂商无法判断，保持检查结果不变 */
const EXPIRING_SOON_MS = 3 * 24 * 60 * 60 * 1000

function resolveHealthAfterCheck(checked: string, expiresAt: string | null, now: number): string {
  if (checked !== 'healthy' || !expiresAt) return checked
  const expiresMs = new Date(expiresAt).getTime()
  if (!Number.isFinite(expiresMs)) return checked
  return expiresMs - now < EXPIRING_SOON_MS ? 'expiring' : 'healthy'
}

export interface ProvidersResult {
  loading: boolean
  refreshing: boolean
  error: string | null
  aggs: ProviderAgg[]
  anyBound: boolean
  totalBound: number
  reload: () => void
  testHealth: (providerId: string, keyId: string) => Promise<void>
  rename: (keyId: string, name: string) => Promise<void>
  setDefault: (providerId: string, keyId: string) => Promise<void>
  setEnabled: (keyId: string, enabled: boolean) => Promise<void>
  setProviderKeyScope: (keyId: string, teamId: string | null) => Promise<void>
  unbind: (keyId: string) => Promise<void>
  /** 智谱等 API 型厂商账号真实额度（平台资源包余额）覆盖，key = keyId */
  zhipuQuotaOverrides: Record<string, { available: boolean; total: number; remaining: number; expired?: boolean }>
  /** 会话内更新某账号健康状态（API Key 测试成功后即时反映） */
  setKeyHealth: (keyId: string, status: string) => void
  /** 智谱各账号控制台会话状态（keyId -> alive/expiring/expired），供态展示与自动续期联动 */
  zhipuSessionStatuses: Record<
    string,
    { hasSession: boolean; status?: 'alive' | 'expiring' | 'expired'; expMs?: number | null; remainingMs?: number | null }
  >
  /** 火山方舟各账号控制台会话状态（keyId -> alive/expiring/expired），供态展示与自动续期联动 */
  volcSessionStatuses: Record<
    string,
    { hasSession: boolean; status?: 'alive' | 'expiring' | 'expired'; expMs?: number | null; remainingMs?: number | null }
  >
  /** 火山方舟账号真实 token 汇总覆盖（keyId -> remaining/total；null 表示已拉取但未拿到真实额度） */
  volcTokenOverrides: Record<string, { remaining: number; total: number } | null>
  /** 阿里云百炼各账号真实免费额度聚合覆盖（keyId -> 账号级剩余/总量），随绑定时的控制台会话捕获落库 */
  bailianQuotaOverrides: Record<string, { available: boolean; total: number; remaining: number; expired?: boolean }>
  /** 火山方舟额度同步：后台静默抓取该账号最新免费模型额度/开通状态并落库；命中返回新加密负载，未抓到返回 false */
  refreshVolcengineModelsOnce: (keyId: string, opts?: { maxStaleMs?: number }) => Promise<string | false>
}

export function useProviders(viewScope: ViewScope = 'personal'): ProvidersResult {
  const { user, team } = useAuth()
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [providers, setProviders] = useState<ProviderMeta[]>([])
  const [keys, setKeys] = useState<ProviderKeySummary[]>([])
  const [ledgers, setLedgers] = useState<QuotaLedgerRow[]>([])
  const [reloadKey, setReloadKey] = useState(0)
  // 健康检查结果会话内覆盖：只更新 map，不重建 keys 数组，避免下游 memo / 效应链整体重算
  const [healthOverrides, setHealthOverrides] = useState<Record<string, string>>({})
  // 智谱等 API 型厂商账号真实额度覆盖（平台资源包余额），key = keyId
  const [zhipuQuotaOverrides, setZhipuQuotaOverrides] = useState<
    Record<string, { available: boolean; total: number; remaining: number; expired?: boolean }>
  >({})
  // 火山方舟账号真实 token 汇总覆盖（该账号所有免费模型 freeQuota 之和），key = keyId。
  // 值为 null 表示已拉取但未拿到真实 token 汇总（用于展示占位，避免误显示账本假额度 50/50）。
  const [volcTokenOverrides, setVolcTokenOverrides] = useState<
    Record<string, { remaining: number; total: number } | null>
  >({})
  // 阿里云百炼各账号真实免费额度聚合覆盖（keyId -> 账号级剩余/总量），随绑定时的控制台会话捕获落库
  const [bailianQuotaOverrides, setBailianQuotaOverrides] = useState<
    Record<string, { available: boolean; total: number; remaining: number; expired?: boolean }>
  >({})

  // 单次拉取智谱某账号真实额度（平台资源包余额）并写入覆盖；返回剩余次数（查询失败返回 null）
  const fetchZhipuQuotaOnce = useCallback(
    async (keyId: string): Promise<number | null> => {
      const svc = getProviderService()
      if (!svc || !user) return null
      try {
        const secret = await svc.getProviderKeySecret(user.id, keyId)
        if (!secret) return null
        const res = await window.api.providers.fetchQuota('zhipu', secret.encrypted_key)
        if (res.ok && res.quota) {
          setZhipuQuotaOverrides((prev) => ({ ...prev, [keyId]: res.quota! }))
          return res.quota.remaining
        }
        return null
      } catch {
        // 额度查询失败不影响生成结果
        return null
      }
    },
    [user]
  )

  // 生成后刷新智谱真实额度：平台扣减有延迟，用 30s 重试窗口（12 次、间隔 2.5s），剩余值下降即提前结束
  const refreshZhipuQuota = useCallback(
    async (keyId: string) => {
      let lastRemaining: number | null = null
      for (let i = 0; i < 12; i++) {
        const remaining = await fetchZhipuQuotaOnce(keyId)
        if (remaining === null) break
        if (lastRemaining !== null && remaining < lastRemaining) break
        lastRemaining = remaining
        if (i < 11) await new Promise((r) => setTimeout(r, 2500))
      }
    },
    [fetchZhipuQuotaOnce]
  )

  // 会话内缓存的各智谱账号控制台会话状态（keyId -> 状态）；续期命中/失败时同步更新
  const [zhipuSessionStatuses, setZhipuSessionStatuses] = useState<
    Record<string, { hasSession: boolean; status?: 'alive' | 'expiring' | 'expired'; expMs?: number | null; remainingMs?: number | null }>
  >({})

  // 对单个智谱账号做一次静默续期：成功则用新加密负载落库并重拉真实额度；全局一次只续一个（共享会话分区）
  const renewZhipuSessionOnce = useCallback(
    async (keyId: string, encrypted: string): Promise<boolean> => {
      if (zhipuRenewInFlight) return false
      zhipuRenewInFlight = true
      zhipuRenewAt.set(keyId, Date.now())
      try {
        const res = await window.api.providers.zhipuRenewSession(keyId, encrypted)
        if (!res.ok || !res.encrypted) return false
        const svc = getProviderService()
        if (svc && user) {
          await svc.refreshProviderKey(user.id, keyId, {
            encryptedKey: res.encrypted,
            healthStatus: 'healthy'
          })
        }
        setZhipuSessionStatuses((prev) => ({
          ...prev,
          [keyId]: { hasSession: true, status: 'alive', expMs: res.expMs ?? null, remainingMs: res.remainingMs ?? null }
        }))
        // 续期成功后重新拉取真实额度，让页面额度显示即时生效
        await fetchZhipuQuotaOnce(keyId)
        return true
      } catch {
        return false
      } finally {
        zhipuRenewInFlight = false
      }
    },
    [user, fetchZhipuQuotaOnce]
  )

  // 扫描所有智谱账号的会话状态：命中 expiring / expired 且未到重试节流时，触发一次静默续期并停止本轮
  const scanZhipuSessions = useCallback(async (): Promise<void> => {
    if (zhipuRenewInFlight) return
    const svc = getProviderService()
    if (!svc || !user) return
    const now = Date.now()
    for (const key of keys.filter((k) => k.provider_id === 'zhipu')) {
      if (now - (zhipuRenewAt.get(key.id) ?? 0) < ZHIPU_RENEW_RETRY_MS) continue
      let secret: { encrypted_key: string } | null = null
      try {
        secret = await svc.getProviderKeySecret(user.id, key.id)
      } catch {
        continue
      }
      if (!secret) continue
      let state
      try {
        state = await window.api.providers.zhipuSessionStatus(key.id, secret.encrypted_key)
      } catch {
        continue
      }
      setZhipuSessionStatuses((prev) => ({ ...prev, [key.id]: state }))
      if (state.hasSession && (state.status === 'expiring' || state.status === 'expired')) {
        await renewZhipuSessionOnce(key.id, secret.encrypted_key)
        return
      }
    }
  }, [user, keys, renewZhipuSessionOnce])

  // 启动智谱会话状态扫描：初始化立即扫一次，之后周期轮询；账号切换时重建
  useEffect(() => {
    if (!user) return
    void scanZhipuSessions()
    const t = setInterval(() => {
      void scanZhipuSessions()
    }, ZHIPU_SESSION_SCAN_MS)
    return () => clearInterval(t)
  }, [user?.id, scanZhipuSessions])

  // 初始化 / 刷新时主动拉取智谱各账号真实额度，覆盖静态默认额度展示为平台实际剩余
  useEffect(() => {
    if (!user || keys.length === 0) return
    const zhipuKeys = keys.filter((k) => k.provider_id === 'zhipu')
    if (zhipuKeys.length === 0) return
    zhipuKeys.forEach((key) => void fetchZhipuQuotaOnce(key.id))
  }, [user?.id, keys, fetchZhipuQuotaOnce])

  /* ================= 火山方舟（volcengine）：控制台会话状态与静默续期（仿智谱） ================= */

  /** 全局续期进行中标记：控制台会话分区共享，同一时刻只允许一个火山账号续期 */
  let volcRenewInFlight = false
  /** keyId -> 该火山账号最近一次续期尝试时间戳（失败节流） */
  const volcRenewAt = new Map<string, number>()
  /** 火山各账号控制台会话状态（keyId -> alive/expiring/expired），供态展示与自动续期联动 */
  const [volcSessionStatuses, setVolcSessionStatuses] = useState<
    Record<string, { hasSession: boolean; status?: 'alive' | 'expiring' | 'expired'; expMs?: number | null; remainingMs?: number | null }>
  >({})

  // 单次拉取火山某账号真实额度并写入覆盖（额度接口待探测，接口可用后即生效）；当前查询失败回退本地账本
  const fetchVolcengineQuotaOnce = useCallback(
    async (keyId: string): Promise<number | null> => {
      const svc = getProviderService()
      if (!svc || !user) return null
      try {
        const secret = await svc.getProviderKeySecret(user.id, keyId)
        if (!secret) return null
        const res = await window.api.providers.fetchQuota('volcengine', secret.encrypted_key)
        if (res.ok && res.quota) return res.quota.remaining
        return null
      } catch {
        return null
      }
    },
    [user]
  )

  // 拉取火山某账号真实 token 汇总（该账号所有免费模型 freeQuota 之和），并写入覆盖。
  // 口径与「查看模型」弹窗 ModelsQuotaSummary 一致：聚合 cost 0 且 freeQuota?.total 存在的模型。
  // 未取到任何真实额度时写 null（前端据此显示占位，而不是账本假额度 50/50）。
  const fetchVolcTokenSummaryOnce = useCallback(
    async (keyId: string): Promise<void> => {
      const svc = getProviderService()
      if (!svc || !user) return
      let found = false
      try {
        const secret = await svc.getProviderKeySecret(user.id, keyId)
        if (!secret) return
        const res = await window.api.providers.apiModels('volcengine', secret.encrypted_key)
        const models = res.ok ? res.models : undefined
        if (Array.isArray(models) && models.length > 0) {
          let total = 0
          let remaining = 0
          // 总数：含所有免费模型（已开通 + 未开通）
          // 可用：只计已开通（activated !== false）模型的可用量
          for (const m of models) {
            if (m.cost === 0 && m.freeQuota && typeof m.freeQuota.total === 'number' && m.freeQuota.total > 0) {
              total += m.freeQuota.total
              if (m.activated !== false && typeof m.freeQuota.remaining === 'number') {
                remaining += m.freeQuota.remaining
              }
            }
          }
          if (total > 0) {
            found = true
            setVolcTokenOverrides((prev) => ({ ...prev, [keyId]: { remaining, total } }))
          }
        }
      } catch {
        // 拉取失败不阻断
      }
      if (!found) {
        setVolcTokenOverrides((prev) => ({ ...prev, [keyId]: null }))
      }
    },
    [user]
  )

  // 单次拉取阿里云百炼某账号真实免费额度聚合（payload 中的账号级快照）并写入覆盖；未取到返回 false
  const fetchBailianQuotaOnce = useCallback(
    async (keyId: string): Promise<boolean> => {
      const svc = getProviderService()
      if (!svc || !user) return false
      try {
        const secret = await svc.getProviderKeySecret(user.id, keyId)
        if (!secret) return false
        const res = await window.api.providers.fetchQuota('bailian', secret.encrypted_key)
        if (res.ok && res.quota) {
          setBailianQuotaOverrides((prev) => ({ ...prev, [keyId]: res.quota! }))
          return true
        }
        return false
      } catch {
        return false
      }
    },
    [user]
  )

  // 对单个火山账号做一次静默续期：成功则用新加密负载落库并重拉真实额度；全局一次只续一个（共享会话分区）
  const renewVolcSessionOnce = useCallback(
    async (keyId: string, encrypted: string): Promise<boolean> => {
      if (volcRenewInFlight) return false
      volcRenewInFlight = true
      volcRenewAt.set(keyId, Date.now())
      try {
        const res = await window.api.providers.volcRenewSession(keyId, encrypted)
        if (!res.ok || !res.encrypted) return false
        const svc = getProviderService()
        if (svc && user) {
          await svc.refreshProviderKey(user.id, keyId, {
            encryptedKey: res.encrypted,
            healthStatus: 'healthy'
          })
        }
        setVolcSessionStatuses((prev) => ({
          ...prev,
          [keyId]: { hasSession: true, status: 'alive', expMs: res.expMs ?? null, remainingMs: res.remainingMs ?? null }
        }))
        await fetchVolcengineQuotaOnce(keyId)
        return true
      } catch {
        return false
      } finally {
        volcRenewInFlight = false
      }
    },
    [user, fetchVolcengineQuotaOnce]
  )

  // 火山方舟额度同步：后台复用该账号分区登录态静默抓取最新免费模型额度/开通状态并落库。
  // 命中（抓到新 models）则用重建的加密负载更新 DB 并返回新 encrypted，供「查看模型」即时展示；
  // 未抓到（登录态失效/页面未就绪）保留旧值返回 false，不打断调用方。
  const refreshVolcengineModelsOnce = useCallback(
    async (keyId: string, opts?: { maxStaleMs?: number }): Promise<string | false> => {
      const svc = getProviderService()
      if (!svc || !user) return false
      try {
        const secret = await svc.getProviderKeySecret(user.id, keyId)
        if (!secret) return false
        const res = await window.api.providers.volcSyncModels(keyId, secret.encrypted_key, opts?.maxStaleMs)
        if (res.cached) return false // 命中缓存：数据仍新鲜，无需回写与返回
        if (!res.ok || res.preserved || !res.encrypted) return false
        await svc.refreshProviderKey(user.id, keyId, {
          encryptedKey: res.encrypted,
          healthStatus: 'healthy',
          // 同步回填账号级指纹：抓到的 accountId 稳定后重算指纹入库，同账号多 Key 共享，去重提示才命中
          accountFingerprint: res.accountFingerprint ?? null
        })
        return res.encrypted
      } catch {
        return false
      }
    },
    [user]
  )

  // 扫描所有火山账号的会话状态：命中 expiring / expired 且未到重试节流时，触发一次静默续期并停止本轮
  const scanVolcSessions = useCallback(async (): Promise<void> => {
    if (volcRenewInFlight) return
    const svc = getProviderService()
    if (!svc || !user) return
    const now = Date.now()
    for (const key of keys.filter((k) => k.provider_id === 'volcengine')) {
      if (now - (volcRenewAt.get(key.id) ?? 0) < ZHIPU_RENEW_RETRY_MS) continue
      let secret: { encrypted_key: string } | null = null
      try {
        secret = await svc.getProviderKeySecret(user.id, key.id)
      } catch {
        continue
      }
      if (!secret) continue
      let state
      try {
        state = await window.api.providers.volcSessionStatus(key.id, secret.encrypted_key)
      } catch {
        continue
      }
      setVolcSessionStatuses((prev) => ({ ...prev, [key.id]: state }))
      if (state.hasSession && (state.status === 'expiring' || state.status === 'expired')) {
        await renewVolcSessionOnce(key.id, secret.encrypted_key)
        return
      }
    }
  }, [user, keys, renewVolcSessionOnce])

  // 启动火山会话状态扫描：初始化立即扫一次，之后周期轮询；账号切换时重建
  useEffect(() => {
    if (!user) return
    void scanVolcSessions()
    const t = setInterval(() => {
      void scanVolcSessions()
    }, ZHIPU_SESSION_SCAN_MS)
    return () => clearInterval(t)
  }, [user?.id, scanVolcSessions])

  // 初始化 / 刷新时主动拉取火山各账号真实额度
  useEffect(() => {
    if (!user || keys.length === 0) return
    const volcKeys = keys.filter((k) => k.provider_id === 'volcengine')
    if (volcKeys.length === 0) return
    volcKeys.forEach((key) => void fetchVolcengineQuotaOnce(key.id))
  }, [user?.id, keys, fetchVolcengineQuotaOnce])

  // 初始化 / 刷新时主动拉取火山各账号真实 token 汇总（供厂商列表行展示，替代账本假额度 50/50）
  useEffect(() => {
    if (!user || keys.length === 0) return
    const volcKeys = keys.filter((k) => k.provider_id === 'volcengine')
    if (volcKeys.length === 0) return
    volcKeys.forEach((key) => void fetchVolcTokenSummaryOnce(key.id))
  }, [user?.id, keys, fetchVolcTokenSummaryOnce])

  // 初始化 / 刷新时主动拉取阿里云百炼各账号真实免费额度聚合（payload 账号级快照）
  useEffect(() => {
    if (!user || keys.length === 0) return
    const bailianKeys = keys.filter((k) => k.provider_id === 'bailian')
    if (bailianKeys.length === 0) return
    bailianKeys.forEach((key) => void fetchBailianQuotaOnce(key.id))
  }, [user?.id, keys, fetchBailianQuotaOnce])

  // 会话内覆盖某账号健康状态（API Key 测试成功/失败后即时反映，不落库）
  const setKeyHealth = useCallback((keyId: string, status: string) => {
    setHealthOverrides((prev) => ({ ...prev, [keyId]: status }))
  }, [])

  const reload = useCallback(() => setReloadKey((k) => k + 1), [])

  // 组件实例挂载时（MainApp key=user.id 保证账号切换即重建）检查账号是否变化：
  // 变化则清空上一账号残留的健康检查节流记录。不放在数据加载 effect 的 cleanup 里，
  // 否则 reload（reloadKey 变化）也会误清空、导致节流失效。
  useEffect(() => {
    const uid = user?.id ?? null
    if (uid !== healthCheckUserId) {
      healthCheckUserId = uid
      healthCheckAt.clear()
    }
  }, [user?.id])

  useEffect(() => {
    let cancelled = false
    const svc = getProviderService()
    if (!svc || !user) {
      setLoading(false)
      setRefreshing(false)
      return
    }
    // 仅首次加载显示 loading；reload 时保留旧数据，避免保存/操作后列表闪空白等待
    const isFirstLoad = providers.length === 0 && keys.length === 0
    if (isFirstLoad) setLoading(true)
    else setRefreshing(true)
    setError(null)
    const loadScopedData = async (): Promise<{
      providers: ProviderMeta[]
      keys: ProviderKeySummary[]
      ledgers: QuotaLedgerRow[]
    }> => {
      const [p] = await Promise.all([svc.listAllProviders()])
      if (viewScope === 'personal') {
        const personalKeys = (await svc.listProviderKeys(user.id)).filter((k) => !k.team_id)
        const personalLedgers = await svc.listTodayLedger(user.id)
        return { providers: p, keys: personalKeys, ledgers: personalLedgers }
      }
      if (viewScope === 'team') {
        if (!team) return { providers: p, keys: [], ledgers: [] }
        const teamKeys = await svc.listTeamProviderKeys(team.id)
        const teamLedgers = await svc.listTeamTodayLedger(team.id)
        return { providers: p, keys: teamKeys, ledgers: teamLedgers }
      }
      const [personalKeys, teamKeys, personalLedgers, teamLedgers] = await Promise.all([
        svc.listProviderKeys(user.id).then((all) => all.filter((k) => !k.team_id)),
        team ? svc.listTeamProviderKeys(team.id) : Promise.resolve<ProviderKeySummary[]>([]),
        svc.listTodayLedger(user.id),
        team ? svc.listTeamTodayLedger(team.id) : Promise.resolve<QuotaLedgerRow[]>([])
      ])
      const seenKeys = new Set<string>()
      const keys = [...personalKeys, ...teamKeys].filter((k) => {
        if (seenKeys.has(k.id)) return false
        seenKeys.add(k.id)
        return true
      })
      const seenLedgers = new Set<string>()
      const ledgers = [...personalLedgers, ...teamLedgers].filter((l) => {
        if (seenLedgers.has(l.id)) return false
        seenLedgers.add(l.id)
        return true
      })
      return { providers: p, keys, ledgers }
    }

    loadScopedData()
      .then(async ({ providers: p, keys: k, ledgers: l }) => {
        if (cancelled) return
        setProviders(p)
        setKeys(k)
        setLedgers(l)
        // 全量数据已刷新（健康状态已写库并在本次拉取中带回），作废会话内覆盖
        setHealthOverrides({})

        // 对已绑定但缺今日 ledger 行的账号自动初始化额度（按账号，每天 0 点重置）
        const today = todayShanghai()
        const existingTodayKeys = new Set(
          l
            .filter((row) => row.date === today && row.account_key_id != null)
            .map((row) => `${row.account_key_id}:${row.team_id ?? 'personal'}`)
        )
        const toInit = k.filter((key) => !existingTodayKeys.has(`${key.id}:${key.team_id ?? 'personal'}`))
        if (toInit.length > 0) {
          const personalToInit = toInit.filter((key) => !key.team_id)
          const teamToInit = toInit.filter((key) => key.team_id)
          const initRows: QuotaLedgerRow[] = []
          if (personalToInit.length > 0) {
            const rows = await svc.ensureProviderLedgerRows(user.id, null, personalToInit.map((key) => key.id))
            initRows.push(...rows)
          }
          if (teamToInit.length > 0 && team) {
            const rows = await svc.ensureProviderLedgerRows(user.id, team.id, teamToInit.map((key) => key.id))
            initRows.push(...rows)
          }
          if (cancelled) return
          const nextLedgers = new Map<string, QuotaLedgerRow>()
          for (const row of [...l, ...initRows]) nextLedgers.set(row.id, row)
          setLedgers(
            [...nextLedgers.values()].sort((a, b) => {
              const dateDiff = b.date.localeCompare(a.date)
              if (dateDiff !== 0) return dateDiff
              return String(a.account_key_id ?? '').localeCompare(String(b.account_key_id ?? ''))
            })
          )
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
        if (!cancelled) {
          setLoading(false)
          setRefreshing(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [user?.id, team?.id, viewScope, reloadKey])

  // 后台停用/启用 providers.enabled 时，通过 Supabase Realtime 拉取最新厂商列表。
  // 桌面端保留全部 admin 配置的厂商；停用厂商在新增厂商弹窗中置灰不可选。
  useEffect(() => {
    if (!user) return
    const auth = getAuthService()
    if (!auth) return
    const client = auth.getClient()
    const channel = client
      .channel('providers-enabled-changes')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'providers' },
        () => {
          const svc = getProviderService()
          if (!svc) return
          void svc
            .listAllProviders()
            .then(setProviders)
            .catch(() => {
              // 实时事件失败不打断当前 UI，下次 reload / 重新登录会恢复。
            })
        }
      )
      .subscribe()

    return () => {
      void client.removeChannel(channel)
    }
  }, [user?.id])

  useEffect(() => {
    if (!user) return
    return window.api.dispatch.onQuotaUpdated((payload) => {
      if (payload.userId !== user.id) return
      // API 型厂商（智谱）生成完成：只刷新该账号真实额度，不更新本地账本
      if (payload.zhipuRefreshKeyId) {
        void refreshZhipuQuota(payload.zhipuRefreshKeyId)
        return
      }
      // 火山方舟生成完成：静默同步该账号免费模型真实剩余额度（开通管理页抓取），并刷新账本
      if (payload.volcRefreshKeyId) {
        void refreshVolcengineModelsOnce(payload.volcRefreshKeyId)
        // 同步后重拉该账号真实额度，让页面剩余展示即时生效
        void fetchVolcengineQuotaOnce(payload.volcRefreshKeyId)
      }
      const ledger = payload.ledger
      setLedgers((prev) => {
        const idx = prev.findIndex((l) => l.id === ledger.id)
        if (idx >= 0) {
          const next = [...prev]
          next[idx] = ledger
          return next
        }
        return [ledger, ...prev]
      })
    })
  }, [user?.id, refreshZhipuQuota, refreshVolcengineModelsOnce, fetchVolcengineQuotaOnce])

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
      // 按账号取今日 ledger 行
      const ledger = ledgers.find(
        (l) =>
          l.account_key_id === k.id &&
          (k.team_id == null ? l.team_id == null : l.team_id === k.team_id)
      )
      const dailyTotal = Number(ledger?.daily_total ?? 0)
      const used = Number(ledger?.used ?? 0)
      const defaultTotal = dailyTotal || 0
      list.push({
        keyId: k.id,
        teamId: k.team_id ?? null,
        ownerUserId: k.owner_user_id,
        accountName: k.account_name ?? '绑定账号',
        authType: k.auth_type,
        health: (healthOverrides[k.id] ?? k.health_status) as BindingView['health'],
        expiresAt: k.cookie_expires_at ? new Date(k.cookie_expires_at).getTime() : null,
        isDefault: !!k.is_default,
        enabled: k.enabled !== false,
        dailyTotal: defaultTotal,
        used,
        remaining: Math.max(defaultTotal - used, 0)
      })
      map.set(k.provider_id, list)
    }

    return providers.map((p) => {
      const bindings = map.get(p.id) ?? []
      const health = p.enabled === false ? 'offline' : bindHealth(bindings)
      return {
        providerId: p.id,
        name: p.name,
        logo: p.logo || p.name.slice(0, 1),
        authType: p.auth_type,
        enabled: p.enabled !== false,
        unitName: p.unit_name ?? '',
        defaultDailyQuota: Number(p.default_daily_quota ?? 0),
        durations: supportedDurations(p),
        boundCount: bindings.length,
        enabledCount: bindings.filter((b) => b.enabled).length,
        health,
        healthLabel: p.enabled === false ? '已停用' : HEALTH_LABEL[health],
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
      try {
        const key = keys.find((k) => k.id === keyId)
        if (!key) return
        const secret = await svc.getProviderKeySecret(user.id, keyId)
        if (!secret) return
        const res = await window.api.providers.healthCheck(providerId, secret.encrypted_key)
        const status = resolveHealthAfterCheck(res.ok ? res.status : 'unknown', key.cookie_expires_at, Date.now())
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

  const setProviderKeyScope = useCallback(
    async (keyId: string, teamId: string | null) => {
      const svc = getProviderService()
      if (!svc || !user) return
      try {
        await svc.setProviderKeyScope(keyId, teamId)
        setKeys((prev) => {
          const next = prev.map((k) => (k.id === keyId ? { ...k, team_id: teamId } : k))
          if (viewScope === 'personal') return next.filter((k) => !k.team_id)
          if (viewScope === 'team') return next.filter((k) => k.team_id === team?.id)
          return next
        })
        // 归属变化会影响账号对应的 ledger 行，直接重拉并补初始化目标作用域的今日额度。
        reload()
      } catch (e) {
        setError(errMsg(e))
      }
    },
    [user, viewScope, team?.id, reload]
  )

  return {
    loading,
    refreshing,
    error,
    aggs,
    anyBound,
    totalBound,
    reload,
    testHealth,
    rename,
    setDefault,
    setEnabled,
    setProviderKeyScope,
    unbind,
    zhipuQuotaOverrides,
    setKeyHealth,
    zhipuSessionStatuses,
    volcSessionStatuses,
    volcTokenOverrides,
    bailianQuotaOverrides,
    refreshVolcengineModelsOnce
  }
}
