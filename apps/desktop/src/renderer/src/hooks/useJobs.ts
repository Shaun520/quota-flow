import { useCallback, useEffect, useRef, useState } from 'react'
import { getJobService } from '../auth/service'
import { ensureFreshSession, isAuthError } from '../auth/session'
import { useAuth } from './useAuth'
import { errMsg } from '../utils/error'
import type { JobRow } from '@quota-flow/db-supabase'
import type { HistoryStatus, JobRecord } from '../../../shared/history'

const PROVIDER_NAME: Record<string, string> = {
  mathmind: 'MathMind', qwenwan: '通义万相', qwen: '通义万相', yuanbao: '元宝混元',
  doubao: '豆包', jimeng: '即梦', kling: '可灵', hailuo: '海螺'
}

const MODE_LABEL: Record<string, string> = {
  text2video: '文生视频', img2video: '图生视频',
  video2video: '视频转视频', imgs2video: '多图生视频'
}

const UNIT_MAP: Record<string, string> = {
  mathmind: '次', qwenwan: '额度', qwen: '额度', yuanbao: '个', doubao: '点',
  jimeng: '灵感值', kling: '积分', hailuo: '次'
}

const STATUS_MAP: Record<string, HistoryStatus> = {
  success: '成功',
  failed: '失败',
  pending: '排队',
  running: '排队',
  not_generated: '未生成'
}

export interface JobItem {
  id: string
  record: JobRecord
}

function toJobItem(row: JobRow): JobItem {
  const pid = row.provider_id ?? ''
  const quotaUsed = Number(row.cost_amount ?? 0)
  const opts = (row.options ?? {}) as Record<string, unknown>
  const accountName = typeof opts.accountName === 'string' && opts.accountName ? opts.accountName : null
  const localPath =
    typeof opts.localPath === 'string' && opts.localPath
      ? opts.localPath
      : row.result_url && !/^https?:/i.test(row.result_url)
        ? row.result_url
        : null
  const params =
    opts.mode || opts.durationSec || opts.ratio || opts.audio || opts.resolution
      ? {
          mode: typeof opts.mode === 'string' ? opts.mode : undefined,
          durationSec: typeof opts.durationSec === 'number' ? opts.durationSec : undefined,
          ratio: typeof opts.ratio === 'string' ? opts.ratio : undefined,
          audio: typeof opts.audio === 'string' ? opts.audio : undefined,
          resolution: typeof opts.resolution === 'string' ? opts.resolution : undefined
        }
      : null
  const images = Array.isArray(opts.images)
    ? opts.images.filter((p): p is string => typeof p === 'string')
    : []
  return {
    id: row.id,
    record: {
      at: row.created_at,
      provider: PROVIDER_NAME[pid] ?? (pid || '—'),
      accountName,
      mode: MODE_LABEL[row.mode] ?? row.mode,
      prompt: row.prompt ?? '',
      cost: quotaUsed > 0 ? `${quotaUsed} ${UNIT_MAP[pid] ?? row.cost_unit ?? '次'}` : '-',
      status: STATUS_MAP[row.status] ?? '失败',
      traceId: row.trace_id ?? null,
      resultUrl: row.result_url ?? null,
      localPath,
      params,
      images,
      errorMessage: row.error ?? null
    }
  }
}

export interface JobsResult {
  loading: boolean
  error: string | null
  items: JobItem[]
  reload: () => void
  remove: (jobId: string) => Promise<boolean>
  removeMany: (ids: string[]) => Promise<number>
}

export function useJobs(): JobsResult {
  const { user } = useAuth()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [items, setItems] = useState<JobItem[]>([])
  const [reloadKey, setReloadKey] = useState(0)
  // 是否已加载过：首次加载显示 loading，后续刷新静默（保留旧数据，避免整页闪“加载中”）
  const loadedRef = useRef(false)

  const reload = useCallback(() => setReloadKey((k) => k + 1), [])

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
    svc
      .listJobs()
      .then((rows) => {
        if (!cancelled) {
          loadedRef.current = true
          setItems(rows.map(toJobItem))
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

  return { loading, error, items, reload, remove, removeMany }
}
