import { useEffect, useRef, useState } from 'react'

// 视频缩略图：加载本地/远程视频，取首帧画到 canvas 生成图片；点击触发预览
export function VideoThumb({
  src,
  onClick,
  style
}: {
  src: string
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void
  style?: React.CSSProperties
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [thumb, setThumb] = useState<string | null>(null)

  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    const draw = (): void => {
      try {
        if (v.readyState >= 2 && v.videoWidth > 0 && canvasRef.current) {
          const c = canvasRef.current
          c.width = 200
          c.height = Math.max(1, Math.round((200 * v.videoHeight) / v.videoWidth))
          c.getContext('2d')?.drawImage(v, 0, 0, c.width, c.height)
          setThumb(c.toDataURL('image/jpeg', 0.7))
        }
      } catch {
        // 取帧失败保留 video 元素兜底
      }
    }
    const onLoaded = (): void => {
      try {
        v.currentTime = Math.min(0.2, (v.duration || 1) * 0.1)
      } catch {}
    }
    const onSeeked = (): void => draw()
    v.addEventListener('loadedmetadata', onLoaded)
    v.addEventListener('seeked', onSeeked)
    v.addEventListener('loadeddata', draw)
    return () => {
      v.removeEventListener('loadedmetadata', onLoaded)
      v.removeEventListener('seeked', onSeeked)
      v.removeEventListener('loadeddata', draw)
    }
  }, [src])

  return (
    <button
      type="button"
      className="video-thumb"
      title="点击预览视频"
      onClick={onClick}
      style={{
        padding: 0,
        border: 'none',
        background: 'transparent',
        cursor: onClick ? 'pointer' : 'default',
        display: 'block',
        width: '100%',
        height: '100%',
        ...style
      }}
    >
      {thumb ? (
        <img
          src={thumb}
          alt="预览"
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        />
      ) : (
        <video
          ref={videoRef}
          src={src}
          muted
          playsInline
          preload="auto"
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        />
      )}
      <canvas ref={canvasRef} style={{ display: 'none' }} />
    </button>
  )
}
