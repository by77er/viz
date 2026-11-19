import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { compactStep } from '../../compact/src/compact'
import { flushTenant } from '../../flush/src/flush'
import { DAY_MS, Sent, T0, append, breakLedgerLog, dataKeys, healLedgerLog, liveKeys, read, someSamples, stream } from '../../flush/test/helpers'
import { canonOf } from '../../flush/test/read'
import { engine } from '../../flush/src/index'
import { DEFAULT_RETENTION, expireTenant, purgeTenant, retentionCutoffDay, retentionPolicy, sweepOrphans } from '../src/index'

const QUIET = T0 + 30 * 60_000
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const exists = async (keys: string[]) => (await Promise.all(keys.map((k) => env.BUCKET.head(k)))).map((o) => o !== null)

/** A tenant with `n` flushed segments; segment `i` holds samples of day `T0 - dayBack(i)` days. */
async function tenantWith(prefix: string, n: number, dayBack: (i: number) => number = () => 0) {
  const s = stream(prefix)
  const sent = new Sent()
  const byDay = new Map<number, Sent>()
  for (let i = 0; i < n; i++) {
    const d = dayBack(i)
    if (!byDay.has(d)) byDay.set(d, new Sent())
    const rows = someSamples(s.tenant, T0 - d * DAY_MS + i * 60_000, 24, i)
    await append(s.shard, s.tenant, rows, sent)
    for (const r of rows) byDay.get(d)!.add(r.labels, r.ts, BigInt.asUintN(64, new BigInt64Array(new Float64Array([r.value as number]).buffer)[0]!))
    await s.shard.seal(s.tenant)
  }
  expect(await flushTenant(env, engine, s.tenant, s.shardName)).toMatchObject({ status: 'ok', awaitingLog: false })
  return { ...s, sent, byDay }
}

describe('retention policy', () => {
  it('reads retention:<tenant> from KV, defaults to 30 days, and never shortens on a bad record', async () => {
    expect(DEFAULT_RETENTION).toEqual({ metric_samples_days: 30 })
    expect(await retentionPolicy(env, 'nobody')).toEqual({ metric_samples_days: 30 })
    await env.CONFIG.put('retention:pol-a', JSON.stringify({ metric_samples_days: 7 }))
    expect(await retentionPolicy(env, 'pol-a')).toEqual({ metric_samples_days: 7 })
    for (const bad of ['{', '{"metric_samples_days":0}', '{"metric_samples_days":-3}', '{"metric_samples_days":"1"}', '{"metric_samples_days":1.5}', 'null']) {
      await env.CONFIG.put('retention:pol-b', bad)
      expect(await retentionPolicy(env, 'pol-b')).toEqual({ metric_samples_days: 30 })
    }
    // Today and the N days before it are kept: with N = 2 on the 18th, the 16th is the first kept day.
    expect(retentionCutoffDay(T0, { metric_samples_days: 2 })).toBe('2026-11-16')
    expect(retentionCutoffDay(Date.UTC(2026, 10, 18, 23, 59, 59, 999), { metric_samples_days: 2 })).toBe('2026-11-16')
    expect(retentionCutoffDay(Date.UTC(2026, 10, 19), { metric_samples_days: 2 })).toBe('2026-11-17')
  })
})

// Review R-1 (design/reviews/write-path-completion.md), ported from the reviewer's
// janitor/test/review.test.ts: a record the tenant wrote for a LONGER period than the default,
// with a typo, must not be replaced by the 30-day default.
describe('review R-1: a retention record that cannot be read', () => {
  it('a 365-day policy with a trailing comma does not expire a 100-day-old file', async () => {
    const s = stream('rv-ret')
    await append(s.shard, s.tenant, someSamples(s.tenant, T0 - 100 * DAY_MS, 24, 0), new Sent())
    await s.shard.seal(s.tenant)
    await append(s.shard, s.tenant, someSamples(s.tenant, T0, 24, 1), new Sent())
    await s.shard.seal(s.tenant)
    expect(await flushTenant(env, engine, s.tenant, s.shardName)).toMatchObject({ status: 'ok' })
    expect(await liveKeys(s.ledger)).toHaveLength(4)

    await env.CONFIG.put(`retention:${s.tenant}`, '{"metric_samples_days": 365,}')
    const r = await expireTenant(env, s.tenant, T0)
    // The tenant asked for 365 days. A record that cannot be read stops expiry (refuse
    // rather than guess); it does not apply a shorter default.
    expect(r.removed).toEqual([])
    expect(await liveKeys(s.ledger)).toHaveLength(4)
  })
})

describe('expire and purge', () => {
  it('expires whole days past the policy from both tables, and touches no object', async () => {
    const t = await tenantWith('j1', 4, (i) => [5, 3, 2, 0][i]!)
    await env.CONFIG.put(`retention:${t.tenant}`, JSON.stringify({ metric_samples_days: 2 }))
    const objects = await dataKeys(t.tenant)
    const r = await expireTenant(env, t.tenant, T0)
    expect(r.beforeDay).toBe('2026-11-16')
    // Days 13 and 15 go (samples and series), days 16 and 18 stay.
    expect(r.removed.map((k) => /day=(\d{4}-\d{2}-\d{2})/.exec(k)![1]).sort()).toEqual(['2026-11-13', '2026-11-13', '2026-11-15', '2026-11-15'])
    const live = await liveKeys(t.ledger)
    expect(live).toHaveLength(4)
    expect(live.every((k) => /day=2026-11-1[68]/.test(k))).toBe(true)
    expect(await dataKeys(t.tenant)).toEqual(objects)
    // What is left reads as exactly the rows of the kept days.
    const kept = [...t.byDay.get(2)!.canon(), ...t.byDay.get(0)!.canon()].sort()
    expect((await read(t.tenant, [t.shardName])).canon).toEqual(kept)
    // A second run removes nothing; the default policy (30 days) would have removed nothing at all.
    expect((await expireTenant(env, t.tenant, T0)).removed).toEqual([])
    const other = await tenantWith('j1b', 2, (i) => [5, 0][i]!)
    expect((await expireTenant(env, other.tenant, T0)).removed).toEqual([])
  })

  it('deletes removed objects only after the grace, and a reader holding the old plan can read all of it until then', async () => {
    const t = await tenantWith('j2', 5)
    // A query takes its plan...
    const oldSamples = await t.ledger.plan({ table: 'metric_samples', minTs: 0, maxTs: Number.MAX_SAFE_INTEGER })
    const oldSeries = await t.ledger.plan({ table: 'metric_series', minTs: 0, maxTs: Number.MAX_SAFE_INTEGER })
    const oldKeys = [...oldSamples.files, ...oldSeries.files].map((f) => f.key)
    // ...then compaction replaces every file the plan names.
    const merged = await compactStep(env, engine, t.tenant, { now: QUIET })
    expect(merged.status).toBe('merged')
    expect((await liveKeys(t.ledger)).some((k) => oldKeys.includes(k))).toBe(false)

    // Within the grace the janitor deletes nothing, however often it runs.
    for (let i = 0; i < 3; i++) expect(await purgeTenant(env, t.tenant, { graceMs: 60_000 })).toEqual({ deleted: [], waiting: 10 })
    expect(await exists(oldKeys)).toEqual(oldKeys.map(() => true))
    // The reader finishes with its OLD plan: every file is there and the result is what was sent.
    const fetch = (keys: string[]) => Promise.all(keys.map(async (k) => new Uint8Array(await (await env.BUCKET.get(k))!.arrayBuffer())))
    const out = engine.select({ sampleFiles: await fetch(oldSamples.files.map((f) => f.key)), seriesFiles: await fetch(oldSeries.files.map((f) => f.key)), tailBatches: [] }, [], 0, 253_402_300_799_999)
    expect(canonOf(out)).toEqual(t.sent.canon())

    // After the grace (by the ledger's clock) they go, in one pass, and the tombstones with them.
    await sleep(120)
    const purged = await purgeTenant(env, t.tenant, { graceMs: 100 })
    expect(purged.deleted.sort()).toEqual(oldKeys.sort())
    expect(purged.waiting).toBe(0)
    expect(await exists(oldKeys)).toEqual(oldKeys.map(() => false))
    expect(await t.ledger.removedSince(0)).toEqual([])
    // The live files were never candidates, and a new reader sees the same rows.
    expect(await dataKeys(t.tenant)).toEqual(await liveKeys(t.ledger))
    expect((await read(t.tenant, [t.shardName])).canon).toEqual(t.sent.canon())
    expect(await purgeTenant(env, t.tenant, { graceMs: 0 })).toEqual({ deleted: [], waiting: 0 })
  })

  it('never deletes while the removal is committed but not logged, whatever the grace', async () => {
    const t = await tenantWith('j3', 3, (i) => [40, 40, 0][i]!)
    const doomed = (await liveKeys(t.ledger)).filter((k) => k.includes('day=2026-10-09'))
    expect(doomed).toHaveLength(4)
    await breakLedgerLog(t.ledger)
    expect((await expireTenant(env, t.tenant, T0)).removed.sort()).toEqual(doomed)
    expect(await t.ledger.outboxDepth()).toBe(2)
    await sleep(20)
    expect(await purgeTenant(env, t.tenant, { graceMs: 0 })).toEqual({ deleted: [], waiting: 4 })
    expect(await exists(doomed)).toEqual([true, true, true, true])
    // Once the log has the removal, the same call deletes.
    await healLedgerLog(t.ledger)
    await t.ledger.drain()
    expect((await purgeTenant(env, t.tenant, { graceMs: 0 })).deleted.sort()).toEqual(doomed)
    expect(await exists(doomed)).toEqual([false, false, false, false])
  })

  it('stops at maxKeys and continues on the next run', async () => {
    const t = await tenantWith('j4', 4, () => 40)
    await expireTenant(env, t.tenant, T0)
    const first = await purgeTenant(env, t.tenant, { graceMs: 0, maxKeys: 3 })
    expect(first.deleted).toHaveLength(3)
    const second = await purgeTenant(env, t.tenant, { graceMs: 0 })
    expect(second.deleted).toHaveLength(5)
    expect(await dataKeys(t.tenant)).toEqual([])
  })
})

describe('orphan sweep', () => {
  const NOW = { graceMs: 0, maxCompactStepMs: 0 }

  it('never deletes the files of a unit that is written but not yet admitted, and they become live', async () => {
    const s = stream('o1')
    const sent = new Sent()
    for (const i of [0, 1]) {
      await append(s.shard, s.tenant, someSamples(s.tenant, T0 + i * 60_000, 24, i), sent)
      await s.shard.seal(s.tenant)
    }
    // Segment 1 is admitted; the flush of segment 2 stops between its PUTs and addUnit.
    let n = 0
    await expect(flushTenant(env, engine, s.tenant, s.shardName, { hooks: { afterPut: () => { if (++n === 2) throw new Error('crash') } } })).rejects.toThrow('crash')
    const pending = (await dataKeys(s.tenant)).filter((k) => /-2-2-[0-9a-f]{8}\.parquet$/.test(k))
    expect(pending).toHaveLength(2)
    expect((await liveKeys(s.ledger)).some((k) => pending.includes(k))).toBe(false)
    // No grace at all, run repeatedly, at any later time: the pending files are kept.
    for (const now of [Date.now(), Date.now() + 365 * DAY_MS]) {
      const r = await sweepOrphans(env, s.tenant, { ...NOW, now })
      expect(r.deleted).toEqual([])
      expect(r.kept.map((k) => [k.key, k.why]).sort()).toEqual(pending.map((k) => [k, 'pending_unit']))
    }
    // The flush is run again and finds its objects.
    const again = await flushTenant(env, engine, s.tenant, s.shardName)
    expect(again.segments.find((g) => g.seqLo === 2)!.files.map((f) => f.put)).toEqual(['exists', 'exists'])
    expect((await read(s.tenant, [s.shardName])).canon).toEqual(sent.canon())
    // Same for the very first unit of a stream the ledger has never heard of.
    const fresh = stream('o1b')
    await append(fresh.shard, fresh.tenant, someSamples(fresh.tenant, T0, 8))
    await fresh.shard.seal(fresh.tenant)
    await expect(flushTenant(env, engine, fresh.tenant, fresh.shardName, { hooks: { afterPut: () => { throw new Error('crash') } } })).rejects.toThrow('crash')
    const first = await sweepOrphans(env, fresh.tenant, NOW)
    expect([first.deleted, first.kept.map((k) => k.why)]).toEqual([[], ['unknown_stream', 'unknown_stream']])
  })

  it('judges a pending unit by the LOGGED watermark, not the committed one', async () => {
    const t = await tenantWith('o2', 1)
    const live = await liveKeys(t.ledger)
    // A stray object for the range the ledger is about to admit but has not logged.
    await append(t.shard, t.tenant, someSamples(t.tenant, T0 + 60_000, 8, 5))
    await t.shard.seal(t.tenant)
    const stray = live[0]!.replace(/-1-1-[0-9a-f]{8}\.parquet$/, '-2-2-0badf00d.parquet')
    await env.BUCKET.put(stray, 'different bytes for the same range')
    await breakLedgerLog(t.ledger)
    expect(await flushTenant(env, engine, t.tenant, t.shardName)).toMatchObject({ status: 'ok', awaitingLog: true })
    // Committed through 2, logged through 1: a ledger rebuilt now would take a unit for 2 again.
    expect((await sweepOrphans(env, t.tenant, NOW)).deleted).toEqual([])
    await healLedgerLog(t.ledger)
    await t.ledger.drain()
    // Logged through 2: nothing can ever admit the stray object. It goes; the live files stay.
    expect((await sweepOrphans(env, t.tenant, NOW)).deleted).toEqual([stray])
    expect((await dataKeys(t.tenant)).sort()).toEqual((await liveKeys(t.ledger)).sort())
  })

  it('deletes what can never be listed once it is old enough: a superseded flush file, an older incarnation, a failed merge', async () => {
    const t = await tenantWith('o3', 4)
    const live = await liveKeys(t.ledger)
    const inc = Number(/L0-.+-(\d+)-1-1-/.exec(live[0]!)![1])
    const base = live[0]!.slice(0, live[0]!.lastIndexOf('/') + 1)
    const shard = /L0-(.+)-\d+-1-1-/.exec(live[0]!)![1]!
    const superseded = `${base}L0-${shard}-${inc}-1-1-0badf00d.parquet`
    const oldIncarnation = `${base}L0-${shard}-${inc - 1}-9-9-0badf00d.parquet`
    const unknown = `${base}notes.txt`
    for (const k of [superseded, oldIncarnation, unknown]) await env.BUCKET.put(k, 'x')
    // A merge that crashed after its PUTs.
    await expect(compactStep(env, engine, t.tenant, { now: QUIET, hooks: { afterPut: () => { throw new Error('crash') } } })).rejects.toThrow('crash')
    const failedMerge = (await dataKeys(t.tenant)).filter((k) => /\/L1-/.test(k))
    expect(failedMerge).toHaveLength(2)

    // Young: kept, with the default graces and with a one-hour grace.
    for (const opts of [{}, { graceMs: 3_600_000 }]) {
      const r = await sweepOrphans(env, t.tenant, opts)
      expect(r.deleted).toEqual([])
      expect(r.kept.map((k) => [k.key, k.why]).sort()).toEqual([...[superseded, oldIncarnation, ...failedMerge].map((k) => [k, 'young']), [unknown, 'unknown_name']].sort())
    }
    // The flush files' grace alone does not release a compaction output: that needs twice a step's deadline.
    expect((await sweepOrphans(env, t.tenant, { graceMs: 0 })).deleted.sort()).toEqual([oldIncarnation, superseded].sort())
    // Old enough (a day from now): the merge outputs go too. Live files and the unknown name never.
    const r = await sweepOrphans(env, t.tenant, { now: Date.now() + 25 * 3_600_000 })
    expect(r.deleted.sort()).toEqual(failedMerge.sort())
    expect(r.listed).toBe(live.length + 3)
    expect(await dataKeys(t.tenant)).toEqual([...live, unknown].sort())
    expect((await read(t.tenant, [t.shardName])).canon).toEqual(t.sent.canon())
  })

  it('a merge in flight keeps its outputs: the sweep runs between its PUTs and its replace', async () => {
    const t = await tenantWith('o4', 4)
    let swept: Awaited<ReturnType<typeof sweepOrphans>> | null = null
    const r = await compactStep(env, engine, t.tenant, {
      now: QUIET,
      // Flush-file grace zero and "a little later": only the step deadline protects the outputs.
      hooks: { afterPut: async () => { swept = await sweepOrphans(env, t.tenant, { graceMs: 0, now: Date.now() + 60_000 }) } },
    })
    expect(swept!.deleted).toEqual([])
    expect(swept!.kept.map((k) => k.why)).toEqual(['young', 'young'])
    expect(r.status).toBe('merged')
    expect(await exists(await liveKeys(t.ledger))).toEqual([true, true])
    expect((await read(t.tenant, [t.shardName])).canon).toEqual(t.sent.canon())
  })

  it('leaves live files, tombstoned files and other tenants alone, with no grace at all', async () => {
    const a = await tenantWith('o5', 5)
    const b = await tenantWith('o5', 2)
    await compactStep(env, engine, a.tenant, { now: QUIET })
    const objects = await dataKeys(a.tenant)
    expect(objects).toHaveLength(12) // 10 tombstoned inputs + 2 live outputs
    const r = await sweepOrphans(env, a.tenant, { ...NOW, now: Date.now() + 365 * DAY_MS })
    expect(r).toEqual({ listed: 12, deleted: [], kept: [] })
    expect(await dataKeys(a.tenant)).toEqual(objects)
    expect((await dataKeys(b.tenant)).length).toBe(4)
    await expect(sweepOrphans(env, '../x', NOW)).rejects.toThrow(/tenant id/)
  })
})
