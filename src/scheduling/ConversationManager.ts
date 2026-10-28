import { conversationMessages, createMessage, type LocalData, type ModelProvider } from '../models'
import { buildPrompt } from '../prompt'
import { appendMessages } from '../storage'
import { newId } from '../ids'
import { MessageScheduler } from './MessageScheduler'
import { DEFAULT_CHAT_SETTINGS, validateChatSettings, type ChatSettings } from './settings'
export class ConversationManager {
  private schedulers = new Map<string, MessageScheduler>()
  constructor(private provider: ModelProvider, private read: () => LocalData, private write: (data: LocalData) => void | Promise<void>) {}
  start() { for (const c of this.read().conversations) this.get(c.id) }
  peek(id: string) { return this.schedulers.get(id) }
  get(id: string): MessageScheduler {
    const existing = this.schedulers.get(id)
    if (existing) return existing
    const data = this.read(), conversation = data.conversations.find(c=>c.id===id)
    if (!conversation) throw new Error('会话不存在。')
    const restored = structuredClone(data.schedulerSnapshots?.find(s=>s.conversationId===id))
    if (restored?.providerId && restored.providerId !== this.provider.id) {
      if (restored.phase === 'Collecting') {
        restored.active = {id:newId(),messages:restored.pending,nextIndex:0}
        restored.pending=[];restored.phase='Idle'
      }
      if (restored.active) restored.error='回复模式已更换，待处理消息未自动发送。可手动重试回复。'
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
      commit: (snapshot, emitted) => {
        let current = this.read()
        if (!current.conversations.some(c=>c.id===id)) throw new Error('会话已关闭。')
        if (emitted) current = appendMessages(current, conversation, [emitted])
        return this.write({ ...current, schedulerSnapshots: [...(current.schedulerSnapshots ?? []).filter(s=>s.conversationId!==id), {...snapshot,providerId:this.provider.id}] })
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
  configure(value: ChatSettings) {
    const settings = validateChatSettings(value)
    this.write({ ...this.read(), chatSettings: settings })
    for (const scheduler of this.schedulers.values()) scheduler.configure(settings)
  }
  cancel(id: string) { this.schedulers.get(id)?.dispose(); this.schedulers.delete(id) }
  dispose() { for (const scheduler of this.schedulers.values()) scheduler.dispose(); this.schedulers.clear() }
}
