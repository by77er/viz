/**
 * The HTTP API: authentication and scopes, Prometheus' response shapes, agreement between
 * the routes and `openapi.json`, and tenant isolation on every route.
 */
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import spec from '../openapi.json'
import { promFloat, ROUTES } from '../src/http'
import { ALL_SCOPES, apiKey, call } from './api'
import { tenantWorld, world, T0 } from './harness'
import { MIN, newTenant, nextTick, notifierStub, ok, rulerStub, runNotifierUntil, vec } from './helpers'

const amConfig = {
  route: { receiver: 'hook', group_by: ['alertname'], group_wait: '0s', group_interval: '1m', repeat_interval: '4h' },
  receivers: [{ name: 'hook', webhook_configs: [{ url: 'https://receiver.test/hook' }] }],
}

/** Fill a path template with something that reaches the handler. */
const concrete = (path: string) => path.replace('{id}', 'mon_00000000000000aa').replace('{name}', 'some-group').replace('{silenceId}', 'abc')

describe('authentication and scopes (edge\'s API-key verification, imported)', () => {
  it('no key, a malformed key, a wrong secret and a disabled key are 401 on every route, with nothing but the reason', async () => {
    const tenant = newTenant('auth')
    const good = await apiKey(tenant)
    const disabled = await apiKey(tenant, ALL_SCOPES, { disabled: true })
    const wrongSecret = good.auth.replace(/_[^_]+$/, '_wrongwrongwrong')
    for (const r of ROUTES) {
      for (const auth of [null, 'Bearer nonsense', wrongSecret, disabled.auth, 'Basic !!!']) {
        const res = await call(auth, r.method, concrete(r.path), r.method === 'GET' || r.method === 'DELETE' ? undefined : {})
        expect(res.status, `${r.method} ${r.path} with ${auth}`).toBe(401)
        expect(res.headers.get('WWW-Authenticate')).toBe('Bearer realm="viz"')
        expect(res.text).not.toContain(tenant)
        if (r.prometheus) expect(res.json).toEqual({ status: 'error', errorType: 'unauthorized', error: expect.any(String) })
        else expect(res.json).toEqual({ error: { code: 'unauthorized', message: expect.any(String) } })
      }
    }
  })

  it('every route refuses a key that has every scope except the one it needs (403), and accepts a key that has only that one', async () => {
    const tenant = newTenant('scope')
    for (const r of ROUTES) {
      const without = await apiKey(tenant, [...ALL_SCOPES.filter((s) => s !== r.scope), 'read', 'write'])
      const body = r.method === 'GET' || r.method === 'DELETE' ? undefined : {}
      const refused = await call(without.auth, r.method, concrete(r.path), body)
      expect(refused.status, `${r.method} ${r.path}`).toBe(403)
      expect(refused.text).toContain(r.scope)
      const only = await apiKey(tenant, [r.scope])
      const allowed = await call(only.auth, r.method, concrete(r.path), body)
      expect([401, 403], `${r.method} ${r.path} -> ${allowed.status}`).not.toContain(allowed.status)
    }
  })

  it('a write needs monitors:write: a read-only key cannot create, update, delete, import or change the notifier', async () => {
    const tenant = newTenant('ro')
    const ro = await apiKey(tenant, ['monitors:read', 'monitors:ack'])
    const monitor = { name: 'M', query: 'q', condition: { op: '>', threshold: 1 } }
    expect((await call(ro.auth, 'POST', '/api/v1/monitors', monitor)).status).toBe(403)
    expect((await call(ro.auth, 'PUT', '/api/v1/monitors/groups/g', { rules: [{ alert: 'A', expr: 'up' }] })).status).toBe(403)
    expect((await call(ro.auth, 'POST', '/api/v1/monitors/rulefile', 'groups: []\n')).status).toBe(403)
    expect((await call(ro.auth, 'PUT', '/api/v1/monitors/notifier', amConfig)).status).toBe(403)
    // ...and nothing was created.
    expect((await call(ro.auth, 'GET', '/api/v1/monitors')).json.monitors).toEqual([])
    expect((await call(ro.auth, 'GET', '/api/v1/monitors/notifier')).json.config).toBeNull()
  })

  it('unknown paths are 404 and unsupported methods 405, before any key is looked at', async () => {
    expect((await call(null, 'GET', '/api/v1/nope')).status).toBe(404)
    expect((await call(null, 'GET', '/api/v1/monitors/not-an-id')).status).toBe(404)
    expect((await call(null, 'PATCH', '/api/v1/monitors')).status).toBe(405)
    expect((await call(null, 'POST', '/api/v1/rules')).status).toBe(405)
  })
})

describe('Prometheus-compatible, read-only: /api/v1/rules and /api/v1/alerts', () => {
  // Field lists transcribed from prometheus/web/api/v1/api.go (main, fetched 2026-11-18):
  // `RuleGroup`, `AlertingRule`, `RecordingRule`, `Alert`. `omitempty` fields are optional.
  const GROUP = ['name', 'file', 'rules', 'interval', 'limit', 'evaluationTime', 'lastEvaluation']
  const ALERTING = ['state', 'name', 'query', 'duration', 'keepFiringFor', 'labels', 'annotations', 'alerts', 'health', 'evaluationTime', 'lastEvaluation', 'type']
  const RECORDING = ['name', 'query', 'labels', 'health', 'evaluationTime', 'lastEvaluation', 'type']
  const ALERT = ['labels', 'annotations', 'state', 'activeAt', 'value']
  const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/
  const keys = (o: object, optional: string[] = []) => Object.keys(o).filter((k) => !optional.includes(k)).sort()

  async function scene() {
    world.now = T0
    const tenant = newTenant('prom')
    const stub = rulerStub(tenant)
    const w = tenantWorld(tenant)
    ok(await stub.configure(tenant, { deadman: false }))
    w.evaluate = (q) => {
      if (q === 'broken') throw new Error('engine: query timed out')
      if (q === 'rec') return vec([{ job: 'api' }, 3])
      if (q === 'held') return vec()
      return vec([{ instance: 'a', __name__: 'm' }, 0.75])
    }
    ok(await stub.saveGroups(tenant, {
      groups: [
        {
          name: 'example', interval: '1m', limit: 7,
          rules: [
            { alert: 'HighRequestLatency', expr: 'job:request_latency_seconds:mean5m{job="myjob"} > 0.5', for: '10m', keep_firing_for: '5m', labels: { severity: 'page' }, annotations: { summary: 'High request latency' } },
            { record: 'job:http_inprogress_requests:sum', expr: 'rec' },
            { alert: 'Broken', expr: 'broken' },
            { alert: 'Now', expr: 'now_expr', labels: { severity: 'ticket' } },
          ],
        },
        { name: 'quiet', interval: '5m', rules: [{ alert: 'Held', expr: 'held' }] },
      ],
    }))
    const key = await apiKey(tenant, ['monitors:read'])
    /** Run alarms until the group "example" has been evaluated once more; returns that evaluation time. */
    const tick = async (): Promise<number> => {
      const last = ok(await stub.snapshot(tenant)).groups.find((g) => g.name === 'example')!.lastEvaluationMs
      for (;;) {
        await nextTick(stub, tenant)
        const now = ok(await stub.snapshot(tenant)).groups.find((g) => g.name === 'example')!.lastEvaluationMs
        if (now !== last) return now as number
      }
    }
    return { tenant, stub, w, key, tick }
  }

  it('before the first evaluation: health unknown, zero times, empty alerts; the envelope is {status, data}', async () => {
    const { key } = await scene()
    const res = await call(key.auth, 'GET', '/api/v1/rules')
    expect(res.status).toBe(200)
    expect(Object.keys(res.json).sort()).toEqual(['data', 'status'])
    expect(res.json.status).toBe('success')
    const rule = res.json.data.groups[0].rules[0]
    expect(rule).toMatchObject({ state: 'inactive', health: 'unknown', alerts: [], evaluationTime: 0, lastEvaluation: '0001-01-01T00:00:00Z' })
    expect('lastError' in rule).toBe(false)
  })

  it('rules: exactly Prometheus\' fields and types for groups, alerting rules, recording rules and alerts', async () => {
    const { key, tick } = await scene()
    const t1 = await tick()
    const res = await call(key.auth, 'GET', '/api/v1/rules')
    const groups = res.json.data.groups as Record<string, unknown>[]
    expect(groups.map((g) => g.name)).toEqual(['example', 'quiet'])
    const g = groups[0] as { rules: Record<string, unknown>[] } & Record<string, unknown>
    expect(keys(g)).toEqual([...GROUP].sort())
    expect(g).toMatchObject({ name: 'example', file: 'shard-0', interval: 60, limit: 7 })
    expect(typeof g.evaluationTime).toBe('number')
    expect(g.lastEvaluation).toMatch(RFC3339)
    expect(Date.parse(g.lastEvaluation as string)).toBe(t1)

    const [high, rec, broken, now] = g.rules as [Record<string, unknown>, Record<string, unknown>, Record<string, unknown>, Record<string, unknown>]
    expect(keys(high, ['lastError'])).toEqual([...ALERTING].sort())
    expect(high).toMatchObject({
      state: 'pending', name: 'HighRequestLatency', query: 'job:request_latency_seconds:mean5m{job="myjob"} > 0.5',
      duration: 600, keepFiringFor: 300, labels: { severity: 'page' }, annotations: { summary: 'High request latency' }, health: 'ok', type: 'alerting',
    })
    expect('lastError' in high).toBe(false) // omitempty
    const alert = (high.alerts as Record<string, unknown>[])[0]!
    expect(keys(alert, ['keepFiringSince'])).toEqual([...ALERT].sort())
    expect(alert).toEqual({ labels: { alertname: 'HighRequestLatency', instance: 'a', severity: 'page' }, annotations: { summary: 'High request latency' }, state: 'pending', activeAt: new Date(t1).toISOString(), value: '7.5e-01' })

    expect(keys(rec, ['lastError'])).toEqual([...RECORDING].sort())
    expect(rec).toMatchObject({ name: 'job:http_inprogress_requests:sum', query: 'rec', labels: {}, health: 'ok', type: 'recording' })

    expect(broken).toMatchObject({ health: 'err', lastError: 'engine: query timed out', state: 'inactive', alerts: [] })
    expect(now).toMatchObject({ state: 'firing', duration: 0, keepFiringFor: 0 })
    expect(typeof now.evaluationTime).toBe('number')
    expect(Date.parse(now.lastEvaluation as string)).toBe(t1)

    // The documented example response (docs/querying/api.md, "Rules") uses these fields; all of them exist here with the same types.
    const documented = { alerts: [{ activeAt: 's', annotations: {}, labels: {}, state: 's', value: 's' }], annotations: {}, duration: 0, health: 's', labels: {}, name: 's', query: 's', type: 's' }
    for (const [k, v] of Object.entries(documented)) expect(typeof high[k], k).toBe(typeof v)
    for (const k of ['file', 'interval', 'limit', 'name', 'rules']) expect(k in g, k).toBe(true)
  })

  it('alerts: active alerts only, with state, activeAt and the value as Go prints it; a held alert carries keepFiringSince', async () => {
    const { w, key, tick } = await scene()
    const t1 = await tick()
    while (world.now < t1 + 10 * MIN) await tick()
    let res = await call(key.auth, 'GET', '/api/v1/alerts')
    expect(Object.keys(res.json.data)).toEqual(['alerts'])
    const alerts = res.json.data.alerts as Record<string, unknown>[]
    expect(alerts.map((a) => [(a.labels as Record<string, string>).alertname, a.state]).sort()).toEqual([['HighRequestLatency', 'firing'], ['Now', 'firing']])
    for (const a of alerts) {
      expect(keys(a, ['keepFiringSince'])).toEqual([...ALERT].sort())
      expect(a.activeAt).toMatch(RFC3339)
      expect(a.value).toBe('7.5e-01')
    }
    // The series goes away: `keep_firing_for` holds one alert (keepFiringSince appears); the other resolves and leaves the list.
    w.evaluate = () => vec()
    const gone = await tick()
    res = await call(key.auth, 'GET', '/api/v1/alerts')
    expect(res.json.data.alerts).toEqual([expect.objectContaining({ state: 'firing', keepFiringSince: new Date(gone).toISOString() })])
    const rules = await call(key.auth, 'GET', '/api/v1/rules')
    // A resolved alert that is only retained is not an active alert, and the rule is inactive.
    expect(rules.json.data.groups[0].rules[3]).toMatchObject({ name: 'Now', state: 'inactive', alerts: [] })
  })

  it('query parameters: type, rule_name[], rule_group[], file[], exclude_alerts, group_limit / group_next_token; match[] is refused, not ignored', async () => {
    const { key, tick } = await scene()
    await tick()
    const get = async (q: string) => (await call(key.auth, 'GET', `/api/v1/rules?${q}`)).json
    const names = (j: { data: { groups: { rules: { name: string }[] }[] } }) => j.data.groups.map((g) => g.rules.map((r) => r.name))
    expect(names(await get('type=alert'))).toEqual([['HighRequestLatency', 'Broken', 'Now'], ['Held']])
    expect(names(await get('type=record'))).toEqual([['job:http_inprogress_requests:sum']]) // a group left with no rules is not returned
    expect(names(await get('rule_name[]=Now&rule_name[]=Held'))).toEqual([['Now'], ['Held']])
    expect(names(await get('rule_group[]=quiet'))).toEqual([['Held']])
    expect(names(await get('file[]=shard-0')).length).toBe(2)
    expect(names(await get('file[]=elsewhere'))).toEqual([])
    const excluded = await get('exclude_alerts=true')
    expect(excluded.data.groups[0].rules[0].alerts).toBeNull() // Go's nil slice
    expect(excluded.data.groups[0].rules[0].state).toBe('pending')
    const page1 = await get('group_limit=1')
    expect(names(page1)).toEqual([['HighRequestLatency', 'job:http_inprogress_requests:sum', 'Broken', 'Now']])
    expect(typeof page1.data.groupNextToken).toBe('string')
    const page2 = await get(`group_limit=1&group_next_token=${page1.data.groupNextToken}`)
    expect(names(page2)).toEqual([['Held']])
    expect('groupNextToken' in page2.data).toBe(false)
    for (const bad of ['type=both', 'exclude_alerts=perhaps', 'match[]={severity="page"}', 'group_limit=0', 'group_next_token=abc', 'group_limit=1&group_next_token=00']) {
      const res = await call(key.auth, 'GET', `/api/v1/rules?${bad}`)
      expect(res.status, bad).toBe(400)
      expect(res.json, bad).toEqual({ status: 'error', errorType: 'bad_data', error: expect.any(String) })
    }
  })

  it('the value is formatted as strconv.FormatFloat(v, \'e\', -1, 64)', () => {
    expect([1, 0.5, 123.45, 0, -2, 1e21, 1.5e-7, 100, 1234567.891].map(promFloat)).toEqual(['1e+00', '5e-01', '1.2345e+02', '0e+00', '-2e+00', '1e+21', '1.5e-07', '1e+02', '1.234567891e+06'])
    expect([NaN, Infinity, -Infinity].map(promFloat)).toEqual(['NaN', '+Inf', '-Inf'])
  })

  it('the built-in watchdog rule is listed like any rule', async () => {
    const tenant = newTenant('dm')
    world.now = T0
    const stub = rulerStub(tenant)
    ok(await stub.configure(tenant, {}))
    await nextTick(stub, tenant)
    const key = await apiKey(tenant)
    const res = await call(key.auth, 'GET', '/api/v1/alerts')
    expect(res.json.data.alerts).toEqual([expect.objectContaining({ labels: { alertname: 'DeadMansSwitch', severity: 'none' }, state: 'firing', value: '1e+00' })])
  })
})

describe('routes and documentation agree (openapi.json)', () => {
  type Op = { operationId: string; security: Record<string, string[]>[]; parameters?: ({ $ref?: string; name?: string })[]; responses: Record<string, unknown>; requestBody?: unknown }
  const paths = spec.paths as unknown as Record<string, Record<string, Op>>

  it('is OpenAPI 3.1, and every route is documented with its method, scope and dryRun; nothing is documented that does not exist', () => {
    expect(spec.openapi).toMatch(/^3\.1\./)
    const documented = Object.entries(paths).flatMap(([path, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${path}`)).sort()
    expect(documented).toEqual(ROUTES.map((r) => `${r.method} ${r.path}`).sort())
    for (const r of ROUTES) {
      const op = paths[r.path]![r.method.toLowerCase()]!
      expect(op.security, `${r.method} ${r.path}`).toEqual([{ apiKey: [r.scope] }])
      const hasDryRun = (op.parameters ?? []).some((p) => p.$ref === '#/components/parameters/dryRun')
      expect(hasDryRun, `${r.method} ${r.path} dryRun`).toBe(r.dryRun)
      // Path parameters in the template are declared.
      for (const m of r.path.matchAll(/\{(\w+)\}/g)) {
        const declared = (op.parameters ?? []).some((p) => p.name === m[1] || (p.$ref !== undefined && (spec.components.parameters as Record<string, { name: string }>)[p.$ref.split('/').pop()!]!.name === m[1]))
        expect(declared, `${r.method} ${r.path} {${m[1]}}`).toBe(true)
      }
      expect(Object.keys(op.responses)).toEqual(expect.arrayContaining(['401', '403']))
      if (r.method === 'POST' || r.method === 'PUT') expect(op.requestBody, `${r.method} ${r.path} body`).toBeDefined()
    }
    const ids = Object.values(paths).flatMap((ops) => Object.values(ops).map((o) => o.operationId))
    expect(new Set(ids).size).toBe(ids.length)
    expect(Object.keys(spec.components.securitySchemes)).toEqual(['apiKey'])
  })

  it('every $ref resolves', () => {
    const refs = [...JSON.stringify(spec).matchAll(/"\$ref":"#\/([^"]+)"/g)].map((m) => m[1]!)
    expect(refs.length).toBeGreaterThan(50)
    for (const ref of refs) {
      let node: unknown = spec
      for (const part of ref.split('/')) node = (node as Record<string, unknown> | undefined)?.[part]
      expect(node, ref).toBeDefined()
    }
  })

  it('every documented route answers (no 404 for the route itself, no 405) and an undocumented one does not', async () => {
    const key = await apiKey(newTenant('doc'))
    for (const [path, ops] of Object.entries(paths)) {
      for (const method of Object.keys(ops)) {
        const res = await call(key.auth, method.toUpperCase(), concrete(path), method === 'get' || method === 'delete' ? undefined : {})
        expect(res.status, `${method} ${path}`).not.toBe(405)
        if (res.status === 404) expect(res.json.error.message, `${method} ${path}`).not.toBe('no such route')
      }
    }
    expect((await call(key.auth, 'GET', '/api/v1/monitors/silences/undo')).status).toBe(405)
    expect((await call(key.auth, 'GET', '/api/v2/monitors')).json.error.message).toBe('no such route')
  })

  it('the documented Prometheus schemas list the fields the handlers return', async () => {
    const schemas = spec.components.schemas as unknown as Record<string, { required: string[]; properties: Record<string, unknown> }>
    expect(schemas.PromRuleGroup!.required.sort()).toEqual(['evaluationTime', 'file', 'interval', 'lastEvaluation', 'limit', 'name', 'rules'])
    expect(schemas.PromAlertingRule!.required).toEqual(['state', 'name', 'query', 'duration', 'keepFiringFor', 'labels', 'annotations', 'alerts', 'health', 'evaluationTime', 'lastEvaluation', 'type'])
    expect(schemas.PromAlert!.required).toEqual(['labels', 'annotations', 'state', 'activeAt', 'value'])
  })
})

describe('tenant isolation on every route', () => {
  /** A tenant with monitors, a rule group, firing alerts, a silence and a notifier config, all created through the API. */
  async function populate(marker: string) {
    const tenant = newTenant(marker)
    const key = await apiKey(tenant)
    const w = tenantWorld(tenant)
    w.evaluate = () => vec([{ instance: `${marker}-host` }, 9])
    w.range = (_q, from) => ({ resultType: 'matrix', result: [{ metric: { instance: `${marker}-host` }, values: [[from / 1000, '9']] }] })
    const ruler = rulerStub(tenant)
    ok(await ruler.configure(tenant, { deadman: false }))
    expect((await call(key.auth, 'PUT', '/api/v1/monitors/notifier', { ...amConfig, receivers: [{ name: 'hook', webhook_configs: [{ url: `https://receiver.test/${marker}`, secret: `${marker}-secret-0123456789` }] }] })).status).toBe(200)
    const created = await call(key.auth, 'POST', '/api/v1/monitors', { name: `${marker}-latency`, query: `${marker}_metric`, condition: { op: '>', threshold: 1, unit: 'ms' }, notify: 'hook', message: `${marker} is slow`, owner: `${marker}-team` })
    expect(created.status).toBe(201)
    expect((await call(key.auth, 'PUT', `/api/v1/monitors/groups/${marker}-group`, { interval: '1m', rules: [{ alert: `${marker}-alert`, expr: `${marker}_up == 0` }, { record: `${marker}:rec`, expr: `${marker}_x` }] })).status).toBe(200)
    world.now = T0 + 5 * MIN
    await nextTick(ruler, tenant)
    await nextTick(ruler, tenant)
    await runNotifierUntil(notifierStub(tenant), tenant, world.now)
    const id = created.json.id as string
    const silenced = await call(key.auth, 'POST', `/api/v1/monitors/${id}/silence`, { duration: '1h', comment: `${marker} maintenance` })
    expect(silenced.status).toBe(200)
    expect(silenced.json.silences.length, JSON.stringify([silenced.json, (await call(key.auth, 'GET', `/api/v1/monitors/${id}`)).json])).toBe(1)
    const state = async () => {
      const got = await Promise.all(['/api/v1/monitors', `/api/v1/monitors/${id}`, '/api/v1/monitors/groups', '/api/v1/monitors/silences', '/api/v1/monitors/notifier', '/api/v1/rules', '/api/v1/alerts', '/api/v1/monitors/rulefile'].map((p) => call(key.auth, 'GET', p)))
      return got.map((r) => r.text.replace(/"nowMs":\d+/g, ''))
    }
    return { tenant, key, id, marker, silenceId: silenced.json.silences[0].id as string, undoToken: silenced.json.undoToken as string, fingerprint: silenced.json.silenced[0] as string, state }
  }

  it('a direct attempt on another tenant\'s monitor, group, silence or undo token finds nothing and changes nothing', async () => {
    const a = await populate('aaa')
    const b = await populate('bbb')
    const before = await b.state()
    expect((await call(a.key.auth, 'GET', `/api/v1/monitors/${b.id}`)).status).toBe(404)
    expect((await call(a.key.auth, 'PUT', `/api/v1/monitors/${b.id}`, { name: 'x', expr: 'up' })).status).toBe(404)
    expect((await call(a.key.auth, 'DELETE', `/api/v1/monitors/${b.id}`)).status).toBe(404)
    expect((await call(a.key.auth, 'POST', `/api/v1/monitors/${b.id}/acknowledge`, {})).status).toBe(404)
    expect((await call(a.key.auth, 'POST', `/api/v1/monitors/${a.id}/acknowledge`, { fingerprint: b.fingerprint })).status).toBe(404)
    expect((await call(a.key.auth, 'POST', `/api/v1/monitors/${b.id}/silence`, { duration: '1h' })).status).toBe(404)
    expect((await call(a.key.auth, 'DELETE', `/api/v1/monitors/groups/${b.marker}-group`)).status).toBe(404)
    expect((await call(a.key.auth, 'DELETE', `/api/v1/monitors/silences/${b.silenceId}`)).status).toBe(404)
    expect((await call(a.key.auth, 'POST', '/api/v1/monitors/silences/undo', { undoToken: b.undoToken })).status).toBe(404)
    expect(await b.state()).toEqual(before)
    // The token still works for its owner.
    expect((await call(b.key.auth, 'POST', '/api/v1/monitors/silences/undo', { undoToken: b.undoToken, dryRun: true })).status).toBe(200)
  })

  it('fuzz: whatever one tenant\'s key sends (the other tenant in paths, queries, headers and bodies), it never sees or changes the other tenant\'s data', async () => {
    const a = await populate('aaa')
    const b = await populate('bbb')
    const bBefore = await b.state()
    const secrets = [b.tenant, 'bbb-', 'bbb_', 'bbb:', b.id, b.silenceId, b.fingerprint, b.undoToken]
    const ids = [b.id, a.id, 'mon_ffffffffffffffff', 'r_0000000000000000']
    const groupNames = ['bbb-group', 'aaa-group', 'monitors/1m', encodeURIComponent(`../${b.tenant}/0`), b.tenant]
    const silenceIds = [b.silenceId, a.silenceId, 'nope']
    const queries = ['', `?tenant=${b.tenant}`, `?tenantId=${b.tenant}&dryRun=true`, `?orgId=${b.tenant}`, '?dryRun=true', `?filter=all&tenant=${b.tenant}`, `?rule_group[]=bbb-group&tenant=${b.tenant}`]
    const headers: Record<string, string>[] = [{}, { 'X-Scope-OrgID': b.tenant }, { 'X-Tenant': b.tenant, 'X-Viz-Tenant': b.tenant }, { 'CF-Worker': b.tenant, Host: `${b.tenant}.viz.test` }]
    const bodies = [
      {}, { tenant: b.tenant }, { dryRun: true, tenant: b.tenant }, { fingerprint: b.fingerprint }, { undoToken: b.undoToken, dryRun: true }, { duration: '1h', fingerprint: b.fingerprint, dryRun: true },
      { name: 'probe', query: 'bbb_metric', condition: { op: '>', threshold: 1 }, group: 'bbb-group', notify: 'hook', dryRun: true, tenant: b.tenant },
      { rules: [{ alert: 'probe', expr: 'bbb_up' }], tenant: b.tenant, dryRun: true }, { groups: [{ name: 'bbb-group', rules: [{ alert: 'P', expr: 'up' }] }], dryRun: true },
      { monitor: { name: 'p', expr: 'bbb_metric > 1' }, fromMs: T0, toMs: T0 + MIN, step: '1m', tenant: b.tenant }, { ...amConfig, dryRun: true, tenant: b.tenant },
    ]
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...ROUTES), fc.constantFrom(...ids), fc.constantFrom(...groupNames), fc.constantFrom(...silenceIds), fc.constantFrom(...queries), fc.constantFrom(...headers), fc.constantFrom(...bodies),
        async (route, id, group, silenceId, query, header, body) => {
          const path = route.path.replace('{id}', id).replace('{name}', group).replace('{silenceId}', silenceId) + query
          const res = await call(a.key.auth, route.method, path, route.method === 'GET' || route.method === 'DELETE' ? undefined : body, header)
          expect(res.status).toBeLessThan(500)
          for (const s of secrets) {
            // The request itself may echo what the caller sent in an error message (a group name it typed); what must never appear is B's stored data.
            if (res.text.includes(s) && !(path + JSON.stringify(body)).includes(s)) throw new Error(`leak of ${s} in ${route.method} ${path}: ${res.text.slice(0, 300)}`)
          }
          expect(res.text).not.toContain('bbb-secret')
          expect(res.text).not.toContain('bbb is slow')
          expect(res.text).not.toContain('bbb maintenance')
          expect(res.text).not.toContain('bbb-team')
          expect(res.text).not.toContain('bbb-host')
        },
      ),
      { numRuns: 400 },
    )
    expect(await b.state()).toEqual(bBefore)
    // The objects themselves refuse a foreign tenant, whoever calls them.
    for (const r of [await rulerStub(b.tenant).snapshot(a.tenant), await rulerStub(b.tenant).timeline(a.tenant, b.id), await rulerStub(b.tenant).saveRule(a.tenant, { name: 'g' }, { alert: 'A', expr: 'up' }),
      await rulerStub(b.tenant).exportGroup(a.tenant, 'bbb-group'), await rulerStub(b.tenant).releaseGroup(a.tenant, 'bbb-group'), await rulerStub(b.tenant).removeRule(a.tenant, 'bbb-group', b.id), await rulerStub(b.tenant).dropTimelines(a.tenant, [b.id]),
      await notifierStub(b.tenant).acknowledge(a.tenant, [b.fingerprint], 'x'), await notifierStub(b.tenant).unacknowledge(a.tenant, [b.fingerprint], 'x'), await notifierStub(b.tenant).silenceAlerts(a.tenant, [b.fingerprint], MIN, 'x', 'y'),
      await notifierStub(b.tenant).undoSilence(a.tenant, b.undoToken, 'x'), await notifierStub(b.tenant).describe(a.tenant, []), await notifierStub(b.tenant).notificationLog(a.tenant, b.id), await notifierStub(b.tenant).getConfig(a.tenant), await notifierStub(b.tenant).dropLogs(a.tenant, [b.id])]) {
      expect(r).toEqual({ status: 'wrong_tenant' })
    }
    expect(await b.state()).toEqual(bBefore)
  })
})
