import { useState } from 'react'
import { PROVIDERS, type Provider } from '../data'
import { IconChevron, IconInfo, PROVIDER_ICONS } from './icons'
import { AddProviderModal } from './Modals'
import Pagination from './Pagination'
import { EmptyState } from './EmptyState'

const PAGE_SIZE = 10

function statusBadge(p: Provider): { cls: string; label: string } {
  if (p.state === 'offline') return { cls: 'badge-error', label: '离线' }
  if (p.state === 'degraded') return { cls: 'badge-pending', label: p.stateLabel }
  return { cls: 'badge-success', label: p.stateLabel }
}

interface ProvidersProps {
  fresh: boolean
  onBound?: () => void
}

export default function Providers({ fresh, onBound }: ProvidersProps) {
  const [text, setText] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [showAddModal, setShowAddModal] = useState(false)
  const [page, setPage] = useState(1)

  const rows = PROVIDERS.filter((p) => {
    const matchText = p.name.includes(text.trim())
    const matchStatus = !statusFilter || p.state === statusFilter
    return matchText && matchStatus
  })

  const pagedRows = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  return (
    <div className="tab-wrap">
      <div className="page-header">
        <div className="title-group">
          <div>
            <h1>厂商管理</h1>
            <div className="divider" />
          </div>
          <p>绑定账号 · 查看额度 · 管理 Cookie</p>
        </div>
        <div className="filter-bar">
          <input
            type="text"
            placeholder="搜索厂商..."
            value={text}
            onChange={(e) => { setText(e.target.value); setPage(1) }}
          />
          <select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setPage(1) }}>
            <option value="">全部状态</option>
            <option value="online">正常</option>
            <option value="degraded">异常</option>
            <option value="offline">离线</option>
          </select>
          <button className="btn-sm primary" onClick={() => setShowAddModal(true)}>
            + 新增厂商
          </button>
        </div>
      </div>

      {fresh && (
          <div className="providers-hint">
            <IconInfo size={14} />
            <span>绑定账号后额度将自动关联到你的账户，智能调度会按可用额度分发任务。</span>
          </div>
        )}

      <div className="provider-table-wrap">
        <div className="table-scroll">
          <table className="provider-table">
            <thead>
              <tr>
                <th style={{ width: '30px' }} />
                <th>厂商</th>
                <th>额度单位</th>
                <th>今日剩余</th>
                <th>账号数</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {fresh ? (
                <tr>
                  <td colSpan={7} className="providers-empty-cell">
                    <EmptyState
                      title="还没有绑定任何厂商账号"
                      description="选择你想使用的厂商，绑定账号后即可获取免费额度"
                      action={
                        <button className="btn-sm primary" onClick={() => setShowAddModal(true)}>
                          + 新增厂商
                        </button>
                      }
                    />
                  </td>
                </tr>
              ) : (
                <>
                  {pagedRows.map((p) => {
                    const badge = statusBadge(p)
                    const isExpanded = !!expanded[p.id]
                    return (
                      <ProviderRow
                        key={p.id}
                        provider={p}
                        badge={badge}
                        expanded={isExpanded}
                        onToggle={() => setExpanded((prev) => ({ ...prev, [p.id]: !prev[p.id] }))}
                      />
                    )
                  })}
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={7} style={{ textAlign: 'center', color: 'var(--fg-muted)', padding: '24px' }}>
                        没有匹配的厂商
                      </td>
                    </tr>
                  )}
                </>
              )}
            </tbody>
          </table>
        </div>
        {!fresh && (
          <div className="table-footer">
            <span className="table-total">共 {rows.length} 项</span>
            <Pagination page={page} total={rows.length} pageSize={PAGE_SIZE} onChange={setPage} />
          </div>
        )}
      </div>
      {showAddModal && (
        <AddProviderModal
          onClose={() => setShowAddModal(false)}
          onDone={() => {
            setShowAddModal(false)
            onBound?.()
          }}
        />
      )}
    </div>
  )
}

function ProviderRow({
  provider,
  badge,
  expanded,
  onToggle
}: {
  provider: Provider
  badge: { cls: string; label: string }
  expanded: boolean
  onToggle: () => void
}) {
  const IconComp = PROVIDER_ICONS[provider.id]
  return (
    <>
      <tr>
        <td>
          <button className={'expand-btn' + (expanded ? ' expanded' : '')} onClick={onToggle} aria-label="展开账号">
            <IconChevron size={12} />
          </button>
        </td>
        <td className="col-name">
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
            {IconComp ? <IconComp size={18} /> : null}
            {provider.name}
          </span>
        </td>
        <td>{provider.unit}</td>
        <td>{provider.remaining}</td>
        <td className="col-accounts">{provider.accounts} 个账号</td>
        <td>
          <span className={'badge ' + badge.cls}>{badge.label}</span>
        </td>
        <td>
          <button className="btn-sm primary">绑定账号</button>
        </td>
      </tr>
      {expanded && (
        <tr className="account-sublist">
          <td colSpan={7}>
            <table className="account-subtable">
              <tbody>
                {provider.accountsDetail.map((acc) => (
                  <tr key={acc.name}>
                    <td>
                      <strong>{acc.name}</strong>
                    </td>
                    <td>{acc.quota}</td>
                    <td className={acc.health}>
                      {acc.health === 'healthy' ? '正常' : acc.health === 'expiring' ? '将过期' : '已耗尽'}
                    </td>
                    <td>
                      <button className="btn-sm">测试</button>{' '}
                      <button className="btn-sm" style={{ color: 'var(--error)' }}>
                        解绑
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </td>
        </tr>
      )}
    </>
  )
}
