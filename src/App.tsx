import { useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Check, Download, Leaf, MessageCircle, Moon, Settings2, ShieldCheck, Sparkles, Sun, Trash2, X } from 'lucide-react'
import { useRegisterSW } from 'virtual:pwa-register/react'
import { character, greeting, MAX_LENGTH, message, mockProvider, type Message } from './chat'
import { decodeMessages, saveMessages, STORAGE_KEY } from './storage'

function initialState() {
  try { return { messages: decodeMessages(localStorage.getItem(STORAGE_KEY)) ?? greeting(), error: '' } }
  catch { return { messages: greeting(), error: '本地记录无法读取，已开启临时会话。损坏的原记录不会被覆盖；请在设置中清空后重试。' } }
}
function initialTheme(): 'light' | 'dark' {
  try { const v = localStorage.getItem('leivra.theme'); if (v === 'dark' || v === 'light') return v } catch { /* session fallback */ }
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}
const clock = (time: number) => new Date(time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
export default function App() {
  const [initial] = useState(initialState)
  const [messages, setMessages] = useState<Message[]>(initial.messages)
  const [error, setError] = useState(initial.error)
  const [storageBlocked, setStorageBlocked] = useState(Boolean(initial.error))
  const [theme, setTheme] = useState(initialTheme)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [settings, setSettings] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  const [atBottom, setAtBottom] = useState(true)
  const [offline, setOffline] = useState(!navigator.onLine)
  const feed = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const settingsButton = useRef<HTMLButtonElement>(null)
  const controller = useRef<AbortController | null>(null)
  const nearBottom = useRef(true)
  const { needRefresh: [needRefresh, setNeedRefresh], updateServiceWorker } = useRegisterSW()
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#202923' : '#78917e')
    try { localStorage.setItem('leivra.theme', theme) } catch { /* theme remains usable for this session */ }
  }, [theme])
  useEffect(() => {
    if (storageBlocked) return
    try { saveMessages(messages) } catch { setError('浏览器无法保存消息。当前仍可聊天，但刷新后可能丢失记录。') }
  }, [messages, storageBlocked])
  useEffect(() => {
    if (nearBottom.current) feed.current?.scrollTo({ top: feed.current.scrollHeight, behavior: 'smooth' })
  }, [messages, busy])
  useEffect(() => {
    const online = () => setOffline(!navigator.onLine)
    window.addEventListener('online', online); window.addEventListener('offline', online)
    return () => { window.removeEventListener('online', online); window.removeEventListener('offline', online); controller.current?.abort() }
  }, [])
  useEffect(() => {
    if (settings) dialog.current?.showModal()
    else { dialog.current?.close() }
  }, [settings])
  function bottom() {
    nearBottom.current = true; setAtBottom(true)
    feed.current?.scrollTo({ top: feed.current.scrollHeight, behavior: 'smooth' })
  }
  async function send() {
    const text = draft.trim()
    if (!text || busy || controller.current || text.length > MAX_LENGTH) return
    const next = [...messages, message('user', text)].slice(-500)
    setMessages(next); setDraft(''); setBusy(true); nearBottom.current = true
    const request = new AbortController(); controller.current = request
    try {
      const replies = await mockProvider.reply(next, request.signal)
      if (!request.signal.aborted) setMessages(current => [...current, ...replies.map(text => message('assistant', text))].slice(-500))
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError')) setError('回复暂时失败，请稍后再试。')
    } finally {
      if (controller.current === request) { controller.current = null; setBusy(false) }
    }
  }
  function clear() {
    controller.current?.abort(); controller.current = null
    setBusy(false); setDraft(''); setMessages([]); setError('')
    try { localStorage.removeItem(STORAGE_KEY); setStorageBlocked(false) }
    catch { setStorageBlocked(true); setError('无法清除浏览器存储，请通过浏览器设置删除此站点数据。') }
    setConfirmClear(false); setSettings(false); nearBottom.current = true
  }
  function exportMessages() {
    const url = URL.createObjectURL(new Blob([JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), messages }, null, 2)], { type: 'application/json' }))
    const a = document.createElement('a'); a.href = url; a.download = 'leivra-messages.json'; a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return <div className="app-shell">
    <aside className="sidebar">
      <a className="brand" href="/" aria-label="Leivra 首页"><span className="brand-mark"><Leaf size={25}/></span><span>leivra<span className="brand-sub">留一处空间，慢慢说</span></span></a>
      <div className="nav-label">属于你的片刻</div>
      <div className="conversation active"><img src={character.avatar} alt="" /><div><strong>蕾芙菈</strong><p>{busy ? '正在输入…' : '我在，慢慢说。'}</p></div><span className="presence"/></div>
      <div className="sidebar-note"><span className="note-line"/><p>平常的日子，<br/>也有值得被听见的小事。</p><span>YOUR LITTLE QUIET CORNER</span></div>
      <div className="sidebar-bottom"><ShieldCheck size={17}/><span>此刻的对话，只留在此设备</span></div>
    </aside>
    <main className="chat">
      <header className="chat-header">
        <img className="header-avatar" src={character.avatar} alt="蕾芙菈头像"/>
        <div className="flex-1 min-w-0"><h1>蕾芙菈 <span className="desktop-tag">LEIVRA</span></h1><p><span className="status-dot"/>{offline ? '离线 · 本地模拟仍可使用' : '在这里，听你说'}</p></div>
        <span className="prototype-badge">本地原型</span>
        <button className="icon-button" onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')} aria-label={theme === 'light' ? '切换深色主题' : '切换浅色主题'}>{theme === 'light' ? <Moon size={20}/> : <Sun size={20}/>}</button>
        <button ref={settingsButton} className="icon-button" aria-label="聊天设置" onClick={() => setSettings(true)}><Settings2 size={20}/></button>
      </header>
      <div className="notice"><Sparkles size={14}/><span>这是我们的初次见面 · 当前回复由本地模拟生成</span></div>
      {error && <div role="alert" className="error-banner">{error}</div>}
      {needRefresh && <div className="update-banner">有新版本可用 <button onClick={() => void updateServiceWorker(true)}>刷新更新</button><button aria-label="稍后更新" onClick={() => setNeedRefresh(false)}><X size={16}/></button></div>}
      <div ref={feed} className="message-feed" role="log" aria-label="聊天记录" aria-live="polite" onScroll={() => {
        const el = feed.current!
        nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90
        setAtBottom(nearBottom.current)
      }}>
        <div className="welcome"><Leaf size={20}/><span>和蕾芙菈的日常</span><p>不必特别有趣，也不用每句话都有意义。</p></div>
        {messages.length === 0 && <p className="empty-state">从一句「你好」开始吧。</p>}
        {messages.map((m, i) => <div key={m.id}>
          {(i === 0 || new Date(messages[i-1].createdAt).toDateString() !== new Date(m.createdAt).toDateString()) && <div className="date-divider">{new Date(m.createdAt).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })}</div>}
          <article className={'message-row ' + m.role} aria-label={m.role === 'user' ? '我' : '蕾芙菈'}>
            <img className="avatar" src={m.role === 'assistant' ? character.avatar : character.userAvatar} alt=""/>
            <div className="message-content"><div className="bubble">{m.text}</div><time dateTime={new Date(m.createdAt).toISOString()}>{clock(m.createdAt)}{m.role === 'user' && <Check size={11} aria-label="已保存到当前会话"/>}</time></div>
          </article>
        </div>)}
        {busy && <div className="message-row assistant"><img className="avatar" src={character.avatar} alt=""/><div className="typing" role="status" aria-label="蕾芙菈正在输入"><i/><i/><i/></div></div>}
      </div>
      {!atBottom && <button className="jump-button" onClick={bottom}><ArrowDown size={15}/>回到最新消息</button>}
      <footer className="composer-area">
        <div className="composer-top"><span><MessageCircle size={15}/> 想到什么，就说什么</span><span className="keyboard-hint">Enter 发送 · Shift + Enter 换行</span></div>
        <form className="composer" onSubmit={e => { e.preventDefault(); void send() }}>
          <textarea ref={input} aria-label="消息" placeholder="和蕾芙菈说说话…" value={draft} maxLength={MAX_LENGTH} rows={2}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229 && !matchMedia('(pointer: coarse)').matches) { e.preventDefault(); void send() } }}/>
          <button type="submit" className="send-button" disabled={!draft.trim() || busy} aria-label="发送消息"><span>发送</span><ArrowUp size={18}/></button>
        </form>
        <div className="composer-bottom"><span><ShieldCheck size={12}/> 原型消息暂存于此浏览器，不会上传</span><span>{draft.length}/{MAX_LENGTH}</span></div>
      </footer>
    </main>
    <dialog ref={dialog} onCancel={() => { setSettings(false); setConfirmClear(false) }} onClose={() => { setSettings(false); settingsButton.current?.focus() }} className="settings-dialog">
      <div className="dialog-heading"><h2>聊天设置</h2><button className="icon-button" aria-label="关闭设置" onClick={() => { setSettings(false); setConfirmClear(false) }}><X size={20}/></button></div>
      <div className="profile-card"><img src={character.avatar} alt="蕾芙菈默认头像"/><div><strong>蕾芙菈</strong><p>温柔，也有自己的想法。</p></div></div>
      <p className="settings-description">当前是 UI 原型，回复为固定规则模拟，不具备真实理解或长期记忆。默认头像为项目自绘插画，可通过角色配置替换；上传功能留待后续。</p>
      <div className="privacy-card"><ShieldCheck size={20}/><div><strong>关于本地记录</strong><p>仅保留最近 500 条消息，未加密。共用浏览器的人可能查看记录；清理站点数据会使记录丢失。多标签页同步暂未支持。</p></div></div>
      <button className="setting-action" onClick={exportMessages}><Download size={18}/>导出本地测试记录 <span>JSON</span></button>
      <button className="setting-action danger" onClick={() => setConfirmClear(true)}><Trash2 size={18}/>清空本地聊天</button>
      {confirmClear && <div className="clear-confirm"><p>将删除此浏览器中的测试消息，无法撤销。</p><div><button onClick={() => setConfirmClear(false)}>取消</button><button className="danger" onClick={clear}>确认清空</button></div></div>}
      <p className="version">LEIVRA · v0.1.0 · 慢慢来，就很好</p>
    </dialog>
  </div>
}