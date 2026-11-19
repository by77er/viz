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
  /**
   * Which of Tempo's and Loki's HTTP APIs this Worker answers: `traces`, `logs`, or both,
   * comma-separated. Unset (the default): neither, and their paths are 404, until the write
   * side of stage 2 (shards, flush, ledger tables) lands (README, "Traces and logs").
   */
  QUERY_SIGNALS?: string
}

/** Whether `QUERY_SIGNALS` enables a signal's API. */
export const signalEnabled = (env: Env, signal: 'traces' | 'logs'): boolean => (env.QUERY_SIGNALS ?? '').split(',').some((x) => x.trim() === signal)

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
   * It is an upper bound (whole row groups), so it must sit above `maxSamples`.
   */
  maxScanSamples: number
  /** Files of both tables one query may fetch (bounds leaf rounds and RPC count). */
  maxFiles: number
  /** Longest a query may run; the `timeout` parameter can only lower it. */
  timeoutMs: number
  /**
   * Split execution (README, "Split execution"). A query that decomposes is split over
   * leaves when its scan bound is above this (or its files do not fit `maxFetchBytes` or
   * `maxFiles`); below it, one place is cheaper (every leaf of a split reads every file).
   */
  splitAboveSamples: number
  /**
   * A query that decomposes is also split when the series it would load, estimated from
   * the series files (`seriesEstimate` in coordinator.ts), are above this: three quarters
   * of `maxSeries`, as `splitAboveSamples` is of `maxSamples`. Without it a query over
   * 100,000 series with few samples each ran in one place and was refused by `maxSeries`
   * (README, "Cardinality").
   */
  splitAboveSeries: number
  /** A split query: samples loaded over all leaves. Each leaf's share is at most `maxSamples`. */
  maxQuerySamples: number
  /** A split query: series loaded over all leaves. Each leaf's share is at most `maxSeries`. */
  maxQuerySeries: number
  /** A split query: the scan bound of the files it reads. */
  maxQueryScanSamples: number
  /** A split query: bytes of the data files it reads, each file counted once. */
  maxQueryFetchBytes: number
  /** A split query: data files of both tables. */
  maxQueryFiles: number
  /** Leaves one split query may use (also bounded by the pool). */
  maxLeaves: number
  /** Cardinality report: distinct series counted (exact counting; above it the report is refused). */
  maxCardinalitySeries: number
  /**
   * Cardinality report: distinct label pairs plus (metric, label, value) triples. Every one
   * reaches the coordinator's merge, which held about 130 bytes of WASM memory each
   * (measured here: 25.9 MiB for 200,000 over 8 leaves, README "Cardinality"); 400,000
   * keeps the merge near 52 MiB of a 128 MB isolate. (It was 2,000,000: about 260 MiB.)
   */
  maxCardinalityPairs: number
  /**
   * Cardinality report: counted over leaves (each a range of `series_id`s) when the series
   * files hold more series than this (`seriesEstimate`), or are over `maxFetchBytes`. One
   * place held 51.9 MiB of WASM memory for 100,000 series (measured here).
   */
  cardinalitySplitAboveSeries: number
  /**
   * The label endpoints (`/labels`, `/label/<name>/values`, `/series`): distinct series
   * listed. They read series files only, never samples (CARDINALITY.md, item 3), so they are
   * bounded by this instead of a query's `maxSeries`; what one place holds is the series files
   * (within `maxFetchBytes`) and, per series listed, its label set for `/series` or one name
   * or value for the other two.
   */
  maxMetadataSeries: number
  /**
   * Traces (README, "Traces and logs"): spans one query may decode, checked against the rows
   * of the row groups it would read (from the index fragments, before anything is fetched) and
   * again by the engine as it decodes (the tail's spans count too). Measured here: a search that
   * held 40,000 spans peaked at 62 MiB of WASM memory (about 1.5 KiB a span, the files included).
   */
  maxSpans: number
  /**
   * Logs: log rows one query may decode, checked the same way. Measured here: a query that
   * kept 80,000 rows peaked at 83 MiB of WASM memory (about 1 KiB a row); one that kept the rows
   * of one stream of the same files, at 15 MiB.
   */
  maxLogRows: number
  /** TraceQL metrics: series in the answer, and points per series (the engine's `Limits`). */
  maxTraceSeries: number
  maxTracePoints: number
  /**
   * Parts of one query (a split, the cardinality report, a label call over leaves) that may read
   * the rest of a tail that did not fit the coordinator themselves. Each such read scans every
   * shard's whole tail for the tenant, on the object that acknowledges writes (D48 "Cost of it"),
   * so a query costs each shard (1 + parts) scans; past this the query is refused (D54, review
   * M-3). See README "Measurements" for the time one scan takes.
   */
  maxTailReadParts: number
}

/**
 * Sized for the coordinator's 128 MB isolate. What one query holds at once: the fetched
 * bytes twice (at most 2 x 16 MiB), and inside WASM the decoded samples at 16 bytes each
 * plus, once they are loaded, the evaluator's step grid at 24 bytes a cell.
 *
 *   while loading   32 MiB + 3,000,000 x 16 B (46 MiB)                    = 78 MiB
 *   evaluating      32 MiB + maxSamples x 16 B (31 MiB) + grid (23 MiB)   = 86 MiB
 *
 * Measured locally (README, "Measurements"): a query that decoded 2.89 M samples from
 * 10.6 MiB of files peaked at 76.7 MiB of WASM memory; the 1-hour, 2,000-series query
 * (0.52 M samples, 2.1 MiB) at 21.5 MiB. `maxScanSamples` is 1.5 x `maxSamples` because
 * the bound counts whole row groups, of which a query may need only a part.
 */
export const DEFAULT_LIMITS: TenantLimits = {
  ...ENGINE_LIMITS,
  maxFetchBytes: 16 << 20,
  maxScanSamples: 3_000_000,
  maxFiles: 2_000,
  timeoutMs: 30_000,
  splitAboveSamples: 1_500_000,
  splitAboveSeries: 15_000,
  maxQuerySamples: 64_000_000,
  maxQuerySeries: 640_000,
  maxQueryScanSamples: 100_000_000,
  maxQueryFetchBytes: 512 << 20,
  maxQueryFiles: 20_000,
  maxLeaves: 32,
  maxCardinalitySeries: 1_000_000,
  maxCardinalityPairs: 400_000,
  cardinalitySplitAboveSeries: 50_000,
  maxMetadataSeries: 200_000,
  maxSpans: 40_000,
  maxLogRows: 60_000,
  maxTraceSeries: 10_000,
  maxTracePoints: 11_000,
  maxTailReadParts: 16,
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
