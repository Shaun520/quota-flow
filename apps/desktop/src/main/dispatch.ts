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
import { parseStoredCredentials as parseProviderCredentials } from './providers'
import { clearVolcModelUnavailable, markVolcModelUnavailable } from './providers'
import { runQwenGeneration } from './qwen-webview'
import { runYuanbaoGeneration } from './yuanbao-webview'
import { runDolaGeneration } from './dola-webview'
import { API_BRANCHES } from './api-branch'
import type { ApiCredential, ApiGenerateParams } from './api-branch'
import { deleteImages } from './github-upload'
import {
  cachedListProviderKeysWithSecrets,
  cachedListTeamProviderKeysWithSecrets,
  invalidateKeysByKeyId
} from './query-cache'

export interface GenerateInput {
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
  /** 历史入库/本地展示用的图片：本地路径或公网 URL（本地路径会复制到 userData/images） */
  images?: string[]
  /** 厂商 API 用的参考图公网 https URL（仅 API 型厂商上传；历史展示不依赖它） */
  imageUrls?: string[]
  /** 参考生（r2v）本地视频参考副本：本地路径会复制到 userData/videos 供历史回显 */
  videos?: string[]
  /** 参考生（r2v）公网 https 视频 URL 数组（bailian 等合入 input.media reference_video） */
  videoUrls?: string[]
  /** 文生视频音频参考的公网 https URL（bailian 等透传 input.audio_url） */
  audioUrl?: string
  /** 特效模板（yt-video-fx）：控制台创建的特效模板标识，透传提交 body 的 Template 字段 */
  template?: string
  /** 音频本地副本路径（历史回显/重新生成回填）；公网 http(s) URL 原样保留 */
  audioLocalPath?: string
  /** 测试开关：显示豆包 WebView 窗口（默认隐藏） */
  showWebview?: boolean
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
  /** API 型厂商（智谱）生成成功后触发：渲染层据此重新拉取该账号真实额度 */
  zhipuRefreshKeyId?: string
  /** 火山方舟生成成功后触发：渲染层据此静默同步该账号免费模型真实剩余额度 */
  volcRefreshKeyId?: string
  /** 阿里云百炼生成成功后触发：渲染层据此静默重抓该账号控制台最新免费额度 */
  bailianRefreshKeyId?: string
  /** 腾讯云 TokenHub 生成成功后触发：渲染层据此刷新该账号额度（本轮未实测积分接口，预留钩子） */
  tokenhubRefreshKeyId?: string
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36'

const DEFAULT_SUPPORTED_DURATIONS = [5, 10]

function normalizeJobMode(mode?: string): string {
  if (mode === 'img' || mode === 'img2video') return 'img2video'
  if (mode === 'multi_ref' || mode === 'first_last' || mode === 'first_frame' || mode === 'firstlast') {
    return mode === 'firstlast' ? 'first_last' : mode
  }
  return 'text2video'
}

function providerLabel(providerId: string): string {
  if (providerId === 'qwenwan') return '千问（通义万相）'
  if (providerId === 'yuanbao') return '元宝混元'
  if (providerId === 'dola') return 'Dola'
  return '豆包'
}

function parseSupportedDurations(meta: { capabilities?: Record<string, unknown> | null } | undefined): number[] {
  const raw = meta?.capabilities?.supported_durations
  if (!Array.isArray(raw)) return [...DEFAULT_SUPPORTED_DURATIONS]
  const durations = raw
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n) && n > 0)
  return durations.length > 0 ? durations : [...DEFAULT_SUPPORTED_DURATIONS]
}

function providerCost(providerId: string, durationSec: number, resolution?: string): { amount: number; unitName: string } {
  const durationPoint = durationSec <= 5 ? 0 : durationSec <= 10 ? 1 : 2
  if (providerId === 'qwenwan') {
    const amount = 1 + durationPoint + (resolution === '1080' ? 1 : 0)
    return { amount, unitName: '额度' }
  }
  if (providerId === 'yuanbao') {
    return { amount: 1, unitName: '个' }
  }
  return { amount: 1 + durationPoint, unitName: '点' }
}

/**
 * 把「生成用图片」持久化为历史上存储的图片副本（供历史详情回显，不依赖外网）：
 *  - 本地路径 → 复制一份到 userData/images 存本地路径，历史显示走本地媒体服务；
 *  - http(s) 公网 URL → 原样保留（兼容旧记录 / 已上传到公网的图）。
 * 各厂商（WebView + API 分支）共用，避免重复实现。
 */
function persistJobImages(images: string[], jobId: string): string[] {
  const jobImages: string[] = []
  if (!images || images.length === 0) return jobImages
  const imgDir = join(app.getPath('userData'), 'images')
  mkdirSync(imgDir, { recursive: true })
  for (let i = 0; i < images.length; i++) {
    const img = images[i]
    try {
      if (/^https?:\/\//i.test(img)) {
        jobImages.push(img)
        continue
      }
      const ext = (/\.(png|gif|webp)$/i.exec(img)?.[1] ?? 'jpg').toLowerCase()
      const dest = join(imgDir, `${jobId}-${i}.${ext}`)
      copyFileSync(img, dest)
      jobImages.push(dest)
    } catch {}
  }
  return jobImages
}

/**
 * 参考生（r2v）参考视频本地副本持久化为历史上存储（供历史详情回显，不依赖外网）：
 *  - 本地路径 → 复制一份到 userData/videos 存本地路径；
 *  - http(s) 公网 URL → 原样保留。
 * 沿用 persistJobImages 模式，仅扩展名为 mp4 时走视频目录。
 */
function persistJobVideos(videos: string[], jobId: string): string[] {
  const jobVideos: string[] = []
  if (!videos || videos.length === 0) return jobVideos
  const videoDir = join(app.getPath('userData'), 'videos')
  mkdirSync(videoDir, { recursive: true })
  for (let i = 0; i < videos.length; i++) {
    const vid = videos[i]
    try {
      if (/^https?:\/\//i.test(vid)) {
        jobVideos.push(vid)
        continue
      }
      const dest = join(videoDir, `${jobId}-${i}.mp4`)
      copyFileSync(vid, dest)
      jobVideos.push(dest)
    } catch {}
  }
  return jobVideos
}

/** 下载视频到 userData/videos/<jobId>.mp4（生成后立即落盘，避免签名 URL 过期） */
function downloadVideo(url: string, jobId: string, providerId = 'doubao', redirects = 0): Promise<string | null> {
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
        headers: {
          'User-Agent': UA,
          Accept: '*/*',
          Referer:
            providerId === 'qwenwan'
              ? 'https://www.qianwen.com/'
              : providerId === 'yuanbao'
                ? 'https://yuanbao.tencent.com/'
                : providerId === 'dola'
                  ? 'https://www.dola.com/'
                  : 'https://www.doubao.com/'
        }
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume()
          void downloadVideo(res.headers.location, jobId, providerId, redirects + 1).then((p) => finish(!!p, p))
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

  const resolvedProviderId = input.providerId
  // 元宝当前没有独立视频生成入口，生成完全靠 chat 输入框提示词完成；
  // 这里在进入任务前补前缀，保证任务记录与页面实际发送的 prompt 一致。
  const dispatchPrompt = resolvedProviderId === 'yuanbao' ? `视频生成：${input.prompt}` : input.prompt

  // API 型厂商（智谱等）走独立分支：实体为 API Key，无 cookie 自动化，额度在平台资源包。
  if (resolvedProviderId in API_BRANCHES) {
    return runApiBranch(input, emit, onJobCreated, onQuotaUpdated)
  }
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
      mode: normalizeJobMode(input.mode),
      prompt: dispatchPrompt,
      status: 'pending',
      providerId: input.providerId
    })
  } catch (e) {
    return { ok: false, error: '创建任务失败: ' + (e instanceof Error ? e.message : String(e)) }
  }
  if (!job) return { ok: false, error: '创建任务失败' }
  emit({ jobId: job.id, status: 'pending', message: '任务已创建' })
  onJobCreated?.(job.id, runCancelState)

  // 1) 选号 + 解析凭证：默认账号优先 → 剩余额度预检 → 失败自动换号（有界）
  const costInfo = providerCost(resolvedProviderId, input.durationSec, input.resolution)
  const cost = costInfo.amount
  const costUnit = costInfo.unitName
  const images = (input.images ?? [])
    .filter((p) => typeof p === 'string' && /\.(jpe?g|png|webp|gif)$/i.test(p))
    .slice(0, resolvedProviderId === 'doubao' || resolvedProviderId === 'yuanbao' || resolvedProviderId === 'dola' ? 10 : 5)
  // 生成参数 + 上传图片副本：随任务持久化，历史详情可回显「提示词/参数/图片」（本地副本，不依赖外网）
  const jobImages = persistJobImages(images, job.id)
  const jobOptions: Record<string, unknown> = {
    mode: input.mode,
    model: input.model,
    durationSec: input.durationSec,
    ratio: input.ratio,
    audio: input.audio,
    resolution: input.resolution
  }
  if (jobImages.length > 0) jobOptions.images = jobImages
  // 按厂商把密钥过滤下推到 SQL，只回传目标厂商行，避免每次生成整表拉取 encrypted_key 大字段
  const keys = input.teamId
    ? await cachedListTeamProviderKeysWithSecrets(client, input.teamId, resolvedProviderId)
    : (await cachedListProviderKeysWithSecrets(client, input.userId, resolvedProviderId)).filter((k) => !k.team_id)
  const providerKeys = keys.filter((k) => k.enabled !== false)

  let selectedKey: { id: string; accountName: string | null } | null = null
  let result:
    | Awaited<ReturnType<typeof runDoubaoGeneration>>
    | Awaited<ReturnType<typeof runQwenGeneration>>
    | Awaited<ReturnType<typeof runYuanbaoGeneration>>
    | Awaited<ReturnType<typeof runDolaGeneration>>
    | null = null
  let lastError = ''

  if (providerKeys.length === 0) {
    const err = `未绑定${providerLabel(resolvedProviderId)}账号（请在厂商页绑定后重试）`
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
      await providerSvc.ensureProviderLedgerRows(input.userId, input.teamId ?? null, providerKeys.map((k) => k.id))
      const freshLedgers = input.teamId
        ? await providerSvc.listTeamTodayLedger(input.teamId)
        : await providerSvc.listTodayLedger(input.userId)
      const remainingOf = (keyId: string): number => {
        const row = freshLedgers.find((l) => l.account_key_id === keyId && l.date === today)
        // 用 daily_total - used - reserved 而非 remaining，与 RPC 原子扣减条件一致
        return row ? Math.max(Number(row.daily_total) - Number(row.used) - Number(row.reserved ?? 0), 0) : 0
      }
      const sorted = [...providerKeys].sort((a, b) => {
        if (!!a.is_default !== !!b.is_default) return a.is_default ? -1 : 1
        // 已失效账号排最后，避免默认账号过期时浪费尝试
        const expiredA = a.health_status === 'expired' ? 1 : 0
        const expiredB = b.health_status === 'expired' ? 1 : 0
        if (expiredA !== expiredB) return expiredA - expiredB
        return remainingOf(b.id) - remainingOf(a.id)
      })

      const tried = new Set<string>()
      for (let round = 0; round < Math.min(providerKeys.length, 3); round++) {
        const cand = sorted.find((k) => !tried.has(k.id) && remainingOf(k.id) >= cost)
        if (!cand) {
          lastError = lastError || `所有${providerLabel(resolvedProviderId)}账号剩余额度不足（本次需 ${cost} ${costUnit}）`
          break
        }
        tried.add(cand.id)
        let c: ProviderCookie[] | null = null
        let s: Array<{ key: string; value: string }> = []
        let storages: OriginStorage[] = []
        try {
          if (safeStorage.isEncryptionAvailable()) {
            const parsed = parseProviderCredentials(cand.encrypted_key, resolvedProviderId)
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
            providerId: resolvedProviderId as 'doubao' | 'qwenwan' | 'yuanbao' | 'dola',
            cancelled: true,
            error: '已手动终止生成（提示词未发送）',
            attempts: []
          }
          break
        }
        const cookies = c ?? []
        if (resolvedProviderId === 'qwenwan') {
          result = await runQwenGeneration({
            cookies,
            storages,
            prompt: dispatchPrompt,
            model: input.model,
            mode: input.mode,
            durationSec: input.durationSec,
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
        } else if (resolvedProviderId === 'yuanbao') {
          result = await runYuanbaoGeneration({
            cookies,
            storages,
            prompt: dispatchPrompt,
            images,
            keyId: cand.id,
            cancel: runCancelState,
            showWebview: input.showWebview,
            onProgress: (stage, detail) =>
              emit({ jobId: job.id, status: 'running', stage, message: stage, data: detail })
          })
        } else if (resolvedProviderId === 'dola') {
          result = await runDolaGeneration({
            cookies,
            storages,
            prompt: dispatchPrompt,
            mode: input.mode,
            model: input.model,
            durationSec: input.durationSec,
            ratio: input.ratio,
            images,
            keyId: cand.id,
            cancel: runCancelState,
            showWebview: input.showWebview,
            onProgress: (stage, detail) =>
              emit({ jobId: job.id, status: 'running', stage, message: stage, data: detail })
          })
        } else {
          result = await runDoubaoGeneration({
            cookies,
            localStorage: s,
            storages,
            prompt: dispatchPrompt,
            mode: input.mode,
            model: input.model,
            durationSec: input.durationSec,
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
        }
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
        if (/未登录|登录|API Key/.test(lastError)) {
          try {
            await providerSvc.updateHealth(input.userId, cand.id, 'expired')
            // 健康态变了会直接影响后续生成的选号排序，立即失效该 key 所在分区缓存
            invalidateKeysByKeyId(cand.id)
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
    const err = result ? result.error || lastError || '生成失败' : lastError || `未找到可用${providerLabel(resolvedProviderId)}账号`
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
    localPath = await downloadVideo(result.videoUrl, job.id, resolvedProviderId)
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
        providerId: resolvedProviderId,
        amount: cost,
        keyId: selectedKey?.id ?? null,
        jobId: job.id
      })
      if (!teamResult.ok) {
        throw new Error(`[${teamResult.code || 'UNKNOWN'}] ${teamResult.message || '额度扣减失败'}`)
      }
      consumed = teamResult.row ?? null
    } else {
      consumed = await providerSvc.consumeLedger(input.userId, resolvedProviderId, cost, {
        unitName: costUnit,
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
      costUnit,
      costAmount: cost,
      attempts: result.attempts,
      options: {
        ...jobOptions,
        remoteUrl: result.videoUrl,
        localPath: localPath || null,
        cleanLocalPath: null,
        originalLocalPath: localPath || null,
        watermarkStatus: 'none',
        watermarkMethod: null,
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
    providerId: resolvedProviderId,
    accountId: selectedKey?.id ?? null,
    resultUrl,
    costUnit,
    costAmount: cost,
    attempts: result.attempts,
    options: {
      ...jobOptions,
      remoteUrl: result.videoUrl,
      localPath: localPath || null,
      cleanLocalPath: null,
      originalLocalPath: localPath || null,
      watermarkStatus: 'none',
      watermarkMethod: null,
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

  return { ok: true, jobId: job.id }
}

/**
 * API 型厂商生成分支（智谱等）：凭证为 API Key，直接调开放平台；
 * 不做 cookie 自动化，按所选厂商直连平台 API，额度为平台资源包（生成后由渲染层刷新真实余额）。
 */
async function runApiBranch(
  input: GenerateInput,
  emit: (event: DispatchEvent) => void,
  onJobCreated?: (jobId: string, state: { aborted: boolean; submitted: boolean }) => void,
  onQuotaUpdated?: (payload: QuotaUpdatedPayload) => void
): Promise<{ ok: boolean; jobId?: string; error?: string }> {
  const providerId = input.providerId
  const branch = API_BRANCHES[providerId]

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

  const model = input.model || 'cogvideox-flash'
  if (!branch.supportedDurations(model).includes(input.durationSec)) {
    return { ok: false, error: `当前模型不支持 ${input.durationSec} 秒` }
  }

  const runCancelState: { aborted: boolean; submitted: boolean } = { aborted: false, submitted: false }

  let job
  try {
    job = await jobSvc.insertJob(input.userId, {
      teamId: input.teamId,
      mode: normalizeJobMode(input.mode),
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

  // 图片本地副本随任务持久化，历史详情离线回显；公网 http(s) URL 原样保留（兼容旧记录）
  const jobImages = persistJobImages(input.images ?? [], job.id)
  // 参考生（r2v）参考视频本地副本随任务持久化，历史详情离线回显；公网 http(s) URL 原样保留
  const jobVideos = persistJobVideos(input.videos ?? [], job.id)
  const jobOptions: Record<string, unknown> = {
    mode: input.mode,
    model,
    durationSec: input.durationSec
  }
  if (jobImages.length > 0) jobOptions.images = jobImages
  if (jobVideos.length > 0) jobOptions.videos = jobVideos
  // 音频本地副本/公网 URL 记录进 options，历史回显与重新生成回填用（本地路径与公网 URL 均原样保留）
  if (input.audioLocalPath) jobOptions.audioLocalPath = input.audioLocalPath
  if (input.audioUrl) jobOptions.audioUrl = input.audioUrl

  // 按厂商把密钥过滤下推到 SQL，只回传该厂商行，避免整表拉取 encrypted_key 大字段
  const keys = input.teamId
    ? await cachedListTeamProviderKeysWithSecrets(client, input.teamId, providerId)
    : (await cachedListProviderKeysWithSecrets(client, input.userId, providerId)).filter((k) => !k.team_id)
  const providerKeys = keys.filter((k) => k.enabled !== false)
  // 选号：厂商实现 pick 时按其策略在多个已启用账号间选最优（如火山按「是否开通+剩余额度」），
  // 否则回退现状：默认账号优先，无默认取首个可用账号。
  let cand = providerKeys.find((k) => k.is_default) ?? providerKeys[0]
  let plain = ''
  if (branch.pick && providerKeys.length > 0) {
    try {
      const list = providerKeys.map((k) => ({
        id: k.id,
        accountName: k.account_name ?? null,
        isDefault: !!k.is_default,
        enabled: k.enabled !== false,
        plain: safeStorage.isEncryptionAvailable()
          ? safeStorage.decryptString(Buffer.from(k.encrypted_key ?? '', 'base64'))
          : ''
      }))
      const idx = branch.pick(list, model)
      if (idx != null && providerKeys[idx]) {
        cand = providerKeys[idx]
        plain = list[idx]?.plain ?? ''
      }
    } catch {
      // 选号异常：回退默认/首个，不阻断
    }
  }
  if (!cand) {
    const err = `未绑定${branch.displayName}账号（请在厂商页绑定后重试）`
    await jobSvc.updateJob(input.userId, job.id, {
      status: 'failed',
      error: err,
      options: jobOptions,
      completedAt: new Date().toISOString()
    })
    emit({ jobId: job.id, status: 'failed', message: err })
    return { ok: false, jobId: job.id, error: err }
  }

  let creds: ApiCredential | null = null
  try {
    if (!plain && safeStorage.isEncryptionAvailable()) {
      plain = safeStorage.decryptString(Buffer.from(cand.encrypted_key ?? '', 'base64'))
    }
    creds = branch.parseCredentials(plain)
  } catch {
    creds = null
  }

  // 提交前预检：模型未开通 / 免费额度用完等，在向 API 提交之前拦截，避免白跑
  if (branch.preflight) {
    const pf = branch.preflight(model, plain, { durationSec: input.durationSec })
    if (!pf.ok) {
      await jobSvc.updateJob(input.userId, job.id, {
        status: 'failed',
        error: pf.reason,
        options: jobOptions,
        completedAt: new Date().toISOString()
      })
      emit({ jobId: job.id, status: 'failed', message: pf.reason })
      return { ok: false, jobId: job.id, error: pf.reason }
    }
  }

  if (!creds) {
    const err = '账号「' + (cand.account_name || '未命名') + '」凭据解密失败'
    await jobSvc.updateJob(input.userId, job.id, {
      status: 'failed',
      error: err,
      options: jobOptions,
      completedAt: new Date().toISOString()
    })
    emit({ jobId: job.id, status: 'failed', message: err })
    return { ok: false, jobId: job.id, error: err }
  }

  await jobSvc.updateJob(input.userId, job.id, {
    status: 'running',
    accountId: cand.id,
    options: { ...jobOptions, accountId: cand.id, accountName: cand.account_name }
  })
  emit({
    jobId: job.id,
    status: 'running',
    stage: 'select-account',
    message: `使用账号：${cand.account_name || '未命名'}`
  })

  if (runCancelState.aborted) {
    await jobSvc.updateJob(input.userId, job.id, {
      status: 'interrupted',
      error: '已手动终止生成',
      options: jobOptions,
      completedAt: new Date().toISOString()
    })
    return { ok: false, jobId: job.id, error: '已手动终止生成' }
  }

  const rawMode = normalizeJobMode(input.mode)
  const mode: ApiGenerateParams['mode'] =
    rawMode === 'text2video' || rawMode === 'first_last' || rawMode === 'multi_ref' ? rawMode : 'img2video'
  const params: ApiGenerateParams = {
    mode,
    model,
    prompt: input.prompt,
    // 图生/首尾/参考生图片为前端上传后的公网 https URL（imageUrls）；厂商不依赖历史本地展示路径
    images: input.imageUrls ?? input.images ?? [],
    // 参考生（r2v）视频为前端上传后的公网 https URL（videoUrls）；厂商不依赖历史本地展示路径
    videos: input.videoUrls ?? input.videos ?? [],
    audioUrl: input.audioUrl,
    template: input.template,
    durationSec: input.durationSec,
    onProgress: (msg) => emit({ jobId: job.id, status: 'running', stage: 'progress', message: msg })
  }
  const res = await branch.generate(input, creds, params)
  if (!res.ok || !res.videoUrl) {
    const err = res.error || '生成失败'
    // 火山方舟提交失败且平台判定模型不可用（无接入点 / 已下架）→ 立即写不可用标记落库，后续生成前拦截 + 查看模型置灰
    if (providerId === 'volcengine' && res.unavailable && model && plain) {
      const marked = markVolcModelUnavailable(plain, model, res.unavailable)
      if (marked.ok && safeStorage.isEncryptionAvailable()) {
        try {
          await providerSvc.refreshProviderKey(input.userId, cand.id, {
            encryptedKey: safeStorage.encryptString(marked.plain).toString('base64')
          })
          // encrypted_key 已更新（落不可用标记），失效缓存避免复用旧负载
          invalidateKeysByKeyId(cand.id)
        } catch {
          // 标记写库失败不回滚本次生成失败
        }
      }
    }
    await jobSvc.updateJob(input.userId, job.id, {
      status: 'failed',
      error: err,
      options: jobOptions,
      completedAt: new Date().toISOString()
    })
    emit({ jobId: job.id, status: 'failed', message: err })
    // 生成失败也延迟清理参考图/音频公网 URL：厂商已不会再拉取，避免残留撑大 GitHub 仓库
    setTimeout(() => {
      void deleteImages([...(input.imageUrls ?? []), ...(input.audioUrl ? [input.audioUrl] : [])]).catch(() => {})
    }, 10 * 60 * 1000)
    return { ok: false, jobId: job.id, error: err }
  }

  let localPath: string | null = null
  try {
    localPath = await downloadVideo(res.videoUrl, job.id, providerId)
  } catch {
    // 下载失败不阻断成功返回，回落远程 URL
  }
  const resultUrl = localPath || res.videoUrl
  const cost = branch.cost(model)

  await jobSvc.updateJob(input.userId, job.id, {
    status: 'success',
    providerId,
    accountId: cand.id,
    resultUrl,
    costUnit: branch.unitName,
    costAmount: cost,
    attempts: [],
    options: {
      ...jobOptions,
      remoteUrl: res.videoUrl,
      localPath: localPath || null,
      accountId: cand.id,
      accountName: cand.account_name
    }
  })
  emit({
    jobId: job.id,
    status: 'success',
    message: '生成成功',
    data: { resultUrl, cost, localPath, accountId: cand.id }
  })

  // 参考图/音频公网 URL 仅供生成瞬间给厂商拉取；生成成功后延迟清理，避免日积月累撑大 GitHub 仓库。
  // 本地历史副本（userData/images）不受影响；延迟给用户留出「成功后再点一次生成」的窗口。
  setTimeout(() => {
    void deleteImages([...(input.imageUrls ?? []), ...(input.audioUrl ? [input.audioUrl] : [])]).catch(() => {})
  }, 10 * 60 * 1000)

  // 火山方舟生成成功 → 自愈清除该模型的历史不可用标记（平台恢复可用即重新放行）
  if (providerId === 'volcengine' && model && plain) {
    const cleared = clearVolcModelUnavailable(plain, model)
    if (cleared.ok && safeStorage.isEncryptionAvailable()) {
      try {
        await providerSvc.refreshProviderKey(input.userId, cand.id, {
          encryptedKey: safeStorage.encryptString(cleared.plain).toString('base64')
        })
        // encrypted_key 已更新（清除不可用标记），失效缓存避免复用旧负载
        invalidateKeysByKeyId(cand.id)
      } catch {
        // 自愈写库失败不影响生成成功返回
      }
    }
  }

  // API 型厂商本地账本不做原子扣减（真实额度在平台）；生成完成后下发热点字段，
  // 渲染层据此重新拉取/同步该账号真实额度：智谱走 fetch-quota，火山走开通管理页静默同步。
  onQuotaUpdated?.({
    userId: input.userId,
    ledger: {
      id: job.id,
      date: todayKey(),
      team_id: input.teamId ?? null,
      owner_user_id: input.userId,
      account_key_id: cand.id,
      provider_id: providerId,
      unit_name: branch.unitName,
      daily_total: 0,
      used: 0,
      remaining: 0,
      reserved: 0,
      refreshed_at: new Date().toISOString()
    },
    ...(providerId === 'volcengine'
      ? { volcRefreshKeyId: cand.id }
      : providerId === 'bailian'
        ? { bailianRefreshKeyId: cand.id }
        : providerId === 'tokenhub'
          ? { tokenhubRefreshKeyId: cand.id }
          : { zhipuRefreshKeyId: cand.id })
  })
  return { ok: true, jobId: job.id }
}
