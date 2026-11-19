import type { EncodedFile, Engine } from '../../contracts/engine'
import { TENANT_ID, type AddUnitResult, type FileEntry, type FlushUnit, type Table } from '../../contracts/ledger'
import type { Ledger } from '../../ledger/src/ledger'
import type { Segment, Shard } from '../../shard/src/shard'
import { dataFileKey, hex } from './keys'

/**
 * Flush: sealed segments of one tenant in one shard become Parquet files that the
 * tenant's ledger lists (design/DESIGN.md §4.3).
 *
 * For each pending segment, in sequence order:
 *
 *   1. shard.readSegment            the segment's batches
 *   2. engine.encodeSegment         one samples file and one series file per UTC day
 *   3. PUT each file, If-None-Match the key contains the content hash (contracts/TABLES.md)
 *   4. ledger.addUnit               ALL files of the segment as ONE unit, admitted atomically
 *   5. ledger.loggedWatermarks      how far the ledger's R2 change log has got
 *   6. shard.recorded(logged)       the shard may discard only what the log holds
 *
 * Nothing here keeps state. Every step is a function of the segment, so the whole thing
 * can run twice at once or stop between any two steps and be run again:
 *
 *   - Encoding is deterministic: the same segment gives the same bytes, hence the same
 *     keys. A second PUT is refused by If-None-Match and accepted as done only if the
 *     object that is there has the same size and SHA-256.
 *   - `addUnit` for a range at or below the ledger's watermark answers `ok` and changes
 *     nothing, so a second report of a segment adds no file.
 *   - The shard is told `recorded` with the ledger's LOGGED watermark, never the merely
 *     committed one: a ledger that loses its storage comes back at the logged watermark,
 *     and whatever is above that must still be in the shard to be flushed again.
 *
 * The caller decides when to run this; see the README for what triggers it in production.
 */

export interface FlushEnv {
  SHARD: DurableObjectNamespace<Shard>
  LEDGER: DurableObjectNamespace<Ledger>
  BUCKET: R2Bucket
  CELL?: string
}

export interface FlushedFile {
  key: string
  table: Table
  day: string
  bytes: number
  rows: number
  /** `created`: this run wrote the object. `exists`: it was already there with the same size and hash. */
  put: 'created' | 'exists'
}

export interface FlushedSegment {
  incarnation: number
  seqLo: number
  seqHi: number
  /** `admitted`: this run's `addUnit` was answered `ok`. `already_admitted`: the ledger's watermark was already at or past it. */
  outcome: 'admitted' | 'already_admitted'
  files: FlushedFile[]
}

export type FlushFailure =
  /** The ledger called the unit unacceptable. Not retryable without a code or data fix. */
  | 'invalid_unit'
  /** An object exists at a file's key with a different size or hash. */
  | 'object_conflict'
  /** Rows between the ledger's watermark and the shard's first pending segment are in neither. */
  | 'gap'
  /** The ledger's watermark falls inside a segment. */
  | 'overlap'
  /** The ledger has a NEWER incarnation of this stream than the shard reports. */
  | 'stale_incarnation'
  /** The ledger still refused the incarnation after it was registered. */
  | 'incarnation_mismatch'
  /** The shard's stream changed incarnation while this run was in progress. */
  | 'shard_incarnation_changed'
  /** The shard refused the recorded mark as not contiguous. */
  | 'shard_not_contiguous'
  /** The shard no longer holds every batch of a segment it lists as pending. */
  | 'segment_incomplete'
  /** The ledger kept answering `not_contiguous` after the pending list was re-read. */
  | 'no_progress'

export interface FlushResult {
  status: 'ok' | 'error'
  tenant: string
  shard: string
  /** Segments handled by this run, in sequence order. */
  segments: FlushedSegment[]
  /** The ledger's logged watermark for this stream when the run ended (0 if none). */
  loggedThrough: number
  /** The shard's recorded mark when the run ended. */
  recordedThrough: number
  /**
   * True if some segment handled here is admitted but not yet recorded in the shard,
   * because the ledger's change log has not caught up. Run again later; nothing is lost.
   */
  awaitingLog: boolean
  /** Sealed segments left for a later run because of `maxSegments`. */
  remaining: number
  /**
   * This run changed something maintenance may care about: it admitted a unit, wrote an
   * object, or saw a segment it handled become recorded. A run that found everything already
   * done (a duplicate delivery) has `changed: false` (review R-11(b)).
   */
  changed: boolean
  /** For `status: 'error'`. */
  reason?: FlushFailure
  detail?: string
}

/** Fault-injection points for tests. A hook that throws stands for a crash at that point. */
export interface FlushHooks {
  afterPut?(segment: Segment, files: FlushedFile[]): void | Promise<void>
  afterAddUnit?(segment: Segment, result: AddUnitResult): void | Promise<void>
  afterRecorded?(segment: Segment): void | Promise<void>
}

export interface FlushOptions {
  /** Stop after this many segments (the rest stay pending). Default 64. */
  maxSegments?: number
  hooks?: FlushHooks
}

const PARQUET = 'application/vnd.apache.parquet'
/** How often the pending list is re-read after the ledger answers `not_contiguous`. */
const MAX_RESTARTS = 2

export class Stop extends Error {
  constructor(
    readonly reason: FlushFailure,
    detail: string,
  ) {
    super(detail)
  }
}

/** Marks "the ledger is behind the segment being reported": re-read both sides and start over. */
class Restart extends Error {}

function sameBytes(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false
  const x = new Uint8Array(a)
  const y = new Uint8Array(b)
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false
  return true
}

/**
 * Write one file under its content-addressed key with `If-None-Match: *`. If an object is
 * already there, it counts as written only when its size and SHA-256 equal this file's.
 * `customMetadata` is written with a new object; an existing one keeps what it has (for a
 * compaction output the key fixes the inputs, so it is the same record).
 */
export async function putFile(bucket: R2Bucket, key: string, bytes: Uint8Array, sha256: ArrayBuffer, customMetadata?: Record<string, string>): Promise<'created' | 'exists'> {
  // `sha256` makes R2 verify the upload and keep the digest with the object.
  const created = await bucket.put(key, bytes, {
    onlyIf: { etagDoesNotMatch: '*' },
    sha256,
    httpMetadata: { contentType: PARQUET },
    ...(customMetadata ? { customMetadata } : {}),
  })
  if (created !== null) return 'created'
  const existing = await bucket.head(key)
  if (existing === null) throw new Error(`flush: ${key} was refused as existing but is not there; run again`)
  if (existing.size !== bytes.byteLength) {
    throw new Stop('object_conflict', `${key} exists with ${existing.size} bytes; this flush produced ${bytes.byteLength}`)
  }
  // Objects this Worker wrote carry their SHA-256. Anything else is read and hashed.
  let stored = existing.checksums.sha256
  if (!stored) {
    const body = await bucket.get(key)
    if (body === null) throw new Error(`flush: ${key} disappeared while it was being compared; run again`)
    stored = await crypto.subtle.digest('SHA-256', await body.arrayBuffer())
  }
  if (!sameBytes(stored, sha256)) throw new Stop('object_conflict', `${key} exists with a different SHA-256`)
  return 'exists'
}

interface Ctx {
  env: FlushEnv
  engine: Engine
  cell: string
  tenant: string
  shardName: string
  shard: DurableObjectStub<Shard>
  ledger: DurableObjectStub<Ledger>
  hooks: FlushHooks
}

/** Steps 1 to 3: read, encode, write. Returns the unit to report and what was written. */
async function writeSegment(c: Ctx, seg: Segment): Promise<{ unit: FlushUnit; files: FlushedFile[] }> {
  const batches = await c.shard.readSegment(c.tenant, seg.seqLo)
  // A pending segment still has every payload: the shard discards only after `recorded`.
  // If it does not (another run recorded it and it has since been discarded), say so.
  const complete =
    batches !== null && batches.length === seg.seqHi - seg.seqLo + 1 && batches.every((b, i) => b.seq === seg.seqLo + i)
  if (!complete) throw new Stop('segment_incomplete', `segment ${seg.seqLo}..${seg.seqHi} is no longer fully held by the shard`)

  const encoded: EncodedFile[] = c.engine.encodeSegment(batches.map((b) => b.payload))
  const entries: FileEntry[] = []
  const puts: Promise<'created' | 'exists'>[] = []
  for (const f of encoded) {
    const digest = await crypto.subtle.digest('SHA-256', f.bytes as Uint8Array<ArrayBuffer>)
    const key = dataFileKey({
      cell: c.cell,
      table: f.table,
      tenant: c.tenant,
      day: f.day,
      level: 0,
      shard: c.shardName,
      incarnation: seg.incarnation,
      seqLo: seg.seqLo,
      seqHi: seg.seqHi,
      sha256Hex: hex(digest),
    })
    // The files of a segment are independent objects: their PUTs go out together (a PUT
    // costs about the same whatever its size), at most six at a time.
    if (puts.length % 6 === 0) await Promise.all(puts)
    puts.push(putFile(c.env.BUCKET, key, f.bytes, digest))
    entries.push({ table: f.table, day: f.day, key, bytes: f.bytes.byteLength, rows: f.rows, minTs: f.minTs, maxTs: f.maxTs, level: 0, index: f.index })
  }
  const how = await Promise.all(puts)
  const written: FlushedFile[] = entries.map((e, i) => ({ key: e.key, table: e.table, day: e.day, bytes: e.bytes, rows: e.rows, put: how[i]! }))
  // One unit per segment, holding every file of it: samples and series become visible together.
  const unit: FlushUnit = { shard: c.shardName, incarnation: seg.incarnation, seqLo: seg.seqLo, seqHi: seg.seqHi, files: entries }
  return { unit, files: written }
}

/** Step 4, with every answer of the ledger handled. Returns how the segment stands. */
async function report(c: Ctx, seg: Segment, unit: FlushUnit): Promise<{ outcome: FlushedSegment['outcome']; result: AddUnitResult }> {
  let result = await c.ledger.addUnit(unit)
  if (result.status === 'incarnation_mismatch') {
    // The ledger knows another incarnation of this stream. A larger number is newer.
    if (result.incarnation > seg.incarnation) {
      throw new Stop('stale_incarnation', `the ledger has incarnation ${result.incarnation} of ${c.shardName}; the shard reported the older ${seg.incarnation}`)
    }
    // The shard was recreated (storage loss): register the new incarnation, then try once more.
    await c.ledger.registerStream({ shard: c.shardName, incarnation: seg.incarnation })
    result = await c.ledger.addUnit(unit)
    if (result.status === 'incarnation_mismatch') {
      throw new Stop('incarnation_mismatch', `the ledger still has incarnation ${result.incarnation} of ${c.shardName} after registering ${seg.incarnation}`)
    }
  }
  switch (result.status) {
    case 'ok':
      return { outcome: 'admitted', result }
    case 'invalid':
      throw new Stop('invalid_unit', result.reason)
    case 'not_contiguous': {
      const w = result.watermark
      // The ledger is already at or past this segment: its rows are in listed files.
      if (w >= seg.seqHi) return { outcome: 'already_admitted', result }
      // The ledger's watermark is inside this segment: no unit of ours can extend it.
      if (w >= seg.seqLo) throw new Stop('overlap', `the ledger's watermark ${w} is inside segment ${seg.seqLo}..${seg.seqHi}`)
      // The ledger is behind (for example it was rebuilt from its log and lost an unlogged
      // unit this run had reported). Re-read the shard's pending list and the ledger's
      // watermark and continue from the segment that extends it.
      throw new Restart()
    }
    default:
      // An answer this code does not know (a newer ledger, `schema_too_new`): fail closed.
      // The exception makes the consumer retry; nothing is taken as admitted.
      throw new Error(`flush: the ledger answered addUnit with ${JSON.stringify((result as { status?: unknown }).status)}; retry`)
  }
}

/** The ledger's committed watermark for this stream, or null if the ledger has not seen the shard. */
async function committedWatermark(c: Ctx): Promise<{ incarnation: number; seq: number } | null> {
  // An empty time range: no files come back, only versions and watermarks.
  const plan = await c.ledger.plan({ table: 'metric_series', minTs: 1, maxTs: 0 })
  const w = plan.watermarks.find((x) => x.shard === c.shardName)
  return w ? { incarnation: w.incarnation, seq: w.seq } : null
}

async function loggedWatermark(c: Ctx, incarnation: number): Promise<number> {
  const w = (await c.ledger.loggedWatermarks()).find((x) => x.shard === c.shardName)
  // A mark of another incarnation says nothing about this stream.
  return w && w.incarnation === incarnation ? w.seq : 0
}

export async function flushTenant(env: FlushEnv, engine: Engine, tenant: string, shardName: string, opts: FlushOptions = {}): Promise<FlushResult> {
  if (!TENANT_ID.test(tenant)) throw new Error('flush: tenant id must match [A-Za-z0-9_-]{1,64}')
  if (typeof shardName !== 'string' || shardName === '') throw new Error('flush: shard name must be a non-empty string')
  const c: Ctx = {
    env,
    engine,
    cell: env.CELL || 'cell-0',
    tenant,
    shardName,
    shard: env.SHARD.get(env.SHARD.idFromName(shardName)),
    ledger: env.LEDGER.get(env.LEDGER.idFromName(tenant)),
    hooks: opts.hooks ?? {},
  }
  const maxSegments = opts.maxSegments ?? 64
  const handled = new Map<number, FlushedSegment>()
  const out: FlushResult = { status: 'ok', tenant, shard: shardName, segments: [], loggedThrough: 0, recordedThrough: 0, awaitingLog: false, remaining: 0, changed: false }
  let incarnation: number | null = null

  try {
    for (let restarts = 0; ; restarts++) {
      try {
        const pending = await c.shard.pendingSegments(tenant)
        out.remaining = 0
        if (pending.length === 0) break
        if (incarnation !== null && pending[0]!.incarnation !== incarnation) {
          throw new Stop('shard_incarnation_changed', `stream ${shardName} changed incarnation during the run`)
        }
        incarnation = pending[0]!.incarnation
        const committed = await committedWatermark(c)

        // The first segment the ledger does not have must start right after its watermark.
        // (A ledger that knows an older incarnation, or none, starts this one at 1.)
        const next = committed && committed.incarnation === incarnation ? committed.seq + 1 : 1
        const first = pending.find((seg) => seg.seqHi >= next)
        if (first && first.seqLo > next && !(committed && committed.incarnation > incarnation)) {
          throw new Stop('gap', `the ledger's next sequence for ${shardName} is ${next}, the shard's first pending segment starts at ${first.seqLo}`)
        }

        let n = 0
        for (const seg of pending) {
          if (n++ >= maxSegments) {
            out.remaining = pending.length - maxSegments
            break
          }
          let entry: FlushedSegment
          if (committed && committed.incarnation === seg.incarnation && seg.seqHi <= committed.seq) {
            // Already admitted by an earlier or concurrent run: nothing to encode or write.
            entry = handled.get(seg.seqLo) ?? { incarnation: seg.incarnation, seqLo: seg.seqLo, seqHi: seg.seqHi, outcome: 'already_admitted', files: [] }
          } else {
            const { unit, files } = await writeSegment(c, seg)
            await c.hooks.afterPut?.(seg, files)
            const { outcome, result } = await report(c, seg, unit)
            await c.hooks.afterAddUnit?.(seg, result)
            entry = { incarnation: seg.incarnation, seqLo: seg.seqLo, seqHi: seg.seqHi, outcome, files }
          }
          handled.set(seg.seqLo, entry)

          // Steps 5 and 6. The LOGGED watermark: what survives the loss of the ledger's storage.
          const logged = await loggedWatermark(c, seg.incarnation)
          if (logged > 0) {
            const r = await c.shard.recorded(tenant, seg.incarnation, logged)
            if (r.status === 'incarnation_mismatch') throw new Stop('shard_incarnation_changed', `stream ${shardName} is now incarnation ${r.incarnation}`)
            if (r.status === 'not_contiguous') {
              throw new Stop('shard_not_contiguous', `the shard refused recorded(${logged}); it has recorded through ${r.recordedThrough}`)
            }
            // Fail closed on an answer this code does not know: never take it for "recorded".
            if (r.status !== 'ok') throw new Error(`flush: the shard answered recorded with ${JSON.stringify((r as { status?: unknown }).status)}; retry`)
          }
          await c.hooks.afterRecorded?.(seg)
        }
        break
      } catch (e) {
        if (!(e instanceof Restart)) throw e
        if (restarts >= MAX_RESTARTS) throw new Stop('no_progress', 'the ledger kept answering not_contiguous after the pending list was re-read')
        // A segment the ledger no longer has is not "handled": it will be reported again.
        handled.clear()
      }
    }
  } catch (e) {
    if (!(e instanceof Stop)) throw e
    out.status = 'error'
    out.reason = e.reason
    out.detail = e.message
  }

  out.segments = [...handled.values()].sort((a, b) => a.seqLo - b.seqLo)
  const state = await c.shard.describe(tenant)
  out.recordedThrough = state?.recordedThrough ?? 0
  if (state) out.loggedThrough = await loggedWatermark(c, state.incarnation)
  out.awaitingLog = out.segments.some((s) => s.incarnation === state?.incarnation && s.seqHi > out.recordedThrough)
  // Every segment handled here was pending (unrecorded) when this run read the list; one that
  // is recorded now became so during the run.
  out.changed = out.segments.some(
    (s) => s.outcome === 'admitted' || s.files.some((f) => f.put === 'created') || (s.incarnation === state?.incarnation && s.seqHi <= out.recordedThrough),
  )
  return out
}
