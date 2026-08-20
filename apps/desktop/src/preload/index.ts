import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { QuotaLedgerRow } from '@quota-flow/db-supabase'

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

export interface CookieRenewState {
  enabled: boolean
  running: boolean
  lastRunAt: number | null
  nextRunAt: number | null
  lastResult: { ok: boolean; renewed: number; failed: number; message?: string } | null
}

export interface CookieRenewConfig {
  supabaseUrl: string
  supabaseAnonKey: string
  accessToken: string
  refreshToken: string
  userId: string
}

export interface JobEvent {
  jobId: string
  status?: string
  stage?: string
  message?: string
  data?: unknown
}

export type WatermarkStatus = 'none' | 'pending' | 'processing' | 'done' | 'failed' | 'needs_bbox' | 'cancelled'

export interface WatermarkProgress {
  jobId: string
  stage: 'detect' | 'ffmpeg' | 'inpaint' | 'done' | 'failed' | 'cancelled'
  progress: number
  message?: string
}

export interface WatermarkProcessInput {
  supabaseUrl: string
  supabaseAnonKey: string
  accessToken: string
  refreshToken: string
  userId: string
  jobId: string
  bbox?: { x: number; y: number; width: number; height: number } | null
  bboxes?: Array<{ x: number; y: number; width: number; height: number }> | null
}

export interface WatermarkProcessResult {
  ok: boolean
  outputPath?: string
  bbox?: { x: number; y: number; width: number; height: number } | null
  bboxes?: Array<{ x: number; y: number; width: number; height: number }> | null
  method?: string
  status: WatermarkStatus
  error?: string
}

export interface WatermarkStatusResult {
  ok: boolean
  jobId: string
  watermarkStatus?: WatermarkStatus | null
  cleanLocalPath?: string | null
  originalLocalPath?: string | null
  watermarkMethod?: string | null
  watermarkError?: string | null
  watermarkBBox?: { x: number; y: number; width: number; height: number } | null
  watermarkBBoxes?: Array<{ x: number; y: number; width: number; height: number }> | null
  error?: string
}

export interface QuotaUpdatedPayload {
  userId: string
  ledger: QuotaLedgerRow
  /** API 型厂商（智谱）生成成功后触发：据此重新拉取该账号真实额度 */
  zhipuRefreshKeyId?: string
  /** 火山方舟生成成功后触发：据此静默同步该账号免费模型的真实剩余额度 */
  volcRefreshKeyId?: string
}

/** 智谱平台资源包余额（fetch-quota 返回） */
export interface ZhipuQuotaResult {
  available: boolean
  total: number
  remaining: number
  expiresAt?: string | null
  packageName?: string | null
  expired?: boolean
}

/** API 型厂商「查看模型」弹窗目录项 */
export interface ApiModelInfo {
  model: string
  priceLabel: string
  cost: number
  durations: number[]
  size: string | null
  modes: Array<{ value: string; label: string }>
  /** 是否已开通该模型（火山方舟未开通模型提示开通；默认 true） */
  activated?: boolean
  /** 【每账号】免费 token 额度（火山方舟免费视频模型）：剩余/总数；未抓到为 undefined */
  freeQuota?: { remaining?: number; total?: number }
  /** 火山方舟模型不可用标记：平台下架 / 账号无接入点 */
  unavailable?: 'decommissioned' | 'no_endpoint'
  /** 不可用原因标签（已下架 / 无接入点），仅当 unavailable 有值时存在 */
  unavailableLabel?: string
}

/** 火山方舟绑定时控制台抓到的免费视频模型（含每账号 token 额度），随加密负载持久化 */
export interface VolcengineCapturedModel {
  id: string
  name?: string
  price?: string
  freeQuota?: { remaining?: number; total?: number }
}

/** 智谱控制台会话状态（依据 consoleJwt 的 JWT exp 判定），供自动续期调度参考 */
export interface ZhipuSessionStatusResult {
  hasSession: boolean
  status?: 'alive' | 'expiring' | 'expired'
  expMs?: number | null
  remainingMs?: number | null
}

export interface UpdaterStatus {
  state: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'not-available' | 'error'
  version?: string
  progress?: number
  error?: string
}

export type MaterialType = 'image' | 'video'

export interface MaterialRecord {
  id: string
  type: MaterialType
  name: string
  fileName: string
  ext: string
  size: number
  createdAt: number
  path: string
}

export interface GenerateRequest {
  supabaseUrl: string
  supabaseAnonKey: string
  accessToken: string
  refreshToken: string
  userId: string
  teamId?: string | null
  prompt: string
  providerId: string
  model?: string
  durationSec: number
  mode?: string
  resolution?: string
  audio?: string
  ratio?: string
  /** 本地图片路径（图生视频） */
  images?: string[]
  /** 测试开关：显示豆包 WebView 窗口（默认隐藏） */
  showWebview?: boolean
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
     * 打开已绑定账号对应的官网窗口
     * @param keyId 账号 key id；使用该账号自己的登录/生成分区
     * @param encryptedKey 可选：加密后的 Cookie/凭据，打开前会尝试注入到该账号分区
     */
    openSite: (providerId: string, keyId: string, encryptedKey?: string) => Promise<{ ok: boolean; error?: string }>
    /**
     * 取消登录窗口
     * @param keyId 可选：对应 login 传入的 keyId，关闭同一账号的登录窗口
     */
    cancelLogin: (providerId: string, keyId?: string) => Promise<void>
    /**
     * 迁移分区：把 src 分区的 cookie 复制到 dst 分区（用于刷新已有账号时把临时分区登录态迁移到目标分区）
     */
    migratePartition: (providerId: string, srcKeyId: string, dstKeyId: string) => Promise<{ ok: boolean; cookieCount?: number; error?: string }>
    /**
     * 测试 API Key 型厂商凭据是否有效（不产生费用）
     */
    testApiKey: (providerId: string, encrypted: string) => Promise<{ ok: boolean; error?: string }>
    /**
     * 查询 API 型厂商账号真实额度（智谱：平台资源包余额）
     */
    fetchQuota: (providerId: string, encrypted: string) => Promise<{ ok: boolean; quota?: ZhipuQuotaResult; error?: string }>
    /**
     * 查询 API 型厂商模型目录（「查看模型」弹窗）
     * @param encrypted 可选：该账号加密负载（火山方舟用它读取每账号免费 token 额度）
     */
    apiModels: (providerId: string, encrypted?: string) => Promise<{ ok: boolean; models?: ApiModelInfo[]; error?: string }>
    /**
     * 捕获智谱控制台登录会话（consoleJwt），用于真实额度查询
     * @param keyId 可选：账号 keyId，用于把控制台登录态隔离到该账号自己的分区，避免多账号串会话
     */
    captureZhipuSession: (keyId?: string) => Promise<{ ok: boolean; consoleJwt?: string; error?: string }>
    /**
     * 读取指定智谱账号的控制台会话状态（依据 consoleJwt 的 JWT exp 判定 alive / expiring / expired），供自动续期调度
     */
    zhipuSessionStatus: (keyId: string, encrypted: string) => Promise<ZhipuSessionStatusResult>
    /**
     * 指定智谱账号控制台会话静默续期：隐藏窗口复用该账号分区登录态 cookie 重新捕获新 consoleJwt；
     * 成功后返回重建后的新加密负载（encrypted），供调用方落库更新
     */
    zhipuRenewSession: (keyId: string, encrypted: string) => Promise<{
      ok: boolean
      encrypted?: string
      expMs?: number | null
      remainingMs?: number | null
      reason?: string
      error?: string
    }>
    /**
     * 捕获火山方舟控制台登录会话（consoleJwt）与账号标识（accountId），用于真实额度查询与账号级去重
     * @param keyId 可选：账号 keyId，用于把控制台登录态隔离到该账号自己的分区，避免多账号串会话
     */
    captureVolcengineSession: (keyId?: string) => Promise<{ ok: boolean; consoleJwt?: string; accountId?: string; models?: VolcengineCapturedModel[]; source?: 'console' | 'fallback'; error?: string }>
    /**
     * 读取指定火山方舟账号的控制台会话状态（依据 consoleJwt 的 JWT exp 判定 alive / expiring / expired）
     */
    volcSessionStatus: (keyId: string, encrypted: string) => Promise<ZhipuSessionStatusResult>
    /**
     * 指定火山方舟账号控制台会话静默续期：隐藏窗口复用该账号分区登录态 cookie 重新捕获新 consoleJwt；
     * 成功后返回重建后的新加密负载（encrypted），供调用方落库更新
     */
    volcRenewSession: (keyId: string, encrypted: string) => Promise<{
      ok: boolean
      encrypted?: string
      expMs?: number | null
      remainingMs?: number | null
      reason?: string
      error?: string
    }>
    /**
     * 指定火山方舟账号额度同步：后台复用该账号分区登录态打开「开通管理」页，静默抓取最新免费模型
     * 额度/开通状态；命中则返回重建后的新加密负载（encrypted）+ models，供调用方落库并刷新展示；
     * 未抓到（登录态失效/页面未就绪）返回 {ok:true, preserved:true} 保留旧值。
     */
    volcSyncModels: (keyId: string, encrypted: string, maxStaleMs?: number) => Promise<{
      ok: boolean
      encrypted?: string
      models?: VolcengineCapturedModel[]
      accountFingerprint?: string | null
      preserved?: boolean
      cached?: boolean
      reason?: string
      error?: string
    }>
  }
  cookieRenew: {
    configure: (config: CookieRenewConfig) => Promise<{ ok: boolean; error?: string }>
    setEnabled: (enabled: boolean) => Promise<{ ok: boolean; state: CookieRenewState }>
    getState: () => Promise<CookieRenewState>
  }
  updater: {
    check: () => Promise<UpdaterStatus>
    download: () => Promise<UpdaterStatus>
    quitAndInstall: () => Promise<void>
    onStatus: (callback: (status: UpdaterStatus) => void) => () => void
  }
  dispatch: {
    generate: (input: GenerateRequest) => Promise<{ ok: boolean; jobId?: string; error?: string }>
    reconcile: (params: { supabaseUrl: string; supabaseAnonKey: string; accessToken: string; refreshToken: string; userId: string }) => Promise<{ ok: boolean; recovered?: boolean; error?: string }>
    cancel: (jobId?: string) => Promise<{ ok: boolean; reason?: string; submitted?: boolean }>
    onEvent: (callback: (event: JobEvent) => void) => () => void
    onQuotaUpdated: (callback: (payload: QuotaUpdatedPayload) => void) => () => void
  }
  files: {
    getPath: (file: File) => string
  }
  materials: {
    list: () => Promise<MaterialRecord[]>
    import: (paths: string[]) => Promise<MaterialRecord[]>
    remove: (id: string) => Promise<{ ok: boolean; error?: string }>
    getUrl: (fileName: string) => Promise<string>
  }
  media: {
    getUrl: (name: string) => Promise<string>
    getImageUrl: (name: string) => Promise<string>
    showInFolder: (filePath: string) => Promise<{ ok: boolean; error?: string }>
  }
  watermark: {
    process: (input: WatermarkProcessInput) => Promise<WatermarkProcessResult>
    retry: (input: WatermarkProcessInput) => Promise<WatermarkProcessResult>
    cancel: (jobId: string) => Promise<{ ok: boolean }>
    getStatus: (input: Omit<WatermarkProcessInput, 'bbox' | 'bboxes'>) => Promise<WatermarkStatusResult>
    onProgress: (callback: (progress: WatermarkProgress) => void) => () => void
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
    openSite: (providerId, keyId, encryptedKey) =>
      ipcRenderer.invoke('provider:open-site', providerId, keyId, encryptedKey) as Promise<{ ok: boolean; error?: string }>,
    cancelLogin: (providerId, keyId) =>
      ipcRenderer.invoke('provider:login-cancel', providerId, keyId) as Promise<void>,
    migratePartition: (providerId, srcKeyId, dstKeyId) =>
      ipcRenderer.invoke('provider:migrate-partition', providerId, srcKeyId, dstKeyId) as Promise<{ ok: boolean; cookieCount?: number; error?: string }>,
    testApiKey: (providerId, encrypted) =>
      ipcRenderer.invoke('provider:test-api-key', providerId, encrypted) as Promise<{ ok: boolean; error?: string }>,
    fetchQuota: (providerId, encrypted) =>
      ipcRenderer.invoke('provider:fetch-quota', providerId, encrypted) as Promise<{ ok: boolean; quota?: ZhipuQuotaResult; error?: string }>,
    apiModels: (providerId, encrypted) =>
      ipcRenderer.invoke('provider:api-models', providerId, encrypted) as Promise<{ ok: boolean; models?: ApiModelInfo[]; error?: string }>,
    captureZhipuSession: (keyId) =>
      ipcRenderer.invoke('provider:capture-zhipu-session', keyId) as Promise<{ ok: boolean; consoleJwt?: string; error?: string }>,
    zhipuSessionStatus: (keyId, encrypted) =>
      ipcRenderer.invoke('provider:zhipu-session-status', 'zhipu', keyId, encrypted) as Promise<ZhipuSessionStatusResult>,
    zhipuRenewSession: (keyId, encrypted) =>
      ipcRenderer.invoke('provider:zhipu-renew-session', 'zhipu', keyId, encrypted) as Promise<{
        ok: boolean
        encrypted?: string
        expMs?: number | null
        remainingMs?: number | null
        reason?: string
        error?: string
      }>,
    captureVolcengineSession: (keyId) =>
      ipcRenderer.invoke('provider:capture-volc-session', keyId) as Promise<{
        ok: boolean
        consoleJwt?: string
        accountId?: string
        models?: VolcengineCapturedModel[]
        source?: 'console' | 'fallback'
        error?: string
      }>,
    volcSessionStatus: (keyId, encrypted) =>
      ipcRenderer.invoke('provider:volc-session-status', 'volcengine', keyId, encrypted) as Promise<ZhipuSessionStatusResult>,
    volcRenewSession: (keyId, encrypted) =>
      ipcRenderer.invoke('provider:volc-renew-session', 'volcengine', keyId, encrypted) as Promise<{
        ok: boolean
        encrypted?: string
        expMs?: number | null
        remainingMs?: number | null
        reason?: string
        error?: string
      }>,
    volcSyncModels: (keyId, encrypted, maxStaleMs) =>
      ipcRenderer.invoke('provider:volc-sync-models', 'volcengine', keyId, encrypted, maxStaleMs) as Promise<{
        ok: boolean
        encrypted?: string
        models?: VolcengineCapturedModel[]
        preserved?: boolean
        cached?: boolean
        reason?: string
        error?: string
      }>
  },
  cookieRenew: {
    configure: (config) => ipcRenderer.invoke('cookie-renew:configure', config) as Promise<{ ok: boolean; error?: string }>,
    setEnabled: (enabled) => ipcRenderer.invoke('cookie-renew:set-enabled', enabled) as Promise<{ ok: boolean; state: CookieRenewState }>,
    getState: () => ipcRenderer.invoke('cookie-renew:get-state') as Promise<CookieRenewState>
  },
  updater: {
    check: () => ipcRenderer.invoke('updater:check') as Promise<UpdaterStatus>,
    download: () => ipcRenderer.invoke('updater:download') as Promise<UpdaterStatus>,
    quitAndInstall: () => ipcRenderer.invoke('updater:quit-and-install') as Promise<void>,
    onStatus: (callback) => {
      const listener = (_e: Electron.IpcRendererEvent, status: UpdaterStatus): void =>
        callback(status)
      ipcRenderer.on('updater:status', listener)
      return () => {
        ipcRenderer.removeListener('updater:status', listener)
      }
    }
  },
  dispatch: {
    generate: (input) => ipcRenderer.invoke('dispatch:generate', input) as Promise<{ ok: boolean; jobId?: string; error?: string }>,
    reconcile: (params) => ipcRenderer.invoke('dispatch:reconcile', params) as Promise<{ ok: boolean; recovered?: boolean; error?: string }>,
    cancel: (jobId) => ipcRenderer.invoke('dispatch:cancel', jobId) as Promise<{ ok: boolean; reason?: string; submitted?: boolean }>,
    onEvent: (callback) => {
      const listener = (_e: Electron.IpcRendererEvent, event: JobEvent): void => callback(event)
      ipcRenderer.on('job:event', listener)
      return () => {
        ipcRenderer.removeListener('job:event', listener)
      }
    },
    onQuotaUpdated: (callback) => {
      const listener = (_e: Electron.IpcRendererEvent, payload: QuotaUpdatedPayload): void => callback(payload)
      ipcRenderer.on('quota:updated', listener)
      return () => {
        ipcRenderer.removeListener('quota:updated', listener)
      }
    }
  },
  files: {
    getPath: (file) => webUtils.getPathForFile(file)
  },
  materials: {
    list: () => ipcRenderer.invoke('materials:list') as Promise<MaterialRecord[]>,
    import: (paths) => ipcRenderer.invoke('materials:import', paths) as Promise<MaterialRecord[]>,
    remove: (id) => ipcRenderer.invoke('materials:remove', id) as Promise<{ ok: boolean; error?: string }>,
    getUrl: (fileName) => ipcRenderer.invoke('materials:get-url', fileName) as Promise<string>
  },
  media: {
    getUrl: (name) => ipcRenderer.invoke('media:get-url', name) as Promise<string>,
    getImageUrl: (name) => ipcRenderer.invoke('media:get-image-url', name) as Promise<string>,
    showInFolder: (filePath) =>
      ipcRenderer.invoke('media:show-in-folder', filePath) as Promise<{ ok: boolean; error?: string }>
  },
  watermark: {
    process: (input) => ipcRenderer.invoke('watermark:process', input) as Promise<WatermarkProcessResult>,
    retry: (input) => ipcRenderer.invoke('watermark:retry', input) as Promise<WatermarkProcessResult>,
    cancel: (jobId) => ipcRenderer.invoke('watermark:cancel', jobId) as Promise<{ ok: boolean }>,
    getStatus: (input) => ipcRenderer.invoke('watermark:get-status', input) as Promise<WatermarkStatusResult>,
    onProgress: (callback) => {
      const listener = (_e: Electron.IpcRendererEvent, progress: WatermarkProgress): void =>
        callback(progress)
      ipcRenderer.on('watermark:progress', listener)
      return () => {
        ipcRenderer.removeListener('watermark:progress', listener)
      }
    }
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
