import { createHash } from 'crypto'
import { app, BrowserWindow, ipcMain, safeStorage, session } from 'electron'
import type { Cookie } from 'electron'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

export type ProviderId =
  | 'doubao'
  | 'jimeng'
  | 'qwen'
  | 'yuanbao'
  | 'kling'
  | 'hailuo'
  | 'mathmind'

interface ProviderSite {
  loginUrl?: string
  healthUrl: string
  apiKeyOnly?: boolean
}

// API Key 型厂商（mathmind）不走登录窗口；其余 cookie 型厂商走网页登录
const PROVIDER_SITES: Record<ProviderId, ProviderSite> = {
  doubao: {
    loginUrl: 'https://www.doubao.com/chat/',
    healthUrl: 'https://www.doubao.com/chat/'
  },
  jimeng: {
    loginUrl: 'https://jimeng.jianying.com/ai-tool/video/generate',
    healthUrl: 'https://jimeng.jianying.com/'
  },
  qwen: {
    loginUrl: 'https://tongyi.aliyun.com/wanxiang/create',
    healthUrl: 'https://tongyi.aliyun.com/'
  },
  yuanbao: {
    loginUrl: 'https://yuanbao.tencent.com/chat/naQivTmsDa',
    healthUrl: 'https://yuanbao.tencent.com/'
  },
  kling: {
    loginUrl: 'https://klingai.com/global/',
    healthUrl: 'https://klingai.com/global/'
  },
  hailuo: {
    loginUrl: 'https://hailuoai.com/video',
    healthUrl: 'https://hailuoai.com/'
  },
  mathmind: {
    healthUrl: '',
    apiKeyOnly: true
  }
}

export interface ProviderCookie {
  name: string
  value: string
  domain: string
  path: string
  httpOnly: boolean
  secure: boolean
  expires: number
}

export interface ProviderLoginResult {
  ok: boolean
  canceled?: boolean
  encrypted?: string
  cookieCount?: number
  expiresAt?: number | null
  accountFingerprint?: string | null
  error?: string
}

const loginWindows = new Map<string, BrowserWindow>()

function partitionFor(providerId: string): string {
  return 'persist:qf-p:' + providerId
}

function encryptCookies(cookies: ProviderCookie[]): string {
  const plain = JSON.stringify(cookies)
  return safeStorage.encryptString(plain).toString('base64')
}

function exportCookies(cookies: Cookie[]): ProviderCookie[] {
  return cookies.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain ?? '',
    path: c.path ?? '',
    httpOnly: c.httpOnly ?? false,
    secure: c.secure ?? false,
    expires: typeof c.expirationDate === 'number' ? c.expirationDate * 1000 : 0
  }))
}

async function collectPartitionCookies(providerId: string): Promise<ProviderCookie[]> {
  const ses = session.fromPartition(partitionFor(providerId))
  const all = await ses.cookies.get({})
  return exportCookies(all)
}

async function injectCookies(
  providerId: string,
  cookies: ProviderCookie[]
): Promise<void> {
  const ses = session.fromPartition(partitionFor(providerId))
  for (const c of cookies) {
    try {
      await ses.cookies.set({
        url: `${c.secure ? 'https' : 'http'}://${c.domain.replace(/^\./, '')}${c.path || '/'}`,
        name: c.name,
        value: c.value,
        httpOnly: c.httpOnly,
        secure: c.secure,
        expirationDate: c.expires > 0 ? Math.floor(c.expires / 1000) : undefined
      })
    } catch {
      // 单条失败不阻塞其余注入
    }
  }
}

/* ============ P2 账号指纹去重（方案 A） ============
 * 登录完成后，在当前登录页面执行各厂商提取脚本，取账号标识（手机号/邮箱/uid 等），
 * 归一化后 sha256 作为指纹。指纹仅主进程计算并透传 renderer，明文标识不出主进程。
 */

interface FingerprintExtractor {
  pageUrl?: string
  script: string
  /** 已验证的 cookie 账号标识优先于 DOM 脚本（防止 DOM 先匹配到会话级不稳定值） */
  cookieFirst?: boolean
}

// 通用提取脚本：优先取常见 uid 属性，其次页面内手机号/邮箱
const COMMON_FINGERPRINT_SCRIPT = `(() => {
  try {
    const attrs = ['data-user-id', 'data-uid', 'data-userid', 'data-account', 'user-id', 'user_id', 'uid', 'userId', 'openid'];
    for (const a of attrs) {
      const el = document.querySelector('[' + a + ']');
      if (el && el.getAttribute(a)) return el.getAttribute(a);
    }
  } catch {} 
  try {
    const text = document.body ? document.body.innerText : '';
    const m = text.match(/1[3-9]\\d{9}/);
    if (m) return m[0];
    const e = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}/);
    if (e) return e[0];
  } catch {}
  return null;
})()`

// 每厂商一个提取脚本（结构差异化时单独实现；先用通用脚本兜底联调）
const ACCOUNT_FINGERPRINT_EXTRACTORS: Partial<Record<ProviderId, FingerprintExtractor>> = {
  // 实测豆包分区 cookie：uid_tt/uid_tt_ss = 字节用户 ID（稳定），sid_tt/sessionid 为会话令牌（会变）
  doubao: { script: COMMON_FINGERPRINT_SCRIPT, cookieFirst: true },
  jimeng: { script: COMMON_FINGERPRINT_SCRIPT },
  qwen: { script: COMMON_FINGERPRINT_SCRIPT },
  // 实测元宝分区 cookie：QQ 登录产生 pt2gguin(o+QQ号) 与 hy_user(元宝账号UUID)，均按账号稳定；
  // uin/wxuin/openid 实际不存在，cookie 标识已验证，优先于泛用 DOM 脚本
  yuanbao: { script: COMMON_FINGERPRINT_SCRIPT, cookieFirst: true },
  kling: { script: COMMON_FINGERPRINT_SCRIPT },
  hailuo: { script: COMMON_FINGERPRINT_SCRIPT }
}

// DOM 提取不到时，从登录 cookie 中找「稳定账号标识」cookie 兜底。
// 这些字段代表账号本身（QQ号/微信uin/阿里登录名等），同账号重复登录值不变，适合做指纹。
const FINGERPRINT_COOKIE_KEYS: Partial<Record<ProviderId, string[]>> = {
  // 实测值：抖音扫码登录时 uid_tt/uid_tt_ss 每次登录会变；flow_cur_user_sec_id 才是账号级稳定标识（两次登录一致）
  doubao: ['flow_cur_user_sec_id', 'uid_tt', 'uid_tt_ss'],
  jimeng: ['user_id', 'uid', 'userId'],
  qwen: ['login_aliyunid', 'loginaliyunid'],
  // 实测值：pt2gguin = o<QQ号>（.ptlogin2.qq.com），hy_user = 元宝账号 UUID（.tencent.com）
  yuanbao: ['pt2gguin', 'hy_user'],
  kling: ['userId', 'user_id', 'kk_u'],
  hailuo: ['user_id', 'uid', 'userId']
}

function normalizeAccountId(raw: string): string {
  // 全角转半角 + trim + 小写
  return raw
    .replace(/[\uff01-\uff5e]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ')
    .trim()
    .toLowerCase()
}

function fingerprintFor(providerId: string, raw: string): string {
  return createHash('sha256')
    .update(`${providerId}|${normalizeAccountId(raw)}`)
    .digest('hex')
}

function providerSite(providerId: string): ProviderSite | undefined {
  return PROVIDER_SITES[providerId as ProviderId]
}

// 轻量诊断：仅记录来源与指纹哈希（不落明文标识），供各厂商提取脚本联调校准
function appendFingerprintDebug(entry: Record<string, unknown>): void {
  try {
    appendFileSync(
      join(app.getPath('userData'), 'fingerprint-debug.jsonl'),
      JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n'
    )
  } catch {
    // 日志失败不影响绑定流程
  }
}

// 在登录窗口（尚未销毁）执行提取脚本；超时/失败返回 null（不阻断绑定）
async function extractAccountFingerprint(
  win: BrowserWindow,
  providerId: string,
  cookies: ProviderCookie[]
): Promise<string | null> {
  const extractor = ACCOUNT_FINGERPRINT_EXTRACTORS[providerId as ProviderId]

  const tryCookieFallback = (): string | null => {
    const keys = FINGERPRINT_COOKIE_KEYS[providerId as ProviderId]
    if (keys && cookies.length > 0) {
      for (const key of keys) {
        const match = cookies.find((c) => c.name.toLowerCase() === key.toLowerCase())
        if (match && match.value.trim()) return match.value.trim()
      }
    }
    return null
  }

  const tryDom = async (): Promise<string | null> => {
    if (!extractor) return null
    let timer: NodeJS.Timeout | undefined
    try {
      const raw = await Promise.race<unknown>([
        win.webContents.executeJavaScript(extractor.script, true),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('fingerprint timeout')), 10000)
        })
      ])
      if (typeof raw === 'string' && raw.trim()) return fingerprintFor(providerId, raw)
    } catch {
      // 页面提取失败，交由调用方走 cookie 兜底
    } finally {
      if (timer) clearTimeout(timer)
    }
    return null
  }

  let source: string | null = null
  let fingerprint: string | null = null

  if (extractor?.cookieFirst) {
    const cookieRaw = tryCookieFallback()
    if (cookieRaw) {
      source = 'cookie'
      fingerprint = fingerprintFor(providerId, cookieRaw)
    } else {
      const domFp = await tryDom()
      if (domFp) {
        source = 'dom'
        fingerprint = domFp
      }
    }
  } else {
    const domFp = await tryDom()
    if (domFp) {
      source = 'dom'
      fingerprint = domFp
    } else {
      const cookieRaw = tryCookieFallback()
      if (cookieRaw) {
        source = 'cookie'
        fingerprint = fingerprintFor(providerId, cookieRaw)
      }
    }
  }

  appendFingerprintDebug({
    providerId,
    source,
    fingerprint: fingerprint ?? null,
    cookieNames: cookies.map((c) => c.name)
  })
  return fingerprint
}

function openLoginWindow(providerId: string): Promise<ProviderLoginResult> {
  const site = providerSite(providerId)
  const loginUrl = site?.loginUrl
  if (!loginUrl) {
    return Promise.resolve({ ok: false, error: '该厂商仅支持 API Key 绑定' })
  }

  return new Promise((resolve) => {
    const existing = loginWindows.get(providerId)
    if (existing && !existing.isDestroyed()) {
      existing.focus()
      resolve({ ok: false, canceled: true, error: '登录窗口已打开' })
      return
    }

    // 清除旧 session，确保每次都是全新登录状态
    // 注：Electron StorageType 不含 sessionStorage（随窗口销毁自动清理），这里清 cookie + localStorage
    const ses = session.fromPartition(partitionFor(providerId))
    void ses.clearStorageData({ storages: ['cookies', 'localstorage'] })

    const win = new BrowserWindow({
      width: 1120,
      height: 780,
      minWidth: 900,
      minHeight: 640,
      autoHideMenuBar: true,
      title: '厂商登录 - Quota-Flow',
      backgroundColor: '#ffffff',
      webPreferences: {
        partition: partitionFor(providerId),
        contextIsolation: true,
        nodeIntegration: false
      }
    })
    loginWindows.set(providerId, win)

    let finished = false
    const done = (result: ProviderLoginResult): void => {
      if (finished) return
      finished = true
      clearInterval(pollTimer)
      if (!win.isDestroyed()) win.destroy()
      loginWindows.delete(providerId)
      resolve(result)
    }

    win.on('closed', () => {
      clearInterval(pollTimer)
      if (loginWindows.get(providerId) === win) loginWindows.delete(providerId)
      if (!finished) {
        finished = true
        resolve({ ok: false, canceled: true })
      }
    })

    // 页面顶部注入操作条：提示 + 完成后点击按钮
    const injectBar = (): void => {
      void win.webContents
        .executeJavaScript(
          `(() => {
            if (document.getElementById('qf-login-bar')) return;
            const bar = document.createElement('div');
            bar.id = 'qf-login-bar';
            bar.style.cssText = 'position:fixed;top:0;left:0;right:0;height:40px;z-index:2147483647;display:flex;align-items:center;justify-content:space-between;padding:0 12px;background:#1c1c1e;color:#fff;font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-shadow:0 1px 4px rgba(0,0,0,.3);';
            bar.innerHTML =
              '<span>请在弹出的页面完成登录</span>' +
              '<button id="qf-login-done" style="padding:5px 14px;border:0;border-radius:6px;background:#e07a3e;color:#fff;font:600 13px/1.4 inherit;cursor:pointer;">已完成登录</button>';
            document.documentElement.style.marginTop = '40px';
            document.body.appendChild(bar);
            document.getElementById('qf-login-done').addEventListener('click', () => {
              window.__QF_LOGIN_DONE__ = true;
            });
          })()`
        )
        .catch(() => {})
    }

    win.webContents.on('did-finish-load', () => {
      injectBar()
    })

    // 轮询用户是否点击"已完成登录"
    const pollTimer = setInterval(() => {
      if (win.isDestroyed()) return
      void win.webContents
        .executeJavaScript('window.__QF_LOGIN_DONE__ === true')
        .then((flag: boolean) => {
          if (!flag) return
          void collectPartitionCookies(providerId)
            .then(async (cookies) => {
              if (cookies.length === 0) {
                done({ ok: false, error: '未检测到登录 Cookie，请确认已登录后重试' })
                return
              }
              // 登录成功：在窗口销毁前提取账号指纹（P2 去重）
              const accountFingerprint = await extractAccountFingerprint(win, providerId, cookies)
              const maxExp = Math.max(...cookies.map((c) => c.expires))
              const viewCookies = cookies.length
              done({
                ok: true,
                encrypted: encryptCookies(cookies),
                cookieCount: viewCookies,
                expiresAt: maxExp > 0 ? maxExp : null,
                accountFingerprint
              })
            })
            .catch((e: unknown) => done({ ok: false, error: String(e) }))
        })
        .catch(() => {})
    }, 800)

    void win.loadURL(loginUrl).catch((e: unknown) => {
      done({ ok: false, error: `加载登录页失败：${String(e)}` })
    })
  })
}

async function healthCheck(
  providerId: string,
  encrypted: string
): Promise<{ ok: boolean; status: string; error?: string }> {
  const site = providerSite(providerId)
  if (!site?.healthUrl) return { ok: false, status: 'unknown', error: '该厂商不支持健康检查' }

  let cookies: ProviderCookie[]
  try {
    const plain = safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
    cookies = JSON.parse(plain) as ProviderCookie[]
  } catch {
    return { ok: false, status: 'unknown', error: '解密失败' }
  }

  const ses = session.fromPartition(partitionFor(providerId))
  await injectCookies(providerId, cookies)

  return new Promise((resolve) => {
    const win = new BrowserWindow({
      show: false,
      width: 800,
      height: 600,
      webPreferences: { partition: partitionFor(providerId) }
    })

    let statusCode: number | null = null
    let finalUrl = ''
    let settled = false
    const settle = (status: string, error?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (!win.isDestroyed()) win.destroy()
      resolve({ ok: status !== 'unknown', status, error })
    }

    const timeout = setTimeout(() => settle('unknown', '健康检查超时'), 20000)

    ses.webRequest.onResponseStarted((details) => {
      if (details.resourceType === 'mainFrame') {
        statusCode = details.statusCode
        finalUrl = details.url
      }
    })

    win.webContents.on('did-fail-load', (_e, code, desc) => {
      if (code === -3) return // ERR_ABORTED（导航跳转忽略）
      settle('unknown', `加载失败 (${code}: ${desc})`)
    })

    win.webContents.on('did-finish-load', () => {
      finalUrl = win.webContents.getURL()
      if (statusCode === null) settle('unknown', '未捕获响应状态')
      else if (statusCode === 200) settle('healthy')
      else if (statusCode === 401 || statusCode === 403) settle('expired', `HTTP ${statusCode}`)
      else settle('unknown', `HTTP ${statusCode}`)
    })

    void win.loadURL(site.healthUrl)
  })
}

let registered = false

export function initProviders(): void {
  if (registered) return
  registered = true

  ipcMain.handle('provider:login', async (_e, providerId: string) => {
    return openLoginWindow(providerId)
  })

  ipcMain.handle('provider:encrypt', (_e, providerId: string, plain: string) => {
    if (typeof plain !== 'string') return { encrypted: '' }
    try {
      const encrypted = safeStorage.encryptString(plain).toString('base64')
      // apikey 型厂商：指纹 = sha256(providerId|apikey 明文)，用于去重
      const fingerprint = plain.trim() ? fingerprintFor(providerId, plain.trim()) : null
      return { encrypted, fingerprint }
    } catch {
      return { encrypted: '' }
    }
  })

  ipcMain.handle('provider:health-check', (_e, providerId: string, encrypted: string) => {
    return healthCheck(providerId, encrypted)
  })

  ipcMain.handle('provider:login-cancel', (_e, providerId: string) => {
    const win = loginWindows.get(providerId)
    if (win && !win.isDestroyed()) win.destroy()
  })
}

declare global {
  interface Window {
    __QF_LOGIN_DONE__?: boolean
  }
}
