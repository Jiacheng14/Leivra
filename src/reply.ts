import type { ModelOutput } from './models'
import { record } from './validation'
// Abnormal-output safeguards, not target lengths or requested bubble counts.
export const MAX_REPLY_MESSAGES = 32
export const MAX_REPLY_LENGTH = 32000
export const MAX_REPLY_TOTAL = 64000
export function validateModelOutput(value: unknown): ModelOutput {
  const v = record(value)
  if (Object.keys(v).some(key => key !== 'messages') || !Array.isArray(v.messages) || !v.messages.length || v.messages.length > MAX_REPLY_MESSAGES || !v.messages.every(item => typeof item === 'string' && item.trim() && item.length <= MAX_REPLY_LENGTH) || v.messages.reduce((n, item: string) => n + item.length, 0) > MAX_REPLY_TOTAL) throw new Error('模型输出格式错误。')
  return { messages: [...v.messages] }
}
export function replyDelayMs(text: string): number {
  return 1000 * Math.min(4, 1 + Math.sqrt(Array.from(text).length / 50))
}
