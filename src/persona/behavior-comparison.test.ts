import { expect, it } from 'vitest'
import { personaScenarios } from '../../tests/fixtures/persona-scenarios'
import original from '../../tests/fixtures/pre-persona-leivra.json'
import { buildPrompt } from '../prompt'
import { defaultLeivra } from '../characters/defaultLeivra'
import { createConversation, createMessage, type Message } from '../models'
import { responseBody } from '../../worker/openai'

// Baseline is the exact pre-engine persona projection. This does NOT score model-generated behavior.
const { name, background, personality, speakingStyle, relationship, customPrompt } = original
const oldPersonaContent = JSON.stringify({ name, background, personality, speakingStyle, relationship, customPrompt })
it.each(personaScenarios)('compares old/new persona and true message boundaries: $title', scenario => {
  const conversation = createConversation(defaultLeivra.id)
  const recentMessages: Message[] = []
  for (const round of scenario.rounds) {
    const currentMessages = round.map(text => createMessage(conversation, 'user', text))
    const request = buildPrompt({ character: defaultLeivra, conversation, recentMessages, currentMessages })
    expect(request.sections.filter(s => s.kind === 'character').map(s => s.content)).toEqual([oldPersonaContent])
    const body = responseBody(request.input, { OPENAI_MODEL: 'fixture' })
    expect(body.input.slice(4, -1)).toEqual(recentMessages.map(m => ({ role: m.role, content: m.text })))
    expect(JSON.parse(body.input.at(-1)!.content)).toEqual(currentMessages.map(({ id, text, createdAt }) => ({ id, text, createdAt })))
    expect(body.input.filter(m => m.role === 'system')).toHaveLength(1)
    recentMessages.push(...currentMessages, createMessage(conversation, 'assistant', '仅供离线对照的历史占位回复。'))
  }
})
