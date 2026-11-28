/// <reference path="../../engine/wasm/js/wasm.d.ts" />
/**
 * A span or log query against a tail of eight hours (D72; review m-3 of
 * design/reviews/signals-end-to-end.md), measured here in local workerd: the test, the shard and
 * SQLite in one process, on a shared machine (times are ±2× with its load and printed with it).
 *
 * The tails: eight hours of spans, and eight of log records, one batch per ten minutes of start
 * time (or `ts`), 48 batches each, all above the watermark: a flush backlog, or senders that
 * deliver late. "Before" is the read `query/` makes today (`readSignalTail`: `signals` only, pages
 * of at most 16 MiB): the whole tail. "After" is the read it makes once it sends the time range
 * (shard/README.md, "Needed changes elsewhere"): for a span-local query (tags, tag values,
 * span-local TraceQL metrics) and a log query, the one-hour window; for a search, a whole-trace
 * metrics query or trace by ID with a hint, the window widened by `traceMarginMs` (2 h) on each
 * side (D62).
 *
 * Before bytes are compared, each "after" read must hold, byte for byte, every batch of the tail
 * in which the engine's flush (an independent reader) finds a row inside the read's nanosecond
 * bound, and nothing that is not in the whole tail.
 *
 * Then the append path, as a counterfactual: the same 96 batches appended one after another to
 * this release and to the release before it (frozen, bench/prebounds/), three runs alternating,
 * each run storing exactly the batches it was sent.
 *
 *   BENCH=signaltail npm run bench
 */
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { createEngine } from '../../engine/wasm/js/index'
import wasm from '../../engine/wasm/js/viz_engine.wasm'
import { type Attrs, type LogRow, type LogStream, type SpanRow, encodeLogBatch, encodeSpanBatch } from '../../engine/wasm/test/signal'
import type { Shard, TailReadOptions } from '../src/shard'

const E = env as unknown as { SHARD: DurableObjectNamespace<Shard>; SHARD_PREBOUNDS: DurableObjectNamespace<Shard>; BENCH: string }
const only = (name: string) => E.BENCH === '' || E.BENCH === name
const engine = createEngine(wasm)
const MS = 1_000_000n
const MINUTE = 60_000n * MS
const HOUR = 60n * MINUTE
const T0 = Date.UTC(2026, 10, 19, 0)
const NS0 = BigInt(T0) * MS
const HOURS = 8
const PER_HOUR = 6
const SPANS = 1_500 // per batch
const LOGS = 2_000 // per batch
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!

let ids = 1
const freshId = (len: 16 | 8) => {
  const b = new Uint8Array(len).fill(0x5a)
  new DataView(b.buffer).setUint32(0, ids++, true)
  return b
}
const RES: Attrs = [['host.name', { s: 'ip-10-0-3-17.ec2.internal' }], ['service.name', { s: 'checkout' }], ['service.version', { s: '2.31.0' }], ['telemetry.sdk.language', { s: 'go' }]]

/** One batch: spans starting over `[from, from + 10 min)`, about 300 bytes each. */
function spanBatch(from: bigint, j: number): Uint8Array {
  const rows: SpanRow[] = Array.from({ length: SPANS }, (_, i) => {
    const start = from + (BigInt(i) * 10n * MINUTE) / BigInt(SPANS)
    return {
      entry: 0, traceId: freshId(16), spanId: freshId(8), start, end: start + BigInt(1 + (i % 400)) * MS, name: `GET /api/v1/cart/{id}`, kind: 2, status: i % 50 === 0 ? 2 : 0,
      attrs: [['http.method', { s: 'GET' }], ['http.route', { s: '/api/v1/cart/{id}' }], ['http.status_code', { i: 200n }], ['net.peer.name', { s: `cart-${i % 7}.internal` }], ['user.id', { s: `u-${j}-${i}` }]],
    }
  })
  return encodeSpanBatch([{ resourceFp: 7n, resource: RES, scopeName: 'go.opentelemetry.io/otel', scopeVersion: '1.30.0' }], rows)
}

/** One batch: log records stamped over `[from, from + 10 min)`, about 200 bytes each. */
function logBatch(from: bigint, j: number): Uint8Array {
  const streams: LogStream[] = [{ labels: { service_name: 'checkout', level: 'info' } }, { labels: { service_name: 'checkout', level: 'error' } }]
  const rows: LogRow[] = Array.from({ length: LOGS }, (_, i) => ({
    entry: i % 50 === 0 ? 1 : 0, ts: from + (BigInt(i) * 10n * MINUTE) / BigInt(LOGS), line: `ts=${j}.${i} msg="cart updated" cart_id=c-${(j * 7919 + i) % 100_000} items=${i % 9} duration_ms=${i % 400}`, severity: 9,
    metadata: [['trace_id', `${(j * 1_000_003 + i).toString(16).padStart(32, '0')}`]],
  }))
  return encodeLogBatch(streams, rows)
}

/** The nanosecond bounds the engine's flush finds in a batch. */
function flushNs(b: Uint8Array): [bigint, bigint] {
  const files = b[4] === 2 ? engine.encodeSpans([b]).filter((f) => f.table === 'spans') : engine.encodeLogs([b])
  return [files.reduce((a, f) => (BigInt(f.minNs) < a ? BigInt(f.minNs) : a), 1n << 63n), files.reduce((a, f) => (BigInt(f.maxNs) > a ? BigInt(f.maxNs) : a), 0n)]
}

async function readAll(s: DurableObjectStub<Shard>, inc: number, opts: TailReadOptions) {
  const got: { seq: number; payload: Uint8Array }[] = []
  let cursor: string | undefined
  let calls = 0
  let scanned = 0
  do {
    const r = await s.tailRead('t', inc, 0, { ...opts, maxBytes: 16 << 20, ...(cursor ? { cursor } : {}) })
    if (r.status !== 'ok' || !r.page) throw new Error(JSON.stringify(r).slice(0, 200))
    got.push(...r.batches)
    scanned += r.page.scannedBytes
    cursor = r.page.next ?? undefined
    calls++
  } while (cursor)
  return { got, calls, scanned }
}

const sent = { spans: [] as Uint8Array[], logs: [] as Uint8Array[] }
for (let j = 0; j < HOURS * PER_HOUR; j++) {
  sent.spans.push(spanBatch(NS0 + BigInt(j) * 10n * MINUTE, j))
  sent.logs.push(logBatch(NS0 + BigInt(j) * 10n * MINUTE, j))
}

describe.skipIf(!only('signaltail'))('a span or log query against eight hours of tail (measured here, workerd)', () => {
  it('bytes returned for a one-hour query, before and after', async () => {
    const W = { lo: NS0 + 4n * HOUR, hi: NS0 + 5n * HOUR - 1n } // 04:00 to 05:00, as [start, end) in ns
    const margin = 2n * HOUR
    const cases: { name: string; signal: 2 | 3; bound: [bigint, bigint] | null }[] = [
      { name: 'spans before: the read query makes today (signals only)', signal: 2, bound: null },
      { name: 'spans after: span-local query (tags, span-local metrics), the hour', signal: 2, bound: [W.lo, W.hi] },
      { name: 'spans after: search / whole-trace metrics / by ID with a hint, the hour ± 2 h margin', signal: 2, bound: [W.lo - margin, W.hi + margin] },
      { name: 'spans after: an hour a day before the tail', signal: 2, bound: [W.lo - 24n * HOUR, W.hi - 24n * HOUR] },
      { name: 'logs before: the read query makes today (signals only)', signal: 3, bound: null },
      { name: 'logs after: a log query, the hour', signal: 3, bound: [W.lo, W.hi] },
      { name: 'logs after: an hour a day before the tail', signal: 3, bound: [W.lo - 24n * HOUR, W.hi - 24n * HOUR] },
    ]
    const shards: Record<2 | 3, { s: DurableObjectStub<Shard>; inc: number; flush: [bigint, bigint][]; stored: number }> = {} as never
    for (const signal of [2, 3] as const) {
      const pool = signal === 2 ? 'traces' : 'logs'
      const s = E.SHARD.get(E.SHARD.idFromName(`sigbench-${Date.now().toString(36)}/${pool}/0`))
      await s.configure({ sealBytes: 64 << 20 })
      let inc = 0
      let stored = 0
      for (const [k, payload] of (signal === 2 ? sent.spans : sent.logs).entries()) {
        const r = await s.append({ tenant: 't', epoch: 1, fingerprint: `b${k}`, payload, rows: signal === 2 ? SPANS : LOGS })
        if (r.status !== 'ok') throw new Error(JSON.stringify(r))
        inc = r.incarnation
        stored += payload.byteLength
      }
      shards[signal] = { s, inc, flush: (signal === 2 ? sent.spans : sent.logs).map(flushNs), stored }
    }
    for (const c of cases) {
      const { s, inc, flush } = shards[c.signal]
      const opts: TailReadOptions = c.bound ? { signals: [c.signal], minTs: Number(c.bound[0] / MS), maxTs: Number(c.bound[1] / MS) } : { signals: [c.signal] }
      const times: number[] = []
      let read = await readAll(s, inc, opts)
      for (let rep = 0; rep < 5; rep++) {
        const t = performance.now()
        read = await readAll(s, inc, opts)
        times.push(performance.now() - t)
      }
      // What the engine reads inside the bound is the same from this read as from the whole tail.
      const all = c.signal === 2 ? sent.spans : sent.logs
      const [lo, hi] = c.bound ?? [0n, (1n << 63n) - 1n]
      const needed = all.map((_, k) => k + 1).filter((seq) => flush[seq - 1]![1] >= lo && flush[seq - 1]![0] <= hi)
      const have = new Map(read.got.map((b) => [b.seq, b.payload]))
      for (const seq of needed) expect(have.get(seq), `${c.name}: batch ${seq}`).toEqual(all[seq - 1])
      for (const [seq, p] of have) expect(p, `${c.name}: batch ${seq}`).toEqual(all[seq - 1])
      const bytes = read.got.reduce((a, b) => a + b.payload.byteLength, 0)
      console.log(`ROW ${JSON.stringify({ case: c.name, tailMB: +(shards[c.signal].stored / 1e6).toFixed(2), batches: read.got.length, needed: needed.length, bytes, bytesMB: +(bytes / 1e6).toFixed(2), overMaxFetch16MiB: bytes > 16 << 20, calls: read.calls, scannedMB: +(read.scanned / 1e6).toFixed(2), msMedian: Math.round(median(times)), msMin: Math.round(Math.min(...times)), msMax: Math.round(Math.max(...times)) })}`)
    }
  })

  it('appends: this release against the release before it, the same 96 batches', async () => {
    const batches = [...sent.spans.map((p) => ({ p, rows: SPANS, pool: 'traces' })), ...sent.logs.map((p) => ({ p, rows: LOGS, pool: 'logs' }))]
    const bytes = batches.reduce((a, b) => a + b.p.byteLength, 0)
    for (let run = 0; run < 3; run++) {
      for (const which of run % 2 === 0 ? ['this', 'before'] as const : ['before', 'this'] as const) {
        const ns = which === 'this' ? E.SHARD : E.SHARD_PREBOUNDS
        const tag = `appbench-${which}-${run}-${Date.now().toString(36)}`
        const stubs = { traces: ns.get(ns.idFromName(`${tag}/traces/0`)), logs: ns.get(ns.idFromName(`${tag}/logs/0`)) }
        for (const st of Object.values(stubs)) await st.configure({ sealBytes: 64 << 20 })
        const times: number[] = []
        const t0 = performance.now()
        for (const [k, b] of batches.entries()) {
          const t = performance.now()
          const r = await stubs[b.pool as 'traces' | 'logs'].append({ tenant: 't', epoch: 1, fingerprint: `b${k}`, payload: b.p, rows: b.rows })
          times.push(performance.now() - t)
          if (r.status !== 'ok') throw new Error(JSON.stringify(r))
        }
        const total = performance.now() - t0
        // Each stored exactly what it was sent.
        for (const pool of ['traces', 'logs'] as const) {
          const d = (await stubs[pool].describe('t'))!
          const r = await stubs[pool].tailRead('t', d.incarnation, 0)
          if (r.status !== 'ok') throw new Error(r.status)
          expect(r.batches.map((x) => x.payload)).toEqual(batches.filter((b) => b.pool === pool).map((b) => b.p))
        }
        console.log(`APPEND ${JSON.stringify({ run, release: which, appends: batches.length, MB: +(bytes / 1e6).toFixed(1), msTotal: Math.round(total), msMedian: +median(times).toFixed(1), msMax: Math.round(Math.max(...times)) })}`)
      }
    }
  })
})
