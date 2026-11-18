import { describe, expect, it } from 'vitest'
import { bucketQuantile, parse, PromQLError, queryInstant, queryRange } from './promql'
import { memorySeries, memoryStorage } from './storage'
import { createMockApi } from './handler'
import { SERIES_START, syntheticStorage } from './data'

// Two counters scraped every 15 s: x grows 10 per scrape, y grows 30 per scrape.
const grid = [0, 15, 30, 45, 60]
const store = memoryStorage([
  memorySeries({ __name__: 'c_total', a: 'x', job: 'j' }, grid.map((t, i) => [t, i * 10])),
  memorySeries({ __name__: 'c_total', a: 'y', job: 'j' }, grid.map((t, i) => [t, i * 30])),
  // Counter with a reset between t=30 and t=45.
  memorySeries({ __name__: 'r_total' }, [[0, 0], [15, 10], [30, 20], [45, 5], [60, 15]]),
  memorySeries({ __name__: 'g', pod: 'p1', svc: 's' }, [[0, 1], [15, 3], [30, 2], [45, 8], [60, 4]]),
  memorySeries({ __name__: 'g', pod: 'p2', svc: 's' }, [[0, 10], [15, 10], [30, 10], [45, 10], [60, 20]]),
  memorySeries({ __name__: 'g', pod: 'p3', svc: 't' }, [[60, 7]]),
  // A classic histogram at t=60.
  memorySeries({ __name__: 'h_bucket', le: '0.1' }, [[60, 10]]),
  memorySeries({ __name__: 'h_bucket', le: '0.5' }, [[60, 60]]),
  memorySeries({ __name__: 'h_bucket', le: '1' }, [[60, 90]]),
  memorySeries({ __name__: 'h_bucket', le: '+Inf' }, [[60, 100]]),
])

type Vec = { metric: Record<string, string>; value: [number, string] }[]
function instant(q: string, t = 60): Record<string, number> {
  const r = queryInstant(store, q, t)
  if (r.resultType !== 'vector') throw new Error(`expected vector, got ${r.resultType}`)
  return Object.fromEntries((r.result as Vec).map((s) => [JSON.stringify(s.metric), Number(s.value[1])]))
}
function scalar(q: string): number {
  const r = queryInstant(store, q, 60)
  if (r.resultType !== 'scalar') throw new Error(`expected scalar, got ${r.resultType}`)
  return Number(r.result[1])
}

describe('mock PromQL: selectors', () => {
  it('selects by matchers', () => {
    expect(instant('c_total')).toEqual({ '{"__name__":"c_total","a":"x","job":"j"}': 40, '{"__name__":"c_total","a":"y","job":"j"}': 120 })
    expect(Object.keys(instant('c_total{a="x"}'))).toHaveLength(1)
    expect(Object.keys(instant('c_total{a!="x"}'))).toEqual(['{"__name__":"c_total","a":"y","job":"j"}'])
    expect(Object.keys(instant('{__name__=~"c_.*", a=~"x|y"}'))).toHaveLength(2)
    expect(Object.keys(instant('g{pod!~"p[12]"}'))).toEqual(['{"__name__":"g","pod":"p3","svc":"t"}'])
    // Regex matchers are anchored.
    expect(Object.keys(instant('g{pod=~"p"}'))).toHaveLength(0)
  })
  it('uses a 5 minute lookback, left-open', () => {
    expect(instant('g{pod="p3"}', 359)).toEqual({ '{"__name__":"g","pod":"p3","svc":"t"}': 7 })
    expect(instant('g{pod="p3"}', 360)).toEqual({})
    expect(instant('g{pod="p3"}', 59)).toEqual({})
  })
  it('applies offset', () => {
    expect(instant('g{pod="p1"} offset 30s')).toEqual({ '{"__name__":"g","pod":"p1","svc":"s"}': 2 })
  })
})

describe('mock PromQL: rate and increase (Prometheus extrapolation)', () => {
  // Window (0, 60] holds samples at 15, 30, 45, 60. For x: 10,20,30,40.
  // delta = 30 over 45 s sampled; the 15 s to the window start is within 1.1 * avg interval
  // and equals the time-to-zero bound, so it is extrapolated: 30 * (45 + 15) / 45 = 40.
  it('increase', () => {
    expect(instant('increase(c_total[1m])')).toEqual({ '{"a":"x","job":"j"}': 40, '{"a":"y","job":"j"}': 120 })
  })
  it('rate = increase / range', () => {
    const r = instant('rate(c_total[1m])')
    expect(r['{"a":"x","job":"j"}']).toBeCloseTo(40 / 60, 12)
    expect(r['{"a":"y","job":"j"}']).toBeCloseTo(2, 12)
  })
  it('handles a counter reset', () => {
    // samples 10, 20, 5, 15 -> 5 + (20 reset) + ... = (15 - 10) + 20 = 25; time-to-zero = 45*(10/25) = 18 > 15,
    // so extrapolate the full 15 s: 25 * 60/45.
    expect(instant('increase(r_total[1m])')['{}']).toBeCloseTo((25 * 60) / 45, 12)
  })
  it('needs two samples', () => {
    expect(instant('rate(c_total[15s])')).toEqual({})
    // (30, 60] has 45 and 60: delta 10 over 15 s; start gap 15 >= 1.1*15? no (15 < 16.5) but zero bound:
    // 15 * (30/10) = 45 > 15, so extrapolate 15 s: 10 * 30/15 = 20 -> rate 20/30.
    expect(instant('rate(c_total{a="x"}[30s])')['{"a":"x","job":"j"}']).toBeCloseTo(20 / 30, 12)
  })
  it('irate uses the last two samples', () => {
    expect(instant('irate(c_total{a="y"}[1m])')['{"a":"y","job":"j"}']).toBeCloseTo(2, 12)
  })
  it('*_over_time', () => {
    expect(instant('avg_over_time(g{pod="p1"}[1m])')['{"pod":"p1","svc":"s"}']).toBeCloseTo((3 + 2 + 8 + 4) / 4, 12)
    expect(instant('max_over_time(g{pod="p1"}[1m])')['{"pod":"p1","svc":"s"}']).toBe(8)
    expect(instant('min_over_time(g{pod="p1"}[1m])')['{"pod":"p1","svc":"s"}']).toBe(2)
    expect(instant('count_over_time(g{pod="p1"}[1m])')['{"pod":"p1","svc":"s"}']).toBe(4)
  })
})

describe('mock PromQL: aggregation', () => {
  it('sum / avg / max / min / count with by, without and no grouping', () => {
    expect(instant('sum(g)')).toEqual({ '{}': 31 })
    expect(instant('sum by (svc) (g)')).toEqual({ '{"svc":"s"}': 24, '{"svc":"t"}': 7 })
    expect(instant('sum(g) by (svc)')).toEqual({ '{"svc":"s"}': 24, '{"svc":"t"}': 7 })
    expect(instant('avg by (svc) (g)')).toEqual({ '{"svc":"s"}': 12, '{"svc":"t"}': 7 })
    expect(instant('max by (svc) (g)')).toEqual({ '{"svc":"s"}': 20, '{"svc":"t"}': 7 })
    expect(instant('min(g)')).toEqual({ '{}': 4 })
    expect(instant('count without (pod) (g)')).toEqual({ '{"svc":"s"}': 2, '{"svc":"t"}': 1 })
    expect(instant('sum by (a) (rate(c_total[1m]))')['{"a":"y"}']).toBeCloseTo(2, 12)
    expect(instant('sum(rate(c_total[1m]))')['{}']).toBeCloseTo(2 + 40 / 60, 12)
  })
  it('topk keeps labels', () => {
    expect(instant('topk(1, g)')).toEqual({ '{"__name__":"g","pod":"p2","svc":"s"}': 20 })
    expect(instant('bottomk(1, g)')).toEqual({ '{"__name__":"g","pod":"p1","svc":"s"}': 4 })
  })
})

describe('mock PromQL: histogram_quantile', () => {
  it('interpolates linearly inside the bucket', () => {
    // rank 50 falls in (0.1, 0.5]: 0.1 + 0.4 * (50 - 10) / (60 - 10) = 0.42
    expect(instant('histogram_quantile(0.5, h_bucket)')['{}']).toBeCloseTo(0.42, 12)
    // rank 5 in the first bucket, lower bound 0: 0.1 * 5/10
    expect(instant('histogram_quantile(0.05, h_bucket)')['{}']).toBeCloseTo(0.05, 12)
    // rank 95 lands in +Inf: the highest finite bound
    expect(instant('histogram_quantile(0.95, h_bucket)')['{}']).toBe(1)
    expect(instant('histogram_quantile(0.9, sum by (le) (h_bucket))')['{}']).toBeCloseTo(1, 12)
  })
  it('edge cases', () => {
    expect(bucketQuantile(0.5, [{ le: 1, count: 0 }, { le: Infinity, count: 0 }])).toBeNaN()
    expect(bucketQuantile(0.5, [{ le: 1, count: 5 }])).toBeNaN()
    expect(bucketQuantile(1.5, [{ le: 1, count: 5 }, { le: Infinity, count: 5 }])).toBe(Infinity)
  })
})

describe('mock PromQL: arithmetic', () => {
  it('scalar precedence and associativity', () => {
    expect(scalar('1 + 2 * 3 ^ 2')).toBe(19)
    expect(scalar('-2 ^ 2')).toBe(-4)
    expect(scalar('2 ^ 3 ^ 2')).toBe(512)
    expect(scalar('(1 + 2) * 3 - 10 / 4 % 2')).toBe(8.5)
    expect(scalar('1 > bool 2')).toBe(0)
    expect(scalar('time()')).toBe(60)
  })
  it('vector with scalar drops the metric name', () => {
    expect(instant('g{pod="p1"} * 2 + 1')).toEqual({ '{"pod":"p1","svc":"s"}': 9 })
    expect(instant('100 - g{pod="p1"}')).toEqual({ '{"pod":"p1","svc":"s"}': 96 })
  })
  it('comparison filters keep the sample', () => {
    expect(instant('g > 5')).toEqual({ '{"__name__":"g","pod":"p2","svc":"s"}': 20, '{"__name__":"g","pod":"p3","svc":"t"}': 7 })
    expect(instant('g{svc="s"} > bool 5')).toEqual({ '{"pod":"p1","svc":"s"}': 0, '{"pod":"p2","svc":"s"}': 1 })
  })
  it('vector with vector matches one-to-one on labels', () => {
    expect(instant('sum(g{svc="s"}) / sum(g)')['{}']).toBeCloseTo(24 / 31, 12)
    expect(instant('c_total / on (a) increase(c_total[1m])')).toEqual({ '{"a":"x"}': 1, '{"a":"y"}': 1 })
    expect(instant('g{pod="p1"} + ignoring (pod) g{pod="p2"}')).toEqual({ '{"svc":"s"}': 24 })
    expect(() => instant('g{pod="p1"} + on (svc) g')).toThrow(/many-to-one/)
  })
})

describe('mock PromQL: range queries and errors', () => {
  it('evaluates on the step grid and omits steps without data', () => {
    const r = queryRange(store, 'g{pod="p3"}', 0, 420, 60)
    expect(r.result).toEqual([{ metric: { __name__: 'g', pod: 'p3', svc: 't' }, values: [[60, '7'], [120, '7'], [180, '7'], [240, '7'], [300, '7']] }])
    const s = queryRange(store, '1 + 1', 0, 30, 15)
    expect(s.result).toEqual([{ metric: {}, values: [[0, '2'], [15, '2'], [30, '2']] }])
  })
  it('reports parse errors with a position', () => {
    expect(() => parse('sum by (')).toThrow(PromQLError)
    expect(() => parse('sum(rate(c_total[5m]')).toThrow('1:21: parse error: unclosed left parenthesis')
    expect(() => parse('c_total{a=}')).toThrow(/1:11: parse error: unexpected "}" in label matching, expected string/)
    expect(() => parse('')).toThrow('no expression found in input')
    expect(() => parse('foo(c_total)')).toThrow(/unknown function with name 'foo'/)
    // Valid PromQL the mock does not implement is `unsupported` (422), as the real API answers it.
    expect(() => parse('sort(c_total)')).toThrow(expect.objectContaining({ errorType: 'unsupported', message: 'function "sort" (not implemented by the viz mock backend)' }))
    expect(() => parse('rate(c_total)')).toThrow(/expected type range vector/)
    expect(() => parse('c_total and g')).toThrow(expect.objectContaining({ errorType: 'unsupported', message: 'set operator "and" (not implemented by the viz mock backend)' }))
    expect(() => parse('{}')).toThrow(/at least one non-empty matcher/)
  })
  it('enforces the 11,000 point limit, in the real API\'s words', () => {
    expect(() => queryRange(store, 'g', 0, 11001, 1)).toThrow('exceeded maximum resolution of 11000 points per timeseries. Try decreasing the query resolution (?step=XX)')
  })
})

describe('mock API over synthetic data', () => {
  const api = createMockApi({ now: () => SERIES_START + 86400 * 30 })
  const get = (url: string) => api.handle('GET', url).body as { status: string; data: any; error?: string; errorType?: string }
  const t = SERIES_START + 86400 * 30

  it('has 128 deterministic series of services and 200 synthetic ones', () => {
    const all = syntheticStorage().all()
    expect(all.length).toBe(328)
    expect(all.filter((s) => s.labels.__name__ === 'viz_synthetic_series')).toHaveLength(200)
    const a = get(`/api/v1/query?query=${encodeURIComponent('pod_cpu_usage_cores')}&time=${t}`)
    const b = get(`/api/v1/query?query=${encodeURIComponent('pod_cpu_usage_cores')}&time=${t}`)
    expect(a).toEqual(b)
    expect(a.data.result.length).toBe(12)
  })
  it('serves labels, label values, series and metadata', () => {
    expect(get('/api/v1/labels').data).toEqual(['__name__', 'instance', 'job', 'le', 'node', 'pod', 'route', 'service', 'status'])
    expect(get('/api/v1/labels?match[]=http_requests_total').data).toEqual(['__name__', 'job', 'route', 'service', 'status'])
    expect(get('/api/v1/label/__name__/values').data).toContain('http_request_duration_seconds_bucket')
    expect(get('/api/v1/label/route/values?match[]=' + encodeURIComponent('http_requests_total{service="auth"}')).data).toEqual(['/login', '/logout', '/token'])
    expect(get('/api/v1/series?match[]=' + encodeURIComponent('http_requests_total{service="auth",status="500"}')).data).toHaveLength(3)
    expect(get('/api/v1/series').errorType).toBe('bad_data')
    // The real API stores no metadata and always answers {}.
    expect(get('/api/v1/metadata').data).toEqual({})
    expect(get('/api/v1/status/buildinfo').data).toEqual({ version: 'viz-mock-0.1.0', revision: 'synthetic', branch: '', buildUser: '', buildDate: '', goVersion: '', mock: true })
  })
  it('counters are monotonic and histogram buckets are cumulative', () => {
    const r = get(`/api/v1/query_range?query=${encodeURIComponent('http_requests_total{service="checkout",route="/pay",status="200"}')}&start=${t - 3 * 86400}&end=${t}&step=3600`)
    const vals = r.data.result[0].values.map((v: [number, string]) => Number(v[1]))
    for (let i = 1; i < vals.length; i++) expect(vals[i]).toBeGreaterThanOrEqual(vals[i - 1])
    const b = get(`/api/v1/query?query=${encodeURIComponent('http_request_duration_seconds_bucket{service="orders"}')}&time=${t}`)
    const byLe = b.data.result
      .map((s: any) => [s.metric.le === '+Inf' ? Infinity : Number(s.metric.le), Number(s.value[1])])
      .sort((x: number[], y: number[]) => x[0]! - y[0]!)
    for (let i = 1; i < byLe.length; i++) expect(byLe[i][1]).toBeGreaterThanOrEqual(byLe[i - 1][1])
    const count = get(`/api/v1/query?query=${encodeURIComponent('http_request_duration_seconds_count{service="orders"}')}&time=${t}`)
    expect(byLe[byLe.length - 1][1]).toBe(Number(count.data.result[0].value[1]))
  })
  it('the histogram count equals the sum of the request counters', () => {
    const a = get(`/api/v1/query?query=${encodeURIComponent('sum(http_requests_total{service="auth"})')}&time=${t}`)
    const b = get(`/api/v1/query?query=${encodeURIComponent('http_request_duration_seconds_count{service="auth"}')}&time=${t}`)
    expect(Number(a.data.result[0].value[1])).toBe(Number(b.data.result[0].value[1]))
  })
  it('one pod has a real gap', () => {
    // Minute 50-62 of every even hour; SERIES_START is midnight UTC.
    const from = t + 40 * 60
    const r = get(`/api/v1/query_range?query=${encodeURIComponent('pod_cpu_usage_cores{pod="checkout-6b7f9-x2k4p"}')}&start=${from}&end=${from + 30 * 60}&step=60`)
    const ts = r.data.result[0].values.map((v: [number, string]) => (v[0] - t) / 60)
    // Present up to minute 49 (then 5 minutes of lookback), absent, present again from minute 62.
    expect(ts).toContain(54)
    expect(ts).not.toContain(56)
    expect(ts).not.toContain(61)
    expect(ts).toContain(62)
  })
  it('returns Prometheus-style errors', () => {
    const r = api.handle('POST', '/api/v1/query_range', `query=${encodeURIComponent('sum by (')}&start=${t - 60}&end=${t}&step=15`)
    expect(r.status).toBe(400)
    // No position: the real API gives none (README, "Needed changes in query/").
    expect(r.body).toEqual({ status: 'error', errorType: 'bad_data', error: 'parse error: unexpected end of input in grouping opts, expected label' })
    expect(api.handle('GET', `/api/v1/query_range?query=up&start=x&end=1&step=1`).status).toBe(400)
    expect(api.handle('GET', '/nope')).toMatchObject({ status: 404, body: { status: 'error', errorType: 'not_found', error: 'not found' } })
  })
})

describe('mock API: the real API\'s HTTP surface (e2e/contract.cjs checks it against the real one)', () => {
  const t = SERIES_START + 86400 * 30
  const api = createMockApi({ now: () => t, requireToken: 'good', readlessToken: 'readless' })
  const auth = { authorization: 'Bearer good' }
  const form = { 'content-type': 'application/x-www-form-urlencoded' }
  const range = (q: string) => `query=${encodeURIComponent(q)}&start=${t - 60}&end=${t}&step=15`

  it('takes the methods each endpoint takes, and says which with Allow', () => {
    expect(api.handle('DELETE', '/api/v1/query', '', auth)).toMatchObject({ status: 405, body: { errorType: 'method_not_allowed', error: 'method not allowed' }, headers: { Allow: 'GET, POST' } })
    expect(api.handle('POST', '/api/v1/metadata', '', auth)).toMatchObject({ status: 405, headers: { Allow: 'GET' } })
    expect(api.handle('POST', '/api/v1/label/job/values', '', auth)).toMatchObject({ status: 405, headers: { Allow: 'GET' } })
    expect(api.handle('GET', '/api/v1/status/flags', '', auth)).toMatchObject({ status: 404 })
  })
  it('refuses a missing or wrong key with 401 and a challenge, and a key without the read scope with 403', () => {
    expect(api.handle('GET', '/api/v1/status/buildinfo')).toMatchObject({ status: 401, body: { errorType: 'unauthorized', error: 'missing API key' }, headers: { 'WWW-Authenticate': 'Bearer realm="viz"' } })
    expect(api.handle('GET', '/api/v1/labels', '', { authorization: 'Bearer nope' })).toMatchObject({ status: 401, body: { error: 'invalid API key' } })
    expect(api.handle('GET', '/api/v1/labels', '', { authorization: 'Bearer readless' })).toMatchObject({ status: 403, body: { errorType: 'forbidden', error: 'API key lacks the read scope' } })
    // No cost headers on a refusal: nothing was asked of storage.
    expect(api.handle('GET', '/api/v1/labels').headers?.['X-Viz-Engine-Ms']).toBeUndefined()
  })
  it('sends the 28 cost headers on answers and on query errors', () => {
    const okRes = api.handle('POST', '/api/v1/query_range', range('up'), { ...auth, ...form })
    const bad = api.handle('POST', '/api/v1/query_range', range('up{'), { ...auth, ...form })
    for (const r of [okRes, bad]) {
      expect(Object.keys(r.headers ?? {}).filter((k) => k.startsWith('X-Viz-'))).toHaveLength(28)
      expect(r.headers?.['X-Viz-Execution']).toBe('single')
    }
  })
  it('answers 422 for the query-size and nesting limits and for PromQL it does not implement', () => {
    const big = api.handle('POST', '/api/v1/query_range', range('up' + ' + up'.repeat(5000)), { ...auth, ...form })
    expect(big).toMatchObject({ status: 422, body: { errorType: 'execution', error: 'query exceeded limit max_query_bytes: 25002 bytes of query text, the limit is 16384' } })
    const deep = api.handle('POST', '/api/v1/query_range', range('('.repeat(120) + 'up' + ')'.repeat(120)), { ...auth, ...form })
    expect(deep).toMatchObject({ status: 422, body: { errorType: 'execution' } })
    expect(api.handle('POST', '/api/v1/query_range', range('up and up'), { ...auth, ...form })).toMatchObject({ status: 422, body: { errorType: 'unsupported' } })
    expect(api.handle('POST', '/api/v1/query_range', range('no_such_fn(up)'), { ...auth, ...form })).toMatchObject({ status: 400, body: { error: "parse error: unknown function with name 'no_such_fn'" } })
    expect(api.handle('POST', '/api/v1/query_range', '', { ...auth, ...form })).toMatchObject({ status: 400, body: { error: 'invalid parameter "query": the query is empty' } })
    expect(api.handle('POST', '/api/v1/query', '{"query":"1"}', { ...auth, 'content-type': 'application/json' })).toMatchObject({ status: 400 })
  })
  it('writes every label set with sorted names, lists series in label order, and bounds label endpoints by start and end', () => {
    const r = api.handle('POST', '/api/v1/query', `query=${encodeURIComponent('up{service="auth"}')}&time=${t}`, { ...auth, ...form }).body as any
    for (const s of r.data.result) expect(Object.keys(s.metric)).toEqual([...Object.keys(s.metric)].sort())
    const instances = r.data.result.map((s: any) => s.metric.instance)
    expect(instances).toEqual([...instances].sort())
    const before = api.handle('GET', `/api/v1/label/__name__/values?start=${SERIES_START - 86400}&end=${SERIES_START - 3600}`, '', auth).body as any
    expect(before.data).toEqual([])
    const during = api.handle('GET', `/api/v1/label/__name__/values?start=${t - 60}&end=${t}`, '', auth).body as any
    expect(during.data).toContain('up')
  })
})
