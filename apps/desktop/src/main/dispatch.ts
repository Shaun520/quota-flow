// 调度编排：job 生命周期（pending → running → success/failed）
// + 豆包执行（webview-engine）+ 额度扣减（quota_ledger）+ 视频下载落盘（URL 时效）

import { app, safeStorage } from 'electron'
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { get as httpsGet } from 'node:https'
import { join } from 'node:path'
import { createSupabaseClient, JobService, ProviderService, todayKey } from '@quota-flow/db-supabase'
import { runDoubaoGeneration } from './webview-engine'
import type { ProviderCookie } from './webview-engine'

export interface GenerateInput {
  supabaseUrl: string
  supabaseAnonKey: string
  accessToken: string
  refreshToken: string
  userId: string
  prompt: string
  providerId: string
  durationSec: number
}

export interface DispatchEvent {
  jobId: string
  status?: string
  stage?: string
  message?: string
  data?: unknown
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36'

function doubaoCost(durationSec: number): number {
  if (durationSec <= 5) return 1
  if (durationSec <= 10) return 2
  return 3
}

/** 本地 data/doubao-auth.json 兜底（与 qwen/yuanbao 同款格式） */
function loadLocalDoubaoCookies(): ProviderCookie[] | null {
  try {
    const file = join(app.getAppPath(), '..', '..', 'data', 'doubao-auth.json')
    if (!existsSync(file)) return null
    const raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    const auth = JSON.parse(raw) as { cookie?: string }
    if (!auth.cookie) return null
    const cookies: ProviderCookie[] = []
    for (const part of auth.cookie.split(';')) {
      const p = part.trim()
      const idx = p.indexOf('=')
      if (idx <= 0) continue
      const name = p.slice(0, idx).trim()
      const value = p.slice(idx + 1).trim()
      if (name && value) {
        cookies.push({ name, value, domain: '.doubao.com', path: '/', httpOnly: false, secure: true, expires: 0 })
      }
    }
    return cookies.length ? cookies : null
  } catch {
    return null
  }
}

/** 下载视频到 userData/videos/<jobId>.mp4（生成后立即落盘，避免签名 URL 过期） */
function downloadVideo(url: string, jobId: string, redirects = 0): Promise<string | null> {
  return new Promise((resolve) => {
    if (redirects > 4) {
      resolve(null)
      return
    }
    const dir = join(app.getPath('userData'), 'videos')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, jobId + '.mp4')
    const tmp = file + '.part'
    const out = createWriteStream(tmp)
    let size = 0
    let settled = false
    const finish = (ok: boolean, path: string | null): void => {
      if (settled) return
      settled = true
      try {
        out.destroy()
      } catch {}
      resolve(ok ? path : null)
    }

    const req = httpsGet(
      url,
      {
        headers: { 'User-Agent': UA, Accept: '*/*', Referer: 'https://www.doubao.com/' }
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume()
          void downloadVideo(res.headers.location, jobId, redirects + 1).then((p) => finish(!!p, p))
          return
        }
        if (!res.statusCode || res.statusCode !== 200) {
          res.resume()
          finish(false, null)
          return
        }
        res.on('data', (c: Buffer) => {
          size += c.length
        })
        res.pipe(out)
      }
    )
    req.on('error', () => finish(false, null))
    req.setTimeout(90000, () => {
      req.destroy()
      finish(false, null)
    })
    out.on('finish', () => {
      if (size > 1024) {
        try {
          renameSync(tmp, file)
          finish(true, file)
        } catch {
          finish(false, null)
        }
      } else {
        finish(false, null)
      }
    })
    out.on('error', () => finish(false, null))
  })
}

export async function runGenerate(
  input: GenerateInput,
  emit: (event: DispatchEvent) => void
): Promise<{ ok: boolean; jobId?: string; error?: string }> {
  if (!input.supabaseUrl || !input.supabaseAnonKey) {
    return { ok: false, error: 'Supabase 未配置' }
  }

  const client = createSupabaseClient({
    supabaseUrl: input.supabaseUrl,
    supabaseAnonKey: input.supabaseAnonKey
  })
  try {
    await client.auth.setSession({ access_token: input.accessToken, refresh_token: input.refreshToken })
  } catch {
    return { ok: false, error: '登录态恢复失败，请重新登录' }
  }
  const jobSvc = new JobService(client)
  const providerSvc = new ProviderService(client)

  let job
  try {
    job = await jobSvc.insertJob(input.userId, {
      mode: 'text2video',
      prompt: input.prompt,
      status: 'pending',
      providerId: input.providerId
    })
  } catch (e) {
    return { ok: false, error: '创建任务失败: ' + (e instanceof Error ? e.message : String(e)) }
  }
  if (!job) return { ok: false, error: '创建任务失败' }
  emit({ jobId: job.id, status: 'pending', message: '任务已创建' })

  // 1) 选号 + 解析 cookie：默认账号优先 → 剩余额度预检 → 失败自动换号（有界）
  const cost = doubaoCost(input.durationSec)
  const keys = await providerSvc.listProviderKeys(input.userId)
  const doubaoKeys = keys.filter((k) => k.provider_id === 'doubao' && k.enabled !== false)

  let selectedKey: { id: string; accountName: string | null } | null = null
  let cookies: ProviderCookie[] | null = null
  let storageEntries: Array<{ key: string; value: string }> = []
  let result: Awaited<ReturnType<typeof runDoubaoGeneration>> | null = null
  let lastError = ''

  if (doubaoKeys.length === 0) {
    // 未绑定账号：本地 auth 文件兜底（开发用）
    cookies = loadLocalDoubaoCookies()
    if (!cookies || cookies.length === 0) {
      const err = '未绑定豆包账号（请在厂商页绑定后重试）'
      await jobSvc.updateJob(input.userId, job.id, {
        status: 'failed',
        error: err,
        completedAt: new Date().toISOString()
      })
      emit({ jobId: job.id, status: 'failed', message: err })
      return { ok: false, jobId: job.id, error: err }
    }
    result = await runDoubaoGeneration({
      cookies,
      localStorage: storageEntries,
      prompt: input.prompt,
      durationSec: input.durationSec,
      onProgress: (stage, detail) => emit({ jobId: job.id, status: 'running', stage, message: stage, data: detail })
    })
    lastError = result.ok ? '' : result.error || '生成失败'
  } else {
    try {
      const providers = await providerSvc.listProviders()
      const doubaoMeta = providers.find((p) => p.id === 'doubao')
      const dailyTotal = Number(doubaoMeta?.default_daily_quota ?? 10)
      const unitName = doubaoMeta?.unit_name ?? '点'
      const today = todayKey()
      const ledgers = await providerSvc.listLedger(input.userId)

      // 确保每个账号今日 ledger 行存在（每日 0 点重置）
      for (const k of doubaoKeys) {
        const hasToday = ledgers.some((l) => l.account_key_id === k.id && l.date === today)
        if (!hasToday) {
          await providerSvc.getOrInitLedger({
            userId: input.userId,
            providerId: 'doubao',
            unitName,
            dailyTotal,
            keyId: k.id
          })
        }
      }
      const freshLedgers = await providerSvc.listLedger(input.userId)
      const remainingOf = (keyId: string): number => {
        const row = freshLedgers.find((l) => l.account_key_id === keyId && l.date === today)
        return row ? Math.max(Number(row.remaining ?? 0), 0) : 0
      }
      const sorted = [...doubaoKeys].sort((a, b) => {
        if (!!a.is_default !== !!b.is_default) return a.is_default ? -1 : 1
        // 已失效账号排最后，避免默认账号过期时浪费尝试
        const expiredA = a.health_status === 'expired' ? 1 : 0
        const expiredB = b.health_status === 'expired' ? 1 : 0
        if (expiredA !== expiredB) return expiredA - expiredB
        return remainingOf(b.id) - remainingOf(a.id)
      })

      const tried = new Set<string>()
      for (let round = 0; round < Math.min(doubaoKeys.length, 3); round++) {
        const cand = sorted.find((k) => !tried.has(k.id) && remainingOf(k.id) >= cost)
        if (!cand) {
          lastError = lastError || `所有豆包账号剩余额度不足（本次需 ${cost} 点）`
          break
        }
        tried.add(cand.id)
        let c: ProviderCookie[] | null = null
        let s: Array<{ key: string; value: string }> = []
        try {
          if (safeStorage.isEncryptionAvailable()) {
            const plain = safeStorage.decryptString(Buffer.from(cand.encrypted_key, 'base64'))
            const parsed = JSON.parse(plain) as unknown
            if (Array.isArray(parsed)) {
              c = parsed as ProviderCookie[]
            } else {
              const obj = parsed as {
                cookies?: ProviderCookie[]
                localStorage?: Array<{ key: string; value: string }>
              }
              c = obj.cookies ?? []
              s = obj.localStorage ?? []
            }
          }
        } catch {
          c = null
        }
        if (!c || c.length === 0) {
          lastError = `账号「${cand.account_name || '未命名'}」cookie 解密失败`
          continue
        }
        cookies = c
        storageEntries = s
        selectedKey = { id: cand.id, accountName: cand.account_name }
        emit({
          jobId: job.id,
          status: 'running',
          stage: 'select-account',
          message: `使用账号：${cand.account_name || '未命名'}`,
          data: { accountId: cand.id }
        })
        await jobSvc.updateJob(input.userId, job.id, {
          status: 'running',
          accountId: cand.id,
          options: { accountId: cand.id, accountName: cand.account_name }
        })
        result = await runDoubaoGeneration({
          cookies: c,
          localStorage: s,
          prompt: input.prompt,
          durationSec: input.durationSec,
          keyId: cand.id,
          onProgress: (stage, detail) =>
            emit({ jobId: job.id, status: 'running', stage, message: stage, data: detail })
        })
        if (result.ok && result.videoUrl) break
        lastError = result.error || '生成失败'
        if (/未登录|登录/.test(lastError)) {
          try {
            await providerSvc.updateHealth(input.userId, cand.id, 'expired')
          } catch {}
        }
        emit({
          jobId: job.id,
          status: 'running',
          stage: 'account-failed',
          message: `账号「${cand.account_name || '未命名'}」失败：${lastError}`,
          data: { accountId: cand.id }
        })
      }
    } catch (e) {
      lastError = '选号/执行异常: ' + (e instanceof Error ? e.message : String(e))
    }
  }

  if (!result || !result.ok || !result.videoUrl) {
    const err = result ? result.error || lastError || '生成失败' : lastError || '未找到可用豆包账号'
    await jobSvc.updateJob(input.userId, job.id, {
      status: 'failed',
      error: err,
      attempts: result?.attempts ?? [],
      completedAt: new Date().toISOString()
    })
    emit({ jobId: job.id, status: 'failed', message: err })
    return { ok: false, jobId: job.id, error: err }
  }

  // 2) 成功：下载落盘（URL 时效）→ 写 jobs（含 account_id）→ 扣该账号额度
  const localPath = await downloadVideo(result.videoUrl, job.id)
  const resultUrl = localPath || result.videoUrl
  await jobSvc.updateJob(input.userId, job.id, {
    status: 'success',
    providerId: 'doubao',
    accountId: selectedKey?.id ?? null,
    resultUrl,
    costUnit: '点',
    costAmount: cost,
    attempts: result.attempts,
    options: {
      remoteUrl: result.videoUrl,
      localPath: localPath || null,
      posterUrl: result.posterUrl ?? null,
      accountId: selectedKey?.id ?? null,
      accountName: selectedKey?.accountName ?? null
    },
    completedAt: new Date().toISOString()
  })
  try {
    await providerSvc.consumeLedger(input.userId, 'doubao', cost, {
      unitName: '点',
      keyId: selectedKey?.id ?? undefined
    })
  } catch (e) {
    emit({
      jobId: job.id,
      status: 'success',
      message: '生成成功，但额度记账失败: ' + (e instanceof Error ? e.message : String(e))
    })
    return { ok: true, jobId: job.id }
  }
  emit({
    jobId: job.id,
    status: 'success',
    message: '生成成功',
    data: { resultUrl, cost, localPath, accountId: selectedKey?.id ?? null }
  })
  return { ok: true, jobId: job.id }
}
