/**
 * A parser for the one body the Explore view waits on: a Prometheus range-query envelope,
 * `{"status":"success","data":{"resultType":"matrix","result":[{"metric":{…},"values":[[t,"v"],…]},…]}}`.
 *
 * Why not `JSON.parse`: for 200 series over 3 h (144,000 samples, 3.4 MB) it builds 144,000
 * two-element arrays, 144,000 strings and as many boxed numbers, about 125 ms at 4x CPU, and
 * the young generation then collects them (design-system/reviews/app-restyle/fixes/FIXES.md).
 * This parser writes each sample's time and value straight into Float64Arrays, and takes the
 * body in pieces as they arrive, so most of the work is done while the rest downloads.
 *
 * It is specialised, not general: inside `data.result` it accepts only series objects of
 * `metric` (any JSON object) and `values` (pairs of a number and a string), in either order.
 * Anything else there (a native histogram, another key) and any input it cannot read makes
 * it give up the fast path, and `finish()` parses the whole text with `JSON.parse` instead:
 * the answer is the same either way, only slower. Outside `data.result` (the envelope,
 * `warnings`, `infos`, an error) the text is small and is parsed by `JSON.parse` at the end.
 *
 * Numbers: a time or value whose digits, as an integer, stay below 2^53, with at most 22 of
 * them after the point, is computed from its digits (the "fast path" of Clinger: exact,
 * because both operands are exact doubles and IEEE division rounds correctly); anything
 * else is read by `Number()` from its text. So every number equals what `JSON.parse` and
 * `Number` give. A time must be a JSON number, as `JSON.parse` requires.
 * "NaN", "+Inf" and "-Inf" are read as such.
 */
import { placeOnGrid, type OnGrid } from '../lib/series'
import type { Metric } from './types'

export interface ParsedSeries {
  metric: Metric
  /** Sample times, epoch seconds, in the order sent. */
  times: Float64Array
  /** Sample values, as numbers (NaN, ±Infinity kept). */
  values: Float64Array
  /** This series' `values` array as JSON, for the raw JSON form: the text as it arrived on the fast path. */
  valuesText: () => string
  /** Where that text is in `ParsedMatrix.text` ([from, to)); null on the slow path. */
  valuesRange: [number, number] | null
  /** The series on the grid the parser was given (lib/series `placeOnGrid`), placed as soon as it was read; absent without a grid and on the slow path. */
  onGrid?: OnGrid
}

/** The grid a range query was asked for, in epoch seconds: each series is placed on it as soon as it has been read. */
export interface MatrixGrid {
  start: number
  end: number
  step: number
}

export interface ParsedMatrix {
  series: ParsedSeries[]
  warnings: string[]
  infos: string[]
  /** The whole body, as received. */
  text: string
  /** False when the fast path gave up and the body was read with JSON.parse. */
  fast: boolean
}

/** The envelope was not a successful matrix: the caller treats it as any other response. */
export class NotAMatrix extends Error {
  constructor(readonly body: unknown) {
    super('not a matrix response')
  }
}

/** `outsideString` when a string of the envelope runs on from the last piece. */
const STRING_CONTINUES = -2

/** Characters of a new piece read together with the unit cut at the end of the last one. */
const JUNCTION = 1024

const POW10 = [1, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11, 1e12, 1e13, 1e14, 1e15, 1e16, 1e17, 1e18, 1e19, 1e20, 1e21, 1e22]

// Character codes.
const QUOTE = 34
const BACKSLASH = 92
const COMMA = 44
const COLON = 58
const LBRACKET = 91
const RBRACKET = 93
const LBRACE = 123
const RBRACE = 125
const MINUS = 45
const PLUS = 43
const DOT = 46
const ZERO = 48
const NINE = 57
const LOWER_E = 101
const UPPER_E = 69

const isSpace = (c: number) => c === 32 || c === 10 || c === 13 || c === 9

/** 2^53: integers below it, and so the digits of a mantissa below it, are exact doubles. */
const EXACT = 9007199254740992

/**
 * A number read from `s[from, to)`, exactly as `Number()` reads it. A plain decimal whose
 * digits, read as an integer, stay below 2^53 and whose fraction has at most 22 digits is
 * computed from its digits (exact: both operands of the one division are exact doubles, and
 * IEEE division rounds correctly); anything else is handed to `Number()`.
 */
export function readNumber(s: string, from: number, to: number): number {
  let i = from
  let c = s.charCodeAt(i)
  let neg = false
  if (c === MINUS) {
    neg = true
    i++
  } else if (c === PLUS) i++
  let m = 0
  let scale = 0
  let any = false
  for (; i < to; i++) {
    const d = s.charCodeAt(i) - ZERO
    if (d < 0 || d > 9) break
    m = m * 10 + d
    any = true
  }
  if (i < to && s.charCodeAt(i) === DOT) {
    for (i++; i < to; i++) {
      const d = s.charCodeAt(i) - ZERO
      if (d < 0 || d > 9) break
      m = m * 10 + d
      scale--
      any = true
    }
  }
  if (i !== to || !any || m >= EXACT || scale < -22) return Number(s.slice(from, to))
  const v = scale === 0 ? m : m / POW10[-scale]!
  return neg ? -v : v
}

/**
 * A sample time: a JSON number (what JSON.parse accepts, no more), read exactly; NaN when
 * the text is not a JSON number. The common form, digits with an optional fraction, is read
 * in the same pass that checks it.
 */
export function readTime(s: string, from: number, to: number): number {
  let i = from
  let c = s.charCodeAt(i)
  if (c === MINUS) c = s.charCodeAt(++i)
  // JSON allows no leading zero before another digit, and needs a digit first.
  if (c === ZERO && i + 1 < to) {
    const d = s.charCodeAt(i + 1) - ZERO
    if (d >= 0 && d <= 9) return NaN
  }
  if (!(c >= ZERO && c <= NINE)) return NaN
  let simple = true
  for (; i < to; i++) {
    const d = s.charCodeAt(i) - ZERO
    if (d < 0 || d > 9) break
  }
  if (i < to && s.charCodeAt(i) === DOT) {
    const f = ++i
    for (; i < to; i++) {
      const d = s.charCodeAt(i) - ZERO
      if (d < 0 || d > 9) break
    }
    if (i === f) return NaN
  }
  if (i !== to) simple = false
  if (!simple) return isJsonNumber(s, from, to) ? Number(s.slice(from, to)) : NaN
  return readNumber(s, from, to)
}

/** Whether `s[from, to)` is a JSON number (`-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?`): what JSON.parse accepts as a time. */
export function isJsonNumber(s: string, from: number, to: number): boolean {
  let i = from
  if (s.charCodeAt(i) === MINUS) i++
  const first = s.charCodeAt(i)
  if (first === ZERO) i++
  else if (first > ZERO && first <= NINE) while (i < to && s.charCodeAt(i) >= ZERO && s.charCodeAt(i) <= NINE) i++
  else return false
  if (i < to && s.charCodeAt(i) === DOT) {
    i++
    const d = i
    while (i < to && s.charCodeAt(i) >= ZERO && s.charCodeAt(i) <= NINE) i++
    if (i === d) return false
  }
  if (i < to && (s.charCodeAt(i) === LOWER_E || s.charCodeAt(i) === UPPER_E)) {
    i++
    if (i < to && (s.charCodeAt(i) === PLUS || s.charCodeAt(i) === MINUS)) i++
    const d = i
    while (i < to && s.charCodeAt(i) >= ZERO && s.charCodeAt(i) <= NINE) i++
    if (i === d) return false
  }
  return i === to
}

/** A sample value from the text between its quotes. */
function readValue(s: string, from: number, to: number): number {
  const n = to - from
  if (n === 3 && s.startsWith('NaN', from)) return NaN
  if (n === 4 && s.charCodeAt(from + 1) === 73 /* I */) {
    if (s.startsWith('+Inf', from)) return Infinity
    if (s.startsWith('-Inf', from)) return -Infinity
  }
  if (n === 3 && s.startsWith('Inf', from)) return Infinity
  const v = readNumber(s, from, to)
  // Not a plain number (NaN from Number()): an escape inside the quotes would mean other text
  // than the raw characters, which JSON.parse alone reads right.
  if (v !== v && s.slice(from, to).includes('\\')) throw new Error('an escape in a sample value')
  return v
}

/** Growable pair of Float64Arrays. */
class Samples {
  times: Float64Array
  values: Float64Array
  n = 0
  constructor(capacity: number) {
    this.times = new Float64Array(capacity)
    this.values = new Float64Array(capacity)
  }
  push(t: number, v: number): void {
    if (this.n === this.times.length) {
      const times = new Float64Array(this.n * 2)
      times.set(this.times)
      this.times = times
      const values = new Float64Array(this.n * 2)
      values.set(this.values)
      this.values = values
    }
    this.times[this.n] = t
    this.values[this.n++] = v
  }
}

const enum Mode {
  /** The envelope around `data.result`: scanned for its place, kept as text. */
  Outside,
  /** Inside `data.result`, between series. */
  Result,
  /** Inside a series object, between its keys. */
  Series,
  /** Inside a series' `values` array, between pairs. */
  Values,
  /** After `data.result` closed: the rest of the envelope. */
  After,
  /** The fast path gave up: only collecting text for JSON.parse. */
  Failed,
}

/** One container of the envelope outside `result`: its kind and, for an object, the key whose value comes next. */
interface Frame {
  object: boolean
  key: string | null
  /** In an object: true when a key (not a value) comes next. */
  expectKey: boolean
}

export class MatrixParser {
  private readonly chunks: string[] = []
  /** Text not yet consumed: the tail of what arrived, from the start of an incomplete unit. */
  private pending = ''
  /** Characters of the body before `pending`. */
  private consumed = 0
  private mode: Mode = Mode.Outside
  /** The envelope's text with the series left out (`"result":[]`), parsed at the end. */
  private outside: string[] = []
  private readonly stack: Frame[] = []
  private readonly series: ParsedSeries[] = []
  /** The series being read. */
  private metric: Metric | null = null
  private samples: Samples | null = null
  private valuesAt: [number, number] = [0, 0]
  private seenValues = false
  /** Samples per series of the first series: the starting capacity of the next. */
  private capacity = 256
  /** Outside: the start of the string being scanned, or -1. */
  private outsideString = -1

  /**
   * With `grid`, each series is also put on it (`ParsedSeries.onGrid`) in the piece of the body
   * that ends it, so that this work is done while the rest downloads and not after the last
   * byte (design-system/reviews/chart-speed).
   */
  constructor(private readonly grid?: MatrixGrid) {}

  /** Feed the next piece of the body. */
  push(chunk: string): void {
    if (chunk === '') return
    this.chunks.push(chunk)
    if (this.mode === Mode.Failed) return
    let s = chunk
    let base = this.consumed
    let from = 0
    try {
      if (this.pending !== '') {
        // The unit cut at the end of the last piece is finished on a short junction string, and
        // the rest is read from the piece itself: reading characters through a concatenation
        // of the two (a cons string in V8) was about twice as slow (README, "Speed").
        const p = this.pending
        const head = p + chunk.slice(0, JUNCTION)
        const i = this.run(head, base, 0)
        const inValues = this.mode === Mode.Result || this.mode === Mode.Series || this.mode === Mode.Values
        if (i >= p.length && inValues) {
          base += p.length
          from = i - p.length
        } else {
          // The cut unit is longer than the junction, or the envelope is being read: the whole of both.
          s = p + chunk
          from = i
        }
      }
      const i = this.run(s, base, from)
      this.pending = i < s.length ? s.slice(i) : ''
      this.consumed = base + i
    } catch {
      this.mode = Mode.Failed
    }
  }

  /**
   * The whole body has arrived: the parsed matrix, or NotAMatrix with the parsed body. On the
   * fast path the body's text is joined only when it is first read (`text`, `valuesText`: the
   * JSON form): joining 3.4 MB of pieces took about 12 ms unthrottled, after the last byte.
   */
  finish(): ParsedMatrix {
    this.joined = null
    if (this.mode === Mode.After && this.pending.trim() === '') {
      let envelope: unknown
      try {
        envelope = JSON.parse(this.outside.join(''))
      } catch {
        envelope = undefined
      }
      const e = envelope as { status?: unknown; data?: { resultType?: unknown; result?: unknown }; warnings?: unknown; infos?: unknown } | undefined
      if (e && e.status === 'success' && e.data && e.data.resultType === 'matrix' && Array.isArray(e.data.result) && e.data.result.length === 0) {
        const parser = this
        return {
          series: this.series,
          warnings: strings(e.warnings),
          infos: strings(e.infos),
          get text() {
            return parser.text()
          },
          fast: true,
        }
      }
    }
    return fromJson(this.text())
  }

  /** Consume as much of `s` as forms complete units; returns where the first incomplete one starts. */
  private run(s: string, base: number, from: number): number {
    let i = from
    const n = s.length
    while (i < n) {
      switch (this.mode) {
        case Mode.Outside:
        case Mode.After: {
          const j = this.scanOutside(s, i)
          if (j < 0) return n // all of it was taken into `outside`
          i = j
          break
        }
        case Mode.Failed:
          return n
        case Mode.Result: {
          while (i < n && isSpace(s.charCodeAt(i))) i++
          if (i >= n) return i
          const c = s.charCodeAt(i)
          if (c === LBRACE) {
            this.metric = null
            this.samples = null
            this.seenValues = false
            this.mode = Mode.Series
            i++
          } else if (c === COMMA && this.series.length > 0) i++
          else if (c === RBRACKET) {
            // `result` is closed: the rest is envelope again.
            this.outside.push(']')
            this.mode = Mode.After
            i++
          } else throw new Error('unexpected character in result')
          break
        }
        case Mode.Series: {
          while (i < n && isSpace(s.charCodeAt(i))) i++
          if (i >= n) return i
          const c = s.charCodeAt(i)
          if (c === COMMA) {
            i++
            continue
          }
          if (c === RBRACE) {
            if (!this.metric || !this.samples) throw new Error('series without metric or values')
            const k = this.samples.n
            const [from, to] = this.valuesAt
            const times = this.samples.times.subarray(0, k)
            const values = this.samples.values.subarray(0, k)
            const g = this.grid
            const onGrid = g ? { start: g.start, end: g.end, step: g.step, values: placeOnGrid(times, values, g.start, g.end, g.step) } : undefined
            this.series.push({ metric: this.metric, times, values, valuesText: () => this.text().slice(from, to), valuesRange: [from, to], onGrid })
            if (this.series.length === 1) this.capacity = Math.max(16, k)
            this.mode = Mode.Result
            i++
            continue
          }
          if (c !== QUOTE) throw new Error('expected a key')
          // A key and its colon: "metric" or "values".
          const close = s.indexOf('"', i + 1)
          if (close < 0) return i
          const key = s.slice(i + 1, close)
          let j = close + 1
          while (j < n && isSpace(s.charCodeAt(j))) j++
          if (j >= n) return i
          if (s.charCodeAt(j) !== COLON) throw new Error('expected a colon')
          j++
          while (j < n && isSpace(s.charCodeAt(j))) j++
          if (j >= n) return i
          if (key === 'metric') {
            const end = objectEnd(s, j)
            if (end < 0) return i
            this.metric = JSON.parse(s.slice(j, end)) as Metric
            i = end
          } else if (key === 'values' && !this.seenValues) {
            if (s.charCodeAt(j) !== LBRACKET) throw new Error('values is not an array')
            this.seenValues = true
            this.samples = new Samples(this.capacity)
            this.valuesAt = [base + j, -1]
            this.mode = Mode.Values
            i = j + 1
          } else throw new Error(`a series key this parser does not read: ${key}`)
          break
        }
        case Mode.Values: {
          // The hot loop: pairs [number, "string"], separated by commas, until `]`.
          const samples = this.samples!
          for (;;) {
            let c = s.charCodeAt(i)
            while (isSpace(c)) c = s.charCodeAt(++i)
            if (i >= n) return i
            if (c === COMMA && samples.n > 0) {
              const comma = i
              c = s.charCodeAt(++i)
              while (isSpace(c)) c = s.charCodeAt(++i)
              if (i >= n) return comma
            }
            if (c === RBRACKET) {
              this.valuesAt[1] = base + i + 1
              this.mode = Mode.Series
              i++
              break
            }
            if (c !== LBRACKET) throw new Error('expected a sample')
            // Compact form, `[t,"v"]`, found with indexOf (native, faster than a loop here);
            // anything else, or a pair not yet all here, goes the long way below.
            const comma = s.indexOf(',', i + 1)
            if (comma > 0 && s.charCodeAt(comma + 1) === QUOTE) {
              const v1 = s.indexOf('"', comma + 2)
              if (v1 > 0 && s.charCodeAt(v1 + 1) === RBRACKET) {
                const t = readTime(s, i + 1, comma)
                if (t === t) {
                  samples.push(t, readValue(s, comma + 2, v1))
                  i = v1 + 2
                  continue
                }
              }
            }
            const start = i
            // The time: up to the comma.
            let j = i + 1
            while (j < n && isSpace(s.charCodeAt(j))) j++
            const t0 = j
            for (; j < n; j++) {
              const d = s.charCodeAt(j)
              if (d === COMMA || isSpace(d)) break
            }
            if (j >= n) return start
            const t1 = j
            while (j < n && isSpace(s.charCodeAt(j))) j++
            if (j >= n) return start
            if (s.charCodeAt(j) !== COMMA) throw new Error('expected a comma in a sample')
            j++
            while (j < n && isSpace(s.charCodeAt(j))) j++
            if (j >= n) return start
            if (s.charCodeAt(j) !== QUOTE) throw new Error('expected a quoted value')
            const v0 = j + 1
            let v1 = v0
            for (; v1 < n; v1++) {
              const d = s.charCodeAt(v1)
              if (d === QUOTE) break
              if (d === BACKSLASH) throw new Error('an escape in a sample value')
            }
            if (v1 >= n) return start
            j = v1 + 1
            while (j < n && isSpace(s.charCodeAt(j))) j++
            if (j >= n) return start
            if (s.charCodeAt(j) !== RBRACKET) throw new Error('expected the end of a sample')
            const t = readTime(s, t0, t1)
            if (t !== t) throw new Error('a time that is not a JSON number')
            samples.push(t, readValue(s, v0, v1))
            i = j + 1
          }
          break
        }
        default:
          return n
      }
    }
    return i
  }

  /** The body as received so far. */
  received(): string {
    return this.chunks.join('')
  }

  private joined: string | null = null
  /** The whole body as received so far (joined once). */
  private text(): string {
    return (this.joined ??= this.chunks.join(''))
  }

  /**
   * Scan the envelope from `i`: copy it to `outside`, follow containers and keys, and stop
   * after `"result":[` inside the top-level `data`. Returns where scanning stopped, or -1
   * when everything given was consumed.
   */
  private scanOutside(s: string, i: number): number {
    const n = s.length
    let from = i
    // A string that ran on from the last piece continues where this one starts reading.
    if (this.outsideString === STRING_CONTINUES) this.outsideString = i
    while (i < n) {
      const c = s.charCodeAt(i)
      if (this.outsideString >= 0) {
        // Inside a string (possibly begun in an earlier piece).
        if (c === BACKSLASH) {
          // An escape cut in two by the network: rare enough to leave to JSON.parse.
          if (i + 1 >= n) {
            this.mode = Mode.Failed
            return -1
          }
          i += 2
          continue
        }
        if (c === QUOTE) {
          const frame = this.stack[this.stack.length - 1]
          if (frame && frame.object && frame.expectKey) {
            // A key: remembered whole (keys are short; one split across pieces is re-read).
            const keyText = this.keyText + s.slice(this.outsideString, i)
            frame.key = JSON.parse(`"${keyText}"`) as string
            frame.expectKey = false
          }
          this.keyText = ''
          this.outsideString = -1
        }
        i++
        continue
      }
      if (c === QUOTE) {
        this.outsideString = i + 1
        this.keyText = ''
        i++
        continue
      }
      if (c === LBRACE || c === LBRACKET) {
        // `"result": [` in the top-level `data` object: the series start here.
        const frame = this.stack[this.stack.length - 1]
        if (c === LBRACKET && this.mode === Mode.Outside && frame && frame.object && frame.key === 'result' && this.stack.length === 2 && this.stack[0]!.key === 'data') {
          this.outside.push(s.slice(from, i + 1))
          this.mode = Mode.Result
          return i + 1
        }
        this.stack.push({ object: c === LBRACE, key: null, expectKey: c === LBRACE })
      } else if (c === RBRACE || c === RBRACKET) {
        this.stack.pop()
      } else if (c === COMMA) {
        const frame = this.stack[this.stack.length - 1]
        if (frame && frame.object) frame.expectKey = true
      }
      i++
    }
    if (this.outsideString >= 0) {
      // A string runs on into the next piece: keep what there is of a key.
      this.keyText += s.slice(this.outsideString, n)
      this.outsideString = STRING_CONTINUES
    }
    this.outside.push(s.slice(from, n))
    return -1
  }
  private keyText = ''
}

/** The end (exclusive) of the JSON object starting at `i`, or -1 if it is not all in `s`. */
function objectEnd(s: string, i: number): number {
  if (s.charCodeAt(i) !== LBRACE) throw new Error('expected an object')
  let depth = 0
  const n = s.length
  for (; i < n; i++) {
    const c = s.charCodeAt(i)
    if (c === QUOTE) {
      for (i++; i < n; i++) {
        const d = s.charCodeAt(i)
        if (d === BACKSLASH) i++
        else if (d === QUOTE) break
      }
      if (i >= n) return -1
    } else if (c === LBRACE || c === LBRACKET) depth++
    else if (c === RBRACE || c === RBRACKET) {
      depth--
      if (depth === 0) return i + 1
    }
  }
  return -1
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

/** The slow path: JSON.parse, then the same typed arrays. Throws NotAMatrix for any other body. */
export function fromJson(text: string): ParsedMatrix {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw new NotAMatrix(undefined)
  }
  const e = body as { status?: unknown; data?: { resultType?: unknown; result?: unknown }; warnings?: unknown; infos?: unknown }
  if (!e || e.status !== 'success' || !e.data || e.data.resultType !== 'matrix' || !Array.isArray(e.data.result)) throw new NotAMatrix(body)
  const series: ParsedSeries[] = []
  for (const r of e.data.result as { metric?: Metric; values?: [number, string][] }[]) {
    if (!r || typeof r !== 'object' || (r.values !== undefined && !Array.isArray(r.values))) throw new NotAMatrix(body)
    const values = r.values ?? []
    const times = new Float64Array(values.length)
    const vs = new Float64Array(values.length)
    for (let k = 0; k < values.length; k++) {
      const pair = values[k]
      if (!Array.isArray(pair)) throw new NotAMatrix(body)
      times[k] = Number(pair[0])
      const v = pair[1]
      vs[k] = v === '+Inf' || v === 'Inf' ? Infinity : v === '-Inf' ? -Infinity : Number(v)
    }
    series.push({ metric: r.metric ?? {}, times, values: vs, valuesText: () => JSON.stringify(values), valuesRange: null })
  }
  return { series, warnings: strings(e.warnings), infos: strings(e.infos), text, fast: false }
}

/** Parse a whole body at once (tests, and bodies that arrive in one piece). */
export function parseMatrix(text: string): ParsedMatrix {
  const p = new MatrixParser()
  p.push(text)
  return p.finish()
}
