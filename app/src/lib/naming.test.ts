import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { middleTruncate, nameSeries, NAME_LENGTH, withoutEmpty } from './naming'
import { seriesKey, type Labels } from './series'

describe('series names (M5)', () => {
  it('drops labels that are the same on every series, and reports them once', () => {
    const n = nameSeries([
      { __name__: 'm', job: 'k', pod: 'a', node: 'n1' },
      { __name__: 'm', job: 'k', pod: 'b', node: 'n1' },
    ])
    expect(n.common).toEqual({ __name__: 'm', job: 'k', node: 'n1' })
    expect(n.distinguishing).toEqual(['pod'])
    expect(n.names.map((x) => x.name)).toEqual(['a', 'b'])
    expect(n.names[0]!.full).toBe('m{job="k", node="n1", pod="a"}')
  })
  it('orders the remaining labels by the number of distinct values, most first', () => {
    const all: Labels[] = []
    for (const service of ['a', 'b']) for (const route of ['/x', '/y', '/z']) for (const status of ['200']) all.push({ service, route, status })
    const n = nameSeries(all)
    expect(n.distinguishing).toEqual(['route', 'service'])
    expect(n.common).toEqual({ status: '200' })
    expect(n.names[0]!.name).toBe('{route="/x", service="a"}')
  })
  it('ties in distinct count are broken by label name, whatever the input order', () => {
    const a = nameSeries([{ b: '1', a: '1' }, { b: '2', a: '2' }])
    expect(a.distinguishing).toEqual(['a', 'b'])
  })
  it('a single series keeps its full name', () => {
    const n = nameSeries([{ __name__: 'up', job: 'api' }])
    expect(n.names).toEqual([{ full: 'up{job="api"}', name: 'up{job="api"}', short: 'up{job="api"}' }])
    expect(n.distinguishing).toEqual([])
  })
  it('series that differ only in __name__ are named by the metric', () => {
    const n = nameSeries([{ __name__: 'requests_total', job: 'a' }, { __name__: 'errors_total', job: 'a' }])
    expect(n.valueOnly).toBe('__name__')
    expect(n.names.map((x) => x.name)).toEqual(['requests_total', 'errors_total'])
  })
  it('a label missing on some series is written as a pair, never as a bare value', () => {
    const n = nameSeries([{ a: '1' }, { a: '1', b: '2' }])
    expect(n.valueOnly).toBeNull()
    expect(n.names.map((x) => x.name)).toEqual(['{}', '{b="2"}'])
  })
  it('identical label sets keep the full name (nothing distinguishes them)', () => {
    const n = nameSeries([{ a: '1' }, { a: '1' }])
    expect(n.names.map((x) => x.name)).toEqual(['{a="1"}', '{a="1"}'])
  })
  it('truncates in the middle, keeping both ends', () => {
    expect(middleTruncate('checkout-6b7f9-x2k4p', 12)).toBe('checko…x2k4p')
    expect(middleTruncate('short', 12)).toBe('short')
  })
  it('shortens long names in the middle and keeps what tells them apart', () => {
    const pods = ['a', 'b', 'c'].map((s) => ({ pod: `checkout-deployment-production-eu-west-1-6b7f9c8d5f-x2k4${s}`, node: 'n' }))
    const n = nameSeries(pods)
    const short = n.names.map((x) => x.short)
    expect(new Set(short).size).toBe(3)
    for (const s of short) {
      expect(s.length).toBeLessThanOrEqual(NAME_LENGTH)
      expect(s).toContain('…')
    }
    expect(short[0]!.endsWith('x2k4a')).toBe(true) // the distinguishing end survives
  })
  it('does not shorten when shortening would make two series look the same', () => {
    // The names differ only in the middle, which is exactly what middle truncation removes.
    const base = 'x'.repeat(30)
    const n = nameSeries([{ id: `${base}A${base}` }, { id: `${base}B${base}` }])
    const short = n.names.map((x) => x.short)
    expect(short[0]).not.toBe(short[1])
    expect(short).toEqual(n.names.map((x) => x.name))
  })

  // ---- properties
  const key = fc.constantFrom('__name__', 'service', 'route', 'status', 'pod', 'le')
  const value = fc.oneof(
    fc.constantFrom('', 'a', 'b', 'auth', 'checkout', '200', '500'),
    fc.string({ maxLength: 6 }),
    // Long values that share a head and a tail, so that truncation is tempted to merge them.
    fc.tuple(fc.constantFrom('checkout-deployment-production-', 'http_request_duration_seconds_'), fc.string({ minLength: 0, maxLength: 4 }), fc.constantFrom('', '-eu-west-1-6b7f9c8d5f-x2k4p', '_bucket_total_per_second')).map(([h, m, t]) => h + m + t),
  )
  const labels = fc.dictionary(key, value, { maxKeys: 5 }) as fc.Arbitrary<Labels>
  const result = fc.array(labels, { minLength: 0, maxLength: 12 })

  it('property: two series get the same name only when their label sets are equal', () => {
    fc.assert(
      fc.property(result, fc.integer({ min: 8, max: 60 }), (all, max) => {
        const n = nameSeries(all, max).names
        for (let i = 0; i < all.length; i++) {
          for (let j = i + 1; j < all.length; j++) {
            const same = seriesKey(withoutEmpty(all[i]!)) === seriesKey(withoutEmpty(all[j]!)) // an empty value is no label
            for (const form of ['name', 'short', 'full'] as const) {
              if (same) expect(n[i]![form]).toBe(n[j]![form])
              else expect(n[i]![form]).not.toBe(n[j]![form])
            }
          }
        }
      }),
      { numRuns: 500 },
    )
  })
  it('property: long values that differ only in the middle still give distinct short names', () => {
    // The case middle truncation is built to break: one long label whose values share a head
    // and a tail, and differ only inside.
    const middles = fc.uniqueArray(fc.string({ minLength: 0, maxLength: 6 }), { minLength: 2, maxLength: 12 })
    fc.assert(
      fc.property(middles, fc.integer({ min: 8, max: 60 }), fc.boolean(), (ms, max, withJob) => {
        const all = ms.map((m) => ({ pod: `checkout-deployment-${m}-production-eu-west-1-x2k4p`, ...(withJob ? { job: 'kubelet' } : {}) }))
        const n = nameSeries(all, max).names
        for (const form of ['name', 'short', 'full'] as const) expect(new Set(n.map((x) => x[form])).size).toBe(all.length)
      }),
      { numRuns: 300 },
    )
  })
  it('property: the names do not depend on the order of the series', () => {
    fc.assert(
      fc.property(result, fc.integer({ min: 0, max: 1000 }), (all, seed) => {
        const order = all.map((_, i) => i).sort((a, b) => ((a * 7919 + seed) % 13) - ((b * 7919 + seed) % 13) || b - a)
        const shuffled = order.map((i) => all[i]!)
        const a = nameSeries(all)
        const b = nameSeries(shuffled)
        order.forEach((from, to) => expect(b.names[to]).toEqual(a.names[from]))
        expect(b.distinguishing).toEqual(a.distinguishing)
        expect(b.common).toEqual(a.common)
      }),
      { numRuns: 300 },
    )
  })
  it('property: a name never contains a label that is common to all series', () => {
    fc.assert(
      fc.property(result, (all) => {
        const n = nameSeries(all)
        if (n.distinguishing.length === 0) return
        for (const k of Object.keys(n.common)) for (const d of n.distinguishing) expect(d).not.toBe(k)
      }),
    )
  })
})
