import { describe, expect, it } from 'vitest'
import {
  digestDashboard, digestPanel, formatNumber, panelOrder, renderDigest, resolve, robustZ, thresholdState,
  type DashboardDigest, type Panel, type PanelDigest, type PromMatrix, type PromVector,
} from '../src/index.ts'
import { red } from './helpers.ts'

const T0 = 1_700_000_000
const STEP = 60
const series = (metric: Record<string, string>, f: (i: number) => number | string | null, n = 11) => ({
  metric,
  values: Array.from({ length: n }, (_, i) => [T0 + i * STEP, f(i)] as const)
    .filter((p) => p[1] !== null)
    .map(([t, v]) => [t, String(v)] as [number, string]),
})
const matrix = (...result: PromMatrix['result']): PromMatrix => ({ resultType: 'matrix', result })

const ts: Panel = { kind: 'timeseries', title: 'Requests', description: 'Request rate per route, for the digest tests.', unit: 'req/s', queries: ['q'] }
const stat: Panel = {
  kind: 'stat', title: 'Error ratio', description: 'Share of failed requests, for the digest tests.', unit: 'ratio', queries: ['q'],
  thresholds: [{ above: 0.001, level: 'warn' }, { above: 0.01, level: 'crit' }],
}

describe('digestPanel: per-series statistics', () => {
  it('computes last, min, max, mean and a rising trend for a linear series', () => {
    const d = digestPanel(ts, matrix(series({ route: '/a' }, (i) => 10 + 2 * i)), { id: 'p' })
    expect(d).toMatchObject({ id: 'p', kind: 'timeseries', unit: 'req/s', seriesCount: 1, noData: false, state: null, outliers: 0 })
    const s = d.series[0]!
    expect(s).toMatchObject({ points: 11, first: 10, last: 30, min: 10, max: 30, mean: 20, value: 30, lastTs: T0 + 600, state: null, outlier: false, z: null })
    expect(s.trend!.direction).toBe('up')
    expect(s.trend!.slope).toBeCloseTo(2 / 60, 12)
    expect(s.trend!.relChange).toBeCloseTo(2, 12)
    expect(s.gaps).toEqual({ count: 0, missing: 0, longest: 0 })
    expect(d.range).toEqual({ start: T0, end: T0 + 600, step: 60 })
  })
  it('classifies falling and flat trends; noise within 5% is flat', () => {
    const d = digestPanel(ts, matrix(
      series({ s: 'down' }, (i) => 100 - 5 * i),
      series({ s: 'const' }, () => 7),
      series({ s: 'noise' }, (i) => 100 + (i % 2 ? 1 : -1)),
      series({ s: 'zero' }, () => 0),
    ), { topK: 10 })
    const by = Object.fromEntries(d.series.map((s) => [s.name, s]))
    expect(by['s=down']!.trend).toMatchObject({ direction: 'down', relChange: -0.5 })
    expect(by['s=down']!.trend!.slope).toBeCloseTo(-5 / 60, 12)
    expect(by['s=const']!.trend).toEqual({ direction: 'flat', slope: 0, relChange: 0 })
    expect(by['s=noise']!.trend!.direction).toBe('flat')
    expect(by['s=zero']!.trend).toEqual({ direction: 'flat', slope: 0, relChange: 0 })
  })
  it('least-squares slope is exact on a noisy line with known fit', () => {
    // v = 3 + 0.5*i with symmetric residuals (+1, -2, +1 repeating sums to zero and is orthogonal to i over 9 points)
    const resid = [1, -2, 1, 1, -2, 1, 1, -2, 1]
    const d = digestPanel(ts, matrix(series({ a: 'b' }, (i) => 3 + 0.5 * i + resid[i]!, 9)))
    const xs = Array.from({ length: 9 }, (_, i) => i)
    const ys = xs.map((i) => 3 + 0.5 * i + resid[i]!)
    const xm = 4
    const ym = ys.reduce((a, b) => a + b) / 9
    const expected = xs.reduce((a, x, i) => a + (x - xm) * (ys[i]! - ym), 0) / xs.reduce((a, x) => a + (x - xm) ** 2, 0) / STEP
    expect(d.series[0]!.trend!.slope).toBeCloseTo(expected, 12)
    expect(d.series[0]!.mean).toBeCloseTo(ym, 12)
  })
  it('skips NaN and Inf samples and counts them', () => {
    const d = digestPanel(ts, matrix(series({ a: 'b' }, (i) => (i === 3 ? 'NaN' : i === 4 ? '+Inf' : i))))
    expect(d.series[0]).toMatchObject({ points: 9, nonFinite: 2, min: 0, max: 10, last: 10 })
    expect(d.series[0]!.mean).toBeCloseTo((55 - 7) / 9, 12)
  })
  it('accepts an instant vector', () => {
    const v: PromVector = { resultType: 'vector', result: [{ metric: { node: 'a' }, value: [T0, '0.42'] }, { metric: { node: 'b' }, value: [T0, '0.9'] }] }
    const d = digestPanel(ts, v)
    expect(d.series.map((s) => [s.name, s.last, s.min, s.max, s.mean, s.trend])).toEqual([['node=b', 0.9, 0.9, 0.9, 0.9, null], ['node=a', 0.42, 0.42, 0.42, 0.42, null]])
  })
  it('names series by legend, else by the labels that differ', () => {
    const data = matrix(series({ __name__: 'up', job: 'api', instance: 'a:1' }, () => 1), series({ __name__: 'up', job: 'api', instance: 'b:1' }, () => 1))
    expect(digestPanel(ts, data).series.map((s) => s.name)).toEqual(['instance=a:1', 'instance=b:1'])
    expect(digestPanel(ts, data, { legends: '{{job}} on {{ instance }}' }).series.map((s) => s.name)).toEqual(['api on a:1', 'api on b:1'])
    expect(digestPanel(ts, matrix(series({ __name__: 'up', job: 'api' }, () => 1))).series[0]!.name).toBe('up')
    expect(digestPanel(ts, matrix(series({}, () => 1))).series[0]!.name).toBe('value')
  })
  it('takes several queries as a map and labels series by query', () => {
    const d = digestPanel(ts, { p50: matrix(series({}, () => 0.1)), p99: matrix(series({}, () => 0.9)) }, { legends: { p99: 'p99' } })
    expect(d.series.map((s) => [s.name, s.query, s.last])).toEqual([['p99', 'p99', 0.9], ['p50: p50', 'p50', 0.1]])
  })
})

describe('digestPanel: gaps', () => {
  it('finds a gap of three missing samples', () => {
    const d = digestPanel(ts, matrix(series({ a: 'b' }, (i) => (i >= 4 && i <= 6 ? null : i))))
    expect(d.series[0]!.gaps).toEqual({ count: 1, missing: 3, longest: 240 })
    expect(d.series[0]!.points).toBe(8)
  })
  it('uses the given step, and reports a late start and staleness against the range', () => {
    const data = matrix(series({ a: 'b' }, (i) => (i < 2 ? null : i)))
    const d = digestPanel(ts, data, { step: 60, start: T0, end: T0 + 600 + 300 })
    expect(d.series[0]!.gaps).toEqual({ count: 1, missing: 2, longest: 180 })
    expect(d.series[0]!.stale).toBe(300)
    expect(digestPanel(ts, data, { step: 60, start: T0 + 120, end: T0 + 600 }).series[0]).toMatchObject({ gaps: { count: 0 } })
    expect(digestPanel(ts, data, { step: 60, start: T0 + 120, end: T0 + 600 }).series[0]!.stale).toBeUndefined()
  })
  it('a coarser real step is not a gap when declared', () => {
    const d = digestPanel(ts, matrix(series({ a: 'b' }, (i) => (i % 2 ? null : i))), { step: 120 })
    expect(d.series[0]!.gaps.count).toBe(0)
  })
})

describe('digestPanel: outliers (robust z-score across series)', () => {
  it('flags the one series far from its peers, with the expected score', () => {
    const means = [10, 10.5, 9.5, 10.2, 9.8, 50]
    const d = digestPanel(ts, matrix(...means.map((m, i) => series({ pod: `p${i}` }, () => m))), { topK: 10 })
    // median 10.1; |dev| = .1 .4 .6 .1 .3 39.9 → MAD .35; z = 0.6745 * 39.9 / 0.35
    const out = d.series.find((s) => s.labels.pod === 'p5')!
    expect(out.outlier).toBe(true)
    expect(out.z).toBeCloseTo((0.6745 * 39.9) / 0.35, 9)
    expect(d.series.filter((s) => s.outlier)).toHaveLength(1)
    expect(d.outliers).toBe(1)
    expect(d.series[0]).toBe(out) // outliers rank first when nothing breaches
    expect(d.series.find((s) => s.labels.pod === 'p2')!.z).toBeCloseTo((0.6745 * -0.6) / 0.35, 9)
  })
  it('robustZ falls back to the mean absolute deviation when MAD is 0', () => {
    const z = robustZ([1, 1, 1, 1, 10])
    expect(z.slice(0, 4)).toEqual([0, 0, 0, 0])
    expect(z[4]).toBeCloseTo(9 / (1.253314 * 1.8), 9)
    expect(robustZ([5, 5, 5])).toEqual([0, 0, 0])
    expect(robustZ([])).toEqual([])
  })
  it('does not flag anything with fewer than four series or with a tight group', () => {
    expect(digestPanel(ts, matrix(series({ a: '1' }, () => 1), series({ a: '2' }, () => 1), series({ a: '3' }, () => 100))).outliers).toBe(0)
    expect(digestPanel(ts, matrix(...[10, 11, 12, 13, 14, 15].map((m, i) => series({ a: String(i) }, () => m)))).outliers).toBe(0)
  })
  it('the cut-off is configurable', () => {
    const data = matrix(...[10, 11, 12, 13, 14, 20].map((m, i) => series({ a: String(i) }, () => m)))
    expect(digestPanel(ts, data).outliers).toBe(0) // z = 0.6745*7.5/1.5 = 3.37
    expect(digestPanel(ts, data, { outlierZ: 3 }).outliers).toBe(1)
  })
})

describe('digestPanel: thresholds', () => {
  it('thresholdState picks the most severe breached level', () => {
    const t = stat.kind === 'stat' ? stat.thresholds! : []
    expect(thresholdState(0.0005, t)).toEqual({ state: 'ok' })
    expect(thresholdState(0.001, t)).toEqual({ state: 'ok' }) // strictly above
    expect(thresholdState(0.002, t)).toEqual({ state: 'warn', breached: '>0.001' })
    expect(thresholdState(0.02, t)).toEqual({ state: 'crit', breached: '>0.01' })
    expect(thresholdState(0.5, [{ below: 1, level: 'crit' }, { below: 3, level: 'warn' }])).toEqual({ state: 'crit', breached: '<1' })
    expect(thresholdState(2, [{ below: 1, level: 'crit' }, { below: 3, level: 'warn' }])).toEqual({ state: 'warn', breached: '<3' })
    expect(thresholdState(5, undefined)).toBeNull()
    expect(thresholdState(null, t)).toEqual({ state: 'ok' })
  })
  it('reports the state of the current value and the worst state in the window', () => {
    const d = digestPanel(stat, matrix(
      series({ svc: 'now-bad' }, (i) => (i < 10 ? 0.0001 : 0.02)),
      series({ svc: 'was-bad' }, (i) => (i === 5 ? 0.02 : 0.0001)),
      series({ svc: 'warn' }, () => 0.005),
      series({ svc: 'fine' }, () => 0.0001),
    ))
    const by = Object.fromEntries(d.series.map((s) => [s.labels.svc, s]))
    expect(by['now-bad']).toMatchObject({ state: 'crit', worst: 'crit', breached: '>0.01', value: 0.02 })
    expect(by['was-bad']).toMatchObject({ state: 'ok', worst: 'crit' })
    expect(by['warn']).toMatchObject({ state: 'warn', worst: 'warn', breached: '>0.001' })
    expect(by['fine']).toMatchObject({ state: 'ok', worst: 'ok' })
    expect(d.state).toBe('crit')
    expect(d.worst).toBe('crit')
    expect(d.series.map((s) => s.labels.svc)).toEqual(['now-bad', 'warn', 'was-bad', 'fine'])
  })
  it('evaluates thresholds on the panel reducer', () => {
    const data = matrix(series({ a: 'b' }, (i) => (i === 5 ? 0.5 : 0.0001)))
    expect(digestPanel(stat, data).state).toBe('ok')
    expect(digestPanel({ ...stat, options: { reduce: 'max' } } as Panel, data)).toMatchObject({ state: 'crit', series: [{ value: 0.5 }] })
    expect(digestPanel({ ...stat, options: { reduce: 'mean' } } as Panel, data).series[0]!.value).toBeCloseTo((0.5 + 10 * 0.0001) / 11, 12)
    expect(digestPanel({ ...stat, options: { reduce: 'sum' } } as Panel, data).series[0]!.value).toBeCloseTo(0.501, 12)
    expect(digestPanel({ ...stat, options: { reduce: 'min' } } as Panel, data).series[0]!.value).toBe(0.0001)
  })
  it('panels without thresholds have no state', () => {
    const d = digestPanel(ts, matrix(series({ a: 'b' }, () => 1e9)))
    expect(d.state).toBeNull()
    expect(d.series[0]!.state).toBeNull()
  })
})

describe('digestPanel: top-k and no data', () => {
  const low: Panel = { ...ts, thresholds: [{ below: 1, level: 'crit' }] } as Panel
  const many = matrix(...Array.from({ length: 10 }, (_, i) => series({ pod: `p${i}` }, () => (i === 0 ? 0.5 : i === 1 ? 0.7 : i * 10))))
  it('keeps the k most important series: breaching first, then by value', () => {
    const d = digestPanel(low, many, { topK: 3 })
    expect(d.seriesCount).toBe(10)
    expect(d.series.map((s) => s.labels.pod)).toEqual(['p1', 'p0', 'p9'])
    expect(d.omitted).toEqual({ count: 7, crit: 0, warn: 0, outliers: 0 })
    expect(d.state).toBe('crit')
  })
  it('the panel state covers series that were cut, and the cut is counted', () => {
    const d = digestPanel(low, many, { topK: 1 })
    expect(d.series).toHaveLength(1)
    expect(d.omitted).toMatchObject({ count: 9, crit: 1 })
    expect(d.state).toBe('crit')
    expect(digestPanel(low, many).series).toHaveLength(5) // default k
    expect(digestPanel(low, many, { topK: 0 })).toMatchObject({ series: [], state: 'crit', omitted: { count: 10, crit: 2 } })
  })
  it('no data is a first-class result', () => {
    for (const data of [matrix(), undefined, null, { q: matrix() }, matrix({ metric: { a: 'b' }, values: [] })]) {
      const d = digestPanel(stat, data as never)
      expect(d.noData).toBe(true)
      expect(d.state).toBe('ok')
    }
  })
  it('text panels carry their content', () => {
    expect(digestPanel({ kind: 'text', title: 'Notes', content: 'read me' }, undefined, { id: 'n' })).toMatchObject({ id: 'n', kind: 'text', text: 'read me', noData: false, series: [] })
  })
})

describe('renderDigest', () => {
  const mk = (i: number, kind: 'crit' | 'warn' | 'outlier' | 'nodata' | 'ok'): PanelDigest => {
    const panel: Panel = { kind: 'timeseries', title: `Panel ${i} ${kind}`, description: `What panel ${i} shows and what bad looks like, in a sentence of realistic length.`, unit: 'req/s', queries: ['q'], thresholds: [{ above: 100, level: 'warn' }, { above: 1000, level: 'crit' }] }
    const base = kind === 'crit' ? 5000 : kind === 'warn' ? 500 : 10
    const data = kind === 'nodata' ? matrix() : matrix(...Array.from({ length: 6 }, (_, s) => series({ route: `/r${s}` }, (t) => (kind === 'outlier' && s === 5 ? 90 : s === 0 ? base : 10 + s * 0.1) + t * 0.01)))
    return digestPanel(panel, data, { id: `p${i}`, topK: 5 })
  }
  const kinds = ['ok', 'ok', 'warn', 'ok', 'nodata', 'ok', 'crit', 'ok', 'outlier', 'ok', 'ok', 'ok'] as const
  const dash: DashboardDigest = { id: 'd', title: 'Test dashboard', intent: 'Checks that rendering respects the budget and orders by importance.', revision: 'abcdef0123456789abcdef0123456789', variables: { env: 'prod' }, panels: kinds.map((k, i) => mk(i, k)) }
  const fullIds = (text: string) => [...text.matchAll(/^## .* — (p\d+) \(/gm)].map((m) => m[1]!)

  it('renders everything when the budget allows, most important first', () => {
    const r = renderDigest(dash, { format: 'markdown', maxTokens: 20000 })
    expect(r.truncated).toBe(false)
    expect(r.cursor).toBeUndefined()
    expect(r.panelsShown).toBe(12)
    expect(fullIds(r.text)).toEqual(['p6', 'p2', 'p8', 'p4', 'p0', 'p1', 'p3', 'p5', 'p7', 'p9', 'p10', 'p11'])
    expect(r.text).toContain('# Test dashboard (d, rev abcdef012345)')
    expect(r.text).toContain('12 panels: 1 crit, 1 warn, 3 with outliers, 1 no data')
    expect(r.text).toContain('## [CRIT] Panel 6 crit — p6 (timeseries, req/s)')
    expect(r.text).toMatch(/\| route=\/r0 \| 5000 \| 5000 \| 5000 \| 5000 \| flat \+0\.002% \| CRIT >1000 \|/)
    expect(r.text).toContain('## [NO DATA] Panel 4 nodata')
    expect(r.text).toContain('No data returned for this range.')
    expect(r.text).toMatch(/outlier z=/)
    expect(r.text).toContain('(1 more series not shown)')
    expect(r.tokens).toBe(Math.ceil(r.text.length / 4))
  })
  it.each([150, 300, 600, 1200])('stays within %i tokens, keeps breaching panels, reports truncation and a cursor', (maxTokens) => {
    const r = renderDigest(dash, { format: 'markdown', maxTokens })
    expect(r.text.length).toBeLessThanOrEqual(maxTokens * 4)
    expect(r.tokens).toBeLessThanOrEqual(maxTokens)
    expect(r.truncated).toBe(true)
    expect(r.cursor).toMatch(/^o:\d+$/)
    expect(r.text).toContain(`cursor "${r.cursor}"`)
    expect(r.text).toMatch(/\[CRIT\] Panel 6/) // the breaching panel always survives
    const shown = fullIds(r.text)
    if (maxTokens >= 300) expect(shown[0]).toBe('p6')
    if (maxTokens >= 600) expect(shown.slice(0, 2)).toEqual(['p6', 'p2'])
    expect(r.text.indexOf('Panel 6 crit')).toBeLessThan(r.text.indexOf('Panel 0 ok') === -1 ? Infinity : r.text.indexOf('Panel 0 ok'))
  })
  it.each(['markdown', 'tsv'] as const)('paging with the cursor shows every panel exactly once in full (%s)', (format) => {
    const seen: string[] = []
    let cursor: string | undefined
    let pages = 0
    do {
      const r = renderDigest(dash, { format, maxTokens: 400, ...(cursor ? { cursor } : {}) })
      expect(r.text.length).toBeLessThanOrEqual(1600)
      const ids = format === 'markdown' ? fullIds(r.text) : [...new Set([...r.text.matchAll(/^(p\d+)\t/gm)].map((m) => m[1]!))]
      seen.push(...ids)
      expect(r.truncated).toBe(r.cursor !== undefined)
      cursor = r.cursor
      pages++
    } while (cursor && pages < 50)
    expect(pages).toBeGreaterThan(2)
    expect(pages).toBeLessThan(13)
    const withData = format === 'markdown' ? 12 : 11 // the no-data panel has no TSV rows
    expect(seen).toHaveLength(withData)
    expect(new Set(seen).size).toBe(withData)
  })
  it('always makes progress, even when one panel does not fit', () => {
    let cursor: string | undefined
    let pages = 0
    do {
      const r = renderDigest(dash, { format: 'markdown', maxTokens: 60, ...(cursor ? { cursor } : {}) })
      expect(r.text.length).toBeLessThanOrEqual(240)
      expect(r.truncated).toBe(true)
      cursor = r.cursor
      pages++
    } while (cursor && pages < 50)
    expect(pages).toBe(12)
  })
  it('a tiny or zero budget never overflows and never throws', () => {
    for (const maxTokens of [0, 1, 5, 20]) {
      const r = renderDigest(dash, { format: 'markdown', maxTokens })
      expect(r.text.length).toBeLessThanOrEqual(maxTokens * 4)
      expect(r.truncated).toBe(true)
    }
  })
  it('TSV has a header row and nine tab-separated fields per data row', () => {
    const r = renderDigest(dash, { format: 'tsv', maxTokens: 20000 })
    const lines = r.text.trimEnd().split('\n')
    const rows = lines.filter((l) => !l.startsWith('#'))
    expect(rows[0]).toBe('panel\tseries\tvalue\tmin\tmax\tmean\ttrend\tstate\tnotes')
    expect(rows.length).toBe(1 + 11 * 5)
    for (const row of rows) expect(row.split('\t')).toHaveLength(9)
    expect(rows[1]!.split('\t').slice(0, 3)).toEqual(['p6', 'route=/r0', '5000'])
    expect(r.text).toContain('# p4\ttimeseries\treq/s\tNO DATA\tPanel 4 nodata\t0 series')
    expect(r.truncated).toBe(false)
    // TSV is the cheaper format
    expect(r.text.length).toBeLessThan(renderDigest(dash, { format: 'markdown', maxTokens: 20000 }).text.length)
  })
  it('a malformed cursor starts from the beginning; a cursor past the end shows nothing more', () => {
    expect(renderDigest(dash, { format: 'markdown', maxTokens: 20000, cursor: 'garbage' }).panelsShown).toBe(12)
    const end = renderDigest(dash, { format: 'markdown', maxTokens: 20000, cursor: 'o:99' })
    expect(end).toMatchObject({ panelsShown: 0, truncated: false })
  })
  it('panelOrder is the order the text is written in, so a caller can list the same panels in structure', () => {
    const order = panelOrder(dash.panels)
    expect(order.map((i) => dash.panels[i]!.id)).toEqual(fullIds(renderDigest(dash, { format: 'markdown', maxTokens: 20000 }).text))
    expect([...order].sort((a, b) => a - b)).toEqual(dash.panels.map((_, i) => i))
    // a page's cursor "o:N" consumed exactly the first N of that order
    for (const maxTokens of [150, 400, 900]) {
      const r = renderDigest(dash, { format: 'markdown', maxTokens })
      const n = Number(r.cursor!.slice(2))
      const written = fullIds(r.text) // panels with a heading: in full, or the first one cut to fit
      expect(written).toEqual(order.slice(0, written.length).map((i) => dash.panels[i]!.id))
      expect(written.length).toBeLessThanOrEqual(n)
      expect(r.panelsShown).toBeLessThanOrEqual(n)
    }
    // ties keep the given (layout) order; text panels go last
    const text = digestPanel({ kind: 'text', title: 'Notes', content: 'x' }, undefined, { id: 'n' })
    const ok = dash.panels.find((p) => p.id === 'p0')!
    expect(panelOrder([text, ok, ok])).toEqual([1, 2, 0])
  })
  it.each(['markdown', 'tsv'] as const)('continuation: false writes no truncation footer, uses its room, and still reports the cursor (%s)', (format) => {
    for (const maxTokens of [60, 150, 400, 900]) {
      const withFooter = renderDigest(dash, { format, maxTokens })
      const without = renderDigest(dash, { format, maxTokens, continuation: false })
      expect(without.text.length).toBeLessThanOrEqual(maxTokens * 4)
      expect(without.text).not.toMatch(/_Truncated:|^# truncated/m)
      expect(without.text).not.toContain('cursor')
      expect(withFooter.text).toMatch(/_Truncated:|^# truncated/m)
      expect(without.truncated).toBe(true)
      expect(without.cursor).toMatch(/^o:\d+$/)
      // never fewer panels than with the footer, since its room is not reserved
      expect(Number(without.cursor!.slice(2))).toBeGreaterThanOrEqual(Number(withFooter.cursor!.slice(2)))
    }
    // paging without the footer still shows every panel exactly once
    const seen: string[] = []
    let cursor: string | undefined
    let pages = 0
    do {
      const r = renderDigest(dash, { format: 'markdown', maxTokens: 400, continuation: false, ...(cursor ? { cursor } : {}) })
      seen.push(...fullIds(r.text))
      cursor = r.cursor
      pages++
    } while (cursor && pages < 50)
    expect(new Set(seen).size).toBe(12)
    expect(seen).toHaveLength(12)
    // nothing to continue: identical to the default
    expect(renderDigest(dash, { format, maxTokens: 20000, continuation: false }).text).toBe(renderDigest(dash, { format, maxTokens: 20000 }).text)
  })
  it('formatNumber is compact', () => {
    expect([0, 1, 0.5, 1234.5678, 0.000123, 12345678, 1e-7, -42.4242, null, NaN].map(formatNumber)).toEqual(['0', '1', '0.5', '1235', '0.000123', '1.23e7', '1e-7', '-42.42', '-', '-'])
  })
})

describe('digestDashboard', () => {
  it('digests a resolved example end to end, fragments included', () => {
    const r = resolve(red)
    const data: Record<string, Record<string, PromMatrix>> = {}
    for (const [id, p] of Object.entries(r.panels)) {
      if (p.kind === 'text') continue
      data[id] = Object.fromEntries(p.queries.map((q, qi) => [q, matrix(series({ route: '/pay' }, (i) => (id === 'error_ratio' ? 0.02 : id === 'db.errors' ? 0.03 : 0.0001 * (qi + 1) + i * 1e-6)))]))
    }
    delete data.routes
    const d = digestDashboard(r, data, { start: T0, end: T0 + 600, step: 60, link: 'https://viz.example/d/service_red?from=1700000000&to=1700000600' })
    expect(d.panels.map((p) => p.id)).toEqual(r.order)
    expect(d.variables).toEqual({ env: 'prod', service: 'checkout', route: '*' })
    expect(d.revision).toBe(r.revision)
    const by = Object.fromEntries(d.panels.map((p) => [p.id, p]))
    expect(by.error_ratio!.state).toBe('crit')
    expect(by['db.errors']!.state).toBe('warn')
    expect(by.routes!.noData).toBe(true)
    expect(by.latency_quantiles!.series.map((s) => s.name)).toEqual(['p99', 'p95', 'p50']) // legends from the queries
    const text = renderDigest(d, { format: 'markdown', maxTokens: 800 })
    expect(text.text.length).toBeLessThanOrEqual(3200)
    expect(text.text.indexOf('[CRIT] Error ratio')).toBeGreaterThan(0)
    expect(text.text.indexOf('[CRIT] Error ratio')).toBeLessThan(text.text.indexOf('[WARN] Dependency error ratio'))
    expect(text.text).toContain('variables env=prod service=checkout route=*')
    expect(text.text).toContain('https://viz.example/d/service_red')
  })
})
