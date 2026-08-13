import { useEffect, useMemo, useRef, useState } from 'react'
import { IconBell, IconRefresh } from './icons'
import { Modal } from './Modals'
import { useAnnouncements } from '../hooks/useAnnouncements'
import type { DesktopAnnouncement } from '../hooks/useAnnouncements'

function readStorageKey(userId: string): string {
  return `qf:announcements:read:${userId}`
}

function loadReadIds(userId: string): string[] {
  try {
    const raw = localStorage.getItem(readStorageKey(userId))
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

function saveReadIds(userId: string, ids: string[]): void {
  try {
    localStorage.setItem(readStorageKey(userId), JSON.stringify(ids))
  } catch {
    // ignore
  }
}

function noticeKindLabel(kind: DesktopAnnouncement['kind']): string {
  return kind === 'update' ? '版本更新' : '公告'
}

function noticeTime(value: string): string {
  if (!value) return ''
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(d)
}

export function NotificationBell({ userId }: { userId: string }) {
  const { items, loading, error, reload } = useAnnouncements(userId)
  const [open, setOpen] = useState(false)
  const [detail, setDetail] = useState<DesktopAnnouncement | null>(null)
  const [readIds, setReadIds] = useState<string[]>(() => loadReadIds(userId))
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setReadIds(loadReadIds(userId))
  }, [userId])

  useEffect(() => {
    if (!open) return
    reload()
    const onDocClick = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, reload])

  const unread = useMemo(() => {
    const read = new Set(readIds)
    return items.filter((item) => !read.has(item.id)).length
  }, [items, readIds])

  const markRead = (item: DesktopAnnouncement): void => {
    setReadIds((prev) => {
      if (prev.includes(item.id)) return prev
      const next = [...prev, item.id]
      saveReadIds(userId, next)
      return next
    })
    setDetail(item)
  }

  return (
    <div className="notification-wrap" ref={rootRef}>
      <button
        className={'notification-button' + (open ? ' active' : '')}
        onClick={() => {
          setOpen((v) => {
            const next = !v
            if (next) reload()
            return next
          })
        }}
        aria-label="通知"
        aria-expanded={open}
      >
        <IconBell size={16} />
        {unread > 0 ? <span className="notification-badge">{unread > 99 ? '99+' : unread}</span> : null}
      </button>

      {open ? (
        <div className="notification-dropdown">
          <div className="notification-dropdown-header">
            <span>通知</span>
            <button className="notification-refresh" onClick={() => reload()} aria-label="刷新通知">
              <IconRefresh size={13} />
            </button>
          </div>
          {loading ? (
            <div className="notification-empty">加载中...</div>
          ) : error ? (
            <div className="notification-empty">{error}</div>
          ) : items.length === 0 ? (
            <div className="notification-empty">暂无通知</div>
          ) : (
            <div className="notification-list">
              {items.map((item) => (
                <button
                  key={item.id}
                  className={'notification-item' + (readIds.includes(item.id) ? ' read' : '')}
                  onClick={() => markRead(item)}
                >
                  <div className="notification-item-main">
                    <span className={'notification-kind ' + (item.kind === 'update' ? 'update' : 'notice')}>
                      {noticeKindLabel(item.kind)}
                    </span>
                    <strong>{item.title}</strong>
                  </div>
                  <div className="notification-item-meta">
                    <span className="notification-time">{noticeTime(item.created_at)}</span>
                    {!readIds.includes(item.id) ? <span className="notification-item-dot" aria-hidden="true" /> : null}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      ) : null}

      {detail ? (
        <Modal
          title={detail.kind === 'update' ? '版本更新说明' : '通知详情'}
          onClose={() => setDetail(null)}
          footer={
            <button className="btn-sm" onClick={() => setDetail(null)}>
              关闭
            </button>
          }
        >
          <div className="notification-detail">
            <div className="notification-detail-meta">
              <span className={'notification-kind ' + (detail.kind === 'update' ? 'update' : 'notice')}>
                {noticeKindLabel(detail.kind)}
              </span>
              <span>{noticeTime(detail.created_at)}</span>
            </div>
            <h3>{detail.title}</h3>
            <div className="notification-detail-content">{detail.content}</div>
          </div>
        </Modal>
      ) : null}
    </div>
  )
}
