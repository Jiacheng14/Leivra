import { useEffect, useRef, useState } from 'react'
import { addCharacter, editCharacter, importCharacter, removeCharacter } from './characters/cards'
import { modelProvider } from './providers'
import { conversationMessages, MAX_LENGTH, type Character, type LocalData } from './models'
import { openDatabase, initializeData, readData, readRollbackData, replaceData, writeData } from './indexedDb'
import { ConversationManager } from './scheduling/ConversationManager'
import { DEFAULT_CHAT_SETTINGS, validateChatSettings, type ChatSettings } from './scheduling/settings'
import { PageOwnership } from './pageOwnership'
import { createBackup, prepareRestore, type Backup } from './backup'

const READ_ERROR = '本地数据无法读取，原记录不会被覆盖。请检查浏览器站点数据或从备份恢复。'
const OWNER_ERROR = '此页面为只读。请关闭其他 Leivra 页面；取得写入权限后可继续聊天。'
const LOCK_ERROR = '当前 HTTP 环境不支持安全的页面锁，聊天已设为只读。请在本机 localhost 或受信任的 HTTPS 环境使用。'

export function useChat() {
  const [data, setData] = useState<LocalData>(() => ({ schemaVersion: 1, activeCharacterId: null, characters: [], conversations: [], messages: [] }))
  const latestData = useRef(data)
  const database = useRef<IDBDatabase | null>(null)
  const writes = useRef<Promise<void>>(Promise.resolve())
  const initialized = useRef(false)
  const restoring = useRef(false)
  const sessionEpoch = useRef(0)
  const [error, setError] = useState('')
  const [writable, setWritable] = useState(false)
  const [restoreAvailable, setRestoreAvailable] = useState(false)
  const [draft, setDraftValue] = useState('')
  const draftVersion = useRef(0)
  const sending = useRef(new Set<number>())
  const [settingsState, setSettingsState] = useState(() => validateChatSettings(DEFAULT_CHAT_SETTINGS))
  const manager = useRef<ConversationManager | null>(null)
  const owner = useRef<PageOwnership | null>(null)
  function requireStorage(allowUninitialized = false) {
    if (!database.current) throw new Error(READ_ERROR)
    if (!owner.current?.isOwner) throw new Error(owner.current?.available ? OWNER_ERROR : LOCK_ERROR)
    if (!allowUninitialized && !initialized.current) throw new Error(READ_ERROR)
    return database.current
  }
  function requireWritable() {
    if (restoring.current) throw new Error('正在恢复备份，请稍候。')
    return requireStorage()
  }
  function updateDraft(value: string) { draftVersion.current++; setDraftValue(value) }
  function queue<T>(action: () => Promise<T>): Promise<T> {
    const operation = writes.current.then(action)
    writes.current = operation.then(() => {}, () => {})
    return operation
  }
  function startManager() {
    const epoch = sessionEpoch.current
    manager.current = new ConversationManager(modelProvider, () => latestData.current, () => { throw new Error('需要事务写入。') }, update => {
      if (epoch !== sessionEpoch.current) return Promise.reject(new Error('会话已关闭。'))
      return mutate(update)
    })
    manager.current.start()
  }
  function publish(next: LocalData) { latestData.current = next; setData(next) }
  function mutate(update: (current: LocalData) => LocalData): Promise<void> {
    const db = requireWritable()
    const epoch = sessionEpoch.current
    const operation = queue(async () => {
      requireStorage()
      if (epoch !== sessionEpoch.current) throw new Error('数据操作已取消。')
      const next = update(latestData.current)
      await writeData(db, next)
      publish(next)
      setError('')
    })
    return operation.catch(cause => {
      setError('浏览器无法保存数据，回复已暂停。')
      throw cause
    })
  }
  useEffect(() => {
    const coordinator = new PageOwnership(navigator.locks, () => {
      initialized.current = false
      sessionEpoch.current++
      // Initialization is part of the same lifecycle barrier as writes and restore.
      void queue(async () => {
        let opened: IDBDatabase | null = null
        try {
          opened = await openDatabase()
          if (!coordinator.isOwner) { opened.close(); return }
          database.current = opened
          const fresh = await initializeData(opened)
          if (!coordinator.isOwner) return
          initialized.current = true
          setRestoreAvailable(true)
          publish(fresh)
          setSettingsState(validateChatSettings(fresh.chatSettings ?? DEFAULT_CHAT_SETTINGS))
          setError(''); setWritable(true)
          startManager()
          if (navigator.storage?.persist) void navigator.storage.persist().catch(() => {})
        } catch {
          if (coordinator.isOwner && opened) { database.current = opened; setRestoreAvailable(true) }
          else opened?.close()
          if (coordinator.isOwner) { setError(READ_ERROR); setWritable(false) }
        }
      })
    }, async () => {
      initialized.current = false
      sessionEpoch.current++
      manager.current?.dispose(); manager.current = null
      setWritable(false)
      await writes.current
      database.current?.close(); database.current = null
      setRestoreAvailable(false)
      setWritable(false)
      setError(owner.current?.available ? OWNER_ERROR : LOCK_ERROR)
    }, () => {
      initialized.current = false
      sessionEpoch.current++
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
    updateDraft(value)
    if (writable && conversation) manager.current?.get(conversation.id).inputActivity()
  }
  async function activate(id: string) {
    try {
      await mutate(current => current.characters.some(c => c.id === id) ? { ...current, activeCharacterId: id } : current)
      updateDraft('')
    } catch (cause) { setError(cause instanceof Error ? cause.message : OWNER_ERROR) }
  }
  async function send() {
    const text = draft.trim()
    if (!conversation || !text || text.length > MAX_LENGTH) return
    const version = draftVersion.current
    if (sending.current.has(version)) return
    sending.current.add(version)
    try {
      requireWritable()
      if (!manager.current) throw new Error(OWNER_ERROR)
      const saved = await manager.current.send(conversation.id, text)
      if (saved) {
        if (draftVersion.current === version) updateDraft('')
      }
      else setError('消息未保存，草稿已保留；回复已暂停。')
    } catch (cause) { setError(cause instanceof Error ? cause.message : '消息发送失败。') }
    finally { sending.current.delete(version) }
  }
  async function importCard(json: string) {
    await mutate(current => addCharacter(current, importCharacter(json)))
    updateDraft('')
  }
  async function saveCard(changes: Omit<Character, 'id' | 'revision' | 'schemaVersion'>) {
    if (!character) throw new Error('请先添加联系人。')
    await mutate(current => editCharacter(current, character.id, changes))
  }
  async function clear() {
    requireWritable()
    if (!conversation) return
    const id = conversation.id
    manager.current?.cancel(id)
    try { await mutate(current => ({ ...current, messages: current.messages.filter(m => m.conversationId !== id), schedulerSnapshots: current.schedulerSnapshots?.filter(s => s.conversationId !== id) })) }
    catch (cause) { if (!restoring.current && initialized.current) manager.current?.get(id); throw cause }
    updateDraft('')
  }
  async function deleteContact(id: string) {
    requireWritable()
    const removed = latestData.current.conversations.filter(c => c.characterId === id)
    for (const c of removed) manager.current?.cancel(c.id)
    try { await mutate(current => removeCharacter(current, id)) }
    catch (cause) { if (!restoring.current && initialized.current) for (const c of removed) manager.current?.get(c.id); throw cause }
    if (character?.id === id) updateDraft('')
  }
  async function configure(settings: ChatSettings) {
    try {
      requireWritable()
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
    try { requireWritable(); void manager.current.get(conversation.id).retry() }
    catch (cause) { setError(cause instanceof Error ? cause.message : OWNER_ERROR) }
  }
  async function ignoreModeSwitch() {
    if (!conversation || !manager.current) return
    try { requireWritable(); await manager.current.get(conversation.id).ignoreModeSwitch() }
    catch (cause) { setError(cause instanceof Error ? cause.message : OWNER_ERROR) }
  }
  async function exportBackup(): Promise<Backup> {
    const db = requireWritable()
    return queue(async () => { requireStorage(); return createBackup(await readData(db)) })
  }
  async function exportRollbackBackup(): Promise<Backup> {
    const db = requireStorage(true)
    if (restoring.current) throw new Error('正在恢复备份，请稍候。')
    return queue(async () => {
      requireStorage(true)
      const previous = await readRollbackData(db)
      if (!previous) throw new Error('没有恢复前快照。')
      return createBackup(previous)
    })
  }
  async function restoreBackup(backup: Backup): Promise<void> {
    const db = requireStorage(true)
    if (restoring.current) throw new Error('正在恢复备份，请稍候。')
    const replacement = prepareRestore(backup.data)
    restoring.current = true
    initialized.current = false
    sessionEpoch.current++
    setWritable(false)
    manager.current?.dispose(); manager.current = null
    await queue(async () => {
      const loadFresh = async () => {
        const fresh = await readData(db)
        if (!owner.current?.isOwner) return
        publish(fresh)
        setSettingsState(validateChatSettings(fresh.chatSettings ?? DEFAULT_CHAT_SETTINGS))
        initialized.current = true
      }
      try {
        requireStorage(true)
        await replaceData(db, replacement)
        await loadFresh()
        updateDraft(''); setError('')
      } catch (cause) {
        try { await loadFresh() }
        catch { initialized.current = false }
        throw cause
      } finally {
        restoring.current = false
        const ready = initialized.current && Boolean(owner.current?.isOwner)
        setWritable(ready)
        if (ready) startManager()
      }
    })
  }
  return { data, character, conversation, messages, error, writable, draft, setDraft, busy, send, activate, importCard, saveCard, clear, deleteContact,
    chatSettings: settingsState, configure,
    replyError: currentSnapshot?.error, canIgnoreModeSwitch: currentSnapshot?.pauseReason === 'mode-switch', retry, ignoreModeSwitch,
    exportBackup, exportRollbackBackup, restoreBackup, setThemePreference, restoreAvailable }
}
