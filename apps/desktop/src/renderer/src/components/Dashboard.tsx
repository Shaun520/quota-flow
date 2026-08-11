import { useEffect, useState, useRef, useCallback } from 'react'
import {
  MODELS,
  computeCost,
  durationOptions,
  resolutionOptions,
  uploadHint
} from '../spec'
import { IconInfo, IconPlay, IconUpload, PROVIDER_ICONS } from './icons'
import { EmptyState } from './EmptyState'
import { useProviders } from '../hooks/useProviders'
import { useJobs } from '../hooks/useJobs'
import { useAuth } from '../hooks/useAuth'
import { getAuthService, getSupabaseConfig } from '../auth/service'

const VIP = false

interface DashboardProps {
  fresh: boolean
  banner: boolean
  step: 1 | 2 | 3
  onGenerate?: () => void
  onGoHistory: () => void
  onGoProviders: () => void
}

export default function Dashboard({ fresh, banner, step, onGenerate, onGoHistory, onGoProviders }: DashboardProps) {
  const { aggs: provAggs } = useProviders()
  const { user } = useAuth()
  const { items: jobItems, reload: reloadJobs } = useJobs()
  const [provider, setProvider] = useState('auto')
  const [model, setModel] = useState(MODELS.auto[0])
  const [mode, setMode] = useState('t2v')
  const [duration, setDuration] = useState(5)
  const [resolution, setResolution] = useState('720')
  const [audio, setAudio] = useState('on')
  const [ratio, setRatio] = useState('9:16')
  const [images, setImages] = useState<string[]>([])
  const [prompt, setPrompt] = useState('')
  const [generating, setGenerating] = useState(false)
  const [genError, setGenError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const durations = durationOptions(provider, model, mode, VIP)
  const resolutions = resolutionOptions(provider)
  const cost = computeCost(provider, model, duration, resolution)
  const upload = uploadHint(provider, mode)

  useEffect(() => {
    if (!durations.some((d) => d.value === duration)) {
      const last = durations[durations.length - 1]
      if (last) setDuration(last.value)
    }
  }, [durations, duration])

  useEffect(() => {
    if (!resolutions.some((r) => r.value === resolution)) {
      const last = resolutions[resolutions.length - 1]
      if (last) setResolution(last.value)
    }
  }, [resolutions, resolution])

  // 主进程生成事件（进度/完成）→ 刷新最近生成
  useEffect(() => {
    return window.api.dispatch.onEvent(() => {
      reloadJobs()
    })
  }, [reloadJobs])

  const handleGenerate = useCallback(async (): Promise<void> => {
    if (generating) return
    if (fresh && step === 1) {
      onGoProviders()
      return
    }
    if (!prompt.trim()) {
      setGenError('请先填写 Prompt 描述')
      return
    }
    if (mode !== 't2v') {
      setGenError('暂仅支持文生视频（图生视频/多参考待接入）')
      return
    }
    setGenError(null)
    setGenerating(true)
    try {
      const auth = getAuthService()
      const session = await auth?.getSession()
      const cfg = getSupabaseConfig()
      if (!auth || !session || !user || !cfg) {
        setGenError('登录态异常，请重新登录')
        return
      }
      const res = await window.api.dispatch.generate({
        supabaseUrl: cfg.url,
        supabaseAnonKey: cfg.anonKey,
        accessToken: session.access_token,
        refreshToken: session.refresh_token,
        userId: user.id,
        prompt: prompt.trim(),
        providerId: provider === 'auto' ? 'doubao' : provider,
        durationSec: duration,
        mode: mode === 't2v' ? 'text2video' : mode,
        resolution,
        audio,
        ratio
      })
      if (!res.ok) {
        setGenError(res.error || '生成失败')
      } else {
        onGenerate?.()
        reloadJobs()
      }
    } catch (e) {
      setGenError(e instanceof Error ? e.message : String(e))
    } finally {
      setGenerating(false)
    }
  }, [generating, fresh, step, prompt, mode, provider, duration, resolution, audio, ratio, user, onGenerate, reloadJobs, onGoProviders])

  const onProviderChange = (value: string): void => {
    setProvider(value)
    setModel(MODELS[value]?.[0] ?? MODELS.auto[0])
  }

  const onPickFiles = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

  const onFilesSelected = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    const urls = files.map((f) => URL.createObjectURL(f))
    setImages((prev) => [...prev, ...urls].slice(0, 4))
    e.target.value = ''
  }, [])

  const onRemoveImage = useCallback((idx: number) => {
    setImages((prev) => prev.filter((_, i) => i !== idx))
  }, [])

  return (
    <div className={'dashboard-wrap' + (banner ? ' has-banner' : '')}>
      <div className="page-header">
        <div className="title-group">
          <div>
            <h1>调度台</h1>
            <div className="divider" />
          </div>
          <p>聚合 7 家厂商免费额度 · 智能调度 · 一键生成</p>
        </div>
      </div>

      <div className="dispatch-grid">
        {/* 生成面板 */}
        <div className="generate-panel">
          <div className="panel-header">
            <h2>生成视频</h2>
            <span className="panel-meta">智能调度 · 可用优先</span>
          </div>

          <div className="input-group">
            <label htmlFor="prompt">Prompt 描述</label>
            <textarea
              id="prompt"
              placeholder="描述你想生成的视频内容，例如：一只橘猫在阳光下打盹，微风轻拂窗帘..."
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
          </div>

          <div className="cascade-row">
            <div className="param-field">
              <label htmlFor="provider">选择厂商</label>
              <select
                id="provider"
                value={provider}
                onChange={(e) => onProviderChange(e.target.value)}
              >
                <option value="auto">智能调度（推荐）</option>
                <option value="doubao">豆包</option>
                <option value="jimeng">即梦</option>
                <option value="qwen">通义万相</option>
                <option value="yuanbao">元宝混元</option>
                <option value="kling">可灵</option>
                <option value="hailuo">海螺</option>
                <option value="mathmind">MathMind</option>
              </select>
            </div>
            <div className="param-field">
              <label htmlFor="model">选择模型</label>
              <select id="model" value={model} onChange={(e) => setModel(e.target.value)}>
                {(MODELS[provider] ?? MODELS.auto).map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="param-row">
            <div className="param-field">
              <label htmlFor="mode">生成模式</label>
              <select id="mode" value={mode} onChange={(e) => setMode(e.target.value)}>
                <option value="t2v">文生视频</option>
                <option value="img">图生视频</option>
                <option value="multi_ref">多参考生成</option>
                <option value="first_last">首尾帧</option>
              </select>
            </div>
            <div className="param-field">
              <label htmlFor="duration">时长</label>
              <select
                id="duration"
                value={duration}
                onChange={(e) => setDuration(Number(e.target.value))}
              >
                {durations.map((d) => (
                  <option key={d.value} value={d.value} disabled={d.disabled}>
                    {d.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="param-field">
              <label htmlFor="resolution">分辨率</label>
              <select
                id="resolution"
                value={resolution}
                disabled={provider === 'yuanbao'}
                onChange={(e) => setResolution(e.target.value)}
              >
                {resolutions.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="param-row">
            <div className="param-field">
              <label htmlFor="audio">智能配音</label>
              <select id="audio" value={audio} onChange={(e) => setAudio(e.target.value)}>
                <option value="on">开</option>
                <option value="off">关</option>
              </select>
            </div>
            <div className="param-field">
              <label htmlFor="ratio">视频比例</label>
              <select id="ratio" value={ratio} onChange={(e) => setRatio(e.target.value)}>
                <option value="9:16">9:16</option>
                <option value="16:9">16:9</option>
                <option value="1:1">1:1</option>
              </select>
            </div>
            <div className="param-field">
              <span className="field-hint">配音 / 比例不影响额度</span>
            </div>
          </div>

          <div
            className={'upload-zone' + (images.length > 0 ? ' has-images' : '')}
            onClick={onPickFiles}
          >
            {images.length > 0 ? (
              <div className="thumb-strip">
                {images.map((src, idx) => (
                  <div className="thumb-item" key={idx}>
                    <img src={src} alt="" />
                    <button className="remove-thumb" onClick={(e) => { e.stopPropagation(); onRemoveImage(idx) }}>×</button>
                  </div>
                ))}
                {images.length < 4 && (
                  <div className="thumb-add">+</div>
                )}
              </div>
            ) : (
              <>
                <IconUpload size={16} />
                <span className="upload-text">{upload}</span>
              </>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              style={{ display: 'none' }}
              onChange={onFilesSelected}
            />
          </div>

          <div className="generate-actions">
            <button
              className="btn-primary"
              disabled={generating}
              onClick={() => void handleGenerate()}
            >
              <IconPlay size={14} />
              {generating ? '生成中…' : '开始生成'}
            </button>
            {genError && (
              <div className="gen-error" style={{ color: 'var(--error)', fontSize: 12, marginTop: 8 }}>
                {genError}
              </div>
            )}
            <div className="cost-estimate">
              <IconInfo size={12} />
              {fresh ? '绑定账号后可查看预计额度消耗' : (
                <>
                  预计 <span className="cost-highlight">{cost.text}</span> ·{' '}
                  <span className="cost-highlight">{cost.who}</span>
                </>
              )}
            </div>
          </div>
        </div>

        {/* 厂商实时状态 */}
        <div className="provider-status-panel">
          <div className="panel-header">
            <h2>厂商实时状态</h2>
            <span className="panel-meta">
              {provAggs.some((a) => a.boundCount > 0)
                ? provAggs.reduce((s, a) => s + a.boundCount, 0) + ' 个账号'
                : '未绑定'}
            </span>
          </div>
          {provAggs.every((a) => a.boundCount === 0) ? (
            <>
              <div className="provider-status-list">
                {provAggs.map((p) => {
                  const IconComp = PROVIDER_ICONS[p.providerId]
                  return (
                    <div className="ps-item unbound" key={p.providerId}>
                      <div className="ps-icon">
                        {IconComp ? <IconComp size={20} /> : null}
                      </div>
                      <div className="ps-info">
                        <div className="ps-name">{p.name}</div>
                        <div className="ps-quota">未绑定</div>
                      </div>
                      <div className="ps-state unbound">
                        <span className="dot" />
                        未绑定
                      </div>
                    </div>
                  )
                })}
              </div>
              <EmptyState
                className="ps-empty"
                title="还没有绑定任何厂商账号"
                description="绑定账号后即可自动获取免费额度，由智能调度按可用额度分发任务"
                action={
                  <button className="btn-sm primary" onClick={onGoProviders}>
                    去绑定账号 →
                  </button>
                }
              />
            </>
          ) : (
            <>
              <div className="provider-status-list">
                {provAggs.map((p) => {
                  const IconComp = PROVIDER_ICONS[p.providerId]
                  const used = p.bindings.reduce((s, b) => s + b.used, 0)
                  const remaining = p.bindings.reduce((s, b) => s + b.remaining, 0)
                  const total = p.bindings.reduce((s, b) => s + b.dailyTotal, 0)
                  const fill = total > 0 ? Math.round((remaining / total) * 100) : 0
                  return (
                    <div className="ps-item" key={p.providerId}>
                      <div className="ps-icon">
                        {IconComp ? <IconComp size={20} /> : null}
                      </div>
                      <div className="ps-info">
                        <div className="ps-name">{p.name}</div>
                        <div className="ps-quota">{remaining} / {total} {p.unitName}</div>
                        {used > 0 && (
                          <div className="quota-bar">
                            <div className="quota-fill" style={{ width: fill + '%' }} />
                          </div>
                        )}
                      </div>
                      <div className={'ps-state ' + (p.health === 'unbound' ? 'unbound' : p.health === 'offline' ? 'offline' : p.health === 'degraded' ? 'degraded' : 'online')}>
                        <span className="dot" />
                        {p.healthLabel}
                      </div>
                    </div>
                  )
                })}
              </div>
              <button className="btn-sm primary" style={{ width: '100%' }} onClick={onGoProviders}>
                管理厂商账号
              </button>
            </>
          )}
        </div>
      </div>

{/* 最近任务：真实生成记录（jobs 表） */}
      {!banner && (
        <div className="recent-jobs">
          <div className="section-header">
            <h2>最近生成</h2>
            <button className="section-link" onClick={onGoHistory}>
              查看全部 →
            </button>
          </div>
          {jobItems.length === 0 ? (
            <EmptyState
              icon={<IconPlay size={18} />}
              title="还没有生成记录"
              description="填写描述并开始生成，你的第一条视频将出现在这里"
            />
          ) : (
            <div className="recent-job-list">
              {jobItems.slice(0, 5).map((j) => (
                <div
                  key={j.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '10px 12px',
                    borderRadius: 10,
                    background: 'var(--panel, rgba(0,0,0,0.03))',
                    marginBottom: 6
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 13,
                        color: 'var(--fg, #1c1c1e)',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis'
                      }}
                    >
                      {j.record.prompt || '（无描述）'}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--fg-muted, #777)', marginTop: 2 }}>
                      {j.record.provider} · {j.record.mode} · {j.record.cost}
                    </div>
                  </div>
                  <span
                    style={{
                      fontSize: 12,
                      color: j.record.status === '成功' ? '#2e7d32' : j.record.status === '失败' ? 'var(--error, #c62828)' : '#b26a00'
                    }}
                  >
                    {j.record.status}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
