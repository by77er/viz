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
 * The marker is the KV key `maint:<tenant>` with metadata `{ due, orphansAt, sweep }`. `due`
 * is the earliest time at which time alone gives this tenant something to do: an hour going
 * quiet, a day closing, the tenant's OLDEST day passing its retention, a grace period
 * ending, an orphan sweep that is still needed. `sweep` says that objects may have been
 * written since the last orphan sweep that found nothing to wait for (a flush, a merge, a
 * merge that crashed); without it the sweep is not due, however long ago it ran. Every
 * maintenance run rewrites the marker from what it found, and deletes it when the tenant has
 * no live file, no tombstone and nothing for the orphan sweep. The cron lists the markers
 * (one KV list, the metadata comes with it) and enqueues only the due ones, so a deployment
 * whose tenants are idle wakes no Durable Object and sends no message until the first of
 * them has a day to expire.
 */

export interface MaintMessage {
  tenant: string
  /** Sent after a flush: new objects exist, so the orphan sweep is needed again. */
  wrote?: boolean
}

export interface MaintEnv extends JanitorEnv {
  MAINT_QUEUE: Queue<MaintMessage>
}

export interface MaintOptions {
  /** Policy clock (tests). Graces are always judged by real clocks: the ledger's and R2's. */
  now?: number
  /** A flush wrote objects since the last run (the message said so): the orphan sweep is needed. */
  wrote?: boolean
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
export interface MaintMarker {
  due: number
  orphansAt: number
  /** Objects may exist that only the orphan sweep would remove. A marker written before this field existed counts as true. */
  sweep: boolean
}

const DAY_MS = 86_400_000

export async function readMarker(env: Pick<MaintEnv, 'CONFIG'>, tenant: string): Promise<MaintMarker | null> {
  const r = await env.CONFIG.getWithMetadata<Partial<MaintMarker>>(maintMarkerKey(tenant))
  return r.value === null ? null : { due: r.metadata?.due ?? 0, orphansAt: r.metadata?.orphansAt ?? 0, sweep: r.metadata?.sweep ?? true }
}

const writeMarker = (env: MaintEnv, tenant: string, m: MaintMarker): Promise<void> => env.CONFIG.put(maintMarkerKey(tenant), '1', { metadata: m })

/**
 * After a flush run that ended ok: make sure the tenant has a marker and ask for a
 * maintenance run now. Used as the flush consumer's `onFlushed`.
 */
export async function noteFlushed(env: MaintEnv, result: Pick<FlushResult, 'tenant'>): Promise<void> {
  const existing = await readMarker(env, result.tenant)
  if (!existing || existing.due > Date.now() || !existing.sweep) {
    // Best effort: KV allows one write a second per key, and two shards of a tenant may be
    // flushed in the same second. The message below carries the same facts (`wrote`), and
    // the maintenance run it causes writes the marker anyway.
    await writeMarker(env, result.tenant, { due: Date.now(), orphansAt: existing?.orphansAt ?? Date.now(), sweep: true }).catch(() => undefined)
  }
  await env.MAINT_QUEUE.send({ tenant: result.tenant, wrote: true })
}

export async function maintainTenant(env: MaintEnv, engine: Engine, tenant: string, opts: MaintOptions = {}): Promise<MaintReport> {
  if (!TENANT_ID.test(tenant)) throw new Error('maintain: tenant id must match [A-Za-z0-9_-]{1,64}')
  const now = opts.now ?? Date.now()
  const deleteGraceMs = opts.deleteGraceMs ?? DEFAULT_DELETE_GRACE_MS
  const orphanEveryMs = opts.orphanEveryMs ?? DAY_MS
  const marker = (await readMarker(env, tenant)) ?? { due: 0, orphansAt: 0, sweep: true }

  // Retention first: there is no point merging a day that is about to expire.
  const expired = await expireTenant(env, tenant, now)
  let compaction: CompactRun
  try {
    compaction = await compactTenant(env, engine, tenant, { now, policy: opts.compaction, maxSteps: opts.maxCompactSteps ?? 8 })
  } catch (e) {
    // A step that crashed may have left its outputs behind, which only the orphan sweep removes.
    if (!marker.sweep) await writeMarker(env, tenant, { ...marker, sweep: true }).catch(() => undefined)
    throw e
  }
  const purged = await purgeTenant(env, tenant, { graceMs: deleteGraceMs })
  // The orphan sweep lists the tenant's whole prefix. It is needed only if objects may have
  // been written since the last sweep that found nothing to wait for: by a flush (the
  // message says so), or by this run's compaction (a merge, a conflict, a refused swap).
  let sweep = marker.sweep || opts.wrote === true || compaction.steps.some((s) => s.status !== 'idle')
  let orphans: OrphanResult | null = null
  if (sweep && Date.now() - marker.orphansAt >= orphanEveryMs) {
    orphans = await sweepOrphans(env, tenant, { graceMs: opts.orphanGraceMs ?? DEFAULT_ORPHAN_GRACE_MS, maxCompactStepMs: opts.maxCompactStepMs })
    marker.orphansAt = Date.now()
    // Still needed only for what it had to leave for later: young objects, units that may
    // yet be admitted, streams the ledger has not seen. (A name it cannot judge never changes.)
    sweep = orphans.kept.some((k) => k.why !== 'unknown_name')
  }

  // When could time alone make work again?
  const ledger = env.LEDGER.get(env.LEDGER.idFromName(tenant))
  const samples = await ledger.plan({ table: 'metric_samples', minTs: 0, maxTs: Number.MAX_SAFE_INTEGER })
  const series = await ledger.plan({ table: 'metric_series', minTs: 0, maxTs: Number.MAX_SAFE_INTEGER })
  const days = [...samples.files, ...series.files].map((f) => f.day).sort()
  const due: number[] = []
  const more = compaction.more
  const failed = compaction.steps.at(-1)?.status === 'error'
  if (more) due.push(Date.now())
  if (failed) due.push(Date.now() + 10 * 60_000) // a merge the ledger or the row check refused: look again, not in a loop
  if (compaction.nextDueAt !== null) due.push(compaction.nextDueAt)
  // Retention removes whole UTC days: the oldest live day expires at the first midnight at
  // which it is more than `keepDays` days old (janitor's `retentionCutoffDay`), not before.
  // A policy changed in KV is applied by the tenant's next run, whatever causes it; for an
  // idle tenant that is this date, computed with the old policy (stack/README.md, "Idle").
  if (days.length > 0) due.push(Date.parse(`${days[0]}T00:00:00Z`) + (expired.keepDays + 1) * DAY_MS)
  // Tombstones waiting for their grace or for the ledger's log: after the grace at the latest.
  if (purged.waiting > 0) due.push(Date.now() + Math.max(deleteGraceMs, 60_000))
  if (sweep) due.push(marker.orphansAt + orphanEveryMs)

  const nextDueAt = due.length === 0 ? null : Math.min(...due)
  // The marker is written before the run is acknowledged: if this throws, the message is retried.
  if (nextDueAt === null) await env.CONFIG.delete(maintMarkerKey(tenant))
  else await writeMarker(env, tenant, { due: nextDueAt, orphansAt: marker.orphansAt, sweep })
  return { tenant, compaction, expired, purged, orphans, nextDueAt, more }
}

/** The cron's part: enqueue every tenant whose marker is due. One KV list; no Durable Object. */
export async function enqueueDue(env: MaintEnv, now = Date.now()): Promise<{ markers: number; enqueued: string[] }> {
  const enqueued: string[] = []
  let markers = 0
  let cursor: string | undefined
  do {
    const page: KVNamespaceListResult<Partial<MaintMarker>> = await env.CONFIG.list<Partial<MaintMarker>>({ prefix: MAINT_MARKER_PREFIX, cursor })
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
    // One run for the group; it knows a flush wrote objects if any message says so.
    const wrote = opts.wrote === true || messages.some((m) => (m.body as MaintMessage).wrote === true)
    try {
      outcome.report = await (opts.run ?? maintainTenant)(env, engine, tenant, { ...opts, wrote })
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
