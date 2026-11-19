/**
 * The upgrade to D67 at scale, with re-bases capped per publish (review M-6; README, "Capped
 * re-bases: time per publish"). Measured here, in local workerd: the test, the publisher, SQLite and
 * a simulated R2 in one process, on a shared machine (the load is printed). Not on Cloudflare.
 *
 * A cell of T tenants of F files each, every log written directly with the contract's encoders:
 * incarnation 1 is a base segment of the F files at version 1000, a segment adding one metric unit,
 * and a checkpoint in parts (format 2, as the ledger writes above 1 MiB) at 1001. Half the files
 * are metric files (samples and series), half span and log files (spans 25%, `trace_index` 5%,
 * logs 20%), over 30 days, keys of realistic length, index fragments of the contracts' shape.
 *
 * Steps:
 *   first    every tenant published (all five tables), the caps lifted: a first publication
 *   upgrade  the span and log tables forgotten (what the D64 release leaves: metrics published and
 *            cursored, the span and log tables never published), then `publish` again until no
 *            tenant waits, with re-bases capped at `cap` staged files: every publish is timed,
 *            with what it staged and what it committed
 *   rebuild  the publisher's storage lost, then `publish` until settled: a table rebuilt from R2
 *            per publish, then the publish from the cursors found there
 *
 *   BENCH_UPGRADE=8x25000@100000,2x100000@100000 npm run bench -- bench/upgrade.bench.test.ts
 */
import { evictDurableObject, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import {
  LEDGER_CHECKPOINT_PART_MAX_BYTES,
  dataKeyPrefix,
  encodeLedgerCheckpointManifest,
  encodeLedgerCheckpointPart,
  ledgerCheckpointKey,
  ledgerCheckpointPartKey,
  ledgerSegmentKey,
  type LedgerTable,
  type LiveFile,
} from '../../contracts/ledger'
import type { PublishResult } from '../src/publisher'
import type { BenchPublisher } from './worker'

const E = env as unknown as { PUBLISHER: DurableObjectNamespace<BenchPublisher>; BUCKET: R2Bucket; BENCH_UPGRADE?: string }
const CASES = (E.BENCH_UPGRADE || '4x2000@4000').split(',').map((c) => {
  const m = /^(\d+)x(\d+)@(\d+)$/.exec(c.trim())
  if (!m) throw new Error(`BENCH_UPGRADE: ${c} is not TENANTSxFILES@CAP`)
  return { tenants: Number(m[1]), files: 200 * Math.ceil(Number(m[2]) / 200), cap: Number(m[3]) }
})
const CELL = 'cell-up'
const DAY = 86_400_000
const DAY0 = Date.UTC(2026, 9, 20)
const DAYS = 30
const enc = new TextEncoder()
const METRIC_INDEX = JSON.stringify({ v: 1, rg: [0, 1, 2].map((g) => ({ rows: 100_000, off: 4 + g * 4_000_000, len: 4_000_000, min_name: 'http_requests_total', max_name: 'process_cpu_seconds_total', min_ts: 1795000000000, max_ts: 1795003600000 })) })
const dayOf = (d: number) => new Date(DAY0 + d * DAY).toISOString().slice(0, 10)

/** Of every 200 files of a tenant: how many each table has, in key order of the tables. */
const SHARE: [LedgerTable, number][] = [['logs', 40], ['metric_samples', 50], ['metric_series', 50], ['spans', 50], ['trace_index', 10]]

/** The tenant's files, in key order: table by table, day by day (spans hour by hour), names ascending. */
function* filesOf(tenant: string, n: number, unit: boolean): Generator<LiveFile> {
  let precedence = 0
  for (const [table, share] of SHARE) {
    const count = (n / 200) * share
    const perDay = Math.ceil(count / DAYS)
    for (let j = 0; j < count; j++) {
      const d = Math.floor(j / perDay)
      const day = dayOf(d)
      const hour = table === 'spans' ? Math.floor(((j % perDay) * 24) / perDay) : undefined
      const minTs = DAY0 + d * DAY + (hour ?? 0) * 3_600_000 + 1000
      const name = `L0-${String(j).padStart(7, '0')}-pool_${table === 'logs' ? 'logs' : table.startsWith('metric') ? 'b' : 'traces'}_${j % 8}-${1000 + (j % 8)}-${String(j + 3).padStart(7, '0')}-${((j * 2654435761) >>> 0).toString(16).padStart(8, '0')}`
      const tsNs = String(minTs * 1e6)
      const index = table.startsWith('metric')
        ? METRIC_INDEX
        : JSON.stringify({ v: 1, rg: [{ rows: 50_000, off: 4, len: 3_000_000, min_name: 'api', max_name: 'web', min_tid: '0a'.repeat(16), max_tid: 'f0'.repeat(16), min_ts: tsNs, max_ts: tsNs }], foot: [3_000_004, 9_000] })
      yield {
        table, day, key: `${dataKeyPrefix('cell-0', table, tenant, day, hour)}${name}.parquet`,
        bytes: 8_000_000, rows: 300_000, minTs, maxTs: minTs + 60_000, level: 0, index, precedence, precedenceLow: precedence,
      }
      precedence++
    }
    // The unit after the base: two series files on a day after every base file's.
    if (unit && table === 'metric_series') yield* unitFiles(tenant)
  }
}

function unitFiles(tenant: string): LiveFile[] {
  const day = dayOf(DAYS + 1)
  return [0, 1].map((i) => ({
    table: 'metric_series' as const, day, key: `${dataKeyPrefix('cell-0', 'metric_series', tenant, day)}L0-unit-${i}.parquet`,
    bytes: 8_000_000, rows: 300_000, minTs: DAY0 + (DAYS + 1) * DAY, maxTs: DAY0 + (DAYS + 1) * DAY + 1000, level: 0, index: METRIC_INDEX, precedence: 1e9 + i, precedenceLow: 1e9 + i,
  }))
}

const watermarks = [{ shard: 'pool/b/0', incarnation: 1000, seq: 1000 }]
const header = (kind: string, tenant: string, first: number, last: number) => `${JSON.stringify({ v: 1, kind, tenant, ledgerIncarnation: 1, firstVersion: first, lastVersion: last, changes: last - first + 1 })}\n`

/** One object written from pieces, streamed into a PUT of its exact length: never held whole. */
async function putStreamed(key: string, pieces: () => Iterable<string>): Promise<void> {
  let length = 0
  for (const p of pieces()) length += p.length // ASCII
  const { readable, writable } = new FixedLengthStream(length)
  const put = E.BUCKET.put(key, readable)
  const w = writable.getWriter()
  let buf = ''
  for (const p of pieces()) {
    buf += p
    if (buf.length >= 1 << 16) {
      await w.write(enc.encode(buf))
      buf = ''
    }
  }
  if (buf) await w.write(enc.encode(buf))
  await w.close()
  await put
}

/** Incarnation 1 of a tenant: the base of its files at 1000, a unit at 1001, a checkpoint in parts at 1001. */
async function writeLog(tenant: string, n: number): Promise<void> {
  await putStreamed(`${CELL}/${ledgerSegmentKey(tenant, 1, 1000, 1000)}`, function* () {
    yield header('viz.ledger.segment', tenant, 1000, 1000)
    yield `{"ledgerIncarnation":1,"version":1000,"at":0,"kind":"base","added":[`
    let first = true
    for (const f of filesOf(tenant, n, false)) {
      yield `${first ? '' : ','}${JSON.stringify(f)}`
      first = false
    }
    yield `],"removed":[],"watermarks":${JSON.stringify(watermarks)},"tombstones":[]}\n`
  })
  const change = { ledgerIncarnation: 1, version: 1001, at: 0, kind: 'add_unit', added: unitFiles(tenant), removed: [], watermark: { shard: 'pool/b/0', incarnation: 1000, seq: 1001 }, unit: { seqLo: 1001, seqHi: 1001 } }
  await E.BUCKET.put(`${CELL}/${ledgerSegmentKey(tenant, 1, 1001, 1001)}`, `${header('viz.ledger.segment', tenant, 1001, 1001)}${JSON.stringify(change)}\n`)
  const attempt = '0c0c0c0c'
  let lines: string[] = []
  let size = 0
  let parts = 0
  let bytes = 0
  let files = 0
  const flush = async () => {
    if (lines.length === 0) return
    const put = await E.BUCKET.put(`${CELL}/${ledgerCheckpointPartKey(tenant, 1, 1001, attempt, parts)}`, encodeLedgerCheckpointPart(tenant, 1, 1001, attempt, parts, lines))
    bytes += put!.size
    parts++
    lines = []
    size = 0
  }
  for (const f of filesOf(tenant, n, true)) {
    const line = JSON.stringify({ file: f })
    if (lines.length > 0 && size + line.length + 1 > LEDGER_CHECKPOINT_PART_MAX_BYTES) await flush()
    lines.push(line)
    size += line.length + 1
    files++
  }
  await flush()
  await E.BUCKET.put(`${CELL}/${ledgerCheckpointKey(tenant, 1, 1001)}`, encodeLedgerCheckpointManifest(tenant, { ledgerIncarnation: 1, version: 1001, at: 0, attempt, parts, files, tombstones: 0, bytes, watermarks, previousIncarnations: [] }))
}

async function wipe(prefix: string): Promise<void> {
  for (;;) {
    const page = await E.BUCKET.list({ prefix, limit: 1000 })
    if (page.objects.length === 0) return
    await E.BUCKET.delete(page.objects.map((o) => o.key))
  }
}

const summary = (r: PublishResult, start: number, end: number) => {
  const rebased = r.tenants.filter((t) => t.rebase)
  return {
    ms: end - start,
    start,
    end,
    rebased: rebased.length,
    staged: rebased.reduce((n, t) => n + t.rebase!.files + t.rebase!.tombstones, 0),
    deferred: r.tenants.filter((t) => t.status === 'deferred').length,
    added: Object.fromEntries(Object.entries(r.tables).filter(([, x]) => x.added > 0).map(([k, x]) => [k, x.added])),
    ops: r.ops,
  }
}

describe('the upgrade to D67, re-bases capped per publish', () => {
  for (const c of CASES) {
    it(`${c.tenants} tenants × ${c.files} files, cap ${c.cap}`, async () => {
      await wipe(`${CELL}/`)
      const ts = Array.from({ length: c.tenants }, (_, i) => `t${String(i).padStart(3, '0')}`)
      for (const t of ts) await writeLog(t, c.files)
      const p = E.PUBLISHER.get(E.PUBLISHER.idFromName(`${CELL}~${c.tenants}x${c.files}@${c.cap}`))
      const out: Record<string, unknown> = { ...c }
      await p.configure({ maxRebaseFilesPerPublish: 1e9, maxRebasesPerPublish: 1e6 })
      let t0 = Date.now()
      const first = await p.publish(ts)
      out.first = summary(first, t0, Date.now())
      console.log(`PUBLISH ${JSON.stringify({ case: `${c.tenants}x${c.files}@${c.cap}`, step: 'first', i: 0, ...(out.first as object) })}`)
      expect(first.tenants.every((t) => t.status === 'ok')).toBe(true)

      await p.forgetSignalTables(CELL)
      await p.configure({ maxRebaseFilesPerPublish: c.cap, maxRebasesPerPublish: 100 })
      const upgrade: unknown[] = []
      for (let i = 0; ; i++) {
        expect(i).toBeLessThan(c.tenants + 2)
        t0 = Date.now()
        const r = await p.publish(ts)
        const s = summary(r, t0, Date.now())
        upgrade.push(s)
        console.log(`PUBLISH ${JSON.stringify({ case: `${c.tenants}x${c.files}@${c.cap}`, step: 'upgrade', i, ...s })}`)
        expect(r.tenants.every((t) => t.status === 'ok' || t.status === 'deferred')).toBe(true)
        if (s.deferred === 0) break
      }
      out.upgrade = upgrade
      for (const table of ['spans', 'trace_index', 'logs'] as const) expect((await p.status(table)).files, table).toBe((c.files / 200) * SHARE.find(([t]) => t === table)![1] * c.tenants)

      await runInDurableObject(p, async (_i, s) => {
        await s.storage.deleteAll()
      })
      await evictDurableObject(p)
      const rebuild: unknown[] = []
      for (let i = 0; ; i++) {
        expect(i).toBeLessThan(8)
        t0 = Date.now()
        const r = await p.publish(ts)
        const s = summary(r, t0, Date.now())
        rebuild.push(s)
        console.log(`PUBLISH ${JSON.stringify({ case: `${c.tenants}x${c.files}@${c.cap}`, step: 'rebuild', i, ...s })}`)
        if (s.deferred === 0) break
      }
      out.rebuild = rebuild
      expect((await p.status('metric_samples')).files).toBe((c.files / 200) * 50 * c.tenants)
      console.log(`RESULT ${JSON.stringify(out)}`)
      await wipe(`${CELL}/`)
    })
  }
})
