/**
 * Registration before writes (D61; spec/README.md "Proposed fixes", R2, with the changes of
 * design/reviews/registration-before-writes.md), the shard's half, against the real ledger:
 *
 *   spec test 1 (R1_safety, shard half)   a new stream's appends are refused `registering`, with
 *                                          nothing stored, until the ledger's answer is LOGGED (a
 *                                          committed registration is not enough); evictions of both
 *                                          objects between every step
 *   review M-1                             refused at once, holding nothing; one tenant's slow
 *                                          ledger blocks no other tenant of the pooled shard; at
 *                                          most one call per stream at a time whatever senders do
 *   review M-2 (the shard's side)          the refusal is a retryable scope of its own, never one
 *                                          edge answers 429
 *   spec test 3 (LIVE_R2, shard half)      a tail read naming a lost stream starts and registers a
 *                                          fresh one and names it
 *   review m-1, m-5, m-7                   the alert, the cap on calls in flight, S5 healing
 *   skew and rollback                      a ledger of the release before D61 (no `logged`); the
 *                                          shard release before D61 on the same storage, and back
 */
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Ledger } from '../../ledger/src/ledger'
import { type AppendResult, SHARD_SCHEMA, type Shard, type ShardConfig } from '../src/shard'
import { Shard as ShardPrereg } from '../bench/prereg/shard'

type Stub = DurableObjectStub<Shard>
type LedgerStub = DurableObjectStub<Ledger>
let n = 0
const id = () => `${Date.now().toString(36)}-${n++}`
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** Registration mode `logged`, with a short backoff so a test need not wait long for one, unless it says otherwise. */
const LOGGED: Partial<ShardConfig> = { registration: 'logged', registerBackoffMs: 20, registerBackoffMaxMs: 200 }

async function setup(cfg: Partial<ShardConfig> = {}): Promise<{ s: Stub; name: string; tenant: string; l: LedgerStub }> {
  const name = `reg-${id()}/0`
  const tenant = `t-${id()}`
  const s = env.SHARD.get(env.SHARD.idFromName(name))
  await s.configure({ ...LOGGED, ...cfg })
  return { s, name, tenant, l: env.LEDGER.get(env.LEDGER.idFromName(tenant)) }
}
const put = (s: Stub, tenant: string, fp: string, bytes = 64): Promise<AppendResult> =>
  s.append({ tenant, epoch: 1, fingerprint: fp, payload: new Uint8Array(bytes).fill(fp.length), rows: 1 })
const stored = (s: Stub, tenant: string) => runInDurableObject(s, (_i: Shard, st) => st.storage.sql.exec(`SELECT seq, fingerprint FROM batch WHERE tenant = ? ORDER BY seq`, tenant).toArray())
const ledgerIncarnation = async (l: LedgerStub, shard: string) => (await l.plan({ table: 'metric_samples', minTs: 1, maxTs: 0 })).watermarks.find((w) => w.shard === shard)?.incarnation

/** Until the shard holds a confirmed registration for `tenant` (its alarm retries on its own), or fail. */
async function registered(s: Stub, tenant: string, within = 10_000): Promise<number> {
  const until = Date.now() + within
  for (;;) {
    const d = await s.describe(tenant)
    if (d?.registered) return d.incarnation
    if (Date.now() > until) throw new Error(`not registered within ${within} ms: ${JSON.stringify(d)} ${JSON.stringify(await s.stats())}`)
    await sleep(20)
  }
}

/** A ledger namespace that the shard instance uses instead of `env.LEDGER` (lost on eviction). */
function wrappedLedgers(wrap: (tenant: string, real: LedgerStub) => Partial<Pick<Ledger, 'registerStream' | 'loggedWatermarks'>>) {
  return {
    idFromName: (name: string) => env.LEDGER.idFromName(name),
    get: (lid: DurableObjectId) => {
      const real = env.LEDGER.get(lid)
      const w = wrap(lid.name!, real)
      return { registerStream: w.registerStream ?? ((ref) => real.registerStream(ref)), loggedWatermarks: w.loggedWatermarks ?? (() => real.loggedWatermarks()) }
    },
  }
}
const useLedgers = (s: Stub, ns: unknown) => runInDurableObject(s, (inst: Shard) => { (inst as unknown as { ledgerNs: unknown }).ledgerNs = ns })

afterEach(() => vi.restoreAllMocks())

describe('spec test 1 (R1_safety, the shard half): nothing is acknowledged before the registration is LOGGED', () => {
  it('refused `registering` with nothing stored while the ledger has only committed it; accepted once logged; both objects evicted between every step', async () => {
    const { s, name, tenant, l } = await setup()
    // An object not running (nothing woke it since the last eviction) has nothing to evict.
    const evict = (x: Stub | LedgerStub) => evictDurableObject(x).catch((e: Error) => { if (!/not currently running/.test(e.message)) throw e })
    const evictBoth = async () => {
      await evict(s)
      await evict(l)
    }
    // Step 1: the first append of a new stream. Refused at once; the registration starts.
    const first = await put(s, tenant, 'b0')
    expect(first).toMatchObject({ status: 'backpressure', scope: 'registering' })
    expect(await stored(s, tenant)).toEqual([])
    await evictBoth()
    // The ledger has (or will have) the registration committed, not logged.
    const inc = (await s.describe(tenant))!.incarnation
    expect(await s.ensureStream(tenant)).toEqual({ incarnation: inc, registered: false })
    expect(await ledgerIncarnation(l, name)).toBe(inc)
    expect(await l.registerStream({ shard: name, incarnation: inc })).toMatchObject({ logged: false })
    await evictBoth()
    // Step 2: R1 would acknowledge here (committed). R2 refuses, again with nothing stored.
    expect(await put(s, tenant, 'b0')).toMatchObject({ status: 'backpressure', scope: 'registering' })
    expect(await stored(s, tenant)).toEqual([])
    await evictBoth()
    // The ledger logs the registration; the shard learns it in the background (its alarm).
    await l.drain()
    await evictBoth()
    expect(await registered(s, tenant)).toBe(inc)
    await evictBoth()
    // Step 3: the retry is accepted, as seq 1 of the registered incarnation.
    expect(await put(s, tenant, 'b0')).toMatchObject({ status: 'ok', incarnation: inc, seq: 1, duplicate: false })
    await evictBoth()
    expect(await put(s, tenant, 'b0')).toMatchObject({ status: 'ok', seq: 1, duplicate: true })
    expect((await stored(s, tenant)).map((r) => r.fingerprint)).toEqual(['b0'])
    // And the ledger's plan names the stream: whatever the ledger loses now, it names it (the
    // registration is in R2), which is what a query needs (spec statement 1).
    await runInDurableObject(l, async (_i, st) => { await st.storage.deleteAll() })
    await evictDurableObject(l)
    expect(await ledgerIncarnation(l, name)).toBe(inc)
  })

  it('a ledger rebuild that rolls back a committed registration: the shard re-registers (still not logged), and accepts only once that is logged', async () => {
    const { s, name, tenant, l } = await setup()
    expect(await put(s, tenant, 'x')).toMatchObject({ scope: 'registering' })
    const { incarnation: inc } = await s.ensureStream(tenant)
    expect(await ledgerIncarnation(l, name)).toBe(inc)
    // LEDGER STORAGE LOSS before its drain: the rebuild has no trace of the stream.
    await runInDurableObject(l, async (_i, st) => { await st.storage.deleteAll() })
    await evictDurableObject(l)
    expect(await ledgerIncarnation(l, name)).toBeUndefined()
    // The shard keeps asking; the next answer registers it again (committed only): still refused.
    expect(await s.ensureStream(tenant)).toEqual({ incarnation: inc, registered: false })
    expect(await ledgerIncarnation(l, name)).toBe(inc)
    expect(await put(s, tenant, 'x')).toMatchObject({ scope: 'registering' })
    await l.drain()
    expect(await registered(s, tenant)).toBe(inc)
    expect(await put(s, tenant, 'x')).toMatchObject({ status: 'ok', incarnation: inc })
  })
})

describe('review M-1: the registration is off the append path', () => {
  it('a tenant whose ledger hangs is refused at once and holds nothing; another tenant of the same shard is not slowed; one call per stream at a time', async () => {
    const { s } = await setup({ registerTimeoutMs: 4_000 })
    const slow = `slow-${id()}`
    const fast = `fast-${id()}`
    // `fast` is registered before the slow ledger appears.
    expect(await put(s, fast, 'warm')).toMatchObject({ scope: 'registering' })
    await s.ensureStream(fast)
    await env.LEDGER.get(env.LEDGER.idFromName(fast)).drain()
    await registered(s, fast)
    let calls = 0
    let hanging = 0
    await useLedgers(s, wrappedLedgers((tenant, real) => (tenant === slow
      ? { registerStream: async (ref) => { calls++; hanging++; await sleep(3_000); hanging--; return real.registerStream(ref) } }
      : {})))
    const t0 = Date.now()
    const timed = async (tenant: string, fp: string) => {
      const t = Date.now()
      const r = await put(s, tenant, fp, 50_000)
      return { r, ms: Date.now() - t }
    }
    const [slowOnes, fastOnes] = await Promise.all([
      Promise.all(Array.from({ length: 40 }, (_, i) => timed(slow, `s${i}`))),
      (async () => { await sleep(50); return Promise.all(Array.from({ length: 40 }, (_, i) => timed(fast, `f${i}`))) })(),
    ])
    const elapsed = Date.now() - t0
    // Every append of the slow tenant: refused, without waiting for its ledger (3 s per call).
    for (const x of slowOnes) expect(x.r).toMatchObject({ status: 'backpressure', scope: 'registering' })
    expect(Math.max(...slowOnes.map((x) => x.ms))).toBeLessThan(1_500)
    // Every append of the other tenant: accepted, while the slow call is still hanging.
    for (const x of fastOnes) expect(x.r).toMatchObject({ status: 'ok' })
    expect(elapsed).toBeLessThan(2_500)
    expect(hanging).toBe(1)
    expect(calls).toBe(1) // single-flight: 40 appends, one call
    // Nothing of the refused appends is held: not in flight, not pending, not stored.
    const st = await s.stats()
    expect([st.inFlight, st.pendingBytes]).toEqual([0, 0])
    expect(st.refusedRegistering).toBeGreaterThanOrEqual(40)
    expect(await stored(s, slow)).toEqual([])
  })

  it('concurrent reads after a loss and concurrent ensureStream calls of one stream share one ledger call', async () => {
    const { s, tenant } = await setup({ registerTimeoutMs: 4_000 })
    let calls = 0
    await useLedgers(s, wrappedLedgers((_t, real) => ({ registerStream: async (ref) => { calls++; await sleep(300); return real.registerStream(ref) } })))
    const reads = await Promise.all(Array.from({ length: 5 }, () => s.tailRead(tenant, 42, 0)))
    expect(new Set(reads.map((r) => JSON.stringify(r))).size).toBe(1)
    expect(calls).toBe(1)
    const ensured = await Promise.all(Array.from({ length: 5 }, () => s.ensureStream(tenant)))
    expect(new Set(ensured.map((r) => r.incarnation)).size).toBe(1)
    expect(calls).toBe(2)
  })

  it('with the default backoff, a sender that hammers a new stream makes one or two ledger calls, not one per append', async () => {
    const { s, tenant } = await setup({ registerBackoffMs: 250, registerBackoffMaxMs: 30_000 })
    let calls = 0
    await useLedgers(s, wrappedLedgers((_t, real) => ({ registerStream: (ref) => { calls++; return real.registerStream(ref) } })))
    for (let i = 0; i < 100; i++) expect(await put(s, tenant, `h${i}`)).toMatchObject({ scope: 'registering' })
    expect(calls).toBeLessThanOrEqual(2)
  })
})

describe('review M-2 (the shard\'s side): the refusal is its own retryable scope', () => {
  it('`backpressure` with scope `registering` and a Retry-After between registerRetryAfterMs and twice it; never `tenant` or `shard` (which edge answers 429)', async () => {
    const { s, tenant } = await setup({ registerRetryAfterMs: 500 })
    for (let i = 0; i < 20; i++) {
      const r = await put(s, tenant, `r${i}`)
      expect(r.status).toBe('backpressure')
      const b = r as Extract<AppendResult, { status: 'backpressure' }>
      expect(b.scope).toBe('registering')
      expect(b.retryAfterMs).toBeGreaterThanOrEqual(500)
      expect(b.retryAfterMs).toBeLessThan(1000)
    }
  })
})

describe('spec test 3 (LIVE_R2, the shard half): a read naming a lost stream starts and registers a fresh one', () => {
  it('after a storage loss the shard answers `incarnation_mismatch` naming a fresh, newer stream that the ledger has registered; read from 0 it is empty; once logged it takes writes', async () => {
    const { s, name, tenant, l } = await setup()
    await put(s, tenant, 'b0')
    const { incarnation: old } = await s.ensureStream(tenant)
    await l.drain()
    await registered(s, tenant)
    expect(await put(s, tenant, 'b0')).toMatchObject({ status: 'ok', incarnation: old })
    expect(await put(s, tenant, 'b1')).toMatchObject({ status: 'ok', incarnation: old })
    // SHARD STORAGE LOSS; the tenant sends nothing more here.
    await runInDurableObject(s, async (_i, st) => { await st.storage.deleteAll() })
    await evictDurableObject(s)
    await s.configure(LOGGED)
    const r = await s.tailRead(tenant, old, 0)
    expect(r.status).toBe('incarnation_mismatch')
    const fresh = (r as { incarnation: number }).incarnation
    expect(fresh).toBeGreaterThan(old)
    // The registration was made before the answer: the next plan names the fresh stream.
    expect(await ledgerIncarnation(l, name)).toBe(fresh)
    // Concurrent reads are answered with the same fresh stream.
    expect(await Promise.all([s.tailRead(tenant, old, 0), s.tailRead(tenant, old, 0)])).toEqual([r, r])
    expect(await s.tailRead(tenant, fresh, 0)).toMatchObject({ status: 'ok', incarnation: fresh, batches: [] })
    await evictDurableObject(s)
    await l.drain()
    expect(await registered(s, tenant)).toBe(fresh)
    expect(await put(s, tenant, 'b2')).toMatchObject({ status: 'ok', incarnation: fresh, seq: 1 })
  })

  it('a fresh stream whose registration call was lost with the instance is registered by the alarm, from storage', async () => {
    const { s, tenant, l } = await setup()
    await useLedgers(s, wrappedLedgers(() => ({ registerStream: () => new Promise(() => {}) }))) // never answers
    expect(await put(s, tenant, 'x')).toMatchObject({ scope: 'registering' })
    await evictDurableObject(s) // the hanging call goes with the instance
    expect(await runInDurableObject(s, (_i, st) => st.storage.getAlarm())).not.toBeNull()
    await l.drain() // nothing to drain yet: the lost call never reached the ledger
    await runDurableObjectAlarm(s)
    await l.drain()
    expect(await registered(s, tenant)).toBeGreaterThan(0)
  })
})

describe('review m-1, m-5, m-7', () => {
  it('m-1: a registration the ledger cannot log is reported once it has waited registerAlertMs (stats and an error line)', async () => {
    const { s, tenant } = await setup({ registerAlertMs: 0 })
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await put(s, tenant, 'x')).toMatchObject({ scope: 'registering' })
    await s.ensureStream(tenant) // the ledger commits, never drains (its drain is test-driven here)
    await s.ensureStream(tenant)
    const st = await s.stats()
    expect(st.registering).toBe(1)
    expect(st.registeringForMs).toBeGreaterThanOrEqual(0)
    expect(errors.mock.calls.map((c) => String(c[0])).some((m) => m.includes(`the registration of ${tenant}'s stream`) && m.includes('its writes are refused until it is'))).toBe(true)
  })

  it('m-5: at most maxRegistrations calls in flight per shard, over all tenants', async () => {
    const { s } = await setup({ maxRegistrations: 2, registerTimeoutMs: 5_000 })
    let now = 0
    let most = 0
    await useLedgers(s, wrappedLedgers((_t, real) => ({ registerStream: async (ref) => { most = Math.max(most, ++now); await sleep(300); now--; return real.registerStream(ref) } })))
    const tenants = Array.from({ length: 6 }, (_, i) => `cap${i}-${id()}`)
    await Promise.all(tenants.map((t) => s.ensureStream(t)))
    expect(most).toBe(2)
  })

  it('m-7 (spec S5): a new stream below the ledger\'s incarnation (a clock stepped back) holds nothing, so it starts again above it and is registered', async () => {
    const { s, name, tenant, l } = await setup()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    // The ledger already has a newer incarnation of this stream than any the shard's clock can make now.
    const theirs = (Date.now() + 86_400_000) * 1024
    await l.registerStream({ shard: name, incarnation: theirs })
    expect(await put(s, tenant, 'x')).toMatchObject({ scope: 'registering' })
    const first = await s.ensureStream(tenant) // the registration was refused: renumbered
    const healed = (await s.describe(tenant))!.incarnation
    expect(healed).toBe(theirs + 1)
    expect(first.registered).toBe(false)
    await s.ensureStream(tenant)
    expect(await ledgerIncarnation(l, name)).toBe(theirs + 1)
    await l.drain()
    expect(await registered(s, tenant)).toBe(theirs + 1)
    expect(await put(s, tenant, 'x')).toMatchObject({ status: 'ok', incarnation: theirs + 1 })
    expect(errors.mock.calls.some((c) => String(c[0]).includes('spec S5'))).toBe(true)
  })

  it('m-7: a stream that holds acknowledged rows (from before D61) is never renumbered: the ledger keeps refusing it, as before', async () => {
    const { s, name, tenant, l } = await setup({ registration: 'lazy' })
    expect(await put(s, tenant, 'x')).toMatchObject({ status: 'ok' }) // lazy: rows, never registered
    const mine = (await s.describe(tenant))!.incarnation
    await l.registerStream({ shard: name, incarnation: mine + 1_000_000 })
    await s.configure({ registration: 'logged' })
    expect(await s.ensureStream(tenant)).toEqual({ incarnation: mine, registered: false })
    expect((await s.describe(tenant))!.incarnation).toBe(mine)
  })
})

describe('skew and rollback (contracts/COMPATIBILITY.md; shard/README.md "Rollout")', () => {
  it('a ledger of the release before D61 answers without `logged`: never taken as logged; once the ledger runs this release, the stream is accepted', async () => {
    const { s, name, tenant } = await setup()
    // The tenant's ledger runs the release before D61 (on its own namespace here).
    await useLedgers(s, env.LEDGER_PREREG)
    const old = env.LEDGER_PREREG.get(env.LEDGER_PREREG.idFromName(tenant))
    expect(await put(s, tenant, 'x')).toMatchObject({ scope: 'registering' })
    const inc = (await s.ensureStream(tenant)).incarnation
    await old.drain()
    expect(await old.registerStream({ shard: name, incarnation: inc })).toEqual({ version: expect.any(Number), previousIncarnation: null })
    expect(await s.ensureStream(tenant)).toEqual({ incarnation: inc, registered: false })
    expect(await put(s, tenant, 'x')).toMatchObject({ scope: 'registering' })
    // The ledger object takes this release's code (here: the shard's own namespace again).
    await evictDurableObject(s)
    await s.ensureStream(tenant)
    await env.LEDGER.get(env.LEDGER.idFromName(tenant)).drain()
    expect(await registered(s, tenant)).toBe(inc)
    expect(await put(s, tenant, 'x')).toMatchObject({ status: 'ok' })
  })

  it('rollback to the shard release before D61 on the same storage, and roll-forward: every stream accepts afterwards; a confirmed registration stays confirmed', async () => {
    const { s, tenant, l } = await setup()
    const t2 = `${tenant}-b`
    const t3 = `${tenant}-c`
    // This release: `tenant` registered and written; `t3` new, refused (registration pending).
    await put(s, tenant, 'a0')
    await s.ensureStream(tenant)
    await l.drain()
    await registered(s, tenant)
    expect(await put(s, tenant, 'a0')).toMatchObject({ status: 'ok' })
    expect(await put(s, t3, 'c0')).toMatchObject({ scope: 'registering' })
    // ROLLBACK: the release before D61 opens the same storage (schema 2 or later, compat 1: it may) and
    // takes writes lazily: into `tenant`, into a stream it creates for `t2`, and into `t3`'s
    // unregistered stream.
    await runInDurableObject(s, async (_i: Shard, st) => {
      const old = new ShardPrereg(st, {} as never)
      for (const [t, fp] of [[tenant, 'a1'], [t2, 'b0'], [t3, 'c0']] as const) {
        expect(await old.append({ tenant: t, epoch: 1, fingerprint: fp, payload: new Uint8Array(64).fill(fp.length), rows: 1 }), `${t} under N`).toMatchObject({ status: 'ok' })
      }
      // This release's schema, not lowered by the older code (since D72: 3).
      expect(st.storage.sql.exec(`SELECT version, compat FROM viz_schema`).one()).toMatchObject({ version: SHARD_SCHEMA.migrations.length, compat: 1 })
    })
    // ROLL FORWARD.
    await evictDurableObject(s)
    expect((await s.describe(tenant))!.registered).toBe(true) // N kept the row and its flag
    expect((await s.describe(t2))!.registered).toBe(false) // N's stream: never confirmed
    // Every stream accepts: `tenant` is confirmed; `t2` and `t3` hold acknowledged rows from N, so
    // refusing them would remove no exposure (they are confirmed in the background).
    expect(await put(s, tenant, 'a2')).toMatchObject({ status: 'ok' })
    expect(await put(s, t2, 'b1')).toMatchObject({ status: 'ok' })
    expect(await put(s, t3, 'c1')).toMatchObject({ status: 'ok' })
    // ...and are confirmed once their ledgers log the registrations.
    for (const t of [t2, t3]) {
      await s.ensureStream(t)
      await env.LEDGER.get(env.LEDGER.idFromName(t)).drain()
      await registered(s, t)
    }
  })

  it('without a LEDGER binding: lazy whatever the mode, and a read naming a lost stream is answered 0, as before D61', async () => {
    const { s, tenant } = await setup()
    await useLedgers(s, undefined)
    expect(await s.tailRead(tenant, 5, 0)).toEqual({ status: 'incarnation_mismatch', incarnation: 0 })
    expect(await s.ensureStream(tenant)).toEqual({ incarnation: 0, registered: false })
  })
})
