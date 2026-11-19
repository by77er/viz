// Request bodies for the S10 trial, generated inside a client Durable Object (no dependencies,
// no eval). Plain JS so the local check (../check-bodies.mjs) and the Worker import the same file.
//
// 1. realistic(): the "realistic" bodies of edge/bench/bodies.mjs (an instrumented HTTP service,
//    8,200 items: 10 resources x 820), with the same LCG and the same order of random draws, so
//    that with seed 7 and the same NOW the protobuf bytes and the JSON text are IDENTICAL to what
//    bodies.mjs builds with protobufjs (checked by ../check-bodies.mjs). The Worker uses a seed per
//    request, so every request carries new trace and span ids.
// 2. rich*(): the shapes query/README.md "Memory" re-derived the caps from (the query engineer's
//    mem-signals.mjs): ~3 KiB OTel-like resources (50 distinct), 12 to 14 span attributes, 12
//    spans a trace; log lines of 150 to 400 bytes in 50 streams with two metadata keys.
// 3. fat*(): the adversarial review's fat-spans.mjs and fat-logs.mjs, and the README's
//    "600 spans, each its own 60 KB attribute".
// 4. marker*(): one tiny trace or log line with a unique id, for acknowledgement → queryable.

const te = new TextEncoder()

/** The LCG of edge/bench/bodies.mjs (and mem-signals.mjs). */
export function lcg(seed) {
  let s = seed >>> 0
  return () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296)
}

// ───────────────────────────── protobuf writer ─────────────────────────────
// Fields are written in ascending field number and a scalar at its proto3 default (0, empty) is
// left out, except a oneof member, as protobufjs's encoder does: so the bytes can be compared.

const varintSize = (n) => {
  let s = 1
  while (n > 0x7f) {
    n = Math.floor(n / 128)
    s++
  }
  return s
}

export class Pb {
  constructor(cap = 1 << 16) {
    this.buf = new Uint8Array(cap)
    this.pos = 0
    this.stack = []
  }
  grow(n) {
    if (this.pos + n <= this.buf.length) return
    let c = this.buf.length * 2
    while (c < this.pos + n) c *= 2
    const b = new Uint8Array(c)
    b.set(this.buf.subarray(0, this.pos))
    this.buf = b
  }
  raw(n) {
    this.grow(10)
    while (n > 0x7f) {
      this.buf[this.pos++] = (n % 128) | 0x80
      n = Math.floor(n / 128)
    }
    this.buf[this.pos++] = n
  }
  tag(field, wt) {
    this.raw(field * 8 + wt)
  }
  uint(field, n, always = false) {
    if (n === 0 && !always) return
    this.tag(field, 0)
    this.raw(n)
  }
  uint64(field, v) {
    // A non-negative bigint as a varint.
    this.tag(field, 0)
    this.grow(10)
    let x = BigInt(v)
    while (x > 0x7fn) {
      this.buf[this.pos++] = Number(x & 0x7fn) | 0x80
      x >>= 7n
    }
    this.buf[this.pos++] = Number(x)
  }
  fixed64(field, v) {
    this.tag(field, 1)
    this.grow(8)
    new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 8).setBigUint64(0, BigInt(v), true)
    this.pos += 8
  }
  fixed32(field, v) {
    this.tag(field, 5)
    this.grow(4)
    new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 4).setUint32(0, v >>> 0, true)
    this.pos += 4
  }
  double(field, v) {
    this.tag(field, 1)
    this.grow(8)
    new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 8).setFloat64(0, v, true)
    this.pos += 8
  }
  bytes(field, b, always = false) {
    if (b.length === 0 && !always) return
    this.tag(field, 2)
    this.raw(b.length)
    this.grow(b.length)
    this.buf.set(b, this.pos)
    this.pos += b.length
  }
  string(field, s, always = false) {
    this.bytes(field, te.encode(s), always)
  }
  /** Start a length-delimited field; `end()` writes its length in front of it. */
  begin(field) {
    this.tag(field, 2)
    this.stack.push(this.pos)
  }
  end() {
    const start = this.stack.pop()
    const len = this.pos - start
    const s = varintSize(len)
    this.grow(s)
    this.buf.copyWithin(start + s, start, this.pos)
    let p = start
    let n = len
    while (n > 0x7f) {
      this.buf[p++] = (n % 128) | 0x80
      n = Math.floor(n / 128)
    }
    this.buf[p] = n
    this.pos += s
  }
  finish() {
    return this.buf.slice(0, this.pos)
  }
}

function anyValue(w, field, v) {
  w.begin(field)
  if (v.string_value !== undefined) w.string(1, v.string_value, true)
  else if (v.bool_value !== undefined) w.uint(2, v.bool_value ? 1 : 0, true)
  else if (v.int_value !== undefined) w.uint64(3, BigInt(v.int_value))
  else if (v.double_value !== undefined) w.double(4, v.double_value)
  w.end()
}
function keyValues(w, field, kvs) {
  for (const { key, value } of kvs) {
    w.begin(field)
    w.string(1, key)
    anyValue(w, 2, value)
    w.end()
  }
}
function scope(w, field, s) {
  w.begin(field)
  if (s.name !== undefined) w.string(1, s.name)
  if (s.version !== undefined) w.string(2, s.version)
  w.end()
}

// ───────────────────────────── 1. realistic (bodies.mjs) ─────────────────────────────

const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
const sv = (s) => ({ string_value: s })
const kvs = (pairs) => pairs.map(([key, value]) => ({ key, value: typeof value === 'string' ? sv(value) : value }))
const jkv = (a) => a.map(({ key, value }) => ({ key, value: value.string_value !== undefined ? { stringValue: value.string_value } : { intValue: String(value.int_value) } }))
const N = 8200
const R = 10
const resourceOf = (r) => ({ attributes: kvs([['service.name', `svc-${r}`], ['service.instance.id', `i-${r}`], ['host.name', `h${r}`], ['k8s.pod.name', `svc-${r}-abc`], ['deployment.environment.name', 'prod']]) })

/** bodies.mjs's traces object `t`, drawing from `rnd` in bodies.mjs's order. NS: bigint ns. */
export function realisticTraces(rnd, NS, n = N) {
  const bytes = (k) => Uint8Array.from({ length: k }, () => (rnd() * 256) | 1)
  return { resource_spans: Array.from({ length: R }, (_, r) => ({ resource: resourceOf(r), scope_spans: [{ scope: { name: 'io.opentelemetry.http', version: '1.0' }, spans: Array.from({ length: n / R }, (_, i) => {
    const start = NS - BigInt(Math.floor(rnd() * 60e9))
    return {
      trace_id: bytes(16), span_id: bytes(8), parent_span_id: rnd() < 0.9 ? bytes(8) : new Uint8Array(0), flags: 0x101, name: `GET /api/v1/resource/${i % 50}`, kind: 2,
      start_time_unix_nano: start, end_time_unix_nano: start + BigInt(Math.floor(rnd() * 1e9)),
      attributes: kvs([['http.request.method', 'GET'], ['http.response.status_code', { int_value: 200 }], ['http.route', `/api/v1/resource/${i % 50}`], ['url.path', `/api/v1/resource/${i % 50}/${Math.floor(rnd() * 1e9)}`],
        ['user_agent.original', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36'], ['server.address', 'api.example.com'], ['server.port', { int_value: 443 }], ['network.protocol.version', '1.1'], ['client.address', `10.0.${i % 255}.${r}`]]),
      events: rnd() < 0.1 ? [{ time_unix_nano: start, name: 'exception', attributes: kvs([['exception.message', 'boom']]) }] : [],
      status: { code: rnd() < 0.05 ? 2 : 0 },
    }
  }) }] })) }
}

export function tracesProto(t) {
  const w = new Pb(4 << 20)
  for (const rs of t.resource_spans) {
    w.begin(1)
    w.begin(1)
    keyValues(w, 1, rs.resource.attributes)
    w.end()
    for (const ss of rs.scope_spans) {
      w.begin(2)
      scope(w, 1, ss.scope)
      for (const p of ss.spans) {
        w.begin(2)
        w.bytes(1, p.trace_id)
        w.bytes(2, p.span_id)
        w.bytes(4, p.parent_span_id)
        w.string(5, p.name)
        w.uint(6, p.kind)
        w.fixed64(7, p.start_time_unix_nano)
        w.fixed64(8, p.end_time_unix_nano)
        keyValues(w, 9, p.attributes)
        for (const e of p.events) {
          w.begin(11)
          w.fixed64(1, e.time_unix_nano)
          w.string(2, e.name)
          keyValues(w, 3, e.attributes)
          w.end()
        }
        w.begin(15)
        w.uint(3, p.status.code)
        w.end()
        w.fixed32(16, p.flags)
        w.end()
      }
      w.end()
    }
    w.end()
  }
  return w.finish()
}

export const tracesJson = (t) => JSON.stringify({ resourceSpans: t.resource_spans.map((r) => ({ resource: { attributes: jkv(r.resource.attributes) }, scopeSpans: r.scope_spans.map((s) => ({ scope: s.scope, spans: s.spans.map((p) => ({
  traceId: hex(p.trace_id), spanId: hex(p.span_id), parentSpanId: hex(p.parent_span_id), flags: p.flags, name: p.name, kind: p.kind,
  startTimeUnixNano: p.start_time_unix_nano.toString(), endTimeUnixNano: p.end_time_unix_nano.toString(), attributes: jkv(p.attributes),
  events: p.events.map((e) => ({ timeUnixNano: e.time_unix_nano.toString(), name: e.name, attributes: jkv(e.attributes) })), status: p.status,
})) })) })) })

const lineOf = (rnd, i) => `ts=2026-11-19T07:00:00Z level=info msg="handled request" request_id=${Math.floor(rnd() * 1e15).toString(16)} route=/api/v1/resource/${i % 50} status=200 duration=${Math.floor(rnd() * 900)}ms`

/** bodies.mjs's logs object `l`. */
export function realisticLogs(rnd, NS, n = N) {
  const bytes = (k) => Uint8Array.from({ length: k }, () => (rnd() * 256) | 1)
  return { resource_logs: Array.from({ length: R }, (_, r) => ({ resource: resourceOf(r), scope_logs: [{ scope: { name: 'logger' }, log_records: Array.from({ length: n / R }, (_, i) => ({
    time_unix_nano: NS - BigInt(Math.floor(rnd() * 60e9)), severity_number: 9, severity_text: 'INFO', body: sv(lineOf(rnd, i)), flags: 1, trace_id: bytes(16), span_id: bytes(8),
    attributes: kvs([['http.route', `/api/v1/resource/${i % 50}`], ['user.id', `u${i % 500}`], ['code.function', 'handle']]),
  })) }] })) }
}

export function logsProto(l) {
  const w = new Pb(4 << 20)
  for (const rl of l.resource_logs) {
    w.begin(1)
    w.begin(1)
    keyValues(w, 1, rl.resource.attributes)
    w.end()
    for (const sl of rl.scope_logs) {
      w.begin(2)
      scope(w, 1, sl.scope)
      for (const x of sl.log_records) {
        w.begin(2)
        w.fixed64(1, x.time_unix_nano)
        w.uint(2, x.severity_number)
        w.string(3, x.severity_text)
        anyValue(w, 5, x.body)
        keyValues(w, 6, x.attributes)
        w.fixed32(8, x.flags)
        w.bytes(9, x.trace_id)
        w.bytes(10, x.span_id)
        w.end()
      }
      w.end()
    }
    w.end()
  }
  return w.finish()
}

export const logsJson = (l) => JSON.stringify({ resourceLogs: l.resource_logs.map((r) => ({ resource: { attributes: jkv(r.resource.attributes) }, scopeLogs: r.scope_logs.map((s) => ({ scope: s.scope, logRecords: s.log_records.map((x) => ({
  timeUnixNano: x.time_unix_nano.toString(), severityNumber: x.severity_number, severityText: x.severity_text, body: { stringValue: x.body.string_value }, attributes: jkv(x.attributes), flags: x.flags, traceId: hex(x.trace_id), spanId: hex(x.span_id),
})) })) })) })

/** bodies.mjs's Loki push object `k` (seconds as bigint). */
export function realisticLoki(rnd, NS, n = N) {
  const bytes = (k) => Uint8Array.from({ length: k }, () => (rnd() * 256) | 1)
  return { streams: Array.from({ length: R }, (_, s) => ({ labels: `{job="app-${s}", instance="10.0.0.${s}:9100", namespace="prod", filename="/var/log/app-${s}.log"}`, entries: Array.from({ length: n / R }, (_, i) => {
    const ns = NS - BigInt(Math.floor(rnd() * 60e9))
    return { timestamp: { seconds: ns / 1_000_000_000n, nanos: Number(ns % 1_000_000_000n) }, line: lineOf(rnd, i), structuredMetadata: [{ name: 'trace_id', value: hex(bytes(16)) }] }
  }) })) }
}

export function lokiProto(k) {
  const w = new Pb(2 << 20)
  for (const s of k.streams) {
    w.begin(1)
    w.string(1, s.labels)
    for (const e of s.entries) {
      w.begin(2)
      w.begin(1)
      w.uint64(1, e.timestamp.seconds)
      w.uint(2, e.timestamp.nanos)
      w.end()
      w.string(2, e.line)
      for (const m of e.structuredMetadata) {
        w.begin(3)
        w.string(1, m.name)
        w.string(2, m.value)
        w.end()
      }
      w.end()
    }
    w.end()
  }
  return w.finish()
}

export const lokiJson = (k) => JSON.stringify({ streams: k.streams.map((s) => ({ stream: Object.fromEntries([...s.labels.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]])), values: s.entries.map((e) => [String(e.timestamp.seconds * 1_000_000_000n + BigInt(e.timestamp.nanos)), e.line, Object.fromEntries(e.structuredMetadata.map((m) => [m.name, m.value]))]) })) })

// ───────────────────────────── 2. rich (query/README.md "Memory") ─────────────────────────────

const S = (k, v) => ({ key: k, value: { stringValue: v } })
const I = (k, v) => ({ key: k, value: { intValue: String(v) } })

/** mem-signals.mjs's 50 resources (10 services x 5 pods), ~3 KiB each, from its own LCG (seed 7). */
export function richResources() {
  const rnd = lcg(7)
  const h = (k) => Array.from({ length: k }, () => Math.floor(rnd() * 16).toString(16)).join('')
  const out = []
  for (let svc = 0; svc < 10; svc++) for (let pod = 0; pod < 5; pod++) {
    const name = `svc-${svc}`
    out.push({ attributes: [
      S('service.name', name), S('service.namespace', 'shop'), S('service.version', `1.${svc}.${pod}`), S('service.instance.id', `${h(8)}-${h(4)}-${h(4)}-${h(4)}-${h(12)}`),
      S('deployment.environment', 'production'), S('telemetry.sdk.name', 'opentelemetry'), S('telemetry.sdk.language', 'java'), S('telemetry.sdk.version', '1.44.1'),
      S('telemetry.distro.name', 'opentelemetry-java-instrumentation'), S('telemetry.distro.version', '2.10.0'), I('process.pid', 1),
      S('process.executable.path', '/opt/java/openjdk/bin/java'),
      S('process.command_line', `/opt/java/openjdk/bin/java -javaagent:/otel/opentelemetry-javaagent.jar -XX:+UseContainerSupport -XX:MaxRAMPercentage=75.0 -Dotel.resource.attributes=service.name=${name},service.namespace=shop -Dspring.profiles.active=prod -Dlogging.config=/config/logback.xml -Djava.security.egd=file:/dev/./urandom -Duser.timezone=UTC -Dfile.encoding=UTF-8 -Dcom.sun.management.jmxremote.port=9010 -Dcom.sun.management.jmxremote.authenticate=false -Dcom.sun.management.jmxremote.ssl=false -cp /app/resources:/app/classes:/app/libs/* com.example.shop.${name}.Application --server.port=8080 --management.server.port=8081 ${'x'.repeat(200)}`),
      S('process.runtime.name', 'OpenJDK Runtime Environment'), S('process.runtime.version', '21.0.5+11-LTS'), S('process.runtime.description', 'Eclipse Adoptium OpenJDK 64-Bit Server VM 21.0.5+11-LTS'),
      S('host.name', `${name}-7d9f8b6c5-${h(5)}`), S('host.arch', 'amd64'), S('host.id', h(32)), S('os.type', 'linux'), S('os.description', 'Linux 6.1.112-122.189.amzn2023.x86_64'),
      S('container.id', h(64)), S('container.name', name), S('container.image.name', `123456789012.dkr.ecr.eu-west-1.amazonaws.com/shop/${name}`), S('container.image.tag', `sha-${h(12)}`),
      S('k8s.namespace.name', 'shop-prod'), S('k8s.pod.name', `${name}-7d9f8b6c5-${h(5)}`), S('k8s.pod.uid', `${h(8)}-${h(4)}-${h(4)}-${h(4)}-${h(12)}`),
      S('k8s.node.name', `ip-10-0-${pod}-${svc}.eu-west-1.compute.internal`), S('k8s.deployment.name', name), S('k8s.replicaset.name', `${name}-7d9f8b6c5`), S('k8s.cluster.name', 'prod-eu-west-1'),
      S('cloud.provider', 'aws'), S('cloud.platform', 'aws_eks'), S('cloud.region', 'eu-west-1'), S('cloud.availability_zone', `eu-west-1${'abc'[pod % 3]}`), S('cloud.account.id', '123456789012'),
    ] })
  }
  return out
}

function richSpanAttrs(i) {
  const a = [S('http.request.method', 'GET'), S('url.path', `/api/v1/orders/${i % 997}/items`), S('url.scheme', 'https'), S('http.route', '/api/v1/orders/{id}/items'), I('http.response.status_code', i % 50 ? 200 : 500),
    S('server.address', 'shop.example.com'), I('server.port', 443), S('client.address', `10.0.${i % 255}.${(i * 7) % 255}`), S('network.protocol.version', '1.1'),
    S('user_agent.original', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15'), I('thread.id', 40 + (i % 64)), S('thread.name', `http-nio-8080-exec-${i % 64}`)]
  if (i % 3 === 0) a.push(S('db.system', 'postgresql'), S('db.statement', `SELECT o.id, o.created_at, o.status, i.sku, i.quantity, i.price FROM orders o JOIN order_items i ON i.order_id = o.id WHERE o.customer_id = $1 AND o.created_at > $2 ORDER BY o.created_at DESC LIMIT 50 /* ${i} */`))
  return a
}

/**
 * OTLP/JSON spans `from` .. `from + count - 1` of mem-signals.mjs's `realistic-spans` (or
 * `fat-attrs`: every span its own 60 KB attribute): start t0 + i x 50 ms (i counted from the block start, so `from` continues a block), 20 ms long, 12 spans a
 * trace (trace id i/12 + 1 + idBase), span id i + 1 + idBase.
 */
export function richSpansJson(resources, from, count, t0Ns, { fat = false, idBase = 0 } = {}) {
  const groups = new Map()
  for (let made = from; made < from + count; made++) {
    const r = made % resources.length
    const start = t0Ns + BigInt(made) * 50_000_000n
    const attrs = fat ? [S('blob', 'y'.repeat(60_000) + made)] : richSpanAttrs(made)
    const sp = { traceId: (Math.floor(made / 12) + 1 + idBase).toString(16).padStart(32, '0'), spanId: (made + 1 + idBase).toString(16).padStart(16, '0'), name: `op-${made % 40}`, kind: 2, startTimeUnixNano: String(start), endTimeUnixNano: String(start + 20_000_000n), attributes: attrs }
    if (!groups.has(r)) groups.set(r, [])
    groups.get(r).push(sp)
  }
  return JSON.stringify({ resourceSpans: [...groups].map(([r, spans]) => ({ resource: resources[r], scopeSpans: [{ scope: { name: 'io.opentelemetry.tomcat-10.0', version: '2.10.0-alpha' }, spans }] })) })
}

/** Loki/JSON rows `from` .. of mem-signals.mjs's `realistic-logs`: 50 streams, t0 + i x 50 ms. */
export function richLogsJson(from, count, t0Ns, seed) {
  const rnd = lcg(seed)
  const h = (k) => Array.from({ length: k }, () => Math.floor(rnd() * 16).toString(16)).join('')
  const streams = new Map()
  for (let made = from; made < from + count; made++) {
    const s = made % 50
    const line = `ts=2026-11-19T11:${String(Math.floor(made / 1000) % 60).padStart(2, '0')}:00Z level=${made % 20 ? 'info' : 'error'} msg="handled request" method=GET path=/api/v1/orders/${made % 997}/items status=${made % 50 ? 200 : 500} duration_ms=${made % 300} user=${made % 1000} trace_id=${h(32)} ${'k'.repeat(made % 250)}`
    if (!streams.has(s)) streams.set(s, [])
    streams.get(s).push([String(t0Ns + BigInt(made) * 50_000_000n), line, { trace_id: h(32), pod: `svc-${s % 10}-7d9f8b6c5-${s}` }])
  }
  return JSON.stringify({ streams: [...streams].map(([s, values]) => ({ stream: { job: `svc-${s % 10}`, namespace: 'shop-prod', pod: `svc-${s % 10}-7d9f8b6c5-${s}`, container: 'app', node: `ip-10-0-${s}.eu-west-1.compute.internal` }, values })) })
}

// ───────────────────────────── 3. fat shapes (the review's repro) ─────────────────────────────

/** fat-spans.mjs: one resource of three 60 KB attributes, spans `from` .. (trace id i + 1, span id 1), start t0 + i µs. */
export function fatSpansJson(from, count, t0Ns) {
  const big = (i) => 'x'.repeat(60_000) + i
  const resource = { attributes: [{ key: 'service.name', value: { stringValue: 'api' } }, ...[0, 1, 2].map((i) => ({ key: `blob${i}`, value: { stringValue: big(i) } }))] }
  const spans = []
  for (let made = from; made < from + count; made++) spans.push({ traceId: (made + 1).toString(16).padStart(32, '0'), spanId: '0000000000000001', name: 'op', kind: 2, startTimeUnixNano: String(t0Ns + BigInt(made) * 1000n), endTimeUnixNano: String(t0Ns + BigInt(made) * 1000n + 1000n) })
  return JSON.stringify({ resourceSpans: [{ resource, scopeSpans: [{ scope: {}, spans }] }] })
}

/** fat-logs.mjs: stream {job}, lines of 200 KB, t0 + i ms. */
export function fatLogsJson(job, from, count, t0Ns) {
  const values = []
  for (let made = from; made < from + count; made++) values.push([String(t0Ns + BigInt(made) * 1_000_000n), 'x'.repeat(200_000) + made])
  return JSON.stringify({ streams: [{ stream: { job }, values }] })
}

// ───────────────────────────── 4. markers ─────────────────────────────

const randomHex = (bytes) => hex(crypto.getRandomValues(new Uint8Array(bytes)))

/** One trace of a root and a child (OTLP/JSON), unique ids; the times are now. */
export function markerTrace(nowMs, tag) {
  const traceId = randomHex(16)
  const root = randomHex(8)
  const ns = BigInt(nowMs) * 1_000_000n
  const body = JSON.stringify({ resourceSpans: [{ resource: { attributes: [S('service.name', 'marker')] }, scopeSpans: [{ scope: { name: 's10' }, spans: [
    { traceId, spanId: root, name: 'marker-root', kind: 2, startTimeUnixNano: String(ns - 5_000_000n), endTimeUnixNano: String(ns), attributes: [S('marker', tag)] },
    { traceId, spanId: randomHex(8), parentSpanId: root, name: 'marker-child', kind: 3, startTimeUnixNano: String(ns - 4_000_000n), endTimeUnixNano: String(ns - 1_000_000n), attributes: [S('marker', tag)] },
  ] }] }] })
  return { traceId, body }
}

/** One Loki/JSON line in stream {job="marker"} carrying a unique token. */
export function markerLine(nowMs, tag) {
  const token = `m${randomHex(8)}`
  const body = JSON.stringify({ streams: [{ stream: { job: 'marker', run: tag }, values: [[String(BigInt(nowMs) * 1_000_000n), `marker ${token} level=info`]] }] })
  return { token, body }
}

// ───────────────────────────── Remote Write (metrics sanity) ─────────────────────────────

/** prometheus.WriteRequest { timeseries { labels, samples } } (protobuf, uncompressed). */
export function remoteWrite(series) {
  const w = new Pb(4096)
  for (const s of series) {
    w.begin(1)
    for (const [name, value] of Object.entries(s.labels).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      w.begin(1)
      w.string(1, name)
      w.string(2, value)
      w.end()
    }
    for (const [ts, v] of s.samples) {
      w.begin(2)
      w.double(1, v)
      w.uint64(2, BigInt(ts))
      w.end()
    }
    w.end()
  }
  return w.finish()
}

export const utf8 = (s) => te.encode(s)
