/**
 * The lost-incarnation leak (spec/README.md F16) and its fix (D61): the orphan sweep asks the
 * shard of a stream whose flush files wait for a unit (`ensureStream`), a shard that lost the
 * stream starts and registers a fresh incarnation, and the sweep calls an older incarnation's
 * files dead once a newer registration is LOGGED (`loggedIncarnation`), never once merely
 * committed (F15). Real shard, ledger, flush, compaction and janitor; storage loss is
 * `deleteAll` and eviction; objects are evicted between steps.
 *
 *   spec test 5  "spec F16": `LEAK_D30_sl_comp2`'s 19 steps with the registration first. Sweep 1
 *                keeps all the objects and asks the shard (which registers a fresh incarnation);
 *                after the drain a later sweep deletes the flush files, and the next the output
 *   spec test 6  "spec F15, adapted": `P_teeth_newer_committed`'s trace. A file of the old
 *                incarnation is kept while the newer registration is only committed; a rebuild
 *                rolls the registration back and the flush Worker's late unit makes the file live
 *                with its object
 *   review m-6   a shard of the release before D61 (no `ensureStream`): files kept, the sweep goes
 *                on; a ledger before D61 (no `loggedIncarnation`): D30's rule, files kept
 */
import { evictDurableObject, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { compactStep } from '../../compact/src/compact'
import type { LoggedWatermark } from '../../contracts/ledger'
import { flushTenant } from '../../flush/src/flush'
import { engine } from '../../flush/src/index'
import { DAY_MS, Sent, T0, append, dataKeys, liveKeys, read, someSamples, stream } from '../../flush/test/helpers'
import type { ShardConfig } from '../../shard/src/shard'
import { type JanitorEnv, sweepOrphans } from '../src/index'

const LOGGED: Partial<ShardConfig> = { registration: 'logged', registerBackoffMs: 20, registerBackoffMaxMs: 200 }
const LATER = { graceMs: 0, now: Date.now() + DAY_MS }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const exists = async (keys: string[]) => (await Promise.all(keys.map((k) => env.BUCKET.head(k)))).map((o) => o !== null)
const evict = (x: Parameters<typeof evictDurableObject>[0]) => evictDurableObject(x).catch((e: Error) => { if (!/not currently running/.test(e.message)) throw e })
const loseStorage = async (x: Parameters<typeof evictDurableObject>[0]) => {
  await runInDurableObject(x, async (_i, st) => { await st.storage.deleteAll() })
  await evict(x)
}
type S = ReturnType<typeof stream>

/** A stream whose registration is logged (registration before writes), and the incarnation. */
async function registeredStream(prefix: string): Promise<S & { inc: number }> {
  const s = stream(prefix)
  await s.shard.configure(LOGGED)
  const { incarnation } = await s.shard.ensureStream(s.tenant)
  await s.ledger.drain()
  for (let i = 0; !(await s.shard.describe(s.tenant))?.registered; i++) {
    if (i > 500) throw new Error('not registered')
    await sleep(20)
  }
  return { ...s, inc: incarnation }
}
const flushFiles = (keys: string[]) => keys.filter((k) => /\/L0-/.test(k))
const outputs = (keys: string[]) => keys.filter((k) => !/\/L0-/.test(k))

describe('spec F16: an incarnation lost before its units were logged leaks no object', () => {
  it('sweep 1 keeps everything and asks the shard; after the fresh registration is logged, the flush files go, then the output', async () => {
    const s = await registeredStream('f16')
    const sent = new Sent()
    // append(b0) → seal(..1) → append(b1) → seal(..2)
    await append(s.shard, s.tenant, someSamples(s.tenant, T0, 24, 0), sent)
    await s.shard.seal(s.tenant)
    await append(s.shard, s.tenant, someSamples(s.tenant, T0 + 60_000, 24, 1), sent)
    await s.shard.seal(s.tenant)
    // list → read → put → addUnit, for both segments: admitted, NOT logged (the drain is held back).
    expect(await flushTenant(env, engine, s.tenant, s.shardName)).toMatchObject({ status: 'ok', awaitingLog: true })
    expect(await liveKeys(s.ledger)).toHaveLength(4)
    // compRead → SHARD-LOSS → LEDGER-LOSS + rebuild (both admissions rolled back) → compPut.
    const step = await compactStep(env, engine, s.tenant, {
      now: T0 + DAY_MS,
      policy: { minL0Files: 2 },
      hooks: { afterPlan: async () => { await loseStorage(s.shard); await loseStorage(s.ledger) } },
    })
    expect(step.status).toBe('conflict')
    const all = await dataKeys(s.tenant)
    expect([flushFiles(all).length, outputs(all).length]).toEqual([4, 2])
    expect(await liveKeys(s.ledger)).toEqual([])
    // The rebuilt ledger names the old incarnation (its registration was logged), at 0.
    expect(await s.ledger.loggedWatermarks()).toEqual([{ shard: s.shardName, incarnation: s.inc, seq: 0, loggedIncarnation: s.inc }])
    await evict(s.ledger)

    // Sweep 1: nothing can be deleted yet; the shard is asked about the stream.
    const one = await sweepOrphans(env, s.tenant, LATER)
    expect(one.deleted).toEqual([])
    expect(one.kept.map((k) => k.why).sort()).toEqual(['inputs_remain', 'inputs_remain', 'pending_unit', 'pending_unit', 'pending_unit', 'pending_unit'])
    expect(one.ensured).toEqual([{ shard: s.shardName, incarnation: expect.any(Number), registered: false }])
    const fresh = one.ensured[0]!.incarnation!
    expect(fresh).toBeGreaterThan(s.inc)
    await evict(s.shard)
    await evict(s.ledger)
    // While the fresh registration is only committed, the old files stay (F15).
    const between = await sweepOrphans(env, s.tenant, LATER)
    expect(between.deleted).toEqual([])
    // drainPUT: the fresh registration is logged.
    await s.ledger.drain()
    await evict(s.ledger)
    expect((await s.ledger.loggedWatermarks())[0]).toMatchObject({ incarnation: fresh, seq: 0, loggedIncarnation: fresh })
    const two = await sweepOrphans(env, s.tenant, LATER)
    expect(two.deleted.sort()).toEqual(flushFiles(all).sort())
    const three = await sweepOrphans(env, s.tenant, LATER)
    expect(three.deleted.sort()).toEqual(outputs(all).sort())
    expect(await dataKeys(s.tenant)).toEqual([])
  })
})

describe('spec F15, adapted: a newer incarnation that is only committed makes no file dead', () => {
  it('the sweep keeps the old incarnation\'s file; a rebuild rolls the newer registration back; the late unit lists the file, with its object', async () => {
    const s = await registeredStream('f15r2')
    const sent = new Sent()
    await append(s.shard, s.tenant, someSamples(s.tenant, T0, 24, 3), sent) // append(b0)
    await s.shard.seal(s.tenant) // seal(..1)
    let swept: Awaited<ReturnType<typeof sweepOrphans>> | undefined
    // list → read → put(1..1); SHARD-LOSS → register(inc 2) (committed); the sweep; LEDGER-LOSS +
    // rebuild; then the Worker's late addUnit(inc1 1..1).
    const r = await flushTenant(env, engine, s.tenant, s.shardName, {
      hooks: {
        afterPut: async () => {
          await loseStorage(s.shard)
          await s.shard.configure(LOGGED)
          const e = await s.shard.ensureStream(s.tenant) // what a write or a read does after a loss
          expect(e.incarnation).toBeGreaterThan(s.inc)
          expect((await s.ledger.loggedWatermarks())[0]).toMatchObject({ incarnation: e.incarnation, loggedIncarnation: s.inc })
          swept = await sweepOrphans(env, s.tenant, LATER)
          await loseStorage(s.ledger)
        },
      },
    })
    expect(swept!.deleted).toEqual([])
    expect(swept!.kept.map((k) => k.why)).toEqual(['pending_unit', 'pending_unit'])
    // The rebuilt ledger never saw incarnation 2, so it admitted the late unit of incarnation 1.
    expect(r.segments).toMatchObject([{ incarnation: s.inc, outcome: 'admitted' }])
    const live = await liveKeys(s.ledger)
    expect(live).toHaveLength(2)
    expect(await exists(live), 'every listed file has its object').toEqual([true, true])
    expect((await read(s.tenant, [])).canon).toEqual(sent.canon())
  })
})

describe('review m-6: release skew at the janitor', () => {
  async function leaked(prefix: string): Promise<S & { inc: number; files: string[] }> {
    const s = await registeredStream(prefix)
    await append(s.shard, s.tenant, someSamples(s.tenant, T0, 24, 5), new Sent())
    await s.shard.seal(s.tenant)
    await flushTenant(env, engine, s.tenant, s.shardName) // admitted, not logged
    await loseStorage(s.shard)
    await loseStorage(s.ledger) // the admission is rolled back; the files are orphans of a lost incarnation
    return { ...s, files: await dataKeys(s.tenant) }
  }

  it('a shard of the release before D61 has no ensureStream: the files are kept, the failure is reported, the sweep finishes', async () => {
    const s = await leaked('skew-shard')
    const oldShards = { idFromName: (n: string) => env.SHARD.idFromName(n), get: () => ({}) } as unknown as JanitorEnv['SHARD']
    const r = await sweepOrphans({ ...env, SHARD: oldShards } as JanitorEnv, s.tenant, LATER)
    expect(r.deleted).toEqual([])
    expect(r.kept.map((k) => k.why)).toEqual(['pending_unit', 'pending_unit'])
    expect(r.ensured).toEqual([{ shard: s.shardName, error: expect.stringMatching(/ensureStream/) }])
    expect(await dataKeys(s.tenant)).toEqual(s.files)
  })

  it('a ledger of the release before D61 sends no loggedIncarnation: D30\'s rule (a logged unit of the newer incarnation), so the files are kept, never deleted on a guess', async () => {
    const s = await leaked('skew-ledger')
    expect((await sweepOrphans(env, s.tenant, LATER)).ensured).toHaveLength(1) // the shard registers a fresh incarnation
    await s.ledger.drain()
    const strip = (ws: LoggedWatermark[]) => ws.map(({ loggedIncarnation: _, ...w }) => w)
    const oldLedgers = {
      idFromName: (n: string) => env.LEDGER.idFromName(n),
      get: (id: DurableObjectId) => {
        const real = env.LEDGER.get(id)
        return { orphanCheck: async (keys: string[]) => { const c = await real.orphanCheck(keys); return { ...c, logged: strip(c.logged) } } }
      },
    } as unknown as JanitorEnv['LEDGER']
    const r = await sweepOrphans({ ...env, LEDGER: oldLedgers } as JanitorEnv, s.tenant, LATER)
    expect(r.deleted).toEqual([])
    expect(await dataKeys(s.tenant)).toEqual(s.files)
    // With this release's ledger the same files are dead.
    expect((await sweepOrphans(env, s.tenant, LATER)).deleted.sort()).toEqual([...s.files].sort())
  })
})
