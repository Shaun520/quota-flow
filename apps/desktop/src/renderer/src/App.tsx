import { useEffect, useState } from 'react'
import type { ComponentType } from 'react'
import Dashboard from './components/Dashboard'
import Providers from './components/Providers'
import History from './components/History'
import Team from './components/Team'
import TitleBar from './components/TitleBar'
import { BrandMark } from './components/Brand'
import AuthScreen from './auth/AuthScreen'
import { useAuth } from './hooks/useAuth'
import type { AuthUser } from './hooks/useAuth'
import type { TeamContext } from '@quota-flow/db-supabase'
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

interface MainAppProps {
  user: AuthUser
  team: TeamContext | null
  onSignOut: () => Promise<void>
}

function MainApp({ user, team, onSignOut }: MainAppProps) {
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
            {team ? '团队 · ' + team.id.slice(0, 8) : '个人模式'}
          </div>
          <div className="avatar-wrap">
            <div className="avatar">{user.displayName.slice(0, 1).toUpperCase()}</div>
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
              <button
                className="dropdown-item"
                style={{ color: 'var(--error)' }}
                onClick={() => void onSignOut()}
              >
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

function SplashScreen() {
  return (
    <div className="auth-shell">
      <TitleBar />
      <div className="auth-wrap">
        <div className="auth-card" style={{ alignItems: 'center', gap: 12, padding: '40px 48px' }}>
          <BrandMark size={30} className="brand-icon" />
          <span style={{ color: 'var(--fg-muted)' }}>正在恢复会话…</span>
        </div>
      </div>
    </div>
  )
}

function ConfigWarning() {
  return (
    <div className="auth-shell">
      <TitleBar />
      <div className="auth-wrap">
        <div className="auth-card" style={{ gap: 10, maxWidth: 420 }}>
          <div className="auth-title" style={{ fontSize: '1.2em' }}>
            未配置 Supabase
          </div>
          <p style={{ color: 'var(--fg-secondary)', margin: 0, lineHeight: 1.7 }}>
            请在 <code>apps/desktop/.env</code> 中设置{' '}
            <code>VITE_SUPABASE_URL</code> 与 <code>VITE_SUPABASE_ANON_KEY</code> 后重启应用。
          </p>
        </div>
      </div>
    </div>
  )
}

export default function App() {
  const { configured, loading, user, team, error, notice, signIn, signUp, sendOtp, verifyOtp, signOut, forgotPassword } =
    useAuth()
  const [submitting, setSubmitting] = useState(false)

  if (loading) return <SplashScreen />
  if (!configured) return <ConfigWarning />

  if (!user) {
    return (
      <AuthScreen
        error={error}
        notice={notice}
        submitting={submitting}
        onSignIn={async (email, password) => {
          setSubmitting(true)
          try {
            await signIn(email, password)
          } finally {
            setSubmitting(false)
          }
        }}
        onSignUp={async (email, token, password, displayName) => {
          setSubmitting(true)
          try {
            await signUp(email, token, password, displayName)
          } finally {
            setSubmitting(false)
          }
        }}
        onSendOtp={async (email) => {
          setSubmitting(true)
          try {
            await sendOtp(email)
          } finally {
            setSubmitting(false)
          }
        }}
        onVerifyOtp={async (email, token) => {
          setSubmitting(true)
          try {
            await verifyOtp(email, token)
          } finally {
            setSubmitting(false)
          }
        }}
        onResendOtp={async (email) => {
          setSubmitting(true)
          try {
            await sendOtp(email)
          } finally {
            setSubmitting(false)
          }
        }}
      />
    )
  }

  return <MainApp user={user} team={team} onSignOut={signOut} />
}