import { createHash } from 'crypto'
import { app, BrowserWindow, ipcMain, safeStorage, session } from 'electron'
import type { Cookie } from 'electron'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 统一 User-Agent：登录 / 校验 / 生成三处必须一致，避免豆包服务端按设备指纹失效会话 */
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36'

export type ProviderId =
  | 'doubao'
  | 'jimeng'
  | 'qwen'
  | 'qwenwan'
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
  qwenwan: {
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

/** 多 origin 存储：按站点 origin 隔离 localStorage / sessionStorage（扩展候选 A 收集范围） */
export interface OriginStorage {
  origin: string
  localStorage: Array<{ key: string; value: string }>
  sessionStorage?: Array<{ key: string; value: string }>
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
const siteWindows = new Map<string, BrowserWindow>()

/**
 * 分区标识：
 * - 无 keyId（通用登录窗口/健康检查）：persist:qf-p:<providerId>
 * - 有 keyId（账号级独立分区，登录=生成）：persist:qf-p:<providerId>:<keyId>
 */
function partitionFor(providerId: string, keyId?: string): string {
  const base = 'persist:qf-p:' + providerId
  return keyId ? `${base}:${keyId}` : base
}

/** 存储 v2 格式说明：
 *  - v0 (兼容最旧): ProviderCookie[]
 *  - v1 (兼容旧):   { cookies: ProviderCookie[], localStorage: {key,value}[] }
 *  - v2 (当前):      { cookies: ProviderCookie[], storages: OriginStorage[] }
 * 加密前统一序列化；parseStoredCredentials 统一归一化为 cookies + storages + 兼容 localStorage。
 */
interface StoredV2 {
  cookies: ProviderCookie[]
  storages?: OriginStorage[]
  /** 兼容 v1：解析时会同步写入 storages[0]（origin=豆包主站） */
  localStorage?: Array<{ key: string; value: string }>
}

function encryptCookies(
  cookies: ProviderCookie[],
  storages: OriginStorage[] = []
): string {
  const payload: StoredV2 = { cookies }
  if (storages.length > 0) payload.storages = storages
  // 兼容 v1 字段，供老代码读取
  const main = storages.find((s) => s.origin.includes('doubao.com')) || storages[0]
  if (main?.localStorage.length) payload.localStorage = main.localStorage
  const plain = JSON.stringify(payload)
  return safeStorage.encryptString(plain).toString('base64')
}

export { encryptCookies }

/** 兼容 v0 / v1 / v2 格式，统一返回 cookies + storages（以及为调用方保留的 localStorage 兼容字段） */
function parseStoredCredentials(encrypted: string): {
  cookies: ProviderCookie[]
  storages: OriginStorage[]
  localStorage: Array<{ key: string; value: string }>
} {
  const plain = safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
  const parsed = JSON.parse(plain) as unknown
  // v0: ProviderCookie[]
  if (Array.isArray(parsed)) {
    return { cookies: parsed as ProviderCookie[], storages: [], localStorage: [] }
  }
  const obj = parsed as StoredV2
  const cookies = obj.cookies ?? []
  const storages: OriginStorage[] = obj.storages ?? []
  // v1 localStorage 归一化到 storages（豆包主站 origin）
  if (obj.localStorage?.length && !storages.length) {
    storages.push({
      origin: 'https://www.doubao.com',
      localStorage: obj.localStorage,
      sessionStorage: []
    })
  }
  // 兼容调用方取 localStorage 字段（豆包主站）
  const mainStorage = storages.find((s) => s.origin.includes('www.doubao.com')) || storages[0]
  const localStorage = mainStorage?.localStorage ?? []
  return { cookies, storages, localStorage }
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

async function collectPartitionCookies(providerId: string, keyId?: string): Promise<ProviderCookie[]> {
  const ses = session.fromPartition(partitionFor(providerId, keyId))
  const all = await ses.cookies.get({})
  return exportCookies(all)
}

async function injectCookies(
  providerId: string,
  cookies: ProviderCookie[],
  keyId?: string
): Promise<void> {
  const ses = session.fromPartition(partitionFor(providerId, keyId))
  ses.setUserAgent(CHROME_UA)
  for (const c of cookies) {
    try {
      await ses.cookies.set({
        url: `${c.secure ? 'https' : 'http'}://${(c.domain || '').replace(/^\./, '') || 'www.doubao.com'}${c.path || '/'}`,
        domain: c.domain || undefined,
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
  qwenwan: { script: COMMON_FINGERPRINT_SCRIPT },
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
  qwenwan: ['login_aliyunid', 'loginaliyunid'],
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

export { providerSite }

function providerMainOrigin(providerId: string): string {
  const site = providerSite(providerId)
  const url = site?.loginUrl || site?.healthUrl
  if (!url) return ''
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}

function isProviderMainSite(providerId: string, currentUrl: string): boolean {
  const origin = providerMainOrigin(providerId)
  if (!origin) return false
  try {
    return new URL(currentUrl).origin === origin
  } catch {
    return currentUrl.startsWith(origin)
  }
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

// 豆包会话 cookie 由 Electron session 统一管理（跨 origin 的 cookie 都在 session 里），
// collectPartitionCookies 已能收集全部 cookie。localStorage 只需收集当前页面 origin 即可，
// 不需要用 iframe 访问 sso/passport/auth 等域名（它们大多不存在或 SSL 证书无效，会产生大量错误日志）。

/**
 * 打开厂商登录窗口
 * @param providerId 厂商 id
 * @param keyId 可选：账号 key id。传入后登录分区与生成分区共用（候选 C：不跨分区迁移，直接在生成分区登录）
 */
function openLoginWindow(providerId: string, keyId?: string): Promise<ProviderLoginResult> {
  const site = providerSite(providerId)
  const loginUrl = site?.loginUrl
  if (!loginUrl) {
    return Promise.resolve({ ok: false, error: '该厂商仅支持 API Key 绑定' })
  }

  // 窗口唯一键：有 keyId 时按 keyId 区分（允许同时打开不同账号的登录窗口）
  const winKey = keyId ? `${providerId}:${keyId}` : providerId
  const partition = partitionFor(providerId, keyId)

  return new Promise((resolve) => {
    const existing = loginWindows.get(winKey)
    if (existing && !existing.isDestroyed()) {
      existing.focus()
      resolve({ ok: false, canceled: true, error: '登录窗口已打开' })
      return
    }

    // 清除旧 session，确保每次都是全新登录状态
    // 注：Electron StorageType 不含 sessionStorage（随窗口销毁自动清理），这里清 cookie + localStorage
    const ses = session.fromPartition(partition)
    ses.setUserAgent(CHROME_UA)
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
        partition,
        contextIsolation: true,
        nodeIntegration: false
      }
    })
    // 候选 B：登录窗口 webContents 统一 UA
    win.webContents.setUserAgent(CHROME_UA)
    loginWindows.set(winKey, win)

    let finished = false
    const done = (result: ProviderLoginResult): void => {
      if (finished) return
      finished = true
      clearInterval(pollTimer)
      if (!win.isDestroyed()) win.destroy()
      loginWindows.delete(winKey)
      resolve(result)
    }

    win.on('closed', () => {
      clearInterval(pollTimer)
      if (loginWindows.get(winKey) === win) loginWindows.delete(winKey)
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
              '<span>请在弹出的页面完成登录，扫码后请等待页面跳转回厂商主站再点击按钮</span>' +
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
          void collectPartitionCookies(providerId, keyId)
            .then(async (cookies) => {
              // 1) 等待页面真正进入已登录状态，且确保跳转到该厂商主站（最多 20s）
              //    候选 D 优化 + 候选 A 校验：确保在主站而不是 SSO 中间页
              let loggedIn = false
              let onMainSite = false
              let currentUrl = ''
              for (let i = 0; i < 20; i++) {
                try {
                  const state = (await win.webContents.executeJavaScript(
                    `(() => {
                      const norm = (s) => (s || '').trim();
                      const btns = [...document.querySelectorAll('button, [role="button"]')]
                        .filter((b) => b.offsetParent !== null)
                        .map((b) => norm(b.textContent));
                      // 登录墙特征（大号按钮），而非导航栏常驻的「登录」按钮
                      const hasLoginWall = btns.some((t) => /^(扫码登录|立即登录|手机号登录|短信登录)$/.test(t));
                      const hasAvatar = !!document.querySelector('[class*="avatar" i], [class*="userinfo" i], [class*="user-info" i]');
                      return { hasLoginWall, hasAvatar, url: location.href };
                    })()`,
                    true
                  )) as { hasLoginWall?: boolean; hasAvatar?: boolean; url?: string }
                  currentUrl = state.url || ''
                  onMainSite = isProviderMainSite(providerId, currentUrl)
                  if (state && !state.hasLoginWall && (state.hasAvatar || onMainSite)) {
                    loggedIn = true
                    break
                  }
                } catch {}
                await sleep(1000)
              }
              if (!loggedIn || !onMainSite) {
                done({
                  ok: false,
                  error: !onMainSite
                    ? '登录后未跳转回厂商主站（当前在 ' + (currentUrl || '未知页') + '），请完成登录流程后重试'
                    : '未检测到有效登录状态，请确认已扫码登录后再试'
                })
                return
              }
              // 2) 等待会话 cookie 落定并稳定（监听 cookie 变化直到不新增）
              await sleep(1500)
              let stableTries = 0
              let lastCount = 0
              for (let i = 0; i < 5; i++) {
                cookies = await collectPartitionCookies(providerId, keyId)
                if (cookies.length === lastCount && cookies.length > 0) {
                  stableTries += 1
                  if (stableTries >= 2) break
                } else {
                  stableTries = 0
                  lastCount = cookies.length
                }
                await sleep(800)
              }
              cookies = await collectPartitionCookies(providerId, keyId)
              if (cookies.length === 0) {
                done({ ok: false, error: '未检测到登录 Cookie，请确认已登录后重试' })
                return
              }
              const hasSession = cookies.some((c) => /session|sso|passport|token|uid|sid/i.test(c.name))
              if (!hasSession) {
                done({ ok: false, error: '未检测到会话 Cookie（可能登录未完成），请重试' })
                return
              }

              // 3) 收集当前页面 origin 的 localStorage + sessionStorage
              //    cookie 由 Electron session 统一管理（跨 origin），这里只需补充当前页面的 Web Storage
              let storages: OriginStorage[] = []
              try {
                const collected = (await win.webContents.executeJavaScript(
                  `(() => {
                    const results = [];
                    try {
                      results.push({
                        origin: location.origin,
                        localStorage: Object.entries(localStorage).map(([k,v]) => ({ key: k, value: v })),
                        sessionStorage: Object.entries(sessionStorage).map(([k,v]) => ({ key: k, value: v }))
                      });
                    } catch {}
                    return results;
                  })()`,
                  true
                )) as OriginStorage[]
                if (Array.isArray(collected)) {
                  storages = collected.filter(
                    (s) => s && typeof s.origin === 'string' && Array.isArray(s.localStorage)
                  )
                }
              } catch {}
              // 4) 记录收集元信息
              appendFingerprintDebug({
                type: 'login-collected',
                providerId,
                keyId: keyId || null,
                partition,
                cookieCount: cookies.length,
                storageOrigins: storages.map((s) => ({ origin: s.origin, ls: s.localStorage.length, ss: (s.sessionStorage || []).length })),
                cookies: cookies.map((c) => ({ name: c.name, domain: c.domain, secure: c.secure, httpOnly: c.httpOnly, expires: c.expires }))
              })

              // 6) 登录成功：在窗口销毁前提取账号指纹（P2 去重）
              const accountFingerprint = await extractAccountFingerprint(win, providerId, cookies)
              const maxExp = Math.max(...cookies.map((c) => c.expires))
              const viewCookies = cookies.length

              // 7) 候选 C 优化：如果传入了 keyId，同步把 cookie + storages
              //    也注入 `persist:qf-p:doubao:<keyId>` 生成分区（避免生成时注入有时序差异）
              if (keyId) {
                try {
                  await injectCookies(providerId, cookies, keyId)
                } catch {}
              }

              done({
                ok: true,
                encrypted: encryptCookies(cookies, storages),
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

/**
 * 打开已绑定账号对应的官网窗口。
 * 复用登录/生成分区（persist:qf-p:<provider>:<keyId>），不清理登录态，
 * 也不会注入登录流程的“已完成登录”操作条。
 */
async function openProviderSite(
  providerId: string,
  keyId: string,
  encryptedKey?: string
): Promise<{ ok: boolean; error?: string }> {
  const site = providerSite(providerId)
  const url = site?.loginUrl || site?.healthUrl
  if (!url) return { ok: false, error: '该厂商仅支持 API Key 绑定，暂不支持打开官网' }

  const partition = partitionFor(providerId, keyId)
  const winKey = `${providerId}:${keyId}`
  const existing = siteWindows.get(winKey)
  if (existing && !existing.isDestroyed()) {
    existing.show()
    existing.focus()
    return { ok: true }
  }

  const ses = session.fromPartition(partition)
  ses.setUserAgent(CHROME_UA)
  if (encryptedKey) {
    try {
      const parsed = parseStoredCredentials(encryptedKey)
      if (parsed.cookies.length > 0) await injectCookies(providerId, parsed.cookies, keyId)
    } catch {
      // 解密失败时仍尝试打开官网，至少让用户看到站点本身。
    }
  }

  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    autoHideMenuBar: true,
    title: '厂商官网 - Quota-Flow',
    backgroundColor: '#ffffff',
    webPreferences: {
      partition,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  win.webContents.setUserAgent(CHROME_UA)
  win.webContents.setWindowOpenHandler(({ url: nextUrl }) => {
    if (nextUrl.startsWith('http')) {
      return { action: 'allow', overrideBrowserWindowOptions: { width: 960, height: 720 } }
    }
    return { action: 'deny' }
  })
  siteWindows.set(winKey, win)

  win.on('closed', () => {
    if (siteWindows.get(winKey) === win) siteWindows.delete(winKey)
  })

  void win.loadURL(url).catch((e: unknown) => {
    if (!win.isDestroyed()) win.destroy()
    siteWindows.delete(winKey)
    return { ok: false, error: `加载官网失败：${String(e)}` }
  })

  return { ok: true }
}

async function healthCheck(
  providerId: string,
  encrypted: string,
  keyId?: string
): Promise<{ ok: boolean; status: string; error?: string }> {
  const site = providerSite(providerId)
  if (!site?.healthUrl) return { ok: false, status: 'unknown', error: '该厂商不支持健康检查' }

  let cookies: ProviderCookie[]
  try {
    cookies = parseStoredCredentials(encrypted).cookies
  } catch {
    return { ok: false, status: 'unknown', error: '解密失败' }
  }

  const partition = partitionFor(providerId, keyId)
  const ses = session.fromPartition(partition)
  ses.setUserAgent(CHROME_UA)
  await injectCookies(providerId, cookies, keyId)

  return new Promise((resolve) => {
    const win = new BrowserWindow({
      show: false,
      // 防止 Windows 上隐藏窗口在创建/导航时闪现
      paintWhenInitiallyHidden: false,
      width: 800,
      height: 600,
      backgroundColor: '#0c0c0c',
      webPreferences: { partition }
    })
    win.webContents.setUserAgent(CHROME_UA)

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

    // 8 秒未加载完成视为异常（后台检查，不阻塞列表展示；失败写回 unknown，由节流逻辑控制重查节奏）
    const timeout = setTimeout(() => settle('unknown', '健康检查超时'), 8000)

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

export interface VisitResult {
  ok: boolean
  status: 'healthy' | 'expired' | 'unknown'
  cookies?: ProviderCookie[]
  storages?: OriginStorage[]
  cookieCount?: number
  expiresAt?: number | null
  error?: string
}

/**
 * 自动续命核心：用隐藏窗口访问厂商站点（复用账号分区与 UA），
 * 模拟活跃等待会话滑动续期，随后重新抓取 cookie + localStorage 并返回。
 * 完整性校验：新会话明显缩水（< 旧的 60%）视为风控/验证码页 → 返回 unknown 放弃写回（保留旧 cookie）。
 */
export async function visitAndCapture(
  providerId: string,
  keyId: string,
  encrypted: string,
  url: string
): Promise<VisitResult> {
  let cookies: ProviderCookie[]
  let oldStorages: OriginStorage[] = []
  try {
    const parsed = parseStoredCredentials(encrypted)
    cookies = parsed.cookies
    oldStorages = parsed.storages ?? []
  } catch {
    return { ok: false, status: 'unknown', error: '解密失败' }
  }
  if (cookies.length === 0) return { ok: false, status: 'unknown', error: '无可用 Cookie' }

  const partition = partitionFor(providerId, keyId)
  const ses = session.fromPartition(partition)
  ses.setUserAgent(CHROME_UA)
  try {
    await injectCookies(providerId, cookies, keyId)
  } catch {
    return { ok: false, status: 'unknown', error: 'Cookie 注入失败' }
  }

  return new Promise((resolve) => {
    const win = new BrowserWindow({
      show: false,
      paintWhenInitiallyHidden: false,
      width: 800,
      height: 600,
      backgroundColor: '#0c0c0c',
      webPreferences: { partition }
    })
    win.webContents.setUserAgent(CHROME_UA)

    let statusCode: number | null = null
    let settled = false
    let timeout: NodeJS.Timeout | undefined
    const settle = (result: VisitResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (!win.isDestroyed()) win.destroy()
      resolve(result)
    }

    // 页面加载 + 模拟活跃停留，最长 30s
    timeout = setTimeout(() => settle({ ok: false, status: 'unknown', error: '续命访问超时' }), 30000)

    ses.webRequest.onResponseStarted((details) => {
      if (details.resourceType === 'mainFrame') {
        statusCode = details.statusCode
      }
    })

    win.webContents.on('did-fail-load', (_e, code, desc) => {
      if (code === -3) return // ERR_ABORTED
      settle({ ok: false, status: 'unknown', error: `加载失败 (${code}: ${desc})` })
    })

    win.webContents.on('did-finish-load', async () => {
      try {
        if (statusCode === 401 || statusCode === 403) {
          settle({ ok: false, status: 'expired', error: `HTTP ${statusCode}` })
          return
        }
        // 模拟活跃：停留等页面完成初始化，触发服务端会话滑动续期
        await sleep(6000)
        const fresh = await collectPartitionCookies(providerId, keyId)
        if (fresh.length === 0) {
          settle({ ok: false, status: 'expired', error: '会话 Cookie 已丢失' })
          return
        }
        if (fresh.length < cookies.length * 0.6) {
          settle({ ok: false, status: 'unknown', error: 'Cookie 数量异常（可能触发验证），保留旧会话' })
          return
        }
        // 重新收集当前页面 Web Storage（抓不到就沿用旧数据）
        let storages: OriginStorage[] = oldStorages
        try {
          const collected = (await win.webContents.executeJavaScript(
            `(() => {
              const results = [];
              try {
                results.push({
                  origin: location.origin,
                  localStorage: Object.entries(localStorage).map(([k,v]) => ({ key: k, value: v })),
                  sessionStorage: Object.entries(sessionStorage).map(([k,v]) => ({ key: k, value: v }))
                });
              } catch {}
              return results;
            })()`,
            true
          )) as OriginStorage[]
          if (Array.isArray(collected) && collected.length > 0) {
            storages = collected.filter(
              (s) => s && typeof s.origin === 'string' && Array.isArray(s.localStorage)
            )
          }
        } catch {}
        const maxExp = Math.max(...fresh.map((c) => c.expires))
        settle({
          ok: true,
          status: 'healthy',
          cookies: fresh,
          storages,
          cookieCount: fresh.length,
          expiresAt: maxExp > 0 ? maxExp : null
        })
      } catch (e) {
        settle({ ok: false, status: 'unknown', error: String(e) })
      }
    })

    void win.loadURL(url).catch((e: unknown) => {
      settle({ ok: false, status: 'unknown', error: `加载页面失败：${String(e)}` })
    })
  })
}

let registered = false

export function initProviders(): void {
  if (registered) return
  registered = true

  ipcMain.handle('provider:login', async (_e, providerId: string, keyId?: string) => {
    return openLoginWindow(providerId, typeof keyId === 'string' ? keyId : undefined)
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

  ipcMain.handle('provider:health-check', (_e, providerId: string, encrypted: string, keyId?: string) => {
    return healthCheck(providerId, encrypted, typeof keyId === 'string' ? keyId : undefined)
  })

  ipcMain.handle(
    'provider:open-site',
    (_e, providerId: string, keyId: string, encryptedKey?: string) =>
      openProviderSite(providerId, keyId, typeof encryptedKey === 'string' ? encryptedKey : undefined)
  )

  ipcMain.handle('provider:login-cancel', (_e, providerId: string, keyId?: string) => {
    const winKey = typeof keyId === 'string' && keyId ? `${providerId}:${keyId}` : providerId
    const win = loginWindows.get(winKey)
    if (win && !win.isDestroyed()) win.destroy()
  })

  // 迁移分区：把 src 分区的 cookie 复制到 dst 分区（用于刷新已有账号时把临时分区登录态迁移到目标分区）
  ipcMain.handle(
    'provider:migrate-partition',
    async (_e, providerId: string, srcKeyId: string, dstKeyId: string) => {
      try {
        const cookies = await collectPartitionCookies(providerId, srcKeyId)
        if (cookies.length === 0) return { ok: false, error: '源分区无 cookie' }
        await injectCookies(providerId, cookies, dstKeyId)
        // 清理临时分区
        try {
          const srcSes = session.fromPartition(partitionFor(providerId, srcKeyId))
          await srcSes.clearStorageData()
        } catch {}
        return { ok: true, cookieCount: cookies.length }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  )
}

declare global {
  interface Window {
    __QF_LOGIN_DONE__?: boolean
  }
}
