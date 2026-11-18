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
import type { FileEntry, Plan, Watermark } from '../../contracts/ledger'
import { poolMap } from '../../edge/src/route'
import type { FetchRange, QueryEngine, QueryStats } from '../../engine/wasm-query/js/index'
import { hash32, shardName, tenantSlots } from '../../shard/src/pool'
import { type Env, type TenantLimits, fileCacheTtl, leafPoolSize } from './config'
import { MAX_BYTES_PER_CALL, MAX_READS_PER_CALL, type ReadItem, type ReadResult } from './leaf'

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
}

export const newCost = (): Cost => ({
  ledgerVersion: 0, planAttempts: 0, filesListed: 0, filesSkipped: 0, filesRead: 0, scanSamples: 0, bytesRead: 0, cacheHits: 0, r2Gets: 0, leafCalls: 0,
  leavesUsed: 0, leafRounds: 0, shardsAsked: 0, shardCalls: 0, tailBatches: 0, tailBytes: 0, seriesLoaded: 0, samplesLoaded: 0, engineMs: 0, wasmMemoryBytes: 0,
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
  samples: FileEntry[]
  series: FileEntry[]
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
 * The ledger lists files in key order, and key order is text order: `…-10-12-…` sorts
 * before `…-2-9-…`, so from a stream's tenth batch on, key order would let an OLDER
 * flush win over a newer one. The order used here, from the key (contracts/TABLES.md):
 *
 *   1. compaction outputs (level 1 and up), higher level first, then by key: they hold
 *      what older flush files held;
 *   2. flush files (level 0) by shard, incarnation and sequence range, as numbers.
 *
 * What this cannot order: two compaction outputs that both hold the same sample (README,
 * "Needed changes": the ledger should carry an explicit precedence).
 */
const FLUSH_KEY = /\/L0-(.+)-(\d+)-(\d+)-(\d+)-[0-9a-f]{8}\.parquet$/
const LEVEL = /\/L(\d+)-[^/]*$/

export function byPrecedence(files: FileEntry[]): FileEntry[] {
  const rank = (f: FileEntry) => {
    const m = FLUSH_KEY.exec(f.key)
    const level = f.level > 0 ? f.level : Number(LEVEL.exec(f.key)?.[1] ?? 0)
    return m && level === 0 ? { level: 0, shard: m[1]!, inc: Number(m[2]), lo: Number(m[3]), hi: Number(m[4]), key: f.key } : { level, shard: '', inc: 0, lo: 0, hi: 0, key: f.key }
  }
  const text = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
  return files
    .map((f) => ({ f, r: rank(f) }))
    .sort((x, y) => y.r.level - x.r.level || text(x.r.shard, y.r.shard) || x.r.inc - y.r.inc || x.r.lo - y.r.lo || x.r.hi - y.r.hi || text(x.r.key, y.r.key))
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
    const r = await stub.tailRead(c.tenant, incarnation, above)
    if (r.status === 'ok') {
      let bytes = 0
      const batches = r.batches.map((b) => {
        bytes += b.payload.byteLength
        return b.payload
      })
      return { status: 'ok', batches, bytes }
    }
    if (r.status === 'stale_watermark') return { status: 'refused', why: `shard ${shard} has discarded rows above the watermark` }
    // incarnation_mismatch
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
export async function gather<T>(c: Context, ranges: FetchRange[], reads: FetchRange[], evaluate: (input: ScanInput) => T): Promise<T> {
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
      // engine lowest precedence first (see `byPrecedence`).
      snap.samples = byPrecedence(snap.samples)
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

      const all = got.ok ? got.bytes : []
      const input: ScanInput = { seriesFiles: all.slice(0, series.length), sampleFiles: all.slice(series.length), tailBatches }
      return timed(c, evaluate, input)
    }
  } finally {
    inFlightBytes -= reserved
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
