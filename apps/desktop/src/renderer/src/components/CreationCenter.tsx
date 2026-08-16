import { useEffect, useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import { createPortal } from 'react-dom'
import type { DesktopFeatureFlags } from '../hooks/useDesktopPermissions'
import type { RegenerateDraft } from './Dashboard'
import { IconClose, IconGrid, IconPlay, IconSparkles } from './icons'

const COMMUNITY_CATEGORIES = ['全部', '国漫3D风', '动作打斗', '赛博都市', '古风仙侠', '治愈系'] as const
type CommunityCategory = (typeof COMMUNITY_CATEGORIES)[number]

export interface CommunityVideo {
  id: string
  title: string
  cover: string
  videoUrl?: string
  durationSec: number
  category: CommunityCategory
  tags: string[]
  prompt: string
  providerHint?: string
}

const COMMUNITY_VIDEOS: CommunityVideo[] = [
  {
    id: 'community-01',
    title: '雪后山巅少年剑客',
    cover: 'https://images.unsplash.com/photo-1533106418989-88406c7cc8ca?auto=format&fit=crop&w=640&q=80',
    durationSec: 10,
    category: '国漫3D风',
    tags: ['国漫3D', '雪山', '云海'],
    prompt: '高规格国漫3D风格，少年剑客站在雪后山巅，衣摆随风翻飞，远处云海翻涌，镜头从正面缓慢推进，金色晨光穿透云层照亮剑锋。',
    providerHint: '豆包 · Seedance 2.0 Mini'
  },
  {
    id: 'community-02',
    title: '雨夜霓虹巷战',
    cover: 'https://images.unsplash.com/photo-1519681393784-d120267933ba?auto=format&fit=crop&w=640&q=80',
    durationSec: 5,
    category: '动作打斗',
    tags: ['打斗', '雨夜', '慢镜头'],
    prompt: '高速动作打斗，雨夜巷战，两道人影在霓虹灯光下贴身交锋，慢镜头捕捉拳脚与雨滴碰撞，镜头快速切换，压迫感强。',
    providerHint: '可灵 · 标准'
  },
  {
    id: 'community-03',
    title: '霓虹雨幕天桥',
    cover: 'https://images.unsplash.com/photo-1519608487953-e999c86e7455?auto=format&fit=crop&w=640&q=80',
    durationSec: 10,
    category: '赛博都市',
    tags: ['赛博朋克', '城市夜景', '全息广告'],
    prompt: '赛博都市夜景，巨型全息广告在雨幕中闪烁，主角撑伞穿过拥挤天桥，霓虹色彩反射在积水路面，航拍缓慢拉升。',
    providerHint: '豆包 · Seedance 2.0 Mini'
  },
  {
    id: 'community-04',
    title: '白衣仙人御剑过云海',
    cover: 'https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=640&q=80',
    durationSec: 5,
    category: '古风仙侠',
    tags: ['仙侠', '御剑', '云海'],
    prompt: '古风仙侠意境，白衣仙人御剑飞过云海，衣袂飘动，瀑布从青翠山崖倾泻，镜头围绕仙人环绕半周。',
    providerHint: '千问 · 万相'
  },
  {
    id: 'community-05',
    title: '午后窗台的小猫',
    cover: 'https://images.unsplash.com/photo-1514888286974-6c03e2ca1dba?auto=format&fit=crop&w=640&q=80',
    durationSec: 5,
    category: '治愈系',
    tags: ['治愈', '猫咪', '阳光'],
    prompt: '治愈系田园短片，小猫在午后窗台伸懒腰，阳光洒进房间，窗帘随风轻摆，镜头缓慢靠近猫爪，画面温暖柔光。',
    providerHint: '海螺 · 标准'
  },
  {
    id: 'community-06',
    title: '黄昏停机坪的机甲少女',
    cover: 'https://images.unsplash.com/photo-1528459801416-a9e53bbf4e17?auto=format&fit=crop&w=640&q=80',
    durationSec: 10,
    category: '国漫3D风',
    tags: ['国漫3D', '机甲', '黄昏'],
    prompt: '国漫3D风战斗前奏，少女机甲在黄昏停机坪单膝落地，装甲表面亮起蓝色能量纹路，镜头低角度环绕展示细节。',
    providerHint: '豆包 · Seedance 2.0 Mini'
  },
  {
    id: 'community-07',
    title: '悬浮载具追车',
    cover: 'https://images.unsplash.com/photo-1550745165-9bc0b252726f?auto=format&fit=crop&w=640&q=80',
    durationSec: 10,
    category: '赛博都市',
    tags: ['追车', '悬浮载具', '光轨'],
    prompt: '科幻城市追车戏，悬浮载具贴着高架桥高速穿行，车灯拖出光轨，镜头跟拍并切换俯冲视角，城市灯火快速掠过。',
    providerHint: '可灵 · 大师'
  },
  {
    id: 'community-08',
    title: '竹林红袖剑气',
    cover: 'https://images.unsplash.com/photo-1541701494587-cb58502866ab?auto=format&fit=crop&w=640&q=80',
    durationSec: 5,
    category: '古风仙侠',
    tags: ['古风', '剑气', '竹海'],
    prompt: '古风仙侠，林间竹海起雾，女子红袖掠过竹叶，剑气切开雾气，镜头跟随红色衣袂穿行，风起叶落。',
    providerHint: '千问 · 万相'
  },
  {
    id: 'community-09',
    title: '雨天咖啡馆窗边',
    cover: 'https://images.unsplash.com/photo-1509042239860-f550ce710b93?auto=format&fit=crop&w=640&q=80',
    durationSec: 5,
    category: '治愈系',
    tags: ['治愈', '咖啡馆', '雨天'],
    prompt: '治愈系动画，雨天咖啡馆窗边，热咖啡升起白雾，小猫趴在桌角看雨滴滑落，镜头缓慢推近，色调温柔安静。',
    providerHint: '海螺 · 标准'
  }
]

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
  onReferenceGenerate?: (draft: RegenerateDraft) => void
  onNotify?: (message: string) => void
}

export default function CreationCenter({ features, onReferenceGenerate, onNotify }: CreationCenterProps) {
  const [category, setCategory] = useState<CommunityCategory>('全部')
  const [selected, setSelected] = useState<CommunityVideo | null>(null)
  const [favorites, setFavorites] = useState<Set<string>>(readFavorites)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [imageFailed, setImageFailed] = useState<Record<string, boolean>>({})

  const visibleVideos = useMemo(
    () => (category === '全部' ? COMMUNITY_VIDEOS : COMMUNITY_VIDEOS.filter((v) => v.category === category)),
    [category]
  )

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
            <span>{visibleVideos.length} 个灵感视频</span>
          </div>
          <div className="community-category-row" role="tablist" aria-label="视频分类">
            {COMMUNITY_CATEGORIES.map((c) => (
              <button
                key={c}
                className={'community-chip' + (category === c ? ' active' : '')}
                onClick={() => setCategory(c)}
              >
                {c}
              </button>
            ))}
          </div>
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
                <div className="community-detail-media">{renderCover(selected, true)}</div>
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
