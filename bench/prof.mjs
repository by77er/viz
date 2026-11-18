import { readFileSync } from 'node:fs'
import { parquetMetadata, parquetRead } from 'hyparquet'
const b = readFileSync('data/js.parquet'); const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
const file = { byteLength: ab.byteLength, slice: (s, e) => ab.slice(s, e) }
const metadata = parquetMetadata(ab)
for (const col of ['metric_name', 'series_id', 'ts', 'value']) {
  const t = []
  for (let it = 0; it < 5; it++) { const s = performance.now(); let n = 0
    await parquetRead({ file, metadata, columns: [col], onChunk: (c) => { n += c.columnData.length } }); t.push(performance.now() - s) }
  console.log('js', col, Math.min(...t).toFixed(1), 'ms')
}
