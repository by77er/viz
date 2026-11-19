import { describe, expect, it } from 'vitest'
import { alignWindow, autoStep, bucketWidth, MAX_POINTS, NICE_STEPS } from './step'
import { assignStyles, hashString, preferredSlot, SLOT_COUNT, slotToken } from './color'
import {
  DEFAULT_SEARCH,
  exploreSearchFromParams,
  exploreSearchToParams,
  parseExploreSearch,
  parseSearchString,
  stringifySearch,
  withoutDefaults,
  type ExploreSearch,
} from './urlState'
import { absoluteSpec, describeRange, formatDuration, isValidTimeSpec, parseDuration, resolveTimeSpec } from './time'
import { formatValue, inferUnit } from './units'
import { alignMatrix, distinguishingNames, seriesKey, seriesName, seriesStats } from './series'
import fc from 'fast-check'

describe('step selection', () => {
  it('never goes below the scrape interval', () => {
    expect(autoStep(300, 1200)).toBe(15)
    expect(autoStep(3600, 1200)).toBe(15)
  })
  it('picks the smallest nice step with at most one point per pixel column', () => {
    expect(autoStep(6 * 3600, 1200)).toBe(30) // 21600/1200 = 18 -> 30
    expect(autoStep(24 * 3600, 1200)).toBe(120) // 72 -> 120
    expect(autoStep(7 * 86400, 1200)).toBe(600) // 504 -> 600
    expect(autoStep(7 * 86400, 400)).toBe(1800) // 1512 -> 1800
    expect(autoStep(30 * 86400, 1000)).toBe(3600) // 2592 -> 3600
  })
  it('buckets the width so nearby widths share a step', () => {
    expect(bucketWidth(1) /* tiny */).toBe(100)
    expect(bucketWidth(1101)).toBe(1200)
    expect(bucketWidth(1200)).toBe(1200)
    expect(autoStep(86400, 1101)).toBe(autoStep(86400, 1199))
  })
  it('property: result is a nice step, <= columns points, and minimal', () => {
    fc.assert(
      fc.property(fc.integer({ min: 60, max: 400 * 86400 }), fc.integer({ min: 50, max: 4000 }), (range, width) => {
        const step = autoStep(range, width)
        const cols = bucketWidth(width)
        expect(step).toBeGreaterThanOrEqual(15)
        expect(range / step).toBeLessThanOrEqual(cols)
        expect(range / step).toBeLessThanOrEqual(MAX_POINTS)
        const i = NICE_STEPS.indexOf(step as (typeof NICE_STEPS)[number])
        if (i > 0 && NICE_STEPS[i - 1]! >= 15) expect(range / NICE_STEPS[i - 1]!).toBeGreaterThan(cols)
      }),
    )
  })
  it('aligns the window to the step', () => {
    expect(alignWindow(1007, 4612, 15)).toEqual({ start: 1005, end: 4605, step: 15 })
    expect(alignWindow(100, 100, 60)).toEqual({ start: 60, end: 120, step: 60 })
  })
})

describe('series colours', () => {
  const keys = ['service="auth"', 'service="catalog"', 'service="checkout"', 'service="orders"']
  it('hash is a fixed function (same series, same colour across reloads)', () => {
    expect(hashString('')).toBe(0x811c9dc5)
    expect(hashString('a')).toBe(0xe40c292c)
    expect(preferredSlot('service="checkout"')).toBe(hashString('service="checkout"') % 8)
  })
  it('is independent of input order', () => {
    const a = assignStyles(keys)
    const b = assignStyles([...keys].reverse())
    for (const k of keys) expect(b.get(k)).toEqual(a.get(k))
  })
  it('gives distinct slots to up to eight series', () => {
    const many = Array.from({ length: 8 }, (_, i) => `pod="p${i}"`)
    const styles = assignStyles(many)
    expect(new Set([...styles.values()].map((s) => s.slot)).size).toBe(8)
    expect([...styles.values()].every((s) => s.slot !== null)).toBe(true)
  })
  it('a series alone on its preferred slot keeps it regardless of the others', () => {
    const k = 'service="auth"'
    const alone = assignStyles([k]).get(k)!
    expect(alone.slot).toBe(preferredSlot(k))
    const others = ['x="1"', 'x="2"', 'x="3"'].filter((o) => preferredSlot(o) !== preferredSlot(k) && o > k)
    expect(assignStyles([k, ...others]).get(k)).toEqual(alone)
  })
  it('beyond eight series, eight keep distinct slots and the rest fold into Other', () => {
    const many = Array.from({ length: 32 }, (_, i) => `le="${i}"`)
    const styles = assignStyles(many)
    const slots = [...styles.values()].map((s) => s.slot)
    expect(slots.filter((s) => s !== null).length).toBe(SLOT_COUNT)
    expect(new Set(slots.filter((s) => s !== null)).size).toBe(SLOT_COUNT)
    expect(slots.filter((s) => s === null).length).toBe(32 - SLOT_COUNT)
    // The coloured ones are the first eight in sorted key order, whatever the input order.
    const firstEight = [...many].sort().slice(0, SLOT_COUNT)
    expect(firstEight.every((k) => styles.get(k)!.slot !== null)).toBe(true)
    expect(assignStyles([...many].reverse())).toEqual(styles)
  })
  it('names only the eight series tokens, in order, and a neutral ink for Other', () => {
    expect(Array.from({ length: SLOT_COUNT }, (_, i) => slotToken(i))).toEqual(
      ['--series-1', '--series-2', '--series-3', '--series-4', '--series-5', '--series-6', '--series-7', '--series-8'],
    )
    expect(slotToken(null)).toBe('--ink-muted')
  })
})

describe('URL state', () => {
  const full: ExploreSearch = {
    q: 'sum by (service) (rate(http_requests_total{status=~"5..", route!="/a b"}[5m])) / 2 + 1',
    from: '1795000000000',
    to: '1795003600000',
    step: '30s',
    unit: 'rps',
    view: 'text',
  }
  it('round-trips through URLSearchParams', () => {
    expect(exploreSearchFromParams(new URLSearchParams(exploreSearchToParams(full).toString()))).toEqual(full)
    expect(exploreSearchFromParams(exploreSearchToParams(DEFAULT_SEARCH))).toEqual(DEFAULT_SEARCH)
    expect(exploreSearchToParams(DEFAULT_SEARCH).toString()).toBe('')
  })
  it('round-trips through the router adapters', () => {
    const s = stringifySearch(withoutDefaults(full))
    expect(s.startsWith('?')).toBe(true)
    expect(s).not.toContain('%22sum') // no JSON quoting of strings
    expect(parseExploreSearch(parseSearchString(s))).toEqual(full)
    expect(stringifySearch(withoutDefaults(DEFAULT_SEARCH))).toBe('')
  })
  it('property: any query string survives', () => {
    fc.assert(
      fc.property(fc.string(), fc.constantFrom('now-5m', 'now-7d', '1795000000000'), (q, from) => {
        const s: ExploreSearch = { ...DEFAULT_SEARCH, q, from }
        expect(parseExploreSearch(parseSearchString(stringifySearch(withoutDefaults(s))))).toEqual(s)
      }),
    )
  })
  it('replaces invalid values with defaults', () => {
    expect(parseExploreSearch({ from: 'yesterday', to: 'now-', step: 'fast', view: 'pie', unit: '<x>' })).toEqual(DEFAULT_SEARCH)
    expect(parseExploreSearch({ from: 1795000000000 }).from).toBe('1795000000000')
  })
  it('accepts each result form, and reads the old tab=json links as the JSON form', () => {
    for (const view of ['chart', 'table', 'text', 'json'] as const) expect(parseExploreSearch({ view }).view).toBe(view)
    expect(parseExploreSearch({ tab: 'json' }).view).toBe('json')
    expect(parseExploreSearch({ view: 'text', tab: 'json' }).view).toBe('text')
  })
  it('has no field that could carry a credential', () => {
    expect(Object.keys(DEFAULT_SEARCH).sort()).toEqual(['from', 'q', 'step', 'to', 'unit', 'view'])
  })
})

describe('time', () => {
  it('parses and formats durations', () => {
    expect(parseDuration('5m')).toBe(300)
    expect(parseDuration('1h30m')).toBe(5400)
    expect(parseDuration('500ms')).toBe(0.5)
    expect(parseDuration('5')).toBeNull()
    expect(parseDuration('m5')).toBeNull()
    expect(formatDuration(90)).toBe('1m30s')
    expect(formatDuration(86400)).toBe('1d')
    expect(formatDuration(15)).toBe('15s')
  })
  it('resolves time specs', () => {
    expect(resolveTimeSpec('now', 1000)).toBe(1000)
    expect(resolveTimeSpec('now-1h', 10000)).toBe(6400)
    expect(resolveTimeSpec(absoluteSpec(1795000000.4), 0)).toBe(1795000000.4)
    expect(isValidTimeSpec('now-15m')).toBe(true)
    expect(isValidTimeSpec('now-x')).toBe(false)
    expect(isValidTimeSpec('12')).toBe(false)
    expect(describeRange('now-6h', 'now', 0)).toBe('Last 6h')
  })
})

describe('units', () => {
  it('formats values', () => {
    expect(formatValue(0)).toBe('0')
    expect(formatValue(1234)).toBe('1.23k')
    expect(formatValue(1_500_000)).toBe('1.5M')
    expect(formatValue(0.00042)).toBe('420µ')
    expect(formatValue(0.0425, 'seconds')).toBe('42.5 ms')
    expect(formatValue(90, 'seconds')).toBe('90 s')
    expect(formatValue(600, 'seconds')).toBe('10 min')
    expect(formatValue(1536, 'bytes')).toBe('1.5 KiB')
    expect(formatValue(3 * 1024 ** 3, 'bytes')).toBe('3 GiB')
    expect(formatValue(0.0421, 'percentunit')).toBe('4.21%')
    expect(formatValue(453.2, 'rps')).toBe('453/s')
    // Was '250m' and '1.5': a number with a unit must show it (design review M7).
    expect(formatValue(0.25, 'cores')).toBe('250 millicores')
    expect(formatValue(1.5, 'cores')).toBe('1.5 cores')
    expect(formatValue(null)).toBe('–')
    expect(formatValue(NaN)).toBe('NaN')
    expect(formatValue(Infinity)).toBe('+Inf')
    expect(formatValue(-12.5)).toBe('-12.5')
  })
  it('infers units from naming conventions', () => {
    expect(inferUnit('sum by (service) (rate(http_requests_total[5m]))')).toBe('rps')
    expect(inferUnit('histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket[5m])))')).toBe('seconds')
    expect(inferUnit('pod_memory_working_set_bytes')).toBe('bytes')
    expect(inferUnit('pod_cpu_usage_cores{service="x"}')).toBe('cores')
    expect(inferUnit('sum(rate(a_total{x="_bytes"}[5m])) / sum(rate(a_total[5m]))')).toBe('none')
    expect(inferUnit('up')).toBe('none')
  })
})

describe('series', () => {
  it('has a canonical key and name', () => {
    expect(seriesKey({ b: '2', a: '1' })).toBe(seriesKey({ a: '1', b: '2' }))
    expect(seriesName({ __name__: 'up', job: 'api' })).toBe('up{job="api"}')
    expect(seriesName({ job: 'api', a: 'x"y' })).toBe('{a="x\\"y", job="api"}')
    expect(seriesName({})).toBe('{}')
  })
  it('aligns a matrix on the step grid and leaves missing steps as gaps', () => {
    const a = alignMatrix(
      {
        resultType: 'matrix',
        result: [
          { metric: { s: 'b' }, values: [[100, '1'], [115, '2'], [160, '5']] },
          { metric: { s: 'a' }, values: [[130, 'NaN'], [145, '+Inf'], [160, '7']] },
        ],
      },
      100,
      160,
      15,
    )
    expect(a.xs).toEqual([100, 115, 130, 145, 160])
    expect(a.series.map((s) => s.name)).toEqual(['{s="a"}', '{s="b"}'])
    // Gaps are NaN in the views' Float64Arrays (they were null).
    expect([...a.series[1]!.values]).toEqual([1, 2, NaN, NaN, 5])
    expect([...a.series[0]!.values]).toEqual([NaN, NaN, NaN, NaN, 7])
    expect(seriesStats(a.xs, a.series[1]!.values)).toEqual({ last: 5, lastAt: 160, min: 1, max: 5, mean: 8 / 3, count: 3 })
    // NaN gaps in a Float64Array count as gaps, as null did.
    expect(seriesStats([0, 1, 2, 3], Float64Array.from([NaN, 2, NaN, 4]))).toEqual({ last: 4, lastAt: 3, min: 2, max: 4, mean: 3, count: 2 })
  })
  it('shortens names to the labels that differ', () => {
    expect(
      distinguishingNames([
        { __name__: 'm', job: 'k', pod: 'a', node: 'n1' },
        { __name__: 'm', job: 'k', pod: 'b', node: 'n1' },
      ]),
    ).toEqual(['{pod="a"}', '{pod="b"}'])
    expect(distinguishingNames([{ __name__: 'm', job: 'k' }])).toEqual(['m{job="k"}'])
    expect(distinguishingNames([{ __name__: 'a' }, { __name__: 'b' }])).toEqual(['a', 'b'])
    expect(distinguishingNames([{ a: '1' }, { a: '1', b: '2' }])).toEqual(['{a="1"}', '{b="2"}'])
  })
  it('falls back to observed timestamps when samples are off the grid', () => {
    const a = alignMatrix({ resultType: 'matrix', result: [{ metric: {}, values: [[101, '1'], [117, '2']] }] }, 100, 160, 15)
    expect(a.xs).toEqual([101, 117])
  })
})
