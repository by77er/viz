/**
 * The cardinality report: Prometheus' `/api/v1/status/tsdb` and viz's
 * `/api/v1/status/cardinality`, over synthetic data whose cardinality is known exactly.
 *
 * Tenant a, in the hour before `B` (the range), looking back one more hour:
 *   old_metric{job="j1", instance="i0".."i4"}   5 series, also written 90 min before B
 *   new_metric{job="j1"|"j2", instance="i0".."i9"}  20 series, first written 20 min before B
 *   pod_metric{ns="n0", pod="p0".."p49"}        50 series, first written 10 min before B
 *   gone_metric{job="j3", instance="i0"}        only 100 min before B: not in the range
 * 75 series in the range, 70 of them created in it, 66 label pairs. Tenant b shares the
 * shards and writes series and values a must never see.
 */
import { env } from 'cloudflare:workers'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { type TenantLimits, clearLimitsCache } from '../src/config'
import { hooks } from '../src/coordinator'
import { type Tenant, type WSeries, type World, api, cost, discardAll, flushAll, sealAll, workload, world, write } from './world'

const B = workload.end + 6 * 3_600_000
const MIN = 60_000
const sec = (ms: number): string => String(ms / 1000)
const window = { start: sec(B - 60 * MIN), end: sec(B), lookback: '1h' }

const series = (name: string, labels: Record<string, string>[], ts: number): WSeries[] => labels.map((l) => ({ labels: { __name__: name, ...l }, samples: [[ts, 1]] }))
const range = (n: number, f: (i: number) => Record<string, string>) => Array.from({ length: n }, (_, i) => f(i))
const OLD = range(5, (i) => ({ job: 'j1', instance: `i${i}` }))
const NEW = range(20, (i) => ({ job: i < 10 ? 'j1' : 'j2', instance: `i${i % 10}` }))
const POD = range(50, (i) => ({ ns: 'n0', pod: `p${i}` }))

async function setLimits(t: Tenant, limits: Partial<TenantLimits> | null): Promise<void> {
  if (limits === null) await env.CONFIG.delete(`limits:${t.name}`)
  else await env.CONFIG.put(`limits:${t.name}`, JSON.stringify(limits))
  clearLimitsCache()
}

type Stat = { name: string; value: number }
interface Tsdb {
  headStats: { numSeries: number; numLabelPairs: number; chunkCount: null; minTime: number; maxTime: number }
  seriesCountByMetricName: Stat[]
  labelValueCountByLabelName: Stat[]
  memoryInBytesByLabelName: Stat[]
  seriesCountByLabelValuePair: Stat[]
}

const get = async <T>(t: Tenant, path: string, params: Record<string, string>): Promise<{ status: number; body: T; res: Response }> => {
  const res = await api(t.key, path, params)
  return { status: res.status, body: (await res.json<{ data: T }>()).data, res }
}

describe('cardinality', () => {
  let w: World
  beforeAll(async () => {
    w = await world()
    // Before the range (flushed): what old_metric and gone_metric were.
    await write(w.a, [...series('old_metric', OLD, B - 90 * MIN), ...series('gone_metric', [{ job: 'j3', instance: 'i0' }], B - 100 * MIN)])
    await write(w.b, [...series('b_secret', [{ job: 'j1', instance: 'zz' }], B - 20 * MIN), ...series('new_metric', [{ job: 'j9', instance: 'i99' }], B - 20 * MIN)])
    await sealAll(w)
    await flushAll(w)
    // In the range: old_metric again and new_metric (flushed), pod_metric (left in the tail).
    await write(w.a, [...series('old_metric', OLD, B - 30 * MIN), ...series('new_metric', NEW, B - 20 * MIN)])
    await sealAll(w)
    await flushAll(w)
    await write(w.a, series('pod_metric', POD, B - 10 * MIN))
  })
  afterEach(async () => {
    delete hooks.forceLeaves
    await setLimits(w.a, null)
  })

  const want: Tsdb = {
    headStats: { numSeries: 75, numLabelPairs: 66, chunkCount: null, minTime: B - 30 * MIN, maxTime: B - 10 * MIN },
    seriesCountByMetricName: [
      { name: 'pod_metric', value: 50 },
      { name: 'new_metric', value: 20 },
      { name: 'old_metric', value: 5 },
    ],
    labelValueCountByLabelName: [
      { name: 'pod', value: 50 },
      { name: 'instance', value: 10 },
      { name: '__name__', value: 3 },
      { name: 'job', value: 2 },
      { name: 'ns', value: 1 },
    ],
    memoryInBytesByLabelName: [
      { name: 'pod', value: 10 * 2 + 40 * 3 },
      { name: '__name__', value: 30 },
      { name: 'instance', value: 20 },
      { name: 'job', value: 4 },
      { name: 'ns', value: 2 },
    ],
    seriesCountByLabelValuePair: [
      { name: '__name__=pod_metric', value: 50 },
      { name: 'ns=n0', value: 50 },
      { name: '__name__=new_metric', value: 20 },
      { name: 'job=j1', value: 15 },
      { name: 'job=j2', value: 10 },
    ],
  }

  it('the tsdb status of a known data set, exactly, in the lake + tail, over leaves, and all in the lake', async () => {
    const one = await get<Tsdb>(w.a, '/api/v1/status/tsdb', { ...window, limit: '5' })
    expect(one.status).toBe(200)
    expect(one.body).toEqual(want)
    // The keys are the ones the Prometheus documentation shows, and only those (plus numLabelPairs).
    expect(Object.keys(one.body)).toEqual(['headStats', 'seriesCountByMetricName', 'labelValueCountByLabelName', 'memoryInBytesByLabelName', 'seriesCountByLabelValuePair'])
    expect(one.res.headers.get('X-Viz-Execution')).toBe('single')
    expect(cost(one.res, 'Tail-Batches')).toBeGreaterThan(0)
    const text = JSON.stringify(one.body)
    for (const n of [2, 3, 7]) {
      hooks.forceLeaves = n
      const split = await get<Tsdb>(w.a, '/api/v1/status/tsdb', { ...window, limit: '5' })
      expect(JSON.stringify(split.body), `${n} leaves`).toBe(text)
      expect([split.res.headers.get('X-Viz-Execution'), cost(split.res, 'Split-Leaves')]).toEqual(['split', n])
    }
    delete hooks.forceLeaves
    // The default limit is 10, and limit cuts every list.
    const ten = await get<Tsdb>(w.a, '/api/v1/status/tsdb', window)
    expect(ten.body.seriesCountByLabelValuePair).toHaveLength(10)
    const two = await get<Tsdb>(w.a, '/api/v1/status/tsdb', { ...window, limit: '2' })
    expect(two.body.labelValueCountByLabelName).toEqual(want.labelValueCountByLabelName.slice(0, 2))
    for (const bad of ['0', '10001', 'x', '-1']) expect((await api(w.a.key, '/api/v1/status/tsdb', { ...window, limit: bad })).status).toBe(400)
  })

  it('viz cardinality: created series (churn), per-metric label cardinality, and the window', async () => {
    const r = await get<{
      numSeries: number
      seriesCreated: number
      metrics: { name: string; series: number; created: number; labels: { name: string; values: number }[] }[]
      labelNames: { name: string; values: number; bytes: number }[]
      labelPairs: { name: string; value: string; series: number }[]
      createdByMetric: { name: string; created: number }[]
      counting: { method: string }
      lookbackStart: number
    }>(w.a, '/api/v1/status/cardinality', { range: '1h', end: sec(B), lookback: '1h', limit: '10' })
    expect(r.status).toBe(200)
    expect([r.body.numSeries, r.body.seriesCreated, r.body.lookbackStart]).toEqual([75, 70, B - 120 * MIN])
    expect(r.body.metrics).toEqual([
      { name: 'pod_metric', series: 50, created: 50, labels: [{ name: 'pod', values: 50 }, { name: 'ns', values: 1 }] },
      { name: 'new_metric', series: 20, created: 20, labels: [{ name: 'instance', values: 10 }, { name: 'job', values: 2 }] },
      { name: 'old_metric', series: 5, created: 0, labels: [{ name: 'instance', values: 5 }, { name: 'job', values: 1 }] },
    ])
    expect(r.body.createdByMetric).toEqual([{ name: 'pod_metric', created: 50 }, { name: 'new_metric', created: 20 }])
    expect(r.body.labelNames[0]).toEqual({ name: 'pod', values: 50, bytes: 140 })
    expect(r.body.labelPairs[0]).toEqual({ name: '__name__', value: 'pod_metric', series: 50 })
    expect(r.body.counting.method).toBe('exact')
    // Without the look-back, old_metric's earlier life is not seen: it counts as created.
    const short = await get<{ seriesCreated: number }>(w.a, '/api/v1/status/cardinality', { range: '1h', end: sec(B), lookback: '0s' })
    expect(short.body.seriesCreated).toBe(75)
    // A window that holds only gone_metric's sample.
    const early = await get<{ numSeries: number; seriesCreated: number }>(w.a, '/api/v1/status/cardinality', { start: sec(B - 101 * MIN), end: sec(B - 99 * MIN), lookback: '0s' })
    expect([early.body.numSeries, early.body.seriesCreated]).toEqual([1, 1])
    // The same over leaves.
    hooks.forceLeaves = 4
    const split = await api(w.a.key, '/api/v1/status/cardinality', { range: '1h', end: sec(B), lookback: '1h', limit: '10' })
    expect((await split.json<{ data: unknown }>()).data).toEqual(r.body)
  })

  it('exact counting is capped: at the cap it answers, one below it refuses, naming the cap', async () => {
    // 76 series seen: the 75 in the range and gone_metric in the look-back window.
    await setLimits(w.a, { maxCardinalitySeries: 76 })
    expect((await api(w.a.key, '/api/v1/status/tsdb', window)).status).toBe(200)
    await setLimits(w.a, { maxCardinalitySeries: 75 })
    let res = await api(w.a.key, '/api/v1/status/tsdb', window)
    expect([res.status, (await res.json<{ error: string }>()).error]).toEqual([422, 'cardinality report exceeded limit max_series: 76 counted, the limit is 75. Narrow the time range.'])
    // 66 pairs + 69 (metric, label, value) triples = 135.
    await setLimits(w.a, { maxCardinalityPairs: 135 })
    expect((await api(w.a.key, '/api/v1/status/tsdb', window)).status).toBe(200)
    await setLimits(w.a, { maxCardinalityPairs: 134 })
    res = await api(w.a.key, '/api/v1/status/tsdb', window)
    expect([res.status, (await res.json<{ error: string }>()).error.split(':')[0]]).toEqual([422, 'cardinality report exceeded limit max_pairs'])
  })

  it('never counts another tenant’s series, on shared shards, in the lake and in the tail', async () => {
    for (const n of [undefined, 3]) {
      hooks.forceLeaves = n
      const a = await api(w.a.key, '/api/v1/status/cardinality', { range: '1h', end: sec(B), limit: '10000' })
      const text = await a.text()
      for (const mark of ['b_secret', 'zz', 'j9', 'i99']) expect(text, mark).not.toContain(mark)
      const b = await get<Tsdb>(w.b, '/api/v1/status/tsdb', { ...window, limit: '10000' })
      expect(b.body.headStats.numSeries).toBe(2)
      expect(JSON.stringify(b.body)).not.toContain('pod_metric')
    }
    // The tenant cannot be named by the request: a parameter or a header naming the other
    // tenant changes nothing.
    delete hooks.forceLeaves
    for (const path of ['/api/v1/status/tsdb', '/api/v1/status/cardinality']) {
      const forged = await api(w.a.key, path, { ...window, limit: '10000', tenant: w.b.name, org: w.b.name }, { headers: { 'X-Scope-OrgID': w.b.name, 'X-Tenant': w.b.name } })
      expect(forged.status).toBe(200)
      const text = await forged.text()
      expect(text).toContain('pod_metric')
      for (const mark of ['b_secret', 'j9']) expect(text, `${path} ${mark}`).not.toContain(mark)
    }
    // A tenant with nothing: zeros, not an error.
    const empty = await world()
    const e = await get<Tsdb>(empty.a, '/api/v1/status/tsdb', window)
    expect(e.body.headStats).toEqual({ numSeries: 0, numLabelPairs: 0, chunkCount: null, minTime: null, maxTime: null })
  })

  it('reads the lake when the shards have discarded: the same report', async () => {
    const before = await (await api(w.a.key, '/api/v1/status/tsdb', { ...window, limit: '100' })).text()
    await sealAll(w)
    await flushAll(w)
    await discardAll(w)
    const after = await api(w.a.key, '/api/v1/status/tsdb', { ...window, limit: '100' })
    expect(cost(after, 'Tail-Batches')).toBe(0)
    expect(await after.text()).toBe(before)
  })
})
