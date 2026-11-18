import type { Engine } from '../../contracts/engine'
import { TENANT_ID } from '../../contracts/ledger'
import type { FlushMessage } from '../../shard/src/shard'
import { type FlushEnv, type FlushResult, flushTenant } from './flush'

/**
 * The flush queue's consumer: `{tenant, shard}` messages (written by a shard when it seals,
 * and by the sweep) become `flushTenant` runs.
 *
 *   - Messages of one batch for the same (tenant, shard) are ONE run: flush handles every
 *     pending segment of the stream, so duplicates and bursts cost nothing.
 *   - At-least-once. A group is acknowledged only when its run ended `ok` with nothing left
 *     to do. Otherwise one message of the group is retried (with a growing delay) and the
 *     others are acknowledged, so a group never multiplies. Flush is idempotent, so a
 *     redelivery after success finds no pending segment and does nothing.
 *   - A message that keeps failing is moved by the queue to the dead-letter queue after
 *     `max_retries`; `consumeDeadLetters` writes each one to R2 where it can be listed.
 *     A message that is not a `{tenant, shard}` at all can never succeed and is written
 *     there at once.
 *
 * Nothing is lost when a message is: the segments stay pending in the shard, the shard
 * keeps its pending marker, and the sweep (src/sweep.ts) enqueues the stream again.
 */

export interface ConsumerOptions {
  /** Called after every run that ended `ok` (the stack uses it to schedule compaction). A throw retries the group. */
  onFlushed?(result: FlushResult): void | Promise<void>
  /** Replaces `flushTenant` (tests inject failures here). */
  flush?(tenant: string, shard: string): Promise<FlushResult>
  /** Where dead letters go. Default: R2, under `{cell}/dead-letters/`. */
  deadLetter?(letter: DeadLetter): Promise<void>
}

export interface GroupOutcome {
  tenant: string
  shard: string
  messages: number
  /** `done`: all acknowledged. `again`: one message retried. */
  action: 'done' | 'again'
  /** Why it is retried: a flush failure reason, `awaiting_log`, `remaining`, or `exception: …`. */
  why?: string
  result?: FlushResult
}

export interface DeadLetter {
  queue: string
  id: string
  attempts: number
  at: number
  reason: string
  body: unknown
}

const isFlushMessage = (b: unknown): b is FlushMessage =>
  typeof b === 'object' && b !== null && typeof (b as FlushMessage).tenant === 'string' && TENANT_ID.test((b as FlushMessage).tenant) &&
  typeof (b as FlushMessage).shard === 'string' && (b as FlushMessage).shard !== ''

/** Delay before a retry: 5 s, doubling per attempt, at most 5 minutes. */
export const retryDelaySeconds = (attempts: number): number => Math.min(300, 5 * 2 ** Math.max(0, attempts - 1))

export const deadLetterPrefix = (cell: string, queue?: string): string => `${cell}/dead-letters/${queue ? `${queue}/` : ''}`

async function writeDeadLetter(env: FlushEnv, letter: DeadLetter): Promise<void> {
  const key = `${deadLetterPrefix(env.CELL || 'cell-0', letter.queue)}${new Date(letter.at).toISOString()}-${letter.id}.json`
  await env.BUCKET.put(key, JSON.stringify(letter), { httpMetadata: { contentType: 'application/json' } })
  console.error(`dead letter on ${letter.queue}: ${letter.reason}`, JSON.stringify(letter.body))
}

export async function consumeFlushBatch(batch: MessageBatch<unknown>, env: FlushEnv, engine: Engine, opts: ConsumerOptions = {}): Promise<GroupOutcome[]> {
  const dead = opts.deadLetter ?? ((l: DeadLetter) => writeDeadLetter(env, l))
  const groups = new Map<string, { msg: FlushMessage; messages: Message<unknown>[] }>()
  for (const m of batch.messages) {
    if (!isFlushMessage(m.body)) {
      // Retrying cannot repair the message. Record it; if even that fails, let the queue retry.
      try {
        await dead({ queue: batch.queue, id: m.id, attempts: m.attempts, at: Date.now(), reason: 'not a {tenant, shard} message', body: m.body })
        m.ack()
      } catch {
        m.retry({ delaySeconds: retryDelaySeconds(m.attempts) })
      }
      continue
    }
    const key = `${m.body.tenant}\u0000${m.body.shard}`
    const g = groups.get(key)
    if (g) g.messages.push(m)
    else groups.set(key, { msg: { tenant: m.body.tenant, shard: m.body.shard }, messages: [m] })
  }

  const out: GroupOutcome[] = []
  for (const { msg, messages } of groups.values()) {
    const outcome: GroupOutcome = { tenant: msg.tenant, shard: msg.shard, messages: messages.length, action: 'done' }
    try {
      const result = await (opts.flush ? opts.flush(msg.tenant, msg.shard) : flushTenant(env, engine, msg.tenant, msg.shard))
      outcome.result = result
      if (result.status !== 'ok') outcome.why = result.reason ?? 'error'
      // Admitted but the ledger's log has not caught up, so the shard was not told: run again.
      else if (result.awaitingLog) outcome.why = 'awaiting_log'
      else if (result.remaining > 0) outcome.why = 'remaining'
      if (result.status === 'ok') await opts.onFlushed?.(result)
    } catch (e) {
      outcome.why = `exception: ${e instanceof Error ? e.message : String(e)}`
    }
    if (outcome.why !== undefined) outcome.action = 'again'
    // One message carries the retry; the rest of the group would only repeat it.
    const carrier = outcome.action === 'again' ? messages.reduce((a, b) => (b.attempts < a.attempts ? b : a)) : null
    for (const m of messages) {
      if (m === carrier) m.retry({ delaySeconds: retryDelaySeconds(m.attempts) })
      else m.ack()
    }
    out.push(outcome)
  }
  return out
}

/**
 * Consumer of a dead-letter queue: every message becomes one JSON object in R2 and an error
 * log line, then is acknowledged. If the write fails the message is retried, not dropped.
 */
export async function consumeDeadLetters(batch: MessageBatch<unknown>, env: FlushEnv, reason = 'retries exhausted'): Promise<number> {
  let written = 0
  for (const m of batch.messages) {
    try {
      await writeDeadLetter(env, { queue: batch.queue, id: m.id, attempts: m.attempts, at: Date.now(), reason, body: m.body })
      m.ack()
      written++
    } catch {
      m.retry({ delaySeconds: 60 })
    }
  }
  return written
}

/** Dead letters recorded so far, oldest first within a queue. For operators and tests. */
export async function listDeadLetters(env: FlushEnv, queue?: string): Promise<DeadLetter[]> {
  const out: DeadLetter[] = []
  let cursor: string | undefined
  do {
    const page = await env.BUCKET.list({ prefix: deadLetterPrefix(env.CELL || 'cell-0', queue), cursor })
    for (const o of page.objects) {
      const body = await env.BUCKET.get(o.key)
      if (body) out.push(await body.json<DeadLetter>())
    }
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
  return out
}
