// Prometheus Remote Write 1.0 request bodies, and Prometheus API reads, for the smoke test and
// the trial. No dependencies: a protobuf encoder for the four messages Remote Write uses, and a
// snappy block "compressor" that emits literals only (valid snappy; edge's decoder and any
// other read it).

function varint(n, out) {
  let v = BigInt(n)
  if (v < 0n) v += 1n << 64n // int64 two's complement
  do {
    let b = Number(v & 0x7fn)
    v >>= 7n
    if (v > 0n) b |= 0x80
    out.push(b)
  } while (v > 0n)
}

function lenField(field, bytes, out) {
  out.push((field << 3) | 2)
  varint(bytes.length, out)
  for (const b of bytes) out.push(b)
}

const utf8 = (s) => [...new TextEncoder().encode(s)]

/** series: [{ labels: {name: value}, samples: [[tsMs, value]] }] → WriteRequest bytes. */
export function encodeWriteRequest(series) {
  const out = []
  for (const s of series) {
    const ts = []
    // Labels sorted by name, as senders do (edge sorts anyway).
    for (const name of Object.keys(s.labels).sort()) {
      const l = []
      lenField(1, utf8(name), l)
      lenField(2, utf8(String(s.labels[name])), l)
      lenField(1, l, ts)
    }
    for (const [t, v] of s.samples) {
      const sm = [0x09]
      const f = new DataView(new ArrayBuffer(8))
      f.setFloat64(0, v, true)
      for (let i = 0; i < 8; i++) sm.push(f.getUint8(i))
      sm.push(0x10)
      varint(t, sm)
      lenField(2, sm, ts)
    }
    lenField(1, ts, out)
  }
  return Uint8Array.from(out)
}

/** Snappy block format, literals only. */
export function snappyLiterals(input) {
  const out = []
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

export const remoteWriteBody = (series) => snappyLiterals(encodeWriteRequest(series))

export function remoteWriteHeaders(key) {
  return {
    Authorization: `Bearer ${key}`,
    'Content-Encoding': 'snappy',
    'Content-Type': 'application/x-protobuf',
    'X-Prometheus-Remote-Write-Version': '0.1.0',
    'User-Agent': 'viz-deploy-smoke/1',
  }
}

/** One Remote Write request; resolves to { status, ms, retryAfter, text }. Never throws for HTTP errors. */
export async function remoteWrite(base, key, series, { signal } = {}) {
  const start = performance.now()
  try {
    const res = await fetch(`${base}/api/v1/write`, { method: 'POST', headers: remoteWriteHeaders(key), body: remoteWriteBody(series), signal })
    const text = await res.text()
    return { status: res.status, ms: performance.now() - start, retryAfter: res.headers.get('Retry-After'), route: res.headers.get('x-viz-route'), text: text.slice(0, 300) }
  } catch (e) {
    return { status: 0, ms: performance.now() - start, error: e.cause?.code ?? e.name ?? 'fetch failed', text: '' }
  }
}

/** One Prometheus instant query; resolves to { status, ms, body }. */
export async function instantQuery(base, key, query, timeSec, { signal } = {}) {
  const start = performance.now()
  const q = new URLSearchParams({ query })
  if (timeSec !== undefined) q.set('time', String(timeSec))
  try {
    const res = await fetch(`${base}/api/v1/query?${q}`, { headers: { Authorization: `Bearer ${key}`, 'User-Agent': 'viz-deploy-smoke/1' }, signal })
    const text = await res.text()
    let body = null
    try {
      body = JSON.parse(text)
    } catch {
      body = { raw: text.slice(0, 300) }
    }
    return { status: res.status, ms: performance.now() - start, body }
  } catch (e) {
    return { status: 0, ms: performance.now() - start, body: null, error: e.cause?.code ?? e.name ?? 'fetch failed' }
  }
}

/** Percentiles of a list of numbers (nearest rank). */
export function percentiles(xs, ps = [50, 90, 99]) {
  const s = [...xs].sort((a, b) => a - b)
  const out = { n: s.length }
  if (!s.length) return out
  for (const p of ps) out[`p${p}`] = Math.round(s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)])
  out.min = Math.round(s[0])
  out.max = Math.round(s[s.length - 1])
  return out
}
