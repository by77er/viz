/**
 * A deliberately small PromQL implementation for the development mock.
 *
 * Supported: number literals; instant and range selectors with = != =~ !~ matchers and
 * `offset`; rate, irate, increase, delta, *_over_time (avg, min, max, sum, count, last);
 * sum/avg/min/max/count/topk/bottomk/quantile with by/without; histogram_quantile; abs,
 * ceil, floor, round, clamp_min, clamp_max, time, vector, scalar; arithmetic (+ - * / % ^)
 * and comparison operators between scalars and vectors, one-to-one vector matching with
 * on()/ignoring(); unary minus. Not supported: subqueries, set operators (and/or/unless),
 * group_left/group_right, @ modifier, native histograms, and most other functions.
 *
 * rate/increase follow Prometheus' extrapolation algorithm so results match a real server.
 */
import type { Labels, Sample, SeriesSource, Storage } from './storage'

export const LOOKBACK = 300

/**
 * `bad_data` (400): the query or a parameter is wrong. `execution` (422): evaluation failed.
 * `unsupported` (422): valid PromQL this mock does not implement, which is how the real viz
 * API answers valid PromQL its engine does not implement (query/README.md).
 */
export class PromQLError extends Error {
  readonly errorType: 'bad_data' | 'execution' | 'unsupported'
  constructor(message: string, errorType: 'bad_data' | 'execution' | 'unsupported' = 'bad_data') {
    super(message)
    this.name = 'PromQLError'
    this.errorType = errorType
  }
}

// ---------------------------------------------------------------- lexer

type TokType = 'num' | 'dur' | 'id' | 'str' | 'op' | 'eof'
interface Tok {
  type: TokType
  text: string
  num?: number
  pos: number
}

const DUR_RE = /^(?:\d+(?:ms|[smhdwy]))+/
const NUM_RE = /^(?:0x[0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/
const ID_RE = /^[a-zA-Z_:][a-zA-Z0-9_:]*/
const OPS = ['==', '!=', '=~', '!~', '<=', '>=', '+', '-', '*', '/', '%', '^', '<', '>', '=', '(', ')', '{', '}', '[', ']', ',', '@']
const DUR_UNITS: Record<string, number> = { ms: 0.001, s: 1, m: 60, h: 3600, d: 86400, w: 604800, y: 31536000 }

export function durationSeconds(text: string): number {
  let total = 0
  for (const m of text.matchAll(/(\d+)(ms|[smhdwy])/g)) total += Number(m[1]) * DUR_UNITS[m[2]!]!
  return total
}

function position(src: string, pos: number): string {
  const before = src.slice(0, pos)
  const line = before.split('\n').length
  const col = pos - before.lastIndexOf('\n')
  return `${line}:${col}`
}

function lex(src: string): Tok[] {
  const toks: Tok[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]!
    if (/\s/.test(c)) {
      i++
      continue
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i++
      continue
    }
    const rest = src.slice(i)
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1
      let value = ''
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\' && c !== '`') {
          const n = src[j + 1]
          value += n === 'n' ? '\n' : n === 't' ? '\t' : (n ?? '')
          j += 2
        } else {
          value += src[j]
          j++
        }
      }
      if (j >= src.length) throw new PromQLError(`${position(src, i)}: parse error: unterminated quoted string`)
      toks.push({ type: 'str', text: value, pos: i })
      i = j + 1
      continue
    }
    let m = DUR_RE.exec(rest)
    // "5m" is a duration; "5" followed by an identifier character is not.
    if (m && !/^[a-zA-Z0-9_]/.test(rest.slice(m[0].length))) {
      toks.push({ type: 'dur', text: m[0], num: durationSeconds(m[0]), pos: i })
      i += m[0].length
      continue
    }
    m = NUM_RE.exec(rest)
    if (m) {
      toks.push({ type: 'num', text: m[0], num: Number(m[0]), pos: i })
      i += m[0].length
      continue
    }
    m = ID_RE.exec(rest)
    if (m) {
      const lower = m[0].toLowerCase()
      if (lower === 'inf' || lower === 'nan') toks.push({ type: 'num', text: m[0], num: lower === 'inf' ? Infinity : NaN, pos: i })
      else toks.push({ type: 'id', text: m[0], pos: i })
      i += m[0].length
      continue
    }
    const op = OPS.find((o) => rest.startsWith(o))
    if (!op) throw new PromQLError(`${position(src, i)}: parse error: unexpected character: ${JSON.stringify(c)}`)
    toks.push({ type: 'op', text: op, pos: i })
    i += op.length
  }
  toks.push({ type: 'eof', text: '', pos: src.length })
  return toks
}

// ---------------------------------------------------------------- AST

export interface Matcher {
  name: string
  op: '=' | '!=' | '=~' | '!~'
  value: string
}

export interface VectorSelector {
  type: 'selector'
  matchers: Matcher[]
  offset: number
  /** Present for a range selector `[5m]`. */
  range?: number
  pos: number
}

export type Node =
  | { type: 'number'; value: number }
  | { type: 'string'; value: string }
  | VectorSelector
  | { type: 'call'; fn: string; args: Node[]; pos: number }
  | { type: 'agg'; op: string; by?: string[]; without?: string[]; param?: Node; expr: Node; pos: number }
  | { type: 'binary'; op: string; lhs: Node; rhs: Node; bool: boolean; on?: string[]; ignoring?: string[]; pos: number }
  | { type: 'neg'; expr: Node }

const AGGREGATORS = new Set(['sum', 'avg', 'min', 'max', 'count', 'topk', 'bottomk', 'quantile'])
const PARAM_AGGREGATORS = new Set(['topk', 'bottomk', 'quantile'])
const UNSUPPORTED_AGGREGATORS = new Set(['stddev', 'stdvar', 'group', 'count_values', 'limitk', 'limit_ratio'])
const RANGE_FUNCTIONS = new Set([
  'rate', 'irate', 'increase', 'delta',
  'avg_over_time', 'min_over_time', 'max_over_time', 'sum_over_time', 'count_over_time', 'last_over_time',
])
/** name -> [minArgs, maxArgs] */
const FUNCTIONS: Record<string, [number, number]> = {
  histogram_quantile: [2, 2], abs: [1, 1], ceil: [1, 1], floor: [1, 1], round: [1, 2],
  clamp_min: [2, 2], clamp_max: [2, 2], time: [0, 0], vector: [1, 1], scalar: [1, 1],
}
const SET_OPS = new Set(['and', 'or', 'unless'])
/** Every function of PromQL (Prometheus 3): a name here that the mock lacks is unsupported, any other name unknown. */
const PROMQL_FUNCTIONS = new Set(
  ('abs absent absent_over_time acos acosh asin asinh atan atanh avg_over_time ceil changes clamp clamp_max clamp_min cos cosh ' +
    'count_over_time day_of_month day_of_week day_of_year days_in_month deg delta deriv double_exponential_smoothing exp floor ' +
    'histogram_avg histogram_count histogram_fraction histogram_quantile histogram_stddev histogram_stdvar histogram_sum holt_winters ' +
    'hour idelta increase info irate label_join label_replace last_over_time ln log10 log2 mad_over_time max_over_time min_over_time ' +
    'minute month pi predict_linear present_over_time quantile_over_time rad rate resets round scalar sgn sin sinh sort ' +
    'sort_by_label sort_by_label_desc sort_desc sqrt stddev_over_time stdvar_over_time sum_over_time tan tanh time timestamp vector year')
    .split(' '),
)
const COMPARISONS = new Set(['==', '!=', '<', '>', '<=', '>='])

class Parser {
  private i = 0
  private readonly toks: Tok[]
  constructor(private readonly src: string) {
    this.toks = lex(src)
  }

  parse(): Node {
    if (this.peek().type === 'eof') throw new PromQLError('1:1: parse error: no expression found in input')
    const node = this.expr()
    if (this.peek().type !== 'eof') this.fail(this.peek(), `unexpected ${this.describe(this.peek())}`)
    return node
  }

  private peek(): Tok {
    return this.toks[this.i]!
  }
  private next(): Tok {
    return this.toks[this.i++]!
  }
  private isOp(text: string): boolean {
    const t = this.peek()
    return t.type === 'op' && t.text === text
  }
  private isId(text: string): boolean {
    const t = this.peek()
    return t.type === 'id' && t.text === text
  }
  private expect(text: string): Tok {
    // The real API's (and Prometheus') wording for a bracket left open at the end.
    if (text === ')' && this.peek().type === 'eof') this.fail(this.peek(), 'unclosed left parenthesis')
    if (!this.isOp(text)) this.fail(this.peek(), `unexpected ${this.describe(this.peek())}, expected "${text}"`)
    return this.next()
  }
  private describe(t: Tok): string {
    if (t.type === 'eof') return 'end of input'
    if (t.type === 'id') return `identifier "${t.text}"`
    if (t.type === 'str') return `string "${t.text}"`
    if (t.type === 'num') return `number "${t.text}"`
    if (t.type === 'dur') return `duration "${t.text}"`
    return `"${t.text}"`
  }
  private fail(t: Tok, msg: string): never {
    throw new PromQLError(`${position(this.src, t.pos)}: parse error: ${msg}`)
  }
  /** Valid PromQL the mock does not implement: 422 `unsupported`, as the real API answers. */
  private unsupported(msg: string): never {
    throw new PromQLError(`${msg} (not implemented by the viz mock backend)`, 'unsupported')
  }

  private expr(): Node {
    const node = this.comparison()
    const t = this.peek()
    if (t.type === 'id' && SET_OPS.has(t.text)) this.unsupported(`set operator "${t.text}"`)
    return node
  }

  private binaryModifiers(): { bool: boolean; on?: string[]; ignoring?: string[] } {
    let bool = false
    let on: string[] | undefined
    let ignoring: string[] | undefined
    if (this.isId('bool')) {
      this.next()
      bool = true
    }
    if (this.isId('on') || this.isId('ignoring')) {
      const which = this.next().text
      const labels = this.labelList()
      if (which === 'on') on = labels
      else ignoring = labels
      const t = this.peek()
      if (t.type === 'id' && (t.text === 'group_left' || t.text === 'group_right'))
        this.unsupported(t.text)
    }
    return { bool, on, ignoring }
  }

  private comparison(): Node {
    let lhs = this.additive()
    while (this.peek().type === 'op' && COMPARISONS.has(this.peek().text)) {
      const op = this.next()
      const mods = this.binaryModifiers()
      lhs = { type: 'binary', op: op.text, lhs, rhs: this.additive(), ...mods, pos: op.pos }
    }
    return lhs
  }

  private additive(): Node {
    let lhs = this.multiplicative()
    while (this.isOp('+') || this.isOp('-')) {
      const op = this.next()
      const mods = this.binaryModifiers()
      if (mods.bool) this.fail(op, 'bool modifier can only be used on comparison operators')
      lhs = { type: 'binary', op: op.text, lhs, rhs: this.multiplicative(), ...mods, pos: op.pos }
    }
    return lhs
  }

  private multiplicative(): Node {
    let lhs = this.unary()
    while (this.isOp('*') || this.isOp('/') || this.isOp('%')) {
      const op = this.next()
      const mods = this.binaryModifiers()
      if (mods.bool) this.fail(op, 'bool modifier can only be used on comparison operators')
      lhs = { type: 'binary', op: op.text, lhs, rhs: this.unary(), ...mods, pos: op.pos }
    }
    return lhs
  }

  private unary(): Node {
    if (this.isOp('-')) {
      this.next()
      return { type: 'neg', expr: this.unary() }
    }
    if (this.isOp('+')) {
      this.next()
      return this.unary()
    }
    return this.power()
  }

  private power(): Node {
    const base = this.postfix()
    if (this.isOp('^')) {
      const op = this.next()
      const mods = this.binaryModifiers()
      // Right associative, and binds tighter than unary minus on its left.
      return { type: 'binary', op: '^', lhs: base, rhs: this.unary(), ...mods, pos: op.pos }
    }
    return base
  }

  private postfix(): Node {
    const node = this.primary()
    let out = node
    if (this.isOp('[')) {
      const open = this.next()
      if (this.peek().type !== 'dur') this.fail(this.peek(), `unexpected ${this.describe(this.peek())} in range, expected a duration`)
      const range = this.next().num!
      if (this.isOp(':') || this.peek().text.startsWith(':')) this.unsupported('subqueries')
      this.expect(']')
      if (node.type !== 'selector') this.fail(open, 'ranges only allowed for vector selectors')
      out = { ...node, range }
    }
    if (this.isId('offset')) {
      const off = this.next()
      let sign = 1
      if (this.isOp('-')) {
        this.next()
        sign = -1
      }
      if (this.peek().type !== 'dur') this.fail(this.peek(), `unexpected ${this.describe(this.peek())} in offset, expected a duration`)
      const d = this.next().num! * sign
      if (out.type !== 'selector') this.fail(off, 'offset modifier must be preceded by an instant vector selector or range vector selector')
      out = { ...out, offset: d }
    }
    if (this.isOp('@')) this.unsupported('the @ modifier')
    return out
  }

  private primary(): Node {
    const t = this.peek()
    if (t.type === 'num') {
      this.next()
      return { type: 'number', value: t.num! }
    }
    if (t.type === 'dur') {
      // A bare duration is a number of seconds in modern PromQL.
      this.next()
      return { type: 'number', value: t.num! }
    }
    if (t.type === 'str') {
      this.next()
      return { type: 'string', value: t.text }
    }
    if (t.type === 'op' && t.text === '(') {
      this.next()
      const inner = this.expr()
      this.expect(')')
      return inner
    }
    if (t.type === 'op' && t.text === '{') return this.selector(undefined, t.pos)
    if (t.type === 'id') {
      this.next()
      const name = t.text
      if (UNSUPPORTED_AGGREGATORS.has(name) && (this.isOp('(') || this.isId('by') || this.isId('without')))
        this.unsupported(`aggregation "${name}"`)
      if (AGGREGATORS.has(name) && (this.isOp('(') || this.isId('by') || this.isId('without'))) return this.aggregation(name, t.pos)
      if (this.isOp('(')) return this.call(name, t)
      return this.selector(name, t.pos)
    }
    return this.fail(t, `unexpected ${this.describe(t)}`)
  }

  private labelList(): string[] {
    this.expect('(')
    const labels: string[] = []
    while (!this.isOp(')')) {
      const t = this.next()
      if (t.type !== 'id') this.fail(t, `unexpected ${this.describe(t)} in grouping opts, expected label`)
      labels.push(t.text)
      if (!this.isOp(')')) this.expect(',')
    }
    this.expect(')')
    return labels
  }

  private aggregation(op: string, pos: number): Node {
    let by: string[] | undefined
    let without: string[] | undefined
    const grouping = () => {
      if (this.isId('by')) {
        this.next()
        by = this.labelList()
      } else if (this.isId('without')) {
        this.next()
        without = this.labelList()
      }
    }
    grouping()
    const open = this.expect('(')
    const args: Node[] = []
    while (!this.isOp(')')) {
      args.push(this.expr())
      if (!this.isOp(')') && !this.isOp(',')) this.expect(')')
      if (this.isOp(',')) this.next()
    }
    this.expect(')')
    if (!by && !without) grouping()
    const want = PARAM_AGGREGATORS.has(op) ? 2 : 1
    if (args.length !== want) this.fail(open, `wrong number of arguments for aggregate expression provided, expected ${want}, got ${args.length}`)
    return want === 2
      ? { type: 'agg', op, by, without, param: args[0]!, expr: args[1]!, pos }
      : { type: 'agg', op, by, without, expr: args[0]!, pos }
  }

  private call(fn: string, t: Tok): Node {
    const isRange = RANGE_FUNCTIONS.has(fn)
    const arity = FUNCTIONS[fn]
    if (!isRange && !arity) {
      if (PROMQL_FUNCTIONS.has(fn)) this.unsupported(`function "${fn}"`)
      this.fail(t, `unknown function with name '${fn}'`)
    }
    this.expect('(')
    const args: Node[] = []
    while (!this.isOp(')')) {
      args.push(this.expr())
      if (!this.isOp(')') && !this.isOp(',')) this.expect(')')
      if (this.isOp(',')) this.next()
    }
    this.expect(')')
    const [min, max] = isRange ? [1, 1] : arity!
    if (args.length < min || args.length > max)
      this.fail(t, `expected ${min === max ? min : `${min}-${max}`} argument(s) in call to "${fn}", got ${args.length}`)
    if (isRange) {
      const a = args[0]!
      if (a.type !== 'selector' || a.range === undefined)
        this.fail(t, `expected type range vector in call to function "${fn}", got instant vector`)
    }
    return { type: 'call', fn, args, pos: t.pos }
  }

  private selector(name: string | undefined, pos: number): VectorSelector {
    const matchers: Matcher[] = []
    if (name !== undefined) matchers.push({ name: '__name__', op: '=', value: name })
    if (this.isOp('{')) {
      this.next()
      while (!this.isOp('}')) {
        const l = this.next()
        if (l.type !== 'id' && l.type !== 'str') this.fail(l, `unexpected ${this.describe(l)} in label matching, expected identifier or "}"`)
        const op = this.next()
        if (op.type !== 'op' || !['=', '!=', '=~', '!~'].includes(op.text))
          this.fail(op, `unexpected ${this.describe(op)} in label matching, expected label matching operator`)
        const v = this.next()
        if (v.type !== 'str') this.fail(v, `unexpected ${this.describe(v)} in label matching, expected string`)
        if (op.text === '=~' || op.text === '!~') {
          try {
            new RegExp(v.text)
          } catch {
            this.fail(v, `error parsing regexp: ${JSON.stringify(v.text)}`)
          }
        }
        matchers.push({ name: l.text, op: op.text as Matcher['op'], value: v.text })
        if (!this.isOp('}')) this.expect(',')
      }
      this.next()
    }
    if (matchers.length === 0 || matchers.every((m) => matchesEmpty(m)))
      throw new PromQLError(`${position(this.src, pos)}: parse error: vector selector must contain at least one non-empty matcher`)
    return { type: 'selector', matchers, offset: 0, pos }
  }
}

function matchValue(m: Matcher, value: string): boolean {
  switch (m.op) {
    case '=':
      return value === m.value
    case '!=':
      return value !== m.value
    case '=~':
      return new RegExp(`^(?:${m.value})$`).test(value)
    case '!~':
      return !new RegExp(`^(?:${m.value})$`).test(value)
  }
}
const matchesEmpty = (m: Matcher) => matchValue(m, '')

export function parse(src: string): Node {
  return new Parser(src).parse()
}

/** Parse a bare series selector (for `match[]` parameters). */
export function parseSelector(src: string): Matcher[] {
  const node = parse(src)
  if (node.type !== 'selector' || node.range !== undefined) throw new PromQLError('1:1: parse error: expected a series selector')
  return node.matchers
}

export function matchLabels(labels: Labels, matchers: Matcher[]): boolean {
  return matchers.every((m) => matchValue(m, labels[m.name] ?? ''))
}

// ---------------------------------------------------------------- evaluation

export interface VSample {
  labels: Labels
  value: number
}
export type Value = { type: 'scalar'; value: number } | { type: 'vector'; samples: VSample[] } | { type: 'string'; value: string }

function labelsKey(labels: Labels, keep?: (name: string) => boolean): string {
  let out = ''
  for (const k of Object.keys(labels).sort()) {
    if (keep && !keep(k)) continue
    out += `${k}\u0001${labels[k]}\u0002`
  }
  return out
}

function dropName(labels: Labels): Labels {
  if (!('__name__' in labels)) return labels
  const { __name__: _, ...rest } = labels
  return rest
}

/** Prometheus' extrapolatedRate (promql/functions.go). */
export function extrapolatedRate(samples: Sample[], rangeStart: number, rangeEnd: number, isCounter: boolean, isRate: boolean): number | undefined {
  if (samples.length < 2) return undefined
  const first = samples[0]!
  const last = samples[samples.length - 1]!
  let result = last.v - first.v
  if (isCounter) {
    let prev = first.v
    for (let i = 1; i < samples.length; i++) {
      const cur = samples[i]!.v
      if (cur < prev) result += prev
      prev = cur
    }
  }
  let durationToStart = first.t - rangeStart
  let durationToEnd = rangeEnd - last.t
  const sampledInterval = last.t - first.t
  const averageInterval = sampledInterval / (samples.length - 1)
  const threshold = averageInterval * 1.1
  if (durationToStart >= threshold) durationToStart = averageInterval / 2
  if (isCounter && result > 0 && first.v >= 0) {
    const durationToZero = sampledInterval * (first.v / result)
    if (durationToZero < durationToStart) durationToStart = durationToZero
  }
  if (durationToEnd >= threshold) durationToEnd = averageInterval / 2
  let factor = (sampledInterval + durationToStart + durationToEnd) / sampledInterval
  if (isRate) factor /= rangeEnd - rangeStart
  return result * factor
}

function rangeFunction(fn: string, samples: Sample[], start: number, end: number): number | undefined {
  if (samples.length === 0) return undefined
  switch (fn) {
    case 'rate':
      return extrapolatedRate(samples, start, end, true, true)
    case 'increase':
      return extrapolatedRate(samples, start, end, true, false)
    case 'delta':
      return extrapolatedRate(samples, start, end, false, false)
    case 'irate': {
      if (samples.length < 2) return undefined
      const a = samples[samples.length - 2]!
      const b = samples[samples.length - 1]!
      const dv = b.v < a.v ? b.v : b.v - a.v
      return dv / (b.t - a.t)
    }
    case 'avg_over_time':
      return samples.reduce((s, x) => s + x.v, 0) / samples.length
    case 'sum_over_time':
      return samples.reduce((s, x) => s + x.v, 0)
    case 'min_over_time':
      return samples.reduce((s, x) => Math.min(s, x.v), Infinity)
    case 'max_over_time':
      return samples.reduce((s, x) => Math.max(s, x.v), -Infinity)
    case 'count_over_time':
      return samples.length
    case 'last_over_time':
      return samples[samples.length - 1]!.v
  }
  return undefined
}

/** Prometheus' bucketQuantile for classic histograms. */
export function bucketQuantile(q: number, buckets: { le: number; count: number }[]): number {
  if (Number.isNaN(q)) return NaN
  if (q < 0) return -Infinity
  if (q > 1) return Infinity
  const sorted = [...buckets].sort((a, b) => a.le - b.le)
  if (sorted.length < 2 || sorted[sorted.length - 1]!.le !== Infinity) return NaN
  // Enforce monotonic cumulative counts.
  let max = 0
  for (const b of sorted) {
    if (b.count < max) b.count = max
    else max = b.count
  }
  const total = sorted[sorted.length - 1]!.count
  if (total === 0) return NaN
  const rank = q * total
  let b = sorted.findIndex((x) => x.count >= rank)
  if (b < 0) b = sorted.length - 1
  if (b === sorted.length - 1) return sorted[sorted.length - 2]!.le
  if (b === 0 && sorted[0]!.le <= 0) return sorted[0]!.le
  const bucketStart = b === 0 ? 0 : sorted[b - 1]!.le
  const bucketEnd = sorted[b]!.le
  const countBelow = b === 0 ? 0 : sorted[b - 1]!.count
  const inBucket = sorted[b]!.count - countBelow
  return bucketStart + (bucketEnd - bucketStart) * ((rank - countBelow) / inBucket)
}

function arith(op: string, a: number, b: number): number {
  switch (op) {
    case '+':
      return a + b
    case '-':
      return a - b
    case '*':
      return a * b
    case '/':
      return a / b
    case '%':
      return a % b
    case '^':
      return Math.pow(a, b)
    case '==':
      return a === b ? 1 : 0
    case '!=':
      return a !== b ? 1 : 0
    case '<':
      return a < b ? 1 : 0
    case '>':
      return a > b ? 1 : 0
    case '<=':
      return a <= b ? 1 : 0
    case '>=':
      return a >= b ? 1 : 0
  }
  throw new PromQLError(`unknown operator ${op}`, 'execution')
}

function quantileOf(q: number, values: number[]): number {
  if (values.length === 0 || Number.isNaN(q)) return NaN
  if (q < 0) return -Infinity
  if (q > 1) return Infinity
  const s = [...values].sort((a, b) => a - b)
  const rank = q * (s.length - 1)
  const lo = Math.floor(rank)
  const hi = Math.min(s.length - 1, lo + 1)
  const w = rank - lo
  return s[lo]! * (1 - w) + s[hi]! * w
}

export class Evaluator {
  private readonly selected = new Map<VectorSelector, SeriesSource[]>()
  private readonly all: SeriesSource[]

  constructor(storage: Storage) {
    this.all = storage.all()
  }

  private sources(sel: VectorSelector): SeriesSource[] {
    let s = this.selected.get(sel)
    if (!s) {
      s = this.all.filter((x) => matchLabels(x.labels, sel.matchers))
      this.selected.set(sel, s)
    }
    return s
  }

  eval(node: Node, t: number): Value {
    switch (node.type) {
      case 'number':
        return { type: 'scalar', value: node.value }
      case 'string':
        return { type: 'string', value: node.value }
      case 'neg': {
        const v = this.eval(node.expr, t)
        if (v.type === 'scalar') return { type: 'scalar', value: -v.value }
        if (v.type === 'vector') return { type: 'vector', samples: v.samples.map((s) => ({ labels: dropName(s.labels), value: -s.value })) }
        throw new PromQLError('unary expression only allowed on expressions of type scalar or instant vector, got "string"')
      }
      case 'selector': {
        if (node.range !== undefined)
          throw new PromQLError('range vector selectors can only be used as the argument of a range function in the viz mock backend')
        const at = t - node.offset
        const samples: VSample[] = []
        for (const src of this.sources(node)) {
          const s = src.latest(at - LOOKBACK, at)
          if (s) samples.push({ labels: src.labels, value: s.v })
        }
        return { type: 'vector', samples }
      }
      case 'call':
        return this.call(node, t)
      case 'agg':
        return this.aggregate(node, t)
      case 'binary':
        return this.binary(node, t)
    }
  }

  private vector(node: Node, t: number, what: string): VSample[] {
    const v = this.eval(node, t)
    if (v.type !== 'vector') throw new PromQLError(`expected type instant vector in ${what}, got ${v.type}`)
    return v.samples
  }

  private scalar(node: Node, t: number, what: string): number {
    const v = this.eval(node, t)
    if (v.type !== 'scalar') throw new PromQLError(`expected type scalar in ${what}, got ${v.type === 'vector' ? 'instant vector' : v.type}`)
    return v.value
  }

  private call(node: Extract<Node, { type: 'call' }>, t: number): Value {
    const { fn, args } = node
    if (RANGE_FUNCTIONS.has(fn)) {
      const sel = args[0] as VectorSelector
      const end = t - sel.offset
      const start = end - sel.range!
      const samples: VSample[] = []
      for (const src of this.sources(sel)) {
        const v = rangeFunction(fn, src.samples(start, end), start, end)
        if (v !== undefined) samples.push({ labels: dropName(src.labels), value: v })
      }
      return { type: 'vector', samples }
    }
    const what = `call to function "${fn}"`
    const map = (f: (v: number) => number): Value => ({
      type: 'vector',
      samples: this.vector(args[0]!, t, what).map((s) => ({ labels: dropName(s.labels), value: f(s.value) })),
    })
    switch (fn) {
      case 'time':
        return { type: 'scalar', value: t }
      case 'vector':
        return { type: 'vector', samples: [{ labels: {}, value: this.scalar(args[0]!, t, what) }] }
      case 'scalar': {
        const v = this.vector(args[0]!, t, what)
        return { type: 'scalar', value: v.length === 1 ? v[0]!.value : NaN }
      }
      case 'abs':
        return map(Math.abs)
      case 'ceil':
        return map(Math.ceil)
      case 'floor':
        return map(Math.floor)
      case 'round': {
        const to = args[1] ? this.scalar(args[1], t, what) : 1
        return map((v) => Math.floor(v / to + 0.5) * to)
      }
      case 'clamp_min': {
        const m = this.scalar(args[1]!, t, what)
        return map((v) => Math.max(v, m))
      }
      case 'clamp_max': {
        const m = this.scalar(args[1]!, t, what)
        return map((v) => Math.min(v, m))
      }
      case 'histogram_quantile': {
        const q = this.scalar(args[0]!, t, what)
        const groups = new Map<string, { labels: Labels; buckets: { le: number; count: number }[] }>()
        for (const s of this.vector(args[1]!, t, what)) {
          const leText = s.labels.le
          if (leText === undefined) continue
          const le = leText === '+Inf' ? Infinity : Number(leText)
          if (Number.isNaN(le)) continue
          const key = labelsKey(s.labels, (k) => k !== 'le' && k !== '__name__')
          let g = groups.get(key)
          if (!g) {
            const { le: _le, __name__: _n, ...rest } = s.labels
            g = { labels: rest, buckets: [] }
            groups.set(key, g)
          }
          g.buckets.push({ le, count: s.value })
        }
        return { type: 'vector', samples: [...groups.values()].map((g) => ({ labels: g.labels, value: bucketQuantile(q, g.buckets) })) }
      }
    }
    throw new PromQLError(`unknown function "${fn}"`)
  }

  private aggregate(node: Extract<Node, { type: 'agg' }>, t: number): Value {
    const input = this.vector(node.expr, t, `aggregation "${node.op}"`)
    const param = node.param ? this.scalar(node.param, t, `aggregation "${node.op}"`) : 0
    // No grouping clause means "by ()": one group with no labels.
    const by = node.by ? new Set(node.by) : node.without ? undefined : new Set<string>()
    const without = new Set([...(node.without ?? []), '__name__'])
    const keep = (name: string) => (by ? by.has(name) : !without.has(name))
    const groups = new Map<string, { labels: Labels; members: VSample[] }>()
    for (const s of input) {
      const key = labelsKey(s.labels, keep)
      let g = groups.get(key)
      if (!g) {
        const labels: Labels = {}
        for (const k of Object.keys(s.labels)) if (keep(k)) labels[k] = s.labels[k]!
        g = { labels, members: [] }
        groups.set(key, g)
      }
      g.members.push(s)
    }
    const out: VSample[] = []
    for (const g of groups.values()) {
      const values = g.members.map((m) => m.value)
      switch (node.op) {
        case 'sum':
          out.push({ labels: g.labels, value: values.reduce((a, b) => a + b, 0) })
          break
        case 'avg':
          out.push({ labels: g.labels, value: values.reduce((a, b) => a + b, 0) / values.length })
          break
        case 'min':
          out.push({ labels: g.labels, value: values.reduce((a, b) => (b < a || Number.isNaN(a) ? b : a)) })
          break
        case 'max':
          out.push({ labels: g.labels, value: values.reduce((a, b) => (b > a || Number.isNaN(a) ? b : a)) })
          break
        case 'count':
          out.push({ labels: g.labels, value: values.length })
          break
        case 'quantile':
          out.push({ labels: g.labels, value: quantileOf(param, values) })
          break
        case 'topk':
        case 'bottomk': {
          const k = Math.floor(param)
          if (k < 1) break
          const dir = node.op === 'topk' ? -1 : 1
          const sorted = [...g.members].filter((m) => !Number.isNaN(m.value)).sort((a, b) => dir * (a.value - b.value))
          out.push(...sorted.slice(0, k))
          break
        }
      }
    }
    return { type: 'vector', samples: out }
  }

  private binary(node: Extract<Node, { type: 'binary' }>, t: number): Value {
    const l = this.eval(node.lhs, t)
    const r = this.eval(node.rhs, t)
    if (l.type === 'string' || r.type === 'string')
      throw new PromQLError('binary expression must contain only scalar and instant vector types')
    const cmp = COMPARISONS.has(node.op)
    if (l.type === 'scalar' && r.type === 'scalar') {
      if (cmp && !node.bool) throw new PromQLError('comparisons between scalars must use BOOL modifier')
      return { type: 'scalar', value: arith(node.op, l.value, r.value) }
    }
    const filter = cmp && !node.bool
    if (l.type === 'vector' && r.type === 'scalar') {
      const samples: VSample[] = []
      for (const s of l.samples) {
        const v = arith(node.op, s.value, r.value)
        if (filter) {
          if (v) samples.push(s)
        } else samples.push({ labels: dropName(s.labels), value: v })
      }
      return { type: 'vector', samples }
    }
    if (l.type === 'scalar' && r.type === 'vector') {
      const samples: VSample[] = []
      for (const s of r.samples) {
        const v = arith(node.op, l.value, s.value)
        if (filter) {
          if (v) samples.push(s)
        } else samples.push({ labels: dropName(s.labels), value: v })
      }
      return { type: 'vector', samples }
    }
    if (l.type !== 'vector' || r.type !== 'vector') throw new PromQLError('unreachable', 'execution')
    const on = node.on ? new Set(node.on) : undefined
    const ignoring = new Set([...(node.ignoring ?? []), '__name__'])
    const keep = (name: string) => (on ? on.has(name) : !ignoring.has(name))
    const right = new Map<string, VSample>()
    for (const s of r.samples) {
      const key = labelsKey(s.labels, keep)
      if (right.has(key))
        throw new PromQLError('found duplicate series for the match group on the right hand-side of the operation; many-to-one matching is not supported by the viz mock backend', 'execution')
      right.set(key, s)
    }
    const seen = new Set<string>()
    const samples: VSample[] = []
    for (const s of l.samples) {
      const key = labelsKey(s.labels, keep)
      const other = right.get(key)
      if (!other) continue
      if (seen.has(key))
        throw new PromQLError('multiple matches for labels: many-to-one matching must be explicit (group_left/group_right), which the viz mock backend does not support', 'execution')
      seen.add(key)
      const v = arith(node.op, s.value, other.value)
      if (filter) {
        if (v) samples.push(s)
        continue
      }
      const labels: Labels = {}
      for (const k of Object.keys(s.labels)) if (keep(k)) labels[k] = s.labels[k]!
      samples.push({ labels, value: v })
    }
    return { type: 'vector', samples }
  }
}

// ---------------------------------------------------------------- API-shaped results

export function formatSampleValue(v: number): string {
  if (Number.isNaN(v)) return 'NaN'
  if (v === Infinity) return '+Inf'
  if (v === -Infinity) return '-Inf'
  return String(v)
}

export const MAX_POINTS = 11000

export function queryRange(storage: Storage, query: string, start: number, end: number, step: number) {
  // The real API's wording (query/src/params.ts and its engine), parameter name included.
  if (end < start) throw new PromQLError('invalid parameter "end": end timestamp must not be before start time')
  if (!(step > 0)) throw new PromQLError('invalid parameter "step": zero or negative query resolution step widths are not accepted. Try a positive integer')
  if ((end - start) / step > MAX_POINTS)
    throw new PromQLError(`exceeded maximum resolution of ${MAX_POINTS} points per timeseries. Try decreasing the query resolution (?step=XX)`)
  const node = parse(query)
  if (node.type === 'string') throw new PromQLError('invalid expression type "string" for range query, must be Scalar or instant Vector')
  if (node.type === 'selector' && node.range !== undefined)
    throw new PromQLError('invalid expression type "range vector" for range query, must be Scalar or instant Vector')
  const ev = new Evaluator(storage)
  const series = new Map<string, { metric: Labels; values: [number, string][] }>()
  const n = Math.floor((end - start) / step + 1e-9)
  for (let i = 0; i <= n; i++) {
    const t = start + i * step
    const v = ev.eval(node, t)
    const samples = v.type === 'scalar' ? [{ labels: {}, value: v.value }] : v.type === 'vector' ? v.samples : []
    const seen = new Set<string>()
    for (const s of samples) {
      const key = labelsKey(s.labels)
      if (seen.has(key)) throw new PromQLError('vector cannot contain metrics with the same labelset', 'execution')
      seen.add(key)
      let out = series.get(key)
      if (!out) {
        out = { metric: s.labels, values: [] }
        series.set(key, out)
      }
      out.values.push([t, formatSampleValue(s.value)])
    }
  }
  const result = [...series.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, v]) => v)
  return { resultType: 'matrix' as const, result }
}

export function queryInstant(storage: Storage, query: string, time: number) {
  const node = parse(query)
  if (node.type === 'selector' && node.range !== undefined) {
    const end = time - node.offset
    const result = storage
      .all()
      .filter((s) => matchLabels(s.labels, node.matchers))
      .map((s) => ({
        metric: s.labels,
        values: s.samples(end - node.range!, end).map((x) => [x.t, formatSampleValue(x.v)] as [number, string]),
      }))
      .filter((s) => s.values.length > 0)
    return { resultType: 'matrix' as const, result }
  }
  const v = new Evaluator(storage).eval(node, time)
  if (v.type === 'scalar') return { resultType: 'scalar' as const, result: [time, formatSampleValue(v.value)] as [number, string] }
  if (v.type === 'string') return { resultType: 'string' as const, result: [time, v.value] as [number, string] }
  const seen = new Set<string>()
  for (const s of v.samples) {
    const key = labelsKey(s.labels)
    if (seen.has(key)) throw new PromQLError('vector cannot contain metrics with the same labelset', 'execution')
    seen.add(key)
  }
  return {
    resultType: 'vector' as const,
    result: v.samples.map((s) => ({ metric: s.labels, value: [time, formatSampleValue(s.value)] as [number, string] })),
  }
}
