/**
 * Measurements, not assertions about speed: metadata sizes, R2 operations and commit time
 * for publishes that add 1, 100 and 10,000 files, then two steady-state commits on the
 * 10,000-file table. The ledger logs are written by real Ledger objects. The data objects
 * are not created (so `verify` runs without the per-object check). Results go to
 * `export/bench.json` and into the README.
 *
 * Times are from workerd's clock on this machine with a simulated R2: local, not Cloudflare.
 */
import { describe, expect, inject, it } from 'vitest'
import type { FileEntry } from '../../contracts/ledger'
import type { PublishResult } from '../src/publisher'
import { DAY_MS, INC, SHARD, T0, dayOf, fresh, icebergLive, ledger, liveKeys, manifestList, mirror, publisher } from './helpers'

const sample = (cell: string, tenant: string, seq: number, i: number): FileEntry => {
  const minTs = T0 + (i % 10) * DAY_MS + seq * 60_000
  const day = dayOf(minTs)
  // hash8 is the start of a SHA-256 in real keys: incompressible. A 32-bit mix stands in for it.
  let h = (seq * 0x9e3779b1 + i * 0x85ebca6b + tenant.length * 0xc2b2ae35) >>> 0
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0
  const hash = ((h ^ (h >>> 16)) >>> 0).toString(16).padStart(8, '0')
  return {
    table: 'metric_samples',
    day,
    key: `${cell}/data/metric_samples/tenant=${tenant}/day=${day}/L0-pool_0-${INC}-${seq}-${seq}-${hash}.parquet`,
    bytes: 1_048_576 + (h % 400_000),
    rows: 60_000 + (h % 40_000),
    minTs,
    maxTs: minTs + 59_999,
    level: 0,
    index: JSON.stringify({ v: 1, rg: [{ rows: 100_000, off: 4, len: 1_048_000, min_name: 'container_cpu_usage_seconds_total', max_name: 'up', min_ts: minTs, max_ts: minTs + 59_999 }] }),
  }
}

const row = (name: string, r: PublishResult, wallMs: number) => {
  const t = r.tables.metric_samples
  return {
    case: name,
    added: t.added,
    removed: t.removed,
    manifestsWritten: t.manifestsWritten,
    bytes: t.bytes,
    totalMetadataBytes: t.bytes.manifests + t.bytes.manifestList + t.bytes.cursors + t.bytes.metadata,
    // R2 operations of the whole publish (both tables; the series table had nothing to do).
    r2: r.ops,
    commitMs: t.commitMs,
    publishMs: r.ms,
    wallMs: Math.round(wallMs),
  }
}

describe('measurements', () => {
  it('reports sizes, operations and time for 1, 100 and 10,000 added files', async () => {
    const results: unknown[] = []

    for (const n of [1, 100]) {
      const { cell, tenant } = fresh()
      const a = tenant('a')
      const files = Array.from({ length: n }, (_, i) => sample(cell, a, 1, i))
      expect(await ledger(a).addUnit({ shard: SHARD, incarnation: INC, seqLo: 1, seqHi: 1, files })).toMatchObject({ status: 'ok' })
      await mirror(a, cell)
      const p = publisher(cell)
      const t0 = performance.now()
      const r = await p.publish()
      results.push(row(`${n} added`, r, performance.now() - t0))
      expect(r.tables.metric_samples.added).toBe(n)
      expect((await p.verify('metric_samples', { checkObjects: false })).ok).toBe(true)
    }

    // 10,000 files: 10 tenants, 10 units of 100 files each, over 10 days.
    const { cell, tenant } = fresh()
    const tenants = Array.from({ length: 10 }, (_, i) => tenant(`t${i}`))
    for (const t of tenants) {
      for (let seq = 1; seq <= 10; seq++) {
        const files = Array.from({ length: 100 }, (_, i) => sample(cell, t, seq, i))
        expect(await ledger(t).addUnit({ shard: SHARD, incarnation: INC, seqLo: seq, seqHi: seq, files })).toMatchObject({ status: 'ok' })
      }
      await mirror(t, cell)
    }
    const p = publisher(cell)
    let t0 = performance.now()
    let r = await p.publish()
    results.push(row('10,000 added (10 tenants, 110 ledger changes)', r, performance.now() - t0))
    expect(r.tables.metric_samples.added).toBe(10_000)
    expect((await icebergLive(cell, 'metric_samples')).length).toBe(10_000)
    const v0 = performance.now()
    expect((await p.verify('metric_samples', { checkObjects: false })).ok).toBe(true)
    const verifyMs = Math.round(performance.now() - v0)

    // Steady state on the 10,000-file table: one more file.
    const t = tenants[0]!
    expect(await ledger(t).addUnit({ shard: SHARD, incarnation: INC, seqLo: 11, seqHi: 11, files: [sample(cell, t, 11, 0)] })).toMatchObject({ status: 'ok' })
    await mirror(t, cell)
    t0 = performance.now()
    r = await p.publish([t])
    results.push(row('+1 file on the 10,000-file table', r, performance.now() - t0))

    // A compaction: 100 files of one tenant become one. Rewrites the one manifest that holds them.
    const remove = (await liveKeys(t, 'metric_samples')).filter((k) => !k.includes(`-${INC}-11-11-`)).slice(0, 100)
    expect(await ledger(t).replace({ remove, add: [{ ...sample(cell, t, 12, 0), level: 1 }] })).toMatchObject({ status: 'ok' })
    await mirror(t, cell)
    t0 = performance.now()
    r = await p.publish([t])
    results.push(row('100 removed + 1 added on the 10,000-file table', r, performance.now() - t0))
    expect(r.tables.metric_samples).toMatchObject({ added: 1, removed: 100 })
    expect((await manifestList(cell, 'metric_samples')).length).toBe(3)
    expect((await p.verify('metric_samples', { checkObjects: false })).ok).toBe(true)

    // An idle publish of every tenant in the cell.
    t0 = performance.now()
    r = await p.publish()
    results.push(row('idle (10 tenants, nothing new)', r, performance.now() - t0))
    expect(r.ops.put).toBe(0)

    const res = await fetch(`${inject('exportUrl')}/bench.json`, { method: 'PUT', body: JSON.stringify({ verifyMs10k: verifyMs, results }, null, 1) })
    expect(res.status).toBe(200)
  })
})
