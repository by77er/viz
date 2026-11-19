// The cost of `batchTimeBounds` (src/tail.ts, D72) per batch, timed in Node, not workerd (workerd's
// clock does not advance during synchronous work, so a pure function cannot be timed inside it).
//   node --experimental-strip-types --no-warnings bench/walk.node.mjs        (Node 22.6 or later)
import { encodeLogBatch, encodeSpanBatch } from '../../engine/wasm/test/signal.ts'
import { batchTimeBounds } from '../src/tail.ts'

const MS = 1_000_000n
const NS0 = BigInt(Date.UTC(2026, 10, 19)) * MS
let ids = 1
const id = (n) => {
  const b = new Uint8Array(n).fill(0x5a)
  new DataView(b.buffer).setUint32(0, ids++, true)
  return b
}
// Spans: `entries` resources of 20 string attributes of 40 bytes each; two span attributes.
const span = (rows, entries) => encodeSpanBatch(
  Array.from({ length: entries }, (_, e) => ({ resourceFp: BigInt(e), resource: Array.from({ length: 20 }, (_, a) => [`k${String(a).padStart(2, '0')}`, { s: 'v'.repeat(40) }]), scopeName: 'go.opentelemetry.io/otel', scopeVersion: '1.30.0' })),
  Array.from({ length: rows }, (_, i) => ({ entry: i % entries, traceId: id(16), spanId: id(8), start: NS0 + BigInt(i) * 997n, end: NS0 + BigInt(i) * 997n + 5n, name: 'GET /x', attrs: [['http.method', { s: 'GET' }], ['user.id', { s: `u-${i}` }]] })),
)
const log = (rows) => encodeLogBatch([{ labels: { service_name: 'a', level: 'info' } }], Array.from({ length: rows }, (_, i) => ({ entry: 0, ts: NS0 + BigInt(i), line: `line ${i} `.padEnd(150, 'x') })))
const cases = [['spans, 1 entry, 3,000 rows', span(3000, 1)], ['spans, 50 entries of 20 attributes, 3,000 rows', span(3000, 50)], ['logs, 5,000 rows', log(5000)], ['logs, 1 row', log(1)]]
for (const [name, b] of cases) {
  if (batchTimeBounds(b) === null) throw new Error(`${name}: no bounds`)
  for (let i = 0; i < 200; i++) batchTimeBounds(b) // warm up
  const reps = 2000
  const t = process.hrtime.bigint()
  for (let i = 0; i < reps; i++) batchTimeBounds(b)
  const us = Number(process.hrtime.bigint() - t) / 1000 / reps
  console.log(`WALK ${JSON.stringify({ case: name, bytes: b.byteLength, usPerBatch: +us.toFixed(1) })}`)
}
