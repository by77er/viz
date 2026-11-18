import { Problem, notFound } from './errors'
import type { Op } from './tenant'
import { decodeCursor, encodeCursor, iso, pageLimit } from './util'

/**
 * The audit log: who did what, when, and the state before and after. It is written only
 * inside a mutation's transaction (Tenant.audit) and never updated or deleted: no code
 * path does either, and two SQLite triggers abort any statement that tries.
 */

interface AuditRow {
  seq: number
  id: string
  at: number
  subject: string
  kind: string
  name: string | null
  action: string
  target_type: string
  target_id: string
  before: string | null
  after: string | null
}

const COLUMNS = 'seq, id, at, subject, kind, name, action, target_type, target_id, before, after'

const view = (r: AuditRow): Record<string, unknown> => ({
  id: r.id,
  at: iso(r.at),
  by: { subject: r.subject, kind: r.kind, name: r.name },
  action: r.action,
  target: { type: r.target_type, id: r.target_id },
  before: r.before === null ? null : (JSON.parse(r.before) as unknown),
  after: r.after === null ? null : (JSON.parse(r.after) as unknown),
})

function time(raw: string | undefined, field: string): number | null {
  if (raw === undefined) return null
  const ms = Date.parse(raw)
  if (!Number.isFinite(ms)) throw new Problem(400, 'bad-time', `"${field}" must be an RFC 3339 time.`, 'Send e.g. 2026-11-18T00:00:00Z.')
  return ms
}

const list: Op = (t, c) => {
  const q = c.input.query
  const limit = pageLimit(q.limit?.[0])
  const after = decodeCursor(q.cursor?.[0], ['number'])
  const where = ['tenant = ?', 'seq < ?']
  const bind: (string | number)[] = [t.tenant, (after?.[0] as number) ?? Number.MAX_SAFE_INTEGER]
  const eq = (param: string, column: string): void => {
    const v = q[param]?.[0]
    if (v !== undefined) {
      where.push(`${column} = ?`)
      bind.push(v)
    }
  }
  eq('action', 'action')
  eq('targetType', 'target_type')
  eq('targetId', 'target_id')
  eq('subject', 'subject')
  eq('kind', 'kind')
  const since = time(q.since?.[0], 'since')
  const until = time(q.until?.[0], 'until')
  if (since !== null) {
    where.push('at >= ?')
    bind.push(since)
  }
  if (until !== null) {
    where.push('at < ?')
    bind.push(until)
  }
  const rows = t.all<AuditRow>(`SELECT ${COLUMNS} FROM audit WHERE ${where.join(' AND ')} ORDER BY seq DESC LIMIT ?`, ...bind, limit + 1)
  const page = rows.slice(0, limit)
  return { status: 200, body: { items: page.map(view), next: rows.length > limit ? encodeCursor([page[page.length - 1]!.seq]) : null } }
}

const get: Op = (t, c) => {
  const row = t.one<AuditRow>(`SELECT ${COLUMNS} FROM audit WHERE tenant = ? AND id = ?`, t.tenant, c.input.params.entry!)
  if (!row) throw notFound('audit entry')
  return { status: 200, body: view(row) }
}

export const auditOps = {
  'audit.list': list,
  'audit.get': get,
} satisfies Record<string, Op>
