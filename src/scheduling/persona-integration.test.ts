import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ConversationManager } from './ConversationManager'
import { createInitialData, validateData } from '../storage'
import { addCharacter, editCharacter, importCharacter } from '../characters/cards'
import { fixtureCardV2 } from '../../tests/fixtures/cardV2'
import type { Character, ModelProvider, ModelOutput } from '../models'
import type { ModelRequest } from '../prompt'

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(100000) })
afterEach(() => vi.useRealTimers())
function changes(card: Character, text: string) {
  const { id: _id, revision: _revision, schemaVersion: _schema, ...fields } = card
  return { ...fields, customPrompt: text }
}
it('takes latest card at generation, pins in-flight revisions and never persists rendered context', async () => {
  let data = addCharacter(createInitialData([]), importCharacter(JSON.stringify(fixtureCardV2())))
  const conversation = data.conversations[1], requests: ModelRequest[] = [], finish: ((output: ModelOutput) => void)[] = []
  const provider: ModelProvider = { id: 'test', reply: vi.fn<ModelProvider['reply']>(request => { requests.push(request); return new Promise(resolve => finish.push(resolve)) }) }
  const manager = new ConversationManager(provider, () => data, next => { data = validateData(next) })
  manager.start()
  await manager.send(conversation.id, '第一轮')
  data = editCharacter(data, conversation.characterId, changes(data.characters[1], 'PERSONA_REV2'))
  // UI activation is unrelated to which card a scheduled conversation resolves.
  data = { ...data, activeCharacterId: data.characters[0].id }
  await vi.advanceTimersByTimeAsync(3500)
  expect(requests[0].characterRevision).toBe(2)
  expect(requests[0].sections[1].content).toContain('PERSONA_REV2')
  data = editCharacter(data, conversation.characterId, changes(data.characters[1], 'PERSONA_REV3'))
  await manager.send(conversation.id, '下一轮')
  expect(requests[0].input.character.revision).toBe(2)
  finish[0]({ messages: ['第一轮回答'] })
  await vi.advanceTimersByTimeAsync(3500)
  expect(requests[1].characterRevision).toBe(3)
  expect(requests[1].sections[1].content).toContain('PERSONA_REV3')
  finish[1]({ messages: ['第二轮回答'] }); await vi.advanceTimersByTimeAsync(0)
  expect(data.messages.map(m => m.text)).toEqual(['第一轮', '下一轮', '第一轮回答', '第二轮回答'])
  for (const value of [data.messages, data.schedulerSnapshots]) expect(JSON.stringify(value)).not.toMatch(/PERSONA_REV|SYSTEM_SENTINEL|BOOK_SENTINEL/)
  manager.dispose()
})

it('keeps V2 errors recoverable without silent fallback, automatic retry or changing queues', async () => {
  let data = addCharacter(createInitialData([]), importCharacter(JSON.stringify(fixtureCardV2())))
  const id = data.conversations[1].id
  const provider: ModelProvider = { id: 'test', reply: vi.fn().mockRejectedValueOnce(new Error('模型服务暂时不可用')).mockResolvedValueOnce({ messages: ['重试回答'] }) }
  const manager = new ConversationManager(provider, () => data, next => { data = validateData(next) })
  manager.start(); await manager.send(id, '保留问题')
  await vi.advanceTimersByTimeAsync(3500)
  expect(manager.peek(id)?.snapshot().error).toContain('模型服务')
  await vi.advanceTimersByTimeAsync(30000)
  expect(provider.reply).toHaveBeenCalledTimes(1)
  expect(data.messages.map(m => m.text)).toEqual(['保留问题'])
  await manager.get(id).retry()
  expect(provider.reply).toHaveBeenCalledTimes(2)
  expect(data.messages.map(m => m.text)).toEqual(['保留问题', '重试回答'])
  manager.dispose()
})

it('stops before provider invocation when the current card cannot be loaded consistently', async () => {
  let data = addCharacter(createInitialData([]), importCharacter(JSON.stringify(fixtureCardV2())))
  const id = data.conversations[1].id
  const provider: ModelProvider = { id: 'test', reply: vi.fn(async () => ({ messages: ['must not happen'] })) }
  const manager = new ConversationManager(provider, () => data, next => { data = next })
  manager.start(); await manager.send(id, '保存的问题')
  data.characters[1] = { ...data.characters[1], name: '与源卡不一致' }
  await vi.advanceTimersByTimeAsync(3500)
  expect(manager.peek(id)?.snapshot().error).toContain('不一致')
  expect(provider.reply).not.toHaveBeenCalled()
  expect(data.messages.map(m => m.text)).toEqual(['保存的问题'])
  manager.dispose()
})
