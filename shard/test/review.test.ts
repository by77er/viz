import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { type Shard, pendingMarkerKey } from '../src/shard'

// Review (design/reviews/write-path-completion.md, R-6). `pendingTenants` deletes the KV pending
// marker, notices that a seal happened during the delete, and puts the marker back. If that
// put fails (KV allows about one write per second per key, and this is the second write to
// the key within one round trip), the exception leaves `marked = true` with no marker in KV.
// The shard never writes the marker again, and its alarm does not retry it: the hourly sweep
// can no longer find this shard.
describe('review: pending marker after a failed re-put', () => {
  it('a shard with a pending segment keeps (or retries) its KV marker', async () => {
    const name = `rv-mark-${Date.now().toString(36)}/0`
    const stub = env.SHARD.get(env.SHARD.idFromName(name))
    const key = pendingMarkerKey(name)
    await runInDurableObject(stub, async (inst: Shard) => {
      const real = env.CONFIG
      let onDelete: (() => Promise<void>) | null = null
      let failPut = false
      const kv = {
        get: real.get.bind(real),
        list: real.list.bind(real),
        put: async (k: string, v: string) => {
          if (failPut) throw new Error('injected: KV 429, one write per second per key')
          return real.put(k, v)
        },
        delete: async (k: string) => {
          await real.delete(k)
          const h = onDelete
          onDelete = null
          if (h) await h()
        },
      }
      ;(inst as unknown as { env: unknown }).env = { CONFIG: kv }
      const put = (tenant: string, fp: string) => inst.append({ tenant, epoch: 1, fingerprint: fp, payload: new Uint8Array(64).fill(1), rows: 1 })

      // Tenant a seals; the marker is written. Its ledger records the segment.
      const a = await put('a', 'a1')
      if (a.status !== 'ok') throw new Error(a.status)
      await inst.seal('a')
      expect(await real.get(key)).not.toBeNull()
      expect(await inst.recorded('a', a.incarnation, a.seq)).toMatchObject({ status: 'ok' })

      // The sweep asks; nothing is pending, so the shard deletes its marker. During the
      // delete, tenant b seals. The shard then re-puts the marker, and that put fails.
      onDelete = async () => {
        await put('b', 'b1')
        await inst.seal('b')
        failPut = true
      }
      await expect(inst.pendingTenants(0)).rejects.toThrow('injected')
      failPut = false
      expect(await inst.pendingSegments('b')).toHaveLength(1)

      // From here on KV works again. The shard has a pending segment; more seals follow.
      await put('b', 'b2')
      await inst.seal('b')
    })
    await runDurableObjectAlarm(stub)
    // The marker must be back (or a retry scheduled) while a segment is pending.
    const marked = await runInDurableObject(stub, (i) => (i as unknown as { marked: boolean }).marked)
    expect(marked).toBe(true) // the shard believes the marker is there...
    expect(await stub.pendingSegments('b')).toHaveLength(2)
    expect(await env.CONFIG.get(key)).not.toBeNull() // ...and it is not: the sweep cannot find b's segments
  })
})
