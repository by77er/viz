import { DurableObject } from 'cloudflare:workers'
import { type FetchRange, type Grid, type LeafBudget, type QueryLimits, createQueryEngine } from '../../engine/wasm-query/js/index'
import wasm from '../../engine/wasm-query/js/viz_query.wasm'
import { hash32 } from '../../shard/src/pool'

/**
 * A query leaf: a stateless Durable Object that reads data files from R2 for a
 * coordinator and hands the bytes back.
 *
 * Why an object at all (design D17, measured in spikes/s1-fanout-r2): one request may
 * have six R2 reads in flight, and a Worker reached through a service binding spends
 * from its caller's six. A Durable Object has six of its own. So the coordinator
 * spreads a query's reads over a pool of leaves, at most six per leaf per call.
 *
 * A leaf keeps NOTHING between calls: no storage, no fields, no alarm. Evicting one at
 * any moment loses nothing; the next call creates it again.
 */

/** R2 reads one call may issue. The platform's limit on connections in flight. */
export const MAX_READS_PER_CALL = 6

/**
 * Bytes one call may return. An RPC message is limited to 32 MiB; this leaves room for
 * the structure around the buffers. The coordinator packs calls to stay under it from
 * the sizes the ledger reports, and cuts a larger object into range reads.
 */
export const MAX_BYTES_PER_CALL = 24 << 20

/** One read: a whole object, or `length` bytes from `offset` (the seam for row-group reads). */
export interface ReadItem {
  key: string
  offset?: number
  length?: number
}

export type ReadResult =
  | { status: 'ok'; bytes: Uint8Array; cached: boolean }
  /** The object is not in R2. The caller's plan is stale (or the lake is damaged): never a silent gap. */
  | { status: 'missing' }

/** A call the leaf will not make is refused with a reason: an explicit status, not an exception. */
export type LeafAnswer = { status: 'ok'; results: ReadResult[] } | { status: 'refused'; reason: string }

export interface LeafEnv {
  BUCKET: R2Bucket
  /** The pool itself: a split leaf asks other leaves to read and extract its rows. */
  LEAF: DurableObjectNamespace<Leaf>
  CELL: string
}

/**
 * The leaves' own engine instance: never the coordinator's, so that a coordinator's
 * reset cannot drop a leaf's gathering session (in tests, and wherever a Durable Object
 * shares an isolate with the Worker).
 */
export const leafEngine = createQueryEngine(wasm)
/** Gathering sessions open in this isolate; the engine is reset only when there are none. */
let openSessions = 0
const RESET_WASM_ABOVE = 48 << 20

function maybeReset(): void {
  if (openSessions === 0 && leafEngine.memoryBytes() > RESET_WASM_ABOVE) leafEngine.reset()
}

/** Test hooks. Empty in production. */
export const leafHooks: {
  /** Drop the engine instance before a split leaf starts, so its memory figure is its own peak. */
  resetBeforeEvaluate?: boolean
  /** Called before a split leaf asks a reader; may throw to simulate a failure. */
  beforeExtract?: (part: number, group: number, attempt: number) => Promise<void>
  /** Called when a split leaf starts; may throw to simulate a failure. */
  beforeEvaluate?: (part: number, attempt: number) => Promise<void>
} = {}

/** One file a reader reads: its key and the size the ledger recorded. */
export interface FileRef {
  key: string
  bytes: number
}

/** A reader's job: sample files (precedence order) and the series files that describe them. */
export interface ExtractRequest {
  series: FileRef[]
  samples: FileRef[]
  without: string[]
  part: number
  parts: number
  ranges: FetchRange[]
  cacheTtlS: number
}

export type ExtractAnswer =
  | { status: 'ok'; batch: Uint8Array; rows: number; series: number; bytesRead: number; cacheHits: number; r2Gets: number }
  | { status: 'missing'; key: string }
  | { status: 'refused'; reason: string }

/** A split leaf's job: one part of a split query. */
export interface EvaluateRequest {
  query: string
  grid: Grid
  fragments: number
  without: string[]
  part: number
  parts: number
  ranges: FetchRange[]
  /** Reader groups, in precedence order: each at most six files. */
  groups: { series: FileRef[]; samples: FileRef[] }[]
  /** This part's tail batches, in order. */
  tails: Uint8Array[]
  budget: LeafBudget
  limits: QueryLimits
  cacheTtlS: number
  pool: number
  queryId: string
}

export interface EvaluateStats {
  readerCalls: number
  readerRetries: number
  extractBytes: number
  extractRows: number
  bytesRead: number
  cacheHits: number
  r2Gets: number
  /** This leaf's engine memory after evaluating (its peak if it had the instance to itself). */
  wasmMemoryBytes: number
  ms: number
}

export type EvaluateAnswer = { status: 'ok'; answer: Uint8Array; stats: EvaluateStats } | { status: 'missing'; key: string } | { status: 'refused'; reason: string }

/**
 * Cache key of a read. The object key is content-hashed (contracts/TABLES.md: `hash8` of
 * the bytes, and objects are written once with `If-None-Match: *`), so the same key
 * always means the same bytes and a cached copy can never be stale. The key also holds
 * the tenant, so one tenant's entry cannot answer for another's.
 */
export function cacheUrl(item: ReadItem): string {
  const range = item.offset === undefined && item.length === undefined ? '' : `?offset=${item.offset ?? 0}&length=${item.length ?? ''}`
  return `https://viz-file-cache.invalid/${item.key.split('/').map(encodeURIComponent).join('/')}${range}`
}

/** The Workers default cache. (Typed here because the DOM library's `CacheStorage` has no `default`.) */
export const fileCache = (): Cache => (caches as unknown as { default: Cache }).default

export class Leaf extends DurableObject<LeafEnv> {
  /**
   * Read up to six items in parallel. Results are in the order of `items`.
   * `cacheTtlS` > 0: look in the Cache API first and store what was read from R2 there.
   */
  async read(items: ReadItem[], cacheTtlS: number): Promise<LeafAnswer> {
    if (items.length > MAX_READS_PER_CALL) return { status: 'refused', reason: `${items.length} reads in one call; the limit is ${MAX_READS_PER_CALL}` }
    const results = await Promise.all(items.map((item) => this.one(item, cacheTtlS)))
    let total = 0
    for (const r of results) if (r.status === 'ok') total += r.bytes.byteLength
    // Refuse rather than fail somewhere inside the RPC layer with an opaque error.
    if (total > MAX_BYTES_PER_CALL) return { status: 'refused', reason: `${total} bytes in one call; the limit is ${MAX_BYTES_PER_CALL}` }
    return { status: 'ok', results }
  }

  /**
   * Reader: read up to six files and return the rows of one part of a split query, as one
   * batch (engine `extract`). Only the part's series are decoded.
   */
  async extract(req: ExtractRequest): Promise<ExtractAnswer> {
    const files = [...req.series, ...req.samples]
    if (files.length > MAX_READS_PER_CALL) return { status: 'refused', reason: `${files.length} reads in one call; the limit is ${MAX_READS_PER_CALL}` }
    const total = files.reduce((a, f) => a + f.bytes, 0)
    if (total > MAX_BYTES_PER_CALL) return { status: 'refused', reason: `${total} bytes in one call; the limit is ${MAX_BYTES_PER_CALL}` }
    const read = await Promise.all(files.map((f) => this.one({ key: f.key }, req.cacheTtlS)))
    let cacheHits = 0
    let bytesRead = 0
    const bytes: Uint8Array[] = []
    for (let i = 0; i < files.length; i++) {
      const r = read[i]!
      if (r.status !== 'ok') return { status: 'missing', key: files[i]!.key }
      // A short read would be a silent hole: refuse it.
      if (r.bytes.byteLength !== files[i]!.bytes) return { status: 'refused', reason: `data file ${files[i]!.key}: read ${r.bytes.byteLength} bytes, expected ${files[i]!.bytes}` }
      if (r.cached) cacheHits++
      bytesRead += r.bytes.byteLength
      bytes.push(r.bytes)
    }
    try {
      const ex = leafEngine.extract(bytes.slice(0, req.series.length), bytes.slice(req.series.length), req.without, req.part, req.parts, req.ranges)
      return { status: 'ok', batch: ex.batch, rows: ex.rows, series: ex.series, bytesRead, cacheHits, r2Gets: files.length - cacheHits }
    } finally {
      maybeReset()
    }
  }

  /**
   * Split leaf: gather this part's rows from readers (other leaves of the pool, one call
   * per group of at most six files, all at once) and from the tail batches the
   * coordinator sent, then evaluate the query's fragments over them. Gathering stops as
   * soon as the part holds more than its budget; the answer then says so, and the
   * coordinator decides. Holds nothing after it returns.
   */
  async evaluate(req: EvaluateRequest): Promise<EvaluateAnswer> {
    const t0 = Date.now()
    if (leafHooks.beforeEvaluate) await leafHooks.beforeEvaluate(req.part, 0)
    if (leafHooks.resetBeforeEvaluate && openSessions === 0) leafEngine.reset()
    const stats: EvaluateStats = { readerCalls: 0, readerRetries: 0, extractBytes: 0, extractRows: 0, bytesRead: 0, cacheHits: 0, r2Gets: 0, wasmMemoryBytes: 0, ms: 0 }
    const handle = leafEngine.gatherNew(req.ranges, req.budget)
    openSessions++
    let open = true
    try {
      let aborted = false
      let missing: string | null = null
      let refused: string | null = null
      const stub = (n: number) => this.env.LEAF.get(this.env.LEAF.idFromName(`leaf/${this.env.CELL}/${n % req.pool}`))
      await Promise.all(
        req.groups.map(async (g, gi) => {
          const job: ExtractRequest = { series: g.series, samples: g.samples, without: req.without, part: req.part, parts: req.parts, ranges: req.ranges, cacheTtlS: req.cacheTtlS }
          const start = hash32(`${req.queryId}\u0000${req.part}\u0000${gi}`)
          let answer: ExtractAnswer
          const call = async (attempt: number): Promise<ExtractAnswer> => {
            if (leafHooks.beforeExtract) await leafHooks.beforeExtract(req.part, gi, attempt)
            stats.readerCalls++
            return stub(start + attempt).extract(job)
          }
          try {
            answer = await call(0)
          } catch {
            // One retry on the next leaf of the pool; a second failure fails the part.
            stats.readerRetries++
            answer = await call(1)
          }
          if (answer.status === 'missing') missing ??= answer.key
          else if (answer.status === 'refused') refused ??= answer.reason
          else {
            stats.extractBytes += answer.batch.byteLength
            stats.extractRows += answer.rows
            stats.bytesRead += answer.bytesRead
            stats.cacheHits += answer.cacheHits
            stats.r2Gets += answer.r2Gets
            // Gathered as it arrives, with its group's precedence: arrival order does not matter.
            if (!aborted && missing === null && refused === null && answer.batch.byteLength > 0) aborted = leafEngine.gatherAdd(handle, gi, answer.batch).aborted
          }
        }),
      )
      if (missing !== null) return { status: 'missing', key: missing }
      if (refused !== null) return { status: 'refused', reason: refused }
      if (!aborted) {
        for (let i = 0; i < req.tails.length && !aborted; i++) aborted = leafEngine.gatherAdd(handle, req.groups.length + i, req.tails[i]!).aborted
      }
      open = false
      openSessions--
      const answer = leafEngine.gatherEval(handle, req.query, req.grid, req.fragments, req.limits)
      stats.wasmMemoryBytes = leafEngine.memoryBytes()
      stats.ms = Date.now() - t0
      return { status: 'ok', answer, stats }
    } finally {
      if (open) {
        openSessions--
        leafEngine.gatherFree(handle)
      }
      maybeReset()
    }
  }

  /**
   * Cardinality: read every series file (six at a time) and summarise the series of one
   * part (a range of `series_id`s) for the report.
   */
  async cardinality(req: {
    files: FileRef[]
    tails: Uint8Array[]
    part: number
    parts: number
    start: number
    end: number
    caps: { maxSeries: number; maxPairs: number }
    cacheTtlS: number
  }): Promise<{ status: 'ok'; summary: Uint8Array; cacheHits: number; r2Gets: number } | { status: 'missing'; key: string }> {
    const bytes: Uint8Array[] = new Array(req.files.length)
    let cacheHits = 0
    for (let i = 0; i < req.files.length; i += MAX_READS_PER_CALL) {
      const wave = req.files.slice(i, i + MAX_READS_PER_CALL)
      const got = await Promise.all(wave.map((f) => this.one({ key: f.key }, req.cacheTtlS)))
      for (let k = 0; k < wave.length; k++) {
        const r = got[k]!
        if (r.status !== 'ok') return { status: 'missing', key: wave[k]!.key }
        if (r.cached) cacheHits++
        bytes[i + k] = r.bytes
      }
    }
    try {
      const summary = leafEngine.cardinalityPart(bytes, req.tails, req.start, req.end, req.part, req.parts, req.caps)
      return { status: 'ok', summary, cacheHits, r2Gets: req.files.length - cacheHits }
    } finally {
      maybeReset()
    }
  }

  private async one(item: ReadItem, cacheTtlS: number): Promise<ReadResult> {
    const url = cacheUrl(item)
    if (cacheTtlS > 0) {
      const hit = await fileCache().match(url)
      if (hit) return { status: 'ok', bytes: new Uint8Array(await hit.arrayBuffer()), cached: true }
    }
    const ranged = item.offset !== undefined || item.length !== undefined
    const object = await this.env.BUCKET.get(item.key, ranged ? { range: { offset: item.offset ?? 0, length: item.length } } : undefined)
    if (!object) return { status: 'missing' }
    const bytes = new Uint8Array(await object.arrayBuffer())
    if (cacheTtlS > 0) {
      // Bounded lifetime, so that erased data ages out of the cache (design §6.3).
      await fileCache()
        .put(url, new Response(bytes, { headers: { 'Cache-Control': `public, max-age=${cacheTtlS}`, 'Content-Type': 'application/octet-stream' } }))
        .catch(() => {}) // the cache is an accelerator: failing to fill it is not an error
    }
    return { status: 'ok', bytes, cached: false }
  }
}
