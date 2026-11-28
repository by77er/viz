/**
 * Reading shard tails: filtered, paged, under a byte budget (D48; CARDINALITY.md "What is
 * left" 1). Used by the coordinator (every endpoint) and by leaves (the rest of a tail that
 * did not fit the coordinator, in their own key range).
 *
 * A shard of this release applies `TailReadOptions` and says so with `page` in its answer;
 * a shard of the previous release ignores them and answers as before, with the whole tail
 * above the watermark, unfiltered and unpaged (contracts/COMPATIBILITY.md §3.3). Both are
 * read here: the engine applies every matcher and range anyway, so a superset is exact.
 *
 * Nothing here decides what a refusal means for the query; it reports the shard's answer
 * by name (`stale`, `mismatch`, `unavailable`) and never turns one into an empty tail.
 */
import type { FetchRange } from '../../engine/wasm-query/js/index'
import type { Shard, TailResult } from '../../shard/src/shard'
import { TAIL_PAGE_MAX_BYTES, TAIL_READ_VERSION, type TailFilter, type TailReadOptions, compileFilter, filterBatch } from '../../shard/src/tail'

export { splitKeyRange } from '../../shard/src/tail'
export type { TailFilter } from '../../shard/src/tail'

/** Storage's timestamp bounds (contracts/BATCH.md). */
const MIN_TS = 0
const MAX_TS = 253_402_300_799_999

/**
 * What a read can ask the shards to keep, from the fetch ranges: a superset of every row the
 * ranges read. The hull of their times (`byTime`); the `__name__` values when EVERY range
 * pins one with `=`; and the `=` matchers on other labels that EVERY range has (`""` is
 * "absent" in both PromQL and the shard's filter). No `!=` or regular expression is passed:
 * the shard compares exact bytes only (shard/README.md "Not implemented yet").
 */
export function tailFilter(ranges: FetchRange[], byTime = true): TailFilter {
  const f: TailFilter = {}
  if (ranges.length === 0) return f
  if (byTime) {
    const lo = Math.max(MIN_TS, Math.min(...ranges.map((r) => r.minTs)))
    const hi = Math.min(MAX_TS, Math.max(...ranges.map((r) => r.maxTs)))
    if (Number.isSafeInteger(lo) && Number.isSafeInteger(hi) && lo <= hi) {
      f.minTs = lo
      f.maxTs = hi
    }
  }
  const names = ranges.map((r) => r.matchers.find((m) => m.name === '__name__' && m.op === '=')?.value)
  if (names.every((n) => n !== undefined && n !== '')) f.metrics = [...new Set(names as string[])].sort()
  const eq = (r: FetchRange) => r.matchers.filter((m) => m.op === '=' && m.name !== '__name__' && m.name !== '')
  const shared = new Map<string, { name: string; value: string }>()
  for (const m of eq(ranges[0]!)) {
    if (ranges.every((r) => eq(r).some((x) => x.name === m.name && x.value === m.value))) shared.set(JSON.stringify([m.name, m.value]), { name: m.name, value: m.value })
  }
  if (shared.size > 0) f.labels = [...shared.values()]
  return f
}

/** What is called on a shard (a Durable Object stub of `Shard`). */
export type ShardStub = Pick<DurableObjectStub<Shard>, 'tailRead'>

/** Bytes a read may take: `cap`, of which `used` is taken. */
export interface TailBudget {
  cap: number
  used: number
}

/** One shard's tail as read. */
export interface TailRead {
  status: 'ok'
  shard: string
  /** The stream and watermark it was read at. */
  incarnation: number
  above: number
  /**
   * The last sequence number of the tail the read covers (fixed by its first page); null when
   * no page was answered (the first kept batch did not fit the budget), so it is not known
   * from the read (the coordinator then asks the shard, `describe`, before any part reads on).
   */
  through: number | null
  /** Batches in sequence order: filtered when `filtered`, else the whole tail above `above`. */
  batches: { seq: number; payload: Uint8Array }[]
  bytes: number
  /** False: the shard answered without `page` (the previous release): unpaged. */
  paged: boolean
  /**
   * The batches hold only what the filter keeps: the shard filtered them (`paged`), or, for a
   * leaf's rest answered whole by a shard rolled back since the coordinator's read, this read
   * applied the shard's own filter to that answer (review m-2).
   */
  filtered: boolean
  /** False: the read stopped at the budget and more of the tail remains. */
  complete: boolean
  /** Bytes of the batch that did not fit (`page_limit`), when that is why it stopped. */
  overBytes: number
  /** That batch's sequence number (null when the read did not stop on one). */
  overSeq: number | null
  /** Whether that batch was the last of the tail (`through`): then `bytes + overBytes` is the whole of it. */
  overLast: boolean
  /** Where a read that stopped at its budget goes on from (`readPages` with `resume`): the page that stopped. */
  resume: { cursor: string | undefined; page: number } | null
  calls: number
  scannedBatches: number
  scannedBytes: number
}

/** How `readPages` reads. */
export interface PageOptions {
  /** A leaf's rest: no batch after this one is kept, and the read ends once it is passed (D54; review m-1). */
  through?: number | null
  /** Replaces each answer (a test hook of the coordinator's). */
  alter?: (answer: unknown) => unknown
  /** Unix ms after which no further page is asked for: the read is refused, retryably (review m-7). */
  deadline?: number
  /** A read that stopped at an earlier budget: go on from where it stopped, into the same object. */
  resume?: TailRead
}

export type PageOutcome =
  | TailRead
  /** The shard has discarded rows above the watermark (on any page): read the ledger again. */
  | { status: 'stale'; shard: string; calls: number }
  /** The stream is another incarnation (on any page). */
  | { status: 'mismatch'; shard: string; incarnation: number; calls: number }
  /** Anything this release does not act on: a newer schema, an unknown status, options refused. Retryable. */
  | { status: 'unavailable'; shard: string; reason: string; calls: number }

/** Test hooks (empty in production): both are shared by the coordinator and the leaves. */
export const tailHooks: {
  /** A shard to read as one of the previous release does: the options are not passed, so it answers without `page`. */
  previousRelease?: (shard: string, where: 'coordinator' | 'leaf') => boolean
  /** Replaces a shard's answer (as a test cannot otherwise make a shard misbehave). */
  alter?: (shard: string, answer: unknown, where: 'coordinator' | 'leaf') => unknown
} = {}

/**
 * Read one shard's tail above `above` of `incarnation`, filtered by `filter`, following
 * pages to the end or until a kept batch does not fit what is left of `budget`. Every page
 * is checked by the shard against the watermark; a refusal on any page drops the pages read.
 * With `o.resume`, a read that stopped at an earlier budget goes on from the page that stopped.
 */
export async function readPages(
  stub: ShardStub,
  shard: string,
  tenant: string,
  incarnation: number,
  above: number,
  filter: TailFilter,
  budget: TailBudget,
  where: 'coordinator' | 'leaf',
  o: PageOptions = {},
): Promise<PageOutcome> {
  const out: TailRead = o.resume ?? {
    status: 'ok', shard, incarnation, above, through: null, batches: [], bytes: 0, paged: true, filtered: true, complete: true, overBytes: 0, overSeq: null, overLast: false, resume: null, calls: 0, scannedBatches: 0, scannedBytes: 0,
  }
  const previous = tailHooks.previousRelease?.(shard, where) ?? false
  const unavailable = (reason: string): PageOutcome => ({ status: 'unavailable', shard, reason, calls: out.calls })
  const through = o.through ?? null
  let cursor = out.resume?.cursor
  let page = out.resume?.page ?? 0
  out.complete = true
  out.overBytes = 0
  out.overSeq = null
  out.overLast = false
  out.resume = null
  for (; ; page++) {
    if (o.deadline !== undefined && Date.now() > o.deadline) return unavailable(`the read of shard ${shard}'s tail passed the query's deadline`)
    // At least one byte: a kept batch that does not fit comes back as `page_limit`, never cut.
    const maxBytes = Math.min(TAIL_PAGE_MAX_BYTES, Math.max(1, budget.cap - budget.used))
    const opts: TailReadOptions = { v: TAIL_READ_VERSION, ...filter, maxBytes, ...(cursor === undefined ? {} : { cursor }) }
    out.calls++
    const raw = (previous ? await stub.tailRead(tenant, incarnation, above) : await stub.tailRead(tenant, incarnation, above, opts)) as unknown
    const r = (o.alter ? o.alter(raw) : tailHooks.alter ? tailHooks.alter(shard, raw, where) : raw) as TailResult
    const status: string = r.status
    if (r.status === 'ok') {
      if (!Array.isArray(r.batches)) return unavailable(`shard ${shard} answered ok without batches`)
      if (r.page === undefined) {
        // The previous release: the whole tail above the watermark in one answer. Never in the
        // middle of a paged read (a shard rolled back between two pages): that is refused.
        if (page > 0) return unavailable(`shard ${shard} stopped paging in the middle of a read`)
        out.paged = false
        out.through = r.through
        // A leaf's rest from a shard rolled back since the coordinator's read: keep what a shard
        // of this release returns (its own filter, the part's key range included), so that only
        // the part's rows count against the part's budget (review m-2). The coordinator uses a
        // whole answer as it is (the engine applies every matcher).
        const f = where === 'leaf' ? compileFilter(filter) : null
        if (f !== null && 'invalid' in f) return unavailable(`the filter of a read of shard ${shard} is not one its own code reads (${f.invalid})`)
        out.filtered = f !== null
        for (const b of r.batches) {
          if (through !== null && b.seq > through) continue
          const payload = f === null ? b.payload : (filterBatch(b.payload, f)?.bytes ?? null)
          if (payload === null) continue
          out.batches.push({ seq: b.seq, payload })
          out.bytes += payload.byteLength
          budget.used += payload.byteLength
        }
        return out
      }
      if (typeof r.page !== 'object' || r.page === null || r.page.v !== TAIL_READ_VERSION) return unavailable(`shard ${shard} answered a page of a version this release does not read`)
      if (page === 0) out.through = r.through
      let got = 0
      let passed = false
      for (const b of r.batches) {
        // A leaf reads the rest of what the coordinator saw, and no later append.
        if (through !== null && b.seq >= through) passed = true
        if (through !== null && b.seq > through) continue
        out.batches.push({ seq: b.seq, payload: b.payload })
        got += b.payload.byteLength
      }
      out.bytes += got
      budget.used += got
      out.scannedBatches += r.page.scannedBatches
      out.scannedBytes += r.page.scannedBytes
      // The end, or (a leaf's rest) a batch at or past `through`: everything up to it was examined.
      if (r.page.next === null || passed) return out
      // A page that did not move the read on would be asked again forever (review m-7).
      if (r.page.next === cursor) return unavailable(`shard ${shard} answered a page that did not advance the read`)
      cursor = r.page.next
      continue
    }
    if (r.status === 'page_limit') {
      // A leaf's rest: a batch past `through` is one no part reads, and every batch before it was
      // examined in order. The read is complete; such a batch never counts against the budget (review m-1).
      if (through !== null && typeof r.seq === 'number' && r.seq > through) return out
      // The rows this read keeps of one batch do not fit what the budget has left.
      out.complete = false
      out.overBytes = typeof r.bytes === 'number' && r.bytes > 0 ? r.bytes : 1
      out.overSeq = typeof r.seq === 'number' ? r.seq : null
      // The batch that did not fit is the last the read keeps: its bytes complete the read. A shard
      // before the review of D72 sends no `last`: then only the tail's last batch is known to be.
      out.overLast = typeof (r as { last?: unknown }).last === 'boolean' ? (r as { last: boolean }).last || r.seq === out.through : out.through !== null && r.seq === out.through
      out.resume = { cursor, page }
      return out
    }
    if (r.status === 'stale_watermark') return { status: 'stale', shard, calls: out.calls }
    if (r.status === 'incarnation_mismatch') return { status: 'mismatch', shard, incarnation: r.incarnation, calls: out.calls }
    // Every other status by name (contracts/COMPATIBILITY.md §2.4, §3.2): retryable, never "empty".
    if (status === 'schema_too_new') return unavailable(`shard ${shard} runs a newer storage schema than this release reads (schema_too_new)`)
    if (r.status === 'invalid') return unavailable(`shard ${shard} refused the tail read's options (${String(r.reason).slice(0, 80)})`)
    if (r.status === 'unsupported_version') return unavailable(`shard ${shard} does not read tail options of version ${TAIL_READ_VERSION}`)
    return unavailable(`shard ${shard} answered a status this release does not know (${status.slice(0, 40)})`)
  }
}

const TWO32 = 4294967296

/** Part of `parts` that owns the unsigned 64-bit key `hi:lo`: floor(key * parts / 2^64), exactly (hi * parts and lo * parts are below 2^53). */
const partOfKey = (hi: number, lo: number, parts: number): number => Math.floor((hi * parts + Math.floor((lo * parts) / TWO32)) / TWO32)

/**
 * A `VZB1` batch cut by `series_id` into `parts`: part `j` holds the rows of the series whose
 * id (unsigned) is in `splitKeyRange(j, parts)`, in their order, with those series' entries
 * copied as stored and every timestamp and value copied as bytes; null for a part with no
 * row, and the batch itself for a part that holds every row. The same bytes the shard's
 * filter returns for that key range (`shard/src/tail.ts` `filterBatch`; tested against it),
 * in one pass for all parts, without the engine.
 */
export const cutById = (payload: Uint8Array, parts: number): (Uint8Array | null)[] => cutByKey(payload, parts, [])

/**
 * A `VZB1` batch cut by split key into `parts`, as `cutById` cuts by id: the key of a series is
 * its `series_id`, unless it carries a label named in `without`; then it is the FNV-1a hash of
 * its other labels, in their stored (sorted) order (engine `SplitKey::key`, storage
 * `series_id`; tested against the engine's `splitTails`). Rows outside the query's ranges are
 * kept (the leaf's gathering applies the ranges, as it does to every batch). This replaces the
 * engine's cut at the coordinator and in the leaves (review M-2: the engine held 6.2 times
 * the tail in WASM memory): it holds the batch and its cuts, and nothing per series but two
 * numbers.
 */
export function cutByKey(payload: Uint8Array, parts: number, without: readonly string[]): (Uint8Array | null)[] {
  const bad = (why: string) => new Error(`not a VZB1 batch: ${why}`)
  if (!Number.isSafeInteger(parts) || parts < 1 || parts > 1 << 16) throw new RangeError('cutByKey: bad parts')
  if (payload.length < 16 || payload[0] !== 0x56 || payload[1] !== 0x5a || payload[2] !== 0x42 || payload[3] !== 0x31 || payload[4] !== 1) throw bad('header')
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  const nRows = dv.getUint32(8, true)
  const nSeries = dv.getUint32(12, true)
  const starts = new Uint32Array(nSeries + 1)
  const partOf = new Uint32Array(nSeries)
  const left = without.map((w) => new TextEncoder().encode(w))
  const isLeft = (at: number, len: number): boolean => left.some((w) => w.length === len && w.every((x, i) => payload[at + i] === x))
  let p = 16
  let single = true
  for (let s = 0; s < nSeries; s++) {
    starts[s] = p
    if (p + 12 > payload.length) throw bad('series table')
    const nLabels = dv.getUint32(p + 8, true)
    let lo = dv.getUint32(p, true)
    let hi = dv.getUint32(p + 4, true)
    const first = p + 12
    p = first
    let carries = false
    for (let l = 0; l < 2 * nLabels; l++) {
      if (p + 2 > payload.length) throw bad('label')
      const len = dv.getUint16(p, true)
      if (left.length > 0 && l % 2 === 0 && isLeft(p + 2, len)) carries = true
      p += 2 + len
      if (p > payload.length) throw bad('label')
    }
    if (carries) {
      // FNV-1a 64 over (name, 0, value, 0) of every label not in `without`, in 32-bit halves.
      hi = 0xcbf29ce4
      lo = 0x84222325
      const eat = (b: number): void => {
        lo = (lo ^ b) >>> 0
        // (hi:lo) * 0x100000001b3 mod 2^64 = (hi:lo) * 0x1b3 + (lo << 40)
        const l = lo * 0x1b3
        const carry = Math.floor(l / TWO32)
        hi = (((Math.imul(hi, 0x1b3) >>> 0) + carry + ((lo << 8) >>> 0)) % TWO32) >>> 0
        lo = l >>> 0
      }
      let q = first
      for (let l = 0; l < nLabels; l++) {
        const nLen = dv.getUint16(q, true)
        const nAt = q + 2
        const vLen = dv.getUint16(nAt + nLen, true)
        const vAt = nAt + nLen + 2
        q = vAt + vLen
        if (isLeft(nAt, nLen)) continue
        for (let i = 0; i < nLen; i++) eat(payload[nAt + i]!)
        eat(0)
        for (let i = 0; i < vLen; i++) eat(payload[vAt + i]!)
        eat(0)
      }
    }
    partOf[s] = partOfKey(hi, lo, parts)
    if (s > 0 && partOf[s] !== partOf[0]) single = false
  }
  starts[nSeries] = p
  const pad8 = (n: number) => (n + 7) & ~7
  const idxAt = pad8(p)
  const tsAt = idxAt + pad8(4 * nRows)
  const valAt = tsAt + 8 * nRows
  if (valAt + 8 * nRows !== payload.length) throw bad('row arrays')
  if (single && nRows > 0) {
    // Every series in one part (as in a shard's answer for a key range), and every one with a
    // row: the batch itself, without a list of rows.
    const used = new Uint8Array(nSeries)
    let n = 0
    for (let i = 0; i < nRows; i++) {
      const s = dv.getUint32(idxAt + 4 * i, true)
      if (s >= nSeries) throw bad('series index')
      if (!used[s]) {
        used[s] = 1
        n++
      }
    }
    if (n === nSeries) return Array.from({ length: parts }, (_, j) => (j === partOf[0] ? payload : null))
  }
  const rows: number[][] = Array.from({ length: parts }, () => [])
  for (let i = 0; i < nRows; i++) {
    const s = dv.getUint32(idxAt + 4 * i, true)
    if (s >= nSeries) throw bad('series index')
    rows[partOf[s]!]!.push(i)
  }
  return rows.map((kept, j) => {
    if (kept.length === 0) return null
    const used = new Uint8Array(nSeries)
    for (const i of kept) used[dv.getUint32(idxAt + 4 * i, true)] = 1
    if (kept.length === nRows) {
      let every = true
      for (let s = 0; s < nSeries && every; s++) if (!used[s]) every = false
      if (every) return payload
    }
    const remap = new Int32Array(nSeries).fill(-1)
    let table = 0
    let n = 0
    for (let s = 0; s < nSeries; s++) {
      if (!used[s] || partOf[s] !== j) continue
      remap[s] = n++
      table += starts[s + 1]! - starts[s]!
    }
    const m = kept.length
    const oIdx = pad8(16 + table)
    const oTs = oIdx + pad8(4 * m)
    const oVal = oTs + 8 * m
    const out = new Uint8Array(oVal + 8 * m)
    const ov = new DataView(out.buffer)
    out.set(payload.subarray(0, 8), 0)
    ov.setUint32(8, m, true)
    ov.setUint32(12, n, true)
    let q = 16
    for (let s = 0; s < nSeries; s++) {
      if (remap[s]! < 0) continue
      out.set(payload.subarray(starts[s]!, starts[s + 1]!), q)
      q += starts[s + 1]! - starts[s]!
    }
    for (let k = 0; k < m; k++) {
      const i = kept[k]!
      ov.setUint32(oIdx + 4 * k, remap[dv.getUint32(idxAt + 4 * i, true)]!, true)
      out.set(payload.subarray(tsAt + 8 * i, tsAt + 8 * i + 8), oTs + 8 * k)
      out.set(payload.subarray(valAt + 8 * i, valAt + 8 * i + 8), oVal + 8 * k)
    }
    return out
  })
}

/**
 * The series ids in `VZB1` batches (contracts/BATCH.md: a 16-byte header, then per series
 * `u64 series_id, u32 n_labels`, labels as `u16 len, bytes` pairs). Only to size a split.
 */
export function seriesIdsOf(batches: Uint8Array[], into: Set<string> = new Set()): Set<string> {
  for (const b of batches) {
    if (b.byteLength < 16) continue
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
    const n = dv.getUint32(12, true)
    let p = 16
    for (let s = 0; s < n && p + 12 <= b.byteLength; s++) {
      into.add(`${dv.getUint32(p + 4, true)}:${dv.getUint32(p, true)}`)
      const labels = dv.getUint32(p + 8, true)
      p += 12
      for (let l = 0; l < 2 * labels && p + 2 <= b.byteLength; l++) p += 2 + dv.getUint16(p, true)
    }
  }
  return into
}

/**
 * What the tail would hold if it were read to the end, from what the reads saw: the bytes
 * kept, and for a read stopped at the budget the stored batches left after the one that did
 * not fit (`through` minus its sequence number) at the bytes kept per stored batch examined so
 * far (or, without that batch, the older rule: the batches not examined at the average stored
 * size times the share kept); and the distinct series seen (a lower bound). An unknown end adds
 * nothing (the coordinator learns every end before it splits: review M-1, m-3). Only to size a
 * split, never to refuse or to answer.
 */
export function tailEstimate(reads: TailRead[]): { bytes: number; series: number } {
  let bytes = 0
  const ids = new Set<string>()
  for (const r of reads) {
    seriesIdsOf(
      r.batches.map((b) => b.payload),
      ids,
    )
    bytes += r.bytes + r.overBytes
    if (r.complete || r.through === null) continue
    if (r.overSeq !== null && r.overSeq > r.above) {
      bytes += Math.ceil(Math.max(0, r.through - r.overSeq) * ((r.bytes + r.overBytes) / (r.overSeq - r.above)))
      continue
    }
    // (The batch that did not fit is in `overBytes`, and not in `scannedBatches`.)
    const left = Math.max(0, r.through - r.above - r.scannedBatches - (r.overBytes > 0 ? 1 : 0))
    const avg = r.scannedBatches > 0 ? r.scannedBytes / r.scannedBatches : 1 << 20
    const ratio = r.scannedBytes > 0 ? Math.min(1, (r.bytes + r.overBytes) / r.scannedBytes) : 1
    bytes += Math.ceil(left * avg * ratio)
  }
  // Series seen, not scaled: batches of later scrapes repeat the same series (measured: scaling
  // by bytes asked for 15 leaves where 9 suffice, test/tail.bench.ts dataset B).
  return { bytes, series: ids.size }
}

/**
 * One shard's tail for one part of a split (or of the cardinality report, or of a label
 * call over leaves): this part's rows of what the coordinator read, and, when that read
 * stopped at the coordinator's budget, where the part reads the rest itself.
 */
export interface TailPart {
  shard: string
  /**
   * This part's rows of what the coordinator read, cut by split key (`cutByKey`; by
   * `series_id` for the report and the label calls, the same cut as the shard's key range), in
   * order. A part checks them as it checks the rest.
   */
  batches: Uint8Array[]
  /**
   * The rest of the tail, above the last batch the coordinator read: the part reads it with
   * `filter` and its key range, through `through`: the end the coordinator saw, or learned from
   * the shard when its first page did not fit (review M-1). Every part reads to the same end, so
   * the parts answer one moment of the shard. (A rest without a number here is refused.)
   */
  rest: { incarnation: number; above: number; through: number; filter: TailFilter } | null
}

/** The rest reads of a part, from the leaf's side. */
export type RestOutcome =
  | { status: 'ok'; reads: (TailRead | null)[]; bytes: number; calls: number }
  | { status: 'stale'; shard: string; incarnation: number; asked: number; calls: number }
  | { status: 'mismatch'; shard: string; incarnation: number; asked: number; calls: number }
  | { status: 'too_large'; bytes: number; calls: number }
  | { status: 'unavailable'; reason: string; calls: number }

/**
 * Reads of several shards under ONE budget (review M-2): together they never hold more than
 * `cap` bytes, `used` of which are taken already. First every read at once, each under an equal
 * share of what is left; then, one after another in the order given, each read that stopped at
 * its share goes on with all that the others left. A read that stops in the second round stops
 * because the reads together are over `cap`, so whether they fit never depends on which shard
 * answered first (where each one stops does, on the order given, which is fixed). Stops at the
 * first outcome that is not `ok`. `first(i, budget)` starts read `i` (null: nothing to read);
 * `more(i, read, budget)` continues it.
 */
export async function readShared(
  n: number,
  cap: number,
  used: number,
  first: (i: number, budget: TailBudget) => Promise<PageOutcome | null>,
  more: (i: number, read: TailRead, budget: TailBudget) => Promise<PageOutcome>,
): Promise<(PageOutcome | null)[]> {
  const share = Math.floor(Math.max(0, cap - used) / Math.max(1, n))
  const out = await Promise.all(Array.from({ length: n }, (_, i) => first(i, { cap: share, used: 0 })))
  if (out.some((g) => g !== null && g.status !== 'ok')) return out
  let held = used + out.reduce((a, g) => a + (g && g.status === 'ok' ? g.bytes : 0), 0)
  for (let i = 0; i < n; i++) {
    const g = out[i]
    if (!g || g.status !== 'ok' || g.complete) continue
    const before = g.bytes
    const m = await more(i, g, { cap, used: held })
    out[i] = m
    if (m.status !== 'ok') return out
    held += m.bytes - before
    if (!m.complete) break
  }
  return out
}

/**
 * Read the rests of `parts` (each in `keyRange`) under `cap` bytes for the part's whole tail
 * (what the coordinator sent counts too), shared by the shards (`readShared`). One answer for
 * all shards: the first refusal by name, else every shard's batches.
 */
export async function readRests(
  stubOf: (shard: string) => ShardStub,
  tenant: string,
  parts: TailPart[],
  keyRange: { lo: string; hi: string } | null,
  cap: number,
  deadline?: number,
): Promise<RestOutcome> {
  // Every part reads to the end the coordinator fixed: one without it is not read (fail closed).
  if (parts.some((p) => p.rest !== null && !Number.isSafeInteger(p.rest.through))) return { status: 'unavailable', reason: 'the coordinator did not fix the end of a shard\'s tail for its parts', calls: 0 }
  const sent = parts.reduce((a, p) => a + p.batches.reduce((x, b) => x + b.byteLength, 0), 0)
  const read = (i: number, budget: TailBudget, resume?: TailRead): Promise<PageOutcome> => {
    const p = parts[i]!
    const rest = p.rest!
    return readPages(stubOf(p.shard), p.shard, tenant, rest.incarnation, rest.above, keyRange ? { ...rest.filter, keyRange } : rest.filter, budget, 'leaf', { through: rest.through, ...(deadline === undefined ? {} : { deadline }), ...(resume ? { resume } : {}) })
  }
  const active = parts.map((_, i) => i).filter((i) => parts[i]!.rest !== null)
  const got = await readShared(
    active.length,
    cap,
    sent,
    (k, budget) => read(active[k]!, budget),
    (k, r, budget) => read(active[k]!, budget, r),
  )
  const calls = got.reduce((a, g) => a + (g ? g.calls : 0), 0)
  for (let k = 0; k < got.length; k++) {
    const g = got[k]
    if (!g || g.status === 'ok') continue
    const asked = parts[active[k]!]!.rest!.incarnation
    if (g.status === 'stale') return { status: 'stale', shard: g.shard, incarnation: asked, asked, calls }
    if (g.status === 'mismatch') return { status: 'mismatch', shard: g.shard, incarnation: g.incarnation, asked, calls }
    return { status: 'unavailable', reason: g.reason, calls }
  }
  const reads: (TailRead | null)[] = parts.map(() => null)
  active.forEach((i, k) => {
    const g = got[k]
    if (g && g.status === 'ok') reads[i] = g
  })
  const total = sent + reads.reduce((a, r) => a + (r ? r.bytes : 0), 0)
  if (reads.some((r) => r && !r.complete) || total > cap) return { status: 'too_large', bytes: total + reads.reduce((a, r) => a + (r ? r.overBytes : 0), 0), calls }
  return { status: 'ok', reads, bytes: total, calls }
}
