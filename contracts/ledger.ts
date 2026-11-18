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

/**
 * A stream is one tenant's log inside one shard. Incarnations are ordered: a larger number
 * is newer (shards derive them from the time the stream was created). The ledger refuses an
 * incarnation lower than the one it has registered.
 */
export interface StreamRef {
  shard: string
  incarnation: number
}

/** Tenant ids are `[A-Za-z0-9_-]{1,64}` everywhere: they appear in object keys unescaped. */
export const TENANT_ID = /^[A-Za-z0-9_-]{1,64}$/

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
  /** The unit itself is unacceptable (a key already belongs to another unit, an empty unit). Nothing changed. */
  | { status: 'invalid'; reason: string }

/*
 * Replay rules. A retried unit is `ok` whenever the stream's watermark is already at or past
 * its `seqHi`, even if its files have since been compacted away. A unit for a shard the
 * ledger has never seen is admitted only with `seqLo === 1`; otherwise it is
 * `not_contiguous` with watermark 0. A retried `replace` is `ok` if every output is live and
 * no input is; otherwise it is judged as a new request.
 */

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

export type ReplaceResult =
  | { status: 'ok'; version: number }
  | { status: 'conflict'; missing: string[] }
  | { status: 'invalid'; reason: string }

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
  /**
   * `base` is the first entry of a ledger incarnation: the whole live set and every
   * watermark it started from (empty for a new tenant, the rebuilt state after storage
   * loss). A log reader that meets a new incarnation starts again from its `base`.
   */
  kind: 'base' | 'add_unit' | 'replace' | 'expire' | 'register_stream'
  added: FileEntry[]
  removed: string[]
  /** For `add_unit` and `register_stream`: the stream's watermark after the change. */
  watermark?: Watermark
  /** For `add_unit`: the sequence range admitted, so a reader can check contiguity. */
  unit?: { seqLo: number; seqHi: number }
  /** For `base`: every stream's watermark. */
  watermarks?: Watermark[]
}

export interface LedgerRpc {
  /**
   * Register a stream (or a new incarnation of one). Idempotent for the same incarnation.
   * Throws for an incarnation lower than the registered one (see `StreamRef`): the return
   * type has no refusal, and a caller must never proceed as if a stale stream were registered.
   */
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

/** Operator and test surface. Not called on the data path. */
export interface LedgerAdminRpc {
  /** Write pending changes to R2 now. Idempotent. */
  drain(): Promise<{ written: number }>
  outboxDepth(): Promise<number>
  /** Rebuild from the R2 log into empty storage, then start a new ledger incarnation. */
  rebuildFromLog(): Promise<{ ledgerIncarnation: number; version: number }>
}

/** R2 keys for the ledger's own log, relative to the cell prefix. */
export const ledgerLogKey = (tenant: string, ledgerIncarnation: number, version: number): string =>
  `ledger/tenant=${tenant}/${ledgerIncarnation}/${String(version).padStart(12, '0')}.json`

/**
 * The `base` entry of an incarnation. It is LOGICALLY first: its `version` is the version the
 * incarnation starts from, and the incarnation's first change is `version + 1`. In a
 * lexicographic key listing it comes AFTER the version objects (`base.json` sorts after
 * digits), so a reader fetches it by this key and does not rely on list order.
 */
export const ledgerBaseKey = (tenant: string, ledgerIncarnation: number): string =>
  `ledger/tenant=${tenant}/${ledgerIncarnation}/base.json`
