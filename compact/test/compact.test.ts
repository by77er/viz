import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { Engine } from '../../contracts/engine'
import type { FileEntry, LedgerChange, LiveFile } from '../../contracts/ledger'
import { flushTenant } from '../../flush/src/flush'
import { DAY_MS, Sent, T0, append, breakLedgerLog, dataKeys, flushSettled, listKeys, liveKeys, loseLedgerStorage, read, sha256Hex, someSamples, stream } from '../../flush/test/helpers'
import { type JanitorEnv, purgeTenant, sweepOrphans } from '../../janitor/src/janitor'
import { DEFAULT_POLICY, type Pair, type StepResult, chooseJob, compactStep, compactTenant, compactedKey, engine, jumpsOver, pairFiles, pairStem } from '../src/index'

const HOUR = 3_600_000
/** `n` flushed segments of one tenant, segment `i` holding samples around `at(i)`. */
async function flushed(prefix: string, n: number, at: (i: number) => number = (i) => T0 + i * 60_000, sent = new Sent()) {
  const s = stream(prefix)
  for (let i = 0; i < n; i++) {
    await append(s.shard, s.tenant, someSamples(s.tenant, at(i), 24, i), sent)
    await s.shard.seal(s.tenant)
  }
  const r = await flushSettled(env, engine, s.tenant, s.shardName)
  expect(r).toMatchObject({ status: 'ok', awaitingLog: false })
  return { ...s, sent }
}
const planOf = async (l: Awaited<ReturnType<typeof flushed>>['ledger'], table: 'metric_samples' | 'metric_series') =>
  (await l.plan({ table, minTs: 0, maxTs: Number.MAX_SAFE_INTEGER })).files
/**
 * Every change in the tenant's ledger log, in order, whatever the layout: one object per change,
 * or segments (contracts/LEDGER-LOG.md; header line, then one change per line). Drains first,
 * since the ledger writes its log in the background.
 */
const changesOf = async (tenant: string): Promise<LedgerChange[]> => {
  await env.LEDGER.get(env.LEDGER.idFromName(tenant)).drain()
  const out: LedgerChange[] = []
  for (const k of await listKeys(`${env.CELL}/ledger/tenant=${tenant}/`)) {
    const text = await (await env.BUCKET.get(k))!.text()
    if (/\/seg-\d+-\d+\.jsonl$/.test(k)) for (const line of text.split('\n').slice(1)) { if (line) out.push(JSON.parse(line) as LedgerChange) }
    else if (/\/\d+\.json$/.test(k)) out.push(JSON.parse(text) as LedgerChange)
  }
  return out.filter((c) => c.kind !== 'base').sort((a, b) => a.ledgerIncarnation - b.ledgerIncarnation || a.version - b.version)
}
const lastChange = async (tenant: string): Promise<LedgerChange> => (await changesOf(tenant)).at(-1)!
/** A policy clock at which today's hours are quiet but the day is still open. */
const QUIET = T0 + 30 * 60_000
const CLOSED = T0 + 2 * DAY_MS

/** Fixture files rank in the order they are made, as admitted files do (contracts/ledger.ts `LiveFile`), unless told otherwise. */
let rank = 0
const fe = (key: string, over: Partial<LiveFile>): LiveFile => ({ table: 'metric_samples', day: '2026-11-18', key, bytes: 1000, rows: 10, minTs: T0, maxTs: T0, level: 0, index: '', precedence: rank, precedenceLow: rank, ...over })
const mk = (name: string, over: Partial<LiveFile> = {}): Pair => {
  rank++
  const samples = fe(`c/data/metric_samples/tenant=t/day=${over.day ?? '2026-11-18'}/${name}-aaaaaaaa.parquet`, over)
  const series = fe(`c/data/metric_series/tenant=t/day=${over.day ?? '2026-11-18'}/${name}-bbbbbbbb.parquet`, { ...over, table: 'metric_series' })
  return pairFiles([samples], [series]).pairs[0]!
}

describe('policy', () => {
  it('pairs a samples file with the series file of the same unit or merge, and reports strays', () => {
    const a = mk('L0-p_0-7-1-1')
    expect(pairStem(a.samples.key)).toBe(pairStem(a.series.key))
    const stray = fe('c/data/metric_samples/tenant=t/day=2026-11-18/L0-p_0-7-9-9-cccccccc.parquet', {})
    const r = pairFiles([a.samples, stray], [a.series])
    expect(r.pairs).toHaveLength(1)
    expect(r.unpaired).toEqual([stray.key])
    expect(r.pairs[0]!.bytes).toBe(2000)
  })

  it('open hour: merges at K level-0 pairs, or when the hour has gone quiet for M minutes', () => {
    const three = [0, 1, 2].map((i) => mk(`L0-p_0-7-${i + 1}-${i + 1}`, { minTs: T0 + i * 1000, maxTs: T0 + i * 1000 }))
    // Three pairs, fresh: nothing yet, and the answer says when to look again.
    const fresh = chooseJob(three, T0 + 3000)
    expect(fresh.job).toBeNull()
    expect(fresh.nextDueAt).toBe(T0 + 2000 + DEFAULT_POLICY.maxL0AgeMs)
    // A fourth pair: count.
    const four = [...three, mk('L0-p_0-7-4-4', { minTs: T0 + 3000, maxTs: T0 + 3000 })]
    expect(chooseJob(four, T0 + 3000).job).toMatchObject({ level: 1, hour: 12, why: 'l0_count' })
    expect(chooseJob(four, T0 + 3000).job!.inputs).toHaveLength(4)
    // Three pairs, ten minutes after the newest sample: age.
    expect(chooseJob(three, T0 + 2000 + DEFAULT_POLICY.maxL0AgeMs).job).toMatchObject({ level: 1, why: 'l0_age' })
    // One pair alone is never merged; pairs in different hours are not merged together.
    expect(chooseJob([three[0]!], QUIET).job).toBeNull()
    const apart = [mk('L0-a', { maxTs: T0 }), mk('L0-b', { minTs: T0 + HOUR, maxTs: T0 + HOUR })]
    expect(chooseJob(apart, T0 + 5 * HOUR).job).toBeNull()
    // The hour's level-1 pair is merged in with new level-0 pairs; without a level-0 pair nothing happens.
    const l1 = mk('L1-h12-0123456789abcdef', { level: 1 })
    expect(chooseJob([l1, three[0]!], QUIET).job!.inputs.map((p) => p.level).sort()).toEqual([0, 1])
    expect(chooseJob([l1, mk('L1-h12-1123456789abcdef', { level: 1 })], QUIET).job).toBeNull()
  })

  it('closed day: everything below level 2 is merged into level-2 pairs, within the budget', () => {
    const day = Array.from({ length: 5 }, (_, i) => mk(`L${i % 2}-x${i}`, { level: i % 2, minTs: T0 + i * HOUR, maxTs: T0 + i * HOUR, bytes: 3000 }))
    // Not closed until the day has ended and the accept window has passed.
    const closesAt = Date.UTC(2026, 10, 19) + DEFAULT_POLICY.closeAfterMs
    expect(chooseJob(day, closesAt - 1).job?.level ?? 1).toBe(1)
    expect(chooseJob(day, closesAt - 1).nextDueAt).toBe(closesAt)
    const job = chooseJob(day, closesAt).job!
    expect(job).toMatchObject({ level: 2, why: 'closed_day', day: '2026-11-18' })
    expect(job.inputs).toHaveLength(5)
    // Budget: at most 2 pairs, then at most 13,000 bytes (two pairs of 6,000).
    expect(chooseJob(day, closesAt, { ...DEFAULT_POLICY, maxInputPairs: 2 }).job!.inputs).toHaveLength(2)
    expect(chooseJob(day, closesAt, { ...DEFAULT_POLICY, maxInputBytes: 13_000 }).job!.inputs).toHaveLength(2)
    // A pair over the budget on its own is left alone; a lone level-0 pair is lifted to level 2.
    expect(chooseJob([day[0]!], closesAt, { ...DEFAULT_POLICY, maxInputBytes: 100 }).job).toBeNull()
    expect(chooseJob([day[0]!], closesAt).job!.inputs).toHaveLength(1)
    // Level 2: big pairs are final, small ones merge with each other, one small one is left.
    const big = mk('L2-d-big', { level: 2, bytes: DEFAULT_POLICY.smallL2Bytes })
    const small = [mk('L2-d-s1', { level: 2 }), mk('L2-d-s2', { level: 2, minTs: T0 + 1 })]
    expect(chooseJob([big, small[0]!], closesAt).job).toBeNull()
    expect(chooseJob([big, ...small], closesAt).job!.inputs.map((p) => p.samples.key).sort()).toEqual(small.map((p) => p.samples.key).sort())
    // The oldest closed day goes first.
    const older = mk('L0-old', { day: '2026-11-17', minTs: T0 - DAY_MS, maxTs: T0 - DAY_MS })
    expect(chooseJob([...day, older], closesAt).job!.day).toBe('2026-11-17')
  })

  it('precedence: inputs are a run in precedence order that jumps over no file overlapping them in time', () => {
    // a and c are hour 12; b, admitted between them, ends in hour 13 but starts inside hour 12.
    const a = mk('L0-a', { minTs: T0, maxTs: T0 + 10 * 60_000 })
    const b = mk('L0-b', { minTs: T0 + 30 * 60_000, maxTs: T0 + HOUR + 10 * 60_000 })
    const c = mk('L0-c', { minTs: T0 + 40 * 60_000, maxTs: T0 + 50 * 60_000 })
    expect(jumpsOver([a, c], [a, b, c].flatMap((p) => [p.samples, p.series]))).toEqual([b.samples.key, b.series.key])
    // Hour 12 alone would put a's rows above b's newer ones: no merge until the day closes.
    const quiet = T0 + 3 * HOUR
    expect(chooseJob([a, b, c], quiet).job).toBeNull()
    // If b does not overlap them, merging over it is harmless.
    const b2 = mk('L0-b2', { minTs: T0 + HOUR + 5 * 60_000, maxTs: T0 + HOUR + 10 * 60_000, precedence: b.precedence, precedenceLow: b.precedence })
    expect(chooseJob([a, b2, c], quiet).job!.inputs.map((p) => p.samples.key)).toEqual([a.samples.key, c.samples.key])
    // A closed day merges a, b and c as one run, in precedence order (not key order, not time order).
    const closed = Date.UTC(2026, 10, 19) + DEFAULT_POLICY.closeAfterMs
    expect(chooseJob([c, b, a], closed).job!.inputs.map((p) => p.samples.key)).toEqual([a, b, c].map((p) => p.samples.key))
    // A big level-2 file in the middle is not a candidate, and the run may not jump over it.
    const big = mk('L2-d-big', { level: 2, bytes: DEFAULT_POLICY.smallL2Bytes, minTs: T0, maxTs: T0 + HOUR, precedence: b.precedence, precedenceLow: b.precedence })
    const job = chooseJob([a, big, c], closed).job!
    expect(job.inputs.map((p) => p.samples.key)).toEqual([a.samples.key])
    // A live file without a partner blocks too.
    expect(chooseJob([a, c], quiet, DEFAULT_POLICY, [b.samples]).job).toBeNull()
  })
})

describe('compactStep', () => {
  it('merges an hour into one level-1 pair: same query result, one replace for both tables, keys per the contract', async () => {
    const t = await flushed('c1', 5)
    const before = await read(t.tenant, [t.shardName])
    expect(before.canon).toEqual(t.sent.canon())
    expect(before.sampleFiles).toHaveLength(5)
    const inputKeys = await liveKeys(t.ledger)

    const r = await compactStep(env, engine, t.tenant, { now: QUIET })
    expect(r.status).toBe('merged')
    if (r.status !== 'merged') return
    expect(r.job).toMatchObject({ level: 1, hour: 12, why: 'l0_count' })
    expect(r.job.inputs.sort()).toEqual(inputKeys)
    expect(r.put).toEqual(['created', 'created'])

    // The ledger lists exactly the pair, and the swap was ONE change.
    expect(await liveKeys(t.ledger)).toEqual(r.outputs.map((f) => f.key).sort())
    const change = await lastChange(t.tenant)
    expect(change).toMatchObject({ kind: 'replace', version: r.version })
    expect(change.removed.sort()).toEqual(inputKeys)
    expect(change.added.map((f) => f.table).sort()).toEqual(['metric_samples', 'metric_series'])

    // Keys: level, span, the same input hash in both, each file's own content hash.
    const [samples, series] = [r.outputs.find((f) => f.table === 'metric_samples')!, r.outputs.find((f) => f.table === 'metric_series')!]
    const KEY = new RegExp(`^${env.CELL}/data/(metric_samples|metric_series)/tenant=${t.tenant}/day=2026-11-18/L1-h12-([0-9a-f]{16})-([0-9a-f]{8})\\.parquet$`)
    expect(KEY.exec(samples.key)![2]).toBe(KEY.exec(series.key)![2])
    for (const f of r.outputs) {
      const body = new Uint8Array(await (await env.BUCKET.get(f.key))!.arrayBuffer())
      expect(body.byteLength).toBe(f.bytes)
      expect((await sha256Hex(body)).slice(0, 8)).toBe(KEY.exec(f.key)![3])
      expect(f.level).toBe(1)
    }
    expect(pairStem(samples.key)).toBe(pairStem(series.key))

    // Invariant I8: the query result is the same, row for row and bit for bit.
    const after = await read(t.tenant, [t.shardName])
    expect(after.canon).toEqual(before.canon)
    expect(after.sampleFiles).toEqual([samples.key])
    expect(samples.rows).toBe(t.sent.size)
    // The inputs are still in R2 (deleting them is the janitor's job, after a grace).
    expect(await dataKeys(t.tenant)).toEqual([...inputKeys, ...r.outputs.map((f) => f.key)].sort())
    // Nothing more to do.
    expect((await compactStep(env, engine, t.tenant, { now: QUIET })).status).toBe('idle')
  })

  it('removes duplicate rows that two flush files share, and keeps the result identical', async () => {
    const s = stream('c2')
    const sent = new Sent()
    const rows = someSamples(s.tenant, T0, 24, 1)
    // The same samples in two segments (a sender's retry split differently), plus two more segments.
    await append(s.shard, s.tenant, rows, sent)
    await s.shard.seal(s.tenant)
    await append(s.shard, s.tenant, [...rows].reverse(), sent)
    await s.shard.seal(s.tenant)
    for (const i of [2, 3]) {
      await append(s.shard, s.tenant, someSamples(s.tenant, T0 + i * 60_000, 24, i), sent)
      await s.shard.seal(s.tenant)
    }
    await flushSettled(env, engine, s.tenant, s.shardName)
    const before = await read(s.tenant, [s.shardName])
    expect(before.lakeRows).toBe(96) // four files of 24 rows; `sent` holds fewer distinct samples
    const r = await compactStep(env, engine, s.tenant, { now: QUIET })
    expect(r.status).toBe('merged')
    const after = await read(s.tenant, [s.shardName])
    expect(after.lakeRows).toBe(sent.size)
    expect(after.canon).toEqual(before.canon)
    expect(after.canon).toEqual(sent.canon())
  })

  it('a step that stops after its PUTs is repeated with the same keys and no second object', async () => {
    const t = await flushed('c3', 4)
    await expect(compactStep(env, engine, t.tenant, { now: QUIET, hooks: { afterPut: () => { throw new Error('crash after PUT') } } })).rejects.toThrow('crash after PUT')
    // Objects exist; the ledger does not list them; queries are unchanged.
    const orphaned = (await dataKeys(t.tenant)).filter((k) => /\/L1-/.test(k))
    expect(orphaned).toHaveLength(2)
    expect((await liveKeys(t.ledger)).some((k) => /\/L1-/.test(k))).toBe(false)
    expect((await read(t.tenant, [t.shardName])).canon).toEqual(t.sent.canon())
    const r = await compactStep(env, engine, t.tenant, { now: QUIET })
    expect(r).toMatchObject({ status: 'merged', put: ['exists', 'exists'] })
    expect((await dataKeys(t.tenant)).filter((k) => /\/L1-/.test(k))).toEqual(orphaned)
    expect((await read(t.tenant, [t.shardName])).canon).toEqual(t.sent.canon())
  })

  it('conflict: an input removed while the step ran means nothing is swapped; the outputs are left for the orphan sweep', async () => {
    const t = await flushed('c4', 4, (i) => T0 - 3 * DAY_MS + i * 60_000)
    const more = new Sent()
    await append(t.shard, t.tenant, someSamples(t.tenant, T0, 24, 9), more)
    await t.shard.seal(t.tenant)
    await flushSettled(env, engine, t.tenant, t.shardName)
    const live = await liveKeys(t.ledger)
    let outputs: string[] = []
    // Retention expires the old day between the step's PUTs and its replace.
    const r = await compactStep(env, engine, t.tenant, {
      now: T0,
      hooks: {
        afterPut: async (out) => {
          outputs = out.map((f) => f.key)
          for (const k of outputs) expect(await env.BUCKET.head(k)).not.toBeNull()
          await t.ledger.expire({ table: 'metric_samples', beforeDay: '2026-11-17' })
          await t.ledger.expire({ table: 'metric_series', beforeDay: '2026-11-17' })
        },
      },
    })
    expect(r.status).toBe('conflict')
    if (r.status !== 'conflict') return
    expect(r.missing.sort()).toEqual(live.filter((k) => k.includes('day=2026-11-15')))
    // The step deletes nothing (spec/README.md F14): the objects stay until the sweep can tell.
    for (const k of outputs) expect(await env.BUCKET.head(k)).not.toBeNull()
    // The expired day did not come back, and what is left reads exactly as sent.
    expect(await liveKeys(t.ledger)).toEqual(live.filter((k) => k.includes('day=2026-11-18')))
    expect((await read(t.tenant, [t.shardName])).canon).toEqual(more.canon())
    // Planning again finds nothing wrong and nothing to do.
    expect((await compactStep(env, engine, t.tenant, { now: T0 })).status).toBe('idle')
    // Once the expired inputs are purged, nothing can ever list the outputs: the sweep deletes them.
    const j = env as unknown as JanitorEnv
    expect((await sweepOrphans(j, t.tenant, { now: Date.now() + 25 * HOUR })).deleted).toEqual([])
    await purgeTenant(j, t.tenant, { graceMs: 0 })
    expect((await sweepOrphans(j, t.tenant, { now: Date.now() + 25 * HOUR })).deleted.sort()).toEqual(outputs.sort())
  })

  it('conflict after an identical step won and its outputs were removed since: the tombstoned objects are left for the janitor', async () => {
    // Steps A and B pick the same inputs, so they produce the same keys. B is slow: while it is
    // between its PUTs and its replace, A finishes, a reader takes a plan listing A's outputs,
    // and retention removes them (tombstoned, within their delete grace). B's replace then
    // conflicts. Deleting "its" outputs would delete A's objects under that reader.
    const t = await flushed('c8', 4)
    let outputs: string[] = []
    let readerPlan: FileEntry[] = []
    const b = await compactStep(env, engine, t.tenant, {
      now: QUIET,
      hooks: {
        afterPut: async (out) => {
          outputs = out.map((f) => f.key).sort()
          const a = await compactStep(env, engine, t.tenant, { now: QUIET })
          expect(a).toMatchObject({ status: 'merged', put: ['exists', 'exists'] })
          readerPlan = [...(await planOf(t.ledger, 'metric_samples')), ...(await planOf(t.ledger, 'metric_series'))]
          expect(readerPlan.map((f) => f.key).sort()).toEqual(outputs)
          await t.ledger.expire({ table: 'metric_samples', beforeDay: '2026-11-19' })
          await t.ledger.expire({ table: 'metric_series', beforeDay: '2026-11-19' })
        },
      },
    })
    expect(b).toMatchObject({ status: 'conflict' })
    const check = await t.ledger.orphanCheck(outputs)
    expect(check).toMatchObject({ live: [], tombstoned: outputs })
    // The reader holding the plan from before the removal can still read every file of it.
    for (const f of readerPlan) expect((await env.BUCKET.head(f.key))?.size).toBe(f.bytes)
  })

  it('two steps at once on the same files leave one pair, no stray object and the same result', async () => {
    const t = await flushed('c5', 6)
    const results = await Promise.all([0, 1, 2].map(() => compactStep(env, engine, t.tenant, { now: QUIET })))
    expect(results.map((r) => r.status)).toEqual(['merged', 'merged', 'merged']) // two of them as replays
    const live = await liveKeys(t.ledger)
    expect(live).toHaveLength(2)
    expect((await dataKeys(t.tenant)).filter((k) => /\/L1-/.test(k))).toEqual(live)
    expect((await read(t.tenant, [t.shardName])).canon).toEqual(t.sent.canon())
    // One replace in the log, not three.
    const changes = await changesOf(t.tenant)
    expect(changes.filter((c) => c.kind === 'replace')).toHaveLength(1)
  })

  it('closed day: several budgeted merges take every file to level 2, and the result never changes', async () => {
    const t = await flushed('c6', 7, (i) => T0 - DAY_MS + i * 50 * 60_000)
    const want = t.sent.canon()
    const run = await compactTenant(env, engine, t.tenant, { now: CLOSED, policy: { maxInputPairs: 3 }, maxSteps: 1 })
    expect(run).toMatchObject({ merged: 1, more: true })
    expect((await read(t.tenant, [t.shardName])).canon).toEqual(want)
    const rest = await compactTenant(env, engine, t.tenant, { now: CLOSED, policy: { maxInputPairs: 3 } })
    expect(rest.more).toBe(false)
    expect(rest.steps.at(-1)!.status).toBe('idle')
    const samples = await planOf(t.ledger, 'metric_samples')
    const series = await planOf(t.ledger, 'metric_series')
    expect(samples.every((f) => f.level === 2) && series.every((f) => f.level === 2)).toBe(true)
    expect(samples.length).toBe(series.length)
    expect(samples.length).toBeLessThan(7)
    expect(samples.reduce((a, f) => a + f.rows, 0)).toBe(t.sent.size)
    expect(pairFiles(samples, series).unpaired).toEqual([])
    expect((await read(t.tenant, [t.shardName])).canon).toEqual(want)
    for (const f of samples) expect(f.key).toMatch(/\/L2-d-[0-9a-f]{16}-[0-9a-f]{8}\.parquet$/)
  })

  it('does not swap when the merge lost or invented rows, or when the step overran its deadline', async () => {
    const t = await flushed('c7', 4)
    const live = await liveKeys(t.ledger)
    const lossy: Engine = { ...engine, mergeFiles: (table, files) => ({ ...engine.mergeFiles(table, files), rows: 1 }) }
    const bad = await compactStep(env, lossy, t.tenant, { now: QUIET })
    expect(bad).toMatchObject({ status: 'error', reason: 'row_count' })
    const greedy: Engine = { ...engine, mergeFiles: (table, files) => ({ ...engine.mergeFiles(table, files), rows: 1e9 }) }
    expect(await compactStep(env, greedy, t.tenant, { now: QUIET })).toMatchObject({ status: 'error', reason: 'row_count' })
    const slow = await compactStep(env, engine, t.tenant, { now: QUIET, policy: { maxStepMs: -1 } })
    expect(slow).toMatchObject({ status: 'error', reason: 'too_slow' })
    expect(await liveKeys(t.ledger)).toEqual(live)
    expect((await read(t.tenant, [t.shardName])).canon).toEqual(t.sent.canon())
  })

  it('fails closed on a replace answer it does not know (a newer ledger, schema_too_new): nothing swapped, nothing deleted', async () => {
    const t = await flushed('c9', 4)
    const live = await liveKeys(t.ledger)
    // Calls go to the real stub, except `replace`, which answers a status this code does not know.
    const wrap = (stub: DurableObjectStub<never>) =>
      new Proxy(stub, {
        get: (s, p) =>
          p === 'then' ? undefined
          : p === 'replace' ? async () => ({ status: 'schema_too_new', component: 'ledger.Ledger', found: 2, compat: 2, known: 1, retryAfterMs: 30_000 })
          : (...a: unknown[]) => (s as unknown as Record<string | symbol, (...x: unknown[]) => unknown>)[p]!(...a),
      })
    const LEDGER = new Proxy(env.LEDGER, { get: (n, p) => (p === 'get' ? (id: DurableObjectId) => wrap(n.get(id) as never) : (Reflect.get(n, p) as (...a: unknown[]) => unknown).bind(n)) })
    let outputs: string[] = []
    await expect(compactStep({ ...env, LEDGER }, engine, t.tenant, { now: QUIET, hooks: { afterPut: (o) => void (outputs = o.map((f) => f.key)) } })).rejects.toThrow(/schema_too_new/)
    expect(await liveKeys(t.ledger)).toEqual(live)
    for (const k of outputs) expect(await env.BUCKET.head(k)).not.toBeNull()
  })

  it('compactedKey refuses parts that could leave the tenant prefix', () => {
    const ok = { cell: 'c', table: 'metric_samples' as const, tenant: 't', day: '2026-11-18', level: 2, inputs16: '0'.repeat(16), sha256Hex: 'a'.repeat(64) }
    expect(compactedKey(ok)).toBe('c/data/metric_samples/tenant=t/day=2026-11-18/L2-d-0000000000000000-aaaaaaaa.parquet')
    expect(() => compactedKey({ ...ok, tenant: 'a/b' })).toThrow()
    expect(() => compactedKey({ ...ok, day: '../x' })).toThrow()
    expect(() => compactedKey({ ...ok, inputs16: 'zz' })).toThrow()
  })
})

export type { StepResult }

/**
 * Review R-2 (design/reviews/write-path-completion.md) and the protocol model's F13 and F14
 * (spec/README.md): a compaction output is only as safe as the rule the orphan sweep and the
 * step itself use to delete it. Each test drives one interleaving deterministically through
 * the hooks of `compactStep` and `sweepOrphans`.
 */
describe('review R-2: compaction outputs and concurrent deleters', () => {
  const HOUR = 3_600_000
  const janitorEnv = env as unknown as JanitorEnv
  const exists = async (keys: string[]) => (await Promise.all(keys.map((k) => env.BUCKET.head(k)))).map((o) => o !== null)

  // Ported from the reviewer's compact/test/review.test.ts.
  it('an adopted output survives a sweep that runs between its PUT and its replace', async () => {
    const t = await flushed('rv-adopt', 4)
    const inputs = await liveKeys(t.ledger)
    expect(inputs).toHaveLength(8)
    // Attempt 1 of the job crashes after its PUTs (too_slow, a ledger that threw, a killed isolate).
    let leftover: string[] = []
    await expect(compactStep(env, engine, t.tenant, { now: QUIET, hooks: { afterPut: (o) => { leftover = o.map((f) => f.key); throw new Error('crash after PUT') } } })).rejects.toThrow('crash after PUT')
    expect(await exists(leftover)).toEqual([true, true])
    // Attempt 2 of the SAME job, the sweep's clock 25 h on: its PUTs answer `exists`, and a
    // sweep runs between its PUTs and its replace.
    let swept: string[] = []
    const r = await compactStep(env, engine, t.tenant, {
      now: QUIET,
      hooks: { afterPut: async () => { swept = (await sweepOrphans(janitorEnv, t.tenant, { now: Date.now() + 25 * HOUR })).deleted } },
    })
    expect(r).toMatchObject({ status: 'merged', put: ['exists', 'exists'] })
    expect(swept).toEqual([])
    const listed = await liveKeys(t.ledger)
    expect(listed).toEqual([...leftover].sort())
    expect(await exists(listed), 'listed outputs exist in R2').toEqual([true, true])
    // After the delete grace the inputs go; the rows are still in an object.
    await purgeTenant(janitorEnv, t.tenant, { graceMs: 0 })
    expect(await exists(inputs)).toEqual(inputs.map(() => false))
    expect((await read(t.tenant, [t.shardName])).canon).toEqual(t.sent.canon())
  })

  it('the review sequence exactly: the sweep has listed and judged the leftover when the adopting step commits, then deletes', async () => {
    const t = await flushed('rv-seq', 4)
    await expect(compactStep(env, engine, t.tenant, { now: QUIET, hooks: { afterPut: () => { throw new Error('crash after PUT') } } })).rejects.toThrow('crash after PUT')
    const leftover = (await dataKeys(t.tenant)).filter((k) => /\/L1-/.test(k))
    // Steps 4-6 of R-2: the sweep (clock 25 h on) lists the leftover and asks the ledger, which
    // does not know it; before the sweep deletes, attempt k adopts the leftover and commits.
    let step: StepResult | null = null
    const o = await sweepOrphans(janitorEnv, t.tenant, {
      now: Date.now() + 25 * HOUR,
      hooks: { beforeDelete: async () => { step = await compactStep(env, engine, t.tenant, { now: QUIET }) } },
    })
    expect(step).toMatchObject({ status: 'merged', put: ['exists', 'exists'] })
    expect(o.deleted).toEqual([])
    expect(await liveKeys(t.ledger)).toEqual(leftover)
    expect(await exists(leftover)).toEqual([true, true])
    await purgeTenant(janitorEnv, t.tenant, { graceMs: 0 })
    expect((await read(t.tenant, [t.shardName])).canon).toEqual(t.sent.canon())
  })

  it('spec F14: a step that conflicts on an unlogged removal leaves its outputs; a rebuild lets the identical step commit them', async () => {
    const t = await flushed('rv-f14', 4)
    const inputs = await liveKeys(t.ledger)
    let b: StepResult | null = null
    // Step A has PUT its outputs. Step B (the same job, the same keys) runs to the end inside
    // A's window: retention expires the inputs while B runs, committed but NOT logged, so B's
    // replace conflicts. Then the ledger loses its storage: the rebuild from its log does not
    // have the expiry, the inputs are live again, and A's replace commits.
    const a = await compactStep(env, engine, t.tenant, {
      now: QUIET,
      hooks: {
        afterPut: async () => {
          b = await compactStep(env, engine, t.tenant, {
            now: QUIET,
            hooks: {
              afterPlan: async () => {
                await breakLedgerLog(t.ledger)
                await t.ledger.expire({ table: 'metric_samples', beforeDay: '2026-11-19' })
                await t.ledger.expire({ table: 'metric_series', beforeDay: '2026-11-19' })
              },
            },
          })
          await loseLedgerStorage(t.ledger)
          expect((await liveKeys(t.ledger)).sort()).toEqual(inputs)
        },
      },
    })
    expect(b).toMatchObject({ status: 'conflict' })
    expect(a).toMatchObject({ status: 'merged' })
    const live = await liveKeys(t.ledger)
    expect(live).toHaveLength(2)
    expect(await exists(live), 'every listed file has its object').toEqual([true, true])
    expect((await read(t.tenant, [t.shardName])).canon).toEqual(t.sent.canon())
  })

  it('a leftover whose inputs are gone for good is deleted; until then it is kept, however old', async () => {
    const t = await flushed('rv-gone', 4)
    await expect(compactStep(env, engine, t.tenant, { now: QUIET, hooks: { afterPut: () => { throw new Error('crash after PUT') } } })).rejects.toThrow('crash after PUT')
    const leftover = (await dataKeys(t.tenant)).filter((k) => /\/L1-/.test(k))
    const later = { now: Date.now() + 365 * DAY_MS }
    // Inputs live: kept, a year on.
    expect((await sweepOrphans(janitorEnv, t.tenant, later)).deleted).toEqual([])
    // Inputs expired (logged) but not yet purged: their objects exist, so still kept.
    await t.ledger.expire({ table: 'metric_samples', beforeDay: '2026-11-19' })
    await t.ledger.expire({ table: 'metric_series', beforeDay: '2026-11-19' })
    const kept = await sweepOrphans(janitorEnv, t.tenant, later)
    expect(kept.deleted).toEqual([])
    // Purged: no step can ever make the leftover live, so it goes.
    expect((await purgeTenant(janitorEnv, t.tenant, { graceMs: 0 })).deleted).toHaveLength(8)
    expect((await sweepOrphans(janitorEnv, t.tenant, later)).deleted.sort()).toEqual(leftover)
    expect(await dataKeys(t.tenant)).toEqual([])
  })
})
