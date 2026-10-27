import type { Message } from './chat'
export const STORAGE_KEY = 'leivra.prototype.messages.v1'
export function decodeMessages(raw: string | null): Message[] | null {
  if (raw === null) return null
  const value: unknown = JSON.parse(raw)
  if (!Array.isArray(value) || !value.every(m => m && typeof m.id === 'string' && (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string' && m.text.length <= 2000 && typeof m.createdAt === 'number' && Number.isFinite(m.createdAt) && !isNaN(new Date(m.createdAt).getTime()))) throw new Error('Invalid message storage')
  return value.slice(-500)
}
export function saveMessages(messages: Message[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(messages.slice(-500)))
}