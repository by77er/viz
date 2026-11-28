/// <reference path="../../engine/wasm/js/wasm.d.ts" />
/**
 * The re-check of D72 (design/reviews, "d72-shard-bounds-r2"; 2026-11-26): its three minors.
 *
 *   r2-m-1  tenants in one shard   the two statements the fix added name the tenant in the outer
 *                                  WHERE and in the skip's subquery: two tenants with the same
 *                                  sequence numbers and opposite times each see their own bounds
 *                                  only (adopted from the reviewer's block C)
 *   r2-m-2  rows read              a ranged read that admits only metric batches runs the statement
 *                                  it ran before D72 (one row read per batch, as the release before
 *                                  D72 on the same storage); only a read that admits spans or logs
 *                                  pays the index lookup (2 rows per batch skipped, 3 per bounded
 *                                  batch kept). Measured as the `rowsRead` of every cursor the read itself
 *                                  opened, in local workerd. A metrics-only read skips nothing,
 *                                  pages as before and does not need the index
 *   r2-m-3  configuration          `configure` refuses a value that breaks its field's rule and
 *                                  changes nothing; a stored one is read as the default; so the
 *                                  batch window can never make a read answer a complete, empty `ok`
 *
 * Span and log batches are written by the engine's test encoder (engine/wasm/test/signal.ts), which
 * shares no code with the shard. "The release before D72" is the frozen copy in bench/prebounds/.
 */
import { evictDurableObject, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { encodeLogBatch, encodeSpanBatch } from '../../engine/wasm/test/signal'
import { bitsOf, encodeBatch } from '../../engine/wasm/test/vzb1'
import { Shard as ShardPrebounds } from '../bench/prebounds/shard'
import { DEFAULT_CONFIG, PLAIN_TAIL_SQL, type Shard, type ShardConfig, TAIL_SCAN_MAX_BATCHES, TIMED_TAIL_SQL, type TailBatch, type TailReadOptions, type TailResult } from '../src/shard'
import { decodeCursor } from '../src/tail'

type Stub = DurableObjectStub<Shard>
type Ok = Extract<TailResult, { status: 'ok' }>
/** What both releases answer a tail read with. */
type Reader = { tailRead(tenant: string, incarnation: number, aboveSeq: number, opts?: TailReadOptions): Promise<unknown> }
const MS = 1_000_000n
const HOUR = 3_600_000n * MS
const HOUR_MS = 3_600_000
const T0 = Date.UTC(2026, 10, 19, 6)
const NS0 = BigInt(T0) * MS
let n = 0
const uid = () => `${Date.now().toString(36)}-${n++}`
const shard = (pool: '' | 'traces' | 'logs'): Stub => env.SHARD.get(env.SHARD.idFromName(pool === '' ? `r2-${uid()}/0` : `r2-${uid()}/${pool}/0`))

let ids = 1
function freshId(len: 16 | 8): Uint8Array {
  const b = new Uint8Array(len).fill(0xab)
  new DataView(b.buffer).setUint32(0, ids++, true)
  return b
}
/** Spans starting at `starts`, each ending an hour later; `pad` more bytes of name per row. */
function spanBatch(starts: bigint[], pad = 0): Uint8Array {
  return encodeSpanBatch(
    [{ resourceFp: 7n, resource: [['service.name', { s: 'svc' }]], scopeName: 'lib', scopeVersion: '1', scopeAttrs: '' }],
    starts.map((start, i) => ({ entry: 0, traceId: freshId(16), spanId: freshId(8), start, end: start + HOUR, name: `op-${i}-${'x'.repeat(pad)}`, kind: 1, attrs: [] })),
  )
}
function logBatch(ts: bigint[]): Uint8Array {
  return encodeLogBatch([{ labels: { job: 'j' } }], ts.map((t, i) => ({ entry: 0, ts: t, observedTs: t + 2n * HOUR, line: `l${i}`, severity: 9, metadata: [] })))
}
/** A metric batch of one series with a sample at each of `ts` (ms); `pad` more bytes of label value. */
function metricBatch(ts: number[], pad = 0): Uint8Array {
  return encodeBatch([{ __name__: 'up', job: `a${'x'.repeat(pad)}` }], ts.map((t, i) => ({ series: 0, ts: t, bits: bitsOf(i) })))
}
const rowsOf = (payload: Uint8Array) => new DataView(payload.buffer, payload.byteOffset).getUint32(8, true)
let fp = 0
async function put(s: Stub, tenant: string, payload: Uint8Array): Promise<number> {
  const a = await s.append({ tenant, epoch: 1, fingerprint: `r2-${fp++}`, payload, rows: rowsOf(payload) })
  if (a.status !== 'ok') throw new Error(JSON.stringify(a))
  return a.seq
}
const seqs = (bs: { seq: number }[]) => bs.map((b) => b.seq)
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
const incOf = async (s: Stub, tenant: string) => (await s.describe(tenant))!.incarnation

/** Every page of a filtered read. A cursor must name a later batch than the one before it. */
async function pagesOf(s: Reader, tenant: string, inc: number, opts: TailReadOptions, between?: () => Promise<void>): Promise<{ batches: TailBatch[]; pages: Ok[] }> {
  const pages: Ok[] = []
  let cursor: string | undefined
  let last = 0
  do {
    const r = (await s.tailRead(tenant, inc, 0, { ...opts, ...(cursor ? { cursor } : {}) })) as TailResult
    if (r.status !== 'ok' || !r.page) throw new Error(`tail read: ${JSON.stringify(r).slice(0, 300)}`)
    pages.push(r)
    if (r.page.next !== null) {
      const c = decodeCursor(r.page.next)
      if (!('seq' in c)) throw new Error('cursor')
      if (c.seq <= last) throw new Error(`cursor did not advance: ${c.seq} after ${last}`)
      last = c.seq
      if (pages.length > 500) throw new Error('more than 500 pages')
    }
    cursor = r.page.next ?? undefined
    if (cursor && between) await between()
  } while (cursor)
  return { batches: pages.flatMap((p) => p.batches), pages }
}

/**
 * Runs `read` inside the object and returns its answer with the rows SQLite read for it: the
 * `rowsRead` of every cursor the read opened on the object's storage, summed after the read is
 * over (what Durable Objects bill as rows read; here local workerd's count). `release` chooses the
 * code: this release (the live instance) or the release before D72 on the same storage.
 */
async function measured<T>(s: Stub, release: 'this' | 'before D72', read: (r: Reader) => Promise<T>): Promise<{ answer: T; rowsRead: number; statements: string[] }> {
  return runInDurableObject(s, async (instance: Shard, st) => {
    const sql = st.storage.sql
    const real = sql.exec
    const opened: { q: string; c: { rowsRead: number } }[] = []
    sql.exec = function (this: unknown, q: string, ...args: unknown[]) {
      const c = real.call(sql, q, ...args)
      opened.push({ q, c })
      return c
    } as typeof sql.exec
    try {
      const reader: Reader = release === 'this' ? instance : new ShardPrebounds(st, {} as never)
      opened.length = 0 // not the constructor's statements
      const answer = await read(reader)
      return { answer, rowsRead: opened.reduce((a, o) => a + o.c.rowsRead, 0), statements: opened.map((o) => o.q) }
    } finally {
      sql.exec = real
    }
  })
}

describe('tenants in one shard (re-check of D72, r2-m-1)', () => {
  it('two tenants with the same sequence numbers and opposite times: each ranged read sees its own bounds only, and page_limit.last counts only its own batches', async () => {
    const s = shard('traces')
    const A = `a-${uid()}`
    const B = `b-${uid()}`
    // seq 1: A at hour 0, B at hour 5. seq 2: A at hour 5, B at hour 0. seq 3: A only, hour 0.
    expect([await put(s, A, spanBatch([NS0])), await put(s, B, spanBatch([NS0 + 5n * HOUR])), await put(s, A, spanBatch([NS0 + 5n * HOUR])), await put(s, B, spanBatch([NS0])), await put(s, A, spanBatch([NS0 + 60_000n * MS]))]).toEqual([1, 1, 2, 2, 3])
    const [ia, ib] = [await incOf(s, A), await incOf(s, B)]
    const h0 = { signals: [2], minTs: T0, maxTs: T0 + HOUR_MS - 1 }
    const h5 = { signals: [2], minTs: T0 + 5 * HOUR_MS, maxTs: T0 + 6 * HOUR_MS - 1 }
    const got = {
      A0: seqs((await pagesOf(s, A, ia, h0)).batches), A5: seqs((await pagesOf(s, A, ia, h5)).batches),
      B0: seqs((await pagesOf(s, B, ib, h0)).batches), B5: seqs((await pagesOf(s, B, ib, h5)).batches),
    }
    // Without the tenant in the skip's subquery, B's batch 1 (hour 5) would hide A's batch 1 from A's
    // read of hour 0; without it in the outer WHERE, each read would return the other's batches too.
    expect(got).toEqual({ A0: [1, 3], A5: [2], B0: [2], B5: [1] })
    // The same without `signals` (the statement is the same; the read admits every signal).
    expect(seqs((await pagesOf(s, A, ia, { minTs: h0.minTs, maxTs: h0.maxTs })).batches)).toEqual([1, 3])
    // page_limit.last: for A at hour 0, batch 1 is followed by 3 (kept): not last. For B at hour 5, batch 1 is the last kept.
    expect(await s.tailRead(A, ia, 0, { ...h0, maxBytes: 10 })).toMatchObject({ status: 'page_limit', seq: 1, last: false })
    expect(await s.tailRead(B, ib, 0, { ...h5, maxBytes: 10 })).toMatchObject({ status: 'page_limit', seq: 1, last: true })
    // For A at hour 5, batch 2 is followed only by 3 (skipped): last. B's batch 2 (hour 0, the same seq) must not count for A.
    expect(await s.tailRead(A, ia, 0, { ...h5, maxBytes: 10 })).toMatchObject({ status: 'page_limit', seq: 2, last: true })
    // The index holds each tenant's bounds under its own name, and agrees with the rows.
    const agree = await runInDurableObject(s, (_i: Shard, st) => ({
      index: st.storage.sql.exec(`SELECT tenant, seq, min_ts, max_ts FROM batch INDEXED BY batch_time WHERE min_ts IS NOT NULL AND max_ts IS NOT NULL ORDER BY tenant, seq`).toArray(),
      rows: st.storage.sql.exec(`SELECT tenant, seq, min_ts, max_ts FROM batch NOT INDEXED WHERE min_ts IS NOT NULL AND max_ts IS NOT NULL ORDER BY tenant, seq`).toArray(),
    }))
    expect(agree.index).toEqual(agree.rows)
    expect(agree.index).toHaveLength(5)
    // Storage is the record: the same after an eviction.
    await evictDurableObject(s)
    expect([seqs((await pagesOf(s, A, ia, h0)).batches), seqs((await pagesOf(s, B, ib, h0)).batches)]).toEqual([[1, 3], [2]])
  })

  it('the same for log batches, and for a metrics-only ranged read of a shared metrics shard (the statement from before D72)', async () => {
    const l = shard('logs')
    const A = `a-${uid()}`
    const B = `b-${uid()}`
    expect([await put(l, A, logBatch([NS0])), await put(l, B, logBatch([NS0 + 5n * HOUR])), await put(l, A, logBatch([NS0 + 5n * HOUR])), await put(l, B, logBatch([NS0]))]).toEqual([1, 1, 2, 2])
    const h0 = { minTs: T0, maxTs: T0 + HOUR_MS - 1 }
    expect([seqs((await pagesOf(l, A, await incOf(l, A), { signals: [3], ...h0 })).batches), seqs((await pagesOf(l, B, await incOf(l, B), { signals: [3], ...h0 })).batches)]).toEqual([[1], [2]])
    const m = shard('')
    expect([await put(m, A, metricBatch([T0])), await put(m, B, metricBatch([T0 + 5 * HOUR_MS])), await put(m, A, metricBatch([T0 + 5 * HOUR_MS])), await put(m, B, metricBatch([T0]))]).toEqual([1, 1, 2, 2])
    expect([seqs((await pagesOf(m, A, await incOf(m, A), { signals: [1], ...h0 })).batches), seqs((await pagesOf(m, B, await incOf(m, B), { signals: [1], ...h0 })).batches)]).toEqual([[1], [2]])
  })
})

describe('rows read by a ranged read (re-check of D72, r2-m-2; measured in local workerd)', () => {
  const N = 200
  /** A range that holds every row of the tails below, and one a day before them. */
  const ALL = { minTs: T0 - HOUR_MS, maxTs: T0 + 400 * 60_000 }
  const FAR = { minTs: T0 - 25 * HOUR_MS, maxTs: T0 - 24 * HOUR_MS }

  it('a metrics-only ranged read reads the rows it read before D72 (one per batch), not two: the statement from before D72, on this release and on the release before D72 over the same storage', async () => {
    const s = shard('')
    const tenant = `t-${uid()}`
    for (let k = 0; k < N; k++) await put(s, tenant, metricBatch([T0 + k * 60_000]))
    const inc = await incOf(s, tenant)
    const one = async (release: 'this' | 'before D72', opts: TailReadOptions) => {
      const m = await measured(s, release, (r) => r.tailRead(tenant, inc, 0, opts))
      const a = m.answer as Ok
      expect(a.status).toBe('ok')
      expect(a.page!.next).toBeNull()
      return { rowsRead: m.rowsRead, statements: m.statements, batches: a.batches.length, scanned: a.page!.scannedBatches, payloads: a.batches.map((b) => hex(b.payload)) }
    }
    const got = {
      thisAll: await one('this', { signals: [1], ...ALL }),
      thisFar: await one('this', { signals: [1], ...FAR }),
      thisOneSided: await one('this', { signals: [1], minTs: ALL.minTs }),
      thisUnranged: await one('this', { signals: [1] }),
      beforeAll: await one('before D72', { signals: [1], ...ALL }),
      beforeFar: await one('before D72', { signals: [1], ...FAR }),
      // A read that admits spans too can skip by bounds, so it pays the lookup, as since D72.
      thisMetricsAndSpans: await one('this', { signals: [1, 2], ...ALL }),
      thisNoSignals: await one('this', { ...ALL }),
    }
    // The statement as built at the review's commit (every ranged read ran it), over the same batches.
    const timedDirect = await runInDurableObject(s, (_i: Shard, st) => {
      const c = st.storage.sql.exec(TIMED_TAIL_SQL, tenant, 1, N, tenant, ALL.minTs, ALL.maxTs)
      const rows = c.toArray().length
      return { rows, rowsRead: c.rowsRead }
    })
    const show = (x: { rowsRead: number; batches: number; scanned: number }) => `${x.rowsRead} rows read, ${x.batches} batches returned, ${x.scanned} examined`
    console.log(`r2-m-2 metrics, ${N} batches (rowsRead, local workerd): this release, signals [1], range holding all: ${show(got.thisAll)}; far range: ${show(got.thisFar)}; unranged: ${show(got.thisUnranged)}. `
      + `The release before D72, same storage: ${show(got.beforeAll)}; far: ${show(got.beforeFar)}. TIMED_TAIL_SQL over the same batches (every ranged read before this change): ${timedDirect.rowsRead} rows read. `
      + `This release, signals [1, 2]: ${show(got.thisMetricsAndSpans)}; no signals: ${show(got.thisNoSignals)}`)
    // One statement per call, and the plain one for a read that admits only metrics.
    for (const x of [got.thisAll, got.thisFar, got.thisOneSided, got.thisUnranged]) expect(x.statements).toEqual([PLAIN_TAIL_SQL])
    for (const x of [got.thisMetricsAndSpans, got.thisNoSignals]) expect(x.statements).toEqual([TIMED_TAIL_SQL])
    // Rows read: as the release before D72 for the same read, and as the unranged read; one per batch.
    expect(got.thisAll.rowsRead).toBe(got.beforeAll.rowsRead)
    expect(got.thisFar.rowsRead).toBe(got.beforeFar.rowsRead)
    expect(got.thisAll.rowsRead).toBe(got.thisUnranged.rowsRead)
    expect([got.thisAll.rowsRead, got.thisFar.rowsRead, got.thisOneSided.rowsRead]).toEqual([N, N, N])
    // The timed statement reads a second row per batch (workerd counts the lookup in batch_time, though it finds no entry).
    expect([timedDirect.rows, timedDirect.rowsRead]).toEqual([N, 2 * N])
    expect([got.thisMetricsAndSpans.rowsRead, got.thisNoSignals.rowsRead]).toEqual([2 * N, 2 * N])
    // Nothing is skipped: every batch is examined whatever the range, and the answers are the release before's, byte for byte.
    expect([got.thisAll.batches, got.thisAll.scanned, got.thisFar.batches, got.thisFar.scanned]).toEqual([N, N, 0, N])
    expect(got.thisAll.payloads).toEqual(got.beforeAll.payloads)
    expect(got.thisMetricsAndSpans.payloads).toEqual(got.thisAll.payloads)
  }, 120_000)

  it('a span or log read with a time range reads 2 rows per batch it skips and 3 per batch it keeps (1 without a range): the cost of deciding from the index', async () => {
    const out: Record<string, unknown> = {}
    for (const pool of ['traces', 'logs'] as const) {
      const s = shard(pool)
      const tenant = `t-${uid()}`
      const signal = pool === 'traces' ? 2 : 3
      // One batch per minute; the first half in hour 0 to 1:40, the second half the same.
      for (let k = 0; k < N; k++) await put(s, tenant, pool === 'traces' ? spanBatch([NS0 + BigInt(k) * 60_000n * MS]) : logBatch([NS0 + BigInt(k) * 60_000n * MS]))
      const inc = await incOf(s, tenant)
      const one = async (release: 'this' | 'before D72', opts: TailReadOptions) => {
        const m = await measured(s, release, (r) => r.tailRead(tenant, inc, 0, opts))
        const a = m.answer as Ok
        expect(a.status).toBe('ok')
        expect(a.page!.next).toBeNull()
        return { rowsRead: m.rowsRead, statements: m.statements, batches: a.batches.length }
      }
      const HALF = { minTs: T0, maxTs: T0 + (N / 2) * 60_000 - 1 } // batches 1 … N/2
      const got = {
        unranged: await one('this', { signals: [signal] }),
        all: await one('this', { signals: [signal], ...ALL }),
        half: await one('this', { signals: [signal], ...HALF }),
        far: await one('this', { signals: [signal], ...FAR }),
        beforeAll: await one('before D72', { signals: [signal], ...ALL }),
        beforeFar: await one('before D72', { signals: [signal], ...FAR }),
      }
      out[pool] = Object.fromEntries(Object.entries(got).map(([k, v]) => [k, `${v.rowsRead} rows read, ${v.batches} returned`]))
      expect(got.unranged.statements).toEqual([PLAIN_TAIL_SQL])
      for (const x of [got.all, got.half, got.far]) expect(x.statements).toEqual([TIMED_TAIL_SQL])
      expect([got.unranged.batches, got.all.batches, got.half.batches, got.far.batches]).toEqual([N, N, N / 2, 0])
      // Without a range, and on the release before D72 whatever the range (it returns every batch): one row per batch.
      expect([got.unranged.rowsRead, got.beforeAll.rowsRead, got.beforeFar.rowsRead]).toEqual([N, N, N])
      expect([got.beforeAll.batches, got.beforeFar.batches]).toEqual([N, N])
      // With a range, as workerd counts them: 2 rows per batch skipped.
      expect(got.far.rowsRead).toBe(2 * N)
      // 3 per batch kept (599 for 200 here: one less when the last batch considered is kept).
      expect(got.all.rowsRead).toBeGreaterThan(3 * N - 3)
      expect(got.all.rowsRead).toBeLessThanOrEqual(3 * N)
      expect(got.half.rowsRead).toBeGreaterThan(2 * N + N / 2 - 3)
      expect(got.half.rowsRead).toBeLessThanOrEqual(2 * N + N / 2)
    }
    console.log(`r2-m-2 spans and logs, ${N} batches each (rowsRead, local workerd): ${JSON.stringify(out)}`)
  }, 120_000)
})

describe('a ranged read that admits only metric batches (re-check of D72, r2-m-2)', () => {
  /**
   * A stream mixing the three signals (not what edge writes: a stream holds one signal; the filter
   * must not depend on it). Hour h holds a metric batch with samples at h:10 and h:50, a span batch
   * at h:05 and a log batch at h:30, for six hours: 18 batches, metric ones at seq 1, 4, 7, …
   */
  async function mixed() {
    const s = shard('')
    const tenant = `t-${uid()}`
    const kinds = new Map<number, 1 | 2 | 3>()
    for (let h = 0; h < 6; h++) {
      kinds.set(await put(s, tenant, metricBatch([T0 + h * HOUR_MS + 600_000, T0 + h * HOUR_MS + 3_000_000], h)), 1)
      kinds.set(await put(s, tenant, spanBatch([NS0 + BigInt(h) * HOUR + 300_000n * MS])), 2)
      kinds.set(await put(s, tenant, logBatch([NS0 + BigInt(h) * HOUR + 1_800_000n * MS])), 3)
    }
    return { s, tenant, inc: await incOf(s, tenant), kinds }
  }
  const of = (kinds: Map<number, number>, signal: number) => [...kinds].filter(([, k]) => k === signal).map(([seq]) => seq)
  /** Hours 2 and 3: metric rows 2:10, 2:50, 3:10, 3:50; the span and log batches of those two hours. */
  const RANGE = { minTs: T0 + 2 * HOUR_MS, maxTs: T0 + 4 * HOUR_MS - 1 }

  it('skips nothing: every batch above the watermark is examined, and the answer is the release before D72\'s, byte for byte, page for page', async () => {
    const { s, tenant, inc, kinds } = await mixed()
    const opts = { signals: [1], ...RANGE }
    const mine = await pagesOf(s, tenant, inc, opts)
    // The metric batches of hours 2 and 3 (seq 7 and 10), every row of each inside the range: whole.
    expect(seqs(mine.batches)).toEqual([7, 10])
    expect(mine.batches.map((b) => b.rows)).toEqual([2, 2])
    expect(mine.pages).toHaveLength(1)
    // Every batch was examined, the span and log batches too (dropped by their signal byte, as before D72).
    expect(mine.pages[0]!.page!.scannedBatches).toBe(kinds.size)
    // The release before D72 on the same storage: the same pages (batches, bytes, what was examined, the end of the read).
    const before = await runInDurableObject(s, async (_i: Shard, st) => {
      const r = (await new ShardPrebounds(st, {} as never).tailRead(tenant, inc, 0, opts)) as Ok
      return { status: r.status, through: r.through, page: r.page, batches: r.batches.map((b) => ({ seq: b.seq, rows: b.rows, payload: hex(b.payload) })) }
    })
    const p = mine.pages[0]!
    expect({ status: p.status, through: p.through, page: p.page, batches: p.batches.map((b) => ({ seq: b.seq, rows: b.rows, payload: hex(b.payload) })) }).toEqual(before)
    // A range that cuts a batch keeps the rows inside it only (2:50 and 3:10), still examining everything.
    const cut = await pagesOf(s, tenant, inc, { signals: [1], minTs: T0 + 2 * HOUR_MS + 1_200_000, maxTs: T0 + 3 * HOUR_MS + 1_200_000 })
    expect([seqs(cut.batches), cut.batches.map((b) => b.rows), cut.pages[0]!.page!.scannedBatches]).toEqual([[7, 10], [1, 1], kinds.size])
    // A range that holds no metric row returns nothing, having examined everything.
    const none = await pagesOf(s, tenant, inc, { signals: [1], minTs: T0 - 2 * HOUR_MS, maxTs: T0 - HOUR_MS })
    expect([none.batches.length, none.pages[0]!.page!.scannedBatches, none.pages[0]!.page!.next]).toEqual([0, kinds.size, null])
  })

  it('a read that admits spans or logs as well behaves as since D72: batches outside the range are skipped unexamined, metric rows are chosen by ts', async () => {
    const { s, tenant, inc, kinds } = await mixed()
    // Bounded batches inside the range: the span and log batches of hours 2 and 3.
    const spansIn = of(kinds, 2).slice(2, 4)
    const logsIn = of(kinds, 3).slice(2, 4)
    const metrics = of(kinds, 1)
    const read = async (signals: number[] | undefined) => {
      const r = await pagesOf(s, tenant, inc, { ...(signals ? { signals } : {}), ...RANGE })
      return { seqs: seqs(r.batches), scanned: r.pages.reduce((a, x) => a + x.page!.scannedBatches, 0) }
    }
    const sorted = (...xs: number[][]) => xs.flat().sort((a, b) => a - b)
    // Examined: every metric batch (no bounds), and the span and log batches whose bounds overlap; the other eight are skipped.
    const examined = metrics.length + spansIn.length + logsIn.length
    expect(await read([1, 2])).toEqual({ seqs: sorted([7, 10], spansIn), scanned: examined })
    expect(await read([1, 3])).toEqual({ seqs: sorted([7, 10], logsIn), scanned: examined })
    expect(await read([2, 3])).toEqual({ seqs: sorted(spansIn, logsIn), scanned: examined })
    expect(await read([2])).toEqual({ seqs: spansIn, scanned: examined })
    expect(await read([3])).toEqual({ seqs: logsIn, scanned: examined })
    expect(await read(undefined)).toEqual({ seqs: sorted([7, 10], spansIn, logsIn), scanned: examined })
    // Against a metrics-only read, which examines all eighteen.
    expect(await read([1])).toEqual({ seqs: [7, 10], scanned: kinds.size })
  })

  it('pages as before: the same rows at every page size, batch window and scan budget, across evictions; cursors advance and are bound to the range; page_limit says last only at the end of the tail', async () => {
    const { s, tenant, inc, kinds } = await mixed()
    const opts = { signals: [1], minTs: T0 + HOUR_MS, maxTs: T0 + 5 * HOUR_MS - 1 } // the metric batches of hours 1 to 4: seq 4, 7, 10, 13
    const one = await pagesOf(s, tenant, inc, opts)
    const want = one.batches.map((b) => [b.seq, hex(b.payload)])
    expect(seqs(one.batches)).toEqual([4, 7, 10, 13])
    const largest = Math.max(...one.batches.map((b) => b.payload.byteLength))
    let reads = 0
    for (const window of [1, 2, 5, 17, 18, 19, TAIL_SCAN_MAX_BATCHES]) {
      for (const scan of [1, 32 << 20]) {
        await s.configure({ tailScanMaxBatches: window, tailScanMaxBytes: scan })
        for (const maxBytes of [largest, 2 * largest, undefined]) {
          for (const evict of [false, true]) {
            const paged = await pagesOf(s, tenant, inc, { ...opts, ...(maxBytes ? { maxBytes } : {}) }, evict ? () => evictDurableObject(s) : undefined)
            const label = JSON.stringify({ window, scan, maxBytes, evict })
            expect(paged.batches.map((b) => [b.seq, hex(b.payload)]), label).toEqual(want)
            expect(new Set(paged.pages.map((p) => p.through)), label).toEqual(new Set([kinds.size]))
            // Every batch is examined exactly once over the read, or once more for a batch that did not fit its page (D48).
            const scanned = paged.pages.reduce((a, p) => a + p.page!.scannedBatches, 0)
            expect(scanned, label).toBeGreaterThanOrEqual(kinds.size)
            expect(scanned, label).toBeLessThanOrEqual(kinds.size + want.length)
            for (const p of paged.pages) expect(p.page!.scannedBatches, label).toBeLessThanOrEqual(window)
            if (window < kinds.size) expect(paged.pages.length, label).toBeGreaterThanOrEqual(Math.ceil(kinds.size / window))
            reads++
          }
        }
      }
    }
    await s.configure({ tailScanMaxBatches: TAIL_SCAN_MAX_BATCHES, tailScanMaxBytes: 32 << 20 })
    expect(reads).toBe(84)
    // A cursor continues only the read it came from: the same range, the same signals.
    const first = (await s.tailRead(tenant, inc, 0, { ...opts, maxBytes: largest })) as Ok
    const cursor = first.page!.next!
    expect(cursor).toBeTruthy()
    expect(await s.tailRead(tenant, inc, 0, { ...opts, maxTs: opts.maxTs + 1, maxBytes: largest, cursor })).toMatchObject({ status: 'invalid' })
    expect(await s.tailRead(tenant, inc, 0, { ...opts, signals: [1, 2], maxBytes: largest, cursor })).toMatchObject({ status: 'invalid' })
    expect((await s.tailRead(tenant, inc, 0, { ...opts, maxBytes: largest, cursor })).status).toBe('ok')
    // An append after the first page is not in the read.
    await put(s, tenant, metricBatch([T0 + 2 * HOUR_MS]))
    expect(seqs((await pagesOf(s, tenant, inc, { ...opts, maxBytes: largest, cursor })).batches)).toEqual([7, 10, 13])
    // page_limit: a pure metric tail; `last` only for the tail's last batch (nothing is skipped, so any later batch may hold kept rows).
    const m = shard('')
    for (let k = 0; k < 3; k++) await put(m, tenant, metricBatch([T0 + k * 60_000]))
    const im = await incOf(m, tenant)
    const all = { signals: [1], minTs: T0, maxTs: T0 + HOUR_MS }
    expect(await m.tailRead(tenant, im, 0, { ...all, maxBytes: 10 })).toMatchObject({ status: 'page_limit', seq: 1, last: false })
    expect(await m.tailRead(tenant, im, 2, { ...all, maxBytes: 10 })).toMatchObject({ status: 'page_limit', seq: 3, last: true })
  }, 120_000)

  it('does not need the index batch_time: without it a metrics-only ranged read answers as before, while a span read fails loudly (it never falls back to reading the rows)', async () => {
    const { s, tenant, inc, kinds } = await mixed()
    const opts = { signals: [1], ...RANGE }
    const before = (await pagesOf(s, tenant, inc, opts)).batches.map((b) => [b.seq, hex(b.payload)])
    await runInDurableObject(s, (_i: Shard, st) => {
      st.storage.sql.exec(`DROP INDEX batch_time`)
    })
    await evictDurableObject(s)
    const after = await pagesOf(s, tenant, inc, opts)
    expect(after.batches.map((b) => [b.seq, hex(b.payload)])).toEqual(before)
    expect(after.pages[0]!.page!.scannedBatches).toBe(kinds.size)
    // (Inside the object: an exception thrown there is matched by its message.)
    const span = await runInDurableObject(s, async (i: Shard) => {
      try {
        return (await i.tailRead(tenant, inc, 0, { signals: [2], ...RANGE })).status
      } catch (e) {
        return `throws: ${String(e)}`
      }
    })
    expect(span).toMatch(/^throws: .*no such index: batch_time/)
    // Without a range no read looks at bounds.
    expect(seqs((await pagesOf(s, tenant, inc, { signals: [2] })).batches)).toEqual(of(kinds, 2))
  })
})

describe('configuration values (re-check of D72, r2-m-3)', () => {
  /** A tail of three span batches in the first three milliseconds, and the read of their hour. */
  async function three() {
    const s = shard('traces')
    const tenant = `t-${uid()}`
    for (let k = 0; k < 3; k++) await put(s, tenant, spanBatch([NS0 + BigInt(k) * MS]))
    return { s, tenant, inc: await incOf(s, tenant) }
  }
  const HOUR0 = { signals: [2], minTs: T0, maxTs: T0 + HOUR_MS - 1 }
  /** What a read answers, as one page: the review's reproduction printed `{"status":"ok","through":3,"batches":[],"next":null}`. */
  const show = async (s: Stub, tenant: string, inc: number, opts?: TailReadOptions) => {
    const r = await s.tailRead(tenant, inc, 0, opts)
    return r.status === 'ok' ? { status: r.status, through: r.through, batches: seqs(r.batches), next: r.page ? r.page.next : 'no page' } : { status: r.status }
  }
  const WHOLE = { status: 'ok', through: 3, batches: [1, 2, 3], next: null }
  /** `configure` refused: the reason, or what it answered when it did not refuse. */
  const refusal = async (s: Stub, cfg: unknown): Promise<string> => {
    try {
      await s.configure(cfg as Partial<ShardConfig>)
      return 'accepted'
    } catch (e) {
      return String(e)
    }
  }
  const BAD_NUMBERS: [string, unknown][] = [['undefined', undefined], ['NaN', Number.NaN], ['negative', -1], ['a non-integer', 1.5], ['Infinity', Infinity], ['-Infinity', -Infinity], ['2^53', 2 ** 53], ['a string', '7'], ['null', null], ['true', true], ['an object', {}]]

  it('tailScanMaxBatches that is not a positive integer (undefined, NaN, 0, negative, a non-integer, …) is refused and changes nothing: every filtered read still returns the whole tail', async () => {
    const { s, tenant, inc } = await three()
    expect(await show(s, tenant, inc, HOUR0)).toEqual(WHOLE)
    for (const [name, v] of [...BAD_NUMBERS, ['0', 0] as [string, unknown]]) {
      expect(await refusal(s, { tailScanMaxBatches: v }), name).toMatch(/shard: configure: tailScanMaxBatches must be an integer of at least 1, not .*; nothing was changed/)
      // Ranged, filtered without a range, and unfiltered: never an empty `ok`.
      expect([await show(s, tenant, inc, HOUR0), await show(s, tenant, inc, { signals: [2] }), await show(s, tenant, inc)], name).toEqual([WHOLE, WHOLE, { ...WHOLE, next: 'no page' }])
      expect((await s.configure({})).tailScanMaxBatches, name).toBe(TAIL_SCAN_MAX_BATCHES)
      // Nor after the object is rebuilt from storage.
      await evictDurableObject(s)
      expect(await show(s, tenant, inc, HOUR0), name).toEqual(WHOLE)
    }
    // A call is refused whole: its valid fields are not applied either.
    expect(await refusal(s, { tailScanMaxBytes: 1, tailScanMaxBatches: Number.NaN })).toMatch(/tailScanMaxBatches must be/)
    expect(await s.configure({})).toEqual(DEFAULT_CONFIG)
    expect(await runInDurableObject(s, (_i: Shard, st) => JSON.parse(st.storage.sql.exec(`SELECT v FROM config WHERE k = 'cfg'`).one().v as string))).toEqual(DEFAULT_CONFIG)
    // Valid values still work: a window of 1 pages batch by batch and returns the same batches.
    expect((await s.configure({ tailScanMaxBatches: 1 })).tailScanMaxBatches).toBe(1)
    const paged = await pagesOf(s, tenant, inc, HOUR0)
    expect([seqs(paged.batches), paged.pages.length]).toEqual([[1, 2, 3], 3])
    expect(await refusal(s, [1])).toMatch(/must be an object of fields/)
    expect(await refusal(s, null)).toMatch(/must be an object of fields/)
    expect(await refusal(s, { tailScanMaxBatchs: 5 })).toMatch(/"tailScanMaxBatchs" is not a configuration field/)
    expect((await s.configure({})).tailScanMaxBatches).toBe(1)
  }, 120_000)

  it('the sibling limits: every numeric field refuses undefined, NaN, a negative, a non-integer and a non-number; sizes and counts refuse 0, durations and the limits whose 0 refuses or defers take it; registration is lazy or logged', async () => {
    const { s, tenant, inc } = await three()
    // Listed here independently of the source: which fields 0 is meaningless for.
    const positive = new Set(['maxBatchBytes', 'sealBytes', 'tenantMaxBytes', 'shardMaxBytes', 'seriesWindowMs', 'seriesExactMax', 'maxGroupBytes', 'tailScanMaxBatches', 'registerTimeoutMs', 'maxRegistrations'])
    const fields = Object.keys(DEFAULT_CONFIG) as (keyof ShardConfig)[]
    expect(fields).toHaveLength(26)
    let refused = 0
    for (const k of fields) {
      if (k === 'registration') {
        for (const v of [undefined, null, '', 'eager', 'LOGGED', 1, true]) {
          expect(await refusal(s, { registration: v }), `registration ${String(v)}`).toMatch(/registration must be 'lazy' or 'logged'/)
          refused++
        }
        continue
      }
      expect(typeof DEFAULT_CONFIG[k], k).toBe('number')
      for (const [name, v] of BAD_NUMBERS) {
        expect(await refusal(s, { [k]: v }), `${k} ${name}`).toMatch(new RegExp(`shard: configure: ${k} must be an integer of at least ${positive.has(k) ? 1 : 0}, not `))
        refused++
      }
      if (positive.has(k)) {
        expect(await refusal(s, { [k]: 0 }), `${k} 0`).toMatch(new RegExp(`${k} must be an integer of at least 1, not 0`))
        refused++
      }
    }
    expect(refused).toBe(25 * BAD_NUMBERS.length + 10 + 7)
    // Nothing of all that was applied or stored.
    expect(await s.configure({})).toEqual(DEFAULT_CONFIG)
    expect(await show(s, tenant, inc, HOUR0)).toEqual(WHOLE)
    // 0 where it has a meaning: accepted, and what it means.
    const zeros = Object.fromEntries(fields.filter((k) => k !== 'registration' && !positive.has(k)).map((k) => [k, 0]))
    expect(Object.keys(zeros)).toHaveLength(15)
    expect(await s.configure(zeros)).toEqual({ ...DEFAULT_CONFIG, ...zeros })
    // tailScanMaxBytes 0 examines nothing per call: an `ok` with no batch that says there is more
    // (query's tests use it for a shard whose pages do not advance), never one that ends the read.
    const stuck = await show(s, tenant, inc, HOUR0)
    expect(stuck).toMatchObject({ status: 'ok', batches: [] })
    expect((stuck as { next: unknown }).next).not.toBeNull()
    // maxInFlight 0 refuses every append, retryably; nothing is acknowledged.
    expect(await s.append({ tenant, epoch: 1, fingerprint: `r2-${fp++}`, payload: spanBatch([NS0]), rows: 1 })).toMatchObject({ status: 'backpressure', scope: 'overload' })
    expect(await s.configure(DEFAULT_CONFIG)).toEqual(DEFAULT_CONFIG)
    expect(await show(s, tenant, inc, HOUR0)).toEqual(WHOLE)
    expect((await s.configure({ registration: 'logged' })).registration).toBe('logged')
    expect((await s.configure({ registration: 'lazy' })).registration).toBe('lazy')
  }, 120_000)

  it('a stored configuration with a value that breaks its rule (as a release that stored whatever it was given could leave: NaN is stored as null) is read with the default in its place; valid and unknown fields are kept', async () => {
    const { s, tenant, inc } = await three()
    const store = async (cfg: Record<string, unknown>) => {
      await runInDurableObject(s, (_i: Shard, st) => {
        st.storage.sql.exec(`INSERT OR REPLACE INTO config (k, v) VALUES ('cfg', ?)`, JSON.stringify(cfg))
      })
      await evictDurableObject(s)
    }
    for (const bad of [null, 0, -3, 2.5, '9', {}, [], true]) {
      await store({ ...DEFAULT_CONFIG, tailScanMaxBatches: bad })
      const label = JSON.stringify(bad)
      expect([await show(s, tenant, inc, HOUR0), await show(s, tenant, inc, { signals: [2] })], label).toEqual([WHOLE, WHOLE])
      expect((await s.configure({})).tailScanMaxBatches, label).toBe(TAIL_SCAN_MAX_BATCHES)
    }
    // Several at once, with a valid one and one this release does not know.
    await store({ tailScanMaxBatches: null, tailScanMaxBytes: null, maxInFlight: -1, sealBytes: 0, registration: 'eager', retainRecordedMs: 0, tenantMaxBytes: 4096, laterField: { a: 1 } })
    const cfg = await s.configure({})
    expect(cfg).toEqual({ ...DEFAULT_CONFIG, retainRecordedMs: 0, tenantMaxBytes: 4096, laterField: { a: 1 } })
    expect(await show(s, tenant, inc, HOUR0)).toEqual(WHOLE)
    // A valid stored window is used as stored.
    await store({ tailScanMaxBatches: 2 })
    const paged = await pagesOf(s, tenant, inc, HOUR0)
    expect([seqs(paged.batches), paged.pages.length]).toEqual([[1, 2, 3], 2])
    // A stored row that is not an object of fields is the defaults.
    await store([1, 2] as never)
    expect(await s.configure({})).toEqual(DEFAULT_CONFIG)
  })
})
