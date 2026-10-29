const { chromium } = require('playwright')
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { existsSync } = require('node:fs')
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '4181', '--strictPort'], { stdio: 'inherit' })
async function ready() {
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch('http://127.0.0.1:4181')).ok) return } catch {}
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error('Preview did not start')
}
const data = page => page.evaluate(() => new Promise((resolve, reject) => {
  const open = indexedDB.open('leivra-local')
  open.onerror = () => reject(open.error)
  open.onsuccess = () => {
    const db = open.result, tx = db.transaction('snapshots', 'readonly')
    const get = tx.objectStore('snapshots').get('current')
    get.onsuccess = () => resolve(get.result)
    get.onerror = () => reject(get.error)
    tx.oncomplete = () => db.close()
  }
}))
;(async () => {
  await ready()
  const browser = await chromium.launch({ headless: true, ...(existsSync(chromium.executablePath()) ? {} : { channel: 'chrome' }) })
  try {
    const context = await browser.newContext()
    const [a, b] = await Promise.all([context.newPage(), context.newPage()])
    const pageErrors = []
    for (const page of [a, b]) page.on('pageerror', error => pageErrors.push(error.message))
    await Promise.all([a.goto('http://127.0.0.1:4181'), b.goto('http://127.0.0.1:4181')])
    let aWritable = false, bWritable = false
    for (let i = 0; i < 20; i++) {
      aWritable = (await a.getByRole('textbox', { name: '消息', exact: true }).count()) > 0 && await a.getByRole('textbox', { name: '消息', exact: true }).isEnabled()
      bWritable = (await b.getByRole('textbox', { name: '消息', exact: true }).count()) > 0 && await b.getByRole('textbox', { name: '消息', exact: true }).isEnabled()
      if (aWritable !== bWritable) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.notEqual(aWritable, bWritable, 'exactly one page must own the writer lock')
    const active = aWritable ? a : b, waiting = aWritable ? b : a
    await active.getByRole('textbox', { name: '消息', exact: true }).fill('待恢复消息')
    await active.getByRole('button', { name: '发送消息', exact: true }).click()
    await active.getByText('待恢复消息', { exact: true }).waitFor()
    assert.equal(await waiting.getByRole('textbox', { name: '消息', exact: true }).count(), 0)
    await active.close()
    await waiting.getByRole('textbox', { name: '消息', exact: true }).waitFor({ state: 'visible' })
    await waiting.waitForFunction(() => !document.querySelector('textarea[aria-label="消息"]').disabled)
    await waiting.getByText('待恢复消息', { exact: true }).waitFor()
    await waiting.getByText('这件事里，你最想聊的是哪一部分？', { exact: true }).waitFor()
    await waiting.waitForTimeout(1000)
    const record = await data(waiting)
    assert.equal(record.messages.filter(message => message.role === 'user' && message.text === '待恢复消息').length, 1)
    assert.equal(record.messages.filter(message => message.role === 'assistant' && message.text === '这件事里，你最想聊的是哪一部分？').length, 1)
    const stale = await context.newPage()
    await stale.goto('http://127.0.0.1:4181')
    assert.equal(await stale.getByRole('textbox', { name: '消息', exact: true }).count(), 0)
    const before = await data(stale)
    await stale.getByRole('button', { name: '聊天设置' }).click()
    assert(await stale.getByRole('button', { name: /导出完整备份/ }).isDisabled())
    assert.deepEqual(await data(stale), before)
    await waiting.reload()
    await waiting.waitForFunction(() => !document.querySelector('textarea[aria-label="消息"]')?.disabled || document.querySelector('[role="alert"]')?.textContent?.includes('只读'))
    assert.equal(pageErrors.length, 0, pageErrors.join('\n'))
    await context.close()
    const fallbackContext = await browser.newContext()
    await fallbackContext.addInitScript(() => { Object.defineProperty(Crypto.prototype, 'randomUUID', { value: undefined, configurable: true }) })
    const fallback = await fallbackContext.newPage()
    await fallback.goto('http://127.0.0.1:4181')
    assert.equal(await fallback.evaluate(() => typeof crypto.randomUUID), 'undefined')
    await fallback.getByRole('textbox', { name: '消息', exact: true }).fill('兼容消息')
    await fallback.getByRole('button', { name: '发送消息', exact: true }).click()
    await fallback.getByText('兼容消息', { exact: true }).waitFor()
    const card = { ...(await data(fallback)).characters[0], id: 'fallback-card', name: '测试联系人' }
    await fallback.getByLabel('导入人物卡').setInputFiles({ name: 'card.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(card)) })
    await fallback.getByRole('button', { name: '联系 测试联系人' }).waitFor()
    assert.equal((await data(fallback)).conversations.length, 2)
    await fallbackContext.close()
    console.log('PASS: two-page race, ownership transfer, old-page write blocking, one queued reply, and UUID fallback initialization/message/conversation')
  } finally { await browser.close() }
})().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => server.kill())
