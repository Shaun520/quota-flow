import { useState } from 'react'
import { HISTORY_ROWS } from '../data'
import { IconDownload, IconEye, IconTrash } from './icons'
import Pagination from './Pagination'

const PAGE_SIZE = 10

function badgeFor(status: string): string {
  if (status === '成功') return 'badge-success'
  if (status === '排队') return 'badge-pending'
  return 'badge-error'
}

export default function History() {
  const [text, setText] = useState('')
  const [provider, setProvider] = useState('')
  const [status, setStatus] = useState('')
  const [page, setPage] = useState(1)

  const providers = Array.from(new Set(HISTORY_ROWS.map((r) => r.provider)))
  const rows = HISTORY_ROWS.filter((r) => {
    const matchText = r.prompt.toLowerCase().includes(text.trim().toLowerCase())
    const matchProvider = !provider || r.provider === provider
    const matchStatus = !status || r.status === status
    return matchText && matchProvider && matchStatus
  })

  const pagedRows = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  return (
    <>
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
          </select>
        </div>
      </div>

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
              {pagedRows.map((r, i) => (
                <tr key={i}>
                  <td className="col-preview">
                    <div className="preview-thumb">
                      {r.status === '失败' ? '失败' : r.status === '排队' ? '生成中' : '预览'}
                    </div>
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
                      <button className="action-btn delete" title="删除" aria-label="删除">
                        <IconTrash size={12} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
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
          <span className="table-total">共 {rows.length} 项</span>
          <Pagination page={page} total={rows.length} pageSize={PAGE_SIZE} onChange={setPage} />
        </div>
      </div>
    </>
  )
}
