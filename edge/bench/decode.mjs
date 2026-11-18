// Decode-throughput benchmark, in Node (V8, like workerd, but not the Workers CPU or limits).
//   node bench/decode.mjs
// Measures the CPU-bound part of one request: decompress → decode + validate + hash →
// build VZB1 batches → SHA-256. No network, no shard.
import { createHash } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'
import { build } from 'esbuild'
import protobuf from 'protobufjs'
import snappy from 'snappyjs'

const out = join(mkdtempSync(join(tmpdir(), 'viz-edge-bench-')), 'edge.mjs')
await build({
  stdin: {
    contents: `export * from './src/batch'; export * from './src/prw'; export * from './src/otlp'; export * from './src/snappy'; export * from './src/limits'`,
    resolveDir: new URL('..', import.meta.url).pathname,
    loader: 'ts',
  },
  bundle: true, format: 'esm', platform: 'neutral', outfile: out, logLevel: 'error',
})
const { Collector, buildBatches, decodeRemoteWrite, decodeOtlpProto, decodeOtlpJson, snappyDecompress, DEFAULT_LIMITS, fnv1a64 } = await import(pathToFileURL(out).href)

const prom = protobuf.parse(`syntax = "proto3"; package p;
message WriteRequest { repeated TimeSeries timeseries = 1; }
message TimeSeries { repeated Label labels = 1; repeated Sample samples = 2; }
message Label { string name = 1; string value = 2; }
message Sample { double value = 1; int64 timestamp = 2; }`, { keepCase: true }).root.lookupType('p.WriteRequest')

const now = Date.now()
const limits = { ...DEFAULT_LIMITS, maxDecompressedBytes: 256 << 20, maxSamples: 5e6, maxSeries: 5e6 }

// A Prometheus-like request: N series, ~10 labels each, one sample per series (what the
// Prometheus queue manager sends: max_samples_per_send = 2000 by default).
function prwBody(n) {
  const timeseries = []
  for (let i = 0; i < n; i++) {
    timeseries.push({
      labels: [
        ['__name__', `http_server_request_duration_seconds_bucket`], ['cluster', 'prod-eu-west-1'], ['container', 'app'],
        ['handler', `/api/v1/resource/${i % 50}`], ['instance', `10.12.${(i >> 8) & 255}.${i & 255}:8080`], ['job', `kubernetes-pods/svc-${i % 20}`],
        ['le', String((i % 12) * 0.25)], ['method', i % 3 ? 'GET' : 'POST'], ['namespace', `team-${i % 9}`], ['pod', `svc-${i % 20}-7d9f8b6c5-${(i * 7919) % 100000}`],
        ['status_code', String(200 + (i % 5) * 100)],
      ].map(([name, value]) => ({ name, value })),
      samples: [{ value: i * 1.25, timestamp: now - (i % 1000) }],
    })
  }
  return prom.encode(prom.fromObject({ timeseries })).finish()
}

function otlpJson(n) {
  const kv = (key, v) => ({ key, value: { stringValue: v } })
  const points = []
  for (let i = 0; i < n; i++) {
    points.push({ attributes: [kv('http.route', `/api/v1/resource/${i % 50}`), kv('http.request.method', i % 3 ? 'GET' : 'POST'), kv('http.response.status_code', String(200 + (i % 5) * 100)), kv('pod', `svc-7d9f8b6c5-${(i * 7919) % 100000}`)], timeUnixNano: String(BigInt(now - (i % 1000)) * 1000000n), asDouble: i * 1.25 })
  }
  return { resourceMetrics: [{ resource: { attributes: [kv('service.name', 'checkout'), kv('service.instance.id', 'i-0123456789'), kv('k8s.cluster.name', 'prod-eu-west-1'), kv('k8s.namespace.name', 'team-3'), kv('deployment.environment', 'prod')] },
    scopeMetrics: [{ metrics: [{ name: 'http.server.request.count', unit: '{request}', sum: { aggregationTemporality: 2, isMonotonic: true, dataPoints: points } }] }] }] }
}

// OTLP protobuf built with the same writer shape as the JSON (minimal encoder).
function otlpProtoBytes(obj) {
  const otlp = protobuf.parse(`syntax = "proto3"; package o;
message Req { repeated RM resource_metrics = 1; }
message RM { Res resource = 1; repeated SM scope_metrics = 2; }
message Res { repeated KV attributes = 1; }
message SM { repeated Metric metrics = 2; }
message Metric { string name = 1; string unit = 3; Sum sum = 7; }
message Sum { repeated DP data_points = 1; int32 aggregation_temporality = 2; bool is_monotonic = 3; }
message DP { repeated KV attributes = 7; fixed64 time_unix_nano = 3; double as_double = 4; }
message KV { string key = 1; AV value = 2; }
message AV { string string_value = 1; }`, { keepCase: true }).root.lookupType('o.Req')
  return otlp.encode(otlp.fromObject(obj)).finish()
}

function time(label, bytes, samples, fn) {
  for (let i = 0; i < 5; i++) fn() // warm up
  const runs = []
  for (let i = 0; i < 15; i++) {
    const t = performance.now()
    fn()
    runs.push(performance.now() - t)
  }
  runs.sort((a, b) => a - b)
  const ms = runs[Math.floor(runs.length / 2)]
  console.log(`${label.padEnd(46)} ${ms.toFixed(2).padStart(8)} ms  ${(bytes / 1048576 / (ms / 1000)).toFixed(0).padStart(5)} MB/s  ${(ms / (bytes / 1048576)).toFixed(1).padStart(6)} ms/MB  ${(samples / (ms / 1000) / 1e6).toFixed(2).padStart(5)} M samples/s`)
  return ms
}

const slotAll = (c) => new Int32Array(c.nSeries)
for (const n of [2000, 50_000]) {
  const raw = prwBody(n)
  const comp = snappy.compress(raw)
  console.log(`\nRemote Write, ${n} series x 1 sample: ${raw.length} bytes raw, ${comp.length} snappy (MB/s and ms/MB are per decompressed MB)`)
  time('  snappy decompress', raw.length, n, () => snappyDecompress(comp, limits.maxDecompressedBytes))
  time('  protobuf decode + validate + series ids', raw.length, n, () => decodeRemoteWrite(raw, new Collector(limits, now, raw.length)))
  const c = new Collector(limits, now)
  decodeRemoteWrite(raw, c)
  let batchBytes = 0
  time('  build VZB1 batches', raw.length, n, () => { batchBytes = 0; for (const b of buildBatches(c, slotAll(c), limits.maxBatchBytes).get(0)) batchBytes += b.bytes.length })
  const batches = buildBatches(c, slotAll(c), limits.maxBatchBytes).get(0)
  time('  SHA-256 fingerprints (node:crypto)', raw.length, n, () => { for (const b of batches) createHash('sha256').update(b.bytes).digest('hex') })
  time('  TOTAL request CPU (all of the above)', raw.length, n, () => {
    const body = snappyDecompress(comp, limits.maxDecompressedBytes)
    const cc = new Collector(limits, now, body.length)
    decodeRemoteWrite(body, cc)
    for (const b of buildBatches(cc, slotAll(cc), limits.maxBatchBytes).get(0)) createHash('sha256').update(b.bytes).digest('hex')
  })
  console.log(`  → ${batches.length} batch(es), ${batchBytes} bytes of VZB1 (${(batchBytes / raw.length).toFixed(2)}x the protobuf)`)
}

{
  const n = 50_000
  const obj = otlpJson(n)
  const json = new TextEncoder().encode(JSON.stringify(obj))
  const snake = JSON.parse(JSON.stringify(obj).replaceAll('resourceMetrics', 'resource_metrics').replaceAll('scopeMetrics', 'scope_metrics').replaceAll('dataPoints', 'data_points')
    .replaceAll('timeUnixNano', 'time_unix_nano').replaceAll('asDouble', 'as_double').replaceAll('stringValue', 'string_value').replaceAll('aggregationTemporality', 'aggregation_temporality').replaceAll('isMonotonic', 'is_monotonic'))
  const proto = otlpProtoBytes(snake)
  console.log(`\nOTLP, 1 resource, ${n} points: ${proto.length} bytes protobuf, ${json.length} bytes JSON (gzip: ${gzipSync(proto).length} / ${gzipSync(json).length})`)
  time('  OTLP protobuf decode + map + series ids', proto.length, n, () => decodeOtlpProto(proto, new Collector(limits, now, proto.length)))
  time('  OTLP JSON parse + map + series ids', json.length, n, () => decodeOtlpJson(json, new Collector(limits, now, json.length)))
}

{
  const input = new Uint8Array(1 << 20).map((_, i) => 97 + (i % 26))
  console.log('\nFNV-1a 64 over 1 MiB')
  time('  BigInt reference (fnv1a64)', input.length, 0, () => fnv1a64(input))
}
