/* eslint-disable */
// legend-writes.test.cjs: the legend written part by part (2026-11-28, C5 of ../third-review.md) leaves the same DOM, and focus in
// the same place, as the legend written afresh on every draw. A differential property test: the same random sequence of results and
// actions is played on the chart of two builds of design-system/dist (VIZ_BEFORE: written afresh; VIZ_AFTER: part by part), and
// after every step the chart's whole markup and the focused element must be equal.
//   VIZ_BEFORE=<design-system dir> VIZ_AFTER=<design-system dir> node --test legend-writes.test.cjs
// Steps: a new result (the same series with new figures; the same result; other series; the same series in another order; fewer
// series), Zoom in and out, a keyboard readout, Escape, Show more / Hide of Other, a sort, a legend row chosen, focus on a legend row
// before a new result, the chart's width changed (900 to 400 px or back: the narrow legend). Widths 900 and 400 px to start, 40 seeds
// of 30 steps each.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { chromium } = require('playwright')
const BEFORE = path.resolve(process.env.VIZ_BEFORE), AFTER = path.resolve(process.env.VIZ_AFTER)
const SEEDS = Number(process.env.VIZ_SEEDS || 40), STEPS = 30

function page(ds, width) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lw-')), 'p.html')
  fs.writeFileSync(f, `<!doctype html><html class="vz" data-theme="light"><head><meta charset="utf-8"><link rel="stylesheet" href="file://${ds}/dist/viz.css"></head><body class="vz"><main style="width:${width}px"><section class="vz-panel"><h2 class="vz-panel-title">T</h2><div class="vz-panel-body"><div class="vz-chart" data-view="t${width}"></div></div></section></main><script src="file://${ds}/dist/viz-chart.js"></script></body></html>`)
  return 'file://' + f
}

/** Plays one seed in a page; returns the markup and the focused element after every step. */
async function play(browser, ds, width, seed) {
  const ctx = await browser.newContext({ viewport: { width: width + 40, height: 900 } })
  const p = await ctx.newPage()
  await p.goto(page(ds, width))
  await p.waitForFunction(() => typeof window.vzChart === 'function')
  const trace = await p.evaluate(async ({ seed, STEPS }) => {
    try { sessionStorage.clear() } catch {}
    const lcg = (s) => () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296
    const r = lcg(seed)
    const n = 20 + Math.floor(r() * 50), t0 = Date.UTC(2026, 10, 18, 9, 30), step = 60000
    const make = (labels, scale) => ({ unit: r() < 0.5 ? 'req/s' : 'cores', agg: 'max', t0, step, series: labels.map((l, i) => ({ labels: l, values: Array.from({ length: n }, (_, k) => (r() < 0.05 ? null : scale * (1 + i) * (1 + 0.3 * Math.sin(k / 5 + i)) * (0.8 + 0.4 * r()))) })) })
    const labelsOf = (count, base) => Array.from({ length: count }, (_, i) => ({ __name__: 'm', service: 's' + ((i + base) % 7), pod: 'p' + (i + base) }))
    let labels = labelsOf(1 + Math.floor(r() * 45), 0), spec = make(labels, 1)
    const el = document.querySelector('.vz-chart'), vz = window.vzChart(el, spec)
    const snap = (what) => ({ what, html: el.outerHTML, focus: document.activeElement === document.body ? 'body' : document.activeElement.outerHTML.slice(0, 160) })
    const out = [snap('first')]
    const click = (sel) => { const b = el.querySelector(sel); if (b && !b.disabled) b.click(); return !!b }
    const key = (k) => { const t = document.activeElement; t.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })) }
    for (let s = 0; s < STEPS; s++) {
      const x = r()
      let what
      if (x < 0.14) { what = 'same series, new figures'; spec = make(labels, 1 + r()); vz.setData(spec) }
      else if (x < 0.22) { what = 'the same result'; vz.setData(spec) }
      else if (x < 0.28) { what = 'other series'; labels = labelsOf(1 + Math.floor(r() * 45), Math.floor(r() * 9)); spec = make(labels, 1); vz.setData(spec) }
      else if (x < 0.33) { what = 'same series, another order'; labels = [...labels].reverse(); spec = make(labels, 1); vz.setData(spec) }
      else if (x < 0.37) { what = 'fewer series'; labels = labels.slice(0, Math.max(1, labels.length - 1 - Math.floor(r() * 5))); spec = make(labels, 1); vz.setData(spec) }
      else if (x < 0.45) { what = 'zoom in'; click('[data-zoom="in"]') }
      else if (x < 0.52) { what = 'zoom out'; click('[data-zoom="out"]') }
      else if (x < 0.60) { what = 'readout by keyboard'; el.querySelector('svg').focus(); for (let k = 0; k < 1 + Math.floor(r() * 6); k++) key('ArrowLeft') }
      else if (x < 0.64) { what = 'Escape'; el.querySelector('svg').focus(); key('Escape') }
      else if (x < 0.70) { what = 'more or less'; click('[data-more]') || click('[data-less]') }
      else if (x < 0.76) { what = 'sort'; const bs = el.querySelectorAll('.vz-sort'); if (bs.length) bs[Math.floor(r() * bs.length)].click() }
      else if (x < 0.84) { what = 'a row chosen'; const rows = el.querySelectorAll('tbody tr[data-key] .vz-series'); if (rows.length) rows[Math.floor(r() * rows.length)].click() }
      else if (x < 0.92) { what = 'focus on a row, then new figures'; const rows = el.querySelectorAll('tbody tr[data-key] .vz-series'); if (rows.length) rows[Math.floor(r() * rows.length)].focus(); spec = make(labels, 1 + r()); vz.setData(spec) }
      else if (x < 0.96) { what = 'blur, then the same result'; document.activeElement?.blur(); vz.setData(spec) }
      else { what = 'the other width'; const m = document.querySelector('main'); m.style.width = m.style.width === '400px' ? '900px' : '400px'; await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res))) }
      await new Promise((res) => requestAnimationFrame(() => setTimeout(res, 0)))
      out.push(snap(what))
    }
    return out
  }, { seed, STEPS })
  await ctx.close()
  return trace
}

test('the legend written part by part leaves the same DOM and focus as written afresh', async () => {
  const browser = await chromium.launch()
  let steps = 0
  try {
    for (const width of [900, 400]) for (let seed = 1; seed <= SEEDS; seed++) {
      const a = await play(browser, BEFORE, width, seed), b = await play(browser, AFTER, width, seed)
      assert.equal(a.length, b.length)
      for (let k = 0; k < a.length; k++) {
        steps++
        assert.equal(b[k].what, a[k].what)
        assert.equal(b[k].html, a[k].html, `width ${width}, seed ${seed}, step ${k} (${a[k].what}): markup differs`)
        assert.equal(b[k].focus, a[k].focus, `width ${width}, seed ${seed}, step ${k} (${a[k].what}): focus differs`)
      }
    }
  } finally { await browser.close() }
  console.log(`# ${steps} steps compared`)
})
