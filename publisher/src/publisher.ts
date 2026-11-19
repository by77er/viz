import { DurableObject } from 'cloudflare:workers'
import { openSchema, refusalOf, type SchemaState, SchemaTooNewError } from '../../contracts/schema'
import { TENANT_ID, type FileEntry, type LedgerTable, type SignalTable } from '../../contracts/ledger'
import { readAvro, writeAvro, type AvroCodec } from './avro'
import {
  CURSORS_FORMAT_VERSION,
  CURSORS_KEY,
  metadataProblem,
  MANIFEST_LIST_SCHEMA,
  STATUS_ADDED,
  STATUS_DELETED,
  STATUS_EXISTING,
  TABLE_NAMES,
  emptyMetadata,
  expiryDeadline,
  isMetricTable,
  liveFromEntry,
  manifestEntry,
  manifestEntrySchema,
  partitionDay,
  spanHour,
  spanHourProblem,
  manifestHeader,
  manifestInfoFromRecord,
  manifestListRecord,
  nextMetadata,
  statsFor,
  summarise,
  type AnyPartition,
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
import {
  R2_CONNECTIONS,
  Slots,
  cursorCompare,
  holding,
  inBatches,
  isPublished,
  listTenants,
  readTenantLog,
  replayAt,
  type BaseInfo,
  type BaseSink,
  type Cursor,
  type LogStatus,
  type Store,
  type StoreObject,
  type TenantLog,
} from './log'

/**
 * The jobs the publisher's one alarm serves (design/DECISIONS.md D34). Each deadline is a row
 * of `due`, in the publisher's clock; the alarm is set at the earliest and deleted when there
 * is none, so an idle publisher has no alarm and costs nothing.
 *
 *   publish         tenants are pending: set by `notify` (coalescing nudges for
 *                   `publishIntervalMs`), by a publish that left some (retry after `retryMs`; after
 *                   `continueMs` when it stopped at a per-publish cap), and by the alarm itself
 *                   before it publishes (a lease: an invocation cut off keeps its deadline)
 *   sweep           metadata objects may be unreferenced: a commit or a failed attempt happened
 *                   (`orphanGraceMs` later), or the last sweep marked objects (their grace end)
 *   expire:<table>  every snapshot beyond the newest `minSnapshots` will be outside the window
 */
type Job = 'publish' | 'sweep' | `expire:${LedgerTable}`

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
  /**
   * Re-bases one publish may start (review M-6: the upgrade to D67 re-bases every tenant). Each
   * publish starts at least one, and no further one once this many have started, or once the ones
   * it started have staged `maxRebaseFilesPerPublish` files and tombstones. The rest wait, least
   * recently started first (table `rebase`), and the alarm continues after `continueMs`.
   */
  maxRebasesPerPublish: number
  maxRebaseFilesPerPublish: number
  /** Tenants whose logs one publish reads (R2 calls are subrequests); the others wait, longest waiting first. */
  maxTenantsPerPublish: number
  /** Delay before the alarm continues a publish that stopped at one of the caps above, or after rebuilding a table from R2. */
  continueMs: number
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
  // From `bench/upgrade.bench.test.ts` (README, "Capped re-bases"): a publish that re-bases this much
  // took at most a few seconds here, against the 30 s of CPU a Durable Object invocation has by default.
  maxRebasesPerPublish: 100,
  maxRebaseFilesPerPublish: 100_000,
  maxTenantsPerPublish: 1_000,
  continueMs: 1_000,
}

export interface R2Ops {
  list: number
  get: number
  head: number
  put: number
  delete: number
}

/**
 * Counts R2 operations, so a publish can report what it cost, and holds every one to a slot of
 * one `Slots` of `R2_CONNECTIONS`: the readers of all tenants, the checkpoint parts read ahead
 * and the commit's writes never have more than six in flight together. A GET keeps its slot
 * until its body has been read.
 */
class CountingBucket implements Store {
  readonly ops: R2Ops = { list: 0, get: 0, head: 0, put: 0, delete: 0 }
  readonly slots = new Slots(R2_CONNECTIONS)
  constructor(private readonly bucket: Store) {}
  private async held<T>(op: () => Promise<T>): Promise<T> {
    const release = await this.slots.take()
    try {
      return await op()
    } finally {
      release()
    }
  }
  async get(key: string): Promise<StoreObject | null> {
    this.ops.get++
    const release = await this.slots.take()
    try {
      const o = await this.bucket.get(key)
      if (!o) {
        release()
        return null
      }
      return holding(o, release)
    } catch (e) {
      release()
      throw e
    }
  }
  head(key: string) {
    this.ops.head++
    return this.held(() => this.bucket.head(key))
  }
  list(options: R2ListOptions) {
    this.ops.list++
    return this.held(() => this.bucket.list(options))
  }
  put(key: string, value: string | Uint8Array, options?: R2PutOptions) {
    this.ops.put++
    return this.held(() => this.bucket.put(key, value, options))
  }
  delete(keys: string | string[]) {
    this.ops.delete += Array.isArray(keys) ? keys.length : 1
    return this.held(() => this.bucket.delete(keys))
  }
}

/**
 * `deferred` (from the reader, or set here): the tenant needs a re-base this publish did not start
 * (its per-publish cap), or was not read at all (the cap on tenants, or the publisher rebuilt a
 * table from R2 first). Tables with a cursor were published from it when the log was read. It stays
 * pending, and the alarm continues after `continueMs`.
 */
export type TenantStatus = LogStatus | 'invalid' | 'inconsistent'

export interface TenantReport {
  tenant: string
  status: TenantStatus
  detail?: string
  /** Version named by a `gap`. */
  gapAt?: number
  /** A re-base: the state it started from (a checkpoint or the base) and what reading it took. */
  rebase?: BaseInfo
  /** The cursor each table is at after this publish. */
  cursors: Partial<Record<LedgerTable, Cursor>>
}

/**
 * What the D64 release recorded of a table it read and did not publish, for one tenant (storage
 * table `unpublished`, migration 4). Since D67 every table is published: this release neither reads
 * nor writes that table, and `unpublished()` returns nothing. The type stays for that method.
 */
export interface UnpublishedRecord {
  table: SignalTable
  tenant: string
  /** The ledger version through which this table's changes have been counted. */
  cursor: Cursor
  /** Live files of the table at `cursor`, as counted. */
  files: number
  /**
   * Where the count started. `base`: the base or checkpoint of the tenant's last re-base, so the
   * count is the ledger's. `log`: the first change this publisher read that named the table (a
   * release before this one never passes such a change, so nothing before it is missed, unless this
   * publisher lost its storage since: README, Risks).
   */
  origin: 'base' | 'log'
  /** The publisher's clock when the table was first and last named in what it read for the tenant. */
  firstSeen: number
  lastSeen: number
}

/** Where a table is (`status`). */
export interface TableStatus {
  /** True for every table the ledger lists since D67 (the D64 release answered false for the span and log tables). */
  published: boolean
  version: number
  snapshotId: number | null
  seq: number
  files: number
  manifests: number
  metadataKey: string | null
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
  tables: Record<LedgerTable, TableReport>
  /** Conditional-write losses that were retried. */
  conflicts: number
  ops: R2Ops
  ms: number
}

export interface VerifyResult {
  ok: boolean
  table: LedgerTable
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
  /** Files to add and keys to remove, of tenants read from a cursor: as many as the changes read. */
  adds: { tenant: string; entry: FileEntry }[]
  removes: { tenant: string; key: string }[]
  /** Removed from the ledger before they were ever published. */
  transient: { tenant: string; key: string }[]
  /**
   * Re-based tenants. Their state at the cursor is in `stage` (the checkpoint or base, then the
   * changes read after it), and what they add and remove is `stage` against `live`, in SQL: a
   * re-base never holds a tenant's files in memory, however many it has.
   */
  staged: string[]
  cursors: Map<string, Cursor>
  problems: Map<string, string>
}

/** A conditional write lost, or SQLite was found behind R2. The caller starts over. */
class Conflict extends Error {}

/**
 * The re-bases of one publish (review M-6). Kept across its attempts: an attempt started over after
 * a conflict re-reads the tenants already admitted and admits no new one (`closed`).
 */
interface RebaseBudget {
  admitted: Set<string>
  /** Files and tombstones the admitted re-bases staged (their checkpoint or base). */
  staged: number
  closed: boolean
}

/** An attempt's result, with what the publish needs to settle `pending` and the alarm. */
interface AttemptResult {
  tenants: TenantReport[]
  tables: Record<LedgerTable, TableReport>
  /** Tenants left for a later publish by a cap (or a rebuild from R2): the alarm continues soon. */
  deferred: boolean
  /** Tenants whose log was not read at all: they keep their place in `pending`. */
  unread: Set<string>
}

/** What the stage refuses of a base or checkpoint (a file listed twice): the log object is corrupt. */
export class BaseRefused extends Error {
  constructor(why: string) {
    super(`ledger log: ${why}`)
  }
}

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
type Totals = { files: number; rows: number; bytes: number }

interface TableState {
  version: number
  snapshotId: number | null
  seq: number
  uuid: string
}

const META_FILE = /\/v(\d+)\.metadata\.json$/
/**
 * Where the alarm's bookkeeping of a table lives: the metric tables' in `due` and `orphan`, the span
 * and log tables' in `signal_due` and `signal_orphan` (storage migration 5), where the D64 release,
 * a rollback target, never looks (it acts on metric tables only, and a row there it cannot act on
 * would wake its alarm at once, for ever).
 */
const dueTable = (job: Job): 'due' | 'signal_due' => (job.startsWith('expire:') && !isMetricTable(job.slice('expire:'.length) as LedgerTable) ? 'signal_due' : 'due')
const orphanTable = (table: LedgerTable): 'orphan' | 'signal_orphan' => (isMetricTable(table) ? 'orphan' : 'signal_orphan')
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
  protected async step(_name: CommitStep, _table: LedgerTable): Promise<void> {}

  /** The bucket under the counting, slot-holding store. Tests wrap it to watch or disturb R2 traffic. */
  protected bucket(): Store {
    return this.env.BUCKET
  }

  /**
   * Random bytes for snapshot ids, file tags, table uuids and Avro sync markers, for a commit to
   * `table`. Tests fix them to compare two publications byte for byte (a seeded sequence for the
   * metric tables and one per span or log table, so that the metric tables' ids do not depend on
   * whether a log has span or log changes); here the table does not matter.
   */
  protected random(n: number, _table?: LedgerTable): Uint8Array {
    return crypto.getRandomValues(new Uint8Array(n))
  }

  // ───────────────────────────── storage ─────────────────────────────

  private get sql(): SqlStorage {
    return this.ctx.storage.sql
  }

  private config(): PublisherConfig {
    const stored: Record<string, unknown> = {}
    for (const r of this.sql.exec(`SELECT k, v FROM config`).toArray()) stored[r.k as string] = JSON.parse(r.v as string)
    return { ...DEFAULTS, locationPrefix: this.env.ICEBERG_LOCATION_PREFIX || 's3://viz-lake', ...stored } as PublisherConfig
  }

  private state(table: LedgerTable): TableState {
    const r = this.sql.exec(`SELECT version, snapshot_id, seq, uuid FROM tbl WHERE name = ?`, table).toArray()[0]
    if (!r) return { version: 0, snapshotId: null, seq: 0, uuid: '' }
    return { version: r.version as number, snapshotId: r.snapshot_id as number | null, seq: r.seq as number, uuid: r.uuid as string }
  }

  private cursorOf(table: LedgerTable, tenant: string): Cursor | null {
    const r = this.sql.exec(`SELECT incarnation, version FROM cursor WHERE tbl = ? AND tenant = ?`, table, tenant).toArray()[0]
    return r ? { ledgerIncarnation: r.incarnation as number, version: r.version as number } : null
  }

  private setCursor(table: LedgerTable, tenant: string, c: Cursor): void {
    this.sql.exec(
      `INSERT INTO cursor (tbl, tenant, incarnation, version) VALUES (?, ?, ?, ?)
       ON CONFLICT (tbl, tenant) DO UPDATE SET incarnation = excluded.incarnation, version = excluded.version`,
      table, tenant, c.ledgerIncarnation, c.version,
    )
  }

  private insertLive(table: LedgerTable, f: LiveFile, manifest: string): void {
    this.sql.exec(
      `INSERT INTO live (tbl, key, tenant, day, rows, bytes, snapshot_id, seq, file_seq, stats, manifest) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      table, f.key, f.tenant, f.day, f.rows, f.bytes, f.snapshotId, f.seq, f.fileSeq, JSON.stringify(f.stats), manifest,
    )
  }

  // ───────────────────────────── paths ─────────────────────────────

  private metaDir(table: LedgerTable): string {
    return `${this.cell}/iceberg/${table}/metadata/`
  }
  private metaKey(table: LedgerTable, version: number): string {
    return `${this.metaDir(table)}v${version}.metadata.json`
  }
  private hintKey(table: LedgerTable): string {
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

  /**
   * A nudge: these tenants' ledgers changed. The alarm publishes them `publishIntervalMs`
   * after the first nudge, so nudges coalesce into one commit per table. Cheap on purpose (one
   * SQLite write and the alarm): its caller is a maintenance run, and the publisher must never
   * slow anything upstream of it (D15).
   */
  async notify(tenants: string[]): Promise<void> {
    this.guard()
    const now = this.now()
    let any = false
    for (const t of tenants) {
      // `since` is the latest nudge: a publish clears only nudges older than its own start.
      if (!TENANT_ID.test(t)) continue
      this.sql.exec(`INSERT INTO pending (tenant, since) VALUES (?, ?) ON CONFLICT (tenant) DO UPDATE SET since = excluded.since`, t, now)
      any = true
    }
    if (!any) return
    // The first nudge sets the deadline; later ones never push it back.
    this.dueNoLaterThan('publish', now + this.config().publishIntervalMs)
    await this.rearm()
  }

  /**
   * The one alarm: whatever of publish, expiry and sweep is due, then the alarm again at the
   * earliest deadline left, or none. At-least-once safe: each job is idempotent and reads what
   * is due from storage.
   */
  async alarm(): Promise<void> {
    const refused = refusalOf(this.schemaState)
    if (refused) {
      // Keep the alarm for the release that owns this storage; touch nothing else.
      await this.ctx.storage.setAlarm(Date.now() + refused.retryAfterMs)
      return
    }
    const tenants = this.pendingTenants()
    if (tenants.length > 0) {
      // Served now. A publish that leaves tenants pending (a failure, a hole, a backlog, a cap)
      // sets the retry; a nudge that arrives meanwhile sets its own deadline. Until then the
      // deadline is a lease, `retryMs` on, and the alarm is set at it: an invocation cut off by the
      // platform (the CPU limit, review M-6) runs no code after it, and still comes back.
      this.setDue('publish', this.now() + this.config().retryMs)
      await this.rearm()
      await this.publish(tenants).catch(() => undefined)
    } else this.clearDue('publish')
    const now = this.now()
    const isDue = (job: Job) => {
      const at = this.dueAt(job)
      return at !== null && at <= now
    }
    const expiring = TABLE_NAMES.filter((t) => isDue(`expire:${t}`))
    if (expiring.length > 0) await this.runMaintenance(expiring, false).catch(() => undefined)
    if (isDue('sweep')) await this.runMaintenance([], true).catch(() => undefined)
    await this.rearm()
  }

  // ───────────────────────────── deadlines ─────────────────────────────

  private dueAt(job: Job): number | null {
    const r = this.sql.exec(`SELECT at FROM ${dueTable(job)} WHERE job = ?`, job).toArray()[0]
    return r ? (r.at as number) : null
  }

  private setDue(job: Job, at: number): void {
    this.sql.exec(`INSERT INTO ${dueTable(job)} (job, at) VALUES (?, ?) ON CONFLICT (job) DO UPDATE SET at = excluded.at`, job, at)
  }

  /** Due at `at`, or earlier if it already is. */
  private dueNoLaterThan(job: Job, at: number): void {
    this.sql.exec(`INSERT INTO ${dueTable(job)} (job, at) VALUES (?, ?) ON CONFLICT (job) DO UPDATE SET at = MIN(at, excluded.at)`, job, at)
  }

  private clearDue(job: Job): void {
    this.sql.exec(`DELETE FROM ${dueTable(job)} WHERE job = ?`, job)
  }

  /** One alarm, at the earliest deadline (of the metric tables' `due` and the span and log tables' `signal_due`); none when nothing is due. */
  private async rearm(): Promise<void> {
    const at = this.sql.exec(`SELECT MIN(at) AS at FROM (SELECT at FROM due UNION ALL SELECT at FROM signal_due)`).one().at as number | null
    if (at === null) {
      if ((await this.ctx.storage.getAlarm()) !== null) await this.ctx.storage.deleteAlarm()
      return
    }
    // Deadlines are in the publisher's clock (`now()`); the alarm runs on the platform's.
    await this.ctx.storage.setAlarm(Date.now() + Math.max(0, at - this.now()))
  }

  /**
   * Inside the transaction of a commit (or of a resync that found another writer's): the
   * objects that commit stopped referencing are swept after the grace period, and the table
   * expires its old snapshots by itself if no later commit does.
   */
  private noteMetadata(cfg: PublisherConfig, table: LedgerTable, meta: TableMetadata, committed: boolean): void {
    if (committed) this.dueNoLaterThan('sweep', this.now() + cfg.orphanGraceMs)
    const at = expiryDeadline(meta, this.retention(cfg))
    if (at === null) this.clearDue(`expire:${table}`)
    else this.setDue(`expire:${table}`, at)
  }

  /** Snapshot expiry for `tables` and, with `sweep`, the orphan sweep of both tables; then their deadlines. */
  private runMaintenance(tables: LedgerTable[], sweep: boolean): Promise<void> {
    return this.serial(async () => {
      const cfg = this.config()
      const store = new CountingBucket(this.bucket())
      for (const table of tables) {
        try {
          await this.expireWithRetries(store, cfg, table)
        } catch (e) {
          // Metadata a newer publisher wrote, or R2 failing: look again later, not in a loop.
          this.setDue(`expire:${table}`, this.now() + cfg.orphanGraceMs)
          throw e
        }
      }
      if (sweep) {
        try {
          for (const table of TABLE_NAMES) await this.sweepTable(store, cfg, table)
        } catch (e) {
          this.setDue('sweep', this.now() + cfg.orphanGraceMs)
          throw e
        }
        this.afterSweep(cfg)
      }
    })
  }

  /** After a sweep: due again when the oldest object it marked has served its grace, else not. */
  private afterSweep(cfg: PublisherConfig): void {
    const oldest = this.sql.exec(`SELECT MIN(since) AS since FROM (SELECT since FROM orphan UNION ALL SELECT since FROM signal_orphan)`).one().since as number | null
    if (oldest === null) this.clearDue('sweep')
    else this.setDue('sweep', oldest + cfg.orphanGraceMs)
  }

  private async expireWithRetries(store: CountingBucket, cfg: PublisherConfig, table: LedgerTable): Promise<number> {
    for (let tries = 0; ; tries++) {
      try {
        return await this.expire(store, cfg, table)
      } catch (e) {
        if (!(e instanceof Conflict) || tries >= 2) throw e
      }
    }
  }

  /** Tenants with unpublished work that the alarm will retry. */
  async pending(): Promise<string[]> {
    this.guard()
    return this.pendingTenants()
  }

  async cursors(table: LedgerTable): Promise<Record<string, Cursor>> {
    this.guard()
    const out: Record<string, Cursor> = {}
    for (const r of this.sql.exec(`SELECT tenant, incarnation, version FROM cursor WHERE tbl = ? ORDER BY tenant`, table).toArray()) {
      out[r.tenant as string] = { ledgerIncarnation: r.incarnation as number, version: r.version as number }
    }
    return out
  }

  /** Where a table is: metadata version, current snapshot, live files and manifests. Every table the ledger lists is published (D67). */
  async status(table: LedgerTable): Promise<TableStatus> {
    this.guard()
    if (!isPublished(table)) throw new Error(`publisher: unknown table ${JSON.stringify(table)}`)
    const s = this.state(table)
    const files = this.sql.exec(`SELECT COUNT(*) AS n FROM live WHERE tbl = ?`, table).one().n as number
    const manifests = this.sql.exec(`SELECT COUNT(*) AS n FROM manifest WHERE tbl = ?`, table).one().n as number
    return { published: true, version: s.version, snapshotId: s.snapshotId, seq: s.seq, files, manifests, metadataKey: s.version > 0 ? this.metaKey(table, s.version) : null }
  }

  /**
   * What the D64 release recorded of the tables it read and did not publish. Since D67 there are
   * none: this release publishes every table and leaves that release's records alone (they serve
   * only a rollback to it, which counts on from them). Always empty; kept so a caller of the D64
   * interface gets an answer, not an error.
   */
  async unpublished(_tenant?: string): Promise<UnpublishedRecord[]> {
    this.guard()
    return []
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

  /**
   * After a publish: tenants still pending are retried `retryMs` later, or `continueMs` later when
   * the publish stopped at a cap (`soon`), unless a nudge has already set an earlier deadline; with
   * none pending, nothing is due for publication.
   */
  private async afterPublish(cfg: PublisherConfig, soon = false): Promise<void> {
    if (this.pendingTenants().length === 0) this.clearDue('publish')
    else this.dueNoLaterThan('publish', this.now() + (soon ? cfg.continueMs : cfg.retryMs))
    await this.rearm()
  }

  private async publishNow(requested?: string[]): Promise<PublishResult> {
    const t0 = this.now()
    const cfg = this.config()
    const store = new CountingBucket(this.bucket())
    let conflicts = 0
    // The tenants being worked on, so that a failure can leave them pending for the alarm.
    let working: string[] = requested ?? []
    const budget: RebaseBudget = { admitted: new Set(), staged: 0, closed: false }
    for (;;) {
      try {
        const { tenants, tables, deferred, unread } = await this.attempt(store, cfg, requested, (names) => { working = names }, budget)
        const done = new Set(tenants.filter((t) => t.status === 'ok' || t.status === 'no_log').map((t) => t.tenant))
        const now = this.now()
        this.ctx.storage.transactionSync(() => {
          for (const t of tenants) {
            if (done.has(t.tenant)) {
              // A nudge that arrived after this publish began may be about a change it did not read.
              this.sql.exec(`DELETE FROM pending WHERE tenant = ? AND since <= ?`, t.tenant, t0)
              this.sql.exec(`DELETE FROM rebase WHERE tenant = ?`, t.tenant)
            } else if (t.status === 'invalid') continue
            // Not read (a cap): it keeps its place. Read and not done: behind those that were not
            // read, so that tenants stuck on a hole never hold the others back from a publish.
            else if (unread.has(t.tenant)) this.sql.exec(`INSERT INTO pending (tenant, since) VALUES (?, ?) ON CONFLICT (tenant) DO NOTHING`, t.tenant, now)
            else this.sql.exec(`INSERT INTO pending (tenant, since) VALUES (?, ?) ON CONFLICT (tenant) DO UPDATE SET since = MAX(since, excluded.since)`, t.tenant, now)
          }
        })
        await this.afterPublish(cfg, deferred)
        return { tenants, tables, conflicts, ops: store.ops, ms: this.now() - t0 }
      } catch (e) {
        // A retry re-reads the re-bases this publish admitted, and admits no other.
        budget.closed = true
        // An attempt that stopped may have left objects nothing references: sweep them later.
        this.dueNoLaterThan('sweep', this.now() + cfg.orphanGraceMs)
        // A table found behind R2 is rebuilt at its own commit, one conflict each: after a lost
        // storage that is one per table with metadata (five since D67, two before), plus one.
        if (!(e instanceof Conflict) || ++conflicts > TABLE_NAMES.length + 1) {
          // Whatever was asked for is still unpublished: make sure the alarm comes back.
          const now = this.now()
          for (const t of working) {
            if (TENANT_ID.test(t)) this.sql.exec(`INSERT INTO pending (tenant, since) VALUES (?, ?) ON CONFLICT (tenant) DO NOTHING`, t, now)
          }
          await this.afterPublish(cfg)
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
    budget: RebaseBudget,
  ): Promise<AttemptResult> {
    // `stage` holds what one attempt's re-bases read, and nothing else may read it: empty it
    // before (an evicted attempt may have left rows) and after. What survives an attempt is what
    // it committed; the per-publish caps bound what one cut off can lose.
    this.sql.exec(`DELETE FROM stage`)
    try {
      return await this.attemptStaged(store, cfg, requested, working, budget)
    } finally {
      this.sql.exec(`DELETE FROM stage`)
    }
  }

  /** The tables the tenant has no cursor in: a re-base is needed before they can be published. */
  private uncursored(tenant: string): LedgerTable[] {
    return TABLE_NAMES.filter((table) => !this.cursorOf(table, tenant))
  }

  /**
   * Whether `tenant` may re-base in this publish. Already admitted: yes. Else at least one per
   * publish, and no other once `maxRebasesPerPublish` have started or the started ones have staged
   * `maxRebaseFilesPerPublish` files and tombstones. Admitting one records when it started, before
   * anything is read, so a re-base cut off with its invocation goes to the back of the queue
   * instead of being tried first again (and holding every other tenant's re-base up for ever).
   */
  private admit(cfg: PublisherConfig, budget: RebaseBudget, tenant: string): boolean {
    if (budget.admitted.has(tenant)) return true
    if (budget.closed) return false
    if (budget.admitted.size > 0 && (budget.admitted.size >= cfg.maxRebasesPerPublish || budget.staged >= cfg.maxRebaseFilesPerPublish)) return false
    budget.admitted.add(tenant)
    this.sql.exec(`INSERT INTO rebase (tenant, started) VALUES (?, ?) ON CONFLICT (tenant) DO UPDATE SET started = excluded.started`, tenant, this.now())
    return true
  }

  private async attemptStaged(
    store: CountingBucket,
    cfg: PublisherConfig,
    requested: string[] | undefined,
    working: (names: string[]) => void,
    budget: RebaseBudget,
  ): Promise<AttemptResult> {
    const names = [...new Set(requested ?? [...(await listTenants(store, this.cell)), ...this.pendingTenants()])].sort()
    working(names)
    const reports = new Map<string, TenantReport>()
    const valid: string[] = []
    for (const t of names) {
      if (TENANT_ID.test(t)) valid.push(t)
      else reports.set(t, { tenant: t, status: 'invalid', detail: 'tenant id must match [A-Za-z0-9_-]{1,64}', cursors: {} })
    }
    const unread = new Set<string>()
    const notRead = (tenant: string, detail: string) => {
      unread.add(tenant)
      reports.set(tenant, { tenant, status: 'deferred', detail, cursors: {} })
    }
    const unchanged = () => Object.fromEntries(TABLE_NAMES.map((table) => [table, emptyReport(this.state(table).version)])) as Record<LedgerTable, TableReport>

    // Paging over tenants: at most `maxTenantsPerPublish` logs read, longest waiting first (a tenant
    // not pending was asked for now). The others keep their place for the next publish.
    const since = new Map(this.sql.exec(`SELECT tenant, since FROM pending`).toArray().map((r) => [r.tenant as string, r.since as number]))
    const now = this.now()
    const order = [...valid].sort((a, b) => (since.get(a) ?? now) - (since.get(b) ?? now) || (a < b ? -1 : a > b ? 1 : 0))
    const read = order.slice(0, Math.max(1, cfg.maxTenantsPerPublish))
    for (const t of order.slice(read.length)) notRead(t, `not read: this publish read ${read.length} tenants (maxTenantsPerPublish)`)
    const uncursored = new Map(read.map((t) => [t, this.uncursored(t)]))
    const candidates = read.filter((t) => uncursored.get(t)!.length > 0)

    // A tenant with no cursor in a table where R2 has metadata and SQLite has none: the publisher's
    // storage was lost (or another writer committed first). Its cursors are in R2: rebuild the
    // table from there before re-basing anyone, one table per publish (a rebuild reads every
    // manifest of its table), and leave every tenant for the next publish. Only in a publish's
    // first attempt: a retry after a conflict has rebuilt the table it conflicted on already.
    if (candidates.length > 0 && !budget.closed) {
      for (const table of TABLE_NAMES) {
        if (this.state(table).version > 0 || (await this.hint(store, table)) === 0) continue
        await this.resync(store, cfg, table)
        for (const t of read) notRead(t, `not read: this publish rebuilt the publisher's state of ${table} from R2 first`)
        return { tenants: [...reports.values()], tables: unchanged(), deferred: true, unread }
      }
    }

    // Re-bases first, one tenant at a time, least recently started first, while the budget lasts;
    // each streams its state into `stage` (D55).
    const started = new Map(this.sql.exec(`SELECT tenant, started FROM rebase`).toArray().map((r) => [r.tenant as string, r.started as number]))
    candidates.sort((a, b) => (started.get(a) ?? -1) - (started.get(b) ?? -1) || (a < b ? -1 : a > b ? 1 : 0))
    const sink = this.stageSink(cfg, budget)
    const logs: TenantLog[] = []
    for (const tenant of candidates) {
      if (!this.admit(cfg, budget, tenant)) break
      logs.push(await readTenantLog(store, this.cell, tenant, null, cfg.maxChangesPerTenant, sink))
    }
    // Then every other tenant read, from the lowest cursor its tables have: the tables with a cursor
    // are published (a tenant waiting for its re-base is not held back on them), the others wait.
    // A tenant with no cursor at all has nothing to read without its re-base. One found to need a
    // re-base only now (a new ledger incarnation) is admitted while the budget lasts.
    const rest = read.filter((t) => !budget.admitted.has(t))
    logs.push(
      ...(await inBatches(rest, FANOUT, async (tenant) => {
        let from: Cursor | null = null
        for (const table of TABLE_NAMES) {
          const c = this.cursorOf(table, tenant)
          if (c && (!from || cursorCompare(c, from) < 0)) from = c
        }
        if (!from) return null
        return readTenantLog(store, this.cell, tenant, from, cfg.maxChangesPerTenant, sink)
      })).filter((log): log is TenantLog => log !== null),
    )
    for (const t of rest) if (uncursored.get(t)!.length === TABLE_NAMES.length) notRead(t, 'needs a re-base; this publish has started as many as it may (the per-publish cap)')
    // In tenant order, as ever: what a commit writes does not depend on the order of the reads.
    logs.sort((a, b) => (a.tenant < b.tenant ? -1 : a.tenant > b.tenant ? 1 : 0))
    for (const log of logs) {
      const r: TenantReport = { tenant: log.tenant, status: log.status, cursors: {} }
      if (log.detail) r.detail = log.detail
      if (log.gapAt !== undefined) r.gapAt = log.gapAt
      if (log.base) r.rebase = log.base
      reports.set(log.tenant, r)
    }

    const tables = {} as Record<LedgerTable, TableReport>
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
    // Read from its cursors, its re-base left for later: published as far as it could be, still pending.
    for (const log of logs) {
      const r = reports.get(log.tenant) as TenantReport
      if (r.status === 'ok' && !budget.admitted.has(log.tenant) && this.uncursored(log.tenant).length > 0) {
        r.status = 'deferred'
        r.detail = `needs a re-base for ${this.uncursored(log.tenant).join(', ')}; this publish has started as many as it may (the per-publish cap)`
      }
    }
    const tenants = [...reports.values()]
    return { tenants, tables, deferred: tenants.some((t) => t.status === 'deferred'), unread }
  }

  /**
   * Where a re-base puts what it reads: `stage`, a batch per transaction. A file's statistics are
   * computed only if it is added (most of a re-base is usually published already), when its
   * manifest is written, and kept in its row for the `live` row the commit inserts from it.
   */
  private stageSink(cfg: PublisherConfig, budget: RebaseBudget): BaseSink {
    const sql = this.sql
    // Re-bases of one publish read their checkpoint or base one at a time (memory: one window of
    // parts), and each is admitted while it holds the turn, so the budget counts what every re-base
    // before it staged.
    const turns = new Slots(1)
    return {
      turn: async (tenant) => {
        const release = await turns.take()
        if (this.admit(cfg, budget, tenant)) return release
        release()
        return null
      },
      reset: (tenant) => void sql.exec(`DELETE FROM stage WHERE tenant = ?`, tenant),
      files: (tenant, files) =>
        this.ctx.storage.transactionSync(() => {
          budget.staged += files.length
          for (const f of files) {
            const n = sql.exec(
              `INSERT OR IGNORE INTO stage (tenant, tbl, tomb, key, day, rows, bytes, min_ts, max_ts, idx) VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
              tenant, f.table, f.key, f.day, f.rows, f.bytes, f.minTs, f.maxTs, typeof f.index === 'string' ? f.index : '',
            ).rowsWritten
            if (n === 0) throw new BaseRefused(`${f.key} is listed twice`)
          }
        }),
      tombstones: (tenant, tombstones) =>
        this.ctx.storage.transactionSync(() => {
          budget.staged += tombstones.length
          for (const t of tombstones) sql.exec(`INSERT OR IGNORE INTO stage (tenant, tbl, tomb, key, day, rows, bytes, min_ts, max_ts, idx) VALUES (?, ?, 1, ?, '', 0, 0, 0, 0, '')`, tenant, t.table, t.key)
        }),
    }
  }

  /**
   * What one table has to change to reflect the logs: the NET difference between what is
   * published for each tenant and that tenant's live set after the changes read. A file
   * added and removed inside the changes read appears in neither list.
   */
  private plan(table: LedgerTable, logs: TenantLog[]): TablePlan {
    const plan: TablePlan = { adds: [], removes: [], transient: [], staged: [], cursors: new Map(), problems: new Map() }
    for (const log of logs) {
      if (log.status === 'no_log' || log.status === 'no_base' || log.status === 'cursor_ahead' || log.status === 'deferred') continue
      const tenant = log.tenant
      const cursor = this.cursorOf(table, tenant)
      if (cursor && cursor.ledgerIncarnation > log.incarnation) {
        plan.problems.set(tenant, `cursor of ${table} is at incarnation ${cursor.ledgerIncarnation}, R2 has ${log.incarnation}`)
        continue
      }
      // Re-base when the table has no cursor in this incarnation, or when the log was read from a
      // state (base or checkpoint) above the table's cursor: the changes between the cursor and that
      // state are not in `log.changes`, so planning from the cursor would skip them (review P-1).
      const rebase = !cursor || cursor.ledgerIncarnation < log.incarnation || (log.base !== null && cursor.version < log.start)
      // A new ledger incarnation: its base (or newest checkpoint) is the whole live set it starts
      // from, in `stage`. Without one, a re-base has nothing to start from.
      if (rebase && !log.base) continue
      const r = rebase ? this.planStaged(table, tenant, log, log.base as BaseInfo) : this.planFromCursor(table, tenant, log, cursor as Cursor)
      if ('problem' in r) {
        // Refuse rather than guess: nothing of this tenant moves until the log makes sense.
        plan.problems.set(tenant, r.problem)
        continue
      }
      if (rebase) plan.staged.push(tenant)
      for (const entry of r.adds) plan.adds.push({ tenant, entry })
      for (const key of r.removes) plan.removes.push({ tenant, key })
      for (const key of r.transient) plan.transient.push({ tenant, key })
      const next: Cursor = { ledgerIncarnation: log.incarnation, version: r.last }
      if (!cursor || cursorCompare(next, cursor) !== 0) plan.cursors.set(tenant, next)
    }
    return plan
  }

  private published(table: LedgerTable, tenant: string, key: string): boolean {
    return this.sql.exec(`SELECT 1 FROM live WHERE tbl = ? AND tenant = ? AND key = ?`, table, tenant, key).toArray().length > 0
  }

  private staged(table: LedgerTable, tenant: string, key: string): boolean {
    return this.sql.exec(`SELECT 1 FROM stage WHERE tenant = ? AND tbl = ? AND tomb = 0 AND key = ?`, tenant, table, key).toArray().length > 0
  }

  /**
   * A tenant read from its cursor: the published files it changes, looked up one by one. Memory
   * is what the changes read touch, never the tenant's published set.
   */
  private planFromCursor(table: LedgerTable, tenant: string, log: TenantLog, cursor: Cursor): { adds: FileEntry[]; removes: string[]; transient: string[]; last: number } | { problem: string } {
    // The changes must start at or below the cursor; a log that starts above it lacks the
    // versions between, and planning from it would skip them silently (review P-1). Refuse.
    if (log.start > cursor.version) {
      return { problem: `the log read for ${table} starts after version ${log.start}, above its cursor at ${cursor.version}: the changes between are not in it` }
    }
    // Keys the changes touched that are live after them: the entry to add, or null if published.
    const work = new Map<string, FileEntry | null>()
    // Published keys the changes removed (and, if in `work` too, added again).
    const gone = new Set<string>()
    const live = (k: string) => work.has(k) || (!gone.has(k) && this.published(table, tenant, k))
    const start = cursor.version
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
        const isLive = live(r.key)
        if (isLive && (r.table === null || r.table === table)) {
          if (work.has(r.key)) work.delete(r.key)
          else gone.add(r.key)
          dropped.push(r.key)
        } else if (isLive) problem = `change ${c.version} removes ${r.key} as a ${r.table} file; it is live in ${table}`
        else if (r.table === table) problem = `change ${c.version} removes ${r.key}, which is not live at version ${c.version - 1}`
      }
      for (const f of c.added) {
        if (f.table !== table) continue
        if (live(f.key)) problem = `change ${c.version} adds ${f.key}, which is already live`
        const hour = table === 'spans' ? spanHourProblem(f) : null
        if (hour) problem = `change ${c.version}: ${hour}`
        work.set(f.key, this.published(table, tenant, f.key) ? null : f)
      }
      if (problem) break
      last = c.version
    }
    if (problem) return { problem }
    const adds: FileEntry[] = []
    for (const [, entry] of work) if (entry) adds.push(entry)
    return {
      adds,
      removes: [...gone].filter((k) => !work.has(k)),
      transient: dropped.filter((k) => !work.has(k) && !this.published(table, tenant, k)),
      last,
    }
  }

  /**
   * A re-based tenant: the changes read after its starting state are applied to `stage`, which
   * then holds its live set at the new cursor. What it adds and removes is left in SQLite for
   * the commit (`stage` against `live`); only the keys the changes removed are listed here.
   */
  private planStaged(table: LedgerTable, tenant: string, log: TenantLog, base: BaseInfo): { adds: FileEntry[]; removes: string[]; transient: string[]; last: number } | { problem: string } {
    const sql = this.sql
    const start = base.version
    const dropped: string[] = []
    let problem: string | null = null
    let last = start
    if (table === 'spans') {
      // Every staged `spans` file must lie in the hour its key names (the partition value is taken
      // from the key): found in SQL, judged by `spanHourProblem`.
      for (const f of sql.exec(
        `SELECT key, day, min_ts, max_ts FROM stage WHERE tenant = ? AND tbl = 'spans' AND tomb = 0 AND NOT (
           instr(key, '/day=' || day || '/hour=') > 0 AND min_ts / 3600000 = max_ts / 3600000
           AND min_ts / 3600000 = CAST(strftime('%s', day) AS INTEGER) / 3600 + CAST(substr(key, instr(key, '/hour=') + 6, 2) AS INTEGER))
         LIMIT 10`,
        tenant,
      )) {
        const why = spanHourProblem({ key: f.key as string, day: f.day as string, minTs: f.min_ts as number, maxTs: f.max_ts as number })
        if (why) return { problem: `version ${start}: ${why}` }
      }
    }
    this.ctx.storage.transactionSync(() => {
      for (const c of log.changes) {
        if (c.version <= start) continue
        for (const r of c.removedFiles) {
          const isLive = this.staged(table, tenant, r.key)
          if (isLive && (r.table === null || r.table === table)) {
            sql.exec(`DELETE FROM stage WHERE tenant = ? AND tbl = ? AND tomb = 0 AND key = ?`, tenant, table, r.key)
            dropped.push(r.key)
          } else if (isLive) problem = `change ${c.version} removes ${r.key} as a ${r.table} file; it is live in ${table}`
          else if (r.table === table) problem = `change ${c.version} removes ${r.key}, which is not live at version ${c.version - 1}`
        }
        for (const f of c.added) {
          if (f.table !== table) continue
          const hour = table === 'spans' ? spanHourProblem(f) : null
          if (hour) problem = `change ${c.version}: ${hour}`
          else if (this.staged(table, tenant, f.key)) problem = `change ${c.version} adds ${f.key}, which is already live`
          else {
            sql.exec(
              `INSERT INTO stage (tenant, tbl, tomb, key, day, rows, bytes, min_ts, max_ts, idx) VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
              // As stageSink: a file without an index fragment is stored with none, never a constraint
              // error that would fail the whole publish (review of #5).
              tenant, table, f.key, f.day, f.rows, f.bytes, f.minTs, f.maxTs, typeof f.index === 'string' ? f.index : '',
            )
          }
        }
        if (problem) break
        last = c.version
      }
    })
    if (problem) return { problem }
    return { adds: [], removes: [], transient: dropped.filter((k) => !this.staged(table, tenant, k) && !this.published(table, tenant, k)), last }
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
  private async currentMetadata(store: Store, cfg: PublisherConfig, table: LedgerTable): Promise<{ state: TableState; prev: TableMetadata | null }> {
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

  private async hint(store: Store, table: LedgerTable): Promise<number> {
    const o = await store.get(this.hintKey(table))
    if (!o) return 0
    const n = Number((await o.text()).trim())
    return Number.isSafeInteger(n) && n > 0 ? n : 0
  }

  // What a re-based tenant adds (staged, not live) and removes (live, not staged), in SQL.
  private static readonly STAGED_ADD = `s.tenant = ? AND s.tbl = ? AND s.tomb = 0 AND NOT EXISTS (SELECT 1 FROM live l WHERE l.tbl = s.tbl AND l.key = s.key)`
  private static readonly STAGED_REMOVE = `l.tbl = ? AND l.tenant = ? AND NOT EXISTS (SELECT 1 FROM stage s WHERE s.tenant = l.tenant AND s.tbl = l.tbl AND s.tomb = 0 AND s.key = l.key)`

  /**
   * Files, rows and bytes a re-based tenant adds to and removes from a table, and the partitions
   * they touch besides the tenant's: days, or for `spans` `{day}/hour={HH}` (the hour level of the key).
   */
  private stagedChange(table: LedgerTable, tenant: string): { adds: Totals; removes: Totals; days: string[] } {
    const totals = (r: Row): Totals => ({ files: r.n as number, rows: r.r as number, bytes: r.b as number })
    const adds = totals(this.sql.exec(`SELECT COUNT(*) AS n, COALESCE(SUM(rows), 0) AS r, COALESCE(SUM(bytes), 0) AS b FROM stage s WHERE ${Publisher.STAGED_ADD}`, tenant, table).one())
    const removes = totals(this.sql.exec(`SELECT COUNT(*) AS n, COALESCE(SUM(rows), 0) AS r, COALESCE(SUM(bytes), 0) AS b FROM live l WHERE ${Publisher.STAGED_REMOVE}`, table, tenant).one())
    const days = new Set<string>()
    const part = table === 'spans' ? `day || substr(key, instr(key, '/hour='), 8)` : 'day'
    for (const r of this.sql.exec(`SELECT DISTINCT ${part} AS p FROM stage s WHERE ${Publisher.STAGED_ADD}`, tenant, table)) days.add(r.p as string)
    for (const r of this.sql.exec(`SELECT DISTINCT ${part} AS p FROM live l WHERE ${Publisher.STAGED_REMOVE}`, table, tenant)) days.add(r.p as string)
    return { adds, removes, days: [...days] }
  }

  /**
   * Tombstones of a re-based tenant (removed files whose objects may remain, from its checkpoint
   * or base) that are neither published nor live in its new state: the publisher may never have
   * seen them (a checkpoint skips the changes before it), so they are recorded as removed by the
   * snapshot `seq`, and released only once no snapshot older than it is retained.
   */
  private recordStagedTombstones(table: LedgerTable, tenant: string, seq: number): void {
    this.sql.exec(
      `INSERT INTO removed (tbl, tenant, key, removed_seq, free_at)
       SELECT s.tbl, s.tenant, s.key, ?, NULL FROM stage s
       WHERE s.tenant = ? AND s.tbl = ? AND s.tomb = 1
         AND NOT EXISTS (SELECT 1 FROM live l WHERE l.tbl = s.tbl AND l.key = s.key)
         AND NOT EXISTS (SELECT 1 FROM stage f WHERE f.tenant = s.tenant AND f.tbl = s.tbl AND f.tomb = 0 AND f.key = s.key)
       ON CONFLICT (tbl, key) DO NOTHING`,
      seq, tenant, table,
    )
  }

  /**
   * One commit. Memory is a few manifests (`manifestTargetEntries` files each) and what the
   * changes read from cursors touch; the files of a re-based tenant stay in SQLite and are read
   * a page at a time, so a tenant of any size is published (README, "Memory").
   */
  private async commit(store: CountingBucket, cfg: PublisherConfig, table: LedgerTable, plan: TablePlan): Promise<TableReport> {
    const t0 = this.now()
    const sql = this.sql
    const staged = plan.staged.map((tenant) => ({ tenant, ...this.stagedChange(table, tenant) }))
    const stagedSet = new Set(plan.staged)
    // The published files that read-from-cursor changes remove: as many as the changes read.
    const removedRows = plan.removes.map(({ tenant, key }) => {
      const r = sql.exec(`SELECT tenant, key, day, rows, bytes, manifest FROM live WHERE tbl = ? AND tenant = ? AND key = ?`, table, tenant, key).toArray()[0]
      if (!r) throw new Error(`publisher: ${key} is to be removed but is not published`)
      return { tenant, key, day: r.day as string, rows: r.rows as number, bytes: r.bytes as number, manifest: r.manifest as string }
    })
    const addFiles = plan.adds.length + staged.reduce((n, x) => n + x.adds.files, 0)
    const removeFiles = removedRows.length + staged.reduce((n, x) => n + x.removes.files, 0)

    if (addFiles === 0 && removeFiles === 0) {
      // Nothing changes in the table. The cursors still move: the changes read did not
      // touch this table (or cancelled out), so the snapshot reflects them as it is.
      const st = this.state(table)
      if (plan.cursors.size === 0 && plan.transient.length === 0 && staged.length === 0) return emptyReport(st.version)
      // The plan was made against SQLite. Moving a cursor on a stale view of the table
      // would be wrong, so check that no newer metadata exists (one HEAD, no write).
      if (await store.head(this.metaKey(table, st.version + 1))) {
        await this.resync(store, cfg, table)
        throw new Conflict(`${table}: R2 is ahead of v${st.version}`)
      }
      const now = this.now()
      this.ctx.storage.transactionSync(() => {
        for (const [tenant, c] of plan.cursors) this.setCursor(table, tenant, c)
        for (const t of plan.transient) this.recordRemoved(table, t.tenant, t.key, 0, now)
        for (const x of staged) this.recordStagedTombstones(table, x.tenant, st.seq)
      })
      return emptyReport(st.version)
    }

    const { state, prev } = await this.currentMetadata(store, cfg, table)
    const now = this.now()
    const base = prev ?? emptyMetadata(table, this.uri(cfg, `${this.cell}/iceberg/${table}`), this.cell, uuidOf(this.random(16, table)), now)
    const snapshotId = snapshotIdOf(this.random(8, table))
    const seq = base['last-sequence-number'] + 1
    const tag = hex(this.random(4, table))
    const report = emptyReport(state.version + 1)
    report.snapshotId = snapshotId
    report.added = addFiles
    report.removed = removeFiles

    // ── manifests ──
    const kept = new Map<string, ManifestInfo>()
    const liveCount = new Map<string, number>()
    for (const r of sql.exec(`SELECT path, info FROM manifest WHERE tbl = ?`, table).toArray()) kept.set(r.path as string, JSON.parse(r.info as string) as ManifestInfo)
    for (const r of sql.exec(`SELECT manifest, COUNT(*) AS n FROM live WHERE tbl = ? GROUP BY manifest`, table).toArray()) liveCount.set(r.manifest as string, r.n as number)

    // Removed files: rewrite only the manifests that hold them. The rewritten manifest keeps
    // the surviving files as EXISTING and lists the removed ones as DELETED.
    const removing = new Map<string, Set<string>>()
    const mark = (m: string) => removing.get(m) ?? removing.set(m, new Set()).get(m)!
    for (const r of removedRows) mark(r.manifest).add(r.key)
    for (const x of staged) {
      if (x.removes.files === 0) continue
      for (const r of sql.exec(`SELECT DISTINCT manifest FROM live l WHERE ${Publisher.STAGED_REMOVE}`, table, x.tenant)) mark(r.manifest as string)
    }
    const rewrites = [...removing.keys()].sort()
    const replaced: string[] = []
    for (const path of rewrites) kept.delete(path)
    // A manifest left with no live file by an earlier commit has done its job.
    for (const path of [...kept.keys()]) {
      if (!liveCount.has(path)) {
        kept.delete(path)
        replaced.push(path)
      }
    }
    const addManifests = Math.ceil(addFiles / cfg.manifestTargetEntries)
    // Merge: when the list would be too long, fold the small untouched manifests together.
    let small: string[] = []
    if (kept.size + rewrites.length + addManifests > cfg.maxManifests) {
      small = [...kept.keys()].filter((p) => (liveCount.get(p) ?? 0) < cfg.manifestTargetEntries / 2).sort()
      if (small.length < 2) small = []
      for (const p of small) kept.delete(p)
      report.manifestsMerged = small.length
    }
    replaced.push(...rewrites, ...small)

    // What the transaction after the commit point applies to `live`, recorded as each manifest is written.
    const memAdded: { file: LiveFile; path: string }[] = []
    const stagedRanges: { tenant: string; lo: [string, string]; hi: [string, string]; path: string }[] = []
    const moved: { from: string; path: string }[] = []
    const mergedRanges: { lo: [string, string, string]; hi: [string, string, string]; path: string }[] = []

    let n = 0
    const newPath = () => `${this.metaDir(table)}${snapshotId}-m${n++}-${tag}.avro`
    const toAdd = (tenant: string, entry: FileEntry): LiveFile => ({ key: entry.key, tenant, day: entry.day, rows: entry.rows, bytes: entry.bytes, snapshotId, seq, fileSeq: seq, stats: statsFor(table, entry) })
    const memAdds = plan.adds.map(({ tenant, entry }) => toAdd(tenant, entry)).sort(byPartition)

    /** Every manifest this commit writes, in order, each built only when it is written. */
    function* outputs(this: Publisher): Generator<{ path: string; parts: Part[] }> {
      // Rewritten manifests, a manifest at a time.
      for (const from of rewrites) {
        const keys = removing.get(from)!
        const parts = sql
          .exec(`SELECT * FROM live WHERE tbl = ? AND manifest = ? ORDER BY tenant, day, key`, table, from)
          .toArray()
          .map((r): Part => {
            const gone = keys.has(r.key as string) || (stagedSet.has(r.tenant as string) && !this.staged(table, r.tenant as string, r.key as string))
            return { file: toLive(r), status: gone ? STATUS_DELETED : STATUS_EXISTING }
          })
        const path = newPath()
        moved.push({ from, path })
        yield { path, parts }
      }
      // Added files, in (tenant, day, key) order: the tenants read from cursors from memory, the
      // re-based ones from `stage`, a page at a time; `manifestTargetEntries` per manifest.
      let parts: Part[] = []
      let ranges: { tenant: string; lo: [string, string]; hi: [string, string] }[] = []
      let mem: LiveFile[] = []
      const flush = () => {
        const path = newPath()
        for (const f of mem) memAdded.push({ file: f, path })
        for (const r of ranges) stagedRanges.push({ ...r, path })
        const out = { path, parts }
        parts = []
        ranges = []
        mem = []
        return out
      }
      const tenants = [...new Set([...memAdds.map((f) => f.tenant), ...plan.staged])].sort()
      let i = 0
      for (const tenant of tenants) {
        if (!stagedSet.has(tenant)) {
          while (i < memAdds.length && memAdds[i]!.tenant === tenant) {
            const f = memAdds[i++]!
            parts.push({ file: f, status: STATUS_ADDED })
            mem.push(f)
            if (parts.length >= cfg.manifestTargetEntries) yield flush()
          }
          continue
        }
        let after: [string, string] = ['', '']
        for (;;) {
          const page = sql
            .exec(`SELECT key, day, rows, bytes, min_ts, max_ts, idx FROM stage s WHERE ${Publisher.STAGED_ADD} AND (s.day, s.key) > (?, ?) ORDER BY s.day, s.key LIMIT 1000`, tenant, table, after[0], after[1])
            .toArray()
          if (page.length === 0) break
          const stats: [string, string][] = []
          for (const r of page) {
            const day = r.day as string
            const key = r.key as string
            const entry = { table, day, key, rows: r.rows as number, bytes: r.bytes as number, minTs: r.min_ts as number, maxTs: r.max_ts as number, index: r.idx as string, level: 0 }
            const f: LiveFile = { key, tenant, day, rows: entry.rows, bytes: entry.bytes, snapshotId, seq, fileSeq: seq, stats: statsFor(table, entry) }
            stats.push([key, JSON.stringify(f.stats)])
            parts.push({ file: f, status: STATUS_ADDED })
            const open = ranges.at(-1)
            if (open && open.tenant === tenant) open.hi = [day, key]
            else ranges.push({ tenant, lo: [day, key], hi: [day, key] })
            after = [day, key]
            if (parts.length >= cfg.manifestTargetEntries) yield flush()
          }
          // Kept for the `live` row of each: the transaction after the commit point inserts from `stage`.
          this.ctx.storage.transactionSync(() => {
            for (const [key, json] of stats) sql.exec(`UPDATE stage SET stats = ? WHERE tenant = ? AND tbl = ? AND tomb = 0 AND key = ?`, json, tenant, table, key)
          })
        }
      }
      if (parts.length > 0) yield flush()
      // Merged small manifests, in (tenant, day, key) order, a page at a time.
      if (small.length > 0) {
        const inSmall = `manifest IN (${small.map(() => '?').join(', ')})`
        let after: [string, string, string] = ['', '', '']
        let chunk: Part[] = []
        let lo: [string, string, string] | null = null
        let hi: [string, string, string] = ['', '', '']
        const done = () => {
          const path = newPath()
          mergedRanges.push({ lo: lo!, hi, path })
          const out = { path, parts: chunk }
          chunk = []
          lo = null
          return out
        }
        for (;;) {
          const page = sql
            .exec(`SELECT * FROM live WHERE tbl = ? AND ${inSmall} AND (tenant, day, key) > (?, ?, ?) ORDER BY tenant, day, key LIMIT 1000`, table, ...small, ...after)
            .toArray()
          if (page.length === 0) break
          for (const r of page) {
            const f = toLive(r)
            chunk.push({ file: f, status: STATUS_EXISTING })
            hi = [f.tenant, f.day, f.key]
            lo ??= hi
            after = hi
            if (chunk.length >= cfg.manifestTargetEntries) yield done()
          }
        }
        if (chunk.length > 0) yield done()
      }
    }

    // Two manifests at a time: one being built and encoded while the other's PUT is in flight.
    const written: ManifestInfo[] = []
    const writing: Promise<void>[] = []
    for (const o of outputs.call(this)) {
      const at = written.length
      written.push(null as unknown as ManifestInfo)
      // Each entry is built as the encoder reaches it: a manifest holds its files, not their records too.
      const records = (function* (uri: (key: string) => string) {
        for (const p of o.parts) yield manifestEntry(table, p.file, p.status, uri(p.file.key), snapshotId)
      })((key) => this.uri(cfg, key))
      const info = { ...summarise(o.parts, seq, snapshotId, table), path: o.path }
      const sync = this.random(16, table)
      writing.push(
        (async () => {
          const bytes = await writeAvro(manifestEntrySchema(table), records, manifestHeader(table), cfg.codec, sync)
          await store.put(o.path, bytes)
          report.bytes.manifests += bytes.length
          written[at] = { ...info, length: bytes.length }
        })(),
      )
      if (writing.length >= 2) await writing.shift()
    }
    await Promise.all(writing)
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
      this.random(16, table),
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
    const before = prev?.snapshots.find((s) => s['snapshot-id'] === prev['current-snapshot-id'])?.summary
    const total = (k: string) => Number(before?.[k] ?? 0)
    const sum = (fs: { rows: number; bytes: number }[], f: 'rows' | 'bytes') => fs.reduce((a, x) => a + x[f], 0)
    const addedRows = sum(memAdds, 'rows') + staged.reduce((a, x) => a + x.adds.rows, 0)
    const addedBytes = sum(memAdds, 'bytes') + staged.reduce((a, x) => a + x.adds.bytes, 0)
    const removedRowsN = sum(removedRows, 'rows') + staged.reduce((a, x) => a + x.removes.rows, 0)
    const removedBytes = sum(removedRows, 'bytes') + staged.reduce((a, x) => a + x.removes.bytes, 0)
    // Partitions changed: (tenant, day), or for `spans` (tenant, hour).
    const partOf = (f: { tenant: string; day: string; key: string }) => (table === 'spans' ? `${f.tenant}/${f.day}${f.key.slice(f.key.indexOf('/hour='), f.key.indexOf('/hour=') + 8)}` : `${f.tenant}/${f.day}`)
    const partitions = new Set([...memAdds, ...removedRows].map(partOf))
    for (const x of staged) for (const d of x.days) partitions.add(`${x.tenant}/${d}`)
    const snapshot: Snapshot = {
      'snapshot-id': snapshotId,
      'sequence-number': seq,
      'timestamp-ms': Math.max(now, (prev?.['last-updated-ms'] ?? 0) + 1),
      'manifest-list': this.uri(cfg, listKey),
      summary: {
        operation: removeFiles === 0 ? 'append' : addFiles === 0 ? 'delete' : 'overwrite',
        'added-data-files': String(addFiles),
        'deleted-data-files': String(removeFiles),
        'added-records': String(addedRows),
        'deleted-records': String(removedRowsN),
        'added-files-size': String(addedBytes),
        'removed-files-size': String(removedBytes),
        'changed-partition-count': String(partitions.size),
        'total-data-files': String(total('total-data-files') + addFiles - removeFiles),
        'total-records': String(total('total-records') + addedRows - removedRowsN),
        'total-files-size': String(total('total-files-size') + addedBytes - removedBytes),
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
      // Removed files leave `live` first, recorded as removed by this snapshot.
      for (const f of removedRows) {
        sql.exec(`DELETE FROM live WHERE tbl = ? AND tenant = ? AND key = ?`, table, f.tenant, f.key)
        this.recordRemoved(table, f.tenant, f.key, seq, null)
      }
      for (const x of staged) {
        if (x.removes.files === 0) continue
        sql.exec(
          `INSERT INTO removed (tbl, tenant, key, removed_seq, free_at) SELECT l.tbl, l.tenant, l.key, ?, NULL FROM live l WHERE ${Publisher.STAGED_REMOVE} ON CONFLICT (tbl, key) DO NOTHING`,
          seq, table, x.tenant,
        )
        sql.exec(`DELETE FROM live AS l WHERE ${Publisher.STAGED_REMOVE}`, table, x.tenant)
      }
      for (const t of plan.transient) this.recordRemoved(table, t.tenant, t.key, 0, now)
      // Survivors of rewritten and merged manifests move to the new ones.
      for (const m of moved) sql.exec(`UPDATE live SET manifest = ? WHERE tbl = ? AND manifest = ?`, m.path, table, m.from)
      if (small.length > 0) {
        const inSmall = `manifest IN (${small.map(() => '?').join(', ')})`
        for (const m of mergedRanges) {
          sql.exec(`UPDATE live SET manifest = ? WHERE tbl = ? AND ${inSmall} AND (tenant, day, key) >= (?, ?, ?) AND (tenant, day, key) <= (?, ?, ?)`, m.path, table, ...small, ...m.lo, ...m.hi)
        }
      }
      // Added files: a re-based tenant's from `stage`, range by range; the others' from memory.
      for (const r of stagedRanges) {
        const range = `s.tenant = ? AND s.tbl = ? AND s.tomb = 0 AND (s.day, s.key) >= (?, ?) AND (s.day, s.key) <= (?, ?) AND NOT EXISTS (SELECT 1 FROM live l WHERE l.tbl = s.tbl AND l.key = s.key)`
        sql.exec(`DELETE FROM removed WHERE tbl = ? AND tenant = ? AND key IN (SELECT s.key FROM stage s WHERE ${range})`, table, r.tenant, r.tenant, table, ...r.lo, ...r.hi)
        sql.exec(
          `INSERT INTO live (tbl, key, tenant, day, rows, bytes, snapshot_id, seq, file_seq, stats, manifest)
           SELECT s.tbl, s.key, s.tenant, s.day, s.rows, s.bytes, ?, ?, ?, s.stats, ? FROM stage s WHERE ${range}`,
          snapshotId, seq, seq, r.path, r.tenant, table, ...r.lo, ...r.hi,
        )
      }
      for (const { file, path } of memAdded) {
        this.insertLive(table, file, path)
        sql.exec(`DELETE FROM removed WHERE tbl = ? AND tenant = ? AND key = ?`, table, file.tenant, file.key)
      }
      for (const x of staged) this.recordStagedTombstones(table, x.tenant, seq)
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
      this.noteMetadata(cfg, table, meta, true)
    })
    await this.step('state-saved', table)
    report.commitMs = this.now() - t0
    return report
  }

  /** The compare-and-swap: create `v{version}.metadata.json` only if it does not exist. */
  private async putMetadata(store: CountingBucket, cfg: PublisherConfig, table: LedgerTable, version: number, meta: TableMetadata): Promise<number> {
    const body = JSON.stringify(meta)
    const put = await store.put(this.metaKey(table, version), body, { onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'application/json' } })
    if (put === null) {
      // Another writer committed this version. Take its state and start over.
      await this.resync(store, cfg, table)
      throw new Conflict(`${table}: v${version} already exists`)
    }
    return body.length
  }

  private recordRemoved(table: LedgerTable, tenant: string, key: string, removedSeq: number, freeAt: number | null): void {
    this.sql.exec(`INSERT INTO removed (tbl, tenant, key, removed_seq, free_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (tbl, key) DO NOTHING`, table, tenant, key, removedSeq, freeAt)
  }

  /** Inside a transaction: forget expired snapshots and free the files only they held. */
  private dropExpired(table: LedgerTable, keptSnapshots: Set<number>, freeBelow: number, now: number): void {
    for (const r of this.sql.exec(`SELECT snapshot_id FROM snap WHERE tbl = ?`, table).toArray()) {
      if (!keptSnapshots.has(r.snapshot_id as number)) this.sql.exec(`DELETE FROM snap WHERE tbl = ? AND snapshot_id = ?`, table, r.snapshot_id)
    }
    // A file removed by the snapshot with sequence number s is referenced by retained
    // snapshots older than s only. Once the oldest retained snapshot is s or newer, none is.
    this.sql.exec(`UPDATE removed SET free_at = ? WHERE tbl = ? AND free_at IS NULL AND removed_seq <= ?`, now, table, freeBelow)
  }

  // ───────────────────────────── resync: SQLite from R2 ─────────────────────────────

  /** Highest metadata version in R2, found from the hint and SQLite, then by probing up. */
  private async latestVersion(store: Store, table: LedgerTable): Promise<number> {
    let v = Math.max(await this.hint(store, table), 0)
    const known = this.state(table).version
    if (known > v && (await store.head(this.metaKey(table, known)))) v = known
    while (await store.head(this.metaKey(table, v + 1))) v++
    return v
  }

  private async readManifestList(store: Store, cfg: PublisherConfig, uri: string, table: LedgerTable): Promise<ManifestInfo[]> {
    const o = await store.get(this.keyOf(cfg, uri))
    if (!o) throw new Error(`publisher: manifest list ${uri} is not in R2`)
    const { records } = await readAvro<ManifestListRecord>(new Uint8Array(await o.arrayBuffer()))
    return records.map((r) => manifestInfoFromRecord(r, this.keyOf(cfg, r.manifest_path), table))
  }

  private async readManifest(store: Store, path: string): Promise<ManifestEntryRecord<AnyPartition>[]> {
    const o = await store.get(path)
    if (!o) throw new Error(`publisher: manifest ${path} is not in R2`)
    return (await readAvro<ManifestEntryRecord<AnyPartition>>(new Uint8Array(await o.arrayBuffer()))).records
  }

  /**
   * Replace everything SQLite caches about a table with what R2 says. This is the recovery
   * path for a crash after the metadata write, for a lost conditional write, and for lost
   * storage. Files that were live in SQLite and are not in the snapshot were removed by a
   * commit SQLite never recorded; they are kept as removed with the current sequence
   * number, which is at or after the real one (so they are freed no earlier than is safe).
   *
   * The snapshot's files go into `live_next` a manifest at a time (never all in memory), and
   * replace `live` in the one transaction that also writes the rest, so an eviction midway
   * leaves SQLite as it was and the next resync starts over.
   */
  private async resync(store: Store, cfg: PublisherConfig, table: LedgerTable): Promise<void> {
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
    let cursors: Record<string, Cursor> = {}
    const sql = this.sql
    sql.exec(`DELETE FROM live_next WHERE tbl = ?`, table)
    try {
      if (current) {
        manifests = await this.readManifestList(store, cfg, current['manifest-list'], table)
        // Two manifests in flight; each one's live entries into `live_next` as they are decoded,
        // 500 per transaction: no manifest's records are ever all in memory.
        await inBatches(manifests, 2, async (m) => {
          const o = await store.get(m.path)
          if (!o) throw new Error(`publisher: manifest ${m.path} is not in R2`)
          let batch: LiveFile[] = []
          const flush = () => {
            const run = batch
            batch = []
            this.ctx.storage.transactionSync(() => {
              for (const f of run) {
                sql.exec(
                  `INSERT INTO live_next (tbl, key, tenant, day, rows, bytes, snapshot_id, seq, file_seq, stats, manifest) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                  table, f.key, f.tenant, f.day, f.rows, f.bytes, f.snapshotId, f.seq, f.fileSeq, JSON.stringify(f.stats), m.path,
                )
              }
            })
          }
          await readAvro<ManifestEntryRecord<AnyPartition>>(new Uint8Array(await o.arrayBuffer()), (e) => {
            if (e.status === STATUS_DELETED) return
            batch.push(liveFromEntry(e, this.keyOf(cfg, e.data_file.file_path), { snapshotId: m.addedSnapshotId, seq: m.seq }))
            if (batch.length >= 500) flush()
          })
          flush()
        })
        const c = await store.get(this.keyOf(cfg, current.summary[CURSORS_KEY] as string))
        if (!c) throw new Error(`publisher: cursor object of snapshot ${current['snapshot-id']} is not in R2`)
        const body = await c.json<{ v?: number; cursors: Record<string, Cursor> }>()
        if ((body.v ?? 1) > CURSORS_FORMAT_VERSION) throw new MetadataTooNew(`metadata_too_new: cursors object of snapshot ${current['snapshot-id']} is version ${body.v}`)
        cursors = body.cursors
      }
      // What each retained snapshot references, for the sweep. Known snapshots are not re-read.
      const known = new Set(sql.exec(`SELECT snapshot_id FROM snap WHERE tbl = ?`, table).toArray().map((r) => r.snapshot_id as number))
      const fresh = await inBatches(meta.snapshots.filter((s) => !known.has(s['snapshot-id'])), FANOUT, async (s) => {
        const list = s === current ? manifests : await this.readManifestList(store, cfg, s['manifest-list'], table)
        return { snapshot: s, files: [this.keyOf(cfg, s['manifest-list']), this.keyOf(cfg, s.summary[CURSORS_KEY] as string), ...list.map((m) => m.path)] }
      })
      const hint = await this.hint(store, table)
      if (hint < version) await store.put(this.hintKey(table), String(version))

      const now = this.now()
      const seq = meta['last-sequence-number']
      this.ctx.storage.transactionSync(() => {
        sql.exec(
          `INSERT INTO removed (tbl, tenant, key, removed_seq, free_at)
           SELECT l.tbl, l.tenant, l.key, ?, NULL FROM live l WHERE l.tbl = ? AND NOT EXISTS (SELECT 1 FROM live_next n WHERE n.tbl = l.tbl AND n.key = l.key)
           ON CONFLICT (tbl, key) DO NOTHING`,
          seq, table,
        )
        for (const t of ['live', 'manifest', 'cursor']) sql.exec(`DELETE FROM ${t} WHERE tbl = ?`, table)
        sql.exec(`DELETE FROM removed AS r WHERE r.tbl = ? AND EXISTS (SELECT 1 FROM live_next n WHERE n.tbl = r.tbl AND n.tenant = r.tenant AND n.key = r.key)`, table)
        sql.exec(`INSERT INTO live SELECT tbl, key, tenant, day, rows, bytes, snapshot_id, seq, file_seq, stats, manifest FROM live_next WHERE tbl = ?`, table)
        sql.exec(`DELETE FROM live_next WHERE tbl = ?`, table)
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
        this.noteMetadata(cfg, table, meta, false)
      })
    } finally {
      sql.exec(`DELETE FROM live_next WHERE tbl = ?`, table)
    }
  }

  // ───────────────────────────── maintenance ─────────────────────────────

  /**
   * Expire snapshots outside the retention window when no publish has done it (a commit
   * expires them as a side effect), then sweep orphans, now. The alarm does the same by itself
   * when each is due (`alarm`); this is the operator's handle on it.
   */
  async maintain(): Promise<{ expired: Record<LedgerTable, number>; swept: Record<LedgerTable, { marked: number; deleted: number }>; ops: R2Ops }> {
    this.guard()
    const out = await this.serial(async () => {
      const cfg = this.config()
      const store = new CountingBucket(this.bucket())
      const expired = {} as Record<LedgerTable, number>
      const swept = {} as Record<LedgerTable, { marked: number; deleted: number }>
      for (const table of TABLE_NAMES) {
        expired[table] = await this.expireWithRetries(store, cfg, table)
        swept[table] = await this.sweepTable(store, cfg, table)
      }
      this.afterSweep(cfg)
      return { expired, swept, ops: store.ops }
    })
    await this.rearm()
    return out
  }

  /** A metadata-only commit that drops expired snapshots. Returns how many. Leaves the table's expiry deadline current. */
  private async expire(store: CountingBucket, cfg: PublisherConfig, table: LedgerTable): Promise<number> {
    const state = this.state(table)
    if (state.version === 0) {
      this.clearDue(`expire:${table}`)
      return 0
    }
    const { prev } = await this.currentMetadata(store, cfg, table)
    if (!prev) return 0
    const now = this.now()
    const meta = nextMetadata(prev, this.uri(cfg, this.metaKey(table, state.version)), null, Math.max(now, prev['last-updated-ms'] + 1), this.retention(cfg))
    const dropped = prev.snapshots.length - meta.snapshots.length
    if (dropped === 0) {
      // Not yet (or already done by a commit): the deadline from what R2 holds now.
      this.noteMetadata(cfg, table, prev, false)
      return 0
    }
    await this.putMetadata(store, cfg, table, state.version + 1, meta)
    await store.put(this.hintKey(table), String(state.version + 1))
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(`UPDATE tbl SET version = ? WHERE name = ?`, state.version + 1, table)
      this.dropExpired(table, new Set(meta.snapshots.map((s) => s['snapshot-id'])), oldestSeq(meta), now)
      this.noteMetadata(cfg, table, meta, true)
    })
    return dropped
  }

  /** Sweep unreferenced metadata objects of both tables, now (the alarm does it when due). */
  async sweep(): Promise<Record<LedgerTable, { marked: number; deleted: number }>> {
    this.guard()
    const out = await this.serial(async () => {
      const cfg = this.config()
      const store = new CountingBucket(this.bucket())
      const out = {} as Record<LedgerTable, { marked: number; deleted: number }>
      for (const table of TABLE_NAMES) out[table] = await this.sweepTable(store, cfg, table)
      this.afterSweep(cfg)
      return out
    })
    await this.rearm()
    return out
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
  private async sweepTable(store: CountingBucket, cfg: PublisherConfig, table: LedgerTable): Promise<{ marked: number; deleted: number }> {
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
    const orphan = orphanTable(table)
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
        const row = this.sql.exec(`SELECT since FROM ${orphan} WHERE path = ?`, key).toArray()[0]
        if (!row) {
          this.sql.exec(`INSERT INTO ${orphan} (path, since) VALUES (?, ?)`, key, now)
          out.marked++
        } else if ((row.since as number) + cfg.orphanGraceMs <= now) {
          await store.delete(key)
          this.sql.exec(`DELETE FROM ${orphan} WHERE path = ?`, key)
          out.deleted++
        }
      }
      cursor = page.truncated ? page.cursor : undefined
    } while (cursor)
    // Sightings of objects that are referenced after all, or gone.
    for (const r of this.sql.exec(`SELECT path FROM ${orphan} WHERE path >= ? AND path < ?`, prefix, `${prefix}￿`).toArray()) {
      const path = r.path as string
      if (referenced.has(path) || !seen.has(path)) this.sql.exec(`DELETE FROM ${orphan} WHERE path = ?`, path)
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
  async verify(table: LedgerTable, options: { cursors?: 'state' | 'snapshot'; checkObjects?: boolean } = {}): Promise<VerifyResult> {
    this.guard()
    // In the queue with publishes: a commit in progress has R2 ahead of SQLite for a moment.
    return this.serial(() => this.verifyNow(table, options))
  }

  private async verifyNow(table: LedgerTable, options: { cursors?: 'state' | 'snapshot'; checkObjects?: boolean }): Promise<VerifyResult> {
    const cfg = this.config()
    const store = new CountingBucket(this.bucket())
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
    /** `spans`: each entry's `start_time_hour`. */
    const hours = new Map<string, number | null>()
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
          manifests = await this.readManifestList(store, cfg, current['manifest-list'], table)
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
            if (table === 'spans') hours.set(f.key, partitionDay(e.data_file.partition).hour)
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
      // `spans`: the partition must be hour(start_time) of its rows, which the key's hour level and the ledger's time range say.
      if (table === 'spans') {
        const want = spanHourProblem(entry) === null ? spanHour(entry.key, entry.day) : -1
        differ('hour', hours.get(key) ?? -1, want)
      }
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

/** Snapshot ids are Iceberg longs; these stay inside JavaScript's safe integers. From 8 random bytes. */
function snapshotIdOf(b: Uint8Array): number {
  const v = new DataView(b.buffer, b.byteOffset, 8)
  return (v.getUint32(0) & 0xfffff) * 0x100000000 + v.getUint32(4) + 1
}

const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('')

/** A version-4 UUID from 16 random bytes. */
function uuidOf(b: Uint8Array): string {
  const u = b.slice()
  u[6] = (u[6]! & 0x0f) | 0x40
  u[8] = (u[8]! & 0x3f) | 0x80
  const h = hex(u)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

const oldestSeq = (meta: TableMetadata): number => meta.snapshots.reduce((m, s) => Math.min(m, s['sequence-number']), Number.MAX_SAFE_INTEGER)

const byPartition = (a: LiveFile, b: LiveFile): number =>
  a.tenant < b.tenant ? -1 : a.tenant > b.tenant ? 1 : a.day < b.day ? -1 : a.day > b.day ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}
