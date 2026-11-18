/**
 * Concurrency: many queries at once, for two tenants, each exactly right; and the same
 * while the data moves from the tails to the lake underneath them.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { QUERIES, type Tenant, type World, cost, discardAll, expected, flushAll, ingest, run, sealAll, world } from './world'

let w: World
beforeAll(async () => {
  w = await world()
  await ingest(w)
  await flushAll(w)
})

const batch = (n: number, offset = 0): { t: Tenant; q: (typeof QUERIES)[number] }[] => Array.from({ length: n }, (_, i) => ({ t: i % 2 ? w.b : w.a, q: QUERIES[(offset + i * 7) % QUERIES.length]! }))

describe('concurrent queries', () => {
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
    const moving = (async () => {
      await sealAll(w)
      await flushAll(w)
      await discardAll(w)
    })()
    const out = await Promise.all(jobs.map(async ({ t, q }, i) => {
      await new Promise((r) => setTimeout(r, i % 10)) // spread the starts across the flush
      return { t, q, res: await run(t.key, q) }
    }))
    await moving
    let replanned = 0
    for (const { t, q, res } of out) {
      expect(await res.json(), `${t.which} ${q.id}`).toEqual(expected[t.which][q.id])
      if (cost(res, 'Plan-Attempts') > 1) replanned++
    }
    console.log(`MEASURE concurrency: ${replanned} of 50 queries re-planned while the flush ran`)
    // And afterwards, all lake.
    const after = await Promise.all(batch(50, 5).map(async ({ t, q }) => ({ t, q, res: await run(t.key, q) })))
    for (const { t, q, res } of after) {
      expect(await res.json(), `${t.which} ${q.id}`).toEqual(expected[t.which][q.id])
      if (cost(res, 'Shards-Asked') > 0) expect(cost(res, 'Tail-Batches')).toBe(0)
    }
  })
})
