import { useState } from 'react'
import type { Character } from './models'
import { exportCharacter } from './characters/cards'
import { downloadJson } from './download'

interface Props {
  character: Character
  onSave(changes: Omit<Character, 'id' | 'revision' | 'schemaVersion'>): void | Promise<void>
}
export default function CharacterSettings({ character, onSave }: Props) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(character)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const field = (key: 'name' | 'avatar' | 'background' | 'speakingStyle' | 'relationship' | 'customPrompt', value: string) => setDraft(current => ({ ...current, [key]: value }))
  return <details className="character-settings">
    <summary>人物卡</summary>
    <div className="card-actions">
      <button type="button" onClick={() => downloadJson(character.id + '.json', exportCharacter(character))}>导出 JSON</button>
      <button type="button" onClick={() => { setDraft(character); setEditing(!editing); setStatus(''); setError('') }}>{editing ? '取消编辑' : '编辑'}</button>
    </div>
    {editing && <form className="card-editor" onSubmit={async e => {
      e.preventDefault(); setError(''); setStatus('')
      try {
        const { id: _id, schemaVersion: _schema, revision: _revision, ...changes } = draft
        await onSave({ ...changes, personality: character.sourceCardV2 ? changes.personality : changes.personality.filter(item => item.trim()) }); setEditing(false); setStatus('已保存')
      } catch (error) { setError(error instanceof Error ? error.message : '人物卡保存失败。') }
    }}>
      <label>名称<input aria-label="名称" value={draft.name} maxLength={80} required onChange={e => field('name', e.target.value)}/></label>
      <label>头像<input aria-label="头像" value={draft.avatar} maxLength={180000} required onChange={e => field('avatar', e.target.value)}/></label>
      <label>身份背景<textarea aria-label="身份背景" value={draft.background} maxLength={8000} onChange={e => field('background', e.target.value)}/></label>
      <label>性格特征（每行一项）<textarea aria-label="性格特征（每行一项）" value={draft.personality.join('\n')} onChange={e => setDraft(current => ({ ...current, personality: character.sourceCardV2 ? [e.target.value] : e.target.value.split('\n') }))}/></label>
      <label>语言风格<textarea aria-label="语言风格" value={draft.speakingStyle} maxLength={4000} onChange={e => field('speakingStyle', e.target.value)}/></label>
      <label>关系设定<textarea aria-label="关系设定" value={draft.relationship} maxLength={4000} onChange={e => field('relationship', e.target.value)}/></label>
      <label>人格提示词<textarea aria-label="人格提示词" value={draft.customPrompt} maxLength={12000} onChange={e => field('customPrompt', e.target.value)}/></label>
      <button type="submit" className="setting-action">保存人物卡</button>
    </form>}
    {error && <p role="alert" className="card-error">{error}</p>}
    {status && <p role="status">{status}</p>}
  </details>
}
