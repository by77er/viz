import { CURSOR_ARG, MAX_TOKENS_ARG, TIME_ARG, formatDuration } from '../args'
import { budgetOf, type Item } from '../page'
import { COUNTER_FUNCTIONS, FUNCTIONS, type Node, PromQLSyntaxError, parsePromQL, selectorText, selectorsOf, typeName, walk } from '../promql'
import { didYouMean } from '../suggest'
import { mapBounded, type Session } from '../session'
import { type ToolDef, ToolError, pagedResult } from '../tool'
import { cell, clean, MAX } from '../untrusted'
import { cursorOf, looksLikeCounter, pinRange, rangeOf, rangeText } from './common'

export const EXPR_ARG = { type: 'string', minLength: 1, maxLength: 10000, description: 'The query expression.' } as const
export const LANG_ARG = { type: 'string', enum: ['promql', 'traceql', 'logql'], default: 'promql', description: 'Query language. Only PromQL is available yet.' } as const

/** Assumed sample spacing for the scan estimate when nothing better is known. */
export const ASSUMED_SCRAPE_SECONDS = 15
const LOOKBACK_SECONDS = 300

export function notAvailable(lang: unknown): ToolError {
  return new ToolError('not-available-yet', `${lang === 'traceql' ? 'TraceQL' : 'LogQL'} is not available yet: this deployment has no engine for it.`, 'Use PromQL (lang "promql") over metrics.', { status: 501 })
}

/** A caret under the error position, one line of context, all of it cleaned (the expression is untrusted). */
export function caretText(expr: string, e: PromQLSyntaxError): string {
  const lines = expr.split('\n')
  const line = lines[e.position.line - 1] ?? ''
  const from = Math.max(0, e.position.column - 1 - 60)
  const shown = line.slice(from, from + 120)
  const col = e.position.column - 1 - from
  return `${clean(shown, { kind: 'expr', max: 160 })}\n${' '.repeat(Math.max(0, col))}${'^'.repeat(Math.max(1, Math.min(e.length, 40)))}\n`
}

interface Finding {
  severity: 'error' | 'warning' | 'info'
  code: string
  /** Untrusted (may quote the expression or a name); shown as data. */
  message: string
  suggestion?: string[]
  position?: { offset: number; line: number; column: number }
  /** Already cleaned: the line and a caret under the error. */
  caret?: string
}

export const validateQuery: ToolDef = {
  name: 'validate_query',
  title: 'Validate a query',
  description:
    'Check a query without running it: syntax with the position of each error (offset, line, column) and a caret, value types, metric and label names checked against this tenant\'s own names with did-you-mean suggestions, common mistakes (rate() on a gauge, histogram_quantile without le), and a cost estimate from series counts over the range (default the last hour): series touched per selector, output points, samples to read. Only PromQL is available yet.',
  scopes: ['read'],
  defaultTokens: 800,
  readOnly: true,
  input: {
    type: 'object',
    additionalProperties: false,
    required: ['expr'],
    properties: {
      expr: EXPR_ARG,
      lang: LANG_ARG,
      from: TIME_ARG('Start of the range the estimate is for', 'now-1h'),
      to: TIME_ARG('End of that range', 'now'),
      step: { type: ['string', 'number'], maxLength: 32, description: 'Step for a range query, e.g. "1m"; default chosen from the range (about 120 points).' },
      max_tokens: MAX_TOKENS_ARG(800),
      cursor: CURSOR_ARG,
    },
  },
  async run(s, args) {
    const c = cursorOf(this.name, args)
    if ((args.lang ?? 'promql') !== 'promql') throw notAvailable(args.lang)
    const expr = String(args.expr)
    const r = rangeOf(s, args, c)
    const findings: Finding[] = []
    let ast: Node | null = null
    let type: string | null = null
    try {
      const p = parsePromQL(expr)
      ast = p.ast
      type = p.type
    } catch (e) {
      if (!(e instanceof PromQLSyntaxError)) throw e
      const near = e.unknown?.kind === 'function' ? didYouMean(e.unknown.name, Object.keys(FUNCTIONS), 3) : []
      findings.push({ severity: 'error', code: 'syntax', message: `${e.position.line}:${e.position.column}: parse error: ${e.message}`, caret: caretText(expr, e), position: e.position, ...(near.length ? { suggestion: near } : {}) })
    }

    const estimate: { selector: string; series: number | null; note?: string }[] = []
    if (ast) {
      if (type === 'matrix') findings.push({ severity: 'warning', code: 'range-vector', message: 'The result is a range vector: it can be queried only as an instant query, not over a range.' })
      if (type === 'string') findings.push({ severity: 'warning', code: 'string-result', message: 'The result is a string literal.' })
      const names = new Set(await s.metricNames())
      const sels = selectorsOf(ast)
      const metas = await (async () => {
        s.usage.upstreamCalls++
        const m = await s.query.metadata()
        return m.ok ? m.data : {}
      })()
      // Names and labels, against this tenant's own.
      const labelsOf = new Map<string, Set<string>>()
      const known = [...new Set(sels.map((x) => x.node.name).filter((n): n is string => n !== undefined && names.has(n)))]
      const lookups = await mapBounded(known, s.limits.maxParallel, s.deadline, async (n) => {
        s.usage.upstreamCalls++
        const res = await s.query.labelNames([`{__name__=${JSON.stringify(n)}}`], { start: r.start - LOOKBACK_SECONDS, end: r.end })
        return res.ok ? res.data : null
      })
      known.forEach((n, i) => {
        const l = lookups[i]!
        if (l.ok && l.value) labelsOf.set(n, new Set(l.value))
      })
      for (const { node, fn } of sels) {
        const n = node.name
        if (n !== undefined && !names.has(n)) {
          const near = didYouMean(n, names, 3)
          findings.push({ severity: 'warning', code: 'unknown-metric', message: `No metric named ${JSON.stringify(n)} has data in this tenant; the query will return nothing.`, ...(near.length ? { suggestion: near } : {}) })
        }
        const labels = n !== undefined ? labelsOf.get(n) : undefined
        if (labels) {
          for (const m of node.matchers) {
            if (!labels.has(m.name) && !(m.op === '=' && m.value === '') && !(m.op === '!=' || m.op === '!~')) {
              const near = didYouMean(m.name, labels, 3)
              findings.push({ severity: 'warning', code: 'unknown-label', message: `Metric ${JSON.stringify(n)} has no label ${JSON.stringify(m.name)}; this matcher matches nothing.`, ...(near.length ? { suggestion: near } : {}) })
            }
          }
        }
        if (fn && COUNTER_FUNCTIONS.has(fn) && n !== undefined) {
          const t = metas[n]?.[0]?.type
          if ((t && t !== 'counter' && t !== 'histogram' && t !== 'summary') || (!t && !looksLikeCounter(n))) {
            findings.push({ severity: 'warning', code: 'rate-on-gauge', message: `${fn}() expects a counter, and ${JSON.stringify(n)} looks like a gauge (${t ? `metadata says ${t}` : 'its name has no _total, _count, _sum or _bucket'}). For a gauge use deriv(), delta() or avg_over_time().` })
          }
        }
      }
      walk(ast, (node) => {
        if (node.type === 'call' && node.fn === 'histogram_quantile') {
          const inner = node.args[1]
          if (inner?.type === 'agg' && !inner.without && inner.grouping !== null && !inner.grouping.includes('le')) {
            findings.push({ severity: 'warning', code: 'histogram-without-le', message: 'histogram_quantile() needs the le label; the aggregation inside drops it. Add le to by (...).' })
          }
        }
        if (node.type === 'agg' && node.grouping === null && ['sum', 'avg', 'max', 'min', 'count'].includes(node.op)) {
          // Fine and common; noted only when the input is large (below).
        }
      })
      // Cost: series per selector over the range, from the series API (the query is not run).
      const toCount = sels.slice(0, 20)
      const counts = await mapBounded(toCount, s.limits.maxParallel, s.deadline, async ({ node }) => {
        s.usage.upstreamCalls++
        const window = (node.range ?? LOOKBACK_SECONDS) + Math.max(0, node.offset ?? 0)
        return s.query.series([selectorText(node)], { start: r.start - window, end: r.end })
      })
      toCount.forEach(({ node }, i) => {
        const x = counts[i]!
        const sel = clean(selectorText(node), { kind: 'expr', max: MAX.text })
        if (!x.ok) estimate.push({ selector: sel, series: null, note: 'not counted: the call reached its deadline' })
        else if (!x.value.ok) estimate.push({ selector: sel, series: null, note: `not counted: ${clean(x.value.error, { max: MAX.error })}` })
        else estimate.push({ selector: sel, series: x.value.data.length })
      })
      if (sels.length > toCount.length) estimate.push({ selector: `(${sels.length - toCount.length} more selectors not counted)`, series: null })
    }

    const steps = Math.floor((r.end - r.start) / r.step) + 1
    const series = estimate.reduce((a, e) => a + (e.series ?? 0), 0)
    const sels = ast ? selectorsOf(ast) : []
    const samples = sels.slice(0, 20).reduce((a, { node }, i) => {
      const n = estimate[i]?.series ?? 0
      const window = node.range ?? LOOKBACK_SECONDS
      return a + n * Math.ceil((r.end - r.start + window) / ASSUMED_SCRAPE_SECONDS)
    }, 0)
    const valid = !findings.some((f) => f.severity === 'error')
    const items: Item[] = [
      ...findings.map((f, i) => ({
        key: `f${i}`,
        text: `${f.severity} ${f.code}: ${clean(f.message, { kind: 'expr', max: MAX.long })}${f.suggestion ? ` Did you mean: ${f.suggestion.map((x) => cell(x, MAX.name)).join(', ')}?` : ''}\n${f.caret ?? ''}`,
        data: { severity: f.severity, code: f.code, message: clean(f.message, { kind: 'expr', max: MAX.long }), ...(f.suggestion ? { suggestions: f.suggestion.map((x) => clean(x, { max: MAX.name })) } : {}), ...(f.position ? { position: f.position } : {}), ...(f.caret ? { caret: f.caret } : {}) },
      })),
      ...estimate.map((e, i) => ({
        key: `e${i}`,
        text: `selector ${e.selector}: ${e.series === null ? (e.note ?? 'not counted') : `${e.series} series`}\n`,
        data: e,
      })),
    ]
    const largest = Math.max(0, ...estimate.map((e) => e.series ?? 0))
    const cls = !ast ? 'unknown' : series === 0 ? 'empty' : series <= 1000 && samples <= 5e6 ? 'small' : series <= 20_000 && samples <= 1e8 ? 'medium' : 'large'
    const header =
      `validate_query: ${valid ? 'valid' : 'invalid'} PromQL${type ? `, result type ${typeName(type as 'vector')}` : ''}; ${findings.filter((f) => f.severity === 'error').length} error(s), ${findings.filter((f) => f.severity === 'warning').length} warning(s).\n` +
      (ast
        ? `Estimate (series API only; the query was not run) over ${rangeText(r)}: ${series} series touched (largest selector ${largest}), ${steps} step(s), up to ${series * steps} output points before aggregation, about ${samples} samples to read assuming ${ASSUMED_SCRAPE_SECONDS}s spacing; cost class ${cls}.\n`
        : '') +
      (ast && largest > 5000 ? `High cardinality: aggregate (sum by (...)) or add topk(); step ${formatDuration(r.step)}.\n` : '')
    return pagedResult({
      tool: this.name,
      s,
      args,
      maxTokens: budgetOf(args.max_tokens, this.defaultTokens),
      header,
      items,
      offset: c?.o ?? 0,
      pinned: pinRange(r),
      meta: { valid, resultType: type, estimate: { series, steps, outputPoints: series * steps, samples, assumedScrapeSeconds: ASSUMED_SCRAPE_SECONDS, class: cls, ran: false }, range: { start: r.start, end: r.end, step: r.step } },
    })
  },
}
