/**
 * Decode limits on the metrics path (contracts/BATCH.md, "Decode limits"; review M-3; D71):
 * OTLP metrics (protobuf, JSON) and the series table Remote Write shares. A data point or
 * resource over 65,536 values is refused before it is built, and stops being built at the
 * limit whatever the body's size: `BUILT` counts what the decoders build, apart from the
 * meters. Kept apart from the span and log tests (test/decode.test.ts) so that it carries over
 * to a tree with metrics only.
 */
import { describe, expect, it } from 'vitest'
import { Collector, buildBatches } from '../src/batch'
import { DEFAULT_LIMITS, type Limits } from '../src/limits'
import { BUILT, DECODE, checkJsonTokens } from '../src/meter'
import { decodeOtlpJson, decodeOtlpProto } from '../src/otlp'
import { validUtf8 } from '../src/pb'
import { DEFAULT_MAP, decodeVZB1, makeKey, newTenant, postOtlp, tail } from './helpers'
import { NS, SVC, cat, emptyObjects, json, jsonTokens, kvArray, kvs, ld, metricsReq, rep, status, str, te } from './wire'

const N = DECODE.maxValues
const SERIES_TOO_LARGE = 'label set too large to fit one batch'

function run(isJson: boolean, body: Uint8Array, limits: Limits = DEFAULT_LIMITS) {
  const before = BUILT.n
  const c = new Collector(limits, Date.now(), body.length)
  ;(isJson ? decodeOtlpJson : decodeOtlpProto)(body, c)
  return { rows: c.nRows, rejected: c.rejectedTotal, reasons: c.rejectionSummary(), built: BUILT.n - before, decoded: c.decoded }
}

/** Partial success of an OTLP metrics response (protobuf): [rejected points, message]. */
function partial(b: Uint8Array): [number, string] {
  let i = 0
  const varint = (): number => {
    let x = 0
    let m = 1
    for (;;) {
      const c = b[i++]!
      x += (c & 127) * m
      if (c < 128) return x
      m *= 128
    }
  }
  if (b[i++] !== 0x0a) throw new Error('no partial_success')
  varint()
  let rejected = 0
  let msg = ''
  while (i < b.length) {
    const t = b[i++]
    if (t === 0x08) rejected = varint()
    else if (t === 0x12) {
      const n = varint()
      msg = new TextDecoder().decode(b.subarray(i, i + n))
      i += n
    } else throw new Error(`tag ${t}`)
  }
  return [rejected, msg]
}

const HOSTILE: [name: string, json: boolean, body: (n: number) => Uint8Array, stored: number][] = [
  ['metrics: resource of empty KeyValues', false, (n) => metricsReq(rep([0x0a, 0], n), [new Uint8Array(0)]), 0],
  ['metrics: point of empty attributes, then a valid point', false, (n) => metricsReq(SVC, [rep([0x3a, 0], n), new Uint8Array(0)]), 1],
  ['metrics: point attribute, an array of empty values', false, (n) => metricsReq(SVC, [ld(0x3a, kvArray('a', n)), new Uint8Array(0)]), 1],
  ['metrics JSON: point of empty attributes, then a valid point', true, (n) => json(`{"resourceMetrics":[{"scopeMetrics":[{"metrics":[{"name":"m","gauge":{"dataPoints":[{"timeUnixNano":"${NS}","asDouble":1,"attributes":[${emptyObjects(n)}]},{"timeUnixNano":"${NS}","asDouble":1}]}}]}]}]}`), 1],
]

describe('decode limits (metrics): an item with more than 65,536 values', () => {
  it('is 65,536 (contracts/BATCH.md), and the request limits have their documented defaults', () => {
    expect(N).toBe(65_536)
    expect(DEFAULT_LIMITS.maxDecompressedBytes).toBe(8 << 20)
    expect(DEFAULT_LIMITS.maxDecodedBytes).toBe(16 << 20)
    expect(DEFAULT_LIMITS.maxJsonTokens).toBe(1 << 20)
  })

  for (const [name, isJson, body, stored] of HOSTILE) {
    it(`${name}: refused on its own, built no further than the limit however large it is`, () => {
      // JSON shapes cost two structural characters per value: 4N of them stay under the token limit.
      const [a, b] = isJson ? [2 * N, 4 * N] : [4 * N, 8 * N]
      const small = run(isJson, body(a))
      const large = run(isJson, body(b))
      for (const r of [small, large]) {
        expect(r.reasons).toContain(SERIES_TOO_LARGE)
        expect(r.rows).toBe(stored)
        expect(r.built).toBeLessThanOrEqual(N + 64)
      }
      // The same work whatever the size: building stopped at the limit.
      expect(Math.abs(large.built - small.built)).toBeLessThanOrEqual(2)
    })
  }

  it('stores a data point of exactly 65,536 values, and refuses one more', () => {
    // 16 labels, each an array of 4,095 integers (8,191 bytes of JSON), N values in all.
    const pointOf = (extra: number) => metricsReq(SVC, [cat(...Array.from({ length: 16 }, (_, i) => ld(0x3a, cat(str(0x0a, `k${i}`), ld(0x12, ld(0x2a, rep([0x0a, 2, 0x18, 0], 4095 + (i === 0 ? extra : 0))))))))])
    expect(run(false, pointOf(0))).toMatchObject({ rows: 1, rejected: 0 })
    // Every value is stored: each label holds all 4,095 elements.
    const c = new Collector(DEFAULT_LIMITS, Date.now())
    decodeOtlpProto(pointOf(0), c)
    const [batch] = [...buildBatches(c, new Int32Array(c.nSeries), DEFAULT_LIMITS.maxBatchBytes).values()].flat()
    const labels = decodeVZB1(batch!.bytes).series[0]!.labels
    const all = `[${Array(4095).fill(0).join(',')}]`
    expect(labels.filter(([n]) => /^k\d+$/.test(n)).map(([n, v]) => [n, v === all])).toEqual(Array.from({ length: 16 }, (_, i) => [`k${i}`, true]).sort())
    expect(run(false, pointOf(1))).toMatchObject({ rows: 0, reasons: `1 ${SERIES_TOO_LARGE}` })
  })

  it('still reads the rest of a point it has stopped building: a malformed body is 400', () => {
    // Invalid UTF-8 (fatal decoding) in a key and in a value it no longer builds.
    expect(status(() => run(false, metricsReq(SVC, [cat(rep([0x3a, 0], N + 10), ld(0x3a, ld(0x0a, Uint8Array.of(0xc0, 0x80))))])))).toBe(400)
    expect(status(() => run(false, metricsReq(SVC, [cat(rep([0x3a, 0], N + 10), ld(0x3a, ld(0x12, ld(0x0a, Uint8Array.of(0xed, 0xa0, 0x80)))))])))).toBe(400)
    // Nested deeper than 16 after the limit.
    let inner: Uint8Array = new Uint8Array(0)
    for (let i = 0; i < 18; i++) inner = ld(0x2a, ld(0x0a, inner))
    expect(status(() => run(false, metricsReq(SVC, [cat(rep([0x3a, 0], N + 10), ld(0x3a, cat(str(0x0a, 'k'), ld(0x12, inner))))])))).toBe(400)
    // JSON keeps checking every value's type.
    expect(status(() => run(true, json(`{"resourceMetrics":[{"resource":{"attributes":[${emptyObjects(N + 10)},{"key":"a","value":{"intValue":"x"}}]}}]}`)))).toBe(400)
  })

  it('refuses through the Worker with a partial success, and stores the rest', async () => {
    const tenant = newTenant('dec')
    const key = await makeKey(tenant)
    const res = await postOtlp(key, metricsReq(SVC, [rep([0x3a, 0], N + 1), new Uint8Array(0)]), 'application/x-protobuf')
    expect(res.status).toBe(200)
    expect(partial(new Uint8Array(await res.arrayBuffer()))).toEqual([1, `1 ${SERIES_TOO_LARGE}`])
    expect((await tail(DEFAULT_MAP, tenant)).length).toBe(1)
  })
})

describe('decode limits (metrics): a request', () => {
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
  })

  it('takes exactly maxDecodedBytes of series, and refuses a byte less', () => {
    const body = metricsReq(cat(SVC, ld(0x0a, kvs('r', 'v'.repeat(500)))), Array.from({ length: 20 }, (_, i) => ld(0x3a, kvs('p', String(i)))))
    const size = run(false, body).decoded
    expect(size).toBeGreaterThan(10_000)
    expect(run(false, body, { ...DEFAULT_LIMITS, maxDecodedBytes: size }).rows).toBe(20)
    expect(status(() => run(false, body, { ...DEFAULT_LIMITS, maxDecodedBytes: size - 1 }))).toBe(413)
  })

  it('JSON bodies: more than maxJsonTokens structural characters is 413 before parsing, as many is accepted', async () => {
    const tenant = newTenant('dec')
    const key = await makeKey(tenant)
    const text = `{"resourceMetrics":[{"scopeMetrics":[{"metrics":[{"name":"m","gauge":{"dataPoints":[{"timeUnixNano":"${NS}","asDouble":1,"attributes":[{"key":"a,{[:","value":{"stringValue":"\\"]}"}}]}]}}]}]}]}`
    const n = jsonTokens(text)
    expect((await postOtlp(key, text, 'application/json', at({ maxJsonTokens: n - 1 }))).status).toBe(413)
    expect(await tail(DEFAULT_MAP, tenant)).toEqual([])
    expect((await postOtlp(key, text, 'application/json', at({ maxJsonTokens: n }))).status).toBe(200)
    expect((await tail(DEFAULT_MAP, tenant)).length).toBe(1)
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
    const s = te.encode('ascii, é, 日本, 😀')
    expect(validUtf8(s, 0, s.length)).toBe(true)
  })
})
