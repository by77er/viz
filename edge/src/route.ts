import { type PoolMap, shardName, slotFor } from '../../shard/src/pool'
import type { AppendResult, Shard } from '../../shard/src/shard'
import { type Batch, buildBatches, type Collector } from './batch'
import { HttpError } from './errors'

/**
 * Routing and append: rows → one or more `VZB1` batches per shard slot → `Shard.append`.
 *
 * The request is acknowledged only if every batch of every slot was appended. Anything
 * else is a retryable refusal of the whole request; batch fingerprints (SHA-256 of the
 * batch bytes) make the sender's full retry idempotent on the slots that had succeeded.
 */

export interface RouteEnv {
  SHARD: DurableObjectNamespace<Shard>
  CONFIG: KVNamespace
  DEFAULT_POOL?: string
}

export type Outcome =
  | { status: 'ok'; rows: number; batches: number }
  | { status: 'backpressure'; retryAfterMs: number }
  | { status: 'unavailable'; reason: string }

const MAP_TTL_MS = 30_000
const MAX_CACHE = 10_000
const maps = new Map<string, { map: PoolMap; expires: number }>()

export function clearMapCache(): void {
  maps.clear()
}

function parseMap(v: unknown): PoolMap | null {
  if (!v || typeof v !== 'object') return null
  const m = v as Record<string, unknown>
  const int = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x)
  if (typeof m.pool !== 'string' || m.pool === '') return null
  if (!int(m.slots) || m.slots < 1 || m.slots > 4096) return null
  if (!int(m.spread) || m.spread < 1) return null
  if (!int(m.epoch) || m.epoch < 0) return null
  return { pool: m.pool, slots: m.slots, spread: m.spread, epoch: m.epoch }
}

/** The tenant's pool map: `pool:<tenant>` in KV, else the default shared pool. */
export async function poolMap(env: RouteEnv, tenant: string, refresh = false): Promise<PoolMap> {
  const now = Date.now()
  const hit = maps.get(tenant)
  if (!refresh && hit && hit.expires > now) return hit.map
  const stored = await env.CONFIG.get(`pool:${tenant}`)
  let map: PoolMap | null = null
  if (stored !== null) {
    // A tenant with a map of its own must never fall through to the shared pool: that
    // would send its rows to shards its readers do not look at.
    try {
      map = parseMap(JSON.parse(stored))
    } catch {
      map = null
    }
    if (!map) throw new HttpError(503, 'shard pool map is invalid', { 'Retry-After': '30' })
  } else if (env.DEFAULT_POOL) {
    try {
      map = parseMap(JSON.parse(env.DEFAULT_POOL))
    } catch {
      map = null
    }
  }
  if (!map) throw new HttpError(503, 'no shard pool is configured', { 'Retry-After': '30' })
  if (maps.size >= MAX_CACHE) maps.clear()
  maps.set(tenant, { map, expires: now + MAP_TTL_MS })
  return map
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  let s = ''
  for (let i = 0; i < d.length; i++) s += (d[i]! < 16 ? '0' : '') + d[i]!.toString(16)
  return s
}

type SlotResult = AppendResult | { status: 'error' }

/** One slot's batches go in order, stopping at the first refusal. */
async function appendSlot(env: RouteEnv, map: PoolMap, tenant: string, slot: number, batches: Batch[]): Promise<SlotResult> {
  let last: SlotResult = { status: 'error' }
  try {
    const stub = env.SHARD.get(env.SHARD.idFromName(shardName(map, slot)))
    for (const b of batches) {
      const fingerprint = crypto.randomUUID()
      last = await stub.append({ tenant, epoch: map.epoch, fingerprint, payload: b.bytes, rows: b.rows })
      if (last.status !== 'ok') return last
    }
  } catch {
    // Overloaded or unreachable shard. Nothing about the batch is known: not acknowledged.
    return { status: 'error' }
  }
  return last
}

async function attempt(env: RouteEnv, map: PoolMap, tenant: string, c: Collector, maxBatchBytes: number): Promise<{ results: SlotResult[]; batches: number }> {
  // Senders repeat few routing keys, so the slot is computed once per distinct key.
  const slotOfRoute = c.routes.map((key) => slotFor(map, tenant, key))
  const slotOfSeries = new Int32Array(c.nSeries)
  for (let i = 0; i < c.nSeries; i++) slotOfSeries[i] = slotOfRoute[c.routeOf[i]!]!
  const bySlot = buildBatches(c, slotOfSeries, maxBatchBytes)
  let batches = 0
  const pending: Promise<SlotResult>[] = []
  for (const [slot, list] of bySlot) {
    batches += list.length
    pending.push(appendSlot(env, map, tenant, slot, list))
  }
  return { results: await Promise.all(pending), batches }
}

/** Append everything the collector accepted. Resolves only when every shard has answered. */
export async function appendAll(env: RouteEnv, tenant: string, c: Collector): Promise<Outcome> {
  if (c.nRows === 0) return { status: 'ok', rows: 0, batches: 0 }
  let map = await poolMap(env, tenant)
  let { results, batches } = await attempt(env, map, tenant, c, c.limits.maxBatchBytes)

  const stale = results.find((r) => r.status === 'stale_epoch')
  if (stale) {
    // Our map is older than one a shard has seen: fetch it again, once, and re-route.
    const fresh = await poolMap(env, tenant, true)
    if (fresh.epoch <= map.epoch) return { status: 'unavailable', reason: 'shard map is being updated' }
    map = fresh
    ;({ results, batches } = await attempt(env, map, tenant, c, c.limits.maxBatchBytes))
    if (results.some((r) => r.status === 'stale_epoch')) return { status: 'unavailable', reason: 'shard map is being updated' }
  }
  if (results.some((r) => r.status === 'error')) return { status: 'unavailable', reason: 'shard unavailable' }
  let retryAfterMs = 0
  for (const r of results) if (r.status === 'backpressure') retryAfterMs = Math.max(retryAfterMs, r.retryAfterMs, 1)
  if (retryAfterMs > 0) return { status: 'backpressure', retryAfterMs }
  return { status: 'ok', rows: c.nRows, batches }
}
