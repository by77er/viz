// Heap per request of edge's decoders, in Node and in workerd, for hostile and realistic bodies.
//
//   node bench/memory.mjs                    every case, Node and workerd
//   node bench/memory.mjs --node traces      only Node, only cases whose name contains "traces"
//   node bench/memory.mjs --workerd --json   workerd only, one JSON line per case
//   node bench/memory.mjs --dump DIR         write each case's body to DIR, measure nothing
//
// Each case runs in a fresh process (Node) or a fresh workerd (one isolate), with V8's
// `--expose-gc --trace-gc`: a forced GC before the request gives the baseline, a forced GC after
// it (the request's objects still held) gives what it retains, and the largest heap size any GC
// in between saw before collecting is the peak (V8's heap only grows between two GCs, so its
// maximum is reached just before one). "Peak" includes garbage not yet collected; "live" is the
// largest heap any GC in the window left behind. Both are the V8 heap only: ArrayBuffer backing
// stores (the body, collector buffers, batches) are outside it and are reported separately by
// Node as `arrayBuffers`. workerd has no API for that, so its column is the V8 heap only.
//
// The bodies are built here: hostile shapes by hand on the wire (each a few bytes per item, the
// shapes of review M-3 and the ones found while fixing it), realistic ones with protobufjs in the
// shape of an instrumented HTTP service (bench/otel.mjs) at about 8,192 items (8,200), the OpenTelemetry
// Collector batch processor's default `send_batch_size` (training knowledge, not verified here).
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

// ───────────────────────────── child (Node) ─────────────────────────────

if (process.argv[2] === '--child') {
  const [bundle, bodyFile, specJson] = process.argv.slice(3)
  const E = await import(pathToFileURL(bundle).href)
  const { runCase } = await import(pathToFileURL(join(HERE, 'memory-run.mjs')).href)
  const spec = JSON.parse(specJson)
  const body = new Uint8Array(readFileSync(bodyFile))
  const { writeSync } = await import('node:fs')
  writeSync(1, 'MARK begin\n')
  globalThis.gc()
  const ab0 = process.memoryUsage().arrayBuffers
  const t0 = performance.now()
  const r = runCase(E, { ...spec, body, now: spec.now })
  const ms = performance.now() - t0
  globalThis.gc()
  const ab1 = process.memoryUsage().arrayBuffers
  writeSync(1, `MARK end ${JSON.stringify({ outcome: r.outcome, rows: r.rows, rejected: r.rejected, reasons: r.reasons.slice(0, 200), ms, arrayBuffersMiB: (ab1 - ab0) / 2 ** 20 })}\n`)
  r.keep.length = 0
  process.exit(0)
}

// ───────────────────────────── wire helpers ─────────────────────────────

const varint = (n) => {
  const out = []
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80)
    n = Math.floor(n / 128)
  }
  out.push(n)
  return out
}
const cat = (...xs) => {
  const o = new Uint8Array(xs.reduce((a, x) => a + x.length, 0))
  let p = 0
  for (const x of xs) {
    o.set(x, p)
    p += x.length
  }
  return o
}
const ld = (tag, payload) => cat(Uint8Array.from([...(Array.isArray(tag) ? tag : [tag]), ...varint(payload.length)]), payload)
const te = new TextEncoder()
const str = (tag, s) => ld(tag, te.encode(s))
const repeat = (unit, n) => {
  const o = new Uint8Array(unit.length * n)
  for (let i = 0; i < n; i++) o.set(unit, i * unit.length)
  return o
}
const fixed64 = (tag, v) => {
  const b = new Uint8Array(9)
  b[0] = tag
  new DataView(b.buffer).setBigUint64(1, BigInt(v), true)
  return b
}
const NOW = Date.now()
const NS = BigInt(NOW) * 1_000_000n
const kv = (k, v) => ld(0x0a, cat(str(0x0a, k), ld(0x12, str(0x0a, v))))

/** A valid span (ids, start in the window) with extra fields appended. */
function span(i, extra = new Uint8Array(0)) {
  const tid = new Uint8Array(16)
  new DataView(tid.buffer).setUint32(0, i + 1)
  const sid = new Uint8Array(8)
  new DataView(sid.buffer).setUint32(0, i + 1)
  return ld(0x12, cat(ld(0x0a, tid), ld(0x12, sid), fixed64(0x39, NS), extra))
}
/** ExportTraceServiceRequest { resource_spans { resource, scope_spans { spans } } } */
const traces = (resource, scopeBody) => ld(0x0a, cat(ld(0x0a, resource), ld(0x12, scopeBody)))
/** ExportLogsServiceRequest, same nesting. */
const logs = traces
/** ExportMetricsServiceRequest { resource_metrics { resource, scope_metrics { metrics } } } */
const metrics = (resource, scopeBody) => ld(0x0a, cat(ld(0x0a, resource), ld(0x12, scopeBody)))
const gaugeWithPoint = (pointBody) => ld(0x12, cat(str(0x0a, 'm'), ld(0x2a, ld(0x0a, cat(fixed64(0x19, NS), fixed64(0x21, 0), pointBody)))))
const record = (extra = new Uint8Array(0)) => ld(0x12, cat(fixed64(0x09, NS), extra))

const emptyKVs = (bytes, tag = 0x0a) => repeat(Uint8Array.of(tag, 0), Math.floor(bytes / 2))
const arrayOfEmpty = (bytes) => ld(0x0a, cat(str(0x0a, 'a'), ld(0x12, ld(0x2a, repeat(Uint8Array.of(0x0a, 0), Math.floor(bytes / 2))))))

function jsonRepeat(prefix, unit, suffix, bytes) {
  const n = Math.max(1, Math.floor((bytes - prefix.length - suffix.length) / (unit.length + 1)))
  return te.encode(prefix + Array(n).fill(unit).join(',') + suffix)
}

// ───────────────────────────── cases ─────────────────────────────

const MiB = 1 << 20
/** [name, path, json, snappy, () => body] */
function hostile(mib) {
  const S = mib * MiB
  const svc = kv('service.name', 'svc')
  return [
    [`traces: resource of empty KeyValues, ${mib} MiB`, 'traces', false, false, () => traces(emptyKVs(S), new Uint8Array(0))],
    [`traces: resource attribute, array of empty values, ${mib} MiB`, 'traces', false, false, () => traces(arrayOfEmpty(S), new Uint8Array(0))],
    [`traces: empty scopes, ${mib} MiB`, 'traces', false, false, () => ld(0x0a, cat(ld(0x0a, svc), repeat(Uint8Array.of(0x12, 0), S / 2)))],
    [`traces: span of empty attributes, ${mib} MiB`, 'traces', false, false, () => traces(svc, span(0, emptyKVs(S, 0x4a)))],
    [`traces: span of empty events, ${mib} MiB`, 'traces', false, false, () => traces(svc, span(0, emptyKVs(S, 0x5a)))],
    [`traces: span name of ${mib} MiB`, 'traces', false, false, () => traces(svc, span(0, str(0x2a, 'a'.repeat(S))))],
    [`traces: minimal valid spans, ${mib} MiB`, 'traces', false, false, () => {
      const n = Math.min(Math.floor(S / 39), 200_000)
      return traces(svc, cat(...Array.from({ length: n }, (_, i) => span(i))))
    }],
    [`logs: resource of empty KeyValues, ${mib} MiB`, 'logs', false, false, () => logs(emptyKVs(S), new Uint8Array(0))],
    [`logs: record of empty attributes, ${mib} MiB`, 'logs', false, false, () => logs(svc, record(emptyKVs(S, 0x32)))],
    [`logs: record body, array of empty values, ${mib} MiB`, 'logs', false, false, () => logs(svc, record(ld(0x2a, ld(0x2a, repeat(Uint8Array.of(0x0a, 0), S / 2)))))],
    [`logs: minimal valid records (200,000)`, 'logs', false, false, () => logs(svc, repeat(record(), 200_000))],
    [`loki: entry of empty metadata, ${mib} MiB`, 'loki', false, false, () => ld(0x0a, cat(str(0x0a, '{job="a"}'), ld(0x12, cat(ld(0x0a, cat(Uint8Array.of(0x08), Uint8Array.from(varint(Number(NS / 1_000_000_000n))))), emptyKVs(S, 0x1a)))))],
    [`loki json: small entries, ${mib} MiB`, 'loki', true, false, () => {
      const parts = ['{"streams":[{"stream":{"job":"a"},"values":[']
      let size = parts[0].length
      for (let i = 0; size < S; i++) {
        const e = `${i ? ',' : ''}["${NS + BigInt(i)}","x"]`
        parts.push(e)
        size += e.length
      }
      parts.push(']}]}')
      return te.encode(parts.join(''))
    }],
    [`metrics: resource of empty KeyValues, ${mib} MiB`, 'metrics', false, false, () => metrics(emptyKVs(S), new Uint8Array(0))],
    [`metrics: resource attribute, array of empty values, ${mib} MiB`, 'metrics', false, false, () => metrics(arrayOfEmpty(S), new Uint8Array(0))],
    [`metrics: point of distinct attribute keys, 256 KiB`, 'metrics', false, false, () => {
      const n = Math.floor((256 << 10) / 16)
      return metrics(svc, gaugeWithPoint(cat(...Array.from({ length: n }, (_, i) => ld(0x3a, cat(str(0x0a, `k${i}`), ld(0x12, str(0x0a, '1'))))))))
    }],
    [`traces json: resource of empty attributes, ${mib} MiB`, 'traces', true, false, () => jsonRepeat('{"resourceSpans":[{"resource":{"attributes":[', '{}', ']}}]}', S)],
    [`logs json: resource of empty attributes, ${mib} MiB`, 'logs', true, false, () => jsonRepeat('{"resourceLogs":[{"resource":{"attributes":[', '{}', ']}}]}', S)],
    [`metrics json: resource of empty attributes, ${mib} MiB`, 'metrics', true, false, () => jsonRepeat('{"resourceMetrics":[{"resource":{"attributes":[', '{}', ']}}]}', S)],
    [`traces json: attribute array of empty values, ${mib} MiB`, 'traces', true, false, () => jsonRepeat('{"resourceSpans":[{"resource":{"attributes":[{"key":"a","value":{"arrayValue":{"values":[', '{}', ']}}}]}}]}', S)],
  ]
}

async function realistic() {
  const protobuf = (await import('protobufjs')).default
  const snappy = (await import('snappyjs')).default
  const root = protobuf.parse(`
syntax = "proto3"; package p;
message KeyValue { string key = 1; AnyValue value = 2; }
message AnyValue { oneof value { string string_value = 1; bool bool_value = 2; int64 int_value = 3; double double_value = 4; } }
message Resource { repeated KeyValue attributes = 1; }
message Scope { string name = 1; string version = 2; }
message ExportTraceServiceRequest { repeated ResourceSpans resource_spans = 1; }
message ResourceSpans { Resource resource = 1; repeated ScopeSpans scope_spans = 2; }
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
message ExportMetricsServiceRequest { repeated ResourceMetrics resource_metrics = 1; }
message ResourceMetrics { Resource resource = 1; repeated ScopeMetrics scope_metrics = 2; }
message ScopeMetrics { Scope scope = 1; repeated Metric metrics = 2; }
message Metric { string name = 1; string description = 2; string unit = 3; Gauge gauge = 5; Sum sum = 7; }
message Gauge { repeated NumberDataPoint data_points = 1; }
message Sum { repeated NumberDataPoint data_points = 1; int32 aggregation_temporality = 2; bool is_monotonic = 3; }
message NumberDataPoint { repeated KeyValue attributes = 7; fixed64 start_time_unix_nano = 2; fixed64 time_unix_nano = 3; double as_double = 4; }
message PushRequest { repeated StreamAdapter streams = 1; }
message StreamAdapter { string labels = 1; repeated EntryAdapter entries = 2; }
message EntryAdapter { Timestamp timestamp = 1; string line = 2; repeated LabelPair structuredMetadata = 3; }
message LabelPair { string name = 1; string value = 2; }
message Timestamp { int64 seconds = 1; int32 nanos = 2; }
`, { keepCase: true }).root
  let seed = 7
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296)
  const bytes = (n) => Uint8Array.from({ length: n }, () => (rnd() * 256) | 1)
  const hex = (b) => Buffer.from(b).toString('hex')
  const L = (n) => protobuf.util.Long.fromString(String(n), true)
  const sv = (s) => ({ string_value: s })
  const kvs = (pairs) => pairs.map(([key, value]) => ({ key, value: typeof value === 'string' ? sv(value) : value }))
  const jkv = (a) => a.map(({ key, value }) => ({ key, value: value.string_value !== undefined ? { stringValue: value.string_value } : { intValue: String(value.int_value) } }))
  const N = 8200
  const R = 10
  const resource = (r) => ({ attributes: kvs([['service.name', `svc-${r}`], ['service.instance.id', `i-${r}`], ['host.name', `h${r}`], ['k8s.pod.name', `svc-${r}-abc`], ['deployment.environment.name', 'prod']]) })

  const t = { resource_spans: Array.from({ length: R }, (_, r) => ({ resource: resource(r), scope_spans: [{ scope: { name: 'io.opentelemetry.http', version: '1.0' }, spans: Array.from({ length: N / R }, (_, i) => {
    const start = NS - BigInt(Math.floor(rnd() * 60e9))
    return {
      trace_id: bytes(16), span_id: bytes(8), parent_span_id: rnd() < 0.9 ? bytes(8) : new Uint8Array(0), flags: 0x101, name: `GET /api/v1/resource/${i % 50}`, kind: 2,
      start_time_unix_nano: L(start), end_time_unix_nano: L(start + BigInt(Math.floor(rnd() * 1e9))),
      attributes: kvs([['http.request.method', 'GET'], ['http.response.status_code', { int_value: 200 }], ['http.route', `/api/v1/resource/${i % 50}`], ['url.path', `/api/v1/resource/${i % 50}/${Math.floor(rnd() * 1e9)}`],
        ['user_agent.original', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36'], ['server.address', 'api.example.com'], ['server.port', { int_value: 443 }], ['network.protocol.version', '1.1'], ['client.address', `10.0.${i % 255}.${r}`]]),
      events: rnd() < 0.1 ? [{ time_unix_nano: L(start), name: 'exception', attributes: kvs([['exception.message', 'boom']]) }] : [],
      status: { code: rnd() < 0.05 ? 2 : 0 },
    }
  }) }] })) }
  const T = root.lookupType('p.ExportTraceServiceRequest')
  const tJson = JSON.stringify({ resourceSpans: t.resource_spans.map((r) => ({ resource: { attributes: jkv(r.resource.attributes) }, scopeSpans: r.scope_spans.map((s) => ({ scope: s.scope, spans: s.spans.map((p) => ({
    traceId: hex(p.trace_id), spanId: hex(p.span_id), parentSpanId: hex(p.parent_span_id), flags: p.flags, name: p.name, kind: p.kind,
    startTimeUnixNano: p.start_time_unix_nano.toString(), endTimeUnixNano: p.end_time_unix_nano.toString(), attributes: jkv(p.attributes),
    events: p.events.map((e) => ({ timeUnixNano: e.time_unix_nano.toString(), name: e.name, attributes: jkv(e.attributes) })), status: p.status,
  })) })) })) })

  const line = (i) => `ts=2026-11-19T07:00:00Z level=info msg="handled request" request_id=${Math.floor(rnd() * 1e15).toString(16)} route=/api/v1/resource/${i % 50} status=200 duration=${Math.floor(rnd() * 900)}ms`
  const l = { resource_logs: Array.from({ length: R }, (_, r) => ({ resource: resource(r), scope_logs: [{ scope: { name: 'logger' }, log_records: Array.from({ length: N / R }, (_, i) => ({
    time_unix_nano: L(NS - BigInt(Math.floor(rnd() * 60e9))), severity_number: 9, severity_text: 'INFO', body: sv(line(i)), flags: 1, trace_id: bytes(16), span_id: bytes(8),
    attributes: kvs([['http.route', `/api/v1/resource/${i % 50}`], ['user.id', `u${i % 500}`], ['code.function', 'handle']]),
  })) }] })) }
  const LG = root.lookupType('p.ExportLogsServiceRequest')
  const lJson = JSON.stringify({ resourceLogs: l.resource_logs.map((r) => ({ resource: { attributes: jkv(r.resource.attributes) }, scopeLogs: r.scope_logs.map((s) => ({ scope: s.scope, logRecords: s.log_records.map((x) => ({
    timeUnixNano: x.time_unix_nano.toString(), severityNumber: x.severity_number, severityText: x.severity_text, body: { stringValue: x.body.string_value }, attributes: jkv(x.attributes), flags: x.flags, traceId: hex(x.trace_id), spanId: hex(x.span_id),
  })) })) })) })

  const k = { streams: Array.from({ length: R }, (_, s) => ({ labels: `{job="app-${s}", instance="10.0.0.${s}:9100", namespace="prod", filename="/var/log/app-${s}.log"}`, entries: Array.from({ length: N / R }, (_, i) => {
    const ns = NS - BigInt(Math.floor(rnd() * 60e9))
    return { timestamp: { seconds: L(ns / 1_000_000_000n), nanos: Number(ns % 1_000_000_000n) }, line: line(i), structuredMetadata: [{ name: 'trace_id', value: hex(bytes(16)) }] }
  }) })) }
  const P = root.lookupType('p.PushRequest')
  const kJson = JSON.stringify({ streams: k.streams.map((s) => ({ stream: Object.fromEntries([...s.labels.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]])), values: s.entries.map((e) => [String(BigInt(e.timestamp.seconds.toString()) * 1_000_000_000n + BigInt(e.timestamp.nanos)), e.line, Object.fromEntries(e.structuredMetadata.map((m) => [m.name, m.value]))]) })) })

  // Metrics: 10 resources × 82 metrics × 10 points with 4 attributes (8,200 points).
  const m = { resource_metrics: Array.from({ length: R }, (_, r) => ({ resource: resource(r), scope_metrics: [{ scope: { name: 'io.opentelemetry.runtime' }, metrics: Array.from({ length: 82 }, (_, j) => {
    const points = Array.from({ length: 10 }, (_, p) => ({ attributes: kvs([['http.request.method', ['GET', 'POST'][p % 2]], ['http.route', `/api/v1/resource/${p}`], ['http.response.status_code', { int_value: 200 }], ['server.address', 'api.example.com']]),
      start_time_unix_nano: L(NS - 3_600_000_000_000n), time_unix_nano: L(NS - BigInt(p)), as_double: rnd() * 1000 }))
    return j % 2 ? { name: `app.requests.${j}`, unit: '{request}', sum: { data_points: points, aggregation_temporality: 2, is_monotonic: true } } : { name: `app.latency.${j}`, unit: 'ms', gauge: { data_points: points } }
  }) }] })) }
  const M = root.lookupType('p.ExportMetricsServiceRequest')
  const mJson = JSON.stringify({ resourceMetrics: m.resource_metrics.map((r) => ({ resource: { attributes: jkv(r.resource.attributes) }, scopeMetrics: r.scope_metrics.map((s) => ({ scope: s.scope, metrics: s.metrics.map((x) => {
    const pts = (x.sum ?? x.gauge).data_points.map((p) => ({ attributes: jkv(p.attributes), startTimeUnixNano: p.start_time_unix_nano.toString(), timeUnixNano: p.time_unix_nano.toString(), asDouble: p.as_double }))
    return x.sum ? { name: x.name, unit: x.unit, sum: { dataPoints: pts, aggregationTemporality: 2, isMonotonic: true } } : { name: x.name, unit: x.unit, gauge: { dataPoints: pts } }
  }) })) })) })

  return [
    ['realistic traces, 8,200 spans', 'traces', false, false, () => T.encode(T.fromObject(t)).finish()],
    ['realistic traces JSON, 8,200 spans', 'traces', true, false, () => te.encode(tJson)],
    ['realistic logs, 8,200 records', 'logs', false, false, () => LG.encode(LG.fromObject(l)).finish()],
    ['realistic logs JSON, 8,200 records', 'logs', true, false, () => te.encode(lJson)],
    ['realistic Loki push (snappy), 8,200 entries', 'loki', false, true, () => snappy.compress(P.encode(P.fromObject(k)).finish())],
    ['realistic Loki push JSON, 8,200 entries', 'loki', true, false, () => te.encode(kJson)],
    ['realistic metrics, 8,200 points', 'metrics', false, false, () => M.encode(M.fromObject(m)).finish()],
    ['realistic metrics JSON, 8,200 points', 'metrics', true, false, () => te.encode(mJson)],
  ]
}

// ───────────────────────────── bundle ─────────────────────────────

async function bundle(dir) {
  const { build } = await import('esbuild')
  const out = join(dir, 'edge.mjs')
  await build({
    stdin: {
      contents: [
        `export { SpanCollector, decodeTracesProto, decodeTracesJson } from './src/spans'`,
        `export { LogCollector, decodeLogsProto, decodeLogsJson, decodeLokiProto, decodeLokiJson } from './src/logs'`,
        `export { DEFAULT_LIMITS } from './src/limits'`,
        `export { snappyDecompress } from './src/snappy'`,
        `export { decodeOtlpProto, decodeOtlpJson } from './src/otlp'`,
        `export { Collector, buildBatches } from './src/batch'`,
      ].join('\n'),
      resolveDir: join(HERE, '..'), loader: 'ts',
    },
    bundle: true, format: 'esm', platform: 'neutral', outfile: out, logLevel: 'error',
    plugins: [{ name: 'stubs', setup(b) {
      b.onResolve({ filter: /shard\/src\/shard$/ }, () => ({ path: 'shard', namespace: 'shard-stub' }))
      b.onLoad({ filter: /.*/, namespace: 'shard-stub' }, () => ({ contents: 'export const MAX_BATCH_BYTES = 1_048_576', loader: 'js' }))
    } }],
  })
  return out
}

// ───────────────────────────── GC trace ─────────────────────────────

const GC = /(Scavenge|Mark-Compact|Mark-Sweep|Minor Mark-Sweep|Minor Mark-Compact)\S*\s+([\d.]+) \(([\d.]+)\) -> ([\d.]+) \(([\d.]+)\) MB, [^\n]*?([\d.]+) \/ [\d.]+ ms/
const STAMP = /\]\s+(\d+) ms:/

/** Peak, live and retained heap (MiB) between `MARK begin` and `MARK end`. */
function window(text) {
  const lines = text.split('\n')
  const b = lines.findIndex((l) => l.includes('MARK begin'))
  const e = lines.findIndex((l, i) => i > b && l.includes('MARK end'))
  if (b < 0 || e < 0) return null
  const gcs = lines.slice(b + 1, e).map((l) => [l.match(GC), l.match(STAMP)]).filter(([m]) => m).map(([m, s]) => ({ before: +m[2], after: +m[4], ms: s ? +s[1] : 0 }))
  if (gcs.length < 2) return null
  const base = gcs[0].after
  const last = gcs[gcs.length - 1]
  const peak = Math.max(...gcs.slice(1).map((g) => g.before)) - base
  const live = Math.max(...gcs.slice(1).map((g) => g.after)) - base
  const end = lines[e].slice(lines[e].indexOf('MARK end') + 9).trim()
  let info = {}
  try {
    info = JSON.parse(end)
  } catch {}
  return { peak, live, retained: last.after - base, gcs: gcs.length - 2, wallMs: last.ms - gcs[0].ms, ...info }
}

function runNode(bundlePath, bodyFile, spec) {
  const r = spawnSync(process.execPath, ['--expose-gc', '--trace-gc', '--max-old-space-size=1400', fileURLToPath(import.meta.url), '--child', bundlePath, bodyFile, JSON.stringify(spec)], { encoding: 'utf8', maxBuffer: 64 << 20 })
  return window(r.stdout) ?? { error: (r.stderr || r.stdout).slice(-300) }
}

const WORKERD = join(HERE, '..', 'node_modules', '.bin', 'workerd')

async function runWorkerd(dir, bundlePath, bodyFile, spec, port) {
  const d = mkdtempSync(join(dir, 'wd-'))
  writeFileSync(join(d, 'edge.mjs'), readFileSync(bundlePath))
  writeFileSync(join(d, 'memory-run.mjs'), readFileSync(join(HERE, 'memory-run.mjs')))
  writeFileSync(join(d, 'body.bin'), readFileSync(bodyFile))
  writeFileSync(join(d, 'spec.json'), JSON.stringify(spec))
  writeFileSync(join(d, 'worker.mjs'), `
import * as E from './edge.mjs'
import { runCase } from './memory-run.mjs'
import raw from './body.bin'
import spec from './spec.json'
export default {
  async fetch() {
    const body = new Uint8Array(raw.slice(0))
    console.log('MARK begin')
    gc()
    const r = runCase(E, { ...spec, body })
    gc()
    console.log('MARK end ' + JSON.stringify({ outcome: r.outcome, rows: r.rows, rejected: r.rejected, reasons: r.reasons.slice(0, 200) }))
    r.keep.length = 0
    return new Response('done')
  },
}
`)
  writeFileSync(join(d, 'c.capnp'), `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [ (name = "main", worker = .w) ],
  sockets = [ (name = "http", address = "127.0.0.1:${port}", http = (), service = "main") ],
  v8Flags = ["--expose-gc", "--trace-gc"],
);
const w :Workerd.Worker = (
  modules = [
    (name = "worker.mjs", esModule = embed "worker.mjs"),
    (name = "edge.mjs", esModule = embed "edge.mjs"),
    (name = "memory-run.mjs", esModule = embed "memory-run.mjs"),
    (name = "body.bin", data = embed "body.bin"),
    (name = "spec.json", json = embed "spec.json"),
  ],
  compatibilityDate = "2026-11-01",
);
`)
  const child = spawn(WORKERD, ['serve', join(d, 'c.capnp'), '--verbose'], { stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  child.stdout.on('data', (b) => (out += b))
  child.stderr.on('data', (b) => (out += b))
  try {
    for (let i = 0; ; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(600_000) })
        await res.text()
        break
      } catch (e) {
        if (i > 100 || e.name === 'TimeoutError') throw e
        await new Promise((r) => setTimeout(r, 100))
      }
    }
    await new Promise((r) => setTimeout(r, 200))
  } catch (e) {
    child.kill('SIGKILL')
    return { error: String(e).slice(0, 200) + ' ' + out.slice(-300) }
  }
  child.kill('SIGKILL')
  return window(out) ?? { error: out.slice(-300) }
}

// ───────────────────────────── main ─────────────────────────────

const args = process.argv.slice(2)
const wantNode = !args.includes('--workerd') || args.includes('--node')
const wantWorkerd = !args.includes('--node') || args.includes('--workerd')
const asJson = args.includes('--json')
const dumpAt = args.indexOf('--dump')
const dump = dumpAt >= 0 ? args.splice(dumpAt, 2)[1] : null
const filters = args.filter((a) => !a.startsWith('--'))
const mib = Number(process.env.MEM_MIB ?? 4)

const dir = mkdtempSync(join(tmpdir(), 'viz-edge-mem-'))
const bundlePath = await bundle(dir)
const cases = [...hostile(mib), ...(await realistic())].filter(([name]) => filters.length === 0 || filters.some((f) => name.includes(f)))
if (!asJson && !dump) {
  console.log(`| Case | Body | Outcome | Node peak / live / retained (MiB) | Node ArrayBuffers retained | workerd peak / live / retained (MiB) | Node ms |`)
  console.log('|---|---|---|---|---|---|---|')
}
let port = 18900
for (const [name, path, json, snappy, make] of cases) {
  const body = make()
  if (dump) {
    writeFileSync(join(dump, `${name.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '')}.bin`), body)
    continue
  }
  const bodyFile = join(dir, 'body.bin')
  writeFileSync(bodyFile, body)
  const spec = { path, json, snappy, now: NOW }
  const n = wantNode ? runNode(bundlePath, bodyFile, spec) : null
  const w = wantWorkerd ? await runWorkerd(dir, bundlePath, bodyFile, spec, port++) : null
  if (asJson) {
    console.log(JSON.stringify({ name, bodyBytes: body.length, node: n, workerd: w }))
    continue
  }
  const f = (x) => (x == null ? '–' : x.error ? `error: ${x.error.replace(/\n/g, ' ').slice(0, 80)}` : `${x.peak.toFixed(1)} / ${x.live.toFixed(1)} / ${x.retained.toFixed(1)}`)
  const outcome = (n && !n.error ? n : w && !w.error ? w : {}).outcome ?? '?'
  const rows = (n && !n.error ? n : w && !w.error ? w : {}).rows ?? '?'
  const rej = (n && !n.error ? n : w && !w.error ? w : {}).rejected ?? '?'
  const size = body.length >= MiB ? `${(body.length / MiB).toFixed(2)} MiB` : `${(body.length / 1024).toFixed(0)} KiB`
  console.log(`| ${name} | ${size} | ${outcome}, ${rows} rows, ${rej} refused | ${f(n)} | ${n && !n.error ? n.arrayBuffersMiB.toFixed(1) : '–'} | ${f(w)} | ${n && !n.error ? n.ms.toFixed(0) : '–'} |`)
}
