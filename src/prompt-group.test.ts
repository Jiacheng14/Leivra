import { expect, it } from 'vitest'
import { buildPrompt } from './prompt'
import { defaultLeivra } from './characters/defaultLeivra'
import { createConversation, createMessage } from './models'
it('preserves grouped boundaries/timestamps, excludes duplicates and bounds long history',()=>{
  const conversation=createConversation(defaultLeivra.id)
  const currentMessages=['甲','乙','丙'].map(text=>createMessage(conversation,'user',text))
  const recentMessages=Array.from({length:50},()=>createMessage(conversation,'assistant','长'.repeat(10000)))
  const result=buildPrompt({character:defaultLeivra,conversation,currentMessages,recentMessages:[...recentMessages,...currentMessages]})
  expect(result.input.recentMessages).toHaveLength(6)
  expect(result.sections.filter(s=>s.kind==='history').reduce((n,s)=>n+s.content.length,0)).toBe(60000)
  expect(JSON.parse(result.sections.at(-1)!.content)).toEqual(currentMessages.map(m=>({id:m.id,text:m.text,createdAt:m.createdAt})))
  expect(result.input.currentMessages).toEqual(currentMessages)
  currentMessages[0].text='caller mutation'
  expect(result.input.currentMessages[0].text).toBe('甲')
})
