/**
 * Local measurement (not a test of correctness, though it checks its results): the cost
 * of `sum by (job)(rate(http_requests_total[5m]))` over 2,000 series for one hour and
 * for 24 hours, with the data partly flushed. Run with `npm run measure`.
 *
 * Everything here is LOCAL: workerd on this machine, R2 and Durable Objects simulated,
 * so I/O is nearly instant. The production figure printed at the end is an ESTIMATE
 * computed from the operation counts and the latencies measured on Cloudflare in
 * spikes/s1-fanout-r2 and spikes/s2-engine-in-worker.
 */
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { LeafSummary } from '../../engine/wasm-query/js/index'
import { clearLimitsCache } from '../src/config'
import { hooks } from '../src/coordinator'
import { engine } from '../src/index'
import { type EvaluateStats, leafHooks } from '../src/leaf'
import { Bulk, JOBS, N_SERIES, checkBulkRates } from './bulk'
import { type Tenant, type World, api, cost, discardAll, flushAll, sealAll, world, write } from './world'

const END = Date.UTC(2026, 10, 18, 12)
const HOUR = 3_600_000
const Q = 'sum by (job)(rate(http_requests_total[5m]))'
const sec = (ms: number): string => String(ms / 1000)
const mib = (b: number): string => (b / 2 ** 20).toFixed(2)

/** 24 h 5 min of scrapes up to END, flushed in 10-minute segments; the last 10 minutes stay in the tail. */
async function load(w: World, t: Tenant, intervalMs: number, n = N_SERIES): Promise<{ samples: number; segments: number; ms: number }> {
  const t0 = performance.now()
  const bulk = new Bulk(END - 24 * HOUR - 300_000, intervalMs, n)
  const perChunk = 600_000 / intervalMs
  let samples = 0
  let segments = 0
  while (bulk.nextTs <= END) {
    const scrapes = Math.min(perChunk, (END - bulk.nextTs) / intervalMs + 1)
    const last = bulk.nextTs + scrapes * intervalMs > END
    await write(t, bulk.series(scrapes))
    samples += scrapes * n
    if (!last) {
      await sealAll(w, [t])
      await flushAll(w, [t])
      segments++
      if (segments % 6 === 0) await discardAll(w) // or the shards' buffers fill up
    }
  }
  await discardAll(w)
  return { samples, segments, ms: performance.now() - t0 }
}

interface Run {
  label: string
  status: number
  wall: number
  res: Response
  body: string
}

async function measure(label: string, t: Tenant, params: Record<string, string>): Promise<Run> {
  engine.reset() // a fresh WASM instance, so its memory is this query's peak
  const t0 = performance.now()
  const res = await api(t.key, '/api/v1/query_range', params, { method: 'POST' })
  const body = await res.text()
  return { label, status: res.status, wall: performance.now() - t0, res, body }
}

function report(r: Run): void {
  const n = (h: string) => cost(r.res, h)
  console.log(
    `MEASURE ${r.label} (local): HTTP ${r.status}, wall ${r.wall.toFixed(0)} ms | ledger reads ${n('Plan-Attempts')} (2 plan calls each), files listed ${n('Files-Listed')}, skipped ${n('Files-Skipped')}, read ${n('Files-Read')} (${mib(n('Bytes-Read'))} MiB) | ` +
      `leaves used ${n('Leaves-Used')}, leaf calls ${n('Leaf-Calls')} in ${n('Leaf-Rounds')} round(s), R2 GETs ${n('R2-Gets')}, cache hits ${n('Cache-Hits')} | shards asked ${n('Shards-Asked')}, shard calls ${n('Shard-Calls')}, tail ${n('Tail-Batches')} batches (${mib(n('Tail-Bytes'))} MiB) | ` +
      `scan bound ${n('Scan-Samples')} samples, loaded ${n('Samples-Loaded')} samples of ${n('Series-Loaded')} series | engine ${n('Engine-Ms')} ms, peak WASM memory ${mib(n('Wasm-Memory-Bytes'))} MiB | response ${r.body.length} B`,
  )
}

/**
 * Production wall time from operation counts (a MODEL; each input says where it is from):
 *
 *   Durable Object call      10 to 70 ms. Not measured alone. Spike S1 bounds it: twelve
 *                            parallel calls to warm objects that each waited 300 ms took
 *                            368 ms.
 *   one leaf round           55 to 203 ms with warm leaves: at least one DO call plus one
 *                            R2 read (45 ms median, S1), at most what S1 measured for a
 *                            whole round of six reads on each of 16 leaves (203 ms; 173 ms
 *                            on 32 leaves). Leaves get at most six reads per round, so a
 *                            round is one wave of reads.
 *   ledger plan              a DO call plus 25 to 40 microseconds per file listed (S4)
 *   engine CPU               2 x local engine time (S2)
 *
 * The ledger is read first (two plan calls in sequence); then shards and leaves run in
 * parallel; leaf rounds are sequential; then the engine.
 */
const DO_CALL = [10, 70] as const
const ROUND = [55, 203] as const
const PER_FILE = [0.025, 0.04] as const

function estimate(r: Run, engineMs = cost(r.res, 'Engine-Ms'), label = r.label): void {
  const n = (h: string) => cost(r.res, h)
  const plans = 2 * n('Plan-Attempts')
  const ledger = [0, 1].map((i) => plans * DO_CALL[i]! + n('Files-Listed') * PER_FILE[i]!)
  const shardSeq = n('Shards-Asked') === 0 ? 0 : Math.ceil(n('Shard-Calls') / n('Shards-Asked'))
  const tail = [0, 1].map((i) => shardSeq * DO_CALL[i]!)
  const leaves = [0, 1].map((i) => n('Leaf-Rounds') * ROUND[i]!)
  const io = [0, 1].map((i) => Math.max(tail[i]!, leaves[i]!))
  const eng = 2 * engineMs
  const total = [0, 1].map((i) => ledger[i]! + io[i]! + eng)
  console.log(
    `ESTIMATE ${label} (production, modelled): ledger ${plans} plan calls x ${DO_CALL.join('-')} ms + ${n('Files-Listed')} files x ${PER_FILE.join('-')} ms = ${ledger.map((x) => x.toFixed(0)).join('-')} ms; ` +
      `then in parallel: shards ${shardSeq} call(s) deep = ${tail.join('-')} ms, leaves ${n('Leaf-Rounds')} round(s) x ${ROUND.join('-')} ms = ${leaves.join('-')} ms -> ${io.join('-')} ms; ` +
      `engine 2 x ${engineMs} = ${eng} ms CPU; total ${total.map((x) => x.toFixed(0)).join('-')} ms with warm leaves (first use of a leaf object adds 250-700 ms, S1)`,
  )
}

interface LeafRun {
  run: Run
  body: string
  leaves: { part: number; stats: EvaluateStats; summary: LeafSummary }[]
}

/**
 * A split query with its leaves run one after another, each starting from a fresh engine
 * instance, so that each leaf's memory figure is its own peak. Locally every object
 * shares one process: run at once, eight leaves of a day at 15 s held 1.6 GB of RSS
 * together (sessions, readers' file buffers and extracts in flight), more than this shared
 * machine allows one process, and their figures would add up.
 */
async function perLeaf(label: string, t: Tenant, params: Record<string, string>): Promise<LeafRun> {
  const leaves: LeafRun['leaves'] = []
  hooks.sequentialLeaves = true
  leafHooks.resetBeforeEvaluate = true
  hooks.leafStats = (part, stats, summary) => leaves.push({ part, stats, summary })
  try {
    const r = await measure(`${label}, leaves one at a time`, t, params)
    report(r)
    for (const l of leaves) {
      console.log(
        `MEASURE   leaf ${l.part}: ${l.summary.gatheredSamples} samples of ${l.summary.gatheredSeries} series held, ${l.summary.loadedSamples} loaded | ` +
          `${l.stats.readerCalls} reader calls, ${mib(l.stats.extractBytes)} MiB of extracts received, ${mib(l.stats.bytesRead)} MiB of files read by its readers | ` +
          `peak WASM memory ${mib(l.stats.wasmMemoryBytes)} MiB | ${l.stats.ms} ms (local, its readers included)`,
      )
    }
    const peak = Math.max(...leaves.map((l) => l.stats.wasmMemoryBytes))
    console.log(`MEASURE   -> ${leaves.length} leaves; largest per-leaf peak WASM memory ${mib(peak)} MiB; total ${mib(leaves.reduce((a, l) => a + l.stats.extractBytes, 0))} MiB of extracts over RPC`)
    return { run: r, body: r.body, leaves }
  } finally {
    delete hooks.sequentialLeaves
    delete leafHooks.resetBeforeEvaluate
    delete hooks.leafStats
  }
}

/**
 * A split query in production, modelled from the counts (each input says where it is from;
 * see `estimate` for the shared ones):
 *
 *   ledger                  as for one place
 *   tail                    the shards, one call deep (coordinator, before the leaves)
 *   leaves                  one DO call to each leaf (in parallel), then each leaf's reader
 *                           calls, all at once, each one DO call plus one wave of at most six
 *                           reads: from ONE round if every call gets its own six
 *                           connections, to ceil(reader calls / pool) rounds if calls to one
 *                           object share six (not measured: S1 measured one caller)
 *   CPU                     2 x local (S2): the slowest leaf's own time (run alone, its
 *                           readers included: an upper bound, its readers run in parallel
 *                           on Cloudflare) plus the coordinator's merge
 */
function splitEstimate(r: Run, per: LeafRun, pool = 32): void {
  const n = (h: string) => cost(r.res, h)
  const plans = 2 * n('Plan-Attempts')
  const ledger = [0, 1].map((i) => plans * DO_CALL[i]! + n('Files-Listed') * PER_FILE[i]!)
  const tail = [0, 1].map((i) => DO_CALL[i]!)
  const readers = n('Reader-Calls')
  const rounds = [1, Math.ceil(readers / pool)]
  const leaves = [0, 1].map((i) => DO_CALL[i]! + rounds[i]! * ROUND[i]!)
  const slowest = Math.max(...per.leaves.map((l) => l.stats.ms))
  const cpu = [0, 1].map((i) => 2 * (i === 0 ? Math.ceil(slowest / Math.max(1, Math.max(...per.leaves.map((l) => l.stats.readerCalls)))) : slowest) + 2 * n('Engine-Ms'))
  const total = [0, 1].map((i) => ledger[i]! + tail[i]! + leaves[i]! + cpu[i]!)
  console.log(
    `ESTIMATE ${r.label} (production, modelled): ledger ${plans} plan calls x ${DO_CALL.join('-')} ms + ${n('Files-Listed')} files x ${PER_FILE.join('-')} ms = ${ledger.map((x) => x.toFixed(0)).join('-')} ms; ` +
      `tail 1 call = ${tail.join('-')} ms; leaves: 1 DO call + ${rounds.join(' to ')} reader round(s) (${readers} reader calls over a pool of ${pool}) x ${ROUND.join('-')} ms = ${leaves.join('-')} ms; ` +
      `CPU 2 x (slowest leaf ${slowest} ms local, its readers in parallel .. in series) + 2 x merge ${n('Engine-Ms')} ms = ${cpu.join('-')} ms; total ${total.map((x) => x.toFixed(0)).join('-')} ms with warm objects`,
  )
}

describe('measurements (local)', () => {
  it('1 hour and 24 hours over 2,000 series, data partly flushed', async () => {
    const w = await world()
    // ── Dataset A: scraped every 15 s (11.5 M samples in 24 h). ──
    const a = await load(w, w.a, 15_000)
    console.log(`MEASURE dataset A (15 s scrape): ${a.samples} samples of ${N_SERIES} series through edge, ${a.segments} flushed 10-minute segments (x 2 shards), last 10 minutes in the tail; loading took ${(a.ms / 1000).toFixed(0)} s`)

    const oneHour = { query: Q, start: sec(END - HOUR), end: sec(END), step: '15' }
    const h1 = await measure('1 h, 15 s scrape, step 15 s, files from R2, first use of the engine in the isolate', w.a, oneHour)
    report(h1)
    expect(h1.status).toBe(200)
    checkBulkRates(JSON.parse(h1.body).data, 241, 15_000)
    const h1b = await measure('1 h, 15 s scrape, step 15 s, files from the Cache API, engine code warm', w.a, oneHour)
    report(h1b)
    expect(h1b.body).toBe(h1.body)
    expect(cost(h1b.res, 'R2-Gets')).toBe(0)
    estimate(h1)
    estimate(h1, cost(h1b.res, 'Engine-Ms'), '1 h, 15 s scrape, step 15 s, files from R2, engine code warm')

    // 24 h at a 15 s scrape is 11.5 M samples, more than one isolate holds: split over
    // leaves by series, with the default limits.
    const day = { query: Q, start: sec(END - 24 * HOUR), end: sec(END), step: '300' }
    const per = await perLeaf('24 h, 15 s scrape, step 5 m, default limits, split, files from R2', w.a, day)
    const d15 = per.run
    expect(d15.status).toBe(200)
    expect(d15.res.headers.get('X-Viz-Execution')).toBe('split')
    checkBulkRates(JSON.parse(d15.body).data, 289, 15_000)
    const perb = await perLeaf('24 h, 15 s scrape, step 5 m, split, files from the Cache API', w.a, day)
    expect(perb.body).toBe(d15.body)
    expect(cost(perb.run.res, 'R2-Gets')).toBe(0)
    splitEstimate(d15, per)

    // ── Dataset B: scraped every 60 s (2.9 M samples in 24 h). ──
    const b = await load(w, w.b, 60_000)
    console.log(`MEASURE dataset B (60 s scrape): ${b.samples} samples of ${N_SERIES} series through edge, ${b.segments} flushed 10-minute segments (x 2 shards), last 10 minutes in the tail; loading took ${(b.ms / 1000).toFixed(0)} s`)
    // With the default limits it is split (2.9 M samples is over what one place may hold) ...
    const per60 = await perLeaf('24 h, 60 s scrape, step 5 m, default limits, split, files from R2', w.b, day)
    const d60s = per60.run
    expect(d60s.status).toBe(200)
    expect(d60s.res.headers.get('X-Viz-Execution')).toBe('split')
    checkBulkRates(JSON.parse(d60s.body).data, 289, 60_000)
    splitEstimate(d60s, per60)
    // ... and, at 2.9 M samples, it can still be evaluated in one place with the sample
    // limit raised: the SAME BYTES, 2,000 series over 24 hours, at 2 and at 8 leaves.
    await env.CONFIG.put(`limits:${w.b.name}`, JSON.stringify({ maxSamples: 3_000_000, splitAboveSamples: 1e12 }))
    clearLimitsCache()
    const d60 = await measure('24 h, 60 s scrape, step 5 m, ONE PLACE, maxSamples raised to 3,000,000, files from the Cache API', w.b, day)
    report(d60)
    expect(d60.status).toBe(200)
    expect(d60.res.headers.get('X-Viz-Execution')).toBe('single')
    expect(d60s.body).toBe(d60.body)
    await env.CONFIG.delete(`limits:${w.b.name}`)
    clearLimitsCache()
    hooks.forceLeaves = 8
    const d60s8 = await perLeaf('24 h, 60 s scrape, step 5 m, split over 8 leaves', w.b, day)
    delete hooks.forceLeaves
    expect(d60s8.body).toBe(d60.body)
    console.log('MEASURE   -> 24 h at a 60 s scrape: split over 2 and 8 leaves and one place give byte-identical responses')
    estimate(d60)

    const h60 = await measure('1 h, 60 s scrape, step 60 s, files from the Cache API', w.b, { query: Q, start: sec(END - HOUR), end: sec(END), step: '60' })
    report(h60)
    expect(h60.status).toBe(200)
    estimate(h60)
  })

  it('the 7-day, 60 s, 5,000-series query, scaled down to one day (7.2 M samples) and extrapolated', async () => {
    const w = await world()
    const n = 5_000
    const c = await load(w, w.a, 60_000, n)
    console.log(`MEASURE dataset C (60 s scrape, ${n} series): ${c.samples} samples through edge, ${c.segments} flushed 10-minute segments (x 2 shards); loading took ${(c.ms / 1000).toFixed(0)} s`)
    const day = { query: Q, start: sec(END - 24 * HOUR), end: sec(END), step: '1800' }
    const per = await perLeaf('1 day of the 7-day query (5,000 series, 60 s scrape, step 30 m), default limits, split, files from R2', w.a, day)
    const r = per.run
    expect(r.status).toBe(200)
    expect(r.res.headers.get('X-Viz-Execution')).toBe('split')
    checkBulkRates(JSON.parse(r.body).data, 49, 60_000, n / JOBS)
    splitEstimate(r, per)
    const leaves = cost(r.res, 'Split-Leaves')
    const held = Math.max(...per.leaves.map((l) => l.summary.gatheredSamples))
    const peak = Math.max(...per.leaves.map((l) => l.stats.wasmMemoryBytes))
    console.log(
      `EXTRAPOLATE 7 days (modelled from the one-day run): ${7 * c.samples} samples, ${7 * cost(r.res, 'Files-Listed')} files, ${mib(7 * cost(r.res, 'Bytes-Read'))} MiB; ` +
        `leaves ceil(${7 * c.samples} / 1,500,000) = ${Math.ceil((7 * c.samples) / 1_500_000)}, capped at maxLeaves 32 -> ${Math.min(32, Math.ceil((7 * c.samples) / 1_500_000))} leaves of ~${Math.round((7 * c.samples) / 32)} samples ` +
        `(here ${leaves} leaves of at most ${held}); per-leaf peak WASM memory ~${mib(peak)} MiB x ${((7 * c.samples) / 32 / held).toFixed(2)} for the samples part; ` +
        `reader calls ${cost(r.res, 'Reader-Calls')} x 7 x 32 / ${leaves} = ${Math.round((cost(r.res, 'Reader-Calls') * 7 * 32) / leaves)}; scan bound ${7 * cost(r.res, 'Scan-Samples')} (limit maxQueryScanSamples 100,000,000)`,
    )
  })
})