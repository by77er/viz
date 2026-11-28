// The Chart rules as properties. Runs the reference chart's own functions (project/components/Chart/preview.html, the one source of
// dist/viz-chart.js) without a page, over random sequences of what happens to a view: series arriving and leaving, a filter applied and
// cleared (in the chart, or in the query), a query edited and edited back, values moving, Other opened and members picked, and the
// person's "Colour the eight largest" (with or without a filter in force). After every step it checks the properties the Chart README
// states ("Series colour", the algorithm: what a person sees wins). A series is on screen when it is in the result and the view's filter
// does not hide it; hidden when the view's filter hides it (in the chart, or a label matcher in the query); away otherwise.
//   P1  a series on screen at two consecutive steps that has a colour keeps it (unless the person asked to colour the largest); a series
//       on screen in Other that takes a colour takes one that no series on screen had at the step before;
//   Twins: the same narrowing done by editing the query and by a dashboard filter gives the same colours, step by step; toggling
//       legend rows never changes a colour.
//   P2  a query edited to series it does not share and edited back returns every series in its own colour;
//   P3  a series on screen is grey only while all eight slots are held on screen ("what a person sees wins": a slot whose series is
//       hidden or away is open, v8); a series coming on screen takes its own slot back
//       whenever no other series on screen holds it; hidden series never gain a slot; a series that takes a colour (other than its own
//       slot back) is never smaller than a series left grey;
//   P4  the readout's "highest" is the highest of every drawn series, members of Other included;
//   P5  the text form's threshold lines, Other line and note are computed over every drawn series, members of Other included;
//   P6  the legend note never claims a colour that is not drawn: its counts are the legend's, and "larger than a coloured series" needs
//       a coloured series;
//   P7  "Colour the eight largest" colours the eight largest series on screen, largest in slot 1, and nothing hidden or away;
//   P8  "Colour the eight largest" is offered exactly when one of the eight largest series on screen is not coloured, so pressing it
//       always changes a colour (v9: the lead's decision on the v8 review's m3), and pressing it then colours each of them.
// Fixed cases: the v7 review's narrowed query (M1), done both ways, the v6 review's sequences D and E (B2), each blocker example of the
// review rubric's Many series row, the v5 review's
// sequences under the v7 rule, flow screen 5, and one case per rule of v5's M2 (negative values, precision, threshold scope, small
// negative values).
//   node --test tools/test/chart-rules.test.mjs            (VIZ_DS_ROOT=<other copy> runs it against another version of the system;
//                                                          VIZ_NO_OFFER=1 leaves out P8, the check of when the recolour is offered, to see an older
//                                                          version's colour failures apart from that one)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
const root = process.env.VIZ_DS_ROOT ? process.env.VIZ_DS_ROOT.replace(/\/?$/, '/') : new URL('../..', import.meta.url).pathname
const script = readFileSync(root + 'project/components/Chart/preview.html', 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1]
const win = {}
vm.runInNewContext(script, { window: win, document: { readyState: 'complete', querySelectorAll: () => [] }, sessionStorage: { getItem: () => null, setItem() {} }, Date, Math, JSON, Set, Map, Object, String, Number, Array, Infinity, console })
const R = win.vzChartRules, D = win.vzChartDemos
// what the action row under Other offers (v7 and earlier had no function for it: their legend offered the recolour only when a member of
// Other was larger than a coloured series or none was coloured)
const actions = (m) => (R.legendActions ? R.legendActions(m) : m.other.length ? ['more', ...(m.larger.length || !m.coloured.length ? ['recolour'] : [])] : [])

// ---- a view, driven the way the reference chart drives it ----
const MIN = 60000, T0 = Date.UTC(2026, 10, 18, 9, 16), STEP = 6 * MIN
const keyOf = (labels) => Object.keys(labels).sort().map((k) => k + '=' + labels[k]).join(',')
const podOf = (k) => k == null ? 'none' : (k.match(/pod=([^,]+)/) ?? k.match(/service=([^,]+)/) ?? [k, k])[1]
class View {
  constructor() { this.map = R.newMap(); this.clientFilter = null; this.serverOut = null; this.st = { picked: new Set(), pickOrder: [], open: 0 }; this.known = new Set() }
  // one result: the series in it (labels, values), and the filters in force
  show(spec) {
    this.spec = spec
    const n = spec.series[0]?.values.length ?? 1, st = { ...this.st, t0: spec.t0, t1: spec.t0 + (n - 1) * spec.step, filter: this.clientFilter && ((s) => !this.clientFilter.has(s.key)), filteredOut: this.serverOut && ((k) => this.serverOut.has(k)) }
    this.m = R.chartModel(spec, this.map, st); this.vis = R.drawnSet(this.m, st); this.facts = R.chartFacts(this.m, this.vis, spec)
    for (const s of this.m.result) this.known.add(s.key)
  }
  slot(k) { return R.slotOf(this.map, k) || 0 }
  // where every series the view has seen is now
  states() {
    const screen = new Set(this.m.listed.map((s) => s.key)), hidden = new Set([...this.m.result.map((s) => s.key).filter((k) => !screen.has(k)), ...(this.serverOut ?? [])])
    const away = new Set([...this.known].filter((k) => !screen.has(k) && !hidden.has(k)))
    return { screen, hidden, away }
  }
  rank(k) { return this.m.byKey.get(k)?.rank ?? -Infinity }
  recolour() { R.recolour(this.map, this.m); this.st.picked.clear(); this.st.pickOrder = [] }
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
const lcg = (seed) => { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296 }
const newPod = (name = 'checkout-api-7d9f8c6b5-new01', level = 3.4) => { const r = lcg(99); return { labels: { __name__: 'pod_cpu_usage_cores', namespace: 'prod', service: 'checkout-api', pod: name, node: 'node-b' }, values: Array.from({ length: 61 }, () => level + (r() - 0.5) * 0.3) } }
const ranked = (spec) => spec.series.map((s) => ({ key: keyOf(s.labels), max: Math.max(...s.values.filter((v) => v != null)) })).sort((a, b) => b.max - a.max)

// ---- the properties, checked after each step ----
// prev: Map key -> slot for the series on screen at the step before; ctx.lastOn: Map key -> the slot it had when it was last on screen
function checkStep(view, prev, ctx) {
  const { screen, hidden } = view.states(), slots = new Map([...screen].map((k) => [k, view.slot(k)]))
  // no two series on screen or hidden hold one slot (a series away may still name the slot it waits for)
  const own = new Map(); for (const k of [...screen, ...hidden]) { const s = view.slot(k); if (s) { assert.ok(!own.has(s), `${ctx.what}: slot ${s} held by ${podOf(k)} and ${podOf(own.get(s))}`); own.set(s, k) } }
  if (ctx.recoloured) ctx.seen.clear()
  for (const s of own.keys()) ctx.seen.add(s)
  if (prev && !ctx.recoloured) for (const [k, s] of slots) if (prev.has(k)) {
    // P1: a colour on screen is kept while the series stays on screen
    if (prev.get(k)) assert.equal(s, prev.get(k), `P1 ${ctx.what}: ${podOf(k)} stayed on screen and changed from slot ${prev.get(k)} to ${s}`)
    // P1: a series on screen leaves Other only for a slot no series that stays on screen had
    else if (s) assert.ok(![...prev].some(([q, t]) => q !== k && t === s && screen.has(q)), `P1 ${ctx.what}: ${podOf(k)} took slot ${s} from a series that stays on screen`)
  }
  // P3: what a person sees wins: a series on screen is grey only while all eight slots are held on screen (a slot whose owner is hidden
  // or away is open, like a free one: v8, the v7 review's M1)
  const grey = [...screen].filter((k) => !slots.get(k)), heldOnScreen = [1, 2, 3, 4, 5, 6, 7, 8].filter((i) => own.has(i) && screen.has(own.get(i)))
  if (grey.length) assert.equal(heldOnScreen.length, 8, `P3 ${ctx.what}: ${grey.length} on screen in Other (the largest ${podOf(grey.sort((a, b) => view.rank(b) - view.rank(a))[0])}) while only ${heldOnScreen.length} slots are held on screen`)
  // P8 (v9: the lead's decision on the v8 review's m3, "every response meaningful"): "Colour the eight largest" is offered exactly when
  // pressing it would change a colour, that is, when one of the eight largest series on screen is not coloured; pressing it then colours
  // every one of them. (Before v9: offered wherever a series on screen was grey, also when the eight largest were already coloured.)
  if (!process.env.VIZ_NO_OFFER) {
    const top8 = [...screen].sort((a, b) => view.rank(b) - view.rank(a) || (a < b ? -1 : 1)).slice(0, 8), greyTop = top8.filter((k) => !slots.get(k)), offered = actions(view.m).includes('recolour')
    if (greyTop.length) assert.ok(offered, `P8 ${ctx.what}: ${podOf(greyTop[0])}, one of the eight largest on screen, is grey and "Colour the eight largest" is not offered`)
    else assert.ok(!offered, `P8 ${ctx.what}: the eight largest on screen are all coloured and "Colour the eight largest" is offered: pressing it would colour no series that is grey`)
    if (offered) { const copy = JSON.parse(JSON.stringify(view.map)); R.recolour(copy, view.m); const left = greyTop.find((k) => !R.slotOf(copy, k)); assert.ok(!left, `P8 ${ctx.what}: pressing "Colour the eight largest" would leave ${podOf(left)}, one of the eight largest, grey`) } }
  // P3: a series coming on screen takes its own slot back whenever no other series on screen holds it
  for (const k of screen) if (prev && !prev.has(k) && !ctx.recoloured) { const had = ctx.lastOn.get(k)
    if (had && slots.get(k) !== had) assert.ok(screen.has(own.get(had)) && own.get(had) !== k, `P3 ${ctx.what}: ${podOf(k)} came back ${slots.get(k) ? 'in slot ' + slots.get(k) : 'grey'} while slot ${had}, its own, is held by no series on screen`) }
  // P3: hidden series never gain a slot
  for (const k of hidden) { const s = view.slot(k); if (s) assert.equal(s, ctx.lastOn.get(k), `P3 ${ctx.what}: hidden ${podOf(k)} has slot ${s}, which it never had on screen`) }
  // P3: by rank: a series that took a colour in this step, other than one taking back its own slot, is never smaller than a series
  // left grey on screen
  if (prev && !ctx.recoloured) for (const [k, s] of slots) { const own0 = !prev.has(k) && ctx.lastOn.get(k) === s, before = prev.get(k)
    if (s && before !== s && !own0) for (const g of grey) assert.ok(view.rank(k) >= view.rank(g), `P3 ${ctx.what}: ${podOf(k)} (${view.rank(k)}) took slot ${s} while the larger ${podOf(g)} (${view.rank(g)}) stays grey`) }
  // P7: "Colour the eight largest" colours the eight largest on screen, largest first
  if (ctx.recoloured) { const order = [...screen].sort((a, b) => view.rank(b) - view.rank(a) || (a < b ? -1 : 1))
    order.forEach((k, i) => assert.equal(slots.get(k), i < 8 ? i + 1 : 0, `P7 ${ctx.what}: ${podOf(k)}, ${i + 1}th largest on screen, in slot ${slots.get(k)}`))
    for (const k of view.known) if (!screen.has(k)) { assert.equal(view.slot(k), 0, `P7 ${ctx.what}: ${podOf(k)} is not on screen and kept slot ${view.slot(k)}`); ctx.lastOn.delete(k) } }
  for (const [k, s] of slots) ctx.lastOn.set(k, s)
  checkFacts(view, ctx)
  return slots
}
function checkFacts(view, ctx) {
  const { m, vis, facts } = view, drawn = [...vis.lines, ...vis.picked, ...(vis.band ? m.other : [])]
  assert.deepEqual(new Set([...facts.drawn].map((s) => s.key)), new Set(drawn.map((s) => s.key)), `drawn set ${ctx.what}`)
  // P4: highest at three points, over every drawn series
  for (const i of [0, Math.floor(m.n / 2), m.n - 1]) {
    const best = drawn.filter((s) => s.v[i] != null).reduce((a, s) => (!a || s.v[i] > a.v[i] ? s : a), null)
    assert.equal(facts.highestAt(i)?.v[i] ?? null, best?.v[i] ?? null, `P4 ${ctx.what}: highest at ${i}`)
  }
  // P5: threshold scope over every drawn series
  const th = view.spec.threshold?.value
  if (th != null) {
    const atEnd = drawn.filter((s) => s.last != null && s.last > th).map((s) => s.key).sort(), earlier = drawn.filter((s) => (s.max ?? -Infinity) > th && !(s.last != null && s.last > th)).map((s) => s.key).sort()
    assert.deepEqual([...facts.threshold.aboveAtEnd].map((s) => s.key).sort(), atEnd, `P5 ${ctx.what}: above at the end`)
    assert.deepEqual([...facts.threshold.aboveEarlier].map((s) => s.key).sort(), earlier, `P5 ${ctx.what}: above earlier`)
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
// a fixed sequence with the properties checked at every step
function stepper() {
  const view = new View(), ctx = { lastOn: new Map(), seen: new Set(), log: [] }; let prev = null
  const step = (what, fn, opts = {}) => { fn?.(view); ctx.log.push(what); prev = checkStep(view, prev, { ...ctx, what: ctx.log.join(' > '), ...opts }); return view }
  return { view, step }
}

// ---- the random sequences ----
const OPS = ['arrive', 'arrive', 'leave', 'leave', 'move', 'client-filter', 'server-filter', 'clear', 'edit-and-back', 'narrow-and-back', 'open-other', 'pick', 'recolour']
function runSequence(seed, steps) {
  const r = rng(seed), u = universe(r, 40), keys = [...u.keys()], view = new View(), result = new Set(keys.slice(0, 10 + Math.floor(r() * 20)))
  let prev = null, log = [], filtered = null; const lastOn = new Map(), seen = new Set()
  const threshold = r() < 0.5 ? { value: 1.5, label: '1.5 cores limit' } : null
  const show = (what, ctx = {}) => { view.show(specOf(u, result, threshold ? { threshold } : {})); log.push(what); prev = checkStep(view, prev, { what: log.join(' > '), lastOn, seen, ...ctx }) }
  show('first result')
  for (let i = 0; i < steps; i++) {
    const op = OPS[Math.floor(r() * OPS.length)]
    if (op === 'arrive') { const k = keys[Math.floor(r() * keys.length)]; if (result.has(k) || (filtered && filtered.has(k))) continue; result.add(k); if (r() < 0.3) u.get(k).values = wave(r, 3.5 * r()); show(`arrive ${podOf(k)}`) }
    else if (op === 'leave') { const pool = [...result].filter((k) => !filtered?.has(k)); if (pool.length < 2) continue; const k = pool[Math.floor(r() * pool.length)]; result.delete(k); show(`leave ${podOf(k)}`) }
    else if (op === 'move') { for (const k of result) if (r() < 0.3) u.get(k).values = wave(r, 3.5 * r() ** 2); show('values move') }
    else if (op === 'client-filter' && !filtered) { filtered = new Set([...result].filter(() => r() < 0.3)); view.clientFilter = filtered; show(`filter in the chart (${filtered.size})`) }
    else if (op === 'server-filter' && !filtered) { filtered = new Set([...result].filter(() => r() < 0.3)); for (const k of filtered) result.delete(k); view.serverOut = filtered; show(`filter in the query (${filtered.size})`) }
    else if (op === 'clear' && filtered) {
      if (view.serverOut) for (const k of filtered) result.add(k)
      // P2: a hidden series that still holds its slot when the filter is cleared (no series on screen needed it) comes back in it
      const snapshot = new Map([...filtered].map((k) => [k, view.slot(k)]))
      view.clientFilter = null; view.serverOut = null; show('clear the filter')
      for (const [k, s] of snapshot) if (s) assert.equal(view.slot(k), s, `P2 ${log.join(' > ')}: ${podOf(k)} held slot ${s} while hidden and came back in slot ${view.slot(k)}`)
      filtered = null
    } else if (op === 'edit-and-back' && !filtered) {
      const before = new Map([...result].map((k) => [k, view.slot(k)])), other = universe(r, 30), saved = new Set(result)
      for (const [k, v] of other) u.set('q2:' + k, { ...v, labels: { ...v.labels, service: 'search' } })
      const q2 = [...u.keys()].filter((k) => k.startsWith('q2:'))
      // the edited query: another service's pods (keys made unique by the service label)
      view.show(specOf(u, q2)); log.push('edit the query'); prev = checkStep(view, prev, { what: log.join(' > '), lastOn, seen })
      result.clear(); for (const k of saved) result.add(k)
      show('edit it back')
      for (const [k, s] of before) assert.equal(view.slot(k), s, `P2 ${log.join(' > ')}: ${podOf(k)} came back in slot ${view.slot(k)}, had ${s}`)
      for (const k of q2) u.delete(k)
    } else if (op === 'narrow-and-back' && !filtered) { // a query narrowed to part of what it showed, and edited back: the colours follow the screen
      const saved = new Set(result), keep = new Set([...result].filter(() => r() < 0.4)); if (!keep.size) continue
      result.clear(); for (const k of keep) result.add(k); show(`narrow the query (${keep.size})`)
      result.clear(); for (const k of saved) result.add(k); show('edit it back')
    } else if (op === 'open-other') { view.st.open = (view.st.open + 20) % 60; show('show more of Other') }
    else if (op === 'pick') { const m = view.m, k = m.other[Math.floor(r() * m.other.length)]?.key; if (!k) continue; if (view.st.picked.has(k)) { view.st.picked.delete(k); view.st.pickOrder = view.st.pickOrder.filter((q) => q !== k) } else if (view.st.pickOrder.length < 3) { view.st.picked.add(k); view.st.pickOrder.push(k) } show('pick a member of Other') }
    else if (op === 'recolour') { view.recolour(); show(`colour the eight largest${filtered ? ' (a filter in force)' : ''}`, { recoloured: true }) }
  }
}

// ---- the v6 review's sequences (B2), as the project lead decided them: what a person sees wins ----
test('B2, sequence D: a pod comes back while its slot is held only by a hidden series: it takes its slot back', () => {
  // eight services, all coloured: nothing is grey on screen, so the hidden newcomer keeps slot 1 until catalog comes back for it
  const { view, step } = stepper(), s8 = D.s8(), catalog = keyOf(s8.series[0].labels), extra = { labels: { namespace: 'prod', service: 'catalog-canary' }, values: s8.series[0].values.map((v) => v * 1.01) }
  step('eight services', (v) => v.show(s8)); assert.equal(view.slot(catalog), 1)
  step('catalog missing from one result, catalog-canary arrives', (v) => v.show({ ...s8, series: [...s8.series.slice(1), extra] }))
  const canary = keyOf(extra.labels); assert.equal(view.slot(canary), 1, 'the newcomer takes the reserved slot of the series that left')
  step('catalog-canary filtered out', (v) => { v.clientFilter = new Set([canary]); v.show({ ...s8, series: [...s8.series.slice(1), extra] }) })
  step('catalog comes back', (v) => v.show({ ...s8, series: [...s8.series, extra] }))
  assert.equal(view.slot(catalog), 1, `catalog came back ${view.slot(catalog) ? 'in slot ' + view.slot(catalog) : 'grey'}: slot 1 was held only by the hidden catalog-canary`)
  step('clear the filter', (v) => { v.clientFilter = null; v.show({ ...s8, series: [...s8.series, extra] }) })
  assert.equal(view.slot(catalog), 1, 'catalog kept slot 1: it stayed on screen'); assert.equal(view.slot(canary), 0, 'catalog-canary comes back in Other: a series on screen holds its slot')
  assert.equal(view.facts.note.kind, 'larger')
})
test('B2, sequence D as the reviewer ran it (36 pods): hiding the newcomer gives its slot to the largest grey pod at once; the returning pod finds it held on screen', () => {
  const { view, step } = stepper(), s36 = D.s36(), all = ranked(s36), big = all[0].key, pod = newPod()
  step('36 pods', (v) => v.show(s36)); assert.equal(view.slot(big), 1)
  const without = { ...s36, series: [...s36.series.filter((s) => keyOf(s.labels) !== big), pod] }, newcomer = keyOf(pod.labels)
  step('the largest pod missing from one result while new01 arrives', (v) => v.show(without)); assert.equal(view.slot(newcomer), 1)
  step('new01 filtered out', (v) => { v.clientFilter = new Set([newcomer]); v.show(without) })
  assert.equal(view.slot(all[8].key), 1, 'the largest pod on screen in Other (the ninth largest) took slot 1, held only by the hidden new01')
  step('the largest pod comes back', (v) => v.show({ ...s36, series: [...s36.series, pod] }))
  assert.equal(view.slot(big), 0, 'slot 1 is held by a pod on screen, which keeps it'); assert.equal(view.facts.note.text, '1 in Other is now larger than a coloured series')
})
test('B2, sequence E: "Without the three largest", a larger pod arrives, "Colour the eight largest", clear: each step follows what is on screen', () => {
  const { view, step } = stepper(), s36 = D.s36(), all = ranked(s36), top3 = new Set(all.slice(0, 3).map((s) => s.key)), pod = newPod()
  step('36 pods', (v) => v.show(s36))
  step('without the three largest', (v) => { v.clientFilter = top3; v.show(s36) })
  for (let i = 0; i < 3; i++) assert.equal(view.slot(all[8 + i].key), i + 1, `the ${9 + i}th largest pod takes slot ${i + 1}, held only by a hidden pod`)
  for (let i = 3; i < 8; i++) assert.equal(view.slot(all[i].key), i + 1, 'the coloured pods on screen keep their colours')
  const next = { ...s36, series: [...s36.series, pod] }
  step('a pod larger than all arrives', (v) => v.show(next)); assert.equal(view.slot(keyOf(pod.labels)), 0); assert.equal(view.facts.note.text, '1 in Other is now larger than a coloured series')
  step('colour the eight largest', (v) => { v.recolour(); v.show(next) }, { recoloured: true })
  assert.equal(view.slot(keyOf(pod.labels)), 1, 'the largest on screen, the new pod, is slot 1')
  step('clear the filter', (v) => { v.clientFilter = null; v.show(next) })
  for (const k of top3) assert.equal(view.slot(k), 0, `${podOf(k)} comes back in Other: every slot is held on screen`)
  assert.equal(view.facts.note.text, '3 in Other are now larger than a coloured series'); assert.ok(view.m.larger.length && view.m.coloured.length === 8, 'and "Colour the eight largest" is offered')
})

// ---- the review rubric's Many series row: each blocker example ----
test('Rubric blocker: a readout naming a smaller series as highest', () => {
  const view = new View(), next = D.s36(); next.series.push(newPod('checkout-api-7d9f8c6b5-new02', 3.6)); view.show(D.s36()); view.show(next)
  const top = view.m.byKey.get(keyOf(next.series.at(-1).labels)); assert.equal(top.slot, 0, 'the new pod is in Other')
  for (const i of [0, 30, 60]) assert.equal(view.facts.highestAt(i).key, top.key, `at ${i} the readout names ${podOf(view.facts.highestAt(i).key)}, not the highest`)
})
test('Rubric blocker: a series on screen changing colour while it stays on screen (deploy churn, a filter, a query edit)', () => {
  const { view, step } = stepper(), s36 = D.s36(), all = ranked(s36)
  step('36 pods', (v) => v.show(s36)); const kept = new Map(all.slice(3, 8).map((s) => [s.key, view.slot(s.key)]))
  const churn = { ...s36, series: [...s36.series.filter((s) => !all.slice(0, 3).some((a) => a.key === keyOf(s.labels))), newPod('a-1', 3.3), newPod('a-2', 3.2), newPod('a-3', 3.1)] }
  step('a deploy replaces the three largest', (v) => v.show(churn)); step('a filter hides a new pod', (v) => { v.clientFilter = new Set([keyOf(churn.series.at(-1).labels)]); v.show(churn) }); step('clear', (v) => { v.clientFilter = null; v.show(churn) })
  for (const [k, s] of kept) assert.equal(view.slot(k), s, `${podOf(k)} stayed on screen and is in slot ${view.slot(k)}, had ${s}`)
})
test('Rubric blocker: the largest series on screen grey while a slot is open (here held only by a hidden series)', () => {
  const { view, step } = stepper(), s36 = D.s36(), all = ranked(s36)
  step('36 pods', (v) => v.show(s36)); step('filter out slot 2', (v) => { v.clientFilter = new Set([all[1].key]); v.show(s36) })
  assert.equal(view.slot(all[8].key), 2, 'the largest pod in Other takes slot 2 at once')
})
test('Rubric blocker: a series coming back grey or in another colour while no series on screen holds its slot', () => {
  const { view, step } = stepper(), s8 = D.s8(), gone = keyOf(s8.series[2].labels)
  step('eight services', (v) => v.show(s8)); step('one misses a result', (v) => v.show({ ...s8, series: s8.series.filter((s) => keyOf(s.labels) !== gone) }))
  step('it is back', (v) => v.show(s8)); assert.equal(view.slot(gone), 3, 'back in its own slot: nothing on screen held it')
})
test('v8: a pod that misses one result while pods are grey: its slot goes to the largest grey pod; it comes back in Other, offered the recolour', () => {
  const { view, step } = stepper(), s36 = D.s36(), all = ranked(s36), gone = all[2].key
  step('36 pods', (v) => v.show(s36)); step('a pod restarts: missing from one result', (v) => v.show({ ...s36, series: s36.series.filter((s) => keyOf(s.labels) !== gone) }))
  assert.equal(view.slot(all[8].key), 3, 'the largest pod in Other takes the open slot')
  step('it is back', (v) => v.show(s36)); assert.equal(view.slot(gone), 0, 'slot 3 is held on screen'); assert.ok(actions(view.m).includes('recolour'))
})
test('Rubric blocker: a query edited to series it does not share and edited back not returning every colour (v5 review, image 02)', () => {
  const { view, step } = stepper(), spec = D.s36()
  step('36 pods', (v) => v.show(spec)); const before = new Map(spec.series.map((s) => [keyOf(s.labels), view.slot(keyOf(s.labels))]))
  const other = D.many(36, 37); for (const s of other.series) s.labels.service = 'search'
  step('the query edited to another service', (v) => v.show(other)); step('and back', (v) => v.show(D.s36()))
  for (const [k, s] of before) assert.equal(view.slot(k), s, `${podOf(k)}: slot ${view.slot(k)}, had ${s}`)
  assert.equal(view.m.coloured.length, 8); assert.equal(view.facts.note.text, '8 coloured by size; 28 in Other')
})

// ---- earlier reviews' sequences under the v7 rule ----
test('v5 image 01 under v7: filter out the three largest, a larger pod arrives, clear: the three take colours back only where nothing on screen holds them', () => {
  const { view, step } = stepper(), spec = D.s36(), all = ranked(spec), top3 = new Set(all.slice(0, 3).map((s) => s.key)), next = { ...D.s36(), series: [...D.s36().series, newPod()] }
  step('36 pods', (v) => v.show(spec)); step('without the three largest', (v) => { v.clientFilter = top3; v.show(spec) })
  step('a larger pod arrives', (v) => v.show(next)); step('clear the filter', (v) => { v.clientFilter = null; v.show(next) })
  for (const k of top3) assert.equal(view.slot(k), 0)
  assert.equal(view.facts.note.text, '4 in Other are now larger than a coloured series', 'the note says the four largest are in Other, beside "Colour the eight largest"')
})
test('A filter round trip with nothing grey on screen returns every colour (eight services, filter in the query)', () => {
  const { view, step } = stepper(), s8 = D.s8(), keys = s8.series.map((s) => keyOf(s.labels)), out = new Set(keys.slice(0, 3))
  step('eight services', (v) => v.show(s8)); const before = new Map(keys.map((k) => [k, view.slot(k)]))
  step('a dashboard filter drops three', (v) => { v.serverOut = out; v.show({ ...s8, series: s8.series.filter((s) => !out.has(keyOf(s.labels))) }) })
  step('cleared', (v) => { v.serverOut = null; v.show(s8) })
  for (const [k, s] of before) assert.equal(view.slot(k), s)
})
test('Flow screen 5: one series, a query that returns 36 pods, and back: the one series returns in slot 1', () => {
  const view = new View(), cart = { unit: 'cores', agg: 'max', t0: T0, step: STEP, series: [{ labels: { service: 'cart' }, values: Array(12).fill(0.4) }] }
  view.show(cart); assert.equal(view.slot(keyOf({ service: 'cart' })), 1)
  view.show(D.many(36, 36)); view.show(cart)
  assert.equal(view.slot(keyOf({ service: 'cart' })), 1, 'cart came back grey or in another colour')
})
// ---- the v7 review's M1: a query narrowed in Explore, and the same narrowing as a dashboard filter ----
const onNode = (spec, node) => ({ ...spec, series: spec.series.filter((s) => s.labels.node === node) })
test('M1 (v7 review), image 03: a query narrowed to node-b colours the eight largest on screen, as the same dashboard filter does', () => {
  const s36 = D.s36(), narrow = onNode(s36, 'node-b'), kept = new Set(narrow.series.map((s) => keyOf(s.labels)))
  const a = stepper(), b = stepper()
  a.step('36 pods', (v) => v.show(s36)); b.step('36 pods', (v) => v.show(s36))
  a.step('the query narrowed to node="node-b"', (v) => v.show(narrow))
  b.step('a dashboard filter node="node-b"', (v) => { v.serverOut = new Set(s36.series.map((s) => keyOf(s.labels)).filter((k) => !kept.has(k))); v.show(narrow) })
  const top = ranked(narrow).slice(0, 8).map((s) => s.key)
  for (const k of top) assert.ok(a.view.slot(k) > 0, `${podOf(k)}, among the eight largest on screen, is grey after the query was narrowed`)
  assert.equal(a.view.m.coloured.length, 8)
  for (const s of narrow.series) { const k = keyOf(s.labels); assert.equal(a.view.slot(k), b.view.slot(k), `${podOf(k)}: slot ${a.view.slot(k)} narrowed by the query, ${b.view.slot(k)} by a filter`) }
  assert.ok(!actions(a.view.m).includes('recolour'), 'the eight largest on node-b are coloured: "Colour the eight largest" would change nothing and is not offered (v9: the v8 review\'s m3)')
  a.step('the query edited back', (v) => v.show(D.s36())); b.step('the filter cleared', (v) => { v.serverOut = null; v.show(D.s36()) })
  for (const s of s36.series) { const k = keyOf(s.labels); assert.equal(a.view.slot(k), b.view.slot(k), `${podOf(k)} after the round trip: ${a.view.slot(k)} by the query, ${b.view.slot(k)} by the filter`) }
  assert.ok(actions(a.view.m).includes('recolour'), 'widened back, seven of the eight largest are in Other: "Colour the eight largest" is offered')
})
test('m3 (v8 review), image 02: "Colour the eight largest" is offered only when pressing it would change a colour', () => {
  const { view, step } = stepper(), s36 = D.s36(), top8 = ranked(s36).slice(0, 8).map((s) => s.key)
  step('36 pods, at load', (v) => v.show(s36)); for (const k of top8) assert.ok(view.slot(k) > 0)
  assert.deepEqual([...actions(view.m)], ['more'], 'at load the eight largest are coloured: only "Show 20 more of Other" is offered (v8 offered the recolour too, image 02 panel 1)')
  { const copy = JSON.parse(JSON.stringify(view.map)); R.recolour(copy, view.m); for (const s of view.m.listed) assert.equal(R.slotOf(copy, s.key), view.slot(s.key), `pressed at load it would change ${podOf(s.key)}: the test's premise is wrong`) }
  step('the query narrowed to node-b', (v) => v.show(onNode(s36, 'node-b'))); assert.deepEqual([...actions(view.m)], ['more'], 'narrowed: the eight largest on node-b took the colours; nothing to offer')
  step('and widened back', (v) => v.show(D.s36())); assert.deepEqual([...actions(view.m)], ['more', 'recolour'], 'widened back: seven of the eight largest are in Other (image 02, panel 3)')
  step('colour the eight largest', (v) => { v.recolour(); v.show(D.s36()) }, { recoloured: true })
  for (const k of top8) assert.ok(view.slot(k) > 0, `${podOf(k)} coloured after the recolour`)
  assert.deepEqual([...actions(view.m)], ['more'], 'once pressed, the recolour is no longer offered: pressing it again would change nothing (image 02, panel 4)')
  step('a pod larger than all arrives', (v) => v.show({ ...D.s36(), series: [...D.s36().series, newPod()] })); assert.deepEqual([...actions(view.m)], ['more', 'recolour'], 'a larger pod in Other: offered again')
})
// Twin views: one narrows and widens by editing its query, the other by a dashboard filter; the colours must agree after every step, and
// each must hold the properties. Legend rows toggled at random change what is drawn and never a colour.
function runTwins(seed, steps) {
  const r = rng(seed), u = universe(r, 40), keys = [...u.keys()], A = new View(), B = new View(), ca = { lastOn: new Map(), seen: new Set() }, cb = { lastOn: new Map(), seen: new Set() }
  let all = new Set(keys.slice(0, 14 + Math.floor(r() * 20))), narrowTo = null, pa = null, pb = null; const log = []
  const show = (what, ctx = {}) => { log.push(what); const vis = narrowTo ? [...all].filter((k) => narrowTo.has(k)) : [...all]
    A.show(specOf(u, vis)); B.serverOut = narrowTo ? new Set([...all].filter((k) => !narrowTo.has(k))) : null; B.show(specOf(u, vis))
    pa = checkStep(A, pa, { ...ca, what: 'query: ' + log.join(' > '), ...ctx }); pb = checkStep(B, pb, { ...cb, what: 'filter: ' + log.join(' > '), ...ctx })
    for (const k of vis) assert.equal(A.slot(k), B.slot(k), `twins ${log.join(' > ')}: ${podOf(k)} is in slot ${A.slot(k)} with the query narrowed, ${B.slot(k)} with the filter`) }
  show('first result')
  for (let i = 0; i < steps; i++) { const op = ['narrow', 'narrow', 'widen', 'arrive', 'leave', 'move', 'toggle', 'toggle', 'recolour'][Math.floor(r() * 9)]
    if (op === 'narrow') { const node = 'node-' + 'abcd'[Math.floor(r() * 4)], pick = r() < 0.5 ? (k) => u.get(k).labels.node === node : () => r() < 0.4; narrowTo = new Set([...all].filter(pick)); show(`narrow (${narrowTo.size} of ${all.size})`) }
    else if (op === 'widen' && narrowTo) { narrowTo = null; show('widen back') }
    else if (op === 'arrive') { const k = keys[Math.floor(r() * keys.length)]; if (all.has(k)) continue; all.add(k); if (narrowTo && r() < 0.5) narrowTo.add(k); show(`arrive ${podOf(k)}`) }
    else if (op === 'leave') { const pool = [...all]; if (pool.length < 3) continue; const k = pool[Math.floor(r() * pool.length)]; all.delete(k); narrowTo?.delete(k); show(`leave ${podOf(k)}`) }
    else if (op === 'move') { for (const k of all) if (r() < 0.3) u.get(k).values = wave(r, 3.5 * r() ** 2); show('values move') }
    else if (op === 'toggle') { const before = new Map([...A.known].map((k) => [k, A.slot(k)])), m = A.m, k = m.listed[Math.floor(r() * m.listed.length)]?.key ?? 'other'
      for (const v of [A, B]) { if (v.st.picked.has(k)) v.st.picked.delete(k); else v.st.picked.add(k) } show(`toggle a legend row`)
      for (const [q, s0] of before) assert.equal(A.slot(q), s0, `toggle ${log.join(' > ')}: ${podOf(q)} changed colour when a legend row was toggled`) }
    else if (op === 'recolour') { A.recolour(); B.recolour(); show('colour the eight largest', { recoloured: true }) }
  }
}
test('v8 twins: 300 random sequences of 30 steps narrowing and widening by query edit and by dashboard filter, with legend toggles: the same colours, every property held', () => {
  for (let seed = 1; seed <= 300; seed++) runTwins(seed, 30)
})
test('Random sequences of arrivals, departures, filters, query edits, Other opened and picked, recolouring (400 of 30 steps)', () => {
  for (let seed = 1; seed <= 400; seed++) runSequence(seed, 30)
})

// ---- v5's M2: axes and numbers ----
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
test('M1 (v5), image 06: a member of Other above the threshold is in the text form', () => {
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
