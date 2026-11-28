/**
 * The review of D77 (design/reviews/d77-ingest-reservations.md), its reproductions as tests.
 *
 * M-1: a grant counts against D37's in-flight limits as one append of its largest batch (its
 * batches go one at a time), so a request of more batches, or more bytes, to one shard than those
 * limits is admitted on an idle shard, and two large requests can share a shard.
 * M-2: no grant outlives its request: after every outcome of a request (ok, 429, 503, the series
 * rounds, a stale epoch, a status this code does not know, a thrown append) the shards it routed
 * to hold no reservation.
 * m-4: the edge-side properties whose mutants survived the review's subset of the suite.
 */
import { env } from 'cloudflare:workers'
import { afterEach, describe, expect, it } from 'vitest'
import { type PoolMap, slotFor } from '../../shard/src/pool'
import { Shard } from '../../shard/src/shard'
import { clearCaches } from '../src/index'
import { MAX_BODY_BYTES, earlyStats, noteOutcome, planCost, refuseKnown } from '../src/early'
import { type Plan, clearMapCache } from '../src/route'
import { SpanCollector } from '../src/spans'
import { type PrwSeries, makeKey, newTenant, postWrite, setPool, shardStub } from './helpers'
import { type ResourceM, postSignal, signalPool, storedBatches, tracesProto } from './otelhelpers'

afterEach(() => clearCaches())

const NOW = BigInt(Date.now()) * 1_000_000n
const id = (n: number, len: number): Uint8Array => {
  const b = new Uint8Array(len)
  new DataView(b.buffer).setUint32(0, n + 1)
  b[len - 1] = 7
  return b
}

async function tenant(slots = 1, activeSeries?: number) {
  const t = newTenant('adm')
  const key = await makeKey(t)
  const map: PoolMap = { pool: `adm/${t}`, slots, spread: slots, epoch: 1 }
  await setPool(t, map)
  if (activeSeries !== undefined) await env.CONFIG.put(`limits:${t}`, JSON.stringify({ active_series: activeSeries }))
  clearCaches()
  return { tenant: t, key, map }
}

function servicesOn(map: PoolMap, t: string, slot: number, n: number): string[] {
  const out: string[] = []
  for (let i = 0; out.length < n; i++) if (slotFor(map, t, `job=svc-${i}\u0000instance=`) === slot) out.push(`svc-${i}`)
  return out
}

/** OTLP traces: `perService` spans with a `pad`-byte attribute (none for 0) under each service; `resource`: extra resource attributes. */
function traces(services: string[], perService: number, pad = 200, seed = 0, resource: [string, { s: string }][] = []): Uint8Array<ArrayBuffer> {
  let n = seed * 1_000_000
  const rs: ResourceM[] = services.map((svc) => ({
    attrs: [['service.name', { s: svc }], ...resource],
    scopes: [{ name: 'lib', spans: Array.from({ length: perService }, () => {
      n++
      return { traceId: id(n, 16), spanId: id(n, 8), name: 'op', start: NOW, end: NOW + 1000n, attrs: pad > 0 ? [['pad', { s: 'x'.repeat(pad) }]] : [] }
    }) }],
  }))
  return tracesProto(rs)
}

/** One resource of `traces()`: the same bytes for the same service, count, pad and seed. */
function resourceOf(svc: string, perService: number, pad: number, seed: number): ResourceM {
  let n = seed * 1_000_000
  return {
    attrs: [['service.name', { s: svc }]],
    scopes: [{ name: 'lib', spans: Array.from({ length: perService }, () => {
      n++
      return { traceId: id(n, 16), spanId: id(n, 8), name: 'op', start: NOW, end: NOW + 1000n, attrs: [['pad', { s: 'x'.repeat(pad) }]] }
    }) }],
  }
}

const PROTO = 'application/x-protobuf'
type Proto = { reserve: Shard['reserve']; append: Shard['append']; release: Shard['release'] }
const proto = Shard.prototype as unknown as Proto

/** Every shard of the pools holds no grant. */
async function noGrants(maps: PoolMap[]): Promise<void> {
  for (const m of maps) {
    for (let s = 0; s < m.slots; s++) expect(await shardStub(m, s).stats(), `${m.pool} slot ${s}`).toMatchObject({ reservations: 0, reservedBytes: 0 })
  }
}

describe('M-1: a grant is one append of its largest batch against the in-flight limits', () => {
  it('R1a: more batches to one shard than maxInFlight (a configured batch size of 16 KiB): accepted on an idle shard, every time', async () => {
    const t = await tenant(1)
    const spans = signalPool(t.map, 'traces')
    const body = traces(['svc-a'], 3000, 400)
    const opts = { env: { INGEST_LIMITS: JSON.stringify({ maxBatchBytes: 16_384 }) } }
    const statuses: number[] = []
    for (let i = 0; i < 3; i++) statuses.push((await postSignal('/v1/traces', t.key, body, PROTO, opts)).status)
    expect(statuses).toEqual([200, 200, 200])
    const stored = (await storedBatches(spans, t.tenant)).get(0)!.length
    expect(stored).toBeGreaterThan(64)
    expect(await shardStub(spans, 0).stats()).toMatchObject({ refusedOverload: 0, reservations: 0, inFlight: 0 })
  })

  it('R1b: default limits, a request whose batches to one shard exceed maxPendingBytes (a large resource entry repeated in every batch): accepted on an idle shard', async () => {
    const t = await tenant(1)
    const spans = signalPool(t.map, 'traces')
    const resource: [string, { s: string }][] = [0, 1, 2, 3].map((i) => [`big.${i}`, { s: String.fromCharCode(97 + i).repeat(62_000) }])
    const body = traces(['svc-a'], 140_000, 0, 0, resource)
    expect(body.byteLength).toBeLessThan(8 << 20)
    const res = await postSignal('/v1/traces', t.key, body, PROTO)
    expect(res.status, await res.clone().text()).toBe(200)
    const batches = (await storedBatches(spans, t.tenant)).get(0)!
    expect(batches.reduce((a, b) => a + b.byteLength, 0)).toBeGreaterThan(16 << 20)
    expect((await postSignal('/v1/traces', t.key, body, PROTO)).status).toBe(200)
    await noGrants([spans])
  })

  it('R1c: default limits, two concurrent large requests (about 8.5 MiB of batches each) to one shard, every append slowed by 20 ms: both accepted', async () => {
    const t = await tenant(1)
    const spans = signalPool(t.map, 'traces')
    const real = proto.append
    proto.append = async function (this: Shard, req) {
      await new Promise((r) => setTimeout(r, 20))
      return real.call(this, req)
    }
    try {
      const a = traces(['svc-a'], 17_000, 400, 1)
      const b = traces(['svc-a'], 17_000, 400, 2)
      const [ra, rb] = await Promise.all([postSignal('/v1/traces', t.key, a, PROTO), postSignal('/v1/traces', t.key, b, PROTO)])
      expect([ra.status, rb.status]).toEqual([200, 200])
    } finally {
      proto.append = real
    }
    expect(await shardStub(spans, 0).stats()).toMatchObject({ refusedOverload: 0, reservations: 0 })
  })
})

describe('M-2: no grant outlives its request', () => {
  it('R2: a metrics request at the active-series limit (series rounds, then 429): no grant is left, and another tenant is not refused for load', async () => {
    const t = await tenant(1, 10)
    const series: PrwSeries[] = Array.from({ length: 400 }, (_, i) => ({ labels: [['__name__', 'up'], ['job', 'api'], ['n', String(i)]], samples: [{ ts: Date.now(), value: i }] }))
    const res = await postWrite(t.key, series, { env: { INGEST_LIMITS: JSON.stringify({ maxBatchBytes: 4096 }) } })
    expect([200, 429, 503]).toContain(res.status)
    const st = await shardStub(t.map, 0).stats()
    expect(st).toMatchObject({ reservations: 0, reservedBytes: 0 })
    expect(st.reserved).toBeGreaterThanOrEqual(2)
    // The shard's in-flight limit at the number of grants the request had taken: with none left
    // held, another tenant's append is admitted.
    await shardStub(t.map, 0).configure({ maxInFlight: st.reserved! })
    const u = await tenant(1)
    const r = await shardStub(t.map, 0).append({ tenant: u.tenant, epoch: 1, fingerprint: 'other', payload: new Uint8Array(32), rows: 1 })
    expect(r.status).toBe('ok')
  })

  /** A two-shard tenant's multi-batch request with the `n`-th append replaced by `fault`. */
  async function withFault(fault: (real: Shard['append'], self: Shard, req: Parameters<Shard['append']>[0]) => Promise<unknown>, nth = 1) {
    const t = await tenant(2)
    const spans = signalPool(t.map, 'traces')
    const real = proto.append
    let calls = 0
    proto.append = async function (this: Shard, req) {
      if (calls++ === nth) return fault(real, this, req) as never
      return real.call(this, req)
    }
    try {
      const body = traces([...servicesOn(spans, t.tenant, 0, 2), ...servicesOn(spans, t.tenant, 1, 2)], 400, 400)
      const res = await postSignal('/v1/traces', t.key, body, PROTO, { env: { INGEST_LIMITS: JSON.stringify({ maxBatchBytes: 16_384 }) } })
      return { status: res.status, spans }
    } finally {
      proto.append = real
    }
  }

  it('after every outcome: ok, a thrown append, a stale epoch, an unknown status, overload, registering, and an `invalid`: the shards hold no grant', async () => {
    const ok = await withFault((real, self, req) => real.call(self, req))
    expect(ok.status).toBe(200)
    await noGrants([ok.spans])
    // Thrown after the shard took its batch out of the grant: the rest of the slot's grant stays unless edge releases it.
    const thrown = await withFault(async (real, self, req) => {
      await real.call(self, req)
      throw new Error('injected: connection lost')
    })
    expect(thrown.status).toBe(503)
    await noGrants([thrown.spans])
    for (const answer of [
      { status: 'stale_epoch', epoch: 1 },
      { status: 'from_a_newer_release' },
      { status: 'backpressure', scope: 'overload', retryAfterMs: 50 },
      { status: 'backpressure', scope: 'registering', retryAfterMs: 50 },
      { status: 'invalid', reason: 'injected' },
    ]) {
      const r = await withFault(async () => answer)
      expect(r.status, JSON.stringify(answer)).toBe(503)
      await noGrants([r.spans])
    }
  })

  it('a 429 at reserve: the shard that granted is released (and nothing is appended)', async () => {
    const t = await tenant(2)
    const spans = signalPool(t.map, 'traces')
    await shardStub(spans, 1).configure({ tenantMaxBytes: 1 })
    const body = traces([...servicesOn(spans, t.tenant, 0, 2), ...servicesOn(spans, t.tenant, 1, 2)], 400, 400)
    const res = await postSignal('/v1/traces', t.key, body, PROTO, { env: { INGEST_LIMITS: JSON.stringify({ maxBatchBytes: 16_384 }) } })
    expect(res.status).toBe(429)
    await noGrants([spans])
  })
})

describe('m-5: the refused-body cache is bounded by bytes', () => {
  const plan = (batches: number): Plan => ({ pool: 'p', epoch: 1, slots: [[0, Array.from({ length: batches }, (_, i) => ({ fingerprint: i.toString(16).padStart(64, '0'), bytes: 16_384 }))]] })
  const refused = (p: Plan) => ({ status: 'backpressure' as const, retryAfterMs: 1000, plan: p })

  it('plans of many small batches: what is remembered stays under MAX_BODY_BYTES, the oldest forgotten first', () => {
    clearCaches()
    const p = plan(500)
    for (let i = 0; i < 1000; i++) noteOutcome('t', 'traces', `k${i}`.padEnd(120, '.'), refused(p))
    const st = earlyStats()
    expect(st.bytes).toBeLessThanOrEqual(MAX_BODY_BYTES)
    expect(st.bodies).toBe(Math.floor(MAX_BODY_BYTES / planCost('k0'.padEnd(120, '.'), p)))
    expect(st.bodies).toBeLessThan(1000)
  })

  it('a plan larger than a sixteenth of the bound is not remembered; an accepted body is forgotten', () => {
    clearCaches()
    noteOutcome('t', 'traces', 'huge', refused(plan(5000)))
    expect(earlyStats()).toEqual({ bodies: 0, bytes: 0 })
    noteOutcome('t', 'traces', 'small', refused(plan(3)))
    expect(earlyStats().bodies).toBe(1)
    noteOutcome('t', 'traces', 'small', { status: 'ok', rows: 1, batches: 3 })
    expect(earlyStats()).toEqual({ bodies: 0, bytes: 0 })
  })
})

/** Count decodes of span bodies: a span decoder seals its collector once, at its end. */
function countDecodes(): { n: number; restore(): void } {
  const p = SpanCollector.prototype as unknown as { seal(): void }
  const real = p.seal
  const counter = { n: 0, restore: () => { p.seal = real } }
  p.seal = function (this: unknown) {
    counter.n++
    return real.call(this)
  }
  return counter
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('m-4: the review\'s surviving edge mutants, each pinned by a test', () => {
  it('R1: an append that throws counts as stored: a later refusal of the request (after a re-route) is 503, never 429', async () => {
    const t = await tenant(2)
    const spans = signalPool(t.map, 'traces')
    // Cache the map at epoch 1 in this isolate, then publish epoch 2.
    expect((await postSignal('/v1/traces', t.key, traces(servicesOn(spans, t.tenant, 0, 1), 2, 50, 9), PROTO)).status).toBe(200)
    await setPool(t.tenant, { ...t.map, epoch: 2 })
    const real = proto.append
    let threw = false
    proto.append = async function (this: Shard, req) {
      if (req.epoch === 1 && !threw) {
        threw = true
        await real.call(this, req)
        throw new Error('injected: the answer was lost')
      }
      if (req.epoch === 1) return { status: 'stale_epoch', epoch: 2 }
      return { status: 'backpressure', scope: 'tenant', retryAfterMs: 1000 }
    }
    try {
      const body = traces([...servicesOn(spans, t.tenant, 0, 2), ...servicesOn(spans, t.tenant, 1, 2)], 400, 400)
      const res = await postSignal('/v1/traces', t.key, body, PROTO, { env: { INGEST_LIMITS: JSON.stringify({ maxBatchBytes: 16_384 }) } })
      expect(threw).toBe(true)
      expect(res.status).toBe(503)
    } finally {
      proto.append = real
    }
  })

  it('R4: a duplicate is not counted as stored: a request whose only appended part was already stored, refused on the other shard, is 429', async () => {
    const t = await tenant(2)
    const spans = signalPool(t.map, 'traces')
    const a = servicesOn(spans, t.tenant, 0, 1)
    const b = servicesOn(spans, t.tenant, 1, 1)
    // The part for slot 0 is stored first, alone.
    expect((await postSignal('/v1/traces', t.key, traces(a, 20, 50, 1), PROTO)).status).toBe(200)
    const before = await storedBatches(spans, t.tenant)
    await shardStub(spans, 1).configure({ tenantMaxBytes: 1 })
    // Grants lost (the shards restarted between the calls): each append is checked as one without a token.
    const realR = proto.reserve
    proto.reserve = async () => ({ status: 'ok', token: 'forgotten', expiresInMs: 5000 })
    try {
      // Slot 0's batch is byte-identical to the one stored (a duplicate); slot 1 is refused for room.
      const body = tracesProto([...a.map((svc) => ({ svc, seed: 1 })), ...b.map((svc) => ({ svc, seed: 2 }))].map(({ svc, seed }) => resourceOf(svc, 20, 50, seed)))
      const res = await postSignal('/v1/traces', t.key, body, PROTO)
      expect(res.status).toBe(429)
    } finally {
      proto.reserve = realR
    }
    expect((await storedBatches(spans, t.tenant)).get(0)!.length).toBe(before.get(0)!.length)
  })

  it('R5: the series rounds give up after a part was stored: 503, never 429', async () => {
    const t = await tenant(2, 20) // a share of 10 per shard
    const a = servicesOn(t.map, t.tenant, 0, 1)[0]!
    const b = servicesOn(t.map, t.tenant, 1, 1)[0]!
    const at = Date.now()
    const series: PrwSeries[] = [
      ...Array.from({ length: 5 }, (_, i) => ({ labels: [['__name__', 'up'], ['job', a], ['n', String(i)]] as [string, string][], samples: [{ ts: at, value: i }] })),
      ...Array.from({ length: 400 }, (_, i) => ({ labels: [['__name__', 'up'], ['job', b], ['n', String(i)]] as [string, string][], samples: [{ ts: at, value: i }] })),
    ]
    const res = await postWrite(t.key, series, { env: { INGEST_LIMITS: JSON.stringify({ maxBatchBytes: 4096 }) } })
    expect(res.status, await res.clone().text()).toBe(503)
    await noGrants([t.map])
  })

  it('R2: a remembered body is decoded again when the tenant\'s map moved (another epoch), not refused on its old plan', async () => {
    const t = await tenant(2)
    const spans = signalPool(t.map, 'traces')
    for (const s of [0, 1]) await shardStub(spans, s).configure({ tenantMaxBytes: 1 })
    const body = traces([...servicesOn(spans, t.tenant, 0, 2), ...servicesOn(spans, t.tenant, 1, 2)], 20)
    for (let i = 0; i < 2; i++) expect((await postSignal('/v1/traces', t.key, body, PROTO)).status).toBe(429)
    await setPool(t.tenant, { ...t.map, epoch: 2 })
    clearMapCache() // the map only; the remembered body stays
    await wait(1100)
    const decodes = countDecodes()
    try {
      expect((await postSignal('/v1/traces', t.key, body, PROTO)).status).toBe(429)
      expect(decodes.n).toBe(1)
    } finally {
      decodes.restore()
    }
  })

  it('R3: the same bytes under another content encoding are not the remembered body', async () => {
    const t = await tenant(2)
    const spans = signalPool(t.map, 'traces')
    for (const s of [0, 1]) await shardStub(spans, s).configure({ tenantMaxBytes: 1 })
    const body = traces([...servicesOn(spans, t.tenant, 0, 2), ...servicesOn(spans, t.tenant, 1, 2)], 20)
    for (let i = 0; i < 2; i++) expect((await postSignal('/v1/traces', t.key, body, PROTO)).status).toBe(429)
    // Not gzip: decoded (and refused as a bad body), not refused as the remembered one.
    const res = await postSignal('/v1/traces', t.key, body, PROTO, { headers: { 'Content-Encoding': 'gzip' } })
    expect(res.status).toBe(400)
  })

  it('R6: an accepted body is forgotten: sent again, it is decoded without a probe', async () => {
    const t = await tenant(2)
    const spans = signalPool(t.map, 'traces')
    for (const s of [0, 1]) await shardStub(spans, s).configure({ tenantMaxBytes: 1 })
    const body = traces([...servicesOn(spans, t.tenant, 0, 2), ...servicesOn(spans, t.tenant, 1, 2)], 20)
    for (let i = 0; i < 2; i++) expect((await postSignal('/v1/traces', t.key, body, PROTO)).status).toBe(429)
    for (const s of [0, 1]) await shardStub(spans, s).configure({ tenantMaxBytes: 64 << 20 })
    await wait(1100)
    expect((await postSignal('/v1/traces', t.key, body, PROTO)).status).toBe(200)
    const realR = proto.reserve
    let probes = 0
    proto.reserve = async function (this: Shard, req) {
      if (req.hold === false) probes++
      return realR.call(this, req)
    }
    try {
      expect((await postSignal('/v1/traces', t.key, body, PROTO)).status).toBe(200)
      expect(probes).toBe(0)
    } finally {
      proto.reserve = realR
    }
  })

  it('R8: a probe answered `overload` is a 503 at once, not a decode', async () => {
    const t = await tenant(2)
    const spans = signalPool(t.map, 'traces')
    for (const s of [0, 1]) await shardStub(spans, s).configure({ tenantMaxBytes: 1 })
    const body = traces([...servicesOn(spans, t.tenant, 0, 2), ...servicesOn(spans, t.tenant, 1, 2)], 20)
    for (let i = 0; i < 2; i++) expect((await postSignal('/v1/traces', t.key, body, PROTO)).status).toBe(429)
    for (const s of [0, 1]) await shardStub(spans, s).configure({ tenantMaxBytes: 64 << 20 })
    await wait(1100)
    const realR = proto.reserve
    proto.reserve = async function (this: Shard, req) {
      if (req.hold === false) return { status: 'backpressure', scope: 'overload', retryAfterMs: 700 }
      return realR.call(this, req)
    }
    const decodes = countDecodes()
    try {
      const res = await postSignal('/v1/traces', t.key, body, PROTO)
      expect(res.status).toBe(503)
      expect(decodes.n).toBe(0)
    } finally {
      decodes.restore()
      proto.reserve = realR
    }
  })

  it('R9: inside its Retry-After, an early refusal answers what is left of the Retry-After the shards gave, not a fixed second', async () => {
    clearCaches()
    const plan: Plan = { pool: 'p', epoch: 1, slots: [[0, [{ fingerprint: 'f'.repeat(64), bytes: 10 }]]] }
    noteOutcome('t-r9', 'traces', 'k-r9', { status: 'backpressure', retryAfterMs: 5000, plan })
    const r = await refuseKnown(env as never, 't-r9', 'traces', 'k-r9')
    expect(r?.status).toBe('backpressure')
    expect(r!.retryAfterMs).toBeGreaterThan(4000)
    expect(r!.retryAfterMs).toBeLessThanOrEqual(5000)
  })
})
