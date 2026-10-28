import { buildPrompt, type GenerationInput } from '../src/prompt'
import { validateModelOutput } from '../src/reply'
import { record } from '../src/validation'
import { ApiFailure, readJsonLimited } from './http'
export interface Env { OPENAI_API_KEY?: string; OPENAI_MODEL?: string; OPENAI_MAX_OUTPUT_TOKENS?: string }
export function responseBody(input:GenerationInput, env:Env) {
  const prompt=buildPrompt(input)
  const maxTokens=Number(env.OPENAI_MAX_OUTPUT_TOKENS ?? 8192)
  if(!Number.isSafeInteger(maxTokens)||maxTokens<256||maxTokens>32768)throw new ApiFailure('MODEL_CONFIG',503)
  return {
    model:env.OPENAI_MODEL,store:false,max_output_tokens:maxTokens,
    input:prompt.sections.map(section=>({
      role:section.role==='context'?'user':section.role,
      content:section.role==='context'?JSON.stringify({kind:section.kind,data:JSON.parse(section.content)}):section.content
    })),
    text:{format:{type:'json_schema',name:'leivra_messages',strict:true,
      schema:{type:'object',properties:{messages:{type:'array',items:{type:'string'}}},required:['messages'],additionalProperties:false}}}
  }
}
export async function generateOpenAI(input:GenerationInput, env:Env, signal:AbortSignal, fetcher:typeof fetch=fetch) {
  if(!env.OPENAI_API_KEY?.trim()||!env.OPENAI_MODEL?.trim())throw new ApiFailure('NOT_CONFIGURED',503)
  let response:Response
  try {
    response=await fetcher('https://api.openai.com/v1/responses',{
      method:'POST',headers:{Authorization:'Bearer '+env.OPENAI_API_KEY,'Content-Type':'application/json'},
      body:JSON.stringify(responseBody(input,env)),signal
    })
  } catch(error) {
    if(error instanceof ApiFailure)throw error
    throw new ApiFailure(signal.aborted?'CANCELLED':'NETWORK')
  }
  if(response.status===401||response.status===403){await response.body?.cancel();throw new ApiFailure('AUTH',502)}
  let value:unknown
  try {value=await readJsonLimited(response.body)}catch {throw new ApiFailure(response.ok?'OUTPUT':'UPSTREAM')}
  if(!response.ok) {
    if(response.status===429){
      const code=typeof value==='object'&&value!==null&&'error' in value ? (value as {error?:{code?:unknown}}).error?.code:undefined
      throw new ApiFailure(code==='insufficient_quota'?'QUOTA':'RATE_LIMIT',429)
    }
    throw new ApiFailure(response.status===400||response.status===404?'MODEL_CONFIG':'UPSTREAM')
  }
  try {
    const data=record(value)
    if(data.status!=='completed'||!Array.isArray(data.output))throw new ApiFailure('OUTPUT')
    const texts:string[]=[]
    for(const item of data.output){
      const message=record(item)
      if(message.type!=='message')continue
      if(message.role!=='assistant'||!Array.isArray(message.content))throw new ApiFailure('OUTPUT')
      for(const part of message.content){
        const c=record(part)
        if(c.type==='refusal')throw new ApiFailure('REFUSAL')
        if(c.type==='output_text'&&typeof c.text==='string')texts.push(c.text)
      }
    }
    return validateModelOutput(JSON.parse(texts.join('')))
  } catch(error){if(error instanceof ApiFailure)throw error;throw new ApiFailure('OUTPUT')}
}
