import { useCallback, useEffect, useState } from 'react'
import { getAuthService, isAuthConfigured, toTokens } from '../auth/service'
import type { TeamContext } from '@quota-flow/db-supabase'

const ERROR_MAP: Record<string, string> = {
  'Invalid login credentials': '邮箱或密码错误',
  'Email not confirmed': '邮箱未验证，请先验证邮箱',
  'User already registered': '该邮箱已注册，请直接登录',
  'Password should be at least 6 characters': '密码至少需要 6 个字符',
  'Unable to validate email address: invalid format': '邮箱格式不正确',
  'Signup requires a valid password': '请输入有效的密码',
  'Email rate limit exceeded': '发送次数过多，请稍后再试',
  'Token has expired': '验证码已过期，请重新发送',
  'Invalid token': '验证码错误，请重新输入',
  'User not found': '用户不存在',
  'Invalid email or password': '邮箱或密码错误',
  'Email address is invalid': '邮箱地址无效',
  'Signup is disabled': '注册功能暂未开放',
  'Too many requests': '请求过于频繁，请稍后再试',
  'For security purposes, you can only request this once every 60 seconds': '发送过于频繁，请 60 秒后再试'
}

function translateError(msg: string): string {
  for (const [en, zh] of Object.entries(ERROR_MAP)) {
    if (msg.includes(en)) return zh
  }
  return msg
}

export interface AuthUser {
  id: string
  email: string
  displayName: string
  createdAt: string
}

interface RawUser {
  id: string
  email?: string | null
  created_at?: string | null
  user_metadata?: Record<string, unknown>
}

export interface AuthResult {
  configured: boolean
  loading: boolean
  user: AuthUser | null
  team: TeamContext | null
  error: string | null
  notice: string | null
  signIn: (email: string, password: string) => Promise<void>
  signUp: (email: string, token: string, password: string, displayName: string) => Promise<void>
  sendOtp: (email: string) => Promise<void>
  verifyOtp: (email: string, token: string) => Promise<void>
  signOut: () => Promise<void>
  forgotPassword: (email: string) => Promise<void>
  updateProfile: (displayName: string) => Promise<string | null>
}

function toAuthUser(raw: RawUser | null): AuthUser | null {
  if (!raw) return null
  const meta = raw.user_metadata ?? {}
  const displayName =
    typeof meta['display_name'] === 'string' ? meta['display_name'] : (raw.email ?? '用户')
  return {
    id: raw.id,
    email: raw.email ?? '',
    displayName,
    createdAt: typeof raw.created_at === 'string' ? raw.created_at : ''
  }
}

export function useAuth(): AuthResult {
  const [configured] = useState(() => isAuthConfigured())
  const [loading, setLoading] = useState(true)
  const [user, setUser] = useState<AuthUser | null>(null)
  const [team, setTeam] = useState<TeamContext | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function init(): Promise<void> {
      if (!isAuthConfigured()) {
        setLoading(false)
        return
      }
      const auth = getAuthService()
      if (!auth) {
        setLoading(false)
        return
      }
      try {
        const stored = await window.api.auth.getSession()
        if (stored) {
          await auth.restoreSession({
            accessToken: stored.accessToken,
            refreshToken: stored.refreshToken,
            expiresAt: stored.expiresAt
          })
          const session = await auth.getSession()
          if (session?.user) {
            const t = await auth.getTeam(session.user.id)
            if (!cancelled) {
              setUser(toAuthUser(session.user as RawUser))
              setTeam(t)
            }
          }
        }
      } catch {
        await window.api.auth.clearSession()
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void init()
    return () => {
      cancelled = true
    }
  }, [])

  const signUp = useCallback(async (email: string, token: string, password: string, displayName: string) => {
    setError(null)
    setNotice(null)
    const auth = getAuthService()
    if (!auth) {
      setError('未配置 Supabase，请检查 VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY')
      return
    }
    const verifyResult = await auth.verifyOtp(email, token)
    if (verifyResult.error) {
      setError(translateError(verifyResult.error))
      return
    }
    if (!verifyResult.session) {
      setError('验证失败：未返回会话')
      return
    }
    await window.api.auth.setSession(toTokens(verifyResult.session))
    const completeResult = await auth.completeSignUp(password, displayName)
    if (completeResult.error) {
      setError(translateError(completeResult.error))
      return
    }
    await window.api.auth.clearSession()
    setNotice('注册成功，请登录')
  }, [])

  const sendOtp = useCallback(async (email: string) => {
    setError(null)
    setNotice(null)
    const auth = getAuthService()
    if (!auth) {
      setError('未配置 Supabase，请检查 VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY')
      return
    }
    const result = await auth.sendOtp(email)
    if (result.error) {
      setError(translateError(result.error))
      return
    }
    setNotice('验证码已发送，请查收邮箱')
  }, [])

  const signIn = useCallback(async (email: string, password: string) => {
    setError(null)
    setNotice(null)
    const auth = getAuthService()
    if (!auth) {
      setError('未配置 Supabase，请检查 VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY')
      return
    }
    const result = await auth.signIn(email, password)
    if (result.error) {
      setError(translateError(result.error))
      return
    }
    if (!result.session) {
      setError('登录失败：未返回会话')
      return
    }
    await window.api.auth.setSession(toTokens(result.session))
    const t = await auth.getTeam(result.user?.id ?? '')
    setUser(toAuthUser(result.user as RawUser))
    setTeam(t)
  }, [])

  const verifyOtp = useCallback(async (email: string, token: string) => {
    setError(null)
    setNotice(null)
    const auth = getAuthService()
    if (!auth) {
      setError('未配置 Supabase，请检查 VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY')
      return
    }
    const result = await auth.verifyOtp(email, token)
    if (result.error) {
      setError(translateError(result.error))
      return
    }
    if (!result.session) {
      setError('验证失败：未返回会话')
      return
    }
    await window.api.auth.setSession(toTokens(result.session))
    const t = await auth.getTeam(result.user?.id ?? '')
    setUser(toAuthUser(result.user as RawUser))
    setTeam(t)
  }, [])

  const signOut = useCallback(async () => {
    const auth = getAuthService()
    if (auth) await auth.signOut()
    await window.api.auth.clearSession()
    setUser(null)
    setTeam(null)
    setError(null)
    setNotice(null)
  }, [])

  const forgotPassword = useCallback(async (email: string) => {
    setError(null)
    setNotice(null)
    const auth = getAuthService()
    if (!auth) {
      setError('未配置 Supabase，请检查 VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY')
      return
    }
    const err = await auth.resetPassword(email)
    if (err) setError(translateError(err))
    else setNotice('密码重置邮件已发送，请查收邮箱')
  }, [])

  const updateProfile = useCallback(async (displayName: string): Promise<string | null> => {
    setError(null)
    setNotice(null)
    const auth = getAuthService()
    if (!auth) return '未配置 Supabase，请检查 VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY'
    const result = await auth.updateProfile(displayName)
    if (result.error) return translateError(result.error)
    setUser((prev) => (prev ? { ...prev, displayName } : prev))
    return null
  }, [])

  return { configured, loading, user, team, error, notice, signIn, signUp, sendOtp, verifyOtp, signOut, forgotPassword, updateProfile }
}