import { afterEach, expect, it, vi } from 'vitest'
import { newId } from './ids'
import { createConversation, createMessage } from './models'
import { createInitialData } from './storage'

afterEach(() => vi.unstubAllGlobals())
it('initializes and creates stable-format IDs on an insecure HTTP origin', () => {
  const native = globalThis.crypto
  vi.stubGlobal('crypto', { getRandomValues: native.getRandomValues.bind(native) })
  const data = createInitialData([])
  const conversation = createConversation('another-character')
  const message = createMessage(conversation, 'user', 'hello')
  const ids = [data.conversations[0].id, conversation.id, message.id, ...Array.from({ length: 100 }, newId)]
  expect(new Set(ids).size).toBe(ids.length)
  for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
})
