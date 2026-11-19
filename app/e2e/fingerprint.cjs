/* eslint-disable */
// "Same data, same geometry" (AGENTS.md, Evidence): before two builds' speeds are compared,
// each must render the same result identically. For the three cases of e2e/measure.cjs this
// records, unthrottled, what a person gets: the chart's pixels (SHA-256 of the canvas), the
// legend, the table (every row), the text digest and the JSON form, and compares two builds.
//
//   node e2e/fingerprint.cjs --root <app dir> --label <name>     writes e2e/measurements/fingerprint-<name>.json
//   node e2e/fingerprint.cjs --compare <name> <name>             exits 1 if anything differs
const path = require('node:path')
const fs = require('node:fs')
const crypto = require('node:crypto')
const lib = require('./lib.cjs')

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback }
const file = (label) => path.join(lib.ROOT, 'e2e', 'measurements', `fingerprint-${label}.json`)
const CASES = { 4: lib.Q_RATE, 36: lib.Q_MANY, 200: 'viz_synthetic_series' }

async function record() {
  const root = path.resolve(arg('root', lib.ROOT))
  const label = arg('label', 'after')
  const stop = await lib.startServers(root)
  const browser = await lib.chromium.launch()
  const out = {}
  try {
    for (const [n, q] of Object.entries(CASES)) {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: 'light' })
      const page = await ctx.newPage()
      await page.goto(lib.url(q))
      await page.waitForSelector('[data-testid=legend] tbody tr', { timeout: 60000 })
      await page.waitForSelector('[data-testid=chart] canvas')
      await page.evaluate(() => document.fonts.ready)
      await page.waitForTimeout(1500)
      const pixels = await page.evaluate(() => { const c = document.querySelector('[data-testid=chart] canvas'); return Array.from(c.getContext('2d').getImageData(0, 0, c.width, c.height).data) })
      const r = { canvas: crypto.createHash('sha256').update(Buffer.from(pixels)).digest('hex') }
      if (await page.$('[data-testid=legend-other]')) await page.click('[data-testid=legend-other]')
      for (let i = 0; i < 10 && (await page.$('[data-testid=legend-more]')); i++) await page.click('[data-testid=legend-more]')
      r.legend = await page.$eval('[data-testid=legend]', (e) => e.innerText)
      r.status = await page.$eval('[data-testid=status]', (e) => e.innerText)
      await page.click('[data-testid=view-table]')
      await page.waitForSelector('[data-testid=result-table] tbody tr')
      for (let i = 0; i < 10 && (await page.$('[data-testid=table-more]')); i++) await page.click('[data-testid=table-more]')
      r.table = await page.$eval('[data-testid=result-table]', (e) => e.innerText)
      await page.click('[data-testid=view-text]')
      await page.waitForSelector('[data-testid=text-view] pre')
      r.text = await page.$eval('[data-testid=text-view] pre', (e) => e.textContent)
      await page.click('[data-testid=view-json]')
      await page.waitForSelector('[data-testid=result-json] pre')
      // The caption carries the answer's time, which differs every run: only the body is compared.
      r.json = await page.$eval('[data-testid=result-json] pre', (e) => e.textContent)
      out[n] = r
      console.log(`${n} series: canvas ${r.canvas.slice(0, 12)}, legend ${r.legend.length} chars, table ${r.table.length}, text ${r.text.length}, json ${r.json.length}`)
      await ctx.close()
    }
  } finally {
    await browser.close()
    stop()
  }
  fs.writeFileSync(file(label), JSON.stringify({ root, when: new Date().toISOString(), cases: out }, null, 2) + '\n')
}

function compare(a, b) {
  const A = JSON.parse(fs.readFileSync(file(a), 'utf8')).cases
  const B = JSON.parse(fs.readFileSync(file(b), 'utf8')).cases
  let diffs = 0
  for (const n of Object.keys(A)) for (const k of Object.keys(A[n])) {
    const same = A[n][k] === B[n]?.[k]
    if (!same) diffs++
    console.log(`${same ? 'same' : 'DIFF'}  ${n} series, ${k}${same ? '' : `: ${String(A[n][k]).slice(0, 80)} | ${String(B[n]?.[k]).slice(0, 80)}`}`)
  }
  console.log(diffs ? `${diffs} differences` : 'identical')
  process.exit(diffs ? 1 : 0)
}

const c = process.argv.indexOf('--compare')
if (c >= 0) compare(process.argv[c + 1], process.argv[c + 2])
else record().catch((e) => { console.error(e); process.exit(1) })
