import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { validate } from '../../dashboard/src/index.ts'
import type { Tenant } from '../src/tenant'
import { auditOf, call, createDashboard, example, get, makeKey, newTenant, post, stubOf } from './helpers'

const SPEC = example('service_red', 'checkout_api')
const PANELS = Object.keys(SPEC.panels)
const P0 = PANELS[0]!
const P1 = PANELS[1]!

/** The change of screen 7: add a panel (with its query, placed in the layout), change one, remove one. */
function screen7Changes(): any[] {
  const removable = 'p_goroutines'
  return [
    {
      name: 'add_dependency_latency',
      reason: 'The incident was a slow dependency, and no panel showed dependencies.',
      ops: [
        { op: 'add', path: '/queries/dep_p99', value: { lang: 'promql', expr: 'histogram_quantile(0.99, sum by (le, db) (rate(db_client_duration_seconds_bucket{service="$service"}[$__rate])))', legend: '{{db}}' } },
        { op: 'add', path: '/panels/dep_latency', value: { kind: 'timeseries', title: 'Dependency latency, p99', description: 'Time the service waits on each thing it calls. A rise here before a rise in latency points at the dependency.', unit: 's', queries: ['dep_p99'] } },
        { op: 'add', path: '/layout/rows/0/items/-', value: 'dep_latency' },
      ],
    },
    { name: 'retitle', reason: 'Says what the number is.', ops: [{ op: 'replace', path: `/panels/${P0}/title`, value: 'Error ratio, 5xx over all' }] },
    { name: 'remove_goroutines', reason: 'Not opened in 90 days and returns no data since the runtime upgrade.', ops: [{ op: 'remove', path: `/panels/${removable}` }, { op: 'remove', path: '/layout/rows/0/items/0' }] },
  ]
}

/** A dashboard with one extra, removable panel at the front of the first row. */
function specWithGoroutines(): any {
  const spec = structuredClone(SPEC)
  spec.queries.goroutines = { lang: 'promql', expr: 'go_goroutines{service="$service"}' }
  spec.panels.p_goroutines = { kind: 'timeseries', title: 'Goroutines', description: 'Number of goroutines per instance of the service.', unit: 'count', queries: ['goroutines'] }
  spec.layout.rows[0].items.unshift('p_goroutines')
  expect(validate(spec).errors).toEqual([])
  return spec
}

async function setup() {
  const t = await newTenant()
  const created = await post(t.admin, '/dashboards', { spec: specWithGoroutines() })
  expect(created.status, created.text).toBe(201)
  const agent = await makeKey(t.admin, ['dashboards:read', 'dashboards:write'], { name: 'investigator', kind: 'agent' })
  const dana = await makeKey(t.admin, ['dashboards:read', 'dashboards:write', 'dashboards:apply'], { name: 'Dana' })
  return { t, r1: created.body.revision as string, agent, dana }
}
const propose = (key: string, body: unknown) => post(key, '/dashboards/checkout_api/proposals', body)
const current = async (key: string) => (await get(key, '/dashboards/checkout_api')).body

describe('proposed changes', () => {
  it('an agent proposes named changes with reasons; nothing changes until a person applies; the revision says who approved and who proposed', async () => {
    const { t, r1, agent, dana } = await setup()
    const res = await propose(agent.key, { message: 'After the investigation into slow checkout', baseRevision: r1, changes: screen7Changes() })
    expect(res.status, res.text).toBe(202)
    expect(res.body.outcome).toBe('proposed')
    const id: string = res.body.proposal.id
    expect(id).toMatch(/^p_[A-Za-z0-9]{22}$/)
    expect(res.body.proposal).toMatchObject({ dashboard: 'checkout_api', status: 'open', baseRevision: r1, baseNumber: 1, by: { kind: 'agent', name: 'investigator', subject: `key:${agent.id}` } })
    expect(Date.parse(res.body.proposal.expiresAt) - Date.parse(res.body.proposal.createdAt)).toBe(30 * 86_400_000)
    expect((await current(t.admin)).number).toBe(1) // nothing has been changed yet

    // listed, with the reasons but not the ops
    const list = await get(dana.key, '/proposals')
    expect(list.body.items).toHaveLength(1)
    expect(list.body.items[0].changes).toEqual(screen7Changes().map((c) => ({ name: c.name, reason: c.reason, ops: c.ops.length })))
    expect((await get(dana.key, '/proposals?dashboard=other')).body.items).toHaveLength(0)

    // shown with the diff against the current revision, change by change
    const shown = await get(dana.key, `/proposals/${id}`)
    expect(shown.body.proposal.changes).toEqual(screen7Changes())
    const review = shown.body.review
    expect(review).toMatchObject({ current: { revision: r1, number: 1 }, moved: false, needsRebase: false, reasons: [], errors: [] })
    expect(review.result.number).toBe(2)
    expect(review.changes.map((c: any) => [c.name, c.applies, c.conflicts])).toEqual([['add_dependency_latency', true, []], ['retitle', true, []], ['remove_goroutines', true, []]])
    const words = review.summary.join('\n')
    expect(words).toContain('dep_latency')
    expect(words).toContain('Error ratio, 5xx over all')
    expect(words).toContain('p_goroutines')
    expect(review.changes[1].summary.join(' ')).toContain('Error ratio, 5xx over all')

    // the agent cannot apply (no scope); Dana can
    expect((await post(agent.key, `/proposals/${id}/apply`)).status).toBe(403)
    const applied = await post(dana.key, `/proposals/${id}/apply`)
    expect(applied.status, applied.text).toBe(200)
    expect(applied.body).toMatchObject({ outcome: 'applied', number: 2, previousRevision: r1, revision: review.result.revision, appliedChanges: ['add_dependency_latency', 'retitle', 'remove_goroutines'], skippedChanges: [] })
    const now = await current(t.admin)
    expect(now.number).toBe(2)
    expect(now.spec.panels.dep_latency.title).toBe('Dependency latency, p99')
    expect(now.spec.panels[P0].title).toBe('Error ratio, 5xx over all')
    expect(now.spec.panels.p_goroutines).toBeUndefined()
    expect(validate(now.spec).ok).toBe(true)
    expect(now.dashboard.lastChangedBy).toMatchObject({ name: 'Dana', kind: 'key' })

    const rev = (await get(t.admin, '/dashboards/checkout_api/revisions')).body.items[0]
    expect(rev).toMatchObject({ number: 2, kind: 'apply', proposal: id, message: 'After the investigation into slow checkout', by: { name: 'Dana', kind: 'key' }, proposedBy: { name: 'investigator', kind: 'agent' } })
    const after = (await get(dana.key, `/proposals/${id}`)).body
    expect(after.proposal).toMatchObject({ status: 'applied', appliedNumber: 2, resolvedBy: { name: 'Dana' } })
    expect(after.review).toBeNull()
    expect((await get(dana.key, '/proposals')).body.items).toHaveLength(0)
    expect((await get(dana.key, '/proposals?status=applied')).body.items).toHaveLength(1)
    // applied once only
    expect((await post(dana.key, `/proposals/${id}/apply`)).body.code).toBe('proposal-closed')
    const audit = await auditOf(t.admin, `&targetId=${id}`)
    expect(audit.map((a) => [a.action, a.by.kind, a.by.name])).toEqual([['proposal.apply', 'key', 'Dana'], ['proposal.create', 'agent', 'investigator']])
    expect(audit[0].after.proposedBy).toMatchObject({ kind: 'agent', name: 'investigator' })
  })

  it('partial application: only the chosen changes are applied, in the proposal\'s order; a selection that depends on a change left out is refused', async () => {
    const { t, r1, agent, dana } = await setup()
    const id: string = (await propose(agent.key, { message: 'three things', baseRevision: r1, changes: screen7Changes() })).body.proposal.id

    for (const bad of [{ changes: [] }, { changes: ['nope'] }, { changes: 'retitle' }]) expect((await post(dana.key, `/proposals/${id}/apply`, bad)).status).toBe(422)
    const dry = await post(dana.key, `/proposals/${id}/apply`, { changes: ['retitle', 'add_dependency_latency'], dryRun: true })
    expect(dry.body).toMatchObject({ dryRun: true, number: 2 })
    expect((await current(t.admin)).number).toBe(1)

    const res = await post(dana.key, `/proposals/${id}/apply`, { changes: ['retitle', 'add_dependency_latency'], message: 'two of three' })
    expect(res.status, res.text).toBe(200)
    expect(res.body).toMatchObject({ appliedChanges: ['add_dependency_latency', 'retitle'], skippedChanges: ['remove_goroutines'], number: 2, revision: dry.body.revision })
    const now = (await current(t.admin)).spec
    expect(now.panels.dep_latency).toBeDefined()
    expect(now.panels[P0].title).toBe('Error ratio, 5xx over all')
    expect(now.panels.p_goroutines).toBeDefined() // the declined change did not happen
    expect(now.layout.rows[0].items[0]).toBe('p_goroutines')
    const p = (await get(dana.key, `/proposals/${id}`)).body.proposal
    expect(p).toMatchObject({ status: 'applied', appliedChanges: ['add_dependency_latency', 'retitle'] })
    expect((await get(t.admin, '/dashboards/checkout_api/revisions')).body.items[0]).toMatchObject({ message: 'two of three', kind: 'apply' })

    // b needs a; choosing b alone is refused and says why
    const base = (await current(t.admin)).revision
    const dep = await propose(agent.key, {
      message: 'dependent',
      baseRevision: base,
      changes: [
        { name: 'a_query', reason: 'needed by b', ops: [{ op: 'add', path: '/queries/extra', value: { lang: 'promql', expr: 'up{service="$service"}' } }] },
        { name: 'b_panel', reason: 'uses a', ops: [{ op: 'add', path: '/panels/extra_panel', value: { kind: 'stat', title: 'Up', description: 'Whether the service instances are up, as scraped.', unit: 'count', queries: ['extra'] } }, { op: 'add', path: '/layout/rows/0/items/-', value: 'extra_panel' }] },
      ],
    })
    expect(dep.status, dep.text).toBe(202)
    const only = await post(dana.key, `/proposals/${dep.body.proposal.id}/apply`, { changes: ['b_panel'] })
    expect(only.status).toBe(422)
    expect(only.body.code).toBe('selection-invalid')
    expect((await current(t.admin)).revision).toBe(base)
    expect((await post(dana.key, `/proposals/${dep.body.proposal.id}/apply`, { changes: ['a_query', 'b_panel'] })).status).toBe(200)
  })

  it('a proposal is always evaluated against the CURRENT revision: clean when the dashboard moved elsewhere, needsRebase when it moved underneath', async () => {
    const { t, r1, agent, dana } = await setup()
    const mk = async (name: string, ops: unknown[]) => (await propose(agent.key, { message: name, baseRevision: (await current(t.admin)).revision, changes: [{ name, reason: 'because', ops }] })).body.proposal.id as string
    const overwrite = await mk('overwrite', [{ op: 'replace', path: `/panels/${P0}/title`, value: 'Agent title' }])
    const onGone = await mk('on_gone', [{ op: 'replace', path: '/panels/p_goroutines/description', value: 'Goroutines per instance, which should stay flat under steady load.' }])
    const elsewhere = await mk('elsewhere', [{ op: 'replace', path: `/panels/${P1}/title`, value: 'Agent on another panel' }])
    const layout = await mk('layout', [{ op: 'add', path: '/queries/q_new', value: { lang: 'promql', expr: 'up' } }, { op: 'add', path: '/panels/p_new', value: { kind: 'stat', title: 'New', description: 'A new panel the agent wants at the end of the first row.', unit: 'count', queries: ['q_new'] } }, { op: 'add', path: '/layout/rows/0/items/-', value: 'p_new' }])

    // Dana changes the same title, and removes the goroutines panel (which shifts the first row)
    const d1 = await call(dana.key, 'PATCH', '/dashboards/checkout_api', { ops: [{ op: 'replace', path: `/panels/${P0}/title`, value: 'Dana title' }], baseRevision: r1, message: 'dana 1' })
    const d2 = await call(dana.key, 'PATCH', '/dashboards/checkout_api', { ops: [{ op: 'remove', path: '/panels/p_goroutines' }, { op: 'remove', path: '/layout/rows/0/items/0' }], baseRevision: d1.body.revision, message: 'dana 2' })
    expect(d2.status, d2.text).toBe(200)
    const head = d2.body.revision

    // 1. would silently overwrite Dana's newer title: the op still applies, but it touches what was edited since
    const a = (await get(dana.key, `/proposals/${overwrite}`)).body.review
    expect(a).toMatchObject({ moved: true, needsRebase: true, current: { revision: head, number: 3 } })
    expect(a.changes[0]).toMatchObject({ applies: true, conflicts: [`/panels/${P0}/title`] })
    expect(a.reasons.join(' ')).toContain('edited since revision 1')
    const ra = await post(dana.key, `/proposals/${overwrite}/apply`)
    expect(ra.status).toBe(409)
    expect(ra.body.code).toBe('needs-rebase')
    expect(ra.body.review.needsRebase).toBe(true)
    expect(ra.body.fix).toContain('PUT')

    // 2. the panel it edits no longer exists: the op fails
    const b = (await get(dana.key, `/proposals/${onGone}`)).body.review
    expect(b).toMatchObject({ moved: true, needsRebase: true, result: null })
    expect(b.changes[0].applies).toBe(false)
    expect(b.changes[0].error).toBeTruthy()
    expect((await post(dana.key, `/proposals/${onGone}/apply`)).body.code).toBe('needs-rebase')

    // 3. appends to an array Dana also changed: indices may have shifted, so it is not applied blind
    expect((await get(dana.key, `/proposals/${layout}`)).body.review).toMatchObject({ moved: true, needsRebase: true })
    expect((await post(dana.key, `/proposals/${layout}/apply`)).status).toBe(409)

    expect((await current(t.admin)).revision).toBe(head) // none of the three changed anything

    // 4. touches a panel nobody else touched: clean, and the diff shown is against the current revision
    const c = (await get(dana.key, `/proposals/${elsewhere}`)).body.review
    expect(c).toMatchObject({ moved: true, needsRebase: false, reasons: [] })
    expect(c.summary.join('\n')).toContain('Agent on another panel')
    expect(c.summary.join('\n')).not.toContain('Dana title') // Dana's change is not part of this proposal's diff
    expect(c.summary.join('\n')).not.toContain('p_goroutines')
    // the reviewer says which revision they looked at; if it is not the current one, refuse
    expect((await post(dana.key, `/proposals/${elsewhere}/apply`, { baseRevision: r1 })).body.code).toBe('stale-revision')
    const ok = await post(dana.key, `/proposals/${elsewhere}/apply`, { baseRevision: head })
    expect(ok.status, ok.text).toBe(200)
    const now = (await current(t.admin)).spec
    expect(now.panels[P0].title).toBe('Dana title')
    expect(now.panels[P1].title).toBe('Agent on another panel')
    expect(now.panels.p_goroutines).toBeUndefined()

    // rebase = edit with ops rebuilt against the current revision; then it applies
    const head2 = (await current(t.admin)).revision
    const edited = await call(agent.key, 'PUT', `/proposals/${overwrite}`, { changes: [{ name: 'overwrite', reason: 'rebased on Dana\'s title', ops: [{ op: 'replace', path: `/panels/${P0}/title`, value: 'Dana title (5xx)' }] }] })
    expect(edited.status, edited.text).toBe(200)
    expect(edited.body.proposal).toMatchObject({ baseRevision: head2, baseNumber: 4 })
    expect(edited.body.review).toMatchObject({ moved: false, needsRebase: false })
    expect((await post(dana.key, `/proposals/${overwrite}/apply`)).status).toBe(200)
    expect((await current(t.admin)).spec.panels[P0].title).toBe('Dana title (5xx)')
  })

  it('an agent can never apply its own proposal, even with the apply scope, unless the tenant sets agentsMayApply', async () => {
    const { t, r1, dana } = await setup()
    const agent = await makeKey(t.admin, ['dashboards:read', 'dashboards:write', 'dashboards:apply'], { name: 'eager agent', kind: 'agent' })
    const other = await makeKey(t.admin, ['dashboards:read', 'dashboards:write', 'dashboards:apply'], { name: 'second agent', kind: 'agent' })
    const ops = [{ op: 'replace', path: `/panels/${P0}/title`, value: 'By the agent' }]

    // its direct patch is its own change too: it becomes a proposal, not a revision
    const direct = await call(agent.key, 'PATCH', '/dashboards/checkout_api', { ops, baseRevision: r1, message: 'just do it' })
    expect(direct.status).toBe(202)
    const id: string = direct.body.proposal.id
    expect((await current(t.admin)).number).toBe(1)

    const self = await post(agent.key, `/proposals/${id}/apply`)
    expect(self.status).toBe(403)
    expect(self.body.code).toBe('self-apply')
    expect(self.body.fix).toContain('agentsMayApply')
    expect((await post(agent.key, `/proposals/${id}/apply`, { dryRun: true })).status).toBe(403)
    // nor may it create, revert or delete directly
    for (const [m, p, b] of [['POST', '/dashboards', { spec: example('service_red', 'agent_made') }], ['DELETE', '/dashboards/checkout_api', {}], ['POST', '/dashboards/checkout_api/revisions/1/revert', { baseRevision: r1 }]] as const) {
      const res = await call(agent.key, m, p, b)
      expect(res.status, `${m} ${p}`).toBe(403)
      expect(res.body.code).toBe('agents-may-not-apply')
    }
    expect((await current(t.admin)).number).toBe(1)

    // a person proposes, the agent edits it: now it is partly the agent's work, and the agent still may not apply it
    const human = await propose(dana.key, { message: 'by dana', baseRevision: r1, changes: [{ name: 'c', reason: 'r', ops: [{ op: 'replace', path: `/panels/${P1}/title`, value: 'Dana proposes' }] }] })
    const hid: string = human.body.proposal.id
    const edited = await call(agent.key, 'PUT', `/proposals/${hid}`, { changes: [{ name: 'c', reason: 'agent rewrote it', ops: [{ op: 'replace', path: `/panels/${P1}/title`, value: 'Agent rewrote' }] }] })
    expect(edited.status, edited.text).toBe(200)
    expect(edited.body.proposal.editedBy).toEqual([{ subject: `key:${agent.id}`, kind: 'agent', name: 'eager agent' }])
    expect((await post(agent.key, `/proposals/${hid}/apply`)).body.code).toBe('self-apply')
    // a different reviewer may: it is not its own
    const byOther = await post(other.key, `/proposals/${hid}/apply`)
    expect(byOther.status, byOther.text).toBe(200)
    expect((await get(t.admin, '/dashboards/checkout_api/revisions')).body.items[0]).toMatchObject({ by: { kind: 'agent', name: 'second agent' }, proposedBy: { name: 'Dana' } })

    // the tenant opts in: now the agent may apply its own, and patch directly
    const set = await call(t.admin, 'PUT', '/settings/general', { value: { agentsMayApply: true } })
    expect(set.status, set.text).toBe(200)
    const again = await call(agent.key, 'PUT', `/proposals/${id}`, { ops })
    expect(again.status, again.text).toBe(200)
    const applied = await post(agent.key, `/proposals/${id}/apply`)
    expect(applied.status, applied.text).toBe(200)
    const base = (await current(t.admin)).revision
    const now = await call(agent.key, 'PATCH', '/dashboards/checkout_api', { ops: [{ op: 'replace', path: `/panels/${P0}/title`, value: 'Directly' }], baseRevision: base })
    expect(now.status).toBe(200)
    expect(now.body.outcome).toBe('applied')
    // and off again
    await call(t.admin, 'PUT', '/settings/general', { value: { agentsMayApply: false } })
    expect((await call(agent.key, 'PATCH', '/dashboards/checkout_api', { ops, baseRevision: now.body.revision })).status).toBe(202)
  })

  it('edit first, then apply: the revision is the approver\'s, the proposer and the editor are both on record', async () => {
    const { t, r1, agent, dana } = await setup()
    const id: string = (await propose(agent.key, { message: 'agent idea', baseRevision: r1, ops: [{ op: 'replace', path: `/panels/${P0}/title`, value: 'agent wording' }] })).body.proposal.id
    const stranger = await makeKey(t.admin, ['dashboards:read', 'dashboards:write'], { name: 'stranger' })
    expect((await call(stranger.key, 'PUT', `/proposals/${id}`, { ops: [{ op: 'replace', path: `/panels/${P0}/title`, value: 'hijack' }] })).status).toBe(403)
    expect((await call(dana.key, 'PUT', `/proposals/${id}`, { ops: [{ op: 'replace', path: '/panels/nope/title', value: 'x' }] })).status).toBe(422)
    const edit = await call(dana.key, 'PUT', `/proposals/${id}`, { message: 'agent idea, reworded', changes: [{ name: 'title', reason: 'Dana prefers this', ops: [{ op: 'replace', path: `/panels/${P0}/title`, value: 'dana wording' }] }] })
    expect(edit.status, edit.text).toBe(200)
    expect(edit.body.proposal).toMatchObject({ by: { name: 'investigator' }, editedBy: [{ name: 'Dana' }], message: 'agent idea, reworded' })
    const applied = await post(dana.key, `/proposals/${id}/apply`)
    expect(applied.status).toBe(200)
    expect((await current(t.admin)).spec.panels[P0].title).toBe('dana wording')
    expect((await get(t.admin, '/dashboards/checkout_api/revisions')).body.items[0]).toMatchObject({ by: { name: 'Dana' }, proposedBy: { name: 'investigator', kind: 'agent' }, proposal: id })
    expect((await auditOf(t.admin, `&targetId=${id}`)).map((a) => a.action)).toEqual(['proposal.apply', 'proposal.edit', 'proposal.create'])
  })

  it('decline needs a reason; a declined proposal stays declined; a proposer may withdraw their own', async () => {
    const { t, r1, agent, dana } = await setup()
    const ops = [{ op: 'replace', path: `/panels/${P0}/title`, value: 'x' }]
    const id: string = (await propose(agent.key, { message: 'm', baseRevision: r1, ops })).body.proposal.id
    expect((await post(dana.key, `/proposals/${id}/decline`, {})).status).toBe(422)
    expect((await post(dana.key, `/proposals/${id}/decline`, { reason: '' })).status).toBe(422)
    const stranger = await makeKey(t.admin, ['dashboards:read', 'dashboards:write'])
    expect((await post(stranger.key, `/proposals/${id}/decline`, { reason: 'no' })).status).toBe(403)
    const d = await post(dana.key, `/proposals/${id}/decline`, { reason: 'The old title is what the runbook says.' })
    expect(d.status).toBe(200)
    expect(d.body.proposal).toMatchObject({ status: 'declined', declineReason: 'The old title is what the runbook says.', resolvedBy: { name: 'Dana' } })
    for (const [m, p, b] of [['POST', `/proposals/${id}/apply`, {}], ['POST', `/proposals/${id}/decline`, { reason: 'again' }], ['PUT', `/proposals/${id}`, { ops }]] as const) {
      expect((await call(dana.key, m, p, b)).body.code, `${m} ${p}`).toBe('proposal-closed')
    }
    expect((await current(t.admin)).number).toBe(1)
    expect((await get(dana.key, '/proposals?status=declined')).body.items.map((p: any) => p.id)).toEqual([id])

    const mine: string = (await propose(agent.key, { message: 'm2', baseRevision: r1, ops })).body.proposal.id
    const w = await post(agent.key, `/proposals/${mine}/decline`, { reason: 'Superseded by my next proposal.' })
    expect(w.status).toBe(200)
    expect(w.body.proposal.resolvedBy).toMatchObject({ kind: 'agent' })
  })

  it('proposals expire after 30 days: refused at once when overdue, closed by the alarm, exactly one audit entry', async () => {
    const { t, r1, agent, dana } = await setup()
    const stub = stubOf(t.tenant)
    const ops = [{ op: 'replace', path: `/panels/${P0}/title`, value: 'x' }]
    const res = await propose(agent.key, { message: 'm', baseRevision: r1, ops })
    const id: string = res.body.proposal.id
    const expires = Date.parse(res.body.proposal.expiresAt)
    expect(await runInDurableObject(stub, (_i, s) => s.storage.getAlarm())).toBe(expires)
    const second: string = (await propose(agent.key, { message: 'm2', baseRevision: r1, ops })).body.proposal.id

    await runInDurableObject(stub, (_i, s) => void s.storage.sql.exec('UPDATE proposals SET expires_at = ? WHERE tenant = ? AND id = ?', Date.now() - 1000, t.tenant, id))
    // before any alarm has run it already counts as expired
    expect((await get(dana.key, `/proposals/${id}`)).body.proposal.status).toBe('expired')
    expect((await post(dana.key, `/proposals/${id}/apply`)).body).toMatchObject({ code: 'proposal-closed', status: 'expired' })
    expect((await get(dana.key, '/proposals')).body.items.map((p: any) => p.id)).toEqual([second])
    expect((await get(dana.key, '/proposals?status=expired')).body.items.map((p: any) => p.id)).toEqual([id])

    await runInDurableObject(stub, (i: Tenant) => i.alarm())
    await runInDurableObject(stub, (i: Tenant) => i.alarm())
    expect(await runInDurableObject(stub, (_i, s) => s.storage.sql.exec('SELECT status FROM proposals WHERE id = ?', id).one().status)).toBe('expired')
    const audit = await auditOf(t.admin, '&action=proposal.expire')
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ by: { subject: 'system', kind: 'system' }, target: { id } })
    // one alarm, now at the next deadline; gone when nothing is open
    expect(await runInDurableObject(stub, (_i, s) => s.storage.getAlarm())).toBe(Date.parse((await get(dana.key, `/proposals/${second}`)).body.proposal.expiresAt))
    await post(dana.key, `/proposals/${second}/decline`, { reason: 'tidy' })
    expect(await runInDurableObject(stub, (_i, s) => s.storage.getAlarm())).toBeNull()
    expect(await runDurableObjectAlarm(stub)).toBe(false)

    // the tenant can shorten the default
    await call(t.admin, 'PUT', '/settings/general', { value: { proposalTtlDays: 7 } })
    const short = await propose(agent.key, { message: 'm3', baseRevision: r1, ops })
    expect(Date.parse(short.body.proposal.expiresAt) - Date.parse(short.body.proposal.createdAt)).toBe(7 * 86_400_000)
  })

  it('creating: stale base, invalid result, no-op, missing reasons and dry run', async () => {
    const { t, r1, agent, dana } = await setup()
    const ops = [{ op: 'replace', path: `/panels/${P0}/title`, value: 'x' }]
    expect((await propose(agent.key, { baseRevision: r1, ops })).status).toBe(422) // no message
    expect((await propose(agent.key, { message: 'm', ops })).status).toBe(428)
    expect((await propose(agent.key, { message: 'm', baseRevision: r1, changes: [{ name: 'a', ops }] })).status).toBe(422) // a change without a reason
    expect((await propose(agent.key, { message: 'm', baseRevision: r1, changes: [{ name: 'a', reason: 'r', ops }, { name: 'a', reason: 'r', ops }] })).status).toBe(422)
    expect((await propose(agent.key, { message: 'm', baseRevision: r1, changes: [{ name: 'Bad Name', reason: 'r', ops }] })).status).toBe(422)
    expect((await propose(agent.key, { message: 'm', baseRevision: r1, ops, changes: [] })).status).toBe(422)
    expect((await propose(agent.key, { message: 'm', baseRevision: r1, ops: [{ op: 'remove', path: `/queries/${Object.keys(SPEC.queries)[0]}` }] })).body.code).toBe('invalid-dashboard')
    expect((await propose(agent.key, { message: 'm', baseRevision: r1, ops: [{ op: 'test', path: '/metadata/id', value: 'checkout_api' }] })).status).toBe(422)
    expect((await propose(agent.key, { message: 'm', baseRevision: 'f'.repeat(32), ops })).body.code).toBe('stale-revision')
    expect((await post(agent.key, '/dashboards/nope/proposals', { message: 'm', baseRevision: r1, ops })).status).toBe(404)

    const dry = await propose(agent.key, { message: 'm', baseRevision: r1, ops, dryRun: true })
    expect(dry.status).toBe(202)
    expect(dry.body).toMatchObject({ dryRun: true, outcome: 'proposed', review: { needsRebase: false, result: { number: 2 } } })
    expect((await get(dana.key, '/proposals?status=all')).body.items).toHaveLength(0)
    expect((await get(dana.key, `/proposals/${dry.body.proposal.id}`)).status).toBe(404)

    // someone who could apply directly may still ask for review
    const asked = await call(dana.key, 'PATCH', '/dashboards/checkout_api', { ops, baseRevision: r1, propose: true, message: 'second opinion please' })
    expect(asked.status).toBe(202)
    expect((await current(t.admin)).number).toBe(1)
    // a person may apply their own proposal
    expect((await post(dana.key, `/proposals/${asked.body.proposal.id}/apply`)).status).toBe(200)
    // a deleted dashboard's proposals cannot be applied
    const p2: string = (await propose(agent.key, { message: 'm', baseRevision: (await current(t.admin)).revision, ops: [{ op: 'replace', path: `/panels/${P0}/title`, value: 'y' }] })).body.proposal.id
    await call(dana.key, 'DELETE', '/dashboards/checkout_api')
    expect((await post(dana.key, `/proposals/${p2}/apply`)).status).toBe(404)
    expect((await get(dana.key, `/proposals/${p2}`)).body).toMatchObject({ review: null, proposal: { status: 'open' } })
  })
})
