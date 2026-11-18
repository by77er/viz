import { describe, expect, it } from 'vitest'
import { lint, LINT_RULES, validate, type Dashboard, type PatchOp } from '../src/index.ts'
import { edit, examples, red } from './helpers.ts'

const k8s = examples['k8s-node-overview.json']!
const codesAt = (d: unknown, opts = {}) => lint(d, opts).map((w) => `${w.code} ${w.path}`)

const cases: { name: string; base?: Dashboard; ops: PatchOp[]; expect: string[] }[] = [
  { name: 'stat without thresholds', ops: [{ op: 'remove', path: '/panels/error_ratio/thresholds' }], expect: ['stat-without-thresholds /panels/error_ratio'] },
  { name: 'table without units', ops: [{ op: 'remove', path: '/panels/routes/options/columns/1/unit' }], expect: ['missing-unit /panels/routes'] },
  { name: 'fixed rate window', ops: [{ op: 'replace', path: '/queries/req_rate_total/expr', value: 'sum(rate(http_server_requests_total{env="$env",service="$service",route=~"$route"}[5m]))' }], expect: ['hardcoded-rate-window /queries/req_rate_total/expr'] },
  { name: 'unused query', ops: [{ op: 'add', path: '/queries/spare', value: { lang: 'promql', expr: 'up' } }], expect: ['unused-query /queries/spare'] },
  { name: 'unused variable', ops: [{ op: 'add', path: '/variables/region', value: { kind: 'text' } }], expect: ['unused-variable /variables/region'] },
  { name: 'unused fragment', ops: [{ op: 'remove', path: '/layout/rows/4' }], expect: ['unused-fragment /fragments/dependency_red'] },
  { name: 'unused fragment parameter', ops: [{ op: 'add', path: '/fragments/dependency_red/params/extra', value: { default: 'x' } }], expect: ['unused-param /fragments/dependency_red/params/extra'] },
  { name: 'panel not in the layout', ops: [{ op: 'remove', path: '/layout/rows/0/items/3' }], expect: ['unplaced-panel /panels/notes'] },
  { name: 'title is the query id', ops: [{ op: 'replace', path: '/panels/error_ratio/title', value: 'err_ratio' }], expect: ['title-is-query /panels/error_ratio/title'] },
  { name: 'title is the query text', ops: [{ op: 'replace', path: '/queries/latency_buckets/expr', value: 'sum(rate(x_bucket[$__rate]))' }, { op: 'replace', path: '/panels/latency_heatmap/title', value: 'sum(rate(x_bucket[$__rate]))' }], expect: ['title-is-query /panels/latency_heatmap/title'] },
  { name: 'placeholder description', ops: [{ op: 'replace', path: '/panels/throughput/description', value: 'TODO: describe' }], expect: ['weak-description /panels/throughput/description'] },
  { name: 'short description', ops: [{ op: 'replace', path: '/panels/throughput/description', value: 'Request rate.' }], expect: ['weak-description /panels/throughput/description'] },
  { name: 'short intent', ops: [{ op: 'replace', path: '/metadata/intent', value: 'Service dashboard' }], expect: ['weak-intent /metadata/intent'] },
  { name: 'duplicate panel', ops: [{ op: 'add', path: '/panels/copy', value: red.panels.throughput }, { op: 'add', path: '/layout/rows/1/items/-', value: 'copy' }], expect: ['duplicate-panel /panels/copy'] },
  { name: 'thresholds in an order that hides warn', ops: [{ op: 'replace', path: '/panels/error_ratio/thresholds/0/above', value: 0.5 }], expect: ['threshold-order /panels/error_ratio/thresholds'] },
  { name: 'free-form variable outside a string', ops: [{ op: 'add', path: '/variables/limit', value: { kind: 'text', default: '10' } }, { op: 'replace', path: '/queries/req_rate/expr', value: 'topk($limit, sum by (route) (rate(http_server_requests_total{env="$env",service="$service",route=~"$route"}[$__rate])))' }], expect: ['bare-variable /queries/req_rate/expr'] },
  { name: 'fragment queries are linted too', ops: [{ op: 'replace', path: '/fragments/dependency_red/queries/calls/expr', value: 'sum(rate(http_client_requests_total{env="$env",service="$caller",peer_service="$peer"}[1m]))' }], expect: ['hardcoded-rate-window /fragments/dependency_red/queries/calls/expr'] },
  { name: 'empty layout', base: k8s, ops: [{ op: 'replace', path: '/layout/items', value: [] }], expect: ['empty-row /layout', ...Object.keys(k8s.panels).map((p) => `unplaced-panel /panels/${p}`)] },
]

describe('lint', () => {
  it.each(cases)('$name', (c) => {
    const d = edit(c.base ?? red, c.ops)
    expect(validate(d)).toEqual({ ok: true, errors: [] }) // lint is about valid specs
    expect(codesAt(d).sort()).toEqual([...c.expect].sort())
    for (const w of lint(d)) {
      expect(w.suggestion).toBeTruthy()
      expect(LINT_RULES[w.code]).toBeTruthy()
    }
  })
  it('warns above N panels, counting fragment instances; N is configurable', () => {
    expect(codesAt(red, { maxPanels: 15 })).toEqual(['too-many-panels /panels']) // 10 own + 2×3 from fragments
    expect(codesAt(red, { maxPanels: 16 })).toEqual([])
    const big = JSON.parse(JSON.stringify(k8s)) as Dashboard
    for (let i = 0; i < 20; i++) {
      big.queries![`q${i}`] = { lang: 'promql', expr: `metric_${i}{cluster=~"$cluster"}` }
      big.panels[`p${i}`] = { kind: 'timeseries', title: `Metric ${i}`, description: `Shows metric ${i} for the cluster over time.`, unit: 'none', queries: [`q${i}`] }
      if (big.layout.kind === 'grid') big.layout.items.push({ panel: `p${i}`, x: 0, y: 100 + i, w: 24, h: 1 })
    }
    expect(codesAt(big)).toEqual(['too-many-panels /panels'])
  })
  it('rules can be disabled', () => {
    const d = edit(red, [{ op: 'remove', path: '/panels/error_ratio/thresholds' }])
    expect(lint(d, { disable: ['stat-without-thresholds'] })).toEqual([])
  })
  it('refuses to lint an invalid spec', () => {
    expect(lint({}).map((w) => w.code)).toEqual(['invalid-spec'])
  })
  it('a subquery or a non-rate range is not flagged', () => {
    const d = edit(red, [{ op: 'replace', path: '/queries/req_rate_total/expr', value: 'max_over_time(sum(rate(http_server_requests_total{env="$env",service="$service",route=~"$route"}[$__rate]))[1h:1m])' }])
    expect(lint(d)).toEqual([])
    const e = edit(red, [{ op: 'replace', path: '/queries/req_rate_total/expr', value: 'avg_over_time(up{env="$env",service="$service",route=~"$route"}[10m])' }])
    expect(lint(e)).toEqual([])
  })
})
