/**
 * Shard pools and routing.
 *
 * A pool is a fixed set of shard objects ("slots"). Each tenant is given a small subset of
 * the pool (its `spread`), chosen by rendezvous hashing so that two tenants rarely share
 * their whole subset: a tenant that overloads its slots affects only the few tenants that
 * overlap with it, and none completely. A dedicated tenant is simply a pool of its own.
 *
 * Everything here is a pure function of the map, so `edge` Workers can route without
 * coordination, and a map change is a new `epoch` that shards fence on.
 */
export interface PoolMap {
  /** Pool name. Shared pools are named for the cell; a dedicated pool for its tenant. */
  pool: string
  /** Number of shard objects in the pool. */
  slots: number
  /** How many of those slots one tenant may use. `spread === slots` means no shuffling. */
  spread: number
  /** Bumped by the ledger on every change. Shards reject writes carrying an older epoch. */
  epoch: number
}

/** 32-bit FNV-1a followed by a murmur finaliser; fast, synchronous, well mixed. */
export function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}

/** The slots a tenant may write to: the `spread` highest-scoring slots for that tenant. */
export function tenantSlots(map: PoolMap, tenant: string): number[] {
  if (map.spread >= map.slots) return Array.from({ length: map.slots }, (_, i) => i)
  const scored = Array.from({ length: map.slots }, (_, slot) => ({ slot, score: hash32(`${tenant}\u0000${slot}`) }))
  scored.sort((a, b) => b.score - a.score || a.slot - b.slot)
  return scored.slice(0, map.spread).map((s) => s.slot).sort((a, b) => a - b)
}

/**
 * The slot for one sender. `routingKey` is the sender-stable key (resource fingerprint).
 * Rendezvous hashing over the tenant's slots, so growing `spread` moves few keys.
 */
export function slotFor(map: PoolMap, tenant: string, routingKey: string): number {
  let best = -1
  let bestScore = -1
  for (const slot of tenantSlots(map, tenant)) {
    const score = hash32(`${tenant}\u0000${routingKey}\u0000${slot}`)
    if (score > bestScore) {
      bestScore = score
      best = slot
    }
  }
  return best
}

/** Durable Object name for a slot. The epoch is not part of it: the object outlives map changes. */
export const shardName = (map: PoolMap, slot: number): string => `${map.pool}/${slot}`

/** A pool holding exactly one tenant. Dedicated and pooled tenants share every code path. */
export const dedicatedPool = (tenant: string, slots: number, epoch: number): PoolMap => ({
  pool: `tenant/${tenant}`,
  slots,
  spread: slots,
  epoch,
})
