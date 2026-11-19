/**
 * The span and log tables in the ledger's log (contracts/TRACES.md, contracts/LOGS.md; the ledger
 * lists them since stage 2, D63), read by a publisher that does not publish them (D64):
 *
 *   - a tenant whose log names `spans`, `trace_index` or `logs` keeps publishing its metrics; the
 *     publisher records those tables as not published (per tenant: live files counted, how far
 *     read) and says so in its report, `unpublished()` and `status`;
 *   - metric publication is byte-identical to that of the same log without those changes, and to
 *     what the release before (N-1, `test/n1/`) publishes from that log;
 *   - files of those tables that the ledger removes are released to the janitor after the delete
 *     grace (no snapshot can reference them), never while a newer publisher has a table of that name;
 *   - a re-base (D55) from a base or a checkpoint counts those files instead of staging them, and
 *     the review P-1 path (one table's cursor below the checkpoint, the other with none) skips
 *     nothing;
 *   - releases N and N-1 side by side: N-1 stops the tenant at the first such change, metrics
 *     included, and releases nothing; a rollback from N to N-1 opens N's storage and publishes
 *     until the next such change, then stops; rolled forward, N catches up. Hence the rollout rule:
 *     `INGEST_SIGNALS` stays off wherever a publisher runs until N is the publisher's rollback floor.
 */
import { evictDurableObject, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { TABLES as CONTRACT_TABLES, dataKeyPrefix, type FileEntry, type FlushUnit, type SignalTable } from '../../contracts/ledger'
import { PUBLISHED_TABLES, UNPUBLISHED_TABLES } from '../src/log'
import {
  DAY_MS,
  INC,
  T0,
  TABLES,
  addUnit,
  dayOf,
  dropCheckpoints,
  expectVerified,
  fileFor,
  fresh,
  icebergLive,
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
  type LedgerStub,
} from './helpers'
import { dumpOf, install, schemaRow } from './storage'

const HOUR = 3_600_000
const TRACES = 'pool/traces/0'
const LOGS = 'pool/logs/0'
const SIGNALS: SignalTable[] = ['spans', 'trace_index', 'logs']

/** A span or log file under the contract's key layout (a `spans` key under its hour), of the ledger's cell. */
const signalFile = (t: string, table: SignalTable, name: string, ts: number): FileEntry => {
  const day = dayOf(ts)
  return {
    table,
    day,
    key: `${dataKeyPrefix(env.CELL, table, t, day, table === 'spans' ? new Date(ts).getUTCHours() : undefined)}${name}.parquet`,
    bytes: 96,
    rows: 7,
    minTs: ts,
    maxTs: ts + 999,
    level: 0,
    index: JSON.stringify({ v: 1, rg: [{ rows: 7, off: 4, len: 80, min_ts: String(ts * 1e6), max_ts: String(ts * 1e6 + 999) }], foot: [84, 300] }),
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

const n1 = (name: string) => env.PUBLISHER_N1.get(env.PUBLISHER_N1.idFromName(name))
const counts = async (t: string) => Object.fromEntries(await Promise.all(SIGNALS.map(async (s) => [s, (await liveKeys(t, s)).length] as const)))
/** The tenant's files in the published tables are exactly its ledger's live metric files. */
const metricsAsLedger = async (cell: string, t: string) => {
  for (const table of TABLES) expect((await icebergLive(cell, table)).filter((k) => k.includes(`/tenant=${t}/`)), table).toEqual(await liveKeys(t, table))
}
const noSignalTables = async (cell: string) => {
  for (const s of SIGNALS) expect(await listKeys(`${cell}/iceberg/${s}/`), s).toEqual([])
}

/** Every object under the cell's Iceberg prefix, with its bytes (hex). */
async function icebergObjects(cell: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const k of await listKeys(`${cell}/iceberg/`)) {
    const b = new Uint8Array(await (await env.BUCKET.get(k))!.arrayBuffer())
    out[k] = [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
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

describe('a publisher that reads the span and log tables and does not publish them', () => {
  it('a tenant with span and log changes keeps publishing its metrics, and records the other tables as not published', async () => {
    const { cell, tenant } = fresh()
    const t = tenant('keeps')
    await quietLedger(t)
    await addUnit(t, pairUnit(cell, t, 1, 1, T0 + 1000), { drain: true })
    await addUnit(t, spanUnit(t, 1, T0 + 5 * HOUR), { drain: true })
    await addUnit(t, logUnit(t, 1, T0 + 2000))
    await addUnit(t, pairUnit(cell, t, 2, 2, T0 + DAY_MS + 1000), { drain: true })
    await mirror(t, cell)
    const p = publisher(cell)
    const r = await p.publish([t])
    expect(r.tenants).toEqual([
      expect.objectContaining({ tenant: t, status: 'ok', cursors: { metric_samples: await ledgerVersion(t), metric_series: await ledgerVersion(t) }, unpublished: { spans: 1, trace_index: 1, logs: 1 } }),
    ])
    expect(r.tables.metric_samples).toMatchObject({ added: 2, removed: 0 })
    await metricsAsLedger(cell, t)
    await noSignalTables(cell)
    expect(await p.pending()).toEqual([])
    await expectVerified(p)
    // What it records, and its status.
    const v = await ledgerVersion(t)
    expect(await p.unpublished(t)).toEqual(
      ['logs', 'spans', 'trace_index'].map((table) => ({ table, tenant: t, cursor: v, files: 1, origin: 'base', firstSeen: expect.any(Number), lastSeen: expect.any(Number) })),
    )
    for (const s of SIGNALS) expect(await p.status(s), s).toEqual({ published: false, version: 0, snapshotId: null, seq: 0, files: 0, manifests: 0, metadataKey: null, unpublished: { tenants: 1, files: 1 } })
    expect(await p.status('metric_samples')).toMatchObject({ published: true, files: 2 })

    // From the cursor: more spans, a log day expired, more metrics. The metric tables move on; the record follows the ledger.
    await addUnit(t, spanUnit(t, 2, T0 + DAY_MS + 6 * HOUR), { drain: true })
    await addUnit(t, logUnit(t, 2, T0 + DAY_MS + 3000), { drain: true })
    expect((await ledger(t).expire({ tables: ['logs'], beforeDay: dayOf(T0 + DAY_MS) })).removed).toHaveLength(1)
    await addUnit(t, pairUnit(cell, t, 3, 3, T0 + DAY_MS + 4000), { drain: true })
    await mirror(t, cell)
    const r2 = await p.publish([t])
    expect(r2.tenants[0]).toMatchObject({ status: 'ok', cursors: { metric_samples: await ledgerVersion(t) }, unpublished: await counts(t) })
    expect(r2.tenants[0]!.rebase).toBeUndefined()
    expect(await counts(t)).toEqual({ spans: 2, trace_index: 2, logs: 1 })
    await metricsAsLedger(cell, t)
    await noSignalTables(cell)
    await expectVerified(p)
    expect((await p.unpublished(t)).map((x) => [x.table, x.files, x.cursor.version])).toEqual([['logs', 1, (await ledgerVersion(t)).version], ['spans', 2, (await ledgerVersion(t)).version], ['trace_index', 2, (await ledgerVersion(t)).version]])
    // A publish with nothing new changes nothing, and counts nothing twice.
    const r3 = await p.publish([t])
    expect(r3.tenants[0]).toMatchObject({ status: 'ok', unpublished: { spans: 2, trace_index: 2, logs: 1 } })
    expect(r3.tables.metric_samples.snapshotId).toBeNull()
  })

  it('metric publication is byte-identical with and without the span and log changes, and to release N-1 on the log without them', async () => {
    const { cell, tenant } = fresh()
    const t = tenant('bytes')
    const l = await quietLedger(t)
    await addUnit(t, pairUnit(cell, t, 1, 1, T0 + 1000), { drain: true })
    await addUnit(t, spanUnit(t, 1, T0 + 5 * HOUR), { drain: true })
    await addUnit(t, logUnit(t, 1, T0 + 2000))
    await addUnit(t, pairUnit(cell, t, 2, 2, T0 + DAY_MS + 1000), { drain: true })
    const stage1 = await segmentsNow(t)
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
    const stage2 = await segmentsNow(t)
    expect(Object.values(stage2).join('')).toMatch(/"table":"spans"/)

    type Run = { publish: (tenants: string[]) => Promise<{ tenants: { status: string; unpublished?: unknown }[] }>; determinism: (seed: number, now: number) => Promise<void> }
    const variants: [string, Run, (body: string) => string][] = [
      ['N, the log as written', publisher(`${cell}~full`) as unknown as Run, (b) => b],
      ['N, the log without span and log changes', publisher(`${cell}~stripped`) as unknown as Run, withoutSignals],
      ['N-1, the log without span and log changes', n1(`${cell}~n1`) as unknown as Run, withoutSignals],
    ]
    const runs: Record<string, Record<string, string>[]> = {}
    for (const [name, p, rewrite] of variants) {
      for (const k of await listKeys(`${cell}/`)) await env.BUCKET.delete(k)
      await p.determinism(20261119, Date.UTC(2026, 10, 19))
      runs[name] = []
      for (const stage of [stage1, stage2]) {
        for (const [k, body] of Object.entries(stage)) await env.BUCKET.put(`${cell}/${k}`, rewrite(body))
        const r = await p.publish([t])
        expect(r.tenants[0], name).toMatchObject({ status: 'ok' })
        expect(r.tenants[0]!.unpublished !== undefined, name).toBe(rewrite === variants[0]![2])
        await metricsAsLedger(cell, t)
        runs[name]!.push(await icebergObjects(cell))
      }
    }
    const [full, stripped, before] = variants.map(([name]) => runs[name]!)
    for (const i of [0, 1]) {
      const keys = Object.keys(full![i]!).sort()
      expect(keys.length, `stage ${i + 1}`).toBeGreaterThanOrEqual(10)
      expect(stripped![i], `stage ${i + 1}: N without the changes`).toEqual(full![i])
      expect(before![i], `stage ${i + 1}: N-1 without the changes`).toEqual(full![i])
    }
  })

  it('the files of those tables that the ledger removes are released to the janitor after the grace, never while a newer publisher has a table of that name', async () => {
    const { cell, tenant } = fresh()
    const t = tenant('release')
    const l = await quietLedger(t)
    await addUnit(t, pairUnit(cell, t, 1, 1, T0 + 1000), { drain: true })
    await addUnit(t, logUnit(t, 1, T0 + 2000), { drain: true })
    await addUnit(t, spanUnit(t, 1, T0 + 3 * HOUR), { drain: true })
    await mirror(t, cell)
    const p = publisher(cell)
    await p.configure({ deleteGraceMs: 60_000 })
    expect((await p.publish([t])).tenants[0]).toMatchObject({ status: 'ok' })
    // Retention of the logs and the traces of day 0; the metrics stay.
    const gone = [...(await l.expire({ tables: ['logs'], beforeDay: dayOf(T0 + DAY_MS) })).removed, ...(await l.expire({ tables: ['spans', 'trace_index'], beforeDay: dayOf(T0 + DAY_MS) })).removed].sort()
    expect(gone).toHaveLength(3)
    await mirror(t, cell)
    expect((await p.publish([t])).tenants[0]).toMatchObject({ status: 'ok', unpublished: { spans: 0, trace_index: 0, logs: 0 } })
    expect(await p.safeToDelete(t)).toEqual([])
    await p.advanceClock(60_001)
    expect(await p.safeToDelete(t)).toEqual(gone)
    // Never a live key, never a metric key that is published.
    for (const table of TABLES) for (const k of await liveKeys(t, table)) expect(gone).not.toContain(k)
    await p.acknowledgeDeleted(t, gone)
    expect(await p.safeToDelete(t)).toEqual([])

    // A cell where a newer publisher publishes `logs` (an object under its table): nothing of `logs` is released by this one.
    const other = fresh()
    const u = other.tenant('guarded')
    const lu = await quietLedger(u)
    await addUnit(u, pairUnit(other.cell, u, 1, 1, T0 + 1000), { drain: true })
    await addUnit(u, logUnit(u, 1, T0 + 2000), { drain: true })
    await addUnit(u, spanUnit(u, 1, T0 + 3 * HOUR), { drain: true })
    await mirror(u, other.cell)
    const q = publisher(other.cell)
    await q.configure({ deleteGraceMs: 60_000 })
    expect((await q.publish([u])).tenants[0]).toMatchObject({ status: 'ok' })
    await env.BUCKET.put(`${other.cell}/iceberg/logs/metadata/v1.metadata.json`, '{"format-version":2}')
    const logsGone = (await lu.expire({ tables: ['logs'], beforeDay: dayOf(T0 + DAY_MS) })).removed
    const spansGone = (await lu.expire({ tables: ['spans', 'trace_index'], beforeDay: dayOf(T0 + DAY_MS) })).removed
    await mirror(u, other.cell)
    expect((await q.publish([u])).tenants[0]).toMatchObject({ status: 'ok', unpublished: { logs: 0, spans: 0 } })
    await q.advanceClock(60_001)
    expect(await q.safeToDelete(u)).toEqual([...spansGone].sort())
    for (const k of logsGone) expect(await q.safeToDelete(u)).not.toContain(k)
  })

  it('the tables this reader knows are exactly the contract\'s: a table the contract adds stops a tenant here until this reader is taught it', () => {
    expect([...PUBLISHED_TABLES, ...UNPUBLISHED_TABLES].sort()).toEqual([...CONTRACT_TABLES].sort())
    expect(PUBLISHED_TABLES).toEqual(TABLES)
    // A table no release knows is refused, explicitly: test/compat.test.ts ("a file of a table this code does not know").
  })
})

describe('a re-base (D55) over a log with the span and log tables', () => {
  it('from the base of a new incarnation after the ledger lost its storage: metrics by difference, the record counted again from the base', async () => {
    const { cell, tenant } = fresh()
    const t = tenant('newinc')
    await quietLedger(t)
    await addUnit(t, pairUnit(cell, t, 1, 1, T0 + 1000), { drain: true })
    await addUnit(t, spanUnit(t, 1, T0 + 5 * HOUR), { drain: true })
    await addUnit(t, logUnit(t, 1, T0 + 2000), { drain: true })
    await mirror(t, cell)
    const p = publisher(cell)
    expect((await p.publish([t])).tenants[0]).toMatchObject({ status: 'ok', unpublished: { spans: 1, trace_index: 1, logs: 1 } })
    await loseLedgerStorage(t)
    const l = ledger(t)
    await l.plan({ table: 'metric_samples', minTs: 0, maxTs: 0 })
    await knobs(l, { checkpointEvery: 1e9, checkpointByLogBytes: false })
    await addUnit(t, spanUnit(t, 2, T0 + 6 * HOUR), { drain: true })
    await addUnit(t, pairUnit(cell, t, 2, 2, T0 + 3000), { drain: true })
    await mirror(t, cell)
    const r = await p.publish([t])
    expect(r.tenants[0]).toMatchObject({ status: 'ok', cursors: { metric_samples: await ledgerVersion(t) }, rebase: { source: 'base', unpublished: { spans: 1, trace_index: 1, logs: 1 } }, unpublished: await counts(t) })
    expect((await ledgerVersion(t)).ledgerIncarnation).toBe(2)
    expect(await counts(t)).toEqual({ spans: 2, trace_index: 2, logs: 1 })
    expect((await p.unpublished(t)).map((x) => [x.table, x.origin, x.cursor])).toEqual(['logs', 'spans', 'trace_index'].map((s) => [s, 'base', expect.objectContaining({ ledgerIncarnation: 2 })]))
    await metricsAsLedger(cell, t)
    await noSignalTables(cell)
    await expectVerified(p)
  })

  for (const format of ['parts', 'one'] as const) {
    it(`from a checkpoint (${format === 'parts' ? 'format 2, in parts' : 'format 1, one object'}): its span and log files counted, not published; their tombstones released`, async () => {
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
      if (format === 'parts') expect(ckpt.filter((k) => k.includes('-') && /\/\d{6}\.jsonl$/.test(k)).length).toBeGreaterThan(1)
      else expect(ckpt).toHaveLength(1)

      const p = publisher(cell)
      await p.configure({ deleteGraceMs: 60_000 })
      const r = await p.publish([t])
      expect(r.tenants[0]).toMatchObject({
        status: 'ok',
        cursors: { metric_samples: await ledgerVersion(t), metric_series: await ledgerVersion(t) },
        rebase: { source: 'checkpoint', format: format === 'parts' ? 2 : 1, version: checkpointAt, unpublished: { spans: 3, trace_index: 3, logs: 1 } },
        unpublished: { spans: 4, trace_index: 4, logs: 1 },
      })
      expect(await counts(t)).toEqual({ spans: 4, trace_index: 4, logs: 1 })
      // The base's span and log files went to the record, not to `stage`: the metric files published are exactly the ledger's.
      await metricsAsLedger(cell, t)
      await noSignalTables(cell)
      await expectVerified(p)
      expect(await p.scratch()).toEqual({ stage: 0, liveNext: 0 })
      // The log file expired before the checkpoint is one of its tombstones: released after the grace.
      expect(await p.safeToDelete(t)).toEqual([])
      await p.advanceClock(60_001)
      expect(await p.safeToDelete(t)).toEqual(expiredLog)
    })
  }

  it('review P-1: one table\'s cursor below the checkpoint, the other with none, across span and log changes: nothing skipped, nothing counted twice', async () => {
    const { cell, tenant } = fresh()
    const t = tenant('p1')
    const l = await quietLedger(t)
    await knobs(l, { checkpointOneObjectBytes: -1, checkpointPartBytes: 600 })
    for (let i = 1; i <= 3; i++) await addUnit(t, pairUnit(cell, t, i, i, T0 + i * 1000), { drain: true })
    await addUnit(t, spanUnit(t, 1, T0 + 2 * HOUR), { drain: true })
    await mirror(t, cell)
    // metric_samples commits, metric_series fails after writing its manifests (nothing of the record is written either).
    const p = publisher(cell)
    await p.failAt('manifests-written', 'metric_series')
    expect((await p.tryPublish([t])).error).toMatch(/injected/)
    expect((await p.cursors('metric_samples'))[t]).toEqual(await ledgerVersion(t))
    expect((await p.cursors('metric_series'))[t]).toBeUndefined()
    expect(await p.unpublished(t)).toEqual([])
    // Before the retry: logs, spans and metrics, and a checkpoint above that cursor.
    await addUnit(t, logUnit(t, 1, T0 + DAY_MS + 1000), { drain: true })
    for (let i = 4; i <= 5; i++) await addUnit(t, pairUnit(cell, t, i, i, T0 + DAY_MS + i * 1000), { drain: true })
    await addUnit(t, spanUnit(t, 2, T0 + DAY_MS + 3 * HOUR), { drain: true })
    await knobs(l, { checkpointEvery: 1 })
    await addUnit(t, pairUnit(cell, t, 6, 6, T0 + DAY_MS + 6000), { drain: true })
    await knobs(l, { checkpointEvery: 1e9 })
    await addUnit(t, logUnit(t, 2, T0 + DAY_MS + 7000), { drain: true })
    await addUnit(t, pairUnit(cell, t, 7, 7, T0 + DAY_MS + 7000), { drain: true })
    await mirror(t, cell)
    const r = await p.publish([t])
    expect(r.tenants[0]).toMatchObject({ status: 'ok', rebase: { source: 'checkpoint', format: 2 }, cursors: { metric_samples: await ledgerVersion(t), metric_series: await ledgerVersion(t) } })
    expect(r.tenants[0]!.unpublished).toEqual(await counts(t))
    expect(await counts(t)).toEqual({ spans: 2, trace_index: 2, logs: 2 })
    await metricsAsLedger(cell, t)
    await expectVerified(p)
  })
})

describe('releases N and N-1 side by side (contracts/COMPATIBILITY.md §6): why INGEST_SIGNALS waits for N', () => {
  /** Two metric units, a span unit, a metric unit, a log unit, a metric unit: one segment each, no checkpoint. */
  async function logWithSignals(cell: string, t: string) {
    await quietLedger(t)
    await addUnit(t, pairUnit(cell, t, 1, 1, T0 + 1000), { drain: true })
    await addUnit(t, pairUnit(cell, t, 2, 2, T0 + 2000), { drain: true })
    const before = await ledgerVersion(t)
    await addUnit(t, spanUnit(t, 1, T0 + 4 * HOUR), { drain: true })
    await addUnit(t, pairUnit(cell, t, 3, 3, T0 + 3000), { drain: true })
    await addUnit(t, logUnit(t, 1, T0 + 5000), { drain: true })
    await addUnit(t, pairUnit(cell, t, 4, 4, T0 + 4000), { drain: true })
    return before
  }

  it('N-1 stops the tenant at the first span or log change, metrics included, every time, and releases nothing; N publishes the same log', async () => {
    const a = fresh()
    const t = a.tenant('side')
    const before = await logWithSignals(a.cell, t)
    await mirror(t, a.cell)
    const b = fresh()
    await mirror(t, b.cell)
    const old = n1(a.cell)
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = (await old.publish([t])).tenants[0]!
      // Stopped before the segment that registers the traces stream and admits its first unit.
      expect(r).toMatchObject({ status: 'unsupported', gapAt: before.version + 1, cursors: { metric_samples: before, metric_series: before } })
      expect(r.detail).toMatch(/table "spans", which this publisher does not know/)
      expect(await old.pending()).toEqual([t])
    }
    expect(await icebergLive(a.cell, 'metric_samples')).toHaveLength(2) // units 3 and 4 wait behind it
    await old.advanceClock(7 * DAY_MS)
    expect(await old.safeToDelete(t)).toEqual([])

    const now = publisher(b.cell)
    const r = (await now.publish([t])).tenants[0]!
    expect(r).toMatchObject({ status: 'ok', cursors: { metric_samples: await ledgerVersion(t) }, unpublished: { spans: 1, trace_index: 1, logs: 1 } })
    await metricsAsLedger(b.cell, t)
    expect(await now.pending()).toEqual([])
  })

  it('a rollback from N to N-1 on N\'s storage: N-1 opens it, publishes until the next span or log change, then stops; rolled forward, N catches up and counts right', async () => {
    const { cell, tenant } = fresh()
    const t = tenant('rollback')
    await logWithSignals(cell, t)
    await mirror(t, cell)
    const now = publisher(cell)
    expect((await now.publish([t])).tenants[0]).toMatchObject({ status: 'ok', unpublished: { spans: 1, trace_index: 1, logs: 1 } })
    const wroteN = await runInDurableObject(now, (_i, s) => ({ dump: dumpOf(s), row: schemaRow(s) }))
    expect(wroteN.row).toMatchObject({ version: 4, compat: 1 })

    // Rollback: N-1's code on N's storage (version 4, readable from 1, so N-1 opens it and leaves the version alone).
    const old = n1(cell)
    await old.pending()
    await install(old, wroteN.dump)
    expect((await old.publish([t])).tenants[0]).toMatchObject({ status: 'ok', cursors: { metric_samples: await ledgerVersion(t) } })
    await addUnit(t, pairUnit(cell, t, 5, 5, T0 + 6000), { drain: true })
    await mirror(t, cell)
    expect((await old.publish([t])).tenants[0]).toMatchObject({ status: 'ok', cursors: { metric_samples: await ledgerVersion(t) } })
    await metricsAsLedger(cell, t)
    const stuckAt = await ledgerVersion(t)
    await addUnit(t, logUnit(t, 2, T0 + 7000), { drain: true })
    await addUnit(t, pairUnit(cell, t, 6, 6, T0 + 8000), { drain: true })
    await mirror(t, cell)
    const stuck = (await old.publish([t])).tenants[0]!
    expect(stuck).toMatchObject({ status: 'unsupported', gapAt: stuckAt.version + 1, cursors: { metric_samples: stuckAt } })
    expect(stuck.detail).toMatch(/table "logs"/)
    expect(await old.pending()).toEqual([t])
    expect(await icebergLive(cell, 'metric_samples')).not.toContain(pairUnit(cell, t, 6, 6, T0 + 8000).files[0]!.key)
    const wroteN1 = await runInDurableObject(old, (_i, s) => ({ dump: dumpOf(s), row: schemaRow(s) }))
    expect(wroteN1.row).toMatchObject({ version: 4, compat: 1 })
    // N-1 left N's record alone (it neither reads nor writes the table).
    expect(wroteN1.dump.rows.unpublished).toEqual(wroteN.dump.rows.unpublished)

    // Rolled forward: N on what N-1 left. It catches up past the change N-1 stopped at, and its record counts the ledger's files.
    await install(now, wroteN1.dump)
    const r = await now.publish([t])
    expect(r.tenants[0]).toMatchObject({ status: 'ok', cursors: { metric_samples: await ledgerVersion(t) }, unpublished: await counts(t) })
    expect(await counts(t)).toEqual({ spans: 1, trace_index: 1, logs: 2 })
    await metricsAsLedger(cell, t)
    await expectVerified(now)
    expect(await now.pending()).toEqual([])
    await evictDurableObject(now)
    expect(await now.unpublished(t)).toHaveLength(3)
    expect(await metadataVersions(cell, 'metric_samples')).toEqual([1, 2, 3])
  })
})

// Unused-import guard for helpers this file relies on only through types.
void dropCheckpoints
