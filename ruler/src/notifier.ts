import { DurableObject } from 'cloudflare:workers'
import {
  IDEMPOTENCY_HEADER,
  type AlertUpdate,
  type IngestResult,
  type NotifierAlert,
  type NotifierHealth,
  type NotifierRpc,
  type OutboxEntry,
  type Silence,
  type SilenceInput,
  type WrongTenant,
} from '../contracts-proposal/rules'
import {
  compileConfig,
  compileSilenceMatchers,
  groupKey,
  groupLabels,
  inhibitedBy,
  matchRoutes,
  silencedBy,
  validateSilence,
  type CompiledConfig,
  type CompiledSilence,
  type Integration,
  type Route,
} from './amconfig'
import { slackPayload, webhookPayload, type PayloadAlert } from './payload'
import { backoffMs, hash64, type Labels } from './util'

/**
 * The notifier: Alertmanager's model for one tenant, owned by a single object.
 *
 * It is a sibling of the Ruler rather than part of it because routing, grouping and above
 * all inhibition are defined over ALL of a tenant's alerts, and a tenant's rules are spread
 * over several ruler shards (`<tenant>/<n>`). One owner of group state also removes the
 * need for Alertmanager's gossip and notification-log replication. The price is a hop:
 * rulers hand transitions over through their own outbox (`Ruler.handoff`), and `ingest`
 * here is idempotent, so the hop is at-least-once with exactly-once effect.
 *
 * Time. A group is flushed only at its ticks: `anchor + k * group_interval`, where the
 * anchor is the group's creation plus `group_wait`. A flush decides from the state "as of
 * the tick": an alert counts once it was received at or before the tick, and counts as
 * resolved once its resolution was received at or before the tick. Decisions are therefore
 * a function of stored rows and the tick time, not of when the alarm happened to run, so a
 * replayed or late alarm decides the same thing, and the notification log (in the group
 * row, written in the same transaction as the outbox row) stops a second send.
 *
 * Delivery. `flush` inserts outbox rows; `drain` POSTs them. A row is deleted only after a
 * 2xx. Every attempt of one notification carries the same `Idempotency-Key`.
 */

export const DEFAULT_NOTIFIER_LIMITS = { maxAlerts: 5000, maxSilences: 1000, maxPayloadAlerts: 500, drainBatch: 25 }

interface StoredAlert {
  fingerprint: string
  labels: Labels
  annotations: Labels
  status: 'firing' | 'resolved'
  startsAt: number
  endsAt: number | null
  value: number
  /** Evaluation time of the last applied update. */
  at: number
  /** Clock time the firing state was first received. */
  receivedAt: number
  /** Clock time the resolution was received. */
  resolvedReceivedAt: number | null
  expiresAt: number | null
  source: string
  generator: { group: string; rule: string }
}

interface LogEntry {
  firing: string[]
  resolved: string[]
  /** Tick of the last notification. */
  ts: number
  /** Notifications decided so far for this (group, integration). */
  n: number
}

interface GroupBody {
  routeKey: string
  receiver: string
  labels: Labels
  createdAt: number
  /** First flush time; later flushes are at `anchor + k * group_interval`. */
  anchor: number
  /** The notification log, per integration. */
  log: Record<string, LogEntry>
}

interface GroupRt {
  key: string
  route: Route
  body: GroupBody
  members: Set<string>
}

interface Decision {
  integration: Integration
  firing: string[]
  resolved: string[]
  /** Something must be recorded in the notification log. */
  update: boolean
  /** ...and a request must actually be sent. */
  send: boolean
}

type OutboxRow = {
  id: number
  gkey: string
  receiver: string
  integration: string
  url: string
  idem_key: string
  body: string
  status: string
  attempts: number
  created_at: number
  next_attempt_at: number
  last_error: string | null
}

function isSubset(a: string[], b: string[]): boolean {
  if (a.length > b.length) return false
  const set = new Set(b)
  for (const x of a) if (!set.has(x)) return false
  return true
}

function errorText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 500)
}

export class Notifier extends DurableObject implements NotifierRpc {
  protected readonly tenant: string
  private cfg: CompiledConfig | null = null
  private alerts = new Map<string, StoredAlert>()
  private silences = new Map<string, { input: SilenceInput; updatedAt: number; compiled: CompiledSilence }>()
  private groups = new Map<string, GroupRt>()
  private nextOutboxId = 1
  private silenceCounter = 0
  private counters = { sqlRowsWritten: 0, alarmsSet: 0, delivered: 0, attempts: 0 }

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never)
    // The object's name IS the tenant.
    this.tenant = ctx.id.name ?? ''
    const sql = ctx.storage.sql
    sql.exec(`CREATE TABLE IF NOT EXISTS meta (tenant TEXT NOT NULL, k TEXT NOT NULL, v TEXT NOT NULL, PRIMARY KEY (tenant, k)) WITHOUT ROWID`)
    sql.exec(`CREATE TABLE IF NOT EXISTS alert (tenant TEXT NOT NULL, fp TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (tenant, fp)) WITHOUT ROWID`)
    sql.exec(`CREATE TABLE IF NOT EXISTS silence (tenant TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (tenant, id)) WITHOUT ROWID`)
    sql.exec(`CREATE TABLE IF NOT EXISTS agg_group (tenant TEXT NOT NULL, gkey TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (tenant, gkey)) WITHOUT ROWID`)
    sql.exec(`CREATE TABLE IF NOT EXISTS outbox (tenant TEXT NOT NULL, id INTEGER NOT NULL, gkey TEXT NOT NULL, receiver TEXT NOT NULL,
      integration TEXT NOT NULL, url TEXT NOT NULL, idem_key TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL,
      created_at INTEGER NOT NULL, next_attempt_at INTEGER NOT NULL, last_error TEXT, PRIMARY KEY (tenant, id)) WITHOUT ROWID`)
    this.load()
  }

  // ───────────────────────── injection points ─────────────────────────

  protected now(): number {
    return Date.now()
  }

  /** The outbound HTTP client. Tests substitute a fake receiver. */
  protected fetcher(): (url: string, init: RequestInit) => Promise<Response> {
    return (url, init) => fetch(url, init)
  }

  /** Fault-injection point for crash tests. Does nothing in production. */
  protected fault(_point: 'flush-commit' | 'flush-committed' | 'sent'): void {}

  // ───────────────────────── storage ─────────────────────────

  private exec<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: SqlStorageValue[]): T[] {
    const cursor = this.ctx.storage.sql.exec<T>(query, ...bindings)
    const rows = cursor.toArray()
    this.counters.sqlRowsWritten += cursor.rowsWritten
    return rows
  }

  private putAlert(a: StoredAlert): void {
    this.exec(`INSERT INTO alert (tenant, fp, body) VALUES (?, ?, ?) ON CONFLICT (tenant, fp) DO UPDATE SET body = excluded.body`, this.tenant, a.fingerprint, JSON.stringify(a))
  }

  private putGroup(g: GroupRt): void {
    this.exec(`INSERT INTO agg_group (tenant, gkey, body) VALUES (?, ?, ?) ON CONFLICT (tenant, gkey) DO UPDATE SET body = excluded.body`, this.tenant, g.key, JSON.stringify(g.body))
  }

  private load(): void {
    const t = this.tenant
    const cfg = this.exec<{ v: string }>(`SELECT v FROM meta WHERE tenant = ? AND k = 'config'`, t)[0]
    if (cfg) {
      const compiled = compileConfig(JSON.parse(cfg.v))
      if (compiled.ok) this.cfg = compiled.config
    }
    for (const r of this.exec<{ body: string }>(`SELECT body FROM alert WHERE tenant = ?`, t)) {
      const a = JSON.parse(r.body) as StoredAlert
      this.alerts.set(a.fingerprint, a)
    }
    for (const r of this.exec<{ id: string; body: string }>(`SELECT id, body FROM silence WHERE tenant = ?`, t)) {
      const s = JSON.parse(r.body) as { input: SilenceInput; updatedAt: number }
      this.silences.set(r.id, { ...s, compiled: { id: r.id, matchers: compileSilenceMatchers(s.input.matchers), startsAt: s.input.startsAt, endsAt: s.input.endsAt } })
    }
    const bodies = new Map(this.exec<{ gkey: string; body: string }>(`SELECT gkey, body FROM agg_group WHERE tenant = ?`, t).map((r) => [r.gkey, JSON.parse(r.body) as GroupBody]))
    this.rebuildGroups(bodies)
    this.nextOutboxId = (this.exec<{ top: number | null }>(`SELECT MAX(id) AS top FROM outbox WHERE tenant = ?`, t)[0]?.top ?? 0) + 1
  }

  /** Derive group membership from the routing tree, attaching the stored group rows. */
  private rebuildGroups(bodies: Map<string, GroupBody>): void {
    this.groups.clear()
    if (!this.cfg) return
    for (const a of this.alerts.values()) {
      for (const route of matchRoutes(this.cfg.root, a.labels)) {
        const labels = groupLabels(route, a.labels)
        const key = groupKey(route, labels)
        let g = this.groups.get(key)
        if (!g) {
          const body = bodies.get(key)
          if (!body) continue
          this.groups.set(key, (g = { key, route, body, members: new Set() }))
        }
        g.members.add(a.fingerprint)
      }
    }
  }

  /** A transaction failed after memory was touched: storage is the truth, start again from it. */
  private reset(): void {
    this.cfg = null
    this.alerts.clear()
    this.silences.clear()
    this.groups.clear()
    this.load()
  }

  private wrongTenant(tenant: string): WrongTenant | null {
    return this.tenant !== '' && tenant === this.tenant ? null : { status: 'wrong_tenant' }
  }

  // ───────────────────────── grouping and decisions ─────────────────────────

  /** Inside a transaction: make sure the groups a firing alert belongs to exist, and add it to them. */
  private joinGroups(a: StoredAlert, now: number): void {
    if (!this.cfg) return
    for (const route of matchRoutes(this.cfg.root, a.labels)) {
      const labels = groupLabels(route, a.labels)
      const key = groupKey(route, labels)
      let g = this.groups.get(key)
      if (!g) {
        // Alertmanager: a new group waits `group_wait`, unless the alert has already been
        // firing for longer than that, in which case it is flushed at once.
        const anchor = a.startsAt + route.groupWaitMs < now ? now : now + route.groupWaitMs
        g = { key, route, body: { routeKey: route.key, receiver: route.receiver, labels, createdAt: now, anchor, log: {} }, members: new Set() }
        this.putGroup(g)
        this.groups.set(key, g)
      }
      g.members.add(a.fingerprint)
    }
  }

  /** The latest flush tick of `g` at or before `t`, or null before its first flush. */
  private tickAt(g: GroupRt, t: number): number | null {
    if (t < g.body.anchor) return null
    return g.body.anchor + Math.floor((t - g.body.anchor) / g.route.groupIntervalMs) * g.route.groupIntervalMs
  }

  /** The first flush tick of `g` at or after `t`. */
  private tickAtOrAfter(g: GroupRt, t: number): number {
    if (t <= g.body.anchor) return g.body.anchor
    return g.body.anchor + Math.ceil((t - g.body.anchor) / g.route.groupIntervalMs) * g.route.groupIntervalMs
  }

  private firingAsOf(a: StoredAlert, tick: number): boolean {
    return a.receivedAt <= tick && !(a.status === 'resolved' && (a.resolvedReceivedAt as number) <= tick)
  }

  private *sourcesAsOf(tick: number): Iterable<StoredAlert> {
    for (const a of this.alerts.values()) if (this.firingAsOf(a, tick)) yield a
  }

  private muted(a: StoredAlert, tick: number): boolean {
    if (silencedBy(this.compiledSilences(), a.labels, tick).length > 0) return true
    return this.cfg !== null && this.cfg.inhibit.length > 0 && inhibitedBy(this.cfg.inhibit, a.labels, this.sourcesAsOf(tick)) !== null
  }

  private *compiledSilences(): Iterable<CompiledSilence> {
    for (const s of this.silences.values()) yield s.compiled
  }

  /**
   * What a flush of `g` at `tick` must do, per integration. This is Alertmanager's
   * pipeline: mute (inhibition, silences), then the dedup stage's `needsUpdate` against
   * the notification log.
   */
  private decide(g: GroupRt, tick: number): Decision[] {
    const firing: string[] = []
    const resolved: string[] = []
    for (const fp of g.members) {
      const a = this.alerts.get(fp)
      if (!a || a.receivedAt > tick) continue
      if (this.muted(a, tick)) continue
      if (this.firingAsOf(a, tick)) firing.push(fp)
      else resolved.push(fp)
    }
    firing.sort()
    resolved.sort()
    const out: Decision[] = []
    for (const integration of this.cfg?.receivers.get(g.route.receiver) ?? []) {
      const entry = g.body.log[integration.key]
      let update: boolean
      if (!entry) update = firing.length > 0
      else if (!isSubset(firing, entry.firing)) update = true
      // No firing alerts now: notify only if the last notification had some (the resolve).
      else if (firing.length === 0) update = entry.firing.length > 0
      else if (integration.sendResolved && !isSubset(resolved, entry.resolved)) update = true
      // Nothing changed: repeat once `repeat_interval` has passed since the last notification.
      else update = entry.ts + g.route.repeatIntervalMs <= tick
      // A receiver that does not want resolved notifications gets nothing when no alert is
      // firing, but the log still moves on, as in Alertmanager.
      const send = update && (integration.sendResolved || firing.length > 0)
      out.push({ integration, firing, resolved: integration.sendResolved ? resolved : [], update, send })
    }
    return out
  }

  /** One flush pass over every group whose tick has come. Decisions and outbox rows commit together. */
  private flush(now: number): void {
    if (!this.cfg) return
    const cfg = this.cfg
    const t = this.tenant
    const plans: { g: GroupRt; tick: number; decisions: Decision[] }[] = []
    for (const g of this.groups.values()) {
      const tick = this.tickAt(g, now)
      if (tick === null) continue
      plans.push({ g, tick, decisions: this.decide(g, tick).filter((d) => d.update) })
    }
    // Resolved alerts leave once every group that holds them has flushed past the resolution.
    const ticks = new Map(plans.map((p) => [p.g.key, p.tick]))
    const gone: string[] = []
    for (const a of this.alerts.values()) {
      if (a.status !== 'resolved') continue
      let held = false
      for (const g of this.groups.values()) {
        if (!g.members.has(a.fingerprint)) continue
        const tick = ticks.get(g.key)
        if (tick === undefined || tick < (a.resolvedReceivedAt as number)) held = true
      }
      if (!held) gone.push(a.fingerprint)
    }
    if (gone.length === 0 && plans.every((p) => p.decisions.length === 0)) return

    const goneSet = new Set(gone)
    const emptied: GroupRt[] = []
    const newLogs: { g: GroupRt; log: Record<string, LogEntry> }[] = []
    let nextId = this.nextOutboxId
    this.ctx.storage.transactionSync(() => {
      for (const { g, tick, decisions } of plans) {
        let newLog: Record<string, LogEntry> | null = null
        if (decisions.length > 0) {
          const log = (newLog = { ...g.body.log })
          for (const d of decisions) {
            const n = (log[d.integration.key]?.n ?? 0) + 1
            log[d.integration.key] = { firing: d.firing, resolved: d.resolved, ts: tick, n }
            if (!d.send) continue
            const alerts: PayloadAlert[] = [...d.firing, ...d.resolved].map((fp) => {
              const a = this.alerts.get(fp) as StoredAlert
              const isFiring = this.firingAsOf(a, tick)
              return { fingerprint: fp, labels: a.labels, annotations: a.annotations, status: isFiring ? 'firing' : 'resolved', startsAt: a.startsAt, endsAt: isFiring ? null : a.endsAt }
            })
            const group = { groupKey: g.key, receiver: g.route.receiver, groupLabels: g.body.labels, externalUrl: cfg.externalUrl }
            const cap = d.integration.maxAlerts > 0 ? Math.min(d.integration.maxAlerts, DEFAULT_NOTIFIER_LIMITS.maxPayloadAlerts) : DEFAULT_NOTIFIER_LIMITS.maxPayloadAlerts
            const body = d.integration.kind === 'slack' ? slackPayload(group, alerts, d.integration.channel, tick) : webhookPayload(group, alerts, cap)
            // Deterministic and attempt-independent: the same decision always yields this key.
            const state = hash64(`${d.firing.join(',')}|${d.resolved.join(',')}`)
            const seed = `${t}\n${g.route.receiver}\n${d.integration.key}\n${g.key}\n${state}\n${n}`
            const idem = hash64(seed) + hash64(`viz-notification\n${seed}`)
            this.exec(`INSERT INTO outbox (tenant, id, gkey, receiver, integration, url, idem_key, body, status, attempts, created_at, next_attempt_at, last_error)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, NULL)`,
              t, nextId++, g.key, g.route.receiver, d.integration.key, d.integration.url, idem, JSON.stringify(body), now, now)
          }
          newLogs.push({ g, log })
        }
        let remaining = 0
        for (const fp of g.members) if (!goneSet.has(fp)) remaining++
        if (remaining === 0) {
          this.exec(`DELETE FROM agg_group WHERE tenant = ? AND gkey = ?`, t, g.key)
          emptied.push(g)
        } else if (newLog) {
          this.exec(`UPDATE agg_group SET body = ? WHERE tenant = ? AND gkey = ?`, JSON.stringify({ ...g.body, log: newLog }), t, g.key)
        }
      }
      for (const fp of gone) this.exec(`DELETE FROM alert WHERE tenant = ? AND fp = ?`, t, fp)
      this.fault('flush-commit')
    })
    // Committed: adopt in memory.
    this.nextOutboxId = nextId
    for (const { g, log } of newLogs) g.body.log = log
    for (const fp of gone) {
      this.alerts.delete(fp)
      for (const g of this.groups.values()) g.members.delete(fp)
    }
    for (const g of emptied) this.groups.delete(g.key)
  }

  /** Heartbeat alerts (the dead-man's switch) that were not refreshed in time resolve themselves. */
  private expire(now: number): void {
    const due = [...this.alerts.values()].filter((a) => a.status === 'firing' && a.expiresAt !== null && a.expiresAt <= now)
    if (due.length === 0) return
    const next = due.map((a): StoredAlert => ({ ...a, status: 'resolved', endsAt: a.expiresAt, at: a.expiresAt as number, resolvedReceivedAt: now, expiresAt: null }))
    this.ctx.storage.transactionSync(() => {
      for (const a of next) this.putAlert(a)
    })
    for (const a of next) this.alerts.set(a.fingerprint, a)
  }

  // ───────────────────────── delivery ─────────────────────────

  /** Send what is due. A row leaves the outbox only after the receiver said 2xx. */
  private async drain(now: number): Promise<void> {
    if (!this.cfg) return
    const { delivery } = this.cfg
    const t = this.tenant
    const rows = this.exec<OutboxRow>(
      `SELECT * FROM outbox WHERE tenant = ? AND status = 'pending' AND next_attempt_at <= ? ORDER BY id LIMIT ?`, t, now, DEFAULT_NOTIFIER_LIMITS.drainBatch)
    for (const row of rows) {
      let ok = false
      let permanent = false
      let error = ''
      this.counters.attempts++
      try {
        const res = await this.fetcher()(row.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'user-agent': 'viz-notifier', [IDEMPOTENCY_HEADER]: row.idem_key },
          body: row.body,
          signal: AbortSignal.timeout(delivery.timeoutMs),
        })
        ok = res.ok
        if (!ok) {
          error = `HTTP ${res.status}`
          // The receiver rejected the request itself; sending it again cannot help.
          permanent = res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429
        }
        await res.body?.cancel()
      } catch (e) {
        error = errorText(e)
      }
      this.fault('sent')
      const attempts = row.attempts + 1
      if (ok) {
        this.exec(`DELETE FROM outbox WHERE tenant = ? AND id = ?`, t, row.id)
        this.counters.delivered++
      } else if (permanent || attempts >= delivery.maxAttempts) {
        this.exec(`UPDATE outbox SET status = 'dead', attempts = ?, last_error = ? WHERE tenant = ? AND id = ?`, attempts, error, t, row.id)
      } else {
        const next = now + backoffMs(attempts, delivery.baseBackoffMs, delivery.maxBackoffMs, row.idem_key)
        this.exec(`UPDATE outbox SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE tenant = ? AND id = ?`, attempts, next, error, t, row.id)
      }
    }
  }

  // ───────────────────────── the alarm ─────────────────────────

  async alarm(): Promise<void> {
    const now = this.now()
    try {
      this.expire(now)
      this.flush(now)
      this.fault('flush-committed')
      await this.drain(now)
    } finally {
      await this.rearm(now)
    }
  }

  /** One alarm at the earliest time anything can change; none when nothing can. */
  private async rearm(now: number): Promise<void> {
    let at = Infinity
    const pending = this.exec<{ next: number | null }>(`SELECT MIN(next_attempt_at) AS next FROM outbox WHERE tenant = ? AND status = 'pending'`, this.tenant)[0]?.next
    if (pending !== null && pending !== undefined) at = Math.min(at, pending)
    for (const a of this.alerts.values()) if (a.status === 'firing' && a.expiresAt !== null) at = Math.min(at, a.expiresAt)
    const boundaries: number[] = []
    for (const s of this.silences.values()) {
      if (s.compiled.startsAt > now) boundaries.push(s.compiled.startsAt)
      if (s.compiled.endsAt > now) boundaries.push(s.compiled.endsAt)
    }
    for (const g of this.groups.values()) {
      if (g.body.anchor > now) {
        at = Math.min(at, g.body.anchor)
        continue
      }
      const tick = this.tickAt(g, now) as number
      // The tick that is already due still has something to do (an update arrived exactly on it).
      if (this.decide(g, tick).some((d) => d.update)) {
        at = Math.min(at, now)
        continue
      }
      const nextTick = tick + g.route.groupIntervalMs
      let hasResolved = false
      for (const fp of g.members) if (this.alerts.get(fp)?.status === 'resolved') hasResolved = true
      if (hasResolved || this.decide(g, nextTick).some((d) => d.update)) {
        at = Math.min(at, nextTick)
        continue
      }
      for (const e of Object.values(g.body.log)) if (e.firing.length > 0) at = Math.min(at, this.tickAtOrAfter(g, e.ts + g.route.repeatIntervalMs))
      for (const b of boundaries) at = Math.min(at, this.tickAtOrAfter(g, b))
    }
    const cur = await this.ctx.storage.getAlarm()
    if (at === Infinity) {
      if (cur !== null) await this.ctx.storage.deleteAlarm()
    } else if (cur !== at) {
      this.counters.alarmsSet++
      await this.ctx.storage.setAlarm(at)
    }
  }

  // ───────────────────────── RPC ─────────────────────────

  async setConfig(tenant: string, config: unknown) {
    const bad = this.wrongTenant(tenant)
    if (bad) return bad
    const compiled = compileConfig(config)
    if (!compiled.ok) return { status: 'invalid' as const, errors: compiled.errors }
    const now = this.now()
    const bodies = new Map([...this.groups.values()].map((g) => [g.key, g.body]))
    try {
      this.ctx.storage.transactionSync(() => {
      this.exec(`INSERT INTO meta (tenant, k, v) VALUES (?, 'config', ?) ON CONFLICT (tenant, k) DO UPDATE SET v = excluded.v`, this.tenant, JSON.stringify(config))
      this.cfg = compiled.config
      this.rebuildGroups(bodies)
      // Groups the new tree no longer produces are dropped with their notification log;
      // firing alerts get groups under the new tree.
      for (const key of bodies.keys()) if (!this.groups.has(key)) this.exec(`DELETE FROM agg_group WHERE tenant = ? AND gkey = ?`, this.tenant, key)
      for (const a of this.alerts.values()) if (a.status === 'firing') this.joinGroups(a, now)
      })
    } catch (e) {
      this.reset()
      throw e
    }
    await this.rearm(now)
    return { status: 'ok' as const }
  }

  async ingest(tenant: string, source: string, updates: AlertUpdate[]): Promise<IngestResult> {
    const bad = this.wrongTenant(tenant)
    if (bad) return bad
    // A ruler shard may only speak for its own tenant.
    if (!source.startsWith(`${this.tenant}/`)) return { status: 'wrong_tenant' }
    const now = this.now()
    // Later updates in one batch see the earlier ones.
    const staged = new Map<string, StoredAlert>()
    let added = 0
    for (const u of updates) {
      const cur = staged.get(u.fingerprint) ?? this.alerts.get(u.fingerprint)
      if (cur) {
        if (u.at < cur.at) continue
        // At the same evaluation time a resolution outranks a firing, so a redelivered
        // "firing" can never undo the "resolved" that followed it.
        if (u.at === cur.at && (cur.status === 'resolved' || (u.status === 'firing' && u.expiresAt === cur.expiresAt))) continue
      }
      if (u.status === 'firing') {
        if (cur && cur.status === 'firing') {
          staged.set(u.fingerprint, { ...cur, annotations: u.annotations, value: u.value, at: u.at, expiresAt: u.expiresAt })
        } else {
          if (!cur) added++
          staged.set(u.fingerprint, {
            fingerprint: u.fingerprint, labels: u.labels, annotations: u.annotations, status: 'firing', startsAt: u.startsAt, endsAt: null,
            value: u.value, at: u.at, receivedAt: now, resolvedReceivedAt: null, expiresAt: u.expiresAt, source, generator: u.generator,
          })
        }
      } else if (cur && cur.status === 'firing') {
        staged.set(u.fingerprint, { ...cur, status: 'resolved', endsAt: u.endsAt ?? u.at, at: u.at, resolvedReceivedAt: now, expiresAt: null })
      }
      // A resolution for an alert this notifier never saw firing has nothing to resolve.
    }
    if (added > 0 && this.alerts.size + added > DEFAULT_NOTIFIER_LIMITS.maxAlerts) return { status: 'overloaded', retryAfterMs: 30_000 }
    const changes = [...staged.values()]
    if (changes.length === 0) return { status: 'ok', applied: 0 }
    try {
      this.ctx.storage.transactionSync(() => {
        for (const a of changes) {
          this.putAlert(a)
          if (a.status === 'firing') this.joinGroups(a, now)
        }
      })
    } catch (e) {
      this.reset()
      throw e
    }
    for (const a of changes) this.alerts.set(a.fingerprint, a)
    await this.rearm(now)
    return { status: 'ok', applied: changes.length }
  }

  async createSilence(tenant: string, silence: SilenceInput) {
    const bad = this.wrongTenant(tenant)
    if (bad) return bad
    const now = this.now()
    const errors = validateSilence(silence, now)
    if (errors.length === 0 && this.silences.size >= DEFAULT_NOTIFIER_LIMITS.maxSilences) {
      // Expired silences make room first.
      for (const [id, s] of this.silences) {
        if (s.compiled.endsAt <= now) {
          this.exec(`DELETE FROM silence WHERE tenant = ? AND id = ?`, this.tenant, id)
          this.silences.delete(id)
        }
      }
      if (this.silences.size >= DEFAULT_NOTIFIER_LIMITS.maxSilences) errors.push({ path: '', message: `this tenant already has ${this.silences.size} silences`, fix: 'Expire silences that are no longer needed.' })
    }
    if (errors.length > 0) return { status: 'invalid' as const, errors }
    const input: SilenceInput = { matchers: silence.matchers, startsAt: silence.startsAt, endsAt: silence.endsAt, createdBy: silence.createdBy, comment: silence.comment }
    const id = hash64(`${this.tenant}\n${now}\n${this.silenceCounter++}\n${JSON.stringify(input)}`)
    this.exec(`INSERT INTO silence (tenant, id, body) VALUES (?, ?, ?)`, this.tenant, id, JSON.stringify({ input, updatedAt: now }))
    this.silences.set(id, { input, updatedAt: now, compiled: { id, matchers: compileSilenceMatchers(input.matchers), startsAt: input.startsAt, endsAt: input.endsAt } })
    await this.rearm(now)
    return { status: 'ok' as const, id }
  }

  async expireSilence(tenant: string, id: string) {
    const bad = this.wrongTenant(tenant)
    if (bad) return bad
    const s = this.silences.get(id)
    if (!s) return { status: 'not_found' as const }
    const now = this.now()
    if (s.compiled.endsAt > now) {
      const input = { ...s.input, endsAt: now, startsAt: Math.min(s.input.startsAt, now) }
      this.exec(`UPDATE silence SET body = ? WHERE tenant = ? AND id = ?`, JSON.stringify({ input, updatedAt: now }), this.tenant, id)
      this.silences.set(id, { input, updatedAt: now, compiled: { ...s.compiled, startsAt: input.startsAt, endsAt: now } })
      await this.rearm(now)
    }
    return { status: 'ok' as const }
  }

  async listSilences(tenant: string) {
    const bad = this.wrongTenant(tenant)
    if (bad) return bad
    const now = this.now()
    const silences: Silence[] = [...this.silences.entries()].map(([id, s]) => ({
      id, ...s.input, updatedAt: s.updatedAt,
      state: s.compiled.endsAt <= now ? 'expired' : s.compiled.startsAt > now ? 'pending' : 'active',
    }))
    return { status: 'ok' as const, silences }
  }

  async listAlerts(tenant: string) {
    const bad = this.wrongTenant(tenant)
    if (bad) return bad
    const now = this.now()
    const alerts: NotifierAlert[] = [...this.alerts.values()].map((a) => ({
      fingerprint: a.fingerprint,
      labels: a.labels,
      annotations: a.annotations,
      status: a.status,
      startsAt: a.startsAt,
      endsAt: a.endsAt,
      silencedBy: silencedBy(this.compiledSilences(), a.labels, now),
      inhibited: this.cfg !== null && inhibitedBy(this.cfg.inhibit, a.labels, this.sourcesAsOf(now)) !== null,
      receivers: this.cfg ? [...new Set(matchRoutes(this.cfg.root, a.labels).map((r) => r.receiver))] : [],
    }))
    return { status: 'ok' as const, alerts }
  }

  async outbox(tenant: string) {
    const bad = this.wrongTenant(tenant)
    if (bad) return bad
    const entries: OutboxEntry[] = this.exec<OutboxRow>(`SELECT * FROM outbox WHERE tenant = ? ORDER BY id LIMIT 1000`, this.tenant).map((r) => ({
      id: r.id, groupKey: r.gkey, receiver: r.receiver, integration: r.integration, url: r.url, idempotencyKey: r.idem_key,
      status: r.status as 'pending' | 'dead', attempts: r.attempts, createdAt: r.created_at, nextAttemptAt: r.next_attempt_at, lastError: r.last_error,
    }))
    return { status: 'ok' as const, entries }
  }

  async retryDeadLetter(tenant: string, id: number) {
    const bad = this.wrongTenant(tenant)
    if (bad) return bad
    const now = this.now()
    const rows = this.exec(`UPDATE outbox SET status = 'pending', attempts = 0, next_attempt_at = ? WHERE tenant = ? AND id = ? AND status = 'dead' RETURNING id`, now, this.tenant, id)
    if (rows.length === 0) return { status: 'not_found' as const }
    await this.rearm(now)
    return { status: 'ok' as const }
  }

  async discardDeadLetter(tenant: string, id: number) {
    const bad = this.wrongTenant(tenant)
    if (bad) return bad
    const rows = this.exec(`DELETE FROM outbox WHERE tenant = ? AND id = ? AND status = 'dead' RETURNING id`, this.tenant, id)
    return rows.length === 0 ? { status: 'not_found' as const } : { status: 'ok' as const }
  }

  async health(tenant: string): Promise<({ status: 'ok' } & NotifierHealth) | WrongTenant> {
    const bad = this.wrongTenant(tenant)
    if (bad) return bad
    const now = this.now()
    const o = this.exec<{ pending: number; dead: number; oldest: number | null }>(
      `SELECT COALESCE(SUM(status = 'pending'), 0) AS pending, COALESCE(SUM(status = 'dead'), 0) AS dead,
        MIN(CASE WHEN status = 'pending' THEN created_at END) AS oldest FROM outbox WHERE tenant = ?`, this.tenant)[0]
    let firing = 0
    for (const a of this.alerts.values()) if (a.status === 'firing') firing++
    return {
      status: 'ok',
      tenant: this.tenant,
      nowMs: now,
      alerts: { firing, resolved: this.alerts.size - firing },
      groups: this.groups.size,
      silences: this.silences.size,
      outboxDepth: o?.pending ?? 0,
      oldestUndeliveredAgeMs: o?.oldest === null || o?.oldest === undefined ? null : Math.max(0, now - o.oldest),
      deadLetters: o?.dead ?? 0,
      alarmAtMs: await this.ctx.storage.getAlarm(),
      counters: { ...this.counters },
    }
  }
}
