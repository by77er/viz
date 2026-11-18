import type { Engine } from '../../contracts/engine'
import { TENANT_ID } from '../../contracts/ledger'
import { type CompactPolicy, type CompactRun, compactTenant } from '../../compact/src/compact'
import type { FlushResult } from '../../flush/src/flush'
import { DEFAULT_DELETE_GRACE_MS, DEFAULT_ORPHAN_GRACE_MS, type ExpireResult, type JanitorEnv, type OrphanResult, type PurgeResult, expireTenant, purgeTenant, sweepOrphans } from '../../janitor/src/janitor'

/**
 * Maintenance of one tenant's files, and what makes it run without anyone calling it.
 *
 *   maintainTenant   compaction steps, then retention (expire), then physical deletion of
 *                    what the ledger calls deletable, and now and then the orphan sweep.
 *
 * Who calls it: the consumer of the maintenance queue (`MAINT_QUEUE`, messages `{tenant}`).
 * Who writes to that queue:
 *
 *   - the flush consumer, after every flush run that ended ok (new files may be mergeable);
 *   - the cron handler, for every tenant whose maintenance marker is due.
 *
 * The marker is the KV key `maint:<tenant>` with metadata `{ due, orphansAt }`. `due` is
 * the earliest time at which time alone gives this tenant something to do: an hour going
 * quiet, a day closing, a day passing its retention, a grace period ending. Every
 * maintenance run rewrites it from what it found, and deletes it when the tenant has no
 * live file, no tombstone and no object left. The cron lists the markers (one KV list, the
 * metadata comes with it) and enqueues only the due ones, so a deployment whose tenants
 * have nothing due wakes no Durable Object and sends no message.
 */

export interface MaintMessage {
  tenant: string
}

export interface MaintEnv extends JanitorEnv {
  MAINT_QUEUE: Queue<MaintMessage>
}

export interface MaintOptions {
  /** Policy clock (tests). Graces are always judged by real clocks: the ledger's and R2's. */
  now?: number
  compaction?: Partial<CompactPolicy>
  /** Merges per run; more work is left for a follow-up message. */
  maxCompactSteps?: number
  deleteGraceMs?: number
  orphanGraceMs?: number
  /** For the orphan sweep's rule about compaction outputs; default is the compaction policy's `maxStepMs`. */
  maxCompactStepMs?: number
  /** The orphan sweep lists the tenant's whole prefix, so it runs at most this often. */
  orphanEveryMs?: number
}

export interface MaintReport {
  tenant: string
  compaction: CompactRun
  expired: ExpireResult
  purged: PurgeResult
  orphans: OrphanResult | null
  /** When to look again, or null if the tenant has nothing left (its marker is deleted). */
  nextDueAt: number | null
  /** True if compaction stopped at `maxCompactSteps`: run again now. */
  more: boolean
}

export const MAINT_MARKER_PREFIX = 'maint:'
export const maintMarkerKey = (tenant: string): string => `${MAINT_MARKER_PREFIX}${tenant}`
interface Marker {
  due: number
  orphansAt: number
}

const DAY_MS = 86_400_000

async function readMarker(env: MaintEnv, tenant: string): Promise<Marker | null> {
  const r = await env.CONFIG.getWithMetadata<Marker>(maintMarkerKey(tenant))
  return r.value === null ? null : { due: r.metadata?.due ?? 0, orphansAt: r.metadata?.orphansAt ?? 0 }
}

const writeMarker = (env: MaintEnv, tenant: string, m: Marker): Promise<void> => env.CONFIG.put(maintMarkerKey(tenant), '1', { metadata: m })

/**
 * After a flush run that ended ok: make sure the tenant has a marker and ask for a
 * maintenance run now. Used as the flush consumer's `onFlushed`.
 */
export async function noteFlushed(env: MaintEnv, result: Pick<FlushResult, 'tenant'>): Promise<void> {
  const existing = await readMarker(env, result.tenant)
  if (!existing || existing.due > Date.now()) {
    // Best effort: KV allows one write a second per key, and two shards of a tenant may be
    // flushed in the same second. The maintenance run this message causes writes the marker anyway.
    await writeMarker(env, result.tenant, { due: Date.now(), orphansAt: existing?.orphansAt ?? Date.now() }).catch(() => undefined)
  }
  await env.MAINT_QUEUE.send({ tenant: result.tenant })
}

export async function maintainTenant(env: MaintEnv, engine: Engine, tenant: string, opts: MaintOptions = {}): Promise<MaintReport> {
  if (!TENANT_ID.test(tenant)) throw new Error('maintain: tenant id must match [A-Za-z0-9_-]{1,64}')
  const now = opts.now ?? Date.now()
  const deleteGraceMs = opts.deleteGraceMs ?? DEFAULT_DELETE_GRACE_MS
  const orphanEveryMs = opts.orphanEveryMs ?? DAY_MS
  const marker = (await readMarker(env, tenant)) ?? { due: 0, orphansAt: 0 }

  // Retention first: there is no point merging a day that is about to expire.
  const expired = await expireTenant(env, tenant, now)
  const compaction = await compactTenant(env, engine, tenant, { now, policy: opts.compaction, maxSteps: opts.maxCompactSteps ?? 8 })
  const purged = await purgeTenant(env, tenant, { graceMs: deleteGraceMs })
  let orphans: OrphanResult | null = null
  if (Date.now() - marker.orphansAt >= orphanEveryMs) {
    orphans = await sweepOrphans(env, tenant, { graceMs: opts.orphanGraceMs ?? DEFAULT_ORPHAN_GRACE_MS, maxCompactStepMs: opts.maxCompactStepMs })
    marker.orphansAt = Date.now()
  }

  // When could time alone make work again?
  const ledger = env.LEDGER.get(env.LEDGER.idFromName(tenant))
  const samples = await ledger.plan({ table: 'metric_samples', minTs: 0, maxTs: Number.MAX_SAFE_INTEGER })
  const series = await ledger.plan({ table: 'metric_series', minTs: 0, maxTs: Number.MAX_SAFE_INTEGER })
  const live = samples.files.length + series.files.length
  const due: number[] = []
  const more = compaction.more
  const failed = compaction.steps.at(-1)?.status === 'error'
  if (more) due.push(Date.now())
  if (failed) due.push(Date.now() + 10 * 60_000) // a merge the ledger or the row check refused: look again, not in a loop
  if (compaction.nextDueAt !== null) due.push(compaction.nextDueAt)
  // Retention works on whole UTC days: the next thing to expire does so at the next midnight.
  if (live > 0) due.push((Math.floor(now / DAY_MS) + 1) * DAY_MS)
  // Tombstones waiting for their grace or for the ledger's log: after the grace at the latest.
  if (purged.waiting > 0) due.push(Date.now() + Math.max(deleteGraceMs, 60_000))
  // The orphan sweep is due again while anything is left under the tenant's prefix, or
  // while this run did not look (objects a failed flush left behind are found only by it).
  const objectsLeft = orphans === null ? 1 : orphans.listed - orphans.deleted.length
  if (live > 0 || purged.waiting > 0 || objectsLeft > 0) due.push(marker.orphansAt + orphanEveryMs)

  const nextDueAt = due.length === 0 ? null : Math.min(...due)
  // The marker is written before the run is acknowledged: if this throws, the message is retried.
  if (nextDueAt === null) await env.CONFIG.delete(maintMarkerKey(tenant))
  else await writeMarker(env, tenant, { due: nextDueAt, orphansAt: marker.orphansAt })
  return { tenant, compaction, expired, purged, orphans, nextDueAt, more }
}

/** The cron's part: enqueue every tenant whose marker is due. One KV list; no Durable Object. */
export async function enqueueDue(env: MaintEnv, now = Date.now()): Promise<{ markers: number; enqueued: string[] }> {
  const enqueued: string[] = []
  let markers = 0
  let cursor: string | undefined
  do {
    const page: KVNamespaceListResult<Marker> = await env.CONFIG.list<Marker>({ prefix: MAINT_MARKER_PREFIX, cursor })
    for (const k of page.keys) {
      markers++
      const tenant = k.name.slice(MAINT_MARKER_PREFIX.length)
      if (TENANT_ID.test(tenant) && (k.metadata?.due ?? 0) <= now) enqueued.push(tenant)
    }
    cursor = page.list_complete ? undefined : page.cursor
  } while (cursor)
  for (let i = 0; i < enqueued.length; i += 100) await env.MAINT_QUEUE.sendBatch(enqueued.slice(i, i + 100).map((tenant) => ({ body: { tenant } })))
  return { markers, enqueued }
}

export interface MaintOutcome {
  tenant: string
  action: 'done' | 'again'
  why?: string
  report?: MaintReport
}

/**
 * Consumer of the maintenance queue. One run per tenant per batch; a run that throws is
 * retried with a delay (and dead-lettered by the queue after `max_retries`); a run that
 * stopped at its step limit sends a follow-up message instead of holding this one.
 */
export async function consumeMaintBatch(
  batch: MessageBatch<unknown>,
  env: MaintEnv,
  engine: Engine,
  opts: MaintOptions & { run?: typeof maintainTenant; deadLetter?(m: Message<unknown>, reason: string): Promise<void> } = {},
): Promise<MaintOutcome[]> {
  const groups = new Map<string, Message<unknown>[]>()
  for (const m of batch.messages) {
    const tenant = (m.body as MaintMessage | null)?.tenant
    if (typeof tenant !== 'string' || !TENANT_ID.test(tenant)) {
      try {
        await opts.deadLetter?.(m, 'not a {tenant} message')
        m.ack()
      } catch {
        m.retry({ delaySeconds: 60 })
      }
      continue
    }
    groups.set(tenant, [...(groups.get(tenant) ?? []), m])
  }
  const out: MaintOutcome[] = []
  for (const [tenant, messages] of groups) {
    const outcome: MaintOutcome = { tenant, action: 'done' }
    try {
      outcome.report = await (opts.run ?? maintainTenant)(env, engine, tenant, opts)
      if (outcome.report.more) await env.MAINT_QUEUE.send({ tenant })
    } catch (e) {
      outcome.action = 'again'
      outcome.why = e instanceof Error ? e.message : String(e)
    }
    const carrier = outcome.action === 'again' ? messages.reduce((a, b) => (b.attempts < a.attempts ? b : a)) : null
    for (const m of messages) {
      if (m === carrier) m.retry({ delaySeconds: Math.min(600, 15 * 2 ** Math.max(0, m.attempts - 1)) })
      else m.ack()
    }
    out.push(outcome)
  }
  return out
}
