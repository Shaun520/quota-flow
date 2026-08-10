import { useState } from 'react'
import { IconChevron, IconInfo, PROVIDER_ICONS } from './icons'
import { AddProviderModal } from './Modals'
import Pagination from './Pagination'
import { EmptyState } from './EmptyState'
import { useProviders } from '../hooks/useProviders'
import type { ProviderAgg } from '../hooks/useProviders'
import { useAuth } from '../hooks/useAuth'

const PAGE_SIZE = 10

function statusBadge(p: ProviderAgg): { cls: string; label: string } {
  if (p.health === 'offline') return { cls: 'badge-error', label: '离线' }
  if (p.health === 'degraded') return { cls: 'badge-pending', label: p.healthLabel }
  if (p.health === 'unbound') return { cls: 'badge-muted', label: '未绑定' }
  return { cls: 'badge-success', label: p.healthLabel }
}

interface ProvidersProps {
  fresh: boolean
  onBound?: () => void
}

export default function Providers({ fresh, onBound }: ProvidersProps) {
  const { user } = useAuth()
  const { loading, error, aggs, reload, testHealth, rename, unbind } = useProviders()
  const [text, setText] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [showAddModal, setShowAddModal] = useState(false)
  const [addTarget, setAddTarget] = useState<string | undefined>(undefined)
  const [page, setPage] = useState(1)

  const boundRows = aggs.filter((a) => a.boundCount > 0)

  const rows = boundRows.filter((p) => {
    const matchText = p.name.toLowerCase().includes(text.trim().toLowerCase())
    const matchStatus = !statusFilter || p.health === statusFilter
    return matchText && matchStatus
  })

  const pagedRows = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  const openAdd = (providerId?: string) => {
    setAddTarget(providerId)
    setShowAddModal(true)
  }

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
            <option value="unbound">未绑定</option>
          </select>
          <button className="btn-sm primary" onClick={() => openAdd()}>
            + 新增厂商
          </button>
        </div>
      </div>

      {error && <div className="auth-msg auth-msg-error">{error}</div>}

      {boundRows.length === 0 && (
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
              {loading ? (
                <tr>
                  <td colSpan={7} style={{ textAlign: 'center', color: 'var(--fg-muted)', padding: '32px' }}>
                    正在加载厂商数据…
                  </td>
                </tr>
              ) : boundRows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="providers-empty-cell">
                    <EmptyState
                      title="还没有绑定任何厂商账号"
                      description="选择你想使用的厂商，绑定账号后即可获取免费额度"
                      action={
                        <button className="btn-sm primary" onClick={() => openAdd()}>
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
                    const isExpanded = !!expanded[p.providerId]
                    return (
                      <ProviderRow
                        key={p.providerId}
                        agg={p}
                        badge={badge}
                        expanded={isExpanded}
                        onToggle={() => setExpanded((prev) => ({ ...prev, [p.providerId]: !prev[p.providerId] }))}
                        onBind={() => openAdd(p.providerId)}
                        onRename={async (keyId, name) => {
                          if (!name.trim()) return
                          await rename(keyId, name)
                        }}
                        onTest={async (keyId) => {
                          await testHealth(p.providerId, keyId)
                        }}
                        onUnbind={async (keyId) => {
                          await unbind(keyId)
                        }}
                      />
                    )
                  })}
                  {pagedRows.length === 0 && (
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
        {!fresh && rows.length > PAGE_SIZE && (
          <div className="table-footer">
            <span className="table-total">共 {rows.length} 项</span>
            <Pagination page={page} total={rows.length} pageSize={PAGE_SIZE} onChange={setPage} />
          </div>
        )}
      </div>
      {showAddModal && user && (
        <AddProviderModal
          providers={aggs.map((a) => ({ providerId: a.providerId, name: a.name, authType: a.authType, boundCount: a.boundCount }))}
          userId={user.id}
          initialProviderId={addTarget}
          onClose={() => setShowAddModal(false)}
          onDone={() => {
            setShowAddModal(false)
            onBound?.()
            reload()
          }}
        />
      )}
    </div>
  )
}

function ProviderRow({
  agg,
  badge,
  expanded,
  onToggle,
  onBind,
  onTest,
  onRename,
  onUnbind
}: {
  agg: ProviderAgg
  badge: { cls: string; label: string }
  expanded: boolean
  onToggle: () => void
  onBind: () => void
  onRename: (keyId: string, name: string) => Promise<void>
  onTest: (keyId: string) => Promise<void>
  onUnbind: (keyId: string) => Promise<void>
}) {
  const IconComp = PROVIDER_ICONS[agg.providerId]
  const totalUsed = agg.bindings.reduce((s, b) => s + b.used, 0)
  const remaining = agg.bindings.reduce((s, b) => s + b.remaining, 0)
  const [editKeyId, setEditKeyId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [savingName, setSavingName] = useState(false)

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
            {agg.name}
          </span>
        </td>
        <td>{agg.unitName}</td>
        <td>{remaining} / {agg.defaultDailyQuota}</td>
        <td className="col-accounts">{agg.boundCount} 个账号</td>
        <td>
          <span className={'badge ' + badge.cls}>{badge.label}</span>
        </td>
        <td>
          <button className="btn-sm primary" onClick={onBind}>绑定账号</button>
        </td>
      </tr>
      {expanded && (
        <tr className="account-sublist">
          <td colSpan={7}>
            {agg.bindings.length === 0 ? (
              <div style={{ padding: '12px 16px', color: 'var(--fg-muted)' }}>
                尚未绑定账号，点击「绑定账号」开始。
              </div>
            ) : (
              <table className="account-subtable">
                <tbody>
                  {agg.bindings.map((acc) => (
                    <tr key={acc.keyId}>
                      <td>
                        {editKeyId === acc.keyId ? (
                          <span style={{ display: 'inline-flex', gap: '6px', alignItems: 'center' }}>
                            <input
                              className="rename-input"
                              type="text"
                              value={editName}
                              autoFocus
                              onChange={(e) => setEditName(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  setSavingName(true)
                                  void onRename(acc.keyId, editName).finally(() => {
                                    setSavingName(false)
                                    setEditKeyId(null)
                                  })
                                }
                                if (e.key === 'Escape') setEditKeyId(null)
                              }}
                            />
                            <button
                              className="btn-sm"
                              disabled={savingName || !editName.trim()}
                              onClick={() => {
                                setSavingName(true)
                                void onRename(acc.keyId, editName).finally(() => {
                                  setSavingName(false)
                                  setEditKeyId(null)
                                })
                              }}
                            >
                              保存
                            </button>
                          </span>
                        ) : (
                          <span style={{ display: 'inline-flex', gap: '6px', alignItems: 'center' }}>
                            <strong>{acc.accountName}</strong>
                            <button className="link-btn" onClick={() => { setEditKeyId(acc.keyId); setEditName(acc.accountName) }}>
                              改名
                            </button>
                          </span>
                        )}
                      </td>
                      <td>{acc.remaining} / {acc.dailyTotal} {agg.unitName}</td>
                      <td className={acc.health === 'healthy' ? 'healthy' : acc.health === 'expiring' ? 'expiring' : 'exhausted'}>
                        {acc.health === 'healthy' ? '正常' : acc.health === 'expiring' ? '将过期' : acc.health === 'expired' ? '已失效' : '未知'}
                      </td>
                      <td>
                        <button
                          className="btn-sm"
                          onClick={() => void onTest(acc.keyId)}
                          disabled={acc.authType !== 'cookie'}
                          title={acc.authType !== 'cookie' ? 'API Key 无需健康检查' : undefined}
                        >
                          测试
                        </button>{' '}
                        <button
                          className="btn-sm"
                          style={{ color: 'var(--error)' }}
                          onClick={() => void onUnbind(acc.keyId)}
                        >
                          解绑
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </td>
        </tr>
      )}
    </>
  )
}