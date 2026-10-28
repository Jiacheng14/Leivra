import type { Character } from '../models'
import { positiveInteger, record } from '../validation'

export function validatePreferences(value: unknown): Character['preferences'] {
  if (value === undefined) return undefined
  const p = record(value)
  if (Object.keys(p).some(k => !['temperature', 'maxReplyMessages'].includes(k))) throw new Error('人物偏好包含未知参数。')
  const preferences: NonNullable<Character['preferences']> = {}
  if (p.temperature !== undefined) {
    if (typeof p.temperature !== 'number' || !Number.isFinite(p.temperature) || p.temperature < 0 || p.temperature > 2) throw new Error('temperature 必须在 0–2 之间。')
    preferences.temperature = p.temperature
  }
  if (p.maxReplyMessages !== undefined) {
    const count = positiveInteger(p.maxReplyMessages)
    if (count > 8) throw new Error('maxReplyMessages 必须在 1–8 之间。')
    preferences.maxReplyMessages = count
  }
  return preferences
}
