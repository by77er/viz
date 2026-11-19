import { DurableObject } from 'cloudflare:workers'
import { SHARD_NAME, TENANT_ID } from '../../contracts/ledger'
import type { Ledger } from '../../ledger/src/ledger'
import { type SchemaSpec, type SchemaTooNew, SchemaTooNewError, columnsOf, openSchema, refusalOf } from '../../contracts/schema'
import { SeriesWindow, UnreadableSketch } from './sketch'
import {
  TAIL_PAGE_MAX_BYTES, TAIL_READ_VERSION, TAIL_SCAN_MAX_BYTES, type TailPage, type TailReadOptions, UnreadableBatch, compileFilter, decodeCursor, encodeCursor,
  filterBatch, fnv64,
} from './tail'
export { TAIL_PAGE_MAX_BYTES, TAIL_READ_VERSION, TAIL_SCAN_MAX_BYTES, type TailFilter, type TailPage, type TailReadOptions, splitKeyRange } from './tail'

/**
 * A pooled shard: the write-ahead log for several tenants in one Durable Object.
 *
 * The unit of everything is a **stream**: one tenant's log inside this shard, identified
 * by `(shard, tenant, incarnation)`. Sequence numbers, seals, discard marks, quotas and
 * dedup fingerprints all belong to a stream. Nothing in this file reads or writes rows
 * without naming the tenant, and no state is shared between streams except the shard's
 * total byte budget and its in-flight limit.
 *
 * Lifecycle of a batch:  append → (seal) → [flush Worker writes Parquet] → recorded → discard
 *
 *   append    refused at once when the shard is over its in-flight limit (nothing is read or
 *             written for it), and, in registration mode `logged` (D61), when the stream is
 *             new and the tenant's ledger has not yet answered its registration as LOGGED
 *             (`registering`: the registration runs in the background, nothing waits for it);
 *             otherwise it joins the open GROUP, and is answered after the group's single
 *             SQLite transaction has committed (the runtime holds the answer until that write
 *             is durable)
 *   seal      fixes a contiguous range of batches as a segment; the boundary is durable,
 *             and a `{tenant, shard}` message for the flush queue is written with it
 *   recorded  the tenant's ledger has admitted the segment's files AND logged that to R2: the
 *             caller passes the ledger's `loggedWatermarks()`, never `addUnit`'s committed
 *             watermark, which a ledger that loses its storage can lose (spec F8)
 *   discard   payloads are dropped after a short retention; `discarded_through` is the fence
 */

/**
 * Largest payload `append` accepts: 1 MiB (contracts/BATCH.md, "Size"). A shard stores a
 * batch as one SQLite value, and Cloudflare caps a value at 2 MB. `edge` splits at this
 * same constant; nothing else may restate the number.
 */
export const MAX_BATCH_BYTES = 1_048_576

export interface ShardConfig {
  /** `append` answers `too_large` for a payload above this. Default `MAX_BATCH_BYTES`. */
  maxBatchBytes: number
  /** Seal a stream when its unsealed bytes reach this. */
  sealBytes: number
  /** Seal a stream when its oldest unsealed batch is this old. */
  sealAgeMs: number
  /** One tenant may buffer at most this many bytes in this shard. */
  tenantMaxBytes: number
  /** Above this total, tenants over their fair share are refused. */
  shardMaxBytes: number
  /** Keep recorded payloads this long so in-flight queries can still read them. */
  retainRecordedMs: number
  /** Remember fingerprints this long, independent of discard, for client retries. */
  fingerprintTtlMs: number
  /** A seal notification that could not be sent is tried again after this long. */
  notifyRetryMs: number
  /** Active-series window: a series counts while it was seen within the last half to whole window. */
  seriesWindowMs: number
  /** A window bucket is an exact set of ids up to this many, a sketch above (src/sketch.ts). */
  seriesExactMax: number
  /** Series windows changed in memory are written to storage at most this often. */
  seriesPersistMs: number
  /**
   * Early refusal: appends accepted but not yet committed may be at most this many, and
   * carry at most `maxPendingBytes`. Past either, `append` answers `backpressure` with
   * scope `overload` before it reads or writes anything.
   */
  maxInFlight: number
  maxPendingBytes: number
  /** The `Retry-After` of an overload refusal: this, plus up to as much again of jitter. */
  overloadRetryMs: number
  /**
   * Group commit: the first append of an empty group waits this long (0: until the
   * current event has finished) for others to join it; the group is then committed in one
   * transaction. A group is also committed at once when it reaches `maxGroupBytes`.
   */
  groupWindowMs: number
  maxGroupBytes: number
  /** A filtered tail read examines at most this many stored bytes per call; the rest is its next page (D48). */
  tailScanMaxBytes: number
  /**
   * Registration before writes (D61; spec/README.md "Proposed fixes", R2). `logged`: an append
   * to a stream the tenant's ledger has not yet answered as registered AND logged is refused
   * at once (`backpressure`, scope `registering`) while the registration runs in the
   * background; a stream that already holds acknowledged rows (made by a release before D61,
   * or in `lazy` mode) keeps accepting while it is confirmed. `lazy`: appends as before D61
   * (the ledger first hears of a stream from its first flush). Tail reads that name a lost
   * stream, and `ensureStream`, register in either mode. The Worker var `SHARD_REGISTRATION`
   * (`logged` or `lazy`), when set, overrides this (shard/README.md, "Rollout").
   */
  registration: 'lazy' | 'logged'
  /** `Retry-After` of a `registering` refusal: this, plus up to as much again of jitter. */
  registerRetryAfterMs: number
  /** A registration the ledger has not answered as logged is asked again after this, doubling up to `registerBackoffMaxMs`. */
  registerBackoffMs: number
  registerBackoffMaxMs: number
  /** One registration call waits at most this long for the ledger (whose start alone may hold it 2 s). */
  registerTimeoutMs: number
  /** Registration calls in flight at once, per shard, over all tenants (review m-5: a shard has six outbound connections). */
  maxRegistrations: number
  /** A stream that has waited this long for its registration to be logged is reported (error log, `stats`; review m-1). */
  registerAlertMs: number
}

export const DEFAULT_CONFIG: ShardConfig = {
  maxBatchBytes: MAX_BATCH_BYTES,
  sealBytes: 4 << 20,
  sealAgeMs: 10 * 60_000,
  tenantMaxBytes: 64 << 20,
  shardMaxBytes: 512 << 20,
  retainRecordedMs: 30_000,
  fingerprintTtlMs: 15 * 60_000,
  notifyRetryMs: 30_000,
  seriesWindowMs: 60 * 60_000,
  seriesExactMax: 4096,
  seriesPersistMs: 60_000,
  maxInFlight: 64,
  maxPendingBytes: 16 << 20,
  overloadRetryMs: 1000,
  groupWindowMs: 0,
  maxGroupBytes: 4 << 20,
  tailScanMaxBytes: TAIL_SCAN_MAX_BYTES,
  registration: 'lazy',
  registerRetryAfterMs: 500,
  registerBackoffMs: 250,
  registerBackoffMaxMs: 30_000,
  registerTimeoutMs: 5_000,
  maxRegistrations: 4,
  registerAlertMs: 60_000,
}

/**
 * The shard's storage, versioned (contracts/COMPATIBILITY.md §2). Version 1 is the schema
 * as the code before versioning created it, with IF NOT EXISTS, so it adopts such storage;
 * an object created before `segment.sealed_at` existed gets that column (0), which `CREATE
 * TABLE IF NOT EXISTS` never added (design/UPGRADES.md §3.1). Stored BLOBs: `batch.payload`
 * is `VZB1` (contracts/BATCH.md); `series_window.data` carries its own format byte
 * (src/sketch.ts `SKETCH_FORMAT`).
 */
const V1 = [
  `CREATE TABLE IF NOT EXISTS config (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS stream (
      tenant TEXT PRIMARY KEY, incarnation INTEGER NOT NULL, epoch INTEGER NOT NULL,
      sealed_through INTEGER NOT NULL, recorded_through INTEGER NOT NULL, discarded_through INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS batch (
      tenant TEXT NOT NULL, seq INTEGER NOT NULL, fingerprint TEXT NOT NULL, rows INTEGER NOT NULL,
      bytes INTEGER NOT NULL, at INTEGER NOT NULL, payload BLOB, PRIMARY KEY (tenant, seq))`,
  `CREATE UNIQUE INDEX IF NOT EXISTS batch_fp ON batch (tenant, fingerprint)`,
  `CREATE TABLE IF NOT EXISTS segment (
      tenant TEXT NOT NULL, seq_lo INTEGER NOT NULL, seq_hi INTEGER NOT NULL, bytes INTEGER NOT NULL,
      rows INTEGER NOT NULL, recorded_at INTEGER, sealed_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (tenant, seq_lo))`,
  // Outbox of seal notifications: written in the same transaction as the segment, deleted
  // when the message has been handed to the queue.
  `CREATE TABLE IF NOT EXISTS notify (tenant TEXT PRIMARY KEY, due INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS series_window (
      tenant TEXT NOT NULL, bucket INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (tenant, bucket))`,
]

export const SHARD_SCHEMA: SchemaSpec = {
  component: 'shard.Shard',
  migrations: [{
    version: 1,
    name: 'the schema as it stood when versioning began (segment.sealed_at added to objects that lack it)',
    readableFrom: 1,
    up: (sql) => {
      for (const s of V1) sql.exec(s)
      if (!columnsOf(sql, 'segment').has('sealed_at')) sql.exec(`ALTER TABLE segment ADD COLUMN sealed_at INTEGER NOT NULL DEFAULT 0`)
    },
  }, {
    // ADDITIVE (readableFrom 1): `stream.registered` is the incarnation whose registration the
    // tenant's ledger answered as logged (D61), 0 before. The release before ignores it, inserts
    // its streams with 0, and never changes a stream row's incarnation, so a value this release
    // wrote stays true under it, and its 0 is only conservative: a stream holding acknowledged
    // rows is accepted whatever the column says, and one holding none is registered first.
    // Nothing relies on the older release maintaining it (COMPATIBILITY.md §2.3; review B-1).
    version: 2,
    name: 'stream.registered: the incarnation whose registration the ledger answered as logged (D61)',
    readableFrom: 1,
    up: (sql) => {
      if (!columnsOf(sql, 'stream').has('registered')) sql.exec(`ALTER TABLE stream ADD COLUMN registered INTEGER NOT NULL DEFAULT 0`)
    },
  }],
}

/**
 * The format version of `FlushMessage` (contracts/COMPATIBILITY.md §3.1: a JSON message
 * carries an integer `v`; an absent `v`, as messages before this field were sent, means 1).
 * flush/src/consumer.ts retries a message of a version it does not know.
 */
export const FLUSH_MESSAGE_VERSION = 1

/** What a shard puts on the flush queue when it seals a segment (binding `FLUSH_QUEUE`). */
export interface FlushMessage {
  /** Always written by this shard (`FLUSH_MESSAGE_VERSION`); optional in the type because messages sent before it existed lack it. */
  v?: number
  tenant: string
  shard: string
}

/**
 * Bindings a shard uses if they are there. Without `FLUSH_QUEUE` nobody is told about a
 * seal (tests of the shard alone, and callers that poll `pendingSegments`). Without
 * `CONFIG` no pending marker is kept, so the hourly sweep cannot find this shard. Without
 * `LEDGER` (the tenants' ledgers, `idFromName(tenant)`) nothing is registered: appends are
 * lazy whatever the mode, and a tail read naming a lost stream is answered as before D61.
 */
export interface ShardEnv {
  FLUSH_QUEUE?: Queue<FlushMessage>
  CONFIG?: KVNamespace
  /** Added with D61. In viz-ingest the ledger is a class of the same script. */
  LEDGER?: DurableObjectNamespace<Ledger>
  /** `logged` or `lazy`: the registration mode, overriding `ShardConfig.registration` (shard/README.md, "Rollout"). */
  SHARD_REGISTRATION?: string
}

/**
 * KV key that exists while a shard has (or recently had) sealed segments its ledger has not
 * recorded. The sweep lists this prefix, so it never wakes a shard that has nothing pending.
 */
export const PENDING_MARKER_PREFIX = 'flush-pending:'
export const pendingMarkerKey = (shard: string): string => `${PENDING_MARKER_PREFIX}${shard}`

export interface AppendRequest {
  tenant: string
  /** Shard-map epoch the caller routed with. */
  epoch: number
  /** Hash of the batch contents, chosen by the caller; makes retries idempotent. */
  fingerprint: string
  payload: Uint8Array
  rows: number
  /**
   * The `series_id` of every entry of the batch's series table, in table order
   * (contracts/BATCH.md, "Active series"). The shard does not parse batches; it only checks
   * that the length equals the header's `n_series`. Without it the batch is not metered.
   */
  seriesIds?: BigInt64Array
  /** This shard's share of the tenant's active-series limit. Needs `seriesIds`. */
  seriesLimit?: number
}

export type AppendResult =
  | { status: 'ok'; incarnation: number; seq: number; duplicate: boolean }
  /**
   * Nothing was stored; retry after `retryAfterMs`. `tenant`: this tenant's buffer is full.
   * `shard`: the shard's byte budget is full and this tenant is over its fair share.
   * `overload`: the shard has more appends in flight than it may take (refused before
   * anything was read or written), or its storage belongs to a newer release; a caller
   * that does not know this scope treats it like the others (backpressure).
   * `registering` (added 2026-11-19, D61): the stream is new (first use, or the shard lost its
   * storage) and the tenant's ledger has not yet answered its registration as logged. The
   * registration runs in the background; nothing was stored or counted, and nothing waited for
   * the ledger. Expected for about a second per new stream. Like `overload` it is the system
   * catching up, not the tenant over a limit: edge answers it 503 with `Retry-After`, never
   * 429 (Remote Write senders must retry 5xx and may drop 429: review M-2). A shard sends it
   * only in registration mode `logged`, which a deployment turns on only once every edge that
   * may run maps it (shard/README.md, "Rollout").
   */
  | { status: 'backpressure'; scope: 'tenant' | 'shard' | 'overload' | 'registering'; retryAfterMs: number }
  | { status: 'stale_epoch'; epoch: number }
  /** The payload is over the batch size cap. Nothing was stored; a retry of the same bytes cannot succeed. */
  | { status: 'too_large'; maxBytes: number }
  /**
   * Accepting the batch would take the stream past its active-series limit. Nothing was
   * stored. `refused` are the ids that are new to the window and do not fit; the same batch
   * without those series is accepted (series already active are never refused).
   */
  | { status: 'series_limit'; limit: number; current: number; refused: BigInt64Array }
  /** The request contradicts itself (`seriesIds` does not match the batch header). Nothing was stored. A caller bug, not retryable as is. */
  | { status: 'invalid'; reason: string }

export interface Segment {
  tenant: string
  incarnation: number
  seqLo: number
  seqHi: number
  bytes: number
  rows: number
}

export interface TailBatch {
  seq: number
  rows: number
  payload: Uint8Array
}

export type TailResult =
  /**
   * `page` is present exactly when the call passed `TailReadOptions` and this shard applied
   * them (added 2026-11-19, D48): `batches` hold only the rows the filter keeps, at most
   * `maxBytes` of them, and `page.next` continues the read. A caller that passed options and
   * gets `ok` WITHOUT `page` is talking to an older shard: the batches are the whole tail,
   * unfiltered and unpaged, as before (COMPATIBILITY.md §3.3: callee first).
   */
  | { status: 'ok'; incarnation: number; through: number; batches: TailBatch[]; page?: TailPage }
  /** The shard has discarded rows above the watermark it was asked about (for a paged read: on any page). Re-read the ledger. */
  | { status: 'stale_watermark'; incarnation: number; discardedThrough: number }
  /**
   * The stream was recreated (storage loss), or the shard held no stream for this tenant while
   * the caller names an incarnation. In the second case (D61) the shard first starts a fresh
   * stream, newer than the one named, and registers it with the tenant's ledger (one call,
   * awaited up to `registerTimeoutMs`; the rest in the background), and names it here, so the
   * next plan names it and a query can finish after a storage loss (spec F6, `LIVE_impl`). It
   * holds nothing acknowledged: read from 0 it is empty. 0 only from a shard without a
   * `LEDGER` binding, or of a release before D61.
   */
  | { status: 'incarnation_mismatch'; incarnation: number }
  /**
   * Added with `TailReadOptions` (only ever answered to a call that passes them). The rows the
   * filter keeps of batch `seq` alone are `bytes`, more than the page may hold: nothing is
   * returned, never a truncated batch. Ask again with a larger `maxBytes` (up to
   * `TAIL_PAGE_MAX_BYTES`, which one stored batch never exceeds) or a narrower filter.
   */
  | { status: 'page_limit'; seq: number; bytes: number; maxBytes: number }
  /** Options or a cursor this shard refuses (malformed, or a cursor of another read). Not retryable as is. */
  | { status: 'invalid'; reason: string }
  /** Options or a cursor of a version this shard does not read (COMPATIBILITY.md §3.2). */
  | { status: 'unsupported_version'; version: number; supported: number }

/** A tenant with sealed segments its ledger has not recorded. */
export interface PendingTenant {
  tenant: string
  segments: number
  /** When the oldest of them was sealed. */
  oldestSealedAt: number
}

export type RecordedResult =
  | { status: 'ok'; recordedThrough: number }
  | { status: 'not_contiguous'; recordedThrough: number }
  | { status: 'incarnation_mismatch'; incarnation: number }

/** What `ensureStream` answers (added 2026-11-19, D61). */
export interface EnsureStreamResult {
  /** The stream's incarnation now: the one the shard holds, or the fresh one it started. 0 only without a `LEDGER` binding and no stream. */
  incarnation: number
  /** The tenant's ledger has answered this incarnation's registration as logged. */
  registered: boolean
}

interface Stream {
  incarnation: number
  /** The tenant's ledger has answered this incarnation's registration as logged (`stream.registered`). */
  registered: boolean
  epoch: number
  nextSeq: number
  sealedThrough: number
  recordedThrough: number
  discardedThrough: number
  /** Bytes of payload still held (unsealed + sealed + recorded-but-retained). */
  bufferedBytes: number
  unsealedBytes: number
  oldestUnsealedAt: number | null
}

/** One append waiting in the open group. */
interface Pending {
  req: AppendRequest
  bytes: number
  now: number
  /** Appends of the same tenant and fingerprint in the same group share one row. */
  joined: Pending[]
  resolve(r: AppendResult): void
  reject(e: unknown): void
}

/** Load-shedding counters since this instance started (`stats()`). */
export interface ShardStats {
  appends: number
  committed: number
  groups: number
  /** Largest group committed. */
  maxGroup: number
  refusedOverload: number
  inFlight: number
  pendingBytes: number
  /** Appends refused `registering` (D61). */
  refusedRegistering: number
  /** Registration calls this instance made to ledgers. */
  registerCalls: number
  /** Streams waiting for their registration to be logged, and how long the longest has waited (ms; 0 if none). A wait over `registerAlertMs` is also an error log line (review m-1). */
  registering: number
  registeringForMs: number
}

/**
 * A stream's registration while the ledger has not answered it as logged. Memory only, a
 * schedule: what must be registered is `stream.registered`, rebuilt in `load`.
 */
interface Registration {
  incarnation: number
  /** When this instance began waiting for it (the alert's clock: an eviction restarts it). */
  since: number
  attempts: number
  /** The next call is not made before this (backoff). While a call is in flight: when the alarm tries again if that call is lost with the instance. */
  at: number
  inFlight: Promise<boolean> | null
  lastError: string | null
  reported: boolean
}

/** `p`, or a rejection after `ms`; the timer never outlives the call. */
async function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([p, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not answer within ${ms} ms`)), ms) })])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * A stream incarnation: milliseconds since the epoch in the high bits, 10 random bits below.
 * Incarnations are therefore ordered by creation time (contracts/ledger.ts `StreamRef`): a
 * stream recreated at a later millisecond always gets a larger number, whatever the random
 * bits, and the value stays a safe integer until the year 2248. Two creations of the same
 * stream within one millisecond, or a clock that steps backwards across a storage loss, are
 * the only ways to get a non-increasing value; the ledger refuses a lower incarnation, so
 * that case fails closed (`incarnation_mismatch`) instead of rewinding a watermark.
 */
export function newIncarnation(nowMs: number, random: number): number {
  return nowMs * 1024 + Math.floor(random * 1024)
}

export class Shard extends DurableObject<ShardEnv> {
  private cfg: ShardConfig = DEFAULT_CONFIG
  private streams = new Map<string, Stream>()
  private totalBytes = 0
  /** Active-series windows, rebuilt from `series_window` rows; `dirtySince` marks unsaved changes. */
  private windows = new Map<string, { w: SeriesWindow; dirtySince: number | null }>()
  /** Tenants whose stored window this code cannot read: their metered appends are refused, never guessed. */
  private unreadableWindows = new Set<string>()
  /** True once the KV pending marker is known to be written (config row `marker`). */
  private marked = false
  private refusal: SchemaTooNew | null = null
  /** Per tenant, the oldest `at` of a discarded batch whose fingerprint is still kept (a hint, rebuilt in `load`). */
  private fingerprintsFrom = new Map<string, number>()
  /** The open group and its accounting (memory only: nothing in it is acknowledged). */
  private group: Pending[] = []
  private groupBytes = 0
  private groupTimer: ReturnType<typeof setTimeout> | null = null
  private inFlight = 0
  private pendingBytes = 0
  private counters = { appends: 0, committed: 0, groups: 0, maxGroup: 0, refusedOverload: 0, refusedRegistering: 0, registerCalls: 0 }
  /** The tenants' ledgers (`env.LEDGER`). A field so that a test can put an older release's ledger behind it. */
  protected ledgerNs: DurableObjectNamespace<Ledger> | undefined
  /** Registrations not yet answered as logged, by tenant (a schedule, rebuilt in `load`). */
  private regs = new Map<string, Registration>()
  /** Registration calls in flight, and calls waiting for one of the `maxRegistrations` slots. */
  private regSlots = 0
  private regWaiters: (() => void)[] = []

  constructor(ctx: DurableObjectState, env: ShardEnv) {
    super(ctx, env ?? {})
    this.ledgerNs = env?.LEDGER
    // contracts/TABLES.md: a shard is named `{pool}/{slot}` with `SHARD_NAME`, or its flush
    // files' keys could name another stream. An object addressed otherwise serves nothing.
    if (ctx.id.name !== undefined && !SHARD_NAME.test(ctx.id.name)) throw new Error(`shard: name ${JSON.stringify(ctx.id.name.slice(0, 140))} does not match SHARD_NAME`)
    this.refusal = refusalOf(openSchema(ctx.storage, SHARD_SCHEMA))
    if (this.refusal) {
      // COMPATIBILITY.md §2.4: read nothing else, write nothing, keep the alarm coming back.
      void ctx.blockConcurrencyWhile(async () => {
        if ((await ctx.storage.getAlarm()) === null) await ctx.storage.setAlarm(Date.now() + this.refusal!.retryAfterMs)
      })
      return
    }
    const sql = ctx.storage.sql
    const row = sql.exec(`SELECT v FROM config WHERE k = 'cfg'`).toArray()[0]
    if (row) this.cfg = { ...DEFAULT_CONFIG, ...JSON.parse(row.v as string) }
    this.marked = sql.exec(`SELECT v FROM config WHERE k = 'marker'`).toArray()[0]?.v === '1'
    this.load()
  }

  /** Rebuild in-memory stream state from storage. Storage is the only source of truth. */
  private load(): void {
    const sql = this.ctx.storage.sql
    this.streams.clear()
    this.totalBytes = 0
    this.fingerprintsFrom.clear()
    for (const r of sql.exec(`SELECT * FROM stream`).toArray()) {
      const tenant = r.tenant as string
      const agg = sql
        .exec(
          `SELECT COALESCE(MAX(seq), 0) AS max_seq,
                  COALESCE(SUM(CASE WHEN payload IS NOT NULL THEN bytes END), 0) AS buffered,
                  COALESCE(SUM(CASE WHEN seq > ? THEN bytes END), 0) AS unsealed,
                  MIN(CASE WHEN seq > ? THEN at END) AS oldest,
                  MIN(CASE WHEN payload IS NULL THEN at END) AS fp_from
           FROM batch WHERE tenant = ?`,
          r.sealed_through, r.sealed_through, tenant,
        )
        .one()
      const s: Stream = {
        incarnation: r.incarnation as number,
        registered: r.registered === r.incarnation,
        epoch: r.epoch as number,
        nextSeq: Math.max(agg.max_seq as number, r.sealed_through as number) + 1,
        sealedThrough: r.sealed_through as number,
        recordedThrough: r.recorded_through as number,
        discardedThrough: r.discarded_through as number,
        bufferedBytes: agg.buffered as number,
        unsealedBytes: agg.unsealed as number,
        oldestUnsealedAt: (agg.oldest as number | null) ?? null,
      }
      this.streams.set(tenant, s)
      this.totalBytes += s.bufferedBytes
      if (agg.fp_from !== null) this.fingerprintsFrom.set(tenant, agg.fp_from as number)
    }
    // Registrations to finish: every new stream (it holds nothing, so it can take no write
    // until it is registered) whose registration the ledger has not answered as logged. A call
    // in flight when the instance went is made again by the alarm. A stream from before D61
    // (rows, never confirmed) is confirmed when it is next written to or `ensureStream`ed.
    const at = Date.now()
    for (const [tenant, r] of this.regs) {
      const s = this.streams.get(tenant)
      if (!s || s.registered || s.incarnation !== r.incarnation) this.regs.delete(tenant)
    }
    if (this.ledgerNs) {
      for (const [tenant, s] of this.streams) {
        if (!s.registered && s.nextSeq === 1 && !this.regs.has(tenant)) this.regs.set(tenant, this.newRegistration(s.incarnation, at))
      }
    }
    // Series windows as last saved. Ids seen since the last save are not in them: after an
    // eviction the count is low by at most `seriesPersistMs` worth of new series.
    this.windows.clear()
    this.unreadableWindows.clear()
    const now = Date.now()
    const stored = new Map<string, [number, Uint8Array][]>()
    for (const r of sql.exec(`SELECT tenant, bucket, data FROM series_window`).toArray()) {
      const list = stored.get(r.tenant as string) ?? []
      list.push([r.bucket as number, new Uint8Array(r.data as ArrayBuffer)])
      stored.set(r.tenant as string, list)
    }
    for (const [tenant, buckets] of stored) {
      try {
        this.windows.set(tenant, { w: SeriesWindow.load(this.cfg.seriesWindowMs, this.cfg.seriesExactMax, now, buckets), dirtySince: null })
      } catch (e) {
        // Written by a newer release: refuse this tenant's metered appends rather than start
        // an empty window, which would loosen its limit (COMPATIBILITY.md §3.2).
        if (!(e instanceof UnreadableSketch)) throw e
        this.unreadableWindows.add(tenant)
        console.error(`shard: series window of ${tenant} is unreadable: ${e.message}`)
      }
    }
  }

  private window(tenant: string, now: number): { w: SeriesWindow; dirtySince: number | null } {
    let e = this.windows.get(tenant)
    if (!e) this.windows.set(tenant, (e = { w: new SeriesWindow(this.cfg.seriesWindowMs, this.cfg.seriesExactMax, now), dirtySince: null }))
    if (e.w.rotate(now)) e.dirtySince ??= now
    return e
  }

  private refused(): never {
    throw new SchemaTooNewError(this.refusal!)
  }

  /**
   * Distinct series of one tenant active in this shard's window. `exact` is false when the
   * count is the sketch's estimate (standard error 1.6%). For a cardinality report.
   */
  async seriesCount(tenant: string): Promise<{ count: number; exact: boolean; windowMs: number }> {
    if (this.refusal) this.refused()
    const e = this.windows.get(tenant)
    if (!e) return { count: 0, exact: true, windowMs: this.cfg.seriesWindowMs }
    e.w.rotate(Date.now())
    return { count: e.w.count(), exact: e.w.exact, windowMs: this.cfg.seriesWindowMs }
  }

  /**
   * A new stream: first use, or after storage loss. A new incarnation is created only when no
   * stream row exists, and never repeats, so sequence numbers are never silently reused. It is
   * not registered yet. `above`: an incarnation the ledger is known to have (a tail read names
   * it), which the new one must exceed even if the clock stepped back (spec S5).
   */
  private createStream(tenant: string, epoch: number, above = 0): Stream {
    const floor = Number.isSafeInteger(above + 1) ? above + 1 : 0
    const incarnation = Math.max(newIncarnation(Date.now(), Math.random()), floor)
    this.ctx.storage.sql.exec(
      `INSERT INTO stream (tenant, incarnation, epoch, sealed_through, recorded_through, discarded_through, registered) VALUES (?, ?, ?, 0, 0, 0, 0)`,
      tenant, incarnation, epoch,
    )
    const s: Stream = { incarnation, registered: false, epoch, nextSeq: 1, sealedThrough: 0, recordedThrough: 0, discardedThrough: 0, bufferedBytes: 0, unsealedBytes: 0, oldestUnsealedAt: null }
    this.streams.set(tenant, s)
    return s
  }

  /**
   * The registration mode in force: the Worker var if set, else the stored configuration; and
   * `lazy` whatever they say when there is no ledger to register with.
   */
  private mode(): 'lazy' | 'logged' {
    if (!this.ledgerNs) return 'lazy'
    const v = this.env.SHARD_REGISTRATION
    return v === 'logged' || v === 'lazy' ? v : this.cfg.registration === 'logged' ? 'logged' : 'lazy'
  }

  /**
   * Whether an append to this stream may join a group. `lazy`: always. `logged`: once the
   * ledger has answered its registration as logged, or if the stream already holds
   * acknowledged rows (a release before D61, or `lazy` mode, made it: refusing it would remove
   * no exposure, and it is confirmed in the background). A stream that holds none is never
   * written to before its registration is logged (D61).
   */
  private accepts(s: Stream): boolean {
    return this.mode() === 'lazy' || s.registered || s.nextSeq > 1
  }

  private registeringRefusal(): AppendResult {
    this.counters.refusedRegistering++
    const ms = this.cfg.registerRetryAfterMs
    return { status: 'backpressure', scope: 'registering', retryAfterMs: ms + Math.floor(Math.random() * ms) }
  }

  /** Streams currently holding bytes; the denominator of the fair share. */
  private activeStreams(): number {
    let n = 0
    for (const s of this.streams.values()) if (s.bufferedBytes > 0) n++
    return n
  }

  async configure(cfg: Partial<ShardConfig>): Promise<ShardConfig> {
    if (this.refusal) this.refused()
    this.cfg = { ...this.cfg, ...cfg }
    this.ctx.storage.sql.exec(`INSERT OR REPLACE INTO config (k, v) VALUES ('cfg', ?)`, JSON.stringify(this.cfg))
    return this.cfg
  }

  /** In-memory load counters since this instance started, for tests and operators. */
  async stats(): Promise<ShardStats> {
    const now = Date.now()
    let longest = 0
    for (const r of this.regs.values()) longest = Math.max(longest, now - r.since)
    return { ...this.counters, inFlight: this.inFlight, pendingBytes: this.pendingBytes, registering: this.regs.size, registeringForMs: longest }
  }

  async append(req: AppendRequest): Promise<AppendResult> {
    const bytes = req.payload.byteLength
    // Early refusal, before anything is read or written: the shard already has as much in
    // flight as it may take. Retryable; nothing about this request is stored or counted.
    if (this.inFlight >= this.cfg.maxInFlight || this.pendingBytes + bytes > this.cfg.maxPendingBytes) {
      this.counters.refusedOverload++
      return { status: 'backpressure', scope: 'overload', retryAfterMs: this.cfg.overloadRetryMs + Math.floor(Math.random() * this.cfg.overloadRetryMs) }
    }
    // Storage of a newer release: retryable, never `ok` (design/UPGRADES.md §7).
    if (this.refusal) return { status: 'backpressure', scope: 'overload', retryAfterMs: this.refusal.retryAfterMs }
    this.counters.appends++
    const sql = this.ctx.storage.sql
    const known = this.streams.get(req.tenant)
    if (known && req.epoch < known.epoch) return { status: 'stale_epoch', epoch: known.epoch }

    // Retry of a batch this stream already holds: same answer, nothing stored twice.
    if (known) {
      const dup = sql.exec(`SELECT seq FROM batch WHERE tenant = ? AND fingerprint = ?`, req.tenant, req.fingerprint).toArray()[0]
      if (dup) return { status: 'ok', incarnation: known.incarnation, seq: dup.seq as number, duplicate: true }
    }
    // The same batch is waiting in the open group: share its answer (and its one row).
    const twin = this.group.find((p) => p.req.tenant === req.tenant && p.req.fingerprint === req.fingerprint)
    if (twin) {
      return new Promise<AppendResult>((resolve, reject) => {
        twin.joined.push({ req, bytes: 0, now: 0, joined: [], resolve: (r) => resolve(r.status === 'ok' ? { ...r, duplicate: true } : r), reject })
      })
    }

    // Checked before anything else about the payload, and before a stream is created for it.
    if (bytes > this.cfg.maxBatchBytes) return { status: 'too_large', maxBytes: this.cfg.maxBatchBytes }

    // Registration before writes (D61). Before any quota, metering or group, and with no await:
    // a refused append is stored nowhere, counted nowhere, and waits for nothing (D37's bound
    // stays what it was; review M-1). The registration runs in the background (`kick`), at most
    // one call per stream at a time and none during its backoff, whatever the senders do.
    if (this.mode() === 'logged') {
      const s = known ?? this.createStream(req.tenant, req.epoch)
      if (!s.registered) {
        this.kick(req.tenant)
        if (!this.accepts(s)) return this.registeringRefusal()
      }
    }
    // What this tenant holds, including what is waiting in the open group.
    let waiting = 0
    for (const p of this.group) if (p.req.tenant === req.tenant) waiting += p.bytes
    const held = (known?.bufferedBytes ?? 0) + waiting
    // A tenant is limited by its own cap first, so its backlog can never consume the shard.
    if (held + bytes > this.cfg.tenantMaxBytes) return { status: 'backpressure', scope: 'tenant', retryAfterMs: 1000 }
    // When the shard as a whole is full, only tenants above their fair share are refused.
    // A tenant at or below its share is always admitted, so one tenant cannot starve another.
    // Fair-share admission can overshoot the budget while over-share tenants drain, so
    // there is also a hard ceiling at twice the budget that nobody passes.
    const total = this.totalBytes + this.groupBytes
    if (total + bytes > 2 * this.cfg.shardMaxBytes) return { status: 'backpressure', scope: 'shard', retryAfterMs: 1000 }
    if (total + bytes > this.cfg.shardMaxBytes) {
      const sharers = this.activeStreams() + (held === 0 ? 1 : 0)
      const fairShare = Math.floor(this.cfg.shardMaxBytes / Math.max(1, sharers))
      if (held + bytes > fairShare) return { status: 'backpressure', scope: 'shard', retryAfterMs: 1000 }
    }

    // Active series. Only ids NEW to the window can be refused, so a tenant at its limit
    // keeps writing the series it already has. Checked and recorded here, with no await in
    // between, so two appends in one group cannot both take the last room.
    const now = Date.now()
    if (req.seriesIds) {
      // The one cheap check the shard can make without parsing the batch: `n_series` at offset 12.
      const header = bytes >= 16 ? new DataView(req.payload.buffer, req.payload.byteOffset, 16).getUint32(12, true) : -1
      if (header !== req.seriesIds.length) {
        return { status: 'invalid', reason: `${req.seriesIds.length} series ids for a batch whose header says ${header}` }
      }
      if (this.unreadableWindows.has(req.tenant)) return { status: 'backpressure', scope: 'overload', retryAfterMs: 30_000 }
      const metered = this.window(req.tenant, now)
      if (req.seriesLimit !== undefined) {
        const { current, fresh } = metered.w.check(req.seriesIds)
        const room = Math.max(0, req.seriesLimit - current)
        if (fresh.length > room) {
          return { status: 'series_limit', limit: req.seriesLimit, current, refused: BigInt64Array.from(fresh.slice(room)) }
        }
      }
      // Ids of a batch that is then not stored only make the count conservative (it is
      // recorded before the commit); a save only when something changed (review R-11).
      if (metered.w.add(req.seriesIds, req.seriesLimit ?? 0)) metered.dirtySince ??= now
    }

    return new Promise<AppendResult>((resolve, reject) => {
      this.inFlight++
      this.pendingBytes += bytes
      this.group.push({ req, bytes, now, joined: [], resolve, reject })
      this.groupBytes += bytes
      if (this.groupBytes >= this.cfg.maxGroupBytes) this.commitSoon(true)
      else this.commitSoon(false)
    })
  }

  /** Commit the open group after the window (or at once). One timer per group. */
  private commitSoon(now: boolean): void {
    if (now) {
      if (this.groupTimer !== null) clearTimeout(this.groupTimer)
      this.groupTimer = null
      void this.commitGroup()
      return
    }
    if (this.groupTimer !== null) return
    this.groupTimer = setTimeout(() => {
      this.groupTimer = null
      void this.commitGroup()
    }, this.cfg.groupWindowMs)
  }

  /**
   * One transaction for every append of the group: a row per batch (never per sample), the
   * stream rows, and any seal with its notification. Each caller is answered only after it
   * commits; if it throws, every caller of the group gets the error and nothing is stored.
   */
  private async commitGroup(): Promise<void> {
    const group = this.group
    if (group.length === 0) return
    this.group = []
    this.groupBytes = 0
    const sql = this.ctx.storage.sql
    let results: AppendResult[]
    let sealed = false
    try {
      results = this.ctx.storage.transactionSync(() => {
        const out: AppendResult[] = []
        const touched = new Set<string>()
        for (const p of group) {
          const { req } = p
          // `logged` mode created the stream before the append joined (and only a stream that
          // accepts joins); `lazy` creates it here, with its first batch, as before D61.
          const s = this.streams.get(req.tenant) ?? (this.mode() === 'lazy' ? this.createStream(req.tenant, req.epoch) : null)
          if (!s || !this.accepts(s)) {
            out.push(this.registeringRefusal())
            continue
          }
          if (req.epoch > s.epoch) {
            s.epoch = req.epoch
            sql.exec(`UPDATE stream SET epoch = ? WHERE tenant = ?`, s.epoch, req.tenant)
          }
          const seq = s.nextSeq
          sql.exec(
            `INSERT INTO batch (tenant, seq, fingerprint, rows, bytes, at, payload) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            req.tenant, seq, req.fingerprint, req.rows, p.bytes, p.now, req.payload,
          )
          s.nextSeq = seq + 1
          s.bufferedBytes += p.bytes
          s.unsealedBytes += p.bytes
          s.oldestUnsealedAt ??= p.now
          this.totalBytes += p.bytes
          touched.add(req.tenant)
          out.push({ status: 'ok', incarnation: s.incarnation, seq, duplicate: false })
        }
        for (const tenant of touched) {
          const s = this.streams.get(tenant)!
          if (s.unsealedBytes >= this.cfg.sealBytes && this.sealStream(tenant, s)) sealed = true
        }
        return out
      })
    } catch (e) {
      // Rolled back: memory may have moved with it, so it is rebuilt from storage.
      this.load()
      this.settle(group)
      for (const p of group) {
        p.reject(e)
        for (const j of p.joined) j.reject(e)
      }
      return
    }
    this.counters.groups++
    this.counters.committed += group.length
    this.counters.maxGroup = Math.max(this.counters.maxGroup, group.length)
    try {
      if (sealed) await this.deliver()
      await this.arm()
    } finally {
      // The answers go out now; the runtime holds each until the transaction is durable.
      this.settle(group)
      group.forEach((p, i) => {
        p.resolve(results[i]!)
        for (const j of p.joined) j.resolve(results[i]!)
      })
    }
  }

  private settle(group: Pending[]): void {
    this.inFlight -= group.length
    for (const p of group) this.pendingBytes -= p.bytes
  }

  /** Fix every unsealed batch of one stream as a segment. Durable before anything reads it. */
  private sealStream(tenant: string, s: Stream): Segment | null {
    const lo = s.sealedThrough + 1
    const hi = s.nextSeq - 1
    if (hi < lo) return null
    const sql = this.ctx.storage.sql
    const agg = sql.exec(`SELECT SUM(bytes) AS bytes, SUM(rows) AS rows FROM batch WHERE tenant = ? AND seq BETWEEN ? AND ?`, tenant, lo, hi).one()
    const now = Date.now()
    sql.exec(`INSERT INTO segment (tenant, seq_lo, seq_hi, bytes, rows, sealed_at) VALUES (?, ?, ?, ?, ?, ?)`, tenant, lo, hi, agg.bytes, agg.rows, now)
    sql.exec(`UPDATE stream SET sealed_through = ? WHERE tenant = ?`, hi, tenant)
    // The notification is part of the seal: same synchronous block, so same transaction.
    sql.exec(`INSERT INTO notify (tenant, due) VALUES (?, ?) ON CONFLICT (tenant) DO UPDATE SET due = excluded.due`, tenant, now)
    s.sealedThrough = hi
    s.unsealedBytes = 0
    s.oldestUnsealedAt = null
    return { tenant, incarnation: s.incarnation, seqLo: lo, seqHi: hi, bytes: agg.bytes as number, rows: agg.rows as number }
  }

  async seal(tenant: string): Promise<Segment | null> {
    if (this.refusal) this.refused()
    // Appends waiting in the open group are committed first: a seal covers what was acknowledged before it.
    if (this.group.length > 0) await this.flushGroup()
    const s = this.streams.get(tenant)
    const seg = s ? this.ctx.storage.transactionSync(() => this.sealStream(tenant, s)) : null
    if (seg) {
      await this.deliver()
      await this.arm()
    }
    return seg
  }

  /** Commit the open group now (and wait for it). */
  private async flushGroup(): Promise<void> {
    if (this.groupTimer !== null) clearTimeout(this.groupTimer)
    this.groupTimer = null
    await this.commitGroup()
  }

  /**
   * Hand one seal notification to its transport. This is the only place that knows the
   * transport is a Queue; see README, "Flush triggering", for why and what to change to
   * make it something else.
   */
  protected async announce(msg: FlushMessage): Promise<void> {
    if (this.env.FLUSH_QUEUE) await this.env.FLUSH_QUEUE.send(msg)
  }

  /**
   * Send every due notification and keep the pending marker true. A notification that
   * cannot be sent stays in the outbox and is retried by the alarm; one that was sent
   * twice is harmless (flush is idempotent).
   */
  private async deliver(): Promise<void> {
    const sql = this.ctx.storage.sql
    const now = Date.now()
    const name = this.ctx.id.name ?? ''
    for (const r of sql.exec(`SELECT tenant, due FROM notify WHERE due <= ? ORDER BY tenant`, now).toArray()) {
      const tenant = r.tenant as string
      try {
        await this.announce({ v: FLUSH_MESSAGE_VERSION, tenant, shard: name })
        // `due` is part of the key: a seal that happened during the send keeps its own row.
        sql.exec(`DELETE FROM notify WHERE tenant = ? AND due = ?`, tenant, r.due)
      } catch {
        sql.exec(`UPDATE notify SET due = ? WHERE tenant = ? AND due = ?`, now + this.cfg.notifyRetryMs, tenant, r.due)
      }
    }
    if (!this.marked && this.env.CONFIG && this.anyPending()) {
      try {
        await this.env.CONFIG.put(pendingMarkerKey(name), JSON.stringify({ since: now }))
        this.setMarked(true)
      } catch {
        // Retried by the alarm (`arm` keeps a deadline while segments are pending and unmarked).
      }
    }
  }

  private anyPending(): boolean {
    for (const tenant of this.streams.keys()) {
      if (this.ctx.storage.sql.exec(`SELECT 1 AS x FROM segment WHERE tenant = ? AND recorded_at IS NULL LIMIT 1`, tenant).toArray().length > 0) return true
    }
    return false
  }

  private setMarked(v: boolean): void {
    this.marked = v
    this.ctx.storage.sql.exec(`INSERT OR REPLACE INTO config (k, v) VALUES ('marker', ?)`, v ? '1' : '0')
  }

  /**
   * Tenants with sealed segments older than `olderThanMs` that their ledgers have not
   * recorded: what the sweep re-enqueues. When the shard has no pending segment at all it
   * removes its pending marker, so the next sweep does not wake it.
   */
  async pendingTenants(olderThanMs = 0): Promise<PendingTenant[]> {
    if (this.refusal) this.refused()
    const sql = this.ctx.storage.sql
    const out: PendingTenant[] = []
    const cutoff = Date.now() - olderThanMs
    for (const tenant of this.streams.keys()) {
      const r = sql.exec(`SELECT COUNT(*) AS n, MIN(sealed_at) AS oldest FROM segment WHERE tenant = ? AND recorded_at IS NULL`, tenant).one()
      if ((r.n as number) > 0 && (r.oldest as number) <= cutoff) out.push({ tenant, segments: r.n as number, oldestSealedAt: r.oldest as number })
    }
    if (this.marked && this.env.CONFIG && !this.anyPending()) {
      const key = pendingMarkerKey(this.ctx.id.name ?? '')
      // Believe the marker gone BEFORE deleting it (review R-6): from here a seal writes it
      // again itself (`deliver`), and if anything below fails the alarm does (`arm`).
      this.setMarked(false)
      await this.env.CONFIG.delete(key)
      // A seal during the delete may have written the marker just before the delete removed
      // it: write it once more. If that fails, `marked` stays false and the alarm retries.
      if (this.anyPending()) {
        try {
          await this.env.CONFIG.put(key, JSON.stringify({ since: Date.now() }))
          this.setMarked(true)
        } catch (e) {
          this.setMarked(false)
          await this.arm()
          throw e
        }
      }
    }
    return out
  }

  /** Sealed segments of one tenant that its ledger has not yet recorded. */
  async pendingSegments(tenant: string): Promise<Segment[]> {
    if (this.refusal) this.refused()
    const s = this.streams.get(tenant)
    if (!s) return []
    return this.ctx.storage.sql
      .exec(`SELECT seq_lo, seq_hi, bytes, rows FROM segment WHERE tenant = ? AND recorded_at IS NULL ORDER BY seq_lo`, tenant)
      .toArray()
      .map((r) => ({ tenant, incarnation: s.incarnation, seqLo: r.seq_lo as number, seqHi: r.seq_hi as number, bytes: r.bytes as number, rows: r.rows as number }))
  }

  /**
   * Payloads of one sealed segment, for the flush Worker. With `incarnation` (and `seqHi`),
   * null unless the stream is still that incarnation and the segment is exactly that range:
   * a flush that listed a segment before the shard lost its storage must not read the new
   * incarnation's batches under the old name (spec/README.md F12). Without them, as before.
   */
  async readSegment(tenant: string, seqLo: number, incarnation?: number, seqHi?: number): Promise<TailBatch[] | null> {
    if (this.refusal) this.refused()
    const s = this.streams.get(tenant)
    if (incarnation !== undefined && s?.incarnation !== incarnation) return null
    const sql = this.ctx.storage.sql
    const seg = sql.exec(`SELECT seq_hi FROM segment WHERE tenant = ? AND seq_lo = ?`, tenant, seqLo).toArray()[0]
    if (!seg || (seqHi !== undefined && seg.seq_hi !== seqHi)) return null
    return this.batches(tenant, seqLo, seg.seq_hi as number)
  }

  private batches(tenant: string, lo: number, hi: number): TailBatch[] {
    return this.ctx.storage.sql
      .exec(`SELECT seq, rows, payload FROM batch WHERE tenant = ? AND seq BETWEEN ? AND ? AND payload IS NOT NULL ORDER BY seq`, tenant, lo, hi)
      .toArray()
      .map((r) => ({ seq: r.seq as number, rows: r.rows as number, payload: new Uint8Array(r.payload as ArrayBuffer) }))
  }

  /**
   * The ledger has admitted every file of segments up to `throughSeq`, and that admission is
   * in its R2 log: `throughSeq` must come from the ledger's `loggedWatermarks()`, never from
   * `addUnit`'s answer (spec F8; the shard discards what is recorded). Must extend the
   * recorded prefix exactly at a segment boundary; anything else is refused unchanged.
   */
  async recorded(tenant: string, incarnation: number, throughSeq: number): Promise<RecordedResult> {
    if (this.refusal) this.refused()
    const s = this.streams.get(tenant)
    if (!s || s.incarnation !== incarnation) return { status: 'incarnation_mismatch', incarnation: s?.incarnation ?? 0 }
    if (throughSeq <= s.recordedThrough) return { status: 'ok', recordedThrough: s.recordedThrough }
    const sql = this.ctx.storage.sql
    const next = sql.exec(`SELECT seq_hi FROM segment WHERE tenant = ? AND seq_lo = ?`, tenant, s.recordedThrough + 1).toArray()[0]
    const boundary = sql.exec(`SELECT 1 AS ok FROM segment WHERE tenant = ? AND seq_hi = ?`, tenant, throughSeq).toArray()[0]
    if (!next || !boundary || throughSeq > s.sealedThrough) return { status: 'not_contiguous', recordedThrough: s.recordedThrough }
    sql.exec(`UPDATE segment SET recorded_at = ? WHERE tenant = ? AND seq_hi <= ? AND recorded_at IS NULL`, Date.now(), tenant, throughSeq)
    sql.exec(`UPDATE stream SET recorded_through = ? WHERE tenant = ?`, throughSeq, tenant)
    s.recordedThrough = throughSeq
    await this.arm()
    return { status: 'ok', recordedThrough: throughSeq }
  }

  /**
   * Rows of ONE tenant above a ledger watermark. If the shard has already discarded rows
   * the caller would need, it says so instead of returning a result with a hole in it.
   *
   * Without `opts` (the form every caller used before D48): every batch above `aboveSeq`, whole,
   * in one answer. With `opts`: only the rows the filter keeps (time range, metric names, exact
   * label values, a range of series keys), in pages of at most `maxBytes`, each with `page`;
   * `page.next` continues the read where it stopped, through the same `through`. A page never
   * holds part of a batch's kept rows: if they alone exceed `maxBytes` the answer is
   * `page_limit`. Every page checks the discard fence against the read's watermark: rows
   * above it discarded since the first page refuse the rest (`stale_watermark`), even rows
   * already returned (stricter than needed, and simple).
   */
  async tailRead(tenant: string, incarnation: number, aboveSeq: number, opts?: TailReadOptions): Promise<TailResult> {
    if (this.refusal) this.refused()
    // Appends waiting in the open group are not acknowledged yet, so not visible either.
    const s = this.streams.get(tenant)
    if (!s) {
      // No stream here. A caller that names one (an incarnation the ledger registered) is
      // told the shard does not hold it, so the loss shows instead of an empty tail (review
      // R-10); one that names none (0) and so expects nothing gets nothing.
      if (incarnation !== 0) {
        if (!this.ledgerNs) return { status: 'incarnation_mismatch', incarnation: 0 }
        // D61: the shard lost the stream the plan names. Refusing alone would refuse every
        // later query for as long as the ledger names the lost stream, which is until the
        // tenant writes here again (spec F6, `LIVE_impl`). So: start a fresh stream (the row
        // first, before any await, so concurrent reads are answered with the same one), newer
        // than the one named, register it, and name it. The next plan names it; read from 0 it
        // is empty, which is right: it holds nothing acknowledged.
        const fresh = this.createStream(tenant, 0, incarnation)
        await this.register(tenant)
        return { status: 'incarnation_mismatch', incarnation: this.streams.get(tenant)?.incarnation ?? fresh.incarnation }
      }
      const empty: TailResult = { status: 'ok', incarnation: 0, through: aboveSeq, batches: [] }
      return opts === undefined ? empty : { ...empty, page: { v: TAIL_READ_VERSION, next: null, scannedBatches: 0, scannedBytes: 0 } }
    }
    if (s.incarnation !== incarnation) return { status: 'incarnation_mismatch', incarnation: s.incarnation }
    if (aboveSeq < s.discardedThrough) return { status: 'stale_watermark', incarnation, discardedThrough: s.discardedThrough }
    if (opts === undefined) return { status: 'ok', incarnation, through: s.nextSeq - 1, batches: this.batches(tenant, aboveSeq + 1, s.nextSeq - 1) }
    return this.tailPage(tenant, s, aboveSeq, opts)
  }

  /** One page of a filtered tail read (`tailRead` with options), the stream and its fence already checked. */
  private tailPage(tenant: string, s: Stream, aboveSeq: number, opts: TailReadOptions): TailResult {
    if (typeof opts !== 'object' || opts === null) return { status: 'invalid', reason: 'options must be an object' }
    const v = opts.v ?? 1
    if (!Number.isSafeInteger(v) || v < 1) return { status: 'invalid', reason: 'v must be a positive integer' }
    if (v > TAIL_READ_VERSION) return { status: 'unsupported_version', version: v, supported: TAIL_READ_VERSION }
    const f = compileFilter(opts)
    if ('invalid' in f) return { status: 'invalid', reason: f.invalid }
    const maxBytes = opts.maxBytes ?? TAIL_PAGE_MAX_BYTES
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) return { status: 'invalid', reason: 'maxBytes must be a positive integer' }
    const limit = Math.min(maxBytes, TAIL_PAGE_MAX_BYTES)
    const binding = { t: fnv64(tenant), f: fnv64(f.canonical) }
    let through = s.nextSeq - 1
    let from = aboveSeq + 1
    if (opts.cursor !== undefined) {
      const c = decodeCursor(opts.cursor)
      if ('unsupported' in c) return { status: 'unsupported_version', version: c.unsupported, supported: TAIL_READ_VERSION }
      if ('invalid' in c) return { status: 'invalid', reason: c.invalid }
      // A cursor continues one read: the same tenant, stream, watermark and filter.
      if (c.t !== binding.t || c.inc !== s.incarnation || c.above !== aboveSeq || c.f !== binding.f || c.seq <= aboveSeq || c.seq > c.through + 1) {
        return { status: 'invalid', reason: 'the cursor belongs to another read (tenant, incarnation, watermark or filter differ)' }
      }
      through = c.through
      from = c.seq
      // (A discard above the read's watermark since its first page was refused by `tailRead`.)
    }
    const batches: TailBatch[] = []
    let bytes = 0
    let scannedBatches = 0
    let scannedBytes = 0
    let next: number | null = null
    // Row by row from SQLite (nothing is awaited here), so the page holds what it returns and
    // one stored batch, not the tail.
    for (const r of this.ctx.storage.sql.exec(
      `SELECT seq, rows, payload FROM batch WHERE tenant = ? AND seq BETWEEN ? AND ? AND payload IS NOT NULL ORDER BY seq`, tenant, from, through,
    )) {
      const seq = r.seq as number
      if (scannedBytes >= this.cfg.tailScanMaxBytes) {
        next = seq
        break
      }
      const payload = new Uint8Array(r.payload as ArrayBuffer)
      scannedBatches++
      scannedBytes += payload.byteLength
      let kept: { bytes: Uint8Array; rows: number } | null
      try {
        kept = f.all ? { bytes: payload, rows: r.rows as number } : filterBatch(payload, f)
      } catch (e) {
        // An acknowledged batch this code cannot read is never skipped: the read fails.
        if (e instanceof UnreadableBatch) throw new Error(`shard: tail of ${tenant}: batch ${seq} is unreadable (${e.message})`)
        throw e
      }
      if (!kept) continue
      if (bytes + kept.bytes.byteLength > limit) {
        if (batches.length === 0) return { status: 'page_limit', seq, bytes: kept.bytes.byteLength, maxBytes: limit }
        next = seq
        break
      }
      batches.push({ seq, rows: kept.rows, payload: kept.bytes })
      bytes += kept.bytes.byteLength
    }
    const page: TailPage = {
      v: TAIL_READ_VERSION,
      next: next === null ? null : encodeCursor({ inc: s.incarnation, above: aboveSeq, through, seq: next, ...binding }),
      scannedBatches,
      scannedBytes,
    }
    return { status: 'ok', incarnation: s.incarnation, through, batches, page }
  }

  /**
   * What an append does before it is accepted, without a batch (D61): the tenant's stream in
   * this shard exists (a fresh incarnation if the shard holds none) and its registration is
   * asked of the ledger once (awaited, up to `registerTimeoutMs`), unless already confirmed;
   * the rest goes on in the background. For the janitor, which needs a shard that lost a stream
   * to start and register a fresh one so the old incarnation's files can be judged dead (spec
   * F16), and for a map change or a new tenant, which can register every new slot before
   * senders write to it (review m-4). Holds no payload; not bounded by D37.
   */
  async ensureStream(tenant: string): Promise<EnsureStreamResult> {
    if (this.refusal) this.refused()
    if (typeof tenant !== 'string' || !TENANT_ID.test(tenant)) throw new Error('shard: tenant id must match [A-Za-z0-9_-]{1,64}')
    let s = this.streams.get(tenant)
    if (!this.ledgerNs) return { incarnation: s?.incarnation ?? 0, registered: s?.registered ?? false }
    s ??= this.createStream(tenant, 0)
    if (!s.registered) await this.register(tenant)
    const now = this.streams.get(tenant) ?? s
    return { incarnation: now.incarnation, registered: now.registered }
  }

  // ───────────────────────────── registration (D61) ─────────────────────────────

  private newRegistration(incarnation: number, now: number): Registration {
    return { incarnation, since: now, attempts: 0, at: now, inFlight: null, lastError: null, reported: false }
  }

  /** The registration schedule of this stream's incarnation. */
  private registration(tenant: string, s: Stream): Registration {
    let r = this.regs.get(tenant)
    if (!r || r.incarnation !== s.incarnation) this.regs.set(tenant, (r = this.newRegistration(s.incarnation, Date.now())))
    return r
  }

  /** Start a registration call for this stream if none is in flight and its backoff is over. Never waits. */
  private kick(tenant: string): void {
    const s = this.streams.get(tenant)
    if (!this.ledgerNs || !s || s.registered) return
    const r = this.registration(tenant, s)
    if (r.inFlight === null && r.at <= Date.now()) void this.register(tenant)
  }

  /**
   * One registration call for this stream (single-flight: a caller during a call gets that
   * call's answer). Resolves true once the ledger has answered it as logged; never throws.
   */
  private register(tenant: string): Promise<boolean> {
    const s = this.streams.get(tenant)
    if (!s) return Promise.resolve(false)
    if (s.registered) return Promise.resolve(true)
    const ns = this.ledgerNs
    if (!ns) return Promise.resolve(false)
    const r = this.registration(tenant, s)
    if (r.inFlight) return r.inFlight
    const call = this.callLedger(tenant, r, ns).finally(() => {
      if (r.inFlight === call) r.inFlight = null
    })
    r.inFlight = call
    this.ctx.waitUntil(call)
    return call
  }

  private async callLedger(tenant: string, r: Registration, ns: DurableObjectNamespace<Ledger>): Promise<boolean> {
    const name = this.ctx.id.name ?? ''
    // If this call is lost with the instance, the alarm makes it again after this (set before
    // the call: the runtime sends nothing out until the alarm's write is durable).
    r.at = Date.now() + this.cfg.registerTimeoutMs + this.cfg.registerBackoffMs
    await this.arm().catch(() => undefined)
    let logged = false
    await this.acquire()
    try {
      r.attempts++
      this.counters.registerCalls++
      const ledger = ns.get(ns.idFromName(tenant))
      try {
        const answer = await within(ledger.registerStream({ shard: name, incarnation: r.incarnation }), this.cfg.registerTimeoutMs, `the ledger of ${tenant}`)
        // A ledger of a release before D61 sends no `logged`: not logged (contracts/ledger.ts).
        logged = answer.logged === true
        r.lastError = logged ? null : 'registered, not yet logged'
      } catch (e) {
        r.lastError = (e instanceof Error ? e.message : String(e)).slice(0, 300)
        await this.lowerThanLedger(tenant, r, ledger)
      }
    } finally {
      this.release()
    }
    if (logged) this.confirm(tenant, r.incarnation)
    else this.backoff(tenant, r)
    await this.arm().catch(() => undefined)
    return logged
  }

  /** The ledger answered this incarnation's registration as logged: remember it (one row write), and stop scheduling it. */
  private confirm(tenant: string, incarnation: number): void {
    const s = this.streams.get(tenant)
    if (!s || s.incarnation !== incarnation) return
    if (!s.registered) {
      this.ctx.storage.sql.exec(`UPDATE stream SET registered = ? WHERE tenant = ? AND incarnation = ?`, incarnation, tenant, incarnation)
      s.registered = true
    }
    if (this.regs.get(tenant)?.incarnation === incarnation) this.regs.delete(tenant)
  }

  private backoff(tenant: string, r: Registration): void {
    const now = Date.now()
    r.at = now + Math.min(this.cfg.registerBackoffMaxMs, this.cfg.registerBackoffMs * 2 ** Math.min(20, Math.max(0, r.attempts - 1)))
    if (!r.reported && now - r.since >= this.cfg.registerAlertMs && this.regs.get(tenant) === r) {
      r.reported = true
      const s = this.streams.get(tenant)
      console.error(
        `shard ${this.ctx.id.name ?? ''}: the registration of ${tenant}'s stream ${r.incarnation} has not been logged by its ledger after ${Math.round((now - r.since) / 1000)} s ` +
          `(${r.attempts} calls; last: ${r.lastError ?? 'none'}); ${s && s.nextSeq > 1 ? 'it keeps accepting (it holds rows from before D61)' : 'its writes are refused until it is'}`,
      )
    }
  }

  /**
   * S5 (spec/README.md): the ledger refuses an incarnation lower than its own for good, which
   * after a storage loss across a clock step back is this new stream's. A stream that holds
   * nothing acknowledged (never registered, no batch) can start again above the ledger's
   * incarnation, read from `loggedWatermarks()`, without losing anything (review m-7). One
   * that holds rows (made before D61) cannot be renumbered; it stays refused by the ledger and
   * is reported, as before D61.
   */
  private async lowerThanLedger(tenant: string, r: Registration, ledger: DurableObjectStub<Ledger>): Promise<void> {
    const name = this.ctx.id.name ?? ''
    const s = this.streams.get(tenant)
    if (!s || s.registered || s.incarnation !== r.incarnation || s.nextSeq !== 1) return
    let theirs: number | undefined
    try {
      theirs = (await within(ledger.loggedWatermarks(), this.cfg.registerTimeoutMs, `the ledger of ${tenant}`)).find((w) => w.shard === name)?.incarnation
    } catch {
      return // the ledger cannot say: try the registration again later
    }
    if (theirs === undefined || theirs <= r.incarnation || !Number.isSafeInteger(theirs + 1)) return // some other failure
    // Judged again after the await: still the same new stream, still holding nothing.
    if (this.streams.get(tenant) !== s || s.registered || s.incarnation !== r.incarnation || s.nextSeq !== 1 || this.group.some((p) => p.req.tenant === tenant)) return
    const fresh = theirs + 1
    this.ctx.storage.sql.exec(`UPDATE stream SET incarnation = ?, registered = 0 WHERE tenant = ? AND incarnation = ?`, fresh, tenant, s.incarnation)
    console.error(`shard ${name}: ${tenant}'s new stream ${s.incarnation} is below the ledger's ${theirs} (a clock that stepped back across a storage loss: spec S5); it holds nothing acknowledged, so it starts again as ${fresh}`)
    s.incarnation = fresh
    this.regs.set(tenant, this.newRegistration(fresh, Date.now()))
  }

  /** A slot among `maxRegistrations` registration calls in flight (review m-5). */
  private acquire(): Promise<void> {
    if (this.regSlots < Math.max(1, this.cfg.maxRegistrations)) {
      this.regSlots++
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => this.regWaiters.push(resolve))
  }

  private release(): void {
    const next = this.regWaiters.shift()
    if (next) next() // the slot passes to the next call
    else this.regSlots--
  }

  /** Per-stream state, for the ledger, for tests and for operators. */
  async describe(tenant: string): Promise<(Stream & { totalBytes: number }) | null> {
    if (this.refusal) this.refused()
    const s = this.streams.get(tenant)
    return s ? { ...s, totalBytes: this.totalBytes } : null
  }

  /** One alarm for the whole shard, set to the earliest deadline, and absent when idle. */
  private async arm(): Promise<void> {
    let due = Infinity
    for (const s of this.streams.values()) {
      if (s.oldestUnsealedAt !== null) due = Math.min(due, s.oldestUnsealedAt + this.cfg.sealAgeMs)
    }
    for (const e of this.windows.values()) {
      if (e.dirtySince !== null) due = Math.min(due, e.dirtySince + this.cfg.seriesPersistMs)
    }
    const sql = this.ctx.storage.sql
    // A notification still in the outbox, or a pending marker that could not be written.
    for (const tenant of this.streams.keys()) {
      const unsent = sql.exec(`SELECT MIN(due) AS at FROM notify WHERE tenant = ?`, tenant).one().at as number | null
      if (unsent !== null) due = Math.min(due, unsent)
      const rec = sql
        .exec(`SELECT MIN(recorded_at) AS at FROM segment WHERE tenant = ? AND recorded_at IS NOT NULL AND seq_hi > ?`, tenant, this.streams.get(tenant)!.discardedThrough)
        .one().at as number | null
      if (rec !== null) due = Math.min(due, rec + this.cfg.retainRecordedMs)
    }
    if (!this.marked && this.env.CONFIG && this.anyPending()) due = Math.min(due, Date.now() + this.cfg.notifyRetryMs)
    for (const at of this.fingerprintsFrom.values()) due = Math.min(due, at + this.cfg.fingerprintTtlMs)
    // A registration's next call (or the deadline of one in flight): the same one alarm (D61).
    for (const r of this.regs.values()) due = Math.min(due, r.at)
    const current = await this.ctx.storage.getAlarm()
    if (due === Infinity) {
      if (current !== null) await this.ctx.storage.deleteAlarm()
    } else if (current === null || Math.abs(current - due) > 250) {
      await this.ctx.storage.setAlarm(Math.max(due, Date.now() + 1))
    }
  }

  /** Housekeeping. Idempotent: alarms are at-least-once. */
  async alarm(): Promise<void> {
    if (this.refusal) {
      await this.ctx.storage.setAlarm(Date.now() + this.refusal.retryAfterMs)
      return
    }
    const now = Date.now()
    const sql = this.ctx.storage.sql
    // 0. Save series windows that changed. Two rows per stream, whole buckets (never a row per id).
    for (const [tenant, e] of this.windows) {
      if (e.dirtySince === null || e.dirtySince + this.cfg.seriesPersistMs > now) continue
      e.w.rotate(now)
      const buckets = e.w.save()
      for (const [bucket, data] of buckets) sql.exec(`INSERT OR REPLACE INTO series_window (tenant, bucket, data) VALUES (?, ?, ?)`, tenant, bucket, data)
      sql.exec(`DELETE FROM series_window WHERE tenant = ? AND bucket < ?`, tenant, buckets[0]![0])
      e.dirtySince = null
    }
    for (const [tenant, s] of this.streams) {
      // 1. Seal streams whose oldest unsealed batch has waited long enough.
      if (s.oldestUnsealedAt !== null && s.oldestUnsealedAt + this.cfg.sealAgeMs <= now) this.sealStream(tenant, s)
      // 2. Discard payloads of segments recorded longer ago than the retention window.
      const hi = sql
        .exec(`SELECT MAX(seq_hi) AS hi FROM segment WHERE tenant = ? AND recorded_at IS NOT NULL AND recorded_at + ? <= ? AND seq_hi > ?`,
          tenant, this.cfg.retainRecordedMs, now, s.discardedThrough)
        .one().hi as number | null
      if (hi !== null) {
        // The fence moves first, in the same transaction as the payloads go.
        const freed = sql.exec(`SELECT COALESCE(SUM(bytes), 0) AS b, MIN(at) AS at FROM batch WHERE tenant = ? AND seq <= ? AND payload IS NOT NULL`, tenant, hi).one()
        sql.exec(`UPDATE stream SET discarded_through = ? WHERE tenant = ?`, hi, tenant)
        sql.exec(`UPDATE batch SET payload = NULL WHERE tenant = ? AND seq <= ? AND payload IS NOT NULL`, tenant, hi)
        sql.exec(`DELETE FROM segment WHERE tenant = ? AND seq_hi <= ?`, tenant, hi)
        s.discardedThrough = hi
        s.bufferedBytes -= freed.b as number
        this.totalBytes -= freed.b as number
        if (freed.at !== null) this.fingerprintsFrom.set(tenant, Math.min(this.fingerprintsFrom.get(tenant) ?? Infinity, freed.at as number))
      }
      // 3. Forget fingerprints of discarded batches once clients can no longer be retrying
      //    (per tenant, as every statement on tenant data is: AGENTS.md, review R-12).
      if ((this.fingerprintsFrom.get(tenant) ?? Infinity) + this.cfg.fingerprintTtlMs <= now) {
        sql.exec(`DELETE FROM batch WHERE tenant = ? AND payload IS NULL AND at + ? <= ?`, tenant, this.cfg.fingerprintTtlMs, now)
        const left = sql.exec(`SELECT MIN(at) AS at FROM batch WHERE tenant = ? AND payload IS NULL`, tenant).one().at as number | null
        if (left === null) this.fingerprintsFrom.delete(tenant)
        else this.fingerprintsFrom.set(tenant, left)
      }
    }
    // 4. Seals made above, and anything a previous attempt could not send.
    await this.deliver()
    // 5. Registrations whose backoff is over, or whose call was lost with an instance (D61).
    //    Each call holds a slot of `maxRegistrations` and waits at most `registerTimeoutMs`.
    const due = [...this.regs].filter(([, r]) => r.inFlight === null && r.at <= now).map(([tenant]) => this.register(tenant))
    if (due.length > 0) await Promise.allSettled(due)
    await this.arm()
  }
}
