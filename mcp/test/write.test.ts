import { beforeAll, describe, expect, it } from 'vitest'
import { type Harness, type Key, controlCall, createDashboard, example, harness, makeKey, newTenant, reset, rest, setAgentsMayApply, snapshot, telemetry, type TestTenant } from './helpers'

/**
 * write_dashboard against the REAL control plane: dry runs write nothing and preview the
 * changed panels; proposals carry named changes; agents cannot apply unless the tenant
 * allows it, and the refusal offers to propose.
 */

let h: Harness
let t: TestTenant
let agent: Key // dashboards:write + read, kind agent
let agentApply: Key // dashboards:write + dashboards:apply + read, kind agent
let person: Key // the same scopes, kind key ("Dana")

beforeAll(async () => {
  reset()
  h = harness()
  t = await newTenant('write')
  telemetry(h, t.tenant)
  agent = await makeKey(t.admin, ['read', 'dashboards:read', 'dashboards:write'], { kind: 'agent', name: 'writer agent' })
  agentApply = await makeKey(t.admin, ['read', 'dashboards:read', 'dashboards:write', 'dashboards:apply'], { kind: 'agent', name: 'apply agent' })
  person = await makeKey(t.admin, ['read', 'dashboards:read', 'dashboards:write', 'dashboards:apply'], { kind: 'key', name: 'Dana' })
  await createDashboard(t.admin, example('service_red'))
})

const revisionOf = async (id: string) => (await controlCall(t.admin, 'GET', `/dashboards/${id}`)).body.revision as string

const panel = (expr: string) => ({
  kind: 'stat',
  title: 'Checkout 5xx per second',
  description: 'Server errors per second for checkout in prod. Above 1 per second someone should look.',
  unit: 'errors/s',
  queries: ['checkout_5xx'],
  thresholds: [{ above: 1, level: 'warn' }],
})
const addPanelOps = (expr: string) => [
  { op: 'add', path: '/queries/checkout_5xx', value: { lang: 'promql', expr } },
  { op: 'add', path: '/panels/checkout_5xx', value: panel(expr) },
  { op: 'add', path: '/layout/rows/0/items/-', value: 'checkout_5xx' },
]
const GOOD = 'sum(rate(http_server_requests_total{env="prod",service="checkout",status=~"5.."}[5m]))'
const WRONG = 'sum(rate(http_server_request_total{env="prod",service="checkout",status=~"5.."}[5m]))'

describe('dry_run (the default)', () => {
  it('writes nothing, whoever calls it', async () => {
    for (const k of [agent, agentApply, person]) {
      const before = await snapshot(t)
      const r = await rest(h, k.key, 'write_dashboard', { id: 'service_red', ops: addPanelOps(GOOD) })
      expect(r.status).toBe(200)
      expect(r.structured.mode).toBe('dry_run')
      expect(r.text).toMatch(/Outcome: nothing was written/)
      expect(await snapshot(t)).toBe(before)
    }
  })

  it('validates, lints, summarises the diff and previews the new panel with its data', async () => {
    const r = await rest(h, agent.key, 'write_dashboard', { id: 'service_red', ops: addPanelOps(GOOD) })
    expect(r.structured.valid).toBe(true)
    expect(r.structured.counts.previewed).toBe(1)
    const pv = r.structured.data.items.find((x: any) => x.preview)?.preview
    expect(pv.id).toBe('checkout_5xx')
    expect(pv.noData).toBe(false)
    expect(pv.seriesCount).toBe(1)
    expect(r.structured.data.items.some((x: any) => typeof x.diff === 'string' && x.diff.includes('checkout_5xx'))).toBe(true)
    // An agent key without dashboards:apply: the control plane would turn an apply into a proposal.
    expect(r.text).toMatch(/this key may not apply here/)
    expect(r.structured.wouldApply).toBe(false)
    const p = await rest(h, person.key, 'write_dashboard', { id: 'service_red', ops: addPanelOps(GOOD) })
    expect(p.structured.wouldApply).toBe(true)
    expect(p.text).toMatch(/apply would create revision 2/)
  })

  it('catches a wrong metric: no data, and the near name from this tenant', async () => {
    const r = await rest(h, agent.key, 'write_dashboard', { id: 'service_red', ops: addPanelOps(WRONG) })
    expect(r.structured.valid).toBe(true) // the spec is fine; the data is not
    const warnings = r.structured.data.items.filter((x: any) => x.code)
    const unknown = warnings.find((w: any) => w.code === 'unknown-metric')
    expect(unknown.suggestions[0]).toBe('http_server_requests_total')
    expect(warnings.map((w: any) => w.code)).toContain('no-data')
    expect(r.text).toMatch(/warning unknown-metric: panel checkout_5xx reads metric "http_server_request_total", which has no data in this tenant\. Did you mean: http_server_requests_total\?/)
  })

  it('reports schema errors with paths and suggestions, and stale bases', async () => {
    const bad = await rest(h, agent.key, 'write_dashboard', { id: 'service_red', ops: [{ op: 'replace', path: '/panels/error_ratio/unit', value: 'seconds' }] })
    expect(bad.structured.valid).toBe(false)
    expect(bad.text).toMatch(/error enum at \/panels\/error_ratio\/unit: .*Suggestion: Did you mean "s"\?/)
    const stale = await rest(h, agent.key, 'write_dashboard', { id: 'service_red', ops: addPanelOps(GOOD), base_revision: '0'.repeat(32) })
    expect(stale.text).toMatch(/the control plane would refuse \(HTTP 409\)/)
    expect(stale.text).toMatch(/code: stale-revision/)
  })

  it('a whole new spec: previews every panel, and says whether the key may create it', async () => {
    const spec = example('viz_ingest_pipeline', 'ingest_copy')
    const r = await rest(h, agent.key, 'write_dashboard', { spec })
    expect(r.structured.valid).toBe(true)
    expect(r.structured.counts.previewed).toBe(Object.keys(spec.panels).length)
    expect(r.text).toMatch(/this key may not create dashboards here/)
  })

  it('warns when a value was copied from cleaned display text', async () => {
    const r = await rest(h, agent.key, 'write_dashboard', { id: 'service_red', ops: [{ op: 'replace', path: '/panels/error_ratio/description', value: 'see hxxps[://]example.com …[+120 chars]' }] })
    expect(r.structured.data.items.map((x: any) => x.code)).toContain('sanitized-copy')
  })
})

describe('propose', () => {
  it('creates a proposal of named changes with reasons; nothing is applied', async () => {
    const base = await revisionOf('service_red')
    const r = await rest(h, agent.key, 'write_dashboard', {
      id: 'service_red',
      mode: 'propose',
      base_revision: base,
      message: 'Add a checkout 5xx panel and retitle the notes',
      changes: [
        { name: 'add_checkout_5xx', reason: 'On-call asked for errors per second next to the ratio.', ops: addPanelOps(GOOD) },
        { name: 'retitle_notes', reason: 'The notes panel title is vague.', ops: [{ op: 'replace', path: '/panels/notes/title', value: 'How to read this dashboard' }] },
      ],
    })
    expect(r.status).toBe(200)
    expect(r.structured.proposal.id).toMatch(/^p_[A-Za-z0-9]{22}$/)
    expect(r.text).toMatch(/Outcome: proposal p_[A-Za-z0-9]{22} created with 2 named change\(s\)/)
    expect(await revisionOf('service_red')).toBe(base)
    const p = await controlCall(t.admin, 'GET', `/proposals/${r.structured.proposal.id}`)
    expect(p.body.proposal.changes.map((c: any) => c.name)).toEqual(['add_checkout_5xx', 'retitle_notes'])
    expect(p.body.proposal.by.kind).toBe('agent')
  })

  it('needs base_revision, and refuses an invalid change without writing', async () => {
    const before = await snapshot(t)
    const noBase = await rest(h, agent.key, 'write_dashboard', { id: 'service_red', mode: 'propose', ops: addPanelOps(GOOD) })
    expect(noBase.status).toBe(428)
    const invalid = await rest(h, agent.key, 'write_dashboard', { id: 'service_red', mode: 'propose', base_revision: await revisionOf('service_red'), ops: [{ op: 'remove', path: '/metadata/intent' }] })
    expect(invalid.status).toBe(422)
    expect(invalid.structured.error.code).toBe('invalid-dashboard')
    expect(await snapshot(t)).toBe(before)
  })

  it('cannot propose a new dashboard (the control plane has no create proposals yet)', async () => {
    const r = await rest(h, agent.key, 'write_dashboard', { spec: example('k8s_node_overview', 'k8s_copy'), mode: 'propose' })
    expect(r.status).toBe(409)
    expect(r.structured.error.code).toBe('propose-needs-existing')
  })
})

describe('apply', () => {
  it('agent identities cannot apply: refused, nothing written, propose offered', async () => {
    for (const k of [agent, agentApply]) {
      const before = await snapshot(t)
      const r = await rest(h, k.key, 'write_dashboard', { id: 'service_red', mode: 'apply', base_revision: await revisionOf('service_red'), ops: addPanelOps(GOOD) })
      expect(r.status).toBe(403)
      expect(r.structured.error.code).toBe('apply-refused')
      expect(r.structured.offer).toEqual({ mode: 'propose' })
      expect(r.text).toMatch(/mode "propose"/)
      expect(await snapshot(t)).toBe(before) // no revision, and no proposal made behind its back
    }
  })

  it('an agent cannot create a dashboard either', async () => {
    const before = await snapshot(t)
    const r = await rest(h, agentApply.key, 'write_dashboard', { spec: example('k8s_node_overview', 'k8s_by_agent'), mode: 'apply' })
    expect(r.status).toBe(403)
    expect(r.structured.error.code).toBe('apply-refused')
    expect(await snapshot(t)).toBe(before)
  })

  it('a key (not an agent) with dashboards:apply applies', async () => {
    const r = await rest(h, person.key, 'write_dashboard', { id: 'service_red', mode: 'apply', base_revision: await revisionOf('service_red'), ops: [{ op: 'replace', path: '/metadata/title', value: 'Service RED' }], message: 'Shorter' })
    expect(r.status).toBe(200)
    expect(r.structured.applied.number).toBeGreaterThan(1)
    const revs = await controlCall(t.admin, 'GET', '/dashboards/service_red/revisions')
    expect(revs.body.items[0].by).toMatchObject({ kind: 'key', name: 'Dana' })
  })

  it('when the tenant allows agents to apply, an agent with dashboards:apply may', async () => {
    const t2 = await newTenant('allow')
    telemetry(h, t2.tenant)
    await createDashboard(t2.admin, example('service_red'))
    const k = await makeKey(t2.admin, ['read', 'dashboards:read', 'dashboards:write', 'dashboards:apply'], { kind: 'agent', name: 'trusted agent' })
    await setAgentsMayApply(t2, true)
    const base = (await controlCall(t2.admin, 'GET', '/dashboards/service_red')).body.revision
    const r = await rest(h, k.key, 'write_dashboard', { id: 'service_red', mode: 'apply', base_revision: base, ops: addPanelOps(GOOD) })
    expect(r.status).toBe(200)
    const revs = await controlCall(t2.admin, 'GET', '/dashboards/service_red/revisions')
    expect(revs.body.items[0].by).toMatchObject({ kind: 'agent', name: 'trusted agent' })
    // Without the apply scope it is still refused, before anything is asked of the control plane.
    const noScope = await rest(h, (await makeKey(t2.admin, ['read', 'dashboards:read', 'dashboards:write'], { kind: 'agent' })).key, 'write_dashboard', { id: 'service_red', mode: 'apply', base_revision: base, ops: addPanelOps(GOOD) })
    expect(noScope.structured.error.code).toBe('apply-refused')
  })

  it('the agent surface offers no way to apply a proposal', async () => {
    const tools = await h.fetch(new Request('https://agent.vis.bitcru.sh/api/v1/agent/tools', { headers: { Authorization: `Bearer ${agentApply.key}` } }))
    const names = ((await tools.json()) as any).tools.map((x: any) => x.name)
    expect(names.filter((n: string) => /apply|approve|accept|revert|delete/.test(n))).toEqual([])
  })
})
