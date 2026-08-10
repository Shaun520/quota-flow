import { useEffect, useState, useRef, useCallback } from 'react'
import { HISTORY_ROWS, PROVIDERS } from '../data'
import {
  MODELS,
  computeCost,
  durationOptions,
  resolutionOptions,
  uploadHint
} from '../spec'
import { IconInfo, IconPlay, IconUpload, PROVIDER_ICONS } from './icons'
import { EmptyState } from './EmptyState'

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
  const [provider, setProvider] = useState('auto')
  const [model, setModel] = useState(MODELS.auto[0])
  const [mode, setMode] = useState('t2v')
  const [duration, setDuration] = useState(5)
  const [resolution, setResolution] = useState('720')
  const [audio, setAudio] = useState('on')
  const [ratio, setRatio] = useState('9:16')
  const [images, setImages] = useState<string[]>([])
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

  const recentJobs = HISTORY_ROWS.slice(0, 5)

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
              onClick={() => {
                if (fresh && step === 1) {
                  onGoProviders()
                  return
                }
                onGenerate?.()
              }}
            >
              <IconPlay size={14} />
              开始生成
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
            <span className="panel-meta">{fresh ? '未绑定' : '7 家接入'}</span>
          </div>
          {fresh ? (
            <>
              <div className="provider-status-list">
                {PROVIDERS.map((p) => {
                  const IconComp = PROVIDER_ICONS[p.id]
                  return (
                    <div className="ps-item unbound" key={p.id}>
                      <div className="ps-icon">
                        {IconComp ? <IconComp size={20} /> : p.icon}
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
                {PROVIDERS.map((p) => {
                  const IconComp = PROVIDER_ICONS[p.id]
                  return (
                    <div className="ps-item" key={p.id}>
                      <div className="ps-icon">
                        {IconComp ? <IconComp size={20} /> : p.icon}
                      </div>
                      <div className="ps-info">
                        <div className="ps-name">{p.name}</div>
                        <div className="ps-quota">{p.remaining} {p.unit}</div>
                        <div className="quota-bar">
                          <div className="quota-fill" style={{ width: p.fill + '%' }} />
                        </div>
                      </div>
                      <div className={'ps-state ' + p.state}>
                        <span className="dot" />
                        {p.stateLabel}
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

      {/* 最近任务：无新手提示时展示（样式与演示模式对齐），内容为真实数据，
         暂无记录时显示空状态，而不是 mock 卡片。 */}
      {!banner && (
        <div className="recent-jobs">
          <div className="section-header">
            <h2>最近生成</h2>
            <button className="section-link" onClick={onGoHistory}>
              查看全部 →
            </button>
          </div>
          {fresh ? (
            <EmptyState
              icon={<IconPlay size={18} />}
              title="还没有生成记录"
              description="填写描述并开始生成，你的第一条视频将出现在这里"
            />
          ) : (
            <div className="job-list">
              {recentJobs.map((row, i) => (
                <div className="job-card" key={i}>
                  <div className="job-thumb">
                    <span>{row.status === '排队' ? '生成中…' : '视频预览'}</span>
                    {row.duration && <span className="job-duration">{row.duration}</span>}
                    <span
                      className={
                        'job-badge ' +
                        (row.status === '成功' ? 'success' : row.status === '排队' ? 'pending' : 'error')
                      }
                    >
                      {row.status}
                    </span>
                  </div>
                  <div className="job-body">
                    <div className="job-prompt">{row.prompt}</div>
                    <div className="job-meta">
                      <span>{row.provider} · {row.mode}</span>
                      <span>{row.cost + (row.time ? ' · ' + row.time : '')}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
