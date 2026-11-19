/**
 * Tempo's and Loki's HTTP APIs: paths, parameters and defaults, as their documentation states
 * them (read 2026-11-19; `CLEANROOM.md` lists the pages). Behind `QUERY_SIGNALS`.
 *
 * Tempo (grafana.com/docs/tempo/latest/api_docs/): bodies as Tempo answers them (no envelope),
 * errors as plain text. Loki (grafana.com/docs/loki/latest/reference/loki-http-api/):
 * `{"status":"success","data":…}`, errors in the same envelope as the Prometheus API.
 */
import { ApiError } from './coordinator'
import type { Route } from './index'
import { NS_PER_S, count, defaultStep, duration, lokiTime, nowNs, tempoMetricsTime, tempoSeconds, traceIdParam } from './sigparams'
import { logLabels, logQuery, traceById, traceMetrics, traceSearch, traceTagValues, traceTags } from './signals'

const HOUR = 3600n * NS_PER_S

const opt = (params: URLSearchParams, name: string): string | null => {
  const v = params.get(name)
  return v === null || v === '' ? null : v
}

/** Tempo's `start`/`end` (seconds) for search, tags and trace by ID; without them, the last hour (viz's choice: Tempo then searches its live store only). */
function tempoWindow(params: URLSearchParams): { start: bigint; end: bigint } {
  const s = opt(params, 'start')
  const e = opt(params, 'end')
  const end = e === null ? nowNs() : tempoSeconds('end', e)
  const start = s === null ? end - HOUR : tempoSeconds('start', s)
  if (end < start) throw new ApiError('bad_data', 'invalid parameters: end is before start')
  return { start: start < 0n ? 0n : start, end }
}

/** The metrics API's range: `start` and `end`, or `since` (default one hour) before now. */
function metricsWindow(params: URLSearchParams): { start: bigint; end: bigint } {
  const s = opt(params, 'start')
  const e = opt(params, 'end')
  if (s !== null || e !== null) {
    if (s === null || e === null) throw new ApiError('bad_data', 'invalid parameters: start and end go together')
    const start = tempoMetricsTime('start', s)
    const end = tempoMetricsTime('end', e)
    if (end <= start) throw new ApiError('bad_data', 'invalid parameters: end must be after start')
    return { start, end }
  }
  const since = opt(params, 'since')
  const end = nowNs()
  const start = end - (since === null ? HOUR : duration('since', since))
  return { start: start < 0n ? 0n : start, end }
}

const traceByIdHandler =
  (version: 1 | 2): Route['handler'] =>
  async (c, params, label) => {
    for (const p of ['q', 'span_pruning', 'span_pruning_group_by', 'span_pruning_min_spans', 'span_pruning_max_parent_depth', 'keep_hierarchy', 'match_depth', 'ancestor_depth']) {
      const v = opt(params, p)
      if (v !== null && !(p === 'span_pruning' && v === 'false')) throw new ApiError('unsupported', `the ${p} parameter is not supported; the whole trace is returned without it`)
    }
    const id = traceIdParam(label)
    const s = opt(params, 'start')
    const e = opt(params, 'end')
    const json = await traceById(c, id, version, s === null ? null : tempoSeconds('start', s), e === null ? null : tempoSeconds('end', e) + NS_PER_S - 1n)
    if (json === null) throw new ApiError('not_found', 'trace not found')
    return json
  }

const search: Route['handler'] = async (c, params) => {
  for (const p of ['tags', 'minDuration', 'maxDuration']) {
    if (opt(params, p) !== null) throw new ApiError('unsupported', `tag-based search (${p}) is not supported; use a TraceQL query in q`)
  }
  const { start, end } = tempoWindow(params)
  return traceSearch(c, { query: opt(params, 'q') ?? '{ }', startNs: start, endNs: end, limit: count(params, 'limit', 20, 100_000), spss: count(params, 'spss', 3, 100_000) })
}

const tags =
  (version: 1 | 2): Route['handler'] =>
  async (c, params) => {
    const { start, end } = tempoWindow(params)
    return traceTags(c, version, opt(params, 'scope') ?? '', start, end, count(params, 'limit', 0, 1_000_000))
  }

const tagValues =
  (version: 1 | 2): Route['handler'] =>
  async (c, params, label) => {
    const { start, end } = tempoWindow(params)
    return traceTagValues(c, version, label, version === 2 ? (opt(params, 'q') ?? '') : '', start, end, count(params, 'limit', 0, 1_000_000))
  }

const metrics =
  (instant: boolean): Route['handler'] =>
  async (c, params) => {
    const q = opt(params, 'q')
    if (q === null) throw new ApiError('bad_data', 'missing parameter q')
    const { start, end } = metricsWindow(params)
    const st = opt(params, 'step')
    const step = instant ? end - start : st === null ? defaultStep(start, end) : duration('step', st)
    if (step <= 0n) throw new ApiError('bad_data', 'invalid parameter "step": must be positive')
    if (!instant && (end - start) / step > BigInt(c.limits.maxSteps)) throw new ApiError('bad_data', `exceeded maximum resolution of ${c.limits.maxSteps} points per timeseries. Try increasing the value of the step parameter`)
    return traceMetrics(c, { query: q, instant, startNs: start, endNs: end, stepNs: step })
  }

const decode = (s: string): string | null => {
  try {
    return decodeURIComponent(s)
  } catch {
    return null
  }
}

/** Tempo's paths, or null. */
export function tempoRoute(path: string): Route | null {
  const t = (handler: Route['handler'], label = ''): Route => ({ handler, methods: ['GET'], label, dialect: 'tempo' })
  switch (path) {
    case '/api/search':
      return t(search)
    case '/api/search/tags':
      return t(tags(1))
    case '/api/v2/search/tags':
      return t(tags(2))
    case '/api/metrics/query_range':
      return t(metrics(false))
    case '/api/metrics/query':
      return t(metrics(true))
  }
  let m = /^\/api\/(v2\/)?traces\/([^/]+)$/.exec(path)
  if (m) {
    const id = decode(m[2]!)
    return id === null ? null : t(traceByIdHandler(m[1] ? 2 : 1), id)
  }
  m = /^\/api\/(v2\/)?search\/tag\/([^/]+)\/values$/.exec(path)
  if (m) {
    const tag = decode(m[2]!)
    return tag === null ? null : t(tagValues(m[1] ? 2 : 1), tag)
  }
  return null
}

// ─────────────────────────────────── Loki ───────────────────────────────────

/** `start`/`end`/`since` of the Loki API; `back` is how far before `end` a missing `start` lies. */
function lokiWindow(params: URLSearchParams, back: bigint): { start: bigint; end: bigint } {
  const e = opt(params, 'end')
  const end = e === null ? nowNs() : lokiTime('end', e)
  const s = opt(params, 'start')
  const since = opt(params, 'since')
  const start = s !== null ? lokiTime('start', s) : end - (since === null ? back : duration('since', since))
  if (end < start) throw new ApiError('bad_data', 'end timestamp must not be before or equal to start time')
  return { start: start < 0n ? 0n : start, end }
}

function direction(params: URLSearchParams): 'forward' | 'backward' {
  const d = opt(params, 'direction') ?? 'backward'
  if (d !== 'forward' && d !== 'backward') throw new ApiError('bad_data', `invalid parameter "direction": ${JSON.stringify(d.slice(0, 20))}, forward or backward`)
  return d
}

const lokiRange: Route['handler'] = async (c, params) => {
  const query = opt(params, 'query')
  if (query === null) throw new ApiError('bad_data', 'missing parameter query')
  if (opt(params, 'interval') !== null) throw new ApiError('unsupported', 'the interval parameter is not supported')
  const { start, end } = lokiWindow(params, HOUR)
  const st = opt(params, 'step')
  const step = st === null ? defaultStep(start, end) : duration('step', st)
  if (step <= 0n) throw new ApiError('bad_data', 'zero or negative query resolution step widths are not accepted. Try a positive integer')
  return logQuery(c, { query, kind: 'range', startNs: start, endNs: end, stepNs: step, limit: count(params, 'limit', 100, 100_000), direction: direction(params) })
}

const lokiInstant: Route['handler'] = async (c, params) => {
  const query = opt(params, 'query')
  if (query === null) throw new ApiError('bad_data', 'missing parameter query')
  const t = opt(params, 'time')
  const time = t === null ? nowNs() : lokiTime('time', t)
  return logQuery(c, { query, kind: 'instant', startNs: time, endNs: time, stepNs: 1n, limit: count(params, 'limit', 100, 100_000), direction: direction(params) })
}

const lokiLabels =
  (kind: 'names' | 'values'): Route['handler'] =>
  async (c, params, label) => {
    const { start, end } = lokiWindow(params, 6n * HOUR)
    const q = opt(params, 'query')
    return logLabels(c, kind, label, q === null ? [] : [q], start, end)
  }

const lokiSeries: Route['handler'] = async (c, params) => {
  const match = params.getAll('match[]').filter((m) => m !== '')
  if (match.length === 0) throw new ApiError('bad_data', 'at least one match[] argument must be provided')
  const { start, end } = lokiWindow(params, 6n * HOUR)
  return logLabels(c, 'series', '', match, start, end)
}

/** Loki's paths, or null. */
export function lokiRoute(path: string): Route | null {
  const l = (handler: Route['handler'], label = ''): Route => ({ handler, methods: ['GET', 'POST'], label, dialect: 'prometheus' })
  switch (path) {
    case '/loki/api/v1/query_range':
      return l(lokiRange)
    case '/loki/api/v1/query':
      return l(lokiInstant)
    case '/loki/api/v1/labels':
      return l(lokiLabels('names'))
    case '/loki/api/v1/series':
      return l(lokiSeries)
  }
  const m = /^\/loki\/api\/v1\/label\/([^/]+)\/values$/.exec(path)
  if (!m) return null
  const name = decode(m[1]!)
  return name === null ? null : l(lokiLabels('values'), name)
}
