import { validateGenerationInput } from '../src/apiContract'
import { ApiFailure, readJsonLimited } from './http'
import { generateOpenAI, type Env } from './openai'
const origins = new Set(['http://localhost:5173','http://127.0.0.1:5173'])
// Local single-process limits. Public deployment requires authentication and distributed limits.
export function createWorker(fetcher:typeof fetch=fetch, timeoutMs=60000, allowedOrigins:ReadonlySet<string>=origins) {
  const active=new Set<string>(), seen=new Map<string,number>()
  let starts:number[]=[]
  return { async fetch(request:Request,env:Env):Promise<Response> {
    const url=new URL(request.url)
    const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}})
    let key:string|undefined, timer:ReturnType<typeof setTimeout>|undefined
    const controller=new AbortController()
    const abort=()=>controller.abort()
    try {
      if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||!allowedOrigins.has(request.headers.get('Origin')??'')||request.headers.get('X-Leivra-Client')!=='1')throw new ApiFailure('FORBIDDEN',403)
      if(url.pathname!=='/api/chat'||request.method!=='POST')return json({error:{code:'BAD_REQUEST'}},404)
      if(!request.headers.get('Content-Type')?.startsWith('application/json'))throw new ApiFailure('BAD_REQUEST',400)
      if(Number(request.headers.get('Content-Length'))>1024*1024)throw new ApiFailure('BAD_REQUEST',413)
      let input
      try {input=validateGenerationInput(await readJsonLimited(request.body))}catch {throw new ApiFailure('BAD_REQUEST',400)}
      if(!env.OPENAI_API_KEY?.trim()||!env.OPENAI_MODEL?.trim())throw new ApiFailure('NOT_CONFIGURED',503)
      const now=Date.now()
      for(const [id,time] of seen)if(now-time>300000)seen.delete(id)
      starts=starts.filter(time=>now-time<60000)
      if(seen.has(input.turnId))throw new ApiFailure('DUPLICATE',409)
      if(active.has(input.conversation.id)||active.size>=2)throw new ApiFailure('BUSY',429)
      if(starts.length>=10)throw new ApiFailure('RATE_LIMIT',429)
      key=input.conversation.id;active.add(key);starts.push(now);seen.set(input.turnId,now)
      request.signal.addEventListener('abort',abort,{once:true})
      if(request.signal.aborted)controller.abort()
      const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new ApiFailure('TIMEOUT',504))},timeoutMs)})
      const result=await Promise.race([generateOpenAI(input,env,controller.signal,fetcher),timeout])
      return json(result)
    } catch(error) {
      const failure=error instanceof ApiFailure?error:new ApiFailure('UPSTREAM')
      return json({error:{code:failure.code,message:failure.message}},failure.status)
    } finally {
      clearTimeout(timer);request.signal.removeEventListener('abort',abort)
      if(key)active.delete(key)
    }
  }}
}
export default createWorker()
