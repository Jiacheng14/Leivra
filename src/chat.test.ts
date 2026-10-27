import { describe, expect, it, vi } from 'vitest'
import { decodeMessages } from './storage'
import { mockProvider, mockReply } from './chat'
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
  it('responds naturally with multiple messages', () => {
    expect(mockReply('今天好累')).toHaveLength(2)
    expect(mockReply('晚安')[1]).toContain('晚安')
  })
  it('cancels in-flight replies when a chat is cleared', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const result = mockProvider.reply([], controller.signal)
    controller.abort()
    await expect(result).rejects.toMatchObject({name:'AbortError'})
    vi.useRealTimers()
  })
  it('resolves after the simulated typing delay', async () => {
    vi.useFakeTimers()
    const result = mockProvider.reply([], new AbortController().signal)
    await vi.runAllTimersAsync()
    await expect(result).resolves.toHaveLength(2)
    vi.useRealTimers()
  })
})
