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
import { TAIL_PAGE_MAX_BYTES, TAIL_READ_VERSION, type TailFilter, type TailReadOptions } from '../../shard/src/tail'

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

/** Bytes a read may take, shared by the reads of one query (the coordinator) or one leaf. */
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
   * no page was answered (the first kept batch did not fit the budget), so it is not known.
   */
  through: number | null
  /** Batches in sequence order: filtered when `paged`, else the whole tail above `above`. */
  batches: { seq: number; payload: Uint8Array }[]
  bytes: number
  /** False: the shard answered without `page` (the previous release): unfiltered and unpaged. */
  paged: boolean
  /** False: the read stopped at the budget and more of the tail remains. */
  complete: boolean
  /** Bytes of the batch that did not fit (`page_limit`), when that is why it stopped. */
  overBytes: number
  calls: number
  scannedBatches: number
  scannedBytes: number
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
  through?: number | null,
  alter?: (answer: unknown) => unknown,
): Promise<PageOutcome> {
  const out: TailRead = { status: 'ok', shard, incarnation, above, through: null, batches: [], bytes: 0, paged: true, complete: true, overBytes: 0, calls: 0, scannedBatches: 0, scannedBytes: 0 }
  const previous = tailHooks.previousRelease?.(shard, where) ?? false
  const unavailable = (reason: string): PageOutcome => ({ status: 'unavailable', shard, reason, calls: out.calls })
  let cursor: string | undefined
  for (let page = 0; ; page++) {
    // At least one byte: a kept batch that does not fit comes back as `page_limit`, never cut.
    const maxBytes = Math.min(TAIL_PAGE_MAX_BYTES, Math.max(1, budget.cap - budget.used))
    const opts: TailReadOptions = { v: TAIL_READ_VERSION, ...filter, maxBytes, ...(cursor === undefined ? {} : { cursor }) }
    out.calls++
    const raw = (previous ? await stub.tailRead(tenant, incarnation, above) : await stub.tailRead(tenant, incarnation, above, opts)) as unknown
    const r = (alter ? alter(raw) : tailHooks.alter ? tailHooks.alter(shard, raw, where) : raw) as TailResult
    const status: string = r.status
    if (r.status === 'ok') {
      if (!Array.isArray(r.batches)) return unavailable(`shard ${shard} answered ok without batches`)
      if (r.page === undefined) {
        // The previous release: the whole tail above the watermark in one answer. Never in the
        // middle of a paged read (a shard rolled back between two pages): that is refused.
        if (page > 0) return unavailable(`shard ${shard} stopped paging in the middle of a read`)
        out.paged = false
        out.through = r.through
        for (const b of r.batches) {
          if (through !== undefined && through !== null && b.seq > through) continue
          out.batches.push({ seq: b.seq, payload: b.payload })
          out.bytes += b.payload.byteLength
        }
        budget.used += out.bytes
        return out
      }
      if (typeof r.page !== 'object' || r.page === null || r.page.v !== TAIL_READ_VERSION) return unavailable(`shard ${shard} answered a page of a version this release does not read`)
      if (page === 0) out.through = r.through
      let got = 0
      for (const b of r.batches) {
        // A leaf reads the rest of what the coordinator saw, and no later append.
        if (through !== undefined && through !== null && b.seq > through) continue
        out.batches.push({ seq: b.seq, payload: b.payload })
        got += b.payload.byteLength
      }
      out.bytes += got
      budget.used += got
      out.scannedBatches += r.page.scannedBatches
      out.scannedBytes += r.page.scannedBytes
      if (r.page.next === null) return out
      cursor = r.page.next
      continue
    }
    if (r.status === 'page_limit') {
      // The rows this read keeps of one batch do not fit what the budget has left.
      out.complete = false
      out.overBytes = typeof r.bytes === 'number' && r.bytes > 0 ? r.bytes : 1
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

/**
 * A `VZB1` batch cut by `series_id` into `parts`: part `j` holds the rows of the series whose
 * id (unsigned) is in `splitKeyRange(j, parts)`, in their order, with those series' entries
 * copied as stored and every timestamp and value copied as bytes; null for a part with no
 * row, and the batch itself for a part that holds every row. The same bytes the shard's
 * filter returns for that key range (`shard/src/tail.ts` `filterBatch`; tested against it),
 * in one pass for all parts, without the engine: the coordinator cuts what it read of a tail
 * that did not fit, holding about twice its bytes and nothing per series.
 */
export function cutById(payload: Uint8Array, parts: number): (Uint8Array | null)[] {
  const bad = (why: string) => new Error(`not a VZB1 batch: ${why}`)
  if (!Number.isSafeInteger(parts) || parts < 1 || parts > 1 << 16) throw new RangeError('cutById: bad parts')
  if (payload.length < 16 || payload[0] !== 0x56 || payload[1] !== 0x5a || payload[2] !== 0x42 || payload[3] !== 0x31 || payload[4] !== 1) throw bad('header')
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  const nRows = dv.getUint32(8, true)
  const nSeries = dv.getUint32(12, true)
  const starts = new Uint32Array(nSeries + 1)
  const partOf = new Uint32Array(nSeries)
  const TWO32 = 4294967296
  let p = 16
  for (let s = 0; s < nSeries; s++) {
    starts[s] = p
    if (p + 12 > payload.length) throw bad('series table')
    // part = floor(id * parts / 2^64), exactly: hi * parts and lo * parts are below 2^53.
    const lo = dv.getUint32(p, true)
    const hi = dv.getUint32(p + 4, true)
    partOf[s] = Math.floor((hi * parts + Math.floor((lo * parts) / TWO32)) / TWO32)
    const nLabels = dv.getUint32(p + 8, true)
    p += 12
    for (let l = 0; l < 2 * nLabels; l++) {
      if (p + 2 > payload.length) throw bad('label')
      p += 2 + dv.getUint16(p, true)
      if (p > payload.length) throw bad('label')
    }
  }
  starts[nSeries] = p
  const pad8 = (n: number) => (n + 7) & ~7
  const idxAt = pad8(p)
  const tsAt = idxAt + pad8(4 * nRows)
  const valAt = tsAt + 8 * nRows
  if (valAt + 8 * nRows !== payload.length) throw bad('row arrays')
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
 * kept, and for a read stopped at the budget its stored batches left (`through` minus those
 * examined) at the average stored size times the share kept so far; and the distinct series
 * seen (a lower bound). Only to size a split, never to refuse or to answer.
 */
export function tailEstimate(reads: TailRead[]): { bytes: number; series: number } {
  let bytes = 0
  let kept = 0
  const ids = new Set<string>()
  for (const r of reads) {
    kept += r.bytes
    seriesIdsOf(
      r.batches.map((b) => b.payload),
      ids,
    )
    bytes += r.bytes + r.overBytes
    if (r.complete) continue
    // (The batch that did not fit is in `overBytes`, and not in `scannedBatches`; an unknown end adds nothing.)
    const left = r.through === null ? 0 : Math.max(0, r.through - r.above - r.scannedBatches - (r.overBytes > 0 ? 1 : 0))
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
   * This part's rows of what the coordinator read, cut by `series_id` (`cutById`, the same
   * cut as the shard's key range), in order. A part whose split key leaves labels out checks
   * them as it checks the rest.
   */
  batches: Uint8Array[]
  /**
   * The rest of the tail, above the last batch the coordinator read: the part reads it with
   * `filter` and its key range, through `through` (what the coordinator saw: no later append),
   * or to the shard's end when the coordinator saw no page (null).
   */
  rest: { incarnation: number; above: number; through: number | null; filter: TailFilter } | null
}

/** The rest reads of a part, from the leaf's side. */
export type RestOutcome =
  | { status: 'ok'; reads: (TailRead | null)[]; bytes: number; calls: number }
  | { status: 'stale'; shard: string; incarnation: number; asked: number; calls: number }
  | { status: 'mismatch'; shard: string; incarnation: number; asked: number; calls: number }
  | { status: 'too_large'; bytes: number; calls: number }
  | { status: 'unavailable'; reason: string; calls: number }

/**
 * Read the rests of `parts` (each in `keyRange`), in parallel, under `cap` bytes for the
 * part's whole tail (what the coordinator sent counts too). One answer for all shards: the
 * first refusal by name, else every shard's batches.
 */
export async function readRests(
  stubOf: (shard: string) => ShardStub,
  tenant: string,
  parts: TailPart[],
  keyRange: { lo: string; hi: string } | null,
  cap: number,
): Promise<RestOutcome> {
  const budget: TailBudget = { cap, used: parts.reduce((a, p) => a + p.batches.reduce((x, b) => x + b.byteLength, 0), 0) }
  const got = await Promise.all(
    parts.map((p) => (p.rest === null ? null : readPages(stubOf(p.shard), p.shard, tenant, p.rest.incarnation, p.rest.above, keyRange ? { ...p.rest.filter, keyRange } : p.rest.filter, budget, 'leaf', p.rest.through))),
  )
  const calls = got.reduce((a, g) => a + (g ? g.calls : 0), 0)
  for (let i = 0; i < got.length; i++) {
    const g = got[i]
    if (!g || g.status === 'ok') continue
    const asked = parts[i]!.rest!.incarnation
    if (g.status === 'stale') return { status: 'stale', shard: g.shard, incarnation: asked, asked, calls }
    if (g.status === 'mismatch') return { status: 'mismatch', shard: g.shard, incarnation: g.incarnation, asked, calls }
    return { status: 'unavailable', reason: g.reason, calls }
  }
  const reads = got.map((g) => (g && g.status === 'ok' ? g : null))
  if (reads.some((r) => r && !r.complete) || budget.used > cap) return { status: 'too_large', bytes: budget.used + reads.reduce((a, r) => a + (r ? r.overBytes : 0), 0), calls }
  return { status: 'ok', reads, bytes: budget.used, calls }
}
