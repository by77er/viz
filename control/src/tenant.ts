import { DurableObject } from 'cloudflare:workers'
import { TENANT_ID } from '../../contracts/ledger'
import { openSchema, refusalOf, type SchemaState, type SchemaTooNew, SchemaTooNewError } from '../../contracts/schema'
import { type Caps, capsFrom } from './caps'
import { Problem, schemaProblem } from './errors'
import type { Actor, Identity } from './identity'
import { auditOps } from './ops-audit'
import { dashboardOps } from './ops-dashboards'
import { expireProposals, proposalOps } from './ops-proposals'
import { keyOps, newKey, purgeStaleSecrets } from './ops-keys'
import { mayApply, purgeDashboards } from './ops-dashboards'
import { settingsOps } from './ops-settings'
import { type OpInput, type OpName, type OpResult, routeOf } from './routes'
import { TENANT_SCHEMA } from './schema'
import { randomId } from './util'

export interface TenantEnv {
  CONFIG: KVNamespace
  CONTROL_CAPS?: string
  LIMIT_CEILINGS?: string
  DEFAULT_POOL?: string
}

/** One request as an operation sees it. */
export interface Ctx {
  id: Identity
  actor: Actor
  input: OpInput
  now: number
  dryRun: boolean
}

export type Op = (t: Tenant, c: Ctx) => OpResult
export type Row = Record<string, SqlStorageValue>

const SYSTEM: Actor = { subject: 'system', kind: 'system', name: null }
/** How soon the alarm retries a KV publication that failed. */
const OUTBOX_RETRY_MS = 30_000

/** Thrown inside the transaction to undo it and still return what would have happened. */
class Rollback extends Error {
  constructor(readonly result: OpResult) {
    super('rollback')
  }
}

/** A mutation that turned out to change nothing: no revision, no audit row. */
export class NoChange extends Rollback {}


const OPS: Record<OpName, Op> = {
  // mayApply: whether this caller's direct dashboard writes take effect (rather than being refused or
  // turned into proposals), so a client can know without a dry run. Depends on the tenant's settings.
  whoami: (t, c) => ({ status: 200, body: { tenant: c.id.tenant, subject: c.id.subject, kind: c.id.kind, name: c.id.name ?? null, scopes: c.id.scopes, mayApply: mayApply(t, c) } }),
  ...keyOps,
  ...dashboardOps,
  ...proposalOps,
  ...settingsOps,
  ...auditOps,
}

/**
 * Everything about one tenant that is not telemetry: API keys, dashboards and their
 * revisions, proposed changes, settings, and the audit log of all of it.
 *
 * Rules this object keeps (AGENTS.md, "Durable Objects"):
 * - SQLite is the only state. The fields below are configuration, the bound tenant read
 *   back from SQLite, and a lock; nothing is cached that another request could change.
 * - Every statement on tenant data names the tenant in its WHERE clause.
 * - A mutation, its audit row and its KV outbox rows commit in one transaction. KV is
 *   written only afterwards, from the outbox, in order.
 * - One alarm, at the earliest of: a proposal expiring, a deleted dashboard due for
 *   purging, an unpublished outbox row. Absent when there is none.
 */
export class Tenant extends DurableObject<TenantEnv> {
  /** Replaceable in tests to make KV fail. Never state. */
  kv: KVNamespace
  caps: Caps
  /** The tenant this object belongs to, from SQLite; '' until it is provisioned. */
  tenant = ''
  private draining: Promise<boolean> = Promise.resolve(true)

  /** What opening storage found (contracts/schema.ts). Anything but `ok` and the object serves nothing and writes nothing. */
  schema: SchemaState = { status: 'schema_too_new', component: TENANT_SCHEMA.component, found: 0, compat: 0, known: 0, retryAfterMs: 0 }

  constructor(ctx: DurableObjectState, env: TenantEnv) {
    super(ctx, env)
    this.kv = env.CONFIG
    this.caps = capsFrom(env.CONTROL_CAPS)
    // Versioned storage: migrate, or refuse storage a newer release wrote (contracts/COMPATIBILITY.md §2).
    // Local SQLite only, so holding off other events for it is allowed (AGENTS.md).
    void ctx.blockConcurrencyWhile(async () => {
      this.schema = openSchema(ctx.storage, TENANT_SCHEMA)
      if (this.schema.status !== 'ok') return
      const bound = ctx.storage.sql.exec("SELECT tenant FROM tenant_meta WHERE k = 'bound'").toArray()[0]
      if (bound) this.tenant = bound.tenant as string
    })
  }

  /** Non-null when this code may not touch the storage: every entry point answers with it and writes nothing. */
  refusal(): SchemaTooNew | null {
    return refusalOf(this.schema)
  }

  // ---- SQL helpers ----

  all<T = Row>(query: string, ...bindings: SqlStorageValue[]): T[] {
    return this.ctx.storage.sql.exec(query, ...bindings).toArray() as T[]
  }

  one<T = Row>(query: string, ...bindings: SqlStorageValue[]): T | undefined {
    return this.all<T>(query, ...bindings)[0]
  }

  run(query: string, ...bindings: SqlStorageValue[]): number {
    return this.ctx.storage.sql.exec(query, ...bindings).rowsWritten
  }

  get limitCeilings(): Record<string, unknown> {
    try {
      const v: unknown = this.env.LIMIT_CEILINGS ? JSON.parse(this.env.LIMIT_CEILINGS) : {}
      return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  }

  /** The shared pool's map as edge has it (`DEFAULT_POOL`), or {} when there is none. */
  get sharedPool(): { pool?: unknown; slots?: unknown; epoch?: unknown } {
    try {
      const v: unknown = JSON.parse(this.env.DEFAULT_POOL ?? '{}')
      return typeof v === 'object' && v !== null ? v : {}
    } catch {
      return {}
    }
  }

  // ---- audit and outbox: only ever called inside a mutation's transaction ----

  audit(actor: Actor, now: number, action: string, targetType: string, targetId: string, before: unknown, after: unknown): string {
    const id = `a_${randomId(22)}`
    this.run(
      'INSERT INTO audit (tenant, id, at, subject, kind, name, action, target_type, target_id, before, after) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      this.tenant, id, now, actor.subject, actor.kind, actor.name, action, targetType, targetId,
      before === null || before === undefined ? null : JSON.stringify(before),
      after === null || after === undefined ? null : JSON.stringify(after),
    )
    return id
  }

  /** Queue a KV write (`value === null`: delete). `expiration` is Unix seconds. */
  publish(kvKey: string, value: unknown, now: number, expiration: number | null = null): void {
    this.run('INSERT INTO outbox (tenant, kv_key, value, expiration, created_at) VALUES (?, ?, ?, ?, ?)', this.tenant, kvKey, value === null ? null : JSON.stringify(value), expiration, now)
  }

  private count(table: 'audit' | 'outbox'): number {
    return this.one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE tenant = ?`, this.tenant)!.n
  }

  /**
   * Run a mutation: everything it writes, its one audit row and its outbox rows commit
   * together or not at all. A dry run executes the same code and then rolls back, so what
   * it reports is exactly what the real call would do.
   */
  private mutate(c: Ctx, op: Op): { result: OpResult; committed: boolean; queued: boolean } {
    let queued = false
    try {
      const result = this.ctx.storage.transactionSync(() => {
        const audits = this.count('audit')
        const outbox = this.count('outbox')
        const r = op(this, c)
        const written = this.count('audit') - audits
        if (written !== 1) throw new Error(`${written} audit rows for one mutation`)
        queued = this.count('outbox') > outbox
        if (c.dryRun) throw new Rollback(r)
        return r
      })
      return { result, committed: true, queued }
    } catch (e) {
      if (e instanceof Rollback) {
        const body = e.result.body
        return { result: { ...e.result, body: typeof body === 'object' && body !== null ? { ...body, dryRun: c.dryRun } : body }, committed: false, queued: false }
      }
      throw e
    }
  }

  // ---- the alarm and the outbox ----

  /** Set the one alarm to the earliest deadline, or remove it. Call synchronously after a commit. */
  private schedule(): Promise<void> {
    const t = this.tenant
    const deadlines: number[] = []
    const p = this.one<{ m: number | null }>("SELECT MIN(expires_at) AS m FROM proposals WHERE tenant = ? AND status = 'open'", t)!.m
    if (p !== null) deadlines.push(p)
    const d = this.one<{ m: number | null }>('SELECT MIN(purge_at) AS m FROM dashboards WHERE tenant = ? AND deleted_at IS NOT NULL', t)!.m
    if (d !== null) deadlines.push(d)
    const o = this.one<{ m: number | null }>('SELECT MIN(created_at) AS m FROM outbox WHERE tenant = ?', t)!.m
    if (o !== null) deadlines.push(Date.now() + OUTBOX_RETRY_MS)
    return deadlines.length ? this.ctx.storage.setAlarm(Math.min(...deadlines)) : this.ctx.storage.deleteAlarm()
  }

  /** Publish the outbox to KV in order. One drain at a time, so an older value never lands after a newer one. */
  private drain(): Promise<boolean> {
    const next = this.draining.then(
      () => this.drainOnce(),
      () => this.drainOnce(),
    )
    this.draining = next
    return next
  }

  private async drainOnce(): Promise<boolean> {
    for (;;) {
      const row = this.one<{ seq: number; kv_key: string; value: string | null; expiration: number | null }>(
        'SELECT seq, kv_key, value, expiration FROM outbox WHERE tenant = ? ORDER BY seq LIMIT 1',
        this.tenant,
      )
      if (!row) return true
      try {
        // KV refuses an expiration less than 60 s away; a record that close to its end is removed instead.
        const expired = row.expiration !== null && row.expiration - Date.now() / 1000 < 61
        if (row.value === null || expired) await this.kv.delete(row.kv_key)
        else await this.kv.put(row.kv_key, row.value, row.expiration !== null ? { expiration: row.expiration } : undefined)
      } catch {
        return false // the row stays; the alarm retries
      }
      this.run('DELETE FROM outbox WHERE tenant = ? AND seq = ?', this.tenant, row.seq)
    }
  }

  /** Idempotent and safe to run at any time: expire proposals, purge old deleted dashboards, republish. */
  override async alarm(): Promise<void> {
    const refused = this.refusal()
    if (refused) {
      // Keep the alarm for the release that owns this storage; touch nothing else.
      await this.ctx.storage.setAlarm(Date.now() + refused.retryAfterMs)
      return
    }
    if (this.tenant === '') return
    const now = Date.now()
    this.ctx.storage.transactionSync(() => {
      expireProposals(this, SYSTEM, now)
      purgeDashboards(this, SYSTEM, now)
      purgeStaleSecrets(this, now)
    })
    await this.drain()
    await this.schedule()
  }

  // ---- RPC ----

  /**
   * Create the tenant and its first admin key. This is the operator's entry point and is
   * reachable only through the Durable Object binding: no HTTP route leads here, because
   * an HTTP route would have to take a tenant from the request.
   */
  async provision(tenant: string, keyName = 'first admin key'): Promise<{ key: string; id: string }> {
    const refused = this.refusal()
    if (refused) throw new SchemaTooNewError(refused)
    if (!TENANT_ID.test(tenant)) throw new Error('tenant id must match [A-Za-z0-9_-]{1,64}')
    if (this.tenant !== '' && this.tenant !== tenant) throw new Error('this object belongs to another tenant')
    const now = Date.now()
    const actor: Actor = { subject: 'system:provision', kind: 'system', name: null }
    const out = this.ctx.storage.transactionSync(() => {
      this.run("INSERT OR IGNORE INTO tenant_meta (tenant, k, v) VALUES (?, 'bound', ?)", tenant, String(now))
      this.tenant = tenant
      if (this.one('SELECT id FROM keys WHERE tenant = ? LIMIT 1', tenant)) throw new Error('tenant already provisioned; create further keys through the API')
      const k = newKey(this, actor, now, { name: keyName, scopes: ['admin'], kind: 'key', expiresAt: null })
      this.audit(actor, now, 'tenant.provision', 'tenant', tenant, null, { firstKey: k.view })
      return k
    })
    const scheduled = this.schedule()
    await this.drain()
    await scheduled
    await this.schedule()
    return { key: out.secret, id: out.view.id as string }
  }

  /** The authoritative answer for an API key that KV says is good. Null: not live. `schema_too_new`: ask again later, it is not a "no". */
  async resolveKey(tenant: string, keyId: string): Promise<{ subject: string; kind: 'agent' | 'key'; name: string; scopes: string[] } | null | SchemaTooNew> {
    const refused = this.refusal()
    if (refused) return refused
    if (this.tenant === '' || tenant !== this.tenant) return null
    const now = Date.now()
    const row = this.one<{ id: string; name: string; kind: 'agent' | 'key'; scopes: string }>(
      `SELECT k.id, k.name, k.kind, k.scopes FROM key_secrets s JOIN keys k ON k.tenant = s.tenant AND k.id = s.key
       WHERE s.tenant = ? AND s.key_id = ? AND k.disabled = 0
         AND (s.valid_until IS NULL OR s.valid_until > ?) AND (k.expires_at IS NULL OR k.expires_at > ?)`,
      this.tenant, keyId, now, now,
    )
    return row ? { subject: `key:${row.id}`, kind: row.kind, name: row.name, scopes: JSON.parse(row.scopes) as string[] } : null
  }

  /**
   * Usage reported by the data path, batched by the caller (one call per flush interval,
   * not per request). Until something calls this, "last used" and "samples, 24 h" are null.
   * Usage is telemetry about a key, not a change to it: it is not in the audit log.
   */
  async recordUsage(tenant: string, batch: { keyId: string; at: number; samples: number }[]): Promise<{ accepted: number; unknown: number } | SchemaTooNew> {
    const refused = this.refusal()
    if (refused) return refused
    if (this.tenant === '' || tenant !== this.tenant) return { accepted: 0, unknown: batch.length }
    let accepted = 0
    let unknown = 0
    const now = Date.now()
    this.ctx.storage.transactionSync(() => {
      for (const u of batch) {
        const ok = typeof u.keyId === 'string' && Number.isSafeInteger(u.at) && u.at > 0 && Number.isSafeInteger(u.samples) && u.samples >= 0
        const key = ok ? this.one<{ key: string }>('SELECT key FROM key_secrets WHERE tenant = ? AND key_id = ?', this.tenant, u.keyId) : undefined
        if (!key) {
          unknown++
          continue
        }
        accepted++
        this.run(
          'INSERT INTO key_usage (tenant, key, hour, samples) VALUES (?, ?, ?, ?) ON CONFLICT (tenant, key, hour) DO UPDATE SET samples = samples + excluded.samples',
          this.tenant, key.key, Math.floor(u.at / 3_600_000), u.samples,
        )
        this.run('UPDATE keys SET last_used_at = MAX(COALESCE(last_used_at, 0), ?) WHERE tenant = ? AND id = ?', u.at, this.tenant, key.key)
      }
      this.run('DELETE FROM key_usage WHERE tenant = ? AND hour < ?', this.tenant, Math.floor(now / 3_600_000) - 48)
    })
    return { accepted, unknown }
  }

  /** Run one operation of the HTTP API for an identity the Worker has established. */
  async invoke(id: Identity, op: OpName, input: OpInput): Promise<OpResult> {
    try {
      const refused = this.refusal()
      if (refused) throw schemaProblem(refused)
      const now = Date.now()
      if (this.tenant === '' || id.tenant !== this.tenant) throw new Problem(401, 'unauthenticated', 'The credential is not usable.', 'Use a key of a provisioned tenant.')
      let identity = id
      if (id.keyId !== undefined) {
        // The key must still be live here, whatever KV or a cache said a moment ago.
        const live = await this.resolveKey(id.tenant, id.keyId)
        if (!live) throw new Problem(401, 'unauthenticated', 'The API key is disabled, expired or deleted.', 'Use a key that is enabled and not expired.')
        if ('status' in live) throw schemaProblem(live)
        identity = { ...id, ...live }
      }
      const route = routeOf(op)
      if (!route.scopes.some((s) => identity.scopes.includes(s))) {
        throw new Problem(403, 'missing-scope', `This needs one of the scopes: ${route.scopes.join(', ')}.`, `Use a key that has one of: ${route.scopes.join(', ')}. This key has: ${identity.scopes.join(', ') || 'none'}.`, { required: route.scopes })
      }
      const body = input.body as { dryRun?: unknown } | undefined | null
      const dryRun = route.mutation && (body?.dryRun === true || input.query.dryRun?.[0] === 'true')
      const c: Ctx = { id: identity, actor: { subject: identity.subject, kind: identity.kind, name: identity.name ?? null }, input, now, dryRun }
      if (!route.mutation) return OPS[op](this, c)

      const { result, committed, queued } = this.mutate(c, OPS[op])
      if (!committed) return result
      const scheduled = this.schedule() // same turn as the commit: the alarm is durable with it
      let published = true
      if (queued) published = await this.drain()
      await scheduled
      if (queued) await this.schedule()
      return queued && typeof result.body === 'object' && result.body !== null ? { ...result, body: { ...result.body, kv: published ? 'published' : 'pending' } } : result
    } catch (e) {
      if (e instanceof Problem) return { status: e.status, body: e.body(), headers: { ...e.headers, 'Content-Type': 'application/problem+json' } }
      throw e
    }
  }
}
