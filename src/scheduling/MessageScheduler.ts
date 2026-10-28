import { replyDelayMs, validateModelOutput } from '../reply'
import type { Message, ModelOutput } from '../models'
import { DEFAULT_CHAT_SETTINGS, INPUT_ACTIVITY_GRACE_MS, MAX_TYPING_EXTENSION_MS, validateChatSettings, type ChatSettings } from './settings'
export type ConversationPhase = 'Idle' | 'Collecting' | 'Generating' | 'Dispatching'
export interface ActiveTurn {
  id: string
  messages: Message[]
  output?: string[]
  nextIndex: number
}
export interface SchedulerSnapshot {
  providerId?: string
  conversationId: string
  characterId: string
  phase: ConversationPhase
  pending: Message[]
  lastSentAt: number
  active?: ActiveTurn
  error?: string
}
interface Options {
  conversationId: string
  characterId: string
  settings?: ChatSettings
  restored?: SchedulerSnapshot
  timeoutMs?: number
  generate(messages: readonly Message[], turnId: string, signal: AbortSignal): Promise<ModelOutput>
  // State and an emitted message must be committed together by the owner.
  commit(snapshot: SchedulerSnapshot, emitted?: Message): void
  delayMs?(text: string): number
}
export const MAX_PENDING_MESSAGES = 100
export const MAX_PENDING_CHARACTERS = 64000
export const REQUEST_TIMEOUT_MS = 65000
export class MessageScheduler {
  private state: SchedulerSnapshot
  private settings: ChatSettings
  private timer?: ReturnType<typeof setTimeout>
  private timeout?: ReturnType<typeof setTimeout>
  private request?: AbortController
  private generation = 0
  private lastInputAt = 0
  private closed = false
  constructor(private options: Options) {
    this.settings = validateChatSettings(options.settings ?? DEFAULT_CHAT_SETTINGS)
    this.state = structuredClone(options.restored ?? {
      conversationId: options.conversationId, characterId: options.characterId,
      phase: 'Idle', pending: [], lastSentAt: 0
    })
    if (this.state.phase === 'Generating') {
      this.state.phase = 'Idle'
      this.state.error = '上次生成已中断，未自动重发。可手动重试回复。'
    }
  }
  snapshot(): SchedulerSnapshot { return structuredClone(this.state) }
  start() {
    if (this.closed) return
    this.commit()
    if (this.state.phase === 'Dispatching') this.scheduleDispatch()
    else this.schedule()
  }
  enqueue(message: Message) {
    if (this.closed) throw new Error('会话已关闭。')
    if (message.role !== 'user' || message.characterId !== this.state.characterId || message.conversationId !== this.state.conversationId) throw new Error('消息与会话不匹配。')
    if ([...this.state.pending, ...(this.state.active?.messages ?? [])].some(m => m.id === message.id)) throw new Error('消息已进入调度队列。')
    if (this.state.pending.length >= MAX_PENDING_MESSAGES || this.state.pending.reduce((n,m)=>n+m.text.length,0) + message.text.length > MAX_PENDING_CHARACTERS) throw new Error('待回复消息过多，请稍候再发送。')
    this.state.pending.push(structuredClone(message))
    this.state.lastSentAt = Date.now()
    if (!this.state.active) this.state.phase = 'Collecting'
    this.commit(message)
    this.schedule()
  }
  inputActivity() {
    if (this.closed || !this.settings.deferWhileTyping || !this.state.pending.length) return
    this.lastInputAt = Date.now()
    this.schedule()
  }
  configure(settings: ChatSettings) {
    this.settings = validateChatSettings(settings)
    this.schedule()
  }
  retry() {
    if (this.closed || !this.state.error || !this.state.active) return
    this.state.error = undefined
    if (this.state.active.output) {
      this.state.phase = 'Dispatching'; this.commit(); this.scheduleDispatch()
    } else {
      // A manual retry is a new attempt; it never silently reuses a possibly charged request.
      this.state.active.id = crypto.randomUUID()
      void this.generate()
    }
  }
  dispose() {
    this.closed = true; this.generation++
    clearTimeout(this.timer); clearTimeout(this.timeout)
    this.request?.abort()
  }
  private commit(emitted?: Message) { this.options.commit(this.snapshot(), emitted) }
  private deadline() {
    const base = this.state.lastSentAt + this.settings.replyWaitMs
    return this.settings.deferWhileTyping ? Math.min(base + MAX_TYPING_EXTENSION_MS, Math.max(base, this.lastInputAt + INPUT_ACTIVITY_GRACE_MS)) : base
  }
  private schedule() {
    if (this.closed || this.state.active || !this.state.pending.length) return
    clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      if (this.closed || this.state.active) return
      this.state.active = { id: crypto.randomUUID(), messages: this.state.pending, nextIndex: 0 }
      this.state.pending = []
      void this.generate()
    }, Math.max(0, this.deadline() - Date.now()))
  }
  private async generate() {
    const active = this.state.active!
    const token = ++this.generation
    const request = new AbortController(); this.request = request
    this.state.phase = 'Generating'; this.state.error = undefined; this.commit()
    try {
      const timeout = new Promise<never>((_, reject) => {
        this.timeout = setTimeout(() => { request.abort(); reject(new Error('回复请求超时，请手动重试。')) }, this.options.timeoutMs ?? REQUEST_TIMEOUT_MS)
      })
      const output = await Promise.race([this.options.generate(structuredClone(active.messages), active.id, request.signal), timeout])
      if (this.closed || token !== this.generation) return
      clearTimeout(this.timeout)
      active.output = validateModelOutput(output).messages; active.nextIndex = 0
      this.state.phase = 'Dispatching'
      // First bubble is committed immediately along with its nextIndex.
      this.dispatch()
    } catch (error) {
      if (this.closed || token !== this.generation) return
      this.state.phase = 'Idle'
      this.state.error = error instanceof Error ? error.message : '回复失败，请手动重试。'
      this.commit()
    } finally {
      if (token === this.generation) { clearTimeout(this.timeout); this.request = undefined }
    }
  }
  private dispatch() {
    if (this.closed || this.state.phase !== 'Dispatching') return
    const active = this.state.active!
    const text = active.output![active.nextIndex]
    if (text === undefined) { this.finish(); return }
    const index = active.nextIndex++
    this.commit({
      id: active.id + '-' + index, conversationId: this.state.conversationId,
      characterId: this.state.characterId, role: 'assistant', text, createdAt: Date.now()
    })
    this.scheduleDispatch()
  }
  private scheduleDispatch() {
    if (this.closed) return
    const active = this.state.active!
    if (active.nextIndex >= active.output!.length) { this.finish(); return }
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.dispatch(), (this.options.delayMs ?? replyDelayMs)(active.output![active.nextIndex]))
  }
  private finish() {
    this.state.active = undefined
    if (this.state.error && this.state.pending.length) {
      this.state.active = {id:crypto.randomUUID(),messages:this.state.pending,nextIndex:0}
      this.state.pending=[];this.state.phase='Idle';this.commit();return
    }
    this.state.error=undefined
    this.state.phase = this.state.pending.length ? 'Collecting' : 'Idle'
    this.commit(); this.schedule()
  }
}
