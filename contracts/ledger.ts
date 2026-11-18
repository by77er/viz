/**
 * The tenant ledger: one Durable Object per tenant. It is the only authority on which
 * data files are visible and how far each shard stream has been recorded.
 * See design/DESIGN.md §2, §4.3, §5.2.
 */

export type Table = 'metric_samples' | 'metric_series'

/** One immutable Parquet object. */
export interface FileEntry {
  table: Table
  /** UTC day, `YYYY-MM-DD`. */
  day: string
  /** R2 object key (contracts/TABLES.md). Unique. */
  key: string
  bytes: number
  rows: number
  minTs: number
  maxTs: number
  /** 0 = flush file; higher = compaction output. */
  level: number
  /** Row-group index fragment: opaque to the ledger, produced and consumed by the engine. */
  index: string
}

/** A stream is one tenant's log inside one shard. */
export interface StreamRef {
  shard: string
  incarnation: number
}

/** Everything one sealed segment produced. Admitted atomically or not at all. */
export interface FlushUnit extends StreamRef {
  seqLo: number
  seqHi: number
  files: FileEntry[]
}

export type AddUnitResult =
  /** Admitted, or already admitted earlier (idempotent replay). */
  | { status: 'ok'; version: number; watermark: number }
  /** `seqLo` is not `watermark + 1` for this stream. Nothing changed. */
  | { status: 'not_contiguous'; watermark: number }
  /** The stream is registered with a different incarnation. Nothing changed. */
  | { status: 'incarnation_mismatch'; incarnation: number }

export interface Watermark extends StreamRef {
  /** Highest sequence number whose rows are in listed files. */
  seq: number
}

export interface PlanRequest {
  table: Table
  /** Inclusive Unix-millisecond range. */
  minTs: number
  maxTs: number
}

export interface Plan {
  /** Ledger incarnation and version this plan reflects. Versions never repeat. */
  ledgerIncarnation: number
  version: number
  /** Live files overlapping the range. */
  files: FileEntry[]
  /** One per registered stream; the query asks each shard for rows above `seq`. */
  watermarks: Watermark[]
}

export interface ReplaceRequest {
  /** Keys that must ALL be live, else nothing changes. */
  remove: string[]
  add: FileEntry[]
}

export type ReplaceResult = { status: 'ok'; version: number } | { status: 'conflict'; missing: string[] }

export interface ExpireRequest {
  table: Table
  /** Remove files whose `day` is strictly before this `YYYY-MM-DD`. */
  beforeDay: string
}

/** A change, as appended to the ledger's R2 log and consumed by the publisher. */
export interface LedgerChange {
  ledgerIncarnation: number
  version: number
  at: number
  kind: 'add_unit' | 'replace' | 'expire' | 'register_stream'
  added: FileEntry[]
  removed: string[]
  watermark?: Watermark
}

export interface LedgerRpc {
  /** Register a stream (or a new incarnation of one). Idempotent for the same incarnation. */
  registerStream(ref: StreamRef): Promise<{ version: number; previousIncarnation: number | null }>
  addUnit(unit: FlushUnit): Promise<AddUnitResult>
  plan(req: PlanRequest): Promise<Plan>
  /** Compaction: swap inputs for outputs iff every input is still live. */
  replace(req: ReplaceRequest): Promise<ReplaceResult>
  /** Retention: drop whole days. Returns removed keys (to delete after publication). */
  expire(req: ExpireRequest): Promise<{ version: number; removed: string[] }>
  /** Highest sequence per stream that is both committed and durably logged to R2. */
  loggedWatermarks(): Promise<Watermark[]>
}

/** R2 keys for the ledger's own log, relative to the cell prefix. */
export const ledgerLogKey = (tenant: string, ledgerIncarnation: number, version: number): string =>
  `ledger/tenant=${tenant}/${ledgerIncarnation}/${String(version).padStart(12, '0')}.json`
