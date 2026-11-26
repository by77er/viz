import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { fromJson, isJsonNumber, MatrixParser, NotAMatrix, parseMatrix, readNumber, type ParsedMatrix } from './matrix'

/** Every element equal, NaN to NaN and -0 to -0 (Object.is), so a value read differently shows. */
function sameNumbers(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false
  return true
}

function sameMatrix(a: ParsedMatrix, b: ParsedMatrix): string | null {
  if (a.series.length !== b.series.length) return `series ${a.series.length} vs ${b.series.length}`
  for (let i = 0; i < a.series.length; i++) {
    const x = a.series[i]!
    const y = b.series[i]!
    if (JSON.stringify(x.metric) !== JSON.stringify(y.metric)) return `metric ${i}`
    if (!sameNumbers(x.times, y.times)) return `times ${i}`
    if (!sameNumbers(x.values, y.values)) return `values ${i}: ${[...x.values].slice(0, 5)} vs ${[...y.values].slice(0, 5)}`
  }
  if (JSON.stringify(a.warnings) !== JSON.stringify(b.warnings)) return 'warnings'
  if (JSON.stringify(a.infos) !== JSON.stringify(b.infos)) return 'infos'
  return null
}

/** Feed `text` in pieces cut at `cuts` (any positions, including inside a number, a string or an escape). */
function parseInPieces(text: string, cuts: number[]): ParsedMatrix {
  const at = [...new Set(cuts.map((c) => c % (text.length + 1)))].sort((a, b) => a - b)
  const p = new MatrixParser()
  let from = 0
  for (const c of at) {
    p.push(text.slice(from, c))
    from = c
  }
  p.push(text.slice(from))
  return p.finish()
}

const label = fc.oneof(fc.constantFrom('__name__', 'job', 'le', 'service', 'a'), fc.string({ minLength: 1, maxLength: 6 }))
/** Label values with what can trip a scanner: quotes, backslashes, brackets, braces, commas, non-ASCII. */
const labelValue = fc.oneof(fc.string({ maxLength: 8 }), fc.constantFrom('q"r', 'a\\b', '}]{[', ',:', 'ü→\u{1F600}', ''))
const valueText = fc.oneof(
  fc.double().map(String),
  fc.double({ noNaN: true, noDefaultInfinity: true, min: -1e6, max: 1e6 }).map((d) => d.toFixed(4)),
  fc.integer().map(String),
  fc.constantFrom('NaN', '+Inf', '-Inf', 'Inf', '', '-0', '0', '1e-9', '1.5e300', '12345678901234567890', '0.1', '3.7740', ' 1', '0x10', 'abc', '.5', '5.', '+1.5'),
)
const time = fc.oneof(
  fc.integer({ min: 0, max: 2_000_000_000 }),
  fc.integer({ min: 0, max: 2_000_000_000_000 }).map((ms) => ms / 1000),
  fc.double({ noNaN: true, noDefaultInfinity: true }),
)
const series = fc.record({
  metric: fc.dictionary(label, labelValue, { maxKeys: 5 }),
  values: fc.array(fc.tuple(time, valueText), { maxLength: 30 }),
  valuesFirst: fc.boolean(),
})
const envelope = fc.record({
  result: fc.array(series, { maxLength: 6 }),
  warnings: fc.option(fc.array(fc.string({ maxLength: 12 }), { maxLength: 2 }), { nil: undefined }),
  infos: fc.option(fc.array(fc.string({ maxLength: 12 }), { maxLength: 2 }), { nil: undefined }),
  dataFirst: fc.boolean(),
  extra: fc.boolean(),
  indent: fc.constantFrom(0, 0, 1, 2),
})

interface Envelope {
  result: { metric: Record<string, string>; values: [number, string][]; valuesFirst: boolean }[]
  warnings?: string[]
  infos?: string[]
  dataFirst: boolean
  extra: boolean
  indent: number
}

function body(e: Envelope): string {
  const result = e.result.map((s) => (s.valuesFirst ? { values: s.values, metric: s.metric } : { metric: s.metric, values: s.values }))
  const data = { resultType: 'matrix', result }
  const out: Record<string, unknown> = e.dataFirst ? { data, status: 'success' } : { status: 'success', data }
  if (e.extra) out.stats = { timings: { evalTotalTime: 0.01 }, note: 'brackets [y] and braces {z} in a string' }
  if (e.warnings) out.warnings = e.warnings
  if (e.infos) out.infos = e.infos
  return JSON.stringify(out, null, e.indent)
}

describe('the matrix parser (typed arrays, as the body arrives)', () => {
  it('property: reads exactly what JSON.parse and Number read, cut into pieces anywhere', () => {
    fc.assert(
      fc.property(envelope, fc.array(fc.nat(), { maxLength: 8 }), (e, cuts) => {
        const text = body(e)
        const fast = parseInPieces(text, cuts)
        const reference = fromJson(text)
        expect(sameMatrix(fast, reference)).toBeNull()
        expect(fast.text).toBe(text)
      }),
      { numRuns: 1000 },
    )
  })

  it('property: takes the fast path for the bodies APIs send, and keeps each values array as it arrived', () => {
    const plain = fc.record({
      result: fc.array(
        fc.record({
          metric: fc.dictionary(label, labelValue, { maxKeys: 5 }),
          values: fc.array(fc.tuple(time, valueText), { maxLength: 30 }),
          valuesFirst: fc.boolean(),
        }),
        { maxLength: 6 },
      ),
      warnings: fc.option(fc.array(fc.stringMatching(/^[a-z ]{0,12}$/), { maxLength: 2 }), { nil: undefined }),
      infos: fc.constant(undefined),
      dataFirst: fc.boolean(),
      extra: fc.boolean(),
      indent: fc.constantFrom(0, 2),
    })
    fc.assert(
      fc.property(plain, fc.array(fc.nat(), { maxLength: 8 }), (e, cuts) => {
        const text = body(e)
        const fast = parseInPieces(text, cuts)
        expect(fast.fast).toBe(true)
        if (e.indent === 0) {
          const parsed = JSON.parse(text) as { data: { result: { values: unknown }[] } }
          fast.series.forEach((s, i) => expect(s.valuesText()).toBe(JSON.stringify(parsed.data.result[i]!.values)))
        }
      }),
      { numRuns: 500 },
    )
  })

  it('reads the real API\'s and the mock\'s bodies on the fast path', () => {
    const real = '{"status":"success","data":{"resultType":"matrix","result":[{"metric":{"service":"auth"},"values":[[1794994200,"117.259649122807"],[1794994260,"121.64912280701752"]]},{"metric":{},"values":[[1794994200,"+Inf"],[1794994215,"NaN"],[1794994230,"-Inf"]]}]}}'
    const m = parseMatrix(real)
    expect(m.fast).toBe(true)
    expect([...m.series[0]!.times]).toEqual([1794994200, 1794994260])
    expect([...m.series[0]!.values]).toEqual([117.259649122807, 121.64912280701752])
    expect([...m.series[1]!.values]).toEqual([Infinity, NaN, -Infinity])
    expect(m.series[1]!.valuesText()).toBe('[[1794994200,"+Inf"],[1794994215,"NaN"],[1794994230,"-Inf"]]')
    expect(parseMatrix('{"status":"success","data":{"resultType":"matrix","result":[]}}')).toMatchObject({ series: [], fast: true })
  })

  it('gives up the fast path, not the answer, for what it does not read', () => {
    // A native histogram's key, a value that is not a string, a time that is not a JSON number.
    for (const text of [
      '{"status":"success","data":{"resultType":"matrix","result":[{"metric":{},"histograms":[[1,{"count":"1"}]]}]}}',
      '{"status":"success","data":{"resultType":"matrix","result":[{"metric":{},"values":[[1,2]]}]}}',
    ]) {
      const m = parseMatrix(text)
      expect(m.fast).toBe(false)
      expect(sameMatrix(m, fromJson(text))).toBeNull()
    }
    expect(() => parseMatrix('{"status":"success","data":{"resultType":"matrix","result":[{"metric":{},"values":[[+1,"2"]]}]}}')).toThrow(NotAMatrix)
    // A time JSON does not allow is refused as JSON.parse refuses it, in the compact form and the spaced one
    // (the mutation run of this change found no check here: a leading zero was accepted unnoticed).
    for (const t of ['01', '00', '-01', '0123', '.5', '5.', '1.e3', '-']) {
      for (const pair of [`[${t},"2"]`, `[ ${t} , "2" ]`]) {
        const text = `{"status":"success","data":{"resultType":"matrix","result":[{"metric":{},"values":[[0,"1"],${pair}]}]}}`
        expect(() => JSON.parse(text), t).toThrow()
        expect(() => parseMatrix(text), t).toThrow(NotAMatrix)
      }
    }
  })

  it('reports what is not a matrix, with the body when it is JSON', () => {
    const err = (() => {
      try {
        parseMatrix('{"status":"error","errorType":"timeout","error":"query timed out"}')
      } catch (e) {
        return e
      }
    })() as NotAMatrix
    expect(err).toBeInstanceOf(NotAMatrix)
    expect(err.body).toEqual({ status: 'error', errorType: 'timeout', error: 'query timed out' })
    expect(() => parseMatrix('{"status":"success","data":{"resultType":"vector","result":[{"metric":{},"value":[1,"2"]}]}}')).toThrow(NotAMatrix)
    expect(() => parseMatrix('{"status":"success","data":{"resultType":"matrix","result":[{"metric":{},"values":[[1,"2"]')).toThrow(NotAMatrix)
    expect(() => parseMatrix('<html>Bad Gateway</html>')).toThrow(NotAMatrix)
  })

  it('reads numbers as Number does, by the fast path where it is exact', () => {
    const cases = ['0', '-0', '1', '15', '1794994200', '1794994200.5', '1794994200.123', '3.7740', '0.1', '0.000001', '123456789012345', '1234567890123456', '12345678901234567', '1e3', '1.5e-7', '.5', '5.', '+2', '9007199254740993', '0.30000000000000004', '1e400', '-1e-400', '00012', '']
    for (const c of cases) expect(Object.is(readNumber(c, 0, c.length), Number(c)), c).toBe(true)
    fc.assert(
      fc.property(fc.oneof(fc.double().map(String), fc.tuple(fc.double({ noNaN: true, noDefaultInfinity: true, min: -1e9, max: 1e9 }), fc.integer({ min: 0, max: 12 })).map(([d, k]) => d.toFixed(k))), (t) => {
        expect(Object.is(readNumber(t, 0, t.length), Number(t))).toBe(true)
      }),
      { numRuns: 2000 },
    )
  })

  it('knows a JSON number', () => {
    for (const ok of ['0', '-0', '15', '1.5', '1e3', '1E+3', '-1.5e-3', '1794994200.123']) expect(isJsonNumber(ok, 0, ok.length), ok).toBe(true)
    for (const bad of ['', '-', '+1', '.5', '5.', '01', '1e', '1e+', '0x1', 'NaN', '1 ']) expect(isJsonNumber(bad, 0, bad.length), bad).toBe(false)
  })
})
