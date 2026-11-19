import { runDurableObjectAlarm } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterAll, describe, expect, it } from 'vitest'
import { breakLedgerLog, healLedgerLog } from '../../flush/test/helpers'
import { engine, flushTenant } from '../src/index'
import { quiesce, settle } from './settle'
import { type Sim, createSim, ingest, ledger, rng, shard } from './sim'

/**
 * Regression test for the soak's end phase (stack/README.md, "Soak", the failure of
 * 2026-11-19). A ledger whose log failed for a while keeps backing off after the log works
 * again, until a drain succeeds: by itself (its alarm, at the end of the backoff, up to 60 s
 * later) or by an explicit `drain()` (which, since 2026-11-19, ends the backoff too). The end
 * phase's removals committed inside that backoff are logged only when it ends; the purge must
 * not delete them before they are logged, and the end phase must wait for that instead of
 * judging the end state after the graces alone.
 *
 * The outage is forced with no explicit drain after it: the log breaks once the end phase has
 * quiesced the tenant (its own `drain()` comes before), the end phase's expiry and merges
 * commit while every drain fails, the ledger's alarm runs until the drain backs off for 16 s,
 * and the log is then healed by hand, nothing more.
 */
const GRACES = { deleteGraceMs: 1500, orphanGraceMs: 1000, stepMs: 1500 } // the soak's
/** The backoff the outage leaves: five failed drains (1, 2, 4, 8, then 16 s). Far longer than the end phase takes to reach its purge. */
const BACKOFF_MS = 16_000

let sim: Sim
afterAll(() => sim?.restore())

describe("the soak's end phase", () => {
  it("reaches its end state when a ledger's drain is still backing off from an outage healed by hand (no explicit drain)", { timeout: 180_000 }, async () => {
    const r = rng(20261119)
    sim = await createSim(1, 12)
    const t = sim.tenants[0]!
    const l = ledger(t)
    await env.CONFIG.put(`retention:${t.name}`, JSON.stringify({ metric_samples_days: 2 }))
    for (const s of sim.shards) await shard(s).configure({ sealBytes: 6000, sealAgeMs: 0, retainRecordedMs: 0, fingerprintTtlMs: 0, seriesPersistMs: 0, notifyRetryMs: 0 })
    // Two requests flushed separately: level-0 files that the end phase merges, so it removes keys.
    expect(await ingest(sim, t, r, 6, 4, 0)).toBe(204)
    await quiesce(sim, t)
    expect(await ingest(sim, t, r, 6, 4, 0)).toBe(204)
    for (const s of sim.shards) {
      await shard(s).seal(t.name)
      expect((await flushTenant(sim.env, engine, t.name, s)).status).toBe('ok')
    }

    const backoff = async () => {
      const at = (await l.logStatus()).alarmAt
      return at === null ? 0 : at - Date.now()
    }
    let checked = 0
    await settle(sim, GRACES, undefined, {
      // The outage (the soak's "ledger log broken"), after the end phase's own drain.
      afterQuiesce: async () => {
        await breakLedgerLog(l)
      },
      // The end phase's expiry and merges have committed and cannot be logged; the drain backs
      // off for 16 s, and then the log is healed by hand, with no drain (the soak's "healed").
      afterRemovals: async () => {
        expect(await l.outboxDepth(), 'the end phase committed removals').toBeGreaterThan(0)
        for (let i = 0; i < 8 && (await backoff()) < BACKOFF_MS - 1000; i++) expect(await runDurableObjectAlarm(l)).toBe(true)
        expect(await backoff(), 'the drain is backing off').toBeGreaterThan(BACKOFF_MS - 1000)
        expect((await l.logStatus()).lastError).toMatch(/injected R2 failure/)
        await healLedgerLog(l)
      },
      // When the graces have passed, the removals are still unlogged: the timing of the soak's
      // failure. Purging then deletes none of them, and the objects in R2 would not be the
      // ledger's live set; the end phase must wait for the log.
      afterGrace: async (x) => {
        expect(x.name).toBe(t.name)
        expect(await l.outboxDepth(), 'the removals are still unlogged when the graces have passed').toBeGreaterThan(0)
        checked++
      },
    })
    expect(checked).toBe(1)
  })
})
