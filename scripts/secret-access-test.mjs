import { createServer } from 'vite'
import { writeFile, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'

const marker = 'FAKE_SECRET_DO_NOT_EXPOSE_123'
const samples = ['worker/.dev.vars.codex-test', '.env.codex-test', 'worker/test-secret.pem']
const created = []
let server
try {
  for (const file of samples) { await writeFile(file, marker, { flag: 'wx' }); created.push(file) }
  server = await createServer({ server: { host: '127.0.0.1', port: 4199, strictPort: true } })
  await server.listen()
  const address = server.httpServer.address()
  assert(address && typeof address === 'object')
  const base = `http://127.0.0.1:${address.port}`
  assert.equal((await fetch(base + '/')).status, 200)
  for (const file of samples) {
    for (const path of [`/${file}`, `/${file}?raw`, `/@fs/${resolve(file).replaceAll('\\', '/')}`]) {
      const response = await fetch(base + path)
      const body = await response.text()
      assert(!body.includes(marker), `${path} exposed fake secret`)
    }
  }
  await writeFile('public/.dev.vars.codex-test', marker, { flag: 'wx' })
  try {
    const response = await fetch(base + '/.dev.vars.codex-test')
    assert.equal(response.status, 403)
    assert(!(await response.text()).includes(marker))
  } finally { await unlink('public/.dev.vars.codex-test') }
  await server.close(); server = undefined
  await writeFile('public/.dev.vars.codex-test', marker, { flag: 'wx' })
  try {
    await assert.rejects(createServer({ server: { host: '127.0.0.1', port: 4199, strictPort: true } }), /Secret-like file or symlink cannot be served/)
  } finally { await unlink('public/.dev.vars.codex-test') }
  console.log('PASS: Vite denies fake backend secrets and rejects public secrets')
} finally {
  await server?.close()
  for (const file of created) await unlink(file)
}
