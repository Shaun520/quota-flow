import { useCallback, useEffect, useMemo, useState } from 'react'
import { getAuthService } from '../auth/service'
import { ensureFreshSession } from '../auth/session'
import { errMsg } from '../utils/error'

/**
 * 厂商生成能力（modes / models），key = provider id。
 * 缺省（undefined）＝ 桌面端未配置，回退到 spec.ts 硬编码默认；
 * 命中行则 modes/models 为该厂商唯一可选项（空数组＝屏蔽）。
 */
export interface ProviderCaps {
  modes?: string[]
  models?: string[]
}
export type ProviderCapsMap = Record<string, ProviderCaps>

interface CapsRow {
  target_type: 'global' | 'team'
  target_id: string | null
  provider: string
  modes: string[]
  models: string[]
}

function applyRows(rows: CapsRow[]): ProviderCapsMap {
  const map: ProviderCapsMap = {}
  // 按 provider 分组，写者覆盖：先 global 后 team，team 命中即覆盖 global
  const order: Record<string, CapsRow[]> = {}
  for (const row of rows) {
    ;(order[row.provider] ??= []).push(row)
  }
  for (const provider of Object.keys(order)) {
    const rowsForProvider = order[provider]
    // 该 provider 有 team 行则取 team 行（纯覆盖）；否则取 global 行
    const team = rowsForProvider.find((r) => r.target_type === 'team')
    const picked = team ?? rowsForProvider.find((r) => r.target_type === 'global')
    if (picked) {
      map[provider] = {
        modes: picked.modes ?? [],
        models: picked.models ?? []
      }
    }
  }
  return map
}

export function useProviderCaps(userId?: string, teamId?: string | null): ProviderCapsMap {
  const [caps, setCaps] = useState<ProviderCapsMap>(() => ({}))
  const [reloadKey, setReloadKey] = useState(0)

  const reload = useCallback(() => setReloadKey((k) => k + 1), [])

  const load = useCallback(async () => {
    if (!userId) {
      setCaps({})
      return
    }
    const auth = getAuthService()
    if (!auth) return
    const guard = await ensureFreshSession()
    if (!guard.ok) return
    const client = auth.getClient()
    try {
      const { data: globalRows, error: globalError } = await client
        .from('provider_caps')
        .select('target_type,target_id,provider,modes,models')
        .eq('target_type', 'global')
        .is('target_id', null)
      if (globalError) throw globalError

      const rows = [...((globalRows ?? []) as CapsRow[])]
      if (teamId) {
        const { data: teamRows, error: teamError } = await client
          .from('provider_caps')
          .select('target_type,target_id,provider,modes,models')
          .eq('target_type', 'team')
          .eq('target_id', teamId)
        if (teamError) throw teamError
        rows.push(...((teamRows ?? []) as CapsRow[]))
      }
      setCaps(applyRows(rows))
    } catch (e) {
      // 能力配置加载失败时保留上次结果，不阻塞调度台（缺省即可用硬编码默认）
      void errMsg(e)
    }
  }, [userId, teamId])

  useEffect(() => {
    void load()
  }, [load, reloadKey])

  useEffect(() => {
    if (!userId) return
    const auth = getAuthService()
    if (!auth) return
    const client = auth.getClient()
    const channel = client
      .channel(`provider-caps-changes-${userId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'provider_caps' }, () => {
        void load()
      })
      .subscribe()

    return () => {
      void client.removeChannel(channel)
    }
  }, [userId, load])

  useEffect(() => {
    const onFocus = (): void => {
      void load()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [load])

  return useMemo(() => caps, [caps])
}