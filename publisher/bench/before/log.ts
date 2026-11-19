// FROZEN: publisher/src/log.ts as it stood before the streaming re-base (2026-11-19), the counterfactual of
// bench/rebase.bench.test.ts. Not used in production; do not edit.
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
 *              ({inc}/ckpt-…) exist only to speed up the ledger's own rebuild; this reader
 *              never reads them.
 *   objects    {inc}/base.json and {inc}/{version:012}.json, one object per change: the first
 *              layout. Still read, because a deployment that ran the trial stage may hold
 *              incarnations in it (LEDGER-LOG.md "Versions", COMPATIBILITY.md §3.6 step 3).
 *
 * Two readers, kept separate on purpose:
 *
 *   readTenantLog   what `publish` uses: the changes after a cursor, in version order, up to
 *                   the first hole or the first object this code may not read. With segments
 *                   it advances over whole segments only.
 *   replayAt        what `verify` uses: the ledger's whole live set at a cursor, rebuilt from
 *                   the incarnation's base with every change checked against the state before it.
 *
 * Refuse, never guess (contracts/COMPATIBILITY.md §3.2): a segment header `v` or `kind`, a change
 * `v` or `kind`, or a file table this code does not know stops the tenant BEFORE that segment
 * (status `unsupported`); a hole stops it before the hole (`gap`); an object that is not what its
 * key says stops it before that object (`corrupt`). Nothing after a stop is ever returned, so it
 * can never be skipped; the publisher keeps the tenant pending and tries again.
 */
import {
  decodeLedgerSegment,
  ledgerBaseKey,
  ledgerIncarnationPrefix,
  ledgerLogKey,
  ledgerSegmentsStartingAfter,
  parseLedgerLogKey,
  type FileEntry,
  type LedgerChange,
  type Table,
} from '../../../contracts/ledger'

export interface Cursor {
  ledgerIncarnation: number
  version: number
}

export const cursorCompare = (a: Cursor, b: Cursor): number => a.ledgerIncarnation - b.ledgerIncarnation || a.version - b.version

/** The parts of R2 the publisher uses. `CountingBucket` implements it. */
export interface Store {
  get(key: string): Promise<R2ObjectBody | null>
  head(key: string): Promise<R2Object | null>
  list(options: R2ListOptions): Promise<R2Objects>
  put(key: string, value: string | Uint8Array, options?: R2PutOptions): Promise<R2Object | null>
  delete(keys: string | string[]): Promise<void>
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

/** A removed key with its table: from `LedgerChange.removedFiles`, or from the key layout for logs written before it (null if the key does not follow it). */
export interface RemovedFile {
  key: string
  table: Table | null
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
  /** Loaded when the reader started from the base (no cursor, or an older incarnation). */
  base: LogChange | null
  /** The version `changes` starts after. */
  start: number
  /** Contiguous: `changes[i].version === start + 1 + i`. */
  changes: LogChange[]
  gapAt?: number
}

/** The tables a ledger file may belong to, as far as this publisher knows (contracts/ledger.ts `Table`). */
const TABLES: ReadonlySet<string> = new Set<Table>(['metric_samples', 'metric_series'])
const CHANGE_OBJECT = /\/(\d{12,})\.json$/
/** `{cell}/data/{table}/…` (contracts/TABLES.md): the table of a removed key in a log written before `removedFiles`. */
const KEY_TABLE = /^[^/]+\/data\/([^/]+)\//
const READ_FANOUT = 6

// ───────────────────────────── what this code reads ─────────────────────────────
//
// Pinned here, not taken from contracts/ledger.ts: they say what THIS publisher knows how to
// apply. When the contract's numbers move, `test/compat.test.ts` fails until this reader is
// taught the new version and these are raised with it (readers first, COMPATIBILITY.md §3.3).

/** Segment and checkpoint header versions (`v`) this publisher reads. */
export const LEDGER_SEGMENT_VERSION = 1
/** The segment header kind this publisher reads (checkpoints are never read here). */
const SEGMENT_KIND = 'viz.ledger.segment'
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
      return { key, table: t !== undefined && TABLES.has(t) ? (t as Table) : null }
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

/**
 * The segment path of `readTenantLog`. `from` is null to start from the incarnation's base.
 * Returns null when the incarnation has no segment after the cursor (the caller then looks for
 * the first layout).
 */
async function readSegmentLog(store: Store, cell: string, tenant: string, incarnation: number, from: Cursor | null, maxChanges: number): Promise<TenantLog | null> {
  const result = (status: LogStatus, extra: Partial<TenantLog> = {}): TenantLog => ({ tenant, status, incarnation, layout: 'segments', base: null, start: from?.version ?? 0, changes: [], ...extra })
  // How many versions above `after` the listed segments cover.
  const covered = (segs: SegmentRef[], after: number) => segs.reduce((n, s) => n + Math.max(0, s.last - Math.max(s.first - 1, after)), 0)

  let refs: SegmentRef[]
  let complete: boolean
  let after: number
  if (from === null) {
    // Re-base: the first segment starts with the base; list from it.
    ;({ segs: refs, complete } = await listSegments(store, cell, tenant, incarnation, undefined, (s) => s.length > 0 && covered(s, s[0]!.first) > maxChanges))
    if (refs.length === 0) return null
    if (await hasObjectBase(store, cell, tenant, incarnation)) return result('corrupt', { detail: `incarnation ${incarnation} has both segments and a base.json` })
    after = refs[0]!.first // the base's version: changes start after it
  } else {
    after = from.version
    const startAfter = `${cell}/${ledgerSegmentsStartingAfter(tenant, incarnation, after)}`
    ;({ segs: refs, complete } = await listSegments(store, cell, tenant, incarnation, startAfter, (s) => covered(s, after) > maxChanges))
    if (refs.length === 0) return null
    if (refs[0]!.first > after + 1) {
      // The cursor is inside a segment, or there is a hole: find the segment holding after + 1.
      const all = await listSegments(store, cell, tenant, incarnation, undefined, (s) => s.length > 0 && s[s.length - 1]!.first > after + 1)
      const holding = all.segs.find((s) => s.first <= after + 1 && after + 1 <= s.last)
      if (!holding) return result('gap', { gapAt: after + 1, detail: `version ${after + 1} of incarnation ${incarnation} is in no segment; the next one starts at ${refs[0]!.first}` })
      refs = [holding, ...refs]
    }
  }

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

  let base: LogChange | null = null
  const start = after
  const changes: LogChange[] = []
  const reads = take.length
  for (let i = 0; i < reads; i += READ_FANOUT) {
    const batch = take.slice(i, i + READ_FANOUT)
    const got = await Promise.all(batch.map((s) => readSegment(store, tenant, incarnation, s)))
    for (const [j, r] of got.entries()) {
      const seg = batch[j]!
      if (r.status !== 'ok') {
        // Stop before this segment, whatever came after it. Never skip it.
        return { tenant, status: r.status, detail: r.reason, incarnation, layout: 'segments', base, start, changes, ...(r.status === 'unsupported' ? { gapAt: seg.first } : {}) }
      }
      for (const c of r.changes) {
        if (from === null && base === null) {
          // An incarnation's first line is its base, and only there.
          if (c.kind !== 'base' || c.version !== seg.first) return result('no_base', { start, detail: `the first segment of incarnation ${incarnation} does not begin with its base` })
          base = c
          continue
        }
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

async function readObjectLog(store: Store, cell: string, tenant: string, incarnation: number, from: Cursor | null, maxChanges: number): Promise<TenantLog> {
  const none = (status: LogStatus, detail?: string): TenantLog => ({ tenant, status, detail, incarnation, layout: 'objects', base: null, start: 0, changes: [] })
  let base: LogChange | null = null
  let start: number
  if (from === null) {
    const b = await readBase(store, cell, tenant, incarnation)
    if (b === null) return none('no_base', `incarnation ${incarnation} has neither a base segment nor a base.json`)
    if (b === 'corrupt') return none('corrupt', `base.json of incarnation ${incarnation} is not a base change`)
    if (b instanceof Unsupported) return { ...none('unsupported', `base.json of incarnation ${incarnation}: ${b.why}`), gapAt: 0 }
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
 * new, one more list looks for the first layout. A re-base adds one head (no `base.json`
 * beside segments).
 */
export async function readTenantLog(store: Store, cell: string, tenant: string, from: Cursor | null, maxChanges: number): Promise<TenantLog> {
  const incarnation = await latestIncarnation(store, cell, tenant)
  if (incarnation === null) return { tenant, status: 'no_log', incarnation: 0, layout: null, base: null, start: 0, changes: [] }
  if (from && from.ledgerIncarnation > incarnation) {
    return { tenant, status: 'cursor_ahead', detail: `cursor is at incarnation ${from.ledgerIncarnation}, R2 has ${incarnation}`, incarnation, layout: null, base: null, start: 0, changes: [] }
  }
  const cursor = from && from.ledgerIncarnation === incarnation ? from : null
  const segments = await readSegmentLog(store, cell, tenant, incarnation, cursor, Math.max(1, maxChanges))
  if (segments) return segments
  // No segment at all (a re-base), or none after the cursor: the first layout, or nothing new.
  const objects = await readObjectLog(store, cell, tenant, incarnation, cursor, Math.max(1, maxChanges))
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
