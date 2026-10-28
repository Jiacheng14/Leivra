export interface ChatSettings { replyWaitMs: number; deferWhileTyping: boolean }
export const DEFAULT_CHAT_SETTINGS: Readonly<ChatSettings> = Object.freeze({ replyWaitMs: 3500, deferWhileTyping: false })
export const MAX_TYPING_EXTENSION_MS = 10000
export const INPUT_ACTIVITY_GRACE_MS = 1500
export function validateChatSettings(value: ChatSettings): ChatSettings {
  if (!value || typeof value.replyWaitMs !== 'number' || value.replyWaitMs < 1000 || value.replyWaitMs > 15000 || value.replyWaitMs % 500 !== 0 || typeof value.deferWhileTyping !== 'boolean') throw new Error('回复等待时间须为 1–15 秒，步长 0.5 秒。')
  return { replyWaitMs: value.replyWaitMs, deferWhileTyping: value.deferWhileTyping }
}
