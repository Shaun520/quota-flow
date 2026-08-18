// 参考图上传到 Supabase Storage（qf-images 桶）
//
// 目的：智谱等开放平台 API 要求 image_url 为可公网访问的 http(s) 地址，
//       本地文件无法直传，因此选图即上传到 qf-images 桶，取公开 https URL 透传。
// 桶策略见 migrations/0028_qf_images_storage.sql（公开读 + 按用户目录写入）。
import { getAuthService } from '../auth/service'
import { ensureFreshSession } from '../auth/session'

const IMAGE_BUCKET = 'qf-images'

function fileExt(file: File): string {
  const name = (file.name.split('.').pop() || 'png')
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase()
  return name && /^(jpe?g|png|gif|webp)$/.test(name) ? name : 'png'
}

/**
 * 把一张本地图片上传到 qf-images 桶，返回公网 https URL。
 * 路径约定 <uid>/<随机>. <ext>，与迁移中的 RLS 目录策略对齐。
 */
export async function uploadReferenceImage(file: File): Promise<string> {
  const auth = getAuthService()
  if (!auth) throw new Error('登录态异常，请重新登录')
  const client = auth.getClient()
  const guard = await ensureFreshSession()
  if (!guard.ok) throw new Error('登录已过期，请重新登录')
  const session = await auth.getSession()
  if (!session?.user?.id) throw new Error('登录态异常，请重新登录')

  const storagePath = `${session.user.id}/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${fileExt(file)}`
  const { error: uploadError } = await client.storage
    .from(IMAGE_BUCKET)
    .upload(storagePath, file, {
      cacheControl: '3600',
      contentType: file.type || undefined
    })
  if (uploadError) throw uploadError

  const { data } = client.storage.from(IMAGE_BUCKET).getPublicUrl(storagePath)
  return data.publicUrl
}