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
  it('does not start generation before 3500ms from the last sent message',async()=>{
    const calls:{at:number;texts:string[]}[]=[]
    const t=setup({generate:async messages=>{calls.push({at:Date.now(),texts:messages.map(m=>m.text)});return {messages:['回复']}}})
    await t.scheduler.enqueue(createMessage(t.conversation,'user','第一条'))
    await vi.advanceTimersByTimeAsync(3000)
    t.scheduler.inputActivity()
    await vi.advanceTimersByTimeAsync(490)
    expect(calls).toEqual([])
    await vi.advanceTimersByTimeAsync(10)
    expect(calls).toEqual([{at:103500,texts:['第一条']}])
  })
  it('resets the deadline for a second sent message and keeps both bubbles',async()=>{
    const calls:{at:number;texts:string[]}[]=[]
    const t=setup({generate:async messages=>{calls.push({at:Date.now(),texts:messages.map(m=>m.text)});return {messages:['回复']}}})
    await t.scheduler.enqueue(createMessage(t.conversation,'user','第一条'))
    await vi.advanceTimersByTimeAsync(2000)
    await t.scheduler.enqueue(createMessage(t.conversation,'user','第二条'))
    await vi.advanceTimersByTimeAsync(3490)
    expect(calls).toEqual([])
    await vi.advanceTimersByTimeAsync(10)
    expect(calls).toEqual([{at:105500,texts:['第一条','第二条']}])
  })
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
  it('ignores typing by default and waits the configured interval after activity',async()=>{
    const normal=setup();normal.scheduler.enqueue(createMessage(normal.conversation,'user','A'))
    await vi.advanceTimersByTimeAsync(3000);normal.scheduler.inputActivity()
    await vi.advanceTimersByTimeAsync(500);expect(normal.generate).toHaveBeenCalledTimes(1)
    const t=setup({settings:{replyWaitMs:3500,deferWhileTyping:true}})
    t.scheduler.enqueue(createMessage(t.conversation,'user','B'))
    for(let i=0;i<13;i++){await vi.advanceTimersByTimeAsync(1000);t.scheduler.inputActivity()}
    expect(t.generate).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(3490)
    expect(t.generate).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(10)
    expect(t.generate).toHaveBeenCalledTimes(1)
  })
  it('supports a 60 second quiet interval and caps a round at five minutes from its first sent message',async()=>{
    const calls:{at:number;texts:string[]}[]=[]
    const t=setup({settings:{replyWaitMs:60000,deferWhileTyping:true},
      generate:async messages=>{calls.push({at:Date.now(),texts:messages.map(m=>m.text)});return {messages:['回复']}}})
    await t.scheduler.enqueue(createMessage(t.conversation,'user','第一条'))
    for(let i=0;i<7;i++) {
      await vi.advanceTimersByTimeAsync(40000)
      t.scheduler.inputActivity()
    }
    await vi.advanceTimersByTimeAsync(19990)
    expect(calls).toEqual([])
    await vi.advanceTimersByTimeAsync(10)
    expect(calls).toEqual([{at:400000,texts:['第一条']}])
  })
  it('includes a late second message but still starts the round at the five minute cap',async()=>{
    const calls:{at:number;texts:string[]}[]=[]
    const t=setup({settings:{replyWaitMs:60000,deferWhileTyping:false},
      generate:async messages=>{calls.push({at:Date.now(),texts:messages.map(m=>m.text)});return {messages:['回复']}}})
    await t.scheduler.enqueue(createMessage(t.conversation,'user','第一条'))
    for(let i=0;i<5;i++) {
      await vi.advanceTimersByTimeAsync(50000)
      await t.scheduler.enqueue(createMessage(t.conversation,'user',`中途消息${i}`))
    }
    await vi.advanceTimersByTimeAsync(40000)
    await t.scheduler.enqueue(createMessage(t.conversation,'user','最后一条'))
    await vi.advanceTimersByTimeAsync(9990)
    expect(calls).toEqual([])
    await vi.advanceTimersByTimeAsync(10)
    expect(calls).toEqual([{at:400000,texts:['第一条','中途消息0','中途消息1','中途消息2','中途消息3','中途消息4','最后一条']}])
  })
  it('honors a custom one-minute cap and recalculates an existing round after a setting change',async()=>{
    const t=setup({settings:{replyWaitMs:60000,deferWhileTyping:true,maxWaitMs:600000}})
    await t.scheduler.enqueue(createMessage(t.conversation,'user','A'))
    await vi.advanceTimersByTimeAsync(40000);t.scheduler.inputActivity()
    t.scheduler.configure({replyWaitMs:60000,deferWhileTyping:true,maxWaitMs:60000})
    await vi.advanceTimersByTimeAsync(19990)
    expect(t.generate).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(10)
    expect(t.generate).toHaveBeenCalledTimes(1)
  })
  it('allows continuous typing beyond five minutes when the cap is unlimited, then waits for quiet',async()=>{
    const t=setup({settings:{replyWaitMs:60000,deferWhileTyping:true,maxWaitMs:null}})
    await t.scheduler.enqueue(createMessage(t.conversation,'user','A'))
    for(let i=0;i<12;i++){await vi.advanceTimersByTimeAsync(30000);t.scheduler.inputActivity()}
    expect(t.generate).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(59990)
    expect(t.generate).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(10)
    expect(t.generate).toHaveBeenCalledTimes(1)
  })
})
describe('per-conversation work',()=>{
  it('joins a message sent while the generating save is pending and restarts its wait',async()=>{
    const conversation=createConversation('test')
    let confirm!:()=>void
    let hold=true
    const calls:{at:number;texts:string[]}[]=[]
    const scheduler=new MessageScheduler({conversationId:conversation.id,characterId:conversation.characterId,
      generate:async messages=>{calls.push({at:Date.now(),texts:messages.map(m=>m.text)});return {messages:['回复']}},
      commit:state=>{
        if (hold && state.phase==='Generating' && state.active?.messages.length===1) {
          hold=false;return new Promise<void>(resolve=>{confirm=resolve})
        }
      }})
    await scheduler.start()
    await scheduler.enqueue(createMessage(conversation,'user','第一条'))
    await vi.advanceTimersByTimeAsync(3500)
    expect(calls).toEqual([])
    const second=scheduler.enqueue(createMessage(conversation,'user','第二条'))
    confirm(); await second
    await vi.advanceTimersByTimeAsync(3490)
    expect(calls).toEqual([])
    await vi.advanceTimersByTimeAsync(10)
    expect(calls).toEqual([{at:107000,texts:['第一条','第二条']}])
    scheduler.dispose()
  })
  it('honors typing deferral while a request is waiting for durable state',async()=>{
    const conversation=createConversation('test')
    let confirm!:()=>void
    let hold=true
    const calls:number[]=[]
    const scheduler=new MessageScheduler({conversationId:conversation.id,characterId:conversation.characterId,
      settings:{replyWaitMs:3500,deferWhileTyping:true},
      generate:async()=>{calls.push(Date.now());return {messages:['回复']}},
      commit:state=>{
        if (hold && state.phase==='Generating') {
          hold=false;return new Promise<void>(resolve=>{confirm=resolve})
        }
      }})
    await scheduler.start()
    await scheduler.enqueue(createMessage(conversation,'user','第一条'))
    await vi.advanceTimersByTimeAsync(3500)
    scheduler.inputActivity()
    confirm(); await vi.advanceTimersByTimeAsync(3490)
    expect(calls).toEqual([])
    await vi.advanceTimersByTimeAsync(10)
    expect(calls).toEqual([107000])
    scheduler.dispose()
  })
  it('applies a changed wait setting before the request starts',async()=>{
    const conversation=createConversation('test')
    let confirm!:()=>void
    let hold=true
    const calls:number[]=[]
    const scheduler=new MessageScheduler({conversationId:conversation.id,characterId:conversation.characterId,
      generate:async()=>{calls.push(Date.now());return {messages:['回复']}},
      commit:state=>{
        if (hold && state.phase==='Generating') {
          hold=false;return new Promise<void>(resolve=>{confirm=resolve})
        }
      }})
    await scheduler.start()
    await scheduler.enqueue(createMessage(conversation,'user','第一条'))
    await vi.advanceTimersByTimeAsync(3500)
    scheduler.configure({replyWaitMs:5000,deferWhileTyping:false})
    confirm(); await vi.advanceTimersByTimeAsync(1490)
    expect(calls).toEqual([])
    await vi.advanceTimersByTimeAsync(10)
    expect(calls).toEqual([105000])
    scheduler.dispose()
  })
  it('waits for async persistence before a request and pauses on rejection',async()=>{
    const conversation=createConversation('test')
    let rejectCommit!: (reason?: unknown)=>void
    const generate=vi.fn(async()=>({messages:['reply']}))
    const saved:SchedulerSnapshot[]=[]
    const scheduler=new MessageScheduler({conversationId:conversation.id,characterId:conversation.characterId,
      generate,commit:state=>{
        if(state.phase==='Generating')return new Promise<void>((_,reject)=>{rejectCommit=reject})
        saved.push(state)
      }})
    await scheduler.start()
    await scheduler.enqueue(createMessage(conversation,'user','hello'))
    await vi.advanceTimersByTimeAsync(3500)
    expect(saved.at(-1)?.phase).toBe('Collecting')
    expect(generate).not.toHaveBeenCalled()
    rejectCommit(new Error('quota'))
    await vi.advanceTimersByTimeAsync(10000)
    expect(generate).not.toHaveBeenCalled()
    expect(scheduler.snapshot().error).toContain('保存失败')
    scheduler.dispose()
  })
  it('keeps the round ID on recovery and uses a new request ID only for manual retry',async()=>{
    const first=setup({generate:()=>new Promise(()=>{})})
    await first.scheduler.enqueue(createMessage(first.conversation,'user','A'))
    await vi.advanceTimersByTimeAsync(3500)
    const original=first.saved().active!.id
    first.scheduler.dispose()
    const retryGenerate=vi.fn(()=>new Promise<{messages:string[]}>(()=>{}))
    const next=setup({conversationId:first.conversation.id,characterId:first.conversation.characterId,restored:first.saved(),generate:retryGenerate})
    expect(next.saved().active?.id).toBe(original)
    await vi.advanceTimersByTimeAsync(10000)
    expect(retryGenerate).not.toHaveBeenCalled()
    void next.scheduler.retry(); await vi.advanceTimersByTimeAsync(0)
    expect(next.saved().active?.id).toBe(original)
    expect(next.saved().active?.requestId).not.toBe(original)
    expect(retryGenerate).toHaveBeenCalledTimes(1)
  })
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
