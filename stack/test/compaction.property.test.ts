import { afterAll, describe, expect, it } from 'vitest'
import { compactStep } from '../../compact/src/compact'
import { read } from '../../flush/test/helpers'
import { expireTenant } from '../../janitor/src/janitor'
import { env } from 'cloudflare:workers'
import { engine, flushTenant } from '../src/index'
import { DAY_MS, type Sim, type SimTenant, checkTenant, checksum, createSim, ingest, ledger, rng, shard } from './sim'

/**
 * Invariant I8: compaction preserves the de-duplicated multiset of rows exactly.
 *
 * Random runs of: ingest (four UTC days, with repeats of samples already sent), seal and
 * flush, compaction steps under random policies and clocks (so hours, closed days and
 * budgets are picked in every order), two steps at once, and a retention expire that lands
 * in the middle of a step. A step must leave what a query returns unchanged: the same
 * rows (compared line by line), the same row count and the same checksum. With an expire
 * in the middle, what is left is exactly the model minus the expired days.
 */
const sims: Sim[] = []
afterAll(() => sims.forEach((s) => s.restore()))

async function flushAll(sim: Sim, t: SimTenant): Promise<void> {
  for (const s of sim.shards) {
    await shard(s).seal(t.name)
    const r = await flushTenant(sim.env, engine, t.name, s)
    expect(r).toMatchObject({ status: 'ok', awaitingLog: false, remaining: 0 })
  }
}

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8]

describe('compaction preserves the rows (I8)', () => {
  it.each(SEEDS)('seed %i: random ingest, flush, compaction in any order, and a concurrent expire', async (seed) => {
    const r = rng(seed)
    const sim = await createSim(1, 24)
    sims.push(sim)
    const t = sim.tenants[0]!
    await env.CONFIG.put(`retention:${t.name}`, JSON.stringify({ metric_samples_days: 2 }))
    for (const s of sim.shards) await shard(s).configure({ sealBytes: 1 << 20, sealAgeMs: 3_600_000 })
    const policy = () => ({ minL0Files: 2 + r.int(3), maxL0AgeMs: r.pick([0, 600_000]), maxInputPairs: 2 + r.int(5), maxInputBytes: r.pick([6_000, 40_000, 16 << 20]), smallL2Bytes: r.pick([0, 3_000, 4 << 20]) })
    const clock = () => Date.now() + r.pick([0, 3_600_000, 3 * DAY_MS, 3 * DAY_MS])
    let merges = 0
    let conflicts = 0
    let expires = 0

    for (let step = 0; step < 40; step++) {
      const where = `seed ${seed} step ${step}`
      const op = r.int(10)
      if (op < 4) {
        // Ingest; one time in three it repeats samples that are already stored (a sender's retry).
        await ingest(sim, t, r, 1 + r.int(8), 1 + r.int(6), r.int(4))
        if (r.chance(0.33)) await ingest(sim, t, rng(seed * 1000 + step), 6, 4, r.int(4))
      } else if (op < 6) {
        await flushAll(sim, t)
      } else if (op < 9) {
        // One or two compaction steps at once. The query result must not move.
        const before = await read(t.name, sim.shards)
        const results = await Promise.all(Array.from({ length: r.chance(0.25) ? 2 : 1 }, () => compactStep(sim.env, engine, t.name, { now: clock(), policy: policy() })))
        const after = await read(t.name, sim.shards)
        expect(after.canon, where).toEqual(before.canon)
        expect(checksum(after.canon), where).toEqual(checksum(before.canon))
        for (const x of results) {
          expect(['idle', 'merged', 'conflict'], where).toContain(x.status)
          if (x.status === 'merged') {
            merges++
            // Rows only ever leave by de-duplication.
            const out = x.outputs.find((f) => f.table === 'metric_samples')!
            expect(out.rows, where).toBeLessThanOrEqual(x.job.inputRows)
            expect(after.lakeRows, where).toBeLessThanOrEqual(before.lakeRows)
          }
        }
      } else {
        // Retention expires the old days while a compaction step is between its plan and
        // its replace (everything is flushed first, so "expired" means "gone" for the model).
        await flushAll(sim, t)
        const at = r.chance(0.5) ? 'afterPlan' : 'afterPut'
        let cutoff = ''
        const x = await compactStep(sim.env, engine, t.name, {
          now: clock(),
          policy: policy(),
          hooks: { [at]: async () => { cutoff = (await expireTenant(sim.env, t.name)).beforeDay! } },
        })
        if (cutoff === '') cutoff = (await expireTenant(sim.env, t.name)).beforeDay! // the step was idle: expire anyway
        expires++
        if (x.status === 'conflict') {
          conflicts++
          // A conflicted step deletes nothing (spec/README.md F14): its outputs stay for the
          // orphan sweep, and `checkTenant` below requires them to be names the sweep can judge.
        }
        t.model.expire(cutoff)
        // Nothing of an expired day came back, whatever the step did.
        const files = (await ledger(t).plan({ table: 'metric_samples', minTs: 0, maxTs: Number.MAX_SAFE_INTEGER })).files
        for (const f of files) expect(f.day >= cutoff, `${where}: ${f.key} is live after its day expired`).toBe(true)
      }
      await checkTenant(sim, t, 0, where)
    }

    // Compact to the end with every day closed, then compare once more, also with pruning of time ranges.
    await flushAll(sim, t)
    const before = await read(t.name, sim.shards)
    for (let i = 0; i < 60; i++) {
      const x = await compactStep(sim.env, engine, t.name, { now: Date.now() + 3 * DAY_MS, policy: { maxInputPairs: 3 } })
      if (x.status === 'idle') break
      expect(x.status).toBe('merged')
      merges++
    }
    const after = await checkTenant(sim, t, 0, `seed ${seed} end`)
    expect(after.canon).toEqual(before.canon)
    expect(checksum(after.canon)).toEqual(checksum(before.canon))
    expect(after.live.every((f) => f.level === 2)).toBe(true)
    const mid = Date.now() - DAY_MS
    const half = await read(t.name, sim.shards, { minTs: mid })
    expect(half.canon).toEqual(before.canon.filter((line) => Number(/ @(\d+) =/.exec(line)![1]) >= mid))
    console.error(`I8 ${JSON.stringify({ seed, rows: after.canon.length, merges, conflicts, expires, files: after.live.length })}`)
    expect(merges).toBeGreaterThan(0)
  })
})
