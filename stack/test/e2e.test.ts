import { evictDurableObject } from 'cloudflare:test'
import { env, exports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { parquetMetadata, parquetReadObjects } from '../../bench/node_modules/hyparquet/src/index.js'
import type { FileEntry, LedgerChange } from '../../contracts/ledger'
import { bitsOf, seriesId } from '../../engine/wasm/test/vzb1'
import { breakLedgerLog, dataKeys, discardRecorded, listKeys, liveKeys, loseLedgerStorage, read, sha256Hex } from '../../flush/test/helpers'
import { StaleTail } from '../../flush/test/read'
import type { Segment } from '../../shard/src/shard'
import { engine, flushTenant } from '../src/index'
import { type Tenant, type World, flushAll, ledgerOf, prwWorkload, sealAll, sendAll, sendPrw, sendPrwWithLimits, shardOf, world } from './world'

const KEY = (tenant: string) =>
  new RegExp(`^${env.CELL}/data/(metric_samples|metric_series)/tenant=${tenant}/day=(\\d{4}-\\d{2}-\\d{2})/L0-(e2e-[a-z0-9]+_[01])-(\\d+)-(\\d+)-(\\d+)-([0-9a-f]{8})\\.parquet$`)
const dayOf = (ts: number) => new Date(ts).toISOString().slice(0, 10)
const M64 = (1n << 64n) - 1n

/** What a query for this tenant returns right now, through the seam. */
const query = (w: World, t: Tenant, opts: Parameters<typeof read>[2] = {}) => read(t.name, w.shards, opts)

async function expectBoth(w: World, check: (t: Tenant, other: Tenant) => Promise<void>): Promise<void> {
  await check(w.a, w.b)
  await check(w.b, w.a)
}

/** Every reading of the tenant's data equals exactly what it sent, and holds nothing of the other tenant. */
async function expectExact(w: World, opts: Parameters<typeof read>[2] = {}): Promise<void> {
  await expectBoth(w, async (t, other) => {
    const r = await query(w, t, opts)
    expect(r.canon).toEqual(t.sent.canon())
    for (const s of r.series) {
      expect(s.labels.owner ?? t.name).toBe(t.name)
      expect(Object.values(s.labels)).not.toContain(other.name)
    }
  })
}

const planOf = async (t: Tenant, table: 'metric_samples' | 'metric_series'): Promise<FileEntry[]> =>
  (await ledgerOf(t).plan({ table, minTs: 0, maxTs: Number.MAX_SAFE_INTEGER })).files

async function loggedUnits(tenant: string): Promise<LedgerChange[]> {
  const out: LedgerChange[] = []
  for (const key of await listKeys(`${env.CELL}/ledger/tenant=${tenant}/`)) {
    if (key.endsWith('base.json')) continue
    const c = await (await env.BUCKET.get(key))!.json<LedgerChange>()
    if (c.kind === 'add_unit') out.push(c)
  }
  return out
}

/** No key is listed twice, and every listed file is an object in R2 of the listed size. */
async function expectLedgerSound(t: Tenant): Promise<void> {
  const files = [...(await planOf(t, 'metric_samples')), ...(await planOf(t, 'metric_series'))]
  expect(new Set(files.map((f) => f.key)).size).toBe(files.length)
  for (const f of files) expect((await env.BUCKET.head(f.key))?.size).toBe(f.bytes)
  // Every samples file is listed together with the series file of its unit and day.
  const stem = (f: FileEntry) => f.key.replace(/metric_(samples|series)/, 'T').replace(/-[0-9a-f]{8}\.parquet$/, '')
  expect(files.filter((f) => f.table === 'metric_series').map(stem).sort()).toEqual(files.filter((f) => f.table === 'metric_samples').map(stem).sort())
}

describe('senders → edge → shard → flush → R2 → ledger → read', () => {
  it('returns exactly what two tenants sent, before flush, after flush and after the shard discards', async () => {
    const w = await world()
    await sendAll(w)
    expect(w.a.sent.size).toBeGreaterThan(60)

    // Both tenants really share both shard objects, each in its own stream.
    for (const s of w.shards) {
      const a = await shardOf(s).describe(w.a.name)
      const b = await shardOf(s).describe(w.b.name)
      expect(a && b).toBeTruthy()
      expect(a!.nextSeq).toBeGreaterThan(1)
    }

    // ── 1. Before flush: everything is tail. ──
    await expectBoth(w, async (t) => {
      const r = await query(w, t)
      expect([r.sampleFiles.length, r.seriesFiles.length]).toEqual([0, 0])
      expect(r.tailRows).toBe(t.sent.size)
      expect(r.canon).toEqual(t.sent.canon())
    })
    await expectExact(w)
    // The series with identical labels in both tenants: each sees only its own values.
    const shared = async (t: Tenant) => (await query(w, t, { matchers: [{ name: '__name__', op: '=', value: 'shared_metric' }] })).canon
    expect((await shared(w.a)).length).toBe(4)
    expect((await shared(w.a)).every((line) => / =408f4[08]0{10}$/.test(line))).toBe(true) // 1000 and 1001
    expect((await shared(w.b)).every((line) => / =409f4[04]0{10}$/.test(line))).toBe(true) // 2000 and 2001
    expect(await shared(w.a)).not.toEqual(await shared(w.b))

    // ── Seal and flush. ──
    expect(await sealAll(w)).toBe(4)
    expect(await dataKeys(w.a.name)).toEqual([]) // sealing writes nothing
    const results = await flushAll(w)
    for (const r of results) expect(r).toMatchObject({ status: 'ok', awaitingLog: false, remaining: 0 })
    expect(results.map((r) => r.segments.length)).toEqual([1, 1, 1, 1])

    // ── Parquet objects: right keys, tenant-pure, listed by the right ledger only. ──
    const days = new Set(w.a.sent.samples().map((s) => dayOf(s.ts)))
    await expectBoth(w, async (t, other) => {
      const keys = await dataKeys(t.name)
      // Two shards × (samples + series) × the UTC days the data covers (one, except at midnight).
      expect(keys.length).toBeGreaterThanOrEqual(4)
      expect(keys.length % 4).toBe(0)
      for (const key of keys) {
        const m = KEY(t.name).exec(key)
        expect(m, key).not.toBeNull()
        const [, , day, shard, incarnation, seqLo, seqHi, hash8] = m!
        expect(days.has(day!)).toBe(true)
        const stream = (await shardOf(shard!.replace('_', '/')).describe(t.name))!
        expect(Number(incarnation)).toBe(stream.incarnation)
        expect([Number(seqLo), Number(seqHi)]).toEqual([1, stream.sealedThrough])
        const bytes = new Uint8Array(await (await env.BUCKET.get(key))!.arrayBuffer())
        expect((await sha256Hex(bytes)).slice(0, 8)).toBe(hash8) // the content hash is in the key
      }
      // The tenant's ledger lists exactly its own objects; the other tenant's ledger lists none of them.
      expect(await liveKeys(ledgerOf(t))).toEqual(keys)
      const theirs = await liveKeys(ledgerOf(other))
      expect(theirs.filter((k) => keys.includes(k))).toEqual([])
      for (const k of theirs) expect(k).toContain(`/tenant=${other.name}/`)
      await expectLedgerSound(t)
      // Tenant-pure: read the objects on their own, with no ledger and no tail.
      const objects = await Promise.all(keys.map(async (k) => ({ k, bytes: new Uint8Array(await (await env.BUCKET.get(k))!.arrayBuffer()) })))
      const raw = engine.select(
        { seriesFiles: objects.filter((o) => o.k.includes('/metric_series/')).map((o) => o.bytes), sampleFiles: objects.filter((o) => o.k.includes('/metric_samples/')).map((o) => o.bytes), tailBatches: [] },
        [], 0, Number.MAX_SAFE_INTEGER,
      )
      expect(raw.reduce((n, s) => n + s.ts.length, 0)).toBe(t.sent.size)
      for (const s of raw) {
        expect(JSON.stringify(s.labels)).not.toContain(other.name)
        if (s.labels.__name__ !== 'shared_metric') expect(s.labels.owner).toBe(t.name)
      }
    })

    // ── 2. After flush, before the shards discard. ──
    await expectBoth(w, async (t) => {
      // The seam: lake files, and the tail above the watermark (now empty).
      const seam = await query(w, t)
      expect(seam.canon).toEqual(t.sent.canon())
      expect([seam.lakeRows, seam.tailRows]).toEqual([t.sent.size, 0])
      // Lake + the WHOLE tail the shards still hold: every row twice over, counted once.
      const overlap = await query(w, t, { tailFrom: 'zero' })
      expect([overlap.lakeRows, overlap.tailRows]).toEqual([t.sent.size, t.sent.size])
      expect(overlap.canon).toEqual(t.sent.canon())
    })
    await expectExact(w, { tailFrom: 'zero' })

    // ── 3. After discard: all lake. ──
    for (const s of w.shards) await discardRecorded(shardOf(s))
    await expectBoth(w, async (t) => {
      for (const s of w.shards) expect((await shardOf(s).describe(t.name))!.bufferedBytes).toBe(0)
      const r = await query(w, t)
      expect(r.canon).toEqual(t.sent.canon())
      expect([r.lakeRows, r.tailRows, r.tailBatches]).toEqual([t.sent.size, 0, 0])
      // A reader holding a watermark from before the discard is refused, not handed a gap.
      await expect(query(w, t, { tailFrom: 'zero' })).rejects.toBeInstanceOf(StaleTail)
    })
    await expectExact(w)

    // A selector and a time range through lake files.
    const up = await query(w, w.a, { matchers: [{ name: '__name__', op: '=', value: 'up' }, { name: 'owner', op: '=~', value: 'tenant-a-.*' }], minTs: w.now - 15_000, maxTs: w.now })
    expect(up.series.length).toBe(4)
    expect(up.canon.length).toBe(8)
    expect((await query(w, w.b, { matchers: [{ name: 'owner', op: '=', value: w.a.name }] })).canon).toEqual([])
  })

  it('is read back identically by an independent Parquet reader (hyparquet)', async () => {
    const w = await world()
    await sendAll(w)
    await sealAll(w)
    await flushAll(w)
    const t = w.a
    const samples = await planOf(t, 'metric_samples')
    const series = await planOf(t, 'metric_series')
    const want = t.sent.samples()

    // Expected checksums, from what was SENT, with series ids computed here by FNV-1a.
    const expected = { rows: want.length, ts: 0n, sid: 0n, xor: 0n, nans: 0 }
    for (const s of want) {
      expected.ts = (expected.ts + BigInt(s.ts)) & M64
      expected.sid = (expected.sid + BigInt.asUintN(64, seriesId(s.labels))) & M64
      const isNan = (s.bits & 0x7ff0000000000000n) === 0x7ff0000000000000n && (s.bits & 0x000fffffffffffffn) !== 0n
      if (isNan) expected.nans++
      else expected.xor ^= s.bits
    }

    const got = { rows: 0, ts: 0n, sid: 0n, xor: 0n, nans: 0 }
    for (const f of samples) {
      const file = await (await env.BUCKET.get(f.key))!.arrayBuffer()
      expect(Number(parquetMetadata(file).num_rows)).toBe(f.rows) // footer row count = what the ledger was told
      const rows = await parquetReadObjects({ file })
      expect(rows.length).toBe(f.rows)
      let prev: Record<string, any> | undefined
      for (const r of rows) {
        expect(Object.keys(r)).toEqual(['metric_name', 'series_id', 'ts', 'value'])
        got.rows++
        got.ts = (got.ts + BigInt(r.ts)) & M64
        got.sid = (got.sid + BigInt.asUintN(64, BigInt(r.series_id))) & M64
        if (Number.isNaN(r.value)) got.nans++
        else got.xor ^= bitsOf(r.value)
        expect(dayOf(Number(r.ts))).toBe(f.day)
        // Sorted by (metric_name, series_id, ts), (series_id, ts) unique.
        if (prev) {
          const byName = prev.metric_name < r.metric_name ? -1 : prev.metric_name > r.metric_name ? 1 : 0
          expect(byName < 0 || (byName === 0 && (prev.series_id < r.series_id || (prev.series_id === r.series_id && prev.ts < r.ts)))).toBe(true)
        }
        prev = r
      }
    }
    expect(got).toEqual(expected)
    expect(got.nans).toBe(3) // two from Remote Write, one from OTLP's NO_RECORDED_VALUE

    // The series files, by the same reader: canonical labels, all of this tenant.
    let seriesRows = 0
    for (const f of series) {
      const rows = await parquetReadObjects({ file: await (await env.BUCKET.get(f.key))!.arrayBuffer() })
      expect(rows.length).toBe(f.rows)
      for (const r of rows) {
        seriesRows++
        const labels = JSON.parse(r.labels) as Record<string, string>
        expect(labels.__name__).toBe(r.metric_name)
        expect(BigInt(r.series_id)).toBe(seriesId(labels))
        expect(r.labels).not.toContain(w.b.name)
        expect(r.labels).not.toMatch(/\s/) // canonical JSON: no whitespace (no label here contains any)
        expect(Object.keys(labels)).toEqual([...Object.keys(labels)].sort())
      }
    }
    expect(seriesRows).toBe(new Set(want.map((s) => `${dayOf(s.ts)} ${seriesId(s.labels)}`)).size)

    // For tools/hyparquet_check.mjs: the same comparison again, in Node.
    const first = samples[0]!
    const bytes = new Uint8Array(await (await env.BUCKET.get(first.key))!.arrayBuffer())
    let b64 = ''
    for (let i = 0; i < bytes.length; i += 0x8000) b64 += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    const shardOfKey = KEY(t.name).exec(first.key)![3]!.replace('_', '/')
    const tail = engine.select({ seriesFiles: [], sampleFiles: [], tailBatches: (await shardOf(shardOfKey).readSegment(t.name, 1))!.map((b) => b.payload) }, [], 0, Number.MAX_SAFE_INTEGER)
    console.error('HYPARQUET_EXPORT ' + JSON.stringify({
      key: first.key,
      rows: first.rows,
      // From the shard's own batches (the tail), not from the file.
      ts_sum: tail.reduce((a, s) => s.ts.reduce((x, v) => (dayOf(v) === first.day ? (x + BigInt(v)) & M64 : x), a), 0n).toString(),
      segment_rows: tail.reduce((a, s) => a + s.ts.filter((v) => dayOf(v) === first.day).length, 0),
      parquet_base64: btoa(b64),
    }))
  })
})

describe('flush is safe to repeat', () => {
  it('two concurrent flushes of every stream leave no duplicate file and identical query results', async () => {
    const w = await world()
    await sendAll(w)
    await sealAll(w)
    const before = { a: (await query(w, w.a)).canon, b: (await query(w, w.b)).canon }

    const runs = await Promise.all(
      [w.a, w.b].flatMap((t) => w.shards.flatMap((s) => [exports.Flush.flushTenant(t.name, s), exports.Flush.flushTenant(t.name, s)])),
    )
    for (const r of runs) expect(r.status).toBe('ok')
    await expectBoth(w, async (t) => {
      await expectLedgerSound(t)
      const keys = await dataKeys(t.name)
      expect(await liveKeys(ledgerOf(t))).toEqual(keys) // nothing orphaned, nothing listed twice
      // One unit per (shard, segment), however many runs reported it.
      const units = await loggedUnits(t.name)
      expect(units.map((u) => u.watermark!.shard).sort()).toEqual([...w.shards].sort())
      for (const u of units) expect(u.unit!.seqLo).toBe(1)
      expect((await query(w, t)).lakeRows).toBe(t.sent.size) // no row is in two listed files
    })
    expect((await query(w, w.a)).canon).toEqual(before.a)
    expect((await query(w, w.b)).canon).toEqual(before.b)
    await expectExact(w)
    // A third run, later, finds nothing to do and changes nothing.
    const versions = await Promise.all((await dataKeys(w.a.name)).map(async (k) => (await env.BUCKET.head(k))!.version))
    for (const r of await flushAll(w)) expect(r).toMatchObject({ status: 'ok', segments: [] })
    expect(await Promise.all((await dataKeys(w.a.name)).map(async (k) => (await env.BUCKET.head(k))!.version))).toEqual(versions)
    for (const s of w.shards) await discardRecorded(shardOf(s))
    await expectExact(w)
  })

  it('converges after a failure between PUT and addUnit, and between addUnit and recorded', async () => {
    const w = await world()
    await sendAll(w)
    await sealAll(w)
    const [s0, s1] = w.shards as [string, string]
    const boom = (at: 'afterPut' | 'afterAddUnit') => ({ hooks: { [at]: (_seg: Segment) => { throw new Error(`injected failure ${at}`) } } })

    // Tenant A, shard 0: the run dies after the objects are written, before the ledger hears of them.
    await expect(flushTenant(env, engine, w.a.name, s0, boom('afterPut'))).rejects.toThrow('injected failure afterPut')
    expect((await dataKeys(w.a.name)).length).toBeGreaterThan(0)
    expect(await liveKeys(ledgerOf(w.a))).toEqual([]) // written but not visible
    // Tenant A, shard 1: the run dies after the ledger admitted the unit, before the shard hears of it.
    await expect(flushTenant(env, engine, w.a.name, s1, boom('afterAddUnit'))).rejects.toThrow('injected failure afterAddUnit')
    expect((await liveKeys(ledgerOf(w.a))).length).toBeGreaterThan(0)
    for (const s of w.shards) expect((await shardOf(s).describe(w.a.name))!.recordedThrough).toBe(0)

    // In that half-done state every query is still exact, with or without the overlapping tail,
    // and tenant B (whose flush never started) is untouched.
    await expectExact(w)
    await expectExact(w, { tailFrom: 'zero' })
    expect(await dataKeys(w.b.name)).toEqual([])

    // The shards must not discard anything yet, whatever their alarms do.
    for (const s of w.shards) await discardRecorded(shardOf(s))
    for (const s of w.shards) expect((await shardOf(s).describe(w.a.name))!.discardedThrough).toBe(0)

    // Re-run everything: it converges, without rewriting an object or adding a second unit.
    const orphanVersions = await Promise.all((await dataKeys(w.a.name)).map(async (k) => (await env.BUCKET.head(k))!.version))
    const keysBefore = await dataKeys(w.a.name)
    for (const r of await flushAll(w)) expect(r).toMatchObject({ status: 'ok', awaitingLog: false })
    expect(await dataKeys(w.a.name)).toEqual(keysBefore)
    expect(await Promise.all(keysBefore.map(async (k) => (await env.BUCKET.head(k))!.version))).toEqual(orphanVersions)
    await expectBoth(w, async (t) => {
      await expectLedgerSound(t)
      expect(await liveKeys(ledgerOf(t))).toEqual(await dataKeys(t.name))
      expect((await loggedUnits(t.name)).length).toBe(2)
      for (const s of w.shards) expect((await shardOf(s).pendingSegments(t.name))).toEqual([])
    })
    await expectExact(w)
    for (const s of w.shards) await discardRecorded(shardOf(s))
    await expectExact(w)
  })

  it('loses nothing when the shard and ledger objects are evicted mid-way, or when a ledger loses its storage', async () => {
    const w = await world()
    await sendAll(w)
    const evictAll = async () => {
      let k = 0
      for (const o of [...w.shards.map(shardOf), ledgerOf(w.a), ledgerOf(w.b)]) await evictDurableObject(o).then(() => k++, () => undefined)
      return k
    }
    expect(await evictAll()).toBeGreaterThanOrEqual(2) // after ingest
    await expectExact(w)
    await sealAll(w)
    expect(await evictAll()).toBeGreaterThanOrEqual(2) // after seal
    await expectExact(w)

    // Evict everything between every two steps of every flush.
    let evictions = 0
    const hooks = { afterPut: async () => { evictions += await evictAll() }, afterAddUnit: async () => { evictions += await evictAll() }, afterRecorded: async () => { evictions += await evictAll() } }
    for (const t of [w.a, w.b]) for (const s of w.shards) expect(await flushTenant(env, engine, t.name, s, { hooks })).toMatchObject({ status: 'ok', awaitingLog: false })
    expect(evictions).toBeGreaterThanOrEqual(8)
    await evictAll()
    await expectExact(w)
    await expectExact(w, { tailFrom: 'zero' })
    await expectBoth(w, (t) => expectLedgerSound(t))

    // More data arrives; tenant A's ledger cannot write its change log, then loses its storage.
    for (const [t, base] of [[w.a, 5000], [w.b, 6000]] as const) expect((await sendPrw(t, prwWorkload(w, t, base, w.now + 1, 3))).status).toBe(204)
    await sealAll(w)
    await breakLedgerLog(ledgerOf(w.a))
    for (const r of await flushAll(w)) expect(r.status).toBe('ok')
    for (const s of w.shards) {
      expect((await shardOf(s).describe(w.a.name))!.recordedThrough).toBeLessThan((await shardOf(s).describe(w.a.name))!.sealedThrough) // A: admitted, not logged, so not recorded
      expect((await shardOf(s).describe(w.b.name))!.recordedThrough).toBe((await shardOf(s).describe(w.b.name))!.sealedThrough) // B is not held back by A's ledger
    }
    for (const s of w.shards) await discardRecorded(shardOf(s))
    await loseLedgerStorage(ledgerOf(w.a)) // comes back from its R2 log: without the unlogged units
    await evictAll()
    await expectExact(w) // the rows are still in the shards
    for (const r of await flushAll(w)) expect(r).toMatchObject({ status: 'ok', awaitingLog: false })
    for (const s of w.shards) await discardRecorded(shardOf(s))
    await evictAll()
    await expectExact(w)
    await expectBoth(w, (t) => expectLedgerSound(t))
  })
})

describe('retries', () => {
  it('a retried Remote Write request, and the same samples batched differently, change no result', async () => {
    const w = await world()
    await sendAll(w)
    const expected = { a: w.a.sent.canon(), b: w.b.sent.canon() }
    const same = async (opts: Parameters<typeof read>[2] = {}) => {
      expect((await query(w, w.a, opts)).canon).toEqual(expected.a)
      expect((await query(w, w.b, opts)).canon).toEqual(expected.b)
      expect(w.a.sent.canon()).toEqual(expected.a) // the retries added no new sample
    }
    const batchesOf = async (t: Tenant) => {
      let k = 0
      for (const s of w.shards) k += (await shardOf(s).describe(t.name))!.nextSeq - 1
      return k
    }
    const first = await batchesOf(w.a)

    // 1. The identical request again: the fingerprint recognises every batch; nothing is stored.
    expect((await sendPrw(w.a, w.a.prw)).status).toBe(204)
    expect(await batchesOf(w.a)).toBe(first)
    await same()

    // 2. The same samples cut into different batches (smaller batch cap, and another series
    //    order): different bytes, different fingerprints, so they ARE stored again…
    expect((await sendPrwWithLimits(w.a, w.a.prw, { maxBatchBytes: 600 })).status).toBe(204)
    expect((await sendPrw(w.a, [...w.a.prw].reverse())).status).toBe(204)
    const stored = await batchesOf(w.a)
    expect(stored).toBeGreaterThan(first + 4)
    // …and invisible in every result: all tail,
    await same()
    expect((await query(w, w.a)).tailRows).toBeGreaterThan(2 * w.a.prw.reduce((n, s) => n + s.samples.length, 0))

    // flushed (the duplicates are removed inside the segment),
    await sealAll(w)
    await flushAll(w)
    await same()
    await same({ tailFrom: 'zero' })
    expect((await query(w, w.a)).lakeRows).toBe(w.a.sent.size)

    // retried again AFTER the flush (duplicates of rows that are now in lake files),
    expect((await sendPrw(w.a, w.a.prw)).status).toBe(204) // same fingerprints: still remembered by the shard
    expect(await batchesOf(w.a)).toBe(stored)
    expect((await sendPrwWithLimits(w.a, w.a.prw, { maxBatchBytes: 900 })).status).toBe(204)
    expect(await batchesOf(w.a)).toBeGreaterThan(stored)
    await same()

    // flushed again (the same rows now sit in two generations of files),
    await sealAll(w)
    await flushAll(w)
    await same()
    const lake = await query(w, w.a)
    expect(lake.lakeRows).toBeGreaterThan(w.a.sent.size) // duplicates across files exist…
    expect(lake.canon).toEqual(expected.a) // …and are not counted

    // and after the shards have discarded everything.
    for (const s of w.shards) await discardRecorded(shardOf(s))
    await same()
    await expectBoth(w, (t) => expectLedgerSound(t))
  })
})
