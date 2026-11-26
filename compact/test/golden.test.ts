/**
 * Golden formats (contracts/COMPATIBILITY.md §3, §8): what compaction writes that another
 * release reads, produced by the real code with fixed inputs. Each file is
 * `test/golden/formats/<format>.v<N>.json`, N = `FORMATS[<format>]` in `src/formats.ts`.
 */
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { FORMATS } from '../src/formats'
import { COMPACTION_INPUTS_META, compactStep, compactedKey, decodeCompactionInputs, encodeCompactionInputs, engine, inputsHash16 } from '../src/index'
import { Sent, T0, append, flushSettled, someSamples, stream } from '../../flush/test/helpers'
import { expectGolden, goldenDir, goldenFile } from './golden'

type Format = keyof typeof FORMATS
const file = (f: Format, v: number = FORMATS[f]) => `formats/${f}.v${v}.json`

/** Fixed inputs of a merge, in the order `JobSummary.inputs` lists them. */
const INPUTS = [
  'cell-0/data/metric_samples/tenant=golden-tenant/day=2026-11-18/L0-pool_0-1763467200000123-1-1-0a0a0a0a.parquet',
  'cell-0/data/metric_samples/tenant=golden-tenant/day=2026-11-18/L0-pool_0-1763467200000123-2-2-0b0b0b0b.parquet',
  'cell-0/data/metric_series/tenant=golden-tenant/day=2026-11-18/L0-pool_0-1763467200000123-1-1-1a1a1a1a.parquet',
  'cell-0/data/metric_series/tenant=golden-tenant/day=2026-11-18/L0-pool_0-1763467200000123-2-2-1b1b1b1b.parquet',
]

describe('golden formats: every format this component writes has a golden file for its current version', () => {
  it('no format is missing a file, and no file claims a version the code does not', () => {
    const files = goldenDir('formats')
    for (const f of Object.keys(FORMATS) as Format[]) {
      expect(files[`${f}.v${FORMATS[f]}.json`], `test/golden/${file(f)}`).toMatchObject({ format: f, version: FORMATS[f] })
    }
    for (const [name, g] of Object.entries(files)) {
      const { format, version } = g as { format: Format; version: number }
      expect(name).toBe(`${format}.v${version}.json`)
      expect(version, `${name} is newer than the code's ${format}`).toBeLessThanOrEqual(FORMATS[format])
    }
  })

  it('key.compaction-output: inputs16 of fixed inputs, and the keys of both levels', async () => {
    const inputs16 = await inputsHash16(INPUTS)
    const sha256Hex = 'fedcba9876543210'.repeat(4)
    const base = { cell: 'cell-0', tenant: 'golden-tenant', day: '2026-11-18', inputs16, sha256Hex }
    expectGolden(file('key.compaction-output'), {
      format: 'key.compaction-output',
      version: FORMATS['key.compaction-output'],
      inputs16,
      level1: compactedKey({ ...base, table: 'metric_samples', level: 1, hour: 7 }),
      level2: compactedKey({ ...base, table: 'metric_series', level: 2 }),
      // Added 2026-11-19 with compaction of the span and log tables (contracts/TRACES.md and
      // LOGS.md, "Compaction"): the same format, for the new tables; the metric keys above are unchanged.
      spansLevel1: compactedKey({ ...base, table: 'spans', level: 1, hour: 7 }),
      spansLevel2: compactedKey({ ...base, table: 'spans', level: 2, hour: 7 }),
      traceIndexLevel1: compactedKey({ ...base, table: 'trace_index', level: 1, hour: 7 }),
      logsLevel2: compactedKey({ ...base, table: 'logs', level: 2 }),
    })
    expect(() => compactedKey({ ...base, table: 'spans', level: 2 })).toThrow(/hour/)
  })

  it('r2.compaction-inputs: the record of a spans output names files of its own hour; the reader refuses another hour, another table, a metric key', async () => {
    const spans = [0, 1].map((i) => `cell-0/data/spans/tenant=golden-tenant/day=2026-11-18/hour=07/L0-pool_traces_0-1763467200000123-${i + 1}-${i + 1}-0${i}0${i}0${i}0${i}.parquet`)
    const key = compactedKey({ cell: 'cell-0', table: 'spans', tenant: 'golden-tenant', day: '2026-11-18', level: 1, hour: 7, inputs16: await inputsHash16(spans), sha256Hex: 'f'.repeat(64) })
    expect(await decodeCompactionInputs(key, encodeCompactionInputs(spans))).toEqual({ inputs: spans })
    const other = async (inputs: string[]) => decodeCompactionInputs(compactedKey({ cell: 'cell-0', table: 'spans', tenant: 'golden-tenant', day: '2026-11-18', level: 1, hour: 7, inputs16: await inputsHash16(inputs), sha256Hex: 'f'.repeat(64) }), encodeCompactionInputs(inputs))
    expect(await other(spans.map((k) => k.replace('/hour=07/', '/hour=08/')))).toEqual({ unreadable: expect.stringContaining('tenant and day') })
    expect(await other(spans.map((k) => k.replace('/spans/', '/logs/').replace('/hour=07/', '/')))).toEqual({ unreadable: expect.stringContaining('tenant and day') })
    expect(await other(INPUTS)).toEqual({ unreadable: expect.stringContaining('tenant and day') })
    // A logs output's inputs are logs files of its day.
    const logs = spans.map((k) => k.replace('/spans/', '/logs/').replace('/hour=07/', '/'))
    const lk = compactedKey({ cell: 'cell-0', table: 'logs', tenant: 'golden-tenant', day: '2026-11-18', level: 2, inputs16: await inputsHash16(logs), sha256Hex: 'f'.repeat(64) })
    expect(await decodeCompactionInputs(lk, encodeCompactionInputs(logs))).toEqual({ inputs: logs })
    expect(await decodeCompactionInputs(lk.replace('/logs/', '/spans/'), encodeCompactionInputs(logs))).toEqual({ unreadable: 'not a compaction output key' })
  })

  it('r2.compaction-inputs: the record, and that the reader takes it back for a key with that inputs16', async () => {
    const record = encodeCompactionInputs(INPUTS)
    expectGolden(file('r2.compaction-inputs'), { format: 'r2.compaction-inputs', version: FORMATS['r2.compaction-inputs'], metadataKey: COMPACTION_INPUTS_META, record })
    const g = goldenFile(file('r2.compaction-inputs')) as { record: string }
    const key = compactedKey({ cell: 'cell-0', table: 'metric_samples', tenant: 'golden-tenant', day: '2026-11-18', level: 1, hour: 7, inputs16: await inputsHash16(INPUTS), sha256Hex: 'f'.repeat(64) })
    expect(await decodeCompactionInputs(key, g.record)).toEqual({ inputs: INPUTS })
  })

  it('every output a step writes carries the record, and it decodes to the step\'s inputs', async () => {
    const s = stream('golden-c')
    for (let i = 0; i < 4; i++) {
      await append(s.shard, s.tenant, someSamples(s.tenant, T0 + i * 60_000, 24, i), new Sent())
      await s.shard.seal(s.tenant)
    }
    await flushSettled(env, engine, s.tenant, s.shardName)
    const r = await compactStep(env, engine, s.tenant, { now: T0 + 30 * 60_000 })
    expect(r.status).toBe('merged')
    if (r.status !== 'merged') return
    for (const f of r.outputs) {
      const meta = (await env.BUCKET.head(f.key))!.customMetadata?.[COMPACTION_INPUTS_META]
      expect(await decodeCompactionInputs(f.key, meta)).toEqual({ inputs: r.job.inputs })
    }
  })

  it('reader: an unknown version, a list that does not hash to the key, or keys of another tenant are refused', async () => {
    const key = compactedKey({ cell: 'cell-0', table: 'metric_samples', tenant: 'golden-tenant', day: '2026-11-18', level: 2, inputs16: await inputsHash16(INPUTS), sha256Hex: 'f'.repeat(64) })
    expect(await decodeCompactionInputs(key, JSON.stringify({ v: 2, inputs: INPUTS }))).toEqual({ unreadable: expect.stringContaining('version 2') })
    expect(await decodeCompactionInputs(key, encodeCompactionInputs(INPUTS.slice(1)))).toEqual({ unreadable: expect.stringContaining('hash') })
    expect(await decodeCompactionInputs(key, encodeCompactionInputs(INPUTS.map((k) => k.replace('golden-tenant', 'other'))))).toEqual({ unreadable: expect.stringContaining('tenant') })
    expect(await decodeCompactionInputs(key, undefined)).toEqual({ unreadable: 'no inputs recorded' })
    expect(await decodeCompactionInputs(key, '{')).toEqual({ unreadable: expect.stringContaining('JSON') })
  })
})
