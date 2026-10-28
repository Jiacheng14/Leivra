import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
export function startNode(args,options={}) {
  return spawn(process.execPath,args,{cwd:resolve('.'),stdio:'inherit',windowsHide:true,...options})
}
export function stopChild(child) {
  if(child && child.exitCode===null)child.kill('SIGTERM')
}
export async function waitForServer(url,child,timeout=30000) {
  const end=Date.now()+timeout
  while(Date.now()<end){
    if(child.exitCode!==null)throw new Error('Local server exited before ready.')
    try {await fetch(url,{signal:AbortSignal.timeout(500)});return}catch{}
    await new Promise(resolve=>setTimeout(resolve,200))
  }
  throw new Error('Local server startup timed out.')
}
