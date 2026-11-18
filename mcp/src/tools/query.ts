import { type PanelDigest, type SeriesDigest, UNITS, digestPanel, formatNumber } from '../../../dashboard/src/index.ts'
import { CURSOR_ARG, MAX_TOKENS_ARG, TIME_ARG, formatDuration, isoOf } from '../args'
import type { PromData } from '../clients'
import { budgetOf, type Item } from '../page'
import { PromQLSyntaxError, parsePromQL } from '../promql'
import type { Session } from '../session'
import { type ToolDef, ToolError, pagedResult } from '../tool'
import { cell, clean, cleanLabels, MAX } from '../untrusted'
import { cursorOf, exploreLink, pinRange, rangeOf, rangeText } from './common'
import { EXPR_ARG, LANG_ARG, caretText, notAvailable } from './validate'

export const FORMATS = ['digest', 'table', 'series'] as const
/** Buckets per series in the table format. */
export const TABLE_BUCKETS = 24
/** Points per item in the series format. */
export const SERIES_CHUNK = 60

const trendText = (s: SeriesDigest): string => {
  const t = s.trend
  if (!t) return '-'
  if (t.relChange === null) return t.direction
  const pct = t.relChange * 100
  return `${t.direction} ${pct >= 0 ? '+' : ''}${Math.abs(pct) >= 100 ? pct.toFixed(0) : Number(pct.toPrecision(2))}%`
}

const notes = (s: SeriesDigest): string => {
  const f: string[] = []
  if (s.outlier) f.push(`outlier z=${formatNumber(s.z)}`)
  if (s.gaps.count) f.push(`${s.gaps.count} gap(s)`)
  if (s.stale !== undefined) f.push(`stale ${formatNumber(s.stale)}s`)
  if (s.nonFinite) f.push(`${s.nonFinite} non-finite`)
  return f.join('; ')
}

function seriesName(labels: Record<string, string>): string {
  const name = labels.__name__ ?? ''
  const rest = Object.entries(labels).filter(([k]) => k !== '__name__').sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => `${k}=${JSON.stringify(v)}`)
  return `${name}{${rest.join(',')}}`
}

export const query: ToolDef = {
  name: 'query',
  title: 'Run a query',
  description:
    'Run PromQL over a range (default the last hour, about 120 steps) or at one instant. Returns a digest by default: per series the last value, min, max, mean, trend (direction and % change over the range), outliers among the series, gaps and staleness, most important series first (largest values, outliers), with the total series count and whether the answer is complete. format "table" gives each series downsampled to 24 buckets as TSV; format "series" gives every point, paged. Every answer includes a link to the same query in the app\'s Explore view. At most 2,000 series are digested; above that the largest by last value are, and the rest are counted. Only PromQL is available yet.',
  scopes: ['read'],
  defaultTokens: 1500,
  readOnly: true,
  input: {
    type: 'object',
    additionalProperties: false,
    required: ['expr'],
    properties: {
      expr: EXPR_ARG,
      lang: LANG_ARG,
      from: TIME_ARG('Start', 'now-1h'),
      to: TIME_ARG('End (the evaluation time for an instant query)', 'now'),
      step: { type: ['string', 'number'], maxLength: 32, description: 'Resolution, e.g. "1m" or 60; default chosen from the range (about 120 points).' },
      instant: { type: 'boolean', default: false, description: 'Evaluate once at "to" instead of over the range.' },
      format: { type: 'string', enum: [...FORMATS], default: 'digest', description: 'digest (default, statistics per series), table (24 buckets per series, TSV) or series (every point, paged).' },
      top_k: { type: 'integer', minimum: 1, maximum: 50, default: 10, description: 'Series shown in full in the digest; the rest are summarised in one line.' },
      unit: { type: 'string', enum: [...UNITS], description: 'Unit of the values, for the digest and the Explore link.' },
      max_tokens: MAX_TOKENS_ARG(1500),
      cursor: CURSOR_ARG,
    },
  },
  async run(s, args) {
    const c = cursorOf(this.name, args)
    if ((args.lang ?? 'promql') !== 'promql') throw notAvailable(args.lang)
    const expr = String(args.expr)
    const r = rangeOf(s, args, c)
    const instant = args.instant === true
    const format = (args.format as (typeof FORMATS)[number] | undefined) ?? 'digest'
    const topK = (args.top_k as number | undefined) ?? 10
    const unit = args.unit as string | undefined
    const timeout = Math.max(0.05, Math.min(s.limits.queryTimeoutMs, s.deadline - performance.now()) / 1000)
    s.usage.queries++
    s.usage.upstreamCalls++
    const res = instant ? await s.query.instant(expr, r.end, { timeout }) : await s.query.range(expr, r.start, r.end, r.step, { timeout })
    if (!res.ok) {
      let detail = `error (${clean(res.errorType, { max: 40 })}): ${clean(res.error, { max: MAX.error })}\n`
      if (res.errorType === 'bad_data') {
        try {
          parsePromQL(expr)
        } catch (e) {
          if (e instanceof PromQLSyntaxError) detail += `at ${e.position.line}:${e.position.column}:\n${caretText(expr, e)}`
        }
      }
      const fix =
        res.errorType === 'bad_data' ? 'Fix the expression (validate_query shows positions and near names) and run it again.'
        : res.errorType === 'timeout' ? 'Shorten the range, raise the step, or aggregate; nothing partial is returned for a timed-out query.'
        : res.status === 401 || res.status === 403 ? 'Use a key with the read scope.'
        : 'Retry; narrow the query if it keeps failing.'
      throw new ToolError('query-failed', `The query service did not answer the query (${res.errorType}).`, fix, { status: res.status === 401 || res.status === 403 ? res.status : res.errorType === 'bad_data' ? 400 : res.status >= 500 ? 502 : 422, detail })
    }
    const data: PromData = res.data
    const link = exploreLink(s.appUrl, expr, r, unit)
    const warnings = res.warnings.map((w) => clean(w, { max: MAX.error }))
    const pinned = pinRange(r)
    const base = {
      tool: this.name,
      s,
      args,
      maxTokens: budgetOf(args.max_tokens, this.defaultTokens),
      offset: c?.o ?? 0,
      pinned,
    }

    if (data.resultType === 'scalar' || data.resultType === 'string') {
      const v = data.result[1]
      return pagedResult({
        ...base,
        header: `query: ${data.resultType} result at ${isoOf(data.result[0])}; complete.\n`,
        items: [{ key: 'value', text: `value: ${data.resultType === 'string' ? cell(v) : formatNumber(Number(v))}\n`, data: { value: data.resultType === 'string' ? clean(v) : Number(v) } }],
        prelude: `link: ${link}\n`,
        meta: { resultType: data.resultType, complete: true, range: { start: r.start, end: r.end, step: r.step }, format },
        data: { link, warnings },
      })
    }

    // Vector or matrix.
    const all = data.result as { metric: Record<string, string>; values?: [number, string][]; value?: [number, string] }[]
    const total = all.length
    s.usage.series += total
    for (const x of all) s.usage.points += x.values ? x.values.length : 1
    let kept = all
    if (total > s.limits.maxSeries) {
      // Largest last values first: never silently truncate, say what was left out.
      const lastOf = (x: (typeof all)[number]) => Math.abs(Number(x.values ? x.values[x.values.length - 1]?.[1] : x.value?.[1]) || 0)
      kept = [...all].sort((a, b) => lastOf(b) - lastOf(a)).slice(0, s.limits.maxSeries)
    }
    const complete = kept.length === total && warnings.length === 0
    const completeness = kept.length < total
      ? `partial: ${kept.length} of ${total} series digested (largest last values); aggregate with sum by (...) or topk() for a complete answer`
      : warnings.length ? `complete, with ${warnings.length} warning(s) from the query service` : 'complete'
    const shaped = data.resultType === 'matrix' ? { resultType: 'matrix' as const, result: kept.map((x) => ({ metric: x.metric, values: x.values! })) } : { resultType: 'vector' as const, result: kept.map((x) => ({ metric: x.metric, value: x.value! })) }

    const prelude = `link: ${link}\n` + (warnings.length ? `warnings: ${warnings.join(' ; ')}\n` : '')
    const meta = { resultType: data.resultType, seriesTotal: total, seriesDigested: kept.length, complete, completeness, format, instant, range: { start: r.start, end: r.end, step: r.step } }

    if (format === 'digest') {
      const panel = { kind: 'timeseries' as const, title: 'query', description: '', unit: (unit ?? 'none') as 'none', queries: ['q'] }
      const d: PanelDigest = digestPanel(panel, shaped, { topK: kept.length, step: instant ? undefined : r.step, start: instant ? undefined : r.start, end: instant ? undefined : r.end })
      const rows = d.series.slice(0, topK)
      const rest = d.series.slice(topK)
      const items: Item[] = rows.map((x, i) => ({
        key: `s${i}`,
        text: `${cell(seriesName(x.labels))} | ${formatNumber(x.last)} | ${formatNumber(x.min)} | ${formatNumber(x.max)} | ${formatNumber(x.mean)} | ${trendText(x)} | ${notes(x)}\n`,
        data: { labels: cleanLabels(x.labels), last: x.last, min: x.min, max: x.max, mean: x.mean, points: x.points, trend: x.trend, outlier: x.outlier, z: x.z, gaps: x.gaps, ...(x.stale !== undefined ? { stale: x.stale } : {}) },
      }))
      if (rest.length) {
        const lasts = rest.map((x) => x.last).filter((v): v is number => v !== null)
        items.push({
          key: 'rest',
          text: `(${rest.length} more series: last values from ${formatNumber(Math.min(...lasts))} to ${formatNumber(Math.max(...lasts))}${rest.some((x) => x.outlier) ? `, ${rest.filter((x) => x.outlier).length} outlier(s)` : ''}; raise top_k or aggregate to see them)\n`,
          data: { more: rest.length, lastMin: lasts.length ? Math.min(...lasts) : null, lastMax: lasts.length ? Math.max(...lasts) : null },
        })
      }
      const header =
        `query: ${instant ? `instant at ${isoOf(r.end)}` : `range ${rangeText(r)}`}; ${total} series${total ? `, ${d.outliers} outlier(s)` : ''}; ${completeness}.\n` +
        (total === 0 ? 'No data: the query matched no series in this range. validate_query checks the names against this tenant.\n' : 'Columns: series | last | min | max | mean | trend | notes\n')
      return pagedResult({ ...base, header, items, prelude, meta, data: { link, warnings } })
    }

    if (format === 'table') {
      const buckets = instant ? 1 : Math.min(TABLE_BUCKETS, Math.max(1, Math.floor((r.end - r.start) / r.step) + 1))
      const width = (r.end - r.start) / buckets
      const edges = Array.from({ length: buckets }, (_, i) => r.start + width * (i + 1))
      const items: Item[] = shaped.result.map((x, i) => {
        const vals = new Array<number | null>(buckets).fill(null)
        if ('values' in x) {
          for (const [t, v] of x.values) {
            const b = Math.min(buckets - 1, Math.max(0, Math.floor((t - r.start) / width)))
            vals[b] = Number(v) // last sample in the bucket
          }
        } else vals[0] = Number(x.value[1])
        return { key: `s${i}`, text: `${cell(seriesName(x.metric))}\t${vals.map((v) => formatNumber(v)).join('\t')}\n`, data: { labels: cleanLabels(x.metric), values: vals } }
      })
      const header = `query: table, ${total} series × ${buckets} bucket(s) of ${formatDuration(Math.round(width))} (last sample in each); ${completeness}.\nColumns: series then bucket end times ${edges.map((e) => isoOf(Math.round(e))).join(' ')}\n`
      return pagedResult({ ...base, header, items, prelude, meta, data: { link, warnings, bucketEnds: edges.map((e) => Math.round(e)) } })
    }

    // series: every point, paged in chunks.
    const items: Item[] = []
    shaped.result.forEach((x, i) => {
      const pts: [number, string][] = 'values' in x ? x.values : [x.value]
      for (let j = 0; j < Math.max(1, pts.length); j += SERIES_CHUNK) {
        const chunk = pts.slice(j, j + SERIES_CHUNK)
        items.push({
          key: `s${i}:${j}`,
          text: `${cell(seriesName(x.metric))} [${j}..${j + chunk.length - 1}]: ${chunk.map(([t, v]) => `${t}=${v}`).join(' ')}\n`,
          data: { series: i, labels: cleanLabels(x.metric), from: j, points: chunk.map(([t, v]) => [t, Number(v)]) },
        })
      }
    })
    const header = `query: raw points, ${total} series, ${items.length} chunk(s) of up to ${SERIES_CHUNK} points (Unix seconds=value); ${completeness}.\n`
    return pagedResult({ ...base, header, items, prelude, meta, data: { link, warnings } })
  },
}
