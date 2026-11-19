/**
 * The WASM query engine and its binding (`engine/wasm-query`), in workerd: the module
 * loads with no imports, the binding honours the contract's number rules, limits come
 * back as typed errors, and the 2,000-series query fits the isolate.
 */
import { describe, expect, it } from 'vitest'
import type { ScanInput } from '../../contracts/engine'
import { DEFAULT_LIMITS, QueryError, type QueryLimits, createQueryEngine } from '../../engine/wasm-query/js/index'
import wasm from '../../engine/wasm-query/js/viz_query.wasm'
import { STALE_NAN, bitsFromBytes, bitsOf, encodeBatch } from '../../engine/wasm/test/vzb1'
import { engine as flushEngine } from '../../flush/src/index'
import { Bulk, JOBS, checkBulkRates } from './bulk'

const T = Date.UTC(2026, 10, 18, 12)
const up = { __name__: 'up', job: 'api', instance: 'a:1' }
const cpu = { __name__: 'cpu_seconds_total', job: 'api', instance: 'a:1' }
const batch = encodeBatch(
  [up, cpu],
  [
    { series: 0, ts: T, bits: bitsOf(1) },
    { series: 0, ts: T + 15_000, bits: bitsOf(1) },
    { series: 0, ts: T + 30_000, bits: STALE_NAN },
    { series: 1, ts: T, bits: bitsOf(10) },
    { series: 1, ts: T + 15_000, bits: bitsOf(25) },
    { series: 1, ts: T + 30_000, bits: 0x7ff8dead0000beefn }, // a NaN with a payload
  ],
)
const tail: ScanInput = { seriesFiles: [], sampleFiles: [], tailBatches: [batch] }
const lake = (batches: Uint8Array[]): ScanInput => {
  const files = flushEngine.encodeSegment(batches)
  return { seriesFiles: files.filter((f) => f.table === 'metric_series').map((f) => f.bytes), sampleFiles: files.filter((f) => f.table === 'metric_samples').map((f) => f.bytes), tailBatches: [] }
}
const fails = (f: () => unknown): QueryError => {
  try {
    f()
  } catch (e) {
    if (e instanceof QueryError) return e
    throw e
  }
  throw new Error('expected a QueryError')
}

describe('the module in workerd', () => {
  it('imports nothing, exports only the C ABI, and instantiates with an empty import object', () => {
    expect(wasm).toBeInstanceOf(WebAssembly.Module)
    expect(WebAssembly.Module.imports(wasm)).toEqual([])
    expect(WebAssembly.Module.exports(wasm).map((e) => e.name).sort()).toEqual([
      'memory', 'viz_alloc', 'viz_free', 'viz_q_abi_version', 'viz_q_card_part', 'viz_q_card_report', 'viz_q_extract', 'viz_q_file_plan', 'viz_q_gather_add', 'viz_q_gather_eval',
      'viz_q_gather_free', 'viz_q_gather_new', 'viz_q_label_names', 'viz_q_label_values', 'viz_q_merge', 'viz_q_meta_part', 'viz_q_parse_selectors', 'viz_q_part_plan', 'viz_q_plan',
      'viz_q_query_instant', 'viz_q_query_range', 'viz_q_sample_plan', 'viz_q_scan_rows', 'viz_q_select', 'viz_q_selectors', 'viz_q_series', 'viz_q_split_plan', 'viz_q_split_tails',
      // ABI 6: traces and logs (ABI 7 and 8 changed their requests, not the list).
      'viz_q_lq_file_plan', 'viz_q_lq_labels', 'viz_q_lq_plan', 'viz_q_lq_query',
      'viz_q_tq_extent', 'viz_q_tq_file_plan', 'viz_q_tq_metrics', 'viz_q_tq_plan', 'viz_q_tq_search', 'viz_q_tq_tag_values', 'viz_q_tq_tags', 'viz_q_tq_trace',
    ].sort())
    // workerd's clock has millisecond resolution: time many and divide.
    const t0 = performance.now()
    for (let i = 0; i < 500; i++) {
      const inst = new WebAssembly.Instance(wasm, {})
      expect((inst.exports.viz_q_abi_version as () => number)()).toBe(8)
    }
    console.log(`MEASURE instantiate in workerd (local): ${((performance.now() - t0) / 500).toFixed(3)} ms each (mean of 500, with one call into the module)`)
    const engine = createQueryEngine(wasm)
    expect(engine.instances()).toBe(0)
    expect(engine.plan('up', T, T, 1)).toHaveLength(1)
    expect(engine.instances()).toBe(1)
    expect(engine.memoryBytes()).toBeGreaterThan(0)
  })
})

describe('the query half of contracts/engine.ts', () => {
  const engine = createQueryEngine(wasm)

  it('plan merges and clamps; selectors lists each selector', () => {
    const name = (v: string) => [{ name: '__name__', op: '=', value: v }]
    expect(engine.plan('rate(up[1m]) / up', T, T + 60_000, 15_000)).toEqual([{ matchers: name('up'), minTs: T - 300_000 + 1, maxTs: T + 60_000 }])
    expect(engine.selectors('rate(up[1m]) / up', T, T + 60_000, 15_000)).toEqual([
      { matchers: name('up'), minTs: T - 60_000 + 1, maxTs: T + 60_000 },
      { matchers: name('up'), minTs: T - 300_000 + 1, maxTs: T + 60_000 },
    ])
    expect(engine.plan('up offset 1h', 0, 60_000, 15_000)).toEqual([]) // before 1970: nothing storage can hold
    expect(engine.plan('1 + 1', T, T, 1)).toEqual([])
    expect(engine.plan('up{job=~"a.*",instance!="x"}', T, T, 1)[0]!.matchers).toEqual(
      expect.arrayContaining([
        { name: 'job', op: '=~', value: 'a.*' },
        { name: 'instance', op: '!=', value: 'x' },
        { name: '__name__', op: '=', value: 'up' },
      ]),
    )
  })

  it('queryRange and queryInstant return the Prometheus data object, times in seconds, values as strings', () => {
    expect(engine.queryRange(tail, 'cpu_seconds_total', T, T + 15_000, 15_000)).toEqual({
      resultType: 'matrix',
      result: [{ metric: cpu, values: [[T / 1000, '10'], [T / 1000 + 15, '25']] }],
    })
    expect(engine.queryInstant(tail, 'cpu_seconds_total - 5', T + 15_000)).toEqual({ resultType: 'vector', result: [{ metric: { job: 'api', instance: 'a:1' }, value: [T / 1000 + 15, '20'] }] })
    expect(engine.queryInstant(tail, '1 + 1', T)).toEqual({ resultType: 'scalar', result: [T / 1000, '2'] })
    expect(engine.queryInstant(tail, '"x"', T)).toEqual({ resultType: 'string', result: [T / 1000, 'x'] })
    expect(engine.queryInstant(tail, 'up[20s]', T + 15_000)).toMatchObject({ resultType: 'matrix' })
    // A staleness marker ends the series; no result ever contains one.
    expect(engine.queryInstant(tail, 'up', T + 29_999)).toMatchObject({ result: [{ value: [T / 1000 + 29.999, '1'] }] })
    expect(engine.queryInstant(tail, 'up', T + 30_000)).toEqual({ resultType: 'vector', result: [] })
    // The JSON form carries what was read.
    const { json, stats } = engine.queryRangeJson(tail, 'cpu_seconds_total', T, T + 15_000, 15_000)
    expect(JSON.parse(json).resultType).toBe('matrix')
    expect(stats).toEqual({ selects: 1, series: 1, samples: 2, outputPoints: 2 })
    // Lake and tail give the same bytes.
    expect(engine.queryRangeJson(lake([batch]), 'cpu_seconds_total', T, T + 15_000, 15_000).json).toBe(json)
  })

  it('select copies sample bytes: a staleness marker and a NaN payload survive bit for bit', () => {
    for (const input of [tail, lake([batch])]) {
      const out = engine.select(input, [{ name: 'job', op: '=', value: 'api' }], 0, 253_402_300_799_999)
      expect(out.map((s) => s.labels)).toEqual([cpu, up])
      expect(Array.from(out[1]!.ts)).toEqual([T, T + 15_000, T + 30_000])
      expect(bitsFromBytes(out[1]!.values)).toEqual([bitsOf(1), bitsOf(1), STALE_NAN])
      expect(bitsFromBytes(out[0]!.values)[2]).toBe(0x7ff8dead0000beefn)
    }
    expect(engine.select(tail, [{ name: '__name__', op: '!~', value: 'u.*' }], T + 1, T + 15_000).map((s) => [s.labels.__name__, Array.from(s.ts)])).toEqual([['cpu_seconds_total', [T + 15_000]]])
  })

  it('refuses times that are not integers, instead of rounding them', () => {
    expect(() => engine.queryInstant(tail, 'up', T + 0.5)).toThrow(RangeError)
    expect(() => engine.queryRange(tail, 'up', T, Number.NaN, 1000)).toThrow(RangeError)
    expect(() => engine.plan('up', T, T + 1, 0.5)).toThrow(RangeError)
    expect(() => engine.select(tail, [], 0.1, 5)).toThrow(RangeError)
    expect(() => engine.queryInstant(tail, 'up', T, { ...DEFAULT_LIMITS, maxSamples: 1.5 })).toThrow(RangeError)
    // The instance is still usable.
    expect(engine.queryInstant(tail, 'up', T)).toMatchObject({ resultType: 'vector' })
  })

  it('metadata calls and match[] parsing', () => {
    const all: [number, number] = [0, 253_402_300_799_999]
    expect(engine.labelNames(tail, [], ...all)).toEqual(['__name__', 'instance', 'job'])
    expect(engine.labelNames(tail, ['up', 'cpu_seconds_total'], ...all)).toEqual(['__name__', 'instance', 'job'])
    expect(engine.labelValues(tail, '__name__', [], ...all)).toEqual(['cpu_seconds_total', 'up'])
    expect(engine.labelValues(tail, '__name__', ['{__name__=~"u.*"}'], ...all)).toEqual(['up'])
    expect(engine.labelValues(tail, 'nope', [], ...all)).toEqual([])
    expect(engine.series(tail, ['up', '{job="api"}'], ...all)).toEqual([cpu, up])
    expect(engine.series(tail, ['up'], T + 30_001, T + 40_000)).toEqual([])
    expect(engine.parseSelectors(['up{job="a"}'])).toEqual([[{ name: '__name__', op: '=', value: 'up' }, { name: 'job', op: '=', value: 'a' }]])
    expect(fails(() => engine.parseSelectors(['sum(up)'])).errorType).toBe('bad_data')
    expect(fails(() => engine.parseSelectors(['{}'])).errorType).toBe('bad_data')
    expect(fails(() => engine.series(tail, [], ...all)).errorType).toBe('bad_data')
  })

  it('errors carry the Prometheus error type', () => {
    expect(fails(() => engine.queryInstant(tail, 'sum(', T))).toMatchObject({ errorType: 'bad_data' })
    expect(fails(() => engine.queryInstant(tail, 'up{job=~"("}', T))).toMatchObject({ errorType: 'bad_data' })
    expect(fails(() => engine.queryInstant(tail, 'up + on (job) {job="api"}', T))).toMatchObject({ errorType: 'execution' })
    expect(fails(() => engine.queryInstant(tail, 'limitk(1, up)', T))).toMatchObject({ errorType: 'unsupported' })
    expect(fails(() => engine.queryInstant({ ...tail, tailBatches: [new Uint8Array([1, 2, 3])] }, 'up', T))).toMatchObject({ errorType: 'internal' })
    expect(fails(() => engine.queryInstant({ ...tail, sampleFiles: [new Uint8Array(64)] }, 'up', T))).toMatchObject({ errorType: 'internal' })
    expect(fails(() => engine.queryRange(tail, 'up', T, T - 1, 1000))).toMatchObject({ errorType: 'bad_data' })
    expect(fails(() => engine.queryRange(tail, 'up', T, T + 1000, 0))).toMatchObject({ errorType: 'bad_data' })
    // Every error leaves the instance in use: no trap, no new instance.
    expect(engine.instances()).toBe(1)
  })

  it('every limit is passed per call and comes back as a typed execution error naming it', () => {
    const lim = (o: Partial<QueryLimits>): QueryLimits => ({ ...DEFAULT_LIMITS, ...o })
    const range = (l: QueryLimits) => engine.queryRange(tail, '{job="api"}', T, T + 15_000, 15_000, l)
    // Exactly at the limit succeeds; one below fails. The data: 2 series, 4 samples, 4 points, 2 x 2 step points.
    const cases: [keyof QueryLimits, number, string][] = [
      ['maxSamples', 4, 'max_samples'],
      ['maxSeries', 2, 'max_series'],
      ['maxOutputPoints', 4, 'max_output_points'],
      ['maxStepPoints', 4, 'max_step_points'],
      ['maxQueryBytes', '{job="api"}'.length, 'max_query_bytes'],
    ]
    for (const [field, at, name] of cases) {
      expect(range(lim({ [field]: at })).result, name).toHaveLength(2)
      const e = fails(() => range(lim({ [field]: at - 1 })))
      expect(e, name).toMatchObject({ errorType: 'execution', limit: { name, max: at - 1, reached: at } })
      expect(e.message).toBe(`query exceeded limit ${name}: ${at} ${e.message.split(`: ${at} `)[1]!.split(',')[0]}, the limit is ${at - 1}`)
    }
    expect(fails(() => engine.queryInstant(tail, '((((up))))', T, lim({ maxDepth: 3 })))).toMatchObject({ errorType: 'execution', limit: { name: 'max_depth', max: 3 } })
    expect(engine.queryInstant(tail, '((((up))))', T, lim({ maxDepth: 5 }))).toMatchObject({ resultType: 'vector' })
    // The step cap is bad_data, as in the Prometheus API.
    expect(fails(() => engine.queryRange(tail, 'up', T, T + 10_000, 1000, lim({ maxSteps: 10 })))).toMatchObject({ errorType: 'bad_data' })
    expect(engine.queryRange(tail, 'up', T, T + 10_000, 1000, lim({ maxSteps: 11 })).result).toHaveLength(1)
    // plan and the metadata calls take limits too.
    expect(fails(() => engine.plan('up', T, T, 1, lim({ maxQueryBytes: 1 })))).toMatchObject({ limit: { name: 'max_query_bytes' } })
    expect(fails(() => engine.labelNames(tail, [], 0, T + 60_000, lim({ maxSeries: 1 })))).toMatchObject({ limit: { name: 'max_series' } })
    // The label calls read series, not samples (since 2026-11-19): a sample limit does not bind them, the series limit does.
    expect(engine.series(tail, ['{job="api"}'], 0, T + 60_000, lim({ maxSamples: 1 }))).toHaveLength(2)
    expect(fails(() => engine.series(tail, ['{job="api"}'], 0, T + 60_000, lim({ maxSeries: 1 })))).toMatchObject({ limit: { name: 'max_series', reached: 2 } })
    // No limit is remembered by the instance.
    expect(range(DEFAULT_LIMITS).result).toHaveLength(2)
  })

  it('filesNeeded and scanRows read the index fragments the flush engine wrote', () => {
    const early = flushEngine.encodeSegment([batch])
    const late = flushEngine.encodeSegment([encodeBatch([{ __name__: 'zzz', job: 'x' }], [{ series: 0, ts: T + 3_600_000, bits: bitsOf(7) }])])
    const files = [...early, ...late]
    const idx = files.map((f) => f.index)
    const name = (v: string) => [{ name: '__name__', op: '=' as const, value: v }]
    const isEarly = files.map((f) => f.maxTs < T + 3_600_000)
    expect(engine.filesNeeded(idx, [{ matchers: [], minTs: 0, maxTs: T + 30_000 }])).toEqual(isEarly)
    expect(engine.filesNeeded(idx, [{ matchers: name('zzz'), minTs: 0, maxTs: 253_402_300_799_999 }])).toEqual(isEarly.map((e) => !e))
    expect(engine.filesNeeded(idx, [{ matchers: name('aaa'), minTs: 0, maxTs: 253_402_300_799_999 }])).toEqual(files.map(() => false))
    expect(engine.filesNeeded(idx, [{ matchers: [{ name: '__name__', op: '=~', value: 'aaa' }], minTs: 0, maxTs: 253_402_300_799_999 }])).toEqual(files.map(() => true))
    expect(engine.scanRows(idx, [{ matchers: [], minTs: 0, maxTs: 253_402_300_799_999 }])).toEqual(files.map((f) => f.rows))
    expect(engine.filesNeeded(['not json', ''], [{ matchers: name('aaa'), minTs: 0, maxTs: 1 }])).toEqual([true, true])
    expect(engine.scanRows(['not json'], [])).toEqual([null])
  })
})

describe('memory', () => {
  it('a 1-hour sum by (job)(rate(m[5m])) over 2,000 series: result, engine time and peak WASM memory', () => {
    const interval = 15_000
    const end = Date.UTC(2026, 10, 18, 12)
    const start = end - 3_600_000
    // 1 h 5 min of scrapes: 261 scrapes x 2,000 series = 522,000 samples.
    const bulk = new Bulk(start - 300_000, interval)
    const batches: Uint8Array[] = []
    while (bulk.nextTs <= end) batches.push(bulk.batch(Math.min(15, (end - bulk.nextTs) / interval + 1)))
    const rows = batches.reduce((a, b) => a + new DataView(b.buffer).getUint32(8, true), 0)
    const cut = Math.floor((batches.length * 5) / 6)
    const flushed = lake(batches.slice(0, cut))
    const input: ScanInput = { ...flushed, tailBatches: batches.slice(cut) }
    const fileBytes = [...flushed.seriesFiles, ...flushed.sampleFiles].reduce((a, f) => a + f.byteLength, 0)
    const tailBytes = input.tailBatches.reduce((a, b) => a + b.byteLength, 0)
    const q = 'sum by (job)(rate(http_requests_total[5m]))'

    const run = (inp: ScanInput, label: string) => {
      const engine = createQueryEngine(wasm) // a fresh instance: its memory is this query's peak
      const t0 = performance.now()
      const out = engine.queryRangeJson(inp, q, start, end, interval)
      const first = performance.now() - t0
      const times: number[] = []
      for (let i = 0; i < 5; i++) {
        const t = performance.now()
        engine.queryRangeJson(inp, q, start, end, interval)
        times.push(performance.now() - t)
      }
      times.sort((a, b) => a - b)
      console.log(
        `MEASURE engine 1h/2000 series (${label}; local): ${out.stats.samples} samples, ${out.stats.series} series, ${out.json.length} B of JSON; first ${first.toFixed(0)} ms, then median ${times[2]!.toFixed(0)} ms; peak WASM memory ${(engine.memoryBytes() / 2 ** 20).toFixed(1)} MiB`,
      )
      return { out, peak: engine.memoryBytes() }
    }
    console.log(`MEASURE engine input: ${rows} samples in ${batches.length} batches; lake ${(fileBytes / 2 ** 20).toFixed(2)} MiB in ${flushed.sampleFiles.length + flushed.seriesFiles.length} files, tail ${(tailBytes / 2 ** 20).toFixed(2)} MiB in ${input.tailBatches.length} batches`)
    const mixed = run(input, 'five sixths in Parquet, the rest in the tail')
    const whole = lake(batches)
    const wholeBytes = [...whole.seriesFiles, ...whole.sampleFiles].reduce((a, f) => a + f.byteLength, 0)
    console.log(`MEASURE engine input, all in Parquet: ${(wholeBytes / 2 ** 20).toFixed(2)} MiB in ${whole.sampleFiles.length + whole.seriesFiles.length} files`)
    const allLake = run(whole, 'all in Parquet')

    expect(rows).toBe(522_000)
    expect(mixed.out.stats).toMatchObject({ series: 2000, samples: 520_000, outputPoints: JOBS * 241 })
    expect(allLake.out.json).toBe(mixed.out.json)
    checkBulkRates(JSON.parse(mixed.out.json), 241, interval)
    expect(JOBS).toBe(20)
    // Fits a 128 MB isolate with room to spare.
    expect(mixed.peak).toBeLessThan(64 << 20)
    expect(allLake.peak).toBeLessThan(64 << 20)
  })
})
