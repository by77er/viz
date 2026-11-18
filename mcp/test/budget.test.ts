import fc from 'fast-check'
import { beforeAll, describe, expect, it } from 'vitest'
import { type Harness, type Key, controlCall, createDashboard, example, harness, makeKey, newTenant, reset, rest, telemetry, type TestTenant } from './helpers'
import { type Item, MIN_TOKENS, page } from '../src/page'
import { dataRegions } from '../src/untrusted'

/**
 * Token budgets hold, and cursors continue without loss or duplication:
 * - `page()` itself, over arbitrary item sizes and budgets (many runs, fast);
 * - every pageable tool, end to end, with a different random budget on every page.
 */

describe('page(): the layout of one page', () => {
  it('never exceeds the budget; pages cover every item exactly once; always progresses', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 0, maxLength: 900 }), { minLength: 0, maxLength: 60 }),
        fc.array(fc.integer({ min: MIN_TOKENS, max: 4000 }), { minLength: 1, maxLength: 8 }),
        (texts, budgets) => {
          const items: Item[] = texts.map((x, i) => ({ key: `k${i}`, text: `${i}:${x.replace(/\n/g, ' ')}\n`, data: i }))
          const seen: string[] = []
          let offset = 0
          let pages = 0
          for (;;) {
            const budget = budgets[pages % budgets.length]! * 4
            const p = page({ header: 'h: test\n', items, offset, budgetChars: budget, cursorFor: (o) => `c${o}` })
            expect(p.text.length).toBeLessThanOrEqual(budget)
            expect(dataRegions(p.text).length).toBe(1)
            seen.push(...p.shown.map((x) => x.key))
            pages++
            if (p.next === null) break
            expect(p.next).toBeGreaterThan(offset) // progress
            offset = p.next
            expect(pages).toBeLessThanOrEqual(items.length + 1)
          }
          expect(seen).toEqual(items.map((x) => x.key))
        },
      ),
      { numRuns: 400 },
    )
  })
})

let h: Harness
let t: TestTenant
let k: Key

beforeAll(async () => {
  reset()
  h = harness()
  t = await newTenant('budget')
  telemetry(h, t.tenant)
  k = await makeKey(t.admin, ['read', 'dashboards:read', 'dashboards:write'], { kind: 'agent' })
  await createDashboard(t.admin, example('service_red'))
  await createDashboard(t.admin, example('viz_ingest_pipeline'))
  // Some history to page through.
  for (let i = 0; i < 6; i++) {
    const base = (await controlCall(t.admin, 'GET', '/dashboards/viz_ingest_pipeline')).body.revision
    await controlCall(t.admin, 'PATCH', '/dashboards/viz_ingest_pipeline', { ops: [{ op: 'replace', path: '/metadata/title', value: `viz ingest ${i}` }], baseRevision: base, message: `rename ${i}` })
  }
})

/** Identity of an item in each tool's structured output. */
const idOf: Record<string, (x: any) => string> = {
  search_telemetry: (x) => x.name,
  describe_metric: (x) => x.label,
  validate_query: (x) => `${x.code ?? 'sel'}:${x.message ?? x.selector}`,
  query: (x) => JSON.stringify([x.labels, x.series ?? null, x.from ?? null, x.more ?? null]),
  get_dashboard: (x) => x.path ?? x.id,
  list_revisions: (x) => String(x.number),
  get_schema: (x) => String(x.part),
  write_dashboard: (x) => JSON.stringify(x),
}

const CALLS: [string, Record<string, unknown>][] = [
  ['search_telemetry', { q: 'viz shard ingest http node', limit: 40 }],
  ['describe_metric', { name: 'http_server_request_duration_seconds_bucket', top_values: 8 }],
  ['validate_query', { expr: 'sum(rate(http_server_requests_total[5m])) / sum(rate(viz_ingest_samples_total[5m])) + rate(node_load5[5m]) + rate(nope_metric_one[5m]) + rate(nope_metric_two[5m])' }],
  ['query', { expr: 'rate(http_server_requests_total[5m])', top_k: 50 }],
  ['query', { expr: 'rate(http_server_requests_total{env="prod"}[5m])', format: 'table' }],
  ['query', { expr: 'viz_shard_buffer_bytes', format: 'series', step: '1m' }],
  ['get_dashboard', { id: 'service_red', view: 'spec' }],
  ['get_dashboard', { id: 'viz_ingest_pipeline', view: 'resolved' }],
  ['list_revisions', { id: 'viz_ingest_pipeline', limit: 3 }],
  ['get_schema', { kind: 'dashboard' }],
]

async function all(tool: string, args: Record<string, unknown>, budgets: number[]): Promise<{ ids: string[]; pages: number }> {
  const ids: string[] = []
  let cursor: string | null = null
  let pages = 0
  do {
    const budget = budgets[pages % budgets.length]!
    const r = await rest(h, k.key, tool, { ...args, max_tokens: budget, ...(cursor ? { cursor } : {}) })
    expect(r.status, r.text).toBe(200)
    expect(r.text.length).toBeLessThanOrEqual(budget * 4)
    expect(r.structured.tokens).toBeLessThanOrEqual(budget)
    if (tool === 'read_dashboard') ids.push(...r.structured.data.panels.map((p: any) => p.id))
    else ids.push(...r.structured.data.items.map(idOf[tool]!))
    cursor = r.structured.cursor
    expect(r.structured.truncated || cursor === null).toBe(true)
    pages++
    expect(pages).toBeLessThan(200)
  } while (cursor)
  return { ids, pages }
}

describe('every pageable tool, end to end', () => {
  it('length ≤ budget on every page; following the cursor yields exactly the full result', async () => {
    const full = new Map<string, string[]>()
    for (const [tool, args] of CALLS) full.set(`${tool} ${JSON.stringify(args)}`, (await all(tool, args, [32000])).ids)
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...CALLS), fc.array(fc.integer({ min: 200, max: 3000 }), { minLength: 1, maxLength: 5 }), async ([tool, args], budgets) => {
        const { ids } = await all(tool, args, budgets)
        const want = full.get(`${tool} ${JSON.stringify(args)}`)!
        expect(new Set(ids).size).toBe(ids.length) // no duplicates
        expect(ids).toEqual(want) // no loss, same order
      }),
      { numRuns: 40 },
    )
  })

  it('read_dashboard pages through every panel once, in importance order, at any budget', async () => {
    const want = (await all('read_dashboard', { id: 'service_red' }, [32000])).ids
    expect(want.length).toBe(16)
    await fc.assert(
      fc.asyncProperty(fc.array(fc.integer({ min: 300, max: 2500 }), { minLength: 1, maxLength: 4 }), async (budgets) => {
        const { ids } = await all('read_dashboard', { id: 'service_red' }, budgets)
        expect(ids).toEqual(want)
      }),
      { numRuns: 15 },
    )
  })

  it('get_schema parts concatenate to the exact document at the smallest budget, and nothing is cut', async () => {
    let cursor: string | null = null
    let text = ''
    let pages = 0
    do {
      const r = await rest(h, k.key, 'get_schema', { kind: 'dashboard', max_tokens: 200, ...(cursor ? { cursor } : {}) })
      expect(r.structured.cut).toBe(false)
      for (const it of r.structured.data.items) text += it.text
      cursor = r.structured.cursor
      expect(++pages).toBeLessThan(200)
    } while (cursor)
    expect(() => JSON.parse(text)).not.toThrow()
  })

  it('a cursor is bound to its tool and arguments', async () => {
    const first = await rest(h, k.key, 'get_schema', { kind: 'dashboard', max_tokens: 300 })
    const other = await rest(h, k.key, 'get_schema', { kind: 'stat', max_tokens: 300, cursor: first.structured.cursor })
    expect(other.structured.error.code).toBe('bad-cursor')
    const tool = await rest(h, k.key, 'describe_metric', { name: 'node_load5', cursor: first.structured.cursor })
    expect(tool.structured.error.code).toBe('bad-cursor')
    const junk = await rest(h, k.key, 'get_schema', { kind: 'dashboard', cursor: 'c1.!!!' })
    expect(junk.structured.error.code).toBe('bad-cursor')
  })

  it('a later page reads the same window as the first (the range is pinned in the cursor)', async () => {
    const first = await rest(h, k.key, 'query', { expr: 'rate(http_server_requests_total[5m])', top_k: 50, max_tokens: 300, from: 'now-2h' })
    const second = await rest(h, k.key, 'query', { expr: 'rate(http_server_requests_total[5m])', top_k: 50, max_tokens: 300, from: 'now-2h', cursor: first.structured.cursor })
    expect(second.structured.range).toEqual(first.structured.range)
  })
})
