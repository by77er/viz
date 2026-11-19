/**
 * The central property: over HTTP, every query of the table returns the SAME bytes
 * wherever the tenant's rows are, and they equal the reference (viz-promql over its
 * in-memory source, fixtures/expected.json):
 *
 *   1. all rows in shard tails (one sealed, unflushed segment and one unsealed);
 *   2. after the first segment is flushed: lake + tail, where the tail overlaps the lake
 *      in time and REWRITES some of its samples;
 *   3. after everything is flushed and the shards have discarded: all lake.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { QUERIES, type Tenant, type World, api, cost, discardAll, expected, flushAll, ingest, ledgerOf, run, sealAll, seriesIn, shardOf, workload, world } from './world'

const STATUS: Record<string, number> = { bad_data: 400, execution: 422, unsupported: 422 }

interface Moment {
  name: string
  bodies: Map<string, string>
  costs: Map<string, { files: number; tail: number; shards: number; hits: number }>
}

const sec = (ms: number): string => String(ms / 1000)
const uniq = (xs: string[]): string[] => [...new Set(xs)].sort()
const byLabels = (xs: Record<string, string>[]): Record<string, string>[] =>
  [...xs].sort((a, b) => {
    const [x, y] = [JSON.stringify(Object.entries(a).sort()), JSON.stringify(Object.entries(b).sort())]
    return x < y ? -1 : x > y ? 1 : 0
  })

/** The label endpoints, with what they must return computed from the workload itself. */
function metaCalls(which: 'a' | 'b'): { id: string; path: string; params: [string, string][]; want: unknown }[] {
  const all = seriesIn(which)
  const [lo, hi] = [workload.t0 + 72 * 15_000, workload.t0 + 90 * 15_000] // `up{job="web",instance="i2:9100"}` has no sample here
  const win = seriesIn(which, lo, hi)
  const window: [string, string][] = [['start', sec(lo)], ['end', sec(hi)]]
  const is = (name: string) => (l: Record<string, string>) => l.__name__ === name
  return [
    { id: 'labels', path: '/api/v1/labels', params: [], want: uniq(all.flatMap((l) => Object.keys(l))) },
    { id: 'labels-match', path: '/api/v1/labels', params: [['match[]', 'temperature'], ['match[]', 'http_request_duration_seconds_bucket']], want: ['__name__', 'job', 'le', 'room'] },
    { id: 'labels-window', path: '/api/v1/labels', params: window, want: uniq(win.flatMap((l) => Object.keys(l))) },
    { id: 'names', path: '/api/v1/label/__name__/values', params: [], want: uniq(all.map((l) => l.__name__!)) },
    { id: 'values-instance', path: '/api/v1/label/instance/values', params: [['match[]', 'up']], want: uniq(all.filter(is('up')).map((l) => l.instance!)) },
    { id: 'values-window', path: '/api/v1/label/instance/values', params: [['match[]', 'up{job="web"}'], ...window], want: uniq(win.filter((l) => l.__name__ === 'up' && l.job === 'web').map((l) => l.instance!)) },
    { id: 'values-owner', path: '/api/v1/label/owner/values', params: [], want: [`tenant-${which}`] },
    { id: 'series-up', path: '/api/v1/series', params: [['match[]', 'up']], want: byLabels(all.filter(is('up'))) },
    { id: 'series-two', path: '/api/v1/series', params: [['match[]', 'temperature'], ['match[]', 'shared_metric']], want: byLabels(all.filter((l) => is('temperature')(l) || is('shared_metric')(l))) },
    { id: 'series-window', path: '/api/v1/series', params: [['match[]', 'up'], ...window], want: byLabels(win.filter(is('up'))) },
  ]
}

async function runAll(w: World, name: string): Promise<Moment> {
  const m: Moment = { name, bodies: new Map(), costs: new Map() }
  for (const t of [w.a, w.b]) {
    for (const q of QUERIES) {
      const res = await run(t.key, q, { method: q.id.length % 2 ? 'GET' : 'POST' })
      const body = await res.text()
      const want = expected[t.which][q.id]!
      // Identical to the reference, as parsed JSON: values are strings, so this is exact.
      expect(JSON.parse(body), `${name}: tenant ${t.which}, ${q.id}: ${q.query}`).toEqual(want)
      expect(res.status, `${name}: ${q.id}`).toBe(want.status === 'success' ? 200 : STATUS[want.errorType])
      expect(res.headers.get('Content-Type')).toBe('application/json')
      m.bodies.set(`${t.which}/${q.id}`, body)
      m.costs.set(`${t.which}/${q.id}`, { files: cost(res, 'Files-Read'), tail: cost(res, 'Tail-Batches'), shards: cost(res, 'Shards-Asked'), hits: cost(res, 'Cache-Hits') })
    }
    for (const c of metaCalls(t.which)) {
      const res = await api(t.key, c.path, c.params)
      const body = await res.text()
      expect(JSON.parse(body), `${name}: tenant ${t.which}, ${c.id}`).toEqual({ status: 'success', data: c.want })
      m.bodies.set(`${t.which}/meta/${c.id}`, body)
    }
  }
  return m
}

describe('results do not depend on where the rows are', () => {
  let w: World
  beforeAll(async () => {
    w = await world()
    await ingest(w)
  })

  it(`${QUERIES.length} queries x 2 tenants are identical in the tail, in lake + tail, and in the lake, and equal the reference`, async () => {
    expect(QUERIES.length).toBeGreaterThanOrEqual(25)
    // Both tenants really have a stream in both shard objects.
    for (const t of [w.a, w.b]) for (const s of w.shards) expect((await shardOf(s).describe(t.name))?.nextSeq, `${t.name} in ${s}`).toBeGreaterThan(1)

    // ── 1. Everything in shard tails. The ledgers have never heard of these streams. ──
    for (const t of [w.a, w.b]) expect((await ledgerOf(t).plan({ table: 'metric_samples', minTs: 0, maxTs: Number.MAX_SAFE_INTEGER })).watermarks).toEqual([])
    const tail = await runAll(w, 'all tail')
    const c1 = tail.costs.get('a/rate-sum-by')!
    expect(c1).toMatchObject({ files: 0, shards: 2 })
    // The shards return only the batches that hold this query's metric in its window (D48):
    // both requests' batches, of one shard or both, depending on where the senders went.
    expect(c1.tail).toBeGreaterThanOrEqual(2)

    // ── 2. The sealed segment is flushed; the second request stays in the tail. ──
    await flushAll(w)
    const mixed = await runAll(w, 'lake + tail')
    const c2 = mixed.costs.get('a/rate-sum-by')!
    expect(c2.files).toBeGreaterThanOrEqual(2) // a samples file and its series file, at least
    expect(c2.tail).toBeGreaterThanOrEqual(1)
    expect(c2.tail).toBeLessThan(c1.tail) // only rows above the watermark
    // The rewritten samples are in the lake with their old value and in the tail with the new one.
    expect(tail.bodies.get('a/sel-rewritten')).toContain(',"values":[')

    // ── 3. Everything flushed, and the shards have discarded it: all lake. ──
    await sealAll(w)
    await flushAll(w)
    await discardAll(w)
    for (const t of [w.a, w.b]) for (const s of w.shards) expect((await shardOf(s).describe(t.name))!.discardedThrough, `${t.name} in ${s}`).toBeGreaterThanOrEqual(2)
    const lake = await runAll(w, 'all lake')
    const c3 = lake.costs.get('a/rate-sum-by')!
    expect(c3.tail).toBe(0)
    expect(c3.files).toBeGreaterThan(c2.files)

    // Byte-identical responses at the three moments.
    for (const [k, body] of tail.bodies) {
      expect(mixed.bodies.get(k), `lake + tail differs from all tail: ${k}`).toBe(body)
      expect(lake.bodies.get(k), `all lake differs from all tail: ${k}`).toBe(body)
    }
    expect(tail.bodies.size).toBe(2 * (QUERIES.length + 10))
    // The window really excludes a series (the label calls are not all-or-nothing).
    expect(seriesIn('a', workload.t0 + 72 * 15_000, workload.t0 + 90 * 15_000).length).toBeLessThan(seriesIn('a').length)
  })

  it('a query evaluated from files that were only in the Cache API is identical too', async () => {
    // Runs after the test above: every file has been read at least once.
    const t: Tenant = w.a
    const q = QUERIES.find((x) => x.id === 'rate-sum-by')!
    const res = await run(t.key, q)
    expect(await res.json()).toEqual(expected.a[q.id])
    expect(cost(res, 'Files-Read')).toBeGreaterThan(0)
    expect(cost(res, 'Cache-Hits')).toBe(cost(res, 'Files-Read'))
    expect(cost(res, 'R2-Gets')).toBe(0)
  })
})
