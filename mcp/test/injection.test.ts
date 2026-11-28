import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type Harness, type Key, NOW, controlCall, createDashboard, example, harness, makeKey, mcpClient, newTenant, reset, rest, rpc, snapshot, telemetry, type TestTenant } from './helpers'
import { CORPUS, IDENT_DASHBOARD, IDENT_METRIC, MARKERS, findMarkers } from './corpus'
import { fakeBacktest, fakeOverBudget, monitorView } from './fake/services'
import { TOOLS } from '../src/registry'
import { dataRegions } from '../src/untrusted'
import { dashboardSchema } from '../../dashboard/src/index.ts'

/** URLs this server itself writes: deep links into the app, and the ids inside the published schema. */
const OWN_URLS = new Set(JSON.stringify(dashboardSchema).match(/https?:\/\/[^\s"]*/g) ?? [])

/**
 * The injection corpus, planted everywhere telemetry or tenant text can reach an agent,
 * read back through every tool, resource and prompt on both surfaces. For every answer:
 * 1. every marker is inside a ```viz-data block (text) or under `data` (structured);
 * 2. nothing that could act as a delimiter, a role, markup, a link or an invisible
 *    instruction survives anywhere, inside the blocks included;
 * 3. long values are cut with a marker;
 * 4. nothing was fetched and nothing changed because of what was read.
 */

let h: Harness
let t: TestTenant
let k: Key
let person: Key
let proposalId: string
const fetched: string[] = []
const realFetch = globalThis.fetch

/** PromQL string literal for any text. */
const lit = (s: string) => JSON.stringify(s)

beforeAll(async () => {
  reset()
  // Anything the server fetches by itself (not through the injected services) is recorded.
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    fetched.push(String(input instanceof Request ? input.url : input))
    return realFetch(input as never, init)
  }) as typeof fetch
  const errors: Record<string, string> = {}
  CORPUS.forEach((c, i) => (errors[`evil_error_trigger_${i}_`] = c))
  h = harness({ prom: { errors, warnings: CORPUS.slice(20, 23) } })
  t = await newTenant('evil')
  const s = telemetry(h, t.tenant)
  CORPUS.forEach((c, i) => {
    s.add({ __name__: 'evil_requests_total', note: c, idx: String(i) }, () => 1 + i, 'counter') // label values
    s.add({ __name__: c, k: 'v' }, () => i) // metric names (UTF-8 names are legal in Prometheus 3)
    s.add({ __name__: 'evil_labels', [c]: 'v', idx: String(i) }, () => i) // label names
    s.add({ __name__: `evil_help_${i}_total` }, () => 1, 'counter')
    s.setMeta(`evil_help_${i}_total`, 'counter', c, c.slice(0, 30)) // help and unit
  })
  s.add({ __name__: IDENT_METRIC, service: 'checkout' }, () => 1, 'counter')

  // A dashboard made of the corpus.
  const spec = example('service_red', IDENT_DASHBOARD)
  spec.metadata.title = CORPUS[1]!.slice(0, 120)
  spec.metadata.intent = `${CORPUS[0]} ${CORPUS[11]}`.slice(0, 600)
  Object.keys(spec.panels).forEach((id, i) => {
    spec.panels[id].title = CORPUS[(i + 2) % CORPUS.length]!.slice(0, 120)
    spec.panels[id].description = CORPUS[(i + 3) % CORPUS.length]!.slice(0, 600)
  })
  const long = CORPUS.find((c) => c.startsWith('INJ14'))!
  spec.panels.notes.content = (CORPUS.filter((c) => c !== long).join('\n') + '\n' + long).slice(0, 8000)
  spec.variables.note = { kind: 'enum', values: CORPUS.slice(0, 5).map((c) => c.slice(0, 200)), default: CORPUS[2]!.slice(0, 200) }
  spec.queries.evil_q = { lang: 'promql', expr: 'sum by (note) (rate(evil_requests_total[$__rate]))' }
  spec.queries.evil_sel = { lang: 'promql', expr: 'sum(rate(evil_requests_total{note="$note"}[$__rate]))' }
  spec.queries.evil_err = { lang: 'promql', expr: 'evil_error_trigger_1_ + evil_requests_total' }
  spec.panels.evil_panel = { kind: 'timeseries', title: CORPUS[22]!.slice(0, 120), description: CORPUS[6]!, unit: 'req/s', queries: ['evil_q', 'evil_sel', 'evil_err'], thresholds: [{ above: 5, level: 'warn', label: 'INJ99 x'.slice(0, 60) }] }
  spec.layout.rows[0].items.push('evil_panel')
  spec.layout.rows[0].title = CORPUS[20]!.slice(0, 120)
  await createDashboard(t.admin, spec, CORPUS[16]!.slice(0, 500))

  k = await makeKey(t.admin, ['read', 'dashboards:read', 'dashboards:write', 'monitors:read'], { kind: 'agent', name: CORPUS[3]!.slice(0, 80) })
  person = await makeKey(t.admin, ['dashboards:read', 'dashboards:apply'], { kind: 'key', name: CORPUS[17]!.slice(0, 80) })
  const base = (await controlCall(t.admin, 'GET', `/dashboards/${IDENT_DASHBOARD}`)).body.revision
  const p = await controlCall(k.key, 'POST', `/dashboards/${IDENT_DASHBOARD}/proposals`, { message: CORPUS[12]!.slice(0, 500), baseRevision: base, changes: [{ name: 'evil', reason: CORPUS[4]!.slice(0, 500), ops: [{ op: 'replace', path: '/metadata/title', value: CORPUS[9]!.slice(0, 120) }] }] })
  proposalId = p.body.proposal.id
  await controlCall(person.key, 'POST', `/proposals/${proposalId}/apply`, { message: CORPUS[15]!.slice(0, 500) })

  h.ruler.monitors.set(t.tenant, [
    {
      view: monitorView({ id: 'mon_e0e0e0e0e0e0e0e0', name: CORPUS[1]!, state: 'firing', value: 3, firingSince: (NOW - 60) * 1000, description: CORPUS[0], message: CORPUS[13], thresholdText: CORPUS[19]!, expr: `evil_requests_total{note=${lit(CORPUS[5]!)}} > 0`, runbookUrl: CORPUS[8], lastError: CORPUS[10], owner: CORPUS[23], labels: { note: CORPUS[3]! }, annotations: { summary: CORPUS[11]!, [CORPUS[2]!]: CORPUS[21]! }, alerts: [{ fingerprint: CORPUS[24]!, labels: { [CORPUS[25]!]: CORPUS[26]! }, state: 'firing', activeAt: (NOW - 60) * 1000, firingSince: (NOW - 60) * 1000, value: 3 }] }),
      history: [{ at: (NOW - 60) * 1000, kind: CORPUS[7]!, note: CORPUS[18]! }],
    },
    { view: monitorView({ id: 'mon_e1e1e1e1e1e1e1e1', name: CORPUS[14]!, state: CORPUS[0] as never, expr: CORPUS[20]! }), history: [] },
  ])
  // Backtests: the corpus in interval labels (names and values), annotations (names and values),
  // fingerprints, the resolution note and the kind; in an over_budget message; in validation problems.
  h.ruler.backtests.set(t.tenant, (b) => {
    if (b.monitor.name === 'evil-budget') return fakeOverBudget(CORPUS.join(' '), { cpu: { modelledMs: 46_200, budgetMs: 20_000 } })
    if (b.monitor.name === 'evil-invalid') return { status: 422, body: { error: { code: 'invalid', message: CORPUS[0] }, problems: CORPUS.map((c, i) => ({ path: i % 2 ? `monitor.labels.${c}` : c, message: CORPUS[(i + 1) % CORPUS.length]!, fix: CORPUS[(i + 2) % CORPUS.length]! })) } }
    if (b.monitor.name === 'evil-failed') return { status: 502, body: { error: { code: 'evaluation_failed', message: CORPUS.join(' ') } } }
    const intervals = CORPUS.map((c, i) => ({ fingerprint: c, labels: { alertname: 'evil', [c]: CORPUS[(i + 3) % CORPUS.length]! }, state: (i % 2 ? 'pending' : 'firing') as 'pending' | 'firing', startMs: (NOW - 7200 + i * 60) * 1000, endMs: (NOW - 7200 + i * 60 + 30) * 1000, open: false, annotations: { summary: c, [CORPUS[(i + 5) % CORPUS.length]!]: CORPUS[(i + 7) % CORPUS.length]!, anomaly: CORPUS[(i + 9) % CORPUS.length]! } }))
    const body = fakeBacktest(b, intervals, { kind: CORPUS[2] })
    ;(body.resolution as { note: string }).note = CORPUS.join(' ')
    return { status: 200, body }
  })
})

afterAll(() => {
  globalThis.fetch = realFetch
})

// ---- the checks ----

const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00ad\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\ufe00-\ufe0f\u2028\u2029]|\uDB40[\uDC00-\uDDEF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
const FORBIDDEN: [string, RegExp][] = [
  ['invisible or control character', INVISIBLE],
  ['markup or special-token opener', /<[A-Za-z/!?|<[%:]/],
  ['role tag', /\[\s*\/?\s*(INST|SYS)\s*\]/i],
  ['special token', /\|\s*(im_start|im_end)\s*\|/i],
  ['script URL', /\b(javascript|vbscript|mailto)\s*:/i],
  ['data URI', /\bdata\s*:\s*text\//i],
  ['bare www link', /\bwww\.evil/i],
  ['markdown link or image', /\]\(|!\[/],
  ['uncut long value', /A{4001,}/],
]

function checkString(s: string, where: string, allowAppLinks: boolean): void {
  for (const [what, re] of FORBIDDEN) expect(re.test(s), `${what} in ${where}: ${JSON.stringify(s.slice(Math.max(0, s.search(re) - 40), s.search(re) + 60))}`).toBe(false)
  for (const m of s.matchAll(/https?:\/\/[^\s"]*/g)) {
    expect(allowAppLinks && (m[0].startsWith('https://viz.bitcru.sh/') || OWN_URLS.has(m[0])), `URL in ${where}: ${m[0].slice(0, 80)}`).toBe(true)
  }
}

function checkText(text: string, where: string): void {
  checkString(text, where, true)
  const regions = dataRegions(text)
  for (const { marker, at } of findMarkers(text)) {
    expect(regions.some(([a, b]) => at >= a && at < b), `${marker} outside a viz-data block in ${where}: ${JSON.stringify(text.slice(Math.max(0, at - 80), at + 40))}`).toBe(true)
  }
  for (const line of text.split('\n')) {
    if (/^\s*(`{3,}|~{3,})/.test(line)) expect(/^```(viz-data [0-9a-f]{8})?$/.test(line), `fence-like line in ${where}: ${line}`).toBe(true)
    expect(/^\s*(Human|Assistant|System|User)\s*:/i.test(line), `role prefix at a line start in ${where}: ${line.slice(0, 60)}`).toBe(false)
  }
  if (text.includes('INJ14')) expect(text, where).toMatch(/…\[\+\d+ chars\]|…\[cut to fit|…\[item cut/)
}

function checkStructured(v: unknown, where: string, path: string[] = []): void {
  if (typeof v === 'string') {
    checkString(v, `${where} at /${path.join('/')}`, true)
    if (findMarkers(v).length) expect(path.includes('data'), `marker outside "data" in ${where} at /${path.join('/')}`).toBe(true)
    return
  }
  if (v && typeof v === 'object') for (const [k2, x] of Object.entries(v)) {
    if (findMarkers(k2).length) expect(path.includes('data'), `marker in a key outside "data" in ${where}`).toBe(true)
    checkString(k2, `${where} key`, false)
    checkStructured(x, where, [...path, k2])
  }
}

/** Calls that read the planted corpus, one or more per tool. */
const CALLS = (): [string, Record<string, unknown>][] => [
  ['search_telemetry', { q: 'evil requests help labels' }],
  ['search_telemetry', { q: IDENT_METRIC }],
  ['search_telemetry', { q: 'INJ01 Ignore' }],
  ['describe_metric', { name: 'evil_requests_total', top_values: 20 }],
  ['describe_metric', { name: 'evil_labels', top_values: 20 }],
  ['describe_metric', { name: CORPUS[1]! }],
  ['describe_metric', { name: 'evil_help_3_total' }],
  ['describe_metric', { name: CORPUS[2]!.slice(0, 10) + 'x' }],
  ['validate_query', { expr: `sum(rate({__name__=${lit(CORPUS[1]!)}}[5m]))` }],
  ['validate_query', { expr: `sum(evil_requests_total{note=${lit(CORPUS[3]!)}}` }],
  ['validate_query', { expr: `rate(${IDENT_METRIC.replace('total', 'totl')}[5m]) + rate(evil_labels{${lit(CORPUS[5]!)}="v"}[5m])` }],
  ['query', { expr: 'rate(evil_requests_total[5m])', top_k: 50, max_tokens: 32000 }],
  ['query', { expr: 'rate(evil_requests_total[5m])', format: 'table', max_tokens: 32000 }],
  ['query', { expr: 'evil_labels', format: 'series', max_tokens: 32000 }],
  ['query', { expr: 'evil_labels', instant: true, max_tokens: 32000 }],
  ...CORPUS.map((_, i): [string, Record<string, unknown>] => ['query', { expr: `evil_error_trigger_${i}_` }]),
  ['search_dashboards', {}],
  ['get_dashboard', { id: IDENT_DASHBOARD, max_tokens: 32000 }],
  ['get_dashboard', { id: IDENT_DASHBOARD, view: 'spec', max_tokens: 32000 }],
  ['get_dashboard', { id: IDENT_DASHBOARD, view: 'resolved', max_tokens: 32000 }],
  ['list_revisions', { id: IDENT_DASHBOARD }],
  ['read_dashboard', { id: IDENT_DASHBOARD, max_tokens: 32000 }],
  ['read_dashboard', { id: IDENT_DASHBOARD, max_tokens: 400 }],
  ['read_dashboard', { id: IDENT_DASHBOARD, format: 'tsv', max_tokens: 32000 }],
  ['write_dashboard', { id: IDENT_DASHBOARD, ops: [{ op: 'replace', path: '/panels/notes/title', value: CORPUS[0]!.slice(0, 120) }], max_tokens: 32000 }],
  ['write_dashboard', { id: IDENT_DASHBOARD, ops: [{ op: 'replace', path: '/panels/error_ratio/unit', value: CORPUS[2]! }], max_tokens: 32000 }],
  ['write_dashboard', { id: IDENT_DASHBOARD, ops: [{ op: 'add', path: '/queries/q2', value: { lang: 'promql', expr: `rate({__name__=${lit(CORPUS[9]!)}}[5m])` } }, { op: 'add', path: '/panels/p2', value: { kind: 'stat', title: CORPUS[10]!.slice(0, 120), description: CORPUS[11]!, unit: 'none', queries: ['q2'] } }, { op: 'add', path: '/layout/rows/0/items/-', value: 'p2' }], max_tokens: 32000 }],
  ['write_dashboard', { spec: { apiVersion: 'viz.dashboard/v1', metadata: { id: 'x', title: CORPUS[1]!.slice(0, 120), intent: CORPUS[13]! }, panels: {}, layout: { kind: 'rows', rows: [] } }, max_tokens: 32000 }],
  ['list_monitors', {}],
  ['get_monitor', { id: 'mon_e0e0e0e0e0e0e0e0', max_tokens: 32000 }],
  ['backtest_monitor', { monitor: { name: 'evil-ok', query: 'rate(evil_requests_total[5m])', condition: { op: '>', threshold: 0 } }, start: 'now-3h', max_tokens: 32000 }],
  ['backtest_monitor', { monitor: { name: 'evil-ok', query: 'rate(evil_requests_total[5m])', condition: { op: '>', threshold: 0 } }, start: 'now-3h', max_tokens: 800 }],
  ['backtest_monitor', { monitor: { name: 'evil-budget', query: 'rate(evil_requests_total[5m])', condition: { op: '>', threshold: 0 } } }],
  ['backtest_monitor', { monitor: { name: 'evil-invalid', query: 'rate(evil_requests_total[5m])', condition: { op: '>', threshold: 0 } }, max_tokens: 32000 }],
  ['get_schema', {}],
  ['annotate', { text: CORPUS[0]! }],
]

describe('the injection corpus through every tool', () => {
  it(`the corpus has at least 20 entries (${CORPUS.length}), each with its own marker`, () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(20)
    expect(new Set(MARKERS).size).toBe(MARKERS.length)
  })

  it('REST: every tool, every answer', async () => {
    const calls = CALLS()
    expect(new Set(calls.map(([tool]) => tool))).toEqual(new Set(TOOLS.map((x) => x.name)))
    const before = await snapshot(t)
    const seen = new Set<string>()
    for (const [tool, args] of calls) {
      const r = await rest(h, k.key, tool, args)
      const where = `${tool} ${JSON.stringify(args).slice(0, 80)}`
      expect([500, 502, 503], where).not.toContain(r.status)
      checkText(r.text, where)
      checkStructured(r.structured, where)
      for (const m of findMarkers(r.text)) seen.add(m.marker)
    }
    // The corpus really reached the agent (otherwise the checks above prove nothing).
    for (const m of MARKERS) expect(seen.has(m), `${m} never reached the agent`).toBe(true)
    expect(await snapshot(t)).toBe(before) // dry runs and reads changed nothing
    expect(fetched).toEqual([])
  })

  it('MCP: the same answers through the official client', async () => {
    const client = await mcpClient(h, k.key)
    for (const [tool, args] of CALLS().filter((_, i) => i % 3 === 0)) {
      const r = (await client.callTool({ name: tool, arguments: args })) as any
      const where = `mcp ${tool}`
      for (const c of r.content) if (c.type === 'text') checkText(c.text, where)
      checkStructured(r.structuredContent, where)
    }
    await client.close()
  })

  it('a proposal whose reasons carry the corpus: the agent reads it back safely', async () => {
    const base = (await controlCall(t.admin, 'GET', `/dashboards/${IDENT_DASHBOARD}`)).body.revision
    const r = await rest(h, k.key, 'write_dashboard', { id: IDENT_DASHBOARD, mode: 'propose', base_revision: base, message: CORPUS[0]!.slice(0, 500), changes: [{ name: 'evil-two', reason: CORPUS[1]!.slice(0, 500), ops: [{ op: 'replace', path: '/panels/notes/title', value: CORPUS[2]!.slice(0, 120) }] }] })
    expect(r.status).toBe(200)
    checkText(r.text, 'propose')
    checkStructured(r.structured, 'propose')
  })

  it('a failed backtest (502): the ruler\'s error, which can quote the query service, is cleaned and fenced', async () => {
    const r = await rest(h, k.key, 'backtest_monitor', { monitor: { name: 'evil-failed', query: 'rate(evil_requests_total[5m])', condition: { op: '>', threshold: 0 } }, max_tokens: 32000 })
    expect(r.status).toBe(502)
    expect(r.structured.error.code).toBe('backtest-failed')
    checkText(r.text, 'backtest_monitor failed')
    checkStructured(r.structured, 'backtest_monitor failed')
    expect(findMarkers(r.text).length).toBeGreaterThan(5)
  })

  it('resources and prompts', async () => {
    const client = await mcpClient(h, k.key)
    const res = await client.readResource({ uri: `viz://dashboards/${IDENT_DASHBOARD}` })
    checkText((res.contents[0] as any).text, 'resource')
    for (const p of (await client.listPrompts()).prompts) {
      const args = Object.fromEntries((p.arguments ?? []).map((a, i) => [a.name, CORPUS[i * 7]!.slice(0, 500)]))
      const got = await client.getPrompt({ name: p.name, arguments: args })
      checkText((got.messages[0]!.content as any).text, `prompt ${p.name}`)
    }
    await client.close()
  })

  it('protocol errors and argument errors do not echo hostile names raw', async () => {
    const unknown = await rpc(h, k.key, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: CORPUS[1], arguments: {} } }, { 'MCP-Protocol-Version': '2025-06-18' })
    expect(unknown.body.error).toBeDefined()
    checkString(JSON.stringify(unknown.body), 'unknown tool error', false)
    const prompt = await rpc(h, k.key, { jsonrpc: '2.0', id: 2, method: 'prompts/get', params: { name: CORPUS[9], arguments: { x: CORPUS[10] } } }, { 'MCP-Protocol-Version': '2025-06-18' })
    checkString(JSON.stringify(prompt.body), 'unknown prompt error', false)
    const badArgs = await rest(h, k.key, 'query', { [CORPUS[1]!]: 1, [CORPUS[8]!]: 2, expr: 'up' })
    checkText(badArgs.text, 'bad args')
    checkStructured(badArgs.structured, 'bad args')
  })

  it('nothing outside the injected services was fetched, whatever the telemetry said', () => {
    expect(fetched).toEqual([])
  })
})
