// 真实项目代码运行器：直接调用编译后的 webview-engine.ts 的 runDoubaoGeneration
// 前置：esbuild 编译 src/main/webview-engine.ts → $TEMP/qf-real-engine.cjs（或 QF_ENGINE 指定）
// 运行：cd apps/desktop && npx --no-install electron scripts/run-real-engine.cjs
// QF_PART_ID=分区 keyId；QF_BASE=1 使用 base 分区（默认 c97a9b3f-...）
// QF_PROMPT；QF_DURATION=5|10；QF_MAX_WAIT=秒
// QF_SOFTWARE=0 关闭软件渲染模拟（默认 1，匹配 App）

const { app, session } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')

const PART_ID = process.env.QF_PART_ID || 'c97a9b3f-059d-4189-be3d-240e1fc48ad0'
const APP_UD = path.join(process.env.APPDATA || '', '@quota-flow', 'desktop')
const USE_BASE = process.env.QF_BASE === '1'
const PART_DIR = USE_BASE ? 'qf-p%3Adoubao' : 'qf-p%3Adoubao%3A' + PART_ID
const ENGINE = process.env.QF_ENGINE || path.join(process.env.TEMP || '.', 'qf-real-engine.cjs')
const PROMPT = process.env.QF_PROMPT || '真实代码跑通测试：一只白猫在窗台晒太阳'
const DURATION = Number(process.env.QF_DURATION || 5)
const MAX_WAIT = Number(process.env.QF_MAX_WAIT || 240)
const SHOW_WEBVIEW = process.env.QF_SHOW_WEBVIEW === '1'

if (process.env.QF_SOFTWARE !== '0') {
  app.disableHardwareAcceleration()
}

function log(k, v) {
  const line = '[' + k + '] ' + (typeof v === 'string' ? v : JSON.stringify(v, null, 0))
  console.log(line)
  try {
    fs.appendFileSync(path.join(process.env.TEMP || '.', 'qf-real-run.log'), new Date().toISOString() + ' ' + line + '\n')
  } catch {}
}

function copyRecursive(src, dst) {
  fs.mkdirSync(dst, { recursive: true })
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name)
    const d = path.join(dst, e.name)
    if (e.isDirectory()) copyRecursive(s, d)
    else {
      try {
        fs.copyFileSync(s, d)
      } catch {}
    }
  }
}

app.whenReady().then(async () => {
  if (!fs.existsSync(ENGINE)) {
    log('fatal', '找不到编译引擎: ' + ENGINE)
    app.exit(2)
    return
  }
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'qf-real-'))
  copyRecursive(path.join(APP_UD, 'Partitions', PART_DIR), path.join(ud, 'Partitions', PART_DIR))
  try {
    fs.copyFileSync(path.join(APP_UD, 'Local State'), path.join(ud, 'Local State'))
  } catch {}
  app.setPath('userData', ud)
  log('userData', ud)
  log('config', { partition: PART_DIR, prompt: PROMPT, duration: DURATION, maxWait: MAX_WAIT, engine: ENGINE })

  const cookiesFile = path.join(ud, 'Partitions', PART_DIR, 'Network', 'Cookies')
  if (!fs.existsSync(cookiesFile)) {
    log('result', { ok: false, error: '分区 cookie 复制失败（App 可能仍在运行，请先退出 App）' })
    app.exit(2)
    return
  }
  log('cookie-copied', fs.statSync(cookiesFile).size)

  // 网络钩子：记录 /chat/completion 请求与响应码
  const partition = USE_BASE ? 'persist:qf-p:doubao' : 'persist:qf-p:doubao:' + PART_ID
  const ses = session.fromPartition(partition)
  const netLog = []
  ses.webRequest.onBeforeRequest({ urls: ['https://www.doubao.com/*'] }, (d, cb) => {
    if (/chat\/completion|samantha|async/.test(d.url)) {
      netLog.push({ t: 'req', url: d.url.slice(0, 160), at: Date.now() })
    }
    cb({})
  })
  ses.webRequest.onCompleted({ urls: ['https://www.doubao.com/*'] }, (d) => {
    if (/chat\/completion|samantha|async/.test(d.url)) {
      netLog.push({ t: 'res', status: d.statusCode, url: d.url.slice(0, 160), at: Date.now() })
    }
  })

  const { runDoubaoGeneration } = require(ENGINE)
  try {
    const result = await runDoubaoGeneration({
      cookies: [], // 分区自带登录会话，无需注入
      localStorage: [],
      storages: [],
      prompt: PROMPT,
      durationSec: DURATION,
      maxWaitSec: MAX_WAIT,
      keyId: USE_BASE ? undefined : PART_ID,
      showWebview: SHOW_WEBVIEW,
      onProgress: (stage, detail) =>
        log('progress', { stage, detail: detail !== undefined ? JSON.stringify(detail).slice(0, 300) : null })
    })
    log('result', result)
    log('net', netLog)
  } catch (e) {
    log('result', { ok: false, error: e instanceof Error ? e.stack || e.message : String(e) })
  }
  app.exit(0)
})

setTimeout(() => {
  log('fatal', '总时长超时')
  app.exit(3)
}, (MAX_WAIT + 120) * 1000)
