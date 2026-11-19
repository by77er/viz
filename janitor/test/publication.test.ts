import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { compactStep } from '../../compact/src/compact'
import { engine } from '../../flush/src/index'
import { Sent, T0, append, dataKeys, flushSettled, liveKeys, someSamples, stream } from '../../flush/test/helpers'
import { parseLedgerLogKey } from '../../contracts/ledger'
import { readAvro } from '../../publisher/src/avro'
import type { ManifestEntryRecord, ManifestListRecord, TableMetadata } from '../../publisher/src/iceberg'
import { type JanitorEnv, type PublisherGateNamespace, purgeTenant } from '../src/index'

/**
 * The deletion gate (DESIGN §5.2, §5.3; publisher/README.md "Needed changes" 3): with a
 * publisher bound, the janitor deletes a removed file's object only once the ledger AND the
 * publisher say so, so an Iceberg snapshot a reader may still hold never loses its files.
 * Without one (every other test), the ledger's rules alone, as before.
 */

const QUIET = T0 + 30 * 60_000
const HOUR = 3_600_000
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const exists = async (keys: string[]) => (await Promise.all(keys.map((k) => env.BUCKET.head(k)))).map((o) => o !== null)
let cells = 0

// ── Reading a published table back: the newest metadata, and the live files of one snapshot. ──
const PREFIX = 's3://viz-lake/'
const keyOf = (uri: string) => (uri.startsWith(PREFIX) ? uri.slice(PREFIX.length) : uri)
async function readMetadata(cell: string, table: string): Promise<TableMetadata> {
  const dir = `${cell}/iceberg/${table}/metadata/`
  const versions = (await env.BUCKET.list({ prefix: dir })).objects.map((o) => /\/v(\d+)\.metadata\.json$/.exec(o.key)?.[1]).filter((v) => v !== undefined).map(Number)
  return (await env.BUCKET.get(`${dir}v${Math.max(...versions)}.metadata.json`))!.json<TableMetadata>()
}
const avro = async <T>(key: string): Promise<T[]> => (await readAvro<T>(new Uint8Array(await (await env.BUCKET.get(key))!.arrayBuffer()))).records
/** Keys of the data files a snapshot (default: the current one) lists as ADDED or EXISTING. */
async function icebergLive(cell: string, table: string, snapshotId?: number): Promise<string[]> {
  const meta = await readMetadata(cell, table)
  const snap = meta.snapshots.find((x) => x['snapshot-id'] === (snapshotId ?? meta['current-snapshot-id']))!
  const out: string[] = []
  for (const m of await avro<ManifestListRecord>(keyOf(snap['manifest-list']))) {
    for (const e of await avro<ManifestEntryRecord>(keyOf(m.manifest_path))) if (e.status !== 2) out.push(keyOf(e.data_file.file_path))
  }
  return out.sort()
}
/** Copy a tenant's ledger log (written under env.CELL) under another cell, byte for byte. */
async function mirror(tenant: string, cell: string): Promise<void> {
  await env.LEDGER.get(env.LEDGER.idFromName(tenant)).drain()
  const from = `${env.CELL}/ledger/tenant=${tenant}/`
  for (const o of (await env.BUCKET.list({ prefix: from })).objects) {
    if (!parseLedgerLogKey(o.key)) continue
    await env.BUCKET.put(`${cell}/ledger/tenant=${tenant}/${o.key.slice(from.length)}`, await (await env.BUCKET.get(o.key))!.arrayBuffer())
  }
}

/** A tenant with `n` flushed units, and a cell of its own whose publisher reads a copy of the tenant's log. */
async function setup(prefix: string, n: number) {
  const s = stream(prefix)
  const sent = new Sent()
  for (let i = 0; i < n; i++) {
    await append(s.shard, s.tenant, someSamples(s.tenant, T0 + i * 60_000, 24, i), sent)
    await s.shard.seal(s.tenant)
  }
  expect(await flushSettled(env, engine, s.tenant, s.shardName)).toMatchObject({ status: 'ok', awaitingLog: false })
  // The ledger writes its log under env.CELL; each test's publisher reads a copy under a cell of
  // its own (as publisher/'s tests do), so tests do not share Iceberg tables.
  const cell = `gate${Date.now().toString(36)}${cells++}`
  const publisher = env.TEST_PUBLISHER.get(env.TEST_PUBLISHER.idFromName(cell))
  const gated: JanitorEnv = { ...env, CELL: cell, PUBLISHER: env.TEST_PUBLISHER }
  const publish = async () => {
    await mirror(s.tenant, cell)
    return publisher.publish([s.tenant])
  }
  return { ...s, sent, cell, publisher, gated, publish }
}

/** A stand-in publisher: answers `safeToDelete` with `released`, or throws, or never answers; records acknowledgements. */
function fakePublisher(behaviour: { released?: string[]; fail?: string; hang?: boolean }) {
  const calls = { safeToDelete: 0, acknowledged: [] as string[] }
  const ns: PublisherGateNamespace = {
    idFromName: (name: string) => ({ name, toString: () => name, equals: () => false }) as unknown as DurableObjectId,
    get: () => ({
      async safeToDelete() {
        calls.safeToDelete++
        if (behaviour.fail) throw new Error(behaviour.fail)
        if (behaviour.hang) await new Promise(() => {})
        return behaviour.released ?? []
      },
      async acknowledgeDeleted(_tenant: string, keys: string[]) {
        calls.acknowledged.push(...keys)
      },
    }),
  }
  return { ns, calls }
}

describe('deletion waits for publication (a publisher is bound)', () => {
  it('a removed file is deleted only once its removal is published, no retained snapshot references it, and the publisher\'s grace has passed', async () => {
    const t = await setup('gate1', 5)
    const p1 = await t.publish()
    expect(p1.tables.metric_samples.added).toBe(5)
    const s1 = (await readMetadata(t.cell, 'metric_samples'))['current-snapshot-id'] as number
    const before = await liveKeys(t.ledger)
    expect(before).toHaveLength(10)

    // Compaction replaces every published file; the ledger's own rules (logged, its grace) pass.
    expect((await compactStep(env, engine, t.tenant, { now: QUIET })).status).toBe('merged')
    await t.ledger.drain()
    await sleep(120)
    const live = await liveKeys(t.ledger)
    const old = before.filter((k) => !live.includes(k))
    expect(old).toHaveLength(10)
    // Without a publisher these would go now (the ledger alone):
    expect((await t.ledger.deletable({ minAgeMs: 100 })).tombstones.map((x) => x.key).sort()).toEqual(old.sort())

    // 1. The removal is not published yet: nothing is deleted.
    expect(await purgeTenant(t.gated, t.tenant, { graceMs: 100 })).toEqual({ deleted: [], waiting: 10, unpublished: 10 })
    expect(await exists(old)).toEqual(old.map(() => true))

    // 2. Published (snapshot 2 lists them as DELETED), but snapshot 1 is retained and references them.
    await t.publish()
    expect((await icebergLive(t.cell, 'metric_samples')).some((k) => old.includes(k))).toBe(false)
    expect(await purgeTenant(t.gated, t.tenant, { graceMs: 100 })).toEqual({ deleted: [], waiting: 10, unpublished: 10 })
    // A reader holding snapshot 1 still finds every file it names.
    const heldBy1 = await icebergLive(t.cell, 'metric_samples', s1)
    expect(heldBy1.length).toBe(5)
    expect(await exists(heldBy1)).toEqual(heldBy1.map(() => true))

    // 3. A day later another commit expires snapshot 1; the publisher's own grace (1 h) has not passed.
    await t.publisher.advanceClock(25 * HOUR)
    await append(t.shard, t.tenant, someSamples(t.tenant, T0 + 3_600_000, 24, 99), t.sent)
    await t.shard.seal(t.tenant)
    expect(await flushSettled(env, engine, t.tenant, t.shardName)).toMatchObject({ status: 'ok' })
    await t.publish()
    const meta = await readMetadata(t.cell, 'metric_samples')
    expect(meta.snapshots.map((x) => x['snapshot-id'])).not.toContain(s1)
    expect(await purgeTenant(t.gated, t.tenant, { graceMs: 100 })).toEqual({ deleted: [], waiting: 10, unpublished: 10 })
    expect(await exists(old)).toEqual(old.map(() => true))

    // 4. After the publisher's grace: exactly those ten go, the ledger forgets them, the publisher too.
    await t.publisher.advanceClock(2 * HOUR)
    expect((await t.publisher.safeToDelete(t.tenant)).sort()).toEqual(old.sort())
    const purged = await purgeTenant(t.gated, t.tenant, { graceMs: 100 })
    expect(purged.deleted.sort()).toEqual(old.sort())
    expect(purged).toMatchObject({ waiting: 0, unpublished: 0 })
    expect(await exists(old)).toEqual(old.map(() => false))
    expect(await t.ledger.removedSince(0)).toEqual([])
    expect(await t.publisher.safeToDelete(t.tenant)).toEqual([])
    // Nothing live was touched, and every file of every retained snapshot is still there.
    expect(await dataKeys(t.tenant)).toEqual(await liveKeys(t.ledger))
    for (const snap of meta.snapshots) {
      const keys = await icebergLive(t.cell, 'metric_samples', snap['snapshot-id'])
      expect(await exists(keys)).toEqual(keys.map(() => true))
    }
  })

  it('deletes only what both say: a key the publisher releases that the ledger does not call deletable stays', async () => {
    const t = await setup('gate2', 4)
    expect((await compactStep(env, engine, t.tenant, { now: QUIET })).status).toBe('merged')
    await t.ledger.drain()
    await sleep(120)
    const tombs = (await t.ledger.deletable({ minAgeMs: 100 })).tombstones.map((x) => x.key)
    const live = await liveKeys(t.ledger)
    expect(tombs).toHaveLength(8)
    // The publisher (wrongly, or about another state of the ledger) releases half the tombstones,
    // a live file and a key the ledger never had.
    const fake = fakePublisher({ released: [...tombs.slice(0, 4), live[0]!, `cell-0/data/metric_samples/tenant=${t.tenant}/day=2026-11-18/L0-x-1-1-1-00000000.parquet`] })
    const r = await purgeTenant({ ...env, PUBLISHER: fake.ns }, t.tenant, { graceMs: 100 })
    expect(r.deleted.sort()).toEqual(tombs.slice(0, 4).sort())
    expect(r).toMatchObject({ waiting: 4, unpublished: 4 })
    expect(await exists(live)).toEqual(live.map(() => true))
    expect(await exists(tombs)).toEqual([false, false, false, false, true, true, true, true])
    // What was deleted is acknowledged; the key the ledger never had is acknowledged too (nothing
    // to delete, nothing live or tombstoned), so the publisher forgets it; the live one is not.
    expect(fake.calls.acknowledged.sort()).toEqual([...tombs.slice(0, 4), `cell-0/data/metric_samples/tenant=${t.tenant}/day=2026-11-18/L0-x-1-1-1-00000000.parquet`].sort())
  })

  it('keys the publisher holds back at the head of the ledger\'s answer do not starve the released ones behind them', async () => {
    const t = await setup('gate4', 4)
    expect((await compactStep(env, engine, t.tenant, { now: QUIET })).status).toBe('merged')
    await t.ledger.drain()
    await sleep(120)
    // The ledger's order: lowest version first (here all one change), then key.
    const tombs = (await t.ledger.deletable({ minAgeMs: 100 })).tombstones.map((x) => x.key)
    expect(tombs).toHaveLength(8)
    const released = tombs.slice(4)
    const fake = fakePublisher({ released })
    // Two at a time: the first read (two keys) is all held back; the run must look further.
    const first = await purgeTenant({ ...env, PUBLISHER: fake.ns }, t.tenant, { graceMs: 100, maxKeys: 2 })
    expect(first.deleted).toHaveLength(2)
    expect(released).toEqual(expect.arrayContaining(first.deleted))
    const second = await purgeTenant({ ...env, PUBLISHER: fake.ns }, t.tenant, { graceMs: 100, maxKeys: 2 })
    expect([...first.deleted, ...second.deleted].sort()).toEqual([...released].sort())
    const third = await purgeTenant({ ...env, PUBLISHER: fake.ns }, t.tenant, { graceMs: 100, maxKeys: 2 })
    expect(third).toMatchObject({ deleted: [], waiting: 4, unpublished: 4 })
    expect(await exists(tombs)).toEqual([true, true, true, true, false, false, false, false])
  })

  it('a publisher that refuses or does not answer: nothing is deleted, the run returns within its bound and says why', async () => {
    const t = await setup('gate3', 3)
    await compactStep(env, engine, t.tenant, { now: QUIET })
    await t.ledger.drain()
    await sleep(120)
    const tombs = (await t.ledger.deletable({ minAgeMs: 100 })).tombstones.map((x) => x.key)
    expect(tombs.length).toBeGreaterThan(0)
    for (const behaviour of [{ fail: 'schema_too_new: publisher.Publisher storage is at version 9' }, { hang: true }]) {
      const fake = fakePublisher({ ...behaviour, released: tombs })
      const started = Date.now()
      const r = await purgeTenant({ ...env, PUBLISHER: fake.ns }, t.tenant, { graceMs: 100, publisherTimeoutMs: 300 })
      expect(Date.now() - started).toBeLessThan(5_000)
      expect(r.deleted).toEqual([])
      expect(r.waiting).toBe(tombs.length)
      expect(r.publisher).toMatch(behaviour.hang ? /did not answer within 300 ms/ : /schema_too_new/)
      expect(fake.calls.acknowledged).toEqual([])
    }
    expect(await exists(tombs)).toEqual(tombs.map(() => true))
    // Unbound: today's behaviour, the ledger alone.
    expect((await purgeTenant(env, t.tenant, { graceMs: 100 })).deleted.sort()).toEqual(tombs.sort())
  })
})
