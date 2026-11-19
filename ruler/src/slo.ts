/**
 * SLO burn-rate rules (contract version 4, `contracts/rules.ts` "SLO burn-rate rules"): parsing
 * and defaults, the bucket rings an SLO keeps per series, one evaluation, and the stored form.
 * Pure: no storage, no I/O, no clock. `ruler.ts` owns the transaction and the schedule.
 *
 * One tick of one SLO rule:
 *
 *   ONE expression (good or bad, and total, over the last interval; `SLO_PART_LABEL` tells
 *   them apart) ──► per series, one bucket (bad events, all events) into a ring that holds the
 *   longest alert window, and into a coarser ring that holds the compliance window
 *        ──► window sums ──► `evaluateWindows` from `anomaly/` (the SRE Workbook's
 *            multi-window rule: both windows strictly above the burn rate)
 *        ──► per series and severity, a flagged series with the sentence and its numbers
 *        ──► `evalAlertingRule`, the alert state machine every alerting rule uses
 *
 * The arithmetic, the default alerts and the first half of the sentence are the library's
 * (`evaluateWindows`, `explainRule`, `SRE_WORKBOOK_RULES`), imported, not copied. The rings are
 * the ruler's: the library's incremental detector keeps one ring in a JSON state that it copies
 * on every point, which is too heavy for state written every tick and for backtests (README,
 * "SLO rules"). Window sums are computed in a fixed order from the ring's contents alone (whole
 * blocks of `FINE_BLOCK` buckets from a cache, the ends bucket by bucket), so the same buckets
 * give the same sums whichever way they arrived: live, after an eviction, in a warm-up or in a
 * backtest.
 */
import { duration, evaluateWindows, explainRule, fmt, SRE_WORKBOOK_RULES, type BurnRule, type RuleResult, type WindowAggregate } from '../../anomaly/src/index.ts'
import {
  SLO_ANNOTATION,
  SLO_DETAIL_ANNOTATION,
  SLO_PART_LABEL,
  type CostClass,
  type RulerConfig,
  type SloBurnAlert,
  type SloDetail,
  type SloHistory,
  type SloRuleStatus,
  type SloRuleV2,
  type SloSeverity,
  type SloSli,
  type SloSpec,
  type ValidationError,
} from '../contracts-proposal/rules.v2'
import type { ParseContext } from './anomaly'
import { classify, PromqlTextError } from './classify'
import type { Series } from './statemachine'
import { byteLength, fingerprint, formatDuration, parseDuration, type Labels } from './util'

// ───────────────────────────── constants ─────────────────────────────

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

/** Written in each SLI expression; replaced by the bucket width. */
export const WINDOW_TOKEN = '$window'
export const SLO_DEFAULTS = { windowMs: 30 * DAY, minEvents: 0, minCoverage: 0.9, maxSeries: 10 } as const
export const SLO_LIMIT_DEFAULTS = { maxSloSeriesPerRule: 100 } as const
/** The compliance window is kept in at most about this many coarse buckets (30 days: 1 h each). */
export const BUDGET_BUCKETS = 720
/** Buckets per stored row of the fine ring (1 h at a 1-minute interval) and of the coarse ring (1 day at 1 h). */
export const FINE_BLOCK = 60
export const COARSE_BLOCK = 24
/** The library's `MAX_RING`: the most buckets the longest window may need. */
export const MAX_SLO_RING = 100_000
export const MAX_SLO_ALERTS = 8
/** The stored row format (`slo_state.body`), pinned by `test/golden/formats/store.slo-state.v1.json`. */
export const SLO_STATE_VERSION = 1

const SEVERITIES: SloSeverity[] = ['page', 'ticket']
const FIELDS = ['objective', 'window', 'sli', 'alerts', 'min_events', 'min_coverage', 'max_series', 'given']
const ALERT_FIELDS = ['severity', 'long_window', 'short_window', 'burn_rate']

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export function sloLimits(cfg: Pick<RulerConfig, 'limits'>): { maxSloSeriesPerRule: number } {
  return { maxSloSeriesPerRule: cfg.limits.maxSloSeriesPerRule ?? SLO_LIMIT_DEFAULTS.maxSloSeriesPerRule }
}

/** The SRE Workbook's alerts as the library defines them (`SRE_WORKBOOK_RULES`), in the contract's shape. */
export const DEFAULT_SLO_ALERTS: SloBurnAlert[] = SRE_WORKBOOK_RULES.map((r) => ({ severity: r.severity, longMs: r.longMs, shortMs: r.shortMs, burnRate: r.burnRate }))

// ───────────────────────────── shape of the state ─────────────────────────────

/** Buckets of one series in the fine ring: one per interval. */
export const fineSlots = (alerts: SloBurnAlert[], intervalMs: number): number[] => {
  const set = new Set<number>()
  for (const a of alerts) for (const ms of [a.longMs, a.shortMs]) set.add(Math.max(1, Math.round(ms / intervalMs)))
  return [...set].sort((a, b) => a - b)
}

/** The ring sizes and the coarse bucket width of a rule at an interval. */
export function sloGeometry(spec: Pick<SloSpec, 'alerts' | 'windowMs'>, intervalMs: number): { fineSize: number; coarseMs: number; coarseBuckets: number; coarseSize: number; windows: number[] } {
  const windows = fineSlots(spec.alerts, intervalMs)
  const longest = windows[windows.length - 1] ?? 1
  const fineSize = Math.ceil(longest / FINE_BLOCK) * FINE_BLOCK
  const coarseMs = intervalMs * Math.max(1, Math.ceil(spec.windowMs / BUDGET_BUCKETS / intervalMs))
  const coarseBuckets = Math.max(1, Math.ceil(spec.windowMs / coarseMs))
  const coarseSize = Math.ceil(coarseBuckets / COARSE_BLOCK) * COARSE_BLOCK
  return { fineSize, coarseMs, coarseBuckets, coarseSize, windows }
}

/** Rough stored size of one series' state (both rings as JSON, plus labels and the last outcome). */
export function estimateSloStateBytes(spec: Pick<SloSpec, 'alerts' | 'windowMs'>, intervalMs: number): number {
  const g = sloGeometry(spec, intervalMs)
  return 1500 + 30 * (g.fineSize + g.coarseSize)
}

// ───────────────────────────── parsing ─────────────────────────────

/** The per-tick expression: both parts of the SLI over one bucket of `windowText`, in one expression. */
export function sloExpr(sli: SloSli, windowText: string): string {
  const w = (e: string | null) => (e ?? '').split(WINDOW_TOKEN).join(windowText)
  const part = (e: string | null, name: string) => `label_replace(${w(e)}, "${SLO_PART_LABEL}", "${name}", "", "")`
  switch (sli.kind) {
    case 'error_ratio':
      return w(sli.errorRatio)
    case 'good_total':
      return `${part(sli.total, 'total')} or ${part(sli.good, 'good')}`
    case 'bad_total':
      return `${part(sli.total, 'total')} or ${part(sli.bad, 'bad')}`
  }
}

/** The per-tick expression with `$window` set to another bucket width (the coarse one, to read the compliance window). */
export function coarseExprOf(sli: SloSli, bucketMs: number): string {
  return sloExpr(sli, formatDuration(bucketMs))
}

/** The SLI expressions of a rule-file `slo` block that is shaped right, with their paths, for save-time validation. */
export function sliExpressions(v: unknown): { field: string; text: string }[] {
  if (!isObject(v) || !isObject(v.sli)) return []
  const out: { field: string; text: string }[] = []
  for (const k of ['good', 'bad', 'total', 'error_ratio']) {
    const t = v.sli[k]
    if (typeof t === 'string' && t.trim() !== '') out.push({ field: `slo.sli.${k}`, text: t.split(WINDOW_TOKEN).join('1m') })
  }
  return out
}

/** What identifies an SLO rule's state: anything that changes how buckets are judged is a new rule. */
export function sloKeyText(spec: Pick<SloSpec, 'objective' | 'windowMs' | 'sli' | 'alerts' | 'minEvents' | 'minCoverage'>): string {
  return JSON.stringify({ o: spec.objective, w: spec.windowMs, s: spec.sli, a: spec.alerts.map((a) => [a.severity, a.longMs, a.shortMs, a.burnRate]), e: spec.minEvents, c: spec.minCoverage })
}

const classOf = (ms: number, cfg: Pick<RulerConfig, 'hotWindowMs' | 'recentWindowMs'>): CostClass => (ms <= cfg.hotWindowMs ? 'tail' : ms <= cfg.recentWindowMs ? 'recent' : 'rollup')

export function sloHistory(spec: Pick<SloSpec, 'alerts' | 'windowMs'>, intervalMs: number, tickClass: CostClass, cfg: Pick<RulerConfig, 'hotWindowMs' | 'recentWindowMs'>): SloHistory {
  const g = sloGeometry(spec, intervalMs)
  const lookbackMs = g.fineSize * intervalMs
  const coldStart = classOf(Math.max(lookbackMs, spec.windowMs), cfg)
  return {
    tick: tickClass,
    coldStart,
    lookbackMs,
    bucketMs: intervalMs,
    budgetLookbackMs: g.coarseBuckets * g.coarseMs,
    budgetBucketMs: g.coarseMs,
    reason:
      `Reads one ${formatDuration(intervalMs)} bucket per tick (${tickClass}); the alert windows are kept as ${g.fineSize} buckets of ${formatDuration(intervalMs)} ` +
      `and the ${formatDuration(spec.windowMs)} compliance window as ${g.coarseBuckets} buckets of ${formatDuration(g.coarseMs)}; ` +
      `warming a new rule reads ${formatDuration(lookbackMs)} at ${formatDuration(intervalMs)} and ${formatDuration(g.coarseBuckets * g.coarseMs)} at ${formatDuration(g.coarseMs)} (${coldStart}).`,
  }
}

/**
 * The `slo` block of a rule-file entry, at `path`. Returns the normalized spec and the per-tick
 * expression, or null after reporting what is wrong. `labels` are the rule's labels.
 */
export function parseSloSpec(c: ParseContext, v: unknown, path: string, intervalMs: number, labels: Labels, cfg: RulerConfig): { spec: SloSpec; expr: string; tickCost: ReturnType<typeof classify> } | null {
  const errors: ValidationError[] = []
  const err = (p: string, message: string, fix: string) => errors.push({ path: p, message, fix })
  if (!isObject(v)) {
    c.err(path, 'slo must be an object', 'Give { "objective": 0.999, "sli": { "bad": "...", "total": "..." } }.')
    return null
  }
  for (const k of Object.keys(v)) if (!FIELDS.includes(k)) err(`${path}.${k}`, `unknown field "${k}"`, `An slo block has: ${FIELDS.filter((f) => f !== 'given').join(', ')}.`)
  // The fields the author gave. A file the ruler exported writes every field out and says in `given` which were chosen.
  let given: string[] = FIELDS.filter((f) => f !== 'given' && v[f] !== undefined)

  // objective
  let objective = 0
  if (typeof v.objective !== 'number' || !Number.isFinite(v.objective) || !(v.objective > 0 && v.objective < 1)) {
    const o = v.objective
    const pct = typeof o === 'number' && o >= 1 && o < 100
    err(`${path}.objective`, 'objective must be a fraction between 0 and 1 (exclusive)', pct ? `Write ${o}% as ${Number(((o as number) / 100).toPrecision(12))}.` : 'Give the target fraction of good events, e.g. 0.999.')
  } else objective = v.objective

  // compliance window
  let windowMs: number = SLO_DEFAULTS.windowMs
  if (v.window !== undefined) {
    const ms = typeof v.window === 'string' ? parseDuration(v.window) : null
    if (ms === null || ms <= 0) err(`${path}.window`, 'window must be a duration, e.g. "30d"', 'Give the compliance window: "28d" or "30d" are usual.')
    else windowMs = ms
  }
  if (windowMs < 2 * intervalMs) err(`${path}.window`, `the window ${formatDuration(windowMs)} is shorter than two evaluations at ${formatDuration(intervalMs)}`, 'Lengthen the window or shorten the group interval.')

  // SLI
  let sli: SloSli | null = null
  if (!isObject(v.sli)) err(`${path}.sli`, 'sli is required', 'Give { "bad": "...", "total": "..." }, { "good": "...", "total": "..." } or { "error_ratio": "..." }, each with $window, e.g. sum(increase(http_requests_total{code=~"5.."}[$window])).')
  else {
    const s = v.sli
    for (const k of Object.keys(s)) if (!['good', 'bad', 'total', 'error_ratio'].includes(k)) err(`${path}.sli.${k}`, `unknown field "${k}"`, 'An sli has good and total, bad and total, or error_ratio.')
    const kind = s.error_ratio !== undefined ? 'error_ratio' : s.good !== undefined ? 'good_total' : s.bad !== undefined ? 'bad_total' : null
    const want = kind === 'error_ratio' ? ['error_ratio'] : kind === 'good_total' ? ['good', 'total'] : kind === 'bad_total' ? ['bad', 'total'] : []
    if (kind === null) err(`${path}.sli`, 'sli needs good and total, bad and total, or error_ratio', 'Prefer bad and total: a missing bad series then means no errors.')
    const present = ['good', 'bad', 'total', 'error_ratio'].filter((k) => s[k] !== undefined)
    if (kind !== null && (present.length !== want.length || !want.every((k) => present.includes(k)))) {
      err(`${path}.sli`, `give exactly ${want.join(' and ')} (found ${present.join(', ')})`, 'Use one form: { good, total }, { bad, total } or { error_ratio }.')
    }
    for (const k of want) {
      const t = s[k]
      const p = `${path}.sli.${k}`
      if (typeof t !== 'string' || t.trim() === '') {
        err(p, `${k} must be a PromQL expression`, 'Write it with $window, e.g. sum(increase(http_requests_total[$window])).')
        continue
      }
      if (byteLength(t) > 16_384) err(p, `${k} is longer than 16384 bytes`, 'Shorten the expression.')
      if (!t.includes(WINDOW_TOKEN)) err(p, `${k} must read one bucket: write its range as [${WINDOW_TOKEN}]`, `The ruler replaces ${WINDOW_TOKEN} with the group interval each tick, e.g. sum(increase(http_requests_total[${WINDOW_TOKEN}])).`)
      if (t.includes(SLO_PART_LABEL)) err(p, `${SLO_PART_LABEL} is reserved`, 'Remove the label from the expression.')
      try {
        classify(t.split(WINDOW_TOKEN).join(formatDuration(intervalMs)), { hotWindowMs: cfg.hotWindowMs, recentWindowMs: cfg.recentWindowMs, lookbackMs: cfg.lookbackMs })
      } catch (e) {
        if (e instanceof PromqlTextError) err(p, e.message, e.fix)
        else throw e
      }
    }
    if (kind !== null && errors.length === 0) {
      const str = (k: string) => (typeof s[k] === 'string' ? (s[k] as string) : null)
      sli = { kind, good: kind === 'good_total' ? str('good') : null, bad: kind === 'bad_total' ? str('bad') : null, total: kind === 'error_ratio' ? null : str('total'), errorRatio: kind === 'error_ratio' ? str('error_ratio') : null }
    }
  }

  // alerts
  let alerts: SloBurnAlert[] = DEFAULT_SLO_ALERTS.map((a) => ({ ...a }))
  if (v.alerts !== undefined) {
    if (!Array.isArray(v.alerts) || v.alerts.length === 0 || v.alerts.length > MAX_SLO_ALERTS) err(`${path}.alerts`, `alerts must be a list of 1 to ${MAX_SLO_ALERTS} burn-rate alerts`, 'Leave it out for the SRE Workbook\'s four.')
    else {
      alerts = []
      v.alerts.forEach((a: unknown, i: number) => {
        const p = `${path}.alerts[${i}]`
        if (!isObject(a)) return err(p, 'an alert is { severity, long_window, short_window, burn_rate }', 'e.g. { "severity": "page", "long_window": "1h", "short_window": "5m", "burn_rate": 14.4 }.')
        for (const k of Object.keys(a)) if (!ALERT_FIELDS.includes(k)) err(`${p}.${k}`, `unknown field "${k}"`, `An alert has: ${ALERT_FIELDS.join(', ')}.`)
        const severity = a.severity
        if (typeof severity !== 'string' || !SEVERITIES.includes(severity as SloSeverity)) err(`${p}.severity`, 'severity must be page or ticket', 'Page for fast burns, ticket for slow ones.')
        const longMs = typeof a.long_window === 'string' ? parseDuration(a.long_window) : null
        const shortMs = typeof a.short_window === 'string' ? parseDuration(a.short_window) : null
        if (longMs === null || longMs <= 0) err(`${p}.long_window`, 'long_window must be a duration', 'e.g. "1h".')
        if (shortMs === null || shortMs <= 0) err(`${p}.short_window`, 'short_window must be a duration', 'e.g. "5m" (the workbook uses 1/12 of the long window).')
        const burn = a.burn_rate
        if (typeof burn !== 'number' || !Number.isFinite(burn) || burn <= 0) err(`${p}.burn_rate`, 'burn_rate must be a positive number', 'e.g. 14.4: the rate that spends 2% of a 30-day budget in an hour.')
        if (longMs !== null && shortMs !== null && longMs > 0 && shortMs > 0) {
          if (shortMs >= longMs) err(`${p}.short_window`, 'short_window must be shorter than long_window', 'The workbook uses 1/12 of the long window.')
          if (shortMs < intervalMs) err(`${p}.short_window`, `short_window ${formatDuration(shortMs)} is shorter than the interval ${formatDuration(intervalMs)}`, 'Lengthen the window or shorten the group interval.')
          if (longMs > windowMs) err(`${p}.long_window`, `long_window ${formatDuration(longMs)} is longer than the compliance window ${formatDuration(windowMs)}`, 'Shorten the alert window.')
        }
        if (typeof severity === 'string' && SEVERITIES.includes(severity as SloSeverity) && longMs && shortMs && typeof burn === 'number' && burn > 0) {
          alerts.push({ severity: severity as SloSeverity, longMs, shortMs, burnRate: burn })
        }
      })
    }
  }
  for (const [i, a] of alerts.entries()) {
    const p = v.alerts === undefined ? `${path}.alerts` : `${path}.alerts[${i}]`
    if (a.longMs % intervalMs !== 0 || a.shortMs % intervalMs !== 0) {
      c.warn(p, `the ${formatDuration(a.longMs)} / ${formatDuration(a.shortMs)} windows are not whole numbers of ${formatDuration(intervalMs)} buckets; each is rounded to the nearest`, 'Use an interval that divides both windows.')
    }
    if (objective > 0 && a.burnRate * (1 - objective) >= 1) {
      c.warn(p, `at objective ${objective}, a burn rate of ${a.burnRate}× needs an error ratio above ${fmt(a.burnRate * (1 - objective))}, which cannot happen: this alert never fires`, 'Lower the burn rate, or raise the objective.')
    }
  }

  const num = (k: string, def: number, lo: number, hi: number, fix: string): number => {
    const x = v[k]
    if (x === undefined) return def
    if (typeof x !== 'number' || !Number.isFinite(x) || x < lo || x > hi) {
      err(`${path}.${k}`, `${k} must be a number from ${lo} to ${hi}`, fix)
      return def
    }
    return x
  }
  const minEvents = num('min_events', SLO_DEFAULTS.minEvents, 0, Number.MAX_SAFE_INTEGER, 'Give the events a long window must hold before its alert may fire, e.g. 100 for a low-traffic service.')
  const minCoverage = num('min_coverage', SLO_DEFAULTS.minCoverage, 0, 1, 'Give a fraction, e.g. 0.9: a window counts once 90% of its buckets have data.')
  const limits = sloLimits(cfg)
  let maxSeries: number = SLO_DEFAULTS.maxSeries
  if (v.max_series !== undefined) {
    if (typeof v.max_series !== 'number' || !Number.isInteger(v.max_series) || v.max_series < 1) err(`${path}.max_series`, 'max_series must be a whole number of at least 1', `Use at most ${limits.maxSloSeriesPerRule}.`)
    else if (v.max_series > limits.maxSloSeriesPerRule) err(`${path}.max_series`, `max_series ${v.max_series} is above this ruler's limit of ${limits.maxSloSeriesPerRule}`, 'Aggregate the SLI (sum by fewer labels), or split it over several rules.')
    else maxSeries = v.max_series
  }
  if (v.given !== undefined) {
    if (!Array.isArray(v.given) || v.given.some((g) => typeof g !== 'string' || !FIELDS.includes(g))) err(`${path}.given`, 'given must list slo fields', 'Leave it out; the ruler writes it.')
    else given = [...new Set(v.given as string[])]
  }
  given.sort()
  if (labels.severity !== undefined) err(`${path.replace(/\.slo$/, '')}.labels.severity`, 'an SLO rule sets severity itself: page or ticket, from the burn-rate alert that fires', 'Remove the severity label; route on severity="page" and severity="ticket".')

  const g = errors.length === 0 && sli !== null ? sloGeometry({ alerts, windowMs }, intervalMs) : null
  if (g && g.windows[g.windows.length - 1]! > MAX_SLO_RING) {
    err(`${path}.alerts`, `the longest window needs ${g.windows[g.windows.length - 1]} buckets at a ${formatDuration(intervalMs)} interval; at most ${MAX_SLO_RING}`, 'Use a longer group interval for long windows.')
  }
  if (errors.length > 0 || sli === null || g === null) {
    for (const e of errors) c.err(e.path, e.message, e.fix)
    return null
  }
  const expr = sloExpr(sli, formatDuration(intervalMs))
  const tickCost = classify(expr, { hotWindowMs: cfg.hotWindowMs, recentWindowMs: cfg.recentWindowMs, lookbackMs: cfg.lookbackMs })
  const history = sloHistory({ alerts, windowMs }, intervalMs, tickCost.class, cfg)
  const spec: SloSpec = { objective, windowMs, sli, alerts, minEvents, minCoverage, maxSeries, given, history, stateBytesPerSeries: estimateSloStateBytes({ alerts, windowMs }, intervalMs) }
  return { spec, expr, tickCost }
}

// ───────────────────────────── the ring ─────────────────────────────

/**
 * Buckets of one series: slot s (an absolute bucket number) at index s mod size, NaN = missing.
 * `size` is a multiple of `block`, so the slots of one absolute block share one block position,
 * whose sums are cached until a bucket in it changes.
 */
export class Ring {
  readonly bad: Float64Array
  readonly tot: Float64Array
  private readonly cBad: Float64Array
  private readonly cTot: Float64Array
  private readonly cN: Int32Array
  private readonly cOk: Uint8Array

  constructor(readonly size: number, readonly block: number, from?: Ring) {
    const blocks = size / block
    this.bad = from ? from.bad.slice() : new Float64Array(size).fill(NaN)
    this.tot = from ? from.tot.slice() : new Float64Array(size).fill(NaN)
    this.cBad = from ? from.cBad.slice() : new Float64Array(blocks)
    this.cTot = from ? from.cTot.slice() : new Float64Array(blocks)
    this.cN = from ? from.cN.slice() : new Int32Array(blocks)
    this.cOk = from ? from.cOk.slice() : new Uint8Array(blocks)
  }

  clone(): Ring {
    return new Ring(this.size, this.block, this)
  }

  private idx(slot: number): number {
    return ((slot % this.size) + this.size) % this.size
  }

  set(slot: number, b: number, t: number): void {
    const i = this.idx(slot)
    this.bad[i] = b
    this.tot[i] = t
    this.cOk[Math.floor(i / this.block)] = 0
  }

  /** Add to a bucket (NaN + x = x): the coarse ring accumulates fine buckets. */
  add(slot: number, b: number, t: number): void {
    const i = this.idx(slot)
    const cb = this.bad[i]!
    if (cb === cb) {
      this.bad[i] = cb + b
      this.tot[i] = this.tot[i]! + t
    } else {
      this.bad[i] = b
      this.tot[i] = t
    }
    this.cOk[Math.floor(i / this.block)] = 0
  }

  get(slot: number): [number, number] {
    const i = this.idx(slot)
    return [this.bad[i]!, this.tot[i]!]
  }

  /** The ring moves from holding (prev - size, prev] to (to - size, to]: the slots in between become missing. */
  advance(prev: number | null, to: number): void {
    if (prev === null || to - prev >= this.size) {
      this.bad.fill(NaN)
      this.tot.fill(NaN)
      this.cOk.fill(0)
      return
    }
    for (let s = prev + 1; s <= to; s++) this.set(s, NaN, NaN)
  }

  private blockSums(pos: number): void {
    if (this.cOk[pos]) return
    let sb = 0
    let st = 0
    let n = 0
    for (let i = pos * this.block, end = i + this.block; i < end; i++) {
      const b = this.bad[i]!
      if (b === b) {
        sb += b
        st += this.tot[i]!
        n++
      }
    }
    this.cBad[pos] = sb
    this.cTot[pos] = st
    this.cN[pos] = n
    this.cOk[pos] = 1
  }

  /**
   * Sums of the present buckets in (s - w, s] for each w of `windows` (ascending, at most `size`),
   * walking back from s: single buckets up to a block boundary, whole blocks from the cache while
   * they lie inside the window, single buckets again at its far end. The order depends only on s
   * and `windows`, so equal contents give equal sums.
   */
  windowSums(s: number, windows: number[]): { bad: number; tot: number; present: number }[] {
    const out: { bad: number; tot: number; present: number }[] = []
    let sb = 0
    let st = 0
    let n = 0
    let q = s
    for (const w of windows) {
      const lo = s - w + 1
      while (q >= lo) {
        const i = this.idx(q)
        if (i % this.block === this.block - 1 && q - this.block + 1 >= lo) {
          const pos = Math.floor(i / this.block)
          this.blockSums(pos)
          sb += this.cBad[pos]!
          st += this.cTot[pos]!
          n += this.cN[pos]!
          q -= this.block
        } else {
          const b = this.bad[i]!
          if (b === b) {
            sb += b
            st += this.tot[i]!
            n++
          }
          q--
        }
      }
      out.push({ bad: sb, tot: st, present: n })
    }
    return out
  }
}

// ───────────────────────────── one evaluation ─────────────────────────────

/** What a flagged severity carried at the last evaluation: replayed as it was. */
export interface SloFlag {
  value: number
  text: string
  detail: SloDetail
}

export interface SloSeriesState {
  labels: Labels
  fine: Ring
  coarse: Ring
  last: { page: SloFlag | null; ticket: SloFlag | null; warming: string | null } | null
  /** Last query time at which the SLI returned the series. */
  seenAt: number
}

export interface SloRt {
  /** Query times are origin + slot × interval. Set at the first evaluation. */
  origin: number | null
  lastSlot: number | null
  lastCoarse: number | null
  lastTs: number | null
  /** Start of the earliest bucket on record (a coarse read's first bucket, or the first tick's): bounds what the budget figure covers. */
  firstTs: number | null
  series: Map<string, SloSeriesState>
  status: SloRuleStatus
  pruned: number
  /** The stored rows are in a format this release does not read: refused, kept as they are. */
  unreadable: string | null
  rawRows: SloRow[] | null
  /** Bytes of the rows as last written or read. */
  stateBytes: number
}

export function emptySloStatus(maxSeries: number): SloRuleStatus {
  return { status: 'unknown', message: null, series: 0, maxSeries, burning: { page: 0, ticket: 0 }, warming: 0, budgetRemaining: null, budgetCoveredMs: 0, stateSeries: 0, stateBytes: 0, pruned: 0 }
}

export function newSloRt(rule: SloRuleV2): SloRt {
  return { origin: null, lastSlot: null, lastCoarse: null, lastTs: null, firstTs: null, series: new Map(), status: emptySloStatus(rule.slo.maxSeries), pruned: 0, unreadable: null, rawRows: null, stateBytes: 0 }
}

/** A working copy for one tick: the committed state is untouched until the tick commits. */
export function cloneSloRt(rt: SloRt): SloRt {
  const series = new Map<string, SloSeriesState>()
  for (const [k, s] of rt.series) series.set(k, { labels: s.labels, fine: s.fine.clone(), coarse: s.coarse.clone(), last: s.last, seenAt: s.seenAt })
  return { ...rt, series, status: { ...rt.status } }
}

export type SloEval =
  | {
      ok: true
      flagged: (Series & { annotations: Record<string, string> })[]
      /** Every series the SLI returned: what "no data" is decided on. */
      present: Series[]
      status: SloRuleStatus
      /** False only for a replayed tick. */
      changed: boolean
    }
  | { ok: false; status: SloRuleStatus; error: string }

const residue = (t: number, m: number) => ((t % m) + m) % m

function newSeries(labels: Labels, g: ReturnType<typeof sloGeometry>): SloSeriesState {
  return { labels, fine: new Ring(g.fineSize, FINE_BLOCK), coarse: new Ring(g.coarseSize, COARSE_BLOCK), last: null, seenAt: 0 }
}

/** One series' parts at one evaluation: the bucket (bad, total), NaN when missing. */
type Parts = { labels: Labels; bad: number; tot: number }

/**
 * Pair the parts of the per-tick expression's result into one bucket per series. Refuses (with a
 * message) results whose parts do not pair up: a good or bad series with no total series (the two
 * expressions aggregate by different labels), or two series with the same labels.
 */
export function bucketsOf(rule: SloRuleV2, series: Series[]): { ok: true; buckets: Map<string, Parts> } | { ok: false; error: string } {
  const kind = rule.slo.sli.kind
  const parts = new Map<string, { labels: Labels; total?: number; part?: number }>()
  for (const s of series) {
    const { [SLO_PART_LABEL]: part, __name__: _n, ...labels } = s.metric
    const key = fingerprint(labels)
    const e = parts.get(key) ?? { labels }
    if (kind === 'error_ratio') {
      if (part !== undefined) return { ok: false, error: `invalid_result: the error ratio returned a series labelled ${SLO_PART_LABEL}` }
      if (e.part !== undefined) return { ok: false, error: 'invalid_result: the error ratio returned two series with the same labels' }
      e.part = s.value
      e.total = 1
    } else if (part === 'total') {
      if (e.total !== undefined) return { ok: false, error: 'invalid_result: the total expression returned two series with the same labels' }
      e.total = s.value
    } else if ((kind === 'good_total' && part === 'good') || (kind === 'bad_total' && part === 'bad')) {
      if (e.part !== undefined) return { ok: false, error: `invalid_result: the ${part} expression returned two series with the same labels` }
      e.part = s.value
    } else {
      return { ok: false, error: `invalid_result: a series without a known ${SLO_PART_LABEL} (${JSON.stringify(part ?? null)})` }
    }
    parts.set(key, e)
  }
  const buckets = new Map<string, Parts>()
  for (const [key, e] of parts) {
    if (e.total === undefined) {
      const what = kind === 'good_total' ? 'good' : 'bad'
      return { ok: false, error: `invalid_result: the ${what} expression returned a series the total expression did not (${JSON.stringify(e.labels).slice(0, 200)}); aggregate both by the same labels` }
    }
    const t = e.total
    // A missing part is 0 good (all bad) or 0 bad (no errors): the total says events happened.
    const p = e.part ?? 0
    const bad = kind === 'good_total' ? Math.max(0, t - p) : p
    const ok = Number.isFinite(t) && Number.isFinite(bad) && t >= 0 && bad >= 0
    buckets.set(key, { labels: e.labels, bad: ok ? bad : NaN, tot: ok ? t : NaN })
  }
  return { ok: true, buckets }
}

const ROUGH: [number, string][] = [[7 * DAY, 'week'], [DAY, 'day'], [60 * MINUTE, 'hour'], [MINUTE, 'minute'], [1000, 'second']]
/** A computed duration in its largest unit, to three significant digits ("1.73 days", not "2496 minutes"). */
export function roughDuration(ms: number): string {
  for (const [size, name] of ROUGH) {
    if (ms >= size) {
      const n = Number((ms / size).toPrecision(3))
      return `${n} ${name}${n === 1 ? '' : 's'}`
    }
  }
  return 'under a second'
}

/** The sentence's second half: how much budget is left, over how much history, and how long it lasts at this rate. */
export function budgetClause(remaining: number | null, coveredMs: number, windowMs: number, longBurn: number): { text: string; exhaustionMs: number | null } {
  if (remaining === null) return { text: 'no events are on record to say how much budget is left', exhaustionMs: null }
  const over = coveredMs >= windowMs ? `over the last ${duration(windowMs)}` : `over the ${duration(coveredMs)} on record (the window is ${duration(windowMs)})`
  if (remaining <= 0) return { text: `the budget is spent ${over} (${fmt(100 * remaining)}% left)`, exhaustionMs: null }
  const exhaustionMs = longBurn > 0 ? Math.round((remaining * windowMs) / longBurn) : null
  return { text: `${fmt(100 * remaining)}% of the budget is left ${over}${exhaustionMs !== null ? `, spent in ${roughDuration(exhaustionMs)} at this rate` : ''}`, exhaustionMs }
}

/**
 * The budget left over the compliance window, from the coarse ring ending at slot k (fine slot n),
 * and how much time it covers: the coarse buckets with data, the current one only as far as it
 * has run, and never more than has passed since the earliest bucket on record.
 */
export function budgetOf(s: SloSeriesState, n: number, k: number, ts: number, firstTs: number | null, objective: number, g: ReturnType<typeof sloGeometry>, windowMs: number, intervalMs: number): { remaining: number | null; coveredMs: number } {
  const [sum] = s.coarse.windowSums(k, [g.coarseBuckets])
  const w = sum!
  const m = g.coarseMs / intervalMs
  const current = s.coarse.get(k)[0]
  const elapsed = (n - (k - 1) * m) * intervalMs
  const byBuckets = w.present * g.coarseMs - (current === current ? g.coarseMs - elapsed : 0)
  const covered = Math.max(0, Math.min(windowMs, byBuckets, firstTs === null ? byBuckets : ts - firstTs))
  // The ring's far edge moves a coarse bucket at a time: within one bucket of the window is the whole window.
  const coveredMs = covered >= windowMs - g.coarseMs ? windowMs : covered
  return { remaining: w.tot > 0 ? 1 - w.bad / w.tot / (1 - objective) : null, coveredMs }
}

/** Evaluate one series at slot n (and coarse slot k): which severities burn, with their sentences. */
function judge(rule: SloRuleV2, s: SloSeriesState, n: number, k: number, ts: number, firstTs: number | null, intervalMs: number, g: ReturnType<typeof sloGeometry>): { page: SloFlag | null; ticket: SloFlag | null; warming: string | null; budget: { remaining: number | null; coveredMs: number } } {
  const spec = rule.slo
  const sums = s.fine.windowSums(n, g.windows)
  const agg = new Map<number, WindowAggregate>()
  let warming: string | null = null
  for (const a of spec.alerts) {
    for (const ms of [a.longMs, a.shortMs]) {
      const w = Math.max(1, Math.round(ms / intervalMs))
      const x = sums[g.windows.indexOf(w)]!
      const coverage = x.present / w
      if (coverage >= spec.minCoverage) agg.set(ms, { bad: x.bad, total: x.tot })
      else {
        agg.set(ms, { bad: 0, total: 0 })
        warming ??= `the ${duration(ms)} window has ${fmt(100 * coverage)}% of its buckets (needs ${fmt(100 * spec.minCoverage)}%)`
      }
    }
  }
  const results = evaluateWindows({ objective: spec.objective, periodMs: spec.windowMs, rules: spec.alerts as BurnRule[], minEvents: spec.minEvents, stepMs: intervalMs, minCoverage: spec.minCoverage }, agg)
  const best: Record<SloSeverity, RuleResult | null> = { page: null, ticket: null }
  for (const r of results) {
    if (!r.firing) continue
    const sev = r.rule.severity as SloSeverity
    const cur = best[sev]
    if (!cur || r.score > cur.score) best[sev] = r
  }
  const budget = budgetOf(s, n, k, ts, firstTs, spec.objective, g, spec.windowMs, intervalMs)
  const flag = (r: RuleResult | null): SloFlag | null => {
    if (!r) return null
    const e = explainRule(r, spec.objective, spec.windowMs, ts)
    const longBurn = r.longBurn ?? 0
    const clause = budgetClause(budget.remaining, budget.coveredMs, spec.windowMs, longBurn)
    const detail: SloDetail = {
      v: 1,
      severity: r.rule.severity as SloSeverity,
      longWindowMs: r.rule.longMs,
      shortWindowMs: r.rule.shortMs,
      longBurnRate: longBurn,
      shortBurnRate: r.shortBurn ?? 0,
      threshold: r.rule.burnRate,
      objective: spec.objective,
      windowMs: spec.windowMs,
      spentInLongWindow: r.longBudgetConsumed ?? 0,
      budgetRemaining: budget.remaining,
      budgetCoveredMs: budget.coveredMs,
      exhaustionMs: clause.exhaustionMs,
      longEvents: r.longEvents,
      at: ts,
    }
    return { value: e.value, text: `${e.text}; ${clause.text}`, detail }
  }
  return { page: flag(best.page), ticket: flag(best.ticket), warming, budget }
}

/**
 * One evaluation of an SLO rule at query time `ts` over `series` (the per-tick expression's
 * result). Mutates `rt` (pass a working copy: `cloneSloRt`) unless it refuses, in which case
 * nothing was changed. `evaluate: false` only moves the buckets in (a warm-up's earlier points:
 * the windows are judged at its last point only).
 *
 * Every series with state is judged at every evaluation, present or not: a series that returned
 * nothing has a missing bucket, and its windows are judged on the buckets they still hold (less
 * than `min_coverage` of them, and they do not count).
 */
export function evalSlo(rule: SloRuleV2, rt: SloRt, series: Series[], ts: number, intervalMs: number, evaluate = true): SloEval {
  const spec = rule.slo
  const refuse = (status: 'series_cap_exceeded' | 'invalid_result' | 'state_unreadable', message: string): SloEval => ({
    ok: false,
    error: message,
    status: { ...rt.status, status, message, series: series.length, maxSeries: spec.maxSeries },
  })
  if (rt.unreadable !== null) {
    return refuse('state_unreadable', `state_unreadable: ${rt.unreadable}. A newer release wrote this rule's state; it is kept unchanged and nothing is evaluated until a release that reads it runs here.`)
  }
  const paired = bucketsOf(rule, series)
  if (!paired.ok) return refuse('invalid_result', `${paired.error}. Nothing was evaluated and no state or alert changed.`)
  const buckets = paired.buckets
  if (buckets.size > spec.maxSeries) {
    return refuse('series_cap_exceeded', `series_cap_exceeded: the SLI returned ${buckets.size} series; this rule evaluates at most ${spec.maxSeries} (max_series). Nothing was evaluated and no state or alert changed. Aggregate the SLI or raise max_series.`)
  }
  const present: Series[] = [...buckets.values()].map((b) => ({ metric: b.labels, value: b.bad, text: String(b.bad) }))
  const g = sloGeometry(spec, intervalMs)

  if (rt.lastTs !== null && ts <= rt.lastTs) {
    // A replayed tick (an alarm retried, or re-run after an eviction): reproduce its outcome.
    return { ok: true, flagged: flaggedOf(rt, rule), present, status: rt.status, changed: false }
  }

  const origin = rt.origin ?? residue(ts, intervalMs)
  const n = Math.round((ts - origin) / intervalMs)
  const m = g.coarseMs / intervalMs
  const k = Math.ceil(n / m)
  for (const [key, b] of buckets) if (!rt.series.has(key)) rt.series.set(key, newSeries(b.labels, g))
  // Series gone longer than the longest window describe nothing any window still holds.
  let pruned = 0
  for (const [key, s] of rt.series) {
    if (!buckets.has(key) && ts - s.seenAt > g.fineSize * intervalMs) {
      rt.series.delete(key)
      pruned++
    }
  }
  for (const [key, s] of rt.series) {
    const b = buckets.get(key)
    const fresh = s.seenAt === 0
    s.fine.advance(fresh ? null : rt.lastSlot, n)
    s.coarse.advance(fresh ? null : rt.lastCoarse, k)
    if (b && b.bad === b.bad) {
      s.fine.set(n, b.bad, b.tot)
      s.coarse.add(k, b.bad, b.tot)
    }
    if (b) s.seenAt = ts
  }
  rt.origin = origin
  rt.lastSlot = n
  rt.lastCoarse = k
  rt.lastTs = ts
  // The earliest bucket with data on record bounds what the budget figure can cover.
  if (rt.firstTs === null && [...buckets.values()].some((b) => b.bad === b.bad)) rt.firstTs = ts - intervalMs
  rt.pruned += pruned

  const status: SloRuleStatus = { ...emptySloStatus(spec.maxSeries), series: buckets.size, stateSeries: rt.series.size, stateBytes: rt.stateBytes, pruned: rt.pruned, warmup: rt.status.warmup }
  let minRemaining: number | null = null
  let covered = 0
  let warmingMessage: string | null = null
  for (const s of rt.series.values()) {
    if (!evaluate) {
      s.last = null
      continue
    }
    const j = judge(rule, s, n, k, ts, rt.firstTs, intervalMs, g)
    // The outcome is replayed from here; a series with a missing bucket was judged too.
    s.last = { page: j.page, ticket: j.ticket, warming: j.warming }
    if (j.page) status.burning.page++
    if (j.ticket) status.burning.ticket++
    if (j.warming) {
      status.warming++
      warmingMessage ??= j.warming
    }
    if (j.budget.remaining !== null && (minRemaining === null || j.budget.remaining < minRemaining)) {
      minRemaining = j.budget.remaining
      covered = j.budget.coveredMs
    }
  }
  status.budgetRemaining = minRemaining
  status.budgetCoveredMs = covered
  status.status = status.warming > 0 ? 'warming' : 'ok'
  status.message = status.warming > 0 ? `${status.warming} of ${rt.series.size} series warming: ${warmingMessage}` : null
  rt.status = status
  return { ok: true, flagged: flaggedOf(rt, rule), present, status, changed: true }
}

function flaggedOf(rt: SloRt, rule: SloRuleV2): (Series & { annotations: Record<string, string> })[] {
  const out: (Series & { annotations: Record<string, string> })[] = []
  for (const key of [...rt.series.keys()].sort()) {
    const s = rt.series.get(key) as SloSeriesState
    for (const sev of SEVERITIES) {
      const f = s.last?.[sev]
      if (!f) continue
      const annotations: Record<string, string> = { [SLO_ANNOTATION]: f.text, [SLO_DETAIL_ANNOTATION]: JSON.stringify(f.detail) }
      if (rule.annotations.description === undefined) annotations.description = f.text
      out.push({ metric: { ...s.labels, severity: sev }, value: f.value, text: String(f.value), annotations })
    }
  }
  return out
}

// ───────────────────────────── stored form ─────────────────────────────

/**
 * One `slo_state` row. `head` (block 0): the rule's slot counters and each series' labels and last
 * outcome. `fine` / `coarse` (block b): buckets b·B .. b·B + B - 1 of every series, null where
 * missing. A tick writes the head and the current block of each ring; blocks that left the
 * window are deleted. Format `store.slo-state` v1.
 */
export interface SloRow {
  part: 'head' | 'fine' | 'coarse'
  block: number
  body: string
}

const numOrNull = (x: number) => (x === x ? x : null)

function blockBody(rt: SloRt, which: 'fine' | 'coarse', block: number): string {
  const B = which === 'fine' ? FINE_BLOCK : COARSE_BLOCK
  const last = (which === 'fine' ? rt.lastSlot : rt.lastCoarse) as number
  const parts: string[] = []
  for (const key of [...rt.series.keys()].sort()) {
    const s = rt.series.get(key) as SloSeriesState
    const ring = which === 'fine' ? s.fine : s.coarse
    const b: (number | null)[] = []
    const t: (number | null)[] = []
    let any = false
    for (let i = 0; i < B; i++) {
      const slot = block * B + i
      if (slot > last || slot <= last - ring.size) {
        b.push(null)
        t.push(null)
        continue
      }
      const [x, y] = ring.get(slot)
      b.push(numOrNull(x))
      t.push(numOrNull(y))
      if (x === x) any = true
    }
    if (any) parts.push(JSON.stringify({ k: key, b, t }))
  }
  return `{"v":${SLO_STATE_VERSION},"series":[${parts.join(',')}]}`
}

export function headBody(rt: SloRt, intervalMs: number, coarseMs: number): string {
  const series = [...rt.series.keys()].sort().map((k) => {
    const s = rt.series.get(k) as SloSeriesState
    return { k, l: s.labels, last: s.last, seen: s.seenAt }
  })
  return JSON.stringify({ v: SLO_STATE_VERSION, origin: rt.origin, stepMs: intervalMs, budgetStepMs: coarseMs, lastSlot: rt.lastSlot, lastCoarse: rt.lastCoarse, lastTs: rt.lastTs, first: rt.firstTs, pruned: rt.pruned, series })
}

/** What one tick writes: the head and the current block of each ring; and the first block still inside each ring (older ones are deleted). */
export function tickRows(rt: SloRt, rule: SloRuleV2, intervalMs: number): { rows: SloRow[]; keepFine: number; keepCoarse: number } {
  const g = sloGeometry(rule.slo, intervalMs)
  const n = rt.lastSlot as number
  const k = rt.lastCoarse as number
  return {
    rows: [
      { part: 'head', block: 0, body: headBody(rt, intervalMs, g.coarseMs) },
      { part: 'fine', block: Math.floor(n / FINE_BLOCK), body: blockBody(rt, 'fine', Math.floor(n / FINE_BLOCK)) },
      { part: 'coarse', block: Math.floor(k / COARSE_BLOCK), body: blockBody(rt, 'coarse', Math.floor(k / COARSE_BLOCK)) },
    ],
    keepFine: Math.floor((n - g.fineSize + 1) / FINE_BLOCK),
    keepCoarse: Math.floor((k - g.coarseSize + 1) / COARSE_BLOCK),
  }
}

/** Every row of a rule's state: what a warm-up writes, and what a shard move carries. */
export function allRows(rt: SloRt, rule: SloRuleV2, intervalMs: number): SloRow[] {
  if (rt.lastSlot === null || rt.lastCoarse === null) return []
  const g = sloGeometry(rule.slo, intervalMs)
  const rows: SloRow[] = [{ part: 'head', block: 0, body: headBody(rt, intervalMs, g.coarseMs) }]
  const n = rt.lastSlot
  const k = rt.lastCoarse
  const empty = `{"v":${SLO_STATE_VERSION},"series":[]}`
  // Blocks without a bucket are not written: a missing row reads as missing buckets.
  for (let b = Math.floor((n - g.fineSize + 1) / FINE_BLOCK); b <= Math.floor(n / FINE_BLOCK); b++) {
    const body = blockBody(rt, 'fine', b)
    if (body !== empty) rows.push({ part: 'fine', block: b, body })
  }
  for (let c = Math.floor((k - g.coarseSize + 1) / COARSE_BLOCK); c <= Math.floor(k / COARSE_BLOCK); c++) {
    const body = blockBody(rt, 'coarse', c)
    if (body !== empty) rows.push({ part: 'coarse', block: c, body })
  }
  return rows
}

/**
 * Rebuild a rule's state from its rows. A row in a version this code does not know is refused
 * (COMPATIBILITY.md §3.2): the caller marks the rule `state_unreadable` and keeps the rows.
 */
export function readSloRows(rule: SloRuleV2, intervalMs: number, rows: SloRow[]): { rt: SloRt } | { error: string } {
  const rt = newSloRt(rule)
  const g = sloGeometry(rule.slo, intervalMs)
  const parsed: { row: SloRow; body: Record<string, unknown> }[] = []
  for (const row of rows) {
    let body: Record<string, unknown>
    try {
      body = JSON.parse(row.body) as Record<string, unknown>
    } catch {
      return { error: 'an slo_state row is not JSON' }
    }
    if (body.v !== SLO_STATE_VERSION || !Array.isArray(body.series)) return { error: `slo_state row version ${JSON.stringify(body.v)} is not ${SLO_STATE_VERSION}` }
    parsed.push({ row, body })
  }
  const head = parsed.find((p) => p.row.part === 'head')
  if (!head) return rows.length === 0 ? { rt } : { error: 'slo_state has blocks but no head row' }
  const h = head.body as { origin: number | null; stepMs: number; lastSlot: number | null; lastCoarse: number | null; lastTs: number | null; first?: number | null; pruned?: number; series: { k: string; l: Labels; last: SloSeriesState['last']; seen: number }[] }
  if (h.stepMs !== intervalMs) return { rt } // another interval: the state describes another rule (the caller deleted it at save)
  rt.origin = h.origin
  rt.lastSlot = h.lastSlot
  rt.lastCoarse = h.lastCoarse
  rt.lastTs = h.lastTs
  rt.firstTs = h.first ?? null
  rt.pruned = h.pruned ?? 0
  for (const e of h.series) rt.series.set(e.k, { ...newSeries(e.l, g), last: e.last, seenAt: e.seen })
  for (const { row, body } of parsed) {
    if (row.part === 'head') continue
    const fine = row.part === 'fine'
    const B = fine ? FINE_BLOCK : COARSE_BLOCK
    const last = fine ? rt.lastSlot : rt.lastCoarse
    if (last === null) continue
    for (const e of body.series as { k: string; b: (number | null)[]; t: (number | null)[] }[]) {
      const s = rt.series.get(e.k)
      if (!s) continue
      const ring = fine ? s.fine : s.coarse
      for (let i = 0; i < B; i++) {
        const slot = row.block * B + i
        const b = e.b[i]
        const t = e.t[i]
        if (slot > last || slot <= last - ring.size || b === null || b === undefined || t === null || t === undefined) continue
        ring.set(slot, b, t)
      }
    }
  }
  rt.stateBytes = rows.reduce((x, r) => x + byteLength(r.body), 0)
  rt.status = { ...rt.status, stateSeries: rt.series.size, stateBytes: rt.stateBytes, pruned: rt.pruned }
  return { rt }
}

// ───────────────────────────── for the monitors API ─────────────────────────────

/** One line for the list, e.g. `SLO 99.9% over 30d: page at 14.4×/6×, ticket at 3×/1×`. */
export function sloText(rule: SloRuleV2): string {
  const by = (sev: SloSeverity) => rule.slo.alerts.filter((a) => a.severity === sev).map((a) => `${fmt(a.burnRate)}×`).join('/')
  const parts = SEVERITIES.map((s) => (by(s) ? `${s} at ${by(s)}` : '')).filter(Boolean)
  return `SLO ${fmt(100 * rule.slo.objective)}% over ${formatDuration(rule.slo.windowMs)}: ${parts.join(', ')}`
}
