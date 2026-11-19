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
import { ANOMALY_BLOCK, emptyStore, planV2, readV2, WINDOWED, type AnomalyWrite, type StoreMeta } from './anomalystore'
import { ANOMALY_STATE_WRITE } from './schema'
import type { Series } from './statemachine'
import { byteLength, fingerprint, formatDuration, type Labels } from './util'

// ───────────────────────────── limits ─────────────────────────────

export const ANOMALY_LIMIT_DEFAULTS = {
  maxAnomalySeriesPerRule: 1000,
  maxAnomalyStateBytesPerSeries: 65_536,
  maxAnomalyStateBytesPerRule: 1_048_576,
  /**
   * State is held in memory between ticks (parsed and as stored JSON, about 3 bytes of heap per
   * stored byte), and a Durable Object has 128 MB: 16 MiB of stored state keeps the anomaly rules
   * of one object near 50 MB at most, beside its alerting rules.
   */
  maxAnomalyStateBytesPerObject: 16_777_216,
} as const

export type AnomalyLimits = { -readonly [K in keyof typeof ANOMALY_LIMIT_DEFAULTS]: number }

export function anomalyLimits(cfg: Pick<RulerConfig, 'limits'>): AnomalyLimits {
  const l = cfg.limits
  return {
    maxAnomalySeriesPerRule: l.maxAnomalySeriesPerRule ?? ANOMALY_LIMIT_DEFAULTS.maxAnomalySeriesPerRule,
    maxAnomalyStateBytesPerSeries: l.maxAnomalyStateBytesPerSeries ?? ANOMALY_LIMIT_DEFAULTS.maxAnomalyStateBytesPerSeries,
    maxAnomalyStateBytesPerRule: l.maxAnomalyStateBytesPerRule ?? ANOMALY_LIMIT_DEFAULTS.maxAnomalyStateBytesPerRule,
    maxAnomalyStateBytesPerObject: l.maxAnomalyStateBytesPerObject ?? ANOMALY_LIMIT_DEFAULTS.maxAnomalyStateBytesPerObject,
  }
}

/** Default `max_series`. */
export const DEFAULT_MAX_SERIES = 100
/**
 * Bytes of series state per `anomaly_state` row of version 1. A rule's state is written as
 * ceil(bytes / ANOMALY_ROW_BYTES) rows per evaluation (whole batches, never a row per series or
 * per sample: AGENTS.md); with the default per-rule limit that is at most 2 rows. Version 2 (robust
 * z and seasonal, `anomalystore.ts`) writes the head and the current block instead.
 */
export const ANOMALY_ROW_BYTES = 512 * 1024
/**
 * The row format version 1 (`anomaly_state.body`, `{"v":1,"series":[…]}`), pinned by
 * `test/golden/formats/store.anomaly-state.v1.json`: what this release writes for every detector
 * but robust z and seasonal, and for those too while the gate `ANOMALY_STATE_WRITE` is 1. Version 2
 * is `anomalystore.ts`; this release reads both.
 */
export const ANOMALY_STATE_VERSION = 1

// ───────────────────────────── the guide: what each detector is for, and the evidence ─────────────────────────────

const EWMA_HELD_OUT = { halfLifePoints: 100, k: 8 }

/**
 * Robust z with the quantile spread at the largest window whose stored state fits the per-series
 * limit (64 KiB) for any values: 1,500 points, measured at 60.9 KB with the longest number
 * encoding (39.7 bytes a point; the save-time estimate, 36, would allow 1,781, where such values
 * reach 72 KB and are refused at run time), leaving about 4.6 KB for labels and the explanation.
 * k 2 and the 99th percentile are the configuration frozen on NAB (anomaly/bench/smd-frozen.json);
 * only the window differs from it (design D33; ruler/README.md part 8).
 */
export const ROBUST_Z_DEFAULTS = { windowPoints: 1500, k: 2, spread: 'quantile', spreadQuantile: 0.99 } as const
/** The configuration frozen on NAB before SMD was fetched and confirmed there; nameable, but over the per-series limit (about 145 KB a series). */
export const ROBUST_Z_CONFIRMED = { windowPoints: 4000, k: 2, spread: 'quantile', spreadQuantile: 0.99 } as const
/** Seasonal with the quantile spread: the configuration frozen on NAB and confirmed on SMD. */
export const SEASONAL_DEFAULTS = { seasons: 1, k: 2, adapt: 'robust', spread: 'quantile', spreadQuantile: 0.99 } as const

const SMD = 'SMD (28 servers, never used to choose anything)'

/**
 * Sources: `anomaly/README.md` ("Benchmark: Numenta Anomaly Benchmark", held-out protocol:
 * parameters and threshold chosen on one half of NAB's files, scored on the other, alarm onsets;
 * "Second benchmark: SMD", every parameter frozen on NAB before SMD was fetched) and, for the
 * window of 1,500 points, `ruler/tools/anomaly-default/` (README part 8). Scores are NAB's
 * normalised score, standard / low-FP / low-FN profiles. Nothing here was measured on viz's own
 * data. These numbers are copied by hand; a change there must be made here.
 */
export const DETECTOR_GUIDE: Record<string, DetectorGuide> = {
  robust_z: {
    name: 'robust_z',
    inRules: true,
    goodFor: 'The default for rules that do not page (design D33). A value far from the trailing median, in multiples of the 99th percentile of |value − median| over the window: routine spikes set the scale, so they do not alarm. On data never used to choose it (SMD, server metrics) it scored first of twelve, above EWMA and the static threshold.',
    notFor: 'Paging where false alarms cost most: on SMD its lead over a static threshold in the low-false-positive profile is not significant, and it raised about 12 unmatched alarms per machine-day against the threshold\'s 1.5. Values wrong only for the time of day (seasonal). With spread "mad": heavy-tailed series, where routine spikes score 20+ robust σ.',
    pageAllowed: true,
    defaultSeverity: 'ticket',
    defaults: { ...ROBUST_Z_DEFAULTS },
    required: [],
    evidence: {
      kind: 'held_out',
      defaultsValidated: true,
      nab: { standard: 42.6, lowFp: 29.7, lowFn: 55.4 },
      note: 'Window 1,500 is the largest whose state fits this ruler\'s 64 KiB per series for any values (the window was set by that limit, not by the data); k 2 and the 99th percentile are as frozen on NAB. Held out on NAB 42.6; on SMD 42.5, post hoc (only the 4,000-point window was frozen before SMD was seen; it scored 42.8 there and is refused here for its state, about 145 KB a series). A rule keeps at most 18 series by default (about 55 KB of state each, 1 MiB a rule), and its warm-up is modelled at about 0.35 ms of CPU a point (0.53 s a series). With spread "mad" the library\'s defaults apply (window 288, k 3.5), as before 2026-11-19; the MAD scored below a static threshold on both benchmarks.',
      lines: [
        { kind: 'held_out', data: 'NAB', config: 'quantile spread, window 1,500 (this default), k chosen on each half from 1, 1.5, 2, 3', score: { standard: 42.6, lowFp: 29.7, lowFn: 55.4 }, text: 'Above EWMA (30.1) and the static threshold (21.8) in every profile. The halves chose k 1.5 and 2 (standard), 2 and 2 (low FP); the default is 2, the frozen k. Window recall 66%, event precision 31%.' },
        { kind: 'post_hoc', data: 'SMD', config: 'quantile spread, window 1,500, k 2 (this default)', score: { standard: 42.5, lowFp: 21.2, lowFn: 50.8 }, text: 'Scored after the frozen results were seen. Over EWMA +32.0 [20.6, 48.1], over the static threshold +26.0 [14.6, 35.1] (standard, 95% machine bootstrap); event F1 0.382 (EWMA 0.206, threshold 0.328); 12.2 unmatched alarm onsets per machine-day.' },
        { kind: 'confirmed', data: 'SMD', config: 'quantile spread, window 4,000, k 2 (frozen on NAB)', score: { standard: 42.8, lowFp: 23.0, lowFn: 44.0 }, text: 'The pre-registered configuration: generalised by the rule written in advance (over EWMA +32.4 [20.7, 48.7], event F1 0.441). Nameable as params { windowPoints: 4000 }, but its state, about 145 KB a series, is over this ruler\'s per-series limit, so the save is refused unless that limit is raised; then at most 7 series a rule, and modelled at 0.92 ms of CPU a point (3.7 s to warm one series, over the 5 s warm-up budget at 2).' },
        { kind: 'post_hoc', data: 'NAB', config: 'quantile spread, window and k chosen on each half (window 4,000)', score: { standard: 44.8, lowFp: 33.7, lowFn: 52.3 }, text: 'The quantile spread itself was chosen after seeing the MAD results below; SMD was fetched only after it was frozen.' },
        { kind: 'held_out', data: 'NAB', config: 'quantile spread, window 1,000, k chosen on each half', score: { standard: 39.4, lowFp: 25.6, lowFn: 52.1 }, text: 'A smaller window: 28 series a rule by default. On SMD (k 2, post hoc) 37.6 / 9.9 / 48.0: below the static threshold (15.5) in the low-false-positive profile.' },
        { kind: 'held_out', data: 'NAB', config: 'MAD spread (spread "mad"), window 1,000, k 10 chosen on each half', score: { standard: -105.9, lowFp: -282.4, lowFn: -45.6 }, text: 'Below a static threshold: on heavy-tailed series the MAD describes only the bulk.' },
        { kind: 'confirmed', data: 'SMD', config: 'MAD spread, frozen', score: { standard: -318.2, lowFp: -698.7, lowFn: -190.4 }, text: 'The hypothesis written in advance (the MAD below the static threshold) held; below even a random detector (−68.0).' },
      ],
    },
  },
  ewma: {
    name: 'ewma',
    inRules: true,
    goodFor: 'A value far from its recent level on noisy, spiky series (a Gaussian spread is widened by routine spikes). It was the default until 2026-11-19, and rules saved then without a detector keep it.',
    notFor: 'A default, and paging: on data never used to choose it (SMD, server metrics) it scored below a static threshold in every profile, with about 30 unmatched alarms per machine-day. Values wrong only for the time of day (seasonal).',
    pageAllowed: true,
    defaultSeverity: 'ticket',
    defaults: { ...EWMA_HELD_OUT },
    required: [],
    evidence: {
      kind: 'held_out',
      defaultsValidated: true,
      nab: { standard: 30.1, lowFp: 3.9, lowFn: 40.8 },
      note: 'halfLifePoints 100 and k 8 were chosen on each half of NAB and scored on the other: 30.1 against the static threshold\'s 21.8. Frozen with them and scored on SMD it fell to 10.4, below the threshold\'s 16.4 in every profile (not confirmed). The library\'s own defaults (halfLifePoints 30, k 4) scored 0.0 under NAB\'s protocol and are not used.',
      lines: [
        { kind: 'held_out', data: 'NAB', config: 'half-life 100, k 8 (chosen on both halves)', score: { standard: 30.1, lowFp: 3.9, lowFn: 40.8 }, text: 'Above the static threshold (21.8) in the standard profile, below it in the low-false-positive profile (5.5). Window recall 59%, event precision 22%.' },
        { kind: 'not_confirmed', data: 'SMD', config: 'half-life 100, k 8 (frozen on NAB)', score: { standard: 10.4, lowFp: -38.4, lowFn: 8.3 }, text: 'The hypothesis written in advance (EWMA above the static threshold) did not hold: below it in every profile (standard −6.0 [−30.9, 10.5], low FP −53.9 [−100.8, −21.9]); event F1 0.206 against 0.328.' },
      ],
    },
  },
  threshold: {
    name: 'threshold',
    inRules: true,
    goodFor: 'Paging on a known limit, and the default for pages. It is the baseline the others were measured against, and it held up best where false alarms cost most, on both benchmarks. Hysteresis: fires past `above`, recovers below `recoverAbove`.',
    notFor: 'Limits nobody can state, and drifting baselines; it misses more (event recall 26% on SMD against 62% for robust z).',
    pageAllowed: true,
    defaultSeverity: 'ticket',
    defaults: {},
    required: ['above or below'],
    evidence: {
      kind: 'held_out',
      defaultsValidated: false,
      nab: { standard: 21.8, lowFp: 5.5, lowFn: 32.7 },
      note: 'On both benchmarks the level was set from each series\' history (min/max ± a margin chosen on NAB). Here the author gives the level, so there is no default to validate.',
      lines: [
        { kind: 'held_out', data: 'NAB', config: 'level from the first 15% of each file, margin chosen on each half', score: { standard: 21.8, lowFp: 5.5, lowFn: 32.7 }, text: 'Beat EWMA in the low-false-positive profile (5.5 against 3.9).' },
        { kind: 'confirmed', data: 'SMD', config: 'level from the training half, margin frozen on NAB', score: { standard: 16.4, lowFp: 15.5, lowFn: 19.6 }, text: 'The hypothesis written in advance (the threshold above EWMA in the low-false-positive profile) held. 1.5 unmatched alarm onsets per machine-day (0.5 with the low-FP margin, at 76% precision).' },
      ],
    },
  },
  seasonal: {
    name: 'seasonal',
    inRules: true,
    goodFor: 'Values wrong for the time of day or week (4 of 4 phase-wrong artificial anomalies caught on NAB against 1 of 4 without it; nyc_taxi). Needs periodMs and a season of history.',
    notFor: 'Series without a season, and paging. Not better than robust z in aggregate on either benchmark. A daily season at a 1-minute interval keeps about 59 KB of state a series (estimated), near the 64 KiB limit: values that print long reach about 68 KB and are refused at run time; use 5-minute rollups.',
    pageAllowed: true,
    defaultSeverity: 'ticket',
    defaults: { ...SEASONAL_DEFAULTS },
    required: ['periodMs'],
    evidence: {
      kind: 'confirmed',
      defaultsValidated: true,
      nab: { standard: 41.4, lowFp: 18.8, lowFn: 48.1 },
      note: 'With spread "quantile", 1 season, k 2: chosen on each half of NAB (the spread itself post hoc), frozen, then 35.5 on SMD, second of twelve (confirmed). On both benchmarks series without a detected period were scored with robust z instead, which a rule cannot do: it needs periodMs. With spread "mad" the library\'s defaults apply (4 seasons, k 4), as before 2026-11-19; the MAD scored below a static threshold on both benchmarks.',
      lines: [
        { kind: 'post_hoc', data: 'NAB', config: 'quantile spread, 1 season, k 2, adapt robust (chosen on each half)', score: { standard: 41.4, lowFp: 18.8, lowFn: 48.1 }, text: 'Held out, but the spread was chosen after seeing the MAD results. On the 22 files with a detected season 45.9, against 47.3 for robust z with the quantile spread.' },
        { kind: 'confirmed', data: 'SMD', config: 'quantile spread, 1 season, k 2, adapt robust (frozen on NAB)', score: { standard: 35.5, lowFp: 21.0, lowFn: 48.6 }, text: 'Generalised by the rule written in advance: over EWMA +25.1 [15.9, 37.6], over the static threshold +19.1 [4.0, 29.9]; event F1 0.330. 478 of 889 series had a daily or weekly season.' },
        { kind: 'held_out', data: 'NAB', config: 'MAD spread, 1 season, k 9, adapt robust (chosen on each half)', score: { standard: -76.4, lowFp: -223.3, lowFn: -26.2 }, text: 'Below a static threshold in aggregate.' },
        { kind: 'confirmed', data: 'SMD', config: 'MAD spread, frozen', score: { standard: -382.8, lowFp: -842.2, lowFn: -228.6 }, text: 'The hypothesis written in advance (the MAD below the static threshold) held.' },
      ],
    },
  },
  cusum: {
    name: 'cusum',
    inRules: true,
    goodFor: 'Explaining a level shift: "mean shifted from A to B at T". Use it for tickets and annotations.',
    notFor: 'Paging: 1,704 alarm events on held-out NAB, a false alarm every 195 points on pure noise, about 125 unmatched alarms per machine-day on SMD. Severity page is refused.',
    pageAllowed: false,
    defaultSeverity: 'info',
    defaults: {},
    required: [],
    evidence: {
      kind: 'held_out',
      defaultsValidated: false,
      nab: { standard: 15.1, lowFp: -51.2, lowFn: 38.8 },
      note: 'Below the static threshold on held-out NAB (standard and low-FP profiles) and on SMD in every profile; the library calls it an explanation, not a pager.',
      lines: [
        { kind: 'held_out', data: 'NAB', config: 'k 1, h 20 (chosen on each half)', score: { standard: 15.1, lowFp: -51.2, lowFn: 38.8 }, text: 'Recall 86%, event precision 15%.' },
        { kind: 'confirmed', data: 'SMD', config: 'k 1, h 20 (frozen)', score: { standard: -147.6, lowFp: -374.2, lowFn: -71.1 }, text: 'The hypothesis written in advance (CUSUM below the static threshold) held.' },
      ],
    },
  },
  stl: {
    name: 'stl',
    inRules: false,
    goodFor: 'A scheduled seasonal decomposition, and explanations from it.',
    notFor: 'Alarms: its residuals scored -352.2 on held-out NAB and -1,065.0 on SMD. Not available as a rule detector.',
    pageAllowed: false,
    defaultSeverity: null,
    defaults: {},
    required: [],
    evidence: {
      kind: 'held_out',
      defaultsValidated: false,
      nab: { standard: -352.2, lowFp: -795.4, lowFn: -203.5 },
      note: 'An explanation, not a pager. Needs a scheduled refit job, which is not built.',
      lines: [
        { kind: 'held_out', data: 'NAB', config: 'refit every period on 4 periods, k 9', score: { standard: -352.2, lowFp: -795.4, lowFn: -203.5 }, text: 'Below a static threshold.' },
        { kind: 'confirmed', data: 'SMD', config: 'the same, frozen', score: { standard: -1065.0, lowFp: -2207.2, lowFn: -683.4 }, text: 'The hypothesis written in advance (STL below the static threshold) held.' },
      ],
    },
  },
  pelt: {
    name: 'pelt',
    inRules: false,
    goodFor: 'Annotating where a series changed, offline (exact, 3.3 ms for a week at 5 min).',
    notFor: 'Online alarms: -123.5 on held-out NAB and -627.4 on SMD. Not available as a rule detector.',
    pageAllowed: false,
    defaultSeverity: null,
    defaults: {},
    required: [],
    evidence: {
      kind: 'held_out',
      defaultsValidated: false,
      nab: { standard: -123.5, lowFp: -321.3, lowFn: -55.9 },
      note: 'An explanation, not a pager.',
      lines: [
        { kind: 'held_out', data: 'NAB', config: 'rolling, minShift 8σ', score: { standard: -123.5, lowFp: -321.3, lowFn: -55.9 }, text: 'Below a static threshold.' },
        { kind: 'confirmed', data: 'SMD', config: 'the same, frozen', score: { standard: -627.4, lowFp: -1338.5, lowFn: -389.3 }, text: 'The hypothesis written in advance (PELT below the static threshold) held.' },
      ],
    },
  },
  burn_rate: {
    name: 'burn_rate',
    inRules: false,
    goodFor: 'SLO error-budget alerts (SRE Workbook multi-window, multi-burn-rate).',
    notFor: 'An anomaly rule: it needs good and total counts per bucket. Write an SLO rule instead (an `slo` block: objective, window, SLI), which raises these alerts.',
    pageAllowed: false,
    defaultSeverity: null,
    defaults: {},
    required: [],
    evidence: {
      kind: 'not_scorable',
      defaultsValidated: false,
      nab: null,
      note: 'Checked against every table of the SRE Workbook chapter, not on NAB or SMD (no SLO data).',
      lines: [{ kind: 'not_scorable', data: 'SRE Workbook', config: 'the workbook\'s four alerts', score: null, text: 'Reproduces every table of the chapter.' }],
    },
  },
}

/**
 * The detector the monitors API and rule files use when none is named and the rule does not page
 * (design D33, which replaces the earlier D33's EWMA): robust z with the quantile spread.
 */
export const DEFAULT_DETECTOR: AnomalyDetector = 'robust_z'
/**
 * With `severity: page` and no detector, the default is the static threshold: it beat EWMA when
 * false alarms cost most on both benchmarks, and the quantile spread's lead over it there is not
 * significant. It needs a level, so such a rule must give one.
 */
export const DEFAULT_PAGE_DETECTOR: AnomalyDetector = 'threshold'
export const DEFAULT_SEVERITY: AnomalySeverity = 'ticket'
/**
 * What an entry that left a field out was saved as before 2026-11-19 (the earlier D33), where that
 * differs from today. A rule saved again over a stored one keeps such a stored value
 * (`parseAnomalySpec`, contracts/rules.ts `AnomalySpecInput`). Fixed: never derived from today's
 * code, and checked against the stored rules that release wrote (test/fixtures/anomaly/).
 */
export const PREVIOUS_DEFAULTS: { detector: AnomalyDetector; params: Record<string, Record<string, AnomalyParamValue>> } = {
  detector: 'ewma',
  params: {
    robust_z: { spread: 'mad', windowPoints: 288, k: 3.5 },
    seasonal: { spread: 'mad', seasons: 4, k: 4 },
  },
}
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

/** Base64 characters of `n` Float64 values. */
const b64Chars = (n: number) => 4 * Math.ceil((8 * n) / 3)
/** Blocks of `ANOMALY_BLOCK` slots that `slots` consecutive slots can span. */
const blocksSpanned = (slots: number) => Math.ceil(Math.max(0, slots - 1) / ANOMALY_BLOCK) + 1

/**
 * Rough stored size of one series' state, for refusing at save what could not be stored. Runtime
 * checks the exact size. `version`: the `store.anomaly-state` version it will be written in (the
 * gate, `ANOMALY_STATE_WRITE`); robust z and seasonal are much smaller in version 2. Version 1's
 * size is also what the CPU and memory models of warm-ups and backtests are calibrated against
 * (`cpuStateBytes`): the detector's work and heap follow its points, not how they are stored.
 */
export function estimateStateBytes(d: AnomalyDetector, p: Record<string, AnomalyParamValue>, stepMs: number, version: 1 | 2 = ANOMALY_STATE_WRITE): number {
  // Labels, the last point and its explanation: the envelope every series carries.
  const envelope = 1200
  const n = (k: string) => (typeof p[k] === 'number' ? (p[k] as number) : 0)
  if (version === 2 && WINDOWED.has(d)) {
    // A head entry (the envelope and the detector's scalars) and, per block the window spans, an
    // entry of `ANOMALY_BLOCK` Float64 values in base64 with its key (`{"k":"<16>","x":"…"}`, and
    // `"r"` for seasonal's residuals). Independent of the values.
    if (d === 'robust_z') {
      const pts = n('windowMs') > 0 ? Math.ceil(n('windowMs') / Math.max(stepMs, 1)) : n('windowPoints')
      return envelope + 100 + blocksSpanned(pts) * (32 + b64Chars(ANOMALY_BLOCK))
    }
    const P = Math.round(n('periodMs') / Math.max(stepMs, 1))
    const R = Math.max(1, Math.floor(n('seasons'))) * P + 1
    const Rr = Math.round((n('residualWindowMs') > 0 ? n('residualWindowMs') : Math.max(n('periodMs'), 100 * stepMs)) / Math.max(stepMs, 1)) + 1
    return envelope + 200 + blocksSpanned(Math.max(R, Rr)) * (39 + 2 * b64Chars(ANOMALY_BLOCK))
  }
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

/**
 * The size the CPU and memory models of warm-ups and backtests price a rule's state at: its version 1
 * estimate, against which they were calibrated (`history.ts` `CPU`, `MEMORY`). Not the stored size:
 * robust z and seasonal scan their window at every point however it is stored, and a run holds the
 * detector's own state in memory, never the stored rows.
 */
export function cpuStateBytes(rule: Pick<AnomalyRuleV2, 'anomaly'>, intervalMs: number): number {
  return estimateStateBytes(rule.anomaly.detector, rule.anomaly.params, intervalMs, 1)
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

/** A score from the guide's evidence lines, so that a warning quotes the guide's own numbers (one copy). */
function evidenceScore(detector: string, data: 'NAB' | 'SMD', config: string, profile: 'standard' | 'lowFp' = 'standard'): number {
  const line = DETECTOR_GUIDE[detector]?.evidence.lines?.find((l) => l.data === data && l.config.startsWith(config))
  if (!line?.score) throw new Error(`DETECTOR_GUIDE has no ${data} score for ${detector} "${config}"`)
  return line.score[profile]
}

/**
 * The `anomaly` block of a rule-file entry, at `path`. Returns the normalized spec, or null
 * after reporting what is wrong. `labels` are the rule's labels (group labels merged in); the
 * severity label is checked against the block's severity.
 *
 * `prior` is the stored rule this entry is saved over (the same group, and the same monitor id, or
 * the same name and expression: `rules.ts`), if any. A field the entry leaves out keeps the prior's
 * value when that value was the default of the release that stored it and today's default differs
 * (`PREVIOUS_DEFAULTS`): saving an unchanged rule again never changes what it does, whatever the
 * defaults have become since (contracts/rules.ts `AnomalySpecInput`, design D33).
 */
export function parseAnomalySpec(c: ParseContext, v: unknown, path: string, intervalMs: number, forMs: number, labels: Labels, cfg: RulerConfig, prior: Pick<AnomalySpec, 'detector' | 'params'> | null = null): AnomalySpec | null {
  const errors: ValidationError[] = []
  const err = (p: string, message: string, fix: string) => errors.push({ path: p, message, fix })
  if (!isObject(v)) {
    c.err(path, 'anomaly must be an object', 'Give {} for the default detector, or leave the field out for an ordinary alerting rule.')
    return null
  }
  const FIELDS = ['detector', 'params', 'unit', 'severity', 'max_series', 'given']
  for (const k of Object.keys(v)) if (!FIELDS.includes(k)) err(`${path}.${k}`, `unknown field "${k}"`, `An anomaly block has: ${FIELDS.filter((f) => f !== 'given').join(', ')}.`)

  // The severity as given (in the block, or as the rule's severity label); its default depends on the detector.
  let givenSeverity: AnomalySeverity | null = null
  if (v.severity !== undefined) {
    if (typeof v.severity !== 'string' || !SEVERITIES.includes(v.severity as AnomalySeverity)) err(`${path}.severity`, `severity must be one of ${SEVERITIES.join(', ')}`, 'Use "ticket" unless a person must be woken; "page" only for detectors that may page.')
    else givenSeverity = v.severity as AnomalySeverity
  } else if (typeof labels.severity === 'string' && SEVERITIES.includes(labels.severity as AnomalySeverity)) {
    givenSeverity = labels.severity as AnomalySeverity
  }

  let detector: AnomalyDetector
  /** Fields left out that keep the stored rule's value (`prior`), for the warning. */
  const kept: string[] = []
  if (v.detector === undefined) {
    detector = givenSeverity === 'page' ? DEFAULT_PAGE_DETECTOR : DEFAULT_DETECTOR
    // Saved again over a rule stored with the earlier default (EWMA): it stays EWMA, unless the
    // parameters given are not EWMA's (then the entry describes another detector).
    const named = isObject(v.params) ? Object.keys(v.params) : []
    if (prior && givenSeverity !== 'page' && prior.detector !== detector && prior.detector === PREVIOUS_DEFAULTS.detector && named.every((k) => k in libraryDefaults(prior.detector))) {
      detector = prior.detector
      kept.push('detector')
    }
  } else if (typeof v.detector !== 'string' || !(ANOMALY_DETECTORS as readonly string[]).includes(v.detector)) {
    const guide = typeof v.detector === 'string' ? DETECTOR_GUIDE[v.detector] : undefined
    err(`${path}.detector`, guide && !guide.inRules ? `"${v.detector}" cannot run in a rule: ${guide.notFor}` : `unknown detector ${JSON.stringify(v.detector)}`, `Use one of ${ANOMALY_DETECTORS.join(', ')}; ${DEFAULT_DETECTOR} is the default.`)
    detector = DEFAULT_DETECTOR
  } else detector = v.detector as AnomalyDetector
  const guide = DETECTOR_GUIDE[detector] as DetectorGuide
  // A detector that explains rather than pages (cusum) defaults to `info`.
  const severity: AnomalySeverity = givenSeverity ?? guide.defaultSeverity ?? DEFAULT_SEVERITY
  if (labels.severity !== undefined && labels.severity !== severity) {
    err(`${path}.severity`, `the severity label "${labels.severity}" and anomaly.severity "${severity}" differ`, 'Set the severity once, in anomaly.severity.')
  }

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
  // The guide's defaults for robust_z and seasonal are the quantile spread's configuration; with
  // spread "mad" given, the library's own defaults apply, as they did before 2026-11-19.
  if (given.includes('spread') && params.spread === 'mad') {
    const lib = libraryDefaults(detector)
    for (const k of Object.keys(guide.defaults)) if (!given.includes(k) && k in lib) params[k] = lib[k] as AnomalyParamValue
  }
  // Saved again over a rule of the same detector: a parameter left out keeps its stored value when
  // that was the earlier default and today's differs (a rule saved before 2026-11-19 with the MAD).
  if (prior && prior.detector === detector) {
    for (const [k, old] of Object.entries(PREVIOUS_DEFAULTS.params[detector] ?? {})) {
      if (given.includes(k) || prior.params[k] !== old || params[k] === old) continue
      params[k] = old
      kept.push(k)
    }
  }

  // What each detector needs to be meaningful.
  if (detector === 'threshold' && typeof params.above !== 'number' && typeof params.below !== 'number') {
    err(`${path}.params`, 'a threshold needs params.above or params.below', severity === 'page' && v.detector === undefined
      ? 'With severity "page" and no detector the default is a static threshold, because it held up best where false alarms cost most (low-FP profile: NAB held out 5.5 vs EWMA 3.9; SMD 15.5 vs EWMA -38.4). Give the level (params.above / params.below), or name another detector and accept more false pages.'
      : 'Give the level the value must not cross, e.g. { "above": 500 }.')
  }
  if (detector === 'seasonal') {
    const period = params.periodMs
    if (typeof period !== 'number' || period <= 0) err(`${path}.params.periodMs`, 'seasonal needs params.periodMs, the season length', 'Use 86400000 for a daily season or 604800000 for a weekly one.')
    else if (period < 2 * intervalMs) err(`${path}.params.periodMs`, `a season of ${formatDuration(period)} is less than two evaluations at ${formatDuration(intervalMs)}`, 'Lengthen the season or shorten the group interval.')
  }
  if (severity === 'page' && !guide.pageAllowed) {
    err(`${path}.severity`, `${detector} may not page: ${guide.notFor}`, 'Use severity "ticket" or "info", or detector "threshold" (with the level) to page.')
  }

  if (errors.length > 0) {
    for (const e of errors) c.err(e.path, e.message, e.fix)
    return null
  }

  const history = historyOf(detector, params, intervalMs, cfg)
  const stateBytesPerSeries = estimateStateBytes(detector, params, intervalMs)
  if (stateBytesPerSeries > limits.maxAnomalyStateBytesPerSeries) {
    const confirmed = detector === 'robust_z' && params.spread === 'quantile' && params.windowPoints === ROBUST_Z_CONFIRMED.windowPoints && !(typeof params.windowMs === 'number' && params.windowMs > 0)
    c.err(
      `${path}.params`,
      `${detector} with these parameters keeps about ${stateBytesPerSeries} bytes of state per series at a ${formatDuration(intervalMs)} interval; the limit is ${limits.maxAnomalyStateBytesPerSeries}` +
        (confirmed ? `. This is the configuration frozen on NAB and confirmed on SMD (${evidenceScore('robust_z', 'SMD', 'quantile spread, window 4,000')}); its window is over this ruler's per-series state limit` : ''),
      detector === 'seasonal'
        ? 'Use a coarser interval (rollups) for long seasons, or fewer seasons.'
        : detector === 'robust_z'
          ? `Use a shorter window: windowPoints ${ROBUST_Z_DEFAULTS.windowPoints}, the default, is the largest whose state fits 65,536 bytes a series for any values (NAB held out ${evidenceScore('robust_z', 'NAB', 'quantile spread, window 1,500')}, SMD ${evidenceScore('robust_z', 'SMD', 'quantile spread, window 1,500')} post hoc). A longer window needs the operator to raise RulerLimits.maxAnomalyStateBytesPerSeries.`
          : 'Use a shorter window.',
    )
    return null
  }
  const fits = Math.max(1, Math.floor(limits.maxAnomalyStateBytesPerRule / stateBytesPerSeries))
  if (v.max_series === undefined && fits < maxSeries) {
    // Not given: the default is what fits the per-rule limit, said once at save. Still a cap, never a drop.
    maxSeries = fits
    c.warn(`${path}.max_series`, `max_series defaults to ${fits} here, not ${DEFAULT_MAX_SERIES}: ${detector} with these parameters may keep about ${stateBytesPerSeries} bytes of state per series, and a rule may keep ${limits.maxAnomalyStateBytesPerRule}`, `Make sure the expression returns at most ${fits} series (an evaluation with more is refused), or set max_series.`)
  }
  if (stateBytesPerSeries * maxSeries > limits.maxAnomalyStateBytesPerRule) {
    c.err(`${path}.max_series`, `${maxSeries} series × about ${stateBytesPerSeries} bytes of state each would exceed the ${limits.maxAnomalyStateBytesPerRule}-byte limit per rule`, `Lower max_series to ${fits}, or aggregate the expression.`)
    return null
  }

  // Kept from the stored rule rather than today's default: said at every such save.
  if (kept.length > 0) {
    const what = kept.map((k) => (k === 'detector' ? `detector ${detector}` : `${k} ${JSON.stringify(params[k])}`)).join(', ')
    const today = kept.includes('detector') ? `${DEFAULT_DETECTOR} with the quantile spread` : kept.map((k) => `${k} ${JSON.stringify(guide.defaults[k] ?? libraryDefaults(detector)[k])}`).join(', ')
    c.warn(`${path}.${kept.includes('detector') ? 'detector' : 'params'}`, `this rule keeps ${what}, the default when it was saved; a new rule would get ${today} (design D33)`, 'Name them to keep them and silence this warning, or name today\'s values to change the rule (its detector state then starts again).')
  }
  // Accepted, but against the evidence or likely not what was meant.
  const thresholdNab = evidenceScore('threshold', 'NAB', 'level')
  const thresholdSmd = evidenceScore('threshold', 'SMD', 'level')
  const defaultNab = evidenceScore('robust_z', 'NAB', 'quantile spread, window 1,500')
  const defaultSmd = evidenceScore('robust_z', 'SMD', 'quantile spread, window 1,500')
  if ((detector === 'robust_z' || detector === 'seasonal') && params.spread === 'mad') {
    c.warn(`${path}.params.spread`, `${detector} with the MAD spread scored below a static threshold on held-out NAB (${evidenceScore(detector, 'NAB', 'MAD spread')} vs ${thresholdNab}) and on SMD (${evidenceScore(detector, 'SMD', 'MAD spread')} vs ${thresholdSmd})`, 'On heavy-tailed series the MAD describes only the bulk, and routine spikes score 20+ robust σ. Leave spread out for the quantile spread.')
  }
  if (detector === 'cusum') {
    c.warn(`${path}.detector`, `cusum scored below a static threshold on held-out NAB (${evidenceScore('cusum', 'NAB', 'k 1')} vs ${thresholdNab}) and on SMD (${evidenceScore('cusum', 'SMD', 'k 1')} vs ${thresholdSmd})`, 'It explains a level shift; use it for tickets and annotations. For alarms, leave the detector out.')
  }
  if (detector === 'ewma') {
    c.warn(`${path}.detector`, `on SMD, data never used to choose it, ewma scored below a static threshold in every profile (${evidenceScore('ewma', 'SMD', 'half-life 100')} vs ${thresholdSmd}; held-out NAB ${evidenceScore('ewma', 'NAB', 'half-life 100')} vs ${thresholdNab})`, `Leave the detector out for robust z with the quantile spread (held-out NAB ${defaultNab}, SMD ${defaultSmd} post hoc); page on a static threshold.`)
  }
  if (severity === 'page' && detector !== 'threshold') {
    const low = detector === 'ewma' ? `EWMA was below a static threshold in the low-false-positive profile on held-out NAB (${evidenceScore('ewma', 'NAB', 'half-life 100', 'lowFp')} vs ${evidenceScore('threshold', 'NAB', 'level', 'lowFp')}) and on SMD (${evidenceScore('ewma', 'SMD', 'half-life 100', 'lowFp')} vs ${evidenceScore('threshold', 'SMD', 'level', 'lowFp')})` : `on SMD, ${detector}'s lead over a static threshold in the low-false-positive profile is not significant, and it raised several times the threshold's unmatched alarms per machine-day`
    c.warn(`${path}.severity`, low, `Page on a static threshold; send ${detector} alerts as tickets.`)
  }
  if (detector === 'ewma' && typeof params.acceptAfter === 'number' && forMs > params.acceptAfter * intervalMs) {
    c.warn(`${path}.for`, `EWMA accepts a new level after ${params.acceptAfter} anomalous points (${formatDuration(params.acceptAfter * intervalMs)} here), so a level shift may stop being flagged before "for" (${formatDuration(forMs)}) is satisfied`, 'Alarms are onsets: use a short "for" and keep_firing_for to hold the alert.')
  }
  if (history.minPoints * intervalMs > 24 * 3_600_000) {
    c.warn(`${path}.detector`, `the detector scores nothing until it has seen ${history.minPoints} points (${formatDuration(history.minPoints * intervalMs)})`, 'A new rule is warmed from that much history when the read fits the warm-up budget; otherwise expect it to report "warming" for that long.')
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
    /** How the point at `ts` was scored, so that a replay of that tick reports it the same way. */
    status: 'ok' | 'warming' | 'missing'
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
  /**
   * Set when the stored rows are in a format this release does not read (a newer release wrote
   * them): the rule is refused (`state_unreadable`) and `rawRows` are kept, unchanged, for a
   * release that reads them, including when the group moves to another shard.
   */
  unreadable: string | null
  rawRows: string[] | null
  /** What is known of the stored rows (their format, and for version 2 their blocks' sizes): what a tick writes is planned from it. */
  store: StoreMeta
}

export function emptyStatus(maxSeries: number): AnomalyRuleStatus {
  return { status: 'unknown', message: null, series: 0, maxSeries, scored: 0, warming: 0, missing: 0, anomalous: 0, stateSeries: 0, stateBytes: 0, pruned: 0 }
}

export function newAnomalyRt(rule: AnomalyRuleV2): AnomalyRt {
  return { series: new Map(), json: new Map(), status: emptyStatus(rule.anomaly.maxSeries), pruned: 0, unreadable: null, rawRows: null, store: emptyStore() }
}

export type AnomalyEval =
  | {
      ok: true
      /** The rule's series state after this tick (a new map; `prev` is untouched). */
      next: Map<string, SeriesState>
      /** Version 1: each series' stored JSON (empty when the rule is written as version 2). */
      json: Map<string, string>
      /** The rows to write if the tick commits (null for a run over history: `serialize` false). */
      write: AnomalyWrite | null
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
 *
 * `serialize: false` (a run over history: a warm-up or a backtest) skips writing each series'
 * stored form and the size limits at every point; the caller serialises once at the end
 * (`serializeAnomaly`). The detector and everything it decides are the same.
 */
export function evalAnomaly(rule: AnomalyRuleV2, prev: AnomalyRt, series: Series[], ts: number, intervalMs: number, limits: AnomalyLimits, ruleAnnotations: Record<string, string>, serialize = true, writeVersion: 1 | 2 = ANOMALY_STATE_WRITE): AnomalyEval {
  const spec = rule.anomaly
  const base: AnomalyRuleStatus = { ...emptyStatus(spec.maxSeries), series: series.length, pruned: prev.pruned }
  const refuse = (status: 'series_cap_exceeded' | 'state_limit_exceeded' | 'state_unreadable', message: string): AnomalyEval => ({
    ok: false,
    error: message,
    status: { ...prev.status, ...base, status, message, stateSeries: prev.series.size, stateBytes: storedBytes(prev) },
  })
  if (!(ANOMALY_DETECTORS as readonly string[]).includes(spec.detector)) {
    // A stored rule naming a detector this release does not know (a newer release saved it):
    // refused, never run as another detector (contracts/rules.ts, `AnomalyDetector`).
    return { ok: false, error: `unsupported_detector: this release does not know the detector ${JSON.stringify(spec.detector)}; a newer release saved this rule. Nothing was scored and no state or alert changed.`, status: { ...prev.status, series: series.length, message: `unsupported detector ${JSON.stringify(spec.detector)}` } }
  }
  if (prev.unreadable !== null) {
    // Refuse rather than guess (COMPATIBILITY.md §3.2): starting cold would resolve firing alerts
    // and overwrite state a newer release will want back.
    return refuse('state_unreadable', `state_unreadable: ${prev.unreadable}. A newer release wrote this rule's detector state; it is kept unchanged and nothing is scored until a release that reads it runs here.`)
  }
  if (series.length > spec.maxSeries) {
    return refuse('series_cap_exceeded', `series_cap_exceeded: the expression returned ${series.length} series; this rule scores at most ${spec.maxSeries} (max_series). Nothing was scored and no state or alert changed. Aggregate the expression or raise max_series (limit ${limits.maxAnomalySeriesPerRule}).`)
  }
  const det = DETECTORS[spec.detector] as unknown as { detect(s: { ts: Float64Array; values: Float64Array }, p: unknown, st: unknown): { points: { status: string; anomalous: boolean; value: number | null; score: number; explanation?: Explanation }[]; state: unknown; summary: { message?: string } } }
  const params = { ...spec.params, stepMs: intervalMs, unit: spec.unit }
  const next = new Map(prev.series)
  const json = new Map(prev.json)
  const flagged: (Series & { annotations: Record<string, string> })[] = []
  const seen = new Set<string>()
  // Version 2 for a windowed detector when the gate says so; version 1 JSON otherwise.
  const v2 = writeVersion === 2 && WINDOWED.has(spec.detector)
  /** Series whose detector state changed (a new point): what version 2 writes blocks for. */
  const touched = new Set<string>()
  const counts = { scored: 0, warming: 0, missing: 0, anomalous: 0 }
  let warmingMessage: string | null = null
  let changed = false
  for (const s of series) {
    // The series' identity: a hash of all its labels (`fingerprint`, a stored format: id.hashes).
    const key = fingerprint(s.metric)
    if (seen.has(key)) return { ok: false, error: 'vector contains metrics with the same labelset', status: { ...prev.status, ...base, status: prev.status.status, message: 'duplicate series' } }
    seen.add(key)
    const before = prev.series.get(key)
    let entry: SeriesState
    if (before?.last && before.last.ts >= ts) {
      // A replayed tick (an alarm retried, or re-run after eviction): reproduce its outcome.
      entry = before
      const st = before.last.status
      if (st === 'missing') counts.missing++
      else if (st === 'warming') {
        counts.warming++
        warmingMessage ??= `needs ${spec.history.minPoints} points before scoring`
      } else counts.scored++
    } else {
      const r = det.detect({ ts: Float64Array.of(ts), values: Float64Array.of(s.value) }, params, before?.state ?? null)
      const p = r.points[0]!
      if (p.status === 'missing') {
        // NaN or ±Inf: not scored, and a gap is not a recovery: keep the previous flag.
        counts.missing++
        entry = { labels: s.metric, state: before?.state ?? r.state, last: before?.last ? { ...before.last, ts, status: 'missing' } : { ts, status: 'missing', flag: false, value: null, score: 0, explanation: null }, seenAt: ts }
      } else {
        if (p.status === 'warming') {
          counts.warming++
          warmingMessage ??= r.summary.message ?? `needs ${spec.history.minPoints} points before scoring`
        } else counts.scored++
        entry = { labels: s.metric, state: r.state, last: { ts, status: p.status === 'warming' ? 'warming' : 'ok', flag: p.status === 'ok' && p.anomalous, value: p.value, score: p.score, explanation: p.anomalous ? (p.explanation ?? null) : null }, seenAt: ts }
      }
      next.set(key, entry)
      if (entry.state !== before?.state) touched.add(key)
      if (serialize && !v2) json.set(key, entryJson(key, entry))
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
  let write: AnomalyWrite | null = null
  if (serialize) {
    // Rows in another format than this tick writes (or to renumber) are rewritten at this tick.
    if (prev.store.version !== null && (prev.store.version !== (v2 ? 2 : 1) || prev.store.rewrite)) changed = true
    write = (v2 ? planV2(spec.detector, intervalMs, windowMsOf(rule, intervalMs), prev.store, next, touched, false) : null) ?? planV1(fillJson(json, next), prev.store)
    for (const [key, bytes] of write.perSeries) {
      if (bytes > limits.maxAnomalyStateBytesPerSeries) {
        return refuse('state_limit_exceeded', `state_limit_exceeded: the detector state of one series (${key.slice(0, 120)}) is ${bytes} bytes; the limit is ${limits.maxAnomalyStateBytesPerSeries}. Nothing was scored and no state or alert changed.`)
      }
    }
    total = write.bytes
    if (total > limits.maxAnomalyStateBytesPerRule) {
      return refuse('state_limit_exceeded', `state_limit_exceeded: the rule's detector state would be ${total} bytes for ${next.size} series; the limit is ${limits.maxAnomalyStateBytesPerRule}. Nothing was scored and no state or alert changed. Lower max_series or aggregate the expression.`)
    }
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
  return { ok: true, next, json: write && write.store.version === 2 ? new Map() : json, write, flagged, present: series, status, changed, pruned }
}

/**
 * Every row of a rule's state, written whole (a warm-up, a shard move, an import): version 2 for a
 * windowed detector while the gate is 2, else version 1. `json`: version 1 entries already
 * serialised, reused.
 */
export function fullAnomalyWrite(rule: AnomalyRuleV2, intervalMs: number, series: Map<string, SeriesState>, writeVersion: 1 | 2 = ANOMALY_STATE_WRITE, json: Map<string, string> = new Map()): AnomalyWrite & { json: Map<string, string> } {
  const v2 = writeVersion === 2 && WINDOWED.has(rule.anomaly.detector) ? planV2(rule.anomaly.detector, intervalMs, windowMsOf(rule, intervalMs), emptyStore(), series, new Set(), true) : null
  if (v2) return { ...v2, json: new Map() }
  const filled = fillJson(new Map([...json].filter(([k]) => series.has(k))), series)
  return { ...planV1(filled, { ...emptyStore(), version: 2 }), json: filled }
}

/** After a run over history: every series' stored form, within the limits, or why not. */
export function serializeAnomaly(rule: AnomalyRuleV2, intervalMs: number, series: Map<string, SeriesState>, limits: AnomalyLimits, writeVersion: 1 | 2 = ANOMALY_STATE_WRITE): { ok: true; write: AnomalyWrite; json: Map<string, string>; bytes: number } | { ok: false; error: string } {
  const write = fullAnomalyWrite(rule, intervalMs, series, writeVersion)
  for (const [key, bytes] of write.perSeries) {
    if (bytes > limits.maxAnomalyStateBytesPerSeries) return { ok: false, error: `state_limit_exceeded: the detector state of one series (${key.slice(0, 120)}) would be ${bytes} bytes; the limit is ${limits.maxAnomalyStateBytesPerSeries}` }
  }
  if (write.bytes > limits.maxAnomalyStateBytesPerRule) return { ok: false, error: `state_limit_exceeded: the rule's detector state would be ${write.bytes} bytes for ${series.size} series; the limit is ${limits.maxAnomalyStateBytesPerRule}` }
  return { ok: true, write, json: write.json, bytes: write.bytes }
}

/** robust_z's window in ms as the detector computes it for this rule (version 2 drops points it has evicted); null for other detectors. */
export function windowMsOf(rule: Pick<AnomalyRuleV2, 'anomaly'>, intervalMs: number): number | null {
  if (rule.anomaly.detector !== 'robust_z') return null
  const d = DETECTORS.robust_z.defaults as unknown as Record<string, number>
  const p = rule.anomaly.params
  const windowMs = typeof p.windowMs === 'number' ? p.windowMs : d.windowMs!
  const windowPoints = typeof p.windowPoints === 'number' ? p.windowPoints : d.windowPoints!
  return windowMs > 0 ? windowMs : windowPoints * intervalMs
}

/** Version 1 entries for every series that has none yet (rows read as version 2, or not serialised). */
function fillJson(json: Map<string, string>, series: Map<string, SeriesState>): Map<string, string> {
  for (const [key, s] of series) if (!json.has(key)) json.set(key, entryJson(key, s))
  return json
}

/** Version 1 rows of `json`: every row rewritten (and every row of another format deleted first). */
function planV1(json: Map<string, string>, prev: StoreMeta): AnomalyWrite {
  const rows = stateRows(json)
  const perSeries = new Map<string, number>()
  let bytes = 0
  for (const [k, j] of json) {
    const n = byteLength(j)
    perSeries.set(k, n)
    bytes += n
  }
  return {
    purge: prev.version === 2 || prev.rewrite,
    upserts: rows.map((body, chunk) => ({ chunk, body })),
    deletes: [],
    deleteFrom: rows.length,
    store: { ...emptyStore(), version: rows.length > 0 ? 1 : null },
    bytes,
    perSeries,
  }
}

/** Stored bytes of a rule's state as last committed. */
function storedBytes(rt: AnomalyRt): number {
  if (rt.store.version === 2) {
    let n = 0
    for (const b of rt.store.rows.values()) n += b
    return n
  }
  let n = 0
  for (const j of rt.json.values()) n += byteLength(j)
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
 * (COMPATIBILITY.md §3.2): the caller marks the rule `state_unreadable` and keeps the rows as they
 * are; it never starts the rule cold over them.
 */
export function readStateRows(bodies: string[]): { series: Map<string, SeriesState>; json: Map<string, string> } | { error: string } {
  const series = new Map<string, SeriesState>()
  const json = new Map<string, string>()
  for (const body of bodies) {
    let row: { v?: unknown; series?: unknown }
    try {
      row = JSON.parse(body) as { v?: unknown; series?: unknown }
    } catch {
      return { error: 'an anomaly_state row is not JSON' }
    }
    if (row.v !== ANOMALY_STATE_VERSION || !Array.isArray(row.series)) return { error: `anomaly_state row version ${JSON.stringify(row.v)} is not ${ANOMALY_STATE_VERSION}` }
    for (const e of row.series as { k: string; l: Labels; s: unknown; last: SeriesState['last']; seen: number }[]) {
      const s: SeriesState = { labels: e.l, state: e.s, last: e.last, seenAt: e.seen }
      series.set(e.k, s)
      json.set(e.k, entryJson(e.k, s))
    }
  }
  return { series, json }
}

/**
 * Rebuild a rule's state from its rows, `{"v":1}` or `{"v":2}` (`chunk` as stored). A row in a
 * version this code does not read, rows of both versions together, or a version 2 row that is not
 * what the format says, are refused (COMPATIBILITY.md §3.2): the caller marks the rule
 * `state_unreadable` and keeps the rows as they are; it never starts the rule cold over them. Rows
 * of the other format than the next tick writes, or under chunk numbers another release gave them,
 * are rewritten whole at that tick (`store.rewrite`, or `store.version`).
 */
export function readAnomalyRows(rows: { chunk: number; body: string }[]): { series: Map<string, SeriesState>; json: Map<string, string>; store: StoreMeta } | { error: string } {
  const parsed: { chunk: number; body: Record<string, unknown>; text: string }[] = []
  const versions = new Set<unknown>()
  for (const r of rows) {
    let body: unknown
    try {
      body = JSON.parse(r.body)
    } catch {
      return { error: 'an anomaly_state row is not JSON' }
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return { error: 'an anomaly_state row is not a JSON object' }
    const v = (body as { v?: unknown }).v
    if (v !== ANOMALY_STATE_VERSION && v !== 2) return { error: `anomaly_state row version ${JSON.stringify(v)} is not 1 or 2` }
    versions.add(v)
    parsed.push({ chunk: r.chunk, body: body as Record<string, unknown>, text: r.body })
  }
  if (versions.size > 1) return { error: 'anomaly_state holds rows of versions 1 and 2 for one rule' }
  if (versions.has(2)) {
    const read = readV2(parsed)
    return 'error' in read ? read : { ...read, json: new Map() }
  }
  const read = readStateRows(rows.map((r) => r.body))
  return 'error' in read ? read : { ...read, store: { ...emptyStore(), version: rows.length > 0 ? 1 : null } }
}
