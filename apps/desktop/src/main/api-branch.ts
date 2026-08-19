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
import { fetchZhipuQuota, zhipuGenerateWithKey } from '@quota-flow/providers'
import type { ZhipuGenerateOptions } from '@quota-flow/providers'
import { ipcMain } from 'electron'

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
}

export interface ApiGenerateParams {
  mode: 'text2video' | 'img2video' | 'first_last' | 'multi_ref'
  model: string
  prompt: string
  /** 图片 https URL（单图或数组，按模型能力透传 image_url） */
  images?: string[]
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
  /** 展示用模型目录（「查看模型」弹窗） */
  catalog(): ApiModelInfo[]
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
    catalog() {
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

/** 已注册的 API 生成分支（key = providerId） */
export const API_BRANCHES: Record<string, ApiGenerationBranch> = {
  zhipu: makeZhipuBranch()
}

let apiIpcRegistered = false

/** 注册 API 型厂商相关 IPC：provider:api-models（「查看模型」弹窗目录） */
export function registerApiIpc(): void {
  if (apiIpcRegistered) return
  apiIpcRegistered = true

  ipcMain.handle('provider:api-models', async (_e, providerId: string) => {
    const branch = API_BRANCHES[providerId]
    if (!branch) return { ok: false, error: '不支持的 API 厂商' }
    return { ok: true, models: branch.catalog() }
  })
}