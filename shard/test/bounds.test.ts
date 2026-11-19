/// <reference path="../../engine/wasm/js/wasm.d.ts" />
/**
 * Time bounds of span and log batches (D72; review m-3 of design/reviews/signals-end-to-end.md;
 * contracts/BATCH.md "Tail reads of spans and log records by time"):
 *
 *   recorded at append   each span or log batch's row holds the floor, in ms, of its smallest and
 *                        largest span start or log timestamp: what the engine's flush (an
 *                        independent reader of the batch) finds in it; a metric batch, an empty
 *                        or unwalkable one holds none (NULL), and is still stored
 *   read by a hull       a filtered read with `[minTs, maxTs]` returns exactly the span or log
 *                        batches whose bounds overlap it, plus every batch without bounds, in
 *                        order; a span that starts inside a NANOSECOND bound is always in a
 *                        returned batch when the bound is passed as the query passes it (floor
 *                        of each end, D62); signals still choose batches
 *   pages and cursors    D48 unchanged: the same batches whatever the page size, cursors bound to
 *                        the hull, `page_limit` only for a batch the read keeps, the scan budget,
 *                        the discard fence, eviction
 *   rollback             storage this release wrote is served by the release before it (frozen,
 *                        bench/prebounds/) on the same storage, and every batch that release
 *                        wrote is kept by every hull after the roll-forward; storage at schema 2
 *                        made by that release migrates to 3 once, its rows unbounded
 *
 * Span and log batches are written by the engine's test encoder (engine/wasm/test/signal.ts),
 * which shares no code with the shard or with edge; bounds are checked against the engine's
 * flush (`encodeSpans`, `encodeLogs`: the files' `minNs`/`maxNs`).
 */
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { createEngine } from '../../engine/wasm/js/index'
import wasm from '../../engine/wasm/js/viz_engine.wasm'
import { type Attrs, type LogRow, type SpanRow, encodeLogBatch, encodeSpanBatch } from '../../engine/wasm/test/signal'
import { bitsFromBytes, bitsOf, encodeBatch } from '../../engine/wasm/test/vzb1'
import { Shard as ShardPrebounds } from '../bench/prebounds/shard'
import { SHARD_SCHEMA, type Shard, type TailBatch, type TailReadOptions, type TailResult } from '../src/shard'
import { batchTimeBounds, keepsBounds } from '../src/tail'

type Stub = DurableObjectStub<Shard>
type Ok = Extract<TailResult, { status: 'ok' }>
const engine = createEngine(wasm)
let n = 0
const uid = () => `${Date.now().toString(36)}-${n++}`
const te = new TextEncoder()

const MS = 1_000_000n
const MINUTE = 60_000n * MS
const HOUR = 60n * MINUTE
const MAX_NS = (1n << 63n) - 1n
const T0 = Date.UTC(2026, 10, 19, 6) // ms
const NS0 = BigInt(T0) * MS

function rng(seed: number) {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const int = (k: number) => Math.floor(next() * k)
  /** A bigint in [0, k). */
  const big = (k: bigint) => (BigInt(int(2 ** 30)) * (1n << 30n) + BigInt(int(2 ** 30))) % k
  return { next, int, big }
}

let ids = 1
/** A unique, never-zero id of `len` bytes. */
function freshId(len: 16 | 8): Uint8Array {
  const b = new Uint8Array(len).fill(0xab)
  new DataView(b.buffer).setUint32(0, ids++, true)
  return b
}

/**
 * A resource attribute of type 5 ("other", canonical OTLP JSON), which the test encoder cannot
 * write: written as a string (same layout: len u32, bytes) and its type byte patched to 5.
 */
const OTHER_KEY = 'zz.other'
const OTHER = '{"arrayValue":{"values":[{"stringValue":"a"},{"intValue":"2"}]}}'
function patchOther(b: Uint8Array): Uint8Array {
  const key = te.encode(OTHER_KEY)
  for (let i = 16; i + key.length < b.length; i++) {
    if (key.every((x, k) => b[i + k] === x) && b[i - 2] === key.length && b[i + key.length] === 1) {
      b[i + key.length] = 5
      return b
    }
  }
  throw new Error('no type-1 attribute to patch')
}

const RESOURCE = (k: number): Attrs => [
  ['host.cores', { i: BigInt(k) }],
  ['ratio', { d: bitsOf(0.25 * k) }],
  ['service.name', { s: `svc-${k}-${'x'.repeat(k % 7)}` }],
  ['up', { b: k % 2 === 0 }],
  [OTHER_KEY, { s: OTHER }],
]

/** A span batch whose rows start at `starts` and last `dur(i)` (ends hours later, so a walk that read `end` would be caught). */
function spanBatch(starts: bigint[], seed = 1, dur = (i: number) => 3n * HOUR + BigInt(i)): Uint8Array {
  const r = rng(seed)
  const entries = 1 + r.int(3)
  const rows: SpanRow[] = starts.map((start, i) => {
    const end = start + dur(i) > MAX_NS ? MAX_NS : start + dur(i)
    return { entry: i % entries, traceId: freshId(16), spanId: freshId(8), start, end, name: `op-${i}`, kind: 1 + (i % 5), attrs: [['http.status_code', { i: 200n }]] }
  })
  return patchOther(encodeSpanBatch(
    Array.from({ length: entries }, (_, e) => ({ resourceFp: BigInt(seed * 10 + e), resource: RESOURCE(seed + e), scopeName: `lib-${e}`, scopeVersion: '1.2.3', scopeAttrs: e === 0 ? '[{"key":"a","value":{"stringValue":"b"}}]' : '' })),
    rows,
  ))
}

/** A log batch of records stamped `ts` (observed two hours later, so a walk that read `observed_ts` would be caught). */
function logBatch(ts: bigint[], seed = 1): Uint8Array {
  const streams = [{ labels: { service_name: `api-${seed}`, level: 'info' } }, { labels: { service_name: 'db' } }, { labels: { job: 'x', instance: `i-${seed}`, env: 'prod' } }]
  const rows: LogRow[] = ts.map((t, i) => ({ entry: i % streams.length, ts: t, observedTs: t + 2n * HOUR, line: `line ${seed} ${i} ${'y'.repeat(i % 13)}`, severity: 9, metadata: [['k8s_pod', `p-${i}`]] }))
  return encodeLogBatch(streams, rows)
}

/** The bounds the engine's flush finds in a batch: the floor in ms of its files' `minNs`/`maxNs`. */
function flushBounds(batch: Uint8Array): { minTs: number; maxTs: number } {
  const files = batch[4] === 2 ? engine.encodeSpans([batch]).filter((f) => f.table === 'spans') : engine.encodeLogs([batch])
  if (files.length === 0) throw new Error('flush wrote nothing')
  const lo = files.reduce((a, f) => (BigInt(f.minNs) < a ? BigInt(f.minNs) : a), MAX_NS)
  const hi = files.reduce((a, f) => (BigInt(f.maxNs) > a ? BigInt(f.maxNs) : a), 0n)
  return { minTs: Number(lo / MS), maxTs: Number(hi / MS) }
}

const rowsOf = (payload: Uint8Array) => new DataView(payload.buffer, payload.byteOffset).getUint32(8, true)
let fp = 0
async function put(s: Stub, tenant: string, payload: Uint8Array): Promise<number> {
  const a = await s.append({ tenant, epoch: 1, fingerprint: `fp-${fp++}`, payload, rows: rowsOf(payload) })
  if (a.status !== 'ok') throw new Error(JSON.stringify(a))
  return a.seq
}

async function stored(s: Stub, tenant: string): Promise<{ seq: number; min: number | null; max: number | null }[]> {
  return runInDurableObject(s, (_i: Shard, st) =>
    st.storage.sql.exec(`SELECT seq, min_ts, max_ts FROM batch WHERE tenant = ? ORDER BY seq`, tenant).toArray().map((r) => ({ seq: r.seq as number, min: r.min_ts as number | null, max: r.max_ts as number | null })))
}

async function readAll(s: Stub, tenant: string, inc: number, opts: TailReadOptions, above = 0): Promise<{ batches: TailBatch[]; pages: Ok[] }> {
  const pages: Ok[] = []
  let cursor: string | undefined
  do {
    const r = await s.tailRead(tenant, inc, above, { ...opts, ...(cursor ? { cursor } : {}) })
    if (r.status !== 'ok' || !r.page) throw new Error(`tail read: ${JSON.stringify(r).slice(0, 300)}`)
    pages.push(r)
    cursor = r.page.next ?? undefined
  } while (cursor)
  return { batches: pages.flatMap((p) => p.batches), pages }
}
const seqs = (bs: TailBatch[]) => bs.map((b) => b.seq)
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

/** Starts spread over `[from, from + width)`, with values on and next to millisecond boundaries. */
function startsIn(r: ReturnType<typeof rng>, from: bigint, width: bigint, count: number): bigint[] {
  return Array.from({ length: count }, (_, i) => {
    const t = from + r.big(width)
    return i % 4 === 0 ? (t / MS) * MS : i % 4 === 1 ? (t / MS) * MS + MS - 1n : t
  })
}

describe('bounds recorded at append', () => {
  it('a span or log batch\'s row holds the floor in ms of its smallest and largest start / ts, as the engine\'s flush finds them; a metric batch holds none', async () => {
    for (const pool of ['traces', 'logs'] as const) {
      const s = env.SHARD.get(env.SHARD.idFromName(`b-${uid()}/${pool}/0`))
      const tenant = `t-${uid()}`
      const r = rng(pool === 'traces' ? 11 : 12)
      const sent: Uint8Array[] = []
      for (let k = 0; k < 6; k++) {
        const t = startsIn(r, NS0 + BigInt(k) * HOUR, HOUR, 1 + r.int(40))
        sent.push(pool === 'traces' ? spanBatch(t, k + 1) : logBatch(t, k + 1))
      }
      // A batch whose times all lie in one millisecond, and one whose rows straddle a millisecond by one nanosecond.
      const edge = [NS0 + 5n * MS + 999_999n, NS0 + 6n * MS]
      sent.push(pool === 'traces' ? spanBatch([edge[0]!], 7) : logBatch([edge[0]!], 7), pool === 'traces' ? spanBatch(edge, 8) : logBatch(edge, 8))
      for (const b of sent) await put(s, tenant, b)
      await evictDurableObject(s) // storage is the record: nothing of it lives in memory
      const want = sent.map((b) => flushBounds(b))
      expect(want.at(-2)).toEqual({ minTs: T0 + 5, maxTs: T0 + 5 })
      expect(want.at(-1)).toEqual({ minTs: T0 + 5, maxTs: T0 + 6 })
      expect(await stored(s, tenant), pool).toEqual(want.map((w, i) => ({ seq: i + 1, min: w.minTs, max: w.maxTs })))
    }
    // A metric batch: no bounds (its rows are filtered one by one, as before).
    const m = env.SHARD.get(env.SHARD.idFromName(`b-${uid()}/0`))
    await put(m, 't', encodeBatch([{ __name__: 'up', job: 'a' }], [{ series: 0, ts: T0, bits: bitsOf(1) }]))
    expect(await stored(m, 't')).toEqual([{ seq: 1, min: null, max: null }])
  })

  it('random batches (1 to 3 entries, every attribute type, times from 0 to 2^63 - 1): the walk agrees with the flush on every one', () => {
    const r = rng(20261119)
    for (let k = 0; k < 150; k++) {
      const count = 1 + r.int(30)
      const kind = r.int(4)
      const times = Array.from({ length: count }, () =>
        kind === 0 ? NS0 + r.big(24n * HOUR) - 12n * HOUR : kind === 1 ? r.big(MAX_NS) : kind === 2 ? (r.big(MAX_NS / MS) * MS) - BigInt(r.int(2)) : [0n, MAX_NS, MS - 1n, MS][r.int(4)]!)
      const t = times.map((x) => (x < 0n ? 0n : x))
      const b = k % 2 === 0 ? spanBatch(t, k + 1, () => 0n) : logBatch(t, k + 1)
      expect(batchTimeBounds(b), `batch ${k}`).toEqual(flushBounds(b))
    }
  })

  it('a batch the walk cannot follow is stored without bounds, and accepted as before (the shard never refuses for it)', async () => {
    const s = env.SHARD.get(env.SHARD.idFromName(`b-${uid()}/traces/0`))
    const good = spanBatch([NS0, NS0 + HOUR], 3)
    const cut = good.slice(0, good.length - 200) // the start column ends past the payload? no: the tail columns are cut
    const short = good.slice(0, 60) // inside the entry table
    const negative = spanBatch([NS0], 4).slice()
    const nRows = rowsOf(negative)
    // The start column's only value made negative (high bit set): outside the contract.
    const col = (() => {
      const dv = new DataView(negative.buffer)
      for (let at = 16; at + 8 <= negative.length; at += 8) if (dv.getBigInt64(at, true) === NS0) return at
      throw new Error('no start')
    })()
    negative[col + 7]! |= 0x80
    const huge = good.slice()
    new DataView(huge.buffer).setUint32(8, 0xffffffff, true) // n_rows past anything the batch could hold
    const empty = encodeLogBatch([], [])
    expect(nRows).toBe(1)
    expect(batchTimeBounds(cut)).toEqual(flushBounds(good)) // the columns after `start` are not read
    for (const b of [short, negative, huge, empty]) expect(batchTimeBounds(b)).toBeNull()
    const tenant = 't'
    for (const b of [short, negative, huge, empty]) await put(s, tenant, b)
    expect(await stored(s, tenant)).toEqual([1, 2, 3, 4].map((seq) => ({ seq, min: null, max: null })))
    const inc = (await s.describe(tenant))!.incarnation
    // Unbounded: kept by a hull that holds none of their times.
    expect(seqs((await readAll(s, tenant, inc, { signals: [2, 3], minTs: 0, maxTs: 0 })).batches)).toEqual([1, 2, 3, 4])
  })
})

/**
 * A traces shard's tail over six hours: twelve batches of this release, each starting within
 * its own half hour, and two written by the release before it in between (no bounds).
 */
async function sixHours(seed: number) {
  const name = `b-${uid()}/traces/0`
  const s = env.SHARD.get(env.SHARD.idFromName(name))
  const tenant = `t-${uid()}`
  const r = rng(seed)
  const spans: { seq: number; start: bigint }[] = []
  const bounds = new Map<number, { min: number; max: number } | null>()
  const payloads = new Map<number, Uint8Array>()
  const add = (seq: number, b: Uint8Array, starts: bigint[], bounded: boolean) => {
    for (const start of starts) spans.push({ seq, start })
    const lo = starts.reduce((a, x) => (x < a ? x : a))
    const hi = starts.reduce((a, x) => (x > a ? x : a))
    bounds.set(seq, bounded ? { min: Number(lo / MS), max: Number(hi / MS) } : null)
    payloads.set(seq, b)
  }
  for (let j = 0; j < 12; j++) {
    if (j === 4 || j === 9) {
      // The release before this one appends on the same storage (a rollback), then this release runs again.
      const starts = startsIn(r, NS0 + BigInt(j) * 30n * MINUTE, 30n * MINUTE, 3 + r.int(5))
      const b = spanBatch(starts, 100 + j)
      const seq = await runInDurableObject(s, async (_i: Shard, st) => {
        const old = new ShardPrebounds(st, {} as never)
        const a = await old.append({ tenant, epoch: 1, fingerprint: `old-${fp++}`, payload: b, rows: rowsOf(b) })
        if (a.status !== 'ok') throw new Error(JSON.stringify(a))
        return a.seq
      })
      await evictDurableObject(s)
      add(seq, b, starts, false)
    }
    const starts = startsIn(r, NS0 + BigInt(j) * 30n * MINUTE, 30n * MINUTE, 3 + r.int(12))
    const b = spanBatch(starts, j + 1)
    add(await put(s, tenant, b), b, starts, true)
  }
  const inc = (await s.describe(tenant))!.incarnation
  return { s, tenant, inc, spans, bounds, payloads }
}

describe('a filtered read by time', () => {
  it('returns exactly the batches whose bounds overlap the hull, and every batch without bounds, in order, whole', async () => {
    const { s, tenant, inc, bounds, payloads } = await sixHours(31)
    expect(await stored(s, tenant)).toEqual([...bounds].map(([seq, b]) => ({ seq, min: b?.min ?? null, max: b?.max ?? null })))
    const want = (lo: number | undefined, hi: number | undefined) =>
      [...bounds].filter(([, b]) => b === null || keepsBounds({ minTs: lo ?? -Infinity, maxTs: hi ?? Infinity }, b.min, b.max)).map(([seq]) => seq)
    const hulls: [number | undefined, number | undefined][] = []
    // Each bounded batch at both of its edges: touching keeps it, one millisecond off does not.
    for (const b of bounds.values()) {
      if (!b) continue
      hulls.push([b.min, b.min], [b.max, b.max], [b.min - 1, b.min - 1], [b.max + 1, b.max + 1], [b.max, b.max + 10], [b.min - 10, b.min], [b.max + 1, b.max + 3_600_000], [b.min - 3_600_000, b.min - 1])
    }
    const r = rng(32)
    for (let k = 0; k < 60; k++) {
      const lo = T0 - 3_600_000 + r.int(8 * 3_600_000)
      hulls.push([lo, lo + r.int(3 * 3_600_000)])
    }
    hulls.push([T0 - 86_400_000, T0 - 3_600_000], [T0 + 86_400_000, T0 + 90_000_000], [T0 + 3 * 3_600_000, undefined], [undefined, T0 + 3_600_000], [0, 9_223_372_036_854])
    let narrowed = 0
    for (const [lo, hi] of hulls) {
      const opts: TailReadOptions = { signals: [2], ...(lo === undefined ? {} : { minTs: lo }), ...(hi === undefined ? {} : { maxTs: hi }) }
      const got = (await readAll(s, tenant, inc, opts)).batches
      expect(seqs(got), JSON.stringify(opts)).toEqual(want(lo, hi))
      for (const b of got) expect(hex(b.payload)).toBe(hex(payloads.get(b.seq)!))
      if (got.length < bounds.size) narrowed++
    }
    expect(narrowed).toBeGreaterThan(hulls.length / 2)
    // Unbounded batches are kept even by a hull that holds none of their times.
    expect(seqs((await readAll(s, tenant, inc, { signals: [2], minTs: 0, maxTs: 0 })).batches)).toEqual([...bounds].filter(([, b]) => b === null).map(([seq]) => seq))
  })

  it('traces (D62): every span that starts inside a nanosecond bound is in a returned batch, with the bound passed as the query passes it (the floor of each end in ms)', async () => {
    const { s, tenant, inc, spans } = await sixHours(41)
    const r = rng(42)
    const starts = spans.map((x) => x.start)
    const pick = () => {
      const k = r.int(5)
      const at = starts[r.int(starts.length)]!
      return k === 0 ? at : k === 1 ? at - 1n : k === 2 ? at + 1n : NS0 - HOUR + r.big(8n * HOUR)
    }
    let inside = 0
    for (let k = 0; k < 200; k++) {
      let L = pick()
      let H = r.int(3) === 0 ? pick() : L + r.big(2n * HOUR)
      if (H < L) [L, H] = [H, L]
      // query/src/sigparams.ts `msRange`: the floor of each end.
      const got = new Set(seqs((await readAll(s, tenant, inc, { signals: [2], minTs: Number(L / MS), maxTs: Number(H / MS) })).batches))
      for (const x of spans) {
        if (x.start < L || x.start > H) continue
        inside++
        expect(got.has(x.seq), `span starting at ${x.start} in batch ${x.seq}, bound [${L}, ${H}]`).toBe(true)
      }
    }
    expect(inside).toBeGreaterThan(500)
  })

  it('logs: the same, by `ts`; and a read that leaves the time out returns every batch, as before', async () => {
    const s = env.SHARD.get(env.SHARD.idFromName(`b-${uid()}/logs/0`))
    const tenant = `t-${uid()}`
    const r = rng(51)
    const rows: { seq: number; ts: bigint }[] = []
    for (let j = 0; j < 10; j++) {
      const ts = startsIn(r, NS0 + BigInt(j) * 40n * MINUTE, 40n * MINUTE, 2 + r.int(20))
      const seq = await put(s, tenant, logBatch(ts, j + 1))
      for (const t of ts) rows.push({ seq, ts: t })
    }
    const inc = (await s.describe(tenant))!.incarnation
    for (let k = 0; k < 100; k++) {
      const L = NS0 - HOUR + r.big(9n * HOUR)
      const H = L + r.big(HOUR)
      const got = new Set(seqs((await readAll(s, tenant, inc, { signals: [3], minTs: Number(L / MS), maxTs: Number(H / MS) })).batches))
      for (const x of rows) if (x.ts >= L && x.ts <= H) expect(got.has(x.seq)).toBe(true)
      // Nothing outside: a returned batch holds a record within the hull's milliseconds.
      for (const seq of got) expect(rows.some((x) => x.seq === seq && x.ts / MS >= L / MS && x.ts / MS <= H / MS)).toBe(true)
    }
    expect(seqs((await readAll(s, tenant, inc, { signals: [3] })).batches)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    const whole = await s.tailRead(tenant, inc, 0)
    expect(whole.status === 'ok' && whole.batches.length).toBe(10)
  })

  it('signals still choose batches when the read has a hull: spans, logs and metric rows each by their own rule', async () => {
    // Not what edge writes (a stream holds one signal), but the filter must not depend on it.
    const s = env.SHARD.get(env.SHARD.idFromName(`mixed-${uid()}/0`))
    const tenant = `t-${uid()}`
    const kinds = new Map<number, { signal: number; min: number; max: number }>()
    const metricBatches: Uint8Array[] = []
    for (let h = 0; h < 6; h++) {
      const at = NS0 + BigInt(h) * HOUR
      const sp = [at + 5n * MINUTE, at + 25n * MINUTE]
      kinds.set(await put(s, tenant, spanBatch(sp, h + 1)), { signal: 2, min: Number(sp[0]! / MS), max: Number(sp[1]! / MS) })
      const lg = [at + 30n * MINUTE, at + 50n * MINUTE]
      kinds.set(await put(s, tenant, logBatch(lg, h + 1)), { signal: 3, min: Number(lg[0]! / MS), max: Number(lg[1]! / MS) })
      const mb = encodeBatch([{ __name__: 'up', job: 'a' }], [{ series: 0, ts: T0 + h * 3_600_000 + 600_000, bits: bitsOf(h) }, { series: 0, ts: T0 + h * 3_600_000 + 3_000_000, bits: bitsOf(-h) }])
      metricBatches.push(mb)
      kinds.set(await put(s, tenant, mb), { signal: 1, min: T0 + h * 3_600_000 + 600_000, max: T0 + h * 3_600_000 + 3_000_000 })
    }
    const inc = (await s.describe(tenant))!.incarnation
    const hull = { minTs: T0 + 3_600_000 + 20 * 60_000, maxTs: T0 + 3 * 3_600_000 + 10 * 60_000 }
    const overlapping = (signal: number) => [...kinds].filter(([, k]) => k.signal === signal && k.max >= hull.minTs && k.min <= hull.maxTs).map(([seq]) => seq)
    expect(seqs((await readAll(s, tenant, inc, { signals: [2], ...hull })).batches)).toEqual(overlapping(2))
    expect(seqs((await readAll(s, tenant, inc, { signals: [3], ...hull })).batches)).toEqual(overlapping(3))
    expect(seqs((await readAll(s, tenant, inc, { signals: [2, 3], ...hull })).batches)).toEqual([...overlapping(2), ...overlapping(3)].sort((a, b) => a - b))
    // Metric rows by `ts`, exactly as the engine selects them from the metric batches alone.
    const metric = (await readAll(s, tenant, inc, { signals: [1], ...hull })).batches
    for (const b of metric) expect(b.payload[4]).toBe(1)
    const flat = (bs: Uint8Array[]) => engine.select({ seriesFiles: [], sampleFiles: [], tailBatches: bs }, [], hull.minTs, hull.maxTs).map((x) => ({ labels: x.labels, ts: Array.from(x.ts), bits: bitsFromBytes(x.values) }))
    expect(flat(metric.map((b) => b.payload))).toEqual(flat(metricBatches))
    expect(flat(metric.map((b) => b.payload)).flatMap((x) => x.ts)).toHaveLength(2)
    // Without `signals`: every signal, each by its rule.
    const all = (await readAll(s, tenant, inc, hull)).batches
    expect(seqs(all.filter((b) => b.payload[4] !== 1))).toEqual([...overlapping(2), ...overlapping(3)].sort((a, b) => a - b))
  })
})

describe('pages, cursors and refusals with a hull (D48 unchanged)', () => {
  it('the same batches whatever the page size; skipped batches are not examined; a cursor is bound to its hull', async () => {
    const { s, tenant, inc, bounds, payloads } = await sixHours(61)
    const hull = { signals: [2], minTs: T0 + 3_600_000, maxTs: T0 + 3 * 3_600_000 }
    const one = await readAll(s, tenant, inc, hull)
    const want = [...bounds].filter(([, b]) => b === null || (b.max >= hull.minTs && b.min <= hull.maxTs)).map(([seq]) => seq)
    expect(seqs(one.batches)).toEqual(want)
    expect(one.pages).toHaveLength(1)
    expect(one.pages[0]!.page!.scannedBatches).toBe(want.length)
    expect(one.pages[0]!.page!.scannedBytes).toBe(want.reduce((a, seq) => a + payloads.get(seq)!.byteLength, 0))
    const largest = Math.max(...want.map((seq) => payloads.get(seq)!.byteLength))
    for (const maxBytes of [largest, largest + 1, 2 * largest]) {
      const paged = await readAll(s, tenant, inc, { ...hull, maxBytes })
      expect(seqs(paged.batches), `maxBytes ${maxBytes}`).toEqual(want)
      expect(paged.pages.length).toBeGreaterThan(1)
      expect(new Set(paged.pages.map((p) => p.through))).toEqual(new Set([one.pages[0]!.through]))
    }
    // The scan budget: one examined batch per call; skipped ones cost nothing.
    await s.configure({ tailScanMaxBytes: 1 })
    const slow = await readAll(s, tenant, inc, hull)
    expect(seqs(slow.batches)).toEqual(want)
    expect(slow.pages.reduce((a, p) => a + p.page!.scannedBatches, 0)).toBe(want.length)
    await s.configure({ tailScanMaxBytes: 32 << 20 })
    // A cursor continues only a read with the same hull.
    const first = await s.tailRead(tenant, inc, 0, { ...hull, maxBytes: largest })
    const cursor = (first as Ok).page!.next!
    expect(cursor).toBeTruthy()
    expect(await s.tailRead(tenant, inc, 0, { ...hull, maxTs: hull.maxTs + 1, maxBytes: largest, cursor })).toMatchObject({ status: 'invalid' })
    expect(await s.tailRead(tenant, inc, 0, { signals: [2], maxBytes: largest, cursor })).toMatchObject({ status: 'invalid' })
    expect((await s.tailRead(tenant, inc, 0, { ...hull, maxBytes: largest, cursor })).status).toBe('ok')
    // Storage is the record: the same after eviction.
    await evictDurableObject(s)
    expect(seqs((await readAll(s, tenant, inc, { ...hull, maxBytes: largest })).batches)).toEqual(want)
  })

  it('page_limit names a batch the read keeps, never a skipped one; a discard above the watermark between pages refuses the rest', async () => {
    const s = env.SHARD.get(env.SHARD.idFromName(`b-${uid()}/traces/0`))
    const tenant = `t-${uid()}`
    await s.configure({ retainRecordedMs: 0 })
    // A large batch an hour before the hull, then small ones inside it.
    const big = spanBatch(Array.from({ length: 400 }, (_, i) => NS0 + BigInt(i) * MS), 1)
    await put(s, tenant, big)
    const small = [2, 3, 4].map((k) => spanBatch([NS0 + 2n * HOUR + BigInt(k) * MINUTE], k))
    for (const b of small) await put(s, tenant, b)
    const inc = (await s.describe(tenant))!.incarnation
    const hull = { signals: [2], minTs: T0 + 2 * 3_600_000, maxTs: T0 + 3 * 3_600_000 }
    const fit = Math.max(...small.map((b) => b.byteLength))
    expect(big.byteLength).toBeGreaterThan(fit)
    const page = await s.tailRead(tenant, inc, 0, { ...hull, maxBytes: fit })
    expect(page).toMatchObject({ status: 'ok' })
    expect(seqs((page as Ok).batches)).toEqual([2])
    expect(await s.tailRead(tenant, inc, 0, { ...hull, maxBytes: fit - 1 })).toMatchObject({ status: 'page_limit', seq: 2 })
    expect(await s.tailRead(tenant, inc, 0, { signals: [2], maxBytes: fit })).toMatchObject({ status: 'page_limit', seq: 1 })
    // The fence: records 1..4 recorded and discarded between two pages of a read from 0.
    await s.seal(tenant)
    const cursor = (page as Ok).page!.next!
    expect(await s.recorded(tenant, inc, 4)).toMatchObject({ status: 'ok' })
    await runDurableObjectAlarm(s)
    expect(await s.tailRead(tenant, inc, 0, { ...hull, maxBytes: fit, cursor })).toMatchObject({ status: 'stale_watermark', discardedThrough: 4 })
    expect(await s.tailRead(tenant, inc, 0, hull)).toMatchObject({ status: 'stale_watermark' })
    expect(await s.tailRead(tenant, inc + 1, 4, hull)).toMatchObject({ status: 'incarnation_mismatch', incarnation: inc })
    expect(await s.tailRead(tenant, inc, 4, hull)).toMatchObject({ status: 'ok', batches: [] })
  })
})

describe('rollback and upgrade (contracts/COMPATIBILITY.md §2.3, §8)', () => {
  it('storage this release wrote is served by the release before it on the same storage; what that release writes is kept by every hull after the roll-forward', async () => {
    const name = `b-${uid()}/traces/0`
    const s = env.SHARD.get(env.SHARD.idFromName(name))
    const tenant = `t-${uid()}`
    const mine = [0n, 3n, 6n].map((h) => spanBatch([NS0 + h * HOUR, NS0 + h * HOUR + 10n * MINUTE], Number(h) + 1))
    for (const b of mine) await put(s, tenant, b)
    const inc = (await s.describe(tenant))!.incarnation
    const hull = { signals: [2], minTs: T0 + 3 * 3_600_000, maxTs: T0 + 3 * 3_600_000 + 60_000 }
    expect(seqs((await readAll(s, tenant, inc, hull)).batches)).toEqual([2])
    const theirs = [1n, 4n].map((h) => spanBatch([NS0 + h * HOUR], Number(h) + 10))
    // ROLLBACK: the release before D72 opens the same storage (schema 3, compat 1: it may).
    await runInDurableObject(s, async (_i: Shard, st) => {
      const old = new ShardPrebounds(st, {} as never)
      expect(st.storage.sql.exec(`SELECT version, compat FROM viz_schema`).one()).toMatchObject({ version: SHARD_SCHEMA.migrations.length, compat: 1 })
      // It serves what this release wrote: every span batch, whole (it ignores bounds and the hull's effect on them).
      const r = await old.tailRead(tenant, inc, 0, { ...hull })
      expect(r.status === 'ok' && r.batches.map((b) => [b.seq, hex(b.payload)])).toEqual(mine.map((b, i) => [i + 1, hex(b)]))
      const whole = await old.tailRead(tenant, inc, 0)
      expect(whole.status === 'ok' && whole.batches.length).toBe(3)
      // It takes writes, seals and serves the segment to flush.
      for (const b of theirs) expect(await old.append({ tenant, epoch: 1, fingerprint: `old-${fp++}`, payload: b, rows: rowsOf(b) })).toMatchObject({ status: 'ok' })
      const seg = await old.seal(tenant)
      expect(seg).toMatchObject({ seqLo: 1, seqHi: 5 })
      expect((await old.readSegment(tenant, 1, inc, 5))!.map((b) => hex(b.payload))).toEqual([...mine, ...theirs].map(hex))
      // A retry of a batch this release stored is a duplicate under the old code too.
      expect(await old.append({ tenant, epoch: 1, fingerprint: 'fp-dup-probe', payload: mine[0]!, rows: 2 })).toMatchObject({ status: 'ok', seq: 6 })
    })
    // ROLL FORWARD.
    await evictDurableObject(s)
    expect(await stored(s, tenant)).toEqual([
      ...mine.map((b, i) => ({ seq: i + 1, min: flushBounds(b).minTs, max: flushBounds(b).maxTs })),
      { seq: 4, min: null, max: null }, { seq: 5, min: null, max: null }, { seq: 6, min: null, max: null },
    ])
    // Batches the release before wrote have no bounds: kept by every hull, the far ones included.
    expect(seqs((await readAll(s, tenant, inc, hull)).batches)).toEqual([2, 4, 5, 6])
    expect(seqs((await readAll(s, tenant, inc, { signals: [2], minTs: 0, maxTs: 0 })).batches)).toEqual([4, 5, 6])
    expect((await s.pendingSegments(tenant)).map((x) => [x.seqLo, x.seqHi])).toEqual([[1, 5]])
    expect(await put(s, tenant, spanBatch([NS0 + 9n * HOUR], 30))).toBe(7)
    expect((await stored(s, tenant)).at(-1)).toEqual({ seq: 7, min: T0 + 9 * 3_600_000, max: T0 + 9 * 3_600_000 })
  })

  it('storage at schema 2, made by the release before, migrates to 3 once: rows unchanged and unbounded, served, kept by every hull', async () => {
    const s = env.SHARD.get(env.SHARD.idFromName(`b-${uid()}/logs/0`))
    const tenant = 't'
    const sent = [0n, 2n, 4n].map((h) => logBatch([NS0 + h * HOUR], Number(h) + 1))
    const before = await runInDurableObject(s, async (_i: Shard, st) => {
      await st.storage.deleteAll()
      const old = new ShardPrebounds(st, {} as never)
      for (const b of sent) expect(await old.append({ tenant, epoch: 1, fingerprint: `old-${fp++}`, payload: b, rows: rowsOf(b) })).toMatchObject({ status: 'ok' })
      expect(st.storage.sql.exec(`SELECT version, compat FROM viz_schema`).one()).toMatchObject({ version: 2, compat: 1 })
      return st.storage.sql.exec(`SELECT * FROM batch ORDER BY seq`).toArray()
    })
    expect(before[0]).not.toHaveProperty('min_ts')
    await evictDurableObject(s)
    const inc = (await s.describe(tenant))!.incarnation
    const schema = () => runInDurableObject(s, (_i: Shard, st) => st.storage.sql.exec(`SELECT version, compat FROM viz_schema`).one())
    expect(await schema()).toMatchObject({ version: 3, compat: 1 })
    const after = await runInDurableObject(s, (_i: Shard, st) => st.storage.sql.exec(`SELECT * FROM batch ORDER BY seq`).toArray())
    expect(after).toEqual(before.map((r) => ({ ...r, min_ts: null, max_ts: null })))
    expect(seqs((await readAll(s, tenant, inc, { signals: [3], minTs: 0, maxTs: 0 })).batches)).toEqual([1, 2, 3])
    await evictDurableObject(s)
    expect(await schema()).toMatchObject({ version: 3, compat: 1 })
    const at = await runInDurableObject(s, (_i: Shard, st) => st.storage.sql.exec(`SELECT updated_at FROM viz_schema`).one().updated_at)
    await evictDurableObject(s)
    await s.describe(tenant)
    expect(await runInDurableObject(s, (_i: Shard, st) => st.storage.sql.exec(`SELECT updated_at FROM viz_schema`).one().updated_at)).toBe(at) // not migrated twice
  })
})
