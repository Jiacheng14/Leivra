import { resolve } from 'node:path'
import { startNode, stopChild } from './local-process.mjs'
process.env.WRANGLER_LOG_PATH=resolve('work/wrangler-logs')
process.env.WRANGLER_SEND_METRICS='false'
process.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV='false'
for(const key of Object.keys(process.env))if(key.startsWith('OPENAI_'))delete process.env[key]
const { unstable_dev } = await import('wrangler')
let backend,frontend,stopping=false
async function stop(){
  if(stopping)return
  stopping=true;stopChild(frontend);await backend?.stop()
}
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>void stop())
try {
  backend=await unstable_dev('worker/index.ts',{config:'worker/wrangler.jsonc',local:true,ip:'127.0.0.1',port:8787,
    experimental:{disableExperimentalWarning:true,showInteractiveDevSession:false}})
  frontend=startNode(['node_modules/vite/bin/vite.js','--mode','real','--host','127.0.0.1','--port','5173','--strictPort'])
  void backend.waitUntilExit().then(()=>stopChild(frontend))
  await new Promise(resolve=>frontend.on('exit',code=>{process.exitCode=stopping?0:code??0;resolve()}))
} catch(error){console.error(error.message);process.exitCode=1}
finally {await stop()}
