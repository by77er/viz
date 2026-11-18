import { DurableObject } from 'cloudflare:workers'
import {
  ledgerLogKey,
  type AddUnitResult,
  type ExpireRequest,
  type FileEntry,
  type FlushUnit,
  type LedgerChange,
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
 *   ledger/tenant={t}/{incarnation}/base.json            state at the start of the incarnation
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

type StoredFile = FileEntry & { unit: UnitRef | null }

interface StoredStream {
  shard: string
  incarnation: number
  watermark: number
  previousIncarnation: number | null
}

/** `base.json`: the whole ledger state at the moment an incarnation starts. */
export interface LedgerBase {
  ledgerIncarnation: number
  /** Version the incarnation starts from. Its first change is `version + 1`. */
  version: number
  at: number
  /** Incarnation whose log was replayed to produce this state, or null for a first start. */
  source: number | null
  files: StoredFile[]
  streams: StoredStream[]
}

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

function checkFile(f: FileEntry): void {
  if (typeof f !== 'object' || f === null) throw new Error('ledger: file entry is not an object')
  if (typeof f.key !== 'string' || f.key === '') throw new Error('ledger: file key must be a non-empty string')
  if (!TABLES.includes(f.table)) throw new Error(`ledger: unknown table for ${f.key}`)
  if (typeof f.day !== 'string' || !DAY.test(f.day)) throw new Error(`ledger: bad day for ${f.key}`)
  if (!isCount(f.bytes) || !isCount(f.rows) || !isCount(f.level)) throw new Error(`ledger: bad bytes/rows/level for ${f.key}`)
  if (!Number.isSafeInteger(f.minTs) || !Number.isSafeInteger(f.maxTs) || f.minTs > f.maxTs) throw new Error(`ledger: bad time range for ${f.key}`)
  if (typeof f.index !== 'string') throw new Error(`ledger: index fragment must be a string for ${f.key}`)
}

/** Validate a list of files and refuse a key that appears twice in it. */
function checkFiles(files: FileEntry[]): void {
  if (!Array.isArray(files)) throw new Error('ledger: files must be an array')
  const seen = new Set<string>()
  for (const f of files) {
    checkFile(f)
    if (seen.has(f.key)) throw new Error(`ledger: duplicate file key in request: ${f.key}`)
    seen.add(f.key)
  }
}

function checkRef(ref: StreamRef): void {
  if (typeof ref.shard !== 'string' || ref.shard === '') throw new Error('ledger: shard must be a non-empty string')
  if (!isCount(ref.incarnation)) throw new Error('ledger: incarnation must be a non-negative integer')
}

const toEntry = (r: Row): FileEntry => ({
  table: r.tbl as Table,
  day: r.day as string,
  key: r.key as string,
  bytes: r.bytes as number,
  rows: r.rows as number,
  minTs: r.min_ts as number,
  maxTs: r.max_ts as number,
  level: r.level as number,
  index: r.idx as string,
})

const toStored = (r: Row): StoredFile => ({
  ...toEntry(r),
  unit:
    r.u_shard === null
      ? null
      : { shard: r.u_shard as string, incarnation: r.u_inc as number, seqLo: r.u_lo as number, seqHi: r.u_hi as number },
})

export class Ledger extends DurableObject<LedgerEnv> implements LedgerRpc {
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
    // The log key embeds the tenant unescaped; a `/` would nest one tenant's log in another's.
    if (tenant.includes('/')) throw new Error('ledger: tenant must not contain "/"')
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
      u_shard TEXT, u_inc INTEGER, u_lo INTEGER, u_hi INTEGER)`)
    sql.exec(`CREATE INDEX IF NOT EXISTS file_tbl_day ON file (tbl, day)`)
    sql.exec(`CREATE INDEX IF NOT EXISTS file_tbl_max ON file (tbl, max_ts)`)
    sql.exec(`CREATE TABLE IF NOT EXISTS stream (
      shard TEXT PRIMARY KEY, incarnation INTEGER NOT NULL, watermark INTEGER NOT NULL,
      logged INTEGER NOT NULL, prev_incarnation INTEGER)`)
    sql.exec(`CREATE TABLE IF NOT EXISTS outbox (version INTEGER PRIMARY KEY, body TEXT NOT NULL)`)
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

  private insertFile(f: FileEntry, unit: UnitRef | null): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO file (key, tbl, day, bytes, rows, min_ts, max_ts, level, idx, u_shard, u_inc, u_lo, u_hi)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      f.key, f.table, f.day, f.bytes, f.rows, f.minTs, f.maxTs, f.level, f.index,
      unit?.shard ?? null, unit?.incarnation ?? null, unit?.seqLo ?? null, unit?.seqHi ?? null,
    )
  }

  /**
   * Bump the version and put the change in the outbox. Must be called inside the same
   * `transactionSync` as the mutation it describes; that is what makes "committed" and
   * "will be logged" the same event.
   */
  private record(kind: LedgerChange['kind'], added: FileEntry[], removed: string[], watermark?: Watermark): number {
    const sql = this.ctx.storage.sql
    const version = this.version() + 1
    sql.exec(`INSERT INTO meta (k, v) VALUES ('version', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v`, version)
    const change: LedgerChange = { ledgerIncarnation: this.ledgerIncarnation(), version, at: Date.now(), kind, added, removed }
    if (watermark) change.watermark = watermark
    sql.exec(`INSERT INTO outbox (version, body) VALUES (?, ?)`, version, JSON.stringify(change))
    return version
  }

  /** After a committed mutation: make sure a retry is scheduled, then try to log it now. */
  private async afterCommit(): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + DRAIN_RETRY_MS)
    // The mutation is committed whether or not R2 is reachable; a failed drain is retried
    // by the alarm, and until then `loggedWatermarks` simply lags.
    await this.drain().catch(() => undefined)
  }

  // ───────────────────────────── LedgerRpc ─────────────────────────────

  async registerStream(ref: StreamRef): Promise<{ version: number; previousIncarnation: number | null }> {
    checkRef(ref)
    const known = this.stream(ref.shard)
    if (known && known.incarnation === ref.incarnation) {
      // Idempotent: a retried registration gets the answer the first one got.
      return { version: this.version(), previousIncarnation: known.previousIncarnation }
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
    checkRef(unit)
    if (!Number.isSafeInteger(unit.seqLo) || !Number.isSafeInteger(unit.seqHi) || unit.seqLo < 1 || unit.seqHi < unit.seqLo) {
      throw new Error('ledger: bad sequence range')
    }
    checkFiles(unit.files)
    const ref: UnitRef = { shard: unit.shard, incarnation: unit.incarnation, seqLo: unit.seqLo, seqHi: unit.seqHi }

    const known = this.stream(unit.shard)
    if (!known) {
      // A shard seen for the first time may introduce itself with its first unit. Anything
      // else from an unknown shard is refused: the ledger has no watermark to extend.
      if (unit.seqLo !== 1) return { status: 'not_contiguous', watermark: 0 }
    } else {
      if (known.incarnation !== unit.incarnation) return { status: 'incarnation_mismatch', incarnation: known.incarnation }
      if (unit.seqHi <= known.watermark) {
        // Replay of a unit admitted earlier, if these are that unit's files and still live.
        const same = unit.files.every((f) => {
          const u = this.liveFile(f.key)?.unit
          return !!u && u.shard === ref.shard && u.incarnation === ref.incarnation && u.seqLo === ref.seqLo && u.seqHi === ref.seqHi
        })
        return same
          ? { status: 'ok', version: this.version(), watermark: known.watermark }
          : { status: 'not_contiguous', watermark: known.watermark }
      }
      if (unit.seqLo !== known.watermark + 1) return { status: 'not_contiguous', watermark: known.watermark }
    }
    // Past the replay check, a key that is already live belongs to some other unit or to a
    // compaction output. Checked for every file before anything is written.
    for (const f of unit.files) {
      if (this.liveFile(f.key)) throw new Error(`ledger: file key already live in another unit: ${f.key}`)
    }

    const version = this.ctx.storage.transactionSync(() => {
      if (!known) this.register(unit, null)
      for (const f of unit.files) this.insertFile(f, ref)
      this.ctx.storage.sql.exec(`UPDATE stream SET watermark = ? WHERE shard = ?`, unit.seqHi, unit.shard)
      return this.record('add_unit', unit.files, [], { shard: unit.shard, incarnation: unit.incarnation, seq: unit.seqHi })
    })
    await this.afterCommit()
    return { status: 'ok', version, watermark: unit.seqHi }
  }

  async plan(req: PlanRequest): Promise<Plan> {
    if (!TABLES.includes(req.table)) throw new Error('ledger: unknown table')
    // No await between these reads, so they see one version.
    const sql = this.ctx.storage.sql
    const files = sql
      .exec(`SELECT * FROM file WHERE tbl = ? AND max_ts >= ? AND min_ts <= ? ORDER BY key`, req.table, req.minTs, req.maxTs)
      .toArray()
      .map(toEntry)
    const watermarks = sql
      .exec(`SELECT shard, incarnation, watermark FROM stream ORDER BY shard`)
      .toArray()
      .map((r): Watermark => ({ shard: r.shard as string, incarnation: r.incarnation as number, seq: r.watermark as number }))
    return { ledgerIncarnation: this.ledgerIncarnation(), version: this.version(), files, watermarks }
  }

  async replace(req: ReplaceRequest): Promise<ReplaceResult> {
    if (!Array.isArray(req.remove) || req.remove.some((k) => typeof k !== 'string' || k === '')) {
      throw new Error('ledger: remove must be a list of keys')
    }
    checkFiles(req.add)
    const remove = [...new Set(req.remove)]
    if (remove.length === 0 && req.add.length === 0) return { status: 'ok', version: this.version() }

    const missing = remove.filter((k) => !this.liveFile(k))
    if (missing.length > 0) {
      // A retry of a swap that already happened: every input gone, every output live.
      const done = missing.length === remove.length && req.add.length > 0 && req.add.every((f) => this.liveFile(f.key)?.unit === null)
      return done ? { status: 'ok', version: this.version() } : { status: 'conflict', missing }
    }
    for (const f of req.add) {
      if (remove.includes(f.key)) throw new Error(`ledger: key is in both remove and add: ${f.key}`)
      if (this.liveFile(f.key)) throw new Error(`ledger: file key already live: ${f.key}`)
    }

    const version = this.ctx.storage.transactionSync(() => {
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
  async drain(): Promise<number> {
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
      await this.drain()
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
    let version = 0
    let changesReplayed = 0
    if (source !== null) ({ version, changesReplayed } = await this.replay(source, files, streams))

    // Higher than anything in R2 and than anything this storage has used.
    const incarnation = Math.max(source ?? 0, this.meta('incarnation') ?? 0) + 1
    const base: LedgerBase = {
      ledgerIncarnation: incarnation,
      version,
      at: Date.now(),
      source,
      files: [...files.values()],
      streams: [...streams.values()],
    }
    // R2 first: the incarnation number is taken, and the rebuilt state is itself durable,
    // before SQLite says so. A crash in between wastes a number and nothing else.
    await this.bucket.put(`${this.incarnationPrefix(incarnation)}base.json`, JSON.stringify(base), {
      httpMetadata: { contentType: 'application/json' },
    })

    const sql = this.ctx.storage.sql
    this.ctx.storage.transactionSync(() => {
      sql.exec(`DELETE FROM file`)
      sql.exec(`DELETE FROM stream`)
      sql.exec(`DELETE FROM outbox`)
      for (const f of base.files) this.insertFile(f, f.unit)
      for (const s of base.streams) {
        // Everything replayed came from R2, so it is logged by definition.
        sql.exec(
          `INSERT INTO stream (shard, incarnation, watermark, logged, prev_incarnation) VALUES (?, ?, ?, ?, ?)`,
          s.shard, s.incarnation, s.watermark, s.watermark, s.previousIncarnation,
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
  ): Promise<{ version: number; changesReplayed: number }> {
    const prefix = this.incarnationPrefix(source)
    let version = 0
    const baseObject = await this.bucket.get(`${prefix}base.json`)
    if (baseObject) {
      const base = await baseObject.json<LedgerBase>()
      version = base.version
      for (const f of base.files) files.set(f.key, f)
      for (const s of base.streams) streams.set(s.shard, s)
    }

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
        this.apply(c, files, streams)
        version = c.version
        changesReplayed++
      }
    }
    return { version, changesReplayed }
  }

  private apply(c: LedgerChange, files: Map<string, StoredFile>, streams: Map<string, StoredStream>): void {
    const bad = (why: string) => new Error(`ledger: cannot replay version ${c.version}: ${why}`)
    for (const k of c.removed) {
      if (!files.delete(k)) throw bad(`removes ${k}, which is not live`)
    }
    let unit: UnitRef | null = null
    const w = c.watermark
    if (c.kind === 'register_stream') {
      if (!w) throw bad('no stream')
      const old = streams.get(w.shard)
      streams.set(w.shard, { shard: w.shard, incarnation: w.incarnation, watermark: w.seq, previousIncarnation: old?.incarnation ?? null })
    } else if (c.kind === 'add_unit') {
      const s = w && streams.get(w.shard)
      if (!w || !s || s.incarnation !== w.incarnation || w.seq <= s.watermark) throw bad('unit does not extend its stream')
      // The change does not carry seqLo; contiguity at admission makes it the old watermark + 1.
      unit = { shard: w.shard, incarnation: w.incarnation, seqLo: s.watermark + 1, seqHi: w.seq }
      s.watermark = w.seq
    }
    for (const f of c.added) {
      if (files.has(f.key)) throw bad(`adds ${f.key}, which is already live`)
      files.set(f.key, { ...f, unit })
    }
  }
}
