import { afterEach, expect, it, vi } from 'vitest'
import { createWorker } from './index'
import { responseBody } from './openai'
import { defaultLeivra } from '../src/characters/defaultLeivra'
import { createConversation, createMessage } from '../src/models'
import { createRealProvider } from '../src/providers/real'
import { buildPrompt } from '../src/prompt'
const env={OPENAI_API_KEY:'FAKE_SECRET_DO_NOT_EXPOSE_123',OPENAI_MODEL:'configured-test-model'}
function input(){const conversation=createConversation(defaultLeivra.id);return {turnId:crypto.randomUUID(),character:defaultLeivra,conversation,recentMessages:[],currentMessages:[createMessage(conversation,'user','你好')]}}
function request(value:unknown=input(),headers:Record<string,string>={}){return new Request('http://127.0.0.1:8787/api/chat',{method:'POST',headers:{Origin:'http://127.0.0.1:5173','Content-Type':'application/json','X-Leivra-Client':'1',...headers},body:JSON.stringify(value)})}
function success(messages=['回复']) {return Response.json({status:'completed',output:[{type:'reasoning',summary:[]},{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify({messages})}]}]})}
afterEach(()=>vi.useRealTimers())
it('uses configured Responses structured output, one system protocol, bounded history and backend-only key',async()=>{
  const upstream=vi.fn<typeof fetch>(async(_url,options)=>{
    expect(options?.headers).toMatchObject({Authorization:'Bearer '+env.OPENAI_API_KEY})
    const body=JSON.parse(String(options?.body))
    expect(body.model).toBe(env.OPENAI_MODEL);expect(body.store).toBe(false)
    expect(body.text.format).toMatchObject({type:'json_schema',strict:true,schema:{additionalProperties:false}})
    expect(body.input.filter((i:{role:string})=>i.role==='system')).toHaveLength(1)
    return success(['短句','多段\n\n'+ '长文'.repeat(3000)])
  })
  const worker=createWorker(upstream)
  const response=await worker.fetch(request(),env)
  expect(response.status).toBe(200)
  const result=await response.json() as {messages:string[]}
  expect(result.messages[1]).toContain('\n\n');expect(result.messages[1].length).toBeGreaterThan(2000)
  expect(JSON.stringify(result)).not.toContain(env.OPENAI_API_KEY)
  expect(upstream.mock.calls[0][0]).toBe('https://api.openai.com/v1/responses')
  expect(upstream).toHaveBeenCalledTimes(1)
})
it.each([[401,'invalid_api_key','AUTH'],[403,'permission','AUTH'],[429,'insufficient_quota','QUOTA'],[429,'rate_limit_exceeded','RATE_LIMIT'],[500,'internal','UPSTREAM'],[400,'model','MODEL_CONFIG'],[404,'model','MODEL_CONFIG']])('sanitizes %s / %s without retry',async(status,code,expected)=>{
  const upstream=vi.fn<typeof fetch>(async()=>Response.json({error:{code,message:env.OPENAI_API_KEY}},{status:Number(status)}))
  const response=await createWorker(upstream).fetch(request(),env)
  const result=JSON.stringify(await response.json())
  expect(result).toContain(expected);expect(result).not.toContain(env.OPENAI_API_KEY);expect(upstream).toHaveBeenCalledTimes(1)
})
it('reports missing configuration and rejects cross-origin/non-local requests without upstream calls',async()=>{
  const upstream=vi.fn<typeof fetch>(), worker=createWorker(upstream)
  expect((await worker.fetch(request(),{})).status).toBe(503)
  expect((await worker.fetch(request(input(),{Origin:'https://evil.example'}),env)).status).toBe(403)
  expect((await worker.fetch(request(input(),{'X-Leivra-Client':''}),env)).status).toBe(403)
  expect((await worker.fetch(new Request('https://public.workers.dev/api/chat',request()),env)).status).toBe(403)
  expect(upstream).not.toHaveBeenCalled()
})
it('validates body size, character ownership, unknown fields and current-message duplicates',async()=>{
  const upstream=vi.fn<typeof fetch>(),worker=createWorker(upstream), i=input()
  const cases=[{...i,sections:[]},{...i,currentMessages:[{...i.currentMessages[0],characterId:'other'}]},{...i,currentMessages:[i.currentMessages[0],i.currentMessages[0]]},{...i,recentMessages:i.currentMessages}]
  for(const value of cases)expect((await worker.fetch(request(value),env)).status).toBe(400)
  expect((await worker.fetch(request('x'.repeat(1024*1024)),env)).status).toBe(400)
  expect((await worker.fetch(request(i,{'Content-Length':String(1024*1024+1)}),env)).status).toBe(413)
  expect(upstream).not.toHaveBeenCalled()
})
it('enforces same-conversation and total concurrency, duplicate turn IDs and rate limit',async()=>{
  const resolvers:Array<(r:Response)=>void>=[]
  const upstream=vi.fn<typeof fetch>(()=>new Promise< Response>(resolve=>resolvers.push(resolve)))
  const worker=createWorker(upstream), a=input(),b=input()
  const first=worker.fetch(request(a),env);await vi.waitFor(()=>expect(upstream).toHaveBeenCalledTimes(1))
  expect((await (await worker.fetch(request(a),env)).json() as {error:{code:string}}).error.code).toBe('DUPLICATE')
  expect((await (await worker.fetch(request({...a,turnId:crypto.randomUUID()}),env)).json() as {error:{code:string}}).error.code).toBe('BUSY')
  const second=worker.fetch(request(b),env);await vi.waitFor(()=>expect(upstream).toHaveBeenCalledTimes(2))
  expect((await worker.fetch(request(),env)).status).toBe(429)
  resolvers.forEach(resolve=>resolve(success()));await Promise.all([first,second])
  const fast=vi.fn<typeof fetch>(async()=>success()),limited=createWorker(fast)
  for(let n=0;n<10;n++)expect((await limited.fetch(request(),env)).status).toBe(200)
  expect((await limited.fetch(request(),env)).status).toBe(429);expect(fast).toHaveBeenCalledTimes(10)
})
it('times out, aborts upstream and never automatically retries',async()=>{
  vi.useFakeTimers()
  let signal:AbortSignal|undefined
  const upstream=vi.fn<typeof fetch>(async(_url,options)=>{signal=options?.signal??undefined;return new Promise(()=>{})})
  const pending=createWorker(upstream,100).fetch(request(),env)
  await vi.advanceTimersByTimeAsync(101)
  expect((await pending).status).toBe(504);expect(signal?.aborted).toBe(true)
  await vi.advanceTimersByTimeAsync(100000);expect(upstream).toHaveBeenCalledTimes(1)
})
it('reports network failures and invalid/incomplete/refused output safely',async()=>{
  const failed=createWorker(vi.fn<typeof fetch>(async()=>{throw new Error(env.OPENAI_API_KEY)}))
  expect(JSON.stringify(await (await failed.fetch(request(),env)).json())).toContain('NETWORK')
  const values=[{status:'incomplete',output:[]},{status:'completed',output:[]},{status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'broken '+env.OPENAI_API_KEY}]}]}]
  for(const value of values){const result=await createWorker(vi.fn<typeof fetch>(async()=>Response.json(value))).fetch(request(),env);expect(JSON.stringify(await result.json())).not.toContain(env.OPENAI_API_KEY);expect(result.status).toBe(502)}
  const refused=await createWorker(vi.fn<typeof fetch>(async()=>Response.json({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'refusal',refusal:'hidden'}]}]}))).fetch(request(),env)
  expect(JSON.stringify(await refused.json())).toContain('REFUSAL')
})
it('connects the real client adapter to the worker with fake upstream and preserves the second turn context',async()=>{
  const upstream=vi.fn<typeof fetch>(async()=>success()),worker=createWorker(upstream)
  const transport=vi.fn<typeof fetch>(async(_url,options)=>worker.fetch(new Request('http://127.0.0.1:8787/api/chat',{...options,headers:{...options?.headers,Origin:'http://127.0.0.1:5173'}}),env))
  const provider=createRealProvider(transport),i=input(),signal=new AbortController().signal
  const first=await provider.reply(buildPrompt(i),signal)
  const history=[...i.currentMessages,createMessage(i.conversation,'assistant',first.messages[0])]
  await provider.reply(buildPrompt({...i,turnId:crypto.randomUUID(),recentMessages:history,currentMessages:[createMessage(i.conversation,'user','继续')]}),signal)
  const body=JSON.parse(String(upstream.mock.calls[1][1]?.body))
  expect(body.input.filter((v:{content:string})=>v.content==='你好')).toHaveLength(1)
  expect(JSON.parse(body.input.at(-1).content)[0].text).toBe('继续')
  expect(JSON.stringify(transport.mock.calls)).not.toContain(env.OPENAI_API_KEY)
  expect(JSON.stringify(responseBody(i,env))).not.toContain(env.OPENAI_API_KEY)
  const bad=createRealProvider(vi.fn<typeof fetch>(async()=>Response.json({error:{code:'AUTH',message:env.OPENAI_API_KEY}},{status:502})))
  await expect(bad.reply(buildPrompt(i),signal)).rejects.toThrow('密钥无效')
})
