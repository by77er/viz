/**
 * A small, safe subset of Prometheus' alert templating (Go text/template).
 *
 * Supported inside `{{ }}`:
 *   operands   $labels.x  $externalLabels.x  $value  .Labels.x  .ExternalLabels.x  .Value
 *              "string literals" and number literals (as function arguments)
 *   functions  humanize humanize1024 humanizeDuration humanizePercentage humanizeTimestamp
 *              printf toUpper toLower title
 *   forms      {{ $value | humanize }}   {{ humanize $value }}   {{ printf "%.2f" $value }}
 *              whitespace trimming with {{- and -}}
 *
 * Everything else (if/range/with/define, variables, `query`, `$externalURL`, arbitrary
 * functions) is rejected when the rule is saved, with the position and a suggested fix.
 * Templates are parsed into a tiny tree and interpreted; nothing is ever compiled to code.
 */
import { labelValue } from './util'

export interface TemplateError {
  /** Character offset into the template text. */
  offset: number
  message: string
  fix: string
}

type Operand =
  | { t: 'label'; name: string }
  | { t: 'ext'; name: string }
  | { t: 'value' }
  | { t: 'str'; v: string }
  | { t: 'num'; v: number }

interface Command {
  fn: string | null
  args: Operand[]
}

type Node = { t: 'text'; v: string } | { t: 'action'; pipe: Command[] }

export interface Template {
  nodes: Node[]
  /** True when the template has no actions: expansion is the text itself. */
  constant: boolean
  source: string
}

export interface TemplateData {
  labels: Record<string, string>
  externalLabels: Record<string, string>
  value: number
}

const FUNCTIONS: Record<string, { min: number; max: number }> = {
  humanize: { min: 1, max: 1 },
  humanize1024: { min: 1, max: 1 },
  humanizeDuration: { min: 1, max: 1 },
  humanizePercentage: { min: 1, max: 1 },
  humanizeTimestamp: { min: 1, max: 1 },
  toUpper: { min: 1, max: 1 },
  toLower: { min: 1, max: 1 },
  title: { min: 1, max: 1 },
  printf: { min: 1, max: 8 },
}

const SUPPORTED =
  'Supported: {{ $labels.name }}, {{ $externalLabels.name }}, {{ $value }}, and the functions ' +
  Object.keys(FUNCTIONS).join(', ') +
  ' (as `{{ $value | humanize }}` or `{{ humanize $value }}`).'

const CONTROL = new Set(['if', 'else', 'end', 'range', 'with', 'define', 'template', 'block', 'break', 'continue'])

class ParseFailure extends Error {
  constructor(readonly err: TemplateError) {
    super(err.message)
  }
}

function fail(offset: number, message: string, fix: string): never {
  throw new ParseFailure({ offset, message, fix })
}

/** Split an action body into tokens: words, quoted strings, and `|`. */
function tokenize(body: string, base: number): { tok: string; at: number }[] {
  const out: { tok: string; at: number }[] = []
  let i = 0
  while (i < body.length) {
    const c = body[i] as string
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++
    } else if (c === '|') {
      out.push({ tok: '|', at: base + i })
      i++
    } else if (c === '"') {
      let j = i + 1
      while (j < body.length && body[j] !== '"') j += body[j] === '\\' ? 2 : 1
      if (j >= body.length) fail(base + i, 'unterminated string literal in template action', 'Close the string with a double quote.')
      out.push({ tok: body.slice(i, j + 1), at: base + i })
      i = j + 1
    } else if (c === '`') {
      const j = body.indexOf('`', i + 1)
      if (j < 0) fail(base + i, 'unterminated raw string in template action', 'Close the string with a backquote.')
      out.push({ tok: JSON.stringify(body.slice(i + 1, j)), at: base + i })
      i = j + 1
    } else if (c === '(' || c === ')') {
      fail(base + i, 'parentheses are not supported in template actions', `Use a single pipeline. ${SUPPORTED}`)
    } else {
      let j = i
      while (j < body.length && !' \t\n\r|"`()'.includes(body[j] as string)) j++
      out.push({ tok: body.slice(i, j), at: base + i })
      i = j
    }
  }
  return out
}

function parseOperand(tok: string, at: number): Operand | null {
  if (tok === '$value' || tok === '.Value') return { t: 'value' }
  for (const [prefix, kind] of [['$labels.', 'label'], ['.Labels.', 'label'], ['$externalLabels.', 'ext'], ['.ExternalLabels.', 'ext']] as const) {
    if (tok.startsWith(prefix)) {
      const name = tok.slice(prefix.length)
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
        fail(at, `"${tok}" is not a valid label reference`, 'Label names contain only letters, digits and underscores: {{ $labels.instance }}.')
      }
      return { t: kind, name }
    }
  }
  if (tok.startsWith('"')) {
    try {
      return { t: 'str', v: JSON.parse(tok) as string }
    } catch {
      fail(at, `invalid string literal ${tok}`, 'Use a double-quoted string with JSON-style escapes.')
    }
  }
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(tok)) return { t: 'num', v: Number(tok) }
  if (tok === '$labels' || tok === '.Labels' || tok === '$externalLabels' || tok === '.ExternalLabels' || tok === '.') {
    fail(at, `"${tok}" cannot be printed whole`, 'Name one label: {{ $labels.instance }}.')
  }
  if (tok === '$externalURL' || tok === '.ExternalURL') {
    fail(at, '$externalURL is not available in viz rule templates', 'Write the URL as text, or put it in an external label and use {{ $externalLabels.name }}.')
  }
  if (tok.startsWith('$') || tok.startsWith('.')) {
    fail(at, `unknown template variable "${tok}"`, SUPPORTED)
  }
  return null
}

function parseAction(body: string, base: number): Command[] {
  const toks = tokenize(body, base)
  if (toks.length === 0) fail(base, 'empty template action', 'Remove the empty {{ }} or put a value in it, e.g. {{ $value }}.')
  const first = toks[0] as { tok: string; at: number }
  if (CONTROL.has(first.tok)) {
    fail(first.at, `template control structure "${first.tok}" is not supported`, `Write separate rules with constant labels instead of branching in a template. ${SUPPORTED}`)
  }
  if (first.tok.startsWith('/*')) fail(first.at, 'template comments are not supported', 'Remove the comment.')
  if (toks.some((t) => t.tok === ':=' || t.tok === '=')) {
    fail(first.at, 'template variable assignment is not supported', SUPPORTED)
  }
  const pipe: Command[] = []
  let cur: { tok: string; at: number }[] = []
  const flush = (at: number) => {
    if (cur.length === 0) fail(at, 'empty command in template pipeline', 'Put a value or a function on each side of "|".')
    const head = cur[0] as { tok: string; at: number }
    const asOperand = parseOperand(head.tok, head.at)
    if (asOperand) {
      if (cur.length > 1) fail((cur[1] as { at: number }).at, `unexpected "${(cur[1] as { tok: string }).tok}" after a value`, 'A value takes no arguments; use "|" to pass it to a function.')
      if (pipe.length > 0) fail(head.at, 'only a function can follow "|"', `Example: {{ $value | humanize }}. ${SUPPORTED}`)
      pipe.push({ fn: null, args: [asOperand] })
    } else {
      const spec = Object.hasOwn(FUNCTIONS, head.tok) ? FUNCTIONS[head.tok] : undefined
      if (!spec) {
        const hint = head.tok === 'query' || head.tok === 'first' || head.tok === 'value' || head.tok === 'label'
          ? 'Queries inside templates are not supported; put the value you need in the rule expression. '
          : ''
        fail(head.at, `template function "${head.tok}" is not supported`, hint + SUPPORTED)
      }
      const args = cur.slice(1).map((t) => {
        const op = parseOperand(t.tok, t.at)
        if (!op) fail(t.at, `"${t.tok}" is not a value`, `Function arguments are $value, $labels.x, $externalLabels.x, strings or numbers. ${SUPPORTED}`)
        return op
      })
      const n = args.length + (pipe.length > 0 ? 1 : 0)
      if (n < spec.min || n > spec.max) {
        fail(head.at, `function "${head.tok}" takes ${spec.min === spec.max ? spec.min : `${spec.min} to ${spec.max}`} argument(s), got ${n}`, `Example: {{ ${head.tok === 'printf' ? 'printf "%.2f" $value' : `${head.tok} $value`} }}.`)
      }
      if (head.tok === 'printf') {
        const fmt = args[0]
        if (pipe.length === 0 || args.length > 0) {
          if (!fmt || fmt.t !== 'str') fail(head.at, 'the first argument of printf must be a string literal', 'Example: {{ printf "%.2f" $value }}.')
          checkFormat(fmt.v, n - 1, head.at)
        }
      }
      pipe.push({ fn: head.tok, args })
    }
    cur = []
  }
  for (const t of toks) {
    if (t.tok === '|') flush(t.at)
    else cur.push(t)
  }
  flush((toks[toks.length - 1] as { at: number }).at)
  return pipe
}

const VERB_RE = /%([-+ 0#]*)(\d+)?(?:\.(\d+))?([a-zA-Z%])/g
const VERBS = new Set(['v', 's', 'd', 'f', 'F', 'e', 'g', 'q', '%'])

function checkFormat(fmt: string, nargs: number, at: number): void {
  let used = 0
  for (const m of fmt.matchAll(VERB_RE)) {
    const verb = m[4] as string
    if (!VERBS.has(verb)) fail(at, `printf verb "%${verb}" is not supported`, 'Use one of %v %s %d %f %e %g %q.')
    if (verb !== '%') used++
  }
  if (used !== nargs) fail(at, `printf format has ${used} verb(s) but ${nargs} argument(s)`, 'Give one argument per verb.')
}

/** Parse and validate a template. Returns the tree, or the first error. */
export function parseTemplate(source: string): { ok: true; template: Template } | { ok: false; error: TemplateError } {
  const nodes: Node[] = []
  let i = 0
  let trimNext = false
  try {
    while (i < source.length) {
      const open = source.indexOf('{{', i)
      let text = open < 0 ? source.slice(i) : source.slice(i, open)
      if (trimNext) text = text.replace(/^\s+/, '')
      if (open < 0) {
        if (text) nodes.push({ t: 'text', v: text })
        break
      }
      const close = findClose(source, open + 2)
      if (close < 0) fail(open, 'unclosed template action', 'Add the closing "}}".')
      let body = source.slice(open + 2, close)
      let base = open + 2
      if (body.startsWith('- ') || body === '-') {
        text = text.replace(/\s+$/, '')
        body = body.slice(1)
        base++
      }
      trimNext = false
      if (body.endsWith(' -')) {
        body = body.slice(0, -1)
        trimNext = true
      }
      if (text) nodes.push({ t: 'text', v: text })
      nodes.push({ t: 'action', pipe: parseAction(body, base) })
      i = close + 2
    }
  } catch (e) {
    if (e instanceof ParseFailure) return { ok: false, error: e.err }
    throw e
  }
  return { ok: true, template: { nodes, constant: nodes.every((n) => n.t === 'text'), source } }
}

/** Index of the `}}` closing an action that starts at `from`, skipping string literals. */
function findClose(s: string, from: number): number {
  let i = from
  while (i < s.length - 1) {
    const c = s[i]
    if (c === '"') {
      i++
      while (i < s.length && s[i] !== '"') i += s[i] === '\\' ? 2 : 1
      i++
    } else if (c === '`') {
      const j = s.indexOf('`', i + 1)
      if (j < 0) return -1
      i = j + 1
    } else if (c === '}' && s[i + 1] === '}') {
      return i
    } else i++
  }
  return -1
}

// ---- Go-compatible number formatting -------------------------------------------------

function expPart(exp: number): string {
  return (exp < 0 ? 'e-' : 'e+') + String(Math.abs(exp)).padStart(2, '0')
}

function special(v: number): string | null {
  if (Number.isNaN(v)) return 'NaN'
  if (v === Infinity) return '+Inf'
  if (v === -Infinity) return '-Inf'
  return null
}

/**
 * Go's `%v` for a float64, which is what `{{ $value }}` prints: shortest round-trip digits,
 * exponent form when the decimal exponent is below -4 or at least 6 (so one million prints
 * as `1e+06`, unlike JavaScript).
 */
export function goFloat(v: number): string {
  const sp = special(v)
  if (sp) return sp
  if (v === 0) return '0'
  const [mant, e] = v.toExponential().split('e') as [string, string]
  const exp = Number(e)
  if (exp < -4 || exp >= 6) return mant + expPart(exp)
  return String(v)
}

/** Go's `%.<prec>g`. */
export function fmtG(v: number, prec: number): string {
  const sp = special(v)
  if (sp) return sp
  if (v === 0) return '0'
  const p = Math.max(1, prec)
  const [mant, e] = v.toExponential(p - 1).split('e') as [string, string]
  const exp = Number(e)
  const strip = (s: string) => (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s)
  if (exp < -4 || exp >= p) return strip(mant) + expPart(exp)
  return strip(v.toFixed(Math.max(0, p - 1 - exp)))
}

function fmtE(v: number, prec: number): string {
  const sp = special(v)
  if (sp) return sp
  const [mant, e] = v.toExponential(prec).split('e') as [string, string]
  return mant + expPart(Number(e))
}

type Value = string | number

function toFloat(v: Value): number {
  if (typeof v === 'number') return v
  const n = v.trim() === '' ? NaN : Number(v)
  if (Number.isNaN(n) && v.trim() !== 'NaN') throw new Error(`can't convert "${v}" to float`)
  return n
}

function show(v: Value): string {
  return typeof v === 'number' ? goFloat(v) : v
}

function scale(v: number, prefixes: string[], step: number, down: boolean): [number, string] {
  let prefix = ''
  for (const p of prefixes) {
    if (down ? Math.abs(v) >= 1 : Math.abs(v) < step) break
    prefix = p
    v = down ? v * step : v / step
  }
  return [v, prefix]
}

const SI_UP = ['k', 'M', 'G', 'T', 'P', 'E', 'Z', 'Y']
const SI_DOWN = ['m', 'u', 'n', 'p', 'f', 'a', 'z', 'y']

/** The `humanize` family, transcribed from prometheus/template/template.go. */
export const humanize = {
  humanize(v: number): string {
    if (v === 0 || !Number.isFinite(v)) return fmtG(v, 4)
    const [x, p] = Math.abs(v) >= 1 ? scale(v, SI_UP, 1000, false) : scale(v, SI_DOWN, 1000, true)
    return fmtG(x, 4) + p
  },
  humanize1024(v: number): string {
    if (Math.abs(v) <= 1 || !Number.isFinite(v)) return fmtG(v, 4)
    const [x, p] = scale(v, ['ki', 'Mi', 'Gi', 'Ti', 'Pi', 'Ei', 'Zi', 'Yi'], 1024, false)
    return fmtG(x, 4) + p
  },
  humanizeDuration(v: number): string {
    if (!Number.isFinite(v)) return fmtG(v, 4)
    if (v === 0) return '0s'
    if (Math.abs(v) >= 1) {
      const sign = v < 0 ? '-' : ''
      const a = Math.abs(v)
      const d = Math.trunc(a)
      const seconds = d % 60
      const minutes = Math.floor(d / 60) % 60
      const hours = Math.floor(d / 3600) % 24
      const days = Math.floor(d / 86400)
      if (days !== 0) return `${sign}${days}d ${hours}h ${minutes}m ${seconds}s`
      if (hours !== 0) return `${sign}${hours}h ${minutes}m ${seconds}s`
      if (minutes !== 0) return `${sign}${minutes}m ${seconds}s`
      return `${sign}${fmtG(a, 4)}s`
    }
    const [x, p] = scale(v, SI_DOWN, 1000, true)
    return `${fmtG(x, 4)}${p}s`
  },
  humanizePercentage(v: number): string {
    return fmtG(v * 100, 4) + '%'
  },
  humanizeTimestamp(v: number): string {
    if (!Number.isFinite(v)) return fmtG(v, 4)
    const ms = Math.floor(v * 1000)
    if (Math.abs(ms) > 8.64e15) throw new Error(`${goFloat(v)} cannot be represented as a timestamp`)
    const iso = new Date(ms).toISOString() // 2015-01-01T00:00:00.000Z
    const frac = iso.slice(20, 23).replace(/0+$/, '')
    return `${iso.slice(0, 10)} ${iso.slice(11, 19)}${frac ? '.' + frac : ''} +0000 UTC`
  },
}

function sprintf(fmt: string, args: Value[]): string {
  let i = 0
  return fmt.replace(VERB_RE, (_m, flags: string, width: string | undefined, prec: string | undefined, verb: string) => {
    if (verb === '%') return '%'
    const a = args[i++] as Value
    const p = prec === undefined ? undefined : Number(prec)
    let s: string
    switch (verb) {
      case 's':
      case 'v':
        s = show(a)
        if (verb === 's' && p !== undefined) s = s.slice(0, p)
        break
      case 'q':
        s = JSON.stringify(show(a))
        break
      case 'd': {
        const n = typeof a === 'number' ? a : Number(a)
        s = Number.isInteger(n) ? String(n) : `%!d(${typeof a === 'number' ? 'float64' : 'string'}=${show(a)})`
        break
      }
      case 'f':
      case 'F': {
        const n = toFloat(a)
        s = special(n) ?? n.toFixed(Math.min(p ?? 6, 100))
        break
      }
      case 'e':
        s = fmtE(toFloat(a), Math.min(p ?? 6, 100))
        break
      default: {
        const n = toFloat(a)
        s = p === undefined ? goFloat(n) : fmtG(n, p)
      }
    }
    if (flags.includes('+') && typeof a === 'number' && a >= 0 && 'dfFeg'.includes(verb)) s = '+' + s
    const w = width === undefined ? 0 : Math.min(Number(width), 256)
    if (s.length < w) s = flags.includes('-') ? s.padEnd(w) : flags.includes('0') && verb !== 's' ? s.padStart(w, '0') : s.padStart(w)
    return s
  })
}

function call(fn: string, args: Value[]): Value {
  switch (fn) {
    case 'humanize':
    case 'humanize1024':
    case 'humanizeDuration':
    case 'humanizePercentage':
    case 'humanizeTimestamp':
      return humanize[fn](toFloat(args[0] as Value))
    case 'toUpper':
      return show(args[0] as Value).toUpperCase()
    case 'toLower':
      return show(args[0] as Value).toLowerCase()
    case 'title':
      return show(args[0] as Value).replace(/(^|[\s_-])(\p{Ll})/gu, (_m, a: string, b: string) => a + b.toUpperCase())
    default:
      return sprintf(show(args[0] as Value), args.slice(1))
  }
}

function operand(op: Operand, d: TemplateData): Value {
  switch (op.t) {
    case 'label':
      return labelValue(d.labels, op.name)
    case 'ext':
      return labelValue(d.externalLabels, op.name)
    case 'value':
      return d.value
    default:
      return op.v
  }
}

/**
 * Expand a parsed template. A runtime failure (for example `humanize` of a label that is
 * not a number) yields Prometheus' `<error expanding template: ...>` text instead of
 * throwing, so one bad annotation never fails the rule.
 */
export function expandTemplate(t: Template, d: TemplateData): string {
  if (t.constant) return t.source
  let out = ''
  try {
    for (const n of t.nodes) {
      if (n.t === 'text') {
        out += n.v
        continue
      }
      let acc: Value | undefined
      for (const cmd of n.pipe) {
        const args = cmd.args.map((a) => operand(a, d))
        if (acc !== undefined) args.push(acc)
        acc = cmd.fn === null ? (args[0] as Value) : call(cmd.fn, args)
      }
      out += show(acc as Value)
    }
  } catch (e) {
    return `<error expanding template: ${e instanceof Error ? e.message : String(e)}>`
  }
  return out
}
