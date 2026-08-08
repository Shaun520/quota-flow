import { BrowserWindow, WebContentsView, ipcMain, session } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export type ProviderId = 'yuanbao' | 'qwenwan'

export interface WebviewTestEvent {
  provider: ProviderId
  type: 'nav' | 'title' | 'fail' | 'log' | 'capture' | 'poll' | 'error'
  message: string
  data?: unknown
  ts: number
}

interface ProviderDef {
  id: ProviderId
  label: string
  url: string
  partition: string
  authFile: string
  cookieUrl: string
  cookieDomain: string
  captureUrls: string[]
}

interface AuthConfig {
  cookie?: string
  agentId?: string
  conversationId?: string
  sessionId?: string
  deviceId?: string
  xXsrfToken?: string
  reqId?: string
  commonHeaders?: Record<string, unknown>
}

interface CapturedRequest {
  reqId?: string
  conversationId?: string
  sessionId?: string
  ts: number
}

const SIDEBAR_WIDTH = 360
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36'

// 开发态：out/main -> apps/desktop -> 仓库根目录；打包后 data/ 不随应用分发
const REPO_ROOT = join(__dirname, '..', '..', '..')

const PROVIDERS: Record<ProviderId, ProviderDef> = {
  yuanbao: {
    id: 'yuanbao',
    label: '元宝',
    url: 'https://yuanbao.tencent.com/chat/naQivTmsDa',
    partition: 'persist:yuanbao',
    authFile: join(REPO_ROOT, 'data', 'yuanbao-auth.json'),
    cookieUrl: 'https://yuanbao.tencent.com',
    cookieDomain: '.yuanbao.tencent.com',
    captureUrls: ['https://yuanbao.tencent.com/api/chat/*']
  },
  qwenwan: {
    id: 'qwenwan',
    label: '千问',
    url: 'https://www.qianwen.com/chat',
    partition: 'persist:qwenwan',
    authFile: join(REPO_ROOT, 'data', 'qwen-auth.json'),
    cookieUrl: 'https://www.qianwen.com',
    cookieDomain: '.qianwen.com',
    captureUrls: ['https://chat2.qianwen.com/api/v2/chat*']
  }
}

function readAuth(def: ProviderDef): AuthConfig | null {
  try {
    if (!existsSync(def.authFile)) return null
    const raw = readFileSync(def.authFile, 'utf-8').replace(/^\uFEFF/, '')
    return JSON.parse(raw) as AuthConfig
  } catch {
    return null
  }
}

const managers = new Map<number, WebviewTestManager>()
let handlersRegistered = false

export function initWebviewTest(win: BrowserWindow): void {
  const manager = new WebviewTestManager(win)
  managers.set(win.id, manager)
  win.on('closed', () => {
    managers.delete(win.id)
    manager.destroy()
  })
  if (!handlersRegistered) {
    handlersRegistered = true
    registerHandlers()
  }
}

function registerHandlers(): void {
  ipcMain.handle('webview-test:open', (e, provider: ProviderId) => managerFor(e).open(provider))
  ipcMain.handle('webview-test:close', (e, provider: ProviderId) => managerFor(e).close(provider))
  ipcMain.handle('webview-test:inject-cookies', (e, provider: ProviderId) =>
    managerFor(e).injectCookies(provider)
  )
  ipcMain.handle('webview-test:auto-send', (e, provider: ProviderId, prompt: string) =>
    managerFor(e).autoSend(provider, prompt)
  )
  ipcMain.handle('webview-test:inspect', (e, provider: ProviderId) =>
    managerFor(e).inspect(provider)
  )
  ipcMain.handle('webview-test:open-devtools', (e, provider: ProviderId) =>
    managerFor(e).openDevTools(provider)
  )
  ipcMain.handle('webview-test:poll', (e, provider: ProviderId) => managerFor(e).poll(provider))
}

function managerFor(e: Electron.IpcMainInvokeEvent): WebviewTestManager {
  const win = BrowserWindow.fromWebContents(e.sender)
  const manager = win ? managers.get(win.id) : undefined
  if (!manager) throw new Error('webview-test manager not found')
  return manager
}

class WebviewTestManager {
  private readonly views = new Map<ProviderId, WebContentsView>()
  private readonly captured = new Map<ProviderId, CapturedRequest>()
  private readonly captureReady = new Set<string>()

  constructor(private readonly win: BrowserWindow) {
    win.on('resize', () => this.layout())
  }

  async open(provider: ProviderId): Promise<{ ok: boolean; message: string }> {
    const def = PROVIDERS[provider]
    const existing = this.views.get(provider)
    if (existing) {
      existing.setVisible(true)
      this.layout()
      this.emit(def, 'log', '已显示现有 WebView')
      return { ok: true, message: '已显示现有 WebView' }
    }

    const ses = session.fromPartition(def.partition)
    ses.setUserAgent(UA)
    this.setupCapture(def, ses)

    const view = new WebContentsView({
      webPreferences: {
        partition: def.partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })
    const wc = view.webContents

    wc.setWindowOpenHandler(({ url }) => {
      // 登录弹窗放行为独立窗口（继承同一 session），其余外部链接走系统浏览器
      if (url.startsWith('http')) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: { width: 560, height: 720, autoHideMenuBar: true }
        }
      }
      return { action: 'deny' }
    })

    wc.on('did-navigate', (_e, url) => {
      this.emit(def, 'nav', `导航到 ${url.slice(0, 160)}`, { url })
    })
    wc.on('did-navigate-in-page', (_e, url) => {
      this.emit(def, 'nav', `页内跳转 ${url.slice(0, 160)}`, { url })
    })
    wc.on('page-title-updated', (_e, title) => {
      this.emit(def, 'title', `页面标题：${title.slice(0, 80)}`)
    })
    wc.on('did-fail-load', (_e, code, desc, url) => {
      this.emit(def, 'fail', `加载失败(${code}) ${desc} ${url.slice(0, 120)}`)
    })

    this.win.contentView.addChildView(view)
    this.views.set(provider, view)
    this.layout()
    try {
      await wc.loadURL(def.url)
    } catch (err) {
      this.emit(def, 'error', `加载失败：${err instanceof Error ? err.message : String(err)}`)
    }
    this.emit(def, 'log', `已打开 ${def.label} WebView`)
    return { ok: true, message: `已打开 ${def.label} WebView` }
  }

  async close(provider: ProviderId): Promise<void> {
    const view = this.views.get(provider)
    if (view) view.setVisible(false)
    this.layout()
  }

  async injectCookies(provider: ProviderId): Promise<{
    injected: number
    total: number
    errors: string[]
  }> {
    const def = PROVIDERS[provider]
    const auth = readAuth(def)
    const result = { injected: 0, total: 0, errors: [] as string[] }
    if (!auth?.cookie) {
      this.emit(
        def,
        'error',
        `未找到 ${def.authFile} 或其中没有 cookie 字段，可改为手动在 WebView 里登录`
      )
      return result
    }
    const ses = session.fromPartition(def.partition)
    const parts = auth.cookie
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean)
    result.total = parts.length
    for (const part of parts) {
      const idx = part.indexOf('=')
      if (idx <= 0) continue
      const name = part.slice(0, idx).trim()
      const value = part.slice(idx + 1).trim()
      if (!name || !value) continue
      try {
        await ses.cookies.set({
          url: def.cookieUrl,
          name,
          value,
          domain: def.cookieDomain,
          path: '/',
          secure: true
        })
        result.injected += 1
      } catch (err) {
        result.errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    this.emit(
      def,
      'log',
      `Cookie 注入 ${result.injected}/${result.total}${result.errors.length ? '，失败 ' + result.errors.length + ' 个' : ''}`,
      { errors: result.errors.slice(0, 5) }
    )
    return result
  }

  async autoSend(provider: ProviderId, prompt: string): Promise<{ ok: boolean; reason: string }> {
    const def = PROVIDERS[provider]
    const view = this.views.get(provider)
    if (!view || !view.getVisible()) {
      return { ok: false, reason: '请先打开 WebView' }
    }
    const script = buildAutoSendScript(prompt)
    const result = (await view.webContents.executeJavaScript(script, true)) as {
      ok: boolean
      reason: string
    }
    this.emit(def, 'log', `自动发送：${result.reason}`)
    return result
  }

  async inspect(provider: ProviderId): Promise<{
    inputFound: boolean
    inputTag: string
    candidates: Array<{
      tag: string
      cls: string
      aria: string
      title: string
      text: string
      disabled: boolean
      svg: boolean
    }>
  }> {
    const def = PROVIDERS[provider]
    const view = this.views.get(provider)
    if (!view || !view.getVisible()) {
      return { inputFound: false, inputTag: '', candidates: [] }
    }
    const result = (await view.webContents.executeJavaScript(
      `(() => {
        const norm = (s) => (s || '').trim();
        const input = [...document.querySelectorAll('textarea, [contenteditable="true"], [contenteditable="plaintext-only"], [role="textbox"]')].find((el) => el.offsetParent !== null) || null;
        const els = [...document.querySelectorAll('button, [role="button"], [class*="send" i], [class*="submit" i]')];
        return {
          inputFound: !!input,
          inputTag: input ? input.tagName.toLowerCase() : '',
          candidates: els.filter((el) => el.offsetParent !== null).slice(0, 15).map((el) => ({
            tag: el.tagName.toLowerCase(),
            cls: (typeof el.className === 'string' ? el.className : '').slice(0, 100),
            aria: el.getAttribute('aria-label') || '',
            title: el.getAttribute('title') || '',
            text: norm(el.textContent).slice(0, 24),
            disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
            svg: !!el.querySelector('svg')
          }))
        };
      })()`,
      true
    )) as {
      inputFound: boolean
      inputTag: string
      candidates: Array<{
        tag: string
        cls: string
        aria: string
        title: string
        text: string
        disabled: boolean
        svg: boolean
      }>
    }
    this.emit(
      def,
      'log',
      `DOM 诊断：输入框=${result.inputFound ? result.inputTag : '未找到'}，候选按钮 ${result.candidates.length} 个`,
      result
    )
    return result
  }

  async openDevTools(provider: ProviderId): Promise<void> {
    const view = this.views.get(provider)
    if (view) view.webContents.openDevTools({ mode: 'detach' })
  }

  async poll(provider: ProviderId): Promise<{
    ok: boolean
    videoUrl?: string
    posterUrl?: string
    error?: string
  }> {
    const def = PROVIDERS[provider]
    const auth = readAuth(def)
    if (!auth) return { ok: false, error: '未找到认证文件' }
    const cap = this.captured.get(provider)
    const reqId = cap?.reqId ?? auth.reqId
    const conversationId = cap?.conversationId ?? auth.conversationId
    const sessionId = cap?.sessionId ?? auth.sessionId
    if (provider === 'qwenwan' && !reqId) {
      return {
        ok: false,
        error: '没有 req_id：请先在 WebView 里发送一次视频生成，等待自动捕获，或在 DevTools 手动复制'
      }
    }
    if (provider === 'yuanbao' && !conversationId) {
      return { ok: false, error: '没有 conversationId：请先在 WebView 里发送一次，等待自动捕获' }
    }

    this.emit(
      def,
      'poll',
      `开始轮询（reqId=${reqId ?? '-'} / cid=${conversationId ?? '-'}，最多 24 次 × 5s）`,
      { reqId, conversationId }
    )
    const maxPolls = 24
    for (let i = 1; i <= maxPolls; i++) {
      try {
        if (provider === 'qwenwan') {
          const video = await pollQwenDetail(auth, sessionId ?? '', reqId ?? '')
          if (video) {
            this.emit(def, 'log', `第 ${i} 次轮询拿到视频：${video.url.slice(0, 140)}`, video)
            return { ok: true, videoUrl: video.url, posterUrl: video.posterUrl }
          }
        } else {
          const video = await pollYuanbaoDetail(auth, conversationId ?? '')
          if (video) {
            this.emit(def, 'log', `第 ${i} 次轮询拿到视频：${video.url.slice(0, 140)}`, video)
            return { ok: true, videoUrl: video.url }
          }
        }
      } catch (err) {
        this.emit(def, 'error', `轮询异常：${err instanceof Error ? err.message : String(err)}`)
      }
      this.emit(def, 'poll', `第 ${i}/${maxPolls} 次：尚未生成完成，5 秒后重试`)
      await sleep(5000)
    }
    return { ok: false, error: '2 分钟内未取到视频 URL，可能仍在生成或请求未真正触发' }
  }

  private setupCapture(def: ProviderDef, ses: Electron.Session): void {
    if (this.captureReady.has(def.partition)) return
    this.captureReady.add(def.partition)
    ses.webRequest.onBeforeRequest({ urls: def.captureUrls }, (details, callback) => {
      callback({})
      let bodyText = ''
      try {
        // Electron 类型定义未声明 requestBody，但运行时 onBeforeRequest 提供该字段
        const withBody = details as unknown as {
          requestBody?: { raw?: Array<{ bytes: Buffer | string }> }
        }
        const raw = withBody.requestBody?.raw
        if (raw?.length) {
          bodyText = Buffer.concat(
            raw.map((x) => (Buffer.isBuffer(x.bytes) ? x.bytes : Buffer.from(x.bytes)))
          ).toString('utf8')
        }
      } catch {
        /* 忽略解析失败 */
      }
      const cap: CapturedRequest = { ts: Date.now() }
      if (def.id === 'qwenwan') {
        try {
          const json = JSON.parse(bodyText) as { req_id?: string; session_id?: string }
          if (json.req_id) cap.reqId = json.req_id
          if (json.session_id) cap.sessionId = json.session_id
        } catch {
          /* 非 JSON body */
        }
      } else {
        const m = details.url.match(/\/api\/chat\/([^/?#]+)/)
        if (m) cap.conversationId = m[1]
        try {
          const json = JSON.parse(bodyText) as { conversationId?: string }
          if (json.conversationId) cap.conversationId = json.conversationId
        } catch {
          /* 非 JSON body */
        }
      }
      if (cap.reqId || cap.conversationId) {
        this.captured.set(def.id, cap)
        this.emit(
          def,
          'capture',
          `捕获生成请求：reqId=${cap.reqId ?? '-'} conversationId=${cap.conversationId ?? '-'}`,
          cap
        )
      }
    })
  }

  private layout(): void {
    const [w, h] = this.win.getContentSize()
    for (const view of this.views.values()) {
      if (view.getVisible()) {
        view.setBounds({
          x: SIDEBAR_WIDTH,
          y: 0,
          width: Math.max(200, w - SIDEBAR_WIDTH),
          height: h
        })
      }
    }
  }

  private emit(
    def: ProviderDef,
    type: WebviewTestEvent['type'],
    message: string,
    data?: unknown
  ): void {
    if (this.win.isDestroyed()) return
    const evt: WebviewTestEvent = { provider: def.id, type, message, data, ts: Date.now() }
    this.win.webContents.send('webview-test:event', evt)
  }

  destroy(): void {
    for (const view of this.views.values()) view.webContents.close()
    this.views.clear()
  }
}

function buildAutoSendScript(prompt: string): string {
  const promptJson = JSON.stringify(prompt)
  return `(() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => (s || '').trim();
  const isSendText = (t) => /发送|提交|生成/.test(t) && !/停止/.test(t);
  const findInput = () => {
    const sels = ['textarea', '[contenteditable="true"]', '[contenteditable="plaintext-only"]', '[role="textbox"]'];
    for (const s of sels) {
      const els = [...document.querySelectorAll(s)].filter((el) => el.offsetParent !== null);
      if (els.length) return els[0];
    }
    return null;
  };
  const setValue = (el, text) => {
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement : window.HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value').set;
      setter.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      el.focus();
      document.execCommand('insertText', false, text);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
    }
  };
  const findSend = () => {
    const btns = [...document.querySelectorAll('button, [role="button"], [class*="send" i], [class*="submit" i], [class*="action" i]')];
    const visible = btns.filter((b) => b.offsetParent !== null && b.disabled !== true && b.getAttribute('aria-disabled') !== 'true');
    // 1) 文字 / aria-label / title / data-testid 匹配
    const hit = visible.find((b) =>
      isSendText(norm(b.textContent)) ||
      isSendText(norm(b.getAttribute('aria-label'))) ||
      isSendText(norm(b.getAttribute('title'))) ||
      isSendText(norm(b.getAttribute('data-testid')))
    );
    if (hit) return hit;
    // 2) 输入框向上 4 层容器内最后一个带 SVG 图标的按钮（发送键通常是纯图标按钮）
    let node = findInput();
    for (let i = 0; i < 4 && node; i++) {
      const parent = node.parentElement;
      if (!parent) break;
      const icons = [...parent.querySelectorAll('button, [role="button"]')].filter(
        (b) => b.offsetParent !== null && b.querySelector('svg')
      );
      if (icons.length) return icons[icons.length - 1];
      node = parent;
    }
    // 3) 兜底：任意可见的 SVG 图标按钮，取最后一个
    const anyIcons = visible.filter((b) => b.querySelector('svg'));
    return anyIcons.length ? anyIcons[anyIcons.length - 1] : null;
  };
  return (async () => {
    const input = findInput();
    if (!input) return { ok: false, reason: '未找到输入框，请手动填写' };
    setValue(input, ${promptJson});
    await sleep(500);
    const send = findSend();
    if (!send) {
      const candidates = [...document.querySelectorAll('button, [role="button"], [class*="send" i], [class*="submit" i]')]
        .filter((b) => b.offsetParent !== null)
        .slice(0, 12)
        .map((b) => ({
          tag: b.tagName.toLowerCase(),
          cls: (typeof b.className === 'string' ? b.className : '').slice(0, 80),
          aria: b.getAttribute('aria-label') || '',
          text: norm(b.textContent).slice(0, 16),
          disabled: b.disabled === true || b.getAttribute('aria-disabled') === 'true',
          svg: !!b.querySelector('svg')
        }));
      return { ok: false, reason: '已填入 prompt，但未找到发送按钮。候选：' + JSON.stringify(candidates).slice(0, 600) };
    }
    send.click();
    return { ok: true, reason: '已填入并点击发送（' + norm(send.getAttribute('aria-label')) + norm(send.textContent) + '），等待页面开始生成' };
  })();
})()`
}

async function pollQwenDetail(
  auth: AuthConfig,
  sessionId: string,
  reqId: string
): Promise<{ url: string; posterUrl: string } | null> {
  const params = new URLSearchParams({
    biz_id: 'ai_qwen',
    chat_client: 'h5',
    device: 'pc',
    fr: 'pc',
    pr: 'qwen',
    ut: auth.deviceId ?? '',
    la: 'zh-CN',
    tz: 'Asia/Shanghai',
    wv: '4.1.4',
    ve: '4.1.4',
    session_id: sessionId,
    req_id: reqId + '_complete'
  })
  const res = await fetch(`https://chat2-api.qianwen.com/api/v1/session/req/detail?${params.toString()}`, {
    headers: {
      accept: '*/*',
      cookie: auth.cookie ?? '',
      'x-deviceid': auth.deviceId ?? '',
      'x-platform': 'pc_tongyi',
      'x-xsrf-token': auth.xXsrfToken ?? '',
      'user-agent': UA,
      referer: `https://www.qianwen.com/chat/${sessionId}`
    },
    signal: AbortSignal.timeout(15000)
  })
  if (res.status !== 200) return null
  const json = (await res.json()) as {
    code?: number
    data?: { response_messages?: Array<Record<string, unknown>> }
  }
  if (json.code !== 0 || !json.data?.response_messages) return null
  for (const msg of json.data.response_messages) {
    if (msg.mime_type !== 'multi_load/iframe') continue
    const meta = msg.meta_data as { multi_load?: Array<{ html?: { sc_html?: string } }> } | undefined
    const scHtml = meta?.multi_load?.[0]?.html?.sc_html
    if (!scHtml) continue
    const videoMatch = scHtml.match(/src="(https?:\/\/[^"]+\.mp4[^"]*)"/)
    if (videoMatch) {
      const posterMatch = scHtml.match(/poster="(https?:\/\/[^"]+\.jpg[^"]*)"/)
      return { url: videoMatch[1], posterUrl: posterMatch ? posterMatch[1] : '' }
    }
  }
  return null
}

async function pollYuanbaoDetail(
  auth: AuthConfig,
  conversationId: string
): Promise<{ url: string; downloadUrl: string } | null> {
  const headers: Record<string, string> = { cookie: auth.cookie ?? '' }
  if (auth.commonHeaders && typeof auth.commonHeaders === 'object') {
    for (const [k, v] of Object.entries(auth.commonHeaders)) {
      if (v != null && (typeof v === 'string' || typeof v === 'number')) headers[k] = String(v)
    }
  }
  headers['content-type'] = 'application/json'
  headers.accept = 'application/json, text/event-stream, text/plain, */*'
  headers.origin = 'https://yuanbao.tencent.com'
  headers.referer = `https://yuanbao.tencent.com/chat/${auth.agentId ?? ''}/${conversationId}`
  headers['user-agent'] = UA

  const res = await fetch('https://yuanbao.tencent.com/api/user/agent/conversation/v1/detail', {
    method: 'POST',
    headers,
    body: JSON.stringify({ conversationId }),
    signal: AbortSignal.timeout(15000)
  })
  if (res.status !== 200) return null
  const json = (await res.json()) as { convs?: Array<Record<string, unknown>> }
  if (!Array.isArray(json.convs)) return null
  const latestAi = [...json.convs].reverse().find((c) => c.speaker === 'ai')
  if (!latestAi) return null
  const speeches = latestAi.speechesV2 as Array<Record<string, unknown>> | undefined
  if (!Array.isArray(speeches)) return null
  let fallback: { url: string; downloadUrl: string } | null = null
  for (const sp of speeches) {
    const extra = (sp.extra ?? {}) as { replaces?: Array<{ multimedias?: Array<Record<string, unknown>> }> }
    for (const rp of extra.replaces ?? []) {
      for (const mm of rp.multimedias ?? []) {
        const url = mm.url as string | undefined
        if (!url || !url.includes('hunyuan-prod')) continue
        const candidate = {
          url,
          downloadUrl: (mm.downloadUrl as string) || url
        }
        if (mm.type !== 'loadingVideo') return candidate
        fallback = candidate
      }
    }
  }
  return fallback
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
