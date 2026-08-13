import { execFile, execFileSync } from 'node:child_process'
import { existsSync, renameSync, rmSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import ffmpegStaticPath from 'ffmpeg-static'
import type { WatermarkBBox } from '../../shared/history'

export type WatermarkStatus = 'none' | 'pending' | 'processing' | 'done' | 'failed' | 'needs_bbox' | 'cancelled'

export type { WatermarkBBox }

export interface WatermarkProgress {
  jobId: string
  stage: 'detect' | 'ffmpeg' | 'inpaint' | 'done' | 'failed' | 'cancelled'
  progress: number
  message?: string
}

export interface WatermarkRequest {
  inputPath: string
  outputPath: string
  jobId: string
  bbox?: WatermarkBBox | null
  bboxes?: WatermarkBBox[] | null
  mode?: 'auto' | 'delogo' | 'inpaint'
  signal?: AbortSignal
  onProgress?: (progress: WatermarkProgress) => void
}

export interface WatermarkResult {
  ok: boolean
  outputPath?: string
  bbox?: WatermarkBBox | null
  bboxes?: WatermarkBBox[] | null
  method?: string
  status: WatermarkStatus
  error?: string
}

const isWindows = process.platform === 'win32'

function systemFfmpeg(): string | null {
  try {
    execFileSync(isWindows ? 'where' : 'which', ['ffmpeg'], {
      stdio: 'ignore',
      windowsHide: true
    })
    return 'ffmpeg'
  } catch {
    return null
  }
}

export function resolveFfmpegPath(): string | null {
  const candidates = [
    process.env.FFMPEG_PATH,
    process.env.FFMPEG_BIN,
    join(process.resourcesPath ?? '', 'ffmpeg', isWindows ? 'ffmpeg.exe' : 'ffmpeg'),
    join(process.resourcesPath ?? '', 'bin', isWindows ? 'ffmpeg.exe' : 'ffmpeg'),
    ffmpegStaticPath
  ]
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate
  }
  return systemFfmpeg()
}

function parseDurationMs(text: string): number {
  const match = /(\d+):(\d+):(\d+\.?\d*)/.exec(text)
  if (!match) return 0
  const h = Number(match[1])
  const m = Number(match[2])
  const s = Number(match[3])
  return (h * 60 * 60 + m * 60 + s) * 1000
}

function probeVideo(ffmpeg: string, inputPath: string, signal?: AbortSignal): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    execFile(
      ffmpeg,
      ['-i', inputPath],
      { maxBuffer: 16 * 1024 * 1024, windowsHide: true, signal },
      (error, _stdout, stderr) => {
        const text = `${stderr}${_stdout}`
        const match = /Video:.*?(\d{2,5})x(\d{2,5})/.exec(text)
        if (!match) {
          if (signal?.aborted) {
            reject(new Error('去水印已取消'))
            return
          }
          reject(new Error(`无法解析视频尺寸: ${text.slice(-240)}`))
          return
        }
        resolve({ width: Number(match[1]), height: Number(match[2]) })
      }
    )
  })
}

function runFfmpeg(
  ffmpeg: string,
  args: string[],
  onProgress?: (progress: WatermarkProgress) => void,
  signal?: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    let durationMs = 0
    const child = execFile(
      ffmpeg,
      args,
      { maxBuffer: 256 * 1024 * 1024, windowsHide: true, signal },
      (error) => {
        if (error) reject(error)
        else resolve()
      }
    )
    child.stderr?.on('data', (chunk: Buffer | string) => {
      const text = String(chunk)
      if (!durationMs) durationMs = parseDurationMs(text)
      const time = /time=(\d+):(\d+):(\d+\.?\d*)/.exec(text)
      if (time && durationMs > 0) {
        const currentMs = parseDurationMs(time[0])
        onProgress?.({
          jobId: '',
          stage: 'ffmpeg',
          progress: Math.min(0.99, currentMs / durationMs),
          message: '正在重编码视频…'
        })
      }
    })
  })
}

function defaultWatermarkBBox(width: number, height: number): WatermarkBBox {
  const boxWidth = Math.max(56, Math.round(width * 0.16))
  const boxHeight = Math.max(18, Math.round(height * 0.03))
  return {
    x: width - boxWidth - Math.max(8, Math.round(width * 0.02)),
    y: height - boxHeight - Math.max(8, Math.round(height * 0.02)),
    width: boxWidth,
    height: boxHeight
  }
}

function uniqueCleanOutputPath(outputPath: string): string {
  const dir = dirname(outputPath)
  const ext = extname(outputPath)
  const base = basename(outputPath, ext)
  return join(dir, `${base}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}${ext}`)
}

function normalizeWatermarkBBox(raw: WatermarkBBox, width: number, height: number): WatermarkBBox | null {
  if (
    !Number.isFinite(raw.x) ||
    !Number.isFinite(raw.y) ||
    !Number.isFinite(raw.width) ||
    !Number.isFinite(raw.height) ||
    raw.width <= 0 ||
    raw.height <= 0
  ) {
    return null
  }

  const minX = 1
  const minY = 1
  const maxX = Math.max(minX, width - 1)
  const maxY = Math.max(minY, height - 1)

  const left = Math.max(minX, Math.min(maxX, Math.round(raw.x)))
  const top = Math.max(minY, Math.min(maxY, Math.round(raw.y)))
  const right = Math.max(minX, Math.min(maxX, Math.round(raw.x) + Math.round(raw.width)))
  const bottom = Math.max(minY, Math.min(maxY, Math.round(raw.y) + Math.round(raw.height)))

  const normalized = {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top
  }
  if (normalized.width <= 0 || normalized.height <= 0) return null
  return normalized
}

export async function removeWatermark(request: WatermarkRequest): Promise<WatermarkResult> {
  const ffmpeg = resolveFfmpegPath()
  if (request.signal?.aborted) {
    return { ok: false, status: 'cancelled', method: 'delogo', error: '去水印已取消' }
  }
  if (!ffmpeg) {
    return {
      ok: false,
      status: 'failed',
      error: '未找到 FFmpeg，请安装 ffmpeg-static 或设置 FFMPEG_PATH'
    }
  }
  if (!existsSync(request.inputPath)) {
    return { ok: false, status: 'failed', error: '原视频不存在，无法去水印' }
  }

  try {
    const { width, height } = await probeVideo(ffmpeg, request.inputPath, request.signal)
    const rawBoxes = request.bboxes?.length
      ? request.bboxes
      : request.bbox
        ? [request.bbox]
        : [defaultWatermarkBBox(width, height)]
    const bboxes: WatermarkBBox[] = []
    for (const raw of rawBoxes) {
      const normalized = normalizeWatermarkBBox(raw, width, height)
      if (!normalized) {
        return { ok: false, status: 'needs_bbox', error: '水印区域无效或超出画面，请重新框选' }
      }
      bboxes.push(normalized)
    }

    request.onProgress?.({
      jobId: request.jobId,
      stage: 'ffmpeg',
      progress: 0.05,
      message: '开始本地去水印…'
    })

    const finalOutput = request.outputPath
    const workingOutput = uniqueCleanOutputPath(finalOutput)
    rmSync(workingOutput, { force: true })
    const filter = bboxes
      .map((bbox) => `delogo=x=${bbox.x}:y=${bbox.y}:w=${bbox.width}:h=${bbox.height}:show=0`)
      .join(',')
    await runFfmpeg(
      ffmpeg,
      [
        '-y',
        '-i',
        request.inputPath,
        '-vf',
        filter,
        '-c:v',
        'libx264',
        '-preset',
        'medium',
        '-crf',
        '18',
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        '-movflags',
        '+faststart',
        workingOutput
      ],
      (progress) => request.onProgress?.({ ...progress, jobId: request.jobId }),
      request.signal
    )

    let outputPath = workingOutput
    if (workingOutput !== finalOutput) {
      try {
        rmSync(finalOutput, { force: true })
        renameSync(workingOutput, finalOutput)
        outputPath = finalOutput
      } catch {
        outputPath = workingOutput
      }
    }

    request.onProgress?.({
      jobId: request.jobId,
      stage: 'done',
      progress: 1,
      message: '去水印完成'
    })
    return {
      ok: true,
      outputPath,
      bboxes,
      method: 'delogo',
      status: 'done'
    }
  } catch (e) {
    if (request.signal?.aborted) {
      return {
        ok: false,
        status: 'cancelled',
        method: 'delogo',
        error: '去水印已取消'
      }
    }
    return {
      ok: false,
      status: 'failed',
      method: 'delogo',
      error: e instanceof Error ? e.message : String(e)
    }
  }
}
