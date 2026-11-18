/**
 * Which ruler shard holds which rule group.
 *
 * The assignment is a pure function of (the tenant's groups and their sizes, the shard
 * count already in use, the limits): every caller computes the same answer, and nothing
 * but the shard count is stored (in the registry, where it only ever grows).
 *
 *   shard(group) = jump_consistent_hash(hash(group name), N)
 *   N            = the smallest count >= the current one for which no shard holds more
 *                  than `maxRulesPerShard` rules or `maxGroupsPerShard` groups
 *
 * A group is one unit: it is never split. Jump hashing has the property that going from N
 * to N+1 shards moves only groups that land on the new shard, so a split touches about
 * 1/(N+1) of the groups and never shuffles the rest.
 */
import type { ValidationError } from '../contracts-proposal/rules.v2'
import { hash64 } from './util'

export interface GroupSize {
  name: string
  rules: number
}

export interface PlacementLimits {
  maxRulesPerShard: number
  maxGroupsPerShard: number
  maxShards: number
}

export const DEFAULT_PLACEMENT: PlacementLimits = { maxRulesPerShard: 1000, maxGroupsPerShard: 64, maxShards: 64 }

const MASK = (1n << 64n) - 1n

/** Lamping and Veach, "A Fast, Minimal Memory, Consistent Hash Algorithm" (2014). */
export function jumpHash(key: string, buckets: number): number {
  let k = BigInt(`0x${hash64(key)}`)
  let b = -1
  let j = 0
  while (j < buckets) {
    b = j
    k = (k * 2862933555777941757n + 1n) & MASK
    j = Math.floor((b + 1) * (2 ** 31 / (Number(k >> 33n) + 1)))
  }
  return b
}

export const shardOf = (group: string, shards: number): number => jumpHash(`viz-rule-group\n${group}`, shards)

export type Assignment = { ok: true; shards: number; placement: Map<string, number> } | { ok: false; error: ValidationError }

export function assign(groups: GroupSize[], currentShards: number, limits: PlacementLimits = DEFAULT_PLACEMENT): Assignment {
  const tooBig = groups.find((g) => g.rules > limits.maxRulesPerShard)
  if (tooBig) {
    return { ok: false, error: { path: 'groups', message: `group "${tooBig.name}" has ${tooBig.rules} rules; a rule shard holds ${limits.maxRulesPerShard}, and a group is never split across shards`, fix: 'Split the group.' } }
  }
  for (let n = Math.max(1, currentShards); n <= limits.maxShards; n++) {
    const rules = new Array<number>(n).fill(0)
    const count = new Array<number>(n).fill(0)
    const placement = new Map<string, number>()
    for (const g of groups) {
      const s = shardOf(g.name, n)
      placement.set(g.name, s)
      rules[s] = (rules[s] as number) + g.rules
      count[s] = (count[s] as number) + 1
    }
    if (rules.every((r) => r <= limits.maxRulesPerShard) && count.every((c) => c <= limits.maxGroupsPerShard)) return { ok: true, shards: n, placement }
  }
  const total = groups.reduce((n, g) => n + g.rules, 0)
  return { ok: false, error: { path: 'groups', message: `${total} rules in ${groups.length} groups do not fit in ${limits.maxShards} rule shards`, fix: 'Delete unused groups or rules, or ask for a higher shard limit.' } }
}
