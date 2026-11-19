/// <reference path="../../engine/wasm/js/wasm.d.ts" />
/**
 * Filtered, paged tail reads (D48; query/CARDINALITY.md "What is left" 1):
 *
 *   - storage-location invariance (design/VERIFICATION.md I17): the engine selects the same
 *     samples, bit for bit, from the pages of a filtered read, from the whole tail, and from the
 *     tail flushed to Parquet; and a filtered page holds ONLY what its filter keeps;
 *   - paging: every page within its budget, every kept row exactly once, in order, through the
 *     `through` of the first page; a batch whose kept rows exceed a page is refused, not cut;
 *   - a cursor continues only its own read; a discard between pages that takes rows the read
 *     still needs is `stale_watermark`; versions this shard does not know are refused;
 *   - the form without options answers exactly as before.
 * The batches are written by the engine's own test encoder and read back by the engine (an
 * implementation the shard does not share), never by the shard's filter code.
 */
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { Matcher, SeriesData } from '../../contracts/engine'
import { createEngine } from '../../engine/wasm/js/index'
import wasm from '../../engine/wasm/js/viz_engine.wasm'
import { STALE_NAN, type Row, bitsFromBytes, bitsOf, encodeBatch, seriesId } from '../../engine/wasm/test/vzb1'
import { type Shard, type TailBatch, type TailReadOptions, type TailResult, splitKeyRange } from '../src/shard'

const engine = createEngine(wasm)
let n = 0
const fresh = () => env.SHARD.get(env.SHARD.idFromName(`tail-${Date.now().toString(36)}/${n++}`))
const T0 = Date.UTC(2026, 10, 19, 10)

function rng(seed: number) {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return { next, int: (k: number) => Math.floor(next() * k) }
}

/** 120 series over 5 metrics; `instance` is optional on some (absent label); duplicates of (series, ts) across and within batches. */
const SERIES = Array.from({ length: 120 }, (_, i) => {
  const s: Record<string, string> = { __name__: `m${i % 5}`, job: `job${i % 3}` }
  if (i % 7 !== 0) s.instance = `host-${i}`
  return s
})
const ids = SERIES.map((s) => BigInt.asUintN(64, seriesId(s)))

/** A tail of `batches` batches, each a random selection of series and timestamps over ten minutes. */
async function writeTail(s: DurableObjectStub<Shard>, tenant: string, batches: number, seed: number): Promise<number> {
  const r = rng(seed)
  let incarnation = 0
  for (let b = 0; b < batches; b++) {
    const pick = Array.from({ length: 10 + r.int(60) }, () => r.int(SERIES.length))
    const uniq = [...new Set(pick)]
    const rows: Row[] = []
    for (let k = 0; k < 40 + r.int(400); k++) {
      const si = r.int(uniq.length)
      // On a 15 s grid so that duplicates of (series, ts) happen; a later row wins.
      const ts = T0 + 15_000 * r.int(40)
      rows.push({ series: si, ts, bits: k % 97 === 0 ? STALE_NAN : bitsOf(b * 1000 + k + 0.5) })
    }
    const payload = encodeBatch(uniq.map((i) => SERIES[i]!), rows)
    const a = await s.append({ tenant, epoch: 1, fingerprint: `fp-${seed}-${b}`, payload, rows: rows.length })
    expect(a.status).toBe('ok')
    if (a.status === 'ok') incarnation = a.incarnation
  }
  return incarnation
}

/** Every page of a filtered read, following `next`; checks each page against its budget. */
async function allPages(s: DurableObjectStub<Shard>, tenant: string, inc: number, above: number, opts: TailReadOptions) {
  const pages: Extract<TailResult, { status: 'ok' }>[] = []
  let cursor = opts.cursor
  for (;;) {
    const r = await s.tailRead(tenant, inc, above, { ...opts, cursor })
    if (r.status !== 'ok') throw new Error(`tail read: ${JSON.stringify(r)}`)
    expect(r.page, 'a filtered read answers with a page').toBeDefined()
    const bytes = r.batches.reduce((x, b) => x + b.payload.byteLength, 0)
    if (opts.maxBytes !== undefined) expect(bytes).toBeLessThanOrEqual(opts.maxBytes)
    pages.push(r)
    if (!r.page!.next) return pages
    cursor = r.page!.next
    expect(pages.length).toBeLessThan(10_000)
  }
}

/** What the engine selects, with values as raw bits (a NaN payload change shows). */
const selectBits = (input: { seriesFiles?: Uint8Array[]; sampleFiles?: Uint8Array[]; tailBatches: Uint8Array[] }, matchers: Matcher[], minTs: number, maxTs: number) =>
  engine
    .select({ seriesFiles: input.seriesFiles ?? [], sampleFiles: input.sampleFiles ?? [], tailBatches: input.tailBatches }, matchers, minTs, maxTs)
    .map((x: SeriesData) => ({ labels: x.labels, ts: [...x.ts], bits: bitsFromBytes(x.values).map(String) }))
    .sort((a, b) => (JSON.stringify(a.labels) < JSON.stringify(b.labels) ? -1 : 1))

const ALL: Matcher[] = [{ name: '__name__', op: '=~', value: '.+' }]

/** The size of the largest batch a read returns (with `filter`, the largest kept part): a page budget that always fits one and rarely two. */
async function largestBatch(s: DurableObjectStub<Shard>, tenant: string, inc: number, filter?: TailReadOptions): Promise<number> {
  const whole = await s.tailRead(tenant, inc, 0, filter)
  if (whole.status !== 'ok') throw new Error(whole.status)
  return Math.max(...whole.batches.map((b) => b.payload.byteLength))
}
const payloads = (bs: TailBatch[]) => bs.map((b) => b.payload)

describe('a filtered read returns what the engine would select, and only that (storage-location invariance)', () => {
  it('for a single series, a selective query, a time range, split key ranges and no filter; from pages, from the whole tail and from Parquet', async () => {
    const s = fresh()
    const tenant = 't'
    const inc = await writeTail(s, tenant, 24, 1)
    const whole = await s.tailRead(tenant, inc, 0)
    if (whole.status !== 'ok') throw new Error(whole.status)
    expect(whole.page, 'the form without options is unchanged').toBeUndefined()
    // The whole tail flushed to Parquet by the engine: the same rows in another place.
    const files = engine.encodeSegment(payloads(whole.batches))
    const lake = { seriesFiles: files.filter((f) => f.table === 'metric_series').map((f) => f.bytes), sampleFiles: files.filter((f) => f.table === 'metric_samples').map((f) => f.bytes) }
    const cases: { name: string; opts: TailReadOptions; matchers: Matcher[]; minTs: number; maxTs: number; key?: { lo: bigint; hi: bigint } }[] = [
      { name: 'one series', opts: { metrics: ['m3'], labels: [{ name: 'instance', value: 'host-8' }, { name: 'job', value: 'job2' }] }, matchers: [{ name: '__name__', op: '=', value: 'm3' }, { name: 'instance', op: '=', value: 'host-8' }, { name: 'job', op: '=', value: 'job2' }], minTs: 0, maxTs: Number.MAX_SAFE_INTEGER },
      { name: 'series without a label', opts: { metrics: ['m0'], labels: [{ name: 'instance', value: '' }] }, matchers: [{ name: '__name__', op: '=', value: 'm0' }, { name: 'instance', op: '=', value: '' }], minTs: 0, maxTs: Number.MAX_SAFE_INTEGER },
      { name: 'two metrics, two minutes', opts: { metrics: ['m1', 'm4'], minTs: T0 + 120_000, maxTs: T0 + 240_000 }, matchers: [{ name: '__name__', op: '=~', value: 'm1|m4' }], minTs: T0 + 120_000, maxTs: T0 + 240_000 },
      { name: 'time only', opts: { minTs: T0 + 300_000 }, matchers: ALL, minTs: T0 + 300_000, maxTs: Number.MAX_SAFE_INTEGER },
      { name: 'no filter, paged', opts: {}, matchers: ALL, minTs: 0, maxTs: Number.MAX_SAFE_INTEGER },
      ...[0, 1, 2, 3].map((j) => {
        const r = splitKeyRange(j, 4)
        return { name: `key range ${j}/4`, opts: { keyRange: r }, matchers: ALL, minTs: 0, maxTs: Number.MAX_SAFE_INTEGER, key: { lo: BigInt(r.lo), hi: BigInt(r.hi) } }
      }),
    ]
    let partsSeries = 0
    for (const c of cases) {
      const pages = await allPages(s, tenant, inc, 0, { ...c.opts, maxBytes: 6_000 })
      const got = pages.flatMap((p) => payloads(p.batches))
      // Everything the filter keeps, and nothing else: selecting ALL from the pages gives what
      // the case's own selection gives from the whole tail and from the lake.
      let want = selectBits({ tailBatches: payloads(whole.batches) }, c.matchers, c.minTs, c.maxTs)
      if (c.key) want = want.filter((x) => { const id = BigInt.asUintN(64, seriesId(x.labels)); return id >= c.key!.lo && id <= c.key!.hi })
      const fromPages = selectBits({ tailBatches: got }, ALL, 0, Number.MAX_SAFE_INTEGER)
      expect(fromPages, `${c.name}: the pages hold exactly the selection`).toEqual(want)
      if (!c.key) {
        expect(selectBits({ ...lake, tailBatches: [] }, c.matchers, c.minTs, c.maxTs), `${c.name}: the lake agrees`).toEqual(want)
        expect(selectBits({ tailBatches: got }, c.matchers, c.minTs, c.maxTs), `${c.name}: the same selection over the pages`).toEqual(want)
      } else partsSeries += want.length
      expect(want.length, `${c.name}: not trivially empty`).toBeGreaterThan(0)
      // Pages: one `through`, sequence numbers increasing, no batch twice.
      const seqs = pages.flatMap((p) => p.batches.map((b) => b.seq))
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
      expect(new Set(seqs).size).toBe(seqs.length)
      expect(new Set(pages.map((p) => p.through))).toEqual(new Set([whole.through]))
    }
    // The key ranges of a split partition the series.
    expect(partsSeries).toBe(selectBits({ tailBatches: payloads(whole.batches) }, ALL, 0, Number.MAX_SAFE_INTEGER).length)
    void ids
  })

  it('a batch the filter keeps whole is returned as stored; a staleness marker keeps its payload', async () => {
    const s = fresh()
    const rows: Row[] = [{ series: 0, ts: T0, bits: STALE_NAN }, { series: 0, ts: T0 + 15_000, bits: 0x7ff8000000000123n }]
    const payload = encodeBatch([{ __name__: 'm', job: 'x' }], rows)
    const a = await s.append({ tenant: 't', epoch: 1, fingerprint: 'one', payload, rows: 2 })
    if (a.status !== 'ok') throw new Error(a.status)
    const r = await s.tailRead('t', a.incarnation, 0, { metrics: ['m'] })
    expect(r.status === 'ok' && [...r.batches[0]!.payload]).toEqual([...payload])
    const cut = await s.tailRead('t', a.incarnation, 0, { minTs: T0 + 1 })
    if (cut.status !== 'ok') throw new Error(cut.status)
    expect(selectBits({ tailBatches: payloads(cut.batches) }, ALL, 0, Number.MAX_SAFE_INTEGER)[0]!.bits).toEqual([String(0x7ff8000000000123n)])
  })
})

describe('pages', () => {
  it('a batch whose kept rows exceed the page is refused, never cut; with room it is returned', async () => {
    const s = fresh()
    const inc = await writeTail(s, 't', 4, 2)
    const big = await s.tailRead('t', inc, 0, { maxBytes: 64 })
    expect(big).toMatchObject({ status: 'page_limit', seq: 1, maxBytes: 64 })
    if (big.status === 'page_limit') expect(big.bytes).toBeGreaterThan(64)
    const ok = await s.tailRead('t', inc, 0, { maxBytes: 1 << 20 })
    expect(ok.status === 'ok' && ok.batches.length).toBe(4)
  })

  it('the scan budget ends a page early with a cursor (an empty page is a continuation, not the end)', async () => {
    const s = fresh()
    await s.configure({ tailScanMaxBytes: 1 })
    const inc = await writeTail(s, 't', 5, 3)
    const pages = await allPages(s, 't', inc, 0, { metrics: ['no-such-metric'] })
    expect(pages.length).toBe(5) // one stored batch examined per call
    expect(pages.every((p) => p.batches.length === 0)).toBe(true)
  })

  it('appends after the first page are not in the read (its `through` is fixed); a read from a later watermark starts after it', async () => {
    const s = fresh()
    const inc = await writeTail(s, 't', 6, 4)
    const page = await largestBatch(s, 't', inc)
    const first = await s.tailRead('t', inc, 0, { maxBytes: page })
    if (first.status !== 'ok' || !first.page?.next) throw new Error('expected more pages')
    await writeTail(s, 't', 2, 5)
    const rest = await allPages(s, 't', inc, 0, { maxBytes: page, cursor: first.page.next })
    const seqs = [...first.batches, ...rest.flatMap((p) => p.batches)].map((b) => b.seq)
    expect(Math.max(...seqs)).toBe(6)
    const later = await s.tailRead('t', inc, 6, {})
    expect(later.status === 'ok' && later.batches.map((b) => b.seq)).toEqual([7, 8])
  })

  it('a cursor continues only its own read; unknown versions are refused', async () => {
    const s = fresh()
    const inc = await writeTail(s, 't', 6, 6)
    await writeTail(s, 'u', 2, 7)
    const first = await s.tailRead('t', inc, 0, { metrics: ['m1'], maxBytes: await largestBatch(s, 't', inc, { metrics: ['m1'] }) })
    if (first.status !== 'ok' || !first.page?.next) throw new Error('expected more pages')
    const cursor = first.page.next
    const invalid = (r: TailResult) => expect(r).toMatchObject({ status: 'invalid' })
    invalid(await s.tailRead('t', inc, 0, { metrics: ['m2'], cursor })) // another filter
    invalid(await s.tailRead('t', inc, 1, { metrics: ['m1'], cursor })) // another watermark
    const uInc = (await s.describe('u'))!.incarnation
    invalid(await s.tailRead('u', uInc, 0, { metrics: ['m1'], cursor })) // another tenant
    invalid(await s.tailRead('t', inc, 0, { metrics: ['m1'], cursor: 'v1.bm90IGEgY3Vyc29y' }))
    invalid(await s.tailRead('t', inc, 0, { minTs: 5, maxTs: 4 }))
    invalid(await s.tailRead('t', inc, 0, { keyRange: { lo: '18446744073709551616', hi: '1' } }))
    expect(await s.tailRead('t', inc, 0, { metrics: ['m1'], cursor: cursor.replace(/^v1\./, 'v2.') })).toEqual({ status: 'unsupported_version', version: 2, supported: 1 })
    expect(await s.tailRead('t', inc, 0, { v: 2 })).toEqual({ status: 'unsupported_version', version: 2, supported: 1 })
    expect((await s.tailRead('t', inc, 0, { metrics: ['m1'], cursor })).status).toBe('ok') // its own read
  })

  it('a discard above the read\'s watermark between pages refuses the rest of the read (stale_watermark), never a page with a hole', async () => {
    const s = fresh()
    await s.configure({ retainRecordedMs: 0 })
    const inc = await writeTail(s, 't', 6, 8)
    // Seal 1..3 as one segment and 4..6 as another (seal() closes what is unsealed).
    await s.seal('t')
    const first = await s.tailRead('t', inc, 0, { maxBytes: await largestBatch(s, 't', inc) })
    if (first.status !== 'ok' || !first.page?.next) throw new Error('expected more pages')
    const returned = Math.max(...first.batches.map((b) => b.seq))
    // The ledger records 1..6 and the shard discards it: the read still needs rows above `returned`.
    expect(await s.recorded('t', inc, 6)).toMatchObject({ status: 'ok' })
    await runDurableObjectAlarm(s)
    const next = await s.tailRead('t', inc, 0, { maxBytes: 1 << 20, cursor: first.page.next })
    expect(next).toMatchObject({ status: 'stale_watermark', discardedThrough: 6 })
    expect(returned).toBeLessThan(6)
  })

  it('the stream checks come first: another incarnation, a lost stream, a watermark below the fence; and they survive eviction', async () => {
    const s = fresh()
    const inc = await writeTail(s, 't', 3, 9)
    expect(await s.tailRead('t', inc + 1, 0, {})).toMatchObject({ status: 'incarnation_mismatch', incarnation: inc })
    expect(await s.tailRead('nobody', 5, 0, {})).toEqual({ status: 'incarnation_mismatch', incarnation: 0 })
    expect(await s.tailRead('nobody', 0, 0, {})).toMatchObject({ status: 'ok', batches: [], page: { next: null } })
    const before = await allPages(s, 't', inc, 0, { metrics: ['m2'], maxBytes: 2_000 })
    await evictDurableObject(s)
    const after = await allPages(s, 't', inc, 0, { metrics: ['m2'], maxBytes: 2_000 })
    expect(after.map((p) => p.batches)).toEqual(before.map((p) => p.batches))
    void runInDurableObject
  })
})
