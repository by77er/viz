/**
 * The publisher across releases (contracts/COMPATIBILITY.md §2, §3, §5):
 *
 *   - its SQLite storage is versioned like every Durable Object's: pinned per version,
 *     adopted from the pre-versioning code, refused (and not written) when newer than this
 *     code may read, served when a newer release declared it readable;
 *   - it never commits, rebuilds from, or sweeps against Iceberg metadata (or a cursors
 *     object) written by a newer publisher;
 *   - it never applies, and never skips, a ledger change of a version or kind it does not know.
 *
 * "A newer release" is the shared runner with one more migration, run on the object's storage
 * before the object is evicted; or metadata in R2 that a newer publisher would have written.
 */
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import {
  LEDGER_CHANGE_KINDS,
  LEDGER_CHANGE_VERSION as CONTRACT_CHANGE_VERSION,
  LEDGER_CHECKPOINT_KIND,
  LEDGER_CHECKPOINT_VERSION as CONTRACT_CHECKPOINT_VERSION,
  LEDGER_SEGMENT_KIND,
  LEDGER_SEGMENT_VERSION as CONTRACT_SEGMENT_VERSION,
  ledgerLogKey,
} from '../../contracts/ledger'
import { describeSchema, type Migration, openSchema, schemaRelease, type SchemaSpec } from '../../contracts/schema'
import { LEDGER_CHANGE_VERSION, LEDGER_CHECKPOINT_VERSION, LEDGER_SEGMENT_VERSION, unsupported, unsupportedSegment } from '../src/log'
import { FORMATS, PUBLISHER_SCHEMA } from '../src/schema'
import { expectGolden, goldenDir } from './golden'
import { addUnit, copyLog, dropCheckpoints, fresh, icebergLive, ledgerVersion, listKeys, metaDir, metadataVersions, mirror, pairUnit, publisher, putObjects, readMetadata, segmentsOf, T0, DAY_MS, TABLES } from './helpers'
import v0 from './fixtures/storage/v0.json'
import { type Dump, dumpOf, install, replaceWith, schemaRow, withoutVersion } from './storage'

const V0 = v0 as unknown as Dump & { cell: string; tenant: string }
const LATEST = PUBLISHER_SCHEMA.migrations.length
const norm = (sql: string) => sql.replace(/\s+/g, ' ').trim()
/** `TestPublisher` adds a clock table of its own; it is not the publisher's schema. */
const own = (schema: { name: string }[]) => schema.filter((s) => s.name !== 'test_clock')
const ownDump = (d: Dump): Dump => ({ schema: own(d.schema) as Dump['schema'], rows: Object.fromEntries(Object.entries(d.rows).filter(([t]) => t !== 'test_clock')) })
const plus = (m: Omit<Migration, 'version'>): SchemaSpec => ({ ...PUBLISHER_SCHEMA, migrations: [...PUBLISHER_SCHEMA.migrations, { ...m, version: LATEST + 1 }] })
function canon(rows: Record<string, Record<string, unknown>[]>): Record<string, string[]> {
  const one = (r: Record<string, unknown>) => JSON.stringify(Object.fromEntries(Object.entries(r).sort(([a], [b]) => (a < b ? -1 : 1))))
  return Object.fromEntries(Object.entries(rows).map(([t, rs]) => [t, rs.map(one).sort()]))
}

/** A cell with one tenant, two units, published once. */
async function published() {
  const { cell, tenant } = fresh()
  const t = tenant('acme')
  await addUnit(t, pairUnit(cell, t, 1, 4))
  await addUnit(t, pairUnit(cell, t, 5, 9))
  await mirror(t, cell)
  const p = publisher(cell)
  const r = await p.publish([t])
  expect(r.tenants[0]!.status).toBe('ok')
  return { cell, t, p }
}

describe('versioned storage', () => {
  it('a fresh publisher is at the latest version, and its schema is the golden file', async () => {
    const p = publisher(fresh().cell)
    expect(await p.pending()).toEqual([])
    const { row, schema } = await runInDurableObject(p, (_i, s) => ({ row: schemaRow(s), schema: own(describeSchema(s.storage.sql)) }))
    expect(row).toMatchObject({ component: 'publisher.Publisher', version: LATEST, compat: schemaRelease(PUBLISHER_SCHEMA).compat })
    expectGolden(`schema/publisher.v${LATEST}.json`, { version: LATEST, schema })
  })

  it('migrations 1..N on empty storage give the golden schema of N, and version 1 is the pre-versioning schema', async () => {
    const files = goldenDir('schema')
    for (let v = 1; v <= LATEST; v++) {
      const p = publisher(fresh().cell)
      await p.pending()
      const schema = await runInDurableObject(p, (_i, s) => {
        replaceWith(s, { schema: [], rows: {} })
        openSchema(s.storage, { ...PUBLISHER_SCHEMA, migrations: PUBLISHER_SCHEMA.migrations.slice(0, v) })
        return describeSchema(s.storage.sql)
      })
      expect({ version: v, schema }).toEqual(files[`publisher.v${v}.json`])
    }
    const v1 = (files['publisher.v1.json'] as { schema: { name: string; type: string; sql: string }[] }).schema.filter((s) => s.name !== 'viz_schema')
    expect(v1).toEqual(V0.schema.map((s) => ({ type: s.type, name: s.name, sql: norm(s.sql) })))
  })

  it('adopts storage written by the pre-versioning code (checked-in dump) as version 1, migrates it to the latest without changing a row, and serves it', async () => {
    const p = publisher(V0.cell)
    await p.pending()
    await install(p, V0)
    expect(await p.cursors('metric_samples')).toEqual({ [V0.tenant]: expect.objectContaining({ ledgerIncarnation: expect.any(Number) }) })
    const st = await p.status('metric_samples')
    expect(st.files).toBe(V0.rows.live!.filter((r) => r.tbl === 'metric_samples').length)
    const after = await runInDurableObject(p, (_i, s) => ({ row: schemaRow(s), dump: withoutVersion(ownDump(dumpOf(s))) }))
    // Every migration after 1 is additive (readableFrom 1): `compat` stays 1.
    expect(after.row).toMatchObject({ version: LATEST, compat: 1 })
    // Version 2 added the `due` table, version 3 `stage` and `live_next`, version 4 `unpublished`, version 5 `signal_due` and `signal_orphan`, version 6 `rebase`, version 7 the re-bases and rebuilds in steps, all empty; every row of the adopted tables is as it was.
    const added = ['due', 'stage', 'live_next', 'unpublished', 'signal_due', 'signal_orphan', 'rebase', 'rebase_stage', 'rebase_step', 'rebase_manifest', 'rebuild', 'rebuild_manifest']
    for (const t of added) expect(after.dump.rows[t], t).toEqual([])
    const adopted = Object.fromEntries(Object.entries(after.dump.rows).filter(([t]) => !added.includes(t)))
    expect(canon(adopted)).toEqual(canon(V0.rows))
  })

  it('storage at golden version 1 is migrated to the latest, keeps publishing, survives eviction and is not migrated twice', async () => {
    const { cell, t, p } = await published()
    // What release 1 left: no `due` table, the version row at 1.
    await runInDurableObject(p, (_i, s) => {
      s.storage.sql.exec('DROP TABLE due')
      s.storage.sql.exec('UPDATE viz_schema SET version = 1, compat = 1')
    })
    await evictDurableObject(p)
    await addUnit(t, pairUnit(cell, t, 10, 12, T0 + DAY_MS))
    await mirror(t, cell)
    expect((await p.publish([t])).tenants[0]!.status).toBe('ok')
    for (const table of TABLES) expect((await p.verify(table)).ok, table).toBe(true)
    const row = await runInDurableObject(p, (_i, s) => schemaRow(s))
    expect(row).toMatchObject({ version: LATEST, compat: 1 })
    expect((await p.schedule()).due.sweep).toBeDefined() // the new table is used at once
    await evictDurableObject(p)
    expect(await runInDurableObject(p, (_i, s) => ({ row: schemaRow(s), reopen: openSchema(s.storage, PUBLISHER_SCHEMA) }))).toMatchObject({ row, reopen: { migrated: [] } })
  })

  it('a publisher made by the pre-versioning code keeps publishing after adoption, survives eviction, and verifies clean', async () => {
    const { cell, t, p } = await published()
    // What the pre-versioning code left: the tables of version 1, no version row.
    await runInDurableObject(p, (_i, s) => {
      s.storage.sql.exec('DROP TABLE viz_schema')
      s.storage.sql.exec('DROP TABLE due')
    })
    await evictDurableObject(p)
    await addUnit(t, pairUnit(cell, t, 10, 12, T0 + DAY_MS))
    await mirror(t, cell)
    expect((await p.publish([t])).tenants[0]!.status).toBe('ok')
    for (const table of TABLES) expect((await p.verify(table)).ok, table).toBe(true)
    const row = await runInDurableObject(p, (_i, s) => schemaRow(s))
    expect(row).toMatchObject({ version: LATEST })
    await evictDurableObject(p)
    expect(await runInDurableObject(p, (_i, s) => ({ row: schemaRow(s), reopen: openSchema(s.storage, PUBLISHER_SCHEMA) }))).toMatchObject({ row, reopen: { migrated: [] } })
  })

  it('refuses storage a newer release migrated past what it knows: every method throws schema_too_new, the alarm is re-armed, nothing written', async () => {
    const { t, p } = await published()
    // Work is due when the newer release takes over: a nudged tenant and its publish deadline.
    // A refusing alarm must leave both as they are (it would otherwise publish and clear them).
    await p.notify([t])
    expect(await p.schedule()).toMatchObject({ due: { publish: expect.any(Number) } })
    const before = await runInDurableObject(p, async (_i, s) => {
      expect(openSchema(s.storage, plus({ name: 'breaking (simulated N+1)', readableFrom: LATEST + 1, up: (sql) => void sql.exec('CREATE TABLE future (x TEXT NOT NULL)') }))).toMatchObject({ version: LATEST + 1 })
      await s.storage.setAlarm(Date.now() + 3_600_000)
      return dumpOf(s)
    })
    await evictDurableObject(p)
    const calls: [string, () => Promise<unknown>][] = [
      ['publish', () => p.publish([t])],
      ['notify', () => p.notify([t])],
      ['pending', () => p.pending()],
      ['cursors', () => p.cursors('metric_samples')],
      ['status', () => p.status('metric_samples')],
      ['unpublished', () => p.unpublished()],
      ['maintain', () => p.maintain()],
      ['sweep', () => p.sweep()],
      ['safeToDelete', () => p.safeToDelete(t)],
      ['acknowledgeDeleted', () => p.acknowledgeDeleted(t, [])],
      ['verify', () => p.verify('metric_samples')],
      ['configure', () => p.configure({ retryMs: 1 })],
    ]
    for (const [name, call] of calls) expect(await call().then(() => 'answered', (e: Error) => e.message), name).toMatch(/^schema_too_new: publisher\.Publisher/)
    const t0 = Date.now()
    expect(await runDurableObjectAlarm(p)).toBe(true)
    const after = await runInDurableObject(p, async (_i, s) => ({ dump: dumpOf(s), alarm: await s.storage.getAlarm() }))
    expect(after.dump).toEqual(before)
    expect(after.alarm).toBeGreaterThanOrEqual(t0 + 25_000)
  })

  it('serves newer storage that declares itself readable by this release, and leaves its version alone', async () => {
    const { cell, t, p } = await published()
    const next = plus({ name: 'additive (simulated N+1): a nullable column', readableFrom: LATEST, up: (sql) => void sql.exec('ALTER TABLE live ADD COLUMN content_hash TEXT') })
    await runInDurableObject(p, (_i, s) => void openSchema(s.storage, next))
    await evictDurableObject(p)
    await addUnit(t, pairUnit(cell, t, 10, 12, T0 + DAY_MS))
    await mirror(t, cell)
    expect((await p.publish([t])).tenants[0]!.status).toBe('ok')
    const seen = await runInDurableObject(p, (_i, s) => ({ row: schemaRow(s), nulls: s.storage.sql.exec('SELECT COUNT(*) AS n FROM live WHERE content_hash IS NULL').one().n }))
    expect(seen.row).toMatchObject({ version: LATEST + 1, compat: LATEST })
    expect(seen.nulls).toBeGreaterThan(0)
  })
})

describe('Iceberg metadata written by a newer publisher', () => {
  it('is never committed over, rebuilt from or swept against; publication waits and nothing in R2 changes', async () => {
    const { cell, t, p } = await published()
    const table = 'metric_samples'
    const n = (await metadataVersions(cell, table)).at(-1)!
    // A newer publisher evolved the table: a column with a new field id, as schema 1, and says so.
    const meta = await readMetadata(cell, table, n)
    const evolved = structuredClone(meta) as typeof meta & { schemas: { 'schema-id': number; fields: unknown[] }[] }
    evolved.schemas.push({ ...evolved.schemas[0]!, 'schema-id': 1, fields: [...evolved.schemas[0]!.fields, { id: meta['last-column-id'] + 1, name: 'exemplar', required: false, type: 'string' }] })
    evolved['current-schema-id'] = 1
    evolved['last-column-id'] = meta['last-column-id'] + 1
    evolved.properties = { ...evolved.properties, 'viz.format-version': '2' }
    await env.BUCKET.put(`${metaDir(cell, table)}v${n + 1}.metadata.json`, JSON.stringify(evolved))
    await env.BUCKET.put(`${metaDir(cell, table)}version-hint.text`, String(n + 1))
    const before = await listKeys(`${cell}/iceberg/`)
    // Its own view of the table is not rebuilt from metadata it does not understand either
    // (only the pending tenants and their retry deadline may change).
    const cache = (d: Dump) => ({ ...d, rows: Object.fromEntries(Object.entries(d.rows).filter(([k]) => k !== 'pending' && k !== 'due')) })
    const cacheBefore = await runInDurableObject(p, (_i, s) => cache(dumpOf(s)))

    await addUnit(t, pairUnit(cell, t, 10, 12, T0 + DAY_MS))
    await mirror(t, cell)
    expect(await p.publish([t]).then(() => 'committed', (e: Error) => e.message)).toMatch(/^metadata_too_new: .*v\d+\.metadata\.json: viz\.format-version 2/)
    expect(await p.pending(), 'the tenant waits for a publisher that understands the table').toEqual([t])
    expect(await p.sweep().then(() => 'swept', (e: Error) => e.message)).toMatch(/^metadata_too_new/)
    expect(await listKeys(`${cell}/iceberg/`)).toEqual(before)
    expect(await runInDurableObject(p, (_i, s) => cache(dumpOf(s)))).toEqual(cacheBefore)
    const verify = await p.verify(table)
    expect(verify.ok).toBe(false)
    expect(verify.problems.join('\n')).toMatch(/newer publisher/)
  })

  it('after a lost storage, a table a newer publisher evolved is not rebuilt from it (rebuilt in steps since storage version 7); publication waits', async () => {
    const { cell, t } = await published()
    const table = 'metric_samples'
    const n = (await metadataVersions(cell, table)).at(-1)!
    const meta = await readMetadata(cell, table, n)
    const evolved = { ...structuredClone(meta), properties: { ...meta.properties, 'viz.format-version': '2' } }
    await env.BUCKET.put(`${metaDir(cell, table)}v${n + 1}.metadata.json`, JSON.stringify(evolved))
    await env.BUCKET.put(`${metaDir(cell, table)}version-hint.text`, String(n + 1))
    const before = await listKeys(`${cell}/iceberg/`)
    // A publisher of the same cell with nothing in its storage: the rebuild from R2 comes first.
    const lost = publisher(`${cell}~lost`)
    expect(await lost.publish([t]).then(() => 'published', (e: Error) => e.message)).toMatch(/^metadata_too_new: .*v\d+\.metadata\.json: viz\.format-version 2/)
    expect(await lost.pending()).toEqual([t])
    const rows = await runInDurableObject(lost, (_i, s) => ({
      live: s.storage.sql.exec(`SELECT COUNT(*) AS n FROM live`).one().n,
      rebuild: s.storage.sql.exec(`SELECT COUNT(*) AS n FROM rebuild`).one().n,
      tbl: s.storage.sql.exec(`SELECT COUNT(*) AS n FROM tbl`).one().n,
    }))
    expect(rows).toEqual({ live: 0, rebuild: 0, tbl: 0 })
    expect(await listKeys(`${cell}/iceberg/`)).toEqual(before)
  })
})

describe('ledger log objects this code does not know (COMPATIBILITY.md §3.2, §8.7)', () => {
  /** A tenant whose units are one segment each: [0,0] base, [1,2] registration and unit 1, [3,3], [4,4], [5,5]. */
  async function logged() {
    const { cell, tenant } = fresh()
    const t = tenant('acme')
    for (let i = 0; i < 4; i++) await addUnit(t, pairUnit(cell, t, 1 + 3 * i, 3 + 3 * i, T0 + i * 1000), { drain: true })
    await mirror(t, cell)
    // About segments: a re-base from a checkpoint would start past the one rewritten below.
    await dropCheckpoints(cell, t)
    const { ledgerIncarnation, version } = await ledgerVersion(t)
    const seg = (await segmentsOf(cell, t, ledgerIncarnation)).find((s) => s.first === version - 1)!
    expect(seg).toMatchObject({ first: version - 1, last: version - 1 })
    const body = await (await env.BUCKET.get(seg.key))!.text()
    return { cell, t, ledgerIncarnation, version, seg, body }
  }

  type Rewrite = (header: Record<string, unknown>, change: Record<string, unknown> & { added: Record<string, unknown>[] }) => void
  const newer: [string, Rewrite, RegExp][] = [
    ['a segment header of version 2', (h) => void (h.v = 2), /segment version 2/],
    ['a header of an unknown kind', (h) => void (h.kind = 'viz.ledger.segment-v2'), /unknown log object kind/],
    ['a change of version 2', (_h, c) => void (c.v = 2), /change version 2/],
    ['a change of an unknown kind', (_h, c) => void (c.kind = 'truncate'), /unknown change kind/],
    // Not `spans`, `trace_index` or `logs`: this publisher reads those (test/signals.test.ts). A table no release knows.
    ['a file of a table this code does not know', (_h, c) => void (c.added[0]!.table = 'profiles'), /table "profiles"/],
  ]
  for (const [what, rewrite, reason] of newer) {
    it(`${what} stops the tenant before that segment: the segments before it are published, nothing after, and it is retried until readable`, async () => {
      const { cell, t, ledgerIncarnation, version, seg, body } = await logged()
      const [h, c] = body.split('\n') as [string, string]
      const header = JSON.parse(h) as Record<string, unknown>
      const change = JSON.parse(c) as Parameters<Rewrite>[1]
      rewrite(header, change)
      await env.BUCKET.put(seg.key, `${JSON.stringify(header)}\n${JSON.stringify(change)}\n`)
      const p = publisher(cell)
      for (let attempt = 0; attempt < 2; attempt++) {
        const r = (await p.publish([t])).tenants[0]!
        expect(r).toMatchObject({ status: 'unsupported', gapAt: version - 1, cursors: { metric_samples: { ledgerIncarnation, version: version - 2 }, metric_series: { ledgerIncarnation, version: version - 2 } } })
        expect(r.detail).toMatch(reason)
        expect(await p.pending(), 'the tenant waits for a publisher that reads it').toEqual([t])
        expect((await p.schedule()).due.publish).toBeDefined()
      }
      // Never skipped: the next segment is readable, yet nothing of it is published.
      expect(await icebergLive(cell, 'metric_samples')).toHaveLength(2)
      // Once a reader that knows it is back (here: the segment restored), it continues.
      await env.BUCKET.put(seg.key, body)
      expect((await p.publish([t])).tenants[0]).toMatchObject({ status: 'ok', cursors: { metric_samples: { version } } })
      expect(await icebergLive(cell, 'metric_samples')).toHaveLength(4)
      expect(await p.pending()).toEqual([])
    })
  }

  it('in the first layout too: a change object of a newer version stops the tenant before it', async () => {
    const { cell, tenant } = fresh()
    const t = tenant('trial')
    const old = env.LEDGER_ASBUILT.get(env.LEDGER_ASBUILT.idFromName(t))
    for (let i = 0; i < 3; i++) {
      const u = pairUnit(cell, t, 1 + i, 1 + i, T0 + i * 1000)
      await putObjects(u.files)
      expect(await old.addUnit(u)).toMatchObject({ status: 'ok' })
    }
    await copyLog(t, env.CELL, cell)
    const version = (await old.plan({ table: 'metric_samples', minTs: 0, maxTs: 0 })).version
    const key = `${cell}/${ledgerLogKey(t, 1, version - 1)}`
    const change = await (await env.BUCKET.get(key))!.json<Record<string, unknown>>()
    await env.BUCKET.put(key, JSON.stringify({ ...change, v: 2 }))
    const p = publisher(cell)
    expect((await p.publish([t])).tenants[0]).toMatchObject({ status: 'unsupported', gapAt: version - 1, cursors: { metric_samples: { ledgerIncarnation: 1, version: version - 2 } } })
    await env.BUCKET.put(key, JSON.stringify(change))
    expect((await p.publish([t])).tenants[0]).toMatchObject({ status: 'ok', cursors: { metric_samples: { version } } })
  })

  it('what the reader accepts, and that it reads exactly what the contract writes (a version bump there fails here until this reader is taught it)', () => {
    expect(unsupported({ kind: 'add_unit' })).toBeNull()
    expect(unsupported({ v: 1, kind: 'base' })).toBeNull()
    expect(unsupported({ v: 2, kind: 'add_unit' })).toMatch(/version 2/)
    expect(unsupported({ kind: 'checkpoint' })).toMatch(/unknown change kind/)
    expect(unsupported({ v: '1', kind: 'add_unit' })).toMatch(/unreadable/)
    expect(unsupportedSegment({ v: 1, kind: LEDGER_SEGMENT_KIND })).toBeNull()
    expect(unsupportedSegment({ v: 2, kind: LEDGER_SEGMENT_KIND })).toMatch(/segment version 2/)
    expect(unsupportedSegment({ v: 1, kind: LEDGER_CHECKPOINT_KIND })).toMatch(/unknown log object kind/)
    expect(unsupportedSegment({ kind: LEDGER_SEGMENT_KIND })).toMatch(/unreadable/)
    expect(LEDGER_SEGMENT_VERSION).toBe(CONTRACT_SEGMENT_VERSION)
    expect(LEDGER_CHANGE_VERSION).toBe(CONTRACT_CHANGE_VERSION)
    // Checkpoints this reader re-bases from: a newer format is passed over for the base
    // (test/checkpoints.test.ts), but a bump in the contract still shows here.
    expect(LEDGER_CHECKPOINT_VERSION).toBe(CONTRACT_CHECKPOINT_VERSION)
    for (const kind of LEDGER_CHANGE_KINDS) expect(unsupported({ kind }), kind).toBeNull()
    expect(FORMATS['read.ledger-segment']).toBe(LEDGER_SEGMENT_VERSION)
    expect(FORMATS['read.ledger-change']).toBe(LEDGER_CHANGE_VERSION)
  })
})
