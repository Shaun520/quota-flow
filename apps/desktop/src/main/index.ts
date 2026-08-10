import { app, BrowserWindow, ipcMain, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { initWebviewTest } from './webview-test'
import { initProviders } from './providers'

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
  initProviders()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
