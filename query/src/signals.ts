/**
 * Traces and logs: Tempo's and Loki's HTTP APIs over a tenant's `spans`, `trace_index` and
 * `logs` files and the tails of its `{pool}/traces` and `{pool}/logs` shards
 * (contracts/TRACES.md, contracts/LOGS.md, D57). The same seam as for metrics (design §2): the
 * ledger is read first, at one version for every table a query needs; files are pruned by
 * their index fragments and read through the leaf pool, at most six reads per leaf call;
 * shards are asked for their tail strictly after the plan and above its watermarks, and a
 * refusal sends the query back to the ledger (`readTails`). The engine (`SignalEngine` of
 * `contracts/engine.ts`) evaluates in one place, under the tenant's byte, file and row caps
 * and the bytes the engine may hold decoded (`maxDecodedBytes`); a query that does not fit one
 * place is refused (422), never cut short (README, "Traces and logs": split execution is not
 * built for them).
 *
 *   logs     plan(logs, hull of the selectors) → file plans by stream list and time → files ‖ tail → engine
 *   search   plan(trace_index, window ± traceMarginMs) → fragments ‖ tail → the traces
 *            overlapping the window, their hull and hours, cut to the margin → plan(spans, hull)
 *            at the same version → files → engine (spans outside the margin dropped)
 *   by ID    plan(trace_index, hint ± margin, or all time) → the row groups whose trace id range
 *            holds the id ‖ tail → the trace's hull and hours → plan(spans, hull), files of
 *            those hours only → engine
 *   metrics  span-local plans read the spans that start in the window; others as search
 *   tags     plan(spans, window) → files ‖ tail → engine
 *
 * The tenant is `c.tenant` (from the API key) and nothing else: every ledger, shard and file
 * read below is addressed by it.
 */
import type { FileEntry, LiveFile, Plan, Watermark } from '../../contracts/ledger'
import type { SignalFilePlan } from '../../contracts/engine'
import { ApiError, type Context, MAX_REFUSALS, MAX_VERSION_RETRIES, MissingFile, type Planned, checkDeadline, fetchFiles, hooks, inPrecedenceOrder, plannedBytes, readTails, reserveBytes, tooMuch } from './coordinator'
import { signalByte, signalShards } from './shards'
import type { SignalBudget } from '../../engine/wasm-query/js/index'
import { MAX_NS, NS_PER_MS, msRange } from './sigparams'

/** The span and log tables (contracts/TRACES.md, LOGS.md), by the names the ledger stores files under. */
export type SignalTable = 'spans' | 'trace_index' | 'logs'

/**
 * The ledger's `plan` for a span or log table (contracts/ledger.ts `Table` names them since
 * 2026-11-19). A ledger that does not list them yet throws `ledger: unknown table`: the query
 * is then answered 503 with that reason (README, "Needed changes elsewhere").
 */
async function planTable(c: Context, table: SignalTable, minTs: number, maxTs: number): Promise<Plan> {
  const ledger = c.env.LEDGER.get(c.env.LEDGER.idFromName(c.tenant))
  c.cost.planAttempts++
  try {
    return await ledger.plan({ table, minTs, maxTs })
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e)
    if (m.includes('unknown table')) throw new ApiError('unavailable', `the ledger does not list ${table} files yet (it knows the metric tables only); traces and logs need stage 2 of the write side`)
    throw e
  }
}

interface Round {
  /** The files of the round, in precedence order, with how each is read. */
  files: { f: LiveFile; plan: SignalFilePlan }[]
  bytes: number
  rows: number
  listed: number
}

/** Files of a plan to read: those the fragments do not skip (all of them, whole, with pruning off). */
function round(files: LiveFile[], plans: SignalFilePlan[] | null): Round {
  const ordered = inPrecedenceOrder(files)
  const out: Round = { files: [], bytes: 0, rows: 0, listed: files.length }
  for (const f of ordered) {
    const plan = plans ? plans[files.indexOf(f)]! : ({ rows: null, read: 'whole' } as SignalFilePlan)
    if (plan.read === 'skip') continue
    out.files.push({ f, plan })
    out.bytes += plannedBytes(planned(f, plan))
    out.rows += plan.rows ?? f.rows
  }
  return out
}

const planned = (f: FileEntry, p: SignalFilePlan): Planned => ({ f, read: p.read === 'skip' || p.read === 'whole' ? 'whole' : p.read })

/** Whether the index fragments prune (a test turns it off to show that the answers do not change). */
const pruning = (): boolean => hooks.signalPruning !== false

/**
 * The refusals before anything is fetched: files and bytes of every round so far from the
 * ledger, and rows from the fragments. `rowRounds` are the rounds whose rows count against
 * `rowsLimit` together (a trace query's `trace_index` round and its `spans` round are checked
 * each on its own: a fragment is not a span).
 */
function capsBeforeFetch(c: Context, rounds: Round[], rowsLimit: number, rowsName: 'max_spans' | 'max_log_rows', rowRounds: Round[] = rounds): void {
  const files = rounds.reduce((a, r) => a + r.files.length, 0)
  const bytes = rounds.reduce((a, r) => a + r.bytes, 0)
  const rows = rowRounds.reduce((a, r) => a + r.rows, 0)
  c.cost.filesListed = rounds.reduce((a, r) => a + r.listed, 0)
  c.cost.filesSkipped = c.cost.filesListed - files
  c.cost.scanRows = rounds.reduce((a, r) => a + r.rows, 0)
  if (files > c.limits.maxFiles) throw new ApiError('execution', `query exceeded limit max_files: ${files} data files to read, the limit is ${c.limits.maxFiles}. Narrow the time range.`)
  if (bytes > c.limits.maxFetchBytes) throw tooMuch(c, 'the data files in range', bytes)
  if (rows > rowsLimit) {
    throw new ApiError('execution', `query exceeded limit ${rowsName}: the data files in range hold ${rows} rows the query would decode, the limit is ${rowsLimit}. Narrow the time range, or select fewer streams.`)
  }
}

/** What an engine call may hold (`maxDecodedBytes`, README "Memory"), and for traces the spans that are its data. */
const budget = (c: Context, bound?: { lo: bigint; hi: bigint }): SignalBudget => (bound ? { maxBytes: c.limits.maxDecodedBytes, bound } : { maxBytes: c.limits.maxDecodedBytes })

/** A query's re-plan bookkeeping, as for metrics: each shard or missing file may send it back to the ledger `MAX_REFUSALS` times. */
function refusals(): { refused: (who: string, why: string) => void; known: Map<string, number> } {
  const counts = new Map<string, number>()
  return {
    known: new Map(),
    refused: (who, why) => {
      const n = (counts.get(who) ?? 0) + 1
      counts.set(who, n)
      if (n > MAX_REFUSALS) throw new ApiError('unavailable', `${why}, and the ledger does not catch up; retry later`)
    },
  }
}

/** Fetch these files; a missing one is a refusal (the plan is older than a deletion). */
async function fetchRound(c: Context, r: Round, have: Map<string, Uint8Array>, refused: (who: string, why: string) => void): Promise<Uint8Array[] | null> {
  try {
    const got = await fetchFiles(
      c,
      r.files.map(({ f, plan }) => planned(f, plan)),
      have,
    )
    c.cost.filesRead += r.files.length
    c.cost.bytesRead += r.bytes
    return got
  } catch (e) {
    if (!(e instanceof MissingFile)) throw e
    refused(`file ${e.key}`, e.message)
    return null
  }
}

/**
 * The tails of a signal's shards above the plan's watermarks, under what the files leave of
 * `maxFetchBytes`; null: refused, read the ledger again. `bound` is the nanosecond range the
 * caller selects rows in (inclusive): the shard skips span and log batches whose time bounds,
 * recorded at append, lie outside it (D72; contracts/BATCH.md "Tail reads of spans and log
 * records by time"), and returns every other batch whole. A shard of an earlier release
 * ignores the range for these batches and returns them all, as before.
 */
async function readSignalTail(
  c: Context,
  signal: 'traces' | 'logs',
  watermarks: Watermark[],
  lakeBytes: number,
  rf: ReturnType<typeof refusals>,
  bound: { lo: bigint; hi: bigint },
): Promise<Uint8Array[] | null> {
  const shards = await signalShards(c.env, c.tenant, signal, watermarks)
  c.cost.shardsAsked = shards.length
  // The signal (`readTails` adds it) and the bound's milliseconds, each end floored: every batch
  // holding a row inside the bound is returned (D72). Series fields stay unsent: they select
  // metric rows only (shard/src/tail.ts). Paged under ONE budget over the signal's shards, each
  // page checked against the query's deadline (`readShared`, review of D54 M-2 and m-7).
  const t = await readTails(c, shards, watermarks, rf.known, rf.refused, msRange(bound.lo, bound.hi), c.limits.maxFetchBytes - lakeBytes, signalByte(signal))
  if (t.again) return null
  if (t.over) throw tooMuch(c, 'the data files in range plus the unflushed tail', lakeBytes + t.atLeast, !t.exact)
  return t.reads.flatMap((r) => r.batches.map((b) => b.payload))
}

/** Time the engine call and record what it held. */
function timed<T>(c: Context, f: () => T): T {
  const t0 = performance.now()
  try {
    return f()
  } finally {
    c.cost.engineMs += Math.round(performance.now() - t0)
    c.cost.wasmMemoryBytes = c.engine.memoryBytes()
  }
}

/** An engine call: timed, its memory recorded. Its errors are typed (`QueryError`: a limit is a 422 naming it). */
const engineCall = timed

// ───────────────────────────────── logs ─────────────────────────────────

export interface LogQuery {
  query: string
  kind: 'range' | 'instant'
  startNs: bigint
  endNs: bigint
  stepNs: bigint
  limit: number
  direction: 'forward' | 'backward'
}

/** Loki's `query_range` / `query`: the `data` object as the engine wrote it. */
export async function logQuery(c: Context, q: LogQuery): Promise<string> {
  const plan = c.engine.lqPlan(q.kind, q.query, q.startNs, q.endNs, q.stepNs)
  if (plan.selectors.length === 0) return engineCall(c, () => c.engine.lqQuery([], [], q.query, { ...q, maxRows: c.limits.maxLogRows, maxSeries: c.limits.maxSeries, maxSteps: c.limits.maxSteps }, budget(c)).json)
  // The hull of the selectors' half-open ranges.
  const lo = plan.selectors.reduce((a, s) => (BigInt(s.start) < a ? BigInt(s.start) : a), BigInt(plan.selectors[0]!.start))
  const hi = plan.selectors.reduce((a, s) => (BigInt(s.end) > a ? BigInt(s.end) : a), BigInt(plan.selectors[0]!.end)) - 1n
  const { minTs, maxTs } = msRange(lo, hi)
  const rf = refusals()
  const have = new Map<string, Uint8Array>()
  for (let attempt = 1; ; attempt++) {
    checkDeadline(c)
    const p = await planTable(c, 'logs', minTs, maxTs)
    c.cost.ledgerVersion = p.version
    if (hooks.afterPlan) await hooks.afterPlan(c.tenant, attempt)
    const r = round(p.files, pruning() ? c.engine.lqFilePlan(p.files.map((f) => f.index), plan.selectors) : null)
    c.cost.pruning = pruning() ? 'fragments' : 'off'
    capsBeforeFetch(c, [r], c.limits.maxLogRows, 'max_log_rows')
    const release = reserveBytes(r.bytes)
    try {
      const [files, tails] = await Promise.all([fetchRound(c, r, have, rf.refused), readSignalTail(c, 'logs', p.watermarks, r.bytes, rf, { lo, hi })])
      if (!files || !tails) continue
      checkDeadline(c)
      const out = engineCall(c, () =>
        c.engine.lqQuery(files, tails, q.query, { ...q, maxRows: c.limits.maxLogRows, maxSeries: c.limits.maxSeries, maxSteps: c.limits.maxSteps }, budget(c)),
      )
      c.cost.rowsDecoded = out.rows
      return out.json
    } finally {
      release()
    }
  }
}

/** Loki's `/labels`, `/label/<name>/values` and `/series`: the `data` array as JSON text. */
export async function logLabels(c: Context, kind: 'names' | 'values' | 'series', name: string, selectors: string[], startNs: bigint, endNs: bigint): Promise<string> {
  const { minTs, maxTs } = msRange(startNs, endNs)
  const rf = refusals()
  const have = new Map<string, Uint8Array>()
  for (let attempt = 1; ; attempt++) {
    checkDeadline(c)
    const p = await planTable(c, 'logs', minTs, maxTs)
    c.cost.ledgerVersion = p.version
    // A file whose fragment lists its streams is answered from the fragment (no read); the
    // others are read by time, `labels` and `ts` only.
    const listing = (f: LiveFile) => pruning() && f.index.includes('"streams":')
    const fromFragments = p.files.filter(listing)
    const toRead = p.files.filter((f) => !listing(f))
    const plans = pruning() ? c.engine.lqFilePlan(toRead.map((f) => f.index), [{ matchers: [], start: String(startNs), end: String(endNs + 1n) }]) : null
    const r = round(toRead, plans)
    r.listed = p.files.length
    c.cost.pruning = pruning() ? 'fragments' : 'off'
    capsBeforeFetch(c, [r], c.limits.maxLogRows, 'max_log_rows')
    const [files, tails] = await Promise.all([fetchRound(c, r, have, rf.refused), readSignalTail(c, 'logs', p.watermarks, r.bytes, rf, { lo: startNs, hi: endNs })])
    if (!files || !tails) continue
    return engineCall(c, () => c.engine.lqLabels(kind, name, selectors, startNs, endNs, inPrecedenceOrder(fromFragments).map((f) => f.index), files, tails))
  }
}

// ───────────────────────────────── traces ─────────────────────────────────

/**
 * The span starts a trace query's data is cut to (D62): its window widened by the tenant's
 * `traceMarginMs` on both sides, within what storage holds. A span of a found trace that starts
 * inside it is read; one that starts outside it is not part of the answer, with pruning on or
 * off alike (the engine drops it before de-duplication).
 */
export function traceBound(c: Context, window: { lo: bigint; hi: bigint }): { lo: bigint; hi: bigint } {
  const margin = BigInt(c.limits.traceMarginMs) * NS_PER_MS
  const lo = window.lo - margin
  const hi = window.hi + margin
  return { lo: lo < 0n ? 0n : lo, hi: hi > MAX_NS ? MAX_NS : hi }
}

/**
 * One ledger version of `trace_index` and `spans` for a search, a metrics query that needs
 * whole traces, or a trace by ID (D62):
 *
 *   1. `plan(trace_index, bound)`, where `bound` is the window widened by `traceMarginMs`; the
 *      row groups whose fragments overlap the bound (and, by ID, whose trace-id range holds
 *      the id); with the tail, the engine finds the traces whose extent, merged over every
 *      fragment and tail span inside the bound, overlaps the window, and the hull of those
 *      extents cut to the bound (`tqExtent`);
 *   2. `plan(spans, hull)` at the same version (else start again); the span row groups whose
 *      starts overlap the hull (by ID, only the hours the fragments name);
 *   3. the engine call, with the bound: every span of a found trace that starts inside the bound
 *      has been read, and the engine drops every span that starts outside it.
 *
 * With pruning off, both tables are read whole over the bound: the same answer.
 */
async function traceRounds<T>(
  c: Context,
  window: { lo: bigint; hi: bigint },
  bound: { lo: bigint; hi: bigint },
  id: Uint8Array | undefined,
  finish: (spanFiles: Uint8Array[], tails: Uint8Array[], bound: { lo: bigint; hi: bigint }) => T,
  empty: () => T,
): Promise<T> {
  const rf = refusals()
  const have = new Map<string, Uint8Array>()
  for (let attempt = 1; attempt <= MAX_VERSION_RETRIES * (MAX_REFUSALS + 1); attempt++) {
    checkDeadline(c)
    const b = msRange(bound.lo, bound.hi)
    const first = await planTable(c, 'trace_index', b.minTs, b.maxTs)
    c.cost.ledgerVersion = first.version
    if (hooks.afterPlan) await hooks.afterPlan(c.tenant, attempt)
    const r1 = round(first.files, pruning() ? c.engine.tqFilePlan('trace_index', first.files.map((f) => f.index), bound.lo, bound.hi, id) : null)
    // Files and bytes only: a fragment is not a span. The engine holds one extent per trace
    // under the byte budget (`tqExtent`).
    capsBeforeFetch(c, [r1], c.limits.maxSpans, 'max_spans', [])
    const [indexFiles, tails] = await Promise.all([fetchRound(c, r1, have, rf.refused), readSignalTail(c, 'traces', first.watermarks, r1.bytes, rf, bound)])
    if (!indexFiles || !tails) continue
    const ext = engineCall(c, () => c.engine.tqExtent(indexFiles, tails, window.lo, window.hi, id, budget(c, bound)))
    if (ext.traces === 0 || ext.lo === undefined || ext.hi === undefined) return empty()
    // Every span of every trace found that starts inside the bound starts inside its hull.
    const hull = pruning() ? { lo: BigInt(ext.lo), hi: BigInt(ext.hi) } : bound
    const h = msRange(hull.lo, hull.hi)
    const second = await planTable(c, 'spans', h.minTs, h.maxTs)
    if (second.version !== first.version || second.ledgerIncarnation !== first.ledgerIncarnation) continue
    // By ID: only the hours the trace's fragments (and its tail spans) name hold its spans.
    const hours = new Set(ext.hours)
    const candidates = id && pruning() ? second.files.filter((f) => { const x = hourOf(f); return x === null || hours.has(x) }) : second.files
    const r2 = round(candidates, pruning() ? c.engine.tqFilePlan('spans', candidates.map((f) => f.index), hull.lo, hull.hi) : null)
    r2.listed = second.files.length
    const tailBytes = tails.reduce((a, b) => a + b.byteLength, 0)
    capsBeforeFetch(c, [r1, r2], c.limits.maxSpans, 'max_spans', [r2])
    if (r1.bytes + r2.bytes + tailBytes > c.limits.maxFetchBytes) throw tooMuch(c, 'the data files in range plus the unflushed tail', r1.bytes + r2.bytes + tailBytes)
    const release = reserveBytes(r2.bytes)
    try {
      const spanFiles = await fetchRound(c, r2, have, rf.refused)
      if (!spanFiles) continue
      checkDeadline(c)
      return finish(spanFiles, tails, bound)
    } finally {
      release()
    }
  }
  throw new ApiError('unavailable', 'the ledger kept changing while the query was being planned; retry')
}

/**
 * The hour (since the epoch) of a `spans` file: a flush writes one file per hour of span start
 * (contracts/TRACES.md), so it is the hour of its first start (`minTs`), whatever its key looks
 * like. Null for a file that spans several hours (a compaction output: never pruned by hour).
 */
export function hourOf(f: Pick<FileEntry, 'minTs' | 'maxTs'>): number | null {
  const h = Math.floor(f.minTs / 3_600_000)
  return Math.floor(f.maxTs / 3_600_000) === h ? h : null
}

export interface TraceSearch {
  query: string
  startNs: bigint
  endNs: bigint
  limit: number
  spss: number
}

/** Tempo's `/api/search` body. */
export async function traceSearch(c: Context, q: TraceSearch): Promise<string> {
  const plan = c.engine.tqPlan('search', q.query, q.startNs, q.endNs, 0n)
  const window = { lo: BigInt(plan.lo), hi: BigInt(plan.hi) }
  const bound = traceBound(c, window)
  const run = (files: Uint8Array[], tails: Uint8Array[], b: { lo: bigint; hi: bigint }) => {
    const out = engineCall(c, () => c.engine.tqSearch(files, tails, q.query, { limit: q.limit, spss: q.spss, startNs: q.startNs, endNs: q.endNs, maxSpans: c.limits.maxSpans }, budget(c, b)))
    c.cost.rowsDecoded = out.spans
    return out.json
  }
  return traceRounds(c, window, bound, undefined, run, () => run([], [], bound))
}

export interface TraceMetrics {
  query: string
  instant: boolean
  startNs: bigint
  endNs: bigint
  stepNs: bigint
}

/** Tempo's `/api/metrics/query_range` and `/api/metrics/query` bodies. */
export async function traceMetrics(c: Context, q: TraceMetrics): Promise<string> {
  const plan = c.engine.tqPlan(q.instant ? 'instant' : 'range', q.query, q.startNs, q.endNs, q.stepNs)
  const req = { instant: q.instant, startNs: BigInt(plan.start!), endNs: BigInt(plan.end!), stepNs: BigInt(plan.step!), maxSpans: c.limits.maxSpans, maxSeries: c.limits.maxTraceSeries, maxPoints: c.limits.maxTracePoints }
  const run = (files: Uint8Array[], tails: Uint8Array[], b?: { lo: bigint; hi: bigint }) => {
    const out = engineCall(c, () => c.engine.tqMetrics(files, tails, q.query, req, budget(c, b)))
    c.cost.rowsDecoded = out.spans
    return out.json
  }
  const window = { lo: BigInt(plan.lo), hi: BigInt(plan.hi) }
  if (plan.complete) {
    const bound = traceBound(c, window)
    return traceRounds(c, window, bound, undefined, run, () => run([], [], bound))
  }
  // Span-local: the spans that start in the window are the data; nothing else is cut.
  return spansIn(c, window, (files, tails) => run(files, tails))
}

/** The spans that start in `window` (one ledger plan of `spans`) and the tail, to `finish`. */
async function spansIn<T>(c: Context, window: { lo: bigint; hi: bigint }, finish: (files: Uint8Array[], tails: Uint8Array[]) => T): Promise<T> {
  const rf = refusals()
  const have = new Map<string, Uint8Array>()
  const w = msRange(window.lo, window.hi)
  for (let attempt = 1; ; attempt++) {
    checkDeadline(c)
    const p = await planTable(c, 'spans', w.minTs, w.maxTs)
    c.cost.ledgerVersion = p.version
    if (hooks.afterPlan) await hooks.afterPlan(c.tenant, attempt)
    const r = round(p.files, pruning() ? c.engine.tqFilePlan('spans', p.files.map((f) => f.index), window.lo, window.hi) : null)
    c.cost.pruning = pruning() ? 'fragments' : 'off'
    capsBeforeFetch(c, [r], c.limits.maxSpans, 'max_spans')
    const release = reserveBytes(r.bytes)
    try {
      const [files, tails] = await Promise.all([fetchRound(c, r, have, rf.refused), readSignalTail(c, 'traces', p.watermarks, r.bytes, rf, window)])
      if (!files || !tails) continue
      checkDeadline(c)
      return finish(files, tails)
    } finally {
      release()
    }
  }
}

/** Tempo's `/api/traces/<id>` (v1) or `/api/v2/traces/<id>` body; null when the trace is not found. */
export async function traceById(c: Context, id: Uint8Array, version: 1 | 2, startNs: bigint | null, endNs: bigint | null): Promise<string | null> {
  // Without a hint, all time: the whole trace. With one, the hint widened by the margin, as for
  // a search (Tempo documents that a range "can result in … partial results").
  const window = { lo: startNs ?? 0n, hi: endNs ?? MAX_NS }
  const bound = startNs === null && endNs === null ? { lo: 0n, hi: MAX_NS } : traceBound(c, window)
  c.cost.pruning = pruning() ? 'hours' : 'off'
  const run = (files: Uint8Array[], tails: Uint8Array[], b: { lo: bigint; hi: bigint }) => {
    const out = engineCall(c, () => c.engine.tqTrace(files, tails, id, version, c.limits.maxSpans, budget(c, b)))
    c.cost.rowsDecoded = out.spans
    return out.json
  }
  return traceRounds(c, window, bound, id, run, () => null)
}

/** Tempo's tag names (`/api/search/tags`, `/api/v2/search/tags`) over the spans that start in the window. */
export async function traceTags(c: Context, version: 1 | 2, scope: string, startNs: bigint, endNs: bigint, limit: number): Promise<string> {
  return spansIn(c, { lo: startNs, hi: endNs }, (files, tails) => engineCall(c, () => c.engine.tqTags(files, tails, version, scope, startNs, endNs, limit, c.limits.maxSpans, budget(c))))
}

/** Tempo's tag values (`/api/search/tag/<tag>/values`, `/api/v2/search/tag/<tag>/values`). */
export async function traceTagValues(c: Context, version: 1 | 2, tag: string, q: string, startNs: bigint, endNs: bigint, limit: number): Promise<string> {
  return spansIn(c, { lo: startNs, hi: endNs }, (files, tails) => engineCall(c, () => c.engine.tqTagValues(files, tails, version, tag, q, startNs, endNs, limit, c.limits.maxSpans, budget(c))))
}
