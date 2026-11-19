/**
 * The soak's checked deletions and its end phase, shared by the soak (test/soak.test.ts) and
 * the end phase's regression test (test/settle.test.ts).
 *
 *   quiesce        everything of one tenant flushed and recorded, with nothing injected
 *   checkedPurge   purgeTenant, with every deletion checked against the rule that allows it
 *   checkedOrphans sweepOrphans, likewise
 *   settle         the end: flush, expire and compact everything, wait out the graces and
 *                  for the ledger to log its removals, delete, and require that nothing is
 *                  left over
 */
import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { expect } from 'vitest'
import { COMPACTION_INPUTS_META, compactStep, decodeCompactionInputs } from '../../compact/src/compact'
import type { Watermark } from '../../contracts/ledger'
import { dataKeys, healLedgerLog } from '../../flush/test/helpers'
import { type OrphanResult, type PurgeResult, expireTenant, purgeTenant, sweepOrphans } from '../../janitor/src/janitor'
import type { Ledger } from '../../ledger/src/ledger'
import { engine, flushTenant, noteFlushed } from '../src/index'
import { DAY_MS, type Sim, type SimTenant, checkTenant, ledger, shard } from './sim'

/** Graces, real time scaled down: delete after `deleteGraceMs`, an orphan after `orphanGraceMs`; a compaction step gives up after `stepMs`. */
export interface Graces {
  deleteGraceMs: number
  orphanGraceMs: number
  stepMs: number
}

/** Counts for the soak's summary line. */
export type Count = (what: string, n?: number) => void

/**
 * How long the end phase waits for a ledger to log what it has committed. The ledger drains
 * by itself: 200 ms after a commit, or, after a failed write, once its backoff ends, which is
 * at most 60 s (contracts/LEDGER-LOG.md, "Drain": 1 s doubling to 60 s). Past this the ledger
 * is not draining at all, and the end phase fails instead of waiting longer.
 */
export const LOG_WAIT_MS = 75_000

const FLUSH_FILE = /\/L0-(.+)-(\d+)-(\d+)-(\d+)-[0-9a-f]{8}\.parquet$/
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Everything of one tenant flushed and recorded, with nothing injected. */
export async function quiesce(sim: Sim, t: SimTenant): Promise<void> {
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
export async function checkedPurge(sim: Sim, t: SimTenant, where: string, g: Graces, did: Count = () => {}): Promise<PurgeResult> {
  const tombstones = new Map((await ledger(t).removedSince(0, 10_000)).map((x) => [x.key, x]))
  const firstUnlogged = await runInDurableObject(ledger(t), (_i: Ledger, state) => (state.storage.sql.exec(`SELECT MIN(version) AS v FROM outbox`).one().v as number | null) ?? Infinity)
  const p = await purgeTenant(sim.env, t.name, { graceMs: g.deleteGraceMs })
  // The ledger judged the age at some moment during the call: by the time it has
  // returned, every deleted key must be at least the grace old.
  const done = Date.now()
  for (const key of p.deleted) {
    const x = tombstones.get(key)
    expect(x, `${where}: ${key} deleted without a tombstone`).toBeDefined()
    expect(done - x!.at, `${where}: ${key} deleted inside the grace`).toBeGreaterThanOrEqual(g.deleteGraceMs)
    expect(x!.version, `${where}: ${key} deleted before its removal was logged`).toBeLessThan(firstUnlogged)
  }
  did('objects purged', p.deleted.length)
  return p
}

/** Sweep orphans, and check each deletion: unreferenced, old enough, and never admissible. */
export async function checkedOrphans(sim: Sim, t: SimTenant, where: string, g: Graces, did: Count = () => {}): Promise<OrphanResult> {
  const listed = new Map<string, number>()
  const inputsOf = new Map<string, string | undefined>()
  for (const table of ['metric_samples', 'metric_series']) {
    for (const o of (await env.BUCKET.list({ prefix: `${env.CELL}/data/${table}/tenant=${t.name}/`, include: ['customMetadata'] })).objects) {
      listed.set(o.key, o.uploaded.getTime())
      inputsOf.set(o.key, o.customMetadata?.[COMPACTION_INPUTS_META])
    }
  }
  const logged: Watermark[] = await ledger(t).loggedWatermarks()
  const o = await sweepOrphans(sim.env, t.name, { graceMs: g.orphanGraceMs, maxCompactStepMs: g.stepMs })
  const before = Date.now() // ages are judged during the call; see `checkedPurge`
  if (o.deleted.length > 0) {
    const after = await ledger(t).orphanCheck(o.deleted)
    expect([after.live, after.tombstoned], `${where}: the orphan sweep deleted a referenced object`).toEqual([[], []])
  }
  for (const key of o.deleted) {
    const age = before - listed.get(key)!
    const m = FLUSH_FILE.exec(key)
    if (m) {
      expect(age, `${where}: ${key} deleted young`).toBeGreaterThanOrEqual(g.orphanGraceMs)
      const w = logged.find((x) => x.shard.replaceAll('/', '_') === m[1])
      const dead = w !== undefined && (w.incarnation > Number(m[2]) || (w.incarnation === Number(m[2]) && w.seq >= Number(m[4])))
      expect(dead, `${where}: ${key} deleted while its unit could still be admitted (logged ${JSON.stringify(w)})`).toBe(true)
    } else {
      // A compaction output may go only once an input of it is gone for good: its object
      // was already deleted before this sweep listed, and the ledger does not list it.
      expect(age, `${where}: compaction output ${key} deleted young`).toBeGreaterThanOrEqual(2 * g.stepMs)
      const d = await decodeCompactionInputs(key, inputsOf.get(key))
      expect('inputs' in d, `${where}: compaction output ${key} deleted although its inputs cannot be read`).toBe(true)
      const gone = 'inputs' in d ? d.inputs.filter((k) => !listed.has(k)) : []
      const live = new Set((await ledger(t).orphanCheck(gone)).live)
      expect(gone.some((k) => !live.has(k)), `${where}: compaction output ${key} deleted while all its inputs remain`).toBe(true)
    }
  }
  did('orphans deleted', o.deleted.length)
  return o
}

/**
 * Wait until the tenant's ledger has logged everything it committed, by its own background
 * drain (no `drain()` here: that is what is being waited for); returns the milliseconds
 * waited, 0 if nothing was pending. A removal may be purged only once it is logged, and a
 * ledger whose log failed a while ago drains only when its backoff ends, up to 60 s later,
 * even if its log works again (the soak's outage, healed by hand). An operator, or the next
 * maintenance run (`purged.waiting > 0` schedules one), waits too.
 */
export async function awaitLogged(t: SimTenant, where: string, timeoutMs = LOG_WAIT_MS): Promise<number> {
  const started = Date.now()
  if ((await ledger(t).outboxDepth()) === 0) return 0
  do {
    if (Date.now() - started > timeoutMs) {
      expect.fail(`${where}: ${t.name}'s ledger did not log its changes within ${timeoutMs} ms: ${JSON.stringify(await ledger(t).logStatus())}`)
    }
    await sleep(50)
  } while ((await ledger(t).outboxDepth()) > 0)
  return Math.max(1, Date.now() - started)
}

export interface SettleHooks {
  /** After a tenant is quiesced (its log drained by an explicit `drain()`), before its expiry and merges commit (tests: inject an outage). */
  afterQuiesce?(t: SimTenant): Promise<void>
  /** After a tenant's expiry and merges have committed, before the graces are waited out (tests: let the drain back off, heal). */
  afterRemovals?(t: SimTenant): Promise<void>
  /** After the graces have passed, before waiting for the logs (tests: the state the end phase finds). */
  afterGrace?(t: SimTenant): Promise<void>
}

/**
 * The end: everything flushed, compacted, expired and deleted; nothing left over. The objects
 * in R2 must then be exactly the ledger's live set, all level 2, with no tombstone and no
 * pending segment left.
 */
export async function settle(sim: Sim, g: Graces, did: Count = () => {}, hooks: SettleHooks = {}): Promise<void> {
  for (const t of sim.tenants) {
    await quiesce(sim, t)
    await hooks.afterQuiesce?.(t)
    const expired = await expireTenant(sim.env, t.name)
    t.model.expire(expired.beforeDay!)
    t.signals?.expire(expired)
    for (let i = 0; i < 200; i++) {
      const x = await compactStep(sim.env, engine, t.name, { now: Date.now() + 3 * DAY_MS, policy: { maxInputPairs: 4, maxStepMs: g.stepMs } })
      if (x.status === 'idle') break
      expect(x.status).toBe('merged')
    }
    await checkTenant(sim, t, g.deleteGraceMs, 'end, before deletion')
    await hooks.afterRemovals?.(t)
  }
  await sleep(Math.max(g.deleteGraceMs, 2 * g.stepMs, g.orphanGraceMs) + 200)
  for (const t of sim.tenants) {
    await hooks.afterGrace?.(t)
    // The removals above are deletable once they are old enough AND logged. The sleep covers
    // the first; the ledger's drain decides the second, and it may still be backing off.
    const waited = await awaitLogged(t, 'end')
    if (waited > 0) {
      did('end: tenants whose removals were unlogged after the graces', 1)
      did('end: ms waited for their ledgers to log', waited)
    }
    await checkedPurge(sim, t, 'end', g, did)
    await checkedOrphans(sim, t, 'end', g, did)
    const state = await checkTenant(sim, t, g.deleteGraceMs, 'end')
    // The ledger's live set is exactly what is in R2, every file is level 2, and nothing waits.
    expect(state.objects).toEqual(state.live.map((f) => f.key).sort())
    expect(state.objects).toEqual(await dataKeys(t.name))
    expect(state.tombstones).toEqual([])
    expect(state.live.every((f) => f.level === 2)).toBe(true)
    for (const s of sim.shards) expect(await shard(s).pendingSegments(t.name)).toEqual([])
  }
}
