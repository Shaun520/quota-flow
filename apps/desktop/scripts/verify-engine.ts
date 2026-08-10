// 引擎集成验证：直接调用 webview-engine 跑一次 5s 豆包生成
// 验证：时长选择 5s、prompt 清理（编辑器内容 === prompt）、取 URL、下载落盘
import { app } from 'electron'
import { createWriteStream, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { get as httpsGet } from 'node:https'
import { join } from 'node:path'
import { runDoubaoGeneration } from '../src/main/webview-engine'

const LOG_FILE = join(process.env.TEMP || '.', 'qf-engine-verify.log')

function log(k: string, v: unknown): void {
  const line = '[' + k + '] ' + (typeof v === 'string' ? v : JSON.stringify(v))
  console.log(line)
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('node:fs').appendFileSync(LOG_FILE, new Date().toISOString() + ' ' + line + '\n')
  } catch {}
}

function loadCookies(): Array<{ name: string; value: string; domain?: string; path?: string; secure?: boolean }> {
  const file = 'D:/project/quota-flow/data/doubao-auth.json'
  const raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
  const auth = JSON.parse(raw) as { cookie?: string }
  const cookies: Array<{ name: string; value: string; domain?: string; path?: string; secure?: boolean }> = []
  for (const part of (auth.cookie || '').split(';')) {
    const p = part.trim()
    const idx = p.indexOf('=')
    if (idx <= 0) continue
    const name = p.slice(0, idx).trim()
    const value = p.slice(idx + 1).trim()
    if (name && value) cookies.push({ name, value, domain: '.doubao.com', path: '/', secure: true })
  }
  return cookies
}

function download(url: string, jobId: string, redirects = 0): Promise<string | null> {
  return new Promise((resolve) => {
    if (redirects > 4) {
      resolve(null)
      return
    }
    const dir = join(app.getPath('userData'), 'videos')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, jobId + '.mp4')
    const tmp = file + '.part'
    const out = createWriteStream(tmp)
    let size = 0
    let settled = false
    const finish = (ok: boolean, path: string | null): void => {
      if (settled) return
      settled = true
      try {
        out.destroy()
      } catch {}
      resolve(ok ? path : null)
    }
    const req = httpsGet(
      url,
      { headers: { 'User-Agent': 'Mozilla/5.0', Accept: '*/*', Referer: 'https://www.doubao.com/' } },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume()
          void download(res.headers.location, jobId, redirects + 1).then((p) => finish(!!p, p))
          return
        }
        if (!res.statusCode || res.statusCode !== 200) {
          res.resume()
          finish(false, null)
          return
        }
        res.on('data', (c: Buffer) => {
          size += c.length
        })
        res.pipe(out)
      }
    )
    req.on('error', () => finish(false, null))
    req.setTimeout(90000, () => {
      req.destroy()
      finish(false, null)
    })
    out.on('finish', () => {
      if (size > 1024) {
        try {
          require('node:fs').renameSync(tmp, file)
          finish(true, file)
        } catch {
          finish(false, null)
        }
      } else {
        finish(false, null)
      }
    })
    out.on('error', () => finish(false, null))
  })
}

app.whenReady().then(async () => {
  try {
    const cookies = loadCookies()
    log('cookies', cookies.length)
    const result = await runDoubaoGeneration({
      cookies,
      prompt: '一只橘猫在窗台上晒太阳，微风吹动窗帘',
      durationSec: 5,
      maxWaitSec: 360,
      onProgress: (stage, detail) => log('stage', { stage, detail })
    })
    log('result', result)
    if (result.ok && result.videoUrl) {
      const local = await download(result.videoUrl, 'engine-verify-' + Date.now())
      log('download', local ? { ok: true, path: local } : { ok: false })
    }
  } catch (e) {
    log('fatal', e instanceof Error ? e.stack || e.message : String(e))
  }
  app.exit(0)
})

setTimeout(() => {
  log('fatal', '总时长超时')
  app.exit(3)
}, 7 * 60 * 1000)
