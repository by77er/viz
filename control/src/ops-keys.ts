import { sha256Hex } from '../../dashboard/src/index.ts'
import { DAY_MS } from './caps'
import { Problem, invalid, notFound } from './errors'
import type { Actor } from './identity'
import { SCOPES } from './routes'
import type { Ctx, Op, Tenant } from './tenant'
import { decodeCursor, encodeCursor, fields, int, iso, pageLimit, randomId, str } from './util'

/**
 * API keys. The Tenant object is the authority; KV is what edge reads.
 *
 * KV record, exactly edge's (edge/src/auth.ts `KeyRecord`):
 *   key:<keyId> → { tenant, secretSha256, scopes, disabled }
 * Only the SHA-256 of the secret is stored, here and in KV. The full key leaves this
 * object once, in the response to create or rotate.
 *
 * Expiry and the overlap after a rotation are KV expirations on the record, so they need
 * no alarm here and edge needs no new field.
 *
 *   revocation:<tenant> → { generation, revokedBefore }
 * is bumped whenever a credential stops being valid (disable, delete, rotate without
 * overlap). A verifier that remembers when it last checked a key against KV can refuse
 * anything checked before `revokedBefore` (Unix ms) and look again.
 */

interface KeyRow {
  id: string
  name: string
  kind: 'key' | 'agent'
  scopes: string
  key_id: string
  created_at: number
  created_by: string
  expires_at: number | null
  disabled: number
  rotated_at: number | null
  last_used_at: number | null
}

const MAX_OVERLAP_S = 7 * 86_400
const MIN_EXPIRY_MS = 5 * 60_000

/** What a list or a response shows of a key. There is no secret in the row to leak. */
export function keyView(t: Tenant, row: KeyRow, now: number): Record<string, unknown> {
  const previous = t.one<{ m: number | null }>('SELECT MAX(valid_until) AS m FROM key_secrets WHERE tenant = ? AND key = ? AND valid_until > ?', t.tenant, row.id, now)?.m ?? null
  // Usage is null, not zero, until the data path has reported something for this key.
  const samples24h =
    row.last_used_at === null
      ? null
      : (t.one<{ n: number | null }>('SELECT SUM(samples) AS n FROM key_usage WHERE tenant = ? AND key = ? AND hour > ?', t.tenant, row.id, Math.floor((now - DAY_MS) / 3_600_000))?.n ?? 0)
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    scopes: JSON.parse(row.scopes) as string[],
    prefix: `viz_${row.key_id}`,
    createdAt: iso(row.created_at),
    createdBy: JSON.parse(row.created_by) as Actor,
    expiresAt: iso(row.expires_at),
    expired: row.expires_at !== null && row.expires_at <= now,
    disabled: row.disabled === 1,
    rotatedAt: iso(row.rotated_at),
    previousSecretValidUntil: iso(previous),
    lastUsedAt: iso(row.last_used_at),
    samples24h,
  }
}

const COLUMNS = 'id, name, kind, scopes, key_id, created_at, created_by, expires_at, disabled, rotated_at, last_used_at'

function load(t: Tenant, id: string): KeyRow {
  const row = t.one<KeyRow>(`SELECT ${COLUMNS} FROM keys WHERE tenant = ? AND id = ?`, t.tenant, id)
  if (!row) throw notFound('key')
  return row
}

/** Queue the KV record of every live secret of a key, as it now stands. */
function publishKey(t: Tenant, id: string, now: number): void {
  const row = load(t, id)
  const secrets = t.all<{ key_id: string; secret_sha256: string; valid_until: number | null }>('SELECT key_id, secret_sha256, valid_until FROM key_secrets WHERE tenant = ? AND key = ?', t.tenant, id)
  for (const s of secrets) {
    const ends = [s.valid_until, row.expires_at].filter((x): x is number => x !== null)
    const end = ends.length ? Math.min(...ends) : null
    if (end !== null && end <= now) {
      t.publish(`key:${s.key_id}`, null, now)
      continue
    }
    const record = { v: 1, tenant: t.tenant, secretSha256: s.secret_sha256, scopes: JSON.parse(row.scopes) as string[], disabled: row.disabled === 1 }
    t.publish(`key:${s.key_id}`, record, now, end === null ? null : Math.ceil(end / 1000))
  }
}

function bumpRevocation(t: Tenant, now: number): void {
  const prev = t.one<{ v: string }>("SELECT v FROM tenant_meta WHERE tenant = ? AND k = 'revocation'", t.tenant)
  const generation = (prev ? (JSON.parse(prev.v) as { generation: number }).generation : 0) + 1
  const value = { generation, revokedBefore: now }
  t.run("INSERT INTO tenant_meta (tenant, k, v) VALUES (?, 'revocation', ?) ON CONFLICT (tenant, k) DO UPDATE SET v = excluded.v", t.tenant, JSON.stringify(value))
  t.publish(`revocation:${t.tenant}`, value, now)
}

export function purgeStaleSecrets(t: Tenant, now: number): void {
  t.run('DELETE FROM key_secrets WHERE tenant = ? AND valid_until IS NOT NULL AND valid_until <= ?', t.tenant, now)
}

const mint = (): { keyId: string; secret: string } => ({ keyId: randomId(16), secret: randomId(40) })

/** Insert a key and queue its KV record. Returns the one and only copy of the full key. */
export function newKey(t: Tenant, actor: Actor, now: number, k: { name: string; scopes: string[]; kind: 'key' | 'agent'; expiresAt: number | null }): { view: Record<string, unknown>; secret: string } {
  const id = `k_${randomId(22)}`
  const { keyId, secret } = mint()
  t.run(
    'INSERT INTO keys (tenant, id, name, kind, scopes, key_id, created_at, created_by, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    t.tenant, id, k.name, k.kind, JSON.stringify(k.scopes), keyId, now, JSON.stringify(actor), k.expiresAt,
  )
  t.run('INSERT INTO key_secrets (tenant, key_id, key, secret_sha256, valid_until) VALUES (?, ?, ?, ?, NULL)', t.tenant, keyId, id, sha256Hex(secret))
  publishKey(t, id, now)
  return { view: keyView(t, load(t, id), now), secret: `viz_${keyId}_${secret}` }
}

/** A tenant must not lock itself out: its last live admin key cannot be disabled or deleted. */
function guardLastAdmin(t: Tenant, row: KeyRow, now: number, verb: string): void {
  if (!(JSON.parse(row.scopes) as string[]).includes('admin') || row.disabled === 1) return
  const others = t
    .all<{ scopes: string }>('SELECT scopes FROM keys WHERE tenant = ? AND id <> ? AND disabled = 0 AND (expires_at IS NULL OR expires_at > ?)', t.tenant, row.id, now)
    .filter((k) => (JSON.parse(k.scopes) as string[]).includes('admin'))
  if (others.length === 0) {
    throw new Problem(409, 'last-admin-key', `Cannot ${verb} the last enabled key with the admin scope: nobody could manage this tenant afterwards.`, 'Create another admin key first, then retry.')
  }
}

const list: Op = (t, c) => {
  const limit = pageLimit(c.input.query.limit?.[0])
  const after = decodeCursor(c.input.query.cursor?.[0], ['number', 'string'])
  const rows = t.all<KeyRow>(
    `SELECT ${COLUMNS} FROM keys WHERE tenant = ? AND (created_at > ? OR (created_at = ? AND id > ?)) ORDER BY created_at, id LIMIT ?`,
    t.tenant, (after?.[0] as number) ?? -1, (after?.[0] as number) ?? -1, (after?.[1] as string) ?? '', limit + 1,
  )
  const page = rows.slice(0, limit)
  const last = page[page.length - 1]
  return {
    status: 200,
    body: {
      items: page.map((row) => keyView(t, row, c.now)),
      next: rows.length > limit && last ? encodeCursor([last.created_at, last.id]) : null,
      // Until the data path calls Tenant.recordUsage, lastUsedAt and samples24h are null for every key.
      usage: { source: 'Tenant.recordUsage', resolution: '1h' },
    },
  }
}

const get: Op = (t, c) => ({ status: 200, body: { key: keyView(t, load(t, c.input.params.key!), c.now) } })

const create: Op = (t, c) => {
  const b = fields(c.input.body, ['name', 'scopes', 'kind', 'expiresAt', 'dryRun'], 'request body')
  const name = str(b.name, 'name', { max: 80 })!
  if (!Array.isArray(b.scopes) || b.scopes.length === 0 || !b.scopes.every((s) => typeof s === 'string' && (SCOPES as readonly string[]).includes(s))) {
    throw invalid('"scopes" must be a non-empty list of known scopes.', `Choose from: ${SCOPES.join(', ')}.`, { field: 'scopes' })
  }
  const scopes = [...new Set(b.scopes as string[])]
  const kind = b.kind === undefined ? 'key' : b.kind
  if (kind !== 'key' && kind !== 'agent') throw invalid('"kind" must be "key" or "agent".', 'Use "agent" for a key an agent will act with, so its changes are shown as made by an agent.', { field: 'kind' })
  let expiresAt: number | null = null
  if (b.expiresAt !== undefined && b.expiresAt !== null) {
    expiresAt = typeof b.expiresAt === 'string' ? Date.parse(b.expiresAt) : NaN
    if (!Number.isFinite(expiresAt) || expiresAt < c.now + MIN_EXPIRY_MS) {
      throw invalid('"expiresAt" must be an RFC 3339 time at least 5 minutes from now.', 'Send e.g. "2027-01-01T00:00:00Z", or leave it out for a key that does not expire.', { field: 'expiresAt' })
    }
  }
  if (t.one('SELECT id FROM keys WHERE tenant = ? AND name = ?', t.tenant, name)) {
    throw new Problem(409, 'name-taken', `A key named "${name}" already exists.`, 'Choose another name, or delete the existing key first.')
  }
  if (t.one<{ n: number }>('SELECT COUNT(*) AS n FROM keys WHERE tenant = ?', t.tenant)!.n >= t.caps.maxKeys) {
    throw new Problem(409, 'too-many-keys', `This tenant already has ${t.caps.maxKeys} keys, the most it may have.`, 'Delete keys that are no longer used.')
  }
  const k = newKey(t, c.actor, c.now, { name, scopes, kind, expiresAt })
  t.audit(c.actor, c.now, 'key.create', 'key', k.view.id as string, null, k.view)
  // A dry run mints nothing a caller could use: the secret it generated is rolled back with the rest.
  return { status: 201, body: { key: k.view, secret: c.dryRun ? null : k.secret, shownOnce: true } }
}

const setDisabled =
  (disabled: boolean): Op =>
  (t, c) => {
    fields(c.input.body, ['dryRun'], 'request body')
    const row = load(t, c.input.params.key!)
    if (disabled) guardLastAdmin(t, row, c.now, 'disable')
    const before = keyView(t, row, c.now)
    t.run('UPDATE keys SET disabled = ? WHERE tenant = ? AND id = ?', disabled ? 1 : 0, t.tenant, row.id)
    purgeStaleSecrets(t, c.now)
    publishKey(t, row.id, c.now)
    if (disabled) bumpRevocation(t, c.now)
    const after = keyView(t, load(t, row.id), c.now)
    t.audit(c.actor, c.now, disabled ? 'key.disable' : 'key.enable', 'key', row.id, before, after)
    return { status: 200, body: { key: after } }
  }

const rotate: Op = (t, c) => {
  const b = fields(c.input.body, ['overlapSeconds', 'dryRun'], 'request body')
  const overlap = b.overlapSeconds === undefined ? 0 : int(b.overlapSeconds, 'overlapSeconds', 0, MAX_OVERLAP_S)
  if (overlap > 0 && overlap < 60) {
    throw invalid('"overlapSeconds" must be 0 or at least 60.', 'The overlap is a KV expiration, which cannot be shorter than 60 seconds. Use 0 to end the old secret now.', { field: 'overlapSeconds' })
  }
  const row = load(t, c.input.params.key!)
  const before = keyView(t, row, c.now)
  purgeStaleSecrets(t, c.now)
  if (overlap === 0) {
    // Every earlier secret of this key ends now, including ones still inside an older overlap.
    for (const s of t.all<{ key_id: string }>('SELECT key_id FROM key_secrets WHERE tenant = ? AND key = ?', t.tenant, row.id)) t.publish(`key:${s.key_id}`, null, c.now)
    t.run('DELETE FROM key_secrets WHERE tenant = ? AND key = ?', t.tenant, row.id)
    bumpRevocation(t, c.now)
  } else {
    t.run('UPDATE key_secrets SET valid_until = ? WHERE tenant = ? AND key = ? AND valid_until IS NULL', c.now + overlap * 1000, t.tenant, row.id)
  }
  const { keyId, secret } = mint()
  t.run('INSERT INTO key_secrets (tenant, key_id, key, secret_sha256, valid_until) VALUES (?, ?, ?, ?, NULL)', t.tenant, keyId, row.id, sha256Hex(secret))
  t.run('UPDATE keys SET key_id = ?, rotated_at = ? WHERE tenant = ? AND id = ?', keyId, c.now, t.tenant, row.id)
  publishKey(t, row.id, c.now)
  const after = keyView(t, load(t, row.id), c.now)
  t.audit(c.actor, c.now, 'key.rotate', 'key', row.id, before, { ...after, overlapSeconds: overlap })
  return { status: 200, body: { key: after, secret: c.dryRun ? null : `viz_${keyId}_${secret}`, shownOnce: true, overlapSeconds: overlap } }
}

const remove: Op = (t, c) => {
  const b = fields(c.input.body, ['confirmName', 'dryRun'], 'request body')
  const row = load(t, c.input.params.key!)
  const confirm = b.confirmName ?? c.input.query.confirmName?.[0]
  if (confirm !== row.name) {
    throw invalid('Deleting a key needs its name repeated as confirmation.', 'Send {"confirmName": "<the key\'s exact name>"} in the body (or ?confirmName=). To stop a key without deleting it, disable it.', { field: 'confirmName' })
  }
  guardLastAdmin(t, row, c.now, 'delete')
  const before = keyView(t, row, c.now)
  for (const s of t.all<{ key_id: string }>('SELECT key_id FROM key_secrets WHERE tenant = ? AND key = ?', t.tenant, row.id)) t.publish(`key:${s.key_id}`, null, c.now)
  t.run('DELETE FROM key_secrets WHERE tenant = ? AND key = ?', t.tenant, row.id)
  t.run('DELETE FROM key_usage WHERE tenant = ? AND key = ?', t.tenant, row.id)
  t.run('DELETE FROM keys WHERE tenant = ? AND id = ?', t.tenant, row.id)
  bumpRevocation(t, c.now)
  t.audit(c.actor, c.now, 'key.delete', 'key', row.id, before, null)
  return { status: 200, body: { deleted: row.id } }
}

export const keyOps = {
  'keys.list': list,
  'keys.get': get,
  'keys.create': create,
  'keys.disable': setDisabled(true),
  'keys.enable': setDisabled(false),
  'keys.rotate': rotate,
  'keys.delete': remove,
} satisfies Record<string, Op>

export type { Ctx }
