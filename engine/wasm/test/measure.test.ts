import { describe, expect, it } from 'vitest'
import { createEngine } from '../js/index'
import wasm from '../js/viz_engine.wasm'
import { bigBatch } from './vzb1'

/**
 * Local measurements inside workerd (not Cloudflare): the numbers quoted in the README.
 * The assertions are only sanity bounds; the figures are printed with a MEASURE prefix.
 */
describe('measurements in workerd', () => {
  it('encodes 8 batches of 1 MiB and selects from the result', () => {
    const T = Date.UTC(2026, 10, 18, 12)
    const batches: Uint8Array[] = []
    let rows = 0
    let t = T
    for (let i = 0; i < 8; i++) {
      const b = bigBatch(2000, 1 << 20, t, 1000)
      expect(b.bytes.byteLength).toBeGreaterThan((1 << 20) - 32)
      expect(b.bytes.byteLength).toBeLessThanOrEqual(1 << 20)
      batches.push(b.bytes)
      rows += b.rows
      t = b.lastTs + 1000
    }
    const inst: number[] = []
    for (let i = 0; i < 20; i++) {
      const s = performance.now()
      new WebAssembly.Instance(wasm, {})
      inst.push(performance.now() - s)
    }
    const enc: number[] = []
    const sel: number[] = []
    let encMem = 0
    let selMem = 0
    let samples = 0
    let parquet: number[] = []
    for (let i = 0; i < 5; i++) {
      const engine = createEngine(wasm)
      let s = performance.now()
      const files = engine.encodeSegment(batches)
      enc.push(performance.now() - s)
      encMem = Math.max(encMem, engine.memoryBytes())
      parquet = files.map((f) => f.bytes.byteLength)
      expect(files[0]!.rows).toBe(rows)
      const reader = createEngine(wasm)
      s = performance.now()
      const out = reader.select({ seriesFiles: [files[1]!.bytes], sampleFiles: [files[0]!.bytes], tailBatches: [] }, [], 0, 253_402_300_799_999)
      sel.push(performance.now() - s)
      selMem = Math.max(selMem, reader.memoryBytes())
      samples = out.reduce((a, x) => a + x.ts.length, 0)
      expect(samples).toBe(rows)
    }
    const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1]!
    console.error('MEASURE ' + JSON.stringify({
      where: 'local workerd (vitest), timer resolution 1 ms',
      instantiate_ms: { median: med(inst), max: Math.max(...inst) },
      encode_8x1MiB: { rows, parquet_bytes: parquet, ms_median: med(enc), ms_all: enc, peak_wasm_memory_mb: +(encMem / 1048576).toFixed(1) },
      select_all_from_result: { samples, ms_median: med(sel), ms_all: sel, peak_wasm_memory_mb: +(selMem / 1048576).toFixed(1) },
    }))
    expect(encMem).toBeLessThan(128 << 20)
    expect(selMem).toBeLessThan(128 << 20)
  })
})
