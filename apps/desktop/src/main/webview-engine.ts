// 豆包（Seedance）WebView 生成执行引擎
// 链路：cookie 注入 → 显示豆包窗口 → 进入「视频生成」→ 时长滑块（JS PointerEvent + 键盘）
//       → 填 prompt（清理 chip）→ 提交
//       → 轮询「你的视频生成好了」→ 点击视频卡片 → 提取 mp4 URL
// 由 dispatch.ts 调用，不直接暴露给渲染进程。
// 窗口策略：默认隐藏；设置「显示豆包窗口」（showWebview=true，本地缓存，用于测试/观察）时可见。
//   注意：隐藏窗口下豆包发送事件可能不触发（Enter/点击在无焦点页面失效），测试时可开启显示。

import { BrowserWindow, session } from 'electron'
import { readFileSync } from 'node:fs'

declare global {
  interface Window {
    __qfRisk?: { type: string; detail?: string | null; at?: number }
    __qfRiskProbeHooked?: boolean
    __qfFetchHooked?: boolean
    __qfXhrHooked?: boolean
    __qfUploadCancel?: boolean
  }
}

const PARTITION = 'persist:qf-p:doubao'
const DOUBAO_URL = 'https://www.doubao.com/chat/'
/** 统一 UA：必须与登录窗口、校验窗口一致（providers.ts CHROME_UA），避免服务端按设备指纹失效会话 */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36'

export interface ProviderCookie {
  name: string
  value: string
  domain?: string
  path?: string
  httpOnly?: boolean
  secure?: boolean
  expires?: number
}

/** 多 origin 存储（与 providers.ts OriginStorage 保持一致） */
export interface OriginStorage {
  origin: string
  localStorage: Array<{ key: string; value: string }>
  sessionStorage?: Array<{ key: string; value: string }>
}

export interface DoubaoGenerateOptions {
  cookies: ProviderCookie[]
  /** 兼容旧：仅 www.doubao.com 单 origin localStorage。优先使用 storages 字段 */
  localStorage?: Array<{ key: string; value: string }>
  /** 新 v2 格式：多 origin storage（候选 A）。存在时优先于 localStorage */
  storages?: OriginStorage[]
  prompt: string
  /** 生成模式：text2video / img2video（当前支持） */
  mode?: string
  /** 模型：Seedance 2.0 Mini / Seedance 2.0 Fast（默认 Mini；通过豆包页面模型选择器真实操作） */
  model?: string
  /** 清晰度：豆包规格无清晰度维度，仅透传记录 */
  resolution?: string
  /** 配音：on / off（尽力注入） */
  audio?: string
  /** 画面比例：9:16 / 16:9 / 1:1（尽力注入） */
  ratio?: string
  /** 本地图片路径（图生视频，主进程读取后以 data URL 注入页面上传） */
  images?: string[]
  /** 账号 id：用于隔离 WebView 分区（persist:qf-p:doubao:<keyId>），防多账号串号；登录窗口也共用该分区（候选 C） */
  keyId?: string
  /** 5 / 10 / 15，默认 5（1 点/次） */
  durationSec?: number
  /** 测试开关：true 时显示豆包 WebView 窗口（默认隐藏） */
  showWebview?: boolean
  /** 最长等待秒数，默认 360 */
  maxWaitSec?: number
  /** 取消/已提交状态：主进程注册表持有，提交前检查 aborted，提交后置 submitted */
  cancel?: { aborted: boolean; submitted: boolean }
  onProgress?: (stage: string, detail?: unknown) => void
}

export interface DoubaoGenerateResult {
  ok: boolean
  providerId: 'doubao'
  videoUrl?: string
  posterUrl?: string | null
  error?: string
  /** 内容政策拒绝（侵权/肖像/版权）：与账号无关，不应切换账号重试 */
  blocked?: boolean
  /** 用户手动终止（提示词未发送） */
  cancelled?: boolean
  attempts: Array<{ providerId: string; ok: boolean; errorMessage?: string }>
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 本地图片 → data URL（供页面注入上传）；超 10MB 或读取失败返回 null */
function fileToDataUrl(file: string): string | null {
  try {
    const mime = /\.png$/i.test(file)
      ? 'image/png'
      : /\.gif$/i.test(file)
        ? 'image/gif'
        : /\.webp$/i.test(file)
          ? 'image/webp'
          : 'image/jpeg'
    const buf = readFileSync(file)
    if (buf.length > 10 * 1024 * 1024) return null
    return `data:${mime};base64,${buf.toString('base64')}`
  } catch {
    return null
  }
}

/* ---------------- 页面脚本（executeJavaScript 字符串） ---------------- */

const inspectScript = (): unknown => {
  const norm = (s: string): string => (s || '').trim()
  const input = [...document.querySelectorAll('textarea, [contenteditable="true"], [contenteditable="plaintext-only"], [role="textbox"]')].find(
    (el) => (el as HTMLElement).offsetParent !== null
  ) || null
  const btns = [...document.querySelectorAll('button, [role="button"]')]
    .filter((b) => (b as HTMLElement).offsetParent !== null)
    .map((b) => norm((b as HTMLElement).textContent || ''))
    .filter(Boolean)
    .slice(0, 20)

  // 登录检测：豆包导航栏始终有「登录」按钮，不能单靠它判断
  // 真正未登录的特征：
  //   1) 登录墙出现：页面中央有大号按钮「扫码登录 / 立即登录 / 手机号登录」
  //   2) 没有任何用户头像/昵称元素
  const hasLoginWall = btns.some((t) => /^(扫码登录|立即登录|手机号登录|短信登录|验证码登录)$/.test(t))
  // 检测用户头像/昵称：已登录时导航栏显示用户信息
  const hasUserInfo = !!(
    document.querySelector('[class*="user-info" i], [class*="userinfo" i], [class*="avatar" i]') ||
    document.querySelector('img[class*="avatar" i], img[src*="avatar" i]')
  )
  const hasLogin = hasLoginWall || !hasUserInfo

  return {
    url: location.href,
    title: document.title,
    inputFound: !!input,
    inputTag: input ? input.tagName.toLowerCase() : '',
    hasLogin,
    hasLoginWall,
    hasUserInfo,
    buttons: btns.slice(0, 12)
  }
}

const openVideoTabScript = (): unknown => {
  const norm = (s: string): string => (s || '').trim()
  const btns = [...document.querySelectorAll('button, [role="button"], [role="tab"]')].filter(
    (b) => (b as HTMLElement).offsetParent !== null
  )
  const textOf = (b: Element): string => norm((b as HTMLElement).textContent || '') || norm(b.getAttribute('aria-label') || '') || norm(b.getAttribute('title') || '')
  const hit =
    btns.find((b) => textOf(b) === '视频生成') ||
    btns.find((b) => {
      const t = textOf(b)
      return t.includes('视频生成') && !/额度|计算|说明|提示|帮助/.test(t)
    })
  if (!hit) return { ok: false, reason: '未找到「视频生成」入口' }
  ;(hit as HTMLElement).click()
  return { ok: true, text: textOf(hit).slice(0, 20) }
}

// 上传图片（图生视频）：找到上传 input，注入 File 并触发 change，等待上传完成
const uploadImagesScript = (dataUrls: string[]): unknown => {
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const findInput = (): HTMLInputElement | null => {
    const inputs = [...document.querySelectorAll<HTMLInputElement>('input[type="file"]')]
    return inputs.find((el) => el.offsetParent !== null) || inputs[0] || null
  }
  return (async () => {
    const results: Array<{ ok: boolean; reason?: string; count?: number }> = []
    const files: File[] = []
    for (let i = 0; i < dataUrls.length; i++) {
      let file: File | null = null
      try {
        const resp = await fetch(dataUrls[i])
        const blob = await resp.blob()
        const ext = blob.type.includes('png')
          ? 'png'
          : blob.type.includes('gif')
            ? 'gif'
            : blob.type.includes('webp')
              ? 'webp'
              : 'jpg'
        file = new File([blob], 'image-' + i + '.' + ext, { type: blob.type || 'image/jpeg' })
      } catch {}
      if (!file) {
        results.push({ ok: false, reason: '图片数据解析失败' })
        continue
      }
      files.push(file)
    }
    if (files.length === 0) {
      return { ok: false, results: results.length > 0 ? results : [{ ok: false, reason: '图片数据解析失败' }] }
    }
    const input = findInput()
    if (!input) {
      return { ok: false, results: [{ ok: false, reason: '未找到上传输入框' }] }
    }
    const dt = new DataTransfer()
    for (const file of files) dt.items.add(file)
    input.files = dt.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
    input.dispatchEvent(new Event('input', { bubbles: true }))
    // 等待上传完成：等「上传中/压缩中」文案消失后再多等 2s（粗略判定）
    let done = false
    for (let w = 0; w < 40; w++) {
      await sleep(750)
      if (window.__qfUploadCancel) {
        return { ok: false, cancelled: true, reason: '已手动终止生成（提示词未发送）' }
      }
      const text = document.body ? document.body.innerText : ''
      const pending = /上传中|正在上传|压缩中|处理中/.test(text)
      if (w > 12 && !pending) {
        await sleep(2000)
        done = true
        break
      }
    }
    results.push({ ok: done, count: files.length })
    return { ok: results.length > 0 && results.every((r) => r.ok), results }
  })()
}

// 图生视频：不清空编辑器（保留已上传的图片 chip），光标移末尾插入 prompt 并回车提交
const insertPromptAndSubmitScript = (prompt: string): unknown => {
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const norm = (s: string): string => (s || '').trim()
  const findEditor = (): HTMLElement | null => {
    const sels = ['[class*="ProseMirror"]', '[class*="tiptap"]', '[contenteditable="true"]', '[contenteditable="plaintext-only"]', '[role="textbox"]']
    for (const s of sels) {
      const els = [...document.querySelectorAll<HTMLElement>(s)].filter((el) => el.offsetParent !== null)
      if (els.length) return els[0]
    }
    return null
  }
  // DOM 定位 ProseMirror 视图（不遍历 window 全局键，避免触发页面 getter 导致失响应）
  const findView = (): { state?: unknown; dispatch?: (tr: unknown) => void } | null => {
    try {
      const pm = document.querySelector<HTMLElement>('[class*="ProseMirror"], [class*="tiptap"], [contenteditable="true"]')
      const desc = pm && (pm as unknown as { pmViewDesc?: { view?: unknown } }).pmViewDesc
      if (desc && desc.view) {
        return desc.view as { state?: unknown; dispatch?: (tr: unknown) => void }
      }
    } catch {}
    return null
  }
  return (async () => {
    const editor = findEditor()
    if (!editor) return { ok: false, reason: '未找到输入框' }
    // 清理编辑器状态里的时长 chip（文本恰为 10s/5s/15s 的节点），保留已上传的图片
    try {
      const view = findView()
      if (view && view.state && view.dispatch) {
        const state = view.state as {
          doc: { descendants: (fn: (node: Record<string, unknown>, pos: number) => void) => void }
          tr: { delete: (from: number, to: number) => void; docChanged: boolean }
        }
        const tr = state.tr
        state.doc.descendants((rawNode, pos) => {
          const node = rawNode as { text?: string; attrs?: Record<string, string>; nodeSize?: number }
          const label = String(node.text || (node.attrs && (node.attrs.label || node.attrs.text)) || '').trim()
          if (/^\d{1,2}s$/.test(label) || (/自动/.test(label) && /\d{1,2}s/.test(label))) {
            tr.delete(pos, pos + (node.nodeSize ?? 1))
          }
        })
        if (tr.docChanged) view.dispatch(tr)
        await sleep(300)
      }
    } catch {}
    // DOM 兜底：删除编辑器内文本恰为时长格式的节点
    try {
      for (const el of [...editor.querySelectorAll('*')]) {
        const t = norm(el.textContent || '')
        if (/^\d{1,2}s$/.test(t)) el.remove()
      }
    } catch {}
    editor.focus()
    try {
      const sel = window.getSelection()
      if (sel) {
        const range = document.createRange()
        range.selectNodeContents(editor)
        range.collapse(false)
        sel.removeAllRanges()
        sel.addRange(range)
      }
    } catch {}
    try {
      document.execCommand('insertText', false, prompt)
    } catch {}
    editor.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: prompt }))
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: prompt }))
    await sleep(800)
    editor.focus()
    const enterOpts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }
    editor.dispatchEvent(new KeyboardEvent('keydown', enterOpts))
    editor.dispatchEvent(new KeyboardEvent('keypress', enterOpts))
    editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }))
    await sleep(1500)
    return { ok: true }
  })()
}

// 填入 prompt：先清空编辑器（ProseMirror 可能含时长 chip），再插入干净文本，校验后回车提交
const fillAndSubmitScript = (prompt: string): unknown => {
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const norm = (s: string): string => (s || '').trim()
  const findEditor = (): HTMLElement | null => {
    const sels = ['[class*="ProseMirror"]', '[class*="tiptap"]', '[contenteditable="true"]', '[contenteditable="plaintext-only"]', '[role="textbox"]']
    for (const s of sels) {
      const els = [...document.querySelectorAll<HTMLElement>(s)].filter((el) => el.offsetParent !== null)
      if (els.length) return els[0]
    }
    return null
  }
  const findTiptap = (): { commands?: { setContent?: (c: string, emit?: boolean) => void }; getText?: () => string } | null => {
    try {
      for (const k of Object.keys(window)) {
        try {
          const v = (window as unknown as Record<string, unknown>)[k]
          if (
            v &&
            typeof v === 'object' &&
            (v as { commands?: unknown }).commands &&
            typeof (v as { commands?: { setContent?: unknown } }).commands?.setContent === 'function'
          ) {
            return v as { commands?: { setContent?: (c: string, emit?: boolean) => void }; getText?: () => string }
          }
        } catch {}
      }
    } catch {}
    return null
  }
  const setText = (el: HTMLElement, text: string): void => {
    el.focus()
    try {
      document.execCommand('selectAll', false)
      document.execCommand('delete', false)
    } catch {}
    // 强清理：selectAll 可能选不中 ProseMirror 的 chip 节点，直接清空 DOM 内容兜底
    try {
      const cur = norm(el.innerText || el.textContent || '')
      if (cur !== '' && !cur.includes(text.slice(0, 8))) {
        el.innerHTML = ''
      }
    } catch {}
    try {
      document.execCommand('insertText', false, text)
    } catch {}
    el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }))
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }))
  }
  return (async () => {
    const editor = findEditor()
    if (!editor) return { ok: false, reason: '未找到输入框，可能未登录或页面结构不同' }
    // 1) 优先用 TipTap 编辑器 API 设置内容：能真正清掉 ProseMirror 状态里的时长 chip（DOM 清理清不掉状态）
    let contentOk = false
    try {
      const tiptap = findTiptap()
      if (tiptap && tiptap.commands && typeof tiptap.commands.setContent === 'function') {
        tiptap.commands.setContent(prompt, false)
        await sleep(400)
        const t = norm(tiptap.getText ? tiptap.getText() : '')
        if (t === prompt) contentOk = true
      }
    } catch {}
    // 2) DOM 兜底：清空 → 插入 → 校验（UI 可能自动附加时长 chip，反复清理）
    if (!contentOk) {
      for (let i = 0; i < 5; i++) {
        setText(editor, prompt)
        await sleep(350)
        const text = norm(editor.innerText || editor.textContent || '')
        if (text === prompt) break
      }
      editor.focus()
      setText(editor, prompt)
      await sleep(350)
    }
    const finalText = norm(editor.innerText || editor.textContent || '')
    if (finalText !== prompt) {
      return { ok: false, reason: '编辑器内容未清理干净: ' + finalText.slice(0, 60) }
    }
    const enterOpts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }
    editor.dispatchEvent(new KeyboardEvent('keydown', enterOpts))
    editor.dispatchEvent(new KeyboardEvent('keypress', enterOpts))
    editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }))
    await sleep(1500)
    return { ok: true, submitted: true }
  })()
}

const extractResultScript = (): unknown => {
  const vids = [...document.querySelectorAll('video')]
    .map((v) => ({ src: (v as HTMLVideoElement).currentSrc || (v as HTMLVideoElement).src || '', poster: (v as HTMLVideoElement).poster || '' }))
    .filter((v) => /^https?:/.test(v.src))
  const mp4s: string[] = []
  const seen = new Set<string>()
  try {
    for (const el of document.querySelectorAll('*')) {
      for (const attr of ['src', 'href', 'data-src', 'data-url']) {
        const v = el.getAttribute && el.getAttribute(attr)
        if (v && /\.mp4([?#]|$)/i.test(v) && !seen.has(v)) {
          seen.add(v)
          mp4s.push(v)
        }
      }
    }
  } catch {}
  const text = document.body ? document.body.innerText : ''
  // 豆包内容政策拒绝：侵权/肖像/版权等拒绝文案（非视频结果）→ 直接判失败
  const blockedMatch = text.match(
    /生成内容中疑似包含侵权[^，。\n]{0,80}|出于肖像保护考虑[^，。\n]{0,80}|由于版权相关限制[^，。\n]{0,80}|无法返回该内容|换个主题|分身认证|侵权|违规|肖像保护|版权相关限制/
  )
  let blockedText: string | null = null
  if (blockedMatch) {
    const idx = blockedMatch.index ?? 0
    const lineStart = text.lastIndexOf('\n', idx) + 1
    let lineEnd = text.indexOf('\n', idx)
    if (lineEnd === -1) lineEnd = text.length
    blockedText = text.slice(lineStart, lineEnd).trim().slice(0, 120) || blockedMatch[0].slice(0, 80)
  }
  return {
    vids,
    mp4s: mp4s.slice(0, 8),
    hasDone: /你的视频生成好了|生成完成|生成成功|生成完毕/.test(text),
    blockedText,
    textTail: text.slice(-240)
  }
}

const clickVideoCardScript = (): unknown => {
  let clicked = 0
  const seen = new Set<Element>()
  const clickEl = (el: Element): void => {
    if (!el || seen.has(el)) return
    seen.add(el)
    try {
      ;(el as HTMLElement).click()
      clicked += 1
    } catch {}
  }
  const imgs = [...document.querySelectorAll('img')].filter(
    (img) => (img as HTMLImageElement).src.includes('video_dsz_watermark') || /video/i.test((img as HTMLImageElement).src || '')
  )
  for (const img of imgs.slice(0, 5)) {
    try {
      const card =
        img.closest('[class*="video" i], [class*="card" i], [class*="message" i], [class*="content" i]') ||
        img.parentElement
      if (!card) continue
      const play = card.querySelector('button, [role="button"], [class*="play" i]')
      if (play) clickEl(play)
      else clickEl(card)
    } catch {}
  }
  const playEls = [...document.querySelectorAll('[class*="play" i]')].filter(
    (el) => (el as HTMLElement).offsetParent !== null && /video|play/i.test((el.className || '') + ' ' + (el.getAttribute('aria-label') || ''))
  )
  for (const el of playEls.slice(0, 6)) clickEl(el)
  return { clicked, found: imgs.length }
}

/* ---------------- 时长滑块 DOM 操作（豆包 Radix Slider，2026-08-11 实测/修正） ----------------
 * 实测结构：
 *   trigger: button[aria-haspopup="menu"]，文本「自动 · 10s」
 *   menu:    div[role="menu"][data-state="open"]（含「比例」网格 +「时长」滑块）
 *   slider:  span[data-slot="slider"] 根 / span[data-slot="slider-track"] 轨道
 *            span[role="slider"][data-slot="slider-thumb"]：aria-valuemin=0、aria-valuemax=11
 *   映射：value = 秒数 - 4（4s→0 ... 15s→11）；手柄支持 ArrowLeft/Right 逐档调节
 *   15s 仅会员，普通账号滑块拖不动（UI 已禁用 15s）。
 *
 * 2026-08-11 修正（App 全局 disableHardwareAcceleration → 软件合成）：
 *   - CDP Input.dispatchMouseEvent / sendInputEvent 在软件渲染下点击不生效（实测 3/3 丢失）
 *     → 改用页面内 JS PointerEvent 打开菜单（Radix 接受非可信事件，隐藏窗口也可用）
 *   - 滑块改值用键盘：focus 手柄后逐次 ArrowLeft/Right，一次一步 + 读值校验
 *     （React 状态批处理，连发 N 次只生效最后一步，实测 5 连发只动 1 档）
 *   - 窗口恢复隐藏（不再依赖 12px 露头 + CDP 可信输入）
 */

/* 读取时长状态：按钮文本 + 菜单是否打开（严格 data-state="open"）+ 滑块手柄值 */
const readDurationStateScript = (): unknown => {
  const norm = (s: string): string => (s || '').trim()
  const textOf = (b: Element): string =>
    norm((b as HTMLElement).textContent || '') ||
    norm(b.getAttribute('aria-label') || '') ||
    norm(b.getAttribute('title') || '')
  const btns = [...document.querySelectorAll('button, [role="button"], [role="tab"]')].filter(
    (b) => (b as HTMLElement).offsetParent !== null
  )
  const durBtn =
    btns.find((b) => /^自动/.test(textOf(b))) ||
    btns.find((b) => /自动/.test(textOf(b))) ||
    btns.find((b) => /时长/.test(textOf(b))) ||
    btns.find((b) => /\d+\s*s/i.test(textOf(b)))
  // 严格只认 data-state="open"：隐藏窗口下菜单关闭动画不完成，closed 内容会残留 DOM
  const menu =
    [...document.querySelectorAll('[role="menu"][data-state="open"]')]
      .filter((el) => (el as HTMLElement).offsetParent !== null)
      .sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0] || null
  const thumb = menu
    ? [...menu.querySelectorAll('[data-slot="slider-thumb"], [role="slider"]')].find(
        (el) => (el as HTMLElement).offsetParent !== null
      ) || null
    : null
  return {
    triggerText: durBtn ? textOf(durBtn).slice(0, 40) : '',
    triggerExpanded: durBtn ? durBtn.getAttribute('aria-expanded') : null,
    menuOpen: !!menu,
    thumbValue: thumb ? thumb.getAttribute('aria-valuenow') : null,
    thumbMin: thumb ? thumb.getAttribute('aria-valuemin') : null,
    thumbMax: thumb ? thumb.getAttribute('aria-valuemax') : null
  }
}

/* 打开时长菜单：JS PointerEvent 序列（软件渲染下 CDP 输入失效，此路可用） */
const openDurationMenuScript = (): unknown => {
  const norm = (s: string): string => (s || '').trim()
  const textOf = (b: Element): string =>
    norm((b as HTMLElement).textContent || '') ||
    norm(b.getAttribute('aria-label') || '') ||
    norm(b.getAttribute('title') || '')
  const btns = [...document.querySelectorAll('button, [role="button"], [role="tab"]')].filter(
    (b) =>
      (b as HTMLElement).offsetParent !== null &&
      (b as HTMLButtonElement).disabled !== true &&
      b.getAttribute('aria-disabled') !== 'true'
  )
  const hit =
    btns.find((b) => /^自动/.test(textOf(b))) ||
    btns.find((b) => /自动/.test(textOf(b))) ||
    btns.find((b) => /时长/.test(textOf(b))) ||
    btns.find((b) => /\d+\s*s/i.test(textOf(b)))
  if (!hit) return { ok: false, reason: '未找到时长选择器' }
  // 幂等：菜单已开则不再点击（Radix trigger 点击是 toggle，重复点击会把它关掉）
  const alreadyOpen =
    hit.getAttribute('aria-expanded') === 'true' || !!document.querySelector('[role="menu"][data-state="open"]')
  if (alreadyOpen) return { ok: true, alreadyOpen: true }
  const r = hit.getBoundingClientRect()
  const base = {
    bubbles: true,
    cancelable: true,
    composed: true,
    pointerId: 9,
    pointerType: 'mouse',
    isPrimary: true,
    clientX: r.x + r.width / 2,
    clientY: r.y + r.height / 2,
    button: 0,
    buttons: 1,
    view: window
  }
  hit.dispatchEvent(new PointerEvent('pointerover', { ...base, buttons: 0 }))
  hit.dispatchEvent(new PointerEvent('pointermove', { ...base, buttons: 0 }))
  hit.dispatchEvent(new PointerEvent('pointerdown', base))
  hit.dispatchEvent(new MouseEvent('mousedown', base))
  hit.dispatchEvent(new PointerEvent('pointerup', { ...base, buttons: 0 }))
  hit.dispatchEvent(new MouseEvent('mouseup', { ...base, buttons: 0 }))
  hit.dispatchEvent(new MouseEvent('click', { ...base, buttons: 0 }))
  return { ok: true, text: textOf(hit).slice(0, 40) }
}

/* 滑块手柄按一次方向键（React 状态批处理：必须一次一步 + 读值校验） */
const pressSliderKeyScript = (dir: string): unknown => {
  const menu =
    [...document.querySelectorAll('[role="menu"][data-state="open"]')]
      .filter((el) => (el as HTMLElement).offsetParent !== null)
      .sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0] || null
  if (!menu) return { ok: false, reason: '时长菜单未打开' }
  const thumb =
    [...menu.querySelectorAll('[data-slot="slider-thumb"], [role="slider"]')].find(
      (el) => (el as HTMLElement).offsetParent !== null
    ) || null
  if (!thumb) return { ok: false, reason: '未找到时长滑块手柄' }
  ;(thumb as HTMLElement).focus()
  const key = dir === 'left' ? 'ArrowLeft' : 'ArrowRight'
  const keyCode = dir === 'left' ? 37 : 39
  thumb.dispatchEvent(
    new KeyboardEvent('keydown', { key, code: key, keyCode, which: keyCode, bubbles: true, cancelable: true })
  )
  thumb.dispatchEvent(new KeyboardEvent('keyup', { key, code: key, keyCode, which: keyCode, bubbles: true }))
  return { ok: true }
}

/* 关闭时长菜单：Escape + 外部 pointerdown（不做 trigger 点击，避免把已关的菜单重新打开） */
const closeDurationMenuScript = (): unknown => {
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  const outside = {
    bubbles: true,
    cancelable: true,
    composed: true,
    pointerId: 12,
    pointerType: 'mouse',
    isPrimary: true,
    clientX: 8,
    clientY: 8,
    button: 0,
    buttons: 1,
    view: window
  }
  document.body.dispatchEvent(new PointerEvent('pointerdown', outside))
  document.body.dispatchEvent(new PointerEvent('pointerup', { ...outside, buttons: 0 }))
  return { ok: true }
}

/* ---------------- 比例网格 DOM 操作（豆包「自动 · Ns」菜单内） ----------------
 * 与时长同菜单：菜单打开时含「比例」网格 +「时长」滑块。
 * 比例项为 button，文本形如「9:16 / 3:4 / 21:9」，选中态通过 class
 * border-dbx-text-highlight 判定（实测 2026-08-22，无 aria-checked/data-state）。
 */

/* 读取比例网格状态：菜单是否打开 + 比例项列表 + 当前选中 */
const readRatioStateScript = (): unknown => {
  const norm = (s: string): string => (s || '').trim()
  const visible = (el: Element): boolean => (el as HTMLElement).offsetParent !== null
  const menu =
    [...document.querySelectorAll('[role="menu"][data-state="open"]')]
      .filter(visible)
      .sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0] || null
  const items = menu
    ? [...menu.querySelectorAll('button, [role="button"]')]
        .filter((el) => visible(el) && /^\d+\s*:\s*\d+$/.test(norm(el.textContent || '')))
        .map((el) => ({
          t: norm(el.textContent || ''),
          selected: /border-dbx-text-highlight/.test((el.className || '').toString()),
          tag: el.tagName,
          cls: (el.className || '').toString().slice(0, 80)
        }))
    : []
  return { menuOpen: !!menu, items }
}

/* 点击比例网格中匹配 target 的比例项 */
const clickRatioScript = (target: string): unknown => {
  const norm = (s: string): string => (s || '').trim()
  const visible = (el: Element): boolean => (el as HTMLElement).offsetParent !== null
  const menu =
    [...document.querySelectorAll('[role="menu"][data-state="open"]')]
      .filter(visible)
      .sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0] || null
  if (!menu) return { ok: false, reason: '比例菜单未打开' }
  const targetNorm = target.replace(/\s+/g, '')
  const els = [...menu.querySelectorAll('button, [role="button"]')].filter(
    (el) => visible(el) && norm(el.textContent || '').replace(/\s+/g, '') === targetNorm
  )
  if (els.length === 0) return { ok: false, reason: '未找到比例项 ' + target }
  const el = els[els.length - 1] as HTMLElement
  // 已选中则跳过
  if (/border-dbx-text-highlight/.test((el.className || '').toString())) {
    return { ok: true, already: true }
  }
  const r = el.getBoundingClientRect()
  const base = {
    bubbles: true,
    cancelable: true,
    composed: true,
    pointerId: 11,
    pointerType: 'mouse',
    isPrimary: true,
    clientX: r.x + r.width / 2,
    clientY: r.y + r.height / 2,
    button: 0,
    buttons: 1,
    view: window
  }
  el.dispatchEvent(new PointerEvent('pointerover', { ...base, buttons: 0 }))
  el.dispatchEvent(new PointerEvent('pointermove', { ...base, buttons: 0 }))
  el.dispatchEvent(new PointerEvent('pointerdown', base))
  el.dispatchEvent(new MouseEvent('mousedown', base))
  el.dispatchEvent(new PointerEvent('pointerup', { ...base, buttons: 0 }))
  el.dispatchEvent(new MouseEvent('mouseup', { ...base, buttons: 0 }))
  el.dispatchEvent(new MouseEvent('click', { ...base, buttons: 0 }))
  return { ok: true, text: norm(el.textContent || '').slice(0, 20) }
}

/* ---------------- 模型选择器 DOM 操作（豆包视频页） ----------------
 * 模型选择器：trigger 按钮文本含「Seedance」或「模型」，aria-haspopup="menu"；
 * 菜单打开后含模型选项（文本形如「Seedance 2.0 Mini日常生成使用」）。
 * 选中态通过菜单项 data-selected="true" 判定（实测 2026-08-22，无 aria-checked/data-state）。
 */

/* 读取模型选择器状态：trigger 文本 + 菜单是否打开 + 模型选项列表 */
const readModelStateScript = (): unknown => {
  const norm = (s: string): string => (s || '').trim()
  const textOf = (b: Element): string =>
    norm((b as HTMLElement).textContent || '') ||
    norm(b.getAttribute('aria-label') || '') ||
    norm(b.getAttribute('title') || '')
  const visible = (el: Element): boolean => (el as HTMLElement).offsetParent !== null
  const btns = [...document.querySelectorAll('button, [role="button"], [role="tab"], [role="combobox"]')].filter(
    (b) => visible(b) && (b as HTMLButtonElement).disabled !== true
  )
  const trigger =
    btns.find((b) => /seedance/i.test(textOf(b)) && (b.getAttribute('aria-haspopup') || '').includes('menu')) ||
    btns.find((b) => /seedance/i.test(textOf(b))) ||
    btns.find((b) => /^模型/.test(textOf(b))) ||
    null
  const menu =
    [...document.querySelectorAll('[role="menu"][data-state="open"], [role="listbox"][data-state="open"]')]
      .filter(visible)
      .sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0] || null
  const options = menu
    ? [...menu.querySelectorAll('button, [role="menuitem"], [role="option"], [role="radio"]')]
        .filter(visible)
        .map((el) => ({
          t: textOf(el).slice(0, 50),
          selected: el.getAttribute('data-selected') === 'true',
          checked: el.getAttribute('aria-checked'),
          pressed: el.getAttribute('aria-pressed'),
          state: el.getAttribute('data-state'),
          tag: el.tagName
        }))
        .filter((o) => o.t)
    : []
  return {
    triggerText: trigger ? textOf(trigger).slice(0, 50) : '',
    triggerExpanded: trigger ? trigger.getAttribute('aria-expanded') : null,
    menuOpen: !!menu,
    options
  }
}

/* 打开模型菜单：JS PointerEvent 序列（与时长菜单同法，软件渲染兼容） */
const openModelMenuScript = (): unknown => {
  const norm = (s: string): string => (s || '').trim()
  const textOf = (b: Element): string =>
    norm((b as HTMLElement).textContent || '') ||
    norm(b.getAttribute('aria-label') || '') ||
    norm(b.getAttribute('title') || '')
  const visible = (el: Element): boolean => (el as HTMLElement).offsetParent !== null
  const btns = [...document.querySelectorAll('button, [role="button"], [role="tab"], [role="combobox"]')].filter(
    (b) => visible(b) && (b as HTMLButtonElement).disabled !== true
  )
  const trigger =
    btns.find((b) => /seedance/i.test(textOf(b)) && (b.getAttribute('aria-haspopup') || '').includes('menu')) ||
    btns.find((b) => /seedance/i.test(textOf(b))) ||
    btns.find((b) => /^模型/.test(textOf(b))) ||
    null
  if (!trigger) return { ok: false, reason: '未找到模型选择器' }
  const alreadyOpen =
    trigger.getAttribute('aria-expanded') === 'true' || !!document.querySelector('[role="menu"][data-state="open"]')
  if (alreadyOpen) return { ok: true, alreadyOpen: true }
  const r = trigger.getBoundingClientRect()
  const base = {
    bubbles: true,
    cancelable: true,
    composed: true,
    pointerId: 13,
    pointerType: 'mouse',
    isPrimary: true,
    clientX: r.x + r.width / 2,
    clientY: r.y + r.height / 2,
    button: 0,
    buttons: 1,
    view: window
  }
  trigger.dispatchEvent(new PointerEvent('pointerover', { ...base, buttons: 0 }))
  trigger.dispatchEvent(new PointerEvent('pointermove', { ...base, buttons: 0 }))
  trigger.dispatchEvent(new PointerEvent('pointerdown', base))
  trigger.dispatchEvent(new MouseEvent('mousedown', base))
  trigger.dispatchEvent(new PointerEvent('pointerup', { ...base, buttons: 0 }))
  trigger.dispatchEvent(new MouseEvent('mouseup', { ...base, buttons: 0 }))
  trigger.dispatchEvent(new MouseEvent('click', { ...base, buttons: 0 }))
  return { ok: true, text: textOf(trigger).slice(0, 50) }
}

/* 点击模型菜单中匹配 target 的选项 */
const clickModelScript = (target: string): unknown => {
  const norm = (s: string): string => (s || '').trim()
  const textOf = (el: Element): string =>
    norm((el as HTMLElement).textContent || '') ||
    norm(el.getAttribute('aria-label') || '') ||
    norm(el.getAttribute('title') || '')
  const visible = (el: Element): boolean => (el as HTMLElement).offsetParent !== null
  const menu =
    [...document.querySelectorAll('[role="menu"][data-state="open"], [role="listbox"][data-state="open"]')]
      .filter(visible)
      .sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0] || null
  if (!menu) return { ok: false, reason: '模型菜单未打开' }
  const targetNorm = norm(target).toLowerCase().replace(/\s+/g, '')
  const els = [...menu.querySelectorAll('button, [role="menuitem"], [role="option"], [role="radio"]')].filter(
    (el) => visible(el) && textOf(el).toLowerCase().replace(/\s+/g, '').includes(targetNorm)
  )
  if (els.length === 0) return { ok: false, reason: '未找到模型选项 ' + target }
  const el = els[els.length - 1] as HTMLElement
  if (el.getAttribute('data-selected') === 'true' || el.getAttribute('aria-checked') === 'true' || el.getAttribute('data-state') === 'selected') {
    return { ok: true, already: true }
  }
  const r = el.getBoundingClientRect()
  const base = {
    bubbles: true,
    cancelable: true,
    composed: true,
    pointerId: 15,
    pointerType: 'mouse',
    isPrimary: true,
    clientX: r.x + r.width / 2,
    clientY: r.y + r.height / 2,
    button: 0,
    buttons: 1,
    view: window
  }
  el.dispatchEvent(new PointerEvent('pointerover', { ...base, buttons: 0 }))
  el.dispatchEvent(new PointerEvent('pointermove', { ...base, buttons: 0 }))
  el.dispatchEvent(new PointerEvent('pointerdown', base))
  el.dispatchEvent(new MouseEvent('mousedown', base))
  el.dispatchEvent(new PointerEvent('pointerup', { ...base, buttons: 0 }))
  el.dispatchEvent(new MouseEvent('mouseup', { ...base, buttons: 0 }))
  el.dispatchEvent(new MouseEvent('click', { ...base, buttons: 0 }))
  return { ok: true, text: textOf(el).slice(0, 50) }
}

/** 通过豆包真实 UI 设置时长（页面内 JS PointerEvent + 键盘，隐藏窗口可用，无需 CDP）。失败时调用方应终止任务。 */
async function applyDoubaoDuration(
  win: BrowserWindow,
  durationSec: number
): Promise<{ ok: boolean; reason?: string }> {
  const exec = (script: string, arg?: string): Promise<unknown> =>
    win.webContents.executeJavaScript('(' + script + ')(' + (arg !== undefined ? JSON.stringify(arg) : '') + ')', true)
  const target = durationSec === 10 ? 10 : durationSec === 15 ? 15 : 5
  const targetValue = Math.max(0, Math.min(11, target - 4))

  // 1) 读取当前按钮文本，已为目标时长则跳过
  let state: {
    triggerText?: string
    menuOpen?: boolean
    thumbValue?: string | null
  } = {}
  try {
    state = (await exec(readDurationStateScript.toString())) as typeof state
  } catch {
    return { ok: false, reason: '读取时长选择器失败' }
  }
  const curSec = Number((state.triggerText || '').match(/(\d+)\s*s/i)?.[1] || 0)
  if (curSec === target) {
    return { ok: true } // 已为目标时长，无需操作
  }

  // 2) 打开菜单（JS PointerEvent，幂等：已开则跳过点击；重试 3 次）
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      state = (await exec(readDurationStateScript.toString())) as typeof state
      if (state.menuOpen) break
    } catch {}
    try {
      const open = (await exec(openDurationMenuScript.toString())) as { ok?: boolean; reason?: string }
      if (!open.ok) {
        if (attempt === 2) return { ok: false, reason: open.reason || '未找到时长选择器' }
        await sleep(600)
        continue
      }
    } catch {
      if (attempt === 2) return { ok: false, reason: '打开时长菜单失败' }
      await sleep(600)
      continue
    }
    for (let i = 0; i < 10; i++) {
      await sleep(500)
      try {
        state = (await exec(readDurationStateScript.toString())) as typeof state
        if (state.menuOpen) break
      } catch {}
    }
    if (state.menuOpen) break
  }
  if (!state.menuOpen) {
    return { ok: false, reason: '时长菜单未打开' }
  }

  // 3) 键盘逐档调值：一次一步 + 读值校验（React 状态批处理，不能连发）
  let cur = Number(state.thumbValue ?? 6)
  for (let i = 0; i < 15 && cur !== targetValue; i++) {
    const dir = targetValue > cur ? 'right' : 'left'
    try {
      await exec(pressSliderKeyScript.toString(), dir)
    } catch {}
    await sleep(300)
    try {
      state = (await exec(readDurationStateScript.toString())) as typeof state
      const v = Number(state.thumbValue)
      if (Number.isFinite(v)) cur = v
    } catch {}
  }

  // 4) 校验：thumb aria-valuenow === target-4 或按钮文本含「Ns」
  let after: { triggerText?: string; thumbValue?: string | null } = {}
  try {
    after = (await exec(readDurationStateScript.toString())) as typeof after
  } catch {}
  const okByThumb = after.thumbValue !== null && Number(after.thumbValue) === targetValue
  const okByText = new RegExp(target + '\\s*s', 'i').test(after.triggerText || '')
  if (!okByThumb && !okByText) {
    return { ok: false, reason: `时长未生效（当前按钮：${after.triggerText || '未知'}）` }
  }

  // 5) 关闭菜单（尽力而为；隐藏窗口下关闭动画不完成，残留 closed 内容不影响后续 fill/submit）
  try {
    await exec(closeDurationMenuScript.toString())
  } catch {}
  await sleep(600)
  return { ok: true }
}

/** 通过豆包真实 UI 设置比例（「自动 · Ns」菜单内的比例网格，JS PointerEvent 点击）。
 *  目标比例已在网格选中时跳过；未找到目标比例项或菜单打不开则失败。 */
async function applyDoubaoRatio(
  win: BrowserWindow,
  ratio: string
): Promise<{ ok: boolean; reason?: string; already?: boolean }> {
  const exec = (script: string, arg?: string): Promise<unknown> =>
    win.webContents.executeJavaScript('(' + script + ')(' + (arg !== undefined ? JSON.stringify(arg) : '') + ')', true)
  const target = (ratio || '').replace(/\s+/g, '')
  if (!target) return { ok: false, reason: '比例为空' }

  // 1) 打开「自动 · Ns」菜单（与时长同菜单；幂等 + 重试 3 次）
  let state: { menuOpen?: boolean; items?: Array<{ t?: string; selected?: boolean }> } = {}
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      state = (await exec(readRatioStateScript.toString())) as typeof state
      if (state.menuOpen) break
    } catch {}
    try {
      const open = (await exec(openDurationMenuScript.toString())) as { ok?: boolean; reason?: string }
      if (!open.ok) {
        if (attempt === 2) return { ok: false, reason: open.reason || '未找到比例入口' }
        await sleep(600)
        continue
      }
    } catch {
      if (attempt === 2) return { ok: false, reason: '打开比例菜单失败' }
      await sleep(600)
      continue
    }
    for (let i = 0; i < 10; i++) {
      await sleep(500)
      try {
        state = (await exec(readRatioStateScript.toString())) as typeof state
        if (state.menuOpen) break
      } catch {}
    }
    if (state.menuOpen) break
  }
  if (!state.menuOpen) return { ok: false, reason: '比例菜单未打开' }

  // 2) 目标已选中则直接成功
  if ((state.items || []).some((it) => it.t && it.t.replace(/\s+/g, '') === target && it.selected === true)) {
    try {
      await exec(closeDurationMenuScript.toString())
    } catch {}
    return { ok: true, already: true }
  }

  // 3) 点击目标比例项
  let click: { ok?: boolean; reason?: string } = {}
  try {
    click = (await exec(clickRatioScript.toString(), target)) as typeof click
  } catch (e) {
    click = { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
  if (!click.ok) {
    try {
      await exec(closeDurationMenuScript.toString())
    } catch {}
    return { ok: false, reason: click.reason || '点击比例失败' }
  }
  await sleep(700)

  // 4) 校验：网格内目标项 border-dbx-text-highlight 高亮
  let after: { items?: Array<{ t?: string; selected?: boolean }> } = {}
  try {
    after = (await exec(readRatioStateScript.toString())) as typeof after
  } catch {}
  const ok = (after.items || []).some(
    (it) => it.t && it.t.replace(/\s+/g, '') === target && it.selected === true
  )
  try {
    await exec(closeDurationMenuScript.toString())
  } catch {}
  if (!ok) return { ok: false, reason: '比例未生效：' + target }
  return { ok: true }
}

/** 通过豆包真实 UI 设置模型（页面模型选择器下拉，JS PointerEvent 点击）。
 *  目标模型已选中时跳过；找不到模型选择器/选项则失败（默认不阻断，返回 ok 表示未变更）。 */
async function applyDoubaoModel(
  win: BrowserWindow,
  model: string
): Promise<{ ok: boolean; reason?: string; changed?: boolean }> {
  const exec = (script: string, arg?: string): Promise<unknown> =>
    win.webContents.executeJavaScript('(' + script + ')(' + (arg !== undefined ? JSON.stringify(arg) : '') + ')', true)
  const target = (model || '').trim()
  if (!target) return { ok: true } // 无模型要求，跳过

  // 1) 读取模型选择器状态
  let state: { triggerText?: string; menuOpen?: boolean; options?: Array<{ t?: string; selected?: boolean }> } = {}
  try {
    state = (await exec(readModelStateScript.toString())) as typeof state
  } catch {
    return { ok: false, reason: '读取模型选择器失败' }
  }
  if (!state.triggerText) return { ok: true } // 页面无模型选择器（页面结构变化），不阻断
  // 目标已选中（trigger 文本含目标）则跳过
  if (state.triggerText.toLowerCase().replace(/\s+/g, '').includes(target.toLowerCase().replace(/\s+/g, ''))) {
    return { ok: true, changed: false }
  }

  // 2) 打开模型菜单
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      state = (await exec(readModelStateScript.toString())) as typeof state
      if (state.menuOpen) break
    } catch {}
    try {
      const open = (await exec(openModelMenuScript.toString())) as { ok?: boolean; reason?: string }
      if (!open.ok) {
        if (attempt === 2) return { ok: false, reason: open.reason || '未找到模型选择器' }
        await sleep(600)
        continue
      }
    } catch {
      if (attempt === 2) return { ok: false, reason: '打开模型菜单失败' }
      await sleep(600)
      continue
    }
    for (let i = 0; i < 10; i++) {
      await sleep(500)
      try {
        state = (await exec(readModelStateScript.toString())) as typeof state
        if (state.menuOpen) break
      } catch {}
    }
    if (state.menuOpen) break
  }
  if (!state.menuOpen) return { ok: false, reason: '模型菜单未打开' }

  // 3) 目标选项已选中则直接成功
  if ((state.options || []).some((o) => o.t && o.t.toLowerCase().replace(/\s+/g, '').includes(target.toLowerCase().replace(/\s+/g, '')) && o.selected === true)) {
    try {
      await exec(closeDurationMenuScript.toString())
    } catch {}
    return { ok: true, changed: false }
  }

  // 4) 点击目标模型选项
  let click: { ok?: boolean; reason?: string } = {}
  try {
    click = (await exec(clickModelScript.toString(), target)) as typeof click
  } catch (e) {
    click = { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
  if (!click.ok) {
    try {
      await exec(closeDurationMenuScript.toString())
    } catch {}
    return { ok: false, reason: click.reason || '点击模型失败' }
  }
  await sleep(700)

  // 5) 校验：trigger 文本或选项 data-selected 已含目标
  let after: { triggerText?: string; options?: Array<{ t?: string; selected?: boolean }> } = {}
  try {
    after = (await exec(readModelStateScript.toString())) as typeof after
  } catch {}
  const ok =
    (after.triggerText || '').toLowerCase().replace(/\s+/g, '').includes(target.toLowerCase().replace(/\s+/g, '')) ||
    (after.options || []).some(
      (o) => o.t && o.t.toLowerCase().replace(/\s+/g, '').includes(target.toLowerCase().replace(/\s+/g, '')) && o.selected === true
    )
  try {
    await exec(closeDurationMenuScript.toString())
  } catch {}
  if (!ok) return { ok: false, reason: '模型未生效：' + target }
  return { ok: true, changed: true }
}

/* ---------------- 风控探针（豆包服务端风控/验证码检测，2026-08-12） ----------------
 * 信号：
 *   /chat/completion 响应体：verify_scene / decision.type=verify（风控验证）、
 *     710022002 / 710022004（限流）、async_task（任务已创建）
 *   DOM：安全验证 / 滑块 / 人机验证 / captcha iframe
 * 页面脚本写入 window.__qfRisk，主进程每轮询 tick 读取。
 */

const riskProbeScript = (): unknown => {
  if (window.__qfRiskProbeHooked) return { ok: true, already: true }
  window.__qfRisk = { type: 'none', detail: null, at: 0 }
  const setRisk = (type: string, detail: string | null): void => {
    window.__qfRisk = { type, detail: detail ? detail.slice(-400) : null, at: Date.now() }
  }
  const analyze = (acc: string): void => {
    if (!acc) return
    if (/async_task|"task_id"/.test(acc)) {
      // 任务已创建：若此前不是验证态，则标记 ok（验证解除）
      if ((window.__qfRisk as { type?: string }).type !== 'verify') setRisk('ok', null)
      return
    }
    if (/710022002|710022004/.test(acc)) {
      setRisk('limit', acc.slice(-400))
      return
    }
    if (/verify_scene|decision[^}]{0,80}verify/i.test(acc)) {
      setRisk('verify', acc.slice(-400))
    }
  }
  const grab = (url: string, p: Promise<Response>): void => {
    p.then((resp) => {
      try {
        if (!resp || !resp.body || !resp.clone || !resp.body.getReader) return
        const clone = resp.clone()
        if (!clone.body) return
        const reader = clone.body.getReader()
        const decoder = new TextDecoder()
        let acc = ''
        const pump = (): void => {
          reader
            .read()
            .then(({ done, value }) => {
              if (done) return
              acc += decoder.decode(value, { stream: true })
              if (acc.length > 300000) acc = acc.slice(-200000)
              analyze(acc)
              pump()
            })
            .catch(() => {})
        }
        pump()
      } catch {}
    }).catch(() => {})
  }
  const origFetch = window.fetch
  if (origFetch && !window.__qfFetchHooked) {
    window.fetch = function (...args: unknown[]): Promise<Response> {
      let u = ''
      try {
        u = typeof args[0] === 'string' ? (args[0] as string) : ((args[0] as { url?: string })?.url || '')
      } catch {}
      const p = origFetch.apply(this, args as [RequestInfo | URL, RequestInit?])
      if (/chat\/completion|samantha\/chat/.test(u)) grab(u, p)
      return p
    }
    window.__qfFetchHooked = true
  }
  const origOpen = XMLHttpRequest.prototype.open
  const origSend = XMLHttpRequest.prototype.send
  if (origOpen && origSend && !window.__qfXhrHooked) {
    XMLHttpRequest.prototype.open = function (m: string, u: string): void {
      ;(this as unknown as { __qfUrl: string }).__qfUrl = String(u)
      return origOpen.apply(this, arguments as unknown as Parameters<typeof XMLHttpRequest.prototype.open>)
    }
    XMLHttpRequest.prototype.send = function (...args: unknown[]): void {
      const x = this as unknown as XMLHttpRequest & { __qfUrl?: string }
      if (/chat\/completion|samantha\/chat/.test(x.__qfUrl || '')) {
        x.addEventListener('load', () => {
          try {
            analyze(x.responseText || '')
          } catch {}
        })
      }
      return origSend.apply(this, args as [Document | XMLHttpRequestBodyInit | null | undefined])
    }
    window.__qfXhrHooked = true
  }
  try {
    const mo = new MutationObserver(() => {
      try {
        const t = document.body ? document.body.innerText : ''
        if (
          /安全验证|滑块验证|请完成验证|拖动滑块|人机验证|完成验证|验证码/.test(t) ||
          document.querySelector('[class*="captcha" i], [class*="verify" i], iframe[src*="captcha" i]')
        ) {
          if ((window.__qfRisk as { type?: string }).type !== 'ok') {
            window.__qfRisk = { type: 'verify', detail: 'dom-verify', at: Date.now() }
          }
        }
      } catch {}
    })
    mo.observe(document.body || document.documentElement, { childList: true, subtree: true, characterData: true })
  } catch {}
  return { ok: true }
}

const readRiskScript = (): unknown => {
  const w = (window.__qfRisk || { type: 'none' }) as { type?: string; detail?: string | null }
  let domVerify = false
  try {
    const t = document.body ? document.body.innerText : ''
    if (/安全验证|滑块验证|请完成验证|拖动滑块|人机验证|完成验证/.test(t)) domVerify = true
    if (document.querySelector('[class*="captcha" i], iframe[src*="captcha" i]')) domVerify = true
  } catch {}
  const type = w.type === 'verify' || w.type === 'limit' ? w.type : domVerify ? 'verify' : 'none'
  return { type, detail: w.detail || null, domVerify }
}

/** 读取风控状态（主进程） */
async function readDoubaoRisk(win: BrowserWindow): Promise<{ type: string; detail?: string | null }> {
  try {
    return (await win.webContents.executeJavaScript(
      '(' + readRiskScript.toString() + ')()',
      true
    )) as { type: string; detail?: string | null }
  } catch {
    return { type: 'none' }
  }
}

/** 风控/验证时显示窗口交用户处理 */
function showRiskWindow(win: BrowserWindow): void {
  try {
    win.show()
    win.focus()
    win.center()
  } catch {}
}

/* ---------------- 主流程 ---------------- */

function progress(opts: DoubaoGenerateOptions, stage: string, detail?: unknown): void {
  opts.onProgress?.(stage, detail)
}

async function injectCookies(cookies: ProviderCookie[], partition: string): Promise<number> {
  const ses = session.fromPartition(partition)
  ses.setUserAgent(UA)
  let injected = 0
  for (const c of cookies) {
    try {
      const cleanDomain = (c.domain || '').replace(/^\./, '') || 'www.doubao.com'
      const cookieUrl = `${c.secure === false ? 'http' : 'https'}://${cleanDomain}${c.path || '/'}`
      // 显式设置 domain：保留原始域 cookie 语义（如 .doubao.com），
      // 否则 Electron 会将其设为 host-only cookie，www.doubao.com 收不到
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

export async function runDoubaoGeneration(options: DoubaoGenerateOptions): Promise<DoubaoGenerateResult> {
  const partition = options.keyId ? `persist:qf-p:doubao:${options.keyId}` : PARTITION
  const attempts: Array<{ providerId: string; ok: boolean; errorMessage?: string }> = []
  const fail = (error: string): DoubaoGenerateResult => {
    attempts.push({ providerId: 'doubao', ok: false, errorMessage: error })
    return { ok: false, providerId: 'doubao', error, attempts }
  }
  /** 内容政策拒绝：错误原文照搬豆包回复，标记 blocked（调用方不再切换账号重试） */
  const failBlocked = (blockedText: string): DoubaoGenerateResult => {
    const r = fail(blockedText)
    return { ...r, blocked: true }
  }
  let win: BrowserWindow | null = null
  const cancelState = options.cancel
  const failCancelled = (): DoubaoGenerateResult => {
    attempts.push({ providerId: 'doubao', ok: false, errorMessage: '已手动终止生成（提示词未发送）' })
    return { ok: false, providerId: 'doubao', cancelled: true, error: '已手动终止生成（提示词未发送）', attempts }
  }
  /** 提交前阶段边界检查：用户已点「终止生成」则销毁窗口并返回中断结果 */
  const abortIfCancelled = (): DoubaoGenerateResult | null => {
    if (!cancelState?.aborted) return null
    try {
      win?.destroy()
    } catch {}
    return failCancelled()
  }
  /** 可中断等待：每 200ms 检查一次取消标记，被取消时立即返回（调用方 return abortNow()） */
  const waitOrAbort = async (ms: number): Promise<boolean> => {
    const step = 200
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (cancelState?.aborted) return true
      await sleep(Math.min(step, end - Date.now()))
    }
    return cancelState?.aborted === true
  }
  const abortNow = (): DoubaoGenerateResult => abortIfCancelled() ?? failCancelled()

  if (options.mode && options.mode !== 'text2video' && options.mode !== 't2v' && options.mode !== 'img2video') {
    return fail('暂仅支持文生视频/图生视频（豆包），当前模式：' + options.mode)
  }

  progress(options, 'inject-cookies')
  const injected = await injectCookies(options.cookies, partition)
  if (injected === 0) {
    // 候选 C 兜底：若分区已存在登录态（登录窗口=生成分区），注入失败但可能仍可使用
    // 继续往下走，由 inspect 登录态检查决定
  }
  {
    const aborted = abortIfCancelled()
    if (aborted) return aborted
  }

  progress(options, 'open-page')
  win = new BrowserWindow({
    // 默认隐藏；设置里开启「显示豆包窗口」后可见（用于测试/观察/处理验证码）
    show: options.showWebview === true,
    width: 1280,
    height: 900,
    title: '豆包生成 - Quota-Flow',
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
  // 候选 B：webContents 也统一 UA（与登录/校验一致）
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
      win.loadURL(DOUBAO_URL),
      waitOrAbort(90000).then((ab) => {
        if (ab) throw new Error('已取消')
        throw new Error('页面加载超时')
      })
    ])
  } catch (e) {
    loadError = { code: -1, desc: e instanceof Error ? e.message : String(e), url: DOUBAO_URL }
  }
  if (await waitOrAbort(4000)) return abortNow()

  // 归一化 effectiveStorages：优先用 storages（v2 多 origin），否则 fallback localStorage（v1）
  const effectiveStorages: OriginStorage[] = []
  if (Array.isArray(options.storages) && options.storages.length > 0) {
    effectiveStorages.push(...options.storages)
  } else if (Array.isArray(options.localStorage) && options.localStorage.length > 0) {
    effectiveStorages.push({
      origin: 'https://www.doubao.com',
      localStorage: options.localStorage
    })
  }

  // 注入当前页面 origin 的 storage，然后刷新页面
  if (effectiveStorages.length > 0) {
    try {
      await win.webContents.executeJavaScript(
        `(() => {
          const all = ${JSON.stringify(effectiveStorages)};
          const main = all.find((s) => location.origin === s.origin) || all.find((s) => (s.origin || '').includes('doubao.com'));
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
      if (await waitOrAbort(3500)) return abortNow()
    } catch {
      // storage 注入失败不阻断，页面可能仅依赖 cookie
    }
  }

  let inspect: { inputFound?: boolean; inputTag?: string; hasLogin?: boolean; hasLoginWall?: boolean; hasUserInfo?: boolean; url?: string } = {}
  try {
    inspect = (await win.webContents.executeJavaScript('(' + inspectScript.toString() + ')()', true)) as typeof inspect
  } catch {
    inspect = {}
  }
  if (loadError || !inspect.inputFound) {
    win.destroy()
    return fail(loadError ? `页面加载失败 (${loadError.code}: ${loadError.desc})` : '豆包页面未找到输入框（可能未登录或页面结构变化）')
  }
  if (inspect.hasLogin) {
    win.destroy()
    return fail(
      '豆包账号未登录（cookie 可能已失效），请在厂商页重新登录后重试' +
        ` (loginWall=${inspect.hasLoginWall}, userInfo=${inspect.hasUserInfo})`
    )
  }

  // 风控探针：包装 /chat/completion 响应 + DOM 验证 UI 检测（提交前挂载）
  try {
    await win.webContents.executeJavaScript('(' + riskProbeScript.toString() + ')()', true)
  } catch {}

  {
    const aborted = abortIfCancelled()
    if (aborted) return aborted
  }
  // 等「视频生成」入口出现（SPA 渲染，最多 ~15s）
  progress(options, 'wait-tab')
  let tabReady = false
  for (let i = 0; i < 15; i++) {
    try {
      const r = await win.webContents.executeJavaScript(
        `(() => {
          const norm = (s) => (s || '').trim();
          return [...document.querySelectorAll('button, [role="button"], [role="tab"]')].some(
            (b) => b.offsetParent !== null && (norm(b.textContent) === '视频生成' || (norm(b.textContent).includes('视频生成') && !/额度|计算|说明|提示|帮助/.test(norm(b.textContent))))
          );
        })()`,
        true
      )
      if (r) {
        tabReady = true
        break
      }
    } catch {}
    if (await waitOrAbort(1000)) return abortNow()
  }
  if (!tabReady) {
    win.destroy()
    return fail('豆包页面未出现「视频生成」入口（可能未登录或页面结构变化）')
  }

  {
    const aborted = abortIfCancelled()
    if (aborted) return aborted
  }
  // 点击页签 → 轮询视频界面出现；失败则 Escape 关弹层重试
  progress(options, 'open-video-tab')
  let entered = false
  for (let attempt = 0; attempt < 2 && !entered; attempt++) {
    try {
      await win.webContents.executeJavaScript(
        `(() => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); })()`,
        true
      )
    } catch {}
    if (await waitOrAbort(500)) return abortNow()
    try {
      await win.webContents.executeJavaScript('(' + openVideoTabScript.toString() + ')()', true)
    } catch {}
    for (let i = 0; i < 8; i++) {
      if (await waitOrAbort(1500)) return abortNow()
      try {
        const vv = (await win.webContents.executeJavaScript(
          '(' + inspectScript.toString() + ')()',
          true
        )) as { inputFound?: boolean; inputTag?: string }
        if (vv && vv.inputFound && vv.inputTag === 'div') {
          entered = true
          break
        }
      } catch {}
    }
  }
  if (!entered) {
    let lastView: unknown = null
    try {
      lastView = await win.webContents.executeJavaScript('(' + inspectScript.toString() + ')()', true)
    } catch {}
    win.destroy()
    return fail('未进入视频生成界面（页面结构可能有变化）' + (lastView ? JSON.stringify(lastView).slice(0, 300) : ''))
  }

  {
    const aborted = abortIfCancelled()
    if (aborted) return aborted
  }
  // 模型：真实 UI 模型选择器（页面无模型选择器时跳过不阻断；有选择器但设置失败则终止）
  if (options.model) {
    progress(options, 'apply-model', { model: options.model })
    const modelApply = await applyDoubaoModel(win, options.model)
    if (!modelApply.ok) {
      win.destroy()
      return fail('豆包模型设置失败：' + (modelApply.reason || '未知原因'))
    }
  }

  const durationSec = options.durationSec === 10 ? 10 : options.durationSec === 15 ? 15 : 5
  // 时长：真实 UI 滑块（Radix Slider），避免「5秒 文本 vs 10s chip」双时长冲突
  progress(options, 'apply-duration', { durationSec })
  const durApply = await applyDoubaoDuration(win, durationSec)
  if (!durApply.ok) {
    win.destroy()
    return fail('豆包时长设置失败：' + (durApply.reason || '未知原因'))
  }

  // 比例：真实 UI 网格点击；失败时回退文本拼接（页面结构变化时不阻断任务）
  let ratioViaDom = false
  if (options.ratio) {
    progress(options, 'apply-ratio', { ratio: options.ratio })
    const ratioApply = await applyDoubaoRatio(win, options.ratio)
    if (ratioApply.ok) ratioViaDom = true
  }

  // 参数统一拼进提示词（豆包会从提示词解析）：生成模式 + 比例(兜底) + 配音 + 分辨率 + 单视频约束
  // 时长/比例走真实 UI 后不再拼文本，避免「文本 vs chip」冲突；比例 DOM 失败时才拼文本兜底
  const modeLabel = options.mode === 'img2video' ? '图生视频' : '文生视频'
  const parts: string[] = [options.prompt, modeLabel]
  if (options.ratio && !ratioViaDom) parts.push(options.ratio)
  if (options.audio === 'on') parts.push('带配音')
  else if (options.audio === 'off') parts.push('关闭配音')
  if (options.resolution) parts.push(`分辨率${options.resolution}p`)
  // 单视频约束：置于最后，作为最明确的指令，覆盖 prompt 里列举多个实体导致的「生成多个视频」
  parts.push('仅生成1个视频')
  const submitPrompt = parts.join('，')
  progress(options, 'apply-params', { mode: modeLabel, model: options.model, ratio: options.ratio, ratioViaDom, audio: options.audio, resolution: options.resolution, submitPrompt })

  {
    const aborted = abortIfCancelled()
    if (aborted) return aborted
  }
  progress(options, 'submit')
  let fillResult: { ok?: boolean; reason?: string } = {}
  const isImg2Video = options.mode === 'img2video'
  if (isImg2Video && (!options.images || options.images.length === 0)) {
    win.destroy()
    return fail('图生视频需要上传图片')
  }
  if (isImg2Video) {
    // 图生视频：先上传图片，再在保留图片的编辑器里插入 prompt 并提交
    const dataUrls: string[] = []
    for (const p of options.images ?? []) {
      const d = fileToDataUrl(p)
      if (d) dataUrls.push(d)
    }
    if (dataUrls.length === 0) {
      win.destroy()
      return fail('图片读取失败（路径无效或超过 10MB）')
    }
    progress(options, 'upload-images', { count: dataUrls.length })
    let uploadOk = false
    let uploadDetail: unknown = null
    let uploadCancelled = false
    try {
      await win.webContents.executeJavaScript('window.__qfUploadCancel = false', true)
      let uploadSettled = false
      const uploadPromise = win.webContents.executeJavaScript(
        '(' + uploadImagesScript.toString() + ')(' + JSON.stringify(dataUrls) + ')',
        true
      )
      const cancelPromise = cancelState
        ? (async () => {
            while (!uploadSettled) {
              if (cancelState.aborted) {
                try {
                  await win.webContents.executeJavaScript('window.__qfUploadCancel = true', true)
                } catch {}
                return { cancelled: true }
              }
              await sleep(200)
            }
            return null
          })()
        : new Promise<unknown>(() => {})
      uploadDetail = await Promise.race([uploadPromise, cancelPromise])
      uploadSettled = true
      uploadCancelled = !!(uploadDetail as { cancelled?: boolean })?.cancelled
      uploadOk = !!((uploadDetail as { ok?: boolean })?.ok)
    } catch {}
    progress(options, 'upload-images-result', uploadDetail)
    if (uploadCancelled) {
      win.destroy()
      return abortNow()
    }
    if (!uploadOk) {
      win.destroy()
      return fail('图片上传失败（豆包界面未确认图片上传完成），请确认图片格式后重试')
    }
    progress(options, 'submit-img2video')
    try {
      fillResult = (await win.webContents.executeJavaScript(
        '(' + insertPromptAndSubmitScript.toString() + ')(' + JSON.stringify(submitPrompt) + ')',
        true
      )) as typeof fillResult
    } catch (e) {
      fillResult = { ok: false, reason: e instanceof Error ? e.message : String(e) }
    }
  } else {
    try {
      fillResult = (await win.webContents.executeJavaScript(
        '(' + fillAndSubmitScript.toString() + ')(' + JSON.stringify(submitPrompt) + ')',
        true
      )) as typeof fillResult
    } catch (e) {
      fillResult = { ok: false, reason: e instanceof Error ? e.message : String(e) }
    }
  }
  if (!fillResult.ok) {
    win.destroy()
    return fail(fillResult.reason || '提交失败')
  }
  // 脚本执行期间用户点了停止：即使脚本已跑完，也按中断处理，不再继续（杜绝「点了停止还在生成」）
  {
    const aborted = abortIfCancelled()
    if (aborted) return aborted
  }
  // 提示词已发送：此后不允许再终止（主进程 cancel 会因 submitted=true 拒绝）
  if (cancelState) cancelState.submitted = true

  // 提交后检查风控：verify → 显示窗口交用户；limit → 直接失败
  await sleep(1500)
  let risk = await readDoubaoRisk(win)
  if (risk.type === 'limit') {
    win.destroy()
    return fail('豆包风控/限流：' + (risk.detail || '请稍后再试'))
  }
  let riskMode = false
  let riskSince = 0
  const RISK_TIMEOUT_MS = 300000 // 风控验证等待上限：5 分钟
  if (risk.type === 'verify') {
    riskMode = true
    riskSince = Date.now()
    showRiskWindow(win)
    progress(options, 'risk-verify', { message: '豆包要求验证，请在弹出的豆包窗口中完成验证' })
  }

  // 内容政策拒绝：豆包返回侵权/肖像/版权等拒绝文案 → 直接失败（不扣额度）
  let submitCheck: { blockedText?: string | null } = {}
  try {
    submitCheck = (await win.webContents.executeJavaScript(
      '(' + extractResultScript.toString() + ')()',
      true
    )) as typeof submitCheck
  } catch {}
  if (submitCheck.blockedText) {
    win.destroy()
    return failBlocked(submitCheck.blockedText)
  }

  progress(options, 'waiting')
  const maxWaitMs = (options.maxWaitSec ?? 360) * 1000
  const started = Date.now()
  let cardClicked = false
  let doneTicks = 0
  let final: { videoUrl?: string; posterUrl?: string | null } | null = null

  while (Date.now() - started < maxWaitMs) {
    await sleep(5000)
    let r: {
      vids?: Array<{ src: string; poster?: string }>
      mp4s?: string[]
      hasDone?: boolean
      blockedText?: string | null
      textTail?: string
    } = {}
    try {
      r = (await win.webContents.executeJavaScript('(' + extractResultScript.toString() + ')()', true)) as typeof r
    } catch {
      r = {}
    }
    // 风控处理：verify → 弹窗交用户；limit → 失败；用户解决后恢复/隐藏
    let riskTick: { type: string; detail?: string | null } = { type: 'none' }
    try {
      riskTick = await readDoubaoRisk(win)
    } catch {}
    if (riskTick.type === 'verify' && !riskMode) {
      riskMode = true
      riskSince = Date.now()
      showRiskWindow(win)
      progress(options, 'risk-verify', { message: '豆包要求验证，请在弹出的豆包窗口中完成验证' })
    }
    if (riskTick.type === 'limit') {
      win.destroy()
      return fail('豆包风控/限流：' + (riskTick.detail || '请稍后再试'))
    }
    if (riskMode) {
      if (riskTick.type !== 'verify') {
        riskMode = false
        if (options.showWebview !== true) {
          try {
            win.hide()
          } catch {}
        }
        progress(options, 'risk-resolved')
      } else if (Date.now() - riskSince > RISK_TIMEOUT_MS) {
        win.destroy()
        return fail('豆包风控验证未完成，请手动重试')
      }
    }
    // 内容政策拒绝：侵权/肖像/版权 → 直接失败
    if (r.blockedText) {
      win.destroy()
      return failBlocked(r.blockedText)
    }
    const video = r.vids && r.vids[0]
    const mp4 = r.mp4s && r.mp4s[0]
    if (video && video.src) {
      final = { videoUrl: video.src, posterUrl: video.poster || null }
      break
    }
    if (mp4) {
      final = { videoUrl: mp4 }
      break
    }
    if (r.hasDone) {
      doneTicks += 1
      if (doneTicks >= 2 && !cardClicked) {
        cardClicked = true
        try {
          await win.webContents.executeJavaScript('(' + clickVideoCardScript.toString() + ')()', true)
        } catch {}
      }
    } else {
      doneTicks = 0
    }
  }

  win.destroy()
  if (!final?.videoUrl) {
    return fail('等待超时未取到视频 URL')
  }
  attempts.push({ providerId: 'doubao', ok: true })
  return {
    ok: true,
    providerId: 'doubao',
    videoUrl: final.videoUrl,
    posterUrl: final.posterUrl ?? null,
    attempts
  }
}
