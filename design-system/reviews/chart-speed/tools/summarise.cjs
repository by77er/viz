// Markdown tables from the alternating before/after files (ab.cjs --out).
//   node summarise.cjs ab-desktop.json ab-phone.json ...
// A cell is: median / 75th percentile (lowest to highest; runs that have the figure).
// "Pairs" compares run i of the first build with run i of the second, taken one after the other:
// the median of (second - first), and in how many pairs the second was the quicker.
const fs = require('node:fs')
const files = process.argv.slice(2)
const f0 = (x) => (x == null ? '-' : x.toFixed(0))
const cell = (o) => (o ? `${f0(o.median)} / ${f0(o.p75)} (${f0(o.min)} to ${f0(o.max)}; ${o.n})` : '-')
const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null }
for (const file of files) {
  const r = JSON.parse(fs.readFileSync(file, 'utf8'))
  console.log(`\n**${r.layout}**: ${r.setup}. Started ${r.when.slice(0, 16).replace('T', ' ')} UTC, calibration ${r.calibrationMs.toFixed(0)} ms, ${r.cores} cores. \`${file.split('/').pop()}\`\n`)
  console.log('| Series | Build | Load at run start: median (range); runs at or below 4 | Body read to painted, ms | Last byte to painted, ms | Chart to table, ms |')
  console.log('|---|---|---|---|---|---|')
  for (const [n, c] of Object.entries(r.cases).sort((a, b) => a[0] - b[0])) {
    for (const b of r.builds) {
      const s = c[b.name].summary
      console.log(`| ${n} | ${b.name} | ${s.load1.median.toFixed(1)} (${s.load1.min.toFixed(1)} to ${s.load1.max.toFixed(1)}); ${s.judged} of ${s.runs} | ${cell(s.response)} | ${cell(s.responseFull)} | ${cell(s.chartToTable)} |`)
    }
    const [A, B] = r.builds.map((b) => c[b.name].raw)
    const pair = (k) => { const d = []; for (let i = 0; i < Math.min(A.length, B.length); i++) if (A[i][k] != null && B[i][k] != null) d.push(B[i][k] - A[i][k]); return d.length ? `${med(d) > 0 ? '+' : ''}${f0(med(d))}; quicker in ${d.filter((x) => x < 0).length} of ${d.length}` : '-' }
    console.log(`| ${n} | pairs: ${r.builds[1].name} less ${r.builds[0].name} | | ${pair('response')} | ${pair('responseFull')} | ${pair('chartToTable')} |`)
  }
}
