import { DurableObject } from 'cloudflare:workers'
import type { PromMatrix, PromScalar, PromVector } from '../../contracts/engine'
import type {
  Alert,
  AlertingRuleV2 as AlertingRule,
  AlertUpdateV2 as AlertUpdate,
  BacktestResponse,
  BatchEvaluator,
  EvalRequest,
  EvalResult,
  Evaluator,
  GroupBundle,
  GroupHealth,
  GroupSnapshot,
  IngestResult,
  RangeEvaluator,
  RuleV2 as Rule,
  RuleGroup,
  RulerConfigV2 as RulerConfig,
  RulerHealth,
  RulerLimits,
  RulerRpcV2 as RulerRpc,
  RuleStatus,
  SampleBatch,
  SaveGroupsResult,
  Sink,
  Timeline,
  TimelineEntry,
  ValidationError,
  Validator,
  WrongTenant,
} from '../contracts-proposal/rules.v2'
import { MAX_BACKTEST_STEPS, runBacktest } from './backtest'
import { classify } from './classify'
import { batchFromSingle, errorText, permissiveValidator } from './evaluator'
import { indexName } from './registry'
import { ruleFileDocument } from './rulefile'
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
    check?(tenant: string, promql: string): ReturnType<Validator['check']>
  }
  SINK?: { write(tenant: string, batches: SampleBatch[]): Promise<void> }
  /** The registry the cron sweeper walks (`registry.ts`). */
  RULER_INDEX?: DurableObjectNamespace
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
  rule: AlertingRule
  result: Extract<AlertEvalResult, { ok: true }>
}

type Cursor = { at: number; samplesDropped: number; groups: Record<string, [number | null, number, number, number, number]> }

const EMPTY: ReadonlyMap<string, Alert> = new Map()

export class Ruler extends DurableObject<RulerEnv> implements RulerRpc {
  protected readonly tenant: string
  protected readonly shard: string
  private readonly objectName: string
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
    const sql = ctx.storage.sql
    // The object's own identity, not tenant data: one row, written when the object is first used.
    sql.exec(`CREATE TABLE IF NOT EXISTS self (one INTEGER PRIMARY KEY CHECK (one = 1), name TEXT NOT NULL)`)
    this.objectName = resolveObjectName(ctx.id.name, sql.exec<{ name: string }>(`SELECT name FROM self`).toArray()[0]?.name)
    const cut = this.objectName.lastIndexOf('/')
    this.tenant = cut > 0 ? this.objectName.slice(0, cut) : ''
    this.shard = cut > 0 ? this.objectName.slice(cut + 1) : ''

    sql.exec(`CREATE TABLE IF NOT EXISTS meta (tenant TEXT NOT NULL, k TEXT NOT NULL, v TEXT NOT NULL, PRIMARY KEY (tenant, k)) WITHOUT ROWID`)
    sql.exec(`CREATE TABLE IF NOT EXISTS rule_group (tenant TEXT NOT NULL, name TEXT NOT NULL, spec TEXT NOT NULL, not_before INTEGER NOT NULL,
      PRIMARY KEY (tenant, name)) WITHOUT ROWID`)
    sql.exec(`CREATE TABLE IF NOT EXISTS alert (tenant TEXT NOT NULL, grp TEXT NOT NULL, rule_key TEXT NOT NULL, fp TEXT NOT NULL, body TEXT NOT NULL,
      PRIMARY KEY (tenant, grp, rule_key, fp)) WITHOUT ROWID`)
    sql.exec(`CREATE TABLE IF NOT EXISTS handoff (tenant TEXT NOT NULL, seq INTEGER NOT NULL, created_at INTEGER NOT NULL, updates TEXT NOT NULL,
      PRIMARY KEY (tenant, seq)) WITHOUT ROWID`)
    // One row per monitor: its bounded transition log as one JSON value (AGENTS.md: whole batches as rows).
    sql.exec(`CREATE TABLE IF NOT EXISTS timeline (tenant TEXT NOT NULL, monitor TEXT NOT NULL, body TEXT NOT NULL,
      PRIMARY KEY (tenant, monitor)) WITHOUT ROWID`)
    this.load()
  }

  // ───────────────────────── injection points ─────────────────────────
  // Production reads bindings and the real clock; `test/harness.ts` overrides these.

  protected now(): number {
    return Date.now()
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
    return batchFromSingle(this.evaluator())
  }

  protected rangeEvaluator(): RangeEvaluator {
    const binding = this.env.EVALUATOR
    if (!binding?.range) throw new Error('no range evaluator binding')
    const range = binding.range.bind(binding)
    return { range: (promql, startMs, endMs, stepMs) => range(this.tenant, promql, startMs, endMs, stepMs) }
  }

  /** Save-time PromQL validation. Permissive until the engine binding offers `check`. */
  protected validator(): Validator {
    const binding = this.env.EVALUATOR
    if (!binding?.check) return permissiveValidator
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
    if (!binding) throw new Error('no SINK binding')
    return { write: (batches) => binding.write(this.tenant, batches) }
  }

  protected notifier(): NotifierPort {
    const ns = this.env.NOTIFIER
    if (!ns) throw new Error('no NOTIFIER binding')
    const stub = ns.get(ns.idFromName(this.tenant)) as unknown as { ingest(tenant: string, source: string, updates: AlertUpdate[]): Promise<IngestResult> }
    return { ingest: (source, updates) => stub.ingest(this.tenant, source, updates) }
  }

  /** Fault-injection point for crash tests. Does nothing in production. */
  protected fault(_point: 'commit' | 'after-commit' | 'handoff-sent'): void {}

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

  private newGroup(spec: RuleGroup, notBefore: number): GroupRt {
    return {
      spec,
      // Prometheus derives a group's offset from a hash of its file and name; here the
      // tenant shard stands in for the file. Stable across saves and restarts.
      offsetMs: parseInt(hash64(`${this.tenant}/${this.shard}/${spec.name}`).slice(0, 12), 16) % spec.intervalMs,
      gen: ++this.genCounter,
      notBefore,
      compiled: spec.rules.map((r) => (r.kind === 'alert' ? compileAlertRule(r) : null)),
      alerts: new Map(),
      rules: new Map(spec.rules.map((r) => [r.key, { health: 'unknown', lastError: null, lastEvaluationMs: null, lastDurationMs: null, noData: false }])),
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

  private wrongTenant(tenant: string): WrongTenant | null {
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
    const rules = g.spec.rules as Rule[]

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

    const setHealth = (rule: Rule, error: string | null, durationMs: number | null = g.rules.get(rule.key)?.lastDurationMs ?? null, noData = g.rules.get(rule.key)?.noData ?? false) => {
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
      const reads = (name: string) => rule.expr.includes(name) || (rule.kind === 'alert' && rule.noData?.expr?.includes(name) === true)
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
          const rule = rules[i] as Rule
          requests.push({ id: rule.key, promql: rule.expr, timeMs: queryTime })
          if (rule.kind === 'alert' && rule.noData?.expr) requests.push({ id: `${rule.key}#presence`, promql: rule.noData.expr, timeMs: queryTime })
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
          const rule = rules[i] as Rule
          const res = results.get(rule.key)
          const wantsPresence = rule.kind === 'alert' && Boolean(rule.noData?.expr)
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
          if (rule.kind === 'alert') {
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
    if (staged.some((s) => s.result.dirty.size > 0)) {
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
        this.enqueueHandoff(updates, ts)
        this.fault('commit')
      })
      this.noteHandoff(updates, ts)
    }
    for (const { rule, result } of staged) g.alerts.set(rule.key, result.alerts)
    this.fault('after-commit')
  }

  private toUpdate(g: GroupRt, rule: AlertingRule, a: Alert, status: 'firing' | 'resolved', at: number): AlertUpdate {
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

  async configure(tenant: string, patch: Partial<Omit<RulerConfig, 'limits'>> & { limits?: Partial<RulerLimits> }): Promise<{ status: 'ok'; config: RulerConfig } | { status: 'invalid'; errors: ValidationError[] } | WrongTenant> {
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
            rules: spec.rules.map((r) => ({ name: r.name, kind: r.kind, key: r.key, cost: r.cost })),
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
        for (const r of spec.rules as Rule[]) {
          if (r.kind !== 'alert' || !r.monitor) continue
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
          const kept = new Set(spec.rules.map((r) => r.key))
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
      const at = typeof id === 'string' ? (existing.spec.rules as Rule[]).findIndex((r) => r.kind === 'alert' && r.monitor?.id === id) : -1
      ruleIndex = at >= 0 ? at : rules.length
      rules[ruleIndex] = rule
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
  async removeRule(tenant: string, groupName: string, monitorId: string, dryRun = false): Promise<{ status: 'ok'; removed: boolean } | { status: 'invalid'; errors: ValidationError[] } | WrongTenant> {
    const bad = this.wrongTenant(tenant)
    if (bad) return bad
    const g = this.groups.get(groupName)
    const at = g && groupName !== DEADMAN_GROUP ? (g.spec.rules as Rule[]).findIndex((r) => (r.kind === 'alert' && r.monitor?.id === monitorId) || bareRuleId(groupName, r.key) === monitorId) : -1
    if (!g || at < 0) return { status: 'ok', removed: false }
    if (dryRun) return { status: 'ok', removed: true }
    if (g.spec.rules.length === 1) {
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
    const rule = (g.spec.rules as Rule[]).find((r) => r.key === key)
    if (alerts.size > 0) this.exec(`DELETE FROM alert WHERE tenant = ? AND grp = ? AND rule_key = ?`, this.tenant, g.spec.name, key)
    if (!rule || rule.kind !== 'alert') return
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

  async snapshot(tenant: string) {
    const bad = this.wrongTenant(tenant)
    if (bad) return bad
    const groups: GroupSnapshot[] = [...this.groups.values()].map((g) => ({
      name: g.spec.name,
      intervalMs: g.spec.intervalMs,
      limit: g.spec.limit,
      lastEvaluationMs: g.lastEvalMs,
      lastDurationMs: g.lastDurationMs,
      rules: (g.spec.rules as Rule[]).map((rule) => {
        const rt = g.rules.get(rule.key)
        return {
          rule,
          health: rt?.health ?? 'unknown',
          lastError: rt?.lastError ?? null,
          lastEvaluationMs: rt?.lastEvaluationMs ?? null,
          lastDurationMs: rt?.lastDurationMs ?? null,
          noData: rt?.noData ?? false,
          alerts: [...(g.alerts.get(rule.key)?.values() ?? [])],
        }
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
   * query and run the result through the live state machine (`backtest.ts`).
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
    const live = intervalMs ?? this.cfg.defaultIntervalMs
    const parsed = parseRuleFile({ groups: [{ name: 'backtest', interval: `${live}ms`, rules: [rule] }] }, this.cfg)
    for (const e of parsed.errors) errors.push({ ...e, path: e.path.replace(/^groups\[0\]\.rules\[0\]\.?/, 'rule.').replace(/\.$/, '') })
    const parsedRule = parsed.groups[0]?.rules[0] as Rule | undefined
    if (errors.length === 0 && parsedRule?.kind !== 'alert') errors.push({ path: 'rule', message: 'only an alerting rule can be backtested', fix: 'Give "alert" and "expr".' })
    if (errors.length > 0 || !parsedRule || parsedRule.kind !== 'alert') return { status: 'invalid', errors }
    let matrix: PromMatrix
    let presence: PromMatrix | null = null
    try {
      const range = this.rangeEvaluator()
      matrix = await range.range(parsedRule.expr, fromMs, toMs, stepMs)
      if (parsedRule.noData?.expr) presence = await range.range(parsedRule.noData.expr, fromMs, toMs, stepMs)
      if (matrix.resultType !== 'matrix') throw new Error('the range evaluation did not return a matrix')
    } catch (e) {
      return { status: 'failed', error: errorText(e) }
    }
    const r = runBacktest({
      rule: parsedRule, compiled: compileAlertRule(parsedRule), matrix, presence, fromMs, toMs, stepMs, liveIntervalMs: live,
      opts: { resolvedRetentionMs: this.cfg.resolvedRetentionMs, limit: this.cfg.limits.maxAlertsPerRule, maxAnnotationBytes: this.cfg.limits.maxAnnotationBytes, externalLabels: this.cfg.externalLabels },
    })
    return r.ok ? { status: 'ok', ...r.result } : { status: 'failed', error: r.error }
  }

  // ───────────────────────── moving a group between shards ─────────────────────────

  async exportGroup(tenant: string, name: string) {
    const bad = this.wrongTenant(tenant)
    if (bad) return bad
    const g = this.groups.get(name)
    if (!g || name === DEADMAN_GROUP) return { status: 'not_found' as const }
    const bundle: GroupBundle = { spec: g.spec as GroupBundle['spec'], alerts: {}, timelines: {} }
    for (const [key, alerts] of g.alerts) if (alerts.size > 0) bundle.alerts[key] = [...alerts.values()]
    for (const r of g.spec.rules as Rule[]) {
      if (r.kind !== 'alert' || !r.monitor) continue
      const row = this.exec<{ body: string }>(`SELECT body FROM timeline WHERE tenant = ? AND monitor = ?`, this.tenant, r.monitor.id)[0]
      if (row) bundle.timelines[r.monitor.id] = JSON.parse(row.body) as Timeline
    }
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
    const keys = new Set(spec.rules.map((r) => r.key))
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
      for (const r of g.spec.rules as Rule[]) if (r.kind === 'alert' && r.monitor) this.exec(`DELETE FROM timeline WHERE tenant = ? AND monitor = ?`, this.tenant, r.monitor.id)
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
      for (const r of g.spec.rules) {
        const rt = g.rules.get(r.key)
        rules.push({
          group: g.spec.name,
          name: r.name,
          kind: r.kind,
          key: r.key,
          cost: r.cost,
          health: rt?.health ?? 'unknown',
          lastError: rt?.lastError ?? null,
          lastEvaluationMs: rt?.lastEvaluationMs ?? null,
          alerts: [...(g.alerts.get(r.key)?.values() ?? [])],
        })
      }
    }
    return { status: 'ok' as const, rules }
  }

  async health(tenant: string): Promise<({ status: 'ok' } & RulerHealth) | WrongTenant> {
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
      rulesInError: g.spec.rules.flatMap((r) => {
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
    if (this.groups.size === 0 && this.handoffDepth === 0) return { status: 'ok' as const, rearmed: false }
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
