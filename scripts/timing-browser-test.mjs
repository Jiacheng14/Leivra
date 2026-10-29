import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { chromium } from 'playwright'
import { startNode, stopChild, waitForServer } from './local-process.mjs'

let server, browser
async function current(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('leivra-local')
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const db = open.result, tx = db.transaction('snapshots', 'readonly')
      const request = tx.objectStore('snapshots').get('current')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
      tx.oncomplete = () => db.close()
    }
  }))
}
async function patchCurrent(page, changes) {
  return page.evaluate(changes => new Promise((resolve, reject) => {
    const open = indexedDB.open('leivra-local')
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const db = open.result, tx = db.transaction('snapshots', 'readwrite')
      const store = tx.objectStore('snapshots'), get = store.get('current')
      get.onsuccess = () => {
        const data = get.result
        if (changes.chatSettings) data.chatSettings = changes.chatSettings
        if (changes.providerId) data.schedulerSnapshots[0].providerId = changes.providerId
        store.put(data, 'current')
      }
      tx.oncomplete = () => { db.close(); resolve() }
      tx.onerror = () => reject(tx.error)
    }
  }), changes)
}
try {
  // Every model request below is intercepted with a fake response.
  server = startNode(['node_modules/vite/bin/vite.js', '--mode', 'real', '--host', '127.0.0.1', '--port', '5179', '--strictPort'])
  await waitForServer('http://127.0.0.1:5179', server)
  browser = await chromium.launch({ headless: true, ...(existsSync(chromium.executablePath()) ? {} : { channel: 'chrome' }) })
  const errors = []
  async function scenario(run) {
    const context = await browser.newContext()
    const page = await context.newPage()
    page.on('pageerror', error => errors.push(error.message))
    await page.clock.install({ time: new Date('2026-10-28T12:00:00.000Z') })
    const requests = []
    await page.route('**/*', route => {
      const url = new URL(route.request().url())
      return url.origin === 'http://127.0.0.1:5179' && !url.pathname.startsWith('/api/') ? route.continue() : route.abort()
    })
    await page.route('**/api/chat', async route => {
      requests.push({ at: await page.evaluate(() => Date.now()), body: route.request().postDataJSON() })
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ messages: ['假回复'] }) })
    })
    await page.goto('http://127.0.0.1:5179')
    await page.getByRole('textbox', { name: '消息', exact: true }).waitFor({ state: 'visible' })
    await page.waitForFunction(() => !document.querySelector('textarea[aria-label="消息"]')?.disabled)
    await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000)
    const send = async text => {
      await page.getByRole('textbox', { name: '消息', exact: true }).fill(text)
      await page.getByRole('button', { name: '发送消息', exact: true }).click()
      for (let i = 0; i < 100; i++) {
        if ((await current(page)).messages.some(message => message.text === text)) return
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      throw new Error('Sent message was not committed to IndexedDB.')
    }
    try { await run({ page, requests, send }) }
    finally { await page.unrouteAll({ behavior: 'wait' }); await context.close() }
  }
  await scenario(async ({ page, requests, send }) => {
    assert.equal(await page.getByLabel('回复等待时间').count(), 1)
    assert.equal(await page.getByLabel('回复等待时间').inputValue(), '5')
    assert.equal(await page.getByLabel('回复等待时间').getAttribute('step'), '1')
    await send('第一条')
    const sentAt = (await current(page)).schedulerSnapshots[0].lastSentAt
    await page.clock.runFor(2000)
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('未发送草稿')
    await page.clock.runFor(2990)
    await page.waitForTimeout(50)
    assert.equal(requests.length, 0, 'draft must not shorten the 5000ms wait')
    const response = page.waitForResponse(item => item.url().endsWith('/api/chat'))
    await page.clock.runFor(10)
    await response
    assert.equal(requests.length, 1)
    assert.equal(requests[0].at - sentAt, 5000)
    assert.deepEqual(requests[0].body.currentMessages.map(message => message.text), ['第一条'])
    assert(!JSON.stringify(requests[0].body).includes('未发送草稿'))
  })
  await scenario(async ({ page, requests, send }) => {
    await send('第一条')
    await page.clock.runFor(2000)
    await send('第二条')
    const lastSentAt = (await current(page)).schedulerSnapshots[0].lastSentAt
    await page.clock.runFor(4990)
    await page.waitForTimeout(50)
    assert.equal(requests.length, 0, 'second send must reset the deadline')
    const response = page.waitForResponse(item => item.url().endsWith('/api/chat'))
    await page.clock.runFor(10)
    await response
    assert.equal(requests.length, 1)
    assert.equal(requests[0].at - lastSentAt, 5000)
    assert.deepEqual(requests[0].body.currentMessages.map(message => message.text), ['第一条', '第二条'])
    assert.equal(await page.locator('.message-row.user').count(), 2)
  })
  await scenario(async ({ page, requests, send }) => {
    await page.getByRole('button', { name: '聊天设置' }).click()
    await page.getByLabel('正在输入时延后回复').check()
    await page.getByRole('button', { name: '关闭设置' }).click()
    await send('第一条')
    await page.clock.runFor(3000)
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('未发送草稿')
    const typedAt = await page.evaluate(() => Date.now())
    await page.clock.runFor(4990)
    await page.waitForTimeout(50)
    assert.equal(requests.length, 0)
    const response = page.waitForResponse(item => item.url().endsWith('/api/chat'))
    await page.clock.runFor(10)
    await response
    assert.equal(requests.length, 1)
    assert.equal(requests[0].at - typedAt, 5000)
    assert.deepEqual(requests[0].body.currentMessages.map(message => message.text), ['第一条'])
    assert(!JSON.stringify(requests[0].body).includes('未发送草稿'))
  })
  await scenario(async ({ page, requests, send }) => {
    await page.getByRole('button', { name: '聊天设置' }).click()
    await page.getByLabel('回复等待时间').fill('60')
    await page.getByLabel('正在输入时延后回复').check()
    await page.getByRole('button', { name: '关闭设置' }).click()
    await send('第一条')
    await page.clock.runFor(50000)
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('未发送草稿')
    const typedAt = await page.evaluate(() => Date.now())
    await page.clock.runFor(59990)
    assert.equal(requests.length, 0)
    const response = page.waitForResponse(item => item.url().endsWith('/api/chat'))
    await page.clock.runFor(10)
    await response
    assert.equal(requests[0].at - typedAt, 60000)
    assert.deepEqual(requests[0].body.currentMessages.map(message => message.text), ['第一条'])
    assert.deepEqual((await current(page)).chatSettings,
      { replyWaitMs: 60000, deferWhileTyping: true, maxWaitMs: 300000 })
  })
  await scenario(async ({ page, requests, send }) => {
    await page.getByRole('button', { name: '聊天设置' }).click()
    await page.getByLabel('回复等待时间').fill('4')
    await page.getByLabel('回复等待时间').fill('3')
    await page.getByRole('button', { name: '关闭设置' }).click()
    await send('第一条')
    await page.clock.runFor(2000)
    await page.reload()
    assert.deepEqual((await current(page)).chatSettings,
      { replyWaitMs: 3000, deferWhileTyping: false, maxWaitMs: 300000 })
    await page.clock.runFor(990)
    await page.waitForTimeout(50)
    assert.equal(requests.length, 0)
    const response = page.waitForResponse(item => item.url().endsWith('/api/chat'))
    await page.clock.runFor(10)
    await response
    assert.equal(requests.length, 1)
    assert.deepEqual(requests[0].body.currentMessages.map(message => message.text), ['第一条'])
  })
  await scenario(async ({ page, requests, send }) => {
    await patchCurrent(page, { chatSettings: { replyWaitMs: 3500, deferWhileTyping: false, maxWaitMs: 300000 } })
    await page.reload()
    await page.getByRole('button', { name: '聊天设置' }).click()
    assert.equal(await page.locator('label[for="reply-wait"] output').textContent(), '3.5 秒')
    assert.equal((await current(page)).chatSettings.replyWaitMs, 3500)
    await page.getByLabel('回复等待时间').fill('4')
    assert.equal((await current(page)).chatSettings.replyWaitMs, 4000)
    await page.getByRole('button', { name: '关闭设置' }).click()
    const response = page.waitForResponse(item => item.url().endsWith('/api/chat'))
    await send('旧设置更新后')
    await page.clock.runFor(4000)
    await response
    assert.equal(requests.length, 1)
  })
  await scenario(async ({ page, requests, send }) => {
    await page.getByRole('button', { name: '聊天设置' }).click()
    assert.equal(await page.getByLabel('最大等待时间').inputValue(), '5')
    await page.getByLabel('回复等待时间').fill('60')
    await page.getByLabel('最大等待时间').fill('10.5')
    await page.getByLabel('正在输入时延后回复').check()
    await page.getByRole('button', { name: '关闭设置' }).click()
    await send('不限等待')
    for (let i = 0; i < 12; i++) {
      await page.clock.runFor(30000)
      await page.getByRole('textbox', { name: '消息', exact: true }).fill('持续输入' + i)
    }
    assert.equal(requests.length, 0, 'typing beyond five minutes must not hit the former cap')
    assert.equal((await current(page)).chatSettings.maxWaitMs, null)
    await page.clock.runFor(59990)
    assert.equal(requests.length, 0)
    const response = page.waitForResponse(item => item.url().endsWith('/api/chat'))
    await page.clock.runFor(10)
    await response
    assert.deepEqual(requests[0].body.currentMessages.map(message => message.text), ['不限等待'])
  })
  await scenario(async ({ page, requests, send }) => {
    await page.getByRole('button', { name: '聊天设置' }).click()
    await page.getByLabel('回复等待时间').fill('60')
    await page.getByLabel('最大等待时间').fill('1')
    await page.getByLabel('正在输入时延后回复').check()
    await page.getByRole('button', { name: '关闭设置' }).click()
    await send('有限等待')
    const sentAt = (await current(page)).schedulerSnapshots[0].lastSentAt
    await page.clock.runFor(40000)
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('仍在输入')
    await page.clock.runFor(19990)
    assert.equal(requests.length, 0)
    const response = page.waitForResponse(item => item.url().endsWith('/api/chat'))
    await page.clock.runFor(10)
    await response
    assert.equal(requests[0].at - sentAt, 60000)
    assert.deepEqual(requests[0].body.currentMessages.map(message => message.text), ['有限等待'])
  })
  await scenario(async ({ page, requests, send }) => {
    await page.getByRole('button', { name: '聊天设置' }).click()
    await page.getByLabel('回复等待时间').fill('60')
    await page.getByRole('button', { name: '关闭设置' }).click()
    await send('模式切换前的任务')
    await patchCurrent(page, { providerId: 'mock' })
    await page.reload()
    await page.evaluate(() => {
      window.__originalTransaction = IDBDatabase.prototype.transaction
      IDBDatabase.prototype.transaction = function (...args) {
        if (args[1] === 'readwrite') throw new DOMException('quota', 'QuotaExceededError')
        return window.__originalTransaction.apply(this, args)
      }
    })
    await page.getByRole('button', { name: '忽略待回复任务' }).click()
    await page.getByRole('alert').filter({ hasText: '浏览器无法保存数据' }).waitFor()
    assert.equal((await current(page)).messages.some(m => m.replyIgnored), false)
    assert.equal(await page.getByRole('button', { name: '忽略待回复任务' }).count(), 1)
    await page.evaluate(() => { IDBDatabase.prototype.transaction = window.__originalTransaction })
    await page.getByRole('button', { name: '忽略待回复任务' }).click()
    for (let i = 0; i < 20 && !(await current(page)).messages.some(m => m.replyIgnored); i++) await page.waitForTimeout(50)
    assert.equal((await current(page)).messages.some(m => m.replyIgnored), true)
    assert.equal(requests.length, 0)
    assert.equal(await page.getByLabel('回复任务已忽略').count(), 1)
    await page.reload()
    assert.equal(await page.getByRole('button', { name: '忽略待回复任务' }).count(), 0)
    await page.getByRole('button', { name: '聊天设置' }).click()
    await page.getByLabel('回复等待时间').fill('1')
    await page.getByRole('button', { name: '关闭设置' }).click()
    const response = page.waitForResponse(item => item.url().endsWith('/api/chat'))
    await send('新的任务')
    await page.clock.runFor(1000)
    await response
    assert.deepEqual(requests[0].body.currentMessages.map(message => message.text), ['新的任务'])
    assert(!JSON.stringify(requests[0].body).includes('模式切换前的任务'))
  })
  await scenario(async ({ page, requests }) => {
    await page.evaluate(() => {
      const original = IDBDatabase.prototype.transaction
      IDBDatabase.prototype.transaction = function (...args) {
        if (args[1] === 'readwrite') throw new DOMException('quota', 'QuotaExceededError')
        return original.apply(this, args)
      }
    })
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('写入失败不得请求')
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await page.getByText(/本地保存失败|消息未保存/).first().waitFor()
    await page.clock.runFor(60000)
    assert.equal(requests.length, 0)
    assert.equal(await page.getByRole('textbox', { name: '消息', exact: true }).inputValue(), '写入失败不得请求')
  })
  assert.deepEqual(errors, [])
  console.log('PASS: default 5s and 1s steps, request timing, unlimited typing, mode-switch ignore and reload')
} finally {
  await browser?.close()
  stopChild(server)
}
