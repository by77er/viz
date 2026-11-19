import { DurableObject } from 'cloudflare:workers'
import {
  LEDGER_CHECKPOINT_KIND,
  LEDGER_SEGMENT_MAX_BYTES,
  TENANT_ID,
  unsupportedLedgerChange,
  decodeLedgerSegment,
  encodeLedgerSegment,
  ledgerBaseKey,
  ledgerCheckpointKey,
  ledgerIncarnationPrefix,
  ledgerSegmentKey,
  ledgerSegmentsStartingAfter,
  parseLedgerLogKey,
  type AddUnitResult,
  type ExpireRequest,
  type FileEntry,
  type FlushUnit,
  type LedgerAdminRpc,
  type LedgerChange,
  type LedgerJanitorRpc,
  type LiveFile,
  PRECEDENCE_PER_VERSION,
  type OrphanCheck,
  type Tombstone,
  type LedgerRpc,
  type Plan,
  type PlanRequest,
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
 *   ledger/tenant={t}/{incarnation}/ckpt-{version:012}.jsonl           the whole state at a version
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
 * In-memory state is a cache or a hint only: the schema state and whether an incarnation is
 * being started (re-derived from SQLite in the constructor), the alarm time this object set,
 * the drain's backoff, and the last fault (for `logStatus`).
 */

export interface LedgerEnv {
  BUCKET: R2Bucket
  CELL?: string
  /** How long after the first unlogged commit the drain runs (ms). Default `DRAIN_DELAY_MS`. */
  LEDGER_DRAIN_DELAY_MS?: string
  /** Write a checkpoint after this many segments. Default `CHECKPOINT_EVERY`. */
  LEDGER_CHECKPOINT_EVERY?: string
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
  phase: 'ready' | 'starting' | 'refused' | 'corrupt'
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
/** Default: a checkpoint after this many segments bounds a rebuild (contracts/LEDGER-LOG.md). */
export const CHECKPOINT_EVERY = 256
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
  }],
}

/**
 * `meta` keys. `log_format` 2 = this incarnation logs segments. `starting` 1 = this storage
 * was created empty and its first incarnation is still being started from R2 (the only way
 * to have a schema version row and no incarnation that is not corruption).
 */
type MetaKey = 'incarnation' | 'version' | 'log_format' | 'seg_first' | 'seg_last' | 'logged_through' | 'segs_since_ckpt' | 'starting'
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

/** The ledger's whole state, as replayed or read; what a base or checkpoint holds. */
interface State {
  version: number
  files: Map<string, StoredFile>
  streams: Map<string, StoredStream>
  tombstones: Map<string, Tombstone>
}

const emptyState = (): State => ({ version: 0, files: new Map(), streams: new Map(), tombstones: new Map() })

/** A recorded segment, ready to write. */
interface PendingSegment {
  first: number
  last: number
  key: string
  body: string
  rows: { version: number; json: string }[]
  /** The bounds were recorded by this call (so must be made durable before the PUT). */
  fresh: boolean
  /** A checkpoint to write once this segment is written: the state at `last`. */
  checkpoint: { version: number; json: string } | null
}

/** An existing log object with other bytes, or a recorded segment whose rows are gone: never overwritten, never guessed around. */
class LogFault extends Error {}

export class Ledger extends DurableObject<LedgerEnv> implements LedgerRpc, LedgerAdminRpc, LedgerJanitorRpc {
  private readonly tenant: string
  private readonly cell: string
  /** Where the change log goes. A field so that tests can substitute a failing bucket. */
  protected bucket: R2Bucket
  protected drainDelayMs: number
  protected checkpointEvery: number
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
    return n('file') === 0 && n('stream') === 0 && n('outbox') === 0 && n('meta') === 0
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

  private insertFile(f: LiveFile, unit: UnitRef | null): void {
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
    void this.drainWithBackoff(SEGMENTS_PER_ALARM).then((failed) => {
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

  private hasPending(): boolean {
    return this.meta('seg_first') !== null || (this.ctx.storage.sql.exec(`SELECT COUNT(*) AS n FROM outbox`).one().n as number) > 0
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
        if (this.hasPending()) this.scheduleDrain(0)
      },
      (e: unknown) => {
        this.starting = null
        this.startFailedAt = Date.now()
        this.lastError = e instanceof Error ? e.message : String(e)
        console.error(`ledger ${this.tenant}: could not start an incarnation: ${this.lastError}`)
        // Try again even if nobody asks.
        this.setAlarmAt(Date.now() + START_RETRY_MS)
      },
    )
  }

  // ───────────────────────────── LedgerRpc ─────────────────────────────

  async registerStream(ref: StreamRef): Promise<{ version: number; previousIncarnation: number | null }> {
    const g = this.gate()
    if (g) await g
    const problem = refProblem(ref)
    if (problem) throw new Error(`ledger: ${problem}`)
    const known = this.stream(ref.shard)
    if (known && known.incarnation === ref.incarnation) {
      // Idempotent: a retried registration gets the answer the first one got.
      return { version: this.version(), previousIncarnation: known.previousIncarnation }
    }
    // Incarnations are ordered (a larger number is newer). A lower one is a stale shard or a
    // late message; registering it would rewind the watermark of the live stream. The
    // contract's return type has no refusal, so this is an exception.
    if (known && ref.incarnation < known.incarnation) {
      throw new Error(`ledger: stream ${ref.shard} is registered with incarnation ${known.incarnation}; refusing the lower ${ref.incarnation}`)
    }
    const version = this.ctx.storage.transactionSync(() => this.register(ref, known))
    this.afterCommit()
    return { version, previousIncarnation: known?.incarnation ?? null }
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

    const version = this.ctx.storage.transactionSync(() => {
      if (!known) this.register(unit, null)
      // Precedence (contracts/ledger.ts `LiveFile`): the version this change is about to get.
      // Units of a stream are admitted in sequence order, so a later write ranks higher.
      const v = this.version() + 1
      const listed = unit.files.map((f, i) => asListed(f, v * PRECEDENCE_PER_VERSION + i, v * PRECEDENCE_PER_VERSION + i))
      for (const f of listed) this.insertFile(f, ref)
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
      const gone = inputs.map((f) => ({ key: f.key, table: f.table }))
      this.bury(gone)
      for (const k of remove) this.ctx.storage.sql.exec(`DELETE FROM file WHERE key = ?`, k)
      for (const f of outputs) this.insertFile(f, null)
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
      for (const table of named) sql.exec(`DELETE FROM file WHERE tbl = ? AND day < ?`, table, req.beforeDay)
      return { version: this.record('expire', [], gone), removed: gone.map((x) => x.key) }
    })
    if (!result) return { version: this.version(), removed: [] }
    this.afterCommit()
    return result
  }

  async loggedWatermarks(): Promise<Watermark[]> {
    const g = this.gate()
    if (g) await g
    return this.ctx.storage.sql
      .exec(`SELECT shard, incarnation, logged FROM stream ORDER BY shard`)
      .toArray()
      .map((r): Watermark => ({ shard: r.shard as string, incarnation: r.incarnation as number, seq: r.logged as number }))
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
    const logged = sql
      .exec(`SELECT shard, incarnation, logged FROM stream ORDER BY shard`)
      .toArray()
      .map((r): Watermark => ({ shard: r.shard as string, incarnation: r.incarnation as number, seq: r.logged as number }))
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
    return { written: await this.drainSerial(Number.MAX_SAFE_INTEGER) }
  }

  private drainSerial(maxSegments: number): Promise<number> {
    const run = this.draining.then(async () => {
      this.drainActive = true
      try {
        return await this.drainNow(maxSegments)
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
  private async drainWithBackoff(maxSegments: number): Promise<boolean> {
    try {
      await this.drainSerial(maxSegments)
      this.failures = 0
      this.retryNotBefore = 0
      return false
    } catch (e) {
      this.failures++
      this.lastError = e instanceof Error ? e.message : String(e)
      const fault = e instanceof LogFault
      if (fault) console.error(`ledger ${this.tenant}: log fault, drain stopped: ${this.lastError}`)
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
        throw new LogFault(`the outbox starts at version ${rows[0]!.version}, the log ends at ${loggedThrough}`)
      }
      const first = rows[0]!.version
      const last = rows[rows.length - 1]!.version
      this.ctx.storage.transactionSync(() => {
        this.setMeta('seg_first', first)
        this.setMeta('seg_last', last)
      })
      fresh = true
      // A checkpoint is the state at the end of this segment, read in this same synchronous
      // step: only possible when the segment ends at the committed version.
      if ((this.meta('segs_since_ckpt') ?? 0) + 1 >= this.checkpointEvery && last === this.version()) {
        checkpoint = { version: last, json: JSON.stringify(this.baseChange(inc, this.stateFromSqlite())) }
      }
    }
    const first = rows[0]!.version
    const last = rows[rows.length - 1]!.version
    return {
      first,
      last,
      key: this.objectKey(ledgerSegmentKey(this.tenant, inc, first, last)),
      body: encodeLedgerSegment(this.tenant, inc, rows),
      rows,
      fresh,
      checkpoint,
    }
  }

  private async drainNow(maxSegments: number): Promise<number> {
    let written = 0
    for (let n = 0; n < maxSegments; n++) {
      const seg = this.nextSegment()
      if (!seg) break
      // The recorded bounds must survive a crash during the PUT, or a retry could choose others.
      if (seg.fresh) await this.ctx.storage.sync()
      const t0 = Date.now()
      await this.putLogObject(seg.key, seg.body)
      const ms = Date.now() - t0
      this.segmentsWritten++
      this.segmentWriteMs = { last: ms, max: Math.max(this.segmentWriteMs.max, ms) }
      this.ctx.storage.transactionSync(() => this.segmentWritten(seg))
      written += seg.rows.length
      if (seg.checkpoint) await this.writeCheckpoint(seg.checkpoint)
    }
    return written
  }

  /** In one transaction with nothing else: the segment is in R2; its rows go, the marks move. */
  private segmentWritten(seg: PendingSegment): void {
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
  }

  private async writeCheckpoint(c: { version: number; json: string }): Promise<void> {
    const inc = this.ledgerIncarnation()
    try {
      await this.putLogObject(this.objectKey(ledgerCheckpointKey(this.tenant, inc, c.version)), encodeLedgerSegment(this.tenant, inc, [c], LEDGER_CHECKPOINT_KIND))
      this.ctx.storage.transactionSync(() => this.setMeta('segs_since_ckpt', 0))
    } catch (e) {
      // Only an accelerator: the next segment that ends at the committed version tries again.
      console.error(`ledger ${this.tenant}: checkpoint at ${c.version} not written: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /**
   * Write one immutable log object with `If-None-Match: *`. An object already there counts
   * as written only if its bytes are these; any other bytes are a fault (never overwritten).
   */
  private async putLogObject(key: string, body: string): Promise<void> {
    const bytes = new TextEncoder().encode(body)
    const created = await this.bucket.put(key, bytes, {
      onlyIf: { etagDoesNotMatch: '*' },
      httpMetadata: { contentType: 'application/x-ndjson' },
    })
    if (created !== null) return
    const existing = await this.bucket.get(key)
    if (existing === null) throw new Error(`ledger: ${key} was refused as existing but is not there; retry`)
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
    const failed = await this.drainWithBackoff(SEGMENTS_PER_ALARM)
    if (this.hasPending()) {
      this.scheduleDrain(failed ? this.retryNotBefore - Date.now() : 0)
    } else if (this.alarmAt !== null) {
      // One set by a mutation during the drain, whose change this drain already wrote.
      this.alarmAt = null
      await this.ctx.storage.deleteAlarm()
    }
  }

  /** Changes committed but not yet written to R2. */
  async outboxDepth(): Promise<number> {
    const g = this.gate()
    if (g) await g
    return this.ctx.storage.sql.exec(`SELECT COUNT(*) AS n FROM outbox`).one().n as number
  }

  /** Operator view of the log. Answers while starting, too. */
  async logStatus(): Promise<LogStatus> {
    const sql = this.ctx.storage.sql
    const ready = !this.refusal && !this.needsStart && !this.corrupt
    const first = ready ? this.meta('seg_first') : null
    const last = ready ? this.meta('seg_last') : null
    return {
      phase: this.refusal ? 'refused' : this.corrupt ? 'corrupt' : this.needsStart ? 'starting' : 'ready',
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

  /** The whole state as SQLite holds it now. */
  private stateFromSqlite(): State {
    const sql = this.ctx.storage.sql
    const s = emptyState()
    s.version = this.version()
    for (const r of sql.exec(`SELECT * FROM file`)) {
      const f = toStored(r)
      s.files.set(f.key, f)
    }
    for (const r of sql.exec(`SELECT * FROM stream`)) {
      s.streams.set(r.shard as string, { shard: r.shard as string, incarnation: r.incarnation as number, watermark: r.watermark as number, previousIncarnation: r.prev_incarnation as number | null })
    }
    for (const r of sql.exec(`SELECT key, tbl, version, at FROM tombstone`)) s.tombstones.set(r.key as string, Ledger.toTombstone(r))
    return s
  }

  /** A `base` change holding `s` (contracts/LEDGER-LOG.md, "The base"), in a fixed order. */
  private baseChange(ledgerIncarnation: number, s: State): LedgerBase {
    const files = [...s.files.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    const streams = [...s.streams.values()].sort((a, b) => (a.shard < b.shard ? -1 : 1))
    return {
      ledgerIncarnation,
      version: s.version,
      at: Date.now(),
      kind: 'base',
      added: files.map(({ unit: _unit, ...entry }) => entry),
      removed: [],
      watermarks: streams.map((st) => ({ shard: st.shard, incarnation: st.incarnation, seq: st.watermark })),
      previousIncarnations: streams.filter((st) => st.previousIncarnation !== null).map((st) => ({ shard: st.shard, previousIncarnation: st.previousIncarnation! })),
      tombstones: [...s.tombstones.values()].filter((t) => !s.files.has(t.key)).sort((a, b) => a.version - b.version || (a.key < b.key ? -1 : 1)),
      units: files.filter((f) => f.unit !== null).map((f) => ({ key: f.key, ...f.unit! })),
    }
  }

  /**
   * Start a new incarnation: its state comes from R2 (storage with no incarnation: a new
   * tenant or storage loss) or from SQLite (storage running an incarnation in the first log
   * layout). Its base segment is written to R2 BEFORE SQLite commits the incarnation, so an
   * incarnation number is never used for two different histories (spec F11). Runs outside
   * `blockConcurrencyWhile`; nothing else commits meanwhile because every request waits in
   * `gate()`.
   */
  private async startIncarnation(mode: 'r2' | 'sqlite'): Promise<RebuildResult> {
    const t0 = Date.now()
    const latest = await this.latestIncarnation()
    let state: State
    let replay: { from: RebuildResult['from']; checkpoint: number | null; changesReplayed: number; segmentsRead: number }
    if (mode === 'sqlite') {
      state = this.stateFromSqlite()
      replay = { from: 'sqlite', checkpoint: null, changesReplayed: 0, segmentsRead: 0 }
    } else if (latest === null) {
      state = emptyState()
      replay = { from: 'empty', checkpoint: null, changesReplayed: 0, segmentsRead: 0 }
    } else {
      ;({ state, ...replay } = await this.replayIncarnation(latest))
    }
    // Higher than anything in R2 and than anything this storage has used.
    const incarnation = Math.max(latest ?? 0, this.meta('incarnation') ?? 0) + 1
    const base = this.baseChange(incarnation, state)
    await this.putLogObject(
      this.objectKey(ledgerSegmentKey(this.tenant, incarnation, state.version, state.version)),
      encodeLedgerSegment(this.tenant, incarnation, [{ version: state.version, json: JSON.stringify(base) }]),
    )

    const sql = this.ctx.storage.sql
    this.ctx.storage.transactionSync(() => {
      if (mode === 'r2') {
        sql.exec(`DELETE FROM file`)
        sql.exec(`DELETE FROM stream`)
        sql.exec(`DELETE FROM tombstone`)
        for (const t of state.tombstones.values()) {
          if (!state.files.has(t.key)) sql.exec(`INSERT INTO tombstone (key, tbl, version, at) VALUES (?, ?, ?, ?)`, t.key, t.table, t.version, t.at)
        }
        for (const f of state.files.values()) this.insertFile(f, f.unit)
        for (const st of state.streams.values()) {
          sql.exec(
            `INSERT INTO stream (shard, incarnation, watermark, logged, prev_incarnation) VALUES (?, ?, ?, ?, ?)`,
            st.shard, st.incarnation, st.watermark, st.watermark, st.previousIncarnation,
          )
        }
      }
      // Everything is in the base now: no change is pending, every watermark is logged.
      sql.exec(`DELETE FROM outbox`)
      sql.exec(`UPDATE stream SET logged = watermark`)
      this.setMeta('incarnation', incarnation)
      this.setMeta('version', state.version)
      this.setMeta('log_format', LOG_FORMAT_SEGMENTS)
      this.setMeta('logged_through', state.version)
      this.setMeta('segs_since_ckpt', 0)
      this.dropMeta('seg_first')
      this.dropMeta('seg_last')
      this.dropMeta('starting')
    })
    return { ledgerIncarnation: incarnation, version: state.version, source: mode === 'sqlite' ? null : latest, ...replay, files: state.files.size, streams: state.streams.size, ms: Date.now() - t0 }
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

  /** Every key under `prefix` (optionally after `startAfter`), in key order. */
  private async listKeys(prefix: string, startAfter?: string): Promise<string[]> {
    const out: string[] = []
    let cursor: string | undefined
    do {
      const page = await this.bucket.list(cursor ? { prefix, cursor } : { prefix, startAfter })
      for (const o of page.objects) out.push(o.key)
      cursor = page.truncated ? page.cursor : undefined
    } while (cursor)
    return out
  }

  /** The state an incarnation's log reaches, in whichever layout it was written. */
  private async replayIncarnation(source: number): Promise<{ state: State; from: RebuildResult['from']; checkpoint: number | null; changesReplayed: number; segmentsRead: number }> {
    const prefix = this.objectKey(ledgerIncarnationPrefix(this.tenant, source))
    const page = await this.bucket.list({ prefix: `${prefix}seg-`, limit: 1 })
    if (page.objects.length === 0) {
      const r = await this.replayObjects(source)
      return { ...r, from: 'objects', checkpoint: null, segmentsRead: 0 }
    }
    if ((await this.bucket.head(this.objectKey(ledgerBaseKey(this.tenant, source)))) !== null) {
      throw new Error(`ledger: incarnation ${source} has both segments and a base.json`)
    }
    return { ...(await this.replaySegments(source)), from: 'segments' }
  }

  /** Read and check one segment or checkpoint object. Unsupported or corrupt refuses the replay. */
  private async readLogObject(key: string, kind: 'segment' | 'checkpoint'): Promise<LedgerChange[]> {
    const parsed = parseLedgerLogKey(key)
    if (!parsed || parsed.type !== kind) throw new Error(`ledger: ${key} is not a ${kind} key`)
    const o = await this.bucket.get(key)
    if (!o) throw new Error(`ledger: log object vanished during rebuild: ${key}`)
    const expected: Parameters<typeof decodeLedgerSegment>[1] =
      parsed.type === 'segment'
        ? { ledgerIncarnation: parsed.ledgerIncarnation, firstVersion: parsed.firstVersion, lastVersion: parsed.lastVersion, tenant: this.tenant }
        : { ledgerIncarnation: parsed.ledgerIncarnation, firstVersion: parsed.version, lastVersion: parsed.version, tenant: this.tenant, kind: LEDGER_CHECKPOINT_KIND }
    const d = decodeLedgerSegment(await o.text(), expected)
    if (d.status !== 'ok') throw new Error(`ledger: ${key} is ${d.status}: ${d.reason}`)
    return d.changes
  }

  /**
   * Segments: the newest readable checkpoint (else the base at the head of the first
   * segment), then every segment after it, contiguous, strictly checked.
   */
  private async replaySegments(source: number): Promise<{ state: State; checkpoint: number | null; changesReplayed: number; segmentsRead: number }> {
    const prefix = this.objectKey(ledgerIncarnationPrefix(this.tenant, source))
    let state: State | null = null
    let checkpoint: number | null = null
    const ckpts = (await this.listKeys(`${prefix}ckpt-`))
      .map((k) => ({ k, p: parseLedgerLogKey(k) }))
      .filter((x) => x.p?.type === 'checkpoint')
      .sort((a, b) => (b.p as { version: number }).version - (a.p as { version: number }).version)
    for (const c of ckpts) {
      try {
        const [base] = await this.readLogObject(c.k, 'checkpoint')
        state = this.stateFromBase(base!)
        checkpoint = state.version
        break
      } catch (e) {
        // A checkpoint is only an accelerator: an unreadable one is passed over for an older one or the base.
        console.error(`ledger ${this.tenant}: checkpoint ${c.k} not used: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    const keys = await this.listKeys(`${prefix}seg-`, checkpoint === null ? undefined : this.objectKey(ledgerSegmentsStartingAfter(this.tenant, source, checkpoint)))
    const segs = keys
      .map((k) => ({ k, p: parseLedgerLogKey(k) }))
      .filter((x): x is { k: string; p: { type: 'segment'; ledgerIncarnation: number; firstVersion: number; lastVersion: number } } => x.p?.type === 'segment')
      .sort((a, b) => a.p.firstVersion - b.p.firstVersion)
    let changesReplayed = 0
    let version = state?.version ?? null
    for (let i = 0; i < segs.length; i += REPLAY_FANOUT) {
      const batch = segs.slice(i, i + REPLAY_FANOUT)
      const read = await Promise.all(batch.map((s) => this.readLogObject(s.k, 'segment')))
      for (const [j, changes] of read.entries()) {
        const seg = batch[j]!.p
        if (version !== null && seg.firstVersion !== version + 1) {
          throw new Error(`ledger: log of incarnation ${source} is not contiguous at version ${version + 1} (next segment starts at ${seg.firstVersion})`)
        }
        for (const c of changes) {
          if (state === null) {
            // The first segment of an incarnation starts with its base.
            if (c.kind !== 'base') throw new Error(`ledger: incarnation ${source} does not start with a base`)
            state = this.stateFromBase(c)
          } else {
            this.apply(c, state)
            changesReplayed++
          }
          version = c.version
        }
      }
    }
    if (state === null) throw new Error(`ledger: incarnation ${source} has no base segment`)
    return { state, checkpoint, changesReplayed, segmentsRead: segs.length }
  }

  private stateFromBase(base: LedgerChange): State {
    if (base.kind !== 'base' || !Array.isArray(base.added) || !Array.isArray(base.watermarks)) throw new Error(`ledger: version ${base.version} is not a base change`)
    const s = emptyState()
    s.version = base.version
    const units = new Map((base.units ?? []).map((u) => [u.key, { shard: u.shard, incarnation: u.incarnation, seqLo: u.seqLo, seqHi: u.seqHi }]))
    // A base written before precedence existed has none: those files rank below everything later.
    for (const f of base.added) s.files.set(f.key, { ...f, precedence: f.precedence ?? 0, precedenceLow: f.precedenceLow ?? f.precedence ?? 0, unit: units.get(f.key) ?? null })
    const prev = new Map((base.previousIncarnations ?? []).map((p) => [p.shard, p.previousIncarnation]))
    for (const w of base.watermarks) s.streams.set(w.shard, { shard: w.shard, incarnation: w.incarnation, watermark: w.seq, previousIncarnation: prev.get(w.shard) ?? null })
    for (const t of base.tombstones ?? []) s.tombstones.set(t.key, { key: t.key, table: t.table, version: t.version, at: t.at })
    return s
  }

  /**
   * The first layout: load one incarnation's `base.json` and apply its change objects in
   * version order. Fails, rather than guessing, if the log has a hole or a change does not
   * fit the state before it.
   */
  private async replayObjects(source: number): Promise<{ state: State; changesReplayed: number }> {
    const prefix = this.objectKey(ledgerIncarnationPrefix(this.tenant, source))
    // An incarnation's log starts at its `base`. Without one there is nothing to start from:
    // an incarnation writes its base before it commits anything else.
    const baseObject = await this.bucket.get(this.objectKey(ledgerBaseKey(this.tenant, source)))
    if (!baseObject) throw new Error(`ledger: incarnation ${source} has log objects but no base`)
    const base = await baseObject.json<LedgerBase>()
    const why = unsupportedLedgerChange(base)
    if (why) throw new Error(`ledger: base of incarnation ${source} is unsupported: ${why}`)
    if (base.kind !== 'base' || base.ledgerIncarnation !== source || !Array.isArray(base.added) || !Array.isArray(base.watermarks)) {
      throw new Error(`ledger: base of incarnation ${source} is not a base change`)
    }
    const state = this.stateFromBase(base)
    const pending: { version: number; key: string }[] = []
    for (const key of await this.listKeys(prefix)) {
      const m = CHANGE_OBJECT.exec(key)
      if (m && Number(m[1]) > state.version) pending.push({ version: Number(m[1]), key })
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
        if (why) throw new Error(`ledger: change ${c.version} of incarnation ${source} is unsupported: ${why}`)
        if (c.ledgerIncarnation !== source || c.version !== state.version + 1) {
          throw new Error(`ledger: log of incarnation ${source} is not contiguous at version ${state.version + 1}`)
        }
        this.apply(c, state)
        changesReplayed++
      }
    }
    return { state, changesReplayed }
  }

  /** Apply one logged change to a replayed state. Throws if it does not fit the state before it. */
  private apply(c: LedgerChange, s: State): void {
    const bad = (why: string) => new Error(`ledger: cannot replay version ${c.version}: ${why}`)
    if (c.version !== s.version + 1) throw bad(`expected version ${s.version + 1}`)
    const inputs: StoredFile[] = []
    for (const k of c.removed) {
      const f = s.files.get(k)
      if (!f) throw bad(`removes ${k}, which is not live`)
      s.files.delete(k)
      inputs.push(f)
      s.tombstones.set(k, { key: k, table: f.table, version: c.version, at: c.at })
    }
    let unit: UnitRef | null = null
    const w = c.watermark
    if (c.kind === 'base') throw bad('a base entry inside the version sequence')
    if (c.kind !== 'register_stream' && c.kind !== 'add_unit' && c.kind !== 'replace' && c.kind !== 'expire') throw bad(`unknown kind ${JSON.stringify(c.kind)}`)
    if (c.kind === 'register_stream') {
      if (!w) throw bad('no stream')
      const old = s.streams.get(w.shard)
      if (old && w.incarnation < old.incarnation) throw bad('registers a lower stream incarnation')
      s.streams.set(w.shard, { shard: w.shard, incarnation: w.incarnation, watermark: w.seq, previousIncarnation: old?.incarnation ?? null })
    } else if (c.kind === 'add_unit') {
      const st = w && s.streams.get(w.shard)
      if (!w || !st || st.incarnation !== w.incarnation || w.seq <= st.watermark) throw bad('unit does not extend its stream')
      // The change carries the admitted range, so contiguity is checked rather than assumed.
      if (!c.unit || c.unit.seqLo !== st.watermark + 1 || c.unit.seqHi !== w.seq) throw bad('unit range is not contiguous with the watermark')
      unit = { shard: w.shard, incarnation: w.incarnation, seqLo: c.unit.seqLo, seqHi: c.unit.seqHi }
      st.watermark = w.seq
    }
    for (const [n, f] of c.added.entries()) {
      if (s.files.has(f.key)) throw bad(`adds ${f.key}, which is already live`)
      // The precedence as assigned when the change was made; a change logged before
      // precedence existed gets what the ledger would have assigned (contracts `LiveFile`).
      let listed: LiveFile = f
      if (typeof f.precedence !== 'number' || typeof f.precedenceLow !== 'number') {
        const from = inputs.filter((i) => i.table === f.table && i.day === f.day)
        const p = c.version * PRECEDENCE_PER_VERSION + n
        listed = from.length === 0
          ? asListed(f, p, p)
          : asListed(f, Math.min(...from.map((i) => i.precedenceLow)), Math.max(...from.map((i) => i.precedence)))
      }
      s.files.set(f.key, { ...listed, unit })
      // A key admitted again (possible only after a caller bug) is live, not buried.
      s.tombstones.delete(f.key)
    }
    s.version = c.version
  }
}
