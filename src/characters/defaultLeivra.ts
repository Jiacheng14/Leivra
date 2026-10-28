import type { Character, Conversation, Message } from '../models'
import { createMessage } from '../models'
import card from './leivra.json'
import { validateCharacter } from './cards'
export const defaultLeivra: Character = validateCharacter(card)
export const DEFAULT_CHARACTER_ID = defaultLeivra.id
// Retain the existing prototype's two demo messages only for the default contact.
export function defaultGreeting(conversation: Conversation): Message[] {
  return [createMessage(conversation, 'assistant', '来啦。今天过得怎么样？'), createMessage(conversation, 'assistant', '不用急着整理好心情，想到什么，就慢慢跟我说。')]
}
// These are demo fixtures, not rules in the shared prompt or provider engine.
export function defaultMockReply(text: string): string[] {
  if (/累|烦|压力|难过/.test(text)) return ['听起来今天不太轻松。先给自己一点喘息的时间吧。', '是有什么事一直压在心上，还是单纯觉得累了？']
  if (/晚安|睡觉/.test(text)) return ['好，今天就先到这里。没做完的事，留一点给明天也没关系。', '晚安，愿你睡个安稳的觉。']
  if (/开心|高兴|好事/.test(text)) return ['听你这么说，我也想多听一点了。', '是什么让你这么开心？跟我分享一下吧。']
  if (/你好|嗨|早/.test(text)) return ['我在。见到你很开心。', '今天想随意聊聊，还是有件事想跟我说？']
  return ['嗯，我在听。', '这件事里，你最想聊的是哪一部分？']
}
