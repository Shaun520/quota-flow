// 额度规格逻辑，与 docs/数据库与额度/Provider额度规格.md 保持一致

export const PROVIDER_LABEL: Record<string, string> = {
  doubao: '豆包',
  jimeng: '即梦',
  qwen: '通义万相',
  qwenwan: '千问（通义万相）',
  yuanbao: '元宝混元',
  dola: 'Dola',
  kling: '可灵',
  hailuo: '海螺',
  zhipu: '智谱（bigmodel）',
  volcengine: '火山方舟',
  bailian: '阿里云百炼',
  tokenhub: '腾讯云TokenHub'
}

export const MODELS: Record<string, string[]> = {
  doubao: ['Seedance 2.0 Mini'],
  jimeng: ['视频 S2.0', '视频 S2.0 Pro'],
  qwen: ['万相 2.7', '万相 2.6', 'HappyHorse 1.0 Beta'],
  qwenwan: ['万相 2.7', '万相 2.6', 'HappyHorse 1.0 Beta'],
  yuanbao: ['混元'],
  dola: ['Dreamina Seedance 2.5', 'Dreamina Seedance 2.0 Fast', 'Dreamina Seedance 1.0'],
  kling: ['可灵-标准', '可灵-大师'],
  hailuo: ['海螺-标准'],
  zhipu: ['cogvideox-flash', 'cogvideox-2', 'cogvideox-3', 'Vidu Q1', 'Vidu 2'],
  volcengine: ['doubao-seedance-1-0-pro-250528', 'doubao-seedance-1-5-pro-251215', 'doubao-seedance-1-0-pro-fast-251015', 'doubao-seedance-1-0-lite-t2v-250428', 'doubao-seedance-1-0-lite-i2v-250428'],
  bailian: ['wan2.7-t2v-2026-06-12', 'wan2.7-i2v-2026-04-25', 'wan2.7-r2v-2026-06-12']
}

/** 智谱模型展示价格（与主进程 api-branch 保持一致） */
export const ZHIPU_MODEL_PRICE: Record<string, string> = {
  'cogvideox-flash': '免费',
  'cogvideox-2': '¥0.5/次',
  'cogvideox-3': '¥1/次',
  'Vidu Q1': '¥2.5/次',
  'Vidu 2': '¥1.25/次起'
}

/** 智谱各模型固定生成时长（秒）；与主进程 api-branch.ZHIPU_MODEL_DURATIONS 保持一致 */
export const ZHIPU_MODEL_DURATIONS: Record<string, number[]> = {
  'cogvideox-flash': [5],
  'cogvideox-2': [5],
  'cogvideox-3': [5, 10],
  'Vidu Q1': [5],
  'Vidu 2': [4]
}

/** 智谱按模型取有效时长；未收录模型回退厂商配置或默认档 */
export function zhipuModelDurations(model: string): number[] {
  return ZHIPU_MODEL_DURATIONS[model] ?? DEFAULT_SUPPORTED_DURATIONS
}

/** 火山方舟（volcengine）免费视频模型：有免费推理额度，Model ID 为平台固定目录（与 docs 实测一致） */
export const VOLC_MODEL_PRICE: Record<string, string> = {
  'doubao-seedance-1-0-pro-250528': '免费',
  'doubao-seedance-1-5-pro-251215': '免费',
  'doubao-seedance-1-0-pro-fast-251015': '免费',
  'doubao-seedance-1-0-lite-t2v-250428': '免费',
  'doubao-seedance-1-0-lite-i2v-250428': '免费'
}

/** 火山方舟各模型固定生成时长（秒）；以相机生产链路为准，未收录模型走默认档 */
export const VOLC_MODEL_DURATIONS: Record<string, number[]> = {}

/** 火山方舟按模型取有效时长；未收录回退默认档 */
export function volcModelDurations(model: string): number[] {
  return VOLC_MODEL_DURATIONS[model] ?? DEFAULT_SUPPORTED_DURATIONS
}

/**
 * 阿里云百炼各模型有效时长档（秒）；与主进程 bailianModelCap 能力卡口径保持一致。
 * 来源：官网能力卡（wan2.6 最高 15s / wan2.5 10s / 参考生 5/10s / 其余默认 5/10s）。
 */
export const BAILIAN_MODEL_DURATIONS: Record<string, number[]> = {
  'wan2.7-t2v': [5, 10],
  'wan2.7-t2v-2026-04-25': [5, 10],
  'wan2.7-t2v-2026-06-12': [5, 10],
  'wan2.7-i2v': [5, 10],
  'wan2.7-i2v-2026-04-25': [5, 10],
  'wan2.7-r2v': [5, 10],
  'wan2.7-r2v-2026-06-12': [5, 10],
  'wan2.6-t2v': [5, 10, 15],
  'wan2.6-i2v': [5, 10, 15],
  'wan2.6-i2v-flash': [5, 10, 15],
  'wan2.6-r2v': [5, 10],
  'wan2.6-r2v-flash': [5, 10],
  'wan2.5-t2v-preview': [5, 10],
  'wan2.5-i2v-preview': [5, 10],
  'wan2.2-t2v-plus': [5],
  'wan2.2-i2v-plus': [5],
  'wan2.2-i2v-flash': [5],
  'wan2.2-kf2v-flash': [5],
  'wanx2.1-t2v-plus': [5],
  'wanx2.1-t2v-turbo': [5],
  'wanx2.1-i2v-plus': [5],
  'wanx2.1-i2v-turbo': [5],
  'wanx2.1-kf2v-plus': [5],
  'happyhorse-1.0-t2v': [5, 10],
  'happyhorse-1.1-t2v': [5, 10],
  'happyhorse-1.0-i2v': [5, 10],
  'happyhorse-1.1-i2v': [5, 10],
  'happyhorse-1.0-r2v': [5, 10],
  'happyhorse-1.1-r2v': [5, 10]
}

/** 阿里云百炼按模型名取有效时长档；未收录模型回退默认档（统一按官方能力卡，不再按 r2v 特殊 5s） */
export function bailianModelDurations(model: string): number[] {
  return BAILIAN_MODEL_DURATIONS[model ?? ''] ?? DEFAULT_SUPPORTED_DURATIONS
}

/**
 * 阿里云百炼各模型可用的生成模式（渲染层能力卡）。
 * 与主进程 bailianModelCap 的 BAILIAN_VERIFIED_CAP.modes 口径完全一致：
 * 依据官网能力卡「输入模态/输出模态」逐模型标注，而非仅看 t2v/i2v 命名段，
 * 避免模式下拉落到裸 value 't2v' 或对同名家族快照（如 wan2.7-t2v=Audio+Text、
 * wan2.7-t2v-2026-06-12=Text+Image）误判。detect/special 专用模型不做直接生成入口。
 */
const BAILIAN_MODEL_MODES: Record<string, Array<{ value: string; label: string }>> = {
  // ---- wan2.7（Audio+Text→Video；2026-06-12 快照为 Text+Image→Video）----
  'wan2.7-t2v': [{ value: 'text2video', label: '文生视频' }],
  'wan2.7-t2v-2026-04-25': [{ value: 'text2video', label: '文生视频' }],
  'wan2.7-t2v-2026-06-12': [{ value: 'text2video', label: '文生视频' }],
  'wan2.7-i2v': [
    { value: 'img2video', label: '图生视频(首帧)' },
    { value: 'first_last', label: '首尾帧生成' }
  ],
  'wan2.7-i2v-2026-04-25': [
    { value: 'img2video', label: '图生视频(首帧)' },
    { value: 'first_last', label: '首尾帧生成' }
  ],
  'wan2.7-r2v': [{ value: 'multi_ref', label: '多参考模式' }],
  'wan2.7-r2v-2026-06-12': [{ value: 'multi_ref', label: '多参考模式' }],
  // ---- wan2.6（Text/Image+Audio→Video+Audio，最高 15s；图生官方为「基于首帧」，不做首尾帧）----
  'wan2.6-t2v': [{ value: 'text2video', label: '文生视频' }],
  'wan2.6-i2v': [{ value: 'img2video', label: '图生视频(首帧)' }],
  'wan2.6-i2v-flash': [{ value: 'img2video', label: '图生视频(首帧)' }],
  'wan2.6-r2v': [{ value: 'multi_ref', label: '多参考模式' }],
  'wan2.6-r2v-flash': [{ value: 'multi_ref', label: '多参考模式' }],
  // ---- wan2.5 preview ----
  'wan2.5-t2v-preview': [{ value: 'text2video', label: '文生视频' }],
  'wan2.5-i2v-preview': [{ value: 'img2video', label: '图生视频(首帧)' }],
  // ---- wan2.2 ----
  'wan2.2-t2v-plus': [{ value: 'text2video', label: '文生视频' }],
  'wan2.2-i2v-plus': [{ value: 'img2video', label: '图生视频(首帧)' }],
  'wan2.2-i2v-flash': [{ value: 'img2video', label: '图生视频(首帧)' }],
  'wan2.2-kf2v-flash': [{ value: 'first_last', label: '首尾帧生成' }],
  // ---- wanx2.1 ----
  'wanx2.1-t2v-plus': [{ value: 'text2video', label: '文生视频' }],
  'wanx2.1-t2v-turbo': [{ value: 'text2video', label: '文生视频' }],
  'wanx2.1-i2v-plus': [{ value: 'img2video', label: '图生视频(首帧)' }],
  'wanx2.1-i2v-turbo': [{ value: 'img2video', label: '图生视频(首帧)' }],
  'wanx2.1-kf2v-plus': [{ value: 'first_last', label: '首尾帧生成' }],
  // ---- happyhorse ----
  'happyhorse-1.0-t2v': [{ value: 'text2video', label: '文生视频' }],
  'happyhorse-1.1-t2v': [{ value: 'text2video', label: '文生视频' }],
  'happyhorse-1.0-i2v': [{ value: 'img2video', label: '图生视频(首帧)' }],
  'happyhorse-1.1-i2v': [{ value: 'img2video', label: '图生视频(首帧)' }],
  'happyhorse-1.0-r2v': [{ value: 'multi_ref', label: '多参考模式' }],
  'happyhorse-1.1-r2v': [{ value: 'multi_ref', label: '多参考模式' }]
}

/**
 * 阿里云百炼 t2v（文生视频）模型可对外暴露的输入能力（渲染层唯一口径）。
 * 口径 =「用户可见的能力 = 能正确传参的模型」（measure-before-hardcode）：
 * 与主进程 BAILIAN_VERIFIED_CAP 的 input 一致，但剔除字段未实测确认的模态
 * （未确认就下发会把错误字段发给厂商）：
 *   - wan2.7 系列音频已确认 `input.audio_url`（官方文生视频 API 参考 + SDK 示例）→ 暴露 'Audio'；
 *   - wan2.7-t2v-2026-06-12 能力卡虽标 Text+Image，但官方「文生视频 API 参考」仅 input.audio_url，
 *     无图片 media 传参字段 → 不暴露 'Image'（t2v 图片本轮不做）；其音频同样走 audio_url → 暴露 'Audio'；
 *   - wan2.6-t2v / wan2.5-t2v-preview 旧协议音频字段未确认 → 不暴露 'Audio'。
 * 用于驱动音频/图片上传区显隐；未收录 t2v 默认 ['Text']，不误开放任何上传入口。
 */
export function bailianModelInputs(model: string): string[] {
  switch (model ?? '') {
    case 'wan2.7-t2v':
    case 'wan2.7-t2v-2026-04-25':
    case 'wan2.7-t2v-2026-06-12':
      return ['Audio', 'Text']
    // 参考生（r2v）：实测（2026-08-21）确认当前账号/地域的 r2v 快照其 media[]
    // 仅接受图片格式（jpeg/jpg/png/bmp/webp），不接受 mp4 视频（报「format mp4 is not supported」）。
    // 因此只暴露 Image，驱动 multi_ref 上传区仅开放「参考图片」（多图），不开放视频入口。
    // 说明：官方通用文档示例含 reference_video，但与本实测口径冲突，以实测为准（见 measure-before-hardcode）。
    case 'wan2.7-r2v':
    case 'wan2.7-r2v-2026-06-12':
    case 'wan2.6-r2v':
    case 'wan2.6-r2v-flash':
    case 'happyhorse-1.0-r2v':
    case 'happyhorse-1.1-r2v':
      return ['Text', 'Image']
    default:
      return ['Text']
  }
}

/**
 * 腾讯云 TokenHub 免费视频模型展示价格（与主进程 api-branch.tokenhubFreeVideoModels 保持一致）。
 * 来源：官方产品计费页实测（四模型积分费率/计费方式）。
 */
export const TKH_MODEL_PRICE: Record<string, string> = {
  'hy-video-1.5': '1.5 积分/次',
  'yt-video-2.0': '2 积分/次起（480p）',
  'yt-video-humanactor': '1 积分/秒（720p）',
  'yt-video-fx': '按模板积分'
}

/** 腾讯云 TokenHub 各模型固定生成时长（秒）；官方 OpenAI 兼容示例未给出，先按项目默认档 [5] TEMP 兜底，待真实提交实测修正 */
export const TKH_MODEL_DURATIONS: Record<string, number[]> = {
  'hy-video-1.5': [5],
  'yt-video-2.0': [5],
  'yt-video-humanactor': [5],
  'yt-video-fx': [5]
}

/** 腾讯云 TokenHub 按模型取有效时长；未收录模型回退默认档 */
export function tkhModelDurations(model: string): number[] {
  return TKH_MODEL_DURATIONS[model ?? ''] ?? DEFAULT_SUPPORTED_DURATIONS
}

/** 腾讯云 TokenHub 各模型可用的生成模式（与主进程 api-branch.TOKENHUB_MODEL_MODES 口径一致） */
const TKH_MODEL_MODES: Record<string, Array<{ value: string; label: string }>> = {
  'hy-video-1.5': [
    { value: 'text2video', label: '文生视频' },
    { value: 'img2video', label: '图生视频' }
  ],
  'yt-video-2.0': [{ value: 'img2video', label: '图生视频' }],
  'yt-video-humanactor': [{ value: 'img2video', label: '图生视频' }],
  'yt-video-fx': []
}

export interface DurationOption {
  value: number
  label: string
  disabled?: boolean
}

export const DEFAULT_SUPPORTED_DURATIONS = [5, 10]

const DURATION_ORDER = [5, 10, 15] as const

/** 千问视频生成模式按模型限定；本轮不再给 qwenwan 暴露文生/图生视频 */
export function providerModeOptions(provider: string, model = ''): Array<{ value: string; label: string }> {
  if (provider === 'volcengine') {
    // 火山免费视频模型支持文生视频 + 图生视频（Seedance 均有免费额度）
    return [
      { value: 'text2video', label: '文生视频' },
      { value: 'img2video', label: '图生视频' }
    ]
  }
  if (provider === 'zhipu') {
    switch (model) {
      case 'cogvideox-flash':
      case 'cogvideox-2':
      case 'cogvideox-3':
        return [
          { value: 'text2video', label: '文生视频' },
          { value: 'img2video', label: '图生视频' }
        ]
      case 'Vidu Q1':
        return [
          { value: 'text2video', label: '文生视频' },
          { value: 'img2video', label: '图生视频' },
          { value: 'first_last', label: '首尾帧生成' }
        ]
      case 'Vidu 2':
        return [
          { value: 'img2video', label: '图生视频' },
          { value: 'first_last', label: '首尾帧生成' },
          { value: 'multi_ref', label: '多参考生成' }
        ]
      default:
        return []
    }
  }
  if (provider === 'bailian') {
    // 调度台模型来自账号免费额度快照，模式优先按 BAILIAN_MODEL_MODES 能力卡精确匹配，
    // 未收录模型再按命名段回溯（r2v·refer=参考生 / kf2v=首尾帧 / i2v=图生 / t2v=文生）。
    // 归属与主进程 bailianModelCap 完全一致，避免下拉落到裸 value 't2v'。
    const m = model ?? ''
    // t2v 标签动态附加能力提示：暴露 Audio 的模型（当前 wan2.7 系列，见 bailianModelInputs）
    // 显示「支持音频参考」，与音频上传区和主进程能力卡口径一致，避免用户误以为文生视频不能传音频。
    const t2vSuffix = bailianModelInputs(m).includes('Audio') ? '（支持音频参考）' : ''
    const t2v = () => ({ value: 'text2video', label: `文生视频${t2vSuffix}` })
    const exact = BAILIAN_MODEL_MODES[m]
    if (exact) return exact.map((o) => (o.value === 'text2video' ? t2v() : o))
    if (/(^|[_-])r2v([_-]|$)/i.test(m) || /refer/i.test(m)) {
      return [{ value: 'multi_ref', label: '多参考模式' }]
    }
    if (/(^|[_-])kf2v([_-]|$)/i.test(m) || /start-end/i.test(m)) {
      return [{ value: 'first_last', label: '首尾帧生成' }]
    }
    if (/(^|[_-])i2v([_-]|$)/i.test(m)) {
      return [{ value: 'img2video', label: '图生视频(首帧)' }]
    }
    if (/(^|[_-])t2v([_-]|$)/i.test(m)) return [t2v()]
    // 兜底：识别不出类型的百炼视频模型统一按「文生视频」，避免下拉落到裸 value 't2v'
    return [t2v()]
  }
  if (provider === 'qwenwan') {
    if (model === '万相 2.7') {
      return [
        { value: 'multi_ref', label: '多参考生成' },
        { value: 'first_last', label: '首尾帧生成' }
      ]
    }
    return [
      { value: 'multi_ref', label: '多参考生成' },
      { value: 'first_frame', label: '首帧生成' }
    ]
  }
  // 元宝没有独立视频生成 DOM，只按提示词 + 多参考图片执行，避免暴露无实际作用的模式选项。
  if (provider === 'yuanbao') {
    return [{ value: 'multi_ref', label: '多参考生成' }]
  }
  if (provider === 'dola') {
    return [{ value: 'multi_ref', label: '多参考生成' }]
  }
  if (provider === 'tokenhub') {
    // 腾讯云 TokenHub 各模型模式与主进程 TOKENHUB_MODEL_MODES 一致；FX 待模板选择器，暂无入口
    return TKH_MODEL_MODES[model ?? ''] ?? []
  }
  return [
    { value: 't2v', label: '文生视频' },
    { value: 'img', label: '图生视频' },
    { value: 'multi_ref', label: '多参考生成' },
    { value: 'first_last', label: '首尾帧生成' }
  ]
}

export function durationOptions(
  provider: string,
  model: string,
  mode: string,
  vip: boolean,
  supportedDurations: number[] = DEFAULT_SUPPORTED_DURATIONS
): DurationOption[] {
  const allowed = new Set(supportedDurations)
  // 智谱：Vidu 2 固定 4s，时长可能不在标准档位，直接按模型能力生成
  if (provider === 'zhipu') {
    const list: DurationOption[] = [...new Set([...allowed])]
      .filter((d) => Number.isFinite(d) && d > 0)
      .sort((a, b) => a - b)
      .map((d) => ({ value: d, label: `${d} 秒` }))
    return list.length > 0 ? list : [{ value: 5, label: '5 秒' }]
  }
  const durations: DurationOption[] = DURATION_ORDER.filter((d) => allowed.has(d)).map((d) => ({
    value: d,
    label: `${d} 秒`
  }))
  if (durations.length === 0) {
    durations.push({ value: 5, label: '5 秒' })
  }
  if (provider === 'yuanbao') {
    durations.length = 1
    durations[0] = { value: 5, label: '5 秒' }
  }
  const d15 = durations.find((d) => d.value === 15)
  if (provider === 'doubao' && d15 && !vip) {
    d15.label = '15 秒（仅 VIP）'
    d15.disabled = true
  }
  if ((provider === 'qwen' || provider === 'qwenwan') && d15) {
    if (model === '万相 2.6' && mode === 'multi_ref') {
      d15.label = '15 秒（多参考不支持）'
      d15.disabled = true
    }
    if (model === 'HappyHorse 1.0 Beta') {
      d15.label = '15 秒（该模型不支持）'
      d15.disabled = true
    }
  }
  return durations
}

export function resolutionOptions(
  provider: string
): Array<{ value: string; label: string }> {
  if (provider === 'yuanbao') return [{ value: '720', label: '720p' }]
  return [
    { value: '720', label: '720p' },
    { value: '1080', label: '1080p' }
  ]
}

export function ratioOptions(provider: string): Array<{ value: string; label: string }> {
  if (provider === 'dola') {
    return [
      { value: '1:1', label: '1:1' },
      { value: '3:4', label: '3:4' },
      { value: '4:3', label: '4:3' },
      { value: '9:16', label: '9:16' },
      { value: '16:9', label: '16:9' },
      { value: '21:9', label: '21:9' }
    ]
  }
  if (provider === 'qwenwan') {
    return [
      { value: '9:16', label: '9:16' },
      { value: '3:4', label: '3:4' },
      { value: '1:1', label: '1:1' },
      { value: '4:3', label: '4:3' },
      { value: '16:9', label: '16:9' }
    ]
  }
  return [
    { value: '9:16', label: '9:16' },
    { value: '16:9', label: '16:9' },
    { value: '1:1', label: '1:1' }
  ]
}

export function uploadHint(provider: string, mode: string): string {
  if (provider === 'volcengine') {
    const map: Record<string, string> = {
      img2video: '图生视频需上传 1 张首帧图片',
      text2video: '文生视频无需上传素材'
    }
    return map[mode] ?? '文生视频无需上传素材'
  }
  if (provider === 'zhipu') {
    const map: Record<string, string> = {
      img2video: '生视频需上传 1 张首帧图片',
      first_last: '首尾帧生成需上传首帧和尾帧共 2 张图片',
      multi_ref: '参考生视频最多上传 5 张参考图',
      text2video: '文生视频无需上传素材'
    }
    return map[mode] ?? '文生视频无需上传素材'
  }
  if (provider === 'bailian') {
    // 百炼各模式显式映射，避免默认「文生视频无需上传素材」误导用户
    const map: Record<string, string> = {
      text2video: '文生视频无需上传素材',
      img2video: '图生视频需上传 1 张首帧图片',
      first_last: '首尾帧生成需上传首帧和尾帧共 2 张图片',
      multi_ref: '多参考模式最多上传 5 张参考图',
    }
    return map[mode] ?? '拖拽图片到此处，最多 5 张'
  }
  if (provider === 'yuanbao') return '上传图片作为参考（最多 10 张，Ctrl+V 可粘贴）'
  if (provider === 'dola') return '上传图片作为参考（最多 10 张，Ctrl+V 可粘贴）'
  if (provider === 'tokenhub') {
    const map: Record<string, string> = {
      img2video: '图生视频需上传 1 张公网 HTTPS 图片',
      text2video: '文生视频无需上传素材'
    }
    return map[mode] ?? '文生视频无需上传素材'
  }
  if (provider === 'doubao' && mode === 'multi_ref') return '上传图片作为参考（最多 10 张）'
  if (mode === 'multi_ref') return '拖拽图片 / 视频到此处（多参考生成，最多 5 个）'
  // 图生视频/首尾帧/首帧：提示需要图片素材
  if (mode === 'img' || mode === 'img2video' || mode === 'first_last' || mode === 'first_frame')
    return '拖拽图片到此处，最多 5 张，或点击选择文件'
  return '文生视频无需上传素材'
}

const DURATION_POINT: Record<number, number> = { 5: 0, 10: 1, 15: 2 }

export interface CostResult {
  text: string
  who: string
}

export function computeCost(
  provider: string,
  model: string,
  duration: number,
  resolution: string
): CostResult {
  const d = DURATION_POINT[duration] ?? 0
  if (provider === 'volcengine') {
    const price = VOLC_MODEL_PRICE[model] ?? '免费'
    return { text: price, who: model + ' · ' + duration + 's' }
  }
  if (provider === 'zhipu') {
    const price = ZHIPU_MODEL_PRICE[model] ?? '免费'
    return { text: price, who: model + ' · ' + duration + 's' }
  }
  if (provider === 'qwen' || provider === 'qwenwan') {
    const cost = 1 + d + (resolution === '1080' ? 1 : 0)
    return { text: cost + ' 额度', who: model + ' · ' + duration + 's · ' + resolution + 'p' }
  }
  if (provider === 'doubao') {
    return { text: 1 + d + ' 点', who: 'Seedance 2.0 Mini · ' + duration + 's' }
  }
  if (provider === 'yuanbao') {
    return { text: '1 个', who: '元宝混元 · 5s' }
  }
  if (provider === 'dola') {
    return { text: 1 + d + ' 点', who: model + ' · ' + duration + 's' }
  }
  if (provider === 'tokenhub') {
    const price = TKH_MODEL_PRICE[model] ?? '免费'
    return { text: price, who: model + ' · ' + duration + 's' }
  }
  return { text: '1 次', who: (PROVIDER_LABEL[provider] ?? provider) + ' 执行' }
}
