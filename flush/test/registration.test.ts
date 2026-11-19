/**
 * Registration before writes (D57; spec/README.md "Proposed fixes", R2): the model's traces
 * replayed against the write path (real shard, ledger, flush and engine) and a reader that
 * follows the query coordinator's protocol (test/coordinator.ts). Every test runs the shard in
 * registration mode `logged`; storage loss is `deleteAll` and eviction.
 *
 *   spec test 1  "spec R1": `R1_safety`'s 15 steps. With the drain held back, a new stream's
 *                append is refused and nothing is stored; once logged, the retry is accepted;
 *                then a ledger rebuild and a shard storage loss: the query's plan names the
 *                stream and the query never completes without b0
 *   spec test 2  "spec F6(b)": `F6b_impl_now` with the registration first (its R2 replay,
 *                results/REPLAY.md): the plan names the stream before its first unit is
 *                admitted; after the shard's storage loss the tail read is refused, never `ok`,
 *                empty; the re-planned attempt returns b0 from the file. The same steps with
 *                lazy registration (the release before D57) miss b0: the finding, reproduced
 *   spec test 3  "spec F6 liveness": `LIVE_R2_teeth_no_read_trigger`'s 6 steps: after a shard
 *                storage loss and no further write, the first attempt is refused, the shard
 *                holds a fresh incarnation the ledger has registered, the second completes
 *                (without b0 and b1: the declared loss)
 */
import { evictDurableObject, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { Plan } from '../../contracts/ledger'
import type { ShardConfig } from '../../shard/src/shard'
import { flushTenant } from '../src/flush'
import { engine } from '../src/index'
import { type Answer, Unavailable, query } from './coordinator'
import { Sent, T0, append, flushSettled, sha256Hex, someSamples, stream } from './helpers'
import { encodeBatch, bitsOf } from '../../engine/wasm/test/vzb1'

const LOGGED: Partial<ShardConfig> = { registration: 'logged', registerBackoffMs: 20, registerBackoffMaxMs: 200 }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
type S = ReturnType<typeof stream>

/** An append as `edge` would make it, its answer returned whatever it is; remembered in `sent` only if acknowledged. */
async function tryAppend(s: S, samples: ReturnType<typeof someSamples>, sent: Sent): Promise<string> {
  const series: Record<string, string>[] = []
  const index = new Map<string, number>()
  const rows = samples.map((x) => {
    const k = JSON.stringify(x.labels)
    let i = index.get(k)
    if (i === undefined) index.set(k, (i = series.push(x.labels) - 1))
    return { series: i, ts: x.ts, bits: bitsOf(x.value as number) }
  })
  const payload = encodeBatch(series, rows)
  const r = await s.shard.append({ tenant: s.tenant, epoch: 1, fingerprint: await sha256Hex(payload), payload, rows: rows.length })
  if (r.status === 'ok') for (const x of samples) sent.add(x.labels, x.ts, bitsOf(x.value as number))
  return r.status === 'backpressure' ? `backpressure:${r.scope}` : r.status
}

async function registered(s: S): Promise<number> {
  const until = Date.now() + 10_000
  for (;;) {
    const d = await s.shard.describe(s.tenant)
    if (d?.registered) return d.incarnation
    if (Date.now() > until) throw new Error(`not registered: ${JSON.stringify(d)}`)
    await sleep(20)
  }
}

const evict = (x: Parameters<typeof evictDurableObject>[0]) => evictDurableObject(x).catch((e: Error) => { if (!/not currently running/.test(e.message)) throw e })
const loseStorage = async (x: Parameters<typeof evictDurableObject>[0]) => {
  await runInDurableObject(x, async (_i, st) => { await st.storage.deleteAll() })
  await evict(x)
}
/** A query paused after its first plan until `release()`. */
function pausedQuery(s: S, pool: string[], check: (plan: Plan) => void) {
  let release!: () => void
  let planned!: () => void
  const gate = new Promise<void>((r) => { release = r })
  const hasPlan = new Promise<void>((r) => { planned = r })
  const answer: Promise<Answer> = query(env, engine, s.tenant, pool, {
    afterPlan: async (attempt, plan) => {
      if (attempt !== 1) return
      check(plan)
      planned()
      await gate
    },
  })
  return { answer, hasPlan, release }
}

describe('spec R1: a committed registration is not enough (R1_safety)', () => {
  it('nothing is acknowledged before the registration is logged; after a ledger rebuild and a shard storage loss the query still returns b0', async () => {
    const s = stream('r1')
    await s.shard.configure(LOGGED)
    const sent = new Sent()
    const b0 = someSamples(s.tenant, T0, 24, 0)
    // register(inc 1), its drain held back: the append is refused (R1 would acknowledge it here).
    expect(await tryAppend(s, b0, sent)).toBe('backpressure:registering')
    const { incarnation: inc } = await s.shard.ensureStream(s.tenant)
    expect(await tryAppend(s, b0, sent)).toBe('backpressure:registering')
    await evict(s.shard)
    await evict(s.ledger)
    expect(await runInDurableObject(s.shard, (_i, st) => st.storage.sql.exec(`SELECT COUNT(*) AS n FROM batch`).one().n)).toBe(0)
    // drainPUT → regLogged → append(b0): accepted.
    await s.ledger.drain()
    expect(await registered(s)).toBe(inc)
    expect(await tryAppend(s, b0, sent)).toBe('ok')
    await s.shard.seal(s.tenant) // seal(..1)
    // list → read → put(1..1); then LEDGER-LOSS + rebuild; then a query plans (before the unit).
    let q: ReturnType<typeof pausedQuery> | undefined
    const r = await flushTenant(env, engine, s.tenant, s.shardName, {
      hooks: {
        afterPut: async () => {
          await loseStorage(s.ledger)
          q = pausedQuery(s, [s.shardName], (plan) => {
            // The logged registration survived the rebuild: the plan names the stream.
            expect(plan.watermarks).toEqual([{ shard: s.shardName, incarnation: inc, seq: 0 }])
            expect(plan.files).toEqual([])
          })
          await q.hasPlan
        },
      },
    })
    // addUnit(inc1 1..1) is admitted; drainPUT; SHARD-LOSS; the query's tail reads now.
    expect(r).toMatchObject({ status: 'ok' })
    await s.ledger.drain()
    await loseStorage(s.shard)
    q!.release()
    const a = await q!.answer
    expect(a.canon).toEqual(sent.canon())
    expect(a.canon.length).toBeGreaterThan(0)
    expect(a.refusals[0]).toMatch(/newer stream than the ledger knows/)
  })
})

describe('spec F6(b): a stream with acknowledged rows is named by every plan', () => {
  async function trace(mode: 'logged' | 'lazy'): Promise<{ answer: Answer; sent: Sent; inc: number }> {
    const s = stream(`f6b-${mode}`)
    await s.shard.configure({ ...LOGGED, registration: mode })
    const sent = new Sent()
    const b0 = someSamples(s.tenant, T0, 24, 0)
    if (mode === 'logged') {
      // register → drainPUT → regLogged (the registration first, as R2 has it).
      expect(await tryAppend(s, b0, sent)).toBe('backpressure:registering')
      await s.shard.ensureStream(s.tenant)
      await s.ledger.drain()
      await registered(s)
    }
    expect(await tryAppend(s, b0, sent)).toBe('ok') // append(b0)
    await s.shard.seal(s.tenant) // seal(..1)
    const inc = (await s.shard.describe(s.tenant))!.incarnation
    await evict(s.shard)
    await evict(s.ledger)
    // The query plans before the stream's first unit is admitted.
    const q = pausedQuery(s, [s.shardName], (plan) => {
      expect(plan.files).toEqual([])
      expect(plan.watermarks).toEqual(mode === 'logged' ? [{ shard: s.shardName, incarnation: inc, seq: 0 }] : [])
    })
    await q.hasPlan
    // The unit is admitted and logged; the shard is told; then it loses its storage.
    expect(await flushSettled(env, engine, s.tenant, s.shardName)).toMatchObject({ status: 'ok', awaitingLog: false })
    await evict(s.ledger)
    await loseStorage(s.shard)
    q.release()
    return { answer: await q.answer, sent, inc }
  }

  it('registration first: the tail read is refused (never ok, empty) and the re-planned attempt returns b0 from the file', async () => {
    const { answer, sent, inc } = await trace('logged')
    expect(answer.canon).toEqual(sent.canon())
    expect(answer.attempts).toBe(2)
    expect(answer.refusals).toEqual([expect.stringMatching(/newer stream than the ledger knows/)])
    // The re-plan reads the fresh stream the shard started, from 0, newer than the lost one.
    expect(answer.asked[0]!.incarnation).toBeGreaterThan(inc)
  })

  it('the same steps with lazy registration (the release before D57) answer without b0: the finding, reproduced', async () => {
    const { answer, sent } = await trace('lazy')
    expect(sent.canon().length).toBeGreaterThan(0)
    expect(answer.canon).toEqual([])
    expect(answer.attempts).toBe(1)
  })
})

describe('spec F6 liveness: a query can finish after a shard storage loss with no further write (LIVE_R2)', () => {
  it('the first attempt is refused; the shard holds a fresh incarnation the ledger has registered; the second completes, without b0 and b1 (the declared loss)', async () => {
    const s = stream('live')
    await s.shard.configure(LOGGED)
    const sent = new Sent()
    // register(inc 1) → drainPUT(v1) → regLogged → append(b0) → append(b1) → SHARD-LOSS
    expect(await tryAppend(s, someSamples(s.tenant, T0, 8, 0), sent)).toBe('backpressure:registering')
    await s.shard.ensureStream(s.tenant)
    await s.ledger.drain()
    const inc = await registered(s)
    const lost = new Sent()
    expect(await tryAppend(s, someSamples(s.tenant, T0, 8, 0), lost)).toBe('ok')
    expect(await tryAppend(s, someSamples(s.tenant, T0 + 60_000, 8, 1), lost)).toBe('ok')
    await evict(s.ledger)
    await loseStorage(s.shard)
    await s.shard.configure(LOGGED)
    const a = await query(env, engine, s.tenant, [s.shardName])
    expect(a.attempts).toBe(2)
    expect(a.refusals).toEqual([expect.stringMatching(/newer stream than the ledger knows/)])
    expect(a.canon).toEqual([])
    const fresh = (await s.shard.describe(s.tenant))!.incarnation
    expect(fresh).toBeGreaterThan(inc)
    expect((await s.ledger.plan({ table: 'metric_samples', minTs: 1, maxTs: 0 })).watermarks).toEqual([{ shard: s.shardName, incarnation: fresh, seq: 0 }])
    // Every later query completes in one attempt.
    await evict(s.shard)
    await evict(s.ledger)
    expect(await query(env, engine, s.tenant, [s.shardName])).toMatchObject({ attempts: 1, canon: [] })
    // And the fresh stream takes writes once its registration is logged.
    await s.ledger.drain()
    expect(await registered(s)).toBe(fresh)
    expect(await tryAppend(s, someSamples(s.tenant, T0 + 120_000, 8, 2), sent)).toBe('ok')
    expect((await query(env, engine, s.tenant, [s.shardName])).canon).toEqual(sent.canon())
    void Unavailable
  })
})

void append
