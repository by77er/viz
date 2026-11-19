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
import type { AlertingRuleV2, AnomalyRuleV2, BacktestResult, HistoryPlanner, RangeEvaluator, SloRuleV2, WarmupStatus } from '../contracts-proposal/rules.v2'
import { evalAnomaly, newAnomalyRt, serializeAnomaly, type AnomalyLimits, type AnomalyRt } from './anomaly'
import { INTERVALS_MAX_BYTES, IntervalTracker, resultOf } from './backtest'
import type { CompiledAlertRule } from './rules'
import { bucketsOf, COARSE_BLOCK, coarseExprOf, evalSlo, FINE_BLOCK, newSloRt, Ring, sloGeometry, type SloRt, type SloSeriesState } from './slo'
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
  slo: 3.1,
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

/** µs of CPU per point an anomaly rule's evaluation costs; a detector this release does not price costs as the dearest would at its size. */
export function anomalyCpu(rule: AnomalyRuleV2): number {
  const c = CPU.anomaly[rule.anomaly.detector]
  const cost = (k: { fixed: number; perStateByte: number }) => k.fixed + k.perStateByte * rule.anomaly.stateBytesPerSeries
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
  companions?: { read: Read; seriesBound: number }[]
  /** Every step of `read`, in time order. Returns an error to stop. */
  feed(ts: number, series: Series[], companions: (Series[] | null)[]): string | null
}

export interface Sizing {
  /** Steps per window, per stream. */
  windowSteps: number[]
  /** The model's peak: the fixed bytes and the largest window. */
  peakBytes: number
  budgetBytes: number
  /** Range queries the windows take (companions included). */
  queries: number
}

/**
 * Windows as large as the budget allows: (budget − fixed) / (points per step × bytes per point),
 * at most the engine's 11,000 steps. Refused when the fixed bytes alone, or one step, do not fit,
 * or when the windows would take more than `MAX_HISTORY_QUERIES` queries.
 */
export function sizeWindows(streams: Stream[], fixedBytes: number, budgetBytes: number): ({ ok: true } & Sizing) | { ok: false; refused: string; peakBytes: number; budgetBytes: number } {
  const windowSteps: number[] = []
  let peak = fixedBytes
  let queries = 0
  for (const s of streams) {
    const perStep = (s.seriesBound + (s.companions ?? []).reduce((n, c) => n + c.seriesBound, 0)) * MEMORY.perPoint
    const w = Math.min(MAX_STEPS_PER_QUERY, stepsOf(s.read), Math.floor((budgetBytes - fixedBytes) / perStep))
    if (w < 1) {
      const need = fixedBytes + perStep
      return { ok: false, refused: `over the memory budget: holding this rule's state (${mb(fixedBytes)}) and one step of ${s.seriesBound} series would take ${mb(need)}; the budget is ${mb(budgetBytes)}`, peakBytes: need, budgetBytes }
    }
    windowSteps.push(w)
    peak = Math.max(peak, fixedBytes + w * perStep)
    const windows = Math.ceil(stepsOf(s.read) / w)
    queries += windows * (1 + (s.companions?.length ?? 0))
  }
  if (queries > MAX_HISTORY_QUERIES) {
    return { ok: false, refused: `over the memory budget: windows that fit ${mb(budgetBytes)} would take ${queries} range queries; at most ${MAX_HISTORY_QUERIES}`, peakBytes: peak, budgetBytes }
  }
  return { ok: true, windowSteps, peakBytes: peak, budgetBytes, queries }
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
   * Refused: nothing kept. Before the first window's evaluation for a budget or a plan (then
   * nothing was fetched, unless the CPU model needed one window to count the series), or before a
   * later window whose series would take the run over its CPU budget. `defer`: it would fit a run
   * with the whole of `deferBelowMs`.
   */
  | { ok: false; refused: string; plan: PlanSum | null; sizing: { peakBytes: number; budgetBytes: number } | null; cpu?: CpuAccount & { spentMs: number }; defer?: boolean }
  /** A window could not be evaluated (or held more than the model allows); what came before it was. */
  | { ok: false; failed: string }

/** A companion read clipped to one window of its stream's read, or null when it has no step there. */
function clip(c: Read, w: Read): Read | null {
  const from = Math.max(c.fromMs, w.fromMs)
  const to = Math.min(c.toMs, w.toMs)
  return from <= to ? { ...c, fromMs: from, toMs: to } : null
}

/**
 * Size the windows, plan every piece, then fetch and feed window after window, stream after
 * stream, in time order. An engine that cannot be reached throws (the caller decides whether to
 * retry); a read over a budget, or one the engine's plan refuses, is refused before any window is
 * fetched; a window holding more points than the model sized it for stops the run (`failed`).
 */
export async function streamHistory(planner: HistoryPlanner, range: RangeEvaluator, streams: Stream[], budget: Budget, memoryBudget: number, fixedBytes: number, cpuBudget: CpuBudget = { budgetMs: Infinity }): Promise<Streamed> {
  const sizing = sizeWindows(streams, fixedBytes, memoryBudget)
  if (!sizing.ok) return { ok: false, refused: sizing.refused, plan: null, sizing: { peakBytes: sizing.peakBytes, budgetBytes: sizing.budgetBytes } }
  const sum: PlanSum = { scanSamples: 0, bytesToRead: 0, queries: 0 }
  for (const s of streams) {
    for (const r of [s.read, ...(s.companions ?? []).map((c) => c.read)]) {
      for (const p of pieces(r)) {
        const plan = await planner.plan(p.promql, p.fromMs, p.toMs, p.stepMs)
        if (plan.refusal) return { ok: false, refused: `the engine would refuse the read: ${plan.refusal.errorType}: ${plan.refusal.error}`, plan: null, sizing }
        if (!Number.isFinite(plan.scanSamples) || !Number.isFinite(plan.bytesToRead)) return { ok: false, refused: 'the engine\'s plan did not say what the read costs, so it was not made', plan: null, sizing }
        sum.scanSamples += plan.scanSamples
        sum.bytesToRead += plan.bytesToRead
        sum.queries++
      }
    }
  }
  if (sum.scanSamples > budget.scanSamples || sum.bytesToRead > budget.bytesToRead) {
    return {
      ok: false,
      refused: `over budget: the read would scan ${sum.scanSamples} samples and ${sum.bytesToRead} bytes in ${sum.queries} range quer${sum.queries === 1 ? 'y' : 'ies'}; the budget is ${budget.scanSamples} samples and ${budget.bytesToRead} bytes`,
      plan: sum,
      sizing,
    }
  }
  let points = 0
  // The CPU model, checked before each window is evaluated, with the most series a window has shown so far.
  let spentUs = CPU.base
  let series = 0
  let fed = 0
  const totalWindows = streams.reduce((n, s, i) => n + Math.ceil(stepsOf(s.read) / sizing.windowSteps[i]!), 0)
  const budgetUs = cpuBudget.budgetMs * 1000
  for (const [i, s] of streams.entries()) {
    const W = sizing.windowSteps[i]!
    for (const w of pieces(s.read, W)) {
      const main = await range.range(w.promql, w.fromMs, w.toMs, w.stepMs)
      if (main.resultType !== 'matrix') throw new Error('the range evaluation did not return a matrix')
      const comps: (PromMatrix | null)[] = []
      for (const c of s.companions ?? []) {
        const cw = clip(c.read, w)
        comps.push(cw ? await range.range(cw.promql, cw.fromMs, cw.toMs, cw.stepMs) : null)
      }
      // The model assumed at most `seriesBound` series a step: a window holding more is not evaluated.
      const held = pointsOf(main) + comps.reduce((n, m) => n + pointsOf(m), 0)
      const allowed = stepsOf(w) * (s.seriesBound + (s.companions ?? []).reduce((n, c) => n + c.seriesBound, 0))
      if (held > allowed) return { ok: false, failed: `the engine returned ${held} points for a window the memory model sized for ${allowed} (${s.seriesBound} series a step): more series than the rule allows` }
      const mainPts = pointsOf(main)
      const thisUs = mainPts * s.cpuPerPoint + (held - mainPts) * (CPU.parse + CPU.presence) + CPU.perWindow
      series = Math.max(series, main.result.length + comps.reduce((n, m) => n + (m?.result.length ?? 0), 0))
      // What is left after this window, every series at every step, at each stream's cost.
      let restUs = 0
      for (let j = i; j < streams.length; j++) {
        const sj = streams[j]!
        const left = j === i ? Math.max(0, (sj.read.toMs - w.toMs) / sj.read.stepMs) : stepsOf(sj.read)
        restUs += left * series * Math.max(sj.cpuPerPoint, CPU.parse + CPU.presence) + Math.ceil(left / sizing.windowSteps[j]!) * CPU.perWindow
      }
      const projected = spentUs + thisUs + restUs
      if (projected > budgetUs) {
        // `spentMs`: what this run used before it stopped (the window it read was parsed), for an alarm's account.
        const cpu = { modelledMs: Math.round(projected / 1000), budgetMs: cpuBudget.budgetMs, spentMs: Math.ceil((spentUs + held * CPU.parse) / 1000) }
        const where = fed === 0 ? `the first window shows ${series} series` : `after ${fed} of ${totalWindows} windows the run shows ${series} series`
        return {
          ok: false,
          refused: `over the CPU budget: ${where}; the whole run would take about ${cpuText(projected)} of CPU (modelled), the budget is ${cpuText(budgetUs)}. ${fed === 0 ? 'Nothing was evaluated' : 'Stopped before evaluating more; nothing is kept'}`,
          plan: sum,
          sizing,
          cpu,
          // A run started again from the beginning would cost the whole projection again.
          defer: cpuBudget.deferBelowMs !== undefined && projected <= cpuBudget.deferBelowMs * 1000,
        }
      }
      spentUs += thisUs
      fed++
      points += held
      const steps = byStep(main)
      const cSteps = comps.map((m) => (m ? byStep(m) : null))
      for (let ts = w.fromMs; ts <= w.toMs; ts += w.stepMs) {
        const err = s.feed(ts, steps.get(ts) ?? [], cSteps.map((c) => (c ? (c.get(ts) ?? []) : null)))
        if (err !== null) return { ok: false, failed: err }
      }
    }
  }
  return { ok: true, plan: sum, sizing, points, cpu: { modelledMs: Math.round(spentUs / 1000), budgetMs: cpuBudget.budgetMs } }
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
  | { ok: false; refused: string; plan: PlanSum | null; sizing: { peakBytes: number; budgetBytes: number } | null; cpu?: CpuAccount & { spentMs: number }; defer?: boolean }
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

/** In-memory bytes of one anomaly rule's state, modelled: the stored estimate, about 3 bytes of heap a stored byte (README, part 8). */
export const anomalyStateBytes = (rule: AnomalyRuleV2) => rule.anomaly.maxSeries * rule.anomaly.stateBytesPerSeries * 3

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

/** A new anomaly rule's state from its history, read in windows: what it would hold had it run over `read`. The state's memory is the rule's own (the per-object budget), not the run's. */
export async function warmAnomaly(rule: AnomalyRuleV2, read: Read, limits: AnomalyLimits, io: HistoryIo): Promise<HistoryRun<AnomalyRt>> {
  const feed = new AnomalyFeed(rule, read.stepMs, limits)
  const run = await streamHistory(io.planner, io.range, [{ read, seriesBound: rule.anomaly.maxSeries, cpuPerPoint: anomalyCpu(rule), feed: (ts, series) => { const r = feed.step(ts, series); return r.ok ? null : r.error } }], io.budget, io.memoryBytes, MEMORY.base, io.cpu)
  if (!run.ok) return run
  const ser = serializeAnomaly(feed.rt.series, limits)
  if (!ser.ok) return { ok: false, failed: ser.error }
  return { ...run, value: { ...feed.rt, json: ser.json, status: { ...feed.rt.status, stateSeries: feed.rt.series.size, stateBytes: ser.bytes } } }
}

// ───────────────────────────── SLO rules ─────────────────────────────

const residue = (t: number, m: number) => ((t % m) + m) % m

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

function freshSeries(rule: SloRuleV2, intervalMs: number, labels: Record<string, string>): SloSeriesState {
  const g = sloGeometry(rule.slo, intervalMs)
  return { labels, fine: new Ring(g.fineSize, FINE_BLOCK), coarse: new Ring(g.coarseSize, COARSE_BLOCK), last: null, seenAt: 0 }
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
    if (!s) rt.series.set(key, (s = freshSeries(rule, intervalMs, b.labels)))
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
function sloStreams(rule: SloRuleV2, intervalMs: number, rt: SloRt, fine: Read, coarse: Read | null, onFine: Stream['feed'], companions?: Stream['companions']): Stream[] {
  const out: Stream[] = []
  if (coarse) out.push({ read: coarse, seriesBound: 2 * rule.slo.maxSeries, cpuPerPoint: CPU.parse + CPU.slo, feed: (ts, series) => sloCoarseStep(rule, intervalMs, rt, coarse.stepMs, ts, series) })
  out.push({ read: fine, seriesBound: 2 * rule.slo.maxSeries, cpuPerPoint: CPU.parse + CPU.slo, companions, feed: onFine })
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
  const fixed = backtestFixed(rule.anomaly.maxSeries) + anomalyStateBytes(rule)
  const run = await streamHistory(io.planner, io.range, [{ read, seriesBound: rule.anomaly.maxSeries, cpuPerPoint: anomalyCpu(rule), companions: presenceCompanion(input, rule.anomaly.maxSeries), feed: step }], io.budget, io.memoryBytes, fixed, io.cpu)
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
  const streams = sloStreams(rule, I, rt, fine, coarse, onFine, presenceCompanion(input, rule.slo.maxSeries))
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
