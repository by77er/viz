import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { assignSeries, bySizeThenName, DEFAULT_POLICY, loadAssignment, meanOf, saveAssignment, SLOTS, type AssignInput, type Assignment } from './assign'

const series = (name: string, mean: number): AssignInput => ({ key: `k:${name}`, name, values: [mean - 1, mean, mean + 1] })
const four = [series('auth', 10), series('catalog', 20), series('checkout', 30), series('orders', 40)]
const many = Array.from({ length: 36 }, (_, i) => series(`s${String(i).padStart(2, '0')}`, (i * 37) % 101))

describe('series assignment (M2)', () => {
  it('gives free slots in palette order by first appearance', () => {
    const a = assignSeries(four, null)
    expect(a.assignment).toEqual({ 'k:auth': 0, 'k:catalog': 1, 'k:checkout': 2, 'k:orders': 3 })
    expect(a.coloured).toEqual(['k:auth', 'k:catalog', 'k:checkout', 'k:orders'])
    expect(a.other).toBeNull()
    // A single series is series-1, not a hashed slot.
    expect(assignSeries([series('only', 1)], null).assignment).toEqual({ 'k:only': 0 })
  })
  it('survivors keep their colour when a filter removes other series', () => {
    const before = assignSeries(four, null)
    const filtered = [four[1]!, four[3]!] // catalog and orders remain
    const after = assignSeries(filtered, before.assignment)
    expect(after.assignment['k:catalog']).toBe(before.assignment['k:catalog'])
    expect(after.assignment['k:orders']).toBe(before.assignment['k:orders'])
    expect(after.assignment).toEqual({ 'k:catalog': 1, 'k:orders': 3 })
    // Without the memory they would be repainted: this is what the test guards.
    expect(assignSeries(filtered, null).assignment).toEqual({ 'k:catalog': 0, 'k:orders': 1 })
  })
  it('a series that joins takes the lowest free slot and moves nobody', () => {
    const before = assignSeries([four[1]!, four[3]!], { 'k:catalog': 1, 'k:orders': 3 })
    const after = assignSeries(four, before.assignment)
    expect(after.assignment).toEqual({ 'k:auth': 0, 'k:catalog': 1, 'k:checkout': 2, 'k:orders': 3 })
  })
  it('a reload reproduces the assignment', () => {
    const first = assignSeries(many, null)
    expect(assignSeries(many, null)).toEqual(first) // a fresh tab on the same URL
    const stored = JSON.parse(JSON.stringify(first.assignment)) as Assignment // the same tab, through sessionStorage
    expect(assignSeries(many, stored)).toEqual(first)
    expect(assignSeries([...many].reverse(), stored).assignment).toEqual(first.assignment)
  })
  it('the remembered assignment survives storage, and bad storage is ignored', () => {
    const store = new Map<string, string>()
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) }
    expect(loadAssignment(storage)).toBeNull()
    saveAssignment({ a: 1, b: 7 }, storage)
    expect(loadAssignment(storage)).toEqual({ a: 1, b: 7 })
    store.set('viz.explore.assignment', '{"a":"x","b":-1,"c":2.5,"d":3}')
    expect(loadAssignment(storage)).toEqual({ d: 3 })
    store.set('viz.explore.assignment', 'not json')
    expect(loadAssignment(storage)).toBeNull()
  })
  it('never colours more than eight series; the rest are ONE Other group', () => {
    // Literal 8, not SLOTS: the design system has eight series tokens, and this guards the constant too.
    expect(SLOTS).toBe(8)
    expect(DEFAULT_POLICY.slots).toBe(8)
    const a = assignSeries(many, null)
    expect(a.coloured.length).toBe(8)
    expect(new Set(Object.values(a.assignment)).size).toBe(8)
    expect(Object.values(a.assignment).every((s) => s >= 0 && s < 8)).toBe(true)
    expect(a.other!.members.length).toBe(36 - 8)
    expect(a.other!.combined).toBeNull() // listed, not drawn, by default
  })
  it('with more series than slots the largest by mean are coloured, ties by name', () => {
    const a = assignSeries(many, null)
    const bySize = [...many].sort((x, y) => meanOf(y.values)! - meanOf(x.values)! || (x.name < y.name ? -1 : 1))
    expect(new Set(a.coloured)).toEqual(new Set(bySize.slice(0, SLOTS).map((s) => s.key)))
    expect(a.other!.members).toEqual(bySize.slice(SLOTS).map((s) => s.key)) // best ranked first
    // Slots still follow appearance, not size.
    expect(a.coloured.map((k) => a.assignment[k])).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    const tied = Array.from({ length: 10 }, (_, i) => series(`t${9 - i}`, 5))
    expect(new Set(assignSeries(tied, null).coloured)).toEqual(new Set(['k:t0', 'k:t1', 'k:t2', 'k:t3', 'k:t4', 'k:t5', 'k:t6', 'k:t7']))
  })
  it('a coloured survivor keeps its slot even when larger series arrive', () => {
    const small = Array.from({ length: 8 }, (_, i) => series(`small${i}`, 1))
    const first = assignSeries(small, null)
    const second = assignSeries([...small, series('huge', 1000)], first.assignment)
    expect(second.assignment).toEqual(first.assignment)
    expect(second.other!.members).toEqual(['k:huge'])
  })
  it('the ranking and the measure are parameters of the policy', () => {
    const byName = assignSeries(many, null, { ...DEFAULT_POLICY, compare: (a, b) => (a.name < b.name ? -1 : 1) })
    expect(byName.coloured).toEqual(many.slice(0, 8).map((s) => s.key))
    const byMax = assignSeries([series('flat', 5), { key: 'k:spiky', name: 'spiky', values: [0, 0, 100] }], null, {
      ...DEFAULT_POLICY,
      slots: 1,
      measure: (v) => Math.max(...v.map((x) => x ?? -Infinity)),
    })
    expect(byMax.coloured).toEqual(['k:spiky'])
    expect(assignSeries(four, null, { ...DEFAULT_POLICY, slots: 2 }).coloured).toEqual(['k:checkout', 'k:orders'])
  })
  it('the Other group can carry a sum for drawing when the policy asks for it', () => {
    const a = assignSeries(
      [series('a', 10), series('b', 20), { key: 'k:c', name: 'c', values: [1, null, 3] }, { key: 'k:d', name: 'd', values: [null, null, 2] }],
      null,
      { ...DEFAULT_POLICY, slots: 2, other: 'sum' },
    )
    expect(a.other).toEqual({ members: ['k:c', 'k:d'], combined: [1, null, 5] })
  })
  it('ranks series without values last', () => {
    expect(bySizeThenName({ key: 'a', name: 'a', size: null }, { key: 'b', name: 'b', size: -5 })).toBeGreaterThan(0)
    expect(meanOf([null, NaN as unknown as number])).toBeNull()
  })

  const input = fc.uniqueArray(
    fc.record({ name: fc.string({ minLength: 1, maxLength: 4 }), mean: fc.integer({ min: -50, max: 50 }) }),
    { selector: (s) => s.name, maxLength: 40 },
  ).map((xs) => xs.map((x) => series(x.name, x.mean)))
  const previous = fc.option(fc.dictionary(fc.string({ minLength: 1, maxLength: 4 }).map((n) => `k:${n}`), fc.integer({ min: -2, max: 12 })), { nil: null })

  it('property: at most eight coloured, distinct slots, every series coloured or in Other exactly once', () => {
    fc.assert(
      fc.property(input, previous, (xs, prev) => {
        const a = assignSeries(xs, prev)
        expect(a.coloured.length).toBeLessThanOrEqual(8)
        const slots = a.coloured.map((k) => a.assignment[k]!)
        expect(new Set(slots).size).toBe(slots.length)
        expect(slots.every((s) => Number.isInteger(s) && s >= 0 && s < 8)).toBe(true)
        const members = a.other?.members ?? []
        expect(a.coloured.length + members.length).toBe(xs.length)
        expect(new Set([...a.coloured, ...members]).size).toBe(xs.length)
        if (xs.length <= SLOTS) expect(a.other).toBeNull()
        else expect(a.coloured.length).toBe(SLOTS)
      }),
      { numRuns: 300 },
    )
  })
  it('property: applying the assignment again changes nothing, and survivors of any filter keep their slots', () => {
    fc.assert(
      fc.property(input, previous, fc.array(fc.boolean(), { minLength: 40, maxLength: 40 }), (xs, prev, keep) => {
        const a = assignSeries(xs, prev)
        expect(assignSeries(xs, a.assignment)).toEqual(a)
        const filtered = xs.filter((_, i) => keep[i])
        const b = assignSeries(filtered, a.assignment)
        for (const s of filtered) if (a.assignment[s.key] !== undefined) expect(b.assignment[s.key]).toBe(a.assignment[s.key])
      }),
      { numRuns: 300 },
    )
  })
})
