import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { type PoolMap, slotFor } from '../../shard/src/pool'
import type { AppendRequest, AppendResult } from '../../shard/src/shard'
import { clearCaches } from '../src/index'
import { type PrwSeries, bitsOf, canon, makeKey, newTenant, otlpProto, postOtlp, postWrite, setPool, shardStub, snappyCompress, tailOfSlot, writeRequest } from './helpers'

/** A two-slot pool of the tenant's own, and one series routed to each slot. */
async function twoSlots() {
  const tenant = newTenant()
  const key = await makeKey(tenant)
  const map: PoolMap = { pool: `flow/${tenant}`, slots: 2, spread: 2, epoch: 1 }
  await setPool(tenant, map)
  const jobFor = (slot: number): string => {
    for (let i = 0; ; i++) if (slotFor(map, tenant, `job=job-${i}\u0000instance=`) === slot) return `job-${i}`
  }
  const now = Date.now()
  const series: PrwSeries[] = [0, 1].map((slot) => ({
    labels: [['__name__', 'requests_total'], ['job', jobFor(slot)], ['slot', String(slot)]],
    samples: [{ ts: now - 1000, value: slot + 1 }, { ts: now, value: slot + 2 }],
  }))
  return { tenant, key, map, series, now }
}

const sent = (s: PrwSeries) => canon(s.samples.map((x) => ({ labels: Object.fromEntries(s.labels), ts: x.ts, bits: bitsOf(x.value as number) })))

describe('backpressure', () => {
  it('429 with Retry-After for the whole request when one slot refuses, nothing of it stored (D77); a full retry stores nothing twice', async () => {
    const { tenant, key, map, series } = await twoSlots()
    // Slot 1 cannot take even one batch; slot 0 is healthy.
    await shardStub(map, 1).configure({ tenantMaxBytes: 16 })
    const body = snappyCompress(writeRequest(series))

    const first = await postWrite(key, body)
    expect(first.status).toBe(429)
    expect(first.headers.get('Retry-After')).toBe('1') // the shard said 1000 ms
    // A 429 stores nothing (D77): the healthy slot granted room but appended nothing, and the
    // refused slot holds nothing. (Before D77 the healthy slot kept its batch.)
    expect((await tailOfSlot(map, 0, tenant)).batches.length).toBe(0)
    expect((await tailOfSlot(map, 1, tenant)).batches.length).toBe(0)

    // Still refused while the shard is full: same answer, still nothing stored.
    expect((await postWrite(key, body)).status).toBe(429)
    expect((await tailOfSlot(map, 0, tenant)).batches.length).toBe(0)

    // The shard drains (here: the cap is lifted) and the sender retries the whole request.
    await shardStub(map, 1).configure({ tenantMaxBytes: 64 << 20 })
    // A retry sent inside the Retry-After is refused before decoding (D77); this one waits it out.
    clearCaches() // as if the Retry-After had passed
    const retry = await postWrite(key, body)
    expect(retry.status).toBe(204)
    for (const slot of [0, 1]) {
      const t = await tailOfSlot(map, slot, tenant)
      expect(t.batches.length).toBe(1)
      expect(canon(t.samples)).toEqual(sent(series[slot]!))
    }
    // …and a duplicate delivery of the acknowledged request changes nothing either.
    expect((await postWrite(key, body)).status).toBe(204)
    for (const slot of [0, 1]) expect((await tailOfSlot(map, slot, tenant)).samples.length).toBe(2)
    expect((await shardStub(map, 0).describe(tenant))!.nextSeq).toBe(2)
  })

  it('OTLP gets 429 + Retry-After too, never a 200 with dropped points', async () => {
    const tenant = newTenant()
    const key = await makeKey(tenant)
    const map: PoolMap = { pool: `flow/${tenant}`, slots: 1, spread: 1, epoch: 1 }
    await setPool(tenant, map)
    await shardStub(map, 0).configure({ tenantMaxBytes: 16 })
    const req = { resourceMetrics: [{ scopeMetrics: [{ metrics: [{ name: 'm', gauge: { dataPoints: [{ timeUnixNano: String(BigInt(Date.now()) * 1_000_000n), asDouble: 1 }] } }] }] }] }
    for (const json of [true, false]) {
      const res = await postOtlp(key, json ? JSON.stringify(req) : otlpProto(req), json ? 'application/json' : 'application/x-protobuf')
      expect(res.status).toBe(429)
      expect(res.headers.get('Retry-After')).toBe('1')
    }
    expect((await tailOfSlot(map, 0, tenant)).samples).toEqual([])
    await shardStub(map, 0).configure({ tenantMaxBytes: 64 << 20 })
    expect((await postOtlp(key, JSON.stringify(req), 'application/json')).status).toBe(200)
    expect((await tailOfSlot(map, 0, tenant)).samples.length).toBe(1)
  })
})

describe('acknowledgement', () => {
  /** A stand-in namespace whose shards answer when the test says so. */
  function fakeShards(respond: (req: AppendRequest, name: string) => Promise<AppendResult>) {
    const calls: { name: string; req: AppendRequest }[] = []
    const ns = {
      idFromName: (name: string) => name,
      get: (name: string) => ({
        append: (req: AppendRequest) => {
          calls.push({ name, req })
          return respond(req, name)
        },
      }),
    }
    return { ns: ns as unknown as Env['SHARD'], calls }
  }
  type Env = Cloudflare.Env

  it('does not answer until every shard append has resolved', async () => {
    const { key, series } = await twoSlots()
    const release: (() => void)[] = []
    const { ns, calls } = fakeShards(
      (req) => new Promise((resolve) => release.push(() => resolve({ status: 'ok', incarnation: 1, seq: 1, duplicate: false }))),
    )
    let answered: Response | null = null
    const pending = postWrite(key, series, { env: { SHARD: ns } }).then((r) => (answered = r))
    const settle = () => new Promise((r) => setTimeout(r, 30))
    await settle()
    expect(calls.length).toBe(2) // both slots were called concurrently…
    expect(answered).toBeNull() // …and neither has answered, so neither has the Worker
    release[0]!()
    await settle()
    expect(answered).toBeNull() // one of two is not enough
    release[1]!()
    expect((await pending).status).toBe(204)
  })

  it('passes tenant, epoch, row count and the SHA-256 of the batch as fingerprint', async () => {
    const { tenant, key, series, map } = await twoSlots()
    const { ns, calls } = fakeShards(async () => ({ status: 'ok', incarnation: 1, seq: 1, duplicate: false }))
    expect((await postWrite(key, series, { env: { SHARD: ns } })).status).toBe(204)
    expect(calls.map((c) => c.name).sort()).toEqual([`${map.pool}/0`, `${map.pool}/1`])
    for (const { req } of calls) {
      expect(req.tenant).toBe(tenant)
      expect(req.epoch).toBe(map.epoch)
      expect(req.rows).toBe(2)
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', req.payload as Uint8Array<ArrayBuffer>))
      expect(req.fingerprint).toBe([...digest].map((b) => b.toString(16).padStart(2, '0')).join(''))
    }
    // Different content → different fingerprints.
    expect(new Set(calls.map((c) => c.req.fingerprint)).size).toBe(2)
  })

  it('503 with Retry-After when a shard fails, whatever the other shards said', async () => {
    const { key, series, map } = await twoSlots()
    const { ns } = fakeShards(async (_req, name) => {
      if (name === `${map.pool}/1`) throw new Error('Durable Object is overloaded')
      return { status: 'ok', incarnation: 1, seq: 1, duplicate: false }
    })
    const res = await postWrite(key, series, { env: { SHARD: ns } })
    expect(res.status).toBe(503)
    expect(res.headers.get('Retry-After')).toBe('1')
    expect(await res.text()).not.toContain('overloaded') // internals are not echoed
  })

  it('makes no shard call and still answers correctly when nothing was accepted', async () => {
    const { key } = await twoSlots()
    const { ns, calls } = fakeShards(async () => ({ status: 'ok', incarnation: 1, seq: 1, duplicate: false }))
    expect((await postWrite(key, [], { env: { SHARD: ns } })).status).toBe(204)
    expect((await postWrite(key, [{ labels: [['__name__', 'old']], samples: [{ ts: 1, value: 1 }] }], { env: { SHARD: ns } })).status).toBe(400)
    expect(calls.length).toBe(0)
  })
})

describe('shard map epochs', () => {
  it('refetches the map once on stale_epoch and retries with the new epoch', async () => {
    const tenant = newTenant()
    const key = await makeKey(tenant)
    const v1: PoolMap = { pool: `epoch/${tenant}`, slots: 1, spread: 1, epoch: 3 }
    await setPool(tenant, v1)
    const one = (name: string): PrwSeries[] => [{ labels: [['__name__', name]], samples: [{ ts: Date.now(), value: 1 }] }]
    clearCaches()
    expect((await postWrite(key, one('first'))).status).toBe(204) // epoch 3 is now cached in the Worker

    // The ledger moves the map to epoch 5 and the shard learns of it (another writer got there first).
    const v2 = { ...v1, epoch: 5 }
    await shardStub(v1, 0).append({ tenant, epoch: 5, fingerprint: 'other-writer', payload: new Uint8Array([1]), rows: 1 })
    expect((await shardStub(v1, 0).describe(tenant))!.epoch).toBe(5)

    // KV still says 3: the refetch finds nothing newer → 503, retryable, nothing stored.
    const stale = await postWrite(key, one('second'))
    expect(stale.status).toBe(503)
    expect(stale.headers.get('Retry-After')).toBe('1')
    expect((await shardStub(v1, 0).describe(tenant))!.nextSeq).toBe(3)

    // KV catches up. The Worker's cache still holds epoch 3; it must refetch and succeed.
    await setPool(tenant, v2)
    let gets = 0
    const counting = { get: (...a: unknown[]) => (gets++, (env.CONFIG.get as (...x: unknown[]) => unknown)(...a)) } as unknown as KVNamespace
    const ok = await postWrite(key, one('third'), { env: { CONFIG: counting } })
    expect(ok.status).toBe(204)
    expect(gets).toBe(1) // exactly one refetch of the map
    const d = await shardStub(v1, 0).describe(tenant)
    expect(d!.nextSeq).toBe(4)
    // The new epoch is cached: the next write needs no KV read and no retry.
    expect((await postWrite(key, one('fourth'), { env: { CONFIG: counting } })).status).toBe(204)
    expect(gets).toBe(1)
  })
})
