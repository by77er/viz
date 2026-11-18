import { describe, expect, it } from 'vitest'
import type { EncodedFile, ScanInput, SeriesData } from '../../../contracts/engine'
import { EngineError, createEngine } from '../js/index'
import wasm from '../js/viz_engine.wasm'
import worker from '../js/worker'
import { STALE_NAN, bigBatch, bitsFromBytes, bitsOf, encodeBatch } from './vzb1'

const T = Date.UTC(2026, 10, 18, 12)
const ALL: [number, number] = [0, 253_402_300_799_999]
const lake = (files: EncodedFile[], tail: Uint8Array[] = []): ScanInput => ({
  seriesFiles: files.filter((f) => f.table === 'metric_series').map((f) => f.bytes),
  sampleFiles: files.filter((f) => f.table === 'metric_samples').map((f) => f.bytes),
  tailBatches: tail,
})
const flat = (out: SeriesData[]) => out.map((s) => ({ labels: s.labels, ts: Array.from(s.ts), bits: bitsFromBytes(s.values) }))

describe('the module in workerd', () => {
  it('loads as an imported WebAssembly module and instantiates lazily', () => {
    expect(wasm).toBeInstanceOf(WebAssembly.Module)
    // Plain C ABI: the module imports nothing from the host.
    expect(WebAssembly.Module.imports(wasm)).toEqual([])
    expect(WebAssembly.Module.exports(wasm).map((e) => e.name).sort()).toEqual(['memory', 'viz_abi_version', 'viz_alloc', 'viz_encode_segment', 'viz_free', 'viz_merge_files', 'viz_select'])
    const engine = createEngine(wasm)
    expect(engine.instances()).toBe(0)
    expect(engine.memoryBytes()).toBe(0)
    expect(engine.encodeSegment([])).toEqual([])
    expect(engine.instances()).toBe(1)
    expect(engine.memoryBytes()).toBeGreaterThan(0)
  })

  it('serves from a Worker', async () => {
    const res = await worker.fetch(new Request('https://engine.test/') as never)
    expect(await res.json()).toMatchObject({ ok: true, instances: 1 })
  })
})

describe('encodeSegment and select', () => {
  const up = { __name__: 'up', job: 'api', instance: 'a:1' }
  const cpu = { __name__: 'cpu_seconds_total', job: 'api', instance: 'a:1', mode: 'user' }
  const DAY = 86_400_000
  const midnight = Date.UTC(2026, 10, 19)
  const batch1 = encodeBatch([up, cpu], [
    { series: 0, ts: T, bits: bitsOf(1) },
    { series: 1, ts: T, bits: bitsOf(10.5) },
    { series: 0, ts: T + 15_000, bits: bitsOf(1) },
    { series: 0, ts: midnight, bits: bitsOf(0) }, // the next UTC day
  ])
  const batch2 = encodeBatch([cpu], [
    { series: 0, ts: T + 15_000, bits: bitsOf(11) },
    { series: 0, ts: T, bits: bitsOf(99) }, // a later batch overrides (cpu, T)
  ])

  it('returns one samples file and one series file per UTC day, with contract fields', () => {
    const engine = createEngine(wasm)
    const files = engine.encodeSegment([batch1, batch2])
    expect(files.map((f) => [f.table, f.day, f.rows, f.minTs, f.maxTs])).toEqual([
      ['metric_samples', '2026-11-18', 4, T, T + 15_000],
      ['metric_series', '2026-11-18', 2, T, T + 15_000],
      ['metric_samples', '2026-11-19', 1, midnight, midnight],
      ['metric_series', '2026-11-19', 1, midnight, midnight],
    ])
    for (const f of files) {
      expect(f.bytes).toBeInstanceOf(Uint8Array)
      const magic = new TextDecoder().decode(f.bytes.subarray(0, 4)) + new TextDecoder().decode(f.bytes.subarray(-4))
      expect(magic).toBe('PAR1PAR1')
      expect(Number.isInteger(f.rows) && Number.isInteger(f.minTs) && Number.isInteger(f.maxTs)).toBe(true)
      const index = JSON.parse(f.index) as { v: number; rg: { rows: number }[] }
      expect(index.v).toBe(1)
      expect(index.rg.reduce((a, g) => a + g.rows, 0)).toBe(f.rows)
      // The bytes are a copy: they do not alias WASM memory, which the next call reuses.
      expect(f.bytes.buffer).not.toBe((engine as unknown as { memory?: unknown }).memory)
    }
    // Deterministic: the same input gives the same bytes, also from a fresh instance.
    const again = createEngine(wasm).encodeSegment([batch1, batch2])
    expect(again.map((f) => Array.from(f.bytes))).toEqual(files.map((f) => Array.from(f.bytes)))
    expect(midnight - T).toBeLessThan(DAY)
  })

  it('selects the same samples from the tail, from the lake, and from both without double counting', () => {
    const engine = createEngine(wasm)
    const files = engine.encodeSegment([batch1, batch2])
    const want = [
      { labels: cpu, ts: [T, T + 15_000], bits: [bitsOf(99), bitsOf(11)] },
      { labels: up, ts: [T, T + 15_000, midnight], bits: [bitsOf(1), bitsOf(1), bitsOf(0)] },
    ]
    const tailOnly = engine.select({ seriesFiles: [], sampleFiles: [], tailBatches: [batch1, batch2] }, [], ...ALL)
    const lakeOnly = engine.select(lake(files), [], ...ALL)
    const both = engine.select(lake(files, [batch1, batch2]), [], ...ALL)
    expect(flat(tailOnly)).toEqual(want)
    expect(flat(lakeOnly)).toEqual(want)
    expect(flat(both)).toEqual(want)
    for (const s of both) {
      expect(s.ts).toBeInstanceOf(Float64Array)
      expect(s.values).toBeInstanceOf(Float64Array)
      expect(Array.from(s.ts).every(Number.isInteger)).toBe(true)
    }
    // Matchers and the inclusive time range.
    expect(flat(engine.select(lake(files), [{ name: '__name__', op: '=', value: 'up' }], T + 1, midnight))).toEqual([{ labels: up, ts: [T + 15_000, midnight], bits: [bitsOf(1), bitsOf(0)] }])
    expect(engine.select(lake(files), [{ name: 'mode', op: '=~', value: 'us.*' }], ...ALL).map((s) => s.labels.__name__)).toEqual(['cpu_seconds_total'])
    expect(engine.select(lake(files), [{ name: 'mode', op: '!~', value: 'us.*' }], ...ALL).map((s) => s.labels.__name__)).toEqual(['up'])
    expect(engine.select(lake(files), [{ name: 'mode', op: '!=', value: '' }, { name: 'job', op: '=', value: 'api' }], ...ALL).length).toBe(1)
    // A series that matches but has no sample in the range is not returned.
    expect(engine.select(lake(files), [], T + 1, T + 2)).toEqual([])
    // The tail wins over the lake for the same (series, ts).
    const override = encodeBatch([up], [{ series: 0, ts: T, bits: bitsOf(7) }])
    expect(flat(engine.select(lake(files, [override]), [{ name: '__name__', op: '=', value: 'up' }], T, T))).toEqual([{ labels: up, ts: [T], bits: [bitsOf(7)] }])
  })

  it('keeps a staleness marker bit for bit through encodeSegment → select (bytes inspected, not numbers)', () => {
    const engine = createEngine(wasm)
    const specials = [
      STALE_NAN, // 0x7ff0000000000002, a signalling NaN: the one JavaScript engines may rewrite
      0x7ff8000000000001n, // the ordinary Prometheus NaN
      0x7ff0000000000001n, // another signalling NaN
      0xfff80000deadbeefn, // negative quiet NaN with a payload
      0x7fffffffffffffffn,
      0x8000000000000000n, // -0
      bitsOf(1.5),
    ]
    const m = { __name__: 'm' }
    const batch = encodeBatch([m], specials.map((bits, i) => ({ series: 0, ts: T + i, bits })))
    const files = engine.encodeSegment([batch])
    for (const input of [lake(files), { seriesFiles: [], sampleFiles: [], tailBatches: [batch] }, lake(files, [batch])]) {
      const out = engine.select(input, [], ...ALL)
      expect(out).toHaveLength(1)
      const values = out[0]!.values
      // The first value's eight bytes, little-endian: 02 00 00 00 00 00 f0 7f.
      expect(Array.from(new Uint8Array(values.buffer, values.byteOffset, 8))).toEqual([0x02, 0, 0, 0, 0, 0, 0xf0, 0x7f])
      expect(bitsFromBytes(values)).toEqual(specials)
      expect(values.buffer.byteLength).toBe(8 * specials.length) // its own buffer, not a view of WASM memory
    }
  })

  it('refuses times that are not integers, and accepts ±Infinity as open bounds', () => {
    const engine = createEngine(wasm)
    const batch = encodeBatch([{ __name__: 'm' }], [{ series: 0, ts: T, bits: bitsOf(1) }])
    const input = { seriesFiles: [], sampleFiles: [], tailBatches: [batch] }
    expect(() => engine.select(input, [], 0.5, T)).toThrow(/minTs must be an integer/)
    expect(() => engine.select(input, [], 0, T + 0.25)).toThrow(/maxTs must be an integer/)
    expect(() => engine.select(input, [], NaN, T)).toThrow(RangeError)
    expect(() => engine.select(input, [], '0' as unknown as number, T)).toThrow(RangeError)
    expect(engine.select(input, [], -Infinity, Infinity)).toHaveLength(1)
    expect(engine.select(input, [], Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)).toHaveLength(1)
    expect(engine.select(input, [], T + 1, Infinity)).toHaveLength(0)
  })

  it('reports engine errors as EngineError and stays usable; a label named __proto__ is just a label', () => {
    const engine = createEngine(wasm)
    const good = encodeBatch([Object.fromEntries([['__name__', 'm'], ['__proto__', 'x'], ['constructor', 'y']])], [{ series: 0, ts: T, bits: bitsOf(1) }])
    expect(() => engine.encodeSegment([good, new Uint8Array([1, 2, 3])])).toThrow(EngineError)
    expect(() => engine.encodeSegment([good, new Uint8Array([1, 2, 3])])).toThrow(/batch 1: bad magic/)
    const truncated = good.slice(0, good.length - 1)
    expect(() => engine.encodeSegment([truncated])).toThrow(/batch 0: truncated/)
    expect(() => engine.select({ seriesFiles: [], sampleFiles: [], tailBatches: [good] }, [{ name: 'a', op: '=~', value: '(' }], ...ALL)).toThrow(EngineError)
    expect(() => engine.select({ seriesFiles: [], sampleFiles: [new Uint8Array(40)], tailBatches: [good] }, [], ...ALL)).toThrow(EngineError)
    expect(() => engine.select({ seriesFiles: [], sampleFiles: [], tailBatches: [] }, [{ name: 'a', op: '==' as '=', value: '' }], ...ALL)).toThrow(/unknown matcher operator/)
    expect(engine.instances()).toBe(1) // errors are values from the engine, not traps
    const out = engine.select({ seriesFiles: [], sampleFiles: [], tailBatches: [good] }, [], ...ALL)
    expect(Object.keys(out[0]!.labels).sort()).toEqual(['__name__', '__proto__', 'constructor'])
    expect(Object.getOwnPropertyDescriptor(out[0]!.labels, '__proto__')!.value).toBe('x')
    expect(Object.getPrototypeOf(out[0]!.labels)).toBe(Object.prototype)
  })

  it('says clearly that the PromQL entry points are not built yet', () => {
    const engine = createEngine(wasm)
    const input = { seriesFiles: [], sampleFiles: [], tailBatches: [] }
    expect(() => engine.queryRange(input, 'up', 0, 1, 1)).toThrow(/queryRange is not built yet/)
    expect(() => engine.queryInstant(input, 'up', 0)).toThrow(/queryInstant is not built yet/)
    expect(() => engine.selectors('up', 0, 1, 1)).toThrow(/selectors is not built yet/)
  })

  it('survives memory growth in the middle of a call, and reset() starts a fresh instance', () => {
    const engine = createEngine(wasm)
    engine.encodeSegment([])
    const before = engine.memoryBytes()
    const big = bigBatch(2000, 1 << 20, T, 1000)
    expect(big.bytes.byteLength).toBeLessThanOrEqual(1 << 20)
    const files = engine.encodeSegment([big.bytes])
    expect(engine.memoryBytes()).toBeGreaterThan(before) // linear memory grew while the request was in it
    expect(files[0]!.rows).toBe(big.rows)
    const out = engine.select(lake(files), [], ...ALL)
    expect(out.reduce((a, s) => a + s.ts.length, 0)).toBe(big.rows)
    const peak = engine.memoryBytes()
    engine.reset()
    expect(engine.memoryBytes()).toBe(0)
    engine.encodeSegment([])
    expect(engine.instances()).toBe(2)
    expect(engine.memoryBytes()).toBeLessThan(peak)
  })
})
