/**
 * Concurrency: many queries at once, for two tenants, each exactly right; and the same
 * while the data moves from the tails to the lake underneath them.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { hooks } from '../src/coordinator'
import { QUERIES, type Tenant, type World, cost, discardAll, expected, flushAll, ingest, run, sealAll, world } from './world'

let w: World
beforeAll(async () => {
  w = await world()
  await ingest(w)
  await flushAll(w)
})

const batch = (n: number, offset = 0): { t: Tenant; q: (typeof QUERIES)[number] }[] => Array.from({ length: n }, (_, i) => ({ t: i % 2 ? w.b : w.a, q: QUERIES[(offset + i * 7) % QUERIES.length]! }))

describe('concurrent queries', () => {
  it('a burst that would hold more file bytes than the isolate’s budget is refused with a retryable 503, not run', async () => {
    const q = QUERIES.find((x) => x.id === 'rate-sum-by')!
    const alone = await run(w.a.key, q)
    const bytes = cost(alone, 'Bytes-Read')
    expect(bytes).toBeGreaterThan(0)
    // Room for two such queries, not three. Each is held while it reads its files (after it
    // has reserved its bytes), so that they overlap.
    hooks.isolateBudgetBytes = 2 * bytes
    hooks.beforeLeafCall = () => new Promise((r) => setTimeout(r, 300))
    try {
      const out = await Promise.all([run(w.a.key, q), run(w.a.key, q), run(w.a.key, q), run(w.a.key, q)])
      const status = out.map((r) => r.status).sort()
      expect(status).toEqual([200, 200, 503, 503])
      for (const res of out) {
        if (res.status === 200) continue
        expect(await res.json()).toEqual({ status: 'error', errorType: 'unavailable', error: 'the query service is busy; retry' })
        expect([cost(res, 'Leaf-Calls'), cost(res, 'Shard-Calls')]).toEqual([0, 0])
      }
      // The budget is given back: afterwards a query runs again, and one alone always does.
      delete hooks.beforeLeafCall
      hooks.isolateBudgetBytes = 1
      expect(await (await run(w.a.key, q)).json()).toEqual(expected.a[q.id])
      expect(await (await run(w.b.key, q)).json()).toEqual(expected.b[q.id])
    } finally {
      delete hooks.beforeLeafCall
      delete hooks.isolateBudgetBytes
    }
  })

  it('50 at once, two tenants, lake + tail: every one equals the reference', async () => {
    const jobs = batch(50)
    const out = await Promise.all(jobs.map(async ({ t, q }) => ({ t, q, res: await run(t.key, q, { method: q.id.length % 2 ? 'GET' : 'POST' }) })))
    expect(out).toHaveLength(50)
    const leaves = new Set<number>()
    for (const { t, q, res } of out) {
      expect(await res.json(), `${t.which} ${q.id}`).toEqual(expected[t.which][q.id])
      leaves.add(cost(res, 'Leaves-Used'))
    }
    expect(new Set(jobs.map((j) => j.q.id)).size).toBeGreaterThan(40)
  })

  it('50 at once while everything is sealed, flushed and discarded underneath: still every one exact', async () => {
    const jobs = batch(50, 3)
    // Hold every query for a moment between its plan and its tail reads, so that the
    // flush and discard below really land inside that window for some of them.
    let k = 0
    hooks.afterPlan = () => new Promise((r) => setTimeout(r, (k++ % 12) * 100))
    const moving = (async () => {
      await new Promise((r) => setTimeout(r, 150)) // most queries have their plan by now
      await sealAll(w)
      await flushAll(w)
      await discardAll(w)
    })()
    const out = await Promise.all(jobs.map(async ({ t, q }, i) => {
      await new Promise((r) => setTimeout(r, i % 10)) // spread the starts across the flush
      return { t, q, res: await run(t.key, q) }
    }))
    await moving
    delete hooks.afterPlan
    let replanned = 0
    for (const { t, q, res } of out) {
      expect(await res.json(), `${t.which} ${q.id}`).toEqual(expected[t.which][q.id])
      if (cost(res, 'Plan-Attempts') > 1) replanned++
    }
    console.log(`MEASURE concurrency: ${replanned} of 50 queries re-planned while the flush ran`)
    expect(replanned).toBeGreaterThan(0)
    // And afterwards, all lake.
    const after = await Promise.all(batch(50, 5).map(async ({ t, q }) => ({ t, q, res: await run(t.key, q) })))
    for (const { t, q, res } of after) {
      expect(await res.json(), `${t.which} ${q.id}`).toEqual(expected[t.which][q.id])
      if (cost(res, 'Shards-Asked') > 0) expect(cost(res, 'Tail-Batches')).toBe(0)
    }
  })
})
