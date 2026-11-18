/**
 * Tier 0: multi-window, multi-burn-rate SLO alerting, as in the Google SRE Workbook,
 * chapter 5 "Alerting on SLOs" (sre.google/workbook/alerting-on-slos, read 2026-11-18).
 *
 *   error ratio over a window  = bad events / total events in the window
 *   burn rate                  = error ratio / (1 − SLO)
 *   budget consumed by a window at burn rate b = b × window / SLO period
 *   detection time (approach 4) = (1 − SLO) / error ratio × window × burn rate
 *
 * A rule fires when the burn rate exceeds its threshold over BOTH its long and its short
 * window (strictly greater, as the workbook's `>` expressions). Defaults are the workbook's
 * approach-6 configuration for a 30-day SLO (its example expressions; Table 5-8 lists the
 * page rows and the 3d/6h ticket row):
 *
 *   page    1h  / 5m   × 14.4   (2% of the budget)
 *   page    6h  / 30m  × 6      (5%)
 *   ticket  24h / 2h   × 3      (10%)
 *   ticket  3d  / 6h   × 1      (10%)
 *
 * Input: `values` = bad events per bucket and `total` = all events per bucket, as increments
 * (the caller turns counters into increases, counter resets included). A missing bucket
 * (NaN in either) is excluded from both sums, never counted as zero errors; each window
 * reports its coverage. `minEvents` is the low-traffic guard from the workbook's
 * "Low-Traffic Services" section: a rule cannot fire unless its long window saw that many events.
 *
 * Two ways to call it:
 * - `evaluateWindows` — stateless, from window aggregates the ruler already has (recording
 *   rules, as Sloth and Pyrra generate). This is the cheap path.
 * - `burnRate.detect` — incremental over a bucket series; state is a ring of the longest
 *   window's buckets plus running sums.
 */
import type { Detector, DetectResult, Explanation, Point, Series } from '../types.ts'
import { length, merge, missingPoint, mod, resolveStep, slotOf, summarize, stateBytes } from '../base.ts'
import { duration, fmt } from '../explain.ts'
import { finiteScore } from '../stats.ts'

export const MINUTE = 60_000
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR

export interface BurnRule {
  severity: 'page' | 'ticket'
  longMs: number
  shortMs: number
  burnRate: number
}

/** The workbook's approach-6 rules (its alerting expressions). */
export const SRE_WORKBOOK_RULES: BurnRule[] = [
  { severity: 'page', longMs: HOUR, shortMs: 5 * MINUTE, burnRate: 14.4 },
  { severity: 'page', longMs: 6 * HOUR, shortMs: 30 * MINUTE, burnRate: 6 },
  { severity: 'ticket', longMs: DAY, shortMs: 2 * HOUR, burnRate: 3 },
  { severity: 'ticket', longMs: 3 * DAY, shortMs: 6 * HOUR, burnRate: 1 },
]

// ───────────────────────────── the arithmetic ─────────────────────────────

/** Fraction of the period's error budget spent by burning at `burnRate` for `windowMs`. */
export const budgetConsumed = (burnRate: number, windowMs: number, periodMs: number) => (burnRate * windowMs) / periodMs
/** Burn rate at which `windowMs` spends `fraction` of the budget. */
export const burnRateFor = (fraction: number, windowMs: number, periodMs: number) => (fraction * periodMs) / windowMs
/** Time to spend the whole budget at a constant burn rate. */
export const timeToExhaustionMs = (burnRate: number, periodMs: number) => periodMs / burnRate
/** Error ratio corresponding to a burn rate. */
export const errorRatioFor = (burnRate: number, objective: number) => burnRate * (1 - objective)
/**
 * Workbook detection time for a constant error ratio that starts at t = 0, window averaged:
 * (1 − SLO) / errorRatio × window × burnRate. Infinity when the error ratio can never reach
 * the threshold (the window average tops out at the error ratio itself).
 */
export function detectionTimeMs(errorRatio: number, objective: number, windowMs: number, burnRate: number): number {
  const need = burnRate * (1 - objective)
  if (!(errorRatio > need)) return Infinity
  return ((1 - objective) / errorRatio) * windowMs * burnRate
}
/** Multiwindow rule: both windows must exceed, so the long window decides (short ≤ long). */
export function ruleDetectionTimeMs(errorRatio: number, objective: number, rule: BurnRule): number {
  return Math.max(detectionTimeMs(errorRatio, objective, rule.longMs, rule.burnRate), detectionTimeMs(errorRatio, objective, rule.shortMs, rule.burnRate))
}
/**
 * Reset time after a long 100%-bad outage ends: the window average falls below the threshold
 * once less than burnRate·(1 − SLO) of the window is still inside the outage.
 */
export function resetTimeMs(windowMs: number, burnRate: number, objective: number): number {
  return windowMs * (1 - Math.min(1, burnRate * (1 - objective)))
}

// ───────────────────────────── stateless evaluation ─────────────────────────────

export interface WindowAggregate { bad: number; total: number }

export interface RuleResult {
  rule: BurnRule
  longBurn: number | null
  shortBurn: number | null
  firing: boolean
  /** min(longBurn, shortBurn) / threshold; ≥ 1 means both windows exceed (subject to minEvents). */
  score: number
  /** Fraction of the period's budget spent within the long window. */
  longBudgetConsumed: number | null
  longEvents: number
  reason: string
}

export interface BurnParams {
  /** e.g. 0.999 */
  objective: number
  periodMs: number
  rules: BurnRule[]
  /** Low-traffic guard: events needed in a rule's long window before it may fire. */
  minEvents: number
  /** Bucket width; 0 = inferred. */
  stepMs: number
  /** Fraction of a window's buckets that must be present for it to count. */
  minCoverage: number
}

export const burnDefaults: BurnParams = { objective: 0.999, periodMs: 30 * DAY, rules: SRE_WORKBOOK_RULES, minEvents: 0, stepMs: 0, minCoverage: 0 }

const burnOf = (w: WindowAggregate | undefined, objective: number) =>
  w && w.total > 0 && Number.isFinite(w.bad) && Number.isFinite(w.total) ? w.bad / w.total / (1 - objective) : null

/** Evaluate every rule from per-window aggregates keyed by window length in ms. */
export function evaluateWindows(params: Partial<BurnParams>, windows: Map<number, WindowAggregate>): RuleResult[] {
  const p = merge(burnDefaults, params)
  return p.rules.map((rule) => {
    const L = windows.get(rule.longMs)
    const S = windows.get(rule.shortMs)
    const longBurn = burnOf(L, p.objective)
    const shortBurn = burnOf(S, p.objective)
    const longEvents = L?.total ?? 0
    const enough = longEvents >= p.minEvents
    const firing = longBurn !== null && shortBurn !== null && longBurn > rule.burnRate && shortBurn > rule.burnRate && enough
    const score = longBurn !== null && shortBurn !== null ? finiteScore(Math.min(longBurn, shortBurn) / rule.burnRate) : 0
    const reason =
      longBurn === null || shortBurn === null ? 'no events in a window'
        : !enough ? `only ${fmt(longEvents)} events in ${duration(rule.longMs)} (minimum ${fmt(p.minEvents)})`
        : firing ? 'both windows above the threshold'
        : 'below the threshold in at least one window'
    return { rule, longBurn, shortBurn, firing, score, longBudgetConsumed: longBurn === null ? null : budgetConsumed(longBurn, rule.longMs, p.periodMs), longEvents, reason }
  })
}

/** The sentence for a firing rule. */
export function explainRule(r: RuleResult, objective: number, periodMs: number, at: number): Explanation {
  const lb = r.longBurn ?? 0
  const sb = r.shortBurn ?? 0
  const consumed = 100 * (r.longBudgetConsumed ?? 0)
  return {
    text:
      `error budget burning at ${fmt(lb)}× over ${duration(r.rule.longMs)} and ${fmt(sb)}× over ${duration(r.rule.shortMs)} ` +
      `(${r.rule.severity} threshold ${fmt(r.rule.burnRate)}×); ${fmt(consumed)}% of the ${duration(periodMs)} budget ` +
      `for a ${fmt(100 * objective)}% objective was spent in the last ${duration(r.rule.longMs)}`,
    detector: 'burn_rate',
    kind: 'burn_rate',
    direction: 'above',
    value: Math.min(lb, sb),
    reference: r.rule.burnRate,
    referenceLabel: `${r.rule.severity} burn-rate threshold`,
    deviations: r.score,
    at,
    facts: { longBurn: lb, shortBurn: sb, threshold: r.rule.burnRate, longWindowMs: r.rule.longMs, shortWindowMs: r.rule.shortMs, budgetConsumedPercent: consumed, severity: r.rule.severity, objective, longEvents: r.longEvents },
  }
}

// ───────────────────────────── incremental detector ─────────────────────────────

export interface BurnSeries extends Series {
  /** Total events per bucket; `values` holds the bad events. */
  total: Float64Array
}

export interface BurnState {
  v: 1
  stepMs: number
  origin: number
  lastTs: number | null
  lastSlot: number | null
  /** Ring of the longest window's buckets; null = missing. */
  bad: (number | null)[]
  tot: (number | null)[]
  /** Window lengths in buckets, with running sums over the last w buckets (bad, total, present). */
  win: { w: number; bad: number; tot: number; present: number }[]
}

function windowsOf(rules: BurnRule[], stepMs: number): number[] {
  const set = new Set<number>()
  for (const r of rules) {
    set.add(Math.max(1, Math.round(r.longMs / stepMs)))
    set.add(Math.max(1, Math.round(r.shortMs / stepMs)))
  }
  return [...set].sort((a, b) => a - b)
}

export const burnRate: Detector<BurnParams, BurnState> & {
  detect(series: BurnSeries, params?: Partial<BurnParams>, state?: BurnState | null): DetectResult<BurnState>
} = {
  name: 'burn_rate',
  tier: 0,
  mode: 'incremental',
  defaults: burnDefaults,
  history(params, stepMs) {
    const p = merge(burnDefaults, params)
    const longest = Math.max(...p.rules.map((r) => r.longMs))
    const buckets = stepMs > 0 ? Math.round(longest / stepMs) : 0
    return {
      lookbackMs: longest,
      resolutionMs: stepMs,
      minPoints: 1,
      incremental: true,
      tickLookbackMs: 0,
      reason: `Longest window ${duration(longest)}; state holds ${buckets} buckets of (bad, total). From recording rules, evaluateWindows needs no state.`,
    }
  },
  detect(series: Series, params?: Partial<BurnParams>, state?: BurnState | null): DetectResult<BurnState> {
    const p = merge(burnDefaults, params)
    const totals = (series as BurnSeries).total
    const stepMs = resolveStep(p.stepMs, state?.stepMs, series, state?.lastTs)
    const n = Math.min(length(series), totals?.length ?? 0)
    const ws = stepMs > 0 ? windowsOf(p.rules, stepMs) : []
    const R = ws.length ? ws[ws.length - 1]! : 1
    const compatible = state && state.v === 1 && state.stepMs === stepMs && state.bad.length === R && state.win.length === ws.length && state.win.every((w, i) => w.w === ws[i])
    let firstTs = NaN
    for (let i = 0; i < n; i++) if (Number.isFinite(series.ts[i]!)) { firstTs = series.ts[i]!; break }
    const st: BurnState = compatible
      ? { ...state, bad: state.bad.slice(), tot: state.tot.slice(), win: state.win.map((w) => ({ ...w })) }
      : { v: 1, stepMs, origin: Number.isFinite(firstTs) ? firstTs : 0, lastTs: null, lastSlot: null, bad: new Array(R).fill(null), tot: new Array(R).fill(null), win: ws.map((w) => ({ w, bad: 0, tot: 0, present: 0 })) }
    const points: Point[] = new Array(n)
    const budget = 1 - p.objective
    // Move the ring forward to slot s. Before the write the ring holds slots s−R … s−1, so the
    // bucket leaving a window of w buckets is slot s−w (for w = R, the one being overwritten).
    const put = (s: number, b: number | null, t: number | null) => {
      for (const w of st.win) {
        const k = mod(s - w.w, R)
        const lb = st.bad[k], lt = st.tot[k]
        if (lb !== null && lb !== undefined && lt !== null && lt !== undefined) { w.bad -= lb; w.tot -= lt; w.present-- }
      }
      st.bad[mod(s, R)] = b
      st.tot[mod(s, R)] = t
      if (b !== null && t !== null) for (const w of st.win) { w.bad += b; w.tot += t; w.present++ }
    }
    for (let i = 0; i < n; i++) {
      const ts = series.ts[i]!
      const b = series.values[i]!
      const t = totals[i]!
      if (!Number.isFinite(ts) || (st.lastTs !== null && ts <= st.lastTs) || stepMs <= 0) {
        points[i] = missingPoint(ts, b)
        continue
      }
      const s = slotOf(ts, st.origin, stepMs)
      if (st.lastSlot !== null && s <= st.lastSlot) { points[i] = missingPoint(ts, b); continue }
      // empty buckets between the last slot and this one
      if (st.lastSlot !== null) {
        const from = Math.max(st.lastSlot + 1, s - R)
        if (s - st.lastSlot - 1 >= R) { // everything left every window
          st.bad.fill(null); st.tot.fill(null)
          for (const w of st.win) { w.bad = 0; w.tot = 0; w.present = 0 }
        } else for (let q = from; q < s; q++) put(q, null, null)
      }
      const valid = Number.isFinite(b) && Number.isFinite(t) && b >= 0 && t >= 0
      put(s, valid ? b : null, valid ? t : null)
      st.lastSlot = s
      st.lastTs = ts
      // clean float drift
      for (const w of st.win) { if (w.bad < 0) w.bad = 0; if (w.tot < 0) w.tot = 0 }
      if (!valid) { points[i] = missingPoint(ts, b); continue }
      const agg = new Map<number, WindowAggregate>()
      for (const r of p.rules) {
        for (const ms of [r.longMs, r.shortMs]) {
          const wb = Math.max(1, Math.round(ms / stepMs))
          const w = st.win.find((x) => x.w === wb)!
          const coverage = w.present / wb
          agg.set(ms, coverage >= p.minCoverage ? { bad: w.bad, total: w.tot } : { bad: 0, total: 0 })
        }
      }
      const results = evaluateWindows(p, agg)
      let best: RuleResult | null = null
      let score = 0
      for (const r of results) {
        score = Math.max(score, r.score)
        if (r.firing && (!best || (r.rule.severity === 'page' && best.rule.severity !== 'page') || (r.rule.severity === best.rule.severity && r.score > best.score))) best = r
      }
      const pt: Point = {
        ts,
        value: t > 0 ? b / t : 0,
        expected: budget,
        lower: null,
        upper: p.rules.length ? budget * Math.min(...p.rules.map((r) => r.burnRate)) : null,
        score: finiteScore(score),
        anomalous: best !== null,
        status: 'ok',
      }
      if (best) pt.explanation = explainRule(best, p.objective, p.periodMs, ts)
      points[i] = pt
    }
    const out: BurnState = { ...st }
    return { points, state: out, summary: { ...summarize('burn_rate', points, out), stateBytes: stateBytes(out) } }
  },
}
