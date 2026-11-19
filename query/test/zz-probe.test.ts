import { it } from 'vitest'
import { discardAll, flushAll, ingest, sealAll, shardOf, world } from './world'

it('probe: flush and discard', async () => {
  const w = await world()
  await ingest(w)
  await sealAll(w)
  await flushAll(w)
  await discardAll(w)
  const out: unknown[] = []
  for (const s of w.shards) { const d = await shardOf(s).describe(w.a.name); out.push([s, d?.recordedThrough, d?.discardedThrough]) }
  throw new Error(`PROBE ${JSON.stringify(out)}`)
})
