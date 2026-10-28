import type { Character } from '../models'
import { newId } from '../ids'
import { positiveInteger, record, stableId, text } from '../validation'
import { validatePreferences } from './preferences'

export const CARD_LIMIT_BYTES = 256 * 1024
export interface CardV2 extends Record<string, unknown> {
  spec: 'chara_card_v2'
  spec_version: '2.0'
  data: Record<string, unknown> & {
    name: string
    description: string
    personality: string
    scenario: string
    first_mes: string
    mes_example: string
    extensions: Record<string, unknown>
  }
}

// Unknown fields are inert JSON, never deep-merged or interpreted as templates/code.
export function validateJsonTree(value: unknown): void {
  let nodes = 0
  function visit(item: unknown, depth: number) {
    if (++nodes > 10000 || depth > 16) throw new Error('人物卡嵌套过深或数据项过多。')
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return
    if (typeof item === 'number' && Number.isFinite(item)) return
    if (typeof item !== 'object' || !item) throw new Error('人物卡只能包含 JSON 数据。')
    if (Array.isArray(item)) {
      if (item.length > 1000) throw new Error('人物卡数组过长。')
      for (const child of item) visit(child, depth + 1)
    } else {
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new Error('人物卡对象格式错误。')
      for (const child of Object.values(item)) visit(child, depth + 1)
    }
  }
  visit(value, 0)
  if (new TextEncoder().encode(JSON.stringify(value)).length > CARD_LIMIT_BYTES) throw new Error('人物卡不得超过 256 KiB。')
}

export function validateCardV2(value: unknown): CardV2 {
  validateJsonTree(value)
  const v = record(value), d = record(v.data)
  if (v.spec !== 'chara_card_v2' || v.spec_version !== '2.0') throw new Error('不支持的人物卡格式或版本。')
  text(d.name, '名称', 80, true)
  for (const [key, limit] of Object.entries({ description: 8000, personality: 10000, scenario: 8000, first_mes: 12000, mes_example: 12000 })) text(d[key], key, limit)
  for (const key of ['system_prompt', 'post_history_instructions', 'creator_notes', 'creator', 'character_version']) {
    if (d[key] !== undefined) text(d[key], key, 12000)
  }
  for (const key of ['alternate_greetings', 'tags']) {
    if (d[key] !== undefined && (!Array.isArray(d[key]) || !d[key].every(item => typeof item === 'string'))) throw new Error(key + '必须为字符串数组。')
  }
  if (d.character_book !== undefined) {
    const book = record(d.character_book)
    record(book.extensions)
    if (!Array.isArray(book.entries)) throw new Error('世界书 entries 必须为数组。')
    for (const item of book.entries) {
      const entry = record(item)
      if (!Array.isArray(entry.keys) || !entry.keys.every(key => typeof key === 'string') || typeof entry.content !== 'string' || typeof entry.enabled !== 'boolean' || typeof entry.insertion_order !== 'number' || !Number.isFinite(entry.insertion_order)) throw new Error('世界书条目格式错误。')
      record(entry.extensions)
    }
  }
  const extensions = d.extensions === undefined ? {} : record(d.extensions)
  if (extensions.leivra !== undefined) {
    const ext = record(extensions.leivra)
    if (ext.schemaVersion !== 1) throw new Error('不支持的 Leivra 扩展版本。')
    if (ext.id !== undefined) stableId(ext.id)
    if (ext.revision !== undefined) positiveInteger(ext.revision)
    validatePreferences(ext.preferences)
    for (const [key, limit] of Object.entries({ avatar: 180000, speakingStyle: 4000, relationship: 4000, customPrompt: 12000 })) {
      if (ext[key] !== undefined) text(ext[key], key, limit)
    }
  }
  // A cloned full document preserves unknown top-level, data and nested extension keys.
  return structuredClone({ ...v, data: { ...d, extensions } }) as CardV2
}

export function projectCardV2(source: CardV2): Omit<Character, 'sourceCardV2'> {
  const d = source.data, ext = record(d.extensions.leivra)
  return {
    schemaVersion: 1, id: stableId(ext.id), revision: positiveInteger(ext.revision),
    name: d.name, avatar: typeof ext.avatar === 'string' ? ext.avatar : '/avatar.svg',
    background: d.description, personality: d.personality ? [d.personality] : [],
    speakingStyle: typeof ext.speakingStyle === 'string' ? ext.speakingStyle : '',
    relationship: typeof ext.relationship === 'string' ? ext.relationship : '',
    customPrompt: typeof ext.customPrompt === 'string' ? ext.customPrompt : '',
    ...(ext.preferences === undefined ? {} : { preferences: validatePreferences(ext.preferences) })
  }
}

export function fromCardV2(value: unknown): Character {
  const source = validateCardV2(value)
  const ext = source.data.extensions.leivra === undefined ? {} : record(source.data.extensions.leivra)
  source.data.extensions.leivra = { ...ext, schemaVersion: 1, id: ext.id ?? newId(), revision: ext.revision ?? 1 }
  return { ...projectCardV2(source), sourceCardV2: source }
}

// Only explicit edits replace mapped values; unrelated fields retain their original JSON values.
export function updateCardV2(current: Character, next: Character): CardV2 {
  const source = validateCardV2(current.sourceCardV2)
  const d = source.data, ext = record(d.extensions.leivra)
  if (next.name !== current.name) d.name = next.name
  if (next.background !== current.background) d.description = next.background
  if (JSON.stringify(next.personality) !== JSON.stringify(current.personality)) d.personality = next.personality.join('\n')
  for (const key of ['avatar', 'speakingStyle', 'relationship', 'customPrompt', 'preferences'] as const) {
    if (JSON.stringify(next[key]) !== JSON.stringify(current[key])) {
      if (next[key] === undefined) delete ext[key]
      else ext[key] = next[key]
    }
  }
  ext.revision = next.revision
  return source
}
