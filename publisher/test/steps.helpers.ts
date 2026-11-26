/** Helpers shared by `test/steps.test.ts` and `test/steps-review.test.ts`: a tenant log on the real ledger, twin cells, alarm runs, the checks a twin comparison makes. */
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { dataKeyPrefix, type FileEntry, type FlushUnit, type LedgerTable, type SignalTable } from '../../contracts/ledger'
import { CURSORS_KEY, type AnyPartition, type ManifestEntryRecord, type ManifestListRecord } from '../src/iceberg'
import type { PublishResult } from '../src/publisher'
import { dumpOf, install, type Dump } from './storage'
import {
  DAY_MS,
  INC,
  T0,
  TABLES,
  addUnit,
  dayOf,
  fresh,
  icebergLive,
  keyOf,
  ledger,
  ledgerVersion,
  listKeys,
  liveKeys,
  loseLedgerStorage,
  metaDir,
  metadataVersions,
  mirror,
  pairUnit,
  publisher,
  readAvroKey,
  readMetadata,
  readerView,
  type LedgerStub,
  type PublisherStub,
} from './helpers'

export const HOUR = 3_600_000
export const SIGNALS: SignalTable[] = ['spans', 'trace_index', 'logs']
export const ALL: LedgerTable[] = [...TABLES, ...SIGNALS]
/**
 * Deadlines no alarm reaches by itself while a test runs (some run for minutes): the tests run each
 * alarm, which publishes whatever is pending whenever it runs. An alarm firing by itself would take a
 * cut a test armed for its own run.
 */
export const QUIET = { continueMs: 1e9, retryMs: 1e9 }
/** The budget of a capped publish here, and the manifests' size: a re-base of a few dozen files takes several runs. */
export const BUDGET = 5
export const ENTRIES = 3
/** A checkpoint part holds at most this many records here (`partBytes` 600: a file's record is about 450 bytes, a tombstone's about 150). */
export const PART_RECORDS = 4

export const d64 = (name: string) => env.PUBLISHER_D64.get(env.PUBLISHER_D64.idFromName(name))
export const m6 = (name: string) => env.PUBLISHER_M6.get(env.PUBLISHER_M6.idFromName(name))

export type Knobs = { checkpointEvery: number; checkpointByLogBytes: boolean; checkpointOneObjectBytes: number; checkpointPartBytes: number }
export const knobs = (l: LedgerStub, k: Partial<Knobs>) => runInDurableObject(l, (i: unknown) => void Object.assign(i as object, k))

export const signalFile = (t: string, table: SignalTable, name: string, ts: number): FileEntry => ({
  table,
  day: dayOf(ts),
  key: `${dataKeyPrefix(env.CELL, table, t, dayOf(ts), table === 'spans' ? new Date(ts).getUTCHours() : undefined)}${name}.parquet`,
  bytes: 96,
  rows: 7,
  minTs: ts,
  maxTs: ts + 999,
  level: 0,
  index: JSON.stringify({ v: 1, rg: [{ rows: 7, off: 4, len: 80, min_name: 'api', max_name: 'web', min_tid: '0a'.repeat(16), max_tid: 'f0'.repeat(16), min_ts: String(ts * 1e6), max_ts: String(ts * 1e6 + 999) }], foot: [84, 300] }),
})
export const spanUnit = (t: string, seq: number, ts: number): FlushUnit => ({
  shard: 'pool/traces/0', incarnation: INC, seqLo: seq, seqHi: seq,
  files: [signalFile(t, 'spans', `L0-pool_traces_0-${INC}-${seq}-${seq}-5a5a5a5a`, ts), signalFile(t, 'trace_index', `L0-pool_traces_0-${INC}-${seq}-${seq}-7a7a7a7a`, ts)],
})
export const logUnit = (t: string, seq: number, ts: number): FlushUnit => ({
  shard: 'pool/logs/0', incarnation: INC, seqLo: seq, seqHi: seq,
  files: [signalFile(t, 'logs', `L0-pool_logs_0-${INC}-${seq}-${seq}-1c1c1c1c`, ts)],
})

/** The next sequence number of each of a tenant's shards (the ledger admits them contiguous). */
export const seqs = new Map<string, { metric: number; span: number; log: number }>()
export const next = (t: string, shard: 'metric' | 'span' | 'log') => {
  const s = seqs.get(t) ?? { metric: 1, span: 1, log: 1 }
  seqs.set(t, s)
  return s[shard]++
}

/** `n` rounds of a metric, a span and a log unit (each its own segment), `i` from `from`, over three days. */
export async function units(t: string, from: number, n: number): Promise<void> {
  for (let i = from; i < from + n; i++) {
    const day = T0 + (i % 3) * DAY_MS
    const m = next(t, 'metric')
    await addUnit(t, pairUnit(env.CELL, t, m, m, day + i * 1000), { drain: true })
    await addUnit(t, spanUnit(t, next(t, 'span'), day + (i % 20) * HOUR + 5000), { drain: true })
    await addUnit(t, logUnit(t, next(t, 'log'), day + i * 1000 + 7), { drain: true })
  }
}

/**
 * A tenant whose newest checkpoint is in many small parts (about one file each), with a log expiry
 * before it (tombstones) and units after it, on the real ledger. Returns its ledger.
 */
export async function tenantLog(t: string, rounds = 6, after = 2): Promise<LedgerStub> {
  const l = ledger(t)
  await l.plan({ table: 'metric_samples', minTs: 0, maxTs: 0 })
  await knobs(l, { checkpointEvery: 1e9, checkpointByLogBytes: false, checkpointOneObjectBytes: -1, checkpointPartBytes: 600 })
  await units(t, 1, rounds)
  if (rounds >= 3) expect((await l.expire({ tables: ['logs'], beforeDay: dayOf(T0 + DAY_MS) })).removed.length).toBeGreaterThan(0)
  await l.drain()
  await checkpointNow(l, t, rounds + 1)
  await units(t, rounds + 2, after)
  return l
}

/** One more metric unit, with a checkpoint (in small parts) at it. */
export async function checkpointNow(l: LedgerStub, t: string, i: number): Promise<void> {
  await knobs(l, { checkpointEvery: 1, checkpointByLogBytes: false, checkpointOneObjectBytes: -1, checkpointPartBytes: 600 })
  const m = next(t, 'metric')
  await addUnit(t, pairUnit(env.CELL, t, m, m, T0 + 2 * DAY_MS + i * 1000), { drain: true })
  await knobs(l, { checkpointEvery: 1e9 })
}

/** One more metric unit. */
export const metricUnit = (t: string, i: number) => {
  const m = next(t, 'metric')
  return addUnit(t, pairUnit(env.CELL, t, m, m, T0 + 2 * DAY_MS + i * 1000), { drain: true })
}

/** The checkpoint parts of a tenant's incarnation under a cell. */
export const partsOf = async (cell: string, t: string, inc: number) => (await listKeys(`${cell}/ledger/tenant=${t}/${inc}/ckpt-`)).filter((k) => /\/ckpt-\d+-[^/]+\/\d+\.jsonl$/.test(k))

/** `cells` published by the D64 release (metrics only), then this release installed on each one's storage: the upgrade to D67. */
export async function upgraded(cells: string[], ts: string[]): Promise<PublisherStub[]> {
  const out: PublisherStub[] = []
  for (const cell of cells) {
    for (const t of ts) await mirror(t, cell)
    const old = d64(cell)
    expect((await old.publish(ts)).tenants.map((x) => x.status)).toEqual(ts.map(() => 'ok'))
    const dump = await runInDurableObject(old, (_i, s) => dumpOf(s))
    const p = publisher(cell)
    await p.pending()
    await install(p, dump)
    out.push(p)
  }
  return out
}

/** One run of the alarm (a publish is due, and the alarm set): the publish it made. */
export async function alarmRun(p: PublisherStub): Promise<PublishResult> {
  await p.publishes()
  const s = await p.schedule()
  expect(s.due.publish, 'a publish is due').toBeDefined()
  expect(s.alarm, 'and the alarm is set').not.toBeNull()
  expect(await runDurableObjectAlarm(p)).toBe(true)
  const published = await p.publishes()
  expect(published).toHaveLength(1)
  return published[0]!
}

/** Alarm runs until nothing is pending. */
export async function alarmRuns(p: PublisherStub, limit = 40): Promise<PublishResult[]> {
  const runs: PublishResult[] = []
  while ((await p.pending()).length > 0) {
    expect(runs.length, `still pending after ${runs.length} alarm runs: ${JSON.stringify(await p.pending())}`).toBeLessThan(limit)
    runs.push(await alarmRun(p))
  }
  return runs
}

/** What a run's re-bases kept across publishes staged and wrote ahead, and what its re-bases read whole staged. */
export const workOf = (r: PublishResult) =>
  r.tenants.reduce((n, t) => n + (t.step ? t.step.staged + t.step.written : t.rebase ? t.rebase.files + t.rebase.tombstones : 0), 0)

/**
 * Every ADDED entry of a table's current snapshot carries the snapshot id of the manifest-list row
 * that lists its manifest (`added_snapshot_id`): the snapshot that added it. Manifests written ahead of
 * a commit carry the id the commit then takes.
 */
export async function addedBySnapshot(cell: string, table: LedgerTable): Promise<void> {
  const meta = await readMetadata(cell, table)
  const snap = meta.snapshots.find((x) => x['snapshot-id'] === meta['current-snapshot-id'])!
  for (const m of await readAvroKey<ManifestListRecord>(keyOf(snap['manifest-list']))) {
    for (const e of await readAvroKey<ManifestEntryRecord<AnyPartition>>(keyOf(m.manifest_path))) {
      if (e.status === 1) expect(e.snapshot_id, `${table}: ${m.manifest_path}`).toBe(m.added_snapshot_id)
    }
  }
}

/** Every table of two cells as a reader sees it, equal; every table of `p` verified; each tenant's files the ledger's. */
export async function sameAsTwin(cell: string, twin: string, p: PublisherStub, ts: string[]): Promise<void> {
  for (const table of ALL) expect(await readerView(cell, table), table).toEqual(await readerView(twin, table))
  for (const table of ALL) await addedBySnapshot(cell, table)
  for (const table of ALL) expect((await p.verify(table)).ok, `verify ${table}`).toBe(true)
  for (const t of ts) for (const table of ALL) expect((await icebergLive(cell, table)).filter((k) => k.includes(`/tenant=${t}/`)), `${t} ${table}`).toEqual(await liveKeys(t, table))
  expect(await p.steps()).toEqual({})
  expect(await p.scratch()).toEqual({ stage: 0, liveNext: 0 })
}

/** The cursors object of every snapshot of a table, by snapshot id. */
export async function snapshotCursors(cell: string, table: LedgerTable): Promise<Map<number, Record<string, { ledgerIncarnation: number; version: number }>>> {
  const out = new Map<number, Record<string, { ledgerIncarnation: number; version: number }>>()
  for (const v of await metadataVersions(cell, table)) {
    const meta = await readMetadata(cell, table, v)
    for (const s of meta.snapshots) {
      if (out.has(s['snapshot-id'])) continue
      const o = await env.BUCKET.get(keyOf(s.summary[CURSORS_KEY] as string))
      if (o) out.set(s['snapshot-id'], (await o.json<{ cursors: Record<string, { ledgerIncarnation: number; version: number }> }>()).cursors)
    }
  }
  return out
}

export type Start = 'upgrade' | 'new tenant' | 'new incarnation'

/**
 * Two cells with the same tenants' logs, in the state where `start` makes every tenant need a re-base:
 * the D67 upgrade (D64's storage, metrics published), nothing published, or everything published and
 * then a new ledger incarnation (written with its own checkpoint in small parts) for the first tenant.
 */
export async function twinCells(start: Start, ts: string[]): Promise<{ cell: string; twin: string; capped: PublisherStub; uncapped: PublisherStub }> {
  const { cell } = fresh()
  const twin = `${cell}t`
  let capped: PublisherStub
  let uncapped: PublisherStub
  if (start === 'upgrade') [capped, uncapped] = (await upgraded([cell, twin], ts)) as [PublisherStub, PublisherStub]
  else {
    for (const t of ts) for (const c of [cell, twin]) await mirror(t, c)
    capped = publisher(cell)
    uncapped = publisher(twin)
    if (start === 'new incarnation') {
      for (const p of [capped, uncapped]) {
        await p.configure({ manifestTargetEntries: ENTRIES, ...QUIET })
        expect((await p.publish(ts)).tenants.map((x) => x.status)).toEqual(ts.map(() => 'ok'))
      }
      // The first tenant's ledger loses its storage: incarnation 2, rebuilt from its log, with a
      // compaction (removals), more units and a checkpoint in small parts.
      const t = ts[0]!
      await loseLedgerStorage(t)
      const l = ledger(t)
      expect((await ledgerVersion(t)).ledgerIncarnation).toBe(2)
      await knobs(l, { checkpointEvery: 1e9, checkpointByLogBytes: false, checkpointOneObjectBytes: -1, checkpointPartBytes: 600 })
      expect((await l.expire({ tables: ['metric_samples', 'metric_series'], beforeDay: dayOf(T0 + DAY_MS) })).removed.length).toBeGreaterThan(0)
      await units(t, 40, 2)
      await checkpointNow(l, t, 50)
      await units(t, 51, 1)
      for (const c of [cell, twin]) await mirror(t, c)
      expect((await partsOf(cell, t, 2)).length).toBeGreaterThan(10)
    }
  }
  await capped.configure({ maxRebaseFilesPerPublish: BUDGET, manifestTargetEntries: ENTRIES, ...QUIET })
  await uncapped.configure({ manifestTargetEntries: ENTRIES, ...QUIET })
  return { cell, twin, capped, uncapped }
}

/** The rows of the tables this release keeps re-bases in, from a dump. */
export const keptRows = (d: Dump) => Object.fromEntries(['rebase_step', 'rebase_stage', 'rebase_manifest'].map((t) => [t, d.rows[t]]))

/** What SQLite says of every table after a rebuild: live files, manifests, cursors, retained snapshots, versions. */
export const rebuilt = (p: PublisherStub | DurableObjectStub) =>
  runInDurableObject(p as PublisherStub, (_i, s) => {
    const q = (sql: string) => s.storage.sql.exec(sql).toArray()
    return {
      live: q(`SELECT * FROM live ORDER BY tbl, key`),
      manifest: q(`SELECT * FROM manifest ORDER BY tbl, path`),
      cursor: q(`SELECT * FROM cursor ORDER BY tbl, tenant`),
      snap: q(`SELECT * FROM snap ORDER BY tbl, snapshot_id`),
      tbl: q(`SELECT * FROM tbl ORDER BY name`),
    }
  })


export const n1 = (name: string) => env.PUBLISHER_N1.get(env.PUBLISHER_N1.idFromName(name))
