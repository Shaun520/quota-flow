import { Fragment, useEffect, useRef, useState } from 'react'
import type { JobItem, JobsResult } from '../hooks/useJobs'
import { IconEye, IconFolder, IconInfo, IconTrash } from './icons'
import Pagination from './Pagination'
import Select from './Select'
import { VideoThumb } from './VideoThumb'

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

export default function History({ jobs }: { jobs: JobsResult }) {
  const { loading, error, items, reload, remove, removeMany } = jobs
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [batchDeleting, setBatchDeleting] = useState(false)
  const [confirm, setConfirm] = useState<{ kind: 'one'; item: JobItem } | { kind: 'many'; ids: string[] } | null>(null)
  const [batchMode, setBatchMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const selectAllRef = useRef<HTMLInputElement>(null)
  const [preview, setPreview] = useState<{ id: string; src: string } | null>(null)
  const [detail, setDetail] = useState<JobItem | null>(null)
  const [detailImgUrls, setDetailImgUrls] = useState<string[]>([])
  const [zoomImg, setZoomImg] = useState<string | null>(null)
  const [mediaUrls, setMediaUrls] = useState<Record<string, string>>({})
  const [text, setText] = useState('')
  const [provider, setProvider] = useState('')
  const [status, setStatus] = useState('')
  const [page, setPage] = useState(1)
  const [notice, setNotice] = useState<string | null>(null)

  // 打开详情时，把上传图片的本地路径解析成可预览的 http 地址
  useEffect(() => {
    if (!detail) {
      setDetailImgUrls([])
      return
    }
    let cancelled = false
    const names = detail.record.images
      .map((p) => p.replace(/\\/g, '/').split('/').pop() || '')
      .filter(Boolean)
    Promise.all(
      names.map((n) => window.api.media.getImageUrl(n).catch(() => null))
    )
      .then((urls) => {
        if (!cancelled) setDetailImgUrls(urls.filter((u): u is string => !!u))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [detail])

  const buildParamItems = (item: JobItem): Array<[string, string]> => {
    const r = item.record
    const items: Array<[string, string]> = []
    const p = r.params
    if (p?.durationSec) items.push(['时长', `${p.durationSec} 秒`])
    if (p?.ratio) items.push(['比例', p.ratio])
    if (p?.audio === 'on') items.push(['配音', '开启'])
    else if (p?.audio === 'off') items.push(['配音', '关闭'])
    if (p?.resolution) items.push(['分辨率', `${p.resolution}p`])
    return items
  }

  const removeJob = async (item: JobItem): Promise<void> => {
    setConfirm({ kind: 'one', item })
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
    setConfirm({ kind: 'many', ids })
  }

  // 在系统文件管理器中打开该视频所在的文件夹（视频已本地落盘 userData/videos）
  const openFolder = async (filePath: string): Promise<void> => {
    try {
      const res = await window.api.media.showInFolder(filePath)
      if (!res.ok) setNotice(res.error ?? '打开文件夹失败')
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e))
    }
  }

  // 确认弹层：确认后执行删除（应用内弹层，避免 window.confirm 原生对话框导致窗口丢焦点/输入框不可编辑）
  const doDelete = async (): Promise<void> => {
    if (!confirm) return
    if (confirm.kind === 'one') {
      setDeletingId(confirm.item.id)
      try {
        await remove(confirm.item.id)
      } finally {
        setDeletingId(null)
      }
    } else {
      setBatchDeleting(true)
      try {
        const n = await removeMany(confirm.ids)
        if (n > 0) clearSelection()
      } finally {
        setBatchDeleting(false)
      }
    }
    setConfirm(null)
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
          <Select
            value={provider}
            onChange={(v) => { setProvider(v); setPage(1) }}
            options={[{ value: '', label: '全部厂商' }, ...providers.map((p) => ({ value: p, label: p }))]}
          />
          <Select
            value={status}
            onChange={(v) => { setStatus(v); setPage(1) }}
            options={[
              { value: '', label: '全部状态' },
              { value: '成功', label: '成功' },
              { value: '排队', label: '排队' },
              { value: '失败', label: '失败' },
              { value: '未生成', label: '未生成' }
            ]}
          />
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
                          <VideoThumb
                            src={mediaUrls[item.id]}
                            onClick={() => togglePreview(item)}
                            style={{ width: 96, height: 54, borderRadius: 6 }}
                          />
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
                            title="查看详情（提示词/参数/图片）"
                            aria-label="查看详情"
                            onClick={() => setDetail(item)}
                          >
                            <IconInfo size={12} />
                          </button>
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

      {notice && (
        <div className="history-error" style={{ marginTop: 8 }}>
          <span>{notice}</span>
          <button className="btn-sm primary" onClick={() => setNotice(null)}>关闭</button>
        </div>
      )}

      {confirm && (
        <div
          className="modal-overlay"
          style={{ zIndex: 300 }}
          onClick={(e) => { if (e.target === e.currentTarget) setConfirm(null) }}
        >
          <div className="modal-card" style={{ maxWidth: 400, padding: '18px 20px' }}>
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 10 }}>
              {confirm.kind === 'one' ? '删除历史记录' : '批量删除历史记录'}
            </div>
            <p style={{ color: 'var(--fg-secondary)', margin: '0 0 16px', lineHeight: 1.7 }}>
              {confirm.kind === 'one'
                ? `确定删除这条历史记录？该任务会从数据库中移除。\n「${confirm.item.record.prompt}」`
                : `确定删除选中的 ${confirm.ids.length} 条历史记录？该操作会从数据库中移除这些任务。`}
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn-sm" onClick={() => setConfirm(null)}>取消</button>
              <button
                className="btn-sm danger"
                disabled={deletingId !== null || batchDeleting}
                onClick={() => void doDelete()}
              >
                {deletingId !== null || batchDeleting ? '删除中...' : '确认删除'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 生成详情：提示词 / 参数 / 上传图片 */}
      {detail && (
        <div
          className="modal-overlay"
          style={{ zIndex: 300 }}
          onClick={(e) => { if (e.target === e.currentTarget) setDetail(null) }}
        >
          <div
            className="modal-card"
            style={{ width: 'min(92vw, 720px)', maxHeight: '86vh', overflow: 'auto', padding: 20 }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
              <div style={{ fontSize: 15, fontWeight: 600 }}>生成详情</div>
              <button className="btn-sm" onClick={() => setDetail(null)}>关闭</button>
            </div>

            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginBottom: 4 }}>提示词</div>
              <div
                style={{
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  background: 'rgba(255,255,255,0.05)',
                  padding: '8px 10px',
                  borderRadius: 8,
                  lineHeight: 1.7,
                  color: 'var(--fg-primary)'
                }}
              >
                {detail.record.prompt || '—'}
              </div>
            </div>

            {buildParamItems(detail).length > 0 && (
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginBottom: 6 }}>参数</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {buildParamItems(detail).map(([k, v]) => (
                    <span
                      key={k}
                      style={{
                        padding: '3px 10px',
                        borderRadius: 999,
                        background: 'var(--accent-bg)',
                        fontSize: 12,
                        color: 'var(--fg-secondary)'
                      }}
                    >
                      {k}：{v}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {detailImgUrls.length > 0 && (
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginBottom: 6 }}>上传图片</div>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  {detailImgUrls.map((u, i) => (
                    <img
                      key={i}
                      src={u}
                      alt=""
                      title="点击放大"
                      onClick={() => setZoomImg(u)}
                      style={{
                        width: 96,
                        height: 96,
                        objectFit: 'cover',
                        borderRadius: 8,
                        cursor: 'zoom-in',
                        background: '#000'
                      }}
                    />
                  ))}
                </div>
              </div>
            )}
            {detailImgUrls.length === 0 && detail.record.mode === '图生视频' && (
              <div style={{ marginBottom: 14, fontSize: 12, color: 'var(--fg-muted)' }}>
                上传图片：（该记录未保存图片副本，旧记录无法回显）
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--fg-muted)' }}>
              <div style={{ display: 'flex', gap: 12, lineHeight: 1.7 }}>
                {[
                  ['厂商', detail.record.provider],
                  ['账号', detail.record.accountName || '—'],
                  ['消耗', detail.record.cost],
                  ['时间', timeAgo(detail.record.at)]
                ].map(([k, v]) => (
                  <div key={k} style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'baseline' }}>
                    <span style={{ width: '3.6em', flexShrink: 0, color: 'var(--fg-secondary)' }}>{k}：</span>
                    <span style={{ minWidth: 0, wordBreak: 'break-word' }}>{v}</span>
                  </div>
                ))}
              </div>
              {detail.record.errorMessage && (
                <div style={{ display: 'flex', gap: 0, lineHeight: 1.6 }}>
                  <span style={{ color: 'var(--fg-secondary)', flexShrink: 0 }}>错误：</span>
                  <span style={{ color: 'var(--error)', wordBreak: 'break-word', minWidth: 0 }}>{detail.record.errorMessage}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 图片放大浮层 */}
      {zoomImg && (
        <div
          className="modal-overlay"
          style={{ zIndex: 400, cursor: 'zoom-out' }}
          onClick={() => setZoomImg(null)}
        >
          <img
            src={zoomImg}
            alt=""
            style={{ maxWidth: '92vw', maxHeight: '88vh', borderRadius: 10, objectFit: 'contain' }}
          />
        </div>
      )}
    </div>
  )
}
