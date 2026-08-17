import { useCallback, useEffect, useRef, useState } from 'react'
import { getAuthService } from '../auth/service'
import { ensureFreshSession } from '../auth/session'
import { errMsg } from '../utils/error'

export interface CommunityVideo {
  id: string
  title: string
  cover: string
  videoUrl?: string
  durationSec: number
  category: string
  tags: string[]
  prompt: string
  providerHint?: string
}

export interface CommunityVideosResult {
  loading: boolean
  error: string | null
  items: CommunityVideo[]
  reload: () => void
}

const COMMUNITY_VIDEO_FIELDS =
  'id,title,cover_url,video_url,duration_sec,category,tags,prompt,provider_hint,enabled,sort_order,created_at'
const FOCUS_RELOAD_THROTTLE_MS = 30 * 1000

function mapCommunityVideo(row: Record<string, unknown>): CommunityVideo {
  return {
    id: String(row.id ?? ''),
    title: String(row.title ?? ''),
    cover: String(row.cover_url ?? ''),
    videoUrl: row.video_url ? String(row.video_url) : undefined,
    durationSec: Number(row.duration_sec ?? 0),
    category: String(row.category ?? ''),
    tags: Array.isArray(row.tags) ? row.tags.map(String) : [],
    prompt: String(row.prompt ?? ''),
    providerHint: row.provider_hint ? String(row.provider_hint) : undefined
  }
}

export function useCommunityVideos(userId?: string): CommunityVideosResult {
  const [items, setItems] = useState<CommunityVideo[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const inFlightKeyRef = useRef<string | null>(null)
  const lastLoadedAtRef = useRef(0)

  const reload = useCallback(() => {
    setReloadKey((k) => k + 1)
  }, [])

  const load = useCallback(async () => {
    if (!userId) {
      setItems([])
      return
    }
    if (inFlightKeyRef.current === userId) return
    inFlightKeyRef.current = userId
    lastLoadedAtRef.current = Date.now()
    const auth = getAuthService()
    if (!auth) {
      setError('视频灵感库服务未配置')
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
      const { data, error: queryError } = await auth
        .getClient()
        .from('creation_videos')
        .select(COMMUNITY_VIDEO_FIELDS)
        .eq('enabled', true)
        .order('sort_order', { ascending: true })
        .order('created_at', { ascending: true })
        .limit(500)
      if (queryError) throw queryError
      setItems((data ?? []).map((row) => mapCommunityVideo(row as Record<string, unknown>)))
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setLoading(false)
      inFlightKeyRef.current = null
    }
  }, [userId])

  useEffect(() => {
    void load()
  }, [load, reloadKey])

  useEffect(() => {
    if (!userId) return
    const auth = getAuthService()
    if (!auth) return
    const client = auth.getClient()
    const channel = client
      .channel(`creation-videos-changes-${userId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'creation_videos' },
        () => {
          void load()
        }
      )
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

  return { loading, error, items, reload }
}
