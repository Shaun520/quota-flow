import { Fragment, useEffect, useRef, useState } from 'react'
import type { JobItem } from '../hooks/useJobs'
import { useJobs } from '../hooks/useJobs'
import { IconEye, IconFolder, IconTrash } from './icons'
import Pagination from './Pagination'

const PAGE_SIZE = 10

function badgeFor(status: string): string {
  if (status === '成功') return 'badge-success'
  if (status === '排队') return 'badge-pending'
  if (status === '失败') return 'badge-error'
  return 'badge-muted'
}

function previewLabel(status: string): string {
  if (status === '失败') return '失败'
  if (status === '排队') return '生成中'
  if (status === '未生成') return '未生成'
  return '预览'
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return '刚刚'
  if (mins < 60) return `${mins} 分钟前`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days} 天前`
  const d = new Date(iso)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd} ${hh}:${mi}`
}

// 视频缩略图：加载本地/远程视频，取首帧画到 canvas 生成图片，点击触发预览
function VideoThumb({ src, onClick }: { src: string; onClick: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [thumb, setThumb] = useState<string | null>(null)

  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    const draw = (): void => {
      try {
        if (v.readyState >= 2 && v.videoWidth > 0 && canvasRef.current) {
          const c = canvasRef.current
          c.width = 160
          c.height = Math.max(1, Math.round((160 * v.videoHeight) / v.videoWidth))
          c.getContext('2d')?.drawImage(v, 0, 0, c.width, c.height)
          setThumb(c.toDataURL('image/jpeg', 0.7))
        }
      } catch {
        // 取帧失败保留 video 元素兜底
      }
    }
    const onLoaded = (): void => {
      try {
        v.currentTime = Math.min(0.2, (v.duration || 1) * 0.1)
      } catch {}
    }
    const onSeeked = (): void => draw()
    v.addEventListener('loadedmetadata', onLoaded)
    v.addEventListener('seeked', onSeeked)
    v.addEventListener('loadeddata', draw)
    return () => {
      v.removeEventListener('loadedmetadata', onLoaded)
      v.removeEventListener('seeked', onSeeked)
      v.removeEventListener('loadeddata', draw)
    }
  }, [src])

  return (
    <button
      className="preview-thumb-btn"
      title="点击预览视频"
      onClick={onClick}
      style={{ padding: 0, border: 'none', background: 'transparent', cursor: 'pointer', display: 'block' }}
    >
      {thumb ? (
        <img
          src={thumb}
          alt="预览"
          style={{ width: 96, height: 54, objectFit: 'cover', borderRadius: 6, display: 'block' }}
        />
      ) : (
        <video
          ref={videoRef}
          src={src}
          muted
          playsInline
          preload="auto"
          style={{ width: 96, height: 54, objectFit: 'cover', borderRadius: 6, display: 'block' }}
        />
      )}
      <canvas ref={canvasRef} style={{ display: 'none' }} />
    </button>
  )
}

export default function History() {
  const { loading, error, items, reload, remove, removeMany } = useJobs()
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [batchDeleting, setBatchDeleting] = useState(false)
  const [batchMode, setBatchMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const selectAllRef = useRef<HTMLInputElement>(null)
  const [preview, setPreview] = useState<{ id: string; src: string } | null>(null)
  const [mediaUrls, setMediaUrls] = useState<Record<string, string>>({})
  const [text, setText] = useState('')
  const [provider, setProvider] = useState('')
  const [status, setStatus] = useState('')
  const [page, setPage] = useState(1)

  const removeJob = async (item: JobItem): Promise<void> => {
    if (!window.confirm('确定删除这条历史记录？该任务会从数据库中移除。')) return
    setDeletingId(item.id)
    try {
      await remove(item.id)
    } finally {
      setDeletingId(null)
    }
  }

  const toggleSelect = (id: string): void => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleSelectAll = (): void => {
    const ids = filtered.map((i) => i.id)
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (ids.every((id) => next.has(id))) {
        for (const id of ids) next.delete(id)
      } else {
        for (const id of ids) next.add(id)
      }
      return next
    })
  }

  const clearSelection = (): void => setSelectedIds(new Set())

  const toggleBatchMode = (): void => {
    if (batchMode) clearSelection()
    setBatchMode((m) => !m)
  }

  const batchDelete = async (): Promise<void> => {
    const ids = [...selectedIds]
    if (ids.length === 0) return
    if (!window.confirm(`确定删除选中的 ${ids.length} 条历史记录？该操作会从数据库中移除这些任务。`)) return
    setBatchDeleting(true)
    try {
      const n = await removeMany(ids)
      if (n > 0) clearSelection()
    } finally {
      setBatchDeleting(false)
    }
  }

  // 在系统文件管理器中打开该视频所在的文件夹（视频已本地落盘 userData/videos）
  const openFolder = async (filePath: string): Promise<void> => {
    try {
      const res = await window.api.media.showInFolder(filePath)
      if (!res.ok) window.alert(res.error ?? '打开文件夹失败')
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e))
    }
  }

  // 一次性解析每行视频的可播放地址（本地路径 → http://127.0.0.1 服务）
  useEffect(() => {
    let cancelled = false
    const map: Record<string, string> = {}
    const tasks: Promise<void>[] = []
    for (const item of items) {
      const r = item.record
      if (!r.resultUrl) continue
      if (/^https?:/i.test(r.resultUrl)) {
        map[item.id] = r.resultUrl
      } else {
        const name = r.resultUrl.replace(/\\/g, '/').split('/').pop() || ''
        tasks.push(
          window.api.media
            .getUrl(name)
            .then((u) => {
              map[item.id] = u
            })
            .catch(() => {})
        )
      }
    }
    void Promise.all(tasks).then(() => {
      if (!cancelled) setMediaUrls(map)
    })
    return () => {
      cancelled = true
    }
  }, [items])

  const togglePreview = (item: JobItem): void => {
    if (preview && preview.id === item.id) {
      setPreview(null)
      return
    }
    const src = mediaUrls[item.id]
    if (!src) return
    setPreview({ id: item.id, src })
  }

  const providers = Array.from(new Set(items.map((i) => i.record.provider)))
  const filtered = items.filter((i) => {
    const r = i.record
    const matchText = r.prompt.toLowerCase().includes(text.trim().toLowerCase())
    const matchProvider = !provider || r.provider === provider
    const matchStatus = !status || r.status === status
    return matchText && matchProvider && matchStatus
  })

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const pagedItems = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)
  const colSpan = batchMode ? 9 : 8
  const selectedCount = filtered.filter((i) => selectedIds.has(i.id)).length
  const allSelected = filtered.length > 0 && selectedCount === filtered.length

  // 全选框半选态：当前筛选结果只选了一部分
  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = selectedCount > 0 && !allSelected
    }
  }, [selectedCount, allSelected])

  if (loading) {
    return (
      <div className="tab-wrap">
        <div className="page-header">
          <div className="title-group">
            <div>
              <h1>历史记录</h1>
              <div className="divider" />
            </div>
            <p>加载中...</p>
          </div>
        </div>
      </div>
    )
  }

  if (error && items.length === 0) {
    return (
      <div className="tab-wrap">
        <div className="page-header">
          <div className="title-group">
            <div>
              <h1>历史记录</h1>
              <div className="divider" />
            </div>
            <p>加载失败</p>
          </div>
        </div>
        <div className="history-error">
          <span>{error}</span>
          <button className="btn-sm primary" onClick={reload}>重试</button>
        </div>
      </div>
    )
  }

  return (
    <div className="tab-wrap">
      <div className="page-header">
        <div className="title-group">
          <div>
            <h1>历史记录</h1>
            <div className="divider" />
          </div>
          <p>全部生成任务 · 支持筛选与批量操作</p>
        </div>
        <div className="filter-bar">
          <button
            className={'btn-sm' + (batchMode ? ' primary' : '')}
            title="勾选多条记录后批量删除"
            onClick={toggleBatchMode}
            disabled={items.length === 0}
          >
            批量删除
          </button>
          <input
            type="text"
            placeholder="搜索提示词..."
            value={text}
            onChange={(e) => { setText(e.target.value); setPage(1) }}
          />
          <select value={provider} onChange={(e) => { setProvider(e.target.value); setPage(1) }}>
            <option value="">全部厂商</option>
            {providers.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1) }}>
            <option value="">全部状态</option>
            <option value="成功">成功</option>
            <option value="排队">排队</option>
            <option value="失败">失败</option>
            <option value="未生成">未生成</option>
          </select>
        </div>
      </div>

      {error && (
        <div className="history-error">
          <span>{error}</span>
          <button className="btn-sm primary" onClick={reload}>重试</button>
        </div>
      )}

      {batchMode && (
        <div className="batch-bar">
          <span>已选 {selectedIds.size} 项</span>
          <div className="actions">
            <button
              className="btn-sm danger"
              disabled={batchDeleting || selectedIds.size === 0}
              onClick={() => void batchDelete()}
            >
              {batchDeleting ? '删除中...' : '删除选中'}
            </button>
            <button className="btn-sm" disabled={batchDeleting} onClick={toggleBatchMode}>
              取消选择
            </button>
          </div>
        </div>
      )}

      <div className="history-table-wrap">
        <div className="table-scroll">
          <table className="history-table">
            <thead>
              <tr>
                {batchMode && (
                  <th className="col-check" style={{ width: '36px' }}>
                    <input
                      ref={selectAllRef}
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleSelectAll}
                      disabled={filtered.length === 0}
                      aria-label="全选当前筛选结果"
                    />
                  </th>
                )}
                <th style={{ width: '80px' }}>预览</th>
                <th>提示词</th>
                <th>厂商</th>
                <th>模式</th>
                <th>消耗</th>
                <th>状态</th>
                <th>质量</th>
                <th style={{ width: '120px' }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {pagedItems.map((item) => {
                const r = item.record
                const localPath = r.localPath
                return (
                  <Fragment key={item.id}>
                    <tr>
                      {batchMode && (
                        <td className="col-check">
                          <input
                            type="checkbox"
                            checked={selectedIds.has(item.id)}
                            onChange={() => toggleSelect(item.id)}
                            disabled={batchDeleting}
                            aria-label="选择该记录"
                          />
                        </td>
                      )}
                      <td className="col-preview">
                        {r.status === '成功' && mediaUrls[item.id] ? (
                          <VideoThumb src={mediaUrls[item.id]} onClick={() => togglePreview(item)} />
                        ) : (
                          <div className="preview-thumb">{previewLabel(r.status)}</div>
                        )}
                      </td>
                      <td className="col-prompt">{r.prompt}</td>
                      <td>{r.provider}{r.accountName ? ' · ' + r.accountName : ''}</td>
                      <td>{r.mode}</td>
                      <td>{r.cost}</td>
                      <td>
                        <span className={'badge ' + badgeFor(r.status)}>{r.status}</span>
                      </td>
                      <td>{r.quality}</td>
                      <td className="col-actions">
                        <div className="action-btns">
                          <button
                            className="action-btn"
                            title="查看"
                            aria-label="查看"
                            onClick={() => togglePreview(item)}
                          >
                            <IconEye size={12} />
                          </button>
                          {localPath && (
                            <button
                              className="action-btn"
                              title="打开所在文件夹"
                              aria-label="打开所在文件夹"
                              onClick={() => void openFolder(localPath)}
                            >
                              <IconFolder size={12} />
                            </button>
                          )}
                          <button
                            className="action-btn delete"
                            title="删除"
                            aria-label="删除"
                            disabled={deletingId === item.id}
                            onClick={() => void removeJob(item)}
                          >
                            <IconTrash size={12} />
                          </button>
                        </div>
                      </td>
                    </tr>
                    {preview && preview.id === item.id && (
                      <tr className="preview-row">
                        <td colSpan={colSpan} style={{ padding: '8px 12px' }}>
                          <video
                            controls
                            autoPlay
                            src={preview.src}
                            style={{ width: '100%', maxHeight: 320, borderRadius: 10, background: '#000' }}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={colSpan} style={{ textAlign: 'center', color: 'var(--fg-muted)', padding: '24px' }}>
                    没有匹配的记录
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="table-footer">
          <span className="table-total">共 {filtered.length} 项</span>
          <Pagination page={safePage} total={filtered.length} pageSize={PAGE_SIZE} onChange={setPage} />
        </div>
      </div>
    </div>
  )
}
