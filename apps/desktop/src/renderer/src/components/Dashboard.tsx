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
import Select from './Select'
import type { JobItem } from '../hooks/useJobs'
import { useAuth } from '../hooks/useAuth'
import type { ProvidersResult } from '../hooks/useProviders'
import type { JobsResult } from '../hooks/useJobs'
import { getAuthService, getSupabaseConfig } from '../auth/service'
import { VideoThumb } from './VideoThumb'
import { getInitialShowWebview } from './Modals'

const VIP = false

/** 生成阶段 → 用户可见文案 */
const STAGE_LABEL: Record<string, string> = {
  'select-account': '选择账号中…',
  'inject-cookies': '注入登录态…',
  'open-page': '打开豆包页面…',
  'wait-tab': '进入视频生成…',
  'open-video-tab': '进入视频生成…',
  'apply-duration': '设置时长…',
  'apply-params': '发送 prompt 中…',
  submit: '发送 prompt 中…',
  waiting: '视频开始生成中…（排队中）',
  'risk-verify': '需要验证，请在弹窗完成…',
  'risk-resolved': '验证完成，继续生成…',
  'account-failed': '当前账号失败，尝试切换…',
  blocked: '豆包拒绝了本次生成（见左侧错误）'
}

interface DashboardProps {
  fresh: boolean
  banner: boolean
  step: 1 | 2 | 3
  onGenerate?: () => void
  onGoHistory: () => void
  onGoProviders: () => void
  providers: ProvidersResult
  jobs: JobsResult
}

export default function Dashboard({ fresh, banner, step, onGenerate, onGoHistory, onGoProviders, providers, jobs }: DashboardProps) {
  const { aggs: provAggs } = providers
  const { user } = useAuth()
  const { items: jobItems, reload: reloadJobs } = jobs
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
  const [genFailed, setGenFailed] = useState(false)
  const [genStage, setGenStage] = useState<string | null>(null)
  const activeJobIdRef = useRef<string | null>(null)
  const [preview, setPreview] = useState<{ id: string; src: string } | null>(null)
  const [mediaUrls, setMediaUrls] = useState<Record<string, string>>({})
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
    return window.api.dispatch.onEvent((ev: { jobId?: string; status?: string; stage?: string; message?: string }) => {
      reloadJobs()
      // 只处理当前任务的事件，避免历史任务事件误伤
      if (activeJobIdRef.current && ev.jobId && ev.jobId !== activeJobIdRef.current) return
      if (ev.status === 'running' && ev.stage) {
        setGenStage(ev.stage)
      } else if (ev.status === 'failed') {
        setGenError(ev.message || '生成失败')
        setGenFailed(true)
        setGenStage(null)
      } else if (ev.status === 'success') {
        setGenFailed(false)
        setGenStage(null)
      }
    })
  }, [reloadJobs])

  // 解析最近生成视频的可播放地址（本地路径 → http://127.0.0.1 服务）
  useEffect(() => {
    let cancelled = false
    const map: Record<string, string> = {}
    const tasks: Promise<void>[] = []
    for (const item of jobItems) {
      const r = item.record
      if (!r.resultUrl) continue
      if (/^https?:/i.test(r.resultUrl)) {
        map[item.id] = r.resultUrl
      } else {
        const name = r.resultUrl.replace(/\\/g, '/').split('/').pop() || ''
        tasks.push(
          window.api.media
            .getUrl(name)
            .then((u) => {
              map[item.id] = u
            })
            .catch(() => {})
        )
      }
    }
    void Promise.all(tasks).then(() => {
      if (!cancelled) setMediaUrls(map)
    })
    return () => {
      cancelled = true
    }
  }, [jobItems])

  const togglePreview = (item: JobItem): void => {
    if (preview && preview.id === item.id) {
      setPreview(null)
      return
    }
    const src = mediaUrls[item.id]
    if (!src) return
    setPreview({ id: item.id, src })
  }

  // 预览浮层：Esc 关闭
  useEffect(() => {
    if (!preview) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setPreview(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [preview])

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
    setGenFailed(false)
    setGenStage(null)
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
        ratio,
        showWebview: getInitialShowWebview()
      })
      activeJobIdRef.current = res.jobId ?? null
      if (!res.ok) {
        setGenError(res.error || '生成失败')
        setGenFailed(true)
      } else {
        onGenerate?.()
        reloadJobs()
      }
    } catch (e) {
      setGenError(e instanceof Error ? e.message : String(e))
      setGenFailed(true)
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
              <Select
                id="provider"
                value={provider}
                onChange={onProviderChange}
                options={[
                  { value: 'auto', label: '智能调度（推荐）' },
                  { value: 'doubao', label: '豆包' },
                  { value: 'jimeng', label: '即梦' },
                  { value: 'qwen', label: '通义万相' },
                  { value: 'yuanbao', label: '元宝混元' },
                  { value: 'kling', label: '可灵' },
                  { value: 'hailuo', label: '海螺' },
                  { value: 'mathmind', label: 'MathMind' }
                ]}
              />
            </div>
            <div className="param-field">
              <label htmlFor="model">选择模型</label>
              <Select
                id="model"
                value={model}
                onChange={setModel}
                options={(MODELS[provider] ?? MODELS.auto).map((m) => ({ value: m, label: m }))}
              />
            </div>
          </div>

          <div className="param-row">
            <div className="param-field">
              <label htmlFor="mode">生成模式</label>
              <Select
                id="mode"
                value={mode}
                onChange={setMode}
                options={[
                  { value: 't2v', label: '文生视频' },
                  { value: 'img', label: '图生视频' },
                  { value: 'multi_ref', label: '多参考生成' },
                  { value: 'first_last', label: '首尾帧' }
                ]}
              />
            </div>
            <div className="param-field">
              <label htmlFor="duration">时长</label>
              <Select
                id="duration"
                value={String(duration)}
                onChange={(v) => setDuration(Number(v))}
                options={durations.map((d) => ({ value: String(d.value), label: d.label, disabled: d.disabled }))}
              />
            </div>
            <div className="param-field">
              <label htmlFor="resolution">分辨率</label>
              <Select
                id="resolution"
                value={resolution}
                disabled={provider === 'yuanbao'}
                onChange={setResolution}
                options={resolutions.map((r) => ({ value: r.value, label: r.label }))}
              />
            </div>
          </div>

          <div className="param-row">
            <div className="param-field">
              <label htmlFor="audio">智能配音</label>
              <Select
                id="audio"
                value={audio}
                onChange={setAudio}
                options={[
                  { value: 'on', label: '开' },
                  { value: 'off', label: '关' }
                ]}
              />
            </div>
            <div className="param-field">
              <label htmlFor="ratio">视频比例</label>
              <Select
                id="ratio"
                value={ratio}
                onChange={setRatio}
                options={[
                  { value: '9:16', label: '9:16' },
                  { value: '16:9', label: '16:9' },
                  { value: '1:1', label: '1:1' }
                ]}
              />
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
            {genError && (
              <div
                className="gen-error"
                style={{ flex: 1, minWidth: 0, color: 'var(--error)', fontSize: 12, textAlign: 'left' }}
              >
                {genError}
              </div>
            )}
            {generating && (
              <div className="gen-status">
                <span className="gen-status-spinner" />
                <span>{genStage ? (STAGE_LABEL[genStage] ?? genStage) : '正在准备…'}</span>
              </div>
            )}
            <button
              className="btn-primary"
              disabled={generating}
              onClick={() => void handleGenerate()}
            >
              <IconPlay size={14} />
              {generating ? '生成中…' : genFailed ? '重新生成' : '开始生成'}
            </button>
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
              {provAggs.some((a) => a.enabledCount > 0)
                ? provAggs.reduce((s, a) => s + a.enabledCount, 0) + ' 个可用账号'
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
                  const used = p.bindings.filter((b) => b.enabled).reduce((s, b) => s + b.used, 0)
                  const remaining = p.bindings.filter((b) => b.enabled).reduce((s, b) => s + b.remaining, 0)
                  const total = p.bindings.filter((b) => b.enabled).reduce((s, b) => s + b.dailyTotal, 0)
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
            <div className="job-list">
              {jobItems.slice(0, 6).map((j) => {
                const r = j.record
                const badgeCls = r.status === '成功' ? 'success' : r.status === '失败' ? 'error' : 'pending'
                return (
                  <div
                    key={j.id}
                    className="job-card"
                    onClick={() => togglePreview(j)}
                  >
                    <div className="job-thumb">
                      {mediaUrls[j.id] ? (
                        <VideoThumb
                          src={mediaUrls[j.id]}
                          onClick={(e) => {
                            e.stopPropagation()
                            togglePreview(j)
                          }}
                        />
                      ) : (
                        <span>{r.status === '成功' ? '已生成' : r.status === '失败' ? '失败' : '排队中'}</span>
                      )}
                      <span className={'job-badge ' + badgeCls}>{r.status}</span>
                    </div>
                    <div className="job-body">
                      <div className="job-prompt">{r.prompt || '（无描述）'}</div>
                      <div className="job-meta">
                        <span>{r.provider}{r.accountName ? ' · ' + r.accountName : ''}</span>
                        <span>{r.cost}</span>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* 预览浮层：网格不动，仅浮层内播放（避免竖屏视频撑高整行卡片） */}
      {preview && (
        <div
          className="video-preview-overlay"
          onClick={() => setPreview(null)}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 9999,
            background: 'rgba(0,0,0,0.78)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24
          }}
        >
          <div style={{ position: 'relative', width: 'min(92vw, 860px)' }} onClick={(e) => e.stopPropagation()}>
            <video
              controls
              autoPlay
              src={preview.src}
              style={{ width: '100%', maxHeight: '82vh', display: 'block', borderRadius: 10, background: '#000', objectFit: 'contain' }}
            />
            <button
              onClick={() => setPreview(null)}
              style={{
                position: 'absolute',
                top: -40,
                right: 0,
                color: '#fff',
                background: 'rgba(255,255,255,0.16)',
                border: 'none',
                borderRadius: 6,
                padding: '4px 10px',
                cursor: 'pointer',
                fontSize: 13
              }}
            >
              ✕ 关闭
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
