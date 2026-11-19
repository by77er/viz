/**
 * Registration before writes (D57; spec/README.md "Proposed fixes", R2), the ledger's half:
 * `registerStream` answers whether the registration is LOGGED, and `loggedWatermarks` /
 * `orphanCheck` report each stream's logged incarnation, both derived from the outbox at call
 * time and never stored (design/reviews/registration-before-writes.md B-1).
 *
 *   spec test 4   `logged` is false until the segment holding the registration is written, then
 *                 true; `loggedIncarnation` moves only there, never at the commit; after a
 *                 rebuild it equals the incarnation; every answer survives eviction
 *   review B-1    a rollback to the release before D57 and a roll-forward, on the same storage:
 *                 what that release committed and drained answers `logged: true`, so no stream
 *                 is refused for ever
 */
import { evictDurableObject, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { Ledger } from '../src/ledger'
import { Ledger as LedgerPrereg } from '../bench/prereg/ledger'
import { INC, S, T0, breakR2, everything, heal, loseStorage, open, pair, type Stub } from './helpers'

const S2 = 'pool/1'
const S3 = 'pool/2'
const logged = async (l: Stub, shard = S) => (await l.loggedWatermarks()).find((w) => w.shard === shard)

/** Run the release before D57 on this object's storage, as a rollback would, and hand it to `body`. */
async function asPrevious<R>(l: Stub, body: (old: LedgerPrereg) => Promise<R>): Promise<R> {
  await everything(l) // the object has started; the old code then opens the same storage
  return runInDurableObject(l, async (_i: Ledger, state) => {
    const old = new LedgerPrereg(state, env as never)
    // Its constructor opened the storage under `blockConcurrencyWhile`; let that finish.
    await state.blockConcurrencyWhile(async () => {})
    return body(old)
  })
}

describe('spec test 4: `logged` and `loggedIncarnation` move only when the registration is logged', () => {
  it('false at the commit, still false while the segment cannot be written or its answer is lost, true once written; the same after every eviction', async () => {
    const { l } = open()
    const r = await l.registerStream({ shard: S, incarnation: INC })
    expect(r).toMatchObject({ previousIncarnation: null, logged: false })
    await evictDurableObject(l)
    expect(await l.registerStream({ shard: S, incarnation: INC })).toMatchObject({ logged: false })
    expect(await logged(l)).toEqual({ shard: S, incarnation: INC, seq: 0, loggedIncarnation: 0 })
    // The segment's PUT fails: nothing is logged.
    await breakR2(l)
    await l.drain().catch(() => undefined)
    expect(await l.registerStream({ shard: S, incarnation: INC })).toMatchObject({ logged: false })
    expect((await l.logStatus()).registrationsPending).toBe(1)
    // The PUT happens but its answer is lost: the segment is in R2, its rows are still in the
    // outbox. Still false (the ledger does not know yet; low is the safe side).
    await breakR2(l, () => true, 'after')
    await l.drain().catch(() => undefined)
    expect(await l.registerStream({ shard: S, incarnation: INC })).toMatchObject({ logged: false })
    await evictDurableObject(l)
    expect(await l.registerStream({ shard: S, incarnation: INC })).toMatchObject({ logged: false })
    expect((await logged(l))!.loggedIncarnation).toBe(0)
    // The retry writes exactly that segment and then removes its rows: logged.
    await heal(l)
    await l.drain()
    expect(await l.registerStream({ shard: S, incarnation: INC })).toMatchObject({ logged: true })
    expect(await logged(l)).toEqual({ shard: S, incarnation: INC, seq: 0, loggedIncarnation: INC })
    expect((await l.logStatus()).registrationsPending).toBe(0)
    await evictDurableObject(l)
    expect(await l.registerStream({ shard: S, incarnation: INC })).toMatchObject({ logged: true })
  })

  it('a new incarnation: the logged prefix names the previous one until the new registration is logged; two pending at once report 0; a unit of the new one is not needed to prove it', async () => {
    const { l } = open()
    await l.registerStream({ shard: S, incarnation: INC })
    await l.addUnit(pair(1, 4))
    await l.drain()
    expect(await logged(l)).toEqual({ shard: S, incarnation: INC, seq: 4, loggedIncarnation: INC })
    const NEW = INC + 10
    expect(await l.registerStream({ shard: S, incarnation: NEW })).toMatchObject({ previousIncarnation: INC, logged: false })
    expect(await logged(l)).toEqual({ shard: S, incarnation: NEW, seq: 0, loggedIncarnation: INC })
    expect((await l.orphanCheck([])).logged).toEqual([{ shard: S, incarnation: NEW, seq: 0, loggedIncarnation: INC }])
    // A second new incarnation before the first is logged: the ledger cannot tell which older
    // one the logged prefix names, so it says 0 (only ever too low).
    const NEWER = INC + 20
    await l.registerStream({ shard: S, incarnation: NEWER })
    expect(await logged(l)).toEqual({ shard: S, incarnation: NEWER, seq: 0, loggedIncarnation: 0 })
    await evictDurableObject(l)
    expect((await logged(l))!.loggedIncarnation).toBe(0)
    await l.drain()
    // Logged with no unit of it at all (D30's rule needed a logged unit: spec F16).
    expect(await logged(l)).toEqual({ shard: S, incarnation: NEWER, seq: 0, loggedIncarnation: NEWER })
    expect(await l.registerStream({ shard: S, incarnation: NEWER })).toMatchObject({ logged: true })
    // Lower incarnations are still refused for good.
    expect(await l.registerStream({ shard: S, incarnation: NEW }).then(() => 'registered', (e: Error) => e.message)).toMatch(/refusing the lower/)
  })

  it('the lazy path (a first unit registers its stream) is the same: logged once drained', async () => {
    const { l } = open()
    expect(await l.addUnit(pair(1, 1, T0, S2, 9))).toMatchObject({ status: 'ok' })
    expect(await l.registerStream({ shard: S2, incarnation: 9 })).toMatchObject({ logged: false })
    expect(await logged(l, S2)).toEqual({ shard: S2, incarnation: 9, seq: 0, loggedIncarnation: 0 })
    await l.drain()
    expect(await l.registerStream({ shard: S2, incarnation: 9 })).toMatchObject({ logged: true })
    expect(await logged(l, S2)).toEqual({ shard: S2, incarnation: 9, seq: 1, loggedIncarnation: 9 })
  })

  it('a rebuild: a registration that was only committed is gone (the stream reads as the log has it); every stream left is logged', async () => {
    const { l } = open()
    await l.registerStream({ shard: S, incarnation: INC })
    await l.addUnit(pair(1, 2))
    await l.drain()
    await l.registerStream({ shard: S, incarnation: INC + 1 }) // committed only
    await l.registerStream({ shard: S2, incarnation: 5 }) // committed only
    await loseStorage(l)
    const ws = await l.loggedWatermarks()
    expect(ws).toEqual([{ shard: S, incarnation: INC, seq: 2, loggedIncarnation: INC }])
    expect(await l.registerStream({ shard: S, incarnation: INC })).toMatchObject({ logged: true })
    // Registering again after the rebuild is a new registration, not logged until drained.
    expect(await l.registerStream({ shard: S2, incarnation: 5 })).toMatchObject({ previousIncarnation: null, logged: false })
  })
})

describe('review B-1: rollback to the release before D57 and roll-forward, on the same storage', () => {
  it('streams that release registered (by registerStream, by a first unit, by a rebuild) answer logged once it drained: none is refused for ever', async () => {
    const { tenant, l } = open()
    // Release N+1 (this one) runs: a stream registered and logged.
    await l.registerStream({ shard: S, incarnation: INC })
    await l.drain()
    expect(await l.registerStream({ shard: S, incarnation: INC })).toMatchObject({ logged: true })
    // Rollback to N on the same storage. N takes a new stream lazily (its first unit registers
    // it), registers another, re-registers S after a shard storage loss, and drains: N's drain
    // knows nothing of D57.
    await asPrevious(l, async (old) => {
      expect(await old.addUnit(pair(1, 3, T0, S2, 77))).toMatchObject({ status: 'ok' })
      expect(await old.registerStream({ shard: S3, incarnation: 88 })).toEqual({ version: expect.any(Number), previousIncarnation: null }) // no `logged`: N
      await old.registerStream({ shard: S, incarnation: INC + 1 })
      await old.drain()
    })
    // Roll forward.
    await evictDurableObject(l)
    for (const [shard, inc] of [[S2, 77], [S3, 88], [S, INC + 1]] as const) {
      expect(await l.registerStream({ shard, incarnation: inc }), `${shard} ${inc}`).toMatchObject({ logged: true })
    }
    expect(await l.loggedWatermarks()).toEqual([
      { shard: S, incarnation: INC + 1, seq: 0, loggedIncarnation: INC + 1 },
      { shard: S2, incarnation: 77, seq: 3, loggedIncarnation: 77 },
      { shard: S3, incarnation: 88, seq: 0, loggedIncarnation: 88 },
    ])
    // N also committed one it did not drain before the roll-forward: pending, then logged by
    // THIS release's drain.
    await asPrevious(l, async (old) => void (await old.registerStream({ shard: 'pool/3', incarnation: 99 })))
    await evictDurableObject(l)
    expect(await l.registerStream({ shard: 'pool/3', incarnation: 99 })).toMatchObject({ logged: false })
    await l.drain()
    expect(await l.registerStream({ shard: 'pool/3', incarnation: 99 })).toMatchObject({ logged: true })
    // N rebuilds the ledger during the rollback (storage loss): every stream it inserts is logged.
    // (This release's instance, which the runtime constructs too, is kept from starting.)
    await runInDurableObject(l, async (_i, state) => { await state.storage.deleteAll() })
    await evictDurableObject(l)
    const proto = Ledger.prototype as unknown as { startIncarnation: () => Promise<unknown> }
    const start = proto.startIncarnation
    proto.startIncarnation = () => new Promise(() => {})
    try {
      await runInDurableObject(l, async (_i: Ledger, state) => {
        const old = new LedgerPrereg(state, env as never)
        await state.blockConcurrencyWhile(async () => {})
        expect(await old.loggedWatermarks()).toHaveLength(4) // N's rebuild from the log
      })
    } finally {
      proto.startIncarnation = start
    }
    await evictDurableObject(l)
    for (const [shard, inc] of [[S2, 77], [S3, 88], [S, INC + 1], ['pool/3', 99]] as const) {
      expect(await l.registerStream({ shard, incarnation: inc }), `after N's rebuild: ${shard}`).toMatchObject({ logged: true })
    }
    void tenant
  })
})
