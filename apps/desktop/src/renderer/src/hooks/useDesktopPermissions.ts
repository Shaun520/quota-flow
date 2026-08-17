import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  'creation.community'
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
const FOCUS_RELOAD_THROTTLE_MS = 30 * 1000

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

export function useDesktopPermissions(userId?: string, teamId?: string | null): DesktopPermissionsResult {
  const [features, setFeatures] = useState<DesktopFeatureFlags>(() => ({ ...DEFAULT_FEATURES }))
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const inFlightKeyRef = useRef<string | null>(null)
  const lastLoadedAtRef = useRef(0)

  const reload = useCallback(() => setReloadKey((k) => k + 1), [])

  const load = useCallback(async () => {
    if (!userId) {
      setFeatures({ ...DEFAULT_FEATURES })
      return
    }
    const requestKey = `${userId}|${teamId ?? ''}`
    if (inFlightKeyRef.current === requestKey) return
    inFlightKeyRef.current = requestKey
    lastLoadedAtRef.current = Date.now()
    const auth = getAuthService()
    if (!auth) {
      setError('权限配置服务未配置')
      inFlightKeyRef.current = null
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
      const client = auth.getClient()
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

      setFeatures(applyRows(rows, { ...DEFAULT_FEATURES }))
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setLoading(false)
      inFlightKeyRef.current = null
    }
  }, [userId, teamId])

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
        void load()
      })
      .subscribe()

    return () => {
      void client.removeChannel(channel)
    }
  }, [userId, load])

  useEffect(() => {
    const onFocus = (): void => {
      if (Date.now() - lastLoadedAtRef.current < FOCUS_RELOAD_THROTTLE_MS) return
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
