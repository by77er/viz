// Same requests, two versions of src/: the batches (every byte), the counts and the refusal
// reasons must be identical, or the differences are printed and the exit code is 1.
//
//   node bench/differential.mjs [REV] [--seeds 1,2,3]
//
// REV is the git revision whose edge/src is "before" (default origin/main). The corpora:
//   - test/fixtures.json (Remote Write and OTLP metrics, encoded by protobufjs and snappyjs);
//   - bench/bodies.mjs's realistic requests (traces, logs, Loki push, metrics; protobuf and JSON);
//   - seeded random OTLP metrics requests, protobuf and JSON, with every AnyValue kind (nested
//     arrays and key-value lists, bytes, NaN, unicode), repeated and colliding keys, empty
//     values, gauges, sums of every temporality, histograms and staleness flags;
//   - scripts/otel-corpus.mjs's requests for each seed (spans, OTLP logs, Loki push), and eight
//     copies of each protobuf one with one to three random bytes changed (refusals, reasons, and
//     which error a malformed body is refused with).
// Signals REV does not decode (no spans.ts or logs.ts there, as on main) are skipped and named.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { realistic } from './bodies.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const EDGE = join(HERE, '..')
const args = process.argv.slice(2)
const seedsAt = args.indexOf('--seeds')
const seeds = seedsAt >= 0 ? args.splice(seedsAt, 2)[1].split(',').map(Number) : [1, 2]
const REV = args[0] ?? 'origin/main'
const work = mkdtempSync(join(tmpdir(), 'viz-edge-diff-'))

// ───────────────────────────── the two versions ─────────────────────────────

async function bundle(srcDir, out) {
  const { build } = await import('esbuild')
  const has = (f) => {
    try {
      readFileSync(join(srcDir, f))
      return true
    } catch {
      return false
    }
  }
  const lines = [
    `export { Collector, buildBatches } from './batch'`,
    `export { DEFAULT_LIMITS } from './limits'`,
    `export { decodeOtlpProto, decodeOtlpJson } from './otlp'`,
    `export { decodeRemoteWrite } from './prw'`,
    `export { snappyDecompress } from './snappy'`,
  ]
  if (has('spans.ts')) lines.push(`export { SpanCollector, decodeTracesProto, decodeTracesJson } from './spans'`)
  if (has('logs.ts')) lines.push(`export { LogCollector, decodeLogsProto, decodeLogsJson, decodeLokiProto, decodeLokiJson } from './logs'`)
  await build({
    stdin: { contents: lines.join('\n'), resolveDir: srcDir, loader: 'ts' },
    bundle: true, format: 'esm', platform: 'neutral', outfile: out, logLevel: 'error',
    plugins: [{ name: 'stubs', setup(b) {
      b.onResolve({ filter: /shard\/src\/(shard|pool)$/ }, (a) => ({ path: a.path, namespace: 'shard-stub' }))
      b.onLoad({ filter: /.*/, namespace: 'shard-stub' }, () => ({ contents: 'export const MAX_BATCH_BYTES = 1_048_576; export const enabledSignals = () => []', loader: 'js' }))
    } }],
  })
  return import(pathToFileURL(out).href)
}

const oldSrc = join(work, 'old', 'src')
mkdirSync(oldSrc, { recursive: true })
// From the repository's root: in a subdirectory `git ls-tree` lists only paths under it.
const ROOT = join(EDGE, '..')
for (const f of execFileSync('git', ['ls-tree', '--name-only', `${REV}:edge/src`], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean)) {
  writeFileSync(join(oldSrc, f), execFileSync('git', ['show', `${REV}:edge/src/${f}`], { cwd: ROOT }))
}
const OLD = await bundle(oldSrc, join(work, 'old.mjs'))
const NEW = await bundle(join(EDGE, 'src'), join(work, 'new.mjs'))

// ───────────────────────────── one request ─────────────────────────────

const sha = (b) => createHash('sha256').update(b).digest('hex').slice(0, 16)
/** The slot of a routing key: a fixed hash, so both versions route alike whatever their series order. */
const slotOf = (route) => createHash('sha256').update(route).digest()[0] % 4

function decode(E, c) {
  const L = { ...E.DEFAULT_LIMITS, ...c.limits }
  try {
    let body = c.body
    if (c.snappy) body = E.snappyDecompress(body, 1 << 30)
    if (c.path === 'metrics' || c.path === 'prw') {
      const col = new E.Collector(L, c.now, body.byteLength)
      if (c.path === 'prw') E.decodeRemoteWrite(body, col)
      else (c.json ? E.decodeOtlpJson : E.decodeOtlpProto)(body, col)
      const slots = Int32Array.from({ length: col.nSeries }, (_, i) => slotOf(col.routes[col.routeOf[i]]))
      const batches = [...E.buildBatches(col, slots, L.maxBatchBytes)].sort((a, b) => a[0] - b[0]).map(([s, bs]) => [s, bs.map((b) => sha(b.bytes) + `/${[...b.seriesIds].join(',')}`)])
      return { rows: col.nRows, rejected: col.rejectedTotal, reasons: col.rejectionSummary(), batches }
    }
    if ((c.path === 'traces' && !E.SpanCollector) || (c.path !== 'traces' && !E.LogCollector)) return { skipped: true }
    const col = c.path === 'traces' ? new E.SpanCollector(L, c.now) : new E.LogCollector(L, c.now)
    if (c.path === 'traces') (c.json ? E.decodeTracesJson : E.decodeTracesProto)(body, col)
    else if (c.path === 'logs') (c.json ? E.decodeLogsJson : E.decodeLogsProto)(body, col)
    else (c.json ? E.decodeLokiJson : E.decodeLokiProto)(body, col)
    const slots = Int32Array.from({ length: col.nSeries }, (_, i) => slotOf(col.routes[col.routeOf[i]]))
    const batches = [...col.build(slots, L.maxBatchBytes)].sort((a, b) => a[0] - b[0]).map(([s, bs]) => [s, bs.map((b) => `${sha(b.bytes)}/${b.rows}`)])
    return { rows: col.nRows, rejected: col.rejectedTotal, reasons: col.rejectionSummary(), batches }
  } catch (e) {
    return { status: e.status ?? `threw ${e.message}`, message: e.message }
  }
}

// ───────────────────────────── corpora ─────────────────────────────

const cases = []
const add = (name, path, json, body, extra = {}) => cases.push({ name, path, json, body, snappy: false, now: Date.now(), limits: {}, ...extra })

// test/fixtures.json
const fx = JSON.parse(readFileSync(join(EDGE, 'test', 'fixtures.json'), 'utf8'))
const b64 = (s) => new Uint8Array(Buffer.from(s, 'base64'))
add('fixtures: Remote Write', 'prw', false, b64(fx.prw.snappy), { snappy: true, now: fx.t0 })
add('fixtures: OTLP metrics, protobuf', 'metrics', false, b64(fx.otlp.proto), { now: fx.t0 })
add('fixtures: OTLP metrics, gzip', 'metrics', false, new Uint8Array(gunzipSync(b64(fx.otlp.gzip))), { now: fx.t0 })

// bench/bodies.mjs
for (const [name, path, json, snappy, make] of await realistic()) add(name, path, json, make(), { snappy })

// Random OTLP metrics, seeded.
const protobuf = (await import('protobufjs')).default
const M = protobuf.parse(`
syntax = "proto3"; package p;
message ExportMetricsServiceRequest { repeated ResourceMetrics resource_metrics = 1; }
message ResourceMetrics { Resource resource = 1; repeated ScopeMetrics scope_metrics = 2; }
message Resource { repeated KeyValue attributes = 1; }
message ScopeMetrics { Scope scope = 1; repeated Metric metrics = 2; }
message Scope { string name = 1; }
message Metric { string name = 1; string unit = 3; Gauge gauge = 5; Sum sum = 7; Histogram histogram = 9; }
message Gauge { repeated NumberDataPoint data_points = 1; }
message Sum { repeated NumberDataPoint data_points = 1; int32 aggregation_temporality = 2; bool is_monotonic = 3; }
message Histogram { repeated NumberDataPoint data_points = 1; int32 aggregation_temporality = 2; }
message NumberDataPoint { repeated KeyValue attributes = 7; fixed64 time_unix_nano = 3; double as_double = 4; sfixed64 as_int = 6; uint32 flags = 8; }
message KeyValue { string key = 1; AnyValue value = 2; }
message AnyValue { oneof value { string string_value = 1; bool bool_value = 2; int64 int_value = 3; double double_value = 4; ArrayValue array_value = 5; KeyValueList kvlist_value = 6; bytes bytes_value = 7; } }
message ArrayValue { repeated AnyValue values = 1; }
message KeyValueList { repeated KeyValue values = 1; }
`, { keepCase: true }).root.lookupType('p.ExportMetricsServiceRequest')

function randomMetrics(seed) {
  let s = seed >>> 0
  const rnd = () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296)
  const pick = (xs) => xs[Math.floor(rnd() * xs.length)]
  const keys = ['service.name', 'service.namespace', 'service.instance.id', 'job', 'instance', 'http.method', 'http_method', 'http-method', 'k8s.pod.name', 'zone', '0digit', '日本', '', 'a.b.c']
  const text = () => pick(['', 'x', 'GET', 'Zürich-🌡', 'a;b', 'with "quotes"', 'ctl\u0001', 'v'.repeat(Math.floor(rnd() * 40))])
  const value = (depth) => {
    const k = Math.floor(rnd() * (depth > 2 ? 5 : 8))
    if (k === 0) return { string_value: text() }
    if (k === 1) return { bool_value: rnd() < 0.5 }
    if (k === 2) return { int_value: protobuf.util.Long.fromNumber(Math.floor((rnd() - 0.5) * 1e12)) }
    if (k === 3) return { double_value: pick([0, -0, 1.5, NaN, Infinity, -1e300, rnd()]) }
    if (k === 4) return {}
    if (k === 5) return { array_value: { values: Array.from({ length: Math.floor(rnd() * 4) }, () => value(depth + 1)) } }
    if (k === 6) return { kvlist_value: { values: Array.from({ length: Math.floor(rnd() * 4) }, () => ({ key: pick(keys), value: value(depth + 1) })) } }
    return { bytes_value: Uint8Array.from({ length: Math.floor(rnd() * 6) }, () => Math.floor(rnd() * 256)) }
  }
  const attrs = (n) => Array.from({ length: n }, () => ({ key: pick(keys), value: value(0) }))
  const now = BigInt(Date.now()) * 1_000_000n
  const point = () => ({ attributes: attrs(Math.floor(rnd() * 5)), time_unix_nano: protobuf.util.Long.fromString(String(now - BigInt(Math.floor(rnd() * 3e12))), true), ...(rnd() < 0.5 ? { as_double: rnd() * 100 } : { as_int: protobuf.util.Long.fromNumber(Math.floor(rnd() * 100)) }), flags: rnd() < 0.1 ? 1 : 0 })
  const metric = (i) => {
    const pts = Array.from({ length: 1 + Math.floor(rnd() * 4) }, point)
    const k = Math.floor(rnd() * 4)
    if (k === 0) return { name: `g.${i}`, unit: pick(['', 'ms', 'By', '1', '{req}/s']), gauge: { data_points: pts } }
    if (k === 1) return { name: `s.${i}`, unit: pick(['', 's']), sum: { data_points: pts, aggregation_temporality: Math.floor(rnd() * 3), is_monotonic: rnd() < 0.5 } }
    if (k === 2) return { name: `h.${i}`, histogram: { data_points: pts, aggregation_temporality: 2 } }
    return { name: `c.${i}_total`, sum: { data_points: pts, aggregation_temporality: 2, is_monotonic: true } }
  }
  return { resource_metrics: Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => ({ resource: { attributes: attrs(Math.floor(rnd() * 6)) }, scope_metrics: [{ scope: { name: 'lib' }, metrics: Array.from({ length: 1 + Math.floor(rnd() * 6) }, (_, i) => metric(i)) }] })) }
}
const jsonAny = (v) => {
  if (v.string_value !== undefined) return { stringValue: v.string_value }
  if (v.bool_value !== undefined) return { boolValue: v.bool_value }
  if (v.int_value !== undefined) return { intValue: v.int_value.toString() }
  if (v.double_value !== undefined) return { doubleValue: Number.isFinite(v.double_value) ? v.double_value : String(v.double_value) }
  if (v.array_value) return { arrayValue: { values: v.array_value.values.map(jsonAny) } }
  if (v.kvlist_value) return { kvlistValue: { values: v.kvlist_value.values.map((x) => ({ key: x.key, value: jsonAny(x.value) })) } }
  if (v.bytes_value) return { bytesValue: Buffer.from(v.bytes_value).toString('base64') }
  return {}
}
const jsonMetrics = (o) => JSON.stringify({ resourceMetrics: o.resource_metrics.map((r) => ({ resource: { attributes: r.resource.attributes.map((a) => ({ key: a.key, value: jsonAny(a.value) })) }, scopeMetrics: r.scope_metrics.map((sm) => ({ scope: sm.scope, metrics: sm.metrics.map((m) => {
  const pts = (d) => d.data_points.map((p) => ({ attributes: p.attributes.map((a) => ({ key: a.key, value: jsonAny(a.value) })), timeUnixNano: p.time_unix_nano.toString(), ...(p.as_double !== undefined ? { asDouble: p.as_double } : { asInt: p.as_int.toString() }), flags: p.flags }))
  const out = { name: m.name, unit: m.unit }
  if (m.gauge) out.gauge = { dataPoints: pts(m.gauge) }
  if (m.sum) out.sum = { dataPoints: pts(m.sum), aggregationTemporality: m.sum.aggregation_temporality, isMonotonic: m.sum.is_monotonic }
  if (m.histogram) out.histogram = { dataPoints: pts(m.histogram), aggregationTemporality: 2 }
  return out
}) })) })) })
for (let seed = 1; seed <= 300; seed++) {
  const o = randomMetrics(seed)
  add(`random OTLP metrics ${seed}, protobuf`, 'metrics', false, M.encode(M.fromObject(o)).finish())
  add(`random OTLP metrics ${seed}, JSON`, 'metrics', true, new TextEncoder().encode(jsonMetrics(o)))
}

// scripts/otel-corpus.mjs requests.
for (const seed of seeds) {
  const out = join(work, `corpus-${seed}`)
  execFileSync('node', [join(EDGE, 'scripts', 'otel-corpus.mjs'), out, String(seed), '1', '--requests'], { cwd: EDGE, stdio: 'ignore' })
  const index = JSON.parse(readFileSync(join(out, 'requests', 'index.json'), 'utf8'))
  const now = Number(readFileSync(join(out, 'requests', 'now_ms'), 'utf8'))
  // The corpus's own limits (scripts/otel-corpus.mjs): its timestamps span hours and days.
  const limits = { maxSpans: 1e7, maxLogRecords: 1e7, spanAcceptBackMs: 1e13, spanAcceptAheadMs: 1e13, logAcceptBackMs: 1e13, logAcceptAheadMs: 1e13 }
  for (const r of index) {
    const path = r.path === '/v1/traces' ? 'traces' : r.path === '/v1/logs' ? 'logs' : 'loki'
    let body = new Uint8Array(readFileSync(join(out, 'requests', r.file)))
    if (r.contentEncoding === 'gzip') body = new Uint8Array(gunzipSync(body))
    const json = (r.contentType ?? '').includes('json')
    add(`otel-corpus seed ${seed}: ${r.file} ${r.path}`, path, json, body, { snappy: r.contentEncoding === 'snappy', now, limits })
    // Damaged copies: every outcome (refusals, their reasons, 400 and its message) must match too.
    if (json || r.contentEncoding === 'snappy') continue
    let s = seed * 7919 + body.length
    const rnd = () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296)
    for (let k = 0; k < 8; k++) {
      const d = Uint8Array.from(body)
      for (let j = 0; j < 1 + Math.floor(rnd() * 3); j++) d[Math.floor(rnd() * d.length)] = Math.floor(rnd() * 256)
      add(`otel-corpus seed ${seed}: ${r.file} ${r.path} damaged`, path, false, d, { now, limits })
    }
  }
}

// ───────────────────────────── compare ─────────────────────────────

let same = 0
let skipped = 0
const differ = []
const tally = new Map()
for (const c of cases) {
  const a = decode(OLD, c)
  if (a.skipped) {
    skipped++
    continue
  }
  const b = decode(NEW, c)
  const group = c.name.replace(/^(random OTLP metrics) \d+,/, '$1').replace(/^(otel-corpus) seed \d+: \S+ (\S+)( damaged)?$/, '$1 $2$3')
  const t = tally.get(group) ?? { n: 0, rows: 0, rejected: 0, errors: 0, differ: 0 }
  t.n++
  if (a.status) t.errors++
  t.rows += a.rows ?? 0
  t.rejected += a.rejected ?? 0
  if (JSON.stringify(a) === JSON.stringify(b)) same++
  else {
    t.differ++
    differ.push([c.name, a, b])
  }
  tally.set(group, t)
}
console.log(`before: ${REV}; after: the working tree\n`)
console.log('| Corpus | Requests | Rows (before) | Refused (before) | Refused whole (before) | Different |')
console.log('|---|---|---|---|---|---|')
for (const [g, t] of tally) console.log(`| ${g} | ${t.n} | ${t.rows} | ${t.rejected} | ${t.errors} | ${t.differ} |`)
console.log(`\n${same} identical, ${differ.length} different, ${skipped} skipped (the signal does not exist at ${REV})`)
for (const [name, a, b] of differ.slice(0, 10)) console.log(`\n${name}\n  before: ${JSON.stringify(a).slice(0, 400)}\n  after:  ${JSON.stringify(b).slice(0, 400)}`)
process.exit(differ.length ? 1 : 0)
