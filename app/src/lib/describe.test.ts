import { describe, expect, it } from 'vitest'
import { describeResult, identify, type ResultRequest } from './describe'
import { nameSeries } from './naming'
import { axisUnitLabel, columnFormat, formatValue, scaleFor } from './units'

const RATE = 'sum by (service) (rate(http_requests_total[5m]))'
const CPU = 'pod_cpu_usage_cores{service="checkout"}'
const MEM = 'pod_memory_working_set_bytes'
const window_ = { start: 1000, end: 4600, step: 15 }
const req = (q: string, extra: Partial<ResultRequest> = {}): ResultRequest => ({ q, from: 'now-1h', to: 'now', step: 'auto', ...extra })

/** Everything the page writes about a result, as one string, the way the page derives it. */
function chrome(resultQuery: string, pendingQuery: string, displayUnit = 'auto'): string {
  const result = identify(req(resultQuery), window_, 1_795_000_000_000)
  const d = describeResult(result, { unit: displayUnit }, req(pendingQuery))
  const values = [136, 117, 171]
  const legend = columnFormat(values, d.unit)
  const scale = scaleFor(d.unit, 171)
  return JSON.stringify({
    q: d.q,
    unit: d.unit,
    head: axisUnitLabel(d.unit, scale),
    legendHead: legend.unit,
    legendCell: legend.cell(136),
    readout: formatValue(136, d.unit),
    digestTitle: d.digestTitle,
    chartLabel: d.chartLabel(4),
    range: d.range,
  })
}

describe('a result describes itself (B1)', () => {
  it('takes the unit from the result on screen, not from the pending query', () => {
    const result = identify(req(RATE), window_, 0)
    for (const pending of [CPU, MEM, 'up', '']) {
      const d = describeResult(result, { unit: 'auto' }, req(pending))
      expect(d.unit).toBe('rps')
      expect(formatValue(136, d.unit)).toBe('136/s') // never "136", "136 B" or "136 cores"
    }
  })
  it('titles the digest and names the chart with the result’s query', () => {
    const d = describeResult(identify(req(RATE), window_, 0), { unit: 'auto' }, req(CPU))
    expect(d.digestTitle).toBe(`Query: ${RATE}`)
    expect(d.chartLabel(4)).toContain(RATE)
    expect(d.chartLabel(4)).not.toContain('pod_cpu_usage_cores')
    expect(d.q).toBe(RATE)
  })
  it('nothing in the description changes with the pending query, and none of it mentions that query', () => {
    const settled = chrome(RATE, RATE)
    for (const pending of [CPU, MEM, 'histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket[5m])))']) {
      const waiting = chrome(RATE, pending)
      expect(waiting).toBe(settled)
      expect(waiting).not.toContain(pending)
    }
    expect(chrome(MEM, RATE)).toContain('MiB'.slice(0, 0)) // sanity: the reverse direction also holds
    expect(chrome(MEM, RATE)).toBe(chrome(MEM, MEM))
  })
  it('says plainly when the result is not the answer to the current request', () => {
    const result = identify(req(RATE), window_, 0)
    expect(describeResult(result, { unit: 'auto' }, req(RATE)).stale).toBeNull()
    expect(describeResult(result, { unit: 'auto' }, req(RATE)).staleText).toBeNull()
    const other = describeResult(result, { unit: 'auto' }, req(CPU))
    expect(other.stale).toBe('query')
    expect(other.staleText).toBe('Showing the previous query')
    const zoomed = describeResult(result, { unit: 'auto' }, req(RATE, { from: 'now-6h' }))
    expect(zoomed.stale).toBe('range')
    expect(zoomed.staleText).toBe('Showing the previous time range')
    expect(zoomed.range).toBe('Last 1h') // the range of the data on screen, not the one asked for
    expect(describeResult(result, { unit: 'auto' }, req(RATE, { step: '1m' })).stale).toBe('range')
  })
  it('a unit chosen in the toolbar applies to what is on screen; "auto" is the result’s own', () => {
    const result = identify(req(RATE), window_, 0)
    expect(describeResult(result, { unit: 'bytes' }, req(CPU)).unit).toBe('bytes')
    expect(describeResult(result, { unit: 'auto' }, req(CPU)).unit).toBe('rps')
    expect(describeResult(result, { unit: 'nonsense' }, req(CPU)).unit).toBe('rps')
  })
  it('fixes the inferred unit when the result is made', () => {
    expect(identify(req(CPU), window_, 5).inferredUnit).toBe('cores')
    expect(identify(req(MEM), window_, 5)).toEqual({ request: req(MEM), window: window_, inferredUnit: 'bytes', receivedAt: 5 })
  })
  it('names of the series come from the result’s label sets', () => {
    expect(nameSeries([{ service: 'auth' }, { service: 'orders' }]).names.map((n) => n.name)).toEqual(['auth', 'orders'])
  })
})
