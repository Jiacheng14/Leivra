import type { ModelProvider } from './models'
import { mockRepliesFor } from './characters/mockFixtures'
export { MAX_LENGTH } from './models'
export { validateModelOutput } from './reply'
import { validateModelOutput } from './reply'
export const mockProvider: ModelProvider = {
  id: 'local-mock',
  reply(request, signal) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(new DOMException('Aborted', 'AbortError')); return }
      const abort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')) }
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', abort)
        try {
          const text = request.sections.find(s => s.kind === 'current-message')?.content ?? ''
          const replies = mockRepliesFor(request.characterId, text)
          resolve(validateModelOutput({ messages: replies }))
        } catch (error) { reject(error) }
      }, 850)
      signal.addEventListener('abort', abort, { once: true })
    })
  }
}