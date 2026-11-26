// A corpus of spans and logs for the read-back checks (engine/storage/readback, and
// engine/storage/tools/otel_independent_check.py):
//
//   node scripts/otel-corpus.mjs OUT [seed] [scale] [--requests]
//
// 1. Generates traces (trees across services, every attribute type, Unicode, empty and
//    long values, events, links, errors, clamped ends, orphans) and logs (OTLP and Loki
//    push, logfmt and JSON lines, structured metadata, trace links), plus retries.
// 2. Encodes the requests with protobufjs (from .proto definitions; independent of edge's
//    hand-written readers) or as OTLP/JSON, and Loki push protobuf with snappyjs.
// 3. Decodes them with edge's own decoders (bundled from src/ with esbuild) into VZB1 signal
//    2 and 3 batches: OUT/batches/{spans,logs}-NNNNN.bin, in request order.
// 4. Writes what the stored data must be, computed here from the generated model with the
//    contracts' mapping rules (a second implementation, sharing no code with src/):
//    OUT/expected/spans.jsonl and OUT/expected/logs.jsonl, duplicates resolved (later wins).
//
// 5. With `--requests`, also the requests themselves, as sent: OUT/requests/NNNNN.bin, an
//    index.json of {file, path, contentType, contentEncoding} in sending order, and now_ms (the
//    clock the decoders above were given), so the same requests can go through the real write
//    path (stack/tools/signals_readback.mjs, stage 2 of traces and logs).
//
// Deterministic for a seed. Nothing here is copied from an incompatible project; the .proto
// field numbers are those of opentelemetry-proto and Loki's pkg/push (both Apache-2.0).
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import protobuf from 'protobufjs'
import snappy from 'snappyjs'

const OUT = process.argv[2]
if (!OUT) {
  console.error('usage: node scripts/otel-corpus.mjs OUT [seed] [scale]')
  process.exit(2)
}
const SEED = Number(process.argv[3] ?? 1)
const SCALE = Number(process.argv[4] ?? 1)
const REQUESTS = process.argv.includes('--requests')

const bundle = join(mkdtempSync(join(tmpdir(), 'viz-otel-corpus-')), 'edge.mjs')
await build({
  stdin: {
    contents: `export * from './src/spans'; export * from './src/logs'; export * from './src/limits'; export * from './src/snappy'`,
    resolveDir: new URL('..', import.meta.url).pathname,
    loader: 'ts',
  },
  bundle: true, format: 'esm', platform: 'neutral', outfile: bundle, logLevel: 'error',
  // The shard module (imported for MAX_BATCH_BYTES) imports the Workers runtime; stand-ins suffice here.
  plugins: [{
    name: 'workers-stub',
    setup(b) {
      b.onResolve({ filter: /^cloudflare:/ }, (a) => ({ path: a.path, namespace: 'stub' }))
      // Only MAX_BATCH_BYTES is needed from the shard module: its contract value (BATCH.md), so
      // the bundle does not depend on the shard's other code.
      b.onResolve({ filter: /shard\/src\/shard$/ }, () => ({ path: 'shard', namespace: 'shard-stub' }))
      b.onLoad({ filter: /.*/, namespace: 'shard-stub' }, () => ({ contents: 'export const MAX_BATCH_BYTES = 1_048_576', loader: 'js' }))
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export class DurableObject {}; export class WorkerEntrypoint {}; export const env = {}', loader: 'js' }))
    },
  }],
})
const E = await import(pathToFileURL(bundle).href)

const proto = protobuf.parse(`
syntax = "proto3";
package p;
message ExportTraceServiceRequest { repeated ResourceSpans resource_spans = 1; }
message ResourceSpans { Resource resource = 1; repeated ScopeSpans scope_spans = 2; string schema_url = 3; }
message Resource { repeated KeyValue attributes = 1; uint32 dropped_attributes_count = 2; }
message InstrumentationScope { string name = 1; string version = 2; repeated KeyValue attributes = 3; uint32 dropped_attributes_count = 4; }
message ScopeSpans { InstrumentationScope scope = 1; repeated Span spans = 2; string schema_url = 3; }
message Span { bytes trace_id = 1; bytes span_id = 2; string trace_state = 3; bytes parent_span_id = 4; fixed32 flags = 16;
  string name = 5; int32 kind = 6; fixed64 start_time_unix_nano = 7; fixed64 end_time_unix_nano = 8;
  repeated KeyValue attributes = 9; uint32 dropped_attributes_count = 10; repeated Event events = 11;
  uint32 dropped_events_count = 12; repeated Link links = 13; uint32 dropped_links_count = 14; Status status = 15; }
message Event { fixed64 time_unix_nano = 1; string name = 2; repeated KeyValue attributes = 3; uint32 dropped_attributes_count = 4; }
message Link { bytes trace_id = 1; bytes span_id = 2; string trace_state = 3; repeated KeyValue attributes = 4; uint32 dropped_attributes_count = 5; fixed32 flags = 6; }
message Status { string message = 2; int32 code = 3; }
message ExportLogsServiceRequest { repeated ResourceLogs resource_logs = 1; }
message ResourceLogs { Resource resource = 1; repeated ScopeLogs scope_logs = 2; string schema_url = 3; }
message ScopeLogs { InstrumentationScope scope = 1; repeated LogRecord log_records = 2; string schema_url = 3; }
message LogRecord { fixed64 time_unix_nano = 1; fixed64 observed_time_unix_nano = 11; int32 severity_number = 2; string severity_text = 3;
  AnyValue body = 5; repeated KeyValue attributes = 6; uint32 dropped_attributes_count = 7; fixed32 flags = 8;
  bytes trace_id = 9; bytes span_id = 10; string event_name = 12; }
message KeyValue { string key = 1; AnyValue value = 2; }
message AnyValue { oneof value { string string_value = 1; bool bool_value = 2; int64 int_value = 3; double double_value = 4;
  ArrayValue array_value = 5; KeyValueList kvlist_value = 6; bytes bytes_value = 7; } }
message ArrayValue { repeated AnyValue values = 1; }
message KeyValueList { repeated KeyValue values = 1; }
message PushRequest { repeated StreamAdapter streams = 1; }
message StreamAdapter { string labels = 1; repeated EntryAdapter entries = 2; uint64 hash = 3; }
message EntryAdapter { Timestamp timestamp = 1; string line = 2; repeated LabelPairAdapter structuredMetadata = 3; repeated LabelPairAdapter parsed = 4; }
message LabelPairAdapter { string name = 1; string value = 2; }
message Timestamp { int64 seconds = 1; int32 nanos = 2; }
`, { keepCase: true }).root
const TracesReq = proto.lookupType('p.ExportTraceServiceRequest')
const LogsReq = proto.lookupType('p.ExportLogsServiceRequest')
const PushReq = proto.lookupType('p.PushRequest')

// ───────────────────────────── random ─────────────────────────────

let state = SEED >>> 0
const rand = () => {
  state = (state + 0x6d2b79f5) >>> 0
  let t = state
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const int = (n) => Math.floor(rand() * n)
const pick = (xs) => xs[int(xs.length)]
const chance = (p) => rand() < p
const bytes = (n) => {
  const b = new Uint8Array(n)
  for (let i = 0; i < n; i++) b[i] = int(256)
  b[0] |= 1
  return b
}
const text = (max = 10) => {
  const al = pick([['a', 'b', 'c', 'x', 'y', 'z'], ['é', 'ü', '中', '€'], ['😀', '🌡', '𝄞'], ['\n', '\t', '"', '\\', ' '], ['￿', '', 'A']])
  return Array.from({ length: int(max + 1) }, () => pick(al)).join('')
}

function value(depth = 0) {
  const k = int(depth > 1 ? 5 : 8)
  if (k === 0) return { s: chance(0.1) ? '' : depth === 0 && chance(0.02) ? 'L'.repeat(60_000) : text() }
  if (k === 1) return { i: BigInt(int(2 ** 31)) * BigInt(pick([1, -1, 4294967296])) }
  if (k === 2) return { d: pick([0, 1.5, -2.25e-300, 1e21, 0.1, 123456789.125, Infinity, -Infinity, NaN, 3]) }
  if (k === 3) return { b: chance(0.5) }
  if (k === 4) return chance(0.5) ? { y: bytes(int(5) + 1) } : { n: true }
  if (k === 5) return { a: Array.from({ length: int(3) }, () => (chance(0.6) ? { s: text(4) } : value(depth + 1))) }
  return { l: Array.from({ length: int(3) }, () => [pick(['k', 'b', 'a', 'é']), value(depth + 1)]) }
}
const extraKeys = ['team', 'é.ü', '😀', 'feature.flag', 'retry.count', 'x', 'peer.service', 'empty']
const extras = (n) => Array.from({ length: int(n + 1) }, () => [pick(extraKeys), value()])

// ───────────────────────────── oracle ─────────────────────────────

const te = new TextEncoder()
const utf8Cmp = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))
function lastWins(kvs) {
  const m = new Map()
  for (const [k, v] of kvs) {
    m.delete(k)
    m.set(k, v)
  }
  return [...m].sort((a, b) => utf8Cmp(a[0], b[0]))
}
const b64 = (b) => Buffer.from(b).toString('base64')
const num = (d) => (Number.isNaN(d) ? '"NaN"' : d === Infinity ? '"Infinity"' : d === -Infinity ? '"-Infinity"' : JSON.stringify(d))
function canonV(v) {
  if ('s' in v) return `{"stringValue":${JSON.stringify(v.s)}}`
  if ('i' in v) return `{"intValue":"${v.i}"}`
  if ('d' in v) return `{"doubleValue":${num(v.d)}}`
  if ('b' in v) return `{"boolValue":${v.b}}`
  if ('a' in v) return v.a.length ? `{"arrayValue":{"values":[${v.a.map(canonV).join(',')}]}}` : '{"arrayValue":{}}'
  if ('l' in v) return v.l.length ? `{"kvlistValue":{"values":${canonL(v.l)}}}` : '{"kvlistValue":{}}'
  if ('y' in v) return `{"bytesValue":"${b64(v.y)}"}`
  return '{}'
}
const canonL = (kvs) => `[${lastWins(kvs).map(([k, v]) => `{"key":${JSON.stringify(k)},"value":${canonV(v)}}`).join(',')}]`
function plainJ(v) {
  if ('s' in v) return JSON.stringify(v.s)
  if ('i' in v) return String(v.i)
  if ('d' in v) return num(v.d)
  if ('b' in v) return String(v.b)
  if ('a' in v) return `[${v.a.map(plainJ).join(',')}]`
  if ('l' in v) return `{${lastWins(v.l).map(([k, x]) => `${JSON.stringify(k)}:${plainJ(x)}`).join(',')}}`
  if ('y' in v) return `"${b64(v.y)}"`
  return 'null'
}
const plainT = (v) => ('s' in v ? v.s : plainJ(v))
const dbits = (d) => {
  const b = Buffer.alloc(8)
  b.writeDoubleLE(d)
  return b.readBigUInt64LE().toString(16)
}
const typed = (kvs) =>
  lastWins(kvs).map(([k, v]) => ('s' in v ? [k, 's', v.s] : 'i' in v ? [k, 'i', String(v.i)] : 'd' in v ? [k, 'd', dbits(v.d)] : 'b' in v ? [k, 'b', String(v.b)] : [k, 'o', canonV(v)]))
function fnv(b) {
  let h = 0xcbf29ce484222325n
  for (const x of b) h = ((h ^ BigInt(x)) * 0x100000001b3n) & 0xffffffffffffffffn
  return BigInt.asIntN(64, h)
}
const hex = (b) => Buffer.from(b).toString('hex')
const streamId = (labels) => fnv(te.encode(labels.map(([n, v]) => `${n}\0${v}\0`).join('')))

const LABEL_KEYS = ['service.name', 'service.namespace', 'deployment.environment.name', 'cloud.region', 'cloud.availability_zone', 'k8s.cluster.name', 'k8s.namespace.name', 'k8s.container.name', 'container.name', 'k8s.replicaset.name', 'k8s.deployment.name', 'k8s.statefulset.name', 'k8s.daemonset.name', 'k8s.cronjob.name', 'k8s.job.name']
const sanitize = (k) => {
  const s = k.replace(/[^A-Za-z0-9_]/gu, '_')
  return /^[0-9]/.test(s) ? `_${s}` : s
}
const byName = (xs) => xs.filter(([, v]) => v !== '').sort((a, b) => utf8Cmp(a[0], b[0]))
function leaves(path, v, out) {
  if ('l' in v) for (const [k, x] of v.l) leaves(`${path}_${k}`, x, out)
  else out.push([sanitize(path), plainT(v)])
}
function level(attrs, skip) {
  const ls = []
  for (const [k, v] of attrs) if (!(skip && LABEL_KEYS.includes(k))) leaves(k, v, ls)
  const m = new Map()
  for (const [n, v] of ls) if (v !== '') m.set(n, m.has(n) ? `${m.get(n)};${v}` : v)
  return m
}
function otlpLabels(attrs) {
  const m = new Map()
  for (const [k, v] of attrs) if (LABEL_KEYS.includes(k)) m.set(sanitize(k), plainT(v))
  if (!m.get('service_name')) m.set('service_name', 'unknown_service')
  return byName([...m])
}

// ───────────────────────────── encoders ─────────────────────────────

const pv = (v) =>
  's' in v ? { string_value: v.s } : 'i' in v ? { int_value: protobuf.util.Long.fromString(String(v.i)) } : 'd' in v ? { double_value: v.d } : 'b' in v ? { bool_value: v.b }
    : 'a' in v ? { array_value: { values: v.a.map(pv) } } : 'l' in v ? { kvlist_value: { values: v.l.map(([k, x]) => ({ key: k, value: pv(x) })) } } : 'y' in v ? { bytes_value: v.y } : {}
const pkvs = (kvs) => (kvs ?? []).map(([k, v]) => ({ key: k, value: pv(v) }))
const L = (n) => protobuf.util.Long.fromString(String(n), true)
const jv = (v) =>
  's' in v ? { stringValue: v.s } : 'i' in v ? { intValue: String(v.i) } : 'd' in v ? { doubleValue: Number.isFinite(v.d) ? v.d : String(v.d) } : 'b' in v ? { boolValue: v.b }
    : 'a' in v ? { arrayValue: { values: v.a.map(jv) } } : 'l' in v ? { kvlistValue: { values: v.l.map(([k, x]) => ({ key: k, value: jv(x) })) } } : 'y' in v ? { bytesValue: b64(v.y) } : {}
const jkvs = (kvs) => (kvs ?? []).map(([k, v]) => ({ key: k, value: jv(v) }))

function tracesBody(resources, json) {
  if (json) {
    return te.encode(JSON.stringify({
      resourceSpans: resources.map((r) => ({
        resource: { attributes: jkvs(r.attrs) },
        scopeSpans: r.scopes.map((sc) => ({
          scope: { name: sc.name, version: sc.version, attributes: jkvs(sc.attrs) },
          spans: sc.spans.map((s) => ({
            traceId: hex(s.traceId), spanId: hex(s.spanId), parentSpanId: s.parent ? hex(s.parent) : '', traceState: s.traceState, flags: s.flags, name: s.name, kind: s.kind,
            startTimeUnixNano: String(s.start), endTimeUnixNano: String(s.end), attributes: jkvs(s.attrs), droppedAttributesCount: s.dropped[0],
            events: s.events.map((e) => ({ timeUnixNano: String(e.t), name: e.name, attributes: jkvs(e.attrs) })), droppedEventsCount: s.dropped[1],
            links: s.links.map((l) => ({ traceId: hex(l.traceId), spanId: hex(l.spanId), traceState: l.traceState, attributes: jkvs(l.attrs) })), droppedLinksCount: s.dropped[2],
            status: { message: s.statusMessage, code: s.status },
          })),
        })),
      })),
    }))
  }
  return TracesReq.encode(TracesReq.fromObject({
    resource_spans: resources.map((r) => ({
      resource: { attributes: pkvs(r.attrs) },
      scope_spans: r.scopes.map((sc) => ({
        scope: { name: sc.name, version: sc.version, attributes: pkvs(sc.attrs) },
        spans: sc.spans.map((s) => ({
          trace_id: s.traceId, span_id: s.spanId, parent_span_id: s.parent ?? new Uint8Array(0), trace_state: s.traceState, flags: s.flags, name: s.name, kind: s.kind,
          start_time_unix_nano: L(s.start), end_time_unix_nano: L(s.end), attributes: pkvs(s.attrs), dropped_attributes_count: s.dropped[0],
          events: s.events.map((e) => ({ time_unix_nano: L(e.t), name: e.name, attributes: pkvs(e.attrs) })), dropped_events_count: s.dropped[1],
          links: s.links.map((l) => ({ trace_id: l.traceId, span_id: l.spanId, trace_state: l.traceState, attributes: pkvs(l.attrs) })), dropped_links_count: s.dropped[2],
          status: { message: s.statusMessage, code: s.status },
        })),
      })),
    })),
  })).finish()
}

function logsBody(resources, json) {
  if (json) {
    return te.encode(JSON.stringify({
      resourceLogs: resources.map((r) => ({
        resource: { attributes: jkvs(r.attrs) },
        scopeLogs: r.scopes.map((sc) => ({
          scope: { name: 'lib', attributes: jkvs(sc.attrs) },
          logRecords: sc.logs.map((x) => ({
            timeUnixNano: x.time === undefined ? undefined : String(x.time), observedTimeUnixNano: x.observed === undefined ? undefined : String(x.observed),
            severityNumber: x.severity, severityText: x.severityText, body: x.body ? jv(x.body) : undefined, attributes: jkvs(x.attrs), flags: x.flags,
            traceId: x.traceId ? hex(x.traceId) : undefined, spanId: x.spanId ? hex(x.spanId) : undefined,
          })),
        })),
      })),
    }))
  }
  return LogsReq.encode(LogsReq.fromObject({
    resource_logs: resources.map((r) => ({
      resource: { attributes: pkvs(r.attrs) },
      scope_logs: r.scopes.map((sc) => ({
        scope: { name: 'lib', attributes: pkvs(sc.attrs) },
        log_records: sc.logs.map((x) => ({
          time_unix_nano: x.time === undefined ? undefined : L(x.time), observed_time_unix_nano: x.observed === undefined ? undefined : L(x.observed),
          severity_number: x.severity, severity_text: x.severityText, body: x.body ? pv(x.body) : undefined, attributes: pkvs(x.attrs), flags: x.flags,
          trace_id: x.traceId, span_id: x.spanId,
        })),
      })),
    })),
  })).finish()
}

function lokiBody(streams, json) {
  if (json) {
    return te.encode(JSON.stringify({ streams: streams.map((s) => ({ stream: Object.fromEntries(s.labels), values: s.entries.map((e) => (e.md.length ? [String(e.ts), e.line, Object.fromEntries(e.md)] : [String(e.ts), e.line])) })) }))
  }
  const raw = PushReq.encode(PushReq.fromObject({
    streams: streams.map((s) => ({
      labels: `{${s.labels.map(([n, v]) => `${n}=${JSON.stringify(v)}`).join(', ')}}`,
      entries: s.entries.map((e) => ({ timestamp: { seconds: L(e.ts / 1_000_000_000n), nanos: Number(e.ts % 1_000_000_000n) }, line: e.line, structuredMetadata: e.md.map(([name, value]) => ({ name, value })) })),
    })),
  })).finish()
  return snappy.compress(raw)
}

// ───────────────────────────── generate ─────────────────────────────

const T0 = BigInt(Date.UTC(2026, 10, 18, 22, 30)) * 1_000_000n // 2026-11-18T22:30Z: hours and a day boundary
const HOUR = 3_600_000_000_000n
const limits = {
  ...E.DEFAULT_LIMITS, maxSpans: 1e7, maxLogRecords: 1e7, maxDecompressedBytes: 1 << 30, maxDecodedBytes: 1 << 30, maxJsonTokens: 1 << 30,
  spanAcceptBackMs: 1e13, spanAcceptAheadMs: 1e13, logAcceptBackMs: 1e13, logAcceptAheadMs: 1e13,
}
const NOW_MS = Number((T0 + 4n * HOUR) / 1_000_000n)

const services = ['frontend', 'checkout', 'cart', 'payment', 'db-proxy', 'Zürich-svc']
const resources = services.map((name, i) => ({
  attrs: [
    ['service.name', { s: name }], ['service.instance.id', { s: `${name}-${i}` }], ['deployment.environment.name', { s: i % 3 ? 'prod' : 'staging' }],
    ['k8s.pod.name', { s: `${name}-7d9f-${i}` }], ['host.name', { s: `h${i}` }], ...(i === 2 ? [['service.namespace', { s: 'shop' }]] : []),
    ...(i === 4 ? [['process.pid', { i: 4242n }], ['k8s.namespace.name', { s: 'data' }]] : []),
  ],
  key: name,
}))
resources.push({ attrs: [['host.name', { s: 'no-service' }], ['é', { l: [['k', { s: 'v' }], ['ü', { i: 3n }], ['n', { a: [{ d: NaN }, { y: new Uint8Array([0, 255]) }] }]] }]], key: '' })

const routes = ['/api/v1/cart', '/api/v1/pay', '/healthz', '/api/v1/items/{id}', '/ünïcode']
const spans = [] // { r: resource index, scope, span }
const scopes = [{ name: 'io.opentelemetry.http', version: '1.2.3' }, { name: 'io.opentelemetry.db', version: '', attrs: [['scope.k', { i: 7n }]] }, { name: '', version: '' }]
const nTraces = Math.round(150 * SCALE)
for (let t = 0; t < nTraces; t++) {
  const traceId = bytes(16)
  const start = T0 + BigInt(int(3 * 3600)) * 1_000_000_000n + BigInt(int(1e9))
  const make = (parent, depth, t0, r) => {
    const dur = BigInt(pick([0, 1, 1000, 250_000, 12_000_000, 80_000_000, 400_000_000, 2_100_000_000]) + int(1000))
    const kind = depth === 0 ? 2 : pick([1, 2, 3, 3, 4, 5])
    const route = pick(routes)
    const err = chance(0.12)
    const attrs = [
      ['http.request.method', { s: pick(['GET', 'POST', 'PUT']) }],
      ['http.response.status_code', chance(0.05) ? { s: '503' } : { i: BigInt(err ? pick([500, 503]) : pick([200, 201, 404])) }],
      ['http.route', { s: route }],
      ...(services[r] === 'db-proxy' ? [['db.system.name', { s: 'postgresql' }]] : []),
      ...(err ? [['error.type', { s: pick(['timeout', 'Bad état']) }]] : []),
      ...(chance(0.05) ? [['rpc.service', { s: 'Cart' }]] : []),
      ...extras(3),
    ]
    const s = {
      traceId, spanId: bytes(8), parent, traceState: chance(0.1) ? 'ot=th:8;rv:1' : '', flags: chance(0.5) ? 0x101 : 0,
      name: depth === 0 ? `GET ${route}` : pick(['SELECT items', 'cart.add', `GET ${route}`, 'publish', '']),
      kind, start: t0, end: chance(0.01) ? t0 - 5n : t0 + dur, attrs,
      dropped: [int(2), 0, chance(0.1) ? 1 : 0],
      events: chance(0.15) ? [{ t: t0 + 5n, name: err ? 'exception' : 'log', attrs: [['exception.message', { s: 'boom' }], ...extras(1)] }] : [],
      links: chance(0.05) ? [{ traceId: bytes(16), spanId: bytes(8), traceState: '', attrs: chance(0.5) ? [['link.k', { b: true }]] : [] }] : [],
      status: err ? 2 : chance(0.2) ? 1 : 0, statusMessage: err ? 'failed' : '',
    }
    spans.push({ r, scope: depth === 0 ? 0 : int(3), s })
    if (depth < 4) for (let c = 0; c < int(depth === 0 ? 5 : 3); c++) make(s.spanId, depth + 1, t0 + BigInt(int(1_000_000)), int(services.length + 1) % (services.length + 1))
  }
  make(undefined, 0, start, 0)
  if (chance(0.03)) spans.push({ r: 1, scope: 0, s: { traceId, spanId: bytes(8), parent: bytes(8), traceState: '', flags: 0, name: 'orphan', kind: 1, start, end: start + 10n, attrs: [], dropped: [0, 0, 0], events: [], links: [], status: 0, statusMessage: '' } })
}
// Maximal values: an attribute value of exactly 65,536 bytes, a span name of 8,192 bytes.
spans[0].s.attrs.push(['max.value', { s: 'M'.repeat(65_536) }])
spans[1].s.name = 'N'.repeat(8192)
// Arrival order is not trace order.
for (let i = spans.length - 1; i > 0; i--) {
  const j = int(i + 1)
  ;[spans[i], spans[j]] = [spans[j], spans[i]]
}
// Retries: some spans sent again later with one attribute changed; the later one must win.
const retried = spans.filter(() => chance(0.03)).map((x) => ({ ...x, s: { ...x.s, attrs: [...x.s.attrs, ['retry', { b: true }]] } }))

function group(list, size) {
  const out = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}
function asResources(part) {
  const by = new Map()
  for (const { r, scope, s } of part) {
    const key = `${r}/${scope}`
    if (!by.has(key)) by.set(key, { r, scope, spans: [] })
    by.get(key).spans.push(s)
  }
  const res = new Map()
  for (const { r, scope, spans: ss } of by.values()) {
    if (!res.has(r)) res.set(r, { attrs: resources[r].attrs, scopes: [] })
    res.get(r).scopes.push({ ...scopes[scope], spans: ss })
  }
  return [...res.values()]
}

mkdirSync(join(OUT, 'batches'), { recursive: true })
mkdirSync(join(OUT, 'expected'), { recursive: true })
const sentRequests = []
/** With `--requests`: one request as sent (its body exactly as the decoders above read it before decompression). */
const keepRequest = (path, body, contentType, contentEncoding) => {
  if (!REQUESTS) return
  if (sentRequests.length === 0) mkdirSync(join(OUT, 'requests'), { recursive: true })
  const file = `${String(sentRequests.length).padStart(5, '0')}.bin`
  writeFileSync(join(OUT, 'requests', file), body)
  sentRequests.push({ file, path, contentType, ...(contentEncoding ? { contentEncoding } : {}) })
}
let nBatch = 0
const writeBatches = (prefix, c) => {
  if (c.rejectedTotal !== 0) throw new Error(`${prefix}: edge refused ${c.rejectedTotal}: ${c.rejectionSummary()}`)
  const batches = c.build(new Int32Array(c.nSeries), limits.maxBatchBytes).get(0) ?? []
  for (const b of batches) writeFileSync(join(OUT, 'batches', `${prefix}-${String(nBatch++).padStart(5, '0')}.bin`), b.bytes)
  return batches.length
}

// Spans: requests of up to 120 spans, protobuf or JSON.
const expectedSpans = new Map()
let spanRequests = 0
let spanBatches = 0
for (const part of [...group(spans, 120), retried]) {
  if (part.length === 0) continue
  const json = chance(0.4)
  const body = tracesBody(asResources(part), json)
  keepRequest('/v1/traces', body, json ? 'application/json' : 'application/x-protobuf')
  const c = new E.SpanCollector(limits, NOW_MS)
  ;(json ? E.decodeTracesJson : E.decodeTracesProto)(body, c)
  spanBatches += writeBatches('spans', c)
  spanRequests++
  for (const { r, scope, s } of part) {
    const sc = scopes[scope]
    const clamped = s.end < s.start
    const attrs = clamped ? [...s.attrs, ['viz.clamped_end', { b: true }]] : s.attrs
    const fixD = (kvs) => (json ? kvs.map(([k, v]) => [k, 'd' in v && Object.is(v.d, -0) ? { d: 0 } : v]) : kvs)
    expectedSpans.set(`${hex(s.traceId)}/${hex(s.spanId)}`, {
      trace_id: hex(s.traceId), span_id: hex(s.spanId), parent_span_id: s.parent ? hex(s.parent) : null, trace_state: s.traceState, flags: s.flags,
      start: String(s.start), end: String(clamped ? s.start : s.end), kind: s.kind, status: s.status, status_message: s.statusMessage, name: s.name,
      resource_fp: String(fnv(te.encode(canonL(resources[r].attrs)))), resource: typed(fixD(resources[r].attrs)), attrs: typed(fixD(attrs)),
      scope_name: sc.name, scope_version: sc.version, scope_attrs: sc.attrs?.length ? canonL(sc.attrs) : '',
      events: s.events.map((e) => [String(e.t), e.name, e.attrs.length ? canonL(e.attrs) : '[]']),
      links: s.links.map((l) => [hex(l.traceId), hex(l.spanId), l.traceState, l.attrs.length ? canonL(l.attrs) : '[]']),
      dropped: s.dropped,
    })
  }
}
writeFileSync(join(OUT, 'expected', 'spans.jsonl'), [...expectedSpans.values()].map((x) => JSON.stringify(x)).join('\n') + '\n')

// Logs: OTLP requests (with trace links to the spans above) and Loki pushes, then retries.
const traced = spans.slice(0, 400).map((x) => x.s)
const logLine = (k) => pick([
  () => `level=${pick(['info', 'warn', 'error'])} msg="request ${k}" status=${pick([200, 404, 500])} duration=${int(900)}ms route=${pick(routes)}`,
  () => JSON.stringify({ level: pick(['info', 'error']), msg: `job ${k}`, user: { id: int(50), name: pick(['ann', 'bö']) }, latency_ms: int(1000) }),
  () => `${pick(['GET', 'POST'])} ${pick(routes)} ${pick([200, 500])} ${text(6)}`,
  () => pick(['error: connection refused', 'panic: nil map', 'starting worker', '', 'x'.repeat(int(2) ? 10 : 100_000)]),
])()
const expectedLogs = new Map()
const logKey = (o) => JSON.stringify([o.stream_id, o.ts, o.line, o.metadata])
let logRequests = 0
let logBatches = 0
const otlpParts = []
for (let q = 0; q < Math.round(25 * SCALE); q++) {
  const rs = Array.from({ length: 1 + int(3) }, () => {
    const r = int(resources.length)
    return {
      attrs: resources[r].attrs,
      scopes: Array.from({ length: 1 + int(2) }, () => ({
        attrs: chance(0.3) ? [['scope.attr', { s: 'v' }], ['a.b', { i: 1n }]] : [],
        logs: Array.from({ length: 1 + int(40) }, (_, k) => {
          const t = T0 + BigInt(int(3 * 3600)) * 1_000_000_000n + BigInt(int(1e9))
          const sp = chance(0.3) ? pick(traced) : undefined
          return {
            time: chance(0.9) ? t : undefined, observed: chance(0.5) ? t + 1000n : chance(0.1) ? undefined : t,
            severity: pick([0, 5, 9, 13, 17, 21]), severityText: pick(['', 'INFO', 'WARN', 'ERROR']),
            body: chance(0.85) ? { s: logLine(k) } : chance(0.5) ? value() : undefined,
            attrs: [...(chance(0.5) ? [['http.route', { s: pick(routes) }]] : []), ...(chance(0.3) ? [['user', { l: [['id', { i: BigInt(int(50)) }], ['tier', { s: 'gold' }]] }]] : []), ...(chance(0.2) ? [['level', { s: pick(['info', 'error']) }]] : [])],
            flags: sp ? 1 : 0, traceId: sp?.traceId, spanId: sp?.spanId,
          }
        }).filter((x) => x.time !== undefined || x.observed !== undefined),
      })),
    }
  })
  otlpParts.push(rs)
}
// Maximal values: a line of exactly 256 KiB, a metadata value of 8,192 bytes.
otlpParts[0][0].scopes[0].logs[0].body = { s: 'X'.repeat(262_144) }
otlpParts[0][0].scopes[0].logs[0].attrs.push(['big', { s: 'v'.repeat(8192) }])
const lokiParts = []
for (let q = 0; q < Math.round(25 * SCALE); q++) {
  lokiParts.push(Array.from({ length: 1 + int(4) }, () => {
    const job = pick(['nginx', 'worker', 'cron', 'Zürich'])
    const labels = byName(Object.entries({ job, instance: `${job}-${int(3)}`, env: pick(['prod', 'dev']), ...(chance(0.5) ? { service_name: job } : {}), ...(chance(0.2) ? { level: pick(['info', 'error']) } : {}) }))
    return {
      labels,
      entries: Array.from({ length: 1 + int(40) }, (_, k) => ({
        ts: T0 + BigInt(int(3 * 3600)) * 1_000_000_000n + BigInt(int(1e9)),
        line: logLine(k),
        md: byName(Object.entries({ ...(chance(0.4) ? { trace_id: hex(bytes(16)) } : {}), ...(chance(0.3) ? { user: String(int(50)) } : {}) })),
      })),
    }
  }))
}
// Retries: one OTLP request and one push sent again whole (stored once), and one OTLP request
// sent again with every severity text changed (same row keys: the later one wins).
otlpParts.push(otlpParts[1])
lokiParts.push(lokiParts[2])
otlpParts.push(otlpParts[3].map((r) => ({ ...r, scopes: r.scopes.map((sc) => ({ ...sc, logs: sc.logs.map((x) => ({ ...x, severityText: 'RETRIED' })) })) })))

const queue = []
for (let i = 0; i < Math.max(otlpParts.length, lokiParts.length); i++) {
  if (otlpParts[i]) queue.push(['otlp', otlpParts[i]])
  if (lokiParts[i]) queue.push(['loki', lokiParts[i]])
}
for (const [kind, part] of queue) {
  const json = chance(0.5)
  const c = new E.LogCollector(limits, NOW_MS)
  if (kind === 'otlp') {
    const body = logsBody(part, json)
    keepRequest('/v1/logs', body, json ? 'application/json' : 'application/x-protobuf')
    ;(json ? E.decodeLogsJson : E.decodeLogsProto)(body, c)
  } else {
    const body = lokiBody(part, json)
    keepRequest('/loki/api/v1/push', body, json ? 'application/json' : 'application/x-protobuf', json ? undefined : 'snappy')
    ;(json ? E.decodeLokiJson : E.decodeLokiProto)(json ? body : E.snappyDecompress(body, 1 << 30), c)
  }
  logBatches += writeBatches('logs', c)
  logRequests++
  if (kind === 'otlp') {
    for (const r of part) {
      const labels = otlpLabels(r.attrs)
      for (const sc of r.scopes) {
        for (const x of sc.logs) {
          const md = new Map()
          for (const l of [level(r.attrs, true), level(sc.attrs, false), level(x.attrs, false)]) for (const [n, v] of l) md.set(n, v)
          const o = {
            stream_id: String(streamId(labels)), labels, ts: String(x.time ?? x.observed), observed_ts: String(x.observed ?? 0n),
            trace_id: x.traceId ? hex(x.traceId) : '0'.repeat(32), span_id: x.spanId ? hex(x.spanId) : '0'.repeat(16), flags: x.flags,
            severity_number: x.severity, severity_text: x.severityText, line: x.body && !('n' in x.body) ? plainT(x.body) : '', metadata: byName([...md]),
          }
          expectedLogs.set(logKey(o), o)
        }
      }
    }
  } else {
    for (const s of part) {
      for (const e of s.entries) {
        const o = { stream_id: String(streamId(s.labels)), labels: s.labels, ts: String(e.ts), observed_ts: '0', trace_id: '0'.repeat(32), span_id: '0'.repeat(16), flags: 0, severity_number: 0, severity_text: '', line: e.line, metadata: e.md }
        expectedLogs.set(logKey(o), o)
      }
    }
  }
}
writeFileSync(join(OUT, 'expected', 'logs.jsonl'), [...expectedLogs.values()].map((x) => JSON.stringify(x)).join('\n') + '\n')
const summary = { seed: SEED, scale: SCALE, spans: expectedSpans.size, spanRequests, spanBatches, logs: expectedLogs.size, logRequests, logBatches, retriedSpans: retried.length }
writeFileSync(join(OUT, 'summary.json'), JSON.stringify(summary, null, 1))
if (REQUESTS) {
  writeFileSync(join(OUT, 'requests', 'index.json'), JSON.stringify(sentRequests, null, 1))
  writeFileSync(join(OUT, 'requests', 'now_ms'), String(NOW_MS))
}
console.log(JSON.stringify(summary))
