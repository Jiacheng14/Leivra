export interface ChatSettings { replyWaitMs: number; deferWhileTyping: boolean }
export const DEFAULT_CHAT_SETTINGS: Readonly<ChatSettings> = Object.freeze({ replyWaitMs: 3500, deferWhileTyping: false })
export const MAX_ROUND_WAIT_MS = 5 * 60 * 1000
export function validateChatSettings(value: ChatSettings): ChatSettings {
  if (!value || typeof value.replyWaitMs !== 'number' || value.replyWaitMs < 1000 || value.replyWaitMs > 60000 || value.replyWaitMs % 500 !== 0 || typeof value.deferWhileTyping !== 'boolean') throw new Error('回复等待时间须为 1–60 秒，步长 0.5 秒。')
  return { replyWaitMs: value.replyWaitMs, deferWhileTyping: value.deferWhileTyping }
}
