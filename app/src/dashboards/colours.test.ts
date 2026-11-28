import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { AlignedData } from '../lib/series'
import { chartKey, DashboardColours, identityOf } from './colours'

// The chart's own rules (design-system/dist/viz-chart.js registers them on `window`), so the map the
// dashboard hands over is checked against the algorithm that will read it, not against a copy of it.
interface Rules {
  newMap(): unknown
  assignSeries(map: unknown, series: { key: string; rank: number }[]): unknown
  slotOf(map: unknown, key: string): number
}
let rules: Rules
const store = new Map<string, string>()
beforeAll(async () => {
  const g = globalThis as unknown as Record<string, unknown>
  g.window = globalThis
  // The script draws nothing here: it only registers its rules (its page set-up waits for a document that never loads).
  g.document = { readyState: 'loading', addEventListener: () => {} }
  g.sessionStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) }
  const chart: string = new URL('../../../design-system/dist/viz-chart.js', import.meta.url).href
  await import(/* @vite-ignore */ chart)
  rules = (globalThis as unknown as { vzChartRules: Rules }).vzChartRules
})
beforeEach(() => store.clear())

const series = (labels: Record<string, string>[], peaks: number[]): AlignedData => ({ xs: [0, 1], series: labels.map((l, i) => ({ labels: l, values: new Float64Array([0, peaks[i]!]) })) }) as unknown as AlignedData
/** The slots the chart gives a panel's series on its first draw, from the map the dashboard handed over for `view`. */
function drawn(view: string, data: AlignedData): Record<string, number> {
  const map = JSON.parse(store.get(`vz-series8:${view}`) ?? 'null') ?? rules.newMap()
  const s = data.series.map((x) => ({ key: chartKey(x.labels), rank: Math.max(...Array.from(x.values as Float64Array)) }))
  rules.assignSeries(map, s)
  return Object.fromEntries(data.series.map((x) => [Object.entries(x.labels).filter(([k]) => k !== '__name__').map(([, v]) => v).join('/'), rules.slotOf(map, chartKey(x.labels))]))
}

describe('one colour per series identity across a dashboard (D-M2)', () => {
  const svc = (s: string) => ({ service: s })
  it('a service keeps its slot in every panel, whichever panel is drawn first and however the panels rank it', () => {
    const c = new DashboardColours('d')
    const requests = series(['catalog', 'checkout', 'orders', 'search'].map(svc), [400, 300, 200, 100])
    const errors = series(['checkout', 'orders', 'catalog', 'search'].map(svc), [9, 5, 2, 1])
    c.seed('dashboard:d:errors', errors, 'q')
    c.seed('dashboard:d:requests', requests, 'q')
    const a = drawn('dashboard:d:errors', errors)
    const b = drawn('dashboard:d:requests', requests)
    expect(a).toEqual(b)
    expect(new Set(Object.values(a)).size).toBe(4)
    // Largest first in the panel that was drawn first.
    expect(a.checkout).toBe(1)
  })
  it('a pod is one identity in its CPU and its memory panel (the metric name is not part of it); a service and a pod do not compete for slots', () => {
    const c = new DashboardColours('d')
    const pods = (metric: string) => series(['a', 'b', 'c'].map((p) => ({ __name__: metric, pod: p })), [3, 2, 1])
    c.seed('v1', series(['catalog', 'checkout'].map(svc), [2, 1]), 'q')
    c.seed('v2', pods('cpu'), 'q')
    c.seed('v3', pods('memory'), 'q')
    expect(drawn('v2', pods('cpu'))).toEqual(drawn('v3', pods('memory')))
    expect(drawn('v2', pods('cpu')).a).toBe(1)
    expect(identityOf({ __name__: 'cpu', pod: 'a' })).toEqual(identityOf({ __name__: 'memory', pod: 'a' }))
  })
  it('past eight in a group: each panel colours its own eight largest; those the first panel coloured too keep their colour', () => {
    const c = new DashboardColours('d')
    const names = Array.from({ length: 12 }, (_, i) => ({ pod: `p${String(i).padStart(2, '0')}` }))
    const first = series(names, names.map((_, i) => 100 - i))
    c.seed('v1', first, 'q')
    const one = drawn('v1', first)
    expect(Object.values(one).filter((s) => s > 0)).toHaveLength(8)
    const second = series(names, names.map((_, i) => i))
    c.seed('v2', second, 'q')
    const two = drawn('v2', second)
    // The second panel's eight largest are p04 to p11; p04 to p07 were coloured in the first and keep their slots.
    const coloured = Object.keys(two).filter((k) => two[k]! > 0).sort()
    expect(coloured).toEqual(['p04', 'p05', 'p06', 'p07', 'p08', 'p09', 'p10', 'p11'])
    for (const k of ['p04', 'p05', 'p06', 'p07']) expect(two[k]).toBe(one[k])
    expect(new Set(coloured.map((k) => two[k])).size).toBe(8)
  })
  it('D-M3: nothing larger than a coloured series starts in Other, whatever the panel drawn before it coloured (Memory by pod after CPU by pod)', () => {
    const c = new DashboardColours('d')
    const names = Array.from({ length: 12 }, (_, i) => ({ __name__: 'm', pod: `p${String(i).padStart(2, '0')}` }))
    // CPU: p00 largest; memory: a different order, its four largest pods are CPU's four smallest.
    const cpu = series(names, names.map((_, i) => 100 - i))
    const memPeaks = [5, 6, 7, 8, 30, 31, 32, 33, 90, 80, 70, 60]
    const mem = series(names, memPeaks)
    c.seed('cpu', cpu, 'q')
    c.seed('mem', mem, 'q')
    const cpuSlots = drawn('cpu', cpu)
    const memSlots = drawn('mem', mem)
    const peak = Object.fromEntries(names.map((n, i) => [n.pod, memPeaks[i]!]))
    const smallestColoured = Math.min(...Object.keys(memSlots).filter((k) => memSlots[k]! > 0).map((k) => peak[k]!))
    const largestOther = Math.max(...Object.keys(memSlots).filter((k) => memSlots[k] === 0).map((k) => peak[k]!))
    expect(largestOther).toBeLessThan(smallestColoured)
    expect(Object.values(memSlots).filter((s) => s > 0)).toHaveLength(8)
    // A pod coloured in both keeps its CPU colour.
    for (const k of ['p04', 'p05', 'p06', 'p07']) expect(memSlots[k]).toBe(cpuSlots[k])
    // And the chart's own note has nothing to say: no series in Other is larger than a coloured one.
    const map = JSON.parse(store.get('vz-series8:mem')!)
    const ranked = mem.series.map((x) => ({ key: chartKey(x.labels), rank: Math.max(...Array.from(x.values as Float64Array)) }))
    rules.assignSeries(map, ranked)
    const other = ranked.filter((x) => rules.slotOf(map, x.key) === 0)
    const col = ranked.filter((x) => rules.slotOf(map, x.key) > 0)
    expect(Math.max(...other.map((x) => x.rank))).toBeLessThan(Math.min(...col.map((x) => x.rank)))
  })
  it('D-M3: a colour the dashboard gave an identity goes to the larger series when two of one panel want it (two groups, one panel)', () => {
    const c = new DashboardColours('d')
    c.seed('a', series([{ service: 'x' }], [1]), 'q') // service x: slot 1
    c.seed('b', series([{ pod: 'y' }], [1]), 'q') // pod y: slot 1 of its own group
    const both = series([{ service: 'x' }, { pod: 'y' }], [1, 2])
    c.seed('c', both, 'q')
    const s = drawn('c', both)
    expect(s.y).toBe(1)
    expect(s.x).toBeGreaterThan(1)
  })
  it('a view already handed over keeps the chart\'s own map (a viewer\'s recolour, a reload)', () => {
    const c = new DashboardColours('d')
    c.seed('v1', series([svc('a')], [1]), 'q')
    store.set('vz-series8:v1', 'kept')
    new DashboardColours('d').seed('v1', series([svc('b')], [1]), 'q')
    expect(store.get('vz-series8:v1')).toBe('kept')
  })
})
