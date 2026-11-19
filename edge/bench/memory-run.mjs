// One request's CPU-bound path, without the network: (snappy) → decode → validate → batches.
// Shared by bench/memory.mjs's Node child and its workerd Worker, so both run the same steps.
//
// `E` is the bundle of src/ (see memory.mjs); `c` is { path, json, snappy, body, now }.
// Returns what was decoded and the objects a request holds until it answers (`keep`), so the
// caller can measure what is retained before letting them go.
export function runCase(E, c) {
  const L = E.DEFAULT_LIMITS
  try {
    let body = c.body
    if (c.snappy) body = E.snappyDecompress(body, L.maxDecompressedBytes)
    if (c.path === 'metrics') {
      const col = new E.Collector(L, c.now, body.byteLength)
      if (c.json) E.decodeOtlpJson(body, col)
      else E.decodeOtlpProto(body, col)
      const slots = new Int32Array(col.nSeries).map((_, i) => i % 4)
      const batches = E.buildBatches(col, slots, L.maxBatchBytes)
      return { outcome: 'ok', rows: col.nRows, rejected: col.rejectedTotal, reasons: col.rejectionSummary(), keep: [body, col, batches] }
    }
    const col = c.path === 'traces' ? new E.SpanCollector(L, c.now) : new E.LogCollector(L, c.now)
    if (c.path === 'traces') (c.json ? E.decodeTracesJson : E.decodeTracesProto)(body, col)
    else if (c.path === 'logs') (c.json ? E.decodeLogsJson : E.decodeLogsProto)(body, col)
    else (c.json ? E.decodeLokiJson : E.decodeLokiProto)(body, col)
    const slots = new Int32Array(col.nSeries).map((_, i) => i % 4)
    const batches = col.build(slots, L.maxBatchBytes)
    return { outcome: 'ok', rows: col.nRows, rejected: col.rejectedTotal, reasons: col.rejectionSummary(), keep: [body, col, batches] }
  } catch (e) {
    if (e && typeof e.status === 'number') return { outcome: `${e.status} ${e.message}`.slice(0, 120), rows: 0, rejected: 0, reasons: '', keep: [] }
    return { outcome: `threw ${e && e.message}`.slice(0, 120), rows: 0, rejected: 0, reasons: '', keep: [] }
  }
}
