/**
 * The janitor writes no format (src/formats.ts). It is a READER of two, and reads each
 * writer's golden files here, every version it claims to read (contracts/COMPATIBILITY.md §8.6,
 * §8.7): the retention record control writes, and the inputs record compact writes. A version
 * it does not read is refused the way §3.2 says: expire nothing; never delete the object.
 */
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { COMPACTION_INPUTS_META, compactedKey, decodeCompactionInputs, inputsHash16 } from '../../compact/src/compact'
import { READS } from '../src/formats'
import { parseRetention, sweepOrphans } from '../src/index'

const writers = import.meta.glob(['../../control/test/golden/formats/kv.settings.v*.json', '../../compact/test/golden/formats/r2.compaction-inputs.v*.json'], { eager: true, import: 'default' })
const golden = (format: keyof typeof READS, v: number) => {
  const dir = format === 'kv.settings' ? 'control' : 'compact'
  const g = writers[`../../${dir}/test/golden/formats/${format}.v${v}.json`]
  if (g === undefined) throw new Error(`no golden file of ${format} v${v} in ${dir}/`)
  return g as Record<string, unknown>
}

describe('golden formats this component reads', () => {
  it('kv.settings: every version read, from control\'s golden files', () => {
    for (const v of READS['kv.settings']) {
      const g = golden('kv.settings', v) as { retention: string }
      expect(parseRetention(g.retention)).toMatchObject({ status: 'ok', source: 'record' })
    }
    expect(parseRetention(JSON.stringify({ v: Math.max(...READS['kv.settings']) + 1, metric_samples_days: 30 }))).toMatchObject({ status: 'unreadable' })
  })

  it('r2.compaction-inputs: every version read, from compact\'s golden files; a newer one keeps the object', async () => {
    for (const v of READS['r2.compaction-inputs']) {
      const g = golden('r2.compaction-inputs', v) as { record: string; metadataKey: string }
      expect(g.metadataKey).toBe(COMPACTION_INPUTS_META)
      const inputs = (JSON.parse(g.record) as { inputs: string[] }).inputs
      const key = compactedKey({ cell: 'cell-0', table: 'metric_samples', tenant: 'golden-tenant', day: '2026-11-18', level: 2, inputs16: await inputsHash16(inputs), sha256Hex: 'f'.repeat(64) })
      expect(await decodeCompactionInputs(key, g.record)).toEqual({ inputs })
    }
    // An unreferenced output whose record is of a newer version, with every input gone: kept.
    const tenant = `golden-j-${Date.now().toString(36)}`
    const inputs = [`${env.CELL}/data/metric_samples/tenant=${tenant}/day=2026-11-18/L0-p_0-1-1-1-0a0a0a0a.parquet`, `${env.CELL}/data/metric_series/tenant=${tenant}/day=2026-11-18/L0-p_0-1-1-1-1a1a1a1a.parquet`]
    const key = compactedKey({ cell: env.CELL, table: 'metric_samples', tenant, day: '2026-11-18', level: 2, inputs16: await inputsHash16(inputs), sha256Hex: 'f'.repeat(64) })
    await env.BUCKET.put(key, 'x', { customMetadata: { [COMPACTION_INPUTS_META]: JSON.stringify({ v: 2, inputs }) } })
    const r = await sweepOrphans(env, tenant, { graceMs: 0, maxCompactStepMs: 0, now: Date.now() + 365 * 86_400_000 })
    expect(r.deleted).toEqual([])
    expect(r.kept).toEqual([{ key, why: 'unknown_inputs', detail: expect.stringContaining('version 2') }])
    // The same object with a version-1 record is deleted: its inputs are gone and the ledger never knew it.
    await env.BUCKET.put(key, 'x', { customMetadata: { [COMPACTION_INPUTS_META]: JSON.stringify({ v: 1, inputs }) } })
    expect((await sweepOrphans(env, tenant, { graceMs: 0, maxCompactStepMs: 0, now: Date.now() + 365 * 86_400_000 })).deleted).toEqual([key])
  })
})
