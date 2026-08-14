// 调度编排：job 生命周期（pending → running → success/failed）
// + 豆包执行（webview-engine）+ 额度扣减（quota_ledger）+ 视频下载落盘（URL 时效）

import { app, safeStorage } from 'electron'
import { copyFileSync, createWriteStream, mkdirSync, renameSync } from 'node:fs'
import { get as httpsGet } from 'node:https'
import { join } from 'node:path'
import { createSupabaseClient, JobService, ProviderService, todayKey } from '@quota-flow/db-supabase'
import type { QuotaLedgerRow } from '@quota-flow/db-supabase'
import { runDoubaoGeneration } from './webview-engine'
import type { ProviderCookie, OriginStorage } from './webview-engine'
import { processWatermarkJob } from './watermark-remover/job'

export interface GenerateInput {
  supabaseUrl: string
  supabaseAnonKey: string
  accessToken: string
  refreshToken: string
  userId: string
  teamId?: string | null
  prompt: string
  providerId: string
  durationSec: number
  mode?: string
  resolution?: string
  audio?: string
  ratio?: string
  /** 本地去水印开关，默认开启 */
  watermarkEnabled?: boolean
  /** 本地图片路径（图生视频，仅允许常见图片格式） */
  images?: string[]
  /** 测试开关：显示豆包 WebView 窗口（默认隐藏） */
  showWebview?: boolean
}

/**
 * 兼容 v0/v1/v2 三种存储格式（与 providers.ts parseStoredCredentials 逻辑一致）
 *  - v0 (最旧): ProviderCookie[]
 *  - v1 (旧):   { cookies: ProviderCookie[], localStorage: {key,value}[] }
 *  - v2 (新):   { cookies: ProviderCookie[], storages: OriginStorage[], localStorage?: legacy }
 */
function parseProviderCredentials(encrypted: string): {
  cookies: ProviderCookie[]
  storages: OriginStorage[]
  localStorage: Array<{ key: string; value: string }>
} {
  const plain = safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
  const parsed = JSON.parse(plain) as unknown
  if (Array.isArray(parsed)) {
    return { cookies: parsed as ProviderCookie[], storages: [], localStorage: [] }
  }
  const obj = parsed as {
    cookies?: ProviderCookie[]
    storages?: OriginStorage[]
    localStorage?: Array<{ key: string; value: string }>
  }
  const cookies = obj.cookies ?? []
  const storages: OriginStorage[] = Array.isArray(obj.storages) ? obj.storages : []
  if (obj.localStorage?.length && !storages.length) {
    storages.push({
      origin: 'https://www.doubao.com',
      localStorage: obj.localStorage,
      sessionStorage: []
    })
  }
  const mainStorage = storages.find((s) => s.origin === 'https://www.doubao.com') || storages[0]
  const localStorage = mainStorage?.localStorage ?? []
  return { cookies, storages, localStorage }
}

export interface DispatchEvent {
  jobId: string
  status?: string
  stage?: string
  message?: string
  data?: unknown
}

export interface QuotaUpdatedPayload {
  userId: string
  ledger: QuotaLedgerRow
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36'

const DEFAULT_SUPPORTED_DURATIONS = [5, 10]

function resolveDispatchProvider(providerId: string): string {
  return providerId === 'auto' ? 'doubao' : providerId
}

function parseSupportedDurations(meta: { capabilities?: Record<string, unknown> | null } | undefined): number[] {
  const raw = meta?.capabilities?.supported_durations
  if (!Array.isArray(raw)) return [...DEFAULT_SUPPORTED_DURATIONS]
  const durations = raw
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n) && n > 0)
  return durations.length > 0 ? durations : [...DEFAULT_SUPPORTED_DURATIONS]
}

function doubaoCost(durationSec: number): number {
  if (durationSec <= 5) return 1
  if (durationSec <= 10) return 2
  return 3
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
  emit: (event: DispatchEvent) => void,
  onJobCreated?: (jobId: string, state: { aborted: boolean; submitted: boolean }) => void,
  onQuotaUpdated?: (payload: QuotaUpdatedPayload) => void
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

  const resolvedProviderId = resolveDispatchProvider(input.providerId)
  try {
    const providers = await providerSvc.listAllProviders()
    const meta = providers.find((p) => p.id === resolvedProviderId)
    const supportedDurations = parseSupportedDurations(meta)
    if (!supportedDurations.includes(input.durationSec)) {
      return { ok: false, error: `当前厂商不支持 ${input.durationSec} 秒` }
    }
  } catch (e) {
    return { ok: false, error: '校验厂商时长失败: ' + (e instanceof Error ? e.message : String(e)) }
  }
  // 取消/已提交状态：由主进程注册表持有引用，IPC 侧可标记 aborted，引擎提交后置 submitted
  const runCancelState: { aborted: boolean; submitted: boolean } = { aborted: false, submitted: false }

  let job
  try {
    job = await jobSvc.insertJob(input.userId, {
      teamId: input.teamId,
      mode: input.mode === 'img2video' ? 'img2video' : 'text2video',
      prompt: input.prompt,
      status: 'pending',
      providerId: input.providerId
    })
  } catch (e) {
    return { ok: false, error: '创建任务失败: ' + (e instanceof Error ? e.message : String(e)) }
  }
  if (!job) return { ok: false, error: '创建任务失败' }
  emit({ jobId: job.id, status: 'pending', message: '任务已创建' })
  onJobCreated?.(job.id, runCancelState)

  // 1) 选号 + 解析 cookie：默认账号优先 → 剩余额度预检 → 失败自动换号（有界）
  const cost = doubaoCost(input.durationSec)
  const images = (input.images ?? [])
    .filter((p) => typeof p === 'string' && /\.(jpe?g|png|webp|gif)$/i.test(p))
    .slice(0, 10)
  // 生成参数 + 上传图片副本：随任务持久化，历史详情可回显「提示词/参数/图片」
  const jobImages: string[] = []
  if (images.length > 0) {
    try {
      const imgDir = join(app.getPath('userData'), 'images')
      mkdirSync(imgDir, { recursive: true })
      for (let i = 0; i < images.length; i++) {
        try {
          const ext = (/\.(png|gif|webp)$/i.exec(images[i])?.[1] ?? 'jpg').toLowerCase()
          const dest = join(imgDir, `${job.id}-${i}.${ext}`)
          copyFileSync(images[i], dest)
          jobImages.push(dest)
        } catch {}
      }
    } catch {}
  }
  const jobOptions: Record<string, unknown> = {
    mode: input.mode,
    durationSec: input.durationSec,
    ratio: input.ratio,
    audio: input.audio,
    resolution: input.resolution,
    watermarkEnabled: input.watermarkEnabled !== false
  }
  if (jobImages.length > 0) jobOptions.images = jobImages
  const keys = input.teamId
    ? await providerSvc.listTeamProviderKeys(input.teamId)
    : (await providerSvc.listProviderKeys(input.userId)).filter((k) => !k.team_id)
  const doubaoKeys = keys.filter((k) => k.provider_id === 'doubao' && k.enabled !== false)

  let selectedKey: { id: string; accountName: string | null } | null = null
  let result: Awaited<ReturnType<typeof runDoubaoGeneration>> | null = null
  let lastError = ''

  if (doubaoKeys.length === 0) {
    const err = '未绑定豆包账号（请在厂商页绑定后重试）'
    await jobSvc.updateJob(input.userId, job.id, {
      status: 'failed',
      error: err,
      options: jobOptions,
      completedAt: new Date().toISOString()
    })
    emit({ jobId: job.id, status: 'failed', message: err })
    return { ok: false, jobId: job.id, error: err }
  } else {
    try {
      const today = todayKey()
      // 批量确保今日 ledger 行存在，避免逐账号请求拖慢生成前的额度排序。
      await providerSvc.ensureProviderLedgerRows(input.userId, input.teamId ?? null, doubaoKeys.map((k) => k.id))
      const freshLedgers = input.teamId
        ? await providerSvc.listTeamTodayLedger(input.teamId)
        : await providerSvc.listTodayLedger(input.userId)
      const remainingOf = (keyId: string): number => {
        const row = freshLedgers.find((l) => l.account_key_id === keyId && l.date === today)
        // 用 daily_total - used - reserved 而非 remaining，与 RPC 原子扣减条件一致
        return row ? Math.max(Number(row.daily_total) - Number(row.used) - Number(row.reserved ?? 0), 0) : 0
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
        let storages: OriginStorage[] = []
        try {
          if (safeStorage.isEncryptionAvailable()) {
            const parsed = parseProviderCredentials(cand.encrypted_key)
            c = parsed.cookies
            s = parsed.localStorage
            storages = parsed.storages
          }
        } catch {
          c = null
        }
        if (!c || c.length === 0) {
          lastError = `账号「${cand.account_name || '未命名'}」cookie 解密失败`
          continue
        }
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
          options: { ...jobOptions, accountId: cand.id, accountName: cand.account_name }
        })
        // 任务注册后、进入引擎前已被取消 → 直接返回中断结果
        if (runCancelState.aborted) {
          result = {
            ok: false,
            providerId: 'doubao',
            cancelled: true,
            error: '已手动终止生成（提示词未发送）',
            attempts: []
          }
          break
        }
        result = await runDoubaoGeneration({
          cookies: c,
          localStorage: s,
          storages,
          prompt: input.prompt,
          durationSec: input.durationSec,
          mode: input.mode,
          resolution: input.resolution,
          audio: input.audio,
          ratio: input.ratio,
          images,
          keyId: cand.id,
          cancel: runCancelState,
          showWebview: input.showWebview,
          onProgress: (stage, detail) =>
            emit({ jobId: job.id, status: 'running', stage, message: stage, data: detail })
        })
        if (result.ok && result.videoUrl) break
        lastError = result.error || '生成失败'
        // 用户手动终止（提示词未发送）：标记为意外中断，不再换号
        if (result.cancelled) {
          try {
            await jobSvc.updateJob(input.userId, job.id, {
              status: 'interrupted',
              error: '已手动终止生成（提示词未发送）',
              options: jobOptions,
              completedAt: new Date().toISOString()
            })
          } catch {}
          emit({
            jobId: job.id,
            status: 'failed',
            message: '已手动终止生成（提示词未发送）'
          })
          return { ok: false, jobId: job.id, error: '已手动终止生成（提示词未发送）' }
        }
        // 内容政策拒绝（侵权/肖像/版权）：与账号无关，不再切换账号重试
        if (result.blocked) {
          emit({
            jobId: job.id,
            status: 'running',
            stage: 'blocked',
            message: lastError
          })
          break
        }
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
    try {
      await jobSvc.updateJob(input.userId, job.id, {
        status: 'failed',
        error: err,
        attempts: result?.attempts ?? [],
        options: jobOptions,
        completedAt: new Date().toISOString()
      })
    } catch {
      // 状态回写失败不阻断错误返回
    }
    emit({ jobId: job.id, status: 'failed', message: err })
    return { ok: false, jobId: job.id, error: err }
  }

  // 2) 成功：下载落盘 → 先扣额度 → 再写 job success
  let localPath: string | null = null
  try {
    localPath = await downloadVideo(result.videoUrl, job.id)
  } catch (e) {
    emit({
      jobId: job.id,
      status: 'running',
      message: '视频下载异常，继续使用远程 URL: ' + (e instanceof Error ? e.message : String(e))
    })
  }
  const resultUrl = localPath || result.videoUrl

  // 先扣额度（原子 RPC），成功后再写 job success；
  // 失败则 job 标记 failed，通过 reconciliation 兜底追记
  let consumed: QuotaLedgerRow | null = null
  try {
    if (input.teamId) {
      const teamResult = await providerSvc.consumeTeamQuotaAndFinalize({
        teamId: input.teamId,
        userId: input.userId,
        providerId: 'doubao',
        amount: cost,
        keyId: selectedKey?.id ?? null,
        jobId: job.id
      })
      if (!teamResult.ok) {
        throw new Error(`[${teamResult.code || 'UNKNOWN'}] ${teamResult.message || '额度扣减失败'}`)
      }
      consumed = teamResult.row ?? null
    } else {
      consumed = await providerSvc.consumeLedger(input.userId, 'doubao', cost, {
        unitName: '点',
        keyId: selectedKey?.id ?? undefined
      })
      if (selectedKey?.id && consumed) {
        await providerSvc.insertQuotaOperation(job.id, consumed.id, 'finalize', cost)
      }
    }
    if (consumed) onQuotaUpdated?.({ userId: input.userId, ledger: consumed })
  } catch (e) {
    const errMsg = '额度扣减失败: ' + (e instanceof Error ? e.message : String(e))
    await jobSvc.updateJob(input.userId, job.id, {
      status: 'failed',
      error: errMsg,
      resultUrl,
      costUnit: '点',
      costAmount: cost,
      attempts: result.attempts,
      options: {
        ...jobOptions,
        remoteUrl: result.videoUrl,
        localPath: localPath || null,
        cleanLocalPath: null,
        originalLocalPath: localPath || null,
        watermarkStatus: localPath && input.watermarkEnabled !== false ? 'processing' : 'none',
        watermarkMethod: localPath && input.watermarkEnabled !== false ? 'delogo' : null,
        watermarkError: null,
        posterUrl: result.posterUrl ?? null,
        accountId: selectedKey?.id ?? null,
        accountName: selectedKey?.accountName ?? null
      },
      completedAt: new Date().toISOString()
    })
    emit({ jobId: job.id, status: 'failed', message: errMsg })
    return { ok: false, jobId: job.id, error: errMsg }
  }

  await jobSvc.updateJob(input.userId, job.id, {
    status: 'success',
    providerId: 'doubao',
    accountId: selectedKey?.id ?? null,
    resultUrl,
    costUnit: '点',
    costAmount: cost,
    attempts: result.attempts,
    options: {
      ...jobOptions,
      remoteUrl: result.videoUrl,
      localPath: localPath || null,
      cleanLocalPath: null,
      originalLocalPath: localPath || null,
      watermarkStatus: localPath && input.watermarkEnabled !== false ? 'processing' : 'none',
      watermarkMethod: localPath && input.watermarkEnabled !== false ? 'delogo' : null,
      watermarkError: null,
      posterUrl: result.posterUrl ?? null,
      accountId: selectedKey?.id ?? null,
      accountName: selectedKey?.accountName ?? null
    },
    completedAt: new Date().toISOString()
  })
  emit({
    jobId: job.id,
    status: 'success',
    message: '生成成功',
    data: { resultUrl, cost, localPath, accountId: selectedKey?.id ?? null }
  })

  if (localPath && input.watermarkEnabled !== false) {
    emit({
      jobId: job.id,
      status: 'running',
      stage: 'watermark',
      message: '本地去水印中…'
    })
    const wmResult = await processWatermarkJob({
      supabaseUrl: input.supabaseUrl,
      supabaseAnonKey: input.supabaseAnonKey,
      accessToken: input.accessToken,
      refreshToken: input.refreshToken,
      userId: input.userId,
      jobId: job.id,
      onProgress: (progress) =>
        emit({
          jobId: job.id,
          status: 'running',
          stage: 'watermark',
          message: progress.message ?? '本地去水印中…',
          data: progress
        })
    })
    emit({
      jobId: job.id,
      status: 'success',
      stage: 'watermark',
      message: wmResult.ok ? '去水印完成' : (wmResult.error || '去水印失败')
    })
  }

  return { ok: true, jobId: job.id }
}
