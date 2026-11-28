/**
 * D82: recorded payloads kept for in-flight queries (`retainRecordedMs`) never cost an append its
 * room. S10 measured a tenant refused for about 33 s while its 64 MiB cap was held by segments the
 * ledger had already logged: the 30 s retention. Now an append or a reserve that would be refused
 * for room first gives up recorded payloads (the tenant's own for its cap, every tenant's for the
 * shard's), then is judged again; unrecorded rows still count in full.
 */
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { Shard } from '../src/shard'

let n = 0
const fresh = () => env.SHARD.get(env.SHARD.idFromName(`rcl-${Date.now().toString(36)}/${n++}`))
const payload = (size: number, tag: number) => {
  const p = new Uint8Array(size)
  new DataView(p.buffer).setUint32(0, tag, true)
  return p
}
let fp = 0
const append = (s: DurableObjectStub<Shard>, tenant: string, size: number) => s.append({ tenant, epoch: 1, fingerprint: `f${fp++}`, payload: payload(size, fp), rows: 1 })
const held = (s: DurableObjectStub<Shard>, tenant: string) =>
  runInDurableObject(s, (_i, state) => state.storage.sql.exec(`SELECT COALESCE(SUM(bytes), 0) AS b FROM batch WHERE tenant = ? AND payload IS NOT NULL`, tenant).one().b as number)

/** `count` batches of `size` sealed as one segment and recorded, as a flush whose unit was logged would. */
async function recordedSegment(s: DurableObjectStub<Shard>, tenant: string, count: number, size: number) {
  for (let i = 0; i < count; i++) expect(await append(s, tenant, size)).toMatchObject({ status: 'ok' })
  const seg = (await s.seal(tenant))!
  expect(await s.recorded(tenant, seg.incarnation, seg.seqHi)).toMatchObject({ status: 'ok' })
  return seg
}

describe('reclaim of recorded payloads (D82)', () => {
  it('a tenant whose cap is held by recorded payloads is admitted, and a reader of them re-plans', async () => {
    const s = fresh()
    await s.configure({ tenantMaxBytes: 1000, retainRecordedMs: 3_600_000 })
    const seg = await recordedSegment(s, 'a', 3, 300)
    expect(await s.describe('a')).toMatchObject({ bufferedBytes: 900, retainedBytes: 900, recordedThrough: 3, discardedThrough: 0 })
    // 900 retained + 300 > 1000: before D82 this was `backpressure` (scope tenant) for an hour.
    expect(await append(s, 'a', 300)).toMatchObject({ status: 'ok' })
    expect(await s.describe('a')).toMatchObject({ bufferedBytes: 300, retainedBytes: 0, discardedThrough: 3 })
    expect(await held(s, 'a')).toBe(300)
    expect(await s.stats()).toMatchObject({ reclaimedBytes: 900 })
    // A reader that planned before the record still holds watermark 0: refused, never handed a gap.
    expect(await s.tailRead('a', seg.incarnation, 0)).toEqual({ status: 'stale_watermark', incarnation: seg.incarnation, discardedThrough: 3 })
    // One that re-planned (the ledger is at 3) reads the rest.
    expect(await s.tailRead('a', seg.incarnation, 3)).toMatchObject({ status: 'ok', batches: [{ seq: 4 }] })
  })

  it('unrecorded rows still count in full: sealed but not recorded, or recorded only up to part of them', async () => {
    const s = fresh()
    await s.configure({ tenantMaxBytes: 1000, retainRecordedMs: 3_600_000 })
    for (let i = 0; i < 3; i++) expect(await append(s, 'a', 300)).toMatchObject({ status: 'ok' })
    await s.seal('a')
    // Sealed, pending flush: nothing may be given up.
    expect(await append(s, 'a', 300)).toMatchObject({ status: 'backpressure', scope: 'tenant' })
    expect(await held(s, 'a')).toBe(900)
    // Recorded, but what is still needed exceeds the cap after giving it up: refused, and what was
    // given up stays given up (it was only kept for queries).
    const t = fresh()
    await t.configure({ tenantMaxBytes: 1000, retainRecordedMs: 3_600_000 })
    await recordedSegment(t, 'a', 1, 200)
    for (let i = 0; i < 3; i++) expect(await append(t, 'a', 250)).toMatchObject({ status: 'ok' })
    // 750 unrecorded + 200 retained + 300 > 1000; without the retained: 1050 > 1000.
    expect(await append(t, 'a', 300)).toMatchObject({ status: 'backpressure', scope: 'tenant' })
    expect(await t.describe('a')).toMatchObject({ bufferedBytes: 750, retainedBytes: 0 })
    // A smaller batch now fits in what the reclaim freed.
    expect(await append(t, 'a', 200)).toMatchObject({ status: 'ok' })
  })

  it('never gives up another tenant\'s payloads for a tenant\'s own cap', async () => {
    const s = fresh()
    await s.configure({ tenantMaxBytes: 1000, retainRecordedMs: 3_600_000 })
    await recordedSegment(s, 'b', 2, 300)
    for (let i = 0; i < 3; i++) expect(await append(s, 'a', 300)).toMatchObject({ status: 'ok' })
    expect(await append(s, 'a', 300)).toMatchObject({ status: 'backpressure', scope: 'tenant' })
    expect(await s.describe('b')).toMatchObject({ retainedBytes: 600, discardedThrough: 0 })
  })

  it('for the shard\'s budget, gives up any tenant\'s recorded payloads before refusing', async () => {
    const s = fresh()
    await s.configure({ shardMaxBytes: 1000, tenantMaxBytes: 10_000, retainRecordedMs: 3_600_000 })
    await recordedSegment(s, 'b', 3, 300)
    // Without D82: 900 + 600 > 1000 and 600 is over a's fair share of two: refused (scope shard).
    expect(await append(s, 'a', 600)).toMatchObject({ status: 'ok' })
    expect(await s.describe('b')).toMatchObject({ retainedBytes: 0, discardedThrough: 3, bufferedBytes: 0 })
    // What is left is judged as before: unrecorded rows over the budget are refused.
    expect(await append(s, 'a', 300)).toMatchObject({ status: 'ok' })
    expect(await append(s, 'a', 300)).toMatchObject({ status: 'backpressure', scope: 'shard' })
  })

  it('a reserve is judged the same way (D77 grants), and the room it frees is real', async () => {
    const s = fresh()
    await s.configure({ tenantMaxBytes: 1000, retainRecordedMs: 3_600_000 })
    await recordedSegment(s, 'a', 3, 300)
    const r = await s.reserve({ tenant: 'a', epoch: 1, batches: [{ fingerprint: 'x1', bytes: 400 }, { fingerprint: 'x2', bytes: 400 }] })
    expect(r).toMatchObject({ status: 'ok' })
    expect(await s.describe('a')).toMatchObject({ bufferedBytes: 0, retainedBytes: 0 })
  })

  it('the retained count is rebuilt from storage after an eviction, so the reclaim still happens', async () => {
    const s = fresh()
    await s.configure({ tenantMaxBytes: 1000, retainRecordedMs: 3_600_000 })
    await recordedSegment(s, 'a', 2, 300)
    expect(await append(s, 'a', 100)).toMatchObject({ status: 'ok' }) // unrecorded, not sealed
    await evictDurableObject(s)
    expect(await s.describe('a')).toMatchObject({ bufferedBytes: 700, retainedBytes: 600 })
    expect(await append(s, 'a', 500)).toMatchObject({ status: 'ok' })
    expect(await s.describe('a')).toMatchObject({ bufferedBytes: 600, retainedBytes: 0, discardedThrough: 2 })
  })

  it('the alarm\'s discard after retention keeps the count right (nothing reclaimed twice)', async () => {
    const s = fresh()
    await s.configure({ tenantMaxBytes: 1000, retainRecordedMs: 0, sealAgeMs: 3_600_000 })
    await recordedSegment(s, 'a', 2, 300)
    expect(await runDurableObjectAlarm(s)).toBe(true)
    expect(await s.describe('a')).toMatchObject({ bufferedBytes: 0, retainedBytes: 0, discardedThrough: 2 })
    await recordedSegment(s, 'a', 1, 400)
    expect(await s.describe('a')).toMatchObject({ bufferedBytes: 400, retainedBytes: 400 })
    expect(await s.stats()).toMatchObject({ reclaimedBytes: 0 })
  })
})
