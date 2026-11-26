import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { SHARD_NAME } from '../../contracts/ledger'
import { TENANT_ID } from '../../contracts/ledger'
import { dedicatedPool, shardName, signalPool, slotFor, tenantSlots, validBasePool, validPoolName, type PoolMap } from '../src/pool'

const pool: PoolMap = { pool: 'cell-1', slots: 16, spread: 2, epoch: 1 }
const tenants = Array.from({ length: 400 }, (_, i) => `tenant-${i}`)

describe('pool routing', () => {
  it('is deterministic and stays inside the tenant\'s slots', () => {
    for (const t of tenants.slice(0, 50)) {
      const slots = tenantSlots(pool, t)
      expect(slots).toHaveLength(2)
      expect(new Set(slots).size).toBe(2)
      expect(tenantSlots(pool, t)).toEqual(slots)
      for (let k = 0; k < 20; k++) {
        const slot = slotFor(pool, t, `job=api,instance=${k}`)
        expect(slots).toContain(slot)
        expect(slotFor(pool, t, `job=api,instance=${k}`)).toBe(slot)
      }
    }
  })

  it('spreads tenants over the pool so few share their whole slot set', () => {
    const load = new Array(16).fill(0)
    const sets = new Map<string, number>()
    for (const t of tenants) {
      const slots = tenantSlots(pool, t)
      for (const s of slots) load[s]++
      sets.set(slots.join(','), (sets.get(slots.join(',')) ?? 0) + 1)
    }
    // 400 tenants x 2 slots over 16 slots: mean 50 per slot.
    expect(Math.min(...load)).toBeGreaterThan(25)
    expect(Math.max(...load)).toBeLessThan(80)
    // 120 possible pairs; with shuffling, the most popular pair holds a small minority.
    expect(sets.size).toBeGreaterThan(100)
    expect(Math.max(...sets.values())).toBeLessThan(15)
  })

  it('moves few senders when a tenant\'s spread grows', () => {
    const wider = { ...pool, spread: 3, epoch: 2 }
    let moved = 0
    for (let k = 0; k < 1000; k++) if (slotFor(pool, 'tenant-7', `k${k}`) !== slotFor(wider, 'tenant-7', `k${k}`)) moved++
    expect(moved).toBeGreaterThan(200) // about a third move to the new slot
    expect(moved).toBeLessThan(450) // the rest stay where they were
    expect(shardName(pool, 3)).toBe(shardName(wider, 3)) // same object across epochs
  })

  it('treats a dedicated tenant as a pool of its own', () => {
    const d = dedicatedPool('acme', 4, 1)
    expect(tenantSlots(d, 'acme')).toEqual([0, 1, 2, 3])
    expect(shardName(d, 2)).toBe('tenant/acme/2')
    // Tenant ids may contain `_`, pool names may not (contracts/TABLES.md).
    expect(dedicatedPool('acme_eu', 2, 1).pool).toBe('tenant/acme-eu')
    expect(validPoolName(dedicatedPool('acme_eu', 2, 1).pool)).toBe(true)
  })

  it('accepts only pool names whose shards\' key encoding is one-to-one (POOL_NAME: no `_`)', () => {
    for (const ok of ['shared/c1', 'tenant/acme-eu', 'e2e-x1', 'a/b/c', 'x'.repeat(120)]) expect(validPoolName(ok), ok).toBe(true)
    for (const bad of ['', 'a_b', 'shared/c_1', 'a//b', '/a', 'a/', 'a b', 'a.b', 'x'.repeat(121), 7, null]) expect(validPoolName(bad), String(bad)).toBe(false)
    // Every shard of a valid pool has a valid name, up to the largest slot a map may have.
    expect(SHARD_NAME.test(shardName({ pool: 'x'.repeat(120), slots: 4096, spread: 1, epoch: 1 }, 4095))).toBe(true)
  })

  // The one rule for a pool map's pool, read by edge and written by control (D66; review M-5).
  it('a base pool is a valid pool name that does not end in a derived pool\'s suffix (validBasePool)', () => {
    for (const ok of ['shared/c1', 'tenant/acme-eu', 'traces', 'logs', 'p/traces/5', 'a/tracesx', 'a/xlogs', 'a/traces-1', 'a/Logs', 'x'.repeat(120)]) expect(validBasePool(ok), ok).toBe(true)
    for (const bad of ['a/traces', 'a/logs', 'shared/c1/traces', 'tenant/traces', 'tenant/logs', 'a_b', 'shared/c_1', 'tenant/acme_eu', 'x'.repeat(121), '', 'a//b', 7, null]) expect(validBasePool(bad), String(bad)).toBe(false)
    // The derived pools of a valid base pool are what edge and query name its span and log shards; a base pool never is one.
    for (const base of ['shared/c1', 'tenant/acme-eu']) for (const s of ['traces', 'logs'] as const) expect(validBasePool(signalPool({ pool: base, slots: 1, spread: 1, epoch: 0 }, s)!.pool)).toBe(false)
  })

  it('the dedicated pool of every tenant id is a valid base pool, except for the ids traces and logs', () => {
    const ids = ['acme', 'acme_eu', 'acme-eu', '_', '-', 'a__b', 'traces', 'logs', 'Traces', 'my_traces', 'logs_', 'x'.repeat(64), '_'.repeat(64)]
    for (const id of ids) {
      expect(TENANT_ID.test(id), id).toBe(true)
      const { pool: p } = dedicatedPool(id, 4, 0)
      expect(p, id).toBe(`tenant/${id.replaceAll('_', '-')}`)
      expect(validPoolName(p), id).toBe(true)
      expect(validBasePool(p), id).toBe(id !== 'traces' && id !== 'logs')
    }
  })

  it('a shard object addressed by a name outside SHARD_NAME serves nothing', async () => {
    const s = env.SHARD.get(env.SHARD.idFromName(`bad_name-${Date.now().toString(36)}/0`))
    const outcome = await s.describe('t').then(() => 'served', (e: Error) => e.message)
    expect(outcome).toMatch(/SHARD_NAME/)
  })
})
