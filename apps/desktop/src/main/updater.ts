import { app } from 'electron'
import { autoUpdater, type UpdateCheckResult } from 'electron-updater'

const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000
const UPDATE_CHECK_TIMEOUT_MS = 20_000

export type UpdaterState =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'not-available'
  | 'error'

export interface UpdaterStatus {
  state: UpdaterState
  version?: string
  progress?: number
  error?: string
}

let lastStatus: UpdaterStatus = { state: 'idle' }
let initialized = false
let checkPromise: Promise<UpdaterStatus> | null = null

function updaterErrorText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  const lower = message.toLowerCase()

  if (lower.includes('404') || lower.includes('not found') || lower.includes('cannot find latest.yml')) {
    return '没有找到可更新的发布版本，请确认 GitHub Releases 已上传安装包和 latest.yml'
  }

  if (
    lower.includes('latest version on github') ||
    lower.includes('no published versions') ||
    lower.includes('err_updater_latest_version_not_found')
  ) {
    return '无法访问 GitHub 最新发布信息，请检查网络或确认 Release 已正式发布'
  }

  if (
    lower.includes('enetdown') ||
    lower.includes('econnrefused') ||
    lower.includes('econnreset') ||
    lower.includes('getaddrinfo') ||
    lower.includes('timeout')
  ) {
    return '无法连接更新服务器，请检查网络后重试'
  }

  if (message.includes('检查更新超时')) {
    return message
  }

  return message || '检查更新失败'
}

function setStatus(sendStatus: (status: UpdaterStatus) => void, status: UpdaterStatus): void {
  lastStatus = status
  sendStatus(status)
}

export function getUpdaterStatus(): UpdaterStatus {
  return lastStatus
}

export function initAutoUpdater(sendStatus: (status: UpdaterStatus) => void): void {
  if (initialized) return
  initialized = true

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => {
    setStatus(sendStatus, { state: 'checking' })
  })
  autoUpdater.on('update-available', (info) => {
    setStatus(sendStatus, { state: 'available', version: info.version })
  })
  autoUpdater.on('update-not-available', (info) => {
    setStatus(sendStatus, { state: 'not-available', version: info.version })
  })
  autoUpdater.on('download-progress', (progress) => {
    setStatus(sendStatus, { state: 'downloading', progress: progress.percent })
  })
  autoUpdater.on('update-downloaded', (info) => {
    setStatus(sendStatus, { state: 'downloaded', version: info.version })
  })
  autoUpdater.on('error', (err) => {
    setStatus(sendStatus, {
      state: 'error',
      error: updaterErrorText(err)
    })
  })

  if (app.isPackaged) {
    setTimeout(() => {
      void checkForUpdatesNow(sendStatus)
    }, 3000)
    setInterval(() => {
      void checkForUpdatesNow(sendStatus)
    }, UPDATE_CHECK_INTERVAL_MS)
  }
}

export async function checkForUpdatesNow(sendStatus: (status: UpdaterStatus) => void): Promise<UpdaterStatus> {
  if (checkPromise) return checkPromise

  checkPromise = doCheckForUpdatesNow(sendStatus).finally(() => {
    checkPromise = null
  })
  return checkPromise
}

async function doCheckForUpdatesNow(sendStatus: (status: UpdaterStatus) => void): Promise<UpdaterStatus> {
  if (!app.isPackaged) {
    const status: UpdaterStatus = {
      state: 'error',
      error: '当前为开发模式，未启用自动更新检查，请运行打包安装版验证'
    }
    setStatus(sendStatus, status)
    return status
  }

  setStatus(sendStatus, { state: 'checking' })
  try {
    const result = await Promise.race([
      autoUpdater.checkForUpdates(),
      new Promise<null>((_, reject) => {
        setTimeout(() => reject(new Error('检查更新超时，请稍后重试')), UPDATE_CHECK_TIMEOUT_MS)
      })
    ])

    if (!result) {
      const status: UpdaterStatus = {
        state: 'error',
        error: app.isPackaged
          ? '未找到更新配置，请确认安装包内包含 app-update.yml'
          : '当前为开发模式，未启用自动更新检查，请运行打包安装版验证'
      }
      setStatus(sendStatus, status)
      return status
    }

    if (!result.isUpdateAvailable) {
      setStatus(sendStatus, { state: 'not-available', version: result.updateInfo.version })
      return getUpdaterStatus()
    }

    setStatus(sendStatus, { state: 'available', version: result.updateInfo.version })
    return getUpdaterStatus()
  } catch (err) {
    const status: UpdaterStatus = {
      state: 'error',
      error: updaterErrorText(err)
    }
    setStatus(sendStatus, status)
    return status
  }
}

export async function downloadUpdate(sendStatus: (status: UpdaterStatus) => void): Promise<UpdaterStatus> {
  setStatus(sendStatus, { state: 'downloading', progress: 0 })
  try {
    await autoUpdater.downloadUpdate()
    return getUpdaterStatus()
  } catch (err) {
    const status: UpdaterStatus = {
      state: 'error',
      error: updaterErrorText(err)
    }
    setStatus(sendStatus, status)
    return status
  }
}

export function quitAndInstall(): void {
  autoUpdater.quitAndInstall()
}
