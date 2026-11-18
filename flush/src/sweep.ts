import { TENANT_ID } from '../../contracts/ledger'
import { type PoolMap, shardName } from '../../shard/src/pool'
import { type FlushMessage, PENDING_MARKER_PREFIX, type Shard } from '../../shard/src/shard'

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
 * `full: true` is the operator's variant for when a marker itself may be missing: it asks
 * EVERY shard named by a pool map in KV (`pool:<tenant>`) and by `DEFAULT_POOL`. That wakes
 * idle shards, so the cron does not use it. Its limit: a shard that only an older version
 * of a map named (the pool was renamed or its slot count reduced) is not found.
 */

export interface SweepEnv {
  SHARD: DurableObjectNamespace<Shard>
  CONFIG: KVNamespace
  FLUSH_QUEUE: Queue<FlushMessage>
  DEFAULT_POOL?: string
}

export interface SweepOptions {
  /** Re-enqueue streams whose oldest pending segment was sealed at least this long ago. Default 10 minutes. */
  olderThanMs?: number
  full?: boolean
}

export interface SweepResult {
  /** Pending markers found in KV. */
  markers: number
  /** Shards asked (each is one Durable Object request). */
  shardsAsked: number
  /** Messages sent to the flush queue. */
  enqueued: FlushMessage[]
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

function slotsOf(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const m = JSON.parse(raw) as PoolMap
    if (typeof m.pool !== 'string' || !Number.isInteger(m.slots) || m.slots < 1 || m.slots > 4096) return []
    return Array.from({ length: m.slots }, (_, slot) => shardName(m, slot))
  } catch {
    return []
  }
}

/** Every shard named by a pool map this deployment can see. */
export async function shardsFromPoolMaps(env: Pick<SweepEnv, 'CONFIG' | 'DEFAULT_POOL'>): Promise<string[]> {
  const names = new Set<string>(slotsOf(env.DEFAULT_POOL))
  for (const key of await listKeys(env.CONFIG, 'pool:')) for (const n of slotsOf(await env.CONFIG.get(key))) names.add(n)
  return [...names].sort()
}

export async function sweepPending(env: SweepEnv, opts: SweepOptions = {}): Promise<SweepResult> {
  const olderThanMs = opts.olderThanMs ?? 10 * 60_000
  const marked = (await listKeys(env.CONFIG, PENDING_MARKER_PREFIX)).map((k) => k.slice(PENDING_MARKER_PREFIX.length))
  const shards = true ? [...new Set([...marked, ...(await shardsFromPoolMaps(env))])].sort() : marked
  const enqueued: FlushMessage[] = []
  for (const shard of shards) {
    if (shard === '') continue
    const pending = await env.SHARD.get(env.SHARD.idFromName(shard)).pendingTenants(olderThanMs)
    for (const p of pending) if (TENANT_ID.test(p.tenant)) enqueued.push({ tenant: p.tenant, shard })
  }
  // sendBatch takes at most 100 messages.
  for (let i = 0; i < enqueued.length; i += 100) await env.FLUSH_QUEUE.sendBatch(enqueued.slice(i, i + 100).map((body) => ({ body })))
  return { markers: marked.length, shardsAsked: shards.length, enqueued }
}
