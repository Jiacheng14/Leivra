import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { startNode, stopChild, waitForServer } from './local-process.mjs'
import { fixtureCardV2 } from '../tests/fixtures/cardV2.ts'

// Real frontend adapter, but no Worker is started and every API request is intercepted.
const server = startNode(['node_modules/vite/bin/vite.js', '--mode', 'real', '--host', '127.0.0.1', '--port', '5182', '--strictPort'])
let browser
try {
  await waitForServer('http://127.0.0.1:5182', server)
  await mkdir('test-results', { recursive: true })
  browser = await chromium.launch({ headless: true })
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width === 390, hasTouch: width === 390 })
    const page = await context.newPage(), requests = [], errors = []
    page.on('pageerror', error => errors.push(error.message))
    // Also deny any accidental non-local resource request from an imported card.
    await context.route('**/*', async route => {
      const url = new URL(route.request().url())
      if (url.hostname !== '127.0.0.1') { errors.push('external request: ' + url.hostname); await route.abort(); return }
      if (url.pathname === '/api/chat') {
        requests.push(route.request().postDataJSON())
        await route.fulfill({ json: { messages: ['仅供自动测试的长回复。\n\n' + '测试段落。'.repeat(500)] } })
      } else await route.continue()
    })
    await page.goto('http://127.0.0.1:5182')
    await page.getByRole('textbox', { name: '消息', exact: true }).waitFor()
    const snapshot = () => page.evaluate(() => JSON.parse(localStorage.getItem('leivra.data.v1')))
    const openContacts = async () => { if (width === 390) await page.getByRole('button', { name: '打开联系人' }).click() }
    const upload = async value => {
      await openContacts()
      await page.getByLabel('导入人物卡').setInputFiles({ name: 'card.json', mimeType: 'application/json', buffer: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)) })
    }
    const card = fixtureCardV2()
    await upload(card)
    await page.waitForFunction(() => document.querySelector('h1 .role-name')?.textContent === '测试角色')
    assert.equal(await page.locator('.message-row').count(), 0)
    const id = (await snapshot()).activeCharacterId
    await page.getByRole('button', { name: '聊天设置' }).click()
    await page.getByLabel('回复等待时间').fill('1')
    await page.getByText('人物卡', { exact: true }).click()
    await page.getByRole('button', { name: '编辑', exact: true }).click()
    await page.getByLabel('名称', { exact: true }).fill('V2 已编辑')
    await page.getByLabel('性格特征（每行一项）', { exact: true }).fill('保留完整性格\n\n和空行。')
    await page.getByLabel('人格提示词', { exact: true }).fill('PERSONA_ONLY_SENTINEL')
    await page.getByRole('button', { name: '保存人物卡', exact: true }).click()
    await page.getByRole('status').filter({ hasText: '已保存' }).waitFor()
    await page.getByRole('button', { name: '关闭设置' }).click()
    await page.reload()
    await page.waitForFunction(() => document.querySelector('h1 .role-name')?.textContent === 'V2 已编辑')
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('V2 私有问题')
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('.message-feed')?.textContent?.includes('仅供自动测试的长回复。'))
    assert.equal(requests.length, 1)
    assert.equal(requests[0].character.id, id)
    assert.equal(requests[0].character.revision, 2)
    assert.equal(requests[0].character.customPrompt, 'PERSONA_ONLY_SENTINEL')
    assert(!('sections' in requests[0]))
    const data = await snapshot()
    assert(!JSON.stringify(data.messages).includes('PERSONA_ONLY_SENTINEL'))
    assert(!JSON.stringify(data.schedulerSnapshots).includes('PERSONA_ONLY_SENTINEL'))
    assert.equal(data.messages.filter(m => m.characterId === id).length, 2)
    await page.getByRole('button', { name: '聊天设置' }).click()
    await page.getByText('人物卡', { exact: true }).click()
    const downloading = page.waitForEvent('download')
    await page.getByRole('button', { name: '导出 JSON', exact: true }).click()
    const exported = await downloading, path = 'test-results/persona-v2-' + width + '.json'
    await exported.saveAs(path)
    const result = JSON.parse(await readFile(path, 'utf8'))
    assert.deepEqual(result.data.character_book, card.data.character_book)
    assert.deepEqual(result.data.extensions.foreign, card.data.extensions.foreign)
    assert.deepEqual(result.extraRoot, card.extraRoot)
    assert.equal(result.data.personality, '保留完整性格\n\n和空行。')
    assert.equal(result.data.system_prompt, card.data.system_prompt)
    const chatDownload = page.waitForEvent('download')
    await page.getByRole('button', { name: '导出本地测试记录 JSON', exact: true }).click()
    const chatPath = 'test-results/persona-chat-' + width + '.json'
    await (await chatDownload).saveAs(chatPath)
    assert(!((await readFile(chatPath, 'utf8')).includes('PERSONA_ONLY_SENTINEL')))
    await page.getByRole('button', { name: '关闭设置' }).click()
    await page.screenshot({ path: 'test-results/persona-chat-' + width + '.png', fullPage: true })
    await openContacts()
    await page.getByRole('button', { name: '联系 蕾芙菈', exact: true }).click()
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('默认角色私有问题')
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('.message-feed')?.textContent?.includes('仅供自动测试的长回复。'))
    assert.equal(requests.length, 2)
    assert.equal(requests[1].character.id, 'leivra-default')
    assert(!JSON.stringify(requests[1]).includes('V2 私有问题'))
    assert(!JSON.stringify(requests[1]).includes('PERSONA_ONLY_SENTINEL'))
    await openContacts()
    await page.getByRole('button', { name: '联系 V2 已编辑', exact: true }).click()
    assert(!(await page.locator('.message-feed').innerText()).includes('默认角色私有问题'))
    await upload('{broken')
    await page.getByText('人物卡 JSON 格式错误。', { exact: true }).waitFor()
    assert.equal((await snapshot()).characters.length, 2)
    assert.equal(requests.length, 2)
    assert.deepEqual(errors, [])
    await context.close()
  }
  console.log('PASS: desktop/mobile V2 edit, roundtrip, isolated Real adapter, long reply and clean chat export (fake upstream only)')
} finally {
  await browser?.close()
  stopChild(server)
}
