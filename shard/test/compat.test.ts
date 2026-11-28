/**
 * Versioned storage and formats (contracts/COMPATIBILITY.md §2, §3, §8), on the real `Shard`:
 * the schema golden, adoption of storage made before versioning (including an object from
 * before `segment.sealed_at`), refusal of storage a newer release made unreadable, service of
 * storage declared readable, and the series-window bucket format with its version byte.
 */
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { describeSchema, type Migration, openSchema, schemaRelease, type SchemaSpec } from '../../contracts/schema'
import { SHARD_SCHEMA, type Shard } from '../src/shard'
import { SKETCH_FORMAT, SeriesWindow } from '../src/sketch'
import { expectGolden, goldenDir } from './golden'

const LATEST = SHARD_SCHEMA.migrations.length
const norm = (sql: string) => sql.replace(/\s+/g, ' ').trim()
let n = 0
const fresh = () => env.SHARD.get(env.SHARD.idFromName(`compat-${Date.now().toString(36)}/${n++}`))
type Stub = DurableObjectStub<Shard>

/** The shard's constructor DDL before versioning (dc2a1c3), verbatim. */
const DDL_DC2A1C3 = [
  `CREATE TABLE IF NOT EXISTS config (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS stream (
      tenant TEXT PRIMARY KEY, incarnation INTEGER NOT NULL, epoch INTEGER NOT NULL,
      sealed_through INTEGER NOT NULL, recorded_through INTEGER NOT NULL, discarded_through INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS batch (
      tenant TEXT NOT NULL, seq INTEGER NOT NULL, fingerprint TEXT NOT NULL, rows INTEGER NOT NULL,
      bytes INTEGER NOT NULL, at INTEGER NOT NULL, payload BLOB, PRIMARY KEY (tenant, seq))`,
  `CREATE UNIQUE INDEX IF NOT EXISTS batch_fp ON batch (tenant, fingerprint)`,
  `CREATE TABLE IF NOT EXISTS segment (
      tenant TEXT NOT NULL, seq_lo INTEGER NOT NULL, seq_hi INTEGER NOT NULL, bytes INTEGER NOT NULL,
      rows INTEGER NOT NULL, recorded_at INTEGER, sealed_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (tenant, seq_lo))`,
  `CREATE TABLE IF NOT EXISTS notify (tenant TEXT PRIMARY KEY, due INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS series_window (
      tenant TEXT NOT NULL, bucket INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (tenant, bucket))`,
]
/** An object made before `sealed_at` was added: the same, without it. */
const DDL_NO_SEALED_AT = DDL_DC2A1C3.map((s) => s.replace(', sealed_at INTEGER NOT NULL DEFAULT 0', ''))

type Dump = Record<string, Record<string, SqlStorageValue>[]>
const dumpAll = (s: Stub): Promise<Dump> =>
  runInDurableObject(s, (_i: Shard, st) => {
    const out: Dump = {}
    for (const t of st.storage.sql.exec(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name`).toArray()) {
      out[t.name as string] = st.storage.sql.exec(`SELECT * FROM ${t.name as string} ORDER BY 1`).toArray()
    }
    return out
  })
const schemaRow = (s: Stub) => runInDurableObject(s, (_i: Shard, st) => st.storage.sql.exec(`SELECT component, version, compat FROM viz_schema`).toArray()[0])

async function install(s: Stub, ddl: string[], rows: Record<string, Record<string, unknown>[]>): Promise<void> {
  await runInDurableObject(s, async (_i: Shard, st) => {
    await st.storage.deleteAll()
    for (const stmt of ddl) st.storage.sql.exec(stmt)
    for (const [table, list] of Object.entries(rows)) {
      for (const r of list) st.storage.sql.exec(`INSERT INTO ${table} (${Object.keys(r).join(', ')}) VALUES (${Object.keys(r).map(() => '?').join(', ')})`, ...Object.values(r))
    }
  })
  await evictDurableObject(s)
}

const OLD_ROWS = {
  stream: [{ tenant: 't', incarnation: 1_800_000_000_000_000, epoch: 1, sealed_through: 2, recorded_through: 0, discarded_through: 0 }],
  batch: [1, 2, 3].map((seq) => ({ tenant: 't', seq, fingerprint: `f${seq}`, rows: 1, bytes: 8, at: 1_800_000_000_000 + seq, payload: new Uint8Array(8).fill(seq).buffer })),
  segment: [{ tenant: 't', seq_lo: 1, seq_hi: 2, bytes: 16, rows: 2, recorded_at: null }],
}

describe('versioned storage: the schema is pinned', () => {
  it('a fresh shard records shard.Shard at the latest version, and its schema is the golden file', async () => {
    const s = fresh()
    await s.describe('nobody')
    expect(await schemaRow(s)).toEqual({ component: 'shard.Shard', version: LATEST, compat: schemaRelease(SHARD_SCHEMA).compat })
    expectGolden(`schema/v${LATEST}.json`, { version: LATEST, schema: await runInDurableObject(s, (_i: Shard, st) => describeSchema(st.storage.sql)) })
  })

  it('there is a golden file for every version, and version 1 is exactly the schema of the code before versioning', async () => {
    const files = goldenDir('schema')
    expect(Object.keys(files).sort()).toEqual(Array.from({ length: LATEST }, (_, i) => `v${i + 1}.json`))
    const v1 = (files['v1.json'] as { schema: { type: string; name: string; sql: string }[] }).schema.filter((x) => x.name !== 'viz_schema')
    const old = await runInDurableObject(fresh(), async (_i: Shard, st) => {
      await st.storage.deleteAll()
      for (const stmt of DDL_DC2A1C3) st.storage.sql.exec(stmt)
      return describeSchema(st.storage.sql)
    })
    expect(v1).toEqual(old.map((x) => ({ ...x, sql: norm(x.sql) })))
  })
})

describe('versioned storage: storage made by other code', () => {
  it('adopts dc2a1c3 storage as version 1 without changing a row, and serves it across eviction', async () => {
    const s = fresh()
    await install(s, DDL_DC2A1C3, { ...OLD_ROWS, segment: OLD_ROWS.segment.map((x) => ({ ...x, sealed_at: 5 })) })
    const before = await runInDurableObject(s, (_i, st) => st.storage.sql.exec(`SELECT * FROM batch ORDER BY seq`).toArray())
    expect((await s.pendingSegments('t')).map((x) => [x.seqLo, x.seqHi])).toEqual([[1, 2]])
    // Adopted as version 1, then migrated to the latest (2 adds `stream.registered`, 3 the batch
    // time bounds of D72; both additive: compat stays 1). The old rows have no bounds (NULL).
    expect(await schemaRow(s)).toEqual({ component: 'shard.Shard', version: LATEST, compat: 1 })
    const after = await dumpAll(s)
    expect(after.batch).toEqual(before)
    expect(after.batch!.map((r) => [r.min_ts, r.max_ts])).toEqual([[null, null], [null, null], [null, null]])
    expect(after.segment).toEqual([{ ...OLD_ROWS.segment[0], sealed_at: 5 }])
    expect(after.stream).toEqual([{ ...OLD_ROWS.stream[0], registered: 0 }])
    const a = await s.append({ tenant: 't', epoch: 1, fingerprint: 'f4', payload: new Uint8Array(8), rows: 1 })
    expect(a).toMatchObject({ status: 'ok', seq: 4 })
    await evictDurableObject(s)
    expect(await schemaRow(s)).toEqual({ component: 'shard.Shard', version: LATEST, compat: 1 })
  })

  it('adopts an object from before segment.sealed_at: migration 1 adds the column, and every statement naming it works', async () => {
    const s = fresh()
    await install(s, DDL_NO_SEALED_AT, OLD_ROWS)
    expect(await s.pendingTenants(0)).toEqual([{ tenant: 't', segments: 1, oldestSealedAt: 0 }])
    expect(await schemaRow(s)).toEqual({ component: 'shard.Shard', version: LATEST, compat: 1 })
    expect((await s.seal('t'))).toMatchObject({ seqLo: 3, seqHi: 3 })
  })

  const NEWER = (readableFrom: number): SchemaSpec => ({
    ...SHARD_SCHEMA,
    migrations: [...SHARD_SCHEMA.migrations, { version: LATEST + 1, name: 'a later release', readableFrom, up: (sql) => void sql.exec(`CREATE TABLE IF NOT EXISTS later (x INTEGER)`) } satisfies Migration],
  })

  it('refuses storage a newer release made unreadable to it: append answers retryable backpressure (never ok), everything else throws, the alarm is re-armed, nothing is written', async () => {
    const s = fresh()
    await s.append({ tenant: 't', epoch: 1, fingerprint: 'a', payload: new Uint8Array(8), rows: 1 })
    await runInDurableObject(s, (_i: Shard, st) => void openSchema(st.storage, NEWER(LATEST + 1)))
    await runInDurableObject(s, (_i: Shard, st) => st.storage.deleteAlarm())
    await evictDurableObject(s)
    const before = await dumpAll(s)
    expect(await s.append({ tenant: 't', epoch: 1, fingerprint: 'b', payload: new Uint8Array(8), rows: 1 })).toMatchObject({ status: 'backpressure', scope: 'overload', retryAfterMs: 30_000 })
    const calls: [string, (i: Shard) => Promise<unknown>][] = [
      ['seal', (i) => i.seal('t')], ['pendingSegments', (i) => i.pendingSegments('t')], ['pendingTenants', (i) => i.pendingTenants(0)],
      ['readSegment', (i) => i.readSegment('t', 1)], ['recorded', (i) => i.recorded('t', 1, 1)], ['tailRead', (i) => i.tailRead('t', 1, 0)],
      ['describe', (i) => i.describe('t')], ['configure', (i) => i.configure({})], ['seriesCount', (i) => i.seriesCount('t')],
    ]
    for (const [name, call] of calls) {
      expect(await runInDurableObject(s, (i: Shard) => call(i).then(() => 'served', (e: Error) => e.message)), name).toMatch(/^schema_too_new/)
    }
    expect(await runInDurableObject(s, (_i: Shard, st) => st.storage.getAlarm())).not.toBeNull()
    expect(await runDurableObjectAlarm(s)).toBe(true)
    expect(await runInDurableObject(s, (_i: Shard, st) => st.storage.getAlarm())).not.toBeNull()
    expect(await dumpAll(s)).toEqual(before)
  })

  it('serves storage a newer release declared readable to it, and does not lower its version', async () => {
    const s = fresh()
    await s.append({ tenant: 't', epoch: 1, fingerprint: 'a', payload: new Uint8Array(8), rows: 1 })
    await runInDurableObject(s, (_i: Shard, st) => void openSchema(st.storage, NEWER(1)))
    await evictDurableObject(s)
    expect(await s.append({ tenant: 't', epoch: 1, fingerprint: 'b', payload: new Uint8Array(8), rows: 1 })).toMatchObject({ status: 'ok', seq: 2 })
    expect(await schemaRow(s)).toEqual({ component: 'shard.Shard', version: LATEST + 1, compat: 1 })
  })
})

describe('the series-window bucket format', () => {
  const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('')

  it(`is pinned (format ${SKETCH_FORMAT}): an exact bucket and a sketch bucket of fixed ids`, () => {
    const w = new SeriesWindow(3_600_000, 4, 0)
    w.add(BigInt64Array.from([1n, -2n, 3n]), 100)
    const exact = w.save()[1]![1]
    const s = new SeriesWindow(3_600_000, 4, 0)
    s.add(BigInt64Array.from([1n, 2n, 3n, 4n, 5n, 6n]), 0) // past exactMax: a sketch
    const sketch = s.save()[1]![1]
    expect([exact[0], exact[1], sketch[0], sketch[1]]).toEqual([0, SKETCH_FORMAT, 1, SKETCH_FORMAT])
    expectGolden(`formats/series-window.v${SKETCH_FORMAT}.json`, {
      format: 'series-window', version: SKETCH_FORMAT,
      exact: hex(exact),
      // The sketch is 4 KB of registers and 16 KB of Bloom bits: pinned by its length and a digest of its bytes.
      sketch: { bytes: sketch.byteLength, header: hex(sketch.subarray(0, 8)), sum: sketch.reduce((a, b, i) => (a + b * ((i % 251) + 1)) >>> 0, 0) },
    })
  })

  it('reads buckets saved before the version byte existed (byte 1 = 0) and refuses a kind or version it does not know', () => {
    const w = new SeriesWindow(3_600_000, 4, 0)
    w.add(BigInt64Array.from([7n, 8n]), 100)
    const [[i0, b0], [i1, b1]] = w.save() as [[number, Uint8Array], [number, Uint8Array]]
    const old = b1.slice()
    old[1] = 0
    expect(SeriesWindow.load(3_600_000, 4, 0, [[i0, b0], [i1, old]]).count()).toBe(2)
    const kind = b1.slice()
    kind[0] = 2
    expect(() => SeriesWindow.load(3_600_000, 4, 0, [[i1, kind]])).toThrow(/kind 2/)
    const version = b1.slice()
    version[1] = SKETCH_FORMAT + 1
    expect(() => SeriesWindow.load(3_600_000, 4, 0, [[i1, version]])).toThrow(/format 2/)
  })

  it('a shard whose stored window it cannot read refuses that tenant\'s metered appends (retryably) instead of starting an empty window', async () => {
    const s = fresh()
    const ids = BigInt64Array.from([1n, 2n])
    const batch = (fp: string, metered: boolean) => {
      const p = new Uint8Array(32)
      new DataView(p.buffer).setUint32(12, ids.length, true)
      return s.append({ tenant: 't', epoch: 1, fingerprint: fp, payload: p, rows: 2, ...(metered ? { seriesIds: ids, seriesLimit: 1 } : {}) })
    }
    expect(await batch('a', true)).toMatchObject({ status: 'series_limit' }) // limit 1, two new series: the window is real
    expect(await batch('a2', false)).toMatchObject({ status: 'ok' })
    await s.configure({ seriesPersistMs: 0 })
    expect(await batch('a3', true)).toMatchObject({ status: 'series_limit' })
    await runInDurableObject(s, async (i: Shard, st) => {
      ;(i as unknown as { windows: Map<string, { dirtySince: number | null }> }).windows.get('t')!.dirtySince = 0
      await i.alarm()
      st.storage.sql.exec(`UPDATE series_window SET data = X'0900' || substr(data, 3) WHERE tenant = 't'`)
    })
    await evictDurableObject(s)
    expect(await batch('b', true)).toMatchObject({ status: 'backpressure', scope: 'overload' })
    expect(await batch('c', false)).toMatchObject({ status: 'ok' })
  })
})
