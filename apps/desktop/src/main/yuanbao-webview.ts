// 元宝（腾讯元宝）WebView 生成执行引擎
// 链路：cookie/storage 注入 → 打开元宝 chat 页面 → 通过 Ctrl+V 粘贴素材图片
//       → 在输入框末尾追加 prompt（调度台会加“视频生成：”前缀）→ 点击发送
//       → 从 webRequest 捕获 conversationId 与请求头 → 轮询 conversation detail 提取视频 URL
// 说明：元宝当前没有独立的视频生成 DOM，生成完全靠 chat 输入框提示词完成，因此这里不点击“AI生视频”等控件。

import { BrowserWindow, clipboard, nativeImage, session } from 'electron'
import { readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import type { OriginStorage, ProviderCookie } from './webview-engine'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36'
const YUANBAO_CHAT_URL = 'https://yuanbao.tencent.com/chat/naQivTmsDa'
const CAPTURE_URLS = ['*://yuanbao.tencent.com/api/chat/*', '*://yuanbao.tencent.com/api/user/agent/conversation/v1/detail']
const DETAIL_API_URL = 'https://yuanbao.tencent.com/api/user/agent/conversation/v1/detail'
const BLOCKED_PATTERN = /违[规法]|内容审核|无法生成|版权|侵权|肖像|敏感|检测到.*(风险|违规)|拒绝生成|请勿生成/
const MAX_IMAGES = 10

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export interface YuanbaoGenerateOptions {
  cookies: ProviderCookie[]
  storages?: OriginStorage[]
  prompt: string
  images?: string[]
  keyId?: string
  showWebview?: boolean
  maxWaitSec?: number
  cancel?: { aborted: boolean; submitted: boolean }
  onProgress?: (stage: string, detail?: unknown) => void
}

export interface YuanbaoGenerateResult {
  ok: boolean
  providerId: 'yuanbao'
  videoUrl?: string
  posterUrl?: string | null
  error?: string
  blocked?: boolean
  cancelled?: boolean
  attempts: Array<{ providerId: string; ok: boolean; errorMessage?: string }>
}

interface CapturedYuanbaoRequest {
  conversationId?: string
  headers?: Record<string, string>
}

interface YuanbaoCaptureRegistration {
  captured: { current: CapturedYuanbaoRequest | null }
}

const captureRegistrations = new Map<string, YuanbaoCaptureRegistration>()

function findHeader(headers: Record<string, string>, names: string[]): string | undefined {
  const lower = new Map<string, string>()
  for (const [key, value] of Object.entries(headers)) {
    lower.set(key.toLowerCase(), value)
  }
  for (const name of names) {
    const value = lower.get(name.toLowerCase())
    if (value) return value
  }
  return undefined
}

function fail(error: string, attempts: Array<{ providerId: string; ok: boolean; errorMessage?: string }>): YuanbaoGenerateResult {
  attempts.push({ providerId: 'yuanbao', ok: false, errorMessage: error })
  return { ok: false, providerId: 'yuanbao', error, attempts }
}

function failBlocked(error: string, attempts: Array<{ providerId: string; ok: boolean; errorMessage?: string }>): YuanbaoGenerateResult {
  const result = fail(error, attempts)
  return { ...result, blocked: true }
}

function failCancelled(attempts: Array<{ providerId: string; ok: boolean; errorMessage?: string }>): YuanbaoGenerateResult {
  const error = '已手动终止生成（提示词未发送）'
  attempts.push({ providerId: 'yuanbao', ok: false, errorMessage: error })
  return { ok: false, providerId: 'yuanbao', cancelled: true, error, attempts }
}

function scriptError(scope: string, e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  if (/Script failed to execute/i.test(msg)) {
    return `${scope}：页面脚本执行异常，请开启显示窗口确认页面状态或检查页面结构`
  }
  return `${scope}：${msg}`
}

function blockedMessageFromText(text?: string): string | null {
  if (!text) return null
  const line = text
    .split('\n')
    .map((s) => s.trim())
    .find((s) => BLOCKED_PATTERN.test(s))
  return line ? line.slice(0, 120) : null
}

function readUploadDataText(details: { uploadData?: Array<{ bytes: Buffer }> }): string {
  const chunks = details.uploadData ?? []
  if (chunks.length === 0) return ''
  try {
    return Buffer.concat(chunks.map((chunk) => chunk.bytes)).toString('utf8')
  } catch {
    return ''
  }
}

function findFirstStringByKeys(value: unknown, keys: string[]): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstStringByKeys(item, keys)
      if (found) return found
    }
    return undefined
  }
  if (!value || typeof value !== 'object') return undefined

  const record = value as Record<string, unknown>
  for (const [key, child] of Object.entries(record)) {
    if (keys.includes(key) && typeof child === 'string' && child.trim()) {
      return child.trim()
    }
    if (child && typeof child === 'object') {
      const found = findFirstStringByKeys(child, keys)
      if (found) return found
    }
  }
  return undefined
}

function setupYuanbaoCapture(
  partition: string,
  ses: Electron.Session,
  captured: { current: CapturedYuanbaoRequest | null }
): void {
  const existing = captureRegistrations.get(partition)
  if (existing) {
    existing.captured = captured
    return
  }

  const registration: YuanbaoCaptureRegistration = { captured }
  captureRegistrations.set(partition, registration)

  ses.webRequest.onBeforeRequest({ urls: CAPTURE_URLS }, (details, callback) => {
    callback({})
    const target = captureRegistrations.get(partition)?.captured
    if (!target) return
    const bodyText = readUploadDataText(details)
    const next: CapturedYuanbaoRequest = { ...target.current }
    const m = details.url.match(/\/api\/chat\/([^/?#]+)/)
    if (m) next.conversationId = m[1]
    if (!next.conversationId && details.url.includes('/api/user/agent/conversation/v1/detail')) {
      next.conversationId = findFirstStringByKeys(parseJsonOrForm(bodyText), ['conversationId', 'conversation_id'])
    }
    if (bodyText) {
      try {
        const json = JSON.parse(bodyText) as unknown
        next.conversationId ||= findFirstStringByKeys(json, ['conversationId', 'conversation_id'])
      } catch {
        try {
          const params = new URLSearchParams(bodyText)
          next.conversationId ||= params.get('conversationId') || params.get('conversation_id') || undefined
        } catch {}
      }
    }
    target.current = next
  })

  ses.webRequest.onBeforeSendHeaders({ urls: CAPTURE_URLS }, (details, callback) => {
    const headers = details.requestHeaders
    const target = captureRegistrations.get(partition)?.captured
    if (target) {
      const next: CapturedYuanbaoRequest = { ...target.current }
      next.headers = headers
      target.current = next
    }
    callback({ requestHeaders: headers })
  })
}

function parseJsonOrForm(bodyText: string): unknown {
  if (!bodyText) return undefined
  try {
    return JSON.parse(bodyText) as unknown
  } catch {
    try {
      const params = new URLSearchParams(bodyText)
      return {
        conversationId: params.get('conversationId') || params.get('conversation_id') || undefined
      }
    } catch {
      return undefined
    }
  }
}

async function injectCookies(cookies: ProviderCookie[], partition: string): Promise<number> {
  const ses = session.fromPartition(partition)
  ses.setUserAgent(UA)
  let injected = 0
  for (const c of cookies) {
    try {
      const cleanDomain = (c.domain || '').replace(/^\./, '') || 'yuanbao.tencent.com'
      const cookieUrl = `${c.secure === false ? 'http' : 'https'}://${cleanDomain}${c.path || '/'}`
      await ses.cookies.set({
        url: cookieUrl,
        domain: c.domain || undefined,
        name: c.name,
        value: c.value,
        httpOnly: !!c.httpOnly,
        secure: c.secure !== false,
        expirationDate: c.expires && c.expires > 0 ? Math.floor(c.expires / 1000) : undefined
      })
      injected += 1
    } catch {
      // 单条失败不阻断
    }
  }
  return injected
}

async function injectStorages(win: BrowserWindow, storages: OriginStorage[]): Promise<void> {
  try {
    await win.webContents.executeJavaScript(
      `(() => {
        const all = ${JSON.stringify(storages)};
        const main = all.find((s) => location.origin === s.origin) || all.find((s) => (s.origin || '').includes('yuanbao.tencent.com'));
        if (main && main.localStorage) {
          for (const { key, value } of main.localStorage) {
            try { localStorage.setItem(key, value); } catch {}
          }
          if (main.sessionStorage) {
            for (const { key, value } of main.sessionStorage) {
              try { sessionStorage.setItem(key, value); } catch {}
            }
          }
        }
      })()`,
      true
    )
    await win.webContents.executeJavaScript('location.reload()', true)
    await sleep(3000)
  } catch {
    // storage 注入失败不阻断，页面可能仅依赖 cookie
  }
}

function buildFocusInputScript(): string {
  return `(async () => {
  try {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
  };
  const findInput = () => {
    const sels = [
      'textarea',
      'input:not([type="file"]):not([type="hidden"]):not([type="submit"]):not([type="button"])',
      '[contenteditable]',
      '[contenteditable="true"]',
      '[contenteditable="plaintext-only"]',
      '[role="textbox"]'
    ];
    for (const s of sels) {
      const els = [...document.querySelectorAll(s)].filter(visible);
      if (els.length) return els[0];
    }
    return null;
  };
  const chatInput = findInput();
  if (!chatInput) return { ok: false, reason: '未找到元宝输入框，无法通过 Ctrl+V 上传素材，请开启显示窗口确认页面正常' };
  chatInput.focus();
  try { chatInput.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
  await sleep(300);
  return { ok: true, reason: '元宝输入框已聚焦，准备通过 Ctrl+V 上传素材' };
  } catch (e) {
    return { ok: false, reason: '元宝素材上传脚本异常: ' + (e && e.message ? e.message : String(e)) };
  }
})()`
}

interface YuanbaoImageData {
  name: string
  mime: string
  dataUrl: string
}

async function readYuanbaoImages(images: string[]): Promise<YuanbaoImageData[]> {
  const out: YuanbaoImageData[] = []
  for (const imagePath of images) {
    try {
      const ext = extname(imagePath).toLowerCase()
      const mime =
        ext === '.png' ? 'image/png' :
        ext === '.gif' ? 'image/gif' :
        ext === '.webp' ? 'image/webp' :
        'image/jpeg'
      const data = await readFile(imagePath)
      out.push({
        name: basename(imagePath),
        mime,
        dataUrl: `data:${mime};base64,${data.toString('base64')}`
      })
    } catch {
      // 单张失败不阻断，只要至少有一张可上传即可
    }
  }
  return out
}

async function uploadYuanbaoImages(win: BrowserWindow, images: string[]): Promise<{ ok: boolean; reason?: string }> {
  const data = await readYuanbaoImages(images)
  if (data.length === 0) {
    return { ok: false, reason: '读取元宝素材图片失败，请确认图片文件仍存在' }
  }
  const savedText = clipboard.readText()
  const savedImage = clipboard.readImage()
  try {
    const focus = (await win.webContents.executeJavaScript(
      buildFocusInputScript(),
      true
    )) as { ok: boolean; reason?: string }
    if (!focus.ok) {
      return { ok: false, reason: focus.reason || '未找到元宝输入框，无法通过 Ctrl+V 上传素材' }
    }

    win.webContents.focus()
    let pasted = 0
    for (const item of data) {
      const image = nativeImage.createFromDataURL(item.dataUrl)
      if (image.isEmpty()) {
        return { ok: false, reason: `元宝素材图片读取失败：${item.name}` }
      }
      clipboard.writeImage(image)
      win.webContents.paste()
      await sleep(1800)
      pasted += 1
    }

    return { ok: true, reason: `已在元宝输入框通过 Ctrl+V 上传 ${pasted} 张素材图片` }
  } catch (e) {
    return { ok: false, reason: scriptError('元宝素材上传', e) }
  } finally {
    try {
      if (!savedImage.isEmpty() || savedText) {
        clipboard.write({ text: savedText, image: savedImage })
      } else {
        clipboard.clear()
      }
    } catch {}
  }
}

function buildFillPromptScript(prompt: string): string {
  const promptJson = JSON.stringify(prompt)
  return `(async () => {
  try {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
  };
  const findInput = () => {
    const sels = [
      'textarea',
      'input:not([type="file"]):not([type="hidden"]):not([type="submit"]):not([type="button"])',
      '[contenteditable]',
      '[contenteditable="true"]',
      '[contenteditable="plaintext-only"]',
      '[role="textbox"]'
    ];
    for (const s of sels) {
      const els = [...document.querySelectorAll(s)].filter(visible);
      if (els.length) return els[0];
    }
    return null;
  };
  const appendText = (el, text) => {
    el.focus();
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement : window.HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value').set;
      const next = (el.value || '') + text;
      setter.call(el, next);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    const sel = window.getSelection();
    if (sel) {
      sel.selectAllChildren(el);
      sel.collapseToEnd();
    }
    document.execCommand('insertText', false, text);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const input = findInput();
  if (!input) return { ok: false, reason: '未找到元宝输入框，页面结构可能已变化' };
  appendText(input, ${promptJson});
  await sleep(400);
  return { ok: true, reason: '已在元宝输入框追加 prompt', tag: input.tagName.toLowerCase(), cls: (typeof input.className === 'string' ? input.className : '').slice(0, 120) };
  } catch (e) {
    return { ok: false, reason: '元宝 prompt 填写脚本异常: ' + (e && e.message ? e.message : String(e)) };
  }
})()`
}

function buildClickSendScript(): string {
  return `(async () => {
  try {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
  };
  const canClick = (el) => el.disabled !== true && el.getAttribute('aria-disabled') !== 'true';
  const isSendText = (t) => /发送|提交|生成/.test(t) && !/停止/.test(t);
  const findInput = () => {
    const sels = [
      'textarea',
      'input:not([type="file"]):not([type="hidden"]):not([type="submit"]):not([type="button"])',
      '[contenteditable]',
      '[contenteditable="true"]',
      '[contenteditable="plaintext-only"]',
      '[role="textbox"]'
    ];
    for (const s of sels) {
      const els = [...document.querySelectorAll(s)].filter(visible);
      if (els.length) return els[0];
    }
    return null;
  };
  const clickEl = (el) => {
    el.style.pointerEvents = 'auto';
    el.style.zIndex = '999';
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    if (typeof PointerEvent !== 'undefined') {
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', view: window }));
      el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', view: window }));
    }
    for (const type of ['mousedown', 'mouseup', 'click']) {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window }));
    }
  };
  const findSend = () => {
    const candidates = [...document.querySelectorAll('button, [role="button"], [class*="send" i], [class*="submit" i], [class*="action" i], [class*="cursor-pointer" i]')].filter(visible);
    const sendByAria = candidates.find((el) => {
      const aria = norm(el.getAttribute('aria-label') || '');
      const title = norm(el.getAttribute('title') || '');
      return aria === '发送消息' || title === '发送消息' || aria === '发送' || title === '发送' || aria === '提交' || title === '提交';
    });
    if (sendByAria) return sendByAria;
    const clickableCandidates = candidates.filter(canClick);
    const hit = clickableCandidates.find((el) => {
      return isSendText(norm(el.getAttribute('aria-label') || '')) ||
        isSendText(norm(el.getAttribute('title') || '')) ||
        isSendText(norm(el.getAttribute('data-testid') || '')) ||
        isSendText(norm(el.textContent || ''));
    });
    if (hit) return hit;
    const input = findInput();
    if (!input) return null;
    let node = input;
    for (let i = 0; i < 6 && node; i++) {
      const parent = node.parentElement;
      if (!parent) break;
      const icons = [...parent.querySelectorAll('button, [role="button"], [class*="cursor-pointer" i]')].filter((el) => visible(el) && canClick(el) && el.querySelector('svg'));
      if (icons.length) return icons[icons.length - 1];
      node = parent;
    }
    return clickableCandidates.filter((el) => el.querySelector('svg')).pop() || null;
  };
  await sleep(400);
  let send = findSend();
  if (!send) return { ok: false, reason: '已填入 prompt，但未找到发送按钮' };
  for (let i = 0; i < 10 && (send.disabled === true || send.getAttribute('aria-disabled') === 'true'); i++) {
    await sleep(300);
    send = findSend();
    if (!send) return { ok: false, reason: '已填入 prompt，但未找到发送按钮' };
  }
  if (send.disabled === true || send.getAttribute('aria-disabled') === 'true') {
    return { ok: false, reason: '元宝发送按钮仍为禁用状态，prompt 未进入编辑器状态' };
  }
  clickEl(send);
  return { ok: true, reason: '已点击元宝发送按钮', aria: send.getAttribute('aria-label') || '', text: norm(send.textContent || '').slice(0, 40), cls: (typeof send.className === 'string' ? send.className : '').slice(0, 120) };
  } catch (e) {
    return { ok: false, reason: '元宝发送脚本异常: ' + (e && e.message ? e.message : String(e)) };
  }
})()`
}

async function waitForYuanbaoCapture(
  captured: { current: CapturedYuanbaoRequest | null },
  cancelState: { aborted: boolean; submitted: boolean } | undefined,
  timeoutMs: number
): Promise<CapturedYuanbaoRequest | null> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (captured.current?.conversationId) return captured.current
    if (cancelState?.aborted) return null
    await sleep(300)
  }
  return null
}

async function cookieHeaderFromSession(partition: string): Promise<string> {
  try {
    const ses = session.fromPartition(partition)
    const cookies = await ses.cookies.get({})
    return cookies.map((c) => `${c.name}=${c.value}`).join('; ')
  } catch {
    return ''
  }
}

function pickDetailHeaders(headers?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  if (!headers) return out
  const skip = new Set([
    'host',
    'content-length',
    'connection',
    'accept-encoding',
    'transfer-encoding',
    'upgrade-insecure-requests',
    'sec-fetch-mode',
    'sec-fetch-site',
    'sec-fetch-user',
    'sec-fetch-dest',
    'sec-ch-ua',
    'sec-ch-ua-mobile',
    'sec-ch-ua-platform'
  ])
  for (const [key, value] of Object.entries(headers)) {
    if (!skip.has(key.toLowerCase()) && value != null) out[key] = value
  }
  return out
}

function extractYuanbaoVideo(data: unknown): { url: string; downloadUrl: string } | null {
  const json = data as { convs?: Array<Record<string, unknown>> }
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

function extractYuanbaoBlocked(data: unknown): string | null {
  const json = data as { convs?: Array<Record<string, unknown>> }
  if (!Array.isArray(json.convs)) return null
  const latestAi = [...json.convs].reverse().find((c) => c.speaker === 'ai')
  if (!latestAi) return null
  const speeches = latestAi.speechesV2 as Array<Record<string, unknown>> | undefined
  if (!Array.isArray(speeches)) return null
  const texts = speeches
    .map((sp) => {
      if (typeof sp.content === 'string') return sp.content
      if (typeof sp.text === 'string') return sp.text
      if (typeof sp.message === 'string') return sp.message
      return ''
    })
    .join('\n')
  return blockedMessageFromText(texts)
}

interface YuanbaoPollResult {
  ok: boolean
  video?: { url: string; downloadUrl: string }
  error?: string
  blocked?: boolean
}

async function pollYuanbaoDetail(
  captured: CapturedYuanbaoRequest,
  partition: string,
  maxWaitMs: number,
  onProgress: (stage: string, detail?: unknown) => void
): Promise<YuanbaoPollResult> {
  const conversationId = captured.conversationId ?? ''
  const cookie = captured.headers?.cookie || (await cookieHeaderFromSession(partition))
  const headers: Record<string, string> = pickDetailHeaders(captured.headers)
  headers.cookie = cookie
  headers['content-type'] = 'application/json'
  headers.accept = 'application/json, text/event-stream, text/plain, */*'
  headers.origin = 'https://yuanbao.tencent.com'
  headers.referer = captured.headers?.referer || `https://yuanbao.tencent.com/chat/naQivTmsDa/${conversationId}`
  headers['user-agent'] = UA

  const started = Date.now()
  while (Date.now() - started < maxWaitMs) {
    try {
      const res = await fetch(DETAIL_API_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify({ conversationId }),
        signal: AbortSignal.timeout(15000)
      })
      if (res.status === 401 || res.status === 403) {
        return { ok: false, error: '元宝接口返回 401/403，可能登录态失效或风控限制' }
      }
      if (res.status === 200) {
        const json = (await res.json()) as unknown
        const blocked = extractYuanbaoBlocked(json)
        if (blocked) {
          return { ok: false, blocked: true, error: blocked }
        }
        const video = extractYuanbaoVideo(json)
        if (video) return { ok: true, video }
      }
    } catch {
      // 单次轮询失败继续
    }
    onProgress('waiting', { message: '等待元宝生成完成…' })
    await sleep(5000)
  }
  return { ok: false, error: '等待超时未取到元宝视频 URL' }
}

export async function runYuanbaoGeneration(options: YuanbaoGenerateOptions): Promise<YuanbaoGenerateResult> {
  const attempts: Array<{ providerId: string; ok: boolean; errorMessage?: string }> = []
  const failWith = (error: string): YuanbaoGenerateResult => fail(error, attempts)
  const cancelState = options.cancel
  let win: BrowserWindow | null = null

  const abortIfCancelled = (): YuanbaoGenerateResult | null => {
    if (!cancelState?.aborted) return null
    try {
      win?.destroy()
    } catch {}
    return failCancelled(attempts)
  }

  const waitOrAbort = async (ms: number): Promise<boolean> => {
    const step = 200
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (cancelState?.aborted) return true
      await sleep(Math.min(step, end - Date.now()))
    }
    return cancelState?.aborted === true
  }

  const abortNow = (): YuanbaoGenerateResult => abortIfCancelled() ?? failCancelled(attempts)

  const images = (options.images ?? []).slice(0, MAX_IMAGES)
  const partition = options.keyId ? `persist:qf-p:yuanbao:${options.keyId}` : 'persist:qf-p:yuanbao'
  options.onProgress?.('inject-cookies')
  await injectCookies(options.cookies, partition)

  const captured: { current: CapturedYuanbaoRequest | null } = { current: null }
  const ses = session.fromPartition(partition)
  ses.setUserAgent(UA)
  setupYuanbaoCapture(partition, ses, captured)

  {
    const aborted = abortIfCancelled()
    if (aborted) return aborted
  }

  options.onProgress?.('open-page')
  win = new BrowserWindow({
    show: options.showWebview === true,
    width: 1280,
    height: 900,
    title: '元宝生成 - Quota-Flow',
    autoHideMenuBar: true,
    backgroundColor: '#0c0c0c',
    webPreferences: {
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  if (options.showWebview === true) {
    try {
      win.center()
    } catch {}
  }
  win.webContents.setUserAgent(UA)
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) return { action: 'allow', overrideBrowserWindowOptions: { width: 560, height: 720 } }
    return { action: 'deny' }
  })

  let loadError: { code: number; desc: string; url: string } | null = null
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    loadError = { code, desc, url }
  })
  try {
    await Promise.race([
      win.loadURL(YUANBAO_CHAT_URL),
      waitOrAbort(90000).then((ab) => {
        if (ab) throw new Error('已取消')
        throw new Error('页面加载超时')
      })
    ])
  } catch (e) {
    loadError = { code: -1, desc: e instanceof Error ? e.message : String(e), url: YUANBAO_CHAT_URL }
  }
  if (await waitOrAbort(4000)) return abortNow()

  if (options.storages && options.storages.length > 0) {
    await injectStorages(win, options.storages)
    if (await waitOrAbort(2000)) return abortNow()
  }

  let inputFound = false
  try {
    inputFound = !!(await win.webContents.executeJavaScript(
      `(() => {
        const sels = [
          'textarea',
          'input:not([type="file"]):not([type="hidden"]):not([type="submit"]):not([type="button"])',
          '[contenteditable]',
          '[contenteditable="true"]',
          '[contenteditable="plaintext-only"]',
          '[role="textbox"]'
        ];
        return [...document.querySelectorAll(sels.join(','))].some((el) => el.offsetParent !== null);
      })()`,
      true
    ))
  } catch {}

  if (loadError || !inputFound) {
    win.destroy()
    return failWith(loadError ? `页面加载失败 (${loadError.code}: ${loadError.desc})` : '元宝账号未登录（cookie 可能已失效），请在厂商页重新登录后重试')
  }

  {
    const aborted = abortIfCancelled()
    if (aborted) return aborted
  }

  if (images.length > 0) {
    options.onProgress?.('upload-images')
    const uploadResult = await uploadYuanbaoImages(win, images)
    if (!uploadResult.ok) {
      win.destroy()
      return failWith(uploadResult.reason || '元宝素材上传失败')
    }
  }

  {
    const aborted = abortIfCancelled()
    if (aborted) return aborted
  }

  captured.current = null
  options.onProgress?.('submit', { prompt: options.prompt, images: images.length })
  let fillResult: { ok?: boolean; reason?: string } = {}
  try {
    fillResult = (await win.webContents.executeJavaScript(
      buildFillPromptScript(options.prompt),
      true
    )) as typeof fillResult
  } catch (e) {
    fillResult = { ok: false, reason: scriptError('元宝 prompt 填写', e) }
  }
  if (!fillResult.ok) {
    win.destroy()
    return failWith(fillResult.reason || '元宝 prompt 填写失败')
  }

  {
    const aborted = abortIfCancelled()
    if (aborted) return aborted
  }

  let sendResult: { ok?: boolean; reason?: string } = {}
  try {
    sendResult = (await win.webContents.executeJavaScript(
      buildClickSendScript(),
      true
    )) as typeof sendResult
  } catch (e) {
    sendResult = { ok: false, reason: scriptError('元宝发送', e) }
  }
  if (!sendResult.ok) {
    win.destroy()
    return failWith(sendResult.reason || '元宝发送失败')
  }

  if (cancelState) cancelState.submitted = true
  options.onProgress?.('waiting', { message: '已发送 prompt，等待元宝生成…' })
  const chat = await waitForYuanbaoCapture(captured, cancelState, 20000)
  if (!chat?.conversationId) {
    win.destroy()
    return failWith('未捕获到元宝生成请求（conversationId），请开启显示窗口或确认页面已正常发送')
  }

  options.onProgress?.('waiting')
  const poll = await pollYuanbaoDetail(chat, partition, (options.maxWaitSec ?? 360) * 1000, (stage, detail) =>
    options.onProgress?.(stage, detail)
  )
  win.destroy()

  if (!poll.ok) {
    if (poll.blocked) {
      return failBlocked(poll.error ?? '元宝拒绝了本次生成', attempts)
    }
    return failWith(poll.error ?? '等待超时未取到元宝视频 URL')
  }
  if (!poll.video) {
    return failWith('等待超时未取到元宝视频 URL')
  }
  const video = poll.video
  attempts.push({ providerId: 'yuanbao', ok: true })
  return {
    ok: true,
    providerId: 'yuanbao',
    videoUrl: video.downloadUrl || video.url,
    posterUrl: null,
    attempts
  }
}
