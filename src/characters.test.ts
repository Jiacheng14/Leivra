import { describe, expect, it } from 'vitest'
import { addCharacter, editCharacter, exportCharacter, importCharacter, validateCharacter, removeCharacter } from './characters/cards'
import { defaultLeivra, DEFAULT_CHARACTER_ID } from './characters/defaultLeivra'
import { appendMessages, createInitialData, DATA_STORAGE_KEY, LEGACY_STORAGE_KEY, loadData, saveData, validateData } from './storage'
import { conversationMessages, createMessage } from './models'

function storage() {
  const values = new Map<string,string>()
  return { getItem: (k:string) => values.get(k) ?? null, setItem: (k:string,v:string) => { values.set(k,v) }, removeItem: (k:string) => { values.delete(k) } }
}
const second = () => ({ ...defaultLeivra, id:'test-contact', name:'测试联系人', customPrompt:'仅供测试的人格设定' })
describe('character cards', () => {
  it('loads the default native card and roundtrips its complete data', () => {
    expect(validateCharacter(defaultLeivra).id).toBe(DEFAULT_CHARACTER_ID)
    expect(importCharacter(exportCharacter(defaultLeivra))).toEqual(defaultLeivra)
  })
  it('safely rejects invalid JSON, unsupported versions, malformed fields and remote avatars', () => {
    expect(() => importCharacter('{broken')).toThrow('JSON')
    for (const changes of [{schemaVersion:2}, {id:''}, {name:' '}, {revision:0}, {personality:'gentle'}, {avatar:'https://tracker.example/a.png'}, {avatar:'//tracker.example/a.png'}, {avatar:'data:image/svg+xml;base64,AAAA'}, {preferences:{temperature:9}}, {unknown:true}]) expect(() => validateCharacter({...defaultLeivra,...changes})).toThrow()
    expect(() => importCharacter(' '.repeat(256*1024+1))).toThrow('256')
  })
  it('imports a second card without overwriting an existing ID', () => {
    const data = createInitialData([])
    const added = addCharacter(data, second())
    expect(added.characters).toHaveLength(2)
    expect(data.characters).toHaveLength(1)
    expect(added.conversations[0].id).not.toBe(added.conversations[1].id)
    expect(() => addCharacter(added, second())).toThrow('ID')
  })
  it('edits and persists personality with a stable ID and incremented revision', () => {
    const data = createInitialData([])
    const { id: _id, revision: _revision, schemaVersion: _schema, ...fields } = data.characters[0]
    const updated = editCharacter(data, DEFAULT_CHARACTER_ID, { ...fields, name:'更名', customPrompt:'新的提示词' })
    const s = storage(); saveData(updated,s)
    const loaded = loadData(s)
    expect(loaded.characters[0]).toMatchObject({id:DEFAULT_CHARACTER_ID,name:'更名',customPrompt:'新的提示词',revision:2})
    expect(loaded.conversations).toEqual(data.conversations)
    expect(data.characters[0].name).toBe('蕾芙菈')
  })
})
describe('scoped local data and migration', () => {
  it('saves and reloads separate cards and conversations; rename keeps history', () => {
    let data = addCharacter(createInitialData([]),second())
    const [a,b] = data.conversations
    data = appendMessages(data,a,[createMessage(a,'user','A 的私有消息')])
    data = appendMessages(data,b,[createMessage(b,'user','B 的私有消息')])
    const { id: _id, revision: _revision, schemaVersion: _schema, ...fields } = data.characters[1]
    data = editCharacter(data,b.characterId,{...fields,name:'改名后'})
    const s=storage(); saveData(data,s); data=loadData(s)
    expect(conversationMessages(data,a).map(m=>m.text)).toEqual(['A 的私有消息'])
    expect(conversationMessages(data,b).map(m=>m.text)).toEqual(['B 的私有消息'])
    expect(data.characters[1].name).toBe('改名后')
    expect(() => appendMessages(data,a,[createMessage(b,'user','越界')])).toThrow()
    expect(() => validateData({...data,messages:[{...data.messages[0],characterId:b.characterId}]})).toThrow()
  })
  it('migrates old messages once, preserves their IDs/times and leaves backup until clear', () => {
    const s=storage(); const legacy=JSON.stringify([{id:'old-1',role:'user',text:'原有消息',createdAt:100}])
    s.setItem(LEGACY_STORAGE_KEY,legacy)
    const migrated=loadData(s)
    expect(migrated.messages[0]).toMatchObject({id:'old-1',characterId:DEFAULT_CHARACTER_ID,createdAt:100,text:'原有消息'})
    saveData(migrated,s)
    expect(loadData(s)).toEqual(migrated)
    expect(s.getItem(LEGACY_STORAGE_KEY)).toBe(legacy)
    expect(s.getItem(DATA_STORAGE_KEY)).not.toBeNull()
  })
  it('keeps an intentionally empty legacy chat empty', () => {
    const s=storage();s.setItem(LEGACY_STORAGE_KEY,'[]')
    expect(loadData(s).messages).toEqual([])
  })
  it('never falls back to older data or overwrites corrupt/unsupported current data', () => {
    const s=storage();s.setItem(LEGACY_STORAGE_KEY,'[]')
    for (const raw of ['broken', JSON.stringify({...createInitialData([]),schemaVersion:2})]) {
      s.setItem(DATA_STORAGE_KEY,raw)
      expect(()=>loadData(s)).toThrow()
      expect(s.getItem(DATA_STORAGE_KEY)).toBe(raw)
    }
  })
  it('trims only the target conversation at 500 messages', () => {
    let data=addCharacter(createInitialData([]),second());const [a,b]=data.conversations
    data=appendMessages(data,b,[createMessage(b,'user','保留 B')])
    data=appendMessages(data,a,Array.from({length:501},(_,i)=>createMessage(a,'user',String(i))))
    expect(conversationMessages(data,a)).toHaveLength(500)
    expect(conversationMessages(data,a)[0].text).toBe('1')
    expect(conversationMessages(data,b)[0].text).toBe('保留 B')
  })
  it('reports storage write failures to the caller', () => {
    const s=storage();s.setItem=()=>{throw new Error('quota')}
    expect(()=>saveData(createInitialData([]),s)).toThrow('quota')
  })
})

describe('contact deletion', () => {
  it('removes a non-current card and only its own conversations/messages', () => {
    let data=addCharacter(createInitialData([]),second())
    const [a,b]=data.conversations
    data=appendMessages(data,a,[createMessage(a,'user','保留 A')])
    data=appendMessages(data,b,[createMessage(b,'user','删除 B')])
    data={...data,activeCharacterId:a.characterId}
    const next=removeCharacter(data,b.characterId)
    expect(next.activeCharacterId).toBe(a.characterId)
    expect(next.characters.map(c=>c.id)).toEqual([a.characterId])
    expect(next.conversations).toEqual([a])
    expect(next.messages).toEqual(conversationMessages(data,a))
    expect(data.characters).toHaveLength(2)
  })
  it('switches to a remaining contact when removing the current one', () => {
    const data=addCharacter(createInitialData([]),second())
    const next=removeCharacter(data,'test-contact')
    expect(next.activeCharacterId).toBe(DEFAULT_CHARACTER_ID)
  })
  it('persists an empty contact set, ignores legacy backup and can add again', () => {
    const s=storage()
    s.setItem(LEGACY_STORAGE_KEY,'[]')
    const empty=removeCharacter(createInitialData([]),DEFAULT_CHARACTER_ID)
    expect(empty).toMatchObject({activeCharacterId:null,characters:[],conversations:[],messages:[]})
    saveData(empty,s)
    expect(loadData(s)).toEqual(empty)
    expect(addCharacter(loadData(s),second()).characters.map(c=>c.id)).toEqual(['test-contact'])
  })
  it('rejects orphaned data and invalid active IDs in an empty snapshot', () => {
    const empty=removeCharacter(createInitialData([]),DEFAULT_CHARACTER_ID)
    expect(()=>validateData({...empty,activeCharacterId:DEFAULT_CHARACTER_ID})).toThrow()
    expect(()=>validateData({...empty,conversations:[createInitialData([]).conversations[0]]})).toThrow()
    expect(()=>validateData({...createInitialData([]),activeCharacterId:null})).toThrow()
    expect(()=>removeCharacter(empty,'missing')).toThrow()
  })
})
