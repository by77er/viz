/**
 * A PromQL parser for `validate_query`: syntax with positions, value types, the selectors
 * a query reads (so the cost can be estimated from series counts without running it) and
 * the functions it calls. It does not evaluate anything; the query service does that.
 *
 * Covers Prometheus 3 syntax: number, string and duration literals; instant and range
 * selectors with `= != =~ !~` (quoted label names and a quoted metric name inside the
 * braces too); subqueries `[r:s]`; `offset` and `@` (`start()`, `end()`); every aggregation
 * with `by`/`without` before or after; binary operators with Prometheus' precedence,
 * `bool`, `on`/`ignoring` and `group_left`/`group_right`; the function list with argument
 * types. Error messages follow Prometheus' wording where one exists, and every error has an
 * offset, a line and a column (both 1-based, as Prometheus prints them).
 */

export type ValueType = 'scalar' | 'vector' | 'matrix' | 'string'

export interface Position {
  /** 0-based character offset. */
  offset: number
  line: number
  column: number
}

export class PromQLSyntaxError extends Error {
  constructor(
    message: string,
    readonly position: Position,
    readonly length = 1,
    /** e.g. an unknown function name, for a did-you-mean. */
    readonly unknown?: { kind: 'function'; name: string },
  ) {
    super(message)
  }
}

export interface Matcher {
  name: string
  op: '=' | '!=' | '=~' | '!~'
  value: string
}

interface Span {
  start: number
  end: number
}

export interface SelectorNode extends Span {
  type: 'selector'
  name?: string
  matchers: Matcher[]
  /** Range in seconds for `x[5m]`. */
  range?: number
  offset?: number
  at?: number | 'start' | 'end'
}

export type Node =
  | (Span & { type: 'number'; value: number })
  | (Span & { type: 'string'; value: string })
  | SelectorNode
  | (Span & { type: 'subquery'; expr: Node; range: number; step?: number; offset?: number; at?: number | 'start' | 'end' })
  | (Span & { type: 'call'; fn: string; args: Node[] })
  | (Span & { type: 'agg'; op: string; grouping: string[] | null; without: boolean; param?: Node; expr: Node })
  | (Span & {
      type: 'binary'
      op: string
      lhs: Node
      rhs: Node
      bool: boolean
      matching: { card: 'one' | 'left' | 'right'; on: boolean; labels: string[]; include: string[] } | null
    })
  | (Span & { type: 'unary'; op: '-' | '+'; expr: Node })
  | (Span & { type: 'paren'; expr: Node })

// ---- function signatures (Prometheus 3.x) ----

interface Signature {
  args: ValueType[]
  /** Arguments from this index on may be omitted. */
  optionalFrom?: number
  /** The last argument type may repeat. */
  variadic?: boolean
  returns: ValueType
}

const V: ValueType = 'vector'
const M: ValueType = 'matrix'
const S: ValueType = 'scalar'
const STR: ValueType = 'string'

export const FUNCTIONS: Record<string, Signature> = {
  abs: { args: [V], returns: V }, absent: { args: [V], returns: V }, absent_over_time: { args: [M], returns: V },
  acos: { args: [V], returns: V }, acosh: { args: [V], returns: V }, asin: { args: [V], returns: V }, asinh: { args: [V], returns: V },
  atan: { args: [V], returns: V }, atanh: { args: [V], returns: V }, avg_over_time: { args: [M], returns: V },
  ceil: { args: [V], returns: V }, changes: { args: [M], returns: V }, clamp: { args: [V, S, S], returns: V },
  clamp_max: { args: [V, S], returns: V }, clamp_min: { args: [V, S], returns: V }, cos: { args: [V], returns: V }, cosh: { args: [V], returns: V },
  count_over_time: { args: [M], returns: V }, days_in_month: { args: [V], optionalFrom: 0, returns: V }, day_of_month: { args: [V], optionalFrom: 0, returns: V },
  day_of_week: { args: [V], optionalFrom: 0, returns: V }, day_of_year: { args: [V], optionalFrom: 0, returns: V }, deg: { args: [V], returns: V },
  delta: { args: [M], returns: V }, deriv: { args: [M], returns: V }, double_exponential_smoothing: { args: [M, S, S], returns: V },
  exp: { args: [V], returns: V }, floor: { args: [V], returns: V }, histogram_avg: { args: [V], returns: V }, histogram_count: { args: [V], returns: V },
  histogram_fraction: { args: [S, S, V], returns: V }, histogram_quantile: { args: [S, V], returns: V }, histogram_stddev: { args: [V], returns: V },
  histogram_stdvar: { args: [V], returns: V }, histogram_sum: { args: [V], returns: V }, holt_winters: { args: [M, S, S], returns: V },
  hour: { args: [V], optionalFrom: 0, returns: V }, idelta: { args: [M], returns: V }, increase: { args: [M], returns: V },
  info: { args: [V, V], optionalFrom: 1, returns: V }, irate: { args: [M], returns: V },
  label_join: { args: [V, STR, STR, STR], variadic: true, optionalFrom: 3, returns: V }, label_replace: { args: [V, STR, STR, STR, STR], returns: V },
  last_over_time: { args: [M], returns: V }, ln: { args: [V], returns: V }, log10: { args: [V], returns: V }, log2: { args: [V], returns: V },
  mad_over_time: { args: [M], returns: V }, max_over_time: { args: [M], returns: V }, min_over_time: { args: [M], returns: V },
  minute: { args: [V], optionalFrom: 0, returns: V }, month: { args: [V], optionalFrom: 0, returns: V }, pi: { args: [], returns: S },
  predict_linear: { args: [M, S], returns: V }, present_over_time: { args: [M], returns: V }, quantile_over_time: { args: [S, M], returns: V },
  rad: { args: [V], returns: V }, rate: { args: [M], returns: V }, resets: { args: [M], returns: V }, round: { args: [V, S], optionalFrom: 1, returns: V },
  scalar: { args: [V], returns: S }, sgn: { args: [V], returns: V }, sin: { args: [V], returns: V }, sinh: { args: [V], returns: V },
  sort: { args: [V], returns: V }, sort_by_label: { args: [V, STR], variadic: true, optionalFrom: 1, returns: V },
  sort_by_label_desc: { args: [V, STR], variadic: true, optionalFrom: 1, returns: V }, sort_desc: { args: [V], returns: V },
  sqrt: { args: [V], returns: V }, stddev_over_time: { args: [M], returns: V }, stdvar_over_time: { args: [M], returns: V },
  sum_over_time: { args: [M], returns: V }, tan: { args: [V], returns: V }, tanh: { args: [V], returns: V }, time: { args: [], returns: S },
  timestamp: { args: [V], returns: V }, vector: { args: [S], returns: V }, year: { args: [V], optionalFrom: 0, returns: V },
}

export const AGGREGATIONS = new Set(['sum', 'min', 'max', 'avg', 'group', 'stddev', 'stdvar', 'count', 'count_values', 'bottomk', 'topk', 'quantile', 'limitk', 'limit_ratio'])
const PARAM_AGG: Record<string, ValueType> = { count_values: STR, bottomk: S, topk: S, quantile: S, limitk: S, limit_ratio: S }
const COMPARISON = new Set(['==', '!=', '<=', '<', '>=', '>'])
const SET_OPS = new Set(['and', 'or', 'unless'])
/** Functions whose argument should be a counter (monotonic). */
export const COUNTER_FUNCTIONS = new Set(['rate', 'irate', 'increase', 'resets'])

// ---- lexer ----

type TokType = 'num' | 'dur' | 'str' | 'id' | 'op' | 'eof'
interface Tok {
  type: TokType
  text: string
  pos: number
  end: number
  num?: number
  str?: string
}

const DUR_UNITS: Record<string, number> = { ms: 0.001, s: 1, m: 60, h: 3600, d: 86400, w: 604800, y: 31536000 }
const DUR_RE = /^(?:\d+(?:ms|s|m|h|d|w|y))+/
const NUM_RE = /^(?:0[xX][0-9a-fA-F]+|(?:\d+(?:_\d+)*\.?\d*(?:_\d+)*|\.\d+)(?:[eE][+-]?\d+)?)/
const ID_RE = /^[a-zA-Z_:][a-zA-Z0-9_:]*/
const OPS = ['==', '!=', '=~', '!~', '<=', '>=', '+', '-', '*', '/', '%', '^', '<', '>', '=', '(', ')', '{', '}', '[', ']', ',', ':', '@']

export function durationSeconds(text: string): number {
  let total = 0
  for (const m of text.matchAll(/(\d+)(ms|s|m|h|d|w|y)/g)) total += Number(m[1]) * DUR_UNITS[m[2]!]!
  return total
}

export function positionOf(src: string, offset: number): Position {
  const before = src.slice(0, offset)
  const line = before.split('\n').length
  return { offset, line, column: offset - before.lastIndexOf('\n') }
}

function lex(src: string): Tok[] {
  const toks: Tok[] = []
  const fail = (pos: number, msg: string, len = 1): never => {
    throw new PromQLSyntaxError(msg, positionOf(src, pos), len)
  }
  let i = 0
  // Inside [...] a colon separates a subquery's range from its step; elsewhere it can start a metric name.
  let brackets = 0
  while (i < src.length) {
    const c = src[i]!
    if (c === '[') brackets++
    else if (c === ']') brackets = Math.max(0, brackets - 1)
    if (c === ':' && brackets > 0) {
      toks.push({ type: 'op', text: ':', pos: i, end: i + 1 })
      i++
      continue
    }
    if (/\s/.test(c)) {
      i++
      continue
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i++
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1
      let value = ''
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\' && c !== '`') {
          const n = src[j + 1]
          if (n === undefined) break
          const esc: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', '"': '"', "'": "'", a: '\x07', b: '\b', f: '\f', v: '\v' }
          if (n in esc) {
            value += esc[n]
            j += 2
          } else if (n === 'x' && /^[0-9a-fA-F]{2}$/.test(src.slice(j + 2, j + 4))) {
            value += String.fromCharCode(parseInt(src.slice(j + 2, j + 4), 16))
            j += 4
          } else if (n === 'u' && /^[0-9a-fA-F]{4}$/.test(src.slice(j + 2, j + 6))) {
            value += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16))
            j += 6
          } else fail(j, `unknown escape sequence ${JSON.stringify('\\' + n)}`, 2)
        } else {
          if (src[j] === '\n' && c !== '`') fail(i, 'unterminated quoted string', j - i)
          value += src[j]
          j++
        }
      }
      if (j >= src.length) fail(i, 'unterminated quoted string', src.length - i)
      toks.push({ type: 'str', text: src.slice(i, j + 1), str: value, pos: i, end: j + 1 })
      i = j + 1
      continue
    }
    const rest = src.slice(i)
    let m = DUR_RE.exec(rest)
    if (m && !/^[a-zA-Z0-9_.]/.test(rest.slice(m[0].length))) {
      toks.push({ type: 'dur', text: m[0], num: durationSeconds(m[0]), pos: i, end: i + m[0].length })
      i += m[0].length
      continue
    }
    m = NUM_RE.exec(rest)
    if (m) {
      const after = rest.slice(m[0].length)
      if (/^[a-zA-Z_]/.test(after) && !/^[eE]/.test(after)) fail(i, `bad number or duration syntax: ${JSON.stringify(rest.slice(0, m[0].length + 1))}`, m[0].length + 1)
      toks.push({ type: 'num', text: m[0], num: Number(m[0].replace(/_/g, '')), pos: i, end: i + m[0].length })
      i += m[0].length
      continue
    }
    m = ID_RE.exec(rest)
    if (m) {
      const lower = m[0].toLowerCase()
      if (lower === 'inf' || lower === 'nan') toks.push({ type: 'num', text: m[0], num: lower === 'inf' ? Infinity : NaN, pos: i, end: i + m[0].length })
      else toks.push({ type: 'id', text: m[0], pos: i, end: i + m[0].length })
      i += m[0].length
      continue
    }
    const op = OPS.find((o) => rest.startsWith(o))
    if (!op) fail(i, `unexpected character: ${JSON.stringify(c)}`)
    toks.push({ type: 'op', text: op!, pos: i, end: i + op!.length })
    i += op!.length
  }
  toks.push({ type: 'eof', text: '', pos: src.length, end: src.length })
  return toks
}

// ---- parser ----

const KEYWORDS = new Set(['by', 'without', 'on', 'ignoring', 'group_left', 'group_right', 'offset', 'bool', 'and', 'or', 'unless', 'atan2'])

class Parser {
  private i = 0
  private readonly toks: Tok[]
  constructor(private readonly src: string) {
    this.toks = lex(src)
  }

  parse(): Node {
    if (this.peek().type === 'eof') this.fail(this.peek(), 'no expression found in input')
    const node = this.expr(0)
    if (this.peek().type !== 'eof') this.fail(this.peek(), `unexpected ${this.describe(this.peek())}`)
    return node
  }

  private peek(k = 0): Tok {
    return this.toks[Math.min(this.i + k, this.toks.length - 1)]!
  }
  private next(): Tok {
    return this.toks[this.i++]!
  }
  private isOp(text: string, k = 0): boolean {
    const t = this.peek(k)
    return t.type === 'op' && t.text === text
  }
  private isId(text: string, k = 0): boolean {
    const t = this.peek(k)
    return t.type === 'id' && t.text.toLowerCase() === text
  }
  private expect(text: string, what?: string): Tok {
    if (!this.isOp(text)) this.fail(this.peek(), `unexpected ${this.describe(this.peek())}${what ? ` in ${what}` : ''}, expected "${text}"`)
    return this.next()
  }
  private describe(t: Tok): string {
    if (t.type === 'eof') return 'end of input'
    if (t.type === 'id') return `identifier ${JSON.stringify(t.text)}`
    if (t.type === 'str') return `string ${t.text}`
    if (t.type === 'num') return `number ${JSON.stringify(t.text)}`
    if (t.type === 'dur') return `duration ${JSON.stringify(t.text)}`
    return JSON.stringify(t.text)
  }
  fail(t: Tok | number, msg: string, len?: number, unknown?: PromQLSyntaxError['unknown']): never {
    const pos = typeof t === 'number' ? t : t.pos
    const l = len ?? (typeof t === 'number' ? 1 : Math.max(1, t.end - t.pos))
    throw new PromQLSyntaxError(msg, positionOf(this.src, pos), l, unknown)
  }

  /** Binary operators by precedence, lowest first. */
  private static readonly LEVELS: string[][] = [['or'], ['and', 'unless'], ['==', '!=', '<=', '<', '>=', '>'], ['+', '-'], ['*', '/', '%', 'atan2']]

  private binOpAt(level: number): string | null {
    const t = this.peek()
    const ops = Parser.LEVELS[level]!
    if (t.type === 'op' && ops.includes(t.text)) return t.text
    if (t.type === 'id' && ops.includes(t.text.toLowerCase())) return t.text.toLowerCase()
    return null
  }

  private expr(level: number): Node {
    if (level >= Parser.LEVELS.length) return this.unary()
    let lhs = this.expr(level + 1)
    for (;;) {
      const op = this.binOpAt(level)
      if (op === null) return lhs
      const opTok = this.next()
      const mods = this.modifiers(op, opTok)
      const rhs = this.expr(level + 1)
      lhs = { type: 'binary', op, lhs, rhs, ...mods, start: lhs.start, end: rhs.end }
    }
  }

  private modifiers(op: string, opTok: Tok): { bool: boolean; matching: Extract<Node, { type: 'binary' }>['matching'] } {
    let bool = false
    if (this.isId('bool')) {
      const b = this.next()
      if (!COMPARISON.has(op)) this.fail(b, 'bool modifier can only be used on comparison operators')
      bool = true
    }
    let matching: Extract<Node, { type: 'binary' }>['matching'] = null
    if (this.isId('on') || this.isId('ignoring')) {
      const on = this.next().text.toLowerCase() === 'on'
      const labels = this.labelList('grouping opts')
      matching = { card: 'one', on, labels, include: [] }
      if (this.isId('group_left') || this.isId('group_right')) {
        const g = this.next()
        if (SET_OPS.has(op)) this.fail(g, `no grouping allowed for "${op}" operation`)
        matching.card = g.text.toLowerCase() === 'group_left' ? 'left' : 'right'
        if (this.isOp('(')) matching.include = this.labelList('grouping opts')
      }
    } else if (this.isId('group_left') || this.isId('group_right')) {
      this.fail(this.peek(), `unexpected ${this.describe(this.peek())}; group_left and group_right need on(...) or ignoring(...) first`)
    }
    void opTok
    return { bool, matching }
  }

  private unary(): Node {
    if (this.isOp('-') || this.isOp('+')) {
      const t = this.next()
      const inner = this.unary()
      // Fold a signed number literal, as Prometheus does.
      if (inner.type === 'number') return { ...inner, value: t.text === '-' ? -inner.value : inner.value, start: t.pos }
      return { type: 'unary', op: t.text as '-' | '+', expr: inner, start: t.pos, end: inner.end }
    }
    return this.power()
  }

  private power(): Node {
    const base = this.postfix()
    if (this.isOp('^')) {
      const t = this.next()
      const mods = this.modifiers('^', t)
      const rhs = this.unary() // right-associative, and binds tighter than a unary minus on its left
      return { type: 'binary', op: '^', lhs: base, rhs, ...mods, start: base.start, end: rhs.end }
    }
    return base
  }

  private duration(what: string): number {
    const t = this.peek()
    if (t.type === 'dur') return this.next().num!
    if (t.type === 'num' && Number.isFinite(t.num)) return this.next().num! // Prometheus 3 accepts a number of seconds
    return this.fail(t, `unexpected ${this.describe(t)} in ${what}, expected a duration`)
  }

  private postfix(): Node {
    let node = this.primary()
    if (this.isOp('[')) {
      const open = this.next()
      const range = this.duration('range')
      if (range <= 0) this.fail(open, 'range must be greater than 0')
      if (this.isOp(':')) {
        this.next()
        let step: number | undefined
        if (!this.isOp(']')) step = this.duration('subquery step')
        const close = this.expect(']', 'subquery selector')
        const t = typeOf(node)
        if (t !== 'vector' && t !== 'scalar') this.fail(open, `subquery is only allowed on instant vector, got ${typeName(t)} instead`)
        node = { type: 'subquery', expr: node, range, ...(step !== undefined ? { step } : {}), start: node.start, end: close.end }
      } else {
        const close = this.expect(']', 'range selector')
        if (node.type !== 'selector') this.fail(open, `ranges only allowed for vector selectors`)
        if (node.range !== undefined) this.fail(open, 'duplicate range')
        if (node.offset !== undefined || node.at !== undefined) this.fail(open, 'range must come before offset and @')
        node = { ...node, range, end: close.end }
      }
    }
    // offset and @, in either order, each at most once.
    for (;;) {
      if (this.isId('offset')) {
        const off = this.next()
        let sign = 1
        if (this.isOp('-')) {
          this.next()
          sign = -1
        } else if (this.isOp('+')) this.next()
        const d = this.duration('offset') * sign
        if (node.type !== 'selector' && node.type !== 'subquery') this.fail(off, 'offset modifier must be preceded by an instant vector selector or range vector selector or a subquery')
        if (node.offset !== undefined) this.fail(off, 'offset may not be set multiple times')
        node = { ...node, offset: d, end: this.peek(-1).end }
        continue
      }
      if (this.isOp('@')) {
        const at = this.next()
        let value: number | 'start' | 'end'
        if (this.isId('start') || this.isId('end')) {
          const which = this.next().text.toLowerCase() as 'start' | 'end'
          this.expect('(', '@ modifier')
          this.expect(')', '@ modifier')
          value = which
        } else {
          let sign = 1
          if (this.isOp('-')) {
            this.next()
            sign = -1
          }
          const t = this.peek()
          if (t.type !== 'num' && t.type !== 'dur') this.fail(t, `unexpected ${this.describe(t)} in @, expected a timestamp, start() or end()`)
          value = sign * this.next().num!
        }
        if (node.type !== 'selector' && node.type !== 'subquery') this.fail(at, '@ modifier must be preceded by an instant vector selector or range vector selector or a subquery')
        if (node.at !== undefined) this.fail(at, '@ may not be set multiple times')
        node = { ...node, at: value, end: this.peek(-1).end }
        continue
      }
      return node
    }
  }

  private primary(): Node {
    const t = this.peek()
    if (t.type === 'num' || t.type === 'dur') {
      this.next()
      return { type: 'number', value: t.num!, start: t.pos, end: t.end }
    }
    if (t.type === 'str') {
      this.next()
      return { type: 'string', value: t.str!, start: t.pos, end: t.end }
    }
    if (this.isOp('(')) {
      this.next()
      const inner = this.expr(0)
      const close = this.expect(')', 'paren expression')
      return { type: 'paren', expr: inner, start: t.pos, end: close.end }
    }
    if (this.isOp('{')) return this.selector(undefined, t)
    if (t.type === 'id') {
      const lower = t.text.toLowerCase()
      if (AGGREGATIONS.has(lower) && (this.isOp('(', 1) || this.isId('by', 1) || this.isId('without', 1))) {
        this.next()
        return this.aggregation(lower, t)
      }
      if (this.isOp('(', 1)) {
        this.next()
        return this.call(t)
      }
      if (KEYWORDS.has(lower)) this.fail(t, `unexpected ${this.describe(t)}`)
      this.next()
      return this.selector(t.text, t)
    }
    return this.fail(t, `unexpected ${this.describe(t)}`)
  }

  private labelList(what: string): string[] {
    this.expect('(', what)
    const labels: string[] = []
    while (!this.isOp(')')) {
      const t = this.next()
      if (t.type === 'id') labels.push(t.text)
      else if (t.type === 'str') labels.push(t.str!)
      else this.fail(t, `unexpected ${this.describe(t)} in ${what}, expected label`)
      if (!this.isOp(')')) this.expect(',', what)
    }
    this.expect(')', what)
    return labels
  }

  private aggregation(op: string, t: Tok): Node {
    const g: { grouping: string[] | null; without: boolean } = { grouping: null, without: false }
    const groupingClause = () => {
      if (this.isId('by') || this.isId('without')) {
        g.without = this.next().text.toLowerCase() === 'without'
        g.grouping = this.labelList('grouping opts')
      }
    }
    groupingClause()
    const open = this.expect('(', 'aggregation')
    const args: Node[] = []
    while (!this.isOp(')')) {
      args.push(this.expr(0))
      if (this.isOp(',')) this.next()
      else if (!this.isOp(')')) this.fail(this.peek(), `unexpected ${this.describe(this.peek())} in aggregation, expected ")" or ","`)
    }
    const close = this.expect(')', 'aggregation')
    if (g.grouping === null) groupingClause()
    const { grouping, without } = g
    const wantParam = op in PARAM_AGG
    if (args.length !== (wantParam ? 2 : 1)) this.fail(open, `wrong number of arguments for aggregate expression provided, expected ${wantParam ? 2 : 1}, got ${args.length}`)
    const node: Node = wantParam
      ? { type: 'agg', op, grouping, without, param: args[0]!, expr: args[1]!, start: t.pos, end: Math.max(close.end, this.peek(-1).end) }
      : { type: 'agg', op, grouping, without, expr: args[0]!, start: t.pos, end: Math.max(close.end, this.peek(-1).end) }
    return node
  }

  private call(t: Tok): Node {
    const name = t.text
    const sig = FUNCTIONS[name]
    if (!sig) this.fail(t, `unknown function with name ${JSON.stringify(name)}`, t.end - t.pos, { kind: 'function', name })
    this.expect('(', 'function call')
    const args: Node[] = []
    while (!this.isOp(')')) {
      args.push(this.expr(0))
      if (this.isOp(',')) this.next()
      else if (!this.isOp(')')) this.fail(this.peek(), `unexpected ${this.describe(this.peek())} in function call, expected ")" or ","`)
    }
    const close = this.expect(')', 'function call')
    return { type: 'call', fn: name, args, start: t.pos, end: close.end }
  }

  private selector(name: string | undefined, t: Tok): SelectorNode {
    const matchers: Matcher[] = []
    let metric = name
    if (this.isOp('{')) {
      this.next()
      while (!this.isOp('}')) {
        const l = this.next()
        if (l.type !== 'id' && l.type !== 'str') this.fail(l, `unexpected ${this.describe(l)} in label matching, expected identifier or "}"`)
        const label = l.type === 'id' ? l.text : l.str!
        // Prometheus 3: a quoted name alone inside the braces is the metric name.
        if (l.type === 'str' && (this.isOp(',') || this.isOp('}'))) {
          if (metric !== undefined) this.fail(l, 'metric name must not be set twice')
          metric = label
        } else {
          const op = this.next()
          if (op.type !== 'op' || !['=', '!=', '=~', '!~'].includes(op.text)) this.fail(op, `unexpected ${this.describe(op)} in label matching, expected one of "=", "!=", "=~" or "!~"`)
          const v = this.next()
          if (v.type !== 'str') this.fail(v, `unexpected ${this.describe(v)} in label matching, expected string`)
          if (label === '__name__' && op.text === '=') {
            if (metric !== undefined && metric !== v.str) this.fail(l, `metric name must not be set twice: ${JSON.stringify(metric)} or ${JSON.stringify(v.str)}`)
            metric = v.str
          } else matchers.push({ name: label, op: op.text as Matcher['op'], value: v.str! })
        }
        if (!this.isOp('}')) this.expect(',', 'label matching')
      }
      const close = this.expect('}', 'label matching')
      if (metric === undefined && !matchers.some((m) => (m.op === '=' && m.value !== '') || (m.op === '=~' && !regexMatchesEmpty(m.value)) || (m.op === '!=' && m.value === ''))) {
        this.fail(t, 'vector selector must contain at least one non-empty matcher', close.end - t.pos)
      }
      return { type: 'selector', ...(metric !== undefined ? { name: metric } : {}), matchers, start: t.pos, end: close.end }
    }
    return { type: 'selector', name: metric!, matchers, start: t.pos, end: t.end }
  }
}

/**
 * Whether a label regex matches the empty string. Prometheus uses RE2 and JavaScript does
 * not, so a pattern JavaScript cannot compile (e.g. RE2's `(?i)`) is treated as not
 * matching empty; the query service is the authority on regex syntax.
 */
export function regexMatchesEmpty(pattern: string): boolean {
  try {
    return new RegExp(`^(?:${pattern.replace(/^\(\?[imsU]+\)/, '')})$`, 'u').test('')
  } catch {
    return false
  }
}

// ---- types ----

export function typeName(t: ValueType): string {
  return t === 'vector' ? 'instant vector' : t === 'matrix' ? 'range vector' : t
}

/** The value type of a node, assuming it parsed; `check` reports mismatches. */
export function typeOf(n: Node): ValueType {
  switch (n.type) {
    case 'number':
      return 'scalar'
    case 'string':
      return 'string'
    case 'selector':
      return n.range !== undefined ? 'matrix' : 'vector'
    case 'subquery':
      return 'matrix'
    case 'call':
      return FUNCTIONS[n.fn]?.returns ?? 'vector'
    case 'agg':
      return 'vector'
    case 'binary':
      return typeOf(n.lhs) === 'scalar' && typeOf(n.rhs) === 'scalar' ? 'scalar' : 'vector'
    case 'unary':
    case 'paren':
      return typeOf(n.expr)
  }
}

function check(src: string, n: Node): void {
  const fail = (node: { start: number; end: number }, msg: string): never => {
    throw new PromQLSyntaxError(msg, positionOf(src, node.start), Math.max(1, node.end - node.start))
  }
  const want = (node: Node, types: ValueType[], ctx: string) => {
    const t = typeOf(node)
    if (!types.includes(t)) fail(node, `expected type ${types.map(typeName).join(' or ')} in ${ctx}, got ${typeName(t)}`)
  }
  switch (n.type) {
    case 'call': {
      const sig = FUNCTIONS[n.fn]!
      const min = sig.optionalFrom ?? sig.args.length
      const max = sig.variadic ? Infinity : sig.args.length
      if (n.args.length < min || n.args.length > max) {
        fail(n, `expected ${min === max ? min : max === Infinity ? `at least ${min}` : `${min} to ${max}`} argument(s) in call to ${JSON.stringify(n.fn)}, got ${n.args.length}`)
      }
      n.args.forEach((a, i) => {
        check(src, a)
        const t = sig.args[Math.min(i, sig.args.length - 1)]!
        want(a, [t], `call to function ${JSON.stringify(n.fn)}`)
      })
      return
    }
    case 'agg':
      check(src, n.expr)
      want(n.expr, ['vector'], 'aggregation expression')
      if (n.param) {
        check(src, n.param)
        want(n.param, [PARAM_AGG[n.op]!], `aggregation parameter of ${n.op}`)
      }
      return
    case 'binary': {
      check(src, n.lhs)
      check(src, n.rhs)
      const l = typeOf(n.lhs)
      const r = typeOf(n.rhs)
      for (const [side, t] of [[n.lhs, l], [n.rhs, r]] as const) {
        if (t !== 'scalar' && t !== 'vector') fail(side, `binary expression must contain only scalar and instant vector types`)
      }
      if (SET_OPS.has(n.op) && (l !== 'vector' || r !== 'vector')) fail(n, `set operator "${n.op}" not allowed in binary scalar expression`)
      if (COMPARISON.has(n.op) && l === 'scalar' && r === 'scalar' && !n.bool) fail(n, 'comparisons between scalars must use BOOL modifier')
      if (n.matching && (l !== 'vector' || r !== 'vector')) fail(n, 'vector matching only allowed between instant vectors')
      return
    }
    case 'unary':
      check(src, n.expr)
      want(n.expr, ['scalar', 'vector'], 'unary expression')
      return
    case 'paren':
      check(src, n.expr)
      return
    case 'subquery':
      check(src, n.expr)
      return
    default:
      return
  }
}

// ---- public API ----

export interface ParsedQuery {
  ast: Node
  type: ValueType
}

/** Parse and type-check. Throws `PromQLSyntaxError` with a position. */
export function parsePromQL(src: string): ParsedQuery {
  const ast = new Parser(src).parse()
  check(src, ast)
  return { ast, type: typeOf(ast) }
}

export function walk(n: Node, visit: (n: Node, parent: Node | null) => void, parent: Node | null = null): void {
  visit(n, parent)
  switch (n.type) {
    case 'call':
      n.args.forEach((a) => walk(a, visit, n))
      return
    case 'agg':
      if (n.param) walk(n.param, visit, n)
      walk(n.expr, visit, n)
      return
    case 'binary':
      walk(n.lhs, visit, n)
      walk(n.rhs, visit, n)
      return
    case 'unary':
    case 'paren':
    case 'subquery':
      walk(n.expr, visit, n)
      return
    default:
      return
  }
}

/** Every vector selector, with the range it is read over and the function that reads it. */
export function selectorsOf(ast: Node): { node: SelectorNode; fn: string | null }[] {
  const out: { node: SelectorNode; fn: string | null }[] = []
  walk(ast, (n, parent) => {
    if (n.type === 'selector') out.push({ node: n, fn: parent?.type === 'call' ? parent.fn : null })
  })
  return out
}

/** A selector as `match[]` text for the series API. Values are re-quoted, so the text is exact. */
export function selectorText(s: SelectorNode): string {
  const parts: string[] = []
  if (s.name !== undefined) parts.push(`__name__=${JSON.stringify(s.name)}`)
  for (const m of s.matchers) parts.push(`${/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(m.name) ? m.name : JSON.stringify(m.name)}${m.op}${JSON.stringify(m.value)}`)
  return `{${parts.join(',')}}`
}
