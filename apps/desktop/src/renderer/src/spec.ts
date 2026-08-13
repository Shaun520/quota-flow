// 额度规格逻辑，与 docs/provider-quota-spec.md 保持一致

export const PROVIDER_LABEL: Record<string, string> = {
  auto: '智能调度',
  doubao: '豆包',
  jimeng: '即梦',
  qwen: '通义万相',
  yuanbao: '元宝混元',
  kling: '可灵',
  hailuo: '海螺',
  mathmind: 'MathMind'
}

export const MODELS: Record<string, string[]> = {
  auto: ['自动选择'],
  doubao: ['Seedance 2.0 Mini'],
  jimeng: ['视频 S2.0', '视频 S2.0 Pro'],
  qwen: ['万相 2.7', '万相 2.6', 'HappyHorse 1.0 Beta'],
  yuanbao: ['混元（固定）'],
  kling: ['可灵-标准', '可灵-大师'],
  hailuo: ['海螺-标准'],
  mathmind: ['mathmind-v1', 'mathmind-v2']
}

export interface DurationOption {
  value: number
  label: string
  disabled?: boolean
}

export const DEFAULT_SUPPORTED_DURATIONS = [5, 10]

const DURATION_ORDER = [5, 10, 15] as const

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
  const durations: DurationOption[] = DURATION_ORDER.filter((d) => allowed.has(d)).map((d) => ({
    value: d,
    label: `${d} 秒`
  }))
  if (durations.length === 0) {
    durations.push({ value: 5, label: '5 秒' })
  }
  if (provider === 'yuanbao') {
    durations.length = 1
    durations[0] = { value: 5, label: '5 秒（固定）' }
  }
  const d15 = durations.find((d) => d.value === 15)
  if (provider === 'doubao' && d15 && !vip) {
    d15.label = '15 秒（仅 VIP）'
    d15.disabled = true
  }
  if (provider === 'qwen' && d15) {
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
  if (provider === 'yuanbao') return [{ value: '720', label: '720p（固定）' }]
  return [
    { value: '720', label: '720p' },
    { value: '1080', label: '1080p' }
  ]
}

export function uploadHint(provider: string, mode: string): string {
  if (provider === 'yuanbao') return '上传图片作为参考（最多 10 张，不支持视频）'
  if (mode === 'multi_ref') return '拖拽图片 / 视频到此处（多参考生成，最多 5 个）'
  if (mode === 'img' || mode === 'first_last') return '拖拽图片到此处，或点击选择文件'
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
  if (provider === 'qwen') {
    const cost = 1 + d + (resolution === '1080' ? 1 : 0)
    return { text: cost + ' 额度', who: model + ' · ' + duration + 's · ' + resolution + 'p' }
  }
  if (provider === 'doubao') {
    return { text: 1 + d + ' 点', who: 'Seedance 2.0 Mini · ' + duration + 's' }
  }
  if (provider === 'yuanbao') {
    return { text: '1 个', who: '元宝混元（固定 5 秒）' }
  }
  return { text: '1 次', who: (PROVIDER_LABEL[provider] ?? provider) + ' 执行' }
}
