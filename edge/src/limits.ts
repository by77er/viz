import { HttpError } from './errors'

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
  /** UTF-8 bytes. Must stay below 65536: the batch format stores lengths as u16. */
  maxLabelNameBytes: number
  maxLabelValueBytes: number
  /** Accept window: a sample may be this much older than now … */
  acceptBackMs: number
  /** … or this much newer. */
  acceptAheadMs: number
  /**
   * One request is split into batches no larger than this per slot. A Durable Object
   * SQLite value is capped at 2 MB, so a batch must stay well below that.
   */
  maxBatchBytes: number
}

export const DEFAULT_LIMITS: Limits = {
  maxBodyBytes: 8 << 20,
  maxDecompressedBytes: 32 << 20,
  maxSeries: 100_000,
  maxSamples: 500_000,
  maxLabelsPerSeries: 64,
  maxLabelNameBytes: 256,
  maxLabelValueBytes: 4096,
  acceptBackMs: 60 * 60_000,
  acceptAheadMs: 5 * 60_000,
  maxBatchBytes: 1 << 20,
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
  out.maxLabelNameBytes = Math.min(out.maxLabelNameBytes, 0xffff)
  out.maxLabelValueBytes = Math.min(out.maxLabelValueBytes, 0xffff)
  out.maxBatchBytes = Math.min(out.maxBatchBytes, 1_900_000)
  cachedRaw = raw
  cached = out
  return out
}
