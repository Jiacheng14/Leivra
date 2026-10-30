import { conversationMessages, createMessage, type LocalData, type ModelProvider } from '../models'
import { buildPrompt } from '../prompt'
import { appendMessages } from '../storage'
import { newId } from '../ids'
import { MessageScheduler, MODE_SWITCH_ERROR } from './MessageScheduler'
import { DEFAULT_CHAT_SETTINGS, validateChatSettings, type ChatSettings } from './settings'
export class ConversationManager {
  private schedulers = new Map<string, MessageScheduler>()
  constructor(private provider: ModelProvider, private read: () => LocalData, private write: (data: LocalData, durableFirst?: boolean) => void | Promise<void>, private mutate?: (update: (data: LocalData) => LocalData, durableFirst?: boolean) => Promise<void>) {}
  start() { for (const c of this.read().conversations) this.get(c.id) }
  peek(id: string) { return this.schedulers.get(id) }
  get(id: string): MessageScheduler {
    const existing = this.schedulers.get(id)
    if (existing) return existing
    const data = this.read(), conversation = data.conversations.find(c=>c.id===id)
    if (!conversation) throw new Error('会话不存在。')
    const restored = structuredClone(data.schedulerSnapshots?.find(s=>s.conversationId===id))
    if (restored?.providerId && restored.providerId !== this.provider.id && restored.pauseReason !== 'backup-restore') {
      if (restored.phase === 'Collecting') {
        restored.active = {id:newId(),messages:restored.pending,nextIndex:0}
        restored.pending=[];restored.phase='Idle'
      }
      if (restored.active) { restored.error=MODE_SWITCH_ERROR; restored.pauseReason='mode-switch' }
    }
    const scheduler: MessageScheduler = new MessageScheduler({
      conversationId: id, characterId: conversation.characterId,
      settings: data.chatSettings ?? DEFAULT_CHAT_SETTINGS,
      restored,
      generate: (currentMessages, turnId, signal) => {
        const current = this.read(), character = current.characters.find(c=>c.id===conversation.characterId)
        if (!character) throw new Error('联系人已删除。')
        const pending = new Set(scheduler.snapshot().pending.map(m=>m.id))
        return this.provider.reply(buildPrompt({ character, conversation, turnId, currentMessages,
          recentMessages: conversationMessages(current, conversation).filter(m=>!pending.has(m.id)) }), signal)
      },
      commit: (snapshot, emitted, ignoredMessageIds) => {
        const update = (data: LocalData) => {
          let current = data
          if (!current.conversations.some(c=>c.id===id)) throw new Error('会话已关闭。')
          if (emitted) current = appendMessages(current, conversation, [emitted])
          if (ignoredMessageIds) {
            const ignored = new Set(ignoredMessageIds)
            current = { ...current, messages: current.messages.map(message => ignored.has(message.id) && message.conversationId === id && message.role === 'user' ? { ...message, replyIgnored: true } : message) }
          }
          return { ...current, schedulerSnapshots: [...(current.schedulerSnapshots ?? []).filter(s=>s.conversationId!==id), {...snapshot,providerId:this.provider.id}] }
        }
        return this.mutate ? this.mutate(update, ignoredMessageIds !== undefined) : this.write(update(this.read()), ignoredMessageIds !== undefined)
      }
    })
    this.schedulers.set(id, scheduler)
    scheduler.start()
    return scheduler
  }
  async send(id: string, text: string) {
    const conversation = this.read().conversations.find(c=>c.id===id)
    if (!conversation) throw new Error('会话不存在。')
    return this.get(id).enqueue(createMessage(conversation, 'user', text))
  }
  configure(value: ChatSettings): Promise<void> {
    const settings = validateChatSettings(value)
    if (this.mutate) return this.mutate(data => ({ ...data, chatSettings: settings }), true).then(() => {
      for (const scheduler of this.schedulers.values()) scheduler.configure(settings)
    })
    const result = this.write({ ...this.read(), chatSettings: settings }, true)
    for (const scheduler of this.schedulers.values()) scheduler.configure(settings)
    return Promise.resolve(result)
  }
  cancel(id: string) { this.schedulers.get(id)?.dispose(); this.schedulers.delete(id) }
  dispose() { for (const scheduler of this.schedulers.values()) scheduler.dispose(); this.schedulers.clear() }
}
