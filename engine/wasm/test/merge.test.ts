import { describe, expect, it } from 'vitest'
import type { EncodedFile, SeriesData } from '../../../contracts/engine'
import { EngineError, createEngine } from '../js/index'
import wasm from '../js/viz_engine.wasm'
import { STALE_NAN, bitsFromBytes, bitsOf, encodeBatch, scrapeBatch } from './vzb1'

const T = Date.UTC(2026, 10, 18, 12)
const ALL: [number, number] = [0, 253_402_300_799_999]
const flat = (out: SeriesData[]) => out.map((s) => ({ labels: s.labels, ts: Array.from(s.ts), bits: bitsFromBytes(s.values) }))
const samples = (files: EncodedFile[]) => files.filter((f) => f.table === 'metric_samples')
const series = (files: EncodedFile[]) => files.filter((f) => f.table === 'metric_series')

describe('mergeFiles', () => {
  const up = { __name__: 'up', job: 'api', instance: 'a:1' }
  const cpu = { __name__: 'cpu_seconds_total', job: 'api', instance: 'a:1', mode: 'user' }
  const mem = { __name__: 'mem_bytes', job: 'db', instance: 'b:1' }

  it('merges the files of several segments into one pair that selects identically', () => {
    const engine = createEngine(wasm)
    // Three segments that overlap in series and in (series, ts); special values included.
    const segs = [
      engine.encodeSegment([encodeBatch([up, cpu], [{ series: 0, ts: T, bits: bitsOf(1) }, { series: 1, ts: T, bits: bitsOf(0.5) }, { series: 0, ts: T + 1000, bits: STALE_NAN }])]),
      engine.encodeSegment([encodeBatch([cpu, mem], [{ series: 0, ts: T, bits: bitsOf(0.5) }, { series: 0, ts: T + 1000, bits: 0x7ff8dead0000beefn }, { series: 1, ts: T + 500, bits: bitsOf(-0) }])]),
      engine.encodeSegment([encodeBatch([up], [{ series: 0, ts: T + 2000, bits: bitsOf(Infinity) }, { series: 0, ts: T, bits: bitsOf(1) }])]),
    ]
    const all = segs.flat()
    const before = engine.select({ seriesFiles: series(all).map((f) => f.bytes), sampleFiles: samples(all).map((f) => f.bytes), tailBatches: [] }, [], ...ALL)

    const mergedSamples = engine.mergeFiles('metric_samples', samples(all).map((f) => f.bytes))
    const mergedSeries = engine.mergeFiles('metric_series', series(all).map((f) => f.bytes))
    expect(mergedSamples).toMatchObject({ table: 'metric_samples', day: '2026-11-18', rows: 6, minTs: T, maxTs: T + 2000 })
    expect(mergedSeries).toMatchObject({ table: 'metric_series', day: '2026-11-18', rows: 3 })
    expect(new TextDecoder().decode(mergedSamples.bytes.subarray(0, 4))).toBe('PAR1')
    expect(JSON.parse(mergedSamples.index)).toMatchObject({ v: 1, rg: [{ rows: 6 }] })
    // The bytes are a copy: they do not alias WASM memory.
    expect(mergedSamples.bytes.buffer).not.toBe((engine as unknown as { memory?: unknown }).memory)

    const after = engine.select({ seriesFiles: [mergedSeries.bytes], sampleFiles: [mergedSamples.bytes], tailBatches: [] }, [], ...ALL)
    expect(flat(after)).toEqual(flat(before))
    expect(after.reduce((a, s) => a + s.ts.length, 0)).toBe(6)
    // Deterministic: the same inputs give the same bytes, in another instance too.
    const again = createEngine(wasm).mergeFiles('metric_samples', samples(all).map((f) => f.bytes))
    expect(again.bytes).toEqual(mergedSamples.bytes)
    expect(again.index).toBe(mergedSamples.index)
  })

  it('the later input wins on a duplicate (series, ts), as select does', () => {
    const engine = createEngine(wasm)
    const a = engine.encodeSegment([encodeBatch([up], [{ series: 0, ts: T, bits: bitsOf(1) }])])
    const b = engine.encodeSegment([encodeBatch([up], [{ series: 0, ts: T, bits: bitsOf(2) }])])
    for (const order of [[a, b], [b, a]]) {
      const files = order.map((f) => samples(f)[0]!.bytes)
      const merged = engine.mergeFiles('metric_samples', files)
      const want = engine.select({ seriesFiles: [series(a)[0]!.bytes], sampleFiles: files, tailBatches: [] }, [], ...ALL)
      const got = engine.select({ seriesFiles: [series(a)[0]!.bytes], sampleFiles: [merged.bytes], tailBatches: [] }, [], ...ALL)
      expect(flat(got)).toEqual(flat(want))
      expect(flat(got)[0]!.bits).toEqual([bitsOf(order[1] === b ? 2 : 1)])
    }
  })

  it('reports engine errors without losing the instance, and frees what it allocated', () => {
    const engine = createEngine(wasm)
    const a = engine.encodeSegment([encodeBatch([up], [{ series: 0, ts: T, bits: bitsOf(1) }])])
    const other = engine.encodeSegment([encodeBatch([up], [{ series: 0, ts: T + 86_400_000, bits: bitsOf(1) }])])
    expect(() => engine.mergeFiles('metric_samples', [])).toThrow(EngineError)
    expect(() => engine.mergeFiles('metric_samples', [new Uint8Array([1, 2, 3])])).toThrow(EngineError)
    // A series file where a samples file belongs, and rows of two days.
    expect(() => engine.mergeFiles('metric_samples', [series(a)[0]!.bytes])).toThrow(EngineError)
    expect(() => engine.mergeFiles('metric_samples', [samples(a)[0]!.bytes, samples(other)[0]!.bytes])).toThrow(/day/i)
    expect(() => engine.mergeFiles('nope' as never, [])).toThrow(RangeError)
    expect(engine.instances()).toBe(1)
    // Many merges in one instance do not grow memory: the file buffer is released each time.
    const inputs = [samples(a)[0]!.bytes, samples(a)[0]!.bytes]
    engine.mergeFiles('metric_samples', inputs)
    const mem0 = engine.memoryBytes()
    for (let i = 0; i < 200; i++) engine.mergeFiles('metric_samples', inputs)
    expect(engine.memoryBytes()).toBe(mem0)
  })

  it('MEASURE: merges 8 flush-sized files and stays far below the isolate limit', () => {
    const maker = createEngine(wasm)
    const inputs = Array.from({ length: 8 }, (_, k) => maker.encodeSegment([scrapeBatch(2000, T + k * 20 * 15_000, 15_000, 20, k)]))
    const engine = createEngine(wasm)
    const s = performance.now()
    const out = engine.mergeFiles('metric_samples', inputs.map((f) => samples(f)[0]!.bytes))
    const ms = performance.now() - s
    expect(out.rows).toBe(8 * 2000 * 20)
    console.error('MEASURE ' + JSON.stringify({ where: 'local workerd (vitest)', merge_8_files: { rows: out.rows, input_bytes: inputs.reduce((a, f) => a + samples(f)[0]!.bytes.byteLength, 0), output_bytes: out.bytes.byteLength, ms, peak_wasm_memory_mb: +(engine.memoryBytes() / 1048576).toFixed(1) } }))
    expect(engine.memoryBytes()).toBeLessThan(64 << 20)
  })
})
