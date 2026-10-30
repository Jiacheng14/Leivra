import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createInitialData, validateData } from '../storage'
import { createMessage, type LocalData, type ModelProvider } from '../models'
import { createBackup, parseBackup, prepareRestore } from '../backup'
import { ConversationManager } from './ConversationManager'
import { MessageScheduler } from './MessageScheduler'

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(100000) })
afterEach(() => vi.useRealTimers())

// Like useChat, publish only after a successful asynchronous durable write.
function setup(output: string[]) {
  let data = createInitialData([])
  let fail: (next: LocalData) => boolean = () => false
  let writes = Promise.resolve()
  const reply = vi.fn(async () => ({ messages: output }))
  const provider: ModelProvider = { id: 'offline-test', reply }
  const open = () => new ConversationManager(provider, () => data, () => { throw new Error('Use mutate') }, update => {
    const operation = writes.then(() => {
      const next = validateData(update(data))
      if (fail(next)) throw new Error('quota')
      data = next
    })
    writes = operation.catch(() => {})
    return operation
  })
  return { open, reply, read: () => data, fail: (predicate: typeof fail) => { fail = predicate },
    replace: (next: LocalData) => { data = validateData(next) } }
}

it.each([
  { output: ['only'], failed: 'only', index: 0 },
  { output: ['first', 'second', 'last'], failed: 'first', index: 0 },
  { output: ['first', 'second', 'last'], failed: 'second', index: 1 },
  { output: ['first', 'second', 'last'], failed: 'last', index: 2 },
])('retries the exact unsaved bubble $failed without a second request', async ({ output, failed, index }) => {
  const t = setup(output), manager = t.open(), id = t.read().conversations[0].id
  manager.start()
  t.fail(next => next.messages.some(m => m.role === 'assistant' && m.text === failed))
  await manager.send(id, 'question')
  await vi.advanceTimersByTimeAsync(20000)
  expect(manager.get(id).snapshot().active?.nextIndex).toBe(index)
  expect(t.read().messages.filter(m => m.role === 'assistant').map(m => m.text)).toEqual(output.slice(0, index))
  t.fail(() => false)
  await manager.get(id).retry()
  await vi.advanceTimersByTimeAsync(20000)
  expect(t.read().messages.filter(m => m.role === 'assistant').map(m => m.text)).toEqual(output)
  expect(new Set(t.read().messages.map(m => m.id)).size).toBe(t.read().messages.length)
  expect(t.reply).toHaveBeenCalledTimes(1)
  expect(t.read().schedulerSnapshots?.[0].active).toBeUndefined()
  manager.dispose()
})

it('removes failed enqueues so retry and resending work after storage recovers', async () => {
  const t = setup(['answer']), manager = t.open(), id = t.read().conversations[0].id
  manager.start(); await vi.advanceTimersByTimeAsync(0)
  t.fail(next => next.messages.some(m => m.role === 'user'))
  expect(await manager.send(id, 'draft')).toBe(false)
  expect(t.read().messages).toEqual([])
  expect(manager.get(id).snapshot().pending).toEqual([])
  await vi.advanceTimersByTimeAsync(10000)
  expect(t.reply).not.toHaveBeenCalled()
  t.fail(() => false)
  await manager.get(id).retry()
  expect(await manager.send(id, 'draft')).toBe(true)
  await vi.advanceTimersByTimeAsync(10000)
  expect(t.read().messages.map(m => m.text)).toEqual(['draft', 'answer'])
  expect(t.reply).toHaveBeenCalledTimes(1)
  manager.dispose()
})

it('keeps already saved messages when several queued sends fail', async () => {
  const t = setup(['answer']), manager = t.open(), id = t.read().conversations[0].id
  manager.start()
  await manager.send(id, 'saved')
  t.fail(next => next.messages.some(m => m.text.startsWith('failed')))
  const results = await Promise.all([manager.send(id, 'failed A'), manager.send(id, 'failed B')])
  expect(results).toEqual([false, false])
  expect(manager.get(id).snapshot().pending.map(m => m.text)).toEqual(['saved'])
  t.fail(() => false)
  await manager.get(id).retry()
  await vi.advanceTimersByTimeAsync(10000)
  expect(t.read().messages.map(m => m.text)).toEqual(['saved', 'answer'])
  manager.dispose()
})

it('does not execute a queued commit after the scheduler is disposed', async () => {
  const data = createInitialData([]), conversation = data.conversations[0]
  let release!: () => void
  const commit = vi.fn(() => new Promise<void>(resolve => { release = resolve }))
  const scheduler = new MessageScheduler({ conversationId: conversation.id, characterId: conversation.characterId,
    generate: vi.fn(async () => ({ messages: ['unused'] })), commit })
  const start = scheduler.start()
  const send = scheduler.enqueue(createMessage(conversation, 'user', 'queued'))
  scheduler.dispose(); release()
  await start
  expect(await send).toBe(false)
  expect(commit).toHaveBeenCalledTimes(1)
})

it.each(['Collecting', 'Generating', 'Dispatching'] as const)('pauses imported $phase work across reloads while preserving generated output', async phase => {
  const t = setup(['new answer'])
  const source = t.read(), conversation = source.conversations[0]
  const message = createMessage(conversation, 'user', 'old request')
  const pending = createMessage(conversation, 'user', 'queued request')
  source.messages = phase === 'Dispatching' ? [message, pending] : [message]
  source.schedulerSnapshots = [{ conversationId: conversation.id, characterId: conversation.characterId,
    providerId: 'offline-test', phase, lastSentAt: 1,
    pending: phase === 'Collecting' ? [message] : phase === 'Dispatching' ? [pending] : [],
    ...(phase === 'Collecting' ? {} : { active: { id: 'old-turn', messages: [message], nextIndex: 0,
      ...(phase === 'Dispatching' ? { output: ['already generated'] } : {}) } }) }]
  const backup = parseBackup(JSON.stringify(createBackup(source)))
  const original = structuredClone(backup)
  t.replace(prepareRestore(backup.data))
  expect(backup).toEqual(original)
  let manager = t.open(); manager.start()
  await vi.advanceTimersByTimeAsync(400000)
  expect(t.reply).not.toHaveBeenCalled()
  expect(t.read().schedulerSnapshots?.[0].pauseReason).toBe('backup-restore')
  if (phase === 'Dispatching') expect(t.read().messages.at(-1)?.text).toBe('already generated')
  manager.dispose()
  t.replace(JSON.parse(JSON.stringify(t.read())))
  manager = t.open(); manager.start()
  await vi.advanceTimersByTimeAsync(400000)
  expect(t.reply).not.toHaveBeenCalled()
  await manager.get(conversation.id).retry()
  await vi.advanceTimersByTimeAsync(10000)
  expect(t.reply).toHaveBeenCalledTimes(1)
  manager.dispose()
})
