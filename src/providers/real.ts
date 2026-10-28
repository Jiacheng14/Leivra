import type { ModelProvider } from '../models'
import { API_ERRORS, type ApiErrorCode } from '../apiContract'
import { validateModelOutput } from '../reply'
export function createRealProvider(fetcher:typeof fetch=fetch):ModelProvider {
  return { id:'openai-backend',async reply(request,signal) {
    let response:Response
    try {
      response=await fetcher('/api/chat',{method:'POST',headers:{'Content-Type':'application/json','X-Leivra-Client':'1'},body:JSON.stringify(request.input),signal})
    } catch {throw new Error(signal.aborted?API_ERRORS.CANCELLED:API_ERRORS.NETWORK)}
    let value:unknown
    try {value=await response.json()}catch {throw new Error(API_ERRORS.UPSTREAM)}
    if(!response.ok){
      const code=typeof value==='object'&&value!==null&&'error' in value?(value as {error?:{code?:unknown}}).error?.code:undefined
      throw new Error(typeof code==='string'&&Object.hasOwn(API_ERRORS,code)?API_ERRORS[code as ApiErrorCode]:API_ERRORS.UPSTREAM)
    }
    try {return validateModelOutput(value)}catch{throw new Error(API_ERRORS.OUTPUT)}
  }}
}
