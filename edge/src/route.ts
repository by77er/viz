import { type PoolMap, shardName, slotFor, tenantSlots } from '../../shard/src/pool'
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

/** Series refused for the tenant's active-series limit. The rest of the request was appended. */
export interface Limited {
  /** The tenant's limit, and the share of it one shard enforces. */
  limit: number
  share: number
  /** Active series on the shard that refused (the largest, if several did). */
  current: number
  /** Distinct new series refused, and how many samples they carried. */
  series: number
  rows: number
}

export type Outcome =
  | { status: 'ok'; rows: number; batches: number; limited?: Limited }
  | { status: 'backpressure'; retryAfterMs: number }
  | { status: 'unavailable'; reason: string }

const MAP_TTL_MS = 30_000
const MAX_CACHE = 10_000
const maps = new Map<string, { map: PoolMap; expires: number }>()

export function clearMapCache(): void {
  maps.clear()
  limits.clear()
}

/** Active series a tenant may have when `limits:<tenant>` says nothing. */
export const DEFAULT_ACTIVE_SERIES = 1_000_000
const limits = new Map<string, { limit: number; expires: number }>()

/**
 * The tenant's active-series limit: `limits:<tenant>` in KV = `{ "active_series": N }`,
 * else the default. A record that cannot be read gives the default, not "no limit".
 */
export async function activeSeriesLimit(env: RouteEnv, tenant: string): Promise<number> {
  const now = Date.now()
  const hit = limits.get(tenant)
  if (hit && hit.expires > now) return hit.limit
  let limit = DEFAULT_ACTIVE_SERIES
  const stored = await env.CONFIG.get(`limits:${tenant}`)
  if (stored !== null) {
    try {
      const n = (JSON.parse(stored) as { active_series?: unknown }).active_series
      if (typeof n === 'number' && Number.isInteger(n) && n >= 0) limit = n
    } catch {
      // keep the default
    }
  }
  if (limits.size >= MAX_CACHE) limits.clear()
  limits.set(tenant, { limit, expires: now + MAP_TTL_MS })
  return limit
}

/**
 * One shard's share of the tenant's limit. Series are spread over the tenant's slots by
 * sender (`job`, `instance`), so the limit is divided evenly among them, rounded up. A
 * tenant whose senders are unevenly spread reaches a shard's share before the whole limit;
 * the sum over its shards never exceeds the limit by more than one series per slot.
 */
export const shardShare = (limit: number, map: PoolMap, tenant: string): number => Math.ceil(limit / tenantSlots(map, tenant).length)

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
async function appendSlot(env: RouteEnv, map: PoolMap, tenant: string, slot: number, batches: Batch[], seriesLimit: number): Promise<SlotResult> {
  let last: SlotResult = { status: 'error' }
  try {
    const stub = env.SHARD.get(env.SHARD.idFromName(shardName(map, slot)))
    for (const b of batches) {
      const fingerprint = await sha256Hex(b.bytes)
      last = await stub.append({ tenant, epoch: map.epoch, fingerprint, payload: b.bytes, rows: b.rows, seriesIds: b.seriesIds, seriesLimit })
      // `invalid` is this Worker contradicting itself; it is not the sender's to fix. Not acknowledged.
      if (last.status === 'invalid') return { status: 'error' }
      if (last.status !== 'ok') return last
    }
  } catch {
    // Overloaded or unreachable shard. Nothing about the batch is known: not acknowledged.
    return { status: 'error' }
  }
  return last
}

async function attempt(env: RouteEnv, map: PoolMap, tenant: string, c: Collector, maxBatchBytes: number, limit: number, skip?: Uint8Array): Promise<{ results: SlotResult[]; batches: number }> {
  // Senders repeat few routing keys, so the slot is computed once per distinct key.
  const slotOfRoute = c.routes.map((key) => slotFor(map, tenant, key))
  const slotOfSeries = new Int32Array(c.nSeries)
  for (let i = 0; i < c.nSeries; i++) slotOfSeries[i] = slotOfRoute[c.routeOf[i]!]!
  const bySlot = buildBatches(c, slotOfSeries, maxBatchBytes, skip)
  const share = shardShare(limit, map, tenant)
  let batches = 0
  const pending: Promise<SlotResult>[] = []
  for (const [slot, list] of bySlot) {
    batches += list.length
    pending.push(appendSlot(env, map, tenant, slot, list, share))
  }
  return { results: await Promise.all(pending), batches }
}

/** Append everything the collector accepted. Resolves only when every shard has answered. */
export async function appendAll(env: RouteEnv, tenant: string, c: Collector): Promise<Outcome> {
  if (c.nRows === 0) return { status: 'ok', rows: 0, batches: 0 }
  let map = await poolMap(env, tenant)
  const limit = await activeSeriesLimit(env, tenant)
  let { results, batches } = await attempt(env, map, tenant, c, c.limits.maxBatchBytes, limit)

  const stale = results.find((r) => r.status === 'stale_epoch')
  if (stale) {
    // Our map is older than one a shard has seen: fetch it again, once, and re-route.
    const fresh = await poolMap(env, tenant, true)
    if (fresh.epoch <= map.epoch) return { status: 'unavailable', reason: 'shard map is being updated' }
    map = fresh
    ;({ results, batches } = await attempt(env, map, tenant, c, c.limits.maxBatchBytes, limit))
    if (results.some((r) => r.status === 'stale_epoch')) return { status: 'unavailable', reason: 'shard map is being updated' }
  }
  if (results.some((r) => r.status === 'error')) return { status: 'unavailable', reason: 'shard unavailable' }
  // A shard configured with a smaller cap than this Worker split at: split again at the
  // shard's cap, once. (The default on both sides is the same constant, MAX_BATCH_BYTES, so
  // this is a deployment whose shard was configured down.) Batches that had been appended
  // are stored again under new fingerprints; readers de-duplicate on (series_id, ts).
  const tooLarge = results.filter((r) => r.status === 'too_large')
  let cap = c.limits.maxBatchBytes
  if (tooLarge.length > 0) {
    for (const r of tooLarge) if (r.status === 'too_large') cap = Math.min(cap, r.maxBytes)
    if (cap >= c.limits.maxBatchBytes) return { status: 'unavailable', reason: 'shard refused the batch size' }
    ;({ results, batches } = await attempt(env, map, tenant, c, cap, limit))
    // Still refused: a single row does not fit the shard's cap, or the map moved. Either
    // way nothing is acknowledged; the whole request is retryable (contracts/BATCH.md).
    if (results.some((r) => r.status === 'too_large' || r.status === 'stale_epoch')) {
      return { status: 'unavailable', reason: 'shard refused the batch size' }
    }
    if (results.some((r) => r.status === 'error')) return { status: 'unavailable', reason: 'shard unavailable' }
  }
  // Active-series limit. A shard that would go over its share stores nothing of the batch and
  // names the NEW series that do not fit. Those series are left out and the rest is sent
  // again: series the tenant already has are never refused. Batches that had been appended
  // and come out byte-identical are recognised by their fingerprint; the others are stored
  // again and de-duplicated on read, as with any retry (contracts/BATCH.md).
  let limited: Limited | undefined
  let skip: Uint8Array | undefined
  for (let round = 0; results.some((r) => r.status === 'series_limit'); round++) {
    // The window moved under us three times running: let the sender retry the request.
    if (round >= 3) return { status: 'backpressure', retryAfterMs: 1000 }
    skip ??= new Uint8Array(c.nSeries)
    const refused = new Set<bigint>()
    let current = limited?.current ?? 0
    for (const r of results) {
      if (r.status !== 'series_limit') continue
      for (const id of r.refused) refused.add(id)
      current = Math.max(current, r.current)
    }
    for (let i = 0; i < c.nSeries; i++) if (refused.has(c.seriesId(i))) skip[i] = 1
    let series = 0
    let rows = 0
    for (let i = 0; i < c.nSeries; i++) series += skip[i]!
    for (let r = 0; r < c.nRows; r++) rows += skip[c.rowSeries[r]!]!
    limited = { limit, share: shardShare(limit, map, tenant), current, series, rows }
    ;({ results, batches } = await attempt(env, map, tenant, c, cap, limit, skip))
    if (results.some((r) => r.status === 'too_large' || r.status === 'stale_epoch')) return { status: 'unavailable', reason: 'shard map is being updated' }
    if (results.some((r) => r.status === 'error')) return { status: 'unavailable', reason: 'shard unavailable' }
  }
  let retryAfterMs = 0
  for (const r of results) if (r.status === 'backpressure') retryAfterMs = Math.max(retryAfterMs, r.retryAfterMs, 1)
  if (retryAfterMs > 0) return { status: 'backpressure', retryAfterMs }
  return limited ? { status: 'ok', rows: c.nRows - limited.rows, batches, limited } : { status: 'ok', rows: c.nRows, batches }
}
