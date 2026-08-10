import { useRef, useState } from 'react'
import type { FormEvent } from 'react'
import TitleBar from '../components/TitleBar'
import { BrandMark } from '../components/Brand'

interface AuthScreenProps {
  error: string | null
  notice: string | null
  submitting: boolean
  onSignIn: (email: string, password: string) => Promise<void>
  onSignUp: (email: string, token: string, password: string, displayName: string) => Promise<void>
  onSendOtp: (email: string) => Promise<void>
  onVerifyOtp: (email: string, token: string) => Promise<void>
  onResendOtp: (email: string) => Promise<void>
}

type AuthTab = 'login' | 'register'
type LoginMode = 'password' | 'otp'

export default function AuthScreen({
  error,
  notice,
  submitting,
  onSignIn,
  onSignUp,
  onSendOtp,
  onVerifyOtp,
  onResendOtp
}: AuthScreenProps) {
  const [tab, setTab] = useState<AuthTab>('login')
  const [loginMode, setLoginMode] = useState<LoginMode>('password')

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [token, setToken] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [countdown, setCountdown] = useState(0)
  const [otpSent, setOtpSent] = useState(false)
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(-1)
  const suggestionsTimerRef = useRef<number | null>(null)

  const emailDomains = ['qq.com', '163.com', '126.com', 'gmail.com', 'outlook.com', 'foxmail.com', 'icloud.com', 'yeah.net']

  function openSuggestions(): void {
    if (suggestionsTimerRef.current !== null) {
      clearTimeout(suggestionsTimerRef.current)
      suggestionsTimerRef.current = null
    }
    setShowSuggestions(true)
  }

  function closeSuggestionsLater(): void {
    if (suggestionsTimerRef.current !== null) {
      clearTimeout(suggestionsTimerRef.current)
    }
    suggestionsTimerRef.current = window.setTimeout(() => {
      suggestionsTimerRef.current = null
      setShowSuggestions(false)
    }, 150)
  }

  function closeSuggestions(): void {
    if (suggestionsTimerRef.current !== null) {
      clearTimeout(suggestionsTimerRef.current)
      suggestionsTimerRef.current = null
    }
    setShowSuggestions(false)
    setSelectedIndex(-1)
  }

  function onEmailChange(v: string): void {
    setEmail(v)
    setSelectedIndex(-1)
    openSuggestions()
  }

  function getEmailSuggestions(input: string): string[] {
    const atIndex = input.indexOf('@')
    if (atIndex === -1) return []
    const prefix = input.slice(0, atIndex)
    const typedDomain = input.slice(atIndex + 1).toLowerCase()
    if (!prefix) return []
    return emailDomains
      .filter(d => d.startsWith(typedDomain) && d !== typedDomain)
      .map(d => `${prefix}@${d}`)
  }

  const emailSuggestions = getEmailSuggestions(email)

  function handleEmailKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (!showSuggestions || emailSuggestions.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex(prev => prev < emailSuggestions.length - 1 ? prev + 1 : 0)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex(prev => prev > 0 ? prev - 1 : emailSuggestions.length - 1)
    } else if (e.key === 'Enter' && selectedIndex >= 0) {
      e.preventDefault()
      setEmail(emailSuggestions[selectedIndex])
      setShowSuggestions(false)
      setSelectedIndex(-1)
    } else if (e.key === 'Escape') {
      setShowSuggestions(false)
      setSelectedIndex(-1)
    }
  }

  function startCountdown(): void {
    setCountdown(60)
    const timer = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(timer)
          return 0
        }
        return prev - 1
      })
    }, 1000)
  }

  function switchTab(next: AuthTab): void {
    setTab(next)
    setLoginMode('password')
    setToken('')
    setPassword('')
    setDisplayName('')
    setOtpSent(false)
    closeSuggestions()
  }

  async function handlePasswordLogin(e: FormEvent): Promise<void> {
    e.preventDefault()
    await onSignIn(email, password)
  }

  async function handleSendOtpForRegister(e: FormEvent): Promise<void> {
    e.preventDefault()
    startCountdown()
    await onSendOtp(email)
    setOtpSent(true)
  }

  async function handleRegister(e: FormEvent): Promise<void> {
    e.preventDefault()
    await onSignUp(email, token, password, displayName)
    setTab('login')
    setLoginMode('password')
    setToken('')
    setPassword('')
    setDisplayName('')
    setEmail('')
    setOtpSent(false)
    closeSuggestions()
  }

  async function handleOtpSend(e: FormEvent): Promise<void> {
    e.preventDefault()
    startCountdown()
    await onSendOtp(email)
  }

  async function handleOtpVerify(e: FormEvent): Promise<void> {
    e.preventDefault()
    await onVerifyOtp(email, token)
  }

  async function handleResend(): Promise<void> {
    startCountdown()
    await onResendOtp(email)
  }

  const isValidEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)

  return (
    <div className="auth-shell">
      <TitleBar />
      <div className="auth-wrap">
        <div className="auth-card">
          <div className="auth-header">
            <BrandMark size={32} className="brand-icon" />
            <h1 className="auth-title">
              {tab === 'login' ? '登录 Quota-Flow' : '注册 Quota-Flow'}
            </h1>
            <p className="auth-subtitle">
              {tab === 'login'
                ? '输入邮箱与密码，开启智能调度之旅'
                : '创建账号，开启智能调度之旅'}
            </p>
          </div>

          {tab === 'login' && (
            <div className="auth-tabs-bar">
              <button
                type="button"
                className={'auth-tab' + (loginMode === 'password' ? ' active' : '')}
                onClick={() => { setLoginMode('password'); setToken(''); closeSuggestions() }}
              >
                密码登录
              </button>
              <button
                type="button"
                className={'auth-tab' + (loginMode === 'otp' ? ' active' : '')}
                onClick={() => { setLoginMode('otp'); setToken(''); closeSuggestions() }}
              >
                验证码登录
              </button>
            </div>
          )}

          {error && <div className="auth-msg auth-msg-error">{error}</div>}
          {notice && <div className="auth-msg">{notice}</div>}

          {/* ===== 登录 · 密码 ===== */}
          {tab === 'login' && loginMode === 'password' && (
            <form className="auth-form" onSubmit={(e) => void handlePasswordLogin(e)}>
              <label className="auth-field">
                <span>邮箱</span>
                <div className="auth-input-wrap auth-email-wrap">
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => onEmailChange(e.target.value)}
                    onFocus={openSuggestions}
                    onBlur={closeSuggestionsLater}
                    onKeyDown={handleEmailKeyDown}
                    placeholder="请输入邮箱地址"
                    required
                    autoFocus
                    autoComplete="email"
                  />
                  {showSuggestions && emailSuggestions.length > 0 && (
                    <div className="auth-email-suggestions">
                      {emailSuggestions.map((s, i) => (
                        <div
                          key={s}
                          className={'auth-email-suggestion' + (i === selectedIndex ? ' selected' : '')}
                          onMouseEnter={() => setSelectedIndex(i)}
                          onMouseDown={() => { setEmail(s); closeSuggestions() }}
                        >
                          {s}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </label>
              <label className="auth-field">
                <span>密码</span>
                <div className="auth-input-wrap">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="请输入密码"
                    required
                    autoComplete="current-password"
                  />
                  <button
                    type="button"
                    className="auth-eye"
                    onClick={() => setShowPassword(!showPassword)}
                    tabIndex={-1}
                  >
                    {showPassword ? '🙈' : '👁'}
                  </button>
                </div>
              </label>
              <button className="auth-btn" type="submit" disabled={submitting}>
                {submitting ? '处理中…' : '登 录'}
              </button>
            </form>
          )}

          {/* ===== 登录 · 验证码 ===== */}
          {tab === 'login' && loginMode === 'otp' && (
            <form className="auth-form" onSubmit={(e) => void (token ? handleOtpVerify(e) : handleOtpSend(e))}>
              <label className="auth-field">
                <span>邮箱</span>
                <div className="auth-input-wrap auth-email-wrap">
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => onEmailChange(e.target.value)}
                    onFocus={openSuggestions}
                    onBlur={closeSuggestionsLater}
                    onKeyDown={handleEmailKeyDown}
                    placeholder="请输入邮箱地址"
                    required
                    autoFocus
                    autoComplete="email"
                  />
                  {showSuggestions && emailSuggestions.length > 0 && (
                    <div className="auth-email-suggestions">
                      {emailSuggestions.map((s, i) => (
                        <div
                          key={s}
                          className={'auth-email-suggestion' + (i === selectedIndex ? ' selected' : '')}
                          onMouseEnter={() => setSelectedIndex(i)}
                          onMouseDown={() => { setEmail(s); closeSuggestions() }}
                        >
                          {s}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </label>
              <label className="auth-field">
                <span>验证码</span>
                <div className="auth-input-wrap auth-input-row">
                  <input
                    type="text"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    placeholder="请输入验证码"
                    autoComplete="one-time-code"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    maxLength={8}
                  />
                  <button
                    type="button"
                    className="auth-send-btn"
                    disabled={countdown > 0 || !isValidEmail}
                    onClick={() => void handleOtpSend({ preventDefault: () => {} } as FormEvent)}
                  >
                    {countdown > 0 ? `${countdown}s` : '发送验证码'}
                  </button>
                </div>
              </label>
              <button className="auth-btn" type="submit" disabled={submitting}>
                {submitting ? '处理中…' : token ? '验证并登录' : '登 录'}
              </button>
            </form>
          )}

          {/* ===== 注册 ===== */}
          {tab === 'register' && (
            <form className="auth-form" onSubmit={(e) => void handleRegister(e)}>
              <label className="auth-field">
                <span>用户名</span>
                <div className="auth-input-wrap">
                  <input
                    type="text"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder="请输入用户名"
                    required
                    autoFocus
                    autoComplete="name"
                  />
                </div>
              </label>
              <label className="auth-field">
                <span>邮箱</span>
                <div className="auth-input-wrap auth-email-wrap">
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => { setEmail(e.target.value); setSelectedIndex(-1) }}
                    onFocus={() => setShowSuggestions(true)}
                    onBlur={() => setTimeout(() => setShowSuggestions(false), 200)}
                    onKeyDown={handleEmailKeyDown}
                    placeholder="请输入邮箱地址"
                    required
                    autoComplete="email"
                  />
                  {showSuggestions && emailSuggestions.length > 0 && (
                    <div className="auth-email-suggestions">
                      {emailSuggestions.map((s, i) => (
                        <div
                          key={s}
                          className={'auth-email-suggestion' + (i === selectedIndex ? ' selected' : '')}
                          onMouseEnter={() => setSelectedIndex(i)}
                          onMouseDown={() => { setEmail(s); closeSuggestions() }}
                        >
                          {s}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </label>
              <label className="auth-field">
                <span>验证码</span>
                <div className="auth-input-wrap auth-input-row">
                  <input
                    type="text"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    placeholder="请输入验证码"
                    autoComplete="one-time-code"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    maxLength={8}
                  />
                  <button
                    type="button"
                    className="auth-send-btn"
                    disabled={countdown > 0 || !isValidEmail}
                    onClick={() => void handleSendOtpForRegister({ preventDefault: () => {} } as FormEvent)}
                  >
                    {countdown > 0 ? `${countdown}s` : '发送验证码'}
                  </button>
                </div>
              </label>
              <label className="auth-field">
                <span>密码</span>
                <div className="auth-input-wrap">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="请输入密码"
                    required
                    autoComplete="new-password"
                  />
                  <button
                    type="button"
                    className="auth-eye"
                    onClick={() => setShowPassword(!showPassword)}
                    tabIndex={-1}
                  >
                    {showPassword ? '🙈' : '👁'}
                  </button>
                </div>
              </label>
              <button className="auth-btn" type="submit" disabled={submitting || !otpSent || token.length < 8}>
                {submitting ? '处理中…' : '注 册'}
              </button>
            </form>
          )}

          <div className="auth-footer">
            {tab === 'login' ? (
              <>
                还没有账号？
                <button type="button" className="auth-footer-link" onClick={() => switchTab('register')}>
                  立即注册
                </button>
              </>
            ) : (
              <>
                已有账号？
                <button type="button" className="auth-footer-link" onClick={() => switchTab('login')}>
                  立即登录
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
