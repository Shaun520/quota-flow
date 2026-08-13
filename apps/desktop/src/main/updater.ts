import { app } from 'electron'
import { autoUpdater } from 'electron-updater'

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

  autoUpdater.autoDownload = true
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
      error: err instanceof Error ? err.message : String(err)
    })
  })

  if (app.isPackaged) {
    setTimeout(() => {
      void checkForUpdatesNow(sendStatus)
    }, 3000)
  }
}

export async function checkForUpdatesNow(sendStatus: (status: UpdaterStatus) => void): Promise<UpdaterStatus> {
  setStatus(sendStatus, { state: 'checking' })
  try {
    await autoUpdater.checkForUpdates()
    return getUpdaterStatus()
  } catch (err) {
    const status: UpdaterStatus = {
      state: 'error',
      error: err instanceof Error ? err.message : String(err)
    }
    setStatus(sendStatus, status)
    return status
  }
}

export function quitAndInstall(): void {
  autoUpdater.quitAndInstall()
}
