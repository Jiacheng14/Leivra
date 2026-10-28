import { expect, it } from 'vitest'
import { createInitialData, validateData } from '../storage'
import { validateChatSettings } from './settings'

it('defaults old stored settings to five minutes and round-trips unlimited as null', () => {
  const legacy = createInitialData([])
  legacy.chatSettings = { replyWaitMs: 3500, deferWhileTyping: true }
  expect(validateData(JSON.parse(JSON.stringify(legacy))).chatSettings?.maxWaitMs).toBe(300000)
  legacy.chatSettings = { replyWaitMs: 3500, deferWhileTyping: true, maxWaitMs: null }
  expect(validateData(JSON.parse(JSON.stringify(legacy))).chatSettings?.maxWaitMs).toBeNull()
  expect(validateChatSettings({ replyWaitMs: 1000, deferWhileTyping: false, maxWaitMs: 90000 }).maxWaitMs).toBe(90000)
  expect(() => validateChatSettings({ replyWaitMs: 1000, deferWhileTyping: false, maxWaitMs: 61000 })).toThrow()
})
