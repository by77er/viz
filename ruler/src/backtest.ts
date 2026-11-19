/**
 * Backtest: "if this rule had existed". The rule's expression is evaluated over history by
 * the engine's range query; each step of the result is then fed, in time order, through
 * `evalAlertingRule`, the same function a live tick calls. There is no second
 * implementation of pending, `for`, `keep_firing_for`, no-data or retention here.
 *
 * The result is ONE list of intervals. The summary numbers are computed from that list, so
 * a chart that shades the intervals and a sentence that quotes the summary cannot disagree.
 */
import type { PromMatrix } from '../../contracts/engine'
import type { Alert, AlertingRuleV2, BacktestInterval, BacktestResult } from '../contracts-proposal/rules.v2'
import type { CompiledAlertRule } from './rules'
import { evalAlertingRule, isNoDataAlert, type AlertEvalOptions, type Series } from './statemachine'
export type { Series }
import { formatDuration, parseSampleValue } from './util'

/** Prometheus refuses range queries of more than 11,000 points per series; so does this. */
export const MAX_BACKTEST_STEPS = 11_000

export interface BacktestInput {
  rule: AlertingRuleV2
  compiled: CompiledAlertRule
  /** Range evaluation of `rule.expr` over [fromMs, toMs] at `stepMs`. */
  matrix: PromMatrix
  /** Range evaluation of the rule's no-data expression, when it has one. */
  presence: PromMatrix | null
  fromMs: number
  toMs: number
  stepMs: number
  /** The interval the rule's group would run at when live. */
  liveIntervalMs: number
  opts: AlertEvalOptions
}

/** Index a matrix by step time: for each series, timestamp (ms) → value text. */
function index(m: PromMatrix): { metric: Record<string, string>; at: Map<number, string> }[] {
  return m.result.map((s) => ({ metric: s.metric, at: new Map(s.values.map(([sec, text]) => [Math.round(sec * 1000), text])) }))
}

function seriesAt(ix: ReturnType<typeof index>, ts: number): Series[] {
  const out: Series[] = []
  for (const s of ix) {
    const text = s.at.get(ts)
    if (text !== undefined) out.push({ metric: s.metric, value: parseSampleValue(text), text })
  }
  return out
}

export function resolutionNote(rule: AlertingRuleV2, stepMs: number, liveIntervalMs: number): string {
  const step = formatDuration(stepMs)
  const parts = [
    `Evaluated every ${step}; the live rule would be evaluated every ${formatDuration(liveIntervalMs)}.`,
    `Each start and end is within ${step} of the true time.`,
    `A breach shorter than ${step} can be missed, and firings less than ${step} apart are joined.`,
  ]
  if (rule.forMs > 0 && stepMs > rule.forMs) {
    parts.push(`"for" (${formatDuration(rule.forMs)}) is shorter than the step, so every breach seen is counted as firing one step (${step}) after it starts.`)
  } else if (rule.forMs > 0 && rule.forMs % stepMs !== 0) {
    parts.push(`"for" (${formatDuration(rule.forMs)}) is not a multiple of the step, so it is in effect rounded up to ${formatDuration(Math.ceil(rule.forMs / stepMs) * stepMs)}.`)
  }
  if (stepMs < liveIntervalMs) parts.push('The step is finer than live evaluation: short firings shown here might not have been seen live.')
  parts.push('History is read as it is stored now (late samples and rollups included), not as it was at the time.')
  return parts.join(' ')
}

/** The summary is a function of the intervals and nothing else. */
export function summarize(intervals: BacktestInterval[]): BacktestResult['summary'] {
  const firing = intervals.filter((i) => i.state === 'firing')
  const pending = intervals.filter((i) => i.state === 'pending')
  const fired = new Set(firing.map((i) => `${i.fingerprint}@${i.startMs}`))
  return {
    firingCount: firing.length,
    pendingCount: pending.length,
    firingMs: firing.reduce((n, i) => n + (i.endMs - i.startMs), 0),
    longestFiringMs: firing.reduce((n, i) => Math.max(n, i.endMs - i.startMs), 0),
    clearedCount: pending.filter((i) => !i.open && !fired.has(`${i.fingerprint}@${i.endMs}`)).length,
    firingAtEnd: firing.some((i) => i.open),
    series: new Set(intervals.map((i) => i.fingerprint)).size,
  }
}

/** What one step gives the alert state machine: the rule's result, and what "no data" is decided on. */
export type StepInput = { series: Series[]; presence: Series[] | null } | { error: string }

export interface Tracked {
  ok: true
  intervals: BacktestInterval[]
  steps: number
}

/**
 * What the intervals of one backtest may hold, modelled (they are all held until the answer): an
 * interval's labels and annotations at two bytes a character, and 200 bytes of its own. Past it the
 * backtest stops and says so. `history.ts` reserves this much in its memory model.
 */
export const INTERVALS_MAX_BYTES = 4 * 1024 * 1024
const intervalBytes = (labels: Record<string, string>, annotations: Record<string, string>) => {
  let n = 200
  for (const m of [labels, annotations]) for (const [k, v] of Object.entries(m)) n += 2 * (k.length + v.length) + 32
  return n
}

/**
 * The alert state machine over a range, one step at a time, turning states into intervals. Each
 * interval keeps the annotations its alert carried when it entered the state (templates expanded,
 * an anomaly or SLO alert's explanation among them). Every kind of backtest goes through here; it
 * holds only the alerts and the intervals, so steps can be fed window by window as they are read.
 */
export class IntervalTracker {
  private alerts: ReadonlyMap<string, Alert> = new Map()
  private readonly open = new Map<string, BacktestInterval>()
  readonly intervals: BacktestInterval[] = []
  steps = 0
  /** Modelled bytes the intervals hold. */
  bytes = 0

  constructor(
    private readonly rule: AlertingRuleV2,
    private readonly compiled: CompiledAlertRule,
    private readonly opts: AlertEvalOptions,
    private readonly toMs: number,
    private readonly maxBytes = INTERVALS_MAX_BYTES,
  ) {}

  /** One step, in time order. Returns an error (and the backtest stops) or null. */
  step(ts: number, input: StepInput): string | null {
    this.steps++
    if ('error' in input) return `at ${new Date(ts).toISOString()}: ${input.error}`
    const r = evalAlertingRule(this.rule, this.compiled, this.alerts, input.series, ts, this.opts, input.presence)
    if (!r.ok) return `at ${new Date(ts).toISOString()}: ${r.error}`
    this.alerts = r.alerts
    for (const fp of new Set([...this.open.keys(), ...this.alerts.keys()])) {
      const a = this.alerts.get(fp)
      const state = a && a.state !== 'inactive' ? a.state : null
      const cur = this.open.get(fp)
      if (cur && cur.state === state) continue
      if (cur) {
        cur.endMs = ts
        cur.open = false
        this.open.delete(fp)
      }
      if (a && state) {
        this.bytes += intervalBytes(a.labels, a.annotations)
        if (this.bytes > this.maxBytes) return `the intervals would hold more than ${this.maxBytes} bytes (${this.intervals.length} so far): the backtest stopped at ${new Date(ts).toISOString()}. Narrow the range or the expression.`
        const next: BacktestInterval = { fingerprint: fp, labels: a.labels, state, startMs: ts, endMs: this.toMs, open: true, noData: isNoDataAlert(a), annotations: a.annotations }
        this.intervals.push(next)
        this.open.set(fp, next)
      }
    }
    return null
  }

  result(): Tracked {
    this.intervals.sort((a, b) => a.startMs - b.startMs || (a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0))
    return { ok: true, intervals: this.intervals, steps: this.steps }
  }
}

/** `IntervalTracker` over [fromMs, toMs] with every step's result from `step(ts)`, in one go. */
export function trackIntervals(rule: AlertingRuleV2, compiled: CompiledAlertRule, opts: AlertEvalOptions, fromMs: number, toMs: number, stepMs: number, step: (ts: number) => StepInput): Tracked | { ok: false; error: string } {
  const t = new IntervalTracker(rule, compiled, opts, toMs)
  for (let ts = fromMs; ts <= toMs; ts += stepMs) {
    const err = t.step(ts, step(ts))
    if (err !== null) return { ok: false, error: err }
  }
  return t.result()
}

export function resultOf(t: Tracked, fromMs: number, toMs: number, stepMs: number, resolution: BacktestResult['resolution']): BacktestResult {
  return { fromMs, toMs, stepMs, steps: t.steps, intervals: t.intervals, summary: summarize(t.intervals), resolution }
}

export function runBacktest(input: BacktestInput): { ok: true; result: BacktestResult } | { ok: false; error: string } {
  const { rule, compiled, fromMs, toMs, stepMs } = input
  const main = index(input.matrix)
  const presence = input.presence ? index(input.presence) : null
  const t = trackIntervals(rule, compiled, input.opts, fromMs, toMs, stepMs, (ts) => ({ series: seriesAt(main, ts), presence: presence ? seriesAt(presence, ts) : null }))
  if (!t.ok) return t
  return {
    ok: true,
    result: resultOf(t, fromMs, toMs, stepMs, { stepMs, liveIntervalMs: input.liveIntervalMs, edgeErrorMs: Math.max(stepMs, input.liveIntervalMs), note: resolutionNote(rule, stepMs, input.liveIntervalMs) }),
  }
}
