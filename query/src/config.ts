import { DEFAULT_LIMITS as ENGINE_LIMITS, type QueryLimits } from '../../engine/wasm-query/js/index'
import type { RouteEnv } from '../../edge/src/route'
import type { Ledger } from '../../ledger/src/ledger'
import type { Leaf } from './leaf'

export interface Env extends RouteEnv {
  LEDGER: DurableObjectNamespace<Ledger>
  LEAF: DurableObjectNamespace<Leaf>
  /** Data files. Read only by leaves. */
  BUCKET: R2Bucket
  CELL: string
  /** Leaf objects per cell (default 32). */
  LEAF_POOL_SIZE?: string
  /** Comma-separated origins allowed by CORS. Never `*`. */
  CORS_ORIGINS?: string
  /** Seconds an immutable data file stays in the Cache API (default 3600). */
  FILE_CACHE_TTL_S?: string
  /** JSON overriding any default of `TenantLimits`, for the whole deployment. */
  QUERY_LIMITS?: string
}

/**
 * What one query may use. `limits:<tenant>` in KV overrides any field for a tenant;
 * `QUERY_LIMITS` overrides the defaults for the deployment.
 */
export interface TenantLimits extends QueryLimits {
  /**
   * Bytes handed to the engine for one query: Parquet files as stored plus tail batches.
   * The isolate holds them twice while the engine runs (the buffers that arrived from
   * the leaves, and their copy inside WASM linear memory).
   */
  maxFetchBytes: number
  /**
   * Lake samples one query may DECODE: the rows of every row group its reads touch
   * (`scanRows` of the engine), known from the ledger before anything is fetched. The
   * engine's `maxSamples` fires only after a selector's samples are in memory at 16 bytes
   * each, and Parquet holds a sample in 2 to 3 bytes, so a byte cap alone would let a
   * 16 MiB read expand to more than 100 MiB before it is refused. This cap bounds that.
   */
  maxScanSamples: number
  /** Files of both tables one query may fetch (bounds leaf rounds and RPC count). */
  maxFiles: number
  /** Longest a query may run; the `timeout` parameter can only lower it. */
  timeoutMs: number
}

/**
 * Sized for the coordinator's 128 MB isolate. Worst case held at once for one query:
 * fetched bytes twice (2 x 16 MiB) + decoded samples (4,000,000 x 16 B = 61 MiB while a
 * selector is loaded; at most `maxSamples` x 16 B = 31 MiB once the engine has checked
 * it) + the evaluator's step grid (`maxStepPoints` x 24 B = 23 MiB). The two engine
 * terms do not peak together with the scan: 32 + 61 = 93 MiB while loading, 32 + 31 + 23
 * = 86 MiB while evaluating. Measured figures are in the README ("Measurements").
 */
export const DEFAULT_LIMITS: TenantLimits = {
  ...ENGINE_LIMITS,
  maxFetchBytes: 16 << 20,
  maxScanSamples: 4_000_000,
  maxFiles: 2_000,
  timeoutMs: 30_000,
}

/** A configuration that cannot be trusted: the query is refused (503), never run on a guess. */
export class ConfigError extends Error {}

const TTL_MS = 30_000
const MAX_CACHE = 10_000
const cache = new Map<string, { limits: TenantLimits; expires: number }>()

export function clearLimitsCache(): void {
  cache.clear()
}

function overlay(base: TenantLimits, raw: string, what: string): TenantLimits {
  let o: unknown
  try {
    o = JSON.parse(raw)
  } catch {
    throw new ConfigError(`${what} is not valid JSON`)
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new ConfigError(`${what} must be a JSON object`)
  const out = { ...base }
  for (const [k, v] of Object.entries(o)) {
    if (!(k in base)) continue // unknown fields are ignored, so a newer record does not break an older Worker
    // A limit that is not a non-negative integer is refused: guessing could loosen it.
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw new ConfigError(`${what}: ${k} must be a non-negative integer`)
    out[k as keyof TenantLimits] = v
  }
  return out
}

/** The tenant's limits: defaults, then `QUERY_LIMITS`, then `limits:<tenant>` in KV. */
export async function tenantLimits(env: Env, tenant: string, now = Date.now()): Promise<TenantLimits> {
  const hit = cache.get(tenant)
  if (hit && hit.expires > now) return hit.limits
  let limits = env.QUERY_LIMITS ? overlay(DEFAULT_LIMITS, env.QUERY_LIMITS, 'QUERY_LIMITS') : DEFAULT_LIMITS
  const stored = await env.CONFIG.get(`limits:${tenant}`)
  if (stored !== null) limits = overlay(limits, stored, 'the tenant\'s query limits')
  if (cache.size >= MAX_CACHE) cache.clear()
  cache.set(tenant, { limits, expires: now + TTL_MS })
  return limits
}

export const leafPoolSize = (env: Env): number => {
  const n = Number(env.LEAF_POOL_SIZE ?? '32')
  return Number.isInteger(n) && n >= 1 && n <= 1024 ? n : 32
}

export const fileCacheTtl = (env: Env): number => {
  const n = Number(env.FILE_CACHE_TTL_S ?? '3600')
  return Number.isInteger(n) && n >= 0 && n <= 86_400 ? n : 3600
}
