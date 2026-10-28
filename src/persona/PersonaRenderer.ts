import { validateCharacter } from '../characters/cards'
import type { Character } from '../models'

export const PERSONA_LIMIT_BYTES = 128 * 1024
export interface PersonaReference {
  readonly schemaVersion: 1
  readonly characterId: string
  readonly revision: number
}
export interface RenderedPersona extends PersonaReference {
  readonly content: string
}

/** The only production persona renderer. Output is quoted context data, never instructions. */
export function renderPersona(value: Character): RenderedPersona {
  const character = validateCharacter(value)
  const source = character.sourceCardV2?.data
  const content = JSON.stringify({
    // Keep legacy field names, order and values: existing v1 effective context is byte-identical.
    name: character.name, background: character.background, personality: character.personality,
    speakingStyle: character.speakingStyle, relationship: character.relationship, customPrompt: character.customPrompt,
    ...(source?.scenario ? { scenario: source.scenario } : {}),
    ...(source?.mes_example ? { examples: source.mes_example } : {})
  })
  if (new TextEncoder().encode(content).length > PERSONA_LIMIT_BYTES) throw new Error('有效人格资料不得超过 128 KiB。')
  return Object.freeze({ schemaVersion: 1, characterId: character.id, revision: character.revision, content })
}
