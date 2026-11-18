import type { Collector } from './batch'
import { badRequest } from './errors'
import { PbReader, utf8String } from './pb'

/**
 * OTLP metrics → Prometheus-shaped samples, following the OpenTelemetry → Prometheus
 * compatibility specification at a basic level:
 *
 *  - Gauge                         → one sample per point
 *  - Sum, cumulative, monotonic    → counter: name gets `_total`
 *  - Sum, cumulative, not monotonic→ gauge
 *  - Sum, delta or unspecified     → rejected (reported in partial_success)
 *  - Histogram, ExponentialHistogram, Summary → rejected (reported in partial_success)
 *  - metric name sanitised, unit appended as a suffix
 *  - resource `service.name` (with `service.namespace/` in front if set) → `job`,
 *    `service.instance.id` → `instance`; every other resource attribute and every point
 *    attribute becomes a label with a sanitised name (point attributes win a clash)
 *  - a point flagged NO_RECORDED_VALUE becomes a Prometheus staleness marker
 *
 * The protobuf and JSON front-ends below both feed `OtlpMapper`, so the mapping exists once.
 */

type Attr = readonly [key: string, value: string]

const UNIT: Record<string, string> = {
  d: 'days', h: 'hours', min: 'minutes', s: 'seconds', ms: 'milliseconds', us: 'microseconds', ns: 'nanoseconds',
  By: 'bytes', KiBy: 'kibibytes', MiBy: 'mebibytes', GiBy: 'gibibytes', TiBy: 'tebibytes',
  KBy: 'kilobytes', MBy: 'megabytes', GBy: 'gigabytes', TBy: 'terabytes',
  m: 'meters', V: 'volts', A: 'amperes', J: 'joules', W: 'watts', g: 'grams',
  Cel: 'celsius', Hz: 'hertz', '%': 'percent',
}
const PER: Record<string, string> = { s: 'second', m: 'minute', min: 'minute', h: 'hour', d: 'day', w: 'week', mo: 'month', y: 'year' }

/** `[^a-zA-Z0-9_]` (and `:` unless allowed) → `_`, runs of `_` collapsed. */
function sanitise(s: string, allowColon: boolean): string {
  let out = ''
  let lastUnderscore = false
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    const ok = (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || (allowColon && c === 58)
    if (ok) {
      out += s[i]
      lastUnderscore = false
    } else if (!lastUnderscore) {
      out += '_'
      lastUnderscore = true
    }
  }
  return out
}

const labelNames = new Map<string, string>()

/** Attribute key → label name. Keys repeat on every point, so the result is remembered. */
export function labelName(key: string): string {
  let name = labelNames.get(key)
  if (name === undefined) {
    const s = sanitise(key, false)
    name = s.length > 0 && s.charCodeAt(0) >= 48 && s.charCodeAt(0) <= 57 ? `key_${s}` : s
    if (labelNames.size >= 4096) labelNames.clear()
    labelNames.set(key, name)
  }
  return name
}

function unitSuffix(unit: string, counter: boolean): string {
  const u = unit.replace(/\{[^}]*\}/g, '').trim()
  if (u === '') return ''
  if (u === '1') return counter ? '' : 'ratio'
  const slash = u.indexOf('/')
  if (slash >= 0) {
    const a = u.slice(0, slash).trim()
    const b = u.slice(slash + 1).trim()
    if (b === '') return sanitise(UNIT[a] ?? a, false)
    return sanitise(`${a === '' ? '' : `${UNIT[a] ?? a}_`}per_${PER[b] ?? UNIT[b] ?? b}`, false)
  }
  return sanitise(UNIT[u] ?? u, false)
}

export function metricName(name: string, unit: string, counter: boolean): string {
  let n = sanitise(name, true)
  if (n.length > 0 && n.charCodeAt(0) >= 48 && n.charCodeAt(0) <= 57) n = `_${n}`
  if (counter && n.endsWith('_total')) n = n.slice(0, -6)
  n = n.replace(/(?<=.)_+$/, '')
  const suffix = unitSuffix(unit, counter).replace(/^_+|_+$/g, '')
  if (suffix !== '' && !n.endsWith(`_${suffix}`)) n = `${n}_${suffix}`
  if (counter) n = `${n}_total`
  return n
}

const CUMULATIVE = 2
const FLAG_NO_RECORDED_VALUE = 1

const enc = new TextEncoder()

/**
 * Label bytes are laid out in one scratch buffer, so that a point costs only its own
 * attributes:   [ resource labels … ][ __name__ = metric ][ this point's attributes … ]
 * The first part is written once per resource, the second once per metric.
 */
export class OtlpMapper {
  private buf = new Uint8Array(1 << 14)
  private offs = new Int32Array(4 * 64)
  private p = 0
  /** Resource labels: how many, where their bytes end, and which slot each name is in. */
  private nResource = 0
  private resourceEnd = 0
  private resourceSlot = new Map<string, number>()
  private metricEnd = 0
  // Scratch for one point.
  private ownNames: string[] = []
  private ownValues: string[] = []
  private saved: number[] = []

  constructor(private readonly c: Collector) {}

  /** Append a string's UTF-8 bytes at `p`; ASCII is written directly. */
  private write(s: string): void {
    const need = this.p + 3 * s.length
    if (need > this.buf.length) {
      const grown = new Uint8Array(need * 2)
      grown.set(this.buf.subarray(0, this.p))
      this.buf = grown
    }
    const buf = this.buf
    let p = this.p
    for (let i = 0; i < s.length; i++) {
      const ch = s.charCodeAt(i)
      if (ch >= 128) {
        p = this.p + enc.encodeInto(s, buf.subarray(this.p)).written
        break
      }
      buf[p++] = ch
    }
    this.p = p
  }

  private label(slot: number, name: string, value: string): void {
    if (4 * slot + 4 > this.offs.length) {
      const grown = new Int32Array(this.offs.length * 2)
      grown.set(this.offs)
      this.offs = grown
    }
    const o = 4 * slot
    this.offs[o] = this.p
    this.write(name)
    this.offs[o + 1] = this.offs[o + 2] = this.p
    this.write(value)
    this.offs[o + 3] = this.p
  }

  resourceAttrs(attrs: Attr[]): void {
    const m = new Map<string, string>()
    let service = ''
    let namespace = ''
    for (const [k, v] of attrs) {
      if (k === 'service.name') service = v
      else if (k === 'service.namespace') namespace = v
      else if (k === 'service.instance.id') m.set('instance', v)
      else {
        const name = attrLabel(k)
        m.set(name, join(m.get(name), v))
      }
    }
    if (service !== '') m.set('job', namespace !== '' ? `${namespace}/${service}` : service)
    this.p = 0
    this.resourceSlot.clear()
    let n = 0
    for (const [k, v] of m) {
      this.resourceSlot.set(k, n)
      this.label(n++, k, v)
    }
    this.nResource = n
    this.resourceEnd = this.metricEnd = this.p
  }

  /** Start a gauge or sum. Returns a rejection reason if its points cannot be stored. */
  metric(name: string, unit: string, sum: boolean, temporality: number, monotonic: boolean): string | null {
    if (sum && temporality !== CUMULATIVE) {
      return temporality === 1 ? 'delta temporality sums are not supported' : 'sum without an aggregation temporality'
    }
    this.p = this.resourceEnd
    this.label(this.nResource, '__name__', metricName(name, unit, sum && monotonic))
    this.metricEnd = this.p
    return null
  }

  rejectPoints(reason: string, n: number): void {
    this.c.reject(reason, n)
  }

  /** `value` is a number, or 8 IEEE bytes at `src[off..]`, or absent. */
  point(attrs: Attr[], tsMs: number, flags: number, value: number | undefined, src?: Uint8Array, off?: number): void {
    this.p = this.metricEnd
    const names = this.ownNames
    const values = this.ownValues
    const saved = this.saved
    names.length = values.length = saved.length = 0
    const first = this.nResource + 1
    for (let a = 0; a < attrs.length; a++) {
      const name = attrLabel(attrs[a]![0])
      let v = attrs[a]![1]
      const rs = this.resourceSlot.get(name)
      let k = names.indexOf(name)
      if (k < 0) {
        k = names.length
        names.push(name)
        values.push(v)
        if (rs !== undefined) saved.push(rs, this.offs[4 * rs + 2]!, this.offs[4 * rs + 3]!)
      } else {
        // Two attributes of this point that sanitise to one name are joined with `;`.
        v = values[k] = join(values[k], v)
      }
      if (rs !== undefined) {
        // A point attribute replaces the resource attribute of the same name, for this
        // point only: its value goes into the resource label's slot (restored below), and
        // its own slot stays empty, which the collector drops.
        const o = 4 * rs
        this.offs[o + 2] = this.p
        this.write(v)
        this.offs[o + 3] = this.p
        this.label(first + k, '', '')
      } else this.label(first + k, name, v)
    }
    const n = first + names.length
    const series = this.c.addSeries(this.buf, this.offs, n)
    for (let i = 0; i < saved.length; i += 3) {
      const o = 4 * saved[i]!
      this.offs[o + 2] = saved[i + 1]!
      this.offs[o + 3] = saved[i + 2]!
    }
    if (series < 0) return this.c.reject(-series, 1)
    if (flags & FLAG_NO_RECORDED_VALUE) this.c.addStale(series, tsMs)
    else if (src !== undefined) this.c.addSampleBytes(series, tsMs, src, off!)
    else if (value !== undefined) this.c.addSampleNumber(series, tsMs, value)
    else this.c.reject('data point without a value', 1)
  }
}

/**
 * The label for an attribute. `job` and `instance` are reserved for the resource's
 * `service.*` attributes (they are the routing key, contracts/BATCH.md "Routing"): any
 * other attribute that would land on those names is renamed `exported_job` /
 * `exported_instance`, as Prometheus does for a scraped label that clashes with a target
 * label. So a data point can never change which shard its sender's rows go to.
 */
function attrLabel(key: string): string {
  const name = labelName(key)
  return name === 'job' ? 'exported_job' : name === 'instance' ? 'exported_instance' : name
}

const join = (prev: string | undefined, value: string): string => (prev === undefined || prev === '' ? value : value === '' ? prev : `${prev};${value}`)

function attrString(v: unknown): string {
  return typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v)
}

// ───────────────────────────── protobuf ─────────────────────────────
//
//   ExportMetricsServiceRequest { repeated ResourceMetrics resource_metrics = 1; }
//   ResourceMetrics { Resource resource = 1; repeated ScopeMetrics scope_metrics = 2; }
//   Resource        { repeated KeyValue attributes = 1; }
//   ScopeMetrics    { repeated Metric metrics = 2; }
//   Metric          { string name = 1; string unit = 3; Gauge gauge = 5; Sum sum = 7;
//                     Histogram histogram = 9; ExponentialHistogram exponential_histogram = 10;
//                     Summary summary = 11; }
//   Gauge           { repeated NumberDataPoint data_points = 1; }
//   Sum             { repeated NumberDataPoint data_points = 1;
//                     AggregationTemporality aggregation_temporality = 2; bool is_monotonic = 3; }
//   NumberDataPoint { fixed64 time_unix_nano = 3; double as_double = 4; sfixed64 as_int = 6;
//                     repeated KeyValue attributes = 7; uint32 flags = 8; }
//   KeyValue        { string key = 1; AnyValue value = 2; }
//   AnyValue        { string_value = 1; bool_value = 2; int_value = 3; double_value = 4;
//                     ArrayValue array_value = 5; KeyValueList kvlist_value = 6; bytes_value = 7; }
//
// A message's fields may arrive in any order, so each level is scanned first for its
// scalar fields and the positions of its children, and the children are read afterwards.

export function decodeOtlpProto(body: Uint8Array, c: Collector): void {
  const r = new PbReader(body)
  const m = new OtlpMapper(c)
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength)
  while (r.pos < r.end) {
    const tag = r.uint32()
    if (tag === 0x0a) resourceMetrics(r, m, view)
    else r.skip(tag & 7)
  }
}

function resourceMetrics(r: PbReader, m: OtlpMapper, view: DataView): void {
  const end = r.len()
  const scopes: number[] = []
  let attrs: Attr[] = []
  while (r.pos < end) {
    const tag = r.uint32()
    if (tag === 0x0a) {
      const rend = r.len()
      while (r.pos < rend) {
        const t = r.uint32()
        if (t === 0x0a) attrs.push(keyValue(r, view))
        else r.skip(t & 7)
      }
      r.done(rend)
    } else if (tag === 0x12) {
      scopes.push(r.pos)
      r.pos = r.len()
    } else r.skip(tag & 7)
  }
  r.done(end)
  m.resourceAttrs(attrs)
  for (const at of scopes) {
    r.pos = at
    const send = r.len()
    while (r.pos < send) {
      const t = r.uint32()
      if (t === 0x12) metric(r, m, view)
      else r.skip(t & 7)
    }
    r.done(send)
  }
  r.pos = end
}

function metric(r: PbReader, m: OtlpMapper, view: DataView): void {
  const end = r.len()
  let name = ''
  let unit = ''
  // [field number, position of the length prefix] of each data message.
  const data: number[] = []
  while (r.pos < end) {
    const tag = r.uint32()
    if (tag === 0x0a || tag === 0x1a) {
      const e = r.len()
      const s = utf8String(r.buf, r.pos, e)
      r.pos = e
      if (tag === 0x0a) name = s
      else unit = s
    } else if (tag === 0x2a || tag === 0x3a || tag === 0x4a || tag === 0x52 || tag === 0x5a) {
      data.push(tag >>> 3, r.pos)
      r.pos = r.len()
    } else r.skip(tag & 7)
  }
  r.done(end)

  for (let i = 0; i < data.length; i += 2) {
    const field = data[i]!
    r.pos = data[i + 1]!
    const dend = r.len()
    const points: number[] = []
    let temporality = 0
    let monotonic = false
    while (r.pos < dend) {
      const t = r.uint32()
      if (t === 0x0a) {
        points.push(r.pos)
        r.pos = r.len()
      } else if (t === 0x10 && (field === 7 || field === 9 || field === 10)) temporality = r.uint32()
      else if (t === 0x18 && field === 7) monotonic = r.uint32() !== 0
      else r.skip(t & 7)
    }
    r.done(dend)
    if (field === 9) m.rejectPoints('histograms are not supported', points.length)
    else if (field === 10) m.rejectPoints('exponential histograms are not supported', points.length)
    else if (field === 11) m.rejectPoints('summaries are not supported', points.length)
    else {
      const reason = m.metric(name, unit, field === 7, temporality, monotonic)
      if (reason !== null) m.rejectPoints(reason, points.length)
      else for (const at of points) numberDataPoint(r, m, view, at)
    }
  }
  r.pos = end
}

function numberDataPoint(r: PbReader, m: OtlpMapper, view: DataView, at: number): void {
  r.pos = at
  const end = r.len()
  const attrs: Attr[] = []
  let tsMs = 0
  let flags = 0
  let doubleAt = -1
  let int: number | undefined
  while (r.pos < end) {
    const tag = r.uint32()
    switch (tag) {
      case 0x19: // time_unix_nano, fixed64
        r.fixed64()
        // floor(nanos / 1e6) exactly: 2^32 = 4294 * 1e6 + 967296.
        tsMs = r.hi * 4294 + Math.floor((r.hi * 967296 + r.lo) / 1e6)
        break
      case 0x21: // as_double
        doubleAt = r.fixed64At()
        int = undefined
        break
      case 0x31: // as_int, sfixed64
        r.fixed64()
        int = r.int64()
        doubleAt = -1
        break
      case 0x3a:
        attrs.push(keyValue(r, view))
        break
      case 0x40:
        flags = r.uint32()
        break
      default:
        r.skip(tag & 7)
    }
  }
  r.done(end)
  if (doubleAt >= 0) m.point(attrs, tsMs, flags, undefined, r.buf, doubleAt)
  else m.point(attrs, tsMs, flags, int)
}

function keyValue(r: PbReader, view: DataView): Attr {
  const end = r.len()
  let key = ''
  let value: unknown
  while (r.pos < end) {
    const tag = r.uint32()
    if (tag === 0x0a) {
      const e = r.len()
      key = utf8String(r.buf, r.pos, e)
      r.pos = e
    } else if (tag === 0x12) value = anyValue(r, view, 0)
    else r.skip(tag & 7)
  }
  r.done(end)
  return [key, attrString(value)]
}

function anyValue(r: PbReader, view: DataView, depth: number): unknown {
  if (depth > 16) throw badRequest('malformed OTLP: attribute value nested too deeply')
  const end = r.len()
  let value: unknown
  while (r.pos < end) {
    const tag = r.uint32()
    switch (tag) {
      case 0x0a: {
        const e = r.len()
        value = utf8String(r.buf, r.pos, e)
        r.pos = e
        break
      }
      case 0x10:
        value = r.uint32() !== 0
        break
      case 0x18: {
        r.varint64()
        const n = r.int64()
        value = Number.isSafeInteger(n) ? n : r.int64Big().toString()
        break
      }
      case 0x21:
        value = view.getFloat64(r.fixed64At(), true)
        break
      case 0x2a: {
        const aend = r.len()
        const items: unknown[] = []
        while (r.pos < aend) {
          const t = r.uint32()
          if (t === 0x0a) items.push(anyValue(r, view, depth + 1) ?? null)
          else r.skip(t & 7)
        }
        r.done(aend)
        value = items
        break
      }
      case 0x32: {
        const kend = r.len()
        const obj: Record<string, unknown> = {}
        while (r.pos < kend) {
          const t = r.uint32()
          if (t === 0x0a) {
            const kvend = r.len()
            let k = ''
            let v: unknown = null
            while (r.pos < kvend) {
              const kt = r.uint32()
              if (kt === 0x0a) {
                const e = r.len()
                k = utf8String(r.buf, r.pos, e)
                r.pos = e
              } else if (kt === 0x12) v = anyValue(r, view, depth + 1) ?? null
              else r.skip(kt & 7)
            }
            r.done(kvend)
            obj[k] = v
          } else r.skip(t & 7)
        }
        r.done(kend)
        value = obj
        break
      }
      case 0x3a: {
        const e = r.len()
        value = base64(r.buf.subarray(r.pos, e))
        r.pos = e
        break
      }
      default:
        r.skip(tag & 7)
    }
  }
  r.done(end)
  return value
}

function base64(b: Uint8Array): string {
  let s = ''
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!)
  return btoa(s)
}

// ─────────────────────────────── JSON ───────────────────────────────
// The OTLP/JSON mapping: lowerCamelCase field names, 64-bit integers as decimal strings
// (numbers are accepted too), enums as integers (names are accepted too), unknown fields
// ignored.

const bad = (what: string): never => {
  throw badRequest(`malformed OTLP JSON: ${what}`)
}

function list(v: unknown, what: string): unknown[] {
  if (v === undefined || v === null) return []
  return Array.isArray(v) ? v : bad(`${what} is not an array`)
}

function object(v: unknown, what: string): Record<string, unknown> {
  if (v === undefined || v === null) return {}
  return typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : bad(`${what} is not an object`)
}

function text(v: unknown, what: string): string {
  if (v === undefined || v === null) return ''
  return typeof v === 'string' ? v : bad(`${what} is not a string`)
}

export function decodeOtlpJson(body: Uint8Array, c: Collector): void {
  let root: unknown
  try {
    root = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body))
  } catch {
    throw badRequest('malformed OTLP JSON: body does not parse')
  }
  if (typeof root !== 'object' || root === null || Array.isArray(root)) bad('body is not an object')
  const m = new OtlpMapper(c)
  for (const rmRaw of list((root as Record<string, unknown>).resourceMetrics, 'resourceMetrics')) {
    const rm = object(rmRaw, 'resourceMetrics[]')
    m.resourceAttrs(jsonAttrs(object(rm.resource, 'resource').attributes))
    for (const smRaw of list(rm.scopeMetrics, 'scopeMetrics')) {
      for (const metricRaw of list(object(smRaw, 'scopeMetrics[]').metrics, 'metrics')) {
        const metric = object(metricRaw, 'metrics[]')
        const name = text(metric.name, 'metric name')
        const unit = text(metric.unit, 'metric unit')
        if (metric.histogram != null) m.rejectPoints('histograms are not supported', list(object(metric.histogram, 'histogram').dataPoints, 'dataPoints').length)
        if (metric.exponentialHistogram != null) m.rejectPoints('exponential histograms are not supported', list(object(metric.exponentialHistogram, 'exponentialHistogram').dataPoints, 'dataPoints').length)
        if (metric.summary != null) m.rejectPoints('summaries are not supported', list(object(metric.summary, 'summary').dataPoints, 'dataPoints').length)
        for (const sum of [false, true]) {
          const raw = sum ? metric.sum : metric.gauge
          if (raw == null) continue
          const data = object(raw, sum ? 'sum' : 'gauge')
          const points = list(data.dataPoints, 'dataPoints')
          const reason = m.metric(name, unit, sum, temporality(data.aggregationTemporality), data.isMonotonic === true)
          if (reason !== null) m.rejectPoints(reason, points.length)
          else for (const p of points) jsonPoint(m, object(p, 'dataPoints[]'))
        }
      }
    }
  }
}

function temporality(v: unknown): number {
  if (v === undefined || v === null) return 0
  if (typeof v === 'number') return v
  if (v === 'AGGREGATION_TEMPORALITY_CUMULATIVE') return 2
  if (v === 'AGGREGATION_TEMPORALITY_DELTA') return 1
  if (v === 'AGGREGATION_TEMPORALITY_UNSPECIFIED') return 0
  return bad('unknown aggregationTemporality')
}

function jsonPoint(m: OtlpMapper, p: Record<string, unknown>): void {
  const flags = typeof p.flags === 'number' ? p.flags : 0
  let value: number | undefined
  if (p.asDouble !== undefined && p.asDouble !== null) value = jsonNumber(p.asDouble, 'asDouble')
  else if (p.asInt !== undefined && p.asInt !== null) value = jsonNumber(p.asInt, 'asInt')
  m.point(jsonAttrs(p.attributes), nanosToMs(p.timeUnixNano), flags, value)
}

function jsonNumber(v: unknown, what: string): number {
  if (typeof v === 'number') return v
  if (typeof v === 'string' && v.trim() !== '') {
    if (v === 'NaN') return NaN
    if (v === 'Infinity') return Infinity
    if (v === '-Infinity') return -Infinity
    const n = Number(v)
    if (!Number.isNaN(n)) return n
  }
  return bad(`${what} is not a number`)
}

/** `timeUnixNano` (decimal string, or a number) → whole milliseconds. */
function nanosToMs(v: unknown): number {
  if (v === undefined || v === null) return 0
  if (typeof v === 'string' && /^\d{1,20}$/.test(v)) return v.length <= 6 ? 0 : Number(v.slice(0, -6))
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return Math.floor(v / 1e6)
  return bad('timeUnixNano is not an unsigned integer')
}

function jsonAttrs(v: unknown): Attr[] {
  const out: Attr[] = []
  for (const kvRaw of list(v, 'attributes')) {
    const kv = object(kvRaw, 'attributes[]')
    out.push([text(kv.key, 'attribute key'), attrString(jsonAny(kv.value, 0))])
  }
  return out
}

function jsonAny(raw: unknown, depth: number): unknown {
  if (depth > 16) bad('attribute value nested too deeply')
  if (raw === undefined || raw === null) return undefined
  const v = object(raw, 'attribute value')
  if (v.stringValue !== undefined) return text(v.stringValue, 'stringValue')
  if (v.boolValue !== undefined) return v.boolValue === true
  if (v.intValue !== undefined) {
    const n = jsonNumber(v.intValue, 'intValue')
    return Number.isSafeInteger(n) ? n : String(v.intValue)
  }
  if (v.doubleValue !== undefined) return jsonNumber(v.doubleValue, 'doubleValue')
  if (v.arrayValue !== undefined) return list(object(v.arrayValue, 'arrayValue').values, 'arrayValue.values').map((x) => jsonAny(x, depth + 1) ?? null)
  if (v.kvlistValue !== undefined) {
    const obj: Record<string, unknown> = {}
    for (const kvRaw of list(object(v.kvlistValue, 'kvlistValue').values, 'kvlistValue.values')) {
      const kv = object(kvRaw, 'kvlistValue.values[]')
      obj[text(kv.key, 'attribute key')] = jsonAny(kv.value, depth + 1) ?? null
    }
    return obj
  }
  if (v.bytesValue !== undefined) return text(v.bytesValue, 'bytesValue')
  return undefined
}

// ───────────────────────────── responses ─────────────────────────────

function varint(n: number): number[] {
  const out: number[] = []
  while (n >= 128) {
    out.push((n % 128) | 128)
    n = Math.floor(n / 128)
  }
  out.push(n)
  return out
}

function lenField(tag: number, payload: Uint8Array | number[]): number[] {
  return [tag, ...varint(payload.length), ...payload]
}

/** ExportMetricsServiceResponse { ExportMetricsPartialSuccess partial_success = 1 { int64 rejected_data_points = 1; string error_message = 2; } } */
export function exportResponse(json: boolean, rejected: number, message: string): Uint8Array<ArrayBuffer> {
  if (json) {
    const body = rejected > 0 ? { partialSuccess: { rejectedDataPoints: String(rejected), errorMessage: message } } : {}
    return enc.encode(JSON.stringify(body))
  }
  if (rejected === 0) return new Uint8Array(0)
  const partial = [0x08, ...varint(rejected), ...lenField(0x12, enc.encode(message))]
  return new Uint8Array(lenField(0x0a, partial))
}

/** google.rpc.Status { int32 code = 1; string message = 2; } — the body of an OTLP error response. */
export function statusBody(json: boolean, code: number, message: string): Uint8Array<ArrayBuffer> {
  if (json) return enc.encode(JSON.stringify({ code, message }))
  return new Uint8Array([0x08, ...varint(code), ...lenField(0x12, enc.encode(message))])
}
