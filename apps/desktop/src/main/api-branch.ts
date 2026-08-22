// API 型厂商生成分支：面向「走开放平台 API（API Key）而非网页 cookie 自动化」的厂商。
//
// 与 webview 引擎（豆包/千问/元宝/Dola）不同，这类厂商：
//   - 凭证是 API Key（存在 provider_keys.encrypted_key 的加密 JSON 里），不是 cookies；
//   - 真实额度在平台资源包（api/biz），生成前可实时预检；
//   - 顶点能力有限，只支持文生/图生视频等。
//
// 设计为「注册表 + 通用执行入口」：未来接更多 API 厂商时，只需新增一个 branch 并注册，
// 调度主体（dispatch 里的 runApiBranch）代码不变。
//
// 当前注册：zhipu（智谱清影 cogvideox-flash/2/3）。

import type { GenerateInput } from './dispatch'
import { decodeZhipuPayload } from './providers'
import {
  decodeVolcenginePayload,
  decodeBailianPayload,
  isBailianVideoFreeModel,
  bailianModelCap,
  bailianGenerateWithKey,
  bailianVideoImageCount,
  fetchZhipuQuota,
  zhipuGenerateWithKey,
  volcengineFreeVideoModels,
  volcengineGenerateWithKey,
  volcengineGenBlocker,
  volcengineModelFreeStatus,
  volcGenTokenEstimate,
  VOLC_DECOMMISSIONED_MODELS,
  decodeTokenhubPayload,
  tokenhubFreeVideoModels,
  tokenhubGenerateWithKey
} from '@quota-flow/providers'
import type { VolcengineFreeVideoModel, ZhipuGenerateOptions, BailianGenerateOptions, BailianFreeTierSlim } from '@quota-flow/providers'
import { ipcMain, safeStorage } from 'electron'

/** 解密后的 API 厂商凭证（各厂商子集可不同；这里统一宽松字段） */
export interface ApiCredential {
  apiKey: string
  consoleJwt?: string | null
}

export interface ApiGenerateOutcome {
  ok: boolean
  videoUrl?: string
  coverImageUrl?: string
  traceId?: string
  error?: string
  /** 火山方舟提交失败时，若平台判定模型不可用（无接入点 / 已下架），透出供调度台落库标记 */
  unavailable?: 'decommissioned' | 'no_endpoint'
}

export interface ApiGenerateParams {
  mode: 'text2video' | 'img2video' | 'first_last' | 'multi_ref'
  model: string
  prompt: string
  /** 图片 https URL（单图或数组，按模型能力透传 image_url） */
  images?: string[]
  /** 参考生（r2v）视频 https URL 数组（bailian 等模型合入 input.media reference_video） */
  videos?: string[]
  /** 文生视频音频参考的 https URL（bailian 等模型透传 input.audio_url） */
  audioUrl?: string
  /** 特效模板（yt-video-fx）：控制台创建的特效模板标识，透传提交 body 的 Template 字段 */
  template?: string
  durationSec: number
  /** 生成过程实时回调（限流重试等），供调度台推送 UI 提示 */
  onProgress?: (message: string) => void
}

export interface ApiGenerationBranch {
  id: string
  displayName: string
  unitName: string
  /** 解密 encrypted_key → 生成凭证；失败返回 null */
  parseCredentials(decrypted: string): ApiCredential | null
  /** 单次成本：免费模型 0，付费按次 1 */
  cost(model: string): number
  /** 该模型支持时长；传入不在列表内则拒绝 */
  supportedDurations(model?: string): number[]
  /** 真实剩余额度（按次资源包）；无法查询返回 null */
  remaining?(creds: ApiCredential, model: string): Promise<number | null>
  /** 展示用模型目录（「查看模型」弹窗）；perModelFreeQuota 为每账号免费 token 额度叠加层（火山方舟） */
  catalog(
    perModelFreeQuota?: Record<string, { remaining?: number; total?: number }>,
    /** 火山方舟：该账号绑定时实时抓到的免费视频模型（优先于固定目录） */
    captured?: VolcengineFreeVideoModel[]
  ): ApiModelInfo[]
  /**
   * 多账号选号（可选）：在多个已启用账号中按厂商策略选出最优下标。
   * 返回下标则 dispatch 改用该账号对应的解密负载；返回 null 由调用方回退默认/首个。
   * dispatches 中的 plain 已是解密后的加密负载明文。
   */
  pick?(
    keys: Array<{ id: string; accountName: string | null; isDefault: boolean; enabled: boolean; plain: string }>,
    model: string
  ): number | null
  /**
   * 提交前预检（可选）：账号解密后、向 API 提交之前执行。
   * 返回 !ok 则在提交前拦截（模型未开通/额度用尽等）。
   */
  preflight?(model: string, plain: string, ctx?: { durationSec?: number }): { ok: boolean; reason?: string }
  generate(input: GenerateInput, creds: ApiCredential, params: ApiGenerateParams): Promise<ApiGenerateOutcome>
}

export interface ApiModelInfo {
  model: string
  /** 展示价格：免费模型「免费」，付费「¥x/次」 */
  priceLabel: string
  /** 0 = 免费，1+ = 付费按次 */
  cost: number
  /** 支持时长（秒） */
  durations: number[]
  /** 固定尺寸；null = 跟随调度台分辨率 */
  size: string | null
  /** 该模型支持生成模式 */
  modes: Array<{ value: string; label: string }>
  /** 是否已开通该模型（火山方舟未开通模型提示开通；默认 true） */
  activated?: boolean
  /** 每账号免费 token 额度（火山方舟免费视频模型）：剩余/总数，未抓到为 undefined */
  freeQuota?: { remaining?: number; total?: number }
  /** 模型不可用标记（火山方舟）：平台下架 / 账号无接入点 */
  unavailable?: 'decommissioned' | 'no_endpoint'
  /** 不可用原因的展示标签，仅当 unavailable 有值时存在 */
  unavailableLabel?: string
}

const ZHIPU_MODEL_COST: Record<string, number> = {
  'cogvideox-flash': 0,
  'cogvideox-2': 1,
  'cogvideox-3': 1,
  'Vidu Q1': 1,
  'Vidu 2': 1
}

/** 各智谱模型的固定生成时长；cogvideox-3 支持 5/10，Vidu Q1 固定 5，Vidu 2 固定 4 */
const ZHIPU_MODEL_DURATIONS: Record<string, number[]> = {
  'cogvideox-flash': [5],
  'cogvideox-2': [5],
  'cogvideox-3': [5, 10],
  'Vidu Q1': [5],
  'Vidu 2': [4]
}

/** 模型→视频尺寸；Vidu 固定输出，cogvideox 按调度台分辨率 */
const ZHIPU_MODEL_SIZE: Record<string, string | null> = {
  'Vidu Q1': '1920x1080',
  'Vidu 2': '1280x720',
  'cogvideox-flash': null,
  'cogvideox-2': null,
  'cogvideox-3': null
}

// 智谱统一模型 + 生成模式 → 实际 API 子模型（Vidu 的模型名与模式一一绑定）
const ZHIPU_API_MODEL: Record<string, Record<string, string>> = {
  'Vidu Q1': {
    text2video: 'viduq1-text',
    img2video: 'viduq1-image',
    first_last: 'viduq1-start-end'
  },
  'Vidu 2': {
    img2video: 'vidu2-image',
    first_last: 'vidu2-start-end',
    multi_ref: 'vidu2-reference'
  }
}

/** 由统一模型 + 生成模式推导实际 API 子模型；cogvideox 系列模型名即 API 名 */
function zhipuApiModel(model: string, mode: string): string {
  return ZHIPU_API_MODEL[model]?.[mode] ?? model
}

function zhipuSizeFromResolution(resolution?: string): string | undefined {
  if (resolution === '1080') return '1920x1080'
  if (resolution === '720') return '1280x720'
  // 4K：'3840x2160'；UI 暂不暴露 4K，保留扩展
  return undefined
}

/** 展示价格（2026-08 实测，来源 open.bigmodel.cn/pricing 与长期接入沉淀） */
const ZHIPU_MODEL_PRICE: Record<string, string> = {
  'cogvideox-flash': '免费',
  'cogvideox-2': '¥0.5/次',
  'cogvideox-3': '¥1/次',
  'Vidu Q1': '¥2.5/次',
  'Vidu 2': '¥1.25/次起'
}

/** 各模型支持的生成模式（值域与调度台/派发保持一致） */
const ZHIPU_MODEL_MODES: Record<string, Array<{ value: string; label: string }>> = {
  'cogvideox-flash': [
    { value: 'text2video', label: '文生视频' },
    { value: 'img2video', label: '图生视频' }
  ],
  'cogvideox-2': [
    { value: 'text2video', label: '文生视频' },
    { value: 'img2video', label: '图生视频' }
  ],
  'cogvideox-3': [
    { value: 'text2video', label: '文生视频' },
    { value: 'img2video', label: '图生视频' }
  ],
  'Vidu Q1': [
    { value: 'text2video', label: '文生视频' },
    { value: 'img2video', label: '图生视频' },
    { value: 'first_last', label: '首尾帧生成' }
  ],
  'Vidu 2': [
    { value: 'img2video', label: '图生视频' },
    { value: 'first_last', label: '首尾帧生成' },
    { value: 'multi_ref', label: '多参考生成' }
  ]
}

/** 模型目录固定顺序 */
const ZHIPU_CATALOG_ORDER = ['cogvideox-flash', 'cogvideox-2', 'cogvideox-3', 'Vidu Q1', 'Vidu 2']

export function makeZhipuBranch(): ApiGenerationBranch {
  return {
    id: 'zhipu',
    displayName: '智谱清影',
    unitName: '次',
    parseCredentials(decrypted) {
      try {
        const { apiKey, consoleJwt } = decodeZhipuPayload(decrypted)
        if (!apiKey) return null
        return { apiKey, consoleJwt: consoleJwt ?? null }
      } catch {
        return null
      }
    },
    cost(model) {
      return ZHIPU_MODEL_COST[model] ?? 1
    },
    supportedDurations(model = 'cogvideox-flash') {
      return ZHIPU_MODEL_DURATIONS[model] ?? [5]
    },
    async remaining(creds) {
      try {
        const res = await fetchZhipuQuota(creds.apiKey, creds.consoleJwt ?? undefined)
        if (!res.ok) return null
        return res.quota.available ? res.quota.remaining : 0
      } catch {
        return null
      }
    },
    catalog(_perModelFreeQuota?: Record<string, { remaining?: number; total?: number }>) {
      return ZHIPU_CATALOG_ORDER.map((model) => ({
        model,
        priceLabel: ZHIPU_MODEL_PRICE[model],
        cost: ZHIPU_MODEL_COST[model],
        durations: ZHIPU_MODEL_DURATIONS[model],
        size: ZHIPU_MODEL_SIZE[model],
        modes: ZHIPU_MODEL_MODES[model]
      }))
    },
    async generate(input, creds, params) {
      // 图生/首尾/参考生需公开图片 URL：本地路径无法用于 API，前端已上传 Supabase 取 https URL。
      // 单图传字符串，首尾帧(2)/参考生(多张)传数组。
      const imgs = (params.images ?? []).filter((u) => /^https?:\/\//i.test(u))
      // 图片数与成本由「生成模式」决定：图生1、首尾2、参考多张
      const needed = params.mode === 'multi_ref' ? -1 : params.mode === 'first_last' ? 2 : params.mode === 'img2video' ? 1 : 0
      if (needed > 0 && imgs.length < needed) {
        return { ok: false, error: needed === 2 ? '首尾帧生成需要上传首帧和尾帧共 2 张图片' : '图生视频需要至少上传 1 张首帧图片' }
      }
      if (params.mode === 'multi_ref' && imgs.length < 1) {
        return { ok: false, error: '参考生视频需要至少上传 1 张参考图' }
      }
      const imageUrl: string | string[] | undefined =
        params.mode === 'text2video' ? undefined
        : params.mode === 'first_last' ? imgs.slice(0, 2)
        : params.mode === 'multi_ref' ? imgs
        : imgs[0]
      const apiModel = zhipuApiModel(params.model, params.mode)
      const opts: ZhipuGenerateOptions = {
        mode: params.mode,
        model: apiModel,
        prompt: params.prompt,
        imageUrl
      }
      // 附加参数：尺寸（Vidu 固定 / cogvideox 按分辨率）、时长、配音
      const fixedSize = ZHIPU_MODEL_SIZE[params.model]
      const extra = opts.extra ?? {}
      if (fixedSize) extra['size'] = fixedSize
      else {
        const size = zhipuSizeFromResolution(input.resolution)
        if (size) extra['size'] = size
      }
      // 时长：cogvideox 按调度台；Vidu 固定（取前端已选值即可）
      const defaultDur = ZHIPU_MODEL_DURATIONS[params.model]?.[0] ?? 5
      extra['duration'] = params.durationSec || defaultDur
      // 配音：前端有 audio='on'/'off'，映射智谱 with_audio
      if (input.audio === 'on') extra['with_audio'] = true
      else if (input.audio === 'off') extra['with_audio'] = false
      // Vidu 固定运动幅度
      if (params.model === 'Vidu Q1' || params.model === 'Vidu 2') extra['movement_amplitude'] = 'auto'
      opts.extra = extra
      // 提示词内附带视频参数描述，便于模型产出符合预期的时长/尺寸/配音
      const paramNotes: string[] = []
      if (extra['size']) paramNotes.push(`画面尺寸 ${extra['size']}`)
      paramNotes.push(`视频时长 ${extra['duration']} 秒`)
      if (typeof extra['with_audio'] === 'boolean') paramNotes.push(extra['with_audio'] ? '带配音' : '无配音')
      if (paramNotes.length && params.prompt) opts.prompt = `${params.prompt}（视频参数：${paramNotes.join('、')}）`
      const r = await zhipuGenerateWithKey(creds.apiKey, opts, params.onProgress)
      return {
        ok: r.ok,
        videoUrl: r.videoUrl,
        coverImageUrl: r.coverImageUrl,
        traceId: r.traceId,
        error: r.error
      }
    }
  }
}

/**
 * 阿里云百炼视频生成模型目录（静态兜底表；优先用账号捕获 realtime freeTiers 过滤出的未过期视频模型）。
 * 成本/时长/模式依据官方与实测（见 docs/厂商与API平台接入/阿里云百炼视频生成接入方案.md §3）：
 *   wan2.7-t2v-2026-06-12   文生，免费（实测 50 次）
 *   wan2.7-i2v-2026-04-25   首帧图生 / 首尾帧，付费按量（无免费）
 *   wan2.7-r2v-2026-06-12   参考生，免费（实测 50 次）
 */
const BAILIAN_VIDEO_MODELS: Array<{
  model: string
  type: 't2v' | 'i2v' | 'r2v'
  free: boolean
  durations: number[]
  priceLabel: string
  cost: number
  modes: Array<{ value: string; label: string }>
}> = [
  {
    model: 'wan2.7-t2v-2026-06-12',
    type: 't2v',
    free: true,
    durations: [5, 10],
    priceLabel: '免费',
    cost: 0,
    modes: [{ value: 'text2video', label: '文生视频' }]
  },
  {
    model: 'wan2.7-i2v-2026-04-25',
    type: 'i2v',
    free: false,
    durations: [5, 10],
    priceLabel: '按量付费',
    cost: 1,
    modes: [
      { value: 'img2video', label: '图生视频(首帧)' },
      { value: 'first_last', label: '首尾帧生成' }
    ]
  },
  {
    model: 'wan2.7-r2v-2026-06-12',
    type: 'r2v',
    free: true,
    durations: [5, 10],
    priceLabel: '免费',
    cost: 0,
    modes: [{ value: 'multi_ref', label: '参考生视频' }]
  }
]

function makeBailianBranch(): ApiGenerationBranch {
  return {
    id: 'bailian',
    displayName: '阿里云百炼',
    unitName: '次',
    parseCredentials(decrypted) {
      try {
        const { apiKey } = decodeBailianPayload(decrypted)
        return apiKey ? { apiKey } : null
      } catch {
        return null
      }
    },
    cost(model) {
      return BAILIAN_VIDEO_MODELS.find((m) => m.model === model)?.cost ?? 1
    },
    supportedDurations(model = 'wan2.7-t2v-2026-06-12') {
      // 时长档位以 bailianModelCap 的能力卡为准（含 r2v 参考生支持 5/10s），与「查看模型」目录口径一致
      return bailianModelCap(model).durations
    },
    async remaining() {
      // 真实按次免费额度随账号 payload freeTiers 快照展示；此处返回 null 表示未知（不做公开 API 实时查询）。
      return null
    },
    preflight() {
      // t2v/r2v 免费额度用尽由服务端 403 FreeTierOnly 兜底，不做客户端暴力拦截；
      // i2v 无免费为按量付费，dispatch 无「继续」确认入口，故用 catalog 的「按量付费」标签提示，不硬拦（避免生成死路）。
      return { ok: true }
    },
    catalog(_perModelFreeQuota, captured?) {
      // captured 传 freeTiers（payload 捕获快照）时按「未过期的视频生成模型」优先展示（口径与「查看模型」一致）
      if (Array.isArray(captured) && captured.length > 0) {
        const tiers = captured as unknown as BailianFreeTierSlim[]
        const live = tiers.filter((t) => isBailianVideoFreeModel(t.model) && !t.expired)
        if (live.length > 0) {
          return live.map((t) => {
            // 能力按官方命名归纳（文生/图生/参考/关键帧/检测/专用），免费额度项本身免费
            const cap = bailianModelCap(t.model)
            return {
              model: t.model,
              priceLabel: '免费',
              cost: 0,
              durations: cap.durations,
              size: null,
              modes: cap.modes,
              activated: true,
              freeQuota: { remaining: t.remaining, total: t.total }
            }
          })
        }
      }
      // 回退内置静态目录
      return BAILIAN_VIDEO_MODELS.map((m) => ({
        model: m.model,
        priceLabel: m.priceLabel,
        cost: m.cost,
        durations: m.durations,
        size: null,
        modes: m.modes,
        activated: true
      }))
    },
    async generate(input, creds, params) {
      const imgs = (params.images ?? []).filter((u) => /^https?:\/\//i.test(u))
      const vids = (params.videos ?? []).filter((u) => /^https?:\/\//i.test(u))
      const needed = bailianVideoImageCount(params.mode)
      // 参考生（multi_ref）：实测当前 r2v 快照 image.media[] 仅收图片格式、不收 mp4，
      // 故需至少 1 张图片；不再允许仅上传视频（视频入口已从前端移除）。
      const needOk =
        params.mode === 'multi_ref'
          ? imgs.length >= 1
          : needed > 0
            ? imgs.length >= needed
            : true
      if (!needOk) {
        return {
          ok: false,
          error:
            needed === 2
              ? '首尾帧生成需要上传首帧和尾帧共 2 张图片'
              : params.mode === 'multi_ref'
                ? '参考生视频需要至少上传 1 张参考图或参考视频'
                : '图生视频需要至少上传 1 张首帧图片'
        }
      }
      // 视频参数追加进 prompt（时长/尺寸/画幅/配音），对齐智谱 generate 既有做法
      const paramNotes: string[] = []
      const size =
        input.resolution === '1080' ? '1920x1080' : input.resolution === '720' ? '1280x720' : undefined
      if (size) paramNotes.push(`画面尺寸 ${size}`)
      if (input.ratio) paramNotes.push(`画幅 ${input.ratio}`)
      paramNotes.push(`视频时长 ${params.durationSec} 秒`)
      paramNotes.push(input.audio === 'off' ? '无配音' : '带配音')
      let prompt = params.prompt
      if (paramNotes.length && params.prompt) prompt = `${params.prompt}（视频参数：${paramNotes.join('、')}）`

      const opts: BailianGenerateOptions = {
        mode: params.mode,
        model: params.model,
        prompt,
        images: imgs,
        videos: vids,
        durationSec: params.durationSec,
        resolution: input.resolution,
        ratio: input.ratio,
        audio: input.audio === 'off' ? 'off' : 'on',
        promptAudioUrl: params.audioUrl
      }
      const r = await bailianGenerateWithKey(creds.apiKey, opts, params.onProgress)
      return {
        ok: r.ok,
        videoUrl: r.videoUrl,
        coverImageUrl: r.coverImageUrl,
        traceId: r.traceId,
        error: r.error ?? (r.freeTierExhausted ? '该模型免费额度已用完，请核对账号免费额度后重试' : undefined)
      }
    }
  }
}

/** 火山方舟免费视频模型默认时长（未收录固定时长走通用档） */
const VOLC_ENGINE_MODEL_DURATIONS = [5, 10]
/** 火山免费视频模型统一支持文生 + 图生（Seedance 均有免费推理额度） */
const VOLC_ENGINE_MODEL_MODES: Array<{ value: string; label: string }> = [
  { value: 'text2video', label: '文生视频' },
  { value: 'img2video', label: '图生视频' }
]

function makeVolcengineBranch(): ApiGenerationBranch {
  const freeModels = volcengineFreeVideoModels()
  return {
    id: 'volcengine',
    displayName: '火山方舟',
    unitName: '次',
    parseCredentials(decrypted) {
      try {
        const { apiKey, consoleJwt } = decodeVolcenginePayload(decrypted)
        if (!apiKey) return null
        return { apiKey, consoleJwt: consoleJwt ?? null }
      } catch {
        return null
      }
    },
    cost() {
      // 本轮火山方舟接入的均为免费视频模型，cost=0
      return 0
    },
    supportedDurations() {
      return VOLC_ENGINE_MODEL_DURATIONS
    },
    async remaining() {
      // 免费 token 额度按账号、且无公开 API 可读；实时额度走本地账本，此处返回 null 表示未知。
      return null
    },
    pick(keys, model) {
      // 多账号优选：能力分主导（能否开通 + 剩余额度），is_default 仅作同分时的二次兜底，
      // 确保「默认账号未开通、其它账号已开通」时仍自动选用能生成的账号。
      // known=false（未知）的候选不因未知加分也不拦截；真正的拦截交给 preflight 依据明确证据处理。
      try {
        let bestIdx: number | null = null
        let bestScore = -Infinity
        keys.forEach((k, idx) => {
          const st = volcengineModelFreeStatus(k.plain, model)
          // 能力分：未开通扣分、已开通与有剩余各加分；未知按 0，不因未知误伤
          let cap = 0
          if (st.known) {
            if (st.activated === true) cap += 1
            if (st.activated === false) cap -= 2
            if (typeof st.remaining === 'number') cap += st.remaining > 0 ? 1 : 0
          }
          // 能力分占主导权（×10），默认只作为同能力下的平局用户名
          const score = cap * 10 + (k.isDefault ? 1 : 0)
          if (score > bestScore) {
            bestScore = score
            bestIdx = idx
          }
        })
        return bestIdx
      } catch {
        return null
      }
    },
    preflight(model, plain, ctx) {
      // 硬性防误扣拦截：未开通 / 额度不可确认 / 剩余不足以完成一次生成 一律拦截，绝不让火山补扣账号余额。
      // （火山无「免费额度不足即拒绝」的服务端开关，免费额度耗尽会强制转按量付费。）
      return volcengineGenBlocker(plain, model, volcGenTokenEstimate(ctx?.durationSec))
    },
    catalog(perModelFreeQuota, captured?: VolcengineFreeVideoModel[]) {
      // 优先使用该账号绑定时实时抓到的免费模型目录；未抓到则回退内置固定目录
      const base = Array.isArray(captured) && captured.length > 0 ? captured : freeModels
      // 内置目录按 id 的默认免费额度，作为兜底：账号负载里存的旧模型缺 freeQuota 时，仍能展示具体 token 量
      const defaultQuota = new Map(freeModels.map((m) => [m.id, m.freeQuota]))
      return base.map((m) => {
        const unavail = m.unavailable ?? (VOLC_DECOMMISSIONED_MODELS.includes(m.id) ? ('decommissioned' as const) : null)
        return {
          model: m.id,
          priceLabel: m.price,
          cost: 0,
          durations: VOLC_ENGINE_MODEL_DURATIONS,
          size: null,
          modes: VOLC_ENGINE_MODEL_MODES,
          activated: m.activated,
          freeQuota: perModelFreeQuota?.[m.id] ?? m.freeQuota ?? defaultQuota.get(m.id),
          unavailable: unavail ?? undefined,
          unavailableLabel: unavail === 'decommissioned' ? '已下架' : unavail === 'no_endpoint' ? '无接入点' : undefined
        }
      })
    },
    async generate(input, creds, params) {
      if (params.mode !== 'text2video' && params.mode !== 'img2video') {
        return { ok: false, error: '火山方舟当前仅支持文生视频 / 图生视频' }
      }
      const images = (params.images ?? []).filter((u) => /^https?:\/\//i.test(u))
      // 图生视频需公网图片 URL（已由调度台上传 Supabase 取 https 地址）
      const r = await volcengineGenerateWithKey(
        creds.apiKey,
        {
          mode: params.mode,
          model: params.model,
          prompt: params.prompt,
          images,
          durationSec: params.durationSec,
          audio: (input.audio === 'off' ? 'off' : 'on') as 'on' | 'off',
          ratio: input.ratio,
          resolution: input.resolution
        },
        params.onProgress
      )
      return {
        ok: r.ok,
        videoUrl: r.videoUrl,
        coverImageUrl: r.coverImageUrl,
        traceId: r.traceId,
        error: r.error,
        unavailable: r.unavailable
      }
    }
  }
}

let apiIpcRegistered = false

/**
 * 腾讯云 TokenHub 视频生成目录（静态兜底表）。四个免费视频模型积分费率/计费方式已实测官方（产品计费 1823/130055）。
 * 时长档官方 OpenAI 兼容示例未给出（见计划 §4.3），先按项目默认档 [5] 作为 TEMP 兜底，待真实提交实测后修正。
 */
const TOKENHUB_MODELS = tokenhubFreeVideoModels()
/** 各模型生成模式（图生均为「首帧」引导；FX 需「特效模板」参数，现调度台无模板选择器，暂不开放生成入口） */
const TOKENHUB_MODEL_MODES: Record<string, Array<{ value: string; label: string }>> = {
  'hy-video-1.5': [
    { value: 'text2video', label: '文生视频' },
    { value: 'img2video', label: '图生视频(首帧)' }
  ],
  'yt-video-2.0': [{ value: 'img2video', label: '图生视频(首帧)' }],
  'yt-video-humanactor': [{ value: 'img2video', label: '图生视频(首帧)' }],
  // FX 依赖「特效模板」参数（Template），调度台通过特效模板输入透传
  'yt-video-fx': [{ value: 'img2video', label: '图生视频(首帧)' }]
}

function makeTokenhubBranch(): ApiGenerationBranch {
  return {
    id: 'tokenhub',
    displayName: '腾讯云TokenHub',
    unitName: '积分',
    parseCredentials(decrypted) {
      try {
        const { apiKey } = decodeTokenhubPayload(decrypted)
        return apiKey ? { apiKey } : null
      } catch {
        return null
      }
    },
    cost() {
      // 本轮接入的均为免费视频模型，cost=0；本地账本不对 tokenhub 做原子扣减（Uin 级共享积分）
      return 0
    },
    supportedDurations(model = 'hy-video-1.5') {
      // 时长档以模型元数据 durations 为准（未实测确认前为空 → 兜底 [5] TEMP，见计划 §3.1）
      const m = TOKENHUB_MODELS.find((x) => x.id === model)
      return m?.durations?.length ? m.durations : [5]
    },
    pick(keys, model) {
      // 多账号按「该模型剩下免费额度」择优：known 且有剩余 +1、known 且耗尽 -2、unknown 记 0 不误伤；
      // 同 Uin 多 key 共享额度，仍按剩余额度避免选到耗尽账号（对齐火山方舟 pick 能力分主导）。
      try {
        let bestIdx: number | null = null
        let bestScore = -Infinity
        keys.forEach((k, idx) => {
          const payload = decodeTokenhubPayload(k.plain)
          const m = Array.isArray(payload.models) ? payload.models.find((x) => x.id === model) : undefined
          const fq = m?.freeQuota
          let cap = 0
          if (fq && typeof fq.remaining === 'number') cap += fq.remaining > 0 ? 1 : -2
          const score = cap * 10 + (k.isDefault ? 1 : 0)
          if (score > bestScore) {
            bestScore = score
            bestIdx = idx
          }
        })
        return bestIdx
      } catch {
        return null
      }
    },
    preflight(model, plain) {
      // 硬性拦截：该模型免费额度已知且耗尽 / 已过期 → 提交前拦截；未知不退不拦（对齐百炼），耗尽由服务端拒绝并归类提示
      try {
        const payload = decodeTokenhubPayload(plain)
        const m = Array.isArray(payload.models) ? payload.models.find((x) => x.id === model) : undefined
        const fq = m?.freeQuota
        if (fq && typeof fq.remaining === 'number' && fq.remaining <= 0) {
          return { ok: false, reason: `${model} 免费额度已用完（剩余 ${fq.remaining}）` }
        }
        if (fq && fq.expired === true) {
          return { ok: false, reason: `${model} 免费额度已过期` }
        }
      } catch {}
      return { ok: true }
    },
    async remaining() {
      // Uin 级积分接口尚未实测（计划 §4.2），返回 null 表示「未知」，不做公开 API 实时查询
      return null
    },
    catalog(perModelFreeQuota) {
      // humanactor 不可用（配音音频托管源待适配）、fx 需特效模板透传，均保留在目录供调度台展示/实测
      const blocked: Record<string, string> = {}
      return TOKENHUB_MODELS.map((m) => {
        const label = blocked[m.id]
        return {
          model: m.id,
          priceLabel: m.price,
          cost: 0,
          durations: m.durations?.length ? m.durations : [5],
          size: null,
          modes: TOKENHUB_MODEL_MODES[m.id] ?? [],
          freeQuota: perModelFreeQuota?.[m.id],
          ...(label ? { unavailable: 'no_endpoint' as const, unavailableLabel: label } : {})
        }
      })
    },
    async generate(input, creds, params) {
      if (params.mode !== 'text2video' && params.mode !== 'img2video') {
        return { ok: false, error: '腾讯云TokenHub 当前仅支持文生视频 / 图生视频' }
      }
      const images = (params.images ?? []).filter((u) => /^https?:\/\//i.test(u))
      const model = params.model
      // 数字人口播（yt-video-humanactor）仅需配音音频（audioUrl 小写透传），不要求图片
      if (model === 'yt-video-humanactor') {
        if (!/^https?:\/\//i.test((params.audioUrl ?? '').trim())) {
          return { ok: false, error: '数字人口播视频需要上传 1 段配音音频' }
        }
      } else if (params.mode === 'img2video' && images.length < 1) {
        return { ok: false, error: '图生视频需要至少上传 1 张首帧图片' }
      }
      const r = await tokenhubGenerateWithKey(creds.apiKey, {
        mode: params.mode,
        model,
        prompt: params.prompt,
        images,
        durationSec: params.durationSec,
        // TokenHub 视频实测仅支持 720p（字符串 "720p"），UI 的 720/1080 均归一化到 "720p"
        resolution: '720p',
        // 数字人口播（yt-video-humanactor）需配音音频：公网 URL 透传给提交 body 的小写 audioUrl
        audioUrl: params.audioUrl ?? undefined,
        // 特效模板（yt-video-fx）：透传给提交 body 的 Template 字段
        template: params.template ?? undefined,
        onProgress: params.onProgress
      })
      return {
        ok: r.ok,
        videoUrl: r.videoUrl,
        coverImageUrl: r.coverImageUrl,
        traceId: r.traceId,
        error: r.error,
        unavailable: r.unavailable
      }
    }
  }
}

/** 已注册的 API 生成分支（key = providerId） */
export const API_BRANCHES: Record<string, ApiGenerationBranch> = {
  zhipu: makeZhipuBranch(),
  volcengine: makeVolcengineBranch(),
  bailian: makeBailianBranch(),
  tokenhub: makeTokenhubBranch()
}

/** 注册 API 型厂商相关 IPC：provider:api-models（「查看模型」弹窗目录） */
export function registerApiIpc(): void {
  if (apiIpcRegistered) return
  apiIpcRegistered = true

  ipcMain.handle('provider:api-models', async (_e, providerId: string, encrypted?: string) => {
    // 阿里云百炼：展示该账号捕获的免费额度模型明细（freeTiers，来自绑定时的控制台会话捕获快照）
    if (providerId === 'bailian') {
      if (!encrypted) return { ok: true, models: [] }
      try {
        const plain = safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
        const { freeTiers } = decodeBailianPayload(plain)
        const models: ApiModelInfo[] = (freeTiers ?? [])
          .filter((t) => isBailianVideoFreeModel(t.model) && !t.expired)
          .map((t) => {
            // 按模型名归纳实际能力（文生/图生/参考/关键帧/检测/专用），替换旧的「统一文生视频」口径
            const cap = bailianModelCap(t.model)
            return {
              model: t.model,
              priceLabel: '免费',
              cost: 0,
              durations: cap.durations,
              size: null,
              // direct 模型给出可选择模式；检测/专用模型 modes 为空，仅展示能力名（弹窗用 note 呈现）
              modes: cap.modes,
              activated: true,
              ...(cap.direct
                ? { freeQuota: { remaining: t.remaining, total: t.total } }
                : {}),
              ...(cap.direct ? {} : { unavailableLabel: cap.label, unavailable: 'no_endpoint' as const })
            }
          })
        return { ok: true, models }
      } catch {
        return { ok: false, error: '解析百炼免费额度失败' }
      }
    }
    const branch = API_BRANCHES[providerId]
    if (!branch) return { ok: false, error: '不支持的 API 厂商' }
    // 火山方舟：解密该账号负载里的每模型免费 token 额度 + 实时抓到的模型目录，叠加到目录上展示
    let perModelFreeQuota: Record<string, { remaining?: number; total?: number }> | undefined
    let captured: VolcengineFreeVideoModel[] | undefined
    if (providerId === 'volcengine' && typeof encrypted === 'string' && encrypted) {
      try {
        const plain = safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
        const { models } = decodeVolcenginePayload(plain)
        captured = models
        if (Array.isArray(models)) {
          perModelFreeQuota = {}
          for (const m of models) {
            if (m?.id && m.freeQuota) perModelFreeQuota[m.id] = m.freeQuota
          }
        }
      } catch {}
    }
    // 腾讯云 TokenHub：优先读负载里绑定时捕获的每模型 freeQuota（DescribeModelEndpointList），
    // 旧负载无 models 时回退到 Uin 级共享 points，对每个免费模型叠加展示
    if (providerId === 'tokenhub' && typeof encrypted === 'string' && encrypted) {
      try {
        const plain = safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
        const payload = decodeTokenhubPayload(plain)
        if (Array.isArray(payload.models)) {
          const byId: Record<string, { remaining?: number; total?: number }> = {}
          for (const m of payload.models) {
            if (m?.id && m.freeQuota && typeof m.freeQuota.remaining === 'number') {
              byId[m.id] = { remaining: m.freeQuota.remaining, total: m.freeQuota.total }
            }
          }
          if (Object.keys(byId).length > 0) perModelFreeQuota = byId
        } else if (payload.points && typeof payload.points.remaining === 'number') {
          perModelFreeQuota = Object.fromEntries(
            tokenhubFreeVideoModels().map((m) => [m.id, { remaining: payload.points!.remaining, total: payload.points!.total ?? 0 }])
          )
        }
      } catch {}
    }
    return { ok: true, models: branch.catalog(perModelFreeQuota, captured) }
  })
}