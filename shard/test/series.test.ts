import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { Shard } from '../src/shard'
import { HLL_REGISTERS, SeriesWindow, bloomBitsFor, hashId, hllEstimate } from '../src/sketch'

let n = 0
const shard = () => env.SHARD.get(env.SHARD.idFromName(`series-${Date.now().toString(36)}/${n++}`))

/** A payload whose header says `nSeries` (offset 12); the shard checks nothing else. */
function payload(nSeries: number, salt: number): Uint8Array {
  const p = new Uint8Array(24)
  const v = new DataView(p.buffer)
  v.setUint32(12, nSeries, true)
  v.setUint32(16, salt, true)
  return p
}
let salt = 0
const send = (s: DurableObjectStub<Shard>, tenant: string, ids: bigint[], limit?: number) => {
  const k = salt++
  return s.append({ tenant, epoch: 1, fingerprint: `fp-${k}`, payload: payload(ids.length, k), rows: ids.length, seriesIds: BigInt64Array.from(ids), seriesLimit: limit })
}
const range = (lo: number, hi: number, f: (i: number) => bigint = (i) => BigInt(i)) => Array.from({ length: hi - lo }, (_, i) => f(lo + i))

/** splitmix64, as a stand-in for well-distributed series ids. */
function mix(i: number): bigint {
  let z = BigInt.asUintN(64, BigInt(i) * 0x9e3779b97f4a7c15n)
  z = BigInt.asUintN(64, (z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n)
  z = BigInt.asUintN(64, (z ^ (z >> 27n)) * 0x94d049bb133111ebn)
  return BigInt.asIntN(64, z ^ (z >> 31n))
}

describe('the sketch', () => {
  it('estimates within 5% for random, sequential and prefix-clustered ids, from 5,000 to 1,000,000', () => {
    const kinds: [string, (i: number) => bigint][] = [
      ['random', mix],
      ['sequential', (i) => BigInt(i)],
      // 24 high bits shared by runs of ids, as a locality-prefixed id would have.
      ['clustered', (i) => BigInt.asIntN(64, (BigInt(i % 37) << 40n) | BigInt.asUintN(40, mix(i)))],
    ]
    for (const [kind, f] of kinds) {
      const reg = new Uint8Array(HLL_REGISTERS)
      let next = 5_000
      for (let i = 1; i <= 1_000_000; i++) {
        const id = f(i)
        const [h1, h2] = hashId(Number(BigInt.asUintN(32, id)), Number(BigInt.asUintN(32, id >> 32n)))
        const j = h1 >>> 20
        const rank = Math.clz32(h2) + 1
        if (rank > reg[j]!) reg[j] = rank
        if (i === next) {
          const err = Math.abs(hllEstimate(reg) - i) / i
          expect(err, `${kind} at ${i}`).toBeLessThan(0.05)
          next = next < 100_000 ? next * 2 : next + 300_000
        }
      }
    }
  })

  it('counts exactly while small, across the two buckets, and forgets after a whole window', () => {
    const w = new SeriesWindow(1000, 100, 0)
    w.add(BigInt64Array.from(range(0, 50)), 0)
    w.add(BigInt64Array.from(range(25, 60)), 0)
    expect([w.count(), w.exact]).toEqual([60, true])
    expect(w.check(BigInt64Array.from(range(55, 65))).fresh).toEqual(range(60, 65))
    // Next bucket: the old ids are still active; ids seen again are not counted twice.
    w.rotate(500)
    expect(w.count()).toBe(60)
    w.add(BigInt64Array.from(range(40, 70)), 0)
    expect(w.count()).toBe(70)
    // One more rotation: only what was seen in the previous bucket remains.
    w.rotate(1000)
    expect(w.count()).toBe(30)
    expect(w.check(BigInt64Array.from([0n, 45n])).fresh).toEqual([0n])
    // And after a whole window with nothing, nothing.
    w.rotate(5000)
    expect(w.count()).toBe(0)
  })

  it('switches to the sketch above the threshold: the count stays within 5% and known ids stay known', () => {
    const w = new SeriesWindow(1000, 256, 0)
    const ids = range(0, 20_000, mix)
    for (let i = 0; i < ids.length; i += 500) w.add(BigInt64Array.from(ids.slice(i, i + 500)), 20_000)
    expect(w.exact).toBe(false)
    expect(Math.abs(w.count() - 20_000) / 20_000).toBeLessThan(0.05)
    // No false negatives: every id that was added is known.
    expect(w.check(BigInt64Array.from(ids)).fresh).toEqual([])
    // New ids are recognised as new, but for the Bloom filter's false positives (about 1%).
    const unseen = range(20_000, 40_000, mix)
    const fresh = w.check(BigInt64Array.from(unseen)).fresh.length
    expect(fresh).toBeGreaterThan(0.97 * unseen.length)
    // The same holds after a save and a load, and across a rotation into the previous bucket.
    const again = SeriesWindow.load(1000, 256, 0, w.save())
    expect(again.count()).toBe(w.count())
    expect(again.check(BigInt64Array.from(ids)).fresh).toEqual([])
    again.rotate(500)
    expect(again.check(BigInt64Array.from(ids)).fresh).toEqual([])
    expect(Math.abs(again.count() - 20_000) / 20_000).toBeLessThan(0.05)
  })

  it('sizes the Bloom filter at about 10 bits per expected id, within 16 KB to 1 MB', () => {
    expect(bloomBitsFor(0)).toBe(1 << 17)
    expect(bloomBitsFor(100_000)).toBe(1 << 20)
    expect(bloomBitsFor(500_000)).toBe(1 << 23)
    expect(bloomBitsFor(50_000_000)).toBe(1 << 23)
  })
})

describe('the active-series limit', () => {
  it('counts distinct series per tenant and refuses only the new ones that do not fit', async () => {
    const s = shard()
    expect(await send(s, 'a', range(0, 8), 10)).toMatchObject({ status: 'ok' })
    expect(await s.seriesCount('a')).toMatchObject({ count: 8, exact: true })
    // 5 existing + 5 new, room for 2: the last 3 new ids are refused, by id.
    const r = await send(s, 'a', range(3, 13), 10)
    expect(r.status).toBe('series_limit')
    if (r.status !== 'series_limit') return
    expect([r.limit, r.current]).toEqual([10, 8])
    expect([...r.refused]).toEqual([10n, 11n, 12n])
    // Nothing of the refused batch was stored or counted.
    expect((await s.describe('a'))!.nextSeq).toBe(2)
    expect((await s.seriesCount('a')).count).toBe(8)
    // The same batch without the refused series is accepted.
    expect(await send(s, 'a', range(3, 10), 10)).toMatchObject({ status: 'ok' })
    expect((await s.seriesCount('a')).count).toBe(10)
    // At the limit: existing series keep being accepted, any new one is refused.
    expect(await send(s, 'a', range(0, 10), 10)).toMatchObject({ status: 'ok' })
    const full = await send(s, 'a', [0n, 99n], 10)
    expect(full.status === 'series_limit' && [...full.refused]).toEqual([99n])
    // Another tenant in the same shard has its own count.
    expect(await send(s, 'b', range(0, 10), 10)).toMatchObject({ status: 'ok' })
    expect((await s.seriesCount('b')).count).toBe(10)
    expect((await s.seriesCount('nobody')).count).toBe(0)
  })

  it('does not meter a batch sent without ids, and refuses ids that disagree with the batch header', async () => {
    const s = shard()
    const r = await s.append({ tenant: 'a', epoch: 1, fingerprint: 'plain', payload: payload(3, 1), rows: 3 })
    expect(r.status).toBe('ok')
    expect((await s.seriesCount('a')).count).toBe(0)
    const bad = await s.append({ tenant: 'a', epoch: 1, fingerprint: 'bad', payload: payload(3, 2), rows: 3, seriesIds: BigInt64Array.of(1n, 2n) })
    expect(bad).toEqual({ status: 'invalid', reason: '2 series ids for a batch whose header says 3' })
    expect((await s.describe('a'))!.nextSeq).toBe(2)
    expect((await s.seriesCount('a')).count).toBe(0)
  })

  it('a retried batch (same fingerprint) is acknowledged without being counted or refused', async () => {
    const s = shard()
    const p = payload(4, 77)
    const req = { tenant: 'a', epoch: 1, fingerprint: 'same', payload: p, rows: 4, seriesIds: BigInt64Array.from(range(0, 4)), seriesLimit: 4 }
    expect(await s.append(req)).toMatchObject({ status: 'ok', duplicate: false })
    expect(await s.append(req)).toMatchObject({ status: 'ok', duplicate: true })
    expect((await s.seriesCount('a')).count).toBe(4)
  })

  it('saves the window from the alarm, not per append, and rebuilds it after an eviction', async () => {
    const s = shard()
    await s.configure({ seriesPersistMs: 60_000, sealAgeMs: 3_600_000 })
    const rows = () => runInDurableObject(s, (_i, state) => state.storage.sql.exec(`SELECT COUNT(*) AS n FROM series_window WHERE tenant = 'a'`).one().n as number)
    await send(s, 'a', range(0, 100), 1000)
    await send(s, 'a', range(50, 150), 1000)
    expect(await rows()).toBe(0) // nothing written per append
    await s.configure({ seriesPersistMs: 0 })
    await runDurableObjectAlarm(s)
    expect(await rows()).toBe(2) // two buckets, whole, however many ids
    await s.configure({ seriesPersistMs: 60_000 })
    await send(s, 'a', range(150, 160), 1000) // not saved yet
    await evictDurableObject(s)
    // Rebuilt from storage: the saved 150, without the 10 that were only in memory.
    expect(await s.seriesCount('a')).toMatchObject({ count: 150, exact: true })
    const r = await send(s, 'a', range(0, 150), 150)
    expect(r.status).toBe('ok')
    const over = await send(s, 'a', [1000n], 150)
    expect(over.status).toBe('series_limit')
  })

  it('above the exact threshold: existing series are always accepted at the limit, new ones are refused', async () => {
    const s = shard()
    await s.configure({ seriesExactMax: 128 })
    const ids = range(0, 5_000, mix)
    for (let i = 0; i < ids.length; i += 1000) expect(await send(s, 'a', ids.slice(i, i + 1000), 1_000_000)).toMatchObject({ status: 'ok' })
    const c = await s.seriesCount('a')
    expect(c.exact).toBe(false)
    expect(Math.abs(c.count - 5_000) / 5_000).toBeLessThan(0.05)
    // The limit is now below the count: every existing series is still accepted...
    for (let i = 0; i < ids.length; i += 1000) expect(await send(s, 'a', ids.slice(i, i + 1000), 4_000)).toMatchObject({ status: 'ok' })
    // ...and new series are refused, but for the filter's false positives.
    const unseen = range(5_000, 6_000, mix)
    const r = await send(s, 'a', [...ids.slice(0, 10), ...unseen], 4_000)
    expect(r.status).toBe('series_limit')
    if (r.status !== 'series_limit') return
    expect(r.refused.length).toBeGreaterThan(970)
    for (const id of r.refused) expect(unseen).toContain(id)
    expect(r.limit).toBe(4_000)
    expect(Math.abs(r.current - 5_000) / 5_000).toBeLessThan(0.05)
  })
})
