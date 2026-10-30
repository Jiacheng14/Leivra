import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { startNode, stopChild, waitForServer } from './local-process.mjs'

const origin = 'http://127.0.0.1:5183'
let server, browser
const errors = []
async function read(page, key = 'current') {
  return page.evaluate(key => new Promise((resolve, reject) => {
    const open = indexedDB.open('leivra-local')
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const db = open.result, tx = db.transaction('snapshots', 'readonly')
      const get = tx.objectStore('snapshots').get(key)
      tx.oncomplete = () => { db.close(); resolve(get.result) }
      tx.onabort = () => { db.close(); reject(tx.error) }
    }
  }), key)
}
async function until(check, description) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('Timed out: ' + description)
}
async function advanceUntil(page, check, description) {
  // IndexedDB commits use real event tasks; let them settle between fake timer steps.
  for (let i = 0; i < 30; i++) {
    await page.clock.runFor(1000)
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('Timed out while advancing clock: ' + description)
}
async function ready(page) {
  await page.waitForFunction(() => document.querySelector('textarea[aria-label="消息"]')?.disabled === false)
  await until(async () => (await read(page)).schedulerSnapshots?.length > 0, 'scheduler initialized')
}
async function controls(page) {
  await page.evaluate(() => {
    window.__fault = { hold: false, held: false, release: false, abortText: null }
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (value, key) {
      const request = put.call(this, value, key)
      if (key !== 'current') return request
      const fault = window.__fault
      if (fault.abortText && value.messages.some(message => message.text === fault.abortText)) {
        fault.abortText = null
        request.addEventListener('success', () => this.transaction.abort())
      }
      if (fault.hold) {
        fault.hold = false; fault.held = true
        const keepAlive = () => {
          this.get('__test_keepalive__').onsuccess = () => { if (!fault.release) keepAlive() }
        }
        keepAlive()
      }
      return request
    }
  })
}
async function send(page, text) {
  await page.getByRole('textbox', { name: '消息', exact: true }).fill(text)
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await until(async () => (await read(page)).messages.some(m => m.text === text), 'saved ' + text)
}
async function settings(page) { await page.getByRole('button', { name: '聊天设置', exact: true }).click() }
async function selectBackup(page, backup) {
  await page.getByLabel('选择 Leivra 备份').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) })
  await page.getByRole('button', { name: '确认恢复', exact: true }).waitFor()
}
async function download(page, name) {
  const event = page.waitForEvent('download')
  await page.getByRole('button', { name }).click()
  return JSON.parse(await readFile(await (await event).path(), 'utf8'))
}
async function scenario(name, run) {
  const context = await browser.newContext({ serviceWorkers: 'block' })
  const requests = []
  await context.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (url.origin === origin && url.pathname === '/api/chat') {
      requests.push(route.request().postDataJSON())
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ messages: ['fake first', 'fake second'] }) })
    }
    if (url.origin === origin && !url.pathname.startsWith('/api/')) return route.continue()
    return route.abort()
  })
  const newPage = async () => {
    const page = await context.newPage()
    page.on('pageerror', error => errors.push(error.message))
    await page.clock.install({ time: new Date('2026-10-30T12:00:00Z') })
    await page.goto(origin)
    await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 100)
    return page
  }
  try {
    const page = await newPage()
    await ready(page)
    await run({ page, requests, newPage })
    console.log('PASS: ' + name)
  } finally { await context.close() }
}

try {
  // No Worker is started. Every API call is fulfilled locally; external traffic is blocked.
  server = startNode(['node_modules/vite/bin/vite.js', '--mode', 'real', '--host', '127.0.0.1', '--port', '5183', '--strictPort'])
  await waitForServer(origin, server)
  browser = await chromium.launch({ headless: true, ...(existsSync(chromium.executablePath()) ? {} : { channel: 'chrome' }) })

  await scenario('read failure blocks ordinary writes even when UI controls are bypassed', async ({ page, requests }) => {
    const original = await read(page)
    await page.evaluate(() => new Promise((resolve, reject) => {
      const open = indexedDB.open('leivra-local')
      open.onsuccess = () => {
        const db = open.result, tx = db.transaction('snapshots', 'readwrite'), store = tx.objectStore('snapshots')
        const get = store.get('current')
        get.onsuccess = () => store.put({ ...get.result, schemaVersion: 99 }, 'current')
        tx.oncomplete = () => { db.close(); resolve() }
        tx.onabort = () => reject(tx.error)
      }
    }))
    await page.reload()
    await page.getByText(/本地数据无法读取/).waitFor()
    const before = await read(page)
    assert(await page.getByRole('button', { name: '添加联系人', exact: true }).isDisabled())
    const card = { ...original.characters[0], id: 'import-after-failure' }
    // Exercise the handler as well as its disabled UI.
    await page.getByLabel('导入人物卡').evaluate(input => { input.disabled = false })
    await page.getByLabel('导入人物卡').setInputFiles({ name: 'card.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(card)) })
    await page.locator('.sidebar .card-error').waitFor()
    assert.deepEqual(await read(page), before)
    assert.equal(requests.length, 0)
    await settings(page)
    await selectBackup(page, { format: 'leivra-backup', backupVersion: 1, exportedAt: new Date().toISOString(), data: original })
    await page.getByRole('button', { name: '确认恢复', exact: true }).click()
    await ready(page)
    assert.equal((await read(page)).schemaVersion, 1)
  })

  await scenario('slow commit preserves a newer draft and blocks double-submit', async ({ page, requests }) => {
    await controls(page)
    await page.evaluate(() => { window.__fault.hold = true })
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('first draft')
    await page.getByRole('button', { name: '发送消息', exact: true }).evaluate(button => { button.click(); button.click() })
    await page.waitForFunction(() => window.__fault.held)
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('new draft')
    await page.evaluate(() => { window.__fault.release = true })
    await page.getByText('first draft', { exact: true }).waitFor()
    assert.equal(await page.getByRole('textbox', { name: '消息', exact: true }).inputValue(), 'new draft')
    assert.equal((await read(page)).messages.filter(m => m.text === 'first draft').length, 1)
    await page.clock.runFor(10000)
    await until(() => requests.length === 1, 'one fake request')
    assert.deepEqual(requests[0].currentMessages.map(m => m.text), ['first draft'])
  })

  await scenario('aborted message transaction can be retried and resent without orphan references', async ({ page, requests }) => {
    await controls(page)
    await page.evaluate(() => { window.__fault.abortText = 'retry draft' })
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('retry draft')
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await page.getByText(/消息未保存/).waitFor()
    assert(!(await read(page)).messages.some(m => m.text === 'retry draft'))
    assert.equal(await page.getByRole('textbox', { name: '消息', exact: true }).inputValue(), 'retry draft')
    await page.clock.runFor(10000)
    assert.equal(requests.length, 0)
    await page.getByRole('button', { name: '重试回复', exact: true }).click()
    await send(page, 'retry draft')
    await page.clock.runFor(10000)
    await until(() => requests.length === 1, 'request after recovery')
    assert.equal((await read(page)).messages.filter(m => m.text === 'retry draft').length, 1)
  })

  await scenario('aborted bubble transaction retries all output without another model request', async ({ page, requests }) => {
    await controls(page)
    await page.evaluate(() => { window.__fault.abortText = 'fake first' })
    await send(page, 'bubble question')
    await page.clock.runFor(5000)
    await page.getByRole('button', { name: '重试回复', exact: true }).waitFor()
    assert(!(await read(page)).messages.some(m => m.text === 'fake first'))
    await page.getByRole('button', { name: '重试回复', exact: true }).click()
    await advanceUntil(page, async () => (await read(page)).messages.some(m => m.text === 'fake second'), 'complete output')
    assert.deepEqual((await read(page)).messages.filter(m => m.text.startsWith('fake ')).map(m => m.text), ['fake first', 'fake second'])
    assert.equal(requests.length, 1)
  })

  await scenario('historical restore is exclusive, pauses requests and exports the previous snapshot after reload', async ({ page, requests }) => {
    await send(page, 'historical request')
    await settings(page)
    const backup = await download(page, /导出完整备份/)
    assert.equal(backup.data.schedulerSnapshots[0].phase, 'Collecting')
    await page.getByRole('button', { name: '关闭设置', exact: true }).click()
    await page.clock.runFor(5000)
    await until(() => requests.length === 1, 'original request')
    await until(async () => (await read(page)).messages.some(m => m.text === 'fake first'), 'first output')
    await advanceUntil(page, async () => (await read(page)).schedulerSnapshots[0].phase === 'Idle', 'finished output')
    const previous = await read(page)
    await settings(page)
    await page.getByText('人物卡', { exact: true }).click()
    await page.getByRole('button', { name: '编辑', exact: true }).click()
    await page.getByLabel('名称', { exact: true }).fill('must not overwrite')
    await selectBackup(page, backup)
    await controls(page)
    await page.evaluate(() => { window.__fault.hold = true })
    await page.getByRole('button', { name: '确认恢复', exact: true }).click()
    await page.waitForFunction(() => window.__fault.held)
    assert(await page.getByRole('button', { name: '保存人物卡', exact: true }).isDisabled())
    assert(await page.getByRole('button', { name: '清空本地聊天', exact: true }).isDisabled())
    await page.locator('.card-editor').evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    await page.getByText('正在恢复备份，请稍候。', { exact: true }).waitFor()
    await page.evaluate(() => { window.__fault.release = true })
    await ready(page)
    await page.waitForFunction(() => !document.querySelector('.settings-dialog[open]'))
    assert.deepEqual((await read(page)).messages, backup.data.messages)
    assert.deepEqual((await read(page, 'before-restore')).messages, previous.messages)
    assert.notEqual((await read(page)).characters[0].name, 'must not overwrite')
    await page.reload(); await ready(page)
    await page.clock.runFor(400000)
    assert.equal(requests.length, 1)
    assert.equal((await read(page)).schedulerSnapshots[0].pauseReason, 'backup-restore')
    await settings(page)
    const rollback = await download(page, /导出恢复前快照/)
    assert.deepEqual(rollback.data.messages, previous.messages)
    await selectBackup(page, rollback)
    await page.getByRole('button', { name: '确认恢复', exact: true }).click()
    await page.waitForFunction(() => !document.querySelector('.settings-dialog[open]'))
    assert.deepEqual((await read(page)).messages, previous.messages)
    assert.equal(requests.length, 1)
  })

  await scenario('restore abort keeps both original data and rollback snapshot', async ({ page, requests }) => {
    const before = await read(page)
    await settings(page)
    await selectBackup(page, { format: 'leivra-backup', backupVersion: 1, exportedAt: new Date().toISOString(), data: before })
    await page.getByRole('button', { name: '确认恢复', exact: true }).click()
    await page.waitForFunction(() => !document.querySelector('.settings-dialog[open]'))
    const rollback = await read(page, 'before-restore')
    assert(rollback, 'an existing rollback snapshot must survive the aborted replacement')
    const backup = structuredClone(before)
    backup.messages.push({ id: 'abort-restore', conversationId: backup.conversations[0].id, characterId: backup.characters[0].id,
      role: 'user', text: 'abort restore', createdAt: 1 })
    await controls(page)
    await page.evaluate(() => { window.__fault.abortText = 'abort restore' })
    await settings(page)
    await selectBackup(page, { format: 'leivra-backup', backupVersion: 1, exportedAt: new Date().toISOString(), data: backup })
    await page.getByRole('button', { name: '确认恢复', exact: true }).click()
    await page.locator('.settings-dialog > .card-error').waitFor()
    assert.deepEqual((await read(page)).messages, before.messages)
    assert.deepEqual(await read(page, 'before-restore'), rollback)
    assert.equal(requests.length, 0)
  })

  await scenario('restore drains an in-flight send and invalidates its queued successor', async ({ page, requests }) => {
    await settings(page)
    const backup = await download(page, /导出完整备份/)
    await page.getByRole('button', { name: '关闭设置', exact: true }).click()
    await controls(page)
    await page.evaluate(() => { window.__fault.hold = true })
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('in-flight send')
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await page.waitForFunction(() => window.__fault.held)
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('queued successor')
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await settings(page)
    await selectBackup(page, backup)
    await page.getByRole('button', { name: '确认恢复', exact: true }).click()
    assert(await page.getByRole('textbox', { name: '消息', exact: true }).isDisabled())
    await page.evaluate(() => { window.__fault.release = true })
    await page.waitForFunction(() => !document.querySelector('.settings-dialog[open]'))
    await page.clock.runFor(30000)
    assert.deepEqual((await read(page)).messages, backup.data.messages)
    assert.equal(requests.length, 0)
    assert((await read(page, 'before-restore')).messages.some(m => m.text === 'in-flight send'))
    assert(!(await read(page, 'before-restore')).messages.some(m => m.text === 'queued successor'))
  })

  await scenario('pagehide holds ownership until the entire restore finishes', async ({ page, requests, newPage }) => {
    await send(page, 'pending at backup')
    await settings(page)
    const backup = await download(page, /导出完整备份/)
    const other = await newPage()
    assert.equal(await other.getByRole('textbox', { name: '消息', exact: true }).count(), 0)
    await selectBackup(page, backup)
    await controls(page)
    await page.evaluate(() => { window.__fault.hold = true })
    await page.getByRole('button', { name: '确认恢复', exact: true }).click()
    await page.waitForFunction(() => window.__fault.held)
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')))
    await new Promise(resolve => setTimeout(resolve, 150))
    assert.equal(await other.getByRole('textbox', { name: '消息', exact: true }).count(), 0)
    await page.evaluate(() => { window.__fault.release = true })
    await ready(other)
    await other.clock.runFor(400000)
    assert.equal(requests.length, 0)
    assert.equal((await read(other)).schedulerSnapshots[0].pauseReason, 'backup-restore')
    assert(await page.getByRole('textbox', { name: '消息', exact: true }).isDisabled())
  })
  assert.deepEqual(errors, [])
} finally {
  await browser?.close()
  stopChild(server)
}
