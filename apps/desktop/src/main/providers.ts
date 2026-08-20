import { createHash } from 'crypto'
import { app, BrowserWindow, ipcMain, safeStorage, session, shell } from 'electron'
import type { Cookie } from 'electron'
import { appendFileSync, openSync, closeSync, readSync, statSync, truncateSync } from 'node:fs'
import { join } from 'node:path'
import {
  fetchZhipuQuota,
  testZhipuApiKey,
  fetchVolcengineQuota,
  testVolcengineApiKey,
  volcengineAccountFingerprint,
  decodeVolcenginePayload,
  jwtExpiryMs,
  captureVolcengineFreeVideoModels,
  volcengineAuthoritativeIds,
  VOLCENGINE_FREE_NAME_TO_ID
} from '@quota-flow/providers'
import {
  testBailianApiKey,
  bailianAccountFingerprint,
  decodeBailianPayload,
  parseBailianFreeTierPayload,
  aggregateBailianFreeQuota,
  isBailianVideoFreeModel
} from '@quota-flow/providers'
import type { VolcengineFreeVideoModel, BailianStoredCookie } from '@quota-flow/providers'

/** 对「解密后的明文」仅做透明的 models 不可用标记写入，返回新明文（不触发网络；consoleJwt/accountId 原样保留）。 */
export function markVolcModelUnavailable(
  plain: string,
  model: string,
  kind: 'decommissioned' | 'no_endpoint'
): { ok: true; plain: string } | { ok: false } {
  try {
    const d = decodeVolcenginePayload(plain)
    if (!d.apiKey) return { ok: false }
    const models = Array.isArray(d.models) ? d.models : []
    const byId = new Map(models.map((m) => [m.id, m]))
    const copy = byId.get(model)
    if (copy) {
      copy.unavailable = kind
    } else {
      byId.set(model, { id: model, unavailable: kind } as VolcengineFreeVideoModel)
    }
    const next = JSON.stringify({ v: 1, apiKey: d.apiKey, consoleJwt: d.consoleJwt ?? null, accountId: d.accountId ?? null, models: Array.from(byId.values()) })
    return { ok: true, plain: next }
  } catch {
    return { ok: false }
  }
}

/** 对「解密后的明文」仅做透明的 models 不可用标记清除（生成成功后自愈），返回新明文。 */
export function clearVolcModelUnavailable(plain: string, model: string): { ok: true; plain: string } | { ok: false } {
  try {
    const d = decodeVolcenginePayload(plain)
    if (!d.apiKey) return { ok: false }
    const models = Array.isArray(d.models) ? d.models : []
    const byId = new Map(models.map((m) => [m.id, m]))
    const cur = byId.get(model)
    if (cur && 'unavailable' in cur) {
      delete cur.unavailable
      // 该 id 除 id 外无其它字段时移除整项，避免占位
      const { unavailable: _u, ...rest } = cur
      if (Object.keys(rest).length <= 1) byId.delete(model)
    }
    const next = JSON.stringify({ v: 1, apiKey: d.apiKey, consoleJwt: d.consoleJwt ?? null, accountId: d.accountId ?? null, models: Array.from(byId.values()) })
    return { ok: true, plain: next }
  } catch {
    return { ok: false }
  }
}

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
  | 'dola'
  | 'kling'
  | 'hailuo'
  | 'bailian'

interface ProviderSite {
  loginUrl?: string
  healthUrl: string
}

// 无 loginUrl 的厂商（例如 API Key 型）不走登录窗口；其余 cookie 型厂商走网页登录
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
    loginUrl: 'https://www.qianwen.com/chat',
    healthUrl: 'https://www.qianwen.com/'
  },
  yuanbao: {
    loginUrl: 'https://yuanbao.tencent.com/chat/naQivTmsDa',
    healthUrl: 'https://yuanbao.tencent.com/'
  },
  dola: {
    loginUrl: 'https://www.dola.com/',
    healthUrl: 'https://www.dola.com/'
  },
  kling: {
    loginUrl: 'https://klingai.com/global/',
    healthUrl: 'https://klingai.com/global/'
  },
  hailuo: {
    loginUrl: 'https://hailuoai.com/video',
    healthUrl: 'https://hailuoai.com/'
  },
  // 阿里云百炼：bailian 为 apikey 厂商，走 openProviderSite 通用分支打开 API Key 管理页
  bailian: {
    loginUrl: 'https://bailian.console.aliyun.com/cn-beijing?tab=model#/api-key',
    healthUrl: 'https://bailian.console.aliyun.com/'
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
 * - 智谱（bigmodel）：控制台会话分区 persist:qf-zhipu-console[:keyId]，keyId 用于账号隔离避免多账号串会话
 * - 无 keyId（通用登录窗口/健康检查）：persist:qf-p:<providerId>
 * - 有 keyId（账号级独立分区，登录=生成）：persist:qf-p:<providerId>:<keyId>
 */
const ZHIPU_CONSOLE_PARTITION = 'persist:qf-zhipu-console'
/** 智谱控制台分区按账号隔离：persist:qf-zhipu-console[:keyId]（无 keyId 回退共享分区，兼容旧账号/即开即用） */
function zhipuConsolePartitionFor(keyId?: string): string {
  return keyId ? `${ZHIPU_CONSOLE_PARTITION}:${keyId}` : ZHIPU_CONSOLE_PARTITION
}
function partitionFor(providerId: string, keyId?: string): string {
  if (providerId === 'zhipu') return zhipuConsolePartitionFor(keyId)
  if (providerId === 'volcengine') return volcConsolePartitionFor(keyId)
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
  const main = storages.find((s) => s.origin.includes('doubao.com') || s.origin.includes('qianwen.com')) || storages[0]
  if (main?.localStorage.length) payload.localStorage = main.localStorage
  const plain = JSON.stringify(payload)
  return safeStorage.encryptString(plain).toString('base64')
}

export { encryptCookies }

function defaultStorageOrigin(providerId: string): string {
  const site = providerSite(providerId)
  const url = site?.loginUrl || site?.healthUrl
  if (url) {
    try {
      const origin = new URL(url).origin
      if (origin) return origin
    } catch {
      // fallthrough to legacy defaults
    }
  }
  if (providerId === 'zhipu') return 'https://open.bigmodel.cn'
  return providerId === 'qwenwan' ? 'https://www.qianwen.com' : 'https://www.doubao.com'
}

/** 兼容 v0 / v1 / v2 格式，统一返回 cookies + storages（以及为调用方保留的 localStorage 兼容字段） */
export function parseStoredCredentials(encrypted: string, providerId = 'doubao'): {
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
  // v1 localStorage 归一化到 storages（按厂商主站 origin，避免千问等厂商解析后仍落到豆包）
  if (obj.localStorage?.length && !storages.length) {
    storages.push({
      origin: defaultStorageOrigin(providerId),
      localStorage: obj.localStorage,
      sessionStorage: []
    })
  }
  // 兼容调用方取 localStorage 字段（当前厂商主站优先，其次任意已收集 storage）
  const mainOrigin = defaultStorageOrigin(providerId)
  const mainStorage = storages.find((s) => s.origin === mainOrigin) || storages[0]
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

function hasSessionCookie(providerId: string, cookies: ProviderCookie[]): boolean {
  const generic = /session|sso|passport|token|uid|sid/i
  const tencent =
    providerId === 'yuanbao' ? /^hy_|^(uin|skey|pt4_token|pt2gguin)$/i : null
  return cookies.some((c) => generic.test(c.name) || (tencent ? tencent.test(c.name) : false))
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
        url: `${c.secure ? 'https' : 'http'}://${(c.domain || '').replace(/^\./, '') || defaultStorageOrigin(providerId).replace(/^https?:\/\//, '')}${c.path || '/'}`,
        domain: c.domain || undefined,
        name: c.name,
        value: c.value,
        httpOnly: c.httpOnly,
        secure: c.secure,
        expirationDate: typeof c.expires === 'number' && c.expires > 0 ? Math.floor(c.expires / 1000) : undefined
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
  qwen: { script: COMMON_FINGERPRINT_SCRIPT, cookieFirst: true },
  qwenwan: { script: COMMON_FINGERPRINT_SCRIPT, cookieFirst: true },
  // 实测元宝分区 cookie：QQ 登录产生 pt2gguin(o+QQ号) 与 hy_user(元宝账号UUID)，均按账号稳定；
  // uin/wxuin/openid 实际不存在，cookie 标识已验证，优先于泛用 DOM 脚本
  yuanbao: { script: COMMON_FINGERPRINT_SCRIPT, cookieFirst: true },
  // Dola 为字节系国际站 cookie 登录，暂用通用脚本 + cookie 优先；指纹 key 后续按真实登录记录校准。
  dola: { script: COMMON_FINGERPRINT_SCRIPT, cookieFirst: true },
  kling: { script: COMMON_FINGERPRINT_SCRIPT },
  hailuo: { script: COMMON_FINGERPRINT_SCRIPT }
}

// DOM 提取不到时，从登录 cookie 中找「稳定账号标识」cookie 兜底。
// 这些字段代表账号本身（QQ号/微信uin/阿里登录名等），同账号重复登录值不变，适合做指纹。
const FINGERPRINT_COOKIE_KEYS: Partial<Record<ProviderId, string[]>> = {
  // 实测值：抖音扫码登录时 uid_tt/uid_tt_ss 每次登录会变；flow_cur_user_sec_id 才是账号级稳定标识（两次登录一致）
  doubao: ['flow_cur_user_sec_id', 'uid_tt', 'uid_tt_ss'],
  jimeng: ['user_id', 'uid', 'userId'],
  // 实测千问登录后 .www.qianwen.com 会下发 b-user-id；_QW_HASH_UID/_QW_WG_UID 是账号级标识兜底。
  qwen: ['b-user-id', '_QW_HASH_UID', '_QW_WG_UID', 'login_aliyunid', 'loginaliyunid'],
  qwenwan: ['b-user-id', '_QW_HASH_UID', '_QW_WG_UID', 'login_aliyunid', 'loginaliyunid'],
  // 实测值：pt2gguin = o<QQ号>（.ptlogin2.qq.com），hy_user = 元宝账号 UUID（.tencent.com）
  yuanbao: ['pt2gguin', 'hy_user'],
  // Dola 同属字节系；避免使用 msToken / s_v_web_id 等会话级易变值做账号指纹。
  dola: ['flow_cur_user_sec_id', 'sessionid', 'sid_tt'],
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
              const hasSession = hasSessionCookie(providerId, cookies)
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
              //    也注入 `persist:qf-p:<providerId>:<keyId>` 生成分区（避免生成时注入有时序差异）
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
  // 智谱（bigmodel）/ 火山方舟（volcengine）/ 阿里云百炼（bailian）：
  // 打开该账号控制台，使用按账号隔离的分区免重复登录且不串号
  let url: string | undefined
  let partition: string
  let injectableEncrypted: string | undefined
  if (providerId === 'zhipu') {
    url = ZHIPU_CONSOLE_URL
    partition = partitionFor(providerId, keyId)
  } else if (providerId === 'volcengine') {
    url = VOLC_CONSOLE_URL
    partition = partitionFor(providerId, keyId)
  } else if (providerId === 'bailian') {
    // 复用绑定时捕获会话所在分区（persist:qf-bailian-console:<keyId>），打开即带已登录会话；每账号独立分区不串号
    url = BAILIAN_CONSOLE_URL
    partition = bailianConsolePartitionFor(keyId)
    injectableEncrypted = encryptedKey
    // 诊断：确认登录 cookie 是否真的落在该账号控制台分区（用于排查「进入官网未登录」）
    try {
      const diagSes = session.fromPartition(partition)
      const diagCks = await diagSes.cookies.get({ url: BAILIAN_CONSOLE_URL })
      console.log(
        `[qf-bailian] OPEN-SITE keyId=${keyId} partition=${partition} cookies=${diagCks.length} names=[${diagCks
          .slice(0, 8)
          .map((c) => c.name)
          .join(',')}]`
      )
    } catch {
      /* 诊断失败不影响打开官网 */
    }
  } else {
    const site = providerSite(providerId)
    url = site?.loginUrl || site?.healthUrl
    if (!url) return { ok: false, error: '该厂商仅支持 API Key 绑定，暂不支持打开官网' }
    partition = partitionFor(providerId, keyId)
    injectableEncrypted = encryptedKey
  }

  const winKey = `${providerId}:${keyId}`
  const existing = siteWindows.get(winKey)
  if (existing && !existing.isDestroyed()) {
    existing.show()
    existing.focus()
    return { ok: true }
  }

  const ses = session.fromPartition(partition)
  ses.setUserAgent(CHROME_UA)
  // 智谱走共享控制台分区，无需注入账号级 cookie；其余厂商按账号分区并注入 cookie
  if (injectableEncrypted) {
    try {
      if (providerId === 'bailian') {
        // 百炼把「进入官网」落在其控制台持久分区，重启后 persist 分区可能未留存登录 cookie，
        // 从加密负载中读取绑定时持久化的控制台 cookie 重新注入，重建登录态（不覆盖目标分区已有 cookie）
        let payloadCookies = 0
        try {
          const plain = safeStorage.decryptString(Buffer.from(injectableEncrypted, 'base64'))
          const d = decodeBailianPayload(plain)
          payloadCookies = Array.isArray(d.cookies) ? d.cookies.length : 0
          const before = await collectBailianConsoleCookies(keyId)
          if (payloadCookies > 0) await injectBailianConsoleCookies(keyId, d.cookies!)
          const after = await collectBailianConsoleCookies(keyId)
          console.log(
            `[qf-bailian] OPEN-SITE-INJECT keyId=${keyId} payloadCookies=${payloadCookies} before=${before.length} after=${after.length}`
          )
        } catch (e) {
          console.log(`[qf-bailian] OPEN-SITE-INJECT keyId=${keyId} payloadCookies=${payloadCookies} err=${e instanceof Error ? e.message : String(e)}`)
        }
      } else {
        const parsed = parseStoredCredentials(injectableEncrypted, providerId)
        if (parsed.cookies.length > 0) await injectCookies(providerId, parsed.cookies, keyId)
      }
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
    cookies = parseStoredCredentials(encrypted, providerId).cookies
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
    const parsed = parseStoredCredentials(encrypted, providerId)
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

/**
 * 解码智谱 API Key payload。
 * 兼容两种格式：
 * - 新版：{ v: 1; apiKey: string; consoleJwt?: string | null } JSON 字符串
 * - 旧版：纯 API Key 字符串（非 `{` 开头）
 */
export function decodeZhipuPayload(decrypted: string): { apiKey: string; consoleJwt?: string | null } {
  const trimmed = decrypted.trim()
  if (!trimmed.startsWith('{')) {
    // 旧版纯 API Key 格式
    return { apiKey: trimmed }
  }
  try {
    const parsed = JSON.parse(trimmed) as { v?: number; apiKey?: string; consoleJwt?: string | null }
    const apiKey = parsed.apiKey?.trim() ?? ''
    let consoleJwt = parsed.consoleJwt ?? null
    // decodeURIComponent 兼容被 URL 编码存储的脏值
    if (typeof consoleJwt === 'string' && consoleJwt) {
      try { consoleJwt = decodeURIComponent(consoleJwt) } catch {}
    }
    return { apiKey, consoleJwt }
  } catch {
    // JSON 解析失败，当作纯 API Key
    return { apiKey: trimmed }
  }
}

/**
 * 智谱账号级指纹：优先用控制台会话查询出的 customerId（同一账号多个 API Key 共享），
 * 拿到 customerId 时指纹 = sha256(providerId|"zhipu-account:"+customerId)；
 * 拿不到（未带会话 / 查询失败）时回退按 API Key 明文哈希，不做账号级拦截。
 * payload 为「加密前明文」，可能是 `{v:1,apiKey,consoleJwt}` 或纯 API Key。
 */
async function zhipuAccountFingerprint(payload: string): Promise<string | null> {
  const { apiKey, consoleJwt } = decodeZhipuPayload(payload)
  if (!apiKey) return null
  if (consoleJwt) {
    try {
      const res = await fetchZhipuQuota(apiKey, consoleJwt)
      if (res.ok && res.quota.customerId) {
        return fingerprintFor('zhipu', 'zhipu-account:' + String(res.quota.customerId))
      }
    } catch {
      // 查询失败则回退 API Key 指纹
    }
  }
  return fingerprintFor('zhipu', apiKey)
}

// 智谱控制台会话捕获窗口：打开 bigmodel.cn 控制台，注入拦截器捕获访问令牌（consoleJwt）。
// 智谱控制台前端用 axios/XMLHttpRequest/fetch 调 /api/biz/ 接口，注入脚本需同时 hook 三种方式
// 以读取请求头 Authorization: Bearer <JWT>；仅扫描 localStorage 拿不到有效 JWT（隔离会话里只有 session_id）。
// 用户登录后点击注入条上的「获取 API Key」，主进程轮询取回捕获的令牌并销毁窗口。
const ZHIPU_CONSOLE_URL = 'https://open.bigmodel.cn/apikey/platform'
// 智谱控制台用「按账号隔离的独立分区」（persist:qf-zhipu-console[:keyId]，keyId 见 zhipuConsolePartitionFor）；
// 每次打开前仅清「登录态存储」（cookies/localStorage 等），
// 保留 HTTP 磁盘缓存以加速重复打开（整站是重 SPA，若每次 clearCache 会强制全量重新下载，明显变慢）。
function zhipuConsoleSession(keyId?: string): Electron.Session {
  return session.fromPartition(zhipuConsolePartitionFor(keyId))
}

// 火山方舟控制台会话捕获：与智谱同套路（打开控制台、注入拦截器捕获 Bearer JWT），
// 但分区、URL、注入全局名各自独立，避免与智谱会话互串。
// 火山控制台请求带 AK/SK 签名头与会话 cookie，主进程无法重放；先在捕获窗口页内注入 hook 取回令牌，
// 后续额度探测（方案 §6）在捕获分区页内同源执行。
const VOLC_CONSOLE_URL = 'https://console.volcengine.com/ark/region:cn-beijing/apikey'
// 火山「开通管理→视觉模型」页：免费视频模型额度/开通状态所在页（额度同步抓取用；tab=ComputerVision 为视觉模型分类）
const VOLC_OPEN_MANAGEMENT_URL =
  'https://console.volcengine.com/ark/region:cn-beijing/openManagement?tab=ComputerVision'
const VOLC_CONSOLE_PARTITION = 'persist:qf-volc-console'
/** 火山控制台分区按账号隔离：persist:qf-volc-console[:keyId]，避免多账号串会话 */
function volcConsolePartitionFor(keyId?: string): string {
  return keyId ? `${VOLC_CONSOLE_PARTITION}:${keyId}` : VOLC_CONSOLE_PARTITION
}
function volcEngineConsoleSession(keyId?: string): Electron.Session {
  return session.fromPartition(volcConsolePartitionFor(keyId))
}
/** 火山同步诊断日志（userData/volc-sync.log）：排查静默抓取为何未命中控制台免费模型 */
// 日志只用于排查火山控制台抓取/绑定问题，无须无限累积：超过上限时自动截断，只保留最近一段。
const VOLC_SYNC_LOG_MAX_BYTES = 2 * 1024 * 1024 // 2MB
const VOLC_SYNC_LOG_KEEP_BYTES = 512 * 1024 // 截断后保留尾部 512KB
// 避免每次追加都 stat 开销；距上次裁剪超阈值才检查一次
let volcSyncLastTrimMs = 0
const VOLC_SYNC_TRIM_INTERVAL_MS = 60 * 1000
// SYNC_HB 心跳节流：同步期间每秒探一次，仅在「页面状态变化」（URL/登录/模型数/滚动/行/分页/注入）时才落日志，
// 静止页面不再每秒刷一条大日志；配合上方的 2MB 自动裁剪，避免一次同步堆砌几十条干扰排查。
let volcSyncHbSig = ''
// 接口响应体 / 请求 URL 去抖：轮询中每拍返回同一个 JSON dump，只在内容变化时才写日志，
// 避免每拍重复落一条冗长的 SYNC_MODELBODY/SYNC_RAW/SYNC_RAWURLS（响应体常达 4~6KB）。
let volcSyncModelBodySig = ''
let volcSyncRawBodySig = ''
let volcSyncRawUrlsSig = ''
// ListModelTokenLimit 逐页累积的额度集合去抖：随分页每拍都会带上已累积的 token 集合，
// 集合收敛后重复落一条 SYNC_TOKENS，只在 <模型名:额度> 集合整体变化时才记录。
let volcSyncTokensSig = ''
// SYNC_HB 只记首尾两条：首拍落第一个快照后，后续每拍仅把最新快照更新进 fireh 内存，
// 由同步收尾（done）统一落一条 SYNC_HB_END，避免滚动期间每拍都刷一条。
let volcSyncHbFired = false
let volcSyncHbLast: string | null = null
// 各火山账号额度同步成功时间戳缓存 keyId → Date.now()，供「查看模型」秒开时判断是否可命中缓存跳过 webview 同步
const volcSyncAt = new Map<string, number>()

function logVolcSync(line: string): void {
  // 仅开发模式记录同步诊断日志：发布版本（app.isPackaged）不落盘，避免无谓写盘与同步日志累积
  if (app.isPackaged) return
  const file = join(app.getPath('userData'), 'volc-sync.log')
  try {
    const now = Date.now()
    // 定时裁剪（本地账本自清理）：不超过频率上限，避免每次写入都去 stat 文件
    if (now - volcSyncLastTrimMs >= VOLC_SYNC_TRIM_INTERVAL_MS) {
      volcSyncLastTrimMs = now
      let size = -1
      try {
        size = statSync(file).size
      } catch {
        size = -1 // 文件尚不存在或读取失败，跳过裁剪
      }
      if (size > VOLC_SYNC_LOG_MAX_BYTES) {
        let tail = ''
        const fd = openSync(file, 'r')
        try {
          const pos = Math.max(0, size - VOLC_SYNC_LOG_KEEP_BYTES)
          const buf = Buffer.alloc(size - pos)
          readSync(fd, buf, 0, buf.length, pos)
          tail = buf.toString('utf8')
          // 左裁剪到首个换行之后，避免截断把一行日志劈成两半
          const nl = tail.indexOf('\n')
          if (nl >= 0) tail = tail.slice(nl + 1)
        } finally {
          closeSync(fd)
        }
        truncateSync(file, 0)
        appendFileSync(file, tail)
      }
    }
    appendFileSync(file, `[${new Date().toISOString()}] ${line}\n`)
  } catch {
    // ignore
  }
}
/** 静默续期窗口最多等待时长（毫秒） */
const VOLC_QUIET_RENEW_TIMEOUT_MS = 25000

/** 静默续期窗口最多等待时长（毫秒）；超时仍未捕获到新 JWT，视为控制台登录态已失效 */
const ZHIPU_QUIET_RENEW_TIMEOUT_MS = 25000

/**
 * 从智谱控制台会话 JWT 中解析 `exp`（毫秒）。非标准 JWT / 无 exp / 解析失败返回 null（据此不自动续期）。
 */
function zhipuJwtExpiryMs(consoleJwt?: string | null): number | null {
  if (!consoleJwt) return null
  const m = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(consoleJwt.trim())
  if (!m) return null
  try {
    const b64 = m[2].replace(/-/g, '+').replace(/_/g, '/')
    const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : ''
    const data = JSON.parse(Buffer.from(b64 + pad, 'base64').toString('utf8')) as { exp?: number }
    return typeof data.exp === 'number' ? data.exp * 1000 : null
  } catch {
    return null
  }
}

/** 自动续期触发阈值：距离过期不足该时长时进入「将过期」状态并触发静默续期（默认 10 分钟） */
const ZHIPU_RENEW_THRESHOLD_MS = 10 * 60 * 1000
/** 同一账号连续两次续期尝试的最小间隔（续期失败后节流重试，避免反复开隐藏窗口） */
const ZHIPU_RENEW_MIN_INTERVAL_MS = 5 * 60 * 1000

export type ZhipuConsoleSessionState =
  | { hasSession: false }
  | { hasSession: true; status: 'alive' | 'expiring' | 'expired'; expMs: number | null; remainingMs: number | null }

/** 依据 JWT 的 exp 判定会话状态：无有效 JWT → hasSession=false；有 exp → 按剩余时间分 alive/expiring/expired；解析不出 exp → 默认 alive */
function zhipuConsoleSessionState(consoleJwt?: string | null): ZhipuConsoleSessionState {
  if (!consoleJwt) return { hasSession: false }
  const expMs = zhipuJwtExpiryMs(consoleJwt)
  if (expMs === null) return { hasSession: true, status: 'alive', expMs: null, remainingMs: null }
  const remainingMs = expMs - Date.now()
  const status = remainingMs <= 0 ? 'expired' : remainingMs <= ZHIPU_RENEW_THRESHOLD_MS ? 'expiring' : 'alive'
  return { hasSession: true, status, expMs, remainingMs }
}

/**
 * 智谱控制台会话捕获 / 静默续期。
 * @param opts.quiet 为 true 时作为「静默续期」：隐藏窗口、不显示注入条、保留登录态 cookie，
 *   直接轮询捕获到的新 JWT 并返回（用于 consoleJwt 过期后的自动续期）。缺省为首次绑定交互式捕获。
 */
export async function captureZhipuConsoleSession(opts?: {
  quiet?: boolean
  /** 绑定/续期所属的账号 keyId；用于把控制台登录态隔离到该账号自己的分区，避免多账号串会话 */
  keyId?: string
  /** 静默续期时当前有效的旧 JWT；若捕获到的新 JWT 与之相同，视为登录态未变化，不当作成功续期 */
  oldConsoleJwt?: string | null
}): Promise<{ ok: boolean; consoleJwt?: string; error?: string }> {
  const quiet = !!opts?.quiet
  const optKeyId = opts?.keyId
  const winKey = `${quiet ? 'zhipu-console-quiet' : 'zhipu-console'}:${optKeyId ?? 'shared'}`
  const oldConsoleJwt = opts?.oldConsoleJwt
  const existing = loginWindows.get(winKey)
  if (existing && !existing.isDestroyed()) {
    existing.focus()
    return { ok: false, error: quiet ? '会话续期进行中' : '智谱控制台窗口已打开' }
  }

  // 首次绑定需清空登录态存储避免残留；静默续期必须保留 cookie 以复用已登录会话，跳过清空
  if (!quiet) {
    try {
      await zhipuConsoleSession(optKeyId).clearStorageData()
    } catch {}
  }
  const ses = zhipuConsoleSession(optKeyId)

  const win = new BrowserWindow({
    width: 1024,
    height: 768,
    minWidth: 840,
    minHeight: 620,
    title: '⋮⋮  Quota-Flow · 智谱控制台',
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    // 静默续期窗口不显示，避免打扰用户
    show: !quiet,
    // 生成/控制台窗口统一保留真实渲染，避免默认隐藏窗口显示时白屏闪烁
    paintWhenInitiallyHidden: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      session: ses
    }
  })
  win.webContents.setUserAgent(CHROME_UA)
  loginWindows.set(winKey, win)
  void win.loadURL(ZHIPU_CONSOLE_URL).catch(() => {})

  const INJECT = `(() => {
    if (window.__QUOTA_FLOW_ZHIPU__) return;
    window.__QUOTA_FLOW_ZHIPU__ = true;
    window.__ZF_CAPTURED__ = window.__ZF_CAPTURED__ || null;
    window.__ZF_SUBMIT__ = false;
    const JWT_RE = /(eyJ[A-Za-z0-9_-]{5,}\\.[A-Za-z0-9_-]{5,}\\.[A-Za-z0-9_-]{5,})/;
    const store = (v) => {
      if (typeof v === 'string' && v) {
        const m = v.match(JWT_RE);
        if (m) { window.__ZF_CAPTURED__ = window.__ZF_CAPTURED__ || m[0]; }
      }
    };
    // 1) hook fetch
    const origFetch = window.fetch;
    if (origFetch) {
      window.fetch = function (...args) {
        try {
          const init = args[1] || {};
          const h = init.headers;
          const getAuth = () => {
            try {
              if (h instanceof Headers) return h.get('authorization');
              if (Array.isArray(h)) { const f = h.find((kv) => (kv[0] || '').toLowerCase() === 'authorization'); return f ? f[1] : undefined; }
              if (h && typeof h === 'object') return h['authorization'] || h['Authorization'];
            } catch (_) {}
            return undefined;
          };
          const a = getAuth();
          if (a) { store(String(a).replace(/^Bearer\\s+/i, '')); }
        } catch (_) {}
        return origFetch.apply(this, args);
      };
    }
    // 2) hook XMLHttpRequest.setRequestHeader（axios 底层）
    const origSet = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
      try { if (String(k).toLowerCase() === 'authorization') store(String(v).replace(/^Bearer\\s+/i, '')); } catch (_) {}
      return origSet.apply(this, arguments);
    };
    // 3) 兜底：定时扫描本地存储（部分页面会持久化登录态）
    const scanStorage = () => {
      for (const name of ['localStorage', 'sessionStorage']) {
        try {
          const s = window[name];
          if (!s) continue;
          for (let i = 0; i < s.length; i++) {
            const k = s.key(i);
            if (!k) continue;
            const v = s.getItem(k);
            if (v && typeof v === 'string') store(v);
          }
        } catch (_) {}
      }
    };
    window.__ZF_SCAN__ = setInterval(scanStorage, 1500);
    scanStorage();
    // 4) 可拖拽注入条（左上角；标题栏含 ⋮⋮ 标识，cursor:grab）
    const bar = document.createElement('div');
    bar.id = 'qf-zhipu-bar';
    bar.style.cssText = 'position:fixed;top:12px;left:12px;z-index:2147483647;display:flex;flex-direction:column;gap:6px;padding:8px 12px;border-radius:8px;background:rgba(20,20,22,.92);color:#fff;font:12.5px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.35);user-select:none;max-width:440px;';
    bar.innerHTML =
      '<div id="qf-zhipu-header" style="display:flex;align-items:center;gap:6px;font-weight:600;color:#fff;cursor:grab;font-size:12.5px;">' +
      '<span id="qf-zhipu-grip" style="color:#9aa0a6;letter-spacing:1px;font-size:13px;">⋮⋮</span>' +
      '<span>Quota-Flow · 智谱控制台</span>' +
      '</div>' +
      '<div style="display:flex;align-items:center;gap:8px;">' +
      '<span style="flex:1;min-width:0;color:#c4c8d0;font-size:12px;line-height:1.4;">请在页面完成智谱控制台登录；登录后在「API Key 管理」页复制 API Key，然后点击下方按钮返回</span>' +
      '<button id="qf-zhipu-get" style="flex-shrink:0;padding:5px 12px;border:0;border-radius:6px;background:#2ea56f;color:#fff;font:600 12px/1 inherit;cursor:pointer;white-space:nowrap;">已获取key返回</button>' +
      '</div>';
    document.body.appendChild(bar);
    document.getElementById('qf-zhipu-get').addEventListener('click', () => {
      scanStorage();
      window.__ZF_SUBMIT__ = true;
      window.__ZF_STATE__ = window.__ZF_CAPTURED__ ? 'ok' : 'none';
    });
    // 拖拽：按下 grip 或标题栏拖动，实时更新位置并夹紧窗口边界
    let dragging = false, offX = 0, offY = 0;
    const grip = document.getElementById('qf-zhipu-grip');
    const header = document.getElementById('qf-zhipu-header');
    const barEl = document.getElementById('qf-zhipu-bar');
    const startDrag = (e) => {
      dragging = true; offX = e.clientX - barEl.offsetLeft; offY = e.clientY - barEl.offsetTop;
      barEl.style.cursor = 'grabbing';
      e.preventDefault();
    };
    if (grip) grip.addEventListener('mousedown', startDrag);
    if (header) header.addEventListener('mousedown', startDrag);
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const x = Math.max(4, Math.min(window.innerWidth - barEl.offsetWidth - 4, e.clientX - offX));
      const y = Math.max(4, Math.min(window.innerHeight - barEl.offsetHeight - 4, e.clientY - offY));
      barEl.style.left = x + 'px'; barEl.style.top = y + 'px';
    });
    document.addEventListener('mouseup', () => { dragging = false; barEl.style.cursor = 'grab'; });
  })()`

  const inject = (): void => {
    void win.webContents.executeJavaScript(INJECT).catch(() => {})
  }
  win.webContents.on('did-finish-load', () => {
    // 延迟注入，避免与控制台自身早期脚本竞争
    setTimeout(inject, 500)
  })

  return new Promise((resolve) => {
    let finished = false
    let renewTimeout: NodeJS.Timeout | null = null
    const done = (result: { ok: boolean; consoleJwt?: string; error?: string }): void => {
      if (finished) return
      finished = true
      clearInterval(pollTimer)
      if (renewTimeout) clearTimeout(renewTimeout)
      if (!win.isDestroyed()) win.destroy()
      loginWindows.delete(winKey)
      resolve(result)
    }
    win.on('closed', () => {
      clearInterval(pollTimer)
      if (renewTimeout) clearTimeout(renewTimeout)
      try {
        void win.webContents
          .executeJavaScript('clearInterval(window.__ZF_SCAN__)')
          .catch(() => {})
      } catch {}
      if (loginWindows.get(winKey) === win) loginWindows.delete(winKey)
      if (!finished) {
        finished = true
        resolve({ ok: false, error: '窗口已关闭' })
      }
    })

    // 静默续期：若超时仍未捕获到新 JWT，判定控制台登录态已失效（可能需要用户重新登录）
    if (quiet) {
      renewTimeout = setTimeout(() => {
        done({ ok: false, error: '静默续期超时：控制台登录态可能已失效，请在厂商页手动刷新账号' })
      }, ZHIPU_QUIET_RENEW_TIMEOUT_MS)
    }

    // 轮询注入条按钮：交互式点击后按捕获情况返回；静默式直接自动取捕获到的新 JWT
    const pollTimer = setInterval(() => {
      if (win.isDestroyed()) return
      if (quiet) {
        void win.webContents
          .executeJavaScript('window.__ZF_CAPTURED__ || null')
          .then((jwt: unknown) => {
            if (typeof jwt !== 'string' || !jwt) return
            // 与当前旧 JWT 相同 → 登录态未更新，继续等待页面刷新出真正的新令牌
            if (oldConsoleJwt && jwt === oldConsoleJwt.trim()) return
            done({ ok: true, consoleJwt: jwt })
          })
          .catch(() => {})
        return
      }
      void win.webContents
        .executeJavaScript('window.__ZF_SUBMIT__ ? [window.__ZF_STATE__, window.__ZF_CAPTURED__] : null')
        .then((val: unknown) => {
          if (!val) return
          const [state, jwt] = val as [string, string | null]
          if (state !== 'ok' || !jwt) {
            done({ ok: false, error: '未在页面捕获到会话令牌，请确认已登录智谱控制台后重试' })
            return
          }
          done({ ok: true, consoleJwt: jwt })
        })
        .catch(() => {})
    }, 700)
  })
}

/**
 * 火山方舟控制台会话捕获 / 静默续期（与智谱 captureZhipuConsoleSession 同套路，独立分区/URL/全局名）。
 * @param opts.quiet true: 隐藏窗口静默重捕获（续期用，保留登录态 cookie）；缺省: 首次绑定交互式捕获。
 */
export async function captureVolcEngineConsoleSession(opts?: {
  quiet?: boolean
  keyId?: string
  oldConsoleJwt?: string | null
  /** 会话窗口初始加载的 URL；缺省为 API Key 管理页。传开通管理页可静默抓取最新免费额度（sync） */
  targetUrl?: string
  /** true 表示「额度同步」模式：静默轮询时同时读取 __VF_MODELS__ 并返回最新 models；缺省为仅绑定/续期的会话捕获 */
  syncModels?: boolean
}): Promise<{ ok: boolean; consoleJwt?: string; accountId?: string; models?: VolcengineFreeVideoModel[]; source?: 'console' | 'fallback'; error?: string }> {
  const quiet = !!opts?.quiet
  const syncModels = !!opts?.syncModels
  const optKeyId = opts?.keyId
  const winKey = `${quiet ? 'volc-console-quiet' : 'volc-console'}:${optKeyId ?? 'shared'}`
  const oldConsoleJwt = opts?.oldConsoleJwt
  const existing = loginWindows.get(winKey)
  if (existing && !existing.isDestroyed()) {
    existing.focus()
    return { ok: false, error: quiet ? '会话续期进行中' : '火山方舟控制台窗口已打开' }
  }

  // 首次绑定需清空登录态存储避免残留；静默续期必须保留 cookie
  if (!quiet) {
    try {
      await volcEngineConsoleSession(optKeyId).clearStorageData()
    } catch {}
  }
  const ses = volcEngineConsoleSession(optKeyId)

  const win = new BrowserWindow({
    width: 1120,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: !quiet,
    paintWhenInitiallyHidden: true,
    autoHideMenuBar: true,
    title: quiet ? '火山方舟控制台 - Quota-Flow' : 'Quota-Flow · 火山方舟控制台',
    backgroundColor: '#ffffff',
    webPreferences: {
      partition: volcConsolePartitionFor(optKeyId),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  ses.setUserAgent(CHROME_UA)
  win.webContents.setUserAgent(CHROME_UA)
  // 拦截非 http(s) 协议跳转（如 bytedance:// 深链），避免触发 Windows 系统级「获取打开此链接的应用」弹窗。
  // 火山控制台第三方登录（抖音/头条/穿山甲等）才会走这类深链，绑定流程推荐使用手机号/账号登录，完全走 http(s)。
  const BLOCKED_PROTO_RE = /^(?!https?:)[a-z][a-z0-9+.-]*:/i
  win.webContents.on('will-navigate', (ev, url) => {
    if (BLOCKED_PROTO_RE.test(url)) {
      ev.preventDefault()
      void win.webContents
        .executeJavaScript(
          `(function(){try{window.__VF_BLOCKED=window.__VF_BLOCKED||[];window.__VF_BLOCKED.push(${JSON.stringify(url)});}catch(_){}})()`
        )
        .catch(() => {})
    }
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (BLOCKED_PROTO_RE.test(url)) return { action: 'deny' }
    return { action: 'allow' }
  })
  loginWindows.set(winKey, win)
  void win.loadURL(opts?.targetUrl || VOLC_CONSOLE_URL).catch(() => {})

  const INJECT = `(() => {
    if (window.__QUOTA_FLOW_VOLC__) return;
    window.__QUOTA_FLOW_VOLC__ = true;
    window.__VF_CAPTURED__ = window.__VF_CAPTURED__ || null;
    window.__VF_ACCOUNT__ = window.__VF_ACCOUNT__ || null;
    // —— 真实账号标识（去重首选）——
    // 火山控制台把「当前登录账号」存在会话 localStorage（如 SLARDARmlmaas_volcconsole / SLARDARvolc_console），
    // 值可能是 base64（URL 编码）或纯 JSON，含 userId 形如 "2112155528_0"（「账号_子账号」），账号唯一且专属于当前登录。
    // 相比从接口响应里扫 accountId（可能命中跨账号共享的静态值，如两次绑到同一 2100466578），用它做去重最可靠，
    // 且能保留「同一火山账号多把 API Key 自动去重」的诉求。
    const extractRealUserid = () => {
      try {
        // 注：本段注入代码位于模板字符串 INJECT 内，正则里的 \d/\s 必须以 \\d/\\s 转义，
        // 否则模板字面量会把它降级成字面量字符，导致正则在页面端完全失效（表现为 REAL=null）。
        const uidRe = /^(?:(\\d{4,20})(?:_\\d+)?)$/;
        const dig = (u) => { if (typeof u !== 'string') return null; const m = uidRe.exec(u.trim()); return m ? m[1] : null; };
        // 火山会话值是 urlsafe base64（可能含 - / _，无 padding），atob 前需换算为标准字符集。
        const decodeB64 = (s) => {
          const t = s.replace(/-/g, '+').replace(/_/g, '/');
          const pad = t.length % 4 ? '='.repeat(4 - (t.length % 4)) : '';
          try { return atob(t + pad); } catch (_) { return null; }
        };
        const decode = (s) => {
          if (typeof s !== 'string' || !s) return s;
          // base64/urlsafe-base64；火山会话值常为该形态，atob 后有 %7B 这类 URL 编码，先解码再 URL 解码。
          if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(s)) {
            const d = decodeB64(s);
            if (d !== null) {
              try { return decodeURIComponent(d); } catch (_) { return d; }
            }
          }
          return s;
        };
        // 权威来源：火山主登录会话 key。只认这一个 key 的 userId/UserID/user_id 字段，
        // 避免遍历「所有 console/volc 相关 key 取首个数字」时误抓到无关 token/accountId（如 377810）。
        const AUTH_KEYS = ['SLARDARmlmaas_volcconsole', 'SLARDARvolc_console'];
        const AUTH_FIELDS = ['userId', 'UserID', 'user_id'];
        const read = (k) => { try { return window.localStorage.getItem(k); } catch (_) { return null; } };
        for (const ak of AUTH_KEYS) {
          const raw = read(ak);
          if (!raw) continue;
          const s = decode(raw);
          try {
            const j = JSON.parse(s);
            for (const f of AUTH_FIELDS) {
              const d = dig(j[f]);
              if (d) return d;
            }
          } catch (_) {}
          // 兜底：正则从解码串里找 userId 形如 "2112155528_0" / "2112155528"
          const m = /"userId"\\s*:\\s*"?((\\d{4,20})(?:_\\d+)?)?"?/i.exec(s);
          if (m) return m[1];
        }
        // 次权威：key 名自带账号 id 的来源：CONSOLE_RECENT_VISIT_<中间_数字_>userId（形如 ..._2112155528 尾段），
        // 账号 id 是 4~12 位（时间戳为 13 位毫秒），取最后一个符合位数的尾段。
        for (let i = 0; i < window.localStorage.length; i++) {
          const k = window.localStorage.key(i) || '';
          if (!/^CONSOLE_RECENT_VISIT_/i.test(k)) continue;
          const kparts = k.split('_');
          const lastSeg = kparts[kparts.length - 1];
          if (/^\\d{4,12}$/.test(lastSeg)) return lastSeg;
        }
      } catch (_) {}
      return null;
    };
    const realUidResolve = () => { const r = extractRealUserid(); if (r) window.__VF_REAL_UID__ = r; return r || null; };
    window.__VF_REAL_UID__ = null;
    // 账号标识写入 + 落 localStorage：volc 控制台从「开通管理」切到「API Key 管理」是整页跳转(非 SPA)，
    // 页面全局 __VF_ACCOUNT__ 会被清空；持久化到同源 localStorage(按分区隔离)后，任何一次整页加载都能恢复。
    const persistAccount = (id) => {
      // 真实 userId 一旦可解析即为权威：优先写它；仅当解析不到（可能登录晚于注入）才用接口扫到的
      // 临时/共享值（如 2100466578）兜底，但绝不因上次已写入 shared 而阻止后续用 real 覆盖。
      const real = window.__VF_REAL_UID__ || realUidResolve();
      const target = real || id;
      if (!target) return;
      try { window.__VF_ACCOUNT__ = target; window.localStorage.setItem('qf:volc:account', String(target)); } catch (_) {}
    };
    if (realUidResolve()) {
      persistAccount(window.__VF_REAL_UID__);
    } else {
      try { const _a = window.localStorage.getItem('qf:volc:account'); if (_a && !window.__VF_ACCOUNT__) window.__VF_ACCOUNT__ = _a; } catch (_) {}
    }
    window.__VF_SUBMIT__ = false;
    const JWT_RE = /(eyJ[A-Za-z0-9_-]{5,}\\.[A-Za-z0-9_-]{5,}\\.[A-Za-z0-9_-]{5,})/;
    const store = (v) => {
      if (typeof v === 'string' && v) {
        const m = v.match(JWT_RE);
        if (m) { window.__VF_CAPTURED__ = window.__VF_CAPTURED__ || m[0]; }
      }
    };
    // 额度接口探测（方案 §6）：记录火山相关的 fetch/XHR 请求，便于运行期实抓额度接口
    const isProbeUrl = (u) => u && /ark|openmanagement|quota|resource|package|project|apikey|account|user/i.test(u);
    const probeLog = (method, u) => {
      try { if (isProbeUrl(u)) console.log('[volc-console] ' + method + ' ' + String(u).slice(0, 300)); } catch (_) {}
    };
    // 账号标识探测（去重）：从控制台接口响应体里找稳定账号 id（uid/account_id/user_id 等），
    // 同一火山账号的多个 API Key 共享同一账户，据此做账号级指纹去重。抓不到则回退 API Key 哈希。
    const ACCOUNT_KEY_RE = /["']?(?:uid|userId|user_id|accountId|account_id|loginname|login_name|customer_id)["']?\\s*[:=]\\s*["']?(\\d{6,20})/i;
    // 火山方舟账户 id 最可靠的真实载体是开通管理页资源的存储桶名：ark-auto-{accountId}-cn-beijing-default。
    // （如 ListModelChargeItems 响应 FeaturedImage.BucketName = "ark-auto-2100466578-cn-..."）
    // 这比 whitelist 里偶发的 JSON 字段（含 bot 预设模板静态 AccountId）更专属于「当前登录账号」，用于去重更稳。
    const BUCKET_ACCOUNT_RE = /ark-(?:auto-)?(\\d{6,20})-cn-/i;
    const extractAccount = (text) => {
      if (typeof text !== 'string' || !text || window.__VF_ACCOUNT__) return;
      // 优先「存储桶名」来源（ark-auto-{accountId}-cn-...，每个火山账号唯一），再回退通用 whitelist 字段。
      // 通用字段可能命中 bot 预设模板里的静态 AccountId（跨账号相同），若被它抢先会把不同账号误识别成同一账号。
      const m = text.match(BUCKET_ACCOUNT_RE) || text.match(ACCOUNT_KEY_RE);
      if (m && m[1]) persistAccount(m[1]);
    };
    // 开通管理页模型接口：网上承载「freeQuota / quota / activated / modelId」的响应体
    // 直接解析出模型列表并入 window.__VF_MODELS_RAW__，避免依赖分页 DOM（wan 在第二页）。
    window.__VF_MODELS_RAW__ = window.__VF_MODELS_RAW__ || [];
    window.__VF_SAVED_RAW__ = window.__VF_SAVED_RAW__ || null;
    const isModelJson = (text) => {
      if (typeof text !== 'string' || text.length < 40) return false;
      // 优先按「真实模型 id 内容」命中：模型列表/额度接口的响应体必然包含具体模型标识
      // （wan2-1-14b、doubao-seedance-1-0-pro 等）。这比按 quota 字段名更可靠——火山接口
      // 字段命名多变，但模型 id / 名称字符串是稳定的。
      if (/wan2\s*-?\s*1\s*-?\s*14b|wan2-1-14b/i.test(text)) return true;
      if (/doubao-seedance\s*-?\s*1-0-pro|doubao-seedance-1-0-pro/i.test(text)) return true;
      if (/doubao-seedance/i.test(text) && /quota|token|额度|剩|免费/i.test(text)) return true;
      if (/wan\s*-\s*1-14b|wan-1-14b/i.test(text)) return true;
      // 兜底：仍是额度+模型名双条件
      return (/freeQuota|free_quota|quota|token|额度/.test(text)) &&
             (/wan|seedance|doubao|deepseek|模型|Model/i.test(text));
    };
    // 接口级模型额度捕获（正解）：直接解析火山开通管理页的 ListModelTokenLimit / ListModelRateLimit
    // 响应体，拿到每个模型的真实免费额度与开通状态，彻底摆脱分页 DOM。响应可能分多次（翻页）返回，
    // 这里按模型名累积合并，用窗口变量暴露给主进程回传。
    window.__VF_TOKEN_LIMITS__ = window.__VF_TOKEN_LIMITS__ || {}; // modelName -> { tokenLimit, currentUsage }
    window.__VF_HAS_RATE__ = window.__VF_HAS_RATE__ || false;      // 是否抓到模型全量列表
    const ingestInterface = (url, text) => {
      try {
        if (typeof text !== 'string' || text.length < 30) return;
        const j = JSON.parse(text);
        const action = j && j.ResponseMetadata && j.ResponseMetadata.Action;
        const res = j && j.Result;
        if (action === 'ListModelTokenLimit' && res && Array.isArray(res.ModelTokenLimits)) {
          for (const it of res.ModelTokenLimits) {
            if (!it || typeof it.FoundationModelName !== 'string') continue;
            const n = it.FoundationModelName.trim();
            const tok = Number(it.TokenLimit) || 0;
            window.__VF_TOKEN_LIMITS__[n] = { tokenLimit: tok, currentUsage: Number(it.CurrentUsage) || 0 };
          }
        } else if (action === 'ListModelRateLimit' && res && Array.isArray(res.Items)) {
          window.__VF_HAS_RATE__ = true;
        } else if (action === 'ListModelChargeItems') {
          // 账号标识权威源：开通管理页模型列表的 FeaturedImage.BucketName 形如 ark-auto-{accountId}-cn-beijing-default，
          // 这是「当前登录账号」的专有 id，比 bot 预设模板的静态 AccountId 可靠，拿来回填账号级指纹去重键。
          const bm = (text).match(/ark-(?:auto-)?(\\d{6,20})-cn-/i);
          if (bm && bm[1]) persistAccount(bm[1]);
        }
      } catch (_) {}
    };
    const tryParseModels = (url, text) => {
      try {
        const isModel = isModelJson(text);
        if (!isModel) return;
        const decis = /wan2\s*-?\s*1\s*-?\s*14b|doubao-seedance|wan-1-14b/i.test(text);
        if (decis || !window.__VF_MODEL_BODY__ || text.length > window.__VF_MODEL_BODY__.length) {
          const capped = text.length > 20000 ? text.slice(0, 20000) : text;
          window.__VF_MODEL_BODY__ = capped;
        }
        const rec = { t: Date.now(), url: String(url || '').slice(0, 300), body: text.slice(0, 8000) };
        window.__VF_MODELS_RAW__.push(rec);
        if (window.__VF_MODELS_RAW__.length > 60) window.__VF_MODELS_RAW__.shift();
        if (!window.__VF_SAVED_RAW__ || text.length > window.__VF_SAVED_RAW__.length) window.__VF_SAVED_RAW__ = text;
      } catch (_) {}
    };
    const feedModels = (url, text) => { try { if (typeof text === 'string') tryParseModels(url, text); } catch (_) {} };
    // 1) hook fetch
    const origFetch = window.fetch;
    if (origFetch) {
      window.fetch = function (...args) {
        try {
          const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
          probeLog('fetch', url);
          const init = args[1] || {};
          const h = init.headers;
          const getAuth = () => {
            try {
              if (h instanceof Headers) return h.get('authorization');
              if (Array.isArray(h)) { const f = h.find((kv) => (kv[0] || '').toLowerCase() === 'authorization'); return f ? f[1] : undefined; }
              if (h && typeof h === 'object') return h['authorization'] || h['Authorization'];
            } catch (_) {}
            return undefined;
          };
          const a = getAuth();
          if (a) { store(String(a).replace(/^Bearer\\s+/i, '')); }
        } catch (_) {}
        const p = origFetch.apply(this, args);
        try {
          p.then((resp) => {
            try { resp.clone().text().then((txt) => { extractAccount(txt); feedModels(url, txt); ingestInterface(url, txt); }); } catch (_) {}
          }).catch(() => {});
        } catch (_) {}
        return p;
      };
    }
    // 2) hook XMLHttpRequest（axios 底层）
    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (m, u, ...rest) {
      try { window.__VF_XHR__ = { method: m, url: u }; } catch (_) {}
      return origOpen.apply(this, [m, u, ...rest]);
    };
    const origSet = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
      try { if (String(k).toLowerCase() === 'authorization') store(String(v).replace(/^Bearer\\s+/i, '')); } catch (_) {}
      return origSet.apply(this, arguments);
    };
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (...rest) {
      try {
        if (window.__VF_XHR__) {
          const probeUrl = String(window.__VF_XHR__.url || '');
          probeLog(window.__VF_XHR__.method, probeUrl);
        }
        if (typeof this.responseText !== 'undefined' && window.__VF_XHR__) {
          const self = this;
          const xUrl = String(window.__VF_XHR__.url || '');
          try { this.addEventListener('load', function () { try { const t = self.responseText || ''; extractAccount(t); feedModels(xUrl, t); ingestInterface(xUrl, t); } catch (_) {} }); } catch (_) {}
        }
      } catch (_) {}
      return origSend.apply(this, rest);
    };
    // 3) 兜底：定时扫描本地存储
    const scanStorage = () => {
      for (const name of ['localStorage', 'sessionStorage']) {
        try {
          const s = window[name];
          if (!s) continue;
          for (let i = 0; i < s.length; i++) {
            const k = s.key(i);
            if (!k) continue;
            const v = s.getItem(k);
            if (v && typeof v === 'string') { store(v); extractAccount(v); }
          }
        } catch (_) {}
      }
      // 账号标识还常以 query 形式出现在登录/管理页 URL（如 ?accountId=2100000825）
      try { extractAccount(location.href); } catch (_) {}
    };
    window.__VF_SCAN__ = setInterval(scanStorage, 1500);
    scanStorage();
    // 3.5) 「绑定即抓模型」：扫描「开通管理→视觉模型」页 DOM，识别带免费推理额度文案的模型。
    //      门禁是「有免费额度 + 开通状态」而非模型名前缀：页面同屏还混有图像（Seedream）与 3D
    //      （Seed3D/Hyper3D/Hitem3D）模型且它们也有免费额度，故抓取层只负责如实上报「卡片名 + 额度 +
    //      是否已开通」，是否属于「视频生成模型」由 providers 权威层按视频家族过滤（不依赖前缀）。
    window.__VF_MODELS__ = window.__VF_MODELS__ || [];
    // 「开通管理→视觉模型」卡片文本 =「模型名 + 未开通/已开通 + 厂商 + 免费推理额度 剩x / 共y token + 开通/退订」。
    // 免费额度文本格式实测为「剩 x / 共 y token」（含剩/共前缀）；没有任何 free token 的模型（如 2.x 系列）不收录。
    const volcQuotaRe = /(?:剩|剩余)\\s*([\\d,]+)\\s*\\/\\s*共?\\s*([\\d,]+)\\s*(?:token|Token|Tokens)?/i;
    const volcStatusRe = /已开通|未开通|尚未开通|待开通|去开通/i;
    const volcHasFreeRe = /免费推理额度|免费额度|剩\\s*[\\d,]+\\s*\\/\\s*共/i;
    const scrapeFreeModels = () => {
      try {
        if (window.__VF_MODELS__.length >= 40) return; // 上限防抖（含图像/3D，宽收集后由类型层过滤）
        const els = document.querySelectorAll('body *');
        for (let i = 0; i < els.length; i++) {
          const el = els[i];
          const own = (el.textContent || '').replace(/\s+/g, ' ').trim();
          // 护栏：去掉整段聚合容器（含多张卡片的整页/整块列表节点，own 文本很长）——它不是单张卡片，
          //       进行下去会把其它卡片的免费额度文本当作本模型的额度，导致无免费额度的模型被误判成有。与模型名/版本无关。
          if (own.length > 200) continue;
          // 仅当该元素自带「开通状态」时视其为卡片信息承载层（避免对整页祖先重复处理）
          const stM = own.match(volcStatusRe);
          if (!stM) continue;
          // 以卡片自身的状态文案判定是否已开通：未开通/尚未开通/待开通/去开通 → false；其余（已开通）→ true。
          // 不能在祖先层探测不到「未开通」时留 undefined，否则合并层会沿用内置默认值，新开通模型永远停在「待开通」。
          const isPendingStatus = /未开通|尚未开通|待开通|去开通/.test(stM[0] || '');
          const name = own.slice(0, stM.index).trim().split(/\\s+/)[0] || '';
          if (!name) continue;
          // 该模型名是否为深描的别扭前段（多个合成词被拆出的残片，如只剩厂商名）——以非模型词作护栏，遇中文/纯厂商名时跳过
          if (/[\\u4e00-\\u9fa5]/.test(name)) continue;
          if (window.__VF_MODELS__.some((m) => m.name === name)) continue;
          // 沿祖先向上寻找该模型的“卡片”：就近取首个同时含额度/开通状态信息的容器
          let container = el;
          let quota = null, notActivated = false, hasFree = false;
          for (let depth = 0; container && depth < 8; container = container.parentElement, depth++) {
            const t = (container.textContent || '').replace(/\\s+/g, ' ').trim();
            const q = t.match(volcQuotaRe);
            const na = /未开通|尚未开通|待开通|去开通/i.test(t);
            if (q) quota = q;
            if (volcHasFreeRe.test(t)) hasFree = true;
            if (na) notActivated = true;
            if (q || na) break; // 就近取实时信息层（继续向上会泛化到整页）
          }
          // 门禁：有免费推理额度才收录（无 free token 的模型如 2.x 系列不混入）
          if (!quota || !hasFree) continue;
          window.__VF_MODELS__.push({
            name,
            remaining: Number(quota[1].replace(/,/g, '')),
            total: Number(quota[2].replace(/,/g, '')),
            activated: isPendingStatus ? false : true
          });
        }
      } catch (_) {}
    };
    // 定期扫描卡片 + 表格行（新 UI 表格行无「剩/共 token」额度也可用开通状态识别；回调延迟执行无 TDZ 问题）
    window.__VF_SCAN2__ = setInterval(function () { scrapeFreeModels(); scrapeTableRows(); }, 2000);
    scrapeFreeModels();
    // 改版后开通管理页为「表格」布局（列：模型名/提供方、状态、免费推理额度、在线推理定价…）。
    // 表格逐屏虚拟渲染，Wan/Seedance-1.0 等有额度模型常在列表深处：新增面向表格行的抓取，
    // 采用「逐屏渐进滚动 + 每屏解析 [role=row]」：滚动到一屏就收录该屏有免费额度的行，再继续下一屏，
    // 不直接跳到底（跳底会漏掉中间所有已刻录屏），保证 wan/lite/seedance1.0 全部收录。
    const scrapeTableRows = () => {
      try {
        if (window.__VF_MODELS__.length >= 40) return;
        const rows = document.querySelectorAll('[role=row], table tr');
        for (let i = 0; i < rows.length; i++) {
          const el = rows[i];
          const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
          // 表头行（无模型名且多为中文列名），跳过
          if (!t || t.length > 400 || /^模型名|^提供方|^状态$/.test(t)) continue;
          const q = t.match(volcQuotaRe);
          // 新 UI 行不再显示「剩 x /共 y token」，改用「安心体验/并发数/RPM」。额度匹配降级为可选：
          // 行内含 开通状态（已开通/未开通/…）即视为模型行，额度有则带、无则留空由 ListModelTokenLimit 接口补齐。
          const stM = t.match(/已开通|未开通|尚未开通|待开通|去开通/);
          if (!q && !stM) continue;
          // 取自提供方(中文)前的连续模型名 token：行首第一个无中文的连续串即模型名。
          // 表格行常把模型名连写重复多次（如 Doubao-Seedance-1.5-pro …×3 且无空格），取最小重复周期去重。
          const nm = t.match(/^[A-Za-z][A-Za-z0-9._-]*/);
          let name = nm ? nm[0] : '';
          if (name) {
            const dup = name.match(/^(.+?)\\1+$/);
            if (dup && dup[1].length > 1) name = dup[1];
          }
          if (!name || /[\\u4e00-\\u9fa5]/.test(name)) continue;
          // 开通状态：行文本含「未开通/待开通/去开通」→ 未开通；否则视为已开通
          const notActivated = /未开通|尚未开通|待开通|去开通/i.test(t);
          if (window.__VF_MODELS__.some((m) => m.name === name)) continue;
          const rec = { name, activated: notActivated ? false : true };
          if (q) {
            rec.remaining = Number(q[1].replace(/,/g, ''));
            rec.total = Number(q[2].replace(/,/g, ''));
          }
          window.__VF_MODELS__.push(rec);
        }
      } catch (_) {}
    };
    scrapeTableRows();
    let vfScreenIdx = 0;
    // 额度同步模式：逐屏渐进滚动所有可滚动容器，一屏一屏往下，滚动一屏就解析该屏表格行。
    // 每次滚一屏而非直接到底，避免跳底导致中间屏幕的模型行未渲染而漏收。
    if (${syncModels ? 'true' : 'false'}) {
      // 接口级额度同步：开通管理页视觉模型表是 Arco 分页（每页 10 条），wan 等免费模型在第二/末页。
      // 真正额度在 ListModelTokenLimit 接口（分页返回），翻到哪页才请求哪页。故这里自动点「下一页」，
      // 触发后续页面的额度接口请求，由 ingestInterface 累积到 window.__VF_TOKEN_LIMITS__。
      // 点击按钮本身可能触发滑动/滚动，这里每轮点一次下一页（或用滚动作为兜底），点到无法前进即停。
      window.__VF_AUTOSCROLL__ = setInterval(function () {
        try {
          // 1) Arco 分页「下一页」：定位分页容器 → 记录当前页码与 next 按钮；多事件派发高仿真点击触发翻页。
          var nextBtn = null;
          var pages = document.querySelectorAll('[class*="arco-pagination"],[class*="pagination"]');
          for (var pi = 0; pi < pages.length && !nextBtn; pi++) {
            var pitms = pages[pi].querySelectorAll('[class*="pagination-item"],[class*="pagination-list"] li');
            for (var pj = 0; pj < pitms.length; pj++) {
              var pel = pitms[pj];
              var pc = String(pel.className || '');
              var ptx = (pel.getAttribute('title') || '') + ' ' + (pel.getAttribute('aria-label') || '') + ' ' + (pel.textContent || '').replace(/\\s+/g, '');
              // 当前页：class 含 current 或 active（兼容 -current / -active 两种命名），文本解析成页码
              if (/pagination-item-(current|active)/.test(pc)) {
                var pm = /(\\d+)/.exec((pel.textContent || '').trim());
                if (pm && pm[1] !== String(window.__VF_PAGE__ || '')) window.__VF_PAGE__ = parseInt(pm[1], 10);
              }
              // next：class 含 next，或 title/aria/文本命中「下一页」
              if (/next/i.test(pc) || /下一页|下一頁|next/i.test(ptx)) nextBtn = pel;
            }
          }
          var hasMore = !!nextBtn && !/disabled|disabled/i.test(String(nextBtn.className || ''));
          window.__VF_HASMORE__ = hasMore;
          // 探针：在页面记录 next 按钮识别与翻页尝试，供主进程日志诊断（重复信息不刷屏）
          var trace = window.__VF_PAGEDEBUG__ || [];
          var nxInfo = nextBtn ? String(nextBtn.className || '').slice(0, 80) : 'none';
          if (trace.length < 8 && (window.__VF_NX_LAST__ || '') !== nxInfo) {
            trace.push('next[' + nxInfo + '] more=' + hasMore + ' pg=' + (window.__VF_PAGE__ || 0));
            window.__VF_PAGEDEBUG__ = trace;
            window.__VF_NX_LAST__ = nxInfo;
          }
          // 限速翻页：少隔 2.8s 才翻一次，避免连翻导致中间页额度接口被 abort（wan 在第二页，须等上页接口返回）
          var npg = Date.now();
          if (hasMore && (window.__VF_LASTPAGE_AT__ || 0) < npg - 2800) {
            try {
              nextBtn.scrollIntoView({ block: 'center' });
              var tgt = nextBtn;
              var inner = nextBtn.querySelector('[class*="icon"],a,button,span,[class*="next"]');
              if (inner) tgt = inner;
              ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'touchend'].forEach(function (ev) {
                tgt.dispatchEvent(new (window.MouseEvent || window.Event)(ev, { bubbles: true, cancelable: true, view: window, detail: 1 }));
              });
              if (tgt.click) tgt.click();
              window.__VF_LASTPAGE_AT__ = npg;
              window.__VF_CLICKNEXT__ = true;
            } catch (_) {}
          }
          // 2) 兜底：仍滚动可滚动容器（兼容虚拟列表/非分页视图）
          const scrollers = Array.from(document.querySelectorAll('*')).filter(function (el) {
            return el.scrollHeight > el.clientHeight + 20;
          });
          for (const s of scrollers) {
            const step = Math.max(s.clientHeight * 0.9, 120);
            s.scrollTop = Math.min(s.scrollHeight, (s.scrollTop || 0) + step);
            vfScreenIdx++;
          }
          window.__VF_SCREEN__ = vfScreenIdx;
          // 3) 每轮都重新抓 DOM 行/卡片（兜底），以及同步一次接口状态变量
          scrapeTableRows();
          scrapeFreeModels();
          window.__VF_INTERFACE_COUNT__ =
            Object.keys(window.__VF_TOKEN_LIMITS__).length + (window.__VF_HAS_RATE__ ? 1 : 0);
        } catch (_) {}
      }, 900);
    }
    // 4) 可拖拽注入条（仅交互式首次绑定显示）
    if (${quiet ? 'false' : 'true'}) {
      const bar = document.createElement('div');
      bar.id = 'qf-volc-bar';
      bar.style.cssText = 'position:fixed;top:12px;left:12px;z-index:2147483647;display:flex;flex-direction:column;gap:6px;padding:8px 12px;border-radius:8px;background:rgba(20,20,22,.92);color:#fff;font:12.5px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.35);user-select:none;max-width:440px;';
      bar.innerHTML =
        '<div id="qf-volc-header" style="display:flex;align-items:center;gap:6px;font-weight:600;color:#fff;cursor:grab;font-size:12.5px;">' +
        '<span id="qf-volc-grip" style="color:#9aa0a6;letter-spacing:1px;font-size:13px;">⋮⋮</span>' +
        '<span>Quota-Flow · 火山方舟控制台</span>' +
        '</div>' +
        '<div style="color:#c9cdd4;font-size:12px;">请使用「手机号登录/账号登录」，进入「API Key 管理」复制 Key 后点击下方按钮即可（第三方登录已拦截，需在外部浏览器完成）</div>' +
        '<button id="qf-volc-done" style="margin-top:2px;border:none;border-radius:6px;background:#22c55e;color:#fff;font:600 12.5px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:7px 12px;cursor:pointer;align-self:flex-start;">已获取 key 返回</button>';
      document.body.appendChild(bar);
      bar.querySelector('#qf-volc-done').addEventListener('click', () => {
        let diag = '';
        try {
          // 诊断：webview 里权威 key 是否存在、解码结果、real 解析结果（定位为何取不到真实 userId）
          const db2 = (s) => { const t = s.replace(/-/g, '+').replace(/_/g, '/'); const pad = t.length % 4 ? '='.repeat(4 - (t.length % 4)) : ''; try { return atob(t + pad); } catch (_) { return null; } };
          const dc2 = (s) => { if (typeof s !== 'string' || !s) return s; if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(s)) { const d = db2(s); if (d !== null) { try { return decodeURIComponent(d); } catch (_) { return d; } } } return s; };
          const parts = [];
          for (const ak of ['SLARDARmlmaas_volcconsole', 'SLARDARvolc_console']) {
            let raw = null; try { raw = window.localStorage.getItem(ak); } catch (_) {}
            if (!raw) { parts.push(ak + '=ABSENT'); continue; }
            let dec = raw; try { dec = dc2(raw); } catch (_) {}
            parts.push(ak + '=' + String(dec).slice(0, 90));
          }
          const r = realUidResolve();
          parts.push('REAL=' + (r || 'null'));
          diag = parts.join(' | ');
          try { window.localStorage.setItem('qf:volc:diag', diag); } catch (_) {}
        } catch (_) {}
        realUidResolve(); if (window.__VF_REAL_UID__) persistAccount(window.__VF_REAL_UID__);
        window.__VF_SUBMIT__ = true; window.__VF_STATE__ = window.__VF_CAPTURED__ ? 'ok' : 'empty';
      });
      let dragging = false, offX = 0, offY = 0;
      const grip = document.getElementById('qf-volc-grip');
      const header = document.getElementById('qf-volc-header');
      const barEl = document.getElementById('qf-volc-bar');
      const startDrag = (e) => { dragging = true; offX = e.clientX - barEl.offsetLeft; offY = e.clientY - barEl.offsetTop; barEl.style.cursor = 'grabbing'; e.preventDefault(); };
      if (grip) grip.addEventListener('mousedown', startDrag);
      if (header) header.addEventListener('mousedown', startDrag);
      document.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const x = Math.max(4, Math.min(window.innerWidth - barEl.offsetWidth - 4, e.clientX - offX));
        const y = Math.max(4, Math.min(window.innerHeight - barEl.offsetHeight - 4, e.clientY - offY));
        barEl.style.left = x + 'px'; barEl.style.top = y + 'px';
      });
      document.addEventListener('mouseup', () => { dragging = false; barEl.style.cursor = 'grab'; });
    }
  })()`

  const inject = (): void => {
    void win.webContents.executeJavaScript(INJECT).catch(() => {})
  }
  win.webContents.on('did-finish-load', () => {
    setTimeout(inject, 500)
  })

  return new Promise<{
    ok: boolean
    consoleJwt?: string
    accountId?: string
    models?: VolcengineFreeVideoModel[]
    source?: 'console' | 'fallback'
    error?: string
  }>((resolve) => {
    let finished = false
    let renewTimeout: NodeJS.Timeout | null = null
    // 额度同步：记开始时间 + 累积「最新一次抓到」的结果。开通管理页为虚拟列表，首屏只渲染顶部卡片（pro），
    // 若首命中就返回，底部的 wan/lite 卡还没被自动滚动渲染出来 → 永远漏卡。故先累积、稳定后再返回。
    const winStart = Date.now()
    let syncLatest:
      | { consoleJwt?: string; accountId?: string | null; models: VolcengineFreeVideoModel[]; signature: string }
      | null = null
    let syncStableCount = 0
    const done = (result: {
      ok: boolean
      consoleJwt?: string
      accountId?: string
      models?: VolcengineFreeVideoModel[]
      source?: 'console' | 'fallback'
      error?: string
    }): void => {
      if (finished) return
      finished = true
      clearInterval(pollTimer)
      if (renewTimeout) clearTimeout(renewTimeout)
      // 收尾落 SYNC_HB_END（仅额度同步模式产生过首拍时）：给出结束时的最新页面快照，补全首尾视角
      if (volcSyncHbFired && volcSyncHbLast) {
        logVolcSync(`SYNC_HB_END ${Date.now() - winStart}ms ${volcSyncHbLast}`)
      }
      if (!win.isDestroyed()) win.destroy()
      loginWindows.delete(winKey)
      resolve(result)
    }
    win.on('closed', () => {
      clearInterval(pollTimer)
      if (renewTimeout) clearTimeout(renewTimeout)
      try {
        void win.webContents
          .executeJavaScript('clearInterval(window.__VF_SCAN__);clearInterval(window.__VF_SCAN2__)')
          .catch(() => {})
      } catch {}
      if (loginWindows.get(winKey) === win) loginWindows.delete(winKey)
      if (!finished) {
        finished = true
        resolve({ ok: false, error: '窗口已关闭' })
      }
    })

    if (quiet) {
      renewTimeout = setTimeout(() => {
        if (syncModels) {
          // 额度同步超时：说明未抓到开通管理页额度（登录态失效/页面未渲染/CSP 阻断）。以「成功但无新数据」返回，
          // 由调用方保留旧 models，避免误把额度清空；仅在非同步场景把超时视为失败（续期需明确失败以便重试）。
          if (!win.isDestroyed()) {
            void win.webContents
              .executeJavaScript(
                `JSON.stringify({url: location.href, body:(document.body&&document.body.innerText||'').slice(0,600), login:/登录|扫码|二维码|手机号|密码/.test((document.body&&document.body.innerText||'')), vf:(window.__VF_MODELS__||[]).length, submit:!!window.__VF_SUBMIT__})`
              )
              .then((s) => logVolcSync(`SYNC_TIMEOUT page=${s}`))
              .catch((e) => logVolcSync(`SYNC_TIMEOUT peek_err=${e}`))
          }
          done({ ok: true, source: 'fallback' })
        } else {
          done({ ok: false, error: '静默续期超时：控制台登录态可能已失效，请在厂商页手动刷新账号' })
        }
      }, VOLC_QUIET_RENEW_TIMEOUT_MS)
    }

    const pollTimer = setInterval(() => {
      if (win.isDestroyed()) return
      if (quiet) {
        // 额度同步模式（静默）：无需注入条点击，等开通管理页抓到免费额度卡片后，累积最新 models，
          // 直到抓取结果连续稳定（自动滚动已滚到底部、末端 wan/lite 卡也收录）或达到最大等待即可返回。
        if (syncModels) {
          // 页内心跳快照：无论是否抓到卡片，每轮都回吐一次页面状态，用于定位「为何 __VF_MODELS__ 为空」
          //（登录墙？开通管理页未渲染？CSP 阻断注入？）。在线则记录，不阻塞主探测流程。
          void win.webContents
            .executeJavaScript(
              `JSON.stringify({url: location.href, t:(document.body&&document.body.innerText||'').replace(/\\s+/g,' ').slice(0,400), login:/登录|扫码|二维码|手机号|密码/.test((document.body&&document.body.innerText||'')), vf:(window.__VF_MODELS__||[]).length, vfIds:(window.__VF_MODELS__||[]).map(m=>m.name).join(','), injected:!!window.__QUOTA_FLOW_VOLC__, submit:!!window.__VF_SUBMIT__, scroller:(function(){var n=0,b=0;try{var all=document.querySelectorAll('*');for(var i=0;i<all.length;i++){var e=all[i];if(e.scrollHeight>e.clientHeight+20){n++;if(e.scrollHeight>e.clientHeight*2)b++;}};return n+'/'+b;}catch(_){return 'err';}})(), cards:document.querySelectorAll('[class*=card],[class*=Card],[class*=item]').length,
sample:(function(){
  var out=[];
  try{
    var els=document.querySelectorAll('*');
    for(var i=0;i<els.length&&out.length<3;i++){
      var e=els[i];
      var tt=(e.textContent||'').replace(/\\s+/g,' ').trim();
      if(tt.length<260&&tt.length>4&&/token|tok|已开通|未开通|开通|剩余|剩|免费/.test(tt)){
        // 近似卡片：文本短且含额度/开通关键词
        out.push(tt.slice(0,160));
      }
    }
  }catch(_){}
  return out;
})(), rows:(function(){
  // 可视化模型（wan / doubao-seedance）在表格深处，逐屏滚动后应整行呈现（含状态列）。
  // 这里专门输出含 wan/seedance 模型名的行全文（截取），以核对开通状态与额度字段格式。
  var out=[];
  try{
    var cells=document.querySelectorAll('table tr, [role=row], [class*=Row]');
    for(var i=0;i<cells.length;i++){
      var c=cells[i];
      var ct=(c.textContent||'').replace(/\s+/g,' ').trim();
      if(ct.length<=6||!/[Ww]an|seedance|Seedance|doubao-seedance/.test(ct))continue;
      if(out.length>=6)break;
      out.push(ct.slice(0,220));
    }
  }catch(_){}
  return out;
})(), pag:(function(){
  // 视觉模型表格为分页结构，wan 在第二页。抓分页控件（文本/容器/按钮）还原「下一页」等结构以便翻页。
  var out=[];
  try{
    var t=document.body&&document.body.innerText||'';
    // 形如「1 / 10 页」「共 2 页」「第 1 页」的总页数文本
    var m=t.match(/[共第]?\\s*\\d+\\s*\\/\\s*\\d+\\s*[页共]?/g);
    if(m){out.push('text:'+String(m).slice(0,80));}
    var m2=t.match(/共\\s*\\d+\\s*页/g);
    if(m2){out.push('共页:'+m2.slice(0,3).join(','));}
  }catch(_){}
  try{
    // 页面唯一存在的分页容器：火山常用 antd pagination 或自研 li 结构
    var conts=document.querySelectorAll('[class*=pagination],[class*=Pagination],[class*=page-list],[class*=PageList],[class*=pager] ,ul');
    var seen=0;
    for(var i=0;i<conts.length&&seen<2;i++){
      var ct=(conts[i].textContent||'').replace(/\\s+/g,' ').trim();
      var cl=String(conts[i].className||'').slice(0,80);
      if(/[\\d/共页><]/.test(ct)&&ct.length<80){out.push('cont:'+cl+'|'+ct); seen++;}
    }
    var btns=document.querySelectorAll('a,button,[role=button]');
    for(var i=0;i<btns.length;i++){
      var b=btns[i];
      var tx=(b.textContent||'').replace(/\\s+/g,' ').trim();
      var al=(b.getAttribute&&b.getAttribute('aria-label'))||'';
      var cl=String(b.className||'').slice(0,60);
      if(/下一页|下一頁|next|>>|^>$/.test(tx)||/next|下一页/i.test(al)||/next|pagination/i.test(cl)){
        var dis=b.hasAttribute&&b.hasAttribute('disabled')?'[dis]':'';
        out.push('btn:'+cl+'|'+(al||tx).slice(0,24)+dis);
        if(out.length>=8)break;
      }
    }
  }catch(_){}
  return out;
})(), frames:(function(){
  var out=[];
  try{
    var fs=document.querySelectorAll('iframe,frame');
    for(var i=0;i<fs.length;i++){
      var f=fs[i];
      var fr={src:String(f.src||f.getAttribute('src')||'').slice(0,140)};
      try{
        var d=f.contentDocument;
        fr.t=(d&&d.body&&d.body.innerText||'').replace(/\s+/g,' ').trim().slice(0,200);
      }catch(_){fr.err='blocked';}
      out.push(fr);
    }
  }catch(_){}
  return out;
})()})`
            )
            .then((s) => {
              // 心跳节流：仅在页面状态变化时记录，避免静止页面每秒刷一条大日志
              let sig = ''
              let compact = ''
              try {
                const o = JSON.parse(s) as Record<string, unknown>
                // 紧凑字段（诊断空 __VF_MODELS__ 所需）：URL/登录墙/模型数/注入/滚动/卡片/模型行/分页
                sig = [o.url, o.login, o.vf, o.vfIds, o.injected, o.submit, o.scroller, o.cards, o.rows, o.pag].join('|')
                compact = JSON.stringify({
                  url: o.url, login: o.login, vf: o.vf, vfIds: o.vfIds, injected: o.injected,
                  submit: !!o.submit, scroller: o.scroller, cards: o.cards, rows: o.rows, pag: o.pag
                })
              } catch {
                sig = ''
              }
              // 只记首尾：首拍落一条 SYNC_HB 快照；后续每拍仅把最新摘要更新进内存，
              // 由同步收尾（done）在结束时统一落一条 SYNC_HB_END，避免滚动期间每拍刷屏。
              if (sig && sig !== volcSyncHbSig) {
                volcSyncHbSig = sig
                volcSyncHbLast = compact
                if (!volcSyncHbFired) {
                  volcSyncHbFired = true
                  logVolcSync(`SYNC_HB ${Date.now() - winStart}ms ${compact}`)
                }
              }
            })
            .catch((e) => logVolcSync(`SYNC_HB_err ${e}`))
          void win.webContents
            .executeJavaScript('window.__VF_MODELS__ && (window.__VF_MODELS__.length > 0 || Object.keys(window.__VF_TOKEN_LIMITS__).length > 0 || window.__VF_HAS_RATE__) ? [window.__VF_CAPTURED__, window.__VF_ACCOUNT__ || null, window.__VF_MODELS__, window.__VF_SCREEN__ || 0, window.__VF_SAVED_RAW__ ? window.__VF_SAVED_RAW__.slice(0, 3000) : null, (window.__VF_MODELS_RAW__||[]).map(function(r){return r.url;}).filter(function(u,i,a){return a.indexOf(u)===i;}).slice(0,15), window.__VF_MODEL_BODY__ ? window.__VF_MODEL_BODY__.slice(0, 6000) : null, window.__VF_TOKEN_LIMITS__ || {}, window.__VF_HAS_RATE__ || false, window.__VF_PAGE__ || 0, window.__VF_HASMORE__ ? true : false, (window.__VF_PAGEDEBUG__ || []).join(";")] : null')
            .then((val: unknown) => {
              if (!val) return
              const [jwt, accountId, rawModels, screenIdx, rawBody, rawUrls, modelBody, tokenLimits, hasRate, curPage, hasMore, pageDebug] = val as [
                string | null,
                string | null,
                Array<{ name: string; remaining?: number; total?: number; activated?: boolean }>,
                number,
                string | null,
                string[] | null,
                string | null,
                Record<string, { tokenLimit: number; currentUsage: number }>,
                boolean,
                number,
                boolean,
                string
              ]
              // 接口原始响应抓取：优先用接口 JSON 解析模型额度的开通状态，DOM 卡片只是兜底。
              // 去抖：URL/响应体在每轮轮询中重复出现，只在内容变化时记录，避免每拍重复 dump。
              if (Array.isArray(rawUrls) && rawUrls.length > 0) {
                const urlSig = rawUrls.join('|')
                if (urlSig !== volcSyncRawUrlsSig) {
                  volcSyncRawUrlsSig = urlSig
                  logVolcSync(`SYNC_RAWURLS ${rawUrls.join(' | ')}`)
                }
              }
              if (typeof modelBody === 'string' && modelBody.length > 80 && modelBody !== rawBody && modelBody !== volcSyncModelBodySig) {
                volcSyncModelBodySig = modelBody
                logVolcSync(`SYNC_MODELBODY ${modelBody.slice(0, 6000)}`)
              }
              if (typeof rawBody === 'string' && rawBody.length > 80 && rawBody !== volcSyncRawBodySig) {
                volcSyncRawBodySig = rawBody
                logVolcSync(`SYNC_RAW sample=${rawBody.slice(0, 2200)}`)
              }
              // 接口级模型：ListModelTokenLimit 的 TokenLimit 即每个已开通模型的免费总额度。
              // 换算为与目录一致的单位（火山 TokenLimit 单位是 token），remaining = TokenLimit - currentUsage。
              const tokenNames = Object.keys(tokenLimits || {})
              if (tokenNames.length > 0) {
                // 去抖：只用集合整体变化时记录一次，避免每拍重复落一条已收敛的 SYNC_TOKENS
                const tokSig = tokenNames
                  .map((n) => `${n}:${tokenLimits[n].tokenLimit}/${tokenLimits[n].currentUsage}`)
                  .join('|')
                if (tokSig !== volcSyncTokensSig) {
                  volcSyncTokensSig = tokSig
                  logVolcSync(
                    `SYNC_TOKENS ${tokenNames
                      .map((n) => `${n}:${tokenLimits[n].tokenLimit}/used${tokenLimits[n].currentUsage}`)
                      .join(' | ')}`
                  )
                }
                // 把接口真实额度 upsert 进 rawModels（副本），供下方 capture 合并，保证已开通模型不被
                // 目录 fallback 显示「待开通」。随后继续走 capture/稳定收敛，不做 return。
                for (const name of tokenNames) {
                  const tl = tokenLimits[name]
                  const existing = rawModels.find((m) => m.name === name)
                  if (existing) {
                    existing.remaining = Math.max(0, tl.tokenLimit - tl.currentUsage)
                    existing.total = tl.tokenLimit
                    existing.activated = true
                  } else {
                    rawModels.push({
                      name,
                      remaining: Math.max(0, tl.tokenLimit - tl.currentUsage),
                      total: tl.tokenLimit,
                      activated: true
                    })
                  }
                }
              }
              const captured = captureVolcengineFreeVideoModels(rawModels)
              if (captured.source !== 'console') return
              // 与上一轮抓到的结果比较，用于判断是否已稳定（虚拟列表滚到底、不再新增/变化卡片）
              const sig = captured.models
                .map((m) => `${m.id}:${m.freeQuota?.remaining ?? '__'}:${m.activated ? 'T' : 'F'}`)
                .join(',')
              if (syncLatest && syncLatest.signature === sig) {
                syncStableCount++
              } else {
                syncStableCount = 1
                syncLatest = { consoleJwt: undefined, accountId, models: captured.models, signature: sig }
                if (typeof jwt === 'string' && jwt) syncLatest.consoleJwt = jwt
              }
              console.log(`[volc-sync] 额度抓取中 ${captured.models.map((m) => m.id).join(',')} stable=${syncStableCount} screen=${screenIdx}`)
              // 收敛：确保已渐进滚动足够多屏（到底部模型已渲染）后再按「连续稳定」返回。
              // 首屏就有 3D 免费模型，若不要求滚屏会过早返回、漏掉深处 wan/seedance1.0。
              const scrolledEnough = typeof screenIdx === 'number' && screenIdx >= 4
              const morePages = !!hasMore
              // 收敛：已尽力翻页（无下一页可点）且结果稳定 3 轮；或翻页/累积超 18s 兜底返回。
              // 不再仅凭 8s 强收（会让停在第一页的稳定签名提前返回、漏掉第二页的 wan）。
              if (
                (scrolledEnough && syncStableCount >= 3 && !morePages) ||
                (scrolledEnough && Date.now() - winStart >= 18000)
              ) {
                // 权威判定「未开通」：分页耗尽(morePages=false) 且 ListModelTokenLimit 已返回过真实 token
                // 额度（该接口只覆盖已开通模型、随分页逐页累积），认定已抓到全量已开通免费模型；
                // 未被抓到的目录模型即为「未开通」，据此覆盖目录默认 activated:true，避免未开通模型
                // （如本账号未开通的 seedance-1.5-pro）误显示「已开通」。
                const complete = !morePages && Object.keys(tokenLimits || {}).length > 0
                const finalCaptured = captureVolcengineFreeVideoModels(rawModels, undefined, {
                  markAbsentInactivated: complete
                })
                const finalModels = finalCaptured.models
                // 接口为准+未知保守：只信任 ListModelTokenLimit 返回（权威）模型的 freeQuota；
                // 未命中模型的 freeQuota 来自 DOM/旧缓存，会误导「查看模型」展示（如 seedance-1.0-pro
                // 显示 272120/2000000 而官网为已开通剩0），一律置空按「— 未知」保守展示。
                const authoritative = volcengineAuthoritativeIds(Object.keys(tokenLimits || {}))
                if (authoritative.size > 0) {
                  for (const m of finalModels) {
                    if (!authoritative.has(m.id)) m.freeQuota = undefined
                  }
                }
                logVolcSync(
                  `SYNC_FINAL complete=${complete ? 'YES' : 'NO'} authoritative=${authoritative.size} models=${finalModels.map((m) => `${m.id}:${m.activated ? 'T' : 'F'}${m.freeQuota ? '/Q' : '/-'}`).join(',')}`
                )
                if (syncLatest) syncLatest.models = finalModels
                done({
                  ok: true,
                  consoleJwt: syncLatest.consoleJwt,
                  accountId: typeof syncLatest.accountId === 'string' ? syncLatest.accountId : undefined,
                  models: finalModels,
                  source: 'console'
                })
              }
            })
            .catch(() => {})
          return
        }
        void win.webContents
          .executeJavaScript('window.__VF_CAPTURED__ || null')
          .then((jwt: unknown) => {
            if (typeof jwt !== 'string' || !jwt) return
            if (oldConsoleJwt && jwt === oldConsoleJwt.trim()) return
            done({ ok: true, consoleJwt: jwt })
          })
          .catch(() => {})
        return
      }
      void win.webContents
        .executeJavaScript('window.__VF_SUBMIT__ ? [window.__VF_STATE__, window.__VF_CAPTURED__, (window.__VF_ACCOUNT__ || (function(){try{return window.localStorage.getItem(\'qf:volc:account\')||null}catch(_){return null}})()), window.__VF_MODELS__ || [], (function(){try{return window.localStorage.getItem(\'qf:volc:account\')||null}catch(_){return \'e\'}})(), (function(){try{return window.localStorage.getItem(\'qf:volc:diag\')||null}catch(_){return null}})() ] : null')
        .then((val: unknown) => {
          if (!val) return
          const [state, jwt, accountId, rawModels, lsVal, diag] = val as [
            string,
            string | null,
            string | null,
            Array<{ name: string; remaining?: number; total?: number }>,
            string | null,
            string | null
          ]
          // 绑定诊断：accountId 可能来自页面全局 __VF_ACCOUNT__，或整页跳转后从 localStorage 恢复读取；
          // 两者都空才能判定绑定时确未抓到账号 id（否则是链路其它环节丢的）
          logVolcSync(
            `CAPTURE_SUBMIT state=${state} accountId=${accountId ? `YES:${accountId}` : 'NO'} ls=${(typeof lsVal === 'string' && lsVal) ? `YES:${lsVal}` : 'NO'} diag=${typeof diag === 'string' && diag ? diag : 'NONE'}`
          )
          // 火山方舟控制台走 cookie 会话，通常不产生进入 Authorization 头的三段式 JWT（consoleJwt）。
          // 故「已获取 key 返回」时不再把缺 JWT 视为失败：绑定只需 API Key，consoleJwt 作为可选增强，
          // 捕获到则带回（供未来额度接口探测），捕获不到也未空返回值正常继续。
          // 只有当既无 JWT 也无账号 id（连账号上下文都没抓到）才提示未完成，避免把已抓到的
          // accountId/models 因 state=empty（无 JWT 的正常态）误丢弃，导致绑定拿不到账号级去重键。
          if (state !== 'ok' && !accountId) {
            done({ ok: false, error: '请在登录火山方舟控制台并复制 API Key 后点击返回' })
            return
          }
          // 「绑定即抓模型」：把控制台页面抓到的免费 Seedance 条目规范化，回退内置目录。
          const captured = captureVolcengineFreeVideoModels(rawModels)
          const label = captured.models.map((m) => m.id).join(',') || '无'
          if (captured.source === 'console') {
            console.log(`[volc-caps] 免费视频模型清单（控制台抓取）：${label}`)
          } else {
            console.log(`[volc-caps] 免费视频模型清单（内置目录回退）：${label}; 抓取原始条目=${rawModels.length}`)
          }
          logVolcSync(
            `CAPTURE_RETURN state=ok accountId=${typeof accountId === 'string' && accountId ? 'YES' : 'NO'}`
          )
          done({
            ok: true,
            consoleJwt: typeof jwt === 'string' && jwt ? jwt : undefined,
            accountId: typeof accountId === 'string' && accountId ? accountId : undefined,
            models: captured.models,
            source: captured.source
          })
        })
        .catch(() => {})
    }, 700)
  })
}

// ── 阿里云百炼控制台会话捕获（复用智谱/火山内核：独立分区 + 注入 hook 抓响应 + localStorage 兜底）──
// 默认落点：API Key 管理页（tab=model#/api-key，用户最熟悉，方便复制/校验 Key）。
// 捕获两样东西（需用户切到免费额度页 costing-balance/free-quota?modelType=Vision 后由注入脚本抓取）：
//   1) accountId（阿里云账号 PK）→ 账号级去重指纹键（免费额度按账号共享，见方案 §6.1）
//   2) freeTierQuotas（真实免费额度）→ 账号级聚合展示（剩余/总量）
// 鉴权：页面内 fetch/XHR 依赖控制台会话 cookie + 页面 SDK 计算注入的 sec_token，故无法由主进程/裸
//   API Key 重放，只能在本捕获窗口页面上下文内 hook 网络响应 + 读 localStorage 缓存整表（页面自身缓存
//   CacheByUId-CURRENT_PK-<accountId>-free_quota_<ModelType>）。
const BAILIAN_CONSOLE_URL = "https://bailian.console.aliyun.com/cn-beijing?tab=model#/api-key"
// 免费额度页（用于注入提示与跳转引导；捕获监听即针对该页响应的 queryFreeTierQuotaAsyn）
const BAILIAN_FREE_QUOTA_URL =
  "https://bailian.console.aliyun.com/cn-beijing?tab=costing-balance#/costing-balance/free-quota?modelType=Vision"
const BAILIAN_CONSOLE_PARTITION = "persist:qf-bailian-console"
/** 百炼控制台分区按账号隔离：persist:qf-bailian-console[:keyId]，避免多账号串会话 */
function bailianConsolePartitionFor(keyId?: string): string {
  return keyId ? `${BAILIAN_CONSOLE_PARTITION}:${keyId}` : BAILIAN_CONSOLE_PARTITION
}
function bailianConsoleSession(keyId?: string): Electron.Session {
  return session.fromPartition(bailianConsolePartitionFor(keyId))
}

const BAILIAN_CONSOLE_ORIGIN = 'https://bailian.console.aliyun.com'

/** 读取百炼控制台分区 cookie（供持久化/回注入，跨重启重建登录态） */
async function collectBailianConsoleCookies(keyId?: string): Promise<ProviderCookie[]> {
  const ses = session.fromPartition(bailianConsolePartitionFor(keyId))
  const all = await ses.cookies.get({})
  return exportCookies(all)
}

/** 向百炼控制台分区回注入 cookie（与网页厂商 injectCookies 同构，但定向到控制台分区） */
async function injectBailianConsoleCookies(keyId: string, cookies: BailianStoredCookie[]): Promise<void> {
  const ses = session.fromPartition(bailianConsolePartitionFor(keyId))
  ses.setUserAgent(CHROME_UA)
  for (const c of cookies) {
    try {
      await ses.cookies.set({
        url: `${c.secure ? 'https' : 'http'}://${(c.domain || '').replace(/^\./, '') || BAILIAN_CONSOLE_ORIGIN.replace(/^https?:\/\//, '')}${c.path || '/'}`,
        domain: c.domain || undefined,
        name: c.name,
        value: c.value,
        httpOnly: c.httpOnly,
        secure: c.secure,
        expirationDate: typeof c.expires === 'number' && c.expires > 0 ? Math.floor(c.expires / 1000) : undefined
      })
    } catch {
      // 单条失败不阻塞其余注入
    }
  }
}
/** 静默捕获（续期/刷新额度）最长等待 */
const BAILIAN_QUIET_WAIT_MS = 5000

/**
 * 绑定捕获时的控制台 cookie 缓存（按账号 accountId 暂存）。
 * 用途：渲染层把捕获结果落库负载时可能因状态/旧 bundle 丢 cookies，加密兜底合并这里最近的捕获结果，
 * 确保登录 cookie 一定随负载持久化，供「进入官网」跨重启重新注入。
 */
const bailianCapturedCookies = new Map<string, BailianStoredCookie[]>()

export async function captureBailianConsoleSession(opts?: {
  /** 静默捕获：不显示窗口、不要求点按钮，抓到数据或超时即自动返回 */
  quiet?: boolean
  /** 绑定/续期所属账号 keyId：隔离登录态，避免多账号串会话 */
  keyId?: string
}): Promise<{
  ok: boolean
  accountId?: string
  freeTiersRaw?: string
  source?: 'console' | 'cache' | 'none'
  cookies?: ProviderCookie[]
  error?: string
}> {
  const quiet = !!opts?.quiet
  const optKeyId = opts?.keyId
  const winKey = `${quiet ? 'bailian-console-quiet' : 'bailian-console'}:${optKeyId ?? 'shared'}`
  const existing = loginWindows.get(winKey)
  if (existing && !existing.isDestroyed()) {
    existing.focus()
    return { ok: false, error: quiet ? '百炼会话捕获进行中' : '百炼控制台窗口已打开' }
  }
  // 首次绑定清空登录态避免残留；静默复用已登录 cookie，跳过清空
  if (!quiet) {
    try {
      await bailianConsoleSession(optKeyId).clearStorageData()
    } catch {}
  }
  const ses = bailianConsoleSession(optKeyId)

  // 主窗口（可见）：落 API Key 管理页，用户在此登录并复制/校验 API Key
  const win = new BrowserWindow({
    width: 1024,
    height: 768,
    minWidth: 840,
    minHeight: 620,
    title: '⋮⋮  Quota-Flow · 阿里云百炼控制台',
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    show: !quiet,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      session: ses
    }
  })
  win.webContents.setUserAgent(CHROME_UA)
  loginWindows.set(winKey, win)
  void win.loadURL(BAILIAN_CONSOLE_URL).catch(() => {})

  // 隐藏捕获窗口：同一 partition 共用登录态（cookie），落免费额度页(视觉模型)，
  // 页面 SDK 自动计算 sec_token 并发起 queryFreeTierQuotaAsyn，由注入脚本抓整表快照——用户无需手动切页
  const capWin = new BrowserWindow({
    width: 1024,
    height: 768,
    show: false,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      session: ses
    }
  })
  capWin.webContents.setUserAgent(CHROME_UA)
  void capWin.loadURL(BAILIAN_FREE_QUOTA_URL).catch(() => {})

  // ── 捕获窗口注入：仅做数据 hook（fetch/XHR + localStorage 兜底），隐藏窗口不含 UI ──
  const CAPTURE_INJECT = `(() => {
    if (window.__QUOTA_FLOW_BAILIAN_CAP__) return;
    window.__QUOTA_FLOW_BAILIAN_CAP__ = true;
    window.__QB_FREE_TIERS_RAW__ = null;
    window.__QB_ACCOUNT__ = null;
    const setRaw = (text) => { try { if (typeof text === 'string' && text.length > 30 && (text.indexOf('freeTierQuot') > -1 || text.indexOf('quotaTotal') > -1)) { window.__QB_FREE_TIERS_RAW__ = text; } } catch (_) {} };
    const ACCT_FROM_KEY = /CURRENT_PK[-_](\\d{6,20})/;
    const ACCT_FROM_VAL = /["']?(?:accountId|userId|user_id|account_id|uid)["']?\\s*[:=]\\s*["']?(\\d{6,20})/i;
    const setAccount = (source) => { try { if (window.__QB_ACCOUNT__) return; const m = String(source || '').match(ACCT_FROM_KEY) || String(source || '').match(ACCT_FROM_VAL); if (m && m[1]) window.__QB_ACCOUNT__ = m[1]; } catch (_) {} };
    const ingest = (url, text) => { try { if (/queryFreeTierQuota/i.test(String(url || ''))) { setRaw(text); setAccount(text); } } catch (_) {} };
    const origFetch = window.fetch;
    if (origFetch) { window.fetch = function (...args) { const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || ''; const p = origFetch.apply(this, args); try { p.then((resp) => { try { resp.clone().text().then((txt) => ingest(url, txt)); } catch (_) {} }).catch(() => {}); } catch (_) {} return p; }; }
    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (m, u) { try { window.__QB_XHR__ = String(u || ''); } catch (_) {} return origOpen.apply(this, arguments); };
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (...rest) { try { if (window.__QB_XHR__) { const self = this; const u = window.__QB_XHR__; this.addEventListener('load', function () { try { const t = self.responseText || ''; ingest(u, t); } catch (_) {} }); } } catch (_) {} return origSend.apply(this, rest); };
    const scanStorage = () => { try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i) || ''; const v = localStorage.getItem(k) || ''; if (/free_quota|freeTier|CacheByUId/.test(k)) { setRaw(v); setAccount(k); } } } catch (_) {} };
    window.__QB_SCAN__ = setInterval(scanStorage, 1200);
    scanStorage();
  })()`
  const injectCap = (): void => {
    void capWin.webContents.executeJavaScript(CAPTURE_INJECT).catch(() => {})
  }
  capWin.webContents.on('did-finish-load', () => {
    setTimeout(injectCap, 500)
  })
  if (quiet) setTimeout(injectCap, 700)

  // ── 主窗口注入：可拖拽提示条 + 「已捕获返回」按钮（数据在隐藏捕获窗口自动抓取）──
  const UI_INJECT = `(() => {
    if (window.__QUOTA_FLOW_BAILIAN_UI__) return;
    window.__QUOTA_FLOW_BAILIAN_UI__ = true;
    window.__QB_UI_SUBMIT__ = false;
    const bar = document.createElement('div');
    bar.id = 'qf-bailian-bar';
    bar.style.cssText = 'position:fixed;top:12px;left:12px;z-index:2147483647;display:flex;flex-direction:column;gap:6px;padding:8px 12px;border-radius:8px;background:rgba(20,20,22,.92);color:#fff;font:12.5px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.35);user-select:none;max-width:440px;';
    bar.innerHTML =
      '<div id="qf-bailian-header" style="display:flex;align-items:center;gap:6px;font-weight:600;color:#fff;cursor:grab;font-size:12.5px;">' +
      '<span id="qf-bailian-grip" style="color:#9aa0a6;letter-spacing:1px;font-size:13px;">⋮⋮</span>' +
      '<span>Quota-Flow · 阿里云百炼控制台</span>' +
      '</div>' +
      '<div style="display:flex;align-items:center;gap:8px;">' +
      '<span style="flex:1;min-width:0;color:#c4c8d0;font-size:12px;line-height:1.4;">请在页面登录并复制 API Key，免费额度已由后台自动捕获；返回请点击下方按钮</span>' +
      '<button id="qf-bailian-return" style="flex-shrink:0;padding:5px 12px;border:0;border-radius:6px;background:#2ea56f;color:#fff;font:600 12px/1 inherit;cursor:pointer;white-space:nowrap;">已捕获返回</button>' +
      '</div>';
    document.body.appendChild(bar);
    document.getElementById('qf-bailian-return').addEventListener('click', () => { window.__QB_UI_SUBMIT__ = true; });
    let dragging = false, offX = 0, offY = 0;
    const grip = document.getElementById('qf-bailian-grip');
    const header = document.getElementById('qf-bailian-header');
    const barEl = document.getElementById('qf-bailian-bar');
    const startDrag = (e) => { dragging = true; offX = e.clientX - barEl.offsetLeft; offY = e.clientY - barEl.offsetTop; barEl.style.cursor = 'grabbing'; e.preventDefault(); };
    if (grip) grip.addEventListener('mousedown', startDrag);
    if (header) header.addEventListener('mousedown', startDrag);
    document.addEventListener('mousemove', (e) => { if (!dragging) return; const x = Math.max(4, Math.min(window.innerWidth - barEl.offsetWidth - 4, e.clientX - offX)); const y = Math.max(4, Math.min(window.innerHeight - barEl.offsetHeight - 4, e.clientY - offY)); barEl.style.left = x + 'px'; barEl.style.top = y + 'px'; });
    document.addEventListener('mouseup', () => { dragging = false; barEl.style.cursor = 'grab'; });
  })()`
  const injectUI = (): void => {
    void win.webContents.executeJavaScript(UI_INJECT).catch(() => {})
  }
  win.webContents.on('did-finish-load', () => {
    setTimeout(injectUI, 500)
  })

  return new Promise<{
    ok: boolean
    accountId?: string
    freeTiersRaw?: string
    source?: 'console' | 'cache' | 'none'
    cookies?: ProviderCookie[]
    error?: string
  }>((resolve) => {
      let finished = false
      let renewTimeout: NodeJS.Timeout | null = null
      const done = (result: {
        ok: boolean
        accountId?: string
        freeTiersRaw?: string
        source?: 'console' | 'cache' | 'none'
        cookies?: ProviderCookie[]
        error?: string
      }): void => {
        if (finished) return
        finished = true
        clearInterval(pollTimer)
        if (renewTimeout) clearTimeout(renewTimeout)
        if (!win.isDestroyed()) win.destroy()
        if (!capWin.isDestroyed()) capWin.destroy()
        loginWindows.delete(winKey)
        resolve(result)
      }
      win.on('closed', () => {
        clearInterval(pollTimer)
        if (renewTimeout) clearTimeout(renewTimeout)
        try {
          void win.webContents.executeJavaScript('clearInterval(window.__QB_UI_SCAN__)').catch(() => {})
        } catch {}
        if (!capWin.isDestroyed()) capWin.destroy()
        if (loginWindows.get(winKey) === win) loginWindows.delete(winKey)
        if (!finished) {
          finished = true
          resolve({ ok: false, error: '窗口已关闭' })
        }
      })

      if (quiet) {
        renewTimeout = setTimeout(() => {
          done({ ok: true, source: 'none' })
        }, BAILIAN_QUIET_WAIT_MS)
      }

      const readCapExpr =
        'window.__QB_FREE_TIERS_RAW__ ? [window.__QB_ACCOUNT__ || null, window.__QB_FREE_TIERS_RAW__] : null'
      const readUIExpr = 'window.__QB_UI_SUBMIT__ || false'
      let reloadTick = 0
      const pollTimer = setInterval(() => {
        if (win.isDestroyed() || capWin.isDestroyed()) return
        reloadTick = (reloadTick + 1) % 15 // 每 ~10.5s 一轮；登录前捕获窗口可能未授权跳走，周期刷新以带登录态重请求
        Promise.all([
          capWin.webContents.executeJavaScript(readCapExpr).catch(() => null),
          quiet ? Promise.resolve(true) : win.webContents.executeJavaScript(readUIExpr).catch(() => false)
        ])
          .then(([capVal, uiGo]) => {
            const val = capVal as [string | null, string] | null
            if (!val) {
              // 登录前窗口常无额度数据：非静默下周期 reload 捕获窗口，用户在主窗口登录后 cookie 生效即可抓到
              if (!quiet && reloadTick === 0) {
                try {
                  void capWin.webContents.reload()
                } catch {}
              }
              return
            }
            const [accountId, raw] = val
            const hasData = typeof raw === 'string' && raw.length > 30
            if (!hasData) {
              if (quiet) return
              // 用户已点「已捕获返回」但未抓到额度：提示而非静默失败
              if (uiGo) done({ ok: false, error: '未捕获到免费额度数据，请确认已在页面登录成功再重试' })
              return
            }
            if (!quiet && !uiGo) return // 数据已就绪但用户尚未点返回，继续等待
            console.log(
              `[qf-bailian] CAPTURE ok accountId=${accountId ? `YES:${accountId}` : 'NO'} rawLen=${raw.length} quiet=${quiet}`
            )
            // 捕获成功后读取该账号控制台分区的登录 cookie，随负载持久化，供「进入官网」跨重启重建登录态
            void Promise.resolve()
              .then(() => collectBailianConsoleCookies(optKeyId))
              .then((cookies) => {
                console.log(`[qf-bailian] CAPTURE cookies=${cookies.length}`)
                // 最近一次成功捕获的 cookie 按 accountId 缓存，供后续 provider:encrypt 兜底合并进负载
                if (accountId && cookies.length > 0) bailianCapturedCookies.set(accountId, cookies)
                done({
                  ok: true,
                  accountId: accountId ?? undefined,
                  freeTiersRaw: raw,
                  source: accountId ? 'console' : 'cache',
                  cookies
                })
              })
              .catch(() => {
                done({
                  ok: true,
                  accountId: accountId ?? undefined,
                  freeTiersRaw: raw,
                  source: accountId ? 'console' : 'cache'
                })
              })
          })
          .catch(() => {})
      }, 700)
    }
  )
}

let registered = false

export function initProviders(): void {
  if (registered) return
  registered = true

  ipcMain.handle('provider:login', async (_e, providerId: string, keyId?: string) => {
    return openLoginWindow(providerId, typeof keyId === 'string' ? keyId : undefined)
  })

  ipcMain.handle('provider:encrypt', async (_e, providerId: string, plain: string) => {
    if (typeof plain !== 'string') return { encrypted: '' }
    try {
      // 百炼兜底：若捕获时返回的 cookies 未随渲染层负载写进来（旧 bundle/状态丢失），
      // 用缓存里最近一次成功捕获的同账号 cookies 合并后再加密，保证登录 cookie 一定落库
      let payloadPlain = plain
      if (providerId === 'bailian') {
        const trimmedP = (plain || '').trim()
        if (trimmedP.startsWith('{')) {
          const d = decodeBailianPayload(trimmedP)
          if (d.accountId && (!Array.isArray(d.cookies) || d.cookies.length === 0)) {
            const live = bailianCapturedCookies.get(d.accountId)
            if (live && live.length > 0) {
              try {
                const obj = JSON.parse(trimmedP)
                obj.cookies = live
                payloadPlain = JSON.stringify(obj)
                console.log(`[qf-bailian] ENC mergeCapturedCookies accountId=${d.accountId} n=${live.length}`)
              } catch {}
            }
          }
        }
      }
      const encrypted = safeStorage.encryptString(payloadPlain).toString('base64')
      // apikey 型厂商：指纹用于去重。
      // 智谱：同一账号可有多个 API Key，优先按 customerId 生成账号级指纹（同账号不同 Key 去重）；
      //       拿不到 customerId（无会话 / 查询失败）时回退按 API Key 明文哈希，避免误拦截。
      let fingerprint: string | null = null
      if (plain.trim()) {
        fingerprint =
          providerId === 'zhipu'
            ? await zhipuAccountFingerprint(plain)
            : providerId === 'volcengine'
              ? await volcengineAccountFingerprint(plain)
              : providerId === 'bailian'
                ? await bailianAccountFingerprint(plain)
                : fingerprintFor(providerId, plain.trim())
        // 火山方舟去重诊断：确认 accountId 是否进链路、指纹是「账号级」还是退化成「Key 哈希」
        if (providerId === 'volcengine') {
          const { accountId } = decodeVolcenginePayload(plain)
          logVolcSync(
            `ENC_VOLC accountId=${accountId ? `YES:${accountId}` : 'NO'} fp_level=${fingerprint ? (accountId ? 'account' : 'key-hash') : 'none'}`
          )
        }
        // 阿里云百炼去重诊断：payload 带 accountId（会话捕获）时按「账号级」指纹去重，否则退化为 Key 哈希
        if (providerId === 'bailian') {
          console.log(
            `[qf-bailian] ENC fp_level=${fingerprint ? (decodeBailianPayload(plain || '').accountId ? 'account' : 'key-hash') : 'none'} keyLen=${plain.trim().length}`
          )
        }
      }
      return { encrypted, fingerprint }
    } catch {
      return { encrypted: '' }
    }
  })

  ipcMain.handle('provider:health-check', (_e, providerId: string, encrypted: string, keyId?: string) => {
    return healthCheck(providerId, encrypted, typeof keyId === 'string' ? keyId : undefined)
  })

  // API Key 型厂商「测试」按钮：解密出 API Key 后调对应开放平台只读接口校验有效性，不产生费用
  ipcMain.handle('provider:test-api-key', async (_e, providerId: string, encrypted: string) => {
    try {
      const plain = safeStorage.decryptString(Buffer.from(encrypted ?? '', 'base64'))
      const { apiKey } = decodeZhipuPayload(plain)
      if (!apiKey) return { ok: false, error: '未解析到 API Key' }
      return providerId === 'volcengine'
        ? await testVolcengineApiKey(apiKey)
        : providerId === 'bailian'
          ? await testBailianApiKey(apiKey)
          : await testZhipuApiKey(apiKey)
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'API Key 校验失败' }
    }
  })

  // API Key 型厂商真实额度查询：解密后取 apiKey + consoleJwt，调对应控制台接口拿资源包余额；
  // 百炼免费额度为一次性 90 天快照，随绑定时的控制台会话捕获落库（账号级聚合功耗，见方案 §6.1）
  ipcMain.handle('provider:fetch-quota', async (_e, providerId: string, encrypted: string) => {
    if (!encrypted) return { ok: false, error: '缺少密钥' }
    try {
      if (providerId === 'bailian') {
        const plain = safeStorage.decryptString(Buffer.from(encrypted ?? '', 'base64'))
        const { freeTiers } = decodeBailianPayload(plain)
        // 展示口径：只统计视频生成模型且未过期的免费额度，与「查看模型」明细口径一致
        const tiers = (freeTiers ?? []).filter(
          (t) => isBailianVideoFreeModel(t.model) && !t.expired
        )
        return { ok: true, quota: aggregateBailianFreeQuota(tiers) }
      }
      const plain = safeStorage.decryptString(Buffer.from(encrypted ?? '', 'base64'))
      const { apiKey, consoleJwt } = decodeZhipuPayload(plain)
      if (!apiKey) return { ok: false, error: '未解析到 API Key' }
      return providerId === 'volcengine'
        ? await fetchVolcengineQuota(apiKey, consoleJwt ?? undefined)
        : await fetchZhipuQuota(apiKey, consoleJwt ?? undefined)
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : '额度查询失败' }
    }
  })

  // 智谱控制台会话捕获：按账号 keyId 弹出对应分区控制台登录窗口并捕获访问令牌（consoleJwt）
  ipcMain.handle('provider:capture-zhipu-session', async (_e, keyId?: string) => {
    return captureZhipuConsoleSession({ keyId: typeof keyId === 'string' && keyId ? keyId : undefined })
  })

  // 火山方舟控制台会话捕获：按账号 keyId 弹出对应分区控制台登录窗口并捕获访问令牌（consoleJwt）
  ipcMain.handle('provider:capture-volc-session', async (_e, keyId?: string) => {
    // 绑定窗口初始落在「开通管理 → 视觉模型」页：该页首屏即调 ListModelChargeItems，其响应
    // FeaturedImage.BucketName 形如 ark-auto-{accountId}-cn-beijing-default，是「当前登录账号」专有 id，
    // 注入脚本据此写入 __VF_ACCOUNT__。这样「绑定第二把同账号 API Key」时就能拿到账号级去重键，命中
    // 「更新已有/新建」提示（对齐智谱 customerId 策略），而不是退化到按 API Key 哈希。
    // 用户在该页左侧导航切到「API Key 管理」复制 Key 属 SPA 内路由，__VF_ACCOUNT__ 得以保留。
    return captureVolcEngineConsoleSession({
      keyId: typeof keyId === 'string' && keyId ? keyId : undefined,
      targetUrl: VOLC_OPEN_MANAGEMENT_URL
    })
  })

  // 百炼控制台会话捕获：按账号 keyId 弹出对应分区控制台窗口，捕获账号 PK + 免费额度整表快照，
  // 并把原始额度文本解析为归一化条目返回（随加密 payload 落库，供账号级去重 + 聚合总额展示）
  ipcMain.handle('provider:capture-bailian-session', async (_e, keyId?: string) => {
    const res = await captureBailianConsoleSession({
      keyId: typeof keyId === 'string' && keyId ? keyId : undefined
    })
    if (!res.ok) return { ok: false, error: res.error }
    const tiers = res.freeTiersRaw ? parseBailianFreeTierPayload(res.freeTiersRaw) : null
    if (tiers === null || tiers.length === 0) {
      return { ok: false, error: '未捕获到有效免费额度，请确认已打开「免费额度」视觉模型页' }
    }
    console.log(
      `[qf-bailian] CAPTURE parsed accountId=${res.accountId ?? 'NO'} tiers=${tiers.length} remaining=${aggregateBailianFreeQuota(tiers).remaining}`
    )
    return { ok: true, accountId: res.accountId ?? null, freeTiers: tiers }
  })

  // 火山方舟控制台会话状态：视 JWT 的 exp 判定 alive / expiring / expired
  ipcMain.handle(
    'provider:volc-session-status',
    async (_e, _providerId: string, keyId: string, encrypted: string) => {
      if (!encrypted) return { hasSession: false }
      try {
        const plain = safeStorage.decryptString(Buffer.from(encrypted ?? '', 'base64'))
        const { consoleJwt } = decodeVolcenginePayload(plain)
        if (!consoleJwt) return { hasSession: false }
        const expMs = jwtExpiryMs(consoleJwt)
        if (expMs === null) return { hasSession: true, status: 'alive', expMs: null, remainingMs: null }
        const remainingMs = expMs - Date.now()
        const status = remainingMs <= 0 ? 'expired' : remainingMs <= 10 * 60 * 1000 ? 'expiring' : 'alive'
        return { hasSession: true, status, expMs, remainingMs }
      } catch {
        return { hasSession: false }
      }
    }
  )

  // 火山方舟控制台会话静默续期：隐藏窗口复用该账号分区登录态 cookie 重新捕获新 JWT，成功则重建加密负载
  ipcMain.handle(
    'provider:volc-renew-session',
    async (_e, _providerId: string, keyId: string, encrypted: string) => {
      if (!encrypted) return { ok: false, reason: 'no-secret', error: '缺少密钥' }
      try {
        const plain = safeStorage.decryptString(Buffer.from(encrypted ?? '', 'base64'))
        const { apiKey, consoleJwt, accountId } = decodeVolcenginePayload(plain)
        if (!apiKey) return { ok: false, reason: 'no-key', error: '未解析到 API Key' }
        const res = await captureVolcEngineConsoleSession({
          quiet: true,
          keyId: typeof keyId === 'string' && keyId ? keyId : undefined,
          oldConsoleJwt: consoleJwt ?? null
        })
        if (!res.ok || !res.consoleJwt) {
          return { ok: false, reason: 'capture-failed', error: res.error ?? '静默续期失败' }
        }
        const newJwt = res.consoleJwt
        // 保留已知 accountId；静默续期若有新捕获的账号 id 则一并更新（保证去重键稳定）
        const newAccountId = res.accountId ?? accountId ?? null
        const newPlain = JSON.stringify({ v: 1, apiKey, consoleJwt: newJwt, accountId: newAccountId })
        const newEncrypted = safeStorage.encryptString(newPlain).toString('base64')
        const expMs = jwtExpiryMs(newJwt)
        const remainingMs = expMs === null ? null : expMs - Date.now()
        return { ok: true, encrypted: newEncrypted, expMs, remainingMs }
      } catch (e) {
        return { ok: false, reason: 'error', error: e instanceof Error ? e.message : '静默续期失败' }
      }
    }
  )

  // 火山方舟额度同步：后台打开「开通管理」页（复用该账号分区登录态），静默抓取最新免费模型额度/开通状态，
  // 成功则重建加密负载（更新 models + 最新 consoleJwt/accountId）返回 newEncrypted，供渲染层落库并刷新展示。
  ipcMain.handle(
    'provider:volc-sync-models',
    async (_e, _providerId: string, keyId: string, encrypted: string, maxStaleMs?: number) => {
      if (!encrypted) return { ok: false, reason: 'no-secret', error: '缺少密钥' }
      // 缓存命中：maxStaleMs>0 且上次同步成功未超期，且负载里已有 models → 直接返回，跳过一次 webview 同步让弹窗秒开
      if (typeof maxStaleMs === 'number' && maxStaleMs > 0) {
        try {
          const plain = safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
          const { models } = decodeVolcenginePayload(plain)
          const syncedAt = volcSyncAt.get(keyId)
          if (Array.isArray(models) && models.length > 0 && typeof syncedAt === 'number' && Date.now() - syncedAt < maxStaleMs) {
            logVolcSync(`SYNC_CACHED key=${keyId}`)
            return { ok: true, cached: true }
          }
        } catch {
          /* 负载解析失败则按未命中继续走完整同步 */
        }
      }
      volcSyncHbSig = '' // 新一次同步重置心跳节流，保证每次都会记录首个状态快照
      volcSyncModelBodySig = ''
      volcSyncRawBodySig = ''
      volcSyncRawUrlsSig = ''
      volcSyncTokensSig = ''
      volcSyncHbFired = false
      volcSyncHbLast = null
      logVolcSync(`SYNC_START key=${keyId}`)
      try {
        const plain = safeStorage.decryptString(Buffer.from(encrypted ?? '', 'base64'))
        const { apiKey, consoleJwt, accountId } = decodeVolcenginePayload(plain)
        if (!apiKey) return { ok: false, reason: 'no-key', error: '未解析到 API Key' }
        const res = await captureVolcEngineConsoleSession({
          quiet: true,
          syncModels: true,
          keyId: typeof keyId === 'string' && keyId ? keyId : undefined,
          oldConsoleJwt: consoleJwt ?? null,
          targetUrl: VOLC_OPEN_MANAGEMENT_URL
        })
        // 成功且抓到了额度卡片 → 用最新 models + 最新 JWT 重建负载回库
        if (res.ok && res.source === 'console' && Array.isArray(res.models) && res.models.length > 0) {
          const newJwt = res.consoleJwt ?? consoleJwt ?? null
          const newAccountId = res.accountId ?? accountId ?? null
          const newPlain = JSON.stringify({ v: 1, apiKey, consoleJwt: newJwt, accountId: newAccountId, models: res.models })
          const newEncrypted = safeStorage.encryptString(newPlain).toString('base64')
          // 同步后回填账号级指纹（对齐智谱 customerId 策略）：一旦抓到该账号稳定 id，就重算指纹供渲染层落库，
          // 让同账号多把 API Key 在库里共享同一 account_fingerprint，后续绑定即可命中「更新已有/新建」去重提示。
          let newFingerprint: string | null = null
          if (newAccountId) {
            newFingerprint = await volcengineAccountFingerprint(newPlain)
          }
          volcSyncAt.set(keyId, Date.now()) // 记录本次成功同步时间，供后续缓存判断
          console.log(`[volc-sync] 回写 models=${res.models.map((m) => m.id).join(',')} accountId=${newAccountId ?? 'NO'}`)
          logVolcSync(`SYNC_BACKFILL key=${keyId} accountId=${newAccountId ? 'YES' : 'NO'} fp=${newFingerprint ? 'account' : (accountId ? 'account' : 'key-hash')}`)
          logVolcSync(`SYNC_WRITEBACK key=${keyId} models=${res.models.map((m) => m.id).join(',')} accountId=${newAccountId ? 'YES' : 'NO'} fp=${newFingerprint ? 'account' : 'key-hash'}`)
          return { ok: true, encrypted: newEncrypted, models: res.models, accountFingerprint: newFingerprint }
        }
        // 同步超时/未抓到（登录态失效或页面未就绪）：保留旧额度，不报错，交由调用方提示可稍后手动刷新
        logVolcSync(`SYNC_PRESERVED key=${keyId} ok=${res.ok} source=${(res as { source?: string }).source ?? '?'}`)
        return { ok: true, preserved: true }
      } catch (e) {
        return { ok: false, reason: 'error', error: e instanceof Error ? e.message : '额度同步失败' }
      }
    }
  )
  ipcMain.handle(
    'provider:zhipu-session-status',
    async (_e, _providerId: string, keyId: string, encrypted: string) => {
      if (!encrypted) return { hasSession: false }
      try {
        const plain = safeStorage.decryptString(Buffer.from(encrypted ?? '', 'base64'))
        const { consoleJwt } = decodeZhipuPayload(plain)
        return zhipuConsoleSessionState(consoleJwt)
      } catch {
        return { hasSession: false }
      }
    }
  )

  // 智谱控制台会话静默续期：按账号 keyId 隐藏窗口复用该账号分区登录态 cookie 重新捕获新 JWT，命中后重建加密负载返回
  ipcMain.handle(
    'provider:zhipu-renew-session',
    async (_e, _providerId: string, keyId: string, encrypted: string) => {
      if (!encrypted) return { ok: false, reason: 'no-secret', error: '缺少密钥' }
      try {
        const plain = safeStorage.decryptString(Buffer.from(encrypted ?? '', 'base64'))
        const { apiKey, consoleJwt } = decodeZhipuPayload(plain)
        if (!apiKey) return { ok: false, reason: 'no-key', error: '未解析到 API Key' }
        const res = await captureZhipuConsoleSession({
          quiet: true,
          keyId: typeof keyId === 'string' && keyId ? keyId : undefined,
          oldConsoleJwt: consoleJwt ?? null
        })
        if (!res.ok || !res.consoleJwt) {
          return { ok: false, reason: 'capture-failed', error: res.error ?? '静默续期失败' }
        }
        const newJwt = res.consoleJwt
      // 重建加密负载（保留 apiKey，替换 consoleJwt），返回新 encrypted 供渲染层落库
        const newPlain = JSON.stringify({ v: 1, apiKey, consoleJwt: newJwt })
        const newEncrypted = safeStorage.encryptString(newPlain).toString('base64')
        const st = zhipuConsoleSessionState(newJwt)
        return {
          ok: true,
          encrypted: newEncrypted,
          ...(st.hasSession ? { expMs: st.expMs, remainingMs: st.remainingMs } : {})
        }
      } catch (e) {
        return { ok: false, reason: 'error', error: e instanceof Error ? e.message : '静默续期失败' }
      }
    }
  )

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
