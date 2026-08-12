import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from 'electron'
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import type { AddressInfo } from 'node:net'
import { initWebviewTest } from './webview-test'
import { initProviders } from './providers'
import { initCookieRenew } from './cookie-renew'
import { runGenerate } from './dispatch'
import type { DispatchEvent } from './dispatch'

/** 活跃生成任务注册表：jobId → 取消/已提交状态（用于「终止生成」与「关闭确认」） */
interface ActiveRunState {
  aborted: boolean
  submitted: boolean
}
const activeRuns = new Map<string, ActiveRunState>()
let allowClose = false
/** 是否有生成在跑（含任务注册前的准备窗口） */
let isGenerating = false
/** 任务注册前用户已点停止 → 注册后立即置 aborted */
let pendingCancel = false
import { createSupabaseClient, JobService, ProviderService, todayKey } from '@quota-flow/db-supabase'

// 禁用 GPU 硬件加速：Windows 上 Chromium 合成器在频繁重绘（如快速点击 tab 切换页面）时
// 偶发丢帧/显示旧缓冲，导致整窗"时不时闪一下"。切到软件合成可根治。
// 必须在 app ready 之前调用。
app.disableHardwareAcceleration()

// 本地媒体预览服务：127.0.0.1 随机端口
//  - 根路径：userData/videos 下 <uuid>.mp4（视频，支持 Range）
//  - /images/：userData/images 下 <jobId>-<n>.<ext>（图生视频上传的图片副本）
let mediaPortPromise: Promise<number> | null = null

function startMediaServer(): Promise<number> {
  if (!mediaPortPromise) {
    mediaPortPromise = new Promise((resolve, reject) => {
      const videosDir = join(app.getPath('userData'), 'videos')
      const imagesDir = join(app.getPath('userData'), 'images')
      const server = createServer((req, res) => {
        const path = (req.url || '').split('?')[0]
        if (path.startsWith('/images/')) {
          const name = path.slice('/images/'.length)
          if (!/^[0-9a-fA-F-]+-\d+\.(png|jpe?g|gif|webp)$/i.test(name)) {
            res.writeHead(400)
            res.end()
            return
          }
          const file = join(imagesDir, name)
          if (!existsSync(file)) {
            res.writeHead(404)
            res.end()
            return
          }
          const ext = (name.split('.').pop() || 'jpg').toLowerCase()
          const type =
            ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/jpeg'
          res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' })
          createReadStream(file).pipe(res)
          return
        }
        const name = path.replace(/^\//, '')
        if (!/^[0-9a-fA-F-]+\.mp4$/.test(name)) {
          res.writeHead(400)
          res.end()
          return
        }
        const file = join(videosDir, name)
        if (!existsSync(file)) {
          res.writeHead(404)
          res.end()
          return
        }
        const size = statSync(file).size
        res.setHeader('Content-Type', 'video/mp4')
        res.setHeader('Accept-Ranges', 'bytes')
        const range = req.headers.range
        if (range) {
          const m = /bytes=(\d*)-(\d*)/.exec(range)
          const start = m && m[1] ? parseInt(m[1], 10) : 0
          const end = m && m[2] ? parseInt(m[2], 10) : size - 1
          res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${size}`,
            'Content-Length': end - start + 1
          })
          createReadStream(file, { start, end }).pipe(res)
        } else {
          res.writeHead(200, { 'Content-Length': size })
          createReadStream(file).pipe(res)
        }
      })
      server.on('error', reject)
      server.listen(0, '127.0.0.1', () => {
        resolve((server.address() as AddressInfo).port)
      })
    })
  }
  return mediaPortPromise
}

interface StoredSession {
  accessToken: string
  refreshToken: string
  expiresAt: number
}

function sessionFilePath(): string {
  return join(app.getPath('userData'), 'auth.json')
}

function readStoredSession(): StoredSession | null {
  try {
    const file = sessionFilePath()
    if (!existsSync(file) || !safeStorage.isEncryptionAvailable()) return null
    const json = safeStorage.decryptString(
      Buffer.from(readFileSync(file, 'utf8'), 'base64')
    )
    const session = JSON.parse(json) as StoredSession
    if (typeof session.accessToken !== 'string' || typeof session.refreshToken !== 'string') {
      return null
    }
    return session
  } catch {
    return null
  }
}

function writeStoredSession(session: StoredSession): void {
  if (!safeStorage.isEncryptionAvailable()) return
  mkdirSync(app.getPath('userData'), { recursive: true })
  const encrypted = safeStorage.encryptString(JSON.stringify(session))
  writeFileSync(sessionFilePath(), encrypted.toString('base64'), 'utf8')
}

function clearStoredSession(): void {
  try {
    rmSync(sessionFilePath(), { force: true })
  } catch {
    // ignore
  }
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 1120,
    minHeight: 700,
    show: false,
    frame: false,
    icon: join(__dirname, '../renderer/icon.png'),
    // 与页面默认 dark 主题背景一致（styles.css [data-theme="dark"] --bg-base: #0c0c0c），
    // 避免点击重绘时露出浅色背景导致整窗闪烁
    backgroundColor: '#0c0c0c',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  win.on('ready-to-show', () => win.show())
  win.on('maximize', () => win.webContents.send('window:maximize-changed', true))
  win.on('unmaximize', () => win.webContents.send('window:maximize-changed', false))
  // 生成进行中关闭 → 弹确认框，避免误关导致生成意外中断
  win.on('close', (e) => {
    if (allowClose || activeRuns.size === 0) return
    e.preventDefault()
    void dialog
      .showMessageBox(win, {
        type: 'warning',
        title: '视频正在生成',
        message: '当前有视频正在生成，关闭应用将中断生成。确定要关闭吗？',
        buttons: ['取消', '确认关闭'],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      })
      .then(({ response }) => {
        if (response === 1) {
          allowClose = true
          win.close()
        }
      })
  })
  initWebviewTest(win)

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  void startMediaServer()
  ipcMain.handle('media:get-url', async (_e, name: unknown) => {
    if (typeof name !== 'string' || !/^[0-9a-fA-F-]+\.mp4$/.test(name)) {
      throw new Error('invalid media name')
    }
    const port = await startMediaServer()
    return `http://127.0.0.1:${port}/${name}`
  })

  ipcMain.handle('media:get-image-url', async (_e, name: unknown) => {
    if (typeof name !== 'string' || !/^[0-9a-fA-F-]+-\d+\.(png|jpe?g|gif|webp)$/i.test(name)) {
      throw new Error('invalid image name')
    }
    const port = await startMediaServer()
    return `http://127.0.0.1:${port}/images/${name}`
  })

  ipcMain.handle('media:show-in-folder', (_e, filePath: unknown) => {
    if (typeof filePath !== 'string' || !filePath) throw new Error('invalid path')
    // 只允许打开 userData/videos 下的文件，避免 renderer 被诱导打开任意路径
    const videosDir = join(app.getPath('userData'), 'videos')
    const resolved = resolve(filePath)
    const dir = videosDir.toLowerCase()
    const target = resolved.toLowerCase()
    const inVideos =
      target === dir || target.startsWith(dir + '\\') || target.startsWith(dir + '/')
    if (!inVideos) throw new Error('path outside videos directory')
    if (!existsSync(resolved)) return { ok: false, error: '视频文件不存在' }
    shell.showItemInFolder(resolved)
    return { ok: true }
  })

  ipcMain.handle('ping', () => 'pong')
  ipcMain.handle('window:minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize())
  ipcMain.handle('window:toggle-maximize', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.handle('window:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close())
  ipcMain.handle('auth:get-session', () => readStoredSession())
  ipcMain.handle('auth:set-session', (_e, session: StoredSession) => {
    if (!session || typeof session.accessToken !== 'string' || typeof session.refreshToken !== 'string') {
      throw new Error('invalid session payload')
    }
    writeStoredSession({
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      expiresAt: typeof session.expiresAt === 'number' ? session.expiresAt : 0
    })
  })
  ipcMain.handle('auth:clear-session', () => clearStoredSession())
  ipcMain.handle('dispatch:generate', async (e, input: Parameters<typeof runGenerate>[0]) => {
    const emit = (ev: DispatchEvent): void => {
      if (!e.sender.isDestroyed()) e.sender.send('job:event', ev)
    }
    let registeredJobId: string | null = null
    isGenerating = true
    pendingCancel = false
    try {
      return await runGenerate(input, emit, (jobId, state) => {
        registeredJobId = jobId
        activeRuns.set(jobId, state)
        // 准备窗口用户已点停止 → 任务一注册立即标记取消
        if (pendingCancel) state.aborted = true
        pendingCancel = false
      })
    } catch (err) {
      // 主进程抛出任意值（如 Supabase PostgrestError 对象）时规范化为可读信息，
      // 避免 Electron 序列化成 [object Object] 导致 UI 看不到真实原因
      const msg =
        err instanceof Error
          ? err.message
          : err && typeof err === 'object'
            ? String((err as { message?: unknown }).message ?? JSON.stringify(err))
            : String(err)
      throw new Error(msg || '生成失败（未知错误）')
    } finally {
      if (registeredJobId) activeRuns.delete(registeredJobId)
      isGenerating = false
      pendingCancel = false
    }
  })

  ipcMain.handle('dispatch:cancel', (_e, jobId: unknown) => {
    // 优先按 jobId 定位；未匹配时回退到当前唯一活跃任务（渲染层事件丢失时也能停）
    let state: ActiveRunState | undefined
    if (typeof jobId === 'string' && jobId && activeRuns.has(jobId)) {
      state = activeRuns.get(jobId)
    } else if (activeRuns.size === 1) {
      const only = activeRuns.keys().next().value as string
      state = activeRuns.get(only)
    } else if (activeRuns.size > 1) {
      return { ok: false, reason: '存在多个进行中的任务，请稍后再试' }
    }
    if (!state) {
      // 生成已开始但任务尚未注册（准备窗口）→ 记待取消，注册后立即生效
      if (isGenerating) {
        pendingCancel = true
        return { ok: true }
      }
      return { ok: false, reason: '任务不存在或已结束' }
    }
    if (state.submitted) return { ok: false, reason: '提示词已发送，无法终止', submitted: true }
    state.aborted = true
    return { ok: true }
  })

  // reconciliation：启动时恢复崩溃残留 + 追记账本
  ipcMain.handle('dispatch:reconcile', async (
    _e,
    params: { supabaseUrl: string; supabaseAnonKey: string; accessToken: string; refreshToken: string; userId: string }
  ) => {
    try {
      const client = createSupabaseClient({
        supabaseUrl: params.supabaseUrl,
        supabaseAnonKey: params.supabaseAnonKey
      })
      await client.auth.setSession({ access_token: params.accessToken, refresh_token: params.refreshToken })
      const jobSvc = new JobService(client)
      const providerSvc = new ProviderService(client)
      let recovered = false

      // 1. 恢复崩溃残留：上次会话遗留的 pending/running → 标记「意外中断」（不做自动恢复）
      const { data: stuckJobs } = await client
        .from('jobs')
        .select('id, created_at')
        .eq('user_id', params.userId)
        .in('status', ['pending', 'running'])
        .order('created_at', { ascending: false })
        .limit(20)
      for (const j of (stuckJobs ?? [])) {
        await jobSvc.updateJob(params.userId, j.id, {
          status: 'interrupted',
          error: '应用意外退出，生成中断',
          completedAt: new Date().toISOString()
        })
        recovered = true
      }

      // 2. 追记未入账的成功任务（单 RPC 原子：检查→扣减→finalize 同一事务）
      const unfinalized = await providerSvc.findUnfinalizedJobs(params.userId)
      for (const u of unfinalized) {
        try {
          const { data, error } = await client.rpc('reconcile_consume_and_finalize', {
            p_user_id: params.userId,
            p_provider_id: 'doubao',
            p_amount: u.costAmount,
            p_key_id: u.keyId,
            p_date: todayKey(),
            p_job_id: u.jobId
          })
          if (error) throw error
          const result = data as unknown as { ok: boolean; code?: string }
          if (result.ok && result.code !== 'ALREADY_FINALIZED') {
            recovered = true
          }
        } catch {
          // RPC 整体失败（网络/DB 异常）→ 事务回滚，额度未扣 → 下次 reconcile 重试安全
        }
      }

      return { ok: true, recovered }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })
  initProviders()
  initCookieRenew()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
