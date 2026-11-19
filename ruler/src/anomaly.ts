/**
 * Anomaly rules (contract version 2, `contracts/rules.ts` "anomaly rules"): parsing and
 * defaults, the detector guide the monitors API serves, one tick of evaluation, and the
 * stored form of detector state. Pure: no storage, no I/O, no clock. `ruler.ts` owns the
 * transaction and the schedule.
 *
 * One tick of one anomaly rule:
 *
 *   expression result (one point per series) ──► each series' detector, from its state
 *        ──► flagged series (value + the detector's sentence and numbers as annotations)
 *        ──► `evalAlertingRule`, the alert state machine every alerting rule uses
 *
 * The detectors are `anomaly/`'s, imported, not copied. Every number an alert shows is the
 * detector's own (`Point.explanation`).
 */
import { classify as classifyHistory, DETECTORS, type Explanation } from '../../anomaly/src/index.ts'
import {
  ANOMALY_ANNOTATION,
  ANOMALY_DETAIL_ANNOTATION,
  ANOMALY_DETECTORS,
  type AnomalyDetail,
  type AnomalyDetector,
  type AnomalyHistory,
  type AnomalyParamValue,
  type AnomalyRuleStatus,
  type AnomalyRuleV2,
  type AnomalySeverity,
  type AnomalySpec,
  type CostClass,
  type DetectorGuide,
  type RulerConfig,
  type ValidationError,
} from '../contracts-proposal/rules.v2'
import type { Series } from './statemachine'
import { byteLength, formatDuration, labelsKey, type Labels } from './util'

// ───────────────────────────── limits ─────────────────────────────

export const ANOMALY_LIMIT_DEFAULTS = {
  maxAnomalySeriesPerRule: 1000,
  maxAnomalyStateBytesPerSeries: 65_536,
  maxAnomalyStateBytesPerRule: 1_048_576,
} as const

export type AnomalyLimits = { -readonly [K in keyof typeof ANOMALY_LIMIT_DEFAULTS]: number }

export function anomalyLimits(cfg: Pick<RulerConfig, 'limits'>): AnomalyLimits {
  const l = cfg.limits
  return {
    maxAnomalySeriesPerRule: l.maxAnomalySeriesPerRule ?? ANOMALY_LIMIT_DEFAULTS.maxAnomalySeriesPerRule,
    maxAnomalyStateBytesPerSeries: l.maxAnomalyStateBytesPerSeries ?? ANOMALY_LIMIT_DEFAULTS.maxAnomalyStateBytesPerSeries,
    maxAnomalyStateBytesPerRule: l.maxAnomalyStateBytesPerRule ?? ANOMALY_LIMIT_DEFAULTS.maxAnomalyStateBytesPerRule,
  }
}

/** Default `max_series`. */
export const DEFAULT_MAX_SERIES = 100
/**
 * Bytes of series state per `anomaly_state` row. A rule's state is written as
 * ceil(bytes / ANOMALY_ROW_BYTES) rows per evaluation (whole batches, never a row per series or
 * per sample: AGENTS.md); with the default per-rule limit that is at most 2 rows.
 */
export const ANOMALY_ROW_BYTES = 512 * 1024
/** The stored row format (`anomaly_state.body`), pinned by `test/golden/formats/store.anomaly-state.v1.json`. */
export const ANOMALY_STATE_VERSION = 1

// ───────────────────────────── the guide: what each detector is for, and the evidence ─────────────────────────────

const EWMA_HELD_OUT = { halfLifePoints: 100, k: 8 }

/**
 * Sources: `anomaly/README.md` "Benchmark: Numenta Anomaly Benchmark", held-out protocol
 * (parameters and threshold chosen on one half of NAB's files, scored on the other, alarm
 * onsets), standard / low-FP / low-FN profiles. Nothing here was measured on viz's own data.
 */
export const DETECTOR_GUIDE: Record<string, DetectorGuide> = {
  ewma: {
    name: 'ewma',
    inRules: true,
    goodFor: 'The default. A value far from its recent level, on noisy and spiky series: a Gaussian spread is widened by routine spikes, so they do not alarm.',
    notFor: 'Paging where false alarms are expensive (a static threshold did better there), and values that are wrong only for the time of day (use seasonal).',
    pageAllowed: true,
    defaultSeverity: 'ticket',
    defaults: { ...EWMA_HELD_OUT },
    required: [],
    evidence: {
      kind: 'held_out',
      defaultsValidated: true,
      nab: { standard: 30.1, lowFp: 3.9, lowFn: 40.8 },
      note: 'halfLifePoints 100 and k 8 were chosen on each half of NAB and scored on the other: 30.1 against the static threshold\'s 21.8 (standard profile), recall 59% against 41%, but event precision 22% (most alarms are not at a labelled anomaly). Lower than the threshold in the low-false-positive profile (3.9 vs 5.5) and on NAB\'s artificial anomalies. Validated on NAB only, not on viz\'s own data. The library\'s own defaults (halfLifePoints 30, k 4) scored 0.0 under NAB\'s protocol and are not used.',
    },
  },
  threshold: {
    name: 'threshold',
    inRules: true,
    goodFor: 'Paging on a known limit. It is the baseline the other detectors were measured against, and it beat EWMA when false alarms cost most (NAB low-FP profile 5.5 vs 3.9). Hysteresis: fires past `above`, recovers below `recoverAbove`.',
    notFor: 'Limits nobody can state, and drifting baselines.',
    pageAllowed: true,
    defaultSeverity: 'ticket',
    defaults: {},
    required: ['above or below'],
    evidence: {
      kind: 'held_out',
      defaultsValidated: false,
      nab: { standard: 21.8, lowFp: 5.5, lowFn: 32.7 },
      note: 'On NAB the level was set from each file\'s first 15% (min/max ± a margin chosen on the other half). Here the author gives the level, so there is no default to validate.',
    },
  },
  robust_z: {
    name: 'robust_z',
    inRules: true,
    goodFor: 'Series whose normal spread is narrow and stable; a sentence in robust standard deviations from the trailing median.',
    notFor: 'Heavy-tailed or spiky series: there the median absolute deviation describes only the bulk and routine spikes score 20+ robust σ.',
    pageAllowed: true,
    defaultSeverity: 'ticket',
    defaults: {},
    required: [],
    evidence: {
      kind: 'held_out',
      defaultsValidated: false,
      nab: { standard: -105.9, lowFp: -282.4, lowFn: -45.6 },
      note: 'With the MAD spread (the library default, used here) it scored below a static threshold on held-out NAB. A 99th-percentile spread (params.spread "quantile") scored 44.8, but that change was made after seeing these results and is unconfirmed on data it has not seen; it is not a default.',
    },
  },
  seasonal: {
    name: 'seasonal',
    inRules: true,
    goodFor: 'Values wrong for the time of day or week (4 of 4 phase-wrong artificial anomalies caught against 1 of 4 without it; nyc_taxi). Needs periodMs and several seasons of history.',
    notFor: 'Paging on NAB-like series in general, and series without a season. Warms up live for `seasons` periods (no backfill yet).',
    pageAllowed: true,
    defaultSeverity: 'ticket',
    defaults: {},
    required: ['periodMs'],
    evidence: {
      kind: 'held_out',
      defaultsValidated: false,
      nab: { standard: -76.4, lowFp: -223.3, lowFn: -26.2 },
      note: 'With the MAD spread it scored below a static threshold on held-out NAB. With params.spread "quantile" 41.4, post hoc and unconfirmed; not a default.',
    },
  },
  cusum: {
    name: 'cusum',
    inRules: true,
    goodFor: 'Explaining a level shift: "mean shifted from A to B at T". Use it for tickets and annotations.',
    notFor: 'Paging: 1,704 alarm events on held-out NAB and a false alarm every 195 points on pure noise. Severity page is refused.',
    pageAllowed: false,
    defaultSeverity: 'info',
    defaults: {},
    required: [],
    evidence: { kind: 'held_out', defaultsValidated: false, nab: { standard: 15.1, lowFp: -51.2, lowFn: 38.8 }, note: 'Below the static threshold in the standard and low-FP profiles; the library calls it an explanation, not a pager.' },
  },
  stl: {
    name: 'stl',
    inRules: false,
    goodFor: 'A scheduled seasonal decomposition, and explanations from it.',
    notFor: 'Alarms: its residuals scored -352.2 on held-out NAB. Not available as a rule detector.',
    pageAllowed: false,
    defaultSeverity: null,
    defaults: {},
    required: [],
    evidence: { kind: 'held_out', defaultsValidated: false, nab: { standard: -352.2, lowFp: -795.4, lowFn: -203.5 }, note: 'An explanation, not a pager. Needs a scheduled refit job, which is not built.' },
  },
  pelt: {
    name: 'pelt',
    inRules: false,
    goodFor: 'Annotating where a series changed, offline (exact, 3.3 ms for a week at 5 min).',
    notFor: 'Online alarms: -123.5 on held-out NAB. Not available as a rule detector.',
    pageAllowed: false,
    defaultSeverity: null,
    defaults: {},
    required: [],
    evidence: { kind: 'held_out', defaultsValidated: false, nab: { standard: -123.5, lowFp: -321.3, lowFn: -55.9 }, note: 'An explanation, not a pager.' },
  },
  burn_rate: {
    name: 'burn_rate',
    inRules: false,
    goodFor: 'SLO error-budget alerts (SRE Workbook multi-window, multi-burn-rate).',
    notFor: 'Rules here: it needs good and total counts per bucket; SLOs are to compile to recording rules, which is not built.',
    pageAllowed: false,
    defaultSeverity: null,
    defaults: {},
    required: [],
    evidence: { kind: 'not_scorable', defaultsValidated: false, nab: null, note: 'Checked against every table of the SRE Workbook chapter, not on NAB (no SLO data).' },
  },
}

/** The detector the monitors API and rule files use when none is named. */
export const DEFAULT_DETECTOR: AnomalyDetector = 'ewma'
/**
 * With `severity: page` and no detector, the default is the static threshold: on held-out NAB it
 * beat EWMA when false alarms cost most. It needs a level, so such a rule must give one.
 */
export const DEFAULT_PAGE_DETECTOR: AnomalyDetector = 'threshold'
export const DEFAULT_SEVERITY: AnomalySeverity = 'ticket'
const SEVERITIES: AnomalySeverity[] = ['page', 'ticket', 'info']

// ───────────────────────────── parameters ─────────────────────────────

/** String parameters and the values they may take. Any other string parameter is refused. */
const ENUMS: Record<string, string[]> = {
  direction: ['both', 'above', 'below'],
  spread: ['mad', 'quantile'],
  blend: ['median', 'mean'],
  adapt: ['robust', 'agile'],
  contamination: ['clip', 'keep'],
}
/** Set by the ruler, never by the author. */
const RULER_OWNED = new Set(['stepMs', 'unit'])
/** Numeric parameters that must be > 0 (or within a range). The library tolerates anything; a rule should not. */
const POSITIVE = new Set(['k', 'h', 'halfLifePoints', 'windowPoints', 'seasons', 'periodMs', 'minPoints', 'warmupPoints', 'relearnPoints', 'minResiduals', 'acceptAfter'])
const NON_NEGATIVE = new Set(['minDeviation', 'minSpread', 'windowMs', 'staleAfterMs', 'residualWindowMs', 'agileWindowMs', 'minSeasons'])
const UNIT_INTERVAL: Record<string, [number, number, boolean]> = { spreadQuantile: [0, 1, false], decay: [0, 1, true] }

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The library's defaults for `d` without the ruler-owned ones. */
function libraryDefaults(d: AnomalyDetector): Record<string, AnomalyParamValue> {
  const out: Record<string, AnomalyParamValue> = {}
  for (const [k, v] of Object.entries(DETECTORS[d].defaults as unknown as Record<string, unknown>)) {
    if (RULER_OWNED.has(k)) continue
    out[k] = v as AnomalyParamValue
  }
  return out
}

/** Rough stored size of one series' state, for refusing at save what could not be stored. Runtime checks the exact size. */
export function estimateStateBytes(d: AnomalyDetector, p: Record<string, AnomalyParamValue>, stepMs: number): number {
  // Labels, the last point and its explanation: the envelope every series carries.
  const envelope = 1200
  const n = (k: string) => (typeof p[k] === 'number' ? (p[k] as number) : 0)
  switch (d) {
    case 'threshold':
      return envelope + 100
    case 'ewma':
      return envelope + 200
    case 'cusum':
      // warm-up values, then at most 2 × 256 excursion points (times and values).
      return envelope + 300 + 20 * n('warmupPoints') + 36 * 2 * 256
    case 'robust_z': {
      const pts = n('windowMs') > 0 ? Math.ceil(n('windowMs') / Math.max(stepMs, 1)) : n('windowPoints')
      // measured 9.4 KB for 288 points (anomaly/bench/cpu.ts): about 33 bytes a point
      return envelope + 200 + 36 * pts
    }
    case 'seasonal': {
      const P = Math.round(n('periodMs') / Math.max(stepMs, 1))
      const R = Math.max(1, Math.floor(n('seasons'))) * P + 1
      const Rr = Math.round((n('residualWindowMs') > 0 ? n('residualWindowMs') : Math.max(n('periodMs'), 100 * stepMs)) / Math.max(stepMs, 1)) + 1
      // measured 26.8 KB for 1,442 slots (daily at 5 min, k = 4): about 19 bytes a slot
      return envelope + 300 + 20 * (R + Rr)
    }
  }
}

const CLASS_ORDER: CostClass[] = ['tail', 'recent', 'rollup']
export const maxClass = (a: CostClass, b: CostClass): CostClass => (CLASS_ORDER.indexOf(a) >= CLASS_ORDER.indexOf(b) ? a : b)

export function historyOf(d: AnomalyDetector, params: Record<string, AnomalyParamValue>, intervalMs: number, cfg: Pick<RulerConfig, 'hotWindowMs' | 'recentWindowMs'>): AnomalyHistory {
  const det = DETECTORS[d] as unknown as { history(p: unknown, step: number): import('../../anomaly/src/index.ts').HistoryNeed }
  const need = det.history({ ...params, stepMs: intervalMs }, intervalMs)
  const c = classifyHistory(need, intervalMs, { hotWindowMs: cfg.hotWindowMs, recentWindowMs: cfg.recentWindowMs })
  return {
    tick: c.tick,
    coldStart: c.coldStart,
    lookbackMs: need.lookbackMs,
    tickLookbackMs: need.tickLookbackMs,
    resolutionMs: need.resolutionMs,
    minPoints: need.minPoints,
    incremental: need.incremental,
    reason: c.reason,
  }
}

export interface ParseContext {
  err(path: string, message: string, fix: string): void
  warn(path: string, message: string, fix: string): void
}

/**
 * The `anomaly` block of a rule-file entry, at `path`. Returns the normalized spec, or null
 * after reporting what is wrong. `labels` are the rule's labels (group labels merged in); the
 * severity label is checked against the block's severity.
 */
export function parseAnomalySpec(c: ParseContext, v: unknown, path: string, intervalMs: number, forMs: number, labels: Labels, cfg: RulerConfig): AnomalySpec | null {
  const errors: ValidationError[] = []
  const err = (p: string, message: string, fix: string) => errors.push({ path: p, message, fix })
  if (!isObject(v)) {
    c.err(path, 'anomaly must be an object', 'Give { "detector": "ewma" } or leave the field out for an ordinary alerting rule.')
    return null
  }
  const FIELDS = ['detector', 'params', 'unit', 'severity', 'max_series', 'given']
  for (const k of Object.keys(v)) if (!FIELDS.includes(k)) err(`${path}.${k}`, `unknown field "${k}"`, `An anomaly block has: ${FIELDS.filter((f) => f !== 'given').join(', ')}.`)

  let severity: AnomalySeverity = DEFAULT_SEVERITY
  if (v.severity !== undefined) {
    if (typeof v.severity !== 'string' || !SEVERITIES.includes(v.severity as AnomalySeverity)) err(`${path}.severity`, `severity must be one of ${SEVERITIES.join(', ')}`, 'Use "ticket" unless a person must be woken; "page" only for detectors that may page.')
    else severity = v.severity as AnomalySeverity
  } else if (typeof labels.severity === 'string' && SEVERITIES.includes(labels.severity as AnomalySeverity)) {
    severity = labels.severity as AnomalySeverity
  }
  if (labels.severity !== undefined && labels.severity !== severity) {
    err(`${path}.severity`, `the severity label "${labels.severity}" and anomaly.severity "${severity}" differ`, 'Set the severity once, in anomaly.severity.')
  }

  let detector: AnomalyDetector
  if (v.detector === undefined) detector = severity === 'page' ? DEFAULT_PAGE_DETECTOR : DEFAULT_DETECTOR
  else if (typeof v.detector !== 'string' || !(ANOMALY_DETECTORS as readonly string[]).includes(v.detector)) {
    const guide = typeof v.detector === 'string' ? DETECTOR_GUIDE[v.detector] : undefined
    err(`${path}.detector`, guide && !guide.inRules ? `"${v.detector}" cannot run in a rule: ${guide.notFor}` : `unknown detector ${JSON.stringify(v.detector)}`, `Use one of ${ANOMALY_DETECTORS.join(', ')}; ewma is the default.`)
    detector = DEFAULT_DETECTOR
  } else detector = v.detector as AnomalyDetector
  const guide = DETECTOR_GUIDE[detector] as DetectorGuide

  if (v.unit !== undefined && (typeof v.unit !== 'string' || v.unit.length > 32)) err(`${path}.unit`, 'unit must be a string of at most 32 characters', 'Use e.g. "ms", "req/s" or "%".')
  const unit = typeof v.unit === 'string' ? v.unit : ''

  const limits = anomalyLimits(cfg)
  let maxSeries = DEFAULT_MAX_SERIES
  if (v.max_series !== undefined) {
    if (typeof v.max_series !== 'number' || !Number.isInteger(v.max_series) || v.max_series < 1) err(`${path}.max_series`, 'max_series must be a whole number of at least 1', `Use at most ${limits.maxAnomalySeriesPerRule}.`)
    else if (v.max_series > limits.maxAnomalySeriesPerRule) err(`${path}.max_series`, `max_series ${v.max_series} is above this ruler's limit of ${limits.maxAnomalySeriesPerRule}`, 'Aggregate the expression (sum by a few labels), or split it over several rules.')
    else maxSeries = v.max_series
  }

  // Parameters: the library's defaults, then the ruler's evidence-based ones, then the author's.
  const params: Record<string, AnomalyParamValue> = { ...libraryDefaults(detector), ...guide.defaults }
  const given: string[] = []
  if (v.params !== undefined && !isObject(v.params)) err(`${path}.params`, 'params must be an object', 'Write the detector parameters as name: value pairs.')
  else if (isObject(v.params)) {
    for (const [k, raw] of Object.entries(v.params)) {
      const p = `${path}.params.${k}`
      if (RULER_OWNED.has(k)) {
        err(p, k === 'stepMs' ? 'stepMs is the group interval' : 'unit is set in anomaly.unit', k === 'stepMs' ? 'Remove it; change the group interval instead.' : 'Move it to anomaly.unit.')
        continue
      }
      if (!(k in params)) {
        err(p, `${detector} has no parameter "${k}"`, `Its parameters: ${Object.keys(params).join(', ')}.`)
        continue
      }
      const d = (DETECTORS[detector].defaults as unknown as Record<string, unknown>)[k]
      if (typeof d === 'number' || d === null) {
        if (!(typeof raw === 'number' && Number.isFinite(raw)) && !(d === null && raw === null)) {
          err(p, `${k} must be a finite number${d === null ? ' or null' : ''}`, 'Give a number.')
          continue
        }
        if (typeof raw === 'number') {
          if (POSITIVE.has(k) && !(raw > 0)) { err(p, `${k} must be greater than 0`, 'Give a positive number.'); continue }
          if (NON_NEGATIVE.has(k) && raw < 0) { err(p, `${k} must not be negative`, 'Give 0 or more.'); continue }
          const range = UNIT_INTERVAL[k]
          if (range && !(raw > range[0] && (range[2] ? raw <= range[1] : raw < range[1]))) { err(p, `${k} must be between ${range[0]} and ${range[1]}`, 'Give a fraction, e.g. 0.99.'); continue }
        }
      } else if (typeof d === 'boolean') {
        if (typeof raw !== 'boolean') { err(p, `${k} must be true or false`, 'Use a boolean.'); continue }
      } else if (typeof d === 'string') {
        const allowed = ENUMS[k]
        if (typeof raw !== 'string' || !allowed || !allowed.includes(raw)) { err(p, `${k} must be one of ${(allowed ?? []).join(', ')}`, `Use one of ${(allowed ?? []).join(', ')}.`); continue }
      }
      params[k] = raw as AnomalyParamValue
      given.push(k)
    }
  }
  if (v.given !== undefined) {
    // Written by the ruler's own export, so a round trip keeps which parameters were defaults.
    if (!Array.isArray(v.given) || v.given.some((g) => typeof g !== 'string' || !(g in params))) err(`${path}.given`, 'given must list parameter names', 'Leave it out; the ruler writes it.')
    else for (const g of v.given as string[]) if (!given.includes(g)) given.push(g)
  }
  given.sort()

  // What each detector needs to be meaningful.
  if (detector === 'threshold' && typeof params.above !== 'number' && typeof params.below !== 'number') {
    err(`${path}.params`, 'a threshold needs params.above or params.below', severity === 'page' && v.detector === undefined
      ? 'With severity "page" and no detector the default is a static threshold, because on held-out NAB it beat EWMA when false alarms cost most (low-FP 5.5 vs 3.9). Give the level (params.above / params.below), or set detector "ewma" and accept more false pages.'
      : 'Give the level the value must not cross, e.g. { "above": 500 }.')
  }
  if (detector === 'seasonal') {
    const period = params.periodMs
    if (typeof period !== 'number' || period <= 0) err(`${path}.params.periodMs`, 'seasonal needs params.periodMs, the season length', 'Use 86400000 for a daily season or 604800000 for a weekly one.')
    else if (period < 2 * intervalMs) err(`${path}.params.periodMs`, `a season of ${formatDuration(period)} is less than two evaluations at ${formatDuration(intervalMs)}`, 'Lengthen the season or shorten the group interval.')
  }
  if (severity === 'page' && !guide.pageAllowed) {
    err(`${path}.severity`, `${detector} may not page: ${guide.notFor}`, 'Use severity "ticket" or "info", or detector "ewma" or "threshold" to page.')
  }

  if (errors.length > 0) {
    for (const e of errors) c.err(e.path, e.message, e.fix)
    return null
  }

  const history = historyOf(detector, params, intervalMs, cfg)
  const stateBytesPerSeries = estimateStateBytes(detector, params, intervalMs)
  if (stateBytesPerSeries > limits.maxAnomalyStateBytesPerSeries) {
    c.err(`${path}.params`, `${detector} with these parameters keeps about ${stateBytesPerSeries} bytes of state per series at a ${formatDuration(intervalMs)} interval; the limit is ${limits.maxAnomalyStateBytesPerSeries}`, detector === 'seasonal' ? 'Use a coarser interval (rollups) for long seasons, or fewer seasons.' : 'Use a shorter window.')
    return null
  }
  if (stateBytesPerSeries * maxSeries > limits.maxAnomalyStateBytesPerRule) {
    const fits = Math.max(1, Math.floor(limits.maxAnomalyStateBytesPerRule / stateBytesPerSeries))
    c.err(`${path}.max_series`, `${maxSeries} series × about ${stateBytesPerSeries} bytes of state each would exceed the ${limits.maxAnomalyStateBytesPerRule}-byte limit per rule`, `Lower max_series to ${fits}, or aggregate the expression.`)
    return null
  }

  // Accepted, but against the evidence or likely not what was meant.
  if (!guide.evidence.defaultsValidated && guide.evidence.nab !== null && guide.evidence.nab.standard < (DETECTOR_GUIDE.threshold as DetectorGuide).evidence.nab!.standard && params.spread !== 'quantile') {
    c.warn(`${path}.detector`, `${detector} as configured scored below a static threshold on held-out NAB (${guide.evidence.nab.standard} vs 21.8)`, `${guide.evidence.note} Consider ewma, the default.`)
  }
  if ((detector === 'robust_z' || detector === 'seasonal') && params.spread === 'quantile') {
    c.warn(`${path}.params.spread`, 'the quantile spread is not validated: it was chosen after seeing the NAB results', 'Treat its alerts as provisional until it has been checked on your own data.')
  }
  if (severity === 'page' && detector === 'ewma') {
    c.warn(`${path}.severity`, 'on held-out NAB, EWMA was below a static threshold in the low-false-positive profile (3.9 vs 5.5)', 'Page on a static threshold; send EWMA alerts as tickets.')
  }
  if (detector === 'ewma' && typeof params.acceptAfter === 'number' && forMs > params.acceptAfter * intervalMs) {
    c.warn(`${path}.for`, `EWMA accepts a new level after ${params.acceptAfter} anomalous points (${formatDuration(params.acceptAfter * intervalMs)} here), so a level shift may stop being flagged before "for" (${formatDuration(forMs)}) is satisfied`, 'Alarms are onsets: use a short "for" and keep_firing_for to hold the alert.')
  }
  if (history.minPoints * intervalMs > 24 * 3_600_000) {
    c.warn(`${path}.detector`, `the detector scores nothing until it has seen ${history.minPoints} points (${formatDuration(history.minPoints * intervalMs)}); there is no backfill from history yet`, 'Expect the rule to report "warming" for that long.')
  }
  return { detector, params, given, unit, severity, maxSeries, history, stateBytesPerSeries }
}

/** The part of an anomaly rule that names its state: a different detector or parameter is a different rule. */
export function anomalyKeyText(expr: string, spec: Pick<AnomalySpec, 'detector' | 'params'>): string {
  const params = Object.keys(spec.params).sort().map((k) => [k, spec.params[k]])
  return `${expr}\u0000${spec.detector}\u0000${JSON.stringify(params)}`
}

// ───────────────────────────── one tick ─────────────────────────────

/** What is remembered per series between ticks. `last` makes a replayed tick reproduce its outcome. */
export interface SeriesState {
  labels: Labels
  state: unknown
  last: {
    ts: number
    flag: boolean
    value: number | null
    score: number
    explanation: Explanation | null
  } | null
  /** Last evaluation time at which the expression returned the series. */
  seenAt: number
}

export interface AnomalyRt {
  series: Map<string, SeriesState>
  /** Stored JSON of each series, so a tick that changes nothing re-serialises nothing. */
  json: Map<string, string>
  status: AnomalyRuleStatus
  pruned: number
}

export function emptyStatus(maxSeries: number): AnomalyRuleStatus {
  return { status: 'unknown', message: null, series: 0, maxSeries, scored: 0, warming: 0, missing: 0, anomalous: 0, stateSeries: 0, stateBytes: 0, pruned: 0 }
}

export function newAnomalyRt(rule: AnomalyRuleV2): AnomalyRt {
  return { series: new Map(), json: new Map(), status: emptyStatus(rule.anomaly.maxSeries), pruned: 0 }
}

export type AnomalyEval =
  | {
      ok: true
      /** The rule's series state after this tick (a new map; `prev` is untouched). */
      next: Map<string, SeriesState>
      json: Map<string, string>
      /** Flagged series, for the alert state machine, with the explanation as annotations. */
      flagged: (Series & { annotations: Record<string, string> })[]
      /** Every series the expression returned: what "no data" is decided on. */
      present: Series[]
      status: AnomalyRuleStatus
      /** Something must be written (false only when every series was a replay and nothing was pruned). */
      changed: boolean
      pruned: number
    }
  | { ok: false; status: AnomalyRuleStatus; error: string }

const entryJson = (key: string, s: SeriesState): string => JSON.stringify({ k: key, l: s.labels, s: s.state, last: s.last, seen: s.seenAt })

export function detailOf(e: Explanation, score: number, detector: AnomalyDetector): AnomalyDetail {
  const d: AnomalyDetail = { v: 1, detector, kind: e.kind, direction: e.direction, value: e.value, reference: e.reference, referenceLabel: e.referenceLabel, score, at: e.at, facts: e.facts }
  if (e.deviations !== undefined) d.deviations = e.deviations
  if (e.spread !== undefined) d.spread = e.spread
  if (e.spreadLabel !== undefined) d.spreadLabel = e.spreadLabel
  return d
}

/**
 * One evaluation of an anomaly rule at `ts` (the query time) over `series` (the expression's
 * result). Pure. Refuses, changing nothing, when the expression returned more than `maxSeries`
 * series or when the state would not fit the limits.
 */
export function evalAnomaly(rule: AnomalyRuleV2, prev: AnomalyRt, series: Series[], ts: number, intervalMs: number, limits: AnomalyLimits, ruleAnnotations: Record<string, string>): AnomalyEval {
  const spec = rule.anomaly
  const base: AnomalyRuleStatus = { ...emptyStatus(spec.maxSeries), series: series.length, pruned: prev.pruned }
  const refuse = (status: 'series_cap_exceeded' | 'state_limit_exceeded', message: string): AnomalyEval => ({
    ok: false,
    error: message,
    status: { ...prev.status, ...base, status, message, stateSeries: prev.series.size, stateBytes: sumBytes(prev.json) },
  })
  if (series.length > spec.maxSeries) {
    return refuse('series_cap_exceeded', `series_cap_exceeded: the expression returned ${series.length} series; this rule scores at most ${spec.maxSeries} (max_series). Nothing was scored and no state or alert changed. Aggregate the expression or raise max_series (limit ${limits.maxAnomalySeriesPerRule}).`)
  }
  const det = DETECTORS[spec.detector] as unknown as { detect(s: { ts: Float64Array; values: Float64Array }, p: unknown, st: unknown): { points: { status: string; anomalous: boolean; value: number | null; score: number; explanation?: Explanation }[]; state: unknown; summary: { message?: string } } }
  const params = { ...spec.params, stepMs: intervalMs, unit: spec.unit }
  const next = new Map(prev.series)
  const json = new Map(prev.json)
  const flagged: (Series & { annotations: Record<string, string> })[] = []
  const seen = new Set<string>()
  const counts = { scored: 0, warming: 0, missing: 0, anomalous: 0 }
  let warmingMessage: string | null = null
  let changed = false
  for (const s of series) {
    const key = labelsKey(s.metric)
    if (seen.has(key)) return { ok: false, error: 'vector contains metrics with the same labelset', status: { ...prev.status, ...base, status: prev.status.status, message: 'duplicate series' } }
    seen.add(key)
    const before = prev.series.get(key)
    let entry: SeriesState
    if (before?.last && before.last.ts >= ts) {
      // A replayed tick (an alarm retried, or re-run after eviction): reproduce its outcome.
      entry = before
    } else {
      const r = det.detect({ ts: Float64Array.of(ts), values: Float64Array.of(s.value) }, params, before?.state ?? null)
      const p = r.points[0]!
      if (p.status === 'missing') {
        // NaN or ±Inf: not scored, and a gap is not a recovery: keep the previous flag.
        counts.missing++
        entry = { labels: s.metric, state: before?.state ?? r.state, last: before?.last ? { ...before.last, ts } : { ts, flag: false, value: null, score: 0, explanation: null }, seenAt: ts }
      } else {
        if (p.status === 'warming') {
          counts.warming++
          warmingMessage ??= r.summary.message ?? `needs ${spec.history.minPoints} points before scoring`
        } else counts.scored++
        entry = { labels: s.metric, state: r.state, last: { ts, flag: p.status === 'ok' && p.anomalous, value: p.value, score: p.score, explanation: p.anomalous ? (p.explanation ?? null) : null }, seenAt: ts }
      }
      next.set(key, entry)
      json.set(key, entryJson(key, entry))
      changed = true
    }
    if (entry.last?.flag) {
      counts.anomalous++
      const e = entry.last.explanation
      const value = entry.last.value ?? s.value
      const annotations: Record<string, string> = {}
      if (e) {
        annotations[ANOMALY_ANNOTATION] = e.text
        annotations[ANOMALY_DETAIL_ANNOTATION] = JSON.stringify(detailOf(e, entry.last.score, spec.detector))
        if (ruleAnnotations.description === undefined) annotations.description = e.text
      }
      flagged.push({ metric: s.metric, value, text: String(value), annotations })
    }
  }
  // Series that went away keep their state for the detector's lookback (they may come back);
  // after that it describes nothing current and is dropped, and counted.
  const ttl = Math.max(spec.history.lookbackMs, 10 * intervalMs)
  let pruned = 0
  for (const [key, s] of prev.series) {
    if (seen.has(key) || ts - s.seenAt <= ttl) continue
    next.delete(key)
    json.delete(key)
    pruned++
    changed = true
  }
  let total = 0
  for (const [key, j] of json) {
    const bytes = byteLength(j)
    if (bytes > limits.maxAnomalyStateBytesPerSeries) {
      return refuse('state_limit_exceeded', `state_limit_exceeded: the detector state of one series (${key.slice(0, 120)}) is ${bytes} bytes; the limit is ${limits.maxAnomalyStateBytesPerSeries}. Nothing was scored and no state or alert changed.`)
    }
    total += bytes
  }
  if (total > limits.maxAnomalyStateBytesPerRule) {
    return refuse('state_limit_exceeded', `state_limit_exceeded: the rule's detector state would be ${total} bytes for ${json.size} series; the limit is ${limits.maxAnomalyStateBytesPerRule}. Nothing was scored and no state or alert changed. Lower max_series or aggregate the expression.`)
  }
  const status: AnomalyRuleStatus = {
    ...base,
    ...counts,
    status: counts.warming > 0 ? 'warming' : 'ok',
    message: counts.warming > 0 ? `${counts.warming} of ${series.length} series warming: ${warmingMessage}` : null,
    stateSeries: next.size,
    stateBytes: total,
    pruned: prev.pruned + pruned,
  }
  return { ok: true, next, json, flagged, present: series, status, changed, pruned }
}

function sumBytes(json: Map<string, string>): number {
  let n = 0
  for (const j of json.values()) n += byteLength(j)
  return n
}

// ───────────────────────────── stored form ─────────────────────────────

/** A rule's state as `anomaly_state` row bodies: whole batches of series, at most `ANOMALY_ROW_BYTES` each. */
export function stateRows(json: Map<string, string>, rowBytes = ANOMALY_ROW_BYTES): string[] {
  const rows: string[] = []
  let parts: string[] = []
  let size = 0
  const flush = () => {
    rows.push(`{"v":${ANOMALY_STATE_VERSION},"series":[${parts.join(',')}]}`)
    parts = []
    size = 0
  }
  for (const key of [...json.keys()].sort()) {
    const j = json.get(key) as string
    const b = byteLength(j) + 1
    if (parts.length > 0 && size + b > rowBytes) flush()
    parts.push(j)
    size += b
  }
  if (parts.length > 0) flush()
  return rows
}

/**
 * Rebuild a rule's state from its rows. A row in a version this code does not know is refused
 * (COMPATIBILITY.md §3.2): the rule then starts cold rather than guessing at the state.
 */
export function readStateRows(bodies: string[]): { series: Map<string, SeriesState>; json: Map<string, string> } | { error: string } {
  const series = new Map<string, SeriesState>()
  const json = new Map<string, string>()
  for (const body of bodies) {
    const row = JSON.parse(body) as { v?: unknown; series?: unknown }
    if (row.v !== ANOMALY_STATE_VERSION || !Array.isArray(row.series)) return { error: `anomaly_state row version ${JSON.stringify(row.v)} is not ${ANOMALY_STATE_VERSION}` }
    for (const e of row.series as { k: string; l: Labels; s: unknown; last: SeriesState['last']; seen: number }[]) {
      const s: SeriesState = { labels: e.l, state: e.s, last: e.last, seenAt: e.seen }
      series.set(e.k, s)
      json.set(e.k, entryJson(e.k, s))
    }
  }
  return { series, json }
}
