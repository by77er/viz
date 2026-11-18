/**
 * The write path for a STAGED deployment only (`deploy/configure.mjs --stage <name>`).
 *
 * stack/src/index.ts routes queue batches by comparing `batch.queue` with the literal
 * production names `viz-flush` and `viz-maint` (FLUSH_QUEUE_NAME, MAINT_QUEUE_NAME); any
 * other queue is treated as a dead-letter queue. A stage's queues are `viz-<stage>-flush`
 * and so on, so without this wrapper every flush message would be written off as a dead
 * letter. This wrapper gives the stack the batch under its production queue name and changes
 * nothing else: same messages, same acknowledgement calls, same exports. Production deploys
 * stack/src/index.ts directly. Recorded under "Needed changes" in deploy/README.md.
 */
import stack, { type StackEnv } from '../../stack/src/index'

export * from '../../stack/src/index'

interface StageEnv extends StackEnv {
  /** `viz-<stage>-`, set by configure.mjs. */
  VIZ_STAGE_PREFIX?: string
}

export function productionQueueName(queue: string, prefix: string | undefined): string {
  return prefix && queue.startsWith(prefix) ? `viz-${queue.slice(prefix.length)}` : queue
}

function asProduction(batch: MessageBatch<unknown>, env: StageEnv): MessageBatch<unknown> {
  return {
    queue: productionQueueName(batch.queue, env.VIZ_STAGE_PREFIX),
    messages: batch.messages,
    metadata: (batch as { metadata?: unknown }).metadata,
    ackAll: () => batch.ackAll(),
    retryAll: (options?: QueueRetryOptions) => batch.retryAll(options),
  } as MessageBatch<unknown>
}

export default {
  fetch: (req, env) => stack.fetch(req, env),
  scheduled: (controller, env, ctx) => stack.scheduled(controller, env, ctx),
  queue: (batch, env) => stack.queue(asProduction(batch, env), env),
} satisfies ExportedHandler<StageEnv>
