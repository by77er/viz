// node --test deploy/test/: the Remote Write body the smoke test sends, decoded by
// independent implementations (snappyjs, protobufjs), and the percentile helper.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import protobuf from 'protobufjs'
import snappy from 'snappyjs'
import { encodeWriteRequest, percentiles, remoteWriteBody, snappyLiterals } from '../lib/prw.mjs'

const root = protobuf.parse(`
syntax = "proto3";
message WriteRequest { repeated TimeSeries timeseries = 1; }
message TimeSeries { repeated Label labels = 1; repeated Sample samples = 2; }
message Label { string name = 1; string value = 2; }
message Sample { double value = 1; int64 timestamp = 2; }
`).root
const WriteRequest = root.lookupType('WriteRequest')

test('a Remote Write body decodes to exactly what was encoded', () => {
  const series = [
    { labels: { __name__: 'm', run: 'r-ü', series: '0' }, samples: [[1795003200123, 1.5], [1795003201123, -0]] },
    { labels: { job: 'j', __name__: 'n' }, samples: [[1, Number.NaN]] },
  ]
  const raw = snappy.uncompress(Buffer.from(remoteWriteBody(series)))
  assert.deepEqual(new Uint8Array(raw), encodeWriteRequest(series))
  const msg = WriteRequest.toObject(WriteRequest.decode(raw), { longs: String })
  assert.equal(msg.timeseries.length, 2)
  assert.deepEqual(msg.timeseries[0].labels, [{ name: '__name__', value: 'm' }, { name: 'run', value: 'r-ü' }, { name: 'series', value: '0' }])
  assert.deepEqual(msg.timeseries[0].samples.map((s) => [s.timestamp, s.value]), [['1795003200123', 1.5], ['1795003201123', -0]])
  assert.deepEqual(msg.timeseries[1].labels.map((l) => l.name), ['__name__', 'job'])
  assert.ok(Number.isNaN(msg.timeseries[1].samples[0].value))
})

test('snappy literals of every length class decode', () => {
  for (const n of [0, 1, 59, 60, 61, 255, 256, 65535, 65536, 65537, 200_000]) {
    const input = new Uint8Array(n).map((_, i) => (i * 7) & 0xff)
    assert.deepEqual(new Uint8Array(snappy.uncompress(Buffer.from(snappyLiterals(input)))), input, `length ${n}`)
  }
})

test('percentiles are nearest-rank', () => {
  assert.deepEqual(percentiles([5, 1, 4, 2, 3]), { n: 5, p50: 3, p90: 5, p99: 5, min: 1, max: 5 })
  assert.deepEqual(percentiles([]), { n: 0 })
})

// The ruler writes recording rules' samples with its own copy of this encoder
// (ruler/src/remote.ts): read back here by the same independent implementations.
test('the ruler\'s Remote Write body (ruler/src/remote.ts) decodes to the recorded samples', async () => {
  const { encodeWriteRequest: enc, seriesOf, snappyLiterals: lit } = await import('../../ruler/src/remote.ts')
  const batches = [
    { id: 't/0/g/k@1795003200000', samples: [{ labels: { __name__: 'job:up:sum', job: 'api' }, timeMs: 1795003200000, value: '3.5' }, { labels: { job: 'web', __name__: 'job:up:sum' }, timeMs: 1795003200000, value: '+Inf' }] },
    { id: 't/0/g/k@1795003260000', samples: [{ labels: { __name__: 'job:up:sum', job: 'api' }, timeMs: 1795003260000, value: 'NaN' }] },
  ]
  const raw = snappy.uncompress(Buffer.from(lit(enc(seriesOf(batches)))))
  const msg = WriteRequest.toObject(WriteRequest.decode(raw), { longs: String })
  const got = msg.timeseries.map((t) => [Object.fromEntries(t.labels.map((l) => [l.name, l.value])), t.samples.map((s) => [s.timestamp, s.value])])
  assert.equal(got.length, 2)
  assert.deepEqual(got[0][0], { __name__: 'job:up:sum', job: 'api' })
  assert.deepEqual(got[0][1][0], ['1795003200000', 3.5])
  assert.equal(got[0][1][1][0], '1795003260000')
  assert.ok(Number.isNaN(got[0][1][1][1]))
  assert.deepEqual(got[1], [{ __name__: 'job:up:sum', job: 'web' }, [['1795003200000', Infinity]]])
  // Labels go out sorted by name, as Prometheus sends them.
  for (const t of msg.timeseries) assert.deepEqual(t.labels.map((l) => l.name), [...t.labels.map((l) => l.name)].sort())
})
