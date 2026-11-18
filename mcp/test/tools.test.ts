import { beforeAll, describe, expect, it } from 'vitest'
import { getSchema } from '../../dashboard/src/index.ts'
import { BASE, type Harness, type Key, NOW, controlCall, createDashboard, example, grantScope, harness, makeKey, mcp, newTenant, reset, rest, telemetry, type TestTenant } from './helpers'
import { monitorView } from './fake/services'
import { dataRegions } from '../src/untrusted'

/** Every tool's paths, against the fake query service and ruler and the REAL control plane. */

let h: Harness
let t: TestTenant
let agent: Key // read + dashboards:read/write, kind agent
let reader: Key // read only

beforeAll(async () => {
  reset()
  h = harness()
  t = await newTenant('tools')
  telemetry(h, t.tenant)
  agent = await makeKey(t.admin, ['read', 'dashboards:read', 'dashboards:write'], { kind: 'agent', name: 'tools agent' })
  reader = await makeKey(t.admin, ['read'], { kind: 'agent' })
  await createDashboard(t.admin, example('service_red'))
  await createDashboard(t.admin, example('k8s_node_overview'))
  h.ruler.monitors.set(t.tenant, [
    { view: monitorView({ id: 'mon_00000000000000a1', name: 'Checkout errors', state: 'firing', value: 0.06, firingSince: (NOW - 900) * 1000, thresholdText: '> 1% for 5m', expr: 'sum(rate(http_server_requests_total{status=~"5.."}[5m])) / sum(rate(http_server_requests_total[5m])) > 0.01', alerts: [{ fingerprint: 'f1', labels: { service: 'checkout' }, state: 'firing', activeAt: (NOW - 1200) * 1000, firingSince: (NOW - 900) * 1000, value: 0.06 }] }), history: [{ at: (NOW - 900) * 1000, kind: 'firing', value: 0.06 }] },
    { view: monitorView({ id: 'mon_00000000000000a2', name: 'Disk space', state: 'ok' }), history: [] },
  ])
})

const ok = (r: { status: number; isError: boolean; text: string }) => {
  if (r.isError || r.status !== 200) throw new Error(`expected success, got ${r.status}: ${r.text}`)
}

describe('search_telemetry', () => {
  it('finds metrics by words, with type, series and label cardinalities', async () => {
    const r = await rest(h, agent.key, 'search_telemetry', { q: 'http server requests' })
    ok(r)
    const top = r.structured.data.items[0]
    expect(top.name).toBe('http_server_requests_total')
    expect(top.type).toBe('counter')
    expect(top.series).toBeGreaterThan(0)
    expect(top.labels).toMatchObject({ env: 2, status: 4 })
    expect(r.text).toMatch(/http_server_requests_total \| counter \| unit none \| \d+ series \| labels env\(2\)/)
  })

  it('finds an entity (a service) and the metrics that carry it', async () => {
    const r = await rest(h, agent.key, 'search_telemetry', { q: 'checkout' })
    ok(r)
    const e = r.structured.data.entities.find((x: any) => x.label === 'service' && x.value === 'checkout')
    expect(e.metrics).toContain('http_server_requests_total')
  })

  it('offers near spellings when nothing matches', async () => {
    const r = await rest(h, agent.key, 'search_telemetry', { q: 'http_server_requets_totl' })
    ok(r)
    expect(r.structured.data.didYouMean).toContain('http_server_requests_total')
  })

  it('traces and logs are not available yet', async () => {
    const r = await rest(h, agent.key, 'search_telemetry', { q: 'x', signal: 'traces' })
    expect(r.status).toBe(501)
    expect(r.structured.error.code).toBe('not-available-yet')
  })
})

describe('describe_metric', () => {
  it('describes labels, values, type and examples', async () => {
    const r = await rest(h, agent.key, 'describe_metric', { name: 'http_server_requests_total' })
    ok(r)
    expect(r.structured.type).toBe('counter')
    expect(r.structured.typeSource).toBe('metadata')
    const status = r.structured.data.items.find((x: any) => x.label === 'status')
    expect(status.distinct).toBe(4)
    expect(r.structured.data.examples[0]).toMatch(/^sum by \(service\) \(rate\(http_server_requests_total\[5m\]\)\)$/)
  })

  it('infers a histogram from the name and gives a quantile example', async () => {
    const r = await rest(h, agent.key, 'describe_metric', { name: 'viz_shard_flush_duration_seconds_bucket' })
    ok(r)
    expect(r.structured.type).toBe('histogram')
    expect(r.structured.data.examples[0]).toMatch(/^histogram_quantile\(0\.95, sum by \(le\)/)
    expect(r.structured.data.unit).toBe('s')
  })

  it('an unknown name gets near spellings from this tenant', async () => {
    const r = await rest(h, agent.key, 'describe_metric', { name: 'http_server_request_total' })
    expect(r.status).toBe(404)
    expect(r.structured.error.code).toBe('unknown-metric')
    expect(r.structured.data.didYouMean[0]).toBe('http_server_requests_total')
    // The name and the suggestions are tenant data: inside the data block only.
    const [region] = dataRegions(r.text)
    expect(r.text.slice(region![0], region![1])).toMatch(/did you mean: http_server_requests_total/)
  })
})

describe('validate_query', () => {
  it('a valid query: types, counts per selector, an estimate, nothing run', async () => {
    const calls = h.prom.calls.length
    const r = await rest(h, agent.key, 'validate_query', { expr: 'sum by (service) (rate(http_server_requests_total{env="prod"}[5m]))' })
    ok(r)
    expect(r.structured.valid).toBe(true)
    expect(r.structured.resultType).toBe('vector')
    expect(r.structured.estimate.series).toBe(28)
    expect(r.structured.estimate.ran).toBe(false)
    expect(h.prom.calls.slice(calls).some((c) => c.path.includes('query'))).toBe(false)
  })

  it('a syntax error has a position and a caret', async () => {
    const r = await rest(h, agent.key, 'validate_query', { expr: 'sum(rate(http_server_requests_total[5m])' })
    ok(r)
    expect(r.structured.valid).toBe(false)
    const e = r.structured.data.items[0]
    expect(e.code).toBe('syntax')
    expect(e.position).toEqual({ offset: 40, line: 1, column: 41 })
    expect(e.caret).toMatch(/\^\n$/)
  })

  it('suggests functions, metric names and label names', async () => {
    const fn = await rest(h, agent.key, 'validate_query', { expr: 'rat(http_server_requests_total[5m])' })
    expect(fn.structured.data.items[0].suggestions).toContain('rate')
    const metric = await rest(h, agent.key, 'validate_query', { expr: 'rate(http_server_request_total[5m])' })
    const m = metric.structured.data.items.find((x: any) => x.code === 'unknown-metric')
    expect(m.suggestions[0]).toBe('http_server_requests_total')
    const label = await rest(h, agent.key, 'validate_query', { expr: 'rate(http_server_requests_total{servce="checkout"}[5m])' })
    expect(label.structured.data.items.find((x: any) => x.code === 'unknown-label').suggestions[0]).toBe('service')
  })

  it('warns about rate() on a gauge and histogram_quantile without le', async () => {
    const g = await rest(h, agent.key, 'validate_query', { expr: 'rate(node_load5[5m])' })
    expect(g.structured.data.items.map((x: any) => x.code)).toContain('rate-on-gauge')
    const le = await rest(h, agent.key, 'validate_query', { expr: 'histogram_quantile(0.9, sum by (route) (rate(http_server_request_duration_seconds_bucket[5m])))' })
    expect(le.structured.data.items.map((x: any) => x.code)).toContain('histogram-without-le')
  })

  it('TraceQL and LogQL are not available yet', async () => {
    for (const lang of ['traceql', 'logql']) {
      const r = await rest(h, agent.key, 'validate_query', { expr: '{ }', lang })
      expect(r.structured.error.code).toBe('not-available-yet')
    }
  })
})

describe('query', () => {
  it('returns a digest by default, never raw points, with completeness and an Explore link', async () => {
    const r = await rest(h, agent.key, 'query', { expr: 'sum by (service) (rate(http_server_requests_total{env="prod"}[5m]))', from: 'now-1h' })
    ok(r)
    expect(r.structured.format).toBe('digest')
    expect(r.structured.complete).toBe(true)
    expect(r.structured.seriesTotal).toBe(3)
    expect(r.text).toMatch(/3 series, \d+ outlier\(s\); complete\./)
    for (const item of r.structured.data.items) {
      expect(item).not.toHaveProperty('values')
      expect(item).not.toHaveProperty('points', expect.any(Array))
      expect(typeof item.last).toBe('number')
    }
    const link = new URL(r.structured.data.link)
    expect(link.origin + link.pathname).toBe('https://vis.bitcru.sh/explore')
    expect(link.searchParams.get('q')).toBe('sum by (service) (rate(http_server_requests_total{env="prod"}[5m]))')
    expect(Number(link.searchParams.get('to'))).toBe(NOW * 1000)
    expect(Number(link.searchParams.get('from'))).toBe((NOW - 3600) * 1000)
  })

  it('instant, scalar, table and series formats', async () => {
    const inst = await rest(h, agent.key, 'query', { expr: 'sum by (cell) (viz_shard_oldest_unflushed_seconds)', instant: true })
    ok(inst)
    expect(inst.structured.resultType).toBe('vector')
    const sc = await rest(h, agent.key, 'query', { expr: 'scalar(sum(kube_node_info))', instant: true })
    expect(sc.structured.data.items[0].value).toBe(4)
    const table = await rest(h, agent.key, 'query', { expr: 'viz_shard_oldest_unflushed_seconds', format: 'table' })
    expect(table.structured.data.items[0].values).toHaveLength(24)
    const raw = await rest(h, agent.key, 'query', { expr: 'viz_shard_oldest_unflushed_seconds', format: 'series', step: '1m', max_tokens: 400 })
    expect(raw.structured.truncated).toBe(true)
    expect(raw.structured.data.items[0].points.length).toBeLessThanOrEqual(60)
  })

  it('no data is said plainly', async () => {
    const r = await rest(h, agent.key, 'query', { expr: 'http_server_requests_total{service="nope"}' })
    ok(r)
    expect(r.text).toMatch(/No data: the query matched no series/)
  })

  it('a query the service rejects comes back with its message as data and a position', async () => {
    const r = await rest(h, agent.key, 'query', { expr: 'sum(rate(http_server_requests_total[5m]' })
    expect(r.status).toBe(400)
    expect(r.structured.error.code).toBe('query-failed')
    expect(r.text).toMatch(/```viz-data [0-9a-f]{8}\nerror \(bad_data\)/)
    expect(r.text).toMatch(/at 1:\d+:/)
  })

  it('more series than the limit: the largest are digested and the rest counted', async () => {
    const small = harness({ deps: { limits: { maxSeries: 5 } } })
    telemetry(small, t.tenant)
    const r = await rest(small, agent.key, 'query', { expr: 'http_server_requests_total' })
    ok(r)
    expect(r.structured.complete).toBe(false)
    expect(r.structured.seriesTotal).toBe(56)
    expect(r.structured.seriesDigested).toBe(5)
    expect(r.text).toMatch(/partial: 5 of 56 series digested/)
  })

  it('a slow query stops at the call deadline', async () => {
    const slow = harness({ prom: { delayMs: 5000 }, deps: { limits: { deadlineMs: 200 } } })
    telemetry(slow, t.tenant)
    const r = await rest(slow, agent.key, 'query', { expr: 'up' })
    expect(r.structured.error.code).toBe('query-failed')
    expect(r.text).toMatch(/\(timeout\)/)
  })
})

describe('search_dashboards, get_dashboard, list_revisions', () => {
  it('search lists the tenant\'s dashboards with who changed them', async () => {
    const r = await rest(h, agent.key, 'search_dashboards', {})
    ok(r)
    expect(r.structured.data.items.map((x: any) => x.id).sort()).toEqual(['k8s_node_overview', 'service_red'])
    const q = await rest(h, agent.key, 'search_dashboards', { q: 'kubernetes' })
    expect(q.structured.data.items.map((x: any) => x.id)).toEqual(['k8s_node_overview'])
  })

  it('search pages through the control plane\'s pages without loss', async () => {
    const seen: string[] = []
    let cursor: string | undefined
    do {
      const r = await rest(h, agent.key, 'search_dashboards', { limit: 1, ...(cursor ? { cursor } : {}) })
      ok(r)
      seen.push(...r.structured.data.items.map((x: any) => x.id))
      cursor = r.structured.cursor ?? undefined
      expect(seen.length).toBeLessThan(10)
    } while (cursor)
    expect(seen.sort()).toEqual(['k8s_node_overview', 'service_red'])
  })

  it('get_dashboard in three views, with the revision to write against', async () => {
    const outline = await rest(h, agent.key, 'get_dashboard', { id: 'service_red' })
    ok(outline)
    expect(outline.structured.view).toBe('outline')
    expect(outline.structured.revision).toMatch(/^[0-9a-f]{32}$/)
    expect(outline.text).toMatch(/panel error_ratio \| stat \| Error ratio \| unit ratio \| thresholds >0.001 warn, >0.01 crit/)
    const spec = await rest(h, agent.key, 'get_dashboard', { id: 'service_red', view: 'spec', max_tokens: 32000 })
    ok(spec)
    expect(spec.structured.truncated).toBe(false)
    expect(spec.structured.data.items.map((x: any) => x.path)).toContain('/panels/error_ratio')
    const resolved = await rest(h, agent.key, 'get_dashboard', { id: 'service_red', view: 'resolved', variables: { service: 'payments' } })
    expect(resolved.text).toMatch(/service=\\?"payments\\?"/)
  })

  it('unknown and malformed ids', async () => {
    const r = await rest(h, agent.key, 'get_dashboard', { id: 'nope' })
    expect(r.status).toBe(404)
    const bad = await rest(h, agent.key, 'get_dashboard', { id: 'Not An Id' })
    expect(bad.status).toBe(400)
    expect(bad.structured.error.code).toBe('invalid-arguments')
  })

  it('list_revisions says who did what', async () => {
    const cur = await rest(h, agent.key, 'get_dashboard', { id: 'k8s_node_overview', view: 'spec' })
    const patch = await controlCall(t.admin, 'PATCH', '/dashboards/k8s_node_overview', { ops: [{ op: 'replace', path: '/metadata/title', value: 'Kubernetes nodes' }], baseRevision: cur.structured.revision, message: 'Shorter title' })
    expect(patch.status).toBe(200)
    const r = await rest(h, agent.key, 'list_revisions', { id: 'k8s_node_overview' })
    ok(r)
    expect(r.structured.current).toBe(2)
    expect(r.structured.data.items[0]).toMatchObject({ number: 2, kind: 'patch', message: 'Shorter title' })
    expect(r.text).toMatch(/#2 [0-9a-f]{12} \|/)
  })
})

describe('get_schema and the schema resources', () => {
  it('pages concatenate to exactly the slice getSchema returns', async () => {
    let cursor: string | undefined
    let text = ''
    let pages = 0
    do {
      const r = await rest(h, reader.key, 'get_schema', { kind: 'dashboard', max_tokens: 1000, ...(cursor ? { cursor } : {}) })
      ok(r)
      for (const it of r.structured.data.items) text += it.text
      cursor = r.structured.cursor ?? undefined
      expect(++pages).toBeLessThan(200)
    } while (cursor)
    const s = getSchema('dashboard')
    expect(JSON.parse(text)).toEqual(JSON.parse(JSON.stringify({ schema: s.schema, example: s.example, units: s.units, builtins: s.builtins, catalog: s.catalog })))
    expect(pages).toBeGreaterThan(3)
  })
})

describe('monitors', () => {
  it('need monitors:read', async () => {
    const r = await rest(h, agent.key, 'list_monitors', {})
    expect(r.status).toBe(403)
    expect(r.structured.error.code).toBe('missing-scope')
  })

  it('list firing first, and get one with its alerts and history', async () => {
    const k = await makeKey(t.admin, ['read'], { kind: 'agent' })
    await grantScope(t, k, 'monitors:read')
    const list = await rest(h, k.key, 'list_monitors', {})
    ok(list)
    expect(list.structured.data.items.map((x: any) => x.state)).toEqual(['firing', 'ok'])
    expect(list.text).toMatch(/\[FIRING\] Checkout errors \(mon_00000000000000a1\) \| > 1% for 5m \| value 0.06/)
    const one = await rest(h, k.key, 'get_monitor', { id: 'mon_00000000000000a1' })
    ok(one)
    expect(one.structured.data.items[0]).toMatchObject({ state: 'firing', labels: { service: 'checkout' } })
    const missing = await rest(h, k.key, 'get_monitor', { id: 'mon_ffffffffffffffff' })
    expect(missing.status).toBe(404)
  })

  it('without a ruler binding they say so', async () => {
    const k = await makeKey(t.admin, ['read'], { kind: 'agent' })
    await grantScope(t, k, 'monitors:read')
    const none = harness({ deps: { monitors: () => null } })
    const r = await rest(none, k.key, 'list_monitors', {})
    expect(r.status).toBe(501)
    expect(r.structured.error.code).toBe('not-available-yet')
  })
})

describe('annotate', () => {
  it('is not available yet and writes nothing', async () => {
    const before = h.prom.calls.length
    const r = await rest(h, agent.key, 'annotate', { text: 'deploy 42' })
    expect(r.status).toBe(501)
    expect(r.structured.error.code).toBe('not-available-yet')
    expect(h.prom.calls.length).toBe(before)
  })
})

describe('the REST surface', () => {
  it('index lists tools with schemas, resources and prompts', async () => {
    const res = await h.fetch(new Request(`${BASE}/api/v1/agent`, { headers: { Authorization: `Bearer ${agent.key}` } }))
    const body = (await res.json()) as any
    expect(res.status).toBe(200)
    expect(body.tools.map((x: any) => x.name)).toContain('write_dashboard')
    expect(body.tools.find((x: any) => x.name === 'query').inputSchema.required).toEqual(['expr'])
    expect(body.prompts).toHaveLength(3)
  })

  it('refuses a tenant in the query string or the arguments', async () => {
    const res = await h.fetch(new Request(`${BASE}/api/v1/agent/tools/query?tenant=other`, { method: 'POST', headers: { Authorization: `Bearer ${agent.key}`, 'Content-Type': 'application/json' }, body: '{"expr":"up"}' }))
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).code).toBe('tenant-not-accepted')
    const r = await rest(h, agent.key, 'query', { expr: 'up', tenant: 'other' })
    expect(r.status).toBe(400)
    expect(r.text).toMatch(/\/tenant is not accepted: the tenant is always the one your credential belongs to/)
  })

  it('unknown tool, wrong method, not JSON', async () => {
    expect((await rest(h, agent.key, 'no_such_tool', {})).status).toBe(404)
    const get = await h.fetch(new Request(`${BASE}/api/v1/agent/tools/query`, { headers: { Authorization: `Bearer ${agent.key}` } }))
    expect(get.status).toBe(405)
    const txt = await h.fetch(new Request(`${BASE}/api/v1/agent/tools/query`, { method: 'POST', headers: { Authorization: `Bearer ${agent.key}`, 'Content-Type': 'text/plain' }, body: 'expr=up' }))
    expect(txt.status).toBe(415)
  })

  it('the MCP and REST surfaces give the same result for the same call', async () => {
    const a = await rest(h, agent.key, 'validate_query', { expr: 'rate(http_server_requests_total[5m])' })
    const b = await mcp(h, agent.key, 'validate_query', { expr: 'rate(http_server_requests_total[5m])' })
    expect(b.text).toBe(a.text)
    const strip = (x: any) => ({ ...x, usage: undefined })
    expect(strip(b.structured)).toEqual(strip(a.structured))
  })
})
