import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { PRECEDENCE_PER_VERSION as P, type FileEntry, type FlushUnit, type LedgerChange, type LiveFile } from '../../contracts/ledger'
import type { Ledger } from '../src/ledger'

/**
 * File precedence (contracts/ledger.ts `LiveFile`): which file wins when two files of one
 * table and day hold the same (series_id, ts). Keys sort as text, so key order is not it.
 */
type Stub = DurableObjectStub<Ledger>
let n = 0
const open = (): { tenant: string; l: Stub } => {
  const tenant = `prec-${n++}`
  return { tenant, l: env.LEDGER.get(env.LEDGER.idFromName(tenant)) }
}
const T0 = Date.UTC(2026, 10, 10, 12)
const dayOf = (ts: number) => new Date(ts).toISOString().slice(0, 10)
const file = (key: string, over: Partial<FileEntry> = {}): FileEntry => {
  const minTs = over.minTs ?? T0
  return { table: 'metric_samples', day: dayOf(minTs), key, bytes: 100, rows: 10, minTs, maxTs: minTs + 999, level: 0, index: '', ...over }
}
/** A flush unit as flush makes it: one samples and one series file, named like flush names them. */
const unit = (shard: string, seqLo: number, seqHi: number, ts = T0): FlushUnit => ({
  shard, incarnation: 900, seqLo, seqHi,
  files: [
    file(`d/metric_samples/L0-${shard}-900-${seqLo}-${seqHi}-aaaaaaaa.parquet`, { minTs: ts }),
    file(`d/metric_series/L0-${shard}-900-${seqLo}-${seqHi}-bbbbbbbb.parquet`, { minTs: ts, table: 'metric_series' }),
  ],
})
const plan = async (l: Stub, table: 'metric_samples' | 'metric_series' = 'metric_samples') => (await l.plan({ table, minTs: 0, maxTs: Number.MAX_SAFE_INTEGER })).files
const versionOf = async (r: Promise<unknown>) => ((await r) as { version: number }).version

describe('file precedence', () => {
  it('a flush file ranks by the version that admitted it, and plan lists files in that order, not in key order', async () => {
    const { l } = open()
    const versions: number[] = []
    for (let s = 1; s <= 12; s++) versions.push(await versionOf(l.addUnit(unit('p_0', s, s))))
    const files = await plan(l)
    // In key order `-10-10-`, `-11-11-` and `-12-12-` sort before `-2-2-`; in the plan they come after it.
    expect(files.map((f) => Number(/-900-(\d+)-/.exec(f.key)![1]))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    expect(files.map((f) => [f.precedenceLow, f.precedence])).toEqual(versions.map((v) => [v * P, v * P]))
    // Both files of a unit share its version; their position in the unit tells them apart.
    const series = await plan(l, 'metric_series')
    expect(series.map((f) => f.precedence)).toEqual(versions.map((v) => v * P + 1))
  })

  it('a replace output covers the range of its inputs of the same table and day; one with no inputs ranks as new', async () => {
    const { l } = open()
    for (let s = 1; s <= 4; s++) await l.addUnit(unit('p_0', s, s))
    const [a, b, c] = await plan(l)
    const [sa, sb, sc] = await plan(l, 'metric_series')
    const r = await l.replace({
      remove: [a!.key, b!.key, c!.key, sa!.key, sb!.key, sc!.key],
      // A precedence the caller sends is ignored.
      add: [{ ...file('d/metric_samples/L1-out', { level: 1 }), precedence: 1, precedenceLow: 1 } as FileEntry, file('d/metric_series/L1-out', { level: 1, table: 'metric_series' }), file('d/metric_samples/L1-other-day', { level: 1, minTs: T0 + 2 * 86_400_000 })],
    })
    expect(r.status).toBe('ok')
    const v = (r as { version: number }).version
    const out = (await plan(l)).find((f) => f.key.endsWith('L1-out'))!
    expect([out.precedenceLow, out.precedence]).toEqual([a!.precedenceLow, c!.precedence])
    const sout = (await plan(l, 'metric_series')).find((f) => f.key.endsWith('L1-out'))!
    expect([sout.precedenceLow, sout.precedence]).toEqual([sa!.precedenceLow, sc!.precedence])
    const other = (await plan(l)).find((f) => f.key.endsWith('L1-other-day'))!
    expect([other.precedenceLow, other.precedence]).toEqual([v * P + 2, v * P + 2])
    // The unmerged fourth unit still ranks above the output: it was written later.
    const files = await plan(l)
    expect(files.map((f) => f.key.split('/').pop())).toEqual(['L1-out', 'L0-p_0-900-4-4-aaaaaaaa.parquet', 'L1-other-day'])
  })

  it('refuses a merge whose range would jump over a file that overlaps it in time, and allows one that does not', async () => {
    const { tenant, l } = open()
    // Two streams, interleaved: p_0 unit 1, p_1 unit 1 (same time), p_0 unit 2, p_1 unit 2 (an hour later).
    await l.addUnit(unit('p_0', 1, 1))
    await l.addUnit(unit('p_1', 1, 1))
    await l.addUnit(unit('p_0', 2, 2))
    await l.addUnit(unit('p_1', 2, 2, T0 + 3_600_000))
    const files = await plan(l)
    const key = (shard: string, s: number, t = 'samples') => `d/metric_${t}/L0-${shard}-900-${s}-${s}-${t === 'samples' ? 'aaaaaaaa' : 'bbbbbbbb'}.parquet`
    const before = files.map((f) => f.key)
    // p_0's two units without p_1's first, which overlaps them in time and ranks between them.
    const jump = await l.replace({ remove: [key('p_0', 1), key('p_0', 2), key('p_0', 1, 'series'), key('p_0', 2, 'series')], add: [file('d/metric_samples/L1-x', { level: 1 }), file('d/metric_series/L1-x', { level: 1, table: 'metric_series' })] })
    expect(jump).toEqual({ status: 'conflict', missing: [], blocking: [key('p_1', 1), key('p_1', 1, 'series')] })
    expect((await plan(l)).map((f) => f.key)).toEqual(before)
    // Including it is fine; so is jumping over p_1's second unit, which ranks between but holds another hour.
    const ok = await l.replace({
      remove: [key('p_0', 1), key('p_1', 1), key('p_0', 2), key('p_0', 1, 'series'), key('p_1', 1, 'series'), key('p_0', 2, 'series')],
      add: [file('d/metric_samples/L1-y', { level: 1 }), file('d/metric_series/L1-y', { level: 1, table: 'metric_series' })],
    })
    expect(ok.status).toBe('ok')
    const changes = await Promise.all((await env.BUCKET.list({ prefix: `${env.CELL}/ledger/tenant=${tenant}/` })).objects.filter((o) => !o.key.endsWith('base.json')).map(async (o) => (await env.BUCKET.get(o.key))!.json<LedgerChange>()))
    const replace = changes.find((c) => c.kind === 'replace')!
    expect(replace.added.every((f: LiveFile) => typeof f.precedence === 'number' && typeof f.precedenceLow === 'number')).toBe(true)
  })

  it('keeps precedence across a rebuild from the log, also from a log written before precedence existed', async () => {
    const { tenant, l } = open()
    for (let s = 1; s <= 11; s++) await l.addUnit(unit('p_0', s, s))
    const [a, b] = await plan(l)
    const [sa, sb] = await plan(l, 'metric_series')
    await l.replace({ remove: [a!.key, b!.key, sa!.key, sb!.key], add: [file('d/metric_samples/L1-z', { level: 1 }), file('d/metric_series/L1-z', { level: 1, table: 'metric_series' })] })
    const want = { samples: await plan(l), series: await plan(l, 'metric_series') }
    // Strip every precedence from the log, as an older ledger would have written it.
    const prefix = `${env.CELL}/ledger/tenant=${tenant}/`
    for (const o of (await env.BUCKET.list({ prefix })).objects) {
      const c = await (await env.BUCKET.get(o.key))!.json<LedgerChange>()
      c.added = c.added.map(({ precedence: _p, precedenceLow: _q, ...f }) => f) as LiveFile[]
      await env.BUCKET.put(o.key, JSON.stringify(c))
    }
    const r = await runInDurableObject(l, async (inst: Ledger, state) => {
      await state.storage.deleteAll()
      return inst.rebuildFromLog()
    })
    expect(r.changesReplayed).toBeGreaterThan(10)
    expect(await plan(l)).toEqual(want.samples)
    expect(await plan(l, 'metric_series')).toEqual(want.series)
  })

  it('refuses a unit with more files than a version has precedence values', async () => {
    const { l } = open()
    const files = Array.from({ length: P + 1 }, (_, i) => file(`k${i}`))
    expect(await l.addUnit({ shard: 'p_0', incarnation: 900, seqLo: 1, seqHi: 1, files })).toMatchObject({ status: 'invalid' })
  })
})
