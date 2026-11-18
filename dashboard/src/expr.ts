/**
 * Variable references in query expressions: scanning and safe substitution.
 *
 * Syntax: `$name` or `${name}` (name = [A-Za-z_][A-Za-z0-9_]*); `$$` is a
 * literal `$`. Anything else after `$` (e.g. `$1` in label_replace, a regex
 * end anchor) is left alone.
 *
 * ESCAPING RULE. A value is never pasted in verbatim; what is written depends
 * on where the reference sits in the expression:
 *
 *  - `regex`: inside a quoted string that follows `=~`, `!~` or `|~`.
 *    Each value is regex-escaped (RE2 metacharacters `\.+*?()|[]{}^$` get a
 *    backslash), then string-escaped for the enclosing quote. Several values
 *    become an alternation `a|b|c`, wrapped as `(?:a|b|c)` unless the
 *    reference is the whole string. "All" (`*`) becomes `.*`.
 *  - `string`: inside any other quoted string (`=`, `!=`, function
 *    arguments). The single value is string-escaped: `\` → `\\`, the quote
 *    character → `\"` / `\'`, control characters → `\n`, `\t`, `\u00XX`.
 *    Several values or "all" cannot be expressed here: substitution fails.
 *  - `bare`: outside any string (range windows, numbers, metric names). The
 *    value must be a number, a duration, or an identifier; anything else
 *    fails. This is what stops `$x = "5m]) or vector(1) #"` style injection.
 *
 * Inside backtick (raw) strings no escape exists, so a value containing a
 * backtick is written as `\x60` in a regex and fails in a plain string.
 *
 * A failed substitution never throws: the reference is left in place (so
 * the query cannot parse and cannot run with attacker-shaped text) and an
 * error is returned for that query.
 */

export type RefContext = 'bare' | 'string' | 'regex'

export interface VarRef {
  name: string
  /** Offsets of the whole reference (`$x` or `${x}`) in the expression. */
  start: number
  end: number
  context: RefContext
  quote?: '"' | "'" | '`'
  /** The reference is the entire content of its string literal. */
  whole: boolean
  /** Grafana-style `${name:format}`; not supported, reported by validate. */
  format?: string
}

export interface Binding {
  values: string[]
  /** "All values": matches anything in a regex context. */
  all?: boolean
}

type Segment = { text: string } | { ref: VarRef } | { dollar: true }

const NAME_START = /[A-Za-z_]/
const NAME_CHAR = /[A-Za-z0-9_]/

function scan(expr: string, lang: string): Segment[] {
  const segs: Segment[] = []
  let text = ''
  const flush = () => {
    if (text) segs.push({ text })
    text = ''
  }
  let quote: '"' | "'" | '`' | undefined
  let context: RefContext = 'bare'
  let stringStart = -1
  const pending: VarRef[] = [] // refs inside the current string, to fill `whole` at its end
  const n = expr.length
  let i = 0
  while (i < n) {
    const c = expr[i]!
    if (quote) {
      if (c === '\\' && quote !== '`' && i + 1 < n) {
        text += c + expr[i + 1]!
        i += 2
        continue
      }
      if (c === quote) {
        for (const r of pending) r.whole = r.start === stringStart + 1 && r.end === i
        pending.length = 0
        quote = undefined
        context = 'bare'
        text += c
        i++
        continue
      }
    } else {
      if (c === '"' || c === "'" || c === '`') {
        const before = expr.slice(0, i).trimEnd()
        context = /(=~|!~|\|~)$/.test(before) ? 'regex' : 'string'
        quote = c
        stringStart = i
        text += c
        i++
        continue
      }
      if (c === '#' && lang === 'promql') {
        const nl = expr.indexOf('\n', i)
        const end = nl === -1 ? n : nl
        text += expr.slice(i, end)
        i = end
        continue
      }
    }
    if (c === '$') {
      const next = expr[i + 1]
      if (next === '$') {
        flush()
        segs.push({ dollar: true })
        i += 2
        continue
      }
      let name = ''
      let end = -1
      let format: string | undefined
      if (next === '{') {
        const m = /^\$\{([A-Za-z_][A-Za-z0-9_]*)(?::([A-Za-z0-9_]*))?\}/.exec(expr.slice(i, i + 200))
        if (m) {
          name = m[1]!
          format = m[2]
          end = i + m[0].length
        }
      } else if (next !== undefined && NAME_START.test(next)) {
        let j = i + 1
        while (j < n && NAME_CHAR.test(expr[j]!)) j++
        name = expr.slice(i + 1, j)
        end = j
      }
      if (name) {
        flush()
        const ref: VarRef = { name, start: i, end, context, whole: false }
        if (quote) {
          ref.quote = quote
          pending.push(ref)
        }
        if (format !== undefined) ref.format = format
        segs.push({ ref })
        i = end
        continue
      }
    }
    text += c
    i++
  }
  flush()
  return segs
}

/** All variable references in an expression, with the context each sits in. */
export function findVariables(expr: string, lang = 'promql'): VarRef[] {
  const out: VarRef[] = []
  for (const s of scan(expr, lang)) if ('ref' in s) out.push(s.ref)
  return out
}

const REGEX_META = /[\\.+*?()|[\]{}^$]/g

export function escapeRegex(v: string): string {
  return v.replace(REGEX_META, '\\$&')
}

/** Escape for a PromQL/LogQL/TraceQL string literal delimited by `quote` (`"` or `'`). */
export function escapeString(v: string, quote: '"' | "'"): string {
  let out = ''
  for (const ch of v) {
    const code = ch.codePointAt(0)!
    if (ch === '\\') out += '\\\\'
    else if (ch === quote) out += '\\' + quote
    else if (ch === '\n') out += '\\n'
    else if (ch === '\r') out += '\\r'
    else if (ch === '\t') out += '\\t'
    else if (code < 0x20 || code === 0x7f) out += '\\u' + code.toString(16).padStart(4, '0')
    else out += ch
  }
  return out
}

const SAFE_BARE = /^(?:[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|(?:[0-9]+(?:ms|s|m|h|d|w|y))+|[A-Za-z_:][A-Za-z0-9_:]*)$/

/** Is `v` safe to write outside a string: a number, a duration, or an identifier. */
export function isSafeBare(v: string): boolean {
  return SAFE_BARE.test(v)
}

export interface SubstituteResult {
  expr: string
  /** One message per reference that could not be substituted safely. Empty means success. */
  errors: string[]
}

function render(ref: VarRef, b: Binding): string | { error: string } {
  const n = b.values.length
  if (ref.context === 'bare') {
    if (b.all || n !== 1) return { error: `$${ref.name} is used outside a string and needs exactly one value, got ${b.all ? '"all"' : n}` }
    const v = b.values[0]!
    if (!isSafeBare(v)) return { error: `$${ref.name} is used outside a string; its value ${JSON.stringify(v)} is not a number, duration or identifier` }
    return v
  }
  const raw = ref.quote === '`'
  if (ref.context === 'regex') {
    if (b.all || n === 0) return '.*'
    const parts = b.values.map((v) => {
      const r = escapeRegex(v)
      return raw ? r.replace(/`/g, '\\x60') : escapeString(r, ref.quote as '"' | "'")
    })
    if (n === 1) return parts[0]!
    const alt = parts.join('|')
    return ref.whole ? alt : `(?:${alt})`
  }
  // plain string
  if (b.all || n !== 1) {
    return { error: `$${ref.name} has ${b.all ? '"all"' : `${n} values`} but is used in an equality matcher or plain string; use a regex matcher (=~)` }
  }
  const v = b.values[0]!
  if (raw) {
    if (v.includes('`')) return { error: `$${ref.name} contains a backtick and is used inside a raw (backtick) string` }
    return v
  }
  return escapeString(v, ref.quote as '"' | "'")
}

/**
 * Substitute variables in `expr`. `lookup` returns the binding for a name, or
 * `undefined` if the name is unknown (the reference is then left in place
 * and reported).
 */
export function substitute(expr: string, lookup: (name: string) => Binding | undefined, lang = 'promql'): SubstituteResult {
  const errors: string[] = []
  let out = ''
  for (const s of scan(expr, lang)) {
    if ('text' in s) out += s.text
    else if ('dollar' in s) out += '$'
    else {
      const original = expr.slice(s.ref.start, s.ref.end)
      const b = lookup(s.ref.name)
      if (!b) {
        errors.push(`$${s.ref.name} is not defined`)
        out += original
        continue
      }
      const r = render(s.ref, b)
      if (typeof r === 'string') out += r
      else {
        errors.push(r.error)
        out += original
      }
    }
  }
  return { expr: out, errors }
}

export const BUILTIN_VARIABLES = {
  __rate: 'Range window for rate()/increase(): at least 4× the scrape interval and at least the step. Use as [$__rate].',
  __interval: 'Query step for the current time range and panel width.',
  __range: 'Length of the dashboard time range, e.g. for increase(x[$__range]).',
} as const
export type BuiltinVariable = keyof typeof BUILTIN_VARIABLES
