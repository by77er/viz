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
import { checkSignal, signalOfShard, withSignal } from './shards'
import { ENGINE_LOAD_PREFIX, type FetchRange, type FilePlan, type FileRead, type Grid, type LeafSummary, QueryError, type QueryEngine, type QueryLimits, type QueryStats, leafSummary, planBytes, sparseFile } from '../../engine/wasm-query/js/index'
import { hash32, shardName, tenantSlots } from '../../shard/src/pool'
import { type Env, type TenantLimits, fileCacheTtl, leafPoolSize } from './config'
import { type EvaluateAnswer, type EvaluateRequest, type EvaluateStats, type FileRef, MAX_BYTES_PER_CALL, MAX_READS_PER_CALL, type CardinalityRequest, type MetaAnswer, type MetaRequest, type ReadItem, type ReadResult, type TailRefusal } from './leaf'
import { byCodePoint, byLabels } from './meta'
import { type PageOutcome, type TailBudget, type TailFilter, type TailPart, type TailRead, cutByKey, readPages, readShared, tailEstimate, tailFilter } from './tail'

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
    readonly errorType: 'bad_data' | 'execution' | 'unavailable' | 'timeout' | 'internal' | 'not_found' | 'unsupported',
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
  /** Series the query loads, estimated from the series files before anything is fetched (`seriesEstimate`). */
  seriesEstimate: number
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
  /**
   * How the files to read were chosen: `fragments` (by name and time from the index
   * fragments, as before 2026-11-19, now with byte ranges), or `series` (the matchers were
   * resolved against the series files first, and only row groups holding a selected
   * series were read: CARDINALITY.md item 2).
   */
  pruning: string
  /**
   * How the shards' tails were read: `filtered` (every shard applied the read's filter and
   * paged, D48), `unfiltered` (a shard of the previous release answered with its whole tail),
   * with `+leaves` when the tail did not fit the coordinator and each split part read the
   * rest of it, in its own key range, itself. Empty when no shard was read.
   */
  tailMode: string
  /**
   * How a split's readers read the series files: `id-range` (each part its `series_id` range,
   * ABI 5), `name-time` (by name and time: the key leaves out a label series carry, or a test
   * asked), `id-range,name-time` (a part saw a foreign series, so the split ran again by name
   * and time). Empty when nothing was split.
   */
  seriesReads: string
  /** Traces and logs: rows of the row groups the index fragments say a query reads (checked against `maxSpans` / `maxLogRows` before any fetch). */
  scanRows: number
  /** Traces and logs: spans or log rows the engine decoded (files and tail, before de-duplication). */
  rowsDecoded: number
}

export const newCost = (): Cost => ({
  ledgerVersion: 0, planAttempts: 0, filesListed: 0, filesSkipped: 0, filesRead: 0, scanSamples: 0, seriesEstimate: 0, bytesRead: 0, cacheHits: 0, r2Gets: 0, leafCalls: 0,
  leavesUsed: 0, leafRounds: 0, shardsAsked: 0, shardCalls: 0, tailBatches: 0, tailBytes: 0, seriesLoaded: 0, samplesLoaded: 0, engineMs: 0, wasmMemoryBytes: 0,
  execution: '', splitReason: '', splitLeaves: 0, readerCalls: 0, rpcBytes: 0, leafPeakWasmBytes: 0, leafMaxSamples: 0, leafReruns: 0, pruning: '', tailMode: '', seriesReads: '',
  scanRows: 0, rowsDecoded: 0,
})

/** The plan-only answer's fields that come from what was recorded so far. */
const planOf = (c: Context): Omit<QueryPlan, 'execution' | 'splitReason'> => ({
  leaves: 0, ledgerVersion: c.cost.ledgerVersion, filesListed: c.cost.filesListed, filesSkipped: c.cost.filesSkipped, filesToRead: 0, bytesToRead: 0,
  scanSamples: c.cost.scanSamples, seriesEstimate: c.cost.seriesEstimate, refusal: null,
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
  /** Bytes of tail the coordinator itself may read, in place of what the limits leave (so a test can make a small tail not fit). */
  tailCap?: number
  /** Readers read the series files by name and time, as before ABI 5 (the measurement's same-run comparison). */
  seriesByName?: boolean
  /** Traces and logs: false reads every file the ledger lists, whole, and every span hour (to show pruning changes no answer). */
  signalPruning?: boolean
  /** Answer a split read by id range even when a part saw a foreign series (to show that the rerun is needed: review m-4). */
  ignoreForeign?: boolean
} = {}

export interface Context {
  env: Env
  engine: QueryEngine
  tenant: string
  limits: TenantLimits
  cost: Cost
  /** Unix ms after which the query gives up with `timeout`. */
  deadline: number
  /** What the timeout message says the deadline was: its length and whose limit it is. */
  deadlineWhy?: string
  /** Spreads this query's reads over the leaf pool differently from any other query's. */
  queryId: string
  /** Prometheus warnings for the envelope (`results truncated due to limit`). */
  warnings?: string[]
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

/** A file to read and how (`engine` `filePlan` / `samplePlan`): whole, or these byte ranges. */
export interface Planned {
  f: Pick<FileEntry, 'key' | 'bytes'>
  read: Exclude<FileRead, 'skip'>
}

/** The whole object as one read, and nothing else. */
export const whole = (f: Pick<FileEntry, 'key' | 'bytes'>): Planned => ({ f, read: 'whole' })

/** Bytes a plan reads. */
export const plannedBytes = (p: Planned): number => planBytes({ rows: null, read: p.read }, p.f.bytes)

/**
 * The reads of `files`: a whole object as one read, the ranges of a planned file as one
 * read each; any read above `MAX_PART_BYTES` is cut into several, so no RPC message nears
 * 32 MiB. `part` numbers a file's pieces in order.
 */
export function pieces(files: (Pick<FileEntry, 'key' | 'bytes'> | Planned)[], max = MAX_PART_BYTES): Piece[] {
  const out: Piece[] = []
  files.forEach((x, file) => {
    const p: Planned = 'read' in x ? x : whole(x)
    const spans: [number, number][] = p.read === 'whole' ? [[0, p.f.bytes]] : p.read
    let part = 0
    for (const [start, length] of spans) {
      if (p.read === 'whole' && length <= max) {
        out.push({ key: p.f.key, file, part: part++, bytes: length })
        continue
      }
      for (let offset = start; offset < start + length; offset += max) {
        const n = Math.min(max, start + length - offset)
        out.push({ key: p.f.key, offset, length: n, file, part: part++, bytes: n })
      }
    }
  })
  return out
}

export class MissingFile extends Error {
  constructor(readonly key: string) {
    super(`data file ${key} is listed by the ledger but is not in R2`)
  }
}

/** What a planned read hands the engine: the bytes of the whole object, or a sparse file of its ranges. */
export function assemble(p: Planned, parts: Uint8Array[]): Uint8Array {
  if (p.read === 'whole') {
    if (parts.length === 1) return parts[0]!
    const out = new Uint8Array(p.f.bytes)
    let at = 0
    for (const b of parts) {
      out.set(b, at)
      at += b.byteLength
    }
    return out
  }
  // Pieces arrive in order; a range cut into pieces is put back together.
  const segments: { offset: number; bytes: Uint8Array }[] = []
  let k = 0
  for (const [offset, length] of p.read) {
    const chunks: Uint8Array[] = []
    let got = 0
    while (got < length) {
      const b = parts[k++]!
      chunks.push(b)
      got += b.byteLength
    }
    if (chunks.length === 1) segments.push({ offset, bytes: chunks[0]! })
    else segments.push({ offset, bytes: assemble({ f: { key: p.f.key, bytes: length }, read: 'whole' }, chunks) })
  }
  return sparseFile(p.f.bytes, segments)
}

const planKey = (p: Planned): string => (p.read === 'whole' ? p.f.key : `${p.f.key}#${JSON.stringify(p.read)}`)

/**
 * Fetch `files` (whole, or the byte ranges of their plans) through the leaf pool. Resolves
 * with one buffer per file, in order (a whole object, or a sparse file container of its
 * ranges), or rejects: with `MissingFile` if R2 does not have an object, with `ApiError`
 * if a leaf failed twice. There is no partial result.
 */
export async function fetchFiles(c: Context, entries: (FileEntry | Planned)[], have: Map<string, Uint8Array>): Promise<Uint8Array[]> {
  const files: Planned[] = entries.map((x) => ('read' in x ? x : whole(x)))
  const todo = files.filter((f) => !have.has(planKey(f)))
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
  todo.forEach((f, i) => have.set(planKey(f), assemble(f, parts[i]!)))
  return files.map((f) => have.get(planKey(f))!)
}

// ────────────────────────────────── tail ──────────────────────────────────

type Tail = { status: 'ok'; read: TailRead } | { status: 'refused'; why: string }

/**
 * Rows of one shard above the ledger's watermark for it, filtered by `filter` and paged
 * under `budget` (D48: `readPages`). A shard of the previous release ignores the filter and
 * answers with its whole tail (`paged` false); that is used as it is.
 *
 * `known` remembers, across re-plans of this query, the incarnation each shard said its
 * stream has. The cases:
 *
 *   - The ledger has a watermark for the shard: ask above it. `stale_watermark` (the
 *     shard discarded past it: a flush was recorded since the plan) and
 *     `incarnation_mismatch`, on any page, are refusals; the caller re-reads the ledger
 *     and the pages read so far are dropped.
 *   - After such a mismatch the fresh plan still has the older incarnation: the shard's
 *     stream is one the ledger has never registered, so everything in it is tail.
 *   - The ledger has never registered the shard: ask for the stream's incarnation, then
 *     read it from sequence 0. If a flush is recorded and discarded in between, the
 *     shard answers `stale_watermark` and the caller re-reads the ledger.
 *   - The ledger knows a NEWER incarnation than the shard has: the shard is behind the
 *     ledger, which cannot be answered correctly. Refused.
 *
 * A read that stops at the budget comes back `complete: false`; the caller refuses the
 * query or hands the rest to leaves. Every other status is a retryable 503.
 */
async function readTail(c: Context, shard: string, w: Watermark | undefined, known: Map<string, number>, filter: TailFilter, budget: TailBudget): Promise<Tail> {
  const stub = c.env.SHARD.get(c.env.SHARD.idFromName(shard))
  let incarnation = w?.incarnation ?? 0
  let above = w?.seq ?? 0
  const learned = known.get(shard)
  if (learned !== undefined && learned > incarnation) {
    incarnation = learned
    above = 0
  }
  const alter = hooks.alterTail
  for (let call = 0; call < 2; call++) {
    const r = await readPages(stub, shard, c.tenant, incarnation, above, filter, budget, 'coordinator', { deadline: c.deadline, ...(alter ? { alter: (a: unknown) => alter(shard, a) } : {}) })
    c.cost.shardCalls += r.calls
    if (r.status === 'ok') return { status: 'ok', read: r }
    const refused = pageRefusal(c, r, incarnation, known)
    if (refused) return refused
    // Never registered by the ledger (no watermark): all of the stream is tail.
    if (w) return { status: 'refused', why: `shard ${shard} has a newer stream than the ledger knows` }
    incarnation = (r as Extract<PageOutcome, { status: 'mismatch' }>).incarnation
    above = 0
  }
  return { status: 'refused', why: `shard ${shard} changed its stream twice during one read` }
}

/**
 * A read's refusal, as `readTail` handles it: `stale` re-plans; `unavailable` is a retryable
 * 503 (or the query's timeout, when that is why); `mismatch` with an older stream than asked
 * re-plans, and with a newer one is remembered in `known` and returned as null (the caller
 * decides whether it re-reads that stream or re-plans).
 */
function pageRefusal(c: Context, r: Exclude<PageOutcome, { status: 'ok' }>, incarnation: number, known: Map<string, number>): Tail | null {
  if (r.status === 'stale') return { status: 'refused', why: `shard ${r.shard} has discarded rows above the watermark` }
  // Every other status by name (contracts/COMPATIBILITY.md §2.4, §3.2): a newer schema, a
  // status this release does not know, options the shard refuses: retryable, never an empty
  // tail and never a stream to re-read.
  if (r.status === 'unavailable') {
    checkDeadline(c)
    throw new ApiError('unavailable', `${r.reason}; retry`)
  }
  if (r.incarnation < incarnation) return { status: 'refused', why: `shard ${r.shard} is behind the ledger` }
  known.set(r.shard, r.incarnation)
  return null
}

/** Every shard's tail as read, or a refusal that sends the query back to the ledger. */
type Tails = { again: true } | { again: false; reads: TailRead[]; bytes: number; over: boolean; atLeast: number; exact: boolean }

/**
 * The tails of `shards` under ONE budget of `cap` bytes for all of them (`readShared`, review
 * M-2: before, each shard's read had the whole cap, so the coordinator could hold one cap per
 * shard): first in parallel under equal shares, then one at a time in name order with what is
 * left. `over`: the tail does not fit (a read stopped at the cap, or a previous-release shard's
 * whole answer passed it); `atLeast` is then a lower bound of its bytes. Every read sends
 * `signal`'s filter, and every batch it gets back is checked by its header (D62: the span and
 * log reads of `signals.ts` come here too, under the same one budget). Every metrics read that
 * stopped before its first page fitted learns its end from the shard (`describe`), so that
 * the parts that read the rest read to one fixed end (review M-1). Refusals are counted with
 * `refused` (which throws past the bound).
 */
export async function readTails(c: Context, shards: string[], watermarks: Watermark[], known: Map<string, number>, refused: (who: string, why: string) => void, filter: TailFilter, cap: number, signal: 1 | 2 | 3 = 1): Promise<Tails> {
  const limit = Math.max(0, hooks.tailCap ?? cap)
  // Every read, the first round's and the second's, sends the signal's filter: a cursor is bound
  // to the filter it was given, and a span or log read asks for its signal only (D62).
  const asked = withSignal(filter, signal)
  const tails: (Tail | null)[] = shards.map(() => null)
  const alter = hooks.alterTail
  await readShared(
    shards.length,
    limit,
    0,
    async (i, budget) => {
      const t = await readTail(c, shards[i]!, watermarks.find((w) => w.shard === shards[i]), known, asked, budget)
      tails[i] = t
      // A refusal stops the second round (`readShared` stops at an outcome that is not ok).
      return t.status === 'ok' ? t.read : { status: 'stale', shard: shards[i]!, calls: 0 }
    },
    async (i, read, budget) => {
      const s = shards[i]!
      const calls = read.calls
      const r = await readPages(c.env.SHARD.get(c.env.SHARD.idFromName(s)), s, c.tenant, read.incarnation, read.above, asked, budget, 'coordinator', { deadline: c.deadline, resume: read, ...(alter ? { alter: (a: unknown) => alter(s, a) } : {}) })
      c.cost.shardCalls += r.calls - calls
      if (r.status === 'ok') tails[i] = { status: 'ok', read: r }
      else tails[i] = pageRefusal(c, r, read.incarnation, known) ?? { status: 'refused', why: `shard ${s} changed its stream during a read` }
      return r.status === 'ok' ? r : { status: 'stale', shard: s, calls: 0 }
    },
  )
  let again = false
  shards.forEach((s, i) => {
    const t = tails[i]!
    if (t.status === 'refused') {
      refused(`shard ${s}`, t.why)
      again = true
    }
  })
  if (again) return { again: true }
  const reads = tails.map((t) => (t as Extract<Tail, { status: 'ok' }>).read)
  // A read asks only for its signal's shards; a batch of another signal is refused, never read
  // as this one (a shard of the previous release answers unfiltered; contracts/BATCH.md D57).
  for (const r of reads) for (const b of r.batches) checkSignal(r.shard, b.payload, signal)
  // The end of a metrics read that stopped on its first page is not in any answer: ask the shard
  // for its stream's end, now that nothing more is read here. Every part then reads through it.
  // (A span or log read is never handed to parts: one that does not fit is refused at once, so it
  // has no end to fix; README, "Traces and logs", "Tail reads".)
  const ends = await Promise.all(reads.map((r) => (r.complete || r.through !== null || signal !== 1 ? null : learnEnd(c, r, known))))
  ends.forEach((why, i) => {
    if (why !== null) {
      refused(`shard ${shards[i]}`, why)
      again = true
    }
  })
  if (again) return { again: true }
  const bytes = reads.reduce((a, r) => a + r.bytes, 0)
  const over = reads.some((r) => !r.complete) || bytes > limit
  c.cost.tailMode = reads.length === 0 ? '' : reads.every((r) => r.paged) ? 'filtered' : 'unfiltered'
  c.cost.tailBatches = reads.reduce((a, r) => a + r.batches.length, 0)
  c.cost.tailBytes = bytes
  // The total is known when every read that stopped stopped at the tail's last batch.
  return { again: false, reads, bytes, over, atLeast: bytes + reads.reduce((a, r) => a + r.overBytes, 0), exact: reads.every((r) => r.complete || r.overLast) }
}

/**
 * The end of `r`'s stream (the shard's last sequence number, `Shard.describe`), for a read that
 * stopped before any page fitted; null when learned (set on `r`), else why the query re-plans: the
 * shard's stream is not the one read, or it has discarded above the read's watermark.
 */
async function learnEnd(c: Context, r: TailRead, known: Map<string, number>): Promise<string | null> {
  c.cost.shardCalls++
  const d = await c.env.SHARD.get(c.env.SHARD.idFromName(r.shard)).describe(c.tenant)
  const incarnation = d?.incarnation ?? 0
  if (!d || incarnation !== r.incarnation) {
    if (incarnation < r.incarnation) return `shard ${r.shard} is behind the ledger`
    known.set(r.shard, incarnation)
    return `shard ${r.shard} has a newer stream than the read`
  }
  if (d.discardedThrough > r.above) return `shard ${r.shard} has discarded rows above the watermark`
  r.through = d.nextSeq - 1
  r.overLast = r.overSeq !== null && r.overSeq === r.through
  return null
}

/**
 * Each read's batches cut by split key into `parts` (`cutByKey`; `without` empty: by
 * `series_id`), per shard and per part, in sequence order. Each read lets go of its batches as
 * they are cut, so the tail is not held twice (review M-2). `reads` keep their other fields.
 */
const cutReads = (reads: TailRead[], parts: number, without: readonly string[]): Uint8Array[][][] =>
  reads.map((r) => {
    const per: Uint8Array[][] = Array.from({ length: parts }, () => [])
    const batches: ({ seq: number; payload: Uint8Array } | null)[] = r.batches
    r.batches = []
    for (let k = 0; k < batches.length; k++) {
      cutByKey(batches[k]!.payload, parts, without).forEach((x, j) => x && per[j]!.push(x))
      batches[k] = null
    }
    return per
  })

/** The tail's batches in the order the engine reads them: shards in name order, each in sequence order. */
const tailBatchesOf = (reads: TailRead[]): Uint8Array[] => reads.flatMap((r) => r.batches.map((b) => b.payload))

/**
 * Where a part reads the rest of a shard's tail that stopped at the coordinator's budget: above
 * the last batch the coordinator has, through the end it saw or learned (`readTails`). Taken
 * before the batches are cut and let go.
 */
const restOf = (r: TailRead, filter: TailFilter): TailPart['rest'] => {
  if (r.complete) return null
  // `readTails` learns every end before a split; a rest without one is never handed out.
  if (r.through === null) throw new ApiError('unavailable', `the end of shard ${r.shard}'s tail is not known; retry`)
  return { incarnation: r.incarnation, above: r.batches.reduce((a, b) => Math.max(a, b.seq), r.above), through: r.through, filter }
}

/**
 * Whether the shards can cut a split's tail by key (`keyRange` of `series_id`): when the split
 * key is the `series_id` of every series that carries none of `without`'s labels, and those
 * labels are ones series rarely carry (`__type__`, `__unit__`). A leaf that meets a series
 * carrying one says so (`strays`), and the query is refused rather than answered wrong.
 */
export const shardsCanCut = (without: string[]): boolean => without.every((l) => l === '__type__' || l === '__unit__')

/**
 * Metric shards to ask: every slot the tenant may write to, and every stream the ledger has
 * registered that is not a span or log stream (`signalOfShard`: the ledger registers the
 * streams of `{pool}/traces/{slot}` and `{pool}/logs/{slot}` too, D57, and a metrics tail
 * read of one of them would fail on its first batch).
 */
async function shardsOf(c: Context, watermarks: Watermark[]): Promise<string[]> {
  const map = await poolMap(c.env, c.tenant)
  const names = new Set(tenantSlots(map, c.tenant).map((slot) => shardName(map, slot)))
  for (const w of watermarks) if (names.has(w.shard) || signalOfShard(w.shard) === 'metrics') names.add(w.shard)
  return [...names].sort()
}

// ───────────────────────────────── gather ─────────────────────────────────

/** The timeout message: it names the limit, so a person can tell a limit from a stall. */
export const timedOut = (why?: string): string => (why ? `query timed out after ${why}` : 'query timed out')

export function checkDeadline(c: Context): void {
  if (Date.now() > c.deadline) throw new ApiError('timeout', timedOut(c.deadlineWhy))
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

/**
 * Reserve `bytes` of the isolate's budget for a query (refused with a retryable 503 when
 * others hold it); returns the release. For the span and log queries (`signals.ts`).
 */
export function reserveBytes(bytes: number): () => void {
  if (inFlightBytes > 0 && inFlightBytes + bytes > (hooks.isolateBudgetBytes ?? ISOLATE_BUDGET_BYTES)) throw new ApiError('unavailable', 'the query service is busy; retry')
  const held = Math.max(bytes, 1)
  inFlightBytes += held
  return () => {
    inFlightBytes -= held
  }
}

/** `atLeast`: `bytes` is a lower bound (a read stopped at the limit, D48). */
export const tooMuch = (c: Context, what: string, bytes: number, atLeast = false): ApiError =>
  new ApiError(
    'execution',
    `query exceeded limit max_fetch_bytes: ${what} is ${atLeast ? 'at least ' : ''}${bytes} bytes, the limit is ${c.limits.maxFetchBytes}. Narrow the time range, or select fewer metrics by name.`,
  )

/**
 * Every part that reads the rest of a tail scans each shard's whole tail for that tenant on the
 * object that acknowledges writes (D48 "Cost of it"), so a query may hand rests to at most
 * `maxTailReadParts` parts (review M-3; D54). Past it the query is refused, naming the limit.
 */
function tooManyReaders(c: Context, parts: number, atLeast: number): void {
  if (parts <= c.limits.maxTailReadParts) return
  throw new ApiError(
    'execution',
    `query exceeded limit max_tail_read_parts: the unflushed tail is at least ${atLeast} bytes, more than max_fetch_bytes (${c.limits.maxFetchBytes}), and the query needs ${parts} parts, each of which would scan the shards' tails; the limit is ${c.limits.maxTailReadParts}. Narrow the time range, select fewer metrics by name, or retry once the tail is flushed.`,
  )
}

/** A part's tail as the coordinator hands it to a leaf: cut here (`tails`), or cut here and read in part by the leaf (`tailParts`). */
export interface PartTail {
  tails: Uint8Array[]
  tailParts?: TailPart[]
}

/**
 * A leaf's refusal of its part of the tail (`Leaf`, `readRests`), handled as the
 * coordinator handles its own: a discarded watermark or another stream sends the query back
 * to the ledger (counted against the shard's bound); a part's tail over the byte cap, or a
 * tail the shards could not cut by key, is 422; anything else a retryable 503.
 */
function tailRefused(c: Context, x: TailRefusal, known: Map<string, number>, refused: (who: string, why: string) => void, parts: number): void {
  if (x.kind === 'stale') return refused(`shard ${x.shard}`, `shard ${x.shard} has discarded rows above the watermark`)
  if (x.kind === 'mismatch') {
    if (x.incarnation < x.asked) return refused(`shard ${x.shard}`, `shard ${x.shard} is behind the ledger`)
    known.set(x.shard, x.incarnation)
    return refused(`shard ${x.shard}`, `shard ${x.shard} has a newer stream than the ledger knows`)
  }
  if (x.kind === 'too_large') throw tooMuch(c, `the unflushed tail of one of ${parts} parts`, x.bytes, true)
  if (x.kind === 'strays') {
    throw new ApiError(
      'execution',
      `query exceeded limit max_fetch_bytes: the unflushed tail is more than ${c.limits.maxFetchBytes} bytes, the limit, and holds series with a __type__ or __unit__ label, which the shards cannot cut by key. Narrow the time range, or select fewer metrics by name.`,
    )
  }
  throw new ApiError('unavailable', `${x.reason}; retry`)
}

/**
 * How many series a query loads, summed over its reads as `max_series` counts them,
 * estimated from the series files before anything is fetched. `rows` is, per file, the
 * rows of the row groups the reads touch (`scanRows`; `null` when the fragment does not
 * parse, then the file's rows). A `metric_series` file holds one row per series.
 *
 * Different shards hold different series, so shards add up. Within a shard, files that
 * cover the same time hold different series (segments cut by size while one scrape
 * arrives) and files of different times repeat them (segments cut by time), so a shard
 * counts as its largest sum over files that overlap one file in time. A compaction output
 * holds every shard's series of its span: the estimate is at least the largest. Row groups
 * hold every metric of a file, so for a small metric among large ones this is high; it is
 * low when a shard's segments are shorter than a scrape interval, and a series only in the
 * tail is not in it. Used to decide a split and its size, never to refuse.
 */
export function seriesEstimate(files: Pick<FileEntry, 'key' | 'rows' | 'minTs' | 'maxTs'>[], rows: (number | null)[]): number {
  const perShard = new Map<string, { minTs: number; maxTs: number; n: number }[]>()
  let merged = 0
  files.forEach((f, i) => {
    const n = rows[i] ?? f.rows
    const m = /\/L0-(.+)-\d+-\d+-\d+-[0-9a-f]{8}\.parquet$/.exec(f.key)
    if (!m) merged = Math.max(merged, n)
    else perShard.set(m[1]!, [...(perShard.get(m[1]!) ?? []), { minTs: f.minTs, maxTs: f.maxTs, n }])
  })
  let flush = 0
  for (const list of perShard.values()) {
    list.sort((a, b) => a.minTs - b.minTs)
    let most = 0
    for (const f of list) {
      let sum = 0
      for (const g of list) {
        if (g.minTs > f.maxTs) break
        if (g.maxTs >= f.minTs) sum += g.n
      }
      most = Math.max(most, sum)
    }
    flush += most
  }
  return Math.max(flush, merged)
}

/**
 * Leaves for a split query: enough that each holds at most three quarters of one
 * isolate's `maxSamples` (`samples`: scan bound plus tail) AND of its `maxSeries`
 * (`series`: `seriesEstimate`), at least 2, at most `maxLeaves` and the pool.
 */
export function leafCount(limits: Pick<TenantLimits, 'maxSamples' | 'maxSeries' | 'maxLeaves'>, pool: number, samples: number, series: number): number {
  const need = Math.max(2, Math.ceil(samples / (0.75 * limits.maxSamples)), Math.ceil(series / (0.75 * limits.maxSeries)))
  return Math.min(need, Math.max(1, Math.min(limits.maxLeaves, pool)))
}

/**
 * The refusal a query gets from the ledger's numbers alone, before any file or shard is
 * read: split queries against the query-wide caps, one place against one isolate's.
 */
function refusalBeforeFetch(c: Context, splitting: boolean, scan: number, files: number, bytes: number): ApiError | null {
  const narrow = 'Narrow the time range, or select fewer metrics by name.'
  if (splitting) {
    if (scan > c.limits.maxQueryScanSamples) return new ApiError('execution', `query exceeded limit max_query_scan_samples: the data files in range hold ${scan} samples the query would decode, the limit is ${c.limits.maxQueryScanSamples}. ${narrow}`)
    if (files > c.limits.maxQueryFiles) return new ApiError('execution', `query exceeded limit max_query_files: ${files} data files to read, the limit is ${c.limits.maxQueryFiles}. Narrow the time range.`)
    if (bytes > c.limits.maxQueryFetchBytes) return new ApiError('execution', `query exceeded limit max_query_fetch_bytes: the ${files} data files in range are ${bytes} bytes, the limit is ${c.limits.maxQueryFetchBytes}. ${narrow}`)
    return null
  }
  if (scan > c.limits.maxScanSamples) return new ApiError('execution', `query exceeded limit max_scan_samples: the data files in range hold ${scan} samples the query would decode, the limit is ${c.limits.maxScanSamples}. ${narrow}`)
  if (files > c.limits.maxFiles) return new ApiError('execution', `query exceeded limit max_files: ${files} data files to read, the limit is ${c.limits.maxFiles}. Narrow the time range.`)
  if (bytes > c.limits.maxFetchBytes) return tooMuch(c, `the ${files} data files in range`, bytes)
  return null
}

/** What `/api/v1/plan` answers: what a query would read and how it would run, without running it. */
export interface QueryPlan {
  /** `single`, `split`, or `none` (no selector: nothing is read). */
  execution: 'single' | 'split' | 'none'
  /** Why one place (empty for a split). */
  splitReason: string
  /** Leaves a split would use (from the lake alone: the tail is not read here). */
  leaves: number
  ledgerVersion: number
  filesListed: number
  filesSkipped: number
  filesToRead: number
  bytesToRead: number
  scanSamples: number
  seriesEstimate: number
  /** The refusal the query would get before anything is fetched, or null. */
  refusal: { errorType: string; error: string } | null
}

/**
 * Everything the engine needs for `ranges` (the merged fetch plan), from one ledger
 * version: the files the ranges can touch and every shard's rows above its watermark.
 * Calls `evaluate` with it and returns its result. `reads` are the reads evaluation will
 * make (one per selector, unmerged): they size the scan before anything is fetched.
 * With `explain`, stops after the ledger read and returns what the query would do
 * (no shard, leaf or R2 is touched).
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

/** Files with their plans, leaving out the ones to skip (a plan never skips a file `filesNeeded` keeps; this is the same rule). */
function toPlanned(files: FileEntry[], plans: FilePlan[]): Planned[] {
  const out: Planned[] = []
  files.forEach((f, i) => {
    const r = plans[i]?.read ?? 'whole'
    if (r !== 'skip') out.push({ f, read: r })
  })
  return out
}

const sumPlanned = (ps: Planned[]): number => ps.reduce((a, p) => a + plannedBytes(p), 0)

/** Whether resolving matchers against series files can prune: some read selects by more than `__name__ =`. */
export const resolvable = (reads: FetchRange[]): boolean => reads.some((r) => r.matchers.some((m) => !(m.name === '__name__' && m.op === '=')))

export async function gather<T>(c: Context, ranges: FetchRange[], reads: FetchRange[], evaluate: (input: ScanInput) => T, split?: SplitSpec<T>, explain?: (p: QueryPlan) => T): Promise<T> {
  // No selector (`1 + 1`, `time()`): nothing to read, and no reason to wake anything.
  if (ranges.length === 0 && explain) return explain({ ...planOf(c), execution: 'none', splitReason: 'the query reads no data' })
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
  // What every shard is asked to keep (D48): the hull of the ranges' times, their metric
  // names, the label values every range pins. The engine applies the ranges exactly.
  const filter = tailFilter(ranges)

  /**
   * Split execution from one ledger version. The tail is the one read in one place that did
   * not fit there (`prior`), or is read now under `maxFetchBytes`. Either way it is cut here by
   * split key in JavaScript (`cutByKey`) and let go as it is cut. When it fits, each part gets
   * its cut; when it does not (and the shards can cut it by key) each part gets its cut of what
   * was read and reads the rest of each shard's tail itself, in its key range, through the end
   * the coordinator fixed. `again`: a shard, a leaf or a missing file sent the query back to
   * the ledger.
   */
  const splitPath = async (
    snap: Snapshot,
    series: FileEntry[],
    samples: FileEntry[],
    scan: number,
    seriesEst: number,
    lakeBytes: number,
    spec: SplitSpec<T>,
    prior: Tails | null,
  ): Promise<{ again: true } | { again: false; value: T }> => {
    let t = prior
    if (!t) {
      const shards = await shardsOf(c, snap.watermarks)
      c.cost.shardsAsked = shards.length
      t = await readTails(c, shards, snap.watermarks, known, refused, filter, c.limits.maxFetchBytes)
    }
    if (t.again) return { again: true }
    const reads = t.reads
    c.cost.filesRead = series.length + samples.length
    c.cost.bytesRead = lakeBytes
    const pool = leafPoolSize(c.env)
    const most = Math.max(1, Math.min(c.limits.maxLeaves, pool))
    let L: number
    let tailFor: (j: number) => PartTail
    // Per shard, per part: the part's rows of what was read here. Kept for the reruns below.
    let cut: Uint8Array[][][]
    let rests: TailPart['rest'][] = []
    const names = reads.map((r) => r.shard)
    if (!t.over) {
      // The tail is held here while it is cut by part (each part goes to its leaf).
      L = hooks.forceLeaves ?? leafCount(c.limits, pool, scan + Math.ceil(t.bytes / 20), seriesEst)
      cut = cutReads(reads, L, spec.without)
      tailFor = (j) => ({ tails: cut.flatMap((perShard) => perShard[j]!) })
    } else {
      if (!shardsCanCut(spec.without)) throw tooMuch(c, 'the unflushed tail', t.atLeast, !t.exact)
      // Leaves sized for the whole tail as estimated from what was read (and its series),
      // with each part's share of it under half of a leaf's byte cap.
      const est = tailEstimate(reads)
      L = hooks.forceLeaves ?? Math.min(most, Math.max(leafCount(c.limits, pool, scan + Math.ceil(est.bytes / 20), Math.max(seriesEst, est.series)), Math.ceil(est.bytes / (0.5 * c.limits.maxFetchBytes))))
      // Where each part reads on (taken before the batches are let go); what was read is cut here
      // by split key, and each part reads the rest of each shard's tail itself.
      rests = reads.map((r) => restOf(r, filter))
      if (rests.some((r) => r !== null)) {
        tooManyReaders(c, L, t.atLeast)
        c.cost.tailMode += '+leaves'
      }
      cut = cutReads(reads, L, spec.without)
      tailFor = (j) => ({ tails: [], tailParts: names.map((shard, i) => ({ shard, batches: cut[i]![j]!, rest: rests[i]! })) })
    }
    checkDeadline(c)
    // Readers read the series files by their part's id range too when the key is the id of
    // every series without `__type__`/`__unit__`; if any part saw a series whose key is not its
    // id (foreign), or could not say (a reader or leaf of the previous release, review B-1),
    // some part may have missed one of its own: run again by name and time.
    const byPart = shardsCanCut(spec.without) && !hooks.seriesByName
    const runParts = async (): Promise<Awaited<ReturnType<typeof runSplit<T>>>> => {
      c.cost.seriesReads = byPart ? 'id-range' : 'name-time'
      let r = await runSplit(c, spec, ranges, series, samples, L, tailFor, byPart)
      if (r.status === 'foreign') {
        c.cost.seriesReads = 'id-range,name-time'
        r = await runSplit(c, spec, ranges, series, samples, L, tailFor, false)
      }
      return r
    }
    let r = await runParts()
    if (t.over && r.status === 'tail' && r.refusal.kind === 'too_large' && hooks.forceLeaves === undefined) {
      // A part's tail was over its cap: the split was sized too small (D31 alternative (d), review
      // m-3). Once, k times as many parts, each inside one of the old (part ranges nest when the
      // count is a multiple), within the leaves allowed, and with the parts of both runs within
      // `maxTailReadParts` (each reads the rests again); else the query is refused.
      const k = Math.min(Math.floor(most / L), Math.floor((c.limits.maxTailReadParts - L) / L), Math.max(2, Math.ceil(r.refusal.bytes / (0.5 * c.limits.maxFetchBytes))))
      if (k >= 2) {
        const before = cut
        cut = before.map((perShard) => {
          const per: Uint8Array[][] = Array.from({ length: L * k }, () => [])
          for (const pieces of perShard) for (let n = 0; n < pieces.length; n++) cutByKey(pieces[n]!, L * k, spec.without).forEach((x, j) => x && per[j]!.push(x))
          perShard.length = 0
          return per
        })
        L *= k
        r = await runParts()
      }
    }
    if (r.status === 'foreign') throw new ApiError('internal', 'a split ran by name and time came back as if read by id range')
    if (r.status === 'missing') {
      refused(`file ${r.key}`, `data file ${r.key} is listed by the ledger but is not in R2`)
      return { again: true }
    }
    if (r.status === 'tail') {
      tailRefused(c, r.refusal, known, refused, L)
      return { again: true }
    }
    return { again: false, value: spec.done(r.out) }
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
      let samples = snap.samples.filter((_, i) => keep[snap.series.length + i])
      // How many samples would the engine decode? Known from the row groups' row counts,
      // before anything is fetched. The engine's own `max_samples` fires only after a
      // selector's samples are in memory, so this is what keeps a too-large query from
      // being materialised at all.
      const rows = c.engine.scanRows(samples.map((f) => f.index), reads)
      let scan = rows.reduce<number>((a, r, i) => a + (r ?? samples[i]!.rows * reads.length), 0)
      // How to read each file, from its fragment: the row groups of the ranges' metrics and
      // times, with the footer, or the whole object (contracts/TABLES.md, "Reading part of a file").
      const byFragment = c.engine.filePlan([...series, ...samples].map((f) => f.index), ranges)
      const seriesPlans = toPlanned(series, byFragment.slice(0, series.length))
      let samplePlans = toPlanned(samples, byFragment.slice(series.length))
      // Recorded before any limit is checked, so a refused query still says what it would have cost.
      c.cost.scanSamples = scan
      c.cost.filesListed = listed.length
      c.cost.filesSkipped = listed.length - series.length - samples.length
      c.cost.pruning = 'fragments'
      let lakeBytesAll = sumPlanned(seriesPlans) + sumPlanned(samplePlans)
      // How many series? From the series files' row groups, also known before any fetch:
      // a query over many series with few samples each needs leaves as much as one with many samples.
      let seriesEst = seriesEstimate(series, c.engine.scanRows(series.map((f) => f.index), reads))
      c.cost.seriesEstimate = seriesEst
      const overOnePlace = (scanned: number, est: number, bytes: number, files: number): boolean =>
        split !== undefined
          ? scanned > c.limits.splitAboveSamples || est > c.limits.splitAboveSeries || bytes > c.limits.maxFetchBytes || files > c.limits.maxFiles
          : scanned > c.limits.maxScanSamples || bytes > c.limits.maxFetchBytes || files > c.limits.maxFiles

      // Series-level pruning (CARDINALITY.md, item 2). When the fragments alone say the query
      // does not fit one place and a read selects by more than its metric's name, resolve the
      // matchers against the series files first: then only the sample row groups that hold a
      // selected series are counted and read, and the series estimate is exact. One more round
      // of reads, so only when it can change the answer.
      // The selected series, to evaluate with instead of the series files (engine `samplePlan`).
      let carrier: Uint8Array | null = null
      if (!explain && hooks.forceLeaves === undefined && overOnePlace(scan, seriesEst, lakeBytesAll, series.length + samples.length) && resolvable(reads) && sumPlanned(seriesPlans) <= c.limits.maxFetchBytes) {
        let got: Uint8Array[]
        try {
          got = await fetchFiles(c, seriesPlans, have)
        } catch (e) {
          if (!(e instanceof MissingFile)) throw e
          refused(`file ${e.key}`, e.message)
          continue
        }
        const t0 = performance.now()
        // Each sample file is planned for the series of its own series file (the pair).
        const at = new Map(seriesPlans.map((p, i) => [pairKey(p.f.key), i]))
        const rp = c.engine.samplePlan(got, samples.map((f) => f.index), reads, undefined, samples.map((f) => at.get(pairKey(f.key)) ?? null))
        c.cost.engineMs += Math.round(performance.now() - t0)
        scan = rp.files.reduce<number>((a, p, i) => a + (p.rows ?? samples[i]!.rows * reads.length), 0)
        samplePlans = toPlanned(samples, rp.files)
        samples = samples.filter((_, i) => rp.files[i]!.read !== 'skip')
        seriesEst = rp.series
        carrier = rp.carrier
        // With the carrier, the series files are not needed again: let them go.
        if (carrier) for (const p of seriesPlans) have.delete(planKey(p))
        lakeBytesAll = sumPlanned(seriesPlans) + sumPlanned(samplePlans)
        c.cost.scanSamples = scan
        c.cost.seriesEstimate = seriesEst
        c.cost.filesSkipped = listed.length - series.length - samples.length
        c.cost.pruning = 'series'
      }
      const wanted = [...series, ...samples]
      const splitting =
        split !== undefined &&
        (hooks.forceLeaves !== undefined || scan > c.limits.splitAboveSamples || seriesEst > c.limits.splitAboveSeries || lakeBytesAll > c.limits.maxFetchBytes || wanted.length > c.limits.maxFiles)
      const refusal = refusalBeforeFetch(c, splitting, scan, wanted.length, lakeBytesAll)
      if (explain) {
        const leaves = splitting ? (hooks.forceLeaves ?? leafCount(c.limits, leafPoolSize(c.env), scan, seriesEst)) : 0
        const why = split === undefined ? c.cost.splitReason : splitting ? '' : 'the query fits in one place'
        return explain({ ...planOf(c), execution: splitting ? 'split' : 'single', splitReason: why, leaves, filesToRead: wanted.length, bytesToRead: lakeBytesAll, refusal: refusal && { errorType: refusal.errorType, error: refusal.message } })
      }
      if (split && splitting) {
        // ── Split execution: leaves read and evaluate parts of the series. ──
        c.cost.execution = 'split'
        c.cost.splitReason = ''
        if (refusal) throw refusal
        const r = await splitPath(snap, series, samples, scan, seriesEst, lakeBytesAll, split, null)
        if (r.again) continue
        return r.value
      }
      if (split) {
        c.cost.execution = 'single'
        c.cost.splitReason = 'the query fits in one place'
      }
      // Known before anything is fetched: the scan bound, the files and their sizes.
      if (refusal) throw refusal
      const lakeBytes = lakeBytesAll
      if (reserved === 0) {
        if (inFlightBytes > 0 && inFlightBytes + lakeBytes > (hooks.isolateBudgetBytes ?? ISOLATE_BUDGET_BYTES)) throw new ApiError('unavailable', 'the query service is busy; retry')
        reserved = Math.max(lakeBytes, 1)
        inFlightBytes += reserved
      }

      // Tails strictly after the plan; shards and leaves in parallel. The tail may take what
      // the files leave of `maxFetchBytes`; a read stops there (D48), it is not read whole first.
      const shards = await shardsOf(c, snap.watermarks)
      c.cost.shardsAsked = shards.length
      const files = fetchFiles(c, carrier ? samplePlans : [...seriesPlans, ...samplePlans], have).then(
        (bytes) => ({ ok: true as const, bytes }),
        (error: unknown) => ({ ok: false as const, error }),
      )
      const tails = await readTails(c, shards, snap.watermarks, known, refused, filter, c.limits.maxFetchBytes - lakeBytes)
      let again = tails.again
      const got = await files
      if (!got.ok) {
        if (!(got.error instanceof MissingFile)) throw got.error
        // The ledger listed it and R2 does not have it: the plan is older than a
        // deletion (compaction, retention). Read the ledger again; never answer without it.
        refused(`file ${got.error.key}`, got.error.message)
        again = true
      }
      if (again || tails.again) continue
      if (tails.over) {
        // The tail does not fit one place. A query that decomposes, over a split key the shards
        // can cut, is split instead: each part reads the rest of the tail in its key range.
        if (split && shardsCanCut(split.without)) {
          have.clear()
          c.cost.execution = 'split'
          c.cost.splitReason = ''
          const splitRefusal = refusalBeforeFetch(c, true, scan, wanted.length, lakeBytesAll)
          if (splitRefusal) throw splitRefusal
          const r = await splitPath(snap, series, samples, scan, seriesEst, lakeBytesAll, split, tails)
          if (r.again) continue
          return r.value
        }
        throw tooMuch(c, 'the data files in range plus the unflushed tail', lakeBytes + tails.atLeast, !tails.exact)
      }
      const tailBatches = tailBatchesOf(tails.reads)
      c.cost.filesRead = wanted.length
      c.cost.bytesRead = lakeBytes
      checkDeadline(c)

      if (hooks.sampleOrder) hooks.sampleOrder(samples.map((f) => f.key))
      const all = got.ok ? got.bytes : []
      // The carrier goes first among the tail batches: its rows lie outside every range, so
      // it only names the series (engine `sample_plan`), and the series files are not needed.
      const input: ScanInput = carrier
        ? { seriesFiles: [], sampleFiles: all, tailBatches: [carrier, ...tailBatches] }
        : { seriesFiles: all.slice(0, seriesPlans.length), sampleFiles: all.slice(seriesPlans.length), tailBatches }
      return timed(c, evaluate, input)
    }
  } finally {
    inFlightBytes -= reserved
  }
}

/** What a label endpoint lists (`/labels`, `/label/<name>/values`, `/series`), for a call over leaves. */
export interface MetaSpec {
  kind: 'names' | 'values' | 'series'
  name: string
  match: string[]
  start: number
  end: number
  /** The engine's limits for the call (`maxSeries` is `maxMetadataSeries`). */
  limits: QueryLimits
}

/**
 * The parts' listings of a label call merged as one place lists them: names and values a
 * sorted union, series a sorted concatenation (parts are disjoint in series); the counts of
 * series listed added per `match[]` set and checked against the call's cap, as one place
 * checks each set's. The answer is the JSON one place gives (`JSON.stringify` of the list).
 */
export function mergeMeta(kind: MetaSpec['kind'], answers: { json: string; listed: number[] }[], maxSeries: number): string {
  const sets = Math.max(0, ...answers.map((a) => a.listed.length))
  for (let i = 0; i < sets; i++) {
    const n = answers.reduce((x, a) => x + (a.listed[i] ?? 0), 0)
    if (n > maxSeries) throw new QueryError('execution', `query exceeded limit max_series: ${n} series listed, the limit is ${maxSeries}`, { name: 'max_series', max: maxSeries, reached: n })
  }
  if (kind === 'series') {
    const all = answers.flatMap((a) => JSON.parse(a.json) as Record<string, string>[])
    all.sort(byLabels)
    return JSON.stringify(all.filter((x, i) => i === 0 || byLabels(all[i - 1]!, x) !== 0))
  }
  const all = answers.flatMap((a) => JSON.parse(a.json) as string[])
  all.sort(byCodePoint)
  return JSON.stringify(all.filter((x, i) => i === 0 || all[i - 1] !== x))
}

/**
 * The label endpoints (CARDINALITY.md, item 3): a series-only read. Only the
 * `metric_series` files the ranges can touch (by name and time, range-read to the row
 * groups of the ranges' metrics) and every shard's tail (filtered by the calls' window,
 * metric names and pinned labels: exact here), from one ledger version with the same fence
 * as a query; no sample file is listed for reading, fetched or decoded. "In the range" is
 * decided per file (contracts/TABLES.md). In one place under `maxFetchBytes` and `maxFiles`
 * over what is read, and in the engine `maxMetadataSeries` (`evaluate` passes it).
 *
 * **Over leaves** (2026-11-19) when the series files or the tail do not fit one place: each
 * part lists the series whose `series_id` is in its range, from its row groups of every
 * series file and its part of the tail (read by it when the tail did not fit here, D54),
 * under `maxFetchBytes` of its own; the coordinator merges the lists and adds up the counts
 * (`mergeMeta`). `evaluate` answers one place; the result is JSON text either way.
 */
export async function gatherSeries(c: Context, ranges: FetchRange[], meta: MetaSpec, evaluate: (input: ScanInput) => string): Promise<string> {
  const minTs = Math.min(...ranges.map((r) => r.minTs))
  const maxTs = Math.max(...ranges.map((r) => r.maxTs))
  const have = new Map<string, Uint8Array>()
  const refusals = new Map<string, number>()
  const known = new Map<string, number>()
  const refused = (who: string, why: string): void => {
    const n = (refusals.get(who) ?? 0) + 1
    refusals.set(who, n)
    if (n > MAX_REFUSALS) throw new ApiError('unavailable', `${why}, and the ledger does not catch up; retry later`)
  }
  const filter = tailFilter(ranges)
  let reserved = 0
  try {
    for (let attempt = 1; ; attempt++) {
      checkDeadline(c)
      const snap = await snapshot(c, minTs, maxTs)
      c.cost.ledgerVersion = snap.version
      if (hooks.afterPlan) await hooks.afterPlan(c.tenant, attempt)
      const listedFiles = snap.series
      const plans = toPlanned(listedFiles, c.engine.filePlan(listedFiles.map((f) => f.index), ranges))
      c.cost.filesListed = snap.series.length + snap.samples.length
      c.cost.filesSkipped = c.cost.filesListed - plans.length
      c.cost.pruning = 'series-only'
      const bytes = sumPlanned(plans)
      // Series files over one place's budget or its file count: over leaves (each reads its ids'
      // row groups), under the query-wide limits (review m-5: `maxFiles` is one place's).
      const leaves = hooks.forceLeaves !== undefined || bytes > c.limits.maxFetchBytes || plans.length > c.limits.maxFiles
      if (leaves && plans.length > c.limits.maxQueryFiles) throw new ApiError('execution', `query exceeded limit max_query_files: ${plans.length} series files to read, the limit is ${c.limits.maxQueryFiles}. Narrow the time range.`)
      if (!leaves && reserved === 0) {
        if (inFlightBytes > 0 && inFlightBytes + bytes > (hooks.isolateBudgetBytes ?? ISOLATE_BUDGET_BYTES)) throw new ApiError('unavailable', 'the query service is busy; retry')
        reserved = Math.max(bytes, 1)
        inFlightBytes += reserved
      }
      const shards = await shardsOf(c, snap.watermarks)
      c.cost.shardsAsked = shards.length
      const files = leaves
        ? Promise.resolve({ ok: true as const, bytes: [] as Uint8Array[] })
        : fetchFiles(c, plans, have).then(
            (b) => ({ ok: true as const, bytes: b }),
            (error: unknown) => ({ ok: false as const, error }),
          )
      const tails = await readTails(c, shards, snap.watermarks, known, refused, filter, c.limits.maxFetchBytes - (leaves ? 0 : bytes))
      let again = tails.again
      const got = await files
      if (!got.ok) {
        if (!(got.error instanceof MissingFile)) throw got.error
        refused(`file ${got.error.key}`, got.error.message)
        again = true
      }
      if (again || tails.again) continue
      checkDeadline(c)
      if (!leaves && !tails.over) {
        c.cost.execution = 'single'
        c.cost.filesRead = plans.length
        c.cost.bytesRead = bytes
        return timed(c, evaluate, { seriesFiles: got.ok ? got.bytes : [], sampleFiles: [], tailBatches: tailBatchesOf(tails.reads) })
      }
      // ── Over leaves: each part lists its `series_id` range. ──
      have.clear()
      const pool = leafPoolSize(c.env)
      const most = Math.max(1, Math.min(c.limits.maxLeaves, pool))
      // Parts by series, as the cardinality report's (each part reads its ids' row groups of
      // every series file, in waves under its byte cap), and enough that its share of the tail
      // is under half its cap.
      const est = tailEstimate(tails.reads)
      const series = seriesEstimate(plans.map((p) => listedFiles.find((f) => f.key === p.f.key)!), plans.map(() => null))
      c.cost.seriesEstimate = series
      const L = hooks.forceLeaves ?? Math.min(most, Math.max(2, Math.ceil(Math.max(series, est.series) / c.limits.cardinalitySplitAboveSeries), Math.ceil((tails.over ? est.bytes : tails.bytes) / (0.5 * c.limits.maxFetchBytes))))
      c.cost.execution = 'split'
      c.cost.splitLeaves = L
      const refs: FileRef[] = plans.map((p) => ({ key: p.f.key, bytes: p.f.bytes, index: listedFiles.find((f) => f.key === p.f.key)!.index }))
      // What the parts read of the series files together (each its id range's row groups of every
      // file, from the fragments; a file of one row group is read by every part): the query-wide
      // byte limit counts every copy (review m-5).
      // (Planned per part only when every part reading all of it would pass the limit.)
      let partBytes = L * bytes
      if (partBytes > c.limits.maxQueryFetchBytes) {
        partBytes = 0
        const indexes = refs.map((f) => f.index!)
        for (let j = 0; j < L; j++) c.engine.partPlan(indexes, ranges, j, L).forEach((p, i) => (partBytes += p.read === 'skip' ? 0 : planBytes({ rows: null, read: p.read }, refs[i]!.bytes)))
      }
      if (partBytes > c.limits.maxQueryFetchBytes) {
        throw new ApiError('execution', `query exceeded limit max_query_fetch_bytes: the ${L} parts would read ${partBytes} bytes of the ${plans.length} series files in range, the limit is ${c.limits.maxQueryFetchBytes}. Narrow the time range, or select fewer metrics by name.`)
      }
      const rests = tails.reads.map((r) => restOf(r, filter))
      const leafTails = rests.some((r) => r !== null)
      if (leafTails) {
        tooManyReaders(c, L, tails.atLeast)
        c.cost.tailMode += '+leaves'
      }
      const cut = cutReads(tails.reads, L, [])
      const base = hash32(c.queryId)
      const answers = await Promise.all(
        Array.from({ length: L }, async (_, j) => {
          const pt: PartTail = leafTails ? { tails: [], tailParts: tails.reads.map((r, i) => ({ shard: r.shard, batches: cut[i]![j]!, rest: rests[i]! })) } : { tails: cut.flatMap((parts) => parts[j]!) }
          const req: MetaRequest = {
            kind: meta.kind, name: meta.name, match: meta.match, start: meta.start, end: meta.end, ranges, files: refs, part: j, parts: L, limits: meta.limits,
            maxBytes: c.limits.maxFetchBytes, tails: pt.tails, cacheTtlS: fileCacheTtl(c.env),
            ...(pt.tailParts ? { tailParts: pt.tailParts, tenant: c.tenant, deadline: c.deadline } : {}),
          }
          const sent = pt.tails.reduce((a, b) => a + b.byteLength, 0) + (pt.tailParts ?? []).reduce((a, p) => a + p.batches.reduce((x, b) => x + b.byteLength, 0), 0)
          const call = (attempt: number) => {
            c.cost.leafCalls++
            c.cost.rpcBytes += sent
            return c.env.LEAF.get(c.env.LEAF.idFromName(`leaf/${c.env.CELL}/${(base + j + attempt) % pool}`)).meta(req)
          }
          let a: MetaAnswer
          try {
            a = await call(0)
          } catch {
            try {
              a = await call(1)
            } catch (e) {
              throw new ApiError('unavailable', `a leaf failed twice listing its part: ${e instanceof Error ? e.message : String(e)}`)
            }
          }
          if (a.status === 'ok' && pt.tailParts && !a.tail) throw new ApiError('unavailable', 'a leaf of an earlier release answered a label call without reading its part of the tail; retry')
          return a
        }),
      )
      c.cost.leavesUsed = Math.max(c.cost.leavesUsed, Math.min(L, pool))
      const missing = answers.find((a) => a.status === 'missing')
      if (missing && missing.status === 'missing') {
        refused(`file ${missing.key}`, `data file ${missing.key} is listed by the ledger but is not in R2`)
        continue
      }
      const tail = answers.find((a) => a.status === 'tail')
      if (tail && tail.status === 'tail') {
        tailRefused(c, tail, known, refused, L)
        continue
      }
      const error = answers.find((a) => a.status === 'error')
      if (error && error.status === 'error') throw new QueryError(error.errorType, error.message, error.limit)
      const large = answers.find((a) => a.status === 'too_large')
      if (large && large.status === 'too_large') throw tooMuch(c, `the series files and unflushed tail of one of ${L} parts`, large.bytes, true)
      const oks = answers.filter((a): a is Extract<MetaAnswer, { status: 'ok' }> => a.status === 'ok')
      c.cost.filesRead = plans.length
      for (const a of oks) {
        c.cost.bytesRead += a.bytesRead
        c.cost.cacheHits += a.cacheHits
        c.cost.r2Gets += a.r2Gets
        c.cost.rpcBytes += a.json.length
        if (a.tail) {
          c.cost.shardCalls += a.tail.calls
          c.cost.tailBatches += a.tail.batches
          c.cost.tailBytes += a.tail.bytes
        }
      }
      const t0 = performance.now()
      try {
        return mergeMeta(meta.kind, oks, meta.limits.maxSeries)
      } finally {
        c.cost.engineMs += Math.round(performance.now() - t0)
      }
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
    // With their fragments, so a reader can range-read its part of each file.
    cur.series.push({ key: s.key, bytes: s.bytes, index: s.index })
    cur.samples.push({ key: f.key, bytes: f.bytes, index: f.index })
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
  L: number,
  tailFor: (part: number) => PartTail,
  seriesByPart: boolean,
): Promise<{ status: 'ok'; out: { json: string; stats: QueryStats } } | { status: 'missing'; key: string } | { status: 'tail'; refusal: TailRefusal } | { status: 'foreign'; count: number; unknown: number }> {
  const pool = leafPoolSize(c.env)
  c.cost.splitLeaves = L
  // The query's budget, and each leaf's share of it (never more than one isolate may hold).
  const qSamples = Math.min(c.limits.maxQuerySamples, L * c.limits.maxSamples)
  const qSeries = Math.min(c.limits.maxQuerySeries, L * c.limits.maxSeries)
  const groups = readerGroups(series, samples)
  if (hooks.sampleOrder) hooks.sampleOrder(groups.flatMap((g) => g.samples.map((f) => f.key)))
  const ttl = fileCacheTtl(c.env)
  const base = hash32(c.queryId)
  const used = new Set<number>()
  let foreign = 0
  // Parts that could not say whether they saw one: a split leaf or a reader of the previous
  // release, which ignores `seriesByPart` and reports no `foreign` (review B-1).
  let unknown = 0
  const leaf = (n: number) => c.env.LEAF.get(c.env.LEAF.idFromName(`leaf/${c.env.CELL}/${n % pool}`))

  const run = async (j: number, budget: { samples: number; series: number }): Promise<EvaluateAnswer> => {
    const pt = tailFor(j)
    const req: EvaluateRequest = {
      query: spec.query, grid: spec.grid, fragments: spec.fragments, without: spec.without, part: j, parts: L, ranges, groups, tails: pt.tails,
      budget: { samples: budget.samples, series: budget.series, stepPoints: c.limits.maxStepPoints }, limits: c.limits, cacheTtlS: ttl, pool, queryId: c.queryId,
      // The rest of a tail that did not fit here: the leaf reads it in its key range, under the byte cap.
      ...(pt.tailParts ? { tailParts: pt.tailParts, tailMaxBytes: c.limits.maxFetchBytes, tenant: c.tenant, deadline: c.deadline } : {}),
      ...(seriesByPart ? { seriesByPart: true } : {}),
    }
    const sent = pt.tails.reduce((a, b) => a + b.byteLength, 0) + (pt.tailParts ?? []).reduce((a, p) => a + p.batches.reduce((x, b) => x + b.byteLength, 0), 0)
    const call = async (attempt: number): Promise<EvaluateAnswer> => {
      used.add((base + j + attempt) % pool)
      c.cost.leafCalls++
      if (hooks.beforeSplitLeaf) await hooks.beforeSplitLeaf(j, attempt)
      c.cost.rpcBytes += sent
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
    if (a.status === 'ok' && pt.tailParts) {
      // A leaf of the previous release ignores `tailParts` and would answer without the rest
      // of the tail: never used (contracts/COMPATIBILITY.md §3.3; retryable).
      if (!a.tail) throw new ApiError('unavailable', 'a split leaf of an earlier release answered without reading its part of the tail; retry')
      c.cost.shardCalls += a.tail.calls
      c.cost.tailBatches += a.tail.batches
      c.cost.tailBytes += a.tail.bytes
    }
    if (a.status === 'ok') {
      const st = a.stats
      // A count only from a leaf that says every one of its readers gave one: an answer without
      // it is "unknown", never 0 (its readers may have read by name and time and said nothing of
      // the series of other parts they saw).
      if (typeof st.foreign === 'number' && st.foreignUnknown === false) foreign += st.foreign
      else unknown++
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
  const tail = first.find((a) => a.status === 'tail')
  if (tail && tail.status === 'tail') return { status: 'tail', refusal: tail }
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
      if (a.status === 'tail') return { status: 'tail', refusal: a }
      if (a.status === 'ok') answers[stopped[k]!] = a.answer
    }
  }
  // A part read its id range of the series files and some part saw a series of another part
  // there, or could not say: that part may have missed one of its own (its id is elsewhere). Not merged.
  if (seriesByPart && (foreign > 0 || unknown > 0) && !hooks.ignoreForeign) return { status: 'foreign', count: foreign, unknown }
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
    // The whole tail, paged under `maxFetchBytes`: no time or metric filter, because the report
    // counts a tail series by the span of its rows in each batch (engine `cardinality`), which a
    // time filter would change at the window's edges (CARDINALITY.md "What is left" 1).
    const tails = await readTails(c, shards, snap.watermarks, known, refused, {}, c.limits.maxFetchBytes)
    if (tails.again) continue
    c.cost.filesRead = files.length
    c.cost.bytesRead = bytes
    const pool = leafPoolSize(c.env)
    const most = Math.max(1, Math.min(c.limits.maxLeaves, pool))
    const rows = files.reduce((a, f) => a + f.rows, 0)
    // Series in the window, from the series files alone (tail series come on top).
    const est = seriesEstimate(files, files.map(() => null))
    c.cost.seriesEstimate = est
    const per = c.limits.cardinalitySplitAboveSeries
    let L = hooks.forceLeaves ?? (bytes > c.limits.maxFetchBytes || est > per ? Math.min(Math.max(2, Math.ceil(rows / 250_000), Math.ceil(est / per)), most) : 1)
    if (tails.over && hooks.forceLeaves === undefined) {
      // The tail does not fit here: over leaves, each reading the rest of it in its key range
      // (exact: a part is a range of `series_id`, D32), with its share under half the cap.
      const t = tailEstimate(tails.reads)
      L = Math.min(most, Math.max(L, 2, Math.ceil(t.bytes / (0.5 * c.limits.maxFetchBytes)), Math.ceil(Math.max(est, t.series) / per)))
    }
    if (tails.over && L === 1) throw tooMuch(c, 'the unflushed tail', tails.atLeast, !tails.exact)
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
      summaries = [c.engine.cardinalityPart(got, tailBatchesOf(tails.reads), start, end, 0, 1, caps)]
      c.cost.engineMs += Math.round(performance.now() - t0)
    } else {
      c.cost.execution = 'split'
      c.cost.splitLeaves = L
      const refs = files.map((f) => ({ key: f.key, bytes: f.bytes }))
      const base = hash32(c.queryId)
      // Each part gets its own series' rows of the tail (cut here by `series_id`, all of them:
      // a part's spans are those of the whole tail), and reads the rest itself if any is left.
      const rests = tails.reads.map((r) => restOf(r, {}))
      const leafTails = !rests.every((r) => r === null)
      if (leafTails) {
        tooManyReaders(c, L, tails.atLeast)
        c.cost.tailMode += '+leaves'
      }
      const cut = cutReads(tails.reads, L, [])
      const answers = await Promise.all(
        Array.from({ length: L }, async (_, j) => {
          const pt: PartTail = leafTails
            ? { tails: [], tailParts: tails.reads.map((r, i) => ({ shard: r.shard, batches: cut[i]![j] ?? [], rest: rests[i]! })) }
            : { tails: cut.flatMap((parts) => parts[j] ?? []) }
          const req: CardinalityRequest = {
            files: refs, tails: pt.tails, part: j, parts: L, start, end, caps, cacheTtlS: fileCacheTtl(c.env),
            ...(pt.tailParts ? { tailParts: pt.tailParts, tailMaxBytes: c.limits.maxFetchBytes, tenant: c.tenant, deadline: c.deadline } : {}),
          }
          const sent = pt.tails.reduce((a, b) => a + b.byteLength, 0) + (pt.tailParts ?? []).reduce((a, p) => a + p.batches.reduce((x, b) => x + b.byteLength, 0), 0)
          const call = (attempt: number) => {
            c.cost.leafCalls++
            c.cost.rpcBytes += sent
            return c.env.LEAF.get(c.env.LEAF.idFromName(`leaf/${c.env.CELL}/${(base + j + attempt) % pool}`)).cardinality(req)
          }
          let a: Awaited<ReturnType<typeof call>>
          try {
            a = await call(0)
          } catch {
            try {
              a = await call(1)
            } catch (e) {
              throw new ApiError('unavailable', `a leaf failed twice counting its part of the report: ${e instanceof Error ? e.message : String(e)}`)
            }
          }
          if (a.status === 'ok' && pt.tailParts && !a.tail) throw new ApiError('unavailable', 'a leaf of an earlier release answered the cardinality report without reading its part of the tail; retry')
          return a
        }),
      )
      const missing = answers.find((a) => a.status === 'missing')
      if (missing && missing.status === 'missing') {
        refused(`file ${missing.key}`, `data file ${missing.key} is listed by the ledger but is not in R2`)
        continue
      }
      const tail = answers.find((a) => a.status === 'tail')
      if (tail && tail.status === 'tail') {
        tailRefused(c, tail, known, refused, L)
        continue
      }
      summaries = answers.map((a) => (a.status === 'ok' ? a.summary : new Uint8Array()))
      for (const a of answers) {
        if (a.status === 'ok') {
          c.cost.rpcBytes += a.summary.byteLength
          c.cost.cacheHits += a.cacheHits
          c.cost.r2Gets += a.r2Gets
          if (a.tail) {
            c.cost.shardCalls += a.tail.calls
            c.cost.tailBatches += a.tail.batches
            c.cost.tailBytes += a.tail.bytes
          }
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
