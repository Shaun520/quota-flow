import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ComponentType, MutableRefObject } from 'react'
import Dashboard from './components/Dashboard'
import Providers from './components/Providers'
import History from './components/History'
import Team from './components/Team'
import TitleBar from './components/TitleBar'
import WelcomeBanner from './components/WelcomeBanner'
import { NotificationBell } from './components/NotificationBell'
import { BrandMark } from './components/Brand'
import AuthScreen from './auth/AuthScreen'
import { useAuth } from './hooks/useAuth'
import type { AuthUser } from './hooks/useAuth'
import { useProviders } from './hooks/useProviders'
import { useJobs } from './hooks/useJobs'
import type { TeamContext, UsageScope, ViewScope } from '@quota-flow/db-supabase'
import {
  Modal,
  ProfileModal,
  SettingsModal,
  getInitialTheme,
  applyTheme,
  getInitialFontSize,
  applyFontSize
} from './components/Modals'
import { getSupabaseConfig, getAuthService } from './auth/service'
import {
  IconClock,
  IconChevron,
  IconGear,
  IconGrid,
  IconLogout,
  IconMonitor,
  IconUser,
  IconUsers
} from './components/icons'
import desktopPackage from '../../../package.json'

type TabId = 'dispatch' | 'providers' | 'history' | 'team'

function readStoredViewScope(hasTeam: boolean): ViewScope {
  const stored = localStorage.getItem('qf-view-scope')
  if (hasTeam && (stored === 'team' || stored === 'global')) return stored
  return hasTeam ? 'global' : 'personal'
}

function readStoredUsageScope(): UsageScope {
  return localStorage.getItem('qf-usage-scope') === 'team' ? 'team' : 'personal'
}

interface TabDef {
  id: TabId
  label: string
  icon: ComponentType<{ size?: number }>
}

interface UpdaterStatusView {
  state: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'not-available' | 'error'
  version?: string
  progress?: number
  error?: string
}

function welcomeDismissedKey(userId: string): string {
  return `qf:welcome-dismissed:${userId}`
}

function readWelcomeDismissed(userId: string): boolean {
  try {
    return localStorage.getItem(welcomeDismissedKey(userId)) === '1'
  } catch {
    return false
  }
}

function writeWelcomeDismissed(userId: string, dismissed: boolean): void {
  try {
    const key = welcomeDismissedKey(userId)
    if (dismissed) localStorage.setItem(key, '1')
    else localStorage.removeItem(key)
  } catch {
    // 本地存储不可用时保持当前会话行为
  }
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
  updater: UpdaterStatusView
  onOpenModal: (m: 'profile' | 'settings') => void
  onSignOut: () => Promise<void>
  onRefreshTeam: () => Promise<void>
}

function MainApp({
  user,
  team,
  updater,
  onOpenModal,
  onSignOut,
  onRefreshTeam
}: MainAppProps) {
  const [viewScope, setViewScope] = useState<ViewScope>(() => readStoredViewScope(!!team))
  const [usageScope, setUsageScope] = useState<UsageScope>(readStoredUsageScope)
  // 厂商 / 任务数据提升到 MainApp 层：随 user 挂载/卸载，账号切换时整棵数据树重建，避免残留上一账号数据
  const providers = useProviders(viewScope)
  const jobs = useJobs()
  const [bannerDismissed, setBannerDismissed] = useState(() => readWelcomeDismissed(user.id))
  const onboardStep = useMemo<1 | 2 | 3>(() => {
    if (jobs.items.some((j) => j.record.status === '成功')) return 3
    if (providers.totalBound > 0) return 2
    return 1
  }, [jobs.items, providers.totalBound])
  const fresh = onboardStep < 3
  const onboardingReady = !providers.loading && !jobs.loading
  const bannerVisible = onboardingReady && fresh && !bannerDismissed

  useEffect(() => {
    if (onboardStep === 3 && !bannerDismissed) {
      setBannerDismissed(true)
      writeWelcomeDismissed(user.id, true)
    }
  }, [onboardStep, bannerDismissed, user.id])

  const hideBanner = useCallback(() => {
    setBannerDismissed(true)
    writeWelcomeDismissed(user.id, true)
  }, [user.id])
  const finishOnboarding = useCallback(() => {
    setBannerDismissed(true)
    writeWelcomeDismissed(user.id, true)
  }, [user.id])
  const [tab, setTab] = useState<TabId>(() => {
    const hit = location.hash.match(/#tab=(.+)/)
    const t = hit ? hit[1] : 'dispatch'
    return (['dispatch', 'providers', 'history', 'team'] as TabId[]).includes(t as TabId)
      ? (t as TabId)
      : 'dispatch'
  })
  const providersTabActiveRef = useRef(tab === 'providers')
  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<number | undefined>(undefined)
  const [scopeOpen, setScopeOpen] = useState(false)
  const scopeWrapRef = useRef<HTMLDivElement | null>(null)
  const [renewText, setRenewText] = useState('自动续命：—')
  const [updatePromptVisible, setUpdatePromptVisible] = useState(false)

  useEffect(() => {
    const wasActive = providersTabActiveRef.current
    providersTabActiveRef.current = tab === 'providers'
    if (!wasActive && tab === 'providers') providers.reload()
  }, [tab, providers.reload])

  const scopeLabel = useMemo(() => {
    if (viewScope === 'team') return '团队模式'
    if (viewScope === 'global') return '全局模式'
    return '个人模式'
  }, [viewScope])

  const showToast = useCallback((msg: string) => {
    setToast(msg)
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 2200)
  }, [])

  const switchViewScope = useCallback((scope: ViewScope) => {
    if (scope === 'team' && !team) {
      showToast('请先加入团队')
      return
    }
    setViewScope(scope)
    localStorage.setItem('qf-view-scope', scope)
    if (scope === 'personal') {
      setUsageScope('personal')
      localStorage.setItem('qf-usage-scope', 'personal')
    } else if (scope === 'team') {
      setUsageScope('team')
      localStorage.setItem('qf-usage-scope', 'team')
    }
  }, [team, showToast])

  const switchUsageScope = useCallback((scope: UsageScope) => {
    setUsageScope(scope)
    localStorage.setItem('qf-usage-scope', scope)
  }, [])

  useEffect(() => {
    if (!scopeOpen) return

    const onPointerDown = (event: MouseEvent) => {
      if (!scopeWrapRef.current?.contains(event.target as Node)) {
        setScopeOpen(false)
      }
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setScopeOpen(false)
    }

    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [scopeOpen])

  useEffect(() => {
    if (!team && (viewScope === 'team' || viewScope === 'global')) {
      switchViewScope('personal')
    }
  }, [team, viewScope, switchViewScope])

  useEffect(() => {
    applyTheme(getInitialTheme())
    applyFontSize(getInitialFontSize())
  }, [])

  useEffect(() => {
    if (updater.state !== 'available' || !updater.version) return
    const key = `qf:update-prompt:${updater.version}`
    try {
      if (localStorage.getItem(key)) return
      localStorage.setItem(key, '1')
    } catch {
      // 本地存储不可用时仍按弹一次处理
    }
    setUpdatePromptVisible(true)
  }, [updater.state, updater.version])

  // Cookie 自动续命：配置主进程调度器（携带最新会话 token）+ 轮询状态更新状态栏
  useEffect(() => {
    if (!user) return
    let cancelled = false
    const sync = async (): Promise<void> => {
      try {
        const cfg = getSupabaseConfig()
        const auth = getAuthService()
        if (!cfg || !auth) return
        const s = await auth.getSession()
        if (!s?.access_token) return
        await window.api.cookieRenew.configure({
          supabaseUrl: cfg.url,
          supabaseAnonKey: cfg.anonKey,
          accessToken: s.access_token,
          refreshToken: s.refresh_token,
          userId: user.id
        })
        const st = await window.api.cookieRenew.getState()
        if (cancelled) return
        if (!st.enabled) {
          setRenewText('自动续命：已关闭')
        } else if (st.running) {
          setRenewText('自动续命中…')
        } else if (st.nextRunAt) {
          const d = new Date(st.nextRunAt)
          const hh = String(d.getHours()).padStart(2, '0')
          const mi = String(d.getMinutes()).padStart(2, '0')
          setRenewText(`自动续命：${hh}:${mi}`)
        } else {
          setRenewText('自动续命：—')
        }
      } catch {
        // 主进程未就绪等下次轮询
      }
    }
    void sync()
    const timer = window.setInterval(() => void sync(), 60000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [user?.id])

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
          <div
            className={'scope-switcher' + (scopeOpen ? ' open' : '')}
            ref={scopeWrapRef}
            aria-label="账号显示模式"
          >
            <button
              className="scope-trigger"
              type="button"
              aria-haspopup="listbox"
              aria-expanded={scopeOpen}
              onClick={() => setScopeOpen((open) => !open)}
              title="点击切换账号显示模式"
            >
              <IconUsers size={12} />
              <span>{scopeLabel}</span>
              <IconChevron size={11} className="scope-chevron" />
            </button>
            <div className="scope-menu" role="listbox" aria-label="账号显示模式">
              <button
                className={'scope-option' + (viewScope === 'personal' ? ' active' : '')}
                type="button"
                role="option"
                aria-selected={viewScope === 'personal'}
                onClick={() => {
                  switchViewScope('personal')
                  setScopeOpen(false)
                }}
                title="只显示个人账号，使用个人额度"
              >
                <span>个人模式</span>
                {viewScope === 'personal' && <span className="scope-option-check">✓</span>}
              </button>
              <button
                className={'scope-option' + (viewScope === 'team' ? ' active' : '')}
                type="button"
                role="option"
                aria-selected={viewScope === 'team'}
                disabled={!team}
                onClick={() => {
                  switchViewScope('team')
                  setScopeOpen(false)
                }}
                title={team ? '只显示团队账号，使用团队额度' : '加入团队后可切换'}
              >
                <span>团队模式</span>
                {viewScope === 'team' && <span className="scope-option-check">✓</span>}
              </button>
              <button
                className={'scope-option' + (viewScope === 'global' ? ' active' : '')}
                type="button"
                role="option"
                aria-selected={viewScope === 'global'}
                disabled={!team}
                onClick={() => {
                  switchViewScope('global')
                  setScopeOpen(false)
                }}
                title={team ? '同时显示个人账号和团队账号，可在生成时选择额度' : '加入团队后可切换'}
              >
                <span>全局模式</span>
                {viewScope === 'global' && <span className="scope-option-check">✓</span>}
              </button>
            </div>
          </div>
          <NotificationBell userId={user.id} />
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
              onStep3Done={finishOnboarding}
              onDismiss={hideBanner}
            />
          )}
          {/* 各 tab 常驻挂载，仅用 display 切换：保留表单/筛选等本地状态，避免切 tab 丢失 */}
          <div className="tab-pane" style={{ display: tab === 'dispatch' ? 'flex' : 'none' }}>
            <Dashboard
              fresh={fresh}
              banner={bannerVisible}
              step={onboardStep}
              viewScope={viewScope}
              usageScope={usageScope}
              onUsageScopeChange={switchUsageScope}
              onGoHistory={() => setTab('history')}
              onGoProviders={() => setTab('providers')}
              providers={providers}
              jobs={jobs}
            />
          </div>
          <div className="tab-pane" style={{ display: tab === 'providers' ? 'flex' : 'none' }}>
            <Providers fresh={fresh} viewScope={viewScope} usageScope={usageScope} providers={providers} />
          </div>
          <div className="tab-pane" style={{ display: tab === 'history' ? 'flex' : 'none' }}>
            <History jobs={jobs} />
          </div>
          <div className="tab-pane" style={{ display: tab === 'team' ? 'flex' : 'none' }}>
            <Team
              active={tab === 'team'}
              fresh={fresh}
              userId={user.id}
              team={team}
              onTeamChanged={onRefreshTeam}
            />
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
          <div className="status-item">{renewText}</div>
        </div>
        <div className="status-right">
          {updater.state === 'downloaded' ? (
            <div className="status-item updater-item">
              <span>新版本已下载</span>
              <button className="updater-action" onClick={() => void window.api.updater.quitAndInstall()}>
                重启安装
              </button>
            </div>
          ) : updater.state === 'available' ? (
            <div className="status-item updater-item">
              <span>发现新版本 {updater.version}</span>
              <button className="updater-action" onClick={() => void window.api.updater.download()}>
                下载
              </button>
            </div>
          ) : updater.state === 'downloading' ? (
            <div className="status-item">下载更新 {Math.round(updater.progress ?? 0)}%</div>
          ) : updater.state === 'checking' ? (
            <div className="status-item">检查更新...</div>
          ) : updater.state === 'error' ? (
            <div className="status-item" title={updater.error ?? ''}>
              更新检查失败
            </div>
          ) : null}
          <div className="status-item">Quota-Flow v{desktopPackage.version}</div>
        </div>
      </footer>
      {toast && <div className="app-toast">{toast}</div>}
      {updatePromptVisible && updater.state === 'available' && (
        <Modal
          title="发现新版本"
          onClose={() => setUpdatePromptVisible(false)}
          footer={
            <>
              <button className="btn-sm" onClick={() => setUpdatePromptVisible(false)}>
                稍后
              </button>
              <button
                className="btn-sm primary"
                onClick={() => {
                  setUpdatePromptVisible(false)
                  void window.api.updater.download()
                }}
              >
                下载更新
              </button>
            </>
          }
        >
          <div className="updater-prompt">
            <p>当前版本为 Quota-Flow v{desktopPackage.version}，发现新版本 v{updater.version}。</p>
            <p>点击“下载更新”后会后台下载安装包，下载完成后可在状态栏或设置中重启安装。</p>
          </div>
        </Modal>
      )}
    </div>
  )
}

type ModalKind = 'profile' | 'settings'

interface AppModalsProps {
  modalApiRef: MutableRefObject<{ open: (m: ModalKind) => void } | null>
  user: AuthUser
  team: TeamContext | null
  updater: UpdaterStatusView
  onUpdateProfile: (name: string) => Promise<string | null>
}

/** 个人中心 / 设置弹窗：弹窗状态独立于此组件内部，开合不再触发 MainApp 及四个 Tab 树重渲染 */
function AppModals({ modalApiRef, user, team, updater, onUpdateProfile }: AppModalsProps) {
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
      {modal === 'settings' && <SettingsModal onClose={() => setModal(null)} updater={updater} />}
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
  const { configured, loading, user, team, error, notice, signIn, signUp, sendOtp, verifyOtp, signOut, forgotPassword, updateProfile, refreshTeam } =
    useAuth()
  const modalApiRef = useRef<{ open: (m: ModalKind) => void } | null>(null)
  const [updater, setUpdater] = useState<UpdaterStatusView>({ state: 'idle' })
  const openModal = useCallback((m: ModalKind) => {
    modalApiRef.current?.open(m)
  }, [])
  useEffect(() => {
    return window.api.updater.onStatus(setUpdater)
  }, [])
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

  return (
    <>
      <MainApp
        key={user.id}
        user={user}
        team={team}
        updater={updater}
        onOpenModal={openModal}
        onSignOut={signOut}
        onRefreshTeam={refreshTeam}
      />
      <AppModals
        modalApiRef={modalApiRef}
        user={user}
        team={team}
        updater={updater}
        onUpdateProfile={updateProfile}
      />
    </>
  )
}
