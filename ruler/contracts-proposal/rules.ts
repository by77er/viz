/**
 * PROPOSED contract: rules, alert state, and notifications (design §7, decision D7).
 *
 * Proposed by `ruler/`; meant to move to `contracts/rules.ts` (the import below then becomes
 * `./engine`). Two Durable Object classes implement it:
 *
 *   Ruler      one per tenant rule shard, named `<tenant>/<n>`. Holds rule groups, evaluates
 *              them on one alarm, owns alert state, hands alert transitions to the Notifier.
 *   Notifier   one per tenant, named `<tenant>`. Alertmanager's model: routing tree,
 *              grouping timers, inhibition, silences, and a transactional outbox to receivers.
 *
 * Conventions:
 * - All times are Unix milliseconds unless a field says otherwise. Durations in *input*
 *   documents (rule files, notifier config) are Prometheus duration strings ("5m"); in
 *   normalized objects and results they are milliseconds with an `Ms` suffix.
 * - Every RPC takes the tenant first. It comes from the caller's credential. An object
 *   whose name does not belong to that tenant answers `{ status: 'wrong_tenant' }` and
 *   touches nothing.
 * - Nothing here throws for bad input: results are discriminated on `status`.
 * - Every RPC may answer `Refused` (`wrong_tenant`, or `schema_too_new` during a deploy or a
 *   rollback: contracts/COMPATIBILITY.md).
 *
 * Versions: 1 is the shape above without the members marked "contract version 2". Version 2
 * (2026-11-19) adds anomaly rules, additively: new optional fields, new types, one new enum value
 * (`'anomaly'` in `RuleStatus.kind` and `SavedRule.kind`, which callers must not act on as another
 * kind). Every rule file and stored group valid under version 1 is valid and means the same.
 * Version 3 (2026-11-19, additively, decision D39): `WebhookConfig.format` and the plain JSON
 * notification body (`JsonNotification`), and the reserved receiver `CONTROL_RECEIVER` through
 * which the destination a person set in control (`contracts/control.ts`) is reached. A config
 * valid under version 2 is valid and means the same (`format` defaults to `alertmanager`).
 * Version 4 (2026-11-19, additively): SLO burn-rate rules (an alerting entry with an `slo` block,
 * kept in the new optional `RuleGroup.sloRules`; one new enum value `'slo'` in `RuleStatus.kind`
 * and `SavedRule.kind`, which callers must not act on as another kind), warming detector state
 * from history (`WarmupStatus`, on the status of anomaly and SLO rules), and five optional
 * `RulerLimits`. Every rule file, stored group and config valid under version 3 is valid and
 * means the same.
 */

import type { PromScalar, PromVector } from '../../contracts/engine'
import type { SchemaTooNew } from '../../contracts/schema'

// ───────────────────────────── injected dependencies ─────────────────────────────

/**
 * What the ruler needs from the query engine. Bound to ONE tenant by whoever constructs it;
 * `timeMs` is the evaluation time (already shifted by the group's `query_offset`).
 * A rejected promise is an evaluation error: the rule is marked `health: 'err'` and its
 * alert state is left exactly as it was.
 */
export interface Evaluator {
  instant(promql: string, timeMs: number): Promise<PromVector | PromScalar>
}

/** One sample produced by a recording rule. `value` is the Prometheus text form, never re-encoded. */
export interface RecordedSample {
  labels: Record<string, string>
  timeMs: number
  value: string
}

/** The output of one recording rule at one evaluation time. */
export interface SampleBatch {
  /**
   * `<tenant>/<shard>/<group>/<rule key>@<evaluation time ms>`. The same rule evaluated at
   * the same time always produces the same id, so a sink that remembers ids makes the
   * ruler's at-least-once delivery effectively once.
   */
  id: string
  samples: RecordedSample[]
}

/** Where recording-rule output goes (the ingest path in production). Rejecting means "not written". */
export interface Sink {
  write(batches: SampleBatch[]): Promise<void>
}

// ───────────────────────────── rule files (input) ─────────────────────────────

/** The Prometheus rule-file document, as JSON. Unknown fields are rejected. */
export interface RuleFile {
  groups: RuleGroupInput[]
}

export interface RuleGroupInput {
  name: string
  /** Default: the ruler's `defaultIntervalMs`. */
  interval?: string
  /** Evaluate the queries this far in the past; alert timing still uses the tick time. */
  query_offset?: string
  /** Max alerts an alerting rule, or series a recording rule, may produce. 0 = the tenant cap only. */
  limit?: number
  /** Labels added to every rule in the group; a rule's own label wins. */
  labels?: Record<string, string>
  /**
   * EXTENDED (contract version 2): an entry may also be an `AnomalyRuleInput` (an alerting entry with
   * an `anomaly` block). EXTENDED (contract version 4): or an `SloRuleInput` (with an `slo` block).
   */
  rules: (AlertingRuleInput | RecordingRuleInput | AnomalyRuleInput | SloRuleInput)[]
}

export interface AlertingRuleInput {
  alert: string
  expr: string
  for?: string
  keep_firing_for?: string
  labels?: Record<string, string>
  annotations?: Record<string, string>
}

export interface RecordingRuleInput {
  record: string
  expr: string
  labels?: Record<string, string>
}

// ───────────────────────────── normalized rules ─────────────────────────────

/** Which storage a rule's expression has to read (design §7). */
export type CostClass = 'tail' | 'recent' | 'rollup'

export interface RuleCost {
  class: CostClass
  /** The furthest the expression reads back from its evaluation time. */
  windowMs: number
  /** One sentence a UI can show next to the class. */
  reason: string
}

export interface AlertingRule {
  kind: 'alert'
  name: string
  expr: string
  forMs: number
  keepFiringForMs: number
  labels: Record<string, string>
  annotations: Record<string, string>
  /** Identity of the rule within its group: hash of name, expression and labels. Alert state follows the key across saves. */
  key: string
  cost: RuleCost
}

export interface RecordingRule {
  kind: 'record'
  name: string
  expr: string
  labels: Record<string, string>
  key: string
  cost: RuleCost
}

export type Rule = AlertingRule | RecordingRule

export interface RuleGroup {
  name: string
  intervalMs: number
  queryOffsetMs: number
  limit: number
  rules: Rule[]
  /**
   * EXTENDED (contract version 2). The group's anomaly rules, evaluated in the same tick and the
   * same batch as `rules`, after them. Absent means none. They are kept out of `rules` on purpose:
   * a release that predates anomaly rules reads `rules` only, so it never evaluates one as a plain
   * alerting rule (which would fire for every series) or as a recording rule (see "anomaly rules").
   */
  anomalyRules?: AnomalyRule[]
  /**
   * EXTENDED (contract version 4). The group's SLO burn-rate rules, evaluated in the same tick and
   * the same batch, after the anomaly rules. Absent means none. Kept out of `rules` and
   * `anomalyRules` for the same reason: a release that predates them never evaluates one as
   * another kind (see "SLO burn-rate rules").
   */
  sloRules?: SloRule[]
}

/** A problem with a document, addressed so a UI can point at it. */
export interface ValidationError {
  /** e.g. `groups[0].rules[2].annotations.summary`. */
  path: string
  message: string
  /** What to change. */
  fix: string
}

// ───────────────────────────── anomaly rules (contract version 2) ─────────────────────────────
//
// ADDED 2026-11-19, additively (contracts/COMPATIBILITY.md §4): nothing above changes meaning.
// A rule file without an `anomaly` block means what it meant; a stored group without
// `anomalyRules` is read as having none.
//
// An anomaly rule watches every series of one PromQL expression with a detector from
// `anomaly/` (its `DETECTORS`). Each tick the ruler evaluates the expression through its
// ordinary batch call, feeds each series' value to that series' detector state, and treats the
// series the detector flags as the rule's result: from there `for`, `keep_firing_for`, the
// no-data policy, alert state, the hand-off and the notifier are those of an alerting rule.
// A flagged alert carries the detector's sentence and the numbers behind it
// (`ANOMALY_ANNOTATION`, `ANOMALY_DETAIL_ANNOTATION`) and its severity as the `severity` label.
//
// DEFAULTS CHANGED 2026-11-19 (design D33, which replaces the earlier D33), with no version
// change: the stored form is the same, and every default is resolved and written out when a rule
// is saved (`AnomalySpec`), so a rule stored before keeps the detector and parameters it was saved
// with, and a release that predates the change reads a rule saved after it. What changed is what
// an entry that leaves a field out is saved as: see `AnomalySpecInput`.

/** Detectors a rule may name: the single-series detectors of `anomaly/` that run from per-series state, one point per tick. */
export const ANOMALY_DETECTORS = ['ewma', 'threshold', 'robust_z', 'seasonal', 'cusum'] as const
/**
 * Not in the list, on purpose: `stl` and `pelt` (batch fits; explanations for a scheduled job, not
 * pagers), `burn_rate` (two series per bucket; an SLO is its own rule kind since contract version 4,
 * "SLO burn-rate rules") and the cross-series detector (one vector, no per-series state). A reader that meets a name it does not
 * know refuses the rule; it never substitutes another detector.
 */
export type AnomalyDetector = (typeof ANOMALY_DETECTORS)[number]

/** Becomes the alert's `severity` label, for routing. */
export type AnomalySeverity = 'page' | 'ticket' | 'info'

export type AnomalyParamValue = number | string | boolean | null

/** The `anomaly` block of a rule-file entry. */
export interface AnomalySpecInput {
  /**
   * Default `robust_z` with the quantile spread (k 2 times the 99th percentile of |x − median| over
   * a window of 1,500 points) when `severity` is not `page`; `threshold` when it is, which then
   * needs `params.above` or `params.below` (design D33). Until 2026-11-19 the default for a rule
   * that does not page was `ewma` (half-life 100, k 8); rules saved then keep it (see above).
   *
   * A rule saved again over a stored anomaly rule (the same group, and the same `monitor.id`, or
   * the same alert name and `expr` when the entry has no monitor id) keeps the stored value of every
   * field the entry leaves out whose stored value was the default of the release that stored it:
   * re-applying an unchanged rule file or monitor never changes what a rule does. Naming the
   * detector or a parameter changes it. The save warns when it kept a value that differs from
   * today's default.
   */
  detector?: AnomalyDetector
  /**
   * The detector's parameters (`anomaly/src/detectors/<name>.ts`, `<Name>Params`) by name. Not
   * `stepMs`: that is the group's interval. Unknown names and wrong types are refused. For
   * `robust_z` and `seasonal` an entry that gives no `spread` gets the quantile spread with the
   * configuration chosen on NAB and checked on SMD (D33; the defaults and the evidence for each are
   * served at `GET /api/v1/monitors/detectors`); `spread: 'mad'` gets the library's own defaults,
   * as every such rule did before 2026-11-19.
   */
  params?: Record<string, AnomalyParamValue>
  /** Printed after numbers in explanations, e.g. "ms". */
  unit?: string
  /** Default `ticket` (`info` for `cusum`). `page` is refused for `cusum`: it explains, it does not page. */
  severity?: AnomalySeverity
  /**
   * Most series the expression may return. Above it the evaluation is refused (the rule is
   * `health: err`, status `series_cap_exceeded`), nothing is scored and no state or alert
   * changes; series are never dropped to fit. Default 100, or fewer when that many series' state
   * could exceed `RulerLimits.maxAnomalyStateBytesPerRule` (the save warns, and the rule stores the
   * number); at most `RulerLimits.maxAnomalySeriesPerRule`.
   */
  max_series?: number
  /** Written by the ruler's own export: which `params` the author gave (the rest are written-out defaults). */
  given?: string[]
}

/**
 * A rule-file entry: an alerting entry (`alert`, `expr`, `for`, `keep_firing_for`, labels,
 * annotations) with an `anomaly` block. `expr` is the series to watch (a gauge, or `rate()` of a
 * counter), not a comparison.
 */
export interface AnomalyRuleInput extends AlertingRuleInput {
  anomaly: AnomalySpecInput
}

/** What a detector reads (the library's `HistoryNeed`), classified with the PromQL thresholds (design §7). */
export interface AnomalyHistory {
  /** What each evaluation reads once the detector has state. */
  tick: CostClass
  /** What warming the detector from history would read: `lookbackMs` at `resolutionMs`. */
  coldStart: CostClass
  lookbackMs: number
  tickLookbackMs: number
  /** 0 = the series' own (the group interval). */
  resolutionMs: number
  /** Valid points before anything is scored; until then the rule is `warming`. */
  minPoints: number
  incremental: boolean
  reason: string
}

export interface AnomalySpec {
  detector: AnomalyDetector
  /**
   * Every parameter, resolved when the rule is saved: defaults are written out, so a later change
   * of a default never changes what a stored rule does (COMPATIBILITY.md §7).
   */
  params: Record<string, AnomalyParamValue>
  /** The parameter names the author gave; the others are defaults. */
  given: string[]
  unit: string
  severity: AnomalySeverity
  maxSeries: number
  history: AnomalyHistory
  /** Estimated stored state of one series, in bytes, used to refuse at save what could not be stored. */
  stateBytesPerSeries: number
}

export interface AnomalyRule {
  kind: 'anomaly'
  /** The `alertname` of its alerts. */
  name: string
  expr: string
  anomaly: AnomalySpec
  forMs: number
  keepFiringForMs: number
  /** Includes `severity`, from `anomaly.severity`. */
  labels: Record<string, string>
  annotations: Record<string, string>
  /** Hash of `anomaly`, name, expression, detector, parameters and labels: a new detector or parameter is a new rule with fresh state. */
  key: string
  /** The larger of the expression's class and the detector's tick class. */
  cost: RuleCost
}

/** The annotation holding the detector's one-sentence explanation of a flagged point. */
export const ANOMALY_ANNOTATION = 'anomaly'
/** The annotation holding the numbers behind that sentence, as `AnomalyDetail` JSON. */
export const ANOMALY_DETAIL_ANNOTATION = 'anomaly_detail'

/** `ANOMALY_DETAIL_ANNOTATION`'s value. Every number in the sentence is one of these. */
export interface AnomalyDetail {
  v: 1
  detector: AnomalyDetector
  kind: 'threshold' | 'deviation' | 'seasonal' | 'level_shift' | 'burn_rate' | 'group_outlier' | 'residual'
  direction: 'above' | 'below'
  value: number
  /** What the value was compared with, and what that is in words. */
  reference: number
  referenceLabel: string
  deviations?: number
  spread?: number
  spreadLabel?: string
  /** The detector's score, in its own unit. */
  score: number
  /** Unix ms of the point (for a level shift, the estimated change). */
  at: number
  facts: Record<string, number | string>
}

/**
 * How an anomaly rule's last evaluation went.
 *   ok                     scored
 *   warming                too little history for some or all series; not scored yet (`message` says what is needed)
 *   series_cap_exceeded    refused: the expression returned more than `maxSeries` series
 *   state_limit_exceeded   refused: the detector state would exceed a `RulerLimits` state limit
 *   state_unreadable       refused: the stored state is in a format this release does not read (a newer
 *                          release wrote it); it is kept as it is for a release that does
 *   unknown                not evaluated yet
 * A refused evaluation changes no state and no alert.
 */
export type AnomalyEvalStatus = 'ok' | 'warming' | 'series_cap_exceeded' | 'state_limit_exceeded' | 'state_unreadable' | 'unknown'

export interface AnomalyRuleStatus {
  status: AnomalyEvalStatus
  message: string | null
  /** Series the expression returned at the last evaluation (also when refused). */
  series: number
  maxSeries: number
  scored: number
  warming: number
  /** Points that were NaN or ±Inf: not scored; the series keeps its previous flag (a gap is not a recovery). */
  missing: number
  anomalous: number
  /** Series with stored state, and its size as stored. */
  stateSeries: number
  stateBytes: number
  /** States of series absent longer than the detector's lookback, dropped since the object started. */
  pruned: number
  /** EXTENDED (contract version 4). How warming the rule from history went; absent for a rule saved before warm-up existed. */
  warmup?: WarmupStatus
}

// ───────────────────────────── warming from history (contract version 4) ─────────────────────────────
//
// ADDED 2026-11-19, additively. A new anomaly or SLO rule (a new rule key: a new detector,
// parameter, interval or SLI is a new rule) does not start cold: before its first evaluation the
// ruler reads its history class with the engine's range query, at the rule's interval, and feeds
// those points through the rule's own evaluation in time order, so its state is what it would be
// had the rule run all along. The cost is asked first (the engine's plan, nothing fetched); over
// the budget (`RulerLimits.maxWarmup*`) the warm-up is refused as a whole, never fetched in part,
// and the rule starts cold, saying so here.

/**
 *   pending      not run yet, or a transient failure that is retried at the next tick (`attempts`)
 *   done         the state was filled from `points` points of history
 *   refused      over the budget, or the engine's plan refused the read: nothing was fetched; the rule
 *                started cold (`message` says why, `plan` and `budget` the numbers)
 *   failed       the engine failed `attempts` times; the rule started cold
 *   not_needed   nothing to read (a detector without history)
 */
export type WarmupState = 'pending' | 'done' | 'refused' | 'failed' | 'not_needed'

export interface WarmupStatus {
  status: WarmupState
  /** The history read, or that would have been read: [fromMs, toMs] at `stepMs`, per query. */
  reads: { fromMs: number; toMs: number; stepMs: number }[]
  /** What the engine's plan said before anything was fetched, summed over the range queries; null until asked. */
  plan: { scanSamples: number; bytesToRead: number; queries: number } | null
  budget: { scanSamples: number; bytesToRead: number }
  /** Points fed through the rule's evaluation (summed over series). */
  points: number
  attempts: number
  message: string | null
  /** When it finished (done, refused, failed); null while pending. */
  finishedAt: number | null
}

// ───────────────────────────── SLO burn-rate rules (contract version 4) ─────────────────────────────
//
// ADDED 2026-11-19, additively (contracts/COMPATIBILITY.md §4): nothing above changes meaning. A
// rule file without an `slo` block means what it meant; a stored group without `sloRules` is read
// as having none.
//
// An SLO is an objective (0.999), a compliance window (30 days) and an SLI: good and total events,
// bad and total events, or an error ratio. The rule raises the multi-window, multi-burn-rate
// alerts of the Google SRE Workbook (chapter 5, "Alerting on SLOs", approach 6): an alert fires
// while the burn rate is above its threshold over BOTH its long and its short window. Defaults
// are the workbook's (`anomaly/` `SRE_WORKBOOK_RULES`): page 1 h / 5 m at 14.4×, page 6 h / 30 m at
// 6×, ticket 1 d / 2 h at 3×, ticket 3 d / 6 h at 1×.
//
// Evaluation: ONE expression per rule per tick (`SloRule.expr`, derived): the events of the last
// interval (one bucket), good or bad and total, distinguished by the label `SLO_PART_LABEL`. The
// ruler keeps each series' buckets for the longest window, and coarser buckets for the compliance
// window (to say how much budget is left), as state (warmed from history, contract version 4). An
// alert carries `severity` (`page` or `ticket`): one alert per series and severity, firing while any
// alert of that severity fires. Its sentence (`SLO_ANNOTATION`) says which windows burned, how
// fast, and how much budget is left; the numbers are `SloDetail` JSON (`SLO_DETAIL_ANNOTATION`).

/**
 * The SLI, as PromQL. Each expression must contain `$window`, which the ruler replaces with the
 * bucket width: the group interval each tick (so `increase(x[$window])` is one bucket's events),
 * or a coarser width when it reads the compliance window. `rate()` works too (only ratios and
 * `min_events` see the unit).
 *   { good, total }   bad = total - good; a series in `good` without one in `total` is an error;
 *                     a `total` series without a `good` one counts as all bad
 *   { bad, total }    a `total` series without a `bad` one counts as no errors
 *   { error_ratio }   one value per bucket, each bucket weighted equally (time-weighted, not by events)
 */
export type SloSliInput = { good: string; total: string } | { bad: string; total: string } | { error_ratio: string }

export interface SloAlertInput {
  severity: 'page' | 'ticket'
  long_window: string
  short_window: string
  /** Fires above this multiple of the budget rate, over both windows (strictly greater, as the workbook's `>`). */
  burn_rate: number
}

/** The `slo` block of a rule-file entry. */
export interface SloSpecInput {
  /** The target fraction of good events, 0 < objective < 1, e.g. 0.999. */
  objective: number
  /** The compliance window. Default "30d". */
  window?: string
  sli: SloSliInput
  /** Default: the SRE Workbook's four (above). */
  alerts?: SloAlertInput[]
  /** Low-traffic guard: events a long window must hold before its alert may fire. Default 0. */
  min_events?: number
  /** Fraction of a window's buckets that must be present for the window to count. Default 0.9. */
  min_coverage?: number
  /** Most series the SLI may return; above it the evaluation is refused, never cut. Default 10. */
  max_series?: number
  /** Written by the ruler's own export: which fields the author gave. */
  given?: string[]
}

/** A rule-file entry: `alert`, `for`, `keep_firing_for`, labels and annotations, and an `slo` block. No `expr`: the SLI is the expression. */
export interface SloRuleInput {
  alert: string
  slo: SloSpecInput
  for?: string
  keep_firing_for?: string
  labels?: Record<string, string>
  annotations?: Record<string, string>
}

export type SloSeverity = 'page' | 'ticket'

export interface SloBurnAlert {
  severity: SloSeverity
  longMs: number
  shortMs: number
  burnRate: number
}

export interface SloSli {
  kind: 'good_total' | 'bad_total' | 'error_ratio'
  /** As written, with `$window`. Null when the kind has no such expression. */
  good: string | null
  bad: string | null
  total: string | null
  errorRatio: string | null
}

/** What an SLO rule reads, classified with the PromQL thresholds (design §7). */
export interface SloHistory {
  /** What each evaluation reads: one bucket. */
  tick: CostClass
  /** What warming the rule from history reads: the longest alert window in buckets, and the compliance window in coarse buckets. */
  coldStart: CostClass
  /** The longest alert window: kept as buckets of `bucketMs` (the group interval). */
  lookbackMs: number
  bucketMs: number
  /** The compliance window: kept as buckets of `budgetBucketMs`, to say how much budget is left. */
  budgetLookbackMs: number
  budgetBucketMs: number
  reason: string
}

export interface SloSpec {
  objective: number
  windowMs: number
  sli: SloSli
  /** Every alert, resolved at save (defaults written out, COMPATIBILITY.md §7). */
  alerts: SloBurnAlert[]
  minEvents: number
  minCoverage: number
  maxSeries: number
  /** The fields the author gave; the others are defaults. */
  given: string[]
  history: SloHistory
  /** Estimated stored state of one series, in bytes. */
  stateBytesPerSeries: number
}

export interface SloRule {
  kind: 'slo'
  /** The `alertname` of its alerts. */
  name: string
  /** The per-tick query, derived from the SLI with `$window` = the group interval: both parts, in one expression. */
  expr: string
  slo: SloSpec
  forMs: number
  keepFiringForMs: number
  /** Without `severity`: each alert's `severity` is the burn-rate alert's. */
  labels: Record<string, string>
  annotations: Record<string, string>
  /** Hash of `slo`, name, objective, window, SLI, alerts and labels: any change is a new rule with fresh state. */
  key: string
  /** The per-tick expression's class; the cold start is in `slo.history`. */
  cost: RuleCost
}

/** The label that tells the two parts of `SloRule.expr` apart (`good`, `bad`, `total`). Reserved: an SLI may not return it. */
export const SLO_PART_LABEL = 'viz_slo_part'
/** The annotation holding the alert's sentence. */
export const SLO_ANNOTATION = 'slo'
/** The annotation holding the numbers behind it, as `SloDetail` JSON. */
export const SLO_DETAIL_ANNOTATION = 'slo_detail'

/** `SLO_DETAIL_ANNOTATION`'s value. Every number in the sentence is one of these. Fractions are 0..1. */
export interface SloDetail {
  v: 1
  severity: SloSeverity
  longWindowMs: number
  shortWindowMs: number
  longBurnRate: number
  shortBurnRate: number
  threshold: number
  objective: number
  windowMs: number
  /** Fraction of the compliance window's budget spent within the long window. */
  spentInLongWindow: number
  /** Fraction of the budget left over the compliance window (negative once overspent); null with no events on record. */
  budgetRemaining: number | null
  /** How much of the compliance window the remaining-budget figure covers (less than `windowMs` until that much history exists). */
  budgetCoveredMs: number
  /** At the long window's burn rate, time until the remaining budget is spent; null if not burning or already spent. */
  exhaustionMs: number | null
  longEvents: number
  at: number
}

/**
 * How an SLO rule's last evaluation went.
 *   ok                    evaluated
 *   warming               some window has less than `min_coverage` of its buckets (`message` says which)
 *   series_cap_exceeded   refused: the SLI returned more than `maxSeries` series
 *   invalid_result        refused: the parts do not pair up (a good or bad series without a total)
 *   state_unreadable      refused: the stored state is in a format this release does not read
 *   unknown               not evaluated yet
 * A refused evaluation changes no state and no alert.
 */
export type SloEvalStatus = 'ok' | 'warming' | 'series_cap_exceeded' | 'invalid_result' | 'state_unreadable' | 'unknown'

export interface SloRuleStatus {
  status: SloEvalStatus
  message: string | null
  series: number
  maxSeries: number
  /** Series whose page / ticket alert condition held at the last evaluation. */
  burning: { page: number; ticket: number }
  warming: number
  /** The lowest remaining-budget fraction over the series, and the history it covers; null with no events. */
  budgetRemaining: number | null
  budgetCoveredMs: number
  stateSeries: number
  stateBytes: number
  pruned: number
  warmup?: WarmupStatus
}

// ───────────────────────────── alert state ─────────────────────────────

export type AlertState = 'pending' | 'firing' | 'inactive'

/**
 * One alert instance. `inactive` instances exist only while a resolved alert is retained
 * (so the resolve reaches the notifier); an alert that never fired is simply absent.
 */
export interface Alert {
  /** Fingerprint of `labels`. */
  fingerprint: string
  /** Series labels without `__name__`, overlaid with the rule's labels, plus `alertname`. */
  labels: Record<string, string>
  annotations: Record<string, string>
  state: AlertState
  /** Evaluation time at which the series first appeared. `for` counts from here. */
  activeAt: number
  firedAt: number | null
  resolvedAt: number | null
  /** Set while `keep_firing_for` is holding a firing alert whose series has gone. */
  keepFiringSince: number | null
  /** Sample value at the last evaluation that returned the series. */
  value: number
}

export interface RuleStatus {
  group: string
  name: string
  /**
   * EXTENDED (contract version 2): `anomaly`; (contract version 4): `slo`. A caller that does not
   * know a kind must not act on the rule as if it were another.
   */
  kind: 'alert' | 'record' | 'anomaly' | 'slo'
  key: string
  cost: RuleCost
  /** `unknown` until first evaluated. */
  health: 'ok' | 'err' | 'unknown'
  lastError: string | null
  lastEvaluationMs: number | null
  alerts: Alert[]
  /** EXTENDED (contract version 2). Present for anomaly rules only. */
  anomaly?: AnomalyRuleStatus
  /** EXTENDED (contract version 4). Present for SLO rules only. */
  slo?: SloRuleStatus
}

// ───────────────────────────── Ruler RPC ─────────────────────────────

export interface RulerLimits {
  maxGroups: number
  maxRulesPerGroup: number
  /** Hard cap on alerts per alerting rule and series per recording rule, whatever `limit` says. */
  maxAlertsPerRule: number
  /** Bytes, per expanded annotation value and per annotation template. */
  maxAnnotationBytes: number
  /** Bytes of one group's stored JSON (one SQLite value). */
  maxGroupBytes: number
  minIntervalMs: number
  /** EXTENDED (contract version 2). Hard cap on `AnomalySpec.maxSeries`. Default 1,000. */
  maxAnomalySeriesPerRule?: number
  /** EXTENDED (contract version 2). Detector state of one series, as stored JSON. Default 65,536. */
  maxAnomalyStateBytesPerSeries?: number
  /** EXTENDED (contract version 2). Detector state of all series of one rule. Default 1,048,576. */
  maxAnomalyStateBytesPerRule?: number
  /**
   * EXTENDED (contract version 2). Detector state one ruler object may have to hold, summed over its
   * anomaly rules as `stateBytesPerSeries × maxSeries` and checked when rules are saved: it bounds
   * the object's memory (state is kept in memory between ticks). Default 16,777,216.
   */
  maxAnomalyStateBytesPerObject?: number
  /** EXTENDED (contract version 4). Hard cap on `SloSpec.maxSeries`. Default 100. SLO state counts against `maxAnomalyStateBytesPerObject`. */
  maxSloSeriesPerRule?: number
  /**
   * EXTENDED (contract version 4). What one warm-up may read, as the engine's plan estimates it before
   * anything is fetched (samples the data files in range hold, and their bytes), summed over its
   * range queries. Default 3,000,000 samples and 16 MiB: what one query of viz-query may read in
   * one place (query/README.md, `maxScanSamples`, `maxFetchBytes`).
   */
  maxWarmupScanSamples?: number
  maxWarmupBytes?: number
  /** EXTENDED (contract version 4). The same for one backtest. Default 20,000,000 samples and 128 MiB. */
  maxBacktestScanSamples?: number
  maxBacktestBytes?: number
}

export interface RulerConfig {
  limits: RulerLimits
  defaultIntervalMs: number
  /** Group cursors and health are persisted this often; alert state only on transitions. */
  heartbeatMs: number
  /** How long a resolved alert is kept (Prometheus: 15m). */
  resolvedRetentionMs: number
  /** Groups due at the same alarm that may be evaluated concurrently. */
  maxConcurrentGroups: number
  /** One group tick gives up on its remaining rules after this long; they are marked `err` and keep their state. */
  groupTimeoutMs: number
  /** Available to templates as `$externalLabels` and added to alerts sent to the notifier (alert labels win). */
  externalLabels: Record<string, string>
  /** Classification thresholds (design §7). */
  hotWindowMs: number
  recentWindowMs: number
  lookbackMs: number
  /** Evaluate the built-in always-firing `DeadMansSwitch` rule. */
  deadman: boolean
  deadmanIntervalMs: number
}

export type WrongTenant = { status: 'wrong_tenant' }

/**
 * What any Ruler or Notifier RPC may answer instead of its result. `wrong_tenant`: the object
 * does not belong to that tenant. `schema_too_new`: the object's storage was written by a newer
 * release than the code answering (contracts/COMPATIBILITY.md §2.4); retry after
 * `retryAfterMs`. Nothing was changed either way.
 */
export type Refused = WrongTenant | SchemaTooNew

export interface SavedRule {
  name: string
  /** EXTENDED (contract version 2): `anomaly`; (contract version 4): `slo`. */
  kind: 'alert' | 'record' | 'anomaly' | 'slo'
  key: string
  cost: RuleCost
  /** EXTENDED (contract version 2). Anomaly rules only: what the detector reads per tick and at a cold start. */
  history?: AnomalyHistory
  /** EXTENDED (contract version 4). SLO rules only: what the rule reads per tick and to warm up. */
  slo?: SloHistory
}

export type SaveGroupsResult =
  | {
      status: 'ok'
      groups: { name: string; intervalMs: number; offsetMs: number; nextEvaluationMs: number; rules: SavedRule[] }[]
      /** Accepted, but probably not what the author meant (e.g. `for` shorter than the interval). */
      warnings: ValidationError[]
    }
  /** Nothing was saved. */
  | { status: 'invalid'; errors: ValidationError[] }
  | Refused

export interface GroupHealth {
  name: string
  intervalMs: number
  /** Evaluation timestamp of the last completed tick. */
  lastEvaluationMs: number | null
  /** Clock time the last tick took. */
  lastDurationMs: number | null
  nextEvaluationMs: number
  evaluations: number
  /** Ticks known to have been skipped because the alarm ran late. */
  skippedTicks: number
  /**
   * Ticks between the last persisted cursor and the first tick after the object was
   * rebuilt from storage. They may or may not have run: the cursor is only persisted at
   * the heartbeat. See README "Risks".
   */
  unobservedTicks: number
  evaluatorErrors: number
  rulesInError: { rule: string; error: string }[]
}

export interface RulerHealth {
  tenant: string
  shard: string
  nowMs: number
  groups: GroupHealth[]
  /** Alert transitions committed but not yet accepted by the notifier. */
  outboxDepth: number
  oldestUndeliveredAgeMs: number | null
  lastHandoffError: string | null
  /** Recording-rule batches the sink refused after retries (no backfill). */
  samplesDropped: number
  alarmAtMs: number | null
  /** Billed writes since this instance was constructed (resets on eviction). */
  counters: { sqlRowsWritten: number; alarmsSet: number; ticks: number }
}

export interface RulerRpc {
  configure(tenant: string, patch: Partial<Omit<RulerConfig, 'limits'>> & { limits?: Partial<RulerLimits> }): Promise<{ status: 'ok'; config: RulerConfig } | { status: 'invalid'; errors: ValidationError[] } | Refused>
  /** Create or replace the groups in `file` by name. All or nothing. Alert state follows rules whose key is unchanged. */
  saveGroups(tenant: string, file: unknown): Promise<SaveGroupsResult>
  /** Validate and classify without saving. */
  checkGroups(tenant: string, file: unknown): Promise<SaveGroupsResult>
  deleteGroup(tenant: string, name: string): Promise<{ status: 'ok'; existed: boolean } | Refused>
  listGroups(tenant: string): Promise<{ status: 'ok'; groups: RuleGroup[] } | Refused>
  /** Prometheus' `/api/v1/rules` content: every rule with health and its alerts. */
  rules(tenant: string): Promise<{ status: 'ok'; rules: RuleStatus[] } | Refused>
  health(tenant: string): Promise<({ status: 'ok' } & RulerHealth) | Refused>
  /** For the platform sweeper: re-arm the alarm if there is work and no alarm. */
  ensureArmed(tenant: string): Promise<{ status: 'ok'; rearmed: boolean } | Refused>
}

// ───────────────────────────── ruler → notifier ─────────────────────────────

/** One alert transition the notifier must know about. Pending alerts are never sent. */
export interface AlertUpdate {
  fingerprint: string
  labels: Record<string, string>
  annotations: Record<string, string>
  status: 'firing' | 'resolved'
  /** When the alert started firing. */
  startsAt: number
  /** When it resolved; null while firing. */
  endsAt: number | null
  value: number
  /**
   * Evaluation time of the transition. The notifier applies an update only if it is not
   * older than what it holds for the fingerprint, and re-applying the same update changes
   * nothing: that is what makes the at-least-once hand-off idempotent.
   */
  at: number
  generator: { group: string; rule: string }
  /**
   * Only for heartbeat alerts (the dead-man's switch): if no newer update arrives by this
   * time the notifier resolves the alert itself. Ordinary alerts carry null and are
   * resolved only by an explicit update.
   */
  expiresAt: number | null
}

export type IngestResult =
  /** `applied` counts updates that changed something; a redelivered batch reports 0. */
  | { status: 'ok'; applied: number }
  /** The notifier is over its limits; nothing was applied; retry later. */
  | { status: 'overloaded'; retryAfterMs: number }
  | Refused

// ───────────────────────────── notifier config (Alertmanager shape) ─────────────────────────────

export interface RouteInput {
  receiver?: string
  group_by?: string[]
  /** Label equality. */
  match?: Record<string, string>
  /** Label regex, fully anchored. */
  match_re?: Record<string, string>
  /** Alertmanager's newer form: `name="value"`, `name!="value"`, `name=~"regex"`, `name!~"regex"`. */
  matchers?: string[]
  /** Keep trying later siblings after this route matches. */
  continue?: boolean
  group_wait?: string
  group_interval?: string
  repeat_interval?: string
  routes?: RouteInput[]
}

export interface WebhookConfig {
  url: string
  /** Default true. */
  send_resolved?: boolean
  /** 0 = all. Extra alerts are counted in `truncatedAlerts`. */
  max_alerts?: number
  /**
   * EXTENDED (contract version 3). The body: `alertmanager` (default), Alertmanager's webhook
   * JSON (`WebhookPayload`, version "4"); `json`, viz's plain form (`JsonNotification`).
   */
  format?: 'alertmanager' | 'json'
}

/**
 * ADDED (contract version 3). The receiver that stands for the tenant's default destination,
 * set through control (`contracts/control.ts` `NotificationTarget`). The notifier adds it to
 * every config: a route may name it, and when the tenant has no notifier config of its own the
 * whole config is `route: { receiver: CONTROL_RECEIVER }` with Alertmanager's default timers.
 * A tenant config may not define a receiver of this name. With no destination set in control
 * it has no integration, and nothing is sent to it.
 */
export const CONTROL_RECEIVER = 'viz:default'

export interface SlackConfig {
  /** A Slack-compatible incoming-webhook URL. */
  api_url: string
  channel?: string
  /** Default false, as in Alertmanager. */
  send_resolved?: boolean
}

export interface ReceiverInput {
  name: string
  webhook_configs?: WebhookConfig[]
  slack_configs?: SlackConfig[]
}

export interface InhibitRuleInput {
  source_match?: Record<string, string>
  source_match_re?: Record<string, string>
  target_match?: Record<string, string>
  target_match_re?: Record<string, string>
  source_matchers?: string[]
  target_matchers?: string[]
  equal?: string[]
}

export interface NotifierConfigInput {
  route: RouteInput
  receivers: ReceiverInput[]
  inhibit_rules?: InhibitRuleInput[]
  /** Printed in payloads as `externalURL`. */
  external_url?: string
  /** Delivery policy; not part of Alertmanager's file. */
  delivery?: {
    /** Attempts before a notification is dead-lettered. Default 8. */
    max_attempts?: number
    /** First retry delay; doubles each attempt up to `max_backoff`, with seeded jitter. Default "1s". */
    base_backoff?: string
    /** Default "5m". */
    max_backoff?: string
    /** Per-request timeout. Default "10s". */
    timeout?: string
  }
}

export interface SilenceMatcher {
  name: string
  value: string
  isRegex: boolean
  /** Default true. False negates the match. */
  isEqual?: boolean
}

export interface SilenceInput {
  matchers: SilenceMatcher[]
  startsAt: number
  endsAt: number
  createdBy: string
  comment: string
}

export interface Silence extends SilenceInput {
  id: string
  updatedAt: number
  /** Derived from the clock at read time. */
  state: 'pending' | 'active' | 'expired'
}

// ───────────────────────────── payloads ─────────────────────────────

/** Alertmanager's webhook body, version "4". Times are RFC 3339. */
export interface WebhookPayload {
  version: '4'
  groupKey: string
  truncatedAlerts: number
  status: 'firing' | 'resolved'
  receiver: string
  groupLabels: Record<string, string>
  commonLabels: Record<string, string>
  commonAnnotations: Record<string, string>
  externalURL: string
  alerts: {
    status: 'firing' | 'resolved'
    labels: Record<string, string>
    annotations: Record<string, string>
    startsAt: string
    /** `0001-01-01T00:00:00Z` while firing. */
    endsAt: string
    generatorURL: string
    fingerprint: string
  }[]
}

/**
 * ADDED (contract version 3). viz's plain webhook body (`WebhookConfig.format: 'json'`), for
 * receivers that are not Alertmanager-compatible. Times are RFC 3339 (UTC, milliseconds), or
 * null. It carries no secret and no URL: `idempotencyKey` is the same value as the
 * `Idempotency-Key` header, the same on every attempt of one notification.
 */
export interface JsonNotification {
  version: 'viz.notification/v1'
  idempotencyKey: string
  status: 'firing' | 'resolved'
  receiver: string
  groupKey: string
  groupLabels: Record<string, string>
  externalURL: string
  /** Alerts the body leaves out (`max_alerts`, or the 500 cap). */
  truncatedAlerts: number
  /** Firing first, then resolved; each ordered by fingerprint. */
  alerts: {
    status: 'firing' | 'resolved'
    /** The `alertname` label. */
    name: string
    labels: Record<string, string>
    annotations: Record<string, string>
    startsAt: string
    /** Null while firing. */
    endsAt: string | null
    /** The sample value at the transition; null when not finite. */
    value: number | null
    fingerprint: string
  }[]
}

/** The HTTP header carrying the notification's idempotency key. */
export const IDEMPOTENCY_HEADER = 'Idempotency-Key'

export interface OutboxEntry {
  id: number
  groupKey: string
  receiver: string
  /** `webhook[0]`, `slack[1]`, ... within the receiver. */
  integration: string
  url: string
  /**
   * `hash(tenant, receiver, integration, group key, state hash, notification number)`.
   * The same for every delivery attempt of one notification; different for a repeat.
   */
  idempotencyKey: string
  status: 'pending' | 'dead'
  attempts: number
  createdAt: number
  nextAttemptAt: number
  lastError: string | null
}

export interface NotifierHealth {
  tenant: string
  nowMs: number
  alerts: { firing: number; resolved: number }
  groups: number
  silences: number
  outboxDepth: number
  oldestUndeliveredAgeMs: number | null
  deadLetters: number
  alarmAtMs: number | null
  /** Since this instance was constructed (resets on eviction). */
  counters: { sqlRowsWritten: number; alarmsSet: number; delivered: number; attempts: number }
}

export interface NotifierAlert {
  fingerprint: string
  labels: Record<string, string>
  annotations: Record<string, string>
  status: 'firing' | 'resolved'
  startsAt: number
  endsAt: number | null
  silencedBy: string[]
  inhibited: boolean
  receivers: string[]
}

export interface NotifierRpc {
  setConfig(tenant: string, config: unknown): Promise<{ status: 'ok' } | { status: 'invalid'; errors: ValidationError[] } | Refused>
  /** Apply a batch of transitions from one ruler shard (`source` = the shard's object name). Idempotent. */
  ingest(tenant: string, source: string, updates: AlertUpdate[]): Promise<IngestResult>
  createSilence(tenant: string, silence: SilenceInput): Promise<{ status: 'ok'; id: string } | { status: 'invalid'; errors: ValidationError[] } | Refused>
  /** End a silence now. */
  expireSilence(tenant: string, id: string): Promise<{ status: 'ok' } | { status: 'not_found' } | Refused>
  listSilences(tenant: string): Promise<{ status: 'ok'; silences: Silence[] } | Refused>
  listAlerts(tenant: string): Promise<{ status: 'ok'; alerts: NotifierAlert[] } | Refused>
  /** Undelivered and dead-lettered notifications. */
  outbox(tenant: string): Promise<{ status: 'ok'; entries: OutboxEntry[] } | Refused>
  /** Put a dead-lettered notification back in the queue with its original idempotency key. */
  retryDeadLetter(tenant: string, id: number): Promise<{ status: 'ok' } | { status: 'not_found' } | Refused>
  discardDeadLetter(tenant: string, id: number): Promise<{ status: 'ok' } | { status: 'not_found' } | Refused>
  health(tenant: string): Promise<({ status: 'ok' } & NotifierHealth) | Refused>
}
