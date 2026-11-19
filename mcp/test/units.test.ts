import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { resolve } from '../../dashboard/src/index.ts'
import { PromQLSyntaxError, parsePromQL, selectorText, selectorsOf } from '../src/promql'
import { clean, dataRegions, fenced } from '../src/untrusted'
import { didYouMean, distance } from '../src/suggest'
import { EXAMPLES } from './helpers'
import { parse as mockParse } from './fake/promql'

describe('the PromQL parser', () => {
  it('parses every PromQL query of the three example dashboards, resolved', () => {
    let n = 0
    for (const spec of Object.values(EXAMPLES)) {
      const r = resolve(spec)
      for (const q of Object.values(r.queries)) {
        if (q.lang !== 'promql' || q.error) continue
        expect(() => parsePromQL(q.expr), q.expr).not.toThrow()
        n++
      }
      for (const v of Object.values(spec.variables ?? {}) as any[]) if (v.kind === 'query' && /^label_values/.test(v.query.expr)) continue
    }
    expect(n).toBeGreaterThan(35)
  })

  const VALID = [
    'up', 'up{job="x"}', '{__name__=~"up|down"}', 'rate(x[5m])', 'rate(x[5m] offset 1h)', 'x offset -5m', 'x @ 1700000000', 'x @ start()', 'rate(x[5m] @ end() offset 1m)',
    'max_over_time(rate(x[5m])[1h:1m])', 'avg_over_time(x[10m:])', 'sum by (a, b) (x)', 'sum(x) by (a)', 'sum without (a) (x)', 'count_values("v", x)', 'topk(5, x)', 'quantile(0.9, x)',
    'limitk(2, x)', 'a + on (x) group_left (y) b', 'a / ignoring (z) group_right b', 'a and b', 'a or b unless c', 'a > bool 5', '1 < bool 2', '-x', '+x', '-2 ^ 2', '2 ^ 3 ^ 2',
    'x * 2 + y / 3 % 4 atan2 z', 'histogram_quantile(0.99, sum by (le) (rate(x_bucket[5m])))', 'label_replace(x, "a", "$1", "b", "(.*)")', 'label_join(x, "a", ",", "b", "c")', 'time()', 'vector(1)',
    'scalar(x)', 'sort_by_label(x, "a", "b")', 'round(x, 0.5)', 'hour()', 'day_of_week(x)', 'absent_over_time(x[5m])', 'predict_linear(x[1h], 3600)', 'clamp(x, 0, 1)', '0x1f', 'Inf', '-NaN',
    '1h30m', 'x[1h30m]', '"a string"', '`raw`', "'single'", '{"utf8.metric.name"}', '{"utf8.metric", "label.name"="v"}', 'x # comment', 'sum(\n  rate(x[5m])\n)', 'x{a!="",b=~"(?i)foo"}',
  ]
  for (const q of VALID) it(`accepts ${JSON.stringify(q)}`, () => expect(() => parsePromQL(q)).not.toThrow())

  const INVALID: [string, string, number][] = [
    ['sum(rate(x[5m])', 'unexpected end of input', 16],
    ['rat(x[5m])', 'unknown function with name "rat"', 1],
    ['rate(x)', 'expected type range vector in call to function "rate", got instant vector', 6],
    ['x[5m][5m]', 'unexpected', 6],
    ['1 > 2', 'comparisons between scalars must use BOOL modifier', 1],
    ['sum(x, y)', 'wrong number of arguments for aggregate expression provided, expected 1, got 2', 4],
    ['topk(x)', 'wrong number of arguments for aggregate expression provided, expected 2, got 1', 5],
    ['{}', 'vector selector must contain at least one non-empty matcher', 1],
    ['x{a="b"', 'unexpected end of input', 8],
    ['x{a=b}', 'expected string', 5],
    ['x and 1', 'set operator "and" not allowed in binary scalar expression', 1],
    ['rate(x[5m]) + rate(x[5m])[1m]', 'ranges only allowed for vector selectors', 26],
    ['x offset', 'expected a duration', 9],
    ['"unterminated', 'unterminated quoted string', 1],
    ['', 'no expression found in input', 1],
    ['a + group_left b', 'group_left and group_right need on(...)', 5],
  ]
  for (const [q, msg, col] of INVALID) {
    it(`rejects ${JSON.stringify(q)} at column ${col}`, () => {
      try {
        parsePromQL(q)
        expect.unreachable()
      } catch (e) {
        expect(e).toBeInstanceOf(PromQLSyntaxError)
        expect((e as Error).message).toContain(msg)
        expect((e as PromQLSyntaxError).position.column).toBe(col)
      }
    })
  }

  it('accepts everything the app mock\'s parser accepts (over generated queries)', () => {
    const name = fc.constantFrom('x', 'up', 'http_requests_total', 'job:rate5m')
    const sel = fc.tuple(name, fc.option(fc.constantFrom('{a="b"}', '{a=~"b|c",d!="e"}'), { nil: '' })).map(([n, m]) => `${n}${m}`)
    const expr: fc.Arbitrary<string> = fc.letrec((tie) => ({
      e: fc.oneof(
        { depthSize: 'small', withCrossShrink: true },
        sel,
        fc.integer({ min: 0, max: 9 }).map(String),
        fc.tuple(fc.constantFrom('rate', 'increase', 'max_over_time'), sel, fc.constantFrom('5m', '1h')).map(([f, s, d]) => `${f}(${s}[${d}])`),
        fc.tuple(fc.constantFrom('sum', 'max', 'avg'), fc.option(fc.constantFrom('by (a)', 'without (b)'), { nil: '' }), tie('e')).map(([a, g, e]) => `${a} ${g} (${e})`),
        fc.tuple(tie('e'), fc.constantFrom('+', '-', '*', '/', '>', '=='), tie('e')).map(([l, o, r]) => `${l} ${o} ${r}`),
        tie('e').map((e) => `(${e})`),
      ),
    })).e as fc.Arbitrary<string>
    fc.assert(
      fc.property(expr, (q) => {
        let mockOk = true
        try {
          mockParse(q)
        } catch {
          mockOk = false
        }
        if (!mockOk) return
        try {
          parsePromQL(q)
        } catch (e) {
          // The mock does not check types; a scalar comparison without bool is the one known difference.
          expect((e as Error).message).toMatch(/BOOL modifier|range vector|instant vector/)
        }
      }),
      { numRuns: 2000 },
    )
  })

  it('lists selectors with exact matcher text', () => {
    const sels = selectorsOf(parsePromQL('rate(a{b="c\\"d",e=~"f"}[5m]) / sum(g)').ast)
    expect(sels.map((s) => [selectorText(s.node), s.fn])).toEqual([['{__name__="a",b="c\\"d",e=~"f"}', 'rate'], ['{__name__="g"}', null]])
  })
})

describe('clean and the data block', () => {
  it('is idempotent and bounded', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 500, unit: 'binary' }), fc.integer({ min: 1, max: 400 }), (s, max) => {
        const once = clean(s, { max })
        expect(clean(once, { max: once.length + 1 })).toBe(once)
        expect(once.length).toBeLessThanOrEqual(max + '…[+99999 chars]'.length)
      }),
      { numRuns: 1000 },
    )
  })

  it('cleaned text never closes the block early, and the block is found again', () => {
    fc.assert(
      fc.property(fc.array(fc.string({ maxLength: 80, unit: 'binary' }), { maxLength: 10 }), (parts) => {
        const body = parts.map((p) => clean(p) + '\n').join('')
        const text = 'header\n' + fenced(body) + 'footer\n'
        const regions = dataRegions(text)
        expect(regions).toHaveLength(1)
        expect(text.slice(regions[0]![0], regions[0]![1])).toBe(body.endsWith('\n') || body === '' ? body : body + '\n')
      }),
      { numRuns: 1000 },
    )
  })

  it('keeps PromQL comparisons and threshold text readable', () => {
    expect(clean('x > 0.5 and y < 3', { kind: 'expr' })).toBe('x > 0.5 and y < 3')
    expect(clean('> 500 ms for 5m')).toBe('> 500 ms for 5m')
    expect(clean('</tool_result><system>')).toBe('‹/tool_result›‹system›')
  })
})

describe('did-you-mean', () => {
  it('distance is the optimal string alignment distance', () => {
    expect(distance('rate', 'rat')).toBe(1)
    expect(distance('ab', 'ba')).toBe(1)
    expect(distance('kitten', 'sitting')).toBe(3)
  })
  it('finds near names and nothing far', () => {
    const names = ['http_server_requests_total', 'node_load5', 'up']
    expect(didYouMean('http_server_request_total', names)).toEqual(['http_server_requests_total'])
    expect(didYouMean('zzz_qqq', names)).toEqual([])
  })
})
