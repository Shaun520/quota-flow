import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import WebSocket from 'ws'
import type { OriginStorage, ProviderCookie } from './providers'

const DOLA_URL = 'https://www.dola.com/'
const DOLA_PROFILE_DIR_NAME = 'system-browser-dola'
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000
const POLL_INTERVAL_MS = 1500
const READY_TIMEOUT_MS = 20 * 1000
const CDP_REQUEST_TIMEOUT_MS = 10 * 1000

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

let activeChild: ChildProcess | null = null
let activePort = 0
let activeBrowserName: 'Chrome' | 'Edge' | null = null

interface BrowserCandidate {
  name: 'Edge' | 'Chrome'
  exe: string
}

interface CdpTarget {
  id: string
  type: string
  url: string
  webSocketDebuggerUrl?: string
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

function dolaProfileDir(): string {
  return join(app.getPath('userData'), DOLA_PROFILE_DIR_NAME)
}

function devToolsPortFile(): string {
  return join(dolaProfileDir(), 'DevToolsActivePort')
}

async function requestJson<T>(url: string, method = 'GET'): Promise<T> {
  const res = await fetch(url, { method })
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`)
  }
  return (await res.json()) as T
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
    if (exe && existsSync(exe)) return { name, exe }
  }
  throw new Error('未找到 Chrome 或 Edge，请先安装浏览器后重试')
}

async function waitForDevToolsPort(
  timeoutMs: number,
  child: ChildProcess | null
): Promise<number> {
  const file = devToolsPortFile()
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      try {
        const raw = readFileSync(file, 'utf8')
        const port = Number(raw.split(/\r?\n/)[0])
        if (port > 0) {
          await requestJson(`http://127.0.0.1:${port}/json/version`)
          activePort = port
          return port
        }
      } catch {
        // 浏览器刚启动，端口文件可能已写但调试端点尚未就绪。
      }
    }
    if (child && child.exitCode !== null) {
      throw new Error('浏览器启动失败或已退出')
    }
    await sleep(250)
  }
  throw new Error('等待浏览器调试端口超时，请重试')
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null) return
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && child.exitCode === null) {
    await sleep(100)
  }
}

async function sendBrowserCommandClose(port: number): Promise<void> {
  try {
    const version = await requestJson<{ webSocketDebuggerUrl?: string }>(
      `http://127.0.0.1:${port}/json/version`
    )
    if (!version.webSocketDebuggerUrl) return
    const client = await CdpClient.connect(version.webSocketDebuggerUrl)
    try {
      await client.send('Browser.close')
    } catch {
      // 浏览器关闭后连接会立刻断开，忽略该结果。
    }
    client.close()
  } catch {
    // 已关闭或无法连接时无需处理。
  }
}

async function closeSystemBrowser(port: number): Promise<void> {
  const child = activeChild
  activeChild = null
  activePort = 0
  activeBrowserName = null
  if (port > 0) {
    await sendBrowserCommandClose(port)
  }
  if (child && child.exitCode === null) {
    try {
      child.kill()
      await waitForChildExit(child, 3000)
    } catch {
      // 进程可能已退出。
    }
  }
}

async function ensureDolaBrowser(): Promise<{ port: number; browserName: string }> {
  const browser = findSystemBrowser()
  const profileDir = dolaProfileDir()
  mkdirSync(profileDir, { recursive: true })

  // 优先使用当前选中的浏览器；若旧实例不是 Chrome/Edge 首选，先关闭再启动。
  try {
    const port = await waitForDevToolsPort(1500, null)
    if (activeBrowserName === browser.name) {
      return { port, browserName: browser.name }
    }
    await closeSystemBrowser(port)
  } catch {
    // 继续启动新实例。
  }

  if (activeChild && activeChild.exitCode === null) {
    activeChild.kill()
    await waitForChildExit(activeChild, 3000)
  }
  try {
    rmSync(devToolsPortFile(), { force: true })
  } catch {
    // 文件不存在或占用时忽略。
  }

  const child = spawn(
    browser.exe,
    [
      `--user-data-dir=${profileDir}`,
      '--remote-debugging-port=0',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-session-crashed-bubble',
      '--no-service-autorun',
      DOLA_URL
    ],
    { stdio: 'ignore', windowsHide: false }
  )
  activeChild = child
  activeBrowserName = browser.name
  child.once('exit', () => {
    if (activeChild === child) {
      activeChild = null
      activeBrowserName = null
    }
  })

  const port = await waitForDevToolsPort(READY_TIMEOUT_MS, child)
  return { port, browserName: browser.name }
}

async function ensureDolaPage(port: number): Promise<CdpTarget> {
  const openPage = async (): Promise<void> => {
    try {
      await requestJson(
        `http://127.0.0.1:${port}/json/new?${encodeURIComponent(DOLA_URL)}`,
        'PUT'
      )
    } catch {
      // 页面可能已存在，下一步会重新读取目标列表。
    }
  }

  for (let i = 0; i < 8; i += 1) {
    const targets = await requestJson<CdpTarget[]>(`http://127.0.0.1:${port}/json/list`)
    const page = targets.find(
      (t) => t.type === 'page' && /dola\.com/i.test(t.url) && !!t.webSocketDebuggerUrl
    )
    if (page) return page
    if (i === 0) await openPage()
    await sleep(500)
  }
  throw new Error('无法打开 Dola 登录页面')
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

  static connect(url: string): Promise<CdpClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { perMessageDeflate: false })
      const onError = (error: Error): void => {
        reject(error)
      }
      ws.once('error', onError)
      ws.once('open', () => {
        ws.removeListener('error', onError)
        resolve(new CdpClient(ws))
      })
    })
  }

  async send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {}
  ): Promise<T> {
    const message = await this.rawSend(method, params)
    return (message.result ?? {}) as T
  }

  close(): void {
    try {
      this.ws.close()
    } catch {
      // 连接已关闭。
    }
  }

  private rawSend(method: string, params: Record<string, unknown>): Promise<CdpResponse> {
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
      this.ws.send(JSON.stringify({ id, method, params }))
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

async function collectDolaStorages(port: number): Promise<OriginStorage[]> {
  const targets = await requestJson<CdpTarget[]>(`http://127.0.0.1:${port}/json/list`)
  const storages: OriginStorage[] = []
  const seen = new Set<string>()
  for (const target of targets) {
    if (target.type !== 'page' || !/dola\.com/i.test(target.url) || !target.webSocketDebuggerUrl) {
      continue
    }
    try {
      const client = await CdpClient.connect(target.webSocketDebuggerUrl)
      try {
        await client.send('Runtime.enable')
        const result = await client.send<RuntimeEvaluateResult<DolaStorageValue>>('Runtime.evaluate', {
          expression: STORAGE_READ_EXPRESSION,
          returnByValue: true
        })
        const payload = result.result?.value
        if (payload?.origin && !seen.has(payload.origin)) {
          seen.add(payload.origin)
          storages.push({
            origin: payload.origin,
            localStorage: payload.localStorage ?? [],
            sessionStorage: payload.sessionStorage ?? []
          })
        }
      } finally {
        client.close()
      }
    } catch {
      // 单个页面读不到 storage 时继续其他页面。
    }
  }
  return storages
}

async function readDolaAuthState(client: CdpClient): Promise<DolaAuthState> {
  try {
    const result = await client.send<RuntimeEvaluateResult<unknown>>('Runtime.evaluate', {
      expression: DOLA_AUTH_STATE_EXPRESSION,
      returnByValue: true,
      awaitPromise: true
    })
    return toDolaAuthState(result.result?.value)
  } catch {
    return { httpStatus: 0, userId: 0, hasAvatar: false, url: '' }
  }
}

export async function collectDolaSystemBrowserLogin(
  isSessionReady: (cookies: ProviderCookie[], authState: DolaAuthState) => boolean
): Promise<SystemBrowserLoginData> {
  let port = 0
  let client: CdpClient | null = null
  try {
    const browser = await ensureDolaBrowser()
    port = browser.port
    const target = await ensureDolaPage(port)
    if (!target.webSocketDebuggerUrl) {
      throw new Error('无法连接到 Dola 登录页面')
    }
    client = await CdpClient.connect(target.webSocketDebuggerUrl)
    await client.send('Runtime.enable')
    await client.send('Network.enable')

    const deadline = Date.now() + LOGIN_TIMEOUT_MS
    while (Date.now() < deadline) {
      try {
        const network = await client.send<{ cookies: CdpCookie[] }>('Network.getAllCookies')
        const cookies = network.cookies
          .map(mapCdpCookie)
          .filter((cookie) => isDolaCookieDomain(cookie.domain))
        const authState = await readDolaAuthState(client)
        if (isSessionReady(cookies, authState)) {
          await sleep(1200)
          const finalNetwork = await client.send<{ cookies: CdpCookie[] }>('Network.getAllCookies')
          const finalCookies = finalNetwork.cookies
            .map(mapCdpCookie)
            .filter((cookie) => isDolaCookieDomain(cookie.domain))
          const finalAuthState = await readDolaAuthState(client)
          if (!isSessionReady(finalCookies, finalAuthState)) continue
          const storages = await collectDolaStorages(port)
          return { cookies: finalCookies, storages }
        }
      } catch (error) {
        if (activeChild && activeChild.exitCode !== null) {
          throw new Error('登录浏览器已关闭，请重新登录')
        }
        throw new Error(
          `读取登录状态失败：${error instanceof Error ? error.message : String(error)}`
        )
      }
      await sleep(POLL_INTERVAL_MS)
    }
    throw new Error('等待 Dola 登录超时，请重新登录后重试')
  } finally {
    if (client) client.close()
    await closeSystemBrowser(port)
  }
}
