import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { type PoolMap, slotFor } from '../../shard/src/pool'
import { Collector, buildBatches } from '../src/batch'
import { clearCaches } from '../src/index'
import { DEFAULT_LIMITS } from '../src/limits'
import { DEFAULT_ACTIVE_SERIES, activeSeriesLimit, shardShare } from '../src/route'
import { decodeRemoteWrite } from '../src/prw'
import { type PrwSeries, bitsOf, canon, decodeVZB1, makeKey, newTenant, otlpProto, postOtlp, postWrite, refSeriesId, setPool, shardStub, tail, tailOfSlot, writeRequest } from './helpers'

/** A tenant with its own pool of `slots` shards and an active-series limit. */
async function tenantWith(limit: number | null, slots = 1) {
  const tenant = newTenant('lim')
  const key = await makeKey(tenant)
  const map: PoolMap = { pool: `lim/${tenant}`, slots, spread: slots, epoch: 1 }
  await setPool(tenant, map)
  if (limit !== null) await env.CONFIG.put(`limits:${tenant}`, JSON.stringify({ active_series: limit }))
  clearCaches()
  return { tenant, key, map }
}
const now = Date.now()
const one = (name: string, i: number, at = now, job = 'api'): PrwSeries => ({
  labels: [['__name__', name], ['job', job], ['instance', 'a:1'], ['n', String(i)]],
  samples: [{ ts: at, value: i }],
})
const many = (name: string, lo: number, hi: number, at = now) => Array.from({ length: hi - lo }, (_, k) => one(name, lo + k, at))
const want = (series: PrwSeries[]) => canon(series.flatMap((s) => s.samples.map((x) => ({ labels: Object.fromEntries(s.labels), ts: x.ts, bits: bitsOf(x.value as number) }))))

describe('series ids travel with the batch', () => {
  it('every batch carries the series_id of each table entry, in table order', () => {
    const c = new Collector(DEFAULT_LIMITS, now)
    const series = [...many('up', 0, 40), ...many('cpu', 0, 40)]
    decodeRemoteWrite(writeRequest(series), c)
    const slots = Int32Array.from({ length: c.nSeries }, (_, i) => i % 3)
    for (const [, batches] of buildBatches(c, slots, 600)) {
      expect(batches.length).toBeGreaterThan(1)
      for (const b of batches) {
        const d = decodeVZB1(b.bytes)
        expect([...b.seriesIds]).toEqual(d.series.map((s) => s.id))
        expect(b.seriesIds.length).toBe(new DataView(b.bytes.buffer).getUint32(12, true))
        for (const s of d.series) expect(s.id).toBe(refSeriesId(s.labels))
      }
    }
    // Skipped series contribute no row and no table entry.
    const skip = new Uint8Array(c.nSeries)
    skip[3] = 1
    const rows = [...buildBatches(c, slots, 1 << 20, skip).values()].flat().reduce((a, b) => a + b.rows, 0)
    expect(rows).toBe(79)
    const ids = [...buildBatches(c, slots, 1 << 20, skip).values()].flat().flatMap((b) => [...b.seriesIds])
    expect(ids).not.toContain(c.seriesId(3))
    expect(ids).toHaveLength(79)
  })
})

describe('active-series limit', () => {
  it('reads limits:<tenant>, defaults to 1,000,000, and divides the limit evenly over the tenant\'s slots', async () => {
    const a = await tenantWith(null)
    expect(DEFAULT_ACTIVE_SERIES).toBe(1_000_000)
    expect(await activeSeriesLimit(env, a.tenant)).toBe(1_000_000)
    const b = await tenantWith(250)
    expect(await activeSeriesLimit(env, b.tenant)).toBe(250)
    for (const bad of ['{', '{"active_series":-1}', '{"active_series":"9"}', '{}']) {
      await env.CONFIG.put(`limits:${b.tenant}`, bad)
      clearCaches()
      expect(await activeSeriesLimit(env, b.tenant)).toBe(1_000_000) // never "no limit"
    }
    expect(shardShare(1_000_000, { pool: 'p', slots: 8, spread: 2, epoch: 1 }, 't')).toBe(500_000)
    expect(shardShare(10, { pool: 'p', slots: 3, spread: 3, epoch: 1 }, 't')).toBe(4)
    expect(shardShare(0, { pool: 'p', slots: 3, spread: 3, epoch: 1 }, 't')).toBe(0)
  })

  it('Remote Write: 429 naming the limit when new series do not fit; existing series are written, also at the limit', async () => {
    const t = await tenantWith(10)
    expect((await postWrite(t.key, many('up', 0, 8))).status).toBe(204)
    expect((await shardStub(t.map, 0).seriesCount(t.tenant)).count).toBe(8)

    // 5 series it already has + 5 new ones, room for 2.
    const mixed = many('up', 3, 13, now + 1)
    const r = await postWrite(t.key, mixed)
    expect(r.status).toBe(429)
    expect(r.headers.get('Retry-After')).toBe('60')
    expect(r.headers.get('X-Prometheus-Remote-Write-Samples-Written')).toBe('7')
    const text = await r.text()
    expect(text).toContain('active series limit reached: the limit is 10 active series per tenant (10 on each of its shards, 8 active on the fullest)')
    expect(text).toContain('3 new series with 3 samples refused')
    expect(text).toContain('7 samples written')
    // Exactly the first request and the 7 accepted series of the second are stored.
    expect(canon(await tail(t.map, t.tenant))).toEqual([...want(many('up', 0, 8)), ...want(many('up', 3, 10, now + 1))].sort())
    expect((await shardStub(t.map, 0).seriesCount(t.tenant)).count).toBe(10)

    // At the limit: every existing series keeps being accepted...
    expect((await postWrite(t.key, many('up', 0, 10, now + 2))).status).toBe(204)
    // ...a request of only new series is refused whole, and stores nothing...
    const before = (await tail(t.map, t.tenant)).length
    const full = await postWrite(t.key, many('other', 0, 4, now + 3))
    expect(full.status).toBe(429)
    expect(full.headers.get('X-Prometheus-Remote-Write-Samples-Written')).toBe('0')
    expect(await full.text()).toContain('4 new series with 4 samples refused')
    expect((await tail(t.map, t.tenant)).length).toBe(before)
    // ...and the sender's retry of the mixed request is refused the same way and stores nothing twice.
    const batches = (await tailOfSlot(t.map, 0, t.tenant)).batches.length
    expect((await postWrite(t.key, mixed)).status).toBe(429)
    expect((await tailOfSlot(t.map, 0, t.tenant)).batches.length).toBe(batches)
  })

  it('OTLP: 200 with partial_success counting the refused points and naming the limit', async () => {
    const t = await tenantWith(2)
    const str = (key: string, v: string) => ({ key, value: { stringValue: v } })
    const body = (queues: string[]) => otlpProto({
      resourceMetrics: [{
        resource: { attributes: [str('service.name', 'svc'), str('service.instance.id', 'i1')] },
        scopeMetrics: [{ metrics: [{ name: 'depth', gauge: { dataPoints: queues.map((q, i) => ({ timeUnixNano: String(BigInt(now) * 1_000_000n), asDouble: i, attributes: [str('queue', q)] })) } }] }],
      }],
    })
    const ok = await postOtlp(t.key, body(['a', 'b']), 'application/x-protobuf')
    expect(ok.status).toBe(200)
    expect((await ok.arrayBuffer()).byteLength).toBe(0)
    const res = await postOtlp(t.key, JSON.stringify({
      resourceMetrics: [{
        resource: { attributes: [str('service.name', 'svc'), str('service.instance.id', 'i1')] },
        scopeMetrics: [{ metrics: [{ name: 'depth', gauge: { dataPoints: ['a', 'c', 'd'].map((q, i) => ({ timeUnixNano: String(BigInt(now + 1) * 1_000_000n), asDouble: i, attributes: [str('queue', q)] })) } }] }],
      }],
    }), 'application/json')
    expect(res.status).toBe(200)
    const out = (await res.json()) as { partialSuccess: { rejectedDataPoints: string; errorMessage: string } }
    expect(out.partialSuccess.rejectedDataPoints).toBe('2')
    expect(out.partialSuccess.errorMessage).toContain('active series limit reached: the limit is 2 active series per tenant')
    expect(out.partialSuccess.errorMessage).toContain('2 new series with 2 samples refused')
    // The point of the existing series was stored.
    expect((await tail(t.map, t.tenant)).filter((s) => s.labels.queue === 'a')).toHaveLength(2)
    expect((await tail(t.map, t.tenant)).some((s) => s.labels.queue === 'c' || s.labels.queue === 'd')).toBe(false)
  })

  it('each shard enforces its share, and one tenant\'s limit does not touch another tenant in the same shards', async () => {
    const t = await tenantWith(4, 2) // 2 per shard
    const jobFor = (slot: number): string => {
      for (let i = 0; ; i++) if (slotFor(t.map, t.tenant, `job=job-${i}\u0000instance=a:1`) === slot) return `job-${i}`
    }
    const on = (slot: number, lo: number, hi: number) => Array.from({ length: hi - lo }, (_, k) => one('up', lo + k, now, jobFor(slot)))
    // Three series for slot 0 (one too many), one for slot 1.
    const r = await postWrite(t.key, [...on(0, 0, 3), ...on(1, 0, 1)])
    expect(r.status).toBe(429)
    expect(await r.text()).toContain('(2 on each of its shards')
    expect((await shardStub(t.map, 0).seriesCount(t.tenant)).count).toBe(2)
    expect((await shardStub(t.map, 1).seriesCount(t.tenant)).count).toBe(1)
    expect(canon(await tail(t.map, t.tenant))).toEqual([...want(on(0, 0, 2)), ...want(on(1, 0, 1))].sort())
    // Another tenant using the SAME shard objects is not limited by this one.
    const other = newTenant('lim-other')
    const otherKey = await makeKey(other)
    await setPool(other, t.map)
    clearCaches()
    expect((await postWrite(otherKey, many('up', 0, 50))).status).toBe(204)
  })

  it('a limit of zero refuses every series; no limits record means the default, which these requests are far below', async () => {
    const zero = await tenantWith(0)
    const r = await postWrite(zero.key, many('up', 0, 3))
    expect(r.status).toBe(429)
    expect((await tail(zero.map, zero.tenant)).length).toBe(0)
    const none = await tenantWith(null)
    expect((await postWrite(none.key, many('up', 0, 300))).status).toBe(204)
    expect((await shardStub(none.map, 0).seriesCount(none.tenant)).count).toBe(300)
  })
})
