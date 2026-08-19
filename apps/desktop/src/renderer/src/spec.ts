// 额度规格逻辑，与 docs/数据库与额度/Provider额度规格.md 保持一致

export const PROVIDER_LABEL: Record<string, string> = {
  auto: '智能调度',
  doubao: '豆包',
  jimeng: '即梦',
  qwen: '通义万相',
  qwenwan: '千问（通义万相）',
  yuanbao: '元宝混元',
  dola: 'Dola',
  kling: '可灵',
  hailuo: '海螺',
  zhipu: '智谱（bigmodel）'
}

export const MODELS: Record<string, string[]> = {
  auto: ['自动选择'],
  doubao: ['Seedance 2.0 Mini'],
  jimeng: ['视频 S2.0', '视频 S2.0 Pro'],
  qwen: ['万相 2.7', '万相 2.6', 'HappyHorse 1.0 Beta'],
  qwenwan: ['万相 2.7', '万相 2.6', 'HappyHorse 1.0 Beta'],
  yuanbao: ['混元'],
  dola: ['Dreamina Seedance 2.5', 'Dreamina Seedance 2.0 Fast', 'Dreamina Seedance 1.0'],
  kling: ['可灵-标准', '可灵-大师'],
  hailuo: ['海螺-标准'],
  zhipu: ['cogvideox-flash', 'cogvideox-2', 'cogvideox-3', 'Vidu Q1', 'Vidu 2']
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

export interface DurationOption {
  value: number
  label: string
  disabled?: boolean
}

export const DEFAULT_SUPPORTED_DURATIONS = [5, 10]

const DURATION_ORDER = [5, 10, 15] as const

/** 千问视频生成模式按模型限定；本轮不再给 qwenwan 暴露文生/图生视频 */
export function providerModeOptions(provider: string, model = ''): Array<{ value: string; label: string }> {
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
  return [
    { value: 't2v', label: '文生视频' },
    { value: 'img', label: '图生视频' },
    { value: 'multi_ref', label: '多参考生成' },
    { value: 'first_last', label: '首尾帧生成' }
  ]
}

export function intersectDurations(lists: number[][]): number[] {
  if (lists.length === 0) return [...DEFAULT_SUPPORTED_DURATIONS]
  const counts = new Map<number, number>()
  for (const list of lists) {
    const unique = Array.from(new Set(list.map(Number).filter((n) => Number.isFinite(n) && n > 0)))
    for (const duration of unique) {
      counts.set(duration, (counts.get(duration) ?? 0) + 1)
    }
  }
  return DURATION_ORDER.filter((duration) => counts.get(duration) === lists.length)
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
  if (provider === 'zhipu') {
    const map: Record<string, string> = {
      img2video: '生视频需上传 1 张首帧图片',
      first_last: '首尾帧生成需上传首帧和尾帧共 2 张图片',
      multi_ref: '参考生视频最多上传 5 张参考图',
      text2video: '文生视频无需上传素材'
    }
    return map[mode] ?? '文生视频无需上传素材'
  }
  if (provider === 'yuanbao') return '上传图片作为参考（最多 10 张，Ctrl+V 可粘贴）'
  if (provider === 'dola') return '上传图片作为参考（最多 10 张，Ctrl+V 可粘贴）'
  if (provider === 'doubao' && mode === 'multi_ref') return '上传图片作为参考（最多 10 张）'
  if (mode === 'multi_ref') return '拖拽图片 / 视频到此处（多参考生成，最多 5 个）'
  if (mode === 'img' || mode === 'first_last' || mode === 'first_frame') return '拖拽图片到此处，最多 5 张，或点击选择文件'
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
  return { text: '1 次', who: (PROVIDER_LABEL[provider] ?? provider) + ' 执行' }
}
