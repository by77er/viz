/**
 * Early refusal and group commit (spikes/s3-ingest-throughput/README.md, conclusions 3 and 4):
 * an append over the in-flight limit is refused before anything is read or written; the
 * appends that are taken are committed in one transaction per group, and each caller is
 * answered only after that transaction commits. Nothing acknowledged is lost across
 * eviction, nothing refused is stored, and a group whose transaction fails stores nothing.
 */
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { type AppendResult, Shard } from '../src/shard'

let n = 0
const fresh = () => env.SHARD.get(env.SHARD.idFromName(`gc-${Date.now().toString(36)}/${n++}`))
const payload = (i: number, size = 64) => {
  const p = new Uint8Array(size)
  new DataView(p.buffer).setUint32(0, i, true)
  return p
}
const stored = (s: DurableObjectStub<Shard>, tenant: string) =>
  runInDurableObject(s, (_i, state) =>
    state.storage.sql.exec(`SELECT seq, fingerprint, payload FROM batch WHERE tenant = ? ORDER BY seq`, tenant).toArray()
      .map((r) => ({ seq: r.seq as number, fp: r.fingerprint as string, first: new DataView(r.payload as ArrayBuffer).getUint32(0, true) })))

/** mulberry32, so a failing run can be repeated from its seed. */
function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('group commit', () => {
  it('commits concurrent appends in one transaction per group, answering each with its own contiguous sequence number', async () => {
    const s = fresh()
    const results = await Promise.all(Array.from({ length: 40 }, (_, i) => s.append({ tenant: i % 2 === 0 ? 'a' : 'b', epoch: 1, fingerprint: `f${i}`, payload: payload(i), rows: 1 })))
    expect(results.every((r) => r.status === 'ok')).toBe(true)
    const st = await s.stats()
    expect(st.committed).toBe(40)
    expect(st.groups).toBeLessThan(40) // they shared transactions
    expect(st.maxGroup).toBeGreaterThan(1)
    expect(st.inFlight).toBe(0)
    for (const t of ['a', 'b']) {
      const seqs = results.filter((_, i) => (i % 2 === 0 ? 'a' : 'b') === t).map((r) => (r as { seq: number }).seq).sort((x, y) => x - y)
      expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => i + 1))
    }
    // One row per batch, never per sample; each answer names the row that holds its payload.
    const rows = await stored(s, 'a')
    expect(rows).toHaveLength(20)
    results.forEach((r, i) => {
      if (i % 2 !== 0) return
      expect(rows.find((x) => x.seq === (r as { seq: number }).seq)!.first).toBe(i)
    })
  })

  it('a retry that arrives while its batch waits in the open group gets the same answer and adds no row', async () => {
    const s = fresh()
    const [a, b, c] = await Promise.all([
      s.append({ tenant: 't', epoch: 1, fingerprint: 'same', payload: payload(1), rows: 1 }),
      s.append({ tenant: 't', epoch: 1, fingerprint: 'same', payload: payload(1), rows: 1 }),
      s.append({ tenant: 't', epoch: 1, fingerprint: 'other', payload: payload(2), rows: 1 }),
    ])
    expect(a).toMatchObject({ status: 'ok', seq: 1, duplicate: false })
    expect(b).toMatchObject({ status: 'ok', seq: 1, duplicate: true })
    expect(c).toMatchObject({ status: 'ok', seq: 2 })
    expect(await stored(s, 't')).toHaveLength(2)
  })

  it('a group whose transaction fails answers every member with the error and stores nothing; the shard goes on', async () => {
    const s = fresh()
    await s.configure({ sealBytes: 200 }) // the group's appends will seal inside the transaction
    const proto = Shard.prototype as unknown as { sealStream(...a: unknown[]): unknown }
    const real = proto.sealStream
    proto.sealStream = function () { throw new Error('injected: failure inside the group transaction') }
    let outcomes: string[]
    try {
      outcomes = await Promise.all(Array.from({ length: 6 }, (_, i) => s.append({ tenant: 't', epoch: 1, fingerprint: `x${i}`, payload: payload(i), rows: 1 }).then((r) => r.status, (e: Error) => e.message)))
    } finally {
      proto.sealStream = real
    }
    expect(outcomes.every((o) => /injected/.test(o))).toBe(true)
    expect(await stored(s, 't')).toEqual([])
    expect(await s.describe('t')).toBeNull()
    expect((await s.stats()).inFlight).toBe(0)
    // Nothing was acknowledged, so a retry of every one of them is stored once.
    const again = await Promise.all(Array.from({ length: 6 }, (_, i) => s.append({ tenant: 't', epoch: 1, fingerprint: `x${i}`, payload: payload(i), rows: 1 })))
    expect(again.map((r) => r.status)).toEqual(Array(6).fill('ok'))
    expect((await stored(s, 't')).map((r) => r.seq)).toEqual([1, 2, 3, 4, 5, 6])
  })
})

describe('early refusal', () => {
  it('over the in-flight limit an append is refused at once, retryably, with Retry-After, and nothing of it is stored', async () => {
    const s = fresh()
    await s.configure({ maxInFlight: 4, overloadRetryMs: 1000, groupWindowMs: 20 })
    const results = await Promise.all(Array.from({ length: 30 }, (_, i) => s.append({ tenant: 't', epoch: 1, fingerprint: `f${i}`, payload: payload(i), rows: 1 })))
    const refused = results.map((r, i) => [r, i] as const).filter(([r]) => r.status === 'backpressure')
    const taken = results.map((r, i) => [r, i] as const).filter(([r]) => r.status === 'ok')
    expect(refused.length).toBeGreaterThan(0)
    expect(taken.length).toBeGreaterThan(0)
    for (const [r] of refused) {
      expect(r).toMatchObject({ status: 'backpressure', scope: 'overload' })
      const ms = (r as { retryAfterMs: number }).retryAfterMs
      expect(ms).toBeGreaterThanOrEqual(1000)
      expect(ms).toBeLessThan(2000)
    }
    const rows = await stored(s, 't')
    expect(rows.map((x) => x.fp).sort()).toEqual(taken.map(([, i]) => `f${i}`).sort())
    expect((await s.describe('t'))!.bufferedBytes).toBe(64 * taken.length)
    expect((await s.stats()).refusedOverload).toBe(refused.length)
  })

  it('a refused append reads nothing: not even its fingerprint (a retry of an acknowledged batch is refused too, harmlessly)', async () => {
    const s = fresh()
    await s.configure({ maxInFlight: 0 })
    const r = await runInDurableObject(s, async (inst: Shard, state) => {
      const before = state.storage.sql.exec(`SELECT 1`).rowsRead
      const out = await inst.append({ tenant: 't', epoch: 1, fingerprint: 'f', payload: payload(1), rows: 1 })
      return { out, rows: (await inst.stats()).appends, before }
    })
    expect(r.out).toMatchObject({ status: 'backpressure', scope: 'overload' })
    expect(r.rows).toBe(0) // it never reached the part of `append` that reads storage
    expect(await stored(s, 't')).toEqual([])
    // A retry of a batch the shard already holds is refused the same way: answering it as a
    // duplicate would mean reading its fingerprint, which an overloaded shard does not do.
    await s.configure({ maxInFlight: 64 })
    expect(await s.append({ tenant: 't', epoch: 1, fingerprint: 'g', payload: payload(2), rows: 1 })).toMatchObject({ status: 'ok' })
    await s.configure({ maxInFlight: 0 })
    expect(await s.append({ tenant: 't', epoch: 1, fingerprint: 'g', payload: payload(2), rows: 1 })).toMatchObject({ status: 'backpressure', scope: 'overload' })
  })

  it('the tenant cap counts what waits in the open group: concurrent appends never take a tenant past it', async () => {
    const s = fresh()
    await s.configure({ tenantMaxBytes: 64 * 3, groupWindowMs: 20 })
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => s.append({ tenant: 't', epoch: 1, fingerprint: `c${i}`, payload: payload(i), rows: 1 })))
    expect(results.filter((r) => r.status === 'ok')).toHaveLength(3)
    expect(results.filter((r) => r.status === 'backpressure' && r.scope === 'tenant')).toHaveLength(3)
    expect((await s.describe('t'))!.bufferedBytes).toBe(64 * 3)
  })

  it('under random load, evictions and refusals, every acknowledged append is stored exactly once and nothing refused is', { timeout: 60_000 }, async () => {
    for (const seed of [1, 2, 3]) {
      const r = rng(seed)
      const s = fresh()
      await s.configure({ maxInFlight: 3 + Math.floor(r() * 6), groupWindowMs: Math.floor(r() * 3) })
      const acked = new Map<string, number>() // fingerprint → seq
      const refusedFps = new Set<string>()
      let k = 0
      for (let round = 0; round < 12; round++) {
        const batch = Array.from({ length: 5 + Math.floor(r() * 25) }, () => {
          // Sometimes resend an acknowledged batch: it must come back with its seq, stored once.
          if (acked.size > 0 && r() < 0.15) return [...acked.keys()][Math.floor(r() * acked.size)]!
          return `f${k++}`
        })
        const res: AppendResult[] = await Promise.all(batch.map((fp) => s.append({ tenant: 't', epoch: 1, fingerprint: fp, payload: payload(Number(fp.slice(1))), rows: 1 }).catch(() => ({ status: 'invalid', reason: 'threw' }) as AppendResult)))
        res.forEach((x, i) => {
          const fp = batch[i]!
          if (x.status === 'ok') {
            if (acked.has(fp)) expect(x.seq, `${fp} answered twice with different seqs`).toBe(acked.get(fp))
            acked.set(fp, x.seq)
            refusedFps.delete(fp)
          } else {
            expect(x.status).toBe('backpressure')
            if (!acked.has(fp)) refusedFps.add(fp)
          }
        })
        if (r() < 0.3) await evictDurableObject(s)
        if (r() < 0.2) await runDurableObjectAlarm(s)
      }
      await evictDurableObject(s)
      const rows = await stored(s, 't')
      // Exactly the acknowledged batches, each once, at the sequence it was answered with.
      expect(new Map(rows.map((x) => [x.fp, x.seq])), `seed ${seed}`).toEqual(acked)
      for (const x of rows) expect(x.first).toBe(Number(x.fp.slice(1)))
      for (const fp of refusedFps) expect(rows.some((x) => x.fp === fp), `${fp} was refused but stored`).toBe(false)
      expect(refusedFps.size, `seed ${seed}: some appends were refused`).toBeGreaterThan(0)
      const tail = await s.tailRead('t', (await s.describe('t'))!.incarnation, 0)
      expect(tail.status === 'ok' && tail.batches.map((b) => b.seq)).toEqual(rows.map((x) => x.seq))
    }
  })
})

describe('review R-11: the series window is saved only when it changed', () => {
  it('a metered append whose series are all already in the current bucket marks nothing to save', async () => {
    const s = fresh()
    await s.configure({ seriesPersistMs: 60_000 })
    const ids = BigInt64Array.from([1n, 2n, 3n])
    const batch = (fp: string) => {
      const p = new Uint8Array(64)
      new DataView(p.buffer).setUint32(12, ids.length, true)
      return s.append({ tenant: 't', epoch: 1, fingerprint: fp, payload: p, rows: 3, seriesIds: ids, seriesLimit: 100 })
    }
    expect((await batch('a')).status).toBe('ok')
    const dirty = () => runInDurableObject(s, (inst: Shard) => (inst as unknown as { windows: Map<string, { dirtySince: number | null }> }).windows.get('t')!.dirtySince)
    expect(await dirty()).not.toBeNull()
    await runInDurableObject(s, async (inst: Shard) => {
      ;(inst as unknown as { windows: Map<string, { dirtySince: number | null }> }).windows.get('t')!.dirtySince = Date.now() - 120_000
      await inst.alarm() // saves it
    })
    expect(await dirty()).toBeNull()
    expect((await batch('b')).status).toBe('ok') // the same three series again
    expect(await dirty()).toBeNull()
  })
})
