import { resolve } from 'node:path'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { startNode, stopChild, waitForServer } from './local-process.mjs'

process.env.WRANGLER_LOG_PATH = resolve('work/wrangler-logs')
process.env.WRANGLER_SEND_METRICS = 'false'
process.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = 'false'
process.env.LEIVRA_TEST_WORKER_PORT = '8791'
const { unstable_dev } = await import('wrangler')
let worker, server, browser
try {
  // Empty bindings and a test-only marker make accidental paid requests impossible.
  worker = await unstable_dev('tests/runtime-worker.ts', { config: 'tests/wrangler.jsonc', local: true, ip: '127.0.0.1', port: 8791,
    logLevel: 'error', experimental: { disableExperimentalWarning: true, disableDevRegistry: true, watch: false } })
  assert.deepEqual(await (await fetch('http://127.0.0.1:8791/__leivra_test_worker')).json(), { testWorker: true })
  server = startNode(['node_modules/vite/bin/vite.js', '--mode', 'real', '--host', '127.0.0.1', '--port', '5179', '--strictPort'])
  await waitForServer('http://127.0.0.1:5179', server)
  browser = await chromium.launch({ headless: true })
  const errors = []
  async function scenario(run) {
    const context = await browser.newContext()
    const page = await context.newPage()
    page.on('pageerror', error => errors.push(error.message))
    await page.clock.install({ time: new Date('2026-10-28T12:00:00.000Z') })
    const requests = []
    await page.route('**/api/chat', async route => {
      requests.push({ at: await page.evaluate(() => Date.now()), body: route.request().postDataJSON() })
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ messages: ['假回复'] }) })
    })
    await page.goto('http://127.0.0.1:5179')
    await page.getByRole('textbox', { name: '消息', exact: true }).waitFor({ state: 'visible' })
    await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000)
    const send = async text => {
      await page.getByRole('textbox', { name: '消息', exact: true }).fill(text)
      await page.getByRole('button', { name: '发送消息', exact: true }).click()
    }
    try { await run({ page, requests, send }) }
    finally { await page.unrouteAll({ behavior: 'wait' }); await context.close() }
  }
  await scenario(async ({ page, requests, send }) => {
    assert.equal(await page.getByLabel('回复等待时间').count(), 1)
    await send('第一条')
    const sentAt = await page.evaluate(() => JSON.parse(localStorage.getItem('leivra.data.v1')).schedulerSnapshots[0].lastSentAt)
    await page.clock.runFor(2000)
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('未发送草稿')
    await page.clock.runFor(1490)
    await page.waitForTimeout(50)
    assert.equal(requests.length, 0, 'draft must not shorten the 3500ms wait')
    const response = page.waitForResponse(item => item.url().endsWith('/api/chat'))
    await page.clock.runFor(10)
    await response
    assert.equal(requests.length, 1)
    assert.equal(requests[0].at - sentAt, 3500)
    assert.deepEqual(requests[0].body.currentMessages.map(message => message.text), ['第一条'])
    assert(!JSON.stringify(requests[0].body).includes('未发送草稿'))
  })
  await scenario(async ({ page, requests, send }) => {
    await send('第一条')
    await page.clock.runFor(2000)
    await send('第二条')
    const lastSentAt = await page.evaluate(() => JSON.parse(localStorage.getItem('leivra.data.v1')).schedulerSnapshots[0].lastSentAt)
    await page.clock.runFor(3490)
    await page.waitForTimeout(50)
    assert.equal(requests.length, 0, 'second send must reset the deadline')
    const response = page.waitForResponse(item => item.url().endsWith('/api/chat'))
    await page.clock.runFor(10)
    await response
    assert.equal(requests.length, 1)
    assert.equal(requests[0].at - lastSentAt, 3500)
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
    await page.clock.runFor(3490)
    await page.waitForTimeout(50)
    assert.equal(requests.length, 0)
    const response = page.waitForResponse(item => item.url().endsWith('/api/chat'))
    await page.clock.runFor(10)
    await response
    assert.equal(requests.length, 1)
    assert.equal(requests[0].at - typedAt, 3500)
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
    assert.deepEqual((await page.evaluate(() => JSON.parse(localStorage.getItem('leivra.data.v1')))).chatSettings,
      { replyWaitMs: 60000, deferWhileTyping: true })
  })
  await scenario(async ({ page, requests, send }) => {
    await page.getByRole('button', { name: '聊天设置' }).click()
    await page.getByLabel('回复等待时间').fill('4')
    await page.getByLabel('回复等待时间').fill('3.5')
    await page.getByRole('button', { name: '关闭设置' }).click()
    await send('第一条')
    await page.clock.runFor(2000)
    await page.reload()
    assert.deepEqual((await page.evaluate(() => JSON.parse(localStorage.getItem('leivra.data.v1')))).chatSettings,
      { replyWaitMs: 3500, deferWhileTyping: false })
    await page.clock.runFor(1490)
    await page.waitForTimeout(50)
    assert.equal(requests.length, 0)
    const response = page.waitForResponse(item => item.url().endsWith('/api/chat'))
    await page.clock.runFor(10)
    await response
    assert.equal(requests.length, 1)
    assert.deepEqual(requests[0].body.currentMessages.map(message => message.text), ['第一条'])
  })
  assert.deepEqual(errors, [])
  console.log('PASS: request timing at 3.5s/5.5s and 60s, draft option timing, saved settings and refreshed queue')
} finally {
  await browser?.close()
  stopChild(server)
  await worker?.stop()
}
