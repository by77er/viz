import {
  type Dashboard,
  type Issue,
  type PatchOp,
  applyOps,
  canonicalJson,
  diff,
  formatNumber,
  lint,
  summarizeDiff,
  validate,
} from '../../../dashboard/src/index.ts'
import { CURSOR_ARG, MAX_TOKENS_ARG, TIME_ARG, VARIABLES_ARG } from '../args'
import { hasScopes } from '../auth'
import type { ControlResponse } from '../clients'
import { budgetOf, type Item } from '../page'
import type { Session } from '../session'
import { type ToolDef, ToolError, pagedResult } from '../tool'
import { cell, clean, cleanDeep, MAX } from '../untrusted'
import { type PanelRun, badgeOf, cleanDigest, controlError, cursorOf, pinRange, rangeOf, rangeText, resolveSpec, runPanels } from './common'
import { ID_ARG, loadSpec } from './dashboards'

const OP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['op', 'path'],
  properties: {
    op: { type: 'string', enum: ['add', 'remove', 'replace', 'move', 'copy', 'test'] },
    path: { type: 'string', maxLength: 500, description: 'JSON Pointer, e.g. /panels/p_err/title. Panels are a map by id, so /panels/<id> never shifts.' },
    from: { type: 'string', maxLength: 500 },
    value: { description: 'Any JSON value.' },
  },
} as const

const CHANGE_NAME = '^[a-z][a-z0-9_-]{0,47}$'

/** Signs that a string is a copy of cleaned display text rather than what is stored. */
const SANITIZED = /…\[\+\d+ chars\]|…\[cut to fit|\bhxxps?\[:\/\/\]|\b(?:javascript|vbscript|mailto|data)\[:\]|\bwww\[\.\]| ⏎ |�/

function sanitizedCopies(value: unknown, path: string, out: string[]): void {
  if (out.length >= 20) return
  if (typeof value === 'string') {
    if (SANITIZED.test(value)) out.push(path)
  } else if (Array.isArray(value)) value.forEach((v, i) => sanitizedCopies(v, `${path}/${i}`, out))
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) sanitizedCopies(v, `${path}/${k}`, out)
}

/** Panels of `after` that are new or whose definition or resolved queries differ from `before`. */
function changedPanels(before: Dashboard | null, after: Dashboard, s: Session, vars: Record<string, string | string[]> | undefined, r: { start: number; end: number; step: number }): { ids: string[]; removed: string[] } {
  const ra = resolveSpec(after, vars, r)
  const shape = (res: ReturnType<typeof resolveSpec>, id: string) => {
    const p = res.panels[id]!
    const { source: _s, instance: _i, ...panel } = p
    const queries = p.kind === 'text' ? [] : p.queries.map((q) => res.queries[q] ? { lang: res.queries[q]!.lang, expr: res.queries[q]!.expr, instant: res.queries[q]!.instant ?? false } : null)
    return canonicalJson({ panel, queries })
  }
  if (!before) return { ids: ra.order, removed: [] }
  const rb = resolveSpec(before, vars, r)
  const ids = ra.order.filter((id) => !(id in rb.panels) || shape(rb, id) !== shape(ra, id))
  const removed = rb.order.filter((id) => !(id in ra.panels))
  void s
  return { ids, removed }
}

interface Warning {
  code: string
  /** Untrusted: may name panels, metrics, paths. */
  text: string
  suggestions?: string[]
}

function previewText(run: PanelRun): string {
  const d = cleanDigest(run.digest)
  const b = badgeOf(run.digest, run.problem)
  const top = d.series.slice(0, 3).map((x) => `${cell(x.name)} = ${formatNumber(x.value)}${x.state && x.state !== 'ok' ? ` (${x.state.toUpperCase()}${x.breached ? ' ' + x.breached : ''})` : ''}`).join(' ; ')
  return `preview ${cell(run.id, 100)}: [${b || 'ok'}] ${d.kind}${d.unit ? `, ${d.unit}` : ''} "${cell(d.title, MAX.title)}"; ${d.seriesCount} series${top ? `; top: ${top}` : ''}${run.problem ? `; ${clean(run.problem.text, { max: MAX.error })}` : ''}\n`
}

export const writeDashboard: ToolDef = {
  name: 'write_dashboard',
  title: 'Write a dashboard',
  description:
    'Create or change a dashboard. mode "dry_run" (the default) writes nothing: it validates against viz.dashboard/v1, lints, summarises the diff, runs the queries of every new or changed panel over the range and reports "no data", failed queries and metric names this tenant does not have (with near names) as warnings, and asks the control plane what applying would do. mode "propose" creates a proposal of named changes, each with a reason, for a person to accept whole or in part. mode "apply" writes a new revision; it is refused for agent keys unless the tenant allows agents to apply, and the refusal says to propose instead. Give one of: spec (a whole new dashboard, or a replacement for id), ops (RFC 6902 against base_revision) or changes (named groups of ops with reasons). Get base_revision from get_dashboard view "spec".',
  scopes: ['dashboards:write', 'read'],
  defaultTokens: 2000,
  readOnly: false,
  input: {
    type: 'object',
    additionalProperties: false,
    properties: {
      id: { ...ID_ARG, description: 'The dashboard to change. Omit to create one from spec.' },
      spec: { type: 'object', description: 'A whole viz.dashboard/v1 spec (see get_schema).' },
      ops: { type: 'array', items: OP_SCHEMA, minItems: 1, maxItems: 200, description: 'RFC 6902 operations against base_revision.' },
      changes: {
        type: 'array',
        minItems: 1,
        maxItems: 50,
        description: 'Named changes for a reviewer to accept one by one.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'reason', 'ops'],
          properties: {
            name: { type: 'string', pattern: CHANGE_NAME, description: 'e.g. "add_error_panel".' },
            reason: { type: 'string', minLength: 1, maxLength: 500, description: 'Why, for the reviewer.' },
            ops: { type: 'array', items: OP_SCHEMA, minItems: 1, maxItems: 200 },
          },
        },
      },
      base_revision: { type: 'string', pattern: '^[0-9a-f]{32}$', description: 'The revision the change was made against (get_dashboard view "spec"). Required to propose or apply a change to an existing dashboard.' },
      mode: { type: 'string', enum: ['dry_run', 'propose', 'apply'], default: 'dry_run', description: 'dry_run (default, writes nothing), propose, or apply.' },
      message: { type: 'string', maxLength: 500, description: 'What and why, for the revision or proposal.' },
      from: TIME_ARG('Preview range start; default the dashboard\'s time range', 'now-1h'),
      to: TIME_ARG('Preview range end', 'now'),
      variables: VARIABLES_ARG,
      max_tokens: MAX_TOKENS_ARG(2000),
      cursor: CURSOR_ARG,
    },
  },
  async run(s, args) {
    const c = cursorOf(this.name, args)
    const mode = (args.mode as 'dry_run' | 'propose' | 'apply' | undefined) ?? 'dry_run'
    const id = args.id as string | undefined
    const given = ['spec', 'ops', 'changes'].filter((k) => args[k] !== undefined)
    if (given.length !== 1) throw new ToolError('invalid-arguments', `Give exactly one of spec, ops or changes (got ${given.length}).`, 'spec for a whole dashboard; ops or changes (with id and base_revision) for an edit.')
    if (!id && args.spec === undefined) throw new ToolError('invalid-arguments', 'ops and changes edit an existing dashboard and need id.', 'Add id, or send a whole spec to create one.')
    if (mode === 'apply' && !hasScopes(s.id, ['dashboards:apply'])) {
      throw new ToolError('apply-refused', 'This key may not apply changes: it lacks the dashboards:apply scope. Nothing was written.', 'Call write_dashboard again with mode "propose" and the same arguments; a person reviews and applies the proposal.', { status: 403, meta: { offer: { mode: 'propose' } } })
    }
    if (!s.control) throw new ToolError('not-available-yet', 'The control plane is not connected to this deployment.', 'Ask the operator to bind CONTROL.', { status: 501 })

    // 1. The dashboard as it is now, and the change as named groups of ops.
    let before: Dashboard | null = null
    let current: { revision: string; number: number } | null = null
    if (id) {
      const cur = await loadSpec(s, id)
      before = cur.spec
      current = { revision: cur.revision, number: cur.number }
      if (args.base_revision === undefined && mode !== 'dry_run') {
        throw new ToolError('base-required', 'Proposing or applying a change needs the revision it was made against.', `Send base_revision; the current one is ${cur.revision.replace(/[^0-9a-f]/g, '')} (get_dashboard view "spec" shows it).`, { status: 428 })
      }
    }
    const base = (args.base_revision as string | undefined) ?? current?.revision
    const message = (args.message as string | undefined) ?? ''
    let changes: { name: string; reason: string; ops: PatchOp[] }[] = []
    if (args.changes) changes = args.changes as typeof changes
    else if (args.ops) changes = [{ name: 'change', reason: message || 'Change proposed by an agent', ops: args.ops as PatchOp[] }]
    else if (before) changes = [{ name: 'replace', reason: message || 'Replacement proposed by an agent', ops: diff(before, args.spec as Dashboard) }]
    const flatOps = changes.flatMap((ch) => ch.ops)
    if (before && args.spec !== undefined && flatOps.length === 0) throw new ToolError('no-change', 'The spec is the same as the current revision.', 'Nothing to do.', { status: 409 })

    // 2. The candidate spec, locally.
    let candidate: Dashboard | null = null
    let patchFailure: { change: string; index: number; message: string } | null = null
    if (!before) candidate = args.spec as Dashboard
    else {
      let doc: unknown = before
      for (const ch of changes) {
        const r = applyOps(doc, ch.ops)
        if (!r.ok) {
          patchFailure = { change: ch.name, index: r.error.index, message: r.error.message }
          break
        }
        doc = r.doc
      }
      if (!patchFailure) candidate = doc as Dashboard
    }
    const validation = candidate ? validate(candidate) : null
    const valid = validation?.ok === true
    if (valid && id && candidate!.metadata.id !== id) throw new ToolError('invalid-arguments', 'A change cannot alter metadata.id.', 'Keep metadata.id, or create a new dashboard under the new id.')
    const lints: Issue[] = valid ? lint(candidate!) : []
    const summary = valid ? (before ? summarizeDiff(before, candidate!) : [`+ new dashboard with ${Object.keys(candidate!.panels).length} panel(s)`]) : []

    // 3. Preview: run every new or changed panel over the range. "No data" is a warning, never hidden.
    const warnings: Warning[] = []
    const copies: string[] = []
    sanitizedCopies(args.spec ?? args.ops ?? args.changes, '', copies)
    for (const p of copies) warnings.push({ code: 'sanitized-copy', text: `the value at ${clean(p, { max: 120 })} looks copied from cleaned display text (a truncation marker, a defanged URL or a replaced character); it would be stored as shown` })
    let previews: PanelRun[] = []
    let removed: string[] = []
    const r = rangeOf(s, args, c, { from: candidate?.time?.from ?? before?.time?.from ?? 'now-1h', to: candidate?.time?.to ?? before?.time?.to ?? 'now' })
    if (valid) {
      const changed = changedPanels(before, candidate!, s, args.variables as Record<string, string | string[]> | undefined, r)
      removed = changed.removed
      const resolved = resolveSpec(candidate!, args.variables as Record<string, string | string[]> | undefined, r)
      previews = await runPanels(s, resolved, changed.ids.slice(0, s.limits.maxPanels), r, { topK: 3, checkNames: true })
      for (const pid of changed.ids.slice(s.limits.maxPanels)) warnings.push({ code: 'not-previewed', text: `panel ${clean(pid, { max: 100 })}: not previewed (more than ${s.limits.maxPanels} changed panels)` })
      for (const run of previews) {
        for (const u of run.unknownMetrics) warnings.push({ code: 'unknown-metric', text: `panel ${clean(run.id, { max: 100 })} reads metric ${JSON.stringify(clean(u.name, { max: MAX.name }))}, which has no data in this tenant`, ...(u.suggestions.length ? { suggestions: u.suggestions } : {}) })
        if (run.problem) warnings.push({ code: run.problem.kind === 'deadline' ? 'not-evaluated' : run.problem.kind === 'unsupported' ? 'not-available-yet' : 'query-failed', text: `panel ${clean(run.id, { max: 100 })}: ${clean(run.problem.text, { max: MAX.error })}` })
        else if (run.digest.noData && run.digest.kind !== 'text') warnings.push({ code: 'no-data', text: `panel ${clean(run.id, { max: 100 })} returned no data over ${rangeText(r)}` })
      }
    }

    // 4. What the control plane says, or does.
    let outcome = ''
    let controlDetail = ''
    const meta: Record<string, unknown> = { mode, valid, range: { start: r.start, end: r.end, step: r.step } }
    const dryRunAt = async (): Promise<ControlResponse> => {
      s.usage.upstreamCalls++
      return id
        ? s.control!.call('PATCH', `/dashboards/${encodeURIComponent(id)}`, { body: { ops: flatOps, baseRevision: base, ...(message ? { message } : {}), dryRun: true } })
        : s.control!.call('POST', '/dashboards', { body: { spec: candidate, ...(message ? { message } : {}), dryRun: true } })
    }
    const refuseApply = (why: string): never => {
      throw new ToolError('apply-refused', `${why} Nothing was written.`, id ? 'Call write_dashboard again with mode "propose" and the same changes; a person reviews and applies them. An admin can allow agents to apply with the tenant setting "agentsMayApply".' : 'Ask a person with dashboards:apply to create it; proposals to create a dashboard are not available yet.', { status: 403, meta: { offer: id ? { mode: 'propose' } : null }, detail: controlDetail || undefined })
    }
    if (!valid) {
      if (mode !== 'dry_run') {
        throw new ToolError('invalid-dashboard', `The change does not make a valid dashboard (${patchFailure ? 'an operation failed' : `${validation?.errors.length ?? 0} error(s)`}). Nothing was written.`, 'Fix the errors listed (each has a path and usually a suggestion) and dry-run again.', {
          status: 422,
          detail: patchFailure ? `change ${clean(patchFailure.change, { max: 48 })}, operation ${patchFailure.index}: ${clean(patchFailure.message, { max: MAX.error })}` : (validation?.errors ?? []).slice(0, 20).map((e) => `${clean(e.path, { max: 120 })}: ${clean(e.message, { max: MAX.error })}${e.suggestion ? ` (${clean(e.suggestion, { max: MAX.error })})` : ''}`).join('\n'),
        })
      }
      outcome = 'invalid; nothing was written'
    } else if (mode === 'dry_run') {
      const res = await dryRunAt()
      const b = res.body ?? {}
      if (id && res.status === 200) outcome = b.outcome === 'unchanged' ? 'nothing was written; applying would change nothing' : `nothing was written; apply would create revision ${Number(b.number)}`
      else if (id && res.status === 202) outcome = 'nothing was written; this key may not apply here, so apply would be refused: use mode "propose"'
      else if (!id && res.status === 201) outcome = b.permitted === false ? 'nothing was written; this key may not create dashboards here' : 'nothing was written; apply would create the dashboard'
      else {
        outcome = `nothing was written; the control plane would refuse (HTTP ${res.status})`
        controlDetail = [typeof b.code === 'string' ? `code: ${cell(b.code, 40)}` : '', typeof b.detail === 'string' ? `detail: ${clean(b.detail, { max: MAX.error })}` : '', Array.isArray(b.errors) ? b.errors.slice(0, 10).map((e: any) => `${clean(e.path, { max: 120 })}: ${clean(e.message, { max: MAX.error })}`).join('\n') : ''].filter(Boolean).join('\n')
      }
      meta.wouldApply = (id && res.status === 200) || (!id && res.status === 201 && b.permitted !== false)
    } else if (mode === 'propose') {
      if (!id) throw new ToolError('propose-needs-existing', 'Proposals to create a dashboard are not available yet; the control plane holds proposals for existing dashboards only. Nothing was written.', 'Ask a person with dashboards:apply to create it, or (if the tenant allows agents to apply) use mode "apply".', { status: 409 })
      s.usage.upstreamCalls++
      const res = await s.control.call('POST', `/dashboards/${encodeURIComponent(id)}/proposals`, { body: { changes, message: message || 'Proposed by an agent', baseRevision: base } })
      if (res.status !== 202) throw controlError(res, 'store the proposal')
      const p = res.body.proposal
      const pid = /^p_[A-Za-z0-9]{22}$/.test(String(p?.id)) ? String(p.id) : null
      outcome = `proposal ${pid ?? '(see data)'} created with ${changes.length} named change(s); a person reviews it and can accept any of them`
      meta.proposal = { id: pid, status: 'open', changes: changes.length, expiresAt: typeof p?.expiresAt === 'string' ? p.expiresAt : null }
      controlDetail = `review: ${(res.body.review?.summary ?? []).slice(0, 10).map((x: unknown) => cell(x, 160)).join(' ; ')}`
    } else {
      // apply: ask first. The control plane turns an agent's write into a proposal unless the
      // tenant allows agents to apply; this surface refuses instead of proposing silently.
      const dry = await dryRunAt()
      if (id && dry.status === 202) refuseApply('Agents may not apply changes in this tenant.')
      if (!id && dry.status === 201 && dry.body?.permitted === false) refuseApply('Agents may not create dashboards in this tenant.')
      if ((id && dry.status !== 200) || (!id && dry.status !== 201)) throw controlError(dry, 'apply the change')
      s.usage.upstreamCalls++
      const res = id
        ? await s.control.call('PATCH', `/dashboards/${encodeURIComponent(id)}`, { body: { ops: flatOps, baseRevision: base, ...(message ? { message } : {}), propose: false } })
        : await s.control.call('POST', '/dashboards', { body: { spec: candidate, ...(message ? { message } : {}) } })
      if (res.status === 202) {
        outcome = 'the control plane stored it as a proposal instead (the tenant setting changed between the check and the write)'
        meta.proposal = { id: /^p_[A-Za-z0-9]{22}$/.test(String(res.body?.proposal?.id)) ? res.body.proposal.id : null, status: 'open' }
      } else if (res.status === 200 || res.status === 201) {
        outcome = res.body.outcome === 'unchanged' ? 'nothing changed' : `applied as revision ${Number(res.body.number)}`
        meta.applied = { number: Number(res.body.number), revision: String(res.body.revision).replace(/[^0-9a-f]/g, '') }
      } else throw controlError(res, 'apply the change')
    }

    const items: Item[] = []
    if (patchFailure) items.push({ key: 'patch', text: `error patch-failed: change ${cell(patchFailure.change, 48)}, operation ${patchFailure.index}: ${cell(patchFailure.message, MAX.error)}\n`, data: cleanDeep(patchFailure) })
    for (const [i, e] of (validation?.errors ?? []).entries()) items.push({ key: `err${i}`, text: `error ${cell(e.code, 40)} at ${cell(e.path, 120)}: ${cell(e.message, MAX.error)}${e.suggestion ? ` Suggestion: ${cell(e.suggestion, MAX.error)}` : ''}\n`, data: cleanDeep(e, MAX.error) })
    for (const [i, w] of warnings.entries()) items.push({ key: `warn${i}`, text: `warning ${w.code}: ${w.text}${w.suggestions?.length ? `. Did you mean: ${w.suggestions.map((x) => cell(x, MAX.name)).join(', ')}?` : ''}\n`, data: { code: w.code, text: w.text, ...(w.suggestions ? { suggestions: w.suggestions.map((x) => clean(x, { max: MAX.name })) } : {}) } })
    for (const [i, l] of lints.entries()) items.push({ key: `lint${i}`, text: `lint ${cell(l.code, 40)} at ${cell(l.path, 120)}: ${cell(l.message, MAX.error)}${l.suggestion ? ` Suggestion: ${cell(l.suggestion, MAX.error)}` : ''}\n`, data: cleanDeep(l, MAX.error) })
    for (const [i, line] of summary.entries()) items.push({ key: `diff${i}`, text: `change ${cell(line, MAX.text)}\n`, data: { diff: clean(line, { max: MAX.text }) } })
    for (const pid of removed) items.push({ key: `rm:${pid}`, text: `removed panel ${cell(pid, 100)}\n`, data: { removed: clean(pid, { max: 100 }) } })
    for (const run of previews) items.push({ key: `pv:${run.id}`, text: previewText(run), data: { preview: { ...cleanDigest(run.digest), badge: badgeOf(run.digest, run.problem), ...(run.problem ? { problem: clean(run.problem.text, { max: MAX.error }) } : {}) } } })
    if (controlDetail) items.push({ key: 'control', text: `control plane: ${controlDetail.replace(/\n/g, ' ; ')}\n`, data: { control: controlDetail } })

    const counts = { errors: (validation?.errors.length ?? 0) + (patchFailure ? 1 : 0), warnings: warnings.length, noData: warnings.filter((w) => w.code === 'no-data').length, unknownMetrics: warnings.filter((w) => w.code === 'unknown-metric').length, lint: lints.length, changes: summary.length, previewed: previews.length }
    const header =
      `write_dashboard ${mode}: ${valid ? 'valid' : 'NOT valid'}; ${counts.errors} error(s), ${counts.warnings} warning(s) (${counts.noData} no data, ${counts.unknownMetrics} unknown metric), ${counts.lint} lint, ${counts.changes} change line(s), ${counts.previewed} panel(s) previewed over ${rangeText(r)}.\n` +
      `Outcome: ${outcome}.\n` +
      (changes.length > 1 || args.changes ? `Named changes: ${changes.length}.\n` : '')
    return pagedResult({
      tool: this.name,
      s,
      args,
      maxTokens: budgetOf(args.max_tokens, this.defaultTokens),
      header,
      items,
      offset: c?.o ?? 0,
      pinned: pinRange(r),
      meta: { ...meta, counts, ...(current ? { baseRevision: (base ?? '').replace(/[^0-9a-f]/g, ''), currentRevision: current.revision.replace(/[^0-9a-f]/g, ''), currentNumber: current.number } : {}) },
      data: { changes: changes.map((ch) => ({ name: clean(ch.name, { max: 48 }), reason: clean(ch.reason, { max: MAX.text }), ops: ch.ops.length })) },
    })
  },
}
