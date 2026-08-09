import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { IconChevron, IconClose, PROVIDER_ICONS } from './icons'
import { PROVIDERS } from '../data'

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

export function ProfileModal({ onClose }: { onClose: () => void }) {
  const fields = [
    { label: '邮箱', value: 'user@example.com', readonly: true },
    { label: '显示名称', value: 'Leo', readonly: false },
    { label: '所属团队', value: 'Quota-Flow Team', readonly: true },
    { label: '角色', value: '管理员', readonly: true },
    { label: '注册时间', value: '2026-07-15', readonly: true }
  ]
  return (
    <Modal
      title="个人中心"
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
      {fields.map((f) => (
        <div className="form-group" key={f.label}>
          <label>{f.label}</label>
          <input type="text" value={f.value} readOnly={f.readonly} />
        </div>
      ))}
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

function ProviderSelect({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const selected = PROVIDERS.find((p) => p.id === value)

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

  const SelectedIcon = selected ? PROVIDER_ICONS[selected.id] : undefined

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
          {PROVIDERS.map((p) => {
            const Icon = PROVIDER_ICONS[p.id]
            return (
              <button
                type="button"
                key={p.id}
                role="option"
                aria-selected={p.id === value}
                className={'provider-select-item' + (p.id === value ? ' active' : '')}
                onClick={() => {
                  onChange(p.id)
                  setOpen(false)
                }}
              >
                {Icon ? <Icon size={16} /> : null}
                <span>{p.name}</span>
                {p.id === value && (
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

export function AddProviderModal({ onClose }: { onClose: () => void }) {
  const [providerId, setProviderId] = useState(PROVIDERS[0]?.id ?? '')
  const [status, setStatus] = useState<'idle' | 'logging-in' | 'done'>('idle')

  const selected = PROVIDERS.find((p) => p.id === providerId)

  const handleLogin = () => {
    setStatus('logging-in')
    setTimeout(() => setStatus('done'), 2000)
  }

  return (
    <Modal
      title="新增厂商账号"
      onClose={onClose}
      footer={
        <>
          <button className="btn-sm" onClick={onClose}>
            取消
          </button>
          <button
            className="btn-sm primary"
            onClick={onClose}
            disabled={status !== 'done'}
          >
            完成
          </button>
        </>
      }
    >
      <div className="form-group">
        <label>选择厂商</label>
        <ProviderSelect
          value={providerId}
          onChange={(id) => {
            setProviderId(id)
            setStatus('idle')
          }}
        />
      </div>
      {selected && (
        <div className="form-group">
          <label>支持模型</label>
          <input type="text" value={selected.models.join(', ')} readOnly />
        </div>
      )}
      <div className="form-group" style={{ background: 'var(--bg-elevated)', padding: '16px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-light)' }}>
        <p style={{ margin: '0 0 12px', fontSize: '13px', color: 'var(--fg-secondary)' }}>
          点击下方按钮，将在浏览器中打开 {selected?.name ?? '厂商'} 登录页面。登录成功后，系统将自动获取账号信息。
        </p>
        {status === 'idle' && (
          <button className="btn-sm primary" onClick={handleLogin}>
            前往 {selected?.name ?? '厂商'} 登录
          </button>
        )}
        {status === 'logging-in' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--fg-muted)' }}>
            <span className="spinner" style={{ width: 14, height: 14, border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
            等待登录完成...
          </div>
        )}
        {status === 'done' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#4ade80' }}>
            ✓ 账号已获取，登录成功
          </div>
        )}
      </div>
    </Modal>
  )
}
