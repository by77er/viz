// Runs the same two query workloads inside workerd. POST the Parquet file as the body.
import wasmModule from './vizcore.wasm'
import { query as jsQuery } from '../ts/impl.mjs'
const T0 = 1763424000000 + 300_000, STEPS = 235, METRIC = 'app_metric_06_total'
let inst
export default {
  async fetch(req) {
    const [, impl, work] = new URL(req.url).pathname.split('/')
    const body = new Uint8Array(await req.arrayBuffer())
    const metric = work === 'q1' ? METRIC : ''
    let res = new Float64Array(1), wasmMb = 0, inits = 0
    const s = Date.now()
    if (impl === 'rust') {
      if (!inst) { inst = await WebAssembly.instantiate(wasmModule, {}); inits = 1 }
      const x = inst.exports, m = new TextEncoder().encode(metric)
      const fp = x.alloc(body.byteLength); new Uint8Array(x.memory.buffer, fp, body.byteLength).set(body)
      const mp = x.alloc(m.byteLength); new Uint8Array(x.memory.buffer, mp, m.byteLength).set(m)
      x.query_c(fp, body.byteLength, mp, m.byteLength, BigInt(T0), STEPS)
      res = new Float64Array(new Uint8Array(x.memory.buffer, x.out_ptr(), x.out_len()).slice().buffer)
      x.out_free(); x.dealloc(mp, m.byteLength); wasmMb = x.memory.buffer.byteLength / 1048576
    } else if (impl === 'js') {
      res = await jsQuery(body, metric, T0, STEPS)
    }
    return Response.json({ impl, work, inner_ms: Date.now() - s, sum: Array.from(res).reduce((a, b) => a + b, 0), wasmMb, inits })
  },
}
