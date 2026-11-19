/**
 * fromGrafana(json): import a classic Grafana dashboard (schemaVersion ≤ 41,
 * the `panels` + `templating` + `gridPos` model) into `viz.dashboard/v1`.
 *
 * Nothing is dropped silently: whatever cannot be represented produces a
 * warning that names the panel or variable.
 */
import { BUILTIN_VARIABLES, findVariables } from './expr.ts'
import { hasOwn, isObject, slugId } from './json.ts'
import { DURATION_PATTERN, TIME_PATTERN } from './schema.ts'
import { API_VERSION, UNITS } from './types.ts'
import type { Dashboard, GridItem, Layout, Level, Panel, Query, QueryLang, Reducer, Row, Threshold, Unit, ValidationError, Variable } from './types.ts'
import { validate } from './validate.ts'

export interface ImportWarning {
  code: string
  message: string
}
export interface ImportResult {
  spec: Dashboard
  warnings: ImportWarning[]
  /** Validation errors of the produced spec. Empty unless the importer has a bug or the input is degenerate. */
  errors: ValidationError[]
}

const UNIT_MAP: Record<string, Unit> = {
  none: 'none', short: 'none', '': 'none',
  percent: 'percent', percentunit: 'ratio',
  s: 's', ms: 'ms', µs: 'us', us: 'us', ns: 'ns', dtdurations: 's', dtdurationms: 'ms',
  bytes: 'bytes', decbytes: 'bytes', bits: 'bits', decbits: 'bits',
  Bps: 'bytes/s', binBps: 'bytes/s', bps: 'bits/s', binbps: 'bits/s',
  reqps: 'req/s', rps: 'req/s', ops: 'ops/s', opm: 'ops/s', eps: 'events/s', rowsps: 'rows/s', cps: 'count',
  celsius: 'celsius', currencyUSD: 'usd',
}
const REDUCE_MAP: Record<string, Reducer> = { last: 'last', lastNotNull: 'last', mean: 'mean', min: 'min', max: 'max', sum: 'sum', total: 'sum' }
const GLOBALS: Record<string, string> = { __rate_interval: '__rate', __interval: '__interval', __range: '__range', __auto_interval: '__interval' }
const DURATION = new RegExp(DURATION_PATTERN)
const TIME = new RegExp(TIME_PATTERN)

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const obj = (v: unknown): Record<string, unknown> => (isObject(v) ? v : {})

function uniqueId(base: string, taken: Set<string>): string {
  let id = base
  for (let n = 2; taken.has(id); n++) {
    const suffix = `_${n}`
    id = base.slice(0, 48 - suffix.length) + suffix
  }
  taken.add(id)
  return id
}

export function fromGrafana(input: unknown): ImportResult {
  const warnings: ImportWarning[] = []
  const warn = (code: string, message: string) => warnings.push({ code, message })
  const root = obj(input)
  const g = isObject(root.dashboard) && !Array.isArray(root.panels) ? root.dashboard : root

  const title = str(g.title) ?? 'Imported dashboard'
  const description = str(g.description)
  if (!description) warn('missing-intent', 'The Grafana dashboard has no description; "metadata.intent" is a TODO placeholder. Say what question the dashboard answers and for whom.')
  const spec: Dashboard = {
    apiVersion: API_VERSION,
    metadata: {
      id: slugId(str(g.uid) ?? title, 'd'),
      title: title.slice(0, 120),
      intent: (description ?? `TODO: say what question "${title}" answers and for whom. Imported from Grafana.`).slice(0, 600),
    },
    panels: {},
    layout: { kind: 'grid', items: [] },
  }
  const tags = [...new Set(arr(g.tags).map((t) => String(t).toLowerCase().replace(/[^a-z0-9_.:-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 40)).filter(Boolean))].slice(0, 16)
  if (tags.length) spec.metadata.tags = tags

  const time = obj(g.time)
  const from = str(time.from)
  const to = str(time.to)
  if (from && to) {
    if (TIME.test(from) && TIME.test(to)) {
      spec.time = { from, to }
      const refresh = str(g.refresh)
      if (refresh && DURATION.test(refresh)) spec.time.refresh = refresh
    } else warn('time-range', `Time range "${from}" → "${to}" uses a form that is not supported (only now, now-<duration> and RFC 3339); dropped.`)
  }

  // ---- variables ----
  const variables: Record<string, Variable> = {}
  const varNames = new Map<string, string>() // Grafana name → id
  const taken = new Set<string>()
  const pending: { id: string; expr: string }[] = []
  for (const raw of arr(obj(g.templating).list)) {
    const v = obj(raw)
    const name = str(v.name)
    if (!name) continue
    const type = String(v.type)
    if (type === 'datasource' || type === 'adhoc' || type === 'groupby' || type === 'switch') {
      warn('unsupported-variable', `Variable "${name}" of type "${type}" has no equivalent and was dropped${type === 'datasource' ? ' (viz dashboards query the tenant\'s own data; no datasource choice is needed)' : ''}.`)
      continue
    }
    const id = uniqueId(slugId(name, 'v'), taken)
    if (id !== name) warn('renamed-variable', `Variable "${name}" was renamed to "${id}" (ids are lowercase); references in queries were rewritten.`)
    varNames.set(name, id)
    const common: { label?: string; description?: string } = {}
    const label = str(v.label)
    if (label) common.label = label.slice(0, 60)
    const desc = str(v.description)
    if (desc) common.description = desc.slice(0, 300)
    const cur = obj(v.current).value
    const curList = (Array.isArray(cur) ? cur : cur === undefined || cur === null ? [] : [cur]).map((x) => (x === '$__all' ? '*' : String(x))).filter((x) => x !== '')
    const multi = v.multi === true
    const includeAll = v.includeAll === true
    const optionValues = arr(v.options).map((o) => String(obj(o).value ?? '')).filter((x) => x && x !== '$__all')
    const csv = typeof v.query === 'string' ? v.query.split(',').map((s) => s.trim()).filter(Boolean) : []

    if (type === 'query') {
      const expr = str(v.query) ?? str(obj(v.query).query) ?? str(v.definition)
      if (!expr) {
        warn('unsupported-variable', `Query variable "${name}" has no query text and was dropped.`)
        varNames.delete(name)
        continue
      }
      const out: Variable = { kind: 'query', ...common, query: { lang: 'promql', expr } }
      if (multi) out.multi = true
      if (includeAll) out.includeAll = true
      if (curList.length) out.default = multi ? curList.slice(0, 200) : curList[0]!
      if (str(v.regex)) warn('variable-regex', `Variable "${name}" filters its values with regex ${JSON.stringify(v.regex)}; that filter was dropped.`)
      variables[id] = out
      pending.push({ id, expr })
    } else if (type === 'custom') {
      const values = [...new Set(optionValues.length ? optionValues : csv)].slice(0, 200)
      if (!values.length) {
        warn('unsupported-variable', `Custom variable "${name}" has no values and was dropped.`)
        varNames.delete(name)
        continue
      }
      const out: Variable = { kind: 'enum', ...common, values }
      if (multi) out.multi = true
      if (includeAll) out.includeAll = true
      const defaults = curList.filter((c) => values.includes(c) || (c === '*' && includeAll))
      if (defaults.length) out.default = multi ? defaults : defaults[0]!
      variables[id] = out
    } else if (type === 'interval') {
      const all = optionValues.length ? optionValues : csv
      const values = [...new Set(all.filter((x) => DURATION.test(x)))].slice(0, 32)
      if (values.length < all.length) warn('variable-values', `Interval variable "${name}": non-duration options (${all.filter((x) => !DURATION.test(x)).join(', ')}) were dropped; use $__interval for an automatic step.`)
      if (!values.length) values.push('1m')
      const out: Variable = { kind: 'interval', ...common, values }
      if (curList[0] && values.includes(curList[0])) out.default = curList[0]
      variables[id] = out
    } else if (type === 'textbox' || type === 'constant') {
      const out: Variable = { kind: 'text', ...common }
      const def = curList[0] ?? str(v.query)
      if (def !== undefined) out.default = def.slice(0, 200)
      variables[id] = out
    } else {
      warn('unsupported-variable', `Variable "${name}" has unknown type "${type}" and was dropped.`)
      varNames.delete(name)
    }
  }

  /** Rewrite Grafana variable syntax to ours. Returns the names that could not be mapped. */
  const rewrite = (expr: string): { expr: string; unknown: string[] } => {
    const unknown: string[] = []
    let e = expr.replace(/\[\[([A-Za-z_][A-Za-z0-9_]*)(?::[A-Za-z0-9_]*)?\]\]/g, '${$1}')
    const refs = findVariables(e)
    for (let i = refs.length - 1; i >= 0; i--) {
      const r = refs[i]!
      const mapped = GLOBALS[r.name] ?? varNames.get(r.name)
      if (mapped === undefined) {
        unknown.push(r.name)
        continue
      }
      const braces = e[r.start + 1] === '{' || /[A-Za-z0-9_]/.test(e[r.end] ?? '')
      e = e.slice(0, r.start) + (braces ? `\${${mapped}}` : `$${mapped}`) + e.slice(r.end)
    }
    return { expr: e, unknown: [...new Set(unknown)].filter((n) => !hasOwn(BUILTIN_VARIABLES, n)) }
  }
  for (const p of pending) {
    const r = rewrite(p.expr)
    const v = variables[p.id]
    if (v?.kind !== 'query') continue
    if (r.unknown.length) {
      warn('unsupported-variable', `Variable "${p.id}" references ${r.unknown.map((u) => '$' + u).join(', ')}, which could not be imported; the variable was dropped.`)
      delete variables[p.id]
      for (const [k, id] of varNames) if (id === p.id) varNames.delete(k)
    } else v.query.expr = r.expr.slice(0, 2000)
  }

  // ---- panels ----
  const queries: Record<string, Query> = {}
  const panelIds = new Set<string>()
  const queryIds = new Set<string>()
  const noDescription: string[] = []
  interface Section {
    title?: string
    items: GridItem[]
  }
  const sections: Section[] = [{ items: [] }]
  let autoY = 0

  const convertPanel = (raw: unknown, section: Section): void => {
    const p = obj(raw)
    const type = String(p.type)
    const pTitle = str(p.title) ?? `Panel ${String(p.id ?? '')}`.trim()
    const where = `Panel "${pTitle}" (${type})`
    const KIND: Record<string, Panel['kind']> = {
      timeseries: 'timeseries', graph: 'timeseries',
      stat: 'stat', singlestat: 'stat', gauge: 'stat', bargauge: 'stat',
      table: 'table', 'table-old': 'table',
      heatmap: 'heatmap', text: 'text',
    }
    const kind = hasOwn(KIND, type) ? KIND[type]! : undefined
    if (!kind) {
      warn('unsupported-panel', `${where} has no equivalent panel kind and was not imported.`)
      return
    }
    if (type === 'gauge' || type === 'bargauge' || type === 'singlestat') warn('approximated-panel', `${where} was imported as a "stat" panel.`)
    const id = uniqueId(slugId(pTitle, 'p'), panelIds)
    const descr = str(p.description)
    const options = obj(p.options)
    const defaults = obj(obj(p.fieldConfig).defaults)

    let panel: Panel
    if (kind === 'text') {
      const content = str(options.content) ?? str(p.content) ?? ''
      if (!content) {
        panelIds.delete(id)
        warn('empty-panel', `${where} has no content and was not imported.`)
        return
      }
      if ((options.mode ?? p.mode) === 'html') warn('text-html', `${where} is HTML; it is kept as text but viz renders Markdown only.`)
      panel = { kind: 'text', title: pTitle.slice(0, 120), content: content.slice(0, 8000) }
      if (descr) panel.description = descr.slice(0, 600)
    } else {
      const max = { timeseries: 8, stat: 4, table: 12, heatmap: 1 }[kind]
      const ids: string[] = []
      for (const rawTarget of arr(p.targets)) {
        const t = obj(rawTarget)
        const ref = str(t.refId) ?? String(ids.length + 1)
        const dsType = str(obj(t.datasource).type) ?? str(obj(p.datasource).type)
        const exprRaw = str(t.expr)
        if (!exprRaw) {
          warn('unsupported-target', `${where}, target ${ref}: not a Prometheus or Loki query${dsType ? ` (datasource type "${dsType}")` : ''}; dropped.`)
          continue
        }
        if (dsType && dsType !== 'prometheus' && dsType !== 'loki') {
          warn('unsupported-target', `${where}, target ${ref}: datasource type "${dsType}" is not supported; dropped.`)
          continue
        }
        if (t.hide === true) {
          warn('hidden-target', `${where}, target ${ref} is hidden in Grafana; dropped.`)
          continue
        }
        const r = rewrite(exprRaw)
        if (r.unknown.length) {
          warn('unsupported-target', `${where}, target ${ref} uses ${r.unknown.map((u) => '$' + u).join(', ')}, which could not be imported; dropped.`)
          continue
        }
        if (ids.length >= max) {
          warn('too-many-targets', `${where}, target ${ref}: a ${kind} panel takes at most ${max} quer${max === 1 ? 'y' : 'ies'}; dropped.`)
          continue
        }
        const lang: QueryLang = dsType === 'loki' ? 'logql' : 'promql'
        const qid = uniqueId(slugId(`${id.slice(0, 40)}_${ref}`, 'q'), queryIds)
        const q: Query = { lang, expr: r.expr.slice(0, 4000) }
        const legend = str(t.legendFormat)
        if (legend && legend !== '__auto') q.legend = legend.slice(0, 200)
        if (t.instant === true) q.instant = true
        queries[qid] = q
        ids.push(qid)
      }
      if (!ids.length) {
        panelIds.delete(id)
        warn('empty-panel', `${where} has no importable queries and was not imported.`)
        return
      }
      const gUnit = str(defaults.unit) ?? str(obj(arr(p.yaxes)[0]).format) ?? str(p.format)
      let unit: Unit = 'none'
      if (gUnit === undefined) warn('missing-unit', `${where} has no unit; imported as "none".`)
      else if (hasOwn(UNIT_MAP, gUnit)) unit = UNIT_MAP[gUnit]!
      else if ((UNITS as readonly string[]).includes(gUnit)) unit = gUnit as Unit
      else warn('unknown-unit', `${where}: Grafana unit "${gUnit}" has no equivalent; imported as "none".`)

      const thresholds: Threshold[] = []
      const th = obj(defaults.thresholds)
      const steps = arr(th.steps).map(obj).filter((s) => num(s.value) !== undefined)
      if (steps.length && th.mode === 'percentage') warn('thresholds', `${where}: percentage thresholds cannot be expressed; dropped.`)
      else if (kind !== 'heatmap') {
        steps.slice(0, 8).forEach((s, i) => {
          const color = String(s.color ?? '')
          const level: Level = /red/i.test(color) ? 'crit' : /orange|yellow|amber/i.test(color) ? 'warn' : /green|blue/i.test(color) ? 'info' : i === steps.length - 1 ? 'crit' : 'warn'
          thresholds.push({ above: num(s.value)!, level })
        })
      }
      const base = { title: pTitle.slice(0, 120), description: (descr ?? 'TODO: describe what this panel shows and what bad looks like.').slice(0, 600), queries: ids }
      if (!descr) noDescription.push(id)

      if (kind === 'timeseries') {
        const custom = obj(defaults.custom)
        const o: NonNullable<Extract<Panel, { kind: 'timeseries' }>['options']> = {}
        const stacking = str(obj(custom.stacking).mode)
        if ((stacking && stacking !== 'none') || p.stack === true) o.stack = true
        if (custom.drawStyle === 'bars' || p.bars === true) o.style = 'bars'
        else if ((num(custom.fillOpacity) ?? 0) >= 30 || (num(p.fill) ?? 0) >= 3) o.style = 'area'
        if (obj(custom.scaleDistribution).type === 'log') o.yScale = 'log'
        if (num(defaults.min) !== undefined) o.yMin = num(defaults.min)!
        if (num(defaults.max) !== undefined && (o.yMin === undefined || num(defaults.max)! > o.yMin)) o.yMax = num(defaults.max)!
        panel = { kind, ...base, unit }
        if (Object.keys(o).length) panel.options = o
        if (thresholds.length) panel.thresholds = thresholds
      } else if (kind === 'stat') {
        const calc = String(arr(obj(options.reduceOptions).calcs)[0] ?? 'lastNotNull')
        const o: NonNullable<Extract<Panel, { kind: 'stat' }>['options']> = {}
        if (hasOwn(REDUCE_MAP, calc)) {
          if (REDUCE_MAP[calc] !== 'last') o.reduce = REDUCE_MAP[calc]!
        } else warn('reducer', `${where}: reducer "${calc}" is not supported; using "last".`)
        if (options.graphMode === 'area') o.sparkline = true
        panel = { kind, ...base, unit }
        if (Object.keys(o).length) panel.options = o
        if (thresholds.length) panel.thresholds = thresholds
      } else if (kind === 'table') {
        panel = { kind, ...base, unit }
        if (thresholds.length) panel.thresholds = thresholds
      } else {
        panel = { kind: 'heatmap', ...base, unit }
      }
      for (const [field, what] of [['transformations', 'transformations'], ['repeat', 'repeat-by-variable']] as const) {
        const val = p[field]
        if ((Array.isArray(val) && val.length) || (typeof val === 'string' && val)) warn('dropped-feature', `${where}: ${what} cannot be expressed and ${field === 'repeat' ? 'was' : 'were'} dropped.`)
      }
      if (arr(obj(p.fieldConfig).overrides).length) warn('dropped-feature', `${where}: field overrides were dropped.`)
    }
    spec.panels[id] = panel

    const gp = obj(p.gridPos)
    const w = Math.min(24, Math.max(1, Math.round(num(gp.w) ?? 24)))
    const x = Math.min(24 - w, Math.max(0, Math.round(num(gp.x) ?? 0)))
    const h = Math.min(100, Math.max(1, Math.round(num(gp.h) ?? 8)))
    const y = Math.min(10000, Math.max(0, Math.round(num(gp.y) ?? autoY)))
    autoY = Math.max(autoY, y + h)
    section.items.push({ panel: id, x, y, w, h })
  }

  for (const raw of arr(g.panels)) {
    const p = obj(raw)
    if (p.type === 'row') {
      const section: Section = { items: [] }
      const t = str(p.title)
      if (t) section.title = t.slice(0, 120)
      sections.push(section)
      for (const inner of arr(p.panels)) convertPanel(inner, section)
      if (str(p.repeat)) warn('dropped-feature', `Row "${t ?? ''}": repeat-by-variable cannot be expressed and was dropped.`)
    } else convertPanel(raw, sections[sections.length - 1]!)
  }
  if (noDescription.length) {
    warn('missing-description', `${noDescription.length} panel(s) have no description in Grafana and got a TODO placeholder: ${noDescription.join(', ')}. lint() reports them as weak-description.`)
  }
  if (arr(obj(g.annotations).list).some((a) => obj(a).builtIn !== 1)) warn('dropped-feature', 'Annotation queries were dropped.')
  if (arr(g.links).length) warn('dropped-feature', 'Dashboard links were dropped.')

  const toGrid = (s: Section): Layout => {
    const minY = Math.min(...s.items.map((i) => i.y))
    return { kind: 'grid', columns: 24, items: s.items.map((i) => ({ ...i, y: i.y - minY })) }
  }
  const filled = sections.filter((s) => s.items.length)
  if (filled.length === 1 && filled[0]!.title === undefined) spec.layout = toGrid(filled[0]!)
  else if (filled.length) {
    spec.layout = {
      kind: 'rows',
      rows: filled.slice(0, 50).map((s) => {
        const row: Row = { items: [toGrid(s)] }
        if (s.title !== undefined) row.title = s.title
        return row
      }),
    }
  }
  if (Object.keys(queries).length) spec.queries = queries

  // Multi-value variables used in equality matchers cannot be expressed; make them single-valued.
  for (const [name, v] of Object.entries(variables)) {
    if ((v.kind !== 'enum' && v.kind !== 'query') || !v.multi) continue
    const exprs = [...Object.values(queries).map((q) => q.expr), ...Object.values(variables).flatMap((o) => (o.kind === 'query' ? [o.query.expr] : []))]
    if (exprs.some((e) => findVariables(e).some((r) => r.name === name && r.context !== 'regex'))) {
      delete v.multi
      if (Array.isArray(v.default)) v.default = v.default[0]!
      warn('variable-not-multi', `Variable "${name}" is multi-value in Grafana but is used in an equality matcher (=); imported as single-value. Change the matcher to =~ and set "multi": true to restore it.`)
    }
  }
  if (Object.keys(variables).length) spec.variables = variables

  const result = validate(spec)
  return { spec, warnings, errors: result.errors }
}
