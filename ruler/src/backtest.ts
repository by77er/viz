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

export function runBacktest(input: BacktestInput): { ok: true; result: BacktestResult } | { ok: false; error: string } {
  const { rule, compiled, fromMs, toMs, stepMs } = input
  const main = index(input.matrix)
  const presence = input.presence ? index(input.presence) : null
  let alerts: ReadonlyMap<string, Alert> = new Map()
  const open = new Map<string, BacktestInterval>()
  const intervals: BacktestInterval[] = []
  let steps = 0
  for (let ts = fromMs; ts <= toMs; ts += stepMs) {
    steps++
    const r = evalAlertingRule(rule, compiled, alerts, seriesAt(main, ts), ts, input.opts, presence ? seriesAt(presence, ts) : null)
    if (!r.ok) return { ok: false, error: `at ${new Date(ts).toISOString()}: ${r.error}` }
    alerts = r.alerts
    for (const fp of new Set([...open.keys(), ...alerts.keys()])) {
      const a = alerts.get(fp)
      const state = a && a.state !== 'inactive' ? a.state : null
      const cur = open.get(fp)
      if (cur && cur.state === state) continue
      if (cur) {
        cur.endMs = ts
        cur.open = false
        open.delete(fp)
      }
      if (a && state) {
        const next: BacktestInterval = { fingerprint: fp, labels: a.labels, state, startMs: ts, endMs: toMs, open: true, noData: isNoDataAlert(a) }
        intervals.push(next)
        open.set(fp, next)
      }
    }
  }
  intervals.sort((a, b) => a.startMs - b.startMs || (a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0))
  return {
    ok: true,
    result: {
      fromMs,
      toMs,
      stepMs,
      steps,
      intervals,
      summary: summarize(intervals),
      resolution: { stepMs, liveIntervalMs: input.liveIntervalMs, edgeErrorMs: Math.max(stepMs, input.liveIntervalMs), note: resolutionNote(rule, stepMs, input.liveIntervalMs) },
    },
  }
}
