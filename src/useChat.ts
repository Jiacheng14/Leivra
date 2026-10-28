import { useEffect, useRef, useState } from 'react'
import { addCharacter, editCharacter, importCharacter, removeCharacter } from './characters/cards'
import { DEFAULT_CHARACTER_ID } from './characters/defaultLeivra'
import { modelProvider } from './providers'
import { conversationMessages, MAX_LENGTH, type Character, type LocalData } from './models'
import { createInitialData, LEGACY_STORAGE_KEY, loadData, saveData } from './storage'
import { ConversationManager } from './scheduling/ConversationManager'
import { DEFAULT_CHAT_SETTINGS, type ChatSettings } from './scheduling/settings'
import { PageOwnership } from './pageOwnership'

const READ_ERROR = '本地数据无法读取，原记录不会被覆盖。请通过浏览器设置备份或修复站点数据。'
const OWNER_ERROR = '此页面为只读。请关闭其他 Leivra 页面；取得写入权限后可继续聊天。'
const LOCK_ERROR = '当前 HTTP 环境不支持安全的页面锁，聊天已设为只读。请在本机 localhost 或受信任的 HTTPS 环境使用。'
function initialState() {
  try { return { data: loadData(), error: '', blocked: false } }
  catch { return { data: createInitialData([]), error: READ_ERROR, blocked: true } }
}
export function useChat() {
  const [initial] = useState(initialState)
  const [data, setData] = useState(initial.data)
  const latestData = useRef(data)
  const storageBlocked = useRef(initial.blocked)
  const [error, setError] = useState(initial.error)
  const [writable, setWritable] = useState(false)
  const [draft, setDraftValue] = useState('')
  const manager = useRef<ConversationManager | null>(null)
  const owner = useRef<PageOwnership | null>(null)
  function requireStorage() {
    if (storageBlocked.current) throw new Error(READ_ERROR)
    if (!owner.current?.isOwner) throw new Error(owner.current?.available ? OWNER_ERROR : LOCK_ERROR)
  }
  function publish(next: LocalData) { latestData.current = next; setData(next) }
  function write(next: LocalData) {
    requireStorage()
    // Keep a failed user message visible in this page, but never report a durable commit.
    publish(next)
    try { saveData(next); setError('') }
    catch (cause) { setError('浏览器无法保存数据，回复已暂停。'); throw cause }
  }
  useEffect(() => {
    const coordinator = new PageOwnership(navigator.locks, () => {
      try {
        const fresh = loadData()
        storageBlocked.current = false
        publish(fresh)
        setError(''); setWritable(true)
        manager.current = new ConversationManager(modelProvider, () => latestData.current, write)
        manager.current.start()
      } catch {
        storageBlocked.current = true
        setError(READ_ERROR); setWritable(false)
      }
    }, () => {
      manager.current?.dispose(); manager.current = null
      setWritable(false)
      setError(owner.current?.available ? OWNER_ERROR : LOCK_ERROR)
    }, () => {
      manager.current?.dispose(); manager.current = null
      setWritable(false); setError(LOCK_ERROR)
    })
    owner.current = coordinator
    setError(coordinator.available ? OWNER_ERROR : LOCK_ERROR)
    coordinator.start()
    const stop = () => coordinator.stop()
    const start = () => coordinator.start()
    window.addEventListener('pagehide', stop); window.addEventListener('pageshow', start)
    return () => {
      window.removeEventListener('pagehide', stop); window.removeEventListener('pageshow', start)
      coordinator.stop(); if (owner.current === coordinator) owner.current = null
    }
  }, [])
  const character = data.characters.find(c => c.id === data.activeCharacterId)
  const conversation = character ? data.conversations.find(c => c.characterId === character.id) : undefined
  const messages = conversation ? conversationMessages(data, conversation) : []
  const snapshot = data.schedulerSnapshots?.find(s => s.conversationId === conversation?.id)
  const currentSnapshot = conversation ? manager.current?.peek(conversation.id)?.snapshot() ?? snapshot : undefined
  const busy = currentSnapshot?.phase === 'Generating' || currentSnapshot?.phase === 'Dispatching'
  function setDraft(value: string) {
    setDraftValue(value)
    if (writable && conversation) manager.current?.get(conversation.id).inputActivity()
  }
  function activate(id: string) {
    try {
      requireStorage()
      const current = latestData.current
      if (id === current.activeCharacterId || !current.characters.some(c => c.id === id)) return
      write({ ...current, activeCharacterId: id }); setDraftValue('')
    } catch (cause) { setError(cause instanceof Error ? cause.message : OWNER_ERROR) }
  }
  async function send() {
    const text = draft.trim()
    if (!conversation || !text || text.length > MAX_LENGTH) return
    try {
      requireStorage()
      if (!manager.current) throw new Error(OWNER_ERROR)
      const saved = await manager.current.send(conversation.id, text)
      setDraftValue('')
      if (!saved) setError('消息暂存于当前页面，但本地保存失败；回复已暂停。')
    } catch (cause) { setError(cause instanceof Error ? cause.message : '消息发送失败。') }
  }
  function saveCardData(next: LocalData, failure: string) {
    requireStorage()
    try { saveData(next) } catch { throw new Error(failure) }
    publish(next); setError('')
  }
  function importCard(json: string) {
    requireStorage()
    const next = addCharacter(latestData.current, importCharacter(json))
    saveCardData(next, '人物卡未保存：浏览器存储不可用或空间不足。')
    setDraftValue('')
  }
  function saveCard(changes: Omit<Character, 'id' | 'revision' | 'schemaVersion'>) {
    requireStorage()
    if (!character) throw new Error('请先添加联系人。')
    saveCardData(editCharacter(latestData.current, character.id, changes), '人物卡未保存：浏览器存储不可用或空间不足。')
  }
  function clear() {
    if (!character || !conversation) return
    try {
      requireStorage()
      const current = latestData.current
      const next = { ...current, messages: current.messages.filter(m => m.conversationId !== conversation.id), schedulerSnapshots: current.schedulerSnapshots?.filter(s => s.conversationId !== conversation.id) }
      saveData(next)
      manager.current?.cancel(conversation.id)
      publish(next); setDraftValue(''); setError('')
      if (character.id === DEFAULT_CHARACTER_ID) localStorage.removeItem(LEGACY_STORAGE_KEY)
    } catch { setError('无法清除浏览器存储或此页面无写入权限。') }
  }
  function deleteContact(id: string) {
    requireStorage()
    const current = latestData.current, next = removeCharacter(current, id)
    saveCardData(next, '联系人未删除：浏览器存储不可用，请重试。')
    for (const c of current.conversations.filter(c => c.characterId === id)) manager.current?.cancel(c.id)
    if (current.activeCharacterId === id) setDraftValue('')
    if (id === DEFAULT_CHARACTER_ID) {
      try { localStorage.removeItem(LEGACY_STORAGE_KEY) }
      catch { setError('联系人已删除，但旧版聊天备份无法清理。请通过浏览器设置删除该站点的旧版备份。') }
    }
  }
  function configure(settings: ChatSettings) {
    try { requireStorage(); manager.current?.configure(settings) }
    catch (cause) { setError(cause instanceof Error ? cause.message : OWNER_ERROR) }
  }
  function retry() {
    if (!conversation || !manager.current) return
    try { requireStorage(); void manager.current.get(conversation.id).retry() }
    catch (cause) { setError(cause instanceof Error ? cause.message : OWNER_ERROR) }
  }
  return { data, character, conversation, messages, error, writable, draft, setDraft, busy, send, activate, importCard, saveCard, clear, deleteContact,
    chatSettings: data.chatSettings ?? DEFAULT_CHAT_SETTINGS, configure,
    replyError: currentSnapshot?.error, retry }
}
