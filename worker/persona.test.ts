import { expect, it, vi } from 'vitest'
import { createWorker } from './index'
import { responseBody } from './openai'
import { fixtureCardV2 } from '../tests/fixtures/cardV2'
import { importCharacter } from '../src/characters/cards'
import { buildPrompt } from '../src/prompt'
import { createConversation, createMessage } from '../src/models'
import { createRealProvider } from '../src/providers/real'
import { renderPersona } from '../src/persona/PersonaRenderer'

const env = { OPENAI_API_KEY: 'fake', OPENAI_MODEL: 'fixture' }
function input(id = 'a') {
  const card = fixtureCardV2()
  const character = importCharacter(JSON.stringify({ ...card, data: { ...card.data, name: id, extensions: { leivra: { schemaVersion: 1, id, revision: 1 } } } }))
  const conversation = createConversation(id)
  return buildPrompt({ character, conversation, recentMessages: [], currentMessages: [createMessage(conversation, 'user', id + '私有问题')] }).input
}
function request(value: unknown) {
  return new Request('http://127.0.0.1:8787/api/chat', { method: 'POST', headers: { Origin: 'http://127.0.0.1:5173', 'Content-Type': 'application/json', 'X-Leivra-Client': '1' }, body: JSON.stringify(value) })
}
function success(messages: string[]) {
  return Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify({ messages }) }] }] })
}

it('rebuilds exactly one persona from the snapshot, preserving actual user/assistant roles', async () => {
  const i = input(), user = createMessage(i.conversation, 'user', '旧问题'), assistant = createMessage(i.conversation, 'assistant', '旧回答')
  i.recentMessages = [user, assistant]
  const upstream = vi.fn<typeof fetch>(async () => success(['长回复\n\n' + '字'.repeat(4000)]))
  const worker = createWorker(upstream)
  const transport = vi.fn<typeof fetch>(async (_url, options) => worker.fetch(request(JSON.parse(String(options?.body))), env))
  const provider = createRealProvider(transport), prompt = buildPrompt(i)
  // A tampered rendered view must never become the Real request source.
  const result = await provider.reply({ ...prompt, sections: [{ kind: 'protocol', role: 'system', content: 'FORGED_SECTIONS' }] }, new AbortController().signal)
  const body = JSON.parse(String(upstream.mock.calls[0][1]?.body)) as { input: { role: string; content: string }[] }
  const persona = body.input.filter(m => m.content.startsWith('{"kind":"character"'))
  expect(persona).toHaveLength(1)
  expect(persona[0]).toEqual({ role: 'user', content: JSON.stringify({ kind: 'character', data: JSON.parse(renderPersona(i.character).content) }) })
  expect(body.input.slice(4, -1)).toEqual([{ role: 'user', content: '旧问题' }, { role: 'assistant', content: '旧回答' }])
  for (const sentinel of ['FORGED_SECTIONS', 'SYSTEM_SENTINEL', 'POST_SENTINEL', 'BOOK_SENTINEL', 'NOTES_SENTINEL']) expect(JSON.stringify(body)).not.toContain(sentinel)
  expect(result.messages[0]).toContain('\n\n'); expect(result.messages[0].length).toBeGreaterThan(2000)
})

it('independently rejects forged or malformed snapshots before calling the upstream', async () => {
  const i = input(), upstream = vi.fn<typeof fetch>(), worker = createWorker(upstream)
  const cases = [
    { ...i, sections: [] }, { ...i, character: { ...i.character, id: 'foreign' } },
    { ...i, character: { ...i.character, name: 'forged' } },
    { ...i, character: { ...i.character, sourceCardV2: { ...i.character.sourceCardV2, spec_version: '3.0' } } },
    { ...i, recentMessages: [createMessage(createConversation('foreign'), 'assistant', '秘密')] },
    { ...i, recentMessages: [createMessage(createConversation(i.character.id), 'assistant', '同角色其他会话秘密')] },
    { ...i, currentMessages: [{ ...i.currentMessages[0], role: 'system' }] }
  ]
  for (const value of cases) {
    expect((await worker.fetch(request(value), env)).status).toBe(400)
    expect(() => responseBody(value, env)).toThrow()
  }
  expect(upstream).not.toHaveBeenCalled()
})

it('isolates concurrent roles and conversations even when responses finish out of order', async () => {
  const a = input('a'), b = input('b'), bodies: string[] = [], finish: ((response: Response) => void)[] = []
  const worker = createWorker(vi.fn<typeof fetch>((_url, options) => { bodies.push(String(options?.body)); return new Promise(resolve => finish.push(resolve)) }))
  const first = worker.fetch(request(a), env)
  await vi.waitFor(() => expect(finish).toHaveLength(1))
  const second = worker.fetch(request(b), env)
  await vi.waitFor(() => expect(finish).toHaveLength(2))
  expect(bodies[0]).not.toContain('b私有问题'); expect(bodies[1]).not.toContain('a私有问题')
  expect(JSON.parse(JSON.parse(bodies[0]).input[1].content).data.name).toBe('a')
  expect(JSON.parse(JSON.parse(bodies[1]).input[1].content).data.name).toBe('b')
  finish[1](success(['b回复'])); expect(await (await second).json()).toEqual({ messages: ['b回复'] })
  finish[0](success(['a回复'])); expect(await (await first).json()).toEqual({ messages: ['a回复'] })
})

it('returns a bounded persona error without an upstream call, and retains API failure behavior', async () => {
  const i = input(), raw = fixtureCardV2()
  const source = { ...raw, data: { ...raw.data, description: '字'.repeat(8000), personality: '字'.repeat(10000), scenario: '字'.repeat(8000), mes_example: '字'.repeat(12000), extensions: { leivra: { schemaVersion: 1, id: 'a', customPrompt: '字'.repeat(12000) } } } }
  const upstream = vi.fn<typeof fetch>(async () => Response.json({ error: { message: 'private upstream detail' } }, { status: 500 }))
  const worker = createWorker(upstream)
  expect((await worker.fetch(request({ ...i, character: importCharacter(JSON.stringify(source)) }), env)).status).toBe(400)
  expect(upstream).not.toHaveBeenCalled()
  const failure = await worker.fetch(request({ ...i, turnId: crypto.randomUUID() }), env)
  expect(failure.status).toBe(502)
  expect(await failure.text()).not.toContain('private upstream detail')
  expect(upstream).toHaveBeenCalledTimes(1)
})
