import { TENANT_ID } from '../../contracts/ledger'
import type { FlushMessage } from '../../shard/src/shard'
import { type FlushEngine, type FlushEnv, type FlushResult, flushTenant } from './flush'

/**
 * The flush queue's consumer: `{v, tenant, shard}` messages (written by a shard when it seals,
 * and by the sweep) become `flushTenant` runs.
 *
 *   - Messages of one batch for the same (tenant, shard) are ONE run: flush handles every
 *     pending segment of the stream, so duplicates and bursts cost nothing.
 *   - At-least-once. A group is acknowledged only when its run ended `ok` with nothing left
 *     to do. Otherwise one message of the group is retried (with a growing delay) and the
 *     others are acknowledged, so a group never multiplies. Flush is idempotent, so a
 *     redelivery after success finds no pending segment and does nothing.
 *   - Versions (contracts/COMPATIBILITY.md §3.2): `v` absent means 1. A message of a version
 *     this code does not know is retried, never flushed on a guess and never dead-lettered
 *     (a newer release wrote it; one that reads it will be running again).
 *   - A message that keeps failing is moved by the queue to the dead-letter queue after
 *     `max_retries`; `consumeDeadLetters` writes the batch to R2 as ONE object where it can
 *     be listed. A version-1 message that is not a `{tenant, shard}` at all can never succeed
 *     and is written there at once.
 *
 * Nothing is lost when a message is: the segments stay pending in the shard, the shard
 * keeps its pending marker, and the sweep (src/sweep.ts) enqueues the stream again.
 */

/** Version of the flush message this code writes and reads (format `queue.flush`, src/formats.ts). */
export const FLUSH_MESSAGE_VERSION = 1

/**
 * A flush message as it travels: the shard's `FlushMessage` plus its format version.
 * (`v` belongs in `FlushMessage` itself, in shard/src/shard.ts; see the README, "Contract issues".)
 */
export type VersionedFlushMessage = FlushMessage & { v?: number }

export interface ConsumerOptions {
  /**
   * Called after a run that changed something (`FlushResult.changed`), whatever its status,
   * and after any run of a redelivered group (an earlier delivery may have changed things and
   * failed before this was called). The stack uses it to ask for maintenance. A throw retries
   * the group.
   */
  onFlushed?(result: FlushResult): void | Promise<void>
  /** Replaces `flushTenant` (tests inject failures here). */
  flush?(tenant: string, shard: string): Promise<FlushResult>
  /** Where dead letters go, one call per batch. Default: ONE object in R2, under `{cell}/dead-letters/`. */
  deadLetter?(letters: DeadLetter[]): Promise<void>
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

/**
 * Version of the dead-letter OBJECT (format `r2.dead-letters`, src/formats.ts). Version 1,
 * written before review R-12, was one `DeadLetter` per object with no `v`; version 2 is
 * `{"v":2,"letters":[DeadLetter, …]}`, one object per consumer invocation.
 */
export const DEAD_LETTER_OBJECT_VERSION = 2

/** The version a message says it is: 1 if it says nothing, null if it is not an object (junk in every version). */
const versionOf = (b: unknown): unknown => (typeof b === 'object' && b !== null && !Array.isArray(b) ? ((b as { v?: unknown }).v ?? 1) : null)

const isFlushMessage = (b: unknown): b is VersionedFlushMessage =>
  typeof b === 'object' && b !== null && typeof (b as FlushMessage).tenant === 'string' && TENANT_ID.test((b as FlushMessage).tenant) &&
  typeof (b as FlushMessage).shard === 'string' && (b as FlushMessage).shard !== ''

/** Delay before a retry: 5 s, doubling per attempt, at most 5 minutes. */
export const retryDelaySeconds = (attempts: number): number => Math.min(300, 5 * 2 ** Math.max(0, attempts - 1))

export const deadLetterPrefix = (cell: string, queue?: string): string => `${cell}/dead-letters/${queue ? `${queue}/` : ''}`

/** ONE R2 object for every letter of one invocation (AGENTS.md: never one PUT per item in a loop). */
export async function writeDeadLetters(env: Pick<FlushEnv, 'BUCKET' | 'CELL'>, letters: DeadLetter[]): Promise<void> {
  if (letters.length === 0) return
  const first = letters[0]!
  const key = `${deadLetterPrefix(env.CELL || 'cell-0', first.queue)}${new Date(first.at).toISOString()}-${first.id}.json`
  await env.BUCKET.put(key, JSON.stringify({ v: DEAD_LETTER_OBJECT_VERSION, letters }), { httpMetadata: { contentType: 'application/json' } })
  for (const l of letters) console.error(`dead letter on ${l.queue}: ${l.reason}`, JSON.stringify(l.body))
}

export async function consumeFlushBatch(batch: MessageBatch<unknown>, env: FlushEnv, engine: FlushEngine, opts: ConsumerOptions = {}): Promise<GroupOutcome[]> {
  const dead = opts.deadLetter ?? ((l: DeadLetter[]) => writeDeadLetters(env, l))
  const groups = new Map<string, { msg: FlushMessage; messages: Message<unknown>[] }>()
  const junk: Message<unknown>[] = []
  for (const m of batch.messages) {
    const v = versionOf(m.body)
    if (v !== null && v !== FLUSH_MESSAGE_VERSION) {
      // Written by a release this one does not know: retry; never guess, never dead-letter.
      m.retry({ delaySeconds: retryDelaySeconds(m.attempts) })
      continue
    }
    if (!isFlushMessage(m.body)) {
      junk.push(m)
      continue
    }
    const key = `${m.body.tenant}\u0000${m.body.shard}`
    const g = groups.get(key)
    if (g) g.messages.push(m)
    else groups.set(key, { msg: { tenant: m.body.tenant, shard: m.body.shard }, messages: [m] })
  }
  if (junk.length > 0) {
    // Retrying cannot repair them. Record them, all in one write; if that fails, let the queue retry.
    const at = Date.now()
    try {
      await dead(junk.map((m) => ({ queue: batch.queue, id: m.id, attempts: m.attempts, at, reason: 'not a {tenant, shard} message', body: m.body })))
      for (const m of junk) m.ack()
    } catch {
      for (const m of junk) m.retry({ delaySeconds: retryDelaySeconds(m.attempts) })
    }
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
      // Maintenance only when this run changed something, or when an earlier delivery of the
      // group may have and then failed (possibly in this very call): review R-11(b).
      if (result.changed || messages.some((m) => m.attempts > 1)) await opts.onFlushed?.(result)
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
 * Consumer of a dead-letter queue: the batch becomes ONE JSON object in R2 and an error log
 * line per message, then every message is acknowledged. If the write fails, every message is
 * retried, none dropped (review R-12: one PUT per invocation, never one per message).
 */
export async function consumeDeadLetters(batch: MessageBatch<unknown>, env: Pick<FlushEnv, 'BUCKET' | 'CELL'>, reason = 'retries exhausted'): Promise<number> {
  const at = Date.now()
  try {
    await writeDeadLetters(env, batch.messages.map((m) => ({ queue: batch.queue, id: m.id, attempts: m.attempts, at, reason, body: m.body })))
  } catch {
    for (const m of batch.messages) m.retry({ delaySeconds: 60 })
    return 0
  }
  for (const m of batch.messages) m.ack()
  return batch.messages.length
}

/**
 * Dead letters recorded so far, oldest object first within a queue. For operators and tests.
 * Reads both object versions; an object of a version it does not know is refused, by name,
 * never skipped (contracts/COMPATIBILITY.md §3.2).
 */
export async function listDeadLetters(env: Pick<FlushEnv, 'BUCKET' | 'CELL'>, queue?: string): Promise<DeadLetter[]> {
  const out: DeadLetter[] = []
  let cursor: string | undefined
  do {
    const page = await env.BUCKET.list({ prefix: deadLetterPrefix(env.CELL || 'cell-0', queue), cursor })
    for (const o of page.objects) {
      const body = await env.BUCKET.get(o.key)
      if (!body) continue
      const rec = await body.json<DeadLetter | { v: number; letters: DeadLetter[] }>()
      const v = (rec as { v?: unknown }).v ?? 1
      if (v === 1) out.push(rec as DeadLetter)
      else if (v === DEAD_LETTER_OBJECT_VERSION && Array.isArray((rec as { letters?: unknown }).letters)) out.push(...(rec as { letters: DeadLetter[] }).letters)
      else throw new Error(`dead letters: ${o.key} is version ${JSON.stringify(v)}; this code reads 1 and ${DEAD_LETTER_OBJECT_VERSION}`)
    }
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
  return out
}
