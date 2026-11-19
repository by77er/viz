/**
 * The coordinator: everything between a parsed HTTP request and the engine's answer.
 *
 *   plan     engine: which matchers and time ranges the query reads
 *   ledger   ONE version: live files of both tables and the watermark of every stream
 *   prune    engine: which files the ranges cannot touch (time and `__name__` statistics)
 *   fetch    leaves read the remaining files from R2, six at a time each
 *   tail     every shard the tenant may use is asked for rows above its watermark
 *   evaluate the WASM engine over (lake files, tail batches), under the tenant's limits
 *
 * The seam (design §2): the tail is read AFTER the plan and only above the plan's
 * watermarks. A shard that has discarded rows above the watermark it is asked about, or
 * whose stream is not the incarnation the ledger knows, refuses; the coordinator then
 * reads the ledger again and starts over. After a bounded number of refusals the query
 * fails with 503. It never answers from a result with a hole in it.
 *
 * The tenant is an argument that comes from the API key and nothing else. Every ledger,
 * shard and file read below is addressed by it.
 */
import type { ScanInput } from '../../contracts/engine'
import type { FileEntry, LiveFile, Plan, Watermark } from '../../contracts/ledger'
import { poolMap } from '../../edge/src/route'
import { ENGINE_LOAD_PREFIX, type FetchRange, type Grid, type LeafSummary, type QueryEngine, type QueryLimits, type QueryStats, leafSummary } from '../../engine/wasm-query/js/index'
import { hash32, shardName, tenantSlots } from '../../shard/src/pool'
import { type Env, type TenantLimits, fileCacheTtl, leafPoolSize } from './config'
import { type EvaluateAnswer, type EvaluateRequest, type EvaluateStats, type FileRef, MAX_BYTES_PER_CALL, MAX_READS_PER_CALL, type ReadItem, type ReadResult } from './leaf'

/** Largest and smallest timestamps storage can hold (contracts/BATCH.md). */
export const MIN_TS = 0
export const MAX_TS = 253_402_300_799_999

/** How often one query re-reads the ledger because its two table plans disagreed. */
export const MAX_VERSION_RETRIES = 4
/** How often one shard (or one missing file) may send a query back to the ledger. */
export const MAX_REFUSALS = 3
/** An object larger than this is read as several range reads, so no RPC message nears 32 MiB. */
export const MAX_PART_BYTES = 16 << 20

/** An error with a Prometheus `errorType`, on its way to an HTTP status. */
export class ApiError extends Error {
  constructor(
    readonly errorType: 'bad_data' | 'execution' | 'unavailable' | 'timeout' | 'internal',
    message: string,
  ) {
    super(message)
  }
}

/** What a query cost (design §6.5). Returned with every answer, as response headers. */
export interface Cost {
  /** Ledger version the answer reflects. */
  ledgerVersion: number
  /** Times the ledger was read: 1, plus one per refusal by a shard, missing file or version mismatch. */
  planAttempts: number
  /** Live files the ledger listed for the time range, both tables. */
  filesListed: number
  /** Of those, skipped from their index fragments. */
  filesSkipped: number
  filesRead: number
  /** Upper bound, from the row groups' row counts, on the lake samples the engine decodes. */
  scanSamples: number
  /** Bytes of data files handed to the engine. */
  bytesRead: number
  /** Reads answered by the Cache API instead of R2. */
  cacheHits: number
  r2Gets: number
  leafCalls: number
  leavesUsed: number
  /** Rounds of leaf calls (a leaf takes at most six reads per round). */
  leafRounds: number
  shardsAsked: number
  shardCalls: number
  tailBatches: number
  tailBytes: number
  seriesLoaded: number
  samplesLoaded: number
  engineMs: number
  wasmMemoryBytes: number
  /** `single` or `split` (empty for calls that do not evaluate PromQL). */
  execution: string
  /** Why a query was evaluated in one place. */
  splitReason: string
  /** Leaves a split query was evaluated on (parts of its series). */
  splitLeaves: number
  /** Reader calls the split leaves made (one per group of at most six files, per leaf). */
  readerCalls: number
  /** Bytes that crossed RPC for a split query: extracts, tail parts, leaf answers. */
  rpcBytes: number
  /** The largest engine memory a split leaf reported. */
  leafPeakWasmBytes: number
  /** The most samples one split leaf held. */
  leafMaxSamples: number
  /** Split leaves run again after stopping at their share of the budget. */
  leafReruns: number
}

export const newCost = (): Cost => ({
  ledgerVersion: 0, planAttempts: 0, filesListed: 0, filesSkipped: 0, filesRead: 0, scanSamples: 0, bytesRead: 0, cacheHits: 0, r2Gets: 0, leafCalls: 0,
  leavesUsed: 0, leafRounds: 0, shardsAsked: 0, shardCalls: 0, tailBatches: 0, tailBytes: 0, seriesLoaded: 0, samplesLoaded: 0, engineMs: 0, wasmMemoryBytes: 0,
  execution: '', splitReason: '', splitLeaves: 0, readerCalls: 0, rpcBytes: 0, leafPeakWasmBytes: 0, leafMaxSamples: 0, leafReruns: 0,
})

/**
 * Hooks for tests: a way to make the world change at the exact moments the seam exists
 * for. Empty in production.
 */
export const hooks: {
  /** Between the two `plan` calls of one ledger read. */
  betweenPlans?: (tenant: string) => Promise<void>
  /** After the ledger was read, before any shard or file is. */
  afterPlan?: (tenant: string, attempt: number) => Promise<void>
  /** Before each leaf call. */
  beforeLeafCall?: (leaf: number, items: ReadItem[]) => Promise<void>
  /** Overrides `MAX_PART_BYTES`, so that small files are read in ranges too. */
  maxPartBytes?: number
  /** Overrides `ISOLATE_BUDGET_BYTES`. */
  isolateBudgetBytes?: number
  /** Split every query that decomposes, over exactly this many leaves. */
  forceLeaves?: number
  /** Run split leaves one after another instead of at once (so each memory figure is its own). */
  sequentialLeaves?: boolean
  /** Before each call to a split leaf; may throw to simulate a failure. */
  beforeSplitLeaf?: (part: number, attempt: number) => Promise<void>
  /** The sample files' keys in the order they go to the engine (one place) or to the readers (split). */
  sampleOrder?: (keys: string[]) => void
  /** Replaces a shard's answer to `tailRead` (a release skew a test cannot otherwise make). */
  alterTail?: (shard: string, answer: unknown) => unknown
  /** Each split leaf's statistics and the header of its answer (for the measurement). */
  leafStats?: (part: number, stats: EvaluateStats, summary: LeafSummary) => void
} = {}

export interface Context {
  env: Env
  engine: QueryEngine
  tenant: string
  limits: TenantLimits
  cost: Cost
  /** Unix ms after which the query gives up with `timeout`. */
  deadline: number
  /** Spreads this query's reads over the leaf pool differently from any other query's. */
  queryId: string
}

// ───────────────────────────────── ledger ─────────────────────────────────

interface Snapshot {
  version: number
  ledgerIncarnation: number
  samples: LiveFile[]
  series: LiveFile[]
  watermarks: Watermark[]
}

/**
 * One consistent view of the ledger: both tables' live files and the watermarks, all at
 * the same version. The series plan is read first and the samples plan second; if the
 * ledger changed in between, both are read again. (A samples file is only readable with
 * the series file of the same flush unit, and the watermarks say what the files cover:
 * mixing versions could drop rows without any error.)
 */
async function snapshot(c: Context, minTs: number, maxTs: number): Promise<Snapshot> {
  const ledger = c.env.LEDGER.get(c.env.LEDGER.idFromName(c.tenant))
  for (let i = 0; i <= MAX_VERSION_RETRIES; i++) {
    c.cost.planAttempts++
    const series: Plan = await ledger.plan({ table: 'metric_series', minTs, maxTs })
    if (hooks.betweenPlans) await hooks.betweenPlans(c.tenant)
    const samples: Plan = await ledger.plan({ table: 'metric_samples', minTs, maxTs })
    if (samples.version === series.version && samples.ledgerIncarnation === series.ledgerIncarnation) {
      return { version: samples.version, ledgerIncarnation: samples.ledgerIncarnation, samples: samples.files, series: series.files, watermarks: samples.watermarks }
    }
    checkDeadline(c)
  }
  throw new ApiError('unavailable', 'the ledger kept changing while the query was being planned; retry')
}

/**
 * Sample files in the order the engine must read them: lowest precedence first, because
 * on a duplicate `(series, timestamp)` the LATER file wins (and any tail batch wins over
 * every file).
 *
 * The ledger assigns every live file a precedence (contracts/ledger.ts `LiveFile`,
 * design/DECISIONS.md D22) and `plan` lists files in ascending precedence, then key. That
 * order is used as it is; this re-states it from the fields (a stable sort that leaves a
 * correct plan untouched), so the order never depends on how keys sort as text.
 */
export function inPrecedenceOrder<F extends Pick<LiveFile, 'precedence' | 'key'>>(files: F[]): F[] {
  return files
    .map((f, i) => ({ f, i }))
    .sort((a, b) => a.f.precedence - b.f.precedence || (a.f.key < b.f.key ? -1 : a.f.key > b.f.key ? 1 : a.i - b.i))
    .map((x) => x.f)
}

// ───────────────────────────────── leaves ─────────────────────────────────

export interface Piece extends ReadItem {
  /** Index of the file this piece belongs to, and its position among the file's pieces. */
  file: number
  part: number
  bytes: number
}

/**
 * Spread the pieces over the leaf pool: rounds of at most one call per leaf, each call at
 * most `MAX_READS_PER_CALL` reads and `MAX_BYTES_PER_CALL` bytes. A piece starts at the
 * leaf chosen by a hash of the query id and its key (so concurrent queries, and the
 * pieces of one query, land on different leaves) and moves on to the next leaf with
 * room; when no leaf has room, a new round starts.
 */
export function assign(pieces: Piece[], pool: number, queryId: string): Map<number, Piece[]>[] {
  const rounds: Map<number, Piece[]>[] = []
  const load: Map<number, number>[] = []
  for (const p of pieces) {
    const start = hash32(`${queryId}\u0000${p.key}\u0000${p.part}`) % pool
    placed: for (let r = 0; ; r++) {
      if (!rounds[r]) {
        rounds[r] = new Map()
        load[r] = new Map()
      }
      for (let i = 0; i < pool; i++) {
        const leaf = (start + i) % pool
        const list = rounds[r]!.get(leaf) ?? []
        const used = load[r]!.get(leaf) ?? 0
        if (list.length < MAX_READS_PER_CALL && (list.length === 0 || used + p.bytes <= MAX_BYTES_PER_CALL)) {
          list.push(p)
          rounds[r]!.set(leaf, list)
          load[r]!.set(leaf, used + p.bytes)
          break placed
        }
      }
    }
  }
  return rounds
}

/** Whole-object reads, except that an object above `MAX_PART_BYTES` is cut into ranges. */
export function pieces(files: Pick<FileEntry, 'key' | 'bytes'>[], max = MAX_PART_BYTES): Piece[] {
  const out: Piece[] = []
  files.forEach((f, file) => {
    if (f.bytes <= max) {
      out.push({ key: f.key, file, part: 0, bytes: f.bytes })
      return
    }
    for (let offset = 0, part = 0; offset < f.bytes; offset += max, part++) {
      const length = Math.min(max, f.bytes - offset)
      out.push({ key: f.key, offset, length, file, part, bytes: length })
    }
  })
  return out
}

class MissingFile extends Error {
  constructor(readonly key: string) {
    super(`data file ${key} is listed by the ledger but is not in R2`)
  }
}

/**
 * Fetch `files` through the leaf pool. Resolves with one buffer per file, in order, or
 * rejects: with `MissingFile` if R2 does not have an object, with `ApiError` if a leaf
 * failed twice. There is no partial result.
 */
async function fetchFiles(c: Context, files: FileEntry[], have: Map<string, Uint8Array>): Promise<Uint8Array[]> {
  const todo = files.filter((f) => !have.has(f.key))
  const pool = leafPoolSize(c.env)
  const ttl = fileCacheTtl(c.env)
  const parts: Uint8Array[][] = todo.map(() => [])
  const used = new Set<number>()
  const stub = (leaf: number) => c.env.LEAF.get(c.env.LEAF.idFromName(`leaf/${c.env.CELL}/${leaf}`))

  const rounds = assign(pieces(todo, hooks.maxPartBytes), pool, c.queryId)
  for (const round of rounds) {
    checkDeadline(c)
    c.cost.leafRounds++
    await Promise.all(
      [...round].map(async ([leaf, list]) => {
        const items: ReadItem[] = list.map(({ key, offset, length }) => (offset === undefined ? { key } : { key, offset, length }))
        const call = async (to: number): Promise<ReadResult[]> => {
          if (hooks.beforeLeafCall) await hooks.beforeLeafCall(to, items)
          used.add(to)
          c.cost.leafCalls++
          const answer = await stub(to).read(items, ttl)
          // The leaf will not do what it was asked (too many reads, too many bytes): a
          // bug in the packing above, and no other leaf would answer differently.
          if (answer.status !== 'ok') throw new ApiError('unavailable', `a leaf refused to read data files: ${answer.reason}`)
          return answer.results
        }
        let results: ReadResult[]
        try {
          results = await call(leaf)
        } catch (first) {
          if (first instanceof ApiError) throw first
          // One retry, on the next leaf of the pool: a leaf that was evicted or reset
          // mid-call is not a reason to fail the query. A second failure is.
          try {
            results = await call((leaf + 1) % pool)
          } catch (e) {
            if (e instanceof ApiError) throw e
            throw new ApiError('unavailable', `could not read data files: ${e instanceof Error ? e.message : String(e)}`)
          }
        }
        if (results.length !== list.length) throw new ApiError('unavailable', 'a leaf answered for a different number of files than it was asked for')
        results.forEach((r, i) => {
          const p = list[i]!
          if (r.status !== 'ok') throw new MissingFile(p.key)
          // A short read would be a silent hole in a file: refuse it.
          if (r.bytes.byteLength !== p.bytes) throw new ApiError('unavailable', `data file ${p.key}: read ${r.bytes.byteLength} bytes, expected ${p.bytes}`)
          parts[p.file]![p.part] = r.bytes
          if (r.cached) c.cost.cacheHits++
          else c.cost.r2Gets++
        })
      }),
    )
  }
  c.cost.leavesUsed = Math.max(c.cost.leavesUsed, used.size)

  todo.forEach((f, i) => {
    const list = parts[i]!
    if (list.length === 1) {
      have.set(f.key, list[0]!)
      return
    }
    const whole = new Uint8Array(f.bytes)
    let at = 0
    for (const b of list) {
      whole.set(b, at)
      at += b.byteLength
    }
    have.set(f.key, whole)
  })
  return files.map((f) => have.get(f.key)!)
}

// ────────────────────────────────── tail ──────────────────────────────────

type Tail = { status: 'ok'; batches: Uint8Array[]; bytes: number } | { status: 'refused'; why: string }

/**
 * Rows of one shard above the ledger's watermark for it.
 *
 * `known` remembers, across re-plans of this query, the incarnation each shard said its
 * stream has. The cases:
 *
 *   - The ledger has a watermark for the shard: ask above it. `stale_watermark` (the
 *     shard discarded past it: a flush was recorded since the plan) and
 *     `incarnation_mismatch` are refusals; the caller re-reads the ledger.
 *   - After such a mismatch the fresh plan still has the older incarnation: the shard's
 *     stream is one the ledger has never registered, so everything in it is tail.
 *   - The ledger has never registered the shard: ask for the stream's incarnation, then
 *     read it from sequence 0. If a flush is recorded and discarded in between, the
 *     shard answers `stale_watermark` and the caller re-reads the ledger.
 *   - The ledger knows a NEWER incarnation than the shard has: the shard is behind the
 *     ledger, which cannot be answered correctly. Refused.
 */
async function readTail(c: Context, shard: string, w: Watermark | undefined, known: Map<string, number>): Promise<Tail> {
  const stub = c.env.SHARD.get(c.env.SHARD.idFromName(shard))
  let incarnation = w?.incarnation ?? 0
  let above = w?.seq ?? 0
  const learned = known.get(shard)
  if (learned !== undefined && learned > incarnation) {
    incarnation = learned
    above = 0
  }
  for (let call = 0; call < 2; call++) {
    c.cost.shardCalls++
    const raw = await stub.tailRead(c.tenant, incarnation, above)
    const r = hooks.alterTail ? (hooks.alterTail(shard, raw) as typeof raw) : raw
    if (r.status === 'ok') {
      if (!Array.isArray(r.batches)) throw new ApiError('unavailable', `shard ${shard} answered ok without batches; retry`)
      let bytes = 0
      const batches = r.batches.map((b) => {
        bytes += b.payload.byteLength
        return b.payload
      })
      return { status: 'ok', batches, bytes }
    }
    if (r.status === 'stale_watermark') return { status: 'refused', why: `shard ${shard} has discarded rows above the watermark` }
    // Every other status is handled by name (contracts/COMPATIBILITY.md §2.4, §3.2): a shard
    // whose storage is newer than this release reads, or a status it does not know, is a
    // retryable failure, never an empty tail and never a stream to re-read.
    const status: string = r.status
    if (status === 'schema_too_new') throw new ApiError('unavailable', `shard ${shard} runs a newer storage schema than this release reads (schema_too_new); retry`)
    if (status !== 'incarnation_mismatch') throw new ApiError('unavailable', `shard ${shard} answered a status this release does not know (${status.slice(0, 40)}); retry`)
    if (r.incarnation < incarnation) return { status: 'refused', why: `shard ${shard} is behind the ledger` }
    known.set(shard, r.incarnation)
    if (w) return { status: 'refused', why: `shard ${shard} has a newer stream than the ledger knows` }
    // Never registered by the ledger: all of the stream is tail.
    incarnation = r.incarnation
    above = 0
  }
  return { status: 'refused', why: `shard ${shard} changed its stream twice during one read` }
}

/** Shards to ask: every slot the tenant may write to, and every stream the ledger has registered. */
async function shardsOf(c: Context, watermarks: Watermark[]): Promise<string[]> {
  const map = await poolMap(c.env, c.tenant)
  const names = new Set(tenantSlots(map, c.tenant).map((slot) => shardName(map, slot)))
  for (const w of watermarks) names.add(w.shard)
  return [...names].sort()
}

// ───────────────────────────────── gather ─────────────────────────────────

export function checkDeadline(c: Context): void {
  if (Date.now() > c.deadline) throw new ApiError('timeout', 'query timed out')
}

/**
 * Bytes of data files this isolate has promised to hold for queries in flight. A query
 * that would take the total past the budget while others are running is refused with a
 * retryable 503 before it fetches anything (a query alone always runs: its own size is
 * bounded by `maxFetchBytes`). An isolate serves many requests at once and has 128 MB
 * for all of them.
 */
let inFlightBytes = 0
export const ISOLATE_BUDGET_BYTES = 48 << 20

const tooMuch = (c: Context, what: string, bytes: number): ApiError =>
  new ApiError(
    'execution',
    `query exceeded limit max_fetch_bytes: ${what} is ${bytes} bytes, the limit is ${c.limits.maxFetchBytes}. Narrow the time range, or select fewer metrics by name.`,
  )

/**
 * Everything the engine needs for `ranges` (the merged fetch plan), from one ledger
 * version: the files the ranges can touch and every shard's rows above its watermark.
 * Calls `evaluate` with it and returns its result. `reads` are the reads evaluation will
 * make (one per selector, unmerged): they size the scan before anything is fetched.
 */
/** A query that decomposes, with what the split path needs. */
export interface SplitSpec<T> {
  query: string
  grid: Grid
  fragments: number
  without: string[]
  /** The answer from the merged result. */
  done: (out: { json: string; stats: QueryStats }) => T
}

export async function gather<T>(c: Context, ranges: FetchRange[], reads: FetchRange[], evaluate: (input: ScanInput) => T, split?: SplitSpec<T>): Promise<T> {
  // No selector (`1 + 1`, `time()`): nothing to read, and no reason to wake anything.
  if (ranges.length === 0) return timed(c, evaluate, { seriesFiles: [], sampleFiles: [], tailBatches: [] })
  const minTs = Math.min(...ranges.map((r) => r.minTs))
  const maxTs = Math.max(...ranges.map((r) => r.maxTs))

  const have = new Map<string, Uint8Array>() // files already fetched by an earlier attempt of this query
  const refusals = new Map<string, number>()
  const known = new Map<string, number>()
  const refused = (who: string, why: string): void => {
    const n = (refusals.get(who) ?? 0) + 1
    refusals.set(who, n)
    if (n > MAX_REFUSALS) throw new ApiError('unavailable', `${why}, and the ledger does not catch up; retry later`)
  }
  let reserved = 0
  try {
    for (let attempt = 1; ; attempt++) {
      checkDeadline(c)
      const snap = await snapshot(c, minTs, maxTs)
      c.cost.ledgerVersion = snap.version
      if (hooks.afterPlan) await hooks.afterPlan(c.tenant, attempt)

      // Which files can the ranges touch? Both tables in one call. Sample files go to the
      // engine lowest precedence first (see `inPrecedenceOrder`).
      snap.samples = inPrecedenceOrder(snap.samples)
      const listed = [...snap.series, ...snap.samples]
      const keep = c.engine.filesNeeded(listed.map((f) => f.index), ranges)
      const series = snap.series.filter((_, i) => keep[i])
      const samples = snap.samples.filter((_, i) => keep[snap.series.length + i])
      // How many samples would the engine decode? Known from the row groups' row counts,
      // before anything is fetched. The engine's own `max_samples` fires only after a
      // selector's samples are in memory, so this is what keeps a too-large query from
      // being materialised at all.
      const rows = c.engine.scanRows(samples.map((f) => f.index), reads)
      const scan = rows.reduce<number>((a, r, i) => a + (r ?? samples[i]!.rows * reads.length), 0)
      const wanted = [...series, ...samples]
      // Recorded before any limit is checked, so a refused query still says what it would have cost.
      c.cost.scanSamples = scan
      c.cost.filesListed = listed.length
      c.cost.filesSkipped = listed.length - wanted.length
      const lakeBytesAll = wanted.reduce((a, f) => a + f.bytes, 0)
      if (split && (hooks.forceLeaves !== undefined || scan > c.limits.splitAboveSamples || lakeBytesAll > c.limits.maxFetchBytes || wanted.length > c.limits.maxFiles)) {
        // ── Split execution: leaves read and evaluate parts of the series; only the tail is held here. ──
        c.cost.execution = 'split'
        c.cost.splitReason = ''
        if (scan > c.limits.maxQueryScanSamples) {
          throw new ApiError('execution', `query exceeded limit max_query_scan_samples: the data files in range hold ${scan} samples the query would decode, the limit is ${c.limits.maxQueryScanSamples}. Narrow the time range, or select fewer metrics by name.`)
        }
        if (wanted.length > c.limits.maxQueryFiles) throw new ApiError('execution', `query exceeded limit max_query_files: ${wanted.length} data files to read, the limit is ${c.limits.maxQueryFiles}. Narrow the time range.`)
        if (lakeBytesAll > c.limits.maxQueryFetchBytes) {
          throw new ApiError('execution', `query exceeded limit max_query_fetch_bytes: the ${wanted.length} data files in range are ${lakeBytesAll} bytes, the limit is ${c.limits.maxQueryFetchBytes}. Narrow the time range, or select fewer metrics by name.`)
        }
        const shards = await shardsOf(c, snap.watermarks)
        c.cost.shardsAsked = shards.length
        const tails = await Promise.all(shards.map((s) => readTail(c, s, snap.watermarks.find((w) => w.shard === s), known)))
        let again = false
        shards.forEach((s, i) => {
          const t = tails[i]!
          if (t.status === 'refused') {
            refused(`shard ${s}`, t.why)
            again = true
          }
        })
        if (again) continue
        const tailBatches = tails.flatMap((t) => (t.status === 'ok' ? t.batches : []))
        const tailBytes = tails.reduce((a, t) => a + (t.status === 'ok' ? t.bytes : 0), 0)
        // The coordinator holds the tail while it cuts it by part.
        if (tailBytes > c.limits.maxFetchBytes) throw tooMuch(c, 'the unflushed tail', tailBytes)
        c.cost.filesRead = wanted.length
        c.cost.bytesRead = lakeBytesAll
        c.cost.tailBatches = tailBatches.length
        c.cost.tailBytes = tailBytes
        checkDeadline(c)
        const r = await runSplit(c, split, ranges, series, samples, tailBatches, scan + Math.ceil(tailBytes / 20))
        if (r.status === 'missing') {
          refused(`file ${r.key}`, `data file ${r.key} is listed by the ledger but is not in R2`)
          continue
        }
        return split.done(r.out)
      }
      if (split) {
        c.cost.execution = 'single'
        c.cost.splitReason = 'the query fits in one place'
      }
      if (scan > c.limits.maxScanSamples) {
        throw new ApiError(
          'execution',
          `query exceeded limit max_scan_samples: the data files in range hold ${scan} samples the query would decode, the limit is ${c.limits.maxScanSamples}. Narrow the time range, or select fewer metrics by name.`,
        )
      }
      if (wanted.length > c.limits.maxFiles) {
        throw new ApiError('execution', `query exceeded limit max_files: ${wanted.length} data files to read, the limit is ${c.limits.maxFiles}. Narrow the time range.`)
      }
      // Known before anything is fetched: the ledger has every file's size.
      const lakeBytes = wanted.reduce((a, f) => a + f.bytes, 0)
      if (lakeBytes > c.limits.maxFetchBytes) throw tooMuch(c, `the ${wanted.length} data files in range`, lakeBytes)
      if (reserved === 0) {
        if (inFlightBytes > 0 && inFlightBytes + lakeBytes > (hooks.isolateBudgetBytes ?? ISOLATE_BUDGET_BYTES)) throw new ApiError('unavailable', 'the query service is busy; retry')
        reserved = Math.max(lakeBytes, 1)
        inFlightBytes += reserved
      }

      // Tails strictly after the plan; shards and leaves in parallel.
      const shards = await shardsOf(c, snap.watermarks)
      c.cost.shardsAsked = shards.length
      const files = fetchFiles(c, wanted, have).then(
        (bytes) => ({ ok: true as const, bytes }),
        (error: unknown) => ({ ok: false as const, error }),
      )
      const tails = await Promise.all(shards.map((s) => readTail(c, s, snap.watermarks.find((w) => w.shard === s), known)))

      let again = false
      shards.forEach((s, i) => {
        const t = tails[i]!
        if (t.status === 'refused') {
          refused(`shard ${s}`, t.why)
          again = true
        }
      })
      const got = await files
      if (!got.ok) {
        if (!(got.error instanceof MissingFile)) throw got.error
        // The ledger listed it and R2 does not have it: the plan is older than a
        // deletion (compaction, retention). Read the ledger again; never answer without it.
        refused(`file ${got.error.key}`, got.error.message)
        again = true
      }
      if (again) continue

      const tailBatches = tails.flatMap((t) => (t.status === 'ok' ? t.batches : []))
      const tailBytes = tails.reduce((a, t) => a + (t.status === 'ok' ? t.bytes : 0), 0)
      if (lakeBytes + tailBytes > c.limits.maxFetchBytes) throw tooMuch(c, 'the data files in range plus the unflushed tail', lakeBytes + tailBytes)
      c.cost.filesRead = wanted.length
      c.cost.bytesRead = lakeBytes
      c.cost.tailBatches = tailBatches.length
      c.cost.tailBytes = tailBytes
      checkDeadline(c)

      if (hooks.sampleOrder) hooks.sampleOrder(samples.map((f) => f.key))
      const all = got.ok ? got.bytes : []
      const input: ScanInput = { seriesFiles: all.slice(0, series.length), sampleFiles: all.slice(series.length), tailBatches }
      return timed(c, evaluate, input)
    }
  } finally {
    inFlightBytes -= reserved
  }
}

// ──────────────────────────────── split ────────────────────────────────

/**
 * A samples file and the series file written with it have the same key once the table
 * name and the content hash are removed (contracts/TABLES.md, "Pairing").
 */
export const pairKey = (key: string): string => key.replace(/\/metric_(samples|series)\//, '/*/').replace(/-[0-9a-f]{8}\.parquet$/, '')

/**
 * Reader groups: sample files in precedence order, each with its series file, packed
 * into calls of at most six reads and 24 MiB. A group never reorders files, so the
 * leaves can rank groups by position.
 */
export function readerGroups(series: FileEntry[], samples: FileEntry[]): { series: FileRef[]; samples: FileRef[] }[] {
  const byPair = new Map(series.map((f) => [pairKey(f.key), f]))
  const groups: { series: FileRef[]; samples: FileRef[] }[] = []
  let cur: { series: FileRef[]; samples: FileRef[] } | null = null
  let bytes = 0
  for (const f of samples) {
    const s = byPair.get(pairKey(f.key))
    if (!s) throw new ApiError('internal', `the plan has no series file for ${f.key}`)
    const add = f.bytes + s.bytes
    if (!cur || cur.series.length + cur.samples.length + 2 > MAX_READS_PER_CALL || bytes + add > MAX_BYTES_PER_CALL) {
      cur = { series: [], samples: [] }
      groups.push(cur)
      bytes = 0
    }
    cur.series.push({ key: s.key, bytes: s.bytes })
    cur.samples.push({ key: f.key, bytes: f.bytes })
    bytes += add
  }
  return groups
}

/** `total` cut into `n` shares that add up to it. */
const share = (total: number, n: number, j: number): number => Math.floor(total / n) + (j < total % n ? 1 : 0)

/**
 * Evaluate a split query: `L` leaves, each owning a range of series keys, each pulling
 * its rows from readers and evaluating the query's fragments; then merge here. Leaves
 * that stop at their share of the budget are run again with what the others left, once.
 */
async function runSplit<T>(
  c: Context,
  spec: SplitSpec<T>,
  ranges: FetchRange[],
  series: FileEntry[],
  samples: FileEntry[],
  tails: Uint8Array[],
  estimate: number,
): Promise<{ status: 'ok'; out: { json: string; stats: QueryStats } } | { status: 'missing'; key: string }> {
  const pool = leafPoolSize(c.env)
  const L = hooks.forceLeaves ?? Math.min(Math.max(2, Math.ceil(estimate / (0.75 * c.limits.maxSamples))), Math.max(1, Math.min(c.limits.maxLeaves, pool)))
  c.cost.splitLeaves = L
  // The query's budget, and each leaf's share of it (never more than one isolate may hold).
  const qSamples = Math.min(c.limits.maxQuerySamples, L * c.limits.maxSamples)
  const qSeries = Math.min(c.limits.maxQuerySeries, L * c.limits.maxSeries)
  const groups = readerGroups(series, samples)
  if (hooks.sampleOrder) hooks.sampleOrder(groups.flatMap((g) => g.samples.map((f) => f.key)))
  const parts = c.engine.splitTails(tails, spec.without, L, ranges)
  const ttl = fileCacheTtl(c.env)
  const base = hash32(c.queryId)
  const used = new Set<number>()
  const leaf = (n: number) => c.env.LEAF.get(c.env.LEAF.idFromName(`leaf/${c.env.CELL}/${n % pool}`))

  const run = async (j: number, budget: { samples: number; series: number }): Promise<EvaluateAnswer> => {
    const req: EvaluateRequest = {
      query: spec.query, grid: spec.grid, fragments: spec.fragments, without: spec.without, part: j, parts: L, ranges, groups, tails: parts[j]!,
      budget: { samples: budget.samples, series: budget.series, stepPoints: c.limits.maxStepPoints }, limits: c.limits, cacheTtlS: ttl, pool, queryId: c.queryId,
    }
    const call = async (attempt: number): Promise<EvaluateAnswer> => {
      used.add((base + j + attempt) % pool)
      c.cost.leafCalls++
      if (hooks.beforeSplitLeaf) await hooks.beforeSplitLeaf(j, attempt)
      c.cost.rpcBytes += parts[j]!.reduce((a, b) => a + b.byteLength, 0)
      return leaf(base + j + attempt).evaluate(req)
    }
    let a: EvaluateAnswer
    try {
      a = await call(0)
    } catch {
      // One retry on the next leaf; the first attempt's answer, if any, was lost with it.
      try {
        a = await call(1)
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e)
        // A module that does not load will not load on a retry either (500, not 503).
        if (m.startsWith(ENGINE_LOAD_PREFIX)) throw new ApiError('internal', `a split leaf could not load the query engine: ${m}`)
        throw new ApiError('unavailable', `a split leaf failed twice: ${m}`)
      }
    }
    if (a.status === 'refused') throw new ApiError('unavailable', `a leaf refused to read data files: ${a.reason}`)
    if (a.status === 'ok') {
      const st = a.stats
      c.cost.readerCalls += st.readerCalls
      c.cost.cacheHits += st.cacheHits
      c.cost.r2Gets += st.r2Gets
      c.cost.rpcBytes += st.extractBytes + a.answer.byteLength
      c.cost.leafPeakWasmBytes = Math.max(c.cost.leafPeakWasmBytes, st.wasmMemoryBytes)
      const sum = leafSummary(a.answer)
      c.cost.leafMaxSamples = Math.max(c.cost.leafMaxSamples, sum.gatheredSamples)
      if (hooks.leafStats) hooks.leafStats(j, st, sum)
    }
    return a
  }

  const runAll = async (jobs: [number, { samples: number; series: number }][]): Promise<EvaluateAnswer[]> => {
    if (!hooks.sequentialLeaves) return Promise.all(jobs.map(([j, b]) => run(j, b)))
    const out: EvaluateAnswer[] = []
    for (const [j, b] of jobs) out.push(await run(j, b))
    return out
  }

  checkDeadline(c)
  const first = await runAll(Array.from({ length: L }, (_, j) => [j, { samples: share(qSamples, L, j), series: share(qSeries, L, j) }] as [number, { samples: number; series: number }]))
  c.cost.leavesUsed = Math.max(c.cost.leavesUsed, used.size)
  const missing = first.find((a) => a.status === 'missing')
  if (missing && missing.status === 'missing') return { status: 'missing', key: missing.key }
  const answers = first.map((a) => (a.status === 'ok' ? a.answer : new Uint8Array()))

  // Leaves that stopped at their share: what they held is a lower bound of what they
  // would load, so the query's total is at least the sum of everyone's counts.
  for (let round = 0; ; round++) {
    const sums = answers.map(leafSummary)
    const stopped = sums.map((s, j) => (s.status === 'aborted' ? j : -1)).filter((j) => j >= 0)
    if (stopped.length === 0) break
    const low = (s: (typeof sums)[number]) => ({ samples: Math.max(s.gatheredSamples, s.loadedSamples), series: Math.max(s.gatheredSeries, s.loadedSeries) })
    const total = sums.reduce((a, s) => ({ samples: a.samples + low(s).samples, series: a.series + low(s).series }), { samples: 0, series: 0 })
    if (total.series > qSeries) throw new ApiError('execution', `query exceeded limit max_series: at least ${total.series} series loaded, the limit is ${qSeries} (over ${L} leaves)`)
    if (total.samples > qSamples) throw new ApiError('execution', `query exceeded limit max_samples: at least ${total.samples} samples loaded, the limit is ${qSamples} (over ${L} leaves)`)
    if (round > 0) {
      throw new ApiError(
        'execution',
        `query exceeded limit max_samples: one leaf's part holds more than one isolate may load (${c.limits.maxSamples} samples or ${c.limits.maxSeries} series); the series are unevenly spread over the ${L} leaves`,
      )
    }
    // Run them again with what the others left, never more than one isolate may hold.
    const rerun = await runAll(
      stopped.map((j) => {
        const others = sums.reduce((a, s, k) => (k === j ? a : { samples: a.samples + low(s).samples, series: a.series + low(s).series }), { samples: 0, series: 0 })
        return [j, { samples: Math.min(c.limits.maxSamples, qSamples - others.samples), series: Math.min(c.limits.maxSeries, qSeries - others.series) }] as [number, { samples: number; series: number }]
      }),
    )
    c.cost.leafReruns += stopped.length
    for (let k = 0; k < stopped.length; k++) {
      const a = rerun[k]!
      if (a.status === 'missing') return { status: 'missing', key: a.key }
      if (a.status === 'ok') answers[stopped[k]!] = a.answer
    }
  }
  checkDeadline(c)
  const limits: QueryLimits = { ...c.limits, maxSamples: qSamples, maxSeries: qSeries, maxStepPoints: L * c.limits.maxStepPoints }
  const t0 = performance.now()
  try {
    return { status: 'ok', out: c.engine.mergeJson(answers, spec.query, spec.grid, limits) }
  } finally {
    c.cost.engineMs += Math.round(performance.now() - t0)
    c.cost.wasmMemoryBytes = c.engine.memoryBytes()
  }
}

// ───────────────────────────── cardinality ─────────────────────────────

/**
 * The cardinality report over `[start, end]`: the tenant's `metric_series` files from
 * `lookbackStart` to `end` (one ledger version) and every shard's tail above the
 * watermarks, with the same fence as a query. Counted in one place, or, when the series
 * files do not fit one place (or a test forces it), over leaves that each own a range of
 * `series_id`s and read every series file.
 */
export async function cardinality(c: Context, start: number, end: number, lookbackStart: number, limit: number): Promise<{ tsdb: string; cardinality: string }> {
  const caps = { maxSeries: c.limits.maxCardinalitySeries, maxPairs: c.limits.maxCardinalityPairs }
  const have = new Map<string, Uint8Array>()
  const refusals = new Map<string, number>()
  const known = new Map<string, number>()
  const refused = (who: string, why: string): void => {
    const n = (refusals.get(who) ?? 0) + 1
    refusals.set(who, n)
    if (n > MAX_REFUSALS) throw new ApiError('unavailable', `${why}, and the ledger does not catch up; retry later`)
  }
  for (;;) {
    checkDeadline(c)
    const snap = await snapshot(c, lookbackStart, end)
    c.cost.ledgerVersion = snap.version
    // Prune by time only (no matchers): every series file that can hold a series of the window.
    const keep = c.engine.filesNeeded(snap.series.map((f) => f.index), [{ matchers: [], minTs: lookbackStart, maxTs: end }])
    const files = snap.series.filter((_, i) => keep[i])
    c.cost.filesListed = snap.series.length
    c.cost.filesSkipped = snap.series.length - files.length
    const bytes = files.reduce((a, f) => a + f.bytes, 0)
    if (files.length > c.limits.maxQueryFiles) throw new ApiError('execution', `query exceeded limit max_query_files: ${files.length} series files to read, the limit is ${c.limits.maxQueryFiles}. Narrow the time range.`)
    if (bytes > c.limits.maxQueryFetchBytes) throw tooMuch(c, `the ${files.length} series files in range`, bytes)
    const shards = await shardsOf(c, snap.watermarks)
    c.cost.shardsAsked = shards.length
    const tails = await Promise.all(shards.map((s) => readTail(c, s, snap.watermarks.find((w) => w.shard === s), known)))
    let again = false
    shards.forEach((s, i) => {
      const t = tails[i]!
      if (t.status === 'refused') {
        refused(`shard ${s}`, t.why)
        again = true
      }
    })
    if (again) continue
    const tailBatches = tails.flatMap((t) => (t.status === 'ok' ? t.batches : []))
    const tailBytes = tails.reduce((a, t) => a + (t.status === 'ok' ? t.bytes : 0), 0)
    if (tailBytes > c.limits.maxFetchBytes) throw tooMuch(c, 'the unflushed tail', tailBytes)
    c.cost.tailBatches = tailBatches.length
    c.cost.tailBytes = tailBytes
    c.cost.filesRead = files.length
    c.cost.bytesRead = bytes
    const pool = leafPoolSize(c.env)
    const rows = files.reduce((a, f) => a + f.rows, 0)
    const L = hooks.forceLeaves ?? (bytes > c.limits.maxFetchBytes ? Math.min(Math.max(2, Math.ceil(rows / 250_000)), Math.max(1, Math.min(c.limits.maxLeaves, pool))) : 1)
    let summaries: Uint8Array[]
    if (L === 1) {
      c.cost.execution = 'single'
      let got: Uint8Array[]
      try {
        got = await fetchFiles(c, files, have)
      } catch (e) {
        if (!(e instanceof MissingFile)) throw e
        refused(`file ${e.key}`, e.message)
        continue
      }
      const t0 = performance.now()
      summaries = [c.engine.cardinalityPart(got, tailBatches, start, end, 0, 1, caps)]
      c.cost.engineMs += Math.round(performance.now() - t0)
    } else {
      c.cost.execution = 'split'
      c.cost.splitLeaves = L
      const refs = files.map((f) => ({ key: f.key, bytes: f.bytes }))
      const base = hash32(c.queryId)
      const answers = await Promise.all(
        Array.from({ length: L }, async (_, j) => {
          const req = { files: refs, tails: tailBatches, part: j, parts: L, start, end, caps, cacheTtlS: fileCacheTtl(c.env) }
          const call = (attempt: number) => {
            c.cost.leafCalls++
            c.cost.rpcBytes += tailBytes
            return c.env.LEAF.get(c.env.LEAF.idFromName(`leaf/${c.env.CELL}/${(base + j + attempt) % pool}`)).cardinality(req)
          }
          try {
            return await call(0)
          } catch {
            return await call(1)
          }
        }),
      )
      const missing = answers.find((a) => a.status === 'missing')
      if (missing && missing.status === 'missing') {
        refused(`file ${missing.key}`, `data file ${missing.key} is listed by the ledger but is not in R2`)
        continue
      }
      summaries = answers.map((a) => (a.status === 'ok' ? a.summary : new Uint8Array()))
      for (const a of answers) {
        if (a.status === 'ok') {
          c.cost.rpcBytes += a.summary.byteLength
          c.cost.cacheHits += a.cacheHits
          c.cost.r2Gets += a.r2Gets
        }
      }
    }
    const t0 = performance.now()
    try {
      return c.engine.cardinalityReport(summaries, limit, start, end, lookbackStart, caps)
    } finally {
      c.cost.engineMs += Math.round(performance.now() - t0)
      c.cost.wasmMemoryBytes = c.engine.memoryBytes()
    }
  }
}

function timed<T>(c: Context, evaluate: (input: ScanInput) => T, input: ScanInput): T {
  const t0 = performance.now()
  try {
    return evaluate(input)
  } finally {
    c.cost.engineMs += Math.round(performance.now() - t0)
    c.cost.wasmMemoryBytes = c.engine.memoryBytes()
  }
}

export function addStats(c: Context, stats: QueryStats): void {
  c.cost.seriesLoaded += stats.series
  c.cost.samplesLoaded += stats.samples
}
