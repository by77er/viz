import { DurableObject } from 'cloudflare:workers'
import type { PromScalar, PromVector } from '../../contracts/engine'
import type {
  Alert,
  AlertingRule,
  AlertUpdate,
  Evaluator,
  GroupHealth,
  IngestResult,
  Rule,
  RuleGroup,
  RulerConfig,
  RulerHealth,
  RulerLimits,
  RulerRpc,
  RuleStatus,
  SampleBatch,
  SaveGroupsResult,
  Sink,
  ValidationError,
  WrongTenant,
} from '../contracts-proposal/rules'
import { classify } from './classify'
import { compileAlertRule, DEADMAN_ALERT, DEADMAN_GROUP, deadmanGroup, parseRuleFile, type CompiledAlertRule } from './rules'
import { evalAlertingRule, evalRecordingRule, toSeries, type AlertEvalResult } from './statemachine'
import { alignedTick, backoffMs, byteLength, hash64, mapLimit } from './util'

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
  EVALUATOR?: { instant(tenant: string, promql: string, timeMs: number): Promise<PromVector | PromScalar> }
  SINK?: { write(tenant: string, batches: SampleBatch[]): Promise<void> }
}

export interface NotifierPort {
  ingest(source: string, updates: AlertUpdate[]): Promise<IngestResult>
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
}

/** Alert updates per hand-off row. Keeps a row far below the 2 MB value cap. */
const HANDOFF_CHUNK = 200
const HANDOFF_ROWS_PER_TICK = 32
const SINK_ATTEMPTS = 3
const MAX_TICK_RETRIES = 5

interface RuleRt {
  health: 'ok' | 'err' | 'unknown'
  lastError: string | null
  lastEvaluationMs: number | null
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

function errorText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 500)
}

export class Ruler extends DurableObject<RulerEnv> implements RulerRpc {
  protected readonly tenant: string
  protected readonly shard: string
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
  private counters = { sqlRowsWritten: 0, alarmsSet: 0, ticks: 0 }

  constructor(ctx: DurableObjectState, env: RulerEnv) {
    super(ctx, env)
    // `<tenant>/<n>`. The name is the only source of the tenant; an object reached by an
    // id that has no name serves nobody.
    const name = ctx.id.name ?? ''
    const cut = name.lastIndexOf('/')
    this.tenant = cut > 0 ? name.slice(0, cut) : ''
    this.shard = cut > 0 ? name.slice(cut + 1) : ''

    const sql = ctx.storage.sql
    sql.exec(`CREATE TABLE IF NOT EXISTS meta (tenant TEXT NOT NULL, k TEXT NOT NULL, v TEXT NOT NULL, PRIMARY KEY (tenant, k)) WITHOUT ROWID`)
    sql.exec(`CREATE TABLE IF NOT EXISTS rule_group (tenant TEXT NOT NULL, name TEXT NOT NULL, spec TEXT NOT NULL, not_before INTEGER NOT NULL,
      PRIMARY KEY (tenant, name)) WITHOUT ROWID`)
    sql.exec(`CREATE TABLE IF NOT EXISTS alert (tenant TEXT NOT NULL, grp TEXT NOT NULL, rule_key TEXT NOT NULL, fp TEXT NOT NULL, body TEXT NOT NULL,
      PRIMARY KEY (tenant, grp, rule_key, fp)) WITHOUT ROWID`)
    sql.exec(`CREATE TABLE IF NOT EXISTS handoff (tenant TEXT NOT NULL, seq INTEGER NOT NULL, created_at INTEGER NOT NULL, updates TEXT NOT NULL,
      PRIMARY KEY (tenant, seq)) WITHOUT ROWID`)
    this.load()
  }

  // ───────────────────────── injection points ─────────────────────────
  // Production reads bindings and the real clock; `test/harness.ts` overrides these.

  protected now(): number {
    return Date.now()
  }

  protected evaluator(): Evaluator {
    const binding = this.env.EVALUATOR
    if (!binding) throw new Error('no EVALUATOR binding')
    return { instant: (promql, timeMs) => binding.instant(this.tenant, promql, timeMs) }
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
      m.set(row.fp, JSON.parse(row.body) as Alert)
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
      rules: new Map(spec.rules.map((r) => [r.key, { health: 'unknown', lastError: null, lastEvaluationMs: null }])),
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

  private async evalGroup(g: GroupRt, ts: number): Promise<void> {
    const gen = g.gen
    const started = Date.now() // real clock on purpose: this is a duration, not a schedule
    const current = () => this.groups.get(g.spec.name) === g && g.gen === gen
    let evaluator: Evaluator | null = null
    const queryTime = ts - g.spec.queryOffsetMs
    const hardCap = this.cfg.limits.maxAlertsPerRule
    const limit = g.spec.limit > 0 ? Math.min(g.spec.limit, hardCap) : hardCap
    const staged: Staged[] = []
    let pending: { rule: Rule; batch: SampleBatch }[] = []

    let timer: ReturnType<typeof setTimeout> | undefined
    let timedOut: Error | null = null
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject((timedOut = new Error(`group evaluation exceeded ${this.cfg.groupTimeoutMs} ms`))), this.cfg.groupTimeoutMs)
    })
    timeout.catch(() => {})

    const setHealth = (rule: Rule, error: string | null) => {
      g.rules.set(rule.key, { health: error === null ? 'ok' : 'err', lastError: error, lastEvaluationMs: ts })
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

    try {
      for (let i = 0; i < g.spec.rules.length; i++) {
        if (!current()) return
        const rule = g.spec.rules[i] as Rule
        // A later rule that reads a series recorded earlier in this tick must see it: write
        // what is pending first. Otherwise recorded samples go out once, after the last rule.
        if (pending.length > 0 && pending.some((p) => rule.expr.includes(p.rule.name))) await flushSink()
        let series
        try {
          if (timedOut) throw timedOut
          evaluator ??= this.evaluator()
          series = toSeries(await Promise.race([evaluator.instant(rule.expr, queryTime), timeout]))
        } catch (e) {
          // The query failed: say so, and leave the rule's alerts exactly as they were.
          g.evaluatorErrors++
          setHealth(rule, errorText(e))
          continue
        }
        if (rule.kind === 'alert') {
          const result = evalAlertingRule(rule, g.compiled[i] as CompiledAlertRule, g.alerts.get(rule.key) ?? EMPTY, series, ts, {
            resolvedRetentionMs: this.cfg.resolvedRetentionMs,
            limit,
            maxAnnotationBytes: this.cfg.limits.maxAnnotationBytes,
            externalLabels: this.cfg.externalLabels,
          })
          if (result.ok) staged.push({ rule, result })
          setHealth(rule, result.ok ? null : result.error)
        } else {
          const result = evalRecordingRule(rule, series, queryTime, limit)
          if (result.ok && result.samples.length > 0) {
            pending.push({ rule, batch: { id: `${this.tenant}/${this.shard}/${g.spec.name}/${rule.key}@${ts}`, samples: result.samples } })
          }
          setHealth(rule, result.ok ? null : result.error)
        }
      }
      await flushSink()
    } finally {
      clearTimeout(timer)
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
      generator: { group: g.spec.name, rule: rule.name },
      expiresAt: heartbeat && status === 'firing' ? at + 2 * Math.max(this.cfg.heartbeatMs, g.spec.intervalMs) + g.spec.intervalMs : null,
    }
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

  async configure(tenant: string, patch: Partial<Omit<RulerConfig, 'limits'>> & { limits?: Partial<RulerLimits> }) {
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
    return this.wrongTenant(tenant) ?? this.validate(file, this.now()).result
  }

  private validate(file: unknown, now: number): { result: SaveGroupsResult; groups: RuleGroup[] } {
    const parsed = parseRuleFile(file, this.cfg)
    const errors = parsed.errors
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
    const now = this.now()
    const { result, groups } = this.validate(file, now)
    if (result.status !== 'ok') return result
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
    await this.afterMutation(now)
    return result
  }

  /** Inside a transaction: a rule went away. Delete its alerts and tell the notifier the firing ones are over. */
  private dropRuleAlerts(g: GroupRt, key: string, alerts: Map<string, Alert>, now: number, updates: AlertUpdate[]): void {
    const rule = g.spec.rules.find((r) => r.key === key)
    if (alerts.size > 0) this.exec(`DELETE FROM alert WHERE tenant = ? AND grp = ? AND rule_key = ?`, this.tenant, g.spec.name, key)
    if (!rule || rule.kind !== 'alert') return
    for (const a of alerts.values()) if (a.state === 'firing') updates.push(this.toUpdate(g, rule, a, 'resolved', now))
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
    if ((this.groups.size === 0 && this.handoffDepth === 0) || (await this.ctx.storage.getAlarm()) !== null) return { status: 'ok' as const, rearmed: false }
    await this.setAlarm(this.now())
    return { status: 'ok' as const, rearmed: true }
  }
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
