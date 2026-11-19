import { type Dashboard, type Issue, ID_PATTERN, type PatchOp, applyPatch, lint, resolve, revisionOf, summarizeDiff, validate } from '../../dashboard/src/index.ts'
import { DAY_MS, DELETED_RETENTION_DAYS } from './caps'
import { Problem, invalid, notFound } from './errors'
import type { Actor } from './identity'
import { createProposal } from './ops-proposals'
import { general } from './ops-settings'
import { type Ctx, NoChange, type Op, type Tenant } from './tenant'
import { decodeCursor, encodeCursor, fields, isRecord, iso, pageLimit, str, utf8Length } from './util'

/**
 * Dashboards: `viz.dashboard/v1` specs with their whole history.
 *
 * A revision is the full spec plus its content hash (`revisionOf`, the id callers use as
 * `baseRevision` and `ETag`) and a number that counts up by one per dashboard (what people
 * say: "revision 14"). History is linear: revision n's parent is n-1, and a revert is a
 * new revision whose content equals an old one.
 */

const DASH_ID = new RegExp(ID_PATTERN)

export interface DashRow {
  id: string
  head: number
  revision: string
  title: string
  intent: string
  tags: string
  owner: string | null
  panel_count: number
  created_at: number
  created_by: string
  updated_at: number
  updated_by: string
  deleted_at: number | null
  deleted_by: string | null
  purge_at: number | null
}

interface RevRow {
  number: number
  revision: string
  spec: string
  bytes: number
  at: number
  by: string
  message: string
  kind: string
  summary: string
  proposal: string | null
  proposed_by: string | null
  reverted_to: number | null
}

const DASH_COLUMNS = 'id, head, revision, title, intent, tags, owner, panel_count, created_at, created_by, updated_at, updated_by, deleted_at, deleted_by, purge_at'
const REV_COLUMNS = 'number, revision, spec, bytes, at, by, message, kind, summary, proposal, proposed_by, reverted_to'

/** A live dashboard, or 404. A deleted one is 404 too, with a hint that it can be restored. */
export function loadDashboard(t: Tenant, id: string, deleted: 'live' | 'deleted' | 'any' = 'live'): DashRow {
  const row = DASH_ID.test(id) ? t.one<DashRow>(`SELECT ${DASH_COLUMNS} FROM dashboards WHERE tenant = ? AND id = ?`, t.tenant, id) : undefined
  if (!row) throw notFound('dashboard')
  if (deleted === 'live' && row.deleted_at !== null) {
    throw new Problem(404, 'dashboard-deleted', `Dashboard "${id}" was deleted.`, `Restore it with POST /api/v1/control/dashboards/${id}/restore before ${iso(row.purge_at)}; after that it is gone.`, { restorableUntil: iso(row.purge_at) })
  }
  if (deleted === 'deleted' && row.deleted_at === null) throw new Problem(409, 'not-deleted', `Dashboard "${id}" is not deleted.`, 'Nothing to restore.')
  return row
}

export function revisionRow(t: Tenant, dashboard: string, number: number): RevRow | undefined {
  return t.one<RevRow>(`SELECT ${REV_COLUMNS} FROM revisions WHERE tenant = ? AND dashboard = ? AND number = ?`, t.tenant, dashboard, number)
}

export function specAt(t: Tenant, dashboard: string, number: number): Dashboard {
  const row = revisionRow(t, dashboard, number)
  if (!row) throw notFound('revision')
  return JSON.parse(row.spec) as Dashboard
}

export const tenantBytes = (t: Tenant): number =>
  (t.one<{ n: number | null }>('SELECT SUM(bytes) AS n FROM revisions WHERE tenant = ?', t.tenant)!.n ?? 0) +
  (t.one<{ n: number | null }>('SELECT SUM(bytes) AS n FROM proposals WHERE tenant = ?', t.tenant)!.n ?? 0)

export function checkTenantBytes(t: Tenant, adding: number): void {
  const used = tenantBytes(t)
  if (used + adding > t.caps.maxTenantBytes) {
    throw new Problem(409, 'tenant-storage-full', `This would bring the tenant's dashboards and proposals to ${used + adding} bytes; the limit is ${t.caps.maxTenantBytes}.`, 'Delete dashboards that are no longer needed (they are purged 30 days after deletion), or ask the operator to raise the limit.', { usedBytes: used, limitBytes: t.caps.maxTenantBytes })
  }
}

const panelCount = (spec: Dashboard): number => Object.keys(resolve(spec).panels).length

/** The row of screen 1. `state` comes from data, which this object never sees: see README, "state hook". */
export function dashboardView(row: DashRow): Record<string, unknown> {
  return {
    id: row.id,
    name: row.title,
    intent: row.intent,
    tags: JSON.parse(row.tags) as string[],
    owner: row.owner,
    panels: row.panel_count,
    revision: row.revision,
    number: row.head,
    createdAt: iso(row.created_at),
    createdBy: JSON.parse(row.created_by) as Actor,
    lastChangedAt: iso(row.updated_at),
    lastChangedBy: JSON.parse(row.updated_by) as Actor,
    state: null,
    ...(row.deleted_at !== null ? { deletedAt: iso(row.deleted_at), deletedBy: JSON.parse(row.deleted_by!) as Actor, restorableUntil: iso(row.purge_at) } : {}),
  }
}

function revisionView(row: RevRow, withSpec: boolean): Record<string, unknown> {
  return {
    number: row.number,
    revision: row.revision,
    at: iso(row.at),
    by: JSON.parse(row.by) as Actor,
    message: row.message,
    kind: row.kind,
    summary: JSON.parse(row.summary) as string[],
    proposal: row.proposal,
    proposedBy: row.proposed_by === null ? null : (JSON.parse(row.proposed_by) as Actor),
    revertedTo: row.reverted_to,
    bytes: row.bytes,
    ...(withSpec ? { spec: JSON.parse(row.spec) as Dashboard } : {}),
  }
}

/** Validate a whole spec, or refuse with every error and its suggestion. */
export function mustValidate(spec: unknown): Dashboard {
  const v = validate(spec)
  if (!v.ok) throw invalidDashboard(v.errors)
  return spec as Dashboard
}

export const invalidDashboard = (errors: Issue[]): Problem =>
  new Problem(422, 'invalid-dashboard', `The dashboard would not be valid: ${errors.length} error${errors.length === 1 ? '' : 's'}. Nothing was changed.`, 'Fix each entry in "errors": each has a JSON Pointer "path" and usually a "suggestion". Use dryRun to check before writing.', { errors })

/** People may always write with the apply scope. Agents only if the tenant says so. */
export function mayApply(t: Tenant, c: Ctx): boolean {
  if (!c.id.scopes.includes('dashboards:apply') && !c.id.scopes.includes('admin')) return false
  return c.id.kind !== 'agent' || general(t).agentsMayApply
}

function requireApply(t: Tenant, c: Ctx, what: string): void {
  if (mayApply(t, c)) return
  if (c.id.kind !== 'agent' || !(c.id.scopes.includes('dashboards:apply') || c.id.scopes.includes('admin'))) {
    throw new Problem(403, 'missing-scope', `To ${what} needs the dashboards:apply scope.`, 'Use a key with dashboards:apply, or propose a patch to an existing dashboard for someone else to apply.', { required: ['admin', 'dashboards:apply'] })
  }
  throw new Problem(403, 'agents-may-not-apply', `An agent may not ${what} directly in this tenant.`, `Propose it instead (${what === 'create a dashboard' ? 'POST /api/v1/control/proposals with the spec' : 'POST /api/v1/control/dashboards/{dashboard}/proposals'}) and let a person apply it, or have an admin set the general setting "agentsMayApply" to true.`)
}

/** The revision the caller says it is working from: `baseRevision` in the body, or `If-Match`. */
export function baseOf(c: Ctx, body: Record<string, unknown>, required: boolean): string | undefined {
  const fromBody = body.baseRevision
  if (fromBody !== undefined && typeof fromBody !== 'string') throw invalid('"baseRevision" must be a string.', 'Send the "revision" you last read.', { field: 'baseRevision' })
  const fromHeader = c.input.ifMatch
  if (fromBody !== undefined && fromHeader !== undefined && fromBody !== fromHeader) {
    throw new Problem(400, 'base-mismatch', '"baseRevision" and If-Match name different revisions.', 'Send one of them, or the same revision in both.')
  }
  const base = fromBody ?? fromHeader
  if (base === undefined && required) {
    throw new Problem(428, 'base-required', 'This write needs the revision it is based on.', 'Send "baseRevision" in the body or an If-Match header, with the "revision" (or ETag) from your last read of the dashboard.')
  }
  return base
}

/** 409 for a write based on a revision that is no longer current, saying what changed underneath. */
export function staleProblem(t: Tenant, dash: DashRow, base: string): Problem {
  const known = t.one<{ number: number }>('SELECT MAX(number) AS number FROM revisions WHERE tenant = ? AND dashboard = ? AND revision = ?', t.tenant, dash.id, base)?.number ?? null
  const since = known === null ? [] : t.all<RevRow>(`SELECT ${REV_COLUMNS} FROM revisions WHERE tenant = ? AND dashboard = ? AND number > ? ORDER BY number LIMIT 20`, t.tenant, dash.id, known)
  return new Problem(
    409,
    'stale-revision',
    `The dashboard changed since revision ${base}; it is now ${dash.revision} (number ${dash.head}). Nothing was changed.`,
    'Read the dashboard again, rebuild the ops against "currentRevision" (see "changedUnderneath" for what moved), and resend. dryRun shows the outcome without writing.',
    {
      baseRevision: base,
      currentRevision: dash.revision,
      currentNumber: dash.head,
      // Null when the base is not a revision this dashboard ever had.
      changedUnderneath: known === null ? null : summarizeDiff(specAt(t, dash.id, known), specAt(t, dash.id, dash.head)),
      revisionsSince: since.map((r) => ({ number: r.number, revision: r.revision, at: iso(r.at), by: JSON.parse(r.by) as Actor, message: r.message })),
    },
    { ETag: `"${dash.revision}"` },
  )
}

export function parseOps(t: Tenant, v: unknown, field = 'ops'): PatchOp[] {
  if (!Array.isArray(v) || v.length === 0 || !v.every(isRecord)) throw invalid(`"${field}" must be a non-empty list of RFC 6902 operations.`, 'Send e.g. [{"op":"replace","path":"/panels/p_err/title","value":"Error ratio"}].', { field })
  if (v.length > t.caps.maxOpsPerRequest) throw invalid(`"${field}" has ${v.length} operations; the most is ${t.caps.maxOpsPerRequest}.`, 'Split the change.', { field })
  return v as PatchOp[]
}

/** Apply ops to the current revision, or refuse. Writes nothing. */
export function planPatch(t: Tenant, dash: DashRow, ops: PatchOp[], base: string): { before: Dashboard; spec: Dashboard; revision: string } {
  if (base !== dash.revision) throw staleProblem(t, dash, base)
  const before = specAt(t, dash.id, dash.head)
  const r = applyPatch(before, ops, { baseRevision: base })
  if (!r.ok) {
    if ('conflict' in r) throw staleProblem(t, dash, base)
    throw invalidDashboard(r.errors)
  }
  if (r.spec.metadata.id !== dash.id) throw invalid('A patch cannot change /metadata/id.', 'Create a new dashboard under the new id instead.', { path: '/metadata/id' })
  return { before, spec: r.spec, revision: r.revision }
}

/** Append a revision and move the dashboard's head to it. Caller is inside a transaction. */
export function commitRevision(
  t: Tenant,
  actor: Actor,
  now: number,
  dash: { id: string; head: number },
  spec: Dashboard,
  summary: string[],
  meta: { kind: 'create' | 'patch' | 'revert' | 'apply'; message: string; proposal?: string; proposedBy?: Actor; revertedTo?: number },
): { number: number; revision: string } {
  const text = JSON.stringify(spec)
  const bytes = utf8Length(text)
  if (bytes > t.caps.maxSpecBytes) {
    throw new Problem(413, 'spec-too-large', `The dashboard is ${bytes} bytes; the most is ${t.caps.maxSpecBytes}.`, 'Split it into several dashboards, or move repeated panels into a fragment.', { bytes, limitBytes: t.caps.maxSpecBytes })
  }
  const number = dash.head + 1
  if (number > t.caps.maxRevisionsPerDashboard) {
    throw new Problem(409, 'too-many-revisions', `This dashboard has ${dash.head} revisions, the most one dashboard may have.`, 'Copy the current spec into a new dashboard to start a fresh history. Pruning old revisions is not available yet.', { limit: t.caps.maxRevisionsPerDashboard })
  }
  checkTenantBytes(t, bytes)
  const revision = revisionOf(spec)
  t.run(
    'INSERT INTO revisions (tenant, dashboard, number, revision, spec, bytes, at, by, message, kind, summary, proposal, proposed_by, reverted_to) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    t.tenant, dash.id, number, revision, text, bytes, now, JSON.stringify(actor), meta.message, meta.kind, JSON.stringify(summary),
    meta.proposal ?? null, meta.proposedBy ? JSON.stringify(meta.proposedBy) : null, meta.revertedTo ?? null,
  )
  t.run(
    'UPDATE dashboards SET head = ?, revision = ?, title = ?, intent = ?, tags = ?, panel_count = ?, updated_at = ?, updated_by = ? WHERE tenant = ? AND id = ?',
    number, revision, spec.metadata.title, spec.metadata.intent, JSON.stringify(spec.metadata.tags ?? []), panelCount(spec), now, JSON.stringify(actor), t.tenant, dash.id,
  )
  return { number, revision }
}

const etag = (revision: string): Record<string, string> => ({ ETag: `"${revision}"` })

/** A short projection for a reader that wants the shape, not the queries. */
function outline(spec: Dashboard): Record<string, unknown> {
  const r = resolve(spec)
  return {
    metadata: spec.metadata,
    time: spec.time ?? null,
    variables: Object.entries(spec.variables ?? {}).map(([id, v]) => ({ id, kind: v.kind, label: v.label ?? null })),
    panels: r.order.map((id) => {
      const p = r.panels[id]!
      return { id, kind: p.kind, title: p.title, unit: 'unit' in p ? (p.unit ?? null) : null, queries: 'queries' in p ? p.queries : [] }
    }),
    fragments: Object.keys(spec.fragments ?? {}),
  }
}

// ---- operations ----

const list: Op = (t, c) => {
  const q = c.input.query
  const limit = pageLimit(q.limit?.[0])
  const after = decodeCursor(q.cursor?.[0], ['string'])
  const where = ['tenant = ?', q.deleted?.[0] === 'true' ? 'deleted_at IS NOT NULL' : 'deleted_at IS NULL']
  const bind: (string | number)[] = [t.tenant]
  const search = q.q?.[0]?.trim()
  if (search) {
    // Substring match with instr() rather than LIKE: Cloudflare's SQLite rejects a LIKE pattern past
    // a short length ("LIKE or GLOB pattern too complex"), so a long search answered 500. instr()
    // has no such limit and needs no escaping; lower() keeps LIKE's ASCII case-insensitivity.
    where.push('(instr(lower(title), lower(?)) > 0 OR instr(lower(id), lower(?)) > 0 OR instr(lower(intent), lower(?)) > 0 OR instr(lower(owner), lower(?)) > 0 OR instr(lower(tags), lower(?)) > 0)')
    const needle = search.slice(0, 200)
    bind.push(needle, needle, needle, needle, needle)
  }
  if (q.tag?.[0]) {
    where.push('instr(lower(tags), lower(?)) > 0')
    bind.push(JSON.stringify(q.tag[0]))
  }
  if (q.owner?.[0]) {
    where.push('owner = ?')
    bind.push(q.owner[0])
  }
  const total = t.one<{ n: number }>(`SELECT COUNT(*) AS n FROM dashboards WHERE ${where.join(' AND ')}`, ...bind)!.n
  const rows = t.all<DashRow>(`SELECT ${DASH_COLUMNS} FROM dashboards WHERE ${where.join(' AND ')} AND id > ? ORDER BY id LIMIT ?`, ...bind, (after?.[0] as string) ?? '', limit + 1)
  const page = rows.slice(0, limit)
  return { status: 200, body: { items: page.map(dashboardView), total, next: rows.length > limit ? encodeCursor([page[page.length - 1]!.id]) : null } }
}

const create: Op = (t, c) => {
  const b = fields(c.input.body, ['spec', 'owner', 'message', 'dryRun'], 'request body')
  // Anyone who may write may dry-run a new spec to have it validated; only the real write needs the right to apply.
  const permitted = mayApply(t, c)
  if (!c.dryRun) requireApply(t, c, 'create a dashboard')
  const spec = mustValidate(b.spec)
  const owner = str(b.owner, 'owner', { max: 80, optional: true }) ?? null
  const message = str(b.message, 'message', { min: 0, max: 500, optional: true }) ?? 'Created'
  const id = spec.metadata.id
  const { summary, ...rev } = insertDashboard(t, c.actor, c.now, spec, { owner, message, kind: 'create' })
  t.audit(c.actor, c.now, 'dashboard.create', 'dashboard', id, null, { ...rev, owner, message })
  return { status: 201, body: { dashboard: dashboardView(loadDashboard(t, id)), ...rev, summary, lint: lint(spec), ...(permitted ? {} : { permitted: false }) }, headers: etag(rev.revision) }
}

/** Whether a dashboard, live or deleted (and so restorable), already holds this id. */
export function idHolder(t: Tenant, id: string): 'live' | 'deleted' | null {
  const row = t.one<{ deleted_at: number | null }>('SELECT deleted_at FROM dashboards WHERE tenant = ? AND id = ?', t.tenant, id)
  return !row ? null : row.deleted_at === null ? 'live' : 'deleted'
}

/** 409 when the id is taken. `proposal`: the caller is proposing or applying a creation, and the fix says what to do then. */
export function requireFreeId(t: Tenant, id: string, proposal = false): void {
  const holder = idHolder(t, id)
  if (holder === 'live') {
    throw new Problem(409, 'dashboard-exists', `A dashboard with id "${id}" already exists.`, proposal ? `Decline this proposal and propose the difference as a change to the existing dashboard (POST /api/v1/control/dashboards/${id}/proposals), or propose under another /metadata/id.` : 'Patch the existing dashboard, or choose another /metadata/id.')
  }
  if (holder === 'deleted') {
    throw new Problem(409, 'dashboard-deleted', `A deleted dashboard still holds the id "${id}".`, `Restore it (POST /api/v1/control/dashboards/${id}/restore), or choose another /metadata/id.`)
  }
}

/** The one line a creation contributes to a diff summary. */
export const createdSummary = (spec: Dashboard): string[] => [`+ dashboard ${spec.metadata.id} "${spec.metadata.title}" (${Object.keys(spec.panels).length} panels)`]

/**
 * Insert a new dashboard and its revision 1. Shared by a direct create and by applying a
 * proposal that creates one, so both refuse the same things. Caller is inside a transaction.
 */
export function insertDashboard(
  t: Tenant,
  actor: Actor,
  now: number,
  spec: Dashboard,
  meta: { owner: string | null; message: string; kind: 'create' | 'apply'; proposal?: string; proposedBy?: Actor },
): { number: number; revision: string; summary: string[] } {
  const id = spec.metadata.id
  requireFreeId(t, id, meta.proposal !== undefined)
  if (t.one<{ n: number }>('SELECT COUNT(*) AS n FROM dashboards WHERE tenant = ?', t.tenant)!.n >= t.caps.maxDashboards) {
    throw new Problem(409, 'too-many-dashboards', `This tenant already has ${t.caps.maxDashboards} dashboards, the most it may have.`, 'Delete dashboards that are no longer needed.')
  }
  const by = JSON.stringify(actor)
  t.run(
    "INSERT INTO dashboards (tenant, id, head, revision, title, intent, tags, owner, panel_count, created_at, created_by, updated_at, updated_by) VALUES (?, ?, 0, '', '', '', '[]', ?, 0, ?, ?, ?, ?)",
    t.tenant, id, meta.owner, now, by, now, by,
  )
  const summary = createdSummary(spec)
  const rev = commitRevision(t, actor, now, { id, head: 0 }, spec, summary, { kind: meta.kind, message: meta.message, proposal: meta.proposal, proposedBy: meta.proposedBy })
  return { ...rev, summary }
}

const get: Op = (t, c) => {
  const dash = loadDashboard(t, c.input.params.dashboard!)
  const q = c.input.query
  const view = q.view?.[0] ?? 'spec'
  if (view !== 'spec' && view !== 'outline' && view !== 'resolved') throw new Problem(400, 'bad-view', '"view" must be spec, outline or resolved.', 'Use ?view=spec (the default), ?view=outline, or ?view=resolved with var.<name>=<value> for each variable.')
  let number = dash.head
  if (q.revision?.[0] !== undefined) {
    number = Number(q.revision[0])
    if (!Number.isInteger(number) || number < 1) throw notFound('revision')
  }
  const row = revisionRow(t, dash.id, number)
  if (!row) throw notFound('revision')
  const spec = JSON.parse(row.spec) as Dashboard
  const body: Record<string, unknown> = { dashboard: dashboardView(dash), number: row.number, revision: row.revision, current: row.number === dash.head, view }
  if (view === 'spec') body.spec = spec
  else if (view === 'outline') body.outline = outline(spec)
  else {
    const variables: Record<string, string | string[]> = {}
    for (const [k, values] of Object.entries(q)) if (k.startsWith('var.') && k.length > 4) variables[k.slice(4)] = values.length === 1 ? values[0]! : values
    body.resolved = resolve(spec, { variables })
  }
  return { status: 200, body, headers: etag(row.revision) }
}

const patch: Op = (t, c) => {
  const b = fields(c.input.body, ['ops', 'baseRevision', 'message', 'propose', 'dryRun'], 'request body')
  const dash = loadDashboard(t, c.input.params.dashboard!)
  const ops = parseOps(t, b.ops)
  const base = baseOf(c, b, true)!
  const message = str(b.message, 'message', { min: 0, max: 500, optional: true }) ?? ''
  if (b.propose !== undefined && typeof b.propose !== 'boolean') throw invalid('"propose" must be true or false.', 'Send "propose": true to ask for review instead of writing.', { field: 'propose' })
  // Without the right to apply, or on request, the same patch becomes a proposal for a person to review.
  if (b.propose === true || !mayApply(t, c)) {
    return createProposal(t, c, dash, base, message || 'Proposed change', [{ name: 'change', reason: message || 'Proposed change', ops }])
  }
  const plan = planPatch(t, dash, ops, base)
  if (plan.revision === dash.revision) {
    throw new NoChange({ status: 200, body: { outcome: 'unchanged', dashboard: dashboardView(dash), number: dash.head, revision: dash.revision, summary: ['No changes.'], lint: lint(plan.spec) }, headers: etag(dash.revision) })
  }
  const summary = summarizeDiff(plan.before, plan.spec)
  const rev = commitRevision(t, c.actor, c.now, dash, plan.spec, summary, { kind: 'patch', message })
  t.audit(c.actor, c.now, 'dashboard.patch', 'dashboard', dash.id, { number: dash.head, revision: dash.revision }, { ...rev, message, summary })
  return { status: 200, body: { outcome: 'applied', dashboard: dashboardView(loadDashboard(t, dash.id)), ...rev, previousRevision: dash.revision, summary, lint: lint(plan.spec) }, headers: etag(rev.revision) }
}

const revert: Op = (t, c) => {
  const b = fields(c.input.body, ['baseRevision', 'message', 'dryRun'], 'request body')
  requireApply(t, c, 'revert a dashboard')
  const dash = loadDashboard(t, c.input.params.dashboard!)
  const number = Number(c.input.params.number)
  const target = Number.isInteger(number) && number >= 1 ? revisionRow(t, dash.id, number) : undefined
  if (!target) throw notFound('revision')
  const base = baseOf(c, b, true)!
  if (base !== dash.revision) throw staleProblem(t, dash, base)
  const before = specAt(t, dash.id, dash.head)
  if (target.revision === dash.revision) {
    throw new NoChange({ status: 200, body: { outcome: 'unchanged', dashboard: dashboardView(dash), number: dash.head, revision: dash.revision, summary: ['No changes.'] }, headers: etag(dash.revision) })
  }
  // An old revision was valid when it was written; check again, since it is about to become current.
  const spec = mustValidate(JSON.parse(target.spec))
  const message = str(b.message, 'message', { min: 0, max: 500, optional: true }) ?? `Reverted to revision ${number}`
  const summary = summarizeDiff(before, spec)
  const rev = commitRevision(t, c.actor, c.now, dash, spec, summary, { kind: 'revert', message, revertedTo: number })
  t.audit(c.actor, c.now, 'dashboard.revert', 'dashboard', dash.id, { number: dash.head, revision: dash.revision }, { ...rev, revertedTo: number, message, summary })
  return { status: 200, body: { outcome: 'applied', dashboard: dashboardView(loadDashboard(t, dash.id)), ...rev, revertedTo: number, previousRevision: dash.revision, summary, lint: lint(spec) }, headers: etag(rev.revision) }
}

const remove: Op = (t, c) => {
  const b = fields(c.input.body, ['baseRevision', 'dryRun'], 'request body')
  requireApply(t, c, 'delete a dashboard')
  const dash = loadDashboard(t, c.input.params.dashboard!)
  const base = baseOf(c, b, false)
  if (base !== undefined && base !== dash.revision) throw staleProblem(t, dash, base)
  const purgeAt = c.now + DELETED_RETENTION_DAYS * DAY_MS
  t.run('UPDATE dashboards SET deleted_at = ?, deleted_by = ?, purge_at = ? WHERE tenant = ? AND id = ?', c.now, JSON.stringify(c.actor), purgeAt, t.tenant, dash.id)
  t.audit(c.actor, c.now, 'dashboard.delete', 'dashboard', dash.id, { number: dash.head, revision: dash.revision }, { deleted: true, restorableUntil: iso(purgeAt) })
  return { status: 200, body: { deleted: dash.id, restorableUntil: iso(purgeAt) } }
}

const restore: Op = (t, c) => {
  fields(c.input.body, ['dryRun'], 'request body')
  requireApply(t, c, 'restore a dashboard')
  const dash = loadDashboard(t, c.input.params.dashboard!, 'deleted')
  t.run('UPDATE dashboards SET deleted_at = NULL, deleted_by = NULL, purge_at = NULL WHERE tenant = ? AND id = ?', t.tenant, dash.id)
  t.audit(c.actor, c.now, 'dashboard.restore', 'dashboard', dash.id, { deleted: true }, { number: dash.head, revision: dash.revision })
  return { status: 200, body: { dashboard: dashboardView(loadDashboard(t, dash.id)) }, headers: etag(dash.revision) }
}

const setOwner: Op = (t, c) => {
  const b = fields(c.input.body, ['owner', 'dryRun'], 'request body')
  requireApply(t, c, 'change a dashboard\'s owner')
  const dash = loadDashboard(t, c.input.params.dashboard!)
  const owner = b.owner === null ? null : str(b.owner, 'owner', { max: 80 })!
  if (owner === dash.owner) throw new NoChange({ status: 200, body: { outcome: 'unchanged', dashboard: dashboardView(dash) } })
  t.run('UPDATE dashboards SET owner = ? WHERE tenant = ? AND id = ?', owner, t.tenant, dash.id)
  t.audit(c.actor, c.now, 'dashboard.owner', 'dashboard', dash.id, { owner: dash.owner }, { owner })
  return { status: 200, body: { outcome: 'applied', dashboard: dashboardView(loadDashboard(t, dash.id)) } }
}

const revisions: Op = (t, c) => {
  const dash = loadDashboard(t, c.input.params.dashboard!)
  const limit = pageLimit(c.input.query.limit?.[0])
  const after = decodeCursor(c.input.query.cursor?.[0], ['number'])
  const rows = t.all<RevRow>(
    `SELECT ${REV_COLUMNS} FROM revisions WHERE tenant = ? AND dashboard = ? AND number < ? ORDER BY number DESC LIMIT ?`,
    t.tenant, dash.id, (after?.[0] as number) ?? Number.MAX_SAFE_INTEGER, limit + 1,
  )
  const page = rows.slice(0, limit)
  return { status: 200, body: { items: page.map((r) => revisionView(r, false)), current: dash.head, next: rows.length > limit ? encodeCursor([page[page.length - 1]!.number]) : null } }
}

const revision: Op = (t, c) => {
  const dash = loadDashboard(t, c.input.params.dashboard!)
  const number = Number(c.input.params.number)
  const row = Number.isInteger(number) && number >= 1 ? revisionRow(t, dash.id, number) : undefined
  if (!row) throw notFound('revision')
  return { status: 200, body: { ...revisionView(row, true), current: row.number === dash.head }, headers: etag(row.revision) }
}

/** Remove dashboards whose 30 days are up, with their revisions and proposals. Idempotent. */
export function purgeDashboards(t: Tenant, actor: Actor, now: number): void {
  for (const d of t.all<DashRow>(`SELECT ${DASH_COLUMNS} FROM dashboards WHERE tenant = ? AND deleted_at IS NOT NULL AND purge_at <= ?`, t.tenant, now)) {
    t.run('DELETE FROM revisions WHERE tenant = ? AND dashboard = ?', t.tenant, d.id)
    // Proposals for the dashboard go with it, except an open proposal to create one under this id: it waited for the id to be free.
    t.run("DELETE FROM proposals WHERE tenant = ? AND dashboard = ? AND NOT (base_number = 0 AND spec IS NOT NULL AND status = 'open')", t.tenant, d.id)
    t.run('DELETE FROM dashboards WHERE tenant = ? AND id = ?', t.tenant, d.id)
    t.audit(actor, now, 'dashboard.purge', 'dashboard', d.id, { number: d.head, revision: d.revision, deletedAt: iso(d.deleted_at) }, null)
  }
}

export const dashboardOps = {
  'dashboards.list': list,
  'dashboards.create': create,
  'dashboards.get': get,
  'dashboards.patch': patch,
  'dashboards.delete': remove,
  'dashboards.restore': restore,
  'dashboards.setOwner': setOwner,
  'revisions.list': revisions,
  'revisions.get': revision,
  'revisions.revert': revert,
} satisfies Record<string, Op>
