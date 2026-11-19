/**
 * Where recording rules' samples go in production: viz-ingest's Prometheus Remote Write 1.0
 * endpoint, over the `INGEST` service binding, with the ruler's service key (scope `write`;
 * the tenant is the key's). One request per `Sink.write` call, with every batch in it.
 *
 * Re-sending is harmless: a sample is identified by its series and timestamp, and the write
 * path keeps one value per (series, timestamp), so the ruler's at-least-once retries write
 * the same rows again rather than new ones.
 *
 * The body is encoded here (protobuf `WriteRequest`, snappy block format with literals only,
 * which every snappy decoder reads); `deploy/lib/prw.mjs` is the same encoder for the smoke
 * test.
 */
import type { SampleBatch, Sink } from '../contracts-proposal/rules.v2'
import type { CredentialSource, Fetcher } from './engine'
import { errorText } from './evaluator'

function varint(n: number | bigint, out: number[]): void {
  let v = BigInt(n)
  if (v < 0n) v += 1n << 64n // int64, two's complement
  do {
    let b = Number(v & 0x7fn)
    v >>= 7n
    if (v > 0n) b |= 0x80
    out.push(b)
  } while (v > 0n)
}

function field(no: number, bytes: ArrayLike<number>, out: number[]): void {
  out.push((no << 3) | 2)
  varint(bytes.length, out)
  for (let i = 0; i < bytes.length; i++) out.push(bytes[i] as number)
}

const utf8 = new TextEncoder()

/** Prometheus' text form of a sample value: `NaN`, `+Inf`, `-Inf`, or a decimal. */
export function parseValue(text: string): number {
  if (text === '+Inf' || text === 'Inf') return Infinity
  if (text === '-Inf') return -Infinity
  if (text === 'NaN') return NaN
  return Number(text)
}

export interface WriteSeries {
  labels: Record<string, string>
  samples: [timeMs: number, value: number][]
}

export function encodeWriteRequest(series: WriteSeries[]): Uint8Array<ArrayBuffer> {
  const out: number[] = []
  for (const s of series) {
    const ts: number[] = []
    for (const name of Object.keys(s.labels).sort()) {
      const l: number[] = []
      field(1, utf8.encode(name), l)
      field(2, utf8.encode(s.labels[name] as string), l)
      field(1, l, ts)
    }
    for (const [t, v] of s.samples) {
      const sm: number[] = [0x09]
      const f = new DataView(new ArrayBuffer(8))
      f.setFloat64(0, v, true)
      for (let i = 0; i < 8; i++) sm.push(f.getUint8(i))
      sm.push(0x10)
      varint(t, sm)
      field(2, sm, ts)
    }
    field(1, ts, out)
  }
  return Uint8Array.from(out)
}

/** Snappy block format, literals only. */
export function snappyLiterals(input: Uint8Array): Uint8Array<ArrayBuffer> {
  const out: number[] = []
  varint(input.length, out)
  for (let off = 0; off < input.length; off += 65536) {
    const chunk = input.subarray(off, Math.min(off + 65536, input.length))
    const n = chunk.length - 1
    if (n < 60) out.push(n << 2)
    else if (n < 256) out.push(60 << 2, n)
    else out.push(61 << 2, n & 0xff, n >> 8)
    for (const b of chunk) out.push(b)
  }
  return Uint8Array.from(out)
}

/** Batches → series, one entry per distinct label set, samples in time order. */
export function seriesOf(batches: SampleBatch[]): WriteSeries[] {
  const by = new Map<string, WriteSeries>()
  for (const b of batches) {
    for (const s of b.samples) {
      const key = JSON.stringify(Object.entries(s.labels).sort(([a], [c]) => (a < c ? -1 : 1)))
      let w = by.get(key)
      if (!w) by.set(key, (w = { labels: s.labels, samples: [] }))
      w.samples.push([s.timeMs, parseValue(s.value)])
    }
  }
  for (const w of by.values()) w.samples.sort((a, b) => a[0] - b[0])
  return [...by.values()]
}

export function remoteWriteSink(ingest: Fetcher, cred: CredentialSource): Sink {
  return {
    async write(batches) {
      const series = seriesOf(batches)
      if (series.length === 0) return
      const key = await cred.get()
      let res: Response
      try {
        res = await ingest.fetch(
          new Request('https://ingest.internal/api/v1/write', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${key}`,
              'Content-Encoding': 'snappy',
              'Content-Type': 'application/x-protobuf',
              'X-Prometheus-Remote-Write-Version': '0.1.0',
              'User-Agent': 'viz-ruler',
            },
            body: snappyLiterals(encodeWriteRequest(series)),
          }),
        )
      } catch (e) {
        throw new Error(`the ingest service could not be reached: ${errorText(e)}`)
      }
      const text = (await res.text()).slice(0, 300)
      if (res.status === 401) cred.rejected(key)
      if (!res.ok) throw new Error(`the ingest service answered ${res.status}: ${text}`)
    },
  }
}
