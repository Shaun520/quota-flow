// 参考图上传到 GitHub 公开仓库，经 jsDelivr CDN 提供公网 https URL（替代原 Supabase qf-images 桶）
//
// 目的：智谱等开放平台 API 要求 image_url 为可公网访问的 http(s) 地址，
//       本地文件无法直传，因此选图即上传到公开仓库对应目录，取 jsDelivr CDN 地址透传（免费、0 带宽费）。
//       该公网 URL 仅在生成瞬间透传给厂商 API；历史展示走 userData/images 本地副本，不依赖 CDN 可用性。
// 上传在主进程完成（token 不落渲染层），此处仅读取文件字节并经 IPC 递交。
function fileExt(file: File): string {
  const name = (file.name.split('.').pop() || 'png')
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase()
  return name && /^(jpe?g|png|gif|webp)$/.test(name) ? (name === 'jpeg' ? 'jpg' : name) : 'png'
}

/** 推断图片扩展名（png/jpg/gif/webp），供本地副本落盘与 GitHub 上传复用 */
export function inferImageExt(file: File): string {
  return fileExt(file)
}

/** 单张参考图编码为 jpg 时优先（压缩产物统一 jpg）；再按扩展名匹配 Content-Type。 */
export function imageContentType(ext: string): string {
  const e = ext.toLowerCase()
  if (e === 'png') return 'image/png'
  if (e === 'gif') return 'image/gif'
  if (e === 'webp') return 'image/webp'
  return 'image/jpeg'
}

// 单张超过此阈值即压缩：GitHub 单文件上限 100MB、jsDelivr 单文件约 20MB，压缩保证原图再大也安全，且不撑大仓库。
const REENCODE_OVER = 8 * 1024 * 1024
const MAX_DIM = 2048
const JPEG_QUALITY = 0.85

export interface PreparedRefImage {
  bytes: ArrayBuffer
  ext: string
  /** 是否发生了重新编码（true 时本地副本应存压缩后的字节，而非原文件路径） */
  reencoded: boolean
}

/**
 * 参考图预处理：大图在渲染层用 canvas 缩放/压缩到远小于仓库与 CDN 单文件限制。
 * 小图原样返回（不重新编码，布尔存磁盘路径优化）；压缩失败回退原始字节尽力上传。
 */
export async function prepareReferenceImage(file: File): Promise<PreparedRefImage> {
  const diskExt = inferImageExt(file)
  if (file.size <= REENCODE_OVER) {
    return { bytes: await file.arrayBuffer(), ext: diskExt, reencoded: false }
  }
  try {
    const bmp = await createImageBitmap(file)
    try {
      let width = bmp.width
      let height = bmp.height
      const scale = Math.min(1, MAX_DIM / Math.max(width, height))
      width = Math.max(1, Math.round(width * scale))
      height = Math.max(1, Math.round(height * scale))
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('canvas 不可用')
      ctx.drawImage(bmp, 0, 0, width, height)
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', JPEG_QUALITY))
      if (!blob || blob.size === 0) throw new Error('压缩失败')
      return { bytes: await blob.arrayBuffer(), ext: 'jpg', reencoded: true }
    } finally {
      bmp.close()
    }
  } catch {
    return { bytes: await file.arrayBuffer(), ext: diskExt, reencoded: false }
  }
}