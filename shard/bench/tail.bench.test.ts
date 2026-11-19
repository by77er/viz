/// <reference path="../../engine/wasm/js/wasm.d.ts" />
/**
 * A filtered, paged tail read against the whole tail (D42; query/CARDINALITY.md "What is
 * left" 1), measured here in local workerd: the test, the shard and SQLite in one process, on a
 * shared machine (times ±2× with its load, printed). Times are taken around the RPC calls from
 * outside the object, so they include building and passing the answer.
 *
 * The tail is about CARDINALITY.md's: 100,000 series of one metric
 * (`http_requests_total{job, instance}`, 20 jobs) scraped every 60 s for seven minutes, 20 MB,
 * in batches of about 1 MB as `edge` cuts them (CARDINALITY.md's ten minutes were 20.2 MB with
 * its labels; these labels are longer). "Before" is the read every caller makes today (`tailRead` without
 * options: the whole tail); "after" is the read the query needs, filtered and paged.
 *
 * Before any time is compared, the engine (an independent reader of VZB1) must select the same
 * samples, bit for bit, from what each read returned, for the query each case stands for.
 *
 *   BENCH=tail npm run bench
 */
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { Matcher } from '../../contracts/engine'
import { createEngine } from '../../engine/wasm/js/index'
import wasm from '../../engine/wasm/js/viz_engine.wasm'
import { type Row, bitsFromBytes, bitsOf, encodeBatch } from '../../engine/wasm/test/vzb1'
import { type Shard, type TailReadOptions, splitKeyRange } from '../src/shard'

const E = env as unknown as { SHARD: DurableObjectNamespace<Shard>; BENCH: string }
const only = (name: string) => E.BENCH === '' || E.BENCH === name
const engine = createEngine(wasm)
const T0 = Date.UTC(2026, 10, 19, 12)
const SERIES = 100_000
const PER_BATCH = 4_500 // series per batch: about 1 MB with seven samples each
const SCRAPES = 7

const series = (i: number) => ({ __name__: 'http_requests_total', job: `job-${i % 20}`, instance: `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}:9100` })
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!

describe.skipIf(!only('tail'))('tail read: whole vs filtered and paged (measured here, workerd)', () => {
  it('20 MB of tail: a single series, a selective query, a split leaf', async () => {
    const s = E.SHARD.get(E.SHARD.idFromName(`tailbench/${Date.now().toString(36)}`))
    await s.configure({ sealBytes: 64 << 20 }) // all of it unsealed, as between two flushes
    let incarnation = 0
    let stored = 0
    for (let b = 0; b * PER_BATCH < SERIES; b++) {
      const ids = Array.from({ length: Math.min(PER_BATCH, SERIES - b * PER_BATCH) }, (_, k) => b * PER_BATCH + k)
      const rows: Row[] = []
      for (let sc = 0; sc < SCRAPES; sc++) for (const [k, i] of ids.entries()) rows.push({ series: k, ts: T0 + sc * 60_000, bits: bitsOf(i * 10 + sc) })
      const payload = encodeBatch(ids.map(series), rows)
      stored += payload.byteLength
      const r = await s.append({ tenant: 't', epoch: 1, fingerprint: `b${b}`, payload, rows: rows.length })
      if (r.status !== 'ok') throw new Error(JSON.stringify(r))
      incarnation = r.incarnation
    }
    const cases: { name: string; opts: TailReadOptions | null; matchers: Matcher[]; minTs: number; maxTs: number; key?: { part: number; parts: number } }[] = [
      { name: 'before: the whole tail', opts: null, matchers: [{ name: '__name__', op: '=', value: 'http_requests_total' }], minTs: 0, maxTs: Number.MAX_SAFE_INTEGER },
      { name: 'after: one series, rate(m{instance="10.0.164.66:9100"}[5m]) over the tail', opts: { metrics: ['http_requests_total'], labels: [{ name: 'instance', value: '10.0.164.66:9100' }], minTs: T0, maxTs: T0 + 420_000 },
        matchers: [{ name: '__name__', op: '=', value: 'http_requests_total' }, { name: 'instance', op: '=', value: '10.0.164.66:9100' }], minTs: T0, maxTs: T0 + 420_000 },
      { name: 'after: selective, sum(rate(m{job="job-7"}[5m])) for the last 3 minutes', opts: { metrics: ['http_requests_total'], labels: [{ name: 'job', value: 'job-7' }], minTs: T0 + 240_000, maxTs: T0 + 420_000 },
        matchers: [{ name: '__name__', op: '=', value: 'http_requests_total' }, { name: 'job', op: '=', value: 'job-7' }], minTs: T0 + 240_000, maxTs: T0 + 420_000 },
      { name: 'after: one split leaf of 8, its key range', opts: { metrics: ['http_requests_total'], keyRange: splitKeyRange(3, 8) },
        matchers: [{ name: '__name__', op: '=', value: 'http_requests_total' }], minTs: 0, maxTs: Number.MAX_SAFE_INTEGER, key: { part: 3, parts: 8 } },
      { name: 'after: no filter, paged (the cost of paging)', opts: {}, matchers: [{ name: '__name__', op: '=', value: 'http_requests_total' }], minTs: 0, maxTs: Number.MAX_SAFE_INTEGER },
    ]
    const whole = await s.tailRead('t', incarnation, 0)
    if (whole.status !== 'ok') throw new Error(whole.status)
    const wholeBatches = whole.batches.map((b) => b.payload)
    const rows: Record<string, unknown>[] = []
    for (const c of cases) {
      const times: number[] = []
      let got: Uint8Array[] = []
      let calls = 0
      for (let rep = 0; rep < 5; rep++) {
        const t = performance.now()
        got = []
        calls = 0
        if (c.opts === null) {
          const r = await s.tailRead('t', incarnation, 0)
          if (r.status !== 'ok') throw new Error(r.status)
          got = r.batches.map((b) => b.payload)
          calls = 1
        } else {
          let cursor: string | undefined
          do {
            const r = await s.tailRead('t', incarnation, 0, { ...c.opts, cursor })
            if (r.status !== 'ok' || !r.page) throw new Error(JSON.stringify(r).slice(0, 200))
            got.push(...r.batches.map((b) => b.payload))
            cursor = r.page.next ?? undefined
            calls++
          } while (cursor)
        }
        times.push(performance.now() - t)
      }
      // The same samples, bit for bit, from the whole tail and from this read.
      const sel = (batches: Uint8Array[]) => engine.select({ seriesFiles: [], sampleFiles: [], tailBatches: batches }, c.matchers, c.minTs, c.maxTs)
        .map((x) => ({ l: x.labels.instance, ts: [...x.ts], b: bitsFromBytes(x.values).join() }))
      let want = sel(wholeBatches)
      if (c.key) {
        const { lo, hi } = splitKeyRange(c.key.part, c.key.parts)
        const { seriesId } = await import('../../engine/wasm/test/vzb1')
        want = want.filter((x) => { const id = BigInt.asUintN(64, seriesId(series(Number(x.l!.split(':')[0]!.split('.').slice(1).reduce((a, p) => a * 256 + Number(p), 0))))); return id >= BigInt(lo) && id <= BigInt(hi) })
      }
      const have = sel(got)
      expect(have.length, c.name).toBe(want.length)
      expect(have, c.name).toEqual(want)
      const bytes = got.reduce((a, b) => a + b.byteLength, 0)
      rows.push({ case: c.name, calls, batches: got.length, bytes, bytesMB: +(bytes / 1e6).toFixed(3), series: have.length, msMedian: +median(times).toFixed(0), msMin: +Math.min(...times).toFixed(0), msMax: +Math.max(...times).toFixed(0) })
      console.log(`ROW ${JSON.stringify(rows.at(-1))}`)
    }
    console.log(`BENCH ${JSON.stringify({ storedMB: +(stored / 1e6).toFixed(1), batches: wholeBatches.length, rows })}`)
  })
})
