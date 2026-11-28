import { describe, expect, it } from 'vitest'
import { resolve, validate, PANEL_KINDS } from '../../../dashboard/src/index.ts'
import { SEED_DASHBOARDS } from '../../mock/dashboards'
import { stringifySearch } from '../lib/urlState'
import { fixedZone } from '../lib/timeInput'
import {
  builtinsFor,
  chartUnitOf,
  dashboardText,
  digestOf,
  DRAWN_KINDS,
  gridSpan,
  isDrawn,
  labelValuesOf,
  panelText,
  parseDashboardsSearch,
  queryWords,
  rangeOf,
  rangeWords,
  readSpec,
  resolveFor,
  sectionsOf,
  timeSpecOf,
  toProm,
  variablesOf,
  windowOf,
} from './model'

const spec = (id: string) => SEED_DASHBOARDS.find((d) => d.spec.metadata.id === id)!.spec
const T1 = Date.UTC(2026, 10, 18, 12, 30) / 1000
const T0 = T1 - 3 * 3600

describe('a spec from the API', () => {
  it('is a dashboard only when the model\'s validate says so', () => {
    expect(readSpec(spec('service_red'))).toMatchObject({ ok: true })
    const broken = { ...spec('service_red'), panels: { p: { kind: 'gauge', title: 'x' } } }
    const r = readSpec(broken)
    expect(r.ok).toBe(false)
    expect(r).toEqual({ ok: false, errors: validate(broken).errors })
    expect(readSpec(null).ok).toBe(false)
    expect(readSpec({ apiVersion: 'viz.dashboard/v2' }).ok).toBe(false)
  })

  it('the kinds this app draws are three of the model\'s five; the others are known and not drawn', () => {
    expect([...DRAWN_KINDS]).toEqual(['timeseries', 'stat', 'table'])
    expect(PANEL_KINDS.filter((k) => !isDrawn(k))).toEqual(['heatmap', 'text'])
    expect(isDrawn('gauge')).toBe(false)
  })
})

describe('the address of /dashboards', () => {
  it('keeps the id, the range, the search, the tag and variable values, and drops everything else', () => {
    expect(parseDashboardsSearch({ id: 'service_red', from: 'now-6h', to: 'now', 'var.service': 'orders', 'var.status': 500, view: 'json', step: '15s', token: 'viz_x_y' })).toEqual({
      id: 'service_red',
      from: 'now-6h',
      to: 'now',
      'var.service': 'orders',
      'var.status': '500',
    })
    expect(parseDashboardsSearch({ q: ' checkout', tag: 'on-call' })).toEqual({ q: ' checkout', tag: 'on-call' })
  })
  it('refuses an id that is not one, a time that is not one, and a variable name that is not an id', () => {
    expect(parseDashboardsSearch({ id: '../etc', from: 'yesterday', to: '', 'var.': 'x', 'var.A-b': 'x', 'var.ok': '' })).toEqual({})
  })
  it('variable values are read by name', () => {
    expect(variablesOf({ id: 'a', 'var.service': 'orders', 'var.status': '*' })).toEqual({ service: 'orders', status: '*' })
  })
  it('a dashboard\'s address keeps a range that is Explore\'s default: left out, it would mean the dashboard\'s own', () => {
    expect(stringifySearch({ id: 'pod_capacity', from: 'now-1h', to: 'now' })).toBe('?id=pod_capacity&from=now-1h&to=now')
    expect(stringifySearch({ q: 'up', from: 'now-1h', to: 'now' })).toBe('?q=up')
  })
})

describe('time', () => {
  it('reads a spec\'s times in the app\'s forms', () => {
    expect(timeSpecOf('now-6h', 'now-1h')).toBe('now-6h')
    expect(timeSpecOf('now', 'now-1h')).toBe('now')
    expect(timeSpecOf('2026-11-18T09:30:00Z', 'now-1h')).toBe(String(Date.UTC(2026, 10, 18, 9, 30)))
    expect(timeSpecOf('last tuesday', 'now-1h')).toBe('now-1h')
    expect(timeSpecOf(undefined, 'now')).toBe('now')
  })
  it('the range is the address\'s, else the spec\'s own, else the last hour', () => {
    expect(rangeOf(spec('pod_capacity'), {})).toEqual({ from: 'now-6h', to: 'now' })
    expect(rangeOf(spec('pod_capacity'), { from: 'now-1h' })).toEqual({ from: 'now-1h', to: 'now' })
    expect(rangeOf(null, {})).toEqual({ from: 'now-1h', to: 'now' })
  })
  it('one window for the whole dashboard, on whole steps, and the model\'s built-ins from it', () => {
    const w = windowOf(String(T0 * 1000), String(T1 * 1000), T1 + 500)!
    expect(w).toEqual({ start: T0, end: T1, step: 30 })
    expect(builtinsFor(w)).toEqual({ __rate: '5m', __interval: '30s', __range: '3h' })
    expect(builtinsFor({ start: 0, end: 7 * 86400, step: 1800 })).toEqual({ __rate: '2h', __interval: '30m', __range: '7d' })
    expect(windowOf('now', 'now-1h', T1)).toBeNull()
  })
  it('a range in words, as the time fields read it', () => {
    const utc = fixedZone(0)
    const now = Date.UTC(2026, 10, 27)
    expect(rangeWords(T0, T1, now, utc)).toBe('18 Nov, 09:30 to 12:30')
    expect(rangeWords(T0 - 86400, T1, now, utc)).toBe('17 Nov 09:30 to 18 Nov 12:30')
  })
})

describe('resolution is the model\'s', () => {
  it('variables from the address are written into the queries by the model, escaped as it escapes', () => {
    const w = { start: T0, end: T1, step: 30 }
    const r = resolveFor(spec('service_red'), { service: 'orders', status: '500' }, w)
    expect(r.queries.rate_by_route!.expr).toBe('sum by (route) (rate(http_requests_total{service="orders",status=~"500"}[5m]))')
    expect(r).toEqual(resolve(spec('service_red'), { variables: { service: 'orders', status: '500' }, builtins: builtinsFor(w) }))
    const hostile = resolveFor(spec('service_red'), { service: 'x"} or up{a="' }, w)
    expect(hostile.queries.cpu!.expr).toBe('pod_cpu_usage_cores{service="x\\"} or up{a=\\""}')
    expect(resolveFor(spec('service_red'), {}, w).variables).toEqual({ service: { values: ['checkout'], all: false }, status: { values: [], all: true } })
  })
})

describe('layout', () => {
  it('a width in twelfths is the nearest the grid has', () => {
    expect([1, 3, 4, 5, 6, 8, 9, 12].map(gridSpan)).toEqual([3, 3, 4, 6, 6, 6, 12, 12])
  })
  it('rows become sections in reading order; an equal split when no span is given', () => {
    const s = sectionsOf(resolve(spec('services_overview')).layout)
    expect(s.map((x) => x.title)).toEqual(['Health', 'Traffic', 'Latency and routes', 'Pods', 'Detail'])
    expect(s[0]!.items).toEqual(['requests', 'error_ratio', 'latency', 'pods'].map((panel) => ({ panel, span: 3 })))
    expect(s[1]!.items).toEqual([{ panel: 'rate_by_service', span: 6 }, { panel: 'errors_by_service', span: 6 }])
    expect(s.flatMap((x) => x.items.map((i) => i.panel))).toEqual(resolve(spec('services_overview')).order)
  })
  it('a fragment instance continues as its own rows under the row\'s heading', () => {
    const r = resolve(spec('checkout_path'))
    expect(sectionsOf(r.layout)).toEqual([
      { title: 'checkout', items: [{ panel: 'checkout.rate', span: 6 }, { panel: 'checkout.latency', span: 6 }] },
      { title: 'orders', items: [{ panel: 'orders.rate', span: 6 }, { panel: 'orders.latency', span: 6 }] },
    ])
  })
  it('a grid is one section, top to bottom then left to right, each item as wide as its share', () => {
    const s = sectionsOf(resolve(spec('pod_capacity')).layout)
    expect(s).toEqual([{ items: [{ panel: 'cpu', span: 6 }, { panel: 'durations', span: 6 }, { panel: 'memory', span: 3 }, { panel: 'sample', span: 6 }, { panel: 'notes', span: 3 }, { panel: 'restarts', span: 6 }] }])
  })
  it('every panel of every seed dashboard is placed exactly once', () => {
    for (const d of SEED_DASHBOARDS) {
      const r = resolve(d.spec)
      expect(sectionsOf(r.layout).flatMap((x) => x.items.map((i) => i.panel)).sort()).toEqual(Object.keys(r.panels).sort())
    }
  })
})

describe('units, variables, names', () => {
  it('a model unit as the chart takes it', () => {
    expect(chartUnitOf('ratio')).toEqual({ name: '%', scale: 100 })
    expect(chartUnitOf('s')).toEqual({ name: 's', scale: 1 })
    expect(chartUnitOf('us')).toEqual({ name: 's', scale: 1e-6 })
    expect(chartUnitOf('bytes')).toEqual({ name: 'B', scale: 1 })
    expect(chartUnitOf('bytes/s', 5 * 1024 ** 2)).toEqual({ name: 'MiB/s', scale: 1 / 1024 ** 2 })
    expect(chartUnitOf('req/s')).toEqual({ name: 'req/s', scale: 1 })
    expect(chartUnitOf('count')).toEqual({ name: '', scale: 1 })
    expect(chartUnitOf(undefined)).toEqual({ name: '', scale: 1 })
  })
  it('reads label_values(...) and nothing else as a variable\'s query', () => {
    expect(labelValuesOf('label_values(http_requests_total, service)')).toEqual({ label: 'service', match: 'http_requests_total' })
    expect(labelValuesOf('label_values(http_requests_total{env="prod",a=~"x,y"}, route)')).toEqual({ label: 'route', match: 'http_requests_total{env="prod",a=~"x,y"}' })
    expect(labelValuesOf(' label_values( pod ) ')).toEqual({ label: 'pod', match: null })
    expect(labelValuesOf('query_result(count(up))')).toBeNull()
    expect(labelValuesOf('up')).toBeNull()
  })
  it('a query is called by its column, its fixed legend, or its id', () => {
    const r = resolve(spec('services_overview'))
    expect(queryWords(r.panels.routes!, 'route_errors', undefined)).toBe('Errors')
    expect(queryWords(resolve(spec('service_red')).panels.duration!, 'p95', 'p95')).toBe('p95')
    expect(queryWords(r.panels.rate_by_service!, 'req_by_service', '{{service}}')).toBe('req_by_service')
  })
})

describe('the text form is the model\'s digest', () => {
  const series = [
    { metric: { service: 'checkout' }, times: [T0, T0 + 30, T0 + 60], values: [0.01, 0.03, 0.06] },
    { metric: { service: 'orders' }, times: [T0, T0 + 30, T0 + 60], values: [0.001, NaN, 0.002] },
  ]
  it('a result as the model takes it: a matrix, values as text', () => {
    expect(toProm(series).result[1]).toEqual({ metric: { service: 'orders' }, values: [[T0, '0.001'], [T0 + 30, 'NaN'], [T0 + 60, '0.002']] })
    expect(toProm([{ metric: {}, times: [1], values: [Infinity] }]).result[0]!.values).toEqual([[1, '+Inf']])
  })
  it('a panel\'s text is the block the model writes for it: heading with kind and unit, description, series with state', () => {
    const r = resolve(spec('service_red'))
    const d = digestOf(r, 'error_ratio', { err_ratio: series }, { start: T0, end: T0 + 60, step: 30 })
    expect(d).toMatchObject({ kind: 'stat', seriesCount: 2, state: 'crit' })
    const text = panelText(r, d)
    expect(text.split('\n')[0]).toBe('## [CRIT] Error ratio — error_ratio (stat, ratio)')
    expect(text).toContain("Share of this service's requests answered with 500.")
    expect(text).toContain('| service=checkout | 0.06 | 0.01 | 0.06 |')
    expect(text).toContain('CRIT >0.05')
    expect(text).not.toContain('# Service: rate, errors, duration')
  })
  it('a kind the app does not draw has its text all the same, under its own kind', () => {
    const r = resolve(spec('pod_capacity'))
    expect(panelText(r, digestOf(r, 'durations', { buckets: series }, null)).split('\n')[0]).toContain('durations (heatmap, s)')
    const note = panelText(r, digestOf(r, 'notes', {}, null))
    expect(note.split('\n')[0]).toBe('## How to read this — notes (text)')
    expect(note).toContain('CPU is in cores, memory in bytes.')
  })
  it('the dashboard\'s text names the range and the variables', () => {
    const r = resolve(spec('service_red'))
    const text = dashboardText(r, [digestOf(r, 'error_ratio', { err_ratio: series }, null)], { start: T0, end: T1, step: 30 })
    expect(text.split('\n')[0]).toMatch(/^# Service: rate, errors, duration \(service_red, rev [0-9a-f]{12}\)$/)
    expect(text).toContain('range 2026-11-18T09:30:00.000Z → 2026-11-18T12:30:00.000Z; variables service=checkout status=*')
  })
})
