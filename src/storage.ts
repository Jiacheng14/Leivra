import { MAX_REPLY_LENGTH } from './reply'
import { validateSnapshots } from './scheduling/persistence'
import { validateChatSettings, type ChatSettings } from './scheduling/settings'
import { MAX_LENGTH, MAX_MESSAGES, createConversation, conversationMessages, type Conversation, type LocalData, type Message } from './models'
import { defaultGreeting, defaultLeivra, DEFAULT_CHARACTER_ID } from './characters/defaultLeivra'
import { validateCharacter } from './characters/cards'
import { record, stableId, text, timestamp, unique } from './validation'
export const LEGACY_STORAGE_KEY = 'leivra.prototype.messages.v1'
export const DATA_STORAGE_KEY = 'leivra.data.v1'
type LegacyMessage = Omit<Message, 'characterId' | 'conversationId'>
type StorageAccess = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

// Read-only legacy decoder: also distinguishes missing history from deliberately empty history.
export function decodeMessages(raw: string | null): LegacyMessage[] | null {
  if (raw === null) return null
  const value: unknown = JSON.parse(raw)
  if (!Array.isArray(value)) throw new Error('旧消息格式错误。')
  const messages = value.map<LegacyMessage>(item => {
    const m = record(item)
    if (m.role !== 'user' && m.role !== 'assistant') throw new Error('旧消息角色错误。')
    return { id: stableId(m.id), role: m.role, text: text(m.text, '消息', m.role === 'assistant' ? MAX_REPLY_LENGTH : MAX_LENGTH), createdAt: timestamp(m.createdAt) }
  })
  unique(messages.map(m => m.id))
  return messages.slice(-MAX_MESSAGES)
}
export function createInitialData(legacy: LegacyMessage[] | null = null): LocalData {
  const conversation = createConversation(DEFAULT_CHARACTER_ID)
  return {
    schemaVersion: 1, activeCharacterId: DEFAULT_CHARACTER_ID,
    characters: [validateCharacter(defaultLeivra)], conversations: [conversation],
    messages: legacy === null ? defaultGreeting(conversation) : legacy.map(m => ({ ...m, conversationId: conversation.id, characterId: DEFAULT_CHARACTER_ID }))
  }
}
export function validateData(value: unknown): LocalData {
  const v = record(value)
  if (v.schemaVersion !== 1) throw new Error('不支持的本地数据版本，原数据未被覆盖。')
  if (!Array.isArray(v.characters) || !Array.isArray(v.conversations) || !Array.isArray(v.messages)) throw new Error('本地数据格式错误。')
  const characters = v.characters.map(validateCharacter)
  unique(characters.map(c => c.id))
  const characterIds = new Set(characters.map(c => c.id))
  const activeCharacterId = v.activeCharacterId === null ? null : stableId(v.activeCharacterId)
  if (characters.length === 0 ? activeCharacterId !== null : activeCharacterId === null || !characterIds.has(activeCharacterId)) throw new Error('当前角色不存在。')
  const conversations: Conversation[] = v.conversations.map(item => {
    const c = record(item)
    const characterId = stableId(c.characterId)
    if (!characterIds.has(characterId)) throw new Error('会话引用了不存在的角色。')
    return { id: stableId(c.id), characterId, createdAt: timestamp(c.createdAt) }
  })
  unique(conversations.map(c => c.id))
  // v1 UI supports one direct conversation per character.
  unique(conversations.map(c => c.characterId))
  if (conversations.length !== characters.length) throw new Error('角色缺少独立会话。')
  const conversationById = new Map(conversations.map(c => [c.id, c]))
  const messages: Message[] = v.messages.map(item => {
    const m = record(item)
    const conversationId = stableId(m.conversationId)
    const characterId = stableId(m.characterId)
    if (conversationById.get(conversationId)?.characterId !== characterId || (m.role !== 'user' && m.role !== 'assistant')) throw new Error('消息所属角色或会话不匹配。')
    if (m.replyIgnored !== undefined && (m.replyIgnored !== true || m.role !== 'user')) throw new Error('忽略回复标记格式错误。')
    return { id: stableId(m.id), characterId, conversationId, role: m.role, text: text(m.text, '消息', m.role === 'assistant' ? MAX_REPLY_LENGTH : MAX_LENGTH), createdAt: timestamp(m.createdAt), ...(m.replyIgnored === true ? { replyIgnored: true as const } : {}) }
  })
  unique(messages.map(m => m.id))
  const schedulerSnapshots = v.schedulerSnapshots === undefined ? undefined : validateSnapshots(v.schedulerSnapshots, conversations)
  const chatSettings = v.chatSettings === undefined ? undefined : validateChatSettings(v.chatSettings as ChatSettings)
  const data = { schedulerSnapshots, chatSettings, schemaVersion: 1 as const, activeCharacterId, characters, conversations, messages }
  const keep = new Set(conversations.flatMap(c => conversationMessages(data, c).slice(-MAX_MESSAGES).map(m => m.id)))
  return { ...data, messages: messages.filter(m => keep.has(m.id)) }
}
export function loadData(storage: StorageAccess = localStorage): LocalData {
  const current = storage.getItem(DATA_STORAGE_KEY)
  if (current !== null) return validateData(JSON.parse(current))
  return createInitialData(decodeMessages(storage.getItem(LEGACY_STORAGE_KEY)))
}
export function saveData(data: LocalData, storage: StorageAccess = localStorage) {
  storage.setItem(DATA_STORAGE_KEY, JSON.stringify(validateData(data)))
}
export function appendMessages(data: LocalData, conversation: Conversation, messages: Message[]): LocalData {
  if (!data.conversations.some(c => c.id === conversation.id && c.characterId === conversation.characterId) || messages.some(m => m.characterId !== conversation.characterId || m.conversationId !== conversation.id)) throw new Error('消息不能写入其他角色的会话。')
  const recent = [...conversationMessages(data, conversation), ...messages.filter(m=>!data.messages.some(existing=>existing.id===m.id))].slice(-MAX_MESSAGES)
  return { ...data, messages: [...data.messages.filter(m => m.conversationId !== conversation.id), ...recent] }
}
