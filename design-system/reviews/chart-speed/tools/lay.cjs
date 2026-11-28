// lay.cjs: where the layout of a drawn result goes. Loads Explore at --series on a built app (CPU 4x), then in the page re-writes
// one part of the chart with its own markup and times the forced style+layout that follows, N times each, alternating the parts.
//   VIZ_E2E_APP_PORT=… VIZ_E2E_MOCK_PORT=… node lay.cjs --lib <app>/e2e/lib.cjs --root <app> [--series 36] [--phone] [--n 15]
const path = require('node:path')
const arg = (n, f) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : f }
const lib = require(path.resolve(arg('lib')))
const ROOT = path.resolve(arg('root')); const SERIES = Number(arg('series', '36')); const N = Number(arg('n', '15')); const PHONE = process.argv.includes('--phone')
const Q = { 4: lib.Q_RATE, 36: lib.Q_MANY, 200: 'viz_synthetic_series' }[SERIES]
const VARIANTS = JSON.parse(require('node:fs').readFileSync(arg('variants'), 'utf8')) // {name: css}: each tried in turn, in every round
;(async () => {
  const stop = await lib.startServers(ROOT)
  const browser = await lib.chromium.launch()
  try {
    const ctx = await browser.newContext(PHONE ? { viewport: { width: 400, height: 800 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : { viewport: { width: 1440, height: 900 } })
    const page = await ctx.newPage()
    await page.goto(lib.url(Q))
    await page.waitForSelector('.vz-chart .vz-legend-table tbody tr[data-key]', { timeout: 30000 })
    await page.waitForTimeout(1500)
    const cdp = await ctx.newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate', { rate: Number(arg('cpu', '4')) })
    const out = await page.evaluate(async ([N, VARIANTS]) => {
      const tag = document.createElement('style'); document.head.appendChild(tag)
      const root = document.querySelector('.vz-chart'), svg = root.querySelector('svg'), tbody = root.querySelector('tbody'), thead = root.querySelector('thead'), note = root.querySelector('.vz-legend-note'), table = root.querySelector('table')
      const thr = Number(document.querySelectorAll('x').length); const S = svg.innerHTML, T = tbody.innerHTML, H = thead.innerHTML, NO = note.innerHTML
      const page = document.querySelector('main') || document.body
      const force = () => { const t = performance.now(); void document.documentElement.offsetHeight; return performance.now() - t }
      const styleOnlyForce = () => { const t = performance.now(); void getComputedStyle(document.body).color; return performance.now() - t }
      const removed = []
      const apply = (css) => { for (const [sh, r, i] of removed.splice(0)) sh.insertRule(r, i); tag.textContent = ''
        if (css.startsWith('drop:')) { const pat = css.slice(5); for (const sh of document.styleSheets) { if (sh.ownerNode === tag) continue; let rules; try { rules = sh.cssRules } catch { continue } for (let i = rules.length - 1; i >= 0; i--) { const r = rules[i]; if (r.selectorText && r.selectorText.includes(pat)) { removed.push([sh, r.cssText, i]); sh.deleteRule(i) } } } removed.reverse() }
        else tag.textContent = css }
      const parts = {
        none: () => {},
        svg: () => { svg.innerHTML = S },
        tbody: () => { tbody.innerHTML = T },
        legend: () => { table.querySelector('colgroup').outerHTML = table.querySelector('colgroup').outerHTML; thead.innerHTML = H; tbody.innerHTML = T; note.innerHTML = NO },
        both: () => { svg.innerHTML = S; table.querySelector('colgroup').outerHTML = table.querySelector('colgroup').outerHTML; thead.innerHTML = H; tbody.innerHTML = T; note.innerHTML = NO },
        styleOnly: () => { root.style.setProperty('--x', String(Math.random())) },
        wrapStyle: () => { root.querySelector('.vz-table-wrap').style.setProperty('--x', String(Math.random())) },
      }
      const res = {}; for (const v of Object.keys(VARIANTS)) for (const k of Object.keys(parts)) res[v + ' ' + k] = { write: [], style: [], layout: [] }
      for (let i = 0; i < N; i++) for (const [v, css] of Object.entries(VARIANTS)) { apply(css); force(); await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30)))
        for (const [k, f] of Object.entries(parts)) {
        force(); await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30)))
        const t0 = performance.now(); f(); const w = performance.now() - t0; const s = styleOnlyForce(); const l = force(); res[v + ' ' + k].write.push(w); res[v + ' ' + k].style.push(s); res[v + ' ' + k].layout.push(l)
      } }
      apply('')
      const med = (a) => { const s = [...a].sort((x, y) => x - y); return +s[Math.floor((s.length - 1) / 2)].toFixed(2) }
      const counts = { svgNodes: svg.querySelectorAll('*').length, rows: tbody.rows.length, cells: tbody.querySelectorAll('td').length, pageNodes: document.querySelectorAll('*').length, pathChars: [...svg.querySelectorAll('path')].reduce((a, p) => a + (p.getAttribute('d') || '').length, 0) }
      return { counts, med: Object.fromEntries(Object.entries(res).map(([k, v]) => [k, { write: med(v.write), style: med(v.style), layout: med(v.layout) }])) }
    }, [N, VARIANTS])
    console.log(JSON.stringify({ series: SERIES, phone: PHONE, counts: out.counts }))
    for (const [k, v] of Object.entries(out.med)) console.log(k.padEnd(36), 'write', String(v.write).padStart(6), 'style', String(v.style).padStart(6), 'layout', String(v.layout).padStart(6))
  } finally { await browser.close(); stop() }
})().catch((e) => { console.error(e); process.exit(1) })
