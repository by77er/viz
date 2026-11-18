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
import { QUERIES, type Tenant, type World, cost, discardAll, expected, flushAll, ingest, ledgerOf, run, sealAll, shardOf, world } from './world'

const STATUS: Record<string, number> = { bad_data: 400, execution: 422, unsupported: 422 }

interface Moment {
  name: string
  bodies: Map<string, string>
  costs: Map<string, { files: number; tail: number; shards: number; hits: number }>
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
    expect(c1.tail).toBeGreaterThanOrEqual(4)

    // ── 2. The sealed segment is flushed; the second request stays in the tail. ──
    await flushAll(w)
    const mixed = await runAll(w, 'lake + tail')
    const c2 = mixed.costs.get('a/rate-sum-by')!
    expect(c2.files).toBeGreaterThanOrEqual(2) // a samples file and its series file, at least
    expect(c2.tail).toBeGreaterThanOrEqual(2)
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
    expect(tail.bodies.size).toBe(2 * QUERIES.length)
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
