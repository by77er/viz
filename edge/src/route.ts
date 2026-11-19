import { DERIVED_SIGNALS, type PoolMap, shardName, signalPool, slotFor, tenantSlots, validPoolName } from '../../shard/src/pool'
import type { AppendResult, Shard } from '../../shard/src/shard'
import { type Batch, buildBatches, type Collector } from './batch'
import { HttpError } from './errors'
import type { Limits } from './limits'

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

/**
 * Spans and log records go to shards of their own (contracts/BATCH.md, "Streams per
 * signal"): the pool `{pool}/traces` or `{pool}/logs`, with the tenant's slots, spread and
 * epoch. Metrics use the pool itself.
 */
export type Signal = 'metrics' | 'traces' | 'logs'

/** The pool map a signal's batches are appended with. 503 if the derived name is not a valid pool name. */
export function signalMap(map: PoolMap, signal: Signal): PoolMap {
  if (signal === 'metrics') return map
  // One derivation for every component (shard/src/pool.ts `signalPool`).
  const derived = signalPool(map, signal)
  if (!derived) throw new HttpError(503, `the ${signal} pool name derived from ${map.pool} is not a valid pool name`, { 'Retry-After': '30' })
  return derived
}

/** What `appendAll` needs of a request's decoded rows: the metrics `Collector`, or a span or log collector. */
export interface Collected {
  readonly limits: Limits
  readonly nRows: number
  readonly nSeries: number
  /** Distinct routing keys, and the one of each series (entry, stream). */
  readonly routes: readonly string[]
  readonly routeOf: ArrayLike<number>
  /** The series (entry, stream) of each row. */
  readonly rowSeries: ArrayLike<number>
  seriesId(i: number): bigint
}

/** Batches per slot, from the slot of each series; rows of series marked in `skip` left out. */
export type BuildBatches = (slotOfSeries: ArrayLike<number>, maxBatchBytes: number, skip?: Uint8Array) => Map<number, Batch[]>

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
  /** A tenant or shard buffer is full: 429. */
  | { status: 'backpressure'; retryAfterMs: number }
  /** A shard has more in flight than it takes (or cannot serve its storage): 503, which every sender retries. */
  | { status: 'overloaded'; retryAfterMs: number }
  | { status: 'unavailable'; reason: string }

/**
 * Every `AppendResult` status this code knows. Anything else (a newer shard's) is a failure
 * of the whole request, never counted as stored (contracts/COMPATIBILITY.md §3.2, design/UPGRADES.md §7).
 */
const KNOWN: ReadonlySet<string> = new Set(['ok', 'backpressure', 'stale_epoch', 'too_large', 'series_limit', 'invalid'])

/**
 * Shards that recently refused as overloaded, until when (this isolate's memory only; a
 * hint). A request whose every slot is in here is refused before its body is read or
 * decoded: it would be refused anyway, and the decode is the edge's largest cost.
 */
const hot = new Map<string, number>()

/**
 * Refuse before decoding: 503 with the shards' own Retry-After when every shard the tenant
 * may write to answered `overload` and its wait has not passed. Null otherwise.
 */
export async function refuseEarly(env: RouteEnv, tenant: string, now = Date.now(), signal: Signal = 'metrics'): Promise<{ status: 'overloaded'; retryAfterMs: number } | null> {
  if (hot.size === 0) return null
  const map = signalMap(await poolMap(env, tenant), signal)
  let until = Infinity
  for (const slot of tenantSlots(map, tenant)) {
    const t = hot.get(shardName(map, slot))
    if (t === undefined || t <= now) return null
    until = Math.min(until, t)
  }
  return { status: 'overloaded', retryAfterMs: until - now }
}

function noteOverload(map: PoolMap, slot: number, retryAfterMs: number): void {
  if (hot.size >= MAX_CACHE) hot.clear()
  hot.set(shardName(map, slot), Date.now() + retryAfterMs)
}

const MAP_TTL_MS = 30_000
const MAX_CACHE = 10_000
const maps = new Map<string, { map: PoolMap; expires: number }>()

export function clearMapCache(): void {
  maps.clear()
  limits.clear()
  hot.clear()
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
    let record: { v?: unknown; active_series?: unknown } | null = null
    try {
      record = JSON.parse(stored) as { v?: unknown; active_series?: unknown }
    } catch {
      // keep the default
    }
    const version = record?.v === undefined ? 1 : record.v
    if (record && version !== 1) {
      // Written by a newer release (contracts/COMPATIBILITY.md §3.2): keep the last good
      // value, else refuse (503). Never fall back to a default that could loosen the limit.
      if (hit) return hit.limit
      throw new HttpError(503, `limits record version ${String(version)} is newer than this release reads`, { 'Retry-After': '30' })
    }
    const n = record?.active_series
    if (typeof n === 'number' && Number.isInteger(n) && n >= 0) limit = n
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

/**
 * Whether a pool may be the base pool of a map: a valid pool name (`POOL_NAME`) that does not
 * end in a derived pool's suffix (`/traces`, `/logs`; contracts/BATCH.md "Streams per signal").
 * Otherwise its metric shard `{base}/{slot}` would be the same object, under the same name, as
 * the span or log shard of the pool one level up, and readers that tell a shard's signal by its
 * name (query's `signalOfShard`, D62) would take it for one.
 */
export const validBasePool = (pool: unknown): pool is string => validPoolName(pool) && !DERIVED_SIGNALS.some((s) => pool.endsWith(`/${s}`))

/** A pool map of a version this code does not read. */
const NEWER_MAP = Symbol('newer pool map')

function parseMap(v: unknown): PoolMap | null | typeof NEWER_MAP {
  if (!v || typeof v !== 'object') return null
  const m = v as Record<string, unknown>
  // contracts/COMPATIBILITY.md §3.2: never route on a guess.
  if (m.v !== undefined && m.v !== 1) return NEWER_MAP
  const int = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x)
  // contracts/TABLES.md: only pool names whose shards' key encoding is one-to-one; and
  // contracts/BATCH.md: no base pool ending in `/traces` or `/logs`.
  if (!validBasePool(m.pool)) return null
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
    let parsed: PoolMap | null | typeof NEWER_MAP = null
    try {
      parsed = parseMap(JSON.parse(stored))
    } catch {
      parsed = null
    }
    if (parsed === NEWER_MAP) {
      if (hit) return hit.map // the last good map of this tenant
      throw new HttpError(503, 'shard pool map is of a newer version than this release reads', { 'Retry-After': '30' })
    }
    map = parsed
    if (!map) throw new HttpError(503, 'shard pool map is invalid', { 'Retry-After': '30' })
  } else if (env.DEFAULT_POOL) {
    try {
      const parsed = parseMap(JSON.parse(env.DEFAULT_POOL))
      map = parsed === NEWER_MAP ? null : parsed
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
      // A status this code does not know is never success (fail closed).
      if (!KNOWN.has(last.status)) return { status: 'error' }
      // `invalid` is this Worker contradicting itself; it is not the sender's to fix. Not acknowledged.
      if (last.status === 'invalid') return { status: 'error' }
      if (last.status === 'backpressure' && (last as { scope: string }).scope === 'overload') noteOverload(map, slot, last.retryAfterMs)
      if (last.status !== 'ok') return last
    }
  } catch {
    // Overloaded or unreachable shard. Nothing about the batch is known: not acknowledged.
    return { status: 'error' }
  }
  return last
}

async function attempt(env: RouteEnv, map: PoolMap, tenant: string, c: Collected, build: BuildBatches, maxBatchBytes: number, limit: number, skip?: Uint8Array): Promise<{ results: SlotResult[]; batches: number }> {
  // Senders repeat few routing keys, so the slot is computed once per distinct key.
  const slotOfRoute = c.routes.map((key) => slotFor(map, tenant, key))
  const slotOfSeries = new Int32Array(c.nSeries)
  for (let i = 0; i < c.nSeries; i++) slotOfSeries[i] = slotOfRoute[c.routeOf[i]!]!
  const bySlot = build(slotOfSeries, maxBatchBytes, skip)
  const share = shardShare(limit, map, tenant)
  let batches = 0
  const pending: Promise<SlotResult>[] = []
  for (const [slot, list] of bySlot) {
    batches += list.length
    pending.push(appendSlot(env, map, tenant, slot, list, share))
  }
  return { results: await Promise.all(pending), batches }
}

/**
 * Append everything the collector accepted. Resolves only when every shard has answered.
 * Metrics by default; spans and log records pass their signal and their batch builder, and
 * go to their signal's pool unmetered (their batches carry no `seriesIds`).
 */
export async function appendAll(env: RouteEnv, tenant: string, c: Collected, signal: Signal = 'metrics', build?: BuildBatches): Promise<Outcome> {
  if (c.nRows === 0) return { status: 'ok', rows: 0, batches: 0 }
  const make: BuildBatches = build ?? ((s, m, k) => buildBatches(c as Collector, s, m, k))
  let map = signalMap(await poolMap(env, tenant), signal)
  const limit = signal === 'metrics' ? await activeSeriesLimit(env, tenant) : 0
  let { results, batches } = await attempt(env, map, tenant, c, make, c.limits.maxBatchBytes, limit)

  const stale = results.find((r) => r.status === 'stale_epoch')
  if (stale) {
    // Our map is older than one a shard has seen: fetch it again, once, and re-route.
    const fresh = signalMap(await poolMap(env, tenant, true), signal)
    if (fresh.epoch <= map.epoch) return { status: 'unavailable', reason: 'shard map is being updated' }
    map = fresh
    ;({ results, batches } = await attempt(env, map, tenant, c, make, c.limits.maxBatchBytes, limit))
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
    ;({ results, batches } = await attempt(env, map, tenant, c, make, cap, limit))
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
    ;({ results, batches } = await attempt(env, map, tenant, c, make, cap, limit, skip))
    if (results.some((r) => r.status === 'too_large' || r.status === 'stale_epoch')) return { status: 'unavailable', reason: 'shard map is being updated' }
    if (results.some((r) => r.status === 'error')) return { status: 'unavailable', reason: 'shard unavailable' }
  }
  // Fail closed: only `ok` counts as stored; anything not handled above refuses the request.
  if (results.some((r) => r.status !== 'ok' && r.status !== 'backpressure')) return { status: 'unavailable', reason: 'shard refused the batch' }
  // An overloaded shard, or a stream whose registration is not yet logged (D61), is a 5xx:
  // Remote Write senders MUST retry 5xx and MAY drop 429. A full buffer stays 429.
  let overloadMs = 0
  let retryAfterMs = 0
  for (const r of results) {
    if (r.status !== 'backpressure') continue
    const scope = (r as { scope: string }).scope
    if (scope === 'overload' || scope === 'registering') overloadMs = Math.max(overloadMs, r.retryAfterMs, 1)
    else retryAfterMs = Math.max(retryAfterMs, r.retryAfterMs, 1)
  }
  if (overloadMs > 0) return { status: 'overloaded', retryAfterMs: Math.max(overloadMs, retryAfterMs) }
  if (retryAfterMs > 0) return { status: 'backpressure', retryAfterMs }
  return limited ? { status: 'ok', rows: c.nRows - limited.rows, batches, limited } : { status: 'ok', rows: c.nRows, batches }
}
