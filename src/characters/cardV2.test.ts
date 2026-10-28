import { expect, it, vi } from 'vitest'
import { fixtureCardV2 } from '../../tests/fixtures/cardV2'
import { addCharacter, editCharacter, exportCharacter, importCharacter, validateCharacter } from './cards'
import { createInitialData, DATA_STORAGE_KEY, loadData, saveData } from '../storage'
import { CARD_LIMIT_BYTES, validateCardV2 } from './cardV2'

it('preserves all unknown V2 JSON through edits, storage and repeated export/import', () => {
  const raw = fixtureCardV2()
  const card = importCharacter(JSON.stringify(raw))
  let data = addCharacter(createInitialData([]), card)
  const { id, revision: _revision, schemaVersion: _schema, ...fields } = card
  data = editCharacter(data, id, { ...fields, name: '改名', background: '新的身份', personality: ['新性格\n\n完整段落'], speakingStyle: '新语气', relationship: '静态关系', customPrompt: '角色资料补充' })
  const values = new Map<string, string>()
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
  saveData(data, { ...storage, removeItem: key => { values.delete(key) } })
  const loaded = loadData({ ...storage, removeItem: key => { values.delete(key) } }).characters.find(c => c.id === id)!
  const exported = JSON.parse(exportCharacter(loaded))
  expect(exported).toEqual({ ...raw, data: { ...raw.data, name: '改名', description: '新的身份', personality: '新性格\n\n完整段落', extensions: { ...raw.data.extensions, leivra: { schemaVersion: 1, id, revision: 2, speakingStyle: '新语气', relationship: '静态关系', customPrompt: '角色资料补充' } } } })
  expect(importCharacter(exportCharacter(loaded))).toEqual(loaded)
  expect(loaded.sourceCardV2?.data.character_version).toBe('author-v2')
  expect(data.messages).toEqual([])
  expect(() => addCharacter(data, loaded)).toThrow('ID')
})

it('preserves unknown keys inside leivra, unsafe-looking inert keys and exact whitespace', () => {
  const raw = fixtureCardV2()
  const source = { ...raw, data: { ...raw.data, name: '  测试角色  ', personality: ' '.repeat(900), extensions: { ...raw.data.extensions, leivra: { schemaVersion: 1, id: 'fixed', revision: 4, future: { keep: true }, preferences: { maxReplyMessages: 3, temperature: 0.5 } }, ...JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"x":1}}}') } } }
  const card = importCharacter(JSON.stringify(source))
  expect(JSON.parse(exportCharacter(card))).toEqual(source)
  expect(Object.hasOwn({}, 'polluted')).toBe(false)
  const { id: _id, revision: _revision, schemaVersion: _schema, ...fields } = card
  const data = editCharacter(addCharacter(createInitialData([]), card), card.id, { ...fields, name: '新名' })
  expect(data.characters[1].sourceCardV2?.data.extensions.leivra).toMatchObject({ future: { keep: true }, revision: 5 })
  expect(data.characters[1].personality).toEqual([' '.repeat(900)])
})

it('rejects missing core fields, malformed types, versions, excessive depth, sizes and non-JSON values', () => {
  for (const key of ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example']) {
    const raw: Record<string, unknown> = { ...fixtureCardV2().data }; delete raw[key]
    expect(() => importCharacter(JSON.stringify({ ...fixtureCardV2(), data: raw }))).toThrow()
  }
  for (const changes of [{ personality: [] }, { name: '' }, { description: 'x'.repeat(8001) }, { extensions: [] }, { character_book: [] }, { tags: [1] }, { extensions: { leivra: { schemaVersion: 2 } } }, { extensions: { leivra: { schemaVersion: 1, avatar: 'https://example.invalid/a.png' } } }, { extensions: { leivra: { schemaVersion: 1, preferences: { temperature: 99 } } } }]) {
    expect(() => importCharacter(JSON.stringify({ ...fixtureCardV2(), data: { ...fixtureCardV2().data, ...changes } }))).toThrow()
  }
  expect(() => importCharacter('{broken')).toThrow('JSON')
  expect(() => importCharacter(JSON.stringify({ ...fixtureCardV2(), spec_version: '3.0' }))).toThrow()
  expect(() => importCharacter(JSON.stringify({ ...fixtureCardV2(), extra: '字'.repeat(90000) }))).toThrow('256')
  let deep: unknown = {}; for (let i = 0; i < 20; i++) deep = { deep }
  expect(() => validateCardV2({ ...fixtureCardV2(), deep })).toThrow('嵌套')
  for (const extra of [Infinity, undefined, () => 1, new Date(), Array(1001).fill(1)]) expect(() => validateCardV2({ ...fixtureCardV2(), extra })).toThrow()
})

it('does not trust a divergent runtime projection or lose source data when editor omits it', () => {
  const card = importCharacter(JSON.stringify(fixtureCardV2()))
  expect(() => validateCharacter({ ...card, name: 'forged' })).toThrow('不一致')
  expect(() => validateCharacter({ ...card, preferences: { temperature: 0.9 } })).toThrow('不一致')
  for (const preferences of [null, [], { model: 'untrusted' }]) {
    const forged = structuredClone(card)
    Object.assign(forged.sourceCardV2!.data.extensions.leivra as object, { preferences })
    expect(() => validateCharacter(forged)).toThrow()
  }
  const { id, revision: _revision, schemaVersion: _schema, sourceCardV2: _source, ...fields } = card
  const data = editCharacter(addCharacter(createInitialData([]), card), id, { ...fields, name: '改名' })
  expect(data.characters[1].sourceCardV2?.data.character_book).toEqual(fixtureCardV2().data.character_book)
})

it('preserves supported empty strings and defaults missing extensions without loading resources', () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('must not fetch'))
  try {
    const raw: Record<string, unknown> = { ...fixtureCardV2().data, personality: '' }; delete raw.extensions
    const card = importCharacter(JSON.stringify({ ...fixtureCardV2(), data: raw }))
    expect(card.personality).toEqual([])
    expect(importCharacter(exportCharacter(card)).id).toBe(card.id)
    expect(fetcher).not.toHaveBeenCalled()
  } finally { fetcher.mockRestore() }
})

it('roundtrips a compact V2 card at the byte limit without inflating its export', () => {
  const raw = fixtureCardV2()
  const source = { ...raw, padding: '', data: { ...raw.data, extensions: { leivra: { schemaVersion: 1, id: 'bounded', revision: 1 } } } }
  source.padding = 'x'.repeat(CARD_LIMIT_BYTES - new TextEncoder().encode(JSON.stringify(source)).length)
  const card = importCharacter(JSON.stringify(source))
  expect(new TextEncoder().encode(exportCharacter(card)).length).toBe(CARD_LIMIT_BYTES)
  expect(importCharacter(exportCharacter(card))).toEqual(card)
})

it('reports a corrupt persisted V2 source without overwriting data or falling back to the default', () => {
  const data = addCharacter(createInitialData([]), importCharacter(JSON.stringify(fixtureCardV2())))
  data.characters[1].sourceCardV2!.data.personality = '损坏后与投影不一致'
  const raw = JSON.stringify(data), setItem = vi.fn(), removeItem = vi.fn()
  expect(() => loadData({ getItem: key => key === DATA_STORAGE_KEY ? raw : null, setItem, removeItem })).toThrow('不一致')
  expect(setItem).not.toHaveBeenCalled(); expect(removeItem).not.toHaveBeenCalled()
})
