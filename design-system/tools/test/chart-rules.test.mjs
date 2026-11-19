// The Chart rules as properties. Runs the reference chart's own functions (project/components/Chart/preview.html, the one source of
// dist/viz-chart.js) without a page, over random sequences of what happens to a view: series arriving and leaving, a filter applied and
// cleared (in the chart, or in the query), a query edited and edited back, values moving, Other opened and members picked, and the
// person's "Colour the eight largest". After every step it checks the properties the README states:
//   P1  a series that is in two consecutive results keeps its colour (slot, or Other), unless the person asked to colour the largest;
//   P2  a filter applied and cleared returns every series it hid in its own colour, whatever arrived or left meanwhile; a query edited
//       and edited back returns every series in its own colour;
//   P3  a series placed in a result (new, or back without its slot) goes to Other only when all eight slots are held; it takes its own
//       slot back whenever no present or filtered-out series holds it; among the series placed together, the larger is never grey while
//       the smaller is coloured;
//   P4  the readout's "highest" is the highest of every drawn series, members of Other included;
//   P5  the text form's threshold lines, Other line and note are computed over every drawn series, members of Other included;
//   P6  the legend note never claims a colour that is not drawn: its counts are the legend's, and "larger than a coloured series" needs
//       a coloured series.
// And the reviewer's two sequences (v5 review, images 01 and 02) as fixed cases, and one case per rule of M2 (negative values, precision,
// threshold scope, small negative values).
//   node --test tools/test/chart-rules.test.mjs            (VIZ_DS_ROOT=<other copy> runs it against another version of the system)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
const root = process.env.VIZ_DS_ROOT ? process.env.VIZ_DS_ROOT.replace(/\/?$/, '/') : new URL('../..', import.meta.url).pathname
const script = readFileSync(root + 'project/components/Chart/preview.html', 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1]
const win = {}
vm.runInNewContext(script, { window: win, document: { readyState: 'complete', querySelectorAll: () => [] }, sessionStorage: { getItem: () => null, setItem() {} }, Date, Math, JSON, Set, Map, Object, String, Number, Array, Infinity, console })
const R = win.vzChartRules, D = win.vzChartDemos
const v6 = typeof R.chartModel === 'function'

// ---- a view, driven the way the reference chart drives it ----
const MIN = 60000, T0 = Date.UTC(2026, 10, 18, 9, 16), STEP = 6 * MIN
const keyOf = (labels) => Object.keys(labels).sort().map((k) => k + '=' + labels[k]).join(',')
class View {
  constructor() { this.map = v6 ? R.newMap() : {}; this.clientFilter = null; this.serverOut = null; this.st = { picked: new Set(), pickOrder: [], open: 0 } }
  // one result: the series in it (labels, values), and the filters in force
  show(spec) {
    this.spec = spec
    const n = spec.series[0]?.values.length ?? 1, st = { ...this.st, t0: spec.t0, t1: spec.t0 + (n - 1) * spec.step, filter: this.clientFilter && ((s) => !this.clientFilter.has(s.key)), filteredOut: this.serverOut && ((k) => this.serverOut.has(k)) }
    if (v6) { this.m = R.chartModel(spec, this.map, st); this.vis = R.drawnSet(this.m, st); this.facts = R.chartFacts(this.m, this.vis, spec); return }
    // v5: the chart filtered first and assigned colours over what was left (its model(), verbatim in effect)
    const all = spec.series.map((s) => { const v = s.values.filter((x) => x != null); return { ...s, key: keyOf(s.labels), rank: v.length ? Math.max(...v) : -1 } })
    const listed = all.filter((s) => !st.filter || st.filter(s)); R.assignSeries(this.map, listed)
    this.m = { listed, all }
  }
  slot(k) { if (v6) return R.slotOf(this.map, k); const x = this.map[k]; return x === undefined ? undefined : x }
}

// ---- data ----
const rng = (seed) => { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }
const N = 12
function universe(r, count) { // pods with a heavy-tailed size, as a real fleet
  const out = new Map()
  for (let i = 0; i < count; i++) { const labels = { pod: 'pod-' + String(i).padStart(3, '0'), node: 'node-' + 'abcd'[i % 4] }, base = 3 * r() ** 4 + 0.02; out.set(keyOf(labels), { labels, base, values: wave(r, base) }) }
  return out
}
const wave = (r, base) => Array.from({ length: N }, () => +(base * (0.7 + 0.6 * r())).toFixed(4))
const specOf = (u, keys, extra = {}) => ({ unit: 'cores', agg: 'max', t0: T0, step: STEP, series: [...keys].map((k) => ({ labels: u.get(k).labels, values: u.get(k).values })), ...extra })

// ---- the properties, checked after each step ----
function checkStep(view, prev, ctx) {
  const inResult = new Set(view.spec.series.map((s) => keyOf(s.labels))), here = new Set([...inResult, ...(view.serverOut ?? [])])
  const slots = new Map([...here].map((k) => [k, view.slot(k)]))
  // P1: in two consecutive results (or filtered out in either), the same colour
  if (prev && !ctx.recoloured) for (const [k, s] of slots) if (prev.has(k)) assert.equal(s, prev.get(k), `P1 ${ctx.what}: ${k} changed from slot ${prev.get(k)} to ${s}`)
  // no two series in the result share a slot
  const used = new Map(); for (const [k, s] of slots) if (s) { assert.ok(!used.has(s), `slot ${s} held by ${k} and ${used.get(s)}`); used.set(s, k) }
  if (v6) {
    // P3: placed series go to Other only when all eight slots are held; larger placed series are never grey while a smaller one is coloured
    const placed = [...inResult].filter((k) => !prev?.has(k))
    const greyPlaced = placed.filter((k) => !slots.get(k)), colouredPlaced = placed.filter((k) => slots.get(k))
    if (greyPlaced.length && !ctx.recoloured) assert.equal(used.size, 8, `P3 ${ctx.what}: ${greyPlaced[0]} put in Other while only ${used.size} slots are held`)
    const rankOf = (k) => view.m.byKey.get(k)?.rank ?? -1
    const returningOk = (k) => ctx.claimedBack?.has(k) // a series given its own slot back is placed by its claim, not by rank
    for (const g of greyPlaced) for (const c of colouredPlaced) if (!returningOk(c) && !ctx.recoloured) assert.ok(rankOf(c) >= rankOf(g), `P3 ${ctx.what}: ${g} (${rankOf(g)}) grey while smaller ${c} (${rankOf(c)}) was coloured`)
    checkFacts(view, ctx)
  }
  return slots
}
function checkFacts(view, ctx) {
  const { m, vis, facts } = view, drawn = [...vis.lines, ...vis.picked, ...(vis.band ? m.other : [])]
  assert.deepEqual(new Set(facts.drawn.map((s) => s.key)), new Set(drawn.map((s) => s.key)), `drawn set ${ctx.what}`)
  // P4: highest at three points, over every drawn series
  for (const i of [0, Math.floor(m.n / 2), m.n - 1]) {
    const best = drawn.filter((s) => s.v[i] != null).reduce((a, s) => (!a || s.v[i] > a.v[i] ? s : a), null)
    assert.equal(facts.highestAt(i)?.v[i] ?? null, best?.v[i] ?? null, `P4 ${ctx.what}: highest at ${i}`)
  }
  // P5: threshold scope over every drawn series
  const th = view.spec.threshold?.value
  if (th != null) {
    const atEnd = drawn.filter((s) => s.last != null && s.last > th).map((s) => s.key).sort(), earlier = drawn.filter((s) => (s.max ?? -Infinity) > th && !(s.last != null && s.last > th)).map((s) => s.key).sort()
    assert.deepEqual(facts.threshold.aboveAtEnd.map((s) => s.key).sort(), atEnd, `P5 ${ctx.what}: above at the end`)
    assert.deepEqual(facts.threshold.aboveEarlier.map((s) => s.key).sort(), earlier, `P5 ${ctx.what}: above earlier`)
  }
  if (vis.band && m.other.length) { const top = m.other.reduce((a, s) => ((s.max ?? -Infinity) > (a.max ?? -Infinity) ? s : a)); assert.equal(facts.otherHighest?.key, top.key, `P5 ${ctx.what}: Other's highest member`) }
  // P6: the note's claims
  const note = facts.note
  if (!m.other.length) assert.equal(note, null, `P6 ${ctx.what}: a note about Other without an Other`)
  else if (!m.coloured.length) assert.equal(note.kind, 'none-coloured', `P6 ${ctx.what}: nothing coloured, the note says ${note.kind}`)
  else {
    const smallest = Math.min(...m.coloured.map((s) => s.max ?? -Infinity)), larger = m.other.filter((s) => (s.max ?? -Infinity) > smallest).length
    if (larger) { assert.equal(note.kind, 'larger'); assert.equal(note.count, larger, `P6 ${ctx.what}: larger count`) }
    else { assert.equal(note.kind, 'by-size'); assert.equal(note.coloured, m.coloured.length); assert.equal(note.other, m.other.length) }
  }
  // the text form carries the note and the threshold's names, members of Other named as such
  const text = R.textLines(m, vis, facts, view.spec, { title: 'T', fmt: R.numberFormat(0.5, '', 1) }).join('\n')
  if (note) assert.ok(text.includes(note.text), `P5 ${ctx.what}: the text form lacks the note "${note.text}"`)
  if (th != null) for (const s of facts.threshold.aboveAtEnd) assert.ok(text.includes(R.seriesName(m, s)), `P5 ${ctx.what}: the text form does not name ${s.key} above the threshold`)
}

// ---- the random sequences ----
const OPS = ['arrive', 'arrive', 'leave', 'leave', 'move', 'client-filter', 'server-filter', 'clear', 'edit-and-back', 'open-other', 'pick', 'recolour']
function runSequence(seed, steps) {
  const r = rng(seed), u = universe(r, 40), keys = [...u.keys()], view = new View(), result = new Set(keys.slice(0, 10 + Math.floor(r() * 20)))
  let prev = null, log = [], filtered = null, snapshot = null
  const threshold = r() < 0.5 ? { value: 1.5, label: '1.5 cores limit' } : null
  const show = (what, ctx = {}) => { view.show(specOf(u, result, threshold ? { threshold } : {})); log.push(what); prev = checkStep(view, prev, { what: log.join(' > '), ...ctx }) }
  show('first result')
  for (let i = 0; i < steps; i++) {
    const op = OPS[Math.floor(r() * OPS.length)]
    if (op === 'arrive') { const k = keys[Math.floor(r() * keys.length)]; if (result.has(k) || (filtered && filtered.has(k))) continue; const back = view.slot(k) !== undefined; result.add(k); if (r() < 0.3) u.get(k).values = wave(r, 3.5 * r()); show(`arrive ${k}`, { claimedBack: back ? new Set([k]) : null }) }
    else if (op === 'leave') { const pool = [...result].filter((k) => !filtered?.has(k)); if (pool.length < 2) continue; const k = pool[Math.floor(r() * pool.length)]; result.delete(k); show(`leave ${k}`) }
    else if (op === 'move') { for (const k of result) if (r() < 0.3) u.get(k).values = wave(r, 3.5 * r() ** 2); show('values move') }
    else if (op === 'client-filter' && !filtered) { filtered = new Set([...result].filter(() => r() < 0.3)); view.clientFilter = filtered; snapshot = new Map([...filtered].map((k) => [k, view.slot(k)])); show(`filter in the chart (${filtered.size})`) }
    else if (op === 'server-filter' && !filtered) { filtered = new Set([...result].filter(() => r() < 0.3)); for (const k of filtered) result.delete(k); view.serverOut = filtered; snapshot = new Map([...filtered].map((k) => [k, view.slot(k)])); show(`filter in the query (${filtered.size})`) }
    else if (op === 'clear' && filtered) {
      if (view.serverOut) for (const k of filtered) result.add(k)
      view.clientFilter = null; view.serverOut = null; show('clear the filter')
      if (v6 || true) for (const [k, s] of snapshot) assert.equal(view.slot(k), s, `P2 ${log.join(' > ')}: ${k} came back in slot ${view.slot(k)}, had ${s}`)
      filtered = null; snapshot = null
    } else if (op === 'edit-and-back' && !filtered) {
      const before = new Map([...result].map((k) => [k, view.slot(k)])), other = universe(r, 30), saved = new Set(result)
      for (const [k, v] of other) u.set('q2:' + k, { ...v, labels: { ...v.labels, service: 'search' } })
      const q2 = [...u.keys()].filter((k) => k.startsWith('q2:'))
      // the edited query: another service's pods (keys made unique by the service label)
      view.show(specOf(u, q2)); log.push('edit the query'); prev = null
      result.clear(); for (const k of saved) result.add(k)
      show('edit it back')
      for (const [k, s] of before) assert.equal(view.slot(k), s, `P2 ${log.join(' > ')}: ${k} came back in slot ${view.slot(k)}, had ${s}`)
      for (const k of q2) u.delete(k)
    } else if (op === 'open-other') { view.st.open = (view.st.open + 20) % 60; show('show more of Other') }
    else if (op === 'pick' && v6) { const m = view.m, k = m.other[Math.floor(r() * m.other.length)]?.key; if (!k) continue; if (view.st.picked.has(k)) { view.st.picked.delete(k); view.st.pickOrder = view.st.pickOrder.filter((q) => q !== k) } else if (view.st.pickOrder.length < 3) { view.st.picked.add(k); view.st.pickOrder.push(k) } show('pick a member of Other') }
    else if (op === 'recolour' && v6 && !filtered) { R.recolour(view.map, view.m); show('colour the eight largest', { recoloured: true }); view.st.picked.clear(); view.st.pickOrder = [] }
  }
}

test('B1, image 01: filter out the three largest, a larger pod arrives, clear: the largest returns in its own colour', () => {
  const view = new View(), spec = D.s36(), all = spec.series.map((s) => ({ key: keyOf(s.labels), max: Math.max(...s.values) })).sort((a, b) => b.max - a.max)
  view.show(spec); const before = new Map(all.map((s) => [s.key, view.slot(s.key)]))
  assert.equal(before.get(all[0].key), 1, 'the largest pod is slot 1 at first sight')
  const top3 = new Set(all.slice(0, 3).map((s) => s.key)); view.clientFilter = top3; view.show(spec)
  const next = D.s36(), r = (() => { let s = 99; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296 })()
  next.series.push({ labels: { __name__: 'pod_cpu_usage_cores', namespace: 'prod', service: 'checkout-api', pod: 'checkout-api-7d9f8c6b5-new01', node: 'node-b' }, values: Array.from({ length: 61 }, () => 3.4 + (r() - 0.5) * 0.3) })
  view.show(next); view.clientFilter = null; view.show(next)
  for (const s of all.slice(0, 8)) assert.equal(view.slot(s.key), before.get(s.key), `${s.key.match(/pod=([^,]+)/)[1]} came back in slot ${view.slot(s.key)}, had ${before.get(s.key)}`)
  if (v6) { assert.equal(view.facts.note.kind, 'larger'); assert.equal(view.facts.note.text, '1 in Other is now larger than a coloured series') }
})

test('B1, image 02: edit the query to another service and back: every colour returns, and the note stays true', () => {
  const view = new View(), spec = D.s36()
  view.show(spec); const before = new Map(spec.series.map((s) => [keyOf(s.labels), view.slot(keyOf(s.labels))]))
  const other = D.many(36, 37); for (const s of other.series) s.labels.service = 'search'
  view.show(other)
  view.show(D.s36())
  for (const [k, s] of before) assert.equal(view.slot(k), s, `${k.match(/pod=([^,]+)/)[1]}: slot ${view.slot(k)}, had ${s}`)
  if (v6) { assert.equal(view.m.coloured.length, 8); assert.equal(view.facts.note.text, '8 coloured by size when first seen; 28 in Other') }
})

test('B1: a filter in the query (not the chart) applied and cleared, with pods arriving meanwhile', () => {
  const view = new View(), spec = D.s36(), keys = spec.series.map((s) => keyOf(s.labels))
  view.show(spec); const before = new Map(keys.map((k) => [k, view.slot(k)])), coloured = keys.filter((k) => before.get(k))
  const out = new Set(coloured.slice(0, 3)); view.serverOut = out
  const narrowed = { ...spec, series: spec.series.filter((s) => !out.has(keyOf(s.labels))) }
  view.show(narrowed)
  narrowed.series.push({ labels: { pod: 'new-pod-1', namespace: 'prod' }, values: Array(61).fill(9) }); view.show(narrowed)
  view.serverOut = null; view.show({ ...spec, series: [...spec.series, narrowed.series.at(-1)] })
  for (const k of out) assert.equal(view.slot(k), before.get(k))
})

test('B1: random sequences of arrivals, departures, filters, query edits, Other opened and picked, recolouring', () => {
  for (let seed = 1; seed <= (v6 ? 400 : 60); seed++) runSequence(seed, 30)
})

test('M2: values below zero: the axis extends below zero and every value lies on the plot', () => {
  const ax = R.valueTicks({ lo: -120, hi: 120, plotH: 160, lineH: 16 })
  assert.ok(ax.bottom <= -120 && ax.top >= 120, `axis ${ax.bottom} to ${ax.top}`)
  assert.ok(ax.ticks.includes(0), 'zero is a tick')
  assert.ok(ax.ticks.length - 1 <= 4, 'at most four intervals')
  const pos = R.valueTicks({ lo: 3, hi: 912, plotH: 160, lineH: 16 }); assert.equal(pos.bottom, 0, 'all positive: from zero')
  const neg = R.valueTicks({ lo: -40, hi: -3, plotH: 160, lineH: 16 }); assert.equal(neg.top, 0, 'all negative: up to zero')
})
test('M2: a threshold is on the axis and does not inflate it', () => {
  const ax = R.valueTicks({ lo: 0, hi: 4.0, threshold: 3.5, plotH: 160, lineH: 16 })
  assert.ok(ax.top >= 4.0 && ax.top < 6, `top ${ax.top} (v5 put it at 6 from threshold x 1.15 then a step of 2)`)
  const high = R.valueTicks({ lo: 0, hi: 2, threshold: 5, plotH: 160, lineH: 16 }); assert.ok(high.top >= 5, 'a threshold above the data is still on the plot')
})
test('M2: precision is one decimal place finer than the place of the step\'s leading digit', () => {
  assert.equal(R.numberFormat(2.5, '').value(7.4321), '7.4')
  assert.equal(R.numberFormat(250, '').value(312.4), '312')
  assert.equal(R.numberFormat(1, '').value(1.25), '1.3')
  assert.equal(R.numberFormat(0.25, '').value(0.1234), '0.12')
  assert.equal(R.numberFormat(2.5, '').tick(7.5), '7.5')
})
test('M2: negative values keep their sign, and a small one says which side of zero it is', () => {
  assert.equal(R.numberFormat(1, '').value(-0.02), '> −0.1')
  assert.equal(R.numberFormat(1, '').value(0.02), '< 0.1')
  assert.equal(R.numberFormat(50, '').value(-120), '−120')
  assert.equal(R.numberFormat(50, '').tick(-50), '−50')
})
test('M1, image 06: a member of Other above the threshold is in the text form', () => {
  assert.ok(v6, 'v5 has no text form outside a page')
  const view = new View(), spec = D.s36()
  view.show(spec)
  const next = D.s36(); next.threshold = { value: 3.5, label: '3.5 cores limit' }
  next.series.push({ labels: { __name__: 'pod_cpu_usage_cores', namespace: 'prod', service: 'checkout-api', pod: 'checkout-api-7d9f8c6b5-new01', node: 'node-b' }, values: Array.from({ length: 61 }, (_, i) => 3.2 + 0.3 * Math.sin(i / 5) + (i === 60 ? 0.5 : 0)) })
  view.show(next)
  const text = R.textLines(view.m, view.vis, view.facts, next, { title: 'CPU by pod', fmt: R.numberFormat(1, '', 1) }).join('\n')
  assert.match(text, /3\.5 cores limit/)
  assert.match(text, /Other, checkout-api-7d9f8c6b5-new01/)
  assert.doesNotMatch(text, /no series above it/)
})
