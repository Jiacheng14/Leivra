import type { LocalData } from './models'
import { record } from './validation'
import { validateData } from './storage'
import { BACKUP_RESTORE_ERROR } from './scheduling/MessageScheduler'

export interface Backup {
  format: 'leivra-backup'
  backupVersion: 1
  exportedAt: string
  data: LocalData
}

export function createBackup(data: LocalData, exportedAt = new Date().toISOString()): Backup {
  return { format: 'leivra-backup', backupVersion: 1, exportedAt, data: validateData(data) }
}

export function prepareRestore(data: LocalData): LocalData {
  const restored = validateData(data)
  // A historical backup cannot tell whether its queued work ran after export.
  for (const snapshot of restored.schedulerSnapshots ?? []) {
    const needsGeneration = snapshot.pending.length > 0 || (snapshot.active && !snapshot.active.output)
    if (snapshot.active?.output) snapshot.phase = 'Dispatching'
    else snapshot.phase = 'Idle'
    if (needsGeneration) {
      snapshot.error = BACKUP_RESTORE_ERROR
      snapshot.pauseReason = 'backup-restore'
    }
  }
  return validateData(restored)
}

export function parseBackup(raw: string): Backup {
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { throw new Error('备份 JSON 格式错误。') }
  const backup = record(parsed)
  if (backup.format !== 'leivra-backup' || backup.backupVersion !== 1) throw new Error('不支持的备份格式或版本。')
  if (typeof backup.exportedAt !== 'string' || !Number.isFinite(Date.parse(backup.exportedAt))) throw new Error('备份时间格式错误。')
  const data = validateData(backup.data)
  // Object key order is irrelevant; array order is the authoritative message order.
  const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)
  if (canonical(data) !== canonical(backup.data)) throw new Error('备份数据存在无法保留的字段。')
  return { format: 'leivra-backup', backupVersion: 1, exportedAt: backup.exportedAt, data }
}

export function backupFilename(date = new Date()): string {
  const part = (value: number) => String(value).padStart(2, '0')
  return `Leivra-backup-${date.getFullYear()}-${part(date.getMonth()+1)}-${part(date.getDate())}-${part(date.getHours())}-${part(date.getMinutes())}.json`
}
