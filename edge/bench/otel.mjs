// Decode CPU per request for OTLP traces, OTLP logs and Loki push, in Node (V8, like
// workerd, but not the Workers runtime or its CPU).
//   node bench/otel.mjs
// Measures the CPU-bound part of one request: (snappy for Loki protobuf) → decode, validate,
// map → build VZB1 batches → SHA-256 of each batch. No network, no shard, no gzip.
import { createHash } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import protobuf from 'protobufjs'
import snappy from 'snappyjs'

const out = join(mkdtempSync(join(tmpdir(), 'viz-edge-otel-bench-')), 'edge.mjs')
await build({
  stdin: { contents: `export * from './src/spans'; export * from './src/logs'; export * from './src/limits'; export * from './src/snappy'`, resolveDir: new URL('..', import.meta.url).pathname, loader: 'ts' },
  bundle: true, format: 'esm', platform: 'neutral', outfile: out, logLevel: 'error',
  plugins: [{ name: 'workers-stub', setup(b) {
    b.onResolve({ filter: /^cloudflare:/ }, (a) => ({ path: a.path, namespace: 'stub' }))
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export class DurableObject {}; export class WorkerEntrypoint {}; export const env = {}', loader: 'js' }))
  } }],
})
const E = await import(pathToFileURL(out).href)

const root = protobuf.parse(`
syntax = "proto3"; package p;
message ExportTraceServiceRequest { repeated ResourceSpans resource_spans = 1; }
message ResourceSpans { Resource resource = 1; repeated ScopeSpans scope_spans = 2; }
message Resource { repeated KeyValue attributes = 1; }
message Scope { string name = 1; string version = 2; }
message ScopeSpans { Scope scope = 1; repeated Span spans = 2; }
message Span { bytes trace_id = 1; bytes span_id = 2; bytes parent_span_id = 4; fixed32 flags = 16; string name = 5; int32 kind = 6;
  fixed64 start_time_unix_nano = 7; fixed64 end_time_unix_nano = 8; repeated KeyValue attributes = 9; repeated Event events = 11; Status status = 15; }
message Event { fixed64 time_unix_nano = 1; string name = 2; repeated KeyValue attributes = 3; }
message Status { string message = 2; int32 code = 3; }
message ExportLogsServiceRequest { repeated ResourceLogs resource_logs = 1; }
message ResourceLogs { Resource resource = 1; repeated ScopeLogs scope_logs = 2; }
message ScopeLogs { Scope scope = 1; repeated LogRecord log_records = 2; }
message LogRecord { fixed64 time_unix_nano = 1; int32 severity_number = 2; string severity_text = 3; AnyValue body = 5; repeated KeyValue attributes = 6;
  fixed32 flags = 8; bytes trace_id = 9; bytes span_id = 10; }
message KeyValue { string key = 1; AnyValue value = 2; }
message AnyValue { oneof value { string string_value = 1; bool bool_value = 2; int64 int_value = 3; double double_value = 4; } }
message PushRequest { repeated StreamAdapter streams = 1; }
message StreamAdapter { string labels = 1; repeated EntryAdapter entries = 2; }
message EntryAdapter { Timestamp timestamp = 1; string line = 2; repeated LabelPair structuredMetadata = 3; }
message LabelPair { string name = 1; string value = 2; }
message Timestamp { int64 seconds = 1; int32 nanos = 2; }
`, { keepCase: true }).root
const T = root.lookupType('p.ExportTraceServiceRequest')
const LG = root.lookupType('p.ExportLogsServiceRequest')
const P = root.lookupType('p.PushRequest')

let seed = 7
const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296)
const bytes = (n) => Uint8Array.from({ length: n }, () => (rnd() * 256) | 1)
const hex = (b) => Buffer.from(b).toString('hex')
const now = Date.now()
const NS = BigInt(now) * 1_000_000n
const L = (n) => protobuf.util.Long.fromString(String(n), true)
const sv = (s) => ({ string_value: s })

/** n spans in 10 resources: ~9 attributes each, 10% with an event; the shape of an instrumented HTTP service. */
function traces(n) {
  const rs = []
  for (let r = 0; r < 10; r++) {
    const spans = []
    for (let i = 0; i < n / 10; i++) {
      const start = NS - BigInt(Math.floor(rnd() * 60e9))
      spans.push({
        trace_id: bytes(16), span_id: bytes(8), parent_span_id: rnd() < 0.9 ? bytes(8) : new Uint8Array(0), flags: 0x101, name: `GET /api/v1/resource/${i % 50}`, kind: 2,
        start_time_unix_nano: L(start), end_time_unix_nano: L(start + BigInt(Math.floor(rnd() * 1e9))),
        attributes: [
          ['http.request.method', sv('GET')], ['http.response.status_code', { int_value: 200 }], ['http.route', sv(`/api/v1/resource/${i % 50}`)],
          ['url.path', sv(`/api/v1/resource/${i % 50}/${Math.floor(rnd() * 1e9)}`)], ['user_agent.original', sv('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36')],
          ['server.address', sv('api.example.com')], ['server.port', { int_value: 443 }], ['network.protocol.version', sv('1.1')], ['client.address', sv(`10.0.${i % 255}.${r}`)],
        ].map(([key, value]) => ({ key, value })),
        events: rnd() < 0.1 ? [{ time_unix_nano: L(start), name: 'exception', attributes: [{ key: 'exception.message', value: sv('boom') }] }] : [],
        status: { code: rnd() < 0.05 ? 2 : 0 },
      })
    }
    rs.push({ resource: { attributes: [['service.name', `svc-${r}`], ['service.instance.id', `i-${r}`], ['host.name', `h${r}`], ['k8s.pod.name', `svc-${r}-abc`], ['deployment.environment.name', 'prod']].map(([key, v]) => ({ key, value: sv(v) })) }, scope_spans: [{ scope: { name: 'io.opentelemetry.http', version: '1.0' }, spans }] })
  }
  return { resource_spans: rs }
}

function tracesJson(obj) {
  const kv = (a) => a.map(({ key, value }) => ({ key, value: value.string_value !== undefined ? { stringValue: value.string_value } : { intValue: String(value.int_value) } }))
  return JSON.stringify({ resourceSpans: obj.resource_spans.map((r) => ({ resource: { attributes: kv(r.resource.attributes) }, scopeSpans: r.scope_spans.map((s) => ({ scope: s.scope, spans: s.spans.map((p) => ({
    traceId: hex(p.trace_id), spanId: hex(p.span_id), parentSpanId: hex(p.parent_span_id), flags: p.flags, name: p.name, kind: p.kind,
    startTimeUnixNano: p.start_time_unix_nano.toString(), endTimeUnixNano: p.end_time_unix_nano.toString(), attributes: kv(p.attributes),
    events: p.events.map((e) => ({ timeUnixNano: e.time_unix_nano.toString(), name: e.name, attributes: kv(e.attributes) })), status: p.status,
  })) })) })) })
}

const line = (i) => `ts=2026-11-19T07:00:00Z level=info msg="handled request" request_id=${Math.floor(rnd() * 1e15).toString(16)} route=/api/v1/resource/${i % 50} status=200 duration=${Math.floor(rnd() * 900)}ms`

function logs(n) {
  const rs = []
  for (let r = 0; r < 10; r++) {
    const recs = []
    for (let i = 0; i < n / 10; i++) {
      recs.push({ time_unix_nano: L(NS - BigInt(Math.floor(rnd() * 60e9))), severity_number: 9, severity_text: 'INFO', body: sv(line(i)), flags: 1, trace_id: bytes(16), span_id: bytes(8),
        attributes: [['http.route', sv(`/api/v1/resource/${i % 50}`)], ['user.id', sv(`u${i % 500}`)], ['code.function', sv('handle')]].map(([key, value]) => ({ key, value })) })
    }
    rs.push({ resource: { attributes: [['service.name', `svc-${r}`], ['service.instance.id', `i-${r}`], ['k8s.namespace.name', 'prod'], ['k8s.pod.name', `svc-${r}-abc`], ['host.name', `h${r}`]].map(([key, v]) => ({ key, value: sv(v) })) }, scope_logs: [{ scope: { name: 'logger' }, log_records: recs }] })
  }
  return { resource_logs: rs }
}

function logsJson(obj) {
  const kv = (a) => a.map(({ key, value }) => ({ key, value: { stringValue: value.string_value } }))
  return JSON.stringify({ resourceLogs: obj.resource_logs.map((r) => ({ resource: { attributes: kv(r.resource.attributes) }, scopeLogs: r.scope_logs.map((s) => ({ scope: s.scope, logRecords: s.log_records.map((x) => ({
    timeUnixNano: x.time_unix_nano.toString(), severityNumber: x.severity_number, severityText: x.severity_text, body: { stringValue: x.body.string_value }, attributes: kv(x.attributes), flags: x.flags, traceId: hex(x.trace_id), spanId: hex(x.span_id),
  })) })) })) })
}

/** Loki push: 10 streams; the shape Promtail sends. */
function loki(n) {
  const streams = []
  for (let s = 0; s < 10; s++) {
    const entries = []
    for (let i = 0; i < n / 10; i++) {
      const ns = NS - BigInt(Math.floor(rnd() * 60e9))
      entries.push({ timestamp: { seconds: L(ns / 1_000_000_000n), nanos: Number(ns % 1_000_000_000n) }, line: line(i), structuredMetadata: [{ name: 'trace_id', value: hex(bytes(16)) }] })
    }
    streams.push({ labels: `{job="app-${s}", instance="10.0.0.${s}:9100", namespace="prod", filename="/var/log/app-${s}.log"}`, entries })
  }
  return { streams }
}

function lokiJson(obj) {
  return JSON.stringify({ streams: obj.streams.map((s) => ({ stream: Object.fromEntries([...s.labels.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]])), values: s.entries.map((e) => [String(BigInt(e.timestamp.seconds.toString()) * 1_000_000_000n + BigInt(e.timestamp.nanos)), e.line, Object.fromEntries(e.structuredMetadata.map((m) => [m.name, m.value]))]) })) })
}

const limits = { ...E.DEFAULT_LIMITS }
const sha = (b) => createHash('sha256').update(b).digest('hex')

function run(kind, body) {
  const c = kind.startsWith('traces') ? new E.SpanCollector(limits, Date.now()) : new E.LogCollector(limits, Date.now())
  if (kind === 'traces-proto') E.decodeTracesProto(body, c)
  else if (kind === 'traces-json') E.decodeTracesJson(body, c)
  else if (kind === 'logs-proto') E.decodeLogsProto(body, c)
  else if (kind === 'logs-json') E.decodeLogsJson(body, c)
  else if (kind === 'loki-proto') E.decodeLokiProto(E.snappyDecompress(body, 64 << 20), c)
  else E.decodeLokiJson(body, c)
  if (c.rejectedTotal) throw new Error(`${kind}: ${c.rejectionSummary()}`)
  let n = 0
  for (const batches of c.build(new Int32Array(c.nSeries).map((_, i) => i % 4), limits.maxBatchBytes).values()) for (const b of batches) n += sha(b.bytes).length
  return c.nRows
}

const te = new TextEncoder()
const cases = []
for (const n of [1000, 8000]) {
  const t = traces(n)
  cases.push(['traces-proto', n, T.encode(T.fromObject(t)).finish()])
  cases.push(['traces-json', n, te.encode(tracesJson(t))])
  const l = logs(n)
  cases.push(['logs-proto', n, LG.encode(LG.fromObject(l)).finish()])
  cases.push(['logs-json', n, te.encode(logsJson(l))])
  const k = loki(n)
  cases.push(['loki-proto', n, snappy.compress(P.encode(P.fromObject(k)).finish())])
  cases.push(['loki-json', n, te.encode(lokiJson(k))])
}
console.log('| Request | Items | Body | CPU per request (median of 15) | Per item | Per MB of body |')
console.log('|---|---|---|---|---|---|')
for (const [kind, n, body] of cases) {
  const times = []
  for (let i = 0; i < 18; i++) {
    const t0 = process.hrtime.bigint()
    const rows = run(kind, body)
    if (rows !== n) throw new Error(`${kind}: ${rows} rows, expected ${n}`)
    if (i >= 3) times.push(Number(process.hrtime.bigint() - t0) / 1e6)
  }
  times.sort((a, b) => a - b)
  const med = times[7]
  console.log(`| ${kind} | ${n} | ${(body.length / 1024).toFixed(0)} KiB | ${med.toFixed(1)} ms (${times[0].toFixed(1)}–${times[times.length - 1].toFixed(1)}) | ${((med * 1000) / n).toFixed(1)} µs | ${(med / (body.length / 1048576)).toFixed(0)} ms |`)
}
