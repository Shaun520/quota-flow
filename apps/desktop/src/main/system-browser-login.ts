import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import WebSocket from 'ws'
import type { OriginStorage, ProviderCookie } from './providers'

const DOLA_URL = 'https://www.dola.com/'
const CDP_REQUEST_TIMEOUT_MS = 10 * 1000
// 官方权限流首次连接会弹「允许调试？」提示，等待用户点击的窗口
const ALLOW_DEBUG_TIMEOUT_MS = 45 * 1000

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface BrowserCandidate {
  name: 'Edge' | 'Chrome'
  exe: string
  /** 本机该浏览器真实的用户数据目录（User Data），登录复用此目录让 Google 识别为「受信任的已知设备」 */
  profileDir: string
}

interface CdpCookie {
  name: string
  value: string
  domain: string
  path: string
  httpOnly: boolean
  secure: boolean
  expires?: number
}

interface CdpResponse {
  id?: number
  result?: Record<string, unknown>
  error?: { message: string }
}

interface RuntimeEvaluateResult<T = Record<string, unknown>> {
  result?: { value?: T }
}

interface DolaStorageValue {
  origin: string
  localStorage: Array<{ key: string; value: string }>
  sessionStorage: Array<{ key: string; value: string }>
}

export interface DolaAuthState {
  httpStatus: number
  userId: number
  hasAvatar: boolean
  url: string
}

export const DOLA_AUTH_STATE_EXPRESSION = `(async () => {
  try {
    const url = location.href;
    if (!/^https:\\/\\/(www\\.)?dola\\.com$/i.test(location.origin)) {
      return { httpStatus: 0, userId: 0, hasAvatar: false, url };
    }
    const hasAvatar = !!document.querySelector('[data-testid="chat_header_avatar_button"]');
    const response = await fetch(
      'https://www.dola.com/passport/account/info/v2/?account_sdk_source=web&sdk_version=2.2.11-doubao.0&device_platform=web',
      { credentials: 'include', cache: 'no-store' }
    );
    const json = await response.json().catch(() => null);
    const data = json && typeof json === 'object' ? json.data : null;
    const userId = Number(data && data.user_id);
    return {
      httpStatus: response.status,
      userId: Number.isFinite(userId) && userId > 0 ? userId : 0,
      hasAvatar,
      url
    };
  } catch {
    return { httpStatus: 0, userId: 0, hasAvatar: false, url: location.href };
  }
})()`

export function toDolaAuthState(value: unknown): DolaAuthState {
  if (!value || typeof value !== 'object') {
    return { httpStatus: 0, userId: 0, hasAvatar: false, url: '' }
  }
  const record = value as Record<string, unknown>
  const userId = Number(record.userId)
  const httpStatus = Number(record.httpStatus)
  return {
    httpStatus: Number.isFinite(httpStatus) ? httpStatus : 0,
    userId: Number.isFinite(userId) && userId > 0 ? userId : 0,
    hasAvatar: record.hasAvatar === true,
    url: typeof record.url === 'string' ? record.url : ''
  }
}

export interface SystemBrowserLoginData {
  cookies: ProviderCookie[]
  storages: OriginStorage[]
}

/** 本机 Chrome/Edge 的真实 User Data 目录：官方权限调试的 DevToolsActivePort 就写在这里 */
function realProfileDirFor(name: 'Edge' | 'Chrome'): string {
  const localAppData = process.env['LOCALAPPDATA'] || process.env['LocalAppData'] || ''
  return name === 'Chrome'
    ? join(localAppData, 'Google', 'Chrome', 'User Data')
    : join(localAppData, 'Microsoft', 'Edge', 'User Data')
}

function findSystemBrowser(): BrowserCandidate {
  const env = process.env as Record<string, string | undefined>
  const programFilesX86 = env['ProgramFiles(x86)'] || env['ProgramFilesX86'] || ''
  const programFiles = env['ProgramFiles'] || env['PROGRAMFILES'] || ''
  const localAppData = env['LOCALAPPDATA'] || env['LocalAppData'] || ''
  // Chrome 优先，Edge 仅作本机未安装 Chrome 时的兜底。
  const candidates: Array<[BrowserCandidate['name'], string]> = [
    ['Chrome', join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe')],
    ['Chrome', join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe')],
    ['Chrome', join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe')],
    ['Edge', join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe')],
    ['Edge', join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe')],
    ['Edge', join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe')]
  ]
  for (const [name, exe] of candidates) {
    if (exe && existsSync(exe)) return { name, exe, profileDir: realProfileDirFor(name) }
  }
  throw new Error('未找到 Chrome 或 Edge，请先安装浏览器后重试')
}

/** 读取官方 chrome://inspect 权限调试端口（Chrome 146+ 官方支持对「真实 profile」调试，不拷贝、不报不安全）。
 *  前置要求：用户在真实 Chrome/Edge 中打开 chrome://inspect/#remote-debugging 并开启「Enable remote debugging」。
 *  注意：权限流不提供 /json/list 这类 HTTP 接口，需用 DevToolsActivePort 第二行给出的浏览器级 ws token。 */
async function ensureOfficialBrowser(): Promise<{ browserName: string; browserWsUrl: string }> {
  const browser = findSystemBrowser()
  const activePortFile = join(browser.profileDir, 'DevToolsActivePort')
  if (!existsSync(activePortFile)) {
    throw new Error(
      `未检测到调试端口。请先打开本机 ${browser.name}，在地址栏输入 chrome://inspect/#remote-debugging，打开「Enable remote debugging」开关（只需开启一次），然后重新点击登录`
    )
  }
  let raw = ''
  try {
    raw = readFileSync(activePortFile, 'utf8')
  } catch {
    throw new Error('读取调试端口信息失败，请确认浏览器运行中，并在 chrome://inspect/#remote-debugging 重新开启开关')
  }
  const lines = raw.split(/\r?\n/)
  const port = Number((lines[0] || '').trim())
  const token = (lines[1] || '').trim()
  if (!Number.isFinite(port) || port <= 0 || !token.startsWith('/')) {
    throw new Error('调试端口信息无效，请在 chrome://inspect/#remote-debugging 重新开启开关后重试')
  }
  return { browserName: browser.name, browserWsUrl: `ws://127.0.0.1:${port}${token}` }
}

/** 连接浏览器级调试端点（带 token），端口未就绪时重试。 */
async function connectBrowser(browserWsUrl: string): Promise<CdpClient> {
  const deadline = Date.now() + ALLOW_DEBUG_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      return await CdpClient.connect(browserWsUrl)
    } catch {
      await sleep(1500)
    }
  }
  throw new Error('无法连接浏览器调试端口，请确认已在 chrome://inspect/#remote-debugging 开启「Enable remote debugging」后重试')
}

interface CdpTargetInfo {
  targetId: string
  type: string
  url: string
}

/** 找到（或新建）dola 页面并附加会话；官方权限流首次附加会弹「允许调试？」提示，重试等待用户点击。 */
async function attachDolaPage(client: CdpClient): Promise<string> {
  const deadline = Date.now() + ALLOW_DEBUG_TIMEOUT_MS
  let lastError: Error | null = null
  while (Date.now() < deadline) {
    try {
      const { targetInfos } = await client.send<{ targetInfos: CdpTargetInfo[] }>('Target.getTargets')
      let page = targetInfos.find((t) => t.type === 'page' && /dola\.com/i.test(t.url))
      if (!page) {
        const created = await client.send<{ targetId: string }>('Target.createTarget', { url: DOLA_URL })
        page = { targetId: created.targetId, type: 'page', url: DOLA_URL }
      }
      const { sessionId } = await client.send<{ sessionId: string }>(
        'Target.attachToTarget',
        { targetId: page.targetId, flatten: true }
      )
      if (sessionId) return sessionId
      throw new Error('附加到 Dola 页面失败')
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e))
      await sleep(1500)
    }
  }
  throw new Error(
    `附加到 Dola 页面失败，请在浏览器弹出的「允许调试」提示中点击「允许」后重试（${lastError?.message ?? ''}）`
  )
}

function isDolaCookieDomain(domain: string): boolean {
  const normalized = domain.replace(/^\./, '').toLowerCase()
  return normalized === 'dola.com' || normalized.endsWith('.dola.com')
}

function mapCdpCookie(cookie: CdpCookie): ProviderCookie {
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path || '/',
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    expires: typeof cookie.expires === 'number' && cookie.expires > 0 ? cookie.expires * 1000 : 0
  }
}

class CdpClient {
  private readonly ws: WebSocket
  private readonly pending = new Map<
    number,
    {
      resolve: (message: CdpResponse) => void
      reject: (error: Error) => void
    }
  >()
  private nextId = 1
  private closed = false

  private constructor(ws: WebSocket) {
    this.ws = ws
    this.ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString()) as CdpResponse
        if (!message.id) return
        const waiter = this.pending.get(message.id)
        if (!waiter) return
        this.pending.delete(message.id)
        if (message.error) {
          waiter.reject(new Error(message.error.message || 'CDP 命令失败'))
        } else {
          waiter.resolve(message)
        }
      } catch {
        // 忽略无法解析的调试消息。
      }
    })
    this.ws.on('error', () => {
      this.closed = true
      this.rejectAll(new Error('调试连接发生错误'))
    })
    this.ws.on('close', () => {
      this.closed = true
      this.rejectAll(new Error('调试连接已关闭'))
    })
  }

  static connect(url: string, timeoutMs = 8000): Promise<CdpClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { perMessageDeflate: false })
      let timer: NodeJS.Timeout | undefined
      let settled = false
      const finish = (error?: Error): void => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        if (error) reject(error)
        else resolve(new CdpClient(ws))
      }
      // 必须一直挂着 error 监听：连接建立前被关闭（如超时 terminate）会异步抛
      // 「WebSocket was closed before the connection was established」，无监听会变成未捕获异常导致主进程崩溃。
      ws.on('error', (e) => finish(e instanceof Error ? e : new Error(String(e))))
      timer = setTimeout(() => {
        try {
          ws.terminate()
        } catch {}
        finish(new Error('连接调试页面超时'))
      }, timeoutMs)
      ws.once('open', () => finish())
    })
  }

  async send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string
  ): Promise<T> {
    const message = await this.rawSend(method, params, sessionId)
    return (message.result ?? {}) as T
  }

  close(): void {
    try {
      this.ws.close()
    } catch {
      // 连接已关闭。
    }
  }

  private rawSend(
    method: string,
    params: Record<string, unknown>,
    sessionId?: string
  ): Promise<CdpResponse> {
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(new Error('调试连接已关闭'))
        return
      }
      const id = this.nextId
      this.nextId += 1
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP 请求超时：${method}`))
      }, CDP_REQUEST_TIMEOUT_MS)
      this.pending.set(id, {
        resolve: (message) => {
          clearTimeout(timer)
          resolve(message)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        }
      })
      const payload: Record<string, unknown> = { id, method, params }
      if (sessionId) payload.sessionId = sessionId
      this.ws.send(JSON.stringify(payload))
    })
  }

  private rejectAll(error: Error): void {
    for (const [id, waiter] of this.pending) {
      this.pending.delete(id)
      waiter.reject(error)
    }
  }
}

const STORAGE_READ_EXPRESSION = `(() => {
  const read = (store) => {
    const out = [];
    try {
      for (let i = 0; i < store.length; i += 1) {
        const key = store.key(i);
        const value = store.getItem(key);
        if (key && value !== null && value.length <= 262144) out.push({ key, value });
      }
    } catch {}
    return out;
  };
  try {
    return {
      origin: location.origin,
      localStorage: read(localStorage),
      sessionStorage: read(sessionStorage)
    };
  } catch {
    return { origin: location.origin, localStorage: [], sessionStorage: [] };
  }
})()`

/** 从已附加的 dola 页面会话读取站点存储（与内置 webview 一致：cookie 走全局，storage 只取当前页 origin）。 */
async function collectDolaStorage(client: CdpClient, sessionId: string): Promise<OriginStorage[]> {
  try {
    const result = await client.send<RuntimeEvaluateResult<DolaStorageValue>>(
      'Runtime.evaluate',
      { expression: STORAGE_READ_EXPRESSION, returnByValue: true },
      sessionId
    )
    const payload = result.result?.value
    if (payload?.origin) {
      return [
        {
          origin: payload.origin,
          localStorage: payload.localStorage ?? [],
          sessionStorage: payload.sessionStorage ?? []
        }
      ]
    }
  } catch {
    // 读不到 storage 时返回空，不影响登录。
  }
  return []
}

async function readDolaAuthState(client: CdpClient, sessionId: string): Promise<DolaAuthState> {
  try {
    const result = await client.send<RuntimeEvaluateResult<unknown>>(
      'Runtime.evaluate',
      {
        expression: DOLA_AUTH_STATE_EXPRESSION,
        returnByValue: true,
        awaitPromise: true
      },
      sessionId
    )
    return toDolaAuthState(result.result?.value)
  } catch {
    return { httpStatus: 0, userId: 0, hasAvatar: false, url: '' }
  }
}

export async function collectDolaSystemBrowserLogin(
  isSessionReady: (cookies: ProviderCookie[], authState: DolaAuthState) => boolean
): Promise<SystemBrowserLoginData> {
  let client: CdpClient | null = null
  try {
    const browser = await ensureOfficialBrowser()
    // 浏览器级连接（官方权限流不提供 /json/list，必须用 DevToolsActivePort 的 ws token）
    client = await connectBrowser(browser.browserWsUrl)
    // 附加到 dola 页面会话（首次会弹「允许调试」，自动重试等待用户点击）
    const sessionId = await attachDolaPage(client)
    await client.send('Runtime.enable', {}, sessionId)
    await client.send('Network.enable', {}, sessionId)

    // 重要：Google 登录期间只要附加了 DevTools 就会被识别为「浏览器不安全」。
    // 因此这里不主动清会话、不等新登录——用户在「未附加调试」的真实浏览器里完成登录后，
    // 本函数只负责把已登录的会话（cookie + storage）抓下来。
    const network = await client.send<{ cookies: CdpCookie[] }>('Network.getAllCookies', {}, sessionId)
    const cookies = network.cookies
      .map(mapCdpCookie)
      .filter((cookie) => isDolaCookieDomain(cookie.domain))
    const authState = await readDolaAuthState(client, sessionId)
    if (!isSessionReady(cookies, authState)) {
      throw new Error(
        '未检测到已登录的 dola 会话。请先在浏览器中完成 dola 登录（谷歌账号需在未附加调试的浏览器里登录，否则会被 Google 拦截），然后重新点击「系统浏览器登录」'
      )
    }
    const storages = await collectDolaStorage(client, sessionId)
    return { cookies, storages }
  } finally {
    if (client) client.close()
    // 官方权限流不接管浏览器生命周期：只断开调试连接，不关闭用户自己的 Chrome
  }
}
