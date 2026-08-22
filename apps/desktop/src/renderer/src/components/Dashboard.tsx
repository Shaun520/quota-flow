import { useEffect, useState, useRef, useCallback, useMemo } from 'react'
import type { ChangeEvent as ReactChangeEvent, ClipboardEvent as ReactClipboardEvent } from 'react'
import { createPortal } from 'react-dom'
import {
  DEFAULT_SUPPORTED_DURATIONS,
  MODELS,
  computeCost,
  durationOptions,
  providerModeOptions,
  ratioOptions,
  resolutionOptions,
  uploadHint,
  zhipuModelDurations,
  bailianModelDurations,
  bailianModelInputs,
  tkhModelDurations
} from '../spec'
import { IconInfo, IconMaximize, IconPlay, IconUpload, ProviderIconMark } from './icons'
import { EmptyState } from './EmptyState'
import Select from './Select'
import type { JobItem } from '../hooks/useJobs'
import { useAuth } from '../hooks/useAuth'
import type { ProvidersResult } from '../hooks/useProviders'
import { getEncryptedKey } from '../hooks/useProviders'
import type { JobsResult } from '../hooks/useJobs'
import type { UsageScope, ViewScope } from '@quota-flow/db-supabase'
import { getAuthService, getProviderService, getSupabaseConfig } from '../auth/service'
import { ensureFreshSession } from '../auth/session'
import { VideoThumb } from './VideoThumb'
import { getInitialShowWebview } from './Modals'
import type { DesktopFeatureFlags } from '../hooks/useDesktopPermissions'
import type { ProviderCaps, ProviderCapsMap } from '../hooks/useProviderCaps'
import { imageContentType, prepareReferenceImage } from '../utils/uploadImage'
import AudioCropModal from './AudioCropModal'

const VIP = false

/** 需要通过公网上传（本地图转公网 URL）才能做图生/参考的 API 型厂商（历史图生记录重新生成时需重传本地图取新 URL） */
const API_IMAGE_PROVIDERS = ['zhipu', 'volcengine', 'bailian', 'tokenhub']

// 文生视频音频参考：扩展名 → MIME（与 github-upload 的 EXT_RE 及本地副本保存共用）
const AUDIO_TYPES: Record<string, string> = {
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg',
  aac: 'audio/aac', webm: 'audio/webm', flac: 'audio/flac', mp4: 'audio/mp4'
}

function audioExt(name: string): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name)
  return m ? m[1].toLowerCase() : 'm4a'
}

/** 探测本地音频文件时长（秒）。利用浏览器 <audio> 解码头信息，避免上传后才因超限报错。
 *  对无法解析的格式返回 null（由后端兜底），返回值可直接与厂商上限比较。 */
async function probeAudioDuration(file: File): Promise<number | null> {
  return new Promise<number | null>((resolve) => {
    try {
      const url = URL.createObjectURL(file)
      const audio = new Audio()
      audio.preload = 'metadata'
      audio.src = url
      audio.onloadedmetadata = () => {
        const d = Number.isFinite(audio.duration) ? audio.duration : null
        URL.revokeObjectURL(url)
        resolve(d)
      }
      audio.onerror = () => {
        URL.revokeObjectURL(url)
        resolve(null)
      }
      // 兜底：最多等 3s，防止极端格式卡死
      setTimeout(() => { URL.revokeObjectURL(url); resolve(null) }, 3000)
    } catch {
      resolve(null)
    }
  })
}

/** PCM 采样数据（含声道/采样率信息）序列化为标准 WAV 字节流（16bit PCM）——已迁移至 AudioCropModal */
// （原 encodeWav/clipAudioTo30s 已移除，裁剪交互由 AudioCropModal 承担）

// 参考生（r2v）参考视频：扩展名 → MIME（与 github-upload 的 EXT_RE 及本地副本保存共用）
const VIDEO_TYPES: Record<string, string> = {
  mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/x-m4v',
  webm: 'video/webm', mkv: 'video/x-matroska', avi: 'video/x-msvideo'
}

function videoExt(name: string): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name)
  return m ? m[1].toLowerCase() : 'mp4'
}

/** 参考生（r2v）可上传的参考视频上限（官方媒体合计 ≤5，预留图片并行，固定给 3 个视频位） */
const MAX_REF_VIDEOS = 3

function maxImageUploadCount(provider: string, model: string): number {
  // 智谱按模型能力限制图片上传数量：图生视频1张、首尾帧2张、Vidu 2参考生视频最多5张
  if (provider === 'zhipu') {
    switch (model) {
      case 'cogvideox-flash':
      case 'cogvideox-2':
      case 'cogvideox-3':
        return 1
      case 'Vidu Q1':
        return 2
      case 'Vidu 2':
        return 5
      default:
        return 1
    }
  }
  if (provider === 'yuanbao' || provider === 'dola') return 10
  if (provider === 'doubao') return 10
  // TokenHub 图生为首帧引导（单图，后端仅取首张），限 1 张；不放开成多图/多参考
  if (provider === 'tokenhub') return 1
  return 5
}

/** 生成阶段 → 用户可见文案 */
const STAGE_LABEL: Record<string, string> = {
  pending: '正在创建任务…',
  'select-account': '选择账号中…',
  'inject-cookies': '注入登录态…',
  'open-page': '打开厂商页面…',
  'wait-tab': '进入视频生成…',
  'open-video-tab': '进入视频生成…',
  'apply-duration': '设置时长…',
  'apply-params': '设置厂商视频参数…',
  'upload-images': '上传图片中…',
  'upload-images-result': '上传图片中…',
  submit: '发送 prompt 中…',
  'submit-img2video': '发送 prompt 中…',
  waiting: '视频开始生成中…（排队中）',
  'risk-verify': '需要验证，请在弹窗完成…',
  'risk-resolved': '验证完成，继续生成…',
  'account-failed': '当前账号失败，尝试切换…',
  blocked: '厂商拒绝了本次生成（见左侧错误）',
  // API 分支（智谱）onProgress 的兜底文案；有具体进度时优先展示 genProgress
  progress: '正在生成…'
}

/** 进入这些阶段说明提示词已发送，不能再终止生成 */
const SUBMITTED_STAGES = new Set([
  'submit',
  'submit-img2video',
  'submit-verify',
  'submit-verify-fallback',
  'waiting',
  'risk-verify',
  'risk-resolved',
  'blocked'
])

interface DashboardProps {
  fresh: boolean
  banner: boolean
  step: 1 | 2 | 3
  viewScope: ViewScope
  usageScope: UsageScope
  onUsageScopeChange: (scope: UsageScope) => void
  onGenerate?: () => void
  onGoHistory: () => void
  onGoProviders: () => void
  providers: ProvidersResult
  jobs: JobsResult
  features: DesktopFeatureFlags
  providerCaps: ProviderCapsMap
  regenerateDraft?: RegenerateDraft | null
  /** 素材库「用作参考」注入的图片：添加为图像参考并切到图生/多参考模式 */
  materialImages?: Array<{ path: string; url: string }>
  onMaterialImagesConsumed?: () => void
  onRegenerateConsumed?: () => void
}

export interface RegenerateDraft {
  prompt: string
  providerId: string
  model: string
  durationSec: number
  resolution: string
  audio: string
  ratio: string
  mode: string
  images: string[]
  /** 文生视频音频参考的本地副本路径（重新生成时用于重传取新公网 URL） */
  audioLocalPath?: string | null
  /** 文生视频音频参考的公网 https URL（旧记录兼容，地址如已删则按本地副本重传） */
  audioUrl?: string | null
}

function normalizeRegenerateMode(providerId: string, rawMode?: string): string {
  // 元宝仅图生/文生：历史 multi_ref（多参考）记录归为图生视频
  if (providerId === 'yuanbao') {
    if (rawMode === 'text2video' || rawMode === 't2v') return 't2v'
    return 'img'
  }
  if (rawMode === 'text2video' || rawMode === 't2v') return 't2v'
  if (rawMode === 'img2video' || rawMode === 'img') return 'img'
  if (rawMode === 'multi_ref' || rawMode === 'first_last' || rawMode === 'first_frame') return rawMode
  if (providerId === 'dola' || providerId === 'qwenwan') return 'multi_ref'
  return 't2v'
}

/** 桌面子模式键归一为 admin 目录扁平键，用于与 caps.modes 求交集 */
function toFlatMode(value: string): string {
  if (value === 't2v') return 'text2video'
  if (value === 'img') return 'img2video'
  return value
}

function visibleModeOptions(
  provider: string,
  model: string,
  features: DesktopFeatureFlags,
  caps?: ProviderCaps
): Array<{ value: string; label: string }> {
  const base = providerModeOptions(provider, model).filter((option) => {
    if (option.value === 't2v' || option.value === 'text2video') return features['dispatch.text2video']
    if (option.value === 'img' || option.value === 'img2video') return features['dispatch.img2video']
    if (option.value === 'multi_ref') return features['dispatch.multi_ref']
    if (option.value === 'first_last') return features['dispatch.first_last']
    if (option.value === 'first_frame') return features['dispatch.first_frame']
    return true
  })
  // Admin 配置了厂商级 caps 时，模式列表与 caps.modes 求交集（双层 AND）
  if (caps?.modes) {
    const allowed = new Set(caps.modes)
    return base.filter((option) => allowed.has(toFlatMode(option.value)))
  }
  return base
}

export default function Dashboard({
  fresh,
  banner,
  step,
  viewScope,
  usageScope,
  onUsageScopeChange,
  onGenerate,
  onGoHistory,
  onGoProviders,
  providers,
  jobs,
  features,
  providerCaps,
  regenerateDraft,
  materialImages,
  onMaterialImagesConsumed,
  onRegenerateConsumed
}: DashboardProps) {
  const { aggs: provAggs, zhipuQuotaOverrides, volcTokenOverrides, bailianQuotaOverrides } = providers
  const { user, team } = useAuth()
  const { items: jobItems, reload: reloadJobs } = jobs
  const [provider, setProvider] = useState('doubao')
  const [model, setModel] = useState(MODELS.doubao[0])
  const [mode, setMode] = useState('text2video')
  const [duration, setDuration] = useState(5)
  const [resolution, setResolution] = useState('720')
  const [audio, setAudio] = useState('on')
  const [ratio, setRatio] = useState('9:16')
  const [images, setImages] = useState<string[]>([])
  const [imageFiles, setImageFiles] = useState<File[]>([])
  const [savedImagePaths, setSavedImagePaths] = useState<string[]>([])
  // 开放平台 API 型厂商（智谱/火山/百炼）参考图的公网 https URL：仅用于生成时透传厂商，历史展示走 savedImagePaths 本地路径
  const [apiImageUrls, setApiImageUrls] = useState<string[]>([])
  // 开放平台 API 型厂商（智谱/火山）图片异步上传计数：>0 表示尚有图片在上传，禁用「开始生成」
  const [uploadingCount, setUpLoadingCount] = useState(0)
  // 文生视频（bailian）音频参考：公网 https URL 透传厂商 + 本地副本供历史回显/重新生成回填
  const [audioName, setAudioName] = useState('')
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  const [audioLocalPath, setAudioLocalPath] = useState<string | null>(null)
  // TokenHub 特效模板（yt-video-fx）：控制台创建的特效模板标识，随目标模型生成时透传提交 body 的 Template 字段
  const [tkhFxTemplate, setTkhFxTemplate] = useState('')
  const isTkhFx = provider === 'tokenhub' && model === 'yt-video-fx'
  const [audioUploading, setAudioUploading] = useState(false)
  // 音频裁剪弹窗：文件时长超过厂商上限时弹出，让用户自行拖选起止区间后上传
  const [cropAudio, setCropAudio] = useState<{ file: File; duration: number } | null>(null)
  // 参考生（r2v）参考视频：仅 multi_ref 的百炼 r2v 模型开放。
  //   refVideoPreviews   展示用 URL（新选=blob；重新生成回填=本地媒体服务 URL）
  //   refVideoLocalPaths 本地副本路径（随任务入库，历史回显/重新生成回填）
  //   refVideoUrls       公网 https URL（透传厂商 input.media reference_video）
  //   refVideoNames      文件名（供展示/删除）
  const [refVideoPreviews, setRefVideoPreviews] = useState<string[]>([])
  const [refVideoLocalPaths, setRefVideoLocalPaths] = useState<string[]>([])
  const [refVideoUrls, setRefVideoUrls] = useState<string[]>([])
  const [refVideoNames, setRefVideoNames] = useState<string[]>([])
  const [refVideoUploading, setRefVideoUploading] = useState(false)
  const [refVideoPreviewing, setRefVideoPreviewing] = useState<string | null>(null)
  // 参考生（r2v）统一上传框的素材添加顺序：把图片（img）与视频（vid）交错排列成一行，保证点击顺序与视觉一致。
  //   每个条目记录 {k: 'img' | 'vid', i: 在该类型数组内的下标}；删除时会自动重排同类条目下标。
  type RefOrderEntry = { k: 'img'; i: number } | { k: 'vid'; i: number }
  const [refItemOrder, setRefItemOrder] = useState<RefOrderEntry[]>([])
  const totalRefItemCount = savedImagePaths.length + refVideoLocalPaths.length
  // 自定义深色音频播放器状态（替换原生 <audio controls> 白底风格）
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [audioPlaying, setAudioPlaying] = useState(false)
  const [audioCurrentTime, setAudioCurrentTime] = useState(0)
  const [audioDuration, setAudioDuration] = useState(0)
  const [prompt, setPrompt] = useState('')
  const [generating, setGenerating] = useState(false)
  const [genError, setGenError] = useState<string | null>(null)
  const [genFailed, setGenFailed] = useState(false)
  const [genStage, setGenStage] = useState<string | null>(null)
  // 智谱等 API 分支 onProgress 的具体进度文案（限流重试、正在生成等），供状态区直接显示
  const [genProgress, setGenProgress] = useState<string | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const submittedRef = useRef(false)
  const cancellingRef = useRef(false)
  const [imagePreview, setImagePreview] = useState<string | null>(null)
  const [promptPreview, setPromptPreview] = useState(false)
  const [promptInputHovered, setPromptInputHovered] = useState(false)
  const activeJobIdRef = useRef<string | null>(null)
  const [preview, setPreview] = useState<{ id: string; src: string } | null>(null)
  const [mediaUrls, setMediaUrls] = useState<Record<string, string>>({})
  const fileInputRef = useRef<HTMLInputElement>(null)
  const refVideoInputRef = useRef<HTMLInputElement>(null)

  // Admin 厂商级生成能力：命中 provider_caps 时该厂商模式/模型以配置为准，缺省回退硬编码默认
  const caps = providerCaps[provider]
  // 火山方舟：调度台模型列表以「账号绑定时实际抓到的免费模型」为准（优先），未抓到才回退 provider_caps / spec 固定目录
  const [volcModels, setVolcModels] = useState<string[] | null>(null)
  // 阿里云百炼：调度台模型列表 = 各已启用账号「绑定捕获」的免费/可用视频模型并集（优先），未抓到回退 spec 固定目录
  const [bailianModels, setBailianModels] = useState<string[] | null>(null)
  // 腾讯云 TokenHub：调度台模型列表 = 各已启用账号目录中可生成模型的并集（排除 FX，未抓到回退 spec 固定目录）
  const [tokenhubModels, setTokenhubModels] = useState<string[] | null>(null)
  const modelList = (p: string): string[] => {
    if (p === 'volcengine' && volcModels && volcModels.length > 0) return volcModels
    if (p === 'bailian' && bailianModels && bailianModels.length > 0) return bailianModels
    if (p === 'tokenhub' && tokenhubModels && tokenhubModels.length > 0) return tokenhubModels
    return providerCaps[p]?.models ?? MODELS[p] ?? MODELS.doubao
  }

  // 历史详情「重新生成」：把历史参数回填到调度台表单，图片走已保存副本路径
  useEffect(() => {
    if (!regenerateDraft) return
    const nextProvider = regenerateDraft.providerId
    const nextModel = modelList(nextProvider).includes(regenerateDraft.model)
      ? regenerateDraft.model
      : modelList(nextProvider)[0] ?? MODELS.doubao[0]
    const normalizedMode = normalizeRegenerateMode(nextProvider, regenerateDraft.mode)
    const nextModes = visibleModeOptions(nextProvider, nextModel, features, providerCaps[nextProvider])
    const nextMode = nextModes.some((m) => m.value === normalizedMode)
      ? normalizedMode
      : (nextModes[0]?.value ?? 'text2video')

    setProvider(nextProvider)
    setModel(nextModel)
    setMode(nextMode)
    setDuration(regenerateDraft.durationSec || 5)
    setResolution(regenerateDraft.resolution || '720')
    setAudio(regenerateDraft.audio || 'on')
    setRatio(regenerateDraft.ratio || '9:16')
    setPrompt(regenerateDraft.prompt || '')
    setImageFiles([])
    setSavedImagePaths(regenerateDraft.images ?? [])
    setApiImageUrls([])
    setImages([])
    // 音频回填：本地副本路径就地保留；公网 https URL 若记录存在则直接复用，供重传判定
    setAudioName('')
    setAudioUrl(regenerateDraft.audioUrl ?? null)
    setAudioLocalPath(regenerateDraft.audioLocalPath ?? null)
    setGenError(null)
    setGenFailed(false)

    let cancelled = false
    const paths = regenerateDraft.images ?? []
    const names = paths
      .map((p) => p.replace(/\\/g, '/').split('/').pop() || '')
      .filter(Boolean)
    Promise.all(names.map((n) => window.api.media.getImageUrl(n).catch(() => null)))
      .then((urls) => {
        if (cancelled) return
        setImages(urls.filter((u): u is string => !!u))
      })
      .catch(() => {})
    // 历史已改为本地副本：API 厂商图生再生成需的参考图，http(s) 旧 URL 直接复用，本地路径重传取新公网 URL（原 URL 生成后已删）
    if (API_IMAGE_PROVIDERS.includes(nextProvider) && paths.length > 0) {
      void Promise.all(
        paths.map(async (p) => {
          if (/^https?:\/\//i.test(p)) return p
          try {
            const bytes = await window.api.storage.readImageLocal(p)
            const ext = (/\.(png|gif|webp|jpe?g)$/i.exec(p)?.[1] ?? 'png').toLowerCase().replace('jpeg', 'jpg')
            const { url } = await window.api.storage.uploadImage({ bytes, contentType: imageContentType(ext), ext })
            return url
          } catch {
            return ''
          }
        })
      )
        .then((urls) => {
          if (cancelled) return
          setApiImageUrls(urls.filter((u): u is string => !!u))
        })
        .catch(() => {})
    }
    // 百炼文生音频参考：有本地副本则重传取新公网 URL（原 https URL 生成后已删），供生成时透传 input.audio_url
    const audioLocal = regenerateDraft.audioLocalPath ?? null
    if (nextProvider === 'bailian' && normalizedMode === 't2v' && audioLocal) {
      const aExt = audioExt(audioLocal)
      window.api.storage
        .readImageLocal(audioLocal)
        .then(async (bytes) => {
          const { url } = await window.api.storage.uploadImage({ bytes, contentType: AUDIO_TYPES[aExt] ?? 'audio/mpeg', ext: aExt })
          if (cancelled) return
          setAudioUrl(url)
          setAudioName(audioLocal.split(/[\\/]/).pop() || '')
        })
        .catch(() => {
          // 本地副本不可读（已被清理）时保持无音频状态，不阻断重新生成
        })
    }
    onRegenerateConsumed?.()
    return () => {
      cancelled = true
    }
  }, [regenerateDraft, features, providerCaps, onRegenerateConsumed])

  // 素材库「用作参考」：把图片追加为图像参考，并切到当前厂商可用的图生/多参考模式
  useEffect(() => {
    if (!materialImages || materialImages.length === 0) return
    setSavedImagePaths((prev) => [...prev, ...materialImages.map((m) => m.path)])
    setImages((prev) => [...prev, ...materialImages.map((m) => m.url)])
    // 素材图是本地路径；仅当素材给了公开 https URL 时才可作 API 厂商参考图透传（否则生成走本地路径）
    setApiImageUrls((prev) => [...prev, ...materialImages.filter((m) => /^https?:\/\//i.test(m.url)).map((m) => m.url)])
    const validModes = visibleModeOptions(provider, model, features, caps)
    const imageMode = validModes.find((m) => ['multi_ref', 'img', 'img2video', 'first_last', 'first_frame'].includes(m.value))
    if (imageMode && imageMode.value !== mode) setMode(imageMode.value)
    onMaterialImagesConsumed?.()
  }, [materialImages, provider, model, features, caps, mode, onMaterialImagesConsumed])

  const activeBoundAggs = useMemo(
    () => provAggs.filter((a) => a.enabled && a.boundCount > 0),
    [provAggs]
  )

  // 火山方舟：调度台模型下拉 = 各已启用账号「绑定时所抓」全部免费模型的并集（动态，非固定文件/库定义）
  useEffect(() => {
    const svc = getProviderService()
    if (!svc || !user) return
    const agg = provAggs.find((a) => a.providerId === 'volcengine' && a.enabled)
    if (!agg || agg.bindings.length === 0) {
      if (volcModels === null) setVolcModels([])
      return
    }
    const enabled = agg.bindings.filter((b) => b.enabled)
    if (enabled.length === 0) return
    let cancelled = false
    void (async () => {
      const union = new Set<string>()
      for (const b of enabled) {
        try {
          const encrypted = await getEncryptedKey(user.id, b.keyId)
          if (!encrypted) continue
          const res = await window.api.providers.apiModels('volcengine', encrypted)
          if (res.ok && res.models) res.models.forEach((m) => m && m.model && union.add(m.model))
        } catch {
          // 单个账号抓取失败不影响整体目录
        }
      }
      if (!cancelled) setVolcModels(Array.from(union))
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, provAggs, volcModels === null])

  // 阿里云百炼：调度台模型下拉 = 各已启用账号「绑定捕获」的可用视频模型并集（动态，非固定文件/库定义）
  useEffect(() => {
    const svc = getProviderService()
    if (!svc || !user) return
    const agg = provAggs.find((a) => a.providerId === 'bailian' && a.enabled)
    if (!agg || agg.bindings.length === 0) {
      if (bailianModels === null) setBailianModels([])
      return
    }
    const enabled = agg.bindings.filter((b) => b.enabled)
    if (enabled.length === 0) return
    let cancelled = false
    void (async () => {
      const union = new Set<string>()
      for (const b of enabled) {
        try {
          const encrypted = await getEncryptedKey(user.id, b.keyId)
          if (!encrypted) continue
          const res = await window.api.providers.apiModels('bailian', encrypted)
          if (res.ok && res.models)
            res.models.forEach((m) => {
              // detect/专用模型（unavailable='no_endpoint'）只进「查看模型」，不进调度台可生成列表
              if (m && m.model && m.unavailable !== 'no_endpoint') union.add(m.model)
            })
        } catch {
          // 单个账号抓取失败不影响整体目录
        }
      }
      if (!cancelled) setBailianModels(Array.from(union))
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, provAggs, bailianModels === null])

  // 腾讯云 TokenHub：调度台模型下拉 = 各已启用账号目录中「可生成」模型并集（unavailable=no_endpoint 的 FX 不进列表），未抓到回退 spec 固定目录
  useEffect(() => {
    const svc = getProviderService()
    if (!svc || !user) return
    const agg = provAggs.find((a) => a.providerId === 'tokenhub' && a.enabled)
    if (!agg || agg.bindings.length === 0) {
      if (tokenhubModels === null) setTokenhubModels([])
      return
    }
    const enabled = agg.bindings.filter((b) => b.enabled)
    if (enabled.length === 0) return
    let cancelled = false
    void (async () => {
      const union = new Set<string>()
      for (const b of enabled) {
        try {
          const encrypted = await getEncryptedKey(user.id, b.keyId)
          if (!encrypted) continue
          const res = await window.api.providers.apiModels('tokenhub', encrypted)
          if (res.ok && res.models)
            res.models.forEach((m) => {
              if (m && m.model && m.unavailable !== 'no_endpoint') union.add(m.model)
            })
        } catch {
          // 单个账号抓取失败不影响整体目录
        }
      }
      if (!cancelled) setTokenhubModels(Array.from(union))
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, provAggs, tokenhubModels === null])

  const providerDurations = useMemo(() => {
    return new Map(provAggs.map((a) => [a.providerId, a.durations]))
  }, [provAggs])
  const selectedDurations = useMemo(() => {
    // 智谱固定生成时长为模型级能力（cogvideox-3 5/10s、Vidu Q1 5s、Vidu 2 4s 等），
    // 与主进程 api-branch 的模型时长校验保持一致，避免 UI 可选但与生成校验冲突。
    if (provider === 'zhipu') return zhipuModelDurations(model)
    if (provider === 'bailian') return bailianModelDurations(model)
    if (provider === 'tokenhub') return tkhModelDurations(model)
    return providerDurations.get(provider) ?? DEFAULT_SUPPORTED_DURATIONS
  }, [provider, model, providerDurations])
  const durations = durationOptions(provider, model, mode, VIP, selectedDurations)
  const modeOptions = useMemo(
    () => visibleModeOptions(provider, model, features, caps),
    [provider, model, features, caps]
  )
  const resolutions = resolutionOptions(provider)
  const ratios = ratioOptions(provider)
  const cost = computeCost(provider, model, duration, resolution)
  const upload = uploadHint(provider, mode)
  // 文生视频（bailian）音频参考能力：仅当属百炼且当前为文生视频（text2video）模型且能力卡含 Audio 时开放音频上传
  // 注意：mode 用长键（text2video/img2video），而非短键（t2v/img），与 providerModeOptions 下拉 value 一致
  const t2vSupportsAudio = provider === 'bailian' && mode === 'text2video' && bailianModelInputs(model).includes('Audio')
  // TokenHub 数字人（yt-video-humanactor）需配音音频：图生模式上开放音频上传，音频公网 URL 透传提交 body 的 AudioUrl
  const tkhHumanactorSupportsAudio = provider === 'tokenhub' && model === 'yt-video-humanactor' && mode === 'img2video'
  // 参考生（r2v）视频参考：仅当属百炼且当前为 multi_ref（参考生）且模型能力卡含 Video 时开放视频上传
  const r2vVideoActive = provider === 'bailian' && mode === 'multi_ref' && bailianModelInputs(model).includes('Video')

  // 音频上传：走与图片一致的 GitHub+jsDelivr https 链，公网 URL 供生成时透传厂商，本地副本供历史回显/回填
  const uploadAudio = useCallback(
    async (bytes: ArrayBuffer, ext: string): Promise<{ url: string; localPath: string }> => {
      const { url } = await window.api.storage.uploadImage({
        bytes,
        contentType: AUDIO_TYPES[ext] ?? 'audio/mpeg',
        ext: ext || 'm4a'
      })
      const { path } = await window.api.storage.saveImageLocal({ bytes, ext: ext || 'm4a' })
      return { url, localPath: path }
    },
    []
  )
  const onPickAudio = useCallback(
    async (e: ReactChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      e.target.value = ''
      if (!file) return
      const ext = audioExt(file.name)
      // 立即设置文件名 + 进入上传中状态，让用户马上看到 loading UI（而非等上传完成才显示）
      setAudioName(file.name)
      setAudioUrl(null)
      setAudioLocalPath(null)
      setAudioUploading(true)
      try {
        // 超长音频：弹出裁剪窗让用户自行拖选起止区间（自动限制在 30s 内），确认后再上传
        const dur = await probeAudioDuration(file)
        if (dur != null && dur > 30) {
          setCropAudio({ file, duration: dur })
          return
        }
        const bytes = await file.arrayBuffer()
        const { url, localPath } = await uploadAudio(bytes, ext)
        setAudioUrl(url)
        setAudioLocalPath(localPath)
      } catch (err) {
        setAudioName('')
        setGenError('音频上传失败：' + (err instanceof Error ? err.message : String(err)))
      } finally {
        setAudioUploading(false)
      }
    },
    [uploadAudio]
  )
  const handleCropDone = useCallback(
    async (bytes: ArrayBuffer, _start: number, _end: number): Promise<void> => {
      setAudioUploading(true)
      try {
        const { url, localPath } = await uploadAudio(bytes, 'wav')
        setAudioUrl(url)
        setAudioLocalPath(localPath)
        setCropAudio(null)
      } catch (err) {
        setAudioName('')
        setGenError('音频上传失败：' + (err instanceof Error ? err.message : String(err)))
      } finally {
        setAudioUploading(false)
      }
    },
    [uploadAudio]
  )
  const handleCropCancel = useCallback((): void => {
    setCropAudio(null)
    if (audioUploading) setAudioUploading(false)
  }, [audioUploading])
  const onRemoveAudio = useCallback((): void => {
    setAudioName('')
    setAudioUrl(null)
    setAudioLocalPath(null)
    setAudioPlaying(false)
    setAudioCurrentTime(0)
    setAudioDuration(0)
  }, [])

  // 参考视频（r2v）上传：与图片/音频一致走 GitHub+jsDelivr https 链，
  // 公网 URL（refVideoUrls）透传厂商 input.media，本地副本（refVideoLocalPaths）供历史回显/重新生成回填
  const uploadRefVideo = useCallback(
    async (file: File): Promise<{ url: string; localPath: string }> => {
      const ext = videoExt(file.name)
      const bytes = await file.arrayBuffer()
      const { url } = await window.api.storage.uploadImage({
        bytes,
        contentType: VIDEO_TYPES[ext] ?? 'video/mp4',
        ext: ext === 'm4v' ? 'm4v' : 'mp4'
      })
      const { path } = await window.api.storage.saveImageLocal({ bytes, ext: 'mp4' })
      return { url, localPath: path }
    },
    []
  )
  const onPickRefVideo = useCallback(
    async (e: ReactChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      e.target.value = ''
      if (!file) return
      const remaining = Math.max(0, MAX_REF_VIDEOS - refVideoLocalPaths.length)
      if (remaining <= 0) return
      // 先展示本地预览 + 进入上传态，避免等 HTTPS 完成才有反馈
      setRefVideoPreviews((prev) => [...prev, URL.createObjectURL(file)])
      setRefVideoLocalPaths((prev) => [...prev, ''])
      setRefVideoUrls((prev) => [...prev, ''])
      setRefVideoNames((prev) => [...prev, file.name])
      setRefVideoUploading(true)
      try {
        const { url, localPath } = await uploadRefVideo(file)
        setRefVideoLocalPaths((prev) => prev.map((p, i) => (i === prev.length - 1 ? localPath : p)))
        setRefVideoUrls((prev) => prev.map((u, i) => (i === prev.length - 1 ? url : u)))
      } catch (err) {
        setGenError('参考视频上传失败：' + (err instanceof Error ? err.message : String(err)))
        setRefVideoPreviews((prev) => prev.slice(0, -1))
        setRefVideoLocalPaths((prev) => prev.slice(0, -1))
        setRefVideoUrls((prev) => prev.slice(0, -1))
        setRefVideoNames((prev) => prev.slice(0, -1))
      } finally {
        setRefVideoUploading(false)
      }
    },
    [refVideoLocalPaths.length, uploadRefVideo]
  )
  const onRemoveRefVideo = useCallback((idx: number): void => {
    setRefVideoPreviews((prev) => prev.filter((_, i) => i !== idx))
    setRefVideoLocalPaths((prev) => prev.filter((_, i) => i !== idx))
    setRefVideoUrls((prev) => prev.filter((_, i) => i !== idx))
    setRefVideoNames((prev) => prev.filter((_, i) => i !== idx))
  }, [])
  const clearRefVideos = useCallback((): void => {
    setRefVideoPreviews([])
    setRefVideoLocalPaths([])
    setRefVideoUrls([])
    setRefVideoNames([])
  }, [])
  // 清空所有参考素材（图片 + 视频 + 顺序），用于切厂商/切模型/重置
  const clearAllRefAssets = useCallback((): void => {
    setImages([])
    setImageFiles([])
    setSavedImagePaths([])
    setApiImageUrls([])
    clearRefVideos()
    setRefItemOrder([])
  }, [clearRefVideos])

  // ===== 参考生（r2v）统一素材框：图片 + 视频 混合上传、一行预览 =====
  const refMixedInputRef = useRef<HTMLInputElement>(null)

  // 视频上传辅助（独立于图片上传，避免依赖 appendApiImages 声明位置）
  const appendVideoAsRef = useCallback(async (file: File): Promise<void> => {
    // 先登记占位条目（下标为当前 refVideoLocalPaths.length，即即将追加的位置）
    const newIdx = refVideoLocalPaths.length
    setRefVideoPreviews((prev) => [...prev, URL.createObjectURL(file)])
    setRefVideoLocalPaths((prev) => [...prev, ''])
    setRefVideoUrls((prev) => [...prev, ''])
    setRefVideoNames((prev) => [...prev, file.name])
    setRefItemOrder((prev) => [...prev, { k: 'vid', i: newIdx }])
    setRefVideoUploading(true)
    try {
      const { url, localPath } = await uploadRefVideo(file)
      setRefVideoLocalPaths((prev) => prev.map((p, i) => (i === newIdx ? localPath : p)))
      setRefVideoUrls((prev) => prev.map((u, i) => (i === newIdx ? url : u)))
    } catch (err) {
      setGenError('参考视频上传失败：' + (err instanceof Error ? err.message : String(err)))
      setRefVideoPreviews((prev) => prev.filter((_, i) => i !== newIdx))
      setRefVideoLocalPaths((prev) => prev.filter((_, i) => i !== newIdx))
      setRefVideoUrls((prev) => prev.filter((_, i) => i !== newIdx))
      setRefVideoNames((prev) => prev.filter((_, i) => i !== newIdx))
      setRefItemOrder((prev) => prev.filter((e) => !(e.k === 'vid' && e.i === newIdx)))
    } finally {
      setRefVideoUploading(false)
    }
  }, [refVideoLocalPaths.length, uploadRefVideo])

  // 音频播放器控制：用隐藏 <audio> 实现深色自定义 UI（替换原生白底控件）
  const toggleAudioPlay = useCallback(() => {
    const el = audioRef.current
    if (!el) return
    if (el.paused) {
      el.play().catch(() => { /* ignore */ })
    } else {
      el.pause()
    }
  }, [])

  const seekAudio = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const el = audioRef.current
    if (!el || !audioDuration) return
    const rect = e.currentTarget.getBoundingClientRect()
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    el.currentTime = pct * audioDuration
  }, [audioDuration])

  // 音频事件同步 React 状态
  useEffect(() => {
    const el = audioRef.current
    if (!el) return
    const onPlay = () => setAudioPlaying(true)
    const onPause = () => setAudioPlaying(false)
    const onTime = () => setAudioCurrentTime(el.currentTime)
    const onLoaded = () => setAudioDuration(el.duration || 0)
    const onEnded = () => { setAudioPlaying(false); setAudioCurrentTime(0) }
    el.addEventListener('play', onPlay)
    el.addEventListener('pause', onPause)
    el.addEventListener('timeupdate', onTime)
    el.addEventListener('loadedmetadata', onLoaded)
    el.addEventListener('ended', onEnded)
    return () => {
      el.removeEventListener('play', onPlay)
      el.removeEventListener('pause', onPause)
      el.removeEventListener('timeupdate', onTime)
      el.removeEventListener('loadedmetadata', onLoaded)
      el.removeEventListener('ended', onEnded)
    }
  }, [audioUrl])

  // 音频 URL 变化时重置播放状态
  useEffect(() => {
    setAudioPlaying(false)
    setAudioCurrentTime(0)
    setAudioDuration(0)
  }, [audioUrl])

  // 音频时间格式化
  const fmtTime = (s: number): string => {
    if (!isFinite(s) || s <= 0) return '0:00'
    const m = Math.floor(s / 60)
    const sec = Math.floor(s % 60)
    return `${m}:${sec.toString().padStart(2, '0')}`
  }

  // 调度台状态面板不展示后台已停用的厂商，避免出现置灰/停用态干扰调度信息。
  const visibleAggs = useMemo(() => provAggs.filter((p) => p.enabled !== false), [provAggs])

  // 厂商选项只取「已启用且已绑定」的厂商
  const providerOptions = useMemo(() => {
    if (activeBoundAggs.length === 0) return []
    return activeBoundAggs.map((a) => ({ value: a.providerId, label: a.name }))
  }, [activeBoundAggs])

  // 当前选择不在可用列表时（例如厂商被解绑），回退到第一个可用厂商
  useEffect(() => {
    if (providerOptions.length === 0) return
    const valid = providerOptions.map((o) => o.value)
    if (!valid.includes(provider)) {
      const next = valid[0]
      const nextModel = modelList(next)[0] ?? MODELS.doubao[0]
      setProvider(next)
      setModel(nextModel)
      const nextModes = visibleModeOptions(next, nextModel, features, providerCaps[next])
      setMode(nextModes[0]?.value ?? 'text2video')
      clearAllRefAssets()
    }
  }, [providerOptions, provider, features, providerCaps, clearAllRefAssets])

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

  useEffect(() => {
    const valid = ratioOptions(provider)
    if (!valid.some((r) => r.value === ratio)) {
      setRatio(valid[0]?.value ?? '9:16')
    }
  }, [provider, ratio])

  // 千问生成模式按模型限定；模型变化后若当前模式不可用，自动落到该模型第一个可用模式
  useEffect(() => {
    const validModes = visibleModeOptions(provider, model, features, caps).map((m) => m.value)
    if (!validModes.includes(mode)) {
      setMode(validModes[0] ?? 'text2video')
      clearAllRefAssets()
    }
  }, [provider, model, mode, features, caps])

  // 主进程生成事件：仅终态（成功/失败）刷新列表，进度事件不触发，避免历史页列表/分页反复闪加载
  useEffect(() => {
    return window.api.dispatch.onEvent((ev: { jobId?: string; status?: string; stage?: string; message?: string }) => {
      if (ev.status === 'success' || ev.status === 'failed') reloadJobs()
      // 运行期间捕获任务 id（dispatch.generate 结束才返回，这里从进度事件里拿）
      if (ev.status === 'running' && ev.jobId && !activeJobIdRef.current) {
        activeJobIdRef.current = ev.jobId
      }
      // 只处理当前任务的事件，避免历史任务事件误伤
      if (activeJobIdRef.current && ev.jobId && ev.jobId !== activeJobIdRef.current) return
      if (ev.status === 'pending') {
        setGenStage('pending')
        setGenProgress(null)
      } else if (ev.status === 'running' && ev.stage) {
        setGenStage(ev.stage)
        // API 分支（智谱 onProgress）带具体过程文案时记录，状态区直接展示
        if (ev.message) setGenProgress(ev.message)
      } else if (ev.status === 'failed') {
        setGenError(ev.message || '生成失败')
        setGenFailed(true)
        setGenStage(null)
        setGenProgress(null)
      } else if (ev.status === 'success') {
        setGenFailed(false)
        setGenStage(null)
        setGenProgress(null)
      }
    })
  }, [reloadJobs])

  // reconciliation：启动时恢复崩溃残留 + 追记未入账额度
  useEffect(() => {
    const run = async () => {
      try {
        const auth = getAuthService()
        const session = await auth?.getSession()
        const cfg = getSupabaseConfig()
        if (!auth || !session || !user || !cfg) return
        await window.api.dispatch.reconcile({
          supabaseUrl: cfg.url,
          supabaseAnonKey: cfg.anonKey,
          accessToken: session.access_token,
          refreshToken: session.refresh_token,
          userId: user.id
        })
      } catch {
        // 静默失败，reconciliation 不影响正常使用
      }
    }
    run()
  }, [])

  // 解析最近生成视频的可播放地址（本地路径 → http://127.0.0.1 服务）
  useEffect(() => {
    let cancelled = false
    const map: Record<string, string> = {}
    const tasks: Promise<void>[] = []
    for (const item of jobItems) {
      const r = item.record
      const sourcePath = r.cleanLocalPath || r.localPath || r.resultUrl
      if (!sourcePath) continue
      if (/^https?:/i.test(sourcePath)) {
        map[item.id] = sourcePath
      } else {
        const name = sourcePath.replace(/\\/g, '/').split('/').pop() || ''
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
    if (!preview && !imagePreview && !promptPreview && !refVideoPreviewing) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setPreview(null)
        setImagePreview(null)
        setPromptPreview(false)
        setRefVideoPreviewing(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [preview, imagePreview, promptPreview, refVideoPreviewing])

  const handleGenerate = useCallback(async (): Promise<void> => {
    const currentMode = provider === 'dola' ? 'multi_ref' : mode
    if (generating) return
    // 开放平台 API 型厂商（智谱/火山）：图生/多参考/首尾帧需公网 https 图片，上传未完成时禁用，避免提交空图报错
    if ((provider === 'zhipu' || provider === 'volcengine') && uploadingCount > 0) {
      setGenError('图片正在上传中，请稍候再生成')
      return
    }
    // 文生视频音频参考上传中：避免空参提交（透传 input.audio_url 需要其公网 URL 就绪）
    if (audioUploading) {
      setGenError('音频正在上传中，请稍候再生成')
      return
    }
    // 参考生（r2v）参考视频上传中：避免空参提交（透传 input.media 需要公网 URL 就绪）
    if (refVideoUploading) {
      setGenError('参考视频正在上传中，请稍候再生成')
      return
    }
    if (fresh && step === 1) {
      onGoProviders()
      return
    }
    if (!prompt.trim()) {
      setGenError('请先填写 Prompt 描述')
      return
    }
    // Admin 配置该厂商 models 为空（被屏蔽）时，无可生成模型
    if (modelList(provider).length === 0) {
      setGenError('该厂商暂无可生成模型')
      return
    }
    const validModes = visibleModeOptions(provider, model, features, caps).map((m) => m.value)
    // TokenHub 数字人（yt-video-humanactor）：当前不可用（配音音频需公网可达托管源），生成前友好拦截
    if (provider === 'tokenhub' && model === 'yt-video-humanactor') {
      setGenError('yt-video-humanactor（数字人）暂不可用：其配音音频需公网可达的托管源，正在适配中')
      return
    }
    // TokenHub 特效模型（yt-video-fx）：当前暂不可用（特效模板调用参数待实测适配），生成前友好拦截
    if (provider === 'tokenhub' && model === 'yt-video-fx') {
      setGenError('yt-video-fx（特效视频）暂不可用：其特效模板调用参数待适配，正在适配中')
      return
    }
    if (!validModes.includes(currentMode)) {
      setGenError('当前生成模式已被管理员关闭，请选择可用的生成模式')
      return
    }
    const imageCount = savedImagePaths.length + imageFiles.length
    // TokenHub 数字人（yt-video-humanactor）为纯音频驱动，不需图片，单独放行并校验音频
    const isTkhHumanactor = provider === 'tokenhub' && model === 'yt-video-humanactor'
    if (isTkhHumanactor) {
      if (!audioUrl) {
        setGenError('数字人口播需要上传 1 段配音音频')
        return
      }
    } else {
      // 文生视频需图片：排除 t2v（网页厂商）与 text2video（智谱 API）两种文案枚举；参考生（r2v）允许视频替代图片故一并放行
      if (currentMode !== 't2v' && currentMode !== 'text2video' && imageCount === 0 && !(r2vVideoActive && refVideoLocalPaths.length > 0)) {
        const modeLabel = visibleModeOptions(provider, model, features, caps).find((m) => m.value === currentMode)?.label ?? '多参考'
        setGenError(`${modeLabel}需要至少上传一张素材图片`)
        return
      }
      if ((currentMode === 'img' || currentMode === 'img2video') && imageCount === 0) {
        setGenError('图生视频需要先上传图片')
        return
      }
    }
    if (!durations.some((d) => d.value === duration)) {
      setGenError('当前厂商不支持该时长')
      return
    }
    if (providerOptions.length === 0) {
      setGenError('尚未绑定厂商账号，请先到厂商页绑定后再生成')
      onGoProviders()
      return
    }
    setGenError(null)
    setGenFailed(false)
    setGenStage(null)
    setGenProgress(null)
    activeJobIdRef.current = null // 上一轮残留的任务 id 会过滤掉本轮进度事件，必须重置
    submittedRef.current = false
    cancellingRef.current = false
    setGenerating(true)
    try {
      const auth = getAuthService()
      const cfg = getSupabaseConfig()
      if (!auth || !user || !cfg) {
        setGenError('登录态异常，请重新登录')
        return
      }
      // 生成前确保会话新鲜：token 即将过期则先续期，避免主进程查询被 401 拦截
      const guard = await ensureFreshSession()
      if (!guard.ok) {
        setGenError('登录已过期，请重新登录')
        return
      }
      const session = await auth.getSession()
      if (!session) {
        setGenError('登录态异常，请重新登录')
        return
      }
      const res = await window.api.dispatch.generate({
        supabaseUrl: cfg.url,
        supabaseAnonKey: cfg.anonKey,
        accessToken: session.access_token,
        refreshToken: session.refresh_token,
        userId: user.id,
        teamId: usageScope === 'team' ? team?.id ?? null : null,
        prompt: prompt.trim(),
        providerId: provider,
        model,
        durationSec: duration,
        mode: currentMode === 't2v' ? 'text2video' : currentMode === 'img' ? 'img2video' : currentMode,
        resolution,
        audio,
        ratio,
        images: (currentMode === 'text2video' || currentMode === 't2v') && provider !== 'yuanbao'
          ? []
          : [...savedImagePaths, ...imageFiles.map((f) => window.api.files.getPath(f)).filter(Boolean)].slice(0, maxImageUploadCount(provider, model)),
        // 厂商 API 用图片仅取公网 https URL（API 型厂商图生参考图）；WebView 厂商不传，主进程回退 images
        imageUrls: apiImageUrls.filter((u): u is string => typeof u === 'string' && /^https?:\/\//i.test(u)),
        // 音频参考：公网 https URL 透传厂商（bailian→input.audio_url；tokenhub humanactor→提交 body AudioUrl）+ 本地副本供历史回显/重新生成回填。
        // 仅当当前模型能力卡明确暴露 Audio（bailian）或数字人模型（tokenhub）时才随生成下发，避免残留音频状态误发到不支持（或字段未确认）的模型。
        audioUrl: t2vSupportsAudio || tkhHumanactorSupportsAudio ? (audioUrl ?? undefined) : undefined,
        audioLocalPath: t2vSupportsAudio || tkhHumanactorSupportsAudio ? (audioLocalPath ?? undefined) : undefined,
        // 特效模板（yt-video-fx）：仅当前为 TokenHub FX 模型时透传，避免残留状态误发到其它模型
        template: isTkhFx ? (tkhFxTemplate.trim() || undefined) : undefined,
        // 参考生（r2v）参考视频：videos=本地副本路径（历史回显/回填），videoUrls=公网 https URL（透传厂商 input.media reference_video）。
        videos: r2vVideoActive ? refVideoLocalPaths.filter(Boolean) : undefined,
        videoUrls: r2vVideoActive
          ? refVideoUrls.filter((u): u is string => typeof u === 'string' && /^https?:\/\//i.test(u))
          : undefined,
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
      setCancelling(false)
      cancellingRef.current = false
      submittedRef.current = false
    }
  }, [generating, fresh, step, prompt, mode, provider, model, features, caps, providerCaps, duration, durations, resolution, audio, ratio, imageFiles, savedImagePaths, apiImageUrls, uploadingCount, audioUploading, audioUrl, audioLocalPath, t2vSupportsAudio, r2vVideoActive, refVideoLocalPaths, refVideoUrls, refVideoUploading, isTkhFx, tkhFxTemplate, user, team, usageScope, onGenerate, reloadJobs, onGoProviders, providerOptions])

  /** 终止生成：发送前有效；点击后按钮锁定「正在终止…」直到任务真正结束，防止连点 */
  const handleCancel = useCallback(async (): Promise<void> => {
    if (cancelling || cancellingRef.current) return
    if (submittedRef.current) {
      setGenError('提示词已发送，无法终止')
      return
    }
    cancellingRef.current = true
    setCancelling(true)
    try {
      // 事件未捕获到 jobId 时也按「当前唯一活跃任务」取消；准备窗口由主进程待取消标志兜底
      const res = await window.api.dispatch.cancel(activeJobIdRef.current ?? undefined)
      if (res.ok) {
        // 取消已受理：保持「正在终止…」直到本任务结束（handleGenerate finally 复位）
        return
      }
      if (res.submitted) {
        submittedRef.current = true
        setGenError(res.reason || '提示词已发送，无法终止')
      } else if (res.reason && res.reason !== '任务不存在或已结束') {
        setGenError(res.reason)
      }
      setCancelling(false)
      cancellingRef.current = false
    } catch (e) {
      setGenError(e instanceof Error ? e.message : String(e))
      setCancelling(false)
      cancellingRef.current = false
    }
  }, [cancelling])

  const onProviderChange = (value: string): void => {
    setProvider(value)
    const nextModel = modelList(value)[0] ?? MODELS.doubao[0]
    setModel(nextModel)
    const nextModes = visibleModeOptions(value, nextModel, features, providerCaps[value])
    setMode(nextModes[0]?.value ?? 'text2video')
    clearAllRefAssets()
  }

  const onModeChange = (value: string): void => {
    setMode(value)
    // 文生视频（text2video）模式清空图片：图片上传区已隐藏，残留图片需一并清掉
    if (value === 'text2video' || value === 't2v') {
      setImages([])
      setImageFiles([])
      setSavedImagePaths([])
      setRefItemOrder((prev) => prev.filter((e) => e.k !== 'img'))
    }
    // 非参考生（multi_ref）模式清空参考视频，避免切走后残留视频参考串场
    if (value !== 'multi_ref') clearRefVideos()
    // 切走参考生时同时清空整个素材顺序，避免遗留跨模式的旧顺序条目
    if (value !== 'multi_ref' && r2vVideoActive) setRefItemOrder([])
  }

  const onModelChange = (value: string): void => {
    // TokenHub 数字人（yt-video-humanactor）当前不可用：列表可见，选中仅给友好提示，不实际切换
    if (provider === 'tokenhub' && value === 'yt-video-humanactor') {
      setGenError('yt-video-humanactor（数字人）暂不可用：其配音音频需公网可达的托管源，正在适配中')
      return
    }
    // TokenHub 特效模型（yt-video-fx）当前不可用：列表可见，选中仅给友好提示，不实际切换
    if (provider === 'tokenhub' && value === 'yt-video-fx') {
      setGenError('yt-video-fx（特效视频）暂不可用：其特效模板调用参数待适配，正在适配中')
      return
    }
    setModel(value)
    const nextModes = visibleModeOptions(provider, value, features, caps)
    if (!nextModes.some((m) => m.value === mode)) {
      setMode(nextModes[0]?.value ?? 'text2video')
      clearAllRefAssets()
    }
  }

  const onPickFiles = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

  // 开放平台 API 型厂商（智谱 / 火山方舟）的图生/多参考/首尾帧图片必须为公网 https URL：
  // 先立即显示本地预览（blob URL），再逐个后台处理，同时得到
  //  - 公网 https URL（apiImageUrls）：只传给厂商 API 用于生成；
  //  - 本地绝对路径（savedImagePaths）：随任务入库，历史模块离线回显（不依赖外网）。
  const appendApiImages = useCallback(
    async (files: File[]) => {
      const base = savedImagePaths.length
      // 预览立刻出现，不等网络上传
      setImages((prev) => [...prev, ...files.map((f) => URL.createObjectURL(f))])
      // 预占储存格保证 savedImagePaths/apiImageUrls 与 images 序号对齐；处理完成后回填
      setSavedImagePaths((prev) => [...prev, ...files.map(() => '')])
      setApiImageUrls((prev) => [...prev, ...files.map(() => '')])
      setUpLoadingCount((c) => c + files.length)
      for (let i = 0; i < files.length; i++) {
        const idx = base + i
        try {
          // 大图优先在渲染层压缩（远小于 GitHub/jsDelivr 单文件上限），小图不重复解码
          const { bytes, ext, reencoded } = await prepareReferenceImage(files[i])
          const { url } = await window.api.storage.uploadImage({ bytes, contentType: imageContentType(ext), ext })
          const diskPath = window.api.files.getPath(files[i])
          // 压缩过的存压缩字节副本；未压缩且带磁盘路径用原路径（不重复落盘），否则 blob 写本地副本兜底
          const localPath =
            !reencoded && diskPath
              ? diskPath
              : (await window.api.storage.saveImageLocal({ bytes, ext })).path
          setSavedImagePaths((prev) => prev.map((p, j) => (j === idx ? localPath : p)))
          setApiImageUrls((prev) => prev.map((p, j) => (j === idx ? url : p)))
        } catch (e) {
          setGenError('图片上传失败：' + (e instanceof Error ? e.message : String(e)))
        } finally {
          setUpLoadingCount((c) => Math.max(0, c - 1))
        }
      }
    },
    [savedImagePaths]
  )

  const onFilesSelected = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    const remaining = Math.max(0, maxImageUploadCount(provider, model) - savedImagePaths.length)
    const picked = files.slice(0, remaining)
    if (API_IMAGE_PROVIDERS.includes(provider)) {
      void appendApiImages(picked)
      e.target.value = ''
      return
    }
    const urls = picked.map((f) => URL.createObjectURL(f))
    setImages((prev) => [...prev, ...urls])
    setImageFiles((prev) => [...prev, ...picked])
    e.target.value = ''
  }, [provider, model, savedImagePaths, appendApiImages])

  const onPasteImages = useCallback((e: ReactClipboardEvent<HTMLDivElement>) => {
    const files = Array.from(e.clipboardData.files ?? []).filter((f) => f.type.startsWith('image/'))
    if (files.length === 0) return
    e.preventDefault()
    const remaining = Math.max(0, maxImageUploadCount(provider, model) - savedImagePaths.length)
    const picked = files.slice(0, remaining)
    if (API_IMAGE_PROVIDERS.includes(provider)) {
      void appendApiImages(picked)
      return
    }
    const urls = picked.map((f) => URL.createObjectURL(f))
    setImages((prev) => [...prev, ...urls])
    setImageFiles((prev) => [...prev, ...picked])
  }, [provider, model, savedImagePaths, appendApiImages])

  const onRemoveImage = useCallback((idx: number) => {
    setImages((prev) => prev.filter((_, i) => i !== idx))
    setSavedImagePaths((prev) => prev.filter((_, i) => i !== idx))
    setApiImageUrls((prev) => prev.filter((_, i) => i !== idx))
    setImageFiles((prev) => {
      if (idx < savedImagePaths.length) return prev
      return prev.filter((_, i) => i !== idx - savedImagePaths.length)
    })
  }, [savedImagePaths])

  // ===== 参考生（r2v）统一素材框：图片 + 视频 混合上传、一行预览（依赖 appendApiImages 声明在此之后）=====

  // 单张图片 → 追加到图片数组并登记为 img 条目
  //   关键：refItemOrder 条目必须在 savedImagePaths 占位符推入的**同一帧**登记，
  //   否则 loading 判断 savedImagePaths[i]==='' 会因上传已完成而为 false
  const appendImageAsRef = useCallback(async (file: File): Promise<void> => {
    const beforeCount = savedImagePaths.length
    if (!API_IMAGE_PROVIDERS.includes(provider)) {
      // 非 API 厂商：直接走本地预览路径
      const url = URL.createObjectURL(file)
      setImages((prev) => [...prev, url])
      setImageFiles((prev) => [...prev, file])
      setRefItemOrder((prev) => [...prev, { k: 'img', i: images.length }])
      return
    }
    // API 厂商（如 bailian）：appendApiImages 的前三 setState（images/savedImagePaths/apiImageUrls）
    //   在**首次 await 之前同步执行**，所以这里紧接其后同步登记 refItemOrder 条目即可拿到占位符帧
    void appendApiImages([file])
    setRefItemOrder((prev) => {
      if (prev.some((e) => e.k === 'img' && e.i === beforeCount)) return prev
      return [...prev, { k: 'img', i: beforeCount }]
    })
  }, [provider, savedImagePaths.length, images.length, appendApiImages])

  // 统一 pick 入口：按 MIME 分类分发到图片/视频上传
  const onPickRefMixed = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    e.target.value = ''
    let remaining = Math.max(0, MAX_REF_VIDEOS + maxImageUploadCount(provider, model) - totalRefItemCount)
    const picked = files.slice(0, remaining)
    for (const f of picked) {
      if (remaining <= 0) break
      if (f.type.startsWith('video/')) {
        await appendVideoAsRef(f)
        remaining = Math.max(0, MAX_REF_VIDEOS + maxImageUploadCount(provider, model) - totalRefItemCount)
      } else if (f.type.startsWith('image/')) {
        await appendImageAsRef(f)
        remaining = Math.max(0, MAX_REF_VIDEOS + maxImageUploadCount(provider, model) - totalRefItemCount)
      }
    }
  }, [provider, model, totalRefItemCount, appendVideoAsRef, appendImageAsRef])

  // 统一 paste 入口
  const onPasteRefMixed = useCallback((e: React.ClipboardEvent<HTMLDivElement>) => {
    const files = Array.from(e.clipboardData.files ?? [])
    if (files.length === 0) return
    e.preventDefault()
    void (async () => {
      let remaining = Math.max(0, MAX_REF_VIDEOS + maxImageUploadCount(provider, model) - totalRefItemCount)
      for (const f of files) {
        if (remaining <= 0) break
        if (f.type.startsWith('video/')) {
          await appendVideoAsRef(f)
        } else if (f.type.startsWith('image/')) {
          await appendImageAsRef(f)
        } else {
          continue
        }
        remaining = Math.max(0, MAX_REF_VIDEOS + maxImageUploadCount(provider, model) - totalRefItemCount)
      }
    })()
  }, [provider, model, totalRefItemCount, appendVideoAsRef, appendImageAsRef])

  // 统一 drop 入口
  const handleRefMixedDrop = useCallback(async (e: React.DragEvent<HTMLDivElement>) => {
    const files = Array.from(e.dataTransfer.files ?? [])
    if (files.length === 0) return
    let remaining = Math.max(0, MAX_REF_VIDEOS + maxImageUploadCount(provider, model) - totalRefItemCount)
    for (const f of files) {
      if (remaining <= 0) break
      if (f.type.startsWith('video/')) {
        await appendVideoAsRef(f)
      } else if (f.type.startsWith('image/')) {
        await appendImageAsRef(f)
      } else {
        continue
      }
      remaining = Math.max(0, MAX_REF_VIDEOS + maxImageUploadCount(provider, model) - totalRefItemCount)
    }
  }, [provider, model, totalRefItemCount, appendVideoAsRef, appendImageAsRef])

  // 从统一素材框按顺序删除一个条目（自动维护同类条目下标）
  const onRemoveRefMixed = useCallback((orderIdx: number): void => {
    setRefItemOrder((prev) => {
      const entry = prev[orderIdx]
      if (!entry) return prev
      if (entry.k === 'img') {
        const i = entry.i
        setImages((p) => p.filter((_, j) => j !== i))
        setImageFiles((p) => p.filter((_, j) => j !== i))
        setSavedImagePaths((p) => p.filter((_, j) => j !== i))
        setApiImageUrls((p) => p.filter((_, j) => j !== i))
      } else {
        const i = entry.i
        setRefVideoPreviews((p) => p.filter((_, j) => j !== i))
        setRefVideoLocalPaths((p) => p.filter((_, j) => j !== i))
        setRefVideoUrls((p) => p.filter((_, j) => j !== i))
        setRefVideoNames((p) => p.filter((_, j) => j !== i))
      }
      // 从顺序数组里删除该条目，并把同类后续条目下标 -1
      return prev
        .filter((_, idx) => idx !== orderIdx)
        .map((e) => {
          if (e.k === entry.k && e.i > entry.i) return { ...e, i: e.i - 1 }
          return e
        })
    })
  }, [])

  return (
    <div className={'dashboard-wrap' + (banner ? ' has-banner' : '')}>
      <div className="page-header">
        <div className="title-group">
          <div>
            <h1>调度台</h1>
            <div className="divider" />
          </div>
          <p>聚合 7 家厂商免费额度 · 一键生成</p>
        </div>
      </div>

      <div className="dispatch-grid">
        {/* 生成面板 */}
        <div className="generate-panel">
          <div className="panel-header">
            <h2>生成视频</h2>
            <span className="panel-meta">自选厂商 · 一键生成</span>
          </div>

          <div className="input-group">
            <label htmlFor="prompt" style={{ margin: 0 }}>Prompt 描述</label>
            <div
              style={{ position: 'relative' }}
              onMouseEnter={() => setPromptInputHovered(true)}
              onMouseLeave={() => setPromptInputHovered(false)}
            >
              <textarea
                id="prompt"
                placeholder="描述你想生成的视频内容，例如：一只橘猫在阳光下打盹，微风轻拂窗帘..."
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                style={{ minHeight: 84, maxHeight: 180, overflowY: 'auto', paddingRight: 34 }}
              />
              <button
                type="button"
                title="放大编辑"
                aria-label="放大编辑"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setPromptPreview(true)}
                style={{
                  position: 'absolute',
                  right: 8,
                  bottom: 8,
                  width: 28,
                  height: 28,
                  padding: 0,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  border: 'none',
                  outline: 'none',
                  boxShadow: 'none',
                  borderRadius: 6,
                  background: 'transparent',
                  color: 'var(--fg-muted)',
                  cursor: 'pointer',
                  opacity: promptInputHovered ? 1 : 0,
                  pointerEvents: promptInputHovered ? 'auto' : 'none',
                  transition: 'opacity .15s ease'
                }}
              >
                <IconMaximize size={14} />
              </button>
            </div>
          </div>

          {provider === 'zhipu' && (
            <p
              className="field-hint"
              style={{
                margin: '6px 0 0',
                fontSize: 12,
                color: '#22c55e',
                lineHeight: 1.5
              }}
            >
              智谱建议使用英文描述分镜 / 镜头运动 / 风格 / 光线，效果更佳
            </p>
          )}

          <div className="cascade-row">
            <div className="param-field">
              <label htmlFor="provider">选择厂商</label>
              <Select
                id="provider"
                value={providerOptions.length === 0 ? '' : provider}
                onChange={onProviderChange}
                options={providerOptions.length > 0 ? providerOptions : [{ value: '', label: '未绑定厂商' }]}
              />
            </div>
            <div className="param-field">
              <label htmlFor="model">选择模型</label>
              <Select
                id="model"
                value={model}
                onChange={onModelChange}
                options={modelList(provider).map((m) => ({ value: m, label: m }))}
              />
            </div>
          </div>

          <div className="param-row">
            <div className="param-field">
              <label htmlFor="mode">生成模式</label>
              <Select
                id="mode"
                value={mode}
                onChange={onModeChange}
                options={modeOptions}
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
            {provider !== 'dola' && (
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
            )}
            {isTkhFx && (
              <div className="param-field param-field-template">
                <label htmlFor="fx-template">特效模板</label>
                <input
                  id="fx-template"
                  type="text"
                  value={tkhFxTemplate}
                  placeholder="控制台创建的模板标识"
                  onChange={(e) => setTkhFxTemplate(e.target.value)}
                />
              </div>
            )}
          </div>

          <div className="param-row ratio-row">
            {!(provider === 'dola' || (provider === 'qwenwan' && /HappyHorse/i.test(model))) && (
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
            )}
            <div className="param-field">
              <label htmlFor="ratio">视频比例</label>
              <Select
                id="ratio"
                value={ratio}
                onChange={setRatio}
                options={ratios}
              />
            </div>
            {viewScope === 'global' && team ? (
              <div className="param-field">
                <label htmlFor="usage-scope">生成额度</label>
                <Select
                  id="usage-scope"
                  value={usageScope}
                  onChange={(v) => onUsageScopeChange(v as UsageScope)}
                  options={[
                    { value: 'personal', label: '个人额度' },
                    { value: 'team', label: '团队额度' }
                  ]}
                />
              </div>
            ) : null}
            {!(viewScope === 'global' && team) ? (
              <div className="param-field">
                <span className="field-hint">配音 / 比例不影响额度</span>
              </div>
            ) : null}
          </div>

          {/* 文生视频音频参考（百炼独立音频参考场景）：仅此场景用独立音频上传框；
          TokenHub 数字人（yt-video-humanactor）的音频已并入下方统一素材框渲染 */}
          {t2vSupportsAudio && (
            <div className={'audio-upload' + (audioName ? ' has-audio' : '')}>
              {audioUploading ? (
                // 上传中占位：立即显示文件名 + loading 动效，避免用户看到空白无反馈
                <div className="audio-player audio-loading">
                  <div className="audio-play-btn" style={{ background: 'var(--border)', cursor: 'wait' }}>
                    <span className="thumb-loading-spinner" />
                  </div>
                  <div className="audio-info">
                    <span className="audio-name" title={audioName || ''}>{audioName || '上传中...'}</span>
                    <div className="audio-progress">
                      <div className="audio-progress-bar" style={{ width: '30%', animation: 'audio-loading 1.4s ease-in-out infinite' }} />
                    </div>
                    <span className="audio-time">上传中</span>
                  </div>
                </div>
              ) : audioName && audioUrl ? (
                <>
                  {/* 隐藏原生 audio 元素，用自定义深色 UI 控制播放，避免白底控件破坏暗色主题 */}
                  <audio ref={audioRef} src={audioUrl} preload="metadata" style={{ display: 'none' }} />
                  <div className="audio-player" onClick={(e) => e.stopPropagation()}>
                    <button
                      className={'audio-play-btn' + (audioPlaying ? ' playing' : '')}
                      onClick={toggleAudioPlay}
                      title={audioPlaying ? '暂停' : '播放'}
                    >
                      {audioPlaying ? (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                          <rect x="6" y="4" width="4" height="16" rx="1" />
                          <rect x="14" y="4" width="4" height="16" rx="1" />
                        </svg>
                      ) : (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                          <path d="M8 5v14l11-7z" />
                        </svg>
                      )}
                    </button>
                    <div className="audio-info">
                      <span className="audio-name" title={audioName}>{audioName}</span>
                      <div className="audio-progress" onClick={seekAudio}>
                        <div
                          className="audio-progress-bar"
                          style={{ width: `${audioDuration > 0 ? (audioCurrentTime / audioDuration) * 100 : 0}%` }}
                        />
                      </div>
                      <span className="audio-time">
                        {fmtTime(audioCurrentTime)} / {fmtTime(audioDuration)}
                      </span>
                    </div>
                    <button className="audio-remove-btn" onClick={onRemoveAudio} title="移除音频">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  </div>
                </>
              ) : (
                <label className="upload-zone audio-zone">
                  <IconUpload size={14} />
                  <span className="upload-text">仅支持上传音频作为参考</span>
                  {audioUploading && <span className="thumb-loading-spinner" />}
                  <input
                    type="file"
                    accept="audio/*"
                    style={{ display: 'none' }}
                    onChange={onPickAudio}
                  />
                </label>
              )}
            </div>
          )}

          {/* 参考生（r2v）且模型含 Video 能力：合并图片/视频上传为**一个**统一素材框，预览一行按添加顺序排列。
          其余场景继续沿用默认图片上传框 */}
          {r2vVideoActive ? (
            <div
              className={'upload-zone ref-mixed-zone' + (totalRefItemCount > 0 ? ' has-images' : '')}
              onClick={() => refMixedInputRef.current?.click()}
              onPaste={onPasteRefMixed}
              onDragOver={(e) => { e.preventDefault() }}
              onDrop={(e) => { e.preventDefault(); void handleRefMixedDrop(e) }}
            >
              {totalRefItemCount > 0 ? (
                <div className="thumb-strip">
                  {refItemOrder.map((entry, orderIdx) => {
                    if (entry.k === 'img') {
                      const src = images[entry.i]
                      const uploading = entry.i < savedImagePaths.length && savedImagePaths[entry.i] === ''
                      return (
                        <div
                          className="thumb-item"
                          key={'img-' + orderIdx}
                          title="点击预览图片"
                          style={{ cursor: 'pointer' }}
                          onClick={(e) => { e.stopPropagation(); if (src) setImagePreview(src) }}
                        >
                          <img src={src} alt="" />
                          {uploading && (
                            <div className="thumb-loading" title="图片上传中…">
                              <span className="thumb-loading-spinner" />
                            </div>
                          )}
                          <button className="remove-thumb" onClick={(e) => { e.stopPropagation(); onRemoveRefMixed(orderIdx) }}>×</button>
                        </div>
                      )
                    }
                    // video
                    const vIdx = entry.i
                    const vSrc = refVideoPreviews[vIdx]
                    const vUploading = refVideoUploading && refVideoLocalPaths[vIdx] === ''
                    return (
                      <div
                        className="thumb-item ref-video-item"
                        key={'vid-' + orderIdx}
                        title="点击预览视频"
                        style={{ cursor: 'pointer' }}
                        onClick={(e) => { e.stopPropagation(); if (vSrc) setRefVideoPreviewing(vSrc) }}
                      >
                        <video src={vSrc} muted preload="metadata" />
                        {vUploading && (
                          <div className="thumb-loading" title="视频上传中…">
                            <span className="thumb-loading-spinner" />
                          </div>
                        )}
                        <span className="thumb-play-mask"><IconPlay size={18} /></span>
                        <button className="remove-thumb" onClick={(e) => { e.stopPropagation(); onRemoveRefMixed(orderIdx) }}>×</button>
                      </div>
                    )
                  })}
                  {totalRefItemCount < MAX_REF_VIDEOS + maxImageUploadCount(provider, model) && (
                    <div className="thumb-add">+</div>
                  )}
                </div>
              ) : (
                <>
                  <IconUpload size={16} />
                  <span className="upload-text">拖拽图片 / 视频到此处（多参考生成，最多 {MAX_REF_VIDEOS + maxImageUploadCount(provider, model)} 个）</span>
                </>
              )}
              <input
                ref={refMixedInputRef}
                type="file"
                accept="image/*,video/*"
                multiple
                style={{ display: 'none' }}
                onChange={onPickRefMixed}
              />
            </div>
          ) : tkhHumanactorSupportsAudio ? (
            // TokenHub 数字人（yt-video-humanactor）：官方文档为纯音频驱动，无需图片，仅提供配音音频上传框
            <div className={'upload-zone humanactor-zone' + (audioName ? ' has-images' : '')}>
              {audioUploading ? (
                <div className="audio-loading">
                  <span className="audio-loading-spinner" /> 音频上传中…
                </div>
              ) : audioName && audioUrl ? (
                <>
                  <audio ref={audioRef} src={audioUrl} preload="metadata" style={{ display: 'none' }} />
                  <div
                    className={'audio-player' + (audioPlaying ? ' playing' : '')}
                    onClick={(e) => { e.stopPropagation(); toggleAudioPlay() }}
                  >
                    <button className="audio-play-btn">
                      {audioPlaying ? (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                          <rect x="6" y="4" width="4" height="16" rx="1" />
                          <rect x="14" y="4" width="4" height="16" rx="1" />
                        </svg>
                      ) : (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                          <path d="M8 5v14l11-7z" />
                        </svg>
                      )}
                    </button>
                    <div className="audio-player-main">
                      <div className="audio-player-progress" onClick={(e) => { e.stopPropagation(); seekAudio(e) }}>
                        <div
                          className="audio-player-bar"
                          style={{ width: `${audioDuration > 0 ? (audioCurrentTime / audioDuration) * 100 : 0}%` }}
                        />
                      </div>
                      <div className="audio-player-name" title={audioName}>{audioName}</div>
                    </div>
                    <button className="audio-remove" onClick={(e) => { e.stopPropagation(); onRemoveAudio() }}>×</button>
                  </div>
                </>
              ) : (
                <label title="上传配音音频" className="upload-empty">
                  <IconUpload size={20} />
                  <span className="upload-text">配音音频（数字人口播）</span>
                  <input
                    type="file"
                    accept="audio/*"
                    style={{ display: 'none' }}
                    onChange={onPickAudio}
                  />
                </label>
              )}
            </div>
          ) : mode !== 'text2video' && !t2vSupportsAudio && (
            <div
              className={'upload-zone' + (images.length > 0 ? ' has-images' : '')}
              onClick={onPickFiles}
              onPaste={onPasteImages}
            >
              {images.length > 0 ? (
                <div className="thumb-strip">
                  {images.map((src, idx) => (
                    <div
                      className="thumb-item"
                      key={idx}
                      title="点击预览图片"
                      style={{ cursor: 'pointer' }}
                      onClick={(e) => {
                        e.stopPropagation()
                        setImagePreview(src)
                      }}
                    >
                      <img src={src} alt="" />
                      {idx < savedImagePaths.length && savedImagePaths[idx] === '' && (
                        <div className="thumb-loading" title="图片上传中…">
                          <span className="thumb-loading-spinner" />
                        </div>
                      )}
                      <button className="remove-thumb" onClick={(e) => { e.stopPropagation(); onRemoveImage(idx) }}>×</button>
                    </div>
                  ))}
                  {images.length < maxImageUploadCount(provider, model) && (
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
          )}

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
                <span>{genStage === 'progress' && genProgress ? genProgress : genStage ? STAGE_LABEL[genStage] ?? genStage : '正在准备…'}</span>
              </div>
            )}
            <button
              className="btn-primary"
              disabled={(generating && cancelling) || ((provider === 'zhipu' || provider === 'volcengine') && uploadingCount > 0) || audioUploading || refVideoUploading}
              onClick={() => {
                if (generating) void handleCancel()
                else void handleGenerate()
              }}
            >
              <IconPlay size={14} />
              {generating
                ? cancelling
                  ? '正在终止…'
                  : submittedRef.current || (genStage && SUBMITTED_STAGES.has(genStage))
                    ? '生成中…'
                    : '停止生成'
                : genFailed
                  ? '重新生成'
                  : '开始生成'}
            </button>
            <div className="cost-estimate">
              <IconInfo size={12} />
              {providerOptions.length === 0 ? '绑定账号后可查看预计额度消耗' : (
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
              {visibleAggs.some((a) => a.enabledCount > 0)
                ? visibleAggs.reduce((s, a) => s + a.enabledCount, 0) + ' 个可用账号'
                : '未绑定'}
            </span>
          </div>
          {visibleAggs.length === 0 ? (
            <EmptyState
              className="ps-empty"
              title="没有可用厂商"
              description="请先到后台管理系统启用厂商"
              action={
                <button className="btn-sm primary" onClick={onGoProviders}>
                  去绑定账号 →
                </button>
              }
            />
          ) : visibleAggs.every((a) => a.boundCount === 0) ? (
            <>
              <div className="provider-status-list">
                {visibleAggs.map((p) => {
                  return (
                    <div className="ps-item unbound" key={p.providerId}>
                      <div className="ps-icon">
                        <ProviderIconMark providerId={p.providerId} logo={p.logo} size={20} />
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
                description="绑定账号后即可自动获取免费额度，在调度台选择厂商生成"
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
                {visibleAggs.map((p) => {
                  const enabledBindings = p.bindings.filter((b) => b.enabled)
                  const isVolc = p.providerId === 'volcengine'
                  const isBailian = p.providerId === 'bailian'
                  // 智谱等 API 型厂商：汇总取平台真实资源包余额（而非静态默认额度），生成后自动刷新
                  const quotaOf = (keyId: string) =>
                    zhipuQuotaOverrides[keyId] && zhipuQuotaOverrides[keyId].available
                      ? zhipuQuotaOverrides[keyId]
                      : undefined
                  // 火山方舟：汇总取账号真实 token 汇总（免费模型 freeQuota 之和），避免显示账本假额度 50/50
                  const volcQuotaOf = (keyId: string) => {
                    const v = volcTokenOverrides[keyId]
                    return v && v.total > 0 ? v : undefined
                  }
                  // 阿里云百炼：汇总取账号级免费额度聚合（会话捕获快照）
                  const bailianQuotaOf = (keyId: string) =>
                    bailianQuotaOverrides[keyId] && bailianQuotaOverrides[keyId].available
                      ? bailianQuotaOverrides[keyId]
                      : undefined
                  const isApiQuota = p.providerId === 'zhipu'
                  const volcKnown = enabledBindings.some((b) => volcQuotaOf(b.keyId))
                  const used = enabledBindings.reduce((s, b) => s + b.used, 0)
                  const remaining = enabledBindings.reduce(
                    (s, b) =>
                      s +
                      (isApiQuota
                        ? quotaOf(b.keyId)?.remaining ?? 0
                        : isVolc
                          ? volcQuotaOf(b.keyId)?.remaining ?? 0
                          : isBailian
                            ? bailianQuotaOf(b.keyId)?.remaining ?? 0
                            : b.remaining),
                    0
                  )
                  const total = enabledBindings.reduce(
                    (s, b) =>
                      s +
                      (isApiQuota
                        ? quotaOf(b.keyId)?.total ?? 0
                        : isVolc
                          ? volcQuotaOf(b.keyId)?.total ?? 0
                          : isBailian
                            ? bailianQuotaOf(b.keyId)?.total ?? 0
                            : b.dailyTotal),
                    0
                  )
                  const fill = total > 0 ? Math.round((remaining / total) * 100) : 0
                  // 火山免费 token 数值较大，以 k tokens 为单位展示
                  const isKTokens = isVolc && total >= 1000
                  const fmtK = (n: number) => Math.round(n / 1000).toLocaleString()
                  const quotaText = isKTokens
                    ? `${fmtK(remaining)}k / ${fmtK(total)}k tokens`
                    : `${remaining.toLocaleString()} / ${total.toLocaleString()} ${p.unitName}`
                  return (
                    <div className="ps-item" key={p.providerId}>
                      <div className="ps-icon">
                        <ProviderIconMark providerId={p.providerId} logo={p.logo} size={20} />
                      </div>
                      <div className="ps-info">
                        <div className="ps-name">{p.name}</div>
                        <div className="ps-quota">{isVolc && !volcKnown ? '—' : quotaText}</div>
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
              {jobItems.slice(0, 10).map((j) => {
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

      {/* 提示词放大编辑浮层 */}
      {promptPreview &&
        createPortal(
          <div
            className="modal-overlay"
            style={{ zIndex: 400 }}
            onClick={(e) => { if (e.target === e.currentTarget) setPromptPreview(false) }}
          >
            <div
              className="modal-card"
              style={{ width: 'min(94vw, 960px)', maxHeight: '88vh', display: 'flex', flexDirection: 'column', padding: 20 }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <div style={{ fontSize: 15, fontWeight: 600 }}>提示词编辑</div>
                <button className="btn-sm primary" onClick={() => setPromptPreview(false)}>完成</button>
              </div>
              <textarea
                autoFocus
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                style={{
                  width: '100%',
                  flex: 1,
                  minHeight: 220,
                  padding: '12px 14px',
                  border: '1px solid var(--border)',
                  outline: 'none',
                  boxShadow: 'none',
                  borderRadius: 8,
                  background: 'var(--bg-elevated)',
                  color: 'var(--fg-primary)',
                  fontFamily: 'var(--font-body)',
                  fontSize: '1em',
                  lineHeight: 1.8,
                  overflowY: 'auto',
                  resize: 'none'
                }}
                placeholder="描述你想生成的视频内容，例如：一只橘猫在阳光下打盹，微风轻拂窗帘..."
              />
            </div>
          </div>,
          document.body
        )}

      {/* 音频裁剪弹窗：超长参考音频让用户自行拖选起止区间 */}
      {cropAudio && (
        <AudioCropModal
          file={cropAudio.file}
          duration={cropAudio.duration}
          onCancel={handleCropCancel}
          onConfirm={async (bytes) => { await handleCropDone(bytes, 0, 0) }}
        />
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

      {/* 参考视频预览浮层 */}
      {refVideoPreviewing && (
        <div
          className="video-preview-overlay"
          onClick={() => setRefVideoPreviewing(null)}
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
          <div style={{ position: 'relative' }} onClick={(e) => e.stopPropagation()}>
            <video
              src={refVideoPreviewing}
              controls
              autoPlay
              style={{ maxWidth: 'min(92vw, 860px)', maxHeight: '82vh', display: 'block', borderRadius: 10 }}
            />
            <button
              onClick={() => setRefVideoPreviewing(null)}
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

      {/* 上传图片预览浮层 */}
      {imagePreview && (
        <div
          className="video-preview-overlay"
          onClick={() => setImagePreview(null)}
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
          <div style={{ position: 'relative' }} onClick={(e) => e.stopPropagation()}>
            <img
              src={imagePreview}
              alt=""
              style={{ maxWidth: 'min(92vw, 860px)', maxHeight: '82vh', display: 'block', borderRadius: 10, objectFit: 'contain' }}
            />
            <button
              onClick={() => setImagePreview(null)}
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
