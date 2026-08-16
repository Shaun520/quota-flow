import { useEffect, useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import { createPortal } from 'react-dom'
import type { DesktopFeatureFlags } from '../hooks/useDesktopPermissions'
import { useCommunityVideos, type CommunityVideo } from '../hooks/useCommunityVideos'
import type { RegenerateDraft } from './Dashboard'
import { IconClose, IconGrid, IconPlay, IconSparkles } from './icons'

const DEFAULT_COMMUNITY_DRAFT: RegenerateDraft = {
  prompt: '',
  providerId: 'doubao',
  model: 'Seedance 2.0 Mini',
  durationSec: 5,
  resolution: '720',
  audio: 'on',
  ratio: '9:16',
  mode: 't2v',
  images: []
}

const FAVORITES_KEY = 'qf:community:favorites'

function readFavorites(): Set<string> {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY)
    if (!raw) return new Set()
    const list = JSON.parse(raw) as string[]
    return new Set(Array.isArray(list) ? list : [])
  } catch {
    return new Set()
  }
}

function writeFavorites(favorites: Set<string>): void {
  try {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(Array.from(favorites)))
  } catch {
    // 本地存储不可用时收藏只在当前会话生效
  }
}

function formatDuration(seconds: number): string {
  return `${seconds}s`
}

function IconDrop({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z" />
      <path d="M9.5 13.5a2.5 2.5 0 0 0 2 2.5" />
    </svg>
  )
}

interface CreationCenterProps {
  features: DesktopFeatureFlags
  userId?: string
  onReferenceGenerate?: (draft: RegenerateDraft) => void
  onNotify?: (message: string) => void
}

export default function CreationCenter({ features, userId, onReferenceGenerate, onNotify }: CreationCenterProps) {
  const communityVideos = useCommunityVideos(userId)
  const videos = communityVideos.items
  const [category, setCategory] = useState<string>('全部')
  const [selected, setSelected] = useState<CommunityVideo | null>(null)
  const [favorites, setFavorites] = useState<Set<string>>(readFavorites)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [imageFailed, setImageFailed] = useState<Record<string, boolean>>({})

  const categories = useMemo(() => {
    const unique = Array.from(new Set(videos.map((v) => v.category).filter(Boolean)))
    return ['全部', ...unique]
  }, [videos])

  const visibleVideos = useMemo(
    () => (category === '全部' ? videos : videos.filter((v) => v.category === category)),
    [category, videos]
  )

  useEffect(() => {
    if (category !== '全部' && !categories.includes(category)) {
      setCategory('全部')
    }
  }, [categories, category])

  useEffect(() => {
    if (!selected) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setSelected(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected])

  const toggleFavorite = (video: CommunityVideo): void => {
    setFavorites((prev) => {
      const next = new Set(prev)
      if (next.has(video.id)) next.delete(video.id)
      else next.add(video.id)
      writeFavorites(next)
      return next
    })
  }

  const copyPrompt = async (video: CommunityVideo, id: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(video.prompt)
      setCopiedId(id)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = video.prompt
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
      setCopiedId(id)
    }
    onNotify?.('提示词已复制')
    window.setTimeout(() => setCopiedId(null), 1200)
  }

  const referenceGenerate = (video: CommunityVideo): void => {
    if (!onReferenceGenerate) return
    onReferenceGenerate({
      ...DEFAULT_COMMUNITY_DRAFT,
      prompt: video.prompt
    })
    onNotify?.('已回填调度台')
  }

  const renderCover = (video: CommunityVideo, large = false): ReactElement => {
    const failed = imageFailed[video.id]
    if (!failed) {
      return (
        <div className={'community-cover-media' + (large ? ' large' : '')}>
          <img
            src={video.cover}
            alt={video.title}
            loading="lazy"
            onError={() => setImageFailed((prev) => ({ ...prev, [video.id]: true }))}
          />
          <span className="community-cover-play">
            <IconPlay size={large ? 26 : 18} />
          </span>
          <span className="community-duration">{formatDuration(video.durationSec)}</span>
        </div>
      )
    }
    return (
      <div className={'community-cover-fallback' + (large ? ' large' : '')}>
        <IconPlay size={large ? 30 : 22} />
        <span>{video.category}</span>
        <span>{formatDuration(video.durationSec)}</span>
      </div>
    )
  }

  const renderActions = (video: CommunityVideo, sourceId: string): ReactElement => {
    const isCopied = copiedId === sourceId
    return (
      <div className="community-card-actions" onClick={(e) => e.stopPropagation()}>
        <button
          className="btn-sm"
          title="复制完整 Prompt"
          onClick={() => void copyPrompt(video, sourceId)}
        >
          {isCopied ? '已复制' : '复制提示词'}
        </button>
        <button
          className="btn-sm primary"
          title="回填到调度台"
          onClick={() => referenceGenerate(video)}
        >
          参考生成
        </button>
      </div>
    )
  }

  return (
    <div className="creation-center">
      {features['creation.ai_toolbox'] !== false ? (
        <section className="ai-toolbar" aria-label="AI 工具箱">
          <div className="creation-section-heading">
            <h2>AI 工具箱</h2>
          </div>
          <div className="ai-tool-row">
            <button
              className={'ai-tool-button' + (features['creation.watermark'] === false ? ' disabled' : '')}
              disabled={features['creation.watermark'] === false}
              title="去水印"
              onClick={() => onNotify?.('去水印请在历史任务详情中使用')}
            >
              <span className="ai-tool-icon">
                <IconDrop size={20} />
              </span>
              <span className="ai-tool-label">去水印</span>
              <span className="ai-tool-status">{features['creation.watermark'] === false ? '未开放' : '历史任务'}</span>
            </button>
            <button
              className={'ai-tool-button' + (features['creation.prompt_expander'] === false ? ' disabled' : '')}
              disabled={features['creation.prompt_expander'] === false}
              title="提示词扩展"
              onClick={() => onNotify?.('提示词扩展待接入')}
            >
              <span className="ai-tool-icon">
                <IconSparkles size={20} />
              </span>
              <span className="ai-tool-label">提示词扩展</span>
              <span className="ai-tool-status">{features['creation.prompt_expander'] === false ? '未开放' : '待接入'}</span>
            </button>
            <button
              className={'ai-tool-button' + (features['creation.storyboard'] === false ? ' disabled' : '')}
              disabled={features['creation.storyboard'] === false}
              title="分镜生成"
              onClick={() => onNotify?.('分镜生成待接入')}
            >
              <span className="ai-tool-icon">
                <IconGrid size={20} />
              </span>
              <span className="ai-tool-label">分镜生成</span>
              <span className="ai-tool-status">{features['creation.storyboard'] === false ? '未开放' : '待接入'}</span>
            </button>
          </div>
        </section>
      ) : null}

      {features['creation.video_library'] === false ? null : features['creation.community'] !== false ? (
        <section className="community-section" aria-label="视频灵感库">
          <div className="creation-section-heading">
            <h2>视频灵感库</h2>
            <span>{communityVideos.loading ? '加载中' : `${videos.length} 个灵感视频`}</span>
          </div>
          <div className="community-category-row" role="tablist" aria-label="视频分类">
            {categories.map((c) => (
              <button
                key={c}
                className={'community-chip' + (category === c ? ' active' : '')}
                onClick={() => setCategory(c)}
              >
                {c}
              </button>
            ))}
          </div>
          {communityVideos.loading ? (
            <div className="community-state">加载中...</div>
          ) : communityVideos.error ? (
            <div className="community-state error">加载失败：{communityVideos.error}</div>
          ) : videos.length === 0 ? (
            <div className="community-state">暂无灵感视频，管理员可在后台添加。</div>
          ) : (
            <div className="community-grid">
              {visibleVideos.map((video) => {
                const isFavorite = favorites.has(video.id)
                return (
                  <article
                    key={video.id}
                    className="community-card"
                    onClick={() => setSelected(video)}
                  >
                    <div className="community-card-cover">
                      {renderCover(video)}
                      <button
                        className={'community-fav' + (isFavorite ? ' active' : '')}
                        title={isFavorite ? '取消收藏' : '收藏'}
                        onClick={(e) => {
                          e.stopPropagation()
                          toggleFavorite(video)
                        }}
                      >
                        {isFavorite ? '★' : '☆'}
                      </button>
                    </div>
                    <div className="community-card-body">
                      <h3>{video.title}</h3>
                      <div className="community-tags">
                        {video.tags.map((tag) => (
                          <span key={tag}>{tag}</span>
                        ))}
                      </div>
                      <p className="community-prompt">{video.prompt}</p>
                      {renderActions(video, video.id)}
                    </div>
                  </article>
                )
              })}
            </div>
          )}
        </section>
      ) : (
        <div className="creation-disabled">视频灵感库未开启</div>
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
              className="modal-card community-detail"
              style={{ width: 'min(94vw, 880px)', maxHeight: '88vh', display: 'flex', flexDirection: 'column' }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="community-detail-header">
                <div>
                  <h3>{selected.title}</h3>
                  <div className="community-detail-meta">
                    <span>{selected.category}</span>
                    <span>{formatDuration(selected.durationSec)}</span>
                    {selected.providerHint ? <span>{selected.providerHint}</span> : null}
                  </div>
                </div>
                <button className="modal-close" title="关闭" onClick={() => setSelected(null)}>
                  <IconClose size={16} />
                </button>
              </div>
              <div className="community-detail-body">
                <div className="community-detail-media">
                  {selected.videoUrl ? (
                    <video
                      className="community-detail-video"
                      src={selected.videoUrl}
                      poster={selected.cover}
                      controls
                      preload="metadata"
                    />
                  ) : (
                    renderCover(selected, true)
                  )}
                </div>
                <div className="community-detail-info">
                  <div className="community-tags">
                    {selected.tags.map((tag) => (
                      <span key={tag}>{tag}</span>
                    ))}
                  </div>
                  <pre className="community-full-prompt">{selected.prompt}</pre>
                  <div className="community-detail-actions">
                    {renderActions(selected, 'detail-' + selected.id)}
                    <button
                      className={'btn-sm community-fav-btn' + (favorites.has(selected.id) ? ' active' : '')}
                      title={favorites.has(selected.id) ? '取消收藏' : '收藏'}
                      onClick={() => toggleFavorite(selected)}
                    >
                      {favorites.has(selected.id) ? '已收藏' : '收藏'}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>,
          document.body
        )}
    </div>
  )
}
