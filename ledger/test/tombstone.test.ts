import { evictDurableObject, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { FlushUnit } from '../../contracts/ledger'
import type { Ledger } from '../src/ledger'
import { DAY_MS, INC, S, T0, breakR2, dayOf, failure, file, k, nm, open as openLedger, tenantName, type Stub } from './helpers'

const open = (): Stub => openLedger(tenantName('tomb')).l
const pair = (seqLo: number, seqHi: number, ts = T0): FlushUnit => ({
  shard: S, incarnation: INC, seqLo, seqHi,
  files: [file(`samples-${seqLo}`, { minTs: ts }), file(`series-${seqLo}`, { minTs: ts, table: 'metric_series' })],
})
const breakLog = (l: Stub) =>
  runInDurableObject(l, (inst: Ledger) => {
    ;(inst as unknown as { bucket: R2Bucket }).bucket = new Proxy(env.BUCKET, {
      get: (t, p) => (p === 'put' ? async () => { throw new Error('injected R2 failure') } : Reflect.get(t, p).bind(t)),
    })
  })
const heal = (l: Stub) => runInDurableObject(l, (inst: Ledger) => { (inst as unknown as { bucket: R2Bucket }).bucket = env.BUCKET })
const keysOf = (ts: { key: string }[]) => ts.map((t) => nm(t.key))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('tombstones', () => {
  it('replace and expire record what they removed, with the version and table, in the same change', async () => {
    const l = open()
    await l.addUnit(pair(1, 1))
    await l.addUnit(pair(2, 2))
    await l.addUnit(pair(3, 3, T0 + 5 * DAY_MS))
    expect(await l.removedSince(0)).toEqual([])
    const r = await l.replace({ remove: [k('samples-1'), k('samples-2'), k('series-1'), k('series-2')], add: [file('L1-samples', { level: 1 }), file('L1-series', { level: 1, table: 'metric_series' })] })
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    const removed = await l.removedSince(0)
    expect(removed.map((t) => [nm(t.key), t.table, t.version])).toEqual([
      ['samples-1', 'metric_samples', r.version], ['samples-2', 'metric_samples', r.version],
      ['series-1', 'metric_series', r.version], ['series-2', 'metric_series', r.version],
    ])
    for (const t of removed) expect(Math.abs(t.at - Date.now())).toBeLessThan(5000)
    // A refused replace buries nothing.
    expect((await l.replace({ remove: [k('samples-1')], add: [file('x')] })).status).toBe('conflict')
    expect(await l.removedSince(0)).toHaveLength(4)

    const e = await l.expire({ table: 'metric_samples', beforeDay: dayOf(T0 + DAY_MS) })
    expect(e.removed).toEqual([k('L1-samples')])
    expect((await l.removedSince(r.version)).map((t) => [nm(t.key), t.table, t.version])).toEqual([['L1-samples', 'metric_samples', e.version]])
    // An expire that removes nothing buries nothing and makes no version.
    await l.expire({ table: 'metric_samples', beforeDay: dayOf(T0 + DAY_MS) })
    expect(await l.removedSince(e.version)).toEqual([])
  })

  it('deletable: only after the grace, by the ledger\'s clock', async () => {
    const l = open()
    await l.addUnit(pair(1, 1))
    await l.replace({ remove: [k('samples-1'), k('series-1')], add: [file('out', { level: 1 })] })
    await l.drain()
    expect(await l.deletable({ minAgeMs: 60_000 })).toEqual({ tombstones: [], waiting: 2 })
    await sleep(60)
    expect(keysOf((await l.deletable({ minAgeMs: 50 })).tombstones)).toEqual(['samples-1', 'series-1'])
    expect(await l.deletable({ minAgeMs: 60_000 })).toEqual({ tombstones: [], waiting: 2 })
    expect(keysOf((await l.deletable({ minAgeMs: 0, limit: 1 })).tombstones)).toEqual(['samples-1'])
  })

  it('deletable: never while the removal is committed but not logged; a rebuild then still has the file', async () => {
    const l = open()
    await l.addUnit(pair(1, 1))
    await l.addUnit(pair(2, 2))
    await l.drain()
    await breakLog(l)
    const r = await l.replace({ remove: [k('samples-1'), k('series-1')], add: [file('out', { level: 1 })] })
    expect(r.status).toBe('ok')
    expect(await l.outboxDepth()).toBe(1)
    // Committed, visible in plans, old enough for any grace: still not deletable.
    expect(await l.deletable({ minAgeMs: 0 })).toEqual({ tombstones: [], waiting: 2 })
    // A second removal behind it in the outbox is not deletable either.
    await l.expire({ table: 'metric_series', beforeDay: '9999-01-01' })
    expect(await l.deletable({ minAgeMs: 0 })).toEqual({ tombstones: [], waiting: 3 })

    // Storage is lost before the log catches up: the rebuilt ledger lists the removed files again.
    await runInDurableObject(l, async (_i, state) => { await state.storage.deleteAll() })
    await evictDurableObject(l)
    const live = (await l.plan({ table: 'metric_samples', minTs: 0, maxTs: Number.MAX_SAFE_INTEGER })).files.map((f) => nm(f.key))
    expect(live).toEqual(['samples-1', 'samples-2'])
    expect(await l.removedSince(0)).toEqual([])
  })

  it('deletable: never while the removal\'s segment is recorded but its write failed or its answer was lost (review S-9)', async () => {
    for (const mode of ['before', 'after'] as const) {
      const l = open()
      await l.addUnit(pair(1, 1))
      await l.addUnit(pair(2, 2))
      await l.drain()
      const r = await l.replace({ remove: [k('samples-1'), k('series-1')], add: [file('out', { level: 1 })] })
      expect(r.status).toBe('ok')
      // The drain records the segment's bounds, then its PUT fails (or lands, its answer lost).
      await breakR2(l, () => true, mode)
      expect(await failure(l, (i) => i.drain())).toMatch(/injected/)
      expect((await l.logStatus()).inFlight).not.toBeNull()
      expect(await l.deletable({ minAgeMs: 0 }), mode).toEqual({ tombstones: [], waiting: 2 })
      // Still not after an eviction (the record is in SQLite); deletable once a drain completes.
      await evictDurableObject(l)
      expect(await l.deletable({ minAgeMs: 0 }), mode).toEqual({ tombstones: [], waiting: 2 })
      await l.drain()
      expect(keysOf((await l.deletable({ minAgeMs: 0 })).tombstones).sort(), mode).toEqual(['samples-1', 'series-1'])
    }
  })

  it('deletable once logged; forget drops only what is not live; both survive eviction', async () => {
    const l = open()
    await l.addUnit(pair(1, 1))
    await breakLog(l)
    await l.replace({ remove: [k('samples-1'), k('series-1')], add: [file('out', { level: 1 })] })
    expect((await l.deletable({ minAgeMs: 0 })).tombstones).toEqual([])
    await heal(l)
    await l.drain()
    expect(keysOf((await l.deletable({ minAgeMs: 0 })).tombstones)).toEqual(['samples-1', 'series-1'])
    await evictDurableObject(l)
    expect(keysOf((await l.deletable({ minAgeMs: 0 })).tombstones)).toEqual(['samples-1', 'series-1'])
    expect(await l.forget([k('samples-1'), k('out'), `${k('out')}-never-heard-of`])).toEqual({ forgotten: 1 })
    expect(keysOf(await l.removedSince(0))).toEqual(['series-1'])
    expect(await l.forget([k('series-1')])).toEqual({ forgotten: 1 })
    expect(await l.deletable({ minAgeMs: 0 })).toEqual({ tombstones: [], waiting: 0 })
  })

  it('a key that is live again is never deletable and cannot be forgotten', async () => {
    const l = open()
    await l.addUnit(pair(1, 1))
    await l.replace({ remove: [k('samples-1'), k('series-1')], add: [file('out', { level: 1 })] })
    // A caller bug brings the removed key back (keys are unique only among live files).
    expect((await l.replace({ remove: [k('out')], add: [file('samples-1', { level: 1 })] })).status).toBe('ok')
    await l.drain()
    expect(keysOf((await l.deletable({ minAgeMs: 0 })).tombstones)).toEqual(['series-1', 'out'])
    expect(await l.forget([k('samples-1')])).toEqual({ forgotten: 0 })
  })

  it('a ledger rebuilt from its log has the tombstones of every logged removal', async () => {
    const l = open()
    await l.addUnit(pair(1, 1))
    await l.addUnit(pair(2, 2, T0 + 3 * DAY_MS))
    const r = await l.replace({ remove: [k('samples-1'), k('series-1')], add: [file('out', { level: 1 }), file('out-series', { level: 1, table: 'metric_series' })] })
    const e = await l.expire({ table: 'metric_samples', beforeDay: dayOf(T0 + DAY_MS) })
    const before = await l.removedSince(0)
    expect(keysOf(before)).toEqual(['samples-1', 'series-1', 'out'])
    await l.drain()
    await runInDurableObject(l, async (_i, state) => { await state.storage.deleteAll() })
    await evictDurableObject(l)
    expect(await l.removedSince(0)).toEqual(before)
    expect(r.status === 'ok' && before[0]!.version === r.version && before[2]!.version === e.version).toBe(true)
    expect(keysOf((await l.deletable({ minAgeMs: 0 })).tombstones)).toEqual(['samples-1', 'series-1', 'out'])
  })

  it('orphanCheck answers live, tombstoned and logged watermarks in one read', async () => {
    const l = open()
    await l.addUnit(pair(1, 1))
    await l.addUnit(pair(2, 4))
    await l.replace({ remove: [k('samples-1')], add: [file('out', { level: 1 })] })
    await l.drain()
    await breakLog(l)
    await l.addUnit(pair(5, 9))
    const c = await l.orphanCheck([k('samples-1'), k('samples-2'), k('out'), `${k('out')}-stranger`, k('series-5')])
    expect(c.live.map(nm).sort()).toEqual(['out', 'samples-2', 'series-5'])
    expect(c.tombstoned.map(nm)).toEqual(['samples-1'])
    // Committed through 9, logged through 4.
    expect(c.logged).toEqual([{ shard: S, incarnation: INC, seq: 4 }])
  })
})
