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
   *
   * Why 32 MiB and not more. The engine runs in the coordinator's 128 MB isolate. For one
   * query the isolate holds the fetched bytes twice (the buffers that arrived from the
   * leaves, and their copy inside WASM linear memory) plus what the engine decodes:
   * 16 bytes a sample up to `maxSamples` (32 MiB at the default) and 24 bytes a step
   * point up to `maxStepPoints` (24 MiB). 2 x 32 + 32 + 24 = 120 MiB is the worst case
   * at the defaults, and both engine limits are rarely reached together. Measured
   * (README, "Measurements"): 7.4 MiB of files and tail peaked at 50 MiB of WASM memory.
   */
  maxFetchBytes: number
  /** Files of both tables one query may fetch (bounds leaf rounds and RPC count). */
  maxFiles: number
  /** Longest a query may run; the `timeout` parameter can only lower it. */
  timeoutMs: number
}

export const DEFAULT_LIMITS: TenantLimits = {
  ...ENGINE_LIMITS,
  maxFetchBytes: 32 << 20,
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
