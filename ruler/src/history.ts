/**
 * Reading a rule's history, and running a rule over it: warm-ups of new anomaly and SLO rules,
 * and backtests of anomaly and SLO rules. Pure apart from the engine calls in `fetchHistory`.
 *
 * Every read is bounded before anything is fetched: each range query (cut into pieces of at most
 * 11,000 steps, the engine's limit) is planned first (`HistoryPlanner`, viz-query's
 * `/api/v1/plan`), the plans are summed, and the whole read is refused when the sum is over the
 * budget or the engine's plan refuses a piece. Nothing is fetched in part.
 *
 * Every run over history feeds the points, in time order, through the function a live tick calls
 * (`evalAnomaly`, `evalSlo`, then `evalAlertingRule`), never through a second implementation.
 */
import type { PromMatrix } from '../../contracts/engine'
import type { AnomalyRuleV2, BacktestResult, HistoryPlanner, RangeEvaluator, SloRuleV2, WarmupStatus } from '../contracts-proposal/rules.v2'
import { evalAnomaly, newAnomalyRt, serializeAnomaly, type AnomalyLimits, type AnomalyRt } from './anomaly'
import { resultOf, trackIntervals, type StepInput } from './backtest'
import type { CompiledAlertRule } from './rules'
import { bucketsOf, COARSE_BLOCK, coarseExprOf, evalSlo, FINE_BLOCK, newSloRt, Ring, sloGeometry, type SloRt, type SloSeriesState } from './slo'
import type { AlertEvalOptions, Series } from './statemachine'
import { fingerprint, formatDuration, parseSampleValue } from './util'

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
} as const

/** A warm-up the engine failed is tried at this many ticks before the rule starts cold. */
export const MAX_WARMUP_ATTEMPTS = 3

/** The two budgets from a ruler's limits. */
export function historyBudgets(limits: Partial<Record<keyof typeof HISTORY_LIMIT_DEFAULTS, number>>): { warmup: Budget; backtest: Budget } {
  return {
    warmup: { scanSamples: limits.maxWarmupScanSamples ?? HISTORY_LIMIT_DEFAULTS.maxWarmupScanSamples, bytesToRead: limits.maxWarmupBytes ?? HISTORY_LIMIT_DEFAULTS.maxWarmupBytes },
    backtest: { scanSamples: limits.maxBacktestScanSamples ?? HISTORY_LIMIT_DEFAULTS.maxBacktestScanSamples, bytesToRead: limits.maxBacktestBytes ?? HISTORY_LIMIT_DEFAULTS.maxBacktestBytes },
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

export type Fetched =
  | { ok: true; matrices: PromMatrix[]; plan: PlanSum }
  /** Nothing was fetched. `plan` is null when the refusal came before any plan was summed. */
  | { ok: false; refused: string; plan: PlanSum | null }

const stepsOf = (r: Read) => Math.floor((r.toMs - r.fromMs) / r.stepMs) + 1

/** A read cut into range queries of at most `MAX_STEPS_PER_QUERY` steps, on the same grid. */
export function pieces(r: Read): Read[] {
  const out: Read[] = []
  for (let from = r.fromMs; from <= r.toMs; from += MAX_STEPS_PER_QUERY * r.stepMs) {
    out.push({ ...r, fromMs: from, toMs: Math.min(r.toMs, from + (MAX_STEPS_PER_QUERY - 1) * r.stepMs) })
  }
  return out
}

/**
 * Plan every piece of every read, then fetch them all, or nothing. An engine that cannot be
 * reached throws (the caller decides whether to retry); a plan over the budget, a plan the engine
 * would refuse, or a plan without the numbers to check is a refusal.
 */
export async function fetchHistory(planner: HistoryPlanner, range: RangeEvaluator, reads: Read[], budget: Budget): Promise<Fetched> {
  const all = reads.map((r) => pieces(r))
  const sum: PlanSum = { scanSamples: 0, bytesToRead: 0, queries: 0 }
  for (const p of all.flat()) {
    const plan = await planner.plan(p.promql, p.fromMs, p.toMs, p.stepMs)
    if (plan.refusal) return { ok: false, refused: `the engine would refuse the read: ${plan.refusal.errorType}: ${plan.refusal.error}`, plan: null }
    if (!Number.isFinite(plan.scanSamples) || !Number.isFinite(plan.bytesToRead)) return { ok: false, refused: 'the engine\'s plan did not say what the read costs, so it was not made', plan: null }
    sum.scanSamples += plan.scanSamples
    sum.bytesToRead += plan.bytesToRead
    sum.queries++
  }
  if (sum.scanSamples > budget.scanSamples || sum.bytesToRead > budget.bytesToRead) {
    return {
      ok: false,
      refused: `over budget: the read would scan ${sum.scanSamples} samples and ${sum.bytesToRead} bytes in ${sum.queries} range quer${sum.queries === 1 ? 'y' : 'ies'}; the budget is ${budget.scanSamples} samples and ${budget.bytesToRead} bytes`,
      plan: sum,
    }
  }
  const matrices: PromMatrix[] = []
  for (const ps of all) {
    if (ps.length === 1) {
      // One range query: its matrix as the engine gave it (duplicate label sets included, which the rule's evaluation refuses).
      const p = ps[0]!
      const m = await range.range(p.promql, p.fromMs, p.toMs, p.stepMs)
      if (m.resultType !== 'matrix') throw new Error('the range evaluation did not return a matrix')
      matrices.push(m)
      continue
    }
    const bySeries = new Map<string, { metric: Record<string, string>; values: [number, string][] }>()
    for (const p of ps) {
      const m = await range.range(p.promql, p.fromMs, p.toMs, p.stepMs)
      if (m.resultType !== 'matrix') throw new Error('the range evaluation did not return a matrix')
      for (const s of m.result) {
        const k = fingerprint(s.metric)
        const e = bySeries.get(k)
        if (e) e.values.push(...s.values)
        else bySeries.set(k, { metric: s.metric, values: [...s.values] })
      }
    }
    matrices.push({ resultType: 'matrix', result: [...bySeries.values()] })
  }
  return { ok: true, matrices, plan: sum }
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

/** Feed history through `evalAnomaly`, in time order, from no state. */
function feedAnomaly(rule: AnomalyRuleV2, rt: AnomalyRt, steps: Map<number, Series[]>, fromMs: number, toMs: number, intervalMs: number, limits: AnomalyLimits): { ok: true; rt: AnomalyRt; points: number } | { ok: false; error: string } {
  let cur = rt
  let points = 0
  for (let ts = fromMs; ts <= toMs; ts += intervalMs) {
    const series = steps.get(ts) ?? []
    points += series.length
    const ev = evalAnomaly(rule, cur, series, ts, intervalMs, limits, rule.annotations, false)
    if (!ev.ok) return { ok: false, error: ev.error }
    cur = { ...cur, series: ev.next, json: ev.json, status: ev.status, pruned: ev.status.pruned }
  }
  return { ok: true, rt: cur, points }
}

/** A new anomaly rule's state from its history: what it would hold had it run over `read`. */
export function warmAnomaly(rule: AnomalyRuleV2, matrix: PromMatrix, read: Read, limits: AnomalyLimits): { ok: true; rt: AnomalyRt; points: number } | { ok: false; error: string } {
  const fed = feedAnomaly(rule, newAnomalyRt(rule), byStep(matrix), read.fromMs, read.toMs, read.stepMs, limits)
  if (!fed.ok) return fed
  const ser = serializeAnomaly(fed.rt.series, limits)
  if (!ser.ok) return ser
  return { ok: true, rt: { ...fed.rt, json: ser.json, status: { ...fed.rt.status, stateSeries: fed.rt.series.size, stateBytes: ser.bytes } }, points: fed.points }
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

/**
 * The state at the end of `fine` from no state: the coarse buckets first (they hold what lies
 * before the fine read), then every fine bucket through `evalSlo` in time order. The windows are
 * judged at the last point only (`judgeFrom`: the first query time at which they are; a backtest
 * passes its `fromMs` and keeps going).
 */
export function seedSlo(rule: SloRuleV2, intervalMs: number, fine: Read, coarse: Read | null, coarseMatrix: PromMatrix | null): { rt: SloRt; points: number } | { error: string } {
  const g = sloGeometry(rule.slo, intervalMs)
  const rt = newSloRt(rule)
  const origin = residue(fine.fromMs, intervalMs)
  rt.origin = origin
  const nFirst = Math.round((fine.fromMs - origin) / intervalMs)
  const m = g.coarseMs / intervalMs
  rt.lastSlot = nFirst - 1
  rt.lastCoarse = Math.ceil(nFirst / m) - 1
  let points = 0
  if (coarse && coarseMatrix) {
    const steps = byStep(coarseMatrix)
    for (let ts = coarse.fromMs; ts <= coarse.toMs; ts += coarse.stepMs) {
      const k = Math.round((ts - origin) / g.coarseMs)
      const list = steps.get(ts) ?? []
      points += list.length
      // The same pairing as a tick, so a coarse read is judged by the same rules.
      const pairs = bucketsOf(rule, list)
      if (!pairs.ok) return { error: pairs.error }
      if (pairs.buckets.size > rule.slo.maxSeries) return { error: `series_cap_exceeded: the SLI returned ${pairs.buckets.size} series; this rule evaluates at most ${rule.slo.maxSeries} (max_series)` }
      for (const [key, b] of pairs.buckets) {
        let s = rt.series.get(key)
        if (!s) rt.series.set(key, (s = freshSeries(rule, intervalMs, b.labels)))
        if (b.bad === b.bad) {
          s.coarse.add(k, b.bad, b.tot)
          // The earliest bucket with data on record starts one coarse width before its step.
          rt.firstTs ??= ts - coarse.stepMs
        }
        s.seenAt = ts
      }
    }
  }
  return { rt, points }
}

function freshSeries(rule: SloRuleV2, intervalMs: number, labels: Record<string, string>): SloSeriesState {
  const g = sloGeometry(rule.slo, intervalMs)
  return { labels, fine: new Ring(g.fineSize, FINE_BLOCK), coarse: new Ring(g.coarseSize, COARSE_BLOCK), last: null, seenAt: 0 }
}

/** Feed fine buckets through `evalSlo`, in time order. Windows are judged from `judgeFrom` on. */
function feedSlo(rule: SloRuleV2, rt: SloRt, steps: Map<number, Series[]>, fromMs: number, toMs: number, intervalMs: number, judgeFrom: number, onStep?: (ts: number, ev: Extract<ReturnType<typeof evalSlo>, { ok: true }>) => void): { ok: true; points: number } | { ok: false; error: string } {
  let points = 0
  for (let ts = fromMs; ts <= toMs; ts += intervalMs) {
    const series = steps.get(ts) ?? []
    points += series.length
    const ev = evalSlo(rule, rt, series, ts, intervalMs, ts >= judgeFrom)
    if (!ev.ok) return { ok: false, error: ev.error }
    onStep?.(ts, ev)
  }
  return { ok: true, points }
}

/** A new SLO rule's state from its history: what it would hold had it run until `fine.toMs`. */
export function warmSlo(rule: SloRuleV2, intervalMs: number, fine: Read, coarse: Read | null, fineMatrix: PromMatrix, coarseMatrix: PromMatrix | null): { ok: true; rt: SloRt; points: number } | { ok: false; error: string } {
  const seeded = seedSlo(rule, intervalMs, fine, coarse, coarseMatrix)
  if ('error' in seeded) return { ok: false, error: seeded.error }
  const fed = feedSlo(rule, seeded.rt, byStep(fineMatrix), fine.fromMs, fine.toMs, intervalMs, fine.toMs)
  if (!fed.ok) return fed
  return { ok: true, rt: seeded.rt, points: seeded.points + fed.points }
}

// ───────────────────────────── backtests of anomaly and SLO rules ─────────────────────────────

export interface RuleBacktestInput {
  compiled: CompiledAlertRule
  fromMs: number
  toMs: number
  /** = the live interval: a detector's step is the interval, so a backtest runs at it. */
  stepMs: number
  opts: AlertEvalOptions
  /** Range evaluation of the rule's no-data expression over [fromMs, toMs], when it has one. */
  presence: PromMatrix | null
}

function resolutionNote(kind: 'anomaly' | 'slo', stepMs: number, warmMs: number): string {
  return [
    `Evaluated every ${formatDuration(stepMs)}, the rule's interval, through the same evaluation as a live tick.`,
    `Its ${kind === 'slo' ? 'burn-rate windows and budget' : 'detector'} started from ${formatDuration(warmMs)} of history before the range, as a new rule's warm-up would leave them.`,
    'When the range starts at a live evaluation time, starts and ends are the times live evaluation gives; otherwise they are on this grid.',
    'History is read as it is stored now (late samples and rollups included), not as it was at the time.',
  ].join(' ')
}

/** An anomaly rule over [fromMs, toMs], warmed from `warmFromMs`. `matrix` covers [warmFromMs, toMs] at the step. */
export function backtestAnomaly(rule: AnomalyRuleV2, matrix: PromMatrix, warmFromMs: number, limits: AnomalyLimits, input: RuleBacktestInput): { ok: true; result: BacktestResult; warmPoints: number } | { ok: false; error: string } {
  const steps = byStep(matrix)
  const I = input.stepMs
  const warmed = feedAnomaly(rule, newAnomalyRt(rule), steps, warmFromMs, input.fromMs - I, I, limits)
  if (!warmed.ok) return warmed
  let rt = warmed.rt
  const presence = input.presence ? byStep(input.presence) : null
  const step = (ts: number): StepInput => {
    const ev = evalAnomaly(rule, rt, steps.get(ts) ?? [], ts, I, limits, rule.annotations, false)
    if (!ev.ok) return { error: ev.error }
    rt = { ...rt, series: ev.next, json: ev.json, status: ev.status, pruned: ev.status.pruned }
    return { series: ev.flagged, presence: presence ? (presence.get(ts) ?? []) : ev.present }
  }
  const tracked = trackIntervals(rule as never, input.compiled, input.opts, input.fromMs, input.toMs, I, step)
  if (!tracked.ok) return tracked
  return {
    ok: true,
    warmPoints: warmed.points,
    result: resultOf(tracked, input.fromMs, input.toMs, I, { stepMs: I, liveIntervalMs: I, edgeErrorMs: I, note: resolutionNote('anomaly', I, input.fromMs - warmFromMs) }),
  }
}

/** An SLO rule over [fromMs, toMs], warmed exactly as a new rule created at `fromMs` would be. */
export function backtestSlo(rule: SloRuleV2, fine: Read, coarse: Read | null, fineMatrix: PromMatrix, coarseMatrix: PromMatrix | null, input: RuleBacktestInput): { ok: true; result: BacktestResult; warmPoints: number } | { ok: false; error: string } {
  const I = input.stepMs
  const seeded = seedSlo(rule, I, fine, coarse, coarseMatrix)
  if ('error' in seeded) return { ok: false, error: seeded.error }
  const rt = seeded.rt
  const steps = byStep(fineMatrix)
  // The warm-up part: buckets only, judged at its last point (as a warm-up leaves the state).
  const warm = feedSlo(rule, rt, steps, fine.fromMs, input.fromMs - I, I, input.fromMs - I)
  if (!warm.ok) return warm
  const presence = input.presence ? byStep(input.presence) : null
  const step = (ts: number): StepInput => {
    const ev = evalSlo(rule, rt, steps.get(ts) ?? [], ts, I, true)
    if (!ev.ok) return { error: ev.error }
    return { series: ev.flagged, presence: presence ? (presence.get(ts) ?? []) : ev.present }
  }
  const tracked = trackIntervals(rule as never, input.compiled, input.opts, input.fromMs, input.toMs, I, step)
  if (!tracked.ok) return tracked
  return {
    ok: true,
    warmPoints: seeded.points + warm.points,
    result: resultOf(tracked, input.fromMs, input.toMs, I, { stepMs: I, liveIntervalMs: I, edgeErrorMs: I, note: resolutionNote('slo', I, input.fromMs - fine.fromMs) }),
  }
}
