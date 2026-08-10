// 豆包 API 路实测脚本（Electron 主进程）
// 凭据三通道：①应用登录态 → Supabase provider_keys → safeStorage 解密 cookie；
//             ②本地 data/doubao-auth.json；③弹出豆包登录窗口（用户扫码登录后自动继续）。
// 流程：注入 persist:qf-p:doubao → 打开豆包 → 自动输入 prompt → 捕获网络请求
//       → 轮询页面视频元素，输出结构化结果后退出。
// 运行：cd apps/desktop && npx --no-install electron scripts/doubao-e2e-test.cjs

const { app, BrowserWindow, session, safeStorage } = require('electron')
const fs = require('fs')
const path = require('path')

const REPO = path.resolve(__dirname, '..', '..', '..')
const DESKTOP_NM = path.join(REPO, 'apps', 'desktop', 'node_modules')
const AUTH_FILE = path.join(process.env.APPDATA || '', '@quota-flow', 'desktop', 'auth.json')
const ENV_FILE = path.join(REPO, 'apps', 'desktop', '.env')
const LOCAL_AUTH_FILE = path.join(REPO, 'data', 'doubao-auth.json')
const LOG_FILE = path.join(process.env.TEMP || '.', 'qf-doubao-e2e.log')
const CAPTURE_FILE = path.join(process.env.TEMP || '.', 'qf-doubao-capture.jsonl')
const MAX_SECONDS = Number(process.env.QF_TEST_MAX_SECONDS || 360)

const { ProviderService, createSupabaseClient } = require(path.join(DESKTOP_NM, '@quota-flow', 'db-supabase', 'dist', 'index.js'))

const PROMPT = process.env.QF_TEST_PROMPT || '生成5秒视频：一只橘猫在窗台上晒太阳，微风吹动窗帘'
const DOUBAO_URL = 'https://www.doubao.com/chat/'
const PARTITION = 'persist:qf-p:doubao'
const MAX_POLLS = Number(process.env.QF_MAX_POLLS || 72) // 72 × 5s = 6 分钟
const LOGIN_TIMEOUT_SECONDS = 600

function log(k, v) {
  const line = '[' + k + '] ' + (typeof v === 'string' ? v : JSON.stringify(v))
  console.log(line)
  try {
    fs.appendFileSync(LOG_FILE, new Date().toISOString() + ' ' + line + '\n')
  } catch {
    // 日志文件写入失败不阻断
  }
}

log('started', { pid: process.pid, log: LOG_FILE, prompt: PROMPT, maxSeconds: MAX_SECONDS })

process.on('uncaughtException', (e) => {
  log('uncaught', e && e.stack ? e.stack : String(e))
  app.exit(2)
})
process.on('unhandledRejection', (e) => {
  log('unhandled', e instanceof Error ? e.stack || e.message : String(e))
  app.exit(2)
})
process.on('exit', (code) => {
  try {
    fs.appendFileSync(LOG_FILE, new Date().toISOString() + ' [exit] code=' + code + '\n')
  } catch {}
})

function loadEnv() {
  const raw = fs.readFileSync(ENV_FILE, 'utf8')
  const env = {}
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_]+)=(.*)$/)
    if (m) env[m[1]] = m[2].trim()
  }
  return env
}

function readStoredSession() {
  if (!fs.existsSync(AUTH_FILE)) return null
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('safeStorage 不可用，无法解密登录态')
  }
  const raw = fs.readFileSync(AUTH_FILE, 'utf8')
  return JSON.parse(safeStorage.decryptString(Buffer.from(raw.trim(), 'base64')))
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const inspectScript = () => {
  const norm = (s) => (s || '').trim()
  const input =
    [...document.querySelectorAll('textarea, [contenteditable="true"], [contenteditable="plaintext-only"], [role="textbox"]')].find(
      (el) => el.offsetParent !== null
    ) || null
  const btns = [...document.querySelectorAll('button, [role="button"]')]
    .filter((b) => b.offsetParent !== null)
    .map((b) => norm(b.textContent))
    .filter(Boolean)
    .slice(0, 20)
  const hasLogin = /登录|扫码|手机号|验证码/.test(btns.join(' '))
  return {
    url: location.href,
    inputFound: !!input,
    inputTag: input ? input.tagName.toLowerCase() : '',
    hasLogin,
    buttons: btns.slice(0, 12)
  }
}

const autoSend = (prompt) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const norm = (s) => (s || '').trim()
  const isSendText = (t) => /发送|提交/.test(t) && !/停止/.test(t) && !/生成|写作|问答|音乐|播客|绘画|图片|视频/.test(t)
  const findInput = () => {
    const pick = (sels) => {
      for (const s of sels) {
        const els = [...document.querySelectorAll(s)].filter((el) => el.offsetParent !== null)
        if (els.length) return els[0]
      }
      return null
    }
    // ProseMirror/TipTap 编辑器优先（豆包视频生成界面）
    const rich =
      pick(['[class*="ProseMirror"]', '[class*="tiptap"]', '[contenteditable="true"]', '[contenteditable="plaintext-only"]']) ||
      pick(['[role="textbox"]'])
    if (rich) return rich
    return pick(['textarea', 'input[type="text"]'])
  }
  const setValue = (el, text) => {
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement : window.HTMLInputElement
      const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value').set
      setter.call(el, text)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    } else {
      el.focus()
      try {
        document.execCommand('selectAll', false, null)
      } catch {}
      try {
        document.execCommand('insertText', false, text)
      } catch {}
      if (!(el.innerText || el.textContent || '').includes(text.slice(0, 8))) {
        try {
          el.innerHTML = ''
          el.focus()
          document.execCommand('insertText', false, text)
        } catch {}
      }
      el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }))
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    }
  }
  const findSend = () => {
    const btns = [...document.querySelectorAll('button, [role="button"], [class*="send" i], [class*="submit" i], [class*="action" i]')]
    const visible = btns.filter((b) => b.offsetParent !== null && b.disabled !== true && b.getAttribute('aria-disabled') !== 'true')
    const hit = visible.find(
      (b) =>
        isSendText(norm(b.textContent)) ||
        isSendText(norm(b.getAttribute('aria-label'))) ||
        isSendText(norm(b.getAttribute('title'))) ||
        isSendText(norm(b.getAttribute('data-testid')))
    )
    if (hit) return hit
    const genHit = visible.find((b) => {
      const t = norm(b.textContent) || norm(b.getAttribute('aria-label')) || ''
      return /^(生成|开始生成|立即生成|创建视频|生成视频)$/.test(t) || /^生成/.test(t)
    })
    if (genHit) return genHit
    let node = findInput()
    for (let i = 0; i < 4 && node; i++) {
      const parent = node.parentElement
      if (!parent) break
      const icons = [...parent.querySelectorAll('button, [role="button"]')].filter(
        (b) => b.offsetParent !== null && b.querySelector('svg')
      )
      if (icons.length) return icons[icons.length - 1]
      node = parent
    }
    const anyIcons = visible.filter((b) => b.querySelector('svg'))
    return anyIcons.length ? anyIcons[anyIcons.length - 1] : null
  }
  return (async () => {
    const input = findInput()
    if (!input) return { ok: false, reason: '未找到输入框，可能未登录或页面结构不同' }
    setValue(input, prompt)
    await sleep(700)
    const inputText =
      norm(input.innerText || input.textContent || '') ||
      (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT' ? norm(input.value) : '')
    const filled = inputText.includes(prompt.slice(0, 8))
    if (!filled) return { ok: false, reason: '内容未成功填入编辑器（ProseMirror 可能拦截了输入）', via: 'fill' }
    const hasSubmitRequest = () => {
      const n = window.__qfNet
      if (!n) return false
      return []
        .concat(n.fetch || [])
        .concat(n.xhr || [])
        .filter((x) => /chat\/completion|samantha\/chat|creativity|video\/|generate/.test(x.url || ''))
        .length > 0
    }
    const hasUserMsg = () => (document.body ? document.body.innerText : '').includes(prompt.slice(0, 12))
    input.focus()
    const enterOpts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }
    input.dispatchEvent(new KeyboardEvent('keydown', enterOpts))
    input.dispatchEvent(new KeyboardEvent('keypress', enterOpts))
    input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }))
    await sleep(1200)
    if (hasUserMsg()) return { ok: true, reason: '已回车发送，用户消息已上屏', via: 'enter' }
    if (hasSubmitRequest()) return { ok: true, reason: '已触发提交请求（/chat/completion）', via: 'enter-submit' }
    // 候选生成按钮：输入区域附近的带 SVG 图标按钮（优先之前禁用、现在启用的）
    const iconBtns = [...document.querySelectorAll('button, [role="button"]')].filter(
      (b) => b.offsetParent !== null && b.querySelector('svg')
    )
    const inputArea =
      (input.closest && input.closest('[class*="input" i], [class*="footer" i], [class*="editor" i]')) ||
      (input.parentElement && input.parentElement.parentElement) ||
      input.parentElement
    const areaBtns = iconBtns.filter((b) => inputArea.contains(b))
    const candidates = areaBtns.filter(
      (b) => b.disabled === false && b.getAttribute('aria-disabled') !== 'true'
    )
    if (candidates.length === 0) candidates.push(...iconBtns.slice(-3))
    let clickReason = ''
    for (const b of candidates.slice(0, 4)) {
      b.click()
      await sleep(1600)
      if (hasSubmitRequest() || hasUserMsg()) {
        return {
          ok: true,
          reason: '已点击生成按钮并触发提交',
          via: 'click',
          btnText: norm(b.textContent).slice(0, 12),
          btnAria: norm(b.getAttribute('aria-label')).slice(0, 12)
        }
      }
      clickReason = '点击后未检测到提交请求'
    }
    return { ok: false, reason: '已填入内容，点击候选按钮后仍无提交请求（' + clickReason + '）', via: 'click' }
  })()
}

// 页面内网络钩子：记录 WebSocket / fetch / XHR，用于确认豆包提交走的通道
const netHookScript = () => {
  window.__qfNet = { ws: [], fetch: [], xhr: [], bodies: [] }
  const grabBody = (url, p) => {
    try {
      p.then((resp) => {
        try {
          if (!resp || !resp.body || !resp.clone) return
          const clone = resp.clone()
          const reader = clone.body.getReader()
          const decoder = new TextDecoder()
          let acc = ''
          const started = Date.now()
          const pump = async () => {
            while (Date.now() - started < 360000) {
              const { done, value } = await reader.read()
              if (done) break
              acc += decoder.decode(value, { stream: true })
              if (acc.length > 500000) acc = acc.slice(-250000)
              if (/(video_model|videoModel|video_url|videoUrl|\.mp4)/.test(acc)) {
                const mp4s = (acc.match(/https?:\\?\/\\?\/[^"'\\\s]+\.mp4[^"'\\\s]*/g) || []).slice(0, 6)
                const videoUrls = (acc.match(/https?:\\?\/\\?\/[^"'\\\s]*(video|vod|byteimg)[^"'\\\s]*/g) || []).slice(0, 6)
                window.__qfNet.bodies.push({
                  url: String(url).slice(0, 120),
                  len: acc.length,
                  mp4s,
                  videoUrls,
                  hasVideoModel: true,
                  tail: acc.slice(-500)
                })
                break
              }
            }
            try {
              await reader.cancel()
            } catch {}
          }
          void pump()
        } catch {}
      }).catch(() => {})
    } catch {}
  }
  try {
    const OrigWS = window.WebSocket
    if (OrigWS && !window.__qfWSHooked) {
      window.WebSocket = function (...args) {
        try {
          window.__qfNet.ws.push({ url: String(args[0]).slice(0, 240), at: Date.now() })
        } catch {}
        return new OrigWS(...args)
      }
      window.WebSocket.prototype = OrigWS.prototype
      window.WebSocket.CONNECTING = OrigWS.CONNECTING
      window.WebSocket.OPEN = OrigWS.OPEN
      window.WebSocket.CLOSING = OrigWS.CLOSING
      window.WebSocket.CLOSED = OrigWS.CLOSED
      window.__qfWSHooked = true
    }
  } catch {}
  const origFetch = window.fetch
  if (origFetch && !window.__qfFetchHooked) {
    window.fetch = function (...args) {
      let p = null
      try {
        const u = typeof args[0] === 'string' ? args[0] : (args[0] && (args[0].url || '')) || ''
        window.__qfNet.fetch.push({ url: String(u).slice(0, 240), at: Date.now() })
        p = origFetch.apply(this, args)
        if (/chat\/completion|im\/chain|im\/conversation/.test(String(u))) {
          grabBody(u, p)
        }
      } catch {
        if (!p) p = origFetch.apply(this, args)
      }
      return p
    }
    window.__qfFetchHooked = true
  }
  const origOpen = XMLHttpRequest.prototype.open
  if (origOpen && !window.__qfXhrHooked) {
    XMLHttpRequest.prototype.open = function (m, u) {
      try {
        window.__qfNet.xhr.push({ method: String(m), url: String(u).slice(0, 240), at: Date.now() })
      } catch {}
      return origOpen.apply(this, arguments)
    }
    window.__qfXhrHooked = true
  }
}

// 点击「视频生成」页签，进入豆包专用视频生成界面
const openVideoTabScript = () => {
  const norm = (s) => (s || '').trim()
  const btns = [...document.querySelectorAll('button, [role="button"]')].filter((b) => b.offsetParent !== null)
  const textOf = (b) => norm(b.textContent) || norm(b.getAttribute('aria-label')) || norm(b.getAttribute('title'))
  const hit =
    btns.find((b) => textOf(b) === '视频生成') ||
    btns.find((b) => {
      const t = textOf(b)
      return t.includes('视频生成') && !/额度|计算|说明|提示|帮助/.test(t)
    })
  if (!hit) return { ok: false, reason: '未找到「视频生成」入口' }
  hit.click()
  return { ok: true, text: textOf(hit).slice(0, 20) }
}

// 详细 DOM 转储：视频生成界面的按钮 / 输入框 / 含「生成」字样的元素
const dumpDomScript = () => {
  const norm = (s) => (s || '').trim()
  const visible = (el) => el.offsetParent !== null
  const btns = [...document.querySelectorAll('button, [role="button"], [class*="btn" i]')]
    .filter(visible)
    .map((b) => ({
      tag: b.tagName.toLowerCase(),
      text: norm(b.textContent).slice(0, 24),
      aria: norm(b.getAttribute('aria-label')).slice(0, 24),
      title: norm(b.getAttribute('title')).slice(0, 24),
      cls: (typeof b.className === 'string' ? b.className : '').slice(0, 60),
      disabled: b.disabled === true || b.getAttribute('aria-disabled') === 'true',
      svg: !!b.querySelector('svg')
    }))
    .slice(0, 40)
  const inputs = [...document.querySelectorAll('textarea, input, [contenteditable="true"], [contenteditable="plaintext-only"], [role="textbox"]')]
    .filter(visible)
    .map((el) => ({
      tag: el.tagName.toLowerCase(),
      placeholder: norm(el.getAttribute('placeholder')).slice(0, 30),
      aria: norm(el.getAttribute('aria-label')).slice(0, 30),
      cls: (typeof el.className === 'string' ? el.className : '').slice(0, 60)
    }))
  const genTexts = [...document.querySelectorAll('*')]
    .filter(visible)
    .map((el) => norm(el.textContent))
    .filter((t) => t && t.length <= 12 && /生成|创作|开始/.test(t))
    .slice(0, 20)
  return { url: location.href, btns, inputs, genTexts }
}

// 生成完成后点击视频卡片（封面占位图/播放按钮），触发 <video> 挂载
const clickVideoCardScript = () => {
  let clicked = 0
  const seen = new Set()
  const clickEl = (el) => {
    if (!el || seen.has(el)) return
    seen.add(el)
    try {
      el.click()
      clicked += 1
    } catch {}
  }
  const imgs = [...document.querySelectorAll('img')].filter(
    (img) => (img.src || '').includes('video_dsz_watermark') || /video/i.test(img.src || '')
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
    (el) => el.offsetParent !== null && /video|play/i.test((el.className || '') + ' ' + (el.getAttribute('aria-label') || ''))
  )
  for (const el of playEls.slice(0, 6)) clickEl(el)
  return { clicked, found: imgs.length }
}

// 点开最近一个「生成视频」会话（复用已提交、正在生成中的任务）
const openRecentConversationScript = () => {
  const norm = (s) => (s || '').trim()
  const els = [...document.querySelectorAll('div, li, a, button')].filter(
    (el) =>
      el.offsetParent !== null &&
      norm(el.textContent).includes('生成视频') &&
      norm(el.textContent).length < 80
  )
  if (els.length === 0) return { ok: false, reason: '未找到会话入口' }
  const target = els[els.length - 1]
  target.click()
  return { ok: true, text: norm(target.textContent).slice(0, 40) }
}

const extractResultScript = () => {
  const vids = [...document.querySelectorAll('video')]
    .map((v) => ({ src: v.currentSrc || v.src || '', poster: v.poster || '' }))
    .filter((v) => /^https?:/.test(v.src))
  const mp4s = []
  try {
    const seen = new Set()
    for (const el of document.querySelectorAll('*')) {
      for (const attr of ['src', 'href', 'data-src', 'data-url']) {
        const v = el.getAttribute && el.getAttribute(attr)
        if (v && /\.mp4([?#]|$)/i.test(v) && !seen.has(v)) {
          seen.add(v)
          mp4s.push(v)
        }
      }
      const bg = el.style && el.style.backgroundImage
      if (bg) {
        const m = bg.match(/url\(["']?(https?:[^"')]+\.mp4[^"')]*)["']?\)/i)
        if (m && !seen.has(m[1])) {
          seen.add(m[1])
          mp4s.push(m[1])
        }
      }
    }
  } catch {
    // DOM 扫描异常忽略
  }
  let net = null
  try {
    net = window.__qfNet || null
  } catch {
    net = null
  }
  const videoUrls = []
  try {
    const seen = new Set()
    for (const el of document.querySelectorAll('*')) {
      const attrs = el.attributes || []
      for (let i = 0; i < attrs.length; i++) {
        const v = attrs[i].value
        if (!v || v.length > 600) continue
        if (/\.mp4([?#]|$)/i.test(v) || /video-sign|video-cdn|video_url|videoUrl/.test(v)) {
          const m = v.match(/https?:\/\/[^"'\\\s]+/g)
          if (m) {
            for (const u of m) {
              if (!seen.has(u)) {
                seen.add(u)
                videoUrls.push(u)
              }
            }
          }
        }
      }
      const bg = el.style && el.style.backgroundImage
      if (bg) {
        const m = bg.match(/url\(["']?(https?:[^"')]+)["']?\)/i)
        if (m && !seen.has(m[1])) {
          seen.add(m[1])
          videoUrls.push(m[1])
        }
      }
    }
  } catch {
    // 忽略扫描异常
  }
  const text = document.body ? document.body.innerText : ''
  return {
    vids,
    mp4s: mp4s.slice(0, 8),
    videoUrls: videoUrls.slice(0, 8),
    net,
    hasDone: /你的视频生成好了|生成完成|生成成功|生成完毕/.test(text),
    hasPending: /生成中|视频生成|正在生成|排队|创作中/.test(text),
    textTail: text.slice(-240)
  }
}

// 读取 data/doubao-auth.json（与 qwen/yuanbao 同款格式：{"cookie": "name=value; ..."}）
function loadLocalDoubaoCookies() {
  if (!fs.existsSync(LOCAL_AUTH_FILE)) return null
  try {
    const raw = fs.readFileSync(LOCAL_AUTH_FILE, 'utf8').replace(/^\uFEFF/, '')
    const auth = JSON.parse(raw)
    const cookieStr = auth.cookie || auth.cookies
    if (!cookieStr) return null
    const parts = String(cookieStr)
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean)
    const cookies = []
    for (const part of parts) {
      const idx = part.indexOf('=')
      if (idx <= 0) continue
      const name = part.slice(0, idx).trim()
      const value = part.slice(idx + 1).trim()
      if (!name || !value) continue
      cookies.push({
        name,
        value,
        domain: '.doubao.com',
        path: '/',
        httpOnly: false,
        secure: true,
        expires: 0
      })
    }
    return cookies.length ? cookies : null
  } catch (e) {
    log('warn', '解析 data/doubao-auth.json 失败: ' + (e instanceof Error ? e.message : String(e)))
    return null
  }
}

// 路径 1：应用登录态 → Supabase provider_keys → safeStorage 解密豆包 cookie
async function resolveSupabaseCookies(env, sessionData) {
  const client = createSupabaseClient({
    supabaseUrl: env.VITE_SUPABASE_URL,
    supabaseAnonKey: env.VITE_SUPABASE_ANON_KEY
  })
  try {
    await client.auth.setSession({
      access_token: sessionData.accessToken,
      refresh_token: sessionData.refreshToken
    })
  } catch {
    // setSession 失败不致命，稍后走 refreshSession
  }
  let user = null
  const first = await client.auth.getUser()
  if (!first.error && first.data?.user) {
    user = first.data.user
  } else {
    const { error: refreshError } = await client.auth.refreshSession({
      refresh_token: sessionData.refreshToken
    })
    if (refreshError) {
      log('warn', '刷新登录态失败: ' + refreshError.message)
      return null
    }
    const second = await client.auth.getUser()
    if (second.error || !second.data?.user) {
      log('warn', '刷新后仍无法获取用户: ' + (second.error ? second.error.message : 'no user'))
      return null
    }
    user = second.data.user
  }
  const userId = user.id
  log('user', userId)

  const svc = new ProviderService(client)
  let providers, keys
  try {
    providers = await svc.listProviders()
    keys = await svc.listProviderKeys(userId)
  } catch (e) {
    log('warn', '查询 Supabase 失败: ' + (e instanceof Error ? e.message : String(e)))
    return null
  }

  const bound = keys.map((k) => k.provider_id)
  const doubaoKeys = keys.filter((k) => k.provider_id === 'doubao')
  if (doubaoKeys.length === 0) {
    log('warn', 'Supabase 中未绑定豆包账号（bound=' + JSON.stringify(bound) + '），回退本地 auth 文件')
    return null
  }

  log('doubao-keys', doubaoKeys.map((k) => ({
    id: k.id,
    accountName: k.account_name,
    health: k.health_status,
    expiresAt: k.cookie_expires_at,
    authType: k.auth_type
  })))

  const key = doubaoKeys[0]
  let cookies
  try {
    const plain = safeStorage.decryptString(Buffer.from(key.encrypted_key, 'base64'))
    cookies = JSON.parse(plain)
  } catch (e) {
    log('warn', '解密豆包 cookie 失败: ' + (e instanceof Error ? e.message : String(e)))
    return null
  }
  if (!Array.isArray(cookies) || cookies.length === 0) {
    log('warn', '豆包 cookie 为空或格式不正确')
    return null
  }
  return {
    cookies,
    keyInfo: { source: 'provider_keys', keyId: key.id, accountName: key.account_name }
  }
}

// 路径 3：弹出可见登录窗口，用户完成豆包登录后收集 cookie（复用桌面端登录流程）
function openDoubaoLogin() {
  return new Promise((resolve) => {
    const ses = session.fromPartition(PARTITION)
    void ses.clearStorageData({ storages: ['cookies', 'localstorage'] })

    const win = new BrowserWindow({
      show: true,
      width: 1120,
      height: 780,
      minWidth: 900,
      minHeight: 640,
      autoHideMenuBar: true,
      title: '豆包登录 - Quota-Flow',
      backgroundColor: '#ffffff',
      webPreferences: {
        partition: PARTITION,
        contextIsolation: true,
        nodeIntegration: false
      }
    })
    win.center()
    win.focus()
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('http')) {
        return { action: 'allow', overrideBrowserWindowOptions: { width: 560, height: 720, autoHideMenuBar: true } }
      }
      return { action: 'deny' }
    })

    let finished = false
    let timer = null
    const done = (result) => {
      if (finished) return
      finished = true
      if (timer) clearInterval(timer)
      if (!win.isDestroyed()) win.destroy()
      resolve(result)
    }
    win.on('closed', () => {
      if (timer) clearInterval(timer)
      if (!finished) {
        finished = true
        resolve({ ok: false, canceled: true, error: '登录窗口已关闭' })
      }
    })

    const injectBar = () => {
      void win.webContents
        .executeJavaScript(`(() => {
          if (document.getElementById('qf-login-bar')) return;
          const bar = document.createElement('div');
          bar.id = 'qf-login-bar';
          bar.style.cssText = 'position:fixed;top:0;left:0;right:0;height:40px;z-index:2147483647;display:flex;align-items:center;justify-content:space-between;padding:0 12px;background:#1c1c1e;color:#fff;font:13px/1.4 -apple-system,"Segoe UI",sans-serif;';
          bar.innerHTML =
            '<span>请在窗口内完成豆包登录，然后点击右侧按钮</span>' +
            '<button id="qf-login-done" style="padding:5px 14px;border:0;border-radius:6px;background:#e07a3e;color:#fff;cursor:pointer;">已完成登录</button>';
          document.documentElement.style.marginTop = '40px';
          document.body.appendChild(bar);
          document.getElementById('qf-login-done').addEventListener('click', () => {
            window.__QF_LOGIN_DONE__ = true;
          });
        })()`)
        .catch(() => {})
    }
    win.webContents.on('did-finish-load', () => injectBar())

    timer = setInterval(() => {
      if (win.isDestroyed()) return
      void win.webContents
        .executeJavaScript('window.__QF_LOGIN_DONE__ === true')
        .then(async (flag) => {
          if (!flag) return
          const all = await ses.cookies.get({})
          if (all.length === 0) {
            done({ ok: false, error: '未检测到 Cookie，请确认已登录后重试' })
            return
          }
          const cookies = all.map((c) => ({
            name: c.name,
            value: c.value,
            domain: c.domain || '',
            path: c.path || '/',
            httpOnly: !!c.httpOnly,
            secure: !!c.secure,
            expires: typeof c.expirationDate === 'number' && c.expirationDate > 0 ? c.expirationDate * 1000 : 0
          }))
          done({ ok: true, cookies })
        })
        .catch(() => {})
    }, 800)

    void win.loadURL(DOUBAO_URL).catch((e) => done({ ok: false, error: '加载登录页失败: ' + String(e) }))
    setTimeout(() => {
      if (!finished) done({ ok: false, error: '登录超时（' + LOGIN_TIMEOUT_SECONDS + 's）' })
    }, LOGIN_TIMEOUT_SECONDS * 1000)
  })
}

async function main() {
  const env = loadEnv()
  if (!env.VITE_SUPABASE_URL || !env.VITE_SUPABASE_ANON_KEY) {
    log('warn', 'apps/desktop/.env 缺少 Supabase 配置，仅尝试本地 data/doubao-auth.json')
  }

  let sessionData = null
  try {
    sessionData = readStoredSession()
  } catch (e) {
    log('error', '解密登录态失败: ' + (e instanceof Error ? e.message : String(e)))
  }
  if (!sessionData) {
    log('warn', '无可用应用登录态（auth.json 缺失或无法解密），回退到本地 data/doubao-auth.json')
  }

  let resolved = null
  if (sessionData && env.VITE_SUPABASE_URL && env.VITE_SUPABASE_ANON_KEY) {
    resolved = await resolveSupabaseCookies(env, sessionData)
  }
  if (!resolved) {
    const local = loadLocalDoubaoCookies()
    if (local) {
      resolved = { cookies: local, keyInfo: { source: 'data/doubao-auth.json' } }
    }
  }
  if (!resolved) {
    log('login', '无可用豆包 cookie，弹出登录窗口（可见）——请扫码/登录后点击「已完成登录」')
    const login = await openDoubaoLogin()
    if (!login.ok) {
      log('result', { ok: false, reason: '豆包登录未完成: ' + (login.error || '窗口关闭') })
      app.exit(0)
      return
    }
    try {
      const cookieStr = login.cookies.map((c) => c.name + '=' + c.value).join('; ')
      fs.writeFileSync(
        LOCAL_AUTH_FILE,
        JSON.stringify({ cookie: cookieStr, savedAt: new Date().toISOString() }, null, 2),
        'utf8'
      )
      log('login', '已保存 data/doubao-auth.json（' + login.cookies.length + ' 条 cookie），后续可复用')
    } catch (e) {
      log('warn', '保存 data/doubao-auth.json 失败: ' + (e instanceof Error ? e.message : String(e)))
    }
    resolved = { cookies: login.cookies, keyInfo: { source: 'login-window' } }
  }
  const { cookies, keyInfo } = resolved
  log('cookie-source', keyInfo)
  log('cookie-count', cookies.length)

  const ses = session.fromPartition(PARTITION)
  log('step', 'session-ready')
  ses.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36'
  )

  const captured = []
  const filter = { urls: ['https://www.doubao.com/*', 'https://*.doubao.com/*'] }
  try {
    fs.writeFileSync(CAPTURE_FILE, '')
  } catch {}
  const appendCapture = (entry) => {
    captured.push(entry)
    try {
      fs.appendFileSync(CAPTURE_FILE, JSON.stringify({ ts: Date.now(), ...entry }) + '\n')
    } catch {}
  }
  ses.webRequest.onBeforeRequest(filter, (d, cb) => {
    appendCapture({ t: 'req', method: d.method, url: d.url })
    cb({})
  })
  ses.webRequest.onCompleted(filter, (d) => {
    appendCapture({ t: 'res', status: d.statusCode, url: d.url })
  })
  log('step', 'capture-ready')

  let injected = 0
  for (let ci = 0; ci < cookies.length; ci++) {
    const c = cookies[ci]
    try {
      await ses.cookies.set({
        url: `${c.secure ? 'https' : 'http'}://${(c.domain || '').replace(/^\./, '')}${c.path || '/'}`,
        name: c.name,
        value: c.value,
        httpOnly: !!c.httpOnly,
        secure: !!c.secure,
        expirationDate: c.expires > 0 ? Math.floor(c.expires / 1000) : undefined
      })
      injected += 1
    } catch {
      // 单条失败不阻断
    }
    if (ci % 10 === 9) log('step', 'cookie-injected ' + (ci + 1) + '/' + cookies.length)
  }
  log('cookie-injected', injected + '/' + cookies.length)

  log('step', 'creating-hidden-window')
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      partition: PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) return { action: 'allow', overrideBrowserWindowOptions: { width: 560, height: 720 } }
    return { action: 'deny' }
  })

  // CDP 响应体抓取：在页面加载前挂上，捕获 chain/single、conversation/info、chat/completion 的响应体
  const reqUrls = new Map()
  try {
    const dbg = win.webContents.debugger
    dbg.attach('1.3')
    await Promise.race([
      dbg.sendCommand('Network.enable'),
      sleep(5000).then(() => {
        throw new Error('Network.enable 超时')
      })
    ])
    dbg.on('message', (_e, method, params) => {
      if (method === 'Network.responseReceived') {
        const u = params.response && params.response.url
        if (u && /chain\/single|conversation\/info|chat\/completion|recent_conv/.test(u)) {
          reqUrls.set(params.requestId, u)
        }
      } else if (method === 'Network.loadingFinished' && reqUrls.has(params.requestId)) {
        const url = reqUrls.get(params.requestId)
        reqUrls.delete(params.requestId)
        void dbg
          .sendCommand('Network.getResponseBody', { requestId: params.requestId })
          .then(({ body, base64Encoded }) => {
            try {
              const text = base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body
              const mp4s = (text.match(/https?:\\?\/\\?\/[^"'\\\s]+\.mp4[^"'\\\s]*/g) || []).slice(0, 5)
              const vids = (text.match(/https?:\\?\/\\?\/[^"'\\\s]*(video|vod)[^"'\\\s]*/g) || []).slice(0, 5)
              log('cdp-body', {
                url: url.slice(0, 120),
                len: text.length,
                mp4s,
                vids,
                hasVideoModel: /video_model|videoModel|video_url|videoUrl/.test(text),
                tail: text.slice(-300)
              })
            } catch {}
          })
          .catch(() => {})
      }
    })
    log('step', 'cdp-ready')
  } catch (e) {
    log('warn', 'CDP 附加失败: ' + (e instanceof Error ? e.message : String(e)))
  }

  let loadError = null
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    loadError = { code, desc, url }
  })
  log('step', 'loading-doubao')
  try {
    await Promise.race([
      win.loadURL(DOUBAO_URL),
      sleep(90000).then(() => {
        throw new Error('loadURL 90s 超时')
      })
    ])
  } catch (e) {
    loadError = { code: -1, desc: e instanceof Error ? e.message : String(e), url: DOUBAO_URL }
  }
  await sleep(4000)

  let inspect
  try {
    inspect = await win.webContents.executeJavaScript('(' + inspectScript.toString() + ')()', true)
  } catch (e) {
    inspect = { error: e instanceof Error ? e.message : String(e) }
  }
  log('inspect', inspect)
  if (loadError) log('load-error', loadError)

  if (!inspect.inputFound) {
    log('result', {
      ok: false,
      reason: '豆包页面未找到输入框，可能未登录（cookie 失效）或页面结构变化',
      inspect,
      captured: captured.slice(0, 30)
    })
    app.exit(0)
    return
  }

  try {
    await win.webContents.executeJavaScript('(' + netHookScript.toString() + ')()', true)
    log('step', 'net-hook-ready')
  } catch {
    log('warn', '注入网络钩子失败（不影响主流程）')
  }

  let netSeen = null
  let netBodies = null
  const noSend = process.env.QF_NO_SEND === '1'
  if (!noSend) {
    let videoTab
    try {
      videoTab = await win.webContents.executeJavaScript('(' + openVideoTabScript.toString() + ')()', true)
    } catch (e) {
      videoTab = { ok: false, reason: '执行打开视频页签脚本异常: ' + (e instanceof Error ? e.message : String(e)) }
    }
    log('video-tab', videoTab)
    await sleep(3000)
    let videoView
    try {
      videoView = await win.webContents.executeJavaScript('(' + inspectScript.toString() + ')()', true)
    } catch (e) {
      videoView = { error: e instanceof Error ? e.message : String(e) }
    }
    log('video-view', videoView)
    let videoDom
    try {
      videoDom = await win.webContents.executeJavaScript('(' + dumpDomScript.toString() + ')()', true)
    } catch (e) {
      videoDom = { error: e instanceof Error ? e.message : String(e) }
    }
    log('video-dom', videoDom)

    let sendResult
    try {
      sendResult = await win.webContents.executeJavaScript(
        '(' + autoSend.toString() + ')(' + JSON.stringify(PROMPT) + ')',
        true
      )
    } catch (e) {
      sendResult = { ok: false, reason: '执行自动发送脚本异常: ' + (e instanceof Error ? e.message : String(e)) }
    }
    log('auto-send', sendResult)
    try {
      const nr = await win.webContents.executeJavaScript(
        'window.__qfNet ? JSON.stringify({ws: window.__qfNet.ws.slice(0, 10), fetch: window.__qfNet.fetch.slice(0, 30), xhr: window.__qfNet.xhr.slice(0, 30)}) : null',
        true
      )
      netSeen = nr ? JSON.parse(nr) : null
    } catch {}
    if (netSeen) log('net-seen', netSeen)
    if (!sendResult.ok) {
      log('result', { ok: false, reason: sendResult.reason, inspect, captured: captured.slice(0, 30) })
      app.exit(0)
      return
    }
  } else {
    log('step', 'QF_NO_SEND=1：跳过提交，打开最近生成视频会话并轮询')
    await sleep(3000)
    try {
      const cr = await win.webContents.executeJavaScript('(' + openRecentConversationScript.toString() + ')()', true)
      log('open-conversation', cr)
    } catch (e) {
      log('warn', '打开最近会话失败: ' + (e instanceof Error ? e.message : String(e)))
    }
    await sleep(3000)
  }
  try {
    const br = await win.webContents.executeJavaScript(
      'window.__qfNet && window.__qfNet.bodies ? JSON.stringify(window.__qfNet.bodies.slice(-6)) : null',
      true
    )
    netBodies = br ? JSON.parse(br) : null
  } catch {}
  if (netBodies && netBodies.length) log('net-bodies', netBodies)

  let final = null
  let lastTextTail = ''
  let doneTicks = 0
  let cardClicked = false
  for (let i = 1; i <= MAX_POLLS; i++) {
    await sleep(5000)
    let r
    try {
      r = await win.webContents.executeJavaScript('(' + extractResultScript.toString() + ')()', true)
    } catch (e) {
      r = { error: e instanceof Error ? e.message : String(e) }
    }
    const video = r.vids && r.vids[0]
    const mp4 = r.mp4s && r.mp4s[0]
    const vurl = r.videoUrls && r.videoUrls[0]
    if (r.textTail) lastTextTail = r.textTail
    if (r.hasDone) {
      doneTicks += 1
      if (doneTicks >= 2 && !cardClicked && !video && !mp4 && !vurl) {
        cardClicked = true
        try {
          const cr = await win.webContents.executeJavaScript('(' + clickVideoCardScript.toString() + ')()', true)
          log('card-click', cr)
        } catch {
          log('warn', '点击视频卡片失败')
        }
      }
    } else {
      doneTicks = 0
    }
    log(
      'poll',
      i + '/' + MAX_POLLS +
        ' vids=' + (r.vids ? r.vids.length : 0) +
        ' mp4=' + (r.mp4s ? r.mp4s.length : 0) +
        ' vurl=' + (r.videoUrls ? r.videoUrls.length : 0) +
        ' pending=' + !!r.hasPending +
        ' done=' + !!r.hasDone
    )
    if (video && video.src) {
      final = {
        ok: true,
        videoUrl: video.src,
        posterUrl: video.poster || null,
        polls: i,
        prompt: PROMPT
      }
      break
    }
    if (mp4) {
      final = {
        ok: true,
        videoUrl: mp4,
        polls: i,
        prompt: PROMPT
      }
      break
    }
    if (vurl) {
      final = {
        ok: true,
        videoUrl: vurl,
        polls: i,
        prompt: PROMPT
      }
      break
    }
    if (r.hasDone && doneTicks >= 4 && !video && !mp4 && !vurl) {
      final = { ok: false, reason: '页面显示生成完成但未提取到视频 URL', poll: i, tail: r.textTail }
      break
    }
  }

  const apiCalls = captured.filter(
    (c) =>
      c.t === 'req' &&
      !/\.(js|css|png|jpe?g|gif|svg|woff2?|ttf|ico|webp)(\?|$)/i.test(c.url) &&
      (c.method !== 'GET' || /samantha|api\/|completion|async\/stream|v[0-9]+\//.test(c.url))
  )
  log(
    'result',
    final || {
      ok: false,
      reason: '轮询超时未取到视频 URL',
      polls: MAX_POLLS,
      tail: lastTextTail.slice(-300),
      net: netSeen,
      netBodies
    }
  )
  log('captured-api', apiCalls.slice(0, 60))
  log('captured-total', captured.length)
  log('capture-file', CAPTURE_FILE)
  app.exit(0)
}

app.whenReady().then(() => {
  main().catch((e) => {
    log('fatal', e instanceof Error ? e.stack || e.message : String(e))
    app.exit(2)
  })
})

// 兜底：总时长超过 MAX_SECONDS 强制退出
setTimeout(() => {
  log('fatal', '总时长超时，强制退出 (' + MAX_SECONDS + 's)')
  app.exit(3)
}, MAX_SECONDS * 1000)
