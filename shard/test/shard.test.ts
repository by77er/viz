import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { Shard } from '../src/shard'

let n = 0
const shard = () => env.SHARD.get(env.SHARD.idFromName(`pool/${n++}`))
const bytes = (size: number, fill = 1) => new Uint8Array(size).fill(fill)
const text = (s: string) => new TextEncoder().encode(s)
const str = (u: Uint8Array) => new TextDecoder().decode(u)
const put = (s: DurableObjectStub<Shard>, tenant: string, fp: string, payload: Uint8Array, epoch = 1) =>
  s.append({ tenant, epoch, fingerprint: fp, payload, rows: 1 })
const ok = async (p: ReturnType<typeof put>) => {
  const r = await p
  if (r.status !== 'ok') throw new Error(`expected ok, got ${r.status}`)
  return r
}

describe('streams are per tenant', () => {
  it('gives each tenant its own contiguous sequence, however writes interleave', async () => {
    const s = shard()
    const seqs: Record<string, number[]> = { a: [], b: [], c: [] }
    for (let i = 0; i < 30; i++) {
      const t = ['a', 'b', 'c'][(i * 7) % 3]!
      seqs[t]!.push((await ok(put(s, t, `f${i}`, bytes(10)))).seq)
    }
    for (const t of ['a', 'b', 'c']) expect(seqs[t]).toEqual(Array.from({ length: 10 }, (_, i) => i + 1))
  })

  it('never returns another tenant\'s rows from a tail read', async () => {
    const s = shard()
    for (let i = 0; i < 5; i++) {
      await ok(put(s, 'a', `f${i}`, text(`a-secret-${i}`)))
      await ok(put(s, 'b', `f${i}`, text(`b-secret-${i}`)))
    }
    const a = await ok(put(s, 'a', 'last', text('a-secret-last')))
    for (const [tenant, inc] of [['a', a.incarnation], ['b', (await s.describe('b'))!.incarnation]] as const) {
      const r = await s.tailRead(tenant, inc, 0)
      expect(r.status).toBe('ok')
      if (r.status !== 'ok') return
      expect(r.batches.length).toBeGreaterThan(0)
      for (const b of r.batches) expect(str(b.payload).startsWith(`${tenant}-secret-`)).toBe(true)
    }
    // A tenant that has never written here sees nothing, not someone else's data.
    const none = await s.tailRead('c', 1, 0)
    expect(none).toMatchObject({ status: 'ok', batches: [] })
  })

  it('treats the same fingerprint from two tenants as two batches, and a retry as one', async () => {
    const s = shard()
    const first = await ok(put(s, 'a', 'same', bytes(100)))
    const other = await ok(put(s, 'b', 'same', bytes(100)))
    const retry = await ok(put(s, 'a', 'same', bytes(100)))
    expect(other.duplicate).toBe(false)
    expect(retry).toMatchObject({ duplicate: true, seq: first.seq })
    expect((await s.describe('a'))!.bufferedBytes).toBe(100)
  })

  it('refuses a stale map epoch for that tenant only', async () => {
    const s = shard()
    await ok(put(s, 'a', 'f1', bytes(10), 5))
    expect(await put(s, 'a', 'f2', bytes(10), 4)).toEqual({ status: 'stale_epoch', epoch: 5 })
    expect((await put(s, 'b', 'f1', bytes(10), 1)).status).toBe('ok')
  })
})

describe('backpressure does not cross tenants', () => {
  it('a tenant at its own cap is refused while its neighbour keeps writing', async () => {
    const s = shard()
    await s.configure({ tenantMaxBytes: 1000, shardMaxBytes: 100_000, sealBytes: 1 << 30 })
    for (let i = 0; i < 10; i++) await ok(put(s, 'noisy', `f${i}`, bytes(100)))
    expect(await put(s, 'noisy', 'over', bytes(100))).toMatchObject({ status: 'backpressure', scope: 'tenant' })
    for (let i = 0; i < 10; i++) await ok(put(s, 'quiet', `f${i}`, bytes(100)))
  })

  it('when the whole shard is full, tenants under their fair share are still admitted', async () => {
    const s = shard()
    await s.configure({ tenantMaxBytes: 10_000, shardMaxBytes: 3000, sealBytes: 1 << 30 })
    // One tenant takes the entire shard budget.
    for (let i = 0; i < 30; i++) await ok(put(s, 'greedy', `f${i}`, bytes(100)))
    expect(await put(s, 'greedy', 'more', bytes(100))).toMatchObject({ status: 'backpressure', scope: 'shard' })
    // Newcomers are admitted up to the fair share, which shrinks as more tenants arrive:
    // 3000 / 2 = 1500 bytes for the first, 3000 / 3 = 1000 for the second.
    for (const [t, share] of [['x', 15], ['y', 10]] as const) {
      for (let i = 0; i < share; i++) await ok(put(s, t, `f${i}`, bytes(100)))
      expect(await put(s, t, 'over', bytes(100))).toMatchObject({ status: 'backpressure', scope: 'shard' })
    }
    // Total held never passes the hard ceiling of twice the budget.
    expect((await s.describe('x'))!.totalBytes).toBeLessThanOrEqual(6000)
    // The greedy tenant stays refused until it drains.
    expect((await put(s, 'greedy', 'again', bytes(100))).status).toBe('backpressure')
  })
})

describe('seal, record, discard', () => {
  it('seals on size, per stream, with a durable boundary that survives eviction', async () => {
    const s = shard()
    await s.configure({ sealBytes: 300 })
    for (let i = 0; i < 3; i++) await ok(put(s, 'a', `f${i}`, bytes(100)))
    await ok(put(s, 'b', 'f0', bytes(100)))
    const before = (await s.describe('a'))!
    expect(await s.pendingSegments('a')).toMatchObject([{ seqLo: 1, seqHi: 3, bytes: 300 }])
    expect(await s.pendingSegments('b')).toEqual([])

    await evictDurableObject(s)

    const after = (await s.describe('a'))!
    expect(after).toMatchObject({ incarnation: before.incarnation, sealedThrough: 3, nextSeq: 4, bufferedBytes: 300 })
    expect(await s.pendingSegments('a')).toMatchObject([{ seqLo: 1, seqHi: 3 }])
    expect((await ok(put(s, 'a', 'f3', bytes(10)))).seq).toBe(4)
    expect((await s.readSegment('a', 1))!.map((b) => b.seq)).toEqual([1, 2, 3])
  })

  it('accepts a recorded mark only at the next segment boundary', async () => {
    const s = shard()
    for (let i = 0; i < 2; i++) await ok(put(s, 'a', `f${i}`, bytes(10)))
    const seg1 = (await s.seal('a'))!
    for (let i = 2; i < 5; i++) await ok(put(s, 'a', `f${i}`, bytes(10)))
    const seg2 = (await s.seal('a'))!
    const inc = seg1.incarnation
    expect(await s.recorded('a', inc, 1)).toMatchObject({ status: 'not_contiguous' }) // mid-segment
    expect(await s.recorded('a', inc, 9)).toMatchObject({ status: 'not_contiguous' }) // beyond sealed
    expect(await s.recorded('a', inc + 1, seg1.seqHi)).toMatchObject({ status: 'incarnation_mismatch' })
    expect(await s.recorded('a', inc, seg1.seqHi)).toEqual({ status: 'ok', recordedThrough: 2 })
    expect(await s.recorded('a', inc, seg2.seqHi)).toEqual({ status: 'ok', recordedThrough: 5 })
    expect(await s.recorded('a', inc, seg1.seqHi)).toEqual({ status: 'ok', recordedThrough: 5 }) // replay is harmless
  })

  it('discards one tenant\'s recorded rows without touching its neighbour, and fences stale readers', async () => {
    const s = shard()
    await s.configure({ retainRecordedMs: 0, fingerprintTtlMs: 60_000 })
    for (let i = 0; i < 3; i++) {
      await ok(put(s, 'a', `f${i}`, bytes(100)))
      await ok(put(s, 'b', `f${i}`, bytes(100)))
    }
    const segA = (await s.seal('a'))!
    await s.seal('b')
    await s.recorded('a', segA.incarnation, segA.seqHi)
    await runDurableObjectAlarm(s)

    expect(await s.describe('a')).toMatchObject({ discardedThrough: 3, bufferedBytes: 0 })
    expect(await s.describe('b')).toMatchObject({ discardedThrough: 0, bufferedBytes: 300 })
    // A reader holding a watermark from before the discard is refused, not handed a gap.
    expect(await s.tailRead('a', segA.incarnation, 0)).toEqual({ status: 'stale_watermark', incarnation: segA.incarnation, discardedThrough: 3 })
    expect(await s.tailRead('a', segA.incarnation, 3)).toMatchObject({ status: 'ok', batches: [] })
    // The neighbour's tail is intact.
    const b = await s.tailRead('b', (await s.describe('b'))!.incarnation, 0)
    expect(b.status === 'ok' && b.batches.length).toBe(3)
    // Retries of discarded batches are still recognised.
    expect(await ok(put(s, 'a', 'f1', bytes(100)))).toMatchObject({ duplicate: true, seq: 2 })
    expect((await ok(put(s, 'a', 'new', bytes(100)))).seq).toBe(4)
  })

  it('seals on age from the alarm, and sets no alarm when there is nothing to do', async () => {
    const s = shard()
    await s.configure({ sealAgeMs: 0, sealBytes: 1 << 30, retainRecordedMs: 0, fingerprintTtlMs: 0 })
    expect(await runDurableObjectAlarm(s)).toBe(false) // idle shard: no alarm scheduled
    await ok(put(s, 'a', 'f0', bytes(10)))
    expect(await runDurableObjectAlarm(s)).toBe(true)
    const seg = (await s.pendingSegments('a'))[0]!
    expect(seg).toMatchObject({ seqLo: 1, seqHi: 1 })
    await s.recorded('a', seg.incarnation, 1)
    expect(await runDurableObjectAlarm(s)).toBe(true) // discards, then forgets the fingerprint
    await runDurableObjectAlarm(s)
    expect(await runInDurableObject(s, (_i, state) => state.storage.getAlarm())).toBeNull()
  })

  it('starts a new incarnation after storage loss instead of reusing sequence numbers', async () => {
    const s = shard()
    const first = await ok(put(s, 'a', 'f0', bytes(10)))
    await runInDurableObject(s, async (_i, state) => { await state.storage.deleteAll() })
    await evictDurableObject(s)
    const second = await ok(put(s, 'a', 'f0', bytes(10)))
    expect(second.seq).toBe(1)
    expect(second.incarnation).not.toBe(first.incarnation)
    expect(await s.tailRead('a', first.incarnation, 0)).toMatchObject({ status: 'incarnation_mismatch', incarnation: second.incarnation })
  })
})
