/**
 * The counterfactual of series-level pruning and the series-only read through the whole
 * read path (query/CARDINALITY.md, "Series-level pruning: before and after"). Runs unchanged
 * in this tree and in a copy of the tree as of 2026-11-18 (it uses only hooks and headers
 * that existed then), and prints each answer's SHA-256 so the two runs can be required to
 * give identical answers.
 *
 *   npm run measure -- test/pruning.bench.ts
 *
 * Workload: `x{job, namespace, pod}` for N = 10,000 and 100,000 series (20 jobs, 20
 * namespaces, one pod per series), counters every 60 s for 1 h 5 min through edge as Remote
 * Write, flushed in ten-minute units on 2 shards, then everything flushed (the tail is a
 * separate limit, CARDINALITY.md item 1). Five shapes over the last hour at a 60 s step.
 *
 * Reads are counted where they are issued: the coordinator's (`X-Viz-R2-Gets` plus
 * `X-Viz-Cache-Hits`, bytes `X-Viz-Bytes-Read`) and every split reader's (`leafStats`: its
 * GETs, cache hits and bytes). LOCAL: workerd on this machine, R2 simulated in one process,
 * so times say how much work is done, not what it takes on Cloudflare. Split leaves run one
 * after another (`sequentialLeaves`), so the machine's 1.5 GB per process holds.
 */
import { env } from 'cloudflare:workers'
import { describe, it } from 'vitest'
import { clearLimitsCache } from '../src/config'
import { hooks } from '../src/coordinator'
import { engine } from '../src/index'
import * as leafModule from '../src/leaf'
import { leafHooks } from '../src/leaf'
import { Bulk } from './bulk'
import { type Tenant, type World, api, cost, discardAll, flushAll, sealAll, world, write } from './world'

const END = Date.UTC(2026, 10, 18, 12)
const HOUR = 3_600_000
const sec = (ms: number): string => String(ms / 1000)
const mib = (b: number): string => (b / 2 ** 20).toFixed(2)
const labels = (i: number): Record<string, string> => ({ __name__: 'x', job: `job-${String(i % 20).padStart(2, '0')}`, namespace: `ns-${String(Math.floor(i / 7) % 20).padStart(2, '0')}`, pod: `pod-${String(i).padStart(7, '0')}` })

async function sha(text: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16)
}

async function load(w: World, t: Tenant, n: number): Promise<number> {
  const t0 = performance.now()
  const bulk = new Bulk(END - HOUR - 300_000, 60_000, n, labels)
  while (bulk.nextTs <= END) {
    const scrapes = Math.min(10, (END - bulk.nextTs) / 60_000 + 1)
    await write(t, bulk.series(scrapes))
    await sealAll(w, [t])
    await flushAll(w, [t])
    await discardAll(w)
  }
  return performance.now() - t0
}

async function call(t: Tenant, n: number, shape: string, path: string, params: Record<string, string> | [string, string][]): Promise<void> {
  engine.reset() // a fresh WASM instance: its memory is this call's peak at the coordinator
  const leaf = { gets: 0, hits: 0, bytes: 0, engineMs: 0, ownMs: 0, peak: 0 }
  hooks.leafStats = (_part, st) => {
    leaf.gets += st.r2Gets
    leaf.hits += st.cacheHits
    leaf.bytes += st.bytesRead
    leaf.engineMs += st.ownEngineMs + st.readerEngineMs
    leaf.ownMs += st.ownEngineMs
    leaf.peak = Math.max(leaf.peak, st.wasmMemoryBytes)
  }
  const t0 = performance.now()
  const res = await api(t.key, path, params, { method: 'GET' })
  const body = await res.text()
  const wall = performance.now() - t0
  delete hooks.leafStats
  const c = (h: string) => cost(res, h)
  const split = res.headers.get('X-Viz-Execution') === 'split'
  // Reads issued (the coordinator adds its split readers' to its own counts), and their
  // bytes: what the coordinator read, or for a split what its readers read.
  const reads = c('R2-Gets') + c('Cache-Hits')
  const bytes = split ? leaf.bytes : c('Bytes-Read')
  const err = res.status === 200 ? '' : ` ${(JSON.parse(body) as { error: string }).error.slice(0, 120)}`
  console.log(
    `MEASURE pruning ${n} | ${shape} | HTTP ${res.status}${err} | ${res.headers.get('X-Viz-Execution') || '-'}${c('Split-Leaves') ? ` over ${c('Split-Leaves')} leaves` : ''} | pruning ${res.headers.get('X-Viz-Pruning') ?? '(none: before)'} | ` +
      `reads ${reads} (R2 ${c('R2-Gets')}, cache ${c('Cache-Hits')}), ${mib(bytes)} MiB | files ${c('Files-Read')} of ${c('Files-Listed')} | scan bound ${c('Scan-Samples')}, series estimate ${c('Series-Estimate')} | ` +
      `wall ${wall.toFixed(0)} ms, engine ${c('Engine-Ms') + Math.round(leaf.engineMs)} ms (leaves ${Math.round(leaf.engineMs)}: own ${Math.round(leaf.ownMs)}, readers ${Math.round(leaf.engineMs - leaf.ownMs)}), coordinator WASM ${mib(c('Wasm-Memory-Bytes'))} MiB, leaf peak ${mib(leaf.peak)} MiB | answer ${body.length} B sha ${await sha(body)}`,
  )
}

async function measureAt(w: World, t: Tenant, n: number): Promise<void> {
  // (workerd cannot read /proc: the load average is recorded by the shell around the run.)
  await env.CONFIG.put(`limits:${t.name}`, JSON.stringify({ timeoutMs: 300_000 }))
  clearLimitsCache()
  const ms = await load(w, t, n)
  console.log(`MEASURE pruning ${n} | dataset: ${n} series, 66 scrapes, flushed in 10-minute units on 2 shards, tail empty; loading took ${(ms / 1000).toFixed(0)} s`)
  hooks.sequentialLeaves = true
  leafHooks.resetBeforeEvaluate = true
  try {
    await api(t.key, '/api/v1/query', { query: '1 + 1', time: sec(END) }) // compiles the engine
    const hour = { start: sec(END - HOUR), end: sec(END), step: '60' }
    const pod = `pod-${String(n / 2 + 17).padStart(7, '0')}`
    for (let round = 0; round < 2; round++) {
      const tag = round === 0 ? '' : ' (again: cache warm)'
      await call(t, n, `one series: rate(x{pod}[5m])${tag}`, '/api/v1/query_range', { query: `rate(x{pod="${pod}"}[5m])`, ...hour })
      await call(t, n, `selective: sum by (pod)(rate(x{namespace="ns-03"}[5m]))${tag}`, '/api/v1/query_range', { query: 'sum by (pod) (rate(x{namespace="ns-03"}[5m]))', ...hour })
      await call(t, n, `full metric: sum by (job)(rate(x[5m]))${tag}`, '/api/v1/query_range', { query: 'sum by (job) (rate(x[5m]))', ...hour })
      if ('covers' in leafModule) {
        // This tree only: the same split with readers reading whole files, in the same run.
        ;(leafHooks as { wholeReads?: boolean }).wholeReads = true
        await call(t, n, `full metric, readers reading whole files (same run)${tag}`, '/api/v1/query_range', { query: 'sum by (job) (rate(x[5m]))', ...hour })
        delete (leafHooks as { wholeReads?: boolean }).wholeReads
      }
      await call(t, n, `label values: /label/pod/values?match[]=x${tag}`, '/api/v1/label/pod/values', [['match[]', 'x'], ['start', hour.start], ['end', hour.end]])
      await call(t, n, `series: /series?match[]=x{pod}${tag}`, '/api/v1/series', [['match[]', `x{pod="${pod}"}`], ['start', hour.start], ['end', hour.end]])
    }
  } finally {
    delete hooks.sequentialLeaves
    delete leafHooks.resetBeforeEvaluate
  }
}

describe('series-level pruning, before and after (local)', () => {
  it('10,000 series', async () => {
    const w = await world()
    await measureAt(w, w.a, 10_000)
  })
  it('100,000 series', async () => {
    const w = await world()
    await measureAt(w, w.b, 100_000)
  })
})
