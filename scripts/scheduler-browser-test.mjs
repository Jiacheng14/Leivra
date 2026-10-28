import { resolve } from 'node:path'
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright'
import { startNode,stopChild,waitForServer } from './local-process.mjs'
process.env.WRANGLER_LOG_PATH=resolve('work/wrangler-logs')
process.env.WRANGLER_SEND_METRICS='false'
process.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV='false'
process.env.LEIVRA_TEST_WORKER_PORT='8791'
const {unstable_dev}=await import('wrangler')
let worker,server,browser
try {
  await mkdir('test-results',{recursive:true})
  worker=await unstable_dev('tests/runtime-worker.ts',{config:'tests/wrangler.jsonc',local:true,ip:'127.0.0.1',port:8791,logLevel:'error',experimental:{disableExperimentalWarning:true,disableDevRegistry:true,watch:false}})
  assert.deepEqual(await (await fetch('http://127.0.0.1:8791/__leivra_test_worker')).json(),{testWorker:true})
  server=startNode(['node_modules/vite/bin/vite.js','--mode','real','--host','127.0.0.1','--port','5179','--strictPort'])
  await waitForServer('http://127.0.0.1:5179',server)
  browser=await chromium.launch({headless:true})
  const errors=[]
  for(const width of [1440,390]){
    const context=await browser.newContext({viewport:{width,height:900},isMobile:width===390,hasTouch:width===390})
    const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message))
    await page.goto('http://127.0.0.1:5179')
    const send=async text=>{await page.getByRole('textbox',{name:'消息',exact:true}).fill(text);await page.getByRole('button',{name:'发送消息',exact:true}).click()}
    const data=()=>page.evaluate(()=>JSON.parse(localStorage.getItem('leivra.data.v1')))
    await page.getByRole('button',{name:'聊天设置'}).click()
    assert.equal(await page.getByLabel('回复等待时间').inputValue(),'3.5')
    assert.equal(await page.getByLabel('正在输入时延后回复').isChecked(),false)
    await page.getByLabel('回复等待时间').fill('1')
    await page.getByLabel('正在输入时延后回复').check()
    await page.screenshot({path:'test-results/timing-settings-'+width+'.png',fullPage:true})
    await page.getByRole('button',{name:'关闭设置'}).click();await page.reload()
    assert.deepEqual((await data()).chatSettings,{replyWaitMs:1000,deferWhileTyping:true,maxWaitMs:300000})
    // This reaches actual workerd through Vite. Test wrapper forces empty bindings.
    const initialResponse=page.waitForResponse(r=>r.url().endsWith('/api/chat'))
    await send('无密钥验收')
    const firstResponse=await initialResponse
    const firstBody=await firstResponse.json()
    assert.equal(firstResponse.status(),503,JSON.stringify(firstBody))
    assert.equal(firstBody.error.code,'NOT_CONFIGURED')
    await page.getByRole('alert').filter({hasText:'后端尚未配置'}).waitFor()
    assert.equal((await data()).messages.filter(m=>m.role==='assistant').length,2)
    await page.reload();await page.getByRole('alert').filter({hasText:'后端尚未配置'}).waitFor()
    const calls=[];let hold=true,release
    await page.route('**/api/chat',async route=>{
      calls.push(route.request().postDataJSON())
      if(hold)await new Promise(resolve=>{release=resolve})
      await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({messages:calls.length===1?['首条','长段\n\n'+'文字'.repeat(2000),'尾条']:['下一轮回复']})})
    })
    await page.getByRole('button',{name:'重试回复',exact:true}).click()
    await page.waitForFunction(()=>JSON.parse(localStorage.getItem('leivra.data.v1')).schedulerSnapshots[0].phase==='Generating')
    await send('下一轮甲');await send('下一轮乙');await send('下一轮丙')
    assert.equal(calls.length,1)
    assert.equal(calls[0].currentMessages.length,1)
    assert(!JSON.stringify(calls[0]).includes('下一轮'))
    hold=false;release()
    await page.locator('.bubble').getByText('首条',{exact:true}).waitFor()
    // Reload mid-dispatch: restore output cursor, not another model request.
    await page.reload()
    await page.locator('.bubble').getByText('尾条',{exact:true}).waitFor()
    await page.locator('.bubble').getByText('下一轮回复',{exact:true}).waitFor()
    assert.equal(calls.length,2)
    assert.deepEqual(calls[1].currentMessages.map(m=>m.text),['下一轮甲','下一轮乙','下一轮丙'])
    assert(!calls[1].recentMessages.some(m=>m.text.startsWith('下一轮')))
    assert(calls[1].recentMessages.some(m=>m.text==='尾条'))
    assert.equal(await page.locator('.bubble').getByText('首条',{exact:true}).count(),1)
    assert((await data()).messages.some(m=>m.text==='长段\n\n'+'文字'.repeat(2000)))
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth))
    await page.screenshot({path:'test-results/real-fixture-chat-'+width+'.png',fullPage:true})
    await page.unroute('**/api/chat')
    // A fresh generation interrupted by reload must not replay automatically.
    let attempted=0
    await page.route('**/api/chat',async route=>{attempted++;await new Promise(resolve=>setTimeout(resolve,2500));await route.abort().catch(()=>{})})
    await send('刷新时中断')
    await page.waitForFunction(()=>JSON.parse(localStorage.getItem('leivra.data.v1')).schedulerSnapshots[0].phase==='Generating')
    await page.reload()
    await page.getByRole('alert').filter({hasText:'上次生成已中断'}).waitFor()
    await page.waitForTimeout(3000);assert.equal(attempted,1)
    await context.close()
  }
  assert.deepEqual(errors,[])
  console.log('PASS: actual local Workers/proxy (no credentials), real-adapter fake replies, settings persistence, grouped queue during generation, long paragraphs, reload dispatch without duplicate calls, interrupted generation without retry, desktop/mobile layouts.')
} finally {await browser?.close();stopChild(server);await worker?.stop()}
