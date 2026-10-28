import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
const roots=process.argv.slice(2)
if(!roots.length)throw new Error('Provide build output directories.')
for(const root of roots){
  const files=await readdir(root,{recursive:true,withFileTypes:true})
  let checked=0
  for(const file of files){
    if(!file.isFile() || !/\.(js|html|json|map)$/.test(file.name))continue
    const content=await readFile(join(file.parentPath,file.name),'utf8')
    if(['FAKE_SECRET_DO_NOT_EXPOSE_123','OPENAI_API_KEY','api.openai.com/v1/responses'].some(marker=>content.includes(marker)))throw new Error('Backend-only marker present in client build: '+file.name)
    checked++
  }
  console.log('PASS: '+root+' — '+checked+' client files contain no backend key variable, fake secret or direct Responses endpoint.')
}
