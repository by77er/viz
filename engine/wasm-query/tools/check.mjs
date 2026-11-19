#!/usr/bin/env node
/**
 * Load proof and size report for js/viz_query.wasm, in Node (no workerd, no bundler):
 *
 *   - raw size, and compressed size with zlib at level 9;
 *   - the module imports NOTHING and exports only `memory` and the C ABI;
 *   - `new WebAssembly.Instance(module, {})` (an empty import object) succeeds; timing;
 *   - through the TypeScript binding (js/index.ts, loaded by Node's type stripping): a
 *     batch encoded here is queried (range, instant, select, metadata, plan, pruning),
 *     limits come back as typed errors, and parse errors do not trap.
 *
 *   ./build.sh && node tools/check.mjs
 */
import { readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { createQueryEngine, DEFAULT_LIMITS, QueryError, sparseFile } from '../js/index.ts'

const path = new URL('../js/viz_query.wasm', import.meta.url)
const bytes = readFileSync(path)
let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`)
  if (!ok) failed++
}

console.log(`js/viz_query.wasm: ${bytes.length} bytes raw, ${gzipSync(bytes, { level: 9 }).length} bytes with zlib at level 9 (build.sh prints the gzip -9 figure)`)
const module = new WebAssembly.Module(bytes)
const imports = WebAssembly.Module.imports(module)
const exports = WebAssembly.Module.exports(module).map((e) => e.name).sort()
check('no imports', imports.length === 0, `${imports.length} imports`)
check('exports are memory and the C ABI only', exports.every((n) => n === 'memory' || n === 'viz_alloc' || n === 'viz_free' || n.startsWith('viz_q_')) && !exports.some((n) => n.includes('wbindgen')), exports.join(' '))

const t0 = performance.now()
for (let i = 0; i < 200; i++) new WebAssembly.Instance(module, {})
check('instantiates with an empty import object', true, `${((performance.now() - t0) / 200).toFixed(3)} ms each in Node, mean of 200`)

// ── a VZB1 batch (contracts/BATCH.md), encoded here ──
const te = new TextEncoder()
const cmp = (a, b) => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i]
  return a.length - b.length
}
const canonical = (labels) => Object.entries(labels).map(([n, v]) => [te.encode(n), te.encode(v)]).sort((a, b) => cmp(a[0], b[0]))
function seriesId(labels) {
  let h = 0xcbf29ce484222325n
  for (const pair of canonical(labels)) {
    for (const part of pair) {
      for (const b of part) h = BigInt.asUintN(64, (h ^ BigInt(b)) * 0x100000001b3n)
      h = BigInt.asUintN(64, h * 0x100000001b3n)
    }
  }
  return BigInt.asIntN(64, h)
}
const pad8 = (n) => (n + 7) & ~7
function batch(series, rows) {
  const entries = series.map((l) => ({ id: seriesId(l), labels: canonical(l) }))
  let table = 0
  for (const e of entries) table += 12 + e.labels.reduce((a, [n, v]) => a + 4 + n.length + v.length, 0)
  const idxAt = pad8(16 + table)
  const tsAt = idxAt + pad8(4 * rows.length)
  const valAt = tsAt + 8 * rows.length
  const out = new Uint8Array(valAt + 8 * rows.length)
  const dv = new DataView(out.buffer)
  out.set(te.encode('VZB1'), 0)
  out[4] = 1
  dv.setUint32(8, rows.length, true)
  dv.setUint32(12, entries.length, true)
  let p = 16
  for (const e of entries) {
    dv.setBigInt64(p, e.id, true)
    dv.setUint32(p + 8, e.labels.length, true)
    p += 12
    for (const pair of e.labels) {
      for (const part of pair) {
        dv.setUint16(p, part.length, true)
        out.set(part, p + 2)
        p += 2 + part.length
      }
    }
  }
  rows.forEach(([s, ts, bits], i) => {
    dv.setUint32(idxAt + 4 * i, s, true)
    dv.setBigInt64(tsAt + 8 * i, BigInt(ts), true)
    dv.setBigUint64(valAt + 8 * i, bits, true)
  })
  return out
}
const bits = (v) => {
  const dv = new DataView(new ArrayBuffer(8))
  dv.setFloat64(0, v, true)
  return dv.getBigUint64(0, true)
}

const T = Date.UTC(2026, 10, 18, 12)
const STALE = 0x7ff0000000000002n
const series = [{ __name__: 'http_requests_total', job: 'api', instance: 'a' }, { __name__: 'http_requests_total', job: 'api', instance: 'b' }, { __name__: 'up', job: 'api', instance: 'a' }]
const rows = []
for (let k = 0; k <= 40; k++) {
  rows.push([0, T + k * 15_000, bits(k * 30)], [1, T + k * 15_000, bits(k * 15)])
  if (k < 20) rows.push([2, T + k * 15_000, bits(1)])
}
rows.push([2, T + 20 * 15_000, STALE])
const input = { seriesFiles: [], sampleFiles: [], tailBatches: [batch(series, rows)] }

const errorOf = (f) => {
  try {
    f()
  } catch (e) {
    return e
  }
  return null
}
const engine = createQueryEngine(module)
const r = engine.queryRange(input, 'sum by (job)(rate(http_requests_total[1m]))', T + 60_000, T + 600_000, 60_000)
check('queryRange: sum by (job)(rate(m[1m])) is 3 per second at every step', r.resultType === 'matrix' && r.result.length === 1 && r.result[0].values.length === 10 && r.result[0].values.every(([t, v], i) => t === (T + 60_000) / 1000 + 60 * i && Math.abs(Number(v) - 3) < 1e-9), JSON.stringify(r.result[0]?.values.slice(0, 2)))
const i1 = engine.queryInstant(input, 'up', T + 19 * 15_000)
const i2 = engine.queryInstant(input, 'up', T + 20 * 15_000)
check('queryInstant: the staleness marker ends the series', i1.result.length === 1 && i2.result.length === 0)
const sel = engine.select(input, [{ name: '__name__', op: '=', value: 'up' }], 0, T + 10 ** 9)
const last = new DataView(sel[0].values.buffer).getBigUint64(8 * 20, true)
check('select: the marker comes back bit for bit', sel.length === 1 && sel[0].ts.length === 21 && last === STALE, last.toString(16))
check('plan', JSON.stringify(engine.plan('rate(up[1m])', T, T + 60_000, 15_000)) === JSON.stringify([{ matchers: [{ name: '__name__', op: '=', value: 'up' }], minTs: T - 59_999, maxTs: T + 60_000 }]))
check('labelNames / labelValues / series', engine.labelNames(input, [], 0, T + 10 ** 9).join() === '__name__,instance,job' && engine.labelValues(input, 'instance', ['up'], 0, T + 10 ** 9).join() === 'a' && engine.series(input, ['up'], 0, T + 10 ** 9).length === 1)
check('scanRows on an unparsable fragment is unknown, never "skip"', engine.scanRows(['?'], [])[0] === null && engine.filesNeeded(['?'], [])[0] === true)
// Series-level pruning (ABI 3). A fragment with row-group series bounds and a footer location.
const frag = JSON.stringify({ v: 1, rg: [0, 1, 2, 3].map((g) => ({ rows: 100, off: 4 + 1000 * g, len: 1000, min_name: 'up', max_name: 'up', min_ts: T, max_ts: T + 600_000, sid: [g * 2 ** 50, g * 2 ** 50 + 999] })), foot: [4004, 500] })
const upAll = [{ matchers: [{ name: '__name__', op: '=', value: 'up' }], minTs: T, maxTs: T + 60_000 }]
const fp = engine.filePlan([frag, '?', frag], [...upAll, { matchers: [{ name: '__name__', op: '=', value: 'down' }], minTs: T, maxTs: T }], 0)
check('filePlan: by name and time; an unparsable fragment is read whole', fp[0].read === 'whole' && fp[0].rows === 400 && fp[1].read === 'whole' && fp[1].rows === null, JSON.stringify(fp))
const pp = engine.partPlan([frag], upAll, 0, 2 ** 20, 0)
check('partPlan: the part holding small ids reads one row group and the footer', JSON.stringify(pp[0]) === JSON.stringify({ rows: 100, read: [[4, 1000], [4004, 500]] }), JSON.stringify(pp))
const sp = engine.samplePlan([], [frag, '?'], upAll)
check('samplePlan: with no series file, nothing is selected; unknown stays whole', sp.series === 0 && sp.files[0].read === 'skip' && sp.files[1].read === 'whole', JSON.stringify(sp))
const bad = errorOf(() => engine.labelNames({ seriesFiles: [sparseFile(100, [{ offset: 90, bytes: new Uint8Array(20) }])], sampleFiles: [], tailBatches: [] }, [], 0, T))
check('a malformed sparse file is an internal error, with no trap', bad instanceof QueryError && bad.errorType === 'internal' && engine.instances() === 1, bad?.message)
check('the label calls never open a sample file', engine.labelValues({ ...input, sampleFiles: [new TextEncoder().encode('PAR1 not parquet')] }, 'instance', ['up'], 0, T + 10 ** 9).join() === 'a')

const limit = errorOf(() => engine.queryRange(input, 'http_requests_total', T, T + 600_000, 15_000, { ...DEFAULT_LIMITS, maxSamples: 10 }))
check('a limit is a typed execution error naming the limit', limit instanceof QueryError && limit.errorType === 'execution' && limit.limit?.name === 'max_samples' && limit.limit.max === 10, limit?.message)
const kinds = [['sum(', 'bad_data'], ['up[', 'bad_data'], ['rate(up)', 'bad_data'], ['up{a=~"("}', 'bad_data'], ['1 +', 'bad_data'], ['up offset', 'bad_data'], ['limitk(1, up)', 'unsupported'], ['up + on (job) http_requests_total', 'execution']]
check('parse and evaluation errors come back typed, with no trap', kinds.every(([q, t]) => errorOf(() => engine.queryInstant(input, q, T))?.errorType === t) && engine.instances() === 1)
check('a non-integer time is refused', errorOf(() => engine.queryInstant(input, 'up', T + 0.5)) instanceof RangeError)
console.log(`WASM memory after everything: ${(engine.memoryBytes() / 2 ** 20).toFixed(1)} MiB`)
process.exit(failed ? 1 : 0)
