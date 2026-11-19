import { describe, expect, it } from 'vitest'
import { controlCall, createDashboard, example, harness, makeKey, mcpClient, newTenant, reset, telemetry } from './helpers'

/**
 * A scripted agent task end to end, as an agent would do it over MCP: every step takes
 * what it needs from the previous step's result, nothing is hard-coded except the goal.
 *
 * Goal: "add a checkout 5xx-per-second panel to the service dashboard".
 * search → describe → validate → query → write_dashboard dry_run (catches a wrong metric,
 * suggests the right one) → fix → dry_run clean → propose (two named changes) → a person
 * applies ONE of them through the control plane → get_dashboard shows it, list_revisions
 * says who applied it and who proposed it.
 */
describe('scripted agent task', () => {
  it('discover, draft, catch a mistake, fix, propose; a person applies part; the agent sees it', async () => {
    reset()
    const h = harness()
    const t = await newTenant('e2e')
    telemetry(h, t.tenant)
    await createDashboard(t.admin, example('service_red'), 'Created by the platform team')
    const agentKey = (await makeKey(t.admin, ['read', 'dashboards:read', 'dashboards:write'], { kind: 'agent', name: 'dashboard agent' })).key
    const dana = (await makeKey(t.admin, ['dashboards:read', 'dashboards:apply'], { kind: 'key', name: 'Dana' })).key
    const client = await mcpClient(h, agentKey)
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = (await client.callTool({ name, arguments: args })) as any
      return { text: r.content[0].text as string, s: r.structuredContent, isError: r.isError === true }
    }

    // 1. Discover: which metric counts checkout's requests?
    const search = await call('search_telemetry', { q: 'checkout requests' })
    expect(search.isError).toBe(false)
    const entity = search.s.data.entities.find((e: any) => e.label === 'service' && e.value === 'checkout')
    const metric = entity.metrics.find((m: string) => m.endsWith('_requests_total') && m.startsWith('http_server'))
    expect(metric).toBe('http_server_requests_total')

    // 2. Describe it: is it a counter, and what are the status values?
    const desc = await call('describe_metric', { name: metric })
    expect(desc.s.type).toBe('counter')
    const statuses = desc.s.data.items.find((i: any) => i.label === 'status').top.map((v: any) => v.value)
    expect(statuses).toContain('500')

    // 3. Draft the expression — with a typo in the metric name, as agents do — and validate it.
    const typo = metric.replace('requests', 'request')
    const draft = `sum(rate(${typo}{env="prod",service="checkout",status=~"5.."}[5m]))`
    const v1 = await call('validate_query', { expr: draft })
    expect(v1.s.valid).toBe(true) // syntactically fine...
    expect(v1.s.data.items.find((i: any) => i.code === 'unknown-metric').suggestions[0]).toBe(metric) // ...but the name is wrong

    // 4. Query the corrected expression to see real numbers.
    const fixed = draft.replace(typo, v1.s.data.items.find((i: any) => i.code === 'unknown-metric').suggestions[0])
    const q = await call('query', { expr: fixed, from: 'now-1h' })
    expect(q.s.seriesTotal).toBe(1)
    expect(q.s.data.items[0].last).toBeGreaterThan(1)

    // 5. Read the dashboard first (reuse before create), then dry-run the panel — with the
    //    typo, as an agent that skipped step 3 would. The dry run catches it.
    const spec = await call('get_dashboard', { id: 'service_red', view: 'spec' })
    const base = spec.s.revision
    const ops = (expr: string) => [
      { op: 'add', path: '/queries/checkout_5xx_rate', value: { lang: 'promql', expr: expr.replace('[5m]', '[$__rate]') } },
      { op: 'add', path: '/panels/checkout_5xx_rate', value: { kind: 'stat', title: 'Checkout 5xx per second', description: 'Server errors per second for checkout in prod. Above 1 per second, page.', unit: 'errors/s', queries: ['checkout_5xx_rate'], thresholds: [{ above: 1, level: 'crit' }] } },
      { op: 'add', path: '/layout/rows/0/items/-', value: 'checkout_5xx_rate' },
    ]
    const dry1 = await call('write_dashboard', { id: 'service_red', base_revision: base, ops: ops(draft) })
    expect(dry1.s.mode).toBe('dry_run')
    const codes = dry1.s.data.items.filter((i: any) => i.code).map((i: any) => i.code)
    expect(codes).toEqual(expect.arrayContaining(['unknown-metric', 'no-data']))
    const suggestion = dry1.s.data.items.find((i: any) => i.code === 'unknown-metric').suggestions[0]
    expect(suggestion).toBe(metric)

    // 6. Fix with the suggestion and dry-run again: clean, with a preview that has data.
    const dry2 = await call('write_dashboard', { id: 'service_red', base_revision: base, ops: ops(draft.replace(typo, suggestion)) })
    expect(dry2.s.counts.warnings).toBe(0)
    const preview = dry2.s.data.items.find((i: any) => i.preview).preview
    expect(preview.noData).toBe(false)
    expect(preview.state).toBe('crit') // checkout is in an incident in the fake data

    // 7. Propose: the panel, and a second change the reviewer may not want.
    const prop = await call('write_dashboard', {
      id: 'service_red',
      mode: 'propose',
      base_revision: base,
      message: 'Checkout errors per second',
      changes: [
        { name: 'add_checkout_5xx_rate', reason: 'Errors per second shows the size of an incident; the ratio hides it at low traffic.', ops: ops(draft.replace(typo, suggestion)) },
        { name: 'retitle', reason: 'Name the service in the title.', ops: [{ op: 'replace', path: '/metadata/title', value: 'Checkout RED' }] },
      ],
    })
    expect(prop.isError).toBe(false)
    const proposal = prop.s.proposal.id
    expect(proposal).toMatch(/^p_/)

    // 7b. The agent cannot apply its own proposal through this surface.
    const self = await call('write_dashboard', { id: 'service_red', mode: 'apply', base_revision: base, ops: ops(fixed) })
    expect(self.isError).toBe(true)

    // 8. A person reviews in the control plane and applies only the panel.
    const review = await controlCall(dana, 'GET', `/proposals/${proposal}`)
    expect(review.body.review.needsRebase).toBe(false)
    const applied = await controlCall(dana, 'POST', `/proposals/${proposal}/apply`, { changes: ['add_checkout_5xx_rate'] })
    expect(applied.status).toBe(200)
    expect(applied.body.appliedChanges).toEqual(['add_checkout_5xx_rate'])
    expect(applied.body.skippedChanges).toEqual(['retitle'])

    // 9. The agent sees the result: the panel is there, the title is not changed.
    const after = await call('get_dashboard', { id: 'service_red' })
    expect(after.s.number).toBe(2)
    expect(after.text).toMatch(/panel checkout_5xx_rate \| stat \| Checkout 5xx per second \| unit errors\/s/)
    expect(after.text).toMatch(/title: Service RED overview/)
    const revs = await call('list_revisions', { id: 'service_red' })
    expect(revs.s.data.items[0]).toMatchObject({ number: 2, kind: 'apply', by: { kind: 'key', name: 'Dana' }, proposedBy: { kind: 'agent', name: 'dashboard agent' } })
    // And reads it with data: the new panel breaches, so it comes first among the crit panels.
    const read = await call('read_dashboard', { id: 'service_red', panels: ['checkout_5xx_rate', 'throughput'] })
    expect(read.s.data.panels[0]).toMatchObject({ id: 'checkout_5xx_rate', badge: 'CRIT' })
    await client.close()
  })
})
