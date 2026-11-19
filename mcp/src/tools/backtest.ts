import { ArgError, CURSOR_ARG, type JsonSchema, MAX_TOKENS_ARG, TIME_ARG, isoOf, parseStep, parseTime } from '../args'
import type { BacktestAnswer, BacktestIntervalView, BacktestView, OverBudgetView } from '../clients'
import { budgetOf, type Item } from '../page'
import { durationSeconds } from '../promql'
import type { Session } from '../session'
import { type ToolDef, ToolError, pagedResult } from '../tool'
import { cell, clean, cleanLabels, MAX } from '../untrusted'
import { cursorOf } from './common'
import { needRuler } from './misc'

/**
 * backtest_monitor: "what would this monitor have done?", answered by the ruler's own
 * `POST /api/v1/monitors/backtest` (ruler README parts 4 and 12–14), which runs the monitor
 * through the evaluation a live monitor uses. This tool adds no evaluation of its own: it
 * checks the arguments, sends one request with the caller's credential, and renders the answer
 * or the refusal. Nothing is saved: the route is read-only (`monitors:read`) and takes no
 * `dryRun` because it never writes.
 */

/** Prometheus' range limit, which the ruler applies to backtests (ruler README part 4). */
export const MAX_BACKTEST_STEPS = 11_000
/** The ruler's default monitor interval (`DEFAULT_MONITOR_INTERVAL` in ruler/src/monitors.ts). */
export const DEFAULT_INTERVAL_MS = 60_000
/** Intervals rendered at most, firing first. The rest are counted in the answer, never dropped silently. */
export const MAX_LISTED_INTERVALS = 1_000
/**
 * The smallest max_tokens this tool takes (the generic floor is 200). The header (at most about
 * 1,000 characters), the cost footer, the cursor line and the resolution note (cut at
 * NOTE_CHARS) always fit whole in it, with room for the start of an interval.
 */
export const MIN_BACKTEST_TOKENS = 800
/** The ruler's resolution note in the text (its notes are under 600 characters; the structure keeps up to 2,000). */
const NOTE_CHARS = 600

type Kind = 'threshold' | 'anomaly' | 'slo'

// ---- the input schema: a monitor document as POST /api/v1/monitors takes it (ruler/openapi.json MonitorInput) ----

/** A duration in the ruler's own form (ruler/src/util.ts): units in this order, each at most once. */
const DURATION_PATTERN = '^(?:\\d+y)?(?:\\d+w)?(?:\\d+d)?(?:\\d+h)?(?:\\d+m)?(?:\\d+s)?(?:\\d+ms)?$'
const DUR = (description: string): JsonSchema => ({ type: 'string', minLength: 2, maxLength: 32, pattern: DURATION_PATTERN, description, examples: ['5m'] })
const TEXT = (maxLength: number, description?: string): JsonSchema => ({ type: 'string', maxLength, ...(description ? { description } : {}) })
const STRING_MAP = (description: string): JsonSchema => ({ type: 'object', additionalProperties: { type: 'string', maxLength: 4096 }, description })

export const MONITOR_ARG: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name'],
  description: 'The monitor exactly as for POST /api/v1/monitors (without dryRun): query + condition (threshold), expr (a PromQL comparison), query + anomaly, or slo (no query). Nothing is saved.',
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 256 },
    query: TEXT(16_000, 'PromQL: compared with condition, or scored by anomaly.'),
    condition: {
      type: 'object',
      additionalProperties: false,
      required: ['op', 'threshold'],
      description: 'Threshold monitor: fires while query op threshold holds (after "for").',
      properties: {
        op: { type: 'string', enum: ['>', '>=', '<', '<=', '==', '!='] },
        threshold: { type: 'number', description: 'In the unit the query returns: 1% is 0.01.' },
        unit: TEXT(32, 'Shown after numbers, e.g. "ms".'),
      },
    },
    expr: TEXT(16_384, 'Instead of query + condition: PromQL whose result series are the breaches.'),
    anomaly: {
      type: 'object',
      additionalProperties: false,
      description: 'Anomaly monitor: a detector scores query. Defaults: detector ewma (threshold when severity is page), severity ticket, maxSeries 100, for 0s, keepFiringFor 10m.',
      properties: {
        detector: { type: 'string', enum: ['ewma', 'threshold', 'robust_z', 'seasonal', 'cusum'] },
        params: { type: 'object', additionalProperties: { type: ['number', 'string', 'boolean', 'null'] }, description: 'The detector\'s parameters by name.' },
        unit: TEXT(32),
        severity: { type: 'string', enum: ['page', 'ticket', 'info'] },
        maxSeries: { type: 'integer', minimum: 1 },
      },
    },
    slo: {
      type: 'object',
      additionalProperties: false,
      required: ['objective', 'sli'],
      description: 'SLO monitor: multi-window burn-rate alerts over sli; no query or condition.',
      properties: {
        objective: { type: 'number', minimum: 0, maximum: 1, description: 'Good fraction, strictly between 0 and 1, e.g. 0.999.' },
        window: DUR('Compliance window; default 30d.'),
        sli: {
          type: 'object',
          additionalProperties: false,
          description: '{bad, total}, {good, total} or {errorRatio}: PromQL with $window, e.g. sum(increase(x_total{code=~"5.."}[$window])).',
          properties: { good: TEXT(16_000), bad: TEXT(16_000), total: TEXT(16_000), errorRatio: TEXT(16_000) },
        },
        alerts: {
          type: 'array',
          maxItems: 8,
          description: 'Default: page 1h/5m at 14.4 and 6h/30m at 6; ticket 1d/2h at 3 and 3d/6h at 1.',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['severity', 'longWindow', 'shortWindow', 'burnRate'],
            properties: { severity: { type: 'string', enum: ['page', 'ticket'] }, longWindow: DUR('Long window.'), shortWindow: DUR('Short window.'), burnRate: { type: 'number', minimum: 0 } },
          },
        },
        minEvents: { type: 'number', minimum: 0 },
        minCoverage: { type: 'number', minimum: 0, maximum: 1 },
        maxSeries: { type: 'integer', minimum: 1, maximum: 100 },
      },
    },
    for: DUR('How long a breach must hold before it fires.'),
    keepFiringFor: DUR('How long it keeps firing after the breach ends.'),
    interval: DUR('Evaluation interval; default 1m. Also the default step.'),
    noData: { type: 'string', enum: ['ok', 'alerting', 'keep'], description: 'When the query returns nothing: resolve (ok, default), fire after noDataFor (alerting), keep the state (keep).' },
    noDataFor: DUR('With noData "alerting".'),
    message: TEXT(4096, 'Notification template; the summary annotation.'),
    description: TEXT(4096),
    runbookUrl: TEXT(2048),
    labels: STRING_MAP('Labels added to its alerts.'),
    annotations: STRING_MAP('Annotations (templates) added to its alerts.'),
    notify: TEXT(256, 'A receiver from the notifier config; checked, nothing is sent.'),
    group: TEXT(256),
    owner: TEXT(256),
    startInvestigation: { type: 'boolean' },
  },
}

// ---- formatting (server-written numbers only) ----

/** Milliseconds as the shortest exact Prometheus duration, in the units and order the ruler parses. */
export function durText(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s'
  let rest = Math.round(ms)
  let out = ''
  for (const [u, size] of [['d', 86_400_000], ['h', 3_600_000], ['m', 60_000], ['s', 1000], ['ms', 1]] as const) {
    const q = Math.floor(rest / size)
    if (q > 0) {
      out += `${q}${u}`
      rest -= q * size
    }
  }
  return out
}

const grouped = (n: number): string => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')

export function bytesText(n: number): string {
  if (n < 1024) return `${grouped(n)} bytes`
  const [v, u] = n < 1 << 20 ? [n / 1024, 'KiB'] : n < 1 << 30 ? [n / (1 << 20), 'MiB'] : [n / (1 << 30), 'GiB']
  return `${Number(v.toPrecision(3))} ${u}`
}

const cpuText = (ms: number): string => (ms < 1000 ? `${Math.round(ms)} ms` : `${Number((ms / 1000).toPrecision(3))} s`)
const timesText = (r: number): string => `${Number(r.toPrecision(2))}×`
const iso = (ms: number): string => isoOf(ms / 1000)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** A range bound for a refusal's remedy: down to the hour past a day, to the minute past an hour, else to the second. */
function niceDown(ms: number): number {
  const unit = ms >= 86_400_000 ? 3_600_000 : ms >= 3_600_000 ? 60_000 : 1000
  return Math.floor(ms / unit) * unit
}

// ---- arguments ----

const kindOf = (m: Record<string, unknown>): Kind => (m.slo !== undefined ? 'slo' : m.anomaly !== undefined ? 'anomaly' : 'threshold')

function intervalOf(m: Record<string, unknown>): number {
  const ms = typeof m.interval === 'string' ? Math.round(durationSeconds(m.interval) * 1000) : 0
  return ms > 0 ? ms : DEFAULT_INTERVAL_MS
}

interface Range {
  fromMs: number
  toMs: number
  stepMs: number
  /** The monitor's interval, when the step had to be raised from it to fit 11,000 steps. */
  raisedFromMs: number | null
}

const badArg = (path: string, message: string, fix = 'Fix the argument and call again.') => new ToolError('invalid-arguments', `Argument ${path} ${message}.`, fix)

/** The absolute range: pinned by the cursor when continuing, else from the arguments and their defaults. */
function rangeFor(s: Session, args: Record<string, unknown>, pinned: Record<string, unknown> | undefined, kind: Kind, intervalMs: number): Range {
  if (pinned && [pinned.f, pinned.t, pinned.st].every((x) => typeof x === 'number')) {
    return { fromMs: pinned.f as number, toMs: pinned.t as number, stepMs: pinned.st as number, raisedFromMs: typeof pinned.r === 'number' ? pinned.r : null }
  }
  let start: number
  let end: number
  let stepS: number | null = null
  try {
    start = parseTime(args.start ?? 'now-24h', s.now, '/start')
    end = parseTime(args.end ?? 'now', s.now, '/end')
    if (args.step !== undefined) stepS = parseStep(args.step, '/step')
  } catch (e) {
    if (e instanceof ArgError) throw badArg(e.path, e.message, e.suggestion)
    throw e
  }
  const fromMs = Math.round(start * 1000)
  const toMs = Math.round(end * 1000)
  if (fromMs < 0) throw badArg('/start', 'is before 1970')
  if (toMs > s.now) throw badArg('/end', `is in the future (now is ${iso(s.now)})`, 'A backtest reads history: use "now" or an earlier time.')
  if (toMs <= fromMs) throw badArg('/end', 'must be after "start"')
  const what = kind === 'slo' ? 'an SLO' : 'an anomaly'
  let stepMs = intervalMs
  if (stepS !== null) {
    stepMs = Math.round(stepS * 1000)
    if (stepMs < 1000) throw badArg('/step', 'must be at least 1s')
    if (kind !== 'threshold' && stepMs !== intervalMs) {
      throw badArg('/step', `must be the monitor's interval (${durText(intervalMs)}) for ${what} monitor: its detector or windows count steps`, 'Leave "step" out, or set monitor.interval to the step you want (that is a different monitor).')
    }
  }
  const steps = Math.floor((toMs - fromMs) / stepMs) + 1
  if (steps <= MAX_BACKTEST_STEPS) return { fromMs, toMs, stepMs, raisedFromMs: null }
  const minStep = Math.ceil((toMs - fromMs) / (MAX_BACKTEST_STEPS - 1) / 1000) * 1000
  if (stepS !== null && kind === 'threshold') throw badArg('/step', `gives ${grouped(steps)} steps over this range; at most ${grouped(MAX_BACKTEST_STEPS)}`, `Use a step of at least ${durText(minStep)}, or a shorter range.`)
  if (kind !== 'threshold') {
    throw badArg('/start', `gives ${grouped(steps)} steps at the monitor's interval (${durText(intervalMs)}); at most ${grouped(MAX_BACKTEST_STEPS)}`, `Use a range of at most ${durText((MAX_BACKTEST_STEPS - 1) * intervalMs)}: ${what} monitor runs only at its interval.`)
  }
  return { fromMs, toMs, stepMs: minStep, raisedFromMs: intervalMs }
}

// ---- the ruler's answer ----

interface Interval extends BacktestIntervalView {
  /** Pending spans: what came next. */
  outcome?: 'fired' | 'cleared' | 'open'
}

/** Keep the intervals in the documented shape; count the rest (never dropped silently). */
function readIntervals(raw: unknown[]): { intervals: Interval[]; malformed: number } {
  const intervals: Interval[] = []
  let malformed = 0
  for (const x of raw) {
    if (!isObj(x) || (x.state !== 'pending' && x.state !== 'firing') || num(x.startMs) === null || num(x.endMs) === null) {
      malformed++
      continue
    }
    const strings = (v: unknown): Record<string, string> => (isObj(v) ? Object.fromEntries(Object.entries(v).map(([k, s]) => [k, String(s)])) : {})
    intervals.push({ fingerprint: String(x.fingerprint ?? ''), labels: strings(x.labels), state: x.state, startMs: x.startMs as number, endMs: x.endMs as number, open: x.open === true, noData: x.noData === true, annotations: strings(x.annotations) })
  }
  return { intervals, malformed }
}

/** The ruler's own summary formula (ruler/src/backtest.ts `summarize`), plus what an agent asks first. */
export function summarize(intervals: Interval[]) {
  const firing = intervals.filter((i) => i.state === 'firing')
  const pending = intervals.filter((i) => i.state === 'pending')
  const fired = new Set(firing.map((i) => `${i.fingerprint}@${i.startMs}`))
  for (const p of pending) p.outcome = p.open ? 'open' : fired.has(`${p.fingerprint}@${p.endMs}`) ? 'fired' : 'cleared'
  const lastFire = firing.reduce<Interval | null>((a, i) => (a === null || i.startMs >= a.startMs ? i : a), null)
  return {
    firingCount: firing.length,
    pendingCount: pending.length,
    clearedCount: pending.filter((p) => p.outcome === 'cleared').length,
    firingMs: firing.reduce((n, i) => n + (i.endMs - i.startMs), 0),
    longestFiringMs: firing.reduce((n, i) => Math.max(n, i.endMs - i.startMs), 0),
    firingAtEnd: firing.some((i) => i.open),
    series: new Set(intervals.map((i) => i.fingerprint)).size,
    firingSeries: new Set(firing.map((i) => i.fingerprint)).size,
    firstFiringMs: firing.length ? Math.min(...firing.map((i) => i.startMs)) : null,
    lastFiringMs: lastFire ? lastFire.startMs : null,
    lastResolvedMs: firing.length && !firing.some((i) => i.open) ? Math.max(...firing.map((i) => i.endMs)) : null,
  }
}

/** Annotations that explain an alert, the kind's own sentence first. `*_detail` (JSON numbers) and the runbook link are in the structured result only. */
function explanation(a: Record<string, string>): string {
  const order = ['anomaly', 'slo', 'summary', 'description']
  const keys = Object.keys(a).filter((k) => !/_detail$/.test(k) && k !== 'runbook_url').sort((x, y) => (order.indexOf(x) + 1 || 99) - (order.indexOf(y) + 1 || 99) || x.localeCompare(y))
  const seen = new Set<string>()
  const parts: string[] = []
  for (const k of keys) {
    if (seen.has(a[k]!)) continue
    seen.add(a[k]!)
    parts.push(`${cell(k, MAX.name)}: ${cell(a[k], MAX.text)}`)
  }
  return parts.join(' ; ')
}

function labelsText(labels: Record<string, string>): string {
  const body = Object.entries(labels)
    .filter(([k]) => k !== 'alertname')
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, v]) => `${cell(k, MAX.name)}=${JSON.stringify(cell(v))}`)
    .join(',')
  return `{${clean(body, { max: 400 })}}`
}

function itemOf(i: Interval, n: number): Item {
  const end = i.open ? 'end of range' : iso(i.endMs)
  const outcome = i.outcome === 'fired' ? ', then fired' : i.outcome === 'cleared' ? ', cleared without firing' : ''
  const still = i.open ? `, still ${i.state}` : ''
  // A pending span that went on to fire carries what its firing span shows: said once, on the firing span.
  const why = i.outcome === 'fired' ? '' : explanation(i.annotations ?? {})
  return {
    key: `i${n}`,
    text: `${i.state}${i.noData ? ' (no data)' : ''} ${iso(i.startMs)} → ${end} (${durText(i.endMs - i.startMs)}${still})${outcome} ${labelsText(i.labels)}${why ? ` | ${why}` : ''}\n`,
    data: {
      state: i.state,
      startMs: i.startMs,
      endMs: i.endMs,
      open: i.open,
      noData: i.noData === true,
      ...(i.outcome ? { outcome: i.outcome } : {}),
      fingerprint: clean(i.fingerprint, { max: 64 }),
      labels: cleanLabels(i.labels),
      annotations: Object.fromEntries(Object.entries(i.annotations ?? {}).map(([k, v]) => [clean(k, { max: MAX.name }), clean(v, { max: MAX.long })])),
    },
  }
}

type Cost = NonNullable<BacktestView['cost']>

function costOf(v: BacktestView): Cost | null {
  const c = v.cost
  if (!isObj(c) || num(c.scanSamples) === null || num(c.bytesToRead) === null || num(c.queries) === null) return null
  const out: Cost = { scanSamples: c.scanSamples, bytesToRead: c.bytesToRead, queries: c.queries, budget: { scanSamples: num(c.budget?.scanSamples) ?? NaN, bytesToRead: num(c.budget?.bytesToRead) ?? NaN } }
  if (isObj(c.memory) && num(c.memory.peakBytes) !== null && num(c.memory.budgetBytes) !== null) {
    out.memory = { peakBytes: c.memory.peakBytes, budgetBytes: c.memory.budgetBytes, windowSteps: Array.isArray(c.memory.windowSteps) ? c.memory.windowSteps.filter((x) => num(x) !== null) : [], queries: num(c.memory.queries) ?? 0 }
  }
  if (isObj(c.cpu) && num(c.cpu.modelledMs) !== null && num(c.cpu.budgetMs) !== null) out.cpu = { modelledMs: c.cpu.modelledMs, budgetMs: c.cpu.budgetMs }
  return out
}

function costLine(c: Cost | null): string {
  if (!c) return 'Cost: the ruler did not report it.\n'
  const budget = Number.isFinite(c.budget.scanSamples) ? ` (budget ${grouped(c.budget.scanSamples)} samples, ${bytesText(c.budget.bytesToRead)})` : ''
  return (
    `Cost (the ruler's plan and models, not measured): read ${grouped(c.scanSamples)} samples, ${bytesText(c.bytesToRead)} in ${grouped(c.queries)} range quer${c.queries === 1 ? 'y' : 'ies'}${budget}` +
    (c.memory ? `; memory peak ${bytesText(c.memory.peakBytes)} (budget ${bytesText(c.memory.budgetBytes)})` : '') +
    (c.cpu ? `; CPU ${cpuText(c.cpu.modelledMs)} (budget ${cpuText(c.cpu.budgetMs)})` : '') +
    '.\n'
  )
}

// ---- refusals, passed through as they are; never retried ----

type BudgetName = 'plan' | 'memory' | 'cpu' | 'unknown'
type Reason = 'plan-over' | 'engine-limit' | 'unpriced' | 'memory-state' | 'memory-windows' | 'cpu' | 'unknown'

/**
 * Which budget refused. The numbers decide where they can; where they cannot (both memory
 * refusals carry `plan: null`, as do the engine's own refusal and an unpriced read), the ruler's
 * wording does (ruler/src/history.ts). README "Contract issues": `over_budget` has no field naming it.
 */
export function whichBudget(ob: OverBudgetView, message: string): { budget: BudgetName; reason: Reason } {
  if (ob.cpu) return { budget: 'cpu', reason: 'cpu' }
  if (ob.plan && ob.budget && (ob.plan.scanSamples > ob.budget.scanSamples || ob.plan.bytesToRead > ob.budget.bytesToRead)) return { budget: 'plan', reason: 'plan-over' }
  if (ob.memory && ob.memory.peakBytes > ob.memory.budgetBytes) return { budget: 'memory', reason: 'memory-state' }
  if (/^over the memory budget/i.test(message)) return { budget: 'memory', reason: 'memory-windows' }
  if (/^over the CPU budget/i.test(message)) return { budget: 'cpu', reason: 'cpu' }
  if (/^the engine would refuse/i.test(message)) return { budget: 'plan', reason: 'engine-limit' }
  if (/^the engine's plan did not say/i.test(message)) return { budget: 'plan', reason: 'unpriced' }
  return { budget: 'unknown', reason: 'unknown' }
}

interface Ctx {
  kind: Kind
  range: Range
  monitor: Record<string, unknown>
}

const SAME = 'Calling again with the same arguments gets the same refusal: change them first.'

function overBudget(ob: OverBudgetView, rulerMessage: string, ctx: Ctx): ToolError {
  const { budget, reason } = whichBudget(ob, rulerMessage)
  const rangeMs = ctx.range.toMs - ctx.range.fromMs
  const stepMs = ctx.range.stepMs
  const stateful = ctx.kind !== 'threshold'
  const fewer = (ratio: number) => `narrow the query to about ${Math.max(1, Math.floor(100 / ratio))}% of its series or fewer (aggregate with sum by (…), or add label matchers)`
  const remedy: { maxRangeMs: number | null; minStepMs: number | null; seriesFraction: number | null } = { maxRangeMs: null, minStepMs: null, seriesFraction: null }
  const shorter = (ratio: number): string | null => {
    const max = niceDown(rangeMs / ratio)
    if (max < stepMs) return null
    remedy.maxRangeMs = max
    return `shorten the range to at most ${durText(max)} (it is ${durText(rangeMs)})`
  }
  let ratio: number | null = null
  let what: string
  let outcome = 'Nothing was fetched.'
  const remedies: (string | null)[] = []
  const notes: string[] = []
  switch (reason) {
    case 'plan-over': {
      const p = ob.plan!
      const b = ob.budget!
      ratio = Math.max(p.scanSamples / b.scanSamples, p.bytesToRead / b.bytesToRead)
      what = `the query service's plan of the read is ${grouped(p.scanSamples)} samples and ${bytesText(p.bytesToRead)} in ${grouped(p.queries)} range quer${p.queries === 1 ? 'y' : 'ies'}; the budget is ${grouped(b.scanSamples)} samples and ${bytesText(b.bytesToRead)}`
      remedies.push(shorter(ratio), fewer(ratio))
      remedy.seriesFraction = 1 / ratio
      notes.push('A coarser step does not reduce what is read.')
      break
    }
    case 'engine-limit':
      what = 'the query service would refuse the read under its own limits (its reason is below)'
      remedies.push('narrow the query (fewer series: aggregate, or add label matchers)', 'shorten the range')
      break
    case 'unpriced':
      what = 'the query service\'s plan did not say what the read costs, and the ruler does not read what it cannot price'
      break
    case 'memory-state': {
      const m = ob.memory!
      ratio = m.peakBytes / m.budgetBytes
      what = `its memory model puts this monitor's state and one step of its series at ${bytesText(m.peakBytes)}; the budget is ${bytesText(m.budgetBytes)}`
      remedies.push(`make the monitor hold fewer series: ${fewer(ratio)}`)
      if (stateful) remedies.push(`lower ${ctx.kind}.maxSeries (state is reserved for that many series, whatever the query returns)`)
      remedy.seriesFraction = 1 / ratio
      notes.push('A shorter range or a coarser step does not change this.')
      break
    }
    case 'memory-windows':
      what = `windows small enough for the ${ob.memory ? `${bytesText(ob.memory.budgetBytes)} ` : ''}memory budget would take more than 1,000 range queries`
      remedies.push('shorten the range', stateful ? null : 'use a coarser step', 'narrow the query to fewer series, so each window holds more steps')
      break
    case 'cpu': {
      outcome = 'It read the first window to count the series; nothing was kept.'
      const c = ob.cpu
      if (c) {
        ratio = c.modelledMs / c.budgetMs
        what = `its CPU model (modelled, not measured) puts the whole run at ${cpuText(c.modelledMs)}; the budget is ${cpuText(c.budgetMs)}`
        remedies.push(shorter(ratio))
        if (!stateful) {
          remedy.minStepMs = Math.ceil((stepMs * ratio) / 1000) * 1000
          remedies.push(`use a step of at least ${durText(remedy.minStepMs)} (it is ${durText(stepMs)})`)
        }
        remedies.push(fewer(ratio))
        remedy.seriesFraction = 1 / ratio
      } else {
        what = 'its CPU model puts the whole run over its budget'
        remedies.push('shorten the range', stateful ? null : 'use a coarser step', 'narrow the query to fewer series')
      }
      break
    }
    default:
      what = 'the ruler did not say which budget (its words are below)'
      outcome = 'Nothing was kept.'
      remedies.push('shorten the range', stateful ? null : 'use a coarser step', 'narrow the query to fewer series')
  }
  if (stateful && (reason === 'plan-over' || reason === 'cpu')) {
    notes.push(`The warm-up before "start" (the ${ctx.kind === 'slo' ? 'SLO\'s windows' : 'detector\'s look-back'}) is read and fed too, and a shorter range does not reduce it.`)
  }
  const list = remedies.filter((x): x is string => typeof x === 'string')
  const fix = list.length
    ? `${list.map((x, i) => (i === 0 ? x[0]!.toUpperCase() + x.slice(1) : x)).join(', or ')}.${notes.map((n) => ` ${n}`).join('')} ${SAME}`
    : 'Nothing in the arguments causes this: report the time of the call.'
  const label = budget === 'plan' ? 'read (plan)' : budget === 'memory' ? 'memory' : budget === 'cpu' ? 'CPU' : 'unnamed'
  return new ToolError('over-budget', `The ruler refused this backtest over its ${label} budget: ${what}${ratio !== null ? ` (${timesText(ratio)} over)` : ''}. ${outcome}`, fix, {
    status: 422,
    detail: `ruler: ${clean(rulerMessage, { max: MAX.long })}`,
    data: { message: clean(rulerMessage, { max: MAX.long }) },
    meta: { refusal: { budget, reason, over: ratio, plan: ob.plan, limits: ob.budget, memory: ob.memory, cpu: ob.cpu, remedy } },
  })
}

// The ruler reports problems found after planning the monitor in rule-file names (`rule.*`), not
// the monitor's own (README "Contract issues"). This maps them back to this tool's arguments.
const RULE_FIELDS: [RegExp, (m: RegExpExecArray, monitor: Record<string, unknown>) => string][] = [
  [/^expr$/, (_m, mon) => (mon.query !== undefined ? 'query' : 'expr')],
  [/^no_data_expr$/, () => 'query'],
  [/^alert$/, () => 'name'],
  [/^keep_firing_for$/, () => 'keepFiringFor'],
  [/^no_data_for$/, () => 'noDataFor'],
  [/^no_data$/, () => 'noData'],
  [/^annotations\.summary$/, () => 'message'],
  [/^annotations\.description$/, () => 'description'],
  [/^annotations\.runbook_url$/, () => 'runbookUrl'],
  [/^labels\.viz_receiver$/, () => 'notify'],
  [/^(anomaly|slo)\.max_series$/, (m) => `${m[1]}.maxSeries`],
  [/^slo\.min_events$/, () => 'slo.minEvents'],
  [/^slo\.min_coverage$/, () => 'slo.minCoverage'],
  [/^slo\.sli\.error_ratio$/, () => 'slo.sli.errorRatio'],
  [/^slo\.alerts\[(\d+)\]\.(long_window|short_window|burn_rate)$/, (m) => `slo.alerts[${m[1]}].${{ long_window: 'longWindow', short_window: 'shortWindow', burn_rate: 'burnRate' }[m[2] as 'long_window']}`],
]

const pointer = (dotted: string): string => '/' + dotted.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean).join('/')

/** Where a problem the ruler names is in this tool's arguments (a JSON Pointer). */
export function argumentOf(path: string, monitor: Record<string, unknown>): string {
  if (path === 'fromMs') return '/start'
  if (path === 'toMs') return '/end'
  if (path === 'step' || path === 'stepMs') return '/step'
  if (path === 'groups[0].interval' || path === 'interval') return '/monitor/interval'
  const m = /^monitor(?:\.(.*))?$/.exec(path)
  if (m) return m[1] ? '/monitor' + pointer(m[1]) : '/monitor'
  const r = /^rule(?:\.(.*))?$/.exec(path)
  if (r && r[1]) {
    for (const [re, to] of RULE_FIELDS) {
      const x = re.exec(r[1])
      if (x) return '/monitor' + pointer(to(x, monitor))
    }
    return '/monitor' + pointer(r[1])
  }
  return '/monitor'
}

function refusal(a: Extract<BacktestAnswer, { ok: false }>, ctx: Ctx, s: Session): ToolError {
  if (a.code === 'over_budget' && a.overBudget) return overBudget(a.overBudget, a.message, ctx)
  const detail = `ruler: ${clean(a.message, { max: MAX.long })}`
  const data = { message: clean(a.message, { max: MAX.long }) }
  if (a.problems && a.problems.length > 0) {
    const problems = a.problems.map((p) => ({ path: clean(p.path, { max: MAX.name }), argument: clean(argumentOf(p.path, ctx.monitor), { max: MAX.name }), message: clean(p.message, { max: MAX.error }), fix: clean(p.fix, { max: MAX.error }) }))
    return new ToolError('invalid-monitor', `The ruler found ${problems.length} problem(s) in the monitor or the range; nothing was run.`, 'Fix each field listed (the ruler\'s path, then the argument it is) and call again.', {
      status: 422,
      detail: problems.map((p) => `${p.path} (argument ${p.argument}): ${p.message} Fix: ${p.fix}`).join('\n'),
      data: { problems },
      meta: { problems: problems.length },
    })
  }
  if (a.code === 'timeout') {
    return new ToolError('ruler-timeout', `The ruler did not answer within ${Number((s.limits.backtestTimeoutMs / 1000).toPrecision(3))} s; any result it computes after that is lost.`, 'Shorten the range, use a coarser step (threshold monitors only) or narrow the query; nothing is cached, so the same call costs the same again.', { status: 504, detail, data })
  }
  if (a.code === 'too_large') return new ToolError('too-large', 'The ruler\'s answer is larger than this server reads.', 'Shorten the range or narrow the query (fewer series, so fewer intervals).', { status: 422, detail, data })
  if (a.status === 401) return new ToolError('ruler-refused', 'The ruler did not accept this key (HTTP 401).', 'Use a key that is enabled and not expired.', { status: 401, detail, data })
  if (a.status === 403) return new ToolError('ruler-refused', 'The ruler says this key may not backtest (HTTP 403): it needs monitors:read.', 'Use a key with monitors:read.', { status: 403, detail, data })
  if (a.status === 404) return new ToolError('not-available-yet', 'This deployment\'s ruler has no backtest route (HTTP 404).', 'Ask the operator to deploy a ruler with POST /api/v1/monitors/backtest.', { status: 501, detail, data })
  if (a.status === 502 && a.code === 'evaluation_failed') {
    return new ToolError('backtest-failed', 'The ruler could not evaluate the monitor over this range (HTTP 502); nothing was saved.', 'Read the reason below: a query error means the query must change; "the intervals would hold more than …" means a shorter range or a narrower query; an unavailable query service may answer later.', { status: 502, detail, data })
  }
  if (a.status === 503 || a.code === 'unavailable') {
    return new ToolError('ruler-unavailable', `The ruler is not available (HTTP ${a.status}); nothing was run.`, a.retryAfterSeconds ? `Try again after ${a.retryAfterSeconds} s.` : 'Try again later.', { status: 503, detail, data })
  }
  return new ToolError('ruler-failed', `The ruler did not answer the backtest (HTTP ${a.status}).`, 'Report the time of the call.', { status: 502, detail, data })
}

// ---- the tool ----

export const backtestMonitor: ToolDef = {
  name: 'backtest_monitor',
  title: 'Backtest a monitor',
  description:
    'Try a monitor over a past range before proposing it; nothing is saved or sent. The ruler runs it through the evaluation a live monitor uses. monitor is what you would POST to /api/v1/monitors: query + condition, expr, query + anomaly, or slo. Defaults: start now-24h, end now, step the monitor\'s interval (1m unless set; anomaly and SLO monitors run only at their interval). Returns a summary (fires, total firing time, first and last fire), then each firing and pending interval with its labels and the explanation its alert would have carried, then the cost. Refusals are final for those arguments: over-budget names the budget (plan, memory or cpu) with its numbers and what to change; invalid-monitor lists each field path.',
  scopes: ['monitors:read', 'read'],
  defaultTokens: 1500,
  readOnly: true,
  input: {
    type: 'object',
    additionalProperties: false,
    required: ['monitor'],
    properties: {
      monitor: MONITOR_ARG,
      start: TIME_ARG('Start of the past range', 'now-24h'),
      end: TIME_ARG('End of the range, not in the future', 'now'),
      step: { type: ['string', 'number'], maxLength: 32, description: 'Evaluation step: a duration ("1m") or seconds. Default: the monitor\'s interval. A threshold monitor whose range needs more than 11,000 steps at its interval gets the smallest step that fits, and the result says so.' },
      // At least MIN_BACKTEST_TOKENS: the summary, the note and the cost are always shown whole.
      max_tokens: { ...MAX_TOKENS_ARG(1500), minimum: MIN_BACKTEST_TOKENS },
      cursor: CURSOR_ARG,
    },
  },
  async run(s, args) {
    const c = cursorOf(this.name, args)
    const ruler = needRuler(s)
    const monitor = args.monitor as Record<string, unknown>
    const asked = kindOf(monitor)
    const range = rangeFor(s, args, c?.p, asked, intervalOf(monitor))
    // Exactly the monitor as given (the schema admits only its own fields), the range, the step: no tenant, no dryRun.
    const req = { monitor: { ...monitor }, fromMs: range.fromMs, toMs: range.toMs, step: durText(range.stepMs) }
    s.usage.upstreamCalls++
    const answer = await ruler.backtest(req, { signal: AbortSignal.timeout(s.limits.backtestTimeoutMs) })
    if (!answer.ok) throw refusal(answer, { kind: asked, range, monitor }, s)

    const v = answer.data
    if (!isObj(v) || !Array.isArray(v.intervals)) {
      throw new ToolError('ruler-failed', 'The ruler answered the backtest in a form this server does not read; nothing was saved.', 'Report the time of the call: the two releases disagree.', { status: 502 })
    }
    const kind: Kind = v.kind === 'anomaly' ? 'anomaly' : v.kind === 'slo' ? 'slo' : v.kind === 'alert' ? 'threshold' : asked
    const { intervals, malformed } = readIntervals(v.intervals)
    const sum = summarize(intervals)
    const order = (a: Interval, b: Interval) => a.startMs - b.startMs || (a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0)
    const sorted = [...intervals.filter((i) => i.state === 'firing').sort(order), ...intervals.filter((i) => i.state === 'pending').sort(order)]
    const listed = sorted.slice(0, MAX_LISTED_INTERVALS)
    const omitted = sorted.length - listed.length
    const omittedFiring = Math.max(0, sum.firingCount - listed.filter((i) => i.state === 'firing').length)
    const cost = costOf(v)
    if (cost) s.usage.queries += cost.memory?.queries || cost.queries
    const stepMs = num(v.stepMs) ?? range.stepMs
    const steps = num(v.steps) ?? Math.floor((range.toMs - range.fromMs) / stepMs) + 1
    const res = isObj(v.resolution) ? v.resolution : null
    const liveMs = num(res?.liveIntervalMs) ?? intervalOf(monitor)
    const edgeMs = num(res?.edgeErrorMs) ?? Math.max(stepMs, liveMs)
    const warmup = isObj(v.warmup) && num(v.warmup.points) !== null ? { reads: Array.isArray(v.warmup.reads) ? v.warmup.reads.length : 0, points: v.warmup.points as number } : null

    const kindWord = kind === 'slo' ? 'SLO' : kind
    const lines = [
      `backtest_monitor: ${kindWord} monitor over ${iso(range.fromMs)} → ${iso(range.toMs)} (${durText(range.toMs - range.fromMs)}), step ${durText(stepMs)}, ${grouped(steps)} steps. Nothing was saved or sent.`,
      range.raisedFromMs !== null ? `The step was raised from the monitor's interval (${durText(range.raisedFromMs)}) to ${durText(range.stepMs)}: the range needs more than ${grouped(MAX_BACKTEST_STEPS)} steps at the interval.` : '',
      sum.firingCount === 0
        ? `Would not have fired.${sum.pendingCount ? ` Pending ${grouped(sum.pendingCount)} time(s): ${grouped(sum.clearedCount)} cleared before firing${sum.pendingCount - sum.clearedCount ? `, ${grouped(sum.pendingCount - sum.clearedCount)} still pending at the end` : ''}.` : ' Never pending either.'}`
        : `Would have fired ${grouped(sum.firingCount)} time(s) on ${grouped(sum.firingSeries)} series, firing ${durText(sum.firingMs)} in total (longest ${durText(sum.longestFiringMs)}); first fire ${iso(sum.firstFiringMs!)}, last fire ${iso(sum.lastFiringMs!)}${sum.firingAtEnd ? ', still firing at the end' : `, last resolved ${iso(sum.lastResolvedMs!)}`}. ${grouped(sum.clearedCount)} pending span(s) cleared without firing.`,
      `Edges are within ${durText(edgeMs)} of where live evaluation (every ${durText(liveMs)}) would put them; the ruler's note on resolution opens the data block.`,
      warmup ? `Warm-up: ${grouped(warmup.points)} point(s) before the start fed through the ${kind === 'slo' ? 'burn-rate windows' : 'detector'} without alerts, as for a new monitor.` : '',
      malformed ? `${grouped(malformed)} interval(s) in a form this server does not read are left out of the list and the counts.` : '',
      sorted.length === 0
        ? 'No intervals.'
        : `Intervals: ${grouped(sorted.length)}, firing first, each with the annotations its alert carried on entering the state${omitted ? `; the first ${grouped(listed.length)} are listed, ${grouped(omitted)} more (${grouped(omittedFiring)} firing, ${grouped(omitted - omittedFiring)} pending) are only counted above` : ''}.`,
    ]
    return pagedResult({
      tool: this.name,
      s,
      args,
      maxTokens: Math.max(MIN_BACKTEST_TOKENS, budgetOf(args.max_tokens, this.defaultTokens)),
      header: lines.filter(Boolean).join('\n') + '\n',
      items: listed.map(itemOf),
      offset: c?.o ?? 0,
      pinned: { f: range.fromMs, t: range.toMs, st: range.stepMs, ...(range.raisedFromMs !== null ? { r: range.raisedFromMs } : {}) },
      prelude: c ? '' : `resolution: ${clean(typeof res?.note === 'string' ? res.note : '-', { max: NOTE_CHARS })}\n`,
      footer: ({ next }) => (next !== null ? 'Each further page runs the backtest again, at the cost below.\n' : '') + costLine(cost),
      meta: {
        kind,
        summary: { firingCount: sum.firingCount, pendingCount: sum.pendingCount, clearedCount: sum.clearedCount, firingMs: sum.firingMs, longestFiringMs: sum.longestFiringMs, firingAtEnd: sum.firingAtEnd, series: sum.series, firingSeries: sum.firingSeries, firstFiringMs: sum.firstFiringMs, lastFiringMs: sum.lastFiringMs, lastResolvedMs: sum.lastResolvedMs },
        range: { fromMs: range.fromMs, toMs: range.toMs, stepMs, steps, stepRaisedFromMs: range.raisedFromMs },
        resolution: { stepMs, liveIntervalMs: liveMs, edgeErrorMs: edgeMs },
        warmup,
        intervals: { total: sorted.length, listed: listed.length, omitted, omittedFiring, malformed },
        cost,
      },
      data: { resolutionNote: clean(typeof res?.note === 'string' ? res.note : '', { max: MAX.long }) },
    })
  },
}
