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

export interface JobEvent {
  jobId: string
  status?: string
  stage?: string
  message?: string
  data?: unknown
}

export interface GenerateRequest {
  supabaseUrl: string
  supabaseAnonKey: string
  accessToken: string
  refreshToken: string
  userId: string
  prompt: string
  providerId: string
  durationSec: number
  mode?: string
  resolution?: string
  audio?: string
  ratio?: string
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
    /**
     * 打开登录窗口
     * @param providerId 厂商 id（doubao / jimeng 等）
     * @param keyId 可选：账号 key id。传入后登录分区与生成分区共用（persist:qf-p:<provider>:<keyId>），避免跨分区迁移会话
     */
    login: (providerId: string, keyId?: string) => Promise<ProviderLoginResult>
    encrypt: (providerId: string, plain: string) => Promise<{ encrypted: string; fingerprint?: string | null }>
    /**
     * 健康检查
     * @param keyId 可选：账号级 partition（与生成分区一致），用于在生成分区直接检查健康状态
     */
    healthCheck: (providerId: string, encrypted: string, keyId?: string) => Promise<HealthCheckResult>
    /**
     * 取消登录窗口
     * @param keyId 可选：对应 login 传入的 keyId，关闭同一账号的登录窗口
     */
    cancelLogin: (providerId: string, keyId?: string) => Promise<void>
    /**
     * 迁移分区：把 src 分区的 cookie 复制到 dst 分区（用于刷新已有账号时把临时分区登录态迁移到目标分区）
     */
    migratePartition: (providerId: string, srcKeyId: string, dstKeyId: string) => Promise<{ ok: boolean; cookieCount?: number; error?: string }>
  }
  dispatch: {
    generate: (input: GenerateRequest) => Promise<{ ok: boolean; jobId?: string; error?: string }>
    onEvent: (callback: (event: JobEvent) => void) => () => void
  }
  media: {
    getUrl: (name: string) => Promise<string>
    showInFolder: (filePath: string) => Promise<{ ok: boolean; error?: string }>
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
    login: (providerId, keyId) =>
      ipcRenderer.invoke('provider:login', providerId, keyId) as Promise<ProviderLoginResult>,
    encrypt: (providerId, plain) =>
      ipcRenderer.invoke('provider:encrypt', providerId, plain) as Promise<{ encrypted: string; fingerprint?: string | null }>,
    healthCheck: (providerId, encrypted, keyId) =>
      ipcRenderer.invoke('provider:health-check', providerId, encrypted, keyId) as Promise<HealthCheckResult>,
    cancelLogin: (providerId, keyId) =>
      ipcRenderer.invoke('provider:login-cancel', providerId, keyId) as Promise<void>,
    migratePartition: (providerId, srcKeyId, dstKeyId) =>
      ipcRenderer.invoke('provider:migrate-partition', providerId, srcKeyId, dstKeyId) as Promise<{ ok: boolean; cookieCount?: number; error?: string }>
  },
  dispatch: {
    generate: (input) => ipcRenderer.invoke('dispatch:generate', input) as Promise<{ ok: boolean; jobId?: string; error?: string }>,
    onEvent: (callback) => {
      const listener = (_e: Electron.IpcRendererEvent, event: JobEvent): void => callback(event)
      ipcRenderer.on('job:event', listener)
      return () => {
        ipcRenderer.removeListener('job:event', listener)
      }
    }
  },
  media: {
    getUrl: (name) => ipcRenderer.invoke('media:get-url', name) as Promise<string>,
    showInFolder: (filePath) =>
      ipcRenderer.invoke('media:show-in-folder', filePath) as Promise<{ ok: boolean; error?: string }>
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
