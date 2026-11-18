import { DurableObject } from 'cloudflare:workers'
import {
  TENANT_ID,
  ledgerBaseKey,
  ledgerLogKey,
  type AddUnitResult,
  type ExpireRequest,
  type FileEntry,
  type FlushUnit,
  type LedgerAdminRpc,
  type LedgerChange,
  type LedgerJanitorRpc,
  type LiveFile,
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

/**
 * The tenant ledger: one Durable Object per tenant; the tenant is the object's name.
 *
 * It holds the tenant's live data files and one watermark per shard stream. It is the only
 * authority on what is visible.
 *
 * Every mutation is one synchronous SQLite transaction that changes the live set, bumps the
 * version and inserts the `LedgerChange` into an outbox. A drain step then writes outbox
 * rows to R2 in version order and deletes each one only after its write succeeded. Two
 * marks per stream follow from that:
 *
 *   watermark   committed in SQLite. Queries plan against it.
 *   logged      the change that set it is in R2. Shards may discard only up to this,
 *               because only this survives the loss of the ledger's storage.
 *
 * R2 layout, under the cell prefix:
 *
 *   ledger/tenant={t}/{incarnation}/base.json            a `base` LedgerChange: the state the incarnation starts from
 *   ledger/tenant={t}/{incarnation}/{version:012}.json   one LedgerChange (contract key)
 *
 * No state lives in memory. Every method reads SQLite. The only field that is not derived
 * from `ctx`/`env` is `draining`, a single-flight guard for the drain step.
 */

export interface LedgerEnv {
  BUCKET: R2Bucket
  CELL?: string
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

/**
 * `base.json` (contracts `ledgerBaseKey`) is a `LedgerChange` of kind `base`: `added` is the
 * whole live set and `watermarks` every stream the incarnation starts from. Its `version`
 * is the version the incarnation starts FROM; the first change after it is `version + 1`.
 */
export type LedgerBase = LedgerChange & { kind: 'base'; watermarks: Watermark[] }

export interface RebuildResult {
  ledgerIncarnation: number
  version: number
  /** Incarnation replayed, or null if R2 held no log for this tenant. */
  source: number | null
  changesReplayed: number
  files: number
  streams: number
}

const TABLES: readonly Table[] = ['metric_samples', 'metric_series']
const DAY = /^\d{4}-\d{2}-\d{2}$/
const CHANGE_OBJECT = /\/(\d{12,})\.json$/
/** Retry delay for a drain that failed, and the safety alarm set with every mutation. */
const DRAIN_RETRY_MS = 5_000
/** Concurrent R2 reads while replaying a log. */
const REPLAY_FANOUT = 6

type Row = Record<string, SqlStorageValue>

const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0

/** Why a file entry is unacceptable, or null. */
function fileProblem(f: FileEntry): string | null {
  if (typeof f !== 'object' || f === null) return 'file entry is not an object'
  if (typeof f.key !== 'string' || f.key === '') return 'file key must be a non-empty string'
  if (!TABLES.includes(f.table)) return `unknown table for ${f.key}`
  if (typeof f.day !== 'string' || !DAY.test(f.day)) return `bad day for ${f.key}`
  if (!isCount(f.bytes) || !isCount(f.rows) || !isCount(f.level)) return `bad bytes/rows/level for ${f.key}`
  if (!Number.isSafeInteger(f.minTs) || !Number.isSafeInteger(f.maxTs) || f.minTs > f.maxTs) return `bad time range for ${f.key}`
  if (typeof f.index !== 'string') return `index fragment must be a string for ${f.key}`
  return null
}

/** Why a list of files is unacceptable (a bad entry, or a key that appears twice), or null. */
function filesProblem(files: FileEntry[]): string | null {
  if (!Array.isArray(files)) return 'files must be an array'
  const seen = new Set<string>()
  for (const f of files) {
    const p = fileProblem(f)
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

export class Ledger extends DurableObject<LedgerEnv> implements LedgerRpc, LedgerAdminRpc, LedgerJanitorRpc {
  private readonly tenant: string
  private readonly cell: string
  /** Where the change log goes. A field so that tests can substitute a failing bucket. */
  protected bucket: R2Bucket
  /** Single-flight guard: drains run one after another, never interleaved. */
  private draining: Promise<unknown> = Promise.resolve()

  constructor(ctx: DurableObjectState, env: LedgerEnv) {
    super(ctx, env)
    const tenant = ctx.id.name
    if (!tenant) throw new Error('ledger: the object must be addressed by name (the tenant)')
    // Tenant ids appear unescaped in object keys; the contract fixes their alphabet.
    if (!TENANT_ID.test(tenant)) throw new Error('ledger: tenant id must match [A-Za-z0-9_-]{1,64}')
    this.tenant = tenant
    this.cell = env.CELL || 'cell-0'
    this.bucket = env.BUCKET
    void ctx.blockConcurrencyWhile(() => this.init())
  }

  // ───────────────────────────── storage ─────────────────────────────

  private schema(): void {
    const sql = this.ctx.storage.sql
    sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)`)
    sql.exec(`CREATE TABLE IF NOT EXISTS file (
      key TEXT PRIMARY KEY, tbl TEXT NOT NULL, day TEXT NOT NULL, bytes INTEGER NOT NULL, rows INTEGER NOT NULL,
      min_ts INTEGER NOT NULL, max_ts INTEGER NOT NULL, level INTEGER NOT NULL, idx TEXT NOT NULL,
      u_shard TEXT, u_inc INTEGER, u_lo INTEGER, u_hi INTEGER,
      prec INTEGER NOT NULL, prec_lo INTEGER NOT NULL)`)
    sql.exec(`CREATE INDEX IF NOT EXISTS file_tbl_day ON file (tbl, day)`)
    sql.exec(`CREATE INDEX IF NOT EXISTS file_tbl_max ON file (tbl, max_ts)`)
    sql.exec(`CREATE TABLE IF NOT EXISTS stream (
      shard TEXT PRIMARY KEY, incarnation INTEGER NOT NULL, watermark INTEGER NOT NULL,
      logged INTEGER NOT NULL, prev_incarnation INTEGER)`)
    sql.exec(`CREATE TABLE IF NOT EXISTS outbox (version INTEGER PRIMARY KEY, body TEXT NOT NULL)`)
    // Keys removed by `replace` or `expire` whose objects are still in R2 (contracts/ledger.ts).
    sql.exec(`CREATE TABLE IF NOT EXISTS tombstone (key TEXT PRIMARY KEY, tbl TEXT NOT NULL, version INTEGER NOT NULL, at INTEGER NOT NULL)`)
    sql.exec(`CREATE INDEX IF NOT EXISTS tombstone_version ON tombstone (version)`)
  }

  /**
   * Runs before any request. Storage with no ledger incarnation is either brand new or has
   * been lost; R2 tells which. Either way a new incarnation starts here, and if R2 holds a
   * log for this tenant the state is rebuilt from it first. If R2 cannot be read the
   * constructor fails and the object serves nothing, rather than serving an empty ledger.
   */
  private async init(): Promise<void> {
    this.schema()
    if (this.meta('incarnation') === null) await this.startIncarnation()
    const pending = this.ctx.storage.sql.exec(`SELECT COUNT(*) AS n FROM outbox`).one().n as number
    if (pending > 0 && (await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now())
  }

  private meta(k: 'incarnation' | 'version'): number | null {
    const r = this.ctx.storage.sql.exec(`SELECT v FROM meta WHERE k = ?`, k).toArray()[0]
    return r ? (r.v as number) : null
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
  private record(kind: LedgerChange['kind'], added: LiveFile[], removed: string[], watermark?: Watermark, unit?: { seqLo: number; seqHi: number }): number {
    const sql = this.ctx.storage.sql
    const version = this.version() + 1
    sql.exec(`INSERT INTO meta (k, v) VALUES ('version', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v`, version)
    const change: LedgerChange = { ledgerIncarnation: this.ledgerIncarnation(), version, at: Date.now(), kind, added, removed }
    if (watermark) change.watermark = watermark
    if (unit) change.unit = unit
    sql.exec(`INSERT INTO outbox (version, body) VALUES (?, ?)`, version, JSON.stringify(change))
    // Tombstones of this change carry exactly its time, so a rebuild from the log restores them as they were.
    if (removed.length > 0) sql.exec(`UPDATE tombstone SET at = ? WHERE version = ?`, change.at, version)
    return version
  }

  /** After a committed mutation: make sure a retry is scheduled, then try to log it now. */
  private async afterCommit(): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + DRAIN_RETRY_MS)
    // The mutation is committed whether or not R2 is reachable; a failed drain is retried
    // by the alarm, and until then `loggedWatermarks` simply lags.
    await this.drainSerial().catch(() => undefined)
  }

  // ───────────────────────────── LedgerRpc ─────────────────────────────

  async registerStream(ref: StreamRef): Promise<{ version: number; previousIncarnation: number | null }> {
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
    await this.afterCommit()
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
    // The unit itself is judged first, so a malformed request is `invalid` whatever the
    // stream's state, and never mistaken for a replay.
    const invalid = (reason: string): AddUnitResult => ({ status: 'invalid', reason })
    const problem = refProblem(unit)
    if (problem) return invalid(problem)
    if (!Number.isSafeInteger(unit.seqLo) || !Number.isSafeInteger(unit.seqHi) || unit.seqLo < 1 || unit.seqHi < unit.seqLo) {
      return invalid('bad sequence range')
    }
    const bad = filesProblem(unit.files)
    if (bad) return invalid(bad)
    if (unit.files.length === 0) return invalid('a unit must have at least one file')
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
      const listed = unit.files.map((f) => asListed(f, v, v))
      for (const f of listed) this.insertFile(f, ref)
      this.ctx.storage.sql.exec(`UPDATE stream SET watermark = ? WHERE shard = ?`, unit.seqHi, unit.shard)
      const recorded = this.record('add_unit', listed, [], { shard: unit.shard, incarnation: unit.incarnation, seq: unit.seqHi }, { seqLo: unit.seqLo, seqHi: unit.seqHi })
      if (recorded !== v) throw new Error('ledger: version moved inside a transaction')
      return recorded
    })
    await this.afterCommit()
    return { status: 'ok', version, watermark: unit.seqHi }
  }

  async plan(req: PlanRequest): Promise<Plan> {
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
    const invalid = (reason: string): ReplaceResult => ({ status: 'invalid', reason })
    if (typeof req !== 'object' || req === null) return invalid('request is not an object')
    if (!Array.isArray(req.remove) || req.remove.some((k) => typeof k !== 'string' || k === '')) {
      return invalid('remove must be a list of keys')
    }
    const bad = filesProblem(req.add)
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

    const version = this.ctx.storage.transactionSync(() => {
      this.bury(remove.map((key) => ({ key, table: this.liveFile(key)!.table })))
      for (const k of remove) this.ctx.storage.sql.exec(`DELETE FROM file WHERE key = ?`, k)
      for (const f of req.add) this.insertFile(f, null)
      return this.record('replace', req.add, remove)
    })
    await this.afterCommit()
    return { status: 'ok', version }
  }

  async expire(req: ExpireRequest): Promise<{ version: number; removed: string[] }> {
    if (!TABLES.includes(req.table)) throw new Error('ledger: unknown table')
    if (typeof req.beforeDay !== 'string' || !DAY.test(req.beforeDay)) throw new Error('ledger: beforeDay must be YYYY-MM-DD')
    const sql = this.ctx.storage.sql
    const result = this.ctx.storage.transactionSync(() => {
      const removed = sql
        .exec(`SELECT key FROM file WHERE tbl = ? AND day < ? ORDER BY key`, req.table, req.beforeDay)
        .toArray()
        .map((r) => r.key as string)
      if (removed.length === 0) return null
      this.bury(removed.map((key) => ({ key, table: req.table })))
      sql.exec(`DELETE FROM file WHERE tbl = ? AND day < ?`, req.table, req.beforeDay)
      return { version: this.record('expire', [], removed), removed }
    })
    if (!result) return { version: this.version(), removed: [] }
    await this.afterCommit()
    return result
  }

  async loggedWatermarks(): Promise<Watermark[]> {
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
    return this.ctx.storage.sql
      .exec(`SELECT key, tbl, version, at FROM tombstone WHERE version > ? ORDER BY version, key LIMIT ?`, version, Math.min(Math.max(1, Math.floor(limit)), 10_000))
      .toArray()
      .map(Ledger.toTombstone)
  }

  async orphanCheck(keys: string[]): Promise<OrphanCheck> {
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

  // ───────────────────────────── change log ─────────────────────────────

  private logKey(incarnation: number, version: number): string {
    return `${this.cell}/${ledgerLogKey(this.tenant, incarnation, version)}`
  }

  private incarnationPrefix(incarnation?: number): string {
    const root = `${this.cell}/ledger/tenant=${this.tenant}/`
    return incarnation === undefined ? root : `${root}${incarnation}/`
  }

  /**
   * Write outbox rows to R2, lowest version first. A row is deleted, and the stream's
   * `logged` mark advanced, only after its write returned. A failure stops the drain at
   * that version, so the log never has a hole below its highest object. Writing a row
   * twice is harmless: the key and the bytes are the same. Returns the number written.
   */
  async drain(): Promise<{ written: number }> {
    return { written: await this.drainSerial() }
  }

  private drainSerial(): Promise<number> {
    const run = this.draining.then(() => this.drainNow())
    this.draining = run.catch(() => undefined)
    return run
  }

  private async drainNow(): Promise<number> {
    const sql = this.ctx.storage.sql
    let written = 0
    for (;;) {
      const row = sql.exec(`SELECT version, body FROM outbox ORDER BY version LIMIT 1`).toArray()[0]
      if (!row) break
      const change = JSON.parse(row.body as string) as LedgerChange
      await this.bucket.put(this.logKey(change.ledgerIncarnation, change.version), row.body as string, {
        httpMetadata: { contentType: 'application/json' },
      })
      this.ctx.storage.transactionSync(() => {
        sql.exec(`DELETE FROM outbox WHERE version = ?`, change.version)
        const w = change.watermark
        // The incarnation test keeps a late change of a replaced stream from moving the new one.
        if (w) sql.exec(`UPDATE stream SET logged = MAX(logged, ?) WHERE shard = ? AND incarnation = ?`, w.seq, w.shard, w.incarnation)
      })
      written++
    }
    await this.ctx.storage.deleteAlarm()
    return written
  }

  async alarm(): Promise<void> {
    try {
      await this.drainSerial()
    } catch {
      await this.ctx.storage.setAlarm(Date.now() + DRAIN_RETRY_MS)
    }
  }

  /** Changes committed but not yet written to R2. */
  async outboxDepth(): Promise<number> {
    return this.ctx.storage.sql.exec(`SELECT COUNT(*) AS n FROM outbox`).one().n as number
  }

  // ───────────────────────────── rebuild ─────────────────────────────

  /**
   * Rebuild an empty ledger from R2 and start a new ledger incarnation.
   *
   * Refuses unless there are no live files, no streams and nothing in the outbox. This runs
   * automatically when the object starts on storage that has no incarnation; calling it by
   * hand is for an operator who has emptied the ledger. See the README for what it
   * guarantees.
   */
  async rebuildFromLog(): Promise<RebuildResult> {
    // An exception escaping blockConcurrencyWhile resets the object, so failures are
    // carried out of it as values and thrown here.
    const outcome = await this.ctx.blockConcurrencyWhile(async (): Promise<RebuildResult | Error> => {
      try {
        this.schema()
        const sql = this.ctx.storage.sql
        const n = (t: string) => sql.exec(`SELECT COUNT(*) AS n FROM ${t}`).one().n as number
        if (n('file') > 0 || n('stream') > 0 || n('outbox') > 0) return new Error('ledger: rebuildFromLog requires an empty ledger')
        return await this.startIncarnation()
      } catch (e) {
        return e instanceof Error ? e : new Error(String(e))
      }
    })
    if (outcome instanceof Error) throw outcome
    return outcome
  }

  private async startIncarnation(): Promise<RebuildResult> {
    const source = await this.latestIncarnation()
    const files = new Map<string, StoredFile>()
    const streams = new Map<string, StoredStream>()
    // Removals seen in the replayed log. Their objects may or may not have been deleted
    // already; deleting again is harmless, forgetting them would leak the objects.
    const buried = new Map<string, Tombstone>()
    let version = 0
    let changesReplayed = 0
    if (source !== null) ({ version, changesReplayed } = await this.replay(source, files, streams, buried))

    // Higher than anything in R2 and than anything this storage has used.
    const incarnation = Math.max(source ?? 0, this.meta('incarnation') ?? 0) + 1
    const base: LedgerBase = {
      ledgerIncarnation: incarnation,
      version,
      at: Date.now(),
      kind: 'base',
      added: [...files.values()].map(({ unit: _unit, ...entry }) => entry),
      removed: [],
      watermarks: [...streams.values()].map((st) => ({ shard: st.shard, incarnation: st.incarnation, seq: st.watermark })),
    }
    // R2 first: the incarnation number is taken, and the rebuilt state is itself durable,
    // before SQLite says so. A crash in between wastes a number and nothing else.
    await this.bucket.put(`${this.cell}/${ledgerBaseKey(this.tenant, incarnation)}`, JSON.stringify(base), {
      httpMetadata: { contentType: 'application/json' },
    })

    const sql = this.ctx.storage.sql
    this.ctx.storage.transactionSync(() => {
      sql.exec(`DELETE FROM file`)
      sql.exec(`DELETE FROM stream`)
      sql.exec(`DELETE FROM outbox`)
      sql.exec(`DELETE FROM tombstone`)
      for (const t of buried.values()) {
        if (!files.has(t.key)) sql.exec(`INSERT INTO tombstone (key, tbl, version, at) VALUES (?, ?, ?, ?)`, t.key, t.table, t.version, t.at)
      }
      for (const f of files.values()) this.insertFile(f, f.unit)
      for (const st of streams.values()) {
        // Everything replayed came from R2, so it is logged by definition.
        sql.exec(
          `INSERT INTO stream (shard, incarnation, watermark, logged, prev_incarnation) VALUES (?, ?, ?, ?, ?)`,
          st.shard, st.incarnation, st.watermark, st.watermark, st.previousIncarnation,
        )
      }
      sql.exec(`INSERT INTO meta (k, v) VALUES ('incarnation', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v`, incarnation)
      sql.exec(`INSERT INTO meta (k, v) VALUES ('version', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v`, version)
    })
    return { ledgerIncarnation: incarnation, version, source, changesReplayed, files: files.size, streams: streams.size }
  }

  /** Highest ledger incarnation with anything in R2, or null. */
  private async latestIncarnation(): Promise<number | null> {
    const prefix = this.incarnationPrefix()
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

  /**
   * Load one incarnation's base and apply its changes in version order. Fails, rather than
   * guessing, if the log has a hole or a change does not fit the state before it.
   */
  private async replay(
    source: number,
    files: Map<string, StoredFile>,
    streams: Map<string, StoredStream>,
    buried: Map<string, Tombstone>,
  ): Promise<{ version: number; changesReplayed: number }> {
    const prefix = this.incarnationPrefix(source)
    let version = 0
    // An incarnation's log starts at its `base`. Without one there is nothing to start from:
    // an incarnation writes its base before it commits anything else.
    const baseObject = await this.bucket.get(`${this.cell}/${ledgerBaseKey(this.tenant, source)}`)
    if (!baseObject) throw new Error(`ledger: incarnation ${source} has log objects but no base`)
    const base = await baseObject.json<LedgerBase>()
    if (base.kind !== 'base' || base.ledgerIncarnation !== source || !Array.isArray(base.added) || !Array.isArray(base.watermarks)) {
      throw new Error(`ledger: base of incarnation ${source} is not a base change`)
    }
    version = base.version
    for (const f of base.added) files.set(f.key, { ...f, unit: null })
    for (const w of base.watermarks) streams.set(w.shard, { shard: w.shard, incarnation: w.incarnation, watermark: w.seq, previousIncarnation: null })

    const pending: { version: number; key: string }[] = []
    let cursor: string | undefined
    do {
      const page = await this.bucket.list({ prefix, cursor })
      for (const o of page.objects) {
        const m = CHANGE_OBJECT.exec(o.key)
        if (m && Number(m[1]) > version) pending.push({ version: Number(m[1]), key: o.key })
      }
      cursor = page.truncated ? page.cursor : undefined
    } while (cursor)
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
        if (c.ledgerIncarnation !== source || c.version !== version + 1) {
          throw new Error(`ledger: log of incarnation ${source} is not contiguous at version ${version + 1}`)
        }
        this.apply(c, files, streams, buried)
        version = c.version
        changesReplayed++
      }
    }
    return { version, changesReplayed }
  }

  private apply(c: LedgerChange, files: Map<string, StoredFile>, streams: Map<string, StoredStream>, buried: Map<string, Tombstone>): void {
    const bad = (why: string) => new Error(`ledger: cannot replay version ${c.version}: ${why}`)
    for (const k of c.removed) {
      const f = files.get(k)
      if (!f) throw bad(`removes ${k}, which is not live`)
      files.delete(k)
      buried.set(k, { key: k, table: f.table, version: c.version, at: c.at })
    }
    let unit: UnitRef | null = null
    const w = c.watermark
    if (c.kind === 'base') throw bad('a base entry inside the version sequence')
    if (c.kind === 'register_stream') {
      if (!w) throw bad('no stream')
      const old = streams.get(w.shard)
      if (old && w.incarnation < old.incarnation) throw bad('registers a lower stream incarnation')
      streams.set(w.shard, { shard: w.shard, incarnation: w.incarnation, watermark: w.seq, previousIncarnation: old?.incarnation ?? null })
    } else if (c.kind === 'add_unit') {
      const s = w && streams.get(w.shard)
      if (!w || !s || s.incarnation !== w.incarnation || w.seq <= s.watermark) throw bad('unit does not extend its stream')
      // The change carries the admitted range, so contiguity is checked rather than assumed.
      if (!c.unit || c.unit.seqLo !== s.watermark + 1 || c.unit.seqHi !== w.seq) throw bad('unit range is not contiguous with the watermark')
      unit = { shard: w.shard, incarnation: w.incarnation, seqLo: c.unit.seqLo, seqHi: c.unit.seqHi }
      s.watermark = w.seq
    }
    for (const f of c.added) {
      if (files.has(f.key)) throw bad(`adds ${f.key}, which is already live`)
      files.set(f.key, { ...f, unit })
    }
  }
}
