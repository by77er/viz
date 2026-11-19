// Remote Write 1.0 request encoding for the load generator: a protobuf `WriteRequest` and a
// snappy block. The snappy block is literals only (valid snappy, no compression), which
// makes bodies a little larger than a real sender's; the edge's decoder is the same either
// way. (The first S3 run's codec was not committed; this replaces it.)
const te = new TextEncoder()

class Pb {
  private parts: number[] = []
  varint(v: number | bigint): this {
    let n = BigInt.asUintN(64, BigInt(v))
    while (n >= 0x80n) {
      this.parts.push(Number(n & 0x7fn) | 0x80)
      n >>= 7n
    }
    this.parts.push(Number(n))
    return this
  }
  bytes(field: number, b: Uint8Array): this {
    this.varint((field << 3) | 2).varint(b.length)
    for (const x of b) this.parts.push(x)
    return this
  }
  string(field: number, s: string): this {
    return this.bytes(field, te.encode(s))
  }
  message(field: number, w: Pb): this {
    return this.bytes(field, w.finish())
  }
  double(field: number, v: number): this {
    this.varint((field << 3) | 1)
    const b = new Uint8Array(8)
    new DataView(b.buffer).setFloat64(0, v, true)
    for (const x of b) this.parts.push(x)
    return this
  }
  int(field: number, v: number): this {
    return this.varint(field << 3).varint(v)
  }
  finish(): Uint8Array {
    return new Uint8Array(this.parts)
  }
}

export interface Series {
  labels: [string, string][]
  samples: { ts: number; value: number }[]
}

export function writeRequest(series: Series[]): Uint8Array {
  const req = new Pb()
  for (const s of series) {
    const ts = new Pb()
    for (const [n, v] of s.labels) ts.message(1, new Pb().string(1, n).string(2, v))
    for (const x of s.samples) ts.message(2, new Pb().double(1, x.value).int(2, x.ts))
    req.message(1, ts)
  }
  return req.finish()
}

/** A snappy block of literals only. */
export function snappyCompress(src: Uint8Array): Uint8Array<ArrayBuffer> {
  const out: number[] = []
  let n = src.length
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80)
    n = Math.floor(n / 128)
  }
  out.push(n)
  for (let from = 0; from < src.length; ) {
    const len = Math.min(src.length - from, 65536)
    if (len <= 60) out.push((len - 1) << 2)
    else if (len <= 256) out.push(60 << 2, len - 1)
    else out.push(61 << 2, (len - 1) & 255, (len - 1) >>> 8)
    for (let i = 0; i < len; i++) out.push(src[from + i]!)
    from += len
  }
  return new Uint8Array(out)
}
