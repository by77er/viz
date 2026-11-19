/**
 * The JavaScript binding of the viz QUERY engine: the query half of `contracts/engine.ts`
 * (`selectors`/`plan`, `queryRange`, `queryInstant`, `select`), the metadata calls and
 * file pruning, over the C ABI documented in `../src/lib.rs`.
 *
 * Number rules (contracts/engine.ts):
 *  - Times going in must be integers (Unix milliseconds). A fractional or NaN time is
 *    refused, never rounded. They cross as i64, written into the request buffer.
 *  - Sample values never pass through JavaScript arithmetic. Query results are JSON
 *    produced inside the engine, with values as Prometheus-formatted strings; `select`
 *    copies raw bytes from WASM memory into a `Float64Array`'s backing buffer.
 *  - Limits are passed with every call. Nothing is configured on the instance.
 *
 * Memory: a request (files and batches included) is written straight into WASM linear
 * memory, one copy per input buffer; results are copied out once and the WASM side is
 * freed before returning. Linear memory never shrinks, so `memoryBytes()` is the
 * instance's high-water mark; `reset()` drops the instance so the memory can be reclaimed.
 *
 * A trap (the Rust side is built with panic=abort) leaves an instance in an unknown state.
 * The binding then drops the instance and creates a fresh one for the next call.
 */
import type { Matcher, PromMatrix, PromScalar, PromString, PromVector, ScanInput, SeriesData } from '../../../contracts/engine'

export const ABI_VERSION = 3

/** Bounds on one query (`engine/query` `Limits`, plus the step cap of `viz-promql`). */
export interface QueryLimits {
  /** Samples loaded from storage, summed over every selector of the query. */
  maxSamples: number
  /** Series loaded from storage, summed over every selector. */
  maxSeries: number
  /** Points in the result. */
  maxOutputPoints: number
  /** For any one selector: series times evaluation steps (the evaluator's grid). */
  maxStepPoints: number
  /** Length of the query text in bytes. */
  maxQueryBytes: number
  /** Nesting depth of the expression. */
  maxDepth: number
  /** Steps of a range query (Prometheus: 11,000). Exceeding it is `bad_data`. */
  maxSteps: number
}

/** The engine's own defaults (`engine/query/src/limits.rs`), sized for a 128 MB isolate. */
export const DEFAULT_LIMITS: QueryLimits = {
  maxSamples: 2_000_000,
  maxSeries: 20_000,
  maxOutputPoints: 500_000,
  maxStepPoints: 1_000_000,
  maxQueryBytes: 16 * 1024,
  maxDepth: 100,
  maxSteps: 11_000,
}

export type ErrorType = 'bad_data' | 'execution' | 'unsupported' | 'internal'

/** An error the engine reported, with the Prometheus `errorType`. */
export class QueryError extends Error {
  override name = 'QueryError'
  readonly errorType: ErrorType
  /** Set when a limit was exceeded: its name (`max_samples`, …), its value and the number reached. */
  readonly limit?: { name: string; max: number; reached: number }
  constructor(errorType: ErrorType, message: string, limit?: { name: string; max: number; reached: number }) {
    super(message)
    this.errorType = errorType
    this.limit = limit
  }
}

/** The message prefix of `EngineLoadError` (it survives an RPC boundary as text). */
export const ENGINE_LOAD_PREFIX = 'engine: the WebAssembly module did not load'

/**
 * The module could not be instantiated (or is not the ABI this binding speaks). Not a
 * query's fault and not transient: retrying in the same deployment cannot help.
 */
export class EngineLoadError extends Error {
  override name = 'EngineLoadError'
  constructor(cause: string) {
    super(`${ENGINE_LOAD_PREFIX}: ${cause}`)
  }
}

/** What a query read (design §6.5). */
export interface QueryStats {
  /** Calls the evaluator made to storage. */
  selects: number
  series: number
  samples: number
  outputPoints: number
}

/** One thing to fetch: every sample of every series matching `matchers` in `[minTs, maxTs]`. */
export interface FetchRange {
  matchers: Matcher[]
  minTs: number
  maxTs: number
}

export type InstantData = PromVector | PromScalar | PromMatrix | PromString

/** How a query is executed (`engine/query` `split_plan`). */
export type SplitPlan = { split: true; fragments: number; without: string[] } | { split: false; reason: string }

/** Where a split query is evaluated: a range query, or an instant query at `time`. */
export type Grid = { start: number; end: number; step: number } | { time: number }

/** What one leaf may hold and load: its share of the query's budget. */
export interface LeafBudget {
  samples: number
  series: number
  stepPoints: number
}

/** A reader's rows of one part, as one `VZB1` batch (empty: no rows). */
export interface Extract {
  batch: Uint8Array
  rows: number
  series: number
}

/** The fixed header of a leaf's answer (`engine/query` `LeafOutput`). */
export interface LeafSummary {
  status: 'ok' | 'error' | 'aborted'
  /** Distinct samples and series the leaf held. */
  gatheredSamples: number
  gatheredSeries: number
  /** Samples and series its selects loaded. */
  loadedSamples: number
  loadedSeries: number
}

/** Bounds on a cardinality report (exact counting; above a cap the report is refused). */
export interface CardinalityCaps {
  maxSeries: number
  maxPairs: number
}

/** Read the fixed header of a leaf's answer without a call into the module. */
export function leafSummary(answer: Uint8Array): LeafSummary {
  if (answer.byteLength < 37 || answer[0] !== 0x56 || answer[1] !== 0x5a || answer[2] !== 0x4c || answer[3] !== 0x31) throw new RangeError('engine: not a leaf answer')
  const dv = new DataView(answer.buffer, answer.byteOffset, answer.byteLength)
  const n = (i: number): number => Number(dv.getBigUint64(5 + 8 * i, true))
  const status = answer[4] === 0 ? 'ok' : answer[4] === 1 ? 'error' : 'aborted'
  return { status, gatheredSamples: n(0), gatheredSeries: n(1), loadedSamples: n(2), loadedSeries: n(3) }
}

/**
 * How to read one file (`engine/query` `FilePlan`): skip it, read it whole, or range-read
 * these `[offset, length]` byte ranges (its footer and the row groups needed; sorted,
 * disjoint) and hand the engine `sparseFile(size, …)` of them.
 */
export type FileRead = 'skip' | 'whole' | [number, number][]

export interface FilePlan {
  /** Upper bound on the rows the reads decode from the file; null when its fragment does not parse. */
  rows: number | null
  read: FileRead
}

/** `samplePlan`'s answer. */
export interface ReadPlan {
  /** Series the reads select (summed over reads, per file in their window): exact for the lake. */
  series: number
  files: FilePlan[]
  /**
   * When every read selects by more than a name: a batch of exactly the selected series
   * (rows at a time no read covers). Evaluate with it FIRST among the tail batches and no
   * series files: same answer, without resolving the series again or holding the series files.
   */
  carrier: Uint8Array | null
}

/** Ranges less than this many bytes apart are read as one (contracts/TABLES.md, "Reading part of a file"). */
export const RANGE_GAP = 64 << 10

/** Bytes a plan reads of a file of `size` bytes. */
export function planBytes(p: FilePlan, size: number): number {
  return p.read === 'skip' ? 0 : p.read === 'whole' ? size : p.read.reduce((a, r) => a + r[1], 0)
}

const SPARSE_MAGIC = [0x56, 0x5a, 0x53, 0x31] // "VZS1"

/**
 * A sparse file container (`engine/storage` `sparse`): the `segments` of a file of `size`
 * bytes, each at its offset, as the engine takes a file it has only part of. Segments must
 * be sorted and disjoint (as `FileRead` ranges are); the engine checks.
 */
export function sparseFile(size: number, segments: { offset: number; bytes: Uint8Array }[]): Uint8Array {
  const data = segments.reduce((a, s) => a + s.bytes.byteLength, 0)
  const out = new Uint8Array(16 + 16 * segments.length + data)
  const dv = new DataView(out.buffer)
  out.set(SPARSE_MAGIC, 0)
  dv.setBigUint64(4, BigInt(size), true)
  dv.setUint32(12, segments.length, true)
  let at = 16
  for (const s of segments) {
    dv.setBigUint64(at, BigInt(s.offset), true)
    dv.setBigUint64(at + 8, BigInt(s.bytes.byteLength), true)
    at += 16
  }
  for (const s of segments) {
    out.set(s.bytes, at)
    at += s.bytes.byteLength
  }
  return out
}

export interface QueryEngine {
  /** What to fetch before evaluating: merged, clamped ranges. `startMs === endMs` plans an instant query. */
  plan(promql: string, startMs: number, endMs: number, stepMs: number, limits?: QueryLimits): FetchRange[]
  /** `contracts/engine.ts` `selectors`: one entry per selector, unmerged. */
  selectors(promql: string, startMs: number, endMs: number, stepMs: number, limits?: QueryLimits): FetchRange[]
  /** `contracts/engine.ts` `queryRange`: the parsed `data` object. */
  queryRange(input: ScanInput, promql: string, startMs: number, endMs: number, stepMs: number, limits?: QueryLimits): PromMatrix
  /** The same as the engine wrote it (JSON text of `data`), with what it read. An HTTP layer passes the text through unparsed. */
  queryRangeJson(input: ScanInput, promql: string, startMs: number, endMs: number, stepMs: number, limits?: QueryLimits): { json: string; stats: QueryStats }
  queryInstant(input: ScanInput, promql: string, timeMs: number, limits?: QueryLimits): InstantData
  queryInstantJson(input: ScanInput, promql: string, timeMs: number, limits?: QueryLimits): { json: string; stats: QueryStats }
  /** `contracts/engine.ts` `select`. */
  select(input: ScanInput, matchers: Matcher[], minTs: number, maxTs: number): SeriesData[]
  /** `match[]` strings to matchers. Anything but a bare, selective series selector is `bad_data`. */
  parseSelectors(selectors: string[]): Matcher[][]
  /** `/api/v1/labels`. `match` empty: every series. */
  labelNames(input: ScanInput, match: string[], minTs: number, maxTs: number, limits?: QueryLimits): string[]
  /** `/api/v1/label/<name>/values`. */
  labelValues(input: ScanInput, name: string, match: string[], minTs: number, maxTs: number, limits?: QueryLimits): string[]
  /** `/api/v1/series`. At least one `match`. */
  series(input: ScanInput, match: string[], minTs: number, maxTs: number, limits?: QueryLimits): Record<string, string>[]
  /**
   * For each index fragment (`FileEntry.index`): false if the file provably holds nothing
   * the ranges read and need not be fetched. Sound by `engine/query` `files_needed`.
   */
  filesNeeded(indexes: string[], ranges: FetchRange[]): boolean[]
  /**
   * For each index fragment: an upper bound on the rows the ranges decode from the file
   * (each row group once per range that may read it). 0 means skip the file; `null` that
   * the fragment does not parse, so the bound is unknown and the file must be read.
   */
  scanRows(indexes: string[], ranges: FetchRange[]): (number | null)[]
  /**
   * For each index fragment: how to read the file for `ranges` by name and time alone
   * (`engine/query` `file_plan`). For either table.
   */
  filePlan(indexes: string[], ranges: FetchRange[], gap?: number): FilePlan[]
  /**
   * Series-level pruning (`engine/query` `sample_plan`): resolve each read's matchers
   * against `seriesFiles` (whole or sparse), keep `part`'s series if given, and say how to
   * read each sample file (`indexes`: their fragments) so that only the footer and the row
   * groups holding a selected series are fetched. `series`: what the reads select.
   */
  samplePlan(seriesFiles: Uint8Array[], indexes: string[], reads: FetchRange[], part?: { without: string[]; part: number; parts: number }, gap?: number): ReadPlan
  /**
   * One split part's reads from the fragments alone (`engine/query` `part_plan`): the row
   * groups whose key range holds its `series_id` range. Enough for every series of the part
   * that carries none of the key's `without` labels; `samplePlan` with the part says what
   * the rest need.
   */
  partPlan(indexes: string[], ranges: FetchRange[], part: number, parts: number, gap?: number): FilePlan[]
  /** How a query is executed: split over leaves, or in one place and why. */
  splitPlan(promql: string, limits?: QueryLimits): SplitPlan
  /** Reader: the rows of `part` of `parts` in the sample files (precedence order) for `ranges`. */
  extract(seriesFiles: Uint8Array[], sampleFiles: Uint8Array[], without: string[], part: number, parts: number, ranges: FetchRange[]): Extract
  /** Coordinator: the tail batches cut by part, each part's in the input order. */
  splitTails(batches: Uint8Array[], without: string[], parts: number, ranges: FetchRange[]): Uint8Array[][]
  /** Leaf: start gathering a split's data. Returns a session handle kept in this instance. */
  gatherNew(ranges: FetchRange[], budget: LeafBudget): number
  /** Leaf: add an extract or a tail batch with its precedence (higher wins on equal timestamps). */
  gatherAdd(handle: number, rank: number, batch: Uint8Array): { aborted: boolean; samples: number; series: number }
  /** Leaf: evaluate the split's fragments; frees the session. The answer goes to the coordinator as bytes. */
  gatherEval(handle: number, promql: string, grid: Grid, fragments: number, limits?: QueryLimits): Uint8Array
  /** Leaf: drop a session that will not be evaluated. */
  gatherFree(handle: number): void
  /** Coordinator: merge the leaves' answers and finish the query; the result as the engine wrote it. */
  mergeJson(answers: Uint8Array[], promql: string, grid: Grid, limits?: QueryLimits): { json: string; stats: QueryStats }
  /** Cardinality: one part's summary of `metric_series` files and tail batches over `[startMs, endMs]`. */
  cardinalityPart(seriesFiles: Uint8Array[], tailBatches: Uint8Array[], startMs: number, endMs: number, part: number, parts: number, caps: CardinalityCaps): Uint8Array
  /** Cardinality: merge the parts and render `/api/v1/status/tsdb` and `/api/v1/status/cardinality` (`data` objects, JSON text). */
  cardinalityReport(summaries: Uint8Array[], limit: number, startMs: number, endMs: number, lookbackStartMs: number, caps: CardinalityCaps): { tsdb: string; cardinality: string }
  /** Size of the instance's linear memory now, which is also its peak: it only grows. */
  memoryBytes(): number
  /** How many times a WASM instance has been created (1, plus one per trap or reset). */
  instances(): number
  /** Drop the instance so its memory can be reclaimed; the next call creates a new one. */
  reset(): void
}

interface Exports {
  memory: WebAssembly.Memory
  viz_q_abi_version(): number
  viz_alloc(len: number): number
  viz_free(ptr: number, len: number): void
}
type Op =
  | 'viz_q_plan'
  | 'viz_q_selectors'
  | 'viz_q_query_range'
  | 'viz_q_query_instant'
  | 'viz_q_select'
  | 'viz_q_parse_selectors'
  | 'viz_q_label_names'
  | 'viz_q_label_values'
  | 'viz_q_series'
  | 'viz_q_scan_rows'
  | 'viz_q_split_plan'
  | 'viz_q_extract'
  | 'viz_q_split_tails'
  | 'viz_q_gather_new'
  | 'viz_q_gather_add'
  | 'viz_q_gather_eval'
  | 'viz_q_gather_free'
  | 'viz_q_merge'
  | 'viz_q_card_part'
  | 'viz_q_card_report'
  | 'viz_q_file_plan'
  | 'viz_q_sample_plan'
  | 'viz_q_part_plan'
type Module = Exports & Record<Op, (ptr: number, len: number) => number>

const OPS: Record<Matcher['op'], number> = { '=': 0, '!=': 1, '=~': 2, '!~': 3 }
const ERROR_TYPES: Record<number, ErrorType> = { 1: 'bad_data', 2: 'execution', 3: 'unsupported', 4: 'internal' }
const I64_MIN = -(2n ** 63n)
const I64_MAX = 2n ** 63n - 1n
const U64_MAX = 2n ** 64n - 1n
const utf8 = new TextEncoder()
const text = new TextDecoder('utf-8', { fatal: true })

function time(name: string, v: number): bigint {
  if (v === Infinity) return I64_MAX
  if (v === -Infinity) return I64_MIN
  if (typeof v !== 'number' || !Number.isInteger(v)) throw new RangeError(`engine: ${name} must be an integer number of milliseconds, got ${v}`)
  return BigInt(v)
}

function limit(name: string, v: number): bigint {
  if (v === Infinity) return U64_MAX
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw new RangeError(`engine: limit ${name} must be a non-negative integer, got ${v}`)
  return BigInt(v)
}

/** A request under construction: parts are sized first, then written once into WASM memory. */
class Request {
  private readonly parts: ((mem: Uint8Array, dv: DataView, at: number) => void)[] = []
  size = 0
  private push(n: number, write: (mem: Uint8Array, dv: DataView, at: number) => void): this {
    const at = this.size
    this.parts.push((mem, dv, base) => write(mem, dv, base + at))
    this.size += n
    return this
  }
  u8(v: number): this {
    return this.push(1, (mem, _dv, at) => {
      mem[at] = v
    })
  }
  u32(v: number): this {
    return this.push(4, (_m, dv, at) => dv.setUint32(at, v, true))
  }
  i64(v: bigint): this {
    return this.push(8, (_m, dv, at) => dv.setBigInt64(at, v, true))
  }
  u64(v: bigint): this {
    return this.push(8, (_m, dv, at) => dv.setBigUint64(at, v, true))
  }
  bytes(b: Uint8Array): this {
    this.u32(b.byteLength)
    return this.push(b.byteLength, (mem, _dv, at) => mem.set(b, at))
  }
  str(s: string): this {
    return this.bytes(utf8.encode(s))
  }
  strs(list: string[]): this {
    this.u32(list.length)
    for (const s of list) this.str(s)
    return this
  }
  limits(l: QueryLimits): this {
    this.u64(limit('maxSamples', l.maxSamples)).u64(limit('maxSeries', l.maxSeries)).u64(limit('maxOutputPoints', l.maxOutputPoints))
    this.u64(limit('maxStepPoints', l.maxStepPoints)).u64(limit('maxQueryBytes', l.maxQueryBytes)).u64(limit('maxDepth', l.maxDepth))
    return this.u64(limit('maxSteps', l.maxSteps))
  }
  scan(input: ScanInput): this {
    this.u32(input.seriesFiles.length).u32(input.sampleFiles.length).u32(input.tailBatches.length)
    for (const list of [input.seriesFiles, input.sampleFiles, input.tailBatches]) for (const b of list) this.bytes(b)
    return this
  }
  ranges(rs: FetchRange[]): this {
    this.u32(rs.length)
    for (const r of rs) this.i64(time('minTs', r.minTs)).i64(time('maxTs', r.maxTs)).matchers(r.matchers)
    return this
  }
  files(list: Uint8Array[]): this {
    this.u32(list.length)
    for (const b of list) this.bytes(b)
    return this
  }
  count(name: string, v: number): this {
    if (!Number.isInteger(v) || v < 0 || v > 0xffff_ffff) throw new RangeError(`engine: ${name} must be a 32-bit count, got ${v}`)
    return this.u32(v)
  }
  grid(g: Grid): this {
    if ('time' in g) return this.u8(1).i64(time('timeMs', g.time)).i64(time('timeMs', g.time)).i64(1n)
    return this.u8(0).i64(time('startMs', g.start)).i64(time('endMs', g.end)).i64(time('stepMs', g.step))
  }
  matchers(ms: Matcher[]): this {
    this.u32(ms.length)
    for (const m of ms) {
      const op = OPS[m.op]
      if (op === undefined) throw new RangeError(`engine: unknown matcher operator ${String(m.op)}`)
      this.u8(op).str(m.name).str(m.value)
    }
    return this
  }
  write(mem: Uint8Array, at: number): void {
    const dv = new DataView(mem.buffer)
    for (const p of this.parts) p(mem, dv, at)
  }
}

/**
 * Create a query engine from the compiled module (`import wasm from './viz_query.wasm'`
 * in a Worker). Instantiation is synchronous and lazy, with an EMPTY import object.
 */
export function createQueryEngine(module: WebAssembly.Module): QueryEngine {
  let x: Module | null = null
  let created = 0

  const instance = (): Module => {
    if (x) return x
    let made: Module
    let abi: number
    try {
      made = new WebAssembly.Instance(module, {}).exports as unknown as Module
      abi = made.viz_q_abi_version()
    } catch (e) {
      throw new EngineLoadError(e instanceof Error ? e.message : String(e))
    }
    if (abi !== ABI_VERSION) throw new EngineLoadError(`module ABI ${abi}, binding expects ${ABI_VERSION}`)
    created++
    x = made
    return made
  }

  /** Run one operation. Views over WASM memory are taken after every call that can grow it, never kept. */
  function call<T>(op: Op, req: Request, read: (payload: Uint8Array) => T): T {
    if (req.size > 0xffff_ffff) throw new RangeError('engine: request larger than 4 GiB')
    const w = instance()
    let at = 0
    let res = 0
    let total = 0
    let own = false
    try {
      at = w.viz_alloc(req.size)
      req.write(new Uint8Array(w.memory.buffer), at)
      res = w[op](at, req.size)
      w.viz_free(at, req.size)
      at = 0
      const head = new DataView(w.memory.buffer, res, 8)
      total = head.getUint32(0, true)
      const status = head.getUint32(4, true)
      const payload = new Uint8Array(w.memory.buffer, res + 8, total - 8)
      if (status !== 0) {
        const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
        const n = dv.getUint32(0, true)
        const name = new TextDecoder().decode(payload.subarray(4, 4 + n))
        // u64 as BigInt, then to Number: informational, and limits are far below 2^53 in practice.
        const max = Number(dv.getBigUint64(4 + n, true))
        const reached = Number(dv.getBigUint64(12 + n, true))
        const message = new TextDecoder().decode(payload.subarray(20 + n))
        own = true
        const type = ERROR_TYPES[status]
        if (!type) throw new QueryError('internal', `engine: malformed request (binding bug): ${message}`)
        throw new QueryError(type, message, n > 0 ? { name, max, reached } : undefined)
      }
      return read(payload)
    } catch (e) {
      // Anything that is not the engine's own error means the instance may be corrupt
      // (a trap, out of memory): never reuse it.
      if (!own) x = null
      throw e
    } finally {
      if (x === w) {
        if (at !== 0) w.viz_free(at, req.size)
        if (res !== 0) w.viz_free(res, total)
      }
    }
  }

  const json = <T>(payload: Uint8Array): T => JSON.parse(text.decode(payload)) as T

  const withStats = (payload: Uint8Array): { json: string; stats: QueryStats } => {
    const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
    const n = (i: number): number => Number(dv.getBigUint64(8 * i, true))
    return { stats: { selects: n(0), series: n(1), samples: n(2), outputPoints: n(3) }, json: text.decode(payload.subarray(32)) }
  }

  const planReq = (promql: string, startMs: number, endMs: number, stepMs: number, limits: QueryLimits): Request =>
    new Request().limits(limits).i64(time('startMs', startMs)).i64(time('endMs', endMs)).i64(time('stepMs', stepMs)).str(promql)

  function queryRangeJson(input: ScanInput, promql: string, startMs: number, endMs: number, stepMs: number, limits = DEFAULT_LIMITS) {
    return call('viz_q_query_range', planReq(promql, startMs, endMs, stepMs, limits).scan(input), withStats)
  }

  function queryInstantJson(input: ScanInput, promql: string, timeMs: number, limits = DEFAULT_LIMITS) {
    return call('viz_q_query_instant', new Request().limits(limits).i64(time('timeMs', timeMs)).str(promql).scan(input), withStats)
  }

  function select(input: ScanInput, matchers: Matcher[], minTs: number, maxTs: number): SeriesData[] {
    const req = new Request().i64(time('minTs', minTs)).i64(time('maxTs', maxTs)).matchers(matchers).scan(input)
    return call('viz_q_select', req, (payload) => {
      const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
      let p = 0
      const str = (): string => {
        const n = dv.getUint32(p, true)
        p += 4 + n
        return text.decode(payload.subarray(p - n, p))
      }
      const n = dv.getUint32(p, true)
      p += 4
      const out: SeriesData[] = new Array(n)
      for (let i = 0; i < n; i++) {
        const nLabels = dv.getUint32(p, true)
        p += 4
        const labels: Record<string, string> = {}
        for (let l = 0; l < nLabels; l++) {
          const name = str()
          // defineProperty, so a label called `__proto__` is an ordinary own property.
          Object.defineProperty(labels, name, { value: str(), enumerable: true, writable: true, configurable: true })
        }
        const rows = dv.getUint32(p, true)
        p = (p + 4 + 7) & ~7
        // Raw byte copies into the arrays' buffers: no f64 is read and written back.
        const ts = new Float64Array(rows)
        new Uint8Array(ts.buffer).set(payload.subarray(p, p + 8 * rows))
        p += 8 * rows
        const values = new Float64Array(rows)
        new Uint8Array(values.buffer).set(payload.subarray(p, p + 8 * rows))
        p += 8 * rows
        out[i] = { labels, ts, values }
      }
      return out
    })
  }

  const metaReq = (limits: QueryLimits, minTs: number, maxTs: number): Request => new Request().limits(limits).i64(time('minTs', minTs)).i64(time('maxTs', maxTs))

  function scanRows(indexes: string[], ranges: FetchRange[]): (number | null)[] {
    const req = new Request().strs(indexes).u32(ranges.length)
    for (const r of ranges) req.i64(time('minTs', r.minTs)).i64(time('maxTs', r.maxTs)).matchers(r.matchers)
    return call('viz_q_scan_rows', req, (payload) => {
      const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
      return indexes.map((_, i) => {
        const rows = dv.getBigUint64(8 * i, true)
        // A count, far below 2^53 unless it saturated; saturation is reported as Infinity.
        return rows === U64_MAX ? null : rows > BigInt(Number.MAX_SAFE_INTEGER) ? Infinity : Number(rows)
      })
    })
  }

  const u64At = (dv: DataView, at: number): number => Number(dv.getBigUint64(at, true))

  function splitTails(batches: Uint8Array[], without: string[], parts: number, ranges: FetchRange[]): Uint8Array[][] {
    const req = new Request().strs(without).count('parts', parts).ranges(ranges).files(batches)
    return call('viz_q_split_tails', req, (payload) => {
      const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
      const out: Uint8Array[][] = []
      let p = 0
      for (let j = 0; j < parts; j++) {
        const n = dv.getUint32(p, true)
        p += 4
        const list: Uint8Array[] = []
        for (let i = 0; i < n; i++) {
          const len = dv.getUint32(p, true)
          list.push(payload.slice(p + 4, p + 4 + len))
          p += 4 + len
        }
        out.push(list)
      }
      return out
    })
  }

  return {
    splitPlan: (promql, limits = DEFAULT_LIMITS) => call('viz_q_split_plan', new Request().limits(limits).str(promql), json<SplitPlan>),
    extract: (seriesFiles, sampleFiles, without, part, parts, ranges) => {
      const req = new Request().strs(without).count('part', part).count('parts', parts).ranges(ranges).files(seriesFiles).files(sampleFiles)
      return call('viz_q_extract', req, (payload) => {
        const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
        return { rows: u64At(dv, 0), series: u64At(dv, 8), batch: payload.slice(16) }
      })
    },
    splitTails,
    gatherNew: (ranges, budget) => {
      const req = new Request().u64(limit('samples', budget.samples)).u64(limit('series', budget.series)).u64(limit('stepPoints', budget.stepPoints)).ranges(ranges)
      return call('viz_q_gather_new', req, (payload) => new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(0, true))
    },
    gatherAdd: (handle, rank, batch) =>
      call('viz_q_gather_add', new Request().count('handle', handle).count('rank', rank).bytes(batch), (payload) => {
        const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
        return { aborted: payload[0] === 1, samples: u64At(dv, 1), series: u64At(dv, 9) }
      }),
    gatherEval: (handle, promql, grid, fragments, limits = DEFAULT_LIMITS) =>
      call('viz_q_gather_eval', new Request().count('handle', handle).limits(limits).grid(grid).count('fragments', fragments).str(promql), (payload) => payload.slice()),
    gatherFree: (handle) => {
      // Only if the instance is alive: a dropped instance has dropped its sessions.
      if (x) call('viz_q_gather_free', new Request().count('handle', handle), () => undefined)
    },
    mergeJson: (answers, promql, grid, limits = DEFAULT_LIMITS) => call('viz_q_merge', new Request().limits(limits).grid(grid).str(promql).files(answers), withStats),
    cardinalityPart: (seriesFiles, tailBatches, startMs, endMs, part, parts, caps) => {
      const req = new Request().i64(time('startMs', startMs)).i64(time('endMs', endMs)).count('part', part).count('parts', parts)
      req.u64(limit('maxSeries', caps.maxSeries)).u64(limit('maxPairs', caps.maxPairs)).files(seriesFiles).files(tailBatches)
      return call('viz_q_card_part', req, (payload) => payload.slice())
    },
    cardinalityReport: (summaries, n, startMs, endMs, lookbackStartMs, caps) => {
      const req = new Request().u64(limit('maxSeries', caps.maxSeries)).u64(limit('maxPairs', caps.maxPairs)).count('limit', n)
      req.i64(time('startMs', startMs)).i64(time('endMs', endMs)).i64(time('lookbackStartMs', lookbackStartMs)).files(summaries)
      return call('viz_q_card_report', req, (payload) => {
        const len = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(0, true)
        return { tsdb: text.decode(payload.subarray(4, 4 + len)), cardinality: text.decode(payload.subarray(4 + len)) }
      })
    },
    plan: (promql, startMs, endMs, stepMs, limits = DEFAULT_LIMITS) => call('viz_q_plan', planReq(promql, startMs, endMs, stepMs, limits), json<FetchRange[]>),
    selectors: (promql, startMs, endMs, stepMs, limits = DEFAULT_LIMITS) => call('viz_q_selectors', planReq(promql, startMs, endMs, stepMs, limits), json<FetchRange[]>),
    queryRangeJson,
    queryRange: (input, promql, startMs, endMs, stepMs, limits) => JSON.parse(queryRangeJson(input, promql, startMs, endMs, stepMs, limits).json) as PromMatrix,
    queryInstantJson,
    queryInstant: (input, promql, timeMs, limits) => JSON.parse(queryInstantJson(input, promql, timeMs, limits).json) as InstantData,
    select,
    parseSelectors: (selectors) => call('viz_q_parse_selectors', new Request().strs(selectors), json<Matcher[][]>),
    labelNames: (input, match, minTs, maxTs, limits = DEFAULT_LIMITS) => call('viz_q_label_names', metaReq(limits, minTs, maxTs).strs(match).scan(input), json<string[]>),
    labelValues: (input, name, match, minTs, maxTs, limits = DEFAULT_LIMITS) => call('viz_q_label_values', metaReq(limits, minTs, maxTs).str(name).strs(match).scan(input), json<string[]>),
    series: (input, match, minTs, maxTs, limits = DEFAULT_LIMITS) => call('viz_q_series', metaReq(limits, minTs, maxTs).strs(match).scan(input), json<Record<string, string>[]>),
    filesNeeded: (indexes, ranges) => scanRows(indexes, ranges).map((rows) => rows !== 0),
    scanRows,
    filePlan: (indexes, ranges, gap = RANGE_GAP) => call('viz_q_file_plan', new Request().u64(limit('gap', gap)).ranges(ranges).strs(indexes), json<FilePlan[]>),
    samplePlan: (seriesFiles, indexes, reads, part, gap = RANGE_GAP) => {
      const req = new Request().u64(limit('gap', gap))
      if (part) req.u8(1).strs(part.without).count('part', part.part).count('parts', part.parts)
      else req.u8(0)
      return call('viz_q_sample_plan', req.ranges(reads).files(seriesFiles).strs(indexes), (payload) => {
        const n = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(0, true)
        const plan = JSON.parse(text.decode(payload.subarray(4, 4 + n))) as Omit<ReadPlan, 'carrier'>
        return { ...plan, carrier: payload.byteLength > 4 + n ? payload.slice(4 + n) : null }
      })
    },
    partPlan: (indexes, ranges, part, parts, gap = RANGE_GAP) =>
      call('viz_q_part_plan', new Request().u64(limit('gap', gap)).count('part', part).count('parts', parts).ranges(ranges).strs(indexes), json<FilePlan[]>),
    memoryBytes: () => (x ? x.memory.buffer.byteLength : 0),
    instances: () => created,
    reset: () => {
      x = null
    },
  }
}
