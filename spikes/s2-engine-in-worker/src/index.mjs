// Spike S2: the benchmark's Rust/WASM core and its JS counterpart, in a real Worker.
//   POST /rust/q1|q2, /js/q1|q2   body = the benchmark Parquet file; runs the query once
//   GET  /mem?kind=wasm|js&mb=N   grows memory to N MiB and touches every page
// Wall time does not advance during CPU work in production, so CPU time is read from analytics.
import wasmModule from './vizcore.wasm'
import { query as jsQuery } from './js-impl.mjs'
const T0 = 1763424000000 + 300_000, STEPS = 235, METRIC = 'app_metric_06_total'
let inst
export default {
  async fetch(req, env) {
    if (req.headers.get('x-key') !== env.KEY) return new Response('not found', { status: 404 })
    const url = new URL(req.url), [, a, b] = url.pathname.split('/')
    if (a === 'mem') {
      const mb = Number(url.searchParams.get('mb') ?? 64), kind = url.searchParams.get('kind') ?? 'wasm'
      if (kind === 'wasm') {
        const m = new WebAssembly.Memory({ initial: 16, maximum: 65536 })
        m.grow(Math.max(0, mb * 16 - 16))
        const v = new Uint8Array(m.buffer); for (let i = 0; i < v.length; i += 4096) v[i] = 1
        return Response.json({ kind, mb, bytes: v.length })
      }
      const keep = []; for (let i = 0; i < mb; i++) { const c = new Uint8Array(1048576); for (let j = 0; j < c.length; j += 4096) c[j] = 1; keep.push(c) }
      return Response.json({ kind, mb, chunks: keep.length })
    }
    const body = new Uint8Array(await req.arrayBuffer())
    if (a === 'noop') return Response.json({ impl: a, bytes: body.byteLength }) // baseline: receive the body and nothing else
    const metric = b === 'q1' ? METRIC : ''
    let res, wasmMb = 0
    if (a === 'rust') {
      if (!inst) inst = await WebAssembly.instantiate(wasmModule, {})
      const x = inst.exports, m = new TextEncoder().encode(metric)
      const fp = x.alloc(body.byteLength); new Uint8Array(x.memory.buffer, fp, body.byteLength).set(body)
      const mp = x.alloc(m.byteLength); new Uint8Array(x.memory.buffer, mp, m.byteLength).set(m)
      x.query_c(fp, body.byteLength, mp, m.byteLength, BigInt(T0), STEPS)
      res = new Float64Array(new Uint8Array(x.memory.buffer, x.out_ptr(), x.out_len()).slice().buffer)
      x.out_free(); x.dealloc(mp, m.byteLength); wasmMb = x.memory.buffer.byteLength / 1048576
    } else res = await jsQuery(body, metric, T0, STEPS)
    return Response.json({ impl: a, work: b, sum: Array.from(res).reduce((p, c) => p + c, 0), wasmMb })
  },
}
