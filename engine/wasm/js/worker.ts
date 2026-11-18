/**
 * A minimal Worker around the engine: proof that the module loads in workerd, and the
 * harness for local measurements (`tools/measure.mjs`, the tests in `test/`).
 *
 *   GET  /            → ABI check, module memory
 *   POST /encode      → body: `u32 n, (u32 len, batch)*`; answers file statistics as JSON
 */
import wasm from './viz_engine.wasm'
import { createEngine } from './index'

const engine = createEngine(wasm)

export default {
  async fetch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname
    if (path === '/encode' && req.method === 'POST') {
      const body = new Uint8Array(await req.arrayBuffer())
      const dv = new DataView(body.buffer)
      const batches: Uint8Array[] = []
      let p = 4
      for (let i = 0; i < dv.getUint32(0, true); i++) {
        const n = dv.getUint32(p, true)
        batches.push(body.subarray(p + 4, p + 4 + n))
        p += 4 + n
      }
      const t0 = Date.now()
      const files = engine.encodeSegment(batches)
      return Response.json({ ms: Date.now() - t0, memoryBytes: engine.memoryBytes(), files: files.map(({ bytes, index: _index, ...f }) => ({ ...f, bytes: bytes.byteLength })) })
    }
    engine.encodeSegment([])
    return Response.json({ ok: true, memoryBytes: engine.memoryBytes(), instances: engine.instances() })
  },
} satisfies ExportedHandler
