import { contextBridge, ipcRenderer } from 'electron'

export interface DesktopApi {
  versions: {
    electron: string
    chrome: string
    node: string
  }
  ping: () => Promise<string>
}

const api: DesktopApi = {
  versions: {
    electron: process.versions.electron ?? '',
    chrome: process.versions.chrome ?? '',
    node: process.versions.node ?? ''
  },
  ping: () => ipcRenderer.invoke('ping') as Promise<string>
}

contextBridge.exposeInMainWorld('api', api)

declare global {
  interface Window {
    api: DesktopApi
  }
}
