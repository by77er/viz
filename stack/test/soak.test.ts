import { evictDurableObject, runDurableObjectAlarm } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterAll, describe, expect, it } from 'vitest'
import { compactStep } from '../../compact/src/compact'
import { breakLedgerLog, healLedgerLog } from '../../flush/test/helpers'
import { canonOf } from '../../flush/test/read'
import { consumeFlushBatch, sweepPending } from '../../flush/src/index'
import { expireTenant } from '../../janitor/src/janitor'
import { FLUSH_QUEUE_NAME, MAINT_QUEUE_NAME, consumeMaintBatch, engine, flushTenant, noteFlushed } from '../src/index'
import { checkedOrphans, checkedPurge, quiesce as quiesceTenant, settle } from './settle'
import { parquetReadObjects } from '../../bench/node_modules/hyparquet/src/index.js'
import { sendLogs, sendSpans } from './signals'
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
 *
 * The shards run in registration mode `logged` (D61): a new stream takes no write until its
 * registration is in its ledger's log. Every stream is new at the start, so the run begins by
 * registering them the way senders do (the same request, retried while it is refused), with
 * evictions between attempts; each such request names one slot, so a refusal stores nothing
 * and the model stays exact.
 *
 * It runs twice: as it always has (`INGEST_SIGNALS` off: nothing of stage 2 runs, and the
 * operations and checks are exactly the metrics soak's), and with spans and logs (stage 2 of
 * traces and logs): every tenant also sends OTLP traces and logs through edge, to the shards of
 * its derived pools, which seal, flush (through the same flush queue, with the same injected
 * crashes), expire (by `trace_days` and `log_days`), purge and sweep with everything else; and
 * every check also requires a reader to see exactly the acknowledged spans and log records,
 * from the files and the tails (test/signals.ts). Those decisions take a generator of their own
 * (`rs`), so the metric operations are drawn as in the run without them. Compaction merges the
 * span and log tables too (compact/, contracts/TRACES.md and LOGS.md "Compaction"): every check
 * then reads merged files, the old-plan reader also reads its plan's span and log files after
 * maintenance ran, and the end requires every span and log file at level 2.
 */
const vars = env as unknown as { SOAK_STEPS?: string; SOAK_SEED?: string }
const STEPS = Number(vars.SOAK_STEPS ?? 400)
const SEED = Number(vars.SOAK_SEED ?? 20261118)
const DELETE_GRACE = 1500
const ORPHAN_GRACE = 1000
const STEP = 1500
const MAX_FLUSH_RETRIES = 8
const GRACES = { deleteGraceMs: DELETE_GRACE, orphanGraceMs: ORPHAN_GRACE, stepMs: STEP }

let sim: Sim
afterAll(() => sim?.restore())
const vars2 = env as unknown as { SOAK_SIGNALS?: string }
/** Which runs: `off`, `on`, or both (the default). */
const RUNS = (vars2.SOAK_SIGNALS ?? 'off,on').split(',').map((x) => x.trim() === 'on')

/** `evictDurableObject`, except that an object that is not running is left alone (the runtime refuses to evict it). */
const evict = (stub: Parameters<typeof evictDurableObject>[0]): Promise<void> =>
  evictDurableObject(stub).catch((e: Error) => {
    if (!/not currently running/.test(e.message)) throw e
  })

describe('soak', () => {
  for (const signals of RUNS) it(`${STEPS} random operations keep every invariant (seed ${SEED})${signals ? ', with spans and logs (INGEST_SIGNALS on)' : ''}`, { timeout: 3_600_000 }, async () => {
    const r = rng(SEED)
    /** Stage 2's decisions, apart from the metric operations' (`r`). */
    const rs = rng(SEED ^ 0x5157)
    sim?.restore()
    sim = await createSim(3, 30, { signals })
    const policy = signals ? { metric_samples_days: 2, trace_days: 3, log_days: 1 } : { metric_samples_days: 2 }
    for (const t of sim.tenants) await env.CONFIG.put(`retention:${t.name}`, JSON.stringify(policy))
    for (const s of [...sim.shards, ...sim.signalShards]) await shard(s).configure({ sealBytes: 6000, sealAgeMs: 0, retainRecordedMs: 0, fingerprintTtlMs: 0, seriesPersistMs: 0, notifyRetryMs: 0, registration: 'logged' })
    const maint = { deleteGraceMs: DELETE_GRACE, orphanGraceMs: ORPHAN_GRACE, maxCompactStepMs: STEP, orphanEveryMs: 0, maxCompactSteps: 3 }
    const compaction = () => ({ minL0Files: 2 + r.int(3), maxL0AgeMs: r.pick([0, 600_000]), maxInputPairs: 2 + r.int(5), maxStepMs: STEP })
    const clock = () => Date.now() + r.pick([0, 3_600_000, 3 * DAY_MS])
    const count: Record<string, number> = {}
    const did = (k: string, n = 1) => { count[k] = (count[k] ?? 0) + n }

    // Flushing a tenant, and every deletion checked against its rule: test/settle.ts.
    const quiesce = (t: SimTenant): Promise<void> => quiesceTenant(sim, t)
    const purge = async (t: SimTenant, where: string): Promise<void> => void (await checkedPurge(sim, t, where, GRACES, did))
    const orphans = async (t: SimTenant, where: string): Promise<void> => void (await checkedOrphans(sim, t, where, GRACES, did))

    const failing = (p: number) => ({
      afterPut: () => { if (r.chance(p)) throw new Error('injected: crash after PUT') },
      afterAddUnit: () => { if (r.chance(p)) throw new Error('injected: crash after addUnit') },
      afterRecorded: () => { if (r.chance(p)) throw new Error('injected: crash after recorded') },
    })

    // Registration before writes: each tenant's first request to each slot is refused
    // `registering` (edge as built answers it 429; it is to answer 503: shard/README.md, "Needed
    // changes elsewhere") until the ledger has logged the registration. The sender retries the
    // same bytes; the shard and the ledger are evicted between attempts half the time.
    const t0 = Date.now()
    for (const t of sim.tenants) {
      for (let slot = 0; slot < sim.shards.length; slot++) {
        const seed = SEED * 31 + sim.tenants.indexOf(t) * 7 + slot
        for (let attempt = 0; ; attempt++) {
          const status = await ingest(sim, t, rng(seed), 4, 3, 0, t0, slot)
          if (status === 204) break
          did(`warm-up ${status}`)
          expect(attempt, `warm-up of ${t.name} slot ${slot}`).toBeLessThan(150)
          if (r.chance(0.5)) await evict(shard(sim.shards[slot]!))
          if (r.chance(0.5)) await evict(ledger(t))
          await new Promise((x) => setTimeout(x, 100))
        }
        expect((await shard(sim.shards[slot]!).describe(t.name))?.registered, `${t.name} slot ${slot} registered`).toBe(true)
      }
      // Stage 2: each tenant's first spans and logs to each slot of its derived pools, resent
      // while refused `registering` (edge answers 503), as for the metric slots.
      if (t.signals) {
        for (const signal of ['traces', 'logs'] as const) {
          for (let slot = 0; slot < sim.map.slots; slot++) {
            const sender = t.senders!.find((x) => x.slots[signal] === slot)
            if (!sender) continue
            const n = signal === 'traces' ? await sendSpans(t.signals, t.key, sender, rs, 2, 0) : await sendLogs(t.signals, t.key, sender, rs, 2, 0)
            did(`warm-up ${signal} refusals`, n)
          }
        }
      }
      await checkTenant(sim, t, DELETE_GRACE, 'warm-up')
    }

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
        const ours = [...sim.shards, ...sim.signalShards]
        did('sweep re-enqueued', s.enqueued.filter((m) => ours.includes(m.shard)).length)
        // Messages for other test files' shards are not this simulation's.
        for (let i = sim.flushQueue.length - 1; i >= 0; i--) if (!ours.includes(sim.flushQueue[i]!.body.shard)) sim.flushQueue.splice(i, 1)
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
              if (report.expired.beforeDay !== null) tt.model.expire(report.expired.beforeDay)
              tt.signals?.expire(report.expired)
              did('files expired', report.expired.removed.length)
              did('merges', report.compaction.merged)
              for (const x of report.compaction.steps) if (x.status === 'merged' && x.job.table) did(`merges of ${x.job.table}`)
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
        for (const x of results) did(x.status === 'rejected' ? 'compaction crashed' : `compaction ${x.value.status}${'job' in x.value && x.value.job.table ? ` (${x.value.job.table})` : ''}`)
        for (const x of results) if (x.status === 'fulfilled') expect(x.value.status, where).not.toBe('error')
      } else if (op < 82) {
        // Retention, with a compaction step running across it.
        await quiesce(t)
        const expire = async () => {
          const e = await expireTenant(sim.env, t.name)
          t.model.expire(e.beforeDay!)
          t.signals?.expire(e)
        }
        const x = await compactStep(sim.env, engine, t.name, { now: clock(), policy: compaction(), hooks: { afterPut: expire } })
        await expire()
        did(`retention (compaction ${x.status})`)
      } else if (op < 87) {
        await purge(t, where)
      } else if (op < 90) {
        await orphans(t, where)
      } else if (op < 94) {
        // Eviction: the object restarts from storage (and a broken ledger log is whole again).
        // An object that has not run yet (early in some seeds) has nothing to evict.
        if (r.chance(0.5)) {
          await evict(shard(r.pick(sim.shards)))
          touched = sim.tenants
        } else await evict(ledger(t))
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
        // With spans and logs: the same reader takes its plan of the span and log tables too, at
        // that version (compaction of those tables runs in the steps below).
        const sig = t.signals ? await Promise.all((['spans', 'trace_index', 'logs'] as const).map((table) => ledger(t).plan({ table, minTs: 0, maxTs: Number.MAX_SAFE_INTEGER }))) : []
        if (s1.version === s2.version && sig.every((p) => p.version === s1.version)) {
          const started = Date.now()
          const fetch = (keys: string[]) => Promise.all(keys.map(async (k) => {
            const o = await env.BUCKET.get(k)
            expect(o, `${where}: ${k} of a plan ${Date.now() - started} ms old is gone`).not.toBeNull()
            return new Uint8Array(await o!.arrayBuffer())
          }))
          const select = async () => canonOf(engine.select({ sampleFiles: await fetch(s1.files.map((f) => f.key)), seriesFiles: await fetch(s2.files.map((f) => f.key)), tailBatches: [] }, [], 0, 253_402_300_799_999))
          // The span and log files of the old plan, read (hyparquet) in its precedence order.
          const signalRows = async () => {
            const out: string[] = []
            for (const p of sig) for (const [k, bytes] of (await fetch(p.files.map((f) => f.key))).entries()) for (const r of await parquetReadObjects({ file: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer })) out.push(`${k} ${JSON.stringify(r, (_, v) => (typeof v === 'bigint' ? String(v) : v instanceof Uint8Array ? Array.from(v) : v))}`)
            return out
          }
          const expectedSignals = await signalRows()
          const expected = await select()
          for (let i = 0; i < 4; i++) await compactStep(sim.env, engine, t.name, { now: Date.now() + 3 * DAY_MS, policy: compaction() })
          await purge(t, where)
          await orphans(t, where)
          if (Date.now() - started < DELETE_GRACE) {
            expect(await select(), `${where}: the old plan reads differently`).toEqual(expected)
            if (t.signals) expect(await signalRows(), `${where}: the old plan's span and log files read differently`).toEqual(expectedSignals)
            did('old-plan readers verified')
          }
        }
      }

      // Stage 2: spans and logs for the tenant, and the derived pools' shards sealed, alarmed and
      // evicted now and then, all drawn from `rs`.
      if (t.signals) {
        const sender = t.senders![rs.int(t.senders!.length)]!
        if (rs.chance(0.3)) did(`spans sent (refusals ${await sendSpans(t.signals, t.key, sender, rs, 1 + rs.int(4), rs.int(4))})`)
        if (rs.chance(0.3)) did(`logs sent (refusals ${await sendLogs(t.signals, t.key, sender, rs, 1 + rs.int(6), rs.int(4))})`)
        const s = sim.signalShards[rs.int(sim.signalShards.length)]!
        const o = rs.int(100)
        if (o < 6 && (await shard(s).seal(t.name))) did('signal seal by hand')
        else if (o < 10) {
          await runDurableObjectAlarm(shard(s))
          touched = sim.tenants
          did('signal shard alarm')
        } else if (o < 13) {
          await evict(shard(s))
          touched = sim.tenants
          did('signal shard evictions')
        }
        if (!touched.includes(t)) touched = [...touched, t]
      }

      for (const x of step % 20 === 19 ? sim.tenants : touched) await checkTenant(sim, x, DELETE_GRACE, where)
    }

    // ── The end: everything flushed, compacted, expired and deleted; nothing left over. ──
    // A maintenance run with a clock days ahead may have expired all of a tenant's data, so
    // each tenant first sends one more request of today's samples: the end state has rows.
    for (const t of sim.tenants) expect(await ingest(sim, t, r, 5, 3, 0)).toBe(204)
    // Then flush, expire, compact and delete everything, once the graces have passed and the
    // ledgers have logged their removals, and require that nothing is left (test/settle.ts).
    await settle(sim, GRACES, did)
    console.error(`SOAK ${JSON.stringify({ steps: STEPS, seed: SEED, ...(signals ? { signals: true, spans: sim.tenants.map((t) => t.signals!.spans.size), logs: sim.tenants.map((t) => t.signals!.logs.size) } : {}), rows: sim.tenants.map((t) => t.model.size), dead_letters: sim.dead.length, ...count })}`)
    expect(sim.tenants.every((t) => t.model.size > 0)).toBe(true)
    sim.restore()
  })
})
