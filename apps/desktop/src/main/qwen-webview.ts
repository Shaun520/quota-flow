// 千问（通义万相）WebView 生成执行引擎
// 链路：cookie/storage 注入 → 打开千问 chat → 自动填写 prompt 并发送
//       → 从 webRequest 捕获 chat 请求的 req_id/session_id 与 detail 所需请求头
//       → 轮询 detail API 提取 mp4 URL / poster
// 说明：千问 chat API 的风控签名由前端页面自身生成，因此这里不走静态 HTTP 提交，
//       只复用页面真实提交后捕获到的会话参数。

import { BrowserWindow, clipboard, nativeImage, session } from 'electron'
import { readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import type { OriginStorage, ProviderCookie } from './webview-engine'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36'
const QWEN_CHAT_URL = 'https://www.qianwen.com/chat'
const CHAT_API_URLS = ['*://*.qianwen.com/api/*', '*://qianwen.com/api/*']
const DETAIL_API_URL = 'https://chat2-api.qianwen.com/api/v1/session/req/detail'
const BLOCKED_PATTERN = /违[规法]|内容审核|无法生成|版权|侵权|肖像|敏感|检测到.*(风险|违规)|拒绝生成|请勿生成/
const QWEN_IMAGE_MODES = new Set(['multi_ref', 'first_last', 'first_frame', 'firstlast'])
const MAX_QWEN_IMAGES = 5

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export interface QwenGenerateOptions {
  cookies: ProviderCookie[]
  storages?: OriginStorage[]
  prompt: string
  model?: string
  mode?: string
  images?: string[]
  resolution?: string
  audio?: string
  ratio?: string
  durationSec?: number
  keyId?: string
  showWebview?: boolean
  maxWaitSec?: number
  cancel?: { aborted: boolean; submitted: boolean }
  onProgress?: (stage: string, detail?: unknown) => void
}

export interface QwenGenerateResult {
  ok: boolean
  providerId: 'qwenwan'
  videoUrl?: string
  posterUrl?: string | null
  error?: string
  blocked?: boolean
  cancelled?: boolean
  attempts: Array<{ providerId: string; ok: boolean; errorMessage?: string }>
}

interface CapturedChatRequest {
  reqId?: string
  sessionId?: string
  deviceId?: string
  xsrfToken?: string
  cookie?: string
}

interface ChatCaptureRegistration {
  captured: { current: CapturedChatRequest | null }
}

interface QwenImageData {
  name: string
  mime: string
  dataUrl: string
}

// webRequest 监听器无法方便地按 session 移除，重复注册会让同一分区跑多次千问任务时叠加监听。
// 这里按 partition 只注册一次，后续任务只替换当前捕获目标，避免旧任务污染新任务的 req_id/session_id。
const chatCaptureRegistrations = new Map<string, ChatCaptureRegistration>()

function isQwenDetailUrl(url: string): boolean {
  return /\/req\/detail\b|\/detail\b/i.test(url)
}

function qwenSessionIdFromUrl(url: string): string | undefined {
  try {
    const pathname = new URL(url).pathname
    const match = pathname.match(/\/chat\/([^/?#]+)/i)
    return match?.[1] || undefined
  } catch {
    return undefined
  }
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

function mergeCapturedFromJsonBody(next: CapturedChatRequest, bodyText: string): void {
  if (!bodyText) return
  try {
    const json = JSON.parse(bodyText) as unknown
    next.reqId ||= findFirstStringByKeys(json, ['req_id', 'reqId', 'request_id', 'requestId'])
    next.sessionId ||= findFirstStringByKeys(json, ['session_id', 'sessionId'])
  } catch {
    // 非 JSON body
  }
}

function mergeCapturedFromFormBody(next: CapturedChatRequest, bodyText: string): void {
  if (!bodyText || bodyText.includes('{')) return
  try {
    const params = new URLSearchParams(bodyText)
    next.reqId ||= params.get('req_id') || params.get('reqId') || params.get('request_id') || params.get('requestId') || undefined
    next.sessionId ||= params.get('session_id') || params.get('sessionId') || undefined
  } catch {
    // 非 form body
  }
}

function mergeCapturedFromUrl(next: CapturedChatRequest, url: string): void {
  try {
    const params = new URL(url).searchParams
    next.reqId ||= params.get('req_id') || params.get('reqId') || params.get('request_id') || params.get('requestId') || undefined
    next.sessionId ||= params.get('session_id') || params.get('sessionId') || undefined
  } catch {
    // 忽略 URL 解析失败
  }
}

function findRequestHeader(headers: Record<string, string>, names: string[]): string | undefined {
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

function fail(error: string, attempts: Array<{ providerId: string; ok: boolean; errorMessage?: string }>): QwenGenerateResult {
  attempts.push({ providerId: 'qwenwan', ok: false, errorMessage: error })
  return { ok: false, providerId: 'qwenwan', error, attempts }
}

function failBlocked(error: string, attempts: Array<{ providerId: string; ok: boolean; errorMessage?: string }>): QwenGenerateResult {
  const result = fail(error, attempts)
  return { ...result, blocked: true }
}

function failCancelled(attempts: Array<{ providerId: string; ok: boolean; errorMessage?: string }>): QwenGenerateResult {
  const error = '已手动终止生成（提示词未发送）'
  attempts.push({ providerId: 'qwenwan', ok: false, errorMessage: error })
  return { ok: false, providerId: 'qwenwan', cancelled: true, error, attempts }
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

async function injectCookies(cookies: ProviderCookie[], partition: string): Promise<number> {
  const ses = session.fromPartition(partition)
  ses.setUserAgent(UA)
  let injected = 0
  for (const c of cookies) {
    try {
      const cleanDomain = (c.domain || '').replace(/^\./, '') || 'www.qianwen.com'
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

async function readQwenImages(images: string[]): Promise<QwenImageData[]> {
  const out: QwenImageData[] = []
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

async function uploadQwenReferences(
  win: BrowserWindow,
  images: string[],
  cancelState?: { aborted: boolean; submitted: boolean }
): Promise<{ ok: boolean; cancelled?: boolean; reason?: string }> {
  const data = await readQwenImages(images)
  if (data.length === 0) {
    return { ok: false, reason: '读取千问素材图片失败，请确认图片文件仍存在' }
  }
  const savedText = clipboard.readText()
  const savedImage = clipboard.readImage()
  const sleepOrAbort = async (ms: number): Promise<boolean> => {
    const step = 150
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (cancelState?.aborted) return true
      await sleep(Math.min(step, end - Date.now()))
    }
    return cancelState?.aborted === true
  }
  try {
    const focus = (await win.webContents.executeJavaScript(
      buildFocusInputScript(),
      true
    )) as { ok: boolean; reason?: string }
    if (!focus.ok) {
      return { ok: false, reason: focus.reason || '未找到千问输入框，无法通过 Ctrl+V 上传素材' }
    }

    let pasted = 0
    for (const item of data) {
      if (cancelState?.aborted) {
        return { ok: false, cancelled: true, reason: '已手动终止生成（提示词未发送）' }
      }
      const image = nativeImage.createFromDataURL(item.dataUrl)
      if (image.isEmpty()) {
        return { ok: false, reason: `千问素材图片读取失败：${item.name}` }
      }
      clipboard.writeImage(image)
      win.webContents.paste()
      if (await sleepOrAbort(1800)) {
        return { ok: false, cancelled: true, reason: '已手动终止生成（提示词未发送）' }
      }
      pasted += 1
    }

    return { ok: true, reason: `已在千问输入框通过 Ctrl+V 上传 ${pasted} 张素材图片` }
  } catch (e) {
    return { ok: false, reason: scriptError('千问素材上传', e) }
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

// 千问官网的“AI生视频”入口会渲染 guide/onboarding 容器，容器本身不能删，
// 否则视频工具栏会一起消失。这里只点击显式关闭按钮，并强制需要操作的控件可交互。
function buildPrepareQwenComposerScript(options: QwenGenerateOptions): string {
  const model = options.model || '万相 2.7'
  const resolution = options.resolution || '720'
  const ratio = options.ratio || '9:16'
  const audio = options.audio || 'on'
  const durationSec = options.durationSec ?? 5
  return `(() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const targetModel = ${JSON.stringify(model)};
  const targetRatio = ${JSON.stringify(ratio)};
  const targetMode = ${JSON.stringify(options.mode || 'multi_ref')};
  const resolutionLabel = ${JSON.stringify(resolution === '1080' ? '超清' : '高清')};
  const durationLabel = ${JSON.stringify(durationSec + '秒')};
  const audioLabel = ${JSON.stringify(audio === 'on' ? '开' : '关')};
  const supportsSmartAudio = !/HappyHorse/i.test(targetModel);
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
  };
  const labelOf = (el) => norm((el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '') + ' ' + (el.textContent || ''));
  const canClick = (el) => el.disabled !== true && el.getAttribute('aria-disabled') !== 'true';
  const clickEl = (el) => {
    el.style.pointerEvents = 'auto';
    el.style.zIndex = '999';
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const events = [];
    if (typeof PointerEvent !== 'undefined') {
      events.push(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', view: window }));
      events.push(new PointerEvent('pointerup', { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', view: window }));
    }
    events.push(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window }));
    events.push(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window }));
    events.push(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window }));
    for (const ev of events) el.dispatchEvent(ev);
  };
  const findButton = (matcher) => [...document.querySelectorAll('button, [role="button"], a, [class*="button" i], [class*="btn" i]')].filter((el) => visible(el) && canClick(el)).find(matcher);
  const closeExplicitGuides = async () => {
    for (let i = 0; i < 6; i++) {
      const close = [...document.querySelectorAll('button, [role="button"]')].find((el) => {
        if (!visible(el) || !canClick(el)) return false;
        const t = labelOf(el);
        return /^(关闭|知道了|我知道了|完成|跳过|下一项|下一步)$/.test(t);
      });
      if (!close) break;
      clickEl(close);
      await sleep(600);
    }
  };
  const forceVideoControls = () => {
    for (const el of [...document.querySelectorAll('[class*="guideComp" i], [class*="guideContainer" i], [class*="guide" i]')]) {
      el.style.pointerEvents = 'auto';
    }
    for (const b of [...document.querySelectorAll('button')]) {
      if (/AI生视频|万相|HappyHorse|多参考|首帧|首尾帧|文生视频|图生视频|720P|1080P/.test(labelOf(b))) {
        b.style.pointerEvents = 'auto';
        b.style.zIndex = '999';
      }
    }
  };
  const ensureVideoMode = async () => {
    const hasVideoToolbar = [...document.querySelectorAll('button')].filter(visible).some((el) => /^(万相|HappyHorse)/.test(labelOf(el)) || /720P|1080P/.test(labelOf(el)));
    if (hasVideoToolbar) return true;
    const ai = findButton((el) => /AI生视频|AI视频|生视频/.test(labelOf(el)));
    if (!ai) return false;
    clickEl(ai);
    await sleep(2200);
    return true;
  };
  const currentModelButton = () => [...document.querySelectorAll('button')].filter(visible).find((el) => /^(万相|HappyHorse)/.test(labelOf(el)));
  const openModelMenu = async () => {
    const btn = currentModelButton();
    if (!btn) return false;
    clickEl(btn);
    await sleep(1200);
    return true;
  };
  const findModelItem = (target) => {
    const targetKey = target.replace(/\\s+/g, '');
    return [...document.querySelectorAll('[role="menuitemcheckbox"], [role="menuitem"], [role="option"], button, [class*="option" i]')]
      .filter(visible)
      .find((el) => {
        const key = norm(el.textContent || '').replace(/\\s+/g, '');
        return key.startsWith(targetKey);
      });
  };
  const currentModeButton = () => [...document.querySelectorAll('button')].filter(visible).find((el) => /多参考生成|首帧生成|首尾帧生成|文生视频|图生视频/.test(labelOf(el)));
  const openModeMenu = async () => {
    const btn = currentModeButton();
    if (!btn) return false;
    clickEl(btn);
    await sleep(1200);
    return true;
  };
  const findModeItem = (target) => {
    const targetKey = target.replace(/\\s+/g, '');
    const menuItems = [...document.querySelectorAll('[role="menuitemcheckbox"], [role="menuitem"], [role="option"]')]
      .filter(visible)
      .find((el) => {
        const key = norm(el.textContent || '').replace(/\\s+/g, '');
        return key === targetKey || key.startsWith(targetKey);
      });
    if (menuItems) return menuItems;
    return [...document.querySelectorAll('button')]
      .filter(visible)
      .find((el) => {
        const key = norm(el.textContent || '').replace(/\\s+/g, '');
        return key === targetKey || key.startsWith(targetKey);
      });
  };
  const applyGenerationMode = async () => {
    const targetModeMap = {
      text2video: '文生视频',
      t2v: '文生视频',
      multi_ref: '多参考生成',
      first_frame: '首帧生成',
      first_last: '首尾帧生成',
      firstlast: '首尾帧生成'
    };
    const targetModeLabel = targetModeMap[targetMode] || '';
    if (!targetModeLabel) return { ok: true };
    const btn = currentModeButton();
    if (!btn) return { ok: true, reason: '未找到千问生成模式按钮，保持页面默认模式' };
    if (norm(btn.textContent || '').includes(targetModeLabel)) return { ok: true };
    if (!(await openModeMenu())) return { ok: false, reason: '未找到千问生成模式按钮' };
    const item = findModeItem(targetModeLabel);
    if (!item) {
      const modeBtn = currentModeButton();
      if (modeBtn) clickEl(modeBtn);
      await sleep(600);
      return { ok: true, reason: '千问页面未提供生成模式：' + targetModeLabel + '，保持默认模式' };
    }
    clickEl(item);
    await sleep(900);
    return { ok: true };
  };
  const findParamsSummaryButton = () => {
    return [...document.querySelectorAll('button, [role="button"], [class*="button" i], [class*="btn" i]')]
      .filter((el) => visible(el) && canClick(el) && el.getAttribute('aria-expanded') !== 'true')
      .find((el) => {
        const t = labelOf(el);
        const cls = typeof el.className === 'string' ? el.className : '';
        return /(720|1080)P\s*[··]?\s*\d+s/.test(t) || /(720|1080)P|超清|高清/.test(t) || /capsuleSecondaryGap/i.test(cls);
      }) || null;
  };
  const findParamsPanel = () => {
    const all = [...document.querySelectorAll('[role="menu"], [data-radix-menu-content], [class*="morePanel" i], [class*="menuContent" i], [class*="popup" i], [class*="drawer" i], [class*="setting" i], [class*="param" i]')].filter(visible);
    const withText = all
      .filter((el) => /清晰度/.test(norm(el.textContent || '')) && /(9:16|3:4|1:1|4:3|16:9|\\d+\\s*秒|智能配音)/.test(norm(el.textContent || '')))
      .filter((el) => el.querySelectorAll('button').length >= 4)
      .sort((a, b) => (a.textContent || '').length - (b.textContent || '').length);
    return withText.find((el) => typeof el.className === 'string' && /morePanel/i.test(el.className))
      || withText.find((el) => el.getAttribute('data-state') === 'open')
      || withText[0]
      || findAnyParamsPanel();
  };
  const findAnyParamsPanel = () => {
    return [...document.querySelectorAll('div, section, [role="menu"], [data-radix-menu-content]')]
      .filter(visible)
      .filter((el) => /清晰度/.test(norm(el.textContent || '')) && /(9:16|3:4|1:1|4:3|16:9|\\d+\\s*秒|智能配音)/.test(norm(el.textContent || '')))
      .filter((el) => el.querySelectorAll('button').length >= 4)
      .sort((a, b) => (a.textContent || '').length - (b.textContent || '').length)[0] || null;
  };
  const openParamsPanel = async () => {
    if (findParamsPanel()) return true;
    const summary = findParamsSummaryButton();
    if (!summary) return false;
    clickEl(summary);
    await sleep(1800);
    return !!findParamsPanel();
  };
  const findSection = (panel, title) => {
    const candidates = [...panel.querySelectorAll('[class*="moreSection" i], [class*="section" i], [class*="item" i], [class*="row" i], [class*="group" i], [class*="field" i], div')]
      .filter(visible)
      .filter((section) => {
        const titleEl = section.querySelector('[class*="moreSectionTitle" i], [class*="title" i], [class*="label" i]');
        const t = norm(section.getAttribute('aria-label') || section.getAttribute('title') || titleEl?.textContent || '');
        const ownText = norm(section.textContent || '');
        return t === title || t.startsWith(title) || ownText.startsWith(title);
      })
      .filter((section) => section.querySelectorAll('button').length > 0);
    return candidates.sort((a, b) => a.querySelectorAll('button').length - b.querySelectorAll('button').length)[0] || null;
  };
  const isActiveOption = (el) => {
    const cls = typeof el.className === 'string' ? el.className : '';
    return cls.includes('segmentButtonActive') || el.getAttribute('aria-checked') === 'true' || el.getAttribute('data-state') === 'checked';
  };
  const findOptionButton = (section, optionLabel) => {
    return [...section.querySelectorAll('button')]
      .filter(visible)
      .find((el) => norm(el.textContent || '') === optionLabel)
      || [...section.querySelectorAll('button')]
        .filter(visible)
        .find((el) => labelOf(el) === optionLabel)
      || null;
  };
  const findOptionButtonInDocument = (optionLabel) => {
    return [...document.querySelectorAll('button, [role="button"]')]
      .filter(visible)
      .find((el) => norm(el.textContent || '') === optionLabel)
      || [...document.querySelectorAll('button, [role="button"]')]
        .filter(visible)
        .find((el) => labelOf(el) === optionLabel)
      || null;
  };
  const applyOption = async (title, optionLabel) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      let panel = findParamsPanel();
      let searchRoot = panel || document;
      let btn = panel ? findOptionButton(searchRoot, optionLabel) : null;
      if (!btn) btn = findOptionButtonInDocument(optionLabel);
      if (!panel && !btn) {
        if (!(await openParamsPanel())) return { ok: false, reason: '未找到千问参数面板（请确认已进入 AI生视频）' };
        panel = findParamsPanel();
        searchRoot = panel || document;
        btn = findOptionButtonInDocument(optionLabel);
      }
      if (panel) {
        const section = findSection(panel, title);
        searchRoot = section || panel;
        if (!btn) btn = findOptionButton(searchRoot, optionLabel);
        if (!btn) btn = findOptionButton(panel, optionLabel);
        if (!btn) btn = findOptionButtonInDocument(optionLabel);
      }
      if (!btn) return { ok: false, reason: '未找到“' + title + '”选项：' + optionLabel };
      if (isActiveOption(btn)) return { ok: true };
      clickEl(btn);
      await sleep(900);
      let check = findOptionButton(searchRoot, optionLabel);
      if (!check && panel) check = findOptionButton(panel, optionLabel);
      if (!check) check = findOptionButtonInDocument(optionLabel);
      if (check && isActiveOption(check)) return { ok: true };
      await sleep(700);
      let check2 = findOptionButton(searchRoot, optionLabel);
      if (!check2 && panel) check2 = findOptionButton(panel, optionLabel);
      if (!check2) check2 = findOptionButtonInDocument(optionLabel);
      if (check2 && isActiveOption(check2)) return { ok: true };
      if (!findParamsPanel()) {
        await openParamsPanel();
      }
    }
    return { ok: false, reason: '设置“' + title + '”失败' };
  };

  return (async () => {
    try {
    if (!(await ensureVideoMode())) return { ok: false, reason: '未找到千问 AI生视频 入口，页面结构可能已变化' };
    await closeExplicitGuides();
    forceVideoControls();

    const modelBtn = currentModelButton();
    if (!modelBtn) return { ok: false, reason: '未找到千问模型选择按钮，页面结构可能已变化' };
    if (labelOf(modelBtn) !== targetModel) {
      if (!(await openModelMenu())) return { ok: false, reason: '未找到千问模型选择按钮' };
      const item = findModelItem(targetModel);
      if (!item) return { ok: false, reason: '未找到千问模型菜单项：' + targetModel };
      clickEl(item);
      await sleep(900);
    }

    const modeApplied = await applyGenerationMode();
    if (!modeApplied.ok) return modeApplied;

    const optionsToApply = [
      ['清晰度', resolutionLabel],
      ['比例', targetRatio],
      ['视频时长', durationLabel]
    ]
    if (supportsSmartAudio) optionsToApply.push(['智能配音', audioLabel])
    for (const [title, optionLabel] of optionsToApply) {
      const applied = await applyOption(title, optionLabel)
      if (!applied.ok) return applied
    }

    return {
      ok: true,
      reason: '千问视频参数已设置',
      detail: { model: targetModel, resolution: ${JSON.stringify(resolution)}, ratio: targetRatio, durationSec: ${durationSec}, audio: ${JSON.stringify(audio)} }
    }
    } catch (e) {
      return { ok: false, reason: '千问参数脚本异常: ' + (e && e.message ? e.message : String(e)) };
    }
  })();
})()`
}

function buildFillPromptScript(prompt: string): string {
  const promptJson = JSON.stringify(prompt)
  return `(async () => {
  try {
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
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
      '[role="textbox"]',
      '[data-lexical-editor]',
      '[data-slate-editor]'
    ];
    for (const s of sels) {
      const els = [...document.querySelectorAll(s)].filter(visible);
      if (els.length) return els[0];
    }
    return null;
  };
  const setValue = (el, text) => {
    el.focus();
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement : window.HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value').set;
      setter.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    el.innerHTML = '';
    el.appendChild(document.createTextNode(text));
    el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, data: text, inputType: 'insertText' }));
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const input = findInput();
  if (!input) return { ok: false, reason: '未找到千问输入框，页面结构可能已变化' };
  setValue(input, ${promptJson});
  return { ok: true, reason: '已填入千问 prompt', tag: input.tagName.toLowerCase(), cls: (typeof input.className === 'string' ? input.className : '').slice(0, 120) };
  } catch (e) {
    return { ok: false, reason: '千问 prompt 填写脚本异常: ' + (e && e.message ? e.message : String(e)) };
  }
})()`
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
      '[role="textbox"]',
      '[data-lexical-editor]',
      '[data-slate-editor]'
    ];
    for (const s of sels) {
      const els = [...document.querySelectorAll(s)].filter(visible);
      if (els.length) return els[0];
    }
    return null;
  };
  const chatInput = findInput();
  if (!chatInput) return { ok: false, reason: '未找到千问输入框，无法通过 Ctrl+V 上传素材，请开启显示窗口确认已进入 AI生视频' };
  chatInput.focus();
  try { chatInput.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
  await sleep(300);
  return { ok: true, reason: '千问输入框已聚焦，准备通过 Ctrl+V 上传素材' };
  } catch (e) {
    return { ok: false, reason: '千问素材上传脚本异常: ' + (e && e.message ? e.message : String(e)) };
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
      '[role="textbox"]',
      '[data-lexical-editor]',
      '[data-slate-editor]'
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
    return { ok: false, reason: '千问发送按钮仍为禁用状态，prompt 未进入编辑器状态' };
  }
  clickEl(send);
  return { ok: true, reason: '已点击千问发送按钮', aria: send.getAttribute('aria-label') || '', text: norm(send.textContent || '').slice(0, 40), cls: (typeof send.className === 'string' ? send.className : '').slice(0, 120) };
  } catch (e) {
    return { ok: false, reason: '千问发送脚本异常: ' + (e && e.message ? e.message : String(e)) };
  }
})()`
}

function setupChatCapture(
  partition: string,
  ses: Electron.Session,
  captured: { current: CapturedChatRequest | null }
): void {
  const existing = chatCaptureRegistrations.get(partition)
  if (existing) {
    existing.captured = captured
    return
  }

  const registration: ChatCaptureRegistration = { captured }
  chatCaptureRegistrations.set(partition, registration)

  ses.webRequest.onBeforeRequest({ urls: CHAT_API_URLS }, (details, callback) => {
    callback({})
    const target = chatCaptureRegistrations.get(partition)?.captured
    if (!target) return
    if (isQwenDetailUrl(details.url)) return
    const bodyText = readUploadDataText(details)
    const next: CapturedChatRequest = { ...target.current }
    mergeCapturedFromUrl(next, details.url)
    mergeCapturedFromJsonBody(next, bodyText)
    mergeCapturedFromFormBody(next, bodyText)
    target.current = next
  })

  ses.webRequest.onBeforeSendHeaders({ urls: CHAT_API_URLS }, (details, callback) => {
    const headers = details.requestHeaders
    const target = chatCaptureRegistrations.get(partition)?.captured
    if (target) {
      if (isQwenDetailUrl(details.url)) {
        callback({ requestHeaders: headers })
        return
      }
      const next: CapturedChatRequest = { ...target.current }
      const deviceId = findRequestHeader(headers, ['x-deviceid', 'x-device-id'])
      if (deviceId) next.deviceId = deviceId
      const xsrfToken = findRequestHeader(headers, ['x-xsrf-token'])
      if (xsrfToken) next.xsrfToken = xsrfToken
      const cookie = findRequestHeader(headers, ['cookie'])
      if (cookie) next.cookie = cookie
      const reqIdHeader = findRequestHeader(headers, ['x-chat-id', 'x-request-id', 'request-id'])
      if (reqIdHeader && !next.reqId) next.reqId = reqIdHeader
      const sessionHeader = findRequestHeader(headers, ['x-session-id', 'x-chat-session-id'])
      if (sessionHeader && !next.sessionId) next.sessionId = sessionHeader
      const chatBizHeader = findRequestHeader(headers, ['x-chat-biz'])
      if (chatBizHeader && (!next.reqId || !next.sessionId)) {
        mergeCapturedFromJsonBody(next, chatBizHeader)
      }
      target.current = next
    }
    callback({ requestHeaders: headers })
  })
}

async function injectStorages(win: BrowserWindow, storages: OriginStorage[]): Promise<void> {
  try {
    await win.webContents.executeJavaScript(
      `(() => {
        const all = ${JSON.stringify(storages)};
        const main = all.find((s) => location.origin === s.origin) || all.find((s) => (s.origin || '').includes('qianwen.com'));
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

async function waitForChatCapture(
  captured: { current: CapturedChatRequest | null },
  cancelState: { aborted: boolean; submitted: boolean } | undefined,
  timeoutMs: number
): Promise<CapturedChatRequest | null> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (captured.current?.reqId && captured.current.sessionId) return captured.current
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

function extractVideoFromDetail(data: unknown): { url: string; posterUrl: string } | null {
  const root = data as { data?: { response_messages?: Array<Record<string, unknown>> } }
  if (!root?.data?.response_messages) return null
  for (const msg of root.data.response_messages) {
    if (msg.mime_type !== 'multi_load/iframe') continue
    const meta = msg.meta_data as { multi_load?: Array<{ html?: { sc_html?: string } }> } | undefined
    const scHtml = meta?.multi_load?.[0]?.html?.sc_html
    if (!scHtml) continue
    const videoMatch = scHtml.match(/src="(https?:\/\/[^"]+\.mp4[^"]*)"/)
    if (!videoMatch) continue
    const posterMatch = scHtml.match(/poster="(https?:\/\/[^"]+\.jpg[^"]*)"/)
    return { url: videoMatch[1], posterUrl: posterMatch ? posterMatch[1] : '' }
  }
  return null
}

function extractBlockedFromDetail(data: unknown): string | null {
  const root = data as { data?: { response_messages?: Array<Record<string, unknown>> } }
  const texts = (root?.data?.response_messages ?? [])
    .map((msg) => {
      if (typeof msg.content === 'string') return msg.content
      if (typeof msg.text === 'string') return msg.text
      if (typeof msg.message === 'string') return msg.message
      if (Array.isArray(msg.content)) {
        return msg.content
          .map((part) => (typeof part === 'string' ? part : (part as { text?: string }).text ?? ''))
          .filter(Boolean)
          .join('\n')
      }
      return ''
    })
    .join('\n')
  return blockedMessageFromText(texts)
}

interface QwenPollResult {
  ok: boolean
  video?: { url: string; posterUrl: string }
  error?: string
  blocked?: boolean
}

async function pollQwenDetail(
  captured: CapturedChatRequest,
  partition: string,
  maxWaitMs: number,
  onProgress: (stage: string, detail?: unknown) => void
): Promise<QwenPollResult> {
  const reqId = captured.reqId ?? ''
  const sessionId = captured.sessionId ?? ''
  const deviceId = captured.deviceId ?? ''
  const xsrfToken = captured.xsrfToken ?? ''
  const cookie = captured.cookie || (await cookieHeaderFromSession(partition))
  const params = new URLSearchParams({
    biz_id: 'ai_qwen',
    chat_client: 'h5',
    device: 'pc',
    fr: 'pc',
    pr: 'qwen',
    ut: deviceId,
    la: 'zh-CN',
    tz: 'Asia/Shanghai',
    wv: '4.1.4',
    ve: '4.1.4',
    session_id: sessionId,
    req_id: reqId + '_complete'
  })
  const started = Date.now()
  while (Date.now() - started < maxWaitMs) {
    try {
      const res = await fetch(`${DETAIL_API_URL}?${params.toString()}`, {
        headers: {
          accept: '*/*',
          cookie,
          'x-deviceid': deviceId,
          'x-platform': 'pc_tongyi',
          'x-xsrf-token': xsrfToken,
          'user-agent': UA,
          referer: `https://www.qianwen.com/chat/${sessionId}`
        },
        signal: AbortSignal.timeout(15000)
      })
      if (res.status === 401 || res.status === 403) {
        return { ok: false, error: '千问接口返回 401/403，可能登录态失效或风控限制' }
      }
      if (res.status === 200) {
        const json = (await res.json()) as unknown
        const blocked = extractBlockedFromDetail(json)
        if (blocked) {
          return { ok: false, blocked: true, error: blocked }
        }
        const video = extractVideoFromDetail(json)
        if (video) return { ok: true, video }
      }
    } catch {
      // 单次轮询失败继续
    }
    onProgress('waiting', { message: '等待千问生成完成…' })
    await sleep(5000)
  }
  return { ok: false, error: '等待超时未取到千问视频 URL' }
}

export async function runQwenGeneration(options: QwenGenerateOptions): Promise<QwenGenerateResult> {
  const attempts: Array<{ providerId: string; ok: boolean; errorMessage?: string }> = []
  const failWith = (error: string): QwenGenerateResult => fail(error, attempts)
  const cancelState = options.cancel
  let win: BrowserWindow | null = null

  const abortIfCancelled = (): QwenGenerateResult | null => {
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

  const abortNow = (): QwenGenerateResult => abortIfCancelled() ?? failCancelled(attempts)

  let qwenMode = options.mode || 'multi_ref'
  if (qwenMode === 'firstlast') qwenMode = 'first_last'
  if (!QWEN_IMAGE_MODES.has(qwenMode)) {
    return failWith('千问当前仅支持多参考/首帧/首尾帧生成（需至少上传一张素材图片）')
  }
  const images = (options.images ?? []).slice(0, MAX_QWEN_IMAGES)
  if (images.length === 0) {
    return failWith('千问多参考/首帧/首尾帧生成需要至少上传一张素材图片')
  }
  options.images = images
  options.mode = qwenMode

  const partition = options.keyId ? `persist:qf-p:qwenwan:${options.keyId}` : 'persist:qf-p:qwenwan'
  options.onProgress?.('inject-cookies')
  await injectCookies(options.cookies, partition)

  const captured: { current: CapturedChatRequest | null } = { current: null }
  const ses = session.fromPartition(partition)
  ses.setUserAgent(UA)
  setupChatCapture(partition, ses, captured)

  {
    const aborted = abortIfCancelled()
    if (aborted) return aborted
  }

  options.onProgress?.('open-page')
  win = new BrowserWindow({
    show: options.showWebview === true,
    width: 1280,
    height: 900,
    title: '千问生成 - Quota-Flow',
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
      win.loadURL(QWEN_CHAT_URL),
      waitOrAbort(90000).then((ab) => {
        if (ab) throw new Error('已取消')
        throw new Error('页面加载超时')
      })
    ])
  } catch (e) {
    loadError = { code: -1, desc: e instanceof Error ? e.message : String(e), url: QWEN_CHAT_URL }
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
          '[role="textbox"]',
          '[data-lexical-editor]',
          '[data-slate-editor]'
        ];
        return [...document.querySelectorAll(sels.join(','))].some((el) => el.offsetParent !== null);
      })()`,
      true
    ))
  } catch {}

  if (loadError || !inputFound) {
    win.destroy()
    return failWith(loadError ? `页面加载失败 (${loadError.code}: ${loadError.desc})` : '千问账号未登录（cookie 可能已失效），请在厂商页重新登录后重试')
  }

  const urlSessionId = qwenSessionIdFromUrl(win.webContents.getURL())
  if (urlSessionId) {
    captured.current = { sessionId: urlSessionId }
  }

  {
    const aborted = abortIfCancelled()
    if (aborted) return aborted
  }

  options.onProgress?.('apply-params', {
    prompt: options.prompt,
    model: options.model,
    mode: options.mode,
    resolution: options.resolution,
    ratio: options.ratio,
    audio: options.audio,
    durationSec: options.durationSec
  })
  let prepareResult: { ok?: boolean; reason?: string } = {}
  try {
    prepareResult = (await win.webContents.executeJavaScript(
      buildPrepareQwenComposerScript(options),
      true
    )) as typeof prepareResult
  } catch (e) {
    prepareResult = { ok: false, reason: scriptError('千问参数设置', e) }
  }
  if (!prepareResult.ok) {
    win.destroy()
    return failWith(prepareResult.reason || '千问页面参数设置失败')
  }

  {
    const aborted = abortIfCancelled()
    if (aborted) return aborted
  }

  options.onProgress?.('upload-images')
  let uploadResult: { ok?: boolean; cancelled?: boolean; reason?: string } = {}
  let uploadSettled = false
  const uploadPromise = uploadQwenReferences(win, options.images ?? [], cancelState)
  const cancelPromise = cancelState
    ? (async () => {
        while (!uploadSettled) {
          if (cancelState.aborted) {
            return { cancelled: true, reason: '已手动终止生成（提示词未发送）' }
          }
          await sleep(200)
        }
        return null
      })()
    : new Promise<never>(() => {})
  uploadResult = (await Promise.race([uploadPromise, cancelPromise])) as typeof uploadResult
  uploadSettled = true
  if (uploadResult.cancelled) {
    win.destroy()
    return abortNow()
  }
  if (!uploadResult.ok) {
    win.destroy()
    return failWith(uploadResult.reason || '千问素材上传失败')
  }

  {
    const aborted = abortIfCancelled()
    if (aborted) return aborted
  }

  captured.current = urlSessionId ? { sessionId: urlSessionId } : null
  options.onProgress?.('submit', { prompt: options.prompt, model: options.model })
  let fillResult: { ok?: boolean; reason?: string } = {}
  try {
    fillResult = (await win.webContents.executeJavaScript(
      buildFillPromptScript(options.prompt),
      true
    )) as typeof fillResult
  } catch (e) {
    fillResult = { ok: false, reason: scriptError('千问 prompt 填写', e) }
  }
  if (!fillResult.ok) {
    win.destroy()
    return failWith(fillResult.reason || '千问 prompt 填写失败')
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
    sendResult = { ok: false, reason: scriptError('千问发送', e) }
  }
  if (!sendResult.ok) {
    win.destroy()
    return failWith(sendResult.reason || '千问发送失败')
  }

  if (cancelState) cancelState.submitted = true
  options.onProgress?.('waiting', { message: '已发送 prompt，等待千问生成…' })
  const chat = await waitForChatCapture(captured, cancelState, 15000)
  if (!chat?.reqId || !chat.sessionId) {
    win.destroy()
    return failWith('未捕获到千问生成请求（req_id/session_id），请开启显示窗口或确认页面已正常发送')
  }
  if (!chat.deviceId || !chat.xsrfToken) {
    win.destroy()
    return failWith('未捕获到千问生成请求头（x-deviceid/x-xsrf-token），请开启显示窗口后重试')
  }

  options.onProgress?.('waiting')
  const poll = await pollQwenDetail(chat, partition, (options.maxWaitSec ?? 360) * 1000, (stage, detail) =>
    options.onProgress?.(stage, detail)
  )
  win.destroy()

  if (!poll.ok) {
    if (poll.blocked) {
      return failBlocked(poll.error ?? '千问拒绝了本次生成', attempts)
    }
    return failWith(poll.error ?? '等待超时未取到千问视频 URL')
  }
  if (!poll.video) {
    return failWith('等待超时未取到千问视频 URL')
  }
  const video = poll.video
  attempts.push({ providerId: 'qwenwan', ok: true })
  return {
    ok: true,
    providerId: 'qwenwan',
    videoUrl: video.url,
    posterUrl: video.posterUrl || null,
    attempts
  }
}
