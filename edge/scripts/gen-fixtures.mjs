// Generates test/fixtures.json with the *real* tooling, in Node: protobufjs encodes the
// Prometheus and OTLP messages from .proto definitions and snappyjs compresses them.
// The tests then feed these bytes to the Worker, so the hand-written protobuf reader and
// snappy decompressor are checked against independent, widely used implementations.
//   node scripts/gen-fixtures.mjs
import { writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import protobuf from 'protobufjs'
import snappy from 'snappyjs'

const prom = protobuf.parse(`
syntax = "proto3";
package prometheus;
message WriteRequest { repeated TimeSeries timeseries = 1; repeated MetricMetadata metadata = 3; }
message MetricMetadata { int32 type = 1; string metric_family_name = 2; string help = 4; string unit = 5; }
message TimeSeries { repeated Label labels = 1; repeated Sample samples = 2; repeated Exemplar exemplars = 3; }
message Label { string name = 1; string value = 2; }
message Sample { double value = 1; int64 timestamp = 2; }
message Exemplar { repeated Label labels = 1; double value = 2; int64 timestamp = 3; }
`, { keepCase: true }).root

const otlp = protobuf.parse(`
syntax = "proto3";
package otlp;
message ExportMetricsServiceRequest { repeated ResourceMetrics resource_metrics = 1; }
message ResourceMetrics { Resource resource = 1; repeated ScopeMetrics scope_metrics = 2; string schema_url = 3; }
message Resource { repeated KeyValue attributes = 1; uint32 dropped_attributes_count = 2; }
message InstrumentationScope { string name = 1; string version = 2; repeated KeyValue attributes = 3; }
message ScopeMetrics { InstrumentationScope scope = 1; repeated Metric metrics = 2; string schema_url = 3; }
message Metric { string name = 1; string description = 2; string unit = 3;
  oneof data { Gauge gauge = 5; Sum sum = 7; Histogram histogram = 9; } }
message Gauge { repeated NumberDataPoint data_points = 1; }
message Sum { repeated NumberDataPoint data_points = 1; int32 aggregation_temporality = 2; bool is_monotonic = 3; }
message Histogram { repeated HistogramDataPoint data_points = 1; int32 aggregation_temporality = 2; }
message HistogramDataPoint { repeated KeyValue attributes = 9; fixed64 start_time_unix_nano = 2; fixed64 time_unix_nano = 3;
  fixed64 count = 4; optional double sum = 5; repeated fixed64 bucket_counts = 6; repeated double explicit_bounds = 7; }
message NumberDataPoint { repeated KeyValue attributes = 7; fixed64 start_time_unix_nano = 2; fixed64 time_unix_nano = 3;
  oneof value { double as_double = 4; sfixed64 as_int = 6; } uint32 flags = 8; }
message KeyValue { string key = 1; AnyValue value = 2; }
message AnyValue { oneof value { string string_value = 1; bool bool_value = 2; int64 int_value = 3; double double_value = 4;
  ArrayValue array_value = 5; KeyValueList kvlist_value = 6; bytes bytes_value = 7; } }
message ArrayValue { repeated AnyValue values = 1; }
message KeyValueList { repeated KeyValue values = 1; }
`, { keepCase: true }).root

const b64 = (u8) => Buffer.from(u8).toString('base64')
const T0 = 1_780_000_000_000 // fixed: the test widens the accept window

// Remote Write: 300 series x 2 samples, labels with repetition so snappy emits real copies.
const series = []
const expectPrw = []
for (let i = 0; i < 300; i++) {
  const labels = [
    { name: '__name__', value: i % 3 === 0 ? 'http_requests_total' : 'http_request_duration_seconds_sum' },
    { name: 'handler', value: `/api/v1/things/${i % 17}` },
    { name: 'instance', value: `10.0.${i % 4}.${i % 7}:8080` },
    { name: 'job', value: `svc-${i % 5}` },
    { name: 'zone', value: i % 2 ? 'eu-west-1a' : 'Zürich-🌡' },
    { name: 'n', value: String(i) },
  ].sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)))
  const samples = [
    { value: i * 1.5, timestamp: T0 + i },
    { value: -i / 3, timestamp: T0 + 15_000 + i },
  ]
  series.push({ labels, samples })
  for (const s of samples) expectPrw.push({ labels: Object.fromEntries(labels.map((l) => [l.name, l.value])), ts: s.timestamp, value: s.value })
}
const WR = prom.lookupType('prometheus.WriteRequest')
const wrBytes = WR.encode(WR.fromObject({
  timeseries: series,
  metadata: [{ type: 1, metric_family_name: 'http_requests_total', help: 'ignored by the receiver', unit: '' }],
})).finish()
const wrSnappy = snappy.compress(wrBytes)

// OTLP: one resource, a gauge, a cumulative monotonic sum, and a histogram (to be rejected).
const nanos = (ms) => String(BigInt(ms) * 1000000n + 999999n) // sub-millisecond part must be floored away
const kv = (key, value) => ({ key, value })
const otlpObj = {
  resource_metrics: [{
    resource: { attributes: [
      kv('service.name', { string_value: 'checkout' }), kv('service.namespace', { string_value: 'shop' }),
      kv('service.instance.id', { string_value: 'i-1' }), kv('host.name', { string_value: 'h1' }),
      kv('k8s.replicas', { int_value: 3 }), kv('canary', { bool_value: true }),
    ] },
    scope_metrics: [{ scope: { name: 'lib', version: '1' }, metrics: [
      { name: 'process.cpu.time', unit: 's', sum: { aggregation_temporality: 2, is_monotonic: true, data_points: [
        { attributes: [kv('cpu.mode', { string_value: 'user' })], time_unix_nano: nanos(T0), as_double: 12.5 },
        { attributes: [kv('cpu.mode', { string_value: 'system' })], time_unix_nano: nanos(T0), as_int: 7 },
      ] } },
      { name: 'queue.depth', unit: '{items}', gauge: { data_points: [
        { attributes: [kv('ratio', { double_value: 0.25 }), kv('tags', { array_value: { values: [{ string_value: 'a' }, { int_value: 2 }] } })], time_unix_nano: nanos(T0 + 1), as_int: -4 },
      ] } },
      { name: 'latency', unit: 'ms', histogram: { aggregation_temporality: 2, data_points: [
        { time_unix_nano: nanos(T0), count: 3, sum: 1.5, bucket_counts: [1, 2], explicit_bounds: [0.1] },
        { time_unix_nano: nanos(T0), count: 1, sum: 0.5, bucket_counts: [1, 0], explicit_bounds: [0.1] },
      ] } },
    ] }],
  }],
}
const ER = otlp.lookupType('otlp.ExportMetricsServiceRequest')
const otlpBytes = ER.encode(ER.fromObject(otlpObj)).finish()
const res = { job: 'shop/checkout', instance: 'i-1', host_name: 'h1', k8s_replicas: '3', canary: 'true' }
const expectOtlp = [
  { labels: { ...res, __name__: 'process_cpu_time_seconds_total', cpu_mode: 'user' }, ts: T0, value: 12.5 },
  { labels: { ...res, __name__: 'process_cpu_time_seconds_total', cpu_mode: 'system' }, ts: T0, value: 7 },
  { labels: { ...res, __name__: 'queue_depth', ratio: '0.25', tags: '["a",2]' }, ts: T0 + 1, value: -4 },
]

writeFileSync(new URL('../test/fixtures.json', import.meta.url), JSON.stringify({
  generatedWith: 'protobufjs + snappyjs + node:zlib (scripts/gen-fixtures.mjs)',
  t0: T0,
  prw: { snappy: b64(wrSnappy), rawBytes: wrBytes.length, expect: expectPrw },
  otlp: { proto: b64(otlpBytes), gzip: b64(gzipSync(otlpBytes)), expect: expectOtlp, rejected: 2 },
}, null, 1) + '\n')
console.log(`prw: ${wrBytes.length} -> ${wrSnappy.length} bytes snappy; otlp: ${otlpBytes.length} bytes`)
