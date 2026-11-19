/**
 * Local measurement of high cardinality through the whole read path (`npm run measure`,
 * README "Cardinality"). One metric with N = 10,000 and 100,000 series (20 jobs, one
 * `instance` per series: the label that makes the cardinality), scraped every 60 s for
 * 1 h 5 min through edge as Remote Write, flushed in ten-minute units on 2 shards, the last
 * ten minutes left in the tails.
 *
 * LOCAL: workerd on this machine, R2 and Durable Objects simulated in one process, so I/O
 * is nearly free and times say how much work is done, not how long it takes on
 * Cloudflare. Split leaves run one after another (`sequentialLeaves`) so that this shared
 * machine's 1.5 GB per process is respected and each leaf's memory is its own.
 *
 * Every query that decomposes is measured twice on the same data: with the series rule
 * (`splitAboveSeries`, leaves sized by series too) and without it (`splitAboveSeries`
 * lifted: the rule before 2026-11-19). Where both answer, the bodies must be identical.
 */
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { clearLimitsCache } from '../src/config'
import { hooks } from '../src/coordinator'
import { engine } from '../src/index'
import { leafHooks } from '../src/leaf'
import { Bulk, JOBS, checkBulkRates } from './bulk'
import { type Tenant, type World, api, cost, discardAll, flushAll, sealAll, world, write } from './world'

const END = Date.UTC(2026, 10, 18, 12)
const HOUR = 3_600_000
const M = 'hc_requests_total'
const sec = (ms: number): string => String(ms / 1000)
const mib = (b: number): string => (b / 2 ** 20).toFixed(2)

const labels = (i: number): Record<string, string> => ({
  __name__: M,
  job: `job-${String(i % JOBS).padStart(2, '0')}`,
  instance: `10.${i >> 16}.${(i >> 8) & 255}.${i & 255}:9100`,
})

/** 1 h 5 min of scrapes up to END, flushed in 10-minute segments; the last 10 minutes stay in the tail. */
async function load(w: World, t: Tenant, n: number): Promise<{ samples: number; segments: number; ms: number }> {
  const t0 = performance.now()
  const bulk = new Bulk(END - HOUR - 300_000, 60_000, n, labels)
  let samples = 0
  let segments = 0
  while (bulk.nextTs <= END) {
    const scrapes = Math.min(10, (END - bulk.nextTs) / 60_000 + 1)
    const last = bulk.nextTs + scrapes * 60_000 > END
    await write(t, bulk.series(scrapes))
    samples += scrapes * n
    if (!last) {
      await sealAll(w, [t])
      await flushAll(w, [t])
      segments++
      await discardAll(w)
    }
  }
  return { samples, segments, ms: performance.now() - t0 }
}

interface Run {
  label: string
  status: number
  wall: number
  res: Response
  body: string
}

async function call(label: string, t: Tenant, path: string, params: Record<string, string> | [string, string][]): Promise<Run> {
  engine.reset() // a fresh WASM instance, so its memory is this call's peak at the coordinator
  const t0 = performance.now()
  const res = await api(t.key, path, params, { method: 'GET' })
  const body = await res.text()
  const r = { label, status: res.status, wall: performance.now() - t0, res, body }
  const n = (h: string) => cost(res, h)
  const err = res.status === 200 ? '' : ` ${(JSON.parse(body) as { error: string }).error.slice(0, 160)}`
  console.log(
    `MEASURE ${label} (local): HTTP ${res.status}${err} | wall ${r.wall.toFixed(0)} ms, engine ${n('Engine-Ms')} ms, coordinator WASM ${mib(n('Wasm-Memory-Bytes'))} MiB | ` +
      `${res.headers.get('X-Viz-Execution') || '-'}${n('Split-Leaves') ? ` over ${n('Split-Leaves')} leaves` : ''}${res.headers.get('X-Viz-Split-Reason') ? ` (${res.headers.get('X-Viz-Split-Reason')})` : ''} | ` +
      `files listed ${n('Files-Listed')}, read ${n('Files-Read')} (${mib(n('Bytes-Read'))} MiB), scan bound ${n('Scan-Samples')}, series estimate ${n('Series-Estimate')} | ` +
      `loaded ${n('Samples-Loaded')} samples of ${n('Series-Loaded')} series | reader calls ${n('Reader-Calls')}, RPC ${mib(n('Rpc-Bytes'))} MiB, leaf peak WASM ${mib(n('Leaf-Peak-Wasm-Bytes'))} MiB, most samples a leaf held ${n('Leaf-Max-Samples')}, reruns ${n('Leaf-Reruns')} | ` +
      `tail ${mib(n('Tail-Bytes'))} MiB | response ${body.length} B`,
  )
  return r
}

async function setLimits(t: Tenant, limits: Record<string, number>): Promise<void> {
  await env.CONFIG.put(`limits:${t.name}`, JSON.stringify({ timeoutMs: 300_000, ...limits }))
  clearLimitsCache()
}

async function measureAt(w: World, t: Tenant, n: number): Promise<void> {
  // (workerd cannot read /proc: the load average is recorded by the shell around the run.)
  console.log(`MEASURE == ${n} series ==`)
  await setLimits(t, {})
  const l = await load(w, t, n)
  console.log(`MEASURE dataset: ${l.samples} samples of ${n} series (${M}, 60 s scrape, 1 h 5 min) through edge; ${l.segments} flushed 10-minute segments x 2 shards; last 10 minutes in the tails; loading took ${(l.ms / 1000).toFixed(0)} s`)

  hooks.sequentialLeaves = true
  leafHooks.resetBeforeEvaluate = true
  try {
    // Warm-up: the first call in an isolate compiles the engine.
    await api(t.key, '/api/v1/query', { query: '1 + 1', time: sec(END) })
    await suite(t, n, 'lake + the last 10 minutes in the tails')
    await sealAll(w, [t])
    await flushAll(w, [t])
    await discardAll(w)
    await suite(t, n, 'everything flushed')
  } finally {
    delete hooks.sequentialLeaves
    delete leafHooks.resetBeforeEvaluate
    delete hooks.forceLeaves
  }
}

async function suite(t: Tenant, n: number, moment: string): Promise<void> {
  console.log(`MEASURE -- ${n} series, ${moment} --`)
  const hour = { start: sec(END - HOUR), end: sec(END), step: '60' }
  const tenMin = { start: sec(END - 600_000), end: sec(END), step: '60' }
  const one = `${M}{instance="10.0.0.5:9100"}`
  const cases: [string, Record<string, string>, number][] = [
    [`sum by (job)(rate(${M}[5m]))`, hour, 61],
    [`sum by (job)(rate(${M}[5m]))`, tenMin, 11],
  ]
  for (const [query, range, points] of cases) {
    const span = range === hour ? '1 h' : '10 min'
    await setLimits(t, {})
    const now = await call(`${n} series, ${moment}: ${query}, ${span}, step 60 s, series rule ON`, t, '/api/v1/query_range', { query, ...range })
    if (now.status === 200) checkBulkRates(JSON.parse(now.body).data, points, 60_000, n / JOBS)
    await setLimits(t, { splitAboveSeries: 1e15 })
    const before = await call(`${n} series, ${moment}: ${query}, ${span}, step 60 s, series rule OFF (the rule before)`, t, '/api/v1/query_range', { query, ...range })
    if (now.status === 200 && before.status === 200) expect(before.body).toBe(now.body)
    await setLimits(t, {})
    const plan = await call(`${n} series, ${moment}: /api/v1/plan of ${query}, ${span}`, t, '/api/v1/plan', { query, ...range })
    console.log(`MEASURE   plan: ${plan.body}`)
  }
  // One series of the metric: every file of the metric is still decoded (no series pruning).
  await call(`${n} series, ${moment}: rate(one series[5m]), 1 h`, t, '/api/v1/query_range', { query: `rate(${one}[5m])`, ...hour })
  await call(`${n} series, ${moment}: sum(rate(one series[5m])), 1 h`, t, '/api/v1/query_range', { query: `sum(rate(${one}[5m]))`, ...hour })
  // The label endpoints Grafana's variables use.
  await call(`${n} series, ${moment}: /label/instance/values?match[]=${M}, 1 h`, t, '/api/v1/label/instance/values', [['match[]', M], ['start', hour.start], ['end', hour.end]])
  await call(`${n} series, ${moment}: /series?match[]=one series, 1 h`, t, '/api/v1/series', [['match[]', one], ['start', hour.start], ['end', hour.end]])
  // The cardinality report over the hour: one place, then over 8 leaves (each part reads every series file).
  const card = await call(`${n} series, ${moment}: /status/cardinality?range=1h`, t, '/api/v1/status/cardinality', { range: '1h', end: sec(END) })
  hooks.forceLeaves = 8
  const card8 = await call(`${n} series, ${moment}: /status/cardinality?range=1h over 8 leaves`, t, '/api/v1/status/cardinality', { range: '1h', end: sec(END) })
  delete hooks.forceLeaves
  if (card.status === 200 && card8.status === 200) expect(card8.body).toBe(card.body)
  await call(`${n} series, ${moment}: /status/tsdb, the hour`, t, '/api/v1/status/tsdb', { start: sec(END - HOUR), end: sec(END) })
}

describe('high cardinality (local)', () => {
  it('10,000 series', async () => {
    const w = await world()
    await measureAt(w, w.a, 10_000)
  })
  it('100,000 series', async () => {
    const w = await world()
    await measureAt(w, w.b, 100_000)
  })
})
