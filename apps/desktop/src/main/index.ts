import { app, BrowserWindow, ipcMain, safeStorage, shell } from 'electron'
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import type { AddressInfo } from 'node:net'
import { initWebviewTest } from './webview-test'
import { initProviders } from './providers'
import { runGenerate } from './dispatch'
import type { DispatchEvent } from './dispatch'

// 本地视频预览服务：127.0.0.1 随机端口，仅提供 userData/videos 下 <uuid>.mp4，支持 Range
let mediaPortPromise: Promise<number> | null = null

function startMediaServer(): Promise<number> {
  if (!mediaPortPromise) {
    mediaPortPromise = new Promise((resolve, reject) => {
      const videosDir = join(app.getPath('userData'), 'videos')
      const server = createServer((req, res) => {
        const name = (req.url || '').split('?')[0].replace(/^\//, '')
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
    backgroundColor: '#f5f1e8',
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
    return runGenerate(input, emit)
  })
  initProviders()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
