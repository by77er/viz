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
 * A file as the ledger lists it (`Plan.files`, `LedgerChange.added`): a `FileEntry` with its
 * PRECEDENCE, which the ledger assigns. Requests (`addUnit`, `replace`) do not carry it; a
 * value sent in one is ignored.
 *
 * Precedence decides which row wins when two files of one table and day hold the same
 * `(series_id, ts)`: the file with the higher precedence, in a read and in a merge alike.
 * Readers pass files to the engine in `Plan.files` order (ascending), and compaction merges
 * its inputs in ascending precedence (the engine lets the later file win). Key order means
 * nothing: keys sort as text, so `…-10-12-…` sorts before `…-2-9-…`.
 *
 *   - A flush file has `[v, v]`, `v` being the ledger version of the `add_unit` that
 *     admitted it. A stream's units are admitted in sequence order, so a later write always
 *     has a higher precedence than an earlier one of the same stream. Across streams the
 *     order is admission order, which the shard-map handover makes the write order
 *     (design/DESIGN.md §4.1: a map change waits for the old shards' units to be recorded).
 *   - A `replace` output has `[min precedenceLow, max precedence]` over the removed files of
 *     its table and day (`[v, v]` if there are none). The ledger admits it only if no other
 *     live file of that table and day whose time range overlaps the output's has a range
 *     that intersects it; otherwise the swap is a `conflict` naming the `blocking` files.
 *
 * So any two live files that could hold the same `(series_id, ts)` (same table, same day,
 * overlapping time ranges) have disjoint ranges and are totally ordered by `precedence`, and
 * every row read or merged has the value of its latest write. (Within one file, the latest
 * row wins: contracts/BATCH.md, contracts/TABLES.md.)
 */
export interface LiveFile extends FileEntry {
  /** High end of the file's precedence range; the order of `Plan.files`. */
  precedence: number
  /** Low end; equal to `precedence` for a flush file. */
  precedenceLow: number
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
  /** Live files overlapping the range, in ascending `precedence` (then key): the order to read them in. */
  files: LiveFile[]
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
  /**
   * Nothing changed. `missing`: inputs that are no longer live. `blocking` (when present):
   * live files that are not inputs but whose precedence range an output's would intersect,
   * on the same table and day and overlapping in time (see `LiveFile`); the live set changed
   * since the caller planned. Either way: plan again.
   */
  | { status: 'conflict'; missing: string[]; blocking?: string[] }
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
  /** With the precedence the ledger assigned. (A log written before precedence existed has none; a reader derives `[version, version]` for `add_unit`, the inputs' range for `replace`.) */
  added: LiveFile[]
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
  /** Compaction: swap inputs for outputs iff every input is still live and the outputs' precedence ranges fit (`LiveFile`). */
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

/*
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * PROPOSED ADDITION (storage path, 2026-11-18): tombstones, for physical deletion.
 * Implemented in ledger/ and used by janitor/. Not yet reviewed (design/REVIEW.md).
 *
 * When `replace` or `expire` removes a key, the ledger records a tombstone in the same
 * transaction: the key, its table, the ledger VERSION of the change that removed it, and
 * the ledger's clock at that moment. Tombstones are keyed by version, so "is the removal
 * logged?" is "is that version in R2?", whatever the shape of the log (one object per
 * change today, segments in LEDGER-LOG.md).
 *
 * An object may be deleted from R2 only when the ledger says so through `deletable`:
 *   1. the change that removed it is durably logged (a ledger rebuilt from its log would
 *      otherwise list the file again), AND
 *   2. it was removed at least `minAgeMs` ago by the ledger's own clock (a query holding a
 *      plan from before the removal may still be reading it), AND
 *   3. the key is not live.
 * A removal that is committed but not yet logged is simply not returned; ask again later.
 * ─────────────────────────────────────────────────────────────────────────────────────────
 */
export interface Tombstone {
  key: string
  table: Table
  /** Ledger version of the `replace` or `expire` that removed the key. */
  version: number
  /** Ledger clock (Unix ms) when it was removed. */
  at: number
}

export interface OrphanCheck {
  /** Of the keys asked about: those that are live. */
  live: string[]
  /** Of the keys asked about: those with a tombstone (their deletion goes through `deletable`). */
  tombstoned: string[]
  /** Every stream's LOGGED watermark, read in the same instant as the two lists. */
  logged: Watermark[]
}

export interface LedgerJanitorRpc {
  /** Tombstones that satisfy all three rules above, lowest version first. `waiting` counts the rest. */
  deletable(req: { minAgeMs: number; limit?: number }): Promise<{ tombstones: Tombstone[]; waiting: number }>
  /** The objects of these keys have been deleted: drop their tombstones. Keys that are live or have none are ignored. */
  forget(keys: string[]): Promise<{ forgotten: number }>
  /** Every tombstone with a version above `version`, lowest first, deletable or not. */
  removedSince(version: number, limit?: number): Promise<Tombstone[]>
  /**
   * For the orphan sweep: which of these keys the ledger knows, and how far each stream is
   * logged, as ONE consistent read. A flush file that is neither live nor tombstoned and
   * whose sequence range is at or below its stream's logged watermark can never become
   * live (a unit for that range is answered as a replay).
   */
  orphanCheck(keys: string[]): Promise<OrphanCheck>
}
/* ───────────────────────────── end of proposed addition ───────────────────────────── */

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
