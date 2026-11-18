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
import { clearLimitsCache } from '../src/config'
import { engine } from '../src/index'
import { Bulk, N_SERIES, checkBulkRates } from './bulk'
import { type Tenant, type World, api, cost, discardAll, flushAll, sealAll, world, write } from './world'

const END = Date.UTC(2026, 10, 18, 12)
const HOUR = 3_600_000
const Q = 'sum by (job)(rate(http_requests_total[5m]))'
const sec = (ms: number): string => String(ms / 1000)
const mib = (b: number): string => (b / 2 ** 20).toFixed(2)

/** 24 h 5 min of scrapes up to END, flushed in 10-minute segments; the last 10 minutes stay in the tail. */
async function load(w: World, t: Tenant, intervalMs: number): Promise<{ samples: number; segments: number; ms: number }> {
  const t0 = performance.now()
  const bulk = new Bulk(END - 24 * HOUR - 300_000, intervalMs)
  const perChunk = 600_000 / intervalMs
  let samples = 0
  let segments = 0
  while (bulk.nextTs <= END) {
    const scrapes = Math.min(perChunk, (END - bulk.nextTs) / intervalMs + 1)
    const last = bulk.nextTs + scrapes * intervalMs > END
    await write(t, bulk.series(scrapes))
    samples += scrapes * N_SERIES
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
 * Production wall time from operation counts. Measured inputs (spikes/s1, s2, s4):
 *   Durable Object call          10 to 40 ms
 *   R2 read below 1 MB           45 to 55 ms, six in parallel per leaf (so one wave per leaf call)
 *   ledger plan                  a DO call, plus 25 to 40 microseconds per file listed
 *   engine CPU                   2 x local
 * The ledger is read first (two plan calls in sequence); then shards and leaves run in
 * parallel; leaf rounds are sequential; then the engine.
 */
function estimate(r: Run, engineMs = cost(r.res, 'Engine-Ms'), label = r.label): void {
  const n = (h: string) => cost(r.res, h)
  const plans = 2 * n('Plan-Attempts')
  const ledger = [plans * 10 + (n('Files-Listed') * 0.025), plans * 40 + (n('Files-Listed') * 0.04)]
  const shardSeq = n('Shards-Asked') === 0 ? 0 : Math.ceil(n('Shard-Calls') / n('Shards-Asked'))
  const tail = [shardSeq * 10, shardSeq * 40]
  const cold = [n('Leaf-Rounds') * (10 + 45), n('Leaf-Rounds') * (40 + 55)]
  const io = [Math.max(tail[0]!, cold[0]!), Math.max(tail[1]!, cold[1]!)]
  const eng = 2 * engineMs
  console.log(
    `ESTIMATE ${label} (production, modelled): ledger ${plans} plan calls = ${ledger[0]!.toFixed(0)}-${ledger[1]!.toFixed(0)} ms; ` +
      `then in parallel: shards ${shardSeq} call(s) deep = ${tail[0]}-${tail[1]} ms, leaves ${n('Leaf-Rounds')} round(s) x (DO call 10-40 + one wave of R2 reads 45-55) = ${cold[0]}-${cold[1]} ms -> ${io[0]}-${io[1]} ms; ` +
      `engine 2 x ${engineMs} = ${eng} ms CPU; total ${(ledger[0]! + io[0]! + eng).toFixed(0)}-${(ledger[1]! + io[1]! + eng).toFixed(0)} ms ` +
      `(files from R2; with every file in the Cache API the leaf rounds still cost their DO call, and the cache read is not measured)`,
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

    // 24 h at a 15 s scrape is 11.5 M samples: over every default limit. It is refused
    // from the ledger's row counts, before a single file or shard is read.
    const day = { query: Q, start: sec(END - 24 * HOUR), end: sec(END), step: '300' }
    const d15 = await measure('24 h, 15 s scrape, step 5 m, default limits', w.a, day)
    report(d15)
    console.log(`MEASURE   -> ${d15.body}`)
    expect(d15.status).toBe(422)
    expect(d15.body).toContain('max_scan_samples')
    expect([cost(d15.res, 'Leaf-Calls'), cost(d15.res, 'Shard-Calls')]).toEqual([0, 0])

    // ── Dataset B: scraped every 60 s (2.9 M samples in 24 h). ──
    const b = await load(w, w.b, 60_000)
    console.log(`MEASURE dataset B (60 s scrape): ${b.samples} samples of ${N_SERIES} series through edge, ${b.segments} flushed 10-minute segments (x 2 shards), last 10 minutes in the tail; loading took ${(b.ms / 1000).toFixed(0)} s`)
    // With the tenant's sample limit raised from 2 M to 3 M (48 MiB of samples).
    await env.CONFIG.put(`limits:${w.b.name}`, JSON.stringify({ maxSamples: 3_000_000 }))
    clearLimitsCache()
    const d60 = await measure('24 h, 60 s scrape, step 5 m, maxSamples raised to 3,000,000, files from R2', w.b, day)
    report(d60)
    expect(d60.status).toBe(200)
    checkBulkRates(JSON.parse(d60.body).data, 289, 60_000)
    const d60b = await measure('24 h, 60 s scrape, step 5 m, maxSamples raised to 3,000,000, files from the Cache API', w.b, day)
    report(d60b)
    expect(d60b.body).toBe(d60.body)
    estimate(d60)
    estimate(d60, cost(d60b.res, 'Engine-Ms'), '24 h, 60 s scrape, step 5 m, files from R2, engine code warm')

    // With the default limits the same query is refused, but only by the engine, after
    // every file was read and every sample decoded.
    await env.CONFIG.delete(`limits:${w.b.name}`)
    clearLimitsCache()
    const d60default = await measure('24 h, 60 s scrape, step 5 m, default limits', w.b, day)
    report(d60default)
    console.log(`MEASURE   -> ${d60default.body}`)
    expect(d60default.status).toBe(422)
    expect(d60default.body).toContain('max_samples')

    const h60 = await measure('1 h, 60 s scrape, step 60 s, files from the Cache API', w.b, { query: Q, start: sec(END - HOUR), end: sec(END), step: '60' })
    report(h60)
    expect(h60.status).toBe(200)
    estimate(h60)
  })
})
