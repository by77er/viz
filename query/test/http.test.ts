/**
 * The HTTP surface: Prometheus-compatible parameters, envelopes, status codes, CORS and
 * authentication, and a small Prometheus API client (test/client.ts, written from the API
 * documentation; the tests need nothing outside query/) run against the Worker.
 */
import { exports } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { PromApiError, PromClient } from './client'
import { makeKey } from '../../edge/test/helpers'
import { QUERIES, type World, api, cost, expected, flushAll, ingest, seriesIn, workload, world } from './world'

let w: World
const END = workload.end
const S = END - 20 * 60_000
const sec = (ms: number): string => String(ms / 1000)
const byId = (id: string) => QUERIES.find((q) => q.id === id)!
const sorted = (xs: string[]): string[] => [...new Set(xs)].sort()
/** Byte order, as the engine sorts label sets. */
const labelSets = (xs: Record<string, string>[]): Record<string, string>[] =>
  [...xs].sort((a, b) => {
    const [x, y] = [JSON.stringify(Object.entries(a).sort()), JSON.stringify(Object.entries(b).sort())]
    return x < y ? -1 : x > y ? 1 : 0
  })

beforeAll(async () => {
  w = await world()
  await ingest(w)
  await flushAll(w) // the first segment is in the lake, the second request in the tail
})

describe('query and query_range', () => {
  it('accepts unix seconds, fractional seconds and RFC 3339 for times, and seconds or durations for step', async () => {
    const q = byId('rate-sum-by')
    const want = expected.a[q.id]
    const forms: Record<string, string>[] = [
      { start: sec(S), end: sec(END), step: '30' },
      { start: `${S / 1000}.000`, end: `${END / 1000}.0004`, step: '30s' },
      { start: new Date(S).toISOString(), end: new Date(END).toISOString(), step: '0.5m'.replace('0.5m', '30.0') },
      { start: '2026-11-18T12:40:00+01:00', end: '2026-11-18T07:00:00.000-05:00', step: '30000ms' },
      { start: (S / 1000).toExponential(), end: sec(END), step: '0m30s' },
    ]
    for (const f of forms) {
      for (const method of ['GET', 'POST'] as const) {
        const res = await api(w.a.key, '/api/v1/query_range', { query: q.query, ...f }, { method })
        expect(await res.json(), JSON.stringify(f)).toEqual(want)
        expect(res.status).toBe(200)
      }
    }
    // A step of 15 s is not 15 ms and not 15 minutes.
    for (const step of ['15', '15s', '15.0', '0.25m'.replace('0.25m', '15000ms')]) {
      const res = await api(w.a.key, '/api/v1/query_range', { query: q.query, start: sec(S), end: sec(END), step })
      expect(await res.json(), step).toEqual(expected.a['step-15s'])
    }
    const m = await (await api(w.a.key, '/api/v1/query_range', { query: 'up', start: sec(END - 120_000), end: sec(END), step: '1m' })).json<{ data: { result: { values: unknown[] }[] } }>()
    expect(m.data.result[0]!.values).toHaveLength(3)
    const h = await (await api(w.a.key, '/api/v1/query_range', { query: 'up', start: sec(END - 7_200_000), end: sec(END), step: '1h' })).json<{ data: { result: { values: [number, string][] }[] } }>()
    expect(h.data.result[0]!.values.map((v) => v[0])).toEqual([END / 1000]) // only the last step has data
  })

  it('instant queries: time in any form, POST form bodies, URL and body parameters merged', async () => {
    const q = byId('i-earlier')
    for (const time of [sec(q.time!), new Date(q.time!).toISOString(), `${Math.floor(q.time! / 1000)}.5`]) {
      expect(await (await api(w.a.key, '/api/v1/query', { query: q.query, time })).json()).toEqual(expected.a[q.id])
      expect(await (await api(w.a.key, '/api/v1/query', { query: q.query, time }, { method: 'POST' })).json()).toEqual(expected.a[q.id])
    }
    // Prometheus merges the URL's parameters with the form body's.
    const res = await exports.default.fetch(`https://viz.test/api/v1/query?time=${sec(q.time!)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${w.a.key}`, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: new URLSearchParams({ query: q.query }).toString(),
    })
    expect(await res.json()).toEqual(expected.a[q.id])
    // No `time`: now. The workload ended long before or after now, so nothing is in the lookback.
    const now = await (await api(w.a.key, '/api/v1/query', { query: 'vector(1)' })).json<{ data: { result: { value: [number, string] }[] } }>()
    expect(Math.abs(now.data.result[0]!.value[0] - Date.now() / 1000)).toBeLessThan(60)
  })

  it('every result type has the shape of the Prometheus HTTP API documentation', async () => {
    const isSample = (v: unknown): boolean => Array.isArray(v) && v.length === 2 && typeof v[0] === 'number' && typeof v[1] === 'string'
    const check = async (id: string, type: string) => {
      const q = byId(id)
      const res = q.kind === 'range' ? await api(w.a.key, '/api/v1/query_range', { query: q.query, start: sec(q.start!), end: sec(q.end!), step: sec(q.step!) }) : await api(w.a.key, '/api/v1/query', { query: q.query, time: sec(q.time!) })
      const body = await res.json<{ status: string; data: { resultType: string; result: unknown } }>()
      expect(Object.keys(body).sort()).toEqual(['data', 'status'])
      expect(body.status).toBe('success')
      expect(Object.keys(body.data).sort()).toEqual(['result', 'resultType'])
      expect(body.data.resultType).toBe(type)
      const r = body.data.result
      if (type === 'matrix') {
        const list = r as { metric: Record<string, string>; values: unknown[] }[]
        expect(list.length).toBeGreaterThan(0)
        for (const s of list) {
          expect(Object.keys(s).sort()).toEqual(['metric', 'values'])
          expect(Object.values(s.metric).every((v) => typeof v === 'string')).toBe(true)
          expect(s.values.length).toBeGreaterThan(0)
          expect(s.values.every(isSample)).toBe(true)
        }
      } else if (type === 'vector') {
        const list = r as { metric: Record<string, string>; value: unknown }[]
        expect(list.length).toBeGreaterThan(0)
        for (const s of list) {
          expect(Object.keys(s).sort()).toEqual(['metric', 'value'])
          expect(isSample(s.value)).toBe(true)
        }
      } else expect(isSample(r)).toBe(true)
    }
    await check('rate-sum-by', 'matrix')
    await check('i-up', 'vector')
    await check('i-matrix', 'matrix')
    await check('i-scalar', 'scalar')
    await check('i-string', 'string')
    // Special values are spelled as Prometheus spells them.
    const special = await (await api(w.a.key, '/api/v1/query_range', { query: 'special', start: sec(S), end: sec(END), step: '15' })).text()
    expect(special).toContain('"+Inf"')
    expect(special).toContain('"-Inf"')
    expect(special).toContain('"NaN"')
  })

  it('errors use the Prometheus envelope, error types and status codes', async () => {
    const range = { start: sec(S), end: sec(END), step: '30' }
    const cases: [string, Record<string, string>, number, string, RegExp][] = [
      ['/api/v1/query', { query: 'sum(' }, 400, 'bad_data', /parse error/],
      ['/api/v1/query', {}, 400, 'bad_data', /invalid parameter "query"/],
      ['/api/v1/query', { query: 'up', time: 'yesterday' }, 400, 'bad_data', /invalid parameter "time": cannot parse "yesterday" to a valid timestamp/],
      ['/api/v1/query', { query: 'up', timeout: 'soon' }, 400, 'bad_data', /invalid parameter "timeout": cannot parse "soon" to a valid duration/],
      ['/api/v1/query', { query: 'up{job=~"("}' }, 400, 'bad_data', /regular expression|regex|parse/i],
      ['/api/v1/query_range', { query: 'up', ...range, start: 'x' }, 400, 'bad_data', /invalid parameter "start"/],
      ['/api/v1/query_range', { query: 'up', start: range.start, end: range.end }, 400, 'bad_data', /invalid parameter "step"/],
      ['/api/v1/query_range', { query: 'up', ...range, step: '0' }, 400, 'bad_data', /zero or negative query resolution step widths are not accepted/],
      ['/api/v1/query_range', { query: 'up', ...range, step: '-5s' }, 400, 'bad_data', /invalid parameter "step"/],
      ['/api/v1/query_range', { query: 'up', ...range, step: '5x' }, 400, 'bad_data', /cannot parse "5x" to a valid duration/],
      ['/api/v1/query_range', { query: 'up', ...range, step: '1s5m' }, 400, 'bad_data', /cannot parse "1s5m" to a valid duration/],
      ['/api/v1/query_range', { query: 'up', start: range.end, end: range.start, step: '30' }, 400, 'bad_data', /end timestamp must not be before start time/],
      ['/api/v1/query_range', { query: 'up', ...range, step: '0.1' }, 400, 'bad_data', /exceeded maximum resolution of 11000 points per timeseries/],
      ['/api/v1/query_range', { query: 'up + on (job) up', ...range }, 422, 'execution', /duplicate series|many-to-many/],
      ['/api/v1/query_range', { query: 'limitk(1, up)', ...range }, 422, 'unsupported', /limitk/],
      ['/api/v1/series', {}, 400, 'bad_data', /no match\[\] parameter provided/],
      ['/api/v1/series', { 'match[]': '{}' }, 400, 'bad_data', /at least one non-empty matcher/],
      ['/api/v1/series', { 'match[]': 'sum(up)' }, 400, 'bad_data', /not a series selector/],
      ['/api/v1/labels', { 'match[]': 'up{' }, 400, 'bad_data', /./],
      ['/api/v1/labels', { start: 'never' }, 400, 'bad_data', /invalid parameter "start"/],
      ['/api/v1/label/job/values', { start: sec(END), end: sec(S) }, 400, 'bad_data', /end timestamp must not be before start time/],
    ]
    for (const [path, params, status, type, message] of cases) {
      for (const method of path.includes('/label/') ? (['GET'] as const) : (['GET', 'POST'] as const)) {
        const res = await api(w.a.key, path, params, { method })
        const body = await res.json<{ status: string; errorType: string; error: string }>()
        expect([res.status, body.status, body.errorType], `${path} ${JSON.stringify(params)}`).toEqual([status, 'error', type])
        expect(body.error).toMatch(message)
        expect(Object.keys(body).sort()).toEqual(['error', 'errorType', 'status'])
        expect(res.headers.get('Content-Type')).toBe('application/json')
      }
    }
    // A body that is not a form.
    const res = await exports.default.fetch('https://viz.test/api/v1/query', { method: 'POST', headers: { Authorization: `Bearer ${w.a.key}`, 'Content-Type': 'application/json' }, body: '{"query":"up"}' })
    expect(res.status).toBe(400)
  })

  it('a timeout is 503 with errorType timeout, and the timeout parameter can only lower the limit', async () => {
    const { hooks } = await import('../src/coordinator')
    hooks.afterPlan = () => new Promise((r) => setTimeout(r, 300))
    try {
      const res = await api(w.a.key, '/api/v1/query', { query: 'up', time: sec(END), timeout: '50ms' })
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ status: 'error', errorType: 'timeout', error: 'query timed out' })
      // Long enough: answers. (A huge value is capped by the tenant's limit, not an error.)
      for (const timeout of ['5', '5s', '1h']) {
        const ok = await api(w.a.key, '/api/v1/query', { query: 'up', time: sec(END), timeout })
        expect(await ok.json()).toEqual(expected.a['i-up'])
      }
    } finally {
      delete hooks.afterPlan
    }
  })

  it('returns the cost of the query in response headers', async () => {
    const q = byId('rate-sum-by')
    const res = await api(w.a.key, '/api/v1/query_range', { query: q.query, start: sec(q.start!), end: sec(q.end!), step: sec(q.step!) })
    expect(await res.json()).toEqual(expected.a[q.id])
    const n = (name: string) => cost(res, name)
    expect(n('Files-Read')).toBeGreaterThanOrEqual(2)
    expect(n('Bytes-Read')).toBeGreaterThan(1000)
    expect(n('Shards-Asked')).toBe(2)
    expect(n('Shard-Calls')).toBe(2)
    expect(n('Tail-Batches')).toBeGreaterThanOrEqual(2)
    expect(n('Tail-Bytes')).toBeGreaterThan(1000)
    expect(n('Series-Loaded')).toBe(8)
    expect(n('Samples-Loaded')).toBeGreaterThan(8 * 80)
    expect(n('Scan-Samples')).toBeGreaterThan(0)
    expect(n('Plan-Attempts')).toBe(1)
    expect(n('Ledger-Version')).toBeGreaterThan(0)
    expect(n('Leaf-Calls')).toBeGreaterThanOrEqual(1)
    expect(n('Leaves-Used')).toBeGreaterThanOrEqual(1)
    expect(n('R2-Gets') + n('Cache-Hits')).toBe(n('Files-Read'))
    expect(n('Wasm-Memory-Bytes')).toBeGreaterThan(1 << 20)
    expect(Number.isInteger(n('Engine-Ms'))).toBe(true)
    // A query with no selector wakes nothing.
    const lit = await api(w.a.key, '/api/v1/query', { query: '1 + 1', time: sec(END) })
    expect([cost(lit, 'Plan-Attempts'), cost(lit, 'Shards-Asked'), cost(lit, 'Files-Read')]).toEqual([0, 0, 0])
    // Errors carry the cost up to the point of failure, too.
    const err = await api(w.a.key, '/api/v1/query', { query: 'up + on (job) up', time: sec(END) })
    expect(err.status).toBe(422)
    expect(cost(err, 'Shards-Asked')).toBe(2)
  })
})

describe('labels, label values and series', () => {
  const all = () => seriesIn('a')
  const names = (list: Record<string, string>[]) => sorted(list.flatMap((l) => Object.keys(l)))
  const values = (list: Record<string, string>[], name: string) => sorted(list.flatMap((l) => (name in l ? [l[name]!] : [])))
  const get = async <T>(path: string, params: Record<string, string> | [string, string][] = {}, method: 'GET' | 'POST' = 'GET'): Promise<T> => {
    const res = await api(w.a.key, path, params, { method })
    const body = await res.json<{ status: string; data: T }>()
    expect([res.status, body.status], path).toEqual([200, 'success'])
    return body.data
  }

  it('label names: all, by match[], by time window; GET and POST', async () => {
    for (const method of ['GET', 'POST'] as const) {
      expect(await get('/api/v1/labels', {}, method)).toEqual(names(all()))
      expect(await get('/api/v1/labels', { 'match[]': 'up' }, method)).toEqual(['__name__', 'instance', 'job'])
      expect(await get('/api/v1/labels', [['match[]', 'up'], ['match[]', 'temperature'], ['match[]', '{le="1"}']], method)).toEqual(['__name__', 'instance', 'job', 'le', 'room'])
    }
    expect(await get('/api/v1/labels', { start: sec(END + 1000), end: sec(END + 2000) })).toEqual([])
    expect(await get('/api/v1/labels', { 'match[]': 'no_such_metric' })).toEqual([])
  })

  it('label values, including __name__ and a name that needs escaping', async () => {
    expect(await get('/api/v1/label/__name__/values')).toEqual(values(all(), '__name__'))
    expect(await get('/api/v1/label/job/values')).toEqual(['api', 'private', 'shared', 'web'])
    expect(await get('/api/v1/label/le/values', { 'match[]': '{job="api"}' })).toEqual(['+Inf', '0.1', '0.5', '1'])
    expect(await get('/api/v1/label/instance/values', [['match[]', 'up{job="api"}'], ['match[]', 'shared_metric']])).toEqual(['i1:9100', 'i2:9100', 's1:9100'])
    expect(await get('/api/v1/label/no_such_label/values')).toEqual([])
    expect(await get(`/api/v1/label/${encodeURIComponent('weird/näme')}/values`)).toEqual([])
    // `up{job="web",instance="i2:9100"}` has samples only in the first 17.5 minutes and the last 6.5.
    const gap = { start: sec(workload.t0 + 72 * 15_000), end: sec(workload.t0 + 90 * 15_000) }
    expect(await get('/api/v1/label/instance/values', { 'match[]': 'up{job="web"}', ...gap })).toEqual(['i1:9100'])
    expect(await get('/api/v1/label/instance/values', { 'match[]': 'up{job="web"}' })).toEqual(['i1:9100', 'i2:9100'])
  })

  it('series: one or several match[], a window, GET and POST', async () => {
    const up = all().filter((l) => l.__name__ === 'up')
    for (const method of ['GET', 'POST'] as const) {
      expect(await get('/api/v1/series', { 'match[]': 'up' }, method)).toEqual(labelSets(up))
      const two = await get<Record<string, string>[]>('/api/v1/series', [['match[]', 'up{job="api"}'], ['match[]', '{__name__=~"temp.*"}']], method)
      expect(two).toEqual(labelSets(all().filter((l) => (l.__name__ === 'up' && l.job === 'api') || l.__name__ === 'temperature')))
    }
    expect(await get('/api/v1/series', { 'match[]': 'up', start: sec(END + 1), end: sec(END + 10) })).toEqual([])
    const everything = await get<Record<string, string>[]>('/api/v1/series', { 'match[]': '{__name__=~".+"}' })
    expect(everything).toEqual(labelSets(all()))
  })
})

describe('other endpoints, methods and CORS', () => {
  it('healthz needs no key; buildinfo and metadata have the documented shapes', async () => {
    const h = await api(null, '/healthz')
    expect([h.status, await h.text()]).toEqual([200, 'ok\n'])
    const b = await api(w.a.key, '/api/v1/status/buildinfo')
    const info = await b.json<{ status: string; data: Record<string, string> }>()
    expect(info.status).toBe('success')
    expect(Object.keys(info.data).sort()).toEqual(['branch', 'buildDate', 'buildUser', 'goVersion', 'revision', 'version'])
    expect(await (await api(w.a.key, '/api/v1/metadata')).json()).toEqual({ status: 'success', data: {} })
    expect((await api(null, '/api/v1/status/buildinfo')).status).toBe(401)
  })

  it('unknown paths are 404 and wrong methods 405, in the envelope', async () => {
    for (const path of ['/', '/api/v1', '/api/v1/query/', '/api/v2/query', '/api/v1/label/values', '/api/v1/label//values', '/api/v1/label/a/b/values', '/api/v1/targets', '/API/V1/QUERY']) {
      const res = await api(w.a.key, path, { query: 'up' })
      expect([path, res.status]).toEqual([path, 404])
      expect(await res.json()).toMatchObject({ status: 'error' })
    }
    for (const [path, method] of [['/api/v1/query', 'DELETE'], ['/api/v1/query_range', 'PUT'], ['/api/v1/label/job/values', 'POST'], ['/api/v1/series', 'DELETE'], ['/api/v1/status/buildinfo', 'POST']] as const) {
      const res = await exports.default.fetch(`https://viz.test${path}`, { method, headers: { Authorization: `Bearer ${w.a.key}` } })
      expect([path, res.status]).toEqual([path, 405])
      expect(res.headers.get('Allow')).toContain('GET')
    }
  })

  it('CORS: only origins on the allow-list are echoed; never a wildcard, never credentials', async () => {
    const q = { query: 'up', time: sec(END) }
    const allowed = await api(w.a.key, '/api/v1/query', q, { headers: { Origin: 'https://app.viz.test' } })
    expect(allowed.headers.get('Access-Control-Allow-Origin')).toBe('https://app.viz.test')
    expect(allowed.headers.get('Vary')).toBe('Origin')
    expect(allowed.headers.get('Access-Control-Expose-Headers')).toContain('X-Viz-Bytes-Read')
    expect(allowed.headers.get('Access-Control-Allow-Credentials')).toBeNull()
    for (const origin of ['https://evil.example', 'https://app.viz.test.evil.example', 'http://app.viz.test', 'null', '*']) {
      const res = await api(w.a.key, '/api/v1/query', q, { headers: { Origin: origin } })
      expect(res.status).toBe(200) // CORS is the browser's check; the key is ours
      expect(res.headers.get('Access-Control-Allow-Origin'), origin).toBeNull()
    }
    expect((await api(w.a.key, '/api/v1/query', q)).headers.get('Access-Control-Allow-Origin')).toBeNull()
    // Preflight: no key, answered from the allow-list.
    const pre = await exports.default.fetch('https://viz.test/api/v1/query_range', { method: 'OPTIONS', headers: { Origin: 'https://app.viz.test', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } })
    expect(pre.status).toBe(204)
    expect(pre.headers.get('Access-Control-Allow-Origin')).toBe('https://app.viz.test')
    expect(pre.headers.get('Access-Control-Allow-Headers')).toContain('Authorization')
    expect(pre.headers.get('Access-Control-Allow-Methods')).toContain('POST')
    const bad = await exports.default.fetch('https://viz.test/api/v1/query_range', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } })
    expect(bad.headers.get('Access-Control-Allow-Origin')).toBeNull()
    // Errors and refusals carry the headers too, or a browser could not read them.
    const denied = await api(null, '/api/v1/query', q, { headers: { Origin: 'https://app.viz.test' } })
    expect([denied.status, denied.headers.get('Access-Control-Allow-Origin')]).toEqual([401, 'https://app.viz.test'])
  })
})

describe('authentication', () => {
  const PATHS: [string, Record<string, string>][] = [
    ['/api/v1/query', { query: 'up' }],
    ['/api/v1/query_range', { query: 'up', start: '1', end: '2', step: '1' }],
    ['/api/v1/labels', {}],
    ['/api/v1/label/job/values', {}],
    ['/api/v1/series', { 'match[]': 'up' }],
    ['/api/v1/metadata', {}],
    ['/api/v1/status/buildinfo', {}],
  ]

  it('no key, a malformed key, an unknown key, a wrong secret and a disabled key are 401 on every endpoint', async () => {
    const disabled = await makeKey(w.a.name, { scopes: ['read'], disabled: true })
    const wrongSecret = `${w.a.key.slice(0, -4)}XXXX`
    for (const [path, params] of PATHS) {
      for (const key of [null, 'nonsense', 'viz_unknownkey_0123456789abcdef', wrongSecret, disabled]) {
        const res = await api(key, path, params)
        expect([path, res.status], String(key)).toEqual([path, 401])
        expect(res.headers.get('WWW-Authenticate')).toContain('Bearer')
        const body = await res.text()
        expect(JSON.parse(body)).toMatchObject({ status: 'error', errorType: 'unauthorized' })
        if (key) expect(body).not.toContain(key.split('_')[2]!) // the secret is never echoed
      }
    }
  })

  it('a key without the read scope is 403 on every endpoint, even though it can write', async () => {
    const writeOnly = await makeKey(w.a.name, { scopes: ['write'] })
    const none = await makeKey(w.a.name, { scopes: [] })
    for (const [path, params] of PATHS) {
      for (const key of [writeOnly, none]) {
        const res = await api(key, path, params)
        expect([path, res.status]).toEqual([path, 403])
        expect(await res.json()).toMatchObject({ status: 'error', errorType: 'forbidden', error: 'API key lacks the read scope' })
      }
    }
    // A read-only key reads, and cannot write.
    const readOnly = await makeKey(w.a.name, { scopes: ['read'] })
    expect(await (await api(readOnly, '/api/v1/query', { query: 'up', time: sec(END) })).json()).toEqual(expected.a['i-up'])
    const wr = await exports.default.fetch('https://viz.test/api/v1/write', { method: 'POST', headers: { Authorization: `Bearer ${readOnly}` }, body: new Uint8Array(1) })
    expect(wr.status).toBe(403)
  })

  it('accepts the key as the password of Basic auth, as Grafana sends it', async () => {
    const res = await api(null, '/api/v1/query', { query: 'up', time: sec(END) }, { headers: { Authorization: `Basic ${btoa(`anything:${w.a.key}`)}` } })
    expect(await res.json()).toEqual(expected.a['i-up'])
  })
})

describe('a Prometheus API client (test/client.ts, written from the API documentation) against the Worker', () => {
  const client = (key: string) => new PromClient({ baseUrl: 'https://viz.test', token: key, fetch: (input, init) => exports.default.fetch(input, init) })

  it('every call parses, and returns what the reference says', async () => {
    const c = client(w.a.key)
    const q = byId('rate-sum-by')
    const r = await c.queryRange(q.query, q.start! / 1000, q.end! / 1000, q.step! / 1000)
    expect(r.warnings).toEqual([])
    expect({ status: 'success', data: r.data }).toEqual(expected.a[q.id])
    for (const id of ['i-up', 'i-scalar', 'i-string', 'i-matrix']) {
      const i = byId(id)
      expect({ status: 'success', data: (await c.query(i.query, i.time! / 1000)).data }, id).toEqual(expected.a[id])
    }
    expect((await c.query('vector(1)')).data.resultType).toBe('vector')
    expect(await c.labels()).toContain('job')
    expect(await c.labels({ match: ['up'], start: S / 1000, end: END / 1000 })).toEqual(['__name__', 'instance', 'job'])
    expect(await c.labelValues('job')).toEqual(['api', 'private', 'shared', 'web'])
    expect(await c.labelValues('weird/name', { match: ['up', '{job="x"}'] })).toEqual([])
    expect(await c.series(['up'], { start: S / 1000, end: END / 1000 })).toHaveLength(4)
    expect(await c.metadata()).toEqual({})
    expect((await c.buildInfo()).version).toMatch(/viz/)
  })

  it('errors arrive as PromApiError with the error type and status', async () => {
    const c = client(w.a.key)
    await expect(c.query('sum(')).rejects.toMatchObject({ errorType: 'bad_data', status: 400 })
    await expect(c.queryRange('up + on (job) up', S / 1000, END / 1000, 30)).rejects.toMatchObject({ errorType: 'execution', status: 422 })
    const e = await client('viz_nokey_0123456789').query('up').catch((x) => x)
    expect(e).toBeInstanceOf(PromApiError)
    expect(e).toMatchObject({ errorType: 'unauthorized', status: 401 })
  })
})
