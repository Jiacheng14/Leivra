import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { ConversationManager } from './ConversationManager'
import { createInitialData, validateData, appendMessages } from '../storage'
import { addCharacter } from '../characters/cards'
import { mockProvider } from '../chat'
import { createRealProvider } from '../providers/real'
import { replyDelayMs, validateModelOutput } from '../reply'
import type { ModelProvider } from '../models'
beforeEach(()=>{ vi.useFakeTimers(); vi.setSystemTime(100000) })
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals()})
it('runs the actual mock through the manager, groups messages, preserves settings and never fetches',async()=>{
  const fetch = vi.fn();vi.stubGlobal('fetch',fetch)
  let data=createInitialData([])
  const provider={...mockProvider,reply:vi.fn(mockProvider.reply)}
  const manager=new ConversationManager(provider,()=>data,next=>{data=validateData(next)})
  manager.start();manager.configure({replyWaitMs:1000,deferWhileTyping:true})
  const id=data.conversations[0].id
  for(const text of ['好烦','作业多','写不完']){manager.send(id,text);await vi.advanceTimersByTimeAsync(500)}
  expect(provider.reply).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(10000)
  expect(provider.reply).toHaveBeenCalledTimes(1)
  const request=provider.reply.mock.calls[0][0]
  expect(request.input.currentMessages.map(m=>m.text)).toEqual(['好烦','作业多','写不完'])
  expect(request.input.recentMessages).toEqual([])
  expect(data.messages.filter(m=>m.role==='user')).toHaveLength(3)
  expect(data.messages.filter(m=>m.role==='assistant')).toHaveLength(2)
  expect(data.chatSettings).toEqual({replyWaitMs:1000,deferWhileTyping:true,maxWaitMs:300000})
  expect(fetch).not.toHaveBeenCalled();manager.dispose()
})
it('restores the saved 3.5s setting and remaining collection delay',async()=>{
  let data=createInitialData([])
  const provider:ModelProvider={id:'test',reply:vi.fn(async()=>({messages:['回复']}))}
  let manager=new ConversationManager(provider,()=>data,next=>{data=validateData(next)})
  manager.start();manager.configure({replyWaitMs:3500,deferWhileTyping:false})
  await manager.send(data.conversations[0].id,'刷新前发送')
  await vi.advanceTimersByTimeAsync(2000)
  manager.dispose();data=validateData(JSON.parse(JSON.stringify(data)))
  expect(data.chatSettings).toEqual({replyWaitMs:3500,deferWhileTyping:false,maxWaitMs:300000})
  manager=new ConversationManager(provider,()=>data,next=>{data=validateData(next)})
  manager.start()
  await vi.advanceTimersByTimeAsync(1490)
  expect(provider.reply).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(10)
  expect(provider.reply).toHaveBeenCalledTimes(1)
  expect(vi.mocked(provider.reply).mock.calls[0][0].input.currentMessages.map(m=>m.text)).toEqual(['刷新前发送'])
  manager.dispose()
})
it('uses the same 3.5s scheduling boundary for Mock and Real adapters',async()=>{
  for(const mode of ['mock','real'] as const) {
    vi.setSystemTime(100000)
    let data=createInitialData([])
    const fetcher=vi.fn(async()=>Response.json({messages:['假回复']}))
    const mock={...mockProvider,reply:vi.fn(mockProvider.reply)}
    const provider=mode==='mock'?mock:createRealProvider(fetcher)
    const manager=new ConversationManager(provider,()=>data,next=>{data=validateData(next)})
    manager.start();manager.configure({replyWaitMs:3500,deferWhileTyping:false})
    await manager.send(data.conversations[0].id,'测试')
    await vi.advanceTimersByTimeAsync(3490)
    expect(mode==='mock'?mock.reply:fetcher).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(10)
    expect(mode==='mock'?mock.reply:fetcher).toHaveBeenCalledTimes(1)
    manager.dispose()
  }
})
it('keeps the user message in memory and never calls the provider after a failed save',async()=>{
  let data=createInitialData([])
  const provider:ModelProvider={id:'real-test',reply:vi.fn(async()=>({messages:['unexpected']}))}
  const manager=new ConversationManager(provider,()=>data,next=>{
    data=validateData(next)
    if(data.messages.some(m=>m.role==='user'))throw new Error('quota')
  })
  manager.start()
  expect(await manager.send(data.conversations[0].id,'keep me')).toBe(false)
  expect(data.messages.filter(m=>m.role==='user').map(m=>m.text)).toEqual(['keep me'])
  await vi.advanceTimersByTimeAsync(30000)
  expect(provider.reply).not.toHaveBeenCalled()
  expect(manager.peek(data.conversations[0].id)?.snapshot().error).toContain('保存失败')
  manager.dispose()
})
it('waits for the manager writer to confirm the generating snapshot',async()=>{
  let data=createInitialData([])
  let confirm!:()=>void
  const provider:ModelProvider={id:'real-test',reply:vi.fn(async()=>({messages:['ok']}))}
  const manager=new ConversationManager(provider,()=>data,next=>{
    if(next.schedulerSnapshots?.[0]?.phase==='Generating') {
      return new Promise<void>(resolve=>{confirm=()=>{data=validateData(next);resolve()}})
    }
    data=validateData(next)
  })
  manager.start()
  await manager.send(data.conversations[0].id,'hello')
  await vi.advanceTimersByTimeAsync(5000)
  expect(provider.reply).not.toHaveBeenCalled()
  expect(data.schedulerSnapshots?.[0]?.phase).toBe('Collecting')
  confirm(); await vi.advanceTimersByTimeAsync(0)
  expect(provider.reply).toHaveBeenCalledTimes(1)
  manager.dispose()
})
it('restores remaining long paragraphs without re-requesting or duplicate bubbles',async()=>{
  const long='第一段。\n\n'+'长文'.repeat(5000)+'\n结尾。'
  let data=createInitialData([])
  const provider:ModelProvider={id:'test',reply:vi.fn(async()=>({messages:['短句',long,'完']}))}
  let manager=new ConversationManager(provider,()=>data,next=>{data=validateData(next)})
  manager.start();manager.send(data.conversations[0].id,'聊聊')
  await vi.advanceTimersByTimeAsync(5000)
  expect(data.messages.map(m=>m.text)).toEqual(['聊聊','短句'])
  manager.dispose();data=validateData(JSON.parse(JSON.stringify(data)))
  manager=new ConversationManager(provider,()=>data,next=>{data=validateData(next)});manager.start()
  await vi.advanceTimersByTimeAsync(3999);expect(data.messages).toHaveLength(2)
  await vi.advanceTimersByTimeAsync(1);expect(data.messages[2].text).toBe(long)
  await vi.advanceTimersByTimeAsync(replyDelayMs('完')+1)
  expect(data.messages.map(m=>m.text)).toEqual(['聊聊','短句',long,'完'])
  expect(provider.reply).toHaveBeenCalledTimes(1)
  expect(appendMessages(data,data.conversations[0],[data.messages[2]]).messages).toHaveLength(4)
  manager.dispose()
})
it('keeps next-round and other-character messages out of a running request',async()=>{
  let data=createInitialData([]);data=addCharacter(data,{...data.characters[0],id:'second',name:'第二人'})
  let resolve!: (value:{messages:string[]})=>void
  const provider:ModelProvider={id:'test',reply:vi.fn(()=>new Promise<{messages:string[]}>(r=>{resolve=r}))}
  const manager=new ConversationManager(provider,()=>data,next=>{data=validateData(next)})
  manager.start();manager.send(data.conversations[0].id,'第一轮')
  await vi.advanceTimersByTimeAsync(5000)
  manager.send(data.conversations[0].id,'下一轮')
  manager.send(data.conversations[1].id,'其他角色秘密')
  const request=vi.mocked(provider.reply).mock.calls[0][0]
  expect(JSON.stringify(request)).not.toMatch(/下一轮|其他角色秘密/)
  resolve({messages:['答复']});await vi.advanceTimersByTimeAsync(0)
  expect(data.messages.filter(m=>m.role==='user')).toHaveLength(3)
  manager.dispose()
})
it('bounds delay nonlinearly and accepts mixed paragraphs while rejecting empty/abnormal output',()=>{
  expect(replyDelayMs('')).toBe(1000);expect(replyDelayMs('x'.repeat(50))).toBe(2000)
  expect(replyDelayMs('x'.repeat(200))).toBe(3000);expect(replyDelayMs('x'.repeat(10000))).toBe(4000)
  expect(replyDelayMs('😀'.repeat(50))).toBe(2000)
  const messages=['一句','  自然段\n\n'+ '字'.repeat(4000)+'\n结束  ']
  expect(validateModelOutput({messages}).messages).toEqual(messages)
  for(const messages of [[],['  '],Array(33).fill('x'),['x'.repeat(32001)],Array(3).fill('x'.repeat(30000))]) expect(()=>validateModelOutput({messages})).toThrow()
})
it('holds a collecting batch when changing provider mode until an explicit retry',async()=>{
  let data=createInitialData([])
  const mock={...mockProvider,reply:vi.fn(mockProvider.reply)}
  let manager=new ConversationManager(mock,()=>data,next=>{data=validateData(next)})
  manager.start();manager.send(data.conversations[0].id,'未完成的模拟消息');manager.dispose()
  const real:ModelProvider={id:'openai-backend',reply:vi.fn(async()=>({messages:['测试返回']}))}
  manager=new ConversationManager(real,()=>data,next=>{data=validateData(next)});manager.start()
  await vi.advanceTimersByTimeAsync(15000)
  expect(real.reply).not.toHaveBeenCalled();expect(data.schedulerSnapshots?.[0].error).toContain('模式')
  manager.get(data.conversations[0].id).retry();await vi.advanceTimersByTimeAsync(0)
  expect(real.reply).toHaveBeenCalledTimes(1);manager.dispose()
})
it('ignores only the selected mode-switched queue, persists it, and excludes it from later context',async()=>{
  let data=addCharacter(createInitialData([]),{...createInitialData([]).characters[0],id:'second',name:'第二人'})
  const mock:ModelProvider={id:'mock',reply:vi.fn(async()=>({messages:['unused']}))}
  let manager=new ConversationManager(mock,()=>data,next=>{data=validateData(next)})
  manager.start()
  const [first,second]=data.conversations.map(c=>c.id)
  await manager.send(first,'放弃的消息')
  await manager.send(second,'其他会话待回复')
  manager.dispose()
  const real:ModelProvider={id:'real',reply:vi.fn(async()=>({messages:['新回复']}))}
  manager=new ConversationManager(real,()=>data,next=>{data=validateData(next)})
  manager.start();await vi.advanceTimersByTimeAsync(0)
  expect(await manager.get(first).ignoreModeSwitch()).toBe(true)
  expect(await manager.get(first).ignoreModeSwitch()).toBe(false)
  expect(data.messages.find(m=>m.text==='放弃的消息')?.replyIgnored).toBe(true)
  expect(data.schedulerSnapshots?.find(s=>s.conversationId===first)?.phase).toBe('Idle')
  expect(data.schedulerSnapshots?.find(s=>s.conversationId===second)?.pauseReason).toBe('mode-switch')
  await vi.advanceTimersByTimeAsync(10000)
  expect(real.reply).not.toHaveBeenCalled()
  manager.dispose();data=validateData(JSON.parse(JSON.stringify(data)))
  manager=new ConversationManager(mock,()=>data,next=>{data=validateData(next)})
  manager.start();await vi.advanceTimersByTimeAsync(10000)
  expect(mock.reply).not.toHaveBeenCalled()
  expect(data.schedulerSnapshots?.find(s=>s.conversationId===first)?.phase).toBe('Idle')
  manager.dispose();data=validateData(JSON.parse(JSON.stringify(data)))
  manager=new ConversationManager(real,()=>data,next=>{data=validateData(next)})
  manager.start();await vi.advanceTimersByTimeAsync(0)
  await manager.send(first,'新的消息')
  await vi.advanceTimersByTimeAsync(5000)
  expect(real.reply).toHaveBeenCalledTimes(1)
  const request=vi.mocked(real.reply).mock.calls[0][0]
  expect(request.input.currentMessages.map(m=>m.text)).toEqual(['新的消息'])
  expect(JSON.stringify(request)).not.toMatch(/放弃的消息|其他会话待回复/)
  expect(data.messages.find(m=>m.text==='放弃的消息')?.replyIgnored).toBe(true)
  manager.dispose()
})
it('keeps a mode-switched queue intact when ignoring cannot be saved',async()=>{
  let data=createInitialData([])
  let manager=new ConversationManager({id:'mock',reply:vi.fn(async()=>({messages:['unused']}))},()=>data,next=>{data=validateData(next)})
  manager.start();const id=data.conversations[0].id
  await manager.send(id,'保留任务');manager.dispose()
  const provider:ModelProvider={id:'real',reply:vi.fn(async()=>({messages:['unused']}))}
  manager=new ConversationManager(provider,()=>data,(next,durableFirst)=>{
    if(durableFirst && next.messages.some(m=>m.replyIgnored))throw new Error('quota')
    data=validateData(next)
  })
  manager.start();await vi.advanceTimersByTimeAsync(0)
  expect(await manager.get(id).ignoreModeSwitch()).toBe(false)
  expect(data.messages.find(m=>m.text==='保留任务')?.replyIgnored).toBeUndefined()
  expect(data.schedulerSnapshots?.[0].pauseReason).toBe('mode-switch')
  await vi.advanceTimersByTimeAsync(10000)
  expect(provider.reply).not.toHaveBeenCalled()
  manager.dispose()
})
it('continues undisplayed output while ignoring only the next queued group after a mode switch',async()=>{
  let data=createInitialData([])
  const first:ModelProvider={id:'mock',reply:vi.fn(async()=>({messages:['一','二']}))}
  let manager=new ConversationManager(first,()=>data,next=>{data=validateData(next)})
  manager.start();const id=data.conversations[0].id
  await manager.send(id,'已生成的消息');await vi.advanceTimersByTimeAsync(5000)
  await manager.send(id,'放弃下一组');manager.dispose()
  const real:ModelProvider={id:'real',reply:vi.fn(async()=>({messages:['unexpected']}))}
  manager=new ConversationManager(real,()=>data,next=>{data=validateData(next)})
  manager.start();await vi.advanceTimersByTimeAsync(0)
  expect(await manager.get(id).ignoreModeSwitch()).toBe(true)
  await vi.advanceTimersByTimeAsync(10000)
  expect(data.messages.filter(m=>m.role==='assistant').map(m=>m.text)).toEqual(['一','二'])
  expect(data.messages.find(m=>m.text==='已生成的消息')?.replyIgnored).toBeUndefined()
  expect(data.messages.find(m=>m.text==='放弃下一组')?.replyIgnored).toBe(true)
  expect(real.reply).not.toHaveBeenCalled()
  manager.dispose()
})
it('holds the next queue after restoring dispatch in a different provider mode',async()=>{
  let data=createInitialData([])
  const first:ModelProvider={id:'mock',reply:vi.fn(async()=>({messages:['一','二']}))}
  let manager=new ConversationManager(first,()=>data,next=>{data=validateData(next)})
  manager.start();manager.send(data.conversations[0].id,'第一组');await vi.advanceTimersByTimeAsync(5000)
  manager.send(data.conversations[0].id,'第二组');manager.dispose()
  const real:ModelProvider={id:'real',reply:vi.fn(async()=>({messages:['第三条']}))}
  manager=new ConversationManager(real,()=>data,next=>{data=validateData(next)});manager.start()
  await vi.advanceTimersByTimeAsync(15000)
  expect(data.messages.filter(m=>m.role==='assistant').map(m=>m.text)).toEqual(['一','二'])
  expect(real.reply).not.toHaveBeenCalled();expect(data.schedulerSnapshots?.[0].active?.messages[0].text).toBe('第二组')
  manager.get(data.conversations[0].id).retry();await vi.advanceTimersByTimeAsync(0)
  expect(real.reply).toHaveBeenCalledTimes(1);manager.dispose()
})
it('restores collection once and rejects foreign/corrupt persisted scheduling data',async()=>{
  let data=createInitialData([])
  const provider={...mockProvider,reply:vi.fn(mockProvider.reply)}
  let manager=new ConversationManager(provider,()=>data,next=>{data=validateData(next)})
  manager.start();manager.send(data.conversations[0].id,'持久化的消息')
  await vi.advanceTimersByTimeAsync(1000);manager.dispose()
  const bad=structuredClone(data);bad.schedulerSnapshots![0].pending[0].characterId='foreign'
  expect(()=>validateData(bad)).toThrow()
  const badIndex=structuredClone(data);badIndex.schedulerSnapshots![0].phase='Dispatching'
  expect(()=>validateData(badIndex)).toThrow()
  manager=new ConversationManager(provider,()=>data,next=>{data=validateData(next)});manager.start()
  await vi.advanceTimersByTimeAsync(3999);expect(provider.reply).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(10000);expect(provider.reply).toHaveBeenCalledTimes(1)
  expect(data.messages.filter(m=>m.role==='user')).toHaveLength(1);manager.dispose()
})
