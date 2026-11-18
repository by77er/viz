// Counterfactual file: PLAIN encodings, which are the cheapest for a JS reader to decode.
import { readFileSync, writeFileSync } from 'node:fs'
import { ByteWriter, parquetWrite } from 'hyparquet-writer'
const meta = JSON.parse(readFileSync('data/meta.json', 'utf8'))
const load = (f, T) => { const b = readFileSync('data/' + f); return new T(b.buffer, b.byteOffset, b.byteLength / T.BYTES_PER_ELEMENT) }
const idx = load('name_idx.u32', Uint32Array), sid = load('series_id.i64', BigInt64Array), ts = load('ts.i64', BigInt64Array), val = load('value.f64', Float64Array)
const nameCol = Array.from(idx, (i) => meta.names[i])
const writer = new ByteWriter()
parquetWrite({ writer, rowGroupSize: 240000, pageSize: 256 * 1024, codec: 'SNAPPY', columnData: [
  { name: 'metric_name', data: nameCol, type: 'STRING', nullable: false },
  { name: 'series_id', data: sid, type: 'INT64', nullable: false, encoding: 'PLAIN' },
  { name: 'ts', data: ts, type: 'INT64', nullable: false, encoding: 'PLAIN' },
  { name: 'value', data: val, type: 'DOUBLE', nullable: false, encoding: 'PLAIN' } ] })
const out = new Uint8Array(writer.getBuffer()); writeFileSync('data/plain.parquet', out); console.log('plain MB', (out.length / 1048576).toFixed(2))
