import { describe, expect, it, vi } from 'vitest'
import { decodeMessages, createInitialData } from './storage'
import { mockProvider, validateModelOutput } from './chat'
import { defaultMockReply } from './characters/defaultLeivra'
import { createMessage } from './models'
import { buildPrompt } from './prompt'

function request() {
  const data = createInitialData([])
  return buildPrompt({ character: data.characters[0], conversation: data.conversations[0], recentMessages: [], currentMessage: createMessage(data.conversations[0], 'user', '你好') })
}
describe('prototype persistence', () => {
  it('distinguishes first launch from an intentionally cleared history', () => {
    expect(decodeMessages(null)).toBeNull()
    expect(decodeMessages('[]')).toEqual([])
  })
  it('rejects corrupted and unsafe records', () => {
    expect(() => decodeMessages('{broken')).toThrow()
    expect(() => decodeMessages('[{"role":"system"}]')).toThrow()
    expect(() => decodeMessages(JSON.stringify([{id:'x',role:'user',text:'a',createdAt:1e100}]))).toThrow()
  })
  it('retains the most recent 500 messages in order', () => {
    const rows = Array.from({length: 501}, (_, i) => ({id:String(i),role:'user',text:'hello',createdAt:1}))
    expect(decodeMessages(JSON.stringify(rows))?.[0].id).toBe('1')
  })
})
describe('mock provider', () => {
  it('retains the existing default contact replies', () => {
    expect(defaultMockReply('今天好累')).toHaveLength(2)
    expect(defaultMockReply('晚安')[1]).toContain('晚安')
  })
  it('cancels in-flight replies when a chat is cleared', async () => {
    vi.useFakeTimers()
    try {
      const controller = new AbortController()
      const result = mockProvider.reply(request(), controller.signal)
      controller.abort()
      await expect(result).rejects.toMatchObject({name:'AbortError'})
    } finally { vi.useRealTimers() }
  })
  it('resolves after the simulated typing delay with validated output', async () => {
    vi.useFakeTimers()
    try {
      const result = mockProvider.reply(request(), new AbortController().signal)
      await vi.runAllTimersAsync()
      expect((await result).messages).toHaveLength(2)
    } finally { vi.useRealTimers() }
  })
  it('allows a single message and rejects unsafe/unstructured output', () => {
    expect(validateModelOutput({messages:['一条消息']})).toEqual({messages:['一条消息']})
    for (const value of [{messages:[]}, {messages:['']}, ['hello'], {messages:['x'],action:'run'}, {messages:Array(33).fill('x')}, {messages:['x'.repeat(32001)]}]) expect(() => validateModelOutput(value)).toThrow()
  })
  it('keeps legacy card preferences without forcing the reply count', async () => {
    vi.useFakeTimers()
    try {
      const r = request()
      const result = mockProvider.reply({...r,preferences:{maxReplyMessages:1}}, new AbortController().signal)
      await vi.runAllTimersAsync()
      expect((await result).messages).toHaveLength(2)
    } finally { vi.useRealTimers() }
  })
})
