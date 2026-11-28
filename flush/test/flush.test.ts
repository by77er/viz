import { evictDurableObject, runInDurableObject } from 'cloudflare:test'
import { env, exports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { LedgerChange } from '../../contracts/ledger'
import type { Segment } from '../../shard/src/shard'
import { STALE_NAN } from '../../engine/wasm/test/vzb1'
import { type FlushOptions, type FlushResult, dataFileKey, engine, flushTenant } from '../src/index'
import {
  DAY_MS, Sent, T0, append, breakLedgerLog, dataKeys, discardRecorded, flushSettled, healLedgerLog, ledgerStub, listKeys, liveKeys, loggedChanges, loseLedgerStorage, read, sha256Hex,
  shardStub, someSamples, stream,
} from './helpers'
import { StaleTail } from './read'

const flush = (tenant: string, shardName: string, opts?: FlushOptions): Promise<FlushResult> => flushTenant(env, engine, tenant, shardName, opts)
/**
 * Flush until the shard has been told what the ledger LOGGED: one run, then the ledger's drain
 * (its alarm, run here at once) and further runs. Segments as the run that first handled them
 * saw them. The ledger drains only when asked in this suite (vitest.config.ts).
 */
const settled = (tenant: string, shardName: string, opts?: FlushOptions): Promise<FlushResult> => flushSettled(env, engine, tenant, shardName, opts)
const dayOf = (ts: number) => new Date(ts).toISOString().slice(0, 10)

/** The key contracts/TABLES.md prescribes, built here from the object's own bytes. */
async function expectedKey(key: string, tenant: string, shardName: string, seg: { incarnation: number; seqLo: number; seqHi: number }): Promise<string> {
  const o = await env.BUCKET.get(key)
  const bytes = new Uint8Array(await o!.arrayBuffer())
  const table = key.includes('/metric_samples/') ? 'metric_samples' : 'metric_series'
  const day = /\/day=(\d{4}-\d{2}-\d{2})\//.exec(key)![1]!
  const hash8 = (await sha256Hex(bytes)).slice(0, 8)
  return `${env.CELL}/data/${table}/tenant=${tenant}/day=${day}/L0-${shardName.replaceAll('/', '_')}-${seg.incarnation}-${seg.seqLo}-${seg.seqHi}-${hash8}.parquet`
}

/** Every add_unit change in the tenant's ledger log in R2 (what is logged, not what is committed). */
const loggedUnits = async (tenant: string): Promise<LedgerChange[]> => (await loggedChanges(tenant)).filter((c) => c.kind === 'add_unit')

const versions = async (keys: string[]) => Promise.all(keys.map(async (k) => (await env.BUCKET.head(k))!.version))

describe('object keys', () => {
  it('builds the key of contracts/TABLES.md exactly', () => {
    const sha256Hex = 'ab12cd34' + '0'.repeat(56)
    expect(dataFileKey({ cell: 'cell-0', table: 'metric_samples', tenant: 'acme', day: '2026-11-18', level: 0, shard: 'shared/c1/3', incarnation: 1843000000000123, seqLo: 7, seqHi: 12, sha256Hex })).toBe(
      'cell-0/data/metric_samples/tenant=acme/day=2026-11-18/L0-shared_c1_3-1843000000000123-7-12-ab12cd34.parquet',
    )
    const ok = { cell: 'c', table: 'metric_series' as const, tenant: 'a', day: '2026-11-18', level: 0, shard: 's', incarnation: 1, seqLo: 1, seqHi: 1, sha256Hex }
    expect(dataFileKey(ok)).toBe('c/data/metric_series/tenant=a/day=2026-11-18/L0-s-1-1-1-ab12cd34.parquet')
    for (const bad of [{ tenant: 'a/b' }, { tenant: '' }, { day: '+10000-01-01' }, { day: '2026-1-1' }, { sha256Hex: 'AB' }, { seqLo: 0 }, { seqLo: 2 }, { incarnation: 1.5 }, { cell: 'a/b' }, { shard: '' }]) {
      expect(() => dataFileKey({ ...ok, ...bad })).toThrow()
    }
  })
})

describe('flushing sealed segments', () => {
  it('turns each sealed segment into one unit of Parquet files under the right keys, then records it in the shard', async () => {
    const { tenant, shardName, shard, ledger } = stream()
    const sent = new Sent()
    // Segment 1: two batches in one UTC day, with a staleness marker and an in-batch duplicate.
    await append(shard, tenant, someSamples(tenant, T0, 40, 1), sent)
    await append(shard, tenant, [
      { labels: { __name__: 'up', job: 'api', instance: 'i-0', tenant_marker: tenant }, ts: T0, value: STALE_NAN }, // overrides batch 1
      { labels: { __name__: 'up', job: 'api', instance: 'i-0', tenant_marker: tenant }, ts: T0 + 1, value: 5 },
      { labels: { __name__: 'up', job: 'api', instance: 'i-0', tenant_marker: tenant }, ts: T0 + 1, value: 6 }, // later row wins
    ], sent)
    const seg1 = (await shard.seal(tenant))!
    // Segment 2: one batch that crosses midnight, so it yields files for two days.
    await append(shard, tenant, someSamples(tenant, T0 + DAY_MS / 2 - 60_000, 40, 2), sent)
    const seg2 = (await shard.seal(tenant))!
    // A third batch stays unsealed: it is tail, and flush must not touch it.
    await append(shard, tenant, someSamples(tenant, T0 + 3_600_000, 8, 3), sent)
    expect([seg1.seqLo, seg1.seqHi, seg2.seqLo, seg2.seqHi]).toEqual([1, 2, 3, 3])

    const before = await read(tenant, [shardName])
    expect(before.canon).toEqual(sent.canon())
    expect([before.sampleFiles.length, before.tailBatches]).toEqual([0, 4]) // all tail

    // One run admits both units. The ledger writes its change log in the background, so the
    // shard is told nothing yet (it may discard only what the log holds) and the run says so.
    const r = await flush(tenant, shardName)
    expect(r).toMatchObject({ status: 'ok', tenant, shard: shardName, loggedThrough: 0, recordedThrough: 0, awaitingLog: true, remaining: 0, changed: true })
    expect(r.segments.map((s) => [s.seqLo, s.seqHi, s.outcome, s.files.map((f) => `${f.table}@${f.day}:${f.put}`)])).toEqual([
      [1, 2, 'admitted', [`metric_samples@${dayOf(T0)}:created`, `metric_series@${dayOf(T0)}:created`]],
      [3, 3, 'admitted', [
        `metric_samples@${dayOf(T0)}:created`, `metric_series@${dayOf(T0)}:created`,
        `metric_samples@${dayOf(T0 + DAY_MS)}:created`, `metric_series@${dayOf(T0 + DAY_MS)}:created`,
      ]],
    ])

    // Objects: exactly the reported ones, under contract keys derived from their own bytes.
    const reported = r.segments.flatMap((s) => s.files.map((f) => f.key)).sort()
    expect(await dataKeys(tenant)).toEqual(reported)
    for (const s of r.segments) {
      for (const f of s.files) {
        expect(f.key).toBe(await expectedKey(f.key, tenant, shardName, s))
        const head = (await env.BUCKET.head(f.key))!
        expect(head.size).toBe(f.bytes)
        expect(head.httpMetadata?.contentType).toBe('application/vnd.apache.parquet')
      }
    }
    // Ledger: lists exactly those files; every samples file has its series file (same day, same unit).
    expect(await liveKeys(ledger)).toEqual(reported)
    const samplesPlan = await ledger.plan({ table: 'metric_samples', minTs: 0, maxTs: Number.MAX_SAFE_INTEGER })
    const seriesPlan = await ledger.plan({ table: 'metric_series', minTs: 0, maxTs: Number.MAX_SAFE_INTEGER })
    expect(samplesPlan.watermarks).toEqual([{ shard: shardName, incarnation: seg1.incarnation, seq: 3 }])
    expect(seriesPlan.files.map((f) => f.key.replace('metric_series', 'X').replace(/-[0-9a-f]{8}\.parquet$/, ''))).toEqual(
      samplesPlan.files.map((f) => f.key.replace('metric_samples', 'X').replace(/-[0-9a-f]{8}\.parquet$/, '')),
    )
    for (const f of [...samplesPlan.files, ...seriesPlan.files]) {
      expect(f.level).toBe(0)
      expect(f.day).toBe(dayOf(f.minTs))
      expect(f.day).toBe(dayOf(f.maxTs))
      expect(JSON.parse(f.index).v).toBe(1)
    }
    // The ledger's log catches up (its alarm, run here at once); the next run records both
    // segments in the shard, and writes and admits nothing.
    expect(await loggedUnits(tenant)).toEqual([])
    await ledger.drain()
    const again = await flush(tenant, shardName)
    expect(again).toMatchObject({ status: 'ok', loggedThrough: 3, recordedThrough: 3, awaitingLog: false, remaining: 0, changed: true })
    expect(again.segments.map((s) => [s.seqLo, s.outcome, s.files.length])).toEqual([[1, 'already_admitted', 0], [3, 'already_admitted', 0]])
    // One unit per segment, with the segment's exact range, holding only that segment's files.
    const units = await loggedUnits(tenant)
    expect(units.map((u) => u.unit)).toEqual([{ seqLo: 1, seqHi: 2 }, { seqLo: 3, seqHi: 3 }])
    for (const u of units) {
      expect(u.added.length).toBeGreaterThan(0)
      for (const f of u.added) expect(f.key).toContain(`-${seg1.incarnation}-${u.unit!.seqLo}-${u.unit!.seqHi}-`)
    }

    // The shard: both segments recorded, the unsealed batch untouched.
    expect(await shard.pendingSegments(tenant)).toEqual([])
    expect(await shard.describe(tenant)).toMatchObject({ recordedThrough: 3, sealedThrough: 3, nextSeq: 5, discardedThrough: 0 })

    // After flush, before the shard discards: the seam reads lake + the unflushed batch…
    const seam = await read(tenant, [shardName])
    expect(seam.canon).toEqual(sent.canon())
    expect([seam.sampleFiles.length, seam.tailBatches]).toEqual([3, 1])
    // …and a read that takes the whole tail as well (flushed rows twice over) gives the same.
    const overlap = await read(tenant, [shardName], { tailFrom: 'zero' })
    expect(overlap.tailBatches).toBe(4)
    expect(overlap.lakeRows + overlap.tailRows).toBeGreaterThan(sent.size) // there really is an overlap
    expect(overlap.canon).toEqual(sent.canon())

    // After the shard discards: lake + the unflushed batch; the stale reader is refused, not handed a gap.
    await discardRecorded(shard)
    expect(await shard.describe(tenant)).toMatchObject({ discardedThrough: 3 })
    const after = await read(tenant, [shardName])
    expect(after.canon).toEqual(sent.canon())
    await expect(read(tenant, [shardName], { tailFrom: 'zero' })).rejects.toBeInstanceOf(StaleTail)

    // Matchers and ranges through the same path.
    const one = await read(tenant, [shardName], { matchers: [{ name: '__name__', op: '=', value: 'up' }, { name: 'instance', op: '=', value: 'i-0' }], minTs: T0, maxTs: T0 + 1 })
    expect(one.canon).toEqual([
      `[["__name__","up"],["instance","i-0"],["job","api"],["tenant_marker","${tenant}"]] @${T0} =7ff0000000000002`,
      `[["__name__","up"],["instance","i-0"],["job","api"],["tenant_marker","${tenant}"]] @${T0 + 1} =${(0x4018000000000000n).toString(16)}`,
    ])
  })

  it('does nothing on a second run, and nothing at all for a tenant or shard with no sealed segment', async () => {
    const { tenant, shardName, shard, ledger } = stream()
    expect(await flush(tenant, shardName)).toMatchObject({ status: 'ok', segments: [], recordedThrough: 0, awaitingLog: false })
    await append(shard, tenant, someSamples(tenant, T0, 12))
    expect(await flush(tenant, shardName)).toMatchObject({ status: 'ok', segments: [] }) // unsealed: not its business
    expect(await dataKeys(tenant)).toEqual([])
    await shard.seal(tenant)
    const first = await settled(tenant, shardName)
    expect(first.segments).toHaveLength(1)
    const keys = await dataKeys(tenant)
    const v = await versions(keys)
    const ledgerVersion = (await ledger.plan({ table: 'metric_samples', minTs: 0, maxTs: 1 })).version

    expect(await flush(tenant, shardName)).toMatchObject({ status: 'ok', segments: [], recordedThrough: 1, loggedThrough: 1 })
    expect(await dataKeys(tenant)).toEqual(keys)
    expect(await versions(keys)).toEqual(v) // no object was rewritten
    expect((await ledger.plan({ table: 'metric_samples', minTs: 0, maxTs: 1 })).version).toBe(ledgerVersion)
  })

  it('honours maxSegments and continues where it stopped', async () => {
    const { tenant, shardName, shard } = stream()
    const sent = new Sent()
    for (let i = 0; i < 4; i++) {
      await append(shard, tenant, someSamples(tenant, T0 + i * 600_000, 8, i), sent)
      await shard.seal(tenant)
    }
    const a = await settled(tenant, shardName, { maxSegments: 3 })
    expect(a).toMatchObject({ status: 'ok', recordedThrough: 3, remaining: 1 })
    expect(a.segments.map((s) => s.seqLo)).toEqual([1, 2, 3])
    const b = await settled(tenant, shardName, { maxSegments: 3 })
    expect(b).toMatchObject({ status: 'ok', recordedThrough: 4, remaining: 0 })
    expect(b.segments.map((s) => s.seqLo)).toEqual([4])
    expect((await read(tenant, [shardName])).canon).toEqual(sent.canon())
  })

  it('flushes one tenant of a shared shard without touching the other, and files are tenant-pure', async () => {
    const a = stream('a')
    const bTenant = `b-${a.tenant}`
    const sentA = new Sent()
    const sentB = new Sent()
    for (let i = 0; i < 3; i++) {
      await append(a.shard, a.tenant, someSamples(a.tenant, T0 + i * 60_000, 20, i), sentA)
      await append(a.shard, bTenant, someSamples(bTenant, T0 + i * 60_000, 20, 10 + i), sentB)
    }
    await a.shard.seal(a.tenant)
    await a.shard.seal(bTenant)

    const r = await flush(a.tenant, a.shardName)
    expect(r.segments).toHaveLength(1)
    // Nothing of B was written or recorded.
    expect(await dataKeys(bTenant)).toEqual([])
    expect(await a.shard.pendingSegments(bTenant)).toHaveLength(1)
    expect(await a.shard.describe(bTenant)).toMatchObject({ recordedThrough: 0 })
    expect(await liveKeys(ledgerStub(bTenant))).toEqual([])
    // Every object of A is under A's prefix and holds only A's series.
    for (const key of await dataKeys(a.tenant)) expect(key).toContain(`/tenant=${a.tenant}/`)
    const files = await Promise.all((await dataKeys(a.tenant)).map(async (k) => ({ k, bytes: new Uint8Array(await (await env.BUCKET.get(k))!.arrayBuffer()) })))
    const raw = engine.select(
      { seriesFiles: files.filter((f) => f.k.includes('/metric_series/')).map((f) => f.bytes), sampleFiles: files.filter((f) => f.k.includes('/metric_samples/')).map((f) => f.bytes), tailBatches: [] },
      [], 0, Number.MAX_SAFE_INTEGER,
    )
    expect(raw.length).toBeGreaterThan(0)
    for (const s of raw) expect(s.labels.tenant_marker).toBe(a.tenant)

    expect((await read(a.tenant, [a.shardName])).canon).toEqual(sentA.canon())
    expect((await read(bTenant, [a.shardName])).canon).toEqual(sentB.canon()) // B: still all tail
    await flush(bTenant, a.shardName)
    expect((await read(bTenant, [a.shardName])).canon).toEqual(sentB.canon())
    for (const key of await dataKeys(bTenant)) expect(key).toContain(`/tenant=${bTenant}/`)
    expect((await read(a.tenant, [a.shardName])).canon).toEqual(sentA.canon())
  })
})

describe('safe to run twice and to stop anywhere', () => {
  async function twoSegments() {
    const s = stream()
    const sent = new Sent()
    await append(s.shard, s.tenant, someSamples(s.tenant, T0, 30, 1), sent)
    await append(s.shard, s.tenant, someSamples(s.tenant, T0 + 300_000, 30, 2), sent)
    const seg1 = (await s.shard.seal(s.tenant))!
    await append(s.shard, s.tenant, someSamples(s.tenant, T0 + 600_000, 30, 3), sent)
    const seg2 = (await s.shard.seal(s.tenant))!
    return { ...s, sent, seg1, seg2 }
  }
  const crash = (at: 'afterPut' | 'afterAddUnit' | 'afterRecorded', onSeqLo: number): FlushOptions => ({
    hooks: { [at]: (seg: Segment) => { if (seg.seqLo === onSeqLo) throw new Error(`injected crash ${at}`) } },
  })

  it('two concurrent runs produce no duplicate file, and the same answer', async () => {
    const { tenant, shardName, shard, ledger, sent } = await twoSegments()
    const [a, b, c] = await Promise.all([flush(tenant, shardName), flush(tenant, shardName), flush(tenant, shardName)])
    for (const r of [a, b, c]) expect(r.status).toBe('ok')
    // Four objects (two per segment), each listed once, whoever wrote them.
    const keys = await dataKeys(tenant)
    expect(keys).toHaveLength(4)
    expect(await liveKeys(ledger)).toEqual(keys)
    // Once the log has caught up, one more run records both segments and writes nothing.
    const last = await settled(tenant, shardName)
    expect(last).toMatchObject({ status: 'ok', recordedThrough: 3, awaitingLog: false })
    expect(last.segments.flatMap((s) => s.files)).toEqual([])
    const units = await loggedUnits(tenant)
    expect(units.map((u) => u.unit)).toEqual([{ seqLo: 1, seqHi: 2 }, { seqLo: 3, seqHi: 3 }])
    expect(await shard.describe(tenant)).toMatchObject({ recordedThrough: 3 })
    // Each object was created exactly once across the three runs.
    const created = [a, b, c].flatMap((r) => r.segments.flatMap((s) => s.files.filter((f) => f.put === 'created').map((f) => f.key))).sort()
    expect(created).toEqual(keys)
    const lakeRows = (await read(tenant, [shardName])).lakeRows
    expect(lakeRows).toBe(sent.size)
    expect((await read(tenant, [shardName])).canon).toEqual(sent.canon())
    await discardRecorded(shard)
    expect((await read(tenant, [shardName])).canon).toEqual(sent.canon())
  })

  for (const pipeline of [1, 2]) {
  it(`converges after a crash between PUT and addUnit, without rewriting any object (pipeline ${pipeline})`, async () => {
    const { tenant, shardName, shard, ledger, sent } = await twoSegments()
    await expect(flush(tenant, shardName, { ...crash('afterPut', 1), pipeline })).rejects.toThrow('injected crash afterPut')
    // Objects are in R2, the ledger knows nothing, the shard has recorded nothing. With a
    // pipeline of 2 (D82) the second segment's objects were written too, ahead of its turn.
    const orphans = await dataKeys(tenant)
    expect(orphans).toHaveLength(2 * pipeline)
    expect(await liveKeys(ledger)).toEqual([])
    expect(await shard.describe(tenant)).toMatchObject({ recordedThrough: 0 })
    expect((await read(tenant, [shardName])).canon).toEqual(sent.canon()) // still served from the tail
    const v = await versions(orphans)

    const r = await settled(tenant, shardName)
    expect(r).toMatchObject({ status: 'ok', recordedThrough: 3 })
    expect(r.segments[0]!.files.map((f) => f.put)).toEqual(['exists', 'exists']) // same bytes, same keys
    expect(r.segments[1]!.files.map((f) => f.put)).toEqual(pipeline === 1 ? ['created', 'created'] : ['exists', 'exists'])
    expect(await versions(orphans)).toEqual(v) // If-None-Match: the first attempt's objects were not overwritten
    expect(await dataKeys(tenant)).toHaveLength(4)
    expect(await liveKeys(ledger)).toEqual(await dataKeys(tenant))
    expect((await read(tenant, [shardName])).canon).toEqual(sent.canon())
    await discardRecorded(shard)
    expect((await read(tenant, [shardName])).canon).toEqual(sent.canon())
  })
  }

  it('converges after a crash between addUnit and recorded, without a second unit', async () => {
    const { tenant, shardName, shard, ledger, sent } = await twoSegments()
    await expect(flush(tenant, shardName, crash('afterAddUnit', 1))).rejects.toThrow('injected crash afterAddUnit')
    // The ledger lists segment 1; the shard does not know yet, so it still holds it.
    expect(await liveKeys(ledger)).toHaveLength(2)
    expect(await shard.describe(tenant)).toMatchObject({ recordedThrough: 0 })
    expect((await shard.pendingSegments(tenant)).map((s) => s.seqLo)).toEqual([1, 3])
    // In between, a query sees every sample once: lake above nothing, tail above the watermark.
    const between = await read(tenant, [shardName])
    expect(between.canon).toEqual(sent.canon())
    expect((await read(tenant, [shardName], { tailFrom: 'zero' })).canon).toEqual(sent.canon())
    const keys = await dataKeys(tenant)
    const v = await versions(keys)
    const ledgerVersion = between.ledgerVersion

    const r = await settled(tenant, shardName)
    expect(r).toMatchObject({ status: 'ok', recordedThrough: 3 })
    expect(r.segments.map((s) => [s.seqLo, s.outcome, s.files.length])).toEqual([[1, 'already_admitted', 0], [3, 'admitted', 2]])
    expect(await versions(keys)).toEqual(v)
    expect((await loggedUnits(tenant)).map((u) => u.unit)).toEqual([{ seqLo: 1, seqHi: 2 }, { seqLo: 3, seqHi: 3 }])
    expect((await read(tenant, [shardName])).ledgerVersion).toBe(ledgerVersion + 1) // exactly one more change: segment 2
    expect(await liveKeys(ledger)).toEqual(await dataKeys(tenant))
    await discardRecorded(shard)
    expect((await read(tenant, [shardName])).canon).toEqual(sent.canon())
  })

  it('converges after a crash right after recorded, and after the shard and ledger objects are evicted mid-run', async () => {
    const { tenant, shardName, shard, ledger, sent } = await twoSegments()
    // The ledger's log catches up right after segment 1 is admitted, so the run tells the shard.
    const drainThenCrash: FlushOptions = { hooks: { afterAddUnit: async () => void (await ledger.drain()), afterRecorded: crash('afterRecorded', 1).hooks!.afterRecorded! } }
    await expect(flush(tenant, shardName, drainThenCrash)).rejects.toThrow('injected crash afterRecorded')
    expect(await shard.describe(tenant)).toMatchObject({ recordedThrough: 2 })
    // Evict both objects at every step of the second run: all their state is in storage.
    let evictions = 0
    const evict = async () => {
      // An object that is not running right now has nothing in memory to lose.
      for (const o of [shard, ledger]) await evictDurableObject(o).then(() => evictions++, () => undefined)
    }
    const r = await settled(tenant, shardName, { hooks: { afterPut: evict, afterAddUnit: evict, afterRecorded: evict } })
    expect(r).toMatchObject({ status: 'ok', recordedThrough: 3, loggedThrough: 3 })
    expect(r.segments.map((s) => s.seqLo)).toEqual([3])
    expect(evictions).toBeGreaterThanOrEqual(4) // both objects really were evicted during the run
    await evict()
    expect(await liveKeys(ledger)).toEqual(await dataKeys(tenant))
    expect(await dataKeys(tenant)).toHaveLength(4)
    expect((await read(tenant, [shardName])).canon).toEqual(sent.canon())
    await discardRecorded(shard)
    await evict()
    expect((await read(tenant, [shardName])).canon).toEqual(sent.canon())
  })

  it('tells the shard only what the ledger has LOGGED, so a ledger that loses its storage loses no rows', async () => {
    const { tenant, shardName, shard, ledger, sent } = await twoSegments()
    // The stream is registered and logged; then the ledger can commit but cannot write its change log.
    await ledger.registerStream({ shard: shardName, incarnation: (await shard.describe(tenant))!.incarnation })
    await ledger.drain()
    await breakLedgerLog(ledger)
    const r = await flush(tenant, shardName)
    expect(r).toMatchObject({ status: 'ok', loggedThrough: 0, recordedThrough: 0, awaitingLog: true })
    expect(r.segments.map((s) => s.outcome)).toEqual(['admitted', 'admitted'])
    // Committed and visible…
    expect((await ledger.plan({ table: 'metric_samples', minTs: 1, maxTs: 0 })).watermarks[0]!.seq).toBe(3)
    expect(await liveKeys(ledger)).toHaveLength(4)
    // …but the shard was told nothing, and discards nothing.
    await discardRecorded(shard)
    expect(await shard.describe(tenant)).toMatchObject({ recordedThrough: 0, discardedThrough: 0 })
    expect((await shard.pendingSegments(tenant)).length).toBe(2)

    // The ledger loses its storage. It comes back from its R2 log, which never got the units.
    await loseLedgerStorage(ledger)
    expect(await liveKeys(ledger)).toEqual([])
    expect((await read(tenant, [shardName])).canon).toEqual(sent.canon()) // every row is still in the shard

    // The next run reports both segments again; the objects are already there.
    const again = await settled(tenant, shardName)
    expect(again).toMatchObject({ status: 'ok', loggedThrough: 3, recordedThrough: 3, awaitingLog: false })
    expect(again.segments.flatMap((s) => s.files.map((f) => f.put))).toEqual(['exists', 'exists', 'exists', 'exists'])
    await discardRecorded(shard)
    expect(await shard.describe(tenant)).toMatchObject({ discardedThrough: 3 })
    expect((await read(tenant, [shardName])).canon).toEqual(sent.canon())
  })

  it('records later, once the log has caught up, without reporting anything twice', async () => {
    const { tenant, shardName, shard, ledger, sent } = await twoSegments()
    await ledger.registerStream({ shard: shardName, incarnation: (await shard.describe(tenant))!.incarnation })
    await ledger.drain()
    await breakLedgerLog(ledger)
    expect(await flush(tenant, shardName)).toMatchObject({ status: 'ok', recordedThrough: 0, awaitingLog: true })
    await healLedgerLog(ledger)
    await ledger.drain() // what the ledger's alarm does
    const r = await flush(tenant, shardName)
    expect(r).toMatchObject({ status: 'ok', recordedThrough: 3, loggedThrough: 3, awaitingLog: false })
    expect(r.segments.map((s) => [s.outcome, s.files.length])).toEqual([['already_admitted', 0], ['already_admitted', 0]])
    expect((await loggedUnits(tenant)).length).toBe(2)
    expect((await read(tenant, [shardName])).canon).toEqual(sent.canon())
  })
})

describe('every answer of the ledger and of R2 is handled', () => {
  it('not_contiguous: re-reads the watermark and reports again what the ledger no longer has', async () => {
    const s = stream()
    const sent = new Sent()
    for (let i = 0; i < 3; i++) {
      await append(s.shard, s.tenant, someSamples(s.tenant, T0 + i * 600_000, 20, i), sent)
      await s.shard.seal(s.tenant)
    }
    // While the run is between segments 1 and 2, the ledger loses its storage together with
    // the unlogged unit of segment 1 (its log could not be written), and comes back empty.
    await s.ledger.registerStream({ shard: s.shardName, incarnation: (await s.shard.describe(s.tenant))!.incarnation })
    await s.ledger.drain()
    await breakLedgerLog(s.ledger)
    let lost = false
    const r = await settled(s.tenant, s.shardName, {
      hooks: {
        afterAddUnit: async (seg) => {
          if (seg.seqLo === 1 && !lost) {
            lost = true
            await loseLedgerStorage(s.ledger) // also heals the log: the new object uses the real bucket
          }
        },
      },
    })
    expect(lost).toBe(true)
    // Segment 2 was answered not_contiguous (watermark 0); the run went back to segment 1.
    expect(r).toMatchObject({ status: 'ok', recordedThrough: 3, loggedThrough: 3, awaitingLog: false })
    expect(r.segments.map((x) => [x.seqLo, x.outcome])).toEqual([[1, 'admitted'], [2, 'admitted'], [3, 'admitted']])
    expect(r.segments[0]!.files.map((f) => f.put)).toEqual(['exists', 'exists'])
    expect((await s.ledger.plan({ table: 'metric_samples', minTs: 1, maxTs: 0 })).watermarks).toMatchObject([{ seq: 3 }])
    expect(await liveKeys(s.ledger)).toEqual(await dataKeys(s.tenant))
    expect(await dataKeys(s.tenant)).toHaveLength(6)
    await discardRecorded(s.shard)
    expect((await read(s.tenant, [s.shardName])).canon).toEqual(sent.canon())
  })

  it('not_contiguous: a segment the ledger already has (admitted by a racing run) is skipped, not re-admitted', async () => {
    const s = stream()
    const sent = new Sent()
    for (let i = 0; i < 2; i++) {
      await append(s.shard, s.tenant, someSamples(s.tenant, T0 + i * 600_000, 20, i), sent)
      await s.shard.seal(s.tenant)
    }
    // Run B completes entirely while run A is between writing segment 1's files and reporting them.
    let b: FlushResult | undefined
    // B runs to the end, its log caught up; A then finds both segments admitted and logged.
    const a = await flush(s.tenant, s.shardName, { hooks: { afterPut: async (seg) => { if (seg.seqLo === 1) b = await settled(s.tenant, s.shardName) } } })
    expect(b).toMatchObject({ status: 'ok', recordedThrough: 2 })
    expect(a).toMatchObject({ status: 'ok', recordedThrough: 2 })
    expect((await loggedUnits(s.tenant)).map((u) => u.unit)).toEqual([{ seqLo: 1, seqHi: 1 }, { seqLo: 2, seqHi: 2 }])
    expect(await liveKeys(s.ledger)).toEqual(await dataKeys(s.tenant))
    expect(await dataKeys(s.tenant)).toHaveLength(4)
    expect((await read(s.tenant, [s.shardName])).canon).toEqual(sent.canon())
  })

  it('gap: stops when rows between the ledger watermark and the first pending segment are in neither', async () => {
    const s = stream()
    await append(s.shard, s.tenant, someSamples(s.tenant, T0, 20, 1))
    await s.shard.seal(s.tenant)
    expect(await settled(s.tenant, s.shardName)).toMatchObject({ status: 'ok', recordedThrough: 1 })
    await append(s.shard, s.tenant, someSamples(s.tenant, T0 + 600_000, 20, 2))
    await s.shard.seal(s.tenant)
    // The ledger, its R2 log AND the tenant's data objects are destroyed (an operator error), so
    // it may restart knowing nothing. (With data objects left, the ledger refuses to start empty
    // over them: review S-5, tested in ledger/.)
    for (const k of await listKeys(`${env.CELL}/ledger/tenant=${s.tenant}/`)) await env.BUCKET.delete(k)
    for (const k of await dataKeys(s.tenant)) await env.BUCKET.delete(k)
    await loseLedgerStorage(s.ledger)
    const before = await dataKeys(s.tenant)

    const r = await flush(s.tenant, s.shardName)
    expect(r).toMatchObject({ status: 'error', reason: 'gap', recordedThrough: 1, segments: [] })
    expect(r.detail).toContain('next sequence')
    expect(await liveKeys(s.ledger)).toEqual([]) // nothing admitted on top of a hole
    expect(await dataKeys(s.tenant)).toEqual(before) // and nothing written
    expect((await s.shard.pendingSegments(s.tenant)).map((x) => x.seqLo)).toEqual([2]) // the segment is kept
  })

  it('incarnation_mismatch: registers the shard\'s new incarnation and retries once', async () => {
    const s = stream()
    const sent = new Sent()
    await append(s.shard, s.tenant, someSamples(s.tenant, T0, 20, 1), sent)
    const old = (await s.shard.seal(s.tenant))!
    expect(await settled(s.tenant, s.shardName)).toMatchObject({ status: 'ok', recordedThrough: 1 })
    await discardRecorded(s.shard)
    // The shard loses its storage: a new incarnation, sequence numbers start again at 1.
    await runInDurableObject(s.shard, async (_i, state) => { await state.storage.deleteAll() })
    await evictDurableObject(s.shard)
    await new Promise((r) => setTimeout(r, 3))
    await append(s.shard, s.tenant, someSamples(s.tenant, T0 + 600_000, 20, 2), sent)
    const fresh = (await s.shard.seal(s.tenant))!
    expect(fresh.seqLo).toBe(1)
    expect(fresh.incarnation).toBeGreaterThan(old.incarnation)

    const r = await settled(s.tenant, s.shardName)
    expect(r).toMatchObject({ status: 'ok', recordedThrough: 1, loggedThrough: 1 })
    expect(r.segments).toMatchObject([{ incarnation: fresh.incarnation, seqLo: 1, outcome: 'admitted' }])
    expect((await s.ledger.plan({ table: 'metric_samples', minTs: 1, maxTs: 0 })).watermarks).toEqual([{ shard: s.shardName, incarnation: fresh.incarnation, seq: 1 }])
    // Files of both incarnations are live, under different keys.
    const keys = await liveKeys(s.ledger)
    expect(keys).toHaveLength(4)
    expect(keys.filter((k) => k.includes(`-${old.incarnation}-1-1-`))).toHaveLength(2)
    expect(keys.filter((k) => k.includes(`-${fresh.incarnation}-1-1-`))).toHaveLength(2)
    expect((await read(s.tenant, [s.shardName])).canon).toEqual(sent.canon())
  })

  it('stale_incarnation: stops when the ledger knows a NEWER incarnation than the shard reports', async () => {
    const s = stream()
    await append(s.shard, s.tenant, someSamples(s.tenant, T0, 20, 1))
    const seg = (await s.shard.seal(s.tenant))!
    await s.ledger.registerStream({ shard: s.shardName, incarnation: seg.incarnation + 1024 })
    const r = await flush(s.tenant, s.shardName)
    expect(r).toMatchObject({ status: 'error', reason: 'stale_incarnation', recordedThrough: 0 })
    expect(await liveKeys(s.ledger)).toEqual([])
    expect((await s.ledger.plan({ table: 'metric_samples', minTs: 1, maxTs: 0 })).watermarks).toEqual([{ shard: s.shardName, incarnation: seg.incarnation + 1024, seq: 0 }])
    expect((await s.shard.pendingSegments(s.tenant)).length).toBe(1)
  })

  it('invalid: stops and surfaces the ledger\'s reason, and records nothing', async () => {
    const s = stream()
    const sent = new Sent()
    const payload = await append(s.shard, s.tenant, someSamples(s.tenant, T0, 20, 1), sent)
    const seg = (await s.shard.seal(s.tenant))!
    // Another unit (of another shard) already holds the key this flush will produce.
    const files = engine.encodeSegment([payload])
    const key = dataFileKey({ cell: env.CELL, table: 'metric_samples', tenant: s.tenant, day: files[0]!.day, level: 0, shard: s.shardName, incarnation: seg.incarnation, seqLo: 1, seqHi: 1, sha256Hex: await sha256Hex(files[0]!.bytes) })
    expect(await s.ledger.addUnit({ shard: 'someone/else', incarnation: 5, seqLo: 1, seqHi: 1, files: [{ table: 'metric_samples', day: files[0]!.day, key, bytes: 1, rows: 1, minTs: T0, maxTs: T0, level: 0, index: '' }] })).toMatchObject({ status: 'ok' })

    const r = await flush(s.tenant, s.shardName)
    expect(r).toMatchObject({ status: 'error', reason: 'invalid_unit', recordedThrough: 0, segments: [] })
    expect(r.detail).toContain('already live in another unit')
    expect((await s.ledger.plan({ table: 'metric_samples', minTs: 1, maxTs: 0 })).watermarks.map((w) => w.shard)).toEqual(['someone/else'])
    expect((await s.shard.pendingSegments(s.tenant)).length).toBe(1)
    expect((await read(s.tenant, [s.shardName], { matchers: [{ name: 'job', op: '=', value: 'api' }] })).tailBatches).toBe(1)
  })

  it('an existing object counts as written only if its size and hash match', async () => {
    for (const variant of ['same size, other bytes', 'other size', 'identical bytes without a stored checksum'] as const) {
      const s = stream()
      const sent = new Sent()
      const payload = await append(s.shard, s.tenant, someSamples(s.tenant, T0, 20, 1), sent)
      const seg = (await s.shard.seal(s.tenant))!
      const file = engine.encodeSegment([payload])[0]!
      const key = dataFileKey({ cell: env.CELL, table: 'metric_samples', tenant: s.tenant, day: file.day, level: 0, shard: s.shardName, incarnation: seg.incarnation, seqLo: 1, seqHi: 1, sha256Hex: await sha256Hex(file.bytes) })
      const squatter = variant === 'identical bytes without a stored checksum' ? file.bytes.slice() : variant === 'other size' ? file.bytes.slice(0, file.bytes.length - 1) : file.bytes.slice().fill(7, 20, 40)
      // The ledger exists before the squatter appears, as in production (flush plans before its
      // first PUT); a ledger that starts empty over existing data objects refuses (review S-5).
      await s.ledger.plan({ table: 'metric_samples', minTs: 0, maxTs: 0 })
      await env.BUCKET.put(key, squatter) // no sha256 stored with it
      const version = (await env.BUCKET.head(key))!.version

      const r = await settled(s.tenant, s.shardName)
      // Whatever happened, the object that was there is untouched.
      expect((await env.BUCKET.head(key))!.version).toBe(version)
      expect(new Uint8Array(await (await env.BUCKET.get(key))!.arrayBuffer())).toEqual(squatter)
      if (variant === 'identical bytes without a stored checksum') {
        // Read back and hashed: it IS this file.
        expect(r).toMatchObject({ status: 'ok', recordedThrough: 1 })
        expect(r.segments[0]!.files.map((f) => f.put)).toEqual(['exists', 'created'])
        expect((await read(s.tenant, [s.shardName])).canon).toEqual(sent.canon())
      } else {
        expect(r).toMatchObject({ status: 'error', reason: 'object_conflict', recordedThrough: 0, segments: [] })
        expect(r.detail).toContain(key)
        expect(await liveKeys(s.ledger)).toEqual([]) // the ledger never lists bytes it did not admit
        expect((await s.shard.pendingSegments(s.tenant)).length).toBe(1)
        expect((await read(s.tenant, [s.shardName])).canon).toEqual(sent.canon()) // the rows are still in the tail
      }
    }
  })
})

describe('entry points', () => {
  it('serves flushTenant over RPC and over fetch', async () => {
    const s = stream()
    const sent = new Sent()
    await append(s.shard, s.tenant, someSamples(s.tenant, T0, 20, 1), sent)
    await s.shard.seal(s.tenant)
    const rpc = await exports.Flush.flushTenant(s.tenant, s.shardName)
    expect(rpc).toMatchObject({ status: 'ok', recordedThrough: 0, awaitingLog: true, segments: [{ seqLo: 1, outcome: 'admitted' }] })
    await s.ledger.drain()
    expect(await exports.Flush.flushTenant(s.tenant, s.shardName)).toMatchObject({ status: 'ok', recordedThrough: 1, awaitingLog: false })

    await append(s.shard, s.tenant, someSamples(s.tenant, T0 + 600_000, 20, 2), sent)
    await s.shard.seal(s.tenant)
    const post = (body: unknown, method = 'POST') => exports.default.fetch('https://flush.internal/flush', { method, body: method === 'POST' ? JSON.stringify(body) : undefined })
    const res = await post({ tenant: s.tenant, shard: s.shardName })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ status: 'ok', recordedThrough: 1, awaitingLog: true, segments: [{ seqLo: 2, outcome: 'admitted' }] })
    await s.ledger.drain()
    expect(await (await post({ tenant: s.tenant, shard: s.shardName })).json()).toMatchObject({ status: 'ok', recordedThrough: 2, awaitingLog: false })
    expect((await read(s.tenant, [s.shardName])).canon).toEqual(sent.canon())

    expect((await post({ tenant: 'a/b', shard: 'x' })).status).toBe(400)
    expect((await post({ tenant: s.tenant })).status).toBe(400)
    expect((await exports.default.fetch('https://flush.internal/flush', { method: 'POST', body: 'not json' })).status).toBe(400)
    expect((await post(null, 'GET')).status).toBe(405)
    expect((await exports.default.fetch('https://flush.internal/other')).status).toBe(404)
    expect((await exports.default.fetch('https://flush.internal/healthz')).status).toBe(200)

    // A run that stops on a state it must not guess about answers 409 with the reason.
    const t = stream()
    await append(t.shard, t.tenant, someSamples(t.tenant, T0, 4, 1))
    const seg = (await t.shard.seal(t.tenant))!
    await t.ledger.registerStream({ shard: t.shardName, incarnation: seg.incarnation + 1024 })
    const refused = await post({ tenant: t.tenant, shard: t.shardName })
    expect(refused.status).toBe(409)
    expect(await refused.json()).toMatchObject({ status: 'error', reason: 'stale_incarnation' })
  })

  it('refuses a tenant id that could escape its prefix', async () => {
    await expect(flush('a/b', 'pool/0')).rejects.toThrow(/tenant id must match/)
    await expect(flush('ok', '')).rejects.toThrow(/shard name/)
    expect(shardStub).toBeDefined()
  })
})

// spec/README.md F12 (the protocol model's trace `F12_impl_read_unbound`): a flush that listed a
// segment before the shard lost its storage must not read the new incarnation's batches under
// the old incarnation's name.
describe('spec F12: a flush read is bound to the incarnation it was listed in', () => {
  it('the shard loses its storage between the listing and the read; the new incarnation\'s batch is not filed under the old one', async () => {
    const s = stream('f12')
    const old = new Sent()
    await append(s.shard, s.tenant, someSamples(s.tenant, T0, 20, 1), old)
    const listed = (await s.shard.seal(s.tenant))!
    const fresh = new Sent()
    const r = await flushTenant(env, engine, s.tenant, s.shardName, {
      hooks: {
        afterList: async () => {
          // After the worker listed (inc 1, 1..1): the shard loses its storage, a new batch arrives
          // in a new incarnation with sequence number 1 again, and is sealed.
          await runInDurableObject(s.shard, async (_i, state) => { await state.storage.deleteAll() })
          await evictDurableObject(s.shard)
          await new Promise((x) => setTimeout(x, 3))
          await append(s.shard, s.tenant, someSamples(s.tenant, T0 + 600_000, 20, 2), fresh)
          const seg = (await s.shard.seal(s.tenant))!
          expect(seg).toMatchObject({ seqLo: 1, seqHi: 1 })
          expect(seg.incarnation).toBeGreaterThan(listed.incarnation)
        },
      },
    })
    expect(r).toMatchObject({ status: 'error', reason: 'shard_incarnation_changed' })
    // Nothing of the new incarnation was admitted under the old one's name.
    expect((await liveKeys(s.ledger)).filter((k) => k.includes(`-${listed.incarnation}-1-1-`))).toEqual([])
    // The next run files the new batch under its own incarnation; the rows lost with the old
    // storage are lost (and visible as such through the ledger's incarnation boundary), not misfiled.
    const again = await flushSettled(env, engine, s.tenant, s.shardName)
    expect(again).toMatchObject({ status: 'ok', awaitingLog: false })
    const keys = await liveKeys(s.ledger)
    expect(keys.every((k) => !k.includes(`-${listed.incarnation}-`))).toBe(true)
    expect((await read(s.tenant, [s.shardName])).canon).toEqual(fresh.canon())
  })
})
