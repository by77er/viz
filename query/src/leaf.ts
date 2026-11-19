import { DurableObject } from 'cloudflare:workers'
import { type FetchRange, type FilePlan, type Grid, type LeafBudget, type QueryLimits, createQueryEngine, sparseFile } from '../../engine/wasm-query/js/index'
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
  /** Readers read whole files, as before 2026-11-19 (for the measurement's same-run comparison). */
  wholeReads?: boolean
} = {}

/** One file a reader reads: its key and the size the ledger recorded. */
export interface FileRef {
  key: string
  bytes: number
  /**
   * Its index fragment (`FileEntry.index`). With it a reader range-reads only its part of
   * the file (contracts/TABLES.md, "Reading part of a file"); without it (a coordinator of an
   * earlier release) it reads the whole object, as before.
   */
  index?: string
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
  | { status: 'ok'; batch: Uint8Array; rows: number; series: number; bytesRead: number; cacheHits: number; r2Gets: number; engineMs: number }
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
  /** Time in this leaf's own engine calls (gathering and evaluating), not its readers'. */
  ownEngineMs: number
  /** Its readers' engine time: the sum, and the longest one call took. */
  readerEngineMs: number
  readerEngineMaxMs: number
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

/** Run `f` over `items` with at most `n` in flight; results in the order of `items`. */
export async function inWaves<I, O>(items: I[], n: number, f: (item: I) => Promise<O>): Promise<O[]> {
  const out: O[] = new Array(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const k = next++
      out[k] = await f(items[k]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker))
  return out
}

/** Whether reading as `have` fetched every byte `need` reads (`need` is not 'skip'). */
export function covers(have: FilePlan['read'], need: Exclude<FilePlan['read'], 'skip'>): boolean {
  if (have === 'whole') return true
  if (have === 'skip' || need === 'whole') return false
  return need.every(([o, l]) => have.some(([ho, hl]) => o >= ho && o + l <= ho + hl))
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
    const stats = { cacheHits: 0, r2Gets: 0, bytesRead: 0 }
    // Every byte range, at most six in flight (a Durable Object's own connections).
    const fetch = async (list: { f: FileRef; read: 'whole' | [number, number][] }[]): Promise<{ status: 'ok'; bytes: Uint8Array[] } | { status: 'missing'; key: string } | { status: 'refused'; reason: string }> => {
      const items: { i: number; item: ReadItem; length: number }[] = []
      list.forEach(({ f, read }, i) => {
        if (read === 'whole') items.push({ i, item: { key: f.key }, length: f.bytes })
        else for (const [offset, length] of read) items.push({ i, item: { key: f.key, offset, length }, length })
      })
      const got = await inWaves(items, MAX_READS_PER_CALL, (x) => this.one(x.item, req.cacheTtlS))
      const parts: { offset: number; bytes: Uint8Array }[][] = list.map(() => [])
      for (let k = 0; k < items.length; k++) {
        const r = got[k]!
        const { i, item, length } = items[k]!
        if (r.status !== 'ok') return { status: 'missing', key: item.key }
        // A short read would be a silent hole: refuse it.
        if (r.bytes.byteLength !== length) return { status: 'refused', reason: `data file ${item.key}: read ${r.bytes.byteLength} bytes, expected ${length}` }
        if (r.cached) stats.cacheHits++
        else stats.r2Gets++
        stats.bytesRead += r.bytes.byteLength
        parts[i]!.push({ offset: item.offset ?? 0, bytes: r.bytes })
      }
      return { status: 'ok', bytes: list.map(({ f, read }, i) => (read === 'whole' ? parts[i]![0]!.bytes : sparseFile(f.bytes, parts[i]!))) }
    }
    const asRead = (p: FilePlan | undefined): 'whole' | [number, number][] | null => (!p || p.read === 'whole' ? 'whole' : p.read === 'skip' ? null : p.read)
    try {
      let engineMs = 0
      const own = <T>(f: () => T): T => {
        const t = performance.now()
        try {
          return f()
        } finally {
          engineMs += performance.now() - t
        }
      }
      const ranged = !leafHooks.wholeReads && req.samples.length > 0 && req.samples.every((f) => typeof f.index === 'string') && req.series.every((f) => typeof f.index === 'string')
      let seriesBytes: Uint8Array[]
      let sampleBytes: Uint8Array[]
      if (!ranged) {
        // Whole objects (a request without fragments).
        const r = await fetch(files.map((f) => ({ f, read: 'whole' as const })))
        if (r.status !== 'ok') return r
        seriesBytes = r.bytes.slice(0, req.series.length)
        sampleBytes = r.bytes.slice(req.series.length)
      } else {
        // One round: the series files by name and time, and of each sample file the row
        // groups of this part's series_id range (exact for every series whose split key is
        // its id: all but those that carry a label of `without`). When `without` holds a
        // label other than `__type__` and `__unit__` (a relabelled or unpinned name, which
        // most series carry), the part's series are spread over every id, so the sample
        // files wait for the series files instead (two rounds, nothing read twice).
        const sp = own(() => leafEngine.filePlan(req.series.map((f) => f.index!), req.ranges))
        const optimistic = req.without.every((l) => l === '__type__' || l === '__unit__')
        const pp: FilePlan[] = optimistic ? own(() => leafEngine.partPlan(req.samples.map((f) => f.index!), req.ranges, req.part, req.parts)) : req.samples.map(() => ({ rows: 0, read: 'skip' }))
        const first: { f: FileRef; read: 'whole' | [number, number][] }[] = []
        const seriesAt: number[] = []
        const samplesAt: number[] = []
        req.series.forEach((f, i) => {
          const read = asRead(sp[i])
          seriesAt.push(read === null ? -1 : first.length)
          if (read !== null) first.push({ f, read })
        })
        req.samples.forEach((f, i) => {
          const read = asRead(pp[i])
          samplesAt.push(read === null ? -1 : first.length)
          if (read !== null) first.push({ f, read })
        })
        const r = await fetch(first)
        if (r.status !== 'ok') return r
        seriesBytes = seriesAt.filter((k) => k >= 0).map((k) => r.bytes[k]!)
        sampleBytes = samplesAt.filter((k) => k >= 0).map((k) => r.bytes[k]!)
        if (optimistic) {
          // The id range is enough unless one of the part's series lies outside it.
          const ex = own(() => leafEngine.extract(seriesBytes, sampleBytes, req.without, req.part, req.parts, req.ranges))
          if (ex.strays === 0) return { status: 'ok', batch: ex.batch, rows: ex.rows, series: ex.series, bytesRead: stats.bytesRead, cacheHits: stats.cacheHits, r2Gets: stats.r2Gets, engineMs }
        }
        // What the part's series need, now that their labels are known; a sample file whose
        // first read does not cover it is read again as planned (a second round). The part's
        // series by their split key, whatever the other matchers say (the extract applies
        // them): with only the metric's name left, the engine parses no label set except of a
        // series that carries a `without` label. A group lists each sample file with its
        // series file at the same position.
        const pairOf = req.samples.map((_, i) => (seriesAt[i] !== undefined && seriesAt[i]! >= 0 ? seriesAt.slice(0, i).filter((k) => k >= 0).length : null))
        const byName = req.ranges.map((x) => ({ ...x, matchers: x.matchers.filter((m) => m.name === '__name__' && m.op === '=') }))
        const exact = own(() => leafEngine.samplePlan(seriesBytes, req.samples.map((f) => f.index!), byName, { without: req.without, part: req.part, parts: req.parts }, pairOf))
        const again: { f: FileRef; read: 'whole' | [number, number][] }[] = []
        const againAt = new Map<number, number>()
        req.samples.forEach((f, i) => {
          const need = exact.files[i]!.read
          if (need === 'skip' || covers(pp[i]!.read, need)) return
          againAt.set(i, again.length)
          again.push({ f, read: need })
        })
        let more: Uint8Array[] = []
        if (again.length > 0) {
          const r2 = await fetch(again)
          if (r2.status !== 'ok') return r2
          more = r2.bytes
        }
        sampleBytes = []
        req.samples.forEach((_, i) => {
          if (exact.files[i]!.read === 'skip') return
          const k = againAt.get(i)
          sampleBytes.push(k !== undefined ? more[k]! : r.bytes[samplesAt[i]!]!)
        })
      }
      const ex = own(() => leafEngine.extract(seriesBytes, sampleBytes, req.without, req.part, req.parts, req.ranges))
      return { status: 'ok', batch: ex.batch, rows: ex.rows, series: ex.series, bytesRead: stats.bytesRead, cacheHits: stats.cacheHits, r2Gets: stats.r2Gets, engineMs }
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
    const stats: EvaluateStats = {
      readerCalls: 0, readerRetries: 0, extractBytes: 0, extractRows: 0, bytesRead: 0, cacheHits: 0, r2Gets: 0, wasmMemoryBytes: 0, ms: 0, ownEngineMs: 0, readerEngineMs: 0, readerEngineMaxMs: 0,
    }
    const own = <T>(f: () => T): T => {
      const t = performance.now()
      try {
        return f()
      } finally {
        stats.ownEngineMs += performance.now() - t
      }
    }
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
            stats.readerEngineMs += answer.engineMs ?? 0
            stats.readerEngineMaxMs = Math.max(stats.readerEngineMaxMs, answer.engineMs ?? 0)
            // Gathered as it arrives, with its group's precedence: arrival order does not matter.
            const batch = answer.batch
            if (!aborted && missing === null && refused === null && batch.byteLength > 0) aborted = own(() => leafEngine.gatherAdd(handle, gi, batch).aborted)
          }
        }),
      )
      if (missing !== null) return { status: 'missing', key: missing }
      if (refused !== null) return { status: 'refused', reason: refused }
      if (!aborted) {
        for (let i = 0; i < req.tails.length && !aborted; i++) aborted = own(() => leafEngine.gatherAdd(handle, req.groups.length + i, req.tails[i]!).aborted)
      }
      open = false
      openSessions--
      const answer = own(() => leafEngine.gatherEval(handle, req.query, req.grid, req.fragments, req.limits))
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
