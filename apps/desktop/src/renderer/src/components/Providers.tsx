import { useEffect, useRef, useState } from 'react'
import { IconChevron, IconClose, IconInfo, IconRefresh, ProviderIconMark } from './icons'
import { AddProviderModal } from './Modals'
import Pagination from './Pagination'
import { EmptyState } from './EmptyState'
import Select from './Select'
import type { ProviderAgg, ProvidersResult } from '../hooks/useProviders'
import { getProviderService } from '../auth/service'
import { useAuth } from '../hooks/useAuth'
import type { UsageScope, ViewScope } from '@quota-flow/db-supabase'
import type { ApiModelInfo } from '../../../preload'

const PAGE_SIZE = 10

// 火山「查看模型」额度缓存有效期：有效期内点开不再触发 webview 同步，直接秒开展示缓存值；过期后台静默刷新
const VOLC_VIEW_MODELS_CACHE_MS = 5 * 60 * 1000

/** 顶部额度汇总条
 * - volcengine：聚合免费模型的额度（保持火山方舟原有展示，单位 tokens）
 * - zhipu（及其他）：展示账号级共用额度（付费模型共用），单位按厂商配置
 */
function ModelsQuotaSummary({
  providerId,
  models,
  quota,
  unit = 'tokens',
}: {
  providerId: string
  models: ApiModelInfo[]
  quota: { available: boolean; total: number; remaining: number } | null
  unit?: string
}) {
  if (providerId === 'volcengine') {
    // 火山方舟：聚合所有免费模型额度。
    // total 含已开通 + 未开通的所有免费模型；remaining 只计已开通（activated !== false）模型的可用量。
    const modelsWithQuota = models.filter((m) => m.cost === 0 && m.freeQuota?.total)
    const total = modelsWithQuota.reduce((sum, m) => sum + (m.freeQuota?.total ?? 0), 0)
    const remaining = modelsWithQuota
      .filter((m) => m.activated !== false)
      .reduce((sum, m) => sum + (m.freeQuota?.remaining ?? 0), 0)
    if (total <= 0) return null
    const pct = Math.min(100, Math.max(0, (remaining / total) * 100))
    return (
      <div className="models-summary">
        <div className="models-summary-bar">
          <div className="models-summary-bar-fill" style={{ width: `${pct}%` }} />
        </div>
        <div className="models-summary-text">
          <span className="models-summary-value">
            {remaining.toLocaleString()} <span className="models-summary-unit">tokens</span>
          </span>
          <span className="models-summary-sep">/</span>
          <span className="models-summary-total">{total.toLocaleString()}</span>
        </div>
      </div>
    )
  }
  // 其他厂商（智谱等）：账号级共用额度
  if (!quota || !quota.available) return null
  const pct = Math.min(100, Math.max(0, (quota.remaining / Math.max(1, quota.total)) * 100))
  return (
    <div className="models-summary">
      <div className="models-summary-bar">
        <div className="models-summary-bar-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="models-summary-text">
        <span className="models-summary-label">共用额度</span>
        <span className="models-summary-value">
          {quota.remaining.toLocaleString()} <span className="models-summary-unit">{unit}</span>
        </span>
        <span className="models-summary-sep">/</span>
        <span className="models-summary-total">{quota.total.toLocaleString()}</span>
      </div>
    </div>
  )
}

/** 单行模型用量
 * - volcengine：免费模型显示自身免费额度（含待开通徽章），单位 tokens
 * - zhipu 等：免费模型显示自身免费额度；付费模型显示账号级共用额度，单位按厂商配置
 */
function ModelQuotaCell({
  providerId,
  model,
  sharedQuota,
  unit = 'tokens',
}: {
  providerId: string
  model: ApiModelInfo
  sharedQuota: { available: boolean; total: number; remaining: number } | null
  unit?: string
}) {
  const isFree = model.cost === 0
  const freeQuota = model.freeQuota

  if (providerId === 'volcengine') {
    // 火山方舟：不可用模型（已下架 / 无接入点）置灰 + 徽标，提示原因
    const unavail = model.unavailable
    if (unavail === 'decommissioned' || unavail === 'no_endpoint') {
      return (
        <span
          className="models-quota-cell"
          title={unavail === 'decommissioned' ? '该模型已被火山平台下架/停用，无法生成' : '该账号无此模型接入点，无法生成；可在开通管理页开通或更换模型'}
        >
          <span className={unavail === 'decommissioned' ? 'badge badge-danger' : 'badge badge-pending'}>
            {unavail === 'decommissioned' ? '已下架' : '无接入点'}
          </span>
          <span className="models-quota-text models-quota-text--dim">不可生成</span>
        </span>
      )
    }
    // 火山方舟：免费模型 + 待开通徽章
    const activated = model.activated !== false
    if (!activated) {
      const quotaText = freeQuota?.total
        ? `${typeof freeQuota.remaining === 'number' ? freeQuota.remaining.toLocaleString() : '—'} / ${freeQuota.total.toLocaleString()} tokens`
        : '—'
      return (
        <span className="models-quota-cell" title="未开通该模型，需在火山方舟控制台开通后才会下发免费额度">
          <span className="badge badge-pending">待开通</span>
          <span className="models-quota-text models-quota-text--dim">{quotaText}</span>
        </span>
      )
    }
    if (freeQuota?.total) {
      return (
        <span className="models-quota-text">
          {typeof freeQuota.remaining === 'number' ? freeQuota.remaining.toLocaleString() : '—'} / {freeQuota.total.toLocaleString()} tokens
        </span>
      )
    }
    // 已开通但接口未返回免费额度（额度耗尽/不在权威列表）：接口为准，未知保守，避免 DOM 旧值误导
    return (
      <span className="models-quota-text models-quota-text--dim" title="接口未返回该模型的免费推理额度，暂不展示具体数值">
        — 未知
      </span>
    )
  }

  // 其他厂商（智谱等）
  if (isFree) {
    // 免费模型：显示自身额度
    if (freeQuota?.total) {
      return (
        <span className="models-quota-text">
          {typeof freeQuota.remaining === 'number' ? freeQuota.remaining.toLocaleString() : '—'} / {freeQuota.total.toLocaleString()} {unit}
        </span>
      )
    }
    return <span className="models-quota-text models-quota-text--dim">—</span>
  }
  // 付费模型：共用账号级额度
  if (sharedQuota?.available) {
    return (
      <span className="models-quota-text" title="付费模型共用该额度">
        共用{sharedQuota.remaining.toLocaleString()} / {sharedQuota.total.toLocaleString()} {unit}
      </span>
    )
  }
  return <span className="models-quota-text models-quota-text--dim">—</span>
}

function statusBadge(p: ProviderAgg): { cls: string; label: string } {
  if (!p.enabled) return { cls: 'badge-muted', label: '已停用' }
  if (p.health === 'offline') return { cls: 'badge-error', label: '离线' }
  if (p.health === 'degraded') return { cls: 'badge-pending', label: p.healthLabel }
  if (p.health === 'unbound') return { cls: 'badge-muted', label: '未绑定' }
  return { cls: 'badge-success', label: p.healthLabel }
}

interface ProvidersProps {
  fresh: boolean
  viewScope: ViewScope
  usageScope: UsageScope
  onBound?: () => void
  providers: ProvidersResult
  canBind?: boolean
}

export default function Providers({ fresh, viewScope, usageScope, onBound, providers, canBind = true }: ProvidersProps) {
  const { user, team } = useAuth()
  const { loading, refreshing, error, aggs, reload, testHealth, rename, setDefault, setEnabled, setProviderKeyScope, unbind, zhipuQuotaOverrides, volcTokenOverrides, setKeyHealth, refreshVolcengineModelsOnce } = providers
  const [text, setText] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [showAddModal, setShowAddModal] = useState(false)
  const [addTarget, setAddTarget] = useState<string | undefined>(undefined)
  const [page, setPage] = useState(1)
  const [justRefreshed, setJustRefreshed] = useState(false)
  const [siteError, setSiteError] = useState('')
  // 顶部居中悬浮提示（API Key 测试结果等）
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null)
  // 「查看模型」弹窗
  const [models, setModels] = useState<ApiModelInfo[] | null>(null)
  const [modelsLoading, setModelsLoading] = useState(false)
  const [modelsLabel, setModelsLabel] = useState('')
  const [modelsProviderId, setModelsProviderId] = useState<string>('')
  // 弹窗顶部免费额度用量（该账号真实资源包余额；付费模型共用）
  const [modelsQuota, setModelsQuota] = useState<{ available: boolean; total: number; remaining: number } | null>(null)
  const [modelsUnit, setModelsUnit] = useState('次')
  const wasRefreshing = useRef(false)
  // 「查看模型」弹窗同步令牌：关闭/重开时忽略过期的异步结果，避免同步完成后弹窗被重新打开
  const modelsTokenRef = useRef(0)

  const showToast = (msg: string, ok = true) => {
    setToast({ msg, ok })
    window.setTimeout(() => setToast(null), 2600)
  }

  // API Key 型厂商「测试」：解密后调开放平台只读接口校验，不产生费用
  const handleTestApiKey = async (providerId: string, keyId: string) => {
    try {
      const svc = getProviderService()
      if (!svc || !user) {
        showToast('登录状态异常，无法测试', false)
        return
      }
      const secret = await svc.getProviderKeySecret(user.id, keyId)
      if (!secret) {
        showToast('未找到该账号密钥', false)
        return
      }
      const res = await window.api.providers.testApiKey(providerId, secret.encrypted_key)
      if (res.ok) {
        setKeyHealth(keyId, 'healthy')
        showToast('API Key 可用', true)
      } else {
        setKeyHealth(keyId, 'expired')
        showToast(res.error ? `API Key 异常：${res.error}` : 'API Key 异常', false)
      }
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), false)
    }
  }

  // API Key 型厂商「查看模型」：拉取模型目录（火山方舟先展示缓存额度，再按 5min 缓存后台静默同步刷新）
  const handleViewModels = async (providerId: string, keyId: string, accountName: string, unitName: string) => {
    // 立即弹出弹窗并进入加载态，让火山方舟较慢的静默同步有可见反馈
    const token = ++modelsTokenRef.current
    setModels(null)
    setModelsLabel(accountName)
    setModelsProviderId(providerId)
    setModelsQuota(zhipuQuotaOverrides[keyId] ?? null)
    setModelsUnit(unitName)
    setModelsLoading(true)
    try {
      let encrypted: string | undefined
      // 火山方舟：取该账号密钥负载，供主进程读取每模型免费 token 额度
      if (providerId === 'volcengine') {
        const svc = getProviderService()
        if (svc && user) {
          const secret = await svc.getProviderKeySecret(user.id, keyId)
          if (secret) encrypted = secret.encrypted_key
        }
      }
      // 先立即用缓存展示模型目录，让弹窗第一次打开就秒出内容
      if (token !== modelsTokenRef.current) return
      const cachedRes = encrypted ? await window.api.providers.apiModels(providerId, encrypted) : null
      if (token !== modelsTokenRef.current) return
      if (cachedRes?.ok && cachedRes.models) {
        setModels(cachedRes.models)
        setModelsLoading(false)
      }
      // 后台静默同步最新额度/开通状态（火山方舟：命中 5min 缓存则跳过，否则同步后刷新展示）
      if (providerId === 'volcengine') {
        const fresh = await refreshVolcengineModelsOnce(keyId, { maxStaleMs: VOLC_VIEW_MODELS_CACHE_MS })
        if (fresh && token === modelsTokenRef.current) {
          const newRes = await window.api.providers.apiModels(providerId, fresh)
          if (token === modelsTokenRef.current && newRes.ok && newRes.models) {
            setModels(newRes.models)
          }
        }
        // 非火山：无缓存可秒开，同步完成后重新拉取展示最新值
      } else if (cachedRes && (!cachedRes.ok || !cachedRes.models)) {
        const res = await window.api.providers.apiModels(providerId, encrypted)
        if (token === modelsTokenRef.current) {
          if (res.ok && res.models) {
            setModels(res.models)
          } else {
            showToast(res.error || '无法加载模型目录', false)
            setModels(null)
          }
        }
      }
    } catch (e) {
      if (token === modelsTokenRef.current) {
        showToast(e instanceof Error ? e.message : String(e), false)
        setModels(null)
      }
    } finally {
      if (token === modelsTokenRef.current) setModelsLoading(false)
    }
  }

  // 关闭「查看模型」弹窗：同时重置加载态，避免加载中无法关闭
  const closeModels = () => {
    modelsTokenRef.current++ // 使在途同步结果失效，防止完成后重新打开弹窗
    setModels(null)
    setModelsLoading(false)
  }

  useEffect(() => {
    if (refreshing) {
      wasRefreshing.current = true
      setJustRefreshed(false)
      return
    }
    if (!wasRefreshing.current) return
    wasRefreshing.current = false
    setJustRefreshed(true)
    const timer = window.setTimeout(() => setJustRefreshed(false), 1600)
    return () => window.clearTimeout(timer)
  }, [refreshing])

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

  const openSite = async (providerId: string, keyId: string) => {
    setSiteError('')
    try {
      const svc = getProviderService()
      if (!svc || !user) {
        setSiteError('登录状态异常，无法打开官网')
        return
      }
      const secret = await svc.getProviderKeySecret(user.id, keyId)
      if (!secret) {
        setSiteError('未找到该账号密钥，无法打开官网')
        return
      }
      const res = await window.api.providers.openSite(providerId, keyId, secret.encrypted_key)
      if (!res.ok) setSiteError(res.error || '无法打开官网')
    } catch (e) {
      setSiteError(e instanceof Error ? e.message : String(e))
    }
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
          <button className="btn-sm refresh-btn" onClick={reload} disabled={loading || refreshing}>
            <IconRefresh size={14} className={loading || refreshing ? 'spin' : undefined} />
            {loading || refreshing ? '\u5237\u65b0\u4e2d' : justRefreshed ? '\u5df2\u5237\u65b0' : '\u5237\u65b0'}
          </button>
          {canBind && (
            <button className="btn-sm primary" onClick={() => openAdd()}>
              + 新增厂商
            </button>
          )}
        </div>
      </div>

      {(error || siteError) && (
        <div className="auth-msg auth-msg-error">{error || siteError}</div>
      )}

      {toast && (
        <div className={
          'account-top-toast ' + (toast.ok ? 'account-top-toast-ok' : 'account-top-toast-err')
        }>
          {toast.msg}
        </div>
      )}

      {boundRows.length === 0 && (
          <div className="providers-hint">
            <IconInfo size={14} />
            <span>绑定账号后额度将自动关联到你的账户，智能调度会按可用额度分发任务；停用的账号不会被调度使用。</span>
          </div>
        )}

      <div className="provider-table-wrap">
        {(loading || refreshing) && (
          <div className="table-refresh-overlay">{loading ? '加载中...' : '刷新中...'}</div>
        )}
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
                        canBind ? (
                          <button className="btn-sm primary" onClick={() => openAdd()}>
                            + 新增厂商
                          </button>
                        ) : (
                          <span className="providers-hint">管理员已关闭账号绑定入口</span>
                        )
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
                        viewScope={viewScope}
                        badge={badge}
                        expanded={isExpanded}
                        onToggle={() => setExpanded((prev) => ({ ...prev, [p.providerId]: !prev[p.providerId] }))}
                        onBind={() => openAdd(p.providerId)}
                        canBind={canBind}
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
                        onSetScope={async (keyId, teamId) => {
                          await setProviderKeyScope(keyId, teamId)
                        }}
                        onOpenSite={(keyId) => openSite(p.providerId, keyId)}
                        onTestApiKey={(keyId) => handleTestApiKey(p.providerId, keyId)}
                        onViewModels={(keyId, accountName) => handleViewModels(p.providerId, keyId, accountName, p.unitName)}
                        zhipuQuotaOverrides={zhipuQuotaOverrides}
                        volcTokenOverrides={volcTokenOverrides}
                        currentUserId={user?.id ?? ''}
                        team={team}
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
          providers={aggs.map((a) => ({ providerId: a.providerId, name: a.name, logo: a.logo, authType: a.authType, enabled: a.enabled, boundCount: a.boundCount }))}
          userId={user.id}
          team={team}
          initialProviderId={addTarget}
          defaultScope={viewScope === 'team' && team ? 'team' : 'personal'}
          onClose={() => setShowAddModal(false)}
          onDone={() => {
            setShowAddModal(false)
            onBound?.()
            reload()
          }}
        />
      )}

      {(models || modelsLoading) && (
        <div className="modal-overlay" onClick={closeModels}>
          <div className="modal models-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{modelsLabel}</h3>
              <button className="modal-close" onClick={closeModels} aria-label="关闭">
                <IconClose size={14} />
              </button>
            </div>
            <div className="modal-body">
              {modelsLoading ? (
                <div className="models-loading">
                  <span
                    className="spinner"
                    style={{ width: 20, height: 20, border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }}
                  />
                  <span>{modelsProviderId === 'volcengine' ? '正在同步最新免费额度，请稍候…' : '正在加载模型目录，请稍候…'}</span>
                </div>
              ) : models ? (
                <>
                  <ModelsQuotaSummary providerId={modelsProviderId} models={models} quota={modelsQuota} unit={modelsUnit} />
                  <table className="models-table">
                    <thead>
                      <tr>
                        <th>模型</th>
                        <th>用量</th>
                        <th>价格</th>
                      </tr>
                    </thead>
                    <tbody>
                      {models.map((m) => (
                        <tr
                          key={m.model}
                          className={m.unavailable ? 'models-row-disabled' : undefined}
                          title={m.unavailable === 'decommissioned' ? '该模型已被火山平台下架/停用，无法生成' : m.unavailable === 'no_endpoint' ? '该账号无此模型接入点，无法生成；可在开通管理页开通或更换模型' : undefined}
                        >
                          <td className="models-cell-model">
                            <code className="models-model-code">{m.model}</code>
                          </td>
                          <td className="models-cell-quota">
                            <ModelQuotaCell providerId={modelsProviderId} model={m} sharedQuota={modelsQuota} unit={modelsUnit} />
                          </td>
                          <td>
                            <span
                              className={'badge ' + (m.cost === 0 ? (m.activated === false ? 'badge-pending' : 'badge-success') : 'badge-pending')}
                              title={m.activated === false ? '未开通模型，需在火山方舟控制台开通' : undefined}
                            >
                              {m.priceLabel}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              ) : null}
            </div>
            <div className="modal-footer">
              <button className="btn-sm primary" onClick={closeModels}>关闭</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function ProviderRow({
  agg,
  viewScope,
  badge,
  expanded,
  onToggle,
  onBind,
  canBind,
  onTest,
  onRename,
  onSetDefault,
  onToggleEnabled,
  onUnbind,
  onSetScope,
  onOpenSite,
  onTestApiKey,
  onViewModels,
  zhipuQuotaOverrides,
  volcTokenOverrides,
  currentUserId,
  team
}: {
  agg: ProviderAgg
  viewScope: ViewScope
  badge: { cls: string; label: string }
  expanded: boolean
  onToggle: () => void
  onBind: () => void
  canBind: boolean
  onRename: (keyId: string, name: string) => Promise<void>
  onTest: (keyId: string) => Promise<void>
  onSetDefault: (keyId: string) => Promise<void>
  onToggleEnabled: (keyId: string, enabled: boolean) => Promise<void>
  onUnbind: (keyId: string) => Promise<void>
  onSetScope: (keyId: string, teamId: string | null) => Promise<void>
  onOpenSite: (keyId: string) => Promise<void>
  onTestApiKey: (keyId: string) => Promise<void>
  onViewModels: (keyId: string, accountName: string) => Promise<void>
  zhipuQuotaOverrides: Record<string, { available: boolean; total: number; remaining: number; expired?: boolean }>
  volcTokenOverrides: Record<string, { remaining: number; total: number } | null>
  currentUserId: string
  team: { id: string } | null
}) {
  const isApiKeyProvider = agg.authType === 'apikey'
  const activeBindings = agg.bindings.filter((b) => b.enabled)
  const totalUsed = activeBindings.reduce((s, b) => s + b.used, 0)
  // API 型厂商：额度以平台真实资源包余额 / token 汇总为准，而非静态默认日额度；汇总只累计有可用数据的账号
  const isApiQuota = agg.providerId === 'zhipu'
  const isVolc = agg.providerId === 'volcengine'
  const quotaOf = (keyId: string) =>
    isApiQuota
      ? zhipuQuotaOverrides[keyId] && zhipuQuotaOverrides[keyId].available
        ? zhipuQuotaOverrides[keyId]
        : undefined
      : isVolc
        ? volcTokenOverrides[keyId] && volcTokenOverrides[keyId]!.total > 0
          ? volcTokenOverrides[keyId]
          : undefined
        : undefined
  const remaining = activeBindings.reduce(
    (s, b) => s + (isApiQuota || isVolc ? quotaOf(b.keyId)?.remaining ?? 0 : b.remaining),
    0
  )
  const totalQuota = activeBindings.reduce(
    (s, b) => s + (isApiQuota || isVolc ? quotaOf(b.keyId)?.total ?? 0 : b.dailyTotal),
    0
  )
  // 火山方舟：所有启用账号都未拿到真实 token 汇总时，厂商行总计显示占位（避免展示假的 0/0 或账本日额度）
  const volcNoQuota =
    isVolc && activeBindings.length > 0 && activeBindings.every((b) => !(volcTokenOverrides[b.keyId] && volcTokenOverrides[b.keyId]!.total > 0))
  const disabledCount = agg.bindings.length - activeBindings.length
  const [editKeyId, setEditKeyId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [savingName, setSavingName] = useState(false)

  return (
    <>
      <tr className={!agg.enabled ? 'provider-disabled' : ''}>
        <td>
          <button className={'expand-btn' + (expanded ? ' expanded' : '')} onClick={onToggle} aria-label="展开账号">
            <IconChevron size={12} />
          </button>
        </td>
        <td className="col-name">
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
            <ProviderIconMark providerId={agg.providerId} logo={agg.logo} size={18} />
            {agg.name}
          </span>
        </td>
        <td>{agg.unitName}</td>
        <td>{volcNoQuota ? <span className="models-quota-text--dim">—</span> : `${remaining.toLocaleString()} / ${totalQuota.toLocaleString()}`}</td>
        <td className="col-accounts">{agg.boundCount} 个账号{disabledCount > 0 ? `（${disabledCount} 已停用）` : ''}</td>
        <td>
          <span className={'badge ' + badge.cls}>{badge.label}</span>
        </td>
        <td>
          <button
            className="btn-sm primary"
            onClick={onBind}
            disabled={!canBind || !agg.enabled}
            title={!canBind ? '管理员已关闭账号绑定入口' : agg.enabled ? undefined : '厂商已停用，暂不能绑定账号'}
          >
            {!canBind ? '绑定已关闭' : agg.enabled ? '绑定账号' : '已停用'}
          </button>
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
                          <span className="account-name-cell">
                            <span className="account-name-line">
                              <strong>{acc.accountName}</strong>
                              {viewScope === 'global' ? (
                                <span className="account-scope-suffix">
                                  {acc.teamId ? '（团队）' : '（个人）'}
                                </span>
                              ) : null}
                              {acc.isDefault && <span className="account-flag account-flag-default">默认</span>}
                              {!acc.enabled && (
                                <span className="badge badge-muted account-flag">已停用</span>
                              )}
                              {acc.ownerUserId === currentUserId ? (
                                <button
                                  className="link-btn"
                                  disabled={!acc.enabled}
                                  title={acc.enabled ? undefined : '账号已停用，请先启用'}
                                  onClick={() => { setEditKeyId(acc.keyId); setEditName(acc.accountName) }}
                                >
                                  改名
                                </button>
                              ) : null}
                            </span>
                          </span>
                        )}
                      </td>
                      <td>
                        {agg.providerId === 'zhipu' ? (
                          (() => {
                            const q = zhipuQuotaOverrides[acc.keyId]
                            return (
                              <span>{q?.available ? `${q.remaining} / ${q.total} ${agg.unitName}` : '—'}</span>
                            )
                          })()
                        ) : agg.providerId === 'volcengine' ? (
                          (() => {
                            const t = volcTokenOverrides[acc.keyId]
                            // 已取到真实 token 汇总：显示真实额度（剩余 / 总数 token）
                            if (t && t.total > 0) {
                              return <span>{t.remaining.toLocaleString()} / {t.total.toLocaleString()} tokens</span>
                            }
                            // 拉取完成但未拿到真实额度：显示占位提示，替代账本假额度（50/50 次）
                            if (t === null) {
                              return <span className="models-quota-text models-quota-text--dim">额度待查看</span>
                            }
                            // 拉取中：短暂沿用旧值避免闪烁
                            return <span>{acc.remaining} / {acc.dailyTotal} {agg.unitName}</span>
                          })()
                        ) : (
                          `${acc.remaining} / ${acc.dailyTotal} ${agg.unitName}`
                        )}
                      </td>
                      <td className={acc.health === 'healthy' ? 'healthy' : acc.health === 'expiring' ? 'expiring' : 'exhausted'}>
                        {!acc.enabled
                          ? '已停用'
                          : acc.health === 'healthy' ? '正常' : acc.health === 'expiring' ? '将过期' : acc.health === 'expired' ? '已失效' : '未知'}
                      </td>
                      <td>
                        {acc.ownerUserId === currentUserId ? (
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
                        ) : (
                          <span className="account-readonly-note">只读</span>
                        )}
                      </td>
                      <td>
                        {!isApiKeyProvider || agg.providerId === 'zhipu' || agg.providerId === 'volcengine' ? (
                          <>
                            <button
                              className="btn-sm"
                              onClick={() => void onOpenSite(acc.keyId)}
                              title={
                                agg.providerId === 'zhipu'
                                  ? '打开已登录的智谱控制台（复用当前会话，免重复登录）'
                                  : '打开该账号对应的官网页面'
                              }
                            >
                              进入官网
                            </button>{' '}
                          </>
                        ) : null}
                        {acc.ownerUserId === currentUserId ? (
                          <>
                            {acc.teamId ? (
                              <button
                                className="btn-sm"
                                onClick={() => void onSetScope(acc.keyId, null)}
                                title="把该账号取消共享，回到个人账号"
                              >
                                取消共享
                              </button>
                            ) : team ? (
                              <button
                                className="btn-sm"
                                onClick={() => void onSetScope(acc.keyId, team.id)}
                                title="把该账号共享给当前团队"
                              >
                                共享到团队
                              </button>
                            ) : null}{' '}
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
                              onClick={() => void (agg.authType === 'apikey' ? onTestApiKey(acc.keyId) : onTest(acc.keyId))}
                              disabled={!acc.enabled}
                              title={!acc.enabled ? '账号已停用，请先启用' : undefined}
                            >
                              测试
                            </button>{' '}
                            {agg.authType === 'apikey' && (
                              <button
                                className="btn-sm"
                                onClick={() => void onViewModels(acc.keyId, acc.accountName)}
                                disabled={!acc.enabled}
                                title={!acc.enabled ? '账号已停用，请先启用' : '查看该账号支持的模型、价格与生成模式'}
                              >
                                查看模型
                              </button>
                            )}{' '}
                            <button
                              className="btn-sm"
                              style={{ color: 'var(--error)' }}
                              disabled={!acc.enabled}
                              title={acc.enabled ? undefined : '账号已停用，请先启用'}
                              onClick={() => void onUnbind(acc.keyId)}
                            >
                              解绑
                            </button>
                          </>
                        ) : (
                          <span className="account-readonly-note">只读</span>
                        )}
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
