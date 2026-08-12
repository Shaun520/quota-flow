import { useCallback, useEffect, useRef, useState } from 'react'
import type { ComponentType, MutableRefObject } from 'react'
import Dashboard from './components/Dashboard'
import Providers from './components/Providers'
import History from './components/History'
import Team from './components/Team'
import TitleBar from './components/TitleBar'
import WelcomeBanner from './components/WelcomeBanner'
import { BrandMark } from './components/Brand'
import AuthScreen from './auth/AuthScreen'
import { useAuth } from './hooks/useAuth'
import type { AuthUser } from './hooks/useAuth'
import { useProviders } from './hooks/useProviders'
import type { ProvidersResult } from './hooks/useProviders'
import { useJobs } from './hooks/useJobs'
import type { JobsResult } from './hooks/useJobs'
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
  fresh: boolean
  bannerVisible: boolean
  onboardStep: 1 | 2 | 3
  completeStep: (n: 1 | 2 | 3) => void
  onFinishOnboarding: () => void
  onDismissBanner: () => void
  providers: ProvidersResult
  jobs: JobsResult
  onOpenModal: (m: 'profile' | 'settings') => void
  onSignOut: () => Promise<void>
}

function MainApp({
  user,
  team,
  fresh,
  bannerVisible,
  onboardStep,
  completeStep,
  onFinishOnboarding,
  onDismissBanner,
  providers,
  jobs,
  onOpenModal,
  onSignOut
}: MainAppProps) {
  const [tab, setTab] = useState<TabId>(() => {
    const hit = location.hash.match(/#tab=(.+)/)
    const t = hit ? hit[1] : 'dispatch'
    return (['dispatch', 'providers', 'history'] as TabId[]).includes(t as TabId)
      ? (t as TabId)
      : 'dispatch'
  })
  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<number | undefined>(undefined)

  const showToast = useCallback((msg: string) => {
    setToast(msg)
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 2200)
  }, [])

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
                if (t.id === 'team') {
                  showToast('系统暂未实现')
                  return
                }
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
            {team ? '团队 · ' + team.id.slice(0, 8) : fresh ? '新用户 · 未绑定' : '个人模式'}
          </div>
          <div className="avatar-wrap">
            <div className="avatar">{user.displayName.slice(0, 1).toUpperCase()}</div>
            <div className="avatar-dropdown">
              <button className="dropdown-item" onClick={() => onOpenModal('profile')}>
                <IconUser size={14} />
                个人中心
              </button>
              <button className="dropdown-item" onClick={() => onOpenModal('settings')}>
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
          {bannerVisible && (
            <WelcomeBanner
              displayName={user.displayName}
              step={onboardStep}
              onGoProviders={() => setTab('providers')}
              onGoDashboard={() => setTab('dispatch')}
              onStep3Done={onFinishOnboarding}
              onDismiss={onDismissBanner}
            />
          )}
          {/* 各 tab 常驻挂载，仅用 display 切换：保留表单/筛选等本地状态，避免切 tab 丢失 */}
          <div className="tab-pane" style={{ display: tab === 'dispatch' ? 'flex' : 'none' }}>
            <Dashboard
              fresh={fresh}
              banner={bannerVisible}
              step={onboardStep}
              onGenerate={() => completeStep(2)}
              onGoHistory={() => setTab('history')}
              onGoProviders={() => setTab('providers')}
              providers={providers}
              jobs={jobs}
            />
          </div>
          <div className="tab-pane" style={{ display: tab === 'providers' ? 'flex' : 'none' }}>
            <Providers fresh={fresh} onBound={() => completeStep(1)} providers={providers} />
          </div>
          <div className="tab-pane" style={{ display: tab === 'history' ? 'flex' : 'none' }}>
            <History jobs={jobs} />
          </div>
          <div className="tab-pane" style={{ display: tab === 'team' ? 'flex' : 'none' }}>
            <Team fresh={fresh} />
          </div>
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
      {toast && <div className="app-toast">{toast}</div>}
    </div>
  )
}

type ModalKind = 'profile' | 'settings'

interface AppModalsProps {
  modalApiRef: MutableRefObject<{ open: (m: ModalKind) => void } | null>
  user: AuthUser
  team: TeamContext | null
  onUpdateProfile: (name: string) => Promise<string | null>
}

/** 个人中心 / 设置弹窗：弹窗状态独立于此组件内部，开合不再触发 MainApp 及四个 Tab 树重渲染 */
function AppModals({ modalApiRef, user, team, onUpdateProfile }: AppModalsProps) {
  const [modal, setModal] = useState<ModalKind | null>(null)

  useEffect(() => {
    modalApiRef.current = { open: setModal }
    return () => {
      modalApiRef.current = null
    }
  }, [modalApiRef])

  return (
    <>
      {modal === 'profile' && (
        <ProfileModal
          user={user}
          team={team}
          onClose={() => setModal(null)}
          onSaveDisplayName={onUpdateProfile}
        />
      )}
      {modal === 'settings' && <SettingsModal onClose={() => setModal(null)} />}
    </>
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
  const { configured, loading, user, team, error, notice, signIn, signUp, sendOtp, verifyOtp, signOut, forgotPassword, updateProfile } =
    useAuth()
  // 厂商 / 任务数据提升到 App 层单例：消除 Dashboard 与 Providers（useProviders）、Dashboard 与 History（useJobs）的重复请求与重复健康检查
  const providers = useProviders()
  const jobs = useJobs()
  const modalApiRef = useRef<{ open: (m: ModalKind) => void } | null>(null)
  const openModal = useCallback((m: ModalKind) => {
    modalApiRef.current?.open(m)
  }, [])
  const [submitting, setSubmitting] = useState(false)
  const [onboardStep, setOnboardStep] = useState<1 | 2 | 3>(() => {
    try {
      const v = Number(localStorage.getItem('quota-flow:onboard-step'))
      return (v === 1 || v === 2 || v === 3) ? v : 1
    } catch {
      return 1
    }
  })
  const fresh = onboardStep < 3
  // 关闭引导只对本次会话生效，重启后重新出现（直到完成全部引导）
  const [bannerDismissed, setBannerDismissed] = useState(false)
  const bannerVisible = fresh && !bannerDismissed

  const completeStep = useCallback((n: 1 | 2 | 3) => {
    setOnboardStep((prev) => {
      const next = n >= prev ? ((n + 1) as 1 | 2 | 3) : prev
      try {
        localStorage.setItem('quota-flow:onboard-step', String(next))
      } catch {
        // ignore
      }
      return next
    })
  }, [])

  const hideBanner = useCallback(() => {
    setBannerDismissed(true)
  }, [])

  const finishOnboarding = useCallback(() => {
    hideBanner()
    try {
      localStorage.setItem('quota-flow:onboard-step', '3')
    } catch {
      // ignore
    }
  }, [hideBanner])

  // Hiding the banner (dismiss/close) keeps real user data; only the layout
  // stays aligned with the demo mode. It does NOT switch to mock data.
  const dismissBanner = hideBanner

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

  return (
    <>
      <MainApp
        user={user}
        team={team}
        fresh={fresh}
        bannerVisible={bannerVisible}
        onboardStep={onboardStep}
        completeStep={completeStep}
        onFinishOnboarding={finishOnboarding}
        onDismissBanner={dismissBanner}
        providers={providers}
        jobs={jobs}
        onOpenModal={openModal}
        onSignOut={signOut}
      />
      <AppModals modalApiRef={modalApiRef} user={user} team={team} onUpdateProfile={updateProfile} />
    </>
  )
}
