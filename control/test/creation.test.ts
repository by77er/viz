import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { revisionOf, validate } from '../../dashboard/src/index.ts'
import { auditOf, call, createDashboard, example, get, makeKey, newTenant, post, stubOf } from './helpers'

/**
 * Proposals that create a dashboard: the same proposal → review → apply flow as a change to
 * an existing one. An agent proposes; a person applies; the spec must pass viz.dashboard/v1
 * (the dashboard package's own `validate`); retries do not make a second proposal, a second
 * dashboard or a second revision.
 */

async function setup() {
  const t = await newTenant('create')
  const agent = await makeKey(t.admin, ['dashboards:read', 'dashboards:write'], { name: 'builder', kind: 'agent' })
  const agentApply = await makeKey(t.admin, ['dashboards:read', 'dashboards:write', 'dashboards:apply'], { name: 'trusted builder', kind: 'agent' })
  const dana = await makeKey(t.admin, ['dashboards:read', 'dashboards:write', 'dashboards:apply'], { name: 'Dana' })
  const sam = await makeKey(t.admin, ['dashboards:read', 'dashboards:write'], { name: 'Sam, write only' })
  return { t, agent, agentApply, dana, sam }
}

const SPEC = (id = 'nodes_new') => example('k8s_node_overview', id)

/** Everything a change could touch, as the admin sees it. */
async function snapshot(admin: string): Promise<string> {
  const dashboards = (await get(admin, '/dashboards?limit=200')).body.items
  const deleted = (await get(admin, '/dashboards?deleted=true&limit=200')).body.items
  const proposals = (await get(admin, '/proposals?status=all&limit=200')).body.items
  return JSON.stringify({ dashboards, deleted, proposals, audit: (await auditOf(admin)).length })
}

describe('proposals that create a dashboard', () => {
  it('an agent proposes a whole new dashboard; nothing exists until a person applies it; the revision says who applied and who proposed', async () => {
    const { t, agent, dana } = await setup()
    const spec = SPEC()
    const res = await post(agent.key, '/proposals', { spec, message: 'Node overview for the new cluster' })
    expect(res.status, res.text).toBe(202)
    expect(res.body.outcome).toBe('proposed')
    const id: string = res.body.proposal.id
    expect(id).toMatch(/^p_[A-Za-z0-9]{22}$/)
    expect(res.body.proposal).toMatchObject({ kind: 'create', dashboard: 'nodes_new', status: 'open', baseRevision: '', baseNumber: 0, changes: [], by: { kind: 'agent', name: 'builder' } })
    expect(res.body.proposal.spec).toEqual(spec)
    expect(res.body.review).toMatchObject({ kind: 'create', current: null, exists: false, needsRebase: false, reasons: [], errors: [], result: { revision: revisionOf(spec), number: 1 } })
    expect(res.body.review.summary).toEqual([`+ dashboard nodes_new "${spec.metadata.title}" (${Object.keys(spec.panels).length} panels)`])
    // nothing exists yet
    expect((await get(t.admin, '/dashboards/nodes_new')).status).toBe(404)

    // listed with the others, without the spec; filtered by the id it would create
    const list = (await get(dana.key, '/proposals')).body.items
    expect(list.map((p: any) => [p.id, p.kind, p.dashboard])).toEqual([[id, 'create', 'nodes_new']])
    expect(list[0].spec).toBeUndefined()
    expect((await get(dana.key, '/proposals?dashboard=nodes_new')).body.items).toHaveLength(1)
    // shown whole, reviewed against the tenant as it is now
    const shown = await get(dana.key, `/proposals/${id}`)
    expect(shown.body.proposal.spec).toEqual(spec)
    expect(shown.body.review.result.number).toBe(1)

    // a dry run of the apply reports exactly the real outcome and writes nothing
    const before = await snapshot(t.admin)
    const dry = await post(dana.key, `/proposals/${id}/apply`, { dryRun: true })
    expect(dry.status, dry.text).toBe(200)
    expect(dry.body).toMatchObject({ dryRun: true, outcome: 'applied', number: 1 })
    expect(await snapshot(t.admin)).toBe(before)

    const applied = await post(dana.key, `/proposals/${id}/apply`)
    expect(applied.status, applied.text).toBe(200)
    expect(applied.body).toMatchObject({ outcome: 'applied', number: 1, revision: revisionOf(spec), appliedChanges: [], skippedChanges: [], dashboard: { id: 'nodes_new', number: 1, createdBy: { name: 'Dana', kind: 'key' } } })
    expect(applied.headers.get('ETag')).toBe(`"${revisionOf(spec)}"`)
    const { dryRun: _d, proposal: dp, dashboard: dd, ...dryRest } = dry.body
    const { proposal: rp, dashboard: rd, ...realRest } = applied.body
    expect(dryRest).toEqual(realRest)
    void dp, void dd, void rp, void rd

    const now = await get(t.admin, '/dashboards/nodes_new')
    expect(now.body.spec).toEqual(spec)
    const revs = (await get(t.admin, '/dashboards/nodes_new/revisions')).body.items
    expect(revs).toHaveLength(1)
    expect(revs[0]).toMatchObject({ number: 1, kind: 'apply', proposal: id, message: 'Node overview for the new cluster', by: { name: 'Dana', kind: 'key' }, proposedBy: { name: 'builder', kind: 'agent' } })
    expect((await get(dana.key, `/proposals/${id}`)).body).toMatchObject({ proposal: { status: 'applied', appliedNumber: 1, appliedChanges: [], resolvedBy: { name: 'Dana' } }, review: null })
    const audit = await auditOf(t.admin, `&targetId=${id}`)
    expect(audit.map((a) => [a.action, a.by.kind, a.by.name])).toEqual([['proposal.apply', 'key', 'Dana'], ['proposal.create', 'agent', 'builder']])
    expect(audit[0].after).toMatchObject({ dashboard: 'nodes_new', created: true, number: 1, proposedBy: { name: 'builder' } })
  })

  it('authorisation: an agent key cannot apply it, whatever its scopes, its own or another\'s; a write-only person cannot either; nothing is written', async () => {
    const { t, agent, agentApply, dana, sam } = await setup()
    const mine = (await post(agent.key, '/proposals', { spec: SPEC('by_builder'), message: 'm' })).body.proposal.id
    const theirs = (await post(agentApply.key, '/proposals', { spec: SPEC('by_trusted'), message: 'm' })).body.proposal.id
    const before = await snapshot(t.admin)
    for (const [key, pid, status, code] of [
      [agentApply.key, mine, 403, 'agents-may-not-apply'],
      [agentApply.key, theirs, 403, 'agents-may-not-apply'],
      [agent.key, mine, 403, 'missing-scope'],
      [sam.key, mine, 403, 'missing-scope'],
    ] as const) {
      for (const body of [{}, { dryRun: true }]) {
        const res = await post(key, `/proposals/${pid}/apply`, body)
        expect(res.status, res.text).toBe(status)
        expect(res.body.code).toBe(code)
      }
    }
    expect(await snapshot(t.admin)).toBe(before)
    // whoami says the same thing before anyone tries
    expect((await get(agentApply.key, '/whoami')).body.mayApply).toBe(false)
    expect((await get(dana.key, '/whoami')).body.mayApply).toBe(true)

    // A person applies; with "agentsMayApply" an agent with the apply scope may too, as for a direct create.
    expect((await post(dana.key, `/proposals/${mine}/apply`)).status).toBe(200)
    expect((await call(t.admin, 'PUT', '/settings/general', { value: { agentsMayApply: true } })).status).toBe(200)
    expect((await get(agentApply.key, '/whoami')).body.mayApply).toBe(true)
    const trusted = await post(agentApply.key, `/proposals/${theirs}/apply`)
    expect(trusted.status, trusted.text).toBe(200)
    expect(trusted.body.dashboard.createdBy).toMatchObject({ kind: 'agent', name: 'trusted builder' })
  })

  it('validation: the spec must pass the viz.dashboard/v1 schema, with the dashboard package\'s own errors; nothing is stored otherwise', async () => {
    const { t, agent } = await setup()
    const before = await snapshot(t.admin)
    const unit = SPEC()
    const p0 = Object.keys(unit.panels).find((k) => 'unit' in unit.panels[k])!
    unit.panels[p0].unit = 'seconds'
    const misspelt = SPEC()
    misspelt.panels[p0].titel = misspelt.panels[p0].title
    const noIntent = SPEC()
    delete noIntent.metadata.intent
    for (const spec of [unit, misspelt, noIntent, { apiVersion: 'viz.dashboard/v1' }, [], 'a dashboard']) {
      const res = await post(agent.key, '/proposals', { spec, message: 'm' })
      expect(res.status, res.text).toBe(422)
      expect(res.body.code).toBe('invalid-dashboard')
      // exactly what the dashboard package says about the same spec, path and suggestion included
      expect(res.body.errors).toEqual(validate(spec).errors)
      expect(res.body.errors.length).toBeGreaterThan(0)
    }
    expect((await post(agent.key, '/proposals', { spec: unit, message: 'm' })).body.errors[0]).toMatchObject({ path: `/panels/${p0}/unit`, code: 'enum', suggestion: expect.stringContaining('"s"') })
    for (const body of [{ spec: SPEC() }, { spec: SPEC(), message: '' }, { message: 'no spec' }, { spec: SPEC(), message: 'm', ops: [] }, { spec: SPEC(), message: 'm', baseRevision: 'x' }]) {
      expect((await post(agent.key, '/proposals', body)).status, JSON.stringify(Object.keys(body))).toBe(422)
    }
    expect(await snapshot(t.admin)).toBe(before)

    // the id must be free: not a live dashboard, not a deleted (restorable) one
    await createDashboard(t.admin, 'taken', 'service_red')
    await createDashboard(t.admin, 'gone', 'service_red')
    await call(t.admin, 'DELETE', '/dashboards/gone')
    const taken = await post(agent.key, '/proposals', { spec: SPEC('taken'), message: 'm' })
    expect([taken.status, taken.body.code]).toEqual([409, 'dashboard-exists'])
    expect(taken.body.fix).toContain('/dashboards/taken/proposals')
    const gone = await post(agent.key, '/proposals', { spec: SPEC('gone'), message: 'm' })
    expect([gone.status, gone.body.code]).toEqual([409, 'dashboard-deleted'])

    // edits are validated the same way, keep the id, and take only a spec
    const id = (await post(agent.key, '/proposals', { spec: SPEC(), message: 'm' })).body.proposal.id
    const mid = await snapshot(t.admin)
    expect((await call(agent.key, 'PUT', `/proposals/${id}`, { spec: unit })).body.code).toBe('invalid-dashboard')
    expect((await call(agent.key, 'PUT', `/proposals/${id}`, { spec: SPEC('renamed') })).status).toBe(422)
    expect((await call(agent.key, 'PUT', `/proposals/${id}`, { ops: [{ op: 'replace', path: '/metadata/title', value: 'x' }] })).status).toBe(422)
    expect(await snapshot(t.admin)).toBe(mid)
    // and a proposal to change a dashboard takes no spec
    const base = (await get(t.admin, '/dashboards/taken')).body.revision
    const change = (await post(agent.key, '/dashboards/taken/proposals', { message: 'm', baseRevision: base, ops: [{ op: 'replace', path: '/metadata/title', value: 'x' }] })).body.proposal.id
    expect((await call(agent.key, 'PUT', `/proposals/${change}`, { spec: SPEC('taken') })).status).toBe(422)
  })

  it('the proposer edits it: the spec is replaced, the review recomputed, the editor recorded; only the proposer or someone who may apply', async () => {
    const { t, agent, sam, dana } = await setup()
    const id = (await post(agent.key, '/proposals', { spec: SPEC(), message: 'first' })).body.proposal.id
    const better = SPEC()
    better.metadata.title = 'Nodes, by cluster'
    const edited = await call(agent.key, 'PUT', `/proposals/${id}`, { spec: better, message: 'second' })
    expect(edited.status, edited.text).toBe(200)
    expect(edited.body).toMatchObject({ outcome: 'edited', proposal: { id, message: 'second', spec: better }, review: { result: { revision: revisionOf(better) } } })
    expect((await call(sam.key, 'PUT', `/proposals/${id}`, { spec: SPEC() })).body.code).toBe('not-yours')
    const byDana = await call(dana.key, 'PUT', `/proposals/${id}`, { spec: SPEC() })
    expect(byDana.body.proposal.editedBy.map((e: any) => e.name)).toEqual(['Dana'])
    expect((await auditOf(t.admin, `&targetId=${id}`)).map((a) => a.action)).toEqual(['proposal.edit', 'proposal.edit', 'proposal.create'])
    // decline (the proposer may withdraw its own), and it is closed for good
    expect((await post(agent.key, `/proposals/${id}/decline`, { reason: 'not needed after all' })).body.proposal.status).toBe('declined')
    expect((await post(dana.key, `/proposals/${id}/apply`)).body).toMatchObject({ code: 'proposal-closed', status: 'declined' })
    expect((await get(t.admin, '/dashboards/nodes_new')).status).toBe(404)
  })

  it('it expires like any proposal: refused once overdue, closed by the alarm', async () => {
    const { t, agent, dana } = await setup()
    const id = (await post(agent.key, '/proposals', { spec: SPEC(), message: 'm' })).body.proposal.id
    const stub = stubOf(t.tenant)
    await runInDurableObject(stub, (_i, s) => void s.storage.sql.exec('UPDATE proposals SET expires_at = ? WHERE tenant = ? AND id = ?', Date.now() - 1000, t.tenant, id))
    expect((await post(dana.key, `/proposals/${id}/apply`)).body).toMatchObject({ code: 'proposal-closed', status: 'expired' })
    await runDurableObjectAlarm(stub)
    expect((await get(dana.key, `/proposals/${id}`)).body.proposal.status).toBe('expired')
    expect((await get(t.admin, '/dashboards/nodes_new')).status).toBe(404)
  })
})

describe('idempotency', () => {
  it('the same caller proposing the same spec again gets its open proposal back: one proposal, one audit entry', async () => {
    const { t, agent, agentApply } = await setup()
    const first = await post(agent.key, '/proposals', { spec: SPEC(), message: 'first try' })
    expect(first.status).toBe(202)
    const auditBefore = (await auditOf(t.admin)).length
    for (const message of ['first try', 'the retry says it differently']) {
      const again = await post(agent.key, '/proposals', { spec: SPEC(), message })
      expect(again.status, again.text).toBe(200)
      expect(again.body).toMatchObject({ outcome: 'unchanged', proposal: { id: first.body.proposal.id, message: 'first try' } })
    }
    // the same request as a dry run says the same
    expect((await post(agent.key, '/proposals', { spec: SPEC(), message: 'm', dryRun: true })).body).toMatchObject({ outcome: 'unchanged', dryRun: true })
    expect((await auditOf(t.admin)).length).toBe(auditBefore)
    expect((await get(t.admin, '/proposals?status=all')).body.items).toHaveLength(1)
    // another caller, or another spec, is another proposal
    expect((await post(agentApply.key, '/proposals', { spec: SPEC(), message: 'm' })).status).toBe(202)
    const other = SPEC()
    other.metadata.title = 'Different'
    expect((await post(agent.key, '/proposals', { spec: other, message: 'm' })).status).toBe(202)
    expect((await get(t.admin, '/proposals')).body.items).toHaveLength(3)
  })

  it('applying twice, or two applies at once, creates the dashboard once: one dashboard, one revision, one apply entry', async () => {
    const { t, agent, dana } = await setup()
    const id = (await post(agent.key, '/proposals', { spec: SPEC(), message: 'm' })).body.proposal.id
    const [a, b] = await Promise.all([post(dana.key, `/proposals/${id}/apply`), post(t.admin, `/proposals/${id}/apply`)])
    expect([a.status, b.status].sort()).toEqual([200, 409])
    const loser = a.status === 409 ? a : b
    expect(loser.body).toMatchObject({ code: 'proposal-closed', status: 'applied', appliedNumber: 1 })
    const retry = await post(dana.key, `/proposals/${id}/apply`)
    expect(retry.body).toMatchObject({ code: 'proposal-closed', status: 'applied', appliedNumber: 1 })
    expect((await get(t.admin, '/dashboards')).body.items.map((d: any) => d.id)).toEqual(['nodes_new'])
    expect((await get(t.admin, '/dashboards/nodes_new/revisions')).body.items).toHaveLength(1)
    expect((await auditOf(t.admin, '&action=proposal.apply')).length).toBe(1)
  })

  it('two proposals for the same new id: once one is applied the other cannot be, and its review says why', async () => {
    const { t, agent, agentApply, dana } = await setup()
    const one = (await post(agent.key, '/proposals', { spec: SPEC(), message: 'one' })).body.proposal.id
    const twoSpec = SPEC()
    twoSpec.metadata.title = 'Another take'
    const two = (await post(agentApply.key, '/proposals', { spec: twoSpec, message: 'two' })).body.proposal.id
    expect((await post(dana.key, `/proposals/${one}/apply`)).status).toBe(200)
    const review = (await get(dana.key, `/proposals/${two}`)).body.review
    expect(review).toMatchObject({ exists: true, result: null })
    expect(review.reasons.join(' ')).toContain('exists now')
    const before = await snapshot(t.admin)
    const refused = await post(dana.key, `/proposals/${two}/apply`)
    expect([refused.status, refused.body.code]).toEqual([409, 'dashboard-exists'])
    expect(refused.body.fix).toContain('Decline this proposal')
    expect(await snapshot(t.admin)).toBe(before)
    // a creation is applied whole: no named changes, no base revision
    const three = (await post(agent.key, '/proposals', { spec: SPEC('third'), message: 'm' })).body.proposal.id
    expect((await post(dana.key, `/proposals/${three}/apply`, { changes: ['create'] })).status).toBe(422)
    expect((await post(dana.key, `/proposals/${three}/apply`, { baseRevision: 'x' })).status).toBe(422)
  })
})

describe('storage written by another release', () => {
  it('a creation row that a release without the spec column rewrote into a change (base_number >= 1) is read as a change', async () => {
    const { t, agent, dana } = await setup()
    const id = (await post(agent.key, '/proposals', { spec: SPEC('later'), message: 'm' })).body.proposal.id
    // The id is taken meanwhile; release 1 lets the proposer edit the row into an ordinary
    // proposal against that dashboard. It does not know the spec column and leaves it there.
    const made = await createDashboard(t.admin, 'later', 'k8s_node_overview')
    const ops = [{ op: 'replace', path: '/metadata/title', value: 'Edited by release 1' }]
    await runInDurableObject(stubOf(t.tenant), (_i, s) =>
      void s.storage.sql.exec('UPDATE proposals SET base_revision = ?, base_number = 1, changes = ? WHERE tenant = ? AND id = ?', made.body.revision, JSON.stringify([{ name: 'change', reason: 'r', ops }]), t.tenant, id),
    )
    const shown = (await get(dana.key, `/proposals/${id}`)).body
    expect(shown.proposal).toMatchObject({ kind: 'patch', baseNumber: 1 })
    expect(shown.proposal.spec).toBeUndefined()
    expect(shown.review).toMatchObject({ current: { number: 1 }, needsRebase: false })
    const applied = await post(dana.key, `/proposals/${id}/apply`)
    expect(applied.status, applied.text).toBe(200)
    expect((await get(t.admin, '/dashboards/later')).body).toMatchObject({ number: 2, spec: { metadata: { title: 'Edited by release 1' } } })
  })

  it('a stored spec is validated again when reviewed and applied: one that does not pass is shown with its errors and never applied', async () => {
    const { t, agent, dana } = await setup()
    const id = (await post(agent.key, '/proposals', { spec: SPEC('checked'), message: 'm' })).body.proposal.id
    const bad = SPEC('checked')
    delete bad.metadata.intent
    await runInDurableObject(stubOf(t.tenant), (_i, s) => void s.storage.sql.exec('UPDATE proposals SET spec = ? WHERE tenant = ? AND id = ?', JSON.stringify(bad), t.tenant, id))
    const review = (await get(dana.key, `/proposals/${id}`)).body.review
    expect(review).toMatchObject({ result: null, errors: validate(bad).errors })
    const before = await snapshot(t.admin)
    const res = await post(dana.key, `/proposals/${id}/apply`)
    expect([res.status, res.body.code]).toEqual([422, 'invalid-dashboard'])
    expect(await snapshot(t.admin)).toBe(before)
  })

  it('purging a deleted dashboard keeps an open proposal to create one under its id, which can then be applied', async () => {
    const { t, agent, dana } = await setup()
    const id = (await post(agent.key, '/proposals', { spec: SPEC('recycled'), message: 'm' })).body.proposal.id
    await createDashboard(t.admin, 'recycled', 'service_red')
    await call(t.admin, 'DELETE', '/dashboards/recycled')
    const stub = stubOf(t.tenant)
    await runInDurableObject(stub, (_i, s) => void s.storage.sql.exec('UPDATE dashboards SET purge_at = ? WHERE tenant = ? AND id = ?', Date.now() - 1000, t.tenant, 'recycled'))
    await runDurableObjectAlarm(stub)
    expect((await get(t.admin, '/dashboards/recycled')).status).toBe(404)
    expect((await get(dana.key, `/proposals/${id}`)).body.review).toMatchObject({ exists: false })
    expect((await post(dana.key, `/proposals/${id}/apply`)).status).toBe(200)
  })
})
