import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterAll, describe, expect, it } from 'vitest'
import { compactStep } from '../../compact/src/compact'
import type { Watermark } from '../../contracts/ledger'
import { breakLedgerLog, dataKeys, healLedgerLog } from '../../flush/test/helpers'
import { canonOf } from '../../flush/test/read'
import { consumeFlushBatch, sweepPending } from '../../flush/src/index'
import { expireTenant, purgeTenant, sweepOrphans } from '../../janitor/src/janitor'
import type { Ledger } from '../../ledger/src/ledger'
import { FLUSH_QUEUE_NAME, MAINT_QUEUE_NAME, consumeMaintBatch, engine, flushTenant, noteFlushed } from '../src/index'
import { DAY_MS, type Sim, type SimTenant, checkTenant, createSim, deliver, ingest, ledger, rng, shard, take } from './sim'

/**
 * Soak: thousands of random operations on three tenants sharing two shards, with the
 * invariants of `checkTenant` asserted after every step for the tenants the step touched
 * (all tenants every 20 steps), and each deletion checked against the rule that allows it.
 *
 *   SOAK_STEPS=3000 SOAK_SEED=1 npx vitest run test/soak.test.ts
 *
 * Graces are real time, scaled down: a removed file may be deleted after DELETE_GRACE, an
 * unreferenced flush file after ORPHAN_GRACE, and a compaction step gives up after STEP.
 */
const vars = env as unknown as { SOAK_STEPS?: string; SOAK_SEED?: string }
const STEPS = Number(vars.SOAK_STEPS ?? 400)
const SEED = Number(vars.SOAK_SEED ?? 20261118)
const DELETE_GRACE = 1500
const ORPHAN_GRACE = 1000
const STEP = 1500
const MAX_FLUSH_RETRIES = 8
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let sim: Sim
afterAll(() => sim?.restore())

const FLUSH_FILE = /\/L0-(.+)-(\d+)-(\d+)-(\d+)-[0-9a-f]{8}\.parquet$/

describe('soak', () => {
  it(`${STEPS} random operations keep every invariant (seed ${SEED})`, { timeout: 3_600_000 }, async () => {
    const r = rng(SEED)
    sim = await createSim(3, 30)
    const policy = { metric_samples_days: 2 }
    for (const t of sim.tenants) await env.CONFIG.put(`retention:${t.name}`, JSON.stringify(policy))
    for (const s of sim.shards) await shard(s).configure({ sealBytes: 6000, sealAgeMs: 0, retainRecordedMs: 0, fingerprintTtlMs: 0, seriesPersistMs: 0, notifyRetryMs: 0 })
    const maint = { deleteGraceMs: DELETE_GRACE, orphanGraceMs: ORPHAN_GRACE, maxCompactStepMs: STEP, orphanEveryMs: 0, maxCompactSteps: 3 }
    const compaction = () => ({ minL0Files: 2 + r.int(3), maxL0AgeMs: r.pick([0, 600_000]), maxInputPairs: 2 + r.int(5), maxStepMs: STEP })
    const clock = () => Date.now() + r.pick([0, 3_600_000, 3 * DAY_MS])
    const count: Record<string, number> = {}
    const did = (k: string, n = 1) => { count[k] = (count[k] ?? 0) + n }

    /** Everything of one tenant flushed and recorded, with nothing injected. */
    const quiesce = async (t: SimTenant): Promise<void> => {
      await healLedgerLog(ledger(t))
      await ledger(t).drain()
      for (const s of sim.shards) {
        await shard(s).seal(t.name)
        for (let i = 0; ; i++) {
          const x = await flushTenant(sim.env, engine, t.name, s)
          expect(x.status, `quiesce ${t.name} ${s}: ${x.reason} ${x.detail}`).toBe('ok')
          if (!x.awaitingLog && x.remaining === 0) break
          expect(i).toBeLessThan(5)
          await ledger(t).drain()
        }
        if (await shard(s).describe(t.name)) await noteFlushed(sim.env, { tenant: t.name })
      }
    }

    /** Delete what the ledger calls deletable, and check each deletion against the rule independently. */
    const purge = async (t: SimTenant, where: string): Promise<void> => {
      const tombstones = new Map((await ledger(t).removedSince(0, 10_000)).map((x) => [x.key, x]))
      const firstUnlogged = await runInDurableObject(ledger(t), (_i: Ledger, state) => (state.storage.sql.exec(`SELECT MIN(version) AS v FROM outbox`).one().v as number | null) ?? Infinity)
      const p = await purgeTenant(sim.env, t.name, { graceMs: DELETE_GRACE })
      // The ledger judged the age at some moment during the call: by the time it has
      // returned, every deleted key must be at least the grace old.
      const done = Date.now()
      for (const key of p.deleted) {
        const x = tombstones.get(key)
        expect(x, `${where}: ${key} deleted without a tombstone`).toBeDefined()
        expect(done - x!.at, `${where}: ${key} deleted inside the grace`).toBeGreaterThanOrEqual(DELETE_GRACE)
        expect(x!.version, `${where}: ${key} deleted before its removal was logged`).toBeLessThan(firstUnlogged)
      }
      did('objects purged', p.deleted.length)
    }

    /** Sweep orphans, and check each deletion: unreferenced, old enough, and never admissible. */
    const orphans = async (t: SimTenant, where: string): Promise<void> => {
      const listed = new Map<string, number>()
      for (const table of ['metric_samples', 'metric_series']) {
        for (const o of (await env.BUCKET.list({ prefix: `${env.CELL}/data/${table}/tenant=${t.name}/` })).objects) listed.set(o.key, o.uploaded.getTime())
      }
      const logged: Watermark[] = await ledger(t).loggedWatermarks()
      const o = await sweepOrphans(sim.env, t.name, { graceMs: ORPHAN_GRACE, maxCompactStepMs: STEP })
      const before = Date.now() // ages are judged during the call; see `purge`
      if (o.deleted.length > 0) {
        const after = await ledger(t).orphanCheck(o.deleted)
        expect([after.live, after.tombstoned], `${where}: the orphan sweep deleted a referenced object`).toEqual([[], []])
      }
      for (const key of o.deleted) {
        const age = before - listed.get(key)!
        const m = FLUSH_FILE.exec(key)
        if (m) {
          expect(age, `${where}: ${key} deleted young`).toBeGreaterThanOrEqual(ORPHAN_GRACE)
          const w = logged.find((x) => x.shard.replaceAll('/', '_') === m[1])
          const dead = w !== undefined && (w.incarnation > Number(m[2]) || (w.incarnation === Number(m[2]) && w.seq >= Number(m[4])))
          expect(dead, `${where}: ${key} deleted while its unit could still be admitted (logged ${JSON.stringify(w)})`).toBe(true)
        } else {
          expect(age, `${where}: compaction output ${key} deleted while a step could still list it`).toBeGreaterThanOrEqual(2 * STEP)
        }
      }
      did('orphans deleted', o.deleted.length)
    }

    const failing = (p: number) => ({
      afterPut: () => { if (r.chance(p)) throw new Error('injected: crash after PUT') },
      afterAddUnit: () => { if (r.chance(p)) throw new Error('injected: crash after addUnit') },
      afterRecorded: () => { if (r.chance(p)) throw new Error('injected: crash after recorded') },
    })

    for (let step = 0; step < STEPS; step++) {
      const where = `step ${step}`
      const t = r.pick(sim.tenants)
      let touched: SimTenant[] = [t]
      const op = r.int(100)

      if (op < 30) {
        const status = await ingest(sim, t, r, 1 + r.int(10), 1 + r.int(8), r.int(4))
        did(`ingest ${status}`)
        if (r.chance(0.2)) did(`ingest ${await ingest(sim, t, rng(SEED + step), 5, 3, r.int(4))} (repeat)`)
      } else if (op < 38) {
        if (await shard(r.pick(sim.shards)).seal(t.name)) did('seal by hand')
      } else if (op < 44) {
        // The shard's alarm: seals on age, discards recorded segments, forgets fingerprints.
        await runDurableObjectAlarm(shard(r.pick(sim.shards)))
        touched = sim.tenants
        did('shard alarm')
      } else if (op < 60) {
        // The flush queue delivers a batch: random messages, sometimes one twice, sometimes failing.
        const batch = take(sim.flushQueue, 1 + r.int(4), r)
        if (batch.length > 0 && r.chance(0.25)) batch.push({ ...batch[0]!, id: `${batch[0]!.id}-dup` })
        if (batch.length > 0) {
          const p = r.pick([0, 0, 0.3])
          const d = await deliver(sim, sim.flushQueue, FLUSH_QUEUE_NAME, batch, MAX_FLUSH_RETRIES, (b) =>
            consumeFlushBatch(b, sim.env, engine, {
              flush: (tenant, s) => flushTenant(sim.env, engine, tenant, s, { hooks: failing(p) }),
              onFlushed: (x) => noteFlushed(sim.env, x),
            }))
          did('flush messages delivered', batch.length)
          did('flush messages retried', d.retried)
          for (const o of d.outcomes) if (o.result) did('segments admitted', o.result.segments.filter((g) => g.outcome === 'admitted').length)
          touched = sim.tenants.filter((x) => batch.some((m) => m.body.tenant === x.name))
        }
      } else if (op < 63) {
        // The cron's flush sweep (no age threshold here, so it re-enqueues whatever is pending).
        const s = await sweepPending(sim.env, { olderThanMs: 0 })
        did('sweep re-enqueued', s.enqueued.filter((m) => sim.shards.includes(m.shard)).length)
        // Messages for other test files' shards are not this simulation's.
        for (let i = sim.flushQueue.length - 1; i >= 0; i--) if (!sim.shards.includes(sim.flushQueue[i]!.body.shard)) sim.flushQueue.splice(i, 1)
        touched = []
      } else if (op < 71) {
        // The maintenance queue delivers: compaction, retention's expire is NOT in here (see below), purge, orphans.
        const batch = take(sim.maintQueue, 1 + r.int(3), r)
        if (batch.length > 0) {
          const d = await deliver(sim, sim.maintQueue, MAINT_QUEUE_NAME, batch, 5, (b) =>
            consumeMaintBatch(b, sim.env, engine, { ...maint, now: Date.now() + r.pick([0, 0, 0, 3_600_000, 3 * DAY_MS]), compaction: compaction(), run: async (e, eng, tenant, o) => {
              if (r.chance(0.15)) throw new Error('injected: maintenance run failed')
              const tt = sim.tenants.find((x) => x.name === tenant)!
              // Retention inside a maintenance run removes whole days from the lake. The model can
              // follow that only if nothing of those days is still in a tail: flush first.
              await quiesce(tt)
              const report = await (await import('../src/maintain')).maintainTenant(e, eng, tenant, o)
              tt.model.expire(report.expired.beforeDay)
              did('files expired', report.expired.removed.length)
              did('merges', report.compaction.merged)
              did('objects purged', report.purged.deleted.length)
              did('orphans deleted', report.orphans?.deleted.length ?? 0)
              return report
            } }))
          did('maintenance messages delivered', batch.length)
          did('maintenance messages retried', d.retried)
          touched = sim.tenants.filter((x) => batch.some((m) => m.body.tenant === x.name))
        }
      } else if (op < 80) {
        // A compaction step on its own, sometimes crashing after its PUTs, sometimes two at once.
        const crash = r.chance(0.15)
        const run = () => compactStep(sim.env, engine, t.name, { now: clock(), policy: compaction(), hooks: crash ? { afterPut: () => { throw new Error('injected: crash after PUT') } } : {} })
        const results = await Promise.allSettled(r.chance(0.2) ? [run(), run()] : [run()])
        for (const x of results) did(x.status === 'rejected' ? 'compaction crashed' : `compaction ${x.value.status}`)
        for (const x of results) if (x.status === 'fulfilled') expect(x.value.status, where).not.toBe('error')
      } else if (op < 82) {
        // Retention, with a compaction step running across it.
        await quiesce(t)
        const x = await compactStep(sim.env, engine, t.name, { now: clock(), policy: compaction(), hooks: { afterPut: async () => { t.model.expire((await expireTenant(sim.env, t.name)).beforeDay) } } })
        t.model.expire((await expireTenant(sim.env, t.name)).beforeDay)
        did(`retention (compaction ${x.status})`)
      } else if (op < 87) {
        await purge(t, where)
      } else if (op < 90) {
        await orphans(t, where)
      } else if (op < 94) {
        // Eviction: the object restarts from storage (and a broken ledger log is whole again).
        if (r.chance(0.5)) {
          await evictDurableObject(shard(r.pick(sim.shards)))
          touched = sim.tenants
        } else await evictDurableObject(ledger(t))
        did('evictions')
      } else if (op < 96) {
        // The ledger cannot write its log for a while: units are admitted but not logged.
        await breakLedgerLog(ledger(t))
        did('ledger log broken')
      } else if (op < 98) {
        await healLedgerLog(ledger(t))
        await ledger(t).drain()
      } else {
        // A query takes its plan, maintenance runs, and the query then reads the files of its OLD plan.
        const s1 = await ledger(t).plan({ table: 'metric_samples', minTs: 0, maxTs: Number.MAX_SAFE_INTEGER })
        const s2 = await ledger(t).plan({ table: 'metric_series', minTs: 0, maxTs: Number.MAX_SAFE_INTEGER })
        if (s1.version === s2.version) {
          const started = Date.now()
          const fetch = (keys: string[]) => Promise.all(keys.map(async (k) => {
            const o = await env.BUCKET.get(k)
            expect(o, `${where}: ${k} of a plan ${Date.now() - started} ms old is gone`).not.toBeNull()
            return new Uint8Array(await o!.arrayBuffer())
          }))
          const select = async () => canonOf(engine.select({ sampleFiles: await fetch(s1.files.map((f) => f.key)), seriesFiles: await fetch(s2.files.map((f) => f.key)), tailBatches: [] }, [], 0, 253_402_300_799_999))
          const expected = await select()
          for (let i = 0; i < 4; i++) await compactStep(sim.env, engine, t.name, { now: Date.now() + 3 * DAY_MS, policy: compaction() })
          await purge(t, where)
          await orphans(t, where)
          if (Date.now() - started < DELETE_GRACE) {
            expect(await select(), `${where}: the old plan reads differently`).toEqual(expected)
            did('old-plan readers verified')
          }
        }
      }

      for (const x of step % 20 === 19 ? sim.tenants : touched) await checkTenant(sim, x, DELETE_GRACE, where)
    }

    // ── The end: everything flushed, compacted, expired and deleted; nothing left over. ──
    for (const t of sim.tenants) {
      await quiesce(t)
      t.model.expire((await expireTenant(sim.env, t.name)).beforeDay)
      for (let i = 0; i < 200; i++) {
        const x = await compactStep(sim.env, engine, t.name, { now: Date.now() + 3 * DAY_MS, policy: { maxInputPairs: 4, maxStepMs: STEP } })
        if (x.status === 'idle') break
        expect(x.status).toBe('merged')
      }
      await checkTenant(sim, t, DELETE_GRACE, 'end, before deletion')
    }
    await sleep(Math.max(DELETE_GRACE, 2 * STEP, ORPHAN_GRACE) + 200)
    for (const t of sim.tenants) {
      await purge(t, 'end')
      await orphans(t, 'end')
      const state = await checkTenant(sim, t, DELETE_GRACE, 'end')
      // The ledger's live set is exactly what is in R2, every file is level 2, and nothing waits.
      expect(state.objects).toEqual(state.live.map((f) => f.key).sort())
      expect(state.objects).toEqual(await dataKeys(t.name))
      expect(state.tombstones).toEqual([])
      expect(state.live.every((f) => f.level === 2)).toBe(true)
      for (const s of sim.shards) expect(await shard(s).pendingSegments(t.name)).toEqual([])
    }
    console.error(`SOAK ${JSON.stringify({ steps: STEPS, seed: SEED, rows: sim.tenants.map((t) => t.model.size), dead_letters: sim.dead.length, ...count })}`)
    expect(sim.tenants.every((t) => t.model.size > 0)).toBe(true)
  })
})
