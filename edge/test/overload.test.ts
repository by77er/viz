/**
 * Early refusal through the edge (spikes/s3-ingest-throughput/README.md, conclusion 3), unknown
 * shard statuses, and the KV records edge reads (contracts/COMPATIBILITY.md §3.2;
 * design/UPGRADES.md §7; review R-9).
 */
import { env } from 'cloudflare:workers'
import { afterEach, describe, expect, it } from 'vitest'
import type { PoolMap } from '../../shard/src/pool'
import { Shard } from '../../shard/src/shard'
import { clearCaches } from '../src/index'
import { type PrwSeries, makeKey, newTenant, otlpProto, postOtlp, postWrite, setPool, sha256Hex, shardStub, tailOfSlot } from './helpers'

async function tenant(slots = 1) {
  const t = newTenant('ovl')
  const key = await makeKey(t)
  const map: PoolMap = { pool: `ovl/${t}`, slots, spread: slots, epoch: 1 }
  await setPool(t, map)
  clearCaches()
  return { tenant: t, key, map }
}
const now = Date.now()
const series = (n: number): PrwSeries[] => Array.from({ length: n }, (_, i) => ({ labels: [['__name__', 'up'], ['job', 'api'], ['n', String(i)]], samples: [{ ts: now, value: i }] }))
const otlp = () => otlpProto({ resourceMetrics: [{ scopeMetrics: [{ metrics: [{ name: 'm', gauge: { dataPoints: [{ timeUnixNano: String(BigInt(now) * 1_000_000n), asDouble: 1 }] } }] }] }] })

afterEach(() => clearCaches())

describe('an overloaded shard', () => {
  it('Remote Write and OTLP get 503 with Retry-After (which every sender retries), nothing is stored, and the retry after it clears is stored once', async () => {
    const t = await tenant()
    await shardStub(t.map, 0).configure({ maxInFlight: 0, overloadRetryMs: 1000 })
    const w = await postWrite(t.key, series(3))
    expect(w.status).toBe(503)
    expect(Number(w.headers.get('Retry-After'))).toBeGreaterThanOrEqual(1)
    expect(await w.text()).toContain('overloaded')
    const o = await postOtlp(t.key, otlp(), 'application/x-protobuf')
    expect(o.status).toBe(503)
    expect(Number(o.headers.get('Retry-After'))).toBeGreaterThanOrEqual(1)
    expect((await tailOfSlot(t.map, 0, t.tenant)).batches).toEqual([])
    await shardStub(t.map, 0).configure({ maxInFlight: 64 })
    clearCaches() // as if the Retry-After had passed
    expect((await postWrite(t.key, series(3))).status).toBe(204)
    expect((await postWrite(t.key, series(3))).status).toBe(204)
    expect((await tailOfSlot(t.map, 0, t.tenant)).batches).toHaveLength(1)
  })

  it('a stream being registered (D61) is 503 with Retry-After, never 429; nothing is stored; the retry once registered is stored once', async () => {
    const t = await tenant()
    const proto = Shard.prototype as unknown as { append: Shard['append'] }
    const real = proto.append
    let refuse = true
    let calls = 0
    proto.append = async function (this: Shard, req) {
      calls++
      return refuse ? { status: 'backpressure', scope: 'registering', retryAfterMs: 700 } : real.call(this, req)
    }
    try {
      for (const res of [await postWrite(t.key, series(3)), await postOtlp(t.key, otlp(), 'application/x-protobuf')]) {
        expect(res.status).toBe(503)
        expect(res.headers.get('Retry-After')).toBe('1')
      }
      // One stream being registered is not an overloaded shard: the second request still reached
      // the shard instead of being refused early (the early refusal stays keyed to `overload`).
      expect(calls).toBe(2)
      expect((await tailOfSlot(t.map, 0, t.tenant)).batches).toEqual([])
      refuse = false
      clearCaches()
      expect((await postWrite(t.key, series(3))).status).toBe(204)
      expect((await postWrite(t.key, series(3))).status).toBe(204) // a retry: stored once
      expect((await tailOfSlot(t.map, 0, t.tenant)).batches).toHaveLength(1)
    } finally {
      proto.append = real
    }
  })

  it('once every shard of the tenant has refused as overloaded, the next request is refused before its body is read or decoded', async () => {
    const t = await tenant(2)
    for (const slot of [0, 1]) await shardStub(t.map, slot).configure({ maxInFlight: 0, overloadRetryMs: 5000 })
    // A request whose series go to both slots: both refuse, and edge remembers it.
    const many: PrwSeries[] = Array.from({ length: 40 }, (_, i) => ({ labels: [['__name__', 'up'], ['job', `job-${i}`]], samples: [{ ts: now, value: i }] }))
    expect((await postWrite(t.key, many)).status).toBe(503)
    // Not even valid snappy: had it been read and decoded, the answer would be a 4xx.
    const garbage = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0x01]) as Uint8Array<ArrayBuffer>
    const r = await postWrite(t.key, garbage)
    expect(r.status).toBe(503)
    expect(Number(r.headers.get('Retry-After'))).toBeGreaterThanOrEqual(4)
    expect((await postOtlp(t.key, 'not json at all', 'application/json')).status).toBe(503)
    // Without the memory (another isolate) the same body is decoded and refused as malformed.
    clearCaches()
    expect([400, 413]).toContain((await postWrite(t.key, garbage)).status)
  })

  it('a status edge does not know is never counted as stored: 503, never 2xx', async () => {
    const t = await tenant()
    const proto = Shard.prototype as unknown as { append(...a: unknown[]): Promise<unknown> }
    const real = proto.append
    proto.append = async () => ({ status: 'accepted_later', seq: 1 })
    try {
      const w = await postWrite(t.key, series(2))
      expect(w.status).toBe(503)
      const o = await postOtlp(t.key, otlp(), 'application/x-protobuf')
      expect(o.status).toBe(503)
    } finally {
      proto.append = real
    }
  })
})

describe('KV records edge reads', () => {
  const record = async (tenant: string, over: Record<string, unknown>) => {
    const keyId = `kv${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`
    const secret = 's3cr3t-0123456789abcdef'
    await env.CONFIG.put(`key:${keyId}`, JSON.stringify({ tenant, secretSha256: await sha256Hex(secret), scopes: ['write'], ...over }))
    clearCaches()
    return `viz_${keyId}_${secret}`
  }

  it('a key record whose tenant id is not a TENANT_ID authenticates nobody, so nothing is acknowledged that could never be flushed (review R-9)', async () => {
    for (const bad of ['acme.prod', 'a/b', 'x'.repeat(65), '']) {
      const key = await record(bad, {})
      expect((await postWrite(key, series(1))).status, bad).toBe(401)
    }
  })

  it('a key record of a newer version is refused with 503 (the key may be fine), never read on a guess and never 401', async () => {
    const t = await tenant()
    const v1 = await record(t.tenant, { v: 1 })
    expect((await postWrite(v1, series(1))).status).toBe(204)
    const v2 = await record(t.tenant, { v: 2 })
    const r = await postWrite(v2, series(1))
    expect(r.status).toBe(503)
    expect(r.headers.get('Retry-After')).toBe('30')
  })

  it('a pool map naming a pool outside POOL_NAME is refused (503) and nothing is stored: its shards\' key encoding would not be one-to-one (contracts/TABLES.md)', async () => {
    const t = await tenant()
    const bad: PoolMap = { ...t.map, pool: `ovl_${t.tenant}` }
    await env.CONFIG.put(`pool:${t.tenant}`, JSON.stringify(bad))
    clearCaches()
    const r = await postWrite(t.key, series(1))
    expect(r.status).toBe(503)
    expect(await r.text()).toMatch(/pool map is invalid/)
    // The shard the bad map names would serve nothing anyway; the good map's shard holds nothing.
    expect(await tailOfSlot(bad, 0, t.tenant).then(() => 'served', (e: Error) => e.message)).toMatch(/SHARD_NAME/)
    expect((await tailOfSlot(t.map, 0, t.tenant)).samples).toEqual([])
    await setPool(t.tenant, t.map)
    clearCaches()
    expect((await postWrite(t.key, series(1))).status).toBe(204)
    expect((await tailOfSlot(t.map, 0, t.tenant)).samples).toHaveLength(1)
  })

  it('a pool map or limits record of a newer version is refused (503) unless this isolate holds the last good one; a limit is never loosened to the default', async () => {
    const t = await tenant()
    await env.CONFIG.put(`pool:${t.tenant}`, JSON.stringify({ ...t.map, v: 2 }))
    clearCaches()
    expect((await postWrite(t.key, series(1))).status).toBe(503)
    await setPool(t.tenant, t.map)
    await env.CONFIG.put(`limits:${t.tenant}`, JSON.stringify({ v: 2, active_series: 5 }))
    clearCaches()
    expect((await postWrite(t.key, series(1))).status).toBe(503)
    await env.CONFIG.put(`limits:${t.tenant}`, JSON.stringify({ v: 1, active_series: 5 }))
    clearCaches()
    expect((await postWrite(t.key, series(1))).status).toBe(204)
  })
})
