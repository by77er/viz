/**
 * The segment log (contracts/LEDGER-LOG.md): crashes between commit, segment write and row
 * deletion; a rebuild that reproduces exactly the state of a live ledger; checkpoints; the
 * first log layout; starting an incarnation outside `blockConcurrencyWhile` (review R-3);
 * readers that refuse what they do not know.
 */
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import {
  LEDGER_CHECKPOINT_KIND, decodeLedgerSegment, encodeLedgerSegment, ledgerBaseKey, ledgerCheckpointKey, ledgerLogKey, ledgerSegmentKey,
  ledgerSegmentsStartingAfter, parseLedgerLogKey, type FileEntry, type LedgerChange, type Table,
} from '../../contracts/ledger'
import { Ledger, type RebuildResult } from '../src/ledger'
import {
  DAY_MS, INC, S, T0, breakR2, dayOf, dumpState, everything, failure, file, heal, k, keys, listAll, logPrefix, loggedOf, loseStorage, nm, open,
  pair, readLog, readSegments, sleep, type Stub, tenantName, unit,
} from './helpers'

/** mulberry32, so a failing run can be repeated from its seed. */
function rng(seed: number) {
  let a = seed >>> 0
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return { next, int: (n: number) => Math.floor(next() * n), chance: (p: number) => next() < p, pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]! }
}

const setCheckpointEvery = (l: Stub, n: number) => runInDurableObject(l, (inst: Ledger) => { (inst as unknown as { checkpointEvery: number }).checkpointEvery = n })
const incarnationOf = async (l: Stub) => (await everything(l)).ledgerIncarnation
/** The state without the logged marks, which a rebuild sets to the watermark by definition. */
const committed = (d: Awaited<ReturnType<typeof dumpState>>) => ({ ...d, streams: d.streams.map(({ logged: _l, ...s }) => s) })

/** R2 holds, per incarnation, segments that never overlap and never leave a gap. */
async function expectContiguous(tenant: string): Promise<Map<number, number>> {
  const ends = new Map<number, number>()
  for (const s of await readSegments(tenant)) {
    const end = ends.get(s.ledgerIncarnation)
    if (end !== undefined) expect(s.first, `${s.key} follows ${end}`).toBe(end + 1)
    ends.set(s.ledgerIncarnation, s.last)
  }
  return ends
}

/**
 * A random workload on one ledger: two streams, units, merges of one file, expiry of both
 * tables, re-registration. Returns after each commit through `onCommit`.
 */
async function randomOp(l: Stub, r: ReturnType<typeof rng>, step: number, seqs: Map<string, { inc: number; seq: number }>): Promise<boolean> {
  const op = r.int(100)
  if (op < 60) {
    const shard = r.pick(['pool/0', 'pool/1'])
    const s = seqs.get(shard) ?? { inc: 100, seq: 0 }
    const hi = s.seq + 1 + r.int(3)
    const res = await l.addUnit(pair(s.seq + 1, hi, T0 + r.int(4) * DAY_MS + step, shard, s.inc))
    expect(res.status, JSON.stringify(res)).toBe('ok')
    seqs.set(shard, { inc: s.inc, seq: hi })
    return true
  }
  if (op < 80) {
    const table: Table = r.pick(['metric_samples', 'metric_series'])
    const files = (await everything(l, table)).files
    if (files.length === 0) return false
    const f = r.pick(files)
    const out: FileEntry = { table, day: f.day, key: `${f.key.slice(0, f.key.lastIndexOf('/') + 1)}L1-${step}`, bytes: f.bytes, rows: f.rows, minTs: f.minTs, maxTs: f.maxTs, level: 1, index: f.index }
    const res = await l.replace({ remove: [f.key], add: [out] })
    expect(res.status, JSON.stringify(res)).toBe('ok')
    return true
  }
  if (op < 88) {
    const res = await l.expire({ tables: ['metric_samples', 'metric_series'], beforeDay: dayOf(T0 + (1 + r.int(2)) * DAY_MS) })
    return res.removed.length > 0
  }
  const shard = r.pick(['pool/0', 'pool/1'])
  const s = seqs.get(shard)
  if (!s) return false
  // The shard lost its storage: a higher incarnation, starting again at 0.
  await l.registerStream({ shard, incarnation: s.inc + 1 })
  seqs.set(shard, { inc: s.inc + 1, seq: 0 })
  return true
}

describe('drain: crashes between commit, segment write and row deletion', () => {
  it('a retried drain writes exactly the segment it recorded, even after more changes committed (spec F10)', async () => {
    const { tenant, l } = open()
    await l.registerStream({ shard: S, incarnation: INC })
    await l.addUnit(pair(1, 1))
    // The PUT lands but its answer is lost: the rows stay, the bounds stay recorded.
    await breakR2(l, () => true, 'after')
    expect(await failure(l, (i) => i.drain())).toMatch(/answer lost/)
    expect(await l.logStatus()).toMatchObject({ inFlight: { first: 1, last: 2 }, pending: 2, loggedThrough: 0 })
    expect(await loggedOf(l)).toBe(0)
    // More commits arrive before the retry.
    await l.addUnit(pair(2, 2))
    await l.addUnit(pair(3, 3))
    await heal(l)
    expect(await l.drain()).toEqual({ written: 4 })
    const segs = await readSegments(tenant)
    expect(segs.map((s) => [s.first, s.last])).toEqual([[0, 0], [1, 2], [3, 4]]) // not 1..4 beside 1..2
    await expectContiguous(tenant)
    expect(await loggedOf(l)).toBe(3)
    // And across eviction: the record is in SQLite, not in memory.
    await l.addUnit(pair(4, 4))
    await breakR2(l, () => true, 'after')
    expect(await failure(l, (i) => i.drain())).toMatch(/answer lost/)
    await evictDurableObject(l)
    await l.addUnit(pair(5, 5))
    await l.drain()
    expect((await readSegments(tenant)).map((s) => [s.first, s.last])).toEqual([[0, 0], [1, 2], [3, 4], [5, 5], [6, 6]])
  })

  it('an object with other bytes at a segment\'s key is a fault: never overwritten, the drain stops, nothing more counts as logged', async () => {
    const { tenant, l } = open()
    await l.addUnit(pair(1, 1))
    const inc = await incarnationOf(l)
    const key = `${env.CELL}/${ledgerSegmentKey(tenant, inc, 1, 2)}`
    await env.BUCKET.put(key, 'someone else wrote this\n')
    expect(await failure(l, (i) => i.drain())).toMatch(/exists with other bytes/)
    expect(await (await env.BUCKET.get(key))!.text()).toBe('someone else wrote this\n')
    expect(await loggedOf(l)).toBe(0)
    expect(await l.outboxDepth()).toBe(2)
    // The alarm reports it and backs off for the longest delay.
    await runDurableObjectAlarm(l)
    const st = await l.logStatus()
    expect(st.lastError).toMatch(/exists with other bytes/)
    expect(st.alarmAt! - Date.now()).toBeGreaterThan(50_000)
  })

  it('under random crashes, failed writes and evictions, a rebuild reproduces the committed state up to the last written segment, and no shard was ever told to discard past it', { timeout: 120_000 }, async () => {
    for (const seed of [11, 12, 13]) {
      const r = rng(seed)
      const { tenant, l } = open(tenantName(`crash${seed}`))
      const seqs = new Map<string, { inc: number; seq: number }>()
      /** `incarnation/version` → the state right after that version committed. */
      const states = new Map<string, Awaited<ReturnType<typeof dumpState>>>()
      /** Highest logged watermark ever reported, per `shard/incarnation`. */
      const told = new Map<string, number>()
      const note = async () => states.set(`${await incarnationOf(l)}/${(await everything(l)).version}`, await dumpState(l))
      await note()
      let losses = 0
      for (let step = 0; step < 70; step++) {
        if (await randomOp(l, r, step, seqs)) await note()
        const x = r.int(100)
        if (x < 25) await l.drain()
        else if (x < 35) {
          await breakR2(l, () => true, r.pick(['before', 'after'] as const))
          await failure(l, (i) => i.drain())
          if (r.chance(0.5)) await heal(l)
        } else if (x < 42) await evictDurableObject(l) // a fresh instance has a working bucket
        if (r.chance(0.3)) {
          for (const w of await l.loggedWatermarks()) {
            const key = `${w.shard}/${w.incarnation}`
            told.set(key, Math.max(told.get(key) ?? 0, w.seq))
          }
        }
        if (step > 10 && losses < 2 && r.chance(0.05)) {
          // Storage is lost. R2 holds the segments up to some version: that is what must come back.
          const inc = await incarnationOf(l)
          const ends = await expectContiguous(tenant)
          const expected = states.get(`${inc}/${ends.get(inc)}`)
          expect(expected, `a state for ${inc}/${ends.get(inc)}`).toBeDefined()
          await loseStorage(l)
          const rebuilt = await dumpState(l)
          expect(committed(rebuilt), `seed ${seed} step ${step}: rebuilt state`).toEqual(committed(expected!))
          for (const w of (await everything(l)).watermarks) {
            const said = told.get(`${w.shard}/${w.incarnation}`) ?? 0
            expect(w.seq, `seed ${seed} step ${step}: ${w.shard} was told ${said} is logged`).toBeGreaterThanOrEqual(said)
          }
          // The workload continues from what survived.
          for (const w of (await everything(l)).watermarks) seqs.set(w.shard, { inc: w.incarnation, seq: w.seq })
          for (const [shard, s] of seqs) if (!(await everything(l)).watermarks.some((w) => w.shard === shard)) seqs.set(shard, { inc: s.inc, seq: 0 })
          await note()
          losses++
        }
      }
      await expectContiguous(tenant)
    }
  })
})

describe('rebuild reproduces exactly the state of a live ledger', () => {
  /** A history with every kind of change, two ledger incarnations and (optionally) checkpoints. */
  async function history(l: Stub, seed: number, checkpointEvery?: number): Promise<void> {
    const r = rng(seed)
    const seqs = new Map<string, { inc: number; seq: number }>()
    for (let step = 0; step < 60; step++) {
      if (checkpointEvery) await setCheckpointEvery(l, checkpointEvery)
      await randomOp(l, r, step, seqs)
      if (r.chance(0.4)) await l.drain()
      if (step === 30) {
        await l.drain()
        await loseStorage(l) // a second incarnation, started from the first one's log
      }
    }
    if (checkpointEvery) await setCheckpointEvery(l, checkpointEvery)
    await l.drain()
  }

  it('a fresh object of the same tenant, with empty storage, rebuilds the live object\'s exact state (files with precedence and unit, streams with previous incarnation, tombstones, version)', async () => {
    for (const seed of [21, 22]) {
      const { tenant, l } = open(tenantName(`exact${seed}`))
      await history(l, seed)
      const live = await dumpState(l)
      expect(live.files.length).toBeGreaterThan(3)
      expect(live.tombstones.length).toBeGreaterThan(0)
      // A second object: same tenant name, its own empty storage, same R2 log.
      const replica = env.LEDGER_REPLICA.get(env.LEDGER_REPLICA.idFromName(tenant))
      const started = await replica.logStatus()
      expect(['starting', 'ready']).toContain(started.phase)
      expect(await dumpState(replica as unknown as Stub)).toEqual({ ...live, version: live.version })
      // And the live object itself, after losing its storage.
      await loseStorage(l)
      expect(await dumpState(l)).toEqual(live)
    }
  })

  it('the same with checkpoints: a rebuild starts from the newest one and reads only the segments after it', async () => {
    const { tenant, l } = open(tenantName('ckpt'))
    await history(l, 31, 3)
    const live = await dumpState(l)
    const inc = await incarnationOf(l)
    const ckpts = (await listAll(`${logPrefix(tenant)}${inc}/ckpt-`)).map((key) => parseLedgerLogKey(key)!)
    expect(ckpts.length).toBeGreaterThan(1)
    const newest = Math.max(...ckpts.map((c) => (c as { version: number }).version))
    const segsAfter = (await readSegments(tenant)).filter((s) => s.ledgerIncarnation === inc && s.first > newest)
    // A checkpoint is a header and one base-kind line holding the state at its version.
    const body = await (await env.BUCKET.get(`${env.CELL}/${ledgerCheckpointKey(tenant, inc, newest)}`))!.text()
    const d = decodeLedgerSegment(body, { ledgerIncarnation: inc, firstVersion: newest, lastVersion: newest, kind: LEDGER_CHECKPOINT_KIND, tenant })
    expect(d.status).toBe('ok')
    expect(d.status === 'ok' && d.changes[0]!.kind).toBe('base')

    const result: RebuildResult = await runInDurableObject(l, async (i: Ledger, state) => {
      await state.storage.deleteAll()
      return i.rebuildFromLog()
    })
    expect(result).toMatchObject({ from: 'segments', checkpoint: newest, segmentsRead: segsAfter.length })
    expect(result.changesReplayed).toBe(live.version - newest)
    expect(await dumpState(l)).toEqual(live)
  })

  it('an unreadable checkpoint is passed over: the rebuild uses an older one or the base, and still comes back exactly', async () => {
    const { tenant, l } = open(tenantName('badckpt'))
    await history(l, 32, 4)
    const live = await dumpState(l)
    const inc = await incarnationOf(l)
    const ckpts = await listAll(`${logPrefix(tenant)}${inc}/ckpt-`)
    expect(ckpts.length).toBeGreaterThan(0)
    await env.BUCKET.put(ckpts.at(-1)!, 'not a checkpoint\n')
    const result: RebuildResult = await runInDurableObject(l, async (i: Ledger, state) => {
      await state.storage.deleteAll()
      return i.rebuildFromLog()
    })
    const older = ckpts.slice(0, -1).map((key) => (parseLedgerLogKey(key) as { version: number }).version)
    expect(result.checkpoint).toBe(older.length > 0 ? Math.max(...older) : null)
    expect(await dumpState(l)).toEqual(live)
  })
})

describe('the first log layout (one object per change)', () => {
  it('a ledger with empty storage rebuilds from a log written by the as-built ledger (an independent writer), then continues in segments', async () => {
    const tenant = tenantName('layout1')
    const old = env.LEDGER_ASBUILT.get(env.LEDGER_ASBUILT.idFromName(tenant))
    open(tenant) // `file` keys for this tenant
    await old.registerStream({ shard: S, incarnation: INC })
    await old.addUnit(pair(1, 4, T0))
    await old.addUnit(pair(5, 9, T0 + DAY_MS))
    await old.addUnit(pair(1, 2, T0, 'pool/7', 3))
    await old.replace({ remove: [pair(1, 4, T0).files[0]!.key], add: [file('L1-a', { level: 1 })] })
    await old.expire({ table: 'metric_series', beforeDay: dayOf(T0 + DAY_MS) })
    await old.registerStream({ shard: 'pool/7', incarnation: 4 })
    const want = { samples: await everything(old as unknown as Stub), series: await everything(old as unknown as Stub, 'metric_series') }
    expect(await listAll(`${logPrefix(tenant)}1/`)).toContain(`${env.CELL}/${ledgerBaseKey(tenant, 1)}`)
    expect(await listAll(`${logPrefix(tenant)}1/`)).toContain(`${env.CELL}/${ledgerLogKey(tenant, 1, 7)}`)

    const l = env.LEDGER.get(env.LEDGER.idFromName(tenant))
    const samples = await everything(l)
    expect(samples.files).toEqual(want.samples.files)
    expect(samples.watermarks).toEqual(want.samples.watermarks)
    expect((await everything(l, 'metric_series')).files).toEqual(want.series.files)
    expect(samples.ledgerIncarnation).toBe(2)
    expect((await l.registerStream({ shard: 'pool/7', incarnation: 4 })).previousIncarnation).toBe(3)
    expect((await l.removedSince(0)).map((t) => nm(t.key)).sort()).toEqual([nm(pair(1, 4, T0).files[0]!.key), nm(pair(1, 4, T0).files[1]!.key), nm(pair(1, 2, T0, 'pool/7', 3).files[1]!.key)].sort())
    await l.addUnit(pair(10, 12, T0))
    await l.drain()
    expect((await readSegments(tenant)).map((s) => [s.ledgerIncarnation, s.first, s.last])).toEqual([[2, 7, 7], [2, 8, 8]])
  })

  it('refuses to replay a first-layout change of a kind it does not know, instead of applying it (design/UPGRADES.md §7)', async () => {
    const tenant = tenantName('layout1bad')
    const old = env.LEDGER_ASBUILT.get(env.LEDGER_ASBUILT.idFromName(tenant))
    open(tenant)
    await old.addUnit(pair(1, 1))
    const key = `${env.CELL}/${ledgerLogKey(tenant, 1, 2)}`
    const c = await (await env.BUCKET.get(key))!.json<LedgerChange>()
    await env.BUCKET.put(key, JSON.stringify({ ...c, kind: 'add_units_v2' }))
    const l = env.LEDGER.get(env.LEDGER.idFromName(tenant))
    expect(await l.plan({ table: 'metric_samples', minTs: 0, maxTs: 1 }).then(() => 'served', (e: Error) => e.message)).toMatch(/ledger_unavailable/)
    expect((await l.logStatus()).lastError).toMatch(/unsupported: unknown change kind "add_units_v2"/)
    expect(await listAll(`${logPrefix(tenant)}2/`)).toEqual([]) // no new incarnation over it
  })

  it('storage still running a first-layout incarnation starts a new incarnation from SQLite: unlogged changes are in its base, nothing is lost', async () => {
    const { tenant, l } = open()
    await l.registerStream({ shard: S, incarnation: INC })
    await l.addUnit(pair(1, 5))
    await l.addUnit(pair(6, 9))
    const before = await dumpState(l)
    const inc = await incarnationOf(l)
    // As the code before segments left it: no log format, changes still in the outbox.
    await runInDurableObject(l, (_i, state) => state.storage.sql.exec(`DELETE FROM meta WHERE k IN ('log_format', 'logged_through', 'segs_since_ckpt')`))
    await evictDurableObject(l)
    expect(await seqOf2(l)).toBe(9)
    expect(await incarnationOf(l)).toBe(inc + 1)
    expect(await l.outboxDepth()).toBe(0)
    expect(await loggedOf(l)).toBe(9) // the base holds it: a shard may discard it
    const base = (await readSegments(tenant)).find((s) => s.ledgerIncarnation === inc + 1)!.changes[0]!
    expect(base).toMatchObject({ kind: 'base', version: before.version })
    expect(committed(await dumpState(l))).toEqual(committed(before))
  })
})

const seqOf2 = async (l: Stub) => (await everything(l)).watermarks.find((w) => w.shard === S)?.seq

describe('starting an incarnation (review R-3: never across R2 inside blockConcurrencyWhile)', () => {
  it('while a rebuild is slow, the object keeps answering: requests wait a bounded time and are refused as retryable; afterwards it serves', async () => {
    const { tenant, l } = open()
    await l.addUnit(pair(1, 3))
    await l.drain()
    const proto = Ledger.prototype as unknown as { latestIncarnation(this: Ledger): Promise<number | null> }
    const real = proto.latestIncarnation
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    proto.latestIncarnation = async function (this: Ledger) {
      await gate // R2 is very slow
      return real.call(this)
    }
    try {
      await loseStorage(l)
      const t0 = Date.now()
      const refused = await l.plan({ table: 'metric_samples', minTs: 0, maxTs: Number.MAX_SAFE_INTEGER }).then(() => 'served', (e: Error) => e.message)
      const waited = Date.now() - t0
      expect(refused).toMatch(/^ledger_unavailable: it is starting a ledger incarnation/)
      expect(waited).toBeGreaterThanOrEqual(1_900)
      expect(waited).toBeLessThan(10_000)
      // Not blocked: another call is answered at once while the rebuild is still waiting on R2.
      const t1 = Date.now()
      expect(await l.logStatus()).toMatchObject({ phase: 'starting' })
      expect(Date.now() - t1).toBeLessThan(500)
      expect(await l.addUnit(pair(4, 4)).then(() => 'served', (e: Error) => e.message)).toMatch(/ledger_unavailable/)
    } finally {
      release()
      proto.latestIncarnation = real
    }
    expect(keys(await everything(l))).toEqual([nm(pair(1, 3).files[0]!.key)])
    expect((await l.logStatus()).phase).toBe('ready')
    expect(tenant).toBeTruthy()
  })

  it('a start that fails (R2 unreadable) is retried by the alarm without any request', async () => {
    const { l } = open()
    await l.addUnit(pair(1, 3))
    await l.drain()
    const proto = Ledger.prototype as unknown as { latestIncarnation(this: Ledger): Promise<number | null> }
    const real = proto.latestIncarnation
    proto.latestIncarnation = async () => { throw new Error('injected: R2 list failed') }
    try {
      await loseStorage(l)
      expect(await l.plan({ table: 'metric_samples', minTs: 0, maxTs: 1 }).then(() => 'served', (e: Error) => e.message)).toMatch(/ledger_unavailable: its log could not be read/)
      const st = await l.logStatus()
      expect(st).toMatchObject({ phase: 'starting', lastError: expect.stringMatching(/R2 list failed/) })
      expect(st.alarmAt).not.toBeNull()
    } finally {
      proto.latestIncarnation = real
    }
    await runDurableObjectAlarm(l)
    expect((await l.logStatus()).phase).toBe('ready')
    expect(await seqOf2(l)).toBe(3)
  })

  it('storage with a version row and no incarnation is refused, never rebuilt over (design/UPGRADES.md §7)', async () => {
    const { tenant, l } = open()
    await l.addUnit(pair(1, 3))
    await l.drain()
    const segments = await listAll(logPrefix(tenant))
    await runInDurableObject(l, (_i, state) => state.storage.sql.exec(`DELETE FROM meta WHERE k = 'incarnation'`))
    await evictDurableObject(l)
    expect(await l.plan({ table: 'metric_samples', minTs: 0, maxTs: 1 }).then(() => 'served', (e: Error) => e.message)).toMatch(/schema version but no ledger incarnation/)
    expect(await l.logStatus()).toMatchObject({ phase: 'corrupt' })
    expect(await listAll(logPrefix(tenant))).toEqual(segments) // nothing written to R2
  })
})

describe('the drain on its own', () => {
  it('with the default delay, a commit reaches R2 by itself within a second or so, and no alarm is left behind', async () => {
    const { tenant, l } = open()
    await runInDurableObject(l, (inst: Ledger) => { (inst as unknown as { drainDelayMs: number }).drainDelayMs = 200 })
    await l.addUnit(pair(1, 3))
    await l.addUnit(pair(4, 6))
    const t0 = Date.now()
    while ((await loggedOf(l)) !== 6) {
      expect(Date.now() - t0).toBeLessThan(5_000)
      await sleep(50)
    }
    // Both commits went out in one segment.
    expect((await readSegments(tenant)).map((s) => [s.first, s.last])).toEqual([[0, 0], [1, 3]])
    expect(await readLog(tenant)).toHaveLength(3)
    expect(await runDurableObjectAlarm(l)).toBe(false)
  })
})

describe('readers refuse what they do not know (contracts/COMPATIBILITY.md §3.2)', () => {
  const lines = (...c: object[]) => c.map((x, i) => ({ version: 5 + i, json: JSON.stringify(x) }))
  const change = (version: number, over: object = {}) => ({ ledgerIncarnation: 3, version, at: 1, kind: 'add_unit', added: [], removed: [], ...over })
  const expected = { ledgerIncarnation: 3, firstVersion: 5, lastVersion: 6, tenant: 't' }

  it('decodes what it encodes, ignores unknown fields, refuses unknown versions and kinds, and calls disagreements corrupt', () => {
    const ok = encodeLedgerSegment('t', 3, lines(change(5), change(6, { extra: 'ignored' })))
    expect(ok.split('\n')[0]).toBe('{"v":1,"kind":"viz.ledger.segment","tenant":"t","ledgerIncarnation":3,"firstVersion":5,"lastVersion":6,"changes":2}')
    const d = decodeLedgerSegment(ok, expected)
    expect(d.status).toBe('ok')
    expect(d.status === 'ok' && d.changes.map((c) => c.version)).toEqual([5, 6])
    const header = (h: object) => [JSON.stringify({ v: 1, kind: 'viz.ledger.segment', tenant: 't', ledgerIncarnation: 3, firstVersion: 5, lastVersion: 6, changes: 2, ...h }), ...ok.split('\n').slice(1)].join('\n')
    expect(decodeLedgerSegment(header({ future: true }), expected).status).toBe('ok')
    expect(decodeLedgerSegment(header({ v: 2 }), expected)).toMatchObject({ status: 'unsupported', reason: expect.stringMatching(/segment version 2/) })
    expect(decodeLedgerSegment(header({ kind: 'viz.ledger.snapshot' }), expected)).toMatchObject({ status: 'unsupported' })
    expect(decodeLedgerSegment(encodeLedgerSegment('t', 3, lines(change(5), change(6, { kind: 'split' }))), expected)).toMatchObject({ status: 'unsupported', reason: expect.stringMatching(/unknown change kind/) })
    expect(decodeLedgerSegment(encodeLedgerSegment('t', 3, lines(change(5, { v: 2 }), change(6))), expected)).toMatchObject({ status: 'unsupported', reason: expect.stringMatching(/change version 2/) })
    expect(decodeLedgerSegment(ok, { ...expected, lastVersion: 7 }).status).toBe('corrupt')
    expect(decodeLedgerSegment(ok, { ...expected, tenant: 'u' }).status).toBe('corrupt')
    expect(decodeLedgerSegment(ok.slice(0, -1), expected).status).toBe('corrupt') // no final newline
    expect(decodeLedgerSegment(encodeLedgerSegment('t', 3, lines(change(5), change(7))) , expected).status).toBe('corrupt')
    expect(() => encodeLedgerSegment('t', 3, [{ version: 5, json: '{}' }, { version: 7, json: '{}' }])).toThrow(/not contiguous/)
    // Keys parse back to what made them; the listing bound starts right after a version.
    expect(parseLedgerLogKey(`c/${ledgerSegmentKey('t', 3, 5, 6)}`)).toEqual({ type: 'segment', ledgerIncarnation: 3, firstVersion: 5, lastVersion: 6 })
    expect(parseLedgerLogKey(`c/${ledgerCheckpointKey('t', 3, 9)}`)).toEqual({ type: 'checkpoint', ledgerIncarnation: 3, version: 9 })
    const after = ledgerSegmentsStartingAfter('t', 3, 6)
    expect(ledgerSegmentKey('t', 3, 5, 6) < after && ledgerSegmentKey('t', 3, 6, 9) < after && ledgerSegmentKey('t', 3, 7, 7) > after).toBe(true)
  })

  it('a rebuild stops at a segment written by a newer release, rather than skip or guess', async () => {
    const { tenant, l } = open()
    await l.addUnit(pair(1, 1))
    await l.drain()
    await l.addUnit(pair(2, 2))
    await l.drain()
    const last = (await readSegments(tenant)).at(-1)!
    const body = await (await env.BUCKET.get(last.key))!.text()
    await env.BUCKET.put(last.key, body.replace('{"v":1,', '{"v":2,'))
    const outcome = await runInDurableObject(l, async (i: Ledger, state) => {
      await state.storage.deleteAll()
      return i.rebuildFromLog().then(() => 'rebuilt', (e: Error) => e.message)
    })
    expect(outcome).toMatch(/unsupported: segment version 2/)
  })
})

describe('the change log as a counterfactual: the as-built ledger and this one agree', () => {
  it('the same workload gives the same live set, watermarks and versions in both', async () => {
    const tenant = tenantName('same')
    open(tenant)
    const a = env.LEDGER_ASBUILT.get(env.LEDGER_ASBUILT.idFromName(`${tenant}`)) as unknown as Stub
    const b = env.LEDGER_REPLICA.get(env.LEDGER_REPLICA.idFromName(tenant)) as unknown as Stub
    const r1 = rng(41)
    const r2 = rng(41)
    const s1 = new Map<string, { inc: number; seq: number }>()
    const s2 = new Map<string, { inc: number; seq: number }>()
    for (let step = 0; step < 40; step++) {
      await randomOp(a, r1, step, s1)
      await randomOp(b, r2, step, s2)
    }
    for (const t of ['metric_samples', 'metric_series'] as const) {
      const [pa, pb] = [await everything(a, t), await everything(b, t)]
      expect(pb.files).toEqual(pa.files)
      expect(pb.watermarks).toEqual(pa.watermarks)
      expect(pb.version).toBe(pa.version)
    }
    expect(await b.removedSince(0)).toEqual(expect.arrayContaining([]))
    expect((await b.removedSince(0)).map((t) => [t.key, t.version])).toEqual((await a.removedSince(0)).map((t) => [t.key, t.version]))
    expect(k).toBeTruthy()
    expect(unit).toBeTruthy()
  })
})
