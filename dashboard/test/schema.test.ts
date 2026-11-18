import { readFileSync } from 'node:fs'
import Ajv2020 from 'ajv/dist/2020.js'
import { describe, expect, it } from 'vitest'
import {
  dashboardSchema, EXAMPLE_DASHBOARD, getSchema, lint, PANEL_KINDS, SCHEMA_KINDS, validate, validateAgainst,
  type Dashboard, type PatchOp,
} from '../src/index.ts'
import { edit, examples, exampleFiles, prng, red, root } from './helpers.ts'

const ajv = new Ajv2020({ allErrors: true, strict: true })
const ajvValidate = ajv.compile(dashboardSchema)
const structural = (doc: unknown) => validateAgainst(dashboardSchema, dashboardSchema, doc)

describe('examples', () => {
  it('has three examples', () => expect(exampleFiles).toHaveLength(3))
  for (const f of exampleFiles) {
    it(`${f} validates with no errors and no lint warnings`, () => {
      expect(validate(examples[f])).toEqual({ ok: true, errors: [] })
      expect(lint(examples[f])).toEqual([])
      expect(ajvValidate(examples[f])).toBe(true)
    })
    it(`${f} has an intent and a description on every data panel`, () => {
      const d = examples[f]!
      expect(d.metadata.intent.length).toBeGreaterThan(60)
      for (const p of Object.values(d.panels)) if (p.kind !== 'text') expect(p.description.length).toBeGreaterThan(40)
    })
  }
})

describe('published schema', () => {
  it('schema/viz.dashboard.v1.schema.json is in sync with src/schema.ts', () => {
    const onDisk = JSON.parse(readFileSync(root + 'schema/viz.dashboard.v1.schema.json', 'utf8'))
    expect(onDisk).toEqual(JSON.parse(JSON.stringify(dashboardSchema)))
  })
  it('is closed: every object schema forbids or constrains additional properties', () => {
    const open: string[] = []
    const walk = (node: unknown, path: string) => {
      if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${path}/${i}`))
      if (typeof node !== 'object' || node === null) return
      const s = node as Record<string, unknown>
      if (s.type === 'object') {
        const closed = s.additionalProperties === false || (typeof s.additionalProperties === 'object' && s.propertyNames !== undefined)
        if (!closed) open.push(path)
      }
      for (const [k, v] of Object.entries(s)) walk(v, `${path}/${k}`)
    }
    walk(dashboardSchema, '')
    expect(open).toEqual([])
  })
  it('compiles under Ajv strict mode (only standard keywords)', () => {
    expect(typeof ajvValidate).toBe('function')
  })
})

describe('getSchema', () => {
  it('returns the full schema and a valid example by default', () => {
    const s = getSchema()
    expect(s.schema).toBe(dashboardSchema)
    expect(validate(s.example)).toEqual({ ok: true, errors: [] })
    expect(lint(s.example)).toEqual([])
    expect(Object.keys(s.catalog).sort()).toEqual([...PANEL_KINDS].sort())
  })
  for (const kind of SCHEMA_KINDS) {
    it(`slice "${kind}" is self-contained and its example is valid against it (Ajv and ours)`, () => {
      const s = getSchema(kind)
      const a = new Ajv2020({ strict: true })
      const check = a.compile(s.schema)
      expect(check(s.example), JSON.stringify(check.errors)).toBe(true)
      expect(validateAgainst(s.schema, s.schema, s.example)).toEqual([])
      if (kind !== 'dashboard') expect(JSON.stringify(s.schema).length).toBeLessThan(JSON.stringify(dashboardSchema).length)
    })
  }
  it('rejects an unknown kind by naming the valid ones', () => {
    expect(() => getSchema('gauge' as never)).toThrow(/Valid: dashboard, timeseries/)
  })
})

interface Case {
  name: string
  base?: Dashboard
  ops: PatchOp[]
  code: string
  path: string
  suggestion: RegExp
}

const withCycle: PatchOp[] = [
  { op: 'add', path: '/fragments/other', value: { description: 'second fragment that loops back', panels: {}, layout: { kind: 'rows', rows: [{ items: [{ fragment: 'dependency_red', as: 'loop', with: { caller: 'a', peer: 'b' } }] }] } } },
  { op: 'add', path: '/fragments/dependency_red/layout/rows/0/items/-', value: { fragment: 'other', as: 'inner' } },
]

const cases: Case[] = [
  { name: 'unknown panel key', ops: [{ op: 'add', path: '/panels/error_ratio/titel', value: 'x' }], code: 'unknown-key', path: '/panels/error_ratio/titel', suggestion: /Did you mean "title"/ },
  { name: 'unknown top-level key, pointer escaped', ops: [{ op: 'add', path: '/a~1b~0c', value: 1 }], code: 'unknown-key', path: '/a~1b~0c', suggestion: /Allowed keys: "apiVersion"/ },
  { name: 'view state is not part of the model', ops: [{ op: 'add', path: '/layout/rows/0/collapsed', value: true }], code: 'unknown-key', path: '/layout/rows/0/collapsed', suggestion: /Allowed keys: "title", "height", "items"/ },
  { name: 'misspelled panel kind', ops: [{ op: 'replace', path: '/panels/error_ratio/kind', value: 'statt' }], code: 'enum', path: '/panels/error_ratio/kind', suggestion: /Did you mean "stat"/ },
  { name: 'Grafana panel kind', ops: [{ op: 'replace', path: '/panels/error_ratio/kind', value: 'gauge' }], code: 'enum', path: '/panels/error_ratio/kind', suggestion: /Did you mean "stat"/ },
  { name: 'missing panel kind', ops: [{ op: 'remove', path: '/panels/error_ratio/kind' }], code: 'required', path: '/panels/error_ratio', suggestion: /"kind": one of "timeseries", "stat", "table", "heatmap", "text"/ },
  { name: 'unit spelled out', ops: [{ op: 'replace', path: '/panels/p99_latency/unit', value: 'seconds' }], code: 'enum', path: '/panels/p99_latency/unit', suggestion: /Did you mean "s"/ },
  { name: 'unit typo', ops: [{ op: 'replace', path: '/panels/p99_latency/unit', value: 'percnt' }], code: 'enum', path: '/panels/p99_latency/unit', suggestion: /Did you mean "percent"/ },
  { name: 'missing unit on a numeric panel', ops: [{ op: 'remove', path: '/panels/requests_by_route/unit' }], code: 'required', path: '/panels/requests_by_route', suggestion: /Add "unit": one of "none", "count"/ },
  { name: 'missing description', ops: [{ op: 'remove', path: '/panels/requests_by_route/description' }], code: 'required', path: '/panels/requests_by_route', suggestion: /Add "description".*what bad looks like/ },
  { name: 'missing intent', ops: [{ op: 'remove', path: '/metadata/intent' }], code: 'required', path: '/metadata', suggestion: /Add "intent".*What question/ },
  { name: 'empty intent', ops: [{ op: 'replace', path: '/metadata/intent', value: '' }], code: 'min-length', path: '/metadata/intent', suggestion: /What question/ },
  { name: 'wrong apiVersion', ops: [{ op: 'replace', path: '/apiVersion', value: 'viz.dashboard/v2' }], code: 'const', path: '/apiVersion', suggestion: /"viz.dashboard\/v1"/ },
  { name: 'query language', ops: [{ op: 'replace', path: '/queries/req_rate/lang', value: 'PromQL' }], code: 'enum', path: '/queries/req_rate/lang', suggestion: /Did you mean "promql"/ },
  { name: 'unsupported query language', ops: [{ op: 'replace', path: '/queries/req_rate/lang', value: 'sql' }], code: 'enum', path: '/queries/req_rate/lang', suggestion: /^Allowed: "promql", "traceql", "logql"\.$/ },
  { name: 'invalid panel id', ops: [{ op: 'add', path: '/panels/P-Rate', value: red.panels.notes }], code: 'invalid-key', path: '/panels/P-Rate', suggestion: /Try "p_rate"/ },
  { name: 'wrong type', ops: [{ op: 'replace', path: '/metadata/tags', value: 'red' }], code: 'type', path: '/metadata/tags', suggestion: /array/ },
  { name: 'threshold with both directions', ops: [{ op: 'add', path: '/panels/error_ratio/thresholds/0/below', value: 1 }], code: 'unknown-key', path: '/panels/error_ratio/thresholds/0/below', suggestion: /Allowed keys: "above", "level", "label"/ },
  { name: 'threshold level', ops: [{ op: 'replace', path: '/panels/error_ratio/thresholds/1/level', value: 'critical' }], code: 'enum', path: '/panels/error_ratio/thresholds/1/level', suggestion: /Did you mean "crit"/ },
  { name: 'option out of range', ops: [{ op: 'replace', path: '/panels/p99_latency/options/decimals', value: 9 }], code: 'maximum', path: '/panels/p99_latency/options/decimals', suggestion: /≤ 6/ },
  { name: 'misspelled layout kind', ops: [{ op: 'replace', path: '/layout/kind', value: 'gird' }], code: 'enum', path: '/layout/kind', suggestion: /Did you mean "grid"/ },
  { name: 'duplicate query in a panel', ops: [{ op: 'add', path: '/panels/latency_quantiles/queries/-', value: 'latency_p50' }], code: 'unique-items', path: '/panels/latency_quantiles/queries/3', suggestion: /Remove the duplicate/ },
  { name: 'heatmap takes one query', ops: [{ op: 'add', path: '/panels/latency_heatmap/queries/-', value: 'latency_p50' }], code: 'max-items', path: '/panels/latency_heatmap/queries', suggestion: /Remove 1 item/ },
  { name: 'bad time range', ops: [{ op: 'replace', path: '/time/from', value: 'yesterday' }], code: 'pattern', path: '/time/from', suggestion: /now-6h/ },

  // --- beyond the schema ---
  { name: 'panel → missing query', ops: [{ op: 'replace', path: '/panels/error_ratio/queries/0', value: 'error_ratio' }], code: 'dangling-query-ref', path: '/panels/error_ratio/queries/0', suggestion: /Did you mean "err_ratio"/ },
  { name: 'layout → missing panel', ops: [{ op: 'replace', path: '/layout/rows/1/items/0', value: 'request_by_route' }], code: 'dangling-panel-ref', path: '/layout/rows/1/items/0', suggestion: /Did you mean "requests_by_route"/ },
  { name: 'layout → missing panel (object form)', ops: [{ op: 'replace', path: '/layout/rows/0/items/0/panel', value: 'errorratio' }], code: 'dangling-panel-ref', path: '/layout/rows/0/items/0/panel', suggestion: /Did you mean "error_ratio"/ },
  { name: 'panel placed twice', ops: [{ op: 'add', path: '/layout/rows/1/items/-', value: 'notes' }], code: 'duplicate-placement', path: '/layout/rows/1/items/2', suggestion: /appears once/ },
  { name: 'undefined variable', ops: [{ op: 'replace', path: '/queries/req_rate_total/expr', value: 'sum(rate(x{env="$evn"}[$__rate]))' }], code: 'undefined-variable', path: '/queries/req_rate_total/expr', suggestion: /Did you mean "env"/ },
  { name: 'misspelled built-in', ops: [{ op: 'replace', path: '/queries/req_rate_total/expr', value: 'sum(rate(x[$__rate_interval]))' }], code: 'undefined-variable', path: '/queries/req_rate_total/expr', suggestion: /Did you mean "__rate"/ },
  { name: 'Grafana format suffix', ops: [{ op: 'replace', path: '/queries/req_rate_total/expr', value: 'sum(rate(x{route=~"${route:regex}"}[$__rate]))' }], code: 'unsupported-variable-format', path: '/queries/req_rate_total/expr', suggestion: /Write \$\{route\}/ },
  { name: 'multi-value variable in equality matcher', ops: [{ op: 'replace', path: '/queries/req_rate_total/expr', value: 'sum(rate(x{route="$route"}[$__rate]))' }], code: 'multi-in-equality', path: '/queries/req_rate_total/expr', suggestion: /=~"\$route"/ },
  { name: 'default not among values', ops: [{ op: 'replace', path: '/variables/env/default', value: 'production' }], code: 'default-not-in-values', path: '/variables/env/default', suggestion: /Did you mean "prod"/ },
  { name: 'variable cycle', ops: [{ op: 'replace', path: '/variables/service/query/expr', value: 'label_values(x{route=~"$route"}, service)' }], code: 'variable-cycle', path: '/variables/service/query/expr', suggestion: /Remove one/ },
  { name: 'table column not among panel queries', ops: [{ op: 'replace', path: '/panels/routes/options/columns/0/query', value: 'route_p90' }], code: 'column-not-in-panel', path: '/panels/routes/options/columns/0/query', suggestion: /Did you mean "route_p99"/ },
  { name: 'missing fragment', ops: [{ op: 'replace', path: '/layout/rows/4/items/0/fragment', value: 'dependency' }], code: 'dangling-fragment-ref', path: '/layout/rows/4/items/0/fragment', suggestion: /Did you mean "dependency_red"/ },
  { name: 'duplicate instance name', ops: [{ op: 'replace', path: '/layout/rows/4/items/1/as', value: 'db' }], code: 'duplicate-id', path: '/layout/rows/4/items/1/as', suggestion: /db_2/ },
  { name: 'unknown fragment parameter', ops: [{ op: 'add', path: '/layout/rows/4/items/0/with/pear', value: 'x' }], code: 'unknown-param', path: '/layout/rows/4/items/0/with/pear', suggestion: /Did you mean "peer"/ },
  { name: 'missing fragment parameter', ops: [{ op: 'remove', path: '/layout/rows/4/items/0/with/peer' }], code: 'missing-param', path: '/layout/rows/4/items/0', suggestion: /"with": \{ "peer"/ },
  { name: 'argument mixes text and variable', ops: [{ op: 'replace', path: '/layout/rows/4/items/0/with/peer', value: 'pg-$env' }], code: 'invalid-argument', path: '/layout/rows/4/items/0/with/peer', suggestion: /exactly one variable reference/ },
  { name: 'argument → undefined variable', ops: [{ op: 'replace', path: '/layout/rows/4/items/0/with/env', value: '$environment' }], code: 'undefined-variable', path: '/layout/rows/4/items/0/with/env', suggestion: /Did you mean "env"/ },
  { name: 'fragment query uses a dashboard variable', ops: [{ op: 'replace', path: '/fragments/dependency_red/queries/calls/expr', value: 'sum(rate(x{env="$env",service="$service",peer="$peer",c="$caller"}[$__rate]))' }], code: 'undefined-variable', path: '/fragments/dependency_red/queries/calls/expr', suggestion: /"with": \{ "service": "\$service" \}/ },
  { name: 'fragment panel → dashboard query', ops: [{ op: 'replace', path: '/fragments/dependency_red/panels/calls/queries/0', value: 'req_rate' }], code: 'dangling-query-ref', path: '/fragments/dependency_red/panels/calls/queries/0', suggestion: /Copy the query into this fragment/ },
  { name: 'fragment cycle', ops: withCycle, code: 'fragment-cycle', path: '/fragments/dependency_red/layout', suggestion: /Break the cycle/ },
  { name: 'fragment instantiating itself', ops: [{ op: 'add', path: '/fragments/dependency_red/layout/rows/0/items/-', value: { fragment: 'dependency_red', as: 'again', with: { caller: 'a', peer: 'b' } } }], code: 'fragment-cycle', path: '/fragments/dependency_red/layout', suggestion: /Break the cycle/ },
  { name: 'grid item past the right edge', base: examples['k8s-node-overview.json'], ops: [{ op: 'replace', path: '/layout/items/2/w', value: 20 }], code: 'grid-overflow', path: '/layout/items/2', suggestion: /Reduce "w" to 16/ },
  { name: 'grid → missing panel', base: examples['k8s-node-overview.json'], ops: [{ op: 'replace', path: '/layout/items/4/panel', value: 'cpus' }], code: 'dangling-panel-ref', path: '/layout/items/4/panel', suggestion: /Did you mean "cpu"/ },
  { name: 'yMin above yMax', base: examples['k8s-node-overview.json'], ops: [{ op: 'replace', path: '/panels/cpu/options/yMin', value: 2 }], code: 'invalid-range', path: '/panels/cpu/options/yMin', suggestion: /Swap/ },
]

describe('validate rejects invalid specs with a pointer and a suggestion', () => {
  it.each(cases)('$name', (c) => {
    const spec = edit(c.base ?? red, c.ops)
    const r = validate(spec)
    expect(r.ok).toBe(false)
    const hit = r.errors.find((e) => e.code === c.code && e.path === c.path)
    expect(hit, `got ${JSON.stringify(r.errors, null, 1)}`).toBeDefined()
    expect(hit!.suggestion).toMatch(c.suggestion)
    expect(hit!.message.length).toBeGreaterThan(10)
    // one mistake, one error: no cascades
    expect(r.errors.length, JSON.stringify(r.errors, null, 1)).toBe(1)
  })

  it('every error has a path that is a valid JSON Pointer, a message and a suggestion', () => {
    for (const c of cases) {
      for (const e of validate(edit(c.base ?? red, c.ops)).errors) {
        expect(e.path === '' || e.path.startsWith('/')).toBe(true)
        expect(e.message).toBeTruthy()
        expect(e.suggestion, `${c.name}: ${e.code}`).toBeTruthy()
      }
    }
  })

  it('rejects non-objects without throwing', () => {
    for (const v of [null, undefined, 1, 'x', [], true]) {
      const r = validate(v)
      expect(r.ok).toBe(false)
      expect(r.errors[0]!.path).toBe('')
    }
  })

  it('reports several independent mistakes in one pass', () => {
    const spec = edit(red, [
      { op: 'add', path: '/panels/error_ratio/colour', value: 'red' },
      { op: 'replace', path: '/panels/p99_latency/unit', value: 'sec' },
      { op: 'remove', path: '/metadata/intent' },
    ])
    expect(validate(spec).errors.map((e) => e.code).sort()).toEqual(['enum', 'required', 'unknown-key'])
  })
})

describe('differential: our interpreter agrees with Ajv (draft 2020-12) on the same schema', () => {
  it('agrees on every case of the invalid table', () => {
    for (const c of cases) {
      const spec = edit(c.base ?? red, c.ops)
      expect(structural(spec).length === 0, c.name).toBe(ajvValidate(spec))
    }
  })

  it('agrees on thousands of random mutations of the examples', () => {
    const rand = prng(20261118)
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!
    const junk: unknown[] = [null, 0, -1, 1.5, 7, 1e9, '', 'x', 'timeseries', 'grid', 'rows', 'Bad Id', '5m', 'now-1h', 'warn', true, false, [], {}, ['a', 'a'], [1], { kind: 'grid' }, { kind: 'text', title: 't', content: 'c' }, { panel: 'notes' }, { above: 1, level: 'warn' }, 'é'.repeat(700)]
    const paths = (doc: unknown): string[][] => {
      const out: string[][] = []
      const walk = (n: unknown, p: string[]) => {
        out.push(p)
        if (Array.isArray(n)) n.forEach((x, i) => walk(x, [...p, String(i)]))
        else if (typeof n === 'object' && n !== null) for (const [k, v] of Object.entries(n)) walk(v, [...p, k])
      }
      walk(doc, [])
      return out
    }
    let valid = 0
    let invalid = 0
    const disagreements: string[] = []
    const docs = [...Object.values(examples), EXAMPLE_DASHBOARD]
    for (let i = 0; i < 6000; i++) {
      const doc = JSON.parse(JSON.stringify(pick(docs))) as unknown
      const steps = 1 + Math.floor(rand() * 2)
      let desc = ''
      for (let s = 0; s < steps; s++) {
        const p = pick(paths(doc).filter((x) => x.length > 0))
        const parent = p.slice(0, -1).reduce<any>((n, k) => n[k], doc)
        const key = p[p.length - 1]!
        const action = pick(['delete', 'replace', 'replace', 'addKey', 'dup', 'rename', 'tweak'] as const)
        desc += `${action} /${p.join('/')}; `
        if (action === 'delete') Array.isArray(parent) ? parent.splice(Number(key), 1) : delete parent[key]
        else if (action === 'replace') parent[key] = pick(junk)
        else if (action === 'addKey') {
          const target = parent[key]
          if (typeof target === 'object' && target !== null && !Array.isArray(target)) target[pick(['extra', 'kind', 'unit', 'title', 'span', 'x', 'default', 'multi', 'new_id', 'Bad-Id'])] = pick(junk)
          else if (Array.isArray(target)) target.push(pick(junk))
        } else if (action === 'dup') {
          if (Array.isArray(parent)) parent.push(parent[Number(key)])
        } else if (action === 'rename') {
          if (!Array.isArray(parent)) {
            parent[pick([key + 's', key.toUpperCase(), 'x_' + key, key.slice(1)]) || 'k'] = parent[key]
            delete parent[key]
          }
        } else {
          const v = parent[key]
          if (typeof v === 'number') parent[key] = pick([v + 0.5, -v, v * 1000, v + 1])
          else if (typeof v === 'string') parent[key] = pick([v + '!', v.toUpperCase(), v.slice(0, 1), v + v + v + v + v + v + v + v, ''])
          else if (typeof v === 'boolean') parent[key] = pick(['true', 1, !v])
        }
      }
      const ours = structural(doc).length === 0
      const theirs = ajvValidate(doc) as boolean
      if (ours !== theirs) disagreements.push(`${desc} ours=${ours} ajv=${theirs} ${JSON.stringify(theirs ? structural(doc) : ajvValidate.errors).slice(0, 300)}`)
      if (theirs) valid++
      else invalid++
    }
    expect(disagreements.slice(0, 5)).toEqual([])
    // both classes must be well represented or the test proves nothing
    expect(valid).toBeGreaterThan(300)
    expect(invalid).toBeGreaterThan(2000)
    console.log(`differential: 6000 mutated specs, ${valid} valid / ${invalid} invalid, 0 disagreements`)
  }, 120_000)
})
