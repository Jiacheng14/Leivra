import { API_ERRORS, type ApiErrorCode } from '../src/apiContract'
export class ApiFailure extends Error {
  constructor(readonly code: ApiErrorCode, readonly status=502) { super(API_ERRORS[code]) }
}
export async function readJsonLimited(body: ReadableStream<Uint8Array> | null, maxBytes=1024*1024): Promise<unknown> {
  if(!body)throw new Error('Missing body')
  const reader=body.getReader(), decoder=new TextDecoder()
  let bytes=0, content=''
  try {
    while(true){
      const {value,done}=await reader.read()
      if(done)break
      bytes+=value.byteLength
      if(bytes>maxBytes){await reader.cancel();throw new Error('Body too large')}
      content+=decoder.decode(value,{stream:true})
    }
    return JSON.parse(content+decoder.decode())
  } finally {reader.releaseLock()}
}
