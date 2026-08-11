// 豆包（Seedance）WebView 生成执行引擎
// 链路：cookie 注入 → 打开豆包 → 进入「视频生成」→ 选时长 → 填 prompt（清理 chip）→ 提交
//       → 轮询「你的视频生成好了」→ 点击视频卡片 → 提取 mp4 URL
// 由 dispatch.ts 调用，不直接暴露给渲染进程。

import { BrowserWindow, session } from 'electron'

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
  /** 生成模式：text2video（当前仅支持） / img2video 等 */
  mode?: string
  /** 清晰度：豆包规格无清晰度维度，仅透传记录 */
  resolution?: string
  /** 配音：on / off（尽力注入） */
  audio?: string
  /** 画面比例：9:16 / 16:9 / 1:1（尽力注入） */
  ratio?: string
  /** 账号 id：用于隔离 WebView 分区（persist:qf-p:doubao:<keyId>），防多账号串号；登录窗口也共用该分区（候选 C） */
  keyId?: string
  /** 5 / 10 / 15，默认 5（1 点/次） */
  durationSec?: number
  /** 最长等待秒数，默认 360 */
  maxWaitSec?: number
  onProgress?: (stage: string, detail?: unknown) => void
}

export interface DoubaoGenerateResult {
  ok: boolean
  providerId: 'doubao'
  videoUrl?: string
  posterUrl?: string | null
  error?: string
  attempts: Array<{ providerId: string; ok: boolean; errorMessage?: string }>
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

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
  return {
    vids,
    mp4s: mp4s.slice(0, 8),
    hasDone: /你的视频生成好了|生成完成|生成成功|生成完毕/.test(text),
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

  if (options.mode && options.mode !== 'text2video' && options.mode !== 't2v') {
    return fail('暂仅支持文生视频（豆包），当前模式：' + options.mode)
  }

  progress(options, 'inject-cookies')
  const injected = await injectCookies(options.cookies, partition)
  if (injected === 0) {
    // 候选 C 兜底：若分区已存在登录态（登录窗口=生成分区），注入失败但可能仍可使用
    // 继续往下走，由 inspect 登录态检查决定
  }

  progress(options, 'open-page')
  const win = new BrowserWindow({
    show: false,
    // 防止 Windows 上隐藏窗口在创建/导航时闪现
    paintWhenInitiallyHidden: false,
    width: 1280,
    height: 900,
    backgroundColor: '#0c0c0c',
    webPreferences: {
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
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
      sleep(90000).then(() => {
        throw new Error('页面加载超时')
      })
    ])
  } catch (e) {
    loadError = { code: -1, desc: e instanceof Error ? e.message : String(e), url: DOUBAO_URL }
  }
  await sleep(4000)

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
      await sleep(3500)
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
    await sleep(1000)
  }
  if (!tabReady) {
    win.destroy()
    return fail('豆包页面未出现「视频生成」入口（可能未登录或页面结构变化）')
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
    await sleep(500)
    try {
      await win.webContents.executeJavaScript('(' + openVideoTabScript.toString() + ')()', true)
    } catch {}
    for (let i = 0; i < 8; i++) {
      await sleep(1500)
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

  // 参数统一拼进提示词（豆包会从提示词解析）：时长 + 比例 + 配音
  const durationSec = options.durationSec === 10 ? 10 : options.durationSec === 15 ? 15 : 5
  const parts: string[] = [options.prompt, `${durationSec}秒`]
  if (options.ratio) parts.push(options.ratio)
  if (options.audio === 'on') parts.push('带配音')
  else if (options.audio === 'off') parts.push('关闭配音')
  if (options.resolution) parts.push(`帧率${options.resolution}p`)
  // 单视频约束：置于最后，作为最明确的指令，覆盖 prompt 里列举多个实体导致的「生成多个视频」
  parts.push('仅生成1个视频')
  const submitPrompt = parts.join('，')
  progress(options, 'apply-params', { durationSec, ratio: options.ratio, audio: options.audio, submitPrompt })

  progress(options, 'submit')
  let fillResult: { ok?: boolean; reason?: string } = {}
  try {
    fillResult = (await win.webContents.executeJavaScript(
      '(' + fillAndSubmitScript.toString() + ')(' + JSON.stringify(submitPrompt) + ')',
      true
    )) as typeof fillResult
  } catch (e) {
    fillResult = { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
  if (!fillResult.ok) {
    win.destroy()
    return fail(fillResult.reason || '提交失败')
  }

  progress(options, 'waiting')
  const maxWaitMs = (options.maxWaitSec ?? 360) * 1000
  const started = Date.now()
  let cardClicked = false
  let doneTicks = 0
  let final: { videoUrl?: string; posterUrl?: string | null } | null = null

  while (Date.now() - started < maxWaitMs) {
    await sleep(5000)
    let r: { vids?: Array<{ src: string; poster?: string }>; mp4s?: string[]; hasDone?: boolean; textTail?: string } = {}
    try {
      r = (await win.webContents.executeJavaScript('(' + extractResultScript.toString() + ')()', true)) as typeof r
    } catch {
      r = {}
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
