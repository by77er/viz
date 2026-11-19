import { badRequest } from './errors'

/**
 * A minimal protobuf wire-format reader: varints, fixed 32/64, length-delimited ranges and
 * skipping. No schema, no allocation per field. Every read is bounds-checked against the
 * buffer; callers check nested message ends with `done(end)`.
 */
export class PbReader {
  pos: number
  readonly end: number
  /** Halves of the last value read by `varint64` / `fixed64`. */
  lo = 0
  hi = 0

  constructor(readonly buf: Uint8Array, pos = 0, end = buf.length) {
    this.pos = pos
    this.end = end
  }

  private byte(): number {
    if (this.pos >= this.end) throw badRequest('malformed protobuf: truncated')
    return this.buf[this.pos++]!
  }

  /** Reads a varint into `lo`/`hi` (unsigned 32-bit halves of the 64-bit value). */
  varint64(): void {
    let lo = 0
    let hi = 0
    let b = 0
    for (let i = 0; i < 4; i++) {
      b = this.byte()
      lo |= (b & 127) << (7 * i)
      if (b < 128) return this.set(lo, 0)
    }
    b = this.byte()
    lo |= (b & 127) << 28
    hi = (b & 127) >>> 4
    if (b < 128) return this.set(lo, hi)
    for (let i = 0; i < 5; i++) {
      b = this.byte()
      hi |= (b & 127) << (7 * i + 3)
      if (b < 128) return this.set(lo, hi)
    }
    throw badRequest('malformed protobuf: varint too long')
  }

  private set(lo: number, hi: number): void {
    this.lo = lo >>> 0
    this.hi = hi >>> 0
  }

  /** A varint truncated to its low 32 bits (tags, lengths, enums, bools). */
  uint32(): number {
    const p = this.pos
    if (p < this.end) {
      const b = this.buf[p]!
      if (b < 128) {
        this.pos = p + 1
        return b
      }
    }
    this.varint64()
    return this.lo
  }

  /** The last `varint64`/`fixed64` as a signed 64-bit number (inexact beyond 2^53). */
  int64(): number {
    if (this.hi < 0x80000000) return this.hi * 4294967296 + this.lo
    return -((~this.hi >>> 0) * 4294967296 + (~this.lo >>> 0) + 1)
  }

  /** The last `varint64`/`fixed64` as an exact signed 64-bit BigInt. */
  int64Big(): bigint {
    return BigInt.asIntN(64, (BigInt(this.hi) << 32n) | BigInt(this.lo))
  }

  /** Reads a length prefix and returns the end offset of the delimited range. */
  len(): number {
    const n = this.uint32()
    const end = this.pos + n
    if (end > this.end) throw badRequest('malformed protobuf: length past end')
    return end
  }

  /** Reads 8 fixed bytes and returns their offset (little-endian in the buffer). */
  fixed64At(): number {
    const p = this.pos
    if (p + 8 > this.end) throw badRequest('malformed protobuf: truncated')
    this.pos = p + 8
    return p
  }

  fixed64(): void {
    const p = this.fixed64At()
    const b = this.buf
    this.lo = (b[p]! | (b[p + 1]! << 8) | (b[p + 2]! << 16) | (b[p + 3]! << 24)) >>> 0
    this.hi = (b[p + 4]! | (b[p + 5]! << 8) | (b[p + 6]! << 16) | (b[p + 7]! << 24)) >>> 0
  }

  skip(wireType: number): void {
    switch (wireType) {
      case 0:
        this.varint64()
        return
      case 1:
        this.fixed64At()
        return
      case 2:
        this.pos = this.len()
        return
      case 5:
        if (this.pos + 4 > this.end) throw badRequest('malformed protobuf: truncated')
        this.pos += 4
        return
      default:
        // Groups (3, 4) are not used by any message we accept.
        throw badRequest(`malformed protobuf: wire type ${wireType}`)
    }
  }

  /** After reading a nested message: the cursor must sit exactly on its end. */
  done(end: number): void {
    if (this.pos !== end) throw badRequest('malformed protobuf: field overruns message')
  }
}

const utf8 = new TextDecoder('utf-8', { fatal: true })

export function utf8String(buf: Uint8Array, start: number, end: number): string {
  try {
    return utf8.decode(buf.subarray(start, end))
  } catch {
    throw badRequest('malformed protobuf: invalid UTF-8 in string')
  }
}
