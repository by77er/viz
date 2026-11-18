import { badRequest, tooLarge } from './errors'

/**
 * Snappy *block* format decompressor (the format Prometheus Remote Write uses; not the
 * framed/stream format). Dependency-free. The declared length is checked against
 * `maxLen` before anything is allocated, and every copy is bounds-checked, so hostile
 * input can neither over-allocate nor read or write out of range.
 */
export function snappyDecompress(src: Uint8Array, maxLen: number): Uint8Array {
  const n = src.length
  let ip = 0

  // Preamble: uncompressed length as a varint (at most 32 bits).
  let len = 0
  let shift = 0
  for (;;) {
    if (ip >= n || shift > 28) throw badRequest('malformed snappy: bad length preamble')
    const b = src[ip++]!
    len += (b & 127) * 2 ** shift
    if (b < 128) break
    shift += 7
  }
  if (len > 0xffffffff) throw badRequest('malformed snappy: bad length preamble')
  if (len > maxLen) throw tooLarge(`decompressed body of ${len} bytes exceeds the limit of ${maxLen}`)

  const dst = new Uint8Array(len)
  let op = 0
  while (ip < n) {
    const tag = src[ip++]!
    let l: number
    if ((tag & 3) === 0) {
      // Literal.
      l = tag >>> 2
      if (l >= 60) {
        const extra = l - 59
        if (ip + extra > n) throw badRequest('malformed snappy: truncated literal length')
        l = 0
        for (let i = 0; i < extra; i++) l += src[ip + i]! * 2 ** (8 * i)
        ip += extra
      }
      l += 1
      if (ip + l > n || op + l > len) throw badRequest('malformed snappy: literal out of range')
      dst.set(src.subarray(ip, ip + l), op)
      ip += l
      op += l
      continue
    }
    let offset: number
    if ((tag & 3) === 1) {
      if (ip >= n) throw badRequest('malformed snappy: truncated copy')
      l = ((tag >>> 2) & 7) + 4
      offset = ((tag >>> 5) << 8) | src[ip++]!
    } else if ((tag & 3) === 2) {
      if (ip + 2 > n) throw badRequest('malformed snappy: truncated copy')
      l = (tag >>> 2) + 1
      offset = src[ip]! | (src[ip + 1]! << 8)
      ip += 2
    } else {
      if (ip + 4 > n) throw badRequest('malformed snappy: truncated copy')
      l = (tag >>> 2) + 1
      offset = (src[ip]! | (src[ip + 1]! << 8) | (src[ip + 2]! << 16) | (src[ip + 3]! << 24)) >>> 0
      ip += 4
    }
    if (offset === 0 || offset > op || op + l > len) throw badRequest('malformed snappy: copy out of range')
    if (offset >= l) {
      dst.copyWithin(op, op - offset, op - offset + l)
      op += l
    } else {
      // Overlapping copy: the pattern repeats, so it has to go byte by byte.
      for (let end = op + l; op < end; op++) dst[op] = dst[op - offset]!
    }
  }
  if (op !== len) throw badRequest('malformed snappy: length mismatch')
  return dst
}
