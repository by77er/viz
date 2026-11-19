/**
 * Per-tenant limits (`limits:<tenant>` in KV, defaults otherwise): each one returns the
 * documented error, names itself and the number reached, and never truncates a result.
 */
import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_LIMITS, type TenantLimits, clearLimitsCache } from '../src/config'
import { QUERIES, type World, api, cost, expected, flushAll, ingest, run, workload, world } from './world'

let w: World
const END = workload.end
const S = END - 20 * 60_000
const sec = (ms: number): string => String(ms / 1000)

async function setLimits(tenant: string, limits: Partial<TenantLimits> | string | null): Promise<void> {
  if (limits === null) await env.CONFIG.delete(`limits:${tenant}`)
  else await env.CONFIG.put(`limits:${tenant}`, typeof limits === 'string' ? limits : JSON.stringify(limits))
  clearLimitsCache()
}

const range = (query: string, step = '30') => api(w.a.key, '/api/v1/query_range', { query, start: sec(S), end: sec(END), step })

beforeAll(async () => {
  w = await world()
  await ingest(w)
  await flushAll(w) // lake + tail
})

describe('limits', () => {
  it('the defaults are the documented ones', () => {
    expect(DEFAULT_LIMITS).toEqual({
      maxSamples: 2_000_000, maxSeries: 20_000, maxOutputPoints: 500_000, maxStepPoints: 1_000_000, maxQueryBytes: 16_384, maxDepth: 100, maxSteps: 11_000,
      maxFetchBytes: 16 << 20, maxScanSamples: 3_000_000, maxFiles: 2_000, timeoutMs: 30_000,
      splitAboveSamples: 1_500_000, splitAboveSeries: 15_000, maxQuerySamples: 64_000_000, maxQuerySeries: 640_000, maxQueryScanSamples: 100_000_000, maxQueryFetchBytes: 512 << 20,
      maxQueryFiles: 20_000, maxLeaves: 32, maxCardinalitySeries: 1_000_000, maxCardinalityPairs: 400_000, cardinalitySplitAboveSeries: 50_000,
      maxMetadataSeries: 200_000,
      maxSpans: 40_000, maxLogRows: 60_000, maxTraceSeries: 10_000, maxTracePoints: 11_000,
    })
  })

  it('each engine limit: exactly at the limit answers, one below is a 422 naming the limit', async () => {
    // `http_requests_total` over 20 minutes at 30 s: 8 series, 41 steps, 328 points.
    const q = 'http_requests_total'
    const base = await range(q)
    const samples = cost(base, 'Samples-Loaded')
    expect(cost(base, 'Series-Loaded')).toBe(8)
    const cases: [keyof TenantLimits, number, string][] = [
      ['maxSamples', samples, 'max_samples'],
      ['maxSeries', 8, 'max_series'],
      ['maxOutputPoints', 8 * 41, 'max_output_points'],
      ['maxStepPoints', 8 * 41, 'max_step_points'],
      ['maxQueryBytes', q.length, 'max_query_bytes'],
    ]
    for (const [field, at, name] of cases) {
      await setLimits(w.a.name, { [field]: at })
      const ok = await range(q)
      expect([name, ok.status]).toEqual([name, 200])
      expect(await ok.text()).toBe(await (await range(q)).text())
      await setLimits(w.a.name, { [field]: at - 1 })
      const res = await range(q)
      const body = await res.json<{ status: string; errorType: string; error: string; data?: unknown }>()
      expect([name, res.status, body.errorType]).toEqual([name, 422, 'execution'])
      expect(body.error).toMatch(new RegExp(`^query exceeded limit ${name}: ${at} .*, the limit is ${at - 1}$`))
      expect(body.data).toBeUndefined() // nothing truncated
      // The other tenant has its own limits.
      expect((await api(w.b.key, '/api/v1/query_range', { query: q, start: sec(S), end: sec(END), step: '30' })).status).toBe(200)
    }
    await setLimits(w.a.name, { maxDepth: 3 })
    const deep = await range('((((up))))')
    expect([deep.status, (await deep.json<{ error: string }>()).error]).toEqual([422, expect.stringMatching(/^query exceeded limit max_depth: /)])
    expect((await range('(up)')).status).toBe(200)
    // The step cap is bad_data (400), as in Prometheus.
    await setLimits(w.a.name, { maxSteps: 41 })
    expect((await range('up')).status).toBe(200)
    await setLimits(w.a.name, { maxSteps: 40 })
    const steps = await range('up')
    expect([steps.status, await steps.json()]).toEqual([400, { status: 'error', errorType: 'bad_data', error: 'exceeded maximum resolution of 40 points per timeseries. Try decreasing the query resolution (?step=XX)' }])
    // The label endpoints obey their own series limit (they read no samples).
    await setLimits(w.a.name, { maxMetadataSeries: 3 })
    for (const path of ['/api/v1/labels', '/api/v1/label/job/values', '/api/v1/series?match[]=up']) {
      const res = await api(w.a.key, path)
      expect([path, res.status, (await res.json<{ error: string }>()).error]).toEqual([path, 422, expect.stringMatching(/^query exceeded limit max_series: /)])
    }
    await setLimits(w.a.name, null)
  })

  it('max_fetch_bytes: the bytes of files plus tail are capped, with a message that says what to do', async () => {
    // `rate(...)` does not decompose, so it is evaluated in one place and these caps apply
    // (a query that decomposes is split instead: split.test.ts).
    const q = QUERIES.find((x) => x.id === 'rate')!
    const base = await run(w.a.key, q)
    const [lake, tail] = [cost(base, 'Bytes-Read'), cost(base, 'Tail-Bytes')]
    expect(lake).toBeGreaterThan(0)
    expect(tail).toBeGreaterThan(0)
    await setLimits(w.a.name, { maxFetchBytes: lake + tail })
    expect(await (await run(w.a.key, q)).json()).toEqual(expected.a[q.id])
    // One byte less: lake + tail is over.
    await setLimits(w.a.name, { maxFetchBytes: lake + tail - 1 })
    let res = await run(w.a.key, q)
    expect(res.status).toBe(422)
    // The tail is read in pages under what the files leave (D48, D54): a read that stops at a
    // batch it cannot tell is the last says "at least" (here it is all of it either way).
    expect(await res.json()).toEqual({
      status: 'error',
      errorType: 'execution',
      error: expect.stringMatching(new RegExp(`^query exceeded limit max_fetch_bytes: the data files in range plus the unflushed tail is (at least )?${lake + tail} bytes, the limit is ${lake + tail - 1}\\. Narrow the time range, or select fewer metrics by name\\.$`)),
    })
    // Less than the lake alone: refused from the ledger's sizes, before any file or shard is read.
    await setLimits(w.a.name, { maxFetchBytes: lake - 1 })
    res = await run(w.a.key, q)
    expect(res.status).toBe(422)
    expect((await res.json<{ error: string }>()).error).toMatch(new RegExp(`^query exceeded limit max_fetch_bytes: the \\d+ data files in range is ${lake} bytes, the limit is ${lake - 1}\\. Narrow the time range`))
    expect([cost(res, 'Shard-Calls'), cost(res, 'Leaf-Calls')]).toEqual([0, 0])
    // A narrower query (by metric name: fewer files survive pruning; or a range the files do not cover) passes.
    expect((await api(w.a.key, '/api/v1/query', { query: '1', time: sec(END) })).status).toBe(200)
    await setLimits(w.a.name, null)
  })

  it('max_scan_samples and max_files are checked from the ledger alone, before anything is fetched', async () => {
    const q = QUERIES.find((x) => x.id === 'rate')!
    const base = await run(w.a.key, q)
    const scan = cost(base, 'Scan-Samples')
    const files = cost(base, 'Files-Read')
    expect(scan).toBeGreaterThan(100)
    // The bound really is one: the engine loaded no more lake samples than it.
    await setLimits(w.a.name, { maxScanSamples: scan })
    expect((await run(w.a.key, q)).status).toBe(200)
    await setLimits(w.a.name, { maxScanSamples: scan - 1 })
    let res = await run(w.a.key, q)
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({
      status: 'error',
      errorType: 'execution',
      error: `query exceeded limit max_scan_samples: the data files in range hold ${scan} samples the query would decode, the limit is ${scan - 1}. Narrow the time range, or select fewer metrics by name.`,
    })
    expect([cost(res, 'Shard-Calls'), cost(res, 'Leaf-Calls')]).toEqual([0, 0])
    // The refusal still says what the query would have cost.
    expect([cost(res, 'Scan-Samples'), cost(res, 'Files-Listed'), cost(res, 'Files-Skipped')]).toEqual([scan, cost(base, 'Files-Listed'), cost(base, 'Files-Skipped')])
    expect(cost(res, 'Files-Listed')).toBeGreaterThan(0)
    // A query with two selectors on the same files decodes them twice.
    await setLimits(w.a.name, null)
    const twice = await api(w.a.key, '/api/v1/query_range', { query: `${q.query} / ${q.query}`, start: sec(q.start!), end: sec(q.end!), step: '30' })
    expect(cost(twice, 'Scan-Samples')).toBe(2 * scan)

    await setLimits(w.a.name, { maxFiles: files })
    expect((await run(w.a.key, q)).status).toBe(200)
    await setLimits(w.a.name, { maxFiles: files - 1 })
    res = await run(w.a.key, q)
    expect([res.status, (await res.json<{ error: string }>()).error]).toEqual([422, `query exceeded limit max_files: ${files} data files to read, the limit is ${files - 1}. Narrow the time range.`])
    await setLimits(w.a.name, null)
  })

  it('the tenant’s time limit applies without a timeout parameter', async () => {
    const { hooks } = await import('../src/coordinator')
    await setLimits(w.a.name, { timeoutMs: 40 })
    hooks.afterPlan = () => new Promise((r) => setTimeout(r, 250))
    try {
      const res = await api(w.a.key, '/api/v1/query', { query: 'up', time: sec(END), timeout: '10m' }) // cannot raise it
      expect([res.status, (await res.json<{ errorType: string }>()).errorType]).toEqual([503, 'timeout'])
    } finally {
      delete hooks.afterPlan
      await setLimits(w.a.name, null)
    }
  })

  it('a limits record that cannot be trusted refuses the query (503); it is never replaced by a guess', async () => {
    for (const bad of ['{not json', '[]', '"x"', '{"maxSamples":"lots"}', '{"maxSeries":-1}', '{"maxFetchBytes":1.5}']) {
      await setLimits(w.a.name, bad)
      const res = await api(w.a.key, '/api/v1/query', { query: 'up', time: sec(END) })
      expect([bad, res.status, (await res.json<{ errorType: string }>()).errorType]).toEqual([bad, 503, 'unavailable'])
    }
    // Unknown fields are ignored.
    await setLimits(w.a.name, '{"somethingNew":1}')
    expect((await api(w.a.key, '/api/v1/query', { query: 'up', time: sec(END) })).status).toBe(200)
    await setLimits(w.a.name, null)
  })
})
