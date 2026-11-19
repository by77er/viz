/**
 * The span and log encoders through the binding (ABI 3), in workerd. Batches are written by
 * this component's own test encoder (`test/signal.ts`, sharing no code with `edge` or the Rust
 * crate) and the files are read back with hyparquet (pure JavaScript, sharing no code with viz
 * or the `parquet` crate).
 */
import { describe, expect, it } from 'vitest'
import { parquetMetadata, parquetReadObjects } from '../../../bench/node_modules/hyparquet/src/index.js'
import type { EncodedSignalFile } from '../../../contracts/engine'
import { EngineError, createEngine } from '../js/index'
import wasm from '../js/viz_engine.wasm'
import { encodeLogBatch, encodeSpanBatch, id, streamId } from './signal'
import { bitsOf, encodeBatch } from './vzb1'

/** 2026-11-19T22:59:59.5Z plus 123 ns: rows on both sides of an hour and of midnight. */
const NS = BigInt(Date.UTC(2026, 10, 19, 22, 59, 59, 500)) * 1_000_000n + 123n
const H = 3_600_000_000_000n
const read = async (f: EncodedSignalFile) => parquetReadObjects({ file: f.bytes.buffer.slice(f.bytes.byteOffset, f.bytes.byteOffset + f.bytes.byteLength) as ArrayBuffer })
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

const api = { resourceFp: 7n, resource: [['service.name', { s: 'api' }]] as [string, { s: string }][], scopeName: 'lib', scopeVersion: '1.0' }
const spansA = encodeSpanBatch([api], [
  { entry: 0, traceId: id(16, 1), spanId: id(8, 1), start: NS, end: NS + 5n, name: 'GET /a', kind: 2, attrs: [['http.route', { s: '/a' }]] },
  { entry: 0, traceId: id(16, 1), spanId: id(8, 2), parentSpanId: id(8, 1), start: NS + 1_000_000_000n, end: NS + 2_000_000_000n, name: 'db', kind: 3, status: 2 },
  { entry: 0, traceId: id(16, 3), spanId: id(8, 3), start: NS - H, end: NS - H + 1n, name: 'early' },
])
// A later batch rewrites span (1, 1) (the later row wins) and adds a span the next day.
const spansB = encodeSpanBatch([api], [
  { entry: 0, traceId: id(16, 1), spanId: id(8, 1), start: NS, end: NS + 7n, name: 'GET /a (again)', kind: 2 },
  { entry: 0, traceId: id(16, 4), spanId: id(8, 4), start: NS + 2n * H, end: NS + 2n * H + 9n, name: 'tomorrow' },
])
const stream = { labels: { service_name: 'api', env: 'prod' } }
const logs = encodeLogBatch([stream], [
  { entry: 0, ts: NS, line: 'a', metadata: [['user', 'ann']] },
  { entry: 0, ts: NS + 2n * H, line: 'b' },
  { entry: 0, ts: NS, line: 'a', metadata: [['user', 'ann']], severity: 9 }, // equal row key: one row, the later wins
  { entry: 0, ts: NS, line: 'a', metadata: [['user', 'bob']] }, // other metadata: another row
])

describe("encodeSpans and encodeLogs (ABI 3), mergeSignalFiles (ABI 4)", () => {
  it('exports the two encoders next to the metric operations', () => {
    expect(WebAssembly.Module.exports(wasm).map((e) => e.name).sort()).toEqual(['memory', 'viz_abi_version', 'viz_alloc', 'viz_encode_logs', 'viz_encode_segment', 'viz_encode_spans', 'viz_free', 'viz_free_file', 'viz_merge_files', 'viz_merge_signal_files', 'viz_select'])
  })

  it('spans: one file per hour of start, then trace_index per day; ms bounds are the floor of the ns bounds', async () => {
    const e = createEngine(wasm)
    const files = e.encodeSpans([spansA, spansB])
    expect(files.map((f) => [f.table, f.day, f.hour])).toEqual([
      ['spans', '2026-11-19', 21],
      ['spans', '2026-11-19', 22],
      ['spans', '2026-11-19', 23],
      ['spans', '2026-11-20', 0],
      ['trace_index', '2026-11-19', null],
      ['trace_index', '2026-11-20', null],
    ])
    for (const f of files) {
      expect(f.minTs).toBe(Number(BigInt(f.minNs) / 1_000_000n))
      expect(f.maxTs).toBe(Number(BigInt(f.maxNs) / 1_000_000n))
      expect(Number(parquetMetadata(f.bytes.buffer.slice(f.bytes.byteOffset) as ArrayBuffer).num_rows)).toBe(f.rows)
    }
    expect(files[1]!.minNs).toBe(String(NS))
    expect(files[1]!.minTs).toBe(Date.UTC(2026, 10, 19, 22, 59, 59, 500))
    // The rewritten span once, with its later name and end; its child a second later, in the next hour.
    const rows = [...(await read(files[1]!)), ...(await read(files[2]!))]
    expect(rows.map((r) => [hex(r.trace_id as Uint8Array), hex(r.span_id as Uint8Array), r.span_name, r.end_unix_nano])).toEqual([
      ['01'.repeat(16), '01'.repeat(8), 'GET /a (again)', NS + 7n],
      ['01'.repeat(16), '02'.repeat(8), 'db', NS + 2_000_000_000n],
    ])
    expect(rows[1]!.status_code).toBe(2)
    expect(hex(rows[1]!.parent_span_id as Uint8Array)).toBe('01'.repeat(8))
    // trace_index: traces 1 and 3 start on the 19th, trace 4 on the 20th; trace 1's fragment names hours 22 and 23.
    const idx = await read(files[4]!)
    expect(idx.map((r) => [hex(r.trace_id as Uint8Array), r.span_count, r.error_count, r.root_span_name])).toEqual([
      ['01'.repeat(16), 2, 1, 'GET /a (again)'],
      ['03'.repeat(16), 1, 0, 'early'],
    ])
    expect(idx[0]!.hours).toEqual([Number(NS / H), Number(NS / H) + 1])
  })

  it('logs: one file per day; rows equal on the row key are one', async () => {
    const e = createEngine(wasm)
    const files = e.encodeLogs([logs])
    expect(files.map((f) => [f.table, f.day, f.hour, f.rows])).toEqual([['logs', '2026-11-19', null, 2], ['logs', '2026-11-20', null, 1]])
    const rows = await read(files[0]!)
    expect(rows.map((r) => [r.stream_id, r.ts, r.line, r.metadata, r.severity_number])).toEqual([
      [streamId(stream.labels), NS, 'a', { user: 'ann' }, 9],
      [streamId(stream.labels), NS, 'a', { user: 'bob' }, null],
    ])
    expect(JSON.parse(files[0]!.index).streams[0][1]).toBe('{"env":"prod","service_name":"api"}')
  })

  it('a batch of another signal is an EngineError naming it; the instance stays usable; output is deterministic', () => {
    const e = createEngine(wasm)
    const metrics = encodeBatch([{ __name__: 'up', job: 'a' }], [{ series: 0, ts: 1, bits: bitsOf(1) }])
    expect(() => e.encodeSpans([spansA, logs])).toThrow(EngineError)
    expect(() => e.encodeSpans([metrics])).toThrow(/batch 0/)
    expect(() => e.encodeLogs([spansA])).toThrow(/batch 0/)
    expect(() => e.encodeSegment([logs])).toThrow(/batch 0/)
    expect(() => e.mergeFiles('spans' as never, [])).toThrow(/unknown table/)
    expect(e.instances()).toBe(1)
    expect(e.encodeSegment([metrics])).toHaveLength(2)
    const again = createEngine(wasm).encodeSpans([spansA, spansB])
    expect(again.map((f) => hex(f.bytes))).toEqual(e.encodeSpans([spansA, spansB]).map((f) => hex(f.bytes)))
    expect(e.encodeSpans([])).toEqual([])
  })

  it('mergeSignalFiles (ABI 4): spans per hour, trace_index and logs per day, the later input winning; read back by hyparquet', async () => {
    const e = createEngine(wasm)
    const a = e.encodeSpans([spansA])
    const b = e.encodeSpans([spansB])
    const at = (fs: EncodedSignalFile[], t: string, hour: number | null) => fs.find((f) => f.table === t && f.hour === hour)!
    // Hour 22 of the 19th: span (1, 1) from both units, the later one kept.
    const spans = e.mergeSignalFiles('spans', [at(a, 'spans', 22).bytes, at(b, 'spans', 22).bytes])
    expect([spans.table, spans.day, spans.hour, spans.rows]).toEqual(['spans', '2026-11-19', 22, 1])
    expect(spans.minNs).toBe(String(NS))
    expect(spans.minTs).toBe(Number(NS / 1_000_000n))
    expect((await read(spans)).map((r) => [r.span_name, r.end_unix_nano])).toEqual([['GET /a (again)', NS + 7n]])
    expect(JSON.parse(spans.index).rg).toHaveLength(1)
    // trace_index of the 19th: trace 1's two fragments merged into one row.
    const idx = e.mergeSignalFiles('trace_index', [at(a, 'trace_index', null).bytes, at(b, 'trace_index', null).bytes])
    const rows = await read(idx)
    expect(rows.map((r) => [hex(r.trace_id as Uint8Array), r.span_count, r.root_span_name])).toEqual([['01'.repeat(16), 3, 'GET /a (again)'], ['03'.repeat(16), 1, 'early']])
    // Logs: the same file twice is its rows once, with a token filter in the file that hyparquet skips.
    const day = e.encodeLogs([logs])[0]!
    const merged = e.mergeSignalFiles('logs', [day.bytes, day.bytes])
    expect(merged.rows).toBe(day.rows)
    expect((await read(merged)).map((r) => [r.line, r.metadata])).toEqual((await read(day)).map((r) => [r.line, r.metadata]))
    const tok = JSON.parse(merged.index).tok as [number, number]
    expect(new TextDecoder().decode(merged.bytes.subarray(tok[0], tok[0] + 4))).toBe('VZT1')
    // Errors are EngineErrors; the instance stays usable.
    expect(() => e.mergeSignalFiles('spans', [day.bytes])).toThrow(EngineError)
    expect(() => e.mergeSignalFiles('logs', [])).toThrow(/no input/)
    expect(() => e.mergeSignalFiles('metric_samples' as never, [day.bytes])).toThrow(RangeError)
    expect(e.instances()).toBe(1)
  })
})
