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
