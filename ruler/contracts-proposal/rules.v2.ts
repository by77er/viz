/**
 * PROPOSED changes to `contracts/rules.ts`, as a typed diff.
 *
 * `ruler/` may not edit `contracts/`. This file re-exports the adopted contract (its copy,
 * `./rules`) and declares everything that is new or changed, so the ruler compiles against
 * the proposal today and the diff to apply to `contracts/rules.ts` is exactly this file:
 *
 *   ADDED     a new export.
 *   CHANGED   replaces the export of the same name without the `V2` suffix.
 *   EXTENDED  adds optional members to the export of the same name without the suffix;
 *             everything the adopted contract says still holds.
 *
 * Summary of the proposal (each item is marked at its declaration):
 *   1. `BatchEvaluator`: one call per rule group per tick; a per-request result or error.
 *      `Evaluator` (one call per expression) stays, as the adapter's input.
 *   2. `RangeEvaluator` for backtests and `Validator` for save-time PromQL checks.
 *   3. Alerting rules carry a no-data policy and, when they are monitors, their presentation.
 *   4. Ruler RPC: `snapshot`, `timeline`, `backtest`, `exportGroup` / `importGroup` /
 *      `releaseGroup` (shard moves), `saveGroups` unchanged.
 *   5. Notifier RPC: acknowledge / unacknowledge, alert-scoped silences with undo, a bounded
 *      notification log per monitor, `describe` (who is notified, acknowledged, silenced),
 *      `getConfig` (secrets redacted).
 *   6. `WebhookConfig.secret`: outbound requests are signed (`SIGNATURE_HEADER`).
 *   7. `AlertUpdate.generator` names the monitor so the notifier can key its log by it.
 *   8. `RulerIndexRpc`: the registry of ruler objects the cron sweeper walks.
 *   9. (with contract version 4) SLO rules carry the same viz fields as alerting rules; group
 *      bundles carry SLO state and warm-up status; `HistoryPlanner` (the engine's plan of a range
 *      read, for budgets); backtests of anomaly and SLO rules, with each alert's annotations and
 *      an `over_budget` refusal; `POST /api/v1/monitors/{id}/backtest`; SLO monitors.
 */
import type { PromMatrix, PromScalar, PromVector } from '../../contracts/engine'
import type {
  Alert,
  AlertUpdate,
  AlertingRule,
  AlertingRuleInput,
  AnomalyDetector,
  AnomalyHistory,
  AnomalyParamValue,
  AnomalyRule,
  AnomalyRuleInput,
  AnomalyRuleStatus,
  AnomalySeverity,
  CostClass,
  NotifierAlert,
  RecordingRule,
  RuleCost,
  RulerConfig,
  RulerLimits,
  RulerRpc,
  NotifierRpc,
  SloHistory,
  SloRule,
  SloRuleInput,
  SloRuleStatus,
  SloSeverity,
  WarmupStatus,
  SaveGroupsResult,
  Silence,
  ValidationError,
  WebhookConfig,
  Refused,
} from './rules'

export * from './rules'

// ───────────────────────────── 1. batch evaluation ─────────────────────────────

/** ADDED. One expression of a batch. `id` is chosen by the caller and echoed in the result. */
export interface EvalRequest {
  id: string
  promql: string
  timeMs: number
}

/** ADDED. `durationMs`, when the engine can attribute time to one expression, feeds `evaluationTime`. */
export type EvalResult =
  | { id: string; ok: true; result: PromVector | PromScalar; durationMs?: number }
  | { id: string; ok: false; error: string; durationMs?: number }

/**
 * ADDED. What the ruler needs from the query engine: all expressions of one rule group at
 * one tick in ONE call, so the engine can plan them together and share scans.
 *
 * - One failing expression does not fail the batch: it is reported in its own result.
 * - Results may come in any order; a request with no result is treated as failed.
 * - A rejected promise means the engine could not be reached: every request failed.
 * - `signal` aborts when the group's time budget is spent; an implementation should then
 *   return what it has. The ruler stops waiting shortly after either way.
 * - Bound to ONE tenant by whoever constructs it, as `Evaluator` is.
 */
export interface BatchEvaluator {
  evaluate(requests: EvalRequest[], opts?: { signal?: AbortSignal }): Promise<EvalResult[]>
}

// ───────────────────────────── 2. range evaluation and validation ─────────────────────────────

/** ADDED. The engine's range query, for backtests. Points are `[unix seconds, value text]`. */
export interface RangeEvaluator {
  range(promql: string, startMs: number, endMs: number, stepMs: number): Promise<PromMatrix>
}

/** ADDED. A selector found in an expression: what `Engine.selectors()` reports, in milliseconds. */
export interface ValidatedSelector {
  /** Matcher text, e.g. `http_requests_total{job="api"}`. */
  text: string
  /** The selector's range (0 for an instant selector) and offset. */
  rangeMs: number
  offsetMs: number
}

/**
 * ADDED (with contract version 4). What a range read would cost, from the engine's plan, before
 * anything is fetched (viz-query's `/api/v1/plan` with `start`, `end`, `step`): samples the data
 * files in range hold, their bytes, and the refusal the engine's own limits would give (or null).
 * The tail of the shards is not in it.
 */
export interface HistoryPlan {
  scanSamples: number
  bytesToRead: number
  seriesEstimate: number
  refusal: { errorType: string; error: string } | null
}

/** ADDED (with contract version 4). Implemented by the engine binding (`plan`) or viz-query's `/api/v1/plan`. */
export interface HistoryPlanner {
  plan(promql: string, startMs: number, endMs: number, stepMs: number): Promise<HistoryPlan>
}

/** ADDED. Save-time PromQL validation; implemented by the engine binding when it exists. */
export interface Validator {
  check(promql: string): Promise<{ ok: boolean; errors: { message: string; offset?: number; fix?: string }[]; selectors: ValidatedSelector[] }>
}

// ───────────────────────────── 3. no-data policy and monitors ─────────────────────────────

/**
 * ADDED. What an alerting rule does while its data is missing.
 *   ok        Prometheus' behaviour: no series, no alert (pending alerts are dropped, firing
 *             ones resolve, subject to `keep_firing_for`).
 *   alerting  after `forMs` without data a synthetic alert with the label `NO_DATA_LABEL`
 *             fires; it resolves when data returns.
 *   keep      pending and firing alerts are left exactly as they are until data returns.
 */
export type NoDataMode = 'ok' | 'alerting' | 'keep'

export interface NoDataPolicy {
  mode: NoDataMode
  /** `alerting` only: how long data must be missing before the synthetic alert fires. */
  forMs: number
  /**
   * The expression whose emptiness means "no data". A comparison (`x > 1`) is empty whenever
   * the condition is false, so a monitor gives its bare query here. Null: the rule's own
   * expression is used.
   */
  expr: string | null
}

/** ADDED. The label that marks the synthetic no-data alert. A rule may not set it. */
export const NO_DATA_LABEL = 'viz_no_data'
/** ADDED. A rule label naming the receiver its alerts go to, ahead of the routing tree. */
export const RECEIVER_LABEL = 'viz_receiver'

export type ConditionOp = '>' | '>=' | '<' | '<=' | '==' | '!='

/** ADDED. What a monitor is beyond its alerting rule. Message, description and runbook are the rule's annotations. */
export interface MonitorMeta {
  /** Stable across edits; history is kept under it. `mon_` + 16 hex digits. */
  id: string
  owner: string
  startInvestigation: boolean
  /** Set when the monitor was written as query + comparison; `expr` is then derived from it. */
  condition: { query: string; op: ConditionOp; threshold: number; unit: string } | null
  createdAt: number
  createdBy: string
  updatedAt: number
  updatedBy: string
}

/** EXTENDED (`AlertingRuleInput`). The extra fields are viz's; a Prometheus rule file has none of them. */
export interface AlertingRuleInputV2 extends AlertingRuleInput {
  no_data?: NoDataMode
  no_data_for?: string
  no_data_expr?: string
  monitor?: MonitorMeta
}

/** EXTENDED (`AlertingRule`). Neither field is part of the rule key: alert state survives changing them. */
export interface AlertingRuleV2 extends AlertingRule {
  noData?: NoDataPolicy
  monitor?: MonitorMeta
}

export type RuleV2 = AlertingRuleV2 | RecordingRule

/**
 * EXTENDED (`AnomalyRuleInput`, contract version 2): an anomaly entry may carry the same viz
 * fields as an alerting entry. With `no_data_expr` absent, "no data" means the watched expression
 * returned no series at all.
 */
export interface AnomalyRuleInputV2 extends AnomalyRuleInput {
  no_data?: NoDataMode
  no_data_for?: string
  no_data_expr?: string
  monitor?: MonitorMeta
}

/** EXTENDED (`AnomalyRule`). As for `AlertingRuleV2`, neither field is part of the rule key. */
export interface AnomalyRuleV2 extends AnomalyRule {
  noData?: NoDataPolicy
  monitor?: MonitorMeta
}

/** EXTENDED (`SloRuleInput`, contract version 4): the viz fields of an alerting entry. "No data" means the SLI returned no series. */
export interface SloRuleInputV2 extends SloRuleInput {
  no_data?: NoDataMode
  no_data_for?: string
  no_data_expr?: string
  monitor?: MonitorMeta
}

/** EXTENDED (`SloRule`). As for `AlertingRuleV2`, neither field is part of the rule key. */
export interface SloRuleV2 extends SloRule {
  noData?: NoDataPolicy
  monitor?: MonitorMeta
}

/** Every rule a group can hold: `RuleGroup.rules`, `RuleGroup.anomalyRules` and `RuleGroup.sloRules`. */
export type AnyRuleV2 = RuleV2 | AnomalyRuleV2 | SloRuleV2

/**
 * EXTENDED (`RulerLimits`). The modelled peak memory one warm-up and one backtest may hold (bytes):
 * history is read and evaluated in time windows sized to it; defaults 16 MiB and 32 MiB. The
 * modelled CPU one backtest may use, and the warm-ups of one alarm together (ms): over it a
 * backtest is refused, a warm-up refused (over the whole) or left for the next alarm (over what the
 * alarm has left); defaults 20,000 and 5,000, under a Durable Object invocation's 30 s default
 * CPU limit. Proposed for `contracts/rules.ts` (README, contract issue 18).
 */
export interface RulerLimitsV2 extends RulerLimits {
  maxWarmupMemoryBytes?: number
  maxBacktestMemoryBytes?: number
  maxWarmupCpuMs?: number
  maxBacktestCpuMs?: number
}

/** EXTENDED (`RulerConfig`). */
export interface RulerConfigV2 extends Omit<RulerConfig, 'limits'> {
  limits: RulerLimitsV2
  /** Entries kept per monitor in the transition log; the oldest are dropped and counted. */
  timelineLimit: number
}

// ───────────────────────────── timeline ─────────────────────────────

/** ADDED. One line of a monitor's history. Ruler entries are transitions; notifier entries are what was sent and done. */
export type TimelineEntry =
  | {
      at: number
      source: 'ruler'
      /** `pending`: the series appeared. `cleared`: it went away before firing. */
      kind: 'pending' | 'firing' | 'resolved' | 'cleared'
      fingerprint: string
      labels: Record<string, string>
      value: number
      noData: boolean
    }
  | { at: number; source: 'ruler'; kind: 'created' | 'edited'; by: string }
  | {
      at: number
      source: 'notifier'
      kind: 'notified'
      receiver: string
      /** `webhook[0]`, `slack[1]`. */
      integration: string
      channel: string | null
      status: 'firing' | 'resolved'
      /** True when nothing changed and `repeat_interval` had passed. */
      repeat: boolean
      fingerprints: string[]
      idempotencyKey: string
      /** Null until the receiver answered 2xx. */
      deliveredAt: number | null
      /** Set when the notification was dead-lettered. */
      failed: string | null
    }
  | { at: number; source: 'notifier'; kind: 'acknowledged' | 'unacknowledged'; by: string; fingerprints: string[] }
  | { at: number; source: 'notifier'; kind: 'silenced'; by: string; until: number; silenceIds: string[]; fingerprints: string[] }
  | { at: number; source: 'notifier'; kind: 'silence_undone' | 'silence_expired'; by: string; silenceIds: string[] }

export interface Timeline {
  /** Oldest first. */
  entries: TimelineEntry[]
  /** Entries dropped because the log is bounded; 0 means `entries` is the whole history. */
  dropped: number
}

// ───────────────────────────── 4. Ruler RPC additions ─────────────────────────────

export interface RuleSnapshot {
  /** EXTENDED: an anomaly rule's snapshot is listed with the group's other rules, after them. */
  rule: AnyRuleV2
  /** EXTENDED. Anomaly rules only. */
  anomaly?: AnomalyRuleStatus
  /** EXTENDED (contract version 4). SLO rules only. */
  slo?: SloRuleStatus
  health: 'ok' | 'err' | 'unknown'
  lastError: string | null
  lastEvaluationMs: number | null
  /** What the evaluator reported for this expression, or the adapter measured; null if unknown. */
  lastDurationMs: number | null
  /** The last successful evaluation found the rule's data missing. */
  noData: boolean
  alerts: Alert[]
}

export interface GroupSnapshot {
  name: string
  intervalMs: number
  limit: number
  lastEvaluationMs: number | null
  lastDurationMs: number | null
  rules: RuleSnapshot[]
}

/** ADDED. A group with everything needed to continue it on another shard. */
export interface GroupBundle {
  spec: { name: string; intervalMs: number; queryOffsetMs: number; limit: number; rules: RuleV2[]; anomalyRules?: AnomalyRuleV2[]; sloRules?: SloRuleV2[] }
  /** rule key → alerts. */
  alerts: Record<string, Alert[]>
  /** monitor id → its transition log. */
  timelines: Record<string, Timeline>
  /**
   * EXTENDED. Anomaly rule key → its stored detector state rows (`anomaly_state.body`, in chunk
   * order), so a moved rule keeps scoring where it was. Absent: the rules start cold.
   */
  anomalyState?: Record<string, string[]>
  /** EXTENDED (contract version 4). SLO rule key → its stored state rows (`slo_state`: part, block, body). Absent: the rules start cold. */
  sloState?: Record<string, { part: string; block: number; body: string }[]>
  /** EXTENDED (contract version 4). Anomaly and SLO rule key → its warm-up status, so a moved rule is not warmed again. */
  warmup?: Record<string, WarmupStatus>
}

/** ADDED. A span during which one alert instance would have been pending or firing. */
export interface BacktestInterval {
  fingerprint: string
  labels: Record<string, string>
  state: 'pending' | 'firing'
  startMs: number
  /** The first step at which the state no longer held, or `toMs` when `open`. */
  endMs: number
  /** Still in this state at the last step. */
  open: boolean
  noData: boolean
  /**
   * EXTENDED (with contract version 4). The annotations the alert carried when it entered this
   * state, templates expanded: for an anomaly or SLO alert, the explanation it would have been sent
   * with (`anomaly`, `slo` and their `_detail` annotations).
   */
  annotations?: Record<string, string>
}

export interface BacktestResult {
  fromMs: number
  toMs: number
  stepMs: number
  steps: number
  /** Ordered by start; shade these on the chart. */
  intervals: BacktestInterval[]
  /** Derived from `intervals`, never computed separately. */
  summary: {
    firingCount: number
    pendingCount: number
    firingMs: number
    longestFiringMs: number
    /** Pending spans that ended without firing. */
    clearedCount: number
    firingAtEnd: boolean
    series: number
  }
  resolution: {
    stepMs: number
    /** The interval the rule would be evaluated at when live. */
    liveIntervalMs: number
    /** Each interval edge is within this of where live evaluation would have put it. */
    edgeErrorMs: number
    /** Plain statement of what this step can and cannot show. */
    note: string
  }
  /** EXTENDED (with contract version 4). The kind of rule backtested; absent means `alert`. */
  kind?: 'alert' | 'anomaly' | 'slo'
  /**
   * EXTENDED (with contract version 4). Anomaly and SLO rules: the history read before `fromMs` and
   * fed through the rule's evaluation (no alerts) so that its state at `fromMs` is what it would
   * have been live, as a warm-up leaves it. Null for alerting rules.
   */
  warmup?: { reads: { fromMs: number; toMs: number; stepMs: number }[]; points: number } | null
  /**
   * EXTENDED (with contract version 4). What the engine's plan said before the fetch, summed over the
   * range queries; and the memory model: the modelled peak, the budget, the steps per window of each
   * read (fetched and evaluated one window at a time, only the rule's state carried between them)
   * and the range queries the windows took; and the CPU model's cost of the run and its budget.
   */
  cost?: {
    scanSamples: number
    bytesToRead: number
    queries: number
    budget: { scanSamples: number; bytesToRead: number }
    memory?: { peakBytes: number; budgetBytes: number; windowSteps: number[]; queries: number }
    cpu?: { modelledMs: number; budgetMs: number }
  }
}

export type BacktestResponse =
  | ({ status: 'ok' } & BacktestResult)
  | { status: 'invalid'; errors: ValidationError[] }
  | { status: 'failed'; error: string }
  /**
   * EXTENDED (with contract version 4). Refused before anything was fetched: the engine's plan of the
   * read is over the backtest budget (`RulerLimits.maxBacktest*`), the engine's own limits would
   * refuse it, or its cost could not be asked. Or refused by the CPU model, after reading the first
   * window (to count the series) or a later one whose series take the run over its budget: nothing
   * kept. Never answered with a part of the range.
   */
  | {
      status: 'over_budget'
      message: string
      plan: { scanSamples: number; bytesToRead: number; queries: number } | null
      budget: { scanSamples: number; bytesToRead: number }
      /** The memory model's peak and budget; null when the refusal came from the engine's plan before sizing. */
      memory?: { peakBytes: number; budgetBytes: number } | null
      /** The CPU model's projection of the whole run and the budget; null when another budget refused it. */
      cpu?: { modelledMs: number; budgetMs: number } | null
    }
  | Refused

/** EXTENDED (`RulerRpc`). */
export interface RulerRpcV2 extends RulerRpc {
  /** Every group with its rules, health and alerts: the source of `/api/v1/rules`, `/api/v1/alerts` and the monitor views. */
  snapshot(tenant: string): Promise<{ status: 'ok'; shard: string; groups: GroupSnapshot[] } | Refused>
  timeline(tenant: string, monitorId: string): Promise<({ status: 'ok' } & Timeline) | Refused>
  /** Run `rule` (an alerting rule input) over history with the live state machine. */
  backtest(tenant: string, rule: unknown, fromMs: number, toMs: number, stepMs: number, liveIntervalMs?: number): Promise<BacktestResponse>
  exportGroup(tenant: string, name: string): Promise<{ status: 'ok'; bundle: GroupBundle } | { status: 'not_found' } | Refused>
  /** Idempotent. The group starts on this shard's schedule with its alert state intact. */
  importGroup(tenant: string, bundle: GroupBundle): Promise<{ status: 'ok' } | { status: 'invalid'; errors: ValidationError[] } | Refused>
  /** Drop a group that now lives on another shard: nothing is resolved, nothing is notified. */
  releaseGroup(tenant: string, name: string): Promise<{ status: 'ok'; existed: boolean } | Refused>
  /** Add one rule to a group, or replace the one with the same monitor id, atomically. */
  saveRule(tenant: string, group: { name: string; interval?: string }, rule: unknown, dryRun?: boolean): Promise<SaveGroupsResult & { ruleIndex?: number }>
  removeRule(tenant: string, group: string, monitorId: string, dryRun?: boolean): Promise<{ status: 'ok'; removed: boolean } | { status: 'invalid'; errors: ValidationError[] } | Refused>
  dropTimelines(tenant: string, monitorIds: string[]): Promise<{ status: 'ok' } | Refused>
}

export type RulerConfigPatchV2 = Partial<Omit<RulerConfigV2, 'limits'>> & { limits?: Partial<RulerLimitsV2> }

// ───────────────────────────── 5. Notifier RPC additions ─────────────────────────────

/** CHANGED (`AlertUpdate.generator`): `monitor` is the monitor id when the rule is a monitor. */
export interface AlertGeneratorV2 {
  group: string
  rule: string
  monitor?: string
}

export interface AlertUpdateV2 extends Omit<AlertUpdate, 'generator'> {
  generator: AlertGeneratorV2
}

export interface Acknowledgement {
  by: string
  at: number
}

/** EXTENDED (`NotifierAlert`). */
export interface NotifierAlertV2 extends NotifierAlert {
  acknowledged: Acknowledgement | null
  /** Latest end of the active silences muting the alert. */
  silencedUntil: number | null
}

export interface ReceiverSummary {
  name: string
  /** How it notifies: one entry per integration. Never a URL or a secret. */
  integrations: { kind: 'webhook' | 'slack'; channel: string | null; signed: boolean }[]
}

/** ADDED. Per alert, what the Monitor screens ask the notifier. */
export interface AlertNotifyState {
  fingerprint: string
  /** False while the ruler's hand-off has not arrived yet. */
  known: boolean
  acknowledged: Acknowledgement | null
  silencedUntil: number | null
  silencedBy: string[]
  inhibited: boolean
  lastNotifiedAt: number | null
  /** Null when nothing will repeat (acknowledged, silenced, or never notified). */
  nextRepeatAt: number | null
}

export interface DescribeItem {
  ref: string
  /** The rule's static labels plus `alertname`: where an alert of this rule would be routed. */
  labels: Record<string, string>
  fingerprints: string[]
}

export interface DescribeResult {
  ref: string
  receivers: ReceiverSummary[]
  alerts: AlertNotifyState[]
}

export type AlertActionResult =
  | {
      status: 'ok'
      /** Fingerprints the action applied to. */
      applied: string[]
      /** Fingerprints the notifier does not hold as firing: nothing was done for them. */
      skipped: string[]
    }
  | Refused

export type SilenceAlertsResult =
  | { status: 'ok'; silences: Silence[]; applied: string[]; skipped: string[]; undoToken: string; undoUntil: number }
  | { status: 'invalid'; errors: ValidationError[] }
  | Refused

/** EXTENDED (`WebhookConfig`). */
export interface WebhookConfigV2 extends WebhookConfig {
  /**
   * Shared secret for `SIGNATURE_HEADER`. Write-only: no RPC or HTTP response returns it.
   * Omitted on a later `setConfig`, the secret stored for the same receiver and URL is kept;
   * an empty string removes it.
   */
  secret?: string
}

/**
 * ADDED. `X-Viz-Signature: t=<unix seconds>,v1=<hex>` where
 * `v1 = HMAC-SHA256(secret, "<t>.<Idempotency-Key>.<body>")`. `t` is the time of the attempt.
 */
export const SIGNATURE_HEADER = 'X-Viz-Signature'

/** EXTENDED (`NotifierRpc`). `dryRun` reports what would happen and changes nothing. */
export interface NotifierRpcV2 extends NotifierRpc {
  /** CHANGED: who ended the silence (for the monitors' history), and a dry run. */
  expireSilence(tenant: string, id: string, by?: string, dryRun?: boolean): Promise<{ status: 'ok' } | { status: 'not_found' } | Refused>
  /** Record who took the alerts. Stops repeat notifications until each alert resolves; hides nothing. */
  acknowledge(tenant: string, fingerprints: string[], by: string, dryRun?: boolean): Promise<AlertActionResult>
  unacknowledge(tenant: string, fingerprints: string[], by: string, dryRun?: boolean): Promise<AlertActionResult>
  /** One silence per alert, matching exactly that alert's labels, for `durationMs` from now. */
  silenceAlerts(tenant: string, fingerprints: string[], durationMs: number, by: string, comment: string, dryRun?: boolean): Promise<SilenceAlertsResult>
  /** Remove the silences a `silenceAlerts` call made, while its undo window is open. */
  undoSilence(tenant: string, undoToken: string, by: string, dryRun?: boolean): Promise<{ status: 'ok'; removed: string[] } | { status: 'not_found' } | { status: 'expired'; undoUntil: number } | Refused>
  describe(tenant: string, items: DescribeItem[]): Promise<{ status: 'ok'; results: DescribeResult[]; configured: boolean } | Refused>
  notificationLog(tenant: string, monitorId: string): Promise<({ status: 'ok' } & Timeline) | Refused>
  /** The stored config with every secret and secret-bearing URL redacted. */
  getConfig(tenant: string): Promise<{ status: 'ok'; config: unknown | null; receivers: ReceiverSummary[] } | Refused>
  dropLogs(tenant: string, monitorIds: string[]): Promise<{ status: 'ok' } | Refused>
}

// ───────────────────────────── 8. the registry of ruler objects ─────────────────────────────

/**
 * ADDED. `RulerIndex`, a small Durable Object, `INDEX_PARTITIONS` of them, named
 * `index/<k>` with `k = hash(tenant) mod INDEX_PARTITIONS`. It knows which ruler shards
 * exist, per tenant, and how many shards a tenant's groups are spread over.
 */
export const INDEX_PARTITIONS = 16

export interface RulerIndexRpc {
  register(tenant: string, shard: string): Promise<{ status: 'ok'; added: boolean }>
  unregister(tenant: string, shard: string): Promise<{ status: 'ok'; removed: boolean }>
  /** The number of shards groups are assigned over (at least 1). Never shrinks. */
  shardCount(tenant: string): Promise<{ status: 'ok'; shards: number }>
  growShards(tenant: string, shards: number): Promise<{ status: 'ok'; shards: number }>
  /** One page of the platform sweep: call `ensureArmed` on each registered ruler after `cursor`. */
  sweepPage(cursor: string | null, limit: number): Promise<{ checked: number; rearmed: number; failed: number; next: string | null }>
}

// ───────────────────────────── HTTP: monitors ─────────────────────────────

/** ADDED. The body of `POST /api/v1/monitors` and `PUT /api/v1/monitors/{id}`. */
export interface MonitorInput {
  name: string
  /** Either `expr`, or `query` with `condition`. */
  expr?: string
  query?: string
  condition?: { op: ConditionOp; threshold: number; unit?: string }
  for?: string
  keepFiringFor?: string
  /** Group interval. Monitors with the same interval share a group, so they share a batch. */
  interval?: string
  /** Default `monitors/<interval>`. */
  group?: string
  description?: string
  /** Template; becomes the `summary` annotation. */
  message?: string
  runbookUrl?: string
  owner?: string
  /** A receiver name from the notifier config. */
  notify?: string
  noData?: NoDataMode
  noDataFor?: string
  startInvestigation?: boolean
  labels?: Record<string, string>
  annotations?: Record<string, string>
  /**
   * EXTENDED. An anomaly monitor: `query` is the expression to watch and a detector, not a
   * `condition`, decides when it alerts. Defaults follow the held-out evidence (see
   * `GET /api/v1/monitors/detectors`): detector `ewma` with the parameters chosen there, severity
   * `ticket`, `for` 0s (alarms are onsets), `keepFiringFor` 10m.
   */
  anomaly?: MonitorAnomalyInput
  /**
   * EXTENDED (with contract version 4). An SLO monitor: no `query` or `condition`; the SLI is the
   * expression and the burn-rate alerts decide (the SRE Workbook's by default).
   */
  slo?: MonitorSloInput
}

/** ADDED (with contract version 4). The `slo` field of a monitor document: the rule file's `slo` block in the API's spelling. */
export interface MonitorSloInput {
  objective: number
  window?: string
  sli: { good: string; total: string } | { bad: string; total: string } | { errorRatio: string }
  alerts?: { severity: SloSeverity; longWindow: string; shortWindow: string; burnRate: number }[]
  minEvents?: number
  minCoverage?: number
  maxSeries?: number
}

/** ADDED (with contract version 4). What the Monitor screens show of an SLO monitor. */
export interface MonitorSloView {
  objective: number
  windowMs: number
  sli: SloRuleV2['slo']['sli']
  alerts: SloRuleV2['slo']['alerts']
  minEvents: number
  minCoverage: number
  maxSeries: number
  history: SloHistory
  status: SloRuleStatus | null
}

/** ADDED. The `anomaly` field of a monitor document. */
export interface MonitorAnomalyInput {
  detector?: AnomalyDetector
  params?: Record<string, AnomalyParamValue>
  unit?: string
  severity?: AnomalySeverity
  maxSeries?: number
}

/** ADDED. What the Monitor screens show of an anomaly monitor. */
export interface MonitorAnomalyView {
  detector: AnomalyDetector
  params: Record<string, AnomalyParamValue>
  /** Parameter names the author gave; the rest are defaults. */
  given: string[]
  unit: string
  severity: AnomalySeverity
  maxSeries: number
  history: AnomalyHistory
  status: AnomalyRuleStatus | null
  /** What this detector is good for and how far the evidence for its defaults goes. */
  guide: DetectorGuide
}

/**
 * ADDED. One detector in `GET /api/v1/monitors/detectors`: what it is for, and the evidence,
 * with its kind stated (held-out NAB, post hoc, or none).
 */
export interface DetectorGuide {
  name: string
  /** Usable as an anomaly rule's detector; false: a library function for jobs and explanations. */
  inRules: boolean
  goodFor: string
  notFor: string
  /** May an anomaly rule with this detector have severity `page`. */
  pageAllowed: boolean
  defaultSeverity: AnomalySeverity | null
  /** The parameters the ruler fills in when the author gives none. */
  defaults: Record<string, AnomalyParamValue>
  /** Parameters an author must give. */
  required: string[]
  evidence: {
    /** `held_out`: chosen on one fold of NAB, scored on the other. `post_hoc`: changed after seeing results. `none`. */
    kind: 'held_out' | 'post_hoc' | 'none' | 'not_scorable'
    /** True only when the defaults above are the held-out-validated configuration. */
    defaultsValidated: boolean
    /** NAB held-out scores (standard / low FP / low FN), null when not scored. */
    nab: { standard: number; lowFp: number; lowFn: number } | null
    note: string
  }
}

export type MonitorState = 'firing' | 'pending' | 'ok' | 'no_data' | 'error' | 'unknown' | 'warming'

export interface MonitorAlertView {
  fingerprint: string
  labels: Record<string, string>
  state: 'pending' | 'firing'
  /** "Above threshold since": when the series first matched. */
  activeAt: number
  /** "Firing since": when `for` was satisfied. Null while pending. */
  firingSince: number | null
  /** When a pending alert will fire if it keeps matching. */
  firesAt: number | null
  value: number
  noData: boolean
  acknowledged: Acknowledgement | null
  silencedUntil: number | null
  inhibited: boolean
  lastNotifiedAt: number | null
  nextRepeatAt: number | null
  /** False while the notifier has not received the alert yet. */
  handedOff: boolean
}

export interface MonitorView {
  id: string
  name: string
  group: string
  shard: string
  state: MonitorState
  /** Earliest `firingSince` / `activeAt` over the monitor's alerts. */
  firingSince: number | null
  activeAt: number | null
  /** Of the alert that has been active longest. */
  value: number | null
  /** e.g. `> 500 ms for 5m`; null when the rule is a raw expression. */
  thresholdText: string | null
  expr: string
  query: string | null
  condition: { op: ConditionOp; threshold: number; unit: string } | null
  forMs: number
  keepFiringForMs: number
  intervalMs: number
  description: string
  message: string
  runbookUrl: string
  owner: string
  notify: string | null
  notifies: ReceiverSummary[]
  noData: NoDataMode
  noDataForMs: number
  startInvestigation: boolean
  labels: Record<string, string>
  annotations: Record<string, string>
  cost: RuleCost
  health: 'ok' | 'err' | 'unknown'
  lastError: string | null
  lastEvaluationMs: number | null
  /** Set when every active alert is acknowledged / silenced. */
  acknowledged: Acknowledgement | null
  silencedUntil: number | null
  alerts: MonitorAlertView[]
  /** False for a rule saved without monitor metadata: no history is recorded for it. */
  historyRecorded: boolean
  /** EXTENDED. Set for an anomaly monitor, null otherwise. */
  anomaly: MonitorAnomalyView | null
  /** EXTENDED (with contract version 4). Set for an SLO monitor, null otherwise. */
  slo: MonitorSloView | null
}

export type { CostClass, SaveGroupsResult }
