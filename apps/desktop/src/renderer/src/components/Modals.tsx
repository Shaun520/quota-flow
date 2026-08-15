import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { IconChevron, IconClose, ProviderIconMark } from './icons'
import { BrandMark } from './Brand'
import Select from './Select'
import { getProviderService } from '../auth/service'
import { errMsg } from '../utils/error'
import type { AuthUser } from '../hooks/useAuth'
import type { TeamContext } from '@quota-flow/db-supabase'
import desktopPackage from '../../../../package.json'

export interface UpdaterStatusView {
  state: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'not-available' | 'error'
  version?: string
  progress?: number
  error?: string
}

export type Theme = 'light' | 'dark'
export type FontSize = '12' | '13' | '14' | '15' | '16'
export type HealthFreq = '每 4 小时' | '每 8 小时' | '每 12 小时'

const HEALTH_FREQ_MS: Record<HealthFreq, number> = {
  '每 4 小时': 4 * 60 * 60 * 1000,
  '每 8 小时': 8 * 60 * 60 * 1000,
  '每 12 小时': 12 * 60 * 60 * 1000
}

/** 健康检查节流间隔（毫秒）；供 useProviders 的自动检查复用，设置变更即时生效 */
export function getHealthCheckIntervalMs(): number {
  const stored = localStorage.getItem('qf-health-freq')
  const freq = stored === '每 8 小时' || stored === '每 12 小时' ? stored : '每 4 小时'
  return HEALTH_FREQ_MS[freq]
}

export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme)
  localStorage.setItem('qf-theme', theme)
}

export function getInitialTheme(): Theme {
  const stored = localStorage.getItem('qf-theme')
  if (stored === 'light' || stored === 'dark') return stored
  return 'dark'
}

export function applyFontSize(size: FontSize): void {
  document.documentElement.style.fontSize = size + 'px'
  localStorage.setItem('qf-font-size', size)
}

export function getInitialFontSize(): FontSize {
  const stored = localStorage.getItem('qf-font-size')
  if (['12', '13', '14', '15', '16'].includes(stored ?? '')) return stored as FontSize
  return '13'
}

const IS_DEV = import.meta.env.DEV

/** 调试开关：仅开发模式可设置，生成时是否显示厂商 WebView 窗口（默认隐藏，本地缓存） */
export function applyShowWebview(show: boolean): void {
  localStorage.setItem('qf-show-webview', show ? '1' : '0')
}

export function getInitialShowWebview(): boolean {
  return IS_DEV && localStorage.getItem('qf-show-webview') === '1'
}

export function getInitialHealthFreq(): HealthFreq {
  const stored = localStorage.getItem('qf-health-freq') as HealthFreq | null
  return stored === '每 8 小时' || stored === '每 12 小时' ? stored : '每 4 小时'
}

export function applyHealthFreq(freq: HealthFreq): void {
  localStorage.setItem('qf-health-freq', freq)
}

/** 自动续命 Cookie 开关：localStorage 持久化 + 同步主进程调度器 */
export function getInitialCookieRenew(): '开启' | '关闭' {
  return localStorage.getItem('qf-cookie-renew') === '关闭' ? '关闭' : '开启'
}

export function applyCookieRenew(value: '开启' | '关闭'): void {
  localStorage.setItem('qf-cookie-renew', value)
  void window.api.cookieRenew.setEnabled(value === '开启')
}

interface ModalProps {
  title: string
  onClose: () => void
  children: ReactNode
  footer: ReactNode
}

export function Modal({ title, onClose, children, footer }: ModalProps) {
  return (
    <div
      className="modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-header">
          <h3>{title}</h3>
          <button className="modal-close" onClick={onClose} aria-label="关闭">
            <IconClose size={14} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        <div className="modal-footer">{footer}</div>
      </div>
    </div>
  )
}

function formatDate(iso: string): string {
  if (!iso) return '-'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function ProfileModal({
  user,
  team,
  onClose,
  onSaveDisplayName
}: {
  user: AuthUser
  team: TeamContext | null
  onClose: () => void
  onSaveDisplayName: (name: string) => Promise<string | null>
}) {
  const [name, setName] = useState(user.displayName)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const handleSave = async () => {
    const trimmed = name.trim()
    if (!trimmed) {
      setError('显示名称不能为空')
      return
    }
    setSaving(true)
    setError(null)
    const err = await onSaveDisplayName(trimmed)
    setSaving(false)
    if (err) {
      setError(err)
      return
    }
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  return (
    <Modal
      title="个人中心"
      onClose={onClose}
      footer={
        <>
          <button className="btn-sm" onClick={onClose}>
            取消
          </button>
          <button className="btn-sm primary" onClick={() => void handleSave()} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </button>
        </>
      }
    >
      <div className="form-group">
        <label>邮箱</label>
        <input type="text" value={user.email} readOnly />
      </div>
      <div className="form-group">
        <label>显示名称</label>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="form-group">
        <label>所属团队</label>
        <input type="text" value={team ? `团队 · ${team.id.slice(0, 8)}` : '未加入团队（个人模式）'} readOnly />
      </div>
      <div className="form-group">
        <label>角色</label>
        <input type="text" value={team ? (team.role === 'admin' ? '管理员' : '成员') : '-'} readOnly />
      </div>
      <div className="form-group">
        <label>注册时间</label>
        <input type="text" value={formatDate(user.createdAt)} readOnly />
      </div>
      {error && <div className="auth-msg auth-msg-error">{error}</div>}
      {saved && <div className="auth-msg auth-msg-success">✓ 已保存</div>}
    </Modal>
  )
}

export function SettingsModal({ onClose, updater }: { onClose: () => void; updater: UpdaterStatusView }) {
  const [theme, setTheme] = useState<Theme>(getInitialTheme)
  const [fontSize, setFontSize] = useState<FontSize>(getInitialFontSize)
  const [showWebview, setShowWebview] = useState<boolean>(getInitialShowWebview)
  const [strategy, setStrategy] = useState('可用优先')
  const [cookieRenew, setCookieRenew] = useState<'开启' | '关闭'>(getInitialCookieRenew)
  const [healthFreq, setHealthFreq] = useState<HealthFreq>(getInitialHealthFreq)

  const handleHealthFreqChange = (value: string) => {
    const freq = value as HealthFreq
    setHealthFreq(freq)
    applyHealthFreq(freq)
  }

  const handleThemeChange = (value: Theme) => {
    setTheme(value)
    applyTheme(value)
  }

  const handleFontSizeChange = (value: FontSize) => {
    setFontSize(value)
    applyFontSize(value)
  }

  const handleShowWebviewChange = (value: boolean) => {
    setShowWebview(value)
    applyShowWebview(value)
  }

  return (
    <Modal
      title="设置"
      onClose={onClose}
      footer={
        <>
          <button className="btn-sm" onClick={onClose}>
            取消
          </button>
          <button className="btn-sm primary" onClick={onClose}>
            保存
          </button>
        </>
      }
    >
      <div className="form-group">
        <label>外观主题</label>
        <Select
          value={theme}
          onChange={(v) => handleThemeChange(v as Theme)}
          options={[
            { value: 'dark', label: '暗黑' },
            { value: 'light', label: '浅色' }
          ]}
        />
      </div>
      <div className="form-group">
        <label>显示大小</label>
        <Select
          value={fontSize}
          onChange={(v) => handleFontSizeChange(v as FontSize)}
          options={[
            { value: '12', label: '小 (12px)' },
            { value: '13', label: '默认 (13px)' },
            { value: '14', label: '大 (14px)' },
            { value: '15', label: '特大 (15px)' },
            { value: '16', label: '超大 (16px)' }
          ]}
        />
      </div>
      {IS_DEV && (
        <div className="form-group">
          <label>调试：显示厂商窗口</label>
          <Select
            value={showWebview ? '1' : '0'}
            onChange={(v) => handleShowWebviewChange(v === '1')}
            options={[
              { value: '0', label: '隐藏（默认）' },
              { value: '1', label: '显示（测试用）' }
            ]}
          />
        </div>
      )}
      <div className="form-group">
        <label>调度策略</label>
        <Select
          value={strategy}
          onChange={setStrategy}
          options={[
            { value: '可用优先', label: '可用优先' },
            { value: '轮询均衡', label: '轮询均衡' },
            { value: '成本优先', label: '成本优先' }
          ]}
        />
      </div>
      <div className="form-group">
        <label>自动续命 Cookie</label>
        <Select
          value={cookieRenew}
          onChange={(v) => {
            const value = v as '开启' | '关闭'
            setCookieRenew(value)
            applyCookieRenew(value)
          }}
          options={[
            { value: '开启', label: '开启（每日 03:00 保活）' },
            { value: '关闭', label: '关闭' }
          ]}
        />
      </div>
      <div className="form-group">
        <label>健康检查频率</label>
        <Select
          value={healthFreq}
          onChange={(v) => handleHealthFreqChange(v)}
          options={[
            { value: '每 4 小时', label: '每 4 小时' },
            { value: '每 8 小时', label: '每 8 小时' },
            { value: '每 12 小时', label: '每 12 小时' }
          ]}
        />
      </div>
      <div className="form-group updater-settings">
        <label>检查更新</label>
        <div className="updater-settings-row">
          <span>当前版本：Quota-Flow v{desktopPackage.version}</span>
          <button
            className="btn-sm primary"
            onClick={() => void window.api.updater.check()}
            disabled={updater.state === 'checking' || updater.state === 'downloading'}
          >
            检查更新
          </button>
        </div>
        <div className="updater-settings-state">
          {updater.state === 'checking' ? (
            '正在检查更新...'
          ) : updater.state === 'available' ? (
            `发现新版本 v${updater.version ?? ''}`
          ) : updater.state === 'downloading' ? (
            `正在下载更新 ${Math.round(updater.progress ?? 0)}%`
          ) : updater.state === 'downloaded' ? (
            `新版本 v${updater.version ?? ''} 已下载`
          ) : updater.state === 'not-available' ? (
            '当前已是最新版本'
          ) : updater.state === 'error' ? (
            `更新检查失败：${updater.error ?? ''}`
          ) : (
            '尚未检查更新'
          )}
        </div>
        {updater.state === 'available' ? (
          <button className="btn-sm" onClick={() => void window.api.updater.download()}>
            下载更新
          </button>
        ) : null}
        {updater.state === 'downloaded' ? (
          <button className="btn-sm primary" onClick={() => void window.api.updater.quitAndInstall()}>
            重启安装
          </button>
        ) : null}
      </div>
    </Modal>
  )
}

export function AboutModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal
      title="关于我们"
      onClose={onClose}
      footer={
        <>
          <button className="btn-sm primary" onClick={onClose}>
            知道了
          </button>
        </>
      }
    >
      <div className="about-box">
        <div className="about-brand">
          <BrandMark size={42} />
        </div>
        <div className="about-title">Quota-Flow</div>
        <div className="about-meta">v{desktopPackage.version}</div>
        <p className="about-desc">多厂商视频调度与额度管理的桌面工具。</p>
        <div className="about-grid">
          <div className="config-card">
            <div className="config-label">产品</div>
            <div className="config-val">Quota-Flow</div>
          </div>
          <div className="config-card">
            <div className="config-label">版本</div>
            <div className="config-val">v{desktopPackage.version}</div>
          </div>
        </div>
        <div className="about-team">
          <div className="about-section-title">开发团队</div>
          <div className="about-team-grid">
            <div className="config-card">
              <div className="config-label">项目组</div>
              <div className="config-val">Quota-Flow 项目组</div>
            </div>
            <div className="config-card">
              <div className="config-label">职责</div>
              <div className="config-val">桌面端、调度链路、数据层与运维支持</div>
            </div>
          </div>
          <div className="config-card">
            <div className="config-label">反馈入口</div>
            <div className="config-val">头像菜单 → 问题反馈</div>
          </div>
        </div>
      </div>
    </Modal>
  )
}

export function FeedbackModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal
      title="问题反馈"
      onClose={onClose}
      footer={
        <>
          <button className="btn-sm" onClick={onClose}>
            取消
          </button>
          <button className="btn-sm primary" disabled>
            提交反馈
          </button>
        </>
      }
    >
      <div className="feedback-box">
        <div className="form-group">
          <label>问题类型</label>
          <Select
            value="使用问题"
            onChange={() => {}}
            options={[
              { value: '使用问题', label: '使用问题' },
              { value: '额度异常', label: '额度异常' },
              { value: '账号绑定', label: '账号绑定' },
              { value: '团队功能', label: '团队功能' },
              { value: '建议', label: '建议' }
            ]}
          />
        </div>
        <div className="form-group">
          <label>标题</label>
          <input type="text" placeholder="一句话描述问题" />
        </div>
        <div className="form-group">
          <label>详细描述</label>
          <textarea rows={4} placeholder="补充操作步骤、预期结果和实际表现" />
        </div>
        <div className="form-group">
          <label>图片</label>
          <input type="file" accept="image/*" multiple />
          <div className="feedback-upload-hint">支持 png、jpg、jpeg、webp，可多选</div>
        </div>
        <div className="form-group">
          <label>联系方式</label>
          <input type="text" placeholder="邮箱或微信，方便跟进" />
        </div>
      </div>
    </Modal>
  )
}

interface ProviderOption {
  providerId: string
  name: string
  logo?: string
  authType: string
  enabled: boolean
  boundCount?: number
}

function firstEnabledProvider(providers: ProviderOption[]): ProviderOption | undefined {
  return providers.find((p) => p.enabled !== false)
}

/** 千问/元宝/Dola 这类 cookie 型厂商，已有账号存在时避免重复绑定，优先自动刷新或保存新指纹明确的账号。 */
const AUTO_RESOLVE_EXISTING_PROVIDER_IDS = new Set(['qwenwan', 'yuanbao', 'dola'])

function shouldAutoResolveExistingProvider(providerId: string): boolean {
  return AUTO_RESOLVE_EXISTING_PROVIDER_IDS.has(providerId)
}

function ProviderSelect({
  providers,
  value,
  onChange
}: {
  providers: ProviderOption[]
  value: string
  onChange: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const selected = providers.find((p) => p.providerId === value)

  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="provider-select" ref={rootRef}>
      <button
        type="button"
        className="provider-select-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {selected ? <ProviderIconMark providerId={selected.providerId} logo={selected.logo} size={16} /> : null}
        <span>{selected?.name ?? '选择厂商'}</span>
        <IconChevron size={12} className={'provider-select-chevron' + (open ? ' open' : '')} />
      </button>
      {open && (
        <div className="provider-select-list" role="listbox" aria-label="选择厂商">
          {providers.map((p) => {
            const disabled = p.enabled === false
            return (
              <button
                type="button"
                key={p.providerId}
                role="option"
                aria-selected={!disabled && p.providerId === value}
                aria-disabled={disabled}
                className={
                  'provider-select-item' +
                  (p.providerId === value ? ' active' : '') +
                  (disabled ? ' disabled' : '')
                }
                disabled={disabled}
                onClick={() => {
                  onChange(p.providerId)
                  setOpen(false)
                }}
              >
                <ProviderIconMark providerId={p.providerId} logo={p.logo} size={16} />
                <span>{p.name}</span>
                {disabled && <span className="provider-select-disabled-label">已停用</span>}
                {!disabled && p.providerId === value && (
                  <svg className="provider-select-check" width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M5 13l4 4 10-10" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

export function AddProviderModal({
  providers,
  userId,
  team,
  initialProviderId,
  defaultScope = 'personal',
  onClose,
  onDone
}: {
  providers: ProviderOption[]
  userId: string
  team?: TeamContext | null
  initialProviderId?: string
  defaultScope?: 'personal' | 'team'
  onClose: () => void
  onDone?: () => void
}) {
  const [providerId, setProviderId] = useState(
    initialProviderId && providers.some((p) => p.providerId === initialProviderId && p.enabled !== false)
      ? initialProviderId
      : (firstEnabledProvider(providers)?.providerId ?? '')
  )
  const [accountScope, setAccountScope] = useState<'personal' | 'team'>(
    defaultScope === 'team' && !!team ? 'team' : 'personal'
  )
  const [status, setStatus] = useState<'idle' | 'logging' | 'pick-account' | 'login-ok' | 'login-fail' | 'apikey-ok'>('idle')
  const [apiKey, setApiKey] = useState('')
  const [accountName, setAccountName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [cookieCount, setCookieCount] = useState(0)
  const [saving, setSaving] = useState(false)
  const [existingKeys, setExistingKeys] = useState<Array<{ id: string; accountName: string; accountFingerprint: string | null }>>([])
  const [refreshTarget, setRefreshTarget] = useState<string>('new')
  const [pendingLogin, setPendingLogin] = useState<{
    encrypted: string
    expiresAt: number | null
    fingerprint: string | null
    cookieCount: number
  } | null>(null)
  // 登录时生成的临时 keyId：让登录窗口在 persist:qf-p:<provider>:<tempId> 分区进行
  // 新建账号时 tempId 会作为 DB 记录 id，使「登录分区 = 生成分区」
  // 刷新已有账号时，登录后通过 migratePartition 把 cookie 迁移到目标分区
  const [loginTempId, setLoginTempId] = useState<string | null>(null)

  useEffect(() => {
    const current = providers.find((p) => p.providerId === providerId)
    if (current && current.enabled !== false) return
    const next = firstEnabledProvider(providers)?.providerId ?? ''
    if (next === providerId) return
    setProviderId(next)
    setStatus((prev) => (prev === 'idle' ? prev : 'idle'))
    setError((prev) => (prev === null ? prev : null))
    setNotice((prev) => (prev === null ? prev : null))
    setCookieCount((prev) => (prev === 0 ? prev : 0))
    setApiKey((prev) => (prev === '' ? prev : ''))
    setPendingLogin((prev) => (prev === null ? prev : null))
    setExistingKeys((prev) => (prev.length === 0 ? prev : []))
    setRefreshTarget((prev) => (prev === 'new' ? prev : 'new'))
    setLoginTempId((prev) => (prev === null ? prev : null))
  }, [providers, providerId])

  const selected = providers.find((p) => p.providerId === providerId)
  const isApiKey = selected?.authType === 'apikey'

  const reset = () => {
    setStatus('idle')
    setError(null)
    setNotice(null)
    setCookieCount(0)
    setApiKey('')
    setPendingLogin(null)
    setExistingKeys([])
    setRefreshTarget('new')
    setLoginTempId(null)
  }

  const saveEncrypted = async (
    encrypted: string,
    authType: 'cookie' | 'apikey',
    expiresAt: number | null,
    accountFingerprint?: string | null,
    refreshKeyId?: string | null
  ) => {
    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      const svc = getProviderService()
      if (!svc) throw new Error('数据库服务未配置')
      const targetTeamId = accountScope === 'team' && team ? team.id : null
      const scopeKeys = accountScope === 'team' && team
        ? await svc.listTeamProviderKeys(team.id)
        : (await svc.listProviderKeys(userId)).filter((k) => !k.team_id)

      // 用户明确选择「刷新已有账号」：直接更新该 key 的 cookie（保留 keyId 与额度归属）
      if (refreshKeyId) {
        await svc.refreshProviderKey(userId, refreshKeyId, {
          encryptedKey: encrypted,
          expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
          // 登录刚成功即视为健康（登录会话本身是最强有效性证据），无需等后台健康检查
          healthStatus: 'healthy',
          accountFingerprint: accountFingerprint ?? null
        })
        // 把临时分区的 cookie 迁移到目标账号分区（登录分区 = 生成分区）
        if (loginTempId) {
          try {
            await window.api.providers.migratePartition(providerId, loginTempId, refreshKeyId)
          } catch {}
        }
        const target = existingKeys.find((k) => k.id === refreshKeyId)
        setNotice(`已刷新账号「${target?.accountName ?? '未命名账号'}」的登录态（保留原账号记录）`)
        setSaving(false)
        return true
      }

      // P2 去重：同一账号指纹已存在则拦截（指纹为 null 时跳过）
      if (accountFingerprint) {
        const dup =
          scopeKeys.find(
            (k) => k.provider_id === providerId && k.account_fingerprint === accountFingerprint
          ) ?? null
        if (dup) {
          if (accountScope === 'team' && team && dup.owner_user_id !== userId) {
            throw new Error('该账号已由其他成员绑定，请由绑定成员刷新')
          }
          // 同一账号重新登录：刷新 cookie，保留 keyId 与额度归属
          await svc.refreshProviderKey(userId, dup.id, {
            encryptedKey: encrypted,
            expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
            healthStatus: 'healthy',
            accountFingerprint: accountFingerprint ?? null
          })
          // 把临时分区的 cookie 迁移到已有账号分区
          if (loginTempId) {
            try {
              await window.api.providers.migratePartition(providerId, loginTempId, dup.id)
            } catch {}
          }
          setNotice(`已刷新账号「${dup.account_name ?? '未命名账号'}」的登录态（保留原账号记录）`)
          setSaving(false)
          return true
        }
      }

      // 备注为空时兜底自动命名：<厂商名> 账号 N（按该厂商第 N 个绑定递增）
      const allKeys = scopeKeys
      const sameProvider = allKeys.filter((k) => k.provider_id === providerId)
      const seq = sameProvider.length + 1
      const name = accountName.trim() || `${selected?.name ?? providerId} 账号 ${seq}`

      // 新建账号：用 loginTempId 作为 DB 记录 id，使「登录分区 = 生成分区」
      const saved = await svc.addProviderKey({
        providerId,
        ownerUserId: userId,
        teamId: targetTeamId,
        encryptedKey: encrypted,
        accountName: name,
        authType,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
        accountFingerprint,
        id: loginTempId || undefined,
        healthStatus: 'healthy'
      })

      // 绑定即初始化今日额度行（当天已有则跳过；必须带 keyId，与列表检测口径一致，避免触发二次刷新）
      if (saved) {
        const meta = await svc.listProviders()
        const p = meta.find((m) => m.id === providerId)
        await svc.getOrInitLedger({
          userId,
          providerId,
          unitName: p?.unit_name ?? '',
          dailyTotal: Number(p?.default_daily_quota ?? 0),
          keyId: saved.id,
          teamId: targetTeamId
        })
      }
    } catch (e) {
      setError(errMsg(e))
      setSaving(false)
      return false
    }
    setSaving(false)
    return true
  }

  const saveApiKey = async (): Promise<boolean> => {
    if (!selected) return false
    setError(null)
    if (!apiKey.trim()) {
      setError('请输入 API Key')
      return false
    }
    setStatus('logging')
    try {
      const enc = await window.api.providers.encrypt(selected.providerId, apiKey.trim())
      if (!enc.encrypted) {
        setStatus('idle')
        setError('加密失败')
        return false
      }
      const saved = await saveEncrypted(enc.encrypted, 'apikey', null, enc.fingerprint ?? null, null)
      if (saved) {
        setStatus('apikey-ok')
        return true
      }
      setStatus('idle')
      return false
    } catch (e) {
      setError(errMsg(e))
      setStatus('idle')
      return false
    }
  }

  const handleLoginClick = async () => {
    if (!selected) return
    if (isApiKey) {
      await saveApiKey()
      return
    }
    setStatus('logging')
    // 生成临时 keyId：让登录窗口在 persist:qf-p:<provider>:<tempId> 分区进行
    // 新建账号时 tempId 会作为 DB 记录 id，使「登录分区 = 生成分区」（候选 C）
    const tempId = crypto.randomUUID()
    setLoginTempId(tempId)
    const res = await window.api.providers.login(selected.providerId, tempId)
    if (res.ok && res.encrypted) {
      const encrypted = res.encrypted
      const expiresAt = res.expiresAt ?? null
      setCookieCount(res.cookieCount ?? 0)
      setPendingLogin({
        encrypted,
        expiresAt,
        fingerprint: res.accountFingerprint ?? null,
        cookieCount: res.cookieCount ?? 0
      })
      const svc = getProviderService()
      let existing: Array<{ id: string; accountName: string; accountFingerprint: string | null }> = []
      if (svc) {
        try {
          const keys = accountScope === 'team' && team
            ? await svc.listTeamProviderKeys(team.id)
            : (await svc.listProviderKeys(userId)).filter((k) => !k.team_id)
          existing = keys
            .filter((k) => k.provider_id === selected.providerId)
            .filter((k) => accountScope !== 'team' || k.owner_user_id === userId)
            .map((k) => ({
              id: k.id,
              accountName: k.account_name ?? '未命名账号',
              accountFingerprint: k.account_fingerprint ?? null
            }))
        } catch {}
      }

      const refreshExisting = async (
        target: { id: string; accountName: string; accountFingerprint?: string | null },
        fingerprint?: string | null
      ): Promise<boolean> => {
        if (!svc) return false
        try {
          await svc.refreshProviderKey(userId, target.id, {
            encryptedKey: encrypted,
            expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
            healthStatus: 'healthy',
            accountFingerprint: fingerprint ?? null
          })
          if (loginTempId) {
            try {
              await window.api.providers.migratePartition(selected.providerId, loginTempId, target.id)
            } catch {}
          }
          setPendingLogin(null)
          setNotice(`已刷新账号「${target.accountName}」的登录态（保留原账号记录）`)
          return true
        } catch {
          return false
        }
      }

      // 指纹去重优先：匹配到已有账号 → 直接刷新（不弹选择）；
      // 指纹能识别且无重复 → 暂存待「完成」时保存；仅当已有旧账号没有指纹时自动刷新，避免重复绑定旧数据。
      if (res.accountFingerprint && svc) {
        try {
          const scopeKeys = accountScope === 'team' && team
            ? await svc.listTeamProviderKeys(team.id)
            : (await svc.listProviderKeys(userId)).filter((k) => !k.team_id)
          const dup =
            scopeKeys.find(
              (k) => k.provider_id === selected.providerId && k.account_fingerprint === res.accountFingerprint
            ) ?? null
          if (dup) {
            if (accountScope === 'team' && team && dup.owner_user_id !== userId) {
              setError('该账号已由其他成员绑定，请由绑定成员刷新')
              setStatus('login-fail')
              return
            }
            if (
              await refreshExisting(
                { id: dup.id, accountName: dup.account_name ?? '未命名账号' },
                res.accountFingerprint
              )
            ) {
              setStatus('login-ok')
              return
            }
          }
        } catch {}
        const hasLegacyExisting =
          shouldAutoResolveExistingProvider(selected.providerId) &&
          existing.some((k) => !k.accountFingerprint)
        if (hasLegacyExisting && existing.length > 0) {
          if (await refreshExisting(existing[0], res.accountFingerprint)) {
            setStatus('login-ok')
            return
          }
          setError('刷新已有账号失败，请重试')
          setStatus('login-fail')
          return
        }
        // 无重复：等用户点「完成」保存，此时已确认账号备注
        setStatus('login-ok')
        return
      }

      // 千问/元宝指纹缺失时，不再弹「新增/刷新」选择：
      // 已有账号直接刷新，避免同一账号重复绑定。
      if (shouldAutoResolveExistingProvider(selected.providerId) && existing.length > 0) {
        if (await refreshExisting(existing[0], res.accountFingerprint)) {
          setStatus('login-ok')
          return
        }
        setError('刷新已有账号失败，请重试')
        setStatus('login-fail')
        return
      }

      // 指纹为空且已有账号：无法自动识别 → 让用户选择（新增 / 刷新某个已有账号）
      if (existing.length > 0) {
        setExistingKeys(existing)
        setRefreshTarget('new')
        setStatus('pick-account')
      } else {
        // 首次绑定：等用户点「完成」保存（登录后仍可补充账号备注）
        setStatus('login-ok')
      }
    } else if (res.canceled) {
      setStatus('idle')
      if (res.error) setError(res.error)
    } else {
      setStatus('login-fail')
      setError(res.error ?? '登录失败，请重试')
    }
  }

  /** 「完成」时统一保存：登录成功只暂存 pendingLogin，名字确认后才落库 */
  const handleFinish = async (): Promise<void> => {
    if (saving) return
    if (isApiKey) {
      if (status === 'apikey-ok') {
        onClose()
        onDone?.()
        return
      }
      const saved = await saveApiKey()
      if (saved) {
        onClose()
        onDone?.()
      }
      return
    }
    if (!pendingLogin) {
      onClose()
      onDone?.()
      return
    }
    const saved = await saveEncrypted(
      pendingLogin.encrypted,
      'cookie',
      pendingLogin.expiresAt,
      pendingLogin.fingerprint,
      refreshTarget === 'new' ? null : refreshTarget
    )
    if (saved) {
      onClose()
      onDone?.()
    }
  }

  return (
    <Modal
      title="新增厂商账号"
      onClose={onClose}
      footer={
        <>
          <button className="btn-sm" onClick={onClose} disabled={saving}>
            取消
          </button>
          <button
            className="btn-sm primary"
            onClick={() => void handleFinish()}
            disabled={
              saving ||
              (status !== 'login-ok' &&
                status !== 'apikey-ok' &&
                status !== 'pick-account' &&
                !(isApiKey && apiKey.trim() && status === 'idle'))
            }
          >
            {saving ? '保存中…' : '完成'}
          </button>
        </>
      }
    >
      <div className="form-group">
        <label>选择厂商</label>
        <ProviderSelect
          providers={providers}
          value={providerId}
          onChange={(id) => {
            setProviderId(id)
            reset()
          }}
        />
        {(selected?.boundCount ?? 0) > 0 && (
          <p style={{ margin: '6px 0 0', fontSize: '12px', color: 'var(--accent)' }}>
            该厂商已绑定 {selected!.boundCount} 个账号，请确认不是重复绑定同一账号
          </p>
        )}
      </div>
      {team ? (
        <div className="form-group">
          <label>账号归属</label>
          <Select
            value={accountScope}
            onChange={(v) => setAccountScope(v as 'personal' | 'team')}
            options={[
              { value: 'personal', label: '个人账号（使用个人额度）' },
              { value: 'team', label: '团队账号（共享给团队，使用团队额度）' }
            ]}
          />
          <p style={{ margin: '6px 0 0', fontSize: '12px', color: 'var(--fg-muted)' }}>
            团队账号会显示给团队内成员，并进入团队额度调度。
          </p>
        </div>
      ) : null}
      <div className="form-group">
        <label>账号备注</label>
        <input
          type="text"
          placeholder={`可留空，自动命名为「${selected?.name ?? '厂商'} 账号 N」`}
          value={accountName}
          onChange={(e) => setAccountName(e.target.value)}
          disabled={saving}
        />
        <p style={{ margin: '6px 0 0', fontSize: '12px', color: 'var(--fg-muted)' }}>
          用于在列表中识别该账号（如「工作号」「小号」）
        </p>
      </div>
      {error && <div className="auth-msg auth-msg-error">{error}</div>}
      {notice && (
        <div
          className="auth-msg"
          style={{ color: '#2e7d32', border: '1px solid rgba(46,125,50,0.35)', borderRadius: 8, padding: '8px 10px', fontSize: 12 }}
        >
          {notice}
        </div>
      )}
      <div className="form-group" style={{ background: 'var(--bg-elevated)', padding: '16px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-light)' }}>
        {isApiKey ? (
          <>
            <p style={{ margin: '0 0 12px', fontSize: '13px', color: 'var(--fg-secondary)' }}>
              {selected?.name} 使用 API Key 方式接入，填入后保存。
            </p>
            <input
              type="password"
              placeholder="请输入 API Key"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              disabled={saving}
            />
          </>
        ) : (
          <>
            {status === 'idle' && (
              <>
                <p style={{ margin: '0 0 12px', fontSize: '13px', color: 'var(--fg-secondary)' }}>
                  点击按钮将打开 {selected?.name ?? '厂商'} 登录窗口。请在窗口中完成登录，登录成功后点击「已完成登录」。
                </p>
                <button className="btn-sm primary" onClick={() => void handleLoginClick()}>
                  前往 {selected?.name ?? '厂商'} 登录 →
                </button>
              </>
            )}
            {status === 'logging' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--fg-muted)' }}>
                <span className="spinner" style={{ width: 14, height: 14, border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                正在获取登录状态，请在登录窗口完成登录…
              </div>
            )}
            {status === 'login-fail' && (
              <div>
                <p style={{ margin: '0 0 12px', fontSize: '13px', color: 'var(--error)' }}>
                  登录未获取到 Cookie，请重试。
                </p>
                <button className="btn-sm primary" onClick={() => void handleLoginClick()}>
                  重新登录
                </button>
              </div>
            )}
            {status === 'pick-account' && pendingLogin && (
              <div>
                <p style={{ margin: '0 0 10px', fontSize: '13px', color: 'var(--fg-secondary)' }}>
                  该厂商已有 {existingKeys.length} 个账号，请选择：
                </p>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, marginBottom: 8 }}>
                  <input
                    type="radio"
                    checked={refreshTarget === 'new'}
                    onChange={() => setRefreshTarget('new')}
                  />
                  新增账号
                </label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, marginBottom: 12 }}>
                  <input
                    type="radio"
                    checked={refreshTarget !== 'new'}
                    onChange={() => setRefreshTarget(existingKeys[0]?.id ?? 'new')}
                  />
                  <span>刷新已有账号</span>
                  {refreshTarget !== 'new' && (
                    <Select
                      value={refreshTarget}
                      onChange={setRefreshTarget}
                      options={existingKeys.map((k) => ({ value: k.id, label: k.accountName }))}
                      style={{ marginLeft: 4, minWidth: 140 }}
                    />
                  )}
                </div>
                <button className="btn-sm primary" onClick={() => void handleFinish()} disabled={saving}>
                  {saving ? '保存中…' : '保存并完成'}
                </button>
              </div>
            )}
            {(status === 'login-ok' || status === 'apikey-ok') && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#4ade80' }}>
                <span>✓ {isApiKey ? 'API Key 已加密保存' : `已获取账号（${cookieCount} 个 Cookie），点击「完成」保存`}</span>
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}
