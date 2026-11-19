/**
 * The JavaScript binding of the viz engine: the storage half of `contracts/engine.ts`
 * (`encodeSegment`, `select`, `mergeFiles`), the flush of spans and logs
 * (`SignalFlushEngine`: `encodeSpans`, `encodeLogs`, ABI 3) and their compaction
 * (`SignalMergeEngine`: `mergeSignalFiles`, ABI 4) over the C ABI documented in `../src/lib.rs`.
 *
 * Number rules (contracts/engine.ts):
 *  - Times going in must be integers. `select` refuses a fractional or NaN bound instead of
 *    rounding it; ±Infinity are accepted and clamped to the i64 range.
 *  - Sample values are copied as raw bytes from WASM memory into a `Float64Array`'s
 *    backing buffer. No element is ever read as a number and written back, so NaN
 *    payloads (staleness markers) survive bit for bit.
 *
 * Memory: a request is written straight into WASM linear memory, one copy per input
 * buffer; results are copied out once and the WASM side is freed before returning.
 * Linear memory never shrinks, so `memoryBytes()` is the high-water mark of the instance.
 *
 * A trap (the Rust side is built with panic=abort) leaves an instance in an unknown state.
 * The binding then drops the instance and creates a fresh one for the next call.
 */
import type { EncodedFile, EncodedSignalFile, Engine, Matcher, ScanInput, SeriesData, SignalFlushEngine, SignalMergeEngine } from '../../../contracts/engine'
import type { SignalTable, Table } from '../../../contracts/ledger'

/** `contracts/engine.ts`: `SignalFlushEngine` needs ABI 3, `SignalMergeEngine` ABI 4. */
export const ABI_VERSION = 4

interface Exports {
  memory: WebAssembly.Memory
  viz_abi_version(): number
  viz_alloc(len: number): number
  viz_free(ptr: number, len: number): void
  viz_encode_segment(ptr: number, len: number): number
  viz_select(ptr: number, len: number): number
  viz_merge_files(ptr: number, len: number): number
  viz_free_file(ptr: number, cap: number): void
  viz_encode_spans(ptr: number, len: number): number
  viz_encode_logs(ptr: number, len: number): number
  viz_merge_signal_files(ptr: number, len: number): number
}

/** An error the engine reported (malformed batch, bad matcher, corrupt file). */
export class EngineError extends Error {
  override name = 'EngineError'
}

export interface VizEngine extends Engine, SignalFlushEngine, SignalMergeEngine {
  /** Size of the instance's linear memory now, which is also its peak: it only grows. */
  memoryBytes(): number
  /** How many times a WASM instance has been created (1, plus one per trap). */
  instances(): number
  /** Drop the instance so its memory can be reclaimed; the next call creates a new one. */
  reset(): void
}

const OPS: Record<Matcher['op'], number> = { '=': 0, '!=': 1, '=~': 2, '!~': 3 }
const TABLES: readonly Table[] = ['metric_samples', 'metric_series']
/** Table bytes of an ABI 3 result (`viz_encode_spans`, `viz_encode_logs`). */
const SIGNAL_TABLES: Record<number, EncodedSignalFile['table']> = { 2: 'spans', 3: 'trace_index', 4: 'logs' }
const SIGNAL_TABLE_BYTES: Record<SignalTable, number> = { spans: 2, trace_index: 3, logs: 4 }
const NS_PER_MS = 1_000_000n
/** The floor of a Unix nanosecond in milliseconds (the ledger's bounds, contracts/engine.ts `EncodedSignalFile`). */
const floorMs = (ns: bigint): number => Number(ns >= 0n ? ns / NS_PER_MS : -((-ns + NS_PER_MS - 1n) / NS_PER_MS))
const I64_MIN = -(2n ** 63n)
const I64_MAX = 2n ** 63n - 1n
const utf8 = new TextEncoder()
const text = new TextDecoder('utf-8', { fatal: true })

const notBuilt = (name: string): never => {
  throw new Error(`engine: ${name} is not built yet (the PromQL crate is not linked into this module)`)
}

function time(name: string, v: number): bigint {
  if (v === Infinity) return I64_MAX
  if (v === -Infinity) return I64_MIN
  if (typeof v !== 'number' || !Number.isInteger(v)) throw new RangeError(`engine: ${name} must be an integer number of milliseconds, got ${v}`)
  return BigInt(v)
}

/**
 * Create an engine from the compiled module (`import wasm from './viz_engine.wasm'` in a
 * Worker). Instantiation is synchronous and lazy: nothing is allocated until first use.
 */
export function createEngine(module: WebAssembly.Module): VizEngine {
  let x: Exports | null = null
  let created = 0

  const instance = (): Exports => {
    if (x) return x
    const made = new WebAssembly.Instance(module, {}).exports as unknown as Exports
    if (made.viz_abi_version() !== ABI_VERSION) throw new Error(`engine: module ABI ${made.viz_abi_version()}, binding expects ${ABI_VERSION}`)
    created++
    x = made
    return made
  }

  /**
   * Run one operation: `size` bytes of request written by `write`, result read by `read`.
   * Views over WASM memory are taken after every call that can grow it, never kept.
   */
  function call<T>(op: 'viz_encode_segment' | 'viz_select' | 'viz_merge_files' | 'viz_encode_spans' | 'viz_encode_logs' | 'viz_merge_signal_files', size: number, write: (mem: Uint8Array, at: number) => void, read: (payload: Uint8Array) => T): T {
    if (size > 0xffff_ffff) throw new RangeError('engine: request larger than 4 GiB')
    const w = instance()
    let req = 0
    let res = 0
    let total = 0
    try {
      req = w.viz_alloc(size)
      write(new Uint8Array(w.memory.buffer), req)
      res = w[op](req, size)
      w.viz_free(req, size)
      req = 0
      const mem = new Uint8Array(w.memory.buffer)
      const head = new DataView(w.memory.buffer, res, 8)
      total = head.getUint32(0, true)
      const status = head.getUint32(4, true)
      const payload = mem.subarray(res + 8, res + total)
      if (status !== 0) throw new EngineError(new TextDecoder().decode(payload))
      return read(payload)
    } catch (e) {
      // Anything that is not the engine's own error message means the instance may be
      // corrupt (a trap, out of memory): never reuse it.
      if (!(e instanceof EngineError)) x = null
      throw e
    } finally {
      if (x === w) {
        if (req !== 0) w.viz_free(req, size)
        if (res !== 0) w.viz_free(res, total)
      }
    }
  }

  /** Read `n` files (the layout shared by `viz_encode_segment` and `viz_merge_files`) starting at `p`. */
  function readFiles(payload: Uint8Array, p: number, n: number): EncodedFile[] {
    const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
    const chunk = (): Uint8Array => {
      const len = dv.getUint32(p, true)
      p += 4 + len
      return payload.subarray(p - len, p)
    }
    const files: EncodedFile[] = []
    for (let i = 0; i < n; i++) {
      const table = TABLES[payload[p]!]
      if (!table) throw new Error('engine: unknown table in result')
      // u64/i64 as BigInt, then to Number: row counts and timestamps are far below 2^53.
      const rows = Number(dv.getBigUint64(p + 4, true))
      const minTs = Number(dv.getBigInt64(p + 12, true))
      const maxTs = Number(dv.getBigInt64(p + 20, true))
      p += 28
      const day = text.decode(chunk())
      const index = text.decode(chunk())
      const bytes = chunk().slice() // copy out of WASM memory before it is freed
      files.push({ table, day, bytes, rows, minTs, maxTs, index })
    }
    return files
  }

  /** `u32 n, (u32 len, batch)*`: the request of every encoder. */
  const batchesSize = (batches: Uint8Array[]): number => {
    let size = 4
    for (const b of batches) size += 4 + b.byteLength
    return size
  }
  const writeBatches = (batches: Uint8Array[]) => (mem: Uint8Array, at: number) => {
    const dv = new DataView(mem.buffer)
    dv.setUint32(at, batches.length, true)
    let p = at + 4
    for (const b of batches) {
      dv.setUint32(p, b.byteLength, true)
      mem.set(b, p + 4)
      p += 4 + b.byteLength
    }
  }

  function encodeSegment(batches: Uint8Array[]): EncodedFile[] {
    return call('viz_encode_segment', batchesSize(batches), writeBatches(batches), (payload) =>
      readFiles(payload, 4, new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(0, true)),
    )
  }

  /**
   * The files of an ABI 3 result. Times come out of the module in nanoseconds (i64); the
   * ledger's `minTs`/`maxTs` are their floor in milliseconds, computed with BigInt (a Unix
   * nanosecond does not fit a JS number), and the exact bounds are kept as decimal strings.
   */
  function readSignalFiles(payload: Uint8Array): EncodedSignalFile[] {
    const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
    let p = 4
    const chunk = (): Uint8Array => {
      const len = dv.getUint32(p, true)
      p += 4 + len
      return payload.subarray(p - len, p)
    }
    const n = dv.getUint32(0, true)
    const files: EncodedSignalFile[] = []
    for (let i = 0; i < n; i++) {
      const table = SIGNAL_TABLES[payload[p]!]
      if (!table) throw new Error('engine: unknown table in result')
      const hourByte = payload[p + 1]!
      const hour = hourByte === 255 ? null : hourByte
      if ((table === 'spans') !== (hour !== null) || (hour !== null && hour > 23)) throw new Error('engine: a span file without its hour, or an hour on another table')
      const rows = Number(dv.getBigUint64(p + 4, true))
      const minNs = dv.getBigInt64(p + 12, true)
      const maxNs = dv.getBigInt64(p + 20, true)
      p += 28
      const day = text.decode(chunk())
      const index = text.decode(chunk())
      const bytes = chunk().slice() // copy out of WASM memory before it is freed
      files.push({ table, hour, day, bytes, rows, minTs: floorMs(minNs), maxTs: floorMs(maxNs), minNs: String(minNs), maxNs: String(maxNs), index })
    }
    return files
  }

  function encodeSpans(batches: Uint8Array[]): EncodedSignalFile[] {
    return call('viz_encode_spans', batchesSize(batches), writeBatches(batches), readSignalFiles)
  }

  function encodeLogs(batches: Uint8Array[]): EncodedSignalFile[] {
    return call('viz_encode_logs', batchesSize(batches), writeBatches(batches), readSignalFiles)
  }

  function mergeFiles(table: Table, files: Uint8Array[]): EncodedFile {
    const t = TABLES.indexOf(table)
    if (t < 0) throw new RangeError(`engine: unknown table ${String(table)}`)
    let size = 8
    for (const f of files) size += 4 + f.byteLength
    return call(
      'viz_merge_files',
      size,
      (mem, at) => {
        const dv = new DataView(mem.buffer)
        dv.setUint32(at, t, true) // u8 table, u8[3] zero
        dv.setUint32(at + 4, files.length, true)
        let p = at + 8
        for (const f of files) {
          dv.setUint32(p, f.byteLength, true)
          mem.set(f, p + 4)
          p += 4 + f.byteLength
        }
      },
      (payload) => {
        // The header only: the file stays where the writer left it (see ../src/lib.rs).
        const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
        let p = 28
        const str = (): string => {
          const len = dv.getUint32(p, true)
          p += 4 + len
          return text.decode(payload.subarray(p - len, p))
        }
        const out = TABLES[payload[0]!]
        if (!out) throw new Error('engine: unknown table in result')
        const rows = Number(dv.getBigUint64(4, true))
        const minTs = Number(dv.getBigInt64(12, true))
        const maxTs = Number(dv.getBigInt64(20, true))
        const day = str()
        const index = str()
        const [ptr, len, cap] = [dv.getUint32(p, true), dv.getUint32(p + 8, true), dv.getUint32(p + 16, true)] // u64 each; wasm32 uses the low half
        const w = instance()
        const bytes = new Uint8Array(w.memory.buffer, ptr, len).slice() // the one copy out
        w.viz_free_file(ptr, cap)
        return { table: out, day, bytes, rows, minTs, maxTs, index }
      },
    )
  }

  /** `viz_merge_signal_files`: as `mergeFiles`, with the header of an ABI 3 signal file. */
  function mergeSignalFiles(table: SignalTable, files: Uint8Array[]): EncodedSignalFile {
    const t = SIGNAL_TABLE_BYTES[table]
    if (t === undefined) throw new RangeError(`engine: unknown signal table ${String(table)}`)
    let size = 8
    for (const f of files) size += 4 + f.byteLength
    return call(
      'viz_merge_signal_files',
      size,
      (mem, at) => {
        const dv = new DataView(mem.buffer)
        dv.setUint32(at, t, true) // u8 table, u8[3] zero
        dv.setUint32(at + 4, files.length, true)
        let p = at + 8
        for (const f of files) {
          dv.setUint32(p, f.byteLength, true)
          mem.set(f, p + 4)
          p += 4 + f.byteLength
        }
      },
      (payload) => {
        const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
        let p = 28
        const str = (): string => {
          const len = dv.getUint32(p, true)
          p += 4 + len
          return text.decode(payload.subarray(p - len, p))
        }
        const out = SIGNAL_TABLES[payload[0]!]
        if (out !== table) throw new Error('engine: the merge answered another table')
        const hourByte = payload[1]!
        const hour = hourByte === 255 ? null : hourByte
        if ((out === 'spans') !== (hour !== null) || (hour !== null && hour > 23)) throw new Error('engine: a span file without its hour, or an hour on another table')
        const rows = Number(dv.getBigUint64(4, true))
        const minNs = dv.getBigInt64(12, true)
        const maxNs = dv.getBigInt64(20, true)
        const day = str()
        const index = str()
        // The file in chunks: each copied out into one buffer and released at once (u64 each; wasm32 uses the low half).
        const total = Number(dv.getBigUint64(p, true))
        const n = dv.getUint32(p + 8, true)
        p += 12
        const w = instance()
        const bytes = new Uint8Array(total)
        let at = 0
        for (let i = 0; i < n; i++, p += 24) {
          const [ptr, len, cap] = [dv.getUint32(p, true), dv.getUint32(p + 8, true), dv.getUint32(p + 16, true)]
          bytes.set(new Uint8Array(w.memory.buffer, ptr, len), at)
          at += len
          w.viz_free_file(ptr, cap)
        }
        if (at !== total) throw new Error(`engine: merged chunks hold ${at} bytes of ${total}`)
        return { table: out, hour, day, bytes, rows, minTs: floorMs(minNs), maxTs: floorMs(maxNs), minNs: String(minNs), maxNs: String(maxNs), index }
      },
    )
  }

  function select(input: ScanInput, matchers: Matcher[], minTs: number, maxTs: number): SeriesData[] {
    const lo = time('minTs', minTs)
    const hi = time('maxTs', maxTs)
    const lists = [input.seriesFiles, input.sampleFiles, input.tailBatches]
    const encoded = matchers.map((m) => {
      const op = OPS[m.op]
      if (op === undefined) throw new RangeError(`engine: unknown matcher operator ${String(m.op)}`)
      return { op, name: utf8.encode(m.name), value: utf8.encode(m.value) }
    })
    let size = 32
    for (const list of lists) for (const b of list) size += 4 + b.byteLength
    for (const m of encoded) size += 9 + m.name.byteLength + m.value.byteLength
    return call(
      'viz_select',
      size,
      (mem, at) => {
        const dv = new DataView(mem.buffer)
        dv.setBigInt64(at, lo, true)
        dv.setBigInt64(at + 8, hi, true)
        dv.setUint32(at + 16, lists[0]!.length, true)
        dv.setUint32(at + 20, lists[1]!.length, true)
        dv.setUint32(at + 24, lists[2]!.length, true)
        dv.setUint32(at + 28, encoded.length, true)
        let p = at + 32
        for (const list of lists) {
          for (const b of list) {
            dv.setUint32(p, b.byteLength, true)
            mem.set(b, p + 4)
            p += 4 + b.byteLength
          }
        }
        for (const m of encoded) {
          mem[p] = m.op
          dv.setUint32(p + 1, m.name.byteLength, true)
          mem.set(m.name, p + 5)
          p += 5 + m.name.byteLength
          dv.setUint32(p, m.value.byteLength, true)
          mem.set(m.value, p + 4)
          p += 4 + m.value.byteLength
        }
      },
      (payload) => {
        const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
        let p = 0
        const str = (): string => {
          const n = dv.getUint32(p, true)
          p += 4 + n
          return text.decode(payload.subarray(p - n, p))
        }
        const n = dv.getUint32(p, true)
        p += 4
        const out: SeriesData[] = new Array(n)
        for (let i = 0; i < n; i++) {
          const nLabels = dv.getUint32(p, true)
          p += 4
          const labels: Record<string, string> = {}
          for (let l = 0; l < nLabels; l++) {
            const name = str()
            // defineProperty, so a label called `__proto__` is an ordinary own property.
            Object.defineProperty(labels, name, { value: str(), enumerable: true, writable: true, configurable: true })
          }
          const rows = dv.getUint32(p, true)
          p = (p + 4 + 7) & ~7
          // Raw byte copies into the arrays' buffers: no f64 is read and written back.
          const ts = new Float64Array(rows)
          new Uint8Array(ts.buffer).set(payload.subarray(p, p + 8 * rows))
          p += 8 * rows
          const values = new Float64Array(rows)
          new Uint8Array(values.buffer).set(payload.subarray(p, p + 8 * rows))
          p += 8 * rows
          out[i] = { labels, ts, values }
        }
        return out
      },
    )
  }

  return {
    encodeSegment,
    encodeSpans,
    encodeLogs,
    select,
    mergeFiles,
    mergeSignalFiles,
    queryRange: () => notBuilt('queryRange'),
    queryInstant: () => notBuilt('queryInstant'),
    selectors: () => notBuilt('selectors'),
    memoryBytes: () => (x ? x.memory.buffer.byteLength : 0),
    instances: () => created,
    reset: () => {
      x = null
    },
  }
}
