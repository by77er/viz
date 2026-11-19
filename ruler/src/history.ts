/**
 * Reading a rule's history, and running a rule over it: warm-ups of new anomaly and SLO rules,
 * and backtests of every kind. Pure apart from the engine calls in `streamHistory`.
 *
 * Every read is bounded twice before anything is fetched:
 *   - memory: the read is fetched and evaluated in time windows, one at a time, in order, with
 *     only the rule's state (detector state, bucket rings, alerts, intervals) carried from one
 *     window to the next. Windows are sized from a memory model (`MEMORY`): the state's bytes plus
 *     one window's points at the series bound the rule's own evaluation enforces. When even the
 *     state does not fit the budget, the read is refused, before any plan is asked for;
 *   - cost: each range query (cut into pieces of at most 11,000 steps, the engine's limit) is
 *     planned first (`HistoryPlanner`, viz-query's `/api/v1/plan`), the plans are summed, and the
 *     whole read is refused when the sum is over the budget or the engine's plan refuses a piece.
 * Nothing is fetched in part: a refusal comes before the first window.
 *
 * Every run over history feeds the points, in time order, through the function a live tick calls
 * (`evalAnomaly`, `evalSlo`, then `evalAlertingRule`), never through a second implementation, so
 * where the windows fall changes nothing in the result.
 */
import type { PromMatrix } from '../../contracts/engine'
import type { AlertingRuleV2, AnomalyRuleV2, BacktestResult, HistoryBudget, HistoryPlan, HistoryPlanner, RangeEvaluator, SloRuleV2, WarmupStatus } from '../contracts-proposal/rules.v2'
import { cpuStateBytes, evalAnomaly, newAnomalyRt, serializeAnomaly, type AnomalyLimits, type AnomalyRt } from './anomaly'
import type { AnomalyWrite } from './anomalystore'
import { INTERVALS_MAX_BYTES, IntervalTracker, resultOf } from './backtest'
import type { CompiledAlertRule } from './rules'
import { bucketsOf, coarseExprOf, evalSlo, newSeries, newSloRt, residue, sloGeometry, type SloRt } from './slo'
import type { AlertEvalOptions, Series } from './statemachine'
import { formatDuration, parseSampleValue } from './util'

/**
 * What one warm-up and one backtest may read, as the engine's plan estimates it before anything is
 * fetched (contracts/rules.ts `RulerLimits`). The warm-up's is what one query of viz-query may read
 * in one place (query/README.md: `maxScanSamples` 3,000,000, `maxFetchBytes` 16 MiB), because it
 * runs by itself when a rule is saved; a backtest is asked for, and may read about seven times that.
 */
export const HISTORY_LIMIT_DEFAULTS = {
  maxWarmupScanSamples: 3_000_000,
  maxWarmupBytes: 16 * 1024 * 1024,
  maxBacktestScanSamples: 20_000_000,
  maxBacktestBytes: 128 * 1024 * 1024,
  /**
   * Modelled peak memory of one warm-up and one backtest (`MEMORY`), well under a Durable Object's
   * 128 MB: the object also holds its rules' live state (at most `maxAnomalyStateBytesPerObject`
   * stored, about 3 bytes of heap a byte) and the runtime's own.
   */
  maxWarmupMemoryBytes: 16 * 1024 * 1024,
  maxBacktestMemoryBytes: 32 * 1024 * 1024,
  /**
   * Modelled CPU one backtest, and the warm-ups of one alarm together, may use (`CPU`). A Durable
   * Object request or alarm may use 30 s of CPU by default, 5 minutes at most (`limits.cpu_ms`;
   * README, "CPU"). The model prices every point at 1.5 times the most it was measured to cost, so
   * a backtest (a request of its own) at its 20 s budget is expected to use at most about 13 s; the
   * warm-ups share an alarm with the live ticks, and get 5 s of it.
   */
  maxBacktestCpuMs: 20_000,
  maxWarmupCpuMs: 5_000,
} as const

/** A warm-up the engine failed is tried at this many ticks before the rule starts cold. */
export const MAX_WARMUP_ATTEMPTS = 3

/** The two budgets from a ruler's limits. */
export function historyBudgets(limits: Partial<Record<keyof typeof HISTORY_LIMIT_DEFAULTS, number>>): { warmup: Budget; backtest: Budget; warmupMemory: number; backtestMemory: number; warmupCpuMs: number; backtestCpuMs: number } {
  return {
    warmup: { scanSamples: limits.maxWarmupScanSamples ?? HISTORY_LIMIT_DEFAULTS.maxWarmupScanSamples, bytesToRead: limits.maxWarmupBytes ?? HISTORY_LIMIT_DEFAULTS.maxWarmupBytes },
    backtest: { scanSamples: limits.maxBacktestScanSamples ?? HISTORY_LIMIT_DEFAULTS.maxBacktestScanSamples, bytesToRead: limits.maxBacktestBytes ?? HISTORY_LIMIT_DEFAULTS.maxBacktestBytes },
    warmupMemory: limits.maxWarmupMemoryBytes ?? HISTORY_LIMIT_DEFAULTS.maxWarmupMemoryBytes,
    backtestMemory: limits.maxBacktestMemoryBytes ?? HISTORY_LIMIT_DEFAULTS.maxBacktestMemoryBytes,
    warmupCpuMs: limits.maxWarmupCpuMs ?? HISTORY_LIMIT_DEFAULTS.maxWarmupCpuMs,
    backtestCpuMs: limits.maxBacktestCpuMs ?? HISTORY_LIMIT_DEFAULTS.maxBacktestCpuMs,
  }
}

/** The stored form of a warm-up status (`warmup.body`, format `store.warmup` v1). */
export const WARMUP_VERSION = 1
export const warmupBody = (w: WarmupStatus): string => JSON.stringify({ v: WARMUP_VERSION, ...w })

/** A stored warm-up status, or null for a version this code does not read (the rule is then treated as warmed: nothing is re-read on a guess). */
export function readWarmup(body: string): WarmupStatus | null {
  try {
    const { v, ...w } = JSON.parse(body) as { v?: unknown } & WarmupStatus
    return v === WARMUP_VERSION ? w : null
  } catch {
    return null
  }
}

/** Prometheus' (and viz-query's) most steps per series in one range query. */
export const MAX_STEPS_PER_QUERY = 11_000
/** Most range queries one warm-up or backtest may make (windows over every read): past it, refused. */
export const MAX_HISTORY_QUERIES = 1_000

export interface Read {
  promql: string
  fromMs: number
  toMs: number
  stepMs: number
}

export interface Budget {
  scanSamples: number
  bytesToRead: number
}

export interface PlanSum {
  scanSamples: number
  bytesToRead: number
  queries: number
}

/**
 * The memory model, in bytes. A point is one sample of one series of a range result while its
 * window is held: the engine's JSON (`[seconds, "value"]`), parsed, and its entry in the per-step
 * index (`byStep`). The constants are calibrated against workerd's resident memory in
 * `test/slo.bench.ts` (README, "Streaming"): the model must stay above what is measured.
 */
export const MEMORY = {
  /** Measured 440–710 bytes of resident memory a point (README, "Streaming"): above all of it. */
  perPoint: 768,
  /** The call itself: the parsed rule, maps, the answer being built. */
  base: 2 * 1024 * 1024,
  /** One alert held by the state machine (labels, annotations: an SLO sentence and its numbers). */
  perAlert: 3 * 1024,
  /** What the intervals of one backtest may hold before it stops (`IntervalTracker`, `INTERVALS_MAX_BYTES`). */
  intervals: INTERVALS_MAX_BYTES,
} as const

/**
 * The CPU model, in microseconds: every point of a window costs the engine's JSON parsed and indexed
 * by step (`parse`) plus what the rule's evaluation does with it, by kind; robust_z and seasonal
 * scan their window at every point, so theirs grows with the state they keep per series
 * (`stateBytesPerSeries`). Every window and every run add an allowance. Calibrated against
 * workerd's CPU time in `test/cpu.bench.ts` (README, "CPU"): each per-point figure is 1.5 times the
 * largest measurement; `perWindow` and `base` are allowances, not measured. CPU time is the active
 * processing a Durable Object invocation is limited by; time waiting on the engine is not counted.
 */
export const CPU = {
  parse: 1.5,
  alert: 2.1,
  presence: 2.1,
  /** An SLO rule's point added to its buckets (warm-up, the coarse read), and one evaluated: burn windows, budget, alerts. */
  sloWarm: 1.5,
  sloEvaluated: 6.2,
  anomaly: {
    ewma: { fixed: 8.5, perStateByte: 0 },
    threshold: { fixed: 6.5, perStateByte: 0 },
    cusum: { fixed: 9.6, perStateByte: 0 },
    robust_z: { fixed: 3, perStateByte: 0.0063 },
    seasonal: { fixed: 18, perStateByte: 0.0027 },
  } as Record<string, { fixed: number; perStateByte: number }>,
  perWindow: 500,
  base: 5_000,
} as const

/**
 * µs of CPU per point an anomaly rule's evaluation costs; a detector this release does not price
 * costs as the dearest would at its size. The size is the state's version 1 estimate
 * (`cpuStateBytes`), which the prices were calibrated against, however the state is stored.
 */
export function anomalyCpu(rule: AnomalyRuleV2, intervalMs: number): number {
  const c = CPU.anomaly[rule.anomaly.detector]
  const bytes = cpuStateBytes(rule, intervalMs)
  const cost = (k: { fixed: number; perStateByte: number }) => k.fixed + k.perStateByte * bytes
  return CPU.parse + (c ? cost(c) : Math.max(...Object.values(CPU.anomaly).map(cost)))
}

const stepsOf = (r: Read) => Math.floor((r.toMs - r.fromMs) / r.stepMs) + 1

/** A read cut into range queries of at most `steps` steps (default the engine's limit), on the same grid, in order. */
export function pieces(r: Read, steps = MAX_STEPS_PER_QUERY): Read[] {
  const out: Read[] = []
  for (let from = r.fromMs; from <= r.toMs; from += steps * r.stepMs) {
    out.push({ ...r, fromMs: from, toMs: Math.min(r.toMs, from + (steps - 1) * r.stepMs) })
  }
  return out
}

/**
 * One read processed window by window. `seriesBound` is the most result series a step may have
 * that the rule's evaluation accepts (its `max_series`, twice for an SLO's two parts, or an
 * alerting rule's alert limit): what windows are sized by. `companions` are reads over the same
 * steps (a no-data expression), fetched over the same windows and handed to `feed` beside it.
 */
export interface Stream {
  read: Read
  seriesBound: number
  /** µs of CPU per point fed (`CPU`). */
  cpuPerPoint: number
  /** Points at or after `fromMs` cost `cpuPerPoint` here instead: a backtest's evaluated part, after its warm-up part. */
  evaluated?: { fromMs: number; cpuPerPoint: number }
  companions?: { read: Read; seriesBound: number }[]
  /** Every step of `read`, in time order. Returns an error to stop. */
  feed(ts: number, series: Series[], companions: (Series[] | null)[]): string | null
}

const mb = (b: number) => `${(b / 1048576).toFixed(1)} MiB`
const cpuText = (us: number) => (us >= 1e6 ? `${(us / 1e6).toFixed(1)} s` : `${Math.round(us / 1000)} ms`)

/** The CPU model's account of a run: what it spent (or, refused, would have spent) and its budget. */
export interface CpuAccount {
  modelledMs: number
  budgetMs: number
}

/** The CPU budget of a run: refuse above `budgetMs`; between it and `deferBelowMs`, say that a later run with more room could take it. */
export interface CpuBudget {
  budgetMs: number
  deferBelowMs?: number
}

export type Streamed =
  | { ok: true; plan: PlanSum; sizing: Sizing; points: number; cpu: CpuAccount }
  /**
   * Refused before any window is read: nothing kept. Over the memory model, a budget or a plan's
   * refusal before anything is fetched; over the budget by the windows' plans, or over the CPU
   * budget, after the series counts (`countsRead`, when a read was counted). `defer`: it would fit
   * a run with the whole of `deferBelowMs`. `exceeded`: the budget it was over; null when the
   * engine's plan refused the read or did not price it (not a budget of the ruler).
   */
  | { ok: false; refused: string; exceeded: HistoryBudget | null; plan: PlanSum | null; sizing: { peakBytes: number; budgetBytes: number } | null; cpu?: CpuAccount & { spentMs: number }; defer?: boolean; countsRead?: boolean }
  /** A window could not be evaluated (or held more than the model allows); what came before it was. */
  | { ok: false; failed: string }

/** µs per point of `s` over the steps of [fromMs, toMs]: the evaluated part's price for the steps it covers. */
function pricePerPoint(s: Stream, fromMs: number, toMs: number): number {
  const e = s.evaluated
  const step = s.read.stepMs
  const steps = Math.floor((toMs - fromMs) / step) + 1
  if (!e || steps <= 0 || toMs < e.fromMs) return s.cpuPerPoint
  const first = Math.max(fromMs, fromMs + Math.ceil((e.fromMs - fromMs) / step) * step)
  const f = (Math.floor((toMs - first) / step) + 1) / steps
  return (1 - f) * s.cpuPerPoint + f * e.cpuPerPoint
}

/** A companion read clipped to one window of its stream's read, or null when it has no step there. */
function clip(c: Read, w: Read): Read | null {
  const from = Math.max(c.fromMs, w.fromMs)
  const to = Math.min(c.toMs, w.toMs)
  return from <= to ? { ...c, fromMs: from, toMs: to } : null
}

export interface Sizing {
  /** The longest window of each stream, in steps. */
  windowSteps: number[]
  /** The model's peak: the fixed bytes and the largest window (or count query) held. */
  peakBytes: number
  budgetBytes: number
  /** Range queries the run makes: the series counts, then the windows (companions included). */
  queries: number
}

/**
 * The windows the rule's bound allows: (budget − fixed) / (points per step × bytes per point) steps,
 * at most the engine's 11,000. Refused when the fixed bytes alone, or one step at the bound, do not
 * fit: then no window can hold what the rule may return.
 */
export function sizeWindows(streams: Stream[], fixedBytes: number, budgetBytes: number): { ok: true; windowSteps: number[] } | { ok: false; refused: string; peakBytes: number; budgetBytes: number } {
  const windowSteps: number[] = []
  for (const s of streams) {
    const perStep = boundOf(s) * MEMORY.perPoint
    const w = Math.min(MAX_STEPS_PER_QUERY, stepsOf(s.read), Math.floor((budgetBytes - fixedBytes) / perStep))
    if (w < 1) {
      const need = fixedBytes + perStep
      return { ok: false, refused: `over the memory budget: holding this rule's state (${mb(fixedBytes)}) and one step of ${s.seriesBound} series would take ${mb(need)}; the budget is ${mb(budgetBytes)}`, peakBytes: need, budgetBytes }
    }
    windowSteps.push(w)
  }
  return { ok: true, windowSteps }
}

/** Most series a step of a stream may hold: its own bound and its companions'. */
const boundOf = (s: Stream) => s.seriesBound + (s.companions ?? []).reduce((n, c) => n + c.seriesBound, 0)

/**
 * The query that counts a read's series: one series, the number of the read's series at each step
 * (none where it has none). It reads what the read reads; its answer is one point a step.
 */
export const countExpr = (promql: string): string => `count(${promql})`

/**
 * Plans a run asks for its windows, at most. Past it, a stream's windows are planned in contiguous
 * groups instead, each group's plan counted once for every window in it: a window's query reads a
 * subset of the files its group's range reads (the same expression, a range inside the group's),
 * so the sum is at least what the windows read. A plan is one ledger read in viz-query, 10–70 ms
 * (query/README.md), and goes through the object's one-call gate.
 */
export const MAX_WINDOW_PLANS = 32

/** One window of a stream: its read, its companions' reads clipped to it, and the points its count gave (null when not counted). */
interface Window {
  read: Read
  companions: (Read | null)[]
  points: number | null
}

const keyOf = (r: Read) => `${r.stepMs} ${r.fromMs} ${r.toMs} ${r.promql}`

/**
 * Plan, count, plan the windows, then fetch and feed window after window, stream after stream, in
 * time order. A read whose windows at the rule's series bound would cut it finer than the engine's
 * 11,000-step pieces is first counted (`countExpr`) and cut into windows by the points each step
 * really holds; otherwise its windows are the pieces. Every query that is fetched is planned, and
 * the sum checked against the budget, before it is fetched:
 * 1. before anything is fetched: the whole reads (a lower bound of any windows over them: every
 *    file they read, some window reads) and the count queries;
 * 2. after the counts, before any window: the count queries and every window as it will be fetched
 *    (companions clipped to it), or a bound (`MAX_WINDOW_PLANS`).
 * An engine that cannot be reached throws (the caller decides whether to retry); a window holding
 * more points than its count said, or than the rule allows, stops the run (`failed`).
 */
export async function streamHistory(planner: HistoryPlanner, range: RangeEvaluator, streams: Stream[], budget: Budget, memoryBudget: number, fixedBytes: number, cpuBudget: CpuBudget = { budgetMs: Infinity }): Promise<Streamed> {
  const bound = sizeWindows(streams, fixedBytes, memoryBudget)
  if (!bound.ok) return { ok: false, refused: bound.refused, exceeded: 'memory', plan: null, sizing: { peakBytes: bound.peakBytes, budgetBytes: bound.budgetBytes } }
  const pointsPerWindow = Math.floor((memoryBudget - fixedBytes) / MEMORY.perPoint)
  // A count query holds one point a step.
  const countSteps = Math.min(MAX_STEPS_PER_QUERY, pointsPerWindow)
  const counted = streams.map((s, i) => bound.windowSteps[i]! < Math.min(MAX_STEPS_PER_QUERY, stepsOf(s.read)))
  const readsOf = (s: Stream) => [{ read: s.read, seriesBound: s.seriesBound }, ...(s.companions ?? [])]

  // Every plan asked once: a window that is a whole piece reuses the piece's.
  const plans = new Map<string, HistoryPlan>()
  const planOf = async (r: Read): Promise<HistoryPlan | string> => {
    const k = keyOf(r)
    let p = plans.get(k)
    if (!p) {
      p = await planner.plan(r.promql, r.fromMs, r.toMs, r.stepMs)
      if (p.refusal) return `the engine would refuse the read: ${p.refusal.errorType}: ${p.refusal.error}`
      if (!Number.isFinite(p.scanSamples) || !Number.isFinite(p.bytesToRead)) return 'the engine\'s plan did not say what the read costs, so it was not made'
      plans.set(k, p)
    }
    return p
  }
  const add = (to: PlanSum, p: HistoryPlan, times = 1) => {
    to.scanSamples += p.scanSamples * times
    to.bytesToRead += p.bytesToRead * times
    to.queries += times
  }
  const over = (p: PlanSum) => p.scanSamples > budget.scanSamples || p.bytesToRead > budget.bytesToRead
  const refuse = (p: PlanSum, how: string, countsRead: boolean, sizing: { peakBytes: number; budgetBytes: number }): Streamed => ({
    ok: false,
    // Samples when both are over: the first the budget names.
    exceeded: p.scanSamples > budget.scanSamples ? 'scan_samples' : 'bytes',
    refused: `over budget: the read would scan ${p.scanSamples} samples and ${p.bytesToRead} bytes in ${p.queries} range quer${p.queries === 1 ? 'y' : 'ies'}${how}; the budget is ${budget.scanSamples} samples and ${budget.bytesToRead} bytes`,
    plan: p,
    sizing,
    ...(countsRead ? { countsRead } : {}),
  })

  // 1. Before anything is fetched: the whole reads and the count queries.
  const first: PlanSum = { scanSamples: 0, bytesToRead: 0, queries: 0 }
  const countReads: { j: number; read: Read }[][] = streams.map(() => [])
  for (const [i, s] of streams.entries()) {
    for (const [j, { read }] of readsOf(s).entries()) {
      for (const p of pieces(read)) {
        const plan = await planOf(p)
        if (typeof plan === 'string') return { ok: false, refused: plan, exceeded: null, plan: null, sizing: null }
        add(first, plan)
      }
      if (!counted[i]) continue
      for (const p of pieces({ ...read, promql: countExpr(read.promql) }, countSteps)) {
        const plan = await planOf(p)
        if (typeof plan === 'string') return { ok: false, refused: plan, exceeded: null, plan: null, sizing: null }
        add(first, plan)
        countReads[i]!.push({ j, read: p })
      }
    }
  }
  const boundPeak = { peakBytes: fixedBytes + Math.max(...streams.map((s, i) => bound.windowSteps[i]! * boundOf(s))) * MEMORY.perPoint, budgetBytes: memoryBudget }
  if (over(first)) return refuse(first, counted.some((x) => x) ? ' (its series counts, and windows that read at least the whole range once)' : '', false, boundPeak)

  // 2. The counts: how many points each step of each counted read holds.
  let spentUs = CPU.base
  const windows: Window[][] = []
  const total: PlanSum = { scanSamples: 0, bytesToRead: 0, queries: 0 }
  let grouped = false
  for (const [i, s] of streams.entries()) {
    if (!counted[i]) {
      // Its windows are the engine's pieces: planned as fetched (a companion clipped to each).
      const ws: Window[] = pieces(s.read).map((w) => ({ read: w, companions: (s.companions ?? []).map((c) => clip(c.read, w)), points: null }))
      for (const w of ws) {
        for (const r of [w.read, ...w.companions]) {
          if (!r) continue
          const plan = await planOf(r)
          if (typeof plan === 'string') return { ok: false, refused: plan, exceeded: null, plan: null, sizing: null }
          add(total, plan)
        }
      }
      windows.push(ws)
      continue
    }
    const perStep = new Map<number, number>()
    const bounds = readsOf(s).map((r) => r.seriesBound)
    for (const { j, read: cr } of countReads[i]!) {
      const m = await range.range(cr.promql, cr.fromMs, cr.toMs, cr.stepMs)
      if (m.resultType !== 'matrix') throw new Error('the range evaluation did not return a matrix')
      add(total, plans.get(keyOf(cr))!)
      let pts = 0
      for (const x of m.result) {
        for (const [sec, text] of x.values) {
          const ts = Math.round(sec * 1000)
          const n = Number(text)
          pts++
          if (!(n > 0)) continue
          if (n > bounds[j]!) return { ok: false, failed: `the read returns ${n} series at ${new Date(ts).toISOString()}, where ${j === 0 ? 'the rule allows' : 'its no-data expression may have'} at most ${bounds[j]} a step: more series than the rule allows` }
          perStep.set(ts, (perStep.get(ts) ?? 0) + n)
        }
      }
      spentUs += pts * CPU.parse + CPU.perWindow
    }
    // Windows by the points each step holds, at most 11,000 steps.
    const ws: Window[] = []
    let from = s.read.fromMs
    let pts = 0
    const close = (to: number) => {
      const w = { ...s.read, fromMs: from, toMs: to }
      ws.push({ read: w, companions: (s.companions ?? []).map((c) => clip(c.read, w)), points: pts })
    }
    for (let ts = s.read.fromMs; ts <= s.read.toMs; ts += s.read.stepMs) {
      const n = perStep.get(ts) ?? 0
      if (ts > from && (pts + n > pointsPerWindow || (ts - from) / s.read.stepMs >= MAX_STEPS_PER_QUERY)) {
        close(ts - s.read.stepMs)
        from = ts
        pts = 0
      }
      pts += n
    }
    close(s.read.toMs)
    windows.push(ws)
  }
  const fetches = total.queries + windows.reduce((n, ws, i) => n + (counted[i] ? ws.reduce((m, w) => m + 1 + w.companions.filter((c) => c).length, 0) : 0), 0)
  const peakPoints = Math.max(0, ...countReads.flat().map((c) => stepsOf(c.read)), ...windows.flatMap((ws, i) => ws.map((w) => w.points ?? stepsOf(w.read) * boundOf(streams[i]!))))
  const sizing: Sizing = { windowSteps: windows.map((ws) => Math.max(...ws.map((w) => stepsOf(w.read)))), peakBytes: fixedBytes + peakPoints * MEMORY.perPoint, budgetBytes: memoryBudget, queries: fetches }
  if (fetches > MAX_HISTORY_QUERIES) {
    // Only counted reads can need this many windows, so the counts were read.
    return { ok: false, refused: `over the memory budget: windows that fit ${mb(memoryBudget)} would take ${fetches} range queries; at most ${MAX_HISTORY_QUERIES}`, exceeded: 'queries', plan: null, sizing: { peakBytes: sizing.peakBytes, budgetBytes: memoryBudget }, ...(counted.some((x) => x) ? { countsRead: true } : {}) }
  }

  // 3. The counted streams' windows, planned as they will be fetched (or bounded by groups of them).
  const toPlan = windows.reduce((n, ws, i) => n + (counted[i] ? ws.filter((w) => !plans.has(keyOf(w.read))).length : 0), 0)
  const groupsWanted = toPlan > MAX_WINDOW_PLANS
  const countedWindows = windows.reduce((n, ws, i) => n + (counted[i] ? ws.length : 0), 0)
  for (const [i, ws] of windows.entries()) {
    if (!counted[i]) continue
    const s = streams[i]!
    if (!groupsWanted) {
      for (const w of ws) {
        for (const r of [w.read, ...w.companions]) {
          if (!r) continue
          const plan = await planOf(r)
          if (typeof plan === 'string') return { ok: false, refused: plan, exceeded: null, plan: null, sizing: null }
          add(total, plan)
        }
      }
      continue
    }
    grouped = true
    // Contiguous groups, as many as this stream's share of MAX_WINDOW_PLANS.
    const g = Math.max(1, Math.floor((MAX_WINDOW_PLANS * ws.length) / countedWindows))
    const size = Math.ceil(ws.length / g)
    for (let a = 0; a < ws.length; a += size) {
      const group = ws.slice(a, a + size)
      const span = { ...s.read, fromMs: group[0]!.read.fromMs, toMs: group.at(-1)!.read.toMs }
      const main = await planOf(span)
      if (typeof main === 'string') return { ok: false, refused: main, exceeded: null, plan: null, sizing: null }
      add(total, main, group.length)
      for (const [j, c] of (s.companions ?? []).entries()) {
        const cs = clip(c.read, span)
        const n = group.filter((w) => w.companions[j]).length
        if (!cs || n === 0) continue
        const plan = await planOf(cs)
        if (typeof plan === 'string') return { ok: false, refused: plan, exceeded: null, plan: null, sizing: null }
        add(total, plan, n)
      }
    }
  }
  if (over(total)) {
    return refuse(total, grouped ? ` (its series counts, and its windows planned in groups, each group's plan counted for every window in it: an upper bound)` : ' (its series counts, and its windows, each planned as it would be fetched)', true, { peakBytes: sizing.peakBytes, budgetBytes: memoryBudget })
  }

  // 4. The CPU model, before any window is read: a counted window at the points its count gave, any
  // other at every step holding the rule's bound (it was not counted because that fits), every
  // window its allowance. An upper bound of what feeding them costs, so a run that starts finishes.
  const totalWindows = windows.reduce((n, ws) => n + ws.length, 0)
  let projected = spentUs
  let pointsUp = 0
  for (const [i, ws] of windows.entries()) {
    for (const w of ws) {
      const n = w.points ?? stepsOf(w.read) * boundOf(streams[i]!)
      pointsUp += n
      projected += n * Math.max(pricePerPoint(streams[i]!, w.read.fromMs, w.read.toMs), CPU.parse + CPU.presence) + CPU.perWindow
    }
  }
  const budgetUs = cpuBudget.budgetMs * 1000
  if (projected > budgetUs) {
    const anyCounted = counted.some((x) => x)
    const how = counted.every((x) => x) ? 'by the series counts' : anyCounted ? 'by the series counts, or at the rule\'s bound where not counted' : 'at the rule\'s bound'
    return {
      ok: false,
      exceeded: 'cpu',
      refused: `over the CPU budget: its ${totalWindows} window${totalWindows === 1 ? ' holds' : 's hold'} ${pointsUp} points ${how}; the whole run would take about ${cpuText(projected)} of CPU (modelled), the budget is ${cpuText(budgetUs)}. ${anyCounted ? 'Only the series counts were read' : 'Nothing was fetched'}`,
      plan: total,
      sizing,
      // `spentMs`: what this run used before it was refused (the counts parsed), for an alarm's account.
      cpu: { modelledMs: Math.round(projected / 1000), budgetMs: cpuBudget.budgetMs, spentMs: Math.ceil(spentUs / 1000) },
      // A run started again from the beginning would cost the whole projection again.
      defer: cpuBudget.deferBelowMs !== undefined && projected <= cpuBudget.deferBelowMs * 1000,
      ...(anyCounted ? { countsRead: true } : {}),
    }
  }

  // 5. The windows, in order.
  let points = 0
  for (const [i, s] of streams.entries()) {
    for (const win of windows[i]!) {
      const w = win.read
      const main = await range.range(w.promql, w.fromMs, w.toMs, w.stepMs)
      if (main.resultType !== 'matrix') throw new Error('the range evaluation did not return a matrix')
      const comps: (PromMatrix | null)[] = []
      for (const cw of win.companions) comps.push(cw ? await range.range(cw.promql, cw.fromMs, cw.toMs, cw.stepMs) : null)
      const mainPts = pointsOf(main)
      const held = mainPts + comps.reduce((n, m) => n + pointsOf(m), 0)
      // The model sized the window for its count, or for the rule's bound: a window holding more is not evaluated.
      if (win.points !== null) {
        if (held > Math.ceil(win.points * 1.1) + stepsOf(w)) return { ok: false, failed: `the engine returned ${held} points for a window its series count put at ${win.points}: the data changed between the count and the read` }
      } else if (held > stepsOf(w) * boundOf(s)) {
        return { ok: false, failed: `the engine returned ${held} points for a window the memory model sized for ${stepsOf(w) * boundOf(s)} (${s.seriesBound} series a step): more series than the rule allows` }
      }
      spentUs += mainPts * pricePerPoint(s, w.fromMs, w.toMs) + (held - mainPts) * (CPU.parse + CPU.presence) + CPU.perWindow
      points += held
      const steps = byStep(main)
      const cSteps = comps.map((m) => (m ? byStep(m) : null))
      for (let ts = w.fromMs; ts <= w.toMs; ts += w.stepMs) {
        const err = s.feed(ts, steps.get(ts) ?? [], cSteps.map((c) => (c ? (c.get(ts) ?? []) : null)))
        if (err !== null) return { ok: false, failed: err }
      }
    }
  }
  return { ok: true, plan: total, sizing, points, cpu: { modelledMs: Math.round(spentUs / 1000), budgetMs: cpuBudget.budgetMs } }
}

/** A matrix by step time: ts (ms) → the series at that step. */
export function byStep(m: PromMatrix | null): Map<number, Series[]> {
  const out = new Map<number, Series[]>()
  if (!m) return out
  for (const s of m.result) {
    for (const [sec, text] of s.values) {
      const ts = Math.round(sec * 1000)
      let list = out.get(ts)
      if (!list) out.set(ts, (list = []))
      list.push({ metric: s.metric, value: parseSampleValue(text), text })
    }
  }
  return out
}

export const pointsOf = (m: PromMatrix | null): number => (m ? m.result.reduce((n, s) => n + s.values.length, 0) : 0)

export function warmupStatus(reads: Read[], budget: Budget): WarmupStatus {
  return { status: 'pending', reads: reads.map((r) => ({ fromMs: r.fromMs, toMs: r.toMs, stepMs: r.stepMs })), plan: null, budget: { ...budget }, points: 0, attempts: 0, message: null, finishedAt: null }
}

/** What a warm-up or a backtest ends with. `points` were read and fed. */
export type HistoryRun<T> =
  | { ok: true; value: T; plan: PlanSum; sizing: Sizing; points: number; cpu: CpuAccount }
  | { ok: false; refused: string; exceeded: HistoryBudget | null; plan: PlanSum | null; sizing: { peakBytes: number; budgetBytes: number } | null; cpu?: CpuAccount & { spentMs: number }; defer?: boolean; countsRead?: boolean }
  | { ok: false; failed: string }

/** The engine and the budgets a run reads with. */
export interface HistoryIo {
  planner: HistoryPlanner
  range: RangeEvaluator
  budget: Budget
  memoryBytes: number
  cpu: CpuBudget
}

// ───────────────────────────── anomaly rules ─────────────────────────────

/** Points an anomaly rule's detector needs before it scores, at the rule's interval; 0 = none. */
export function anomalyWarmPoints(rule: AnomalyRuleV2, intervalMs: number): number {
  const h = rule.anomaly.history
  if (h.lookbackMs <= 0) return 0
  return Math.max(h.minPoints, Math.ceil(h.lookbackMs / intervalMs))
}

/** What warming an anomaly rule reads to have its state at `endTs` (the query time before its first evaluation). */
export function anomalyWarmReads(rule: AnomalyRuleV2, intervalMs: number, endTs: number): Read[] {
  const p = anomalyWarmPoints(rule, intervalMs)
  return p === 0 ? [] : [{ promql: rule.expr, fromMs: endTs - (p - 1) * intervalMs, toMs: endTs, stepMs: intervalMs }]
}

/**
 * In-memory bytes of one anomaly rule's state, modelled: the version 1 estimate, about 3 bytes of heap
 * a byte of it (README, part 8). A run holds the detector's own state, not the stored rows, so this
 * does not shrink with version 2.
 */
export const anomalyStateBytes = (rule: AnomalyRuleV2, intervalMs: number) => rule.anomaly.maxSeries * cpuStateBytes(rule, intervalMs) * 3

/** One anomaly rule's state, fed step by step through `evalAnomaly` (no per-step serialisation). */
class AnomalyFeed {
  rt: AnomalyRt
  constructor(private readonly rule: AnomalyRuleV2, private readonly intervalMs: number, private readonly limits: AnomalyLimits) {
    this.rt = newAnomalyRt(rule)
  }
  step(ts: number, series: Series[]): Extract<ReturnType<typeof evalAnomaly>, { ok: true }> | { ok: false; error: string } {
    const ev = evalAnomaly(this.rule, this.rt, series, ts, this.intervalMs, this.limits, this.rule.annotations, false)
    if (!ev.ok) return ev
    this.rt = { ...this.rt, series: ev.next, json: ev.json, status: ev.status, pruned: ev.status.pruned }
    return ev
  }
}

/**
 * A new anomaly rule's state from its history, read in windows: what it would hold had it run over
 * `read`, and its rows written whole in the version the gate says (`writeVersion`). The state's
 * memory is the rule's own (the per-object budget), not the run's.
 */
export async function warmAnomaly(rule: AnomalyRuleV2, read: Read, limits: AnomalyLimits, io: HistoryIo, writeVersion?: 1 | 2): Promise<HistoryRun<AnomalyRt & { write: AnomalyWrite }>> {
  const feed = new AnomalyFeed(rule, read.stepMs, limits)
  const run = await streamHistory(io.planner, io.range, [{ read, seriesBound: rule.anomaly.maxSeries, cpuPerPoint: anomalyCpu(rule, read.stepMs), feed: (ts, series) => { const r = feed.step(ts, series); return r.ok ? null : r.error } }], io.budget, io.memoryBytes, MEMORY.base, io.cpu)
  if (!run.ok) return run
  const ser = serializeAnomaly(rule, read.stepMs, feed.rt.series, limits, writeVersion)
  if (!ser.ok) return { ok: false, failed: ser.error }
  return { ...run, value: { ...feed.rt, json: ser.json, store: ser.write.store, write: ser.write, status: { ...feed.rt.status, stateSeries: feed.rt.series.size, stateBytes: ser.bytes } } }
}

// ───────────────────────────── SLO rules ─────────────────────────────

/**
 * What warming an SLO rule reads to have its state at `endTs`: the fine buckets of the longest
 * window (from the start of the coarse bucket it begins in), and the compliance window before
 * that as coarse buckets, each read with `$window` set to its own bucket width.
 */
export function sloWarmReads(rule: SloRuleV2, intervalMs: number, endTs: number): { fine: Read; coarse: Read | null } {
  const g = sloGeometry(rule.slo, intervalMs)
  const origin = residue(endTs, intervalMs)
  const nEnd = Math.round((endTs - origin) / intervalMs)
  const m = g.coarseMs / intervalMs
  const kFirst = Math.ceil((nEnd - g.fineSize + 1) / m)
  const nFirst = (kFirst - 1) * m + 1
  const kEnd = Math.ceil(nEnd / m)
  const kFrom = kEnd - g.coarseBuckets + 1
  const fine: Read = { promql: rule.expr, fromMs: origin + nFirst * intervalMs, toMs: endTs, stepMs: intervalMs }
  const coarse: Read | null = kFrom <= kFirst - 1 ? { promql: coarseExpr(rule, g.coarseMs), fromMs: origin + kFrom * g.coarseMs, toMs: origin + (kFirst - 1) * g.coarseMs, stepMs: g.coarseMs } : null
  return { fine, coarse }
}

/** The per-tick expression with `$window` set to the coarse bucket width instead of the interval (rebuilt from the SLI, never by editing the derived text). */
export const coarseExpr = (rule: SloRuleV2, coarseMs: number): string => coarseExprOf(rule.slo.sli, coarseMs)

/** In-memory bytes of one SLO rule's state, modelled: both rings of every series as Float64Arrays, their caches, labels and last outcome. */
export function sloStateBytes(rule: SloRuleV2, intervalMs: number): number {
  const g = sloGeometry(rule.slo, intervalMs)
  return rule.slo.maxSeries * (16 * (g.fineSize + g.coarseSize) + 4096)
}

/**
 * The state a run over `fine` starts from: no buckets, the slot counters just before the fine
 * read (so the coarse buckets fed first are not cleared by the first fine one).
 */
export function sloStart(rule: SloRuleV2, intervalMs: number, fine: Read): SloRt {
  const g = sloGeometry(rule.slo, intervalMs)
  const rt = newSloRt(rule)
  const origin = residue(fine.fromMs, intervalMs)
  rt.origin = origin
  const nFirst = Math.round((fine.fromMs - origin) / intervalMs)
  rt.lastSlot = nFirst - 1
  rt.lastCoarse = Math.ceil(nFirst / (g.coarseMs / intervalMs)) - 1
  return rt
}

/** One coarse step into the rings: the compliance window before the fine read (the same pairing as a tick). */
export function sloCoarseStep(rule: SloRuleV2, intervalMs: number, rt: SloRt, coarseStepMs: number, ts: number, series: Series[]): string | null {
  const g = sloGeometry(rule.slo, intervalMs)
  const pairs = bucketsOf(rule, series)
  if (!pairs.ok) return pairs.error
  if (pairs.buckets.size > rule.slo.maxSeries) return `series_cap_exceeded: the SLI returned ${pairs.buckets.size} series; this rule evaluates at most ${rule.slo.maxSeries} (max_series)`
  const k = Math.round((ts - (rt.origin as number)) / g.coarseMs)
  for (const [key, b] of pairs.buckets) {
    let s = rt.series.get(key)
    if (!s) rt.series.set(key, (s = newSeries(b.labels, g)))
    if (b.bad === b.bad) {
      s.coarse.add(k, b.bad, b.tot)
      // The earliest bucket with data on record starts one coarse width before its step.
      rt.firstTs ??= ts - coarseStepMs
    }
    s.seenAt = ts
  }
  return null
}

/** The streams of an SLO run: the coarse read, then the fine read, each through `onFine` for its steps. */
function sloStreams(rule: SloRuleV2, intervalMs: number, rt: SloRt, fine: Read, coarse: Read | null, onFine: Stream['feed'], companions?: Stream['companions'], evaluatedFromMs?: number): Stream[] {
  const out: Stream[] = []
  if (coarse) out.push({ read: coarse, seriesBound: 2 * rule.slo.maxSeries, cpuPerPoint: CPU.parse + CPU.sloWarm, feed: (ts, series) => sloCoarseStep(rule, intervalMs, rt, coarse.stepMs, ts, series) })
  const evaluated = evaluatedFromMs === undefined ? {} : { evaluated: { fromMs: evaluatedFromMs, cpuPerPoint: CPU.parse + CPU.sloEvaluated } }
  out.push({ read: fine, seriesBound: 2 * rule.slo.maxSeries, cpuPerPoint: CPU.parse + CPU.sloWarm, ...evaluated, companions, feed: onFine })
  return out
}

/** A new SLO rule's state from its history, read in windows: what it would hold had it run until `fine.toMs`. Its rings are the rule's own memory (the per-object budget), not the run's. */
export async function warmSlo(rule: SloRuleV2, intervalMs: number, fine: Read, coarse: Read | null, io: HistoryIo): Promise<HistoryRun<SloRt>> {
  const rt = sloStart(rule, intervalMs, fine)
  const onFine: Stream['feed'] = (ts, series) => {
    const ev = evalSlo(rule, rt, series, ts, intervalMs, ts >= fine.toMs)
    return ev.ok ? null : ev.error
  }
  const run = await streamHistory(io.planner, io.range, sloStreams(rule, intervalMs, rt, fine, coarse, onFine), io.budget, io.memoryBytes, MEMORY.base, io.cpu)
  return run.ok ? { ...run, value: rt } : run
}

// ───────────────────────────── backtests ─────────────────────────────

export interface RuleBacktestInput {
  compiled: CompiledAlertRule
  fromMs: number
  toMs: number
  /** = the live interval for anomaly and SLO rules: a detector's step is the interval. */
  stepMs: number
  opts: AlertEvalOptions
  /** The rule's no-data expression, read over [fromMs, toMs] beside it, when it has one. */
  presence: string | null
  /** The alert limit: the most series a step of an alerting rule may have. */
  alertLimit: number
}

function resolutionNote(kind: 'anomaly' | 'slo', stepMs: number, warmMs: number): string {
  return [
    `Evaluated every ${formatDuration(stepMs)}, the rule's interval, through the same evaluation as a live tick.`,
    `Its ${kind === 'slo' ? 'burn-rate windows and budget' : 'detector'} started from ${formatDuration(warmMs)} of history before the range, as a new rule's warm-up would leave them.`,
    'When the range starts at a live evaluation time, starts and ends are the times live evaluation gives; otherwise they are on this grid.',
    'History is read as it is stored now (late samples and rollups included), not as it was at the time.',
  ].join(' ')
}

export interface BacktestRun {
  result: BacktestResult
  warmPoints: number
}

const presenceCompanion = (input: RuleBacktestInput, bound: number) =>
  input.presence ? [{ read: { promql: input.presence, fromMs: input.fromMs, toMs: input.toMs, stepMs: input.stepMs }, seriesBound: bound }] : undefined

/** Bytes a backtest holds besides its windows: the call, the alerts of `alerts` series, the intervals. */
const backtestFixed = (alerts: number) => MEMORY.base + alerts * MEMORY.perAlert + MEMORY.intervals

/** An alerting rule over [fromMs, toMs], read in windows. */
export async function backtestAlert(rule: AlertingRuleV2, input: RuleBacktestInput, io: HistoryIo): Promise<HistoryRun<BacktestRun>> {
  const tracker = new IntervalTracker(rule, input.compiled, input.opts, input.toMs)
  const read: Read = { promql: rule.expr, fromMs: input.fromMs, toMs: input.toMs, stepMs: input.stepMs }
  const run = await streamHistory(io.planner, io.range, [{ read, seriesBound: input.alertLimit, cpuPerPoint: CPU.parse + CPU.alert, companions: presenceCompanion(input, input.alertLimit), feed: (ts, series, c) => tracker.step(ts, { series, presence: c[0] ?? null }) }], io.budget, io.memoryBytes, backtestFixed(input.alertLimit), io.cpu)
  if (!run.ok) return run
  return { ...run, value: { result: resultOf(tracker.result(), input.fromMs, input.toMs, input.stepMs, { stepMs: 0, liveIntervalMs: 0, edgeErrorMs: 0, note: '' }), warmPoints: 0 } }
}

/** An anomaly rule over [fromMs, toMs], warmed from `warmFromMs` as a warm-up at `fromMs` would, read in windows. */
export async function backtestAnomaly(rule: AnomalyRuleV2, warmFromMs: number, limits: AnomalyLimits, input: RuleBacktestInput, io: HistoryIo): Promise<HistoryRun<BacktestRun>> {
  const I = input.stepMs
  const feed = new AnomalyFeed(rule, I, limits)
  const tracker = new IntervalTracker(rule as unknown as AlertingRuleV2, input.compiled, input.opts, input.toMs)
  let warmPoints = 0
  const read: Read = { promql: rule.expr, fromMs: warmFromMs, toMs: input.toMs, stepMs: I }
  const step: Stream['feed'] = (ts, series, c) => {
    const ev = feed.step(ts, series)
    if (ts < input.fromMs) {
      // The warm-up part: state only, no alerts.
      warmPoints += series.length
      return ev.ok ? null : ev.error
    }
    return tracker.step(ts, ev.ok ? { series: ev.flagged, presence: c[0] ?? ev.present } : { error: ev.error })
  }
  const fixed = backtestFixed(rule.anomaly.maxSeries) + anomalyStateBytes(rule, I)
  const run = await streamHistory(io.planner, io.range, [{ read, seriesBound: rule.anomaly.maxSeries, cpuPerPoint: anomalyCpu(rule, I), companions: presenceCompanion(input, rule.anomaly.maxSeries), feed: step }], io.budget, io.memoryBytes, fixed, io.cpu)
  if (!run.ok) return run
  const result = resultOf(tracker.result(), input.fromMs, input.toMs, I, { stepMs: I, liveIntervalMs: I, edgeErrorMs: I, note: resolutionNote('anomaly', I, input.fromMs - warmFromMs) })
  return { ...run, value: { result, warmPoints } }
}

/** An SLO rule over [fromMs, toMs], warmed exactly as a new rule created at `fromMs` would be, read in windows. `fine` starts at the warm-up's start and ends at `toMs`. */
export async function backtestSlo(rule: SloRuleV2, fine: Read, coarse: Read | null, input: RuleBacktestInput, io: HistoryIo): Promise<HistoryRun<BacktestRun>> {
  const I = input.stepMs
  const rt = sloStart(rule, I, fine)
  const tracker = new IntervalTracker(rule as unknown as AlertingRuleV2, input.compiled, input.opts, input.toMs)
  let warmPoints = 0
  const onFine: Stream['feed'] = (ts, series, c) => {
    if (ts < input.fromMs) {
      // The warm-up part: buckets only, judged at its last point (as a warm-up leaves the state).
      warmPoints += series.length
      const ev = evalSlo(rule, rt, series, ts, I, ts >= input.fromMs - I)
      return ev.ok ? null : ev.error
    }
    const ev = evalSlo(rule, rt, series, ts, I, true)
    return tracker.step(ts, ev.ok ? { series: ev.flagged, presence: c[0] ?? ev.present } : { error: ev.error })
  }
  const streams = sloStreams(rule, I, rt, fine, coarse, onFine, presenceCompanion(input, rule.slo.maxSeries), input.fromMs)
  if (coarse) {
    // Coarse points are warm-up points too.
    const f = streams[0]!.feed
    streams[0]!.feed = (ts, series, c) => {
      warmPoints += series.length
      return f(ts, series, c)
    }
  }
  const fixed = backtestFixed(2 * rule.slo.maxSeries) + sloStateBytes(rule, I)
  const run = await streamHistory(io.planner, io.range, streams, io.budget, io.memoryBytes, fixed, io.cpu)
  if (!run.ok) return run
  const result = resultOf(tracker.result(), input.fromMs, input.toMs, I, { stepMs: I, liveIntervalMs: I, edgeErrorMs: I, note: resolutionNote('slo', I, input.fromMs - fine.fromMs) })
  return { ...run, value: { result, warmPoints } }
}
