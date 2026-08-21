// 音频参考裁剪弹窗：文件时长超过厂商上限（百炼 30s）时，让用户直接在波形上拖选起止区间，
// 选中片段强制 ≤ 上限，确认后裁剪为 WAV 回传给调用方上传。纯浏览器实现，无第三方依赖。
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

const MAX_SEC = 30

interface AudioCropModalProps {
  file: File
  duration: number
  onCancel: () => void
  onConfirm: (bytes: ArrayBuffer, startSec: number, endSec: number) => void | Promise<void>
}

/** PCM 采样（多声道）序列化为标准 16bit WAV。 */
function encodeWav(channelData: Float32Array[], sampleRate: number): ArrayBuffer {
  const channels = channelData.length
  const bytesPerSample = 2
  const dataLength = channelData[0].length * channels * bytesPerSample
  const buffer = new ArrayBuffer(44 + dataLength)
  const view = new DataView(buffer)
  const writeStr = (o: number, s: string): void => {
    for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i))
  }
  writeStr(0, 'RIFF'); view.setUint32(4, 36 + dataLength, true); writeStr(8, 'WAVE')
  writeStr(12, 'fmt '); view.setUint32(16, 16, true)
  view.setUint16(20, 1, true); view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * channels * bytesPerSample, true)
  view.setUint16(32, channels * bytesPerSample, true); view.setUint16(34, 16, true)
  writeStr(36, 'data'); view.setUint32(40, dataLength, true)

  let offset = 44
  const n = channelData[0].length
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < channels; c++) {
      let s = channelData[c][i]
      s = Math.max(-1, Math.min(1, s))
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true)
      offset += 2
    }
  }
  return buffer
}

function fmtTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) return '0:00'
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, '0')}`
}

export default function AudioCropModal({ file, duration, onCancel, onConfirm }: AudioCropModalProps) {
  const [buffer, setBuffer] = useState<AudioBuffer | null>(null)
  const [peaks, setPeaks] = useState<number[]>([])
  const [start, setStart] = useState(0)
  const [end, setEnd] = useState(Math.min(duration, MAX_SEC))
  const [busy, setBusy] = useState(false)
  const [playing, setPlaying] = useState(false)
  // 试听播放头（秒）：>=0 表示正在播放中的当前位置
  const [playhead, setPlayhead] = useState<number>(-1)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  // 拖拽状态：null 未拖，start/end 表示正在拖动对应手柄
  const draggingRef = useRef<'start' | 'end' | null>(null)
  // 试听播放相关：独立 AudioContext（解码用的已 close），source / RAF 句柄
  const playCtxRef = useRef<AudioContext | null>(null)
  const sourceRef = useRef<AudioBufferSourceNode | null>(null)
  const rafRef = useRef<number | null>(null)
  const playStartRef = useRef(0) // 播放起始（源时间轴秒）
  const playCtxT0Ref = useRef(0) // 播放开始时的 ctx.currentTime

  // 解码音频并计算单声道峰值（用于波形绘制）
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const raw = await file.arrayBuffer()
        const AC: typeof AudioContext =
          window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
        const ctx = new AC()
        const b = await ctx.decodeAudioData(raw)
        await ctx.close()
        if (cancelled) return
        const data = b.getChannelData(0)
        const width = 600
        const block = Math.max(1, Math.floor(data.length / width))
        const p: number[] = []
        for (let x = 0; x < width; x++) {
          let max = 0
          const s = x * block
          const e = Math.min(data.length, s + block)
          for (let i = s; i < e; i++) { const v = Math.abs(data[i]); if (v > max) max = v }
          p.push(max)
        }
        setBuffer(b)
        setPeaks(p)
      } catch { /* 解码失败：交由调用方直传原文件兜底 */ }
    })()
    return () => { cancelled = true }
  }, [file])

  // 绘制波形：未选中区浅色，选中区高亮，边界显示左右手柄
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    canvas.width = w * dpr
    canvas.height = h * dpr
    const g = canvas.getContext('2d')
    if (!g) return
    g.scale(dpr, dpr)
    const cs = getComputedStyle(document.documentElement)
    const fg = cs.getPropertyValue('--fg-secondary') || '#999'
    const accent = cs.getPropertyValue('--accent') || '#4f8cff'
    const waveH = h - 36 // 底部留拖拽手柄区 + 时间刻度
    g.clearRect(0, 0, w, h)
    if (peaks.length === 0) return
    const barW = w / peaks.length
    const xOf = (sec: number): number => (sec / duration) * w
    // 未选中区域（浅色全量波形）
    g.fillStyle = fg
    g.globalAlpha = 0.35
    peaks.forEach((p, i) => {
      const bh = Math.max(1, p * waveH)
      g.fillRect(i * barW, (waveH - bh) / 2, Math.max(1, barW), bh)
    })
    // 选中区高亮覆盖
    const sx = xOf(start); const ex = xOf(end)
    // 选中区高亮底
    g.fillStyle = accent
    g.globalAlpha = 0.22
    g.fillRect(sx, 0, ex - sx, waveH)
    // 起止手柄：顶宽底窄的三角把手 + 竖线
    g.globalAlpha = 1
    const handleColor = accent
    const drawHandle = (x: number): void => {
      g.fillStyle = handleColor
      g.fillRect(x - 1.5, 0, 3, waveH)
      g.beginPath()
      g.moveTo(x - 6, 18); g.lineTo(x + 6, 18); g.lineTo(x, 6)
      g.closePath(); g.fill()
    }
    drawHandle(sx)
    drawHandle(ex)
    g.globalAlpha = 1
    // 起止时间刻度
    g.fillStyle = fg
    g.font = '11px sans-serif'
    g.textAlign = 'center'
    g.fillText(fmtTime(start), Math.max(10, sx), h - 8)
    g.fillText(fmtTime(end), Math.max(10, ex), h - 8)
    // 试听播放头：当前播放位置白色/亮色竖线
    if (playhead >= 0 && playhead >= start && playhead <= end) {
      const px = xOf(playhead)
      g.fillStyle = '#fff'
      g.fillRect(px, 0, 1.5, waveH)
    }
  }, [peaks, start, end, duration, playhead])

  // 指针交互：拖左右手柄改起止。端点强制 start<end 且 end-start≤MAX_SEC
  const onPointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    if (!canvas || !duration) return
    const rect = canvas.getBoundingClientRect()
    const x = e.clientX - rect.left
    const pxStart = (start / duration) * rect.width
    const pxEnd = (end / duration) * rect.width
    const TH = 8 // 手柄吸附半径(px)
    if (Math.abs(x - pxStart) <= TH) draggingRef.current = 'start'
    else if (Math.abs(x - pxEnd) <= TH) draggingRef.current = 'end'
    else if (x > pxStart && x < pxEnd) { /* 点击选中区不动 */ }
    else { const s = Math.max(0, Math.min(duration, (x / rect.width) * duration)); setStart(s); setEnd(Math.min(duration, s + MAX_SEC)) }
  }, [start, end, duration])

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const mode = draggingRef.current
    const canvas = canvasRef.current
    if (!mode || !canvas || !duration) return
    const rect = canvas.getBoundingClientRect()
    const sec = Math.max(0, Math.min(duration, ((e.clientX - rect.left) / rect.width) * duration))
    if (mode === 'start') {
      const next = Math.max(0, Math.min(end - 1, sec))
      setStart(next)
      if (end - next > MAX_SEC) setEnd(next + MAX_SEC)
    } else {
      const next = Math.max(start + 1, Math.min(duration, sec))
      setEnd(next)
      if (next - start > MAX_SEC) setStart(next - MAX_SEC)
    }
  }, [start, end, duration])

  const stopDrag = useCallback(() => { draggingRef.current = null }, [])

  // 停止试听（释放 context / source / RAF）
  const stopPlayback = useCallback(() => {
    try { sourceRef.current?.stop() } catch { /* 已停止 */ }
    sourceRef.current = null
    try { playCtxRef.current?.close() } catch { /* 已关闭 */ }
    playCtxRef.current = null
    if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null }
    setPlaying(false)
    setPlayhead(-1)
  }, [])

  // 从区间的 fromSec 起播放到 end 为止（用独立 AudioContext + BufferSource）
  const playRange = useCallback((fromSec: number, toSec: number) => {
    if (!buffer || toSec <= fromSec) return
    const AC: typeof AudioContext =
      window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    const ctx = new AC()
    const src = ctx.createBufferSource()
    src.buffer = buffer
    src.connect(ctx.destination)
    src.onended = (): void => stopPlayback()
    src.start(0, fromSec, toSec - fromSec)
    playCtxRef.current = ctx
    sourceRef.current = src
    playStartRef.current = fromSec
    playCtxT0Ref.current = ctx.currentTime
    setPlaying(true)
    setPlayhead(fromSec)
    const tick = (): void => {
      const now = playCtxRef.current?.currentTime ?? 0
      const pos = fromSec + (now - playCtxT0Ref.current)
      if (pos >= toSec) { stopPlayback(); return }
      setPlayhead(pos)
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
  }, [buffer, stopPlayback])

  // 试听或暂停选中片段 [start, end]
  const togglePlay = useCallback(() => {
    if (playing) { stopPlayback(); return }
    playRange(start, end)
  }, [playing, stopPlayback, start, end, playRange])

  // 拖拽改变起止期间：若正在播放且播放头越界，停止试听（避免撕裂区间外的声音）
  useEffect(() => {
    if (playing && (playhead < start || playhead >= end)) stopPlayback()
  }, [start, end, playing, playhead, stopPlayback])

  // 卸载时清理
  useEffect(() => () => stopPlayback(), [stopPlayback])

  const confirm = useCallback(async () => {
    if (!buffer || busy) return
    setBusy(true)
    try {
      const sampleRate = buffer.sampleRate
      const chans: Float32Array[] = []
      for (let c = 0; c < buffer.numberOfChannels; c++) {
        const data = buffer.getChannelData(c)
        const s = Math.floor(start * sampleRate)
        const e = Math.min(data.length, Math.floor(end * sampleRate))
        chans.push(data.slice(s, e))
      }
      const bytes = encodeWav(chans, sampleRate)
      await onConfirm(bytes, start, end)
    } finally {
      setBusy(false)
    }
  }, [buffer, busy, start, end, onConfirm])

  const selectedLen = end - start

  return createPortal(
    <div
      className="modal-overlay"
      style={{ zIndex: 500 }}
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onCancel() }}
    >
      <div className="modal-card" style={{ width: 'min(92vw, 680px)', padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontSize: 15, fontWeight: 600 }}>音频裁剪</div>
          <div style={{ fontSize: 12, color: 'var(--fg-secondary)', wordBreak: 'break-all' }}>{file.name}</div>
        </div>

        <div style={{ fontSize: 13, color: 'var(--fg-secondary)', lineHeight: 1.6 }}>
          该音频共 <b>{fmtTime(duration)}</b>，厂商仅支持 ≤ {MAX_SEC}s 的参考音频。
          请拖动下方波形左右手柄，选择要保留的片段（自动限制在 {MAX_SEC}s 内）。
        </div>

        <canvas
          ref={canvasRef}
          style={{ width: '100%', height: 130, touchAction: 'none', cursor: duration ? 'ew-resize' : 'default' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={stopDrag}
          onPointerLeave={stopDrag}
        />

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13, gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button
              className="btn-sm"
              onClick={togglePlay}
              disabled={!buffer || busy}
              title={playing ? '暂停试听' : '播放选中片段试听'}
              style={{ padding: '2px 10px' }}
            >
              {playing ? '暂停' : '试听'}
            </button>
            <span>
              选中 <b style={{ color: 'var(--accent)' }}>{fmtTime(start)}</b> ~ <b style={{ color: 'var(--accent)' }}>{fmtTime(end)}</b>
              ({selectedLen.toFixed(1)}s)
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {playing && playhead >= 0 && <span style={{ color: 'var(--accent)' }}>{fmtTime(playhead)}</span>}
            <span style={{ color: selectedLen > MAX_SEC ? 'var(--danger, #e5484d)' : 'var(--fg-secondary)' }}>上限 {MAX_SEC}s</span>
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn-sm" onClick={() => { if (!busy) onCancel() }} disabled={busy}>取消</button>
          <button className="btn-sm primary" onClick={confirm} disabled={busy || !buffer}>
            {busy ? '裁剪中...' : `确认裁剪（${selectedLen.toFixed(1)}s）`}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}