/**
 * Test world for the end-to-end tests: two tenants that share one pool of two shards,
 * each sending a Remote Write request and an OTLP request through the edge Worker.
 */
import { runInDurableObject } from 'cloudflare:test'
import { env, exports } from 'cloudflare:workers'
import { type PoolMap, shardName, slotFor } from '../../shard/src/pool'
import { type PrwSeries, STALE_NAN, bitsOf, call, makeKey, otlpProto, setPool, snappyCompress, writeRequest } from '../../edge/test/helpers'
import { Sent, ledgerStub, shardStub } from '../../flush/test/helpers'
import type { Ledger } from '../../ledger/src/ledger'

let n = 0

export interface Tenant {
  name: string
  key: string
  sent: Sent
  /** The Remote Write request of this tenant, kept so it can be retried. */
  prw: PrwSeries[]
}

export interface World {
  map: PoolMap
  shards: string[]
  a: Tenant
  b: Tenant
  now: number
}

/** An instance name whose routing key lands on `slot` for this tenant. */
function instanceFor(map: PoolMap, tenant: string, job: string, slot: number, skip = 0): string {
  for (let i = 0; ; i++) {
    const inst = `10.0.0.${i}:9100`
    if (slotFor(map, tenant, `job=${job}\u0000instance=${inst}`) === slot && skip-- === 0) return inst
  }
}

export async function world(): Promise<World> {
  const id = `${Date.now().toString(36)}${n++}`
  // Sub-second timestamps differ per test, so nothing depends on the wall clock's digits.
  const now = Date.now()
  const map: PoolMap = { pool: `e2e-${id}`, slots: 2, spread: 2, epoch: 1 }
  const mk = async (prefix: string): Promise<Tenant> => {
    const name = `${prefix}-${id}`
    await setPool(name, map) // both tenants: the SAME pool, so they share both shard objects
    return { name, key: await makeKey(name), sent: new Sent(), prw: [] }
  }
  return { map, shards: [shardName(map, 0), shardName(map, 1)], a: await mk('tenant-a'), b: await mk('tenant-b'), now }
}

/** The Remote Write workload of one tenant: series on both slots, special values, shared label sets. */
export function prwWorkload(w: World, t: Tenant, valueBase: number, at = w.now, points = 6): PrwSeries[] {
  const out: PrwSeries[] = []
  for (const slot of [0, 1]) {
    for (const k of [0, 1]) {
      const instance = instanceFor(w.map, t.name, 'api', slot, k)
      for (const name of ['up', 'http_requests_total']) {
        out.push({
          labels: [['__name__', name], ['job', 'api'], ['instance', instance], ['owner', t.name], ['empty', '']],
          samples: Array.from({ length: points }, (_, i) => ({ ts: at - (points - 1 - i) * 15_000, value: valueBase + slot * 100 + k * 10 + i + (name === 'up' ? 0 : 0.5) })),
        })
      }
    }
    // A series whose labels are IDENTICAL in both tenants (same series_id): only the values differ.
    const shared = instanceFor(w.map, t.name, 'shared', slot)
    out.push({ labels: [['__name__', 'shared_metric'], ['job', 'shared'], ['instance', shared], ['slot', String(slot)]], samples: [{ ts: at - 1000, value: valueBase }, { ts: at, value: valueBase + 1 }] })
  }
  // Values that must survive bit for bit, on whichever slot they route to.
  out.push({
    labels: [['__name__', 'special_values'], ['job', 'api'], ['instance', instanceFor(w.map, t.name, 'api', 0)], ['owner', t.name]],
    samples: [
      { ts: at - 5000, value: STALE_NAN },
      { ts: at - 4000, value: 0x7ff8dead0000beefn },
      { ts: at - 3000, value: -0 },
      { ts: at - 2000, value: Infinity },
      { ts: at - 1000, value: 5e-324 },
    ],
  })
  return out
}

export function remember(t: Tenant, series: PrwSeries[]): void {
  for (const s of series) {
    const labels = Object.fromEntries(s.labels.filter(([, v]) => v !== ''))
    for (const x of s.samples) t.sent.add(labels, Number(x.ts), typeof x.value === 'bigint' ? x.value : bitsOf(x.value))
  }
}

const post = (path: string, key: string, body: BodyInit, headers: Record<string, string>): Promise<Response> =>
  exports.default.fetch(`https://edge.test${path}`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, ...headers }, body })

const PRW_HEADERS = { 'Content-Type': 'application/x-protobuf', 'Content-Encoding': 'snappy', 'X-Prometheus-Remote-Write-Version': '0.1.0' }

/** POST a Remote Write request through the stack's default export (the edge Worker). */
export async function sendPrw(t: Tenant, series: PrwSeries[]): Promise<Response> {
  const res = await post('/api/v1/write', t.key, snappyCompress(writeRequest(series)), PRW_HEADERS)
  if (res.status === 204) remember(t, series)
  return res
}

/** The same request with the edge's limits overridden, so it is cut into different batches. */
export async function sendPrwWithLimits(t: Tenant, series: PrwSeries[], limits: object): Promise<Response> {
  const res = await call('/api/v1/write', { method: 'POST', headers: { Authorization: `Bearer ${t.key}`, ...PRW_HEADERS }, body: snappyCompress(writeRequest(series)), env: { ...env, INGEST_LIMITS: JSON.stringify(limits) } })
  if (res.status === 204) remember(t, series)
  return res
}

const str = (key: string, v: string) => ({ key, value: { stringValue: v } })
const nanos = (ms: number) => String(BigInt(ms) * 1_000_000n)

/** POST an OTLP/HTTP protobuf request, and record what it must have become. */
export async function sendOtlp(w: World, t: Tenant, valueBase: number): Promise<Response> {
  const at = w.now
  const req = {
    resourceMetrics: [{
      resource: { attributes: [str('service.name', 'checkout'), str('service.namespace', 'shop'), str('service.instance.id', 'pod-1'), str('host.name', 'h1'), str('owner', t.name)] },
      scopeMetrics: [{
        scope: { name: 'lib' },
        metrics: [
          { name: 'queue.depth', gauge: { dataPoints: [
            { timeUnixNano: nanos(at - 2000), asDouble: valueBase + 0.25, attributes: [str('queue', 'q1')] },
            { timeUnixNano: nanos(at - 1000), asDouble: valueBase + 0.75, attributes: [str('queue', 'q1')] },
            { timeUnixNano: nanos(at - 1000), asInt: String(valueBase + 7), attributes: [str('queue', 'q2'), str('job', 'from-a-point')] },
            { timeUnixNano: nanos(at), flags: 1, attributes: [str('queue', 'q1')] }, // NO_RECORDED_VALUE → staleness marker
          ] } },
          { name: 'requests', sum: { aggregationTemporality: 2, isMonotonic: true, dataPoints: [
            { timeUnixNano: nanos(at - 1000), asInt: String(valueBase + 100), attributes: [str('code', '200')] },
            { timeUnixNano: nanos(at), asInt: String(valueBase + 101), attributes: [str('code', '200')] },
          ] } },
        ],
      }],
    }],
  }
  const res = await post('/v1/metrics', t.key, otlpProto(req), { 'Content-Type': 'application/x-protobuf' })
  if (res.status === 200) {
    const base = { job: 'shop/checkout', instance: 'pod-1', host_name: 'h1', owner: t.name }
    t.sent.add({ ...base, __name__: 'queue_depth', queue: 'q1' }, at - 2000, bitsOf(valueBase + 0.25))
    t.sent.add({ ...base, __name__: 'queue_depth', queue: 'q1' }, at - 1000, bitsOf(valueBase + 0.75))
    // The point attribute `job` cannot replace the routing label: it becomes `exported_job`.
    t.sent.add({ ...base, __name__: 'queue_depth', queue: 'q2', exported_job: 'from-a-point' }, at - 1000, bitsOf(valueBase + 7))
    t.sent.add({ ...base, __name__: 'queue_depth', queue: 'q1' }, at, STALE_NAN)
    t.sent.add({ ...base, __name__: 'requests_total', code: '200' }, at - 1000, bitsOf(valueBase + 100))
    t.sent.add({ ...base, __name__: 'requests_total', code: '200' }, at, bitsOf(valueBase + 101))
  }
  return res
}

/** Both tenants send their Remote Write and OTLP requests. */
export async function sendAll(w: World): Promise<void> {
  for (const [t, base] of [[w.a, 1000], [w.b, 2000]] as const) {
    t.prw = prwWorkload(w, t, base)
    const r = await sendPrw(t, t.prw)
    if (r.status !== 204) throw new Error(`remote write: ${r.status} ${await r.text()}`)
    const o = await sendOtlp(w, t, base)
    if (o.status !== 200) throw new Error(`otlp: ${o.status}`)
    const body = new Uint8Array(await o.arrayBuffer())
    if (body.length !== 0) throw new Error('otlp: unexpected partial_success')
  }
}

export const shardOf = (name: string) => shardStub(name)
export const ledgerOf = (t: Tenant) => ledgerStub(t.name)

/** Seal whatever each tenant has unsealed in each shard. Returns how many segments that made. */
export async function sealAll(w: World): Promise<number> {
  let k = 0
  for (const t of [w.a, w.b]) for (const s of w.shards) if (await shardOf(s).seal(t.name)) k++
  return k
}

/**
 * Run the ledger's drain now (what its alarm does about 200 ms after a commit). Inside the
 * object, so a drain that fails (a test broke the log) is reported here and not as an
 * unhandled rejection crossing the RPC boundary. Returns whether it wrote everything.
 */
export const drainLedger = (tenant: string): Promise<boolean> =>
  runInDurableObject(ledgerStub(tenant), (l: Ledger) => l.drain().then(() => true, () => false))

/**
 * Flush every (tenant, shard) through the stack's `Flush` entrypoint, over RPC, until each
 * run has told its shard `recorded` (`awaitingLog: false`). The ledger logs in the background
 * (contracts/LEDGER-LOG.md), so a run that admitted units ends `awaitingLog` and the flush
 * queue retries its message; here the drain runs at once and the flush is repeated, at most
 * five times (a ledger whose log is broken stays `awaitingLog`). Each result is the last
 * run's, with every segment as the run that first handled it saw it (as `flushSettled` in
 * flush/test/helpers.ts).
 */
export async function flushAll(w: World) {
  const out = []
  for (const t of [w.a, w.b]) {
    for (const s of w.shards) {
      let last = await exports.Flush.flushTenant(t.name, s)
      const seen = new Map(last.segments.map((g) => [g.seqLo, g]))
      let changed = last.changed
      for (let i = 0; i < 5 && last.status === 'ok' && last.awaitingLog; i++) {
        await drainLedger(t.name)
        last = await exports.Flush.flushTenant(t.name, s)
        changed ||= last.changed
        for (const g of last.segments) if (!seen.has(g.seqLo)) seen.set(g.seqLo, g)
      }
      out.push({ ...last, changed, segments: [...seen.values()].sort((a, b) => a.seqLo - b.seqLo) })
    }
  }
  return out
}
