import { evictDurableObject, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { expect } from 'vitest'
import { encodeLedgerSegment, ledgerSegmentKey, parseLedgerLogKey, type FileEntry, type FlushUnit, type LedgerChange, type LedgerTable, type Table } from '../../contracts/ledger'
import type { Ledger } from '../../ledger/src/ledger'
import { readAvro } from '../src/avro'
import { CURSORS_KEY, type AnyPartition, type ManifestEntryRecord, type ManifestListRecord, type TableMetadata } from '../src/iceberg'
import type { TestPublisher } from './worker'

export type LedgerStub = DurableObjectStub<Ledger>
export type PublisherStub = DurableObjectStub<TestPublisher>

export const TABLES: Table[] = ['metric_samples', 'metric_series']
export const SHARD = 'pool/0'
export const INC = 7001
export const DAY_MS = 86_400_000
export const T0 = Date.UTC(2026, 10, 10)
export const dayOf = (ts: number) => new Date(ts).toISOString().slice(0, 10)
export const PREFIX = 's3://viz-lake'

let n = 0
/** A cell and tenant names nobody else uses, so tests cannot see each other. */
export const fresh = () => {
  const id = `${Date.now().toString(36)}${n++}`
  return { cell: `c-${id}`, tenant: (name: string) => `${name}-${id}` }
}

export const ledger = (tenant: string): LedgerStub => env.LEDGER.get(env.LEDGER.idFromName(tenant))
export const publisher = (name: string): PublisherStub => env.PUBLISHER.get(env.PUBLISHER.idFromName(name))

/**
 * A synthetic data file under the contract's key layout. The key is under the LEDGER's cell
 * (`env.CELL`), whatever cell the test publishes into: the ledger admits only keys under its own
 * cell (contracts/ledger.ts `FileEntry.key`). Tenant names are unique per test, so keys are too.
 */
export const fileFor = (_cell: string, tenant: string, table: Table, name: string, over: Partial<FileEntry> = {}): FileEntry => {
  const minTs = over.minTs ?? T0
  const day = over.day ?? dayOf(minTs)
  return {
    table,
    day,
    key: `${env.CELL}/data/${table}/tenant=${tenant}/day=${day}/${name}.parquet`,
    bytes: 64,
    rows: 10,
    minTs,
    maxTs: minTs + 999,
    level: 0,
    index: JSON.stringify({ v: 1, rg: [{ rows: 10, off: 4, len: 50, min_name: 'cpu', max_name: 'up', min_ts: minTs, max_ts: minTs + 999 }] }),
    ...over,
  }
}

/** Put a placeholder object of the recorded size for each file, so `verify` finds it. */
export const putObjects = async (files: FileEntry[]) => {
  for (let i = 0; i < files.length; i += 6) {
    await Promise.all(files.slice(i, i + 6).map((f) => env.BUCKET.put(f.key, new Uint8Array(f.bytes))))
  }
}

/** A flush unit with one samples file and one series file, as a flush produces. */
export const pairUnit = (cell: string, tenant: string, seqLo: number, seqHi: number, ts = T0): FlushUnit => ({
  shard: SHARD,
  incarnation: INC,
  seqLo,
  seqHi,
  files: [
    fileFor(cell, tenant, 'metric_samples', `L0-pool_0-${INC}-${seqLo}-${seqHi}`, { minTs: ts }),
    fileFor(cell, tenant, 'metric_series', `L0-pool_0-${INC}-${seqLo}-${seqHi}`, { minTs: ts, rows: 3 }),
  ],
})

/**
 * Admit a unit. With `drain`, its change (and a first unit's registration) is written to R2
 * at once, as a segment of its own; otherwise it waits for the next drain (`mirror` drains),
 * so the changes in between share a segment, as under load.
 */
export const addUnit = async (tenant: string, unit: FlushUnit, opts: { drain?: boolean } = {}) => {
  // The ledger is running before any of the tenant's data objects exist, as in production (flush
  // plans before its first PUT): a ledger that starts empty over data objects refuses (review S-5).
  await ledger(tenant).plan({ table: 'metric_samples', minTs: 0, maxTs: 0 })
  await putObjects(unit.files)
  expect(await ledger(tenant).addUnit(unit)).toMatchObject({ status: 'ok' })
  if (opts.drain) await ledger(tenant).drain()
  return unit
}

/**
 * The Ledger object writes its log under `env.CELL`. Tests give each case its own cell, so
 * this drains the ledger and copies the tenant's log, byte for byte, to the same keys under
 * the test's cell: segments, checkpoints and any first-layout objects. `skip` leaves out the
 * segments holding these versions (to make a hole); `upTo` leaves out segments that end above it.
 */
export const mirror = async (tenant: string, cell: string, opts: { skip?: number[]; upTo?: number } = {}) => {
  await ledger(tenant).drain()
  await copyLog(tenant, env.CELL, cell, opts)
}

/**
 * Remove a tenant's checkpoints from a cell's copy of its log. A re-base starts from the newest
 * checkpoint, so a test about how SEGMENTS are read (a hole, an object of a newer version, a
 * backlog) drops them: otherwise the publisher legitimately starts past what the test put there.
 */
export const dropCheckpoints = async (cell: string, tenant: string) => {
  const keys = (await listKeys(`${cell}/ledger/tenant=${tenant}/`)).filter((k) => k.includes('/ckpt-'))
  if (keys.length > 0) await env.BUCKET.delete(keys)
  return keys.length
}

export const copyLog = async (tenant: string, fromCell: string, toCell: string, opts: { skip?: number[]; upTo?: number } = {}) => {
  const from = `${fromCell}/ledger/tenant=${tenant}/`
  let cursor: string | undefined
  do {
    const page = await env.BUCKET.list({ prefix: from, cursor })
    for (const o of page.objects) {
      const p = parseLedgerLogKey(o.key)
      if (p?.type === 'segment') {
        if (opts.skip?.some((v) => p.firstVersion <= v && v <= p.lastVersion)) continue
        if (opts.upTo !== undefined && p.lastVersion > opts.upTo) continue
      }
      const body = await env.BUCKET.get(o.key)
      await env.BUCKET.put(`${toCell}/ledger/tenant=${tenant}/${o.key.slice(from.length)}`, await body!.arrayBuffer())
    }
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
}

/** The segments of a tenant's incarnation under a cell, in version order: `[first, last]` and the key. */
export const segmentsOf = async (cell: string, tenant: string, incarnation: number) =>
  (await listKeys(`${cell}/ledger/tenant=${tenant}/${incarnation}/seg-`))
    .map((key) => ({ key, p: parseLedgerLogKey(key) }))
    .filter((x): x is { key: string; p: { type: 'segment'; ledgerIncarnation: number; firstVersion: number; lastVersion: number } } => x.p?.type === 'segment')
    .map(({ key, p }) => ({ key, first: p.firstVersion, last: p.lastVersion }))
    .sort((a, b) => a.first - b.first)

/** Write a segment as the ledger would (the contract's codec), with changes given as objects. */
export const putSegment = async (cell: string, tenant: string, incarnation: number, changes: (Omit<Partial<LedgerChange>, 'version'> & { version: number } & Record<string, unknown>)[]) => {
  const key = `${cell}/${ledgerSegmentKey(tenant, incarnation, changes[0]!.version, changes.at(-1)!.version)}`
  await env.BUCKET.put(key, encodeLedgerSegment(tenant, incarnation, changes.map((c) => ({ version: c.version, json: JSON.stringify(c) }))))
  return key
}

export const liveKeys = async (tenant: string, table: LedgerTable): Promise<string[]> =>
  (await ledger(tenant).plan({ table, minTs: 0, maxTs: Number.MAX_SAFE_INTEGER })).files.map((f) => f.key).sort()

export const ledgerVersion = async (tenant: string) => {
  const p = await ledger(tenant).plan({ table: 'metric_samples', minTs: 0, maxTs: 0 })
  return { ledgerIncarnation: p.ledgerIncarnation, version: p.version }
}

export const loseLedgerStorage = async (tenant: string) => {
  const l = ledger(tenant)
  await l.drain()
  await runInDurableObject(l, async (_i, state) => { await state.storage.deleteAll() })
  await evictDurableObject(l)
}

// ───────────────────────────── reading the published table back ─────────────────────────────

export const keyOf = (uri: string, prefix = PREFIX) => {
  if (!uri.startsWith(`${prefix}/`)) throw new Error(`${uri} is not under ${prefix}`)
  return uri.slice(prefix.length + 1)
}

export const metaDir = (cell: string, table: LedgerTable) => `${cell}/iceberg/${table}/metadata/`

export const listKeys = async (prefix: string): Promise<string[]> => {
  const out: string[] = []
  let cursor: string | undefined
  do {
    const page = await env.BUCKET.list({ prefix, cursor })
    out.push(...page.objects.map((o) => o.key))
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
  return out
}

/** Metadata versions present in R2 for a table, ascending. */
export const metadataVersions = async (cell: string, table: LedgerTable): Promise<number[]> =>
  (await listKeys(metaDir(cell, table)))
    .map((k) => /\/v(\d+)\.metadata\.json$/.exec(k)?.[1])
    .filter((v): v is string => v !== undefined)
    .map(Number)
    .sort((a, b) => a - b)

export const readMetadata = async (cell: string, table: LedgerTable, version?: number): Promise<TableMetadata> => {
  const v = version ?? (await metadataVersions(cell, table)).at(-1)
  const o = await env.BUCKET.get(`${metaDir(cell, table)}v${v}.metadata.json`)
  if (!o) throw new Error(`no metadata v${v} for ${table} in ${cell}`)
  return o.json<TableMetadata>()
}

export const readAvroKey = async <T>(key: string): Promise<T[]> => {
  const o = await env.BUCKET.get(key)
  if (!o) throw new Error(`${key} is not in R2`)
  return (await readAvro<T>(new Uint8Array(await o.arrayBuffer()))).records
}

export interface ReadEntry {
  manifest: string
  status: number
  key: string
  tenant: string | null
  /** The `day` partition value, or for `spans` the day of its hour. */
  day: number | null
  /** `spans`: the `start_time_hour` partition value. */
  hour: number | null
  rows: number
  bytes: number
  /** Data sequence number: the entry's own, or inherited from the manifest list. */
  seq: number
  entry: ManifestEntryRecord<AnyPartition>
}

/** Every manifest entry (any status) reachable from one snapshot of a table. */
export const snapshotEntries = async (cell: string, table: LedgerTable, snapshotId?: number, prefix = PREFIX): Promise<ReadEntry[]> => {
  const meta = await readMetadata(cell, table)
  const id = snapshotId ?? meta['current-snapshot-id']
  const snap = meta.snapshots.find((s) => s['snapshot-id'] === id)
  if (!snap) throw new Error(`snapshot ${id} is not in the metadata`)
  const out: ReadEntry[] = []
  for (const m of await readAvroKey<ManifestListRecord>(keyOf(snap['manifest-list'], prefix))) {
    const manifest = keyOf(m.manifest_path, prefix)
    for (const e of await readAvroKey<ManifestEntryRecord<AnyPartition>>(manifest)) {
      const p = e.data_file.partition
      const hour = 'start_time_hour' in p ? p.start_time_hour : null
      out.push({
        manifest,
        status: e.status,
        key: keyOf(e.data_file.file_path, prefix),
        tenant: p.tenant,
        day: 'start_time_hour' in p ? (hour === null ? null : Math.floor(hour / 24)) : p.day,
        hour,
        rows: e.data_file.record_count,
        bytes: e.data_file.file_size_in_bytes,
        seq: e.sequence_number ?? m.sequence_number,
        entry: e,
      })
    }
  }
  return out
}

/** Keys of the live data files (status ADDED or EXISTING) of a snapshot, sorted. */
export const icebergLive = async (cell: string, table: LedgerTable, snapshotId?: number, prefix = PREFIX): Promise<string[]> =>
  (await snapshotEntries(cell, table, snapshotId, prefix)).filter((e) => e.status !== 2).map((e) => e.key).sort()

export const manifestList = async (cell: string, table: LedgerTable, prefix = PREFIX): Promise<ManifestListRecord[]> => {
  const meta = await readMetadata(cell, table)
  const snap = meta.snapshots.find((s) => s['snapshot-id'] === meta['current-snapshot-id'])
  return readAvroKey<ManifestListRecord>(keyOf(snap!['manifest-list'], prefix))
}

export const expectVerified = async (p: PublisherStub) => {
  for (const table of TABLES) {
    const v = await p.verify(table)
    expect(v, `verify(${table})`).toMatchObject({ ok: true, missingFromIceberg: [], extraInIceberg: [], mismatched: [], missingObjects: [], sizeMismatch: [], problems: [] })
  }
}

type Published = Awaited<ReturnType<PublisherStub['publish']>>

/**
 * Publish until no tenant is left for a later publish by a per-publish cap (`deferred`): after a
 * lost storage each publish first rebuilds one table from R2 (review M-6). Returns every result.
 */
export const publishSettled = async (p: PublisherStub, tenants?: string[], limit = 12): Promise<Published[]> => {
  const out: Published[] = []
  for (;;) {
    const r = await p.publish(tenants)
    out.push(r)
    if (!r.tenants.some((t) => t.status === 'deferred')) return out
    expect(out.length, `still deferred after ${out.length} publishes: ${JSON.stringify(r.tenants)}`).toBeLessThan(limit)
  }
}

/** R2 operations of several publishes, added up. */
export const opsOf = (rs: Published[]) => rs.reduce((a, r) => ({ list: a.list + r.ops.list, get: a.get + r.ops.get, head: a.head + r.ops.head, put: a.put + r.ops.put, delete: a.delete + r.ops.delete }), { list: 0, get: 0, head: 0, put: 0, delete: 0 })

/**
 * What a reader of a table's current snapshot sees, with nothing that depends on how many commits
 * made it: every live data file (its whole `data_file`: path, partition, counts, sizes, bounds,
 * offsets), the snapshot's totals, the cursor object it points at, and the table's metadata without
 * its history, ids and location (the cell's name is replaced).
 */
export async function readerView(cell: string, table: LedgerTable): Promise<unknown> {
  const meta = await readMetadata(cell, table)
  const current = meta.snapshots.find((s) => s['snapshot-id'] === meta['current-snapshot-id'])!
  const files = (await snapshotEntries(cell, table)).filter((e) => e.status !== 2).map((e) => [e.key, e.entry.data_file] as const)
  files.sort(([a], [b]) => (a < b ? -1 : 1))
  const totals = Object.fromEntries(Object.entries(current.summary).filter(([k]) => k.startsWith('total-')))
  const cursors = (await (await env.BUCKET.get(keyOf(current.summary[CURSORS_KEY] as string)))!.json<{ cursors: unknown }>()).cursors
  const { 'table-uuid': _u, location: _l, 'last-updated-ms': _m, 'current-snapshot-id': _c, snapshots: _s, 'snapshot-log': _sl, 'metadata-log': _ml, 'last-sequence-number': _q, refs: _r, ...rest } = meta as unknown as Record<string, unknown>
  return JSON.parse(JSON.stringify({ files, totals, cursors, rest }, (_k, v: unknown) => (v instanceof Uint8Array ? [...v] : v)).replaceAll(cell, 'CELL'))
}
