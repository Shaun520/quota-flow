import { contextBridge, ipcRenderer } from 'electron'

export type ProviderId = 'yuanbao' | 'qwenwan'

export interface WebviewTestEvent {
  provider: ProviderId
  type: 'nav' | 'title' | 'fail' | 'log' | 'capture' | 'poll' | 'error'
  message: string
  data?: unknown
  ts: number
}

export interface DesktopApi {
  versions: {
    electron: string
    chrome: string
    node: string
  }
  ping: () => Promise<string>
  webviewTest: {
    open: (provider: ProviderId) => Promise<{ ok: boolean; message: string }>
    close: (provider: ProviderId) => Promise<void>
    injectCookies: (
      provider: ProviderId
    ) => Promise<{ injected: number; total: number; errors: string[] }>
    autoSend: (provider: ProviderId, prompt: string) => Promise<{ ok: boolean; reason: string }>
    inspect: (
      provider: ProviderId
    ) => Promise<{
      inputFound: boolean
      inputTag: string
      candidates: Array<{
        tag: string
        cls: string
        aria: string
        title: string
        text: string
        disabled: boolean
        svg: boolean
      }>
    }>
    openDevTools: (provider: ProviderId) => Promise<void>
    poll: (
      provider: ProviderId
    ) => Promise<{ ok: boolean; videoUrl?: string; posterUrl?: string; error?: string }>
    onEvent: (callback: (event: WebviewTestEvent) => void) => () => void
  }
}

const api: DesktopApi = {
  versions: {
    electron: process.versions.electron ?? '',
    chrome: process.versions.chrome ?? '',
    node: process.versions.node ?? ''
  },
  ping: () => ipcRenderer.invoke('ping') as Promise<string>,
  webviewTest: {
    open: (provider) => ipcRenderer.invoke('webview-test:open', provider),
    close: (provider) => ipcRenderer.invoke('webview-test:close', provider),
    injectCookies: (provider) => ipcRenderer.invoke('webview-test:inject-cookies', provider),
    autoSend: (provider, prompt) => ipcRenderer.invoke('webview-test:auto-send', provider, prompt),
    inspect: (provider) => ipcRenderer.invoke('webview-test:inspect', provider),
    openDevTools: (provider) => ipcRenderer.invoke('webview-test:open-devtools', provider),
    poll: (provider) => ipcRenderer.invoke('webview-test:poll', provider),
    onEvent: (callback) => {
      const listener = (_e: Electron.IpcRendererEvent, event: WebviewTestEvent): void =>
        callback(event)
      ipcRenderer.on('webview-test:event', listener)
      return () => {
        ipcRenderer.removeListener('webview-test:event', listener)
      }
    }
  }
}

contextBridge.exposeInMainWorld('api', api)

declare global {
  interface Window {
    api: DesktopApi
  }
}
