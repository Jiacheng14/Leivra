import { isRealMode } from './providers'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Check, CircleAlert, Download, Menu, Moon, Settings2, ShieldCheck, Sun, Trash2, X } from 'lucide-react'
import { useRegisterSW } from 'virtual:pwa-register/react'
import { MAX_LENGTH } from './models'
import { useChat } from './useChat'
import CharacterSettings from './CharacterSettings'
import ContactsSidebar from './ContactsSidebar'
import { downloadJson } from './download'
import { backupFilename, parseBackup, type Backup } from './backup'

function initialTheme(): 'light' | 'dark' {
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}
const clock = (time: number) => new Date(time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
export default function App() {
  const { data, character, conversation, messages, error, writable, restoreAvailable, draft, setDraft, busy, send: sendMessage, activate, importCard, saveCard, clear: clearMessages, deleteContact, chatSettings, configure, replyError, canIgnoreModeSwitch, retry, ignoreModeSwitch, exportBackup, restoreBackup, setThemePreference } = useChat()
  const [theme, setTheme] = useState(initialTheme)
  const [settings, setSettings] = useState(false)
  const [contactsOpen, setContactsOpen] = useState(false)
  const closeContacts = useCallback(() => setContactsOpen(false), [])
  const [confirmClear, setConfirmClear] = useState(false)
  const [restoreCandidate, setRestoreCandidate] = useState<Backup | null>(null)
  const [backupError, setBackupError] = useState('')
  const [restoring, setRestoring] = useState(false)
  const backupFile = useRef<HTMLInputElement>(null)
  const [atBottom, setAtBottom] = useState(true)
  const [offline, setOffline] = useState(!navigator.onLine)
  const feed = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const settingsButton = useRef<HTMLButtonElement>(null)
  const nearBottom = useRef(true)
  const { needRefresh: [needRefresh, setNeedRefresh], updateServiceWorker } = useRegisterSW()
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#202923' : '#78917e')
  }, [theme])
  useEffect(() => { if (data.theme) setTheme(data.theme) }, [data.theme])
  useEffect(() => {
    if (nearBottom.current) feed.current?.scrollTo({ top: feed.current.scrollHeight, behavior: 'smooth' })
  }, [messages, busy])
  useEffect(() => {
    const online = () => setOffline(!navigator.onLine)
    window.addEventListener('online', online); window.addEventListener('offline', online)
    return () => { window.removeEventListener('online', online); window.removeEventListener('offline', online) }
  }, [])
  useEffect(() => {
    if (settings) dialog.current?.showModal()
    else dialog.current?.close()
  }, [settings])
  function bottom() {
    nearBottom.current = true; setAtBottom(true)
    feed.current?.scrollTo({ top: feed.current.scrollHeight, behavior: 'smooth' })
  }
  function send() {
    nearBottom.current = true
    return sendMessage()
  }
  useEffect(() => {
    document.title = character ? 'Leivra · ' + character.name : 'Leivra'
    nearBottom.current = true; setAtBottom(true)
    feed.current?.scrollTo({ top: feed.current.scrollHeight })
  }, [character?.id, character?.name])
  async function clear() {
    try { await clearMessages(); setConfirmClear(false); setSettings(false); nearBottom.current = true }
    catch (cause) { setBackupError(cause instanceof Error ? cause.message : '清空失败。') }
  }
  async function exportCompleteBackup() {
    try { setBackupError(''); downloadJson(backupFilename(), JSON.stringify(await exportBackup(), null, 2)) }
    catch (cause) { setBackupError(cause instanceof Error ? cause.message : '备份导出失败。') }
  }
  async function confirmRestore() {
    if (!restoreCandidate || restoring) return
    setRestoring(true)
    try {
      await restoreBackup(restoreCandidate)
      setRestoreCandidate(null); setBackupError(''); setSettings(false); nearBottom.current = true
    } catch (cause) { setBackupError(cause instanceof Error ? cause.message : '恢复失败，原有数据已保留。') }
    finally { setRestoring(false) }
  }
  return <div className="app-shell">
    <ContactsSidebar characters={data.characters} activeId={data.activeCharacterId} open={contactsOpen} onClose={closeContacts} onSelect={activate} onImport={importCard} onDelete={deleteContact}/>
    <main className="chat">
      <header className="chat-header">
        <button type="button" className="icon-button contacts-toggle" aria-label="打开联系人" aria-haspopup="dialog" aria-expanded={contactsOpen} onClick={() => setContactsOpen(true)}><Menu size={20}/></button>
        {character && <img className="header-avatar" src={character.avatar} alt={character.name + '头像'}/>}
        <div className="flex-1 min-w-0"><h1><span className="role-name">{character?.name ?? 'Leivra'}</span>{character && <span className="desktop-tag">LEIVRA</span>}</h1>{offline && <p>{isRealMode ? '离线 · 真实回复需要网络' : '离线 · 本地模拟仍可使用'}</p>}</div>
        <span className="prototype-badge">本地原型</span>
        <button className="icon-button" disabled={!writable} onClick={() => void setThemePreference(theme === 'light' ? 'dark' : 'light').catch(() => {})} aria-label={theme === 'light' ? '切换深色主题' : '切换浅色主题'}>{theme === 'light' ? <Moon size={20}/> : <Sun size={20}/>}</button>
        <button ref={settingsButton} className="icon-button" aria-label="聊天设置" onClick={() => setSettings(true)}><Settings2 size={20}/></button>
      </header>
      {replyError && <div role="alert" className="error-banner reply-error-banner"><span>{replyError}</span><button onClick={retry} disabled={!writable}>重试回复</button>{canIgnoreModeSwitch && <button type="button" className="ignore-button" aria-label="忽略待回复任务" disabled={!writable} onClick={() => void ignoreModeSwitch()}><X size={16}/></button>}</div>}
      {error && <div role="alert" className="error-banner">{error}</div>}
      {needRefresh && <div className="update-banner">有新版本可用 <button onClick={() => void updateServiceWorker(true)}>刷新更新</button><button aria-label="稍后更新" onClick={() => setNeedRefresh(false)}><X size={16}/></button></div>}
      <div ref={feed} className="message-feed" role="log" aria-label="聊天记录" aria-live="polite" onScroll={() => {
        const el = feed.current!
        nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90
        setAtBottom(nearBottom.current)
      }}>
        {!character ? <p className="empty-state">暂无联系人</p> : <>
          {messages.length === 0 && <p className="empty-state">从一句「你好」开始吧。</p>}
          {messages.map((m, i) => <div key={m.id}>
            {(i === 0 || new Date(messages[i-1].createdAt).toDateString() !== new Date(m.createdAt).toDateString()) && <div className="date-divider">{new Date(m.createdAt).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })}</div>}
            <article className={'message-row ' + m.role} aria-label={m.role === 'user' ? '我' : character.name}>
              <img className="avatar" src={m.role === 'assistant' ? character.avatar : '/user.svg'} alt=""/>
              <div className="message-content"><div className="bubble">{m.text}</div><time dateTime={new Date(m.createdAt).toISOString()}>{clock(m.createdAt)}{m.replyIgnored ? <CircleAlert className="reply-ignored-icon" size={13} aria-label="回复任务已忽略"/> : m.role === 'user' && <Check size={11} aria-label="已保存到当前会话"/>}</time></div>
            </article>
          </div>)}
          {busy && <div className="message-row assistant"><img className="avatar" src={character.avatar} alt=""/><div className="typing" role="status" aria-label={character.name + '正在输入'}><i/><i/><i/></div></div>}
        </>}
      </div>
      {character && !atBottom && <button className="jump-button" onClick={bottom}><ArrowDown size={15}/>回到最新消息</button>}
      {character && <footer className="composer-area">
        <div className="composer-top"><span className="keyboard-hint ml-auto">Enter 发送 · Shift + Enter 换行</span></div>
        <form className="composer" onSubmit={e => { e.preventDefault(); void send() }}>
          <textarea ref={input} aria-label="消息" placeholder={'和' + character.name + '说说话…'} value={draft} maxLength={MAX_LENGTH} rows={2} disabled={!writable}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229 && !matchMedia('(pointer: coarse)').matches) { e.preventDefault(); void send() } }}/>
          <button type="submit" className="send-button" disabled={!writable || !draft.trim()} aria-label="发送消息"><span>发送</span><ArrowUp size={18}/></button>
        </form>
        <div className="composer-bottom"><span><ShieldCheck size={12}/> {isRealMode ? '记录保存在本机；回复时将相关上下文发送至 OpenAI' : '消息保存在此浏览器，不会上传'}</span><span>{draft.length}/{MAX_LENGTH}</span></div>
      </footer>}
    </main>
    <dialog ref={dialog} onCancel={() => { setSettings(false); setConfirmClear(false); setRestoreCandidate(null) }} onClose={() => { setSettings(false); setRestoreCandidate(null); settingsButton.current?.focus() }} className="settings-dialog">
      <div className="dialog-heading"><h2>聊天设置</h2><button className="icon-button" aria-label="关闭设置" onClick={() => { setSettings(false); setConfirmClear(false) }}><X size={20}/></button></div>
      {character && <div className="profile-card"><img src={character.avatar} alt={character.name + '头像'}/><div><strong>{character.name}</strong><p>{character.speakingStyle}</p></div></div>}
      <p className="settings-description">{isRealMode ? '当前使用 OpenAI API，按用量计费。人物卡与当前会话的近期上下文经本地后端发送；没有长期记忆。失败不会切换为模拟回复。' : '当前是 UI 原型，回复为固定规则模拟，不具备真实理解或长期记忆。人物卡可在下方编辑或导出，添加联系人请使用侧栏；Mock 不模拟自定义人格提示词。'}</p>
      <div className="chat-timing-settings">
        <label htmlFor="reply-wait">回复等待时间 <output>{chatSettings.replyWaitMs / 1000} 秒</output></label>
        <input id="reply-wait" type="range" min="1" max="60" step="1" value={chatSettings.replyWaitMs / 1000} disabled={!writable} onChange={e=>configure({...chatSettings, replyWaitMs:Number(e.target.value)*1000})}/>
        <label htmlFor="max-wait">最大等待时间 <output>{chatSettings.maxWaitMs === null ? '不限' : `${chatSettings.maxWaitMs / 60000} 分钟`}</output></label>
        <input id="max-wait" type="range" min="1" max="10.5" step="0.5" value={chatSettings.maxWaitMs === null ? 10.5 : chatSettings.maxWaitMs / 60000} disabled={!writable} onChange={e=>configure({...chatSettings, maxWaitMs:Number(e.target.value) === 10.5 ? null : Number(e.target.value)*60000})}/>
        <label><input type="checkbox" checked={chatSettings.deferWhileTyping} disabled={!writable} onChange={e=>configure({...chatSettings,deferWhileTyping:e.target.checked})}/>正在输入时延后回复</label>
      </div>
      <div className="privacy-card"><ShieldCheck size={20}/><div><strong>关于本地记录</strong><p>记录保存在此浏览器的 IndexedDB，未加密。共用浏览器的人可能查看；清理站点数据仍可能使记录丢失，请妥善保存备份。多标签页同步暂未支持。</p></div></div>
      <button className="setting-action" disabled={!writable || restoring} onClick={() => void exportCompleteBackup()}><Download size={18}/>导出完整备份 <span>JSON</span></button>
      <button className="setting-action" disabled={!restoreAvailable || restoring} onClick={() => backupFile.current?.click()}>从备份恢复</button>
      <input ref={backupFile} className="contact-file" type="file" accept=".json,application/json" aria-label="选择 Leivra 备份" onChange={async e => {
        const file = e.target.files?.[0]; e.target.value = ''
        if (!file) return
        try { setBackupError(''); setRestoreCandidate(parseBackup(await file.text())) }
        catch (cause) { setRestoreCandidate(null); setBackupError(cause instanceof Error ? cause.message : '备份文件无效。') }
      }}/>
      {restoreCandidate && <div className="clear-confirm"><p>备份时间：{new Date(restoreCandidate.exportedAt).toLocaleString('zh-CN')}；角色 {restoreCandidate.data.characters.length}，会话 {restoreCandidate.data.conversations.length}，消息 {restoreCandidate.data.messages.length}。确认后将完整替换当前本地数据。</p><div><button disabled={restoring} onClick={() => setRestoreCandidate(null)}>取消</button><button className="danger" disabled={restoring} onClick={() => void confirmRestore()}>确认恢复</button></div></div>}
      {backupError && <p role="alert" className="card-error">{backupError}</p>}
      {character && <>
        <CharacterSettings key={character.id} character={character} onSave={saveCard}/>
        <button className="setting-action danger" onClick={() => setConfirmClear(true)}><Trash2 size={18}/>清空本地聊天</button>
        {confirmClear && <div className="clear-confirm"><p>将删除当前角色在此浏览器中的消息，无法撤销。</p><div><button onClick={() => setConfirmClear(false)}>取消</button><button className="danger" onClick={() => void clear()}>确认清空</button></div></div>}
      </>}
      <p className="version">LEIVRA · v0.1.0 · 慢慢来，就很好</p>
    </dialog>
  </div>
}
