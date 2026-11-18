/**
 * validate(spec): structural validation against the JSON Schema, then
 * semantic checks the schema cannot express (references, duplicates,
 * cycles, variable use).
 */
import { BUILTIN_VARIABLES, findVariables, type VarRef } from './expr.ts'
import { closest, hasOwn, isObject, listOf, pointer } from './json.ts'
import { dashboardSchema } from './schema.ts'
import { validateAgainst } from './schema-validate.ts'
import type { Dashboard, Fragment, FragmentUse, Issue, Layout, Panel, Query, ValidationResult } from './types.ts'

type Path = (string | number)[]

export interface LayoutVisitor {
  panel?(id: string, path: Path): void
  use?(use: FragmentUse, path: Path): void
}

export type ClassifiedRowItem =
  | { type: 'panel'; panel: string; span?: number; bare: boolean }
  | { type: 'use'; use: FragmentUse }
  | { type: 'layout'; layout: Layout }

/** Tell the four row item forms apart. Returns undefined for anything else (invalid input). */
export function classifyRowItem(item: unknown): ClassifiedRowItem | undefined {
  if (typeof item === 'string') return { type: 'panel', panel: item, bare: true }
  if (!isObject(item)) return undefined
  if (typeof item.panel === 'string') return { type: 'panel', panel: item.panel, bare: false, ...(typeof item.span === 'number' ? { span: item.span } : {}) }
  if (typeof item.fragment === 'string' && typeof item.as === 'string') return { type: 'use', use: item as unknown as FragmentUse }
  if (item.kind === 'rows' || item.kind === 'grid') return { type: 'layout', layout: item as unknown as Layout }
  return undefined
}

/** Walk a layout tree, reporting each panel placement and fragment instance with its path. */
export function walkLayout(layout: Layout, path: Path, v: LayoutVisitor): void {
  if (!isObject(layout)) return
  if (layout.kind === 'grid') {
    if (!Array.isArray(layout.items)) return
    layout.items.forEach((it, i) => {
      if (isObject(it) && typeof it.panel === 'string') v.panel?.(it.panel, [...path, 'items', i, 'panel'])
    })
    return
  }
  if (layout.kind !== 'rows' || !Array.isArray(layout.rows)) return
  layout.rows.forEach((row, r) => {
    if (!isObject(row) || !Array.isArray(row.items)) return
    row.items.forEach((raw, i) => {
      const p = [...path, 'rows', r, 'items', i]
      const item = classifyRowItem(raw)
      if (!item) return
      if (item.type === 'panel') v.panel?.(item.panel, item.bare ? p : [...p, 'panel'])
      else if (item.type === 'use') v.use?.(item.use, p)
      else walkLayout(item.layout, p, v)
    })
  })
}

function didYouMean(name: string, candidates: string[], what: string): string {
  const near = closest(name, candidates)
  if (near) return `Did you mean ${JSON.stringify(near)}?`
  return candidates.length ? `Defined ${what}: ${listOf(candidates)}.` : `No ${what} are defined.`
}

const SINGLE_REF = /^(?:\$([A-Za-z_][A-Za-z0-9_]*)|\$\{([A-Za-z_][A-Za-z0-9_]*)\})$/

/** If `value` is exactly one variable reference, its name. */
export function argumentRef(value: string): string | undefined {
  const m = SINGLE_REF.exec(value)
  return m ? (m[1] ?? m[2]) : undefined
}

interface Scope {
  /** Names visible to expressions, with whether they can hold several values. */
  names: Map<string, { multi: boolean }>
  what: string
}

function checkExpr(expr: string, lang: string, path: Path, scope: Scope, out: Issue[]): VarRef[] {
  const refs = findVariables(expr, lang)
  const at = pointer(path)
  for (const r of refs) {
    if (r.format !== undefined) {
      out.push({ path: at, code: 'unsupported-variable-format', message: `\${${r.name}:${r.format}} uses a format suffix, which is not supported.`, suggestion: `Write \${${r.name}}; escaping is chosen from where the variable is used (regex-escaped inside =~ "…").` })
    }
    if (hasOwn(BUILTIN_VARIABLES, r.name)) continue
    const def = scope.names.get(r.name)
    if (!def) {
      const candidates = [...scope.names.keys(), ...Object.keys(BUILTIN_VARIABLES)]
      out.push({
        path: at,
        code: 'undefined-variable',
        message: `Expression uses $${r.name}, which is not defined.`,
        suggestion: `${didYouMean(r.name, candidates, scope.what)} Define it, or write $$ for a literal "$".`,
      })
      continue
    }
    if (def.multi && r.context !== 'regex') {
      out.push({
        path: at,
        code: 'multi-in-equality',
        message: `$${r.name} can hold several values but is used ${r.context === 'bare' ? 'outside a string' : 'in an equality matcher or plain string'}.`,
        suggestion: `Use a regex matcher: label=~"$${r.name}".`,
      })
    }
  }
  return refs
}

function checkPanels(panels: Record<string, Panel>, queries: Record<string, Query>, base: Path, otherScope: Record<string, Query> | undefined, out: Issue[]): void {
  const qids = Object.keys(queries)
  for (const [pid, panel] of Object.entries(panels)) {
    if (panel.kind === 'text') continue
    const p = [...base, pid]
    panel.queries.forEach((q, i) => {
      if (hasOwn(queries, q)) return
      const elsewhere = otherScope && hasOwn(otherScope, q)
      out.push({
        path: pointer([...p, 'queries', i]),
        code: 'dangling-query-ref',
        message: `Panel "${pid}" references query "${q}", which does not exist${elsewhere ? ' in this fragment (fragment panels can only use the fragment\'s own queries)' : ''}.`,
        suggestion: elsewhere ? `Copy the query into this fragment's "queries".` : `${didYouMean(q, qids, 'queries')} Or add it under "queries".`,
      })
    })
    if (panel.kind === 'table' && panel.options) {
      panel.options.columns?.forEach((col, i) => {
        if (!panel.queries.includes(col.query)) {
          out.push({ path: pointer([...p, 'options', 'columns', i, 'query']), code: 'column-not-in-panel', message: `Column refers to query "${col.query}", which is not in this panel's "queries".`, suggestion: `${didYouMean(col.query, panel.queries, 'panel queries')}` })
        }
      })
      if (panel.options.sortBy !== undefined && !panel.queries.includes(panel.options.sortBy)) {
        out.push({ path: pointer([...p, 'options', 'sortBy']), code: 'column-not-in-panel', message: `sortBy refers to query "${panel.options.sortBy}", which is not in this panel's "queries".`, suggestion: `${didYouMean(panel.options.sortBy, panel.queries, 'panel queries')}` })
      }
    }
    if (panel.kind === 'timeseries' && panel.options?.yMin !== undefined && panel.options.yMax !== undefined && panel.options.yMin >= panel.options.yMax) {
      out.push({ path: pointer([...p, 'options', 'yMin']), code: 'invalid-range', message: `yMin (${panel.options.yMin}) is not below yMax (${panel.options.yMax}).`, suggestion: 'Swap them or remove one.' })
    }
  }
}

function checkLayout(
  layout: Layout,
  base: Path,
  panels: Record<string, Panel>,
  fragments: Record<string, Fragment>,
  scope: Scope,
  instances: Map<string, string>,
  out: Issue[],
): void {
  const placed = new Map<string, string>()
  const pids = Object.keys(panels)
  const checkGrid = (l: Layout, p: Path) => {
    if (l.kind === 'grid') {
      const cols = l.columns ?? 24
      l.items.forEach((it, i) => {
        if (it.x + it.w > cols) {
          out.push({ path: pointer([...p, 'items', i]), code: 'grid-overflow', message: `Item spans columns ${it.x}–${it.x + it.w}, past the grid width ${cols}.`, suggestion: `Reduce "w" to ${Math.max(1, cols - it.x)} or lower "x".` })
        }
      })
    } else {
      l.rows.forEach((row, r) =>
        row.items.forEach((raw, i) => {
          const item = classifyRowItem(raw)
          if (item?.type === 'layout') checkGrid(item.layout, [...p, 'rows', r, 'items', i])
        }),
      )
    }
  }
  checkGrid(layout, base)
  walkLayout(layout, base, {
    panel(id, path) {
      const at = pointer(path)
      if (!hasOwn(panels, id)) {
        out.push({ path: at, code: 'dangling-panel-ref', message: `Layout references panel "${id}", which does not exist.`, suggestion: `${didYouMean(id, pids, 'panels')} Or add the panel under "panels".` })
        return
      }
      const first = placed.get(id)
      if (first !== undefined) {
        out.push({ path: at, code: 'duplicate-placement', message: `Panel "${id}" is already placed at ${first}.`, suggestion: 'Remove one placement; a panel appears once in the layout.' })
      } else placed.set(id, at)
    },
    use(use, path) {
      const at = pointer(path)
      const first = instances.get(use.as)
      if (first !== undefined) {
        out.push({ path: pointer([...path, 'as']), code: 'duplicate-id', message: `Fragment instance name "${use.as}" is already used at ${first}.`, suggestion: `Pick a different "as", e.g. "${use.as}_2".` })
      } else instances.set(use.as, at)
      const frag = hasOwn(fragments, use.fragment) ? fragments[use.fragment] : undefined
      if (!frag) {
        out.push({ path: pointer([...path, 'fragment']), code: 'dangling-fragment-ref', message: `Layout instantiates fragment "${use.fragment}", which does not exist.`, suggestion: `${didYouMean(use.fragment, Object.keys(fragments), 'fragments')}` })
        return
      }
      const params = frag.params ?? {}
      const args = use.with ?? {}
      for (const [k, v] of Object.entries(args)) {
        const ap = [...path, 'with', k]
        if (!hasOwn(params, k)) {
          out.push({ path: pointer(ap), code: 'unknown-param', message: `Fragment "${use.fragment}" has no parameter "${k}".`, suggestion: `${didYouMean(k, Object.keys(params), 'parameters')}` })
        }
        if (!v.includes('$')) continue
        const name = argumentRef(v)
        if (name === undefined) {
          if (v.replace(/\$\$/g, '').includes('$')) {
            out.push({ path: pointer(ap), code: 'invalid-argument', message: `Argument ${JSON.stringify(v)} mixes text and a variable reference.`, suggestion: 'An argument is either a literal string or exactly one variable reference such as "$env". Write $$ for a literal "$".' })
          }
        } else if (!scope.names.has(name)) {
          out.push({ path: pointer(ap), code: 'undefined-variable', message: `Argument references $${name}, which is not defined.`, suggestion: `${didYouMean(name, [...scope.names.keys()], scope.what)}` })
        }
      }
      for (const [k, def] of Object.entries(params)) {
        if (def.default === undefined && !hasOwn(args, k)) {
          out.push({ path: at, code: 'missing-param', message: `Fragment "${use.fragment}" requires parameter "${k}"${def.description ? ` (${def.description})` : ''}.`, suggestion: `Add "with": { "${k}": "…" }.` })
        }
      }
    },
  })
}

function semantic(spec: Dashboard, out: Issue[]): void {
  const variables = spec.variables ?? {}
  const queries = spec.queries ?? {}
  const fragments = spec.fragments ?? {}

  // -- variables: defaults, references between variables, cycles
  const dashScope: Scope = { names: new Map(), what: 'variables' }
  for (const [name, v] of Object.entries(variables)) {
    dashScope.names.set(name, { multi: (v.kind === 'enum' || v.kind === 'query') && v.multi === true })
  }
  const varDeps = new Map<string, string[]>()
  for (const [name, v] of Object.entries(variables)) {
    const base = ['variables', name]
    if (v.kind === 'enum' || v.kind === 'interval') {
      const defaults = v.default === undefined ? [] : Array.isArray(v.default) ? v.default : [v.default]
      defaults.forEach((d, i) => {
        if (v.values.includes(d) || (d === '*' && v.kind === 'enum' && v.includeAll)) return
        const near = closest(d, v.values)
        out.push({
          path: pointer(Array.isArray(v.default) ? [...base, 'default', i] : [...base, 'default']),
          code: 'default-not-in-values',
          message: `Default ${JSON.stringify(d)} is not one of the variable's values.`,
          suggestion: near ? `Did you mean ${JSON.stringify(near)}?` : `Values: ${listOf(v.values)}.`,
        })
      })
    }
    if ((v.kind === 'enum' || v.kind === 'query') && Array.isArray(v.default) && v.default.length > 1 && !v.multi) {
      out.push({ path: pointer([...base, 'default']), code: 'default-not-single', message: 'Default lists several values but the variable is not "multi".', suggestion: 'Set "multi": true, or give one default.' })
    }
    if (v.kind === 'query') {
      const refs = checkExpr(v.query.expr, v.query.lang, [...base, 'query', 'expr'], dashScope, out)
      varDeps.set(name, refs.map((r) => r.name).filter((n) => hasOwn(variables, n)))
    }
  }
  reportCycles(varDeps, (name, cycle) => {
    out.push({ path: pointer(['variables', name, 'query', 'expr']), code: 'variable-cycle', message: `Variable "${name}" depends on itself: ${cycle.join(' → ')}.`, suggestion: 'Remove one of the references so variables can be evaluated in order.' })
  })

  // -- dashboard queries, panels, layout
  for (const [qid, q] of Object.entries(queries)) checkExpr(q.expr, q.lang, ['queries', qid, 'expr'], dashScope, out)
  checkPanels(spec.panels, queries, ['panels'], undefined, out)
  const instances = new Map<string, string>()
  checkLayout(spec.layout, ['layout'], spec.panels, fragments, dashScope, instances, out)

  // -- fragments
  const fragDeps = new Map<string, string[]>()
  for (const [fid, frag] of Object.entries(fragments)) {
    const base = ['fragments', fid]
    const scope: Scope = { names: new Map(), what: 'fragment parameters' }
    for (const p of Object.keys(frag.params ?? {})) scope.names.set(p, { multi: false })
    for (const [qid, q] of Object.entries(frag.queries ?? {})) {
      const before = out.length
      checkExpr(q.expr, q.lang, [...base, 'queries', qid, 'expr'], scope, out)
      for (let i = before; i < out.length; i++) {
        const e = out[i]!
        const m = /\$(\w+)/.exec(e.message)
        if (e.code === 'undefined-variable' && m && hasOwn(variables, m[1]!)) {
          e.message += ' Fragments cannot see dashboard variables.'
          e.suggestion = `Declare a parameter under "params" and pass it at the use site: "with": { "${m[1]}": "$${m[1]}" }.`
        }
      }
    }
    checkPanels(frag.panels, frag.queries ?? {}, [...base, 'panels'], queries, out)
    const deps: string[] = []
    walkLayout(frag.layout, [], { use: (u) => void deps.push(u.fragment) })
    fragDeps.set(fid, deps.filter((d) => hasOwn(fragments, d)))
    checkLayout(frag.layout, [...base, 'layout'], frag.panels, fragments, scope, new Map(), out)
  }
  reportCycles(fragDeps, (fid, cycle) => {
    out.push({ path: pointer(['fragments', fid, 'layout']), code: 'fragment-cycle', message: `Fragment "${fid}" instantiates itself: ${cycle.join(' → ')}.`, suggestion: 'Break the cycle; fragments must form a tree.' })
  })
}

/** Report each cycle of `deps` once, at its first member in declaration order. */
function reportCycles(deps: Map<string, string[]>, report: (node: string, cycle: string[]) => void): void {
  const reported = new Set<string>()
  for (const start of deps.keys()) {
    const stack: string[] = [start]
    const seen = new Set<string>()
    const dfs = (node: string): string[] | null => {
      for (const next of deps.get(node) ?? []) {
        if (next === start) return [...stack, start]
        if (seen.has(next)) continue
        seen.add(next)
        stack.push(next)
        const found = dfs(next)
        if (found) return found
        stack.pop()
      }
      return null
    }
    const cycle = dfs(start)
    if (!cycle) continue
    const key = [...new Set(cycle)].sort().join(' ')
    if (reported.has(key)) continue
    reported.add(key)
    report(start, cycle)
  }
}

/**
 * Validate a dashboard spec. `ok` is true only if there are no errors.
 * Semantic checks run only once the structure is valid, so every reported
 * path exists in the document.
 */
export function validate(spec: unknown): ValidationResult {
  const errors = validateAgainst(dashboardSchema, dashboardSchema, spec)
  if (errors.length === 0) semantic(spec as Dashboard, errors)
  return { ok: errors.length === 0, errors }
}

/** Type guard form of `validate`. */
export function isDashboard(spec: unknown): spec is Dashboard {
  return validate(spec).ok
}
