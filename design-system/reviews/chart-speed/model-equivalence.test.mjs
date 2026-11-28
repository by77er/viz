// The chart's model before and after the speed change, as a property: for random results (gaps, negative values, steps with no element,
// series shorter than the grid, a zoomed range, a filter), `chartModel` of the two versions gives the same figures for every series
// (values in range, last, min, max, rank, slot), the same coloured and Other lists in the same order, the same band and the same unit;
// and `textLines` of both gives the same text form.
//   VIZ_BEFORE=<preview.html before the change> [VIZ_AFTER=<preview.html after>] node --test model-equivalence.test.mjs
// The second test needs no VIZ_BEFORE: the same results handed to the chart in its typed form (D76: Float64Array, NaN for a gap) give the
// same model, colour map and text form as in its first form (arrays, null for a gap).
// VIZ_AFTER defaults to this checkout's project/components/Chart/preview.html. The before version is in git:
//   git show <commit before>:design-system/project/components/Chart/preview.html > /tmp/before.html
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
const AFTER = process.env.VIZ_AFTER || new URL('../../project/components/Chart/preview.html', import.meta.url).pathname
const BEFORE = process.env.VIZ_BEFORE
const load = (file) => { const script = readFileSync(file, 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1], win = {}
  vm.runInNewContext(script, { window: win, document: { readyState: 'complete', querySelectorAll: () => [] }, sessionStorage: { getItem: () => null, setItem() {} } }); return win.vzChartRules }
const lcg = (seed) => { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296 }
// every number as itself, including the ones JSON loses
const plain = (x) => JSON.stringify(x, (k, v) => (ArrayBuffer.isView(v) ? Array.from(v) : typeof v === 'number' && !Number.isFinite(v) ? 'number:' + String(v) : Object.is(v, -0) ? 'number:-0' : v === undefined ? 'undefined' : v instanceof Map || typeof v === 'function' ? undefined : v))

function randomSpec(r) {
  const n = 1 + Math.floor(r() * 80), count = 1 + Math.floor(r() * 60), gaps = r() < 0.6 ? r() * 0.4 : 0, below = r() < 0.3, holes = r() < 0.15, short = r() < 0.15
  const series = []
  for (let i = 0; i < count; i++) {
    const base = (below ? -1 : 1) * 3 * Math.pow(r(), 4) + (r() < 0.1 ? 0 : 0.02), len = short && r() < 0.3 ? Math.floor(r() * n) : n, values = new Array(len)
    for (let k = 0; k < len; k++) { if (holes && r() < 0.05) continue; values[k] = r() < gaps ? null : r() < 0.02 ? 0 : base + (r() - 0.5) * base * 0.3 }
    if (r() < 0.05) values.fill(null)
    series.push({ labels: { __name__: 'm', pod: 'p' + i, node: 'n' + (i % 3) }, values })
  }
  const step = 60000, t0 = 1795000000000
  return { unit: ['cores', 'B', 'ms', 'req/s'][Math.floor(r() * 4)], agg: 'max', t0, step, series, ...(r() < 0.3 ? { threshold: { value: 1.5, label: 'limit' } } : {}), n }
}

test('chartModel and the text form are the same before and after, over random results', { skip: !BEFORE && 'set VIZ_BEFORE to the chart source before the change' }, () => {
  const A = load(BEFORE), B = load(AFTER), r = lcg(20261127)
  let withBand = 0, withGaps = 0, zoomed = 0
  for (let c = 0; c < 600; c++) {
    const spec = randomSpec(r), n = spec.n, a = Math.floor(r() * n), b = a + Math.floor(r() * (n - a)), zoom = r() < 0.4
    const view = { t0: spec.t0 + (zoom ? a : 0) * spec.step, t1: spec.t0 + (zoom ? b : n - 1) * spec.step, ...(r() < 0.2 ? { filter: (s) => s.labels.node !== 'n1' } : {}) }
    const mapA = A.newMap(), mapB = B.newMap(), runs = 1 + Math.floor(r() * 2)
    let ma, mb
    for (let k = 0; k < runs; k++) { ma = A.chartModel(spec, mapA, view); mb = B.chartModel(spec, mapB, view) }
    assert.equal(plain(mb), plain(ma), `case ${c}: the models differ`)
    assert.equal(plain(mapB), plain(mapA), `case ${c}: the colour maps differ`)
    if (ma.other.length) withBand++; if (ma.band.lo.includes(null)) withGaps++; if (zoom) zoomed++
    const va = A.drawnSet(ma, { picked: new Set(), pickOrder: [] }), vb = B.drawnSet(mb, { picked: new Set(), pickOrder: [] })
    const fa = A.numberFormat(0.5, ma.unit.suffix, ma.unit.div), fb = B.numberFormat(0.5, mb.unit.suffix, mb.unit.div)
    assert.deepEqual([...B.textLines(mb, vb, B.chartFacts(mb, vb, spec), spec, { title: 'T', fmt: fb })], [...A.textLines(ma, va, A.chartFacts(ma, va, spec), spec, { title: 'T', fmt: fa })], `case ${c}: the text forms differ`)
  }
  // the cases must have reached what the change touches
  assert.ok(withBand > 300 && withGaps > 100 && zoomed > 150, `too few cases with a band (${withBand}), a gap in the band (${withGaps}) or a zoom (${zoomed})`)
})

test('the typed form gives the same model, colour map and text form as the first form', () => {
  const B = load(AFTER), r = lcg(20261128)
  let typedViews = 0, withGaps = 0
  for (let c = 0; c < 600; c++) {
    const spec = randomSpec(r), n = spec.n, a = Math.floor(r() * n), b = a + Math.floor(r() * (n - a)), zoom = r() < 0.4
    // the first form as the app made it (every step has an element: a step with none is a gap, null), and the same values typed, NaN for a gap
    const first = { ...spec, series: spec.series.map((s) => ({ ...s, values: Array.from(s.values, (x) => (x === undefined ? null : x)) })) }
    const typed = { ...spec, series: first.series.map((s) => ({ ...s, values: Float64Array.from(s.values, (x) => (x === null ? NaN : x)) })) }
    const view = { t0: spec.t0 + (zoom ? a : 0) * spec.step, t1: spec.t0 + (zoom ? b : n - 1) * spec.step, ...(r() < 0.2 ? { filter: (s) => s.labels.node !== 'n1' } : {}) }
    const mapA = B.newMap(), mapB = B.newMap(), runs = 1 + Math.floor(r() * 2)
    let ma, mb
    for (let k = 0; k < runs; k++) { ma = B.chartModel(first, mapA, view); mb = B.chartModel(typed, mapB, view) }
    assert.equal(plain(mb), plain(ma), `case ${c}: the models differ`)
    assert.equal(plain(mapB), plain(mapA), `case ${c}: the colour maps differ`)
    typedViews += mb.result.filter((s) => ArrayBuffer.isView(s.v)).length; if (mb.result.some((s) => Array.isArray(s.v) && s.v.includes(null))) withGaps++
    const va = B.drawnSet(ma, { picked: new Set(), pickOrder: [] }), vb = B.drawnSet(mb, { picked: new Set(), pickOrder: [] })
    const f = B.numberFormat(0.5, ma.unit.suffix, ma.unit.div)
    assert.deepEqual([...B.textLines(mb, vb, B.chartFacts(mb, vb, typed), typed, { title: 'T', fmt: f })], [...B.textLines(ma, va, B.chartFacts(ma, va, first), first, { title: 'T', fmt: f })], `case ${c}: the text forms differ`)
    // nothing the chart was given was written to
    assert.equal(plain(typed.series.map((s) => Array.from(s.values, (x) => (Number.isNaN(x) ? null : x)))), plain(first.series.map((s) => s.values)), `case ${c}: the input changed`)
  }
  assert.ok(typedViews > 1000 && withGaps > 200, `too few typed series held without a copy (${typedViews}) or with a gap (${withGaps})`)
})
