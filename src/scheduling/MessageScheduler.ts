import { newId } from '../ids'
import { replyDelayMs, validateModelOutput } from '../reply'
import type { Message, ModelOutput } from '../models'
import { DEFAULT_CHAT_SETTINGS, INPUT_ACTIVITY_GRACE_MS, MAX_TYPING_EXTENSION_MS, validateChatSettings, type ChatSettings } from './settings'

export type ConversationPhase = 'Idle' | 'Collecting' | 'Generating' | 'Dispatching'
export interface ActiveTurn {
  id: string
  // The round ID stays stable. A deliberate retry gets a new request ID.
  requestId?: string
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
  generate(messages: readonly Message[], requestId: string, signal: AbortSignal): Promise<ModelOutput>
  // Resolve only after the full snapshot and optional emitted message are durably committed.
  commit(snapshot: SchedulerSnapshot, emitted?: Message): void | Promise<void>
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
  private paused = false
  private writes: Promise<void> | null = null
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
  async start() {
    if (!await this.commit() || this.closed) return
    if (this.state.phase === 'Dispatching') this.scheduleDispatch()
    else this.schedule()
  }
  async enqueue(message: Message) {
    if (this.closed) throw new Error('会话已关闭。')
    if (message.role !== 'user' || message.characterId !== this.state.characterId || message.conversationId !== this.state.conversationId) throw new Error('消息与会话不匹配。')
    if ([...this.state.pending, ...(this.state.active?.messages ?? [])].some(m => m.id === message.id)) throw new Error('消息已进入调度队列。')
    if (this.state.pending.length >= MAX_PENDING_MESSAGES || this.state.pending.reduce((n,m)=>n+m.text.length,0) + message.text.length > MAX_PENDING_CHARACTERS) throw new Error('待回复消息过多，请稍候再发送。')
    this.state.pending.push(structuredClone(message))
    this.state.lastSentAt = Date.now()
    if (!this.state.active) this.state.phase = 'Collecting'
    if (!await this.commit(message)) return false
    if (!this.closed) this.schedule()
    return true
  }
  inputActivity() {
    if (this.closed || !this.settings.deferWhileTyping || !this.state.pending.length) return
    this.lastInputAt = Date.now(); this.schedule()
  }
  configure(settings: ChatSettings) {
    this.settings = validateChatSettings(settings); this.schedule()
  }
  async retry() {
    if (this.closed || !this.state.error) return
    this.state.error = undefined; this.paused = false
    if (!this.state.active) {
      if (await this.commit()) this.schedule()
    } else if (this.state.active.output) {
      this.state.phase = 'Dispatching'
      if (await this.commit()) this.scheduleDispatch()
    } else {
      this.state.active.requestId = newId()
      await this.generate()
    }
  }
  dispose() {
    this.closed = true; this.generation++
    clearTimeout(this.timer); clearTimeout(this.timeout)
    this.request?.abort()
  }
  private commit(emitted?: Message): Promise<boolean> {
    const snapshot = this.snapshot()
    const fail = () => {
      if (!this.closed) {
        this.paused = true
        this.state.phase = 'Idle'
        this.state.error = '本地保存失败，回复已暂停。请检查浏览器存储后手动重试。'
      }
      return false as const
    }
    try {
      if (!this.writes) {
        const result = this.options.commit(snapshot, emitted)
        if (!result || typeof result.then !== 'function') return Promise.resolve(true)
        this.writes = result
      } else {
        this.writes = this.writes.then(() => this.options.commit(snapshot, emitted))
      }
      const operation = this.writes
      void operation.finally(() => { if (this.writes === operation) this.writes = null }).catch(() => {})
      return operation.then(() => true, fail)
    } catch { return Promise.resolve(fail()) }
  }
  private deadline() {
    const base = this.state.lastSentAt + this.settings.replyWaitMs
    return this.settings.deferWhileTyping ? Math.min(base + MAX_TYPING_EXTENSION_MS, Math.max(base, this.lastInputAt + INPUT_ACTIVITY_GRACE_MS)) : base
  }
  private schedule() {
    if (this.closed || this.paused || this.state.error || this.state.active || !this.state.pending.length) return
    clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      if (this.closed || this.paused || this.state.active) return
      this.state.active = { id: newId(), messages: this.state.pending, nextIndex: 0 }
      this.state.pending = []
      void this.generate()
    }, Math.max(0, this.deadline() - Date.now()))
  }
  private async generate() {
    const active = this.state.active!
    const token = ++this.generation
    this.state.phase = 'Generating'; this.state.error = undefined
    // This is the no-request-before-durable-state barrier, including async stores.
    if (!await this.commit() || this.closed || token !== this.generation) return
    const request = new AbortController(); this.request = request
    try {
      const timeout = new Promise<never>((_, reject) => {
        this.timeout = setTimeout(() => { request.abort(); reject(new Error('回复请求超时，请手动重试。')) }, this.options.timeoutMs ?? REQUEST_TIMEOUT_MS)
      })
      const output = await Promise.race([this.options.generate(structuredClone(active.messages), active.requestId ?? active.id, request.signal), timeout])
      if (this.closed || token !== this.generation) return
      clearTimeout(this.timeout)
      active.output = validateModelOutput(output).messages; active.nextIndex = 0
      this.state.phase = 'Dispatching'
      await this.dispatch()
    } catch (error) {
      if (this.closed || token !== this.generation) return
      this.state.phase = 'Idle'
      this.state.error = error instanceof Error ? error.message : '回复失败，请手动重试。'
      await this.commit()
    } finally {
      if (token === this.generation) { clearTimeout(this.timeout); this.request = undefined }
    }
  }
  private async dispatch() {
    if (this.closed || this.paused || this.state.phase !== 'Dispatching') return
    const active = this.state.active!
    const text = active.output![active.nextIndex]
    if (text === undefined) { await this.finish(); return }
    const index = active.nextIndex++
    if (!await this.commit({
      id: active.id + '-' + index, conversationId: this.state.conversationId,
      characterId: this.state.characterId, role: 'assistant', text, createdAt: Date.now()
    })) return
    this.scheduleDispatch()
  }
  private scheduleDispatch() {
    if (this.closed || this.paused) return
    const active = this.state.active!
    if (active.nextIndex >= active.output!.length) { void this.finish(); return }
    clearTimeout(this.timer)
    this.timer = setTimeout(() => { void this.dispatch() }, (this.options.delayMs ?? replyDelayMs)(active.output![active.nextIndex]))
  }
  private async finish() {
    this.state.active = undefined
    if (this.state.error && this.state.pending.length) {
      this.state.active = { id: newId(), messages: this.state.pending, nextIndex: 0 }
      this.state.pending = []; this.state.phase = 'Idle'; await this.commit(); return
    }
    this.state.error = undefined
    this.state.phase = this.state.pending.length ? 'Collecting' : 'Idle'
    if (await this.commit()) this.schedule()
  }
}
