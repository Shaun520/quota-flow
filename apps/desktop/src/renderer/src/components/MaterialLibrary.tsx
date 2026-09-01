import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { useMaterials } from '../hooks/useMaterials'
import type { MaterialRecord } from '../../../preload'

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

interface MaterialLibraryProps {
  onUseMaterial?: (materials: Array<{ path: string; url: string }>) => void
  onNotify?: (message: string) => void
}

export default function MaterialLibrary({ onUseMaterial, onNotify }: MaterialLibraryProps) {
  const { items, loading, error, importFiles, remove } = useMaterials()
  const [filter, setFilter] = useState<'all' | 'image' | 'video'>('all')
  const [keyword, setKeyword] = useState('')
  const [urls, setUrls] = useState<Record<string, string>>({})
  const [selected, setSelected] = useState<MaterialRecord | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  /** 多选「用作参考」的素材 id 集合（仅图片可勾选） */
  const [multiSel, setMultiSel] = useState<ReadonlySet<string>>(new Set())
  const fileInputRef = useRef<HTMLInputElement>(null)

  const toggleMulti = (id: string): void => {
    setMultiSel((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const clearMulti = (): void => setMultiSel(new Set())

  // 批量回填调度台（多张图片一次用作参考）
  const useSelected = (): void => {
    const picked = visibleItems
      .filter((m) => multiSel.has(m.id) && !!urls[m.id])
      .map((m) => ({ path: m.path, url: urls[m.id]! }))
    if (picked.length === 0) return
    clearMulti()
    onUseMaterial?.(picked)
  }

  const visibleItems = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    return items.filter((m) => {
      if (filter !== 'all' && m.type !== filter) return false
      if (kw && !m.name.toLowerCase().includes(kw)) return false
      return true
    })
  }, [items, filter, keyword])

  // 解析所有素材的可预览 URL（媒体服务端口动态，逐个获取）
  useEffect(() => {
    let cancelled = false
    const map: Record<string, string> = {}
    const tasks = items.map((m) =>
      window.api.materials.getUrl(m.fileName).catch(() => null)
    )
    void Promise.all(tasks).then((res) => {
      if (cancelled) return
      items.forEach((m, i) => {
        const u = res[i]
        if (u) map[m.id] = u
      })
      setUrls(map)
    })
    return () => {
      cancelled = true
    }
  }, [items])

  useEffect(() => {
    if (!selected) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setSelected(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected])

  const onPickFiles = (): void => fileInputRef.current?.click()

  const onFilesSelected = async (e: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const files = Array.from(e.target.files ?? [])
    e.target.value = ''
    if (files.length === 0) return
    try {
      const { imported, skipped } = await importFiles(files)
      onNotify?.(skipped > 0 ? `已导入 ${imported} 个素材（跳过 ${skipped} 个不支持的文件）` : `已导入 ${imported} 个素材`)
    } catch (err) {
      onNotify?.(err instanceof Error ? err.message : '导入失败')
    }
  }

  const handleRemove = async (item: MaterialRecord): Promise<void> => {
    if (removing) return
    setRemoving(item.id)
    try {
      await remove(item.id)
      if (selected?.id === item.id) setSelected(null)
      // 从多选中剔除已删除项，避免计数残留
      setMultiSel((prev) => {
        if (!prev.has(item.id)) return prev
        const next = new Set(prev)
        next.delete(item.id)
        return next
      })
      onNotify?.('已删除素材')
    } catch (err) {
      onNotify?.(err instanceof Error ? err.message : '删除失败')
    } finally {
      setRemoving(null)
    }
  }

  const renderThumb = (item: MaterialRecord): ReactElement => {
    const src = urls[item.id]
    if (!src) {
      return (
        <div className="material-thumb placeholder">
          <span>{item.type === 'video' ? '视频' : '图片'}</span>
        </div>
      )
    }
    if (item.type === 'video') {
      return (
        <video
          src={src}
          muted
          preload="metadata"
          className="material-thumb"
          poster=""
        />
      )
    }
    return <img src={src} alt={item.name} loading="lazy" className="material-thumb" />
  }

  return (
    <section className="material-section" aria-label="我的素材库">
      <div className="creation-section-heading">
        <h2>我的素材库</h2>
        <div className="material-heading-actions">
          <span>{items.length} 个素材</span>
          <button className="btn-sm primary" onClick={onPickFiles}>
            导入素材
          </button>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,video/mp4"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => void onFilesSelected(e)}
        />
      </div>

      <div className="material-toolbar">
        <div className="community-category-row" role="tablist" aria-label="素材类型">
          {(
            [
              { value: 'all', label: '全部' },
              { value: 'image', label: '图片' },
              { value: 'video', label: '视频' }
            ] as Array<{ value: 'all' | 'image' | 'video'; label: string }>
          ).map((c) => (
            <button
              key={c.value}
              className={'community-chip' + (filter === c.value ? ' active' : '')}
              onClick={() => setFilter(c.value)}
            >
              {c.label}
            </button>
          ))}
        </div>
        <input
          className="material-search"
          placeholder="搜索素材名称"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
      </div>

      {loading ? (
        <div className="community-state">加载中...</div>
      ) : error ? (
        <div className="community-state error">加载失败：{error}</div>
      ) : items.length === 0 ? (
        <div className="community-state">
          素材库为空，导入本地图片 / 视频作为创作参考素材。
          <button className="btn-sm primary" style={{ marginTop: 8 }} onClick={onPickFiles}>
            导入素材
          </button>
        </div>
      ) : visibleItems.length === 0 ? (
        <div className="community-state">没有匹配的素材。</div>
      ) : (
        <>
          {multiSel.size > 0 && (
            <div className="material-batch-bar">
              <div className="hint">
                <span className="count">已选 {multiSel.size} 张图片</span>
              </div>
              <div className="material-card-actions" style={{ margin: 0 }}>
                <button className="btn-sm" onClick={clearMulti}>取消选择</button>
                <button className="btn-sm primary" onClick={useSelected}>用作参考（{multiSel.size}）</button>
              </div>
            </div>
          )}
          <div className="material-grid">
          {visibleItems.map((m) => {
            const src = urls[m.id]
            const canUse = m.type === 'image'
            const isSel = multiSel.has(m.id)
            return (
              <article
                key={m.id}
                className={'material-card' + (isSel ? ' selected' : '')}
                onClick={() => src && setSelected(m)}
              >
                <div className="material-card-cover">
                  {renderThumb(m)}
                  {canUse && (
                    <div
                      className={'material-select' + (isSel ? ' on' : '')}
                      title={isSel ? '取消选择' : '选择用作参考'}
                      onClick={(e) => { e.stopPropagation(); toggleMulti(m.id) }}
                    >
                      {isSel ? '✓' : '+'}
                    </div>
                  )}
                </div>
                <div className="material-card-body">
                  <h4 title={m.name}>{m.name}</h4>
                  <div className="material-meta">
                    <span>{m.ext.toUpperCase()}</span>
                    <span>{formatBytes(m.size)}</span>
                  </div>
                  <div className="material-card-actions" onClick={(e) => e.stopPropagation()}>
                    {canUse && (
                      <button
                        className="btn-sm primary"
                        title="回填到调度台作为参考图"
                        onClick={() => {
                          if (!src) return
                          onUseMaterial?.([{ path: m.path, url: src }])
                        }}
                      >
                        用作参考
                      </button>
                    )}
                    <button className="btn-sm" disabled={removing === m.id} onClick={() => void handleRemove(m)}>
                      {removing === m.id ? '删除中' : '删除'}
                    </button>
                  </div>
                </div>
              </article>
            )
          })}
          </div>
        </>
      )}

      {selected &&
        createPortal(
          <div
            className="modal-overlay"
            style={{ zIndex: 300 }}
            onClick={(e) => {
              if (e.target === e.currentTarget) setSelected(null)
            }}
          >
            <div
              className="modal-card material-detail"
              style={{ width: 'min(94vw, 860px)', maxHeight: '88vh', display: 'flex', flexDirection: 'column' }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="material-detail-header">
                <h3>{selected.name}</h3>
                <button className="modal-close" title="关闭" onClick={() => setSelected(null)}>
                  ×
                </button>
              </div>
              <div className="material-detail-media">
                {selected.type === 'video' && urls[selected.id] ? (
                  <video src={urls[selected.id]} controls preload="metadata" className="material-detail-video" />
                ) : urls[selected.id] ? (
                  <img src={urls[selected.id]} alt={selected.name} className="material-detail-img" />
                ) : (
                  <div className="community-state">素材不可预览</div>
                )}
              </div>
              <div className="material-detail-footer">
                <span>{selected.type === 'video' ? '视频' : '图片'} · {selected.ext.toUpperCase()} · {formatBytes(selected.size)}</span>
                {selected.type === 'image' && (
                  <button
                    className="btn-sm primary"
                    onClick={() => {
                      const src = urls[selected.id]
                      if (!src) return
                      setSelected(null)
                      onUseMaterial?.([{ path: selected.path, url: src }])
                    }}
                  >
                    用作参考
                  </button>
                )}
              </div>
            </div>
          </div>,
          document.body
        )}
    </section>
  )
}