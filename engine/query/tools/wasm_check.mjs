// Proves the whole-engine module needs no JavaScript glue: it has zero imports, is
// instantiated with an empty import object, and answers queries over Parquet + tail.
//
//   (cd wasm && CARGO_TARGET_DIR=$PWD/../target cargo build --release --target wasm32-unknown-unknown)
//   node tools/wasm_check.mjs [path/to/viz_whole_engine.wasm]
import { readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const here = fileURLToPath(new URL('.', import.meta.url))
const path = process.argv[2] ?? here + '../target/wasm32-unknown-unknown/release/viz_whole_engine.wasm'
const bytes = readFileSync(path)
console.log(`module: ${bytes.length} bytes raw, ${gzipSync(bytes, { level: 9 }).length} bytes gzip -9`)

const module = new WebAssembly.Module(bytes)
const imports = WebAssembly.Module.imports(module)
console.log(`imports: ${imports.length}`, imports.map((i) => `${i.module}.${i.name}`).join(' '))
assert.equal(imports.length, 0, 'the module must import nothing')
const exportNames = WebAssembly.Module.exports(module).map((e) => e.name)
assert.ok(!exportNames.some((n) => n.startsWith('__wbindgen')), 'no wasm-bindgen exports')
console.log(`exports: ${exportNames.join(' ')}`)

const t0 = performance.now()
const instantiate = () => new WebAssembly.Instance(module, {}).exports // an EMPTY import object
let vz = instantiate()
console.log(`instantiate: ${(performance.now() - t0).toFixed(1)} ms`)

// ---------------------------------------------------------------- calling convention
const enc = new TextEncoder()
const dec = new TextDecoder()
function put(vz, data) {
  const p = vz.viz_alloc(data.length)
  new Uint8Array(vz.memory.buffer, p, data.length).set(data)
  return p
}
function take(vz, r) {
  const ptr = Number(r >> 32n), len = Number(r & 0xffffffffn)
  const out = new Uint8Array(vz.memory.buffer, ptr, len).slice()
  vz.viz_free(ptr, len)
  return out
}
function blobList(blobs) {
  const out = new Uint8Array(4 + blobs.reduce((n, b) => n + 4 + b.length, 0))
  const dv = new DataView(out.buffer)
  dv.setUint32(0, blobs.length, true)
  let o = 4
  for (const b of blobs) { dv.setUint32(o, b.length, true); out.set(b, o + 4); o += 4 + b.length }
  return out
}
function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}
function call(vz, name, bufs, ...nums) {
  const args = []
  for (const b of bufs) args.push(put(vz, b), b.length)
  const res = take(vz, vz[name](...args, ...nums))
  for (let i = 0; i < bufs.length; i++) vz.viz_free(args[2 * i], bufs[i].length)
  return res
}
const json = (vz, name, bufs, ...nums) => JSON.parse(dec.decode(call(vz, name, bufs, ...nums)))
function files(res) {
  assert.equal(res[0], 0, 'storage call failed: ' + dec.decode(res.subarray(1)))
  const dv = new DataView(res.buffer, res.byteOffset)
  const out = { samples: [], series: [] }
  let o = 5
  for (let i = 0; i < dv.getUint32(1, true); i++) {
    const len = dv.getUint32(o, true)
    ;(res[o + 4] === 0 ? out.samples : out.series).push(res.slice(o + 5, o + 4 + len))
    o += 4 + len
  }
  return out
}

// ---------------------------------------------------------------- a VZB1 batch encoder (contracts/BATCH.md)
function seriesId(labels) {
  let h = 0xcbf29ce484222325n
  const eat = (s) => {
    for (const b of enc.encode(s)) h = ((h ^ BigInt(b)) * 0x100000001b3n) & 0xffffffffffffffffn
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn // the 0x00 separator
  }
  for (const [n, v] of labels) { eat(n); eat(v) }
  return BigInt.asIntN(64, h)
}
const STALE = 0x7ff0000000000002n
function batch(series, rows) {
  // series: sorted [name, value][] per series; rows: [seriesIdx, tsMs, value | STALE]
  const table = []
  for (const labels of series) {
    const head = new DataView(new ArrayBuffer(12))
    head.setBigInt64(0, seriesId(labels), true)
    head.setUint32(8, labels.length, true)
    table.push(new Uint8Array(head.buffer))
    for (const part of labels.flat()) {
      const b = enc.encode(part)
      table.push(new Uint8Array(new Uint16Array([b.length]).buffer), b)
    }
  }
  const tbl = concat(table)
  const pad8 = (n) => (8 - (n % 8)) % 8
  const idxAt = 16 + tbl.length + pad8(16 + tbl.length)
  const tsAt = idxAt + 4 * rows.length + pad8(idxAt + 4 * rows.length)
  const out = new Uint8Array(tsAt + 16 * rows.length)
  const dv = new DataView(out.buffer)
  out.set(enc.encode('VZB1'), 0)
  out[4] = 1
  dv.setUint32(8, rows.length, true)
  dv.setUint32(12, series.length, true)
  out.set(tbl, 16)
  rows.forEach(([s, ts, v], i) => {
    dv.setUint32(idxAt + 4 * i, s, true)
    dv.setBigInt64(tsAt + 8 * i, BigInt(ts), true)
    // Staleness markers are written as bits: a JS number cannot carry the payload safely.
    if (v === STALE) dv.setBigUint64(tsAt + 8 * rows.length + 8 * i, STALE, true)
    else dv.setFloat64(tsAt + 8 * rows.length + 8 * i, v, true)
  })
  return out
}

// ---------------------------------------------------------------- data: 40 counters in 4 jobs, one hour + 5 min at 15 s
const T0 = 1_700_005_000_000 // 2023-11-14T23:36:40Z: the data crosses UTC midnight
const N = 40, STEPS = 261
const series = []
for (let i = 0; i < N; i++) {
  series.push([['__name__', 'http_requests_total'], ['instance', `i${String(i).padStart(2, '0')}`], ['job', `job${i % 4}`]])
}
series.push([['__name__', 'up'], ['job', 'gone']])
const rows = []
for (let k = 0; k < STEPS; k++) {
  for (let i = 0; i < N; i++) rows.push([i, T0 + k * 15_000, (i + 1) * k]) // instance i grows by i+1 per scrape
  if (k < 100) rows.push([N, T0 + k * 15_000, 1])
  if (k === 100) rows.push([N, T0 + k * 15_000, STALE])
}
// Six batches; the first four are flushed to Parquet, the last three stay in the tail
// (so one batch is in both places).
const per = Math.ceil(rows.length / 6)
const batches = []
for (let b = 0; b < 6; b++) {
  const part = rows.slice(b * per, (b + 1) * per)
  const used = [...new Set(part.map((r) => r[0]))]
  batches.push(batch(used.map((s) => series[s]), part.map(([s, t, v]) => [used.indexOf(s), t, v])))
}
const lake = files(call(vz, 'viz_encode_segment', [blobList(batches.slice(0, 2))]))
const lake2 = files(call(vz, 'viz_encode_segment', [blobList(batches.slice(2, 4))]))
const sampleFiles = [...lake.samples, ...lake2.samples], seriesFiles = [...lake.series, ...lake2.series]
const tail = batches.slice(3)
console.log(`data: ${rows.length} samples, ${sampleFiles.length} sample files (${sampleFiles.reduce((n, f) => n + f.length, 0)} bytes of Parquet), ${tail.length} tail batches`)
assert.ok(sampleFiles.length >= 3, 'two flushes over two UTC days')
const input = concat([blobList(seriesFiles), blobList(sampleFiles), blobList(tail)])
const allTail = concat([blobList([]), blobList([]), blobList(batches)])

// ---------------------------------------------------------------- queries
const q = (s) => enc.encode(s)
const start = BigInt(T0 + 300_000), end = BigInt(T0 + 3_900_000), step = 15_000n

const t1 = performance.now()
const r = json(vz, 'viz_query_range', [input, q('sum by (job) (rate(http_requests_total[5m]))')], start, end, step)
const first = performance.now() - t1
assert.equal(r.status, 'success', JSON.stringify(r).slice(0, 300))
assert.equal(r.data.resultType, 'matrix')
assert.equal(r.data.result.length, 4)
for (const s of r.data.result) {
  const j = Number(s.metric.job.slice(3))
  // instances j, j+4, ... each grow by (i+1) per 15 s: the job's rate is sum(i+1)/15 per second.
  let want = 0
  for (let i = j; i < N; i += 4) want += (i + 1) / 15
  assert.deepEqual(Object.keys(s.metric), ['job'])
  assert.equal(s.values.length, 241)
  assert.equal(s.values[0][0], (T0 + 300_000) / 1000, 'timestamps are Unix seconds')
  for (const [, v] of s.values) assert.ok(Math.abs(Number(v) - want) < 1e-9 * want, `${s.metric.job}: ${v} != ${want}`)
}
const t2 = performance.now()
const again = json(vz, 'viz_query_range', [input, q('sum by (job) (rate(http_requests_total[5m]))')], start, end, step)
console.log(`query_range sum by (job) (rate(...[5m])), 40 series, 241 steps, lake + tail: first call ${first.toFixed(1)} ms, second ${(performance.now() - t2).toFixed(1)} ms`)
assert.deepEqual(again, r)
// Storage-location invariance, in the module: the same rows all in the tail.
assert.deepEqual(json(vz, 'viz_query_range', [allTail, q('sum by (job) (rate(http_requests_total[5m]))')], start, end, step), r)

// The series ended by a staleness marker (written from JS as raw bits, flushed to Parquet).
const up = json(vz, 'viz_query_range', [input, q('up')], BigInt(T0 + 99 * 15_000), BigInt(T0 + 110 * 15_000), 15_000n)
assert.equal(up.data.result.length, 1)
assert.deepEqual(up.data.result[0].values, [[(T0 + 99 * 15_000) / 1000, '1']], 'the marker ends the series')

const inst = json(vz, 'viz_query_instant', [input, q('count(http_requests_total)')], end)
assert.deepEqual(inst.data, { resultType: 'vector', result: [{ metric: {}, value: [Number(end) / 1000, '40'] }] })

const plan = json(vz, 'viz_plan', [q('sum by (job) (rate(http_requests_total[5m]))')], start, end, step)
assert.deepEqual(plan.data, [{ matchers: [{ name: '__name__', op: '=', value: 'http_requests_total' }], minTs: T0 + 1, maxTs: T0 + 3_900_000 }])

assert.deepEqual(json(vz, 'viz_label_names', [input, q('')], start, end).data, ['__name__', 'instance', 'job'])
assert.deepEqual(json(vz, 'viz_label_values', [input, q('job'), q('http_requests_total')], start, end).data, ['job0', 'job1', 'job2', 'job3'])
assert.equal(json(vz, 'viz_series', [input, q('{job=~"job[01]"}')], start, end).data.length, 20)

// Compaction links too, and the compacted day gives the same answer.
const day1 = files(call(vz, 'viz_merge_files', [blobList([lake.samples[0], lake2.samples[0]])], 0)).samples
assert.equal(day1.length, 1)

// Errors come back as Prometheus error bodies. Parse errors run lrpar's error path, the
// only code that could have asked for a clock: nothing traps.
for (const [query, type] of [['sum(', 'bad_data'], ['up +', 'bad_data'], ['up{a=~"("}', 'bad_data'], ['@@@', 'bad_data'], ['', 'bad_data'], ['up[1e400]', 'bad_data'],
  ['limitk(1, up)', 'unsupported'], ['http_requests_total + on(job) http_requests_total', 'execution']]) {
  const e = json(vz, 'viz_query_range', [input, q(query)], start, end, step)
  assert.equal(e.status, 'error', query)
  assert.equal(e.errorType, type, `${query}: ${e.error}`)
}
const many = json(vz, 'viz_query_range', [input, q('up')], 0n, 11_000_000n, 1000n)
assert.equal(many.errorType, 'bad_data')

// Date functions do not need a clock either (chrono is linked without JS bindings).
assert.equal(json(vz, 'viz_query_instant', [input, q('day_of_week(vector(1700006400))')], end).data.result[0].value[1], '3')

// ---------------------------------------------------------------- stack headroom for nested queries
// The module's stack is 1 MiB. A query at the default depth limit (100) must evaluate;
// measure how deep each shape can go with limits off (a fresh instance per attempt,
// because a stack overflow traps and poisons the instance).
const shapes = {
  parens: (n) => '('.repeat(n) + 'm' + ')'.repeat(n),
  'binary chain': (n) => 'm' + ' + m'.repeat(n),
  unary: (n) => '-'.repeat(n) + 'm',
  'function calls': (n) => 'abs('.repeat(n) + 'm' + ')'.repeat(n),
  aggregations: (n) => 'sum('.repeat(n) + 'm' + ')'.repeat(n),
  subqueries: (n) => 'max_over_time('.repeat(n) + 'm[1m]' + ')[1m:15s]'.repeat(n - 1) + ')',
}
const survives = (text) => {
  const fresh = instantiate()
  try { return json(fresh, 'viz_probe_unlimited', [q(text)]).status === 'success' } catch { return false }
}
for (const [name, make] of Object.entries(shapes)) {
  // A subquery level is two levels to the guard (the call, and the `]` that wraps it).
  const atLimit = name === 'subqueries' ? 49 : 99
  const guarded = json(vz, 'viz_query_range', [input, q(make(atLimit))], start, start, 1n)
  assert.equal(guarded.status, 'success', `${name} at the depth limit: ${JSON.stringify(guarded).slice(0, 200)}`)
  const refused = json(vz, 'viz_query_range', [input, q(make(120))], start, start, 1n)
  assert.equal(refused.errorType, 'execution', name)
  assert.match(refused.error, /max_depth/)
  let lo = 100, hi = 100
  while (hi < 200_000 && survives(make(hi))) { lo = hi; hi *= 2 }
  while (hi - lo > Math.max(1, lo >> 4)) { const mid = (lo + hi) >> 1; if (survives(make(mid))) lo = mid; else hi = mid }
  console.log(`depth headroom, ${name}: evaluates at nesting ${lo}${hi >= 200_000 ? '+' : ''}, limit is 100`)
  assert.ok(lo >= 200, `${name}: less than 2x headroom over max_depth`)
}
console.log(`memory after all of this: ${(vz.memory.buffer.byteLength / 1048576).toFixed(1)} MiB`)
console.log('OK: no imports, empty import object, queries answered')
