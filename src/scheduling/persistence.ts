import type { Conversation, Message } from '../models'
import { MAX_LENGTH } from '../models'
import { record, stableId, text, timestamp, unique } from '../validation'
import { validateModelOutput } from '../reply'
import { MAX_PENDING_CHARACTERS, MAX_PENDING_MESSAGES, type SchedulerSnapshot, type ConversationPhase } from './MessageScheduler'
export function validateSnapshots(value: unknown, conversations: Conversation[]): SchedulerSnapshot[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > conversations.length) throw new Error('调度数据格式错误。')
  const snapshots = value.map(item => {
    const v = record(item)
    const conversationId = stableId(v.conversationId), characterId = stableId(v.characterId)
    if (!conversations.some(c => c.id === conversationId && c.characterId === characterId)) throw new Error('调度数据所属会话错误。')
    function batch(value: unknown): Message[] {
      if (!Array.isArray(value) || value.length > MAX_PENDING_MESSAGES) throw new Error('调度消息组错误。')
      const messages = value.map(item => {
        const m = record(item)
        if (m.role !== 'user' || m.conversationId !== conversationId || m.characterId !== characterId) throw new Error('调度消息所属会话错误。')
        return { id: stableId(m.id), conversationId, characterId, role: 'user' as const, text: text(m.text, '消息', MAX_LENGTH, true), createdAt: timestamp(m.createdAt) }
      })
      if (messages.reduce((n,m)=>n+m.text.length,0)>MAX_PENDING_CHARACTERS) throw new Error('调度消息组过长。')
      return messages
    }
    if (!['Idle','Collecting','Generating','Dispatching'].includes(String(v.phase))) throw new Error('调度状态错误。')
    const result: SchedulerSnapshot = { conversationId, characterId, phase: v.phase as ConversationPhase, pending: batch(v.pending), lastSentAt: timestamp(v.lastSentAt) }
    if (v.providerId !== undefined) result.providerId = stableId(v.providerId)
    if (v.error !== undefined) result.error = text(v.error, '错误信息', 500, true)
    if (v.pauseReason !== undefined) {
      if (v.pauseReason !== 'mode-switch' && v.pauseReason !== 'backup-restore') throw new Error('暂停原因格式错误。')
      result.pauseReason = v.pauseReason
    }
    if (v.active !== undefined) {
      const a = record(v.active), messages = batch(a.messages)
      const output = a.output === undefined ? undefined : validateModelOutput({messages:a.output}).messages
      if (!messages.length || !Number.isSafeInteger(a.nextIndex) || Number(a.nextIndex)<0 || Number(a.nextIndex)>(output?.length ?? 0)) throw new Error('回复发送进度错误。')
      result.active = { id: stableId(a.id), ...(a.requestId === undefined ? {} : { requestId: stableId(a.requestId) }), messages, output, nextIndex: Number(a.nextIndex) }
    }
    unique([...result.pending, ...(result.active?.messages ?? [])].map(m=>m.id))
    if ((result.phase === 'Generating' || result.phase === 'Dispatching') && !result.active) throw new Error('调度缺少当前轮次。')
    if (result.phase === 'Dispatching' && !result.active?.output) throw new Error('调度缺少已生成回复。')
    if (result.phase === 'Collecting' && (result.active || !result.pending.length)) throw new Error('调度收集状态错误。')
    if (result.phase === 'Idle' && result.active && !result.error) throw new Error('调度中断状态错误。')
    return result
  })
  unique(snapshots.map(s=>s.conversationId))
  return snapshots
}
