/**
 * Versioned storage and formats (contracts/COMPATIBILITY.md §2, §3, §8), on the real `Ledger`:
 *
 *   - the schema of every released version is pinned (golden file), and version 1 is exactly
 *     what the code before versioning created;
 *   - storage made by that code (dc2a1c3, and an object from before file precedence) is
 *     adopted as version 1 without a row of its live set changing, and serves;
 *   - storage a newer release migrated past what this code may read is refused on every
 *     entry point, the alarm is re-armed, and nothing is written;
 *   - storage a newer release declared readable is served and left at its version;
 *   - the segment and checkpoint formats are pinned by golden files made by the real code.
 */
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { LEDGER_SEGMENT_VERSION, ledgerSegmentKey } from '../../contracts/ledger'
import { describeSchema, type Migration, openSchema, schemaRelease, type SchemaSpec } from '../../contracts/schema'
import { LEDGER_SCHEMA, type Ledger } from '../src/ledger'
import { expectGolden, goldenDir } from './golden'
import { INC, S, T0, dayOf, everything, listAll, logPrefix, open, pair, readSegments, type Stub } from './helpers'

const LATEST = LEDGER_SCHEMA.migrations.length
const norm = (sql: string) => sql.replace(/\s+/g, ' ').trim()

/** `schema()` of the ledger before versioning (ledger/bench/asbuilt/ledger.ts, commit dc2a1c3), verbatim. */
const DDL_DC2A1C3 = [
  `CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS file (
      key TEXT PRIMARY KEY, tbl TEXT NOT NULL, day TEXT NOT NULL, bytes INTEGER NOT NULL, rows INTEGER NOT NULL,
      min_ts INTEGER NOT NULL, max_ts INTEGER NOT NULL, level INTEGER NOT NULL, idx TEXT NOT NULL,
      u_shard TEXT, u_inc INTEGER, u_lo INTEGER, u_hi INTEGER,
      prec INTEGER NOT NULL, prec_lo INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS file_tbl_day ON file (tbl, day)`,
  `CREATE INDEX IF NOT EXISTS file_tbl_max ON file (tbl, max_ts)`,
  `CREATE TABLE IF NOT EXISTS stream (
      shard TEXT PRIMARY KEY, incarnation INTEGER NOT NULL, watermark INTEGER NOT NULL,
      logged INTEGER NOT NULL, prev_incarnation INTEGER)`,
  `CREATE TABLE IF NOT EXISTS outbox (version INTEGER PRIMARY KEY, body TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS tombstone (key TEXT PRIMARY KEY, tbl TEXT NOT NULL, version INTEGER NOT NULL, at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS tombstone_version ON tombstone (version)`,
]
/** The same, as an object created before file precedence (D22): `file` has no `prec`, `prec_lo`. */
const DDL_PRE_D22 = DDL_DC2A1C3.map((s) => s.replace(`,
      prec INTEGER NOT NULL, prec_lo INTEGER NOT NULL)`, ')'))

type Dump = Record<string, Record<string, SqlStorageValue>[]>
const dumpAll = (l: Stub): Promise<Dump> =>
  runInDurableObject(l, (_i: Ledger, s) => {
    const out: Dump = {}
    for (const t of s.storage.sql.exec(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name`).toArray()) {
      out[t.name as string] = s.storage.sql.exec(`SELECT * FROM ${t.name as string} ORDER BY 1`).toArray()
    }
    return out
  })
const schemaRow = (l: Stub) => runInDurableObject(l, (_i: Ledger, s) => s.storage.sql.exec(`SELECT component, version, compat FROM viz_schema`).toArray()[0])

/** Replace the object's storage with what older code left: `ddl`, then `rows` per table. */
async function install(l: Stub, ddl: string[], rows: Record<string, Record<string, SqlStorageValue>[]>): Promise<void> {
  await everything(l) // the object exists (and has started on its own); now overwrite its storage
  await runInDurableObject(l, async (_i: Ledger, s) => {
    await s.storage.deleteAll()
    for (const stmt of ddl) s.storage.sql.exec(stmt)
    for (const [table, list] of Object.entries(rows)) {
      for (const r of list) s.storage.sql.exec(`INSERT INTO ${table} (${Object.keys(r).join(', ')}) VALUES (${Object.keys(r).map(() => '?').join(', ')})`, ...Object.values(r))
    }
  })
  await evictDurableObject(l)
}

/** Rows as the code before versioning wrote them for one unit of stream S, version 2, unlogged. */
function oldRows(withPrecedence: boolean) {
  const u = pair(1, 5)
  const fileRow = (f: (typeof u.files)[number], i: number) => ({
    key: f.key, tbl: f.table, day: f.day, bytes: f.bytes, rows: f.rows, min_ts: f.minTs, max_ts: f.maxTs, level: f.level, idx: f.index,
    u_shard: S, u_inc: INC, u_lo: 1, u_hi: 5, ...(withPrecedence ? { prec: 2 * 4096 + i, prec_lo: 2 * 4096 + i } : {}),
  })
  return {
    meta: [{ k: 'incarnation', v: 1 }, { k: 'version', v: 2 }],
    file: u.files.map(fileRow),
    stream: [{ shard: S, incarnation: INC, watermark: 5, logged: 0, prev_incarnation: null }],
    outbox: [{ version: 2, body: JSON.stringify({ ledgerIncarnation: 1, version: 2, at: 1, kind: 'add_unit', added: [], removed: [], watermark: { shard: S, incarnation: INC, seq: 5 }, unit: { seqLo: 1, seqHi: 5 } }) }],
    tombstone: [{ key: `${u.files[0]!.key}-old`, tbl: 'metric_samples', version: 1, at: 1 }],
  }
}
const nm1 = (key: string) => key.slice(key.lastIndexOf('/') + 1)

describe('versioned storage: the schema of every released version is pinned', () => {
  it('a fresh object records ledger.Ledger at the latest version, and its schema is the golden file for that version', async () => {
    const { l } = open()
    await everything(l)
    expect(await schemaRow(l)).toEqual({ component: 'ledger.Ledger', version: LATEST, compat: schemaRelease(LEDGER_SCHEMA).compat })
    const schema = await runInDurableObject(l, (_i: Ledger, s) => describeSchema(s.storage.sql))
    expectGolden(`schema/v${LATEST}.json`, { version: LATEST, schema })
  })

  it('there is a golden file for every version, and version 1 is exactly the schema the code before versioning created', async () => {
    const files = goldenDir('schema')
    expect(Object.keys(files).sort()).toEqual(Array.from({ length: LATEST }, (_, i) => `v${i + 1}.json`))
    const v1 = (files['v1.json'] as { schema: { type: string; name: string; sql: string }[] }).schema.filter((s) => s.name !== 'viz_schema')
    const old = await runInDurableObject(open().l, async (_i: Ledger, s) => {
      await s.storage.deleteAll()
      for (const stmt of DDL_DC2A1C3) s.storage.sql.exec(stmt)
      return describeSchema(s.storage.sql)
    })
    expect(v1).toEqual(old.map((x) => ({ ...x, sql: norm(x.sql) })))
  })
})

describe('versioned storage: opening storage made by other code', () => {
  it('adopts dc2a1c3 storage as version 1, migrates it to the latest, without changing its live set, serves it, and moves its log to segments in a new incarnation', async () => {
    const { tenant, l } = open()
    const rows = oldRows(true)
    await install(l, DDL_DC2A1C3, rows)
    const p = await everything(l) // the first call opens the old storage
    expect(await schemaRow(l)).toEqual({ component: 'ledger.Ledger', version: LATEST, compat: 2 })
    const after = await dumpAll(l)
    expect(after.file).toEqual(rows.file)
    expect(after.tombstone).toEqual(rows.tombstone)
    expect(after.stream).toEqual([{ ...rows.stream[0], logged: 5 }]) // its unlogged unit is in the new base
    expect(after.outbox).toEqual([])
    expect(p.files.map((f) => f.key)).toEqual([rows.file[0]!.key])
    expect(p.ledgerIncarnation).toBeGreaterThan(1)
    expect((await readSegments(tenant)).find((s) => s.ledgerIncarnation === p.ledgerIncarnation)!.changes[0]).toMatchObject({ kind: 'base', version: 2 })
    // Still the same after eviction, and not migrated twice.
    await evictDurableObject(l)
    expect(await everything(l)).toEqual(p)
    expect(await schemaRow(l)).toEqual({ component: 'ledger.Ledger', version: LATEST, compat: 2 })
  })

  it('adopts an object from before file precedence: migration 1 adds prec and prec_lo (0), and plan serves it', async () => {
    const { l } = open()
    const rows = oldRows(false)
    await install(l, DDL_PRE_D22, rows)
    const p = await everything(l)
    expect(p.files.map((f) => [f.key, f.precedenceLow, f.precedence])).toEqual([[rows.file[0]!.key, 0, 0]])
    expect(await schemaRow(l)).toEqual({ component: 'ledger.Ledger', version: LATEST, compat: 2 })
    const cols = await runInDurableObject(l, (_i: Ledger, s) => s.storage.sql.exec(`PRAGMA table_info(file)`).toArray().map((r) => r.name))
    expect(cols).toContain('prec')
    expect(cols).toContain('prec_lo')
    // New units rank above the old files.
    expect(await l.addUnit(pair(6, 6))).toMatchObject({ status: 'ok' })
    const after = await everything(l)
    expect(after.files.at(-1)!.precedence).toBeGreaterThan(0)
  })

  const NEWER = (readableFrom: number): SchemaSpec => ({
    ...LEDGER_SCHEMA,
    migrations: [...LEDGER_SCHEMA.migrations, { version: LATEST + 1, name: 'a later release', readableFrom, up: (sql) => void sql.exec(`CREATE TABLE IF NOT EXISTS later (x INTEGER)`) } satisfies Migration],
  })

  it('refuses storage a newer release made unreadable to it, on every entry point; re-arms its alarm; writes nothing', async () => {
    const { tenant, l } = open()
    await l.addUnit(pair(1, 2))
    await l.drain()
    await runInDurableObject(l, (_i: Ledger, s) => void openSchema(s.storage, NEWER(LATEST + 1)))
    await runInDurableObject(l, (_i: Ledger, s) => s.storage.deleteAlarm())
    await evictDurableObject(l)
    const before = await dumpAll(l)
    const r2 = await listAll(logPrefix(tenant))
    const calls: [string, (i: Ledger) => Promise<unknown>][] = [
      ['registerStream', (i) => i.registerStream({ shard: 'x', incarnation: 1 })],
      ['addUnit', (i) => i.addUnit(pair(3, 3))],
      ['plan', (i) => i.plan({ table: 'metric_samples', minTs: 0, maxTs: 1 })],
      ['replace', (i) => i.replace({ remove: [], add: [] })],
      ['expire', (i) => i.expire({ table: 'metric_samples', beforeDay: dayOf(T0) })],
      ['loggedWatermarks', (i) => i.loggedWatermarks()],
      ['deletable', (i) => i.deletable({ minAgeMs: 0 })],
      ['forget', (i) => i.forget([])],
      ['removedSince', (i) => i.removedSince(0)],
      ['orphanCheck', (i) => i.orphanCheck([])],
      ['drain', (i) => i.drain()],
      ['outboxDepth', (i) => i.outboxDepth()],
      ['rebuildFromLog', (i) => i.rebuildFromLog()],
    ]
    for (const [name, call] of calls) {
      const outcome = await runInDurableObject(l, (i: Ledger) => call(i).then(() => 'served', (e: Error) => e.message))
      expect(outcome, name).toMatch(/^schema_too_new/)
    }
    expect(await l.logStatus()).toMatchObject({ phase: 'refused' })
    expect(await runInDurableObject(l, (_i: Ledger, s) => s.storage.getAlarm())).not.toBeNull()
    expect(await runDurableObjectAlarm(l)).toBe(true)
    expect(await runInDurableObject(l, (_i: Ledger, s) => s.storage.getAlarm())).not.toBeNull()
    expect(await dumpAll(l)).toEqual(before)
    expect(await listAll(logPrefix(tenant))).toEqual(r2)
  })

  it('serves storage a newer release declared readable to it, and does not lower its version', async () => {
    const { l } = open()
    await l.addUnit(pair(1, 2))
    await runInDurableObject(l, (_i: Ledger, s) => void openSchema(s.storage, NEWER(1)))
    await evictDurableObject(l)
    expect(await l.addUnit(pair(3, 4))).toMatchObject({ status: 'ok', watermark: 4 })
    // Migration 2 is forward-only (readableFrom 2), so compat stays 2 under the newer additive one.
    expect(await schemaRow(l)).toEqual({ component: 'ledger.Ledger', version: LATEST + 1, compat: 2 })
  })

  it('this storage refuses a release that knows only schema version 1 (the release that drains the first layout): forward-only (review S-1)', async () => {
    const { l } = open()
    await l.addUnit(pair(1, 2))
    const V1_ONLY: SchemaSpec = { ...LEDGER_SCHEMA, migrations: LEDGER_SCHEMA.migrations.slice(0, 1) }
    expect(schemaRelease(LEDGER_SCHEMA)).toEqual({ component: 'ledger.Ledger', latest: LATEST, compat: 2 })
    const opened = await runInDurableObject(l, (_i: Ledger, s) => openSchema(s.storage, V1_ONLY))
    expect(opened).toMatchObject({ status: 'schema_too_new', found: LATEST, compat: 2, known: 1 })
  })
})

describe('golden formats: the R2 log objects this release writes', () => {
  /** Replace what differs between runs (the test's tenant name, clock readings) after checking its shape. */
  const scrub = (text: string, tenant: string) => text.replaceAll(tenant, '<tenant>').replace(/"at":\d{13}/g, '"at":"<ms>"')

  it(`a segment (v${LEDGER_SEGMENT_VERSION}) and a checkpoint (v${LEDGER_SEGMENT_VERSION}), written by the ledger for a fixed history`, async () => {
    const { tenant, l } = open()
    await runInDurableObject(l, (inst: Ledger) => { (inst as unknown as { checkpointEvery: number }).checkpointEvery = 1 })
    await l.registerStream({ shard: S, incarnation: INC })
    const u = pair(1, 5)
    await l.addUnit(u)
    await l.replace({ remove: [u.files[0]!.key], add: [{ ...u.files[0]!, key: u.files[0]!.key.replace('samples-', 'L1-samples-'), level: 1 }] })
    await l.expire({ tables: ['metric_samples', 'metric_series'], beforeDay: dayOf(T0 + 86_400_000) })
    await l.drain()
    const inc = (await everything(l)).ledgerIncarnation
    const seg = await (await env.BUCKET.get(`${env.CELL}/${ledgerSegmentKey(tenant, inc, 1, 4)}`))!.text()
    const ckpts = await listAll(`${logPrefix(tenant)}${inc}/ckpt-`)
    expect(ckpts.map(nm1)).toEqual(['ckpt-000000000004.jsonl'])
    const ckpt = await (await env.BUCKET.get(ckpts[0]!))!.text()
    expectGolden(`formats/ledger.segment.v${LEDGER_SEGMENT_VERSION}.json`, { format: 'ledger.segment', version: LEDGER_SEGMENT_VERSION, key: scrub(ledgerSegmentKey(tenant, inc, 1, 4), tenant).replace(`/${inc}/`, '/<incarnation>/'), body: scrub(seg, tenant).replaceAll(`"ledgerIncarnation":${inc}`, '"ledgerIncarnation":"<incarnation>"') })
    expectGolden(`formats/ledger.checkpoint.v${LEDGER_SEGMENT_VERSION}.json`, { format: 'ledger.checkpoint', version: LEDGER_SEGMENT_VERSION, body: scrub(ckpt, tenant).replaceAll(`"ledgerIncarnation":${inc}`, '"ledgerIncarnation":"<incarnation>"') })
  })
})
