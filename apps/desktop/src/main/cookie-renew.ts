import { app, ipcMain } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createSupabaseClient, ProviderService } from '@quota-flow/db-supabase'
import { encryptCookies, providerSite, visitAndCapture } from './providers'

/** Cookie 自动续命：每日 03:00 全量访问厂商站点保活 + 临近过期的账号提前续命（详见 docs/develop/cookie-renew-design.md） */

const RENEW_HOUR = 3 // 每日续命时段（凌晨低活跃）
const RENEW_AHEAD_MS = 24 * 60 * 60 * 1000 // 距过期 24h 内的账号提前续命
const TICK_MS = 60 * 1000 // 调度检查周期
const MAX_CONSECUTIVE_FAILS = 3 // 同账号连续失败熔断，次日才恢复
const ACCOUNT_GAP_MS = 1000 // 多账号间错峰

export interface CookieRenewState {
  enabled: boolean
  running: boolean
  lastRunAt: number | null
  nextRunAt: number | null
  lastResult: { ok: boolean; renewed: number; failed: number; message?: string } | null
}

interface RenewConfig {
  supabaseUrl: string
  supabaseAnonKey: string
  accessToken: string
  refreshToken: string
  userId: string
}

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

let renewEnabled = true // 默认开启（对齐 README「凌晨 3 点自动续命」承诺）

function loadSettings(): void {
  try {
    const file = settingsPath()
    if (!existsSync(file)) return
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { cookieRenew?: unknown }
    if (typeof parsed.cookieRenew === 'boolean') renewEnabled = parsed.cookieRenew
  } catch {
    // 配置损坏按默认处理
  }
}

function saveSettings(): void {
  try {
    mkdirSync(app.getPath('userData'), { recursive: true })
    writeFileSync(settingsPath(), JSON.stringify({ cookieRenew: renewEnabled }), 'utf8')
  } catch {
    // 持久化失败不影响运行期行为
  }
}

let config: RenewConfig | null = null
let running = false
let lastRunAt: number | null = null
let lastResult: CookieRenewState['lastResult'] = null
let lastDailyKey = ''
const failCount = new Map<string, number>()
let timer: NodeJS.Timeout | null = null
let started = false

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function nextScheduledAt(now: Date): number {
  const next = new Date(now)
  next.setHours(RENEW_HOUR, 0, 0, 0)
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1)
  return next.getTime()
}

function buildState(): CookieRenewState {
  return {
    enabled: renewEnabled,
    running,
    lastRunAt,
    nextRunAt: renewEnabled && config ? nextScheduledAt(new Date()) : null,
    lastResult
  }
}

async function tick(): Promise<void> {
  if (!renewEnabled || running || !config) return

  const now = new Date()
  const dailyKey = now.toISOString().slice(0, 10)
  const dailyDue = now.getHours() === RENEW_HOUR && lastDailyKey !== dailyKey

  let providerSvc: ProviderService | null = null
  try {
    const client = createSupabaseClient({
      supabaseUrl: config.supabaseUrl,
      supabaseAnonKey: config.supabaseAnonKey
    })
    await client.auth.setSession({
      access_token: config.accessToken,
      refresh_token: config.refreshToken
    })
    providerSvc = new ProviderService(client)

    const keys = await providerSvc.listProviderKeys(config.userId)
    const candidates = keys.filter((k) => {
      if (k.auth_type === 'apikey') return false // 无 cookie 会话
      if (k.enabled === false) return false
      if ((failCount.get(k.id) ?? 0) >= MAX_CONSECUTIVE_FAILS) return false // 熔断
      if (k.health_status === 'expired') return false
      const expiresAt = k.cookie_expires_at ? new Date(k.cookie_expires_at).getTime() : null
      const soonDue = expiresAt !== null && expiresAt - now.getTime() < RENEW_AHEAD_MS
      return dailyDue || soonDue
    })
    if (candidates.length === 0) return

    running = true
    lastRunAt = now.getTime()
    let renewed = 0
    let failed = 0
    let expiredCount = 0
    for (const key of candidates) {
      const site = providerSite(key.provider_id)
      if (!site?.healthUrl) {
        failed += 1
        continue
      }
      try {
        const res = await visitAndCapture(key.provider_id, key.id, key.encrypted_key, site.healthUrl)
        if (res.ok && res.status === 'healthy' && res.cookies && res.cookies.length > 0) {
          await providerSvc.refreshProviderKey(config.userId, key.id, {
            encryptedKey: encryptCookies(res.cookies, res.storages ?? []),
            expiresAt: res.expiresAt ? new Date(res.expiresAt).toISOString() : null,
            healthStatus: 'healthy'
          })
          failCount.delete(key.id)
          renewed += 1
        } else if (res.status === 'expired') {
          await providerSvc.updateHealth(config.userId, key.id, 'expired')
          expiredCount += 1
        } else {
          failCount.set(key.id, (failCount.get(key.id) ?? 0) + 1)
          failed += 1
        }
      } catch {
        failCount.set(key.id, (failCount.get(key.id) ?? 0) + 1)
        failed += 1
      }
      await sleep(ACCOUNT_GAP_MS)
    }
    if (dailyDue) lastDailyKey = dailyKey
    lastResult = {
      ok: failed === 0 && expiredCount === 0,
      renewed,
      failed,
      message:
        expiredCount > 0
          ? `${expiredCount} 个账号会话已失效，请重新登录`
          : failed > 0
            ? `${failed} 个账号续命失败，已熔断待明日重试`
            : `已续命 ${renewed} 个账号`
    }
  } catch {
    // 会话过期 / 网络 / DB 异常：本轮放弃，等 renderer 重新 configure 携带新 token
  } finally {
    running = false
  }
}

export function initCookieRenew(): void {
  if (started) return
  started = true
  loadSettings()

  ipcMain.handle('cookie-renew:configure', (_e, cfg: unknown) => {
    const c = cfg as Partial<RenewConfig> | null
    if (
      !c ||
      typeof c.supabaseUrl !== 'string' ||
      typeof c.supabaseAnonKey !== 'string' ||
      typeof c.accessToken !== 'string' ||
      typeof c.refreshToken !== 'string' ||
      typeof c.userId !== 'string'
    ) {
      return { ok: false, error: 'invalid cookie-renew config' }
    }
    config = {
      supabaseUrl: c.supabaseUrl,
      supabaseAnonKey: c.supabaseAnonKey,
      accessToken: c.accessToken,
      refreshToken: c.refreshToken,
      userId: c.userId
    }
    return { ok: true }
  })

  ipcMain.handle('cookie-renew:set-enabled', (_e, enabled: unknown) => {
    renewEnabled = enabled === true
    saveSettings()
    return { ok: true, state: buildState() }
  })

  ipcMain.handle('cookie-renew:get-state', () => buildState())

  timer = setInterval(() => void tick(), TICK_MS)
  void tick()
}
