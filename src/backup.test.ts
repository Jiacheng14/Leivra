import { describe, expect, it } from 'vitest'
import { createBackup, parseBackup } from './backup'
import { createInitialData } from './storage'
import { createMessage } from './models'

describe('complete JSON backup', () => {
  it('roundtrips all messages, cards, settings and scheduling data without credentials', () => {
    const data = createInitialData([])
    const message = createMessage(data.conversations[0], 'user', '长文'.repeat(1000))
    data.messages.push(message)
    data.chatSettings = { replyWaitMs: 60000, deferWhileTyping: true, maxWaitMs: 300000 }
    data.theme = 'dark'
    data.schedulerSnapshots = [{ conversationId: message.conversationId, characterId: message.characterId, phase: 'Collecting', pending: [message], lastSentAt: message.createdAt }]
    const raw = JSON.stringify(createBackup(data))
    expect(parseBackup(raw).data).toEqual(data)
    expect(raw).not.toMatch(/apiKey|OPENAI_API_KEY|CLOUDFLARE_API_TOKEN/)
  })
  it('rejects damage, foreign links, missing content and unsupported versions', () => {
    const backup = createBackup(createInitialData([]))
    expect(() => parseBackup('{')).toThrow('JSON')
    expect(() => parseBackup(JSON.stringify({ ...backup, backupVersion: 2 }))).toThrow('版本')
    expect(() => parseBackup(JSON.stringify({ ...backup, data: { ...backup.data, messages: undefined } }))).toThrow()
    expect(() => parseBackup(JSON.stringify({ ...backup, data: { ...backup.data, messages: [{ id: 'bad', role: 'user', text: 'x', createdAt: 1, characterId: 'foreign', conversationId: backup.data.conversations[0].id }] } }))).toThrow()
    expect(() => parseBackup(JSON.stringify({ ...backup, data: { ...backup.data, unknown: true } }))).toThrow()
  })
})
