import { app } from 'electron'
import { join } from 'node:path'
import { createSupabaseClient, JobService } from '@quota-flow/db-supabase'
import { removeWatermark } from './engine'
import type { WatermarkBBox, WatermarkProgress, WatermarkResult } from './engine'

export interface WatermarkJobInput {
  supabaseUrl: string
  supabaseAnonKey: string
  accessToken: string
  refreshToken: string
  userId: string
  jobId: string
  bbox?: WatermarkBBox | null
  bboxes?: WatermarkBBox[] | null
  signal?: AbortSignal
  onProgress?: (progress: WatermarkProgress) => void
}

function readOptions(job: { options?: Record<string, unknown> | null }): Record<string, unknown> {
  return (job.options ?? {}) as Record<string, unknown>
}

function readWatermarkBBox(value: unknown): WatermarkBBox | null {
  if (!value || typeof value !== 'object') return null
  const bbox = value as Record<string, unknown>
  if (
    typeof bbox.x !== 'number' ||
    typeof bbox.y !== 'number' ||
    typeof bbox.width !== 'number' ||
    typeof bbox.height !== 'number' ||
    !Number.isFinite(bbox.x) ||
    !Number.isFinite(bbox.y) ||
    !Number.isFinite(bbox.width) ||
    !Number.isFinite(bbox.height)
  ) {
    return null
  }
  return {
    x: Math.max(0, Math.round(bbox.x)),
    y: Math.max(0, Math.round(bbox.y)),
    width: Math.max(0, Math.round(bbox.width)),
    height: Math.max(0, Math.round(bbox.height))
  }
}

function readWatermarkBBoxes(value: unknown): WatermarkBBox[] | null {
  if (!Array.isArray(value)) return null
  const boxes = value
    .map((item) => readWatermarkBBox(item))
    .filter((bbox): bbox is WatermarkBBox => bbox !== null)
  return boxes.length > 0 ? boxes : null
}

export async function processWatermarkJob(input: WatermarkJobInput): Promise<WatermarkResult> {
  try {
    const client = createSupabaseClient({
      supabaseUrl: input.supabaseUrl,
      supabaseAnonKey: input.supabaseAnonKey
    })
    await client.auth.setSession({ access_token: input.accessToken, refresh_token: input.refreshToken })
    const jobSvc = new JobService(client)
    const jobs = await jobSvc.listJobs(input.userId)
    const job = jobs.find((j) => j.id === input.jobId)
    if (!job) {
      return { ok: false, status: 'failed', error: '任务不存在' }
    }

    const opts = readOptions(job)
    const localPath = typeof opts.localPath === 'string' && opts.localPath ? opts.localPath : null
    if (!localPath) {
      return { ok: false, status: 'failed', error: '没有本地原视频，无法去水印' }
    }

    const savedBBox = readWatermarkBBox(opts.watermarkBBox)
    const savedBBoxes = readWatermarkBBoxes(opts.watermarkBBoxes) ?? (savedBBox ? [savedBBox] : null)
    const bboxes = input.bboxes?.length
      ? input.bboxes
      : input.bbox
        ? [input.bbox]
        : savedBBoxes
    const manualBBoxes = input.bboxes?.length
      ? input.bboxes
      : input.bbox
        ? [input.bbox]
        : savedBBoxes
    const cleanPath = join(app.getPath('userData'), 'videos', `${input.jobId}.clean.mp4`)
    const processingOptions = {
      ...opts,
      watermarkStatus: 'processing',
      watermarkMethod: 'delogo',
      watermarkError: null,
      watermarkBBox: manualBBoxes?.[0] ?? null,
      watermarkBBoxes: manualBBoxes ?? null
    }
    await jobSvc.updateJob(input.userId, input.jobId, {
      status: 'success',
      options: processingOptions
    })

    const result = await removeWatermark({
      inputPath: localPath,
      outputPath: cleanPath,
      jobId: input.jobId,
      bboxes,
      signal: input.signal,
      onProgress: (progress) => input.onProgress?.(progress)
    })

    const usedBBoxes = result.bboxes?.length ? result.bboxes : manualBBoxes
    const finalOptions = {
      ...processingOptions,
      cleanLocalPath: result.ok ? (result.outputPath ?? cleanPath) : null,
      originalLocalPath: localPath,
      watermarkStatus: result.status,
      watermarkMethod: result.method ?? 'delogo',
      watermarkError: result.error ?? null,
      watermarkBBox: usedBBoxes?.[0] ?? null,
      watermarkBBoxes: usedBBoxes ?? null
    }
    await jobSvc.updateJob(input.userId, input.jobId, {
      status: 'success',
      options: finalOptions
    })

    return result
  } catch (e) {
    return {
      ok: false,
      status: 'failed',
      error: e instanceof Error ? e.message : String(e)
    }
  }
}

export interface WatermarkStatusPayload {
  ok: boolean
  jobId: string
  watermarkStatus?: string | null
  cleanLocalPath?: string | null
  originalLocalPath?: string | null
  watermarkMethod?: string | null
  watermarkError?: string | null
  watermarkBBox?: WatermarkBBox | null
  watermarkBBoxes?: WatermarkBBox[] | null
  error?: string
}

export async function getWatermarkStatus(
  input: Pick<WatermarkJobInput, 'supabaseUrl' | 'supabaseAnonKey' | 'accessToken' | 'refreshToken' | 'userId' | 'jobId'>
): Promise<WatermarkStatusPayload> {
  try {
    const client = createSupabaseClient({
      supabaseUrl: input.supabaseUrl,
      supabaseAnonKey: input.supabaseAnonKey
    })
    await client.auth.setSession({ access_token: input.accessToken, refresh_token: input.refreshToken })
    const jobSvc = new JobService(client)
    const jobs = await jobSvc.listJobs(input.userId)
    const job = jobs.find((j) => j.id === input.jobId)
    if (!job) {
      return { ok: false, jobId: input.jobId, error: '任务不存在' }
    }
    const opts = readOptions(job)
    return {
      ok: true,
      jobId: job.id,
      watermarkStatus: typeof opts.watermarkStatus === 'string' ? opts.watermarkStatus : null,
      cleanLocalPath: typeof opts.cleanLocalPath === 'string' ? opts.cleanLocalPath : null,
      originalLocalPath: typeof opts.originalLocalPath === 'string' ? opts.originalLocalPath : null,
      watermarkMethod: typeof opts.watermarkMethod === 'string' ? opts.watermarkMethod : null,
      watermarkError: typeof opts.watermarkError === 'string' ? opts.watermarkError : null,
      watermarkBBox: readWatermarkBBox(opts.watermarkBBox),
      watermarkBBoxes: readWatermarkBBoxes(opts.watermarkBBoxes) ?? (readWatermarkBBox(opts.watermarkBBox) ? [readWatermarkBBox(opts.watermarkBBox) as WatermarkBBox] : null)
    }
  } catch (e) {
    return {
      ok: false,
      jobId: input.jobId,
      error: e instanceof Error ? e.message : String(e)
    }
  }
}
