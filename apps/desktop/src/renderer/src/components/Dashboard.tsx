import { useEffect, useState, useRef, useCallback, useMemo } from 'react'
import type { ClipboardEvent as ReactClipboardEvent } from 'react'
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
  zhipuModelDurations
} from '../spec'
import { IconInfo, IconMaximize, IconPlay, IconUpload, ProviderIconMark } from './icons'
import { EmptyState } from './EmptyState'
import Select from './Select'
import type { JobItem } from '../hooks/useJobs'
import { useAuth } from '../hooks/useAuth'
import type { ProvidersResult } from '../hooks/useProviders'
import type { JobsResult } from '../hooks/useJobs'
import type { UsageScope, ViewScope } from '@quota-flow/db-supabase'
import { getAuthService, getSupabaseConfig } from '../auth/service'
import { ensureFreshSession } from '../auth/session'
import { VideoThumb } from './VideoThumb'
import { getInitialShowWebview } from './Modals'
import type { DesktopFeatureFlags } from '../hooks/useDesktopPermissions'
import { uploadReferenceImage } from '../utils/uploadImage'

const VIP = false

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
}

function normalizeRegenerateMode(providerId: string, rawMode?: string): string {
  if (rawMode === 'text2video' || rawMode === 't2v') return 't2v'
  if (rawMode === 'img2video' || rawMode === 'img') return 'img'
  if (rawMode === 'multi_ref' || rawMode === 'first_last' || rawMode === 'first_frame') return rawMode
  if (providerId === 'yuanbao' || providerId === 'dola' || providerId === 'qwenwan') return 'multi_ref'
  return 't2v'
}

function visibleModeOptions(
  provider: string,
  model: string,
  features: DesktopFeatureFlags
): Array<{ value: string; label: string }> {
  return providerModeOptions(provider, model).filter((option) => {
    if (option.value === 't2v') return features['dispatch.text2video']
    if (option.value === 'img') return features['dispatch.img2video']
    if (option.value === 'multi_ref') return features['dispatch.multi_ref']
    if (option.value === 'first_last') return features['dispatch.first_last']
    if (option.value === 'first_frame') return features['dispatch.first_frame']
    return true
  })
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
  regenerateDraft,
  materialImages,
  onMaterialImagesConsumed,
  onRegenerateConsumed
}: DashboardProps) {
  const { aggs: provAggs, zhipuQuotaOverrides } = providers
  const { user, team } = useAuth()
  const { items: jobItems, reload: reloadJobs } = jobs
  const [provider, setProvider] = useState('doubao')
  const [model, setModel] = useState(MODELS.doubao[0])
  const [mode, setMode] = useState('t2v')
  const [duration, setDuration] = useState(5)
  const [resolution, setResolution] = useState('720')
  const [audio, setAudio] = useState('on')
  const [ratio, setRatio] = useState('9:16')
  const [images, setImages] = useState<string[]>([])
  const [imageFiles, setImageFiles] = useState<File[]>([])
  const [savedImagePaths, setSavedImagePaths] = useState<string[]>([])
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

  // 历史详情「重新生成」：把历史参数回填到调度台表单，图片走已保存副本路径
  useEffect(() => {
    if (!regenerateDraft) return
    const nextProvider = regenerateDraft.providerId
    const nextModel = MODELS[nextProvider]?.includes(regenerateDraft.model)
      ? regenerateDraft.model
      : MODELS[nextProvider]?.[0] ?? MODELS.doubao[0]
    const normalizedMode = normalizeRegenerateMode(nextProvider, regenerateDraft.mode)
    const nextModes = visibleModeOptions(nextProvider, nextModel, features)
    const nextMode = nextModes.some((m) => m.value === normalizedMode)
      ? normalizedMode
      : (nextModes[0]?.value ?? 't2v')

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
    setImages([])
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
    onRegenerateConsumed?.()
    return () => {
      cancelled = true
    }
  }, [regenerateDraft, features, onRegenerateConsumed])

  // 素材库「用作参考」：把图片追加为图像参考，并切到当前厂商可用的图生/多参考模式
  useEffect(() => {
    if (!materialImages || materialImages.length === 0) return
    setSavedImagePaths((prev) => [...prev, ...materialImages.map((m) => m.path)])
    setImages((prev) => [...prev, ...materialImages.map((m) => m.url)])
    const validModes = visibleModeOptions(provider, model, features)
    const imageMode = validModes.find((m) => ['multi_ref', 'img', 'first_last', 'first_frame'].includes(m.value))
    if (imageMode && imageMode.value !== mode) setMode(imageMode.value)
    onMaterialImagesConsumed?.()
  }, [materialImages, provider, model, features, mode, onMaterialImagesConsumed])

  const activeBoundAggs = useMemo(
    () => provAggs.filter((a) => a.enabled && a.boundCount > 0),
    [provAggs]
  )
  const providerDurations = useMemo(() => {
    return new Map(provAggs.map((a) => [a.providerId, a.durations]))
  }, [provAggs])
  const selectedDurations = useMemo(() => {
    // 智谱固定生成时长为模型级能力（cogvideox-3 5/10s、Vidu Q1 5s、Vidu 2 4s 等），
    // 与主进程 api-branch 的模型时长校验保持一致，避免 UI 可选但与生成校验冲突。
    if (provider === 'zhipu') return zhipuModelDurations(model)
    return providerDurations.get(provider) ?? DEFAULT_SUPPORTED_DURATIONS
  }, [provider, model, providerDurations])
  const durations = durationOptions(provider, model, mode, VIP, selectedDurations)
  const modeOptions = useMemo(
    () => visibleModeOptions(provider, model, features),
    [provider, model, features]
  )
  const resolutions = resolutionOptions(provider)
  const ratios = ratioOptions(provider)
  const cost = computeCost(provider, model, duration, resolution)
  const upload = uploadHint(provider, mode)

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
      setProvider(next)
      setModel(MODELS[next]?.[0] ?? MODELS.doubao[0])
      const nextModes = visibleModeOptions(next, MODELS[next]?.[0] ?? MODELS.doubao[0], features)
      setMode(nextModes[0]?.value ?? 't2v')
      setImages([])
      setImageFiles([])
      setSavedImagePaths([])
    }
  }, [providerOptions, provider, features])

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
    const validModes = visibleModeOptions(provider, model, features).map((m) => m.value)
    if (!validModes.includes(mode)) {
      setMode(validModes[0] ?? 't2v')
      setImages([])
      setImageFiles([])
      setSavedImagePaths([])
    }
  }, [provider, model, mode, features])

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
    if (!preview && !imagePreview && !promptPreview) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setPreview(null)
        setImagePreview(null)
        setPromptPreview(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [preview, imagePreview, promptPreview])

  const handleGenerate = useCallback(async (): Promise<void> => {
    const currentMode = provider === 'dola' ? 'multi_ref' : mode
    if (generating) return
    if (fresh && step === 1) {
      onGoProviders()
      return
    }
    if (!prompt.trim()) {
      setGenError('请先填写 Prompt 描述')
      return
    }
    const validModes = visibleModeOptions(provider, model, features).map((m) => m.value)
    if (!validModes.includes(currentMode)) {
      setGenError('当前生成模式已被管理员关闭，请选择可用的生成模式')
      return
    }
    const imageCount = savedImagePaths.length + imageFiles.length
    // 文生视频需图片：排除 t2v（网页厂商）与 text2video（智谱 API）两种文案枚举
    if (currentMode !== 't2v' && currentMode !== 'text2video' && imageCount === 0) {
      const modeLabel = visibleModeOptions(provider, model, features).find((m) => m.value === currentMode)?.label ?? '多参考'
      setGenError(`${modeLabel}需要至少上传一张素材图片`)
      return
    }
    if (currentMode === 'img' && imageCount === 0) {
      setGenError('图生视频需要先上传图片')
      return
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
        images: currentMode === 't2v' && provider !== 'yuanbao'
          ? []
          : [...savedImagePaths, ...imageFiles.map((f) => window.api.files.getPath(f)).filter(Boolean)].slice(0, maxImageUploadCount(provider, model)),
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
  }, [generating, fresh, step, prompt, mode, provider, model, features, duration, durations, resolution, audio, ratio, imageFiles, savedImagePaths, user, team, usageScope, onGenerate, reloadJobs, onGoProviders, providerOptions])

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
    const nextModel = MODELS[value]?.[0] ?? MODELS.doubao[0]
    setModel(nextModel)
    const nextModes = visibleModeOptions(value, nextModel, features)
    setMode(nextModes[0]?.value ?? 't2v')
    setImages([])
    setImageFiles([])
    setSavedImagePaths([])
  }

  const onModeChange = (value: string): void => {
    setMode(value)
    if (value === 't2v' && provider !== 'yuanbao') {
      setImages([])
      setImageFiles([])
      setSavedImagePaths([])
    }
  }

  const onModelChange = (value: string): void => {
    setModel(value)
    const nextModes = visibleModeOptions(provider, value, features)
    if (!nextModes.some((m) => m.value === mode)) {
      setMode(nextModes[0]?.value ?? 't2v')
      setImages([])
      setImageFiles([])
      setSavedImagePaths([])
    }
  }

  const onPickFiles = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

  // 智谱走开放平台 API，图生/多参考/首尾帧的图片必须为公网 https URL：
  // 先立即显示本地预览（blob URL），再逐个后台上传到 qf-images 桶取公开 URL（回填 savedImagePaths 同序号格子）。
  const appendZhipuImages = useCallback(
    async (files: File[]) => {
      const base = savedImagePaths.length
      // 预览立刻出现，不等网络上传
      setImages((prev) => [...prev, ...files.map((f) => URL.createObjectURL(f))])
      // 预占储存格保证 savedImagePaths 与 images 序号对齐；上传完成后回填 https URL
      setSavedImagePaths((prev) => [...prev, ...files.map(() => '')])
      for (let i = 0; i < files.length; i++) {
        try {
          const url = await uploadReferenceImage(files[i])
          setSavedImagePaths((prev) => prev.map((p, idx) => (idx === base + i ? url : p)))
        } catch (e) {
          setGenError('图片上传失败：' + (e instanceof Error ? e.message : String(e)))
        }
      }
    },
    [savedImagePaths]
  )

  const onFilesSelected = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    const remaining = Math.max(0, maxImageUploadCount(provider, model) - savedImagePaths.length)
    const picked = files.slice(0, remaining)
    if (provider === 'zhipu') {
      void appendZhipuImages(picked)
      e.target.value = ''
      return
    }
    const urls = picked.map((f) => URL.createObjectURL(f))
    setImages((prev) => [...prev, ...urls])
    setImageFiles((prev) => [...prev, ...picked])
    e.target.value = ''
  }, [provider, model, savedImagePaths, appendZhipuImages])

  const onPasteImages = useCallback((e: ReactClipboardEvent<HTMLDivElement>) => {
    const files = Array.from(e.clipboardData.files ?? []).filter((f) => f.type.startsWith('image/'))
    if (files.length === 0) return
    e.preventDefault()
    const remaining = Math.max(0, maxImageUploadCount(provider, model) - savedImagePaths.length)
    const picked = files.slice(0, remaining)
    if (provider === 'zhipu') {
      void appendZhipuImages(picked)
      return
    }
    const urls = picked.map((f) => URL.createObjectURL(f))
    setImages((prev) => [...prev, ...urls])
    setImageFiles((prev) => [...prev, ...picked])
  }, [provider, model, savedImagePaths, appendZhipuImages])

  const onRemoveImage = useCallback((idx: number) => {
    setImages((prev) => prev.filter((_, i) => i !== idx))
    setSavedImagePaths((prev) => prev.filter((_, i) => i !== idx))
    setImageFiles((prev) => {
      if (idx < savedImagePaths.length) return prev
      return prev.filter((_, i) => i !== idx - savedImagePaths.length)
    })
  }, [savedImagePaths])

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
                options={(MODELS[provider] ?? MODELS.doubao).map((m) => ({ value: m, label: m }))}
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

          {(mode !== 't2v' || provider === 'yuanbao') && (
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
              disabled={generating && cancelling}
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
                  // 智谱等 API 型厂商：汇总取平台真实资源包余额（而非静态默认额度），生成后自动刷新
                  const quotaOf = (keyId: string) =>
                    zhipuQuotaOverrides[keyId] && zhipuQuotaOverrides[keyId].available
                      ? zhipuQuotaOverrides[keyId]
                      : undefined
                  const isApiQuota = p.providerId === 'zhipu'
                  const used = enabledBindings.reduce((s, b) => s + b.used, 0)
                  const remaining = enabledBindings.reduce(
                    (s, b) => s + (isApiQuota ? quotaOf(b.keyId)?.remaining ?? 0 : b.remaining),
                    0
                  )
                  const total = enabledBindings.reduce(
                    (s, b) => s + (isApiQuota ? quotaOf(b.keyId)?.total ?? 0 : b.dailyTotal),
                    0
                  )
                  const fill = total > 0 ? Math.round((remaining / total) * 100) : 0
                  return (
                    <div className="ps-item" key={p.providerId}>
                      <div className="ps-icon">
                        <ProviderIconMark providerId={p.providerId} logo={p.logo} size={20} />
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
