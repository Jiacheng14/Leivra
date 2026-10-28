import type { Conversation, Message } from './models'
import { MAX_LENGTH } from './models'
import { MAX_REPLY_LENGTH } from './reply'
import type { GenerationInput } from './prompt'
import { validateCharacter } from './characters/cards'
import { record, stableId, text, timestamp, unique } from './validation'
export const API_ERRORS = {
  BAD_REQUEST: '请求数据不符合格式或超过限制。',
  FORBIDDEN: '此后端仅允许本机开发页面访问。',
  NOT_CONFIGURED: '后端尚未配置 API Key 或模型名称。',
  AUTH: 'OpenAI 密钥无效或缺少访问权限，请检查后端配置。',
  QUOTA: 'OpenAI API 余额或配额不足，请检查账户。',
  RATE_LIMIT: '请求过于频繁，请稍后手动重试。',
  BUSY: '后端正在处理其他请求，请稍后手动重试。',
  DUPLICATE: '该轮请求已经提交，未重复调用模型。',
  MODEL_CONFIG: '模型或请求配置不受支持，请检查后端模型设置。',
  TIMEOUT: '模型请求超时，请手动重试。',
  NETWORK: '无法连接模型服务，请检查网络后手动重试。',
  UPSTREAM: '模型服务暂时不可用，请稍后手动重试。',
  OUTPUT: '模型未返回完整有效的消息，请手动重试。',
  REFUSAL: '模型未能回应这组消息。',
  CANCELLED: '请求已取消。'
} as const
export type ApiErrorCode = keyof typeof API_ERRORS
export function validateGenerationInput(value: unknown): GenerationInput {
  const v = record(value)
  if (Object.keys(v).some(key=>!['turnId','character','conversation','recentMessages','currentMessages'].includes(key))) throw new Error('请求包含未知字段。')
  const character=validateCharacter(v.character), c=record(v.conversation)
  const conversation:Conversation={id:stableId(c.id),characterId:stableId(c.characterId),createdAt:timestamp(c.createdAt)}
  if(conversation.characterId!==character.id) throw new Error('角色与会话不匹配。')
  function messages(value:unknown,current:boolean):Message[] {
    if(!Array.isArray(value)||value.length>(current?100:50)||(current&&!value.length)) throw new Error('消息组格式错误。')
    const result=value.map(item=>{
      const m=record(item)
      if(m.characterId!==character.id||m.conversationId!==conversation.id||(m.role!=='user'&&m.role!=='assistant')||(current&&m.role!=='user')) throw new Error('消息归属错误。')
      return {id:stableId(m.id),characterId:character.id,conversationId:conversation.id,role:m.role,text:text(m.text,'消息',m.role==='user'?MAX_LENGTH:MAX_REPLY_LENGTH,true),createdAt:timestamp(m.createdAt)} as Message
    })
    unique(result.map(m=>m.id))
    if(result.reduce((n,m)=>n+m.text.length,0)>64000)throw new Error('消息组过长。')
    return result
  }
  const recentMessages=messages(v.recentMessages,false),currentMessages=messages(v.currentMessages,true)
  unique([...recentMessages,...currentMessages].map(m=>m.id))
  return {turnId:stableId(v.turnId),character,conversation,recentMessages,currentMessages}
}
