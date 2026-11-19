/**
 * Decode limits (contracts/BATCH.md, "Decode limits"; review M-3): what a decoder builds for
 * one item is counted before it is built, and a hostile item stops being built at the limit
 * whatever the body's size. "Cheaply" is checked on `BUILT`, which counts every key-value
 * entry and array element a decoder creates, apart from the meters: it must stay at the limit
 * when the hostile body grows. The bodies are written here byte by byte, sharing nothing
 * with src/.
 */
import { describe, expect, it } from 'vitest'
import { Collector } from '../src/batch'
import { HttpError } from '../src/errors'
import { DEFAULT_LIMITS, type Limits } from '../src/limits'
import { LogCollector, LogReject, decodeLogsJson, decodeLogsProto, decodeLokiJson, decodeLokiProto } from '../src/logs'
import { BUILT, DECODE, checkJsonTokens } from '../src/meter'
import { decodeOtlpJson, decodeOtlpProto } from '../src/otlp'
import { validUtf8 } from '../src/pb'
import { SpanCollector, SpanReject, decodeTracesJson, decodeTracesProto } from '../src/spans'
import { DEFAULT_MAP, makeKey, newTenant, postOtlp, snappyCompress, tail } from './helpers'
import { partialProto, postSignal, storedLogs, storedSpans } from './otelhelpers'

const N = DECODE.maxValues
const te = new TextEncoder()
const NS = BigInt(Date.now()) * 1_000_000n
const SERIES_TOO_LARGE = 'label set too large to fit one batch'

// ───────────────────────────── wire, by hand ─────────────────────────────

const varint = (n: number): number[] => {
  const out: number[] = []
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80)
    n = Math.floor(n / 128)
  }
  out.push(n)
  return out
}
const cat = (...xs: Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const o = new Uint8Array(xs.reduce((a, x) => a + x.length, 0))
  let p = 0
  for (const x of xs) {
    o.set(x, p)
    p += x.length
  }
  return o
}
const ld = (tag: number, b: Uint8Array): Uint8Array<ArrayBuffer> => cat(Uint8Array.from([tag, ...varint(b.length)]), b)
const str = (tag: number, s: string): Uint8Array<ArrayBuffer> => ld(tag, te.encode(s))
const rep = (unit: Uint8Array | number[], n: number): Uint8Array<ArrayBuffer> => {
  const u = Uint8Array.from(unit)
  const o = new Uint8Array(u.length * n)
  for (let i = 0; i < n; i++) o.set(u, i * u.length)
  return o
}
const fixed64 = (tag: number, v: bigint): Uint8Array<ArrayBuffer> => {
  const b = new Uint8Array(9)
  b[0] = tag
  new DataView(b.buffer).setBigUint64(1, v, true)
  return b
}
/** KeyValue { key, string value } as the body of a field. */
const kvs = (k: string, v: string): Uint8Array<ArrayBuffer> => cat(str(0x0a, k), ld(0x12, str(0x0a, v)))
/** KeyValue { key, value { array_value { n empty AnyValues } } }: 1 + n values. */
const kvArray = (k: string, n: number): Uint8Array<ArrayBuffer> => cat(str(0x0a, k), ld(0x12, ld(0x2a, rep([0x0a, 0], n))))
/** A valid span (ids, start now) with extra fields. */
function span(i: number, extra: Uint8Array = new Uint8Array(0)): Uint8Array<ArrayBuffer> {
  const tid = new Uint8Array(16)
  new DataView(tid.buffer).setUint32(12, i + 1)
  const sid = new Uint8Array(8)
  new DataView(sid.buffer).setUint32(4, i + 1)
  return cat(ld(0x0a, tid), ld(0x12, sid), fixed64(0x39, NS), extra)
}
/** ExportTraceServiceRequest / ExportLogsServiceRequest: one resource (attribute fields), one scope. */
const request = (resource: Uint8Array, scope: Uint8Array): Uint8Array<ArrayBuffer> => ld(0x0a, cat(ld(0x0a, resource), ld(0x12, scope)))
const SVC = ld(0x0a, kvs('service.name', 'svc'))
const record = (extra: Uint8Array = new Uint8Array(0)): Uint8Array<ArrayBuffer> => ld(0x12, cat(fixed64(0x09, NS), extra))
/** ExportMetricsServiceRequest: one resource, one scope, one gauge `m` with these points. */
const metricsReq = (resource: Uint8Array, points: Uint8Array[]): Uint8Array<ArrayBuffer> =>
  ld(0x0a, cat(ld(0x0a, resource), ld(0x12, ld(0x12, cat(str(0x0a, 'm'), ld(0x2a, cat(...points.map((p) => ld(0x0a, cat(fixed64(0x19, NS), fixed64(0x21, 0n), p))))))))))
/** Loki PushRequest: one stream with these entries (each: a timestamp now, then `extra`). */
const lokiReq = (labels: string, entries: Uint8Array[]): Uint8Array<ArrayBuffer> =>
  ld(0x0a, cat(str(0x0a, labels), ...entries.map((e) => ld(0x12, cat(ld(0x0a, Uint8Array.from([0x08, ...varint(Math.floor(Date.now() / 1000))])), e)))))

// ───────────────────────────── running a decoder ─────────────────────────────

type Signal = 'traces' | 'logs' | 'loki' | 'metrics'
interface Run {
  rows: number
  rejected: number
  reasons: string
  built: number
}

function run(signal: Signal, json: boolean, body: Uint8Array, limits: Limits = DEFAULT_LIMITS): Run {
  const now = Date.now()
  const before = BUILT.n
  if (signal === 'metrics') {
    const c = new Collector(limits, now, body.length)
    ;(json ? decodeOtlpJson : decodeOtlpProto)(body, c)
    return { rows: c.nRows, rejected: c.rejectedTotal, reasons: c.rejectionSummary(), built: BUILT.n - before }
  }
  const c = signal === 'traces' ? new SpanCollector(limits, now) : new LogCollector(limits, now)
  if (c instanceof SpanCollector) (json ? decodeTracesJson : decodeTracesProto)(body, c)
  else if (signal === 'logs') (json ? decodeLogsJson : decodeLogsProto)(body, c)
  else (json ? decodeLokiJson : decodeLokiProto)(body, c)
  return { rows: c.nRows, rejected: c.rejectedTotal, reasons: c.rejectionSummary(), built: BUILT.n - before }
}

function status(f: () => unknown): number | 'ok' {
  try {
    f()
    return 'ok'
  } catch (e) {
    if (e instanceof HttpError) return e.status
    throw e
  }
}

// ───────────────────────────── hostile shapes ─────────────────────────────

/**
 * Each shape is one item with `n` values (entries or elements) and, where the signal allows,
 * one valid item after it that must be stored. `n` is scaled to show that building stops at
 * the limit: the built count must be the same for 4N and 8N values.
 */
const json = (s: string): Uint8Array<ArrayBuffer> => te.encode(s)
const emptyObjects = (n: number): string => Array(n).fill('{}').join(',')
const HOSTILE: [name: string, signal: Signal, json: boolean, body: (n: number) => Uint8Array, reason: string, stored: number][] = [
  ['traces: resource of empty KeyValues', 'traces', false, (n) => request(rep([0x0a, 0], n), ld(0x12, span(0))), SpanReject.entryValues, 0],
  ['traces: span of empty attributes, then a valid span', 'traces', false, (n) => request(SVC, cat(ld(0x12, span(0, rep([0x4a, 0], n))), ld(0x12, span(1)))), SpanReject.values, 1],
  ['traces: span attribute, an array of empty values', 'traces', false, (n) => request(SVC, cat(ld(0x12, span(0, ld(0x4a, kvArray('a', n)))), ld(0x12, span(1)))), SpanReject.values, 1],
  ['traces: span attribute, a key-value list of empty entries', 'traces', false, (n) => request(SVC, cat(ld(0x12, span(0, ld(0x4a, cat(str(0x0a, 'a'), ld(0x12, ld(0x32, rep([0x0a, 0], n))))))), ld(0x12, span(1)))), SpanReject.values, 1],
  ['traces: event attributes', 'traces', false, (n) => request(SVC, cat(ld(0x12, span(0, ld(0x5a, rep([0x1a, 0], n)))), ld(0x12, span(1)))), SpanReject.values, 1],
  ['traces: scope attributes', 'traces', false, (n) => request(SVC, cat(ld(0x0a, rep([0x1a, 0], n)), ld(0x12, span(0)))), SpanReject.entryValues, 0],
  ['traces JSON: resource of empty attributes', 'traces', true, (n) => json(`{"resourceSpans":[{"resource":{"attributes":[${emptyObjects(n)}]},"scopeSpans":[{"spans":[{}]}]}]}`), SpanReject.entryValues, 0],
  ['traces JSON: span attribute, an array of empty values', 'traces', true, (n) => json(`{"resourceSpans":[{"scopeSpans":[{"spans":[{"traceId":"0102030405060708090a0b0c0d0e0f10","spanId":"0102030405060708","startTimeUnixNano":"${NS}","attributes":[{"key":"a","value":{"arrayValue":{"values":[${emptyObjects(n)}]}}}]}]}]}]}`), SpanReject.values, 0],
  ['logs: resource of empty KeyValues', 'logs', false, (n) => request(rep([0x0a, 0], n), record()), LogReject.resourceValues, 0],
  // Its first entry has an empty key, which refuses a record before anything else (as before).
  ['logs: record of empty attributes, then a valid record', 'logs', false, (n) => request(SVC, cat(record(rep([0x32, 0], n)), record())), LogReject.emptyKey, 1],
  ['logs: record body, an array of empty values', 'logs', false, (n) => request(SVC, cat(record(ld(0x2a, ld(0x2a, rep([0x0a, 0], n)))), record())), LogReject.values, 1],
  ['logs: scope attributes', 'logs', false, (n) => request(SVC, cat(ld(0x0a, rep([0x1a, 0], n)), record())), LogReject.resourceValues, 0],
  ['logs JSON: record attributes', 'logs', true, (n) => json(`{"resourceLogs":[{"scopeLogs":[{"logRecords":[{"timeUnixNano":"${NS}","attributes":[${Array(n).fill('{"key":"a"}').join(',')}]}]}]}]}`), LogReject.values, 0],
  ['Loki: entry of empty structured metadata, then a valid entry', 'loki', false, (n) => lokiReq('{job="a"}', [rep([0x1a, 0], n), str(0x12, 'ok')]), LogReject.values, 1],
  ['Loki: a label set of n pairs', 'loki', false, (n) => lokiReq(`{${Array.from({ length: n }, (_, i) => `a${i}=""`).join(',')}}`, [str(0x12, 'x')]), LogReject.labelPairs, 0],
  ['Loki JSON: entry of n metadata keys, then a valid entry', 'loki', true, (n) => json(`{"streams":[{"stream":{"job":"a"},"values":[["${NS}","x",{${Array.from({ length: n }, (_, i) => `"k${i}":""`).join(',')}}],["${NS}","ok"]]}]}`), LogReject.values, 1],
  ['metrics: resource of empty KeyValues', 'metrics', false, (n) => metricsReq(rep([0x0a, 0], n), [new Uint8Array(0)]), SERIES_TOO_LARGE, 0],
  ['metrics: point of empty attributes, then a valid point', 'metrics', false, (n) => metricsReq(SVC, [rep([0x3a, 0], n), new Uint8Array(0)]), SERIES_TOO_LARGE, 1],
  ['metrics: point attribute, an array of empty values', 'metrics', false, (n) => metricsReq(SVC, [ld(0x3a, kvArray('a', n)), new Uint8Array(0)]), SERIES_TOO_LARGE, 1],
  ['metrics JSON: point of empty attributes, then a valid point', 'metrics', true, (n) => json(`{"resourceMetrics":[{"scopeMetrics":[{"metrics":[{"name":"m","gauge":{"dataPoints":[{"timeUnixNano":"${NS}","asDouble":1,"attributes":[${emptyObjects(n)}]},{"timeUnixNano":"${NS}","asDouble":1}]}}]}]}]}`), SERIES_TOO_LARGE, 1],
]

describe('decode limits: an item with more than 65,536 values', () => {
  it('is 65,536 (contracts/BATCH.md), and the request limits have their documented defaults', () => {
    expect(N).toBe(65_536)
    expect(DEFAULT_LIMITS.maxDecompressedBytes).toBe(8 << 20)
    expect(DEFAULT_LIMITS.maxDecodedBytes).toBe(16 << 20)
    expect(DEFAULT_LIMITS.maxJsonTokens).toBe(1 << 20)
  })

  for (const [name, signal, isJson, body, reason, stored] of HOSTILE) {
    it(`${name}: refused on its own, built no further than the limit however large it is`, () => {
      // JSON shapes cost two structural characters per value: 4N of them stay under the token limit.
      const [a, b] = isJson ? [2 * N, 4 * N] : [4 * N, 8 * N]
      const small = run(signal, isJson, body(a))
      const large = run(signal, isJson, body(b))
      for (const r of [small, large]) {
        expect(r.reasons).toContain(reason)
        expect(r.rows).toBe(stored)
        expect(r.built).toBeLessThanOrEqual(N + 64)
      }
      // The same work whatever the size: building stopped at the limit.
      expect(Math.abs(large.built - small.built)).toBeLessThanOrEqual(2)
    })
  }

  it('builds at most 128 events and 128 links of a span, and refuses it for them as before', () => {
    const r = run('traces', false, request(SVC, cat(ld(0x12, span(0, rep([0x5a, 2, 0x12, 0], 4 * N))), ld(0x12, span(1)))))
    expect(r.reasons).toBe(`1 ${SpanReject.events}`)
    expect(r.rows).toBe(1)
    // 128 events and the resource's one attribute.
    expect(r.built).toBeLessThanOrEqual(129)
    const l = run('traces', false, request(SVC, ld(0x12, span(0, rep([0x6a, 0], 4 * N)))))
    expect(l.reasons).toBe(`1 ${SpanReject.links}`)
    expect(l.built).toBeLessThanOrEqual(129)
  })

  it('stores an item of exactly 65,536 values, and refuses one more', () => {
    // A span: four array attributes of N/4 - 1 empty values each, plus their four entries.
    const spanOf = (extra: number) => request(SVC, ld(0x12, span(0, cat(...['a', 'b', 'c', 'd'].map((k, i) => ld(0x4a, kvArray(k, N / 4 - 1 + (i === 0 ? extra : 0))))))))
    expect(run('traces', false, spanOf(0))).toMatchObject({ rows: 1, rejected: 0 })
    expect(run('traces', false, spanOf(1))).toMatchObject({ rows: 0, reasons: `1 ${SpanReject.values}` })
    // A log record: a body array of N - 1 integers and one attribute (its line is 131 KiB of plain JSON).
    const recordOf = (extra: number) => request(SVC, record(cat(ld(0x2a, ld(0x2a, rep([0x0a, 2, 0x18, 0], N - 1 + extra))), ld(0x32, kvs('a', 'b')))))
    expect(run('logs', false, recordOf(0))).toMatchObject({ rows: 1, rejected: 0 })
    expect(run('logs', false, recordOf(1))).toMatchObject({ rows: 0, reasons: `1 ${LogReject.values}` })
    // A data point: 16 labels, each an array of 4,095 integers (8,190 bytes of JSON), N values in all.
    const pointOf = (extra: number) => metricsReq(SVC, [cat(...Array.from({ length: 16 }, (_, i) => ld(0x3a, cat(str(0x0a, `k${i}`), ld(0x12, ld(0x2a, rep([0x0a, 2, 0x18, 0], 4095 + (i === 0 ? extra : 0))))))))])
    expect(run('metrics', false, pointOf(0))).toMatchObject({ rows: 1, rejected: 0 })
    expect(run('metrics', false, pointOf(1))).toMatchObject({ rows: 0, reasons: `1 ${SERIES_TOO_LARGE}` })
    // A Loki entry: N structured metadata pairs with empty values (dropped, as before), then one more.
    const entryOf = (extra: number) => lokiReq('{job="a"}', [rep([0x1a, 0], N + extra)])
    expect(run('loki', false, entryOf(0))).toMatchObject({ rows: 1, rejected: 0 })
    expect(run('loki', false, entryOf(1))).toMatchObject({ rows: 0, reasons: `1 ${LogReject.values}` })
    // A Loki label set: N - 1 empty-valued pairs (dropped) and job="a", then one pair more.
    const labelsOf = (extra: number) => lokiReq(`{${Array.from({ length: N - 1 + extra }, (_, i) => `a${i}=""`).join(',')},job="a"}`, [str(0x12, 'x')])
    expect(run('loki', false, labelsOf(0))).toMatchObject({ rows: 1, rejected: 0 })
    expect(run('loki', false, labelsOf(1))).toMatchObject({ rows: 0, reasons: `1 ${LogReject.labelPairs}` })
  })

  it('counts a resource and each of its scopes together (spans)', () => {
    // The resource: four arrays, N - 16 values; a scope attribute of k values: N - 16 + 1 + k.
    const resource = cat(...['a', 'b', 'c', 'd'].map((k) => ld(0x0a, kvArray(k, N / 4 - 1 - 4))))
    const withScope = (k: number) => request(resource, cat(ld(0x0a, ld(0x1a, kvArray('s', k))), ld(0x12, span(0))))
    expect(run('traces', false, withScope(15))).toMatchObject({ rows: 1, rejected: 0 })
    expect(run('traces', false, withScope(16))).toMatchObject({ rows: 0, reasons: `1 ${SpanReject.entryValues}` })
  })

  it('still reads the rest of an item it has stopped building: a malformed body is 400', () => {
    let deep = ld(0x12, new Uint8Array(0))
    for (let i = 0; i < 18; i++) deep = ld(0x12, ld(0x32, ld(0x0a, cat(str(0x0a, 'x'), deep))))
    const tooDeep = cat(str(0x0a, 'k'), deep)
    expect(status(() => run('traces', false, request(SVC, ld(0x12, span(0, cat(rep([0x4a, 0], N + 10), ld(0x4a, tooDeep)))))))).toBe(400)
    expect(status(() => run('logs', false, request(SVC, record(cat(rep([0x32, 0], N + 10), ld(0x32, tooDeep))))))).toBe(400)
    expect(status(() => run('traces', false, request(SVC, ld(0x12, span(0, cat(rep([0x4a, 0], N + 10), Uint8Array.of(0x4a, 5, 0x0a)))))))).toBe(400)
    // Metrics refuses invalid UTF-8 (fatal decoding) in keys it no longer builds too.
    expect(status(() => run('metrics', false, metricsReq(SVC, [cat(rep([0x3a, 0], N + 10), ld(0x3a, ld(0x0a, Uint8Array.of(0xc0, 0x80))))])))).toBe(400)
    expect(status(() => run('metrics', false, metricsReq(SVC, [cat(rep([0x3a, 0], N + 10), ld(0x3a, ld(0x12, ld(0x0a, Uint8Array.of(0xed, 0xa0, 0x80)))))])))).toBe(400)
    // JSON keeps checking every value's type.
    expect(status(() => run('traces', true, json(`{"resourceSpans":[{"resource":{"attributes":[${emptyObjects(N + 10)},{"key":5}]}}]}`)))).toBe(400)
    expect(status(() => run('metrics', true, json(`{"resourceMetrics":[{"resource":{"attributes":[${emptyObjects(N + 10)},{"key":"a","value":{"intValue":"x"}}]}}]}`)))).toBe(400)
  })

  it('refuses through the Worker with each endpoint\'s status, and stores the rest', async () => {
    const tenant = newTenant('dec')
    const key = await makeKey(tenant)
    const traces = await postSignal('/v1/traces', key, request(SVC, cat(ld(0x12, span(0, rep([0x4a, 0], N + 1))), ld(0x12, span(1)))), 'application/x-protobuf')
    expect(traces.status).toBe(200)
    expect(partialProto(new Uint8Array(await traces.arrayBuffer()))).toEqual([1, `1 ${SpanReject.values}`])
    expect((await storedSpans(DEFAULT_MAP, tenant)).length).toBe(1)
    const logs = await postSignal('/v1/logs', key, request(SVC, cat(record(ld(0x2a, ld(0x2a, rep([0x0a, 0], N + 1)))), record())), 'application/x-protobuf')
    expect(logs.status).toBe(200)
    expect(partialProto(new Uint8Array(await logs.arrayBuffer()))).toEqual([1, `1 ${LogReject.values}`])
    const loki = await postSignal('/loki/api/v1/push', key, snappyCompress(lokiReq('{job="a"}', [rep([0x1a, 0], N + 1), str(0x12, 'ok')])), 'application/x-protobuf')
    expect(loki.status).toBe(400)
    expect(await loki.text()).toBe(`rejected 1 of 2 entries (1 ${LogReject.values}); 1 written`)
    expect((await storedLogs(DEFAULT_MAP, tenant)).length).toBe(2)
    const metrics = await postOtlp(key, metricsReq(SVC, [rep([0x3a, 0], N + 1), new Uint8Array(0)]), 'application/x-protobuf')
    expect(metrics.status).toBe(200)
    expect(partialProto(new Uint8Array(await metrics.arrayBuffer()))).toEqual([1, `1 ${SERIES_TOO_LARGE}`])
    expect((await tail(DEFAULT_MAP, tenant)).length).toBe(1)
  })
})

// ───────────────────────────── per request ─────────────────────────────

describe('decode limits: a request', () => {
  const at = (limits: Partial<Limits>) => ({ env: { INGEST_LIMITS: JSON.stringify(limits) } })

  it('metrics: a resource copied into more series bytes than maxDecodedBytes is refused whole (413), nothing stored', async () => {
    const tenant = newTenant('dec')
    const key = await makeKey(tenant)
    // One resource of ~4 KiB of labels, 50 points with a label each: ~200 KiB of series from a 5 KiB body.
    const resource = cat(...Array.from({ length: 4 }, (_, i) => ld(0x0a, kvs(`r${i}`, 'v'.repeat(1000)))))
    const body = metricsReq(resource, Array.from({ length: 50 }, (_, i) => ld(0x3a, kvs('p', String(i)))))
    expect(body.length).toBeLessThan(6000)
    const over = await postOtlp(key, body, 'application/x-protobuf', at({ maxDecodedBytes: 150_000 }))
    expect(over.status).toBe(413)
    expect(await tail(DEFAULT_MAP, tenant)).toEqual([])
    const under = await postOtlp(key, body, 'application/x-protobuf', at({ maxDecodedBytes: 250_000 }))
    expect(under.status).toBe(200)
    expect((await tail(DEFAULT_MAP, tenant)).length).toBe(50)
    // Remote Write uses the same series table and the same limit.
    expect(run('metrics', false, body, { ...DEFAULT_LIMITS, maxDecodedBytes: 250_000 }).rows).toBe(50)
    expect(status(() => run('metrics', false, body, { ...DEFAULT_LIMITS, maxDecodedBytes: 150_000 }))).toBe(413)
  })

  it('spans: a resource copied into more entries than maxDecodedBytes allows is refused whole (413), nothing stored', async () => {
    const tenant = newTenant('dec')
    const key = await makeKey(tenant)
    const resource = cat(SVC, ...Array.from({ length: 4 }, (_, i) => ld(0x0a, kvs(`r${i}`, 'v'.repeat(1000)))))
    // 40 scopes, each named apart, one span each: 40 entries of ~4 KiB each.
    const body = ld(0x0a, cat(ld(0x0a, resource), ...Array.from({ length: 40 }, (_, i) => ld(0x12, cat(ld(0x0a, str(0x0a, `s${i}`)), ld(0x12, span(i)))))))
    const over = await postSignal('/v1/traces', key, body, 'application/x-protobuf', at({ maxDecodedBytes: 100_000 }))
    expect(over.status).toBe(413)
    expect(await storedSpans(DEFAULT_MAP, tenant)).toEqual([])
    const under = await postSignal('/v1/traces', key, body, 'application/x-protobuf', at({ maxDecodedBytes: 400_000 }))
    expect(under.status).toBe(200)
    expect((await storedSpans(DEFAULT_MAP, tenant)).length).toBe(40)
  })

  it('takes exactly maxDecodedBytes, and refuses a byte less (each signal)', () => {
    const decodedOf = (signal: Signal, body: Uint8Array, limits: Limits): number => {
      const c = signal === 'metrics' ? new Collector(limits, Date.now(), body.length) : signal === 'traces' ? new SpanCollector(limits, Date.now()) : new LogCollector(limits, Date.now())
      if (c instanceof Collector) decodeOtlpProto(body, c)
      else if (c instanceof SpanCollector) decodeTracesProto(body, c)
      else decodeLogsProto(body, c)
      return c.decoded
    }
    const resource = cat(SVC, ld(0x0a, kvs('r', 'v'.repeat(500))))
    const bodies: [Signal, Uint8Array][] = [
      ['metrics', metricsReq(resource, Array.from({ length: 20 }, (_, i) => ld(0x3a, kvs('p', String(i)))))],
      ['traces', ld(0x0a, cat(ld(0x0a, resource), ...Array.from({ length: 20 }, (_, i) => ld(0x12, cat(ld(0x0a, str(0x0a, `s${i}`)), ld(0x12, span(i)))))))],
      ['logs', request(resource, cat(...Array.from({ length: 20 }, () => record(ld(0x2a, str(0x0a, 'line'))))))],
    ]
    for (const [signal, body] of bodies) {
      const size = decodedOf(signal, body, DEFAULT_LIMITS)
      expect(size, signal).toBeGreaterThan(1000)
      expect(run(signal, false, body, { ...DEFAULT_LIMITS, maxDecodedBytes: size }).rows, signal).toBe(20)
      expect(status(() => run(signal, false, body, { ...DEFAULT_LIMITS, maxDecodedBytes: size - 1 })), signal).toBe(413)
    }
  })

  it('logs: rows past maxDecodedBytes refuse the request whole (413)', () => {
    const body = request(SVC, cat(...Array.from({ length: 100 }, () => record(ld(0x2a, str(0x0a, 'x'.repeat(1000)))))))
    expect(run('logs', false, body, { ...DEFAULT_LIMITS, maxDecodedBytes: 200_000 }).rows).toBe(100)
    expect(status(() => run('logs', false, body, { ...DEFAULT_LIMITS, maxDecodedBytes: 50_000 }))).toBe(413)
  })

  it('JSON bodies: more than maxJsonTokens structural characters is 413 before parsing, as many is accepted', async () => {
    const tenant = newTenant('dec')
    const key = await makeKey(tenant)
    const bodies: [string, string, Signal][] = [
      ['/v1/metrics', `{"resourceMetrics":[{"scopeMetrics":[{"metrics":[{"name":"m","gauge":{"dataPoints":[{"timeUnixNano":"${NS}","asDouble":1,"attributes":[{"key":"a,{[:","value":{"stringValue":"\\"]}"}}]}]}}]}]}]}`, 'metrics'],
      ['/v1/traces', `{"resourceSpans":[{"scopeSpans":[{"spans":[{"traceId":"0102030405060708090a0b0c0d0e0f10","spanId":"0102030405060708","startTimeUnixNano":"${NS}","name":"a:b,{c}[d]"}]}]}]}`, 'traces'],
      ['/v1/logs', `{"resourceLogs":[{"scopeLogs":[{"logRecords":[{"timeUnixNano":"${NS}","body":{"stringValue":"{\\"x\\":[1,2]}"}}]}]}]}`, 'logs'],
      ['/loki/api/v1/push', `{"streams":[{"stream":{"job":"a"},"values":[["${NS}","line, with: {all} [of them]"]]}]}`, 'loki'],
    ]
    for (const [path, text] of bodies) {
      let n = 0
      // Counted here apart from src: structure outside strings, skipping escaped characters.
      for (let i = 0, inStr = false; i < text.length; i++) {
        const ch = text[i]!
        if (inStr) {
          if (ch === '\\') i++
          else if (ch === '"') inStr = false
        } else if (ch === '"') inStr = true
        else if ('{[,:'.includes(ch)) n++
      }
      const post = (limit: number) =>
        path === '/v1/metrics' ? postOtlp(key, text, 'application/json', at({ maxJsonTokens: limit })) : postSignal(path, key, text, 'application/json', at({ maxJsonTokens: limit }))
      expect((await post(n - 1)).status, path).toBe(413)
      expect([200, 204], path).toContain((await post(n)).status)
    }
    expect((await tail(DEFAULT_MAP, tenant)).length).toBe(1)
    expect((await storedSpans(DEFAULT_MAP, tenant)).length).toBe(1)
    expect((await storedLogs(DEFAULT_MAP, tenant)).length).toBe(2)
  })

  it('counts JSON structure outside strings only', () => {
    // { : [ , — the rest is inside strings, an escaped quote included.
    expect(status(() => checkJsonTokens(te.encode('{"a,b:c{[":["x\\"]}",1]}'), 4))).toBe('ok')
    expect(status(() => checkJsonTokens(te.encode('{"a,b:c{[":["x\\"]}",1]}'), 3))).toBe(413)
    expect(status(() => checkJsonTokens(te.encode('[[],[],{}]'), 6))).toBe('ok')
    expect(status(() => checkJsonTokens(te.encode('[[],[],{}]'), 5))).toBe(413)
  })
})

describe('validUtf8', () => {
  it('agrees with a fatal TextDecoder on 20,000 random byte strings, biased to the edges of multi-byte forms', () => {
    const td = new TextDecoder('utf-8', { fatal: true })
    let seed = 12345
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296)
    const edges = [0x00, 0x7f, 0x80, 0x8f, 0x90, 0x9f, 0xa0, 0xbf, 0xc0, 0xc1, 0xc2, 0xdf, 0xe0, 0xed, 0xee, 0xef, 0xf0, 0xf4, 0xf5, 0xff]
    let invalid = 0
    for (let k = 0; k < 20_000; k++) {
      const b = Uint8Array.from({ length: 1 + Math.floor(rnd() * 6) }, () => (rnd() < 0.7 ? edges[Math.floor(rnd() * edges.length)]! : Math.floor(rnd() * 256)))
      let want = true
      try {
        td.decode(b)
      } catch {
        want = false
      }
      if (!want) invalid++
      expect(validUtf8(b, 0, b.length), Array.from(b, (x) => x.toString(16)).join(' ')).toBe(want)
    }
    expect(invalid).toBeGreaterThan(5000)
    expect(validUtf8(te.encode('ascii, é, 日本, 😀'), 0, te.encode('ascii, é, 日本, 😀').length)).toBe(true)
  })
})
