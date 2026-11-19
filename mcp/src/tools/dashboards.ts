import {
  type Dashboard,
  type DashboardDigest,
  type PanelDigest,
  ID_PATTERN,
  canonicalJson,
  panelOrder,
  renderDigest,
} from '../../../dashboard/src/index.ts'
import { CURSOR_ARG, MAX_TOKENS_ARG, TIME_ARG, VARIABLES_ARG, isoOf } from '../args'
import { budgetOf, charsFor, encodeCursor, argsHash, tokensOf, type Item } from '../page'
import type { Session } from '../session'
import { type ToolDef, type ToolResult, ToolError, pagedResult } from '../tool'
import { DATA_NOTICE, FENCE_OVERHEAD, cell, clean, cleanDeep, MAX, fenced } from '../untrusted'
import { type PanelRun, badgeOf, cleanDigest, controlError, cursorOf, exploreLink, pinRange, rangeOf, rangeText, resolveSpec, runPanels } from './common'

export const ID_ARG = { type: 'string', pattern: ID_PATTERN, maxLength: 48, description: 'Dashboard id (metadata.id), e.g. "service_red". From search_dashboards.' } as const

function needControl(s: Session) {
  if (!s.control) throw new ToolError('not-available-yet', 'The control plane is not connected to this deployment.', 'Ask the operator to bind CONTROL.', { status: 501 })
  return s.control
}

const actorText = (a: { kind?: unknown; name?: unknown } | null | undefined): string =>
  a ? `${cell(a.kind, 10)}${a.name ? ` ${cell(a.name, 80)}` : ''}` : 'unknown'

/** Load a dashboard's spec at a revision number (or the head). */
export async function loadSpec(s: Session, id: string, revision?: number): Promise<{ spec: Dashboard; revision: string; number: number; current: boolean }> {
  const control = needControl(s)
  s.usage.upstreamCalls++
  const r = await control.call('GET', `/dashboards/${encodeURIComponent(id)}`, { query: { view: 'spec', revision: revision !== undefined ? String(revision) : undefined } })
  if (r.status !== 200) throw controlError(r, 'read the dashboard')
  return { spec: r.body.spec as Dashboard, revision: String(r.body.revision), number: Number(r.body.number), current: r.body.current === true }
}

// ---- search_dashboards ----

export const searchDashboards: ToolDef = {
  name: 'search_dashboards',
  title: 'Search dashboards',
  description:
    'Find existing dashboards before making a new one. Matches words in the id, title, intent, owner and tags. Returns per dashboard: id, title, intent, tags, panel count, revision number and when and by whom (person or agent) it last changed. Usage statistics are not tracked yet.',
  scopes: ['dashboards:read'],
  defaultTokens: 1000,
  readOnly: true,
  input: {
    type: 'object',
    additionalProperties: false,
    properties: {
      q: { type: 'string', maxLength: 200, description: 'Words to match; empty lists every dashboard.' },
      tag: { type: 'string', maxLength: 64, description: 'Only dashboards with this tag.' },
      limit: { type: 'integer', minimum: 1, maximum: 50, default: 20, description: 'Dashboards per page.' },
      max_tokens: MAX_TOKENS_ARG(1000),
      cursor: CURSOR_ARG,
    },
  },
  async run(s, args) {
    const c = cursorOf(this.name, args)
    const control = needControl(s)
    const limit = (args.limit as number | undefined) ?? 20
    // The control plane pages by its own cursor; ours remembers it and how far into that page we got.
    const remote = typeof c?.p?.rc === 'string' ? (c.p.rc as string) : undefined
    s.usage.upstreamCalls++
    const r = await control.call('GET', '/dashboards', { query: { q: args.q as string | undefined, tag: args.tag as string | undefined, limit: String(limit), cursor: remote } })
    if (r.status !== 200) throw controlError(r, 'list dashboards')
    const page = r.body.items as any[]
    const items: Item[] = page.map((d) => ({
      key: String(d.id),
      text: `${cell(d.id, 48)} | ${cell(d.name, MAX.title)} | ${(d.tags ?? []).map((t: unknown) => cell(t, 40)).join(',') || '-'} | ${Number(d.panels)} panels | rev ${Number(d.number)} | ${cell(d.lastChangedAt, 30)} by ${actorText(d.lastChangedBy)} | intent: ${cell(d.intent, 160)}\n`,
      data: cleanDeep({ id: d.id, title: d.name, intent: d.intent, tags: d.tags, owner: d.owner, panels: d.panels, number: d.number, revision: d.revision, lastChangedAt: d.lastChangedAt, lastChangedBy: d.lastChangedBy }),
    }))
    const skip = typeof c?.p?.k === 'number' ? (c.p.k as number) : 0
    const hash = argsHash(args)
    const nextRemote = r.body.next as string | null
    const result = pagedResult({
      tool: this.name,
      s,
      args,
      maxTokens: budgetOf(args.max_tokens, this.defaultTokens),
      header: `search_dashboards: ${Number(r.body.total)} dashboard(s) match; this page holds up to ${limit}.\nColumns: id | title | tags | panels | revision | last changed | intent\n`,
      items,
      offset: skip,
      meta: { total: Number(r.body.total) },
    })
    // Continue within this remote page, or move to the next one.
    const shownTo = skip + (result.structured.shown as number)
    let cursor: string | null = null
    if (shownTo < items.length) cursor = encodeCursor({ t: this.name, a: hash, o: shownTo, p: { ...(remote ? { rc: remote } : {}), k: shownTo } })
    else if (nextRemote) cursor = encodeCursor({ t: this.name, a: hash, o: 0, p: { rc: nextRemote, k: 0 } })
    return withCursor(result, cursor)
  },
}

/** Replace a paged result's cursor (and its footer line) when the cursor is composite. */
function withCursor(res: ToolResult, cursor: string | null): ToolResult {
  const old = res.structured.cursor
  let text = res.text.replace(/^Truncated: .*\n/m, '')
  if (cursor) text += `More: call again with cursor "${cursor}" to continue.\n`
  void old
  return { ...res, text, structured: { ...res.structured, cursor, truncated: cursor !== null || res.structured.truncated } }
}

// ---- get_dashboard ----

/** The spec as items addressed by JSON Pointer, so a long spec pages without splitting a value. */
function specItems(spec: Dashboard): Item[] {
  const items: Item[] = []
  const add = (path: string, value: unknown) => {
    const v = cleanDeep(value, MAX.spec)
    items.push({ key: path, text: `${cell(path, 120)} ${JSON.stringify(v)}\n`, data: { path: clean(path, { max: 120 }), value: v } })
  }
  add('/apiVersion', spec.apiVersion)
  add('/metadata', spec.metadata)
  if (spec.time) add('/time', spec.time)
  for (const [k, v] of Object.entries(spec.variables ?? {})) add(`/variables/${k}`, v)
  for (const [k, v] of Object.entries(spec.queries ?? {})) add(`/queries/${k}`, v)
  for (const [k, v] of Object.entries(spec.panels)) add(`/panels/${k}`, v)
  add('/layout', spec.layout)
  for (const [k, v] of Object.entries(spec.fragments ?? {})) add(`/fragments/${k}`, v)
  return items
}

/** JSON Pointers whose value cleaning changed: a reader must not write those values back. */
function alteredPaths(spec: unknown, path = ''): string[] {
  if (typeof spec === 'string') return clean(spec, { max: MAX.spec }) === spec ? [] : [path]
  if (spec === null || typeof spec !== 'object') return []
  return Object.entries(spec as Record<string, unknown>).flatMap(([k, v]) => alteredPaths(v, `${path}/${k.replace(/~/g, '~0').replace(/\//g, '~1')}`))
}

export const getDashboard: ToolDef = {
  name: 'get_dashboard',
  title: 'Get a dashboard',
  description:
    'Read a dashboard\'s definition. view "outline" (default, cheapest): title, intent, variables, and per panel id, kind, title, unit and query ids. view "spec": the viz.dashboard/v1 JSON, one JSON Pointer per line (/metadata, /panels/<id>, /layout, ...), with the revision to send as base_revision to write_dashboard. view "resolved": fragments expanded and variables substituted, per panel with its final queries. Strings are shown cleaned (control characters, markup and URLs neutralised); "altered" lists values that differ from what is stored, so do not copy those into a change. A value larger than a whole page is shown cut ("cut": true); read the spec with max_tokens of 2,000 or more. No data: use read_dashboard for that.',
  scopes: ['dashboards:read'],
  defaultTokens: 2000,
  readOnly: true,
  input: {
    type: 'object',
    additionalProperties: false,
    required: ['id'],
    properties: {
      id: ID_ARG,
      view: { type: 'string', enum: ['outline', 'spec', 'resolved'], default: 'outline', description: 'outline, spec or resolved.' },
      revision: { type: 'integer', minimum: 1, description: 'A revision number from list_revisions; default the current one.' },
      variables: VARIABLES_ARG,
      max_tokens: MAX_TOKENS_ARG(2000),
      cursor: CURSOR_ARG,
    },
  },
  async run(s, args) {
    const c = cursorOf(this.name, args)
    const id = String(args.id)
    const view = (args.view as string | undefined) ?? 'outline'
    const number = typeof c?.p?.n === 'number' ? (c.p.n as number) : (args.revision as number | undefined)
    const { spec, revision, number: n, current } = await loadSpec(s, id, number)
    let items: Item[]
    let prelude = ''
    const r = rangeOf(s, {}, null, { from: spec.time?.from ?? 'now-1h', to: spec.time?.to ?? 'now' })
    if (view === 'spec') {
      items = specItems(spec)
    } else {
      const resolved = resolveSpec(spec, args.variables as Record<string, string | string[]> | undefined, r)
      prelude =
        `id: ${cell(spec.metadata.id, 48)}\ntitle: ${cell(spec.metadata.title, MAX.title)}\nintent: ${cell(spec.metadata.intent, MAX.text)}\n` +
        (spec.metadata.tags?.length ? `tags: ${spec.metadata.tags.map((t) => cell(t, 40)).join(', ')}\n` : '') +
        (spec.time ? `time: ${cell(spec.time.from, 40)} → ${cell(spec.time.to, 40)}\n` : '') +
        Object.entries(resolved.variables).map(([k, v]) => `variable ${cell(k, MAX.name)} = ${v.all ? '*' : v.values.map((x) => cell(x, 80)).join('|')}\n`).join('') +
        (resolved.issues.length ? `issues: ${resolved.issues.map((i) => cell(i.message, 160)).join(' ; ')}\n` : '')
      items = resolved.order.map((pid) => {
        const p = resolved.panels[pid]!
        const unit = 'unit' in p && p.unit ? p.unit : '-'
        const queries = p.kind === 'text' ? [] : p.queries
        const qText =
          view === 'resolved'
            ? queries.map((q) => `${cell(q, MAX.name)}: ${clean(resolved.queries[q]?.expr ?? '?', { kind: 'expr', max: MAX.long })}${resolved.queries[q]?.error ? ` (substitution failed: ${cell(resolved.queries[q]!.error, 160)})` : ''}`).join(' ; ')
            : queries.map((q) => cell(q, MAX.name)).join(', ')
        return {
          key: pid,
          text: `panel ${cell(pid, 100)} | ${p.kind} | ${cell(p.title, MAX.title)} | unit ${unit}${'thresholds' in p && p.thresholds?.length ? ` | thresholds ${p.thresholds.map((t) => `${'above' in t ? '>' + t.above : '<' + t.below} ${t.level}`).join(', ')}` : ''} | queries ${qText || '-'}\n`,
          data: cleanDeep({ id: pid, kind: p.kind, title: p.title, unit: 'unit' in p ? p.unit ?? null : null, description: p.description ?? null, queries: view === 'resolved' ? queries.map((q) => ({ id: q, expr: resolved.queries[q]?.expr, lang: resolved.queries[q]?.lang, ...(resolved.queries[q]?.error ? { error: resolved.queries[q]!.error } : {}) })) : queries, ...('thresholds' in p ? { thresholds: p.thresholds ?? [] } : {}) }, MAX.long),
        }
      })
      if (Object.keys(spec.fragments ?? {}).length) prelude += `fragments: ${Object.keys(spec.fragments!).map((f) => cell(f, MAX.name)).join(', ')}\n`
    }
    const altered = alteredPaths(spec)
    return pagedResult({
      tool: this.name,
      s,
      args,
      maxTokens: budgetOf(args.max_tokens, this.defaultTokens),
      header: `get_dashboard: view ${view}; revision ${n} (${revision})${current ? ', current' : ', not the current one'}; ${Object.keys(spec.panels).length} panel(s) in the spec.${view === 'spec' ? ' Send this revision as base_revision when changing it.' : ''}${altered.length ? ` ${altered.length} value(s) shown altered by cleaning.` : ''}\n`,
      items,
      offset: c?.o ?? 0,
      prelude: c ? '' : prelude,
      pinned: { n },
      meta: { view, revision, number: n, current },
      data: { altered: altered.slice(0, 100).map((p) => clean(p, { max: 120 })), ...(view === 'spec' && !c ? { id: clean(spec.metadata.id, { max: 48 }) } : {}) },
    })
  },
}

// ---- list_revisions ----

export const listRevisions: ToolDef = {
  name: 'list_revisions',
  title: 'List revisions',
  description: 'History of one dashboard, newest first: revision number and hash, when, who (person or agent, by name), kind (create, patch, apply of a proposal, revert), message, a one-line summary per change, and the proposal and proposer when a reviewed proposal was applied.',
  scopes: ['dashboards:read'],
  defaultTokens: 1000,
  readOnly: true,
  input: {
    type: 'object',
    additionalProperties: false,
    required: ['id'],
    properties: { id: ID_ARG, limit: { type: 'integer', minimum: 1, maximum: 50, default: 20, description: 'Revisions per page.' }, max_tokens: MAX_TOKENS_ARG(1000), cursor: CURSOR_ARG },
  },
  async run(s, args) {
    const c = cursorOf(this.name, args)
    const control = needControl(s)
    const remote = typeof c?.p?.rc === 'string' ? (c.p.rc as string) : undefined
    s.usage.upstreamCalls++
    const r = await control.call('GET', `/dashboards/${encodeURIComponent(String(args.id))}/revisions`, { query: { limit: String((args.limit as number | undefined) ?? 20), cursor: remote } })
    if (r.status !== 200) throw controlError(r, 'list revisions')
    const items: Item[] = (r.body.items as any[]).map((v) => ({
      key: String(v.number),
      text:
        `#${Number(v.number)} ${String(v.revision).slice(0, 12).replace(/[^0-9a-f]/g, '')} | ${cell(v.at, 30)} | ${actorText(v.by)} | ${cell(v.kind, 10)}` +
        (v.proposal ? ` | proposal ${cell(v.proposal, 40)} by ${actorText(v.proposedBy)}` : '') +
        (v.revertedTo ? ` | reverted to #${Number(v.revertedTo)}` : '') +
        ` | ${cell(v.message, 200)} | ${(v.summary as unknown[]).slice(0, 6).map((x) => cell(x, 160)).join(' ; ')}${(v.summary as unknown[]).length > 6 ? ' ; …' : ''}\n`,
      data: cleanDeep({ number: v.number, revision: v.revision, at: v.at, by: v.by, kind: v.kind, message: v.message, summary: v.summary, proposal: v.proposal, proposedBy: v.proposedBy, revertedTo: v.revertedTo }),
    }))
    const skip = typeof c?.p?.k === 'number' ? (c.p.k as number) : 0
    const hash = argsHash(args)
    const res = pagedResult({ tool: this.name, s, args, maxTokens: budgetOf(args.max_tokens, this.defaultTokens), header: `list_revisions: current revision is #${Number(r.body.current)}.\nColumns: number hash | at | by | kind | message | changes\n`, items, offset: skip, meta: { current: Number(r.body.current) } })
    const shownTo = skip + (res.structured.shown as number)
    let cursor: string | null = null
    if (shownTo < items.length) cursor = encodeCursor({ t: this.name, a: hash, o: shownTo, p: { ...(remote ? { rc: remote } : {}), k: shownTo } })
    else if (r.body.next) cursor = encodeCursor({ t: this.name, a: hash, o: 0, p: { rc: r.body.next, k: 0 } })
    return withCursor(res, cursor)
  },
}

// ---- read_dashboard ----

export const READ_DEFAULT_TOKENS = 2000

export const readDashboard: ToolDef = {
  name: 'read_dashboard',
  title: 'Read a dashboard',
  description:
    'Look at a dashboard with its data: runs every panel\'s queries over the range (default the dashboard\'s own time range) and returns one digest per panel — threshold state (CRIT, WARN, ok), value, min, max, mean, trend, outliers, gaps, "no data" — breaching and anomalous panels first, then the rest in layout order, within max_tokens (default 2,000). Panels whose queries failed, are TraceQL or LogQL (not available yet), or were not reached before the deadline say so. At most 40 panels and 6 queries at a time; a call stops starting queries after 10 s. Annotations are not available yet. Per-panel Explore links are in the structured result.',
  scopes: ['dashboards:read', 'read'],
  defaultTokens: READ_DEFAULT_TOKENS,
  readOnly: true,
  input: {
    type: 'object',
    additionalProperties: false,
    required: ['id'],
    properties: {
      id: ID_ARG,
      revision: { type: 'integer', minimum: 1, description: 'A revision number; default the current one.' },
      panels: { type: 'array', items: { type: 'string', maxLength: 100 }, maxItems: 40, description: 'Only these panel ids (fragment panels are "<instance>.<id>"). Default all.' },
      from: TIME_ARG('Start; default the dashboard\'s time range', 'now-1h'),
      to: TIME_ARG('End', 'now'),
      variables: VARIABLES_ARG,
      format: { type: 'string', enum: ['markdown', 'tsv'], default: 'markdown', description: 'markdown tables (default) or TSV, which is about half the size.' },
      top_k: { type: 'integer', minimum: 1, maximum: 20, default: 5, description: 'Series listed per panel, most important first.' },
      max_tokens: MAX_TOKENS_ARG(READ_DEFAULT_TOKENS),
      cursor: CURSOR_ARG,
    },
  },
  async run(s, args) {
    const c = cursorOf(this.name, args)
    const id = String(args.id)
    const number = typeof c?.p?.n === 'number' ? (c.p.n as number) : (args.revision as number | undefined)
    const { spec, revision, number: n } = await loadSpec(s, id, number)
    const r = rangeOf(s, args, c, { from: spec.time?.from ?? 'now-1h', to: spec.time?.to ?? 'now' })
    const resolved = resolveSpec(spec, args.variables as Record<string, string | string[]> | undefined, r)
    const wanted = Array.isArray(args.panels) ? (args.panels as string[]) : null
    if (wanted) {
      const missing = wanted.filter((p) => !(p in resolved.panels))
      if (missing.length) throw new ToolError('unknown-panel', `${missing.length} of the panel ids are not in this dashboard.`, 'Use panel ids from get_dashboard (view outline).', { status: 404, detail: `unknown: ${missing.map((m) => cell(m, 100)).join(', ')}\nknown: ${resolved.order.map((m) => cell(m, 100)).join(', ')}` })
    }
    const ids = (wanted ?? resolved.order).filter((p, i, a) => a.indexOf(p) === i)
    const evaluated = ids.slice(0, s.limits.maxPanels)
    const overLimit = ids.slice(s.limits.maxPanels)
    const topK = (args.top_k as number | undefined) ?? 5
    const t0 = performance.now()
    const runs = await runPanels(s, resolved, evaluated, r, { topK })
    for (const pid of overLimit) runs.push({ id: pid, digest: { id: pid, kind: resolved.panels[pid]!.kind, title: resolved.panels[pid]!.title, seriesCount: 0, series: [], omitted: { count: 0, crit: 0, warn: 0, outliers: 0 }, state: null, worst: null, outliers: 0, noData: true }, problem: { kind: 'limit', text: `not evaluated: more than ${s.limits.maxPanels} panels` }, unknownMetrics: [] })
    const ms = Math.round(performance.now() - t0)

    // Clean every tenant string; mark incomplete panels in their description so the text says why.
    const problems = new Map(runs.filter((x) => x.problem).map((x) => [x.id, x.problem!]))
    const panels: PanelDigest[] = runs.map((x) => {
      const d = cleanDigest(x.digest)
      const pr = x.problem
      return pr ? { ...d, description: `⚠ ${badgeOf(x.digest, pr)}: ${clean(pr.text, { max: MAX.error })}${d.description ? ` — ${d.description}` : ''}` } : d
    })
    const digest: DashboardDigest = {
      id: clean(spec.metadata.id, { max: 48 }),
      title: clean(spec.metadata.title, { max: MAX.title }),
      intent: clean(spec.metadata.intent, { max: MAX.text }),
      revision,
      range: { start: r.start, end: r.end },
      panels,
    }
    const vars = Object.entries(resolved.variables)
    if (vars.length) digest.variables = Object.fromEntries(vars.map(([k, v]) => [clean(k, { max: MAX.name }), v.all ? '*' : v.values.map((x) => clean(x, { max: 80 })).join('|')]))

    const counts = { crit: 0, warn: 0, info: 0, noData: 0, failed: 0, notEvaluated: 0, outliers: 0 }
    for (const x of runs) {
      if (x.problem?.kind === 'error' || x.problem?.kind === 'substitution') counts.failed++
      else if (x.problem && x.problem.kind !== 'unsupported') counts.notEvaluated++
      if (x.digest.state === 'crit') counts.crit++
      else if (x.digest.state === 'warn') counts.warn++
      else if (x.digest.state === 'info') counts.info++
      if (x.digest.noData) counts.noData++
      if (x.digest.outliers) counts.outliers++
    }
    const complete = counts.failed === 0 && counts.notEvaluated === 0
    const budget = charsFor(budgetOf(args.max_tokens, this.defaultTokens))
    const header =
      `read_dashboard: revision ${n} (${revision.slice(0, 12)}); ${rangeText(r)}; ${runs.length} panel(s): ${counts.crit} crit, ${counts.warn} warn, ${counts.outliers} with outliers, ${counts.noData} no data, ${counts.failed} failed, ${counts.notEvaluated} not evaluated; ${complete ? 'complete' : 'partial'}; ${s.usage.queries} queries in ${ms} ms. Breaching and anomalous panels come first. Annotations: not available yet.\n`
    const hash = argsHash(args)
    const cursorFor = (o: number) => encodeCursor({ t: this.name, a: hash, o, p: { ...pinRange(r), n } })
    const footerReserve = `Truncated: ${runs.length} of ${runs.length} panels not shown in full. Call again with cursor "${cursorFor(runs.length)}" to continue.\n`.length
    const inner = Math.floor((budget - header.length - DATA_NOTICE.length - 1 - FENCE_OVERHEAD - footerReserve) / 4)
    const offset = c?.o ?? 0
    const format = (args.format as 'markdown' | 'tsv' | undefined) ?? 'markdown'
    // No continuation line from the package: it would name its internal cursor; ours goes outside the data block.
    const rendered = renderDigest(digest, { format, maxTokens: Math.max(0, inner), cursor: `o:${offset}`, continuation: false })
    const body = rendered.text
    const nextOffset = rendered.cursor ? Number(rendered.cursor.slice(2)) : null
    const cursor = nextOffset !== null ? cursorFor(nextOffset) : null
    let text = header + DATA_NOTICE + '\n' + fenced(body)
    if (cursor) text += `Truncated: ${runs.length - nextOffset!} of ${runs.length} panels not shown in full. Call again with cursor "${cursor}" to continue.\n`
    else if (rendered.truncated) text += 'Truncated: some series were left out of a panel to fit max_tokens.\n'
    if (text.length > budget) text = text.slice(0, budget)

    // The order the text was written in (the package's own), so the structure lists the same panels.
    const ordered = panelOrder(panels).map((i) => ({ p: panels[i]!, i }))
    // Panels this page consumed: the cursor moves past a panel shown cut to fit, so it is listed (marked cut).
    const consumed = (nextOffset ?? runs.length) - Math.min(offset, runs.length)
    const shown = ordered.slice(offset, offset + consumed).map(({ p, i }, j) => {
      const run = runs[i]!
      return {
        ...p,
        ...(j >= rendered.panelsShown ? { cut: true } : {}),
        badge: badgeOf(run.digest, run.problem),
        ...(run.problem ? { problem: { kind: run.problem.kind, text: clean(run.problem.text, { max: MAX.error }) } } : {}),
        ...(run.expr ? { link: exploreLink(s.appUrl, run.expr, r, 'unit' in p ? p.unit : undefined) } : {}),
      }
    })
    return {
      text,
      isError: false,
      structured: {
        tool: this.name,
        ok: true,
        truncated: rendered.truncated || cursor !== null,
        cursor,
        tokens: tokensOf(text),
        usage: { ...s.usage, ms },
        revision,
        number: n,
        range: { start: r.start, end: r.end, step: r.step },
        panelsTotal: runs.length,
        panelsShown: rendered.panelsShown,
        panelsOnPage: consumed,
        offset,
        counts,
        complete,
        annotations: 'not available yet',
        data: { dashboard: { id: digest.id, title: digest.title, intent: digest.intent, variables: digest.variables ?? {} }, panels: shown },
      },
    }
  },
}

export type { PanelRun }
export { isoOf, canonicalJson }
