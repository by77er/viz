/**
 * Test world: two tenants that share one pool of two shards. Each sends the workload of
 * `fixtures/workload.json` as real Remote Write requests through the edge Worker, and
 * queries go through the query Worker over HTTP. `fixtures/expected.json` holds what
 * every query must return (see tools/gen-fixtures.mjs).
 */
import { runDurableObjectAlarm } from 'cloudflare:test'
import { env, exports } from 'cloudflare:workers'
import { type PrwSeries, STALE_NAN, makeKey, setPool, snappyCompress, writeRequest } from '../../edge/test/helpers'
import type { Ledger } from '../../ledger/src/ledger'
import { type PoolMap, shardName, slotFor } from '../../shard/src/pool'
import type { Shard } from '../../shard/src/shard'
import expectedJson from './fixtures/expected.json'
import workloadJson from './fixtures/workload.json'

export type Value = number | 'stale' | 'NaN' | '+Inf' | '-Inf'
export interface WSeries {
  labels: Record<string, string>
  samples: [number, Value][]
}
export interface Query {
  id: string
  kind: 'range' | 'instant'
  query: string
  start?: number
  end?: number
  step?: number
  time?: number
}
export type Envelope = { status: 'success'; data: unknown } | { status: 'error'; errorType: string; error: string }

export const workload = workloadJson as unknown as { t0: number; end: number; stepMs: number; cut: number; requests: Record<'a' | 'b', WSeries[][]>; queries: Query[] }
export const expected = expectedJson as unknown as Record<'a' | 'b', Record<string, Envelope>>
export const QUERIES = workload.queries

export interface Tenant {
  which: 'a' | 'b'
  name: string
  /** A key with the `read` and `write` scopes. */
  key: string
}
export interface World {
  map: PoolMap
  shards: string[]
  a: Tenant
  b: Tenant
}

const tenantName = (which: 'a' | 'b', id: string): string => `tenant-${which}-${id}`
const mapOf = (id: string, slots: number): PoolMap => ({ pool: `q-${id}`, slots, spread: slots, epoch: 1 })

/** The routing keys of a tenant's workload, as edge builds them (`edge/src/batch.ts`: job and instance). */
const routingKeys = (which: 'a' | 'b'): string[] => [
  ...new Set(workload.requests[which].flat().map((s) => `job=${s.labels.job ?? ''}\u0000instance=${s.labels.instance ?? ''}`)),
]

/**
 * Whether both tenants' senders reach every shard of a two-shard world made with this id.
 * A sender's shard is a hash of the tenant's name and the sender's routing key
 * (`shard/src/pool.ts` `slotFor`), and the name holds the id, which comes from the clock: for
 * 0.78% of ids (1,558 of 200,000 tried) one tenant's nine senders all land in one shard, and
 * every test that says "both tenants have a stream in both shards" then fails. That happened
 * once in CI on pull request #9 (`invariance.test.ts`, `nextSeq` undefined). `world()` skips
 * such ids. Worlds of one shard, or of more than two, are not constrained.
 */
export function reachesBothShards(id: string): boolean {
  const map = mapOf(id, 2)
  return (['a', 'b'] as const).every((which) => new Set(routingKeys(which).map((k) => slotFor(map, tenantName(which, id), k))).size === 2)
}

/** The first of `next()`'s ids a world of `slots` shards may use: for two shards, one that reaches both. */
export function pickId(next: () => string, slots: number): string {
  let id = next()
  while (slots === 2 && !reachesBothShards(id)) id = next()
  return id
}

let n = 0
export async function world(slots = 2): Promise<World> {
  const id = pickId(() => `${Date.now().toString(36)}${n++}`, slots)
  const map = mapOf(id, slots)
  const mk = async (which: 'a' | 'b'): Promise<Tenant> => {
    const name = tenantName(which, id)
    await setPool(name, map) // both tenants: the SAME pool, so they share every shard object
    return { which, name, key: await makeKey(name, { scopes: ['read', 'write'] }) }
  }
  return { map, shards: Array.from({ length: slots }, (_, i) => shardName(map, i)), a: await mk('a'), b: await mk('b') }
}

const BITS: Record<string, bigint> = { stale: STALE_NAN, NaN: 0x7ff8000000000000n, '+Inf': 0x7ff0000000000000n, '-Inf': 0xfff0000000000000n }

export const toPrw = (series: WSeries[]): PrwSeries[] =>
  series.map((s) => ({ labels: Object.entries(s.labels), samples: s.samples.map(([ts, v]) => ({ ts, value: typeof v === 'number' ? v : BITS[v]! })) }))

/** POST a Remote Write request through the script's default export (the edge Worker). */
export async function write(t: Tenant, series: WSeries[]): Promise<void> {
  const res = await exports.default.fetch('https://viz.test/api/v1/write', {
    method: 'POST',
    headers: { Authorization: `Bearer ${t.key}`, 'Content-Type': 'application/x-protobuf', 'Content-Encoding': 'snappy', 'X-Prometheus-Remote-Write-Version': '0.1.0' },
    body: snappyCompress(writeRequest(toPrw(series))),
  })
  if (res.status !== 204) throw new Error(`remote write: ${res.status} ${await res.text()}`)
}

export const shardOf = (name: string): DurableObjectStub<Shard> => env.SHARD.get(env.SHARD.idFromName(name))
export const ledgerOf = (t: Tenant): DurableObjectStub<Ledger> => env.LEDGER.get(env.LEDGER.idFromName(t.name))

/** Seal whatever each tenant has unsealed in each shard. */
export async function sealAll(w: World, tenants = [w.a, w.b]): Promise<void> {
  for (const t of tenants) for (const s of w.shards) await shardOf(s).seal(t.name)
}

/** Flush every sealed segment of every (tenant, shard) through the `Flush` entrypoint. */
export async function flushAll(w: World, tenants = [w.a, w.b]): Promise<void> {
  for (const t of tenants) {
    for (const s of w.shards) {
      let r = await exports.Flush.flushTenant(t.name, s)
      if (r.status !== 'ok') throw new Error(`flush ${t.name} ${s}: ${JSON.stringify(r)}`)
      // The shard is told `recorded` only up to the ledger's LOGGED watermark (flush step 6),
      // which moves when the ledger's alarm drains its outbox to the R2 log. Do what that
      // alarm would do, and flush again so the shard learns it (and may discard).
      for (let i = 0; i < 3 && r.awaitingLog; i++) {
        await runDurableObjectAlarm(ledgerOf(t))
        r = await exports.Flush.flushTenant(t.name, s)
        if (r.status !== 'ok') throw new Error(`flush ${t.name} ${s}: ${JSON.stringify(r)}`)
      }
      if (r.awaitingLog) throw new Error(`flush ${t.name} ${s}: the ledger's log did not catch up`)
    }
  }
}

/** Let every shard discard what is recorded (retention 0), as its alarm would later. */
export async function discardAll(w: World): Promise<void> {
  for (const s of w.shards) {
    await shardOf(s).configure({ retainRecordedMs: 0 })
    await runDurableObjectAlarm(shardOf(s))
  }
}

/** The whole workload: first request, a seal, second request (which overlaps and rewrites part of the first). */
export async function ingest(w: World, tenants = [w.a, w.b]): Promise<void> {
  for (const t of tenants) await write(t, workload.requests[t.which][0]!)
  await sealAll(w, tenants)
  for (const t of tenants) await write(t, workload.requests[t.which][1]!)
}

export interface CallOptions {
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
}

/** One API call over HTTP, as a client makes it. Parameters may repeat (`[['match[]', 'up'], …]`). */
export function api(key: string | null, path: string, params: Record<string, string | number> | [string, string][] = {}, opts: CallOptions = {}): Promise<Response> {
  const list: [string, string][] = Array.isArray(params) ? params : Object.entries(params).map(([k, v]) => [k, String(v)])
  const qs = new URLSearchParams(list).toString()
  const headers: Record<string, string> = { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...opts.headers }
  if (opts.method === 'POST') {
    return exports.default.fetch(`https://viz.test${path}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers }, body: qs })
  }
  return exports.default.fetch(`https://viz.test${path}${qs ? `?${qs}` : ''}`, { headers })
}

const seconds = (ms: number): string => (ms / 1000).toFixed(3)

/** Run one query of the table over HTTP. */
export function run(key: string, q: Query, opts: CallOptions = {}): Promise<Response> {
  return q.kind === 'range'
    ? api(key, '/api/v1/query_range', { query: q.query, start: seconds(q.start!), end: seconds(q.end!), step: seconds(q.step!) }, opts)
    : api(key, '/api/v1/query', { query: q.query, time: seconds(q.time!) }, opts)
}

export const cost = (res: Response, name: string): number => Number(res.headers.get(`X-Viz-${name}`))

/** Series of a tenant's workload with at least one sample in `[start, end]`. */
export function seriesIn(which: 'a' | 'b', start = 0, end = Number.MAX_SAFE_INTEGER): Record<string, string>[] {
  const seen = new Map<string, Record<string, string>>()
  for (const req of workload.requests[which]) {
    for (const s of req) {
      if (s.samples.some(([ts]) => ts >= start && ts <= end)) seen.set(JSON.stringify(Object.entries(s.labels).sort()), s.labels)
    }
  }
  return [...seen.values()]
}
