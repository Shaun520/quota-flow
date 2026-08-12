import { useState } from 'react'
import { IconChevron, IconInfo, PROVIDER_ICONS } from './icons'
import { AddProviderModal } from './Modals'
import Pagination from './Pagination'
import { EmptyState } from './EmptyState'
import Select from './Select'
import type { ProviderAgg, ProvidersResult } from '../hooks/useProviders'
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
  providers: ProvidersResult
}

export default function Providers({ fresh, onBound, providers }: ProvidersProps) {
  const { user } = useAuth()
  const { loading, error, aggs, reload, testHealth, rename, setDefault, setEnabled, unbind } = providers
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
          <Select
            value={statusFilter}
            onChange={(v) => { setStatusFilter(v); setPage(1) }}
            options={[
              { value: '', label: '全部状态' },
              { value: 'online', label: '正常' },
              { value: 'degraded', label: '异常' },
              { value: 'offline', label: '离线' },
              { value: 'unbound', label: '未绑定' }
            ]}
          />
          <button className="btn-sm primary" onClick={() => openAdd()}>
            + 新增厂商
          </button>
        </div>
      </div>

      {error && <div className="auth-msg auth-msg-error">{error}</div>}

      {boundRows.length === 0 && (
          <div className="providers-hint">
            <IconInfo size={14} />
            <span>绑定账号后额度将自动关联到你的账户，智能调度会按可用额度分发任务；停用的账号不会被调度使用。</span>
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
                        onSetDefault={async (keyId) => {
                          await setDefault(p.providerId, keyId)
                        }}
                        onToggleEnabled={async (keyId, enabled) => {
                          await setEnabled(keyId, enabled)
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
  onSetDefault,
  onToggleEnabled,
  onUnbind
}: {
  agg: ProviderAgg
  badge: { cls: string; label: string }
  expanded: boolean
  onToggle: () => void
  onBind: () => void
  onRename: (keyId: string, name: string) => Promise<void>
  onTest: (keyId: string) => Promise<void>
  onSetDefault: (keyId: string) => Promise<void>
  onToggleEnabled: (keyId: string, enabled: boolean) => Promise<void>
  onUnbind: (keyId: string) => Promise<void>
}) {
  const IconComp = PROVIDER_ICONS[agg.providerId]
  const activeBindings = agg.bindings.filter((b) => b.enabled)
  const totalUsed = activeBindings.reduce((s, b) => s + b.used, 0)
  const remaining = activeBindings.reduce((s, b) => s + b.remaining, 0)
  const totalQuota = activeBindings.reduce((s, b) => s + b.dailyTotal, 0)
  const disabledCount = agg.bindings.length - activeBindings.length
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
        <td>{remaining} / {totalQuota}</td>
        <td className="col-accounts">{agg.boundCount} 个账号{disabledCount > 0 ? `（${disabledCount} 已停用）` : ''}</td>
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
                    <tr key={acc.keyId} className={acc.enabled ? '' : 'account-disabled'}>
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
                            {acc.isDefault && (
                              <span
                                style={{
                                  fontSize: 11,
                                  color: '#e07a3e',
                                  border: '1px solid currentColor',
                                  borderRadius: 4,
                                  padding: '0 5px'
                                }}
                              >
                                默认
                              </span>
                            )}
                            {!acc.enabled && (
                              <span className="badge badge-muted" style={{ fontSize: 11, padding: '1px 6px' }}>
                                已停用
                              </span>
                            )}
                            <button
                              className="link-btn"
                              disabled={!acc.enabled}
                              title={acc.enabled ? undefined : '账号已停用，请先启用'}
                              onClick={() => { setEditKeyId(acc.keyId); setEditName(acc.accountName) }}
                            >
                              改名
                            </button>
                          </span>
                        )}
                      </td>
                      <td>{acc.remaining} / {acc.dailyTotal} {agg.unitName}</td>
                      <td className={acc.health === 'healthy' ? 'healthy' : acc.health === 'expiring' ? 'expiring' : 'exhausted'}>
                        {!acc.enabled
                          ? '已停用'
                          : acc.health === 'healthy' ? '正常' : acc.health === 'expiring' ? '将过期' : acc.health === 'expired' ? '已失效' : '未知'}
                      </td>
                      <td>
                        <label
                          className="switch"
                          title={acc.enabled ? '停用后智能调度将跳过该账号' : '启用后该账号可被智能调度使用'}
                        >
                          <input
                            type="checkbox"
                            checked={acc.enabled}
                            onChange={(e) => void onToggleEnabled(acc.keyId, e.target.checked)}
                          />
                          <span className="switch-track">
                            <span className="switch-thumb" />
                          </span>
                          <span className="switch-label">{acc.enabled ? '启用' : '停用'}</span>
                        </label>
                      </td>
                      <td>
                        <button
                          className="btn-sm"
                          disabled={acc.isDefault || !acc.enabled}
                          onClick={() => void onSetDefault(acc.keyId)}
                          title={
                            !acc.enabled
                              ? '账号已停用，请先启用'
                              : acc.isDefault
                                ? '已是默认账号'
                                : '设为默认：优先扣减该账号额度'
                          }
                        >
                          设为默认
                        </button>{' '}
                        <button
                          className="btn-sm"
                          onClick={() => void onTest(acc.keyId)}
                          disabled={acc.authType !== 'cookie' || !acc.enabled}
                          title={
                            !acc.enabled
                              ? '账号已停用，请先启用'
                              : acc.authType !== 'cookie'
                                ? 'API Key 无需健康检查'
                                : undefined
                          }
                        >
                          测试
                        </button>{' '}
                        <button
                          className="btn-sm"
                          style={{ color: 'var(--error)' }}
                          disabled={!acc.enabled}
                          title={acc.enabled ? undefined : '账号已停用，请先启用'}
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
