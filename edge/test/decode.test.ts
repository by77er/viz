/**
 * Decode limits on the span and log paths (contracts/BATCH.md, "Decode limits"; review M-3;
 * D71): OTLP traces and logs (protobuf, JSON) and Loki push (protobuf, JSON). What a decoder
 * builds for one item is counted before it is built, and a hostile item stops being built at
 * the limit whatever the body's size. "Cheaply" is checked on `BUILT`, which counts every
 * key-value entry and array element a decoder creates, apart from the meters: it must stay at
 * the limit when the hostile body grows. The metrics path is in test/decode-metrics.test.ts;
 * the bodies are written by hand (test/wire.ts).
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_LIMITS, type Limits } from '../src/limits'
import { LogCollector, LogReject, decodeLogsJson, decodeLogsProto, decodeLokiJson, decodeLokiProto } from '../src/logs'
import { BUILT, DECODE } from '../src/meter'
import { SpanCollector, SpanReject, decodeTracesJson, decodeTracesProto } from '../src/spans'
import { DEFAULT_MAP, makeKey, newTenant, snappyCompress } from './helpers'
import { decodeLogBatch, decodeSpanBatch, partialProto, postSignal, storedLogs, storedSpans } from './otelhelpers'
import { NS, SVC, cat, emptyObjects, fixed64, json, jsonTokens, kvArray, kvs, ld, lokiReq, record, rep, request, span, status, str } from './wire'

const N = DECODE.maxValues

// ───────────────────────────── running a decoder ─────────────────────────────

type Signal = 'traces' | 'logs' | 'loki'
interface Run {
  rows: number
  rejected: number
  reasons: string
  built: number
  decoded: number
}

function collect(signal: Signal, json: boolean, body: Uint8Array, limits: Limits = DEFAULT_LIMITS): SpanCollector | LogCollector {
  const now = Date.now()
  const c = signal === 'traces' ? new SpanCollector(limits, now) : new LogCollector(limits, now)
  if (c instanceof SpanCollector) (json ? decodeTracesJson : decodeTracesProto)(body, c)
  else if (signal === 'logs') (json ? decodeLogsJson : decodeLogsProto)(body, c)
  else (json ? decodeLokiJson : decodeLokiProto)(body, c)
  return c
}

function run(signal: Signal, json: boolean, body: Uint8Array, limits: Limits = DEFAULT_LIMITS): Run {
  const before = BUILT.n
  const c = collect(signal, json, body, limits)
  return { rows: c.nRows, rejected: c.rejectedTotal, reasons: c.rejectionSummary(), built: BUILT.n - before, decoded: c.decoded }
}

/** The rows a collector would append, read back with the test-side decoders. */
const storedOf = (c: SpanCollector | LogCollector): Uint8Array[] => [...c.build(new Int32Array(c.nSeries), DEFAULT_LIMITS.maxBatchBytes).values()].flat().map((b) => b.bytes)

// ───────────────────────────── hostile shapes ─────────────────────────────

/**
 * Each shape is one item with `n` values (entries or elements) and, where the signal allows,
 * one valid item after it that must be stored. `n` is scaled to show that building stops at
 * the limit: the built count must be the same for 4N and 8N values.
 */
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
]

describe('decode limits: an item with more than 65,536 values', () => {
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

  it('stores a span of exactly 128 events and 128 links, every one, and refuses a span of 129', () => {
    const ids = (i: number): Uint8Array => {
      const t = new Uint8Array(24)
      new DataView(t.buffer).setUint32(12, i + 1)
      new DataView(t.buffer).setUint32(20, i + 1)
      return cat(ld(0x0a, t.subarray(0, 16)), ld(0x12, t.subarray(16)))
    }
    const events = (n: number) => cat(...Array.from({ length: n }, (_, i) => ld(0x5a, cat(fixed64(0x09, NS), str(0x12, `e${i}`)))))
    const links = (n: number) => cat(...Array.from({ length: n }, (_, i) => ld(0x6a, ids(i))))
    const c = collect('traces', false, request(SVC, ld(0x12, span(0, cat(events(128), links(128))))))
    expect(c).toMatchObject({ nRows: 1, rejectedTotal: 0 })
    const [s] = storedOf(c).flatMap(decodeSpanBatch)
    expect(s!.events.map((e) => e.name)).toEqual(Array.from({ length: 128 }, (_, i) => `e${i}`))
    expect(s!.links.length).toBe(128)
    expect(run('traces', false, request(SVC, ld(0x12, span(0, events(129)))))).toMatchObject({ rows: 0, reasons: `1 ${SpanReject.events}` })
    expect(run('traces', false, request(SVC, ld(0x12, span(0, links(129)))))).toMatchObject({ rows: 0, reasons: `1 ${SpanReject.links}` })
  })

  it('stores an item of exactly 65,536 values, and refuses one more', () => {
    // A span: four array attributes of N/4 - 1 empty values each, plus their four entries.
    // Every value is stored: the last array keeps all its elements.
    const spanOf = (extra: number) => request(SVC, ld(0x12, span(0, cat(...['a', 'b', 'c', 'd'].map((k, i) => ld(0x4a, kvArray(k, N / 4 - 1 + (i === 0 ? extra : 0))))))))
    const atLimit = collect('traces', false, spanOf(0))
    expect(atLimit).toMatchObject({ nRows: 1, rejectedTotal: 0 })
    const [stored] = storedOf(atLimit).flatMap(decodeSpanBatch)
    // (The span has no end, so it is stored clamped, with viz.clamped_end beside these four.)
    expect(stored!.attrs.filter(([k]) => k.length === 1).map(([k, kind, v]) => [k, kind, v.split('{}').length - 1])).toEqual(['a', 'b', 'c', 'd'].map((k) => [k, 'o', N / 4 - 1]))
    expect(run('traces', false, spanOf(1))).toMatchObject({ rows: 0, reasons: `1 ${SpanReject.values}` })
    // A log record: a body array of N - 1 integers and one attribute (its line is 131 KiB of plain JSON), all stored.
    const recordOf = (extra: number) => request(SVC, record(cat(ld(0x2a, ld(0x2a, rep([0x0a, 2, 0x18, 0], N - 1 + extra))), ld(0x32, kvs('a', 'b')))))
    const recordAt = collect('logs', false, recordOf(0))
    expect(recordAt).toMatchObject({ nRows: 1, rejectedTotal: 0 })
    const [log] = storedOf(recordAt).flatMap(decodeLogBatch)
    expect(log!.line).toBe(`[${Array(N - 1).fill(0).join(',')}]`)
    expect(log!.metadata).toEqual([['a', 'b']])
    expect(run('logs', false, recordOf(1))).toMatchObject({ rows: 0, reasons: `1 ${LogReject.values}` })
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
    // JSON keeps checking every value's type.
    expect(status(() => run('traces', true, json(`{"resourceSpans":[{"resource":{"attributes":[${emptyObjects(N + 10)},{"key":5}]}}]}`)))).toBe(400)
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
  })
})

// ───────────────────────────── per request ─────────────────────────────

describe('decode limits: a request', () => {
  const at = (limits: Partial<Limits>) => ({ env: { INGEST_LIMITS: JSON.stringify(limits) } })

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

  it('takes exactly maxDecodedBytes, and refuses a byte less (spans, logs)', () => {
    const resource = cat(SVC, ld(0x0a, kvs('r', 'v'.repeat(500))))
    const bodies: [Signal, Uint8Array][] = [
      ['traces', ld(0x0a, cat(ld(0x0a, resource), ...Array.from({ length: 20 }, (_, i) => ld(0x12, cat(ld(0x0a, str(0x0a, `s${i}`)), ld(0x12, span(i)))))))],
      ['logs', request(resource, cat(...Array.from({ length: 20 }, () => record(ld(0x2a, str(0x0a, 'line'))))))],
    ]
    for (const [signal, body] of bodies) {
      const size = run(signal, false, body).decoded
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
    const bodies: [string, string][] = [
      ['/v1/traces', `{"resourceSpans":[{"scopeSpans":[{"spans":[{"traceId":"0102030405060708090a0b0c0d0e0f10","spanId":"0102030405060708","startTimeUnixNano":"${NS}","name":"a:b,{c}[d]"}]}]}]}`],
      ['/v1/logs', `{"resourceLogs":[{"scopeLogs":[{"logRecords":[{"timeUnixNano":"${NS}","body":{"stringValue":"{\\"x\\":[1,2]}"}}]}]}]}`],
      ['/loki/api/v1/push', `{"streams":[{"stream":{"job":"a"},"values":[["${NS}","line, with: {all} [of them]"]]}]}`],
    ]
    for (const [path, text] of bodies) {
      const n = jsonTokens(text)
      const post = (limit: number) => postSignal(path, key, text, 'application/json', at({ maxJsonTokens: limit }))
      expect((await post(n - 1)).status, path).toBe(413)
      expect([200, 204], path).toContain((await post(n)).status)
    }
    expect((await storedSpans(DEFAULT_MAP, tenant)).length).toBe(1)
    expect((await storedLogs(DEFAULT_MAP, tenant)).length).toBe(2)
  })
})
