/**
 * The test world's own premise: in a two-shard world both tenants have senders in both shards.
 * Placement is a hash of names that hold a clock-derived id, so the premise fails for some ids;
 * `world()` skips them (see `reachesBothShards` in world.ts).
 */
import { describe, expect, it } from 'vitest'
import { ingest, pickId, reachesBothShards, shardOf, world } from './world'

describe('the test world', () => {
  it('an id that leaves a tenant in one shard is recognised and skipped for a two-shard world only', () => {
    // 'mwm0oeco0': found by trying 200,000 ids; 1,558 of them (0.78%) leave a tenant in one shard.
    const bad = 'mwm0oeco0'
    expect(reachesBothShards(bad)).toBe(false)
    const good = pickId(() => `${Date.now().toString(36)}x`, 2)
    const from = (ids: string[]) => () => ids.shift()!
    expect(pickId(from([bad, bad, good]), 2)).toBe(good)
    expect(pickId(from([bad, good]), 1)).toBe(bad)
    expect(pickId(from([bad, good]), 4)).toBe(bad)
  })

  it('most ids are fine, and some are not: the check is not vacuous either way', () => {
    let bad = 0
    for (let i = 0; i < 20_000; i++) if (!reachesBothShards(`${(1_795_000_000_000 + i * 977).toString(36)}0`)) bad++
    expect(bad).toBeGreaterThan(50)
    expect(bad).toBeLessThan(400)
  })

  it('a two-shard world puts both tenants in both shards', async () => {
    for (let i = 0; i < 3; i++) {
      const w = await world()
      expect(reachesBothShards(w.a.name.slice('tenant-a-'.length))).toBe(true)
      await ingest(w)
      for (const t of [w.a, w.b]) for (const s of w.shards) expect((await shardOf(s).describe(t.name))?.nextSeq, `${t.name} in ${s}`).toBeGreaterThan(1)
    }
  })
})
