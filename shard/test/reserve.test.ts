/**
 * Room reserved before a request appends (D77; contracts/BATCH.md "What a refusal stored"): a
 * grant counts against the tenant's and the shard's limits until its batches are appended, it is
 * released or it expires; an append under its token is not refused for room or load; and the grant
 * is memory only, so an eviction drops it and changes nothing stored.
 */
import { evictDurableObject, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { Shard } from '../src/shard'

let n = 0
const fresh = () => env.SHARD.get(env.SHARD.idFromName(`rsv-${Date.now().toString(36)}/${n++}`))
const payload = (size: number, tag = 0) => {
  const p = new Uint8Array(size)
  new DataView(p.buffer).setUint32(0, tag, true)
  return p
}
const rows = (s: DurableObjectStub<Shard>, tenant: string) =>
  runInDurableObject(s, (_i, state) => state.storage.sql.exec(`SELECT COUNT(*) AS n FROM batch WHERE tenant = ?`, tenant).one().n as number)
const append = (s: DurableObjectStub<Shard>, tenant: string, fp: string, size: number, reservation?: string) =>
  s.append({ tenant, epoch: 1, fingerprint: fp, payload: payload(size), rows: 1, ...(reservation ? { reservation } : {}) })
const tokenOf = (r: Awaited<ReturnType<Shard['reserve']>>): string => {
  if (r.status !== 'ok' || r.token === null) throw new Error(`expected a grant, got ${JSON.stringify(r)}`)
  return r.token
}

describe('reserve', () => {
  it('a grant holds room against the tenant cap: another request is refused it, the granted appends are not, and stats count it until it is used', async () => {
    const s = fresh()
    await s.configure({ tenantMaxBytes: 1000 })
    const token = tokenOf(await s.reserve({ tenant: 'a', epoch: 1, batches: [{ fingerprint: 'f1', bytes: 300 }, { fingerprint: 'f2', bytes: 300 }] }))
    expect(await s.stats()).toMatchObject({ reservations: 1, reservedBytes: 600, reserved: 1 })
    // Another request of the tenant: 600 granted + 600 > 1000.
    expect(await s.reserve({ tenant: 'a', epoch: 1, batches: [{ fingerprint: 'g1', bytes: 600 }] })).toMatchObject({ status: 'backpressure', scope: 'tenant' })
    expect(await append(s, 'a', 'g1', 600)).toMatchObject({ status: 'backpressure', scope: 'tenant' })
    // Another tenant is not affected by this tenant's grant (its own cap).
    expect(await append(s, 'b', 'g1', 600)).toMatchObject({ status: 'ok' })
    // The granted batches are appended.
    expect(await append(s, 'a', 'f1', 300, token)).toMatchObject({ status: 'ok', duplicate: false })
    expect(await s.stats()).toMatchObject({ reservations: 1, reservedBytes: 300 })
    expect(await append(s, 'a', 'f2', 300, token)).toMatchObject({ status: 'ok', duplicate: false })
    expect(await s.stats()).toMatchObject({ reservations: 0, reservedBytes: 0 })
    expect(await rows(s, 'a')).toBe(2)
    // Used up: the token now admits nothing (an append under it is checked as one without it).
    expect(await append(s, 'a', 'f3', 600, token)).toMatchObject({ status: 'backpressure', scope: 'tenant' })
  })

  it('refuses for room exactly as an append would, and a refused reserve holds nothing', async () => {
    const s = fresh()
    await s.configure({ tenantMaxBytes: 1000 })
    expect(await append(s, 'a', 'x', 800)).toMatchObject({ status: 'ok' })
    expect(await s.reserve({ tenant: 'a', epoch: 1, batches: [{ fingerprint: 'f1', bytes: 100 }, { fingerprint: 'f2', bytes: 101 }] })).toMatchObject({ status: 'backpressure', scope: 'tenant', retryAfterMs: 1000 })
    expect(await s.stats()).toMatchObject({ reservations: 0, reservedBytes: 0, refusedReserve: 1 })
    expect(await s.reserve({ tenant: 'a', epoch: 1, batches: [{ fingerprint: 'f1', bytes: 100 }, { fingerprint: 'f2', bytes: 100 }] })).toMatchObject({ status: 'ok' })
  })

  it('counts grants in the shard-wide budget: a tenant over its fair share is refused while another holds a grant', async () => {
    const s = fresh()
    await s.configure({ shardMaxBytes: 1000, tenantMaxBytes: 10_000 })
    expect(await append(s, 'a', 'x', 900)).toMatchObject({ status: 'ok' })
    tokenOf(await s.reserve({ tenant: 'b', epoch: 1, batches: [{ fingerprint: 'f', bytes: 500 }] }))
    // a holds 900 of a 1000 budget shared by two: over its share once b's grant counts.
    expect(await append(s, 'a', 'y', 200)).toMatchObject({ status: 'backpressure', scope: 'shard' })
    // Under the budget without the grant, over it with: refused for its fair share.
    const u = fresh()
    await u.configure({ shardMaxBytes: 1000, tenantMaxBytes: 10_000 })
    expect(await append(u, 'b', 'x', 100)).toMatchObject({ status: 'ok' })
    expect(await append(u, 'a', 'x', 400)).toMatchObject({ status: 'ok' })
    tokenOf(await u.reserve({ tenant: 'c', epoch: 1, batches: [{ fingerprint: 'f', bytes: 400 }] }))
    expect(await append(u, 'a', 'y', 200)).toMatchObject({ status: 'backpressure', scope: 'shard' })
  })

  it('batches the stream holds or has waiting need no room: a full retry is granted with nothing held', async () => {
    const s = fresh()
    await s.configure({ tenantMaxBytes: 1000 })
    expect(await append(s, 'a', 'f1', 900)).toMatchObject({ status: 'ok' })
    expect(await s.reserve({ tenant: 'a', epoch: 1, batches: [{ fingerprint: 'f1', bytes: 900 }] })).toEqual({ status: 'ok', token: null, expiresInMs: 0 })
    // A twin waiting in the open group counts as held too.
    const pending = append(s, 'b', 'w', 500)
    const r = await s.reserve({ tenant: 'b', epoch: 1, batches: [{ fingerprint: 'w', bytes: 500 }, { fingerprint: 'v', bytes: 100 }] })
    await pending
    expect(r.status).toBe('ok')
    expect(await s.stats()).toMatchObject({ reservedBytes: 100 })
  })

  it('hold: false answers without holding anything (a probe)', async () => {
    const s = fresh()
    await s.configure({ tenantMaxBytes: 1000 })
    expect(await s.reserve({ tenant: 'a', epoch: 1, batches: [{ fingerprint: 'f', bytes: 900 }], hold: false })).toEqual({ status: 'ok', token: null, expiresInMs: 0 })
    expect(await s.stats()).toMatchObject({ reservations: 0, reservedBytes: 0 })
    expect(await s.reserve({ tenant: 'a', epoch: 1, batches: [{ fingerprint: 'f', bytes: 1001 }], hold: false })).toMatchObject({ status: 'backpressure', scope: 'tenant' })
  })

  it('release gives the room back; a token of another tenant, for another batch, or for fewer bytes admits nothing', async () => {
    const s = fresh()
    await s.configure({ tenantMaxBytes: 1000 })
    const t1 = tokenOf(await s.reserve({ tenant: 'a', epoch: 1, batches: [{ fingerprint: 'f', bytes: 900 }] }))
    await s.release('b', t1) // not b's: ignored
    expect(await s.stats()).toMatchObject({ reservedBytes: 900 })
    await s.release('a', t1)
    expect(await s.stats()).toMatchObject({ reservations: 0, reservedBytes: 0 })
    expect(await append(s, 'a', 'f', 900, t1)).toMatchObject({ status: 'ok' }) // room again, admitted without the token
    const t2 = tokenOf(await s.reserve({ tenant: 'a', epoch: 1, batches: [{ fingerprint: 'g', bytes: 50 }] }))
    await s.configure({ tenantMaxBytes: 920 })
    expect(await append(s, 'b', 'g', 50, t2)).toMatchObject({ status: 'ok' }) // b has room of its own
    expect(await append(s, 'a', 'h', 50, t2)).toMatchObject({ status: 'backpressure', scope: 'tenant' }) // another fingerprint
    expect(await append(s, 'a', 'g', 60, t2)).toMatchObject({ status: 'backpressure', scope: 'tenant' }) // more bytes than granted
    expect(await append(s, 'a', 'g', 50, t2)).toMatchObject({ status: 'ok' })
    // A tenant at its cap cannot use another tenant's token for a batch of the same fingerprint.
    await s.configure({ tenantMaxBytes: 1000 })
    const t3 = tokenOf(await s.reserve({ tenant: 'a', epoch: 1, batches: [{ fingerprint: 'k', bytes: 10 }] }))
    expect(await append(s, 'c', 'fill', 995)).toMatchObject({ status: 'ok' })
    expect(await append(s, 'c', 'k', 10, t3)).toMatchObject({ status: 'backpressure', scope: 'tenant' })
    expect(await s.stats()).toMatchObject({ reservedBytes: 10 }) // still a's
  })

  it('a grant expires after reservationTtlMs: its room is free again and its token admits nothing', async () => {
    const s = fresh()
    await s.configure({ tenantMaxBytes: 1000, reservationTtlMs: 20 })
    const token = tokenOf(await s.reserve({ tenant: 'a', epoch: 1, batches: [{ fingerprint: 'f', bytes: 900 }] }))
    await new Promise((r) => setTimeout(r, 40))
    expect(await s.stats()).toMatchObject({ reservations: 0, reservedBytes: 0, reservationsExpired: 1 })
    expect(await append(s, 'b', 'x', 10)).toMatchObject({ status: 'ok' })
    await s.configure({ tenantMaxBytes: 500 })
    expect(await append(s, 'a', 'f', 900, token)).toMatchObject({ status: 'backpressure', scope: 'tenant' })
  })

  it('a granted append is not refused for load; the grant counts in the in-flight limit for everyone else', async () => {
    const s = fresh()
    await s.configure({ maxInFlight: 2 })
    const token = tokenOf(await s.reserve({ tenant: 'a', epoch: 1, batches: [{ fingerprint: 'f1', bytes: 10 }, { fingerprint: 'f2', bytes: 10 }] }))
    expect(await append(s, 'b', 'x', 10)).toMatchObject({ status: 'backpressure', scope: 'overload' })
    expect(await s.reserve({ tenant: 'b', epoch: 1, batches: [{ fingerprint: 'x', bytes: 10 }] })).toMatchObject({ status: 'backpressure', scope: 'overload' })
    // The limits are lowered after the grant (an operator, or a shard shedding): what was granted still goes in.
    await s.configure({ maxPendingBytes: 0 })
    const both = await Promise.all([append(s, 'a', 'f1', 10, token), append(s, 'a', 'f2', 10, token)])
    expect(both.map((r) => r.status)).toEqual(['ok', 'ok'])
    expect(await append(s, 'b', 'x', 10)).toMatchObject({ status: 'backpressure', scope: 'overload' })
    await s.configure({ maxPendingBytes: 16 << 20 })
    expect(await append(s, 'b', 'x', 10)).toMatchObject({ status: 'ok' })
  })

  it('answers stale_epoch and too_large as an append would, and refuses a new stream in `logged` mode until it is registered (D61)', async () => {
    const s = fresh()
    expect(await append(s, 'a', 'x', 10)).toMatchObject({ status: 'ok' })
    await s.append({ tenant: 'a', epoch: 5, fingerprint: 'y', payload: payload(10), rows: 1 })
    expect(await s.reserve({ tenant: 'a', epoch: 4, batches: [{ fingerprint: 'f', bytes: 10 }] })).toEqual({ status: 'stale_epoch', epoch: 5 })
    await s.configure({ maxBatchBytes: 100 })
    expect(await s.reserve({ tenant: 'a', epoch: 5, batches: [{ fingerprint: 'f', bytes: 101 }] })).toEqual({ status: 'too_large', maxBytes: 100 })
    await s.configure({ registration: 'logged' })
    expect(await s.reserve({ tenant: 'new', epoch: 1, batches: [{ fingerprint: 'f', bytes: 10 }] })).toMatchObject({ status: 'backpressure', scope: 'registering' })
    let thrown = ''
    try {
      await s.reserve({ tenant: 'a', epoch: 5, batches: [{ fingerprint: 3, bytes: 10 }] } as never)
    } catch (e) {
      thrown = String(e)
    }
    expect(thrown).toMatch(/fingerprint/)
  })

  it('a grant is memory only: an eviction drops it, nothing stored changes, and its appends are admitted as without a token', async () => {
    const s = fresh()
    await s.configure({ tenantMaxBytes: 1000 })
    expect(await append(s, 'a', 'x', 100)).toMatchObject({ status: 'ok' })
    const token = tokenOf(await s.reserve({ tenant: 'a', epoch: 1, batches: [{ fingerprint: 'f1', bytes: 400 }, { fingerprint: 'f2', bytes: 400 }] }))
    await evictDurableObject(s)
    expect(await s.stats()).toMatchObject({ reservations: 0, reservedBytes: 0 })
    expect(await rows(s, 'a')).toBe(1)
    // Room is what storage says: 100 held, so both fit without the grant...
    expect(await append(s, 'a', 'f1', 400, token)).toMatchObject({ status: 'ok' })
    // ...and with less room, the second is refused as any append would be (edge answers it 503: BATCH.md).
    await s.configure({ tenantMaxBytes: 800 })
    expect(await append(s, 'a', 'f2', 400, token)).toMatchObject({ status: 'backpressure', scope: 'tenant' })
    expect(await rows(s, 'a')).toBe(2)
  })
})
