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
import { consumeDeadLetters, consumeFlushBatch, engine, sweepPending } from '../../flush/src/index'
import type { FlushMessage } from '../../shard/src/shard'
import { type MaintEnv, type MaintMessage, type MaintOptions, consumeMaintBatch, enqueueDue, noteFlushed } from './maintain'

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
      deadLetter: async (m, reason) => void (await consumeDeadLetters({ queue: batch.queue, messages: [m] } as unknown as MessageBatch<unknown>, env, reason)),
    })
  }
  // Anything else bound to this consumer is a dead-letter queue: record what was given up on.
  else await consumeDeadLetters(batch, env)
}

/** The cron: both sweeps. Each lists KV and touches nothing else unless something is due. */
export async function handleScheduled(env: StackEnv, now = Date.now()) {
  const flush = await sweepPending(env)
  const maintenance = await enqueueDue(env, now)
  return { flush, maintenance }
}

export default {
  fetch: (req, env) => edge.fetch(req, env),
  queue: (batch, env) => handleQueue(batch, env),
  scheduled: async (_controller, env, ctx) => {
    ctx.waitUntil(handleScheduled(env))
  },
} satisfies ExportedHandler<StackEnv>
