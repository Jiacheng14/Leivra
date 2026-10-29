export const MAX_LENGTH = 2000
export const MAX_MESSAGES = 500
export interface Character {
  schemaVersion: 1
  id: string
  revision: number
  name: string
  avatar: string
  background: string
  personality: string[]
  speakingStyle: string
  relationship: string
  customPrompt: string
  preferences?: { temperature?: number; maxReplyMessages?: number }
  // Full inert V2 source; the adapter validates its projection against the fields above.
  sourceCardV2?: import('./characters/cardV2').CardV2
}
export interface Conversation {
  id: string
  characterId: string
  createdAt: number
}
export interface Message {
  id: string
  conversationId: string
  characterId: string
  role: 'user' | 'assistant'
  text: string
  createdAt: number
  replyIgnored?: true
}
// Only a contract in this phase: no extraction or memory persistence is enabled.
export interface Memory {
  schemaVersion: 1
  id: string
  characterId: string
  revision: number
  content: string
  updatedAt: number
}
export interface SharedInformation {
  id: string
  text: string
  consent: 'explicit' | 'not-granted'
  characterIds?: readonly string[]
}
export interface ModelOutput { messages: string[] }
export interface ModelProvider {
  readonly id: string
  reply(request: import('./prompt').ModelRequest, signal: AbortSignal): Promise<ModelOutput>
}
export interface LocalData {
  schemaVersion: 1
  theme?: 'light' | 'dark'
  activeCharacterId: string | null
  characters: Character[]
  conversations: Conversation[]
  messages: Message[]
  chatSettings?: import('./scheduling/settings').ChatSettings
  schedulerSnapshots?: import('./scheduling/MessageScheduler').SchedulerSnapshot[]
}
export function createConversation(characterId: string): Conversation {
  return { id: newId(), characterId, createdAt: Date.now() }
}
export function createMessage(conversation: Conversation, role: Message['role'], text: string): Message {
  return { id: newId(), conversationId: conversation.id, characterId: conversation.characterId, role, text, createdAt: Date.now() }
}
export function conversationMessages(data: LocalData, conversation: Conversation): Message[] {
  return data.messages.filter(m => m.characterId === conversation.characterId && m.conversationId === conversation.id)
}
import { newId } from './ids'
