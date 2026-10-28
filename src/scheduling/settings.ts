export interface ChatSettings { replyWaitMs: number; deferWhileTyping: boolean; maxWaitMs?: number | null }
export type ValidatedChatSettings = Required<ChatSettings>
export const DEFAULT_CHAT_SETTINGS: Readonly<ValidatedChatSettings> = Object.freeze({ replyWaitMs: 3500, deferWhileTyping: false, maxWaitMs: 5 * 60 * 1000 })
export function validateChatSettings(value: ChatSettings): ValidatedChatSettings {
  if (!value || typeof value.replyWaitMs !== 'number' || value.replyWaitMs < 1000 || value.replyWaitMs > 60000 || value.replyWaitMs % 500 !== 0 || typeof value.deferWhileTyping !== 'boolean') throw new Error('回复等待时间须为 1–60 秒，步长 0.5 秒。')
  const maxWaitMs = value.maxWaitMs === undefined ? DEFAULT_CHAT_SETTINGS.maxWaitMs : value.maxWaitMs
  if (maxWaitMs !== null && (typeof maxWaitMs !== 'number' || !Number.isFinite(maxWaitMs) || maxWaitMs < 60000 || maxWaitMs > 600000 || maxWaitMs % 30000 !== 0)) throw new Error('最大等待时间须为 1–10 分钟，步长 0.5 分钟，或选择不限。')
  return { replyWaitMs: value.replyWaitMs, deferWhileTyping: value.deferWhileTyping, maxWaitMs }
}
