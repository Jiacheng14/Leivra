import { createWorker } from '../worker/index'
const worker=createWorker(fetch,60000,new Set(['http://127.0.0.1:5179']))
// Test-only wrapper: empty bindings make paid calls impossible.
export default { fetch(request: Request) { return worker.fetch(request, {}) } }
