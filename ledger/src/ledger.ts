import { DurableObject } from 'cloudflare:workers'
import {
  LEDGER_CHECKPOINT_KIND,
  LEDGER_CHECKPOINT_PART_MAX_BYTES,
  LEDGER_SEGMENT_KIND,
  LEDGER_SEGMENT_MAX_BYTES,
  LEDGER_SEGMENT_VERSION,
  TENANT_ID,
  checkpointHeaderProblem,
  unsupportedLedgerChange,
  decodeLedgerCheckpointManifest,
  decodeLedgerCheckpointPart,
  decodeLedgerSegment,
  encodeLedgerCheckpointManifest,
  encodeLedgerCheckpointPart,
  encodeLedgerSegment,
  ledgerBaseKey,
  ledgerCheckpointKey,
  ledgerCheckpointPartKey,
  ledgerIncarnationPrefix,
  ledgerSegmentKey,
  ledgerSegmentsStartingAfter,
  parseLedgerLogKey,
  readLedgerLogStream,
  type LedgerCheckpointManifest,
  type LedgerSegmentHeader,
  type AddUnitResult,
  type ExpireRequest,
  type FileEntry,
  type FlushUnit,
  type LedgerAdminRpc,
  type LedgerChange,
  type LedgerJanitorRpc,
  type LiveFile,
  type LoggedWatermark,
  PRECEDENCE_PER_VERSION,
  SHARD_NAME,
  type OrphanCheck,
  type Tombstone,
  type LedgerRpc,
  type Plan,
  type PlanRequest,
  type RegisterResult,
  type ReplaceRequest,
  type ReplaceResult,
  type StreamRef,
  type Table,
  type Watermark,
} from '../../contracts/ledger'
import { type SchemaSpec, type SchemaTooNew, SchemaTooNewError, columnsOf, openSchema, refusalOf } from '../../contracts/schema'

/**
 * The tenant ledger: one Durable Object per tenant; the tenant is the object's name.
 *
 * It holds the tenant's live data files and one watermark per shard stream. It is the only
 * authority on what is visible.
 *
 * Every mutation is one synchronous SQLite transaction that changes the live set, bumps the
 * version and inserts the `LedgerChange` into an outbox; it then sets the alarm (if none is
 * set) and answers. It never waits for R2. The alarm drains the outbox to R2 as SEGMENTS
 * (contracts/LEDGER-LOG.md): it records the segment's bounds in SQLite, writes it, and only
 * then deletes its rows and advances the logged marks, in one transaction. Two marks per
 * stream follow from that:
 *
 *   watermark   committed in SQLite. Queries plan against it.
 *   logged      the change that set it is in a written segment. Shards may discard only up
 *               to this, because only this survives the loss of the ledger's storage.
 *
 * R2 layout, under the cell prefix (keys in contracts/ledger.ts):
 *
 *   ledger/tenant={t}/{incarnation}/seg-{first:012}-{last:012}.jsonl   the changes, first..last;
 *                                                                      the first segment starts with the base
 *   ledger/tenant={t}/{incarnation}/ckpt-{version:012}.jsonl           a checkpoint: the whole state at a version
 *                                                                      (format 1), or the manifest of its parts (format 2)
 *   ledger/tenant={t}/{incarnation}/ckpt-{version:012}-{attempt}/{part:06}.jsonl   a part of a format-2 checkpoint
 *
 * The first layout (`base.json` and `{version}.json`) is still READ, by a rebuild of an
 * incarnation that used it. A ledger whose storage still runs such an incarnation starts a
 * new one, in segments, when it starts under this code.
 *
 * Starting an incarnation (a new tenant, storage loss, or the first layout) needs R2: list
 * the incarnations, replay the newest, write the new base. That runs OUTSIDE
 * `blockConcurrencyWhile` (AGENTS.md); while it runs every request waits up to
 * `START_WAIT_MS` and is then refused with a retryable `LedgerUnavailableError`. Nothing is
 * served or committed before the base is in R2.
 *
 * A checkpoint larger than one part is written in parts by later drain steps (D47); its
 * progress and the pre-images that keep it at its version are rows of `ckpt` and `ckpt_pre`.
 * A rebuild streams checkpoints and bases into SQLite; nothing holds the whole state.
 *
 * In-memory state is a cache or a hint only: the schema state and whether an incarnation is
 * being started (re-derived from SQLite in the constructor), the alarm time this object set,
 * the drain's and the checkpoint's backoffs, and the last fault (for `logStatus`).
 */

export interface LedgerEnv {
  BUCKET: R2Bucket
  CELL?: string
  /** How long after the first unlogged commit the drain runs (ms). Default `DRAIN_DELAY_MS`. */
  LEDGER_DRAIN_DELAY_MS?: string
  /** Write a checkpoint after this many segments. Default `CHECKPOINT_EVERY`. */
  LEDGER_CHECKPOINT_EVERY?: string
  /** Refuse new files above this much state (bytes). Default `STATE_MAX_BYTES`. */
  LEDGER_STATE_MAX_BYTES?: string
}

/** Which flush unit a file came from. Null for compaction outputs. */
interface UnitRef {
  shard: string
  incarnation: number
  seqLo: number
  seqHi: number
}

type StoredFile = LiveFile & { unit: UnitRef | null }

interface StoredStream {
  shard: string
  incarnation: number
  watermark: number
  previousIncarnation: number | null
}

/** A `LedgerChange` of kind `base`: the whole state at `version`. */
export type LedgerBase = LedgerChange & { kind: 'base'; watermarks: Watermark[] }

export interface RebuildResult {
  ledgerIncarnation: number
  version: number
  /** Incarnation replayed, or null if R2 held no log for this tenant (or the state came from SQLite). */
  source: number | null
  /** How the new incarnation's state was obtained. */
  from: 'empty' | 'segments' | 'objects' | 'sqlite'
  /** The checkpoint the replay started from, if any. */
  checkpoint: number | null
  changesReplayed: number
  segmentsRead: number
  files: number
  streams: number
  ms: number
}

export interface LogStatus {
  /**
   * `stuck`: the log cannot go on as it is (the outbox does not continue the written log, an
   * object at a segment's key has other bytes, or the log cannot be rebuilt from); `stuck`
   * says why. Nothing more counts as logged until an operator acts (`restartFromSqlite`, or
   * repairing R2): stuck, never lost, never silently skipped (review S-1).
   */
  phase: 'ready' | 'starting' | 'refused' | 'corrupt' | 'stuck'
  ledgerIncarnation: number | null
  version: number
  /** Highest version in a written segment of this incarnation. */
  loggedThrough: number | null
  /** Changes committed but not in R2. */
  pending: number
  /** The segment being written, if one is recorded. */
  inFlight: { first: number; last: number } | null
  segmentsSinceCheckpoint: number
  /** The alarm time this object set, if any. */
  alarmAt: number | null
  lastError: string | null
  /** Since this instance started: segments written, and the slowest and the last segment write (ms). */
  segmentsWritten: number
  segmentWriteMs: { last: number; max: number }
  /** Why the log is stuck, if it is (phase `stuck`). */
  stuck: string | null
  /** Estimated size of the whole state as a base or checkpoint (bytes), and the most `addUnit` admits to (review S-2). */
  stateBytes: number
  stateLimitBytes: number
  /** A checkpoint being written in parts (format 2), if any: its version, how far it is, and its parts so far. */
  checkpoint: { version: number; phase: 'files' | 'tombstones' | 'manifest'; parts: number; files: number; tombstones: number; bytes: number } | null
  /**
   * Registrations committed but not yet logged (D57): while there are any, a shard refuses the
   * writes of those new streams. With `pendingSince`, what an operator alerts on when the log
   * cannot be written (review m-1): a stuck or failing drain shows here as registrations that
   * wait, not only as a growing `pending`.
   */
  registrationsPending: number
  /** When the oldest change still in the outbox was committed (Unix ms), or null. */
  pendingSince: number | null
}

/**
 * The ledger cannot serve yet (it is starting an incarnation: rebuilding from R2 or writing
 * its base) or its log cannot be read. Retryable: nothing happened. The message starts with
 * `ledger_unavailable`, so a caller on the far side of an RPC boundary can recognise it.
 */
export class LedgerUnavailableError extends Error {
  override name = 'LedgerUnavailable'
  readonly retryable = true
  constructor(readonly reason: string, readonly retryAfterMs: number) {
    super(`ledger_unavailable: ${reason}; retry in ${Math.ceil(retryAfterMs / 1000)} s`)
  }
}

const TABLES: readonly Table[] = ['metric_samples', 'metric_series']
const DAY = /^\d{4}-\d{2}-\d{2}$/
const CHANGE_OBJECT = /\/(\d{12,})\.json$/
/** Default: the alarm runs this long after the first unlogged commit, so a burst shares a segment. */
export const DRAIN_DELAY_MS = 200
/** A failed drain is retried after this, doubling up to `DRAIN_RETRY_MAX_MS`. */
const DRAIN_RETRY_MS = 1_000
const DRAIN_RETRY_MAX_MS = 60_000
/** At most this many segments per alarm; then the alarm is set again. */
const SEGMENTS_PER_ALARM = 16
/**
 * Default: a checkpoint after at least this many segments, and only once the segments written
 * since the last checkpoint (or the base) are at least as large as it: so checkpoints cost at
 * most as much R2 as the log itself, whatever the write rate (review S-2).
 */
export const CHECKPOINT_EVERY = 256
/**
 * Default: `addUnit` refuses new files (`full`) once the state would exceed this many bytes, as
 * estimated by `entryBytes` (review S-2). Checkpoints are written in parts and a rebuild streams
 * into SQLite (contracts/LEDGER-LOG.md, "Checkpoints"; D47), so no step holds the state in
 * memory and memory no longer sets the bound (measured flat from 8,000 to 300,000 files). What
 * grows with the state is TIME: a rebuild or a new incarnation reads and writes all of it, and
 * requests are refused (retryably) meanwhile: 20 s at 300,000 files here. This is the largest
 * state measured (300,000 S4-shaped files, about 298 MiB; ledger/README.md). Raising it needs
 * that time measured on Cloudflare. The publisher still reads a new incarnation's base whole
 * (ledger/README.md, "Needed changes elsewhere").
 */
export const STATE_MAX_BYTES = 300 * 1024 * 1024
/**
 * A checkpoint of a state whose estimate is at most this is written in format 1 (one object,
 * built in one step, as before): about one part's worth, so no step builds more than a part.
 * Above it, in format 2 (parts across drains).
 */
export const CHECKPOINT_ONE_OBJECT_BYTES = LEDGER_CHECKPOINT_PART_MAX_BYTES
/** At most this many checkpoint parts per alarm (each one PUT), interleaved with segments. */
const CHECKPOINT_PARTS_PER_ALARM = 8
/** A rebuild reads log objects concurrently up to this many bytes (and `REPLAY_FANOUT` objects). */
const REPLAY_BYTES_IN_FLIGHT = 8 * 1024 * 1024
/** A start writes the base to R2 in pieces of about this many characters. */
const BASE_WRITE_CHUNK = 256 * 1024
const FILE_OVERHEAD_BYTES = 448
const entryBytes = (f: { key: string; index: string }): number => f.key.length + f.index.length + FILE_OVERHEAD_BYTES
/** The same estimate in SQL, over rows of `file`. */
const ENTRY_BYTES_SQL = `COALESCE(SUM(LENGTH(idx) + LENGTH(key) + ${FILE_OVERHEAD_BYTES}), 0)`
/** Concurrent R2 reads while replaying a log: a Durable Object's six connections. */
const REPLAY_FANOUT = 6
/** A request waits this long for a starting incarnation before it is refused. */
const START_WAIT_MS = 2_000
/** A failed start is tried again after this. */
const START_RETRY_MS = 5_000

/**
 * The ledger's storage, versioned (contracts/COMPATIBILITY.md §2). Version 1 is the schema
 * exactly as the code before versioning created it, with IF NOT EXISTS, so it adopts such
 * storage without changing a row; an object created before file precedence (D22) also gets
 * `prec`/`prec_lo` (0: those files keep ranking by key among themselves, as they did). The
 * segment log needed no new table: its state is rows of `meta` (`log_format`, `seg_first`,
 * `seg_last`, `logged_through`, `segs_since_ckpt`, `starting`), absent in older storage,
 * which this code reads as "an incarnation in the first layout" and replaces with a new
 * incarnation. See ledger/README.md, "Versioned storage".
 */
const V1 = [
  `CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS file (
      key TEXT PRIMARY KEY, tbl TEXT NOT NULL, day TEXT NOT NULL, bytes INTEGER NOT NULL, rows INTEGER NOT NULL,
      min_ts INTEGER NOT NULL, max_ts INTEGER NOT NULL, level INTEGER NOT NULL, idx TEXT NOT NULL,
      u_shard TEXT, u_inc INTEGER, u_lo INTEGER, u_hi INTEGER,
      prec INTEGER NOT NULL, prec_lo INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS file_tbl_day ON file (tbl, day)`,
  `CREATE INDEX IF NOT EXISTS file_tbl_max ON file (tbl, max_ts)`,
  `CREATE TABLE IF NOT EXISTS stream (
      shard TEXT PRIMARY KEY, incarnation INTEGER NOT NULL, watermark INTEGER NOT NULL,
      logged INTEGER NOT NULL, prev_incarnation INTEGER)`,
  `CREATE TABLE IF NOT EXISTS outbox (version INTEGER PRIMARY KEY, body TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS tombstone (key TEXT PRIMARY KEY, tbl TEXT NOT NULL, version INTEGER NOT NULL, at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS tombstone_version ON tombstone (version)`,
]

export const LEDGER_SCHEMA: SchemaSpec = {
  component: 'ledger.Ledger',
  migrations: [{
    version: 1,
    name: 'the schema as it stood when versioning began (prec/prec_lo added to objects from before D22)',
    readableFrom: 1,
    up: (sql) => {
      for (const s of V1) sql.exec(s)
      const cols = columnsOf(sql, 'file')
      if (!cols.has('prec')) sql.exec(`ALTER TABLE file ADD COLUMN prec INTEGER NOT NULL DEFAULT 0`)
      if (!cols.has('prec_lo')) sql.exec(`ALTER TABLE file ADD COLUMN prec_lo INTEGER NOT NULL DEFAULT 0`)
    },
  }, {
    // FORWARD-ONLY (readableFrom = 2): the outbox and `meta` now mean "drained as segments".
    // Code that knows only version 1 and drains the first layout must not open this storage:
    // it would write per-change objects into a segment incarnation and tell shards they are
    // logged (review S-1). Versioned older code now refuses (`schema_too_new`); code from
    // before versioning cannot be stopped by a version row and is kept out by the release
    // record (contracts/COMPATIBILITY.md §6; ledger/README.md, "Needed changes elsewhere").
    version: 2,
    name: 'the change log in segments (contracts/LEDGER-LOG.md); the state-size estimate in meta',
    readableFrom: 2,
    up: (sql) => {
      sql.exec(`DELETE FROM meta WHERE k = 'state_bytes'`)
      sql.exec(`INSERT INTO meta (k, v) SELECT 'state_bytes', ${ENTRY_BYTES_SQL} FROM file`)
    },
  }, {
    // ADDITIVE (readableFrom 2): two new tables for a checkpoint written in parts across drains
    // (contracts/LEDGER-LOG.md, "Checkpoints"). A release that knows only version 2 ignores them
    // and changes files without recording pre-images; `ckpt.tracked` then stops following the
    // version, and this code abandons that checkpoint instead of writing a wrong one.
    version: 3,
    name: 'a checkpoint in parts: its progress (ckpt) and the files changed since its version (ckpt_pre)',
    readableFrom: 2,
    up: (sql) => {
      sql.exec(`CREATE TABLE IF NOT EXISTS ckpt (
          id INTEGER PRIMARY KEY CHECK (id = 1), incarnation INTEGER NOT NULL, version INTEGER NOT NULL, attempt TEXT NOT NULL,
          at INTEGER NOT NULL, phase TEXT NOT NULL, file_cursor TEXT NOT NULL, tomb_cursor TEXT NOT NULL, parts INTEGER NOT NULL,
          files INTEGER NOT NULL, tombstones INTEGER NOT NULL, bytes INTEGER NOT NULL, tracked INTEGER NOT NULL, streams TEXT NOT NULL)`)
      sql.exec(`CREATE TABLE IF NOT EXISTS ckpt_pre (
          key TEXT PRIMARY KEY, absent INTEGER NOT NULL, tbl TEXT, day TEXT, bytes INTEGER, rows INTEGER, min_ts INTEGER, max_ts INTEGER,
          level INTEGER, idx TEXT, u_shard TEXT, u_inc INTEGER, u_lo INTEGER, u_hi INTEGER, prec INTEGER, prec_lo INTEGER)`)
    },
  }],
}

/** Columns of `file`, in order; `ckpt_pre` repeats them after `absent`. */
const FILE_COLUMNS = 'key, tbl, day, bytes, rows, min_ts, max_ts, level, idx, u_shard, u_inc, u_lo, u_hi, prec, prec_lo'

/** A checkpoint in progress (the one row of `ckpt`). */
interface CheckpointRow {
  incarnation: number
  version: number
  attempt: string
  at: number
  /** `files`: parts are being written from the files at `version`; `tombstones`: then the tombstones; `manifest`: every part is written. */
  phase: 'files' | 'tombstones' | 'manifest'
  /** The last file key, and the last tombstone key, in a written part ('' before the first). */
  fileCursor: string
  tombCursor: string
  parts: number
  files: number
  tombstones: number
  bytes: number
  /** The highest version whose changes to files were recorded in `ckpt_pre`; must equal the version for the checkpoint to go on. */
  tracked: number
  streams: Pick<LedgerCheckpointManifest, 'watermarks' | 'previousIncarnations'>
}

/** SQLite orders TEXT by its UTF-8 bytes; JavaScript compares UTF-16 code units. This is SQLite's order. */
function compareKeys(a: string, b: string): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    let x = a.charCodeAt(i)
    let y = b.charCodeAt(i)
    if (x === y) continue
    // Surrogates (U+D800–DFFF, i.e. code points above U+FFFF) come after U+E000–FFFF in UTF-8.
    if (x >= 0xd800 && y >= 0xd800) {
      x = x >= 0xe000 ? x - 0x800 : x + 0x2000
      y = y >= 0xe000 ? y - 0x800 : y + 0x2000
    }
    return x - y
  }
  return a.length - b.length
}

/**
 * `meta` keys. `log_format` 2 = this incarnation logs segments. `starting` 1 = this storage
 * was created empty and its first incarnation is still being started from R2 (the only way
 * to have a schema version row and no incarnation that is not corruption).
 */
type MetaKey = 'incarnation' | 'version' | 'log_format' | 'seg_first' | 'seg_last' | 'logged_through' | 'segs_since_ckpt' | 'starting'
  | 'state_bytes' | 'log_bytes_since_ckpt' | 'ckpt_bytes'
const LOG_FORMAT_SEGMENTS = 2

type Row = Record<string, SqlStorageValue>

const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0

/** Why a file entry is unacceptable, or null. `prefix(f)` is where its key must lie. */
function fileProblem(f: FileEntry, prefix: (f: FileEntry) => string): string | null {
  if (typeof f !== 'object' || f === null) return 'file entry is not an object'
  if (typeof f.key !== 'string' || f.key === '') return 'file key must be a non-empty string'
  if (!TABLES.includes(f.table)) return `unknown table for ${f.key}`
  if (typeof f.day !== 'string' || !DAY.test(f.day)) return `bad day for ${f.key}`
  if (!isCount(f.bytes) || !isCount(f.rows) || !isCount(f.level)) return `bad bytes/rows/level for ${f.key}`
  if (!Number.isSafeInteger(f.minTs) || !Number.isSafeInteger(f.maxTs) || f.minTs > f.maxTs) return `bad time range for ${f.key}`
  if (typeof f.index !== 'string') return `index fragment must be a string for ${f.key}`
  // Only this tenant's objects, of this table and day (contracts/ledger.ts `FileEntry.key`):
  // whatever the ledger lists, the janitor will one day delete.
  const p = prefix(f)
  if (!f.key.startsWith(p) || f.key.length === p.length || f.key.slice(p.length).includes('/')) return `file key ${f.key} is not under ${p}`
  return null
}

/** Why a list of files is unacceptable (a bad entry, or a key that appears twice), or null. */
function filesProblem(files: FileEntry[], prefix: (f: FileEntry) => string): string | null {
  if (!Array.isArray(files)) return 'files must be an array'
  const seen = new Set<string>()
  for (const f of files) {
    const p = fileProblem(f, prefix)
    if (p) return p
    if (seen.has(f.key)) return `duplicate file key in request: ${f.key}`
    seen.add(f.key)
  }
  return null
}

function refProblem(ref: StreamRef): string | null {
  if (typeof ref !== 'object' || ref === null) return 'stream reference is not an object'
  if (typeof ref.shard !== 'string' || ref.shard === '') return 'shard must be a non-empty string'
  // contracts/TABLES.md: the key encoding of a shard name is one-to-one only for these names.
  if (!SHARD_NAME.test(ref.shard)) return `shard name ${JSON.stringify(ref.shard.slice(0, 140))} does not match SHARD_NAME`
  if (!isCount(ref.incarnation)) return 'incarnation must be a non-negative integer'
  return null
}

const toEntry = (r: Row): LiveFile => ({
  table: r.tbl as Table,
  day: r.day as string,
  key: r.key as string,
  bytes: r.bytes as number,
  rows: r.rows as number,
  minTs: r.min_ts as number,
  maxTs: r.max_ts as number,
  level: r.level as number,
  index: r.idx as string,
  precedence: r.prec as number,
  precedenceLow: r.prec_lo as number,
})

/** The request's fields only: a precedence a caller sent is never taken (contracts/ledger.ts `LiveFile`). */
const asListed = (f: FileEntry, precedenceLow: number, precedence: number): LiveFile => ({
  table: f.table, day: f.day, key: f.key, bytes: f.bytes, rows: f.rows, minTs: f.minTs, maxTs: f.maxTs, level: f.level, index: f.index,
  precedence, precedenceLow,
})

const toStored = (r: Row): StoredFile => ({
  ...toEntry(r),
  unit:
    r.u_shard === null
      ? null
      : { shard: r.u_shard as string, incarnation: r.u_inc as number, seqLo: r.u_lo as number, seqHi: r.u_hi as number },
})


/** A recorded segment, ready to write. */
interface PendingSegment {
  /** The ledger incarnation it belongs to: a segment of an older one is never applied to a newer (review S-7). */
  incarnation: number
  first: number
  last: number
  key: string
  body: string
  rows: { version: number; json: string }[]
  /** The bounds were recorded by this call (so must be made durable before the PUT). */
  fresh: boolean
  /** A format-1 checkpoint (a small state) to write once this segment is written: the state at `last`, encoded. */
  checkpoint: { version: number; body: string } | null
}

/** An existing log object with other bytes, or a recorded segment whose rows are gone: never overwritten, never guessed around. */
class LogFault extends Error {}
/** The outbox does not continue the written log: something other than this drain logged (or lost) changes in between. */
class LogDiscontinuity extends LogFault {}

export class Ledger extends DurableObject<LedgerEnv> implements LedgerRpc, LedgerAdminRpc, LedgerJanitorRpc {
  private readonly tenant: string
  private readonly cell: string
  /** Where the change log goes. A field so that tests can substitute a failing bucket. */
  protected bucket: R2Bucket
  protected drainDelayMs: number
  protected checkpointEvery: number
  /** Checkpoint only once the log since the last one is as large as it (false in tests that count segments only). */
  protected checkpointByLogBytes = true
  /** A format-2 checkpoint part holds records up to this many characters (a field so that tests can make parts small). */
  protected checkpointPartBytes = LEDGER_CHECKPOINT_PART_MAX_BYTES
  /** A state estimated at most this is checkpointed in format 1, as one object (a field so that tests can force format 2). */
  protected checkpointOneObjectBytes = CHECKPOINT_ONE_OBJECT_BYTES
  /** A rebuild writes a base it reads into SQLite in transactions of this many rows: what it holds of it at once. */
  protected rebuildBatchRows = 256
  protected stateMaxBytes: number
  /** Why the log is stuck (phase `stuck`), re-derived by the next drain or start after an eviction. */
  private stuck: string | null = null
  /** Single-flight guard: drains run one after another, never interleaved. */
  private draining: Promise<unknown> = Promise.resolve()
  private refusal: SchemaTooNew | null = null
  /** Storage this code will not serve or repair (a version row and no incarnation). */
  private corrupt: string | null = null
  /** Set while storage has no usable incarnation; the promise of the start in progress. */
  private needsStart: 'r2' | 'sqlite' | null = null
  private starting: Promise<RebuildResult> | null = null
  private startFailedAt = 0
  /** The alarm time this object set (a cache of `getAlarm`, re-read in the constructor). */
  private alarmAt: number | null = null
  /** A drain is not retried before this (backoff after a failure). */
  private retryNotBefore = 0
  private failures = 0
  /** A checkpoint step is not retried before this (backoff after a failed write; a hint, lost on eviction). */
  private checkpointRetryAt = 0
  private checkpointFailures = 0
  private lastError: string | null = null
  /** Scheduling hints for drains started by commits: is one running, when did the last end, since when is something pending. */
  private drainActive = false
  private segmentsWritten = 0
  private segmentWriteMs = { last: 0, max: 0 }
  private lastDrainEnd = 0
  private pendingSince: number | null = null

  constructor(ctx: DurableObjectState, env: LedgerEnv) {
    super(ctx, env)
    const tenant = ctx.id.name
    if (!tenant) throw new Error('ledger: the object must be addressed by name (the tenant)')
    // Tenant ids appear unescaped in object keys; the contract fixes their alphabet.
    if (!TENANT_ID.test(tenant)) throw new Error('ledger: tenant id must match [A-Za-z0-9_-]{1,64}')
    this.tenant = tenant
    this.cell = env.CELL || 'cell-0'
    this.bucket = env.BUCKET
    this.drainDelayMs = Number(env.LEDGER_DRAIN_DELAY_MS ?? DRAIN_DELAY_MS)
    this.checkpointEvery = Math.max(1, Number(env.LEDGER_CHECKPOINT_EVERY ?? CHECKPOINT_EVERY))
    this.stateMaxBytes = Math.max(1, Number(env.LEDGER_STATE_MAX_BYTES ?? STATE_MAX_BYTES))
    // Local storage only inside: no R2, no network (AGENTS.md).
    void ctx.blockConcurrencyWhile(() => this.open())
  }

  // ───────────────────────────── storage ─────────────────────────────

  private async open(): Promise<void> {
    const state = openSchema(this.ctx.storage, LEDGER_SCHEMA)
    this.refusal = refusalOf(state)
    this.alarmAt = await this.ctx.storage.getAlarm()
    if (this.refusal) {
      // COMPATIBILITY.md §2.4: re-arm and touch nothing else.
      if (this.alarmAt === null) this.setAlarmAt(Date.now() + this.refusal.retryAfterMs)
      return
    }
    // Storage is NEW only when this open created every table (design/UPGRADES.md §7): a new
    // tenant, or storage that was lost. Only then does the ledger rebuild from R2. The mark is
    // committed with the schema (no await in between), so a start interrupted by eviction
    // resumes instead of looking like corruption.
    const created = state.status === 'ok' && state.migrated.includes(1) && (!state.adopted || this.isEmpty())
    if (created && this.meta('incarnation') === null) this.ctx.storage.transactionSync(() => this.setMeta('starting', 1))
    if (this.meta('incarnation') === null) {
      if (this.meta('starting') !== 1) {
        // A version row and no incarnation: not new, not ours to guess about. Refuse.
        this.corrupt = 'storage has a schema version but no ledger incarnation; refusing to rebuild over it'
        console.error(`ledger ${this.tenant}: ${this.corrupt}`)
        return
      }
      this.needsStart = 'r2'
    } else if (this.meta('log_format') !== LOG_FORMAT_SEGMENTS) this.needsStart = 'sqlite'
    if (this.needsStart) {
      // Started now, outside `blockConcurrencyWhile`; requests wait for it or are refused.
      this.beginStart()
      return
    }
    if (this.hasPending() && this.alarmAt === null) this.setAlarmAt(Date.now())
  }

  private isEmpty(): boolean {
    const n = (t: string) => this.ctx.storage.sql.exec(`SELECT COUNT(*) AS n FROM ${t}`).one().n as number
    // `state_bytes` is written by migration 2 itself, so it does not make storage "used".
    const meta = this.ctx.storage.sql.exec(`SELECT COUNT(*) AS n FROM meta WHERE k <> 'state_bytes'`).one().n as number
    return n('file') === 0 && n('stream') === 0 && n('outbox') === 0 && meta === 0
  }

  private meta(k: MetaKey): number | null {
    const r = this.ctx.storage.sql.exec(`SELECT v FROM meta WHERE k = ?`, k).toArray()[0]
    return r ? (r.v as number) : null
  }

  private setMeta(k: MetaKey, v: number): void {
    this.ctx.storage.sql.exec(`INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v`, k, v)
  }

  private dropMeta(k: MetaKey): void {
    this.ctx.storage.sql.exec(`DELETE FROM meta WHERE k = ?`, k)
  }

  private ledgerIncarnation(): number {
    const v = this.meta('incarnation')
    if (v === null) throw new Error('ledger: not initialised')
    return v
  }

  private version(): number {
    return this.meta('version') ?? 0
  }

  private stream(shard: string): StoredStream | null {
    const r = this.ctx.storage.sql.exec(`SELECT * FROM stream WHERE shard = ?`, shard).toArray()[0]
    if (!r) return null
    return {
      shard,
      incarnation: r.incarnation as number,
      watermark: r.watermark as number,
      previousIncarnation: r.prev_incarnation as number | null,
    }
  }

  private liveFile(key: string): StoredFile | null {
    const r = this.ctx.storage.sql.exec(`SELECT * FROM file WHERE key = ?`, key).toArray()[0]
    return r ? toStored(r) : null
  }

  /** Where a file of this table and day must be: `{cell}/data/{table}/tenant={tenant}/day={day}/`. */
  private readonly keyPrefix = (f: FileEntry): string => `${this.cell}/data/${f.table}/tenant=${this.tenant}/day=${f.day}/`

  /**
   * Inside the transaction that removes `keys` from the live set: remember them, with the
   * version that removal is about to get, until their objects have been deleted.
   */
  private bury(keys: { key: string; table: Table }[]): void {
    const version = this.version() + 1
    const at = Date.now()
    for (const k of keys) {
      this.ctx.storage.sql.exec(`INSERT OR REPLACE INTO tombstone (key, tbl, version, at) VALUES (?, ?, ?, ?)`, k.key, k.table, version, at)
    }
  }

  /**
   * Inside a mutation's transaction, BEFORE rows of `file` matching `where` (over `f`) are
   * deleted: keep their state at the version of the checkpoint in progress, for keys it has not
   * written yet. The first change since that version wins (`OR IGNORE`). No checkpoint, no row.
   */
  private preimageOfDeleted(where: string, ...args: SqlStorageValue[]): void {
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO ckpt_pre (absent, ${FILE_COLUMNS})
       SELECT 0, ${FILE_COLUMNS.split(', ').map((c) => `f.${c}`).join(', ')} FROM file f, ckpt c
       WHERE c.phase = 'files' AND f.key > c.file_cursor AND ${where}`,
      ...args,
    )
  }

  /** Inside a mutation's transaction, before `file` gets `key`: the key was not live at the checkpoint's version. */
  private preimageOfInserted(key: string): void {
    this.ctx.storage.sql.exec(`INSERT OR IGNORE INTO ckpt_pre (key, absent) SELECT ?, 1 FROM ckpt WHERE phase = 'files' AND ? > file_cursor`, key, key)
  }

  /**
   * Inside a mutation's transaction: whether a checkpoint is reading files now, so that changes
   * to files must leave pre-images. Read once per mutation; without one, a mutation runs no
   * statement for it.
   */
  private tracking(): boolean {
    return this.ctx.storage.sql.exec(`SELECT 1 AS x FROM ckpt WHERE phase = 'files'`).toArray().length > 0
  }

  /** A live file admitted by a mutation (`addUnit`, `replace`): a checkpoint reading files is told. */
  private insertFile(f: LiveFile, unit: UnitRef | null, tracking: boolean): void {
    if (tracking) this.preimageOfInserted(f.key)
    this.loadFile(f, unit)
  }

  /** A row of `file`, as it is: for a rebuild, which runs with no checkpoint in progress. */
  private loadFile(f: LiveFile, unit: UnitRef | null): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO file (key, tbl, day, bytes, rows, min_ts, max_ts, level, idx, u_shard, u_inc, u_lo, u_hi, prec, prec_lo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      f.key, f.table, f.day, f.bytes, f.rows, f.minTs, f.maxTs, f.level, f.index,
      unit?.shard ?? null, unit?.incarnation ?? null, unit?.seqLo ?? null, unit?.seqHi ?? null,
      f.precedence, f.precedenceLow,
    )
  }

  /**
   * Bump the version and put the change in the outbox. Must be called inside the same
   * `transactionSync` as the mutation it describes; that is what makes "committed" and
   * "will be logged" the same event.
   */
  private record(
    kind: LedgerChange['kind'],
    added: LiveFile[],
    removed: { key: string; table: Table }[],
    watermark?: Watermark,
    unit?: { seqLo: number; seqHi: number },
  ): number {
    const sql = this.ctx.storage.sql
    const version = this.version() + 1
    this.setMeta('version', version)
    const change: LedgerChange = { ledgerIncarnation: this.ledgerIncarnation(), version, at: Date.now(), kind, added, removed: removed.map((r) => r.key) }
    if (removed.length > 0) change.removedFiles = removed.map((r) => ({ key: r.key, table: r.table }))
    if (watermark) change.watermark = watermark
    if (unit) change.unit = unit
    sql.exec(`INSERT INTO outbox (version, body) VALUES (?, ?)`, version, JSON.stringify(change))
    // A checkpoint in progress follows every version, or is abandoned (a release that does not
    // know it changed files without telling it: `ckpt.tracked` stops here).
    sql.exec(`UPDATE ckpt SET tracked = ? WHERE tracked = ?`, version, version - 1)
    // Tombstones of this change carry exactly its time, so a rebuild from the log restores them as they were.
    if (removed.length > 0) sql.exec(`UPDATE tombstone SET at = ? WHERE version = ?`, change.at, version)
    return version
  }

  /**
   * After a committed mutation: make sure the drain will run. No await, so the caller is
   * answered as soon as the commit is durable (the runtime holds the answer until then, and
   * the alarm is part of the same write).
   */
  private afterCommit(): void {
    const now = Date.now()
    this.pendingSince ??= now
    // Under continuous load the runtime may not deliver the alarm until the object is idle
    // (measured in workerd: 1,600 units in 8 s, the alarm ran only after the last one), so
    // a commit also starts a drain itself once one is due. Not awaited: the caller is
    // answered when its commit is durable, never after an R2 write.
    if (!this.drainActive && now >= this.retryNotBefore && now - this.pendingSince >= this.drainDelayMs && now - this.lastDrainEnd >= this.drainDelayMs) {
      this.kickDrain()
    }
    // The alarm covers the tail: the last commits before the object goes quiet.
    this.scheduleDrain(this.drainDelayMs)
  }

  private kickDrain(): void {
    void this.drainWithBackoff(SEGMENTS_PER_ALARM, CHECKPOINT_PARTS_PER_ALARM).then((failed) => {
      if (this.hasPending()) this.scheduleDrain(failed ? this.retryNotBefore - Date.now() : this.drainDelayMs)
    })
  }

  /** Set the alarm `delayMs` ahead unless one is already due by then; never before a backoff ends. */
  private scheduleDrain(delayMs: number): void {
    const at = Math.max(Date.now() + delayMs, this.retryNotBefore)
    if (this.alarmAt !== null && this.alarmAt <= at) return
    this.setAlarmAt(at)
  }

  private setAlarmAt(at: number): void {
    this.alarmAt = at
    // Not awaited: the write is output-gated with whatever this event committed.
    this.ctx.storage.setAlarm(at).catch(() => undefined)
  }

  /** Something for the drain to do now: a recorded segment, an outbox row, or a checkpoint in progress that is not backing off. */
  private hasPending(): boolean {
    return this.meta('seg_first') !== null || (this.ctx.storage.sql.exec(`SELECT COUNT(*) AS n FROM outbox`).one().n as number) > 0
      || (this.checkpointRow() !== null && Date.now() >= this.checkpointRetryAt)
  }

  /** After a drain with nothing left to do now: the alarm for a checkpoint that waits for its backoff, else none. */
  private afterDrain(): void {
    if (this.checkpointRow() !== null) this.scheduleDrain(Math.max(0, this.checkpointRetryAt - Date.now()))
    else if (this.alarmAt !== null) {
      this.alarmAt = null
      this.ctx.storage.deleteAlarm().catch(() => undefined)
    }
  }

  // ───────────────────────────── gate ─────────────────────────────

  /**
   * Null when the object may serve now. Otherwise a promise that resolves once it may, or
   * rejects with the reason it may not (schema too new, or an incarnation still starting).
   */
  private gate(): Promise<void> | null {
    if (this.refusal) return Promise.reject(new SchemaTooNewError(this.refusal))
    if (this.corrupt) return Promise.reject(new LedgerUnavailableError(this.corrupt, DRAIN_RETRY_MAX_MS))
    if (!this.needsStart) return null
    return this.waitStarted()
  }

  private async waitStarted(): Promise<void> {
    if (!this.starting && Date.now() - this.startFailedAt >= START_RETRY_MS) this.beginStart()
    const run = this.starting
    if (run) {
      // Wait for the start, but at most START_WAIT_MS; the timer is cleared either way, so
      // no dangling timer keeps the object awake (and billed) after the answer.
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([run.then(() => undefined, () => undefined), new Promise<void>((r) => { timer = setTimeout(r, START_WAIT_MS) })])
      clearTimeout(timer)
    }
    if (this.needsStart) {
      const why = this.lastError && !this.starting ? `its log could not be read (${this.lastError})` : 'it is starting a ledger incarnation (rebuilding from R2 or writing its base)'
      throw new LedgerUnavailableError(why, this.starting ? START_WAIT_MS : START_RETRY_MS)
    }
  }

  private beginStart(): void {
    const mode = this.needsStart
    if (!mode || this.starting) return
    this.starting = this.startIncarnation(mode)
    this.starting.then(
      () => {
        this.needsStart = null
        this.starting = null
        this.lastError = null
        this.stuck = null
        this.failures = 0
        this.retryNotBefore = 0
        if (this.hasPending()) this.scheduleDrain(0)
      },
      (e: unknown) => {
        this.starting = null
        this.startFailedAt = Date.now()
        this.lastError = e instanceof Error ? e.message : String(e)
        // A log that cannot be rebuilt from (a gap, both layouts, an unreadable or unsupported
        // object, a missing log while data exists) is stuck until someone repairs R2; a failed
        // read is only retried.
        if (e instanceof LogFault) this.stuck = `${this.lastError}; operator: repair R2`
        console.error(`ledger ${this.tenant}: could not start an incarnation: ${this.lastError}`)
        // Try again even if nobody asks.
        this.setAlarmAt(Date.now() + START_RETRY_MS)
      },
    )
  }

  // ───────────────────────────── LedgerRpc ─────────────────────────────

  async registerStream(ref: StreamRef): Promise<RegisterResult> {
    const g = this.gate()
    if (g) await g
    const problem = refProblem(ref)
    if (problem) throw new Error(`ledger: ${problem}`)
    const known = this.stream(ref.shard)
    if (known && known.incarnation === ref.incarnation) {
      // Idempotent: a retried registration gets the answer the first one got, and whether it
      // is logged by now (D57): derived from the outbox, never stored (review B-1).
      return { version: this.version(), previousIncarnation: known.previousIncarnation, logged: this.registrationLogged(ref.shard, ref.incarnation) }
    }
    // Incarnations are ordered (a larger number is newer). A lower one is a stale shard or a
    // late message; registering it would rewind the watermark of the live stream. The
    // contract's return type has no refusal, so this is an exception.
    if (known && ref.incarnation < known.incarnation) {
      throw new Error(`ledger: stream ${ref.shard} is registered with incarnation ${known.incarnation}; refusing the lower ${ref.incarnation}`)
    }
    const version = this.ctx.storage.transactionSync(() => this.register(ref, known))
    this.afterCommit()
    // Only committed: its change is in the outbox until a segment holding it is written.
    return { version, previousIncarnation: known?.incarnation ?? null, logged: false }
  }

  /**
   * Registrations committed but not yet logged, by shard: the incarnations a `register_stream`
   * change still in the outbox names. One read of the outbox (a drain cycle of rows; more while
   * the drain is stuck), parsing only registration changes. Outbox rows leave only with the
   * segment that holds them (`segmentWritten`) or with a new incarnation, whose base is in R2
   * before it commits (`startIncarnation`); and every release writes and drains the same
   * outbox. So a committed registration that no row names is in the logged prefix, whatever
   * release committed or drained it: nothing here can be left stale by a rollback (D57;
   * review B-1).
   */
  private pendingRegistrations(): Map<string, Set<number>> {
    const out = new Map<string, Set<number>>()
    for (const r of this.ctx.storage.sql.exec(`SELECT body FROM outbox WHERE instr(body, '"kind":"register_stream"') > 0`)) {
      const c = JSON.parse(r.body as string) as LedgerChange
      if (c.kind !== 'register_stream' || !c.watermark) continue
      let set = out.get(c.watermark.shard)
      if (!set) out.set(c.watermark.shard, (set = new Set()))
      set.add(c.watermark.incarnation)
    }
    return out
  }

  /** Is this stream's committed registration of `incarnation` in the logged prefix? (The caller has checked it is the committed one.) */
  private registrationLogged(shard: string, incarnation: number): boolean {
    // A logged unit of the incarnation proves it at once: the log is a prefix of versions, and
    // a unit's version is above its stream's registration (`logged` moves only for the
    // stream's current incarnation, and is reset to 0 by a registration).
    const r = this.ctx.storage.sql.exec(`SELECT logged FROM stream WHERE shard = ? AND incarnation = ?`, shard, incarnation).toArray()[0]
    if (r && (r.logged as number) > 0) return true
    return !this.pendingRegistrations().get(shard)?.has(incarnation)
  }

  /**
   * Every stream with its logged watermark and its logged incarnation (contracts/ledger.ts
   * `LoggedWatermark`), as one synchronous read. The outbox is read only if some stream's
   * logged watermark is 0 (otherwise every registration is proven logged by a logged unit).
   */
  private loggedStreams(): LoggedWatermark[] {
    const rows = this.ctx.storage.sql.exec(`SELECT shard, incarnation, logged, prev_incarnation FROM stream ORDER BY shard`).toArray()
    const pending = rows.some((r) => (r.logged as number) === 0) ? this.pendingRegistrations() : new Map<string, Set<number>>()
    return rows.map((r): LoggedWatermark => {
      const shard = r.shard as string
      const incarnation = r.incarnation as number
      const seq = r.logged as number
      const prev = r.prev_incarnation as number | null
      const waiting = pending.get(shard)
      // The committed incarnation if its registration is logged; else the one registered
      // before it, if that registration is logged; else 0 (unknown, and low is the safe side).
      const loggedIncarnation = seq > 0 || !waiting?.has(incarnation) ? incarnation : prev !== null && !waiting.has(prev) ? prev : 0
      return { shard, incarnation, seq, loggedIncarnation }
    })
  }

  /** Inside a transaction: create the stream, or replace its incarnation and restart at 0. */
  private register(ref: StreamRef, known: StoredStream | null): number {
    this.ctx.storage.sql.exec(
      `INSERT INTO stream (shard, incarnation, watermark, logged, prev_incarnation) VALUES (?, ?, 0, 0, ?)
       ON CONFLICT (shard) DO UPDATE SET incarnation = excluded.incarnation, watermark = 0, logged = 0,
         prev_incarnation = excluded.prev_incarnation`,
      ref.shard, ref.incarnation, known?.incarnation ?? null,
    )
    return this.record('register_stream', [], [], { shard: ref.shard, incarnation: ref.incarnation, seq: 0 })
  }

  async addUnit(unit: FlushUnit): Promise<AddUnitResult> {
    const g = this.gate()
    if (g) await g
    // The unit itself is judged first, so a malformed request is `invalid` whatever the
    // stream's state, and never mistaken for a replay.
    const invalid = (reason: string): AddUnitResult => ({ status: 'invalid', reason })
    const problem = refProblem(unit)
    if (problem) return invalid(problem)
    if (!Number.isSafeInteger(unit.seqLo) || !Number.isSafeInteger(unit.seqHi) || unit.seqLo < 1 || unit.seqHi < unit.seqLo) {
      return invalid('bad sequence range')
    }
    const bad = filesProblem(unit.files, this.keyPrefix)
    if (bad) return invalid(bad)
    if (unit.files.length === 0) return invalid('a unit must have at least one file')
    if (unit.files.length > PRECEDENCE_PER_VERSION) return invalid(`a unit has at most ${PRECEDENCE_PER_VERSION} files`)
    const ref: UnitRef = { shard: unit.shard, incarnation: unit.incarnation, seqLo: unit.seqLo, seqHi: unit.seqHi }

    const known = this.stream(unit.shard)
    if (!known) {
      // A shard seen for the first time may introduce itself with its first unit. Anything
      // else from an unknown shard is refused: the ledger has no watermark to extend.
      if (unit.seqLo !== 1) return { status: 'not_contiguous', watermark: 0 }
    } else {
      // A different incarnation, higher or lower, is refused here. A higher one must be
      // registered first (`registerStream`); a lower one is stale and can never be.
      if (known.incarnation !== unit.incarnation) return { status: 'incarnation_mismatch', incarnation: known.incarnation }
      // Replay rule (contracts/ledger.ts): the watermark is already at or past this unit, so
      // its rows are in listed files, whether or not these particular files still are (they
      // may have been compacted or expired since). Nothing changes.
      if (unit.seqHi <= known.watermark) return { status: 'ok', version: this.version(), watermark: known.watermark }
      if (unit.seqLo !== known.watermark + 1) return { status: 'not_contiguous', watermark: known.watermark }
    }
    // Past the replay check, a key that is already live belongs to some other unit or to a
    // compaction output. Checked for every file before anything is written.
    for (const f of unit.files) {
      if (this.liveFile(f.key)) return invalid(`file key already live in another unit: ${f.key}`)
    }
    // The state must stay small enough to be written as one base or checkpoint and rebuilt in
    // one isolate (review S-2). Only new files are refused; compaction and retention shrink it.
    const adding = unit.files.reduce((n, f) => n + entryBytes(f), 0)
    const stateBytes = this.meta('state_bytes') ?? 0
    if (stateBytes + adding > this.stateMaxBytes) {
      console.error(`ledger ${this.tenant}: full: ${stateBytes} + ${adding} bytes of state would exceed ${this.stateMaxBytes}; unit ${unit.shard} ${unit.seqLo}..${unit.seqHi} refused`)
      return { status: 'full', stateBytes, limitBytes: this.stateMaxBytes }
    }

    const version = this.ctx.storage.transactionSync(() => {
      this.setMeta('state_bytes', (this.meta('state_bytes') ?? 0) + adding)
      if (!known) this.register(unit, null)
      // Precedence (contracts/ledger.ts `LiveFile`): the version this change is about to get.
      // Units of a stream are admitted in sequence order, so a later write ranks higher.
      const v = this.version() + 1
      const listed = unit.files.map((f, i) => asListed(f, v * PRECEDENCE_PER_VERSION + i, v * PRECEDENCE_PER_VERSION + i))
      const tracking = this.tracking()
      for (const f of listed) this.insertFile(f, ref, tracking)
      this.ctx.storage.sql.exec(`UPDATE stream SET watermark = ? WHERE shard = ?`, unit.seqHi, unit.shard)
      const recorded = this.record('add_unit', listed, [], { shard: unit.shard, incarnation: unit.incarnation, seq: unit.seqHi }, { seqLo: unit.seqLo, seqHi: unit.seqHi })
      if (recorded !== v) throw new Error('ledger: version moved inside a transaction')
      return recorded
    })
    this.afterCommit()
    return { status: 'ok', version, watermark: unit.seqHi }
  }

  async plan(req: PlanRequest): Promise<Plan> {
    const g = this.gate()
    if (g) await g
    if (!TABLES.includes(req.table)) throw new Error('ledger: unknown table')
    // No await between these reads, so they see one version.
    const sql = this.ctx.storage.sql
    const files = sql
      // In precedence order: the order a reader hands files to the engine, later wins.
      .exec(`SELECT * FROM file WHERE tbl = ? AND max_ts >= ? AND min_ts <= ? ORDER BY prec, key`, req.table, req.minTs, req.maxTs)
      .toArray()
      .map(toEntry)
    const watermarks = sql
      .exec(`SELECT shard, incarnation, watermark FROM stream ORDER BY shard`)
      .toArray()
      .map((r): Watermark => ({ shard: r.shard as string, incarnation: r.incarnation as number, seq: r.watermark as number }))
    return { ledgerIncarnation: this.ledgerIncarnation(), version: this.version(), files, watermarks }
  }

  async replace(req: ReplaceRequest): Promise<ReplaceResult> {
    const g = this.gate()
    if (g) await g
    const invalid = (reason: string): ReplaceResult => ({ status: 'invalid', reason })
    if (typeof req !== 'object' || req === null) return invalid('request is not an object')
    if (!Array.isArray(req.remove) || req.remove.some((k) => typeof k !== 'string' || k === '')) {
      return invalid('remove must be a list of keys')
    }
    const bad = filesProblem(req.add, this.keyPrefix)
    if (bad) return invalid(bad)
    const remove = [...new Set(req.remove)]
    if (remove.length === 0 && req.add.length === 0) return { status: 'ok', version: this.version() }
    for (const f of req.add) {
      if (remove.includes(f.key)) return invalid(`key is in both remove and add: ${f.key}`)
    }

    const missing = remove.filter((k) => !this.liveFile(k))
    // Replay rule: a retry of a swap that already happened is `ok` if every output is live
    // and no input is. Anything else is judged as a new request, below.
    if (req.add.length > 0 && missing.length === remove.length && req.add.every((f) => this.liveFile(f.key))) {
      return { status: 'ok', version: this.version() }
    }
    if (missing.length > 0) return { status: 'conflict', missing }
    for (const f of req.add) {
      if (this.liveFile(f.key)) return invalid(`file key already live: ${f.key}`)
    }

    // Precedence (contracts/ledger.ts `LiveFile`): an output covers the range of the inputs
    // of its table and day, and is admitted only if no other live file that could share a
    // row with it (same table and day, overlapping time range) has a range inside that.
    const inputs = remove.map((k) => this.liveFile(k)!)
    if (req.add.length > PRECEDENCE_PER_VERSION) return invalid(`a replace adds at most ${PRECEDENCE_PER_VERSION} files`)
    const next = (this.version() + 1) * PRECEDENCE_PER_VERSION
    const outputs = req.add.map((f, n) => {
      const from = inputs.filter((i) => i.table === f.table && i.day === f.day)
      return from.length === 0
        ? asListed(f, next + n, next + n)
        : asListed(f, Math.min(...from.map((i) => i.precedenceLow)), Math.max(...from.map((i) => i.precedence)))
    })
    const removing = new Set(remove)
    const blocking = new Set<string>()
    for (const o of outputs) {
      const rows = this.ctx.storage.sql
        .exec(`SELECT key FROM file WHERE tbl = ? AND day = ? AND max_ts >= ? AND min_ts <= ? AND prec >= ? AND prec_lo <= ?`,
          o.table, o.day, o.minTs, o.maxTs, o.precedenceLow, o.precedence)
        .toArray()
      for (const r of rows) if (!removing.has(r.key as string)) blocking.add(r.key as string)
    }
    if (blocking.size > 0) return { status: 'conflict', missing: [], blocking: [...blocking].sort() }

    const version = this.ctx.storage.transactionSync(() => {
      const delta = outputs.reduce((n, f) => n + entryBytes(f), 0) - inputs.reduce((n, f) => n + entryBytes(f), 0)
      this.setMeta('state_bytes', Math.max(0, (this.meta('state_bytes') ?? 0) + delta))
      const gone = inputs.map((f) => ({ key: f.key, table: f.table }))
      this.bury(gone)
      const tracking = this.tracking()
      for (const k of remove) {
        if (tracking) this.preimageOfDeleted('f.key = ?', k)
        this.ctx.storage.sql.exec(`DELETE FROM file WHERE key = ?`, k)
      }
      for (const f of outputs) this.insertFile(f, null, tracking)
      return this.record('replace', outputs, gone)
    })
    this.afterCommit()
    return { status: 'ok', version }
  }

  async expire(req: ExpireRequest): Promise<{ version: number; removed: string[] }> {
    const g = this.gate()
    if (g) await g
    // One table (`table`) or several (`tables`): every named table's old days leave in ONE
    // change, so a samples file and its series file leave together (contracts/TABLES.md).
    const tables = 'tables' in req && req.tables !== undefined ? req.tables : [(req as { table: Table }).table]
    if (!Array.isArray(tables) || tables.length === 0 || tables.some((t) => !TABLES.includes(t))) throw new Error('ledger: unknown table')
    if (typeof req.beforeDay !== 'string' || !DAY.test(req.beforeDay)) throw new Error('ledger: beforeDay must be YYYY-MM-DD')
    const sql = this.ctx.storage.sql
    const named = [...new Set(tables)]
    const result = this.ctx.storage.transactionSync(() => {
      const gone: { key: string; table: Table }[] = []
      for (const table of named) {
        for (const r of sql.exec(`SELECT key FROM file WHERE tbl = ? AND day < ? ORDER BY key`, table, req.beforeDay)) gone.push({ key: r.key as string, table })
      }
      if (gone.length === 0) return null
      this.bury(gone)
      let freed = 0
      for (const table of named) freed += sql.exec(`SELECT ${ENTRY_BYTES_SQL} AS b FROM file WHERE tbl = ? AND day < ?`, table, req.beforeDay).one().b as number
      this.setMeta('state_bytes', Math.max(0, (this.meta('state_bytes') ?? 0) - freed))
      const tracking = this.tracking()
      for (const table of named) {
        if (tracking) this.preimageOfDeleted('f.tbl = ? AND f.day < ?', table, req.beforeDay)
        sql.exec(`DELETE FROM file WHERE tbl = ? AND day < ?`, table, req.beforeDay)
      }
      return { version: this.record('expire', [], gone), removed: gone.map((x) => x.key) }
    })
    if (!result) return { version: this.version(), removed: [] }
    this.afterCommit()
    return result
  }

  async loggedWatermarks(): Promise<LoggedWatermark[]> {
    const g = this.gate()
    if (g) await g
    return this.loggedStreams()
  }

  // ───────────────────────────── LedgerJanitorRpc ─────────────────────────────

  private static toTombstone(r: Row): Tombstone {
    return { key: r.key as string, table: r.tbl as Table, version: r.version as number, at: r.at as number }
  }

  /** The lowest version still in the outbox: everything below it is in R2. */
  private firstUnlogged(): number {
    const v = this.ctx.storage.sql.exec(`SELECT MIN(version) AS v FROM outbox`).one().v as number | null
    return v ?? Number.MAX_SAFE_INTEGER
  }

  async deletable(req: { minAgeMs: number; limit?: number }): Promise<{ tombstones: Tombstone[]; waiting: number }> {
    const g = this.gate()
    if (g) await g
    if (typeof req?.minAgeMs !== 'number' || !(req.minAgeMs >= 0)) throw new Error('ledger: minAgeMs must be a non-negative number')
    const limit = Math.min(Math.max(1, Math.floor(req.limit ?? 1000)), 10_000)
    const sql = this.ctx.storage.sql
    // One synchronous read: logged (the removing version is below everything in the
    // outbox), old enough by this object's clock, and not live.
    const tombstones = sql
      .exec(
        `SELECT t.key, t.tbl, t.version, t.at FROM tombstone t
         WHERE t.version < ? AND t.at <= ? AND NOT EXISTS (SELECT 1 FROM file f WHERE f.key = t.key)
         ORDER BY t.version, t.key LIMIT ?`,
        this.firstUnlogged(), Date.now() - req.minAgeMs, limit,
      )
      .toArray()
      .map(Ledger.toTombstone)
    const total = sql.exec(`SELECT COUNT(*) AS n FROM tombstone`).one().n as number
    return { tombstones, waiting: total - tombstones.length }
  }

  async forget(keys: string[]): Promise<{ forgotten: number }> {
    const g = this.gate()
    if (g) await g
    if (!Array.isArray(keys) || keys.some((k) => typeof k !== 'string')) throw new Error('ledger: keys must be a list of strings')
    const sql = this.ctx.storage.sql
    let forgotten = 0
    this.ctx.storage.transactionSync(() => {
      for (const k of keys) {
        if (this.liveFile(k)) continue
        forgotten += sql.exec(`DELETE FROM tombstone WHERE key = ?`, k).rowsWritten
      }
    })
    return { forgotten }
  }

  async removedSince(version: number, limit = 1000): Promise<Tombstone[]> {
    const g = this.gate()
    if (g) await g
    return this.ctx.storage.sql
      .exec(`SELECT key, tbl, version, at FROM tombstone WHERE version > ? ORDER BY version, key LIMIT ?`, version, Math.min(Math.max(1, Math.floor(limit)), 10_000))
      .toArray()
      .map(Ledger.toTombstone)
  }

  async orphanCheck(keys: string[]): Promise<OrphanCheck> {
    const g = this.gate()
    if (g) await g
    if (!Array.isArray(keys) || keys.some((k) => typeof k !== 'string')) throw new Error('ledger: keys must be a list of strings')
    const sql = this.ctx.storage.sql
    // No await: the three answers describe one instant.
    const live = keys.filter((k) => this.liveFile(k) !== null)
    const tombstoned = keys.filter((k) => sql.exec(`SELECT 1 AS x FROM tombstone WHERE key = ?`, k).toArray().length > 0)
    const logged = this.loggedStreams()
    return { live, tombstoned, logged }
  }

  // ───────────────────────────── change log: drain ─────────────────────────────

  private objectKey(cellRelative: string): string {
    return `${this.cell}/${cellRelative}`
  }

  /**
   * Write pending changes to R2 now, as segments (what the alarm does). Returns the number
   * of changes written.
   */
  async drain(): Promise<{ written: number }> {
    const g = this.gate()
    if (g) await g
    // Asked for now: a checkpoint backing off is tried again too.
    this.checkpointRetryAt = 0
    try {
      const written = await this.drainSerial(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)
      this.stuck = null
      return { written }
    } catch (e) {
      if (e instanceof LogFault) await this.noteStuck(e)
      throw e
    }
  }

  /**
   * A log fault: say so in `logStatus` and the error log (review S-1). One case is healed at
   * once: the outbox does not continue the log AND this segment incarnation holds first-layout
   * objects. That is what a rollback to the release that drains the first layout leaves after
   * the roll-forward; SQLite holds every committed change, including those the old release
   * logged as objects and told shards about, so a new incarnation started from SQLite (its base
   * in R2 first) loses nothing (the protocol model checks this fix: spec/README.md). Any other
   * fault stays stuck until an operator repairs R2 or calls `restartFromSqlite()`.
   */
  private async noteStuck(e: LogFault): Promise<void> {
    const foreign = await this.foreignLayout()
    if (e instanceof LogDiscontinuity && foreign !== '' && !this.needsStart) {
      this.lastError = `${e.message}${foreign}; restarting the incarnation from SQLite`
      console.error(`ledger ${this.tenant}: ${this.lastError}`)
      this.needsStart = 'sqlite'
      this.beginStart()
      return
    }
    this.stuck = `${e.message}${foreign}; operator: repair R2 or call restartFromSqlite()`
    console.error(`ledger ${this.tenant}: log stuck, drain stopped: ${this.stuck}`)
  }

  private drainSerial(maxSegments: number, maxParts: number): Promise<number> {
    const run = this.draining.then(async () => {
      this.drainActive = true
      try {
        const written = await this.drainNow(maxSegments, maxParts)
        // Nothing left to write: the alarm set for it has nothing to do (AGENTS.md: one alarm,
        // deleted when there is nothing to do), unless a checkpoint waits for its backoff. A
        // commit after this check sets a new one.
        if (!this.hasPending()) this.afterDrain()
        return written
      } finally {
        this.drainActive = false
        this.lastDrainEnd = Date.now()
        this.pendingSince = this.hasPending() ? this.lastDrainEnd : null
      }
    })
    this.draining = run.catch(() => undefined)
    return run
  }

  /** A drain whose failure sets the backoff and is reported, not thrown. Returns whether it failed. */
  private async drainWithBackoff(maxSegments: number, maxParts: number): Promise<boolean> {
    try {
      await this.drainSerial(maxSegments, maxParts)
      this.failures = 0
      this.retryNotBefore = 0
      this.stuck = null
      return false
    } catch (e) {
      this.failures++
      this.lastError = e instanceof Error ? e.message : String(e)
      const fault = e instanceof LogFault
      // Stuck, and saying so: nothing more counts as logged (shards keep their rows) until an
      // operator acts. Never written around, never skipped (review S-1).
      if (fault) await this.noteStuck(e)
      const delay = fault ? DRAIN_RETRY_MAX_MS : Math.min(DRAIN_RETRY_MAX_MS, DRAIN_RETRY_MS * 2 ** (this.failures - 1))
      this.retryNotBefore = Date.now() + delay
      return true
    }
  }

  /**
   * The segment to write next: the one recorded in `meta` if a write of it may have
   * happened (a retry must write exactly it: spec F10), else every pending row up to the size
   * cap, whose bounds are recorded here. Null when nothing is pending.
   */
  private nextSegment(): PendingSegment | null {
    const sql = this.ctx.storage.sql
    const inc = this.ledgerIncarnation()
    const recordedFirst = this.meta('seg_first')
    const recordedLast = this.meta('seg_last')
    let rows: { version: number; json: string }[]
    let fresh = false
    let checkpoint: PendingSegment['checkpoint'] = null
    if (recordedFirst !== null && recordedLast !== null) {
      rows = sql
        .exec(`SELECT version, body FROM outbox WHERE version BETWEEN ? AND ? ORDER BY version`, recordedFirst, recordedLast)
        .toArray()
        .map((r) => ({ version: r.version as number, json: r.body as string }))
      if (rows.length !== recordedLast - recordedFirst + 1) {
        throw new LogFault(`the recorded segment ${recordedFirst}..${recordedLast} has ${rows.length} of its rows; refusing to write a different one`)
      }
    } else {
      rows = []
      let bytes = 0
      for (const r of sql.exec(`SELECT version, body FROM outbox ORDER BY version`)) {
        const json = r.body as string
        if (rows.length > 0 && bytes + json.length + 1 > LEDGER_SEGMENT_MAX_BYTES) break
        rows.push({ version: r.version as number, json })
        bytes += json.length + 1
      }
      if (rows.length === 0) return null
      const loggedThrough = this.meta('logged_through')
      if (loggedThrough === null || rows[0]!.version !== loggedThrough + 1) {
        throw new LogDiscontinuity(`the outbox starts at version ${rows[0]!.version}, the log ends at ${loggedThrough}`)
      }
      const first = rows[0]!.version
      const last = rows[rows.length - 1]!.version
      this.ctx.storage.transactionSync(() => {
        this.setMeta('seg_first', first)
        this.setMeta('seg_last', last)
      })
      fresh = true
    }
    const first = rows[0]!.version
    const last = rows[rows.length - 1]!.version
    const body = encodeLedgerSegment(this.tenant, inc, rows)
    // A checkpoint is the state at the end of this segment: only possible when the segment ends at
    // the committed version, and fixed in this same synchronous step. Taken after at least
    // `checkpointEvery` segments AND once the log written since the last checkpoint (or the base)
    // is at least as large as it, so checkpoints cost at most as much R2 as the log (review S-2).
    // A small state is written as before, in one object built now (format 1). A larger one is
    // only BEGUN here: its parts are written by later drain steps, from the state at this version
    // (format 2; D47), and nothing holds the whole state.
    if (fresh && this.checkpointRow() === null && (this.meta('segs_since_ckpt') ?? 0) + 1 >= this.checkpointEvery && last === this.version()
      && (!this.checkpointByLogBytes || (this.meta('log_bytes_since_ckpt') ?? 0) + body.length >= (this.meta('ckpt_bytes') ?? 0))) {
      if ((this.meta('state_bytes') ?? 0) <= this.checkpointOneObjectBytes) {
        // The exact size of the state, now that it is read (the running estimate can drift).
        this.setMeta('state_bytes', this.ctx.storage.sql.exec(`SELECT ${ENTRY_BYTES_SQL} AS b FROM file`).one().b as number)
        const json = [...this.baseChunks(inc, last, Date.now())].join('')
        checkpoint = { version: last, body: encodeLedgerSegment(this.tenant, inc, [{ version: last, json }], LEDGER_CHECKPOINT_KIND) }
      } else this.beginCheckpoint(inc, last)
    }
    return {
      incarnation: inc,
      first,
      last,
      key: this.objectKey(ledgerSegmentKey(this.tenant, inc, first, last)),
      body,
      rows,
      fresh,
      checkpoint,
    }
  }

  /**
   * Segments first, then a step of the checkpoint in progress, and again: a part never waits
   * behind the log, and the log waits for at most one part's PUT.
   */
  private async drainNow(maxSegments: number, maxParts: number): Promise<number> {
    let written = 0
    let segments = 0
    let parts = 0
    for (;;) {
      const seg = segments < maxSegments ? this.nextSegment() : null
      if (seg) {
        segments++
        // The recorded bounds must survive a crash during the PUT, or a retry could choose others.
        if (seg.fresh) await this.ctx.storage.sync()
        const t0 = Date.now()
        await this.putLogObject(seg.key, seg.body)
        const ms = Date.now() - t0
        this.segmentsWritten++
        this.segmentWriteMs = { last: ms, max: Math.max(this.segmentWriteMs.max, ms) }
        this.ctx.storage.transactionSync(() => this.segmentWritten(seg))
        written += seg.rows.length
        if (seg.checkpoint) await this.writeCheckpoint(seg.checkpoint, seg.incarnation)
        continue
      }
      if (parts < maxParts && (await this.checkpointStep())) {
        parts++
        continue
      }
      return written
    }
  }

  /** In one transaction with nothing else: the segment is in R2; its rows go, the marks move. */
  private segmentWritten(seg: PendingSegment): void {
    // A drain of an incarnation that has since been replaced (an operator emptied storage and
    // rebuilt while its PUT was in flight) must not touch the new one's rows (review S-7).
    if (this.meta('incarnation') !== seg.incarnation) return
    const sql = this.ctx.storage.sql
    sql.exec(`DELETE FROM outbox WHERE version BETWEEN ? AND ?`, seg.first, seg.last)
    for (const r of seg.rows) {
      const w = (JSON.parse(r.json) as LedgerChange).watermark
      // The incarnation test keeps a late change of a replaced stream from moving the new one.
      if (w) sql.exec(`UPDATE stream SET logged = MAX(logged, ?) WHERE shard = ? AND incarnation = ?`, w.seq, w.shard, w.incarnation)
    }
    this.setMeta('logged_through', seg.last)
    this.dropMeta('seg_first')
    this.dropMeta('seg_last')
    this.setMeta('segs_since_ckpt', (this.meta('segs_since_ckpt') ?? 0) + 1)
    this.setMeta('log_bytes_since_ckpt', (this.meta('log_bytes_since_ckpt') ?? 0) + seg.body.length)
  }

  /** A format-1 checkpoint (a small state, one object), after the segment that ends at its version. */
  private async writeCheckpoint(c: { version: number; body: string }, inc: number): Promise<void> {
    try {
      await this.putLogObject(this.objectKey(ledgerCheckpointKey(this.tenant, inc, c.version)), c.body)
      if (this.meta('incarnation') !== inc) return
      this.ctx.storage.transactionSync(() => {
        this.setMeta('segs_since_ckpt', 0)
        this.setMeta('log_bytes_since_ckpt', 0)
        this.setMeta('ckpt_bytes', c.body.length)
      })
    } catch (e) {
      // Only an accelerator: the next segment that ends at the committed version tries again.
      console.error(`ledger ${this.tenant}: checkpoint at ${c.version} not written: ${e instanceof Error ? e.message : String(e)}`)
      return
    }
    await this.deleteSuperseded(inc, c.version, null)
  }

  // ───────────────────────────── checkpoints in parts (format 2) ─────────────────────────────

  /** The checkpoint in progress, if any. */
  private checkpointRow(): CheckpointRow | null {
    const r = this.ctx.storage.sql.exec(`SELECT * FROM ckpt WHERE id = 1`).toArray()[0]
    if (!r) return null
    return {
      incarnation: r.incarnation as number, version: r.version as number, attempt: r.attempt as string, at: r.at as number,
      phase: r.phase as CheckpointRow['phase'], fileCursor: r.file_cursor as string, tombCursor: r.tomb_cursor as string,
      parts: r.parts as number, files: r.files as number, tombstones: r.tombstones as number, bytes: r.bytes as number,
      tracked: r.tracked as number, streams: JSON.parse(r.streams as string) as CheckpointRow['streams'],
    }
  }

  /**
   * Begin a checkpoint of the state at `version`, which is the committed version now (called in
   * the synchronous step that fixes the segment ending there). Only the streams are read now;
   * files and tombstones are read part by part later, and every mutation from here on keeps the
   * pre-image of a file it changes ahead of the checkpoint's cursor (`ckpt_pre`), so a part is
   * always the state at `version`.
   */
  private beginCheckpoint(inc: number, version: number): void {
    const sql = this.ctx.storage.sql
    const rows = sql.exec(`SELECT shard, incarnation, watermark, prev_incarnation FROM stream ORDER BY shard`).toArray()
    const streams: CheckpointRow['streams'] = {
      watermarks: rows.map((r) => ({ shard: r.shard as string, incarnation: r.incarnation as number, seq: r.watermark as number })),
      previousIncarnations: rows.filter((r) => r.prev_incarnation !== null).map((r) => ({ shard: r.shard as string, previousIncarnation: r.prev_incarnation as number })),
    }
    const attempt = (crypto.getRandomValues(new Uint32Array(1))[0]! >>> 0).toString(16).padStart(8, '0')
    this.ctx.storage.transactionSync(() => {
      sql.exec(`DELETE FROM ckpt_pre`)
      sql.exec(
        `INSERT OR REPLACE INTO ckpt (id, incarnation, version, attempt, at, phase, file_cursor, tomb_cursor, parts, files, tombstones, bytes, tracked, streams)
         VALUES (1, ?, ?, ?, ?, 'files', '', '', 0, 0, 0, 0, ?, ?)`,
        inc, version, attempt, Date.now(), version, JSON.stringify(streams),
      )
    })
  }

  /**
   * A checkpoint write failed. Only an accelerator: it never fails or delays the drain of the log;
   * it is tried again after a backoff (1 s doubling to 60 s), from where it stood.
   */
  private checkpointFailed(ck: CheckpointRow, e: unknown): void {
    this.checkpointFailures++
    this.checkpointRetryAt = Date.now() + Math.min(DRAIN_RETRY_MAX_MS, DRAIN_RETRY_MS * 2 ** (this.checkpointFailures - 1))
    console.error(`ledger ${this.tenant}: checkpoint at ${ck.version}, part ${ck.parts}: not written (${e instanceof Error ? e.message : String(e)}); again in ${this.checkpointRetryAt - Date.now()} ms`)
  }

  /** Drop the checkpoint in progress (its parts stay in R2 until the next checkpoint's sweep). */
  private abandonCheckpoint(why: string): void {
    console.error(`ledger ${this.tenant}: checkpoint abandoned: ${why}`)
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(`DELETE FROM ckpt`)
      this.ctx.storage.sql.exec(`DELETE FROM ckpt_pre`)
    })
  }

  /**
   * The next part of the checkpoint in progress, read in one synchronous step: the files after
   * its cursor as they were at its version (`file`, except where `ckpt_pre` holds a pre-image or
   * says the key was not live then), in key order, then the tombstones of removals at or below
   * its version, until the part holds `checkpointPartBytes`.
   */
  private buildPart(ck: CheckpointRow): { body: string; records: number; files: number; tombstones: number; fileCursor: string; tombCursor: string; phase: CheckpointRow['phase'] } {
    const sql = this.ctx.storage.sql
    const lines: string[] = []
    let size = 0
    let files = 0
    let tombstones = 0
    let { phase, fileCursor, tombCursor } = ck
    // A record goes in unless the part already holds one and it would take the part past its
    // budget: a part is at most `checkpointPartBytes`, or one larger record alone.
    const fits = (line: string) => lines.length === 0 || size + line.length + 1 <= this.checkpointPartBytes
    const add = (line: string) => {
      lines.push(line)
      size += line.length + 1
    }
    let open = true
    if (phase === 'files') {
      const live = sql.exec(`SELECT ${FILE_COLUMNS} FROM file WHERE key > ? ORDER BY key`, fileCursor)[Symbol.iterator]()
      const pre = sql.exec(`SELECT absent, ${FILE_COLUMNS} FROM ckpt_pre WHERE key > ? ORDER BY key`, fileCursor)[Symbol.iterator]()
      let a = live.next()
      let b = pre.next()
      for (;;) {
        if (a.done && b.done) {
          phase = 'tombstones'
          break
        }
        // The next key in SQLite's order, from `file` or from a pre-image (which wins: it is the
        // state at the checkpoint's version, or says the key was not live then).
        const c = a.done ? 1 : b.done ? -1 : compareKeys(a.value.key as string, b.value.key as string)
        const row = c < 0 ? (a.value as Row) : b.value.absent === 0 ? (b.value as Row) : null
        if (row) {
          const { unit, ...entry } = toStored(row)
          const line = JSON.stringify({ file: unit ? { ...entry, unit } : entry })
          if (!fits(line)) {
            open = false
            break
          }
          add(line)
          files++
        }
        fileCursor = (c < 0 ? a.value.key : b.value.key) as string
        if (c >= 0) b = pre.next()
        if (c <= 0) a = live.next()
      }
    }
    if (phase === 'tombstones' && open) {
      let more = false
      for (const r of sql.exec(`SELECT key, tbl, version, at FROM tombstone WHERE version <= ? AND key > ? ORDER BY key`, ck.version, tombCursor)) {
        const line = JSON.stringify({ tombstone: Ledger.toTombstone(r) })
        if (!fits(line)) {
          more = true
          break
        }
        add(line)
        tombstones++
        tombCursor = r.key as string
      }
      if (!more) phase = 'manifest'
    }
    const body = lines.length > 0 ? encodeLedgerCheckpointPart(this.tenant, ck.incarnation, ck.version, ck.attempt, ck.parts, lines) : ''
    return { body, records: lines.length, files, tombstones, fileCursor, tombCursor, phase }
  }

  /**
   * One step of the checkpoint in progress: write its next part, or (once every part is written
   * and the log has reached its version) its manifest, which completes it; then delete the
   * checkpoints it supersedes. False when there is nothing to do now.
   */
  private async checkpointStep(): Promise<boolean> {
    const ck = this.checkpointRow()
    if (!ck || Date.now() < this.checkpointRetryAt) return false
    const inc = this.meta('incarnation')
    if (ck.incarnation !== inc) {
      this.abandonCheckpoint(`it belongs to incarnation ${ck.incarnation}, this is ${inc}`)
      return false
    }
    if (ck.tracked !== this.version()) {
      // Versions committed without pre-images (a release that does not know checkpoints in parts
      // ran on this storage): the parts still to write could not be the state at its version.
      this.abandonCheckpoint(`changes after version ${ck.tracked} were not tracked (the ledger is at ${this.version()})`)
      return false
    }
    const sql = this.ctx.storage.sql
    if (ck.phase === 'manifest') {
      // Never ahead of the log: the segment that ends at its version is written first.
      if ((this.meta('logged_through') ?? -1) < ck.version) return false
      const manifest: LedgerCheckpointManifest = {
        ledgerIncarnation: inc, version: ck.version, at: ck.at, attempt: ck.attempt, parts: ck.parts, files: ck.files, tombstones: ck.tombstones, bytes: ck.bytes,
        watermarks: ck.streams.watermarks, previousIncarnations: ck.streams.previousIncarnations,
      }
      const body = encodeLedgerCheckpointManifest(this.tenant, manifest)
      try {
        await this.putLogObject(this.objectKey(ledgerCheckpointKey(this.tenant, inc, ck.version)), body)
      } catch (e) {
        // Another manifest at this version (another attempt's): this one is not needed.
        if (e instanceof LogFault) this.abandonCheckpoint(e.message)
        else this.checkpointFailed(ck, e)
        return false
      }
      this.checkpointFailures = 0
      // The manifest is in R2: the checkpoint exists. Only now may older ones go.
      const done = this.ctx.storage.transactionSync(() => {
        if (this.checkpointRow()?.attempt !== ck.attempt || this.meta('incarnation') !== inc) return false
        sql.exec(`DELETE FROM ckpt`)
        sql.exec(`DELETE FROM ckpt_pre`)
        this.setMeta('segs_since_ckpt', 0)
        this.setMeta('log_bytes_since_ckpt', 0)
        this.setMeta('ckpt_bytes', ck.bytes + body.length)
        return true
      })
      if (done) await this.deleteSuperseded(inc, ck.version, ck.attempt)
      return true
    }
    const part = this.buildPart(ck)
    let bytes = 0
    if (part.records > 0) {
      // Not conditional: a part means nothing until a manifest names it, and a retry of this
      // attempt writes the same records (the state at the checkpoint's version, from the same cursor).
      try {
        const put = await this.bucket.put(this.objectKey(ledgerCheckpointPartKey(this.tenant, inc, ck.version, ck.attempt, ck.parts)), part.body, {
          httpMetadata: { contentType: 'application/x-ndjson' },
        })
        bytes = put?.size ?? part.body.length
      } catch (e) {
        this.checkpointFailed(ck, e)
        return false
      }
      this.checkpointFailures = 0
    }
    this.ctx.storage.transactionSync(() => {
      sql.exec(
        `UPDATE ckpt SET phase = ?, file_cursor = ?, tomb_cursor = ?, parts = parts + ?, files = files + ?, tombstones = tombstones + ?, bytes = bytes + ?
         WHERE id = 1 AND incarnation = ? AND attempt = ? AND parts = ?`,
        part.phase, part.fileCursor, part.tombCursor, part.records > 0 ? 1 : 0, part.files, part.tombstones, bytes, inc, ck.attempt, ck.parts,
      )
    })
    return true
  }

  /**
   * After the checkpoint at `version` (with parts of `attempt`, or none) is complete in R2: delete
   * the manifests of older checkpoints of the incarnation, then every part that is not this
   * checkpoint's (older checkpoints', and abandoned attempts'). Manifests go first, so no listed
   * checkpoint ever names a part that is gone. A failure leaves the rest for the next checkpoint.
   */
  private async deleteSuperseded(inc: number, version: number, attempt: string | null): Promise<void> {
    try {
      const keys = await this.listKeys(this.objectKey(`${ledgerIncarnationPrefix(this.tenant, inc)}ckpt-`))
      const manifests: string[] = []
      const parts: string[] = []
      for (const k of keys) {
        const p = parseLedgerLogKey(k)
        if (p?.type === 'checkpoint' && p.version < version) manifests.push(k)
        else if (p?.type === 'checkpoint_part' && p.version <= version && !(p.version === version && p.attempt === attempt)) parts.push(k)
      }
      for (const list of [manifests, parts]) {
        for (let i = 0; i < list.length; i += 1000) await this.bucket.delete(list.slice(i, i + 1000))
      }
    } catch (e) {
      console.error(`ledger ${this.tenant}: superseded checkpoints not deleted: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /**
   * Write one immutable log object with `If-None-Match: *`. An object already there counts
   * as written only if its bytes are these; any other bytes are a fault (never overwritten).
   */
  private async putLogObject(key: string, body: string): Promise<void> {
    // The string itself, not an encoded copy: a base or checkpoint can be large (review S-2).
    const created = await this.bucket.put(key, body, {
      onlyIf: { etagDoesNotMatch: '*' },
      httpMetadata: { contentType: 'application/x-ndjson' },
    })
    if (created !== null) return
    const existing = await this.bucket.get(key)
    if (existing === null) throw new Error(`ledger: ${key} was refused as existing but is not there; retry`)
    const bytes = new TextEncoder().encode(body)
    const there = new Uint8Array(await existing.arrayBuffer())
    if (there.length !== bytes.length || !there.every((b, i) => b === bytes[i])) {
      throw new LogFault(`${key} exists with other bytes (${there.length} vs ${bytes.length}); not overwritten`)
    }
  }

  async alarm(): Promise<void> {
    this.alarmAt = null
    if (this.refusal) {
      this.setAlarmAt(Date.now() + this.refusal.retryAfterMs)
      return
    }
    if (this.corrupt) return
    if (this.needsStart) {
      // A start that failed (or never ran): try it here, outside any request.
      if (!this.starting) this.beginStart()
      await this.starting?.catch(() => undefined)
      return
    }
    const failed = await this.drainWithBackoff(SEGMENTS_PER_ALARM, CHECKPOINT_PARTS_PER_ALARM)
    if (this.hasPending()) {
      this.scheduleDrain(failed ? this.retryNotBefore - Date.now() : 0)
    } else {
      // An alarm set by a mutation during the drain, whose change this drain already wrote, goes;
      // a checkpoint waiting for its backoff keeps one.
      this.afterDrain()
    }
  }

  /** Changes committed but not yet written to R2. */
  async outboxDepth(): Promise<number> {
    const g = this.gate()
    if (g) await g
    return this.ctx.storage.sql.exec(`SELECT COUNT(*) AS n FROM outbox`).one().n as number
  }

  /**
   * Whether this incarnation's prefix also holds first-layout objects (`{version}.json` or
   * `base.json`): what a release that drained the first layout leaves behind after a rollback
   * across this one. Text for the stuck reason; empty when none (or R2 cannot say).
   */
  private async foreignLayout(): Promise<string> {
    try {
      const inc = this.meta('incarnation')
      if (inc === null) return ''
      const prefix = this.objectKey(ledgerIncarnationPrefix(this.tenant, inc))
      const first = (await this.bucket.list({ prefix, limit: 1 })).objects[0]?.key
      return first && (CHANGE_OBJECT.test(first) || first.endsWith('/base.json'))
        ? `; this segment incarnation also holds first-layout objects (from ${first.slice(prefix.length)}): a release that drains the first layout has run on this storage`
        : ''
    } catch {
      return ''
    }
  }

  /** Operator view of the log. Answers while starting, too. */
  async logStatus(): Promise<LogStatus> {
    const sql = this.ctx.storage.sql
    const ready = !this.refusal && !this.needsStart && !this.corrupt
    const first = ready ? this.meta('seg_first') : null
    const last = ready ? this.meta('seg_last') : null
    const ck = ready ? this.checkpointRow() : null
    let registrationsPending = 0
    if (ready) for (const set of this.pendingRegistrations().values()) registrationsPending += set.size
    const oldest = ready ? sql.exec(`SELECT body FROM outbox ORDER BY version LIMIT 1`).toArray()[0] : undefined
    return {
      phase: this.refusal ? 'refused' : this.corrupt ? 'corrupt' : this.stuck ? 'stuck' : this.needsStart ? 'starting' : 'ready',
      ledgerIncarnation: ready ? this.meta('incarnation') : null,
      version: ready ? this.version() : 0,
      loggedThrough: ready ? this.meta('logged_through') : null,
      pending: ready ? (sql.exec(`SELECT COUNT(*) AS n FROM outbox`).one().n as number) : 0,
      inFlight: first !== null && last !== null ? { first, last } : null,
      segmentsSinceCheckpoint: ready ? (this.meta('segs_since_ckpt') ?? 0) : 0,
      alarmAt: this.alarmAt,
      lastError: this.corrupt ?? this.lastError,
      segmentsWritten: this.segmentsWritten,
      segmentWriteMs: this.segmentWriteMs,
      stuck: this.stuck,
      stateBytes: ready ? (this.meta('state_bytes') ?? 0) : 0,
      stateLimitBytes: this.stateMaxBytes,
      checkpoint: ck ? { version: ck.version, phase: ck.phase, parts: ck.parts, files: ck.files, tombstones: ck.tombstones, bytes: ck.bytes } : null,
      registrationsPending,
      pendingSince: oldest ? ((JSON.parse(oldest.body as string) as LedgerChange).at ?? null) : null,
    }
  }

  // ───────────────────────────── incarnations and rebuild ─────────────────────────────

  /**
   * Rebuild an empty ledger from R2 and start a new ledger incarnation. Refuses unless there
   * are no live files, no streams and nothing in the outbox. This runs by itself when the
   * object starts on storage that has no incarnation; calling it by hand is for an operator
   * who has emptied the ledger (for example with `deleteAll`). See the README for what it
   * guarantees. Waits for the whole rebuild.
   */
  async rebuildFromLog(): Promise<RebuildResult> {
    if (this.refusal) throw new SchemaTooNewError(this.refusal)
    if (this.starting) await this.starting.catch(() => undefined)
    // A drain in flight finishes (or fails) before the storage is judged (review S-7).
    await this.draining
    // Storage may have been emptied under this instance: open (create) the schema again.
    this.refusal = refusalOf(openSchema(this.ctx.storage, LEDGER_SCHEMA))
    if (this.refusal) throw new SchemaTooNewError(this.refusal)
    const sql = this.ctx.storage.sql
    const n = (t: string) => sql.exec(`SELECT COUNT(*) AS n FROM ${t}`).one().n as number
    if (n('file') > 0 || n('stream') > 0 || n('outbox') > 0) throw new Error('ledger: rebuildFromLog requires an empty ledger')
    this.ctx.storage.transactionSync(() => {
      sql.exec(`DELETE FROM meta`)
      this.setMeta('starting', 1)
    })
    this.corrupt = null
    this.needsStart = 'r2'
    this.beginStart()
    return this.starting!
  }

  /**
   * Operator: start a new ledger incarnation from this object's own SQLite state, which holds
   * every committed change. The way out of a stuck log (`logStatus().phase === 'stuck'`) whose
   * outbox no longer continues what was written, for example after a release that drains the
   * first layout ran on this storage (review S-1): the new incarnation's base, written to R2
   * before it commits, holds everything committed, so nothing a shard was told is lost and the
   * drain goes on in the new incarnation. The old incarnation's objects stay; a rebuild reads
   * only the newest incarnation. Waits for the whole start.
   */
  async restartFromSqlite(): Promise<RebuildResult> {
    if (this.refusal) throw new SchemaTooNewError(this.refusal)
    if (this.corrupt) throw new LedgerUnavailableError(this.corrupt, DRAIN_RETRY_MAX_MS)
    if (this.starting) await this.starting.catch(() => undefined)
    if (this.meta('incarnation') === null) throw new Error('ledger: no incarnation in SQLite to restart from; use rebuildFromLog')
    await this.draining
    this.needsStart = 'sqlite'
    this.beginStart()
    return this.starting!
  }

  /** Empty every table of the state (a start from R2 loads it again). */
  private clearState(): void {
    const sql = this.ctx.storage.sql
    this.ctx.storage.transactionSync(() => {
      for (const t of ['file', 'stream', 'tombstone', 'ckpt', 'ckpt_pre']) sql.exec(`DELETE FROM ${t}`)
    })
  }

  /**
   * The `base` change holding the state SQLite holds now, as JSON text in pieces: exactly what
   * `JSON.stringify` of the base gives (its members in the contract's order; files by key,
   * streams by shard, tombstones by version then key), produced a page of rows at a time, so the
   * whole line is never one string unless the caller joins it. A start consumes it across awaits
   * (requests wait at the gate meanwhile, so the rows do not move).
   */
  private *baseChunks(ledgerIncarnation: number, version: number, at: number): Generator<string> {
    const sql = this.ctx.storage.sql
    const PAGE = 512
    yield `{"ledgerIncarnation":${ledgerIncarnation},"version":${version},"at":${at},"kind":"base","added":[`
    let sep = ''
    for (let after = '', more = true; more;) {
      const rows = sql.exec(`SELECT * FROM file WHERE key > ? ORDER BY key LIMIT ?`, after, PAGE).toArray()
      more = rows.length === PAGE
      for (const r of rows) {
        yield `${sep}${JSON.stringify(toEntry(r))}`
        sep = ','
        after = r.key as string
      }
    }
    const streams = sql.exec(`SELECT shard, incarnation, watermark, prev_incarnation FROM stream ORDER BY shard`).toArray()
    yield `],"removed":[],"watermarks":${JSON.stringify(streams.map((r) => ({ shard: r.shard, incarnation: r.incarnation, seq: r.watermark })))}`
    yield `,"previousIncarnations":${JSON.stringify(streams.filter((r) => r.prev_incarnation !== null).map((r) => ({ shard: r.shard, previousIncarnation: r.prev_incarnation })))}`
    yield ',"tombstones":['
    sep = ''
    for (let v = -1, k = '', more = true; more;) {
      const rows = sql
        .exec(
          `SELECT key, tbl, version, at FROM tombstone t WHERE (t.version > ? OR (t.version = ? AND t.key > ?))
             AND NOT EXISTS (SELECT 1 FROM file f WHERE f.key = t.key) ORDER BY t.version, t.key LIMIT ?`,
          v, v, k, PAGE,
        )
        .toArray()
      more = rows.length === PAGE
      for (const r of rows) {
        yield `${sep}${JSON.stringify(Ledger.toTombstone(r))}`
        sep = ','
        v = r.version as number
        k = r.key as string
      }
    }
    yield '],"units":['
    sep = ''
    for (let after = '', more = true; more;) {
      const rows = sql.exec(`SELECT key, u_shard, u_inc, u_lo, u_hi FROM file WHERE key > ? AND u_shard IS NOT NULL ORDER BY key LIMIT ?`, after, PAGE).toArray()
      more = rows.length === PAGE
      for (const r of rows) {
        yield `${sep}${JSON.stringify({ key: r.key, shard: r.u_shard, incarnation: r.u_inc, seqLo: r.u_lo, seqHi: r.u_hi })}`
        sep = ','
        after = r.key as string
      }
    }
    yield ']}'
  }

  /**
   * Write the base segment of a new incarnation (`seg-{version}-{version}`, format 1: the header
   * and one `base` line) from SQLite, in pieces: one pass measures it, a second streams it into
   * a single conditional PUT of exactly that length. Memory holds one piece, not the state.
   * Returns its size. An object already at the key is someone else's start: an error, retried
   * with the next incarnation number.
   */
  private async writeBase(ledgerIncarnation: number, version: number): Promise<number> {
    const at = Date.now()
    const header = `${JSON.stringify({ v: LEDGER_SEGMENT_VERSION, kind: LEDGER_SEGMENT_KIND, tenant: this.tenant, ledgerIncarnation, firstVersion: version, lastVersion: version, changes: 1 })}\n`
    let length = utf8Length(header) + 1
    let since = 0
    for (const piece of this.baseChunks(ledgerIncarnation, version, at)) {
      length += utf8Length(piece)
      since += piece.length
      // Measuring holds nothing, but it is a pass over the whole state: let other events in.
      if (since >= 4 * BASE_WRITE_CHUNK) {
        since = 0
        await new Promise((r) => setTimeout(r, 0))
      }
    }
    const key = this.objectKey(ledgerSegmentKey(this.tenant, ledgerIncarnation, version, version))
    const { readable, writable } = new FixedLengthStream(length)
    const put = this.bucket.put(key, readable, { onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'application/x-ndjson' } })
    const writer = writable.getWriter()
    const encoder = new TextEncoder()
    try {
      let buf = header
      for (const piece of this.baseChunks(ledgerIncarnation, version, at)) {
        buf += piece
        if (buf.length >= BASE_WRITE_CHUNK) {
          await writer.write(encoder.encode(buf))
          buf = ''
        }
      }
      await writer.write(encoder.encode(`${buf}\n`))
      await writer.close()
    } catch (e) {
      await writer.abort(e).catch(() => undefined)
      await put.catch(() => undefined)
      throw e
    }
    if ((await put) === null) throw new Error(`ledger: ${key} already exists (another start of incarnation ${ledgerIncarnation}); retry`)
    return length
  }

  /**
   * Start a new incarnation: its state comes from R2 (storage with no incarnation: a new tenant
   * or storage loss), streamed into SQLite, or is what SQLite holds (storage running an
   * incarnation in the first log layout; an operator's restart). Its base segment is written to
   * R2 from SQLite BEFORE SQLite commits the incarnation, so an incarnation number is never used
   * for two different histories (spec F11). Runs outside `blockConcurrencyWhile`; nothing else
   * commits meanwhile because every request waits in `gate()`.
   */
  private async startIncarnation(mode: 'r2' | 'sqlite'): Promise<RebuildResult> {
    const t0 = Date.now()
    const latest = await this.latestIncarnation()
    let replay: { from: RebuildResult['from']; checkpoint: number | null; changesReplayed: number; segmentsRead: number }
    let version: number
    if (mode === 'sqlite') {
      version = this.version()
      replay = { from: 'sqlite', checkpoint: null, changesReplayed: 0, segmentsRead: 0 }
    } else {
      // No incarnation here: whatever rows an interrupted start left are loaded again.
      this.clearState()
      if (latest === null) {
        // No log at all. A new tenant has no data objects either: every ledger writes its base
        // before it admits a file. Data objects without a log mean the log is not where this
        // ledger looks (a changed CELL, a wrong bucket, a deleted prefix): starting empty would
        // let the sweeps delete live data (review S-5). Refused until someone looks.
        for (const table of TABLES) {
          const data = await this.bucket.list({ prefix: this.objectKey(`data/${table}/tenant=${this.tenant}/`), limit: 1 })
          if (data.objects.length > 0) {
            throw new LogFault(`ledger: no change log for this tenant in R2, but it has data objects (${data.objects[0]!.key}); refusing to start empty over them`)
          }
        }
        version = 0
        replay = { from: 'empty', checkpoint: null, changesReplayed: 0, segmentsRead: 0 }
      } else {
        ;({ version, ...replay } = await this.replayIncarnation(latest))
      }
    }
    // Higher than anything in R2 and than anything this storage has used.
    const incarnation = Math.max(latest ?? 0, this.meta('incarnation') ?? 0) + 1
    const baseBytes = await this.writeBase(incarnation, version)

    const sql = this.ctx.storage.sql
    this.ctx.storage.transactionSync(() => {
      // Everything is in the base now: no change is pending, every watermark is logged, and a
      // checkpoint of the old incarnation is moot.
      sql.exec(`DELETE FROM outbox`)
      sql.exec(`DELETE FROM ckpt`)
      sql.exec(`DELETE FROM ckpt_pre`)
      sql.exec(`UPDATE stream SET logged = watermark`)
      this.setMeta('incarnation', incarnation)
      this.setMeta('version', version)
      this.setMeta('log_format', LOG_FORMAT_SEGMENTS)
      this.setMeta('logged_through', version)
      this.setMeta('segs_since_ckpt', 0)
      this.setMeta('log_bytes_since_ckpt', 0)
      // The base is the first checkpoint: the next is due once the log is as large as it.
      this.setMeta('ckpt_bytes', baseBytes)
      this.setMeta('state_bytes', sql.exec(`SELECT ${ENTRY_BYTES_SQL} AS b FROM file`).one().b as number)
      this.dropMeta('seg_first')
      this.dropMeta('seg_last')
      this.dropMeta('starting')
    })
    const n = (t: string) => sql.exec(`SELECT COUNT(*) AS n FROM ${t}`).one().n as number
    return { ledgerIncarnation: incarnation, version, source: mode === 'sqlite' ? null : latest, ...replay, files: n('file'), streams: n('stream'), ms: Date.now() - t0 }
  }

  /** Highest ledger incarnation with anything in R2, or null. */
  private async latestIncarnation(): Promise<number | null> {
    const prefix = this.objectKey(`ledger/tenant=${this.tenant}/`)
    let latest: number | null = null
    let cursor: string | undefined
    do {
      const page = await this.bucket.list({ prefix, delimiter: '/', cursor })
      for (const p of page.delimitedPrefixes) {
        const name = p.slice(prefix.length, -1)
        if (/^\d+$/.test(name)) latest = Math.max(latest ?? 0, Number(name))
      }
      cursor = page.truncated ? page.cursor : undefined
    } while (cursor)
    return latest
  }

  /** Every object under `prefix` (optionally after `startAfter`), in key order, with its size. */
  private async listObjects(prefix: string, startAfter?: string): Promise<{ key: string; size: number }[]> {
    const out: { key: string; size: number }[] = []
    let cursor: string | undefined
    do {
      const page = await this.bucket.list(cursor ? { prefix, cursor } : { prefix, startAfter })
      for (const o of page.objects) out.push({ key: o.key, size: o.size })
      cursor = page.truncated ? page.cursor : undefined
    } while (cursor)
    return out
  }

  private async listKeys(prefix: string, startAfter?: string): Promise<string[]> {
    return (await this.listObjects(prefix, startAfter)).map((o) => o.key)
  }

  /** Load the state an incarnation's log reaches into SQLite (empty before), in whichever layout it was written. */
  private async replayIncarnation(source: number): Promise<{ version: number; from: RebuildResult['from']; checkpoint: number | null; changesReplayed: number; segmentsRead: number }> {
    const prefix = this.objectKey(ledgerIncarnationPrefix(this.tenant, source))
    const page = await this.bucket.list({ prefix: `${prefix}seg-`, limit: 1 })
    if (page.objects.length === 0) {
      const r = await this.replayObjects(source)
      return { ...r, from: 'objects', checkpoint: null, segmentsRead: 0 }
    }
    // Each incarnation uses one layout; both present is corrupt (LEDGER-LOG.md, "Readers").
    // Per-change objects `{version:012}.json` sort before `base.json`, `ckpt-` and `seg-`, so
    // the first key under the prefix says whether any is there. Refused, never skipped: they
    // are what a release draining the first layout logged here (review S-1).
    const firstKey = (await this.bucket.list({ prefix, limit: 1 })).objects[0]?.key
    if (firstKey && CHANGE_OBJECT.test(firstKey)) {
      throw new LogFault(`ledger: incarnation ${source} holds both segments and first-layout change objects (${firstKey.slice(prefix.length)}); refusing to rebuild from either`)
    }
    if ((await this.bucket.head(this.objectKey(ledgerBaseKey(this.tenant, source)))) !== null) {
      throw new LogFault(`ledger: incarnation ${source} has both segments and a base.json`)
    }
    return { ...(await this.replaySegments(source)), from: 'segments' }
  }

  /** Read and check one segment whole (at most 4 MiB, or one change). Unsupported or corrupt refuses the replay. */
  private async readSegment(key: string): Promise<LedgerChange[]> {
    const parsed = parseLedgerLogKey(key)
    if (parsed?.type !== 'segment') throw new LogFault(`ledger: ${key} is not a segment key`)
    const o = await this.bucket.get(key)
    if (!o) throw new Error(`ledger: log object vanished during rebuild: ${key}`)
    const d = decodeLedgerSegment(await o.text(), { ledgerIncarnation: parsed.ledgerIncarnation, firstVersion: parsed.firstVersion, lastVersion: parsed.lastVersion, tenant: this.tenant })
    if (d.status !== 'ok') throw new LogFault(`ledger: ${key} is ${d.status}: ${d.reason}`)
    return d.changes
  }

  /**
   * Where a `base` (of a segment, a format-1 checkpoint or a `base.json`) goes as it is read,
   * element by element: files and tombstones straight into SQLite; streams, and units that
   * arrive before their file, kept until `finish`. Memory: the streams, not the files.
   */
  private baseSink(): { element: (member: string, el: unknown) => void; finish: (scalars: Record<string, unknown>, expect: { ledgerIncarnation: number; version: number }) => void; files: () => number } {
    const sql = this.ctx.storage.sql
    const watermarks: Watermark[] = []
    const previous = new Map<string, number>()
    const lateUnits = new Map<string, UnitRef>()
    let files = 0
    // Writes go in transactions of a few hundred rows: one commit per row would be most of a
    // rebuild's time (measured: 32,000 files took 15.6 s that way, in local workerd).
    let batch: (() => void)[] = []
    const flush = () => {
      const run = batch
      batch = []
      if (run.length > 0) this.ctx.storage.transactionSync(() => { for (const op of run) op() })
    }
    const later = (op: () => void) => {
      batch.push(op)
      if (batch.length >= this.rebuildBatchRows) flush()
    }
    const fail = (why: string) => new LogFault(`ledger: a base that cannot be read: ${why}`)
    return {
      element: (member, el) => {
        const x = el as Record<string, unknown>
        if (typeof x !== 'object' || x === null) throw fail(`an element of ${member} is not an object`)
        if (member === 'added') {
          const f = x as unknown as LiveFile
          if (typeof f.key !== 'string') throw fail('a file without a key')
          // A base written before precedence existed has none: those files rank below everything later.
          later(() => this.loadFile({ ...f, precedence: f.precedence ?? 0, precedenceLow: f.precedenceLow ?? f.precedence ?? 0 }, null))
          files++
        } else if (member === 'tombstones') {
          const t = x as unknown as Tombstone
          later(() => sql.exec(`INSERT OR REPLACE INTO tombstone (key, tbl, version, at) VALUES (?, ?, ?, ?)`, t.key, t.table, t.version, t.at))
        } else if (member === 'units') {
          const u = x as unknown as UnitRef & { key: string }
          const ref = { shard: u.shard, incarnation: u.incarnation, seqLo: u.seqLo, seqHi: u.seqHi }
          later(() => {
            const hit = sql.exec(`UPDATE file SET u_shard = ?, u_inc = ?, u_lo = ?, u_hi = ? WHERE key = ?`, ref.shard, ref.incarnation, ref.seqLo, ref.seqHi, u.key).rowsWritten
            if (hit === 0) lateUnits.set(u.key, ref)
          })
        } else if (member === 'watermarks') watermarks.push(x as unknown as Watermark)
        else if (member === 'previousIncarnations') previous.set(x.shard as string, x.previousIncarnation as number)
        else if (member !== 'removed') throw fail(`an array member ${JSON.stringify(member)} this code does not know`)
      },
      finish: (scalars, expect) => {
        flush()
        const why = unsupportedLedgerChange(scalars)
        if (why) throw fail(why)
        if (scalars.kind !== 'base' || scalars.ledgerIncarnation !== expect.ledgerIncarnation || scalars.version !== expect.version) {
          throw fail(`it is ${JSON.stringify(scalars.kind)} ${String(scalars.ledgerIncarnation)}/${String(scalars.version)}, expected the base ${expect.ledgerIncarnation}/${expect.version}`)
        }
        this.ctx.storage.transactionSync(() => {
          for (const [key, u] of lateUnits) sql.exec(`UPDATE file SET u_shard = ?, u_inc = ?, u_lo = ?, u_hi = ? WHERE key = ?`, u.shard, u.incarnation, u.seqLo, u.seqHi, key)
          for (const w of watermarks) {
            sql.exec(`INSERT INTO stream (shard, incarnation, watermark, logged, prev_incarnation) VALUES (?, ?, ?, ?, ?)`, w.shard, w.incarnation, w.seq, w.seq, previous.get(w.shard) ?? null)
          }
          // A tombstone of a key that is live again is not one (as a base is written).
          sql.exec(`DELETE FROM tombstone WHERE key IN (SELECT key FROM file)`)
        })
      },
      files: () => files,
    }
  }

  /**
   * Load a checkpoint into SQLite (empty before), whatever its format; returns its version.
   * Format 1: its `base` line, streamed. Format 2: its manifest, then each part, checked against
   * the manifest, inserted a part at a time. Throws if it cannot be read whole; the caller then
   * empties the tables and tries an older checkpoint, or the base.
   */
  private async loadCheckpoint(key: string, source: number, version: number): Promise<number> {
    const o = await this.bucket.get(key)
    if (!o) throw new Error(`ledger: checkpoint vanished during rebuild: ${key}`)
    let header: LedgerSegmentHeader | null = null
    const sink = this.baseSink()
    const arrays = { watermarks: [] as unknown[], previousIncarnations: [] as unknown[] }
    const { lines, streamed } = await readLedgerLogStream(
      o.body,
      1,
      (member, el) => {
        if (header!.v === 1) sink.element(member, el)
        else if (member === 'watermarks' || member === 'previousIncarnations') arrays[member].push(el)
        else throw new LogFault(`ledger: ${key}: a manifest with an array member ${JSON.stringify(member)}`)
      },
      (index, value) => {
        if (index !== 0) throw new LogFault(`ledger: ${key}: more than one line after the header`)
        const problem = checkpointHeaderProblem(value, { ledgerIncarnation: source, version, tenant: this.tenant })
        if (problem) throw new LogFault(`ledger: ${key} is ${problem.status}: ${problem.reason}`)
        header = value as LedgerSegmentHeader
      },
    )
    if (lines !== 2 || !header || !streamed) throw new LogFault(`ledger: ${key}: not a header and one line`)
    const h = header as LedgerSegmentHeader
    if (h.v === 1) {
      sink.finish(streamed, { ledgerIncarnation: source, version })
      return version
    }
    const d = decodeLedgerCheckpointManifest({ ...streamed, ...arrays }, h)
    if (d.status !== 'ok') throw new LogFault(`ledger: ${key} is ${d.status}: ${d.reason}`)
    const m = d.manifest
    const sql = this.ctx.storage.sql
    let files = 0
    let tombstones = 0
    const read = (part: number) =>
      this.bucket.get(this.objectKey(ledgerCheckpointPartKey(this.tenant, source, version, m.attempt, part))).then(async (p) => {
        if (!p) throw new LogFault(`ledger: ${key} names part ${part}, which is not there`)
        return p.text()
      })
    // Parts in order, a few read ahead: memory is a few parts, whatever the state.
    const ahead: Promise<string>[] = []
    for (let part = 0; part < m.parts; part++) {
      while (ahead.length < REPLAY_FANOUT - 2 && part + ahead.length < m.parts) {
        const p = read(part + ahead.length)
        p.catch(() => undefined) // awaited below, in order; a failure of one read ahead is reported there
        ahead.push(p)
      }
      const body = await ahead.shift()!
      const p = decodeLedgerCheckpointPart(body, { tenant: this.tenant, ledgerIncarnation: source, version, attempt: m.attempt, part })
      if (p.status !== 'ok') throw new LogFault(`ledger: part ${part} of ${key} is ${p.status}: ${p.reason}`)
      this.ctx.storage.transactionSync(() => {
        for (const r of p.records) {
          if ('file' in r) {
            const { unit, ...f } = r.file
            this.loadFile(f, unit ? { shard: unit.shard, incarnation: unit.incarnation, seqLo: unit.seqLo, seqHi: unit.seqHi } : null)
            files++
          } else {
            const t = r.tombstone
            sql.exec(`INSERT OR REPLACE INTO tombstone (key, tbl, version, at) VALUES (?, ?, ?, ?)`, t.key, t.table, t.version, t.at)
            tombstones++
          }
        }
      })
    }
    if (files !== m.files || tombstones !== m.tombstones) throw new LogFault(`ledger: ${key}: its parts hold ${files} files and ${tombstones} tombstones, the manifest says ${m.files} and ${m.tombstones}`)
    const previous = new Map(m.previousIncarnations.map((p) => [p.shard, p.previousIncarnation]))
    this.ctx.storage.transactionSync(() => {
      for (const w of m.watermarks) {
        sql.exec(`INSERT INTO stream (shard, incarnation, watermark, logged, prev_incarnation) VALUES (?, ?, ?, ?, ?)`, w.shard, w.incarnation, w.seq, w.seq, previous.get(w.shard) ?? null)
      }
      sql.exec(`DELETE FROM tombstone WHERE key IN (SELECT key FROM file)`)
    })
    return version
  }

  /**
   * Segments, into SQLite: the newest checkpoint that can be read whole (else the base at the
   * head of the first segment), then every segment after it, contiguous, strictly checked,
   * applied change by change. Memory: what is being read (a few log objects), never the state.
   */
  private async replaySegments(source: number): Promise<{ version: number; checkpoint: number | null; changesReplayed: number; segmentsRead: number }> {
    const prefix = this.objectKey(ledgerIncarnationPrefix(this.tenant, source))
    let version: number | null = null
    let checkpoint: number | null = null
    const ckpts = (await this.listKeys(`${prefix}ckpt-`))
      .map((k) => ({ k, p: parseLedgerLogKey(k) }))
      .filter((x): x is { k: string; p: { type: 'checkpoint'; ledgerIncarnation: number; version: number } } => x.p?.type === 'checkpoint')
      .sort((a, b) => b.p.version - a.p.version)
    for (const c of ckpts) {
      try {
        version = await this.loadCheckpoint(c.k, source, c.p.version)
        checkpoint = version
        break
      } catch (e) {
        // A checkpoint is only an accelerator: one that cannot be read whole is passed over for
        // an older one or the base, and what it loaded is emptied first.
        console.error(`ledger ${this.tenant}: checkpoint ${c.k} not used: ${e instanceof Error ? e.message : String(e)}`)
        this.clearState()
      }
    }
    const listed = await this.listObjects(`${prefix}seg-`, checkpoint === null ? undefined : this.objectKey(ledgerSegmentsStartingAfter(this.tenant, source, checkpoint)))
    const segs = listed
      .map((o) => ({ ...o, p: parseLedgerLogKey(o.key) }))
      .filter((x): x is { key: string; size: number; p: { type: 'segment'; ledgerIncarnation: number; firstVersion: number; lastVersion: number } } => x.p?.type === 'segment')
      .sort((a, b) => a.p.firstVersion - b.p.firstVersion)
    let changesReplayed = 0
    let i = 0
    if (version === null) {
      // No checkpoint: the first segment starts with the base, which is as large as the state.
      const first = segs[0]
      if (!first) throw new LogFault(`ledger: incarnation ${source} has no base segment`)
      const r = await this.loadBaseSegment(first.key, first.p, source)
      version = r.version
      changesReplayed += r.changes
      i = 1
    }
    // The other segments are read a few ahead, at most `REPLAY_BYTES_IN_FLIGHT` at a time.
    const ahead: { seg: (typeof segs)[number]; read: Promise<LedgerChange[]> }[] = []
    let inFlight = 0
    for (; i < segs.length || ahead.length > 0;) {
      while (i < segs.length && ahead.length < REPLAY_FANOUT && (ahead.length === 0 || inFlight + segs[i]!.size <= REPLAY_BYTES_IN_FLIGHT)) {
        const seg = segs[i++]!
        inFlight += seg.size
        const read = this.readSegment(seg.key)
        read.catch(() => undefined) // awaited below, in order
        ahead.push({ seg, read })
      }
      const { seg, read } = ahead.shift()!
      const changes = await read
      inFlight -= seg.size
      if (seg.p.firstVersion !== version + 1) {
        throw new LogFault(`ledger: log of incarnation ${source} is not contiguous at version ${version + 1} (next segment starts at ${seg.p.firstVersion})`)
      }
      for (const c of changes) {
        this.applyLogged(c, version + 1)
        version = c.version
        changesReplayed++
      }
    }
    return { version, checkpoint, changesReplayed, segmentsRead: segs.length }
  }

  /** The first segment of an incarnation, streamed: its header, its base (into SQLite), then any changes after it. */
  private async loadBaseSegment(key: string, p: { ledgerIncarnation: number; firstVersion: number; lastVersion: number }, source: number): Promise<{ version: number; changes: number }> {
    const o = await this.bucket.get(key)
    if (!o) throw new Error(`ledger: log object vanished during rebuild: ${key}`)
    const sink = this.baseSink()
    let header: LedgerSegmentHeader | null = null
    const changes: LedgerChange[] = []
    const { lines, streamed } = await readLedgerLogStream(o.body, 1, sink.element, (index, value) => {
      if (index === 0) {
        const h = value as LedgerSegmentHeader
        if (typeof h !== 'object' || h === null || typeof h.v !== 'number') throw new LogFault(`ledger: ${key} is corrupt: an unreadable header`)
        if (h.v > LEDGER_SEGMENT_VERSION) throw new LogFault(`ledger: ${key} is unsupported: segment version ${h.v}; this code reads up to ${LEDGER_SEGMENT_VERSION}`)
        if (h.kind !== LEDGER_SEGMENT_KIND) throw new LogFault(`ledger: ${key} is unsupported: unknown log object kind ${JSON.stringify(h.kind)}`)
        if (h.tenant !== this.tenant || h.ledgerIncarnation !== p.ledgerIncarnation || h.firstVersion !== p.firstVersion || h.lastVersion !== p.lastVersion) {
          throw new LogFault(`ledger: ${key} is corrupt: its header does not match its key`)
        }
        header = h
        return
      }
      const c = value as LedgerChange
      const why = unsupportedLedgerChange(c)
      if (why) throw new LogFault(`ledger: ${key} is unsupported: ${why}`)
      changes.push(c)
    })
    const h = header as LedgerSegmentHeader | null
    if (!h || !streamed || lines !== h.changes + 1 || h.changes !== p.lastVersion - p.firstVersion + 1) throw new LogFault(`ledger: ${key} is corrupt: ${lines - 1} lines for ${h?.changes} changes`)
    // The first line of an incarnation's first segment is its base.
    if (streamed.kind !== 'base') throw new LogFault(`ledger: incarnation ${source} does not start with a base`)
    sink.finish(streamed, { ledgerIncarnation: source, version: p.firstVersion })
    let version = p.firstVersion
    for (const c of changes) {
      if (c.ledgerIncarnation !== source) throw new LogFault(`ledger: ${key} is corrupt: a change of incarnation ${c.ledgerIncarnation}`)
      this.applyLogged(c, version + 1)
      version = c.version
    }
    return { version, changes: changes.length }
  }

  /**
   * The first layout: stream one incarnation's `base.json` into SQLite and apply its change
   * objects in version order. Fails, rather than guessing, if the log has a hole or a change does
   * not fit the state before it.
   */
  private async replayObjects(source: number): Promise<{ version: number; changesReplayed: number }> {
    const prefix = this.objectKey(ledgerIncarnationPrefix(this.tenant, source))
    // An incarnation's log starts at its `base`. Without one there is nothing to start from:
    // an incarnation writes its base before it commits anything else.
    const baseObject = await this.bucket.get(this.objectKey(ledgerBaseKey(this.tenant, source)))
    if (!baseObject) throw new LogFault(`ledger: incarnation ${source} has log objects but no base`)
    const sink = this.baseSink()
    const { streamed } = await readLedgerLogStream(baseObject.body, 0, sink.element, () => {
      throw new LogFault(`ledger: base of incarnation ${source} is more than one object`)
    })
    if (!streamed) throw new LogFault(`ledger: base of incarnation ${source} is not a base change`)
    const why = unsupportedLedgerChange(streamed)
    if (why) throw new LogFault(`ledger: base of incarnation ${source} is unsupported: ${why}`)
    if (typeof streamed.version !== 'number') throw new LogFault(`ledger: base of incarnation ${source} is not a base change`)
    sink.finish(streamed, { ledgerIncarnation: source, version: streamed.version })
    let version = streamed.version
    const pending: { version: number; key: string }[] = []
    for (const key of await this.listKeys(prefix)) {
      const m = CHANGE_OBJECT.exec(key)
      if (m && Number(m[1]) > version) pending.push({ version: Number(m[1]), key })
    }
    pending.sort((a, b) => a.version - b.version)

    let changesReplayed = 0
    for (let i = 0; i < pending.length; i += REPLAY_FANOUT) {
      const batch = pending.slice(i, i + REPLAY_FANOUT)
      const changes = await Promise.all(
        batch.map(async (p) => {
          const o = await this.bucket.get(p.key)
          if (!o) throw new Error(`ledger: log object vanished during rebuild: ${p.key}`)
          return o.json<LedgerChange>()
        }),
      )
      for (const c of changes) {
        // COMPATIBILITY.md §3.2: a version or kind this code does not know stops the replay.
        const why = unsupportedLedgerChange(c)
        if (why) throw new LogFault(`ledger: change ${c.version} of incarnation ${source} is unsupported: ${why}`)
        if (c.ledgerIncarnation !== source || c.version !== version + 1) {
          throw new LogFault(`ledger: log of incarnation ${source} is not contiguous at version ${version + 1}`)
        }
        this.applyLogged(c, version + 1)
        version = c.version
        changesReplayed++
      }
    }
    return { version, changesReplayed }
  }

  /**
   * Apply one logged change to the state being rebuilt in SQLite, in one transaction. Throws
   * (and the transaction rolls back) if it does not fit the state before it.
   */
  private applyLogged(c: LedgerChange, expected: number): void {
    const bad = (why: string) => new LogFault(`ledger: cannot replay version ${c.version}: ${why}`)
    if (c.version !== expected) throw bad(`expected version ${expected}`)
    if (c.kind === 'base') throw bad('a base entry inside the version sequence')
    if (c.kind !== 'register_stream' && c.kind !== 'add_unit' && c.kind !== 'replace' && c.kind !== 'expire') throw bad(`unknown kind ${JSON.stringify(c.kind)}`)
    const sql = this.ctx.storage.sql
    this.ctx.storage.transactionSync(() => {
      const inputs: LiveFile[] = []
      for (const k of c.removed) {
        const r = sql.exec(`SELECT * FROM file WHERE key = ?`, k).toArray()[0]
        if (!r) throw bad(`removes ${k}, which is not live`)
        const f = toEntry(r)
        inputs.push(f)
        sql.exec(`DELETE FROM file WHERE key = ?`, k)
        sql.exec(`INSERT OR REPLACE INTO tombstone (key, tbl, version, at) VALUES (?, ?, ?, ?)`, k, f.table, c.version, c.at)
      }
      let unit: UnitRef | null = null
      const w = c.watermark
      if (c.kind === 'register_stream') {
        if (!w) throw bad('no stream')
        const old = this.stream(w.shard)
        if (old && w.incarnation < old.incarnation) throw bad('registers a lower stream incarnation')
        sql.exec(
          `INSERT INTO stream (shard, incarnation, watermark, logged, prev_incarnation) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (shard) DO UPDATE SET incarnation = excluded.incarnation, watermark = excluded.watermark, logged = excluded.logged, prev_incarnation = excluded.prev_incarnation`,
          w.shard, w.incarnation, w.seq, w.seq, old?.incarnation ?? null,
        )
      } else if (c.kind === 'add_unit') {
        const st = w ? this.stream(w.shard) : null
        if (!w || !st || st.incarnation !== w.incarnation || w.seq <= st.watermark) throw bad('unit does not extend its stream')
        // The change carries the admitted range, so contiguity is checked rather than assumed.
        if (!c.unit || c.unit.seqLo !== st.watermark + 1 || c.unit.seqHi !== w.seq) throw bad('unit range is not contiguous with the watermark')
        unit = { shard: w.shard, incarnation: w.incarnation, seqLo: c.unit.seqLo, seqHi: c.unit.seqHi }
        sql.exec(`UPDATE stream SET watermark = ?, logged = ? WHERE shard = ?`, w.seq, w.seq, w.shard)
      }
      for (const [n, f] of c.added.entries()) {
        if (sql.exec(`SELECT 1 AS x FROM file WHERE key = ?`, f.key).toArray().length > 0) throw bad(`adds ${f.key}, which is already live`)
        // The precedence as assigned when the change was made; a change logged before
        // precedence existed gets what the ledger would have assigned (contracts `LiveFile`).
        let listed: LiveFile = f
        if (typeof f.precedence !== 'number' || typeof f.precedenceLow !== 'number') {
          const from = inputs.filter((x) => x.table === f.table && x.day === f.day)
          const p = c.version * PRECEDENCE_PER_VERSION + n
          listed = from.length === 0
            ? asListed(f, p, p)
            : asListed(f, Math.min(...from.map((x) => x.precedenceLow)), Math.max(...from.map((x) => x.precedence)))
        }
        this.loadFile(asListed(listed, listed.precedenceLow, listed.precedence), unit)
        // A key admitted again (possible only after a caller bug) is live, not buried.
        sql.exec(`DELETE FROM tombstone WHERE key = ?`, f.key)
      }
    })
  }
}

/** Bytes of `s` as UTF-8 (`JSON.stringify` never leaves a lone surrogate). */
function utf8Length(s: string): number {
  let n = s.length
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) continue
    if (c < 0x800) n += 1
    else if (c >= 0xd800 && c < 0xe000) n += 1 // each half of a pair: 4 bytes for 2 units
    else n += 2
  }
  return n
}
