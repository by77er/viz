import type { Collector } from './batch'
import { PbReader } from './pb'

/**
 * Prometheus Remote Write 1.0: `prometheus.WriteRequest` → rows.
 *
 *   WriteRequest { repeated TimeSeries timeseries = 1; }            (metadata = 3 ignored)
 *   TimeSeries   { repeated Label labels = 1; repeated Sample samples = 2;
 *                  repeated Exemplar exemplars = 3; repeated Histogram histograms = 4; }
 *   Label        { string name = 1; string value = 2; }
 *   Sample       { double value = 1; int64 timestamp = 2; }
 *
 * Label bytes are never turned into strings: they are hashed and copied straight from the
 * decompressed body. Sample values are copied as their 8 wire bytes, so the staleness NaN
 * (and any other NaN payload) is preserved bit for bit.
 */
export function decodeRemoteWrite(body: Uint8Array, c: Collector): void {
  const r = new PbReader(body)
  // Scratch reused across series: label offsets (4 per label) and sample positions.
  const maxLabels = c.limits.maxLabelsPerSeries + 1
  const offs = new Int32Array(4 * maxLabels)
  let samples = new Int32Array(64)

  while (r.pos < r.end) {
    const tag = r.uint32()
    if (tag !== 0x0a) {
      r.skip(tag & 7)
      continue
    }
    const end = r.len()
    let nLabels = 0
    let nSamples = 0
    let nHistograms = 0
    while (r.pos < end) {
      const t = r.uint32()
      if (t === 0x0a) {
        // Label
        const lend = r.len()
        let ns = 0
        let ne = 0
        let vs = 0
        let ve = 0
        while (r.pos < lend) {
          const lt = r.uint32()
          if (lt === 0x0a) {
            ne = r.len()
            ns = r.pos
            r.pos = ne
          } else if (lt === 0x12) {
            ve = r.len()
            vs = r.pos
            r.pos = ve
          } else r.skip(lt & 7)
        }
        r.done(lend)
        // Empty-valued labels are dropped here; one slot past the limit is kept so the
        // collector sees (and rejects) a series with too many labels.
        if (ve > vs && nLabels < maxLabels) {
          const o = 4 * nLabels++
          offs[o] = ns
          offs[o + 1] = ne
          offs[o + 2] = vs
          offs[o + 3] = ve
        }
      } else if (t === 0x12) {
        // Sample: remember where it is; labels may legally come after samples.
        if (nSamples === samples.length) {
          const g = new Int32Array(nSamples * 2)
          g.set(samples)
          samples = g
        }
        samples[nSamples++] = r.pos
        r.pos = r.len()
      } else if (t === 0x22) {
        nHistograms++
        r.pos = r.len()
      } else r.skip(t & 7)
    }
    r.done(end)

    if (nHistograms > 0) c.reject('native histograms are not supported', nHistograms)
    if (nSamples === 0) continue
    const series = c.addSeries(body, offs, nLabels)
    if (series < 0) {
      c.reject(-series, nSamples)
      continue
    }
    for (let i = 0; i < nSamples; i++) {
      r.pos = samples[i]!
      const send = r.len()
      let valueAt = -1
      let ts = 0
      while (r.pos < send) {
        const st = r.uint32()
        if (st === 0x09) valueAt = r.fixed64At()
        else if (st === 0x10) {
          r.varint64()
          ts = r.int64()
        } else r.skip(st & 7)
      }
      r.done(send)
      c.addSampleBytes(series, ts, valueAt < 0 ? null : body, valueAt)
    }
    r.pos = end
  }
}
