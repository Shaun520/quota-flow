import { Fragment, useEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { JobItem, JobsResult } from '../hooks/useJobs'
import type { WatermarkBBox } from '../../../shared/history'
import { IconEye, IconFolder, IconInfo, IconTrash } from './icons'
import Pagination from './Pagination'
import Select from './Select'
import { VideoThumb } from './VideoThumb'
import { useAuth } from '../hooks/useAuth'
import { getAuthService, getProviderService, getSupabaseConfig } from '../auth/service'
import type { DesktopFeatureFlags } from '../hooks/useDesktopPermissions'
import type { JobStatus } from '@quota-flow/db-supabase'

const PAGE_SIZE = 10

function ModalLayer({ children }: { children: ReactNode }) {
  return createPortal(<>{children}</>, document.body)
}

function badgeFor(status: string): string {
  if (status === '成功') return 'badge-success'
  if (status === '排队') return 'badge-pending'
  if (status === '失败') return 'badge-error'
  if (status === '意外中断') return 'badge-error'
  return 'badge-muted'
}

function previewLabel(status: string): string {
  if (status === '失败') return '失败'
  if (status === '排队') return '生成中'
  if (status === '未生成') return '未生成'
  if (status === '意外中断') return '中断'
  return '预览'
}

function watermarkLabel(status?: string | null, hasManualBBox = false): string {
  if (status === 'none') return '可去水印'
  if (!status) return '未处理'
  if (status === 'processing' || status === 'pending') return '处理中'
  if (status === 'done') return hasManualBBox ? '已处理' : '默认处理'
  if (status === 'failed') return '失败'
  if (status === 'needs_bbox') return '需框选'
  if (status === 'cancelled') return '已取消'
  return status
}

interface DisplayRect {
  left: number
  top: number
  width: number
  height: number
}

function videoDisplayRect(video: HTMLVideoElement, frame: HTMLElement): DisplayRect | null {
  if (!video.videoWidth || !video.videoHeight) return null
  const frameRect = frame.getBoundingClientRect()
  const videoAspect = video.videoWidth / video.videoHeight
  const frameAspect = frameRect.width / frameRect.height
  let left = 0
  let top = 0
  let width = frameRect.width
  let height = frameRect.width / videoAspect
  if (height > frameRect.height) {
    height = frameRect.height
    width = frameRect.height * videoAspect
    left = (frameRect.width - width) / 2
  } else {
    top = (frameRect.height - height) / 2
  }
  return { left, top, width, height }
}

function formatBBox(bbox: WatermarkBBox | null): string {
  if (!bbox) return '未选择'
  return `${bbox.width}x${bbox.height} @ ${bbox.x},${bbox.y}`
}

function formatBBoxes(bboxes: WatermarkBBox[] | null): string {
  if (!bboxes || bboxes.length === 0) return '未选择'
  return bboxes.map((bbox, index) => `${index + 1}: ${formatBBox(bbox)}`).join('；')
}

function dragBoxStyle(start: { x: number; y: number } | null, end: { x: number; y: number } | null): CSSProperties | undefined {
  if (!start || !end) return undefined
  const left = Math.min(start.x, end.x)
  const top = Math.min(start.y, end.y)
  return {
    position: 'absolute',
    left,
    top,
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
    border: '2px solid rgba(255,255,255,0.95)',
    background: 'rgba(239,68,68,0.18)',
    pointerEvents: 'none',
    zIndex: 2
  }
}

function savedBBoxStyle(
  video: HTMLVideoElement | null,
  frame: HTMLElement | null,
  bbox: WatermarkBBox | null,
  border: string
): CSSProperties | undefined {
  if (!video || !frame || !bbox) return undefined
  const display = videoDisplayRect(video, frame)
  if (!display) return undefined
  const sx = display.width / video.videoWidth
  const sy = display.height / video.videoHeight
  return {
    position: 'absolute',
    left: display.left + bbox.x * sx,
    top: display.top + bbox.y * sy,
    width: bbox.width * sx,
    height: bbox.height * sy,
    border,
    pointerEvents: 'none',
    zIndex: 1
  }
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

export default function History({
  jobs,
  features = {},
  onRegenerate
}: {
  jobs: JobsResult
  features?: Partial<DesktopFeatureFlags>
  onRegenerate?: (item: JobItem) => void
}) {
  const { loading, error, items, total, page, setPage, setFilters, reload, remove, removeMany, getDetail } = jobs
  const { user } = useAuth()
  const canDetail = features['history.detail'] !== false
  const canRegenerate = features['history.regenerate'] !== false && !!onRegenerate
  const canCopyPrompt = features['history.copy_prompt'] !== false
  const canWatermark = features['history.watermark_removal'] !== false
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
  const [promptPreview, setPromptPreview] = useState(false)
  const [mediaUrls, setMediaUrls] = useState<Record<string, string>>({})
  const [retryingId, setRetryingId] = useState<string | null>(null)
  const [boxSelectItem, setBoxSelectItem] = useState<JobItem | null>(null)
  const [boxVideoUrl, setBoxVideoUrl] = useState<string | null>(null)
  const [boxBBoxes, setBoxBBoxes] = useState<WatermarkBBox[]>([])
  const [boxDrawing, setBoxDrawing] = useState(false)
  const [boxStart, setBoxStart] = useState<{ x: number; y: number } | null>(null)
  const [boxEnd, setBoxEnd] = useState<{ x: number; y: number } | null>(null)
  const [boxPlaying, setBoxPlaying] = useState(false)
  const [boxTime, setBoxTime] = useState(0)
  const [boxDuration, setBoxDuration] = useState(0)
  const boxVideoRef = useRef<HTMLVideoElement | null>(null)
  const boxFrameRef = useRef<HTMLDivElement | null>(null)
  const [text, setText] = useState('')
  const [provider, setProvider] = useState('')
  const [status, setStatus] = useState<JobStatus | ''>('')
  const [allProviderOptions, setProviderOptions] = useState<Array<{ value: string; label: string }>>([])
  const [notice, setNotice] = useState<string | null>(null)
  const [copiedPrompt, setCopiedPrompt] = useState(false)

  useEffect(() => {
    const svc = getProviderService()
    if (!svc) return
    let cancelled = false
    svc
      .listAllProviders()
      .then((providers) => {
        if (!cancelled) {
          setProviderOptions(providers.map((p) => ({ value: p.id, label: p.name })))
        }
      })
      .catch(() => {
        // 非关键：筛选器仍可用当前页出现的厂商；列表加载失败也不影响历史数据。
      })
    return () => {
      cancelled = true
    }
  }, [])

  // 打开详情时，把上传图片解析成可预览的 http 地址。
  // 兼容两类来源：本地图片副本（userData/images，走本地媒体服务）与公网 https 地址（开放平台 API 上传到 Supabase qf-images 桶）。
  useEffect(() => {
    if (!detail) {
      setDetailImgUrls([])
      setPromptPreview(false)
      return
    }
    let cancelled = false
    const paths = detail.record.images.map((p) => p.replace(/\\/g, '/')).filter(Boolean)
    Promise.all(
      paths.map((p) => {
        // 已是公网 http(s) URL（如 Supabase 公开地址）→ 直接展示，无需本地媒体服务
        if (/^https?:\/\//i.test(p)) return Promise.resolve(p)
        // 本地图片副本：取 basename 走本地媒体服务解析
        const name = p.split('/').pop() || ''
        if (!name) return Promise.resolve(null)
        return window.api.media.getImageUrl(name).catch(() => null)
      })
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

  // 打开详情：列表只回 summary，点开时按 id 懒加载完整字段（model/params/images/error/audio）
  const openDetail = async (item: JobItem): Promise<void> => {
    try {
      const full = await getDetail(item.id)
      if (full) setDetail(full)
    } catch {
      // 详情拉取失败不阻断；保持弹窗关闭，用户可重试
    }
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
    const ids = items.map((i) => i.id)
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

  const copyPrompt = async (text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedPrompt(true)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = text
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
      setCopiedPrompt(true)
    }
    window.setTimeout(() => setCopiedPrompt(false), 1200)
  }

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

  const closeBoxSelect = (): void => {
    const video = boxVideoRef.current
    if (video) {
      video.pause()
      video.removeAttribute('src')
      video.load()
    }
    setBoxPlaying(false)
    setBoxTime(0)
    setBoxDuration(0)
    setBoxSelectItem(null)
    setBoxVideoUrl(null)
    setBoxBBoxes([])
    setBoxDrawing(false)
    setBoxStart(null)
    setBoxEnd(null)
  }

  const retryWatermark = async (item: JobItem, bboxes?: WatermarkBBox[]): Promise<void> => {
    if (retryingId) return
    try {
      const auth = getAuthService()
      const cfg = getSupabaseConfig()
      const session = await auth?.getSession()
      if (!auth || !cfg || !session || !user) {
        setNotice('登录状态异常，无法重试去水印')
        return
      }
      setRetryingId(item.id)
      const res = await window.api.watermark.retry({
        supabaseUrl: cfg.url,
        supabaseAnonKey: cfg.anonKey,
        accessToken: session.access_token,
        refreshToken: session.refresh_token,
        userId: user.id,
        jobId: item.id,
        bboxes: bboxes ?? item.record.watermarkBBoxes ?? (item.record.watermarkBBox ? [item.record.watermarkBBox] : undefined)
      })
      if (!res.ok) {
        setNotice(res.error ?? '去水印重试失败')
      }
      if (boxSelectItem?.id === item.id) {
        closeBoxSelect()
      }
      reload()
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e))
    } finally {
      setRetryingId(null)
    }
  }

  const openBoxSelect = async (item: JobItem): Promise<void> => {
    const sourcePath = item.record.localPath
    if (!sourcePath || /^https?:/i.test(sourcePath)) {
      setNotice('没有本地原视频，无法框选水印')
      return
    }
    try {
      const name = sourcePath.replace(/\\/g, '/').split('/').pop() || ''
      const url = await window.api.media.getUrl(name)
      setBoxSelectItem(item)
      setBoxVideoUrl(url)
      setBoxBBoxes(item.record.watermarkBBoxes ?? (item.record.watermarkBBox ? [item.record.watermarkBBox] : []))
      setBoxStart(null)
      setBoxEnd(null)
      setBoxDrawing(false)
      setBoxTime(0)
      setBoxDuration(0)
      setBoxPlaying(false)
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e))
    }
  }

  const toggleBoxPlay = (): void => {
    const video = boxVideoRef.current
    if (!video) return
    if (video.paused) {
      void video.play().catch(() => {})
    } else {
      video.pause()
    }
  }

  const seekBox = (value: number): void => {
    const video = boxVideoRef.current
    if (!video) return
    video.currentTime = value
    setBoxTime(value)
  }

  const beginBoxDraw = (e: ReactMouseEvent<HTMLDivElement>): void => {
    if (!boxFrameRef.current || retryingId) return
    e.preventDefault()
    const rect = boxFrameRef.current.getBoundingClientRect()
    const point = { x: e.clientX - rect.left, y: e.clientY - rect.top }
    setBoxStart(point)
    setBoxEnd(point)
    setBoxDrawing(true)
  }

  const moveBoxDraw = (e: ReactMouseEvent<HTMLDivElement>): void => {
    if (!boxDrawing || !boxStart || !boxFrameRef.current) return
    e.preventDefault()
    const rect = boxFrameRef.current.getBoundingClientRect()
    setBoxEnd({ x: e.clientX - rect.left, y: e.clientY - rect.top })
  }

  const endBoxDraw = (): void => {
    if (!boxDrawing) return
    setBoxDrawing(false)
    const video = boxVideoRef.current
    const frame = boxFrameRef.current
    if (!video || !frame || !boxStart || !boxEnd) return
    const display = videoDisplayRect(video, frame)
    if (!display) return
    const sx = video.videoWidth / display.width
    const sy = video.videoHeight / display.height
    const left = Math.max(display.left, Math.min(display.left + display.width, Math.min(boxStart.x, boxEnd.x)))
    const top = Math.max(display.top, Math.min(display.top + display.height, Math.min(boxStart.y, boxEnd.y)))
    const right = Math.max(display.left, Math.min(display.left + display.width, Math.max(boxStart.x, boxEnd.x)))
    const bottom = Math.max(display.top, Math.min(display.top + display.height, Math.max(boxStart.y, boxEnd.y)))
    const x = Math.max(0, Math.round((left - display.left) * sx))
    const y = Math.max(0, Math.round((top - display.top) * sy))
    const width = Math.max(1, Math.round((right - left) * sx))
    const height = Math.max(1, Math.round((bottom - top) * sy))
    const next = {
      x,
      y,
      width: Math.min(width, video.videoWidth - x),
      height: Math.min(height, video.videoHeight - y)
    }
    setBoxBBoxes((prev) => [...prev, next])
  }

  // 确认弹层：确认后执行删除（应用内弹层，避免 window.confirm 原生对话框导致窗口丢焦点/输入框不可编辑）
  const doDelete = async (): Promise<void> => {
    if (!confirm) return
    if (confirm.kind === 'one') {
      setDeletingId(confirm.item.id)
      try {
        const ok = await remove(confirm.item.id)
        if (!ok) {
          setNotice('删除失败：只能删除当前账号下的历史记录，请确认这条记录归属后重试。')
        }
      } finally {
        setDeletingId(null)
      }
    } else {
      setBatchDeleting(true)
      try {
        const n = await removeMany(confirm.ids)
        if (n === confirm.ids.length) {
          clearSelection()
        } else if (n > 0) {
          clearSelection()
          setNotice(`已删除 ${n} 条，剩余 ${confirm.ids.length - n} 条不是当前账号记录，未删除。`)
        } else {
          setNotice('删除失败：只能删除当前账号下的历史记录，请确认这些记录归属后重试。')
        }
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
      const sourcePath = r.cleanLocalPath || r.localPath || r.resultUrl
      if (!sourcePath) continue
      if (/^https?:/i.test(sourcePath)) {
        map[item.id] = sourcePath
      } else {
        const name = sourcePath.replace(/\\/g, '/').split('/').pop() || ''
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

  const pageProviders = Array.from(new Set(items.map((i) => i.record.providerId).filter((id): id is string => !!id)))
  const providerOptions = [...allProviderOptions]
  for (const id of pageProviders) {
    if (!providerOptions.some((opt) => opt.value === id)) {
      providerOptions.push({ value: id, label: items.find((i) => i.record.providerId === id)?.record.provider ?? id })
    }
  }
  if (provider && !providerOptions.some((opt) => opt.value === provider)) {
    providerOptions.unshift({ value: provider, label: provider })
  }

  const maxPage = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const safePage = Math.min(page, maxPage)
  useEffect(() => {
    if (page !== safePage) setPage(safePage)
  }, [page, safePage, setPage])
  const colSpan = batchMode ? (canWatermark ? 11 : 10) : (canWatermark ? 10 : 9)
  const selectedCount = items.filter((i) => selectedIds.has(i.id)).length
  const allSelected = items.length > 0 && selectedCount === items.length

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
            onChange={(e) => { setText(e.target.value); setFilters({ search: e.target.value }) }}
          />
          <Select
            value={provider}
            onChange={(v) => { setProvider(v); setFilters({ providerId: v }) }}
            options={[{ value: '', label: '全部厂商' }, ...providerOptions]}
          />
          <Select
            value={status}
            onChange={(v) => { setStatus(v as JobStatus | ''); setFilters({ status: v as JobStatus | '' }) }}
            options={[
              { value: '', label: '全部状态' },
              { value: 'success', label: '成功' },
              { value: 'pending', label: '排队' },
              { value: 'failed', label: '失败' },
              { value: 'not_generated', label: '未生成' },
              { value: 'interrupted', label: '意外中断' }
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
                      disabled={items.length === 0}
                      aria-label="全选当前页结果"
                    />
                  </th>
                )}
                <th style={{ width: '80px' }}>预览</th>
                <th>提示词</th>
                <th>厂商</th>
                <th>账号</th>
                <th>模式</th>
                <th>消耗</th>
                <th>状态</th>
                {canWatermark && <th>去水印</th>}
                <th style={{ width: '120px' }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const r = item.record
                const localPath = r.localPath
                const wmStatus = r.watermarkStatus
                const hasManualBBox = (r.watermarkBBoxes?.length ?? 0) > 0
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
                      <td>{r.provider}</td>
                      <td>{r.accountName || '—'}</td>
                      <td>{r.mode}</td>
                      <td>{r.cost}</td>
                      <td>
                        <span className={'badge ' + badgeFor(r.status)}>{r.status}</span>
                      </td>
                      {canWatermark && (
                        <td>
                          <div className="watermark-cell">
                            <span className={'watermark-pill ' + (wmStatus === 'done' ? 'done' : wmStatus === 'failed' || wmStatus === 'needs_bbox' ? 'error' : wmStatus === 'processing' || wmStatus === 'pending' ? 'pending' : '')}>
                              {watermarkLabel(wmStatus, hasManualBBox)}
                            </span>
                            {localPath && wmStatus !== 'processing' && wmStatus !== 'pending' && (
                              <button
                                className="btn-sm"
                                title="框选水印区域并重新处理"
                                aria-label="框选去水印"
                                disabled={retryingId === item.id}
                                onClick={() => void openBoxSelect(item)}
                              >
                                框选
                              </button>
                            )}
                            {(wmStatus === 'failed' || wmStatus === 'needs_bbox' || wmStatus === 'cancelled') && localPath && (
                              <button
                                className="btn-sm"
                                title="重试去水印"
                                aria-label="重试去水印"
                                disabled={retryingId === item.id}
                                onClick={() => void retryWatermark(item)}
                              >
                                {retryingId === item.id ? '…' : '重试'}
                              </button>
                            )}
                          </div>
                        </td>
                      )}
                      <td className="col-actions">
                        <div className="action-btns">
                          {canDetail && (
                            <button
                              className="action-btn"
                              title="查看详情（提示词/参数/图片）"
                              aria-label="查看详情"
                              onClick={() => void openDetail(item)}
                            >
                              <IconInfo size={12} />
                            </button>
                          )}
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
              {items.length === 0 && (
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
          <span className="table-total">共 {total} 项</span>
          <Pagination page={safePage} total={total} pageSize={PAGE_SIZE} onChange={setPage} />
        </div>
      </div>

      {notice && (
        <div className="history-error" style={{ marginTop: 8 }}>
          <span>{notice}</span>
          <button className="btn-sm primary" onClick={() => setNotice(null)}>关闭</button>
        </div>
      )}

      {confirm && (
        <ModalLayer>
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
                  ? '确定删除这条历史记录？该任务会从数据库中移除。'
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
        </ModalLayer>
      )}

      {/* 生成详情：提示词 / 参数 / 上传图片 */}
      {detail && (
        <ModalLayer>
          <div
            className="modal-overlay"
            style={{ zIndex: 300 }}
            onClick={(e) => { if (e.target === e.currentTarget) setDetail(null) }}
          >
            <div
              className="modal-card"
              style={{ width: 'min(92vw, 720px)', maxHeight: '86vh', overflow: 'auto', padding: 20 }}
            >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 14 }}>
              <div style={{ fontSize: 15, fontWeight: 600, marginRight: 'auto' }}>生成详情</div>
              {canRegenerate && (
                <button
                  className="btn-sm primary"
                  onClick={() => {
                    const item = detail
                    if (!item) return
                    setDetail(null)
                    onRegenerate(item)
                  }}
                >
                  重新生成
                </button>
              )}
              {canCopyPrompt && (
                <button
                  className="btn-sm"
                  disabled={!detail.record.prompt}
                  onClick={() => void copyPrompt(detail.record.prompt || '')}
                >
                  {copiedPrompt ? '已复制' : '复制提示词'}
                </button>
              )}
              <button
                className="btn-sm"
                title="关闭"
                aria-label="关闭"
                onClick={() => setDetail(null)}
              >
                X
              </button>
            </div>

            <div style={{ marginBottom: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>提示词</span>
              </div>
              <div
                role="button"
                tabIndex={0}
                title="点击放大预览"
                onClick={() => setPromptPreview(true)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    setPromptPreview(true)
                  }
                }}
                style={{
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  background: 'rgba(255,255,255,0.05)',
                  padding: '8px 10px',
                  borderRadius: 8,
                  lineHeight: 1.7,
                  height: 140,
                  overflowY: 'auto',
                  cursor: 'zoom-in',
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
        </ModalLayer>
      )}

      {/* 框选去水印：使用原视频预览并绘制水印区域 */}
      {boxSelectItem && boxVideoUrl && (
        <ModalLayer>
          <div
            className="modal-overlay"
            style={{ zIndex: 350 }}
            onClick={(e) => { if (e.target === e.currentTarget) closeBoxSelect() }}
          >
            <div
              className="modal-card"
              style={{ width: 'min(94vw, 880px)', maxHeight: '88vh', overflow: 'auto', padding: 20 }}
            >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <div style={{ fontSize: 15, fontWeight: 600 }}>框选去水印</div>
              <button className="btn-sm" onClick={closeBoxSelect}>关闭</button>
            </div>
            <p style={{ margin: '0 0 12px', color: 'var(--fg-secondary)', lineHeight: 1.7, fontSize: 13 }}>
              在原始视频上把水印覆盖区域框出来，可以连续框多个；点“重新处理”会保存这些区域并按它们重跑本地 FFmpeg 去水印。
            </p>
            <div
              ref={boxFrameRef}
              onMouseDown={beginBoxDraw}
              onMouseMove={moveBoxDraw}
              onMouseUp={endBoxDraw}
              onMouseLeave={endBoxDraw}
              style={{ position: 'relative', borderRadius: 8, overflow: 'hidden', background: '#000', cursor: 'crosshair', marginBottom: 10 }}
            >
              <video
                ref={boxVideoRef}
                src={boxVideoUrl}
                preload="auto"
                onPlay={() => setBoxPlaying(true)}
                onPause={() => setBoxPlaying(false)}
                onTimeUpdate={(e) => setBoxTime(e.currentTarget.currentTime)}
                onLoadedMetadata={(e) => setBoxDuration(e.currentTarget.duration || 0)}
                style={{ width: '100%', maxHeight: '56vh', display: 'block', pointerEvents: 'none', objectFit: 'contain' }}
              />
              {boxBBoxes
                .map((bbox) => savedBBoxStyle(boxVideoRef.current, boxFrameRef.current, bbox, '2px solid rgba(74,222,128,0.95)'))
                .filter((style): style is CSSProperties => !!style)
                .map((style, index) => (
                  <div key={index} style={style} />
                ))}
              {dragBoxStyle(boxStart, boxEnd) && (
                <div style={dragBoxStyle(boxStart, boxEnd)} />
              )}
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
              <button className="btn-sm" onClick={toggleBoxPlay} disabled={!boxDuration}>
                {boxPlaying ? '暂停' : '播放'}
              </button>
              <input
                type="range"
                min={0}
                max={boxDuration || 0}
                step={0.1}
                value={boxTime}
                onChange={(e) => seekBox(Number(e.target.value))}
                style={{ flex: 1, minWidth: 180 }}
              />
              <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
                {boxTime.toFixed(1)} / {boxDuration.toFixed(1)}s
              </span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1, minWidth: 0 }}>
                <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>选择区域：{formatBBoxes(boxBBoxes)}</span>
                {boxBBoxes.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {boxBBoxes.map((bbox, index) => (
                      <span key={index} className="watermark-bbox-chip">
                        {index + 1}: {formatBBox(bbox)}
                        <button
                          className="btn-sm"
                          title="删除该区域"
                          disabled={retryingId === boxSelectItem.id}
                          onClick={() => setBoxBBoxes((prev) => prev.filter((_, i) => i !== index))}
                        >
                          删除
                        </button>
                      </span>
                    ))}
                    <button
                      className="btn-sm"
                      title="清空所有框选区域"
                      disabled={retryingId === boxSelectItem.id}
                      onClick={() => setBoxBBoxes([])}
                    >
                      清空
                    </button>
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn-sm" onClick={closeBoxSelect}>取消</button>
                <button
                  className="btn-sm primary"
                  disabled={boxBBoxes.length === 0 || retryingId === boxSelectItem.id}
                  onClick={() => void retryWatermark(boxSelectItem, boxBBoxes)}
                >
                  {retryingId === boxSelectItem.id ? '处理中…' : '重新处理'}
                </button>
              </div>
            </div>
          </div>
        </div>
        </ModalLayer>
      )}

      {/* 图片放大浮层 */}
      {promptPreview && detail && (
        <ModalLayer>
          <div
            className="modal-overlay"
            style={{ zIndex: 400 }}
            onClick={(e) => { if (e.target === e.currentTarget) setPromptPreview(false) }}
          >
            <div
              className="modal-card"
              style={{ width: 'min(94vw, 960px)', maxHeight: '88vh', display: 'flex', flexDirection: 'column', padding: 20 }}
            >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <div style={{ fontSize: 15, fontWeight: 600 }}>提示词预览</div>
              <div style={{ display: 'flex', gap: 8 }}>
                {canCopyPrompt && (
                  <button
                    className="btn-sm"
                    disabled={!detail.record.prompt}
                    onClick={() => void copyPrompt(detail.record.prompt || '')}
                  >
                    {copiedPrompt ? '已复制' : '复制提示词'}
                  </button>
                )}
                <button className="btn-sm" onClick={() => setPromptPreview(false)}>关闭</button>
              </div>
            </div>
            <div
              style={{
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                background: 'rgba(255,255,255,0.05)',
                padding: '12px 14px',
                borderRadius: 8,
                lineHeight: 1.8,
                overflowY: 'auto',
                flex: 1,
                minHeight: 220,
                color: 'var(--fg-primary)'
              }}
            >
              {detail.record.prompt || '—'}
            </div>
          </div>
        </div>
        </ModalLayer>
      )}

      {zoomImg && (
        <ModalLayer>
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
        </ModalLayer>
      )}
    </div>
  )
}
