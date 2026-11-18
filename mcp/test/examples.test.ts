import { beforeAll, describe, expect, it } from 'vitest'
import { type Harness, type Key, createDashboard, example, harness, makeKey, newTenant, reset, rest, telemetry, type TestTenant } from './helpers'
import { dataRegions } from '../src/untrusted'

/**
 * The three dashboards in dashboard/examples, read through read_dashboard with the fake
 * query service: each fits 2,000 tokens, and the panels that breach their thresholds come
 * first. Also the measurements quoted in the README (tokens per budget, wall time).
 */

let h: Harness
let t: TestTenant
let agent: Key
const NAMES = ['service_red', 'k8s_node_overview', 'viz_ingest_pipeline'] as const

beforeAll(async () => {
  reset()
  h = harness()
  t = await newTenant('examples')
  telemetry(h, t.tenant)
  agent = await makeKey(t.admin, ['read', 'dashboards:read'], { kind: 'agent' })
  for (const n of NAMES) await createDashboard(t.admin, example(n))
})

/** The rank of a panel's badge: breaching first, then anomalous, then the rest. */
const rank = (badge: string): number => ({ CRIT: 0, WARN: 1, INFO: 2, OUTLIER: 3 } as Record<string, number>)[badge] ?? 4

describe('read_dashboard on the examples', () => {
  for (const name of NAMES) {
    it(`${name}: fits 2,000 tokens, breaching panels first`, async () => {
      const r = await rest(h, agent.key, 'read_dashboard', { id: name })
      expect(r.status).toBe(200)
      expect(r.text.length).toBeLessThanOrEqual(8000)
      expect(r.structured.tokens).toBeLessThanOrEqual(2000)
      const panels = r.structured.data.panels as { id: string; badge: string; state: string | null }[]
      expect(panels.length).toBeGreaterThan(0)
      // At least one panel breaches in each example (the fake has an incident in each).
      expect(panels[0]!.badge === 'CRIT' || panels[0]!.badge === 'WARN').toBe(true)
      const ranks = panels.map((p) => rank(p.badge))
      expect([...ranks].sort((a, b) => a - b)).toEqual(ranks)
      // The text lists them in the same order, inside the data block.
      const [region] = dataRegions(r.text)
      const body = r.text.slice(region![0], region![1])
      let at = -1
      for (const p of panels) {
        const i = body.indexOf(` — ${p.id} (`)
        expect(i).toBeGreaterThan(at)
        at = i
      }
      expect(r.structured.counts.crit + r.structured.counts.warn).toBeGreaterThan(0)
    })
  }

  it('service_red: the error ratio is CRIT, TraceQL is not available, unsupported PromQL says so', async () => {
    const r = await rest(h, agent.key, 'read_dashboard', { id: 'service_red', max_tokens: 8000 })
    const byId = Object.fromEntries((r.structured.data.panels as any[]).map((p) => [p.id, p]))
    expect(byId.error_ratio.badge).toBe('CRIT')
    expect(byId.slow_spans.badge).toBe('NOT AVAILABLE')
    expect(byId.error_ratio.link).toMatch(/^https:\/\/vis\.bitcru\.sh\/explore\?q=/)
    expect(r.structured.complete).toBe(true)
  })

  it('k8s: a query the fake cannot run is reported as failed, and the read is marked partial', async () => {
    const r = await rest(h, agent.key, 'read_dashboard', { id: 'k8s_node_overview', max_tokens: 8000 })
    const byId = Object.fromEntries((r.structured.data.panels as any[]).map((p) => [p.id, p]))
    expect(byId.memory.badge).toBe('CRIT')
    expect(byId.not_ready_nodes.badge).toBe('QUERY FAILED') // `or` is outside the fake's PromQL subset
    expect(r.structured.complete).toBe(false)
    expect(r.text).toMatch(/; partial;/)
  })

  it('panels and variables narrow the read', async () => {
    const r = await rest(h, agent.key, 'read_dashboard', { id: 'viz_ingest_pipeline', panels: ['durability_window', 'unflushed_by_cell'], variables: { cell: 'c2' } })
    expect(r.structured.panelsTotal).toBe(2)
    expect(r.structured.data.panels.map((p: any) => p.badge)).toEqual(['CRIT', 'CRIT'])
    const bad = await rest(h, agent.key, 'read_dashboard', { id: 'viz_ingest_pipeline', panels: ['nope'] })
    expect(bad.status).toBe(404)
  })

  it('the deadline marks what was not evaluated and the result as partial', async () => {
    const slow = harness({ prom: { delayMs: { viz_shard_flush: 3000 } }, deps: { limits: { deadlineMs: 300 } } })
    telemetry(slow, t.tenant)
    const r = await rest(slow, agent.key, 'read_dashboard', { id: 'viz_ingest_pipeline', max_tokens: 8000 })
    expect(r.status).toBe(200)
    expect(r.structured.complete).toBe(false)
    expect(r.structured.counts.notEvaluated).toBeGreaterThan(0)
    const flush = (r.structured.data.panels as any[]).find((p) => p.id === 'flush_time')
    expect(flush.badge).toBe('NOT EVALUATED')
  })

  it('never more than the parallel limit in flight, and identical queries run once', async () => {
    const limited = harness({ prom: { delayMs: 5 }, deps: { limits: { maxParallel: 3 } } })
    telemetry(limited, t.tenant)
    await rest(limited, agent.key, 'read_dashboard', { id: 'k8s_node_overview' })
    expect(limited.prom.maxInFlight).toBeLessThanOrEqual(3)
    expect(limited.prom.maxInFlight).toBeGreaterThan(1)
    const jobs = limited.prom.calls.filter((c) => c.expr).map((c) => `${c.path} ${c.expr}`)
    expect(new Set(jobs).size).toBe(jobs.length)
  })

  it('more panels than the limit: the rest are listed as not evaluated', async () => {
    const few = harness({ deps: { limits: { maxPanels: 4 } } })
    telemetry(few, t.tenant)
    const r = await rest(few, agent.key, 'read_dashboard', { id: 'service_red', max_tokens: 8000 })
    expect(r.structured.counts.notEvaluated).toBe(r.structured.panelsTotal - 4)
    expect(r.structured.complete).toBe(false)
  })
})

describe('measurements (printed for the README)', () => {
  it('tokens at budgets 500, 2,000, 8,000 and wall time with the fake', async () => {
    const rows: string[] = []
    for (const name of NAMES) {
      for (const budget of [500, 2000, 8000]) {
        const times: number[] = []
        let last: Awaited<ReturnType<typeof rest>> | null = null
        for (let i = 0; i < 3; i++) {
          const t0 = Date.now()
          last = await rest(h, agent.key, 'read_dashboard', { id: name, max_tokens: budget })
          times.push(Date.now() - t0)
        }
        const s = last!.structured
        expect(s.tokens).toBeLessThanOrEqual(budget)
        rows.push(`${name}\t${budget}\t${s.tokens}\t${s.panelsShown}/${s.panelsTotal}\t${s.truncated}\t${s.usage.queries}\t${Math.min(...times)}-${Math.max(...times)} ms`)
      }
    }
    console.log('dashboard\tbudget\ttokens\tpanels in full\ttruncated\tqueries\twall (3 runs)\n' + rows.join('\n'))
  })
})
