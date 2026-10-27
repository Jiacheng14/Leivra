export type Message = { id: string; role: 'user' | 'assistant'; text: string; createdAt: number }
export interface ChatProvider {
  reply(messages: readonly Message[], signal: AbortSignal): Promise<string[]>
}
export const character = { name: '蕾芙菈', avatar: '/avatar.svg', userAvatar: '/user.svg' }
export const MAX_LENGTH = 2000
export function message(role: Message['role'], text: string): Message {
  return { id: crypto.randomUUID(), role, text, createdAt: Date.now() }
}
export function greeting(): Message[] {
  return [message('assistant', '来啦。今天过得怎么样？'), message('assistant', '不用急着整理好心情，想到什么，就慢慢跟我说。')]
}
export function mockReply(text: string): string[] {
  if (/累|烦|压力|难过/.test(text)) return ['听起来今天不太轻松。先给自己一点喘息的时间吧。', '是有什么事一直压在心上，还是单纯觉得累了？']
  if (/晚安|睡觉/.test(text)) return ['好，今天就先到这里。没做完的事，留一点给明天也没关系。', '晚安，愿你睡个安稳的觉。']
  if (/开心|高兴|好事/.test(text)) return ['听你这么说，我也想多听一点了。', '是什么让你这么开心？跟我分享一下吧。']
  if (/你好|嗨|早/.test(text)) return ['我在。见到你很开心。', '今天想随意聊聊，还是有件事想跟我说？']
  return ['嗯，我在听。', '这件事里，你最想聊的是哪一部分？']
}
export const mockProvider: ChatProvider = {
  reply(messages, signal) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(new DOMException('Aborted', 'AbortError')); return }
      const abort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')) }
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', abort)
        resolve(mockReply(messages.filter(m => m.role === 'user').at(-1)?.text ?? ''))
      }, 850)
      signal.addEventListener('abort', abort, { once: true })
    })
  }
}