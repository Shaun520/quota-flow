import { getAuthService, toTokens } from './service'
import { errMsg } from '../utils/error'

/** 续期提前量：access token 到期前 2 分钟就算“需要续期” */
const REFRESH_LEAD_SEC = 120

let refreshLock: Promise<{ ok: boolean; refreshed: boolean }> | null = null

export interface SessionGuardResult {
  ok: boolean
  /** 本次是否真正执行了续期（用于“续期后重试一次”，避免无限重试） */
  refreshed: boolean
}

const expiredListeners = new Set<() => void>()

/** 登录态确认失效（刷新失败）时通知 useAuth 清理界面状态 */
export function onSessionExpired(cb: () => void): () => void {
  expiredListeners.add(cb)
  return () => {
    expiredListeners.delete(cb)
  }
}

function notifySessionExpired(): void {
  for (const cb of [...expiredListeners]) {
    try {
      cb()
    } catch {}
  }
}

/**
 * 确保当前会话未过期：
 * - 会话仍有效 → 直接返回 ok
 * - 即将/已经过期 → 用 refresh token 续期并持久化新 token
 * - 续期失败 → 清空本地登录态、通知 useAuth，返回 ok=false
 */
export async function ensureFreshSession(): Promise<SessionGuardResult> {
  const auth = getAuthService()
  if (!auth) return { ok: false, refreshed: false }
  if (refreshLock) return refreshLock
  refreshLock = (async () => {
    try {
      const session = await auth.getSession()
      if (!session) {
        await window.api.auth.clearSession()
        notifySessionExpired()
        return { ok: false, refreshed: false }
      }
      const now = Math.floor(Date.now() / 1000)
      const expiresAt = session.expires_at ?? 0
      if (expiresAt - now > REFRESH_LEAD_SEC) {
        return { ok: true, refreshed: false }
      }
      const refreshed = await auth.refreshSession()
      if (refreshed) {
        await window.api.auth.setSession(toTokens(refreshed))
        return { ok: true, refreshed: true }
      }
      await window.api.auth.clearSession()
      notifySessionExpired()
      return { ok: false, refreshed: false }
    } catch {
      return { ok: false, refreshed: false }
    } finally {
      refreshLock = null
    }
  })()
  return refreshLock
}

/** 判断查询错误是否与登录态相关（JWT 过期/无效等），用于触发自动续期重试 */
export function isAuthError(e: unknown): boolean {
  const msg = errMsg(e)
  if (!msg) return false
  return (
    /\b(jwt|token|session|auth|unauthorized|invalid api key)\b/i.test(msg) ||
    /\b(401|403)\b/.test(msg) ||
    /expired/i.test(msg)
  )
}
