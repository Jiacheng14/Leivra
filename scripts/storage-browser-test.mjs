import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { startNode, stopChild, waitForServer } from './local-process.mjs'

let server, browser
const origin = 'http://127.0.0.1:4182'
async function read(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('leivra-local')
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const db = open.result
      const tx = db.transaction('snapshots', 'readonly')
      const get = tx.objectStore('snapshots').get('current')
      get.onsuccess = () => resolve(get.result)
      get.onerror = () => reject(get.error)
      tx.oncomplete = () => db.close()
    }
  }))
}
async function pageWith(context) {
  const page = await context.newPage()
  await page.goto(origin)
  await page.getByRole('textbox', { name: '消息', exact: true }).waitFor({ state: 'visible' })
  return page
}
try {
  server = startNode(['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '4182', '--strictPort'])
  await waitForServer(origin, server)
  browser = await chromium.launch({ headless: true, channel: 'chrome' })
  const freshContext = await browser.newContext()
  const fresh = await pageWith(freshContext)
  await fresh.getByRole('textbox', { name: '消息', exact: true }).waitFor({ state: 'visible' })
  await fresh.waitForFunction(() => !document.querySelector('textarea[aria-label="消息"]')?.disabled)
  const base = await read(fresh)
  assert.equal(base.schemaVersion, 1)
  await freshContext.close()

  const legacy = structuredClone(base)
  const first = legacy.conversations[0]
  legacy.messages = Array.from({ length: 510 }, (_, i) => ({
    id: 'old-' + i, conversationId: first.id, characterId: first.characterId,
    role: 'user', text: '旧消息 ' + i, createdAt: 1000 + i
  }))
  const { sourceCardV2: _source, ...secondCard } = legacy.characters[0]
  secondCard.id = 'second'; secondCard.name = '第二角色'
  legacy.characters.push(secondCard)
  legacy.conversations.push({ id: 'second-conversation', characterId: 'second', createdAt: 2000 })
  legacy.messages.push({ id: 'second-message', conversationId: 'second-conversation', characterId: 'second', role: 'user', text: '独立会话', createdAt: 2001 })
  legacy.chatSettings = { replyWaitMs: 60000, deferWhileTyping: true, maxWaitMs: 300000 }
  const context = await browser.newContext()
  await context.addInitScript(data => {
    if (sessionStorage.getItem('leivra-test-seeded')) return
    sessionStorage.setItem('leivra-test-seeded', '1')
    localStorage.setItem('leivra.data.v1', JSON.stringify(data))
    localStorage.setItem('leivra.theme', 'dark')
  }, legacy)
  const page = await pageWith(context)
  await page.getByText('旧消息 509', { exact: true }).waitFor()
  let migrated = await read(page)
  assert.equal(migrated.messages.length, 511)
  assert.equal(migrated.characters.length, 2)
  assert.equal(migrated.theme, 'dark')
  assert.equal(await page.evaluate(() => localStorage.getItem('leivra.data.v1')), JSON.stringify(legacy))
  await page.evaluate(() => localStorage.setItem('leivra.data.v1', 'corrupt old snapshot'))
  await page.reload()
  await page.getByText('旧消息 509', { exact: true }).waitFor()
  assert.equal((await read(page)).messages.length, 511)

  await page.getByRole('button', { name: '聊天设置' }).click()
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: /导出完整备份/ }).click()
  const download = await downloadPromise
  const path = await download.path()
  const fs = await import('node:fs/promises')
  const backup = JSON.parse(await fs.readFile(path, 'utf8'))
  assert.equal(backup.data.messages.length, 511)
  assert.equal(backup.data.characters.length, 2)
  assert.equal(backup.data.chatSettings.replyWaitMs, 60000)
  assert.equal(backup.data.theme, 'dark')
  assert.equal(JSON.stringify(backup).includes('apiKey'), false)

  await page.getByRole('button', { name: '关闭设置' }).click()
  await page.getByRole('textbox', { name: '消息', exact: true }).fill('恢复前新增')
  await page.getByRole('button', { name: '发送消息' }).click()
  await page.getByText('恢复前新增', { exact: true }).waitFor()
  assert.equal((await read(page)).messages.length, 512)
  await page.getByRole('button', { name: '聊天设置' }).click()
  await page.locator('input[aria-label="选择 Leivra 备份"]').setInputFiles({
    name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from('{')
  })
  await page.getByText('备份 JSON 格式错误。').waitFor()
  assert.equal((await read(page)).messages.length, 512)
  await page.locator('input[aria-label="选择 Leivra 备份"]').setInputFiles({
    name: 'valid.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup))
  })
  await page.getByText(/角色 2，会话 2，消息 511/).waitFor()
  assert.equal((await read(page)).messages.length, 512)
  await page.getByRole('button', { name: '确认恢复' }).click()
  await page.waitForFunction(() => !document.querySelector('.clear-confirm')?.textContent?.includes('确认恢复'))
  assert.equal((await read(page)).messages.length, 511)
  await page.reload()
  await page.getByText('旧消息 509', { exact: true }).waitFor()
  assert.equal((await read(page)).messages.length, 511)
  await context.close()

  const corruptContext = await browser.newContext()
  await corruptContext.addInitScript(() => localStorage.setItem('leivra.data.v1', '{broken'))
  const corrupt = await corruptContext.newPage()
  await corrupt.goto(origin)
  await corrupt.getByText(/本地数据无法读取/).waitFor()
  assert.equal(await corrupt.getByRole('textbox', { name: '消息', exact: true }).count(), 0)
  assert.equal(await corrupt.evaluate(() => localStorage.getItem('leivra.data.v1')), '{broken')
  await corrupt.getByRole('button', { name: '聊天设置' }).click()
  await corrupt.getByRole('button', { name: '从备份恢复' }).waitFor({ state: 'visible' })
  await corrupt.locator('input[aria-label="选择 Leivra 备份"]').setInputFiles({
    name: 'recovery.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup))
  })
  await corrupt.getByRole('button', { name: '确认恢复' }).click()
  await corrupt.getByText('旧消息 509', { exact: true }).waitFor()
  assert.equal((await read(corrupt)).messages.length, 511)
  assert.equal(await corrupt.evaluate(() => localStorage.getItem('leivra.data.v1')), '{broken')
  await corruptContext.close()
  const failureContext = await browser.newContext()
  const failure = await pageWith(failureContext)
  await failure.waitForFunction(() => !document.querySelector('textarea[aria-label="消息"]')?.disabled)
  const beforeFailure = await read(failure)
  await failure.evaluate(() => {
    const original = IDBDatabase.prototype.transaction
    IDBDatabase.prototype.transaction = function (...args) {
      if (args[1] === 'readwrite') throw new Error('simulated write failure')
      return original.apply(this, args)
    }
  })
  await failure.getByRole('textbox', { name: '消息', exact: true }).fill('不能提交的消息')
  await failure.getByRole('button', { name: '发送消息' }).click()
  await failure.getByText(/消息未保存|本地保存失败/).first().waitFor()
  assert.equal((await read(failure)).messages.length, beforeFailure.messages.length)
  assert.equal(await failure.getByRole('textbox', { name: '消息', exact: true }).inputValue(), '不能提交的消息')
  await failureContext.close()
  console.log('PASS: IndexedDB first start, 511-message multi-character migration, old-source retention, idempotence, complete export, invalid-file rejection, confirmed replacement, corrupt-source recovery and write-failure protection.')
} finally {
  await browser?.close()
  await stopChild(server)
}
