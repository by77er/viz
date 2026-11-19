import { DurableObject } from 'cloudflare:workers'
import { openSchema, refusalOf, type SchemaState } from '../../contracts/schema'
import type { PromMatrix, PromScalar, PromVector } from '../../contracts/engine'
import type {
  Alert,
  AlertingRuleV2 as AlertingRule,
  AnomalyRuleV2 as AnomalyRule,
  AnyRuleV2 as AnyRule,
  AlertUpdateV2 as AlertUpdate,
  BacktestResponse,
  BatchEvaluator,
  EvalRequest,
  EvalResult,
  Evaluator,
  GroupBundle,
  GroupHealth,
  GroupSnapshot,
  HistoryPlan,
  HistoryPlanner,
  IngestResult,
  RangeEvaluator,
  RuleV2 as Rule,
  RuleGroup,
  RulerConfigV2 as RulerConfig,
  RulerHealth,
  RulerLimits,
  RulerRpcV2 as RulerRpc,
  RuleSnapshot,
  RuleStatus,
  SampleBatch,
  SaveGroupsResult,
  SavedRule,
  Sink,
  SloRuleV2 as SloRule,
  Timeline,
  TimelineEntry,
  ValidationError,
  Validator,
  Refused,
  WarmupStatus,
} from '../contracts-proposal/rules.v2'
import { ANOMALY_LIMIT_DEFAULTS, anomalyLimits, emptyStatus, evalAnomaly, historyOf, maxClass, newAnomalyRt, readStateRows, stateRows, type AnomalyEval, type AnomalyRt } from './anomaly'
import { MAX_BACKTEST_STEPS, resolutionNote } from './backtest'
import { anomalyWarmPoints, anomalyWarmReads, backtestAlert, backtestAnomaly, backtestSlo, HISTORY_LIMIT_DEFAULTS, historyBudgets, MAX_WARMUP_ATTEMPTS, readWarmup, sloWarmReads, warmAnomaly, warmSlo, warmupBody, warmupStatus, type HistoryIo, type Read } from './history'
import { allRows, cloneSloRt, emptySloStatus, evalSlo, newSloRt, readSloRows, SLO_LIMIT_DEFAULTS, sliExpressions, sloHistory, tickRows, type SloEval, type SloRow, type SloRt } from './slo'
import { classify } from './classify'
import type { ServiceKeyResult, TenantServiceRpc } from '../../contracts/control'
import { ServiceCredential, type StoredKey } from './credential'
import { ENGINE_CALLS_IN_FLIGHT, Gate, httpEngine, type Fetcher, type HttpEngine } from './engine'
import { batchFromSingle, errorText, permissiveValidator } from './evaluator'
import { remoteWriteSink } from './remote'
import { stageExpired } from './util'
import { indexName } from './registry'
import { ruleFileDocument } from './rulefile'
import { RULER_SCHEMA } from './schema'
import { compileAlertRule, DEADMAN_ALERT, DEADMAN_GROUP, deadmanGroup, parseRuleFile, type CompiledAlertRule } from './rules'
import { evalAlertingRule, evalRecordingRule, isNoDataAlert, toSeries, type AlertEvalResult, type Series } from './statemachine'
import { alignedTick, backoffMs, byteLength, formatDuration, hash64, mapLimit, parseDuration, resolveObjectName } from './util'

/**
 * The ruler: Prometheus rule evaluation for one tenant rule shard.
 *
 * One object per `<tenant>/<n>`. It holds many rule groups and ONE alarm, set to the
 * earliest group deadline. Each tick evaluates every due group once, at the group's aligned
 * evaluation time; rules in a group run in order at that same time.
 *
 * What is durable, and when it is written:
 *
 *   rule_group   one row per group (the whole group as JSON)          on save
 *   alert        one row per pending / firing / retained alert        on a state transition
 *   handoff      alert transitions not yet accepted by the Notifier   same transaction as the transition
 *   meta/cursor  per-group last evaluation time and counters          at the heartbeat only
 *
 * A tick in which no alert changes state writes no rows. The sample value and annotations
 * of a steady alert are refreshed in memory only.
 *
 * Why replays are safe: an evaluation is a pure function of (stored alert state, query
 * result, evaluation time), see `statemachine.ts`. A transition and its hand-off row commit
 * together or not at all; the in-memory copy is swapped only after the commit. So a tick
 * that is retried, or re-run after an eviction, either finds the transition already made
 * (and makes none) or makes it for the first time.
 */

/** Production bindings. The evaluator and sink take the tenant explicitly; the ruler binds it. */
export interface RulerEnv {
  NOTIFIER?: DurableObjectNamespace
  /** The query engine. `evaluate` is the batch form; `instant` alone is adapted to it. */
  EVALUATOR?: {
    instant?(tenant: string, promql: string, timeMs: number): Promise<PromVector | PromScalar>
    evaluate?(tenant: string, requests: EvalRequest[]): Promise<EvalResult[]>
    range?(tenant: string, promql: string, startMs: number, endMs: number, stepMs: number): Promise<PromMatrix>
    plan?(tenant: string, promql: string, startMs: number, endMs: number, stepMs: number): Promise<HistoryPlan>
    check?(tenant: string, promql: string): ReturnType<Validator['check']>
  }
  SINK?: { write(tenant: string, batches: SampleBatch[]): Promise<void> }
  /** The registry the cron sweeper walks (`registry.ts`). */
  RULER_INDEX?: DurableObjectNamespace
  /**
   * Production wiring while the query Worker has no RPC entrypoint (README, "Needed
   * changes"): viz-query's Prometheus HTTP API (`engine.ts`), viz-ingest's Remote Write
   * (`remote.ts`), both with the shard's service key from control's `Tenant` object
   * (`credential.ts`, contracts/control.ts). `EVALUATOR` / `SINK`, when bound, win.
   */
  QUERY?: Fetcher
  INGEST?: Fetcher
  TENANT?: DurableObjectNamespace
  /** A staged trial's deadline (ISO 8601, set by deploy/configure.mjs --expires): after it, nothing is evaluated or re-armed. */
  VIZ_STAGE_EXPIRES_AT?: string
}

export interface NotifierPort {
  ingest(source: string, updates: AlertUpdate[]): Promise<IngestResult>
}

export interface IndexPort {
  register(shard: string): Promise<unknown>
  unregister(shard: string): Promise<unknown>
}

export const DEFAULT_RULER_CONFIG: RulerConfig = {
  limits: {
    maxGroups: 64,
    maxRulesPerGroup: 1000,
    maxAlertsPerRule: 1000,
    maxAnnotationBytes: 4096,
    maxGroupBytes: 1_500_000,
    minIntervalMs: 10_000,
    ...ANOMALY_LIMIT_DEFAULTS,
    ...SLO_LIMIT_DEFAULTS,
    ...HISTORY_LIMIT_DEFAULTS,
  },
  defaultIntervalMs: 60_000,
  heartbeatMs: 5 * 60_000,
  resolvedRetentionMs: 15 * 60_000,
  maxConcurrentGroups: 4,
  groupTimeoutMs: 120_000,
  externalLabels: {},
  hotWindowMs: 10 * 60_000,
  recentWindowMs: 24 * 3_600_000,
  lookbackMs: 5 * 60_000,
  deadman: true,
  deadmanIntervalMs: 60_000,
  timelineLimit: 200,
}

/** After the group's time budget is spent the evaluator gets this long to hand back what it has. */
const ABORT_GRACE_MS = 25

/** Alert updates per hand-off row. Keeps a row far below the 2 MB value cap. */
const HANDOFF_CHUNK = 200
const HANDOFF_ROWS_PER_TICK = 32
const SINK_ATTEMPTS = 3
const MAX_TICK_RETRIES = 5

interface RuleRt {
  health: 'ok' | 'err' | 'unknown'
  lastError: string | null
  lastEvaluationMs: number | null
  lastDurationMs: number | null
  /** The last successful evaluation found the rule's data missing (its no-data policy applied). */
  noData: boolean
}

/** The id a rule without monitor metadata is addressed by in the monitors API. */
export function bareRuleId(group: string, key: string): string {
  return `r_${hash64(`${group}\n${key}`)}`
}

interface GroupRt {
  spec: RuleGroup
  offsetMs: number
  /** Bumped whenever the group is replaced; a tick in flight for an older generation is abandoned. */
  gen: number
  /** The first evaluation is at the first aligned time at or after this. */
  notBefore: number
  compiled: (CompiledAlertRule | null)[]
  /** Anomaly and SLO rules' templates, by rule key. */
  anomalyCompiled: Map<string, CompiledAlertRule>
  /** Anomaly rule key → per-series detector state, as committed (rebuilt from `anomaly_state`). */
  anomaly: Map<string, AnomalyRt>
  /** SLO rule key → per-series bucket rings, as committed (rebuilt from `slo_state`). */
  slo: Map<string, SloRt>
  /** Anomaly and SLO rule key → how warming it from history went (rebuilt from `warmup`). */
  warmup: Map<string, WarmupStatus>
  /** rule key → fingerprint → alert */
  alerts: Map<string, Map<string, Alert>>
  rules: Map<string, RuleRt>
  lastEvalMs: number | null
  /** The cursor came from the heartbeat row, so ticks after it may have run unrecorded. */
  cursorApprox: boolean
  lastDurationMs: number | null
  evaluations: number
  skipped: number
  unobserved: number
  evaluatorErrors: number
}

interface Staged {
  rule: AlertingRule | AnomalyRule | SloRule
  result: Extract<AlertEvalResult, { ok: true }>
  /** Anomaly rules: the detector state to commit with the alerts. */
  anomaly?: Extract<AnomalyEval, { ok: true }>
  /** SLO rules: the working copy of the rings, to commit with the alerts. */
  slo?: { rt: SloRt; ev: Extract<SloEval, { ok: true }> }
}

/** Every rule of a group, in evaluation order: the ordinary rules, then the anomaly rules, then the SLO rules. */
export function allRules(spec: RuleGroup): AnyRule[] {
  return [...(spec.rules as AnyRule[]), ...((spec.anomalyRules ?? []) as AnomalyRule[]), ...((spec.sloRules ?? []) as SloRule[])]
}

/** The rules with state that a warm-up fills: anomaly and SLO rules. */
const stateRules = (spec: RuleGroup): (AnomalyRule | SloRule)[] => [...((spec.anomalyRules ?? []) as AnomalyRule[]), ...((spec.sloRules ?? []) as SloRule[])]

/**
 * The alert state machine reads only `name`, `forMs`, `keepFiringForMs` and `noData` of a rule,
 * which anomaly and SLO rules have with the same meaning.
 */
const asAlerting = (r: AnomalyRule | SloRule): AlertingRule => r as unknown as AlertingRule

type Cursor = { at: number; samplesDropped: number; groups: Record<string, [number | null, number, number, number, number]> }

const EMPTY: ReadonlyMap<string, Alert> = new Map()

export class Ruler extends DurableObject<RulerEnv> implements RulerRpc {
  protected tenant = ''
  protected shard = ''
  private objectName = ''
  /** What opening storage found. Anything but `ok`: every RPC answers `schema_too_new` and nothing is written. */
  private schema: SchemaState = { status: 'schema_too_new', component: RULER_SCHEMA.component, found: 0, compat: 0, known: 0, retryAfterMs: 0 }
  private cfg: RulerConfig = DEFAULT_RULER_CONFIG
  /** Set once anything has been configured or saved. An untouched object has no rows and no alarm. */
  private activatedAt: number | null = null
  private groups = new Map<string, GroupRt>()
  private handoffDepth = 0
  private handoffOldest: number | null = null
  private handoffNextSeq = 1
  private handoffFailures = 0
  private handoffRetryAt: number | null = null
  private lastHandoffError: string | null = null
  private lastHeartbeatMs = 0
  private samplesDropped = 0
  private ticking = false
  private tickFailures = 0
  private genCounter = 0
  /** Whether the registry lists this object (`registry.ts`); persisted, so it is asked once. */
  private registered = false
  /** Set at each heartbeat: the next tick re-checks the registration if it is not as wanted. */
  private registrationDue = false
  private counters = { sqlRowsWritten: 0, alarmsSet: 0, ticks: 0 }

  constructor(ctx: DurableObjectState, env: RulerEnv) {
    super(ctx, env)
    // `<tenant>/<n>`. The name is the only source of the tenant; an object reached by an
    // id that has no name serves nobody.
    // Versioned storage (contracts/COMPATIBILITY.md §2): migrate, or refuse storage a newer
    // release wrote. Local SQLite only, so holding other events off for it is allowed.
    void ctx.blockConcurrencyWhile(async () => {
      this.schema = openSchema(ctx.storage, RULER_SCHEMA)
      if (this.schema.status !== 'ok') return
      const sql = ctx.storage.sql
      // The object's own identity, not tenant data: one row, written when the object is first used.
      this.objectName = resolveObjectName(ctx.id.name, sql.exec<{ name: string }>(`SELECT name FROM self`).toArray()[0]?.name)
      const cut = this.objectName.lastIndexOf('/')
      this.tenant = cut > 0 ? this.objectName.slice(0, cut) : ''
      this.shard = cut > 0 ? this.objectName.slice(cut + 1) : ''
      this.load()
    })
  }

  // ───────────────────────── injection points ─────────────────────────
  // Production reads bindings and the real clock; `test/harness.ts` overrides these.

  protected now(): number {
    return Date.now()
  }

  /** Every engine call of this object goes through here: one at a time (`engine.ts`, six connections). */
  private readonly engineGate = new Gate(ENGINE_CALLS_IN_FLIGHT)
  private credentialRt: ServiceCredential | null = null

  /** The shard's service key (`credential.ts`), from control's `Tenant` object; stored in `meta`. */
  protected credential(): ServiceCredential {
    this.credentialRt ??= new ServiceCredential({
      now: () => this.now(),
      load: () => {
        const row = this.exec<{ v: string }>(`SELECT v FROM meta WHERE tenant = ? AND k = 'service_key'`, this.tenant)[0]
        return row ? (JSON.parse(row.v) as StoredKey) : null
      },
      save: (k) => {
        if (k === null) this.exec(`DELETE FROM meta WHERE tenant = ? AND k = 'service_key'`, this.tenant)
        else this.putMeta('service_key', k)
      },
      issue: () => this.issueServiceKey(),
    })
    return this.credentialRt
  }

  protected issueServiceKey(): Promise<ServiceKeyResult> {
    const ns = this.env.TENANT
    if (!ns) return Promise.reject(new Error('no TENANT binding (the control plane)'))
    const stub = ns.get(ns.idFromName(this.tenant)) as unknown as TenantServiceRpc
    return stub.serviceKey(this.tenant, 'viz-ruler', this.shard)
  }

  /** viz-query's HTTP API, when bound and no RPC evaluator is. */
  private httpEngine(): HttpEngine | null {
    const q = this.env.QUERY
    return q ? httpEngine(q, this.credential(), this.engineGate) : null
  }

  /** The single-call form. Kept as the input of the adapter; nothing else calls it. */
  protected evaluator(): Evaluator {
    const binding = this.env.EVALUATOR
    if (!binding?.instant) throw new Error('no EVALUATOR binding')
    const instant = binding.instant.bind(binding)
    return { instant: (promql, timeMs) => instant(this.tenant, promql, timeMs) }
  }

  /** What a tick uses: the engine's batch call when it has one, else the adapter over `evaluator()`. */
  protected batchEvaluator(): BatchEvaluator {
    const binding = this.env.EVALUATOR
    if (binding?.evaluate) {
      const evaluate = binding.evaluate.bind(binding)
      return { evaluate: (requests) => evaluate(this.tenant, requests) }
    }
    if (!binding?.instant) {
      const http = this.httpEngine()
      if (http) return { evaluate: (requests, opts) => http.evaluate(requests, opts) }
    }
    return batchFromSingle(this.evaluator())
  }

  protected rangeEvaluator(): RangeEvaluator {
    const binding = this.env.EVALUATOR
    if (!binding?.range) {
      const http = this.httpEngine()
      if (http) return { range: (promql, startMs, endMs, stepMs) => http.range(promql, startMs, endMs, stepMs) }
      throw new Error('no range evaluator binding')
    }
    const range = binding.range.bind(binding)
    return { range: (promql, startMs, endMs, stepMs) => range(this.tenant, promql, startMs, endMs, stepMs) }
  }

  /**
   * The range evaluator warm-ups read through: the same as backtests' (`rangeEvaluator`). Its own
   * injection point only so that the test harness can give tenants that script no history an
   * empty one, as a new metric has.
   */
  protected warmupRange(): RangeEvaluator {
    return this.rangeEvaluator()
  }

  /** The cost of a range read before it is made: the engine's `plan`, else query's `/api/v1/plan`. Without either, history is not read. */
  protected historyPlanner(): HistoryPlanner {
    const binding = this.env.EVALUATOR
    if (!binding?.plan) {
      const http = this.httpEngine()
      if (http) return { plan: (promql, startMs, endMs, stepMs) => http.plan(promql, startMs, endMs, stepMs) }
      return { plan: () => Promise.reject(new Error('no engine plan binding: the cost of the read cannot be checked, so it is not made')) }
    }
    const plan = binding.plan.bind(binding)
    return { plan: (promql, startMs, endMs, stepMs) => plan(this.tenant, promql, startMs, endMs, stepMs) }
  }

  /** Save-time PromQL validation: the engine's `check`, else query's `/api/v1/plan`, else permissive. */
  protected validator(): Validator {
    const binding = this.env.EVALUATOR
    if (!binding?.check) {
      const http = this.httpEngine()
      return http ? { check: (promql) => http.check(promql) } : permissiveValidator
    }
    const check = binding.check.bind(binding)
    return { check: (promql) => check(this.tenant, promql) }
  }

  protected index(): IndexPort | null {
    const ns = this.env.RULER_INDEX
    if (!ns) return null
    const stub = ns.get(ns.idFromName(indexName(this.tenant))) as unknown as { register(t: string, s: string): Promise<unknown>; unregister(t: string, s: string): Promise<unknown> }
    return { register: (shard) => stub.register(this.tenant, shard), unregister: (shard) => stub.unregister(this.tenant, shard) }
  }

  protected sink(): Sink {
    const binding = this.env.SINK
    if (!binding) {
      if (this.env.INGEST) return remoteWriteSink(this.env.INGEST, this.credential())
      throw new Error('no SINK binding')
    }
    return { write: (batches) => binding.write(this.tenant, batches) }
  }

  protected notifier(): NotifierPort {
    const ns = this.env.NOTIFIER
    if (!ns) throw new Error('no NOTIFIER binding')
    const stub = ns.get(ns.idFromName(this.tenant)) as unknown as { ingest(tenant: string, source: string, updates: AlertUpdate[]): Promise<IngestResult> }
    return { ingest: (source, updates) => stub.ingest(this.tenant, source, updates) }
  }

  /** Fault-injection point for crash tests. Does nothing in production. */
  protected fault(_point: 'commit' | 'after-commit' | 'handoff-sent' | 'warmup-commit'): void {}

  // ───────────────────────── storage helpers ─────────────────────────

  /** Run a statement, count the rows it wrote (they are billed), return its rows. */
  private exec<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: SqlStorageValue[]): T[] {
    const cursor = this.ctx.storage.sql.exec<T>(query, ...bindings)
    const rows = cursor.toArray()
    this.counters.sqlRowsWritten += cursor.rowsWritten
    return rows
  }

  private putMeta(k: string, v: unknown): void {
    this.exec(`INSERT INTO meta (tenant, k, v) VALUES (?, ?, ?) ON CONFLICT (tenant, k) DO UPDATE SET v = excluded.v`, this.tenant, k, JSON.stringify(v))
  }

  /** Rebuild every piece of in-memory state from SQLite. */
  private load(): void {
    const t = this.tenant
    const meta = new Map(this.exec<{ k: string; v: string }>(`SELECT k, v FROM meta WHERE tenant = ?`, t).map((r) => [r.k, r.v]))
    const cfg = meta.get('config')
    if (cfg) this.cfg = mergeConfig(DEFAULT_RULER_CONFIG, JSON.parse(cfg) as Partial<RulerConfig>)
    const activated = meta.get('activated_at')
    this.activatedAt = activated ? (JSON.parse(activated) as number) : null
    this.registered = meta.get('registered') === 'true'
    const cursor = meta.has('cursor') ? (JSON.parse(meta.get('cursor') as string) as Cursor) : null
    this.lastHeartbeatMs = cursor?.at ?? 0
    this.samplesDropped = cursor?.samplesDropped ?? 0

    for (const row of this.exec<{ name: string; spec: string; not_before: number }>(`SELECT name, spec, not_before FROM rule_group WHERE tenant = ?`, t)) {
      this.groups.set(row.name, this.newGroup(JSON.parse(row.spec) as RuleGroup, row.not_before))
    }
    this.syncDeadman()
    for (const row of this.exec<{ grp: string; rule_key: string; fp: string; body: string }>(`SELECT grp, rule_key, fp, body FROM alert WHERE tenant = ?`, t)) {
      const g = this.groups.get(row.grp)
      if (!g) continue
      let m = g.alerts.get(row.rule_key)
      if (!m) g.alerts.set(row.rule_key, (m = new Map()))
      m.set(row.fp, reviveAlert(row.body))
    }
    // Detector state: the only copy is these rows, so memory is exactly what was last committed.
    const bodies = new Map<string, string[]>()
    for (const row of this.exec<{ grp: string; rule_key: string; body: string }>(`SELECT grp, rule_key, body FROM anomaly_state WHERE tenant = ? ORDER BY grp, rule_key, chunk`, t)) {
      const k = `${row.grp}\n${row.rule_key}`
      bodies.set(k, [...(bodies.get(k) ?? []), row.body])
    }
    for (const [k, rows] of bodies) {
      const cut = k.lastIndexOf('\n')
      const rt = this.groups.get(k.slice(0, cut))?.anomaly.get(k.slice(cut + 1))
      if (!rt) continue
      const read = readStateRows(rows)
      if ('error' in read) {
        // A newer release's row format: refuse the rule and keep the rows (COMPATIBILITY.md §3.2).
        rt.unreadable = read.error
        rt.rawRows = rows
        rt.status = { ...rt.status, status: 'state_unreadable', message: read.error }
        continue
      }
      rt.series = read.series
      rt.json = read.json
      rt.status = { ...rt.status, stateSeries: read.series.size, stateBytes: rows.reduce((n, b) => n + byteLength(b), 0) }
    }
    // SLO rings: the same, from `slo_state`.
    const sloRows = new Map<string, SloRow[]>()
    for (const row of this.exec<{ grp: string; rule_key: string; part: string; block: number; body: string }>(`SELECT grp, rule_key, part, block, body FROM slo_state WHERE tenant = ? ORDER BY grp, rule_key, part, block`, t)) {
      const k = `${row.grp}\n${row.rule_key}`
      let list = sloRows.get(k)
      if (!list) sloRows.set(k, (list = []))
      list.push({ part: row.part as SloRow['part'], block: row.block, body: row.body })
    }
    for (const [k, rows] of sloRows) {
      const cut = k.lastIndexOf('\n')
      const g = this.groups.get(k.slice(0, cut))
      const rule = g?.spec.sloRules?.find((r) => r.key === k.slice(cut + 1)) as SloRule | undefined
      if (!g || !rule) continue
      this.adoptSloRows(g, rule, rows)
    }
    for (const row of this.exec<{ grp: string; rule_key: string; body: string }>(`SELECT grp, rule_key, body FROM warmup WHERE tenant = ?`, t)) {
      const g = this.groups.get(row.grp)
      if (!g) continue
      const w = readWarmup(row.body)
      if (w) g.warmup.set(row.rule_key, w)
    }
    if (cursor) {
      for (const [name, c] of Object.entries(cursor.groups)) {
        const g = this.groups.get(name)
        if (!g) continue
        ;[g.lastEvalMs, g.skipped, g.unobserved, g.evaluations, g.evaluatorErrors] = c
        if (g.lastEvalMs !== null && g.lastEvalMs < g.notBefore) g.lastEvalMs = null
        g.cursorApprox = g.lastEvalMs !== null && this.cfg.heartbeatMs > 0
      }
    }
    const h = this.exec<{ n: number; oldest: number | null; top: number | null }>(
      `SELECT COUNT(*) AS n, MIN(created_at) AS oldest, MAX(seq) AS top FROM handoff WHERE tenant = ?`, t)[0]
    this.handoffDepth = h?.n ?? 0
    this.handoffOldest = h?.oldest ?? null
    this.handoffNextSeq = (h?.top ?? 0) + 1
  }

  /** Memory for one SLO rule from its rows; rows a newer release wrote are refused and kept. */
  private adoptSloRows(g: GroupRt, rule: SloRule, rows: SloRow[]): void {
    const read = readSloRows(rule, g.spec.intervalMs, rows)
    const rt = g.slo.get(rule.key) ?? newSloRt(rule)
    if ('error' in read) {
      // A newer release's row format: refuse the rule and keep the rows (COMPATIBILITY.md §3.2).
      rt.unreadable = read.error
      rt.rawRows = rows
      rt.status = { ...rt.status, status: 'state_unreadable', message: read.error }
      g.slo.set(rule.key, rt)
      return
    }
    g.slo.set(rule.key, read.rt)
  }

  private newGroup(spec: RuleGroup, notBefore: number): GroupRt {
    return {
      spec,
      // Prometheus derives a group's offset from a hash of its file and name; here the
      // tenant shard stands in for the file. Stable across saves and restarts.
      offsetMs: parseInt(hash64(`${this.tenant}/${this.shard}/${spec.name}`).slice(0, 12), 16) % spec.intervalMs,
      gen: ++this.genCounter,
      notBefore,
      compiled: spec.rules.map((r) => (r.kind === 'alert' ? compileAlertRule(r) : null)),
      anomalyCompiled: new Map(stateRules(spec).map((r) => [r.key, compileAlertRule(asAlerting(r))])),
      anomaly: new Map(((spec.anomalyRules ?? []) as AnomalyRule[]).map((r) => [r.key, newAnomalyRt(r)])),
      slo: new Map(((spec.sloRules ?? []) as SloRule[]).map((r) => [r.key, newSloRt(r)])),
      warmup: new Map(),
      alerts: new Map(),
      rules: new Map(allRules(spec).map((r) => [r.key, { health: 'unknown', lastError: null, lastEvaluationMs: null, lastDurationMs: null, noData: false }])),
      lastEvalMs: null,
      cursorApprox: false,
      lastDurationMs: null,
      evaluations: 0,
      skipped: 0,
      unobserved: 0,
      evaluatorErrors: 0,
    }
  }

  /** The dead-man's switch lives on shard 0 of an activated tenant, in memory only (its alerts are stored like any other). */
  private syncDeadman(): void {
    const want = this.cfg.deadman && this.shard === '0' && this.activatedAt !== null
    const have = this.groups.get(DEADMAN_GROUP)
    if (want && (!have || have.spec.intervalMs !== this.cfg.deadmanIntervalMs)) {
      const g = this.newGroup(deadmanGroup(this.cfg), have ? this.now() : (this.activatedAt as number))
      if (have) g.alerts = have.alerts
      this.groups.set(DEADMAN_GROUP, g)
    } else if (!want && have) {
      this.groups.delete(DEADMAN_GROUP)
    }
  }

  /** Every RPC asks this first: storage this code may not touch, or another tenant's object. */
  private wrongTenant(tenant: string): Refused | null {
    const refused = refusalOf(this.schema)
    if (refused) return refused
    return this.tenant !== '' && tenant === this.tenant ? null : { status: 'wrong_tenant' }
  }

  private activate(now: number): void {
    if (this.activatedAt !== null) return
    this.activatedAt = now
    this.exec(`INSERT OR IGNORE INTO self (one, name) VALUES (1, ?)`, this.objectName)
    this.putMeta('activated_at', now)
    this.putMeta('config', this.cfg)
  }

  // ───────────────────────── scheduling ─────────────────────────

  /** First aligned time at or after `t`. */
  private ceilTick(g: GroupRt, t: number): number {
    const a = alignedTick(t, g.spec.intervalMs, g.offsetMs)
    return a === t ? t : a + g.spec.intervalMs
  }

  /** When `g` is next due, given that every tick up to the aligned time at `now` is done or skipped. */
  private nextDue(g: GroupRt, now: number): number {
    return Math.max(this.ceilTick(g, g.notBefore), alignedTick(now, g.spec.intervalMs, g.offsetMs) + g.spec.intervalMs)
  }

  private async setAlarm(at: number): Promise<void> {
    this.counters.alarmsSet++
    await this.ctx.storage.setAlarm(at)
  }

  /** RPCs only ever pull the alarm earlier; the tick owns the full schedule. */
  private async armAtMost(at: number): Promise<void> {
    const cur = await this.ctx.storage.getAlarm()
    if (cur === null || at < cur) await this.setAlarm(at)
  }

  /** After a tick: one alarm at the earliest deadline, or none when there is nothing to do. */
  private async reschedule(now: number): Promise<void> {
    let at = Infinity
    for (const g of this.groups.values()) at = Math.min(at, this.nextDue(g, now))
    if (this.handoffDepth > 0) at = Math.min(at, this.handoffRetryAt ?? now)
    if (at === Infinity) await this.ctx.storage.deleteAlarm()
    else await this.setAlarm(at)
  }

  // ───────────────────────── the tick ─────────────────────────

  async alarm(): Promise<void> {
    const refused = refusalOf(this.schema)
    if (refused) {
      // Keep the alarm for the release that owns this storage; touch nothing else.
      await this.ctx.storage.setAlarm(Date.now() + refused.retryAfterMs)
      return
    }
    // A staged trial past its deadline stops by itself (AGENTS.md: timers end at a deadline).
    if (stageExpired(this.env.VIZ_STAGE_EXPIRES_AT, Date.now())) {
      await this.ctx.storage.deleteAlarm()
      return
    }
    await this.tick()
  }

  private async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    const now = this.now()
    try {
      this.counters.ticks++
      const due: { g: GroupRt; ts: number }[] = []
      for (const g of this.groups.values()) {
        const ts = alignedTick(now, g.spec.intervalMs, g.offsetMs)
        // Not started yet, or this (group, evaluation time) is already done: a replayed alarm lands here.
        if (ts < g.notBefore || (g.lastEvalMs !== null && ts <= g.lastEvalMs)) continue
        // Missed ticks are counted, never replayed: evaluate once, at the latest due time.
        const previous = g.lastEvalMs ?? this.ceilTick(g, g.notBefore) - g.spec.intervalMs
        const missed = Math.max(0, Math.round((ts - previous) / g.spec.intervalMs) - 1)
        if (g.cursorApprox) g.unobserved += missed
        else g.skipped += missed
        due.push({ g, ts })
      }
      await mapLimit(due, this.cfg.maxConcurrentGroups, ({ g, ts }) => this.evalGroup(g, ts))
      this.heartbeat(now)
      await this.drainHandoff(now)
      if (this.registrationDue) {
        this.registrationDue = false
        await this.syncRegistration()
      }
      this.tickFailures = 0
    } catch (e) {
      // The tick died part-way (a storage error, say). Whatever committed is durable and
      // the rest is not in memory, so running it again is safe. Do not rely on the
      // platform's alarm retry alone: come back shortly, a bounded number of times, and
      // after that on the normal schedule (the missed evaluations are then counted).
      this.ticking = false
      if (++this.tickFailures <= MAX_TICK_RETRIES) await this.setAlarm(now + backoffMs(this.tickFailures, 1000, 30_000, `${this.tenant}/${this.shard}/tick`))
      else await this.reschedule(now)
      throw e
    }
    this.ticking = false
    await this.reschedule(now)
  }

  /**
   * One tick of one group. All of the group's expressions go to the evaluator in ONE batch
   * call, with one exception: a rule whose text mentions a series recorded earlier in the
   * same group starts a new batch, after the recorded samples have been handed to the sink
   * (README, "Recording rules read in the same tick").
   */
  private async evalGroup(g: GroupRt, ts: number): Promise<void> {
    const gen = g.gen
    const started = Date.now() // real clock on purpose: this is a duration, not a schedule
    const current = () => this.groups.get(g.spec.name) === g && g.gen === gen
    let evaluator: BatchEvaluator | null = null
    const queryTime = ts - g.spec.queryOffsetMs
    const hardCap = this.cfg.limits.maxAlertsPerRule
    const limit = g.spec.limit > 0 ? Math.min(g.spec.limit, hardCap) : hardCap
    const staged: Staged[] = []
    let pending: { rule: Rule; batch: SampleBatch }[] = []
    // New anomaly and SLO rules are warmed from history before their first evaluation; one whose
    // warm-up the engine just failed sits this tick out (it says so) and is tried again.
    const waiting = await this.warmUp(g, queryTime - g.spec.intervalMs, current)
    if (!current()) return
    const rules = allRules(g.spec).filter((r) => !waiting.has(r.key))
    const aLimits = anomalyLimits(this.cfg)

    // The time budget. At the deadline the evaluator is told to stop (`abort`) and the sink
    // is given up on (`timeout`); an evaluator that ignores the signal is abandoned a
    // moment later (`hard`).
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let grace: ReturnType<typeof setTimeout> | undefined
    let timedOut: Error | null = null
    let rejectHard!: (e: Error) => void
    const hard = new Promise<never>((_, reject) => (rejectHard = reject))
    hard.catch(() => {})
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = new Error(`group evaluation exceeded ${this.cfg.groupTimeoutMs} ms`)
        reject(timedOut)
        abort.abort(timedOut)
        grace = setTimeout(() => rejectHard(timedOut as Error), ABORT_GRACE_MS)
      }, this.cfg.groupTimeoutMs)
    })
    timeout.catch(() => {})

    const setHealth = (rule: AnyRule, error: string | null, durationMs: number | null = g.rules.get(rule.key)?.lastDurationMs ?? null, noData = g.rules.get(rule.key)?.noData ?? false) => {
      g.rules.set(rule.key, { health: error === null ? 'ok' : 'err', lastError: error, lastEvaluationMs: ts, lastDurationMs: durationMs, noData })
    }
    const flushSink = async () => {
      if (pending.length === 0) return
      const batch = pending
      pending = []
      let lastError = ''
      for (let attempt = 1; attempt <= SINK_ATTEMPTS; attempt++) {
        try {
          await Promise.race([this.sink().write(batch.map((p) => p.batch)), timeout])
          return
        } catch (e) {
          lastError = errorText(e)
        }
      }
      this.samplesDropped += batch.length
      for (const p of batch) setHealth(p.rule, `sink: ${lastError}`)
    }

    // Split the rules into batches. A new batch starts before a rule that reads a name
    // recorded since the last batch boundary.
    const stages: number[][] = []
    let stage: number[] = []
    let recordedHere: string[] = []
    rules.forEach((rule, i) => {
      const reads = (name: string) => rule.expr.includes(name) || (rule.kind !== 'record' && rule.noData?.expr?.includes(name) === true)
      if (stage.length > 0 && recordedHere.some(reads)) {
        stages.push(stage)
        stage = []
        recordedHere = []
      }
      stage.push(i)
      if (rule.kind === 'record') recordedHere.push(rule.name)
    })
    if (stage.length > 0) stages.push(stage)

    try {
      for (const indexes of stages) {
        if (!current()) return
        const requests: EvalRequest[] = []
        for (const i of indexes) {
          const rule = rules[i] as AnyRule
          requests.push({ id: rule.key, promql: rule.expr, timeMs: queryTime })
          if (rule.kind !== 'record' && rule.noData?.expr) requests.push({ id: `${rule.key}#presence`, promql: rule.noData.expr, timeMs: queryTime })
        }
        const results = new Map<string, EvalResult>()
        // The whole call failing (the engine is unreachable) fails every rule of the batch;
        // a failure inside the batch belongs to its own rule only.
        let batchError: string | null = null
        try {
          if (timedOut) throw timedOut
          evaluator ??= this.batchEvaluator()
          for (const r of await Promise.race([evaluator.evaluate(requests, { signal: abort.signal }), hard])) results.set(r.id, r)
        } catch (e) {
          batchError = errorText(e)
        }
        if (!current()) return
        for (const i of indexes) {
          const rule = rules[i] as AnyRule
          const res = results.get(rule.key)
          const wantsPresence = rule.kind !== 'record' && Boolean(rule.noData?.expr)
          const pres = wantsPresence ? results.get(`${rule.key}#presence`) : undefined
          let error = batchError ?? (res === undefined ? 'the evaluator returned no result for this rule' : res.ok ? null : res.error)
          if (error === null && wantsPresence) error = pres === undefined ? 'the evaluator returned no result for the no-data check' : pres.ok ? null : `no-data check: ${pres.error}`
          let series: Series[] = []
          let presence: Series[] | null = null
          if (error === null) {
            try {
              series = toSeries((res as Extract<EvalResult, { ok: true }>).result)
              if (pres?.ok) presence = toSeries(pres.result)
            } catch (e) {
              error = errorText(e)
            }
          }
          if (error !== null) {
            // The query failed: say so, and leave the rule's alerts exactly as they were.
            g.evaluatorErrors++
            setHealth(rule, error, res?.durationMs ?? null)
            continue
          }
          if (rule.kind === 'anomaly') {
            // The detector decides which series are the rule's result; the alert state machine
            // does the rest. A refused evaluation (series cap, state limit) changes nothing.
            const rt = g.anomaly.get(rule.key) as AnomalyRt
            const ev = evalAnomaly(rule, rt, series, queryTime, g.spec.intervalMs, aLimits, rule.annotations)
            if (!ev.ok) {
              rt.status = ev.status
              setHealth(rule, ev.error, res?.durationMs ?? null)
              continue
            }
            const result = evalAlertingRule(asAlerting(rule), g.anomalyCompiled.get(rule.key) as CompiledAlertRule, g.alerts.get(rule.key) ?? EMPTY, ev.flagged, ts, {
              resolvedRetentionMs: this.cfg.resolvedRetentionMs,
              limit,
              maxAnnotationBytes: this.cfg.limits.maxAnnotationBytes,
              externalLabels: this.cfg.externalLabels,
            }, presence ?? ev.present)
            if (result.ok) staged.push({ rule, result, anomaly: ev })
            setHealth(rule, result.ok ? null : result.error, res?.durationMs ?? null, result.ok ? result.noData : undefined)
          } else if (rule.kind === 'slo') {
            // The burn-rate alerts decide which series (and severities) are the rule's result. The
            // rings are evaluated on a working copy, adopted only after the commit.
            const rt = g.slo.get(rule.key) as SloRt
            const work = cloneSloRt(rt)
            const ev = evalSlo(rule, work, series, queryTime, g.spec.intervalMs)
            if (!ev.ok) {
              rt.status = ev.status
              setHealth(rule, ev.error, res?.durationMs ?? null)
              continue
            }
            const result = evalAlertingRule(asAlerting(rule), g.anomalyCompiled.get(rule.key) as CompiledAlertRule, g.alerts.get(rule.key) ?? EMPTY, ev.flagged, ts, {
              resolvedRetentionMs: this.cfg.resolvedRetentionMs,
              limit,
              maxAnnotationBytes: this.cfg.limits.maxAnnotationBytes,
              externalLabels: this.cfg.externalLabels,
            }, presence ?? ev.present)
            if (result.ok) staged.push({ rule, result, slo: { rt: work, ev } })
            setHealth(rule, result.ok ? null : result.error, res?.durationMs ?? null, result.ok ? result.noData : undefined)
          } else if (rule.kind === 'alert') {
            const result = evalAlertingRule(rule, g.compiled[i] as CompiledAlertRule, g.alerts.get(rule.key) ?? EMPTY, series, ts, {
              resolvedRetentionMs: this.cfg.resolvedRetentionMs,
              limit,
              maxAnnotationBytes: this.cfg.limits.maxAnnotationBytes,
              externalLabels: this.cfg.externalLabels,
            }, presence)
            if (result.ok) staged.push({ rule, result })
            setHealth(rule, result.ok ? null : result.error, res?.durationMs ?? null, result.ok ? result.noData : undefined)
          } else {
            const result = evalRecordingRule(rule, series, queryTime, limit)
            if (result.ok && result.samples.length > 0) {
              pending.push({ rule, batch: { id: `${this.tenant}/${this.shard}/${g.spec.name}/${rule.key}@${ts}`, samples: result.samples } })
            }
            setHealth(rule, result.ok ? null : result.error, res?.durationMs ?? null)
          }
        }
        // Recorded samples leave before the next batch is evaluated, and once at the end.
        await flushSink()
      }
    } finally {
      clearTimeout(timer)
      clearTimeout(grace)
    }
    if (!current()) return
    // From here to the end there is no await: commit, then swap memory, then move the cursor.
    this.commit(g, ts, staged)
    g.lastEvalMs = ts
    g.cursorApprox = false
    g.evaluations++
    g.lastDurationMs = Date.now() - started
  }

  /** Persist the tick's transitions and their hand-off rows in one transaction, then adopt the new state. */
  private commit(g: GroupRt, ts: number, staged: Staged[]): void {
    if (staged.some((s) => s.result.dirty.size > 0 || s.anomaly?.changed === true || s.slo?.ev.changed === true)) {
      const t = this.tenant
      const updates: AlertUpdate[] = []
      this.ctx.storage.transactionSync(() => {
        for (const { rule, result } of staged) {
          for (const fp of result.dirty) {
            const a = result.alerts.get(fp)
            if (a) {
              this.exec(`INSERT INTO alert (tenant, grp, rule_key, fp, body) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT (tenant, grp, rule_key, fp) DO UPDATE SET body = excluded.body`, t, g.spec.name, rule.key, fp, JSON.stringify(a))
            } else {
              this.exec(`DELETE FROM alert WHERE tenant = ? AND grp = ? AND rule_key = ? AND fp = ?`, t, g.spec.name, rule.key, fp)
            }
          }
          const before = g.alerts.get(rule.key) ?? EMPTY
          for (const n of result.notify) {
            const a = (n.status === 'firing' ? result.alerts.get(n.fingerprint) : before.get(n.fingerprint)) as Alert
            updates.push(this.toUpdate(g, rule, a, n.status, ts))
          }
          // A monitor's history: the state changes of this tick, in the same transaction.
          if (rule.monitor) this.appendTimeline(rule.monitor.id, transitions(before, result.alerts, result.dirty, ts))
        }
        // Detector state goes in the same transaction as the alerts it produced, so a replay
        // finds both or neither. Whole batches of series per row, never a row per series.
        for (const { rule, anomaly } of staged) if (anomaly?.changed) this.writeAnomalyState(g.spec.name, rule.key, anomaly.json)
        // SLO rings likewise: the head and the current block of each ring, as whole batches.
        for (const { rule, slo } of staged) if (slo?.ev.changed) this.writeSloTick(g, rule as SloRule, slo.rt)
        this.enqueueHandoff(updates, ts)
        this.fault('commit')
      })
      this.noteHandoff(updates, ts)
    }
    for (const { rule, result, anomaly, slo } of staged) {
      g.alerts.set(rule.key, result.alerts)
      if (anomaly) {
        const rt = g.anomaly.get(rule.key) as AnomalyRt
        rt.series = anomaly.next
        rt.json = anomaly.json
        rt.status = anomaly.status
        rt.pruned = anomaly.status.pruned
      }
      if (slo) {
        slo.rt.status = { ...slo.ev.status, stateBytes: slo.rt.stateBytes }
        g.slo.set(rule.key, slo.rt)
      }
    }
    this.fault('after-commit')
  }

  /**
   * Inside a transaction: replace one anomaly rule's state rows. Rows written per evaluation =
   * ceil(state bytes / ANOMALY_ROW_BYTES), plus the rows of a shrinking state that are deleted.
   */
  private writeAnomalyState(group: string, key: string, json: Map<string, string>): void {
    const rows = stateRows(json)
    rows.forEach((body, chunk) => {
      this.exec(`INSERT INTO anomaly_state (tenant, grp, rule_key, chunk, body) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (tenant, grp, rule_key, chunk) DO UPDATE SET body = excluded.body`, this.tenant, group, key, chunk, body)
    })
    this.exec(`DELETE FROM anomaly_state WHERE tenant = ? AND grp = ? AND rule_key = ? AND chunk >= ?`, this.tenant, group, key, rows.length)
  }

  /**
   * Whether a rule has state a warm-up must not replace: series it has scored, or rows a newer
   * release wrote that this one cannot read (kept as they are, never started cold over).
   */
  private hasState(g: GroupRt, r: AnomalyRule | SloRule): boolean {
    if (r.kind === 'anomaly') {
      const rt = g.anomaly.get(r.key)
      return rt !== undefined && (rt.series.size > 0 || rt.rawRows !== null)
    }
    const rt = g.slo.get(r.key)
    return rt !== undefined && (rt.lastTs !== null || rt.rawRows !== null)
  }

  /**
   * Inside a transaction: one SLO tick's rows. The head and the current block of each ring are
   * replaced; blocks that left the rings are deleted (3 rows written a tick, plus a delete when a
   * block leaves). `rt.stateBytes` is kept as the sum of the rule's row bytes.
   */
  private writeSloTick(g: GroupRt, rule: SloRule, rt: SloRt): void {
    const t = this.tenant
    const { rows, keepFine, keepCoarse } = tickRows(rt, rule, g.spec.intervalMs)
    for (const r of rows) {
      this.exec(`INSERT INTO slo_state (tenant, grp, rule_key, part, block, body) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (tenant, grp, rule_key, part, block) DO UPDATE SET body = excluded.body`, t, g.spec.name, rule.key, r.part, r.block, r.body)
    }
    this.exec(`DELETE FROM slo_state WHERE tenant = ? AND grp = ? AND rule_key = ? AND ((part = 'fine' AND block < ?) OR (part = 'coarse' AND block < ?))`, t, g.spec.name, rule.key, keepFine, keepCoarse)
    rt.stateBytes = this.exec<{ n: number }>(`SELECT COALESCE(SUM(LENGTH(CAST(body AS BLOB))), 0) AS n FROM slo_state WHERE tenant = ? AND grp = ? AND rule_key = ?`, t, g.spec.name, rule.key)[0]?.n ?? 0
  }

  /** Inside a transaction: replace all of one SLO rule's rows (a warm-up, a shard move). */
  private writeSloAll(group: string, key: string, rows: SloRow[]): void {
    this.exec(`DELETE FROM slo_state WHERE tenant = ? AND grp = ? AND rule_key = ?`, this.tenant, group, key)
    for (const r of rows) this.exec(`INSERT INTO slo_state (tenant, grp, rule_key, part, block, body) VALUES (?, ?, ?, ?, ?, ?)`, this.tenant, group, key, r.part, r.block, r.body)
  }

  private putWarmup(group: string, key: string, w: WarmupStatus): void {
    this.exec(`INSERT INTO warmup (tenant, grp, rule_key, body) VALUES (?, ?, ?, ?) ON CONFLICT (tenant, grp, rule_key) DO UPDATE SET body = excluded.body`, this.tenant, group, key, warmupBody(w))
  }

  /**
   * Warm the group's pending anomaly and SLO rules so that their state at `endTs` (the query time
   * before this tick's) is what it would be had they run all along. Per rule: the reads are planned
   * (nothing fetched); over the budget, or refused by the engine's plan, the warm-up is refused and
   * the rule starts cold; otherwise the reads are fetched whole and fed, in time order, through the
   * rule's own evaluation; the state rows and the status commit in one transaction. An engine
   * failure leaves the job pending (the rule waits this tick out) until `MAX_WARMUP_ATTEMPTS`, then
   * the rule starts cold. Returns the keys of rules that wait.
   */
  private async warmUp(g: GroupRt, endTs: number, current: () => boolean): Promise<Set<string>> {
    const waiting = new Set<string>()
    const budgets = historyBudgets(this.cfg.limits)
    const budget = budgets.warmup
    const aLimits = anomalyLimits(this.cfg)
    const I = g.spec.intervalMs
    for (const rule of stateRules(g.spec)) {
      const job = g.warmup.get(rule.key)
      if (!job || job.status !== 'pending') continue
      const base0: WarmupStatus = { ...job, attempts: job.attempts }
      const unreadable = rule.kind === 'anomaly' ? g.anomaly.get(rule.key)?.unreadable : g.slo.get(rule.key)?.unreadable
      if (unreadable) {
        // State a newer release wrote is kept as it is, never replaced by a warm-up.
        this.ctx.storage.transactionSync(() => this.putWarmup(g.spec.name, rule.key, { ...base0, status: 'refused', message: `the stored state is a newer release's (${unreadable}); it is kept and not warmed over`, finishedAt: this.now() }))
        g.warmup.set(rule.key, { ...base0, status: 'refused', message: `the stored state is a newer release's (${unreadable}); it is kept and not warmed over`, finishedAt: this.now() })
        continue
      }
      let reads: Read[]
      let slo: ReturnType<typeof sloWarmReads> | null = null
      if (rule.kind === 'anomaly') reads = anomalyWarmReads(rule, I, endTs)
      else {
        slo = sloWarmReads(rule, I, endTs)
        reads = slo.coarse ? [slo.fine, slo.coarse] : [slo.fine]
      }
      const base: WarmupStatus = { ...warmupStatus(reads, budget), attempts: job.attempts }
      const finish = (w: WarmupStatus, write?: () => void) => {
        if (!current()) return
        this.ctx.storage.transactionSync(() => {
          write?.()
          this.putWarmup(g.spec.name, rule.key, w)
          this.fault('warmup-commit')
        })
        g.warmup.set(rule.key, w)
      }
      if (reads.length === 0) {
        finish({ ...base, status: 'not_needed', finishedAt: this.now() })
        continue
      }
      // Read in windows sized to the memory budget, planned first, fed in time order.
      const io: HistoryIo = { planner: this.historyPlanner(), range: this.warmupRange(), budget, memoryBytes: budgets.warmupMemory }
      let run: Awaited<ReturnType<typeof warmAnomaly>> | Awaited<ReturnType<typeof warmSlo>>
      try {
        run = rule.kind === 'anomaly' ? await warmAnomaly(rule, reads[0]!, aLimits, io) : await warmSlo(rule, I, (slo as NonNullable<typeof slo>).fine, (slo as NonNullable<typeof slo>).coarse, io)
      } catch (e) {
        const attempts = job.attempts + 1
        const last = attempts >= MAX_WARMUP_ATTEMPTS
        finish({ ...base, status: last ? 'failed' : 'pending', attempts, message: `the engine failed the read (${errorText(e)}); ${last ? 'the rule started cold' : 'tried again at the next tick'}`, finishedAt: last ? this.now() : null })
        if (!last) waiting.add(rule.key)
        continue
      }
      if (!current()) return waiting
      if (!run.ok) {
        // Refused before anything was fetched (budget, memory, the engine's plan), or stopped in a
        // window (the rule's own refusal: a series cap, a state limit): nothing is kept.
        if ('refused' in run) finish({ ...base, status: 'refused', attempts: job.attempts + 1, plan: run.plan, message: `${run.refused}; nothing was fetched and the rule started cold`, finishedAt: this.now() })
        else finish({ ...base, status: 'refused', attempts: job.attempts + 1, message: `${run.failed}; nothing was kept and the rule started cold`, finishedAt: this.now() })
        continue
      }
      const done: WarmupStatus = { ...base, status: 'done', attempts: job.attempts + 1, plan: run.plan, points: run.points, finishedAt: this.now() }
      if (rule.kind === 'anomaly') {
        const rt = run.value as AnomalyRt
        finish(done, () => this.writeAnomalyState(g.spec.name, rule.key, rt.json))
        if (current()) g.anomaly.set(rule.key, { ...rt, status: { ...rt.status, status: 'unknown', message: null } })
      } else {
        const rt = run.value as SloRt
        const rows = allRows(rt, rule, I)
        rt.stateBytes = rows.reduce((n, r) => n + byteLength(r.body), 0)
        finish(done, () => this.writeSloAll(g.spec.name, rule.key, rows))
        if (current()) g.slo.set(rule.key, { ...rt, status: { ...emptySloStatus(rule.slo.maxSeries), stateSeries: rt.series.size, stateBytes: rt.stateBytes } })
      }
    }
    return waiting
  }

  private toUpdate(g: GroupRt, rule: AlertingRule | AnomalyRule | SloRule, a: Alert, status: 'firing' | 'resolved', at: number): AlertUpdate {
    const heartbeat = g.spec.name === DEADMAN_GROUP
    return {
      fingerprint: a.fingerprint,
      // External labels are attached on the way out and never override an alert's own label.
      labels: { ...this.cfg.externalLabels, ...a.labels },
      annotations: a.annotations,
      status,
      startsAt: a.firedAt ?? a.activeAt,
      endsAt: status === 'resolved' ? at : null,
      value: a.value,
      at,
      generator: rule.monitor ? { group: g.spec.name, rule: rule.name, monitor: rule.monitor.id } : { group: g.spec.name, rule: rule.name },
      expiresAt: heartbeat && status === 'firing' ? at + 2 * Math.max(this.cfg.heartbeatMs, g.spec.intervalMs) + g.spec.intervalMs : null,
    }
  }

  /**
   * Inside a transaction: add entries to a monitor's transition log. The log is one row,
   * read and rewritten here, holding at most `timelineLimit` entries; what falls off the
   * front is counted in `dropped`, so a reader can tell a complete history from a cut one.
   */
  private appendTimeline(monitor: string, entries: TimelineEntry[]): void {
    if (entries.length === 0) return
    const row = this.exec<{ body: string }>(`SELECT body FROM timeline WHERE tenant = ? AND monitor = ?`, this.tenant, monitor)[0]
    const log: Timeline = row ? (JSON.parse(row.body) as Timeline) : { entries: [], dropped: 0 }
    for (const e of entries) {
      // Replays and re-imports must not write an entry twice.
      if (!log.entries.some((x) => sameEntry(x, e))) log.entries.push(e)
    }
    const over = log.entries.length - this.cfg.timelineLimit
    if (over > 0) {
      log.entries.splice(0, over)
      log.dropped += over
    }
    this.exec(`INSERT INTO timeline (tenant, monitor, body) VALUES (?, ?, ?) ON CONFLICT (tenant, monitor) DO UPDATE SET body = excluded.body`, this.tenant, monitor, JSON.stringify(log))
  }

  /** Inside a transaction: store alert updates for the notifier. */
  private enqueueHandoff(updates: AlertUpdate[], now: number): void {
    for (let i = 0; i < updates.length; i += HANDOFF_CHUNK) {
      this.exec(`INSERT INTO handoff (tenant, seq, created_at, updates) VALUES (?, ?, ?, ?)`,
        this.tenant, this.handoffNextSeq + i / HANDOFF_CHUNK, now, JSON.stringify(updates.slice(i, i + HANDOFF_CHUNK)))
    }
  }

  /** After the transaction committed: reflect the new hand-off rows in memory. */
  private noteHandoff(updates: AlertUpdate[], now: number): void {
    const rows = Math.ceil(updates.length / HANDOFF_CHUNK)
    if (rows === 0) return
    this.handoffNextSeq += rows
    this.handoffDepth += rows
    this.handoffOldest ??= now
  }

  /**
   * The coarse heartbeat: one row with every group's cursor and counters, and a refresh of
   * the dead-man's switch so the notifier can tell a live ruler from a dead one.
   */
  private heartbeat(now: number): void {
    if (this.groups.size === 0 || now - this.lastHeartbeatMs < this.cfg.heartbeatMs) return
    const cursor: Cursor = { at: now, samplesDropped: this.samplesDropped, groups: {} }
    for (const [name, g] of this.groups) cursor.groups[name] = [g.lastEvalMs, g.skipped, g.unobserved, g.evaluations, g.evaluatorErrors]
    const updates: AlertUpdate[] = []
    const dm = this.groups.get(DEADMAN_GROUP)
    if (dm && dm.lastEvalMs !== null && this.lastHeartbeatMs !== 0) {
      const rule = dm.spec.rules[0] as AlertingRule
      for (const a of dm.alerts.get(rule.key)?.values() ?? []) {
        if (a.state === 'firing') updates.push(this.toUpdate(dm, rule, a, 'firing', dm.lastEvalMs))
      }
    }
    this.ctx.storage.transactionSync(() => {
      this.putMeta('cursor', cursor)
      this.enqueueHandoff(updates, now)
    })
    this.noteHandoff(updates, now)
    this.lastHeartbeatMs = now
    this.registrationDue = true
  }

  /** Deliver committed transitions to the notifier, oldest first; a row is deleted only once accepted. */
  private async drainHandoff(now: number): Promise<void> {
    if (this.handoffDepth === 0) return
    if (this.handoffRetryAt !== null && now < this.handoffRetryAt) return
    const t = this.tenant
    const rows = this.exec<{ seq: number; updates: string }>(
      `SELECT seq, updates FROM handoff WHERE tenant = ? ORDER BY seq LIMIT ?`, t, HANDOFF_ROWS_PER_TICK)
    for (const row of rows) {
      try {
        const r = await this.notifier().ingest(`${this.tenant}/${this.shard}`, JSON.parse(row.updates) as AlertUpdate[])
        if (r.status !== 'ok') throw new Error(`notifier answered ${r.status}`)
      } catch (e) {
        this.lastHandoffError = errorText(e)
        this.handoffFailures++
        this.handoffRetryAt = now + backoffMs(this.handoffFailures, 2000, 60_000, `${t}/${this.shard}/handoff`)
        return
      }
      this.fault('handoff-sent')
      this.exec(`DELETE FROM handoff WHERE tenant = ? AND seq = ?`, t, row.seq)
      this.handoffDepth--
    }
    this.handoffFailures = 0
    this.handoffRetryAt = null
    this.lastHandoffError = null
    this.handoffOldest = this.handoffDepth === 0 ? null
      : (this.exec<{ oldest: number | null }>(`SELECT MIN(created_at) AS oldest FROM handoff WHERE tenant = ?`, t)[0]?.oldest ?? null)
  }

  // ───────────────────────── RPC ─────────────────────────

  async configure(tenant: string, patch: Partial<Omit<RulerConfig, 'limits'>> & { limits?: Partial<RulerLimits> }): Promise<{ status: 'ok'; config: RulerConfig } | { status: 'invalid'; errors: ValidationError[] } | Refused> {
    const bad = this.wrongTenant(tenant)
    if (bad) return bad
    const errors = validateConfigPatch(patch)
    if (errors.length > 0) return { status: 'invalid' as const, errors }
    const now = this.now()
    const before = this.cfg
    const next = mergeConfig(this.cfg, patch as Partial<RulerConfig>)
    const reclassify = next.hotWindowMs !== before.hotWindowMs || next.recentWindowMs !== before.recentWindowMs || next.lookbackMs !== before.lookbackMs
    this.ctx.storage.transactionSync(() => {
      this.cfg = next
      this.activate(now)
      this.putMeta('config', next)
      if (reclassify) {
        for (const g of this.groups.values()) {
          if (g.spec.name === DEADMAN_GROUP) continue
          for (const r of g.spec.rules) r.cost = classify(r.expr, next)
          for (const r of (g.spec.anomalyRules ?? []) as AnomalyRule[]) {
            const exprCost = classify(r.expr, next)
            r.anomaly.history = historyOf(r.anomaly.detector, r.anomaly.params, g.spec.intervalMs, next)
            r.cost = { class: maxClass(exprCost.class, r.anomaly.history.tick), windowMs: Math.max(exprCost.windowMs, r.anomaly.history.tickLookbackMs), reason: `${exprCost.reason}; the detector: ${r.anomaly.history.reason}` }
          }
          for (const r of (g.spec.sloRules ?? []) as SloRule[]) {
            const tick = classify(r.expr, next)
            r.slo.history = sloHistory(r.slo, g.spec.intervalMs, tick.class, next)
            r.cost = { class: tick.class, windowMs: tick.windowMs, reason: `${tick.reason}; ${r.slo.history.reason}` }
          }
          this.exec(`UPDATE rule_group SET spec = ? WHERE tenant = ? AND name = ?`, JSON.stringify(g.spec), this.tenant, g.spec.name)
        }
      }
    })
    this.syncDeadman()
    await this.afterMutation(now)
    return { status: 'ok' as const, config: this.cfg }
  }

  async checkGroups(tenant: string, file: unknown): Promise<SaveGroupsResult> {
    const bad = this.wrongTenant(tenant)
    if (bad) return bad
    const promql = await this.checkPromql(file)
    return this.validate(file, this.now(), promql).result
  }

  /**
   * Ask the validator about every expression in the document. This is the only await of a
   * save and it comes first, so that validation against the object's state and the
   * transaction that follows see the same state.
   */
  private async checkPromql(file: unknown): Promise<ValidationError[]> {
    const exprs: { path: string; text: string }[] = []
    const groups = (file as { groups?: unknown } | null)?.groups
    if (Array.isArray(groups)) {
      groups.forEach((g: unknown, gi: number) => {
        const rules = (g as { rules?: unknown } | null)?.rules
        if (!Array.isArray(rules)) return
        rules.forEach((r: unknown, ri: number) => {
          for (const field of ['expr', 'no_data_expr']) {
            const text = (r as Record<string, unknown> | null)?.[field]
            if (typeof text === 'string' && text.trim() !== '') exprs.push({ path: `groups[${gi}].rules[${ri}].${field}`, text })
          }
          // An SLO rule's SLI, with $window as one minute (contract version 4).
          for (const e of sliExpressions((r as Record<string, unknown> | null)?.slo)) exprs.push({ path: `groups[${gi}].rules[${ri}].${e.field}`, text: e.text })
        })
      })
    }
    if (exprs.length === 0) return []
    const validator = this.validator()
    const errors: ValidationError[] = []
    const checked = await mapLimit(exprs, 4, async (e) => {
      try {
        return await validator.check(e.text)
      } catch (err) {
        // A validator that cannot be reached must not block saving: the first evaluation will report the rule.
        return { ok: true, errors: [], selectors: [], unavailable: errorText(err) }
      }
    })
    checked.forEach((r, i) => {
      if (r.ok) return
      const at = exprs[i] as { path: string; text: string }
      for (const e of r.errors.length > 0 ? r.errors : [{ message: 'the expression is not valid PromQL' }]) {
        errors.push({ path: at.path, message: e.offset === undefined ? e.message : `${e.message} (at character ${e.offset})`, fix: e.fix ?? 'Correct the expression; try it in Explore first.' })
      }
    })
    return errors
  }

  private validate(file: unknown, now: number, promqlErrors: ValidationError[] = []): { result: SaveGroupsResult; groups: RuleGroup[] } {
    const parsed = parseRuleFile(file, this.cfg)
    const errors = [...parsed.errors, ...promqlErrors]
    const names = new Set([...this.groups.keys()].filter((n) => n !== DEADMAN_GROUP))
    for (const g of parsed.groups) names.add(g.name)
    if (names.size > this.cfg.limits.maxGroups) {
      errors.push({ path: 'groups', message: `this ruler would hold ${names.size} groups; the limit is ${this.cfg.limits.maxGroups}`, fix: 'Delete unused groups, merge groups, or place the new groups in another rule shard.' })
    }
    parsed.groups.forEach((g, i) => {
      const bytes = byteLength(JSON.stringify(g))
      if (bytes > this.cfg.limits.maxGroupBytes) {
        errors.push({ path: `groups[${i}]`, message: `group "${g.name}" is ${bytes} bytes when stored; the limit is ${this.cfg.limits.maxGroupBytes}`, fix: 'Split the group.' })
      }
    })
    // Detector state is kept in memory between ticks: the anomaly rules of one object may reserve
    // at most this much (each rule its estimate per series × max_series), whichever groups they are in.
    const budget = anomalyLimits(this.cfg).maxAnomalyStateBytesPerObject
    const replaced = new Set(parsed.groups.map((g) => g.name))
    let reserved = 0
    // SLO rules' rings count against the same budget (they are held in memory between ticks too).
    const reserve = (r: AnomalyRule | SloRule) => (r.kind === 'anomaly' ? r.anomaly.stateBytesPerSeries * r.anomaly.maxSeries : r.slo.stateBytesPerSeries * r.slo.maxSeries)
    for (const g of this.groups.values()) if (!replaced.has(g.spec.name)) for (const r of stateRules(g.spec)) reserved += reserve(r)
    for (const g of parsed.groups) {
      for (const r of stateRules(g)) {
        reserved += reserve(r)
        if (reserved > budget) {
          const at = r.kind === 'anomaly' ? `${parsed.anomalyPaths?.get(r) ?? 'groups'}.anomaly.max_series` : `${parsed.sloPaths?.get(r) ?? 'groups'}.slo.max_series`
          const per = r.kind === 'anomaly' ? r.anomaly.stateBytesPerSeries : r.slo.stateBytesPerSeries
          errors.push({ path: at, message: `this ruler shard's anomaly and SLO rules would reserve ${reserved} bytes of state (max_series × about ${per} bytes per series for this rule); the limit per shard is ${budget}`, fix: 'Lower max_series (to the series the expression really returns), aggregate the expression, or put the rule in a group on another shard.' })
          break
        }
      }
      if (reserved > budget) break
    }
    if (errors.length > 0) return { result: { status: 'invalid', errors }, groups: [] }
    return {
      groups: parsed.groups,
      result: {
        status: 'ok',
        warnings: parsed.warnings,
        groups: parsed.groups.map((spec) => {
          const g = this.newGroup(spec, now)
          return {
            name: spec.name,
            intervalMs: spec.intervalMs,
            offsetMs: g.offsetMs,
            nextEvaluationMs: this.ceilTick(g, now),
            rules: allRules(spec).map((r): SavedRule => (r.kind === 'anomaly' ? { name: r.name, kind: r.kind, key: r.key, cost: r.cost, history: r.anomaly.history } : r.kind === 'slo' ? { name: r.name, kind: r.kind, key: r.key, cost: r.cost, slo: r.slo.history } : { name: r.name, kind: r.kind, key: r.key, cost: r.cost })),
          }
        }),
      },
    }
  }

  async saveGroups(tenant: string, file: unknown): Promise<SaveGroupsResult> {
    const bad = this.wrongTenant(tenant)
    if (bad) return bad
    const promqlErrors = await this.checkPromql(file)
    const now = this.now()
    const result = this.commitGroups(file, now, promqlErrors, false)
    if (result.status === 'ok') await this.afterMutation(now)
    return result
  }

  /** Validate and, unless `dryRun`, store. No await in here: what was validated is what is committed. */
  private commitGroups(file: unknown, now: number, promqlErrors: ValidationError[], dryRun: boolean): SaveGroupsResult {
    const { result, groups } = this.validate(file, now, promqlErrors)
    if (result.status !== 'ok' || dryRun) return result
    const t = this.tenant
    const built: GroupRt[] = []
    const updates: AlertUpdate[] = []
    this.ctx.storage.transactionSync(() => {
      this.activate(now)
      for (const spec of groups) {
        const old = this.groups.get(spec.name)
        // Keeping the schedule needs the same interval; otherwise the group starts afresh.
        const keepSchedule = old !== undefined && old.spec.intervalMs === spec.intervalMs
        const g = this.newGroup(spec, keepSchedule ? old.notBefore : now)
        // History: who created or last edited each monitor (once per `updatedAt`), ahead of
        // the transitions the edit itself causes.
        for (const r of allRules(spec)) {
          if (r.kind === 'record' || !r.monitor) continue
          const m = r.monitor
          this.appendTimeline(m.id, [{ at: m.updatedAt, source: 'ruler', kind: m.updatedAt === m.createdAt ? 'created' : 'edited', by: m.updatedBy }])
        }
        if (old) {
          if (keepSchedule) {
            g.lastEvalMs = old.lastEvalMs
            g.cursorApprox = old.cursorApprox
          }
          g.skipped = old.skipped
          g.unobserved = old.unobserved
          g.evaluations = old.evaluations
          g.evaluatorErrors = old.evaluatorErrors
          const kept = new Set(allRules(spec).map((r) => r.key))
          for (const [key, alerts] of old.alerts) {
            if (kept.has(key)) {
              // Same name, expression and labels: the rule's alerts and health carry over.
              g.alerts.set(key, alerts)
              const rt = old.rules.get(key)
              if (rt) g.rules.set(key, rt)
            } else {
              this.dropRuleAlerts(old, key, alerts, now, updates)
            }
          }
          // Same key (detector and parameters too) and the same interval (the detector's step): the
          // detector state carries over; otherwise it describes another rule and is deleted.
          const sameStep = old.spec.intervalMs === spec.intervalMs
          for (const [key, rt] of old.anomaly) {
            if (kept.has(key) && sameStep) g.anomaly.set(key, rt)
            else this.exec(`DELETE FROM anomaly_state WHERE tenant = ? AND grp = ? AND rule_key = ?`, t, spec.name, key)
          }
          // SLO rings the same way (an interval is a bucket width), and the warm-up status with them.
          for (const [key, rt] of old.slo) {
            if (kept.has(key) && sameStep) g.slo.set(key, rt)
            else this.exec(`DELETE FROM slo_state WHERE tenant = ? AND grp = ? AND rule_key = ?`, t, spec.name, key)
          }
          for (const [key, w] of old.warmup) {
            if (kept.has(key) && sameStep) g.warmup.set(key, w)
            else this.exec(`DELETE FROM warmup WHERE tenant = ? AND grp = ? AND rule_key = ?`, t, spec.name, key)
          }
        } else {
          // A new group: no state may be inherited from a group of the same name that is gone.
          this.exec(`DELETE FROM anomaly_state WHERE tenant = ? AND grp = ?`, t, spec.name)
          this.exec(`DELETE FROM slo_state WHERE tenant = ? AND grp = ?`, t, spec.name)
          this.exec(`DELETE FROM warmup WHERE tenant = ? AND grp = ?`, t, spec.name)
        }
        // A new anomaly or SLO rule (no state carried over) is warmed from history before its first
        // evaluation: a pending job, one row, run by the next tick (contract version 4).
        for (const r of stateRules(spec)) {
          if (g.warmup.has(r.key) || this.hasState(g, r)) continue
          const w = warmupStatus([], historyBudgets(this.cfg.limits).warmup)
          this.putWarmup(spec.name, r.key, w)
          g.warmup.set(r.key, w)
        }
        this.exec(`INSERT INTO rule_group (tenant, name, spec, not_before) VALUES (?, ?, ?, ?)
          ON CONFLICT (tenant, name) DO UPDATE SET spec = excluded.spec, not_before = excluded.not_before`, t, spec.name, JSON.stringify(spec), g.notBefore)
        built.push(g)
      }
      this.enqueueHandoff(updates, now)
    })
    this.noteHandoff(updates, now)
    for (const g of built) this.groups.set(g.spec.name, g)
    this.syncDeadman()
    return result
  }

  /**
   * Add one rule to a group, or replace the rule that carries the same monitor id, as one
   * step inside this object: two callers adding monitors to the same group cannot lose
   * each other's rule. The group is created with `interval` if it does not exist.
   * `ruleIndex` is the rule's position, so a caller can map `groups[0].rules[<n>]` paths.
   */
  async saveRule(tenant: string, group: { name: string; interval?: string }, rule: unknown, dryRun = false): Promise<SaveGroupsResult & { ruleIndex?: number }> {
    const bad = this.wrongTenant(tenant)
    if (bad) return bad
    const promql = await this.checkPromql({ groups: [{ rules: [rule] }] })
    const now = this.now()
    const existing = this.groups.get(group.name)
    const id = (rule as { monitor?: { id?: unknown } } | null)?.monitor?.id
    let doc: Record<string, unknown>
    let ruleIndex: number
    if (existing && group.name !== DEADMAN_GROUP) {
      doc = ruleFileDocument([existing.spec], { extensions: true }).file.groups[0] as Record<string, unknown>
      const rules = doc.rules as unknown[]
      const all = allRules(existing.spec)
      const at = typeof id === 'string' ? all.findIndex((r) => r.kind !== 'record' && r.monitor?.id === id) : -1
      // The document lists the ordinary rules, then the anomaly rules, then the SLO rules, as they
      // are stored. The rule goes where it will be stored, so that `ruleIndex` names it in the errors
      // and in the result.
      const kindOf = (r: unknown): 'alert' | 'anomaly' | 'slo' => {
        const o = (typeof r === 'object' && r !== null ? r : {}) as { anomaly?: unknown; slo?: unknown }
        return o.slo !== undefined ? 'slo' : o.anomaly !== undefined ? 'anomaly' : 'alert'
      }
      const kind = kindOf(rule)
      const storedKind = (k: AnyRule['kind']) => (k === 'record' ? 'alert' : k)
      if (at >= 0 && storedKind(all[at]!.kind) === kind) {
        ruleIndex = at
        rules[at] = rule
      } else {
        if (at >= 0) rules.splice(at, 1)
        const removed = (k: 'alert' | 'anomaly' | 'slo') => (at >= 0 && storedKind(all[at]!.kind) === k ? 1 : 0)
        const ordinary = existing.spec.rules.length - removed('alert')
        const anomalies = (existing.spec.anomalyRules?.length ?? 0) - removed('anomaly')
        ruleIndex = kind === 'slo' ? rules.length : kind === 'anomaly' ? ordinary + anomalies : ordinary
        rules.splice(ruleIndex, 0, rule)
      }
      if (group.interval !== undefined && parseDuration(group.interval) !== existing.spec.intervalMs) {
        return { status: 'invalid', errors: [{ path: 'interval', message: `group "${group.name}" is evaluated every ${formatDuration(existing.spec.intervalMs)}`, fix: 'Use that interval, or put the monitor in another group.' }] }
      }
    } else {
      doc = { name: group.name, rules: [rule] }
      if (group.interval !== undefined) doc.interval = group.interval
      ruleIndex = 0
    }
    const errors = promql.map((e) => ({ ...e, path: e.path.replace('groups[0].rules[0]', `groups[0].rules[${ruleIndex}]`) }))
    const result = this.commitGroups({ groups: [doc] }, now, errors, dryRun)
    if (result.status === 'ok' && !dryRun) await this.afterMutation(now)
    return { ...result, ruleIndex }
  }

  /** Remove the rule carrying `monitorId` from `groupName`; a group left without rules is deleted. */
  async removeRule(tenant: string, groupName: string, monitorId: string, dryRun = false): Promise<{ status: 'ok'; removed: boolean } | { status: 'invalid'; errors: ValidationError[] } | Refused> {
    const bad = this.wrongTenant(tenant)
    if (bad) return bad
    const g = this.groups.get(groupName)
    const at = g && groupName !== DEADMAN_GROUP ? allRules(g.spec).findIndex((r) => (r.kind !== 'record' && r.monitor?.id === monitorId) || bareRuleId(groupName, r.key) === monitorId) : -1
    if (!g || at < 0) return { status: 'ok', removed: false }
    if (dryRun) return { status: 'ok', removed: true }
    if (allRules(g.spec).length === 1) {
      await this.deleteGroup(tenant, groupName)
      return { status: 'ok', removed: true }
    }
    const doc = ruleFileDocument([g.spec], { extensions: true }).file.groups[0] as Record<string, unknown>
    ;(doc.rules as unknown[]).splice(at, 1)
    const now = this.now()
    const result = this.commitGroups({ groups: [doc] }, now, [], false)
    if (result.status === 'invalid') return result
    await this.afterMutation(now)
    return { status: 'ok', removed: true }
  }

  /** Inside a transaction: a rule went away. Delete its alerts and tell the notifier the firing ones are over. */
  private dropRuleAlerts(g: GroupRt, key: string, alerts: Map<string, Alert>, now: number, updates: AlertUpdate[]): void {
    const rule = allRules(g.spec).find((r) => r.key === key)
    if (alerts.size > 0) this.exec(`DELETE FROM alert WHERE tenant = ? AND grp = ? AND rule_key = ?`, this.tenant, g.spec.name, key)
    if (!rule || rule.kind === 'record') return
    for (const a of alerts.values()) if (a.state === 'firing') updates.push(this.toUpdate(g, rule, a, 'resolved', now))
    if (rule.monitor) this.appendTimeline(rule.monitor.id, transitions(alerts, EMPTY, new Set(alerts.keys()), now))
  }

  async deleteGroup(tenant: string, name: string) {
    const bad = this.wrongTenant(tenant)
    if (bad) return bad
    const g = this.groups.get(name)
    if (!g || name === DEADMAN_GROUP) return { status: 'ok' as const, existed: false }
    const now = this.now()
    const updates: AlertUpdate[] = []
    this.ctx.storage.transactionSync(() => {
      this.exec(`DELETE FROM rule_group WHERE tenant = ? AND name = ?`, this.tenant, name)
      this.exec(`DELETE FROM anomaly_state WHERE tenant = ? AND grp = ?`, this.tenant, name)
      this.exec(`DELETE FROM slo_state WHERE tenant = ? AND grp = ?`, this.tenant, name)
      this.exec(`DELETE FROM warmup WHERE tenant = ? AND grp = ?`, this.tenant, name)
      for (const [key, alerts] of g.alerts) this.dropRuleAlerts(g, key, alerts, now, updates)
      this.enqueueHandoff(updates, now)
    })
    this.noteHandoff(updates, now)
    this.groups.delete(name)
    await this.afterMutation(now)
    return { status: 'ok' as const, existed: true }
  }

  /** After an RPC changed groups: make sure the alarm is no later than the earliest new deadline. */
  private async afterMutation(now: number): Promise<void> {
    let at = Infinity
    for (const g of this.groups.values()) if (g.lastEvalMs === null) at = Math.min(at, this.ceilTick(g, g.notBefore))
    if (this.handoffDepth > 0) at = Math.min(at, this.handoffRetryAt ?? now)
    if (at !== Infinity) await this.armAtMost(at)
    else if (this.groups.size === 0) await this.ctx.storage.deleteAlarm()
    await this.syncRegistration()
  }

  /**
   * Keep the registry in step with whether this object has work. Best effort: a failed
   * call leaves the flag as it was and is tried again after the next change or heartbeat.
   */
  private async syncRegistration(): Promise<void> {
    const want = this.groups.size > 0 || this.handoffDepth > 0
    if (want === this.registered) return
    try {
      const index = this.index()
      if (!index) return
      await (want ? index.register(this.shard) : index.unregister(this.shard))
    } catch {
      return
    }
    this.registered = want
    this.putMeta('registered', want)
  }

  // ───────────────────────── views for the HTTP API ─────────────────────────

  private anomalyStatus(g: GroupRt, rule: AnomalyRule) {
    const rt = g.anomaly.get(rule.key)
    const status = rt ? { ...rt.status, maxSeries: rule.anomaly.maxSeries } : emptyStatus(rule.anomaly.maxSeries)
    const w = g.warmup.get(rule.key)
    if (w?.status === 'pending' && status.status === 'unknown') return { ...status, status: 'warming' as const, message: w.message ?? 'warming from history before the first evaluation', warmup: w }
    return w ? { ...status, warmup: w } : status
  }

  private sloStatus(g: GroupRt, rule: SloRule) {
    const rt = g.slo.get(rule.key)
    const { warmup: _w, ...status } = rt ? { ...rt.status, maxSeries: rule.slo.maxSeries, stateSeries: rt.series.size, stateBytes: rt.stateBytes } : emptySloStatus(rule.slo.maxSeries)
    const w = g.warmup.get(rule.key)
    if (w?.status === 'pending' && status.status === 'unknown') {
      // Not evaluated yet because it is being warmed: say so rather than "unknown".
      return { ...status, status: 'warming' as const, message: w.message ?? 'warming from history before the first evaluation', warmup: w }
    }
    return w ? { ...status, warmup: w } : status
  }

  async snapshot(tenant: string) {
    const bad = this.wrongTenant(tenant)
    if (bad) return bad
    const groups: GroupSnapshot[] = [...this.groups.values()].map((g) => ({
      name: g.spec.name,
      intervalMs: g.spec.intervalMs,
      limit: g.spec.limit,
      lastEvaluationMs: g.lastEvalMs,
      lastDurationMs: g.lastDurationMs,
      rules: allRules(g.spec).map((rule) => {
        const rt = g.rules.get(rule.key)
        const snap: RuleSnapshot = {
          rule,
          health: rt?.health ?? 'unknown',
          lastError: rt?.lastError ?? null,
          lastEvaluationMs: rt?.lastEvaluationMs ?? null,
          lastDurationMs: rt?.lastDurationMs ?? null,
          noData: rt?.noData ?? false,
          alerts: [...(g.alerts.get(rule.key)?.values() ?? [])],
        }
        if (rule.kind === 'anomaly') snap.anomaly = this.anomalyStatus(g, rule)
        if (rule.kind === 'slo') snap.slo = this.sloStatus(g, rule)
        return snap
      }),
    }))
    return { status: 'ok' as const, shard: this.shard, groups }
  }

  async timeline(tenant: string, monitorId: string) {
    const bad = this.wrongTenant(tenant)
    if (bad) return bad
    const row = this.exec<{ body: string }>(`SELECT body FROM timeline WHERE tenant = ? AND monitor = ?`, this.tenant, monitorId)[0]
    const log: Timeline = row ? (JSON.parse(row.body) as Timeline) : { entries: [], dropped: 0 }
    return { status: 'ok' as const, entries: log.entries, dropped: log.dropped }
  }

  /** Forget the history of monitors that were deleted. */
  async dropTimelines(tenant: string, monitorIds: string[]) {
    const bad = this.wrongTenant(tenant)
    if (bad) return bad
    for (const id of monitorIds) this.exec(`DELETE FROM timeline WHERE tenant = ? AND monitor = ?`, this.tenant, id)
    return { status: 'ok' as const }
  }

  /**
   * "If this rule had existed": evaluate `rule` over [fromMs, toMs] with the engine's range
   * query and run the result through the live evaluation in time order (`backtest.ts`,
   * `history.ts`). An alerting rule's points go to the alert state machine; an anomaly or SLO
   * rule's go through its detector or burn-rate windows first, warmed from the history before
   * `fromMs` as a new rule's warm-up would leave them, at the rule's interval (its step). Every read
   * is planned first and refused, whole, over the backtest budget.
   */
  async backtest(tenant: string, rule: unknown, fromMs: number, toMs: number, stepMs: number, intervalMs?: number): Promise<BacktestResponse> {
    const bad = this.wrongTenant(tenant)
    if (bad) return bad
    const errors: ValidationError[] = []
    const whole = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v)
    if (!whole(fromMs) || !whole(toMs) || toMs < fromMs) errors.push({ path: 'toMs', message: 'fromMs and toMs must be Unix milliseconds with fromMs <= toMs', fix: 'Give the range to test, e.g. the last 7 days.' })
    if (!whole(stepMs) || stepMs < 1000) errors.push({ path: 'stepMs', message: 'stepMs must be at least 1000', fix: 'Use a step of one second or more; the rule interval is a good choice.' })
    else if (errors.length === 0 && Math.floor((toMs - fromMs) / stepMs) + 1 > MAX_BACKTEST_STEPS) {
      const min = Math.ceil((toMs - fromMs) / (MAX_BACKTEST_STEPS - 1) / 1000) * 1000
      errors.push({ path: 'stepMs', message: `the range needs more than ${MAX_BACKTEST_STEPS} steps`, fix: `Use a step of at least ${min} ms, or a shorter range.` })
    }
    const o = (typeof rule === 'object' && rule !== null ? rule : {}) as { anomaly?: unknown; slo?: unknown }
    const stateful = o.anomaly !== undefined || o.slo !== undefined
    // A detector's step is the interval: an anomaly or SLO rule is backtested at its own interval.
    const live = intervalMs ?? (stateful && whole(stepMs) ? stepMs : this.cfg.defaultIntervalMs)
    if (stateful && errors.length === 0 && live !== stepMs) {
      errors.push({ path: 'stepMs', message: `an ${o.slo !== undefined ? 'SLO' : 'anomaly'} rule is backtested at its interval (${formatDuration(live)}): its detector or windows count steps`, fix: `Use a step of ${formatDuration(live)}, or leave the interval out to test the rule at this step.` })
    }
    const parsed = parseRuleFile({ groups: [{ name: 'backtest', interval: `${live}ms`, rules: [rule] }] }, this.cfg)
    for (const e of parsed.errors) errors.push({ ...e, path: e.path.replace(/^groups\[0\]\.rules\[0\]\.?/, 'rule.').replace(/\.$/, '') })
    const parsedRule = parsed.groups[0] ? (allRules(parsed.groups[0])[0] as AnyRule | undefined) : undefined
    if (errors.length === 0 && (!parsedRule || parsedRule.kind === 'record')) errors.push({ path: 'rule', message: 'a recording rule cannot be backtested', fix: 'Give "alert" with "expr", an "anomaly" block or an "slo" block.' })
    if (errors.length > 0 || !parsedRule || parsedRule.kind === 'record') return { status: 'invalid', errors }

    const budgets = historyBudgets(this.cfg.limits)
    const budget = budgets.backtest
    const opts = { resolvedRetentionMs: this.cfg.resolvedRetentionMs, limit: this.cfg.limits.maxAlertsPerRule, maxAnnotationBytes: this.cfg.limits.maxAnnotationBytes, externalLabels: this.cfg.externalLabels }
    const io: HistoryIo = { planner: this.historyPlanner(), range: this.rangeEvaluator(), budget, memoryBytes: budgets.backtestMemory }
    const input = { compiled: compileAlertRule(asAlerting(parsedRule as AnomalyRule)), fromMs, toMs, stepMs, opts, presence: parsedRule.noData?.expr ?? null, alertLimit: this.cfg.limits.maxAlertsPerRule }
    const warmReads: { fromMs: number; toMs: number; stepMs: number }[] = []
    let run: Awaited<ReturnType<typeof backtestAlert>>
    try {
      if (parsedRule.kind === 'alert') run = await backtestAlert(parsedRule, input, io)
      else if (parsedRule.kind === 'anomaly') {
        const warmFromMs = fromMs - anomalyWarmPoints(parsedRule, stepMs) * stepMs
        if (warmFromMs < fromMs) warmReads.push({ fromMs: warmFromMs, toMs: fromMs - stepMs, stepMs })
        run = await backtestAnomaly(parsedRule, warmFromMs, anomalyLimits(this.cfg), input, io)
      } else {
        // Warmed exactly as a rule created at `fromMs` would be, then on to `toMs` in the same read.
        const w = sloWarmReads(parsedRule, stepMs, fromMs - stepMs)
        if (w.coarse) warmReads.push({ fromMs: w.coarse.fromMs, toMs: w.coarse.toMs, stepMs: w.coarse.stepMs })
        warmReads.unshift({ fromMs: w.fine.fromMs, toMs: fromMs - stepMs, stepMs })
        run = await backtestSlo(parsedRule, { ...w.fine, toMs }, w.coarse, input, io)
      }
    } catch (e) {
      return { status: 'failed', error: errorText(e) }
    }
    if (!run.ok) {
      if ('failed' in run) return { status: 'failed', error: run.failed }
      return { status: 'over_budget', message: `${run.refused}. Nothing was fetched: shorten the range, lengthen the step (alerting rules only), or narrow the expression.`, plan: run.plan, budget, memory: run.sizing ? { peakBytes: run.sizing.peakBytes, budgetBytes: run.sizing.budgetBytes } : null }
    }
    const cost = { ...run.plan, budget, memory: { peakBytes: run.sizing.peakBytes, budgetBytes: run.sizing.budgetBytes, windowSteps: run.sizing.windowSteps, queries: run.sizing.queries } }
    if (parsedRule.kind === 'alert') {
      const result = { ...run.value.result, resolution: { stepMs, liveIntervalMs: live, edgeErrorMs: Math.max(stepMs, live), note: resolutionNote(parsedRule, stepMs, live) } }
      return { status: 'ok', ...result, kind: 'alert', warmup: null, cost }
    }
    return { status: 'ok', ...run.value.result, kind: parsedRule.kind, warmup: { reads: warmReads, points: run.value.warmPoints }, cost }
  }

  // ───────────────────────── moving a group between shards ─────────────────────────

  async exportGroup(tenant: string, name: string) {
    const bad = this.wrongTenant(tenant)
    if (bad) return bad
    const g = this.groups.get(name)
    if (!g || name === DEADMAN_GROUP) return { status: 'not_found' as const }
    const bundle: GroupBundle = { spec: g.spec as GroupBundle['spec'], alerts: {}, timelines: {} }
    for (const [key, alerts] of g.alerts) if (alerts.size > 0) bundle.alerts[key] = [...alerts.values()]
    for (const r of allRules(g.spec)) {
      if (r.kind === 'record' || !r.monitor) continue
      const row = this.exec<{ body: string }>(`SELECT body FROM timeline WHERE tenant = ? AND monitor = ?`, this.tenant, r.monitor.id)[0]
      if (row) bundle.timelines[r.monitor.id] = JSON.parse(row.body) as Timeline
    }
    if (g.anomaly.size > 0) {
      bundle.anomalyState = {}
      for (const [key, rt] of g.anomaly) {
        if (rt.rawRows !== null) bundle.anomalyState[key] = rt.rawRows
        else if (rt.json.size > 0) bundle.anomalyState[key] = stateRows(rt.json)
      }
    }
    if (g.slo.size > 0) {
      bundle.sloState = {}
      for (const [key, rt] of g.slo) {
        const rule = g.spec.sloRules?.find((r) => r.key === key) as SloRule | undefined
        if (rt.rawRows !== null) bundle.sloState[key] = rt.rawRows
        else if (rule && rt.lastSlot !== null) bundle.sloState[key] = allRows(rt, rule, g.spec.intervalMs)
      }
    }
    if (g.warmup.size > 0) bundle.warmup = Object.fromEntries(g.warmup)
    return { status: 'ok' as const, bundle }
  }

  /**
   * Take over a group from another shard: its rules, every alert (so `for` timers,
   * `firedAt` and retention continue) and its monitors' history. Idempotent. The group
   * starts on this shard's own tick grid at the next aligned time.
   */
  async importGroup(tenant: string, bundle: GroupBundle) {
    const bad = this.wrongTenant(tenant)
    if (bad) return bad
    const spec = bundle?.spec
    if (!spec || typeof spec.name !== 'string' || !Array.isArray(spec.rules) || spec.name === DEADMAN_GROUP) {
      return { status: 'invalid' as const, errors: [{ path: 'spec', message: 'not a group bundle', fix: 'Pass what exportGroup returned.' }] }
    }
    const names = new Set([...this.groups.keys()].filter((n) => n !== DEADMAN_GROUP))
    names.add(spec.name)
    if (names.size > this.cfg.limits.maxGroups) {
      return { status: 'invalid' as const, errors: [{ path: 'spec', message: `this ruler would hold ${names.size} groups; the limit is ${this.cfg.limits.maxGroups}`, fix: 'Place the group in another rule shard.' }] }
    }
    const now = this.now()
    const t = this.tenant
    const g = this.newGroup(spec as RuleGroup, now)
    const keys = new Set(allRules(spec as RuleGroup).map((r) => r.key))
    this.ctx.storage.transactionSync(() => {
      this.activate(now)
      this.exec(`INSERT INTO rule_group (tenant, name, spec, not_before) VALUES (?, ?, ?, ?)
        ON CONFLICT (tenant, name) DO UPDATE SET spec = excluded.spec, not_before = excluded.not_before`, t, spec.name, JSON.stringify(spec), now)
      this.exec(`DELETE FROM alert WHERE tenant = ? AND grp = ?`, t, spec.name)
      for (const [key, alerts] of Object.entries(bundle.alerts ?? {})) {
        if (!keys.has(key)) continue
        const m = new Map<string, Alert>()
        for (const a of alerts) {
          m.set(a.fingerprint, a)
          this.exec(`INSERT INTO alert (tenant, grp, rule_key, fp, body) VALUES (?, ?, ?, ?, ?)`, t, spec.name, key, a.fingerprint, JSON.stringify(a))
        }
        g.alerts.set(key, m)
      }
      for (const [monitor, log] of Object.entries(bundle.timelines ?? {})) this.appendTimeline(monitor, log.entries)
      this.exec(`DELETE FROM anomaly_state WHERE tenant = ? AND grp = ?`, t, spec.name)
      for (const [key, rows] of Object.entries(bundle.anomalyState ?? {})) {
        const rt = g.anomaly.get(key)
        if (!rt || !keys.has(key)) continue
        const read = readStateRows(rows)
        if ('error' in read) {
          // A format this code cannot read: stored as it came, and the rule is refused until a release that reads it runs.
          rows.forEach((body, chunk) => this.exec(`INSERT INTO anomaly_state (tenant, grp, rule_key, chunk, body) VALUES (?, ?, ?, ?, ?)`, t, spec.name, key, chunk, body))
          rt.unreadable = read.error
          rt.rawRows = rows
          rt.status = { ...rt.status, status: 'state_unreadable', message: read.error }
          continue
        }
        rt.series = read.series
        rt.json = read.json
        this.writeAnomalyState(spec.name, key, read.json)
      }
      this.exec(`DELETE FROM slo_state WHERE tenant = ? AND grp = ?`, t, spec.name)
      for (const [key, rows] of Object.entries(bundle.sloState ?? {})) {
        const rule = (spec as RuleGroup).sloRules?.find((r) => r.key === key) as SloRule | undefined
        if (!rule || !keys.has(key)) continue
        // Stored as they came (a format this code cannot read is refused, and kept, by `adoptSloRows`).
        for (const r of rows) this.exec(`INSERT INTO slo_state (tenant, grp, rule_key, part, block, body) VALUES (?, ?, ?, ?, ?, ?)`, t, spec.name, key, r.part, r.block, r.body)
        this.adoptSloRows(g, rule, rows as SloRow[])
      }
      // Warm-up status travels with the state; a rule that arrives without state is warmed here.
      this.exec(`DELETE FROM warmup WHERE tenant = ? AND grp = ?`, t, spec.name)
      for (const r of stateRules(spec as RuleGroup)) {
        const carried = bundle.warmup?.[r.key]
        const w = carried ?? (this.hasState(g, r) ? null : warmupStatus([], historyBudgets(this.cfg.limits).warmup))
        if (!w) continue
        this.putWarmup(spec.name, r.key, w)
        g.warmup.set(r.key, w)
      }
    })
    this.groups.set(spec.name, g)
    this.syncDeadman()
    await this.afterMutation(now)
    return { status: 'ok' as const }
  }

  /** The group now lives on another shard: forget it here without resolving or notifying anything. */
  async releaseGroup(tenant: string, name: string) {
    const bad = this.wrongTenant(tenant)
    if (bad) return bad
    const g = this.groups.get(name)
    if (!g || name === DEADMAN_GROUP) return { status: 'ok' as const, existed: false }
    this.ctx.storage.transactionSync(() => {
      this.exec(`DELETE FROM rule_group WHERE tenant = ? AND name = ?`, this.tenant, name)
      this.exec(`DELETE FROM alert WHERE tenant = ? AND grp = ?`, this.tenant, name)
      this.exec(`DELETE FROM anomaly_state WHERE tenant = ? AND grp = ?`, this.tenant, name)
      this.exec(`DELETE FROM slo_state WHERE tenant = ? AND grp = ?`, this.tenant, name)
      this.exec(`DELETE FROM warmup WHERE tenant = ? AND grp = ?`, this.tenant, name)
      for (const r of allRules(g.spec)) if (r.kind !== 'record' && r.monitor) this.exec(`DELETE FROM timeline WHERE tenant = ? AND monitor = ?`, this.tenant, r.monitor.id)
    })
    this.groups.delete(name)
    await this.afterMutation(this.now())
    return { status: 'ok' as const, existed: true }
  }

  async listGroups(tenant: string) {
    const bad = this.wrongTenant(tenant)
    if (bad) return bad
    return { status: 'ok' as const, groups: [...this.groups.values()].map((g) => g.spec) }
  }

  async rules(tenant: string) {
    const bad = this.wrongTenant(tenant)
    if (bad) return bad
    const rules: RuleStatus[] = []
    for (const g of this.groups.values()) {
      for (const r of allRules(g.spec)) {
        const rt = g.rules.get(r.key)
        const status: RuleStatus = {
          group: g.spec.name,
          name: r.name,
          kind: r.kind,
          key: r.key,
          cost: r.cost,
          health: rt?.health ?? 'unknown',
          lastError: rt?.lastError ?? null,
          lastEvaluationMs: rt?.lastEvaluationMs ?? null,
          alerts: [...(g.alerts.get(r.key)?.values() ?? [])],
        }
        if (r.kind === 'anomaly') status.anomaly = this.anomalyStatus(g, r)
        if (r.kind === 'slo') status.slo = this.sloStatus(g, r)
        rules.push(status)
      }
    }
    return { status: 'ok' as const, rules }
  }

  async health(tenant: string): Promise<({ status: 'ok' } & RulerHealth) | Refused> {
    const bad = this.wrongTenant(tenant)
    if (bad) return bad
    const now = this.now()
    const groups: GroupHealth[] = [...this.groups.values()].map((g) => ({
      name: g.spec.name,
      intervalMs: g.spec.intervalMs,
      lastEvaluationMs: g.lastEvalMs,
      lastDurationMs: g.lastDurationMs,
      nextEvaluationMs: g.lastEvalMs === null ? this.ceilTick(g, g.notBefore) : g.lastEvalMs + g.spec.intervalMs,
      evaluations: g.evaluations,
      skippedTicks: g.skipped,
      unobservedTicks: g.unobserved,
      evaluatorErrors: g.evaluatorErrors,
      rulesInError: allRules(g.spec).flatMap((r) => {
        const rt = g.rules.get(r.key)
        return rt?.health === 'err' ? [{ rule: r.name, error: rt.lastError ?? '' }] : []
      }),
    }))
    return {
      status: 'ok',
      tenant: this.tenant,
      shard: this.shard,
      nowMs: now,
      groups,
      outboxDepth: this.handoffDepth,
      oldestUndeliveredAgeMs: this.handoffOldest === null ? null : Math.max(0, now - this.handoffOldest),
      lastHandoffError: this.lastHandoffError,
      samplesDropped: this.samplesDropped,
      alarmAtMs: await this.ctx.storage.getAlarm(),
      counters: { ...this.counters },
    }
  }

  async ensureArmed(tenant: string) {
    const bad = this.wrongTenant(tenant)
    if (bad) return bad
    if ((this.groups.size === 0 && this.handoffDepth === 0) || (await this.ctx.storage.getAlarm()) !== null) return { status: 'ok' as const, rearmed: false }
    await this.setAlarm(this.now())
    return { status: 'ok' as const, rearmed: true }
  }
}

/** A stored alert. JSON has no NaN (the value of a no-data alert), so it comes back as null. */
function reviveAlert(body: string): Alert {
  const a = JSON.parse(body) as Alert
  if (a.value === null) a.value = NaN
  return a
}

const active = (a: Alert | undefined): 'pending' | 'firing' | null => (a && a.state !== 'inactive' ? a.state : null)

/** The state changes between two alert maps, as history entries. */
function transitions(before: ReadonlyMap<string, Alert>, after: ReadonlyMap<string, Alert>, dirty: Iterable<string>, at: number): TimelineEntry[] {
  const out: TimelineEntry[] = []
  for (const fp of dirty) {
    const b = before.get(fp)
    const a = after.get(fp)
    const was = active(b)
    const is = active(a)
    if (was === is) continue
    const ref = (a ?? b) as Alert
    out.push({ at, source: 'ruler', kind: is ?? (was === 'firing' ? 'resolved' : 'cleared'), fingerprint: fp, labels: ref.labels, value: ref.value, noData: isNoDataAlert(ref) })
  }
  return out
}

function sameEntry(a: TimelineEntry, b: TimelineEntry): boolean {
  if (a.at !== b.at || a.kind !== b.kind || a.source !== b.source) return false
  return 'fingerprint' in a && 'fingerprint' in b ? a.fingerprint === b.fingerprint : true
}

function mergeConfig(base: RulerConfig, patch: Partial<Omit<RulerConfig, 'limits'>> & { limits?: Partial<RulerLimits> }): RulerConfig {
  return { ...base, ...patch, limits: { ...base.limits, ...(patch.limits ?? {}) }, externalLabels: patch.externalLabels ?? base.externalLabels }
}

function validateConfigPatch(patch: unknown): ValidationError[] {
  const errors: ValidationError[] = []
  if (typeof patch !== 'object' || patch === null) return [{ path: '', message: 'config must be an object', fix: 'Send the fields to change.' }]
  const p = patch as Record<string, unknown>
  const positive = (path: string, v: unknown, min: number) => {
    if (v === undefined) return
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min) errors.push({ path, message: `${path} must be a number of at least ${min}`, fix: `Use a value of at least ${min}.` })
  }
  for (const k of Object.keys(p)) {
    if (!(k in DEFAULT_RULER_CONFIG)) errors.push({ path: k, message: `unknown field "${k}"`, fix: `Known fields: ${Object.keys(DEFAULT_RULER_CONFIG).join(', ')}.` })
  }
  positive('defaultIntervalMs', p.defaultIntervalMs, 1000)
  positive('heartbeatMs', p.heartbeatMs, 0)
  positive('resolvedRetentionMs', p.resolvedRetentionMs, 0)
  positive('maxConcurrentGroups', p.maxConcurrentGroups, 1)
  positive('groupTimeoutMs', p.groupTimeoutMs, 100)
  positive('hotWindowMs', p.hotWindowMs, 0)
  positive('recentWindowMs', p.recentWindowMs, 0)
  positive('lookbackMs', p.lookbackMs, 0)
  positive('deadmanIntervalMs', p.deadmanIntervalMs, 1000)
  positive('timelineLimit', p.timelineLimit, 1)
  if (p.deadman !== undefined && typeof p.deadman !== 'boolean') errors.push({ path: 'deadman', message: 'deadman must be true or false', fix: 'Use a boolean.' })
  if (p.limits !== undefined) {
    if (typeof p.limits !== 'object' || p.limits === null) errors.push({ path: 'limits', message: 'limits must be an object', fix: 'Send the limits to change.' })
    else {
      for (const [k, v] of Object.entries(p.limits as Record<string, unknown>)) {
        if (!(k in DEFAULT_RULER_CONFIG.limits)) errors.push({ path: `limits.${k}`, message: `unknown limit "${k}"`, fix: `Known limits: ${Object.keys(DEFAULT_RULER_CONFIG.limits).join(', ')}.` })
        else positive(`limits.${k}`, v, 1)
      }
    }
  }
  if (p.externalLabels !== undefined) {
    const ok = typeof p.externalLabels === 'object' && p.externalLabels !== null &&
      Object.entries(p.externalLabels as Record<string, unknown>).every(([k, v]) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k) && typeof v === 'string')
    if (!ok) errors.push({ path: 'externalLabels', message: 'externalLabels must map label names to strings', fix: 'Use { "cluster": "eu-1" }.' })
  }
  return errors
}
