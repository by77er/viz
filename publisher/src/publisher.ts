import { DurableObject } from 'cloudflare:workers'
import { openSchema, refusalOf, type SchemaState, SchemaTooNewError } from '../../contracts/schema'
import { TENANT_ID, type FileEntry, type Table } from '../../contracts/ledger'
import { readAvro, writeAvro, type AvroCodec } from './avro'
import {
  CURSORS_FORMAT_VERSION,
  CURSORS_KEY,
  metadataProblem,
  MANIFEST_ENTRY_SCHEMA,
  MANIFEST_LIST_SCHEMA,
  STATUS_ADDED,
  STATUS_DELETED,
  STATUS_EXISTING,
  TABLE_NAMES,
  emptyMetadata,
  expiryDeadline,
  liveFromEntry,
  manifestEntry,
  manifestHeader,
  manifestInfoFromRecord,
  manifestListRecord,
  nextMetadata,
  statsFor,
  summarise,
  type FileStats,
  type LiveFile,
  type ManifestEntryRecord,
  type ManifestInfo,
  type ManifestListRecord,
  type Retention,
  type Snapshot,
  type TableMetadata,
} from './iceberg'
import { PUBLISHER_SCHEMA } from './schema'
import { cursorCompare, inBatches, listTenants, readTenantLog, replayAt, type Cursor, type LogStatus, type Store, type TenantLog } from './log'

/**
 * The jobs the publisher's one alarm serves (design/DECISIONS.md D31). Each deadline is a row
 * of `due`, in the publisher's clock; the alarm is set at the earliest and deleted when there
 * is none, so an idle publisher has no alarm and costs nothing.
 *
 *   publish         tenants are pending: set by `notify` (coalescing nudges for
 *                   `publishIntervalMs`), or by a publish that left some (retry after `retryMs`)
 *   sweep           metadata objects may be unreferenced: a commit or a failed attempt happened
 *                   (`orphanGraceMs` later), or the last sweep marked objects (their grace end)
 *   expire:<table>  every snapshot beyond the newest `minSnapshots` will be outside the window
 */
type Job = 'publish' | 'sweep' | `expire:${Table}`

/**
 * The publisher: one Durable Object per cell (the cell id is the object's name). It is the
 * single writer of the cell's Iceberg metadata, which it derives from the tenants' ledger
 * change logs in R2. See design/DESIGN.md §5.3 and the README.
 *
 * Truth and cache. The Iceberg table in R2 is the truth about what is published. SQLite
 * here is a cache of it (the live files of the current snapshot, which manifest holds each,
 * the per-tenant cursors) plus bookkeeping that only the publisher has (removed files
 * waiting for their snapshots to expire, orphan sightings, pending tenants). A commit is
 * one conditional R2 write of `v{N+1}.metadata.json`; SQLite is updated after it. If SQLite
 * and R2 disagree about the version, SQLite is rebuilt from R2 (`resync`), which is also
 * how a crash between any two steps of a commit converges.
 *
 * Nothing is kept in memory between requests except `queue`, a single-flight guard.
 */

export interface PublisherEnv {
  BUCKET: R2Bucket
  /** URI of the bucket root as readers see it, e.g. `s3://viz-lake`. No trailing slash. */
  ICEBERG_LOCATION_PREFIX?: string
}

export interface PublisherConfig {
  /** Prefix of every absolute URI written into metadata: `{locationPrefix}/{r2 key}`. */
  locationPrefix: string
  /** Snapshots are kept this long (and never fewer than `minSnapshots`, at least 2). */
  snapshotWindowMs: number
  minSnapshots: number
  /** Merge small manifests when a commit would leave more than this many. */
  maxManifests: number
  /** Entries per manifest written by an append or a merge. */
  manifestTargetEntries: number
  /** An unreferenced metadata object is deleted this long after the sweep first saw it. */
  orphanGraceMs: number
  /** A removed data file is handed to deletion this long after its last snapshot expired. */
  deleteGraceMs: number
  /** Previous metadata files kept in `metadata-log`. */
  metadataLogMax: number
  /** Delay before the alarm retries tenants that could not be published. */
  retryMs: number
  /** Delay between a `notify` and the publish it causes, so that nudges coalesce. */
  publishIntervalMs: number
  codec: AvroCodec
  /** Changes read per tenant per publish. More than this is finished by the alarm. */
  maxChangesPerTenant: number
}

const DEFAULTS: Omit<PublisherConfig, 'locationPrefix'> = {
  snapshotWindowMs: 24 * 3_600_000,
  minSnapshots: 2,
  maxManifests: 16,
  manifestTargetEntries: 10_000,
  orphanGraceMs: 3_600_000,
  deleteGraceMs: 3_600_000,
  metadataLogMax: 20,
  retryMs: 60_000,
  publishIntervalMs: 120_000,
  codec: 'deflate',
  maxChangesPerTenant: 2_000,
}

export interface R2Ops {
  list: number
  get: number
  head: number
  put: number
  delete: number
}

/** Counts R2 operations, so a publish can report what it cost. */
class CountingBucket implements Store {
  readonly ops: R2Ops = { list: 0, get: 0, head: 0, put: 0, delete: 0 }
  constructor(private readonly bucket: R2Bucket) {}
  get(key: string) {
    this.ops.get++
    return this.bucket.get(key)
  }
  head(key: string) {
    this.ops.head++
    return this.bucket.head(key)
  }
  list(options: R2ListOptions) {
    this.ops.list++
    return this.bucket.list(options)
  }
  put(key: string, value: string | Uint8Array, options?: R2PutOptions) {
    this.ops.put++
    return this.bucket.put(key, value, options) as Promise<R2Object | null>
  }
  delete(keys: string | string[]) {
    this.ops.delete += Array.isArray(keys) ? keys.length : 1
    return this.bucket.delete(keys)
  }
}

export type TenantStatus = LogStatus | 'invalid' | 'inconsistent'

export interface TenantReport {
  tenant: string
  status: TenantStatus
  detail?: string
  /** Version named by a `gap`. */
  gapAt?: number
  /** The cursor each table is at after this publish. */
  cursors: Partial<Record<Table, Cursor>>
}

export interface TableReport {
  /** Metadata version after this publish (0: the table does not exist yet). */
  version: number
  /** Snapshot written by this publish, or null if nothing changed. */
  snapshotId: number | null
  added: number
  removed: number
  manifestsWritten: number
  manifestsMerged: number
  /** Bytes written to R2 for this commit, by kind. */
  bytes: { manifests: number; manifestList: number; cursors: number; metadata: number }
  commitMs: number
}

export interface PublishResult {
  tenants: TenantReport[]
  tables: Record<Table, TableReport>
  /** Conditional-write losses that were retried. */
  conflicts: number
  ops: R2Ops
  ms: number
}

export interface VerifyResult {
  ok: boolean
  table: Table
  /** Metadata version in R2, and the one SQLite believes. */
  metadataVersion: number
  stateVersion: number
  snapshotId: number | null
  files: number
  tenants: number
  /** Live in a ledger at its cursor, absent from the snapshot. */
  missingFromIceberg: string[]
  /** In the snapshot, not live in the ledger at its cursor. */
  extraInIceberg: string[]
  /** In both, but the manifest entry disagrees with the ledger's file entry. */
  mismatched: { key: string; field: string; iceberg: string | number; ledger: string | number }[]
  /** A data file listed more than once in the snapshot. */
  duplicates: string[]
  /** Referenced objects (data files, manifests, manifest list, cursor object) not in R2. */
  missingObjects: string[]
  sizeMismatch: { key: string; recorded: number; actual: number }[]
  /** Anything else: an unreadable log, a cursor behind the snapshot's, a version mismatch. */
  problems: string[]
}

interface TablePlan {
  adds: { tenant: string; entry: FileEntry }[]
  removes: { tenant: string; key: string }[]
  /** Removed from the ledger before they were ever published. */
  transient: { tenant: string; key: string }[]
  cursors: Map<string, Cursor>
  problems: Map<string, string>
}

/** A conditional write lost, or SQLite was found behind R2. The caller starts over. */
class Conflict extends Error {}

/**
 * R2 holds metadata or a cursors object written by a newer publisher than this code
 * (contracts/COMPATIBILITY.md §5). Nothing is committed, swept or overwritten; the tenants
 * stay pending and the alarm retries until a release that understands it runs.
 */
export class MetadataTooNew extends Error {
  override name = 'MetadataTooNew'
}

function checkMetadata(meta: TableMetadata, key: string): void {
  const problem = metadataProblem(meta)
  if (problem) throw new MetadataTooNew(`metadata_too_new: ${key}: ${problem}`)
}

type Row = Record<string, SqlStorageValue>
type Part = { file: LiveFile; status: number }

interface TableState {
  version: number
  snapshotId: number | null
  seq: number
  uuid: string
}

const META_FILE = /\/v(\d+)\.metadata\.json$/
const FANOUT = 6

const emptyReport = (version: number): TableReport => ({
  version,
  snapshotId: null,
  added: 0,
  removed: 0,
  manifestsWritten: 0,
  manifestsMerged: 0,
  bytes: { manifests: 0, manifestList: 0, cursors: 0, metadata: 0 },
  commitMs: 0,
})

const toLive = (r: Row): LiveFile => ({
  key: r.key as string,
  tenant: r.tenant as string,
  day: r.day as string,
  rows: r.rows as number,
  bytes: r.bytes as number,
  snapshotId: r.snapshot_id as number,
  seq: r.seq as number,
  fileSeq: r.file_seq as number,
  stats: JSON.parse(r.stats as string) as FileStats,
})

export class Publisher extends DurableObject<PublisherEnv> {
  protected readonly cell: string
  /** Single-flight guard: publishes, sweeps and maintenance run one after another. */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(ctx: DurableObjectState, env: PublisherEnv) {
    super(ctx, env)
    const name = ctx.id.name
    if (!name) throw new Error('publisher: the object must be addressed by name (the cell id)')
    this.cell = this.cellOf(name)
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(this.cell)) throw new Error('publisher: cell id must match [A-Za-z0-9_-]{1,64}')
    // Versioned storage (contracts/COMPATIBILITY.md §2): migrate, or refuse storage a newer
    // release wrote. Local SQLite only, so holding other events off for it is allowed.
    void ctx.blockConcurrencyWhile(async () => {
      this.schemaState = openSchema(ctx.storage, PUBLISHER_SCHEMA)
    })
  }

  /** What opening storage found. Anything but `ok`: every method throws `SchemaTooNewError` and nothing is written. */
  private schemaState: SchemaState = { status: 'schema_too_new', component: PUBLISHER_SCHEMA.component, found: 0, compat: 0, known: 0, retryAfterMs: 0 }

  /**
   * Storage a newer release wrote: refuse. The publisher's results are reports, not status
   * unions, and its callers (a queue consumer, a cron) retry on an exception, so it throws
   * (contracts/COMPATIBILITY.md §2.4).
   */
  private guard(): void {
    const refused = refusalOf(this.schemaState)
    if (refused) throw new SchemaTooNewError(refused)
  }

  // ───────────────────────────── seams for tests ─────────────────────────────

  /** The cell an object name stands for. Tests override it to run two writers on one cell. */
  protected cellOf(name: string): string {
    return name
  }

  protected now(): number {
    return Date.now()
  }

  /** Called after each step of a commit. Tests override it to stop or pause there. */
  protected async step(_name: CommitStep, _table: Table): Promise<void> {}

  // ───────────────────────────── storage ─────────────────────────────

  private get sql(): SqlStorage {
    return this.ctx.storage.sql
  }

  private config(): PublisherConfig {
    const stored: Record<string, unknown> = {}
    for (const r of this.sql.exec(`SELECT k, v FROM config`).toArray()) stored[r.k as string] = JSON.parse(r.v as string)
    return { ...DEFAULTS, locationPrefix: this.env.ICEBERG_LOCATION_PREFIX || 's3://viz-lake', ...stored } as PublisherConfig
  }

  private state(table: Table): TableState {
    const r = this.sql.exec(`SELECT version, snapshot_id, seq, uuid FROM tbl WHERE name = ?`, table).toArray()[0]
    if (!r) return { version: 0, snapshotId: null, seq: 0, uuid: '' }
    return { version: r.version as number, snapshotId: r.snapshot_id as number | null, seq: r.seq as number, uuid: r.uuid as string }
  }

  private cursorOf(table: Table, tenant: string): Cursor | null {
    const r = this.sql.exec(`SELECT incarnation, version FROM cursor WHERE tbl = ? AND tenant = ?`, table, tenant).toArray()[0]
    return r ? { ledgerIncarnation: r.incarnation as number, version: r.version as number } : null
  }

  private setCursor(table: Table, tenant: string, c: Cursor): void {
    this.sql.exec(
      `INSERT INTO cursor (tbl, tenant, incarnation, version) VALUES (?, ?, ?, ?)
       ON CONFLICT (tbl, tenant) DO UPDATE SET incarnation = excluded.incarnation, version = excluded.version`,
      table, tenant, c.ledgerIncarnation, c.version,
    )
  }

  private insertLive(table: Table, f: LiveFile, manifest: string): void {
    this.sql.exec(
      `INSERT INTO live (tbl, key, tenant, day, rows, bytes, snapshot_id, seq, file_seq, stats, manifest) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      table, f.key, f.tenant, f.day, f.rows, f.bytes, f.snapshotId, f.seq, f.fileSeq, JSON.stringify(f.stats), manifest,
    )
  }

  // ───────────────────────────── paths ─────────────────────────────

  private metaDir(table: Table): string {
    return `${this.cell}/iceberg/${table}/metadata/`
  }
  private metaKey(table: Table, version: number): string {
    return `${this.metaDir(table)}v${version}.metadata.json`
  }
  private hintKey(table: Table): string {
    return `${this.metaDir(table)}version-hint.text`
  }
  private uri(cfg: PublisherConfig, key: string): string {
    return `${cfg.locationPrefix}/${key}`
  }
  private keyOf(cfg: PublisherConfig, uri: string): string {
    const p = `${cfg.locationPrefix}/`
    if (!uri.startsWith(p)) throw new Error(`publisher: ${uri} is not under the configured location ${cfg.locationPrefix}`)
    return uri.slice(p.length)
  }

  // ───────────────────────────── public surface ─────────────────────────────

  /**
   * Change settings. `locationPrefix` is written into every metadata file as part of
   * absolute URIs, so it can only be set before the first commit.
   */
  async configure(patch: Partial<PublisherConfig>): Promise<PublisherConfig> {
    this.guard()
    if (patch.locationPrefix !== undefined) {
      if (patch.locationPrefix.endsWith('/')) throw new Error('publisher: locationPrefix must not end with a slash')
      const current = this.config().locationPrefix
      const committed = TABLE_NAMES.some((t) => this.state(t).version > 0)
      if (committed && patch.locationPrefix !== current) throw new Error('publisher: locationPrefix cannot change once a table has been committed')
    }
    if (patch.minSnapshots !== undefined && patch.minSnapshots < 2) throw new Error('publisher: minSnapshots must be at least 2')
    if (patch.codec !== undefined && patch.codec !== 'deflate' && patch.codec !== 'null') throw new Error('publisher: codec must be deflate or null')
    for (const [k, v] of Object.entries(patch)) {
      if (!(k in DEFAULTS) && k !== 'locationPrefix') throw new Error(`publisher: unknown setting ${k}`)
      this.sql.exec(`INSERT INTO config (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v`, k, JSON.stringify(v))
    }
    return this.config()
  }

  /**
   * Publish what the ledgers have logged since the last publication. With no argument,
   * every tenant that has a ledger log in the cell is considered. Idempotent: with nothing
   * new, it writes nothing.
   */
  async publish(tenants?: string[]): Promise<PublishResult> {
    this.guard()
    return this.serial(() => this.publishNow(tenants))
  }

  /** A nudge: these tenants changed. The alarm publishes them after `publishIntervalMs`. */
  async notify(tenants: string[]): Promise<void> {
    this.guard()
    const now = this.now()
    for (const t of tenants) {
      // `since` is the latest nudge: a publish clears only nudges older than its own start.
      if (TENANT_ID.test(t)) this.sql.exec(`INSERT INTO pending (tenant, since) VALUES (?, ?) ON CONFLICT (tenant) DO UPDATE SET since = excluded.since`, t, now)
    }
    if (this.pendingTenants().length > 0 && (await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(now + this.config().publishIntervalMs)
    }
  }

  async alarm(): Promise<void> {
    const refused = refusalOf(this.schemaState)
    if (refused) {
      // Keep the alarm for the release that owns this storage; touch nothing else.
      await this.ctx.storage.setAlarm(Date.now() + refused.retryAfterMs)
      return
    }
    const tenants = this.pendingTenants()
    if (tenants.length > 0) {
      // A failure leaves the tenants pending; `scheduleAlarm` below sets the retry.
      await this.publish(tenants).catch(() => undefined)
    }
    await this.scheduleAlarm(true)
  }

  /** Tenants with unpublished work that the alarm will retry. */
  async pending(): Promise<string[]> {
    this.guard()
    return this.pendingTenants()
  }

  async cursors(table: Table): Promise<Record<string, Cursor>> {
    this.guard()
    const out: Record<string, Cursor> = {}
    for (const r of this.sql.exec(`SELECT tenant, incarnation, version FROM cursor WHERE tbl = ? ORDER BY tenant`, table).toArray()) {
      out[r.tenant as string] = { ledgerIncarnation: r.incarnation as number, version: r.version as number }
    }
    return out
  }

  /** Where a table is: metadata version, current snapshot, live files and manifests. */
  async status(table: Table): Promise<{ version: number; snapshotId: number | null; seq: number; files: number; manifests: number; metadataKey: string | null }> {
    this.guard()
    const s = this.state(table)
    const files = this.sql.exec(`SELECT COUNT(*) AS n FROM live WHERE tbl = ?`, table).one().n as number
    const manifests = this.sql.exec(`SELECT COUNT(*) AS n FROM manifest WHERE tbl = ?`, table).one().n as number
    return { version: s.version, snapshotId: s.snapshotId, seq: s.seq, files, manifests, metadataKey: s.version > 0 ? this.metaKey(table, s.version) : null }
  }

  // ───────────────────────────── publish ─────────────────────────────

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn)
    this.queue = run.catch(() => undefined)
    return run
  }

  private pendingTenants(): string[] {
    return this.sql.exec(`SELECT tenant FROM pending ORDER BY tenant`).toArray().map((r) => r.tenant as string)
  }

  /** One alarm, only while something is pending. */
  private async scheduleAlarm(fromAlarm = false): Promise<void> {
    if (this.pendingTenants().length === 0) {
      await this.ctx.storage.deleteAlarm()
    } else if (fromAlarm || (await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(this.now() + this.config().retryMs)
    }
  }

  private async publishNow(requested?: string[]): Promise<PublishResult> {
    const t0 = this.now()
    const cfg = this.config()
    const store = new CountingBucket(this.env.BUCKET)
    let conflicts = 0
    // The tenants being worked on, so that a failure can leave them pending for the alarm.
    let working: string[] = requested ?? []
    for (;;) {
      try {
        const result = await this.attempt(store, cfg, requested, (names) => { working = names })
        const done = new Set(result.tenants.filter((t) => t.status === 'ok' || t.status === 'no_log').map((t) => t.tenant))
        const now = this.now()
        for (const t of result.tenants) {
          // A nudge that arrived after this publish began may be about a change it did not read.
          if (done.has(t.tenant)) this.sql.exec(`DELETE FROM pending WHERE tenant = ? AND since <= ?`, t.tenant, t0)
          else if (t.status !== 'invalid') this.sql.exec(`INSERT INTO pending (tenant, since) VALUES (?, ?) ON CONFLICT (tenant) DO NOTHING`, t.tenant, now)
        }
        await this.scheduleAlarm()
        return { ...result, conflicts, ops: store.ops, ms: this.now() - t0 }
      } catch (e) {
        if (!(e instanceof Conflict) || ++conflicts > 3) {
          // Whatever was asked for is still unpublished: make sure the alarm comes back.
          const now = this.now()
          for (const t of working) {
            if (TENANT_ID.test(t)) this.sql.exec(`INSERT INTO pending (tenant, since) VALUES (?, ?) ON CONFLICT (tenant) DO NOTHING`, t, now)
          }
          await this.scheduleAlarm()
          throw e
        }
      }
    }
  }

  private async attempt(
    store: CountingBucket,
    cfg: PublisherConfig,
    requested: string[] | undefined,
    working: (names: string[]) => void,
  ): Promise<Omit<PublishResult, 'conflicts' | 'ops' | 'ms'>> {
    const names = [...new Set(requested ?? [...(await listTenants(store, this.cell)), ...this.pendingTenants()])].sort()
    working(names)
    const reports = new Map<string, TenantReport>()
    const valid: string[] = []
    for (const t of names) {
      if (TENANT_ID.test(t)) valid.push(t)
      else reports.set(t, { tenant: t, status: 'invalid', detail: 'tenant id must match [A-Za-z0-9_-]{1,64}', cursors: {} })
    }

    // Read each tenant's log once, from the lowest cursor any table has for it.
    const logs = await inBatches(valid, FANOUT, (tenant) => {
      let from: Cursor | null = null
      for (const table of TABLE_NAMES) {
        const c = this.cursorOf(table, tenant)
        if (!c) return readTenantLog(store, this.cell, tenant, null, cfg.maxChangesPerTenant)
        if (!from || cursorCompare(c, from) < 0) from = c
      }
      return readTenantLog(store, this.cell, tenant, from, cfg.maxChangesPerTenant)
    })
    for (const log of logs) {
      const r: TenantReport = { tenant: log.tenant, status: log.status, cursors: {} }
      if (log.detail) r.detail = log.detail
      if (log.gapAt !== undefined) r.gapAt = log.gapAt
      reports.set(log.tenant, r)
    }

    const tables = {} as Record<Table, TableReport>
    for (const table of TABLE_NAMES) {
      const plan = this.plan(table, logs)
      for (const [tenant, why] of plan.problems) {
        const r = reports.get(tenant) as TenantReport
        r.status = 'inconsistent'
        r.detail = why
      }
      tables[table] = await this.commit(store, cfg, table, plan)
      for (const log of logs) {
        const c = this.cursorOf(table, log.tenant)
        if (c) (reports.get(log.tenant) as TenantReport).cursors[table] = c
      }
    }
    return { tenants: [...reports.values()], tables }
  }

  /**
   * What one table has to change to reflect the logs: the NET difference between what is
   * published for each tenant and that tenant's live set after the changes read. A file
   * added and removed inside the changes read appears in neither list.
   */
  private plan(table: Table, logs: TenantLog[]): TablePlan {
    const plan: TablePlan = { adds: [], removes: [], transient: [], cursors: new Map(), problems: new Map() }
    for (const log of logs) {
      if (log.status === 'no_log' || log.status === 'no_base' || log.status === 'cursor_ahead') continue
      const tenant = log.tenant
      const cursor = this.cursorOf(table, tenant)
      if (cursor && cursor.ledgerIncarnation > log.incarnation) {
        plan.problems.set(tenant, `cursor of ${table} is at incarnation ${cursor.ledgerIncarnation}, R2 has ${log.incarnation}`)
        continue
      }
      const published = new Set(this.sql.exec(`SELECT key FROM live WHERE tbl = ? AND tenant = ?`, table, tenant).toArray().map((r) => r.key as string))
      const rebase = !cursor || cursor.ledgerIncarnation < log.incarnation
      // key -> the entry to add, or null if the file is already published.
      const work = new Map<string, FileEntry | null>()
      let start: number
      if (rebase) {
        // A new ledger incarnation: its base is the whole live set it starts from.
        if (!log.base) continue
        for (const f of log.base.added) if (f.table === table) work.set(f.key, published.has(f.key) ? null : f)
        start = log.base.version
      } else {
        for (const k of published) work.set(k, null)
        start = (cursor as Cursor).version
      }
      const dropped: string[] = []
      let problem: string | null = null
      let last = start
      for (const c of log.changes) {
        if (c.version <= start) continue
        for (const r of c.removedFiles) {
          // `removed` holds keys of every table; `removedFiles` says which (from the ledger, or
          // from the key layout for a log written before it). A removal of this table's file that
          // is not live here, or of a live file as another table's, means the log and the
          // publication disagree.
          if (work.has(r.key) && (r.table === null || r.table === table)) {
            work.delete(r.key)
            dropped.push(r.key)
          } else if (work.has(r.key)) problem = `change ${c.version} removes ${r.key} as a ${r.table} file; it is live in ${table}`
          else if (r.table === table) problem = `change ${c.version} removes ${r.key}, which is not live at version ${c.version - 1}`
        }
        for (const f of c.added) {
          if (f.table !== table) continue
          if (work.has(f.key)) problem = `change ${c.version} adds ${f.key}, which is already live`
          work.set(f.key, published.has(f.key) ? null : f)
        }
        if (problem) break
        last = c.version
      }
      if (problem) {
        // Refuse rather than guess: nothing of this tenant moves until the log makes sense.
        plan.problems.set(tenant, problem)
        continue
      }
      for (const [, entry] of work) if (entry) plan.adds.push({ tenant, entry })
      for (const k of published) if (!work.has(k)) plan.removes.push({ tenant, key: k })
      for (const k of dropped) if (!published.has(k) && !work.has(k)) plan.transient.push({ tenant, key: k })
      const next: Cursor = { ledgerIncarnation: log.incarnation, version: last }
      if (!cursor || cursorCompare(next, cursor) !== 0) plan.cursors.set(tenant, next)
    }
    return plan
  }

  // ───────────────────────────── commit ─────────────────────────────

  private retention(cfg: PublisherConfig): Retention {
    return { snapshotWindowMs: cfg.snapshotWindowMs, minSnapshots: cfg.minSnapshots, metadataLogMax: cfg.metadataLogMax }
  }

  /**
   * Load the metadata SQLite believes is current and check that nothing newer exists. If
   * either fails, SQLite is behind (or ahead of) R2: rebuild it and make the caller start
   * over with a fresh plan.
   */
  private async currentMetadata(store: Store, cfg: PublisherConfig, table: Table): Promise<{ state: TableState; prev: TableMetadata | null }> {
    const state = this.state(table)
    let prev: TableMetadata | null = null
    if (state.version > 0) {
      const o = await store.get(this.metaKey(table, state.version))
      if (!o) {
        await this.resync(store, cfg, table)
        throw new Conflict(`${table}: v${state.version} is not in R2`)
      }
      prev = await o.json<TableMetadata>()
      checkMetadata(prev, this.metaKey(table, state.version))
    }
    const floor = state.version > 0 ? state.version : await this.hint(store, table)
    if (floor > state.version || (await store.head(this.metaKey(table, state.version + 1)))) {
      await this.resync(store, cfg, table)
      throw new Conflict(`${table}: R2 is ahead of v${state.version}`)
    }
    return { state, prev }
  }

  private async hint(store: Store, table: Table): Promise<number> {
    const o = await store.get(this.hintKey(table))
    if (!o) return 0
    const n = Number((await o.text()).trim())
    return Number.isSafeInteger(n) && n > 0 ? n : 0
  }

  private async commit(store: CountingBucket, cfg: PublisherConfig, table: Table, plan: TablePlan): Promise<TableReport> {
    const t0 = this.now()
    if (plan.adds.length === 0 && plan.removes.length === 0) {
      // Nothing changes in the table. The cursors still move: the changes read did not
      // touch this table (or cancelled out), so the snapshot reflects them as it is.
      const version = this.state(table).version
      if (plan.cursors.size === 0 && plan.transient.length === 0) return emptyReport(version)
      // The plan was made against SQLite. Moving a cursor on a stale view of the table
      // would be wrong, so check that no newer metadata exists (one HEAD, no write).
      if (await store.head(this.metaKey(table, version + 1))) {
        await this.resync(store, cfg, table)
        throw new Conflict(`${table}: R2 is ahead of v${version}`)
      }
      const now = this.now()
      this.ctx.storage.transactionSync(() => {
        for (const [tenant, c] of plan.cursors) this.setCursor(table, tenant, c)
        for (const t of plan.transient) this.recordRemoved(table, t.tenant, t.key, 0, now)
      })
      return emptyReport(version)
    }

    const { state, prev } = await this.currentMetadata(store, cfg, table)
    const now = this.now()
    const base = prev ?? emptyMetadata(table, this.uri(cfg, `${this.cell}/iceberg/${table}`), this.cell, crypto.randomUUID(), now)
    const snapshotId = newSnapshotId()
    const seq = base['last-sequence-number'] + 1
    const tag = crypto.randomUUID().slice(0, 8)
    const report = emptyReport(state.version + 1)
    report.snapshotId = snapshotId
    report.added = plan.adds.length
    report.removed = plan.removes.length

    // ── manifests ──
    const kept = new Map<string, ManifestInfo>()
    const liveCount = new Map<string, number>()
    for (const r of this.sql.exec(`SELECT path, info FROM manifest WHERE tbl = ?`, table).toArray()) kept.set(r.path as string, JSON.parse(r.info as string) as ManifestInfo)
    for (const r of this.sql.exec(`SELECT manifest, COUNT(*) AS n FROM live WHERE tbl = ? GROUP BY manifest`, table).toArray()) liveCount.set(r.manifest as string, r.n as number)

    // Removed files: rewrite only the manifests that hold them. The rewritten manifest
    // keeps the surviving files as EXISTING and lists the removed ones as DELETED.
    const removing = new Map<string, Set<string>>()
    for (const { tenant, key } of plan.removes) {
      const r = this.sql.exec(`SELECT manifest FROM live WHERE tbl = ? AND tenant = ? AND key = ?`, table, tenant, key).toArray()[0]
      if (!r) throw new Error(`publisher: ${key} is to be removed but is not published`)
      const m = r.manifest as string
      if (!removing.has(m)) removing.set(m, new Set())
      ;(removing.get(m) as Set<string>).add(key)
    }
    const outputs: { path: string; parts: Part[] }[] = []
    const replaced: string[] = []
    let n = 0
    const newPath = () => `${this.metaDir(table)}${snapshotId}-m${n++}-${tag}.avro`
    for (const [path, keys] of removing) {
      const parts = this.sql
        .exec(`SELECT * FROM live WHERE tbl = ? AND manifest = ? ORDER BY tenant, day, key`, table, path)
        .toArray()
        .map((r): Part => ({ file: toLive(r), status: keys.has(r.key as string) ? STATUS_DELETED : STATUS_EXISTING }))
      outputs.push({ path: newPath(), parts })
      replaced.push(path)
      kept.delete(path)
    }
    // A manifest left with no live file by an earlier commit has done its job.
    for (const path of [...kept.keys()]) {
      if (!liveCount.has(path)) {
        kept.delete(path)
        replaced.push(path)
      }
    }
    // Added files: one new manifest (more only above `manifestTargetEntries`).
    const adds = plan.adds
      .map(({ tenant, entry }): LiveFile => ({
        key: entry.key, tenant, day: entry.day, rows: entry.rows, bytes: entry.bytes, snapshotId, seq, fileSeq: seq, stats: statsFor(table, entry),
      }))
      .sort(byPartition)
    for (let i = 0; i < adds.length; i += cfg.manifestTargetEntries) {
      outputs.push({ path: newPath(), parts: adds.slice(i, i + cfg.manifestTargetEntries).map((file): Part => ({ file, status: STATUS_ADDED })) })
    }
    // Merge: when the list would be too long, fold the small untouched manifests together.
    if (kept.size + outputs.length > cfg.maxManifests) {
      const small = [...kept.keys()].filter((p) => (liveCount.get(p) ?? 0) < cfg.manifestTargetEntries / 2)
      if (small.length >= 2) {
        const files: LiveFile[] = []
        for (const p of small) {
          for (const r of this.sql.exec(`SELECT * FROM live WHERE tbl = ? AND manifest = ?`, table, p).toArray()) files.push(toLive(r))
          kept.delete(p)
          replaced.push(p)
        }
        files.sort(byPartition)
        for (let i = 0; i < files.length; i += cfg.manifestTargetEntries) {
          outputs.push({ path: newPath(), parts: files.slice(i, i + cfg.manifestTargetEntries).map((file): Part => ({ file, status: STATUS_EXISTING })) })
        }
        report.manifestsMerged = small.length
      }
    }

    const written: ManifestInfo[] = []
    for (const group of chunk(outputs, 4)) {
      written.push(
        ...(await Promise.all(
          group.map(async (o): Promise<ManifestInfo> => {
            const records = o.parts.map((p) => manifestEntry(table, p.file, p.status, this.uri(cfg, p.file.key), snapshotId))
            const bytes = await writeAvro(MANIFEST_ENTRY_SCHEMA, records, manifestHeader(table), cfg.codec)
            await store.put(o.path, bytes)
            report.bytes.manifests += bytes.length
            return { ...summarise(o.parts, seq, snapshotId), path: o.path, length: bytes.length }
          }),
        )),
      )
    }
    report.manifestsWritten = written.length
    await this.step('manifests-written', table)

    // ── manifest list ──
    const manifests = [...written, ...kept.values()]
    const listKey = `${this.metaDir(table)}snap-${snapshotId}-${tag}.avro`
    const listBytes = await writeAvro(
      MANIFEST_LIST_SCHEMA,
      manifests.map((m) => manifestListRecord(m, this.uri(cfg, m.path))),
      { 'snapshot-id': String(snapshotId), 'sequence-number': String(seq), 'format-version': '2', ...(state.snapshotId ? { 'parent-snapshot-id': String(state.snapshotId) } : {}) },
      cfg.codec,
    )
    await store.put(listKey, listBytes)
    report.bytes.manifestList = listBytes.length
    await this.step('manifest-list-written', table)

    // ── the ledger cursors this snapshot reflects: one immutable object ──
    const cursors = await this.cursors(table)
    for (const [tenant, c] of plan.cursors) cursors[tenant] = c
    const cursorsKey = `${this.metaDir(table)}cursors-${snapshotId}-${tag}.json`
    const cursorsBody = JSON.stringify({ v: CURSORS_FORMAT_VERSION, table, cell: this.cell, snapshotId, cursors })
    await store.put(cursorsKey, cursorsBody, { httpMetadata: { contentType: 'application/json' } })
    report.bytes.cursors = cursorsBody.length
    await this.step('cursors-written', table)

    // ── metadata.json: the commit ──
    const removedLive = plan.removes.map(({ tenant, key }) => toLive(this.sql.exec(`SELECT * FROM live WHERE tbl = ? AND tenant = ? AND key = ?`, table, tenant, key).one()))
    const before = prev?.snapshots.find((s) => s['snapshot-id'] === prev['current-snapshot-id'])?.summary
    const total = (k: string) => Number(before?.[k] ?? 0)
    const sum = (fs: { rows: number; bytes: number }[], f: 'rows' | 'bytes') => fs.reduce((a, x) => a + x[f], 0)
    const partitions = new Set([...adds, ...removedLive].map((f) => `${f.tenant}/${f.day}`))
    const snapshot: Snapshot = {
      'snapshot-id': snapshotId,
      'sequence-number': seq,
      'timestamp-ms': Math.max(now, (prev?.['last-updated-ms'] ?? 0) + 1),
      'manifest-list': this.uri(cfg, listKey),
      summary: {
        operation: plan.removes.length === 0 ? 'append' : plan.adds.length === 0 ? 'delete' : 'overwrite',
        'added-data-files': String(adds.length),
        'deleted-data-files': String(removedLive.length),
        'added-records': String(sum(adds, 'rows')),
        'deleted-records': String(sum(removedLive, 'rows')),
        'added-files-size': String(sum(adds, 'bytes')),
        'removed-files-size': String(sum(removedLive, 'bytes')),
        'changed-partition-count': String(partitions.size),
        'total-data-files': String(total('total-data-files') + adds.length - removedLive.length),
        'total-records': String(total('total-records') + sum(adds, 'rows') - sum(removedLive, 'rows')),
        'total-files-size': String(total('total-files-size') + sum(adds, 'bytes') - sum(removedLive, 'bytes')),
        'total-delete-files': '0',
        'total-position-deletes': '0',
        'total-equality-deletes': '0',
        [CURSORS_KEY]: this.uri(cfg, cursorsKey),
        'viz.tenants': String(Object.keys(cursors).length),
      },
      'schema-id': 0,
    }
    if (state.snapshotId !== null) snapshot['parent-snapshot-id'] = state.snapshotId
    const meta = nextMetadata(base, prev ? this.uri(cfg, this.metaKey(table, state.version)) : null, snapshot, snapshot['timestamp-ms'], this.retention(cfg))
    report.bytes.metadata = await this.putMetadata(store, cfg, table, state.version + 1, meta)
    await this.step('metadata-written', table)

    await store.put(this.hintKey(table), String(state.version + 1))
    await this.step('hint-written', table)

    // ── SQLite follows R2 ──
    const freeBelow = oldestSeq(meta)
    const keptSnapshots = new Set(meta.snapshots.map((s) => s['snapshot-id']))
    this.ctx.storage.transactionSync(() => {
      const sql = this.sql
      for (const f of removedLive) {
        sql.exec(`DELETE FROM live WHERE tbl = ? AND tenant = ? AND key = ?`, table, f.tenant, f.key)
        this.recordRemoved(table, f.tenant, f.key, seq, null)
      }
      for (const t of plan.transient) this.recordRemoved(table, t.tenant, t.key, 0, now)
      for (const o of outputs) {
        for (const p of o.parts) {
          if (p.status === STATUS_ADDED) {
            this.insertLive(table, p.file, o.path)
            sql.exec(`DELETE FROM removed WHERE tbl = ? AND tenant = ? AND key = ?`, table, p.file.tenant, p.file.key)
          } else if (p.status === STATUS_EXISTING) {
            sql.exec(`UPDATE live SET manifest = ? WHERE tbl = ? AND tenant = ? AND key = ?`, o.path, table, p.file.tenant, p.file.key)
          }
        }
      }
      for (const p of replaced) sql.exec(`DELETE FROM manifest WHERE tbl = ? AND path = ?`, table, p)
      for (const m of written) sql.exec(`INSERT INTO manifest (tbl, path, info) VALUES (?, ?, ?)`, table, m.path, JSON.stringify(m))
      for (const [tenant, c] of plan.cursors) this.setCursor(table, tenant, c)
      sql.exec(
        `INSERT INTO tbl (name, version, snapshot_id, seq, uuid) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (name) DO UPDATE SET version = excluded.version, snapshot_id = excluded.snapshot_id, seq = excluded.seq, uuid = excluded.uuid`,
        table, state.version + 1, snapshotId, seq, meta['table-uuid'],
      )
      sql.exec(`INSERT INTO snap (tbl, snapshot_id, seq, files) VALUES (?, ?, ?, ?)`, table, snapshotId, seq, JSON.stringify([listKey, cursorsKey, ...manifests.map((m) => m.path)]))
      this.dropExpired(table, keptSnapshots, freeBelow, now)
    })
    await this.step('state-saved', table)
    report.commitMs = this.now() - t0
    return report
  }

  /** The compare-and-swap: create `v{version}.metadata.json` only if it does not exist. */
  private async putMetadata(store: CountingBucket, cfg: PublisherConfig, table: Table, version: number, meta: TableMetadata): Promise<number> {
    const body = JSON.stringify(meta)
    const put = await store.put(this.metaKey(table, version), body, { onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'application/json' } })
    if (put === null) {
      // Another writer committed this version. Take its state and start over.
      await this.resync(store, cfg, table)
      throw new Conflict(`${table}: v${version} already exists`)
    }
    return body.length
  }

  private recordRemoved(table: Table, tenant: string, key: string, removedSeq: number, freeAt: number | null): void {
    this.sql.exec(`INSERT INTO removed (tbl, tenant, key, removed_seq, free_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (tbl, key) DO NOTHING`, table, tenant, key, removedSeq, freeAt)
  }

  /** Inside a transaction: forget expired snapshots and free the files only they held. */
  private dropExpired(table: Table, keptSnapshots: Set<number>, freeBelow: number, now: number): void {
    for (const r of this.sql.exec(`SELECT snapshot_id FROM snap WHERE tbl = ?`, table).toArray()) {
      if (!keptSnapshots.has(r.snapshot_id as number)) this.sql.exec(`DELETE FROM snap WHERE tbl = ? AND snapshot_id = ?`, table, r.snapshot_id)
    }
    // A file removed by the snapshot with sequence number s is referenced by retained
    // snapshots older than s only. Once the oldest retained snapshot is s or newer, none is.
    this.sql.exec(`UPDATE removed SET free_at = ? WHERE tbl = ? AND free_at IS NULL AND removed_seq <= ?`, now, table, freeBelow)
  }

  // ───────────────────────────── resync: SQLite from R2 ─────────────────────────────

  /** Highest metadata version in R2, found from the hint and SQLite, then by probing up. */
  private async latestVersion(store: Store, table: Table): Promise<number> {
    let v = Math.max(await this.hint(store, table), 0)
    const known = this.state(table).version
    if (known > v && (await store.head(this.metaKey(table, known)))) v = known
    while (await store.head(this.metaKey(table, v + 1))) v++
    return v
  }

  private async readManifestList(store: Store, cfg: PublisherConfig, uri: string): Promise<ManifestInfo[]> {
    const o = await store.get(this.keyOf(cfg, uri))
    if (!o) throw new Error(`publisher: manifest list ${uri} is not in R2`)
    const { records } = await readAvro<ManifestListRecord>(new Uint8Array(await o.arrayBuffer()))
    return records.map((r) => manifestInfoFromRecord(r, this.keyOf(cfg, r.manifest_path)))
  }

  private async readManifest(store: Store, path: string): Promise<ManifestEntryRecord[]> {
    const o = await store.get(path)
    if (!o) throw new Error(`publisher: manifest ${path} is not in R2`)
    return (await readAvro<ManifestEntryRecord>(new Uint8Array(await o.arrayBuffer()))).records
  }

  /** The live files of a snapshot, read from its manifests: file and the manifest holding it. */
  private async readSnapshotFiles(store: Store, cfg: PublisherConfig, manifests: ManifestInfo[]): Promise<{ file: LiveFile; manifest: string }[]> {
    const out: { file: LiveFile; manifest: string }[] = []
    const all = await inBatches(manifests, FANOUT, (m) => this.readManifest(store, m.path))
    for (const [i, entries] of all.entries()) {
      const m = manifests[i] as ManifestInfo
      for (const e of entries) {
        if (e.status === STATUS_DELETED) continue
        out.push({ file: liveFromEntry(e, this.keyOf(cfg, e.data_file.file_path), { snapshotId: m.addedSnapshotId, seq: m.seq }), manifest: m.path })
      }
    }
    return out
  }

  /**
   * Replace everything SQLite caches about a table with what R2 says. This is the recovery
   * path for a crash after the metadata write, for a lost conditional write, and for lost
   * storage. Files that were live in SQLite and are not in the snapshot were removed by a
   * commit SQLite never recorded; they are kept as removed with the current sequence
   * number, which is at or after the real one (so they are freed no earlier than is safe).
   */
  private async resync(store: Store, cfg: PublisherConfig, table: Table): Promise<void> {
    const version = await this.latestVersion(store, table)
    if (version === 0) {
      this.ctx.storage.transactionSync(() => {
        for (const t of ['live', 'manifest', 'cursor', 'snap']) this.sql.exec(`DELETE FROM ${t} WHERE tbl = ?`, table)
        this.sql.exec(`DELETE FROM tbl WHERE name = ?`, table)
      })
      return
    }
    const o = await store.get(this.metaKey(table, version))
    if (!o) throw new Error(`publisher: ${this.metaKey(table, version)} vanished`)
    const meta = await o.json<TableMetadata>()
    // Never rebuild this code's view from a table a newer publisher evolved: the next commit would overwrite it.
    checkMetadata(meta, this.metaKey(table, version))
    const current = meta.snapshots.find((s) => s['snapshot-id'] === meta['current-snapshot-id'])
    let manifests: ManifestInfo[] = []
    let files: { file: LiveFile; manifest: string }[] = []
    let cursors: Record<string, Cursor> = {}
    if (current) {
      manifests = await this.readManifestList(store, cfg, current['manifest-list'])
      files = await this.readSnapshotFiles(store, cfg, manifests)
      const c = await store.get(this.keyOf(cfg, current.summary[CURSORS_KEY] as string))
      if (!c) throw new Error(`publisher: cursor object of snapshot ${current['snapshot-id']} is not in R2`)
      const body = await c.json<{ v?: number; cursors: Record<string, Cursor> }>()
      if ((body.v ?? 1) > CURSORS_FORMAT_VERSION) throw new MetadataTooNew(`metadata_too_new: cursors object of snapshot ${current['snapshot-id']} is version ${body.v}`)
      cursors = body.cursors
    }
    // What each retained snapshot references, for the sweep. Known snapshots are not re-read.
    const known = new Set(this.sql.exec(`SELECT snapshot_id FROM snap WHERE tbl = ?`, table).toArray().map((r) => r.snapshot_id as number))
    const fresh = await inBatches(meta.snapshots.filter((s) => !known.has(s['snapshot-id'])), FANOUT, async (s) => {
      const list = s === current ? manifests : await this.readManifestList(store, cfg, s['manifest-list'])
      return { snapshot: s, files: [this.keyOf(cfg, s['manifest-list']), this.keyOf(cfg, s.summary[CURSORS_KEY] as string), ...list.map((m) => m.path)] }
    })
    const hint = await this.hint(store, table)
    if (hint < version) await store.put(this.hintKey(table), String(version))

    const now = this.now()
    const seq = meta['last-sequence-number']
    const stillLive = new Set(files.map((f) => f.file.key))
    this.ctx.storage.transactionSync(() => {
      const sql = this.sql
      for (const r of sql.exec(`SELECT tenant, key FROM live WHERE tbl = ?`, table).toArray()) {
        if (!stillLive.has(r.key as string)) this.recordRemoved(table, r.tenant as string, r.key as string, seq, null)
      }
      for (const t of ['live', 'manifest', 'cursor']) sql.exec(`DELETE FROM ${t} WHERE tbl = ?`, table)
      for (const f of files) {
        this.insertLive(table, f.file, f.manifest)
        sql.exec(`DELETE FROM removed WHERE tbl = ? AND tenant = ? AND key = ?`, table, f.file.tenant, f.file.key)
      }
      for (const m of manifests) sql.exec(`INSERT INTO manifest (tbl, path, info) VALUES (?, ?, ?)`, table, m.path, JSON.stringify(m))
      for (const [tenant, c] of Object.entries(cursors)) this.setCursor(table, tenant, c)
      sql.exec(
        `INSERT INTO tbl (name, version, snapshot_id, seq, uuid) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (name) DO UPDATE SET version = excluded.version, snapshot_id = excluded.snapshot_id, seq = excluded.seq, uuid = excluded.uuid`,
        table, version, meta['current-snapshot-id'] ?? null, seq, meta['table-uuid'],
      )
      for (const f of fresh) {
        sql.exec(`INSERT INTO snap (tbl, snapshot_id, seq, files) VALUES (?, ?, ?, ?)`, table, f.snapshot['snapshot-id'], f.snapshot['sequence-number'], JSON.stringify(f.files))
      }
      this.dropExpired(table, new Set(meta.snapshots.map((s) => s['snapshot-id'])), oldestSeq(meta), now)
    })
  }

  // ───────────────────────────── maintenance ─────────────────────────────

  /**
   * Expire snapshots outside the retention window when no publish has done it (a commit
   * expires them as a side effect), then sweep orphans. Meant for a cron.
   */
  async maintain(): Promise<{ expired: Record<Table, number>; swept: Record<Table, { marked: number; deleted: number }>; ops: R2Ops }> {
    this.guard()
    return this.serial(async () => {
      const cfg = this.config()
      const store = new CountingBucket(this.env.BUCKET)
      const expired = {} as Record<Table, number>
      const swept = {} as Record<Table, { marked: number; deleted: number }>
      for (const table of TABLE_NAMES) {
        expired[table] = 0
        for (let tries = 0; tries < 3; tries++) {
          try {
            expired[table] = await this.expire(store, cfg, table)
            break
          } catch (e) {
            if (!(e instanceof Conflict)) throw e
          }
        }
        swept[table] = await this.sweepTable(store, cfg, table)
      }
      return { expired, swept, ops: store.ops }
    })
  }

  /** A metadata-only commit that drops expired snapshots. Returns how many. */
  private async expire(store: CountingBucket, cfg: PublisherConfig, table: Table): Promise<number> {
    const state = this.state(table)
    if (state.version === 0) return 0
    const { prev } = await this.currentMetadata(store, cfg, table)
    if (!prev) return 0
    const now = this.now()
    const meta = nextMetadata(prev, this.uri(cfg, this.metaKey(table, state.version)), null, Math.max(now, prev['last-updated-ms'] + 1), this.retention(cfg))
    const dropped = prev.snapshots.length - meta.snapshots.length
    if (dropped === 0) return 0
    await this.putMetadata(store, cfg, table, state.version + 1, meta)
    await store.put(this.hintKey(table), String(state.version + 1))
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(`UPDATE tbl SET version = ? WHERE name = ?`, state.version + 1, table)
      this.dropExpired(table, new Set(meta.snapshots.map((s) => s['snapshot-id'])), oldestSeq(meta), now)
    })
    return dropped
  }

  /** Sweep unreferenced metadata objects of both tables. */
  async sweep(): Promise<Record<Table, { marked: number; deleted: number }>> {
    this.guard()
    return this.serial(async () => {
      const cfg = this.config()
      const store = new CountingBucket(this.env.BUCKET)
      const out = {} as Record<Table, { marked: number; deleted: number }>
      for (const table of TABLE_NAMES) out[table] = await this.sweepTable(store, cfg, table)
      return out
    })
  }

  /**
   * Delete metadata objects nothing references: leftovers of commits that did not finish,
   * the files of expired snapshots, metadata files that fell out of the metadata log.
   *
   * An object is deleted only on a later sweep, at least `orphanGraceMs` after the sweep
   * that first saw it unreferenced. A commit in flight has written manifests that nothing
   * references yet; a reader may still be planning against a snapshot that has just
   * expired. The grace period covers both. Metadata files with a version above the current
   * one are never touched: they would be another writer's commit.
   */
  private async sweepTable(store: CountingBucket, cfg: PublisherConfig, table: Table): Promise<{ marked: number; deleted: number }> {
    const out = { marked: 0, deleted: 0 }
    let state = this.state(table)
    if (state.version === 0) return out
    // The referenced set must be the current one, so check that SQLite is not behind.
    if (await store.head(this.metaKey(table, state.version + 1))) {
      await this.resync(store, cfg, table)
      state = this.state(table)
    }
    const o = await store.get(this.metaKey(table, state.version))
    if (!o) return out
    const meta = await o.json<TableMetadata>()
    // A newer publisher may reference objects this code does not know about (statistics, delete files): delete nothing.
    checkMetadata(meta, this.metaKey(table, state.version))
    const referenced = new Set<string>([this.metaKey(table, state.version), this.hintKey(table)])
    for (const m of meta['metadata-log']) referenced.add(this.keyOf(cfg, m['metadata-file']))
    const snaps = new Map(this.sql.exec(`SELECT snapshot_id, files FROM snap WHERE tbl = ?`, table).toArray().map((r) => [r.snapshot_id as number, JSON.parse(r.files as string) as string[]]))
    for (const s of meta.snapshots) {
      const files = snaps.get(s['snapshot-id'])
      // Without the full reference list of a retained snapshot, nothing can be proven orphan.
      if (!files) return out
      for (const f of files) referenced.add(f)
    }

    const now = this.now()
    const prefix = this.metaDir(table)
    const seen = new Set<string>()
    let cursor: string | undefined
    do {
      const page = await store.list({ prefix, cursor })
      for (const obj of page.objects) {
        const key = obj.key
        seen.add(key)
        if (referenced.has(key)) continue
        const v = META_FILE.exec(key)
        if (v && Number(v[1]) > state.version) continue
        const row = this.sql.exec(`SELECT since FROM orphan WHERE path = ?`, key).toArray()[0]
        if (!row) {
          this.sql.exec(`INSERT INTO orphan (path, since) VALUES (?, ?)`, key, now)
          out.marked++
        } else if ((row.since as number) + cfg.orphanGraceMs <= now) {
          await store.delete(key)
          this.sql.exec(`DELETE FROM orphan WHERE path = ?`, key)
          out.deleted++
        }
      }
      cursor = page.truncated ? page.cursor : undefined
    } while (cursor)
    // Sightings of objects that are referenced after all, or gone.
    for (const r of this.sql.exec(`SELECT path FROM orphan WHERE path >= ? AND path < ?`, prefix, `${prefix}￿`).toArray()) {
      const path = r.path as string
      if (referenced.has(path) || !seen.has(path)) this.sql.exec(`DELETE FROM orphan WHERE path = ?`, path)
    }
    return out
  }

  // ───────────────────────────── physical deletion hand-off ─────────────────────────────

  /**
   * Data files of a tenant that may be deleted from R2: removed from the ledger, the
   * removal published (or the file never published at all), referenced by no retained
   * snapshot for at least `deleteGraceMs`, and not live in any table now.
   */
  async safeToDelete(tenant: string): Promise<string[]> {
    this.guard()
    const limit = this.now() - this.config().deleteGraceMs
    return this.sql
      .exec(
        `SELECT r.key FROM removed r WHERE r.tenant = ? AND r.free_at IS NOT NULL AND r.free_at <= ?
           AND NOT EXISTS (SELECT 1 FROM live l WHERE l.tenant = ? AND l.key = r.key) ORDER BY r.key`,
        tenant, limit, tenant,
      )
      .toArray()
      .map((r) => r.key as string)
  }

  /** The deleter reports what it deleted, so the publisher can forget those keys. */
  async acknowledgeDeleted(tenant: string, keys: string[]): Promise<void> {
    this.guard()
    for (const k of keys) this.sql.exec(`DELETE FROM removed WHERE tenant = ? AND key = ? AND free_at IS NOT NULL`, tenant, k)
  }

  // ───────────────────────────── verify: the scrubber ─────────────────────────────

  /**
   * Check one table against the ledgers. The data files of the current snapshot, read from
   * its manifests in R2, must equal the union over tenants of each ledger's live set at the
   * published cursor, recomputed by replaying the logs from R2; and every referenced object
   * must exist with the recorded size.
   *
   * `cursors: 'state'` (default) uses the cursors in SQLite, which is what the publisher
   * will continue from. `'snapshot'` uses the cursor object the snapshot points at, which
   * needs nothing but R2.
   */
  async verify(table: Table, options: { cursors?: 'state' | 'snapshot'; checkObjects?: boolean } = {}): Promise<VerifyResult> {
    this.guard()
    // In the queue with publishes: a commit in progress has R2 ahead of SQLite for a moment.
    return this.serial(() => this.verifyNow(table, options))
  }

  private async verifyNow(table: Table, options: { cursors?: 'state' | 'snapshot'; checkObjects?: boolean }): Promise<VerifyResult> {
    const cfg = this.config()
    const store = new CountingBucket(this.env.BUCKET)
    const state = this.state(table)
    const result: VerifyResult = {
      ok: false, table, metadataVersion: 0, stateVersion: state.version, snapshotId: null, files: 0, tenants: 0,
      missingFromIceberg: [], extraInIceberg: [], mismatched: [], duplicates: [], missingObjects: [], sizeMismatch: [], problems: [],
    }
    const finish = (): VerifyResult => {
      result.ok =
        result.missingFromIceberg.length + result.extraInIceberg.length + result.mismatched.length + result.duplicates.length +
          result.missingObjects.length + result.sizeMismatch.length + result.problems.length === 0
      return result
    }

    // ── the Iceberg side, from R2 alone ──
    const version = await this.latestVersion(store, table)
    result.metadataVersion = version
    if (version !== state.version) result.problems.push(`R2 is at v${version}, the publisher's state is at v${state.version}`)
    const iceberg = new Map<string, LiveFile>()
    let snapshotCursors: Record<string, Cursor> = {}
    if (version > 0) {
      const o = await store.get(this.metaKey(table, version))
      if (!o) {
        result.missingObjects.push(this.metaKey(table, version))
        return finish()
      }
      const meta = await o.json<TableMetadata>()
      const tooNew = metadataProblem(meta)
      if (tooNew) {
        result.problems.push(`metadata written by a newer publisher, not verified: ${tooNew}`)
        return finish()
      }
      const current = meta.snapshots.find((s) => s['snapshot-id'] === meta['current-snapshot-id'])
      if (current) {
        result.snapshotId = current['snapshot-id']
        let manifests: ManifestInfo[]
        try {
          manifests = await this.readManifestList(store, cfg, current['manifest-list'])
        } catch {
          result.missingObjects.push(this.keyOf(cfg, current['manifest-list']))
          return finish()
        }
        for (const m of manifests) {
          const head = await store.head(m.path)
          if (!head) {
            result.missingObjects.push(m.path)
            continue
          }
          if (head.size !== m.length) result.sizeMismatch.push({ key: m.path, recorded: m.length, actual: head.size })
          for (const e of await this.readManifest(store, m.path)) {
            if (e.status === STATUS_DELETED) continue
            const f = liveFromEntry(e, this.keyOf(cfg, e.data_file.file_path), { snapshotId: m.addedSnapshotId, seq: m.seq })
            if (iceberg.has(f.key)) result.duplicates.push(f.key)
            iceberg.set(f.key, f)
          }
        }
        const c = await store.get(this.keyOf(cfg, current.summary[CURSORS_KEY] as string))
        if (!c) result.missingObjects.push(this.keyOf(cfg, current.summary[CURSORS_KEY] as string))
        else snapshotCursors = (await c.json<{ cursors: Record<string, Cursor> }>()).cursors
      }
    }
    result.files = iceberg.size

    // ── the ledger side, replayed from the logs ──
    const stateCursors = await this.cursors(table)
    for (const [tenant, c] of Object.entries(snapshotCursors)) {
      const s = stateCursors[tenant]
      if (!s || cursorCompare(s, c) < 0) result.problems.push(`cursor of ${tenant} in the publisher's state is behind the snapshot's (${JSON.stringify(s ?? null)} < ${JSON.stringify(c)})`)
    }
    const cursors = options.cursors === 'snapshot' ? snapshotCursors : stateCursors
    result.tenants = Object.keys(cursors).length
    const expected = new Map<string, { tenant: string; entry: FileEntry }>()
    for (const [tenant, cursor] of Object.entries(cursors)) {
      try {
        for (const [key, entry] of await replayAt(store, this.cell, tenant, cursor)) {
          if (entry.table === table) expected.set(key, { tenant, entry })
        }
      } catch (e) {
        result.problems.push(`ledger log: ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    for (const [key, { tenant, entry }] of expected) {
      const f = iceberg.get(key)
      if (!f) {
        result.missingFromIceberg.push(key)
        continue
      }
      const differ = (field: string, a: string | number, b: string | number) => {
        if (a !== b) result.mismatched.push({ key, field, iceberg: a, ledger: b })
      }
      differ('tenant', f.tenant, tenant)
      differ('day', f.day, entry.day)
      differ('rows', f.rows, entry.rows)
      differ('bytes', f.bytes, entry.bytes)
    }
    for (const key of iceberg.keys()) if (!expected.has(key)) result.extraInIceberg.push(key)

    // ── every data file exists with the recorded size ──
    if (options.checkObjects !== false) {
      await inBatches([...iceberg.values()], FANOUT, async (f) => {
        const head = await store.head(f.key)
        if (!head) result.missingObjects.push(f.key)
        else if (head.size !== f.bytes) result.sizeMismatch.push({ key: f.key, recorded: f.bytes, actual: head.size })
      })
    }
    for (const list of [result.missingFromIceberg, result.extraInIceberg, result.duplicates, result.missingObjects]) list.sort()
    return finish()
  }
}

export type CommitStep = 'manifests-written' | 'manifest-list-written' | 'cursors-written' | 'metadata-written' | 'hint-written' | 'state-saved'

/** Snapshot ids are Iceberg longs; these stay inside JavaScript's safe integers. */
function newSnapshotId(): number {
  const a = crypto.getRandomValues(new Uint32Array(2))
  return ((a[0] as number) & 0xfffff) * 0x100000000 + (a[1] as number) + 1
}

const oldestSeq = (meta: TableMetadata): number => meta.snapshots.reduce((m, s) => Math.min(m, s['sequence-number']), Number.MAX_SAFE_INTEGER)

const byPartition = (a: LiveFile, b: LiveFile): number =>
  a.tenant < b.tenant ? -1 : a.tenant > b.tenant ? 1 : a.day < b.day ? -1 : a.day > b.day ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}
