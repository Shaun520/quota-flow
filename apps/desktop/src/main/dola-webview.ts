// Dola WebView 生成执行引擎
// 链路：cookie/storage 注入 → 打开 Dola 官网 → 点击「视频生成」→ 通过真实 DOM 选择模型/时长/比例
//       → 通过 Ctrl+V 粘贴多参考图片（最多 10 张）→ 追加 prompt → 点击生成 → 轮询页面/网络媒体地址提取 mp4 URL
// 说明：Dola 视频生成有独立入口与参数控件，参数不拼入 prompt。

import { app, BrowserWindow, clipboard, session } from 'electron'
import { existsSync, mkdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { OriginStorage, ProviderCookie } from './webview-engine'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36'
const DOLA_URL = 'https://www.dola.com/chat/'
const BLOCKED_PATTERN = /违[规法]|内容审核|无法生成|版权|侵权|肖像|敏感|检测到.*(风险|违规)|拒绝生成|请勿生成|无法返回该内容/
const MAX_DOLA_IMAGES = 10
const ALLOWED_MODELS = ['Dreamina Seedance 2.5', 'Dreamina Seedance 2.0 Fast', 'Dreamina Seedance 1.0']
const ALLOWED_DURATIONS = [5, 10]
const ALLOWED_RATIOS = ['1:1', '3:4', '4:3', '9:16', '16:9', '21:9']

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export interface DolaGenerateOptions {
  cookies: ProviderCookie[]
  storages?: OriginStorage[]
  prompt: string
  images?: string[]
  mode?: string
  model?: string
  durationSec?: number
  ratio?: string
  keyId?: string
  showWebview?: boolean
  maxWaitSec?: number
  cancel?: { aborted: boolean; submitted: boolean }
  onProgress?: (stage: string, detail?: unknown) => void
}

export interface DolaGenerateResult {
  ok: boolean
  providerId: 'dola'
  videoUrl?: string
  posterUrl?: string | null
  error?: string
  blocked?: boolean
  cancelled?: boolean
  attempts: Array<{ providerId: string; ok: boolean; errorMessage?: string }>
}

interface CapturedDolaMedia {
  mediaUrls: Set<string>
}

interface DolaCaptureRegistration {
  captured: { current: CapturedDolaMedia | null }
}

const captureRegistrations = new Map<string, DolaCaptureRegistration>()

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

function fail(error: string, attempts: Array<{ providerId: string; ok: boolean; errorMessage?: string }>): DolaGenerateResult {
  attempts.push({ providerId: 'dola', ok: false, errorMessage: error })
  return { ok: false, providerId: 'dola', error, attempts }
}

function failBlocked(error: string, attempts: Array<{ providerId: string; ok: boolean; errorMessage?: string }>): DolaGenerateResult {
  const result = fail(error, attempts)
  return { ...result, blocked: true }
}

function failCancelled(attempts: Array<{ providerId: string; ok: boolean; errorMessage?: string }>): DolaGenerateResult {
  const error = '已手动终止生成（提示词未发送）'
  attempts.push({ providerId: 'dola', ok: false, errorMessage: error })
  return { ok: false, providerId: 'dola', cancelled: true, error, attempts }
}

function setupDolaCapture(
  partition: string,
  ses: Electron.Session,
  captured: { current: CapturedDolaMedia | null }
): void {
  const existing = captureRegistrations.get(partition)
  if (existing) {
    existing.captured = captured
    return
  }

  const registration: DolaCaptureRegistration = { captured }
  captureRegistrations.set(partition, registration)

  ses.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
    callback({})
    const target = captureRegistrations.get(partition)?.captured
    if (!target?.current) return
    if (/\.mp4([?#]|$)/i.test(details.url)) {
      target.current.mediaUrls.add(details.url)
    }
  })
}

async function injectCookies(cookies: ProviderCookie[], partition: string): Promise<number> {
  const ses = session.fromPartition(partition)
  ses.setUserAgent(UA)
  let injected = 0
  for (const c of cookies) {
    try {
      const cleanDomain = (c.domain || '').replace(/^\./, '') || 'www.dola.com'
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
        const main = all.find((s) => location.origin === s.origin) || all.find((s) => (s.origin || '').includes('dola.com'));
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

/** 参数分步脚本共用的页面内 DOM 辅助。脚本只「定位返回坐标」，真实点击由主进程 sendInputEvent 完成，
 *  以兼容 Dola 的 Radix 受控菜单（合成事件无法展开下拉）。 */
const DOLA_PARAM_HELPERS = `
  const norm = (s) => (s || '').replace(/[\\s\\n\\u{3000}]/gu, ' ').trim();
  const visible = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0'; };
  const canClick = (el) => el.disabled !== true && el.getAttribute('aria-disabled') !== 'true';
  const labelOf = (el) => norm((el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '') + ' ' + (el.textContent || ''));
  const keyOf = (s) => (s || '').replace(/[\\s·•]/g, '').toLowerCase();
  const findButton = (m) => [...document.querySelectorAll('button, [role="button"], a, [class*="button" i], [class*="btn" i]')].filter((el) => visible(el) && canClick(el)).find(m);
  const findAny = (m) => [...document.querySelectorAll('button, [role="button"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"], a, div, span')].filter(visible).find(m);
  const findMenuItemInOpenMenu = (m) => {
    const menus = [...document.querySelectorAll('[role="menu"], [role="listbox"], [role="menubar"], [data-radix-menu-content], [data-radix-popper-content-wrapper]')].filter(visible);
    for (const menu of menus) { const hit = [...menu.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"]')].filter(visible).find(m); if (hit) return hit; }
    return [...document.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"]')].filter(visible).find(m);
  };
  const pt = (el) => { const r = el.getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]; };
  const cands = () => [...document.querySelectorAll('button, [role="button"], [role="menuitem"], [role="menuitemradio"], [role="option"], a, div, span')].filter(visible).map((el) => labelOf(el)).filter((t) => t && /seedance|模型|2\s*\.?\s*5|1\s*\.?\s*0|fast|比例|时长/i.test(t)).slice(0, 18).join(' | ');
`

/** 参数单步脚本包装：body 返回 { ok, points:[[x,y]...], reason } */
function paramStepScript(body: string): string {
  return `(async () => { const run = async () => { ${DOLA_PARAM_HELPERS} ${body} }; try { return await run(); } catch (e) { return { ok: false, reason: 'step: ' + (e && e.message ? e.message : String(e)) }; } })()`
}

/** 主进程发送真实鼠标输入事件完成点击（受信事件，可展开 Dola Radix 菜单） */
async function realClickDola(win: BrowserWindow, points: number[][]): Promise<void> {
  for (const [x, y] of points) {
    win.webContents.sendInputEvent({ type: 'mouseMove', x, y })
    win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
    await sleep(300)
  }
}

/**
 * 进入 Dola 视频生成界面并设置模型/时长/比例（真实点击）。
 * 每步：页面脚本定位元素并返回中心坐标 → 主进程 sendInputEvent 真实点击 → 等菜单展开再点目标项。
 */
async function setupDolaParams(
  win: BrowserWindow,
  opts: { model?: string; durationSec?: number; ratio?: string },
  cancelState?: { aborted: boolean; submitted: boolean }
): Promise<{ ok: boolean; reason?: string }> {
  const modelName = opts.model || ALLOWED_MODELS[0]
  const tModelKey = modelName.replace(/[\s·•]/g, '').toLowerCase()
  const tModelKey2 = tModelKey.replace(/^dreamina/, '')
  const tDur = opts.durationSec === 10 ? '10s' : '5s'
  const tRatioKey = (opts.ratio || '9:16').replace(/[\s·•]/g, '').toLowerCase()

  const runStep = async (body: string, waitMs: number, label: string): Promise<{ ok: boolean; cancelled?: boolean; reason?: string }> => {
    if (cancelState?.aborted) return { ok: false, cancelled: true, reason: '已手动终止生成（提示词未发送）' }
    const r = (await win.webContents.executeJavaScript(paramStepScript(body), true)) as { ok?: boolean; reason?: string; points?: number[][] }
    if (r?.ok === false) return { ok: false, reason: (label ? label + '：' : '') + (r.reason || '定位失败') }
    await realClickDola(win, r?.points ?? [])
    if (waitMs) await sleep(waitMs)
    return { ok: true }
  }

  // 1) 关闭 Cookie 提示（有则点击）
  const cookie = await runStep(
    `const el = findButton((node) => { const t = labelOf(node); return t === '我知道了' || t === '我知道了cookie政策' || (t.includes('我知道了') && /cookie|政策|使用/.test(t)); }); if (!el) return { ok: true, points: [] }; return { ok: true, points: [pt(el)] };`,
    700,
    '关闭 Cookie 提示'
  )
  if (!cookie.ok) return cookie

  // 2) 进入视频生成界面
  const entry = await runStep(
    `const hasToolbar = [...document.querySelectorAll('button,[role="button"]')].filter(visible).some((el)=>{ const t=labelOf(el); const k=keyOf(t); return (k.includes('模型') && /seedance|2\\.5|2\\.0|1\\.0/.test(k)) || /(10s|5s)/.test(k) || k.includes('比例'); }); if (hasToolbar) return { ok: true, points: [] }; const en=findButton((el)=>{ const t=labelOf(el); const cls=(typeof el.className==='string'?el.className:'').toLowerCase(); return t==='视频生成'||(cls.includes('skill-bar-button')&&t.includes('视频生成')&&!/额度|计算|说明|帮助|历史/.test(t)); }); if(!en) return { ok:false, points:[], reason:'未找到「视频生成」入口；候选:'+cands() }; return { ok:true, points:[pt(en)] };`,
    2000,
    '进入视频生成'
  )
  if (!entry.ok) return entry
  await sleep(500)

  // 3) 模型：触发按钮 → 展开 → 目标项
  const model = await runStep(
    `const cur=findButton((el)=>{ const t=keyOf(labelOf(el)); return t.includes('模型')||t.includes('seedance'); }); if(cur && keyOf(labelOf(cur)).includes(${JSON.stringify(tModelKey)})) return { ok:true, points:[] }; const tr=findButton((el)=>{ const t=keyOf(labelOf(el)); return t.includes('seedance')||t.includes('模型'); }) || findAny((el)=>{ const t=keyOf(labelOf(el)); return t.includes('seedance')||t.includes('模型'); }); if(!tr) return { ok:false, points:[], reason:'未找到模型触发按钮；候选:'+cands() }; return { ok:true, points:[pt(tr)] };`,
    1200,
    'Dola 模型设置失败'
  )
  if (!model.ok) return model
  const modelItem = await runStep(
    `const it=findMenuItemInOpenMenu((el)=>{ const t=keyOf(labelOf(el)); return t.includes(${JSON.stringify(tModelKey)}) || t.includes(${JSON.stringify(tModelKey2)}); }) || findAny((el)=>{ const t=keyOf(labelOf(el)); return t.includes(${JSON.stringify(tModelKey)}) || t.includes(${JSON.stringify(tModelKey2)}); }); if(!it) return { ok:false, points:[], reason:'下拉中未找到目标项；候选:'+cands() }; return { ok:true, points:[pt(it)] };`,
    900,
    'Dola 模型设置失败'
  )
  if (!modelItem.ok) return modelItem

  // 4) 时长
  const dur = await runStep(
    `const cur=findButton((el)=>{ const t=keyOf(labelOf(el)); return /(10s|5s|10秒|5秒|时长)/.test(t); }); if(cur && keyOf(labelOf(cur)).includes(${JSON.stringify(tDur)})) return { ok:true, points:[] }; const tr=findButton((el)=>{ const t=keyOf(labelOf(el)); return /(10s|5s|10秒|5秒|时长)/.test(t); }) || findAny((el)=>{ const t=keyOf(labelOf(el)); return /(10s|5s|10秒|5秒|时长)/.test(t); }); if(!tr) return { ok:false, points:[], reason:'未找到时长触发按钮；候选:'+cands() }; return { ok:true, points:[pt(tr)] };`,
    1200,
    'Dola 时长设置失败'
  )
  if (!dur.ok) return dur
  const durItem = await runStep(
    `const it=findMenuItemInOpenMenu((el)=>keyOf(labelOf(el)).includes(${JSON.stringify(tDur)})) || findAny((el)=>keyOf(labelOf(el)).includes(${JSON.stringify(tDur)})); if(!it) return { ok:false, points:[], reason:'下拉中未找到目标项；候选:'+cands() }; return { ok:true, points:[pt(it)] };`,
    900,
    'Dola 时长设置失败'
  )
  if (!durItem.ok) return durItem

  // 5) 比例
  const ratioStep = await runStep(
    `const cur=findButton((el)=>{ const t=keyOf(labelOf(el)); return t.includes(${JSON.stringify(tRatioKey)}) || /(比例|16:9|9:16|1:1)/.test(t); }); if(cur && keyOf(labelOf(cur)).includes(${JSON.stringify(tRatioKey)})) return { ok:true, points:[] }; const tr=findButton((el)=>{ const t=keyOf(labelOf(el)); return /(比例|16:9|9:16|1:1)/.test(t); }) || findAny((el)=>{ const t=keyOf(labelOf(el)); return /(比例|16:9|9:16|1:1)/.test(t); }); if(!tr) return { ok:false, points:[], reason:'未找到比例触发按钮；候选:'+cands() }; return { ok:true, points:[pt(tr)] };`,
    1200,
    'Dola 比例设置失败'
  )
  if (!ratioStep.ok) return ratioStep
  const ratioItem = await runStep(
    `const it=findMenuItemInOpenMenu((el)=>keyOf(labelOf(el)).includes(${JSON.stringify(tRatioKey)})) || findAny((el)=>keyOf(labelOf(el)).includes(${JSON.stringify(tRatioKey)})); if(!it) return { ok:false, points:[], reason:'下拉中未找到目标项；候选:'+cands() }; return { ok:true, points:[pt(it)] };`,
    900,
    'Dola 比例设置失败'
  )
  if (!ratioItem.ok) return ratioItem

  return { ok: true, reason: 'Dola 视频生成参数已设置' }
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
      '.tiptap.ProseMirror',
      '.ProseMirror',
      '.tiptap',
      '[data-slate-editor="true"]',
      'textarea',
      'input:not([type="file"]):not([type="hidden"]):not([type="submit"]):not([type="button"])',
      '[contenteditable="true"]',
      '[contenteditable="plaintext-only"]',
      '[contenteditable]:not([contenteditable="false"])',
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
  if (!input) return { ok: false, reason: '未找到 Dola prompt 输入框，可能未登录或页面结构已变化' };
  appendText(input, ${promptJson});
  await sleep(500);
  return { ok: true, reason: '已填入 Dola prompt', tag: input.tagName.toLowerCase(), cls: (typeof input.className === 'string' ? input.className : '').slice(0, 120) };
  } catch (e) {
    return { ok: false, reason: 'Dola prompt 填写脚本异常: ' + (e && e.message ? e.message : String(e)) };
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
      '.tiptap.ProseMirror',
      '.ProseMirror',
      '.tiptap',
      '[data-slate-editor="true"]',
      'textarea',
      'input:not([type="file"]):not([type="hidden"]):not([type="submit"]):not([type="button"])',
      '[contenteditable="true"]',
      '[contenteditable="plaintext-only"]',
      '[contenteditable]:not([contenteditable="false"])',
      '[role="textbox"]'
    ];
    for (const s of sels) {
      const els = [...document.querySelectorAll(s)].filter(visible);
      if (els.length) return els[0];
    }
    return null;
  };
  const input = findInput();
  if (!input) return { ok: false, reason: '未找到 Dola 输入框，无法通过 Ctrl+V 上传素材，请开启显示窗口确认页面正常' };
  input.focus();
  if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
    const len = (input.value || '').length;
    input.setSelectionRange(len, len);
  } else {
    const sel = window.getSelection();
    if (sel) {
      sel.selectAllChildren(input);
      sel.collapseToEnd();
    }
  }
  try { input.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
  await sleep(300);
  return { ok: true, reason: 'Dola 输入框已聚焦，准备通过 Ctrl+V 上传素材' };
  } catch (e) {
    return { ok: false, reason: 'Dola 素材上传脚本异常: ' + (e && e.message ? e.message : String(e)) };
  }
})()`
}

/**
 * 构造 Windows CF_HDROP（DROPFILES）剪贴板数据：把多张图片的本地路径以「多文件」方式一次写入剪贴板，
 * 这样 Dola 输入框一次 Ctrl+V 即可把多张图全部贴进来（而非逐张粘贴导致只保留一张）。
 */
function buildCFHDrop(paths: string[]): Buffer {
  const enc: Buffer[] = []
  for (const p of paths) {
    enc.push(Buffer.from(p, 'utf16le'))
    enc.push(Buffer.alloc(2)) // 每个路径以 NUL 结尾
  }
  const filesLen = enc.reduce((n, b) => n + b.length, 0)
  const buf = Buffer.alloc(20 + filesLen + 2)
  buf.writeUInt32LE(20, 0) // pFiles：文件列表相对头部的偏移（20 = 头部长度）
  buf.writeUInt32LE(0, 4)  // pt.x
  buf.writeUInt32LE(0, 8)  // pt.y
  buf.writeUInt32LE(0, 12) // fNC
  buf.writeUInt32LE(1, 16) // fWide：使用 UTF-16
  let o = 20
  for (const b of enc) {
    b.copy(buf, o)
    o += b.length
  }
  buf.writeUInt16LE(0, o) // 列表末尾补双 NUL
  return buf
}

async function uploadDolaImages(
  win: BrowserWindow,
  images: string[],
  cancelState?: { aborted: boolean; submitted: boolean }
): Promise<{ ok: boolean; cancelled?: boolean; reason?: string }> {
  const files = (images || []).filter((p) => existsSync(p))
  if (files.length === 0) {
    return { ok: false, reason: '读取 Dola 素材图片失败，请确认图片文件仍存在' }
  }
  const savedText = clipboard.readText()
  const savedImage = clipboard.readImage()
  // paste() 依赖窗口可见可聚焦，隐藏窗口下 Ctrl+V 粘贴图片不生效；
  // 上传素材阶段临时显示窗口，传完再恢复隐藏。
  const wasVisible = win.isVisible()
  if (!wasVisible) {
    win.show()
    win.center()
  }
  win.webContents.focus()
  win.focus()
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
    if (cancelState?.aborted) {
      return { ok: false, cancelled: true, reason: '已手动终止生成（提示词未发送）' }
    }
    const focus = (await win.webContents.executeJavaScript(
      buildFocusInputScript(),
      true
    )) as { ok: boolean; reason?: string }
    if (!focus.ok) {
      return { ok: false, reason: focus.reason || '未找到 Dola 输入框，无法通过 Ctrl+V 上传素材' }
    }
    win.webContents.focus()
    // 多张图一次写入剪贴板的文件列表，再粘贴一次（Dola 支持一次粘贴多张图）
    clipboard.writeBuffer('CF_HDROP', buildCFHDrop(files))
    win.webContents.paste()
    if (await sleepOrAbort(2500)) {
      return { ok: false, cancelled: true, reason: '已手动终止生成（提示词未发送）' }
    }
    return { ok: true, reason: `已在 Dola 输入框通过 Ctrl+V 粘贴 ${files.length} 张素材图片（多图一次粘贴）` }
  } catch (e) {
    return { ok: false, reason: scriptError('Dola 素材上传', e) }
  } finally {
    try {
      if (!savedImage.isEmpty() || savedText) {
        clipboard.write({ text: savedText, image: savedImage })
      } else {
        clipboard.clear()
      }
    } catch {}
    // 上传阶段临时显示的窗口恢复隐藏（原本就隐藏才 hide）
    if (!wasVisible) {
      try {
        win.hide()
      } catch {}
    }
  }
}

/**
 * 参数设置失败/进入视频界面异常时自动截屏保存到 userData/dola-debug/，便于定位页面实际状态。
 */
async function captureDolaDebug(win: BrowserWindow, tag: string): Promise<string | null> {
  try {
    const image = await win.webContents.capturePage()
    if (image.isEmpty()) return null
    const dir = join(app.getPath('userData'), 'dola-debug')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${Date.now()}-${tag}.png`)
    await writeFile(file, image.toPNG())
    return file
  } catch {
    return null
  }
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
  const isSendText = (t) => {
    const s = norm(t);
    if (!s) return false;
    if (/停止|取消/.test(s)) return false;
    if (/^(生成|发送|提交|开始)$/.test(s)) return true;
    return /^(开始生成|立即生成|发送生成|提交生成|生成视频)$/.test(s);
  };
  const isLikelySend = (el) => {
    const cls = typeof el.className === 'string' ? el.className : '';
    return /bg-dbx-text-highlight|text-dbx-text-static-white-primary/.test(cls) ||
      /send|submit|生成|发送/.test(cls);
  };
  const findInput = () => {
    const sels = [
      '.tiptap.ProseMirror',
      '.ProseMirror',
      '.tiptap',
      '[data-slate-editor="true"]',
      'textarea',
      'input:not([type="file"]):not([type="hidden"]):not([type="submit"]):not([type="button"])',
      '[contenteditable="true"]',
      '[contenteditable="plaintext-only"]',
      '[contenteditable]:not([contenteditable="false"])',
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
    const candidates = [...document.querySelectorAll('button, [role="button"], [class*="send" i], [class*="submit" i], [class*="action" i]')].filter(visible);
    const clickableCandidates = candidates.filter(canClick);
    const match = (el) =>
      isSendText(norm(el.getAttribute('aria-label') || '')) ||
      isSendText(norm(el.getAttribute('title') || '')) ||
      isSendText(norm(el.getAttribute('data-testid') || '')) ||
      isSendText(norm(el.textContent || '')) ||
      isLikelySend(el);
    const hit = clickableCandidates.find((el) => (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') && match(el)) ||
      clickableCandidates.find(match);
    if (hit) return hit;
    const input = findInput();
    if (!input) return null;
    let node = input;
    for (let i = 0; i < 6 && node; i++) {
      const parent = node.parentElement;
      if (!parent) break;
      const icons = [...parent.querySelectorAll('button, [role="button"]')].filter(
        (el) => visible(el) && canClick(el) && (el.querySelector('svg') || isLikelySend(el))
      );
      if (icons.length) return icons[icons.length - 1];
      node = parent;
    }
    return clickableCandidates.filter((el) => (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') && (el.querySelector('svg') || isLikelySend(el))).pop() || null;
  };
  await sleep(400);
  let send = findSend();
  if (!send) return { ok: false, reason: '已填入 Dola prompt，但未找到生成按钮' };
  for (let i = 0; i < 10 && (send.disabled === true || send.getAttribute('aria-disabled') === 'true'); i++) {
    await sleep(300);
    send = findSend();
    if (!send) return { ok: false, reason: '已填入 Dola prompt，但未找到生成按钮' };
  }
  if (send.disabled === true || send.getAttribute('aria-disabled') === 'true') {
    return { ok: false, reason: 'Dola 生成按钮仍为禁用状态，prompt 未进入可提交状态' };
  }
  clickEl(send);
  return { ok: true, reason: '已点击 Dola 生成按钮', aria: send.getAttribute('aria-label') || '', text: norm(send.textContent || '').slice(0, 40), cls: (typeof send.className === 'string' ? send.className : '').slice(0, 120) };
  } catch (e) {
    return { ok: false, reason: 'Dola 发送脚本异常: ' + (e && e.message ? e.message : String(e)) };
  }
})()`
}

function buildExtractResultScript(): string {
  return `(() => {
  try {
  const norm = (s) => (s || '').trim();
  const vids = [...document.querySelectorAll('video')]
    .map((v) => ({ src: (v).currentSrc || (v).src || '', poster: (v).poster || '' }))
    .filter((v) => /^https?:/.test(v.src));
  const mp4s = [];
  const seen = new Set();
  for (const el of document.querySelectorAll('*')) {
    for (const attr of ['src', 'href', 'data-src', 'data-url']) {
      const v = el.getAttribute && el.getAttribute(attr);
      if (v && /\.mp4([?#]|$)/i.test(v) && !seen.has(v)) {
        seen.add(v);
        mp4s.push(v);
      }
    }
  }
  const perf = performance.getEntriesByType('resource').map((e) => e.name).filter((name) => /\.mp4([?#]|$)/i.test(name) && !seen.has(name));
  for (const name of perf) {
    if (!seen.has(name)) { seen.add(name); mp4s.push(name); }
  }
  const text = document.body ? document.body.innerText : '';
  const blockedMatch = text.match(/违[规法]|内容审核|无法生成|版权|侵权|肖像|敏感|检测到.*(风险|违规)|拒绝生成|请勿生成|无法返回该内容/);
  let blockedText = null;
  if (blockedMatch) {
    const idx = blockedMatch.index ?? 0;
    const lineStart = text.lastIndexOf('\\n', idx) + 1;
    let lineEnd = text.indexOf('\\n', idx);
    if (lineEnd === -1) lineEnd = text.length;
    blockedText = text.slice(lineStart, lineEnd).trim().slice(0, 120) || blockedMatch[0].slice(0, 80);
  }
  return {
    vids,
    mp4s: mp4s.slice(0, 12),
    hasDone: /你的视频生成好了|生成完成|生成成功|生成完毕|下载视频|保存视频/.test(text),
    blockedText,
    textTail: text.slice(-240)
  };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
})()`
}

function buildClickVideoCardScript(): string {
  return `(() => {
  let clicked = 0;
  const seen = new Set();
  const clickEl = (el) => {
    if (!el || seen.has(el)) return;
    seen.add(el);
    try { el.click(); clicked += 1; } catch {}
  };
  const imgs = [...document.querySelectorAll('img')].filter(
    (img) => /video|poster|thumbnail/i.test(img.src || '')
  );
  for (const img of imgs.slice(0, 5)) {
    try {
      const card = img.closest('[class*="video" i], [class*="card" i], [class*="message" i], [class*="content" i]') || img.parentElement;
      if (!card) continue;
      const play = card.querySelector('button, [role="button"], [class*="play" i]');
      if (play) clickEl(play);
      else clickEl(card);
    } catch {}
  }
  const playEls = [...document.querySelectorAll('[class*="play" i]')].filter(
    (el) => el.offsetParent !== null && /video|play/i.test((el.className || '') + ' ' + (el.getAttribute('aria-label') || ''))
  );
  for (const el of playEls.slice(0, 6)) clickEl(el);
  return { clicked, found: imgs.length };
})()`
}

function pickMediaUrl(result: {
  vids?: Array<{ src: string; poster?: string }>
  mp4s?: string[]
  mediaUrls?: string[]
}): { videoUrl: string; posterUrl?: string } | null {
  const seen = new Set<string>()
  const add = (url?: string): void => {
    if (url && /^https?:/i.test(url) && !seen.has(url)) seen.add(url)
  }
  for (const v of result.vids ?? []) add(v.src)
  for (const u of result.mp4s ?? []) add(u)
  for (const u of result.mediaUrls ?? []) add(u)
  const first = [...seen][0]
  if (!first) return null
  const poster = result.vids?.find((v) => v.src === first)?.poster
  return { videoUrl: first, posterUrl: poster }
}

export async function runDolaGeneration(options: DolaGenerateOptions): Promise<DolaGenerateResult> {
  const attempts: Array<{ providerId: string; ok: boolean; errorMessage?: string }> = []
  const failWith = (error: string): DolaGenerateResult => fail(error, attempts)
  const cancelState = options.cancel
  let win: BrowserWindow | null = null

  const abortIfCancelled = (): DolaGenerateResult | null => {
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

  const abortNow = (): DolaGenerateResult => abortIfCancelled() ?? failCancelled(attempts)

  const mode = options.mode ?? 'multi_ref'
  // Dola 支持文生视频 + 多参考生成；多参考必须传图，文生视频不要求素材
  if (mode !== 'multi_ref' && mode !== 'text2video' && mode !== 't2v') {
    return failWith('Dola 不支持该生成模式，请选择「文生视频」或「多参考生成」')
  }
  const isMultiRef = mode === 'multi_ref'
  const images = (options.images ?? []).slice(0, MAX_DOLA_IMAGES)
  if (isMultiRef && images.length === 0) {
    return failWith('Dola 多参考生成需要至少上传一张素材图片')
  }
  const durationSec = options.durationSec === 10 ? 10 : 5
  if (!ALLOWED_DURATIONS.includes(durationSec)) {
    return failWith('Dola 当前仅支持 5s / 10s')
  }
  const model = options.model || ALLOWED_MODELS[0]
  if (!ALLOWED_MODELS.includes(model)) {
    return failWith('Dola 不支持的模型：' + model)
  }

  const partition = options.keyId ? `persist:qf-p:dola:${options.keyId}` : 'persist:qf-p:dola'
  options.onProgress?.('inject-cookies')
  await injectCookies(options.cookies, partition)

  const captured: { current: CapturedDolaMedia | null } = { current: null }
  const ses = session.fromPartition(partition)
  ses.setUserAgent(UA)
  setupDolaCapture(partition, ses, captured)

  {
    const aborted = abortIfCancelled()
    if (aborted) return aborted
  }

  options.onProgress?.('open-page')
  win = new BrowserWindow({
    show: options.showWebview === true,
    width: 1280,
    height: 900,
    title: 'Dola 生成 - Quota-Flow',
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
      win.loadURL(DOLA_URL),
      waitOrAbort(90000).then((ab) => {
        if (ab) throw new Error('已取消')
        throw new Error('页面加载超时')
      })
    ])
  } catch (e) {
    loadError = { code: -1, desc: e instanceof Error ? e.message : String(e), url: DOLA_URL }
  }
  if (await waitOrAbort(4000)) return abortNow()

  if (options.storages && options.storages.length > 0) {
    await injectStorages(win, options.storages)
    if (await waitOrAbort(2000)) return abortNow()
  }

  let videoEntryFound = false
  for (let i = 0; i < 15; i++) {
    try {
      const r = await win.webContents.executeJavaScript(
        `(() => {
          const norm = (s) => (s || '').trim();
          const visible = (el) => {
            const r = el.getBoundingClientRect();
            const cs = getComputedStyle(el);
            return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
          };
          const hasToolbar = [...document.querySelectorAll('button, [role="button"]')].filter(visible).some((el) => {
            const t = norm((el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '') + ' ' + (el.textContent || ''));
            return /Dreamina|Seedance|模型|比例/.test(t) || /(10s|5s|10秒|5秒)/.test(t);
          });
          const hasEntry = [...document.querySelectorAll('button, [role="button"]')].filter(visible).some((el) => {
            const t = norm((el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '') + ' ' + (el.textContent || ''));
            return t === '视频生成' || /^(视频生成|AI生视频|AI视频生成)$/.test(t) || (t.includes('视频生成') && !/额度|计算|说明|帮助|历史/.test(t));
          });
          return hasToolbar || hasEntry;
        })()`,
        true
      )
      if (r) {
        videoEntryFound = true
        break
      }
    } catch {}
    if (await waitOrAbort(1000)) return abortNow()
  }
  if (loadError || !videoEntryFound) {
    const shot = await captureDolaDebug(win, 'entry')
    win.destroy()
    return failWith((loadError ? `页面加载失败 (${loadError.code}: ${loadError.desc})` : 'Dola 页面未出现「视频生成」入口（可能未登录或定位不到入口）') + (shot ? ` [截图:${shot}]` : ''))
  }

  {
    const aborted = abortIfCancelled()
    if (aborted) return aborted
  }

  options.onProgress?.('apply-params', { prompt: options.prompt, model, durationSec, ratio: options.ratio })
  let prepareResult: { ok?: boolean; reason?: string } = {}
  try {
    prepareResult = await setupDolaParams(win, { model, durationSec, ratio: options.ratio }, cancelState)
  } catch (e) {
    prepareResult = { ok: false, reason: scriptError('Dola 参数设置', e) }
  }
  if (!prepareResult.ok) {
    if (prepareResult.reason === '已手动终止生成（提示词未发送）') {
      win.destroy()
      return failCancelled(attempts)
    }
    const shot = await captureDolaDebug(win, 'params')
    win.destroy()
    return failWith((prepareResult.reason || 'Dola 页面参数设置失败') + (shot ? ` [截图:${shot}]` : ''))
  }

  {
    const aborted = abortIfCancelled()
    if (aborted) return abortNow()
  }

  if (images.length > 0) {
    options.onProgress?.('upload-images')
    let uploadResult: { ok?: boolean; cancelled?: boolean; reason?: string } = {}
    let uploadSettled = false
    const uploadPromise = uploadDolaImages(win, images, cancelState)
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
      return failWith(uploadResult.reason || 'Dola 素材上传失败')
    }
  }

  {
    const aborted = abortIfCancelled()
    if (aborted) return abortNow()
  }

  captured.current = { mediaUrls: new Set<string>() }
  options.onProgress?.('submit', { prompt: options.prompt, model })
  let fillResult: { ok?: boolean; reason?: string } = {}
  try {
    fillResult = (await win.webContents.executeJavaScript(
      buildFillPromptScript(options.prompt),
      true
    )) as typeof fillResult
  } catch (e) {
    fillResult = { ok: false, reason: scriptError('Dola prompt 填写', e) }
  }
  if (!fillResult.ok) {
    win.destroy()
    return failWith(fillResult.reason || 'Dola prompt 填写失败')
  }

  {
    const aborted = abortIfCancelled()
    if (aborted) return abortNow()
  }

  let sendResult: { ok?: boolean; reason?: string } = {}
  try {
    sendResult = (await win.webContents.executeJavaScript(
      buildClickSendScript(),
      true
    )) as typeof sendResult
  } catch (e) {
    sendResult = { ok: false, reason: scriptError('Dola 发送', e) }
  }
  if (!sendResult.ok) {
    win.destroy()
    return failWith(sendResult.reason || 'Dola 发送失败')
  }

  if (cancelState) cancelState.submitted = true
  options.onProgress?.('waiting', { message: '已发送 prompt，等待 Dola 生成…' })
  const maxWaitMs = (options.maxWaitSec ?? 360) * 1000
  const started = Date.now()
  let clickedCard = false
  let final: { videoUrl: string; posterUrl?: string } | null = null

  while (Date.now() - started < maxWaitMs) {
    await sleep(5000)
    let r: {
      vids?: Array<{ src: string; poster?: string }>
      mp4s?: string[]
      hasDone?: boolean
      blockedText?: string | null
      textTail?: string
      ok?: boolean
      error?: string
    } = {}
    try {
      r = (await win.webContents.executeJavaScript(buildExtractResultScript(), true)) as typeof r
    } catch {
      r = {}
    }
    if (r.blockedText) {
      win.destroy()
      return failBlocked(r.blockedText, attempts)
    }
    const mediaUrls = captured.current ? [...captured.current.mediaUrls] : []
    const picked = pickMediaUrl({ ...r, mediaUrls })
    if (picked) {
      final = picked
      break
    }
    if (r.hasDone && !clickedCard) {
      clickedCard = true
      try {
        await win.webContents.executeJavaScript(buildClickVideoCardScript(), true)
      } catch {}
    }
  }

  win.destroy()
  if (!final) {
    return failWith('等待超时未取到 Dola 视频 URL')
  }
  attempts.push({ providerId: 'dola', ok: true })
  return {
    ok: true,
    providerId: 'dola',
    videoUrl: final.videoUrl,
    posterUrl: final.posterUrl ?? null,
    attempts
  }
}
