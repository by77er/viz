/**
 * A publish does bounded work, whatever the number of tenants (review M-6 of the D67 review).
 *
 * The upgrade to D67 leaves every tenant without a cursor in the span and log tables, so every one
 * needs a re-base; before this, the first publish re-based all of them in one invocation, and one
 * cut off by the CPU limit was retried from nothing, so publication could stop for the whole cell.
 *
 *   - a cell whose tenants all need a re-base finishes over several alarm runs, each within the cap
 *     (files staged, or tenants), and ends exactly where one uncapped publish ends: the same data
 *     files with the same partitions, counts and bounds, totals, cursors and table metadata;
 *   - the tenants waiting for their re-base are read from the cursors they have: their metric
 *     tables keep being published, as do the tenants already re-based;
 *   - an invocation cut off in the middle of a re-base (the object reset, as the platform does at
 *     the CPU limit: no `finally` runs) loses nothing committed before it, keeps a deadline for the
 *     alarm, and the re-bases it had started go to the back of the queue;
 *   - a publish reads at most `maxTenantsPerPublish` tenants, longest waiting first, and a tenant
 *     stuck on a hole does not hold the others back.
 *
 * (After a lost storage the publisher rebuilds a table from R2 per publish before it re-bases anyone:
 * `test/signals.test.ts`, "SQLite rebuilt from R2 alone".)
 */
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { dataKeyPrefix, type FileEntry, type FlushUnit, type LedgerTable, type SignalTable } from '../../contracts/ledger'
import { TABLE_NAMES } from '../src/iceberg'
import type { PublishResult } from '../src/publisher'
import { dumpOf, install } from './storage'
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
  ledgerVersion,
  liveKeys,
  metadataVersions,
  mirror,
  pairUnit,
  publisher,
  readerView,
  type PublisherStub,
} from './helpers'

const HOUR = 3_600_000
const SIGNALS: SignalTable[] = ['spans', 'trace_index', 'logs']
const ALL: LedgerTable[] = [...TABLES, ...SIGNALS]
/** Long enough that no alarm fires by itself while a test runs; the tests run each alarm. */
const CONTINUE_MS = 30_000

const signalFile = (t: string, table: SignalTable, name: string, ts: number): FileEntry => ({
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
const spanUnit = (t: string, seq: number, ts: number): FlushUnit => ({
  shard: 'pool/traces/0', incarnation: INC, seqLo: seq, seqHi: seq,
  files: [signalFile(t, 'spans', `L0-pool_traces_0-${INC}-${seq}-${seq}-5a5a5a5a`, ts), signalFile(t, 'trace_index', `L0-pool_traces_0-${INC}-${seq}-${seq}-7a7a7a7a`, ts)],
})
const logUnit = (t: string, seq: number, ts: number): FlushUnit => ({
  shard: 'pool/logs/0', incarnation: INC, seqLo: seq, seqHi: seq,
  files: [signalFile(t, 'logs', `L0-pool_logs_0-${INC}-${seq}-${seq}-1c1c1c1c`, ts)],
})

/** Metrics, spans and logs, each unit its own segment, so the ledger writes a checkpoint (every 3 here); then one more metric unit after it. */
async function tenantLog(cell: string, t: string): Promise<void> {
  await addUnit(t, pairUnit(cell, t, 1, 1, T0 + 1000), { drain: true })
  await addUnit(t, spanUnit(t, 1, T0 + 5 * HOUR), { drain: true })
  await addUnit(t, logUnit(t, 1, T0 + 2000), { drain: true })
  await addUnit(t, pairUnit(cell, t, 2, 2, T0 + DAY_MS + 1000), { drain: true })
}

const d64 = (name: string) => env.PUBLISHER_D64.get(env.PUBLISHER_D64.idFromName(name))

/** `cells` published by the D64 release (metrics only), then this release installed on each one's storage: the upgrade. */
async function upgradedCells(cells: string[], ts: string[]): Promise<PublisherStub[]> {
  const out: PublisherStub[] = []
  for (const cell of cells) {
    for (const t of ts) await mirror(t, cell)
    const old = d64(cell)
    const r = await old.publish(ts)
    expect(r.tenants.map((x) => x.status)).toEqual(ts.map(() => 'ok'))
    for (const s of SIGNALS) expect(await metadataVersions(cell, s)).toEqual([])
    const dump = await runInDurableObject(old, (_i, s) => dumpOf(s))
    const p = publisher(cell)
    await p.pending()
    await install(p, dump)
    out.push(p)
  }
  return out
}

/** Files and tombstones a publish's re-bases staged, and the tenants it re-based. */
const rebasesOf = (r: PublishResult) => {
  const rebased = r.tenants.filter((t) => t.rebase)
  return { tenants: rebased.map((t) => t.tenant), staged: rebased.reduce((n, t) => n + t.rebase!.files + t.rebase!.tombstones, 0) }
}

/** Run the alarm at its publish deadline until nothing is pending. Returns what each run published. */
async function alarmRuns(p: PublisherStub, limit = 12): Promise<PublishResult[]> {
  const runs: PublishResult[] = []
  while ((await p.pending()).length > 0) {
    expect(runs.length, `still pending after ${runs.length} alarm runs: ${JSON.stringify(await p.pending())}`).toBeLessThan(limit)
    runs.push(await alarmRun(p))
  }
  return runs
}

/** One run of the alarm at its publish deadline: the publish it made. */
async function alarmRun(p: PublisherStub): Promise<PublishResult> {
  await p.publishes()
  const s = await p.schedule()
  expect(s.due.publish, 'a publish is due').toBeDefined()
  expect(s.alarm, 'and the alarm is set').not.toBeNull()
  await p.advanceClock(Math.max(0, s.due.publish! - s.now))
  expect(await runDurableObjectAlarm(p)).toBe(true)
  const published = await p.publishes()
  expect(published).toHaveLength(1)
  return published[0]!
}

describe('the upgrade to D67 spread over publishes (review M-6)', () => {
  it('every tenant re-based over several alarm runs, each within the cap on staged files; the tables end exactly as one uncapped publish leaves them', async () => {
    const { cell, tenant } = fresh()
    const ts = [0, 1, 2, 3, 4].map((i) => tenant(`u${i}`))
    for (const t of ts) await tenantLog(cell, t)
    const [capped, uncapped] = await upgradedCells([cell, `${cell}x`], ts)
    const metricBefore = await Promise.all(TABLES.map((t) => metadataVersions(cell, t)))

    // Uncapped (the defaults are far above five small tenants): one publish re-bases all five.
    const one = await uncapped!.publish(ts)
    expect(one.tenants.map((x) => [x.status, !!x.rebase])).toEqual(ts.map(() => ['ok', true]))
    const size = rebasesOf(one).staged / ts.length
    expect(Number.isInteger(size) && size > 0).toBe(true) // every tenant's checkpoint holds the same

    // Capped at two tenants' worth of staged files: no publish starts a third re-base.
    const cap = 2 * size
    await capped!.configure({ maxRebaseFilesPerPublish: cap, continueMs: CONTINUE_MS })
    await capped!.notify(ts)
    const runs = await alarmRuns(capped!)
    expect(runs.map((r) => rebasesOf(r).tenants.length)).toEqual([2, 2, 1])
    for (const r of runs) expect(rebasesOf(r).staged).toBeLessThanOrEqual(cap)
    // Least recently started first, then by name: here, never started, so by name.
    expect(runs.flatMap((r) => rebasesOf(r).tenants)).toEqual(ts)
    // Each run left the rest pending and the alarm set at `continueMs`, not the minute of a retry.
    for (const r of runs.slice(0, -1)) expect(r.tenants.filter((x) => x.status === 'deferred').length).toBeGreaterThan(0)
    expect(await capped!.rebaseQueue()).toEqual({})

    for (const table of ALL) expect(await readerView(cell, table), table).toEqual(await readerView(`${cell}x`, table))
    // The metric tables were not committed again by either: the re-bases found them published.
    expect(await Promise.all(TABLES.map((t) => metadataVersions(cell, t)))).toEqual(metricBefore)
    for (const p of [capped!, uncapped!]) {
      for (const table of ALL) expect((await p.verify(table)).ok, table).toBe(true)
    }
    for (const t of ts) for (const table of ALL) expect((await icebergLive(cell, table)).filter((k) => k.includes(`/tenant=${t}/`)), table).toEqual(await liveKeys(t, table))
  })

  it('the cap on tenants: one re-base per run; the tenants still waiting keep their metrics published from the cursors they have, as do those re-based already', async () => {
    const { cell, tenant } = fresh()
    const ts = [0, 1, 2, 3].map((i) => tenant(`m${i}`))
    for (const t of ts) await tenantLog(cell, t)
    const [p] = await upgradedCells([cell], ts)
    await p!.configure({ maxRebasesPerPublish: 1, continueMs: CONTINUE_MS })
    await p!.notify(ts)

    const r1 = await alarmRun(p!)
    expect(rebasesOf(r1).tenants).toEqual([ts[0]])
    expect(r1.tenants.filter((x) => x.status === 'deferred').map((x) => x.tenant).sort()).toEqual(ts.slice(1))
    // Pending, and the alarm comes back after `continueMs`.
    expect((await p!.pending()).sort()).toEqual(ts.slice(1))
    const s = await p!.schedule()
    expect(s.due.publish! - s.now).toBeLessThanOrEqual(CONTINUE_MS)
    expect(s.alarm).not.toBeNull()

    // New metrics for the last tenant in the queue and for the one re-based already.
    const last = ts[3]!
    const fresh3 = pairUnit(cell, last, 3, 3, T0 + DAY_MS + 3000)
    const fresh0 = pairUnit(cell, ts[0]!, 3, 3, T0 + DAY_MS + 3000)
    await addUnit(last, fresh3, { drain: true })
    await addUnit(ts[0]!, fresh0, { drain: true })
    for (const t of [last, ts[0]!]) await mirror(t, cell)
    await p!.notify([ts[0]!])

    const r2 = await alarmRun(p!)
    expect(rebasesOf(r2).tenants).toEqual([ts[1]])
    // Committed now, though its re-base is two runs away: its metric cursors moved, its span and log tables wait.
    expect(r2.tables.metric_samples.added).toBe(2)
    const samples = await icebergLive(cell, 'metric_samples')
    for (const u of [fresh3, fresh0]) expect(samples).toContain(u.files[0]!.key)
    const waiting = r2.tenants.find((x) => x.tenant === last)!
    expect(waiting).toMatchObject({ status: 'deferred', cursors: { metric_samples: await ledgerVersion(last), metric_series: await ledgerVersion(last) } })
    expect(waiting.rebase).toBeUndefined()
    expect(waiting.cursors.spans).toBeUndefined()
    expect(r2.tenants.find((x) => x.tenant === ts[0])).toMatchObject({ status: 'ok' })
    expect(r2.tenants.find((x) => x.tenant === ts[0])!.rebase).toBeUndefined()

    const rest = await alarmRuns(p!)
    expect(rest.map((r) => rebasesOf(r).tenants)).toEqual([[ts[2]], [ts[3]]])
    for (const t of ts) for (const table of ALL) expect((await icebergLive(cell, table)).filter((k) => k.includes(`/tenant=${t}/`)), `${t} ${table}`).toEqual(await liveKeys(t, table))
    for (const table of ALL) expect((await p!.verify(table)).ok, table).toBe(true)
  })
})

describe('an invocation cut off in the middle of a re-base (as at the CPU limit)', () => {
  it('loses nothing committed before it, leaves the alarm a deadline, and the re-bases it had started go to the back of the queue', async () => {
    const { cell, tenant } = fresh()
    const ts = [0, 1, 2, 3, 4, 5].map((i) => tenant(`k${i}`))
    for (const t of ts) {
      await tenantLog(cell, t)
      await mirror(t, cell)
    }
    const p = publisher(cell)
    await p.configure({ maxRebasesPerPublish: 2, continueMs: CONTINUE_MS })
    await p.notify(ts)

    const r1 = await alarmRun(p)
    expect(rebasesOf(r1).tenants).toEqual(ts.slice(0, 2))
    const committed = Object.fromEntries(await Promise.all(ALL.map(async (table) => [table, { files: await icebergLive(cell, table), cursors: await p.cursors(table) }] as const)))
    for (const t of ts.slice(0, 2)) for (const table of ALL) expect(committed[table]!.cursors[t], `${t} ${table}`).toEqual(await ledgerVersion(t))

    // The second run starts k2 and k3; the object is reset at k3's first read, k2 staged and not committed.
    const s = await p.schedule()
    await p.advanceClock(Math.max(0, s.due.publish! - s.now))
    const reached = p.pauseOnGet(`ledger/tenant=${ts[3]}/`)
    await p.pending() // delivered after the pause is armed
    const run = runDurableObjectAlarm(p).then(
      () => 'finished',
      (e: unknown) => `failed: ${String(e)}`,
    )
    await reached
    expect(await p.abortNow().then(() => 'returned', () => 'reset')).toBe('reset')
    await run
    const q = publisher(cell) // the object as constructed afresh on its storage

    // Nothing committed before is lost or changed; nothing of k2 or k3 is published.
    for (const table of ALL) {
      expect(await icebergLive(cell, table), table).toEqual(committed[table]!.files)
      expect(await q.cursors(table), table).toEqual(committed[table]!.cursors)
    }
    expect((await q.pending()).sort()).toEqual(ts.slice(2))
    expect(Object.keys(await q.rebaseQueue()).sort()).toEqual(ts.slice(2, 4))
    // The alarm's lease: a publish is still due, and the alarm is set, though no code ran after the reset.
    const after = await q.schedule()
    expect(after.due.publish).toBeDefined()
    expect(after.alarm).not.toBeNull()

    // The next run takes the two never started, not the two cut off; the one after, those.
    const runs = await alarmRuns(q)
    expect(runs.map((r) => rebasesOf(r).tenants)).toEqual([ts.slice(4), ts.slice(2, 4)])
    // k0 and k1 were never re-based again.
    expect(runs.flatMap((r) => r.tenants).filter((x) => ts.slice(0, 2).includes(x.tenant) && x.rebase)).toEqual([])
    for (const t of ts) for (const table of ALL) expect((await icebergLive(cell, table)).filter((k) => k.includes(`/tenant=${t}/`)), `${t} ${table}`).toEqual(await liveKeys(t, table))
    for (const table of ALL) expect((await q.verify(table)).ok, table).toBe(true)
    expect(await q.scratch()).toEqual({ stage: 0, liveNext: 0 })
    expect(await q.rebaseQueue()).toEqual({})
  })
})

describe('a capped publish started over after a conflict', () => {
  it('re-reads the re-bases it admitted, admits no other, and commits them', async () => {
    const { cell, tenant } = fresh()
    const [x, y1, y2] = [tenant('x'), tenant('y1'), tenant('y2')]
    for (const t of [x, y1, y2]) {
      await addUnit(t, pairUnit(cell, t, 1, 1, T0 + 1000), { drain: true })
      await mirror(t, cell)
    }
    const A = publisher(cell)
    const B = publisher(`${cell}~b`) // a second writer on the same cell
    await B.configure({ maxRebasesPerPublish: 1, continueMs: CONTINUE_MS })
    // B re-bases y1 (y2 waits for the cap) and stops before its first metadata write; A commits x meanwhile.
    const reached = B.pauseAt('cursors-written', 'metric_samples')
    const bDone = B.publish([y1, y2])
    await reached
    expect((await A.publish([x])).tenants[0]).toMatchObject({ status: 'ok' })
    await B.resume()
    const b = await bDone
    expect(b.conflicts).toBeGreaterThanOrEqual(1)
    // Started over: y1 (now the most recently started) re-based and committed, y2 still waiting.
    expect(b.tenants.map((r) => [r.tenant, r.status, !!r.rebase]).sort()).toEqual([[y1, 'ok', true], [y2, 'deferred', false]])
    for (const t of [x, y1]) expect((await icebergLive(cell, 'metric_samples')).filter((k) => k.includes(`/tenant=${t}/`))).toEqual(await liveKeys(t, 'metric_samples'))
    expect((await icebergLive(cell, 'metric_samples')).filter((k) => k.includes(`/tenant=${y2}/`))).toEqual([])
    expect(await B.pending()).toEqual([y2])
  })
})

describe('paging over tenants', () => {
  it('a publish reads at most maxTenantsPerPublish logs, longest waiting first; a tenant stuck on a hole goes behind the others', async () => {
    const { cell, tenant } = fresh()
    const ts = [0, 1, 2, 3, 4].map((i) => tenant(`p${i}`))
    for (const t of ts) {
      await addUnit(t, pairUnit(cell, t, 1, 1, T0 + 1000), { drain: true })
      await mirror(t, cell)
    }
    const p = publisher(cell)
    expect((await p.publish(ts)).tenants.map((x) => x.status)).toEqual(ts.map(() => 'ok'))
    await p.configure({ maxTenantsPerPublish: 2, continueMs: CONTINUE_MS })
    // A new unit each; p1 gets two, and the first one's segment is not copied (a hole), so p1 stops there every time.
    for (const t of ts) await addUnit(t, pairUnit(cell, t, 2, 2, T0 + 2000), { drain: true })
    const hole = (await ledgerVersion(ts[1]!)).version
    await addUnit(ts[1]!, pairUnit(cell, ts[1]!, 3, 3, T0 + 3000), { drain: true })
    for (const t of ts) await mirror(t, cell, t === ts[1] ? { skip: [hole] } : {})
    await p.notify(ts)

    const reads: string[][] = []
    for (let i = 0; i < 3; i++) {
      const r = await alarmRun(p)
      const read = r.tenants.filter((x) => !(x.status === 'deferred' && x.detail?.startsWith('not read'))).map((x) => x.tenant)
      expect(read.length, `run ${i + 1}`).toBeLessThanOrEqual(2)
      reads.push(read.sort())
    }
    // p1 is read in the first run (all nudged at once: by name), and then waits behind those not read yet.
    expect(reads).toEqual([[ts[0], ts[1]], [ts[2], ts[3]], [ts[1], ts[4]].sort()])
    for (const t of ts.filter((x) => x !== ts[1])) expect((await icebergLive(cell, 'metric_samples')).filter((k) => k.includes(`/tenant=${t}/`))).toEqual(await liveKeys(t, 'metric_samples'))
    expect(await p.pending()).toEqual([ts[1]])
    // Only p1 is left: the alarm retries it every `retryMs`, not every `continueMs`.
    const s = await p.schedule()
    expect(s.due.publish! - s.now).toBeGreaterThan(CONTINUE_MS)
  })
})

// Every table the ledger lists is published: the tests above cover all of them.
expect(TABLE_NAMES).toEqual(ALL)
