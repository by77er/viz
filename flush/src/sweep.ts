import { TENANT_ID } from '../../contracts/ledger'
import { type PoolMap, enabledSignals, shardName, signalPool } from '../../shard/src/pool'
import { type FlushMessage, PENDING_MARKER_PREFIX, type Shard } from '../../shard/src/shard'
import { FLUSH_MESSAGE_VERSION, type VersionedFlushMessage } from './consumer'

/**
 * The sweep: the safety net under the seal notification. It re-enqueues every stream whose
 * sealed segments have been pending longer than `olderThanMs` (a message was lost, or
 * flush kept failing and its message was dead-lettered).
 *
 * It must cost nothing when there is nothing to do, so it does not ask shards whether they
 * have work: it lists the `flush-pending:<shard>` keys in KV, which a shard writes at its
 * first seal and removes when the sweep asks and nothing is pending (shard/src/shard.ts).
 * No key, no Durable Object is woken and no message is sent.
 *
 * One shard that fails does not stop the others, at most `maxShards` shards are asked per
 * sweep (rotating hour by hour), and what was found is sent even if a later shard fails
 * (review R-7).
 *
 * `full: true` is the operator's variant for when a marker itself may be missing: it asks
 * EVERY shard named by a pool map in KV (`pool:<tenant>`) and by `DEFAULT_POOL`, and the shards
 * of the derived pools `{pool}/traces` and `{pool}/logs` (contracts/BATCH.md, "Streams per
 * signal") for each signal `INGEST_SIGNALS` enables. That wakes idle shards, so the cron does
 * not use it. Its limits: a shard that only an older version of a map named (the pool was
 * renamed or its slot count reduced) is not found, nor a derived pool's shard once its signal
 * is no longer enabled. The cron's sweep finds every shard by its marker, derived pools
 * included (a shard of `{pool}/traces` writes `flush-pending:{pool}/traces/{slot}`).
 */

export interface SweepEnv {
  SHARD: DurableObjectNamespace<Shard>
  CONFIG: KVNamespace
  FLUSH_QUEUE: Queue<FlushMessage>
  DEFAULT_POOL?: string
  /** The signals edge appends besides metrics (edge/src/index.ts): their derived pools are swept by `full`. */
  INGEST_SIGNALS?: string
}

/**
 * Shards asked per sweep (one cron invocation). Designed for Cloudflare's documented limit of
 * 10,000 subrequests per invocation on the Paid plan (50 on Free), where a subrequest is any
 * request "to Cloudflare services like R2, KV, or D1"
 * (https://developers.cloudflare.com/workers/platform/limits/, read 2026-11-18). The page does
 * not say whether a Durable Object call counts; this assumes it does. One cron then spends at
 * most 500 shard calls + one KV list per 1,000 markers + one `sendBatch` per 100 streams found
 * + the maintenance sweep's list pages and sends (stack/src/maintain.ts `enqueueDue`): about
 * 1,000 in a large deployment, a tenth of the limit, and under the 1,000 the Paid plan allowed
 * until 2025. Shards beyond it wait for a later cron (see `rotation`).
 */
export const DEFAULT_MAX_SHARDS_PER_SWEEP = 500
/** Shard calls in flight at once: the six-connection budget of one invocation (AGENTS.md). */
const PARALLEL = 6
const HOUR_MS = 3_600_000

export interface SweepOptions {
  /** Re-enqueue streams whose oldest pending segment was sealed at least this long ago. Default 10 minutes. */
  olderThanMs?: number
  full?: boolean
  /** Shards asked by this sweep at most. Default `DEFAULT_MAX_SHARDS_PER_SWEEP`. */
  maxShards?: number
  /** The cron's clock: which window of the marked shards this sweep asks (see `rotation`). */
  now?: number
}

export interface SweepResult {
  /** Pending markers found in KV. */
  markers: number
  /** Shards asked (each is one Durable Object request). */
  shardsAsked: number
  /** Shards to ask that were left for a later sweep by `maxShards`. */
  deferred: number
  /** Messages sent to the flush queue. */
  enqueued: VersionedFlushMessage[]
  /** Shards whose answer was an exception. The others were still asked and their streams sent (review R-7). */
  failed: { shard: string; error: string }[]
  /** Messages found but not sent because their `sendBatch` failed. */
  unsent: number
}

async function listKeys(kv: KVNamespace, prefix: string): Promise<string[]> {
  const out: string[] = []
  let cursor: string | undefined
  do {
    const page: KVNamespaceListResult<unknown> = await kv.list({ prefix, cursor })
    for (const k of page.keys) out.push(k.name)
    cursor = page.list_complete ? undefined : page.cursor
  } while (cursor)
  return out
}

function slotsOf(raw: string | null | undefined, signals: readonly ('traces' | 'logs')[]): string[] {
  if (!raw) return []
  try {
    const m = JSON.parse(raw) as PoolMap
    if (typeof m.pool !== 'string' || !Number.isInteger(m.slots) || m.slots < 1 || m.slots > 4096) return []
    const maps = [m, ...signals.map((s) => signalPool(m, s)).filter((x): x is PoolMap => x !== null)]
    return maps.flatMap((p) => Array.from({ length: p.slots }, (_, slot) => shardName(p, slot)))
  } catch {
    return []
  }
}

/** Every shard named by a pool map this deployment can see, with its derived pools' for the enabled signals. */
export async function shardsFromPoolMaps(env: Pick<SweepEnv, 'CONFIG' | 'DEFAULT_POOL' | 'INGEST_SIGNALS'>): Promise<string[]> {
  const signals = enabledSignals(env.INGEST_SIGNALS)
  const names = new Set<string>(slotsOf(env.DEFAULT_POOL, signals))
  for (const key of await listKeys(env.CONFIG, 'pool:')) for (const n of slotsOf(await env.CONFIG.get(key), signals)) names.add(n)
  return [...names].sort()
}

/**
 * The shards one sweep asks when there are more than `max`: a window of `max` consecutive
 * names (sorted, wrapping around), moved on by `max` each hour. Successive hourly crons
 * therefore cover every marked shard within ceil(n / max) hours, with no state kept anywhere.
 */
export function rotation(shards: readonly string[], max: number, now: number): string[] {
  if (shards.length <= max) return [...shards]
  const start = (Math.floor(now / HOUR_MS) * max) % shards.length
  return Array.from({ length: max }, (_, i) => shards[(start + i) % shards.length]!)
}

export async function sweepPending(env: SweepEnv, opts: SweepOptions = {}): Promise<SweepResult> {
  const olderThanMs = opts.olderThanMs ?? 10 * 60_000
  const max = Math.max(1, opts.maxShards ?? DEFAULT_MAX_SHARDS_PER_SWEEP)
  const marked = (await listKeys(env.CONFIG, PENDING_MARKER_PREFIX)).map((k) => k.slice(PENDING_MARKER_PREFIX.length)).filter((s) => s !== '')
  const all = opts.full ? [...new Set([...marked, ...(await shardsFromPoolMaps(env))])].sort() : [...marked].sort()
  const shards = rotation(all, max, opts.now ?? Date.now())
  const out: SweepResult = { markers: marked.length, shardsAsked: shards.length, deferred: all.length - shards.length, enqueued: [], failed: [], unsent: 0 }

  // Found messages go out in batches of 100 (sendBatch's limit) as soon as there are enough,
  // so a sweep that is cut short has sent what it found; a failed send loses only its batch,
  // which the next sweep finds again (the segments are still pending).
  let pending: VersionedFlushMessage[] = []
  const send = async (all: boolean) => {
    while (pending.length >= 100 || (all && pending.length > 0)) {
      const batch = pending.slice(0, 100)
      pending = pending.slice(100)
      try {
        await env.FLUSH_QUEUE.sendBatch(batch.map((body) => ({ body })))
        out.enqueued.push(...batch)
      } catch (e) {
        out.unsent += batch.length
        console.error(`flush sweep: ${batch.length} messages not sent: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }
  // One shard that throws (a reset object, an old schema, a lost marker write) is reported and
  // skipped; every other shard is still asked (review R-7).
  for (let i = 0; i < shards.length; i += PARALLEL) {
    const group = shards.slice(i, i + PARALLEL)
    const answers = await Promise.allSettled(group.map((shard) => env.SHARD.get(env.SHARD.idFromName(shard)).pendingTenants(olderThanMs)))
    answers.forEach((a, j) => {
      const shard = group[j]!
      if (a.status === 'rejected') {
        const error = a.reason instanceof Error ? a.reason.message : String(a.reason)
        out.failed.push({ shard, error })
        console.error(`flush sweep: shard ${shard} failed: ${error}`)
        return
      }
      for (const p of a.value) if (TENANT_ID.test(p.tenant)) pending.push({ v: FLUSH_MESSAGE_VERSION, tenant: p.tenant, shard })
    })
    await send(false)
  }
  await send(true)
  return out
}
