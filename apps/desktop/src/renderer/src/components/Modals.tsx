import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { IconChevron, IconClose, PROVIDER_ICONS } from './icons'
import { getProviderService } from '../auth/service'
import { errMsg } from '../utils/error'
import type { AuthUser } from '../hooks/useAuth'
import type { TeamContext } from '@quota-flow/db-supabase'

export type Theme = 'light' | 'dark'
export type FontSize = '12' | '13' | '14' | '15' | '16'

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

interface ModalProps {
  title: string
  onClose: () => void
  children: ReactNode
  footer: ReactNode
}

function Modal({ title, onClose, children, footer }: ModalProps) {
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

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const [theme, setTheme] = useState<Theme>(getInitialTheme)
  const [fontSize, setFontSize] = useState<FontSize>(getInitialFontSize)

  const handleThemeChange = (value: Theme) => {
    setTheme(value)
    applyTheme(value)
  }

  const handleFontSizeChange = (value: FontSize) => {
    setFontSize(value)
    applyFontSize(value)
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
        <select value={theme} onChange={(e) => handleThemeChange(e.target.value as Theme)}>
          <option value="dark">暗黑</option>
          <option value="light">浅色</option>
        </select>
      </div>
      <div className="form-group">
        <label>显示大小</label>
        <select value={fontSize} onChange={(e) => handleFontSizeChange(e.target.value as FontSize)}>
          <option value="12">小 (12px)</option>
          <option value="13">默认 (13px)</option>
          <option value="14">大 (14px)</option>
          <option value="15">特大 (15px)</option>
          <option value="16">超大 (16px)</option>
        </select>
      </div>
      <div className="form-group">
        <label>调度策略</label>
        <select defaultValue="可用优先">
          <option>可用优先</option>
          <option>轮询均衡</option>
          <option>质量优先</option>
          <option>成本优先</option>
        </select>
      </div>
      <div className="form-group">
        <label>质量阈值（低于此值自动重试）</label>
        <input type="range" min={1} max={5} step={0.1} defaultValue={3} style={{ accentColor: 'var(--accent)' }} />
      </div>
      <div className="form-group">
        <label>运行模式</label>
        <select defaultValue="官方托管（推荐）">
          <option>官方托管（推荐）</option>
          <option>自部署</option>
        </select>
      </div>
      <div className="form-group">
        <label>自动续命 Cookie</label>
        <select defaultValue="开启">
          <option>开启</option>
          <option>关闭</option>
        </select>
      </div>
      <div className="form-group">
        <label>健康检查频率</label>
        <select defaultValue="每 4 小时">
          <option>每 4 小时</option>
          <option>每 8 小时</option>
          <option>每 12 小时</option>
        </select>
      </div>
    </Modal>
  )
}

interface ProviderOption {
  providerId: string
  name: string
  authType: string
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

  const SelectedIcon = selected ? PROVIDER_ICONS[selected.providerId] : undefined

  return (
    <div className="provider-select" ref={rootRef}>
      <button
        type="button"
        className="provider-select-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {SelectedIcon ? <SelectedIcon size={16} /> : null}
        <span>{selected?.name ?? '选择厂商'}</span>
        <IconChevron size={12} className={'provider-select-chevron' + (open ? ' open' : '')} />
      </button>
      {open && (
        <div className="provider-select-list" role="listbox" aria-label="选择厂商">
          {providers.map((p) => {
            const Icon = PROVIDER_ICONS[p.providerId]
            return (
              <button
                type="button"
                key={p.providerId}
                role="option"
                aria-selected={p.providerId === value}
                className={'provider-select-item' + (p.providerId === value ? ' active' : '')}
                onClick={() => {
                  onChange(p.providerId)
                  setOpen(false)
                }}
              >
                {Icon ? <Icon size={16} /> : null}
                <span>{p.name}</span>
                {p.providerId === value && (
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
  initialProviderId,
  onClose,
  onDone
}: {
  providers: ProviderOption[]
  userId: string
  initialProviderId?: string
  onClose: () => void
  onDone?: () => void
}) {
  const [providerId, setProviderId] = useState(initialProviderId ?? providers[0]?.providerId ?? '')
  const [status, setStatus] = useState<'idle' | 'logging' | 'login-ok' | 'login-fail' | 'apikey-ok'>('idle')
  const [apiKey, setApiKey] = useState('')
  const [accountName, setAccountName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [cookieCount, setCookieCount] = useState(0)
  const [saving, setSaving] = useState(false)

  const selected = providers.find((p) => p.providerId === providerId)
  const isApiKey = selected?.authType === 'apikey'
  const loginOk = status === 'login-ok'

  const reset = () => {
    setStatus('idle')
    setError(null)
    setCookieCount(0)
    setApiKey('')
  }

  const saveEncrypted = async (encrypted: string, authType: 'cookie' | 'apikey', expiresAt: number | null) => {
    setSaving(true)
    setError(null)
    try {
      const svc = getProviderService()
      if (!svc) throw new Error('数据库服务未配置')

      // 备注为空时兜底自动命名：<厂商名> 账号 N（按该厂商第 N 个绑定递增）
      const existingKeys = await svc.listProviderKeys(userId)
      const sameProvider = existingKeys.filter((k) => k.provider_id === providerId)
      const seq = sameProvider.length + 1
      const name = accountName.trim() || `${selected?.name ?? providerId} 账号 ${seq}`

      const saved = await svc.addProviderKey({
        providerId,
        ownerUserId: userId,
        encryptedKey: encrypted,
        accountName: name,
        authType,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null
      })

      // 绑定即初始化今日额度行（当天已有则跳过）
      if (saved) {
        const meta = await svc.listProviders()
        const p = meta.find((m) => m.id === providerId)
        await svc.getOrInitLedger({
          userId,
          providerId,
          unitName: p?.unit_name ?? '',
          dailyTotal: Number(p?.default_daily_quota ?? 0)
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

  const handleLoginClick = async () => {
    if (!selected) return
    setError(null)
    if (isApiKey) {
      if (!apiKey.trim()) {
        setError('请输入 API Key')
        return
      }
      setStatus('logging')
      const enc = await window.api.providers.encrypt(apiKey.trim())
      if (!enc.encrypted) {
        setStatus('idle')
        setError('加密失败')
        return
      }
      const saved = await saveEncrypted(enc.encrypted, 'apikey', null)
      if (saved) setStatus('apikey-ok')
      return
    }
    setStatus('logging')
    const res = await window.api.providers.login(selected.providerId)
    if (res.ok && res.encrypted) {
      setCookieCount(res.cookieCount ?? 0)
      const saved = await saveEncrypted(res.encrypted, 'cookie', res.expiresAt ?? null)
      if (saved) setStatus('login-ok')
    } else if (res.canceled) {
      setStatus('idle')
      if (res.error) setError(res.error)
    } else {
      setStatus('login-fail')
      setError(res.error ?? '登录失败，请重试')
    }
  }

  const handleFinish = () => {
    onClose()
    onDone?.()
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
            onClick={handleFinish}
            disabled={saving || (!loginOk && status !== 'apikey-ok')}
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
      </div>
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