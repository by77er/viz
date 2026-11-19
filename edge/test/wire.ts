/**
 * Request bodies written byte by byte for the decode-limit tests (test/decode-metrics.test.ts):
 * protobuf by hand and JSON as text, sharing nothing with src/.
 */
import { HttpError } from '../src/errors'

export const te = new TextEncoder()
export const NS = BigInt(Date.now()) * 1_000_000n

export const varint = (n: number): number[] => {
  const out: number[] = []
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80)
    n = Math.floor(n / 128)
  }
  out.push(n)
  return out
}
export const cat = (...xs: Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const o = new Uint8Array(xs.reduce((a, x) => a + x.length, 0))
  let p = 0
  for (const x of xs) {
    o.set(x, p)
    p += x.length
  }
  return o
}
/** A length-delimited field: tag byte, length, bytes. */
export const ld = (tag: number, b: Uint8Array): Uint8Array<ArrayBuffer> => cat(Uint8Array.from([tag, ...varint(b.length)]), b)
export const str = (tag: number, s: string): Uint8Array<ArrayBuffer> => ld(tag, te.encode(s))
/** `unit` repeated `n` times. */
export const rep = (unit: Uint8Array | number[], n: number): Uint8Array<ArrayBuffer> => {
  const u = Uint8Array.from(unit)
  const o = new Uint8Array(u.length * n)
  for (let i = 0; i < n; i++) o.set(u, i * u.length)
  return o
}
export const fixed64 = (tag: number, v: bigint): Uint8Array<ArrayBuffer> => {
  const b = new Uint8Array(9)
  b[0] = tag
  new DataView(b.buffer).setBigUint64(1, v, true)
  return b
}
/** KeyValue { key, string value } as the body of a field. */
export const kvs = (k: string, v: string): Uint8Array<ArrayBuffer> => cat(str(0x0a, k), ld(0x12, str(0x0a, v)))
/** KeyValue { key, value { array_value { n empty AnyValues } } }: 1 + n values. */
export const kvArray = (k: string, n: number): Uint8Array<ArrayBuffer> => cat(str(0x0a, k), ld(0x12, ld(0x2a, rep([0x0a, 0], n))))
/** A resource attribute `service.name = svc`. */
export const SVC = ld(0x0a, kvs('service.name', 'svc'))
/** ExportMetricsServiceRequest: one resource, one scope, one gauge `m` with these points (each at now, value 0). */
export const metricsReq = (resource: Uint8Array, points: Uint8Array[]): Uint8Array<ArrayBuffer> =>
  ld(0x0a, cat(ld(0x0a, resource), ld(0x12, ld(0x12, cat(str(0x0a, 'm'), ld(0x2a, cat(...points.map((p) => ld(0x0a, cat(fixed64(0x19, NS), fixed64(0x21, 0n), p))))))))))

export const json = (s: string): Uint8Array<ArrayBuffer> => te.encode(s)
export const emptyObjects = (n: number): string => Array(n).fill('{}').join(',')

/** Structural characters of JSON text outside strings, counted apart from src. */
export function jsonTokens(text: string): number {
  let n = 0
  for (let i = 0, inStr = false; i < text.length; i++) {
    const ch = text[i]!
    if (inStr) {
      if (ch === '\\') i++
      else if (ch === '"') inStr = false
    } else if (ch === '"') inStr = true
    else if ('{[,:'.includes(ch)) n++
  }
  return n
}

/** 'ok', or the status of the HttpError `f` throws. */
export function status(f: () => unknown): number | 'ok' {
  try {
    f()
    return 'ok'
  } catch (e) {
    if (e instanceof HttpError) return e.status
    throw e
  }
}
