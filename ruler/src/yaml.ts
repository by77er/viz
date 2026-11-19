/**
 * A parser and emitter for the subset of YAML that Prometheus rule files use.
 *
 * Chosen over a dependency: the full `yaml` package is several hundred kilobytes of a
 * Worker's bundle for features a rule file must not use anyway, and a subset parser can say
 * exactly what it refuses and where.
 *
 * Accepted: one document (an optional leading `---`); block mappings and block sequences;
 * plain, single-quoted and double-quoted scalars, including ones folded over several
 * lines; literal (`|`) and folded (`>`) block scalars with `-` / `+` chomping and an
 * explicit indentation digit; comments; flow sequences and flow mappings that fit on one
 * line.
 *
 * Refused, each with the line and what to write instead: anchors (`&a`), aliases (`*a`),
 * merge keys (`<<`), tags (`!!str`), directives (`%YAML`), more than one document, complex
 * keys (`? `), tabs in indentation, duplicate keys, multi-line flow collections.
 *
 * The parser does not decide what a plain scalar means: `1`, `true` and `~` come back as
 * plain scalars with their text. The caller applies a schema (`core` below, or the
 * rule-file schema in `rulefile.ts`), as a typed YAML decoder does.
 */

export type YamlNode =
  | { k: 'scalar'; v: string; plain: boolean; line: number }
  | { k: 'map'; entries: [string, YamlNode][]; line: number }
  | { k: 'seq'; items: YamlNode[]; line: number }

export class YamlError extends Error {
  constructor(
    message: string,
    readonly line: number,
    readonly fix: string,
  ) {
    super(`line ${line}: ${message}`)
  }
}

interface Line {
  n: number
  indent: number
  /** Text after the indentation, untouched (comments still in). */
  text: string
}

const isBlank = (l: Line) => l.text === '' || l.text.startsWith('#')

/** Cut a trailing comment from text that is outside any quoted scalar. */
function stripComment(s: string): string {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '#' && (i === 0 || s[i - 1] === ' ' || s[i - 1] === '\t')) return s.slice(0, i).trimEnd()
  }
  return s.trimEnd()
}

const ESCAPES: Record<string, string> = {
  '0': '\0', a: '\x07', b: '\b', t: '\t', '\t': '\t', n: '\n', v: '\v', f: '\f', r: '\r', e: '\x1b', ' ': ' ', '"': '"', '/': '/', '\\': '\\',
  N: '\u0085', _: '\u00a0', L: '\u2028', P: '\u2029',
}

/** The text of a quoted scalar, quotes included, decoded. */
function unquote(raw: string, n: number): string {
  const body = raw.slice(1, -1)
  if (raw[0] === "'") return body.replace(/''/g, "'")
  let out = ''
  for (let i = 0; i < body.length; i++) {
    const c = body[i] as string
    if (c !== '\\') {
      out += c
      continue
    }
    const e = body[++i]
    if (e === undefined) throw new YamlError('a backslash at the end of a quoted value', n, 'Remove it or escape it as "\\\\".')
    const hex = e === 'x' ? 2 : e === 'u' ? 4 : e === 'U' ? 8 : 0
    if (hex > 0) {
      const digits = body.slice(i + 1, i + 1 + hex)
      if (!new RegExp(`^[0-9a-fA-F]{${hex}}$`).test(digits) || parseInt(digits, 16) > 0x10ffff) throw new YamlError(`bad \\${e} escape`, n, `Follow \\${e} with ${hex} hex digits.`)
      out += String.fromCodePoint(parseInt(digits, 16))
      i += hex
    } else if (e in ESCAPES) {
      out += ESCAPES[e]
    } else {
      throw new YamlError(`unknown escape "\\${e}"`, n, 'In double quotes a backslash must be written "\\\\"; or use single quotes.')
    }
  }
  return out
}

class Parser {
  private lines: Line[] = []
  private pos = 0

  constructor(text: string) {
    const raw = text.replace(/^\uFEFF/, '').split(/\r?\n/)
    if (raw[raw.length - 1] === '') raw.pop() // the newline that ends the file is not a line
    let seenContent = false
    raw.forEach((full, i) => {
      const n = i + 1
      let indent = 0
      while (indent < full.length && full[indent] === ' ') indent++
      if (full[indent] === '\t' && full.trim() !== '') throw new YamlError('a tab is used for indentation', n, 'Indent with spaces.')
      const text = full.slice(indent)
      if (indent === 0 && /^---(\s|$)/.test(text)) {
        if (seenContent || this.lines.some((l) => !isBlank(l))) throw new YamlError('a second YAML document starts here', n, 'Put one rule file in one document; remove the "---".')
        const rest = stripComment(text.slice(3).trim())
        if (rest !== '') throw new YamlError('content on the "---" line is not supported', n, 'Start the document on the next line.')
        seenContent = true
        return
      }
      if (indent === 0 && /^\.\.\.(\s|$)/.test(text)) {
        this.lines.push({ n, indent: 0, text: '\u0000end' })
        return
      }
      if (indent === 0 && text.startsWith('%')) throw new YamlError('YAML directives are not supported', n, 'Remove the directive line.')
      this.lines.push({ n, indent, text })
    })
    const end = this.lines.findIndex((l) => l.text === '\u0000end')
    if (end >= 0) {
      const after = this.lines.slice(end + 1).find((l) => !isBlank(l))
      if (after) throw new YamlError('content after the end of the document', after.n, 'Put one rule file in one document.')
      this.lines.length = end
    }
  }

  parse(): YamlNode {
    this.skipBlank()
    if (this.pos >= this.lines.length) return { k: 'scalar', v: '', plain: true, line: 1 }
    const node = this.node(0)
    this.skipBlank()
    const extra = this.lines[this.pos]
    if (extra) throw new YamlError('unexpected content: its indentation does not match anything above', extra.n, 'Align it with the block it belongs to.')
    return node
  }

  private skipBlank(): void {
    while (this.pos < this.lines.length && isBlank(this.lines[this.pos] as Line)) this.pos++
  }

  private peek(): Line | undefined {
    this.skipBlank()
    return this.lines[this.pos]
  }

  /** A node whose first line is at exactly the indentation of the next content line, which must be >= `min`. */
  private node(min: number): YamlNode {
    const l = this.peek() as Line
    if (l.indent < min) return { k: 'scalar', v: '', plain: true, line: l.n }
    if (l.text === '-' || l.text.startsWith('- ')) return this.seq(l.indent)
    this.refuseIndicators(l.text, l.n)
    if (this.keyEnd(l.text, l.n) >= 0) return this.map(l.indent)
    this.pos++
    return this.inline(l.text, l.indent - 1, l.n)
  }

  private refuseIndicators(text: string, n: number): void {
    const c = text[0]
    if (c === '&') throw new YamlError('anchors (&name) are not supported', n, 'Write the value out where it is used.')
    if (c === '*') throw new YamlError('aliases (*name) are not supported', n, 'Write the value out instead of referring to an anchor.')
    if (c === '!') throw new YamlError('tags (!tag) are not supported', n, 'Remove the tag; quote the value if it must be a string.')
    if (text === '?' || text.startsWith('? ')) throw new YamlError('complex keys (? key) are not supported', n, 'Use a plain "key: value" pair.')
    if (c === '@' || c === '`') throw new YamlError(`a value cannot start with "${c}"`, n, 'Quote the value.')
  }

  /**
   * If `text` starts a mapping entry, the index of the ':' that ends its key; else -1.
   * Keys are plain (no ": " inside) or quoted.
   */
  private keyEnd(text: string, n: number): number {
    const c = text[0]
    if (c === '"' || c === "'") {
      const close = this.quotedEnd(text, 0)
      if (close < 0) return -1
      const rest = text.slice(close + 1)
      return /^\s*:(\s|$)/.test(rest) ? close + 1 + rest.indexOf(':') : -1
    }
    if (c === '[' || c === '{') return -1
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]
      if (ch === '#' && i > 0 && text[i - 1] === ' ') return -1
      if (ch === ':' && (i + 1 === text.length || text[i + 1] === ' ' || text[i + 1] === '\t')) {
        if (i === 0) throw new YamlError('a mapping entry has no key', n, 'Put the key before the colon.')
        return i
      }
    }
    return -1
  }

  /** Index of the closing quote of the quoted scalar starting at `from`, or -1 if it does not close on this line. */
  private quotedEnd(text: string, from: number): number {
    const q = text[from]
    for (let i = from + 1; i < text.length; i++) {
      if (q === '"' && text[i] === '\\') {
        i++
        continue
      }
      if (text[i] === q) {
        if (q === "'" && text[i + 1] === "'") {
          i++
          continue
        }
        return i
      }
    }
    return -1
  }

  private key(text: string, end: number, n: number): string {
    const raw = text.slice(0, end).trimEnd()
    if (raw[0] === '"' || raw[0] === "'") return unquote(raw, n)
    if (raw === '<<') throw new YamlError('merge keys (<<) are not supported', n, 'Write the merged fields out.')
    return raw
  }

  private map(indent: number): YamlNode {
    const first = this.peek() as Line
    const entries: [string, YamlNode][] = []
    const seen = new Set<string>()
    for (;;) {
      const l = this.peek()
      if (!l || l.indent < indent) break
      if (l.indent > indent) throw new YamlError('this line is indented more than the mapping it follows', l.n, 'Align it with the other keys, or indent it under a key that has no value.')
      this.refuseIndicators(l.text, l.n)
      if (l.text === '-' || l.text.startsWith('- ')) throw new YamlError('a list item where a "key: value" pair was expected', l.n, 'Indent the list under its key.')
      const end = this.keyEnd(l.text, l.n)
      if (end < 0) throw new YamlError('expected "key: value"', l.n, 'Add the colon, or indent the line if it continues the value above.')
      const key = this.key(l.text, end, l.n)
      if (seen.has(key)) throw new YamlError(`the key "${key}" appears twice in one mapping`, l.n, 'Remove or rename one of them.')
      seen.add(key)
      this.pos++
      const rest = l.text.slice(end + 1).trim()
      entries.push([key, this.value(rest, indent, l.n, true)])
    }
    return { k: 'map', entries, line: first.n }
  }

  private seq(indent: number): YamlNode {
    const first = this.peek() as Line
    const items: YamlNode[] = []
    for (;;) {
      const l = this.peek()
      if (!l || l.indent < indent) break
      if (l.indent > indent) throw new YamlError('this line is indented more than the list it follows', l.n, 'Align it with the list items.')
      if (!(l.text === '-' || l.text.startsWith('- '))) break
      const after = l.text.slice(1)
      const rest = after.trimStart()
      if (rest === '' || rest.startsWith('#')) {
        this.pos++
        items.push(this.nested(indent, l.n, false))
        continue
      }
      // "- key: value" and "- - x": the item is a block node whose first line starts here.
      const col = indent + 1 + (after.length - rest.length)
      this.refuseIndicators(rest, l.n)
      if (rest === '-' || rest.startsWith('- ') || this.keyEnd(rest, l.n) >= 0) {
        this.lines[this.pos] = { n: l.n, indent: col, text: rest }
        items.push(this.node(col))
      } else {
        this.pos++
        items.push(this.inline(rest, indent, l.n))
      }
    }
    return { k: 'seq', items, line: first.n }
  }

  /** The value of a key or list item whose line had nothing after it. */
  private nested(parentIndent: number, n: number, listMayAlign: boolean): YamlNode {
    const next = this.peek()
    if (next && next.indent > parentIndent) return this.node(parentIndent + 1)
    // A block sequence may sit at the same indentation as the key it belongs to.
    if (listMayAlign && next && next.indent === parentIndent && (next.text === '-' || next.text.startsWith('- '))) return this.seq(parentIndent)
    return { k: 'scalar', v: '', plain: true, line: n }
  }

  private value(rest: string, parentIndent: number, n: number, listMayAlign: boolean): YamlNode {
    if (rest === '' || rest.startsWith('#')) return this.nested(parentIndent, n, listMayAlign)
    return this.inline(rest, parentIndent, n)
  }

  /** A value that starts on the current line: block scalar, flow collection, quoted or plain scalar. */
  private inline(rest: string, parentIndent: number, n: number): YamlNode {
    this.refuseIndicators(rest, n)
    const c = rest[0]
    if (c === '|' || c === '>') return { k: 'scalar', v: this.blockScalar(rest, parentIndent, n), plain: false, line: n }
    if (c === '[' || c === '{') {
      const text = stripComment(rest)
      const flow = new Flow(text, n)
      const node = flow.node()
      flow.end()
      return node
    }
    if (c === '"' || c === "'") return { k: 'scalar', v: this.quoted(rest, parentIndent, n), plain: false, line: n }
    if (c === '%' || c === ',' || c === ']' || c === '}') throw new YamlError(`a value cannot start with "${c}"`, n, 'Quote the value.')
    // Plain scalar, possibly continued on more-indented lines (folded with spaces).
    const parts = [stripComment(rest)]
    let blank = 0
    for (;;) {
      const l = this.lines[this.pos]
      if (!l) break
      if (l.text === '') {
        blank++
        this.pos++
        continue
      }
      if (l.indent <= parentIndent || l.text.startsWith('#')) break
      if (this.keyEnd(l.text, l.n) >= 0) throw new YamlError('a "key: value" pair inside a multi-line plain value', l.n, 'Quote the value above, or fix the indentation of this line.')
      const piece = stripComment(l.text)
      parts.push(blank > 0 ? '\n'.repeat(blank) + piece : ' ' + piece)
      blank = 0
      this.pos++
    }
    return { k: 'scalar', v: parts.join(''), plain: true, line: n }
  }

  private quoted(rest: string, parentIndent: number, n: number): string {
    let text = rest
    let close = this.quotedEnd(text, 0)
    let blank = 0
    while (close < 0) {
      const l = this.lines[this.pos]
      if (!l) throw new YamlError('a quoted value is never closed', n, 'Add the closing quote.')
      this.pos++
      if (l.text === '') {
        blank++
        continue
      }
      if (l.indent <= parentIndent) throw new YamlError('a quoted value is never closed', n, 'Add the closing quote, or indent its continuation lines.')
      // Folding: a line break is a space, an empty line is a newline. An escaped break joins.
      const trimmed = text.trimEnd()
      if (text[0] === '"' && /(^|[^\\])(\\\\)*\\$/.test(trimmed)) text = trimmed.slice(0, -1) + l.text
      else text = trimmed + (blank > 0 ? '\n'.repeat(blank) : ' ') + l.text
      blank = 0
      close = this.quotedEnd(text, 0)
    }
    const tail = stripComment(text.slice(close + 1))
    if (tail !== '') throw new YamlError('unexpected text after a quoted value', n, 'Remove it, or put the whole value inside the quotes.')
    return unquote(text.slice(0, close + 1), n)
  }

  private blockScalar(header: string, parentIndent: number, n: number): string {
    const m = /^([|>])([+-]?)([1-9]?)([+-]?)\s*(#.*)?$/.exec(header)
    if (!m) throw new YamlError('bad block scalar header', n, 'Write "|", "|-", "|+", ">" or ">-", then the text on the following lines.')
    const folded = m[1] === '>'
    const chomp = m[2] || m[4] || ''
    let indent = m[3] ? Math.max(parentIndent, 0) + Number(m[3]) : -1
    const rows: { text: string; more: boolean }[] = []
    for (;;) {
      const l = this.lines[this.pos]
      if (!l) break
      if (l.text === '') {
        rows.push({ text: '', more: false })
        this.pos++
        continue
      }
      if (indent < 0) {
        if (l.indent <= parentIndent) break
        indent = l.indent
      }
      if (l.indent < indent) break
      rows.push({ text: ' '.repeat(l.indent - indent) + l.text, more: l.indent > indent })
      this.pos++
    }
    // Trailing empty rows belong to chomping, not to the content.
    let trailing = 0
    while (rows.length > 0 && (rows[rows.length - 1] as { text: string }).text === '') {
      rows.pop()
      trailing++
    }
    let body = ''
    if (!folded) body = rows.map((r) => r.text).join('\n')
    else {
      // Folding: a break between two ordinary lines is a space; each empty line is a
      // newline; a break next to a more-indented line is kept as it is.
      let prev: { text: string; more: boolean } | null = null
      let blanks = 0
      for (const r of rows) {
        if (r.text === '') {
          blanks++
          continue
        }
        if (prev === null) body += '\n'.repeat(blanks) + r.text
        else if (prev.more || r.more) body += '\n'.repeat(blanks + 1) + r.text
        else body += (blanks === 0 ? ' ' : '\n'.repeat(blanks)) + r.text
        prev = r
        blanks = 0
      }
    }
    if (rows.length === 0) return chomp === '+' ? '\n'.repeat(trailing) : ''
    if (chomp === '-') return body
    if (chomp === '+') return body + '\n'.repeat(trailing + 1)
    return body + '\n'
  }
}

/** Flow collections on one line: `[a, "b"]`, `{a: b}`. */
class Flow {
  private i = 0
  constructor(
    private readonly s: string,
    private readonly n: number,
  ) {}

  private ws(): void {
    while (this.s[this.i] === ' ') this.i++
  }

  end(): void {
    this.ws()
    if (this.i < this.s.length) throw new YamlError('unexpected text after a flow collection', this.n, 'Remove it.')
  }

  node(): YamlNode {
    this.ws()
    const c = this.s[this.i]
    if (c === undefined) throw new YamlError('a flow collection is not closed on its line', this.n, 'Close it on the same line, or use block style (one item per line).')
    if (c === '&') throw new YamlError('anchors (&name) are not supported', this.n, 'Write the value out where it is used.')
    if (c === '*') throw new YamlError('aliases (*name) are not supported', this.n, 'Write the value out instead of referring to an anchor.')
    if (c === '!') throw new YamlError('tags (!tag) are not supported', this.n, 'Remove the tag.')
    if (c === '[') {
      this.i++
      const items: YamlNode[] = []
      for (;;) {
        this.ws()
        if (this.s[this.i] === ']') {
          this.i++
          break
        }
        items.push(this.node())
        this.ws()
        if (this.s[this.i] === ',') this.i++
        else if (this.s[this.i] !== ']') throw new YamlError('a flow sequence is not closed on its line', this.n, 'Close it with "]" on the same line, or use block style.')
      }
      return { k: 'seq', items, line: this.n }
    }
    if (c === '{') {
      this.i++
      const entries: [string, YamlNode][] = []
      const seen = new Set<string>()
      for (;;) {
        this.ws()
        if (this.s[this.i] === '}') {
          this.i++
          break
        }
        const key = this.scalar(true)
        this.ws()
        if (this.s[this.i] !== ':') throw new YamlError('expected ":" in a flow mapping', this.n, 'Write {key: value}.')
        this.i++
        if (key.v === '<<' && key.plain) throw new YamlError('merge keys (<<) are not supported', this.n, 'Write the merged fields out.')
        if (seen.has(key.v)) throw new YamlError(`the key "${key.v}" appears twice in one mapping`, this.n, 'Remove or rename one of them.')
        seen.add(key.v)
        this.ws()
        const empty = this.s[this.i] === ',' || this.s[this.i] === '}'
        entries.push([key.v, empty ? { k: 'scalar', v: '', plain: true, line: this.n } : this.node()])
        this.ws()
        if (this.s[this.i] === ',') this.i++
        else if (this.s[this.i] !== '}') throw new YamlError('a flow mapping is not closed on its line', this.n, 'Close it with "}" on the same line, or use block style.')
      }
      return { k: 'map', entries, line: this.n }
    }
    return this.scalar(false)
  }

  private scalar(isKey: boolean): Extract<YamlNode, { k: 'scalar' }> {
    const c = this.s[this.i]
    if (c === '"' || c === "'") {
      const start = this.i
      let j = start + 1
      for (; j < this.s.length; j++) {
        if (c === '"' && this.s[j] === '\\') {
          j++
          continue
        }
        if (this.s[j] === c) {
          if (c === "'" && this.s[j + 1] === "'") {
            j++
            continue
          }
          break
        }
      }
      if (j >= this.s.length) throw new YamlError('a quoted value is not closed on its line', this.n, 'Add the closing quote.')
      this.i = j + 1
      const raw = this.s.slice(start, j + 1)
      return { k: 'scalar', v: unquote(raw, this.n), plain: false, line: this.n }
    }
    const start = this.i
    while (this.i < this.s.length) {
      const ch = this.s[this.i] as string
      if (ch === ',' || ch === ']' || ch === '}' || ch === '[' || ch === '{') break
      if (ch === ':' && (isKey || this.s[this.i + 1] === ' ' || this.i + 1 === this.s.length)) break
      this.i++
    }
    return { k: 'scalar', v: this.s.slice(start, this.i).trim(), plain: true, line: this.n }
  }
}

export function parseYaml(text: string): YamlNode {
  return new Parser(text).parse()
}

const INT_RE = /^[-+]?(0|[1-9][0-9]*)$/
const FLOAT_RE = /^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$/

/** What a plain scalar means under YAML's core schema. */
export function coreScalar(v: string): string | number | boolean | null {
  if (v === '' || v === '~' || v === 'null' || v === 'Null' || v === 'NULL') return null
  if (v === 'true' || v === 'True' || v === 'TRUE') return true
  if (v === 'false' || v === 'False' || v === 'FALSE') return false
  if (INT_RE.test(v) || FLOAT_RE.test(v)) return Number(v)
  if (/^0x[0-9a-fA-F]+$/.test(v)) return parseInt(v.slice(2), 16)
  if (/^0o[0-7]+$/.test(v)) return parseInt(v.slice(2), 8)
  if (/^[-+]?\.(inf|Inf|INF)$/.test(v)) return v.startsWith('-') ? -Infinity : Infinity
  if (/^\.(nan|NaN|NAN)$/.test(v)) return NaN
  return v
}

/** The tree as plain data under the core schema. */
export function core(node: YamlNode): unknown {
  if (node.k === 'scalar') return node.plain ? coreScalar(node.v) : node.v
  if (node.k === 'seq') return node.items.map(core)
  const out: Record<string, unknown> = {}
  for (const [k, v] of node.entries) Object.defineProperty(out, k, { value: core(v), enumerable: true, writable: true, configurable: true })
  return out
}

// ───────────────────────────── emitter ─────────────────────────────

const PLAIN_SAFE = /^[A-Za-z0-9_./()$][A-Za-z0-9_./()$ :@%+=<>~^|*!?'"\[\]{},;&\\-]*$/

function plainOk(s: string): boolean {
  if (!PLAIN_SAFE.test(s) || s !== s.trim() || /:( |$)/.test(s)) return false
  if (typeof coreScalar(s) !== 'string') return false
  return true
}

function scalarText(s: string): string {
  return plainOk(s) ? s : JSON.stringify(s)
}

/** A string that a literal block scalar reproduces exactly. */
function blockOk(s: string): boolean {
  if (!s.includes('\n') || /[\x00-\x09\x0b-\x1f\x7f\u0085\u2028\u2029\ufeff]/.test(s)) return false
  if (/\n\n$/.test(s) || s.startsWith('\n') || s.startsWith(' ')) return false
  return s.split('\n').every((line) => !/\s$/.test(line))
}

function emit(v: unknown, indent: number, out: string[], lead: string): void {
  const pad = ' '.repeat(indent)
  if (Array.isArray(v)) {
    if (v.length === 0) {
      out.push(lead === '' ? `${pad}[]` : `${lead} []`)
      return
    }
    if (lead !== '') out.push(lead)
    for (const item of v) {
      if (item !== null && typeof item === 'object' && (Array.isArray(item) ? item.length > 0 : Object.keys(item).length > 0)) {
        const sub: string[] = []
        emit(item, indent + 2, sub, '')
        sub[0] = `${pad}- ${(sub[0] as string).slice(indent + 2)}`
        out.push(...sub)
      } else {
        const sub: string[] = []
        emit(item, indent + 2, sub, `${pad}-`)
        out.push(...sub)
      }
    }
    return
  }
  if (v !== null && typeof v === 'object') {
    const keys = Object.keys(v)
    if (keys.length === 0) {
      out.push(lead === '' ? `${pad}{}` : `${lead} {}`)
      return
    }
    if (lead !== '') out.push(lead)
    for (const k of keys) emit((v as Record<string, unknown>)[k], indent + 2, out, `${pad}${scalarText(k)}:`)
    return
  }
  let text: string
  if (v === null || v === undefined) text = 'null'
  else if (typeof v === 'number') text = Number.isNaN(v) ? '.nan' : v === Infinity ? '.inf' : v === -Infinity ? '-.inf' : String(v)
  else if (typeof v === 'boolean') text = String(v)
  else {
    const s = String(v)
    if (lead !== '' && blockOk(s)) {
      const body = s.endsWith('\n') ? s.slice(0, -1) : s
      out.push(`${lead} ${s.endsWith('\n') ? '|' : '|-'}`)
      for (const line of body.split('\n')) out.push(line === '' ? '' : `${pad}${line}`)
      return
    }
    text = scalarText(s)
  }
  out.push(lead === '' ? `${pad}${text}` : `${lead} ${text}`)
}

/** Block-style YAML for plain data. What it writes, `parseYaml` + `core` read back to the same data. */
export function toYaml(value: unknown): string {
  const out: string[] = []
  emit(value, 0, out, '')
  return out.join('\n') + '\n'
}
