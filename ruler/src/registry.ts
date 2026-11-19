/**
 * The registry of ruler objects, for the sweeper.
 *
 * Why it is its own small object and not part of the Notifier. A Durable Object cannot
 * find itself: if an alarm is lost, a ruler never runs again and nothing inside it can
 * notice. Something outside must know that the object exists. A cron invocation starts
 * with no tenant in hand, so the list has to be reachable without one; a per-tenant object
 * such as the Notifier cannot hold it (the cron would still need the list of tenants), and
 * sweeping through Notifiers would wake every tenant's Notifier on every sweep. So the
 * list lives in `INDEX_PARTITIONS` small objects named `index/<k>`, `k = hash(tenant) mod
 * INDEX_PARTITIONS`: a fixed fan-out for the cron, no single object that every tenant
 * writes to, and a row is written only when a ruler shard gains or loses all its work.
 *
 * The same object records how many shards a tenant's groups are spread over, because the
 * placement (`placement.ts`) must be the same for every caller and must never shrink.
 *
 * `sweepPage` is the one statement that reads across tenants. It returns counts only and
 * is reachable from the cron entry point, never from a tenant's request.
 */
import { DurableObject } from 'cloudflare:workers'
import { openSchema, refusalOf, type SchemaState, SchemaTooNewError } from '../../contracts/schema'
import { INDEX_PARTITIONS, type RulerIndexRpc } from '../contracts-proposal/rules.v2'
import { INDEX_SCHEMA } from './schema'
import { hash64, mapLimit } from './util'

export function indexPartition(tenant: string): number {
  return parseInt(hash64(`viz-ruler-index\n${tenant}`).slice(0, 8), 16) % INDEX_PARTITIONS
}

export const indexName = (tenant: string): string => `index/${indexPartition(tenant)}`

export interface IndexEnv {
  RULER?: DurableObjectNamespace
}

type RulerStub = { ensureArmed(tenant: string): Promise<{ status: string; rearmed?: boolean }> }

export class RulerIndex extends DurableObject<IndexEnv> implements RulerIndexRpc {
  /** What opening storage found. Anything but `ok`: every method throws `SchemaTooNewError` and nothing is written. */
  private schema: SchemaState = { status: 'schema_too_new', component: INDEX_SCHEMA.component, found: 0, compat: 0, known: 0, retryAfterMs: 0 }

  constructor(ctx: DurableObjectState, env: IndexEnv) {
    super(ctx, env)
    // Versioned storage (contracts/COMPATIBILITY.md §2). Local SQLite only.
    void ctx.blockConcurrencyWhile(async () => {
      this.schema = openSchema(ctx.storage, INDEX_SCHEMA)
    })
  }

  /**
   * Storage a newer release wrote: refuse. These results have one shape (`ok`), so a caller
   * that did not expect another would misread one; an exception is what every caller here
   * already handles (contracts/COMPATIBILITY.md §2.4, "not a union").
   */
  private guard(): void {
    const refused = refusalOf(this.schema)
    if (refused) throw new SchemaTooNewError(refused)
  }

  protected now(): number {
    return Date.now()
  }

  /** The ruler object for (tenant, shard). Tests substitute a stub. */
  protected ruler(tenant: string, shard: string): RulerStub {
    const ns = this.env.RULER
    if (!ns) throw new Error('no RULER binding')
    return ns.get(ns.idFromName(`${tenant}/${shard}`)) as unknown as RulerStub
  }

  async register(tenant: string, shard: string) {
    this.guard()
    if (tenant === '' || shard === '') return { status: 'ok' as const, added: false }
    const c = this.ctx.storage.sql.exec(`INSERT OR IGNORE INTO ruler (tenant, shard, registered_at) VALUES (?, ?, ?)`, tenant, shard, this.now())
    return { status: 'ok' as const, added: c.rowsWritten > 0 }
  }

  async unregister(tenant: string, shard: string) {
    this.guard()
    const c = this.ctx.storage.sql.exec(`DELETE FROM ruler WHERE tenant = ? AND shard = ?`, tenant, shard)
    return { status: 'ok' as const, removed: c.rowsWritten > 0 }
  }

  async shardCount(tenant: string) {
    this.guard()
    const row = this.ctx.storage.sql.exec<{ shards: number }>(`SELECT shards FROM tenant_shards WHERE tenant = ?`, tenant).toArray()[0]
    return { status: 'ok' as const, shards: row?.shards ?? 1 }
  }

  async growShards(tenant: string, shards: number) {
    this.guard()
    if (!Number.isInteger(shards) || shards < 1) return this.shardCount(tenant)
    this.ctx.storage.sql.exec(
      `INSERT INTO tenant_shards (tenant, shards) VALUES (?, ?) ON CONFLICT (tenant) DO UPDATE SET shards = MAX(shards, excluded.shards) WHERE tenant = excluded.tenant`, tenant, shards)
    return this.shardCount(tenant)
  }

  async registered(tenant: string) {
    this.guard()
    const shards = this.ctx.storage.sql.exec<{ shard: string }>(`SELECT shard FROM ruler WHERE tenant = ? ORDER BY shard`, tenant).toArray().map((r) => r.shard)
    return { status: 'ok' as const, shards }
  }

  /**
   * One page of the sweep, in (tenant, shard) order after `cursor`. For each registered
   * ruler: `ensureArmed`, which sets an alarm only if the object has work and no alarm.
   * A ruler that cannot be reached is counted and left for the next sweep.
   */
  async sweepPage(cursor: string | null, limit: number) {
    this.guard()
    const [afterTenant, afterShard] = cursor === null ? ['', ''] : (JSON.parse(cursor) as [string, string])
    const rows = this.ctx.storage.sql
      .exec<{ tenant: string; shard: string }>(
        // viz:sweep — platform enumeration, not a tenant's read (see the header).
        `SELECT tenant, shard FROM ruler WHERE (tenant, shard) > (?, ?) ORDER BY tenant, shard LIMIT ?`, afterTenant, afterShard, Math.max(1, Math.min(limit, 500)))
      .toArray()
    let rearmed = 0
    let failed = 0
    // A Durable Object has six outbound connections; stay under them.
    await mapLimit(rows, 4, async (r) => {
      try {
        const res = await this.ruler(r.tenant, r.shard).ensureArmed(r.tenant)
        if (res.status === 'ok' && res.rearmed) rearmed++
        else if (res.status !== 'ok') failed++
      } catch {
        failed++
      }
    })
    const last = rows[rows.length - 1]
    return { checked: rows.length, rearmed, failed, next: last && rows.length > 0 && rows.length >= Math.max(1, Math.min(limit, 500)) ? JSON.stringify([last.tenant, last.shard]) : null }
  }
}

export interface SweepResult {
  partitions: number
  checked: number
  rearmed: number
  failed: number
}

/**
 * The Cron Trigger entry point: walk every index partition and re-arm rulers whose alarm
 * was lost. Idempotent; a ruler that is armed is left alone, so sweeping twice changes
 * nothing the second time.
 */
export async function sweep(env: { RULER_INDEX: { idFromName(name: string): DurableObjectId; get(id: DurableObjectId): unknown } }, pageSize = 200): Promise<SweepResult> {
  const total: SweepResult = { partitions: INDEX_PARTITIONS, checked: 0, rearmed: 0, failed: 0 }
  await mapLimit(Array.from({ length: INDEX_PARTITIONS }, (_, k) => k), 4, async (k) => {
    const stub = env.RULER_INDEX.get(env.RULER_INDEX.idFromName(`index/${k}`)) as unknown as RulerIndexRpc
    let cursor: string | null = null
    do {
      const page: Awaited<ReturnType<RulerIndexRpc['sweepPage']>> = await stub.sweepPage(cursor, pageSize)
      total.checked += page.checked
      total.rearmed += page.rearmed
      total.failed += page.failed
      cursor = page.next
    } while (cursor !== null)
  })
  return total
}
