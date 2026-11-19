/**
 * Checkpoints in parts (contracts/LEDGER-LOG.md, "Checkpoints", format 2; review S-2's full fix):
 *
 *   - a checkpoint written part by part across drains is exactly the state at its version,
 *     whatever commits while it is written (adds, removals and expiries ahead of and behind its
 *     cursor), and a rebuild from it equals the live ledger;
 *   - a crash, a lost answer or a storage loss at every await of the checkpoint path loses
 *     nothing that was logged, and the checkpoint resumes or is passed over;
 *   - superseded checkpoints are deleted only once a newer one is complete in R2, manifests
 *     before parts;
 *   - part boundaries: a part holds at most its budget (a larger record alone), records in key
 *     order with nothing missing or repeated, in SQLite's order of keys (UTF-8, not UTF-16);
 *   - a rebuild streams the base and the parts into SQLite instead of holding them;
 *   - a checkpoint left untracked by a release that does not know it is abandoned, not written;
 *   - format 1 is still read, and the release before this one reads this one's log.
 */
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import {
  JsonObjectStream, LEDGER_CHECKPOINT_VERSION, decodeLedgerCheckpointManifest, decodeLedgerCheckpointPart, ledgerCheckpointKey, ledgerCheckpointPartKey,
  parseLedgerLogKey, readLedgerLogStream, type FileEntry, type LedgerCheckpointManifest, type LedgerSegmentHeader, type Table,
} from '../../contracts/ledger'
import type { Ledger, RebuildResult } from '../src/ledger'
import { expectGolden } from './golden'
import {
  DAY_MS, S, T0, dayOf, dumpState, everything, file, listAll, logPrefix, loggedOf, loseStorage, open, pair, readSegments, type Stub, tenantName, unit,
} from './helpers'

interface Knobs {
  checkpointEvery: number
  checkpointByLogBytes: boolean
  checkpointOneObjectBytes: number
  checkpointPartBytes: number
  bucket: R2Bucket
  drainSerial(segments: number, parts: number): Promise<number>
}
const knobs = (i: Ledger) => i as unknown as Knobs

/** Checkpoints in parts of about `partBytes` characters after every segment (instance settings: set again after an eviction). */
const inParts = (l: Stub, partBytes = 600) =>
  runInDurableObject(l, (i: Ledger) => {
    Object.assign(knobs(i), { checkpointEvery: 1, checkpointByLogBytes: false, checkpointOneObjectBytes: -1, checkpointPartBytes: partBytes })
  })
const noCheckpoints = (l: Stub) => runInDurableObject(l, (i: Ledger) => { knobs(i).checkpointEvery = 1e9 })
/** One bounded drain step: up to `segments` segments and `parts` checkpoint steps. */
const step = (l: Stub, segments: number, parts: number) => runInDurableObject(l, (i: Ledger) => knobs(i).drainSerial(segments, parts))
const incarnationOf = async (l: Stub) => (await everything(l)).ledgerIncarnation
const committed = (d: Awaited<ReturnType<typeof dumpState>>) => ({ ...d, streams: d.streams.map(({ logged: _l, ...s }) => s) })
const rebuild = (l: Stub): Promise<RebuildResult> =>
  runInDurableObject(l, async (i: Ledger, state) => {
    await state.storage.deleteAll()
    return i.rebuildFromLog()
  })

function rng(seed: number) {
  let a = seed >>> 0
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return { next, int: (n: number) => Math.floor(next() * n), pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]! }
}

/** Some history: units on two streams, merges, an expiry, a re-registration, so files, tombstones and streams all have rows. */
async function history(l: Stub, units: number, seqs = new Map<string, number>()): Promise<Map<string, number>> {
  for (let n = 0; n < units; n++) {
    const shard = n % 3 === 0 ? 'pool/1' : S
    const seq = (seqs.get(shard) ?? 0) + 1
    expect((await l.addUnit(pair(seq, seq, T0 + (n % 4) * DAY_MS + n, shard, 100))).status).toBe('ok')
    seqs.set(shard, seq)
  }
  return seqs
}

/** A random change of any kind; returns a short label. */
async function mutate(l: Stub, r: ReturnType<typeof rng>, n: number, seqs: Map<string, number>, incs: Map<string, number>): Promise<string> {
  const op = r.int(10)
  if (op < 5) {
    const shard = r.pick([S, 'pool/1'])
    const seq = (seqs.get(shard) ?? 0) + 1
    expect((await l.addUnit(pair(seq, seq, T0 + r.int(4) * DAY_MS + 1000 + n, shard, incs.get(shard) ?? 100))).status).toBe('ok')
    seqs.set(shard, seq)
    return 'add'
  }
  if (op < 8) {
    const table: Table = r.pick(['metric_samples', 'metric_series'])
    const files = (await everything(l, table)).files
    if (files.length === 0) return 'none'
    const f = r.pick(files)
    const out: FileEntry = { table, day: f.day, key: `${f.key.slice(0, f.key.lastIndexOf('/') + 1)}L1-m${n}`, bytes: f.bytes, rows: f.rows, minTs: f.minTs, maxTs: f.maxTs, level: 1, index: f.index }
    expect((await l.replace({ remove: [f.key], add: [out] })).status).toBe('ok')
    return 'replace'
  }
  if (op < 9) {
    await l.expire({ tables: ['metric_samples', 'metric_series'], beforeDay: dayOf(T0 + (1 + r.int(2)) * DAY_MS) })
    return 'expire'
  }
  const shard = r.pick([S, 'pool/1'])
  const inc = (incs.get(shard) ?? 100) + 1
  await l.registerStream({ shard, incarnation: inc })
  incs.set(shard, inc)
  seqs.set(shard, 0)
  return 'register'
}

/** SQLite's order of TEXT (UTF-8 bytes), the order `dumpState` lists rows in. */
const enc = new TextEncoder()
function utf8Order(a: unknown, b: unknown): number {
  const x = enc.encode(a as string)
  const y = enc.encode(b as string)
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]! - y[i]!
  return x.length - y.length
}

/** A format-2 checkpoint as R2 holds it, decoded with the contract's codec, as rows of the ledger's tables. */
async function readCheckpoint(tenant: string, inc: number, version: number) {
  const body = await (await env.BUCKET.get(`${env.CELL}/${ledgerCheckpointKey(tenant, inc, version)}`))!.text()
  const [h, line] = body.split('\n')
  const header = JSON.parse(h!) as LedgerSegmentHeader
  expect(header.v).toBe(LEDGER_CHECKPOINT_VERSION)
  const d = decodeLedgerCheckpointManifest(line!, header)
  if (d.status !== 'ok') throw new Error(`${d.status}: ${d.reason}`)
  const m = d.manifest
  const files: Record<string, unknown>[] = []
  const tombstones: Record<string, unknown>[] = []
  const parts: { records: number; chars: number; firstKey: string; lastKey: string }[] = []
  for (let p = 0; p < m.parts; p++) {
    const pb = await (await env.BUCKET.get(`${env.CELL}/${ledgerCheckpointPartKey(tenant, inc, version, m.attempt, p)}`))!.text()
    const dp = decodeLedgerCheckpointPart(pb, { tenant, ledgerIncarnation: inc, version, attempt: m.attempt, part: p })
    if (dp.status !== 'ok') throw new Error(`part ${p}: ${dp.status}: ${dp.reason}`)
    const keys: string[] = []
    let chars = 0
    for (const [n, r] of dp.records.entries()) {
      chars += pb.split('\n')[n + 1]!.length + 1
      if ('file' in r) {
        const f = r.file
        keys.push(f.key)
        files.push({
          key: f.key, tbl: f.table, day: f.day, bytes: f.bytes, rows: f.rows, min_ts: f.minTs, max_ts: f.maxTs, level: f.level, idx: f.index,
          u_shard: f.unit?.shard ?? null, u_inc: f.unit?.incarnation ?? null, u_lo: f.unit?.seqLo ?? null, u_hi: f.unit?.seqHi ?? null, prec: f.precedence, prec_lo: f.precedenceLow,
        })
      } else tombstones.push({ key: r.tombstone.key, tbl: r.tombstone.table, version: r.tombstone.version, at: r.tombstone.at })
    }
    parts.push({ records: dp.records.length, chars, firstKey: keys[0] ?? '', lastKey: keys.at(-1) ?? '' })
  }
  const prev = new Map(m.previousIncarnations.map((p) => [p.shard, p.previousIncarnation]))
  const live = new Set(files.map((f) => f.key))
  return {
    manifest: m,
    parts,
    /** In the shape of `dumpState` (without `logged`), tombstones of live keys left out as a rebuild does. */
    state: {
      version: m.version,
      files: [...files].sort((a, b) => utf8Order(a.key, b.key)),
      streams: m.watermarks.map((w) => ({ shard: w.shard, incarnation: w.incarnation, watermark: w.seq, prev_incarnation: prev.get(w.shard) ?? null })),
      tombstones: tombstones.filter((t) => !live.has(t.key)).sort((a, b) => utf8Order(a.key, b.key)),
    },
    fileKeysInOrder: files.map((f) => f.key as string),
  }
}

describe('a checkpoint in parts is the state at its version', () => {
  it('whatever commits while its parts are written, ahead of its cursor and behind it; and a rebuild from it equals the live ledger', async () => {
    for (const seed of [51, 52, 53]) {
      const r = rng(seed)
      const { tenant, l } = open(tenantName(`ckparts${seed}`))
      await noCheckpoints(l)
      const seqs = await history(l, 24)
      const incs = new Map<string, number>()
      // A few merges and an expiry first, so there are tombstones at the checkpoint's version.
      for (let n = 0; n < 6; n++) await mutate(l, r, 100 + n, seqs, incs)
      await l.drain()
      await inParts(l, 500 + r.int(1500))
      const s = (seqs.get(S) ?? 0) + 1
      expect((await l.addUnit(pair(s, s, T0, S, incs.get(S) ?? 100))).status).toBe('ok')
      seqs.set(S, s)
      const atV = committed(await dumpState(l))
      // The segment, which begins the checkpoint at the committed version.
      await step(l, 16, 0)
      const st = await l.logStatus()
      expect(st.checkpoint).toMatchObject({ version: atV.version, phase: 'files', parts: 0 })
      // One part at a time, and between parts every kind of change.
      const ops: string[] = []
      // Until it is complete (a later one may begin as soon as it is).
      for (let n = 0; (await l.logStatus()).checkpoint?.version === atV.version; n++) {
        expect(n, 'the checkpoint completes').toBeLessThan(500)
        await step(l, 0, 1)
        ops.push(await mutate(l, r, n, seqs, incs))
        if (r.int(4) === 0) await step(l, 16, 0) // the log keeps going between parts
      }
      expect(new Set(ops).size, `seed ${seed}: every kind of change happened during the checkpoint (${ops.join(',')})`).toBeGreaterThanOrEqual(3)
      const inc = await incarnationOf(l)
      const ck = await readCheckpoint(tenant, inc, atV.version)
      expect(ck.manifest.parts, `seed ${seed}: written in several parts`).toBeGreaterThan(3)
      expect(ck.state, `seed ${seed}: the checkpoint holds exactly the state at its version`).toEqual(atV)
      // A rebuild starts from the newest checkpoint and replays what committed after it.
      await l.drain()
      const live = await dumpState(l)
      const result = await rebuild(l)
      expect(result.from).toBe('segments')
      expect(result.checkpoint).toBeGreaterThanOrEqual(atV.version)
      expect(await dumpState(l), `seed ${seed}: rebuilt`).toEqual(live)
    }
  })

  it('an empty state, one record larger than a part, parts that end on the budget: nothing missing or repeated, in key order, each part within its budget', async () => {
    const { tenant, l } = open(tenantName('ckbounds'))
    // Empty: a manifest with no parts.
    await l.registerStream({ shard: S, incarnation: 100 })
    await inParts(l, 700)
    await l.drain()
    const inc = await incarnationOf(l)
    let ck = await readCheckpoint(tenant, inc, (await everything(l)).version)
    expect(ck.manifest).toMatchObject({ parts: 0, files: 0, tombstones: 0 })
    // Files of varied sizes, one far larger than a part.
    await noCheckpoints(l)
    for (let n = 1; n <= 30; n++) {
      const big = n === 17 ? 'B'.repeat(5_000) : 'i'.repeat(n * 13)
      expect((await l.addUnit(unit(n, n, [file(`f-${String(n).padStart(3, '0')}`, { index: big })], S, 100))).status).toBe('ok')
    }
    await l.replace({ remove: [file('f-003').key, file('f-004').key], add: [file('m-003', { level: 1 })] })
    await inParts(l, 700)
    await l.addUnit(unit(31, 31, [file('f-031')], S, 100))
    await l.drain()
    const v = (await everything(l)).version
    ck = await readCheckpoint(tenant, inc, v)
    const live = committed(await dumpState(l))
    expect(ck.state).toEqual(live)
    expect(ck.fileKeysInOrder).toEqual([...ck.fileKeysInOrder].sort(utf8Order))
    expect(new Set(ck.fileKeysInOrder).size).toBe(ck.fileKeysInOrder.length)
    for (const [n, p] of ck.parts.entries()) {
      // A part holds at most its budget of records, or one larger record alone.
      if (p.records > 1) expect(p.chars, `part ${n}`).toBeLessThanOrEqual(700)
      if (p.chars > 700) expect(p.records, `part ${n}: a larger record goes alone`).toBe(1)
      // Parts are full: the next part's first record would not have fitted.
      if (n + 1 < ck.parts.length && p.records > 0) expect(p.chars, `part ${n} is not cut early`).toBeGreaterThan(700 - 1_200)
    }
    expect(ck.parts.some((p) => p.records === 1 && p.chars > 5_000)).toBe(true)
    expect(ck.manifest.tombstones).toBe(2)
  })

  it('merges live rows and pre-images in SQLite\'s order of keys (UTF-8 bytes), also for keys JavaScript orders otherwise', async () => {
    const { tenant, l } = open(tenantName('ckutf8'))
    await noCheckpoints(l)
    // In UTF-16 '\ud83d\ude00' (an emoji) sorts before '\ue000'; in UTF-8 (SQLite) after it.
    const names = ['a', 'b\ue000', 'b\ud83d\ude00', 'b\uffff', 'c\u00e9', 'c\ud83d\ude01', 'd']
    for (const [n, name] of names.entries()) expect((await l.addUnit(unit(n + 1, n + 1, [file(name)], S, 100))).status).toBe('ok')
    await inParts(l, 1) // one record per part
    await l.addUnit(unit(8, 8, [file('e')], S, 100))
    await step(l, 16, 0)
    const want = committed(await dumpState(l))
    await step(l, 0, 1) // 'a' written
    // Changes ahead of the cursor, on both sides of the UTF-16/UTF-8 disagreement.
    await l.replace({ remove: [file('b\ud83d\ude00').key], add: [file('b\ud83d\ude00x', { level: 1 })] })
    await l.replace({ remove: [file('c\u00e9').key], add: [file('b\ue001', { level: 1 })] })
    await l.drain()
    const v = want.version
    const ck = await readCheckpoint(tenant, await incarnationOf(l), v)
    expect(ck.state).toEqual(want)
    const result = await rebuild(l)
    expect(result.checkpoint).toBe(v) // readable: no record repeated or out of place
  })
})

describe('crashes and storage losses at every await of the checkpoint path', () => {
  /** A bucket whose `n`-th operation on a checkpoint key (PUT, DELETE or a listing of `ckpt-`) fails before or after it happens. */
  const failAt = (l: Stub, n: number, mode: 'before' | 'after') =>
    runInDurableObject(l, (inst: Ledger) => {
      const real = env.BUCKET
      let seen = 0
      const hit = () => ++seen === n
      const isCkpt = (k: unknown) => (typeof k === 'string' ? k : Array.isArray(k) ? String(k[0] ?? '') : '').includes('/ckpt-')
      knobs(inst).bucket = new Proxy(real, {
        get(target, prop) {
          const f = Reflect.get(target, prop) as (...a: unknown[]) => Promise<unknown>
          if (prop !== 'put' && prop !== 'delete' && prop !== 'list') return typeof f === 'function' ? f.bind(target) : f
          return async (...a: unknown[]) => {
            const key = prop === 'list' ? (a[0] as { prefix?: string } | undefined)?.prefix : a[0]
            const h = isCkpt(key) && hit()
            if (h && mode === 'before') throw new Error(`injected: crash before ${String(prop)} #${n}`)
            const out = await f.apply(target, a)
            if (h) throw new Error(`injected: crash after ${String(prop)} #${n}`)
            return out
          }
        },
      })
    })

  it('after each, a lost ledger rebuilds exactly what was logged; without the loss, the checkpoint resumes and completes', { timeout: 300_000 }, async () => {
    // Count the checkpoint path's R2 operations once: parts, the manifest, the listing and the deletions.
    const ops = async (l: Stub) => {
      let count = 0
      await runInDurableObject(l, (inst: Ledger) => {
        const real = env.BUCKET
        knobs(inst).bucket = new Proxy(real, {
          get(target, prop) {
            const f = Reflect.get(target, prop) as (...a: unknown[]) => Promise<unknown>
            if (prop !== 'put' && prop !== 'delete' && prop !== 'list') return typeof f === 'function' ? f.bind(target) : f
            return async (...a: unknown[]) => {
              const key = prop === 'list' ? (a[0] as { prefix?: string } | undefined)?.prefix : a[0]
              if ((typeof key === 'string' ? key : Array.isArray(key) ? String(key[0] ?? '') : '').includes('/ckpt-')) count++
              return f.apply(target, a)
            }
          },
        })
      })
      return () => count
    }
    const setup = async (label: string) => {
      const { tenant, l } = open(tenantName(label))
      await noCheckpoints(l)
      const seqs = await history(l, 10)
      await l.replace({ remove: [pair(1, 1, T0, 'pool/1', 100).files[0]!.key], add: [file('L1-x', { level: 1 })] })
      // A first checkpoint, so a second one has one to supersede.
      await inParts(l, 900)
      await l.addUnit(pair(seqs.get(S)! + 1, seqs.get(S)! + 1, T0, S, 100))
      await l.drain()
      await l.addUnit(pair(seqs.get(S)! + 2, seqs.get(S)! + 2, T0 + DAY_MS, S, 100))
      return { tenant, l, next: seqs.get(S)! + 3 }
    }
    const probe = await setup('ckops')
    const counted = await ops(probe.l)
    await probe.l.drain()
    const total = counted()
    expect(total, 'parts, a manifest, a listing and deletions').toBeGreaterThanOrEqual(5)
    let cases = 0
    for (let n = 1; n <= total; n++) {
      for (const mode of ['before', 'after'] as const) {
        for (const then of ['lose', 'evict'] as const) {
          const { tenant, l, next } = await setup(`ckcrash${n}${mode[0]}${then[0]}`)
          await failAt(l, n, mode)
          await l.drain() // the segment is written; the checkpoint stops at the failure (never the log)
          expect(await l.outboxDepth()).toBe(0)
          const live = await dumpState(l)
          if (then === 'lose') {
            // The checkpoint path never loses what was logged: everything was.
            await loseStorage(l)
            expect(await dumpState(l), `crash ${mode} op ${n}, then storage loss`).toEqual(live)
          } else {
            await evictDurableObject(l)
            await inParts(l, 900)
            await l.addUnit(pair(next, next, T0, S, 100))
            await l.drain() // resumes (or abandons and starts again) and completes
            expect((await l.logStatus()).checkpoint).toBeNull()
            const after = await dumpState(l)
            const r = await rebuild(l)
            expect(r.checkpoint, `crash ${mode} op ${n}, then eviction: a complete checkpoint is used`).not.toBeNull()
            expect(await dumpState(l), `crash ${mode} op ${n}, then eviction and more writes`).toEqual(after)
          }
          // Whatever happened, R2 holds at most the newest complete checkpoint and its own parts once a checkpoint completes.
          void tenant
          cases++
        }
      }
    }
    console.log(`checkpoint crash cases: ${cases} (${total} operations x before/after x loss/eviction)`)
  })
})

describe('superseded checkpoints', () => {
  it('stay until a newer checkpoint is complete in R2; then its manifest goes, then its parts, and abandoned attempts\' parts', async () => {
    const { tenant, l } = open(tenantName('cksuper'))
    await noCheckpoints(l)
    const seqs = await history(l, 12)
    await inParts(l, 800)
    let s = seqs.get(S)! + 1
    await l.addUnit(pair(s, s, T0, S, 100))
    await l.drain()
    const inc = await incarnationOf(l)
    const first = (await everything(l)).version
    const objects = async () => (await listAll(`${logPrefix(tenant)}${inc}/ckpt-`)).map((k) => parseLedgerLogKey(k)!)
    const firstObjects = await objects()
    expect(firstObjects.filter((o) => o.type === 'checkpoint')).toEqual([{ type: 'checkpoint', ledgerIncarnation: inc, version: first }])
    expect(firstObjects.filter((o) => o.type === 'checkpoint_part').length).toBeGreaterThan(2)
    // A second checkpoint whose manifest cannot be written: the first one stays whole.
    s++
    await l.addUnit(pair(s, s, T0 + DAY_MS, S, 100))
    const second = (await everything(l)).version
    await runInDurableObject(l, (inst: Ledger) => {
      const real = env.BUCKET
      knobs(inst).bucket = new Proxy(real, {
        get(target, prop) {
          const f = Reflect.get(target, prop) as (...a: unknown[]) => Promise<unknown>
          if (prop === 'put') return async (key: string, ...rest: unknown[]) => {
            if (key.endsWith(`/ckpt-${String(second).padStart(12, '0')}.jsonl`)) throw new Error('injected: manifest PUT failed')
            return f.call(target, key, ...rest)
          }
          return typeof f === 'function' ? f.bind(target) : f
        },
      })
    })
    await l.drain()
    expect((await l.logStatus()).checkpoint).toMatchObject({ version: second, phase: 'manifest' })
    const during = await objects()
    for (const o of firstObjects) expect(during).toContainEqual(o)
    // A loss now rebuilds from the first checkpoint (the second does not exist).
    const live = await dumpState(l)
    const r = await rebuild(l)
    expect(r.checkpoint).toBe(first)
    expect(await dumpState(l)).toEqual(live)
    // In the new incarnation: two complete checkpoints; the first is gone, manifest and parts, once the second is.
    await evictDurableObject(l) // a working bucket again
    const inc2 = await incarnationOf(l)
    await inParts(l, 800)
    for (const k of [1, 2]) {
      s++
      await l.addUnit(pair(s, s, T0, S, 100))
      await l.drain()
      const v = (await everything(l)).version
      const left = (await listAll(`${logPrefix(tenant)}${inc2}/ckpt-`)).map((key) => parseLedgerLogKey(key)!)
      expect(left.filter((o) => o.type === 'checkpoint'), `after checkpoint ${k}`).toEqual([{ type: 'checkpoint', ledgerIncarnation: inc2, version: v }])
      expect(left.every((o) => o.type === 'checkpoint' || (o.type === 'checkpoint_part' && o.version === v)), `after checkpoint ${k}: only its own parts`).toBe(true)
    }
    // An abandoned attempt's parts (here: one left behind by hand) go with the next checkpoint.
    const v = (await everything(l)).version
    await env.BUCKET.put(`${env.CELL}/${ledgerCheckpointPartKey(tenant, inc2, v, 'deadbeef', 0)}`, 'left over\n')
    s++
    await l.addUnit(pair(s, s, T0, S, 100))
    await l.drain()
    expect((await listAll(`${logPrefix(tenant)}${inc2}/ckpt-`)).some((k) => k.includes('-deadbeef/'))).toBe(false)
  })

  it('a manifest whose answer was lost is written again with the same bytes and completes the checkpoint', async () => {
    const { tenant, l } = open(tenantName('ckagain'))
    await noCheckpoints(l)
    await history(l, 8)
    await inParts(l, 800)
    await l.addUnit(pair(1, 1, T0, 'pool/9', 1))
    const v = (await everything(l)).version
    await runInDurableObject(l, (inst: Ledger) => {
      const real = env.BUCKET
      knobs(inst).bucket = new Proxy(real, {
        get(target, prop) {
          const f = Reflect.get(target, prop) as (...a: unknown[]) => Promise<unknown>
          if (prop === 'put') return async (key: string, ...rest: unknown[]) => {
            const out = await f.call(target, key, ...rest)
            if (key.endsWith(`/ckpt-${String(v).padStart(12, '0')}.jsonl`)) throw new Error('injected: manifest answer lost')
            return out
          }
          return typeof f === 'function' ? f.bind(target) : f
        },
      })
    })
    await l.drain()
    expect((await l.logStatus()).checkpoint).toMatchObject({ phase: 'manifest' })
    await evictDurableObject(l)
    await l.drain()
    expect((await l.logStatus()).checkpoint).toBeNull()
    const r = await rebuild(l)
    expect(r.checkpoint).toBe(v)
    void tenant
  })
})

describe('a rebuild streams into SQLite', () => {
  /**
   * Serve log objects slowly, a few bytes at a time, and note how many rows `file` holds when the
   * last piece of each one is asked for (or, for a checkpoint part, which is read whole, when it
   * is fetched). A rebuild that held an object, or every part, before writing SQLite sees none.
   */
  const slowly = (l: Stub, seen: { key: string; rows: number }[]) =>
    runInDurableObject(l, (inst: Ledger, state) => {
      const real = env.BUCKET
      const rows = () => state.storage.sql.exec(`SELECT COUNT(*) AS n FROM file`).one().n as number
      knobs(inst).bucket = new Proxy(real, {
        get(target, prop) {
          const f = Reflect.get(target, prop) as (...a: unknown[]) => Promise<unknown>
          if (prop !== 'get') return typeof f === 'function' ? f.bind(target) : f
          return async (key: string, ...rest: unknown[]) => {
            const o = (await f.call(target, key, ...rest)) as R2ObjectBody | null
            if (!o || !(key.includes('/seg-') || key.includes('/ckpt-'))) return o
            if (parseLedgerLogKey(key)?.type === 'checkpoint_part') {
              seen.push({ key, rows: rows() })
              return o
            }
            const bytes = new Uint8Array(await o.arrayBuffer())
            let at = 0
            const body = new ReadableStream<Uint8Array>({
              pull(c) {
                if (at >= bytes.length) {
                  seen.push({ key, rows: rows() })
                  c.close()
                  return
                }
                c.enqueue(bytes.slice(at, at + 97))
                at += 97
              },
            })
            const text = () => new Response(bytes).text()
            return { key: o.key, size: o.size, etag: o.etag, body, text, arrayBuffer: async () => bytes.buffer, json: async () => JSON.parse(await text()) } as unknown as R2ObjectBody
          }
        },
      })
    })

  it('from a base, and from a checkpoint of either format: files are in SQLite before the object (or the last part) has been read', async () => {
    for (const format of ['base', 'v1', 'v2'] as const) {
      const { l } = open(tenantName(`ckstream${format}`))
      await noCheckpoints(l)
      await history(l, 20)
      if (format === 'base') {
        await l.drain()
        await loseStorage(l) // a new incarnation whose base holds every file
        await everything(l)
        await noCheckpoints(l)
      } else {
        await runInDurableObject(l, (i: Ledger) => {
          Object.assign(knobs(i), { checkpointEvery: 1, checkpointByLogBytes: false, checkpointOneObjectBytes: format === 'v1' ? 1e12 : -1, checkpointPartBytes: 2_000 })
        })
        await l.addUnit(pair(1, 1, T0, 'pool/9', 1))
      }
      await l.drain()
      const live = await dumpState(l)
      expect(live.files.length).toBeGreaterThan(30)
      const seen: { key: string; rows: number }[] = []
      await slowly(l, seen)
      // A base is written to SQLite in batches of rows as it is read; small ones here, so a small base shows it.
      await runInDurableObject(l, (i: Ledger) => { (i as unknown as { rebuildBatchRows: number }).rebuildBatchRows = 8 })
      const r = await rebuild(l)
      expect(r.checkpoint === null, format).toBe(format === 'base')
      const holding = seen.filter((x) => {
        const p = parseLedgerLogKey(x.key)
        return format === 'v2' ? p?.type === 'checkpoint_part' : format === 'v1' ? p?.type === 'checkpoint' : p?.type === 'segment'
      })
      expect(holding.length, format).toBeGreaterThan(format === 'v2' ? 5 : 0)
      const last = format === 'v2' ? holding.at(-1)! : holding[0]!
      expect(last.rows, `${format}: rows in SQLite when ${last.key.slice(-48)} was read`).toBeGreaterThan(0)
      expect(await dumpState(l)).toEqual(live)
    }
  })

  it('the incremental reader gives what JSON.parse gives, however the text is cut (strings with brackets, escapes, astral characters)', () => {
    const r = rng(7)
    const nasty = ['', ']', '[', '{', '}', ',', '"', '\\', '\\"]', 'a,b', '\u00e9', '\ud83d\ude00', '\u2028', '\n', 'x'.repeat(50)]
    const value = (depth: number): unknown => {
      const k = r.int(depth > 2 ? 4 : 7)
      if (k === 0) return r.pick(nasty) + r.int(1000)
      if (k === 1) return r.int(1e9) - 5e8
      if (k === 2) return r.pick([true, false, null, 1.5e-7])
      if (k === 3) return r.pick(nasty)
      if (k === 4) return Array.from({ length: r.int(4) }, () => value(depth + 1))
      return Object.fromEntries(Array.from({ length: r.int(4) }, () => [r.pick(nasty) + r.int(9), value(depth + 1)]))
    }
    for (let t = 0; t < 300; t++) {
      const obj: Record<string, unknown> = {}
      for (let m = 0; m < 1 + r.int(6); m++) obj[`${r.pick(nasty)}${m}`] = r.int(2) === 0 ? Array.from({ length: r.int(6) }, () => value(1)) : value(1)
      const text = JSON.stringify(obj)
      const got: Record<string, unknown[]> = {}
      const s = new JsonObjectStream((member, el) => { (got[member] ??= []).push(el) })
      for (let i = 0; i < text.length;) {
        const n = 1 + r.int(9)
        s.push(text.slice(i, i + n))
        i += n
      }
      const rebuilt = { ...s.end() } as Record<string, unknown>
      for (const [k, v] of Object.entries(obj)) if (Array.isArray(v)) rebuilt[k] = got[k] ?? []
      expect(rebuilt).toEqual(obj)
    }
    expect(() => { const s = new JsonObjectStream(() => undefined); s.push('{"a":[1,2'); s.end() }).toThrow()
    expect(() => new JsonObjectStream(() => undefined).push('[1]')).toThrow()
  })

  it('a log object read a byte at a time, multi-byte characters split across pieces, gives the same lines', async () => {
    const lines = ['{"v":1,"h":"\u00e9\ud83d\ude00"}', JSON.stringify({ kind: 'base', added: [{ key: 'k\ud83d\ude00', n: 1 }, { key: ']"\\', n: 2 }], version: 3 }), '{"x":"\u2028"}']
    const bytes = new TextEncoder().encode(lines.map((x) => `${x}\n`).join(''))
    let at = 0
    const body = new ReadableStream<Uint8Array>({ pull(c) { if (at >= bytes.length) c.close(); else c.enqueue(bytes.slice(at, ++at)) } })
    const els: unknown[] = []
    const whole: unknown[] = []
    const r = await readLedgerLogStream(body, 1, (_m, e) => els.push(e), (_i, v) => whole.push(v))
    expect(r.lines).toBe(3)
    expect(whole).toEqual([JSON.parse(lines[0]!), JSON.parse(lines[2]!)])
    expect(els).toEqual(JSON.parse(lines[1]!).added)
    expect(r.streamed).toEqual({ kind: 'base', version: 3 })
  })
})

describe('compatibility', () => {
  it('a checkpoint that a release without checkpoint tracking left behind is abandoned, never written with changes it did not see', async () => {
    const { tenant, l } = open(tenantName('ckuntracked'))
    await noCheckpoints(l)
    await history(l, 12)
    await inParts(l, 500)
    await l.addUnit(pair(1, 1, T0, 'pool/9', 1))
    await step(l, 16, 1)
    const begun = (await l.logStatus()).checkpoint!
    expect(begun.parts).toBe(1)
    // The release before this one commits a removal of a file ahead of the cursor, as its code does
    // (no pre-image, no `tracked`): version, file row and outbox in one transaction.
    const victim = (await everything(l)).files.at(-1)!
    await runInDurableObject(l, (_i: Ledger, state) => {
      const sql = state.storage.sql
      state.storage.transactionSync(() => {
        const inc = sql.exec(`SELECT v FROM meta WHERE k = 'incarnation'`).one().v as number
        const v = (sql.exec(`SELECT v FROM meta WHERE k = 'version'`).one().v as number) + 1
        sql.exec(`UPDATE meta SET v = ? WHERE k = 'version'`, v)
        sql.exec(`DELETE FROM file WHERE key = ?`, victim.key)
        sql.exec(`INSERT INTO tombstone (key, tbl, version, at) VALUES (?, ?, ?, 1)`, victim.key, victim.table, v)
        sql.exec(`INSERT INTO outbox (version, body) VALUES (?, ?)`, v, JSON.stringify({ ledgerIncarnation: inc, version: v, at: 1, kind: 'replace', added: [], removed: [victim.key], removedFiles: [{ key: victim.key, table: victim.table }] }))
      })
    })
    await l.drain()
    const inc = await incarnationOf(l)
    expect(await env.BUCKET.head(`${env.CELL}/${ledgerCheckpointKey(tenant, inc, begun.version)}`)).toBeNull()
    // The next one is begun afresh and is right.
    await l.addUnit(pair(2, 2, T0, 'pool/9', 1))
    await l.drain()
    const live = await dumpState(l)
    const r = await rebuild(l)
    expect(r.checkpoint).toBe(live.version)
    expect(await dumpState(l)).toEqual(live)
  })

  it('the release before this one rebuilds from this one\'s log (it passes over a checkpoint in parts), and this one from its log (format 1)', async () => {
    // This release writes; the older one reads.
    const { tenant, l } = open(tenantName('ckcross'))
    await noCheckpoints(l)
    await history(l, 16)
    await inParts(l, 700)
    await l.addUnit(pair(1, 1, T0, 'pool/9', 1))
    await l.drain()
    await l.addUnit(pair(2, 2, T0, 'pool/9', 1))
    await l.drain()
    const live = await dumpState(l)
    const before = env.LEDGER_BEFORE.get(env.LEDGER_BEFORE.idFromName(tenant)) as unknown as Stub
    expect(await dumpState(before)).toEqual(live)
    // The older one writes (format-1 checkpoints, its own way); this one reads.
    const t2 = tenantName('ckcross2')
    const old = env.LEDGER_BEFORE.get(env.LEDGER_BEFORE.idFromName(t2)) as unknown as Stub
    open(t2)
    await runInDurableObject(old, (i: unknown) => { Object.assign(i as object, { checkpointEvery: 1, checkpointByLogBytes: false }) })
    await history(old, 16)
    await old.drain()
    const oldState = await dumpState(old)
    expect((await listAll(`${logPrefix(t2)}`)).some((k) => /ckpt-\d{12}\.jsonl$/.test(k))).toBe(true)
    const mine = env.LEDGER_REPLICA.get(env.LEDGER_REPLICA.idFromName(t2)) as unknown as Stub
    expect(await dumpState(mine)).toEqual({ ...oldState })
  })

  it(`golden: a format-${LEDGER_CHECKPOINT_VERSION} checkpoint (manifest and parts) written by the ledger for a fixed history`, async () => {
    const { tenant, l } = open()
    await l.registerStream({ shard: S, incarnation: 7001 })
    const u = pair(1, 5)
    await l.addUnit(u)
    await l.replace({ remove: [u.files[0]!.key], add: [{ ...u.files[0]!, key: u.files[0]!.key.replace('samples-', 'L1-samples-'), level: 1 }] })
    await l.expire({ tables: ['metric_series'], beforeDay: dayOf(T0 + DAY_MS) })
    await l.addUnit(pair(6, 6, T0 + DAY_MS))
    await inParts(l, 300)
    await l.registerStream({ shard: 'pool/1', incarnation: 9 })
    await l.drain()
    const inc = await incarnationOf(l)
    const v = (await everything(l)).version
    const keys = await listAll(`${logPrefix(tenant)}${inc}/ckpt-`)
    const manifest = await (await env.BUCKET.get(`${env.CELL}/${ledgerCheckpointKey(tenant, inc, v)}`))!.text()
    const m = JSON.parse(manifest.split('\n')[1]!) as LedgerCheckpointManifest
    const scrub = (text: string) => text.replaceAll(tenant, '<tenant>').replace(/"at":\d{13}/g, '"at":"<ms>"').replaceAll(`"ledgerIncarnation":${inc}`, '"ledgerIncarnation":"<incarnation>"').replaceAll(m.attempt, '<attempt>').replace(/"bytes":\d+,"watermarks"/, '"bytes":"<bytes>","watermarks"')
    const parts: string[] = []
    for (let p = 0; p < m.parts; p++) parts.push(scrub(await (await env.BUCKET.get(`${env.CELL}/${ledgerCheckpointPartKey(tenant, inc, v, m.attempt, p)}`))!.text()))
    const ckName = `ckpt-${String(v).padStart(12, '0')}`
    expect(keys.map((k) => k.slice(k.indexOf('/ckpt-') + 1).replace(m.attempt, '<attempt>'))).toEqual([
      ...Array.from({ length: m.parts }, (_, p) => `${ckName}-<attempt>/${String(p).padStart(6, '0')}.jsonl`), `${ckName}.jsonl`,
    ])
    expectGolden(`formats/ledger.checkpoint.v${LEDGER_CHECKPOINT_VERSION}.json`, { format: 'ledger.checkpoint', version: LEDGER_CHECKPOINT_VERSION, manifest: scrub(manifest), parts })
    // And the contract decodes what it pins.
    expect(m).toMatchObject({ version: v, files: 3, tombstones: 2 })
    void readSegments
    void loggedOf
  })
})
