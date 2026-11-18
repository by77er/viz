import * as snappyjs from 'snappyjs'
import { describe, expect, it } from 'vitest'
import { Collector, buildBatches, fnv1a64, seriesIdInput } from '../src/batch'
import { HttpError } from '../src/errors'
import { DEFAULT_LIMITS } from '../src/limits'
import { PbReader } from '../src/pb'
import { snappyDecompress } from '../src/snappy'
import { PY_VECTORS, PbWriter, bitsOf, checkCanonical, decodeVZB1, refSeriesId, snappyCompress } from './helpers'

const te = new TextEncoder()

/** Deterministic PRNG so failures reproduce. */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}

const status = (fn: () => unknown): number => {
  try {
    fn()
  } catch (e) {
    if (e instanceof HttpError) return e.status
    throw e
  }
  return 0
}

/** Feed label strings to a Collector the way a decoder does. */
function addSeries(c: Collector, labels: [string, string][]): number {
  const parts: Uint8Array[] = []
  const offs: number[] = []
  let p = 0
  for (const [n, v] of labels) {
    const nb = te.encode(n)
    const vb = te.encode(v)
    offs.push(p, p + nb.length, p + nb.length, p + nb.length + vb.length)
    p += nb.length + vb.length
    parts.push(nb, vb)
  }
  const buf = new Uint8Array(p)
  let q = 0
  for (const part of parts) {
    buf.set(part, q)
    q += part.length
  }
  return c.addSeries(buf, Int32Array.from(offs), labels.length)
}

const entryId = (c: Collector, i: number): bigint => {
  const e = c.entry(i)
  return new DataView(e.buffer, e.byteOffset, e.byteLength).getBigInt64(0, true)
}

describe('series id (FNV-1a 64)', () => {
  it('matches vectors computed independently in Python', () => {
    expect(fnv1a64(new Uint8Array(0))).toBe(-3750763034362895579n)
    for (const [id, labels] of PY_VECTORS) {
      expect(fnv1a64(seriesIdInput(labels))).toBe(id)
      expect(refSeriesId(labels)).toBe(id)
      const c = new Collector(DEFAULT_LIMITS, Date.now())
      expect(entryId(c, addSeries(c, labels))).toBe(id)
    }
  })

  it('is the same whatever order the sender put the labels in, and ignores empty values', () => {
    const [id, labels] = PY_VECTORS[1]!
    const c = new Collector(DEFAULT_LIMITS, Date.now())
    const a = addSeries(c, labels)
    const b = addSeries(c, [...labels].reverse())
    const d = addSeries(c, [['zzz', ''], ...labels, ['aaa', '']])
    expect([a, b, d]).toEqual([0, 0, 0])
    expect(c.nSeries).toBe(1)
    expect(entryId(c, 0)).toBe(id)
  })

  it('32-bit-halves implementation equals the BigInt reference on random label sets', () => {
    const r = rng(7)
    const alphabet = ['a', 'Z', '_', '9', 'é', 'ß', '🌡', '\u{ffff}', '\u{10000}', '\x7f', ' ', '中']
    const word = (max: number) => Array.from({ length: 1 + Math.floor(r() * max) }, () => alphabet[Math.floor(r() * alphabet.length)]).join('')
    const c = new Collector({ ...DEFAULT_LIMITS, maxSeries: 1e6 }, Date.now())
    for (let i = 0; i < 2000; i++) {
      const m = new Map<string, string>([['__name__', word(20)]])
      for (let j = Math.floor(r() * 8); j > 0; j--) m.set(word(6), word(40))
      const labels = [...m]
      const idx = addSeries(c, labels)
      expect(idx).toBeGreaterThanOrEqual(0)
      // The entry must be canonical (sorted by UTF-8 bytes, not UTF-16 units) and carry the reference id.
      const batch = decodeVZB1(buildBatches(oneRow(c, idx), new Int32Array(c.nSeries), 1 << 20).get(0)![0]!.bytes)
      checkCanonical(batch.series[0]!)
      expect(batch.series[0]!.id).toBe(fnv1a64(seriesIdInput(batch.series[0]!.labels)))
      expect(new Map(batch.series[0]!.labels)).toEqual(m)
    }
  })
})

/** A collector view with exactly one row, for series `idx`. */
function oneRow(c: Collector, idx: number): Collector {
  c.nRows = 0
  c.addSampleNumber(idx, Date.now(), 1)
  return c
}

describe('label validation', () => {
  const c = () => new Collector({ ...DEFAULT_LIMITS, maxLabelsPerSeries: 3, maxLabelNameBytes: 8, maxLabelValueBytes: 5 }, Date.now())
  it('rejects what the contract forbids and accepts the boundary', () => {
    expect(addSeries(c(), [['__name__', 'a'], ['b', '12345'], ['c', 'x']])).toBe(0)
    expect(addSeries(c(), [['job', 'a']])).toBeLessThan(0) // no __name__
    expect(addSeries(c(), [['__name__', 'a'], ['b', '1'], ['b', '2']])).toBeLessThan(0) // duplicate
    expect(addSeries(c(), [['__name__', 'a'], ['b', '1'], ['c', '2'], ['d', '3']])).toBeLessThan(0) // too many
    expect(addSeries(c(), [['__name__', 'a'], ['b', '1'], ['c', '2'], ['d', '']])).toBe(0) // empty value does not count
    expect(addSeries(c(), [['__name__', 'a'], ['bbbbbbbbb', '1']])).toBeLessThan(0) // name too long
    expect(addSeries(c(), [['__name__', 'a'], ['b', '123456']])).toBeLessThan(0) // value too long
    expect(addSeries(c(), [['__name__', 'a'], ['', '1']])).toBeLessThan(0) // empty name
    expect(addSeries(c(), [['__name__', 'a'], ['b', '1\u00002']])).toBeLessThan(0) // NUL would make the id ambiguous
  })

  it('rejects invalid UTF-8', () => {
    const buf = new Uint8Array([...te.encode('__name__'), 0xff, 0xfe])
    expect(c().addSeries(buf, Int32Array.of(0, 8, 8, 10), 1)).toBeLessThan(0)
  })
})

describe('batch encoding', () => {
  it('splits a slot into batches under the size limit, keeping every row in arrival order', () => {
    const now = Date.now()
    const c = new Collector(DEFAULT_LIMITS, now)
    const sent: { name: string; ts: number; v: number }[] = []
    for (let i = 0; i < 5000; i++) {
      const name = `metric_${i % 700}`
      const idx = addSeries(c, [['__name__', name], ['job', 'j']])
      c.addSampleNumber(idx, now - i, i * 0.5)
      sent.push({ name, ts: now - i, v: i * 0.5 })
    }
    const max = 8192
    const batches = buildBatches(c, new Int32Array(c.nSeries).fill(3), max).get(3)!
    expect(batches.length).toBeGreaterThan(5)
    const got: typeof sent = []
    for (const b of batches) {
      expect(b.bytes.length).toBeLessThanOrEqual(max)
      const d = decodeVZB1(b.bytes)
      expect(d.rows.length).toBe(b.rows)
      d.series.forEach(checkCanonical)
      // No series is listed without a row, none twice.
      expect(new Set(d.rows.map((r) => r.series)).size).toBe(d.series.length)
      expect(new Set(d.series.map((s) => s.id)).size).toBe(d.series.length)
      for (const r of d.rows) got.push({ name: d.series[r.series]!.labels[0]![1], ts: Number(r.ts), v: new DataView(new BigUint64Array([r.bits]).buffer).getFloat64(0, true) })
    }
    expect(got).toEqual(sent)
  })

  it('writes every timestamp of the contract range as an exact i64, and rejects everything outside it', () => {
    // However wide the accept window is configured, the contract range 0..253402300799999 bounds it.
    const c = new Collector({ ...DEFAULT_LIMITS, acceptBackMs: Infinity, acceptAheadMs: Infinity }, 0)
    const idx = addSeries(c, [['__name__', 'a']])
    const MAX = 253_402_300_799_999 // 9999-12-31T23:59:59.999Z
    expect(new Date(MAX).toISOString()).toBe('9999-12-31T23:59:59.999Z')
    const ts = [0, 1, 4294967295, 4294967296, 1700000000123, MAX - 1, MAX]
    for (const t of ts) c.addSampleNumber(idx, t, 0)
    const outside = [-1, -4294967296, Number.MIN_SAFE_INTEGER, MAX + 1, Number.MAX_SAFE_INTEGER, NaN, Infinity, -Infinity]
    for (const t of outside) c.addSampleNumber(idx, t, 0)
    expect(c.rejectedTotal).toBe(outside.length)
    expect(Object.fromEntries(c.rejected)).toEqual({ 'timestamp older than the accept window': 5, 'timestamp too far in the future': 3 })
    const d = decodeVZB1(buildBatches(c, new Int32Array(1), 1 << 20).get(0)![0]!.bytes)
    expect(d.rows.map((r) => r.ts)).toEqual(ts.map(BigInt))
  })
})

describe('snappy block decompressor', () => {
  const inputs = (): Uint8Array[] => {
    const r = rng(42)
    const random = (n: number) => Uint8Array.from({ length: n }, () => Math.floor(r() * 256))
    const texty = (n: number) => te.encode(Array.from({ length: n }, (_, i) => `job="svc-${i % 13}",instance="10.0.0.${i % 31}:9100",le="${(i % 7) * 0.25}";`).join(''))
    return [new Uint8Array(0), te.encode('a'), random(1), random(61), random(300), random(70_000), texty(10), texty(3000), new Uint8Array(200_000).fill(7), te.encode('abcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabc')]
  }

  it('inverts the reference implementation (snappyjs) and the test compressor', () => {
    for (const input of inputs()) {
      expect(snappyDecompress(snappyjs.compress(input), 1 << 24)).toEqual(input)
      const mine = snappyCompress(input)
      expect(snappyDecompress(mine, 1 << 24)).toEqual(input)
      // …and the test compressor itself is valid snappy according to snappyjs.
      expect(new Uint8Array(snappyjs.uncompress(mine))).toEqual(input)
    }
  })

  it('handles every element type, including overlapping and 4-byte-offset copies', () => {
    // len=13: literal "ab" (tag 0x04), copy1 len 4 offset 2 (overlapping), copy2 len 3 offset 6, copy4 len 4 offset 1
    const stream = new Uint8Array([13, 0x04, 0x61, 0x62, 0x01, 0x02, 0x02 | (2 << 2), 0x06, 0x00, 0x03 | (3 << 2), 0x01, 0x00, 0x00, 0x00])
    expect(new TextDecoder().decode(snappyDecompress(stream, 100))).toBe('ababababaaaaa')
    // 2-byte literal length (tag 61): 300 bytes
    const lit = new Uint8Array(300).map((_, i) => i & 255)
    expect(snappyDecompress(new Uint8Array([0xac, 0x02, 61 << 2, 299 & 255, 299 >>> 8, ...lit]), 1000)).toEqual(lit)
  })

  it('refuses hostile input instead of reading or writing out of range', () => {
    const max = 1 << 20
    expect(status(() => snappyDecompress(new Uint8Array([]), max))).toBe(400)
    expect(status(() => snappyDecompress(new Uint8Array([0x80]), max))).toBe(400) // truncated preamble
    expect(status(() => snappyDecompress(new Uint8Array([5, 0x04, 0x61]), max))).toBe(400) // literal runs past input
    expect(status(() => snappyDecompress(new Uint8Array([2, 0x08, 0x61, 0x62, 0x63]), max))).toBe(400) // literal longer than declared
    // The declared length (5) is consistent in these three, so only the copy's own bounds can refuse them.
    expect(status(() => snappyDecompress(new Uint8Array([5, 0x00, 0x61, 0x01, 0x05]), max))).toBe(400) // copy offset before start
    expect(status(() => snappyDecompress(new Uint8Array([5, 0x00, 0x61, 0x01, 0x00]), max))).toBe(400) // copy offset 0
    expect(status(() => snappyDecompress(new Uint8Array([5, 0x00, 0x61, 0x02 | (3 << 2), 0x02, 0x00]), max))).toBe(400) // 2-byte offset before start
    expect(status(() => snappyDecompress(new Uint8Array([3, 0x00, 0x61]), max))).toBe(400) // shorter than declared
    expect(status(() => snappyDecompress(new Uint8Array([2, 0x00, 0x61, 0x05, 0x01]), max))).toBe(400) // copy past declared length
    // A 4 GiB declaration is refused before anything is allocated.
    expect(status(() => snappyDecompress(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0x0f, 0x00]), max))).toBe(413)
    expect(status(() => snappyDecompress(snappyjs.compress(new Uint8Array(1001)), 1000))).toBe(413)
    expect(snappyDecompress(snappyjs.compress(new Uint8Array(1000)), 1000).length).toBe(1000)
    // Random garbage never throws anything but a 400/413.
    const r = rng(99)
    for (let i = 0; i < 3000; i++) {
      const junk = Uint8Array.from({ length: 1 + Math.floor(r() * 40) }, () => Math.floor(r() * 256))
      expect([0, 400, 413]).toContain(status(() => snappyDecompress(junk, 4096)))
    }
  })
})

describe('protobuf reader', () => {
  it('reads varints of every length exactly', () => {
    const values = [0n, 1n, 127n, 128n, 300n, 2n ** 28n - 1n, 2n ** 28n, 2n ** 32n - 1n, 2n ** 32n, 2n ** 35n + 5n, 2n ** 53n - 1n, 2n ** 63n - 1n, -1n, -(2n ** 63n), -1700000000000n]
    const w = new PbWriter()
    for (const v of values) w.varint(v)
    const r = new PbReader(w.finish())
    for (const v of values) {
      r.varint64()
      expect(r.int64Big()).toBe(BigInt.asIntN(64, v))
      if (v >= -(2n ** 53n) && v <= 2n ** 53n) expect(r.int64()).toBe(Number(BigInt.asIntN(64, v)))
    }
    expect(r.pos).toBe(r.end)
  })

  it('rejects truncated and over-long input with 400', () => {
    expect(status(() => new PbReader(new Uint8Array([0x80])).varint64())).toBe(400)
    expect(status(() => new PbReader(new Uint8Array(11).fill(0x80)).varint64())).toBe(400)
    expect(status(() => new PbReader(new Uint8Array([5, 1, 2])).len())).toBe(400)
    expect(status(() => new PbReader(new Uint8Array([1, 2, 3])).fixed64At())).toBe(400)
    expect(status(() => new PbReader(new Uint8Array([1])).skip(3))).toBe(400)
    expect(bitsOf(1)).toBe(0x3ff0000000000000n)
  })
})
