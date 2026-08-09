import { useEffect, useState } from 'react'
import type { ComponentType } from 'react'
import Dashboard from './components/Dashboard'
import Providers from './components/Providers'
import History from './components/History'
import Team from './components/Team'
import { BrandMark } from './components/Brand'
import { ProfileModal, SettingsModal, getInitialTheme, applyTheme, getInitialFontSize, applyFontSize } from './components/Modals'
import {
  IconClock,
  IconGear,
  IconGrid,
  IconLogout,
  IconMonitor,
  IconUser,
  IconUsers
} from './components/icons'

type TabId = 'dispatch' | 'providers' | 'history' | 'team'

interface TabDef {
  id: TabId
  label: string
  icon: ComponentType<{ size?: number }>
}

const TABS: TabDef[] = [
  { id: 'dispatch', label: '调度台', icon: IconGrid },
  { id: 'providers', label: '厂商', icon: IconMonitor },
  { id: 'history', label: '历史', icon: IconClock },
  { id: 'team', label: '团队', icon: IconUsers }
]

function TitleBar() {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    if (!window.api?.windowControls?.onMaximizeChange) return
    return window.api.windowControls.onMaximizeChange(setMaximized)
  }, [])

  return (
    <div className="title-bar">
      <div className="title-bar-text">Quota-Flow · Unified LLM Router</div>
      <div className="window-controls">
        <button
          title="最小化"
          aria-label="最小化"
          onClick={() => void window.api?.windowControls?.minimize?.()}
        >
          <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <rect x="1" y="5.5" width="10" height="1" fill="currentColor" />
          </svg>
        </button>
        <button
          title={maximized ? '还原' : '最大化'}
          aria-label={maximized ? '还原' : '最大化'}
          onClick={() => void window.api?.windowControls?.toggleMaximize?.()}
        >
          {maximized ? (
            <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <rect x="1.5" y="3.5" width="7" height="7" stroke="currentColor" />
              <path d="M3.5 3.5V1.5h7v7h-2" stroke="currentColor" />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <rect x="1.5" y="1.5" width="9" height="9" stroke="currentColor" />
            </svg>
          )}
        </button>
        <button
          className="btn-close"
          title="关闭"
          aria-label="关闭"
          onClick={() => void window.api?.windowControls?.close?.()}
        >
          <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M1 1l10 10M11 1L1 11" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </button>
      </div>
    </div>
  )
}

export default function App() {
  const [tab, setTab] = useState<TabId>(() => {
    const hit = location.hash.match(/#tab=(.+)/)
    const t = hit ? hit[1] : 'dispatch'
    return (['dispatch', 'providers', 'history', 'team'] as TabId[]).includes(t as TabId)
      ? (t as TabId)
      : 'dispatch'
  })
  const [modal, setModal] = useState<'profile' | 'settings' | null>(null)

  useEffect(() => {
    applyTheme(getInitialTheme())
    applyFontSize(getInitialFontSize())
  }, [])

  return (
    <div className="app-shell">
      <TitleBar />

      {/* 顶部导航：主 Tab + 用户区 */}
      <nav className="top-nav">
        <div className="brand">
          <BrandMark size={18} className="brand-icon" />
          <span>Quota-Flow</span>
        </div>
        {TABS.map((t) => {
          const Icon = t.icon
          return (
            <button
              key={t.id}
              className={'nav-tab' + (tab === t.id ? ' active' : '')}
              onClick={() => {
                setTab(t.id)
                location.hash = 'tab=' + t.id
              }}
            >
              <Icon size={15} />
              {t.label}
            </button>
          )
        })}

        <div className="user-area">
          <div className="team-badge">
            <IconUsers size={10} />
            团队免费 · 2/3
          </div>
          <div className="avatar-wrap">
            <div className="avatar">L</div>
            <div className="avatar-dropdown">
              <button className="dropdown-item" onClick={() => setModal('profile')}>
                <IconUser size={14} />
                个人中心
              </button>
              <button className="dropdown-item" onClick={() => setModal('settings')}>
                <IconGear size={14} />
                设置
              </button>
              <div className="dropdown-divider" />
              <button className="dropdown-item" style={{ color: 'var(--error)' }}>
                <IconLogout size={14} />
                退出登录
              </button>
            </div>
          </div>
        </div>
      </nav>

      {/* 主体内容 */}
      <main className="main-content">
        <div className="content-inner">
          {tab === 'dispatch' && (
            <Dashboard onGoHistory={() => setTab('history')} onGoProviders={() => setTab('providers')} />
          )}
          {tab === 'providers' && <Providers />}
          {tab === 'history' && <History />}
          {tab === 'team' && <Team />}
        </div>
      </main>

      {/* 底部状态栏 */}
      <footer className="status-bar">
        <div className="status-left">
          <div className="status-item">
            <span className="status-dot" />
            调度引擎正常
          </div>
          <div className="status-item">上次刷新：14:32</div>
          <div className="status-item">自动续命：03:00</div>
        </div>
        <div className="status-right">
          <div className="status-item">Quota-Flow v0.9.0</div>
        </div>
      </footer>

      {modal === 'profile' && <ProfileModal onClose={() => setModal(null)} />}
      {modal === 'settings' && <SettingsModal onClose={() => setModal(null)} />}
    </div>
  )
}
