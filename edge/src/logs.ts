import { type Batch, fnv1a64 } from './batch'
import { badRequest, tooLarge } from './errors'
import type { Limits } from './limits'
import {
  type AnyV,
  Buf,
  type KV,
  bad,
  cmpUtf8,
  jsonAny,
  jsonAttrs,
  jsonId,
  jsonInt,
  jsonU32,
  list,
  nsHalves,
  nsToMs,
  object,
  parseJson,
  pbAnyValue,
  pbBytes,
  pbFixed32,
  pbKeyValue,
  pbString,
  plainText,
  resourceRoute,
  text,
  utf8,
} from './otel'
import { PbReader } from './pb'

/**
 * Log records → `VZB1` signal 3 (contracts/BATCH.md, "Log records, signal 3";
 * contracts/LOGS.md §1): OTLP/HTTP logs (protobuf, JSON) and Loki push (protobuf with
 * snappy, JSON). A record that breaks a rule is refused on its own and counted with its
 * reason; the rest of the request is stored.
 */

export const LOG = {
  maxLine: 262_144,
  maxSeverityText: 1024,
  maxLabels: 32,
  maxNameBytes: 1024,
  maxValueBytes: 8192,
  maxMetadata: 128,
  maxMetadataBytes: 65_536,
  rowFixedBytes: 61,
} as const

export const LogReject = {
  noTime: 'log record without a timestamp',
  badTime: 'log timestamp outside 1970 to 2262, or malformed',
  tooOld: 'log timestamp older than the accept window',
  tooNew: 'log timestamp too far in the future',
  severity: 'severity number above 24',
  severityText: 'severity text over 1,024 bytes',
  traceId: 'log record with a trace_id that is not 16 bytes',
  spanId: 'log record with a span_id that is not 8 bytes',
  line: 'log line over 256 KiB',
  labelName: 'stream label name breaks [A-Za-z_][A-Za-z0-9_]* or is over 1,024 bytes',
  labelValue: 'stream label value over 8,192 bytes or with a NUL byte',
  labelDup: 'stream label name repeated',
  noLabels: 'stream without labels',
  tooManyLabels: 'stream with more than 32 labels',
  labelSyntax: 'stream labels do not parse as {name="value", ...}',
  mdName: 'structured metadata name breaks [A-Za-z_][A-Za-z0-9_]* or is over 1,024 bytes',
  mdValue: 'structured metadata value over 8,192 bytes or with a NUL byte',
  mdDup: 'structured metadata name repeated',
  mdTooMany: 'more than 128 structured metadata entries',
  mdTooLarge: 'structured metadata over 64 KiB',
  emptyKey: 'attribute with an empty key',
} as const

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Resource attributes that are stream labels by default (contracts/LOGS.md §1). */
export const STREAM_LABEL_KEYS: ReadonlySet<string> = new Set([
  'service.name',
  'service.namespace',
  'deployment.environment.name',
  'cloud.region',
  'cloud.availability_zone',
  'k8s.cluster.name',
  'k8s.namespace.name',
  'k8s.container.name',
  'container.name',
  'k8s.replicaset.name',
  'k8s.deployment.name',
  'k8s.statefulset.name',
  'k8s.daemonset.name',
  'k8s.cronjob.name',
  'k8s.job.name',
])

/** An attribute key as a label or metadata name: non-`[A-Za-z0-9_]` characters become `_`; a leading digit gets `_` in front. */
export function labelName(key: string): string {
  let out = ''
  for (const ch of key) {
    const c = ch.charCodeAt(0)
    out += (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 95 ? ch : '_'
  }
  const c0 = out.charCodeAt(0)
  return c0 >= 48 && c0 <= 57 ? `_${out}` : out
}

/** One accepted record. */
interface Row {
  entry: number
  tsLo: number
  tsHi: number
  obsLo: number
  obsHi: number
  traceId: Uint8Array
  spanId: Uint8Array
  flags: number
  severity: number
  line: Uint8Array
  severityText: Uint8Array
  metadata: Uint8Array
  size: number
}

export interface LogIn {
  /** i64 nanoseconds as halves, or null when the record has no usable timestamp. */
  ts: [number, number] | null
  observed: [number, number]
  traceId: Uint8Array
  spanId: Uint8Array
  flags: number
  severity: number
  severityText: string
  line: string
  metadata: [string, string][]
}

const ZERO16 = new Uint8Array(16)
const ZERO8 = new Uint8Array(8)
const zero = (b: Uint8Array): boolean => b.every((x) => x === 0)

/** Canonical name-value pairs: empty values dropped, names checked, sorted by UTF-8 bytes. */
function pairs(raw: readonly [string, string][], nameReason: string, valueReason: string, dupReason: string): [string, string][] | string {
  const out: [string, string][] = []
  for (const [n, v] of raw) {
    if (v === '') continue
    if (!NAME.test(n) || n.length > LOG.maxNameBytes) return nameReason
    if (v.includes('\u0000') || utf8(v).length > LOG.maxValueBytes) return valueReason
    out.push([n, v])
  }
  out.sort((a, b) => cmpUtf8(a[0], b[0]))
  for (let i = 1; i < out.length; i++) if (out[i - 1]![0] === out[i]![0]) return dupReason
  return out
}

/** Accumulates the validated log records of one request, grouped by stream. */
export class LogCollector {
  readonly streamBytes: Uint8Array[] = []
  readonly streamIds: bigint[] = []
  private readonly streamByKey = new Map<string, number>()
  readonly routes: string[] = []
  readonly routeOf: number[] = []
  private readonly routeIdx = new Map<string, number>()
  readonly rows: Row[] = []
  rowSeries = new Uint32Array(0)

  received = 0
  rejectedTotal = 0
  readonly rejected = new Map<string, number>()
  private readonly minMs: number
  private readonly maxMs: number

  constructor(readonly limits: Limits, now: number) {
    this.minMs = Math.max(now - limits.logAcceptBackMs, 0)
    this.maxMs = now + limits.logAcceptAheadMs
  }

  get nRows(): number {
    return this.rows.length
  }
  get nSeries(): number {
    return this.streamBytes.length
  }
  seriesId(i: number): bigint {
    return this.streamIds[i]!
  }

  reject(reason: string, count = 1): void {
    if (count <= 0) return
    this.rejected.set(reason, (this.rejected.get(reason) ?? 0) + count)
    this.rejectedTotal += count
    this.received += count
  }

  rejectionSummary(): string {
    const s = [...this.rejected].map(([r, n]) => `${n} ${r}`).join('; ')
    // Bounded, as the OTLP specification asks of partial-success messages; long enough to name every reason.
    return s.length > 2048 ? `${s.slice(0, 2045)}...` : s
  }

  /**
   * The stream for a label set: its index, or the reason its records are refused. `route` is
   * the routing key; by default it is built from the `job` and `instance` labels.
   */
  stream(raw: readonly [string, string][], route?: string): number | string {
    const labels = pairs(raw, LogReject.labelName, LogReject.labelValue, LogReject.labelDup)
    if (typeof labels === 'string') return labels
    if (labels.length === 0) return LogReject.noLabels
    if (labels.length > LOG.maxLabels) return LogReject.tooManyLabels
    const b = new Buf(64)
    const idInput = new Buf(64)
    b.big(0n)
    b.u32(labels.length)
    let job = ''
    let instance = ''
    for (const [n, v] of labels) {
      const nb = utf8(n)
      const vb = utf8(v)
      b.u16(nb.length)
      b.bytes(nb)
      b.u16(vb.length)
      b.bytes(vb)
      idInput.bytes(nb)
      idInput.u8(0)
      idInput.bytes(vb)
      idInput.u8(0)
      if (n === 'job') job = v
      else if (n === 'instance') instance = v
    }
    const id = fnv1a64(idInput.done())
    const bytes = b.done()
    new DataView(bytes.buffer).setBigInt64(0, id, true)
    let key = ''
    for (let i = 0; i < bytes.length; i += 4096) key += String.fromCharCode(...bytes.subarray(i, i + 4096))
    const hit = this.streamByKey.get(key)
    if (hit !== undefined) return hit
    const idx = this.streamBytes.length
    this.streamBytes.push(bytes)
    this.streamIds.push(id)
    this.streamByKey.set(key, idx)
    const r = route ?? `job=${job}\u0000instance=${instance}`
    let ri = this.routeIdx.get(r)
    if (ri === undefined) {
      ri = this.routes.length
      this.routes.push(r)
      this.routeIdx.set(r, ri)
    }
    this.routeOf.push(ri)
    return idx
  }

  /** Validate one record of stream `stream` (or refuse it) and add it. */
  add(stream: number, x: LogIn): void {
    if (x.ts === null) return this.reject(LogReject.noTime)
    const ms = nsToMs(x.ts[0], x.ts[1])
    if (ms < this.minMs) return this.reject(LogReject.tooOld)
    if (ms > this.maxMs) return this.reject(LogReject.tooNew)
    if (!(x.severity >= 0 && x.severity <= 24)) return this.reject(LogReject.severity)
    if (x.traceId.length !== 0 && x.traceId.length !== 16) return this.reject(LogReject.traceId)
    if (x.spanId.length !== 0 && x.spanId.length !== 8) return this.reject(LogReject.spanId)
    const line = utf8(x.line)
    if (line.length > LOG.maxLine) return this.reject(LogReject.line)
    const severityText = utf8(x.severityText)
    if (severityText.length > LOG.maxSeverityText) return this.reject(LogReject.severityText)
    const md = pairs(x.metadata, LogReject.mdName, LogReject.mdValue, LogReject.mdDup)
    if (typeof md === 'string') return this.reject(md)
    if (md.length > LOG.maxMetadata) return this.reject(LogReject.mdTooMany)
    const mb = new Buf(16)
    mb.u16(md.length)
    let total = 0
    for (const [n, v] of md) {
      const nb = utf8(n)
      const vb = utf8(v)
      total += nb.length + vb.length
      mb.u16(nb.length)
      mb.bytes(nb)
      mb.u16(vb.length)
      mb.bytes(vb)
    }
    if (total > LOG.maxMetadataBytes) return this.reject(LogReject.mdTooLarge)
    if (this.rows.length >= this.limits.maxLogRecords) throw tooLarge(`more than ${this.limits.maxLogRecords} log records in one request`)
    this.received++
    const metadata = mb.done()
    this.rows.push({
      entry: stream,
      tsLo: x.ts[0],
      tsHi: x.ts[1],
      obsLo: x.observed[0],
      obsHi: x.observed[1],
      traceId: x.traceId.length === 0 ? ZERO16 : x.traceId,
      spanId: x.spanId.length === 0 ? ZERO8 : x.spanId,
      flags: x.flags >>> 0,
      severity: x.severity,
      line,
      severityText,
      metadata,
      size: LOG.rowFixedBytes + line.length + severityText.length + metadata.length,
    })
  }

  seal(): void {
    this.rowSeries = Uint32Array.from(this.rows, (r) => r.entry)
  }

  /** Batches per slot, rows in arrival order, each batch at most `maxBatchBytes`. */
  build(slotOfStream: ArrayLike<number>, maxBatchBytes: number): Map<number, Batch[]> {
    const bySlot = new Map<number, Row[]>()
    for (const r of this.rows) {
      const slot = slotOfStream[r.entry]!
      let l = bySlot.get(slot)
      if (!l) bySlot.set(slot, (l = []))
      l.push(r)
    }
    const out = new Map<number, Batch[]>()
    for (const [slot, rows] of bySlot) {
      const batches: Batch[] = []
      let from = 0
      while (from < rows.length) {
        const local = new Map<number, number>()
        let entryBytes = 0
        let varBytes = 0
        let to = from
        for (; to < rows.length; to++) {
          const r = rows[to]!
          const isNew = !local.has(r.entry)
          const e = entryBytes + (isNew ? this.streamBytes[r.entry]!.length : 0)
          const n = to - from + 1
          const bound = 16 + e + 8 + 49 * n + 12 * (n + 1) + varBytes + (r.size - LOG.rowFixedBytes) + 8 * 12
          if (n > 1 && bound > maxBatchBytes) break
          if (isNew) {
            local.set(r.entry, local.size)
            entryBytes = e
          }
          varBytes += r.size - LOG.rowFixedBytes
        }
        batches.push(this.encode(rows.slice(from, to), local))
        from = to
      }
      out.set(slot, batches)
    }
    return out
  }

  private encode(rows: Row[], local: Map<number, number>): Batch {
    const b = new Buf(1024)
    b.bytes(new Uint8Array([0x56, 0x5a, 0x42, 0x31, 3, 0, 0, 0]))
    b.u32(rows.length)
    b.u32(local.size)
    for (const e of local.keys()) b.bytes(this.streamBytes[e]!)
    const fixed = (f: (r: Row) => void): void => {
      b.pad8()
      for (const r of rows) f(r)
    }
    fixed((r) => b.u32(local.get(r.entry)!))
    fixed((r) => b.i64(r.tsLo, r.tsHi))
    fixed((r) => b.i64(r.obsLo, r.obsHi))
    fixed((r) => b.bytes(r.traceId))
    fixed((r) => b.bytes(r.spanId))
    fixed((r) => b.u32(r.flags))
    fixed((r) => b.u8(r.severity))
    for (const col of ['line', 'severityText', 'metadata'] as const) {
      b.pad8()
      let off = 0
      b.u32(0)
      for (const r of rows) {
        off += r[col].length
        b.u32(off)
      }
      b.pad8()
      for (const r of rows) b.bytes(r[col])
    }
    b.pad8()
    return { bytes: b.done(), rows: rows.length }
  }
}

// ───────────────────────────── OTLP mapping ─────────────────────────────

/** Flatten an attribute into (name, value) leaves: key-value lists by `_` (contracts/LOGS.md §1). */
function flatten(prefix: string, v: AnyV, out: [string, string][]): void {
  if (v.k === 'l') {
    for (const [k, x] of v.v) flatten(`${prefix}_${k}`, x, out)
    return
  }
  out.push([labelName(prefix), plainText(v)])
}

/** One level's attributes as metadata: flattened, named, colliding names joined with `;`. */
function level(attrs: readonly KV[], skip?: ReadonlySet<string>): Map<string, string> | string {
  const leaves: [string, string][] = []
  for (const [k, v] of attrs) {
    if (k === '') return LogReject.emptyKey
    if (skip?.has(k)) continue
    if (v.k === 'l') {
      for (const [sk, x] of v.v) flatten(`${k}_${sk}`, x, leaves)
    } else leaves.push([labelName(k), plainText(v)])
  }
  const m = new Map<string, string>()
  for (const [n, v] of leaves) {
    if (v === '') continue
    const prev = m.get(n)
    m.set(n, prev === undefined ? v : `${prev};${v}`)
  }
  return m
}

/** The stream labels of an OTLP resource. */
export function otlpLabels(resource: readonly KV[]): [string, string][] | string {
  const m = new Map<string, string>()
  for (const [k, v] of resource) {
    if (k === '') return LogReject.emptyKey
    if (STREAM_LABEL_KEYS.has(k)) m.set(labelName(k), plainText(v))
  }
  if ((m.get('service_name') ?? '') === '') m.set('service_name', 'unknown_service')
  return [...m]
}

/** The resource's and scope's metadata (more specific wins), merged with a record's. */
function mergeLevels(...levels: Map<string, string>[]): [string, string][] {
  const m = new Map<string, string>()
  for (const l of levels) for (const [n, v] of l) m.set(n, v)
  return [...m]
}

interface OtlpRecord {
  time: [number, number]
  observed: [number, number]
  severity: number
  severityText: string
  body: AnyV
  attrs: KV[]
  flags: number
  traceId: Uint8Array
  spanId: Uint8Array
}

function addOtlp(c: LogCollector, stream: number, base: Map<string, string>[], rec: OtlpRecord): void {
  const own = level(rec.attrs)
  if (typeof own === 'string') return c.reject(own)
  const hasTime = rec.time[0] !== 0 || rec.time[1] !== 0
  const hasObserved = rec.observed[0] !== 0 || rec.observed[1] !== 0
  const ts = hasTime ? rec.time : hasObserved ? rec.observed : null
  if (ts !== null && ts[1] >= 0x80000000) return c.reject(LogReject.badTime)
  if (rec.observed[1] >= 0x80000000) return c.reject(LogReject.badTime)
  c.add(stream, {
    ts,
    observed: rec.observed,
    traceId: rec.traceId.length === 16 && zero(rec.traceId) ? new Uint8Array(0) : rec.traceId,
    spanId: rec.spanId.length === 8 && zero(rec.spanId) ? new Uint8Array(0) : rec.spanId,
    flags: rec.flags,
    severity: rec.severity,
    severityText: rec.severityText,
    line: rec.body.k === 'n' ? '' : plainText(rec.body),
    metadata: mergeLevels(...base, own),
  })
}

/** A resource: its stream (or the reason its records are refused) and its metadata level. */
function otlpResource(c: LogCollector, attrs: KV[]): { stream: number | string; meta: Map<string, string> | string } {
  const labels = otlpLabels(attrs)
  if (typeof labels === 'string') return { stream: labels, meta: labels }
  return { stream: c.stream(labels, resourceRoute(attrs)), meta: level(attrs, STREAM_LABEL_KEYS) }
}

// ───────────────────────────── OTLP protobuf ─────────────────────────────
//
//   ExportLogsServiceRequest { repeated ResourceLogs resource_logs = 1; }
//   ResourceLogs { Resource resource = 1; repeated ScopeLogs scope_logs = 2; }
//   ScopeLogs    { InstrumentationScope scope = 1; repeated LogRecord log_records = 2; }
//   LogRecord    { fixed64 time_unix_nano = 1; SeverityNumber severity_number = 2;
//                  string severity_text = 3; AnyValue body = 5; repeated KeyValue attributes = 6;
//                  uint32 dropped_attributes_count = 7; fixed32 flags = 8; bytes trace_id = 9;
//                  bytes span_id = 10; fixed64 observed_time_unix_nano = 11; string event_name = 12; }

export function decodeLogsProto(body: Uint8Array, c: LogCollector): void {
  const r = new PbReader(body)
  while (r.pos < r.end) {
    const tag = r.uint32()
    if (tag === 0x0a) resourceLogs(r, c)
    else r.skip(tag & 7)
  }
  c.seal()
}

function resourceLogs(r: PbReader, c: LogCollector): void {
  const end = r.len()
  const scopes: number[] = []
  const attrs: KV[] = []
  while (r.pos < end) {
    const tag = r.uint32()
    if (tag === 0x0a) {
      const rend = r.len()
      while (r.pos < rend) {
        const t = r.uint32()
        if (t === 0x0a) attrs.push(pbKeyValue(r))
        else r.skip(t & 7)
      }
      r.done(rend)
    } else if (tag === 0x12) {
      scopes.push(r.pos)
      r.pos = r.len()
    } else r.skip(tag & 7)
  }
  r.done(end)
  const res = otlpResource(c, attrs)
  for (const at of scopes) {
    r.pos = at
    const send = r.len()
    const records: number[] = []
    const sattrs: KV[] = []
    while (r.pos < send) {
      const t = r.uint32()
      if (t === 0x0a) {
        const scend = r.len()
        while (r.pos < scend) {
          const st = r.uint32()
          if (st === 0x1a) sattrs.push(pbKeyValue(r))
          else r.skip(st & 7)
        }
        r.done(scend)
      } else if (t === 0x12) {
        records.push(r.pos)
        r.pos = r.len()
      } else r.skip(t & 7)
    }
    r.done(send)
    const scope = level(sattrs)
    const why = typeof res.stream === 'string' ? res.stream : typeof res.meta === 'string' ? res.meta : typeof scope === 'string' ? scope : null
    if (why !== null) {
      c.reject(why, records.length)
      continue
    }
    for (const p of records) {
      r.pos = p
      addOtlp(c, res.stream as number, [res.meta as Map<string, string>, scope as Map<string, string>], pbRecord(r))
    }
  }
  r.pos = end
}

function pbRecord(r: PbReader): OtlpRecord {
  const end = r.len()
  const x: OtlpRecord = { time: [0, 0], observed: [0, 0], severity: 0, severityText: '', body: { k: 'n' }, attrs: [], flags: 0, traceId: new Uint8Array(0), spanId: new Uint8Array(0) }
  while (r.pos < end) {
    const tag = r.uint32()
    switch (tag) {
      case 0x09:
        r.fixed64()
        x.time = [r.lo, r.hi]
        break
      case 0x10:
        r.varint64()
        x.severity = r.hi === 0 && r.lo <= 0x7fffffff ? r.lo : -1
        break
      case 0x1a:
        x.severityText = pbString(r)
        break
      case 0x2a:
        x.body = pbAnyValue(r, 0)
        break
      case 0x32:
        x.attrs.push(pbKeyValue(r))
        break
      case 0x45:
        x.flags = pbFixed32(r)
        break
      case 0x4a:
        x.traceId = pbBytes(r)
        break
      case 0x52:
        x.spanId = pbBytes(r)
        break
      case 0x59:
        r.fixed64()
        x.observed = [r.lo, r.hi]
        break
      default:
        r.skip(tag & 7)
    }
  }
  r.done(end)
  return x
}

// ─────────────────────────────── OTLP JSON ───────────────────────────────

const SEVERITIES = (() => {
  const names = ['UNSPECIFIED', 'TRACE', 'TRACE2', 'TRACE3', 'TRACE4', 'DEBUG', 'DEBUG2', 'DEBUG3', 'DEBUG4', 'INFO', 'INFO2', 'INFO3', 'INFO4', 'WARN', 'WARN2', 'WARN3', 'WARN4', 'ERROR', 'ERROR2', 'ERROR3', 'ERROR4', 'FATAL', 'FATAL2', 'FATAL3', 'FATAL4']
  return names.map((n) => `SEVERITY_NUMBER_${n}`)
})()

function jsonTime(v: unknown, what: string): [number, number] {
  const n = jsonInt(v, what) ?? 0n
  if (n < 0n) bad(`${what} is negative`)
  return nsHalves(n) ?? [0, 0x80000000]
}

export function decodeLogsJson(body: Uint8Array, c: LogCollector): void {
  const root = parseJson(body, 'OTLP JSON')
  for (const rlRaw of list(root.resourceLogs, 'resourceLogs')) {
    const rl = object(rlRaw, 'resourceLogs[]')
    const res = otlpResource(c, jsonAttrs(object(rl.resource, 'resource').attributes))
    for (const slRaw of list(rl.scopeLogs, 'scopeLogs')) {
      const sl = object(slRaw, 'scopeLogs[]')
      const scope = level(jsonAttrs(object(sl.scope, 'scope').attributes))
      const records = list(sl.logRecords, 'logRecords')
      const why = typeof res.stream === 'string' ? res.stream : typeof res.meta === 'string' ? res.meta : typeof scope === 'string' ? scope : null
      if (why !== null) {
        c.reject(why, records.length)
        continue
      }
      for (const raw of records) {
        const x = object(raw, 'logRecords[]')
        const sev = x.severityNumber
        addOtlp(c, res.stream as number, [res.meta as Map<string, string>, scope as Map<string, string>], {
          time: jsonTime(x.timeUnixNano, 'timeUnixNano'),
          observed: jsonTime(x.observedTimeUnixNano, 'observedTimeUnixNano'),
          severity: typeof sev === 'string' ? SEVERITIES.indexOf(sev) : sev === undefined || sev === null ? 0 : typeof sev === 'number' && Number.isInteger(sev) ? sev : bad('severityNumber is not an enum'),
          severityText: text(x.severityText, 'severityText'),
          body: jsonAny(x.body, 0),
          attrs: jsonAttrs(x.attributes),
          flags: jsonU32(x.flags, 'flags'),
          traceId: jsonId(x.traceId, 'traceId'),
          spanId: jsonId(x.spanId, 'spanId'),
        })
      }
    }
  }
  c.seal()
}

// ─────────────────────────────── Loki push ───────────────────────────────

/**
 * A Prometheus label set as Loki's protobuf push carries it: `{name="value", ...}`, values
 * in Go's double-quoted string syntax. Returns the pairs, or null if it does not parse.
 */
export function parseLabelSet(s: string): [string, string][] | null {
  let i = 0
  const ws = (): void => {
    while (i < s.length && (s[i] === ' ' || s[i] === '\t' || s[i] === '\n' || s[i] === '\r')) i++
  }
  ws()
  if (s[i] !== '{') return null
  i++
  const out: [string, string][] = []
  ws()
  if (s[i] === '}') {
    i++
    ws()
    return i === s.length ? out : null
  }
  for (;;) {
    ws()
    const start = i
    while (i < s.length && /[A-Za-z0-9_]/.test(s[i]!)) i++
    const name = s.slice(start, i)
    if (name === '') return null
    ws()
    if (s[i] !== '=') return null
    i++
    ws()
    if (s[i] !== '"') return null
    i++
    let v = ''
    for (;;) {
      if (i >= s.length) return null
      const ch = s[i++]!
      if (ch === '"') break
      if (ch !== '\\') {
        v += ch
        continue
      }
      const e = s[i++]
      const simple: Record<string, string> = { a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', '"': '"', "'": "'" }
      if (e !== undefined && simple[e] !== undefined) v += simple[e]
      else if (e === 'x' || e === 'u' || e === 'U') {
        const n = e === 'x' ? 2 : e === 'u' ? 4 : 8
        const h = s.slice(i, i + n)
        if (h.length !== n || !/^[0-9a-fA-F]+$/.test(h)) return null
        i += n
        const cp = parseInt(h, 16)
        if (e === 'x') v += String.fromCharCode(cp)
        else if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return null
        else v += String.fromCodePoint(cp)
      } else if (e !== undefined && e >= '0' && e <= '7') {
        const o = s.slice(i - 1, i + 2)
        if (!/^[0-7]{3}$/.test(o)) return null
        i += 2
        v += String.fromCharCode(parseInt(o, 8))
      } else return null
    }
    out.push([name, v])
    ws()
    if (s[i] === ',') {
      i++
      ws()
      if (s[i] === '}') {
        i++
        break
      }
      continue
    }
    if (s[i] === '}') {
      i++
      break
    }
    return null
  }
  ws()
  return i === s.length ? out : null
}

/** Labels of a pushed stream; a repeated name is refused here (the `pairs` check also sees it). */
function lokiStream(c: LogCollector, labels: [string, string][] | null): number | string {
  if (labels === null) return LogReject.labelSyntax
  return c.stream(labels)
}

//   PushRequest   { repeated StreamAdapter streams = 1; }
//   StreamAdapter { string labels = 1; repeated EntryAdapter entries = 2; uint64 hash = 3; }
//   EntryAdapter  { google.protobuf.Timestamp timestamp = 1; string line = 2;
//                   repeated LabelPairAdapter structuredMetadata = 3; repeated LabelPairAdapter parsed = 4; }
//   Timestamp     { int64 seconds = 1; int32 nanos = 2; }
//   LabelPairAdapter { string name = 1; string value = 2; }

export function decodeLokiProto(body: Uint8Array, c: LogCollector): void {
  const r = new PbReader(body)
  while (r.pos < r.end) {
    const tag = r.uint32()
    if (tag !== 0x0a) {
      r.skip(tag & 7)
      continue
    }
    const end = r.len()
    let labels = ''
    const entries: number[] = []
    while (r.pos < end) {
      const t = r.uint32()
      if (t === 0x0a) labels = pbString(r)
      else if (t === 0x12) {
        entries.push(r.pos)
        r.pos = r.len()
      } else r.skip(t & 7)
    }
    r.done(end)
    const stream = lokiStream(c, parseLabelSet(labels))
    if (typeof stream === 'string') {
      c.reject(stream, entries.length)
      r.pos = end
      continue
    }
    for (const at of entries) {
      r.pos = at
      const eend = r.len()
      let ts: [number, number] | null = [0, 0]
      let line = ''
      const md: [string, string][] = []
      while (r.pos < eend) {
        const t = r.uint32()
        if (t === 0x0a) {
          const tend = r.len()
          let seconds = 0n
          let nanos = 0n
          while (r.pos < tend) {
            const tt = r.uint32()
            if (tt === 0x08) {
              r.varint64()
              seconds = r.int64Big()
            } else if (tt === 0x10) {
              r.varint64()
              nanos = BigInt.asIntN(32, r.int64Big())
            } else r.skip(tt & 7)
          }
          r.done(tend)
          ts = nanos < 0n || nanos > 999_999_999n ? null : nsHalves(seconds * 1_000_000_000n + nanos)
        } else if (t === 0x12) line = pbString(r)
        else if (t === 0x1a) {
          const mend = r.len()
          let n = ''
          let v = ''
          while (r.pos < mend) {
            const mt = r.uint32()
            if (mt === 0x0a) n = pbString(r)
            else if (mt === 0x12) v = pbString(r)
            else r.skip(mt & 7)
          }
          r.done(mend)
          md.push([n, v])
        } else r.skip(t & 7)
      }
      r.done(eend)
      if (ts === null) {
        c.reject(LogReject.badTime)
        continue
      }
      c.add(stream, { ts, observed: [0, 0], traceId: new Uint8Array(0), spanId: new Uint8Array(0), flags: 0, severity: 0, severityText: '', line, metadata: md })
    }
    r.pos = end
  }
  c.seal()
}

const malformed = (what: string): never => {
  throw badRequest(`malformed Loki push JSON: ${what}`)
}

/** `{"streams":[{"stream":{...},"values":[["<ns>","<line>"(, {metadata})], ...]}]}` */
export function decodeLokiJson(body: Uint8Array, c: LogCollector): void {
  const root = parseJson(body, 'Loki push JSON')
  const streams = root.streams
  if (streams !== undefined && streams !== null && !Array.isArray(streams)) malformed('streams is not an array')
  for (const sRaw of (streams as unknown[] | undefined) ?? []) {
    if (typeof sRaw !== 'object' || sRaw === null || Array.isArray(sRaw)) malformed('a stream is not an object')
    const s = sRaw as Record<string, unknown>
    const labelsRaw = s.stream ?? {}
    if (typeof labelsRaw !== 'object' || labelsRaw === null || Array.isArray(labelsRaw)) malformed('stream is not an object')
    const labels: [string, string][] = []
    for (const [k, v] of Object.entries(labelsRaw as Record<string, unknown>)) {
      if (typeof v !== 'string') malformed(`label ${JSON.stringify(k)} is not a string`)
      labels.push([k, v as string])
    }
    const values = s.values ?? []
    if (!Array.isArray(values)) malformed('values is not an array')
    const stream = lokiStream(c, labels)
    if (typeof stream === 'string') {
      c.reject(stream, (values as unknown[]).length)
      continue
    }
    for (const e of values as unknown[]) {
      if (!Array.isArray(e) || e.length < 2 || e.length > 3) malformed('an entry is not [timestamp, line] or [timestamp, line, metadata]')
      const [tsRaw, line, mdRaw] = e as unknown[]
      if (typeof line !== 'string') malformed('a line is not a string')
      const md: [string, string][] = []
      if (mdRaw !== undefined && mdRaw !== null) {
        if (typeof mdRaw !== 'object' || Array.isArray(mdRaw)) malformed('structured metadata is not an object')
        for (const [k, v] of Object.entries(mdRaw as Record<string, unknown>)) {
          if (typeof v !== 'string') malformed(`structured metadata ${JSON.stringify(k)} is not a string`)
          md.push([k, v as string])
        }
      }
      const ts = typeof tsRaw === 'string' && /^\d{1,19}$/.test(tsRaw) ? nsHalves(BigInt(tsRaw)) : null
      if (ts === null) {
        c.reject(LogReject.badTime)
        continue
      }
      c.add(stream, { ts, observed: [0, 0], traceId: new Uint8Array(0), spanId: new Uint8Array(0), flags: 0, severity: 0, severityText: '', line: line as string, metadata: md })
    }
  }
  c.seal()
}
