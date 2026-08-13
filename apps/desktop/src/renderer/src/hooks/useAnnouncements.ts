import { useCallback, useEffect, useState } from 'react'
import { getAuthService } from '../auth/service'
import { ensureFreshSession } from '../auth/session'
import { errMsg } from '../utils/error'

export type DesktopAnnouncementKind = 'notice' | 'update'

export interface DesktopAnnouncement {
  id: string
  title: string
  content: string
  kind: DesktopAnnouncementKind
  target: 'all' | 'team'
  published: boolean
  created_at: string
  updated_at: string | null
  deleted_at: string | null
}

export interface AnnouncementsResult {
  loading: boolean
  error: string | null
  items: DesktopAnnouncement[]
  reload: () => void
}

export function useAnnouncements(userId?: string): AnnouncementsResult {
  const [items, setItems] = useState<DesktopAnnouncement[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  const reload = useCallback(() => {
    setReloadKey((k) => k + 1)
  }, [])

  const load = useCallback(async () => {
    if (!userId) {
      setItems([])
      return
    }
    const auth = getAuthService()
    if (!auth) {
      setError('通知服务未配置')
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
        .from('announcements')
        .select('id,title,content,kind,target,published,created_at,updated_at,deleted_at')
        .eq('target', 'all')
        .eq('published', true)
        .is('deleted_at', null)
        .order('created_at', { ascending: false })
        .limit(50)
      if (queryError) throw queryError
      setItems((data ?? []) as DesktopAnnouncement[])
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setLoading(false)
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
      .channel(`announcements-changes-${userId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'announcements' },
        () => {
          void load()
        }
      )
      .subscribe()

    return () => {
      void client.removeChannel(channel)
    }
  }, [userId, load])

  return { loading, error, items, reload }
}
