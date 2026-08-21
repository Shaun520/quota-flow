import { useCallback, useEffect, useMemo, useState } from 'react'
import { getAuthService } from '../auth/service'
import { ensureFreshSession } from '../auth/session'
import { errMsg } from '../utils/error'

export const DESKTOP_FEATURE_KEYS = [
  'tab.dispatch',
  'tab.providers',
  'tab.history',
  'tab.team',
  'tab.creation',
  'dispatch.text2video',
  'dispatch.img2video',
  'dispatch.multi_ref',
  'dispatch.first_last',
  'dispatch.first_frame',
  'providers.bind',
  'history.detail',
  'history.regenerate',
  'history.copy_prompt',
  'history.watermark_removal',
  'creation.ai_toolbox',
  'creation.watermark',
  'creation.prompt_expander',
  'creation.storyboard',
  'creation.video_library',
  'creation.community',
  'creation.material_library'
] as const

export type DesktopFeatureKey = (typeof DESKTOP_FEATURE_KEYS)[number]

export type DesktopFeatureFlags = Record<DesktopFeatureKey, boolean>

export interface DesktopPermissionsResult {
  loading: boolean
  error: string | null
  features: DesktopFeatureFlags
  reload: () => void
}

const DEFAULT_FEATURES = Object.fromEntries(
  DESKTOP_FEATURE_KEYS.map((key) => [key, true])
) as DesktopFeatureFlags

interface PermissionRow {
  target_type: 'global' | 'team'
  target_id: string | null
  feature_key: string
  enabled: boolean
}

function applyRows(rows: PermissionRow[], features: DesktopFeatureFlags): DesktopFeatureFlags {
  const next = { ...features }
  for (const row of rows) {
    if (DESKTOP_FEATURE_KEYS.includes(row.feature_key as DesktopFeatureKey)) {
      next[row.feature_key as DesktopFeatureKey] = !!row.enabled
    }
  }
  return next
}

/* 权限开关是低变数据：窗口 focus 高频触发重载会反复打库（Source 里 desktop_permissions 调用量高）。
 * 用进程内 TTL 合并 focus 风暴；realtime 变更与显式 reload() 强制绕过，保证不被陈旧值卡住。 */
interface PermCacheEntry {
  at: number
  features: DesktopFeatureFlags
}
const permCache = new Map<string, PermCacheEntry>()
const PERM_CACHE_TTL_MS = 10_000

/** 拉取 global +（可选）team 权限，返回原始行 */
async function fetchRows(
  client: ReturnType<NonNullable<ReturnType<typeof getAuthService>>['getClient']>,
  userId: string,
  teamId?: string | null
): Promise<PermissionRow[]> {
  const { data: globalRows, error: globalError } = await client
    .from('desktop_permissions')
    .select('target_type,target_id,feature_key,enabled')
    .eq('target_type', 'global')
    .is('target_id', null)
  if (globalError) throw globalError

  const rows = [...((globalRows ?? []) as PermissionRow[])]
  if (teamId) {
    const { data: teamRows, error: teamError } = await client
      .from('desktop_permissions')
      .select('target_type,target_id,feature_key,enabled')
      .eq('target_type', 'team')
      .eq('target_id', teamId)
    if (teamError) throw teamError
    rows.push(...((teamRows ?? []) as PermissionRow[]))
  }
  return rows
}

export function useDesktopPermissions(userId?: string, teamId?: string | null): DesktopPermissionsResult {
  const [features, setFeatures] = useState<DesktopFeatureFlags>(() => ({ ...DEFAULT_FEATURES }))
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  const load = useCallback(
    async (force = false) => {
      if (!userId) {
        setFeatures({ ...DEFAULT_FEATURES })
        return
      }
      const cacheKey = `${userId}|${teamId ?? ''}`
      // focus 触发的重载在 TTL 内直接复用缓存，避免反复打库；force 绕过（realtime / 显式 reload）
      if (!force) {
        const hit = permCache.get(cacheKey)
        if (hit && Date.now() - hit.at < PERM_CACHE_TTL_MS) {
          setFeatures({ ...hit.features })
          setLoading(false)
          setError(null)
          return
        }
      }
      const auth = getAuthService()
      if (!auth) {
        setError('权限配置服务未配置')
        return
      }
      setLoading(true)
      setError(null)
      try {
        const guard = await ensureFreshSession()
        if (!guard.ok) {
          setError('登录已过期，请重新登录')
          return
        }
        const rows = await fetchRows(auth.getClient(), userId, teamId)
        const next = applyRows(rows, { ...DEFAULT_FEATURES })
        setFeatures(next)
        permCache.set(cacheKey, { at: Date.now(), features: next })
      } catch (e) {
        setError(errMsg(e))
      } finally {
        setLoading(false)
      }
    },
    [userId, teamId]
  )

  const reload = useCallback(() => {
    void load(true)
    setReloadKey((k) => k + 1)
  }, [load])

  useEffect(() => {
    void load()
  }, [load, reloadKey])

  useEffect(() => {
    if (!userId) return
    const auth = getAuthService()
    if (!auth) return
    const client = auth.getClient()
    const channel = client
      .channel(`desktop-permissions-changes-${userId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'desktop_permissions' }, () => {
        void load(true)
      })
      .subscribe()

    return () => {
      void client.removeChannel(channel)
    }
  }, [userId, load])

  useEffect(() => {
    const onFocus = (): void => {
      void load()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [load])

  return useMemo(
    () => ({ loading, error, features, reload }),
    [loading, error, features, reload]
  )
}
