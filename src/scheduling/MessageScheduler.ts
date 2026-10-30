import { newId } from '../ids'
import { replyDelayMs, validateModelOutput } from '../reply'
import type { Message, ModelOutput } from '../models'
import { DEFAULT_CHAT_SETTINGS, validateChatSettings, type ChatSettings, type ValidatedChatSettings } from './settings'

export type ConversationPhase = 'Idle' | 'Collecting' | 'Generating' | 'Dispatching'
export const MODE_SWITCH_ERROR = '回复模式已更换，待处理消息未自动发送。可手动重试回复。'
export const BACKUP_RESTORE_ERROR = '已恢复备份，待回复任务已暂停。确认需要生成后可手动重试回复。'
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
  pauseReason?: 'mode-switch' | 'backup-restore'
}
interface Options {
  conversationId: string
  characterId: string
  settings?: ChatSettings
  restored?: SchedulerSnapshot
  timeoutMs?: number
  generate(messages: readonly Message[], requestId: string, signal: AbortSignal): Promise<ModelOutput>
  // Resolve only after the full snapshot and optional emitted message are durably committed.
  commit(snapshot: SchedulerSnapshot, emitted?: Message, ignoredMessageIds?: readonly string[]): void | Promise<void>
  delayMs?(text: string): number
}
export const MAX_PENDING_MESSAGES = 100
export const MAX_PENDING_CHARACTERS = 64000
export const REQUEST_TIMEOUT_MS = 65000

export class MessageScheduler {
  private state: SchedulerSnapshot
  private settings: ValidatedChatSettings
  private timer?: ReturnType<typeof setTimeout>
  private timeout?: ReturnType<typeof setTimeout>
  private request?: AbortController
  private generation = 0
  private lastInputAt = 0
  private closed = false
  private paused = false
  private requestStarted = false
  private ignoring = false
  private writes: Promise<void> | null = null
  constructor(private options: Options) {
    this.settings = validateChatSettings(options.settings ?? DEFAULT_CHAT_SETTINGS)
    this.state = structuredClone(options.restored ?? {
      conversationId: options.conversationId, characterId: options.characterId,
      phase: 'Idle', pending: [], lastSentAt: 0
    })
    if (this.state.error === MODE_SWITCH_ERROR) this.state.pauseReason = 'mode-switch'
    // A restored active turn may already have reached the provider. Keep it separate.
    this.requestStarted = Boolean(options.restored?.active)
    if (this.state.phase === 'Generating') {
      this.state.phase = 'Idle'
      this.state.error = this.state.pauseReason === 'mode-switch' ? MODE_SWITCH_ERROR : '上次生成已中断，未自动重发。可手动重试回复。'
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
    const collecting = this.state.active && !this.requestStarted ? [...this.state.active.messages, ...this.state.pending] : this.state.pending
    if (collecting.length >= MAX_PENDING_MESSAGES || collecting.reduce((n,m)=>n+m.text.length,0) + message.text.length > MAX_PENDING_CHARACTERS) throw new Error('待回复消息过多，请稍候再发送。')
    this.requeueBeforeRequest()
    this.state.pending.push(structuredClone(message))
    this.state.lastSentAt = Date.now()
    if (!this.state.active) this.state.phase = 'Collecting'
    if (!await this.commit(message)) {
      // The history transaction did not commit. Do not leave an orphan in the queue.
      this.state.pending = this.state.pending.filter(item => item.id !== message.id)
      if (this.state.active && !this.requestStarted) {
        this.state.active.messages = this.state.active.messages.filter(item => item.id !== message.id)
        if (!this.state.active.messages.length) this.state.active = undefined
      }
      return false
    }
    if (!this.closed) this.schedule()
    return true
  }
  inputActivity() {
    if (this.closed || !this.settings.deferWhileTyping || (!this.state.pending.length && !(this.state.active && !this.requestStarted))) return
    this.lastInputAt = Date.now()
    if (this.requeueBeforeRequest()) {
      void this.commit().then(saved => { if (saved) this.schedule() })
    } else this.schedule()
  }
  configure(settings: ChatSettings) {
    this.settings = validateChatSettings(settings)
    if (this.requeueBeforeRequest()) {
      void this.commit().then(saved => { if (saved) this.schedule() })
    } else this.schedule()
  }
  async retry() {
    if (this.closed || !this.state.error) return
    this.state.error = undefined; this.state.pauseReason = undefined; this.paused = false
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
  async ignoreModeSwitch() {
    if (this.closed || this.ignoring || this.state.pauseReason !== 'mode-switch') return false
    this.ignoring = true
    const previous = this.snapshot()
    const ignored = [...this.state.pending, ...(this.state.active?.output ? [] : this.state.active?.messages ?? [])].map(message => message.id)
    const next = this.snapshot()
    next.pending = []
    if (!next.active?.output) next.active = undefined
    next.phase = next.active ? 'Dispatching' : 'Idle'
    next.error = undefined
    next.pauseReason = undefined
    clearTimeout(this.timer)
    const saved = await this.commit(undefined, ignored, next)
    if (!saved || this.closed) {
      this.state = previous
      this.paused = false
      if (previous.phase === 'Dispatching') this.scheduleDispatch()
      this.ignoring = false
      return false
    }
    this.state = next
    if (!next.active) { this.generation++; this.requestStarted = false }
    else this.scheduleDispatch()
    this.ignoring = false
    return true
  }
  dispose() {
    this.closed = true; this.generation++
    clearTimeout(this.timer); clearTimeout(this.timeout)
    this.request?.abort()
  }
  private requeueBeforeRequest(): boolean {
    if (!this.state.active || this.requestStarted || this.state.active.output) return false
    this.generation++ // Invalidates a Generating snapshot awaiting storage confirmation.
    this.state.pending = [...this.state.active.messages, ...this.state.pending]
    this.state.active = undefined
    this.state.phase = 'Collecting'
    return true
  }
  private commit(emitted?: Message, ignoredMessageIds?: readonly string[], replacement?: SchedulerSnapshot): Promise<boolean> {
    if (this.closed) return Promise.resolve(false)
    const snapshot = replacement ?? this.snapshot()
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
        const result = this.options.commit(snapshot, emitted, ignoredMessageIds)
        if (!result || typeof result.then !== 'function') return Promise.resolve(true)
        this.writes = result
      } else {
        this.writes = this.writes.then(() => {
          if (this.closed) throw new Error('会话已关闭。')
          return this.options.commit(snapshot, emitted, ignoredMessageIds)
        })
      }
      const operation = this.writes
      void operation.finally(() => { if (this.writes === operation) this.writes = null }).catch(() => {})
      return operation.then(() => true, fail)
    } catch { return Promise.resolve(fail()) }
  }
  private deadline() {
    const base = this.state.lastSentAt + this.settings.replyWaitMs
    const firstSentAt = Math.min(...this.state.pending.map(message => message.createdAt))
    const quietUntil = this.settings.deferWhileTyping ? Math.max(base, this.lastInputAt + this.settings.replyWaitMs) : base
    return this.settings.maxWaitMs === null ? quietUntil : Math.min(firstSentAt + this.settings.maxWaitMs, quietUntil)
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
      const generation = this.options.generate(structuredClone(active.messages), active.requestId ?? active.id, request.signal)
      this.requestStarted = true
      const output = await Promise.race([generation, timeout])
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
    })) {
      // Subsequent queued commits also fail; retry this same bubble and stable ID.
      active.nextIndex = index
      return
    }
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
    this.requestStarted = false
    if (this.state.error && this.state.pending.length) {
      this.state.active = { id: newId(), messages: this.state.pending, nextIndex: 0 }
      this.state.pending = []; this.state.phase = 'Idle'; await this.commit(); return
    }
    this.state.error = undefined
    this.state.pauseReason = undefined
    this.state.phase = this.state.pending.length ? 'Collecting' : 'Idle'
    if (await this.commit()) this.schedule()
  }
}
