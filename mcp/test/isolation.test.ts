import fc from 'fast-check'
import { beforeAll, describe, expect, it } from 'vitest'
import { BASE, type Harness, type Key, NOW, controlCall, controlFetcher, createDashboard, example, harness, makeKey, mcpClient, newTenant, reset, rest, snapshot, telemetry, type TestTenant } from './helpers'
import { httpControlClient } from '../src/clients'
import { monitorView } from './fake/services'
import { TOOLS } from '../src/registry'

/**
 * Tenant isolation through every tool, resource and prompt. Tenant A holds one of
 * everything, each carrying the marker ALPHA-SECRET (or alpha_secret). Tenant B's agent, with
 * every scope, calls everything with A's identifiers, hostile strings and fuzzed arguments,
 * and tries to name A as its tenant. Nothing of A may come back, A must be unchanged, and
 * every downstream request made for B must have been B's.
 */

let h: Harness
let A: TestTenant
let B: TestTenant
let bKey: Key
let aKey: Key
let aProposal: string
const A_MONITOR = 'mon_a1a1a1a1a1a1a1a1'
const A_DASH = 'alpha_secret_board'
const A_METRIC = 'alpha_secret_orders_total'
/** In every string of A's data; B never sends it. */
const ONLY_A = 'Zq7xAlphaOnly'
/**
 * What of A an answer to B contains. A marker counts only if B's own request did not
 * contain it: echoing what the caller sent is not a leak, but A's metric name coming back as
 * a suggestion for a misspelling, or A's tenant id, is.
 */
const leaks = (output: string, a: TestTenant, request = ''): string[] =>
  [ONLY_A, a.tenant, A_METRIC, A_DASH, A_MONITOR, aProposal ?? 'p_never'].filter((m) => output.includes(m) && !request.includes(m))

beforeAll(async () => {
  reset()
  h = harness()
  A = await newTenant('alpha')
  B = await newTenant('beta')
  const ta = telemetry(h, A.tenant)
  ta.add({ __name__: A_METRIC, customer: `ALPHA-SECRET-customer-${ONLY_A}` }, () => 5, 'counter')
  ta.setMeta(A_METRIC, 'counter', `ALPHA-SECRET orders ${ONLY_A}`)
  const tb = telemetry(h, B.tenant)
  tb.add({ __name__: 'beta_widgets_total', customer: 'beta-customer' }, () => 2, 'counter')
  const spec = example('service_red', A_DASH)
  spec.metadata.title = `ALPHA-SECRET board ${ONLY_A}`
  await createDashboard(A.admin, spec)
  aKey = await makeKey(A.admin, ['read', 'dashboards:read', 'dashboards:write', 'monitors:read'], { kind: 'agent' })
  const base = (await controlCall(A.admin, 'GET', `/dashboards/${A_DASH}`)).body.revision
  const p = await controlCall(aKey.key, 'POST', `/dashboards/${A_DASH}/proposals`, { message: `ALPHA-SECRET proposal ${ONLY_A}`, baseRevision: base, changes: [{ name: 'x', reason: `ALPHA-SECRET reason ${ONLY_A}`, ops: [{ op: 'replace', path: '/metadata/title', value: `ALPHA-SECRET 2 ${ONLY_A}` }] }] })
  aProposal = p.body.proposal.id
  h.ruler.monitors.set(A.tenant, [{ view: monitorView({ id: A_MONITOR, name: `ALPHA-SECRET monitor ${ONLY_A}`, state: 'firing' }), history: [] }])
  h.ruler.monitors.set(B.tenant, [{ view: monitorView({ id: 'mon_b2b2b2b2b2b2b2b2', name: 'beta monitor' }), history: [] }])
  await createDashboard(B.admin, example('k8s_node_overview'))
  bKey = await makeKey(B.admin, ['read', 'dashboards:read', 'dashboards:write', 'dashboards:apply', 'monitors:read'], { kind: 'agent' })
})

/** Calls with A's identifiers, made with B's key. */
const TARGETED: [string, Record<string, unknown>][] = [
  ['search_telemetry', { q: 'alpha secret orders' }],
  ['search_telemetry', { q: A_METRIC }],
  ['describe_metric', { name: A_METRIC }],
  ['validate_query', { expr: `rate(${A_METRIC}[5m])` }],
  ['validate_query', { expr: 'rate(alpha_secret_order_total[5m])' }],
  ['query', { expr: A_METRIC }],
  ['query', { expr: `{customer="ALPHA-SECRET-customer"}` }],
  ['query', { expr: `count({__name__=~".+"})`, instant: true }],
  ['search_dashboards', { q: 'ALPHA' }],
  ['search_dashboards', {}],
  ['get_dashboard', { id: A_DASH }],
  ['get_dashboard', { id: A_DASH, view: 'spec' }],
  ['list_revisions', { id: A_DASH }],
  ['read_dashboard', { id: A_DASH }],
  ['write_dashboard', { id: A_DASH, ops: [{ op: 'replace', path: '/metadata/title', value: 'x' }] }],
  ['write_dashboard', { id: A_DASH, mode: 'propose', base_revision: '0'.repeat(32), ops: [{ op: 'replace', path: '/metadata/title', value: 'x' }] }],
  ['write_dashboard', { id: A_DASH, mode: 'apply', base_revision: '0'.repeat(32), ops: [{ op: 'replace', path: '/metadata/title', value: 'x' }] }],
  ['list_monitors', {}],
  ['get_monitor', { id: A_MONITOR }],
  ['get_schema', {}],
  ['annotate', { text: 'x', dashboard: A_DASH }],
]

describe('B cannot see or touch A', () => {
  it('every tool, with A\'s identifiers: nothing of A comes back, A is unchanged, downstream calls were B\'s', async () => {
    expect(new Set(TARGETED.map(([t]) => t))).toEqual(new Set(TOOLS.map((t) => t.name)))
    const before = await snapshot(A)
    const promBefore = h.prom.calls.length
    const rulerBefore = h.ruler.calls.length
    for (const [tool, args] of TARGETED) {
      const r = await rest(h, bKey.key, tool, args)
      const all = r.text + JSON.stringify(r.structured)
      expect(leaks(all, A, JSON.stringify(args)), `${tool} ${JSON.stringify(args)}`).toEqual([])
      expect([500, 502, 503]).not.toContain(r.status)
    }
    expect(await snapshot(A)).toBe(before)
    expect(h.prom.calls.slice(promBefore).every((c) => c.tenant === B.tenant)).toBe(true)
    expect(h.ruler.calls.slice(rulerBefore).every((c) => c.tenant === B.tenant)).toBe(true)
  })

  it('A\'s dashboard, proposal and monitor ids do not resolve for B', async () => {
    expect((await rest(h, bKey.key, 'get_dashboard', { id: A_DASH })).status).toBe(404)
    expect((await rest(h, bKey.key, 'read_dashboard', { id: A_DASH })).status).toBe(404)
    expect((await rest(h, bKey.key, 'get_monitor', { id: A_MONITOR })).status).toBe(404)
    const list = await rest(h, bKey.key, 'list_monitors', {})
    expect(list.structured.data.items.map((m: any) => m.id)).toEqual(['mon_b2b2b2b2b2b2b2b2'])
  })

  it('no tool takes a tenant: the argument, the query string and tenant-looking headers', async () => {
    for (const t of TOOLS) {
      const r = await rest(h, bKey.key, t.name, { tenant: A.tenant })
      expect(r.status, t.name).toBe(400)
      expect(r.structured.error.code).toBe('invalid-arguments')
    }
    const q = await h.fetch(new Request(`${BASE}/mcp?tenant=${A.tenant}`, { method: 'POST', headers: { Authorization: `Bearer ${bKey.key}`, 'Content-Type': 'application/json' }, body: '{}' }))
    expect(q.status).toBe(400)
    for (const header of ['X-Viz-Tenant', 'X-Scope-OrgID', 'X-Tenant']) {
      const r = await rest(h, bKey.key, 'search_dashboards', {}, { [header]: A.tenant })
      expect(r.structured.data.items.map((d: any) => d.id)).toEqual(['k8s_node_overview'])
    }
  })

  it('did-you-mean never offers another tenant\'s names, even with A\'s names cached in this isolate', async () => {
    // A warms the per-isolate names cache.
    const warm = await rest(h, aKey.key, 'validate_query', { expr: 'rate(alpha_secret_order_total[5m])' })
    expect(warm.structured.data.items.find((i: any) => i.code === 'unknown-metric').suggestions).toContain(A_METRIC)
    for (const headers of [{}, { 'X-Viz-Tenant': A.tenant }, { 'X-Scope-OrgID': A.tenant }] as Record<string, string>[]) {
      const v = await rest(h, bKey.key, 'validate_query', { expr: 'rate(alpha_secret_order_total[5m])' }, headers)
      expect(leaks(v.text + JSON.stringify(v.structured), A)).toEqual([])
      expect(v.structured.data.items.find((i: any) => i.code === 'unknown-metric').suggestions ?? []).not.toContain(A_METRIC)
      const s = await rest(h, bKey.key, 'search_telemetry', { q: 'alpha_secret_order_total' }, headers)
      expect(leaks(s.text + JSON.stringify(s.structured), A)).toEqual([])
      const d = await rest(h, bKey.key, 'describe_metric', { name: 'alpha_secret_order_total' }, headers)
      expect(leaks(d.text + JSON.stringify(d.structured), A)).toEqual([])
      const w = await rest(h, bKey.key, 'write_dashboard', { id: 'k8s_node_overview', ops: [{ op: 'add', path: '/queries/z', value: { lang: 'promql', expr: 'rate(alpha_secret_order_total[5m])' } }, { op: 'add', path: '/panels/z', value: { kind: 'stat', title: 'z', description: 'z', unit: 'none', queries: ['z'] } }, { op: 'add', path: '/layout/items/-', value: { panel: 'z', x: 0, y: 30, w: 4, h: 4 } }] }, headers)
      expect(w.status).toBe(200)
      expect(leaks(w.text + JSON.stringify(w.structured), A, 'alpha_secret_order_total')).toEqual([])
    }
  })

  it('resources and prompts, over MCP: A\'s dashboard is not readable, nothing of A appears', async () => {
    const client = await mcpClient(h, bKey.key)
    await expect(client.readResource({ uri: `viz://dashboards/${A_DASH}` })).rejects.toThrow()
    for (const r of (await client.listResources()).resources) {
      const read = await client.readResource({ uri: r.uri })
      expect(leaks(JSON.stringify(read), A)).toEqual([])
    }
    for (const p of (await client.listPrompts()).prompts) {
      const args = Object.fromEntries((p.arguments ?? []).map((a) => [a.name, A_DASH]))
      const got = await client.getPrompt({ name: p.name, arguments: args })
      // The prompt echoes only what B sent; it reads nothing of A.
      expect(leaks(JSON.stringify(got), A, A_DASH)).toEqual([])
    }
    const tools = await client.listTools()
    expect(leaks(JSON.stringify(tools), A)).toEqual([])
    await client.close()
  })

  it('fuzz: random tools and arguments from A\'s identifiers and hostile strings never return A\'s data', async () => {
    const before = await snapshot(A)
    const promBefore = h.prom.calls.length
    const ids = [A_DASH, A_MONITOR, A_METRIC, aProposal, A.tenant, 'error_ratio', 'k8s_node_overview', 'service_red', 'mon_b2b2b2b2b2b2b2b2', '../' + A.tenant, `${A_DASH}/../${A_DASH}`, '%2e%2e', '*', '.*', '']
    const values = fc.oneof(fc.constantFrom(...ids), fc.string({ maxLength: 40 }), fc.integer({ min: -5, max: 5000 }), fc.boolean(), fc.constant(null), fc.constantFrom(`{customer=~"ALPHA.*"}`, `{__name__=~"alpha.*"}`, `${A_METRIC}{customer="ALPHA-SECRET-customer"}`))
    const argNames = ['id', 'name', 'q', 'expr', 'view', 'revision', 'panels', 'mode', 'base_revision', 'cursor', 'filter', 'kind', 'from', 'to', 'format', 'instant', 'max_tokens', 'tenant', 'variables', 'ops']
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...TOOLS.map((t) => t.name)), fc.dictionary(fc.constantFrom(...argNames), values, { maxKeys: 4 }), fc.constantFrom<Record<string, string>>({}, { 'X-Viz-Tenant': A.tenant }), async (tool, args, headers) => {
        const r = await rest(h, bKey.key, tool, args, headers)
        expect([500, 502, 503]).not.toContain(r.status)
        expect(leaks(r.text + JSON.stringify(r.structured), A, JSON.stringify(args)), `${tool} ${JSON.stringify(args)}`).toEqual([])
      }),
      { numRuns: 300 },
    )
    expect(await snapshot(A)).toBe(before)
    expect(h.prom.calls.slice(promBefore).every((c) => c.tenant === B.tenant)).toBe(true)
  })
})

describe('credentials', () => {
  it('a disabled key stops at once (the control plane is asked on every call)', async () => {
    const k = await makeKey(B.admin, ['read'], { kind: 'agent' })
    expect((await rest(h, k.key, 'get_schema', {})).status).toBe(200)
    await controlCall(B.admin, 'POST', `/keys/${k.id}/disable`)
    const r = await rest(h, k.key, 'get_schema', {})
    expect(r.status).toBe(401)
  })

  it('a key that is in KV but not in the control plane is refused: control issues monitors:read, so it is asked and says the key is not live', async () => {
    const keyId = 'edgeonly' + NOW
    const secret = 'S'.repeat(40)
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret)))].map((b) => b.toString(16).padStart(2, '0')).join('')
    const { env } = await import('cloudflare:test')
    await env.CONFIG.put(`key:${keyId}`, JSON.stringify({ tenant: B.tenant, secretSha256: digest, scopes: ['monitors:read'] }))
    const key = `viz_${keyId}_${secret}`
    for (const tool of ['list_monitors', 'search_dashboards', 'get_schema']) expect((await rest(h, key, tool, {})).status, tool).toBe(401)
  })

  it('a control release that does not know the key\'s scopes (403 no-scopes, as an older one could during a deploy): read as an agent with edge\'s scopes, which may not apply', async () => {
    const k = await makeKey(B.admin, ['read', 'dashboards:read', 'dashboards:write', 'dashboards:apply', 'monitors:read'], { kind: 'key', name: 'person with every scope' })
    const older = harness({
      deps: {
        control: (_e, auth) => {
          const real = httpControlClient(controlFetcher, auth)
          return { call: async (method, path, opts) => (path === '/whoami' ? { status: 403, body: { code: 'no-scopes' } } : real.call(method, path, opts)) }
        },
      },
    })
    for (const [k2, v] of h.prom.storages) older.prom.storages.set(k2, v)
    for (const [k2, v] of h.ruler.monitors) older.ruler.monitors.set(k2, v)
    const r = await rest(older, k.key, 'list_monitors', {})
    expect(r.status).toBe(200)
    expect(r.structured.data.items.map((m: any) => m.id)).toEqual(['mon_b2b2b2b2b2b2b2b2'])
    // edge's scopes, but the kind and the right to apply were not confirmed: apply is refused, nothing written
    const before = await snapshot(B)
    const base = (await controlCall(B.admin, 'GET', '/dashboards/k8s_node_overview')).body.revision
    const apply = await rest(older, k.key, 'write_dashboard', { id: 'k8s_node_overview', mode: 'apply', base_revision: base, ops: [{ op: 'replace', path: '/metadata/title', value: 'x' }] })
    expect(apply.status).toBe(403)
    expect(apply.structured.error.code).toBe('apply-refused')
    expect(apply.text).toMatch(/did not say whether this key may apply/)
    expect(await snapshot(B)).toBe(before)
  })
})
