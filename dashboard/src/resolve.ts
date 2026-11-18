/**
 * resolve(spec, { variables }): expand fragment instances and substitute
 * variables, producing the flat form the query layer and renderer consume.
 *
 * Never throws on a spec that passes `validate`. Problems that depend on
 * runtime values (an unsafe value, a missing argument) are reported in
 * `issues` and on the affected query as `error`; such a query keeps its
 * unsubstituted reference so it cannot run (fail closed).
 */
import { BUILTIN_VARIABLES, substitute, type Binding, type BuiltinVariable } from './expr.ts'
import { hasOwn, isObject, pointer } from './json.ts'
import { revisionOf } from './revision.ts'
import { DURATION_PATTERN } from './schema.ts'
import type { Dashboard, Fragment, Issue, Layout, Metadata, Panel, Query, QueryLang, TimeRange, Variable } from './types.ts'
import { argumentRef } from './validate.ts'

export interface ResolveOptions {
  /** Selected values by variable name. Omitted variables take their default. `"*"` means all. */
  variables?: Record<string, string | string[]>
  /** Values for $__rate, $__interval, $__range. Defaults: 5m, 1m, 1h. */
  builtins?: Partial<Record<BuiltinVariable, string>>
}

export interface ResolvedQuery {
  lang: QueryLang
  /** Expression with variables substituted. */
  expr: string
  legend?: string
  instant?: boolean
  /** JSON Pointer of the query in the source spec. */
  source: string
  /** Set when substitution failed; the query must not be run. */
  error?: string
}

/** A panel whose `queries` are ids in `ResolvedDashboard.queries`. */
export type ResolvedPanel = Panel & {
  /** JSON Pointer of the panel in the source spec. */
  source: string
  /** Fragment instance path, e.g. `db` or `deps.cache`, when the panel came from a fragment. */
  instance?: string
}

export type ResolvedRowItem = { panel: string; span?: number } | { layout: ResolvedLayout; span?: number; instance?: string }
export type ResolvedLayout =
  | { kind: 'rows'; rows: { title?: string; height?: number; items: ResolvedRowItem[] }[] }
  | { kind: 'grid'; columns: number; items: { panel: string; x: number; y: number; w: number; h: number }[] }

export interface ResolvedDashboard {
  apiVersion: Dashboard['apiVersion']
  metadata: Metadata
  time?: TimeRange
  /** Revision of the source spec. */
  revision: string
  /** The value each variable resolved to. */
  variables: Record<string, { values: string[]; all: boolean }>
  /** Keys are query ids; fragment queries are `<instance>.<id>`. */
  queries: Record<string, ResolvedQuery>
  /** Keys are panel ids; fragment panels are `<instance>.<id>`. */
  panels: Record<string, ResolvedPanel>
  layout: ResolvedLayout
  /** Panel ids in reading order (layout order). */
  order: string[]
  issues: Issue[]
}

const DURATION = new RegExp(DURATION_PATTERN)
const DEFAULT_BUILTINS: Record<BuiltinVariable, string> = { __rate: '5m', __interval: '1m', __range: '1h' }

function bindVariable(name: string, def: Variable, given: string | string[] | undefined, issues: Issue[]): Binding {
  const path = pointer(['variables', name])
  const warn = (message: string, suggestion: string) => issues.push({ path, code: 'variable-value', message, suggestion })
  const defaults = def.default === undefined ? undefined : Array.isArray(def.default) ? def.default : [def.default]
  let values = given === undefined ? undefined : (Array.isArray(given) ? given : [given]).filter((v): v is string => typeof v === 'string')

  if (def.kind === 'text') return { values: [values?.[0] ?? defaults?.[0] ?? ''] }

  if (def.kind === 'interval') {
    const v = values?.[0]
    if (v !== undefined && DURATION.test(v)) return { values: [v] }
    if (v !== undefined) warn(`${JSON.stringify(v)} is not a duration; using the default.`, `Values: ${def.values.join(', ')}.`)
    return { values: [defaults?.[0] ?? def.values[0]!] }
  }

  const allowAll = def.kind === 'query' || def.includeAll === true
  const pick = (vals: string[] | undefined, origin: string): Binding | undefined => {
    if (!vals || vals.length === 0) return undefined
    if (vals.includes('*')) {
      if (allowAll) return { values: [], all: true }
      warn(`"*" (all) was ${origin} but the variable does not set "includeAll".`, 'Set "includeAll": true or choose a value.')
      vals = vals.filter((v) => v !== '*')
    }
    if (def.kind === 'enum') {
      const bad = vals.filter((v) => !def.values.includes(v))
      if (bad.length) warn(`${bad.map((b) => JSON.stringify(b)).join(', ')} ${origin} but not among the variable's values; ignored.`, `Values: ${def.values.join(', ')}.`)
      vals = vals.filter((v) => def.values.includes(v))
    }
    if (vals.length > 1 && !def.multi) {
      warn(`Several values were ${origin} but the variable is not "multi"; using the first.`, 'Set "multi": true to allow several values.')
      vals = vals.slice(0, 1)
    }
    return vals.length ? { values: vals } : undefined
  }
  return (
    pick(values, 'given') ??
    pick(defaults, 'the default') ??
    (def.kind === 'enum' ? { values: [def.values[0]!] } : { values: [], all: true })
  )
}

export function resolve(spec: Dashboard, opts: ResolveOptions = {}): ResolvedDashboard {
  const issues: Issue[] = []
  const given = opts.variables ?? {}
  const builtins = { ...DEFAULT_BUILTINS, ...(opts.builtins ?? {}) }
  const fragments = spec.fragments ?? {}

  const dashScope = new Map<string, Binding>()
  const variables: ResolvedDashboard['variables'] = {}
  for (const [name, def] of Object.entries(spec.variables ?? {})) {
    const b = bindVariable(name, def, hasOwn(given, name) ? given[name] : undefined, issues)
    dashScope.set(name, b)
    variables[name] = { values: b.values, all: b.all === true }
  }
  for (const name of Object.keys(given)) {
    if (!dashScope.has(name)) issues.push({ path: '', code: 'unknown-variable', message: `A value was given for "${name}", which is not a variable of this dashboard.`, suggestion: `Variables: ${[...dashScope.keys()].join(', ') || '(none)'}.` })
  }

  const lookupIn = (scope: Map<string, Binding>) => (name: string): Binding | undefined => {
    if (hasOwn(BUILTIN_VARIABLES, name)) return { values: [String(builtins[name as BuiltinVariable])] }
    return scope.get(name)
  }

  const queries: Record<string, ResolvedQuery> = {}
  const panels: Record<string, ResolvedPanel> = {}
  const order: string[] = []

  const addQueries = (src: Record<string, Query>, prefix: string, base: (string | number)[], scope: Map<string, Binding>) => {
    for (const [qid, q] of Object.entries(src)) {
      const source = pointer([...base, qid])
      const r = substitute(q.expr, lookupIn(scope), q.lang)
      const out: ResolvedQuery = { lang: q.lang, expr: r.expr, source }
      if (q.legend !== undefined) out.legend = q.legend
      if (q.instant !== undefined) out.instant = q.instant
      if (r.errors.length) {
        out.error = r.errors.join('; ')
        issues.push({ path: source + '/expr', code: 'substitution-failed', message: `Query "${prefix}${qid}" cannot be run: ${out.error}.`, suggestion: 'Change the variable value, or move the variable into a quoted regex matcher (=~).' })
      }
      queries[prefix + qid] = out
    }
  }
  const addPanels = (src: Record<string, Panel>, prefix: string, base: (string | number)[]) => {
    for (const [pid, p] of Object.entries(src)) {
      const copy = JSON.parse(JSON.stringify(p)) as Panel
      if (copy.kind !== 'text') copy.queries = copy.queries.map((q) => prefix + q)
      if (copy.kind === 'table' && copy.options) {
        copy.options.columns?.forEach((c) => (c.query = prefix + c.query))
        if (copy.options.sortBy !== undefined) copy.options.sortBy = prefix + copy.options.sortBy
      }
      const resolved: ResolvedPanel = { ...copy, source: pointer([...base, pid]) }
      if (prefix) resolved.instance = prefix.slice(0, -1)
      panels[prefix + pid] = resolved
    }
  }

  const expandLayout = (
    layout: Layout,
    prefix: string,
    known: Record<string, Panel>,
    scope: Map<string, Binding>,
    base: (string | number)[],
    stack: string[],
  ): ResolvedLayout => {
    if (layout.kind === 'grid') {
      const items = layout.items.filter((it) => hasOwn(known, it.panel)).map((it) => ({ ...it, panel: prefix + it.panel }))
      for (const it of items) order.push(it.panel)
      return { kind: 'grid', columns: layout.columns ?? 24, items }
    }
    const rows = layout.rows.map((row, r) => {
      const items: ResolvedRowItem[] = []
      row.items.forEach((item, i) => {
        const at = [...base, 'rows', r, 'items', i]
        if (typeof item === 'string') {
          if (hasOwn(known, item)) {
            items.push({ panel: prefix + item })
            order.push(prefix + item)
          }
        } else if (!isObject(item)) {
          return
        } else if ('panel' in item) {
          if (hasOwn(known, item.panel)) {
            items.push({ panel: prefix + item.panel, ...(item.span !== undefined ? { span: item.span } : {}) })
            order.push(prefix + item.panel)
          }
        } else if ('fragment' in item) {
          const frag: Fragment | undefined = hasOwn(fragments, item.fragment) ? fragments[item.fragment] : undefined
          if (!frag || stack.includes(item.fragment) || stack.length >= 16) {
            issues.push({ path: pointer(at), code: 'fragment-not-expanded', message: `Fragment "${item.fragment}" ${frag ? 'is part of a reference cycle' : 'does not exist'}; the instance "${item.as}" was skipped.`, suggestion: 'Run validate() on the spec.' })
            return
          }
          const inner = new Map<string, Binding>()
          const outer = lookupIn(scope)
          for (const [param, def] of Object.entries(frag.params ?? {})) {
            const arg = item.with && hasOwn(item.with, param) ? item.with[param] : def.default
            if (arg === undefined) {
              issues.push({ path: pointer(at), code: 'missing-param', message: `Instance "${item.as}" does not set required parameter "${param}".`, suggestion: `Add "with": { "${param}": "…" }.` })
              continue
            }
            const refName = argumentRef(arg)
            if (refName !== undefined) {
              const b = outer(refName)
              if (b) inner.set(param, b)
              else issues.push({ path: pointer([...at, 'with', param]), code: 'undefined-variable', message: `Argument references $${refName}, which is not defined.`, suggestion: 'Run validate() on the spec.' })
            } else inner.set(param, { values: [arg.replace(/\$\$/g, '$')] })
          }
          const p = `${prefix}${item.as}.`
          const fbase = ['fragments', item.fragment]
          addQueries(frag.queries ?? {}, p, [...fbase, 'queries'], inner)
          addPanels(frag.panels, p, [...fbase, 'panels'])
          const sub = expandLayout(frag.layout, p, frag.panels, inner, [...fbase, 'layout'], [...stack, item.fragment])
          items.push({ layout: sub, instance: p.slice(0, -1), ...(item.span !== undefined ? { span: item.span } : {}) })
        } else {
          items.push({ layout: expandLayout(item, prefix, known, scope, at, stack) })
        }
      })
      return { ...(row.title !== undefined ? { title: row.title } : {}), ...(row.height !== undefined ? { height: row.height } : {}), items }
    })
    return { kind: 'rows', rows }
  }

  addQueries(spec.queries ?? {}, '', ['queries'], dashScope)
  addPanels(spec.panels, '', ['panels'])
  const layout = expandLayout(spec.layout, '', spec.panels, dashScope, ['layout'], [])

  const out: ResolvedDashboard = {
    apiVersion: spec.apiVersion,
    metadata: spec.metadata,
    revision: revisionOf(spec),
    variables,
    queries,
    panels,
    layout,
    order,
    issues,
  }
  if (spec.time) out.time = spec.time
  return out
}
