import { useCallback, useEffect, useRef, useState } from 'react'
import type { MaterialRecord } from '../../../preload'
import { errMsg } from '../utils/error'

export interface UseMaterialsResult {
  items: MaterialRecord[]
  loading: boolean
  error: string | null
  reload: () => void
  /** 从用户选择的 File 列表导入素材（v1 走本地素材库） */
  importFiles: (files: File[]) => Promise<{ imported: number; skipped: number }>
  remove: (id: string) => Promise<void>
  urlOf: (fileName: string) => Promise<string>
}

export function useMaterials(): UseMaterialsResult {
  const [items, setItems] = useState<MaterialRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  const reload = useCallback(() => setReloadKey((k) => k + 1), [])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const list = await window.api.materials.list()
      setItems(list)
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load, reloadKey])

  const importFiles = useCallback(async (files: File[]): Promise<{ imported: number; skipped: number }> => {
    if (files.length === 0) return { imported: 0, skipped: 0 }
    const paths = files
      .map((f) => window.api.files.getPath(f).trim())
      .filter(Boolean)
    const created = await window.api.materials.import(paths)
    await load()
    return { imported: created.length, skipped: paths.length - created.length }
  }, [load])

  const remove = useCallback(async (id: string): Promise<void> => {
    const res = await window.api.materials.remove(id)
    if (!res.ok) throw new Error(res.error || '删除失败')
    setItems((prev) => prev.filter((m) => m.id !== id))
  }, [])

  const urlOf = useCallback((fileName: string): Promise<string> => window.api.materials.getUrl(fileName), [])

  return { items, loading, error, reload, importFiles, remove, urlOf }
}