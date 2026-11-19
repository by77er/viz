/**
 * The write path in one script: senders → edge → Shard → flush → R2 Parquet → Ledger,
 * and everything that keeps it moving without being called:
 *
 *   default export   fetch      the edge Worker (`POST /api/v1/write`, `POST /v1/metrics`, `GET /healthz`)
 *                    queue      the flush queue (a shard's seal → `flushTenant`), the
 *                               maintenance queue (compaction, retention, deletion), and
 *                               both dead-letter queues
 *                    scheduled  hourly: re-enqueue streams whose segments are still pending,
 *                               and tenants whose maintenance is due
 *   Flush            the flush entrypoint (`flushTenant(tenant, shardName)` over RPC)
 *   Shard, Ledger    the Durable Object classes
 *
 * Nothing here adds behaviour of its own beyond `maintain.ts` (the order of the
 * maintenance jobs and their marker): it puts the components behind one set of bindings.
 */
import edge from '../../edge/src/index'
import { type SweepResult, consumeDeadLetters, consumeFlushBatch, engine, sweepPending } from '../../flush/src/index'
import type { FlushMessage } from '../../shard/src/shard'
import { type DueResult, type MaintEnv, type MaintMessage, type MaintOptions, consumeMaintBatch, enqueueDue, noteFlushed } from './maintain'

export { Shard } from '../../shard/src/shard'
export { Ledger } from '../../ledger/src/ledger'
export { Flush, engine, flushTenant } from '../../flush/src/index'
export type { FlushOptions, FlushResult } from '../../flush/src/index'
export * from './maintain'

export interface StackEnv extends MaintEnv {
  SHARD: DurableObjectNamespace<import('../../shard/src/shard').Shard>
  FLUSH_QUEUE: Queue<FlushMessage>
  MAINT_QUEUE: Queue<MaintMessage>
  DEFAULT_POOL?: string
  INGEST_LIMITS?: string
  /** JSON overriding `MaintOptions` (graces, compaction policy). Tests and small deployments. */
  MAINTENANCE?: string
}

export const FLUSH_QUEUE_NAME = 'viz-flush'
export const MAINT_QUEUE_NAME = 'viz-maint'

function maintOptions(env: StackEnv): MaintOptions {
  if (!env.MAINTENANCE) return {}
  try {
    return JSON.parse(env.MAINTENANCE) as MaintOptions
  } catch {
    return {}
  }
}

export async function handleQueue(batch: MessageBatch<unknown>, env: StackEnv): Promise<void> {
  if (batch.queue === FLUSH_QUEUE_NAME) await consumeFlushBatch(batch, env, engine, { onFlushed: (r) => noteFlushed(env, r) })
  else if (batch.queue === MAINT_QUEUE_NAME) {
    await consumeMaintBatch(batch, env, engine, {
      ...maintOptions(env),
      // Junk of one batch in ONE dead-letter object; a failed write retries those messages.
      deadLetter: async (messages, reason) => {
        if ((await consumeDeadLetters({ queue: batch.queue, messages } as unknown as MessageBatch<unknown>, env, reason)) !== messages.length) throw new Error('dead letters not written')
      },
    })
  }
  // Anything else bound to this consumer is a dead-letter queue: record what was given up on.
  else await consumeDeadLetters(batch, env)
}

export interface CronResult {
  /** The flush sweep's result, or null if it failed as a whole (its KV listing threw). */
  flush: SweepResult | null
  /** The maintenance sweep's result, or null if it failed as a whole. */
  maintenance: DueResult | null
  /** Everything that went wrong, one line each: a sweep that failed, a shard that threw, messages not sent, retention records that cannot be read, markers of an unknown version. */
  errors: string[]
}

/**
 * The cron: both sweeps, independently. Each lists KV and touches nothing else unless
 * something is due. One failing shard, listing or send never stops the other sweep, nor the
 * rest of its own (review R-7); what went wrong is logged and returned.
 */
export async function handleScheduled(env: StackEnv, now = Date.now()): Promise<CronResult> {
  const [f, m] = await Promise.allSettled([sweepPending(env, { now }), enqueueDue(env, now)])
  const errors: string[] = []
  const why = (e: unknown) => (e instanceof Error ? e.message : String(e))
  if (f.status === 'rejected') errors.push(`flush sweep failed: ${why(f.reason)}`)
  else {
    for (const x of f.value.failed) errors.push(`flush sweep: shard ${x.shard} failed: ${x.error}`)
    if (f.value.unsent > 0) errors.push(`flush sweep: ${f.value.unsent} messages not sent`)
  }
  if (m.status === 'rejected') errors.push(`maintenance sweep failed: ${why(m.reason)}`)
  else {
    if (m.value.unsent > 0) errors.push(`maintenance sweep: ${m.value.unsent} messages not sent`)
    for (const x of m.value.retentionRefused) errors.push(`retention:${x.tenant} cannot be read (${x.reason}); nothing is expired for this tenant`)
    if (m.value.unsupported.length > 0) errors.push(`maintenance markers of a version this release does not read: ${m.value.unsupported.join(', ')}`)
  }
  for (const e of errors) console.error(`cron: ${e}`)
  return { flush: f.status === 'fulfilled' ? f.value : null, maintenance: m.status === 'fulfilled' ? m.value : null, errors }
}

export default {
  fetch: (req, env) => edge.fetch(req, env),
  queue: (batch, env) => handleQueue(batch, env),
  scheduled: async (_controller, env, ctx) => {
    // Both sweeps have run whatever failed; the invocation is then marked failed, so the
    // problem shows in the cron's history as well as in the log.
    ctx.waitUntil(
      handleScheduled(env).then((r) => {
        if (r.errors.length > 0) throw new Error(`cron: ${r.errors.length} problem(s); first: ${r.errors[0]}`)
      }),
    )
  },
} satisfies ExportedHandler<StackEnv>
