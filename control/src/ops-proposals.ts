import { type Dashboard, type Issue, type PatchOp, applyOps, diff, lint, parsePointer, revisionOf, summarizeDiff, validate } from '../../dashboard/src/index.ts'
import { DAY_MS } from './caps'
import { Problem, invalid, notFound } from './errors'
import type { Actor } from './identity'
import { type DashRow, baseOf, checkTenantBytes, commitRevision, dashboardView, invalidDashboard, loadDashboard, parseOps, specAt, staleProblem } from './ops-dashboards'
import { general } from './ops-settings'
import type { Ctx, Op, Tenant } from './tenant'
import type { OpResult } from './routes'
import { decodeCursor, encodeCursor, fields, isRecord, iso, pageLimit, randomId, str, utf8Length } from './util'

/**
 * Proposed changes: the agent-first way to edit a dashboard.
 *
 * A proposal is a list of named changes, each a group of RFC 6902 ops with a reason, made
 * against a base revision. Nothing changes until someone with the right to apply accepts
 * it, whole or change by change. Whenever it is shown or applied it is evaluated against
 * the dashboard as it is NOW, never against the base it was written for.
 */

export interface Change {
  name: string
  reason: string
  ops: PatchOp[]
}

interface PropRow {
  id: string
  dashboard: string
  base_revision: string
  base_number: number
  message: string
  changes: string
  status: 'open' | 'applied' | 'declined' | 'expired'
  created_at: number
  by: string
  editors: string
  expires_at: number
  resolved_at: number | null
  resolved_by: string | null
  reason: string | null
  applied_number: number | null
  applied_changes: string | null
}

const COLUMNS = 'id, dashboard, base_revision, base_number, message, changes, status, created_at, by, editors, expires_at, resolved_at, resolved_by, reason, applied_number, applied_changes'
const CHANGE_NAME = /^[a-z][a-z0-9_-]{0,47}$/

function load(t: Tenant, id: string): PropRow {
  const row = t.one<PropRow>(`SELECT ${COLUMNS} FROM proposals WHERE tenant = ? AND id = ?`, t.tenant, id)
  if (!row) throw notFound('proposal')
  return row
}

/** An open proposal past its date is expired whether or not the alarm has got to it yet. */
const statusOf = (row: PropRow, now: number): PropRow['status'] => (row.status === 'open' && row.expires_at <= now ? 'expired' : row.status)

function view(row: PropRow, now: number, withOps: boolean): Record<string, unknown> {
  const changes = JSON.parse(row.changes) as Change[]
  return {
    id: row.id,
    dashboard: row.dashboard,
    status: statusOf(row, now),
    message: row.message,
    by: JSON.parse(row.by) as Actor,
    editedBy: JSON.parse(row.editors) as Actor[],
    createdAt: iso(row.created_at),
    expiresAt: iso(row.expires_at),
    baseRevision: row.base_revision,
    baseNumber: row.base_number,
    changes: changes.map((ch) => (withOps ? ch : { name: ch.name, reason: ch.reason, ops: ch.ops.length })),
    resolvedAt: iso(row.resolved_at),
    resolvedBy: row.resolved_by === null ? null : (JSON.parse(row.resolved_by) as Actor),
    declineReason: row.reason,
    appliedNumber: row.applied_number,
    appliedChanges: row.applied_changes === null ? null : (JSON.parse(row.applied_changes) as string[]),
  }
}

export function parseChanges(t: Tenant, b: Record<string, unknown>, fallbackReason: string): Change[] {
  if (b.changes !== undefined && b.ops !== undefined) throw invalid('Send "changes" or "ops", not both.', 'Use "changes" to group ops into named, separately acceptable changes.')
  if (b.changes === undefined) return [{ name: 'change', reason: str(b.reason, 'reason', { max: 500, optional: true }) ?? fallbackReason, ops: parseOps(t, b.ops) }]
  if (!Array.isArray(b.changes) || b.changes.length === 0 || b.changes.length > 50) throw invalid('"changes" must be a list of 1 to 50 changes.', 'Send [{"name":"add_dependency_latency","reason":"…","ops":[…]}].', { field: 'changes' })
  const seen = new Set<string>()
  let total = 0
  const out = b.changes.map((raw, i) => {
    const ch = fields(raw, ['name', 'reason', 'ops'], `change ${i}`)
    if (!isRecord(raw)) throw invalid(`Change ${i} must be an object.`, 'Send {"name","reason","ops"}.')
    const name = str(ch.name, `changes/${i}/name`, { max: 48 })!
    if (!CHANGE_NAME.test(name)) throw invalid(`Change name "${name}" is not valid.`, 'Use a lowercase letter, then lowercase letters, digits, "_" or "-"; at most 48 characters.', { field: `changes/${i}/name` })
    if (seen.has(name)) throw invalid(`Two changes are named "${name}".`, 'Give every change its own name; a reviewer accepts changes by name.', { field: `changes/${i}/name` })
    seen.add(name)
    const ops = parseOps(t, ch.ops, `changes/${i}/ops`)
    total += ops.length
    // Every change says why: the reviewer reads the reason next to the diff.
    return { name, reason: str(ch.reason, `changes/${i}/reason`, { max: 500 })!, ops }
  })
  if (total > t.caps.maxOpsPerRequest) throw invalid(`The proposal has ${total} operations; the most is ${t.caps.maxOpsPerRequest}.`, 'Split it into several proposals.')
  return out
}

/** The part of a pointer that names a map entry: cut at the first array index, because indices shift. */
function stablePrefix(path: string): string[] {
  const tokens = parsePointer(path) ?? []
  const cut = tokens.findIndex((tok) => /^(?:\d+|-)$/.test(tok))
  return cut < 0 ? tokens : tokens.slice(0, cut)
}

const overlaps = (a: string[], b: string[]): boolean => {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false
  return true
}

function touched(ops: PatchOp[]): string[][] {
  const out: string[][] = []
  for (const op of ops) {
    if (op.op === 'test') continue
    out.push(stablePrefix(op.path))
    if ('from' in op) out.push(stablePrefix(op.from))
  }
  return out
}

interface Evaluation {
  moved: boolean
  changes: { name: string; reason: string; ops: PatchOp[]; applies: boolean; error?: string; conflicts: string[]; summary: string[] }[]
  /** The spec after the chosen changes, when every one applied. */
  result: Dashboard | null
  errors: Issue[]
  /** The dashboard moved and the changes no longer fit it: someone has to rebuild them. */
  needsRebase: boolean
  /** The chosen changes do not work even on the base they were written for (a partial selection that depends on a change left out). */
  selectionInvalid: boolean
  reasons: string[]
  summary: string[]
}

function sequence(start: Dashboard, changes: Change[]): { doc: unknown; failed: { name: string; error: string }[]; steps: { before: unknown; after: unknown }[] } {
  let doc: unknown = start
  const failed: { name: string; error: string }[] = []
  const steps: { before: unknown; after: unknown }[] = []
  for (const ch of changes) {
    const r = applyOps(doc, ch.ops)
    if (!r.ok) {
      failed.push({ name: ch.name, error: `Operation ${r.error.index} failed: ${r.error.message}` })
      steps.push({ before: doc, after: doc })
      continue
    }
    steps.push({ before: doc, after: r.doc })
    doc = r.doc
  }
  return { doc, failed, steps }
}

const safeSummary = (a: unknown, b: unknown, ops: PatchOp[]): string[] => {
  // A step between two changes can be a spec that is not valid on its own; describe it by its ops then.
  if (validate(a).ok && validate(b).ok) return summarizeDiff(a as Dashboard, b as Dashboard)
  return ops.map((op) => `${op.op} ${op.path}`)
}

/**
 * Evaluate the chosen changes against the dashboard as it is now.
 *
 * Clean means all three: every op applies, the result is a valid dashboard, and no change
 * touches a part of the dashboard that was edited since the base revision. The third check
 * is what stops a `replace` from silently overwriting someone else's newer edit.
 */
export function evaluate(t: Tenant, dash: DashRow, row: PropRow, chosen: Change[]): Evaluation {
  const current = specAt(t, dash.id, dash.head)
  const moved = dash.revision !== row.base_revision
  const underneath = moved ? diff(specAt(t, dash.id, row.base_number), current).map((op) => ({ path: op.path, prefix: stablePrefix(op.path) })) : []
  const run = sequence(current, chosen)
  const reasons: string[] = []
  const changes = chosen.map((ch, i) => {
    const failure = run.failed.find((f) => f.name === ch.name)
    const mine = touched(ch.ops)
    const conflicts = [...new Set(underneath.filter((u) => mine.some((m) => overlaps(m, u.prefix))).map((u) => u.path))]
    if (failure) reasons.push(`Change "${ch.name}" no longer applies: ${failure.error}`)
    if (conflicts.length) reasons.push(`Change "${ch.name}" touches what was edited since revision ${row.base_number}: ${conflicts.slice(0, 5).join(', ')}`)
    const step = run.steps[i]!
    return { ...ch, applies: !failure, ...(failure ? { error: failure.error } : {}), conflicts, summary: failure ? [] : safeSummary(step.before, step.after, ch.ops) }
  })
  const v = run.failed.length ? { ok: false, errors: [] as Issue[] } : validate(run.doc)
  if (!run.failed.length && !v.ok) reasons.push(`The result would not be a valid dashboard (${v.errors.length} error${v.errors.length === 1 ? '' : 's'}).`)
  const clean = run.failed.length === 0 && v.ok && changes.every((ch) => ch.conflicts.length === 0)
  let selectionInvalid = false
  if (!clean && (run.failed.length > 0 || !v.ok)) {
    // Is the dashboard having moved to blame, or the selection itself?
    const onBase = moved ? sequence(specAt(t, dash.id, row.base_number), chosen) : run
    selectionInvalid = onBase.failed.length > 0 || !validate(onBase.doc).ok
  }
  const result = run.failed.length === 0 && v.ok ? (run.doc as Dashboard) : null
  return {
    moved,
    changes,
    result,
    errors: v.errors,
    needsRebase: moved && !clean && !selectionInvalid,
    selectionInvalid,
    reasons,
    summary: result ? summarizeDiff(current, result) : [],
  }
}

function review(dash: DashRow, ev: Evaluation): Record<string, unknown> {
  return {
    current: { revision: dash.revision, number: dash.head },
    moved: ev.moved,
    needsRebase: ev.needsRebase,
    reasons: ev.reasons,
    changes: ev.changes.map(({ ops: _ops, reason: _reason, ...rest }) => rest),
    summary: ev.summary,
    result: ev.result ? { revision: revisionOf(ev.result), number: dash.head + 1, lint: lint(ev.result) } : null,
    errors: ev.errors,
  }
}

const hasApplyScope = (c: Ctx): boolean => c.id.scopes.includes('dashboards:apply') || c.id.scopes.includes('admin')

/** Validate changes against the current revision and store them as a proposal. Shared by PATCH and POST …/proposals. */
export function createProposal(t: Tenant, c: Ctx, dash: DashRow, base: string, message: string, changes: Change[], existing?: PropRow): OpResult {
  if (base !== dash.revision) throw staleProblem(t, dash, base)
  const current = specAt(t, dash.id, dash.head)
  const run = sequence(current, changes)
  if (run.failed.length) {
    const f = run.failed[0]!
    throw invalidDashboard([{ path: '', code: 'patch-failed', message: `Change "${f.name}": ${f.error} Nothing was stored.` }])
  }
  const v = validate(run.doc)
  if (!v.ok) throw invalidDashboard(v.errors)
  const result = run.doc as Dashboard
  if (result.metadata.id !== dash.id) throw invalid('A change cannot alter /metadata/id.', 'Create a new dashboard under the new id instead.', { path: '/metadata/id' })
  const revision = revisionOf(result)
  if (revision === dash.revision) throw invalid('The proposal changes nothing.', 'Check the ops: the result equals the current revision.')
  const text = JSON.stringify(changes)
  const bytes = utf8Length(text) + utf8Length(message)
  if (bytes > t.caps.maxSpecBytes) throw new Problem(413, 'proposal-too-large', `The proposal is ${bytes} bytes; the most is ${t.caps.maxSpecBytes}.`, 'Split it into several proposals.')
  const actorJson = JSON.stringify(c.actor)
  let id: string
  if (existing) {
    id = existing.id
    const editors = JSON.parse(existing.editors) as Actor[]
    const by = JSON.parse(existing.by) as Actor
    if (c.actor.subject !== by.subject && !editors.some((e) => e.subject === c.actor.subject)) editors.push(c.actor)
    checkTenantBytes(t, Math.max(0, bytes - utf8Length(existing.changes)))
    t.run(
      'UPDATE proposals SET base_revision = ?, base_number = ?, message = ?, changes = ?, editors = ?, bytes = ? WHERE tenant = ? AND id = ?',
      dash.revision, dash.head, message, text, JSON.stringify(editors), bytes, t.tenant, id,
    )
    t.audit(c.actor, c.now, 'proposal.edit', 'proposal', id, view(existing, c.now, true), view(load(t, id), c.now, true))
  } else {
    const open = t.one<{ n: number }>("SELECT COUNT(*) AS n FROM proposals WHERE tenant = ? AND dashboard = ? AND status = 'open'", t.tenant, dash.id)!.n
    if (open >= t.caps.maxOpenProposalsPerDashboard) {
      throw new Problem(409, 'too-many-proposals', `This dashboard already has ${open} open proposals, the most it may have.`, 'Apply or decline some of them first.')
    }
    checkTenantBytes(t, bytes)
    id = `p_${randomId(22)}`
    t.run(
      "INSERT INTO proposals (tenant, id, dashboard, base_revision, base_number, message, changes, status, created_at, by, editors, expires_at, bytes) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, '[]', ?, ?)",
      t.tenant, id, dash.id, dash.revision, dash.head, message, text, c.now, actorJson, c.now + general(t).proposalTtlDays * DAY_MS, bytes,
    )
    t.audit(c.actor, c.now, 'proposal.create', 'proposal', id, null, view(load(t, id), c.now, true))
  }
  const row = load(t, id)
  return {
    status: existing ? 200 : 202,
    body: {
      outcome: existing ? 'edited' : 'proposed',
      proposal: view(row, c.now, true),
      review: review(dash, evaluate(t, dash, row, changes)),
    },
  }
}

const create: Op = (t, c) => {
  const b = fields(c.input.body, ['changes', 'ops', 'reason', 'baseRevision', 'message', 'dryRun'], 'request body')
  const dash = loadDashboard(t, c.input.params.dashboard!)
  const message = str(b.message, 'message', { max: 500 })!
  return createProposal(t, c, dash, baseOf(c, b, true)!, message, parseChanges(t, b, message))
}

const list: Op = (t, c) => {
  const q = c.input.query
  const limit = pageLimit(q.limit?.[0])
  const after = decodeCursor(q.cursor?.[0], ['number', 'string'])
  const status = q.status?.[0] ?? 'open'
  if (!['open', 'applied', 'declined', 'expired', 'all'].includes(status)) throw new Problem(400, 'bad-status', '"status" must be open, applied, declined, expired or all.', 'Leave it out for open proposals.')
  const where = ['tenant = ?']
  const bind: (string | number)[] = [t.tenant]
  if (status === 'open') {
    where.push("status = 'open' AND expires_at > ?")
    bind.push(c.now)
  } else if (status === 'expired') {
    where.push("(status = 'expired' OR (status = 'open' AND expires_at <= ?))")
    bind.push(c.now)
  } else if (status !== 'all') {
    where.push('status = ?')
    bind.push(status)
  }
  if (q.dashboard?.[0]) {
    where.push('dashboard = ?')
    bind.push(q.dashboard[0])
  }
  const rows = t.all<PropRow>(
    `SELECT ${COLUMNS} FROM proposals WHERE ${where.join(' AND ')} AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ?`,
    ...bind, (after?.[0] as number) ?? Number.MAX_SAFE_INTEGER, (after?.[0] as number) ?? Number.MAX_SAFE_INTEGER, (after?.[1] as string) ?? '', limit + 1,
  )
  const page = rows.slice(0, limit)
  const last = page[page.length - 1]
  return { status: 200, body: { items: page.map((r) => view(r, c.now, false)), next: rows.length > limit && last ? encodeCursor([last.created_at, last.id]) : null } }
}

const get: Op = (t, c) => {
  const row = load(t, c.input.params.proposal!)
  const body: Record<string, unknown> = { proposal: view(row, c.now, true), review: null }
  const dash = t.one<{ deleted_at: number | null }>('SELECT deleted_at FROM dashboards WHERE tenant = ? AND id = ?', t.tenant, row.dashboard)
  if (statusOf(row, c.now) === 'open' && dash && dash.deleted_at === null) {
    const live = loadDashboard(t, row.dashboard)
    body.dashboard = dashboardView(live)
    body.review = review(live, evaluate(t, live, row, JSON.parse(row.changes) as Change[]))
  }
  return { status: 200, body }
}

function mustBeOpen(row: PropRow, now: number): void {
  const status = statusOf(row, now)
  if (status !== 'open') throw new Problem(409, 'proposal-closed', `This proposal is ${status}; it can no longer be changed or applied.`, 'Create a new proposal against the current revision.', { status })
}

const edit: Op = (t, c) => {
  const b = fields(c.input.body, ['changes', 'ops', 'reason', 'message', 'dryRun'], 'request body')
  const row = load(t, c.input.params.proposal!)
  mustBeOpen(row, c.now)
  const by = JSON.parse(row.by) as Actor
  if (by.subject !== c.id.subject && !hasApplyScope(c)) {
    throw new Problem(403, 'not-yours', 'Only the proposer, or someone who may apply changes, can edit a proposal.', 'Create your own proposal instead.')
  }
  const dash = loadDashboard(t, row.dashboard)
  const message = str(b.message, 'message', { max: 500, optional: true }) ?? row.message
  // An edit is always made against the dashboard as it is now, so it also rebases the proposal.
  return createProposal(t, c, dash, dash.revision, message, parseChanges(t, b, message), row)
}

const apply: Op = (t, c) => {
  const b = fields(c.input.body, ['changes', 'message', 'baseRevision', 'dryRun'], 'request body')
  const row = load(t, c.input.params.proposal!)
  mustBeOpen(row, c.now)
  const by = JSON.parse(row.by) as Actor
  const editors = JSON.parse(row.editors) as Actor[]
  // An agent never approves its own work, whatever scopes its key has, unless the tenant allows it.
  const own = by.subject === c.id.subject || editors.some((e) => e.subject === c.id.subject)
  if (c.id.kind === 'agent' && own && !general(t).agentsMayApply) {
    throw new Problem(403, 'self-apply', 'An agent may not apply a proposal it wrote or edited.', 'Ask a person, or another reviewer, to apply it. An admin can allow this with the general setting "agentsMayApply".')
  }
  const dash = loadDashboard(t, row.dashboard)
  const expected = baseOf(c, b, false)
  if (expected !== undefined && expected !== dash.revision) throw staleProblem(t, dash, expected)
  const all = JSON.parse(row.changes) as Change[]
  let chosen = all
  if (b.changes !== undefined) {
    if (!Array.isArray(b.changes) || b.changes.length === 0 || !b.changes.every((n) => typeof n === 'string')) throw invalid('"changes" must be a non-empty list of change names.', `This proposal's changes are: ${all.map((ch) => ch.name).join(', ')}.`, { field: 'changes' })
    const unknown = (b.changes as string[]).filter((n) => !all.some((ch) => ch.name === n))
    if (unknown.length) throw invalid(`No such change in this proposal: ${unknown.join(', ')}.`, `This proposal's changes are: ${all.map((ch) => ch.name).join(', ')}.`, { field: 'changes' })
    chosen = all.filter((ch) => (b.changes as string[]).includes(ch.name)) // always in the proposal's own order
  }
  const ev = evaluate(t, dash, row, chosen)
  const detail = { review: review(dash, ev) }
  if (ev.selectionInvalid) {
    throw new Problem(422, 'selection-invalid', 'The chosen changes do not make a valid dashboard without the ones left out.', 'Include the changes they depend on (see "review.reasons"), or edit the proposal first.', detail)
  }
  if (ev.needsRebase) {
    throw new Problem(409, 'needs-rebase', `The dashboard changed since this proposal was written (revision ${row.base_number} then, ${dash.head} now) and the changes no longer fit. Nothing was changed.`, 'Edit the proposal (PUT /api/v1/control/proposals/{proposal}) with ops rebuilt against the current revision, or decline it. "review.reasons" says what does not fit.', detail)
  }
  if (!ev.result) throw invalidDashboard(ev.errors)
  if (revisionOf(ev.result) === dash.revision) throw new Problem(409, 'nothing-to-apply', 'The dashboard already contains these changes.', 'Decline the proposal; there is nothing left to apply.')
  const message = str(b.message, 'message', { max: 500, optional: true }) ?? row.message
  const applied = chosen.map((ch) => ch.name)
  const skipped = all.filter((ch) => !applied.includes(ch.name)).map((ch) => ch.name)
  const rev = commitRevision(t, c.actor, c.now, dash, ev.result, ev.summary, { kind: 'apply', message, proposal: row.id, proposedBy: by })
  t.run(
    "UPDATE proposals SET status = 'applied', resolved_at = ?, resolved_by = ?, applied_number = ?, applied_changes = ? WHERE tenant = ? AND id = ? AND status = 'open'",
    c.now, JSON.stringify(c.actor), rev.number, JSON.stringify(applied), t.tenant, row.id,
  )
  t.audit(c.actor, c.now, 'proposal.apply', 'proposal', row.id, { dashboard: dash.id, number: dash.head, revision: dash.revision }, { dashboard: dash.id, ...rev, appliedChanges: applied, skippedChanges: skipped, proposedBy: by, summary: ev.summary })
  return {
    status: 200,
    body: { outcome: 'applied', proposal: view(load(t, row.id), c.now, false), dashboard: dashboardView(loadDashboard(t, dash.id)), ...rev, previousRevision: dash.revision, appliedChanges: applied, skippedChanges: skipped, summary: ev.summary, lint: lint(ev.result) },
    headers: { ETag: `"${rev.revision}"` },
  }
}

const decline: Op = (t, c) => {
  const b = fields(c.input.body, ['reason', 'dryRun'], 'request body')
  const row = load(t, c.input.params.proposal!)
  mustBeOpen(row, c.now)
  const by = JSON.parse(row.by) as Actor
  if (by.subject !== c.id.subject && !hasApplyScope(c)) {
    throw new Problem(403, 'not-yours', 'Only the proposer, or someone who may apply changes, can decline a proposal.', 'Ask someone with the dashboards:apply scope.')
  }
  const reason = str(b.reason, 'reason', { max: 500 })!
  t.run("UPDATE proposals SET status = 'declined', resolved_at = ?, resolved_by = ?, reason = ? WHERE tenant = ? AND id = ? AND status = 'open'", c.now, JSON.stringify(c.actor), reason, t.tenant, row.id)
  t.audit(c.actor, c.now, 'proposal.decline', 'proposal', row.id, { status: 'open' }, { status: 'declined', reason })
  return { status: 200, body: { outcome: 'declined', proposal: view(load(t, row.id), c.now, false) } }
}

/** Close open proposals whose date has passed. Idempotent: a second run finds none. */
export function expireProposals(t: Tenant, actor: Actor, now: number): void {
  for (const row of t.all<PropRow>(`SELECT ${COLUMNS} FROM proposals WHERE tenant = ? AND status = 'open' AND expires_at <= ?`, t.tenant, now)) {
    t.run("UPDATE proposals SET status = 'expired', resolved_at = ? WHERE tenant = ? AND id = ? AND status = 'open'", now, t.tenant, row.id)
    t.audit(actor, now, 'proposal.expire', 'proposal', row.id, { status: 'open' }, { status: 'expired' })
  }
}

export const proposalOps = {
  'proposals.create': create,
  'proposals.list': list,
  'proposals.get': get,
  'proposals.edit': edit,
  'proposals.apply': apply,
  'proposals.decline': decline,
} satisfies Record<string, Op>
