import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { liveKeys, read } from '../../flush/test/helpers'
import { ledgerOf, sendAll, shardOf, world } from './world'

const until = async (what: string, ok: () => Promise<boolean>, ms = 60_000): Promise<void> => {
  const deadline = Date.now() + ms
  while (!(await ok())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

describe('nobody calls flush', () => {
  it('ingest that seals a segment is flushed and recorded by the queue alone', async () => {
    const w = await world()
    // Small segments: the requests below seal on size, inside `append`.
    for (const s of w.shards) await shardOf(s).configure({ sealBytes: 200 })
    await sendAll(w)
    // No seal, no flush, no drain is called from here on. The real (simulated) queue delivers.
    for (const t of [w.a, w.b]) {
      await until(`${t.name}: files in the ledger`, async () => (await liveKeys(ledgerOf(t))).length >= 4)
      await until(`${t.name}: every sealed segment recorded`, async () => {
        for (const s of w.shards) if ((await shardOf(s).pendingSegments(t.name)).length > 0) return false
        return true
      })
      const r = await read(t.name, w.shards)
      expect(r.canon).toEqual(t.sent.canon())
      expect(r.sampleFiles.length).toBeGreaterThanOrEqual(2)
    }
    // The flush consumer also asked for maintenance: each tenant has a marker.
    await until('maintenance markers', async () => (await env.CONFIG.list({ prefix: 'maint:' })).keys.filter((k) => k.name.endsWith(w.a.name) || k.name.endsWith(w.b.name)).length === 2)
  })
})
