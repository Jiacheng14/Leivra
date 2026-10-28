export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('数据必须是对象。')
  return value as Record<string, unknown>
}
export function text(value: unknown, field: string, limit: number, required = false): string {
  if (typeof value !== 'string' || value.length > limit || (required && !value.trim())) throw new Error(field + '格式错误或超出长度限制。')
  return value
}
export function stableId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(value)) throw new Error('ID 必须是 1–80 位字母、数字、点、下划线或连字符。')
  return value
}
export function positiveInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error('版本号必须为正整数。')
  return value
}
export function timestamp(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || isNaN(new Date(value).getTime())) throw new Error('时间格式错误。')
  return value
}
export function unique(ids: string[]) {
  if (new Set(ids).size !== ids.length) throw new Error('数据包含重复 ID。')
}