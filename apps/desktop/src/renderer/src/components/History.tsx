import { useState } from 'react'
import type { JobItem } from '../hooks/useJobs'
import { useJobs } from '../hooks/useJobs'
import { IconDownload, IconEye, IconTrash } from './icons'
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

export default function History() {
  const { loading, error, items, reload, remove } = useJobs()
  const [deletingId, setDeletingId] = useState<string | null>(null)
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

      <div className="history-table-wrap">
        <div className="table-scroll">
          <table className="history-table">
            <thead>
              <tr>
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
                return (
                  <tr key={item.id}>
                    <td className="col-preview">
                      <div className="preview-thumb">{previewLabel(r.status)}</div>
                    </td>
                    <td className="col-prompt">{r.prompt}</td>
                    <td>{r.provider}</td>
                    <td>{r.mode}</td>
                    <td>{r.cost}</td>
                    <td>
                      <span className={'badge ' + badgeFor(r.status)}>{r.status}</span>
                    </td>
                    <td>{r.quality}</td>
                    <td className="col-actions">
                      <div className="action-btns">
                        <button className="action-btn" title="查看" aria-label="查看">
                          <IconEye size={12} />
                        </button>
                        {r.status !== '失败' && (
                          <button className="action-btn" title="下载" aria-label="下载">
                            <IconDownload size={12} />
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
                )
              })}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={8} style={{ textAlign: 'center', color: 'var(--fg-muted)', padding: '24px' }}>
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
