import { BrowserWindow, ipcMain, safeStorage, session } from 'electron'
import type { Cookie } from 'electron'

export type ProviderId =
  | 'doubao'
  | 'jimeng'
  | 'qwen'
  | 'yuanbao'
  | 'kling'
  | 'hailuo'
  | 'mathmind'

interface ProviderSite {
  loginUrl?: string
  healthUrl: string
  apiKeyOnly?: boolean
}

// API Key 型厂商（mathmind）不走登录窗口；其余 cookie 型厂商走网页登录
const PROVIDER_SITES: Record<ProviderId, ProviderSite> = {
  doubao: {
    loginUrl: 'https://www.doubao.com/chat/',
    healthUrl: 'https://www.doubao.com/chat/'
  },
  jimeng: {
    loginUrl: 'https://jimeng.jianying.com/ai-tool/video/generate',
    healthUrl: 'https://jimeng.jianying.com/'
  },
  qwen: {
    loginUrl: 'https://tongyi.aliyun.com/wanxiang/create',
    healthUrl: 'https://tongyi.aliyun.com/'
  },
  yuanbao: {
    loginUrl: 'https://yuanbao.tencent.com/chat/naQivTmsDa',
    healthUrl: 'https://yuanbao.tencent.com/'
  },
  kling: {
    loginUrl: 'https://klingai.com/global/',
    healthUrl: 'https://klingai.com/global/'
  },
  hailuo: {
    loginUrl: 'https://hailuoai.com/video',
    healthUrl: 'https://hailuoai.com/'
  },
  mathmind: {
    healthUrl: '',
    apiKeyOnly: true
  }
}

export interface ProviderCookie {
  name: string
  value: string
  domain: string
  path: string
  httpOnly: boolean
  secure: boolean
  expires: number
}

export interface ProviderLoginResult {
  ok: boolean
  canceled?: boolean
  encrypted?: string
  cookieCount?: number
  expiresAt?: number | null
  error?: string
}

const loginWindows = new Map<string, BrowserWindow>()

function partitionFor(providerId: string): string {
  return 'persist:qf-p:' + providerId
}

function encryptCookies(cookies: ProviderCookie[]): string {
  const plain = JSON.stringify(cookies)
  return safeStorage.encryptString(plain).toString('base64')
}

function exportCookies(cookies: Cookie[]): ProviderCookie[] {
  return cookies.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    httpOnly: c.httpOnly,
    secure: c.secure,
    expires: typeof c.expirationDate === 'number' ? c.expirationDate * 1000 : 0
  }))
}

async function collectPartitionCookies(providerId: string): Promise<ProviderCookie[]> {
  const ses = session.fromPartition(partitionFor(providerId))
  const all = await ses.cookies.get({})
  return exportCookies(all)
}

async function injectCookies(
  providerId: string,
  cookies: ProviderCookie[]
): Promise<void> {
  const ses = session.fromPartition(partitionFor(providerId))
  for (const c of cookies) {
    try {
      await ses.cookies.set({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        httpOnly: c.httpOnly,
        secure: c.secure,
        expirationDate: c.expires > 0 ? Math.floor(c.expires / 1000) : undefined
      })
    } catch {
      // 单条失败不阻塞其余注入
    }
  }
}

function openLoginWindow(providerId: string): Promise<ProviderLoginResult> {
  const site = PROVIDER_SITES[providerId]
  if (!site?.loginUrl) {
    return Promise.resolve({ ok: false, error: '该厂商仅支持 API Key 绑定' })
  }

  return new Promise((resolve) => {
    const existing = loginWindows.get(providerId)
    if (existing && !existing.isDestroyed()) {
      existing.focus()
      resolve({ ok: false, canceled: true, error: '登录窗口已打开' })
      return
    }

    const win = new BrowserWindow({
      width: 1120,
      height: 780,
      minWidth: 900,
      minHeight: 640,
      autoHideMenuBar: true,
      title: '厂商登录 - Quota-Flow',
      backgroundColor: '#ffffff',
      webPreferences: {
        partition: partitionFor(providerId),
        contextIsolation: true,
        nodeIntegration: false
      }
    })
    loginWindows.set(providerId, win)

    let finished = false
    const done = (result: ProviderLoginResult): void => {
      if (finished) return
      finished = true
      clearInterval(pollTimer)
      if (!win.isDestroyed()) win.destroy()
      loginWindows.delete(providerId)
      resolve(result)
    }

    win.on('closed', () => {
      clearInterval(pollTimer)
      if (loginWindows.get(providerId) === win) loginWindows.delete(providerId)
      if (!finished) {
        finished = true
        resolve({ ok: false, canceled: true })
      }
    })

    // 页面顶部注入操作条：提示 + 完成后点击按钮
    const injectBar = (): void => {
      void win.webContents
        .executeJavaScript(
          `(() => {
            if (document.getElementById('qf-login-bar')) return;
            const bar = document.createElement('div');
            bar.id = 'qf-login-bar';
            bar.style.cssText = 'position:fixed;top:0;left:0;right:0;height:40px;z-index:2147483647;display:flex;align-items:center;justify-content:space-between;padding:0 12px;background:#1c1c1e;color:#fff;font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-shadow:0 1px 4px rgba(0,0,0,.3);';
            bar.innerHTML =
              '<span>请在弹出的页面完成登录</span>' +
              '<button id="qf-login-done" style="padding:5px 14px;border:0;border-radius:6px;background:#e07a3e;color:#fff;font:600 13px/1.4 inherit;cursor:pointer;">已完成登录</button>';
            document.documentElement.style.marginTop = '40px';
            document.body.appendChild(bar);
            document.getElementById('qf-login-done').addEventListener('click', () => {
              window.__QF_LOGIN_DONE__ = true;
            });
          })()`
        )
        .catch(() => {})
    }

    win.webContents.on('did-finish-load', () => {
      injectBar()
    })

    // 轮询用户是否点击"已完成登录"
    const pollTimer = setInterval(() => {
      if (win.isDestroyed()) return
      void win.webContents
        .executeJavaScript('window.__QF_LOGIN_DONE__ === true')
        .then((flag: boolean) => {
          if (!flag) return
          void collectPartitionCookies(providerId)
            .then((cookies) => {
              if (cookies.length === 0) {
                done({ ok: false, error: '未检测到登录 Cookie，请确认已登录后重试' })
                return
              }
              const maxExp = Math.max(...cookies.map((c) => c.expires))
              const viewCookies = cookies.length
              done({
                ok: true,
                encrypted: encryptCookies(cookies),
                cookieCount: viewCookies,
                expiresAt: maxExp > 0 ? maxExp : null
              })
            })
            .catch((e: unknown) => done({ ok: false, error: String(e) }))
        })
        .catch(() => {})
    }, 800)

    void win.loadURL(site.loginUrl).catch((e: unknown) => {
      done({ ok: false, error: `加载登录页失败：${String(e)}` })
    })
  })
}

async function healthCheck(
  providerId: string,
  encrypted: string
): Promise<{ ok: boolean; status: string; error?: string }> {
  const site = PROVIDER_SITES[providerId]
  if (!site?.healthUrl) return { ok: false, status: 'unknown', error: '该厂商不支持健康检查' }

  let cookies: ProviderCookie[]
  try {
    const plain = safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
    cookies = JSON.parse(plain) as ProviderCookie[]
  } catch {
    return { ok: false, status: 'unknown', error: '解密失败' }
  }

  const ses = session.fromPartition(partitionFor(providerId))
  await injectCookies(providerId, cookies)

  return new Promise((resolve) => {
    const win = new BrowserWindow({
      show: false,
      width: 800,
      height: 600,
      webPreferences: { partition: partitionFor(providerId) }
    })

    let statusCode: number | null = null
    let finalUrl = ''
    let settled = false
    const settle = (status: string, error?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (!win.isDestroyed()) win.destroy()
      resolve({ ok: status !== 'unknown', status, error })
    }

    const timeout = setTimeout(() => settle('unknown', '健康检查超时'), 20000)

    ses.webRequest.onResponseStarted((details) => {
      if (details.resourceType === 'mainFrame') {
        statusCode = details.statusCode
        finalUrl = details.url
      }
    })

    win.webContents.on('did-fail-load', (_e, code, desc) => {
      if (code === -3) return // ERR_ABORTED（导航跳转忽略）
      settle('unknown', `加载失败 (${code}: ${desc})`)
    })

    win.webContents.on('did-finish-load', () => {
      finalUrl = win.webContents.getURL()
      if (statusCode === null) settle('unknown', '未捕获响应状态')
      else if (statusCode === 200) settle('healthy')
      else if (statusCode === 401 || statusCode === 403) settle('expired', `HTTP ${statusCode}`)
      else settle('unknown', `HTTP ${statusCode}`)
    })

    void win.loadURL(site.healthUrl)
  })
}

let registered = false

export function initProviders(): void {
  if (registered) return
  registered = true

  ipcMain.handle('provider:login', async (_e, providerId: string) => {
    return openLoginWindow(providerId)
  })

  ipcMain.handle('provider:encrypt', (_e, plain: string) => {
    if (typeof plain !== 'string') return { encrypted: '' }
    try {
      return { encrypted: safeStorage.encryptString(plain).toString('base64') }
    } catch {
      return { encrypted: '' }
    }
  })

  ipcMain.handle('provider:health-check', (_e, providerId: string, encrypted: string) => {
    return healthCheck(providerId, encrypted)
  })

  ipcMain.handle('provider:login-cancel', (_e, providerId: string) => {
    const win = loginWindows.get(providerId)
    if (win && !win.isDestroyed()) win.destroy()
  })
}

declare global {
  interface Window {
    __QF_LOGIN_DONE__?: boolean
  }
}