import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageScheduler, type SchedulerSnapshot } from './MessageScheduler'
import { createConversation, createMessage, type Message } from '../models'
import { DEFAULT_CHAT_SETTINGS } from './settings'

beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(100000)})
afterEach(()=>vi.useRealTimers())
function setup(overrides: Partial<ConstructorParameters<typeof MessageScheduler>[0]> = {}) {
  const conversation=createConversation('test')
  const emitted:Message[]=[]
  let saved:SchedulerSnapshot
  const generate=vi.fn(async()=>({messages:['回复']}))
  const scheduler=new MessageScheduler({conversationId:conversation.id,characterId:conversation.characterId,
    generate,commit:(state,m)=>{saved=state;if(m?.role === 'assistant')emitted.push(m)},...overrides})
  scheduler.start()
  return {scheduler,generate,emitted,conversation,saved:()=>saved}
}
describe('message collection',()=>{
  it('groups three separately sent messages once and resets the quiet timer',async()=>{
    const t=setup()
    for(const text of ['好烦','今天作业多','写不完']) {
      t.scheduler.enqueue(createMessage(t.conversation,'user',text))
      await vi.advanceTimersByTimeAsync(2000)
    }
    expect(t.generate).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1499);expect(t.generate).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(t.generate).toHaveBeenCalledTimes(1)
    expect(t.generate.mock.calls[0]).toBeDefined()
    expect(t.emitted).toHaveLength(1)
  })
  it('uses changed wait settings for an existing collection',async()=>{
    const t=setup();t.scheduler.enqueue(createMessage(t.conversation,'user','A'))
    await vi.advanceTimersByTimeAsync(500)
    t.scheduler.configure({...DEFAULT_CHAT_SETTINGS,replyWaitMs:1000})
    await vi.advanceTimersByTimeAsync(500)
    expect(t.generate).toHaveBeenCalledTimes(1)
  })
  it('ignores typing by default and caps optional typing deferral',async()=>{
    const normal=setup();normal.scheduler.enqueue(createMessage(normal.conversation,'user','A'))
    await vi.advanceTimersByTimeAsync(3000);normal.scheduler.inputActivity()
    await vi.advanceTimersByTimeAsync(500);expect(normal.generate).toHaveBeenCalledTimes(1)
    const t=setup({settings:{replyWaitMs:3500,deferWhileTyping:true}})
    t.scheduler.enqueue(createMessage(t.conversation,'user','B'))
    for(let i=0;i<13;i++){await vi.advanceTimersByTimeAsync(1000);t.scheduler.inputActivity()}
    expect(t.generate).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(500)
    expect(t.generate).toHaveBeenCalledTimes(1)
  })
})
describe('per-conversation work',()=>{
  it('queues during generation/dispatch without cancelling or overlapping',async()=>{
    let complete!:(v:{messages:string[]})=>void
    const calls:Message[][]=[];let firstSignal:AbortSignal|undefined
    const t=setup({generate:async(batch,_id,signal)=>{
      calls.push([...batch]);firstSignal??=signal
      return calls.length===1?await new Promise(resolve=>{complete=resolve}):{messages:['next']}
    },delayMs:()=>2000})
    t.scheduler.enqueue(createMessage(t.conversation,'user','A'))
    await vi.advanceTimersByTimeAsync(3500)
    t.scheduler.enqueue(createMessage(t.conversation,'user','B'))
    await vi.advanceTimersByTimeAsync(3500)
    expect(calls).toHaveLength(1);expect(firstSignal?.aborted).toBe(false)
    complete({messages:['one','two']});await vi.advanceTimersByTimeAsync(0)
    expect(t.emitted.map(m=>m.text)).toEqual(['one'])
    t.scheduler.enqueue(createMessage(t.conversation,'user','C'))
    await vi.advanceTimersByTimeAsync(2000)
    expect(t.emitted.map(m=>m.text)).toEqual(['one','two'])
    expect(calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1500)
    expect(calls.map(batch=>batch.map(m=>m.text))).toEqual([['A'],['B','C']])
  })
  it('keeps separate conversations progressing independently',async()=>{
    const a=setup({generate:()=>new Promise(()=>{})}), b=setup()
    a.scheduler.enqueue(createMessage(a.conversation,'user','A'))
    b.scheduler.enqueue(createMessage(b.conversation,'user','B'))
    await vi.advanceTimersByTimeAsync(3500)
    expect(a.saved().phase).toBe('Generating');expect(b.emitted).toHaveLength(1)
    a.scheduler.dispose()
  })
  it('reports failures/timeouts without automatic retries or losing the batch',async()=>{
    const t=setup({generate:async()=>{throw new Error('failed')}})
    t.scheduler.enqueue(createMessage(t.conversation,'user','A'))
    await vi.advanceTimersByTimeAsync(4000)
    expect(t.saved().active?.messages[0].text).toBe('A')
    expect(t.saved().error).toBe('failed')
    await vi.advanceTimersByTimeAsync(30000);expect(t.saved().error).toBe('failed')
    const slow=setup({generate:()=>new Promise(()=>{}),timeoutMs:1000})
    slow.scheduler.enqueue(createMessage(slow.conversation,'user','slow'))
    await vi.advanceTimersByTimeAsync(4500)
    expect(slow.saved().error).toContain('超时')
  })
  it('does not auto-regenerate an interrupted request on reload',async()=>{
    const t=setup({generate:()=>new Promise(()=>{})})
    t.scheduler.enqueue(createMessage(t.conversation,'user','A'));await vi.advanceTimersByTimeAsync(3500)
    const restored=t.saved();t.scheduler.dispose()
    const next=setup({conversationId:restored.conversationId,characterId:restored.characterId,restored})
    await vi.advanceTimersByTimeAsync(10000)
    expect(next.generate).not.toHaveBeenCalled()
    next.scheduler.retry();await vi.advanceTimersByTimeAsync(0)
    expect(next.generate).toHaveBeenCalledTimes(1)
  })
  it('disposes timers and ignores late provider completions',async()=>{
    let finish!:(v:{messages:string[]})=>void
    const t=setup({generate:()=>new Promise(resolve=>{finish=resolve})})
    t.scheduler.enqueue(createMessage(t.conversation,'user','A'));await vi.advanceTimersByTimeAsync(3500)
    t.scheduler.dispose();finish({messages:['late']})
    await vi.advanceTimersByTimeAsync(10000)
    expect(t.emitted).toEqual([])
  })
})
