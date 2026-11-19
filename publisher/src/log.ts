/**
 * Reading a tenant's ledger change log from R2 (contracts/LEDGER-LOG.md; keys and the segment
 * codec are in contracts/ledger.ts). The log is the publisher's only input and its whole
 * backlog.
 *
 * Each ledger incarnation uses exactly one of two layouts:
 *
 *   segments   {inc}/seg-{first:012}-{last:012}.jsonl: a header line, then the changes
 *              first..last, one per line. The incarnation's first segment begins with its
 *              `base`. What the ledger writes since LEDGER-LOG.md was built. Checkpoints
 *              ({inc}/ckpt-{version}.jsonl: format 1, one object; format 2, a manifest naming
 *              parts under ckpt-{version}-{attempt}/) hold the state at their version; a re-base
 *              starts from the newest one this code reads, else from the base.
 *   objects    {inc}/base.json and {inc}/{version:012}.json, one object per change: the first
 *              layout. Still read, because a deployment that ran the trial stage may hold
 *              incarnations in it (LEDGER-LOG.md "Versions", COMPATIBILITY.md §3.6 step 3).
 *
 * Two readers, kept separate on purpose:
 *
 *   readTenantLog   what `publish` uses: the changes after a cursor, in version order, up to
 *                   the first hole or the first object this code may not read. With segments
 *                   it advances over whole segments only. A re-base (no cursor in the newest
 *                   incarnation) streams the state it starts from into a `BaseSink` (the
 *                   publisher's SQLite), a part or a few hundred files at a time: nothing here
 *                   holds a state, whatever its size.
 *   replayAt        what `verify` uses: the ledger's whole live set at a cursor, rebuilt from
 *                   the incarnation's base with every change checked against the state before it.
 *                   It holds that set in memory (README, "Not implemented").
 *
 * Tables. Every table the ledger lists (`LedgerTable`) is known here and published
 * (`PUBLISHED_TABLES`): the metric pair, and since design/DECISIONS.md D65 the span and log tables.
 * A re-base stages the files of every table.
 *
 * Refuse, never guess (contracts/COMPATIBILITY.md §3.2): a segment header `v` or `kind`, a change
 * `v` or `kind`, or a file table this code does not know stops the tenant BEFORE that segment
 * (status `unsupported`); a hole stops it before the hole (`gap`); an object that is not what its
 * key says stops it before that object (`corrupt`); a checkpoint part its manifest names that is
 * not there stops it (`incomplete`). Nothing after a stop is ever returned, so it can never be
 * skipped; the publisher keeps the tenant pending and tries again. A re-base that stops returns no
 * base, so nothing of what it read is published.
 */
import {
  checkpointHeaderProblem,
  decodeLedgerCheckpointManifest,
  decodeLedgerCheckpointPart,
  decodeLedgerSegment,
  ledgerBaseKey,
  ledgerCheckpointPartKey,
  ledgerIncarnationPrefix,
  ledgerLogKey,
  ledgerSegmentsStartingAfter,
  parseLedgerLogKey,
  readLedgerLogStream,
  type FileEntry,
  type LedgerChange,
  type LedgerSegmentHeader,
  type LedgerTable,
  type SignalTable,
  type Table,
} from '../../contracts/ledger'

export interface Cursor {
  ledgerIncarnation: number
  version: number
}

export const cursorCompare = (a: Cursor, b: Cursor): number => a.ledgerIncarnation - b.ledgerIncarnation || a.version - b.version

/** What the publisher reads of an R2 object. `R2ObjectBody` is one. */
export interface StoreObject {
  readonly key: string
  readonly size: number
  readonly body: ReadableStream<Uint8Array>
  text(): Promise<string>
  json<T>(): Promise<T>
  arrayBuffer(): Promise<ArrayBuffer>
}

/** The parts of R2 the publisher uses. `CountingBucket` implements it (and `R2Bucket` is one). */
export interface Store {
  get(key: string): Promise<StoreObject | null>
  head(key: string): Promise<R2Object | null>
  list(options: R2ListOptions): Promise<R2Objects>
  put(key: string, value: string | Uint8Array, options?: R2PutOptions): Promise<R2Object | null>
  delete(keys: string | string[]): Promise<void>
}

/**
 * Outbound connections one Durable Object invocation may have in flight (AGENTS.md: six, R2
 * binding reads included). Every R2 operation of a publish, a sweep or a verify takes a slot of
 * one shared `Slots`, and a GET keeps its slot until its body has been read, so the readers of
 * every tenant, the parts read ahead and the commit's writes together never exceed it.
 */
export const R2_CONNECTIONS = 6

/** A counting semaphore: `take` waits for a free slot and returns its release (idempotent). */
export class Slots {
  private free: number
  private readonly waiting: (() => void)[] = []
  /** Slots held now, and the most ever held at once. */
  held = 0
  highWater = 0
  constructor(readonly size: number) {
    this.free = size
  }
  async take(): Promise<() => void> {
    if (this.free > 0) this.free--
    else await new Promise<void>((resolve) => this.waiting.push(resolve))
    this.held++
    this.highWater = Math.max(this.highWater, this.held)
    let released = false
    return () => {
      if (released) return
      released = true
      this.held--
      const next = this.waiting.shift()
      if (next) next()
      else this.free++
    }
  }
}

/**
 * The object `o` with `release` called once its body has been read (or failed, or was
 * cancelled): the slot of a GET is held for as long as its connection is.
 */
export function holding(o: StoreObject, release: () => void): StoreObject {
  const after = async <T>(read: () => Promise<T>): Promise<T> => {
    try {
      return await read()
    } finally {
      release()
    }
  }
  let body: ReadableStream<Uint8Array> | null = null
  return {
    key: o.key,
    size: o.size,
    text: () => after(() => o.text()),
    json: <T>() => after(() => o.json<T>()),
    arrayBuffer: () => after(() => o.arrayBuffer()),
    get body() {
      if (body) return body
      const reader = o.body.getReader()
      body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const { done, value } = await reader.read()
            if (done) {
              release()
              controller.close()
            } else controller.enqueue(value)
          } catch (e) {
            release()
            controller.error(e)
          }
        },
        cancel(reason) {
          release()
          return reader.cancel(reason)
        },
      })
      return body
    },
  }
}

export type LogStatus =
  /** Everything after the cursor was read. */
  | 'ok'
  /** A version is missing; `changes` stops before it and `gapAt` names it. */
  | 'gap'
  /** More changes exist than one publish reads; `changes` is a contiguous prefix. */
  | 'more'
  /** The tenant has no ledger log in R2. */
  | 'no_log'
  /** The newest incarnation has log objects but no base to start from. */
  | 'no_base'
  /** The cursor names an incarnation newer than anything in R2. */
  | 'cursor_ahead'
  /** An object does not say what its key says, is not a change, or holds both layouts. */
  | 'corrupt'
  /**
   * A segment or change of a version (`v`), kind or table this code does not know, written by
   * a newer ledger (contracts/COMPATIBILITY.md §3.2). `changes` stops before the object that
   * holds it, and `gapAt` names that object's first version; it is never skipped. The tenant
   * waits for a publisher that reads it.
   */
  | 'unsupported'
  /**
   * A re-base found a checkpoint whose manifest names a part that is not in R2: deleted while it
   * was being read (the ledger deletes a checkpoint's parts once a newer one is complete), or
   * lost. Nothing read from it is used (`base` is null); the tenant stays pending, and the next
   * publish lists the checkpoints again.
   */
  | 'incomplete'

/** A removed key with its table: from `LedgerChange.removedFiles`, or from the key layout for logs written before it (null if the key does not follow it). */
export interface RemovedFile {
  key: string
  table: LedgerTable | null
}

/** A change as this reader hands it on: checked, with `removedFiles` always present. */
export type LogChange = Omit<LedgerChange, 'removedFiles'> & { removedFiles: RemovedFile[] }

export interface TenantLog {
  tenant: string
  status: LogStatus
  detail?: string
  /** Newest ledger incarnation in R2. */
  incarnation: number
  /** The layout of that incarnation, once known. */
  layout: 'segments' | 'objects' | null
  /**
   * Set when the reader started from the state an incarnation holds at some version (no cursor,
   * or one in an older incarnation): its base, or its newest checkpoint. Its files and tombstones
   * are in the `BaseSink`; null whenever that read did not complete, so a partial one is never used.
   */
  base: BaseInfo | null
  /** The version `changes` starts after. */
  start: number
  /** Contiguous: `changes[i].version === start + 1 + i`. */
  changes: LogChange[]
  gapAt?: number
}

/**
 * Where a re-base puts the state it reads: the publisher's SQLite (`stage`), never memory. Calls
 * come in batches of at most a part (or `BASE_BATCH` files of a base); each is one transaction.
 */
export interface BaseSink {
  /** Forget whatever an earlier read left for this tenant. */
  reset(tenant: string): void
  /** Live files at the base's version. Throws if a key repeats. */
  files(tenant: string, files: FileEntry[]): void
  /**
   * Removed files whose objects may still exist (tombstones), removed at or below that version:
   * of every table this code knows, published or not.
   */
  tombstones(tenant: string, tombstones: { key: string; table: LedgerTable }[]): void
  /**
   * Waits for this tenant's turn to read a checkpoint or base, and returns its release. The
   * publisher gives one turn at a time, so tenants re-basing in the same publish hold one window
   * of parts between them, not one each. Absent: no turns.
   */
  turn?(): Promise<() => void>
}

/** What a re-base started from. Its files are in the `BaseSink`, not here. */
export interface BaseInfo {
  /** The ledger version of that state. */
  version: number
  /** The head of the incarnation's first segment, or a checkpoint. */
  source: 'base' | 'checkpoint'
  /** For a checkpoint: format 1 (one object) or 2 (a manifest and parts). */
  format: 1 | 2 | null
  /** Live files it holds, of every table. */
  files: number
  tombstones: number
  /** Log objects read for it: 1, or a manifest and its parts. */
  objects: number
  /** The most checkpoint parts requested and not yet applied at any moment (at most `PART_WINDOW`). */
  window: number
  /** Checkpoints passed over because this code does not read their format, newest first. */
  passedOver: string[]
}

// ───────────────────────────── the tables this code knows ─────────────────────────────
//
// Pinned here, not taken from contracts/ledger.ts `TABLES`, like the versions below: a table the
// contract adds stays unknown to this reader (and stops a tenant whose log names it) until this
// reader is taught it; `test/signals.test.ts` fails until then (readers first, §3.3).

/**
 * Tables this publisher publishes as Iceberg tables: every table the ledger lists. The metric pair
 * since the first release; the span and log tables since design/DECISIONS.md D65 (the release
 * before, D64, read them and did not publish them).
 */
export const PUBLISHED_TABLES: readonly LedgerTable[] = ['metric_samples', 'metric_series', 'spans', 'trace_index', 'logs']
/** Tables the ledger lists that this publisher reads and does not publish: none since D65 (D64 had the span and log tables here). */
export const UNPUBLISHED_TABLES: readonly SignalTable[] = []
const PUBLISHED: ReadonlySet<string> = new Set<string>(PUBLISHED_TABLES)
/** Every table a ledger file may belong to, as far as this publisher knows. A file of any other table stops the tenant (`unsupported`). */
const TABLES: ReadonlySet<string> = new Set<string>([...PUBLISHED_TABLES, ...UNPUBLISHED_TABLES])
/** Whether this publisher publishes `table`. */
export const isPublished = (table: string): table is LedgerTable => PUBLISHED.has(table)
const CHANGE_OBJECT = /\/(\d{12,})\.json$/
/** `{cell}/data/{table}/…` (contracts/TABLES.md): the table of a removed key in a log written before `removedFiles`. */
const KEY_TABLE = /^[^/]+\/data\/([^/]+)\//
const READ_FANOUT = 6
/**
 * Checkpoint parts requested ahead of, or held with, the one being applied. A part is at most
 * about 1 MiB (`LEDGER_CHECKPOINT_PART_MAX_BYTES`; a single larger record goes alone), so a
 * re-base holds a few MiB of it whatever the state. The reads also take slots of the shared
 * `Slots`, so they never add to what else is in flight beyond `R2_CONNECTIONS`.
 */
export const PART_WINDOW = 4
/** Files of a base (or a format-1 checkpoint) handed to the sink per transaction. */
export const BASE_BATCH = 256

// ───────────────────────────── what this code reads ─────────────────────────────
//
// Pinned here, not taken from contracts/ledger.ts: they say what THIS publisher knows how to
// apply. When the contract's numbers move, `test/compat.test.ts` fails until this reader is
// taught the new version and these are raised with it (readers first, COMPATIBILITY.md §3.3).

/** Segment and checkpoint header versions (`v`) this publisher reads. */
export const LEDGER_SEGMENT_VERSION = 1
/** The segment header kind this publisher reads. */
const SEGMENT_KIND = 'viz.ledger.segment'
/**
 * Checkpoint formats this publisher reads (header `v` of `ckpt-{version}.jsonl`): 1, one object;
 * 2, a manifest and parts (contracts/LEDGER-LOG.md, "Checkpoints"). A checkpoint of a higher
 * format is passed over for an older one or the base, as the ledger's rebuild does: a checkpoint
 * is only a shortcut, so nothing is skipped and no reader has to be released first.
 */
export const LEDGER_CHECKPOINT_VERSION = 2
/** The `LedgerChange` versions this code reads (absent `v` = 1) and the kinds it knows how to apply. */
export const LEDGER_CHANGE_VERSION = 1
const KINDS: ReadonlySet<string> = new Set<LedgerChange['kind']>(['base', 'add_unit', 'replace', 'expire', 'register_stream'])

/** Why this code may not apply `c`, or null (contracts/COMPATIBILITY.md §3.2: refuse, never guess). */
export function unsupported(c: { v?: unknown; kind?: unknown }): string | null {
  const v = c.v === undefined ? 1 : c.v
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1) return `unreadable change version ${JSON.stringify(c.v)}`
  if (v > LEDGER_CHANGE_VERSION) return `change version ${v}; this publisher reads up to ${LEDGER_CHANGE_VERSION}`
  if (typeof c.kind !== 'string' || !KINDS.has(c.kind)) return `unknown change kind ${JSON.stringify(c.kind)}`
  return null
}

/** Why this code may not read a segment with this header, or null. */
export function unsupportedSegment(h: { v?: unknown; kind?: unknown }): string | null {
  if (typeof h.v !== 'number' || !Number.isSafeInteger(h.v) || h.v < 1) return `unreadable segment version ${JSON.stringify(h.v)}`
  if (h.v > LEDGER_SEGMENT_VERSION) return `segment version ${h.v}; this publisher reads up to ${LEDGER_SEGMENT_VERSION}`
  if (h.kind !== SEGMENT_KIND) return `unknown log object kind ${JSON.stringify(h.kind)}`
  return null
}

type Checked = { ok: LogChange } | { unsupported: string } | { corrupt: string }

/**
 * Check one change and give it `removedFiles`. `removedFiles`, when present, must name the keys
 * of `removed` in the same order, each with a table; when absent (logs written before it) the
 * table comes from the key layout. A file of a table this code does not know is refused.
 */
function check(c: LedgerChange): Checked {
  const why = unsupported(c)
  if (why) return { unsupported: why }
  if (!Array.isArray(c.added) || !Array.isArray(c.removed)) return { corrupt: `change ${c.version} has no added/removed lists` }
  for (const f of c.added) {
    if (typeof f !== 'object' || f === null || typeof f.key !== 'string') return { corrupt: `change ${c.version} adds a malformed file` }
    if (!TABLES.has(f.table)) return { unsupported: `change ${c.version} adds a file of table ${JSON.stringify(f.table)}, which this publisher does not know` }
  }
  if (c.removed.some((k) => typeof k !== 'string')) return { corrupt: `change ${c.version} removes something that is not a key` }
  let removedFiles: RemovedFile[]
  if (c.removedFiles === undefined) {
    removedFiles = c.removed.map((key) => {
      const t = KEY_TABLE.exec(key)?.[1]
      return { key, table: t !== undefined && TABLES.has(t) ? (t as LedgerTable) : null }
    })
  } else {
    if (!Array.isArray(c.removedFiles) || c.removedFiles.length !== c.removed.length) return { corrupt: `change ${c.version}: removedFiles does not list the keys of removed` }
    removedFiles = []
    for (const [i, r] of c.removedFiles.entries()) {
      if (typeof r !== 'object' || r === null || r.key !== c.removed[i]) return { corrupt: `change ${c.version}: removedFiles[${i}] is not removed[${i}]` }
      if (!TABLES.has(r.table)) return { unsupported: `change ${c.version} removes a file of table ${JSON.stringify(r.table)}, which this publisher does not know` }
      removedFiles.push({ key: r.key, table: r.table })
    }
  }
  return { ok: { ...c, removedFiles } }
}

class Unsupported {
  constructor(readonly why: string) {}
}

export async function inBatches<T, R>(items: readonly T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))))
  return out
}

const tenantPrefix = (cell: string, tenant: string) => `${cell}/ledger/tenant=${tenant}/`

async function latestIncarnation(store: Store, cell: string, tenant: string): Promise<number | null> {
  const prefix = tenantPrefix(cell, tenant)
  let latest: number | null = null
  let cursor: string | undefined
  do {
    const page = await store.list({ prefix, delimiter: '/', cursor })
    for (const p of page.delimitedPrefixes) {
      const name = p.slice(prefix.length, -1)
      if (/^\d+$/.test(name)) latest = Math.max(latest ?? 0, Number(name))
    }
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
  return latest
}

// ───────────────────────────── segments ─────────────────────────────

interface SegmentRef {
  key: string
  first: number
  last: number
}

/**
 * An incarnation's segments in version order, listed page by page from `startAfter` (a full
 * key) or from the first one, until `enough` says so or the listing ends. Keys are zero-padded
 * to 12 digits, so key order is version order (the contract's `ledgerSegmentsStartingAfter`
 * relies on the same); each page is still sorted by number.
 */
async function listSegments(
  store: Store,
  cell: string,
  tenant: string,
  incarnation: number,
  startAfter: string | undefined,
  enough: (segs: SegmentRef[]) => boolean,
): Promise<{ segs: SegmentRef[]; complete: boolean }> {
  const prefix = `${cell}/${ledgerIncarnationPrefix(tenant, incarnation)}seg-`
  const segs: SegmentRef[] = []
  let cursor: string | undefined
  for (;;) {
    const page = await store.list(cursor ? { prefix, cursor } : { prefix, startAfter })
    const found: SegmentRef[] = []
    for (const o of page.objects) {
      const p = parseLedgerLogKey(o.key)
      if (p?.type === 'segment' && p.ledgerIncarnation === incarnation) found.push({ key: o.key, first: p.firstVersion, last: p.lastVersion })
    }
    segs.push(...found.sort((a, b) => a.first - b.first || a.last - b.last))
    if (!page.truncated) return { segs, complete: true }
    if (enough(segs)) return { segs, complete: false }
    cursor = page.cursor
  }
}

type SegmentRead = { status: 'ok'; changes: LogChange[] } | { status: 'unsupported' | 'corrupt'; reason: string }

/** Read one segment and check it against its key, its tenant and what this code reads. */
async function readSegment(store: Store, tenant: string, incarnation: number, seg: SegmentRef): Promise<SegmentRead> {
  const o = await store.get(seg.key)
  if (!o) return { status: 'corrupt', reason: `segment ${seg.first}-${seg.last} of incarnation ${incarnation} was listed and is gone` }
  const d = decodeLedgerSegment(await o.text(), { ledgerIncarnation: incarnation, firstVersion: seg.first, lastVersion: seg.last, tenant })
  if (d.status !== 'ok') return { status: d.status, reason: `segment ${seg.first}-${seg.last} of incarnation ${incarnation}: ${d.reason}` }
  // The codec accepts what the CONTRACT knows; this publisher applies only what it knows.
  const why = unsupportedSegment(d.header)
  if (why) return { status: 'unsupported', reason: `segment ${seg.first}-${seg.last} of incarnation ${incarnation}: ${why}` }
  const changes: LogChange[] = []
  for (const c of d.changes) {
    const r = check(c)
    if ('unsupported' in r) return { status: 'unsupported', reason: `segment ${seg.first}-${seg.last} of incarnation ${incarnation}: version ${c.version}: ${r.unsupported}` }
    if ('corrupt' in r) return { status: 'corrupt', reason: `segment ${seg.first}-${seg.last} of incarnation ${incarnation}: ${r.corrupt}` }
    changes.push(r.ok)
  }
  return { status: 'ok', changes }
}

/** "Both present is corrupt" (LEDGER-LOG.md, "Readers"): a segment incarnation must have no `base.json`. */
async function hasObjectBase(store: Store, cell: string, tenant: string, incarnation: number): Promise<boolean> {
  return (await store.head(`${cell}/${ledgerBaseKey(tenant, incarnation)}`)) !== null
}

// ───────────────────────────── re-base: the state an incarnation is at ─────────────────────────────

/** Why reading a base or a checkpoint stops; thrown out of the stream's callbacks and caught below. */
class Stop extends Error {
  constructor(
    readonly status: 'corrupt' | 'unsupported' | 'no_base' | 'incomplete' | 'passed_over',
    why: string,
  ) {
    super(why)
  }
}

/** What a malformed object (bad JSON, UTF-8 or line structure) makes the stream reader throw. Anything else is R2 failing, and propagates. */
const malformed = (e: unknown): e is Error =>
  e instanceof SyntaxError || (e instanceof TypeError && /encod|utf/i.test(e.message)) || (e instanceof Error && /^(json stream|ledger log):/.test(e.message))

/** SQLite's key order (UTF-8 bytes), the order the ledger writes a checkpoint's records in. */
export function compareKeys(a: string, b: string): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    let x = a.charCodeAt(i)
    let y = b.charCodeAt(i)
    if (x === y) continue
    // Surrogates (code points above U+FFFF) come after U+E000–FFFF in UTF-8.
    if (x >= 0xd800 && y >= 0xd800) {
      x = x >= 0xe000 ? x - 0x800 : x + 0x2000
      y = y >= 0xe000 ? y - 0x800 : y + 0x2000
    }
    return x - y
  }
  return a.length - b.length
}

/** A live file of a base or checkpoint, checked as far as the publisher uses it. */
function fileOf(x: unknown, where: string): FileEntry {
  const f = x as FileEntry
  if (typeof f !== 'object' || f === null || typeof f.key !== 'string' || typeof f.day !== 'string' || typeof f.rows !== 'number' || typeof f.bytes !== 'number') {
    throw new Stop('corrupt', `${where}: a malformed file`)
  }
  if (!TABLES.has(f.table)) throw new Stop('unsupported', `${where}: a file of table ${JSON.stringify(f.table)}, which this publisher does not know`)
  return f
}

function tombstoneOf(x: unknown, where: string): { key: string; table: LedgerTable } {
  const t = x as { key?: unknown; table?: unknown }
  if (typeof t !== 'object' || t === null || typeof t.key !== 'string') throw new Stop('corrupt', `${where}: a malformed tombstone`)
  if (typeof t.table !== 'string' || !TABLES.has(t.table)) throw new Stop('unsupported', `${where}: a tombstone of table ${JSON.stringify(t.table)}, which this publisher does not know`)
  return { key: t.key, table: t.table as LedgerTable }
}

/** Files and tombstones on their way to the sink, `BASE_BATCH` per transaction: of every table, since every table is published (D65). */
class Batches {
  private f: FileEntry[] = []
  private t: { key: string; table: LedgerTable }[] = []
  files = 0
  tombstones = 0
  constructor(
    private readonly sink: BaseSink,
    private readonly tenant: string,
  ) {}
  file(f: FileEntry): void {
    this.files++
    this.f.push(f)
    if (this.f.length >= BASE_BATCH) this.flush()
  }
  tombstone(t: { key: string; table: LedgerTable }): void {
    this.t.push(t)
    this.tombstones++
    if (this.t.length >= BASE_BATCH) this.flush()
  }
  flush(): void {
    if (this.f.length > 0) this.sink.files(this.tenant, this.f)
    if (this.t.length > 0) this.sink.tombstones(this.tenant, this.t)
    this.f = []
    this.t = []
  }
}

/** The header line of a segment, checked against its key and its tenant (as `decodeLedgerSegment` does, and against what this code reads). */
function segmentHeader(value: unknown, seg: SegmentRef, tenant: string, incarnation: number, where: string): LedgerSegmentHeader {
  const h = value as LedgerSegmentHeader
  if (typeof h !== 'object' || h === null) throw new Stop('corrupt', `${where}: the header line is not an object`)
  if (typeof h.v !== 'number' || !Number.isSafeInteger(h.v) || h.v < 1) throw new Stop('corrupt', `${where}: unreadable segment version ${JSON.stringify(h.v)}`)
  if (h.kind === 'viz.ledger.checkpoint') throw new Stop('corrupt', `${where}: a checkpoint where a segment was expected`)
  const why = unsupportedSegment(h)
  if (why) throw new Stop('unsupported', `${where}: ${why}`)
  if (h.tenant !== tenant) throw new Stop('corrupt', `${where}: tenant ${JSON.stringify(h.tenant)}, expected ${tenant}`)
  if (h.ledgerIncarnation !== incarnation || h.firstVersion !== seg.first || h.lastVersion !== seg.last || h.changes !== seg.last - seg.first + 1) {
    throw new Stop('corrupt', `${where}: its header says ${h.ledgerIncarnation}/${h.firstVersion}-${h.lastVersion} (${h.changes} lines)`)
  }
  return h
}

type BaseRead = { status: 'ok'; info: BaseInfo; changes: LogChange[] } | { status: 'corrupt' | 'unsupported' | 'no_base'; reason: string }

/**
 * An incarnation's first segment, streamed: its header, its `base` line element by element into
 * the sink (`readLedgerLogStream`), then any changes after it in the same segment. Memory: one
 * file of the base at a time and `BASE_BATCH` on their way to SQLite, whatever the state.
 */
async function readBaseSegment(store: Store, tenant: string, incarnation: number, seg: SegmentRef, sink: BaseSink, passedOver: string[]): Promise<BaseRead> {
  const where = `segment ${seg.first}-${seg.last} of incarnation ${incarnation}`
  const o = await store.get(seg.key)
  if (!o) return { status: 'corrupt', reason: `${where} was listed and is gone` }
  sink.reset(tenant)
  const out = new Batches(sink, tenant)
  let header: LedgerSegmentHeader | null = null
  const changes: LogChange[] = []
  try {
    const { lines, streamed } = await readLedgerLogStream(
      o.body,
      1,
      (member, element) => {
        if (member === 'added') out.file(fileOf(element, where))
        else if (member === 'tombstones') out.tombstone(tombstoneOf(element, where))
        // `removed`, `units`, `watermarks`, `previousIncarnations` and anything newer: not the
        // publisher's. Each element is parsed on its own and dropped.
      },
      (index, value) => {
        if (index === 0) {
          header = segmentHeader(value, seg, tenant, incarnation, where)
          return
        }
        const c = value as LedgerChange
        if (typeof c !== 'object' || c === null) throw new Stop('corrupt', `${where}: line ${index + 1} is not an object`)
        const why = unsupported(c)
        if (why) throw new Stop('unsupported', `${where}: version ${seg.first + index - 1}: ${why}`)
        if (c.ledgerIncarnation !== incarnation || c.version !== seg.first + index - 1) throw new Stop('corrupt', `${where}: line ${index + 1} is ${c.ledgerIncarnation}/${c.version}`)
        if (c.kind === 'base') throw new Stop('corrupt', `version ${c.version} of incarnation ${incarnation} is a base inside the log`)
        const r = check(c)
        if ('unsupported' in r) throw new Stop('unsupported', `${where}: version ${c.version}: ${r.unsupported}`)
        if ('corrupt' in r) throw new Stop('corrupt', `${where}: ${r.corrupt}`)
        changes.push(r.ok)
      },
    )
    out.flush()
    const h = header as LedgerSegmentHeader | null
    if (!h || !streamed || lines !== h.changes + 1) throw new Stop('corrupt', `${where}: ${lines - 1} lines after its header, which says ${h?.changes}`)
    const why = unsupported(streamed)
    if (why) throw new Stop('unsupported', `${where}: version ${seg.first}: ${why}`)
    if (streamed.kind !== 'base' || streamed.version !== seg.first) throw new Stop('no_base', `the first segment of incarnation ${incarnation} does not begin with its base`)
    if (streamed.ledgerIncarnation !== incarnation) throw new Stop('corrupt', `${where}: its base is of incarnation ${String(streamed.ledgerIncarnation)}`)
  } catch (e) {
    if (e instanceof Stop) return { status: e.status as 'corrupt' | 'unsupported' | 'no_base', reason: e.message }
    if (malformed(e)) return { status: 'corrupt', reason: `${where}: ${e.message}` }
    throw e
  }
  return {
    status: 'ok',
    info: { version: seg.first, source: 'base', format: null, files: out.files, tombstones: out.tombstones, objects: 1, window: 0, passedOver },
    changes,
  }
}

type CheckpointRead =
  | { status: 'ok'; info: BaseInfo }
  /** No checkpoint this code reads: start from the base. */
  | { status: 'none'; passedOver: string[] }
  | { status: 'corrupt' | 'unsupported' | 'incomplete'; reason: string }

/**
 * The newest checkpoint of an incarnation that this code reads, into the sink. One list (with a
 * delimiter, so each checkpoint's parts are one prefix, not a key each), then the manifests,
 * newest first: one of a format this code does not read is passed over (the base is always
 * there); one that is corrupt, or names a part that is not there, stops the re-base.
 */
async function readNewestCheckpoint(store: Store, cell: string, tenant: string, incarnation: number, sink: BaseSink): Promise<CheckpointRead> {
  const prefix = `${cell}/${ledgerIncarnationPrefix(tenant, incarnation)}ckpt-`
  const manifests: { key: string; version: number }[] = []
  let cursor: string | undefined
  do {
    const page = await store.list({ prefix, delimiter: '/', cursor })
    for (const o of page.objects) {
      const p = parseLedgerLogKey(o.key)
      if (p?.type === 'checkpoint' && p.ledgerIncarnation === incarnation) manifests.push({ key: o.key, version: p.version })
    }
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
  manifests.sort((a, b) => b.version - a.version)
  const passedOver: string[] = []
  for (const m of manifests) {
    const r = await readCheckpoint(store, cell, tenant, incarnation, m, sink)
    if (r.status === 'passed_over') {
      passedOver.push(r.reason)
      continue
    }
    if (r.status === 'ok') return { status: 'ok', info: { ...r.info, passedOver } }
    return r as { status: 'corrupt' | 'unsupported' | 'incomplete'; reason: string }
  }
  return { status: 'none', passedOver }
}

/**
 * One checkpoint into the sink. Format 1: its one `base` line, streamed like a base. Format 2: its
 * manifest, then its parts in order, `PART_WINDOW` requested at a time, each checked against the
 * manifest and its key (tenant, incarnation, version, attempt, part number, record count), files
 * then tombstones in strictly ascending key order across parts, and in total the files, the
 * tombstones and the bytes the manifest names. Any disagreement stops it (`corrupt`); a missing
 * part too (`incomplete`); either way the caller gets no base, so nothing of it is published.
 */
async function readCheckpoint(
  store: Store,
  cell: string,
  tenant: string,
  incarnation: number,
  m: { key: string; version: number },
  sink: BaseSink,
): Promise<{ status: 'ok'; info: BaseInfo } | { status: 'corrupt' | 'unsupported' | 'incomplete' | 'passed_over'; reason: string }> {
  const where = `checkpoint ${m.version} of incarnation ${incarnation}`
  const o = await store.get(m.key)
  if (!o) return { status: 'incomplete', reason: `${where} was listed and is gone (superseded meanwhile)` }
  sink.reset(tenant)
  const out = new Batches(sink, tenant)
  let format = 0 as 0 | 1 | 2
  let header: LedgerSegmentHeader | null = null
  const arrays: Record<'watermarks' | 'previousIncarnations', unknown[]> = { watermarks: [], previousIncarnations: [] }
  try {
    const { lines, streamed } = await readLedgerLogStream(
      o.body,
      1,
      (member, element) => {
        if (format === 1) {
          if (member === 'added') out.file(fileOf(element, where))
          else if (member === 'tombstones') out.tombstone(tombstoneOf(element, where))
        } else if (member === 'watermarks' || member === 'previousIncarnations') arrays[member].push(element)
        else throw new Stop('corrupt', `${where}: a manifest with an array member ${JSON.stringify(member)}`)
      },
      (index, value) => {
        if (index !== 0) throw new Stop('corrupt', `${where}: more than one line after its header`)
        const problem = checkpointHeaderProblem(value, { ledgerIncarnation: incarnation, version: m.version, tenant })
        if (problem) throw new Stop(problem.status === 'unsupported' ? 'passed_over' : 'corrupt', `${where}: ${problem.reason}`)
        const h = value as LedgerSegmentHeader
        if (h.v > LEDGER_CHECKPOINT_VERSION) throw new Stop('passed_over', `${where}: format ${h.v}; this publisher reads up to ${LEDGER_CHECKPOINT_VERSION}`)
        header = h
        format = h.v as 1 | 2
      },
    )
    out.flush()
    const h = header as LedgerSegmentHeader | null
    if (lines !== 2 || !h || !streamed) throw new Stop('corrupt', `${where}: not a header and one line`)
    if (format === 1) {
      const why = unsupported(streamed)
      if (why) throw new Stop('passed_over', `${where}: ${why}`)
      if (streamed.kind !== 'base' || streamed.ledgerIncarnation !== incarnation || streamed.version !== m.version) throw new Stop('corrupt', `${where}: its line is not the base at ${m.version}`)
      return { status: 'ok', info: { version: m.version, source: 'checkpoint', format: 1, files: out.files, tombstones: out.tombstones, objects: 1, window: 0, passedOver: [] } }
    }

    const d = decodeLedgerCheckpointManifest({ ...streamed, ...arrays }, h)
    if (d.status === 'unsupported') throw new Stop('passed_over', `${where}: ${d.reason}`)
    if (d.status === 'corrupt') throw new Stop('corrupt', `${where}: ${d.reason}`)
    const man = d.manifest
    const fetchPart = async (part: number): Promise<{ size: number; text: string } | null> => {
      const p = await store.get(`${cell}/${ledgerCheckpointPartKey(tenant, incarnation, m.version, man.attempt, part)}`)
      return p ? { size: p.size, text: await p.text() } : null
    }
    // Parts in order; the next few are requested while one is applied.
    const ahead: Promise<{ size: number; text: string } | null>[] = []
    let next = 0
    let window = 0
    let bytes = 0
    let files = 0
    let tombstones = 0
    let lastFile: string | null = null
    let lastTombstone: string | null = null
    for (let part = 0; part < man.parts; part++) {
      while (next < man.parts && ahead.length < PART_WINDOW) {
        const read = fetchPart(next++)
        read.catch(() => undefined) // awaited below, in order
        ahead.push(read)
      }
      window = Math.max(window, ahead.length)
      const got = await ahead.shift()!
      if (!got) throw new Stop('incomplete', `${where} names part ${part} (attempt ${man.attempt}), which is not in R2`)
      const p = decodeLedgerCheckpointPart(got.text, { tenant, ledgerIncarnation: incarnation, version: m.version, attempt: man.attempt, part })
      if (p.status === 'unsupported') throw new Stop('passed_over', `${where}, part ${part}: ${p.reason}`)
      if (p.status === 'corrupt') throw new Stop('corrupt', `${where}, part ${part}: ${p.reason}`)
      bytes += got.size
      const fs: FileEntry[] = []
      const ts: { key: string; table: LedgerTable }[] = []
      for (const r of p.records) {
        if ('file' in r) {
          if (lastTombstone !== null) throw new Stop('corrupt', `${where}, part ${part}: a file after the tombstones`)
          const f = fileOf(r.file, `${where}, part ${part}`)
          if (lastFile !== null && compareKeys(f.key, lastFile) <= 0) throw new Stop('corrupt', `${where}, part ${part}: files out of key order (${f.key} after ${lastFile})`)
          lastFile = f.key
          fs.push(f)
        } else {
          const t = tombstoneOf(r.tombstone, `${where}, part ${part}`)
          if (lastTombstone !== null && compareKeys(t.key, lastTombstone) <= 0) throw new Stop('corrupt', `${where}, part ${part}: tombstones out of key order (${t.key} after ${lastTombstone})`)
          lastTombstone = t.key
          ts.push(t)
        }
      }
      files += fs.length
      tombstones += ts.length
      if (fs.length > 0) sink.files(tenant, fs)
      if (ts.length > 0) sink.tombstones(tenant, ts)
    }
    if (files !== man.files || tombstones !== man.tombstones) {
      throw new Stop('corrupt', `${where}: its parts hold ${files} files and ${tombstones} tombstones, its manifest says ${man.files} and ${man.tombstones}`)
    }
    // The only size the format gives: the manifest's total of the parts' bytes, as R2 stored them.
    if (bytes !== man.bytes) throw new Stop('corrupt', `${where}: its parts are ${bytes} bytes, its manifest says ${man.bytes}`)
    return { status: 'ok', info: { version: m.version, source: 'checkpoint', format: 2, files, tombstones, objects: 1 + man.parts, window, passedOver: [] } }
  } catch (e) {
    if (e instanceof Stop) return { status: e.status === 'no_base' ? 'corrupt' : e.status, reason: e.message }
    if (malformed(e)) return { status: 'corrupt', reason: `${where}: ${e.message}` }
    throw e
  }
}

/**
 * The segment path of `readTenantLog`. `from` is null to re-base: start from the newest
 * checkpoint this code reads, else from the base at the head of the incarnation's first
 * segment, either streamed into `sink`. Returns null when the incarnation has no segment after
 * the cursor (the caller then looks for the first layout).
 */
async function readSegmentLog(store: Store, cell: string, tenant: string, incarnation: number, from: Cursor | null, maxChanges: number, sink: BaseSink): Promise<TenantLog | null> {
  const result = (status: LogStatus, extra: Partial<TenantLog> = {}): TenantLog => ({ tenant, status, incarnation, layout: 'segments', base: null, start: from?.version ?? 0, changes: [], ...extra })
  // How many versions above `after` the listed segments cover.
  const covered = (segs: SegmentRef[], after: number) => segs.reduce((n, s) => n + Math.max(0, s.last - Math.max(s.first - 1, after)), 0)

  let refs: SegmentRef[]
  let complete: boolean
  let after: number
  /** A re-base's starting state, once read. */
  let base: BaseInfo | null = null
  /** A re-base from the base: the first segment, streamed rather than read whole. */
  let baseSegment: SegmentRef | null = null
  let cursor = from
  if (from === null) {
    // One tenant's checkpoint or base at a time (the publisher's turns): released on every way out.
    const done = (await sink.turn?.()) ?? (() => {})
    try {
      const ck = await readNewestCheckpoint(store, cell, tenant, incarnation, sink)
      if (ck.status === 'corrupt' || ck.status === 'unsupported' || ck.status === 'incomplete') {
        // Never a partial publish: no base, so nothing read from it is used.
        if (await hasObjectBase(store, cell, tenant, incarnation)) return result('corrupt', { detail: `incarnation ${incarnation} has both segments and a base.json` })
        return result(ck.status, { detail: ck.reason })
      }
      if (ck.status === 'ok') {
        // Only a segment incarnation has checkpoints. From here on, as from a cursor at its version.
        if (await hasObjectBase(store, cell, tenant, incarnation)) return result('corrupt', { detail: `incarnation ${incarnation} has both segments and a base.json` })
        base = ck.info
        cursor = { ledgerIncarnation: incarnation, version: ck.info.version }
      } else {
        // No checkpoint: the first segment starts with the base; list from it.
        ;({ segs: refs, complete } = await listSegments(store, cell, tenant, incarnation, undefined, (s) => s.length > 0 && covered(s, s[0]!.first) > maxChanges))
        if (refs.length === 0) return null
        if (await hasObjectBase(store, cell, tenant, incarnation)) return result('corrupt', { detail: `incarnation ${incarnation} has both segments and a base.json` })
        after = refs[0]!.first // the base's version: changes start after it
        baseSegment = refs[0]!
        const b = await readBaseSegment(store, tenant, incarnation, baseSegment, sink, (ck as { passedOver: string[] }).passedOver)
        if (b.status !== 'ok') return result(b.status, { detail: b.reason, start: after, ...(b.status === 'unsupported' ? { gapAt: baseSegment.first } : {}) })
        done()
        return readAfter(store, tenant, incarnation, refs, complete, after, maxChanges, b.info, b.changes, baseSegment)
      }
    } finally {
      done()
    }
  }
  after = (cursor as Cursor).version
  const startAfter = `${cell}/${ledgerSegmentsStartingAfter(tenant, incarnation, after)}`
  ;({ segs: refs, complete } = await listSegments(store, cell, tenant, incarnation, startAfter, (s) => covered(s, after) > maxChanges))
  if (refs.length === 0) {
    // Nothing after the cursor. After a checkpoint that is the whole log: the state is the checkpoint's.
    return base ? { tenant, status: 'ok', incarnation, layout: 'segments', base, start: after, changes: [] } : null
  }
  if (refs[0]!.first > after + 1) {
    // The cursor is inside a segment, or there is a hole: find the segment holding after + 1.
    const all = await listSegments(store, cell, tenant, incarnation, undefined, (s) => s.length > 0 && s[s.length - 1]!.first > after + 1)
    const holding = all.segs.find((s) => s.first <= after + 1 && after + 1 <= s.last)
    if (!holding) return result('gap', { base, start: after, gapAt: after + 1, detail: `version ${after + 1} of incarnation ${incarnation} is in no segment; the next one starts at ${refs[0]!.first}` })
    refs = [holding, ...refs]
  }
  return readAfter(store, tenant, incarnation, refs, complete, after, maxChanges, base, [], null)
}

/**
 * Whole segments after `after`, contiguous, up to about `maxChanges` changes (at least one
 * segment). With a base read from the first of `refs` (`pre` holds the changes after its base
 * line), that segment is not read again.
 */
async function readAfter(
  store: Store,
  tenant: string,
  incarnation: number,
  refs: SegmentRef[],
  complete: boolean,
  after: number,
  maxChanges: number,
  base: BaseInfo | null,
  pre: LogChange[],
  baseSegment: SegmentRef | null,
): Promise<TenantLog> {
  // Whole segments, contiguous, up to the cap (at least one segment).
  let status: LogStatus = 'ok'
  let gapAt: number | undefined
  let detail: string | undefined
  const take: SegmentRef[] = []
  let n = 0
  for (const [i, s] of refs.entries()) {
    if (i > 0) {
      const prev = refs[i - 1]!
      if (s.first > prev.last + 1) {
        status = 'gap'
        gapAt = prev.last + 1
        detail = `version ${gapAt} of incarnation ${incarnation} is in no segment; the next one starts at ${s.first}`
        break
      }
      if (s.first <= prev.last) {
        // Two segments claim the same versions: neither is trusted. Stop before both.
        status = 'corrupt'
        detail = `segments ${prev.first}-${prev.last} and ${s.first}-${s.last} of incarnation ${incarnation} overlap`
        if (take.at(-1) === prev) take.pop()
        break
      }
    }
    if (take.length > 0 && n >= maxChanges) {
      status = 'more'
      break
    }
    take.push(s)
    n += Math.max(0, s.last - Math.max(s.first - 1, after))
  }
  if (status === 'ok' && !complete) status = 'more'

  const start = after
  const changes: LogChange[] = []
  // A base segment was streamed already: its changes after the base line are `pre`.
  let reads = take
  if (baseSegment !== null) {
    if (take[0] !== baseSegment) {
      // Overlapping with the segment after it: nothing of the incarnation is trusted, not even its base.
      return { tenant, status, detail, incarnation, layout: 'segments', base: null, start, changes }
    }
    changes.push(...pre.filter((c) => c.version > start))
    reads = take.slice(1)
  }
  for (let i = 0; i < reads.length; i += READ_FANOUT) {
    const batch = reads.slice(i, i + READ_FANOUT)
    const got = await Promise.all(batch.map((s) => readSegment(store, tenant, incarnation, s)))
    for (const [j, r] of got.entries()) {
      const seg = batch[j]!
      if (r.status !== 'ok') {
        // Stop before this segment, whatever came after it. Never skip it.
        return { tenant, status: r.status, detail: r.reason, incarnation, layout: 'segments', base, start, changes, ...(r.status === 'unsupported' ? { gapAt: seg.first } : {}) }
      }
      for (const c of r.changes) {
        if (c.kind === 'base') return { tenant, status: 'corrupt', detail: `version ${c.version} of incarnation ${incarnation} is a base inside the log`, incarnation, layout: 'segments', base, start, changes }
        if (c.version > start) changes.push(c)
      }
    }
  }
  const log: TenantLog = { tenant, status, incarnation, layout: 'segments', base, start, changes }
  if (detail) log.detail = detail
  if (gapAt !== undefined) log.gapAt = gapAt
  return log
}

// ───────────────────────────── the first layout: one object per change ─────────────────────────────

async function readBase(store: Store, cell: string, tenant: string, incarnation: number): Promise<LogChange | null | 'corrupt' | Unsupported> {
  const o = await store.get(`${cell}/${ledgerBaseKey(tenant, incarnation)}`)
  if (!o) return null
  const base = await o.json<LedgerChange>()
  if (base.kind !== 'base' && unsupported(base) === null) return 'corrupt'
  const r = check(base)
  if ('unsupported' in r) return new Unsupported(r.unsupported)
  if ('corrupt' in r || base.ledgerIncarnation !== incarnation || !Number.isSafeInteger(base.version)) return 'corrupt'
  return r.ok
}

/** Versions of an incarnation's change objects that are greater than `after`, ascending. */
async function listVersions(store: Store, cell: string, tenant: string, incarnation: number, after: number): Promise<number[]> {
  const prefix = `${tenantPrefix(cell, tenant)}${incarnation}/`
  const versions: number[] = []
  let cursor: string | undefined
  do {
    // `startAfter` skips what is already published; zero-padded names list in version order.
    // `base.json`, checkpoints and segments sort after every change object.
    const page = await store.list({ prefix, cursor, startAfter: cursor ? undefined : `${cell}/${ledgerLogKey(tenant, incarnation, after)}` })
    for (const o of page.objects) {
      const m = CHANGE_OBJECT.exec(o.key)
      if (m && Number(m[1]) > after) versions.push(Number(m[1]))
    }
    // Change objects come first in the listing; past them there is nothing more to find.
    cursor = page.truncated && page.objects.every((o) => CHANGE_OBJECT.test(o.key)) ? page.cursor : undefined
  } while (cursor)
  // Never trust listing order for correctness: sort by number.
  return versions.sort((a, b) => a - b)
}

async function readChange(store: Store, cell: string, tenant: string, incarnation: number, version: number): Promise<LogChange | null | Unsupported> {
  const o = await store.get(`${cell}/${ledgerLogKey(tenant, incarnation, version)}`)
  if (!o) return null
  const c = await o.json<LedgerChange>()
  const r = check(c)
  if ('unsupported' in r) return new Unsupported(`version ${version}: ${r.unsupported}`)
  if ('corrupt' in r || c.ledgerIncarnation !== incarnation || c.version !== version || c.kind === 'base') return null
  return r.ok
}

/** The first layout's `base.json`, streamed into the sink (it has no header: the object is line 0). */
async function streamObjectBase(store: Store, cell: string, tenant: string, incarnation: number, sink: BaseSink): Promise<BaseInfo | null | Stop> {
  const where = `base.json of incarnation ${incarnation}`
  const o = await store.get(`${cell}/${ledgerBaseKey(tenant, incarnation)}`)
  if (!o) return null
  sink.reset(tenant)
  const out = new Batches(sink, tenant)
  try {
    const { streamed } = await readLedgerLogStream(
      o.body,
      0,
      (member, element) => {
        if (member === 'added') out.file(fileOf(element, where))
        else if (member === 'tombstones') out.tombstone(tombstoneOf(element, where))
      },
      () => {
        throw new Stop('corrupt', `${where} is more than one object`)
      },
    )
    out.flush()
    if (!streamed) throw new Stop('corrupt', `${where} is not a base change`)
    const why = unsupported(streamed)
    if (why) throw new Stop('unsupported', `${where}: ${why}`)
    if (streamed.kind !== 'base' || streamed.ledgerIncarnation !== incarnation || !Number.isSafeInteger(streamed.version)) throw new Stop('corrupt', `${where} is not a base change`)
    return { version: streamed.version as number, source: 'base', format: null, files: out.files, tombstones: out.tombstones, objects: 1, window: 0, passedOver: [] }
  } catch (e) {
    if (e instanceof Stop) return e
    if (malformed(e)) return new Stop('corrupt', `${where}: ${e.message}`)
    throw e
  }
}

async function readObjectLog(store: Store, cell: string, tenant: string, incarnation: number, from: Cursor | null, maxChanges: number, sink: BaseSink): Promise<TenantLog> {
  const none = (status: LogStatus, detail?: string): TenantLog => ({ tenant, status, detail, incarnation, layout: 'objects', base: null, start: 0, changes: [] })
  let base: BaseInfo | null = null
  let start: number
  if (from === null) {
    const b = await streamObjectBase(store, cell, tenant, incarnation, sink)
    if (b === null) return none('no_base', `incarnation ${incarnation} has neither a base segment nor a base.json`)
    if (b instanceof Stop) return b.status === 'unsupported' ? { ...none('unsupported', b.message), gapAt: 0 } : none('corrupt', b.message)
    base = b
    start = b.version
  } else {
    start = from.version
  }

  const listed = await listVersions(store, cell, tenant, incarnation, start)
  // The contiguous run start+1, start+2, ... A hole ends it.
  let run = 0
  while (run < listed.length && listed[run] === start + 1 + run) run++
  let status: LogStatus = run < listed.length ? 'gap' : 'ok'
  let gapAt = run < listed.length ? start + 1 + run : undefined
  if (run > maxChanges) {
    run = maxChanges
    status = 'more'
    gapAt = undefined
  }
  const wanted = listed.slice(0, run)
  const read = await inBatches(wanted, READ_FANOUT, (v) => readChange(store, cell, tenant, incarnation, v))
  const changes: LogChange[] = []
  for (const [i, c] of read.entries()) {
    if (c instanceof Unsupported) {
      // Written by a newer ledger: stop before it, as for a hole, and say why. Never skip it.
      return { tenant, status: 'unsupported', detail: c.why, incarnation, layout: 'objects', base, start, changes, gapAt: wanted[i] }
    }
    if (!c) {
      // Listed a moment ago, unreadable or wrong now: stop before it, as for a hole.
      return { tenant, status: 'corrupt', detail: `change ${wanted[i]} of incarnation ${incarnation} is missing or not what its key says`, incarnation, layout: 'objects', base, start, changes }
    }
    changes.push(c)
  }
  const log: TenantLog = { tenant, status, incarnation, layout: 'objects', base, start, changes }
  if (gapAt !== undefined) {
    log.gapAt = gapAt
    log.detail = `version ${gapAt} of incarnation ${incarnation} is missing; ${listed[listed.length - 1]} exists`
  }
  return log
}

// ───────────────────────────── publish: the changes after a cursor ─────────────────────────────

/**
 * The changes a tenant's ledger logged after `from`, in version order.
 *
 * With no cursor, or a cursor from an older incarnation, the reader starts again from the
 * newest incarnation's `base` (the contract's rule for a new incarnation). A hole, or an
 * object this code may not read, ends the result there: nothing after it is ever returned.
 * With segments, at most about `maxChanges` changes are read, in whole segments (always at
 * least one); the rest is `more`.
 *
 * R2 operations: one list for the incarnations, one for the segments after the cursor (a
 * second only if the cursor sits inside a segment), one get per segment read. When nothing is
 * new, one more list looks for the first layout. A re-base adds one list (checkpoints), one head
 * (no `base.json` beside segments) and the get of its checkpoint's manifest and parts, or of the
 * base segment; its files and tombstones go to `sink`, a part or `BASE_BATCH` at a time.
 */
export async function readTenantLog(store: Store, cell: string, tenant: string, from: Cursor | null, maxChanges: number, sink: BaseSink): Promise<TenantLog> {
  const incarnation = await latestIncarnation(store, cell, tenant)
  if (incarnation === null) return { tenant, status: 'no_log', incarnation: 0, layout: null, base: null, start: 0, changes: [] }
  if (from && from.ledgerIncarnation > incarnation) {
    return { tenant, status: 'cursor_ahead', detail: `cursor is at incarnation ${from.ledgerIncarnation}, R2 has ${incarnation}`, incarnation, layout: null, base: null, start: 0, changes: [] }
  }
  const cursor = from && from.ledgerIncarnation === incarnation ? from : null
  const segments = await readSegmentLog(store, cell, tenant, incarnation, cursor, Math.max(1, maxChanges), sink)
  if (segments) return segments
  // No segment at all (a re-base), or none after the cursor: the first layout, or nothing new.
  const objects = await readObjectLog(store, cell, tenant, incarnation, cursor, Math.max(1, maxChanges), sink)
  // Nothing after the cursor in either layout: which one the incarnation uses is not known here.
  return cursor && objects.status === 'ok' && objects.changes.length === 0 ? { ...objects, layout: null } : objects
}

/** Tenants that have a ledger log under the cell. */
export async function listTenants(store: Store, cell: string): Promise<string[]> {
  const prefix = `${cell}/ledger/`
  const out: string[] = []
  let cursor: string | undefined
  do {
    const page = await store.list({ prefix, delimiter: '/', cursor })
    for (const p of page.delimitedPrefixes) {
      const name = p.slice(prefix.length, -1)
      if (name.startsWith('tenant=')) out.push(name.slice('tenant='.length))
    }
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
  return out
}

// ───────────────────────────── verify: the live set at a cursor ─────────────────────────────

/** Apply one change to a replayed live set, checking it against the state before it. */
function applyChecked(files: Map<string, FileEntry>, c: LogChange, tenant: string): void {
  for (const r of c.removedFiles) {
    const f = files.get(r.key)
    if (!f) throw new Error(`change ${c.version} of ${tenant} removes ${r.key}, which is not live`)
    if (r.table !== null && r.table !== f.table) throw new Error(`change ${c.version} of ${tenant} removes ${r.key} as a ${r.table} file; it is a ${f.table} file`)
    files.delete(r.key)
  }
  for (const f of c.added) {
    if (files.has(f.key)) throw new Error(`change ${c.version} of ${tenant} adds ${f.key}, which is already live`)
    files.set(f.key, f)
  }
}

/**
 * The ledger's live set at `cursor`, rebuilt from R2: the incarnation's base, then every
 * change up to the cursor, each checked against the state before it. Throws with the reason
 * if the log cannot produce that state.
 */
export async function replayAt(store: Store, cell: string, tenant: string, cursor: Cursor): Promise<Map<string, FileEntry>> {
  const inc = cursor.ledgerIncarnation
  const { segs } = await listSegments(store, cell, tenant, inc, undefined, (s) => s.length > 0 && s[s.length - 1]!.last >= cursor.version)
  if (segs.length > 0) return replaySegments(store, cell, tenant, cursor, segs)

  const base = await readBase(store, cell, tenant, inc)
  if (base instanceof Unsupported) throw new Error(`incarnation ${inc} of ${tenant}: base.json is not readable by this publisher: ${base.why}`)
  if (base === null || base === 'corrupt') throw new Error(`incarnation ${inc} of ${tenant} has no usable base`)
  if (cursor.version < base.version) throw new Error(`cursor version ${cursor.version} of ${tenant} is before the base of incarnation ${inc} (${base.version})`)
  const files = new Map<string, FileEntry>()
  for (const f of base.added) files.set(f.key, f)
  const versions: number[] = []
  for (let v = base.version + 1; v <= cursor.version; v++) versions.push(v)
  const changes = await inBatches(versions, READ_FANOUT, (v) => readChange(store, cell, tenant, inc, v))
  for (const [i, c] of changes.entries()) {
    if (c instanceof Unsupported) throw new Error(`change ${versions[i]} of incarnation ${inc} of ${tenant} is not readable by this publisher: ${c.why}`)
    if (!c) throw new Error(`change ${versions[i]} of incarnation ${inc} of ${tenant} is missing from the log`)
    applyChecked(files, c, tenant)
  }
  return files
}

async function replaySegments(store: Store, cell: string, tenant: string, cursor: Cursor, segs: SegmentRef[]): Promise<Map<string, FileEntry>> {
  const inc = cursor.ledgerIncarnation
  if (await hasObjectBase(store, cell, tenant, inc)) throw new Error(`incarnation ${inc} of ${tenant} has both segments and a base.json`)
  const files = new Map<string, FileEntry>()
  let version: number | null = null
  const need = segs.filter((s) => s.first <= cursor.version)
  for (const [i, s] of need.entries()) {
    if (i > 0 && s.first !== need[i - 1]!.last + 1) throw new Error(`log of incarnation ${inc} of ${tenant} is not contiguous at version ${need[i - 1]!.last + 1} (next segment starts at ${s.first})`)
  }
  for (let i = 0; i < need.length; i += READ_FANOUT) {
    const got = await Promise.all(need.slice(i, i + READ_FANOUT).map((s) => readSegment(store, tenant, inc, s)))
    for (const r of got) {
      if (r.status !== 'ok') throw new Error(`${r.reason} (${r.status})`)
      for (const c of r.changes) {
        if (c.version > cursor.version) break
        if (version === null) {
          if (c.kind !== 'base') throw new Error(`incarnation ${inc} of ${tenant} does not start with a base`)
          for (const f of c.added) files.set(f.key, f)
        } else {
          if (c.kind === 'base') throw new Error(`version ${c.version} of incarnation ${inc} of ${tenant} is a base inside the log`)
          if (c.version !== version + 1) throw new Error(`log of incarnation ${inc} of ${tenant} is not contiguous at version ${version + 1}`)
          applyChecked(files, c, tenant)
        }
        version = c.version
      }
    }
  }
  if (version === null) throw new Error(`incarnation ${inc} of ${tenant} has no base segment`)
  if (version < cursor.version) throw new Error(`the log of incarnation ${inc} of ${tenant} ends at ${version}, before the cursor ${cursor.version}`)
  return files
}
