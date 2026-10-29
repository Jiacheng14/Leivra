import { useEffect, useRef, useState } from 'react'
import { addCharacter, editCharacter, importCharacter, removeCharacter } from './characters/cards'
import { modelProvider } from './providers'
import { conversationMessages, MAX_LENGTH, type Character, type LocalData } from './models'
import { openDatabase, initializeData, readData, replaceData, writeData } from './indexedDb'
import { ConversationManager } from './scheduling/ConversationManager'
import { DEFAULT_CHAT_SETTINGS, validateChatSettings, type ChatSettings } from './scheduling/settings'
import { PageOwnership } from './pageOwnership'
import { createBackup, type Backup } from './backup'

const READ_ERROR = '本地数据无法读取，原记录不会被覆盖。请检查浏览器站点数据或从备份恢复。'
const OWNER_ERROR = '此页面为只读。请关闭其他 Leivra 页面；取得写入权限后可继续聊天。'
const LOCK_ERROR = '当前 HTTP 环境不支持安全的页面锁，聊天已设为只读。请在本机 localhost 或受信任的 HTTPS 环境使用。'

export function useChat() {
  const [data, setData] = useState<LocalData>(() => ({ schemaVersion: 1, activeCharacterId: null, characters: [], conversations: [], messages: [] }))
  const latestData = useRef(data)
  const database = useRef<IDBDatabase | null>(null)
  const writes = useRef<Promise<void>>(Promise.resolve())
  const [error, setError] = useState('')
  const [writable, setWritable] = useState(false)
  const [restoreAvailable, setRestoreAvailable] = useState(false)
  const [draft, setDraftValue] = useState('')
  const [settingsState, setSettingsState] = useState(() => validateChatSettings(DEFAULT_CHAT_SETTINGS))
  const manager = useRef<ConversationManager | null>(null)
  const owner = useRef<PageOwnership | null>(null)
  function requireStorage() {
    if (!database.current) throw new Error(READ_ERROR)
    if (!owner.current?.isOwner) throw new Error(owner.current?.available ? OWNER_ERROR : LOCK_ERROR)
  }
  function publish(next: LocalData) { latestData.current = next; setData(next) }
  function mutate(update: (current: LocalData) => LocalData): Promise<void> {
    const operation = writes.current.then(async () => {
      requireStorage()
      const next = update(latestData.current)
      await writeData(database.current!, next)
      publish(next)
      setError('')
    })
    writes.current = operation.catch(() => {})
    return operation.catch(cause => {
      setError('浏览器无法保存数据，回复已暂停。')
      throw cause
    })
  }
  useEffect(() => {
    const coordinator = new PageOwnership(navigator.locks, () => {
      void (async () => {
        let opened: IDBDatabase | null = null
        try {
          opened = await openDatabase()
          const fresh = await initializeData(opened)
          if (!coordinator.isOwner) { opened.close(); return }
          database.current = opened
          setRestoreAvailable(true)
          publish(fresh)
          setSettingsState(validateChatSettings(fresh.chatSettings ?? DEFAULT_CHAT_SETTINGS))
          setError(''); setWritable(true)
          manager.current = new ConversationManager(modelProvider, () => latestData.current, () => { throw new Error('需要事务写入。') }, mutate)
          manager.current.start()
          if (navigator.storage?.persist) void navigator.storage.persist().catch(() => {})
        } catch {
          if (coordinator.isOwner && opened) { database.current = opened; setRestoreAvailable(true) }
          else opened?.close()
          setError(READ_ERROR); setWritable(false)
        }
      })()
    }, async () => {
      manager.current?.dispose(); manager.current = null
      await writes.current
      database.current?.close(); database.current = null
      setRestoreAvailable(false)
      setWritable(false)
      setError(owner.current?.available ? OWNER_ERROR : LOCK_ERROR)
    }, () => {
      manager.current?.dispose(); manager.current = null
      database.current?.close(); database.current = null
      setRestoreAvailable(false)
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
  async function activate(id: string) {
    try {
      await mutate(current => current.characters.some(c => c.id === id) ? { ...current, activeCharacterId: id } : current)
      setDraftValue('')
    } catch (cause) { setError(cause instanceof Error ? cause.message : OWNER_ERROR) }
  }
  async function send() {
    const text = draft.trim()
    if (!conversation || !text || text.length > MAX_LENGTH) return
    try {
      requireStorage()
      if (!manager.current) throw new Error(OWNER_ERROR)
      const saved = await manager.current.send(conversation.id, text)
      if (saved) setDraftValue('')
      else setError('消息未保存，草稿已保留；回复已暂停。')
    } catch (cause) { setError(cause instanceof Error ? cause.message : '消息发送失败。') }
  }
  async function importCard(json: string) {
    await mutate(current => addCharacter(current, importCharacter(json)))
    setDraftValue('')
  }
  async function saveCard(changes: Omit<Character, 'id' | 'revision' | 'schemaVersion'>) {
    if (!character) throw new Error('请先添加联系人。')
    await mutate(current => editCharacter(current, character.id, changes))
  }
  async function clear() {
    if (!conversation) return
    const id = conversation.id
    manager.current?.cancel(id)
    try { await mutate(current => ({ ...current, messages: current.messages.filter(m => m.conversationId !== id), schedulerSnapshots: current.schedulerSnapshots?.filter(s => s.conversationId !== id) })) }
    catch (cause) { manager.current?.get(id); throw cause }
    setDraftValue('')
  }
  async function deleteContact(id: string) {
    const removed = latestData.current.conversations.filter(c => c.characterId === id)
    for (const c of removed) manager.current?.cancel(c.id)
    try { await mutate(current => removeCharacter(current, id)) }
    catch (cause) { for (const c of removed) manager.current?.get(c.id); throw cause }
    if (character?.id === id) setDraftValue('')
  }
  async function configure(settings: ChatSettings) {
    try {
      requireStorage()
      const validated = validateChatSettings(settings)
      setSettingsState(validated)
      await manager.current?.configure(validated)
    } catch (cause) {
      setSettingsState(validateChatSettings(latestData.current.chatSettings ?? DEFAULT_CHAT_SETTINGS))
      setError(cause instanceof Error ? cause.message : OWNER_ERROR)
    }
  }
  async function setThemePreference(theme: 'light' | 'dark') {
    await mutate(current => ({ ...current, theme }))
  }
  function retry() {
    if (!conversation || !manager.current) return
    try { requireStorage(); void manager.current.get(conversation.id).retry() }
    catch (cause) { setError(cause instanceof Error ? cause.message : OWNER_ERROR) }
  }
  async function ignoreModeSwitch() {
    if (!conversation || !manager.current) return
    try { requireStorage(); await manager.current.get(conversation.id).ignoreModeSwitch() }
    catch (cause) { setError(cause instanceof Error ? cause.message : OWNER_ERROR) }
  }
  async function exportBackup(): Promise<Backup> {
    requireStorage()
    await writes.current
    return createBackup(await readData(database.current!))
  }
  async function restoreBackup(backup: Backup): Promise<void> {
    requireStorage()
    setWritable(false)
    manager.current?.dispose(); manager.current = null
    await writes.current
    let valid = false
    try {
      await replaceData(database.current!, backup.data)
      const fresh = await readData(database.current!)
      publish(fresh); setDraftValue(''); setError('')
      setSettingsState(validateChatSettings(fresh.chatSettings ?? DEFAULT_CHAT_SETTINGS))
      valid = true
      setWritable(true)
    } catch (cause) {
      try {
        const fresh = await readData(database.current!)
        publish(fresh)
        setSettingsState(validateChatSettings(fresh.chatSettings ?? DEFAULT_CHAT_SETTINGS))
        valid = true; setWritable(true)
      }
      catch { setWritable(false) }
      throw cause
    } finally {
      if (valid) {
        manager.current = new ConversationManager(modelProvider, () => latestData.current, () => { throw new Error('需要事务写入。') }, mutate)
        manager.current.start()
      }
    }
  }
  return { data, character, conversation, messages, error, writable, draft, setDraft, busy, send, activate, importCard, saveCard, clear, deleteContact,
    chatSettings: settingsState, configure,
    replyError: currentSnapshot?.error, canIgnoreModeSwitch: currentSnapshot?.pauseReason === 'mode-switch', retry, ignoreModeSwitch,
    exportBackup, restoreBackup, setThemePreference, restoreAvailable }
}
