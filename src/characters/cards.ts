import type { Character, LocalData } from '../models'
import { createConversation } from '../models'
import { positiveInteger, record, stableId, text } from '../validation'
import { CARD_LIMIT_BYTES, fromCardV2, projectCardV2, updateCardV2, validateCardV2 } from './cardV2'
export { CARD_LIMIT_BYTES } from './cardV2'
export function validateCharacter(value: unknown): Character {
  const v = record(value)
  if (v.schemaVersion !== 1) throw new Error('不支持的人物卡 schemaVersion；当前仅支持 Leivra v1。')
  const fields = ['schemaVersion','id','revision','name','avatar','background','personality','speakingStyle','relationship','customPrompt','preferences','sourceCardV2']
  if (Object.keys(v).some(k => !fields.includes(k))) throw new Error('人物卡包含未知字段，请使用 Leivra v1 格式。')
  const sourceCardV2 = v.sourceCardV2 === undefined ? undefined : validateCardV2(v.sourceCardV2)
  const avatar = text(v.avatar, '头像', 180000, true)
  // Local assets or embedded raster images only: imported cards must not phone home.
  if (!/^\/(?!\/)(?!.*\.\.)[a-zA-Z0-9/_.-]+\.(svg|png|jpe?g|webp)$/.test(avatar) && !/^data:image\/(png|jpeg|webp);base64,[a-zA-Z0-9+/]+={0,2}$/.test(avatar)) throw new Error('头像仅支持站点内图片路径或内嵌 PNG/JPEG/WebP。')
  if (!Array.isArray(v.personality) || v.personality.length > 20) throw new Error('性格特征必须为最多 20 项的数组。')
  let preferences: Character['preferences']
  if (v.preferences !== undefined) {
    const p = record(v.preferences)
    if (Object.keys(p).some(k => !['temperature','maxReplyMessages'].includes(k))) throw new Error('人物偏好包含未知参数。')
    preferences = {}
    if (p.temperature !== undefined) {
      if (typeof p.temperature !== 'number' || !Number.isFinite(p.temperature) || p.temperature < 0 || p.temperature > 2) throw new Error('temperature 必须在 0–2 之间。')
      preferences.temperature = p.temperature
    }
    if (p.maxReplyMessages !== undefined) {
      const count = positiveInteger(p.maxReplyMessages)
      if (count > 8) throw new Error('maxReplyMessages 必须在 1–8 之间。')
      preferences.maxReplyMessages = count
    }
  }
  const card: Character = {
    schemaVersion: 1, id: stableId(v.id), revision: positiveInteger(v.revision),
    name: sourceCardV2 ? text(v.name, '名称', 80, true) : text(v.name, '名称', 80, true).trim(), avatar,
    background: text(v.background, '身份背景', 8000),
    personality: v.personality.map(item => text(item, '性格特征', sourceCardV2 ? 10000 : 500, !sourceCardV2)),
    speakingStyle: text(v.speakingStyle, '语言风格', 4000),
    relationship: text(v.relationship, '关系设定', 4000),
    customPrompt: text(v.customPrompt, '人格提示词', 12000),
    ...(preferences ? { preferences } : {}),
    ...(sourceCardV2 ? { sourceCardV2 } : {})
  }
  if (sourceCardV2) {
    const projection = projectCardV2(sourceCardV2)
    for (const key of Object.keys(projection) as (keyof typeof projection)[]) {
      if (key === 'preferences') continue
      if (JSON.stringify(card[key]) !== JSON.stringify(projection[key])) throw new Error('V2 人物卡与角色快照不一致。')
    }
    if (card.preferences?.temperature !== projection.preferences?.temperature || card.preferences?.maxReplyMessages !== projection.preferences?.maxReplyMessages) throw new Error('V2 人物偏好不一致。')
  } else if (new TextEncoder().encode(JSON.stringify(card, null, 2)).length > CARD_LIMIT_BYTES) throw new Error('人物卡不得超过 256 KiB。')
  return card
}
export function importCharacter(json: string): Character {
  if (new TextEncoder().encode(json).length > CARD_LIMIT_BYTES) throw new Error('人物卡文件不得超过 256 KiB。')
  let value: unknown
  try { value = JSON.parse(json) } catch { throw new Error('人物卡 JSON 格式错误。') }
  return validateCharacter(record(value).spec === undefined ? value : fromCardV2(value))
}
export function exportCharacter(character: Character): string {
  const card = validateCharacter(character)
  // Compact V2 JSON keeps accepted cards within the same byte budget on reimport.
  return card.sourceCardV2 ? JSON.stringify(card.sourceCardV2) : JSON.stringify(card, null, 2)
}
export function addCharacter(data: LocalData, value: unknown): LocalData {
  const card = validateCharacter(value)
  if (data.characters.some(c => c.id === card.id)) throw new Error('该角色 ID 已存在；请编辑现有角色，或为新角色使用不同 ID。')
  return { ...data, characters: [...data.characters, card], conversations: [...data.conversations, createConversation(card.id)], activeCharacterId: card.id }
}
export function editCharacter(data: LocalData, id: string, changes: Omit<Character, 'id' | 'revision' | 'schemaVersion'>): LocalData {
  const current = data.characters.find(c => c.id === id)
  if (!current) throw new Error('角色不存在。')
  let candidate: Character = { ...changes, id, revision: current.revision + 1, schemaVersion: 1 }
  if (current.sourceCardV2) {
    const sourceCardV2 = updateCardV2(current, candidate)
    candidate = { ...projectCardV2(sourceCardV2), sourceCardV2 }
  }
  const updated = validateCharacter(candidate)
  return { ...data, characters: data.characters.map(c => c.id === id ? updated : c) }
}
export function removeCharacter(data: LocalData, id: string): LocalData {
  if (!data.characters.some(c => c.id === id)) throw new Error('联系人不存在。')
  const characters = data.characters.filter(c => c.id !== id)
  const removedConversations = new Set(data.conversations.filter(c => c.characterId === id).map(c => c.id))
  return {
    ...data, characters,
    schedulerSnapshots: data.schedulerSnapshots?.filter(s=>s.characterId!==id && !removedConversations.has(s.conversationId)),
    conversations: data.conversations.filter(c => c.characterId !== id),
    messages: data.messages.filter(m => m.characterId !== id && !removedConversations.has(m.conversationId)),
    activeCharacterId: data.activeCharacterId === id ? characters[0]?.id ?? null : data.activeCharacterId
  }
}
