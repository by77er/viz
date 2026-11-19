/**
 * Adversarial review of D55 (not part of the component): a table whose cursor is in the newest
 * incarnation but BELOW the newest checkpoint, while another table of the same tenant has no
 * cursor (so the tenant is re-based from that checkpoint). The cursor table is then planned
 * "from its cursor" over changes that start after the checkpoint.
 */
import { runInDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { DAY_MS, T0, TABLES, addUnit, fresh, icebergLive, ledger, ledgerVersion, liveKeys, mirror, pairUnit, publisher, type LedgerStub } from './helpers'

type Knobs = { checkpointEvery: number; checkpointByLogBytes: boolean; checkpointOneObjectBytes: number; checkpointPartBytes: number }
const knobs = (l: LedgerStub, k: Partial<Knobs>) => runInDurableObject(l, (i: unknown) => void Object.assign(i as object, k))

describe('review D55: cursors of the two tables diverge across a checkpoint', () => {
  for (const format of ['parts', 'one'] as const) {
    it(`a table with a cursor below the newest checkpoint (${format}) does not skip the changes in between`, async () => {
      const { cell, tenant } = fresh()
      const t = tenant(`skip-${format}`)
      const l = ledger(t)
      await l.plan({ table: 'metric_samples', minTs: 0, maxTs: 0 })
      await knobs(l, { checkpointEvery: 1e9, checkpointByLogBytes: false, checkpointOneObjectBytes: format === 'one' ? 1e12 : -1, checkpointPartBytes: 600 })
      for (let i = 1; i <= 3; i++) await addUnit(t, pairUnit(cell, t, i, i, T0 + i * 1000), { drain: true })
      await mirror(t, cell)

      // First publication: metric_samples commits, metric_series fails after writing its manifests
      // (a crash, a CPU limit, an R2 error: anything between the two tables' commits).
      const p = publisher(cell)
      await p.failAt('manifests-written', 'metric_series')
      const first = await p.tryPublish([t])
      expect(first.error).toMatch(/injected/)
      const c1 = await p.cursors('metric_samples')
      expect(c1[t]).toEqual(await ledgerVersion(t))
      expect((await p.cursors('metric_series'))[t]).toBeUndefined()

      // Before the retry, the ledger admits more units and writes a checkpoint above that cursor.
      for (let i = 4; i <= 5; i++) await addUnit(t, pairUnit(cell, t, i, i, T0 + DAY_MS + i * 1000), { drain: true })
      await knobs(l, { checkpointEvery: 1 })
      await addUnit(t, pairUnit(cell, t, 6, 6, T0 + DAY_MS + 6000), { drain: true })
      await knobs(l, { checkpointEvery: 1e9 })
      await addUnit(t, pairUnit(cell, t, 7, 7, T0 + DAY_MS + 7000), { drain: true })
      await mirror(t, cell)

      const r = await p.publish([t])
      console.log(`REVIEW ${format}: ${JSON.stringify(r.tenants[0])}`)
      console.log(`REVIEW ${format}: tables ${JSON.stringify({ s: r.tables.metric_samples, x: r.tables.metric_series })}`)
      const bad: string[] = []
      for (const table of TABLES) {
        const published = (await icebergLive(cell, table)).filter((k) => k.includes(`/tenant=${t}/`))
        const want = await liveKeys(t, table)
        const missing = want.filter((k) => !published.includes(k))
        console.log(`REVIEW ${format}: ${table}: ledger ${want.length}, published ${published.length}, missing ${JSON.stringify(missing.map((k) => k.split('/').pop()))}`)
        bad.push(...missing)
      }
      const v = await p.verify('metric_samples')
      console.log(`REVIEW ${format}: verify(metric_samples) ${JSON.stringify({ ok: v.ok, missingFromIceberg: v.missingFromIceberg.map((k: string) => k.split('/').pop()), problems: v.problems })}`)
      expect(bad).toEqual([])
    })
  }
})
