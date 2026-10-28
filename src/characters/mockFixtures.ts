import { DEFAULT_CHARACTER_ID, defaultMockReply } from './defaultLeivra'
const fixtures = new Map<string, (text: string) => string[]>([[DEFAULT_CHARACTER_ID, defaultMockReply]])
export function mockRepliesFor(characterId: string, text: string): string[] {
  return fixtures.get(characterId)?.(text) ?? ['我在听，你可以继续说。']
}
