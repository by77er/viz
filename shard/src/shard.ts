import { DurableObject } from 'cloudflare:workers'
import { SeriesWindow } from './sketch'

/**
 * A pooled shard: the write-ahead log for several tenants in one Durable Object.
 *
 * The unit of everything is a **stream**: one tenant's log inside this shard, identified
 * by `(shard, tenant, incarnation)`. Sequence numbers, seals, discard marks, quotas and
 * dedup fingerprints all belong to a stream. Nothing in this file reads or writes rows
 * without naming the tenant, and no state is shared between streams except the shard's
 * total byte budget.
 *
 * Lifecycle of a batch:  append → (seal) → [flush Worker writes Parquet] → recorded → discard
 *
 *   append    durable before the caller is answered (Durable Object output gate)
 *   seal      fixes a contiguous range of batches as a segment; the boundary is durable,
 *             and a `{tenant, shard}` message for the flush queue is written with it
 *   recorded  the tenant's ledger has admitted the segment's files
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
}

/** What a shard puts on the flush queue when it seals a segment (binding `FLUSH_QUEUE`). */
export interface FlushMessage {
  tenant: string
  shard: string
}

/**
 * Bindings a shard uses if they are there. Without `FLUSH_QUEUE` nobody is told about a
 * seal (tests of the shard alone, and callers that poll `pendingSegments`). Without
 * `CONFIG` no pending marker is kept, so the hourly sweep cannot find this shard.
 */
export interface ShardEnv {
  FLUSH_QUEUE?: Queue<FlushMessage>
  CONFIG?: KVNamespace
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
  | { status: 'backpressure'; scope: 'tenant' | 'shard'; retryAfterMs: number }
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
  | { status: 'ok'; incarnation: number; through: number; batches: TailBatch[] }
  /** The shard has discarded rows above the watermark it was asked about. Re-read the ledger. */
  | { status: 'stale_watermark'; incarnation: number; discardedThrough: number }
  /** The stream was recreated (storage loss). The ledger must register the new incarnation. */
  | { status: 'incarnation_mismatch'; incarnation: number }

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

interface Stream {
  incarnation: number
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
  /** True once the KV pending marker is known to be written (config row `marker`). */
  private marked = false

  constructor(ctx: DurableObjectState, env: ShardEnv) {
    super(ctx, env ?? {})
    const sql = ctx.storage.sql
    sql.exec(`CREATE TABLE IF NOT EXISTS config (k TEXT PRIMARY KEY, v TEXT NOT NULL)`)
    sql.exec(`CREATE TABLE IF NOT EXISTS stream (
      tenant TEXT PRIMARY KEY, incarnation INTEGER NOT NULL, epoch INTEGER NOT NULL,
      sealed_through INTEGER NOT NULL, recorded_through INTEGER NOT NULL, discarded_through INTEGER NOT NULL)`)
    sql.exec(`CREATE TABLE IF NOT EXISTS batch (
      tenant TEXT NOT NULL, seq INTEGER NOT NULL, fingerprint TEXT NOT NULL, rows INTEGER NOT NULL,
      bytes INTEGER NOT NULL, at INTEGER NOT NULL, payload BLOB, PRIMARY KEY (tenant, seq))`)
    sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS batch_fp ON batch (tenant, fingerprint)`)
    sql.exec(`CREATE TABLE IF NOT EXISTS segment (
      tenant TEXT NOT NULL, seq_lo INTEGER NOT NULL, seq_hi INTEGER NOT NULL, bytes INTEGER NOT NULL,
      rows INTEGER NOT NULL, recorded_at INTEGER, sealed_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (tenant, seq_lo))`)
    // Outbox of seal notifications: written in the same transaction as the segment, deleted
    // when the message has been handed to the queue.
    sql.exec(`CREATE TABLE IF NOT EXISTS notify (tenant TEXT PRIMARY KEY, due INTEGER NOT NULL)`)
    sql.exec(`CREATE TABLE IF NOT EXISTS series_window (
      tenant TEXT NOT NULL, bucket INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (tenant, bucket))`)
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
    for (const r of sql.exec(`SELECT * FROM stream`).toArray()) {
      const tenant = r.tenant as string
      const agg = sql
        .exec(
          `SELECT COALESCE(MAX(seq), 0) AS max_seq,
                  COALESCE(SUM(CASE WHEN payload IS NOT NULL THEN bytes END), 0) AS buffered,
                  COALESCE(SUM(CASE WHEN seq > ? THEN bytes END), 0) AS unsealed,
                  MIN(CASE WHEN seq > ? THEN at END) AS oldest
           FROM batch WHERE tenant = ?`,
          r.sealed_through, r.sealed_through, tenant,
        )
        .one()
      const s: Stream = {
        incarnation: r.incarnation as number,
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
    }
    // Series windows as last saved. Ids seen since the last save are not in them: after an
    // eviction the count is low by at most `seriesPersistMs` worth of new series.
    this.windows.clear()
    const now = Date.now()
    const stored = new Map<string, [number, Uint8Array][]>()
    for (const r of sql.exec(`SELECT tenant, bucket, data FROM series_window`).toArray()) {
      const list = stored.get(r.tenant as string) ?? []
      list.push([r.bucket as number, new Uint8Array(r.data as ArrayBuffer)])
      stored.set(r.tenant as string, list)
    }
    for (const [tenant, buckets] of stored) {
      this.windows.set(tenant, { w: SeriesWindow.load(this.cfg.seriesWindowMs, this.cfg.seriesExactMax, now, buckets), dirtySince: null })
    }
  }

  private window(tenant: string, now: number): { w: SeriesWindow; dirtySince: number | null } {
    let e = this.windows.get(tenant)
    if (!e) this.windows.set(tenant, (e = { w: new SeriesWindow(this.cfg.seriesWindowMs, this.cfg.seriesExactMax, now), dirtySince: null }))
    if (e.w.rotate(now)) e.dirtySince ??= now
    return e
  }

  /**
   * Distinct series of one tenant active in this shard's window. `exact` is false when the
   * count is the sketch's estimate (standard error 1.6%). For a cardinality report.
   */
  async seriesCount(tenant: string): Promise<{ count: number; exact: boolean; windowMs: number }> {
    const e = this.windows.get(tenant)
    if (!e) return { count: 0, exact: true, windowMs: this.cfg.seriesWindowMs }
    e.w.rotate(Date.now())
    return { count: e.w.count(), exact: e.w.exact, windowMs: this.cfg.seriesWindowMs }
  }

  private stream(tenant: string, epoch: number): Stream {
    let s = this.streams.get(tenant)
    if (!s) {
      // A new incarnation is created only when no stream row exists: first use, or after
      // storage loss. It never repeats, so sequence numbers are never silently reused.
      const incarnation = newIncarnation(Date.now(), Math.random())
      this.ctx.storage.sql.exec(
        `INSERT INTO stream (tenant, incarnation, epoch, sealed_through, recorded_through, discarded_through) VALUES (?, ?, ?, 0, 0, 0)`,
        tenant, incarnation, epoch,
      )
      s = { incarnation, epoch, nextSeq: 1, sealedThrough: 0, recordedThrough: 0, discardedThrough: 0, bufferedBytes: 0, unsealedBytes: 0, oldestUnsealedAt: null }
      this.streams.set(tenant, s)
    }
    return s
  }

  /** Streams currently holding bytes; the denominator of the fair share. */
  private activeStreams(): number {
    let n = 0
    for (const s of this.streams.values()) if (s.bufferedBytes > 0) n++
    return n
  }

  async configure(cfg: Partial<ShardConfig>): Promise<ShardConfig> {
    this.cfg = { ...this.cfg, ...cfg }
    this.ctx.storage.sql.exec(`INSERT OR REPLACE INTO config (k, v) VALUES ('cfg', ?)`, JSON.stringify(this.cfg))
    return this.cfg
  }

  async append(req: AppendRequest): Promise<AppendResult> {
    const sql = this.ctx.storage.sql
    const known = this.streams.get(req.tenant)
    if (known && req.epoch < known.epoch) return { status: 'stale_epoch', epoch: known.epoch }

    // Retry of a batch this stream already holds: same answer, nothing stored twice.
    if (known) {
      const dup = sql.exec(`SELECT seq FROM batch WHERE tenant = ? AND fingerprint = ?`, req.tenant, req.fingerprint).toArray()[0]
      if (dup) return { status: 'ok', incarnation: known.incarnation, seq: dup.seq as number, duplicate: true }
    }

    const bytes = req.payload.byteLength
    // Checked before anything else about the payload, and before a stream is created for it.
    if (bytes > this.cfg.maxBatchBytes) return { status: 'too_large', maxBytes: this.cfg.maxBatchBytes }
    const held = known?.bufferedBytes ?? 0
    // A tenant is limited by its own cap first, so its backlog can never consume the shard.
    if (held + bytes > this.cfg.tenantMaxBytes) return { status: 'backpressure', scope: 'tenant', retryAfterMs: 1000 }
    // When the shard as a whole is full, only tenants above their fair share are refused.
    // A tenant at or below its share is always admitted, so one tenant cannot starve another.
    // Fair-share admission can overshoot the budget while over-share tenants drain, so
    // there is also a hard ceiling at twice the budget that nobody passes.
    if (this.totalBytes + bytes > 2 * this.cfg.shardMaxBytes) return { status: 'backpressure', scope: 'shard', retryAfterMs: 1000 }
    if (this.totalBytes + bytes > this.cfg.shardMaxBytes) {
      const sharers = this.activeStreams() + (held === 0 ? 1 : 0)
      const fairShare = Math.floor(this.cfg.shardMaxBytes / Math.max(1, sharers))
      if (held + bytes > fairShare) return { status: 'backpressure', scope: 'shard', retryAfterMs: 1000 }
    }

    // Active series. Only ids NEW to the window can be refused, so a tenant at its limit
    // keeps writing the series it already has. Nothing is recorded unless the batch is stored.
    const now = Date.now()
    let metered: { w: SeriesWindow; dirtySince: number | null } | null = null
    if (req.seriesIds) {
      // The one cheap check the shard can make without parsing the batch: `n_series` at offset 12.
      const header = bytes >= 16 ? new DataView(req.payload.buffer, req.payload.byteOffset, 16).getUint32(12, true) : -1
      if (header !== req.seriesIds.length) {
        return { status: 'invalid', reason: `${req.seriesIds.length} series ids for a batch whose header says ${header}` }
      }
      metered = this.window(req.tenant, now)
      if (req.seriesLimit !== undefined) {
        const { current, fresh } = metered.w.check(req.seriesIds)
        const room = Math.max(0, req.seriesLimit - current)
        if (fresh.length > room) {
          return { status: 'series_limit', limit: req.seriesLimit, current, refused: BigInt64Array.from(fresh.slice(room)) }
        }
      }
    }

    const s = this.stream(req.tenant, req.epoch)
    if (req.epoch > s.epoch) {
      s.epoch = req.epoch
      sql.exec(`UPDATE stream SET epoch = ? WHERE tenant = ?`, s.epoch, req.tenant)
    }
    const seq = s.nextSeq
    sql.exec(
      `INSERT INTO batch (tenant, seq, fingerprint, rows, bytes, at, payload) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      req.tenant, seq, req.fingerprint, req.rows, bytes, now, req.payload,
    )
    s.nextSeq = seq + 1
    s.bufferedBytes += bytes
    s.unsealedBytes += bytes
    s.oldestUnsealedAt ??= now
    this.totalBytes += bytes
    if (metered && req.seriesIds) {
      metered.w.add(req.seriesIds, req.seriesLimit ?? 0)
      metered.dirtySince ??= now
    }

    if (s.unsealedBytes >= this.cfg.sealBytes && this.sealStream(req.tenant, s)) await this.deliver()
    await this.arm()
    // Returning here is the acknowledgement. The runtime holds the response until the
    // writes above are durable, so an acknowledged batch survives a crash.
    return { status: 'ok', incarnation: s.incarnation, seq, duplicate: false }
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
    const s = this.streams.get(tenant)
    const seg = s ? this.sealStream(tenant, s) : null
    if (seg) {
      await this.deliver()
      await this.arm()
    }
    return seg
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
        await this.announce({ tenant, shard: name })
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
    return this.ctx.storage.sql.exec(`SELECT 1 AS x FROM segment WHERE recorded_at IS NULL LIMIT 1`).toArray().length > 0
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
    const sql = this.ctx.storage.sql
    const out: PendingTenant[] = []
    const cutoff = Date.now() - olderThanMs
    for (const tenant of this.streams.keys()) {
      const r = sql.exec(`SELECT COUNT(*) AS n, MIN(sealed_at) AS oldest FROM segment WHERE tenant = ? AND recorded_at IS NULL`, tenant).one()
      if ((r.n as number) > 0 && (r.oldest as number) <= cutoff) out.push({ tenant, segments: r.n as number, oldestSealedAt: r.oldest as number })
    }
    if (this.marked && this.env.CONFIG && !this.anyPending()) {
      const key = pendingMarkerKey(this.ctx.id.name ?? '')
      // `marked` stays true during the delete, so a seal that happens meanwhile does not
      // race a put against it; it is noticed below and the marker is written again.
      await this.env.CONFIG.delete(key)
      if (this.anyPending()) await this.env.CONFIG.put(key, JSON.stringify({ since: Date.now() }))
      else this.setMarked(false)
    }
    return out
  }

  /** Sealed segments of one tenant that its ledger has not yet recorded. */
  async pendingSegments(tenant: string): Promise<Segment[]> {
    const s = this.streams.get(tenant)
    if (!s) return []
    return this.ctx.storage.sql
      .exec(`SELECT seq_lo, seq_hi, bytes, rows FROM segment WHERE tenant = ? AND recorded_at IS NULL ORDER BY seq_lo`, tenant)
      .toArray()
      .map((r) => ({ tenant, incarnation: s.incarnation, seqLo: r.seq_lo as number, seqHi: r.seq_hi as number, bytes: r.bytes as number, rows: r.rows as number }))
  }

  /** Payloads of one sealed segment, for the flush Worker. */
  async readSegment(tenant: string, seqLo: number): Promise<TailBatch[] | null> {
    const sql = this.ctx.storage.sql
    const seg = sql.exec(`SELECT seq_hi FROM segment WHERE tenant = ? AND seq_lo = ?`, tenant, seqLo).toArray()[0]
    if (!seg) return null
    return this.batches(tenant, seqLo, seg.seq_hi as number)
  }

  private batches(tenant: string, lo: number, hi: number): TailBatch[] {
    return this.ctx.storage.sql
      .exec(`SELECT seq, rows, payload FROM batch WHERE tenant = ? AND seq BETWEEN ? AND ? AND payload IS NOT NULL ORDER BY seq`, tenant, lo, hi)
      .toArray()
      .map((r) => ({ seq: r.seq as number, rows: r.rows as number, payload: new Uint8Array(r.payload as ArrayBuffer) }))
  }

  /**
   * The ledger has admitted every file of segments up to `throughSeq`. Must extend the
   * recorded prefix exactly at a segment boundary; anything else is refused unchanged.
   */
  async recorded(tenant: string, incarnation: number, throughSeq: number): Promise<RecordedResult> {
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
   */
  async tailRead(tenant: string, incarnation: number, aboveSeq: number): Promise<TailResult> {
    const s = this.streams.get(tenant)
    if (!s) return { status: 'ok', incarnation, through: aboveSeq, batches: [] }
    if (s.incarnation !== incarnation) return { status: 'incarnation_mismatch', incarnation: s.incarnation }
    if (aboveSeq < s.discardedThrough) return { status: 'stale_watermark', incarnation, discardedThrough: s.discardedThrough }
    return { status: 'ok', incarnation, through: s.nextSeq - 1, batches: this.batches(tenant, aboveSeq + 1, s.nextSeq - 1) }
  }

  /** Per-stream state, for the ledger, for tests and for operators. */
  async describe(tenant: string): Promise<(Stream & { totalBytes: number }) | null> {
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
    const unsent = sql.exec(`SELECT MIN(due) AS at FROM notify`).one().at as number | null
    if (unsent !== null) due = Math.min(due, unsent)
    if (!this.marked && this.env.CONFIG && this.anyPending()) due = Math.min(due, Date.now() + this.cfg.notifyRetryMs)
    const rec = sql.exec(`SELECT MIN(s.recorded_at) AS at FROM segment s JOIN stream t ON t.tenant = s.tenant WHERE s.recorded_at IS NOT NULL AND s.seq_hi > t.discarded_through`).one().at as number | null
    if (rec !== null) due = Math.min(due, rec + this.cfg.retainRecordedMs)
    const fp = sql.exec(`SELECT MIN(at) AS at FROM batch WHERE payload IS NULL`).one().at as number | null
    if (fp !== null) due = Math.min(due, fp + this.cfg.fingerprintTtlMs)
    const current = await this.ctx.storage.getAlarm()
    if (due === Infinity) {
      if (current !== null) await this.ctx.storage.deleteAlarm()
    } else if (current === null || Math.abs(current - due) > 250) {
      await this.ctx.storage.setAlarm(Math.max(due, Date.now() + 1))
    }
  }

  /** Housekeeping. Idempotent: alarms are at-least-once. */
  async alarm(): Promise<void> {
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
        const freed = sql.exec(`SELECT COALESCE(SUM(bytes), 0) AS b FROM batch WHERE tenant = ? AND seq <= ? AND payload IS NOT NULL`, tenant, hi).one().b as number
        sql.exec(`UPDATE stream SET discarded_through = ? WHERE tenant = ?`, hi, tenant)
        sql.exec(`UPDATE batch SET payload = NULL WHERE tenant = ? AND seq <= ? AND payload IS NOT NULL`, tenant, hi)
        sql.exec(`DELETE FROM segment WHERE tenant = ? AND seq_hi <= ?`, tenant, hi)
        s.discardedThrough = hi
        s.bufferedBytes -= freed
        this.totalBytes -= freed
      }
    }
    // 3. Forget fingerprints of discarded batches once clients can no longer be retrying.
    sql.exec(`DELETE FROM batch WHERE payload IS NULL AND at + ? <= ?`, this.cfg.fingerprintTtlMs, now)
    // 4. Seals made above, and anything a previous attempt could not send.
    await this.deliver()
    await this.arm()
  }
}
