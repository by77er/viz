/**
 * Re-bases and rebuilds kept across invocations (README, "Re-bases and rebuilds in steps";
 * design/DECISIONS.md D55, D67). Before this, one tenant's re-base and one table's rebuild from R2
 * each ran whole in one invocation: one too large for an invocation's CPU was cut off, put behind the
 * others and tried again from nothing, for ever.
 *
 *   - a re-base spanning several alarm runs, its checkpoint staged a few parts per run and its added
 *     files written into manifests ahead of its commit, ends with every table exactly as one uncapped
 *     re-base leaves it (a twin cell), whether it is the upgrade to D67, a new tenant or a new ledger
 *     incarnation; each run within its budget; the manifests written ahead survive a sweep;
 *   - an invocation cut off at every R2 operation of every step loses nothing committed, never moves
 *     the kept progress backwards, and the cell still ends as its twin;
 *   - a new ledger incarnation in the middle of a re-base (while staging, or while writing ahead):
 *     nothing kept from the old one is used or committed;
 *   - the release before this one, on storage this release left in the middle of a re-base, ignores
 *     what was kept (and sweeps the manifests written ahead, which this release then writes again), or
 *     re-bases the tenant whole itself, after which this release drops what it kept;
 *   - a table rebuilt from R2 after a lost storage, a few manifests per publish, also cut off at every
 *     R2 operation, ends with SQLite exactly as one rebuild leaves it.
 */
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { dataKeyPrefix, type FileEntry, type FlushUnit, type LedgerTable, type SignalTable } from '../../contracts/ledger'
import { CURSORS_KEY } from '../src/iceberg'
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
  readMetadata,
  readerView,
  type LedgerStub,
  type PublisherStub,
} from './helpers'

const HOUR = 3_600_000
const SIGNALS: SignalTable[] = ['spans', 'trace_index', 'logs']
const ALL: LedgerTable[] = [...TABLES, ...SIGNALS]
/** Long enough that no alarm fires by itself while a test runs; the tests run each alarm. */
const CONTINUE_MS = 30_000
/** The budget of a capped publish here, and the manifests' size: a re-base of a few dozen files takes several runs. */
const BUDGET = 5
const ENTRIES = 3
/** A checkpoint part holds at most this many records here (`partBytes` 600, a record about 450 bytes). */
const PART_RECORDS = 1

const d64 = (name: string) => env.PUBLISHER_D64.get(env.PUBLISHER_D64.idFromName(name))
const m6 = (name: string) => env.PUBLISHER_M6.get(env.PUBLISHER_M6.idFromName(name))

type Knobs = { checkpointEvery: number; checkpointByLogBytes: boolean; checkpointOneObjectBytes: number; checkpointPartBytes: number }
const knobs = (l: LedgerStub, k: Partial<Knobs>) => runInDurableObject(l, (i: unknown) => void Object.assign(i as object, k))

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

/** `n` rounds of a metric, a span and a log unit (each its own segment), from `seq`, over three days. */
async function units(t: string, seq: number, n: number): Promise<void> {
  for (let i = seq; i < seq + n; i++) {
    const day = T0 + (i % 3) * DAY_MS
    await addUnit(t, pairUnit(env.CELL, t, i, i, day + i * 1000), { drain: true })
    await addUnit(t, spanUnit(t, i, day + (i % 20) * HOUR + 5000), { drain: true })
    await addUnit(t, logUnit(t, i, day + i * 1000 + 7), { drain: true })
  }
}

/**
 * A tenant whose newest checkpoint is in many small parts (about one file each), with a log expiry
 * before it (tombstones) and units after it, on the real ledger. Returns its ledger.
 */
async function tenantLog(t: string, rounds = 6, after = 2): Promise<LedgerStub> {
  const l = ledger(t)
  await l.plan({ table: 'metric_samples', minTs: 0, maxTs: 0 })
  await knobs(l, { checkpointEvery: 1e9, checkpointByLogBytes: false, checkpointOneObjectBytes: -1, checkpointPartBytes: 600 })
  await units(t, 1, rounds)
  expect((await l.expire({ tables: ['logs'], beforeDay: dayOf(T0 + DAY_MS) })).removed.length).toBeGreaterThan(0)
  await l.drain()
  await checkpointNow(l, t, rounds + 1)
  await units(t, rounds + 2, after)
  return l
}

/** One more metric unit, with a checkpoint (in small parts) at it. */
async function checkpointNow(l: LedgerStub, t: string, seq: number): Promise<void> {
  await knobs(l, { checkpointEvery: 1, checkpointByLogBytes: false, checkpointOneObjectBytes: -1, checkpointPartBytes: 600 })
  await addUnit(t, pairUnit(env.CELL, t, seq, seq, T0 + 2 * DAY_MS + seq * 1000), { drain: true })
  await knobs(l, { checkpointEvery: 1e9 })
}

/** The checkpoint parts of a tenant's incarnation under a cell. */
const partsOf = async (cell: string, t: string, inc: number) => (await listKeys(`${cell}/ledger/tenant=${t}/${inc}/ckpt-`)).filter((k) => /\/ckpt-\d+-[^/]+\/\d+\.jsonl$/.test(k))

/** `cells` published by the D64 release (metrics only), then this release installed on each one's storage: the upgrade to D67. */
async function upgraded(cells: string[], ts: string[]): Promise<PublisherStub[]> {
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

/** Alarm runs until nothing is pending. */
async function alarmRuns(p: PublisherStub, limit = 40): Promise<PublishResult[]> {
  const runs: PublishResult[] = []
  while ((await p.pending()).length > 0) {
    expect(runs.length, `still pending after ${runs.length} alarm runs: ${JSON.stringify(await p.pending())}`).toBeLessThan(limit)
    runs.push(await alarmRun(p))
  }
  return runs
}

/** What a run's re-bases kept across publishes staged and wrote ahead, and what its re-bases read whole staged. */
const workOf = (r: PublishResult) =>
  r.tenants.reduce((n, t) => n + (t.step ? t.step.staged + t.step.written : t.rebase ? t.rebase.files + t.rebase.tombstones : 0), 0)

/** Every table of two cells as a reader sees it, equal; every table of `p` verified; each tenant's files the ledger's. */
async function sameAsTwin(cell: string, twin: string, p: PublisherStub, ts: string[]): Promise<void> {
  for (const table of ALL) expect(await readerView(cell, table), table).toEqual(await readerView(twin, table))
  for (const table of ALL) expect((await p.verify(table)).ok, `verify ${table}`).toBe(true)
  for (const t of ts) for (const table of ALL) expect((await icebergLive(cell, table)).filter((k) => k.includes(`/tenant=${t}/`)), `${t} ${table}`).toEqual(await liveKeys(t, table))
  expect(await p.steps()).toEqual({})
  expect(await p.scratch()).toEqual({ stage: 0, liveNext: 0 })
}

/** The cursors object of every snapshot of a table, by snapshot id. */
async function snapshotCursors(cell: string, table: LedgerTable): Promise<Map<number, Record<string, { ledgerIncarnation: number; version: number }>>> {
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

type Start = 'upgrade' | 'new tenant' | 'new incarnation'

/**
 * Two cells with the same tenants' logs, in the state where `start` makes every tenant need a re-base:
 * the D67 upgrade (D64's storage, metrics published), nothing published, or everything published and
 * then a new ledger incarnation (written with its own checkpoint in small parts) for the first tenant.
 */
async function twinCells(start: Start, ts: string[]): Promise<{ cell: string; twin: string; capped: PublisherStub; uncapped: PublisherStub }> {
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
        await p.configure({ manifestTargetEntries: ENTRIES })
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
  await capped.configure({ maxRebaseFilesPerPublish: BUDGET, manifestTargetEntries: ENTRIES, continueMs: CONTINUE_MS })
  await uncapped.configure({ manifestTargetEntries: ENTRIES })
  return { cell, twin, capped, uncapped }
}

describe('a re-base kept across invocations (README, "Re-bases and rebuilds in steps")', () => {
  for (const start of ['upgrade', 'new tenant', 'new incarnation'] as Start[]) {
    it(`${start}: spread over several alarm runs within the budget, it ends exactly as one uncapped re-base; manifests written ahead survive a sweep`, async () => {
      const { tenant } = fresh()
      const ts = [tenant('big'), tenant('small')]
      await tenantLog(ts[0]!, 6)
      await tenantLog(ts[1]!, 1, 1)
      const { cell, twin, capped, uncapped } = await twinCells(start, ts)
      const big = ts[0]!

      // Uncapped: one publish re-bases every tenant that needs it, whole.
      const one = await uncapped.publish(ts)
      expect(one.tenants.map((x) => x.status)).toEqual(ts.map(() => 'ok'))
      expect(one.tenants.find((x) => x.tenant === big)!.rebase).toBeDefined()
      expect(one.tenants.every((x) => !x.step)).toBe(true)

      const before = Object.fromEntries(await Promise.all(ALL.map(async (t) => [t, await metadataVersions(cell, t)] as const)))
      await capped.notify(ts)
      const runs: PublishResult[] = []
      let swept = false
      while ((await capped.pending()).length > 0) {
        expect(runs.length, 'alarm runs').toBeLessThan(40)
        runs.push(await alarmRun(capped))
        // Once manifests are written ahead, a sweep long past the grace leaves them where they are.
        const kept = (await capped.steps())[big]
        if (!swept && kept && kept.ahead > 0) {
          swept = true
          const objects = Object.fromEntries(await Promise.all(SIGNALS.map(async (t) => [t, await listKeys(metaDir(cell, t))] as const)))
          for (let i = 0; i < 2; i++) {
            await capped.advanceClock(2 * HOUR)
            await capped.maintain()
          }
          for (const t of SIGNALS) for (const k of objects[t]!) expect(await listKeys(metaDir(cell, t)), `${t}: ${k}`).toContain(k)
          expect((await capped.steps())[big]!.ahead).toBe(kept.ahead)
        }
      }
      expect(swept, 'some run left manifests written ahead').toBe(true)
      // Several runs, each within its budget: a run stops at the first part or manifest past it.
      expect(runs.length).toBeGreaterThanOrEqual(5)
      for (const [i, r] of runs.entries()) expect(workOf(r), `run ${i + 1}`).toBeLessThanOrEqual(BUDGET - 1 + Math.max(PART_RECORDS, ENTRIES))
      const steps = runs.flatMap((r) => r.tenants.filter((x) => x.tenant === big && x.step).map((x) => x.step!))
      expect(steps.map((s) => s.phase)).toContain('staging')
      expect(steps.map((s) => s.phase)).toContain('writing')
      expect(steps.filter((s) => s.phase === 'committed')).toHaveLength(1)
      // The big tenant's re-based tables were committed once each, by the one publish that finished it.
      const commits = runs.filter((r) => r.tenants.some((x) => x.tenant === big && x.step?.phase === 'committed'))
      expect(commits).toHaveLength(1)
      for (const t of SIGNALS) expect((await metadataVersions(cell, t)).filter((v) => !before[t]!.includes(v)).length, t).toBeLessThanOrEqual(runs.filter((r) => r.tables[t].snapshotId !== null).length)

      await sameAsTwin(cell, twin, capped, ts)
    })
  }
})

describe('an invocation cut off at every R2 operation of a re-base in steps', () => {
  it('loses nothing committed, never moves the kept progress backwards, and ends exactly as the uncapped twin', async () => {
    const { tenant } = fresh()
    const ts = [tenant('cut')]
    await tenantLog(ts[0]!, 3, 1)
    const { cell, twin, capped, uncapped } = await twinCells('upgrade', ts)
    expect((await uncapped.publish(ts)).tenants[0]!.status).toBe('ok')
    await capped.notify(ts)

    let p = capped
    let k = 1
    let cuts = 0
    let runs = 0
    let last = { done: 0, ahead: 0, target: null as number | null }
    const committed = new Map<LedgerTable, number[]>()
    for (const t of ALL) committed.set(t, await metadataVersions(cell, t))
    while ((await p.pending()).length > 0) {
      expect(runs, 'alarm runs').toBeLessThan(400)
      runs++
      await p.publishes()
      const s = await p.schedule()
      expect(s.due.publish, 'a publish is due, after a cut too').toBeDefined()
      expect(s.alarm, 'and the alarm is set').not.toBeNull()
      await p.advanceClock(Math.max(0, s.due.publish! - s.now))
      await p.cutAtOp(k)
      const reached = p.cutReached().then(
        () => 'cut' as const,
        () => 'gone' as const,
      )
      const run = runDurableObjectAlarm(p).then(
        () => 'done' as const,
        () => 'failed' as const,
      )
      if ((await Promise.race([reached, run])) === 'cut') {
        expect(await p.abortNow().then(() => 'returned', () => 'reset')).toBe('reset')
        await run
        p = publisher(cell)
        cuts++
        k++
      } else {
        expect(await run).toBe('done')
        await p.disarmCut()
        k = 1
      }
      // Nothing committed is lost: every metadata version stays, and each table's newest is readable.
      for (const t of ALL) {
        const now = await metadataVersions(cell, t)
        for (const v of committed.get(t)!) expect(now, `${t} v${v}`).toContain(v)
        committed.set(t, now)
      }
      // The kept progress never moves backwards (it is gone once committed).
      const kept = (await p.steps())[ts[0]!]
      if (kept) {
        if (last.target === null && kept.target === null) expect(kept.done).toBeGreaterThanOrEqual(last.done)
        if (last.target !== null) expect(kept.target).toBe(last.target)
        if (kept.target !== null && last.target !== null) expect(kept.ahead).toBeGreaterThanOrEqual(last.ahead - SIGNALS.length)
        last = { done: kept.done, ahead: kept.ahead, target: kept.target }
      }
    }
    expect(cuts).toBeGreaterThan(30)
    await sameAsTwin(cell, twin, p, ts)
  })
})

describe('a new ledger incarnation in the middle of a re-base kept across invocations', () => {
  for (const phase of ['staging', 'writing'] as const) {
    it(`while ${phase}: nothing kept from the old incarnation is used or committed; the re-base starts over on the new one`, async () => {
      const { tenant } = fresh()
      const t = tenant(`inc-${phase}`)
      await tenantLog(t, 4, 1)
      const { cell, twin, capped, uncapped } = await twinCells('new tenant', [t])
      await capped.notify([t])
      // Run until the kept re-base is in the phase asked for.
      for (let i = 0; ; i++) {
        expect(i).toBeLessThan(30)
        await alarmRun(capped)
        const kept = (await capped.steps())[t]
        if (phase === 'staging' ? kept && kept.target === null && kept.done > 0 : kept && kept.ahead > 0) break
      }
      const old = (await capped.steps())[t]!
      expect(old.incarnation).toBe(1)
      for (const table of ALL) expect(await metadataVersions(cell, table)).toEqual([])

      // The ledger loses its storage: incarnation 2, with a removal, a unit and a checkpoint of its own.
      await loseLedgerStorage(t)
      const l = ledger(t)
      await knobs(l, { checkpointEvery: 1e9, checkpointByLogBytes: false, checkpointOneObjectBytes: -1, checkpointPartBytes: 600 })
      expect((await l.expire({ tables: ['metric_samples', 'metric_series'], beforeDay: dayOf(T0 + DAY_MS) })).removed.length).toBeGreaterThan(0)
      await checkpointNow(l, t, 60)
      await units(t, 61, 1)
      for (const c of [cell, twin]) await mirror(t, c)

      const runs = await alarmRuns(capped)
      // Every snapshot of every table names the tenant at incarnation 2 only: nothing staged or written
      // ahead for incarnation 1 was committed.
      for (const table of ALL) {
        for (const [id, cursors] of await snapshotCursors(cell, table)) if (cursors[t]) expect(cursors[t]!.ledgerIncarnation, `${table} snapshot ${id}`).toBe(2)
      }
      expect(runs.flatMap((r) => r.tenants.filter((x) => x.step).map((x) => x.step!.version))).not.toContain(old.version)
      expect((await uncapped.publish([t])).tenants[0]!.status).toBe('ok')
      await sameAsTwin(cell, twin, capped, [t])
    })
  }
})

/** The rows of the tables this release keeps re-bases in, from a dump. */
const keptRows = (d: Dump) => Object.fromEntries(['rebase_step', 'rebase_stage', 'rebase_manifest'].map((t) => [t, d.rows[t]]))

describe('the release before this one (test/m6/) on storage this release left in the middle of a re-base', () => {
  it('ignores what was kept, and sweeps the manifests written ahead; rolled forward, this release writes them again and ends as the twin', async () => {
    const { tenant } = fresh()
    const [big, other] = [tenant('rb'), tenant('ro')]
    await tenantLog(big, 6)
    await tenantLog(other, 1, 1)
    const { cell, twin, capped, uncapped } = await twinCells('upgrade', [big, other])
    expect((await uncapped.publish([big, other])).tenants.map((x) => x.status)).toEqual(['ok', 'ok'])
    await capped.notify([big, other])
    for (let i = 0; ; i++) {
      expect(i).toBeLessThan(30)
      await alarmRun(capped)
      const kept = (await capped.steps())[big]
      if (kept && kept.ahead >= 2 && (await capped.pending()).length === 1) break
    }
    const left = await runInDurableObject(capped, (_i, s) => dumpOf(s))
    expect(left.rows.rebase_manifest!.length).toBeGreaterThanOrEqual(2)

    // Rollback: the M-6 release on this storage (version 7, compat 1: it opens it). It publishes the
    // other tenant's new metric unit, and its sweep, knowing nothing of manifests written ahead, deletes
    // them after its grace. What this release kept is left as it was.
    const old = m6(cell)
    await old.pending()
    await install(old, left)
    await addUnit(other, pairUnit(env.CELL, other, 90, 90, T0 + 2 * DAY_MS + 90_000), { drain: true })
    for (const c of [cell, twin]) await mirror(other, c)
    expect((await old.publish([other])).tenants[0]!.status).toBe('ok')
    const ahead = left.rows.rebase_manifest!.map((r) => r.path as string)
    for (let i = 0; i < 2; i++) {
      await old.advanceClock(2 * HOUR)
      await old.maintain()
    }
    for (const k of ahead) expect(await env.BUCKET.head(k), k).toBeNull()
    const after = await runInDurableObject(old, (_i, s) => dumpOf(s))
    expect(keptRows(after)).toEqual(keptRows(left))
    expect(after.rows.viz_schema![0]).toMatchObject({ version: 7, compat: 1 })

    // Rolled forward: the manifests are found missing before the commit, written again, and committed.
    await install(capped, after)
    await capped.notify([big])
    await alarmRuns(capped)
    expect((await uncapped.publish([other])).tenants[0]!.status).toBe('ok')
    await sameAsTwin(cell, twin, capped, [big, other])
  })

  it('re-bases the tenant whole itself; rolled forward, this release drops what it kept and re-bases nothing again', async () => {
    const { tenant } = fresh()
    const t = tenant('rw')
    await tenantLog(t, 4, 1)
    const { cell, twin, capped, uncapped } = await twinCells('upgrade', [t])
    expect((await uncapped.publish([t])).tenants[0]!.status).toBe('ok')
    await capped.notify([t])
    await alarmRun(capped)
    expect((await capped.steps())[t]).toBeDefined()
    const left = await runInDurableObject(capped, (_i, s) => dumpOf(s))

    const old = m6(cell)
    await old.pending()
    await install(old, left)
    const r = await old.publish([t])
    expect(r.tenants[0]).toMatchObject({ status: 'ok', rebase: { source: 'checkpoint' } })
    const after = await runInDurableObject(old, (_i, s) => dumpOf(s))
    expect(keptRows(after)).toEqual(keptRows(left))
    const objects = Object.fromEntries(await Promise.all(ALL.map(async (x) => [x, await listKeys(metaDir(cell, x))] as const)))

    await install(capped, after)
    const f = await capped.publish([t])
    expect(f.tenants[0]).toMatchObject({ status: 'ok' })
    expect(f.tenants[0]!.rebase).toBeUndefined()
    expect(f.tenants[0]!.step).toBeUndefined()
    for (const x of ALL) expect(await listKeys(metaDir(cell, x)), x).toEqual(objects[x])
    await sameAsTwin(cell, twin, capped, [t])
  })
})

/** What SQLite says of every table after a rebuild: live files, manifests, cursors, retained snapshots, versions. */
const rebuilt = (p: PublisherStub) =>
  runInDurableObject(p, (_i, s) => {
    const q = (sql: string) => s.storage.sql.exec(sql).toArray()
    return {
      live: q(`SELECT * FROM live ORDER BY tbl, key`),
      manifest: q(`SELECT * FROM manifest ORDER BY tbl, path`),
      cursor: q(`SELECT * FROM cursor ORDER BY tbl, tenant`),
      snap: q(`SELECT * FROM snap ORDER BY tbl, snapshot_id`),
      tbl: q(`SELECT * FROM tbl ORDER BY name`),
    }
  })

describe('a table rebuilt from R2 in steps after a lost storage', () => {
  it('a few manifests per publish, within the budget, even cut off at every R2 operation; SQLite ends exactly as one rebuild leaves it, and the next commit is right', async () => {
    const { cell, tenant } = fresh()
    const ts = [tenant('r0'), tenant('r1')]
    for (const t of ts) {
      await tenantLog(t, 4, 1)
      await mirror(t, cell)
    }
    // Published with small manifests, so each table has several.
    const first = publisher(`${cell}~first`)
    await first.configure({ manifestTargetEntries: 2 })
    expect((await first.publish(ts)).tenants.map((x) => x.status)).toEqual(ts.map(() => 'ok'))
    for (const table of ALL) expect((await first.status(table)).manifests, table).toBeGreaterThanOrEqual(2)

    // Two publishers that lost their storage, on the same cell: one rebuilds uncapped, one capped.
    const whole = publisher(`${cell}~whole`)
    const steps = publisher(`${cell}~steps`)
    const wr = await whole.publish(ts)
    expect(wr.tenants.every((x) => x.status === 'deferred')).toBe(true)
    for (let i = 0; i < 10 && (await whole.publish(ts)).tenants.some((x) => x.status === 'deferred'); i++);
    await steps.configure({ maxRebaseFilesPerPublish: 2, continueMs: CONTINUE_MS })

    // Capped, cut off at every R2 operation of each publish in turn.
    let p = steps
    let k = 1
    let cuts = 0
    let publishes = 0
    const progress: Record<string, number> = {}
    for (;;) {
      expect(publishes, 'publishes').toBeLessThan(300)
      publishes++
      await p.cutAtOp(k)
      const reached = p.cutReached().then(
        () => 'cut' as const,
        () => 'gone' as const,
      )
      const run = p.publish(ts).then(
        (r) => r,
        () => null,
      )
      const first = await Promise.race([reached, run])
      if (first === 'cut') {
        expect(await p.abortNow().then(() => 'returned', () => 'reset')).toBe('reset')
        await run
        p = publisher(`${cell}~steps`)
        cuts++
        k++
      } else {
        await p.disarmCut()
        k = 1
        const r = first === 'gone' ? await run : first
        expect(r).not.toBeNull()
        if (!r!.tenants.some((x) => x.status === 'deferred')) break
        // Within its budget: a rebuilding publish reads no tenant.
        expect(r!.tenants.every((x) => x.status === 'deferred')).toBe(true)
      }
      // Progress never moves backwards (a table's done manifests), until the table is rebuilt.
      for (const [table, b] of Object.entries(await p.rebuilds())) {
        expect(b.done, table).toBeGreaterThanOrEqual(progress[table] ?? 0)
        progress[table] = b.done
      }
    }
    expect(cuts).toBeGreaterThan(20)
    expect(await p.rebuilds()).toEqual({})
    expect(await rebuilt(p)).toEqual(await rebuilt(whole))

    // The next commit after the rebuild is right.
    await addUnit(ts[0]!, pairUnit(env.CELL, ts[0]!, 95, 95, T0 + 2 * DAY_MS + 95_000), { drain: true })
    await mirror(ts[0]!, cell)
    expect((await p.publish(ts)).tenants.map((x) => x.status)).toEqual(ts.map(() => 'ok'))
    for (const table of ALL) expect((await p.verify(table)).ok, table).toBe(true)
    for (const t of ts) for (const table of ALL) expect((await icebergLive(cell, table)).filter((x) => x.includes(`/tenant=${t}/`)), `${t} ${table}`).toEqual(await liveKeys(t, table))
  })

  it('without cuts: each publish within its budget, a table over several publishes, and no tenant re-based', async () => {
    const { cell, tenant } = fresh()
    const ts = [tenant('s0'), tenant('s1')]
    for (const t of ts) {
      await tenantLog(t, 4, 1)
      await mirror(t, cell)
    }
    const first = publisher(`${cell}~first`)
    await first.configure({ manifestTargetEntries: 2 })
    expect((await first.publish(ts)).tenants.map((x) => x.status)).toEqual(ts.map(() => 'ok'))
    const whole = publisher(`${cell}~whole`)
    for (let i = 0; i < 10 && (await whole.publish(ts)).tenants.some((x) => x.status === 'deferred'); i++);
    const p = publisher(`${cell}~steps`)
    await p.configure({ maxRebaseFilesPerPublish: 3 })
    const seen: Record<string, number[]> = {}
    for (let i = 0; ; i++) {
      expect(i).toBeLessThan(60)
      const before = await p.rebuilds()
      const r = await p.publish(ts)
      if (!r.tenants.some((x) => x.status === 'deferred')) {
        expect(r.tenants.every((x) => !x.rebase)).toBe(true)
        break
      }
      const after = await p.rebuilds()
      for (const [table, b] of Object.entries(after)) (seen[table] ??= []).push(b.done - (before[table]?.done ?? 0))
    }
    // Each publish took at most the budget's worth of manifests (two files each here): at most two manifests.
    for (const [table, steps] of Object.entries(seen)) for (const d of steps) expect(d, table).toBeLessThanOrEqual(2)
    expect(Object.values(seen).some((s) => s.length >= 2)).toBe(true)
    expect(await rebuilt(p)).toEqual(await rebuilt(whole))
    await evictDurableObject(p)
    for (const table of ALL) expect((await p.verify(table)).ok, table).toBe(true)
  })
})
