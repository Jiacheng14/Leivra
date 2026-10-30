import { isRealMode } from './providers'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Leaf, Plus, ShieldCheck, Trash2, X } from 'lucide-react'
import type { Character } from './models'
import { CARD_LIMIT_BYTES } from './characters/cards'

interface Props {
  writable: boolean
  characters: Character[]
  activeId: string | null
  open: boolean
  onClose(): void
  onSelect(id: string): void | Promise<void>
  onImport(json: string): void | Promise<void>
  onDelete(id: string): void | Promise<void>
}
export default function ContactsSidebar({ characters, activeId, writable, open, onClose, onSelect, onImport, onDelete }: Props) {
  const [mobile, setMobile] = useState(() => matchMedia('(max-width: 700px)').matches)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [deleteError, setDeleteError] = useState('')
  const drawer = useRef<HTMLDialogElement>(null)
  const confirmation = useRef<HTMLDialogElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const addButton = useRef<HTMLButtonElement>(null)
  const deleteTrigger = useRef<HTMLElement | null>(null)
  const deleting = characters.find(c => c.id === deletingId)
  const closeConfirmation = useCallback(() => { setDeletingId(null); setDeleteError('') }, [])
  useEffect(() => {
    const query = matchMedia('(max-width: 700px)')
    const change = () => { setMobile(query.matches); onClose() }
    query.addEventListener('change', change)
    return () => query.removeEventListener('change', change)
  }, [onClose])
  useEffect(() => {
    if (mobile && open) drawer.current?.showModal()
    else drawer.current?.close()
  }, [mobile, open])
  useEffect(() => {
    if (deleting) confirmation.current?.showModal()
    else confirmation.current?.close()
  }, [deleting])
  const content = <aside className="sidebar" aria-label="联系人">
    <div className="sidebar-top">
      <a className="brand" href="/" aria-label="Leivra 首页"><span className="brand-mark"><Leaf size={25}/></span><span>leivra<span className="brand-sub">我的目光永远注视着你</span></span></a>
      {mobile && <button type="button" className="icon-button" aria-label="关闭联系人" onClick={onClose}><X size={20}/></button>}
    </div>
    <h2 className="nav-label">联系人</h2>
    <div className="contact-list">{characters.map(contact => <div className="contact-entry" key={contact.id} data-character-id={contact.id}>
      <button type="button" disabled={!writable} className={'conversation ' + (contact.id === activeId ? 'active' : '')} aria-label={'联系 ' + contact.name} aria-current={contact.id === activeId ? 'true' : undefined} onClick={() => { onSelect(contact.id); onClose() }}>
        <img src={contact.avatar} alt=""/><div><strong>{contact.name}</strong></div>{contact.id === activeId && <span className="presence"/>}
      </button>
      <button type="button" disabled={!writable} className="icon-button contact-delete" aria-label={'删除联系人 ' + contact.name} onClick={e => {
        deleteTrigger.current = e.currentTarget
        setDeleteError(''); setDeletingId(contact.id)
      }}><Trash2 size={16}/></button>
    </div>)}</div>
    <button ref={addButton} type="button" disabled={!writable} className="setting-action add-contact" onClick={() => fileInput.current?.click()}><Plus size={18}/>添加联系人</button>
    <input ref={fileInput} disabled={!writable} className="contact-file" type="file" accept=".json,application/json" aria-label="导入人物卡" onChange={async e => {
      const file = e.target.files?.[0]; e.target.value = ''
      if (!file) return
      setError('')
      try {
        if (file.size > CARD_LIMIT_BYTES) throw new Error('人物卡文件不得超过 256 KiB。')
        await onImport(await file.text()); onClose()
      } catch (error) { setError(error instanceof Error ? error.message : '人物卡导入失败。') }
    }}/>
    {error && <p className="card-error" role="alert">{error}</p>}
    <div className="sidebar-bottom"><ShieldCheck size={17}/><span>{isRealMode ? '记录保存在本机 · OpenAI 回复' : '此刻的对话，只留在此设备'}</span></div>
  </aside>
  return <>
    {mobile ? <dialog ref={drawer} className="contacts-drawer" aria-label="联系人侧栏" onCancel={onClose} onClose={onClose}>{content}</dialog> : content}
    <dialog ref={confirmation} className="settings-dialog delete-contact-dialog" aria-labelledby="delete-contact-title" onCancel={closeConfirmation} onClose={() => {
      closeConfirmation()
      const target = deleteTrigger.current
      if (target?.isConnected) target.focus()
      else addButton.current?.focus()
    }}>
      <h2 id="delete-contact-title">删除联系人</h2>
      <p>将删除「{deleting?.name}」在此浏览器中的人物卡、专属会话和消息，无法撤销。其他联系人不受影响。</p>
      {deleteError && <p className="card-error" role="alert">{deleteError}</p>}
      <div className="delete-contact-actions">
        <button type="button" autoFocus onClick={closeConfirmation}>取消</button>
        <button type="button" disabled={!writable} className="danger" onClick={async () => {
          if (!deleting) return
          try { await onDelete(deleting.id); closeConfirmation() }
          catch (error) { setDeleteError(error instanceof Error ? error.message : '联系人删除失败。') }
        }}>确认删除联系人</button>
      </div>
    </dialog>
  </>
}
