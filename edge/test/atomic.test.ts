/**
 * A request refused with 429 stores nothing (D77; spikes/s10-signals-trial/README.md, "A request
 * refused at the end can be partly stored"), and a retry of a body this isolate saw refused is
 * refused before it is decoded ("A 429 costs edge a full decode").
 *
 * The shapes are S10's: a tenant whose spans (or log records, or series) go to two shards, one of
 * which has room and one of which is full; and a sender that retries the same body.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { type PoolMap, slotFor } from '../../shard/src/pool'
import { clearCaches } from '../src/index'
import { Shard } from '../../shard/src/shard'
import { SpanCollector } from '../src/spans'
import { LogCollector } from '../src/logs'
import { Collector } from '../src/batch'
import { type PrwSeries, makeKey, newTenant, postWrite, setPool, shardStub } from './helpers'
import { type ResourceM, lokiProto, postSignal, signalPool, storedBatches, tracesProto } from './otelhelpers'

afterEach(() => clearCaches())

const NOW = BigInt(Date.now()) * 1_000_000n
const id = (n: number, len: number): Uint8Array => {
  const b = new Uint8Array(len)
  new DataView(b.buffer).setUint32(0, n + 1)
  b[len - 1] = 7
  return b
}

/** A tenant with its own pool of `slots` shards. */
async function tenant(slots = 2) {
  const t = newTenant('atm')
  const key = await makeKey(t)
  const map: PoolMap = { pool: `atm/${t}`, slots, spread: slots, epoch: 1 }
  await setPool(t, map)
  clearCaches()
  return { tenant: t, key, map }
}

/** Services whose routing keys (job = service.name, instance empty) land on `slot` of `map`, for `tenant`. */
function servicesOn(map: PoolMap, tenant: string, slot: number, n: number): string[] {
  const out: string[] = []
  for (let i = 0; out.length < n; i++) if (slotFor(map, tenant, `job=svc-${i}\u0000instance=`) === slot) out.push(`svc-${i}`)
  return out
}

/** OTLP traces: `perService` spans of `pad` bytes of attribute under each service. */
function traces(services: string[], perService: number, pad = 200, seed = 0): Uint8Array<ArrayBuffer> {
  let n = seed * 1_000_000
  const rs: ResourceM[] = services.map((svc) => ({
    attrs: [['service.name', { s: svc }]],
    scopes: [{ name: 'lib', spans: Array.from({ length: perService }, () => {
      n++
      return { traceId: id(n, 16), spanId: id(n, 8), name: 'op', start: NOW, end: NOW + 1000n, attrs: [['pad', { s: 'x'.repeat(pad) }]] }
    }) }],
  }))
  return tracesProto(rs)
}

/** Stored batches of the tenant, per slot, in a pool. */
async function storedCount(map: PoolMap, tenant: string): Promise<number[]> {
  const by = await storedBatches(map, tenant)
  return Array.from({ length: map.slots }, (_, s) => by.get(s)?.length ?? 0)
}

/** Count decodes: every decoder seals its collector once, at its end. */
function countDecodes(): { n: number; restore(): void } {
  const protos = [SpanCollector.prototype, LogCollector.prototype] as unknown as { seal(): void }[]
  const real = protos.map((p) => p.seal)
  const counter = {
    n: 0,
    restore() {
      protos.forEach((p, i) => (p.seal = real[i]!))
      ;(Collector.prototype as unknown as { addSeries: unknown }).addSeries = realAdd
    },
  }
  protos.forEach((p, i) => {
    p.seal = function (this: unknown) {
      counter.n++
      return real[i]!.call(this)
    }
  })
  // Metrics have no seal: count the first series added by each collector.
  const cp = Collector.prototype as unknown as { addSeries(...a: unknown[]): number }
  const realAdd = cp.addSeries
  const seen = new WeakSet<object>()
  cp.addSeries = function (this: object, ...a: unknown[]) {
    if (!seen.has(this)) {
      seen.add(this)
      counter.n++
    }
    return realAdd.apply(this, a)
  }
  return counter
}

describe('defect 1: a 429 stores nothing (two shards, one full)', () => {
  it('OTLP traces: one shard full, the other with room: 429 and neither shard holds a batch of the request', async () => {
    const t = await tenant(2)
    const spans = signalPool(t.map, 'traces')
    await shardStub(spans, 1).configure({ tenantMaxBytes: 1 })
    const body = traces([...servicesOn(spans, t.tenant, 0, 3), ...servicesOn(spans, t.tenant, 1, 3)], 20)
    const res = await postSignal('/v1/traces', t.key, body, 'application/x-protobuf')
    expect(res.status).toBe(429)
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThanOrEqual(1)
    expect(await storedCount(spans, t.tenant)).toEqual([0, 0])
    // Once the full shard has room, the same request is stored whole, once.
    await shardStub(spans, 1).configure({ tenantMaxBytes: 64 << 20 })
    clearCaches()
    expect((await postSignal('/v1/traces', t.key, body, 'application/x-protobuf')).status).toBe(200)
    expect((await postSignal('/v1/traces', t.key, body, 'application/x-protobuf')).status).toBe(200)
    expect(await storedCount(spans, t.tenant)).toEqual([1, 1])
  })

  it('OTLP traces, one shard, several batches: the buffer has room for the first batch only: 429 and nothing stored', async () => {
    const t = await tenant(1)
    const spans = signalPool(t.map, 'traces')
    // Batches of at most 16 KiB; room for about one.
    await shardStub(spans, 0).configure({ tenantMaxBytes: 20_000 })
    const body = traces(['svc-a'], 200, 400)
    const res = await postSignal('/v1/traces', t.key, body, 'application/x-protobuf', { env: { INGEST_LIMITS: JSON.stringify({ maxBatchBytes: 16_384 }) } })
    expect(res.status).toBe(429)
    expect(await storedCount(spans, t.tenant)).toEqual([0])
  })

  it('Loki push: one log shard full: 429 and nothing stored', async () => {
    const t = await tenant(2)
    const logs = signalPool(t.map, 'logs')
    await shardStub(logs, 0).configure({ tenantMaxBytes: 1 })
    const jobs = [...servicesOn(logs, t.tenant, 0, 2), ...servicesOn(logs, t.tenant, 1, 2)]
    const body = lokiProto(jobs.map((j) => ({ labels: `{job="${j}"}`, entries: Array.from({ length: 10 }, (_, i) => ({ ts: NOW + BigInt(i), line: `line ${i} of ${j}` })) })))
    const res = await postSignal('/loki/api/v1/push', t.key, body, 'application/x-protobuf')
    expect(res.status, await res.clone().text()).toBe(429)
    expect(await storedCount(logs, t.tenant)).toEqual([0, 0])
  })

  it('Remote Write: one metric shard full: 429 and nothing stored', async () => {
    const t = await tenant(2)
    await shardStub(t.map, 1).configure({ tenantMaxBytes: 1 })
    const jobs = [...servicesOn(t.map, t.tenant, 0, 2), ...servicesOn(t.map, t.tenant, 1, 2)]
    const series: PrwSeries[] = jobs.map((j) => ({ labels: [['__name__', 'up'], ['job', j]], samples: [{ ts: Date.now(), value: 1 }] }))
    const res = await postWrite(t.key, series)
    expect(res.status).toBe(429)
    expect(await storedCount(t.map, t.tenant)).toEqual([0, 0])
  })
})

describe('defect 2: a refused retry is not decoded again', () => {
  it('the same traces body sent while the buffer is full: decoded on its first refusals only, then refused before decoding, with the shard\'s Retry-After', async () => {
    const t = await tenant(2)
    const spans = signalPool(t.map, 'traces')
    for (const s of [0, 1]) await shardStub(spans, s).configure({ tenantMaxBytes: 1 })
    const body = traces([...servicesOn(spans, t.tenant, 0, 2), ...servicesOn(spans, t.tenant, 1, 2)], 20)
    const decodes = countDecodes()
    try {
      const statuses: number[] = []
      for (let i = 0; i < 5; i++) {
        const res = await postSignal('/v1/traces', t.key, body, 'application/x-protobuf')
        statuses.push(res.status)
        expect(Number(res.headers.get('Retry-After'))).toBeGreaterThanOrEqual(1)
      }
      expect(statuses).toEqual([429, 429, 429, 429, 429])
      expect(decodes.n).toBeLessThanOrEqual(2)
    } finally {
      decodes.restore()
    }
  })
})


describe('D77: what is left after a refusal, and when 429 may not be said', () => {
  it('the shard that granted room gets it back when another refuses: no grant is left held', async () => {
    const t = await tenant(2)
    const spans = signalPool(t.map, 'traces')
    await shardStub(spans, 1).configure({ tenantMaxBytes: 1 })
    const body = traces([...servicesOn(spans, t.tenant, 0, 3), ...servicesOn(spans, t.tenant, 1, 3)], 20)
    expect((await postSignal('/v1/traces', t.key, body, 'application/x-protobuf')).status).toBe(429)
    expect(await shardStub(spans, 0).stats()).toMatchObject({ reservations: 0, reservedBytes: 0, reserved: 1 })
  })

  it('a grant lost between the two calls (a shard restarted), then refused at append after the other shard stored its part: 503, never 429', async () => {
    const t = await tenant(2)
    const spans = signalPool(t.map, 'traces')
    await shardStub(spans, 1).configure({ tenantMaxBytes: 1 })
    const proto = Shard.prototype as unknown as { reserve: Shard['reserve'] }
    const real = proto.reserve
    proto.reserve = async () => ({ status: 'ok', token: 'forgotten', expiresInMs: 5000 })
    try {
      const body = traces([...servicesOn(spans, t.tenant, 0, 3), ...servicesOn(spans, t.tenant, 1, 3)], 20)
      const res = await postSignal('/v1/traces', t.key, body, 'application/x-protobuf')
      expect(res.status).toBe(503)
      expect(Number(res.headers.get('Retry-After'))).toBeGreaterThanOrEqual(1)
      expect(await res.text()).toContain('retry the whole request')
      expect(await storedCount(spans, t.tenant)).toEqual([1, 0])
    } finally {
      proto.reserve = real
    }
  })

  it('a shard of a release without `reserve` (skew during a deploy): requests are appended as before; a refusal after a stored part is 503', async () => {
    const t = await tenant(2)
    const spans = signalPool(t.map, 'traces')
    const proto = Shard.prototype as unknown as { reserve?: Shard['reserve'] }
    const real = proto.reserve
    delete proto.reserve
    try {
      const body = traces([...servicesOn(spans, t.tenant, 0, 3), ...servicesOn(spans, t.tenant, 1, 3)], 20)
      expect((await postSignal('/v1/traces', t.key, body, 'application/x-protobuf')).status).toBe(200)
      await shardStub(spans, 1).configure({ tenantMaxBytes: 1 })
      const res = await postSignal('/v1/traces', t.key, traces([...servicesOn(spans, t.tenant, 0, 3), ...servicesOn(spans, t.tenant, 1, 3)], 20, 200, 1), 'application/x-protobuf')
      expect(res.status).toBe(503)
    } finally {
      proto.reserve = real
    }
  })

  it('a request of one batch is appended without reserving (no extra call), and a 429 for it stored nothing', async () => {
    const t = await tenant(2)
    const spans = signalPool(t.map, 'traces')
    const proto = Shard.prototype as unknown as { reserve: Shard['reserve'] }
    const real = proto.reserve
    let calls = 0
    proto.reserve = async function (this: Shard, req) {
      calls++
      return real.call(this, req)
    }
    try {
      const one = traces(servicesOn(spans, t.tenant, 0, 1), 3)
      expect((await postSignal('/v1/traces', t.key, one, 'application/x-protobuf')).status).toBe(200)
      expect(calls).toBe(0)
      await shardStub(spans, 0).configure({ tenantMaxBytes: 1 })
      expect((await postSignal('/v1/traces', t.key, traces(servicesOn(spans, t.tenant, 0, 1), 3, 200, 1), 'application/x-protobuf')).status).toBe(429)
      expect(await storedCount(spans, t.tenant)).toEqual([1, 0])
      expect(calls).toBe(0)
    } finally {
      proto.reserve = real
    }
  })
})

describe('D77: refusing before decoding is never longer than the shard said, and only for the body it refused', () => {
  it('inside the Retry-After: refused without asking a shard; after it, with room: decoded, appended, 200', async () => {
    const t = await tenant(2)
    const spans = signalPool(t.map, 'traces')
    for (const s of [0, 1]) await shardStub(spans, s).configure({ tenantMaxBytes: 1 })
    const body = traces([...servicesOn(spans, t.tenant, 0, 2), ...servicesOn(spans, t.tenant, 1, 2)], 20)
    expect((await postSignal('/v1/traces', t.key, body, 'application/x-protobuf')).status).toBe(429) // marks the tenant
    expect((await postSignal('/v1/traces', t.key, body, 'application/x-protobuf')).status).toBe(429) // remembered
    const proto = Shard.prototype as unknown as { reserve: Shard['reserve']; append: Shard['append'] }
    const [realR, realA] = [proto.reserve, proto.append]
    let calls = 0
    proto.reserve = async function (this: Shard, req) {
      calls++
      return realR.call(this, req)
    }
    proto.append = async function (this: Shard, req) {
      calls++
      return realA.call(this, req)
    }
    try {
      const inside = await postSignal('/v1/traces', t.key, body, 'application/x-protobuf')
      expect(inside.status).toBe(429)
      expect(Number(inside.headers.get('Retry-After'))).toBe(1)
      expect(calls).toBe(0)
      for (const s of [0, 1]) await shardStub(spans, s).configure({ tenantMaxBytes: 64 << 20 })
      await new Promise((r) => setTimeout(r, 1100))
      const decodes = countDecodes()
      try {
        expect((await postSignal('/v1/traces', t.key, body, 'application/x-protobuf')).status).toBe(200)
        expect(decodes.n).toBe(1)
      } finally {
        decodes.restore()
      }
      expect(await storedCount(spans, t.tenant)).toEqual([1, 1])
      // The probe held nothing, and the request used up its grants.
      for (const s of [0, 1]) expect(await shardStub(spans, s).stats()).toMatchObject({ reservations: 0, reservedBytes: 0 })
    } finally {
      proto.reserve = realR
      proto.append = realA
    }
  })

  it('after the Retry-After, still full: the probe holds nothing and refuses with the shard\'s Retry-After, without decoding', async () => {
    const t = await tenant(2)
    const spans = signalPool(t.map, 'traces')
    for (const s of [0, 1]) await shardStub(spans, s).configure({ tenantMaxBytes: 1 })
    const body = traces([...servicesOn(spans, t.tenant, 0, 2), ...servicesOn(spans, t.tenant, 1, 2)], 20)
    for (let i = 0; i < 2; i++) expect((await postSignal('/v1/traces', t.key, body, 'application/x-protobuf')).status).toBe(429)
    await new Promise((r) => setTimeout(r, 1100))
    const decodes = countDecodes()
    try {
      const res = await postSignal('/v1/traces', t.key, body, 'application/x-protobuf')
      expect(res.status).toBe(429)
      expect(Number(res.headers.get('Retry-After'))).toBe(1)
      expect(decodes.n).toBe(0)
    } finally {
      decodes.restore()
    }
    for (const s of [0, 1]) expect(await shardStub(spans, s).stats()).toMatchObject({ reservations: 0, reservedBytes: 0 })
  })

  it('another body of a refused tenant, and any body of another tenant, is decoded and appended as usual', async () => {
    const t = await tenant(2)
    const u = await tenant(2)
    const spans = signalPool(t.map, 'traces')
    await shardStub(spans, 1).configure({ tenantMaxBytes: 1 })
    const body = traces([...servicesOn(spans, t.tenant, 0, 2), ...servicesOn(spans, t.tenant, 1, 2)], 20)
    for (let i = 0; i < 2; i++) expect((await postSignal('/v1/traces', t.key, body, 'application/x-protobuf')).status).toBe(429)
    // Another body of t that goes only to the shard with room: accepted.
    expect((await postSignal('/v1/traces', t.key, traces(servicesOn(spans, t.tenant, 0, 2), 5, 200, 2), 'application/x-protobuf')).status).toBe(200)
    // The same bytes from another tenant: its own shards, decoded and accepted.
    const uSpans = signalPool(u.map, 'traces')
    expect((await postSignal('/v1/traces', u.key, body, 'application/x-protobuf')).status).toBe(200)
    expect((await storedCount(uSpans, u.tenant)).reduce((a, b) => a + b)).toBeGreaterThan(0)
  })

  it('Remote Write: a refused body sent again is refused before decoding too', async () => {
    const t = await tenant(2)
    for (const s of [0, 1]) await shardStub(t.map, s).configure({ tenantMaxBytes: 1 })
    const jobs = [...servicesOn(t.map, t.tenant, 0, 2), ...servicesOn(t.map, t.tenant, 1, 2)]
    const series: PrwSeries[] = jobs.map((j) => ({ labels: [['__name__', 'up'], ['job', j]], samples: [{ ts: Date.now(), value: 1 }] }))
    const decodes = countDecodes()
    try {
      for (let i = 0; i < 4; i++) expect((await postWrite(t.key, series)).status).toBe(429)
      expect(decodes.n).toBe(2)
    } finally {
      decodes.restore()
    }
  })
})
