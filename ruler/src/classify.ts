/**
 * Cost classification of a rule from the text of its PromQL expression (design §7).
 *
 * The class depends on how far back the expression reads: the largest, over all selectors,
 * of (range or default lookback) + enclosing subquery ranges + offsets. This file computes
 * that with a tokenizer and a bracket-aware walk; it does not parse PromQL and needs no
 * query engine. Where it cannot be sure it over-estimates, so a rule is never promised a
 * cheaper class than it gets:
 *   - every bare identifier that is not a keyword or a function call counts as a selector;
 *   - a negative offset does not shrink the window;
 *   - an `@ <timestamp>` modifier reads an arbitrary time and forces `rollup`.
 */
import { parseDuration } from './util'
import type { CostClass, RuleCost } from '../contracts-proposal/rules'

export interface ClassifyConfig {
  /** A rule whose window fits in this is answered from shard tails. */
  hotWindowMs: number
  /** A rule whose window fits in this reads flush files; beyond it, rollups. */
  recentWindowMs: number
  /** PromQL lookback delta applied to instant selectors. */
  lookbackMs: number
}

export const DEFAULT_CLASSIFY: ClassifyConfig = { hotWindowMs: 10 * 60_000, recentWindowMs: 24 * 3_600_000, lookbackMs: 5 * 60_000 }

type Tok =
  | { t: 'id'; v: string }
  | { t: 'num'; v: string }
  | { t: 'str' }
  | { t: 'open' | 'close' }
  | { t: 'sel' }
  | { t: 'range'; rangeMs: number; subquery: boolean }
  | { t: 'op'; v: string }

export class PromqlTextError extends Error {
  constructor(message: string, readonly offset: number, readonly fix: string) {
    super(message)
  }
}

/** PromQL durations also allow compound and (in newer versions) plain-number seconds. */
function durationMs(text: string, offset: number): number {
  const t = text.trim()
  const d = parseDuration(t)
  if (d !== null) return d
  if (/^\d+(\.\d+)?$/.test(t)) return Math.round(Number(t) * 1000)
  throw new PromqlTextError(`"${t}" is not a duration`, offset, 'Write a duration such as 5m, 1h30m or 30s.')
}

function tokenize(q: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  while (i < q.length) {
    const c = q[i] as string
    if (/\s/.test(c)) {
      i++
    } else if (c === '#') {
      while (i < q.length && q[i] !== '\n') i++
    } else if (c === '"' || c === "'" || c === '`') {
      const start = i
      i++
      while (i < q.length && q[i] !== c) i += c !== '`' && q[i] === '\\' ? 2 : 1
      if (i >= q.length) throw new PromqlTextError('unterminated string', start, 'Close the string literal.')
      i++
      out.push({ t: 'str' })
    } else if (c === '{') {
      // A label matcher block: skip to the matching brace, honouring strings.
      const start = i
      i++
      while (i < q.length && q[i] !== '}') {
        const d = q[i] as string
        if (d === '"' || d === "'" || d === '`') {
          i++
          while (i < q.length && q[i] !== d) i += d !== '`' && q[i] === '\\' ? 2 : 1
        }
        i++
      }
      if (i >= q.length) throw new PromqlTextError('unclosed "{"', start, 'Close the label matchers with "}".')
      i++
      // `metric{...}` is one selector: the identifier before it already counted.
      const prev = out[out.length - 1]
      if (!(prev && prev.t === 'id')) out.push({ t: 'sel' })
      else out[out.length - 1] = { t: 'sel' }
    } else if (c === '[') {
      const end = q.indexOf(']', i)
      if (end < 0) throw new PromqlTextError('unclosed "["', i, 'Close the range with "]".')
      const body = q.slice(i + 1, end)
      const colon = body.indexOf(':')
      out.push({ t: 'range', rangeMs: durationMs(colon < 0 ? body : body.slice(0, colon), i + 1), subquery: colon >= 0 })
      i = end + 1
    } else if (c === '(') {
      out.push({ t: 'open' })
      i++
    } else if (c === ')') {
      out.push({ t: 'close' })
      i++
    } else if (/[0-9.]/.test(c) && !(c === '.' && !/[0-9]/.test(q[i + 1] ?? ''))) {
      let j = i
      while (j < q.length && /[0-9a-zA-Z_.]/.test(q[j] as string)) j++
      if (/[eE]$/.test(q.slice(i, j)) && /[+-]/.test(q[j] ?? '')) {
        j++
        while (j < q.length && /[0-9]/.test(q[j] as string)) j++
      }
      out.push({ t: 'num', v: q.slice(i, j) })
      i = j
    } else if (/[a-zA-Z_:]/.test(c)) {
      let j = i
      while (j < q.length && /[a-zA-Z0-9_:.]/.test(q[j] as string)) j++
      out.push({ t: 'id', v: q.slice(i, j) })
      i = j
    } else {
      out.push({ t: 'op', v: c })
      i++
    }
  }
  return out
}

const KEYWORDS = new Set(['and', 'or', 'unless', 'atan2', 'bool', 'inf', 'nan', 'start', 'end'])
const GROUPING = new Set(['by', 'without', 'on', 'ignoring', 'group_left', 'group_right'])

interface Walk {
  windowMs: number
  fixedAt: boolean
}

/** Largest window among the atoms in `toks[from, to)`. */
function walk(toks: Tok[], from: number, to: number, lookbackMs: number): Walk {
  let best = 0
  let fixedAt = false
  // The atom most recently completed, so a following range / offset can attach to it.
  let atom: number | null = null
  const commit = () => {
    if (atom !== null) best = Math.max(best, atom)
    atom = null
  }
  const matching = (open: number): number => {
    let depth = 0
    for (let k = open; k < to; k++) {
      const t = toks[k] as Tok
      if (t.t === 'open') depth++
      else if (t.t === 'close' && --depth === 0) return k
    }
    throw new PromqlTextError('unbalanced parentheses', 0, 'Check that every "(" has a matching ")".')
  }
  for (let i = from; i < to; i++) {
    const t = toks[i] as Tok
    if (t.t === 'id') {
      const lower = t.v.toLowerCase()
      const next = toks[i + 1]
      if (GROUPING.has(lower)) {
        // `by (a, b)` holds label names, not selectors. An aggregation's grouping may come
        // after its argument list, so the pending atom is kept.
        if (next && next.t === 'open') i = matching(i + 1)
      } else if (lower === 'offset') {
        const sign = next && next.t === 'op' && (next.v === '-' || next.v === '+') ? next.v : ''
        const numTok = toks[i + (sign ? 2 : 1)]
        if (!numTok || numTok.t !== 'num') throw new PromqlTextError('offset needs a duration', 0, 'Write e.g. `offset 5m`.')
        const d = { ms: durationMs(numTok.v, 0), negative: sign === '-' }
        if (atom === null) throw new PromqlTextError('offset must follow a selector', 0, 'Put the offset directly after the selector it shifts.')
        if (!d.negative) atom += d.ms
        i += sign ? 2 : 1
      } else if (KEYWORDS.has(lower) || (next && next.t === 'id' && (next.v.toLowerCase() === 'by' || next.v.toLowerCase() === 'without'))) {
        // operators, literals, and an aggregator written `sum by (x) (...)` read nothing themselves
        if (!KEYWORDS.has(lower)) commit()
      } else if (next && next.t === 'open') {
        // function or aggregation call: its window is that of its arguments
        commit()
        const close = matching(i + 1)
        const inner = walk(toks, i + 2, close, lookbackMs)
        fixedAt ||= inner.fixedAt
        atom = inner.windowMs
        i = close
      } else {
        commit()
        atom = lookbackMs
      }
    } else if (t.t === 'sel') {
      commit()
      atom = lookbackMs
    } else if (t.t === 'open') {
      commit()
      const close = matching(i)
      const inner = walk(toks, i + 1, close, lookbackMs)
      fixedAt ||= inner.fixedAt
      atom = inner.windowMs
      i = close
    } else if (t.t === 'range') {
      if (atom === null) throw new PromqlTextError('a range must follow a selector or a subquery expression', 0, 'Write e.g. `rate(http_requests_total[5m])`.')
      // A range selector reads exactly its range (the lookback no longer applies); a
      // subquery evaluates its inner expression over the range, so the windows add.
      atom = t.subquery ? atom + t.rangeMs : t.rangeMs
    } else if (t.t === 'op') {
      if (t.v === '@') {
        const next = toks[i + 1]
        const isCall = next && next.t === 'id' && (next.v === 'start' || next.v === 'end')
        if (!isCall) fixedAt = true
        i += isCall ? 3 : next && next.t === 'op' ? 2 : 1
      } else if (t.v !== ',') {
        // binary operator: the atom on its left is complete
        commit()
      } else commit()
    } else if (t.t === 'num' || t.t === 'str') {
      commit()
    }
  }
  commit()
  return { windowMs: best, fixedAt }
}

/**
 * The furthest an expression reads back from its evaluation time, in milliseconds.
 * Throws `PromqlTextError` on text that cannot be a PromQL expression (unbalanced
 * brackets, malformed durations); it does not otherwise validate PromQL.
 */
export function maxWindowMs(promql: string, lookbackMs = DEFAULT_CLASSIFY.lookbackMs): { windowMs: number; fixedAt: boolean } {
  const toks = tokenize(promql)
  let depth = 0
  for (const t of toks) {
    if (t.t === 'open') depth++
    else if (t.t === 'close' && --depth < 0) break
  }
  if (depth !== 0) throw new PromqlTextError('unbalanced parentheses', 0, 'Check that every "(" has a matching ")".')
  return walk(toks, 0, toks.length, lookbackMs)
}

export function classify(promql: string, cfg: ClassifyConfig = DEFAULT_CLASSIFY): RuleCost {
  const { windowMs, fixedAt } = maxWindowMs(promql, cfg.lookbackMs)
  let cls: CostClass
  let reason: string
  if (fixedAt) {
    cls = 'rollup'
    reason = 'uses an @ timestamp modifier, which can read any time'
  } else if (windowMs <= cfg.hotWindowMs) {
    cls = 'tail'
    reason = `reads back ${windowMs} ms, within the ${cfg.hotWindowMs} ms shards hold`
  } else if (windowMs <= cfg.recentWindowMs) {
    cls = 'recent'
    reason = `reads back ${windowMs} ms, beyond the ${cfg.hotWindowMs} ms shards hold`
  } else {
    cls = 'rollup'
    reason = `reads back ${windowMs} ms, beyond the ${cfg.recentWindowMs} ms recent window`
  }
  return { class: cls, windowMs, reason }
}
