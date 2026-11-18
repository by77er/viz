import { CURSOR_ARG, MAX_TOKENS_ARG, TIME_ARG } from '../args'
import { budgetOf, type Item } from '../page'
import { didYouMean } from '../suggest'
import { mapBounded, type Session } from '../session'
import { type ToolDef, ToolError, pagedResult } from '../tool'
import { cell, clean, MAX } from '../untrusted'
import { cursorOf, inferType, inferUnit, rangeOf, rangeText } from './common'

/** Labels whose values name things an agent asks about by name: services, jobs, nodes. */
const ENTITY_LABELS = ['service', 'job', 'app', 'application', 'namespace', 'component', 'cluster', 'node', 'cell', 'pod', 'instance', 'peer_service', 'env', 'environment']

const NAME_ARG = { type: 'string', minLength: 1, maxLength: 200, description: 'Metric name, exactly as stored, e.g. "http_server_requests_total".' } as const

interface LabelStats {
  /** label name → value → series count */
  values: Map<string, Map<string, number>>
  series: number
}

function labelStats(series: Record<string, string>[]): LabelStats {
  const values = new Map<string, Map<string, number>>()
  for (const s of series) {
    for (const [k, v] of Object.entries(s)) {
      if (k === '__name__') continue
      let m = values.get(k)
      if (!m) values.set(k, (m = new Map()))
      m.set(v, (m.get(v) ?? 0) + 1)
    }
  }
  return { values, series: series.length }
}

type Meta = Record<string, { type: string; help: string; unit: string }[]>

async function metadataOf(s: Session, metric?: string): Promise<Meta> {
  s.usage.upstreamCalls++
  const r = await s.query.metadata(metric)
  return r.ok && r.data && typeof r.data === 'object' ? r.data : {}
}

// ---- search_telemetry ----

export const searchTelemetry: ToolDef = {
  name: 'search_telemetry',
  title: 'Search telemetry',
  description:
    'Find metrics by name, help text or the things they describe (a service, job, node or cluster name). Returns per metric: type (counter, gauge, histogram; inferred from the name when the store has no metadata), unit, help, series count in the last hour, and label names with their number of distinct values. Also lists entity label values that match (e.g. service="checkout") with the metrics that carry them. Metrics only: traces and logs are not available yet. Start here, then describe_metric.',
  scopes: ['read'],
  defaultTokens: 1000,
  readOnly: true,
  input: {
    type: 'object',
    additionalProperties: false,
    required: ['q'],
    properties: {
      q: { type: 'string', minLength: 1, maxLength: 200, description: 'Words to look for, e.g. "checkout errors" or "http request duration".' },
      signal: { type: 'string', enum: ['metrics', 'traces', 'logs'], default: 'metrics', description: 'Which signal to search. Only "metrics" is available yet.' },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 20, description: 'Most metrics to return in all pages.' },
      max_tokens: MAX_TOKENS_ARG(1000),
      cursor: CURSOR_ARG,
    },
  },
  async run(s, args) {
    const c = cursorOf(this.name, args)
    if ((args.signal ?? 'metrics') !== 'metrics') {
      throw new ToolError('not-available-yet', `Searching ${String(args.signal)} is not available yet; only metrics are.`, 'Search with signal "metrics".', { status: 501 })
    }
    const q = String(args.q)
    const limit = (args.limit as number | undefined) ?? 20
    const words = q.toLowerCase().split(/[\s_.:{}(),"'=]+/).filter((w) => w.length > 0)
    const [names, meta, labelNames] = await Promise.all([s.metricNames(), metadataOf(s), (async () => {
      s.usage.upstreamCalls++
      const r = await s.query.labelNames([], { start: Math.floor(s.now / 1000) - 3600, end: Math.floor(s.now / 1000) })
      return r.ok ? r.data : []
    })()])

    // Rank metric names: every word found counts; whole name parts count more; help text a little.
    const scored: { name: string; score: number }[] = []
    for (const name of names) {
      const lname = name.toLowerCase()
      const parts = new Set(lname.split(/[_:]/))
      const help = (meta[name]?.[0]?.help ?? '').toLowerCase()
      let score = 0
      for (const w of words) {
        if (parts.has(w)) score += 3
        else if (lname.includes(w)) score += 2
        else if (help.includes(w)) score += 1
      }
      if (score > 0) scored.push({ name, score })
    }
    scored.sort((a, b) => b.score - a.score || a.name.length - b.name.length || a.name.localeCompare(b.name))
    // Nothing matched: offer near spellings from this tenant's own names.
    const near = scored.length === 0 ? didYouMean(q.replace(/\s+/g, '_'), names, 5) : []

    // Entity values: "checkout" is a service, not a metric.
    const entityLabels = labelNames.filter((l) => ENTITY_LABELS.includes(l))
    const entityHits: { label: string; value: string; metrics: string[] }[] = []
    if (c === null || c.o === 0) {
      const vals = await mapBounded(entityLabels, s.limits.maxParallel, s.deadline, async (l) => {
        s.usage.upstreamCalls++
        const r = await s.query.labelValues(l, [], { start: Math.floor(s.now / 1000) - 3600, end: Math.floor(s.now / 1000) })
        return r.ok ? r.data.filter((v) => words.some((w) => w.length >= 3 && v.toLowerCase().includes(w))).slice(0, 5).map((v) => ({ label: l, value: v })) : []
      })
      const hits = vals.flatMap((v) => (v.ok ? v.value : [])).slice(0, 10)
      const carried = await mapBounded(hits, s.limits.maxParallel, s.deadline, async (h) => {
        s.usage.upstreamCalls++
        const r = await s.query.labelValues('__name__', [`{${h.label}=${JSON.stringify(h.value)}}`], { start: Math.floor(s.now / 1000) - 3600, end: Math.floor(s.now / 1000) })
        return r.ok ? r.data : []
      })
      hits.forEach((h, i) => entityHits.push({ ...h, metrics: carried[i]!.ok ? (carried[i] as { value: string[] }).value : [] }))
    }

    const ranked = scored.slice(0, limit).map((x) => x.name)
    const offset = c?.o ?? 0
    // Describe the metrics that can appear on this page (one series call each, bounded).
    const window = ranked.slice(offset, offset + Math.min(limit, s.limits.maxDescribed))
    const end = Math.floor(s.now / 1000)
    const details = await mapBounded(window, s.limits.maxParallel, s.deadline, async (name) => {
      s.usage.upstreamCalls++
      const r = await s.query.series([`{__name__=${JSON.stringify(name)}}`], { start: end - 3600, end })
      return r.ok ? labelStats(r.data) : null
    })

    const items: Item[] = []
    // Entity hits are part of the first page only; they are not counted in the cursor offset.
    const entityText = entityHits.map((h) => `${cell(h.label, MAX.name)}=${cell(h.value)} is on ${h.metrics.length} metric(s): ${h.metrics.slice(0, 8).map((m) => cell(m, MAX.name)).join(', ')}${h.metrics.length > 8 ? ', …' : ''}\n`).join('')
    for (let i = 0; i < ranked.length; i++) {
      const name = ranked[i]!
      const m = meta[name]?.[0]
      const t = inferType(name, m)
      const unit = inferUnit(name, m)
      const d = i >= offset && i < offset + window.length ? details[i - offset] : undefined
      const st = d?.ok ? d.value : null
      const labels = st ? [...st.values.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => [k, v.size] as const) : []
      const text =
        `${cell(name, MAX.name)} | ${t.type}${t.source === 'name' ? ' (from name)' : ''} | unit ${cell(unit, 20)} | ` +
        (st ? `${st.series} series | labels ${labels.slice(0, 12).map(([k, n]) => `${cell(k, MAX.name)}(${n})`).join(' ')}${labels.length > 12 ? ' …' : ''}` : 'series not counted') +
        (m?.help ? ` | ${cell(m.help, 160)}` : '') +
        '\n'
      items.push({
        key: name,
        text,
        data: { name: clean(name, { max: MAX.name }), type: t.type, typeSource: t.source, unit: clean(unit, { max: 20 }), help: m?.help ? clean(m.help, { max: MAX.text }) : null, series: st?.series ?? null, labels: Object.fromEntries(labels.map(([k, n]) => [clean(k, { max: MAX.name }), n])) },
      })
    }
    const header =
      `search_telemetry: ${scored.length} matching metric(s)${scored.length > limit ? `, the best ${limit} listed` : ''}; ${entityHits.length} matching entity value(s).` +
      (scored.length === 0 ? ` No metric name contains these words${near.length ? '; near spellings are listed' : ''}.` : '') +
      '\nColumns: name | type | unit | series in the last hour | labels (distinct values) | help\n'
    const prelude = (entityText ? `Entities:\n${entityText}` : '') + (near.length ? `Did you mean: ${near.map((n) => cell(n, MAX.name)).join(', ')}\n` : '') + (items.length && entityText ? 'Metrics:\n' : '')
    return pagedResult({
      tool: this.name,
      s,
      args,
      maxTokens: budgetOf(args.max_tokens, this.defaultTokens),
      header,
      items,
      offset,
      prelude: offset === 0 ? prelude : '',
      meta: { matches: scored.length },
      data: { entities: entityHits.map((h) => ({ label: clean(h.label, { max: MAX.name }), value: clean(h.value, { max: MAX.label }), metrics: h.metrics.slice(0, 50).map((m) => clean(m, { max: MAX.name })) })), didYouMean: near.map((n) => clean(n, { max: MAX.name })) },
    })
  },
}

// ---- describe_metric ----

function exampleQueries(name: string, type: string, labels: string[]): string[] {
  const by = labels.find((l) => ['service', 'job', 'route', 'handler', 'status', 'code', 'node', 'pod', 'cell'].includes(l)) ?? labels[0]
  const grp = by ? ` by (${by})` : ''
  if (type === 'histogram' || name.endsWith('_bucket')) {
    const base = name.replace(/_bucket$/, '')
    return [`histogram_quantile(0.95, sum by (le) (rate(${base}_bucket[5m])))`, `sum${grp} (rate(${base}_count[5m]))`]
  }
  if (type === 'counter') return [`sum${grp} (rate(${name}[5m]))`, `sum${grp} (increase(${name}[1h]))`]
  return [`avg${grp} (${name})`, `max_over_time(${name}[1h])`]
}

export const describeMetric: ToolDef = {
  name: 'describe_metric',
  title: 'Describe a metric',
  description:
    'Everything needed to query one metric: type and unit (inferred from the name when the store has no metadata), help, series count over the range (default the last hour), every label with its number of distinct values and the top values by series count, a few sample series, and example PromQL. An unknown name returns near spellings from this tenant\'s own metric names.',
  scopes: ['read'],
  defaultTokens: 1000,
  readOnly: true,
  input: {
    type: 'object',
    additionalProperties: false,
    required: ['name'],
    properties: {
      name: NAME_ARG,
      top_values: { type: 'integer', minimum: 1, maximum: 20, default: 5, description: 'Values listed per label, most series first.' },
      from: TIME_ARG('Start of the range', 'now-1h'),
      to: TIME_ARG('End of the range', 'now'),
      max_tokens: MAX_TOKENS_ARG(1000),
      cursor: CURSOR_ARG,
    },
  },
  async run(s, args) {
    const c = cursorOf(this.name, args)
    const name = String(args.name)
    const r = rangeOf(s, args, c)
    s.usage.upstreamCalls++
    const res = await s.query.series([`{__name__=${JSON.stringify(name)}}`], { start: r.start, end: r.end })
    if (!res.ok) {
      throw new ToolError('query-failed', `The query service could not list the series (${res.errorType}).`, 'Check the name with search_telemetry, or retry.', { status: res.status === 401 || res.status === 403 ? res.status : 502, detail: `error: ${clean(res.error, { max: MAX.error })}` })
    }
    if (res.data.length === 0) {
      const names = await s.metricNames()
      if (!names.includes(name)) {
        const near = didYouMean(name, names, 5)
        throw new ToolError('unknown-metric', 'This tenant has no metric of that name.', near.length ? 'Use one of the near spellings listed, or search_telemetry.' : 'Use search_telemetry to find the metric.', {
          status: 404,
          detail: `name: ${clean(name, { max: MAX.name })}\n` + (near.length ? `did you mean: ${near.map((n) => clean(n, { max: MAX.name })).join(', ')}\n` : ''),
          data: { didYouMean: near.map((n) => clean(n, { max: MAX.name })) },
        })
      }
    }
    const meta = (await metadataOf(s, name))[name]?.[0]
    const st = labelStats(res.data)
    s.usage.series += st.series
    const t = inferType(name, meta)
    const unit = inferUnit(name, meta)
    const top = (args.top_values as number | undefined) ?? 5
    const labels = [...st.values.entries()].sort((a, b) => a[1].size - b[1].size || a[0].localeCompare(b[0]))
    const examples = exampleQueries(name, t.type, labels.map(([k]) => k))
    const sample = res.data.slice(0, 3).map((x) => Object.entries(x).filter(([k]) => k !== '__name__').map(([k, v]) => `${cell(k, MAX.name)}=${JSON.stringify(cell(v))}`).join(','))

    const items: Item[] = labels.map(([k, vals]) => {
      const sorted = [...vals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      return {
        key: k,
        text: `label ${cell(k, MAX.name)}: ${vals.size} value(s); top: ${sorted.slice(0, top).map(([v, n]) => `${JSON.stringify(cell(v))} (${n})`).join(', ')}${vals.size > top ? ', …' : ''}\n`,
        data: { label: clean(k, { max: MAX.name }), distinct: vals.size, top: sorted.slice(0, top).map(([v, n]) => ({ value: clean(v, { max: MAX.label }), series: n })) },
      }
    })
    const header = `describe_metric: ${st.series} series over ${rangeText(r)}; ${labels.length} label(s); type ${t.type}${t.source === 'name' ? ' (inferred from the name)' : ''}.\n`
    const prelude =
      (c ? '' :
        `name: ${cell(name, MAX.name)}\nunit: ${cell(unit, 20)}\n` +
        (meta?.help ? `help: ${cell(meta.help)}\n` : '') +
        `examples: ${examples.map((e) => clean(e, { kind: 'expr', max: MAX.text })).join('  ;  ')}\n` +
        (sample.length ? `sample series: ${sample.map((x) => `{${x}}`).join('  ')}\n` : '') +
        (st.series === 0 ? 'no series in this range; widen from/to.\n' : ''))
    return pagedResult({
      tool: this.name,
      s,
      args,
      maxTokens: budgetOf(args.max_tokens, this.defaultTokens),
      header,
      items,
      offset: c?.o ?? 0,
      prelude,
      pinned: { s: r.start, e: r.end, st: r.step },
      meta: { series: st.series, type: t.type, typeSource: t.source, range: { start: r.start, end: r.end } },
      data: { name: clean(name, { max: MAX.name }), unit: clean(unit, { max: 20 }), help: meta?.help ? clean(meta.help) : null, examples: examples.map((e) => clean(e, { kind: 'expr', max: MAX.text })) },
    })
  },
}
