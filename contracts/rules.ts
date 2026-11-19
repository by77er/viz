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
 */

import type { PromScalar, PromVector } from './engine'
import type { SchemaTooNew } from './schema'

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
  /** EXTENDED (contract version 2): an entry may also be an `AnomalyRuleInput` (an alerting entry with an `anomaly` block). */
  rules: (AlertingRuleInput | RecordingRuleInput | AnomalyRuleInput)[]
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

/** Detectors a rule may name: the single-series detectors of `anomaly/` that run from per-series state, one point per tick. */
export const ANOMALY_DETECTORS = ['ewma', 'threshold', 'robust_z', 'seasonal', 'cusum'] as const
/**
 * Not in the list, on purpose: `stl` and `pelt` (batch fits; explanations for a scheduled job, not
 * pagers), `burn_rate` (two series per bucket; SLOs compile to recording rules instead) and the
 * cross-series detector (one vector, no per-series state). A reader that meets a name it does not
 * know refuses the rule; it never substitutes another detector.
 */
export type AnomalyDetector = (typeof ANOMALY_DETECTORS)[number]

/** Becomes the alert's `severity` label, for routing. */
export type AnomalySeverity = 'page' | 'ticket' | 'info'

export type AnomalyParamValue = number | string | boolean | null

/** The `anomaly` block of a rule-file entry. */
export interface AnomalySpecInput {
  /**
   * Default `ewma` (with the parameters chosen on held-out data, not the library's); `threshold`
   * when `severity` is `page`, which then needs `params.above` or `params.below` (design D31).
   */
  detector?: AnomalyDetector
  /**
   * The detector's parameters (`anomaly/src/detectors/<name>.ts`, `<Name>Params`) by name. Not
   * `stepMs`: that is the group's interval. Unknown names and wrong types are refused.
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
  /** EXTENDED (contract version 2): `anomaly`. A caller that does not know a kind must not act on the rule as if it were another. */
  kind: 'alert' | 'record' | 'anomaly'
  key: string
  cost: RuleCost
  /** `unknown` until first evaluated. */
  health: 'ok' | 'err' | 'unknown'
  lastError: string | null
  lastEvaluationMs: number | null
  alerts: Alert[]
  /** EXTENDED (contract version 2). Present for anomaly rules only. */
  anomaly?: AnomalyRuleStatus
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
  /** EXTENDED (contract version 2): `anomaly`. */
  kind: 'alert' | 'record' | 'anomaly'
  key: string
  cost: RuleCost
  /** EXTENDED (contract version 2). Anomaly rules only: what the detector reads per tick and at a cold start. */
  history?: AnomalyHistory
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
}

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
