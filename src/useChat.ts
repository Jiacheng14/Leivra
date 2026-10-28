import { useEffect, useRef, useState } from 'react'
import { addCharacter, editCharacter, importCharacter, removeCharacter } from './characters/cards'
import { DEFAULT_CHARACTER_ID } from './characters/defaultLeivra'
import { modelProvider } from './providers'
import { conversationMessages, MAX_LENGTH, type Character, type LocalData } from './models'
import { createInitialData, LEGACY_STORAGE_KEY, loadData, saveData } from './storage'
import { ConversationManager } from './scheduling/ConversationManager'
import { DEFAULT_CHAT_SETTINGS, type ChatSettings } from './scheduling/settings'
function initialState() {
  try { return { data: loadData(), error: '', blocked: false } }
  catch { return { data: createInitialData([]), error: '本地数据无法读取，已开启临时会话。原记录不会被覆盖，请通过浏览器设置备份或修复站点数据。', blocked: true } }
}
export function useChat() {
  const [initial] = useState(initialState)
  const [data, setData] = useState(initial.data)
  const latestData = useRef(data)
  const [error, setError] = useState(initial.error)
  const [draft, setDraftValue] = useState('')
  const manager = useRef<ConversationManager | null>(null)
  function write(next: LocalData) {
    latestData.current = next
    setData(next)
    if (!initial.blocked) {
      try { saveData(next) } catch { setError('浏览器无法保存数据。当前仍可聊天，但刷新后可能丢失记录。') }
    }
  }
  useEffect(() => {
    const start = () => {
      if (manager.current) return
      manager.current = new ConversationManager(modelProvider, () => latestData.current, write)
      manager.current.start()
    }
    const stop = () => { manager.current?.dispose(); manager.current = null }
    start()
    window.addEventListener('pagehide', stop); window.addEventListener('pageshow', start)
    return () => { window.removeEventListener('pagehide', stop); window.removeEventListener('pageshow', start); stop() }
    // One manager per mounted page; callbacks read the synchronous data ref.
  }, [])
  const character = data.characters.find(c => c.id === data.activeCharacterId)
  const conversation = character ? data.conversations.find(c => c.characterId === character.id) : undefined
  const messages = conversation ? conversationMessages(data, conversation) : []
  const snapshot = data.schedulerSnapshots?.find(s => s.conversationId === conversation?.id)
  const busy = snapshot?.phase === 'Generating' || snapshot?.phase === 'Dispatching'
  function setDraft(value: string) {
    setDraftValue(value)
    if (conversation) manager.current?.get(conversation.id).inputActivity()
  }
  function activate(id: string) {
    const current = latestData.current
    if (id === current.activeCharacterId || !current.characters.some(c => c.id === id)) return
    setDraftValue(''); write({ ...current, activeCharacterId: id })
  }
  function send() {
    const text = draft.trim()
    if (!conversation || !text || text.length > MAX_LENGTH || !manager.current) return
    try { manager.current.send(conversation.id, text); setDraftValue('') }
    catch (e) { setError(e instanceof Error ? e.message : '消息发送失败。') }
  }
  function requireStorage() {
    if (initial.blocked) throw new Error('本地数据无法读取，暂不能保存人物卡。请先备份或修复浏览器站点数据。')
  }
  function importCard(json: string) {
    requireStorage()
    const next = addCharacter(latestData.current, importCharacter(json))
    try { saveData(next) } catch { throw new Error('人物卡未保存：浏览器存储不可用或空间不足。') }
    setDraftValue(''); write(next)
  }
  function saveCard(changes: Omit<Character, 'id' | 'revision' | 'schemaVersion'>) {
    requireStorage()
    if (!character) throw new Error('请先添加联系人。')
    const next = editCharacter(latestData.current, character.id, changes)
    try { saveData(next) } catch { throw new Error('人物卡未保存：浏览器存储不可用或空间不足。') }
    write(next)
  }
  function clear() {
    if (!character || !conversation) return
    manager.current?.cancel(conversation.id); setDraftValue('')
    const current = latestData.current
    const next = { ...current, messages: current.messages.filter(m => m.conversationId !== conversation.id), schedulerSnapshots: current.schedulerSnapshots?.filter(s=>s.conversationId!==conversation.id) }
    write(next)
    if (initial.blocked) { setError('临时会话已清空；无法读取的原数据仍保留。'); return }
    try {
      saveData(next)
      if (character.id === DEFAULT_CHARACTER_ID) localStorage.removeItem(LEGACY_STORAGE_KEY)
      setError('')
    } catch { setError('无法清除浏览器存储，请通过浏览器设置删除此站点数据。') }
  }
  function deleteContact(id: string) {
    requireStorage()
    const current = latestData.current, next = removeCharacter(current, id)
    try { saveData(next) } catch { throw new Error('联系人未删除：浏览器存储不可用，请重试。') }
    for (const c of current.conversations.filter(c=>c.characterId===id)) manager.current?.cancel(c.id)
    if (current.activeCharacterId === id) setDraftValue('')
    write(next)
    if (id === DEFAULT_CHARACTER_ID) {
      try { localStorage.removeItem(LEGACY_STORAGE_KEY) }
      catch { setError('联系人已删除，但旧版聊天备份无法清理。请通过浏览器设置删除该站点的旧版备份。') }
    }
  }
  function configure(settings: ChatSettings) { manager.current?.configure(settings) }
  function retry() { if (conversation) manager.current?.get(conversation.id).retry() }
  return { data, character, conversation, messages, error, draft, setDraft, busy, send, activate, importCard, saveCard, clear, deleteContact,
    chatSettings: data.chatSettings ?? DEFAULT_CHAT_SETTINGS, configure, replyError: snapshot?.error, retry }
}
