/**
 * Local measurement of the filtered, paged tail (D48; CARDINALITY.md "What is left" 1)
 * through the whole read path: `npm run measure -- test/tail.bench.ts`.
 *
 * The shard's case (shard/README.md, "Tail reads filtered and paged"): 100,000 series of one
 * metric (`tb_requests_total{job, instance}`, 20 jobs) at 60 s, seven minutes of it unflushed
 * in two shards' tails (about 22 MB), written through edge as Remote Write, after ten minutes
 * that are flushed (one unit) so that queries over the last fifteen minutes read lake and tail.
 *
 * Both ways on the same data, each call three times (the first cold for the engine code):
 *
 *   before   the shards answer as the previous release does (no filter, no paging: the whole
 *            tail), which is what the coordinator received before this change; `maxFetchBytes`
 *            raised to 64 MiB so that it answers at all (with the default, 16 MiB, every call
 *            is refused: that is the "before" a tenant saw);
 *   after    this release with the default limits.
 *
 * Where both answer, the bodies must be byte-identical. LOCAL: workerd on this machine, R2,
 * shards and leaves in one process; RPC is a copy in memory, so times say how much work is
 * done, not what Cloudflare takes. Split leaves run one after another (`sequentialLeaves`)
 * so that this shared machine's 1.5 GB per process holds.
 */
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { clearLimitsCache } from '../src/config'
import { hooks } from '../src/coordinator'
import { engine } from '../src/index'
import { leafHooks } from '../src/leaf'
import { tailHooks } from '../src/tail'
import { Bulk, JOBS } from './bulk'
import { type Tenant, type World, api, cost, discardAll, flushAll, sealAll, world, write } from './world'

const END = Date.UTC(2026, 10, 18, 12)
const M = 'tb_requests_total'
const N = 100_000
const sec = (ms: number): string => String(ms / 1000)
const mib = (b: number): string => (b / 2 ** 20).toFixed(2)

const labels = (i: number): Record<string, string> => ({
  __name__: M,
  job: `job-${String(i % JOBS).padStart(2, '0')}`,
  instance: `10.${i >> 16}.${(i >> 8) & 255}.${i & 255}:9100`,
})

async function setLimits(t: Tenant, limits: Record<string, number>): Promise<void> {
  await env.CONFIG.put(`limits:${t.name}`, JSON.stringify({ timeoutMs: 600_000, ...limits }))
  clearLimitsCache()
}

interface Out {
  status: number
  body: string
  wall: number[]
  res: Response
}

async function three(label: string, t: Tenant, path: string, params: Record<string, string> | [string, string][]): Promise<Out> {
  const wall: number[] = []
  let last: { res: Response; body: string } | null = null
  for (let i = 0; i < 3; i++) {
    engine.reset()
    const t0 = performance.now()
    const res = await api(t.key, path, params)
    const body = await res.text()
    wall.push(performance.now() - t0)
    if (last && body !== last.body) throw new Error(`${label}: run ${i} answered differently`)
    last = { res, body }
  }
  const { res, body } = last!
  const n = (h: string) => cost(res, h)
  const err = res.status === 200 ? '' : ` ${(JSON.parse(body) as { error: string }).error.slice(0, 140)}`
  const sorted = [...wall].sort((a, b) => a - b)
  console.log(
    `MEASURE ${label} (local): HTTP ${res.status}${err} | wall ${wall.map((x) => x.toFixed(0)).join(' / ')} ms (median ${sorted[1]!.toFixed(0)}) | engine ${n('Engine-Ms')} ms, coordinator WASM ${mib(n('Wasm-Memory-Bytes'))} MiB | ` +
      `${res.headers.get('X-Viz-Execution') || '-'}${n('Split-Leaves') ? ` over ${n('Split-Leaves')} leaves` : ''} | tail ${res.headers.get('X-Viz-Tail-Mode') || '-'}: ${n('Tail-Batches')} batches, ${mib(n('Tail-Bytes'))} MiB, ${n('Shard-Calls')} shard calls | ` +
      `files ${n('Files-Read')} (${mib(n('Bytes-Read'))} MiB) | loaded ${n('Samples-Loaded')} samples of ${n('Series-Loaded')} series | leaf calls ${n('Leaf-Calls')}, reader calls ${n('Reader-Calls')}, RPC ${mib(n('Rpc-Bytes'))} MiB, leaf peak WASM ${mib(n('Leaf-Peak-Wasm-Bytes'))} MiB | response ${body.length} B`,
  )
  return { status: res.status, body, wall, res }
}

describe('the tail, filtered and paged (local)', () => {
  it('100,000 series, about 22 MB unflushed', async () => {
    const w: World = await world()
    const t = w.a
    // Large enough that seven minutes stay unflushed and unrefused (the defaults: 4 MiB seals, 64 MiB a tenant).
    for (const s of w.shards) await shardOf(w, s).configure({ tenantMaxBytes: 256 << 20 })
    await setLimits(t, {})
    const t0 = performance.now()
    const bulk = new Bulk(END - 17 * 60_000 + 60_000, 60_000, N, labels)
    // Ten minutes, flushed (one unit per shard)...
    await write(t, bulk.series(10))
    await sealAll(w, [t])
    await flushAll(w, [t])
    await discardAll(w)
    // ...then seven minutes left in the tails (sealed segments not flushed, and the open one).
    for (let k = 0; k < 7; k++) await write(t, bulk.series(1))
    console.log(`MEASURE dataset: ${N} series (${M}, 60 s), 10 minutes flushed + 7 minutes in the tails; loading took ${((performance.now() - t0) / 1000).toFixed(0)} s`)

    hooks.sequentialLeaves = true
    leafHooks.resetBeforeEvaluate = true
    try {
      await api(t.key, '/api/v1/query', { query: '1 + 1', time: sec(END) })
      const range = { start: sec(END - 15 * 60_000), end: sec(END), step: '60' }
      const cases: [string, string, Record<string, string> | [string, string][], number | undefined][] = [
        ['one series, rate(m{instance}[5m]), 15 min', '/api/v1/query_range', { query: `rate(${M}{instance="10.0.164.66:9100"}[5m])`, ...range }, undefined],
        ['selective, sum(rate(m{job="job-07"}[5m])), 15 min', '/api/v1/query_range', { query: `sum(rate(${M}{job="job-07"}[5m]))`, ...range }, undefined],
        ['full metric, sum by (job)(rate(m[5m])), 15 min, 8 leaves', '/api/v1/query_range', { query: `sum by (job) (rate(${M}[5m]))`, ...range }, 8],
        ['full metric, sum by (job)(rate(m[5m])), 15 min, leaves as sized', '/api/v1/query_range', { query: `sum by (job) (rate(${M}[5m]))`, ...range }, undefined],
        ['/label/job/values?match[]=m, 15 min', '/api/v1/label/job/values', [['match[]', M], ['start', range.start], ['end', range.end]], undefined],
        ['/series?match[]=m{instance}, 15 min', '/api/v1/series', [['match[]', `${M}{instance="10.0.164.66:9100"}`], ['start', range.start], ['end', range.end]], undefined],
        ['/status/tsdb, 15 min', '/api/v1/status/tsdb', { start: range.start, end: range.end }, undefined],
      ]
      for (const [what, path, params, leaves] of cases) {
        if (leaves) hooks.forceLeaves = leaves
        else delete hooks.forceLeaves
        // Before: the shards' whole tails, as the previous release answers.
        tailHooks.previousRelease = () => true
        await setLimits(t, {})
        const refusedBefore = await three(`before (default limits): ${what}`, t, path, params)
        await setLimits(t, { maxFetchBytes: 64 << 20 })
        const before = await three(`before (maxFetchBytes 64 MiB): ${what}`, t, path, params)
        // After: this release, default limits.
        delete tailHooks.previousRelease
        await setLimits(t, {})
        const after = await three(`after (default limits): ${what}`, t, path, params)
        if (before.status === 200 && after.status === 200) {
          expect(after.body, what).toBe(before.body)
          console.log(`MEASURE   identical bodies (${after.body.length} B); before refused with the default limits: ${refusedBefore.status !== 200}`)
        }
      }
    } finally {
      delete hooks.sequentialLeaves
      delete hooks.forceLeaves
      delete leafHooks.resetBeforeEvaluate
      delete tailHooks.previousRelease
    }
  })
})

function shardOf(_w: World, name: string) {
  return env.SHARD.get(env.SHARD.idFromName(name))
}
