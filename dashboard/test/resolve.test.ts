import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { escapeRegex, escapeString, findVariables, resolve, substitute, validate, type Binding, type Dashboard } from '../src/index.ts'
import { edit, examples, red } from './helpers.ts'

const one = (v: string): Binding => ({ values: [v] })
const sub = (expr: string, vars: Record<string, Binding>) => substitute(expr, (n) => vars[n])

describe('findVariables', () => {
  it('finds $name and ${name} with the context each is used in', () => {
    const refs = findVariables('sum(rate(m{a="$x", b=~"${y}|z", c!~`$z`, d != \'$w\'}[$__rate])) > $limit')
    expect(refs.map((r) => [r.name, r.context, r.quote, r.whole])).toEqual([
      ['x', 'string', '"', true],
      ['y', 'regex', '"', false],
      ['z', 'regex', '`', true],
      ['w', 'string', "'", true],
      ['__rate', 'bare', undefined, false],
      ['limit', 'bare', undefined, false],
    ])
  })
  it('leaves $1, a regex end anchor, $$ and comments alone', () => {
    expect(findVariables('label_replace(m, "a", "$1", "b", "(.*)$") # uses $nothing')).toEqual([])
    expect(findVariables('m{a=~"x$$y"}')).toEqual([])
    expect(findVariables('m{a="\\"$x"}').map((r) => [r.name, r.context])).toEqual([['x', 'string']])
  })
  it('recognises LogQL and TraceQL regex operators', () => {
    expect(findVariables('{app="$a"} |~ "$pat" |= "$lit"', 'logql').map((r) => r.context)).toEqual(['string', 'regex', 'string'])
    expect(findVariables('{ span.http.url =~ "$u" && name = "$n" }', 'traceql').map((r) => r.context)).toEqual(['regex', 'string'])
  })
})

describe('substitute: escaping', () => {
  it('string context escapes backslash and the quote', () => {
    expect(sub('m{a="$x"}', { x: one('pl"ain\\') })).toEqual({ expr: 'm{a="pl\\"ain\\\\"}', errors: [] })
    expect(sub("m{a='$x'}", { x: one(`it's "q"`) }).expr).toBe(`m{a='it\\'s "q"'}`)
    expect(sub('m{a="$x"}', { x: one('a\nb\tc\u0001') }).expr).toBe('m{a="a\\nb\\tc\\u0001"}')
  })
  it('an injection attempt through a label value stays inside the string', () => {
    const evil = 'x"} or vector(1) or m{a="'
    const r = sub('sum(m{a="$x"})', { x: one(evil) })
    expect(r.errors).toEqual([])
    expect(r.expr).toBe('sum(m{a="x\\"} or vector(1) or m{a=\\""})')
    // exactly one string literal remains, holding the whole value
    const strings = r.expr.match(/"(?:[^"\\]|\\.)*"/g)
    expect(strings).toHaveLength(1)
    expect(JSON.parse(strings![0]!)).toBe(evil)
  })
  it('regex context regex-escapes, then string-escapes', () => {
    expect(sub('m{a=~"$x"}', { x: one('a.b|c(d)') }).expr).toBe('m{a=~"a\\\\.b\\\\|c\\\\(d\\\\)"}')
    expect(sub('m{a=~`$x`}', { x: one('a.b`c') }).expr).toBe('m{a=~`a\\.b\\x60c`}')
    expect(escapeRegex('\\.+*?()|[]{}^$')).toBe('\\\\\\.\\+\\*\\?\\(\\)\\|\\[\\]\\{\\}\\^\\$')
    expect(escapeString('a"b', '"')).toBe('a\\"b')
  })
  it('multi-value joins as an escaped alternation; grouped unless it is the whole string', () => {
    const v = { x: { values: ['api.v1', 'web|2', 'c'] } }
    expect(sub('m{a=~"$x"}', v).expr).toBe('m{a=~"api\\\\.v1|web\\\\|2|c"}')
    expect(sub('m{a=~"pre-${x}-post"}', v).expr).toBe('m{a=~"pre-(?:api\\\\.v1|web\\\\|2|c)-post"}')
    expect(sub('m{a!~"$x"}', { x: { values: ['only'] } }).expr).toBe('m{a!~"only"}')
  })
  it('the alternation matches exactly the selected values (checked with a real regex)', () => {
    fc.assert(
      fc.property(fc.array(fc.string({ maxLength: 12 }), { minLength: 1, maxLength: 5 }), fc.string({ maxLength: 12 }), (values, probe) => {
        const r = sub('m{a=~"$x"}', { x: { values } })
        const literal = /=~("(?:[^"\\]|\\.)*")\}$/.exec(r.expr)![1]!
        const re = new RegExp(`^(?:${JSON.parse(literal) as string})$`, 's')
        return r.errors.length === 0 && values.every((v) => re.test(v)) && re.test(probe) === values.includes(probe)
      }),
      { numRuns: 1000 },
    )
  })
  it('"all" is .* in a regex and an error elsewhere', () => {
    expect(sub('m{a=~"$x"}', { x: { values: [], all: true } }).expr).toBe('m{a=~".*"}')
    const r = sub('m{a="$x"}', { x: { values: [], all: true } })
    expect(r.expr).toBe('m{a="$x"}')
    expect(r.errors[0]).toMatch(/use a regex matcher/)
  })
  it('several values in an equality matcher fail closed', () => {
    const r = sub('m{a="$x"}', { x: { values: ['a', 'b'] } })
    expect(r.expr).toBe('m{a="$x"}')
    expect(r.errors).toHaveLength(1)
  })
  it('outside a string only numbers, durations and identifiers are written', () => {
    expect(sub('rate(m[$w]) > $n and on() $metric', { w: one('5m'), n: one('0.5'), metric: one('up:sum') }).expr).toBe('rate(m[5m]) > 0.5 and on() up:sum')
    for (const evil of ['5m]) or vector(1) #', '1 or vector(1)', 'up{a="b"}', '', 'a b', '5m:1m', '0x10)']) {
      const r = sub('rate(m[$w])', { w: one(evil) })
      expect(r.expr, evil).toBe('rate(m[$w])')
      expect(r.errors, evil).toHaveLength(1)
    }
  })
  it('unknown names are left in place and reported; $$ is a literal dollar', () => {
    expect(sub('m{a="$nope"}', {})).toEqual({ expr: 'm{a="$nope"}', errors: ['$nope is not defined'] })
    expect(sub('m{a=~"x$$"}', {}).expr).toBe('m{a=~"x$"}')
  })
  it('property: a substituted string value never changes the number of string literals', () => {
    fc.assert(
      fc.property(fc.string(), (v) => {
        const r = sub('m{a="$x",b=~"$x"}', { x: one(v) })
        const strings = r.expr.match(/"(?:[^"\\]|\\.)*"/g) ?? []
        const rest = r.expr.replace(/"(?:[^"\\]|\\.)*"/g, 'S')
        return r.errors.length === 0 && strings.length === 2 && rest === 'm{a=S,b=~S}' && JSON.parse(strings[0]!) === v
      }),
      { numRuns: 2000 },
    )
  })
})

describe('resolve', () => {
  it('substitutes defaults and given values', () => {
    const r = resolve(red, { variables: { service: 'cart', route: ['/a.b', '/c'] }, builtins: { __rate: '2m' } })
    expect(r.issues).toEqual([])
    expect(r.variables).toEqual({ env: { values: ['prod'], all: false }, service: { values: ['cart'], all: false }, route: { values: ['/a.b', '/c'], all: false } })
    expect(r.queries.req_rate!.expr).toBe('sum by (route) (rate(http_server_requests_total{env="prod",service="cart",route=~"/a\\\\.b|/c"}[2m]))')
    expect(resolve(red).queries.req_rate!.expr).toContain('service="checkout",route=~".*"}[5m]')
    expect(r.revision).toMatch(/^[0-9a-f]{32}$/)
  })
  it('expands fragment instances with prefixed ids and bound parameters', () => {
    const r = resolve(red, { variables: { env: 'staging' } })
    expect(Object.keys(r.panels).filter((p) => p.includes('.'))).toEqual(['db.errors', 'db.calls', 'db.latency', 'payments.errors', 'payments.calls', 'payments.latency'])
    expect(r.panels['db.errors']).toMatchObject({ kind: 'stat', queries: ['db.call_err_ratio'], instance: 'db', source: '/fragments/dependency_red/panels/errors' })
    expect(r.queries['payments.calls']!.expr).toBe('sum(rate(http_client_requests_total{env="staging",service="checkout",peer_service="payments-api"}[5m]))')
    expect(r.queries['db.calls']!.expr).toContain('peer_service="postgres"')
    // every panel's queries exist; every panel in the layout exists
    for (const p of Object.values(r.panels)) if (p.kind !== 'text') for (const q of p.queries) expect(r.queries[q]).toBeDefined()
    expect(r.order).toHaveLength(Object.keys(r.panels).length)
    for (const id of r.order) expect(r.panels[id]).toBeDefined()
    const deps = r.layout.kind === 'rows' ? r.layout.rows[4]! : undefined
    expect(deps?.items[0]).toMatchObject({ instance: 'db', layout: { kind: 'rows', rows: [{ items: [{ panel: 'db.errors', span: 2 }, { panel: 'db.calls' }, { panel: 'db.latency' }] }] } })
  })
  it('expands nested fragments and passes parameters through', () => {
    const nested = edit(red, [
      { op: 'add', path: '/fragments/both', value: { description: 'two dependencies side by side', params: { svc: {} }, panels: {}, layout: { kind: 'rows', rows: [{ items: [{ fragment: 'dependency_red', as: 'left', with: { caller: '$svc', peer: 'a"b' } }] }] } } },
      { op: 'add', path: '/layout/rows/-', value: { items: [{ fragment: 'both', as: 'pair', with: { svc: '$service' } }] } },
    ])
    expect(validate(nested)).toEqual({ ok: true, errors: [] })
    const r = resolve(nested, { variables: { service: 'cart' } })
    expect(r.issues).toEqual([])
    expect(r.queries['pair.left.calls']!.expr).toContain('service="cart",peer_service="a\\"b"')
    expect(r.panels['pair.left.calls']!.instance).toBe('pair.left')
  })
  it('falls back to defaults for values an enum does not have, and says so', () => {
    const r = resolve(red, { variables: { env: 'prod"} or vector(1) #', nope: 'x' } })
    expect(r.variables.env!.values).toEqual(['prod'])
    expect(r.issues.map((i) => i.code).sort()).toEqual(['unknown-variable', 'variable-value'])
    expect(r.queries.req_rate!.expr).toContain('env="prod"')
  })
  it('several values for a single-value variable use the first; several in an equality matcher fail closed', () => {
    const r = resolve(red, { variables: { service: ['a', 'b'] } })
    expect(r.variables.service!.values).toEqual(['a'])
    expect(r.issues[0]!.code).toBe('variable-value')
    const r2 = resolve(red, { variables: { service: '*' } }) // query variable: "all" is allowed, but used with =
    expect(r2.queries.req_rate!.error).toMatch(/use a regex matcher/)
    expect(r2.queries.req_rate!.expr).toContain('service="$service"')
    expect(r2.issues.some((i) => i.code === 'substitution-failed' && i.path === '/queries/req_rate/expr')).toBe(true)
  })
  it('an unsafe value for a bare variable fails closed', () => {
    const d = edit(examples['viz-ingest-pipeline.json']!, [{ op: 'replace', path: '/variables/quantile', value: { kind: 'text', default: '0.99' } }])
    expect(validate(d).ok).toBe(true)
    expect(resolve(d).queries.ack_latency!.expr).toContain('histogram_quantile(0.99, ')
    const r = resolve(d, { variables: { quantile: '0.99, vector(1)) or (' } })
    expect(r.queries.ack_latency!.error).toMatch(/not a number, duration or identifier/)
    expect(r.queries.ack_latency!.expr).toContain('histogram_quantile($quantile, ')
  })
  it('does not mutate the spec', () => {
    const before = JSON.stringify(red)
    resolve(red, { variables: { route: ['/x'] } })
    expect(JSON.stringify(red)).toBe(before)
  })
  it('property: never throws on valid specs, whatever the variable values, and every reference resolves', () => {
    const specs = Object.values(examples)
    const value = fc.oneof(fc.string(), fc.array(fc.string(), { maxLength: 4 }), fc.constantFrom('*', '', 'prod', '5m', '0.99', '"', '\\', '`', '$env', '${x}', '$$'))
    const names = ['env', 'service', 'route', 'cluster', 'node', 'cell', 'signal', 'quantile', 'unknown', '__rate', '__proto__', 'constructor']
    fc.assert(
      fc.property(fc.constantFrom(...specs), fc.dictionary(fc.constantFrom(...names), value), fc.option(fc.string(), { nil: undefined }), (spec, variables, rate) => {
        const r = resolve(spec, { variables, ...(rate !== undefined ? { builtins: { __rate: rate } } : {}) })
        for (const p of Object.values(r.panels)) if (p.kind !== 'text') for (const q of p.queries) if (!r.queries[q]) return false
        for (const q of Object.values(r.queries)) {
          if (q.error === undefined && findVariables(q.expr, q.lang).length > 0 && !/\$/.test(JSON.stringify(variables))) return false
        }
        return r.order.every((id) => r.panels[id] !== undefined)
      }),
      { numRuns: 1500 },
    )
  })
  it('property: never throws on valid random edits of the examples', () => {
    // random structural edits; keep only those that still validate, then resolve
    const specs = Object.values(examples)
    let resolved = 0
    fc.assert(
      fc.property(fc.constantFrom(...specs), fc.array(fc.tuple(fc.nat(), fc.constantFrom('remove-row', 'remove-item', 'dup-fragment', 'drop-var-default', 'swap-rows')), { maxLength: 4 }), (spec, steps) => {
        const d = JSON.parse(JSON.stringify(spec)) as Dashboard
        for (const [n, kind] of steps) {
          if (d.layout.kind !== 'rows' || d.layout.rows.length === 0) continue
          const rows = d.layout.rows
          const row = rows[n % rows.length]!
          if (kind === 'remove-row') rows.splice(n % rows.length, 1)
          else if (kind === 'remove-item' && row.items.length > 1) row.items.splice(n % row.items.length, 1)
          else if (kind === 'swap-rows') rows.reverse()
          else if (kind === 'dup-fragment' && d.fragments) rows.push({ items: [{ fragment: Object.keys(d.fragments)[0]!, as: `i${n % 5}`, with: { caller: '$service', peer: `p${n}` } }] })
          else if (kind === 'drop-var-default') for (const v of Object.values(d.variables ?? {})) delete v.default
        }
        if (!validate(d).ok) return true
        resolved++
        const r = resolve(d, { variables: { route: ['a', 'b'] } })
        return r.order.every((id) => r.panels[id] !== undefined)
      }),
      { numRuns: 500 },
    )
    expect(resolved).toBeGreaterThan(200)
  })
})
