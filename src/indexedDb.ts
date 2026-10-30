import type { LocalData } from './models'
import { loadData, validateData } from './storage'

const DATABASE = 'leivra-local'
const STORE = 'snapshots'
const CURRENT = 'current'
const ROLLBACK = 'before-restore'
export const DATABASE_VERSION = 1

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB 请求失败。'))
  })
}

function completed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB 事务已中止。'))
  })
}

export function openDatabase(): Promise<IDBDatabase> {
  if (!globalThis.indexedDB) return Promise.reject(new Error('此浏览器不支持 IndexedDB。'))
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, DATABASE_VERSION)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE)
    }
    request.onsuccess = () => {
      const database = request.result
      database.onversionchange = () => database.close()
      resolve(database)
    }
    request.onerror = () => reject(request.error ?? new Error('IndexedDB 无法打开。'))
    request.onblocked = () => reject(new Error('其他页面阻止数据库升级，请关闭其他 Leivra 页面。'))
  })
}

async function readKey(database: IDBDatabase, key: string): Promise<LocalData | undefined> {
  const transaction = database.transaction(STORE, 'readonly')
  const done = completed(transaction)
  const [value]: [unknown, void] = await Promise.all([requestValue(transaction.objectStore(STORE).get(key)), done])
  return value === undefined ? undefined : validateData(value)
}

export async function readData(database: IDBDatabase): Promise<LocalData> {
  const data = await readKey(database, CURRENT)
  if (!data) throw new Error('IndexedDB 中没有已初始化的数据。')
  return data
}

export async function initializeData(database: IDBDatabase, storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = localStorage): Promise<LocalData> {
  const existing = await readKey(database, CURRENT)
  if (existing) return existing
  // Read and validate the old snapshot before opening a write transaction. Never edit it.
  const source = loadData(storage)
  const legacyTheme = storage.getItem('leivra.theme')
  if (legacyTheme === 'light' || legacyTheme === 'dark') source.theme = legacyTheme
  const transaction = database.transaction(STORE, 'readwrite')
  const done = completed(transaction)
  transaction.objectStore(STORE).add(source, CURRENT)
  await done
  const migrated = await readData(database)
  if (JSON.stringify(migrated) !== JSON.stringify(validateData(source))) throw new Error('迁移校验失败，旧数据已保留。')
  return migrated
}

export async function writeData(database: IDBDatabase, value: LocalData): Promise<void> {
  const data = validateData(value)
  const transaction = database.transaction(STORE, 'readwrite')
  const done = completed(transaction)
  transaction.objectStore(STORE).put(data, CURRENT)
  await done
}

export async function replaceData(database: IDBDatabase, value: LocalData): Promise<void> {
  const data = validateData(value)
  const transaction = database.transaction(STORE, 'readwrite')
  const done = completed(transaction)
  const store = transaction.objectStore(STORE)
  // The read and both writes share one transaction: a failed replacement leaves current intact.
  const replacement = requestValue(store.get(CURRENT)).then((previous: unknown) => {
    try {
      if (previous !== undefined) store.put(previous, ROLLBACK)
      store.put(data, CURRENT)
    } catch (cause) {
      transaction.abort()
      throw cause
    }
  })
  await Promise.all([replacement, done])
  try {
    if (JSON.stringify(await readData(database)) !== JSON.stringify(data)) throw new Error('恢复后校验失败。')
  } catch (cause) {
    const rollback = await readRawRollback(database)
    if (rollback !== undefined) {
      const reversal = database.transaction(STORE, 'readwrite')
      const reversalDone = completed(reversal)
      reversal.objectStore(STORE).put(rollback, CURRENT)
      await reversalDone
    }
    throw cause
  }
}

async function readRawRollback(database: IDBDatabase): Promise<unknown> {
  const transaction = database.transaction(STORE, 'readonly')
  const done = completed(transaction)
  const [value]: [unknown, void] = await Promise.all([requestValue(transaction.objectStore(STORE).get(ROLLBACK)), done])
  return value
}
export async function readRollbackData(database: IDBDatabase): Promise<LocalData | undefined> {
  return readKey(database, ROLLBACK)
}
