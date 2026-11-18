import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { lint, revisionOf, validate } from '../../dashboard/src/index.ts'
import type { Tenant } from '../src/tenant'
import { EXAMPLES, auditOf, call, createDashboard, example, get, makeKey, newTenant, post, stubOf } from './helpers'

const patch = (key: string, id: string, body: unknown, headers?: Record<string, string>) => call(key, 'PATCH', `/dashboards/${id}`, body, headers)
const firstPanel = (spec: any): string => Object.keys(spec.panels)[0]!
const retitle = (spec: any, title: string) => [{ op: 'replace', path: `/panels/${firstPanel(spec)}/title`, value: title }]

/** Everything observable about a tenant's dashboards, for "nothing changed" assertions. */
async function snapshot(admin: string): Promise<unknown> {
  const list = (await get(admin, '/dashboards?limit=200')).body
  const deleted = (await get(admin, '/dashboards?deleted=true&limit=200')).body
  const revisions: Record<string, unknown> = {}
  for (const d of list.items) revisions[d.id] = (await get(admin, `/dashboards/${d.id}/revisions?limit=200`)).body
  return { list, deleted, revisions, proposals: (await get(admin, '/proposals?status=all&limit=200')).body, audit: (await auditOf(admin)).length }
}

describe('dashboards', () => {
  it('the three example dashboards round-trip exactly, with the columns of the dashboards screen', async () => {
    const t = await newTenant()
    for (const [id, spec] of Object.entries(EXAMPLES)) {
      expect(validate(spec).ok).toBe(true)
      const res = await post(t.admin, '/dashboards', { spec, owner: 'platform', message: 'import' })
      expect(res.status, res.text).toBe(201)
      expect(res.body).toMatchObject({ number: 1, revision: revisionOf(spec), lint: lint(spec) })
      expect(res.headers.get('ETag')).toBe(`"${revisionOf(spec)}"`)
      const back = await get(t.admin, `/dashboards/${id}`)
      expect(back.status).toBe(200)
      expect(back.body.spec).toEqual(spec)
      expect(JSON.stringify(back.body.spec)).toBe(JSON.stringify(spec)) // key order too
      expect(back.body.revision).toBe(revisionOf(spec))
      expect(back.headers.get('ETag')).toBe(`"${revisionOf(spec)}"`)
      const rev1 = await get(t.admin, `/dashboards/${id}/revisions/1`)
      expect(rev1.body.spec).toEqual(spec)
      expect(rev1.body).toMatchObject({ number: 1, kind: 'create', message: 'import', current: true })
    }
    const list = await get(t.admin, '/dashboards')
    expect(list.body.total).toBe(3)
    expect(list.body.items.map((d: any) => d.id)).toEqual(Object.keys(EXAMPLES).sort())
    const red: any = EXAMPLES.service_red
    const row = list.body.items.find((d: any) => d.id === 'service_red')
    expect(row).toMatchObject({ name: red.metadata.title, intent: red.metadata.intent, tags: red.metadata.tags, owner: 'platform', number: 1, state: null })
    expect(row.lastChangedBy).toEqual({ subject: `key:${t.adminId}`, kind: 'key', name: 'first admin key' })
    expect(row.panels).toBeGreaterThanOrEqual(Object.keys(red.panels).length) // fragment instances count as the panels they render
    expect(Date.parse(row.lastChangedAt)).toBeGreaterThan(Date.now() - 60_000)
  })

  it('create: validation errors refuse with path and suggestion; lint warnings are returned and do not refuse', async () => {
    const t = await newTenant()
    const bad = example('service_red', 'bad_one')
    bad.panels[firstPanel(bad)].unit = 'seconds'
    bad.metadata.titel = 'oops'
    const res = await post(t.admin, '/dashboards', { spec: bad })
    expect(res.status).toBe(422)
    expect(res.body.code).toBe('invalid-dashboard')
    expect(res.headers.get('Content-Type')).toContain('application/problem+json')
    expect(res.body.errors.length).toBeGreaterThanOrEqual(2)
    for (const e of res.body.errors) expect(e).toMatchObject({ path: expect.stringMatching(/^\//), code: expect.any(String), message: expect.any(String) })
    expect(res.body.errors.some((e: any) => /Did you mean/.test(e.suggestion ?? ''))).toBe(true)
    expect((await get(t.admin, '/dashboards')).body.total).toBe(0)
    expect((await post(t.admin, '/dashboards', { spec: 'not a spec' })).status).toBe(422)
    expect((await post(t.admin, '/dashboards', {})).status).toBe(422)

    const lazy = example('service_red', 'lazy')
    lazy.metadata.intent = 'Stuff.'
    const ok = await post(t.admin, '/dashboards', { spec: lazy })
    expect(ok.status).toBe(201)
    expect(ok.body.lint.length).toBeGreaterThan(0)
    expect(ok.body.lint).toEqual(lint(lazy))

    expect((await post(t.admin, '/dashboards', { spec: lazy })).body.code).toBe('dashboard-exists')
  })

  it('get: spec, outline, resolved with variables, and old revisions', async () => {
    const t = await newTenant()
    const created = await createDashboard(t.admin, 'red')
    const spec = example('service_red', 'red')
    const outline = await get(t.admin, '/dashboards/red?view=outline')
    expect(outline.body.spec).toBeUndefined()
    expect(outline.body.outline.metadata).toEqual(spec.metadata)
    expect(outline.body.outline.panels.length).toBe(created.body.dashboard.panels)
    expect(outline.body.outline.panels[0]).toMatchObject({ id: expect.any(String), kind: expect.any(String), title: expect.any(String) })
    expect(outline.text.length).toBeLessThan(JSON.stringify(spec).length / 2)

    const resolved = await get(t.admin, '/dashboards/red?view=resolved&var.env=staging&var.service=cart&var.route=/a&var.route=/b')
    expect(resolved.status).toBe(200)
    expect(resolved.body.resolved.variables).toMatchObject({ env: { values: ['staging'] }, service: { values: ['cart'] }, route: { values: ['/a', '/b'] } })
    expect(resolved.body.resolved.queries.req_rate.expr).toContain('env="staging"')
    expect(resolved.body.resolved.queries.req_rate.expr).toContain('service="cart"')
    expect(resolved.body.resolved.queries.req_rate.expr).not.toContain('$env')

    await patch(t.admin, 'red', { ops: retitle(spec, 'Renamed'), baseRevision: created.body.revision })
    expect((await get(t.admin, '/dashboards/red?revision=1')).body).toMatchObject({ number: 1, current: false, spec })
    expect((await get(t.admin, '/dashboards/red')).body).toMatchObject({ number: 2, current: true })
    for (const path of ['/dashboards/red?view=pdf', '/dashboards/red?revision=9', '/dashboards/red?revision=x', '/dashboards/nope', '/dashboards/Red', '/dashboards/red/revisions/0', '/dashboards/red/revisions/3']) {
      const res = await get(t.admin, path)
      expect([400, 404], path).toContain(res.status)
      expect(res.body.fix, path).toBeTruthy()
    }
  })

  it('list: search by name, intent, tag and owner; pages by opaque cursor', async () => {
    const t = await newTenant()
    await createDashboard(t.admin, 'checkout_api', 'service_red', { owner: 'payments' })
    await createDashboard(t.admin, 'cart', 'service_red', { owner: 'storefront' })
    await createDashboard(t.admin, 'nodes', 'k8s_node_overview', { owner: 'platform' })
    await createDashboard(t.admin, 'ingest', 'viz_ingest_pipeline', { owner: 'platform' })
    await createDashboard(t.admin, 'catalog', 'service_red', { owner: 'storefront' })
    const ids = async (qs: string) => (await get(t.admin, `/dashboards${qs}`)).body.items.map((d: any) => d.id)
    expect(await ids('?q=checkout')).toEqual(['checkout_api'])
    expect(await ids('?q=storefront')).toEqual(['cart', 'catalog'])
    expect(await ids('?owner=platform')).toEqual(['ingest', 'nodes'])
    expect(await ids(`?q=${encodeURIComponent((EXAMPLES.k8s_node_overview as any).metadata.title.slice(0, 8))}`)).toEqual(['nodes'])
    expect(await ids(`?tag=${(EXAMPLES.service_red as any).metadata.tags[0]}`)).toEqual(['cart', 'catalog', 'checkout_api'])
    expect(await ids('?q=%25')).toEqual([]) // a literal %, not a wildcard
    expect(await ids('?q=zzz')).toEqual([])

    const seen: string[] = []
    let cursor: string | null = null
    let pages = 0
    do {
      const res: any = await get(t.admin, `/dashboards?limit=2${cursor ? `&cursor=${cursor}` : ''}`)
      expect(res.body.total).toBe(5)
      seen.push(...res.body.items.map((d: any) => d.id))
      cursor = res.body.next
      pages++
    } while (cursor)
    expect(pages).toBe(3)
    expect(seen).toEqual(['cart', 'catalog', 'checkout_api', 'ingest', 'nodes'])
    for (const bad of ['?cursor=abc', '?cursor=W10', `?cursor=${btoa('[1]')}`, '?limit=0', '?limit=500', '?limit=x']) {
      const res = await get(t.admin, `/dashboards${bad}`)
      expect(res.status, bad).toBe(400)
      expect(res.body.fix).toBeTruthy()
    }
  })

  it('patch: against baseRevision or If-Match; history says who, when, why and what', async () => {
    const t = await newTenant()
    const created = await createDashboard(t.admin, 'red')
    const spec = example('service_red', 'red')
    const r1: string = created.body.revision

    const none = await patch(t.admin, 'red', { ops: retitle(spec, 'A') })
    expect(none.status).toBe(428)
    expect(none.body.fix).toContain('If-Match')

    const p1 = await patch(t.admin, 'red', { ops: retitle(spec, 'Errors, as a ratio'), baseRevision: r1, message: 'clearer title' })
    expect(p1.status, p1.text).toBe(200)
    expect(p1.body).toMatchObject({ outcome: 'applied', number: 2, previousRevision: r1 })
    expect(p1.body.summary.join('\n')).toContain('Errors, as a ratio')
    const want = structuredClone(spec)
    want.panels[firstPanel(spec)].title = 'Errors, as a ratio'
    expect(p1.body.revision).toBe(revisionOf(want))
    expect(p1.headers.get('ETag')).toBe(`"${p1.body.revision}"`)
    expect((await get(t.admin, '/dashboards/red')).body.spec).toEqual(want)

    // If-Match instead of baseRevision
    const p2 = await patch(t.admin, 'red', { ops: [{ op: 'add', path: '/metadata/tags/-', value: 'tier-1' }], message: 'tag' }, { 'If-Match': `"${p1.body.revision}"` })
    expect(p2.status, p2.text).toBe(200)
    expect(p2.body.number).toBe(3)
    // both, disagreeing
    expect((await patch(t.admin, 'red', { ops: retitle(spec, 'B'), baseRevision: r1 }, { 'If-Match': `"${p2.body.revision}"` })).status).toBe(400)
    expect((await patch(t.admin, 'red', { ops: retitle(spec, 'B') }, { 'If-Match': '*' })).status).toBe(400)

    // a patch that would make it invalid changes nothing and says why
    const inv = await patch(t.admin, 'red', { ops: [{ op: 'remove', path: `/queries/${Object.keys(spec.queries)[0]}` }], baseRevision: p2.body.revision })
    expect(inv.status).toBe(422)
    expect(inv.body.errors.length).toBeGreaterThan(0)
    const failing = await patch(t.admin, 'red', { ops: [{ op: 'replace', path: '/panels/nope/title', value: 'x' }], baseRevision: p2.body.revision })
    expect(failing.status).toBe(422)
    expect(failing.body.errors[0].code).toBe('patch-failed')
    expect((await patch(t.admin, 'red', { ops: [{ op: 'replace', path: '/metadata/id', value: 'other' }], baseRevision: p2.body.revision })).status).toBe(422)
    expect((await patch(t.admin, 'red', { ops: [], baseRevision: p2.body.revision })).status).toBe(422)
    expect((await patch(t.admin, 'red', { ops: retitle(spec, 'B'), baseRevision: p2.body.revision, base: 'typo' })).status).toBe(422)

    // a patch that changes nothing makes no revision and no audit entry
    const noop = await patch(t.admin, 'red', { ops: [{ op: 'test', path: '/metadata/id', value: 'red' }], baseRevision: p2.body.revision })
    expect(noop.status).toBe(200)
    expect(noop.body).toMatchObject({ outcome: 'unchanged', number: 3 })

    const revs = await get(t.admin, '/dashboards/red/revisions')
    expect(revs.body.items.map((r: any) => [r.number, r.kind, r.message])).toEqual([[3, 'patch', 'tag'], [2, 'patch', 'clearer title'], [1, 'create', 'Created']])
    expect(revs.body.current).toBe(3)
    for (const r of revs.body.items) {
      expect(r.by).toEqual({ subject: `key:${t.adminId}`, kind: 'key', name: 'first admin key' })
      expect(Date.parse(r.at)).toBeGreaterThan(Date.now() - 60_000)
      expect(r.summary.length).toBeGreaterThan(0)
      expect(r.spec).toBeUndefined()
    }
    expect(revs.body.items[1].summary.join(' ')).toContain('Errors, as a ratio')
    const paged = await get(t.admin, '/dashboards/red/revisions?limit=2')
    expect(paged.body.items.map((r: any) => r.number)).toEqual([3, 2])
    expect((await get(t.admin, `/dashboards/red/revisions?limit=2&cursor=${paged.body.next}`)).body.items.map((r: any) => r.number)).toEqual([1])
    expect((await auditOf(t.admin, '&targetId=red')).map((a) => a.action)).toEqual(['dashboard.patch', 'dashboard.patch', 'dashboard.create'])
  })

  it('a stale base gets 409 with the current revision and what changed underneath', async () => {
    const t = await newTenant()
    const created = await createDashboard(t.admin, 'red')
    const spec = example('service_red', 'red')
    const r1: string = created.body.revision
    const dana = await makeKey(t.admin, ['dashboards:read', 'dashboards:apply'], { name: 'Dana' })
    const p1 = await patch(dana.key, 'red', { ops: retitle(spec, 'Changed by Dana'), baseRevision: r1, message: 'dana was here' })
    expect(p1.status).toBe(200)

    const stale = await patch(t.admin, 'red', { ops: [{ op: 'replace', path: '/metadata/title', value: 'Mine' }], baseRevision: r1 })
    expect(stale.status).toBe(409)
    expect(stale.body).toMatchObject({ code: 'stale-revision', baseRevision: r1, currentRevision: p1.body.revision, currentNumber: 2 })
    expect(stale.body.changedUnderneath.join('\n')).toContain('Changed by Dana')
    expect(stale.body.revisionsSince).toHaveLength(1)
    expect(stale.body.revisionsSince[0]).toMatchObject({ number: 2, message: 'dana was here', by: { name: 'Dana', kind: 'key' } })
    expect(stale.headers.get('ETag')).toBe(`"${p1.body.revision}"`)
    expect(stale.body.fix).toContain('currentRevision')
    // the 409 is enough to retry correctly
    const retry = await patch(t.admin, 'red', { ops: [{ op: 'replace', path: '/metadata/title', value: 'Mine' }], baseRevision: stale.body.currentRevision })
    expect(retry.status).toBe(200)
    const now = (await get(t.admin, '/dashboards/red')).body.spec
    expect(now.metadata.title).toBe('Mine')
    expect(now.panels[firstPanel(spec)].title).toBe('Changed by Dana')

    // a base this dashboard never had
    const unknown = await patch(t.admin, 'red', { ops: retitle(spec, 'x'), baseRevision: 'f'.repeat(32) })
    expect(unknown.status).toBe(409)
    expect(unknown.body.changedUnderneath).toBeNull()
    // the same through If-Match
    expect((await patch(t.admin, 'red', { ops: retitle(spec, 'x') }, { 'If-Match': `"${r1}"` })).status).toBe(409)
  })

  it('concurrent patches against the same base: exactly one wins, every other gets a usable 409', async () => {
    const t = await newTenant()
    const created = await createDashboard(t.admin, 'red')
    const spec = example('service_red', 'red')
    const panels = Object.keys(spec.panels)
    for (const n of [2, 8]) {
      const base: string = (await get(t.admin, '/dashboards/red')).body.revision
      const before: number = (await get(t.admin, '/dashboards/red')).body.number
      const results = await Promise.all(
        Array.from({ length: n }, (_x, i) => patch(t.admin, 'red', { ops: [{ op: 'replace', path: `/panels/${panels[i]}/title`, value: `writer ${n}-${i}` }], baseRevision: base, message: `writer ${i}` })),
      )
      const winners = results.filter((r) => r.status === 200)
      const losers = results.filter((r) => r.status === 409)
      expect(winners).toHaveLength(1)
      expect(losers).toHaveLength(n - 1)
      const winner = results.findIndex((r) => r.status === 200)
      for (const l of losers) {
        expect(l.body).toMatchObject({ code: 'stale-revision', currentRevision: winners[0]!.body.revision, currentNumber: before + 1 })
        expect(l.body.changedUnderneath.join('\n')).toContain(`writer ${n}-${winner}`) // says what the winner did
        expect(l.body.revisionsSince[0].message).toBe(`writer ${winner}`)
      }
      const after = await get(t.admin, '/dashboards/red')
      expect(after.body.number).toBe(before + 1)
      const titles = panels.map((p) => after.body.spec.panels[p].title).filter((x: string) => x.startsWith(`writer ${n}-`))
      expect(titles).toEqual([`writer ${n}-${winner}`])
      // a loser rebuilds against the revision the 409 gave it, and both edits survive
      const loser = results.findIndex((r) => r.status === 409)
      const redo = await patch(t.admin, 'red', { ops: [{ op: 'replace', path: `/panels/${panels[loser]}/title`, value: `writer ${n}-${loser}` }], baseRevision: losers[0]!.body.currentRevision })
      expect(redo.status).toBe(200)
      const merged = (await get(t.admin, '/dashboards/red')).body.spec
      expect(merged.panels[panels[winner]!].title).toBe(`writer ${n}-${winner}`)
      expect(merged.panels[panels[loser]!].title).toBe(`writer ${n}-${loser}`)
    }
    expect(created.body.number).toBe(1)
    expect((await get(t.admin, '/dashboards/red/revisions')).body.items.map((r: any) => r.number)).toEqual([5, 4, 3, 2, 1])
  })

  it('revert makes a new revision with the old content; history is never rewritten', async () => {
    const t = await newTenant()
    const created = await createDashboard(t.admin, 'red')
    const spec = example('service_red', 'red')
    const p1 = await patch(t.admin, 'red', { ops: retitle(spec, 'Two'), baseRevision: created.body.revision })
    const p2 = await patch(t.admin, 'red', { ops: retitle(spec, 'Three'), baseRevision: p1.body.revision })

    expect((await post(t.admin, '/dashboards/red/revisions/1/revert', {})).status).toBe(428)
    expect((await post(t.admin, '/dashboards/red/revisions/1/revert', { baseRevision: p1.body.revision })).status).toBe(409)
    expect((await post(t.admin, '/dashboards/red/revisions/7/revert', { baseRevision: p2.body.revision })).status).toBe(404)
    const same = await post(t.admin, '/dashboards/red/revisions/3/revert', { baseRevision: p2.body.revision })
    expect(same.body).toMatchObject({ outcome: 'unchanged', number: 3 })

    const rv = await post(t.admin, '/dashboards/red/revisions/1/revert', {}, { 'If-Match': `"${p2.body.revision}"` })
    expect(rv.status, rv.text).toBe(200)
    expect(rv.body).toMatchObject({ outcome: 'applied', number: 4, revertedTo: 1, revision: created.body.revision })
    expect(rv.body.summary.join(' ')).toContain('Three')
    expect((await get(t.admin, '/dashboards/red')).body.spec).toEqual(spec)
    const revs = (await get(t.admin, '/dashboards/red/revisions')).body.items
    expect(revs.map((r: any) => [r.number, r.kind, r.revertedTo])).toEqual([[4, 'revert', 1], [3, 'patch', null], [2, 'patch', null], [1, 'create', null]])
    expect(revs[0].message).toBe('Reverted to revision 1')
    expect((await get(t.admin, '/dashboards/red/revisions/3')).body.spec.panels[firstPanel(spec)].title).toBe('Three')
  })

  it('delete is soft: not listed, restorable for 30 days, then purged by the alarm', async () => {
    const t = await newTenant()
    const created = await createDashboard(t.admin, 'red')
    await createDashboard(t.admin, 'keep', 'k8s_node_overview')
    const stub = stubOf(t.tenant)
    expect(await runInDurableObject(stub, (_i, s) => s.storage.getAlarm())).toBeNull() // idle: no alarm

    expect((await call(t.admin, 'DELETE', '/dashboards/red', { baseRevision: 'f'.repeat(32) })).status).toBe(409)
    const del = await call(t.admin, 'DELETE', '/dashboards/red')
    expect(del.status, del.text).toBe(200)
    const until = Date.parse(del.body.restorableUntil)
    expect(Math.abs(until - (Date.now() + 30 * 86_400_000))).toBeLessThan(60_000)
    expect(await runInDurableObject(stub, (_i, s) => s.storage.getAlarm())).toBe(until)

    expect((await get(t.admin, '/dashboards')).body).toMatchObject({ total: 1, items: [{ id: 'keep' }] })
    expect((await get(t.admin, '/dashboards?q=red')).body.items.map((d: any) => d.id)).not.toContain('red')
    const gone = await get(t.admin, '/dashboards/red')
    expect(gone.status).toBe(404)
    expect(gone.body.code).toBe('dashboard-deleted')
    expect(gone.body.fix).toContain('/restore')
    for (const [m, p, b] of [['PATCH', '/dashboards/red', { ops: [{ op: 'remove', path: '/metadata/tags' }], baseRevision: created.body.revision }], ['GET', '/dashboards/red/revisions', undefined], ['POST', '/dashboards/red/revisions/1/revert', { baseRevision: created.body.revision }], ['DELETE', '/dashboards/red', undefined]] as const) {
      expect((await call(t.admin, m, p, b)).status, `${m} ${p}`).toBe(404)
    }
    expect((await post(t.admin, '/dashboards', { spec: example('service_red', 'red') })).body.code).toBe('dashboard-deleted')
    const bin = await get(t.admin, '/dashboards?deleted=true')
    expect(bin.body.items).toHaveLength(1)
    expect(bin.body.items[0]).toMatchObject({ id: 'red', restorableUntil: del.body.restorableUntil, deletedBy: { kind: 'key' } })

    // restore: same content, same history
    expect((await post(t.admin, '/dashboards/keep/restore')).status).toBe(409)
    const res = await post(t.admin, '/dashboards/red/restore')
    expect(res.status).toBe(200)
    expect((await get(t.admin, '/dashboards/red')).body).toMatchObject({ revision: created.body.revision, number: 1 })
    expect((await get(t.admin, '/dashboards')).body.total).toBe(2)
    expect(await runInDurableObject(stub, (_i, s) => s.storage.getAlarm())).toBeNull()

    // delete again; when the 30 days are over the alarm purges it for good
    await call(t.admin, 'DELETE', '/dashboards/red')
    expect(await runDurableObjectAlarm(stub)).toBe(true) // early: nothing to purge yet
    expect((await get(t.admin, '/dashboards?deleted=true')).body.items).toHaveLength(1)
    await runInDurableObject(stub, (_i, s) => void s.storage.sql.exec('UPDATE dashboards SET purge_at = ? WHERE tenant = ? AND id = ?', Date.now() - 1, t.tenant, 'red'))
    await runInDurableObject(stub, (i: Tenant) => i.alarm())
    await runInDurableObject(stub, (i: Tenant) => i.alarm()) // at-least-once: a second run changes nothing
    expect((await get(t.admin, '/dashboards?deleted=true')).body.items).toHaveLength(0)
    expect((await post(t.admin, '/dashboards/red/restore')).status).toBe(404)
    expect(await runInDurableObject(stub, (_i, s) => s.storage.sql.exec("SELECT COUNT(*) AS n FROM revisions WHERE dashboard = 'red'").one().n)).toBe(0)
    expect(await runInDurableObject(stub, (_i, s) => s.storage.getAlarm())).toBeNull()
    const purges = (await auditOf(t.admin, '&action=dashboard.purge'))
    expect(purges).toHaveLength(1)
    expect(purges[0]).toMatchObject({ by: { kind: 'system' }, target: { type: 'dashboard', id: 'red' } })
    expect((await post(t.admin, '/dashboards', { spec: example('service_red', 'red') })).status).toBe(201) // the id is free again
  })

  it('every write has a dry run that reports exactly what the real call then does, and changes nothing', async () => {
    const t = await newTenant()
    const spec = example('service_red', 'red')
    const strip = (b: any) => JSON.parse(JSON.stringify(b, (k, v) => (['dryRun', 'createdAt', 'lastChangedAt', 'restorableUntil', 'deletedAt', 'at'].includes(k) ? undefined : v)))
    async function both(method: string, path: string, body: Record<string, unknown>): Promise<any> {
      const before = await snapshot(t.admin)
      const dry = await call(t.admin, method, path, { ...body, dryRun: true })
      expect(dry.body.dryRun, `${method} ${path}`).toBe(true)
      expect(await snapshot(t.admin), `${method} ${path} dry run changed something`).toEqual(before)
      const real = await call(t.admin, method, path, body)
      expect(real.status).toBe(dry.status)
      expect(real.body.dryRun).toBeUndefined()
      expect(strip(real.body), `${method} ${path}`).toEqual(strip(dry.body))
      expect(real.headers.get('ETag')).toBe(dry.headers.get('ETag'))
      expect(await snapshot(t.admin)).not.toEqual(before)
      return real.body
    }
    const c = await both('POST', '/dashboards', { spec, owner: 'payments' })
    const p = await both('PATCH', '/dashboards/red', { ops: retitle(spec, 'Dry then wet'), baseRevision: c.revision, message: 'm' })
    expect(p.number).toBe(2)
    await both('PUT', '/dashboards/red/owner', { owner: 'storefront' })
    const r = await both('POST', '/dashboards/red/revisions/1/revert', { baseRevision: p.revision })
    expect(r.number).toBe(3)
    await both('DELETE', '/dashboards/red', {})
    await both('POST', '/dashboards/red/restore', {})

    // dry runs of things that would fail report the same failure
    const stale = await call(t.admin, 'PATCH', '/dashboards/red', { ops: retitle(spec, 'x'), baseRevision: p.revision, dryRun: true })
    expect(stale.status).toBe(409)
    const invalid = await post(t.admin, '/dashboards', { spec: { ...example('service_red', 'other'), panels: {} }, dryRun: true })
    expect(invalid.status).toBe(422)
    // ?dryRun=true is the same switch
    const q = await call(t.admin, 'DELETE', '/dashboards/red?dryRun=true')
    expect(q.body.dryRun).toBe(true)
    expect((await get(t.admin, '/dashboards/red')).status).toBe(200)
  })

  it('caps: revisions per dashboard, bytes per tenant and spec size refuse with clear errors', async () => {
    const t = await newTenant()
    const stub = stubOf(t.tenant)
    const created = await createDashboard(t.admin, 'red')
    const spec = example('service_red', 'red')
    const bytes = JSON.stringify(spec).length
    const setCaps = (caps: Record<string, number>) => runInDurableObject(stub, (i: Tenant) => void Object.assign(i.caps, caps))

    await setCaps({ maxRevisionsPerDashboard: 2 })
    const p1 = await patch(t.admin, 'red', { ops: retitle(spec, 'two'), baseRevision: created.body.revision })
    expect(p1.status).toBe(200)
    const p2 = await patch(t.admin, 'red', { ops: retitle(spec, 'three'), baseRevision: p1.body.revision })
    expect(p2.status).toBe(409)
    expect(p2.body).toMatchObject({ code: 'too-many-revisions', limit: 2 })
    expect(p2.body.fix).toBeTruthy()
    expect((await get(t.admin, '/dashboards/red')).body.number).toBe(2)

    await setCaps({ maxRevisionsPerDashboard: 500, maxTenantBytes: Math.round(bytes * 2.5) })
    const full = await post(t.admin, '/dashboards', { spec: example('service_red', 'another') })
    expect(full.status).toBe(409)
    expect(full.body.code).toBe('tenant-storage-full')
    expect(full.body.usedBytes).toBeGreaterThan(bytes * 2 - 200)
    expect(full.body.limitBytes).toBe(Math.round(bytes * 2.5))
    expect((await get(t.admin, '/dashboards')).body.total).toBe(1) // the half-made dashboard did not stay

    await setCaps({ maxTenantBytes: 1 << 30, maxSpecBytes: 1000 })
    const big = await post(t.admin, '/dashboards', { spec: example('service_red', 'big') })
    expect(big.status).toBe(413)
    expect(big.body).toMatchObject({ code: 'spec-too-large', limitBytes: 1000 })

    await setCaps({ maxSpecBytes: 1 << 20, maxDashboards: 1 })
    expect((await post(t.admin, '/dashboards', { spec: example('service_red', 'big') })).body.code).toBe('too-many-dashboards')
  })

  it('scopes: read cannot write; write without apply proposes; owner can be set', async () => {
    const t = await newTenant()
    const created = await createDashboard(t.admin, 'red')
    const spec = example('service_red', 'red')
    const reader = await makeKey(t.admin, ['dashboards:read'])
    const writer = await makeKey(t.admin, ['dashboards:write'])
    const sender = await makeKey(t.admin, ['write', 'read'])

    expect((await get(reader.key, '/dashboards/red')).status).toBe(200)
    expect((await get(sender.key, '/dashboards/red')).status).toBe(403)
    expect((await get(sender.key, '/dashboards')).status).toBe(403)
    for (const [m, p, b] of [['PATCH', '/dashboards/red', { ops: retitle(spec, 'x'), baseRevision: created.body.revision }], ['POST', '/dashboards', { spec: example('service_red', 'n') }], ['DELETE', '/dashboards/red', {}], ['POST', '/dashboards/red/revisions/1/revert', { baseRevision: created.body.revision }], ['PUT', '/dashboards/red/owner', { owner: 'x' }], ['POST', '/dashboards/red/restore', {}]] as const) {
      const res = await call(reader.key, m, p, b)
      expect(res.status, `${m} ${p}`).toBe(403)
      expect(res.body.code).toBe('missing-scope')
    }
    // write without apply: a patch becomes a proposal, the dashboard is untouched
    const proposed = await patch(writer.key, 'red', { ops: retitle(spec, 'Proposed title'), baseRevision: created.body.revision, message: 'please' })
    expect(proposed.status).toBe(202)
    expect(proposed.body.outcome).toBe('proposed')
    expect((await get(t.admin, '/dashboards/red')).body.number).toBe(1)
    // ... and cannot create, delete or revert for real, but can have a new spec checked
    expect((await post(writer.key, '/dashboards', { spec: example('service_red', 'n') })).status).toBe(403)
    const dry = await post(writer.key, '/dashboards', { spec: example('service_red', 'n'), dryRun: true })
    expect(dry.status).toBe(201)
    expect(dry.body).toMatchObject({ dryRun: true, permitted: false, number: 1 })
    expect((await call(writer.key, 'DELETE', '/dashboards/red')).status).toBe(403)

    const o = await call(t.admin, 'PUT', '/dashboards/red/owner', { owner: 'payments' })
    expect(o.body.dashboard.owner).toBe('payments')
    expect((await call(t.admin, 'PUT', '/dashboards/red/owner', { owner: 'payments' })).body.outcome).toBe('unchanged')
    expect((await call(t.admin, 'PUT', '/dashboards/red/owner', { owner: null })).body.dashboard.owner).toBeNull()
    expect((await call(t.admin, 'PUT', '/dashboards/red/owner', {})).status).toBe(422)
  })
})
