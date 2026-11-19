import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { PRECEDENCE_PER_VERSION, TENANT_ID, ledgerBaseKey, ledgerLogKey, type FileEntry, type FlushUnit, type LedgerChange, type Plan, type Table } from '../../contracts/ledger'
import type { Ledger, LedgerBase } from '../src/ledger'

type Stub = DurableObjectStub<Ledger>

let n = 0
const tenantName = () => `tenant-${n++}`
const open = (tenant = tenantName()): { tenant: string; l: Stub } => ({ tenant, l: env.LEDGER.get(env.LEDGER.idFromName(tenant)) })

const S = 'pool/0'
const INC = 7001
const DAY_MS = 86_400_000
const dayOf = (ts: number) => new Date(ts).toISOString().slice(0, 10)
const T0 = Date.UTC(2026, 10, 10)

const file = (key: string, over: Partial<FileEntry> = {}): FileEntry => {
  const minTs = over.minTs ?? T0
  return { table: 'metric_samples', day: dayOf(minTs), key, bytes: 100, rows: 10, minTs, maxTs: minTs + 999, level: 0, index: `idx:${key}`, ...over }
}
const unit = (seqLo: number, seqHi: number, files: FileEntry[], shard = S, incarnation = INC): FlushUnit => ({ shard, incarnation, seqLo, seqHi, files })
/** A unit with one samples file and one series file, the way a flush produces them. */
const pair = (seqLo: number, seqHi: number, ts = T0, shard = S, incarnation = INC): FlushUnit =>
  unit(seqLo, seqHi, [
    file(`samples-${shard}-${incarnation}-${seqLo}-${seqHi}`, { minTs: ts }),
    file(`series-${shard}-${incarnation}-${seqLo}-${seqHi}`, { minTs: ts, table: 'metric_series' }),
  ], shard, incarnation)

const everything = async (l: Stub, table: Table = 'metric_samples') => l.plan({ table, minTs: 0, maxTs: Number.MAX_SAFE_INTEGER })
const keys = (p: Plan) => p.files.map((f) => f.key)
const seqOf = async (l: Stub, shard = S) => (await everything(l)).watermarks.find((w) => w.shard === shard)?.seq
const loggedOf = async (l: Stub, shard = S) => (await l.loggedWatermarks()).find((w) => w.shard === shard)?.seq

const logPrefix = (tenant: string) => `${env.CELL}/ledger/tenant=${tenant}/`
/** Every change object in R2 for a tenant, in key order. */
const readLog = async (tenant: string): Promise<LedgerChange[]> => {
  const listed = await env.BUCKET.list({ prefix: logPrefix(tenant) })
  const out: LedgerChange[] = []
  for (const o of listed.objects) {
    if (o.key.endsWith('base.json')) continue
    const change = await (await env.BUCKET.get(o.key))!.json<LedgerChange>()
    expect(o.key).toBe(`${env.CELL}/${ledgerLogKey(tenant, change.ledgerIncarnation, change.version)}`)
    out.push(change)
  }
  return out
}

/** Make the ledger's R2 writes fail for keys the predicate selects. Lasts until eviction or `heal`. */
const breakR2 = (l: Stub, fails: (key: string) => boolean = () => true) =>
  runInDurableObject(l, (inst: Ledger) => {
    const real = env.BUCKET
    const broken = new Proxy(real, {
      get(target, prop) {
        if (prop === 'put') {
          return async (key: string, ...rest: unknown[]) => {
            if (fails(key)) throw new Error('injected R2 failure')
            return (target.put as (...a: unknown[]) => unknown)(key, ...rest)
          }
        }
        const v = Reflect.get(target, prop)
        return typeof v === 'function' ? v.bind(target) : v
      },
    })
    ;(inst as unknown as { bucket: R2Bucket }).bucket = broken
  })
const heal = (l: Stub) => runInDurableObject(l, (inst: Ledger) => { (inst as unknown as { bucket: R2Bucket }).bucket = env.BUCKET })
/**
 * The message a call fails with. Called inside the object: a rejection crossing the RPC
 * boundary is also reported by the test runner as unhandled.
 */
const failure = <R>(l: Stub, call: (inst: Ledger) => Promise<R>): Promise<string> =>
  runInDurableObject(l, (inst: Ledger) => call(inst).then(() => 'did not fail', (e: Error) => e.message))
const loseStorage = async (l: Stub) => {
  await runInDurableObject(l, async (_i, state) => { await state.storage.deleteAll() })
  await evictDurableObject(l)
}

describe('contiguity', () => {
  it('admits units that extend the watermark and refuses a gap or an overlap', async () => {
    const { l } = open()
    await l.registerStream({ shard: S, incarnation: INC })
    expect(await l.addUnit(pair(1, 10))).toMatchObject({ status: 'ok', watermark: 10 })
    expect(await l.addUnit(pair(11, 20))).toMatchObject({ status: 'ok', watermark: 20 })

    const before = await everything(l)
    expect(await l.addUnit(pair(22, 30))).toEqual({ status: 'not_contiguous', watermark: 20 }) // gap
    expect(await l.addUnit(pair(15, 30))).toEqual({ status: 'not_contiguous', watermark: 20 }) // overlap
    expect(await l.addUnit(pair(20, 30))).toEqual({ status: 'not_contiguous', watermark: 20 }) // off by one
    expect(await everything(l)).toEqual(before)
    expect(await l.addUnit(pair(21, 30))).toMatchObject({ status: 'ok', watermark: 30 })
  })

  it('answers a replayed unit with ok and changes nothing', async () => {
    const { tenant, l } = open()
    await l.registerStream({ shard: S, incarnation: INC })
    const first = await l.addUnit(pair(1, 10))
    await l.addUnit(pair(11, 20))
    const before = await everything(l)
    const log = await readLog(tenant)

    const again = await l.addUnit(pair(1, 10))
    expect(again).toEqual({ status: 'ok', version: before.version, watermark: 20 })
    expect(first.status === 'ok' && first.version).toBeLessThan(before.version)
    expect(await everything(l)).toEqual(before)
    expect(await readLog(tenant)).toEqual(log)
  })

  it('answers ok for any unit at or below the watermark and admits none of its files (replay rule)', async () => {
    const { tenant, l } = open()
    await l.registerStream({ shard: S, incarnation: INC })
    await l.addUnit(pair(1, 10))
    const before = await everything(l)
    const log = await readLog(tenant)
    // Same range, different bytes (so a different key): those rows are already recorded.
    expect(await l.addUnit(unit(1, 10, [file('other-attempt')]))).toEqual({ status: 'ok', version: before.version, watermark: 10 })
    // A sub-range of what is recorded.
    expect(await l.addUnit(unit(1, 5, [file('sub-range')]))).toEqual({ status: 'ok', version: before.version, watermark: 10 })
    // A unit that straddles the watermark is not a replay: part of it is new.
    expect(await l.addUnit(unit(5, 15, [file('straddle')]))).toEqual({ status: 'not_contiguous', watermark: 10 })
    expect(await everything(l)).toEqual(before)
    expect(await readLog(tenant)).toEqual(log)
  })

  it('answers a replay with ok after its files were compacted or expired away', async () => {
    const { l } = open()
    const u = pair(1, 10)
    await l.addUnit(u)
    await l.replace({ remove: [u.files[0]!.key], add: [file('L1', { level: 1 })] })
    await l.expire({ table: 'metric_series', beforeDay: '2999-01-01' })
    const before = await everything(l)
    expect(keys(before)).toEqual(['L1'])
    expect(await l.addUnit(u)).toEqual({ status: 'ok', version: before.version, watermark: 10 })
    expect(await everything(l)).toEqual(before) // the compacted-away inputs did not come back
  })

  it('keeps streams independent', async () => {
    const { l } = open()
    expect(await l.addUnit(pair(1, 5, T0, 'pool/1', 11))).toMatchObject({ status: 'ok', watermark: 5 })
    expect(await l.addUnit(pair(1, 9, T0, 'pool/2', 22))).toMatchObject({ status: 'ok', watermark: 9 })
    expect(await l.addUnit(pair(6, 12, T0, 'pool/2', 22))).toEqual({ status: 'not_contiguous', watermark: 9 })
    expect(await l.addUnit(pair(6, 12, T0, 'pool/1', 11))).toMatchObject({ status: 'ok', watermark: 12 })
    expect((await everything(l)).watermarks).toEqual([
      { shard: 'pool/1', incarnation: 11, seq: 12 },
      { shard: 'pool/2', incarnation: 22, seq: 9 },
    ])
  })
})

describe('atomicity of a unit', () => {
  it('admits nothing when one file key belongs to another unit', async () => {
    const { tenant, l } = open()
    await l.registerStream({ shard: S, incarnation: INC })
    await l.addUnit(unit(1, 10, [file('a'), file('b')]))
    const before = await everything(l)
    const log = await readLog(tenant)

    const refusal = await l.addUnit(unit(11, 20, [file('c'), file('d'), file('a'), file('e')]))
    expect(await everything(l)).toEqual(before) // not `c` and `d` without `e`
    expect(refusal).toEqual({ status: 'invalid', reason: 'file key already live in another unit: a' })
    expect(keys(await everything(l))).toEqual(['a', 'b'])
    expect(await readLog(tenant)).toEqual(log)
    expect(await l.outboxDepth()).toBe(0)
    // The stream was not advanced, so the corrected unit is still the next one.
    expect(await l.addUnit(unit(11, 20, [file('c'), file('d'), file('e')]))).toMatchObject({ status: 'ok', watermark: 20 })
  })

  it('admits nothing when one file is malformed or a key repeats inside the unit', async () => {
    const { l } = open()
    await l.registerStream({ shard: S, incarnation: INC })
    const before = await everything(l)
    const reason = async (u: FlushUnit) => {
      const r = await l.addUnit(u)
      return r.status === 'invalid' ? r.reason : `status ${r.status}`
    }
    expect(await reason(unit(1, 10, [file('a'), file('b', { table: 'nope' as Table })]))).toMatch(/unknown table/)
    expect(await reason(unit(1, 10, [file('a'), file('b', { day: '2026-1-1' })]))).toMatch(/bad day/)
    expect(await reason(unit(1, 10, [file('a'), file('b'), file('a')]))).toMatch(/duplicate file key/)
    expect(await reason(unit(1, 10, []))).toMatch(/at least one file/)
    expect(await reason(unit(0, 10, [file('a')]))).toMatch(/bad sequence range/)
    expect(await reason(unit(5, 4, [file('a')]))).toMatch(/bad sequence range/)
    expect(await reason(unit(1, 10, [file('a')], ''))).toMatch(/shard must be/)
    expect(await reason(unit(1, 10, [file('')]))).toMatch(/non-empty string/)
    expect(await everything(l)).toEqual(before)
    // An invalid unit is invalid even where a valid one would be a replay.
    const other = open().l
    await other.addUnit(pair(1, 10))
    const r = await other.addUnit(unit(1, 10, []))
    expect(r).toMatchObject({ status: 'invalid' })
    expect(await other.addUnit(unit(1, 10, [file('a'), file('a')]))).toMatchObject({ status: 'invalid' })
    expect((await everything(l, 'metric_series')).files).toEqual([])
  })

  it('makes all files of a unit visible in one version', async () => {
    const { l } = open()
    await l.registerStream({ shard: S, incarnation: INC })
    const v0 = (await everything(l)).version
    const r = await l.addUnit(pair(1, 10))
    expect(r).toMatchObject({ status: 'ok', version: v0 + 1 })
    expect((await everything(l)).files).toHaveLength(1)
    expect((await everything(l, 'metric_series')).files).toHaveLength(1)
  })
})

describe('stream incarnations', () => {
  it('registers idempotently', async () => {
    const { tenant, l } = open()
    const a = await l.registerStream({ shard: S, incarnation: INC })
    const b = await l.registerStream({ shard: S, incarnation: INC })
    expect(a.previousIncarnation).toBeNull()
    expect(b).toEqual(a)
    expect((await readLog(tenant)).map((c) => c.kind)).toEqual(['register_stream'])
  })

  it('auto-registers an unknown shard only on its first unit', async () => {
    const { tenant, l } = open()
    expect(await l.addUnit(pair(5, 9))).toEqual({ status: 'not_contiguous', watermark: 0 })
    expect((await everything(l)).watermarks).toEqual([])
    expect(await l.addUnit(pair(1, 4))).toMatchObject({ status: 'ok', watermark: 4 })
    expect((await everything(l)).watermarks).toEqual([{ shard: S, incarnation: INC, seq: 4 }])
    expect((await readLog(tenant)).map((c) => c.kind)).toEqual(['register_stream', 'add_unit'])
    // Once the shard is known, another incarnation cannot introduce itself with a unit.
    expect(await l.addUnit(pair(1, 4, T0, S, INC + 1))).toEqual({ status: 'incarnation_mismatch', incarnation: INC })
  })

  it('performs the storage-loss handshake', async () => {
    const { l } = open()
    await l.registerStream({ shard: S, incarnation: INC })
    await l.addUnit(pair(1, 10))
    await l.addUnit(pair(11, 20))
    expect(await loggedOf(l)).toBe(20)

    const NEW = INC + 5
    // A unit from the new incarnation before it has registered is refused.
    expect(await l.addUnit(pair(1, 3, T0, S, NEW))).toEqual({ status: 'incarnation_mismatch', incarnation: INC })

    const v = (await everything(l)).version
    const reg = await l.registerStream({ shard: S, incarnation: NEW })
    expect(reg).toEqual({ version: v + 1, previousIncarnation: INC })
    expect(await l.registerStream({ shard: S, incarnation: NEW })).toEqual(reg) // retry gets the same answer

    const p = await everything(l)
    expect(p.watermarks).toEqual([{ shard: S, incarnation: NEW, seq: 0 }])
    expect(await l.loggedWatermarks()).toEqual([{ shard: S, incarnation: NEW, seq: 0 }])
    expect(p.files).toHaveLength(2) // rows already in files stay visible

    // The old incarnation can no longer add, not even a replay; the new one starts at 1.
    expect(await l.addUnit(pair(21, 30))).toEqual({ status: 'incarnation_mismatch', incarnation: NEW })
    expect(await l.addUnit(pair(1, 10))).toEqual({ status: 'incarnation_mismatch', incarnation: NEW })
    expect(await l.addUnit(pair(2, 3, T0, S, NEW))).toEqual({ status: 'not_contiguous', watermark: 0 })
    expect(await l.addUnit(pair(1, 3, T0, S, NEW))).toMatchObject({ status: 'ok', watermark: 3 })
    expect((await everything(l)).files).toHaveLength(3)
  })
})

describe('plan', () => {
  it('returns only files of the table that overlap the inclusive range', async () => {
    const { l } = open()
    await l.registerStream({ shard: S, incarnation: INC })
    await l.addUnit(unit(1, 1, [
      file('s-early', { minTs: 1000, maxTs: 1999 }),
      file('s-mid', { minTs: 2000, maxTs: 2999 }),
      file('s-late', { minTs: 3000, maxTs: 3999 }),
      file('s-wide', { minTs: 500, maxTs: 9000 }),
      file('series-mid', { minTs: 2000, maxTs: 2999, table: 'metric_series' }),
    ]))
    const q = async (minTs: number, maxTs: number, table: Table = 'metric_samples') => keys(await l.plan({ table, minTs, maxTs }))
    expect(await q(2100, 2200)).toEqual(['s-mid', 's-wide'])
    expect(await q(1999, 2000)).toEqual(['s-early', 's-mid', 's-wide']) // both ends inclusive
    // In precedence order (the files' order in the unit here), not key order.
    expect(await q(2999, 3000)).toEqual(['s-mid', 's-late', 's-wide'])
    expect(await q(0, 499)).toEqual([])
    expect(await q(9001, 10_000)).toEqual([])
    expect(await q(0, 10_000)).toEqual(['s-early', 's-mid', 's-late', 's-wide'])
    expect(await q(0, 10_000, 'metric_series')).toEqual(['series-mid'])
  })

  it('returns entries exactly as they were admitted', async () => {
    const { l } = open()
    const f = file('exact', { bytes: 12345, rows: 678, level: 0, index: '{"rowGroups":[1,2,3]}' })
    const r = await l.addUnit(unit(1, 3, [f]))
    // Exactly as admitted, plus the precedence the ledger assigned (contracts/ledger.ts `LiveFile`).
    const p = (r as { version: number }).version * PRECEDENCE_PER_VERSION
    expect((await everything(l)).files).toEqual([{ ...f, precedence: p, precedenceLow: p }])
  })

  it('reads files, watermarks and version from one state while units are being added', async () => {
    const { l } = open()
    await l.registerStream({ shard: S, incarnation: INC })
    const v0 = (await everything(l)).version
    // Unit k covers sequence k and adds one samples file, so at any version the samples
    // file count, the watermark and the version must all agree.
    const work: Promise<unknown>[] = []
    const plans: Promise<Plan>[] = []
    for (let k = 1; k <= 25; k++) {
      work.push(l.addUnit(pair(k, k, T0 + k)))
      plans.push(everything(l))
      plans.push(everything(l))
    }
    await Promise.all(work)
    const seen = new Set<number>()
    for (const p of await Promise.all(plans)) {
      const seq = p.watermarks[0]!.seq
      expect(p.files).toHaveLength(seq)
      expect(p.version).toBe(v0 + seq)
      seen.add(seq)
    }
    expect(seen.size).toBeGreaterThan(1) // the plans really did interleave with the adds
    expect(await seqOf(l)).toBe(25)
  })
})

describe('replace', () => {
  it('swaps inputs for outputs when every input is live', async () => {
    const { tenant, l } = open()
    await l.addUnit(unit(1, 3, [file('a'), file('b'), file('c')]))
    const v = (await everything(l)).version
    const merged = file('L1-ab', { level: 1, rows: 20 })
    expect(await l.replace({ remove: ['a', 'b'], add: [merged] })).toEqual({ status: 'ok', version: v + 1 })
    expect(keys(await everything(l))).toEqual(['L1-ab', 'c'])
    expect(await seqOf(l)).toBe(3) // watermarks are untouched by compaction
    expect((await readLog(tenant)).at(-1)).toMatchObject({ kind: 'replace', removed: ['a', 'b'], added: [merged], version: v + 1 })
  })

  it('reports a conflict, listing the missing inputs, and changes nothing', async () => {
    const { tenant, l } = open()
    await l.addUnit(unit(1, 3, [file('a'), file('b'), file('c'), file('old', { minTs: T0 - 5 * DAY_MS })]))
    await l.expire({ table: 'metric_samples', beforeDay: dayOf(T0) }) // retention removes `old`
    const before = await everything(l)
    const log = await readLog(tenant)

    expect(await l.replace({ remove: ['a', 'old', 'never'], add: [file('L1-x', { level: 1 })] })).toEqual({ status: 'conflict', missing: ['old', 'never'] })
    expect(await everything(l)).toEqual(before) // `a` is still live, `L1-x` is not, version did not move
    expect(await readLog(tenant)).toEqual(log)
    expect(await l.outboxDepth()).toBe(0)
  })

  it('answers a retry of a completed swap with ok and no new version', async () => {
    const { l } = open()
    await l.addUnit(unit(1, 3, [file('a'), file('b')]))
    const req = { remove: ['a', 'b'], add: [file('L1-ab', { level: 1 })] }
    const first = await l.replace(req)
    expect(await l.replace(req)).toEqual(first)
    // Half of it is not a retry.
    expect(await l.replace({ remove: ['a'], add: [file('L1-other', { level: 1 })] })).toEqual({ status: 'conflict', missing: ['a'] })
    // Outputs live but one input live too: judged as a new request.
    await l.addUnit(unit(4, 5, [file('c')]))
    expect(await l.replace({ remove: ['a', 'c'], add: [file('L1-ab', { level: 1 })] })).toEqual({ status: 'conflict', missing: ['a'] })
    expect(await l.replace({ remove: ['c'], add: [file('L1-ab', { level: 1 })] })).toMatchObject({ status: 'invalid' })
    // A retried swap with no inputs (a pure add) is also recognised.
    const pure = { remove: [], add: [file('L1-pure', { level: 1 })] }
    const p1 = await l.replace(pure)
    expect(p1.status).toBe('ok')
    expect(await l.replace(pure)).toEqual(p1)
  })

  it('refuses an output whose key is already live', async () => {
    const { l } = open()
    await l.addUnit(unit(1, 3, [file('a'), file('b'), file('c')]))
    const before = await everything(l)
    expect(await l.replace({ remove: ['a'], add: [file('c')] })).toEqual({ status: 'invalid', reason: 'file key already live: c' })
    expect(await l.replace({ remove: ['a'], add: [file('a')] })).toMatchObject({ status: 'invalid', reason: 'key is in both remove and add: a' })
    expect(await l.replace({ remove: ['a'], add: [file('x'), file('x')] })).toMatchObject({ status: 'invalid' })
    expect(await l.replace({ remove: ['a'], add: [file('x', { day: 'nope' })] })).toMatchObject({ status: 'invalid' })
    expect(await l.replace({ remove: [''], add: [] })).toMatchObject({ status: 'invalid' })
    expect(await everything(l)).toEqual(before)
  })
})

describe('expire', () => {
  it('removes whole days of one table, strictly before the day given', async () => {
    const { tenant, l } = open()
    const d = (i: number) => T0 + i * DAY_MS
    await l.addUnit(unit(1, 9, [
      file('s-d0', { minTs: d(0) }), file('s-d1', { minTs: d(1) }), file('s-d1b', { minTs: d(1) + 5 }), file('s-d2', { minTs: d(2) }),
      file('series-d0', { minTs: d(0), table: 'metric_series' }),
    ]))
    const v = (await everything(l)).version
    const r = await l.expire({ table: 'metric_samples', beforeDay: dayOf(d(2)) })
    expect(r).toEqual({ version: v + 1, removed: ['s-d0', 's-d1', 's-d1b'] })
    expect(keys(await everything(l))).toEqual(['s-d2'])
    expect(keys(await everything(l, 'metric_series'))).toEqual(['series-d0']) // other table untouched
    expect(await seqOf(l)).toBe(9)
    expect((await readLog(tenant)).at(-1)).toMatchObject({ kind: 'expire', version: v + 1, removed: ['s-d0', 's-d1', 's-d1b'], added: [] })

    // Nothing to remove: no new version, nothing logged.
    expect(await l.expire({ table: 'metric_samples', beforeDay: dayOf(d(2)) })).toEqual({ version: v + 1, removed: [] })
    expect(await readLog(tenant)).toHaveLength(v + 1)
  })
})

describe('change log', () => {
  it('writes one change per version, in order, describing each mutation', async () => {
    const { tenant, l } = open()
    await l.registerStream({ shard: S, incarnation: INC })
    const u = pair(1, 10)
    await l.addUnit(u)
    await l.replace({ remove: [u.files[0]!.key], add: [file('L1', { level: 1 })] })
    await l.expire({ table: 'metric_series', beforeDay: '2999-01-01' })

    const log = await readLog(tenant)
    const inc = (await everything(l)).ledgerIncarnation
    expect(log.map((c) => [c.ledgerIncarnation, c.version, c.kind])).toEqual([
      [inc, 1, 'register_stream'], [inc, 2, 'add_unit'], [inc, 3, 'replace'], [inc, 4, 'expire'],
    ])
    expect(log[0]!.watermark).toEqual({ shard: S, incarnation: INC, seq: 0 })
    expect(log[1]).toMatchObject({ added: u.files, removed: [], watermark: { shard: S, incarnation: INC, seq: 10 }, unit: { seqLo: 1, seqHi: 10 } })
    expect(log[0]!.unit).toBeUndefined()
    expect(log[2]!.watermark).toBeUndefined()
    expect(log[3]!.removed).toEqual([u.files[1]!.key])
  })

  it('reports a watermark as logged only once its change is in R2', async () => {
    const { tenant, l } = open()
    await l.registerStream({ shard: S, incarnation: INC })
    await l.addUnit(pair(1, 10))
    expect(await loggedOf(l)).toBe(10)

    await breakR2(l)
    expect(await l.addUnit(pair(11, 20))).toMatchObject({ status: 'ok', watermark: 20 }) // commits regardless
    expect(await l.addUnit(pair(21, 30))).toMatchObject({ status: 'ok', watermark: 30 })
    expect(await seqOf(l)).toBe(30) // committed: queries see it
    expect(await loggedOf(l)).toBe(10) // not logged: shards must keep 11..30
    expect(await l.outboxDepth()).toBe(2)
    expect(await readLog(tenant)).toHaveLength(2)

    // The alarm retries while R2 is down and makes no progress, but keeps itself scheduled.
    expect(await runDurableObjectAlarm(l)).toBe(true)
    expect(await loggedOf(l)).toBe(10)
    expect(await l.outboxDepth()).toBe(2)

    await heal(l)
    expect(await runDurableObjectAlarm(l)).toBe(true)
    expect(await loggedOf(l)).toBe(30)
    expect(await l.outboxDepth()).toBe(0)
    expect((await readLog(tenant)).map((c) => c.version)).toEqual([1, 2, 3, 4])
    expect(await runDurableObjectAlarm(l)).toBe(false) // nothing pending, no alarm left behind
  })

  it('never writes a later change before an earlier one', async () => {
    const { tenant, l } = open()
    await l.registerStream({ shard: S, incarnation: INC }) // version 1
    const inc = (await everything(l)).ledgerIncarnation
    const stuck = `${env.CELL}/${ledgerLogKey(tenant, inc, 3)}`
    await breakR2(l, (key) => key === stuck)

    await l.addUnit(pair(1, 10)) // version 2: written
    await l.addUnit(pair(11, 20)) // version 3: fails
    await l.addUnit(pair(21, 30)) // version 4: must wait behind 3
    await l.addUnit(pair(31, 40)) // version 5
    expect((await readLog(tenant)).map((c) => c.version)).toEqual([1, 2])
    expect(await loggedOf(l)).toBe(10)
    expect(await seqOf(l)).toBe(40)

    await heal(l)
    expect(await l.drain()).toEqual({ written: 3 })
    expect((await readLog(tenant)).map((c) => c.version)).toEqual([1, 2, 3, 4, 5])
    expect(await loggedOf(l)).toBe(40)
  })

  it('drains idempotently: a change written twice is the same object', async () => {
    const { tenant, l } = open()
    await l.addUnit(pair(1, 10))
    const log = await readLog(tenant)
    // Put the last change back in the outbox, as if the delete after the write had been lost.
    await runInDurableObject(l, (_i, state) => {
      state.storage.sql.exec(`INSERT INTO outbox (version, body) VALUES (?, ?)`, 2, JSON.stringify(log[1]))
    })
    expect(await l.drain()).toEqual({ written: 1 })
    expect(await l.drain()).toEqual({ written: 0 })
    expect(await readLog(tenant)).toEqual(log)
    expect(await loggedOf(l)).toBe(10)
  })

  it('keeps each tenant\'s log under its own prefix', async () => {
    const a = open()
    const b = open()
    await a.l.addUnit(unit(1, 1, [file('a-only')]))
    await b.l.addUnit(unit(1, 2, [file('b-only')]))
    expect((await readLog(a.tenant)).flatMap((c) => c.added.map((f) => f.key))).toEqual(['a-only'])
    expect((await readLog(b.tenant)).flatMap((c) => c.added.map((f) => f.key))).toEqual(['b-only'])
    expect(keys(await everything(a.l))).toEqual(['a-only'])
  })
})

describe('eviction', () => {
  it('keeps files, watermarks, version and incarnation', async () => {
    const { l } = open()
    await l.registerStream({ shard: S, incarnation: INC })
    await l.addUnit(pair(1, 10))
    await l.addUnit(pair(1, 4, T0, 'pool/1', 99))
    await l.replace({ remove: [pair(1, 10).files[0]!.key], add: [file('L1', { level: 1 })] })
    const samples = await everything(l)
    const series = await everything(l, 'metric_series')
    const logged = await l.loggedWatermarks()

    await evictDurableObject(l)
    expect(await everything(l)).toEqual(samples)
    expect(await everything(l, 'metric_series')).toEqual(series)
    expect(await l.loggedWatermarks()).toEqual(logged)
    expect(await l.addUnit(pair(1, 10))).toMatchObject({ status: 'ok', watermark: 10 }) // a replay, though its samples file was compacted away
    expect(await l.addUnit(pair(1, 4, T0, 'pool/1', 99))).toMatchObject({ status: 'ok', watermark: 4 }) // replay still recognised
    expect(await l.addUnit(pair(11, 12))).toMatchObject({ status: 'ok', version: samples.version + 1 })
  })

  it('keeps unlogged changes in the outbox and logs them afterwards', async () => {
    const { tenant, l } = open()
    await l.registerStream({ shard: S, incarnation: INC })
    await breakR2(l)
    await l.addUnit(pair(1, 10))
    await l.addUnit(pair(11, 20))
    expect(await loggedOf(l)).toBe(0)

    await evictDurableObject(l) // the new instance has a working bucket again
    expect(await loggedOf(l)).toBe(0) // still not logged: nothing has drained yet
    expect(await seqOf(l)).toBe(20)
    expect(await l.outboxDepth()).toBe(2)
    expect(await runDurableObjectAlarm(l)).toBe(true)
    expect(await loggedOf(l)).toBe(20)
    expect((await readLog(tenant)).map((c) => c.version)).toEqual([1, 2, 3])
  })
})

describe('rebuild from the R2 log', () => {
  /** A history that uses every kind of change. Returns the state a rebuild must reproduce. */
  const history = async (l: Stub) => {
    await l.registerStream({ shard: S, incarnation: INC })
    await l.addUnit(pair(1, 10, T0 - 3 * DAY_MS))
    await l.addUnit(pair(11, 20, T0))
    // pool/1's unit is admitted between pool/0's two units; at another time, so that merging
    // those two does not jump over a file that could hold the same samples (`LiveFile`).
    await l.addUnit(pair(1, 7, T0 + 2000, 'pool/1', 42))
    await l.addUnit(pair(21, 30, T0 + 1))
    await l.replace({ remove: [pair(11, 20).files[0]!.key, pair(21, 30, T0 + 1).files[0]!.key], add: [file('L1-merged', { level: 1, rows: 20 })] })
    await l.expire({ table: 'metric_samples', beforeDay: dayOf(T0 - DAY_MS) })
    await l.registerStream({ shard: 'pool/1', incarnation: 43 }) // pool/1 lost its storage
    await l.addUnit(pair(1, 2, T0, 'pool/1', 43))
    return { samples: await everything(l), series: await everything(l, 'metric_series'), logged: await l.loggedWatermarks() }
  }

  it('reproduces the live set and the watermarks after storage loss', async () => {
    const { l } = open()
    const before = await history(l)
    expect(before.samples.files.length).toBeGreaterThan(1)

    await loseStorage(l)
    const samples = await everything(l)
    expect(samples.files).toEqual(before.samples.files)
    expect(samples.watermarks).toEqual(before.samples.watermarks)
    expect((await everything(l, 'metric_series')).files).toEqual(before.series.files)
    expect(await l.loggedWatermarks()).toEqual(before.logged)

    // The rebuilt ledger behaves like the old one: replays, contiguity, the handshake answer.
    expect(await l.addUnit(pair(1, 2, T0, 'pool/1', 43))).toMatchObject({ status: 'ok', watermark: 2 })
    expect(await l.addUnit(pair(32, 40))).toEqual({ status: 'not_contiguous', watermark: 30 })
    expect(await l.addUnit(pair(1, 7, T0, 'pool/1', 42))).toEqual({ status: 'incarnation_mismatch', incarnation: 43 })
    expect((await l.registerStream({ shard: 'pool/1', incarnation: 43 })).previousIncarnation).toBe(42)
    expect(await l.replace({ remove: [pair(11, 20).files[0]!.key], add: [file('x', { level: 1 })] })).toMatchObject({ status: 'conflict' })
    expect(await l.addUnit(pair(31, 40))).toMatchObject({ status: 'ok', watermark: 40 })
  })

  it('can be called explicitly on an emptied ledger, and refuses a ledger that is not empty', async () => {
    const { l } = open()
    const before = await history(l)
    expect(await failure(l, (i) => i.rebuildFromLog())).toMatch(/requires an empty ledger/)
    expect(await everything(l)).toEqual(before.samples)

    const result = await runInDurableObject(l, async (inst: Ledger, state) => {
      await state.storage.deleteAll()
      return inst.rebuildFromLog()
    })
    expect(result).toMatchObject({
      source: before.samples.ledgerIncarnation,
      ledgerIncarnation: before.samples.ledgerIncarnation + 1,
      version: before.samples.version,
      changesReplayed: before.samples.version,
      streams: 2,
    })
    const after = await everything(l)
    expect(after.files).toEqual(before.samples.files)
    expect(after.watermarks).toEqual(before.samples.watermarks)
  })

  it('never repeats a (ledger incarnation, version), and versions keep counting up', async () => {
    const { tenant, l } = open()
    const seen: string[] = []
    const note = async () => {
      const p = await everything(l)
      seen.push(`${p.ledgerIncarnation}/${p.version}`)
      return p
    }
    await l.registerStream({ shard: S, incarnation: INC })
    await note()
    for (let k = 1; k <= 3; k++) { await l.addUnit(pair(k, k)); await note() }
    const first = await note()

    await loseStorage(l)
    const second = await everything(l)
    expect(second.ledgerIncarnation).toBeGreaterThan(first.ledgerIncarnation)
    expect(second.version).toBe(first.version)
    for (let k = 4; k <= 6; k++) { await l.addUnit(pair(k, k)); await note() }

    await loseStorage(l) // a rebuilt ledger can itself be rebuilt
    const third = await everything(l)
    expect(third.ledgerIncarnation).toBeGreaterThan(second.ledgerIncarnation)
    expect(third.files).toHaveLength(6)
    expect(third.watermarks).toEqual([{ shard: S, incarnation: INC, seq: 6 }])
    await l.addUnit(pair(7, 7)); await note()

    expect(new Set(seen).size).toBe(seen.length - 1) // only the deliberate double read of `first` repeats
    const log = await readLog(tenant)
    const ids = log.map((c) => `${c.ledgerIncarnation}/${c.version}`)
    expect(new Set(ids).size).toBe(ids.length)
    // Across incarnations the logged versions form one sequence without a hole.
    expect(log.map((c) => c.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(new Set(log.map((c) => c.ledgerIncarnation)).size).toBe(3)
  })

  it('loses exactly the changes that were committed but not logged, under a new incarnation', async () => {
    const { tenant, l } = open()
    await l.registerStream({ shard: S, incarnation: INC })
    await l.addUnit(pair(1, 10))
    await breakR2(l)
    const lost = await l.addUnit(pair(11, 20))
    const before = await everything(l)
    expect(before.watermarks[0]!.seq).toBe(20)
    expect(await loggedOf(l)).toBe(10) // what a shard was allowed to discard

    await loseStorage(l)
    const after = await everything(l)
    expect(after.watermarks[0]!.seq).toBe(10) // back to the logged watermark, never below it
    expect(await loggedOf(l)).toBe(10)
    expect(keys(after)).toEqual([pair(1, 10).files[0]!.key])
    // The version number 3 will be used again, but under a different incarnation.
    expect(after.ledgerIncarnation).toBeGreaterThan(before.ledgerIncarnation)
    const again = await l.addUnit(pair(11, 20)) // the shard still holds 11..20 and re-sends
    expect(again).toMatchObject({ status: 'ok', watermark: 20 })
    expect(again.status === 'ok' && lost.status === 'ok' && again.version === lost.version).toBe(true)
    expect((await readLog(tenant)).map((c) => `${c.ledgerIncarnation - before.ledgerIncarnation}/${c.version}`)).toEqual(['0/1', '0/2', '1/3'])
  })

  it('records the state of each incarnation in base.json', async () => {
    const { tenant, l } = open()
    await l.addUnit(pair(1, 10))
    await loseStorage(l)
    const p = await everything(l)
    expect(`${logPrefix(tenant)}${p.ledgerIncarnation}/base.json`).toBe(`${env.CELL}/${ledgerBaseKey(tenant, p.ledgerIncarnation)}`)
    const base = await (await env.BUCKET.get(`${env.CELL}/${ledgerBaseKey(tenant, p.ledgerIncarnation)}`))!.json<LedgerBase>()
    // Exactly the contract's `base` LedgerChange: no other fields.
    expect(Object.keys(base).sort()).toEqual(['added', 'at', 'kind', 'ledgerIncarnation', 'removed', 'version', 'watermarks'])
    expect(base).toMatchObject({ ledgerIncarnation: p.ledgerIncarnation, version: 2, kind: 'base', removed: [] })
    const byKey = (a: FileEntry, b: FileEntry) => (a.key < b.key ? -1 : 1)
    const live = [...p.files, ...(await everything(l, 'metric_series')).files].sort(byKey)
    expect([...base.added].sort(byKey)).toEqual(live) // whole FileEntry objects, nothing more
    expect(base.watermarks).toEqual([{ shard: S, incarnation: INC, seq: 10 }])
    const first = await (await env.BUCKET.get(`${env.CELL}/${ledgerBaseKey(tenant, p.ledgerIncarnation - 1)}`))!.json<LedgerBase>()
    expect(first).toEqual({ ledgerIncarnation: p.ledgerIncarnation - 1, version: 0, at: first.at, kind: 'base', added: [], removed: [], watermarks: [] })
    // In an R2 listing the base comes AFTER the version objects (`b` sorts after digits).
    const listed = await env.BUCKET.list({ prefix: `${logPrefix(tenant)}${p.ledgerIncarnation - 1}/` })
    expect(listed.objects.map((o) => o.key.split('/').pop())).toEqual(['000000000001.json', '000000000002.json', 'base.json'])
  })

  it('fails rather than rebuild from a log with a hole', async () => {
    const { tenant, l } = open()
    await l.registerStream({ shard: S, incarnation: INC })
    for (let k = 1; k <= 4; k++) await l.addUnit(pair(k, k))
    const inc = (await everything(l)).ledgerIncarnation
    await env.BUCKET.delete(`${env.CELL}/${ledgerLogKey(tenant, inc, 3)}`)
    const outcome = await runInDurableObject(l, async (inst: Ledger, state) => {
      await state.storage.deleteAll()
      return inst.rebuildFromLog().then(() => 'rebuilt', (e: Error) => e.message)
    })
    expect(outcome).toMatch(/not contiguous at version 3/)
  })
})

describe('contracts v2', () => {
  it('writes a base change before anything else, for a brand-new tenant too', async () => {
    const { tenant, l } = open()
    const p = await everything(l) // first touch: no mutation yet
    const base = await (await env.BUCKET.get(`${env.CELL}/${ledgerBaseKey(tenant, p.ledgerIncarnation)}`))!.json<LedgerChange>()
    expect(base).toMatchObject({ kind: 'base', ledgerIncarnation: p.ledgerIncarnation, version: 0, added: [], removed: [], watermarks: [] })
    expect(await readLog(tenant)).toEqual([])
  })

  it('refuses a stream incarnation lower than the registered one, and keeps the watermark', async () => {
    const { tenant, l } = open()
    await l.registerStream({ shard: S, incarnation: INC })
    await l.addUnit(pair(1, 10))
    const before = await everything(l)
    const log = await readLog(tenant)
    expect(await failure(l, (i) => i.registerStream({ shard: S, incarnation: INC - 1 }))).toMatch(/refusing the lower/)
    expect(await l.addUnit(pair(1, 3, T0, S, INC - 1))).toEqual({ status: 'incarnation_mismatch', incarnation: INC })
    expect(await everything(l)).toEqual(before)
    expect(await readLog(tenant)).toEqual(log)
    // A higher one is still accepted.
    expect((await l.registerStream({ shard: S, incarnation: INC + 1 })).previousIncarnation).toBe(INC)
    expect(await failure(l, (i) => i.registerStream({ shard: S, incarnation: INC }))).toMatch(/refusing the lower/)
  })

  it('only serves tenant ids that match TENANT_ID', async () => {
    for (const ok of ['a', 'Tenant_1-x', 'x'.repeat(64)]) expect(TENANT_ID.test(ok)).toBe(true)
    for (const bad of ['a/1', 'a.b', 'a b', 'x'.repeat(65), 'é', 'a=b']) {
      expect(TENANT_ID.test(bad)).toBe(false)
      const stub = env.LEDGER.get(env.LEDGER.idFromName(bad))
      const outcome = await stub.plan({ table: 'metric_samples', minTs: 0, maxTs: 1 }).then(() => 'served', (e: Error) => e.message)
      expect(outcome).toMatch(/tenant id must match/)
    }
    // Nothing was written to R2 for any of them.
    for (const bad of ['a/1', 'a.b']) expect((await env.BUCKET.list({ prefix: `${env.CELL}/ledger/tenant=${bad}` })).objects).toEqual([])
  })

  it('exposes the admin surface: drain, outboxDepth, rebuildFromLog', async () => {
    const { l } = open()
    await l.registerStream({ shard: S, incarnation: INC })
    await breakR2(l)
    await l.addUnit(pair(1, 10))
    expect(await l.outboxDepth()).toBe(1)
    await heal(l)
    expect(await l.drain()).toEqual({ written: 1 })
    expect(await l.outboxDepth()).toBe(0)
    const p = await everything(l)
    const r = await runInDurableObject(l, async (inst: Ledger, state) => {
      await state.storage.deleteAll()
      return inst.rebuildFromLog()
    })
    expect(r).toMatchObject({ ledgerIncarnation: p.ledgerIncarnation + 1, version: p.version })
  })

  it('checks unit contiguity while replaying the log, from the range each change carries', async () => {
    const { tenant, l } = open()
    await l.registerStream({ shard: S, incarnation: INC })
    for (let k = 1; k <= 3; k++) await l.addUnit(pair(k, k))
    const inc = (await everything(l)).ledgerIncarnation
    const key = `${env.CELL}/${ledgerLogKey(tenant, inc, 3)}`
    const change = await (await env.BUCKET.get(key))!.json<LedgerChange>()
    expect(change.unit).toEqual({ seqLo: 2, seqHi: 2 })
    await env.BUCKET.put(key, JSON.stringify({ ...change, unit: { seqLo: 1, seqHi: 2 } }))
    const outcome = await runInDurableObject(l, async (inst: Ledger, state) => {
      await state.storage.deleteAll()
      return inst.rebuildFromLog().then(() => 'rebuilt', (e: Error) => e.message)
    })
    expect(outcome).toMatch(/unit range is not contiguous/)
  })

  it('lets a log reader that meets a new incarnation start again from its base', async () => {
    const { tenant, l } = open()
    await l.addUnit(pair(1, 10))
    await l.addUnit(pair(11, 20))
    await loseStorage(l)
    await l.addUnit(pair(21, 30))
    const p = await everything(l)
    // Read only the latest incarnation: base + its changes reproduce the live set and watermark.
    const base = await (await env.BUCKET.get(`${env.CELL}/${ledgerBaseKey(tenant, p.ledgerIncarnation)}`))!.json<LedgerChange>()
    const live = new Set(base.added.map((f) => f.key))
    let seq = base.watermarks!.find((w) => w.shard === S)!.seq
    for (const c of (await readLog(tenant)).filter((c) => c.ledgerIncarnation === p.ledgerIncarnation)) {
      for (const k of c.removed) live.delete(k)
      for (const f of c.added) live.add(f.key)
      if (c.kind === 'add_unit') {
        expect(c.unit!.seqLo).toBe(seq + 1)
        seq = c.unit!.seqHi
      }
    }
    expect([...live].sort()).toEqual([...keys(p), ...keys(await everything(l, 'metric_series'))].sort())
    expect(seq).toBe(30)
  })
})
