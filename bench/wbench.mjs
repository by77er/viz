import { readFileSync } from 'node:fs'
const N = 15
for (const [impl, file] of [['noop', 'rust'], ['rust', 'rust'], ['js', 'js']]) for (const work of ['q1', 'q2']) {
  const body = readFileSync(`data/${file}.parquet`); const t = []; let last
  for (let i = 0; i < N; i++) { const s = performance.now(); const r = await fetch(`http://127.0.0.1:8799/${impl}/${work}`, { method: 'POST', body }); last = await r.json(); t.push(performance.now() - s) }
  const warm = t.slice(1).sort((a, b) => a - b)
  console.log(JSON.stringify({ impl, work, first_ms: +t[0].toFixed(1), median_ms: +warm[warm.length >> 1].toFixed(1), min_ms: +warm[0].toFixed(1), inner_ms: last.inner_ms, sum: last.sum.toPrecision(12), wasmMb: last.wasmMb }))
}
