/**
 * The span and log tables (contracts/TRACES.md, contracts/LOGS.md), published as Iceberg tables of
 * their own beside the metric pair (design/DECISIONS.md D67; the D64 release read them and did not
 * publish them):
 *
 *   - a tenant's `spans`, `trace_index` and `logs` files are published exactly as its ledger lists
 *     them, from a first publication and from the cursor; partition values (`hour(start_time)` for
 *     `spans`, the day for the others), counts and bounds are those of the files; every table verifies;
 *   - metric publication is byte-identical: this release on the log as written, this release on the
 *     same log without the span and log changes, the D64 release (`test/d64/`) on the log as written,
 *     and the release before that (`test/n1/`) on the log without them;
 *   - their removed files are released by the snapshot rule (once no retained snapshot references
 *     them, then the delete grace), as metric files are;
 *   - a `spans` file outside its key's hour stops the tenant, from the cursor and in a re-base;
 *   - SQLite rebuilt from R2 alone (a lost storage) holds every table, the `spans` hours included;
 *   - a re-base (D55) stages them: from the base of a new incarnation, from a checkpoint in parts or
 *     in one object, and on the review P-1 path; and the first publish after an upgrade from the
 *     D64 release re-bases every tenant once and publishes everything;
 *   - this release and the D64 release side by side (D64's rollout rule makes D64 the oldest
 *     rollback target once `INGEST_SIGNALS` is on): D64 on this release's storage keeps publishing the
 *     metrics, leaves the span and log tables, their cursors and their metadata alone, and releases
 *     none of their removed files; rolled forward, this release catches up.
 */
import { evictDurableObject, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { TABLES as CONTRACT_TABLES, dataKeyPrefix, ledgerSegmentKey, type FileEntry, type FlushUnit, type LedgerTable, type SignalTable } from '../../contracts/ledger'
import { dayToInt, SIGNAL_DEFS, TABLE_NAMES, type ManifestListRecord } from '../src/iceberg'
import { PUBLISHED_TABLES, UNPUBLISHED_TABLES } from '../src/log'
import {
  DAY_MS,
  INC,
  T0,
  TABLES,
  addUnit,
  dayOf,
  fileFor,
  fresh,
  icebergLive,
  keyOf,
  ledger,
  ledgerVersion,
  listKeys,
  liveKeys,
  loseLedgerStorage,
  metadataVersions,
  mirror,
  pairUnit,
  publisher,
  putObjects,
  putSegment,
  readAvroKey,
  readMetadata,
  snapshotEntries,
  type LedgerStub,
  type PublisherStub,
} from './helpers'
import { dumpOf, install, schemaRow } from './storage'

const HOUR = 3_600_000
const TRACES = 'pool/traces/0'
const LOGS = 'pool/logs/0'
const SIGNALS: SignalTable[] = ['spans', 'trace_index', 'logs']
const ALL: LedgerTable[] = [...TABLES, ...SIGNALS]

/** A span or log file under the contract's key layout (a `spans` key under its hour), of the ledger's cell, with an index fragment of the contract's shape. */
const signalFile = (t: string, table: SignalTable, name: string, ts: number): FileEntry => {
  const day = dayOf(ts)
  const rg =
    table === 'trace_index'
      ? { rows: 7, off: 4, len: 80, min_tid: '0a'.repeat(16), max_tid: 'f0'.repeat(16), min_ts: String(ts * 1e6), max_ts: String(ts * 1e6 + 999) }
      : { rows: 7, off: 4, len: 80, min_name: 'api', max_name: 'web', min_ts: String(ts * 1e6), max_ts: String(ts * 1e6 + 999) }
  return {
    table,
    day,
    key: `${dataKeyPrefix(env.CELL, table, t, day, table === 'spans' ? new Date(ts).getUTCHours() : undefined)}${name}.parquet`,
    bytes: 96,
    rows: 7,
    minTs: ts,
    maxTs: ts + 999,
    level: 0,
    index: JSON.stringify({ v: 1, rg: [rg], foot: [84, 300] }),
  }
}
/** A flush unit of the traces stream: one `spans` file of `ts`'s hour and one `trace_index` file of its day. */
const spanUnit = (t: string, seq: number, ts: number): FlushUnit => ({
  shard: TRACES,
  incarnation: INC,
  seqLo: seq,
  seqHi: seq,
  files: [signalFile(t, 'spans', `L0-pool_traces_0-${INC}-${seq}-${seq}-5a5a5a5a`, ts), signalFile(t, 'trace_index', `L0-pool_traces_0-${INC}-${seq}-${seq}-7a7a7a7a`, ts)],
})
/** A flush unit of the logs stream: one `logs` file of `ts`'s day. */
const logUnit = (t: string, seq: number, ts: number): FlushUnit => ({
  shard: LOGS,
  incarnation: INC,
  seqLo: seq,
  seqHi: seq,
  files: [signalFile(t, 'logs', `L0-pool_logs_0-${INC}-${seq}-${seq}-1c1c1c1c`, ts)],
})

type Knobs = { checkpointEvery: number; checkpointByLogBytes: boolean; checkpointOneObjectBytes: number; checkpointPartBytes: number }
const knobs = (l: LedgerStub, k: Partial<Knobs>) => runInDurableObject(l, (i: unknown) => void Object.assign(i as object, k))
/** A ledger that writes a checkpoint only when a test says so. */
const quietLedger = async (t: string) => {
  const l = ledger(t)
  await l.plan({ table: 'metric_samples', minTs: 0, maxTs: 0 })
  await knobs(l, { checkpointEvery: 1e9, checkpointByLogBytes: false })
  return l
}

const d64 = (name: string) => env.PUBLISHER_D64.get(env.PUBLISHER_D64.idFromName(name))
const n1 = (name: string) => env.PUBLISHER_N1.get(env.PUBLISHER_N1.idFromName(name))

/** The tenant's files in every published table are exactly its ledger's live files. */
const asLedger = async (cell: string, t: string, tables: LedgerTable[] = ALL) => {
  for (const table of tables) expect((await icebergLive(cell, table)).filter((k) => k.includes(`/tenant=${t}/`)), table).toEqual(await liveKeys(t, table))
}
const verified = async (p: PublisherStub, tables: LedgerTable[] = ALL) => {
  for (const table of tables) {
    const v = await p.verify(table)
    expect(v, `verify(${table})`).toMatchObject({ ok: true, missingFromIceberg: [], extraInIceberg: [], mismatched: [], missingObjects: [], sizeMismatch: [], problems: [] })
  }
}

const le64 = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, 8).getBigInt64(0, true)
const le32 = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, 4).getInt32(0, true)
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('')

/**
 * What the current snapshot of a span or log table says of each of the tenant's files, against the
 * ledger's entry: partition (the hour of `spans` = the key's hour = the hour of its start times; the
 * day of the others), counts only for required top-level columns, valid bounds, split offsets.
 */
async function expectEntriesOfFiles(cell: string, t: string, table: SignalTable) {
  const ledgerFiles = new Map((await ledger(t).plan({ table, minTs: 0, maxTs: Number.MAX_SAFE_INTEGER })).files.map((f) => [f.key, f]))
  const entries = (await snapshotEntries(cell, table)).filter((e) => e.status !== 2 && e.tenant === t)
  expect(entries.map((e) => e.key).sort()).toEqual([...ledgerFiles.keys()].sort())
  const required = SIGNAL_DEFS[table].data.filter((c) => c.required && typeof c.type === 'string').map((c) => c.id)
  for (const e of entries) {
    const f = ledgerFiles.get(e.key)!
    const d = e.entry.data_file
    expect(d.record_count).toBe(f.rows)
    expect(d.file_size_in_bytes).toBe(f.bytes)
    if (table === 'spans') {
      const keyHour = dayToInt(f.day) * 24 + Number(/\/hour=(\d\d)\//.exec(f.key)![1])
      expect(e.hour, e.key).toBe(keyHour)
      expect(e.hour).toBe(Math.floor(f.minTs / HOUR))
      expect(e.hour).toBe(Math.floor(f.maxTs / HOUR))
      expect(Object.keys(d.partition)).toEqual(['tenant', 'start_time_hour'])
    } else {
      expect(e.day, e.key).toBe(dayToInt(f.day))
      expect(Object.keys(d.partition)).toEqual(['tenant', 'day'])
    }
    expect(d.value_counts!.map((x) => x.key)).toEqual(required)
    expect(d.value_counts!.every((x) => x.value === f.rows)).toBe(true)
    expect(d.null_value_counts!.every((x) => x.value === 0)).toBe(true)
    const lo = new Map(d.lower_bounds!.map((x) => [x.key, x.value]))
    const hi = new Map(d.upper_bounds!.map((x) => [x.key, x.value]))
    const nsIds = table === 'spans' ? [6] : table === 'trace_index' ? [2, 3] : [3]
    for (const id of nsIds) {
      expect(le64(lo.get(id)!)).toBe(BigInt(f.minTs) * 1_000_000n)
      expect(le64(hi.get(id)!)).toBe(BigInt(f.maxTs) * 1_000_000n + 999_999n)
    }
    if (table === 'spans') {
      expect(le64(lo.get(9)!)).toBe(BigInt(f.minTs) * 1000n) // start_time, microseconds
      expect(le64(hi.get(9)!)).toBe(BigInt(f.maxTs) * 1000n + 999n)
      expect(new TextDecoder().decode(lo.get(10)!)).toBe('api') // service_name, from the fragment
    }
    if (table === 'trace_index') expect([hex(lo.get(1)!), hex(hi.get(1)!)]).toEqual(['0a'.repeat(16), 'f0'.repeat(16)])
    if (table === 'logs') expect(new TextDecoder().decode(hi.get(1)!)).toBe('web')
    expect(d.split_offsets).toEqual([4])
  }
}

/** Every object under the cell's Iceberg prefix of these tables, with its bytes (hex). */
async function icebergObjects(cell: string, tables: LedgerTable[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const table of tables) {
    for (const k of await listKeys(`${cell}/iceberg/${table}/`)) out[k] = hex(new Uint8Array(await (await env.BUCKET.get(k))!.arrayBuffer()))
  }
  return out
}

/** The tenant's segments as the ledger wrote them (drained first), by key relative to the cell. Checkpoints left out. */
async function segmentsNow(t: string): Promise<Record<string, string>> {
  await ledger(t).drain()
  const out: Record<string, string> = {}
  for (const k of await listKeys(`${env.CELL}/ledger/tenant=${t}/`)) {
    if (k.includes('/ckpt-')) continue
    out[k.slice(env.CELL.length + 1)] = await (await env.BUCKET.get(k))!.text()
  }
  return out
}

const SIGNAL_KEY = /\/data\/(spans|trace_index|logs)\//
/**
 * A segment as the ledger would have written it had the tenant no span or log files: every
 * change keeps its version, kind and metric files; its span and log files, removals, tombstones
 * and units are gone. The header (versions, line count) is unchanged.
 */
function withoutSignals(body: string): string {
  return body
    .split('\n')
    .map((line, i) => {
      if (i === 0 || line === '') return line
      const c = JSON.parse(line) as Record<string, unknown> & { added: FileEntry[]; removed: string[]; removedFiles?: { key: string; table: string }[] }
      c.added = c.added.filter((f) => !SIGNALS.includes(f.table as SignalTable))
      c.removed = c.removed.filter((k) => !SIGNAL_KEY.test(k))
      if (c.removedFiles) {
        c.removedFiles = c.removedFiles.filter((r) => !SIGNALS.includes(r.table as SignalTable))
        if (c.removedFiles.length === 0) delete c.removedFiles
      }
      if (Array.isArray(c.tombstones)) c.tombstones = (c.tombstones as { table: string }[]).filter((x) => !SIGNALS.includes(x.table as SignalTable))
      if (Array.isArray(c.units)) c.units = (c.units as { key: string }[]).filter((u) => !SIGNAL_KEY.test(u.key))
      return JSON.stringify(c)
    })
    .join('\n')
}

describe('the span and log tables, published', () => {
  it('a tenant\'s spans, trace_index and logs are published exactly as its ledger lists them, with the partition, counts and bounds of each file', async () => {
    const { cell, tenant } = fresh()
    const t = tenant('pub')
    const l = await quietLedger(t)
    await addUnit(t, pairUnit(cell, t, 1, 1, T0 + 1000), { drain: true })
    await addUnit(t, spanUnit(t, 1, T0 + 5 * HOUR), { drain: true })
    await addUnit(t, logUnit(t, 1, T0 + 2000))
    await addUnit(t, spanUnit(t, 2, T0 + 23 * HOUR + 59 * 60_000), { drain: true })
    await addUnit(t, pairUnit(cell, t, 2, 2, T0 + DAY_MS + 1000), { drain: true })
    await mirror(t, cell)
    const p = publisher(cell)
    const r = await p.publish([t])
    const v = await ledgerVersion(t)
    expect(r.tenants).toEqual([expect.objectContaining({ tenant: t, status: 'ok', cursors: { metric_samples: v, metric_series: v, spans: v, trace_index: v, logs: v } })])
    expect(r.tenants[0]).not.toHaveProperty('unpublished')
    expect([r.tables.spans.added, r.tables.trace_index.added, r.tables.logs.added]).toEqual([2, 2, 1])
    await asLedger(cell, t)
    for (const s of SIGNALS) await expectEntriesOfFiles(cell, t, s)
    await verified(p)
    for (const s of SIGNALS) expect(await p.status(s)).toMatchObject({ published: true, version: 1, files: s === 'logs' ? 1 : 2, manifests: 1 })
    expect(await p.unpublished(t)).toEqual([])

    // The metadata: the partition spec, the hour summaries in the manifest list, the summary's partitions.
    const spans = await readMetadata(cell, 'spans')
    expect(spans['partition-specs']).toEqual([{ 'spec-id': 0, fields: [{ name: 'tenant', transform: 'identity', 'source-id': 45, 'field-id': 1000 }, { name: 'start_time_hour', transform: 'hour', 'source-id': 9, 'field-id': 1001 }] }])
    const snap = spans.snapshots.find((s) => s['snapshot-id'] === spans['current-snapshot-id'])!
    expect(snap.summary).toMatchObject({ operation: 'append', 'added-data-files': '2', 'changed-partition-count': '2', 'total-records': '14' })
    const [m] = await readAvroKey<ManifestListRecord>(keyOf(snap['manifest-list']))
    expect([le32(m!.partitions![1]!.lower_bound!), le32(m!.partitions![1]!.upper_bound!)]).toEqual([Math.floor((T0 + 5 * HOUR) / HOUR), Math.floor((T0 + 23 * HOUR) / HOUR)])
    expect(new TextDecoder().decode(m!.partitions![0]!.lower_bound!)).toBe(t)
    const logs = await readMetadata(cell, 'logs')
    expect(logs['partition-specs']).toEqual([{ 'spec-id': 0, fields: [{ name: 'tenant', transform: 'identity', 'source-id': 13, 'field-id': 1000 }, { name: 'day', transform: 'identity', 'source-id': 14, 'field-id': 1001 }] }])
    expect(JSON.parse(logs.properties['schema.name-mapping.default']!)).toContainEqual({ 'field-id': 6, names: ['metadata'], fields: [{ 'field-id': 15, names: ['key'] }, { 'field-id': 16, names: ['value'] }] })

    // From the cursor: more spans, a log day expired, more metrics.
    await addUnit(t, spanUnit(t, 3, T0 + DAY_MS + 6 * HOUR), { drain: true })
    await addUnit(t, logUnit(t, 2, T0 + DAY_MS + 3000), { drain: true })
    expect((await l.expire({ tables: ['logs'], beforeDay: dayOf(T0 + DAY_MS) })).removed).toHaveLength(1)
    await addUnit(t, pairUnit(cell, t, 3, 3, T0 + DAY_MS + 4000), { drain: true })
    await mirror(t, cell)
    const r2 = await p.publish([t])
    expect(r2.tenants[0]).toMatchObject({ status: 'ok', cursors: { spans: await ledgerVersion(t), logs: await ledgerVersion(t) } })
    expect(r2.tenants[0]!.rebase).toBeUndefined()
    expect(r2.tables.logs).toMatchObject({ added: 1, removed: 1 })
    expect(r2.tables.spans).toMatchObject({ added: 1, removed: 0 })
    await asLedger(cell, t)
    for (const s of SIGNALS) await expectEntriesOfFiles(cell, t, s)
    await verified(p)
    // The removed log file is a DELETED entry of the snapshot that removed it.
    const deleted = (await snapshotEntries(cell, 'logs')).filter((e) => e.status === 2)
    expect(deleted.map((e) => e.key)).toEqual([logUnit(t, 1, T0 + 2000).files[0]!.key])
    // A publish with nothing new commits nothing.
    const r3 = await p.publish([t])
    for (const table of ALL) expect(r3.tables[table].snapshotId, table).toBeNull()
  })

  it('metric publication is byte-identical: this release on the log as written and without span and log changes, the D64 release on the log as written, and N-1 of D64 without them', async () => {
    const { cell, tenant } = fresh()
    const t = tenant('bytes')
    const l = await quietLedger(t)
    await addUnit(t, pairUnit(cell, t, 1, 1, T0 + 1000), { drain: true })
    await addUnit(t, spanUnit(t, 1, T0 + 5 * HOUR), { drain: true })
    await addUnit(t, logUnit(t, 1, T0 + 2000))
    await addUnit(t, pairUnit(cell, t, 2, 2, T0 + DAY_MS + 1000), { drain: true })
    const live = async () => Object.fromEntries(await Promise.all(ALL.map(async (table) => [table, await liveKeys(t, table)] as const)))
    const stage1 = { log: await segmentsNow(t), live: await live() }
    // Then: spans, logs, a log day and a metric day expired, a compaction, more metrics.
    await addUnit(t, spanUnit(t, 2, T0 + DAY_MS + 6 * HOUR), { drain: true })
    await addUnit(t, logUnit(t, 2, T0 + DAY_MS + 3000), { drain: true })
    expect((await l.expire({ tables: ['logs'], beforeDay: dayOf(T0 + DAY_MS) })).removed).toHaveLength(1)
    await addUnit(t, pairUnit(cell, t, 3, 3, T0 + DAY_MS + 4000), { drain: true })
    const merged = fileFor(cell, t, 'metric_samples', 'L1-day1', { minTs: T0 + DAY_MS, level: 1, rows: 20, bytes: 100 })
    await putObjects([merged])
    const u2 = pairUnit(cell, t, 2, 2, T0 + DAY_MS + 1000).files[0]!.key
    const u3 = pairUnit(cell, t, 3, 3, T0 + DAY_MS + 4000).files[0]!.key
    expect(await l.replace({ remove: [u2, u3], add: [merged] })).toMatchObject({ status: 'ok' })
    expect((await l.expire({ tables: ['metric_samples', 'metric_series'], beforeDay: dayOf(T0 + DAY_MS) })).removed).toHaveLength(2)
    await addUnit(t, spanUnit(t, 3, T0 + DAY_MS + 7 * HOUR), { drain: true })
    const stage2 = { log: await segmentsNow(t), live: await live() }
    expect(Object.values(stage2.log).join('')).toMatch(/"table":"spans"/)

    type Run = { publish: (tenants: string[]) => Promise<{ tenants: { status: string }[] }>; determinism: (seed: number, now: number) => Promise<void> }
    const variants: [string, Run, (body: string) => string, boolean][] = [
      ['N, the log as written', publisher(`${cell}~full`) as unknown as Run, (b) => b, true],
      ['N, the log without span and log changes', publisher(`${cell}~stripped`) as unknown as Run, withoutSignals, false],
      ['D64 (N-1), the log as written', d64(`${cell}~d64`) as unknown as Run, (b) => b, false],
      ['9292abb (N-2), the log without span and log changes', n1(`${cell}~n1`) as unknown as Run, withoutSignals, false],
    ]
    const runs: Record<string, Record<string, string>[]> = {}
    for (const [name, p, rewrite, signals] of variants) {
      for (const k of await listKeys(`${cell}/`)) await env.BUCKET.delete(k)
      await p.determinism(20261119, Date.UTC(2026, 10, 19))
      runs[name] = []
      for (const stage of [stage1, stage2]) {
        for (const [k, body] of Object.entries(stage.log)) await env.BUCKET.put(`${cell}/${k}`, rewrite(body))
        const r = await p.publish([t])
        expect(r.tenants[0], name).toMatchObject({ status: 'ok' })
        for (const table of TABLES) expect(await icebergLive(cell, table), `${name}: ${table}`).toEqual(stage.live[table])
        // Only this release publishes the span and log tables, exactly the ledger's.
        for (const s of SIGNALS) expect(signals ? await icebergLive(cell, s) : await listKeys(`${cell}/iceberg/${s}/`), `${name}: ${s}`).toEqual(signals ? stage.live[s] : [])
        runs[name]!.push(await icebergObjects(cell, TABLES))
      }
    }
    const [full, ...others] = variants.map(([name]) => runs[name]!)
    for (const i of [0, 1]) {
      expect(Object.keys(full![i]!).length, `stage ${i + 1}`).toBeGreaterThanOrEqual(10)
      for (const [j, other] of others.entries()) expect(other[i], `stage ${i + 1}: ${variants[j + 1]![0]}`).toEqual(full![i])
    }
  })

  it('their removed files are released by the snapshot rule: once no retained snapshot references them, after the delete grace; never a live key', async () => {
    const { cell, tenant } = fresh()
    const t = tenant('release')
    const l = await quietLedger(t)
    await addUnit(t, pairUnit(cell, t, 1, 1, T0 + 1000), { drain: true })
    await addUnit(t, logUnit(t, 1, T0 + 2000), { drain: true })
    await addUnit(t, spanUnit(t, 1, T0 + 3 * HOUR), { drain: true })
    await mirror(t, cell)
    const p = publisher(cell)
    await p.configure({ deleteGraceMs: 60_000, snapshotWindowMs: HOUR })
    expect((await p.publish([t])).tenants[0]).toMatchObject({ status: 'ok' })
    // Retention of day 0's logs and traces; and a log unit added and expired between two publications.
    await addUnit(t, logUnit(t, 2, T0 + 4000), { drain: true })
    const gone = [...(await l.expire({ tables: ['logs'], beforeDay: dayOf(T0 + DAY_MS) })).removed, ...(await l.expire({ tables: ['spans', 'trace_index'], beforeDay: dayOf(T0 + DAY_MS) })).removed].sort()
    expect(gone).toHaveLength(4)
    const transient = logUnit(t, 2, T0 + 4000).files[0]!.key
    const published = gone.filter((k) => k !== transient)
    await mirror(t, cell)
    expect((await p.publish([t])).tenants[0]).toMatchObject({ status: 'ok' })
    for (const s of SIGNALS) expect(await icebergLive(cell, s), s).toEqual([])
    // Never published: released after the grace alone. The others: snapshot 1 still references them.
    expect(await p.safeToDelete(t)).toEqual([])
    await p.advanceClock(60_001)
    expect(await p.safeToDelete(t)).toEqual([transient])
    // Snapshot 1 is retained (the newest two always are) until a later commit to the same table expires it.
    await p.advanceClock(2 * HOUR)
    await p.maintain()
    expect(await p.safeToDelete(t)).toEqual([transient])
    await addUnit(t, logUnit(t, 3, T0 + DAY_MS + 5000), { drain: true })
    await addUnit(t, spanUnit(t, 2, T0 + DAY_MS + 5 * HOUR), { drain: true })
    await mirror(t, cell)
    expect((await p.publish([t])).tenants[0]).toMatchObject({ status: 'ok' })
    expect(await p.safeToDelete(t)).toEqual([transient])
    await p.advanceClock(60_001)
    expect(await p.safeToDelete(t)).toEqual(gone)
    for (const table of ALL) for (const k of await liveKeys(t, table)) expect(gone).not.toContain(k)
    expect(published.every((k) => gone.includes(k))).toBe(true)
    await p.acknowledgeDeleted(t, gone)
    expect(await p.safeToDelete(t)).toEqual([])
    await verified(p)
  })

  it('a spans file whose time range is not in its key\'s hour stops the tenant: nothing of that change is published', async () => {
    const { cell, tenant } = fresh()
    const t = tenant('hour')
    await quietLedger(t)
    await addUnit(t, spanUnit(t, 1, T0 + 2 * HOUR), { drain: true })
    await mirror(t, cell)
    const p = publisher(cell)
    expect((await p.publish([t])).tenants[0]).toMatchObject({ status: 'ok' })
    // A forged change (the ledger refuses such a file): under hour 03, times in hour 04.
    const v = await ledgerVersion(t)
    const bad = { ...signalFile(t, 'spans', 'L0-forged', T0 + 3 * HOUR), minTs: T0 + 4 * HOUR, maxTs: T0 + 4 * HOUR + 10, precedence: (v.version + 1) * 4096, precedenceLow: (v.version + 1) * 4096 }
    await putSegment(cell, t, v.ledgerIncarnation, [{ ledgerIncarnation: v.ledgerIncarnation, version: v.version + 1, at: 0, kind: 'add_unit', added: [bad], removed: [] }])
    const r = (await p.publish([t])).tenants[0]!
    expect(r.status).toBe('inconsistent')
    expect(r.detail).toMatch(/is under hour .* its start times lie in hours/)
    expect(r.cursors.spans).toEqual(v)
    expect(await icebergLive(cell, 'spans')).not.toContain(bad.key)
    expect(await p.pending()).toEqual([t])

    // The same in a re-base: a forged base segment (the incarnation's first) whose `added` holds such a file.
    const u = tenant('hourbase')
    const good = { ...signalFile(u, 'spans', 'L0-good', T0 + 2 * HOUR), precedence: 1, precedenceLow: 1 }
    const forged = { ...signalFile(u, 'spans', 'L0-forged', T0 + 3 * HOUR), minTs: T0 + 4 * HOUR, maxTs: T0 + 4 * HOUR + 10, precedence: 2, precedenceLow: 2 }
    const header = { v: 1, kind: 'viz.ledger.segment', tenant: u, ledgerIncarnation: 1, firstVersion: 0, lastVersion: 0, changes: 1 }
    const base = { ledgerIncarnation: 1, version: 0, at: 0, kind: 'base', added: [good, forged], removed: [], watermarks: [] }
    await env.BUCKET.put(`${cell}/${ledgerSegmentKey(u, 1, 0, 0)}`, `${JSON.stringify(header)}\n${JSON.stringify(base)}\n`)
    const rb = (await p.publish([u])).tenants[0]!
    expect(rb).toMatchObject({ status: 'inconsistent', rebase: { source: 'base', files: 2 } })
    expect(rb.detail).toMatch(/L0-forged.*is under hour .* its start times lie in hours/)
    expect(rb.cursors.spans).toBeUndefined()
    expect(await icebergLive(cell, 'spans')).not.toContain(good.key)
  })

  it('SQLite rebuilt from R2 alone after the publisher lost its storage: every table, the spans hours included; nothing committed again, and the next commits are right', async () => {
    const { cell, tenant } = fresh()
    const t = tenant('resync')
    const l = await quietLedger(t)
    await addUnit(t, pairUnit(cell, t, 1, 1, T0 + 1000), { drain: true })
    await addUnit(t, spanUnit(t, 1, T0 + 5 * HOUR), { drain: true })
    await addUnit(t, spanUnit(t, 2, T0 + DAY_MS + 7 * HOUR), { drain: true })
    await addUnit(t, logUnit(t, 1, T0 + 2000), { drain: true })
    await mirror(t, cell)
    const p = publisher(cell)
    expect((await p.publish([t])).tenants[0]).toMatchObject({ status: 'ok' })
    const before = await icebergObjects(cell, ALL)
    await runInDurableObject(p, async (_i, state) => { await state.storage.deleteAll() })
    await evictDurableObject(p)
    const r = await p.publish([t])
    expect(r.ops.put).toBe(0)
    expect(await icebergObjects(cell, ALL)).toEqual(before)
    for (const s of SIGNALS) expect(await p.status(s)).toMatchObject({ version: 1, files: s === 'logs' ? 1 : 2 })
    await verified(p)
    // The next commit of spans removes day 0's file: the rewritten manifest and its list row from what the resync read.
    expect((await l.expire({ tables: ['spans', 'trace_index'], beforeDay: dayOf(T0 + DAY_MS) })).removed).toHaveLength(2)
    await addUnit(t, spanUnit(t, 3, T0 + DAY_MS + 9 * HOUR), { drain: true })
    await mirror(t, cell)
    expect((await p.publish([t])).tables.spans).toMatchObject({ added: 1, removed: 1 })
    await asLedger(cell, t)
    for (const s of SIGNALS) await expectEntriesOfFiles(cell, t, s)
    const meta = await readMetadata(cell, 'spans')
    const rows = await readAvroKey<ManifestListRecord>(keyOf(meta.snapshots.find((x) => x['snapshot-id'] === meta['current-snapshot-id'])!['manifest-list']))
    const hours = rows.map((m) => [le32(m.partitions![1]!.lower_bound!), le32(m.partitions![1]!.upper_bound!)]).sort()
    // One manifest for the added file, the rewritten one holding day 1's file (and day 0's as DELETED).
    expect(hours).toEqual([[Math.floor((T0 + 5 * HOUR) / HOUR), Math.floor((T0 + DAY_MS + 7 * HOUR) / HOUR)], [Math.floor((T0 + DAY_MS + 9 * HOUR) / HOUR), Math.floor((T0 + DAY_MS + 9 * HOUR) / HOUR)]].sort())
    await verified(p)
  })

  it('the tables this reader knows are exactly the contract\'s, and it publishes every one of them, metric tables first', () => {
    expect([...PUBLISHED_TABLES].sort()).toEqual([...CONTRACT_TABLES].sort())
    expect(UNPUBLISHED_TABLES).toEqual([])
    expect(TABLE_NAMES).toEqual(ALL)
    // A table no release knows is refused, explicitly: test/compat.test.ts ("a file of a table this code does not know").
  })
})

describe('a re-base (D55) over the span and log tables', () => {
  it('from the base of a new incarnation after the ledger lost its storage: every table by difference', async () => {
    const { cell, tenant } = fresh()
    const t = tenant('newinc')
    await quietLedger(t)
    await addUnit(t, pairUnit(cell, t, 1, 1, T0 + 1000), { drain: true })
    await addUnit(t, spanUnit(t, 1, T0 + 5 * HOUR), { drain: true })
    await addUnit(t, logUnit(t, 1, T0 + 2000), { drain: true })
    await mirror(t, cell)
    const p = publisher(cell)
    expect((await p.publish([t])).tenants[0]).toMatchObject({ status: 'ok' })
    await loseLedgerStorage(t)
    const l = ledger(t)
    await l.plan({ table: 'metric_samples', minTs: 0, maxTs: 0 })
    await knobs(l, { checkpointEvery: 1e9, checkpointByLogBytes: false })
    await addUnit(t, spanUnit(t, 2, T0 + 6 * HOUR), { drain: true })
    expect((await l.expire({ tables: ['logs'], beforeDay: dayOf(T0 + DAY_MS) })).removed).toHaveLength(1)
    await addUnit(t, pairUnit(cell, t, 2, 2, T0 + 3000), { drain: true })
    await mirror(t, cell)
    const r = await p.publish([t])
    const v = await ledgerVersion(t)
    expect(v.ledgerIncarnation).toBe(2)
    expect(r.tenants[0]).toMatchObject({ status: 'ok', cursors: { metric_samples: v, spans: v, trace_index: v, logs: v }, rebase: { source: 'base' } })
    expect(r.tables.spans).toMatchObject({ added: 1, removed: 0 })
    expect(r.tables.logs).toMatchObject({ added: 0, removed: 1 })
    await asLedger(cell, t)
    for (const s of SIGNALS) await expectEntriesOfFiles(cell, t, s)
    await verified(p)
  })

  for (const format of ['parts', 'one'] as const) {
    it(`from a checkpoint (${format === 'parts' ? 'format 2, in parts' : 'format 1, one object'}): its span and log files staged and published; a tombstone of one released by the snapshot rule`, async () => {
      const { cell, tenant } = fresh()
      const t = tenant(`ckpt-${format}`)
      const l = await quietLedger(t)
      await knobs(l, { checkpointOneObjectBytes: format === 'one' ? 1e12 : -1, checkpointPartBytes: 600 })
      for (let i = 1; i <= 4; i++) await addUnit(t, pairUnit(cell, t, i, i, T0 + (i % 2) * DAY_MS + i * 1000), { drain: true })
      for (let i = 1; i <= 3; i++) await addUnit(t, spanUnit(t, i, T0 + DAY_MS + i * HOUR), { drain: true })
      await addUnit(t, logUnit(t, 1, T0 + 5000), { drain: true })
      await addUnit(t, logUnit(t, 2, T0 + DAY_MS + 5000), { drain: true })
      const expiredLog = (await l.expire({ tables: ['logs'], beforeDay: dayOf(T0 + DAY_MS) })).removed
      expect(expiredLog).toHaveLength(1)
      await l.drain()
      await knobs(l, { checkpointEvery: 1 })
      await addUnit(t, pairUnit(cell, t, 5, 5, T0 + DAY_MS + 5000), { drain: true })
      const checkpointAt = (await ledgerVersion(t)).version
      await knobs(l, { checkpointEvery: 1e9 })
      await addUnit(t, spanUnit(t, 4, T0 + DAY_MS + 9 * HOUR), { drain: true })
      await addUnit(t, pairUnit(cell, t, 6, 6, T0 + DAY_MS + 6000), { drain: true })
      await mirror(t, cell)
      const ckpt = await listKeys(`${cell}/ledger/tenant=${t}/1/ckpt-`)
      if (format === 'parts') expect(ckpt.filter((k) => /\/\d{6}\.jsonl$/.test(k)).length).toBeGreaterThan(1)
      else expect(ckpt).toHaveLength(1)

      const p = publisher(cell)
      await p.configure({ deleteGraceMs: 60_000, snapshotWindowMs: HOUR })
      const r = await p.publish([t])
      const v = await ledgerVersion(t)
      expect(r.tenants[0]).toMatchObject({ status: 'ok', cursors: { metric_samples: v, metric_series: v, spans: v, trace_index: v, logs: v }, rebase: { source: 'checkpoint', format: format === 'parts' ? 2 : 1, version: checkpointAt } })
      expect([r.tables.spans.added, r.tables.trace_index.added, r.tables.logs.added]).toEqual([4, 4, 1])
      await asLedger(cell, t)
      for (const s of SIGNALS) await expectEntriesOfFiles(cell, t, s)
      await verified(p)
      expect(await p.scratch()).toEqual({ stage: 0, liveNext: 0 })
      // The log file expired before the checkpoint is one of its tombstones, recorded as removed by
      // the commit's snapshot: released once no older snapshot is retained, then the grace.
      await p.advanceClock(60_001)
      expect(await p.safeToDelete(t)).toEqual(expiredLog)
    })
  }

  it('review P-1 over the span and log tables: spans committed, trace_index not, then a checkpoint above the spans cursor: nothing skipped, nothing twice', async () => {
    const { cell, tenant } = fresh()
    const t = tenant('p1')
    const l = await quietLedger(t)
    await knobs(l, { checkpointOneObjectBytes: -1, checkpointPartBytes: 600 })
    for (let i = 1; i <= 2; i++) await addUnit(t, pairUnit(cell, t, i, i, T0 + i * 1000), { drain: true })
    await addUnit(t, spanUnit(t, 1, T0 + 2 * HOUR), { drain: true })
    await addUnit(t, logUnit(t, 1, T0 + 3000), { drain: true })
    await mirror(t, cell)
    // The metric tables and spans commit; trace_index fails after writing its manifests, so it and logs have no cursor.
    const p = publisher(cell)
    await p.failAt('manifests-written', 'trace_index')
    expect((await p.tryPublish([t])).error).toMatch(/injected/)
    const at = await ledgerVersion(t)
    expect((await p.cursors('spans'))[t]).toEqual(at)
    expect((await p.cursors('trace_index'))[t]).toBeUndefined()
    expect((await p.cursors('logs'))[t]).toBeUndefined()
    // Before the retry: more spans, logs and metrics, a span day expired, and a checkpoint above that cursor.
    await addUnit(t, spanUnit(t, 2, T0 + DAY_MS + 3 * HOUR), { drain: true })
    await addUnit(t, logUnit(t, 2, T0 + DAY_MS + 1000), { drain: true })
    expect((await l.expire({ tables: ['spans', 'trace_index'], beforeDay: dayOf(T0 + DAY_MS) })).removed).toHaveLength(2)
    await knobs(l, { checkpointEvery: 1 })
    await addUnit(t, pairUnit(cell, t, 3, 3, T0 + DAY_MS + 6000), { drain: true })
    await knobs(l, { checkpointEvery: 1e9 })
    await addUnit(t, spanUnit(t, 3, T0 + DAY_MS + 4 * HOUR), { drain: true })
    await mirror(t, cell)
    const r = await p.publish([t])
    const v = await ledgerVersion(t)
    expect(r.tenants[0]).toMatchObject({ status: 'ok', rebase: { source: 'checkpoint', format: 2 }, cursors: { metric_samples: v, spans: v, trace_index: v, logs: v } })
    // spans: its cursor is below the checkpoint, so it is re-based too (the P-1 path): one file removed, two added.
    expect(r.tables.spans).toMatchObject({ added: 2, removed: 1 })
    expect(r.tables.trace_index).toMatchObject({ added: 2, removed: 0 })
    await asLedger(cell, t)
    for (const s of SIGNALS) await expectEntriesOfFiles(cell, t, s)
    await verified(p)
  })

  it('the first publish after an upgrade from the D64 release re-bases every tenant once and publishes its span and log tables; the metric tables are not committed again', async () => {
    const { cell, tenant } = fresh()
    const t = tenant('upgrade')
    const l = await quietLedger(t)
    await addUnit(t, pairUnit(cell, t, 1, 1, T0 + 1000), { drain: true })
    await addUnit(t, spanUnit(t, 1, T0 + 5 * HOUR), { drain: true })
    await addUnit(t, logUnit(t, 1, T0 + 2000), { drain: true })
    await knobs(l, { checkpointEvery: 1 })
    await addUnit(t, pairUnit(cell, t, 2, 2, T0 + 3000), { drain: true })
    await knobs(l, { checkpointEvery: 1e9 })
    await addUnit(t, logUnit(t, 2, T0 + DAY_MS + 2000), { drain: true })
    expect((await l.expire({ tables: ['logs'], beforeDay: dayOf(T0 + DAY_MS) })).removed).toHaveLength(1)
    await mirror(t, cell)
    const old = d64(cell)
    await old.configure({ deleteGraceMs: 60_000 })
    const before = (await old.publish([t])).tenants[0]!
    expect(before).toMatchObject({ status: 'ok', unpublished: { spans: 1, trace_index: 1, logs: 1 } })
    for (const s of SIGNALS) expect(await listKeys(`${cell}/iceberg/${s}/`)).toEqual([])
    const metricBefore = await icebergObjects(cell, TABLES)
    const wrote = await runInDurableObject(old, (_i, s) => ({ dump: dumpOf(s), row: schemaRow(s) }))
    expect(wrote.row).toMatchObject({ version: 4, compat: 1 })

    // The upgrade: this release on the D64 release's storage (the same schema version: no migration).
    const p = publisher(cell)
    await p.pending()
    await install(p, wrote.dump)
    const r = await p.publish([t])
    const v = await ledgerVersion(t)
    expect(r.tenants[0]).toMatchObject({ status: 'ok', rebase: { source: 'checkpoint' }, cursors: { metric_samples: v, spans: v, trace_index: v, logs: v } })
    for (const table of TABLES) expect(r.tables[table].snapshotId, table).toBeNull()
    expect(await icebergObjects(cell, TABLES)).toEqual(metricBefore)
    expect([r.tables.spans.added, r.tables.trace_index.added, r.tables.logs.added]).toEqual([1, 1, 1])
    await asLedger(cell, t)
    await verified(p)
    const after = await runInDurableObject(p, (_i, s) => ({ dump: dumpOf(s), row: schemaRow(s) }))
    expect(after.row).toMatchObject({ version: 4, compat: 1 })
    // The D64 release's record is left as it was; this release reports nothing unpublished.
    expect(after.dump.rows.unpublished).toEqual(wrote.dump.rows.unpublished)
    expect(await p.unpublished()).toEqual([])
    // The log file D64 released stays released (it was never published).
    await p.advanceClock(60_001)
    expect(await p.safeToDelete(t)).toEqual([logUnit(t, 1, T0 + 2000).files[0]!.key])
    // From the cursor afterwards: as any tenant.
    await addUnit(t, spanUnit(t, 2, T0 + DAY_MS + 6 * HOUR), { drain: true })
    await mirror(t, cell)
    const r2 = await p.publish([t])
    expect(r2.tenants[0]!.rebase).toBeUndefined()
    expect(r2.tables.spans).toMatchObject({ added: 1 })
    await asLedger(cell, t)
  })
})

describe('this release and the D64 release side by side (D64 is the oldest rollback target once INGEST_SIGNALS is on)', () => {
  it('a rollback to D64 on this release\'s storage: D64 publishes the metrics and leaves the span and log tables alone, releasing none of their files; rolled forward, this release catches up', async () => {
    const { cell, tenant } = fresh()
    const t = tenant('rollback')
    const l = await quietLedger(t)
    await addUnit(t, pairUnit(cell, t, 1, 1, T0 + 1000), { drain: true })
    await addUnit(t, spanUnit(t, 1, T0 + 4 * HOUR), { drain: true })
    await addUnit(t, logUnit(t, 1, T0 + 5000), { drain: true })
    await mirror(t, cell)
    const now = publisher(cell)
    await now.configure({ deleteGraceMs: 60_000 })
    expect((await now.publish([t])).tenants[0]).toMatchObject({ status: 'ok' })
    const wroteN = await runInDurableObject(now, (_i, s) => ({ dump: dumpOf(s), row: schemaRow(s) }))
    expect(wroteN.row).toMatchObject({ version: 4, compat: 1 })
    const signalObjects = await icebergObjects(cell, SIGNALS)
    expect(Object.keys(signalObjects).length).toBeGreaterThan(10)

    // Rollback: D64's code on this release's storage. More metrics, logs and spans; the first day's logs expire.
    const old = d64(cell)
    await old.pending()
    await install(old, wroteN.dump)
    await addUnit(t, pairUnit(cell, t, 2, 2, T0 + 6000), { drain: true })
    await addUnit(t, logUnit(t, 2, T0 + DAY_MS + 7000), { drain: true })
    const expired = (await l.expire({ tables: ['logs'], beforeDay: dayOf(T0 + DAY_MS) })).removed
    expect(expired).toHaveLength(1)
    await addUnit(t, spanUnit(t, 2, T0 + 5 * HOUR), { drain: true })
    await mirror(t, cell)
    const r = (await old.publish([t])).tenants[0]!
    expect(r).toMatchObject({ status: 'ok', cursors: { metric_samples: await ledgerVersion(t) } })
    await asLedger(cell, t, TABLES)
    await old.advanceClock(7 * DAY_MS)
    await old.maintain()
    // Not the expired log file: this release's `logs` table exists in the cell, and its snapshots reference it.
    expect(await old.safeToDelete(t)).toEqual([])
    expect(await icebergObjects(cell, SIGNALS)).toEqual(signalObjects)
    const wroteD64 = await runInDurableObject(old, (_i, s) => ({ dump: dumpOf(s), row: schemaRow(s) }))
    expect(wroteD64.row).toMatchObject({ version: 4, compat: 1 })
    const cursorsOf = (d: typeof wroteN.dump, tbl: string) => d.rows.cursor!.filter((c) => c.tbl === tbl)
    for (const s of SIGNALS) expect(cursorsOf(wroteD64.dump, s), s).toEqual(cursorsOf(wroteN.dump, s))
    expect(wroteD64.dump.rows.live!.filter((x) => SIGNALS.includes(x.tbl as SignalTable))).toEqual(wroteN.dump.rows.live!.filter((x) => SIGNALS.includes(x.tbl as SignalTable)))

    // Rolled forward on what D64 left: the span and log tables catch up from their cursors.
    await install(now, wroteD64.dump)
    const f = await now.publish([t])
    expect(f.tenants[0]).toMatchObject({ status: 'ok', cursors: { spans: await ledgerVersion(t), logs: await ledgerVersion(t), metric_samples: await ledgerVersion(t) } })
    expect(f.tenants[0]!.rebase).toBeUndefined()
    expect(f.tables.logs).toMatchObject({ added: 1, removed: 1 })
    expect(f.tables.spans).toMatchObject({ added: 1, removed: 0 })
    for (const table of TABLES) expect(f.tables[table].snapshotId, table).toBeNull()
    await asLedger(cell, t)
    await verified(now)
    expect(await now.pending()).toEqual([])
    await evictDurableObject(now)
    expect(await metadataVersions(cell, 'logs')).toEqual([1, 2])
    // The expired log file: removed by snapshot 2 of `logs`, released once snapshot 1 is no longer retained.
    await now.advanceClock(60_001)
    expect(await now.safeToDelete(t)).toEqual([])
    await now.configure({ snapshotWindowMs: 1 })
    await addUnit(t, logUnit(t, 3, T0 + DAY_MS + 9000), { drain: true })
    await mirror(t, cell)
    await now.publish([t])
    await now.advanceClock(60_001)
    expect(await now.safeToDelete(t)).toEqual(expired)
  })
})
