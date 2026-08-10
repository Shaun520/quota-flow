import { contextBridge, ipcRenderer } from 'electron'

export type ProviderId = 'yuanbao' | 'qwenwan'

export interface WebviewTestEvent {
  provider: ProviderId
  type: 'nav' | 'title' | 'fail' | 'log' | 'capture' | 'poll' | 'error'
  message: string
  data?: unknown
  ts: number
}

export interface AuthSessionTokens {
  accessToken: string
  refreshToken: string
  expiresAt: number
}

export interface ProviderLoginResult {
  ok: boolean
  canceled?: boolean
  encrypted?: string
  cookieCount?: number
  expiresAt?: number | null
  accountFingerprint?: string | null
  error?: string
}

export interface HealthCheckResult {
  ok: boolean
  status: string
  error?: string
}

export interface DesktopApi {
  versions: {
    electron: string
    chrome: string
    node: string
  }
  ping: () => Promise<string>
  auth: {
    getSession: () => Promise<AuthSessionTokens | null>
    setSession: (tokens: AuthSessionTokens) => Promise<void>
    clearSession: () => Promise<void>
  }
  providers: {
    login: (providerId: string) => Promise<ProviderLoginResult>
    encrypt: (providerId: string, plain: string) => Promise<{ encrypted: string; fingerprint?: string | null }>
    healthCheck: (providerId: string, encrypted: string) => Promise<HealthCheckResult>
    cancelLogin: (providerId: string) => Promise<void>
  }
  windowControls: {
    minimize: () => Promise<void>
    toggleMaximize: () => Promise<void>
    close: () => Promise<void>
    onMaximizeChange: (callback: (maximized: boolean) => void) => () => void
  }
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
  auth: {
    getSession: () => ipcRenderer.invoke('auth:get-session') as Promise<AuthSessionTokens | null>,
    setSession: (tokens) => ipcRenderer.invoke('auth:set-session', tokens) as Promise<void>,
    clearSession: () => ipcRenderer.invoke('auth:clear-session') as Promise<void>
  },
  providers: {
    login: (providerId) => ipcRenderer.invoke('provider:login', providerId) as Promise<ProviderLoginResult>,
    encrypt: (providerId, plain) =>
      ipcRenderer.invoke('provider:encrypt', providerId, plain) as Promise<{ encrypted: string; fingerprint?: string | null }>,
    healthCheck: (providerId, encrypted) =>
      ipcRenderer.invoke('provider:health-check', providerId, encrypted) as Promise<HealthCheckResult>,
    cancelLogin: (providerId) => ipcRenderer.invoke('provider:login-cancel', providerId) as Promise<void>
  },
  windowControls: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    onMaximizeChange: (callback) => {
      const listener = (_e: Electron.IpcRendererEvent, maximized: boolean): void =>
        callback(maximized)
      ipcRenderer.on('window:maximize-changed', listener)
      return () => {
        ipcRenderer.removeListener('window:maximize-changed', listener)
      }
    }
  },
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
  },
}

contextBridge.exposeInMainWorld('api', api)

declare global {
  interface Window {
    api: DesktopApi
  }
}
