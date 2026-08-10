export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message
  if (typeof e === 'string') return e
  if (e && typeof e === 'object') {
    const obj = e as Record<string, unknown>
    const m = obj.message ?? obj.details ?? obj.hint ?? obj.error
    if (typeof m === 'string') return m
    try {
      return JSON.stringify(obj)
    } catch {
      return String(e)
    }
  }
  return String(e)
}