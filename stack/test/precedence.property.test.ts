import { runDurableObjectAlarm } from 'cloudflare:test'
import { afterAll, describe, expect, it } from 'vitest'
import { compactStep } from '../../compact/src/compact'
import { type PrwSeries, bitsOf, postWrite } from '../../edge/test/helpers'
import { read } from '../../flush/test/helpers'
import { engine, flushTenant } from '../src/index'
import { DAY_MS, INGEST, type Sim, checkTenant, createSim, ledger, rng, shard } from './sim'

/**
 * The latest write wins (contracts/ledger.ts `LiveFile`, contracts/TABLES.md "Precedence").
 *
 * A small pool of (series, ts) keys is written again and again with new values, in many
 * small segments (so every stream passes sequence number 10, where key order and sequence
 * order part), flushed, compacted under random policies and clocks (open hours, closed
 * days, budgets that split a day into several merges, two steps at once), and discarded
 * from the shards. After every step a query must return, for every key, the value of the
 * LAST acknowledged write, whether the key's rows are in the tail, in flush files, in
 * compaction outputs, or in several of them at once.
 */
const sims: Sim[] = []
afterAll(() => sims.forEach((s) => s.restore()))

const SEEDS = [11, 12, 13, 14, 15, 16]

describe('the latest write wins (precedence)', () => {
  it.each(SEEDS)('seed %i: random rewrites of the same samples across flushes and compactions', async (seed) => {
    const r = rng(seed)
    const sim = await createSim(1, 8)
    sims.push(sim)
    const t = sim.tenants[0]!
    for (const s of sim.shards) await shard(s).configure({ sealBytes: 1 << 20, sealAgeMs: 3_600_000, retainRecordedMs: 0, fingerprintTtlMs: 0 })
    // Keys: 6 series × 6 times, today across three hours and yesterday (closed with a clock a day ahead).
    const base = Math.floor((Date.now() - 4 * 3_600_000) / 60_000) * 60_000
    const times = [0, 20, 50, 70, 110, 130].map((m) => base + m * 60_000)
    const keys = [0, 1, 2, 3, 4, 5].flatMap((i) => [...times, times[1]! - DAY_MS, times[4]! - DAY_MS].map((ts) => ({ i, ts })))
    let writes = 0
    let rewrites = 0
    let merges = 0
    let conflicts = 0
    const written = new Set<string>()
    const policy = () => ({ minL0Files: 2 + r.int(3), maxL0AgeMs: r.pick([0, 600_000]), maxInputPairs: 2 + r.int(5), maxInputBytes: r.pick([5_000, 20_000, 16 << 20]), smallL2Bytes: r.pick([0, 4_000, 4 << 20]) })
    const clock = () => Date.now() + r.pick([0, 3_600_000, 2 * DAY_MS])

    for (let step = 0; step < 70; step++) {
      const where = `seed ${seed} step ${step}`
      const op = r.int(10)
      if (op < 5) {
        // A write of 1–4 keys with new values; then, mostly, a seal, so segments stay small.
        const picked = new Map<string, { i: number; ts: number }>()
        for (let n = 1 + r.int(4); picked.size < n; ) {
          const k = r.pick(keys)
          picked.set(`${k.i}@${k.ts}`, k)
        }
        const bySeries = new Map<number, PrwSeries>()
        for (const { i, ts } of picked.values()) {
          const s = bySeries.get(i) ?? { labels: t.series[i]!.labels, samples: [] }
          s.samples.push({ ts, value: ++writes * 1.5 + seed })
          bySeries.set(i, s)
        }
        const body = [...bySeries.values()]
        const res = await postWrite(t.key, body, { env: INGEST })
        expect(res.status, where).toBe(204)
        for (const s of body) {
          for (const x of s.samples) {
            const k = `${s.labels.find(([n]) => n === 'k')![1]}@${x.ts}`
            if (written.has(k)) rewrites++
            written.add(k)
            t.model.add(Object.fromEntries(s.labels), Number(x.ts), bitsOf(x.value as number))
          }
        }
        if (r.chance(0.8)) for (const s of sim.shards) await shard(s).seal(t.name)
      } else if (op < 7) {
        for (const s of sim.shards) {
          const x = await flushTenant(sim.env, engine, t.name, s)
          expect(x.status, `${where}: ${x.reason} ${x.detail}`).toBe('ok')
        }
      } else if (op < 9) {
        const results = await Promise.all(Array.from({ length: r.chance(0.25) ? 2 : 1 }, () => compactStep(sim.env, engine, t.name, { now: clock(), policy: policy() })))
        for (const x of results) {
          expect(['idle', 'merged', 'conflict'], `${where}: ${JSON.stringify(x)}`).toContain(x.status)
          if (x.status === 'merged') merges++
          if (x.status === 'conflict') conflicts++
        }
      } else {
        // The shards discard what is recorded: those rows are now only in the lake.
        for (const s of sim.shards) await runDurableObjectAlarm(shard(s))
      }
      await checkTenant(sim, t, 0, where)
    }

    // Everything flushed and compacted to the end with every day closed: still the latest values.
    for (const s of sim.shards) {
      await shard(s).seal(t.name)
      expect((await flushTenant(sim.env, engine, t.name, s)).status).toBe('ok')
      await runDurableObjectAlarm(shard(s))
    }
    for (let i = 0; i < 80; i++) {
      const x = await compactStep(sim.env, engine, t.name, { now: Date.now() + 2 * DAY_MS, policy: { maxInputPairs: 3 } })
      if (x.status === 'idle') break
      expect(x.status).toBe('merged')
      merges++
    }
    const end = await checkTenant(sim, t, 0, `seed ${seed} end`)
    expect(end.live.every((f) => f.level === 2)).toBe(true)
    expect((await read(t.name, sim.shards)).tailRows).toBe(0)
    // The run exercised what it is about: rewrites, streams past sequence 10, merges.
    const seqs = await Promise.all(sim.shards.map(async (s) => (await shard(s).describe(t.name))?.nextSeq ?? 0))
    const files = (await ledger(t).plan({ table: 'metric_samples', minTs: 0, maxTs: Number.MAX_SAFE_INTEGER })).files
    console.error(`PRECEDENCE ${JSON.stringify({ seed, writes, rewrites, keys: written.size, merges, conflicts, nextSeq: seqs, files: files.length })}`)
    expect(rewrites).toBeGreaterThan(10)
    expect(Math.max(...seqs)).toBeGreaterThan(12)
    expect(merges).toBeGreaterThan(3)
  })
})
