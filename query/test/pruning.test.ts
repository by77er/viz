/**
 * Series-level pruning and the series-only read through the whole read path
 * (CARDINALITY.md, items 2 and 3).
 *
 * Tenant a: `pr_total{job, ns, pod}` for 25,000 series, six scrapes a minute apart, all
 * flushed in one unit on one shard, so the samples file holds 150,000 rows in two row
 * groups (100,000 and 50,000) and a one-series read can leave one out. Tenant b shares the shards. Every
 * answer here is compared with the same call answered without the pruning (default
 * limits: the query fits one place and reads whole files), and must be byte-identical.
 */
import { env } from 'cloudflare:workers'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { type TenantLimits, clearLimitsCache } from '../src/config'
import { hooks } from '../src/coordinator'
import { leafHooks } from '../src/leaf'
import { Bulk } from './bulk'
import { type Tenant, type World, api, cost, discardAll, flushAll, sealAll, workload, world, write } from './world'

const N = 25_000
const END = workload.end + 3 * 3_600_000
const T0 = END - 5 * 60_000
const sec = (ms: number): string => String(ms / 1000)
/** The series of `ns="n3"`: 1,250 of them, spread over the whole id space. */
const IN_N3 = Array.from({ length: N }, (_, i) => i).filter((i) => Math.floor(i / 3) % 20 === 3)
const labels = (i: number): Record<string, string> => ({ __name__: 'pr_total', job: `j${i % 7}`, ns: `n${Math.floor(i / 3) % 20}`, pod: `p${String(i).padStart(5, '0')}` })

async function setLimits(t: Tenant, limits: Partial<TenantLimits> | null): Promise<void> {
  if (limits === null) await env.CONFIG.delete(`limits:${t.name}`)
  else await env.CONFIG.put(`limits:${t.name}`, JSON.stringify(limits))
  clearLimitsCache()
}

const range = (t: Tenant, query: string) => api(t.key, '/api/v1/query_range', { query, start: sec(T0 + 60_000), end: sec(END), step: '60' })

describe('series-level pruning', () => {
  let w: World
  beforeAll(async () => {
    w = await world(1) // one shard: each samples file holds all 150,000 rows, in two row groups
    await write(w.a, new Bulk(T0, 60_000, N, labels).series(6))
    await write(w.b, new Bulk(T0, 60_000, 50, (i) => ({ __name__: 'pr_total', job: 'secret', pod: `b${i}` })).series(6))
    await sealAll(w)
    await flushAll(w)
    await discardAll(w)
  }, 600_000)

  afterEach(async () => {
    await setLimits(w.a, null)
    delete hooks.forceLeaves
    delete hooks.leafStats
    delete leafHooks.resetBeforeEvaluate
  })

  it('one series: refused before; now its row group and the footer are read, and the answer is the same', async () => {
    const q = 'pr_total{pod="p01234"}'
    const base = await range(w.a, q)
    const want = await base.text()
    expect(base.status).toBe(200)
    expect(base.headers.get('X-Viz-Pruning')).toBe('fragments')
    const coarse = cost(base, 'Scan-Samples')
    // Every row of the metric, in the samples files of both shards.
    expect(coarse).toBe(N * 6)
    // A scan cap below the metric's rows: the fragments alone would refuse (as every
    // release before this one did); resolving the matcher reads one row group a file.
    await setLimits(w.a, { maxScanSamples: coarse - 1 })
    const res = await range(w.a, q)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(want)
    expect(res.headers.get('X-Viz-Pruning')).toBe('series')
    expect(cost(res, 'Series-Estimate')).toBe(1)
    expect(cost(res, 'Scan-Samples')).toBeLessThan(coarse)
    expect(cost(res, 'Scan-Samples')).toBeGreaterThanOrEqual(6)
    // Fewer bytes of sample files than the whole objects (series files are read either way).
    expect(cost(res, 'Bytes-Read')).toBeLessThan(cost(base, 'Bytes-Read'))
    expect(cost(res, 'Samples-Loaded')).toBe(cost(base, 'Samples-Loaded'))
  })

  it('a selection scattered over the ids: exact series count, every row group, the same answer split or not', async () => {
    const q = 'sum by (pod) (rate(pr_total{ns="n3"}[5m]))'
    const base = await range(w.a, q)
    expect(base.status).toBe(200)
    const want = await base.text()
    // Force the fragments' verdict over one place: the series estimate becomes exact.
    await setLimits(w.a, { splitAboveSeries: 100 })
    const res = await range(w.a, q)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(want)
    expect(res.headers.get('X-Viz-Pruning')).toBe('series')
    expect(cost(res, 'Series-Estimate')).toBe(IN_N3.length)
    expect(res.headers.get('X-Viz-Execution')).toBe('split')
  })

  it('split readers read their part of each file, and the answer is the one-place answer', async () => {
    // The second query's split key leaves out `job`, which every series carries: a part's
    // series are then not its id range, and a reader must read again what its first,
    // id-range read did not cover.
    for (const q of ['sum by (job) (rate(pr_total[5m]))', 'sum by (job) (label_replace(pr_total{ns="n5"}, "job", "x-$1", "pod", "p0*(.*)"))']) {
      delete hooks.forceLeaves
      const base = await range(w.a, q)
      expect(base.status).toBe(200)
      const want = await base.text()
      for (const leaves of [2, 5]) {
        hooks.forceLeaves = leaves
        let readerBytes = 0
        hooks.leafStats = (_p, st) => {
          readerBytes += st.bytesRead
        }
        const res = await range(w.a, q)
        delete hooks.leafStats
        expect([q, leaves, res.status]).toEqual([q, leaves, 200])
        expect(await res.text()).toBe(want)
        expect(res.headers.get('X-Viz-Execution')).toBe('split')
        // Together the readers read less than every part reading every file whole.
        expect(readerBytes).toBeLessThan(leaves * cost(base, 'Bytes-Read'))
      }
    }
  })

  it('label calls read series files and the tail only: no sample file, no sample limit, their own series limit', async () => {
    const params: [string, string][] = [['match[]', 'pr_total{ns="n3"}'], ['start', sec(T0)], ['end', sec(END)]]
    const res = await api(w.a.key, '/api/v1/label/pod/values', params)
    expect(res.status).toBe(200)
    const pods = (await res.json<{ data: string[] }>()).data
    expect(pods).toEqual(IN_N3.map((i) => `p${String(i).padStart(5, '0')}`))
    expect(res.headers.get('X-Viz-Pruning')).toBe('series-only')
    // Only the series file was read (one shard).
    expect(cost(res, 'Files-Read')).toBe(1)
    expect(cost(res, 'Samples-Loaded')).toBe(0)
    // A sample budget does not bind them; the listing does.
    await setLimits(w.a, { maxScanSamples: 1, maxSamples: 1, maxSeries: 1 })
    expect((await api(w.a.key, '/api/v1/label/pod/values', params)).status).toBe(200)
    await setLimits(w.a, { maxMetadataSeries: pods.length - 1 })
    const over = await api(w.a.key, '/api/v1/label/pod/values', params)
    expect([over.status, (await over.json<{ error: string }>()).error]).toEqual([422, expect.stringMatching(/^query exceeded limit max_series: \d+ series listed, the limit is \d+$/)])
    // /series and /labels agree with the values.
    await setLimits(w.a, null)
    const one = await api(w.a.key, '/api/v1/series', [['match[]', 'pr_total{pod="p00042"}'], ['start', sec(T0)], ['end', sec(END)]])
    expect((await one.json<{ data: unknown[] }>()).data).toEqual([labels(42)])
    const names = await api(w.a.key, '/api/v1/labels', [['match[]', 'pr_total'], ['start', sec(T0)], ['end', sec(END)]])
    expect((await names.json<{ data: string[] }>()).data).toEqual(['__name__', 'job', 'ns', 'pod'])
    // Tenant b sees only its own.
    const b = await api(w.b.key, '/api/v1/label/job/values', [['start', sec(T0)], ['end', sec(END)]])
    expect((await b.json<{ data: string[] }>()).data).toEqual(['secret'])
  })
})
