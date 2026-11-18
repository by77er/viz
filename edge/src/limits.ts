import { MAX_BATCH_BYTES } from '../../shard/src/shard'
import { HttpError } from './errors'

/**
 * The ceilings contracts/BATCH.md fixes. A deployment may set tighter limits through
 * `INGEST_LIMITS`, never looser ones: a batch that breaks these is not a valid `VZB1` batch.
 * The batch size cap is `MAX_BATCH_BYTES`, the one constant the shard enforces too.
 */
export const CONTRACT = {
  maxLabelsPerSeries: 128,
  maxLabelNameBytes: 1024,
  maxLabelValueBytes: 8192,
  maxBatchBytes: MAX_BATCH_BYTES,
  /** Timestamps are Unix milliseconds in the years 1970 to 9999, so a UTC day is `YYYY-MM-DD`. */
  minTimestampMs: 0,
  maxTimestampMs: 253_402_300_799_999,
} as const

export interface Limits {
  /** Largest request body as received (compressed, if it is compressed). */
  maxBodyBytes: number
  /** Largest request body after decompression. Checked before / while inflating. */
  maxDecompressedBytes: number
  /** Distinct series in one request. */
  maxSeries: number
  /** Samples (rows) in one request. */
  maxSamples: number
  maxLabelsPerSeries: number
  /** UTF-8 bytes. At most the contract's 1,024 (names) and 8,192 (values). */
  maxLabelNameBytes: number
  maxLabelValueBytes: number
  /** Accept window: a sample may be this much older than now … */
  acceptBackMs: number
  /** … or this much newer. */
  acceptAheadMs: number
  /**
   * One request is split into batches no larger than this per slot. Never above
   * `MAX_BATCH_BYTES` (1 MiB, contracts/BATCH.md): the shard answers `too_large` beyond it.
   */
  maxBatchBytes: number
}

export const DEFAULT_LIMITS: Limits = {
  maxBodyBytes: 8 << 20,
  maxDecompressedBytes: 32 << 20,
  maxSeries: 100_000,
  maxSamples: 500_000,
  maxLabelsPerSeries: CONTRACT.maxLabelsPerSeries,
  maxLabelNameBytes: CONTRACT.maxLabelNameBytes,
  maxLabelValueBytes: CONTRACT.maxLabelValueBytes,
  acceptBackMs: 60 * 60_000,
  acceptAheadMs: 5 * 60_000,
  maxBatchBytes: CONTRACT.maxBatchBytes,
}

let cachedRaw: string | undefined
let cached: Limits = DEFAULT_LIMITS

/** Limits = defaults overridden by the `INGEST_LIMITS` JSON variable. */
export function limitsFrom(raw: string | undefined): Limits {
  if (!raw) return DEFAULT_LIMITS
  if (raw === cachedRaw) return cached
  let o: unknown
  try {
    o = JSON.parse(raw)
  } catch {
    throw new HttpError(500, 'INGEST_LIMITS is not valid JSON')
  }
  const out: Limits = { ...DEFAULT_LIMITS }
  if (o && typeof o === 'object') {
    for (const k of Object.keys(DEFAULT_LIMITS) as (keyof Limits)[]) {
      const v = (o as Record<string, unknown>)[k]
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[k] = Math.floor(v)
    }
  }
  out.maxLabelsPerSeries = Math.min(out.maxLabelsPerSeries, CONTRACT.maxLabelsPerSeries)
  out.maxLabelNameBytes = Math.min(out.maxLabelNameBytes, CONTRACT.maxLabelNameBytes)
  out.maxLabelValueBytes = Math.min(out.maxLabelValueBytes, CONTRACT.maxLabelValueBytes)
  out.maxBatchBytes = Math.min(out.maxBatchBytes, CONTRACT.maxBatchBytes)
  cachedRaw = raw
  cached = out
  return out
}
