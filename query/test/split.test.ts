/**
 * Split execution over HTTP (README, "Split execution"): a query that decomposes is
 * evaluated by leaves that each own a range of series keys, and the coordinator merges
 * their partial aggregates. The property: the response is BYTE-IDENTICAL to evaluating
 * the query in one place, for the query table and for aggregation-heavy queries, at 1, 2,
 * 7 and 32 leaves, with the rows all in shard tails, in the lake with an overlapping tail
 * that rewrites samples, and all in the lake.
 */
import { env } from 'cloudflare:workers'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { type TenantLimits, clearLimitsCache } from '../src/config'
import { hooks } from '../src/coordinator'
import { cacheUrl, fileCache, leafHooks } from '../src/leaf'
import { QUERIES, type Query, type Tenant, type World, api, cost, discardAll, expected, flushAll, ingest, run, sealAll, workload, world } from './world'

const rateSumBy = QUERIES.find((q) => q.id === 'rate-sum-by')!

/** Aggregation-heavy queries over the workload's metrics, as range and instant queries. */
export const AGG = [
  'sum(rate(http_requests_total[5m]))',
  'sum by (job, code) (increase(http_requests_total[2m]))',
  'avg by (job) (memory_bytes)',
  'avg without (instance) (rate(http_requests_total[1m]))',
  'count by (job) (http_requests_total)',
  'min by (job) (memory_bytes)',
  'max(temperature)',
  'group by (job) (up)',
  'stddev without (instance) (memory_bytes)',
  'stdvar(rate(http_requests_total[5m]))',
  'topk(3, rate(http_requests_total[5m]))',
  'bottomk by (job) (1, memory_bytes)',
  'count_values("value", up)',
  'count_values by (job) ("v", round(rate(http_requests_total[5m])))',
  'sum(special)',
  'min(special)',
  'max(special)',
  'avg(special)',
  'stddev(special)',
  'sum by (job) (rate(http_requests_total{code=~"5.."}[5m])) / sum by (job) (rate(http_requests_total[5m]))',
  'histogram_quantile(0.5, sum by (le) (increase(http_request_duration_seconds_bucket[5m])))',
  'quantile(0.5, sum by (instance) (rate(http_requests_total[5m])))',
  'sum(sum by (job, instance) (rate(http_requests_total[5m])))',
  'sum by (job) (label_replace(up, "instance", "all", "instance", ".*"))',
  'sum by (host) (label_replace(memory_bytes, "host", "$1", "instance", "(.*):.*"))',
  'count({__name__=~"up|memory_bytes"})',
  'sum by (job) (up @ end())',
  'sum(http_requests_total offset 5m)',
  'sum(max_over_time(rate(http_requests_total[1m])[5m:30s]))',
  'scalar(count(up)) * 2',
  'sum(shared_metric)',
  'topk(1, sum by (job) (temperature))',
]

const extra: Query[] = AGG.flatMap((query, i) => [
  { id: `agg-${i}`, kind: 'range' as const, query, start: rateSumBy.start, end: rateSumBy.end, step: rateSumBy.step },
  { id: `agg-${i}-i`, kind: 'instant' as const, query, time: rateSumBy.end },
])

async function setLimits(t: Tenant, limits: Partial<TenantLimits> | null): Promise<void> {
  if (limits === null) await env.CONFIG.delete(`limits:${t.name}`)
  else await env.CONFIG.put(`limits:${t.name}`, JSON.stringify(limits))
  clearLimitsCache()
}

/** Every query once in one place and at each leaf count; returns the number of split answers. */
async function compare(t: Tenant, leaves: number[], moment: string): Promise<number> {
  let splits = 0
  for (const q of [...QUERIES, ...extra]) {
    delete hooks.forceLeaves
    const one = await run(t.key, q)
    const want = await one.text()
    expect(one.headers.get('X-Viz-Execution') ?? '', `${moment} ${q.id}`).not.toBe('split')
    if (expected[t.which][q.id]) expect(JSON.parse(want), `${moment}: ${t.which} ${q.id}`).toEqual(expected[t.which][q.id])
    for (const n of leaves) {
      hooks.forceLeaves = n
      const res = await run(t.key, q)
      const body = await res.text()
      expect(body, `${moment}: tenant ${t.which}, ${q.id} (${q.query}) over ${n} leaves`).toBe(want)
      expect(res.status).toBe(one.status)
      const how = res.headers.get('X-Viz-Execution')
      if (how === 'split') {
        splits++
        expect(cost(res, 'Split-Leaves')).toBe(n)
        if (res.status === 200 && cost(one, 'Samples-Loaded') > 0) {
          // What the query loaded is the same, summed over the leaves.
          expect([cost(res, 'Samples-Loaded'), cost(res, 'Series-Loaded')], `${q.id}`).toEqual([cost(one, 'Samples-Loaded'), cost(one, 'Series-Loaded')])
        }
      }
    }
  }
  delete hooks.forceLeaves
  return splits
}

describe('split execution equals one place', () => {
  let w: World
  beforeAll(async () => {
    w = await world()
    await ingest(w)
  })
  afterEach(() => {
    delete hooks.forceLeaves
  })

  it(`${QUERIES.length} + ${extra.length} queries at 1, 2, 7 and 32 leaves, in the tail, lake + tail and the lake`, { timeout: 900_000 }, async () => {
    // 1. All in shard tails.
    const s1 = await compare(w.a, [1, 2, 7, 32], 'all tail')
    await compare(w.b, [7], 'all tail')
    // 2. The first segment flushed; the tail overlaps it and rewrites samples.
    await flushAll(w)
    const s2 = await compare(w.a, [1, 2, 7, 32], 'lake + tail')
    await compare(w.b, [7], 'lake + tail')
    // 3. All in the lake.
    await sealAll(w)
    await flushAll(w)
    await discardAll(w)
    const s3 = await compare(w.a, [1, 2, 7, 32], 'all lake')
    await compare(w.b, [7], 'all lake')
    // Most of it really was split (the rest fell back, and said why).
    for (const s of [s1, s2, s3]) expect(s).toBeGreaterThanOrEqual(4 * (2 * AGG.length + 10))
  })
})

describe('split execution', () => {
  let w: World
  beforeAll(async () => {
    w = await world()
    await ingest(w)
    await flushAll(w) // lake + tail
  })
  afterEach(async () => {
    delete hooks.forceLeaves
    delete hooks.beforeSplitLeaf
    delete hooks.sequentialLeaves
    delete leafHooks.beforeExtract
    await setLimits(w.a, null)
  })

  it('a query that does not decompose is evaluated in one place, says why, and is still right', async () => {
    const cases: [string, string][] = [
      ['rate', 'outside any aggregation'],
      ['quantile', '`quantile` does not decompose'],
      ['hist-avg', 'outside any aggregation'],
      ['bin-group-left', 'outside any aggregation'],
      ['subquery-avg-sum', 'subquery'],
      ['i-matrix', 'range vector'],
      ['absent', 'outside any aggregation'],
      ['err-many-to-many', 'outside any aggregation'],
    ]
    hooks.forceLeaves = 7
    for (const [id, why] of cases) {
      const q = QUERIES.find((x) => x.id === id)!
      const res = await run(w.a.key, q)
      expect(await res.json(), id).toEqual(expected.a[id])
      expect(res.headers.get('X-Viz-Execution'), id).toBe('single')
      expect(res.headers.get('X-Viz-Split-Reason'), id).toContain(why)
      expect(cost(res, 'Split-Leaves')).toBe(0)
    }
    // A query that decomposes but is small stays in one place unless forced.
    delete hooks.forceLeaves
    const res = await run(w.a.key, rateSumBy)
    expect([res.headers.get('X-Viz-Execution'), res.headers.get('X-Viz-Split-Reason')]).toEqual(['single', 'the query fits in one place'])
  })

  it('a query is split by itself once its scan bound is above splitAboveSamples, and the answer is the same', async () => {
    const base = await run(w.a.key, rateSumBy)
    const want = await base.text()
    await setLimits(w.a, { splitAboveSamples: cost(base, 'Scan-Samples') - 1 })
    const res = await run(w.a.key, rateSumBy)
    expect(await res.text()).toBe(want)
    expect(res.headers.get('X-Viz-Execution')).toBe('split')
    expect(cost(res, 'Split-Leaves')).toBe(2)
    expect(cost(res, 'Reader-Calls')).toBeGreaterThanOrEqual(2)
    expect(cost(res, 'Rpc-Bytes')).toBeGreaterThan(0)
    expect(cost(res, 'Leaf-Peak-Wasm-Bytes')).toBeGreaterThan(0)
  })

  it('each leaf stops at its share of the budget; one that the skew pushed over is run again, and the answer is the same', async () => {
    const base = await run(w.a.key, rateSumBy)
    const want = await base.text()
    const samples = cost(base, 'Samples-Loaded')
    hooks.forceLeaves = 2
    const at = async (limits: Partial<TenantLimits>) => {
      await setLimits(w.a, limits)
      return run(w.a.key, rateSumBy)
    }
    // Shares of exactly what the query loads in total, one leaf's share each: a leaf
    // whose part holds more than half stops while gathering, and is run again with what
    // the other left. Same bytes.
    let res = await at({ maxSamples: samples, maxQuerySamples: samples })
    expect(await res.text()).toBe(want)
    const held = cost(res, 'Leaf-Max-Samples')
    expect(held).toBeGreaterThan(0)
    // The query's budget one sample below what it loads: refused, naming the limit.
    res = await at({ maxSamples: samples, maxQuerySamples: samples - 1 })
    expect(res.status).toBe(422)
    const body = await res.json<{ errorType: string; error: string; data?: unknown }>()
    expect(body.errorType).toBe('execution')
    expect(body.error).toMatch(/^query exceeded limit max_samples: (at least )?\d+ samples loaded, the limit is \d+/)
    expect(body.data).toBeUndefined()
    // A share far below a part: every leaf stops while gathering, long before it holds its part.
    res = await at({ maxSamples: 20, maxQuerySamples: 40 })
    expect(res.status).toBe(422)
    expect((await res.json<{ error: string }>()).error).toMatch(/^query exceeded limit max_samples: at least \d+ samples loaded, the limit is 40 \(over 2 leaves\)/)
    expect(cost(res, 'Leaf-Max-Samples')).toBeLessThan(samples)
    // The series budget the same way.
    res = await at({ maxQuerySeries: 1 })
    expect([res.status, (await res.json<{ error: string }>()).error.split(':')[0]]).toEqual([422, 'query exceeded limit max_series'])
  })

  it('a leaf whose part is over its share is run again only when the others left room', async () => {
    const base = await run(w.a.key, rateSumBy)
    const want = await base.text()
    const samples = cost(base, 'Samples-Loaded')
    hooks.forceLeaves = 7
    hooks.sequentialLeaves = true
    // Seven shares of a budget exactly the query's size: parts are uneven, so some leaf
    // exceeds its seventh and is run again with the rest.
    await setLimits(w.a, { maxSamples: samples, maxQuerySamples: samples })
    const res = await run(w.a.key, rateSumBy)
    expect(await res.text()).toBe(want)
    expect(cost(res, 'Leaf-Reruns')).toBeGreaterThan(0)
  })

  it('a reader or a split leaf that fails once is retried, and nothing is counted twice; twice is a 503', async () => {
    const one = await run(w.a.key, rateSumBy)
    const want = await one.text()
    hooks.forceLeaves = 3
    leafHooks.beforeExtract = async (_part, group, attempt) => {
      if (attempt === 0 && group === 0) throw new Error('injected reader failure')
    }
    let res = await run(w.a.key, rateSumBy)
    expect(await res.text()).toBe(want)
    delete leafHooks.beforeExtract
    hooks.beforeSplitLeaf = async (part, attempt) => {
      if (attempt === 0 && part === 1) throw new Error('injected leaf failure')
    }
    res = await run(w.a.key, rateSumBy)
    expect(await res.text()).toBe(want)
    expect([cost(res, 'Samples-Loaded'), cost(res, 'Series-Loaded')]).toEqual([cost(one, 'Samples-Loaded'), cost(one, 'Series-Loaded')])
    expect(cost(res, 'Leaf-Calls')).toBe(4)
    hooks.beforeSplitLeaf = async (part) => {
      if (part === 2) throw new Error('injected leaf failure')
    }
    res = await run(w.a.key, rateSumBy)
    expect([res.status, (await res.json<{ errorType: string }>()).errorType]).toEqual([503, 'unavailable'])
  })

  it('a data file missing from R2 sends a split query back to the ledger, never to a partial answer', async () => {
    hooks.forceLeaves = 2
    const plan = await (await import('./world')).ledgerOf(w.a).plan({ table: 'metric_samples', minTs: 0, maxTs: Number.MAX_SAFE_INTEGER })
    const victim = plan.files[0]!.key
    const obj = await env.BUCKET.get(victim)
    const bytes = new Uint8Array(await obj!.arrayBuffer())
    await env.BUCKET.delete(victim)
    await fileCache().delete(cacheUrl({ key: victim }))
    try {
      const res = await run(w.a.key, rateSumBy)
      expect([res.status, (await res.json<{ errorType: string; data?: unknown }>()).errorType, cost(res, 'Plan-Attempts')]).toEqual([503, 'unavailable', 4])
    } finally {
      await env.BUCKET.put(victim, bytes)
    }
    expect(await (await run(w.a.key, rateSumBy)).json()).toEqual(expected.a['rate-sum-by'])
  })

  it('the tail travels to the leaf that owns each series: a rate window that straddles lake and tail is exact', async () => {
    // Moment 2's tail overlaps the lake and rewrites samples in it (fixtures): the same
    // answer as the reference at every leaf count is the proof; here, explicitly for the
    // rewritten series and a rate over the seam.
    for (const n of [1, 2, 7]) {
      hooks.forceLeaves = n
      for (const id of ['rate-sum-by', 'i-rate-sum-by', 'step-15s']) {
        const q = QUERIES.find((x) => x.id === id)!
        const res = await run(w.a.key, q)
        expect(await res.json(), `${id} at ${n}`).toEqual(expected.a[id])
        expect(cost(res, 'Tail-Batches')).toBeGreaterThan(0)
      }
      const res = await api(w.a.key, '/api/v1/query_range', { query: 'max(temperature)', start: String(workload.t0 / 1000), end: String(workload.end / 1000), step: '15' })
      hooks.forceLeaves = undefined
      const one = await api(w.a.key, '/api/v1/query_range', { query: 'max(temperature)', start: String(workload.t0 / 1000), end: String(workload.end / 1000), step: '15' })
      expect(await res.text()).toBe(await one.text())
    }
  })
})
