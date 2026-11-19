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
  /**
   * R2 object key (contracts/TABLES.md). Unique. It must lie under
   * `{cell}/data/{table}/tenant={tenant}/day={day}/` for this entry's table and day and the
   * ledger's own tenant and cell: the ledger answers `invalid` otherwise, so the janitor can
   * never be told to delete another tenant's object (design/reviews/write-path-completion.md R-8).
   */
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
 *   - A flush file has `[p, p]` with `p = v × PRECEDENCE_PER_VERSION + i`: `v` is the ledger
 *     version of the `add_unit` that admitted it and `i` its position in the unit (a flush
 *     unit has one file per table and day, so only `v` matters for it; `i` only makes the
 *     order total for any unit the ledger accepts). A stream's units are admitted in
 *     sequence order, so a later write always ranks above an earlier one of the same
 *     stream. Across streams the order is admission order, which the shard-map handover
 *     makes the write order (design/DESIGN.md §4.1: a map change waits for the old shards'
 *     units to be recorded).
 *   - A `replace` output has `[min precedenceLow, max precedence]` over the removed files of
 *     its table and day (`[p, p]` as for a unit if there are none). The ledger admits it only if no other
 *     live file of that table and day whose time range overlaps the output's has a range
 *     that intersects it; otherwise the swap is a `conflict` naming the `blocking` files.
 *
 * So any two live files that could hold the same `(series_id, ts)` (same table, same day,
 * overlapping time ranges) have disjoint ranges and are totally ordered by `precedence`, and
 * every row read or merged has the value of its latest write. (Within one file, the latest
 * row wins: contracts/BATCH.md, contracts/TABLES.md.)
 */
/** Precedence values per ledger version: a unit or a `replace` has at most this many files. */
export const PRECEDENCE_PER_VERSION = 4096

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
  /** The shard's Durable Object name: matches `SHARD_NAME`. */
  shard: string
  incarnation: number
}

/** Tenant ids are `[A-Za-z0-9_-]{1,64}` everywhere: they appear in object keys unescaped. */
export const TENANT_ID = /^[A-Za-z0-9_-]{1,64}$/

/**
 * Shard names (`{pool}/{slot}`, contracts/TABLES.md "Object keys"): segments of
 * `[A-Za-z0-9-]` joined by `/`, at most 128 characters. No `_`, so a flush file's key, which
 * writes the shard name with `/` replaced by `_`, names exactly one stream: `_` there always
 * stands for `/`. The ledger refuses a stream named otherwise (`invalid`).
 */
export const SHARD_NAME = /^(?=.{1,128}$)[A-Za-z0-9-]+(?:\/[A-Za-z0-9-]+)*$/
/** Pool names: as `SHARD_NAME`, at most 120 characters, so `{pool}/{slot}` is a shard name for any slot below 4,096. */
export const POOL_NAME = /^(?=.{1,120}$)[A-Za-z0-9-]+(?:\/[A-Za-z0-9-]+)*$/

/** Everything one sealed segment produced. Admitted atomically or not at all. */
export interface FlushUnit extends StreamRef {
  seqLo: number
  seqHi: number
  files: FileEntry[]
}

export type AddUnitResult =
  /**
   * Admitted, or already admitted earlier (idempotent replay). `watermark` is the COMMITTED
   * watermark: the change may not be in the ledger's R2 log yet (contracts/LEDGER-LOG.md), and a
   * ledger that loses its storage comes back without it. It must never be passed to a shard's
   * `recorded`: only `loggedWatermarks()` may (spec F8).
   */
  | { status: 'ok'; version: number; watermark: number }
  /** `seqLo` is not `watermark + 1` for this stream. Nothing changed. */
  | { status: 'not_contiguous'; watermark: number }
  /** The stream is registered with a different incarnation. Nothing changed. */
  | { status: 'incarnation_mismatch'; incarnation: number }
  /** The unit itself is unacceptable (a key already belongs to another unit, an empty unit). Nothing changed. */
  | { status: 'invalid'; reason: string }
  /**
   * The ledger already holds as much state as it can write as one base or checkpoint and
   * rebuild within one isolate (`stateBytes` of `limitBytes`, estimated; LEDGER-LOG.md "Size").
   * Nothing changed. Retryable: compaction and retention shrink the state; if it persists the
   * tenant needs splitting. Added 2026-11-19 (review S-2); a caller that does not know it
   * fails closed and retries (COMPATIBILITY.md §3.2).
   */
  | { status: 'full'; stateBytes: number; limitBytes: number }

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

/**
 * Retention: remove whole days. Name one `table`, or several in `tables`: then every file of
 * every named table before `beforeDay` leaves the ledger in ONE change, so a samples file and
 * its series file leave together (contracts/TABLES.md, "Pairing"). `tables` was added after
 * `table` (an additive request field, COMPATIBILITY.md §4); a ledger that predates it refuses
 * a request without `table` (unknown table), so a caller never loses an expiry silently.
 */
export type ExpireRequest =
  | {
      table: Table
      /** Remove files whose `day` is strictly before this `YYYY-MM-DD`. */
      beforeDay: string
    }
  | { tables: Table[]; beforeDay: string }

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
  /**
   * The same keys as `removed`, in the same order, each with its table, so a reader need not
   * remember which table a removed key belonged to. Written with every non-empty `removed` by
   * the segment log (contracts/LEDGER-LOG.md); absent in logs written before it. Additive:
   * `removed` keeps its meaning (contracts/COMPATIBILITY.md §4, never repurpose).
   */
  removedFiles?: { key: string; table: Table }[]
  /** For `add_unit` and `register_stream`: the stream's watermark after the change. */
  watermark?: Watermark
  /** For `add_unit`: the sequence range admitted, so a reader can check contiguity. */
  unit?: { seqLo: number; seqHi: number }
  /** For `base`: every stream's watermark. */
  watermarks?: Watermark[]
  /**
   * For `base` (segment log only; optional, ignored by readers that do not need them): what
   * a rebuild needs besides the live set to come back EXACTLY as the ledger was. A stream's
   * previous incarnation (what a retried `registerStream` answers), the tombstones of removed
   * files whose objects may still exist, and the flush unit each file came from.
   */
  previousIncarnations?: { shard: string; previousIncarnation: number }[]
  tombstones?: Tombstone[]
  units?: { key: string; shard: string; incarnation: number; seqLo: number; seqHi: number }[]
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
  /**
   * Highest sequence per stream that is both committed and durably logged to R2, as of the
   * highest version ALL of whose predecessors are in R2 (the contiguous prefix of the log).
   * With the segment log it lags the committed watermark by up to one drain cycle
   * (contracts/LEDGER-LOG.md). The only legitimate source of `Shard.recorded`.
   */
  loggedWatermarks(): Promise<Watermark[]>
}

/** Operator and test surface. Not called on the data path. */
export interface LedgerAdminRpc {
  /** Write pending changes to R2 now (what the alarm does). Idempotent. `written` counts changes. */
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
 * change at first, segments since contracts/LEDGER-LOG.md was built).
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

/*
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * R2 keys and formats of the ledger's own log, relative to the cell prefix. Two layouts
 * exist; each ledger incarnation uses exactly one (contracts/LEDGER-LOG.md):
 *
 *   per-change objects (first layout; read, no longer written)
 *     {incarnation}/base.json                 the `base` change
 *     {incarnation}/{version:012}.json        one change
 *
 *   segments (current; written by the ledger since LEDGER-LOG.md was built)
 *     {incarnation}/seg-{first:012}-{last:012}.jsonl   a header line, then the changes
 *                                                      first..last, one per line; the
 *                                                      incarnation's first segment begins
 *                                                      with its `base`
 *     {incarnation}/ckpt-{version:012}.jsonl           a checkpoint: the whole state at
 *                                                      `version`, for a bounded rebuild
 * ─────────────────────────────────────────────────────────────────────────────────────────
 */

/** First layout: one change. Read by a rebuild and by log readers; not written any more. */
export const ledgerLogKey = (tenant: string, ledgerIncarnation: number, version: number): string =>
  `ledger/tenant=${tenant}/${ledgerIncarnation}/${String(version).padStart(12, '0')}.json`

/**
 * First layout: the `base` entry of an incarnation. It is LOGICALLY first: its `version` is
 * the version the incarnation starts from, and the incarnation's first change is
 * `version + 1`. In a lexicographic key listing it comes AFTER the version objects
 * (`base.json` sorts after digits), so a reader fetches it by this key and does not rely on
 * list order. Read, no longer written.
 */
export const ledgerBaseKey = (tenant: string, ledgerIncarnation: number): string =>
  `ledger/tenant=${tenant}/${ledgerIncarnation}/base.json`

/** Format version of a segment or checkpoint object written by this release (its header's `v`). */
export const LEDGER_SEGMENT_VERSION = 1
/** `LedgerChange` versions a reader of this release applies. A change without `v` is version 1. */
export const LEDGER_CHANGE_VERSION = 1
/** Every `LedgerChange.kind` this release writes and applies. A reader refuses any other. */
export const LEDGER_CHANGE_KINDS: readonly LedgerChange['kind'][] = ['base', 'add_unit', 'replace', 'expire', 'register_stream']
/** A segment holds changes up to this many bytes; a single larger change goes alone. */
export const LEDGER_SEGMENT_MAX_BYTES = 4 * 1024 * 1024

export const LEDGER_SEGMENT_KIND = 'viz.ledger.segment'
export const LEDGER_CHECKPOINT_KIND = 'viz.ledger.checkpoint'

/** The first line of a segment or checkpoint object. Readers ignore fields they do not know. */
export interface LedgerSegmentHeader {
  /** Format version (contracts/COMPATIBILITY.md §3.1). A reader refuses a `v` it does not know. */
  v: number
  kind: typeof LEDGER_SEGMENT_KIND | typeof LEDGER_CHECKPOINT_KIND
  tenant: string
  ledgerIncarnation: number
  /** Versions of the lines that follow, inclusive. For a checkpoint both are its version. */
  firstVersion: number
  lastVersion: number
  /** Number of change lines: `lastVersion - firstVersion + 1`. */
  changes: number
}

const pad12 = (n: number): string => String(n).padStart(12, '0')

/** Everything one ledger incarnation logs is under this prefix. */
export const ledgerIncarnationPrefix = (tenant: string, ledgerIncarnation: number): string => `ledger/tenant=${tenant}/${ledgerIncarnation}/`

export const ledgerSegmentKey = (tenant: string, ledgerIncarnation: number, firstVersion: number, lastVersion: number): string =>
  `${ledgerIncarnationPrefix(tenant, ledgerIncarnation)}seg-${pad12(firstVersion)}-${pad12(lastVersion)}.jsonl`

export const ledgerCheckpointKey = (tenant: string, ledgerIncarnation: number, version: number): string =>
  `${ledgerIncarnationPrefix(tenant, ledgerIncarnation)}ckpt-${pad12(version)}.jsonl`

/**
 * `startAfter` for an R2 listing of an incarnation's segments that START after `version`:
 * every `seg-{first}-…` with `first > version`, and nothing before. (`~` sorts after the
 * digits.) A reader whose cursor sits inside a segment does not find that segment this way;
 * see contracts/LEDGER-LOG.md, "Readers".
 */
export const ledgerSegmentsStartingAfter = (tenant: string, ledgerIncarnation: number, version: number): string =>
  `${ledgerIncarnationPrefix(tenant, ledgerIncarnation)}seg-${pad12(version)}-~`

export type LedgerLogObject =
  | { type: 'segment'; ledgerIncarnation: number; firstVersion: number; lastVersion: number }
  | { type: 'checkpoint'; ledgerIncarnation: number; version: number }
  | { type: 'base'; ledgerIncarnation: number }
  | { type: 'change'; ledgerIncarnation: number; version: number }

/** What an object of a ledger log is, from its key (full or cell-relative), or null if it is none. */
export function parseLedgerLogKey(key: string): LedgerLogObject | null {
  let m = /\/(\d+)\/seg-(\d{12,})-(\d{12,})\.jsonl$/.exec(key)
  if (m) return { type: 'segment', ledgerIncarnation: Number(m[1]), firstVersion: Number(m[2]), lastVersion: Number(m[3]) }
  m = /\/(\d+)\/ckpt-(\d{12,})\.jsonl$/.exec(key)
  if (m) return { type: 'checkpoint', ledgerIncarnation: Number(m[1]), version: Number(m[2]) }
  m = /\/(\d+)\/base\.json$/.exec(key)
  if (m) return { type: 'base', ledgerIncarnation: Number(m[1]) }
  m = /\/(\d+)\/(\d{12,})\.json$/.exec(key)
  if (m) return { type: 'change', ledgerIncarnation: Number(m[1]), version: Number(m[2]) }
  return null
}

/**
 * The body of a segment (or, with `kind` = checkpoint, a checkpoint): a header line, then
 * each change's JSON on its own line, each line ending in `\n`. Changes are given as the
 * exact JSON the ledger committed, so the same changes always give the same bytes (a retried
 * write must be byte-identical; contracts/LEDGER-LOG.md, "Drain").
 */
export function encodeLedgerSegment(
  tenant: string,
  ledgerIncarnation: number,
  lines: readonly { version: number; json: string }[],
  kind: LedgerSegmentHeader['kind'] = LEDGER_SEGMENT_KIND,
): string {
  if (lines.length === 0) throw new Error('ledger segment: no changes')
  const firstVersion = lines[0]!.version
  lines.forEach((l, i) => {
    if (l.version !== firstVersion + i) throw new Error(`ledger segment: versions are not contiguous at ${firstVersion + i}`)
    if (l.json.includes('\n')) throw new Error('ledger segment: a change spans lines')
  })
  if (kind === LEDGER_CHECKPOINT_KIND && lines.length !== 1) throw new Error('ledger checkpoint: exactly one line')
  // Field order is fixed by this literal: the header is part of the bytes a retry must repeat.
  const header: LedgerSegmentHeader = {
    v: LEDGER_SEGMENT_VERSION,
    kind,
    tenant,
    ledgerIncarnation,
    firstVersion,
    lastVersion: firstVersion + lines.length - 1,
    changes: lines.length,
  }
  return `${JSON.stringify(header)}\n${lines.map((l) => `${l.json}\n`).join('')}`
}

export type DecodedLedgerSegment =
  | { status: 'ok'; header: LedgerSegmentHeader; changes: LedgerChange[] }
  /** Written by a newer release (a segment `v`, change `v` or change kind this code does not know). Stop before it; never skip it. */
  | { status: 'unsupported'; reason: string }
  /** Not what its key or header says, or not a segment at all. Stop and report. */
  | { status: 'corrupt'; reason: string }

/** Why this code may not apply a change (contracts/COMPATIBILITY.md §3.2), or null. */
export function unsupportedLedgerChange(c: { v?: unknown; kind?: unknown }): string | null {
  const v = c.v === undefined ? 1 : c.v
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1) return `unreadable change version ${JSON.stringify(c.v)}`
  if (v > LEDGER_CHANGE_VERSION) return `change version ${v}; this code reads up to ${LEDGER_CHANGE_VERSION}`
  if (typeof c.kind !== 'string' || !(LEDGER_CHANGE_KINDS as readonly string[]).includes(c.kind)) return `unknown change kind ${JSON.stringify(c.kind)}`
  return null
}

/**
 * Parse and check a segment or checkpoint object. `expected` is what its key says (from
 * `parseLedgerLogKey`) and, optionally, whose log it is; any disagreement is `corrupt`.
 * Strict on structure, tolerant of unknown fields, and refusing (`unsupported`) on unknown
 * versions and kinds.
 */
export function decodeLedgerSegment(
  body: string,
  expected: { ledgerIncarnation: number; firstVersion: number; lastVersion: number; kind?: LedgerSegmentHeader['kind']; tenant?: string },
): DecodedLedgerSegment {
  const corrupt = (reason: string): DecodedLedgerSegment => ({ status: 'corrupt', reason })
  const lines = body.split('\n')
  if (lines.length < 3 || lines[lines.length - 1] !== '') return corrupt('not a header line followed by change lines, each ending in a newline')
  let header: LedgerSegmentHeader
  try {
    header = JSON.parse(lines[0]!) as LedgerSegmentHeader
  } catch {
    return corrupt('the header line is not JSON')
  }
  if (typeof header !== 'object' || header === null) return corrupt('the header line is not an object')
  if (typeof header.v !== 'number' || !Number.isSafeInteger(header.v) || header.v < 1) return corrupt(`unreadable segment version ${JSON.stringify(header.v)}`)
  if (header.v > LEDGER_SEGMENT_VERSION) return { status: 'unsupported', reason: `segment version ${header.v}; this code reads up to ${LEDGER_SEGMENT_VERSION}` }
  if (header.kind !== LEDGER_SEGMENT_KIND && header.kind !== LEDGER_CHECKPOINT_KIND) return { status: 'unsupported', reason: `unknown log object kind ${JSON.stringify(header.kind)}` }
  const kind = expected.kind ?? LEDGER_SEGMENT_KIND
  if (header.kind !== kind) return corrupt(`a ${header.kind} where a ${kind} was expected`)
  if (expected.tenant !== undefined && header.tenant !== expected.tenant) return corrupt(`tenant ${JSON.stringify(header.tenant)}, expected ${expected.tenant}`)
  if (header.ledgerIncarnation !== expected.ledgerIncarnation || header.firstVersion !== expected.firstVersion || header.lastVersion !== expected.lastVersion) {
    return corrupt(`header says ${header.ledgerIncarnation}/${header.firstVersion}-${header.lastVersion}, the key ${expected.ledgerIncarnation}/${expected.firstVersion}-${expected.lastVersion}`)
  }
  const n = header.lastVersion - header.firstVersion + 1
  if (!(n >= 1) || header.changes !== n || lines.length - 2 !== n) return corrupt(`${lines.length - 2} change lines; the header says ${header.changes} for ${n} versions`)
  const changes: LedgerChange[] = []
  for (let i = 0; i < n; i++) {
    let c: LedgerChange & { v?: unknown }
    try {
      c = JSON.parse(lines[i + 1]!) as LedgerChange
    } catch {
      return corrupt(`line ${i + 2} is not JSON`)
    }
    if (typeof c !== 'object' || c === null) return corrupt(`line ${i + 2} is not an object`)
    const why = unsupportedLedgerChange(c)
    if (why) return { status: 'unsupported', reason: `version ${header.firstVersion + i}: ${why}` }
    if (c.ledgerIncarnation !== header.ledgerIncarnation || c.version !== header.firstVersion + i) return corrupt(`line ${i + 2} is ${c.ledgerIncarnation}/${c.version}, expected ${header.ledgerIncarnation}/${header.firstVersion + i}`)
    if (!Array.isArray(c.added) || !Array.isArray(c.removed)) return corrupt(`change ${c.version} has no added/removed lists`)
    if (header.kind === LEDGER_CHECKPOINT_KIND && c.kind !== 'base') return corrupt('a checkpoint holds one base change')
    changes.push(c)
  }
  return { status: 'ok', header, changes }
}
