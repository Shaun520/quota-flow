import { useCallback, useEffect, useRef, useState } from 'react'
import { getJobService } from '../auth/service'
import { ensureFreshSession, isAuthError } from '../auth/session'
import { useAuth } from './useAuth'
import { errMsg } from '../utils/error'
import type { JobListItem, JobListQuery, JobStatus } from '@quota-flow/db-supabase'
import type { HistoryStatus, JobRecord, WatermarkBBox, WatermarkStatus } from '../../../shared/history'

const PAGE_SIZE = 10

const PROVIDER_NAME: Record<string, string> = {
  qwenwan: '通义万相', qwen: '通义万相', yuanbao: '元宝混元',
  doubao: '豆包', jimeng: '即梦', kling: '可灵', hailuo: '海螺'
}

const MODE_LABEL: Record<string, string> = {
  text2video: '文生视频', img2video: '图生视频',
  video2video: '视频转视频', imgs2video: '多图生视频',
  multi_ref: '多参考生成', first_last: '首尾帧生成', first_frame: '首帧生成'
}

const UNIT_MAP: Record<string, string> = {
  qwenwan: '额度', qwen: '额度', yuanbao: '个', doubao: '点',
  jimeng: '灵感值', kling: '积分', hailuo: '次'
}

const STATUS_MAP: Record<string, HistoryStatus> = {
  success: '成功',
  failed: '失败',
  pending: '排队',
  running: '排队',
  not_generated: '未生成',
  interrupted: '意外中断'
}

export interface JobItem {
  id: string
  record: JobRecord
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((p): p is string => typeof p === 'string') : []
}

function toJobItem(row: JobListItem): JobItem {
  const pid = row.provider_id ?? ''
  const quotaUsed = Number(row.cost_amount ?? 0)
  const watermarkBBox = readWatermarkBBox(row.watermarkBBox)
  const watermarkBBoxes = readWatermarkBBoxes(row.watermarkBBoxes, watermarkBBox)
  const accountName = readString(row.accountName)
  const localPath = readString(row.localPath) ?? (
    row.result_url && !/^https?:/i.test(row.result_url) ? row.result_url : null
  )
  const cleanLocalPath = readString(row.cleanLocalPath)
  const watermarkStatus = readString(row.watermarkStatus) as WatermarkStatus | null
  const watermarkMethod = readString(row.watermarkMethod)
  const watermarkError = readString(row.watermarkError)
  const durationSec = readNumber(row.durationSec)
  const params =
    row.mode || durationSec || row.ratio || row.audio || row.resolution
      ? {
          mode: row.mode,
          durationSec: durationSec ?? undefined,
          ratio: readString(row.ratio) ?? undefined,
          audio: readString(row.audio) ?? undefined,
          resolution: readString(row.resolution) ?? undefined
        }
      : null
  const images = readStringArray(row.images)
  return {
    id: row.id,
    record: {
      at: row.created_at,
      provider: PROVIDER_NAME[pid] ?? (pid || '—'),
      providerId: pid || undefined,
      model: readString(row.model) ?? undefined,
      accountName,
      mode: MODE_LABEL[row.mode] ?? row.mode,
      prompt: row.prompt ?? '',
      cost: quotaUsed > 0 ? `${quotaUsed} ${UNIT_MAP[pid] ?? row.cost_unit ?? '次'}` : '-',
      status: STATUS_MAP[row.status] ?? '失败',
      traceId: row.trace_id ?? null,
      resultUrl: row.result_url ?? null,
      localPath,
      cleanLocalPath,
      watermarkStatus,
      watermarkMethod,
      watermarkError,
      watermarkBBox,
      watermarkBBoxes,
      params,
      images,
      errorMessage: row.error ?? null
    }
  }
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

function readWatermarkBBoxes(value: unknown, fallback: WatermarkBBox | null): WatermarkBBox[] | null {
  if (Array.isArray(value)) {
    const boxes = value
      .map((item) => readWatermarkBBox(item))
      .filter((bbox): bbox is WatermarkBBox => bbox !== null)
    return boxes.length > 0 ? boxes : fallback ? [fallback] : null
  }
  return fallback ? [fallback] : null
}

export interface JobsResult {
  loading: boolean
  error: string | null
  items: JobItem[]
  total: number
  page: number
  hasAnySuccess: boolean
  setPage: (page: number) => void
  setFilters: (filters: Partial<JobFilters>) => void
  reload: () => void
  remove: (jobId: string) => Promise<boolean>
  removeMany: (ids: string[]) => Promise<number>
}

export interface JobFilters {
  search: string
  providerId: string
  status: JobStatus | ''
}

export function useJobs(): JobsResult {
  const { user } = useAuth()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [items, setItems] = useState<JobItem[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [filters, setFiltersState] = useState<JobFilters>({ search: '', providerId: '', status: '' })
  const [hasAnySuccess, setHasAnySuccess] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  // 是否已加载过：首次加载显示 loading，后续刷新静默（保留旧数据，避免整页闪“加载中”）
  const loadedRef = useRef(false)

  const reload = useCallback(() => setReloadKey((k) => k + 1), [])
  const setFilters = useCallback((next: Partial<JobFilters>) => {
    setFiltersState((prev) => ({ ...prev, ...next }))
    setPage(1)
  }, [])

  useEffect(() => {
    let cancelled = false
    if (!user) {
      setLoading(false)
      return
    }
    const svc = getJobService()
    if (!svc) {
      setLoading(false)
      setError('Supabase 未配置，无法加载历史记录')
      return
    }
    if (!loadedRef.current) setLoading(true)
    setError(null)
    const query: JobListQuery = {
      page,
      pageSize: PAGE_SIZE,
      search: filters.search,
      providerId: filters.providerId || undefined,
      status: filters.status || undefined
    }
    svc
      .listJobs(user.id, query)
      .then((res) => {
        if (!cancelled) {
          loadedRef.current = true
          setItems(res.items.map(toJobItem))
          setTotal(res.total)
          setPage(res.page)
        }
      })
      .catch(async (e: unknown) => {
        if (cancelled) return
        if (isAuthError(e)) {
          const guard = await ensureFreshSession()
          if (cancelled) return
          if (guard.ok && guard.refreshed) {
            // 续期成功：重试一次（刷新过才会重试，避免无限循环）
            setReloadKey((k) => k + 1)
            return
          }
          setError(guard.ok ? errMsg(e) : '登录已过期，请重新登录')
        } else {
          setError(errMsg(e))
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [user?.id, reloadKey, page, filters.search, filters.providerId, filters.status])

  useEffect(() => {
    let cancelled = false
    if (!user) return
    const svc = getJobService()
    if (!svc) return
    svc
      .hasAnySuccess(user.id)
      .then((value) => {
        if (!cancelled) setHasAnySuccess(value)
      })
      .catch(() => {
        // 非关键：只影响欢迎横幅是否把用户视为已完成首次生成。
      })
    return () => {
      cancelled = true
    }
  }, [user?.id, reloadKey])

  const remove = useCallback(
    async (jobId: string): Promise<boolean> => {
      const svc = getJobService()
      if (!svc || !user) return false
      try {
        const ok = await svc.deleteJob(user.id, jobId)
        if (ok) reload()
        return ok
      } catch (e) {
        setError(errMsg(e))
        return false
      }
    },
    [reload, user]
  )

  const removeMany = useCallback(
    async (ids: string[]): Promise<number> => {
      const svc = getJobService()
      if (!svc || !user || ids.length === 0) return 0
      try {
        const n = await svc.deleteJobs(user.id, ids)
        if (n > 0) reload()
        return n
      } catch (e) {
        setError(errMsg(e))
        return 0
      }
    },
    [reload, user]
  )

  return { loading, error, items, total, page, hasAnySuccess, setPage, setFilters, reload, remove, removeMany }
}
