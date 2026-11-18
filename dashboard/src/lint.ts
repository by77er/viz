/**
 * lint(spec): non-fatal advice. Run it on a spec that passes `validate`;
 * on an invalid spec it returns a single `invalid-spec` warning.
 */
import { findVariables, isSafeBare } from './expr.ts'
import { canonicalJson, hasOwn, pointer } from './json.ts'
import type { Dashboard, Issue, LintWarning, Panel, Query } from './types.ts'
import { validate, walkLayout } from './validate.ts'

export interface LintOptions {
  /** Warn above this many panels (fragment panels count once per instance). Default 24. */
  maxPanels?: number
  /** Rule codes to skip. */
  disable?: string[]
}

export const LINT_RULES: Record<string, string> = {
  'invalid-spec': 'The spec does not pass validate(); fix errors first.',
  'missing-unit': 'A table has neither a panel unit nor a unit on every column.',
  'stat-without-thresholds': 'A stat panel has no thresholds, so a reader cannot tell good from bad.',
  'too-many-panels': 'More panels than a reader (or a token budget) can take in.',
  'hardcoded-rate-window': 'rate()/increase() over a literal window such as [5m] instead of [$__rate].',
  'unused-query': 'A named query no panel references.',
  'unused-variable': 'A variable no expression or fragment argument references.',
  'unused-fragment': 'A fragment that is never instantiated.',
  'unused-param': 'A fragment parameter no fragment query uses.',
  'unplaced-panel': 'A panel that is not in the layout and so is never shown.',
  'title-is-query': 'A panel title that is just the query text or a query id.',
  'weak-description': 'A description that is a placeholder or too short to say what bad looks like.',
  'weak-intent': 'An intent too short to say what question the dashboard answers.',
  'duplicate-panel': 'Two panels of the same kind over the same queries.',
  'bare-variable': 'A free-form variable used outside a string; only numbers, durations and identifiers will substitute.',
  'threshold-order': 'Thresholds where a less severe level is harder to reach than a more severe one.',
  'empty-row': 'A layout with no panels.',
}

const RATE_FN = /\b(?:rate|irate|increase|delta|idelta|deriv|changes|resets)\s*\(/
const LITERAL_WINDOW = /\[\s*(?:[0-9]+(?:ms|s|m|h|d|w|y))+\s*\]/
const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, '')
const SEVERITY = { info: 1, warn: 2, crit: 3 } as const

function lintPanels(panels: Record<string, Panel>, queries: Record<string, Query>, base: (string | number)[], out: Issue[]): void {
  const seen = new Map<string, string>()
  for (const [pid, panel] of Object.entries(panels)) {
    const p = [...base, pid]
    const description = panel.description
    if (description !== undefined && (/^\s*(todo|tbd|fixme)\b/i.test(description) || description.trim().length < 20)) {
      out.push({ path: pointer([...p, 'description']), code: 'weak-description', message: `Panel "${pid}" has a placeholder or very short description.`, suggestion: 'Say what the panel shows, how to read it, and what bad looks like.' })
    }
    if (panel.kind === 'text') continue

    const key = canonicalJson([panel.kind, panel.queries])
    const twin = seen.get(key)
    if (twin) out.push({ path: pointer(p), code: 'duplicate-panel', message: `Panel "${pid}" shows the same queries with the same kind as "${twin}".`, suggestion: 'Remove one, or change what it shows.' })
    else seen.set(key, pid)

    const title = normalize(panel.title)
    for (const qid of panel.queries) {
      const q = hasOwn(queries, qid) ? queries[qid] : undefined
      if (title === normalize(qid) || (q && title === normalize(q.expr))) {
        out.push({ path: pointer([...p, 'title']), code: 'title-is-query', message: `Title of "${pid}" is just the query ${q && title === normalize(q.expr) ? 'text' : 'id'}.`, suggestion: 'Name what is measured in words a reader would use, e.g. "Error ratio".' })
        break
      }
    }
    if (panel.kind === 'stat' && !panel.thresholds?.length) {
      out.push({ path: pointer(p), code: 'stat-without-thresholds', message: `Stat panel "${pid}" has no thresholds.`, suggestion: 'Add "thresholds", e.g. [{ "above": 0.01, "level": "warn" }, { "above": 0.05, "level": "crit" }].' })
    }
    if (panel.kind === 'table' && panel.unit === undefined) {
      const cols = panel.options?.columns ?? []
      const covered = panel.queries.every((qid) => cols.some((c) => c.query === qid && c.unit !== undefined))
      if (!covered) out.push({ path: pointer(p), code: 'missing-unit', message: `Table "${pid}" has no unit and not every column sets one.`, suggestion: 'Add "unit" to the panel, or a "unit" to each entry of options.columns.' })
    }
    if (panel.kind !== 'heatmap' && panel.thresholds && panel.thresholds.length > 1) {
      for (const dir of ['above', 'below'] as const) {
        const ts = panel.thresholds.filter((t) => dir in t).map((t) => ({ v: (t as unknown as Record<string, number>)[dir]!, s: SEVERITY[t.level] }))
        const bad = ts.some((a) => ts.some((b) => a.s < b.s && (dir === 'above' ? a.v > b.v : a.v < b.v)))
        if (bad) out.push({ path: pointer([...p, 'thresholds']), code: 'threshold-order', message: `In "${pid}", a less severe "${dir}" threshold is harder to reach than a more severe one, so it can never be the reported state.`, suggestion: `Order levels so that warn is reached before crit.` })
      }
    }
  }
}

function lintQueries(queries: Record<string, Query>, base: (string | number)[], used: Set<string>, what: string, out: Issue[]): void {
  for (const [qid, q] of Object.entries(queries)) {
    const p = [...base, qid]
    if (!used.has(qid)) out.push({ path: pointer(p), code: 'unused-query', message: `Query "${qid}" is not used by any ${what}.`, suggestion: 'Remove it, or reference it from a panel.' })
    if (q.lang === 'promql' && RATE_FN.test(q.expr) && LITERAL_WINDOW.test(q.expr)) {
      const m = LITERAL_WINDOW.exec(q.expr)!
      out.push({ path: pointer([...p, 'expr']), code: 'hardcoded-rate-window', message: `Query "${qid}" uses a fixed range window ${m[0]}; it will alias when zoomed out and be noisy when zoomed in.`, suggestion: 'Use [$__rate] so the window follows the query step.' })
    }
  }
}

/** Non-fatal warnings about a dashboard. */
export function lint(spec: unknown, opts: LintOptions = {}): LintWarning[] {
  const v = validate(spec)
  if (!v.ok) {
    return [{ path: '', code: 'invalid-spec', message: `The spec has ${v.errors.length} validation error(s); lint needs a valid spec.`, suggestion: 'Run validate() and fix its errors first.' }]
  }
  const d = spec as Dashboard
  const out: Issue[] = []
  const maxPanels = opts.maxPanels ?? 24
  const variables = d.variables ?? {}
  const queries = d.queries ?? {}
  const fragments = d.fragments ?? {}

  if (d.metadata.intent.trim().length < 30) {
    out.push({ path: '/metadata/intent', code: 'weak-intent', message: 'The intent is too short to tell a reader what question this dashboard answers.', suggestion: 'One or two sentences: who looks at this, and what they decide from it.' })
  }

  // usage
  const usedQueries = new Set<string>()
  for (const p of Object.values(d.panels)) if (p.kind !== 'text') p.queries.forEach((q) => usedQueries.add(q))
  const usedVars = new Set<string>()
  const noteExpr = (expr: string, lang: string, path: (string | number)[], known: (n: string) => 'free' | 'safe' | undefined) => {
    for (const r of findVariables(expr, lang)) {
      usedVars.add(r.name)
      if (r.context === 'bare' && known(r.name) === 'free') {
        out.push({ path: pointer(path), code: 'bare-variable', message: `$${r.name} is used outside a string; a value that is not a number, duration or identifier will fail to substitute.`, suggestion: `Put it inside a quoted matcher, or make "${r.name}" an enum/interval variable with safe values.` })
      }
    }
  }
  const varKind = (n: string): 'free' | 'safe' | undefined => {
    const v = hasOwn(variables, n) ? variables[n] : undefined
    if (!v) return undefined
    if (v.kind === 'interval') return 'safe'
    if (v.kind === 'enum') return v.values.every(isSafeBare) ? 'safe' : 'free'
    return 'free'
  }
  for (const [qid, q] of Object.entries(queries)) noteExpr(q.expr, q.lang, ['queries', qid, 'expr'], varKind)
  for (const [name, v] of Object.entries(variables)) if (v.kind === 'query') noteExpr(v.query.expr, v.query.lang, ['variables', name, 'query', 'expr'], varKind)

  const placed = new Set<string>()
  const usedFragments = new Set<string>()
  let panelCount = Object.keys(d.panels).length
  const countUse = (fid: string, depth: number): number => {
    const f = hasOwn(fragments, fid) ? fragments[fid] : undefined
    if (!f || depth > 16) return 0
    let n = Object.keys(f.panels).length
    walkLayout(f.layout, [], { use: (u) => void (n += countUse(u.fragment, depth + 1)) })
    return n
  }
  const noteUse = (u: { fragment: string; with?: Record<string, string> }) => {
    usedFragments.add(u.fragment)
    for (const v of Object.values(u.with ?? {})) for (const r of findVariables(v)) usedVars.add(r.name)
  }
  walkLayout(d.layout, ['layout'], {
    panel: (id) => void placed.add(id),
    use: (u) => {
      noteUse(u)
      panelCount += countUse(u.fragment, 0)
    },
  })
  if (placed.size === 0 && usedFragments.size === 0) {
    out.push({ path: '/layout', code: 'empty-row', message: 'The layout places no panels.', suggestion: 'Add panel ids to a row, e.g. { "kind": "rows", "rows": [{ "items": ["my_panel"] }] }.' })
  }

  lintQueries(queries, ['queries'], usedQueries, 'panel', out)
  lintPanels(d.panels, queries, ['panels'], out)
  for (const pid of Object.keys(d.panels)) {
    if (!placed.has(pid)) out.push({ path: pointer(['panels', pid]), code: 'unplaced-panel', message: `Panel "${pid}" is not in the layout, so it is never shown.`, suggestion: `Add "${pid}" to a row in "layout", or remove the panel.` })
  }

  for (const [fid, f] of Object.entries(fragments)) {
    const base = ['fragments', fid]
    const fUsedQ = new Set<string>()
    for (const p of Object.values(f.panels)) if (p.kind !== 'text') p.queries.forEach((q) => fUsedQ.add(q))
    const fUsedParams = new Set<string>()
    for (const q of Object.values(f.queries ?? {})) for (const r of findVariables(q.expr, q.lang)) fUsedParams.add(r.name)
    const fPlaced = new Set<string>()
    walkLayout(f.layout, [], {
      panel: (id) => void fPlaced.add(id),
      use: (u) => {
        usedFragments.add(u.fragment)
        for (const v of Object.values(u.with ?? {})) for (const r of findVariables(v)) fUsedParams.add(r.name)
      },
    })
    lintQueries(f.queries ?? {}, [...base, 'queries'], fUsedQ, 'panel of the fragment', out)
    lintPanels(f.panels, f.queries ?? {}, [...base, 'panels'], out)
    for (const pid of Object.keys(f.panels)) {
      if (!fPlaced.has(pid)) out.push({ path: pointer([...base, 'panels', pid]), code: 'unplaced-panel', message: `Fragment panel "${pid}" is not in the fragment layout.`, suggestion: 'Add it to the fragment layout, or remove it.' })
    }
    for (const param of Object.keys(f.params ?? {})) {
      if (!fUsedParams.has(param)) out.push({ path: pointer([...base, 'params', param]), code: 'unused-param', message: `Parameter "${param}" of fragment "${fid}" is not used by its queries.`, suggestion: 'Use it in a query as $' + param + ', or remove it.' })
    }
  }
  for (const fid of Object.keys(fragments)) {
    if (!usedFragments.has(fid)) out.push({ path: pointer(['fragments', fid]), code: 'unused-fragment', message: `Fragment "${fid}" is never instantiated.`, suggestion: `Add { "fragment": "${fid}", "as": "…" } to a layout row, or remove it.` })
  }
  for (const name of Object.keys(variables)) {
    if (!usedVars.has(name)) out.push({ path: pointer(['variables', name]), code: 'unused-variable', message: `Variable "${name}" is not used by any query or fragment argument.`, suggestion: `Use it in a query as $${name}, or remove it.` })
  }
  if (panelCount > maxPanels) {
    out.push({ path: '/panels', code: 'too-many-panels', message: `The dashboard shows ${panelCount} panels; more than ${maxPanels} is hard to read and expensive to digest.`, suggestion: 'Split it by audience or question, or move detail to a second dashboard.' })
  }

  const disabled = new Set(opts.disable ?? [])
  return out.filter((w) => !disabled.has(w.code))
}
