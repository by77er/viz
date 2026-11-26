// The cost of `batchTimeBounds` (src/tail.ts, D72) per batch, timed in Node, not workerd (workerd's
// clock moves in whole milliseconds, too coarse for one walk).
//   node --experimental-strip-types --no-warnings bench/walk.node.mjs        (Node 22.6 or later)
//
// Typical batches; the most expensive shapes edge builds for the walk (review of D72, m-4: every
// span its own resource of 128 attributes, every log record its own stream; edge's own encoder
// builds the same shapes in test/bounds.edge.test.ts "R5b", whose sizes these match); and 1 MiB
// shapes edge never builds (the review's walk-hostile.mts), which the walk refuses or passes in
// linear time.
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
// Edge's worst: one span per resource, each resource 128 attributes (service.name and 127 bools
// with one- or two-byte keys), as many as fit 1 MiB (edge: 1,289).
const keys = Array.from({ length: 127 }, (_, i) => String.fromCharCode(33 + (i % 90)) + (i >= 90 ? 'x' : '')).sort()
const worstSpans = (n) => encodeSpanBatch(
  Array.from({ length: n }, (_, k) => ({ resourceFp: BigInt(k), resource: [...keys.map((key) => [key, { b: true }]), ['service.name', { s: `s${k}` }]].sort((a, b) => (a[0] < b[0] ? -1 : 1)), scopeName: '', scopeVersion: '' })),
  Array.from({ length: n }, (_, k) => ({ entry: k, traceId: id(16), spanId: id(8), start: NS0 - BigInt(k) * MS, end: NS0, name: '' })),
)
// Edge's worst for logs: one record per stream, each a one-label stream (edge: 12,465 in 1 MiB).
const worstLogs = (n) => encodeLogBatch(Array.from({ length: n }, (_, k) => ({ labels: { a: `${k}` } })), Array.from({ length: n }, (_, k) => ({ entry: k, ts: NS0 - BigInt(k) * MS, line: '' })))
// Shapes edge never builds (1 MiB each).
const LEN = 1 << 20
const raw = (signal, fill) => {
  const b = new Uint8Array(LEN)
  b.set([0x56, 0x5a, 0x42, 0x31, signal, 0, 0, 0])
  fill(new DataView(b.buffer))
  return b
}
const cases = [
  ['spans, 1 entry, 3,000 rows', span(3000, 1), true],
  ['spans, 50 entries of 20 attributes, 3,000 rows', span(3000, 50), true],
  ['logs, 5,000 rows', log(5000), true],
  ['logs, 1 row', log(1), true],
  ['spans, edge\'s worst: 1,289 resources of 128 attributes, a span each', worstSpans(1289), true],
  ['logs, edge\'s worst: 12,465 one-label streams, a record each', worstLogs(12465), true],
  ['not edge: logs, 1 stream of 262,000 empty labels', raw(3, (dv) => { dv.setUint32(8, 1, true); dv.setUint32(12, 1, true); dv.setUint32(24, Math.floor((LEN - 16 - 8 - 4 - 64) / 4), true) }), false],
  ['not edge: spans, 58,000 empty entries', raw(2, (dv) => { dv.setUint32(8, 1, true); dv.setUint32(12, Math.floor((LEN - 80) / 18), true) }), false],
  ['not edge: spans, 1 entry of 65,535 bool attributes with empty keys', raw(2, (dv) => { dv.setUint32(8, 1, true); dv.setUint32(12, 1, true); dv.setUint16(24, 65535, true); for (let i = 0; i < 65535; i++) dv.setUint8(26 + 4 * i + 2, 4) }), false],
  ['not edge: logs, 87,000 rows and no entry', raw(3, (dv) => { dv.setUint32(8, Math.floor((LEN - 64) / 12) - 1, true) }), false],
]
for (const [name, b, bounded] of cases) {
  if ((batchTimeBounds(b) !== null) !== bounded) throw new Error(`${name}: bounds ${JSON.stringify(batchTimeBounds(b))}`)
  for (let i = 0; i < 50; i++) batchTimeBounds(b) // warm up
  const reps = b.byteLength > 500_000 && !name.startsWith('spans, 1') && !name.startsWith('logs, 5') ? 200 : 2000
  const t = process.hrtime.bigint()
  for (let i = 0; i < reps; i++) batchTimeBounds(b)
  const us = Number(process.hrtime.bigint() - t) / 1000 / reps
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  console.log(`WALK ${JSON.stringify({ case: name, bytes: b.byteLength, rows: dv.getUint32(8, true), entries: dv.getUint32(12, true), bounded, usPerBatch: +us.toFixed(1) })}`)
}
