/**
 * Prometheus Remote Write 1.0 request bodies, with no dependencies: a protobuf encoder for
 * the messages Remote Write uses and a snappy block "compressor" that emits literals only
 * (valid snappy; edge's decoder reads it). The same encoding deploy/lib/prw.mjs uses for the
 * smoke test, written here so the app's tools do not depend on deploy/ (another engineer's).
 */

export interface WriteSeries {
  labels: Record<string, string>
  /** [timestamp in ms, value] */
  samples: [number, number][]
}

class Bytes {
  buf = new Uint8Array(1 << 16)
  n = 0
  push(b: number): void {
    if (this.n === this.buf.length) {
      const next = new Uint8Array(this.buf.length * 2)
      next.set(this.buf)
      this.buf = next
    }
    this.buf[this.n++] = b
  }
  pushAll(bytes: Uint8Array): void {
    for (let i = 0; i < bytes.length; i++) this.push(bytes[i]!)
  }
  bytes(): Uint8Array {
    return this.buf.subarray(0, this.n)
  }
}

function varint(n: number | bigint, out: Bytes): void {
  let v = BigInt(n)
  if (v < 0n) v += 1n << 64n
  do {
    let b = Number(v & 0x7fn)
    v >>= 7n
    if (v > 0n) b |= 0x80
    out.push(b)
  } while (v > 0n)
}

function lenField(field: number, bytes: Uint8Array, out: Bytes): void {
  out.push((field << 3) | 2)
  varint(bytes.length, out)
  out.pushAll(bytes)
}

const utf8 = (s: string) => new TextEncoder().encode(s)

/** WriteRequest { repeated TimeSeries timeseries = 1 } with Label { name = 1, value = 2 } and Sample { double value = 1, int64 timestamp = 2 }. */
export function encodeWriteRequest(series: WriteSeries[]): Uint8Array {
  const out = new Bytes()
  const f = new DataView(new ArrayBuffer(8))
  for (const s of series) {
    const ts = new Bytes()
    for (const name of Object.keys(s.labels).sort()) {
      const l = new Bytes()
      lenField(1, utf8(name), l)
      lenField(2, utf8(s.labels[name]!), l)
      lenField(1, l.bytes(), ts)
    }
    for (const [t, v] of s.samples) {
      const sm = new Bytes()
      sm.push(0x09)
      f.setFloat64(0, v, true)
      for (let i = 0; i < 8; i++) sm.push(f.getUint8(i))
      sm.push(0x10)
      varint(t, sm)
      lenField(2, sm.bytes(), ts)
    }
    lenField(1, ts.bytes(), out)
  }
  return out.bytes().slice()
}

/** Snappy block format, literals only. */
export function snappyLiterals(input: Uint8Array): Uint8Array {
  const out = new Bytes()
  varint(input.length, out)
  for (let off = 0; off < input.length; off += 65536) {
    const chunk = input.subarray(off, Math.min(off + 65536, input.length))
    const n = chunk.length - 1
    if (n < 60) out.push(n << 2)
    else if (n < 256) {
      out.push(60 << 2)
      out.push(n)
    } else {
      out.push(61 << 2)
      out.push(n & 0xff)
      out.push(n >> 8)
    }
    out.pushAll(chunk)
  }
  return out.bytes().slice()
}

export const remoteWriteBody = (series: WriteSeries[]): Uint8Array => snappyLiterals(encodeWriteRequest(series))

export function remoteWriteHeaders(key: string): Record<string, string> {
  return {
    Authorization: `Bearer ${key}`,
    'Content-Encoding': 'snappy',
    'Content-Type': 'application/x-protobuf',
    'X-Prometheus-Remote-Write-Version': '0.1.0',
    'User-Agent': 'viz-app-seed/1',
  }
}
