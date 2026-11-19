import { Problem, invalid, notFound } from './errors'
import type { Actor } from './identity'
import { PROPOSAL_TTL_DAYS } from './caps'
import { type Ctx, NoChange, type Op, type Tenant } from './tenant'
import { fields, int, isRecord, iso } from './util'

/**
 * Settings, one versioned JSON value per section. Three sections are also published to KV
 * for the data path, in the shapes the readers already use:
 *
 *   retention:<tenant> → { metric_samples_days: N, … }           (janitor/src/janitor.ts)
 *   limits:<tenant>    → { active_series: N, … }                 (edge/src/route.ts)
 *   pool:<tenant>      → { pool, slots, spread, epoch }          (shard/src/pool.ts `PoolMap`)
 *
 * `notifications` is not published to KV: its webhook secret must not sit in a namespace every
 * Worker reads. The ruler asks for it over the Durable Object binding instead
 * (`Tenant.notificationTarget`, contracts/control.ts). The secret is write-only: it is kept in
 * `tenant_meta` (k `notifications.webhookSecret`), never in the section's value, so no read,
 * list or audit entry can carry it; the value records only when it was set
 * (`webhookSecretSetAt`).
 */
import type { NotificationTargetResult, WebhookFormat } from '../../contracts/control'
import { DERIVED_SIGNALS } from '../../shard/src/pool'

export const SECTIONS = ['general', 'retention', 'limits', 'pool', 'notifications'] as const
export type Section = (typeof SECTIONS)[number]

export interface General {
  /** May an agent identity apply its own changes? Default false: a person approves. */
  agentsMayApply: boolean
  proposalTtlDays: number
}

const DEFAULTS: Record<Section, unknown> = {
  general: { agentsMayApply: false, proposalTtlDays: PROPOSAL_TTL_DAYS } satisfies General,
  // What the readers assume when KV has no record.
  retention: { metric_samples_days: 30 },
  limits: { active_series: 1_000_000 },
  pool: null,
  notifications: { email: [], webhookUrl: null, webhookFormat: 'alertmanager', sendResolved: true, webhookSecretSetAt: null } satisfies NotificationsValue,
}

/** The `notifications` section as stored. Values written before the webhook fields existed lack them; `notificationsOf` fills the defaults. */
export interface NotificationsValue {
  email: string[]
  webhookUrl: string | null
  webhookFormat: WebhookFormat
  sendResolved: boolean
  /** When the current webhook secret was set (Unix ms); null: requests are not signed. The secret itself is never here. */
  webhookSecretSetAt: number | null
}

/** Where the webhook secret is kept: `tenant_meta`, never in a value an API returns. */
const SECRET_KEY = 'notifications.webhookSecret'
const SECRET_MIN = 16
const SECRET_MAX = 512

interface SettingRow {
  section: Section
  version: number
  value: string
  updated_at: number
  updated_by: string
}

function row(t: Tenant, section: Section): SettingRow | undefined {
  return t.one<SettingRow>('SELECT section, version, value, updated_at, updated_by FROM settings WHERE tenant = ? AND section = ?', t.tenant, section)
}

export function general(t: Tenant): General {
  const r = row(t, 'general')
  return r ? (JSON.parse(r.value) as General) : (DEFAULTS.general as General)
}

function view(section: Section, r: SettingRow | undefined): Record<string, unknown> {
  return {
    section,
    version: r?.version ?? 0,
    // `value` is what was set; `effective` is what applies, i.e. the default when nothing was set.
    value: r ? (JSON.parse(r.value) as unknown) : null,
    effective: r ? (JSON.parse(r.value) as unknown) : DEFAULTS[section],
    updatedAt: iso(r?.updated_at),
    updatedBy: r ? (JSON.parse(r.updated_by) as Actor) : null,
    publishedTo: section === 'retention' || section === 'limits' || section === 'pool' ? `${section}:<tenant>` : null,
  }
}

function sectionOf(c: Ctx): Section {
  const s = c.input.params.section!
  if (!(SECTIONS as readonly string[]).includes(s)) throw notFound('settings section')
  return s as Section
}

// ---- validation: each returns the value to store ----

const RETENTION_KEYS = ['metric_samples_days', 'metric_5m_days', 'metric_1h_days', 'log_days', 'trace_days'] as const

function validateRetention(v: Record<string, unknown>, before: Record<string, number>, confirmShorter: boolean): Record<string, number> {
  const out: Record<string, number> = {}
  for (const k of RETENTION_KEYS) if (v[k] !== undefined) out[k] = int(v[k], k, 1, 3650)
  if (out.metric_samples_days === undefined) throw invalid('"metric_samples_days" is required.', 'Send at least {"metric_samples_days": 30}. Tiers: metric_5m_days, metric_1h_days; other signals: log_days, trace_days.', { field: 'metric_samples_days' })
  const tiers = [out.metric_samples_days, out.metric_5m_days, out.metric_1h_days]
  for (let i = 1; i < tiers.length; i++) {
    const coarser = tiers[i]
    const finer = tiers.slice(0, i).filter((x): x is number => x !== undefined).pop()
    if (coarser !== undefined && finer !== undefined && coarser < finer) {
      throw invalid('A coarser rollup tier cannot be kept for less time than a finer one.', 'Keep metric_samples_days ≤ metric_5m_days ≤ metric_1h_days.', { field: RETENTION_KEYS[i] })
    }
  }
  // Shortening retention deletes data that cannot be brought back, so it has to be said twice.
  const shorter = Object.keys(before).filter((k) => out[k] !== undefined && out[k]! < before[k]!)
  if (shorter.length && !confirmShorter) {
    throw new Problem(422, 'confirmation-required', `This shortens retention (${shorter.map((k) => `${k}: ${before[k]} → ${out[k]}`).join(', ')}). Data older than the new period is deleted for good.`, 'Send "confirmShorter": true to go ahead. dryRun shows the change without making it.', { shortened: shorter })
  }
  return out
}

const LIMIT_KEYS: Record<string, [number, number]> = {
  active_series: [1, 1_000_000_000],
  samples_per_second: [1, 100_000_000],
  query_max_series: [1, 100_000_000],
  query_max_samples: [1, 100_000_000_000],
  query_timeout_seconds: [1, 600],
  query_max_range_days: [1, 3650],
  query_concurrency: [1, 1000],
}

function validateLimits(t: Tenant, v: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {}
  const ceilings = t.limitCeilings
  for (const [k, [min, max]] of Object.entries(LIMIT_KEYS)) {
    if (v[k] === undefined) continue
    out[k] = int(v[k], k, min, max)
    const ceiling = ceilings[k]
    if (typeof ceiling === 'number' && out[k]! > ceiling) {
      throw invalid(`"${k}" may be at most ${ceiling} in this deployment.`, 'Ask the operator to raise the ceiling (LIMIT_CEILINGS), or choose a lower value.', { field: k, ceiling })
    }
  }
  if (Object.keys(out).length === 0) throw invalid('At least one limit is required.', `Limits: ${Object.keys(LIMIT_KEYS).join(', ')}.`)
  return out
}

interface PoolValue {
  pool: string
  slots: number
  spread: number
  epoch: number
}

/**
 * The pool map. Only two changes are safe without the drain-and-handover protocol of
 * DESIGN §4.1, which does not exist yet: giving the tenant its first own map, and raising
 * `spread`. Everything else moves keys between shards that still hold unrecorded data and
 * dedup fingerprints, and is refused.
 */
function validatePool(t: Tenant, v: Record<string, unknown>, before: PoolValue | null): PoolValue {
  if (v.epoch !== undefined) throw invalid('"epoch" is assigned by viz, not by the caller.', 'Send {"pool","slots","spread"} only; the epoch is bumped for you.', { field: 'epoch' })
  if (typeof v.pool !== 'string') throw invalid('"pool" must be a string.', `Use "tenant/${t.tenant}" for a dedicated pool, or the shared pool's name.`, { field: 'pool' })
  const slots = int(v.slots, 'slots', 1, 1024)
  const spread = int(v.spread, 'spread', 1, 64)
  if (spread > slots) throw invalid('"spread" cannot exceed "slots".', 'A tenant can use at most every slot of its pool.', { field: 'spread' })
  const shared = t.sharedPool
  if (v.pool !== `tenant/${t.tenant}` && v.pool !== shared.pool) {
    throw invalid(`A tenant may only use its own pool ("tenant/${t.tenant}")${typeof shared.pool === 'string' ? ` or the shared pool ("${shared.pool}")` : ''}.`, 'Another tenant\'s dedicated pool is not yours to write to.', { field: 'pool' })
  }
  // contracts/BATCH.md "Streams per signal", D66: a pool map's pool never ends in a derived pool's
  // suffix, or its metric shards would be another pool's span or log shards; edge refuses such a
  // map (503 for every write). So the dedicated pool of a tenant named `traces` or `logs` is refused.
  const pool = v.pool
  const derived = DERIVED_SIGNALS.find((s) => pool.endsWith(`/${s}`))
  if (derived !== undefined) {
    const fix = pool === shared.pool
      ? 'The shared pool itself breaks this rule, and the data path refuses it for every tenant: the operator must rename it (DEFAULT_POOL).'
      : `Use the shared pool${typeof shared.pool === 'string' ? ` ("${shared.pool}")` : ''}. A tenant whose id is "traces" or "logs" cannot have a dedicated pool.`
    throw invalid(`The pool "${pool}" ends in "/${derived}", the suffix of the derived ${derived} pools; the data path refuses a pool map whose pool ends so.`, fix, { field: 'pool' })
  }
  if (v.pool === shared.pool && slots !== shared.slots) throw invalid(`The shared pool has ${String(shared.slots)} slots.`, 'A tenant can choose its spread within the shared pool, not the pool\'s size.', { field: 'slots' })
  // The first own map starts above the shared map's epoch, so a shard never sees it as older.
  const sharedEpoch = typeof shared.epoch === 'number' && Number.isInteger(shared.epoch) && shared.epoch >= 0 ? shared.epoch : 0
  if (before === null) return { pool: v.pool, slots, spread, epoch: sharedEpoch + 1 }
  const unsupported = (what: string): Problem =>
    new Problem(409, 'pool-change-unsupported', `Changing ${what} needs the drain-and-handover protocol (DESIGN §4.1), which is not implemented: old shards must be recorded and their dedup fingerprints handed over first. Nothing was changed.`, 'Only raising "spread" is possible for now. Keep "pool" and "slots" as they are.', { current: before })
  if (v.pool !== before.pool) throw unsupported('the pool')
  if (slots !== before.slots) throw unsupported('the number of slots')
  if (spread < before.spread) throw unsupported('"spread" downwards')
  return { pool: v.pool, slots, spread, epoch: spread === before.spread ? before.epoch : before.epoch + 1 }
}

function notificationsOf(raw: unknown): NotificationsValue {
  const v = (isRecord(raw) ? raw : {}) as Partial<NotificationsValue>
  return {
    email: Array.isArray(v.email) ? v.email : [],
    webhookUrl: typeof v.webhookUrl === 'string' ? v.webhookUrl : null,
    webhookFormat: v.webhookFormat === 'json' ? 'json' : 'alertmanager',
    sendResolved: v.sendResolved !== false,
    webhookSecretSetAt: typeof v.webhookSecretSetAt === 'number' ? v.webhookSecretSetAt : null,
  }
}

function storedSecret(t: Tenant): { secret: string; setAt: number } | null {
  const r = t.one<{ v: string }>('SELECT v FROM tenant_meta WHERE tenant = ? AND k = ?', t.tenant, SECRET_KEY)
  return r ? (JSON.parse(r.v) as { secret: string; setAt: number }) : null
}

/**
 * The value to store, and what to do with the secret. `webhookSecret` is write-only: a string
 * sets it, null or "" removes it, and leaving it out keeps the stored one, but only while the
 * URL stays the same (a secret never follows a webhook to a new address).
 */
function validateNotifications(v: Record<string, unknown>, before: NotificationsValue, now: number): { value: NotificationsValue; secret: string | null | undefined } {
  const o = fields(v, ['email', 'webhookUrl', 'webhookFormat', 'sendResolved', 'webhookSecret', 'webhookSecretSetAt'], 'notifications value')
  const email = o.email ?? []
  if (!Array.isArray(email) || email.length > 20 || !email.every((e) => typeof e === 'string' && /^[^\s@]{1,64}@[^\s@]{1,255}$/.test(e))) throw invalid('"email" must be a list of at most 20 addresses.', 'Send e.g. ["oncall@example.com"].', { field: 'email' })
  let webhookUrl: string | null = null
  if (o.webhookUrl !== undefined && o.webhookUrl !== null) {
    let ok = false
    try {
      ok = typeof o.webhookUrl === 'string' && o.webhookUrl.length <= 2000 && new URL(o.webhookUrl).protocol === 'https:'
    } catch {
      ok = false
    }
    if (!ok) throw invalid('"webhookUrl" must be an https URL.', 'Send an https:// URL, or null.', { field: 'webhookUrl' })
    webhookUrl = o.webhookUrl as string
  }
  const format = o.webhookFormat ?? 'alertmanager'
  if (format !== 'alertmanager' && format !== 'json') throw invalid('"webhookFormat" must be "alertmanager" or "json".', '"alertmanager" sends Alertmanager\'s webhook JSON (version 4); "json" sends viz\'s plain form (viz.notification/v1).', { field: 'webhookFormat' })
  if (o.sendResolved !== undefined && typeof o.sendResolved !== 'boolean') throw invalid('"sendResolved" must be true or false.', 'Send a boolean; the default is true.', { field: 'sendResolved' })
  // Assigned here; a client that sends back what it read may repeat it, but not choose it.
  if (o.webhookSecretSetAt !== undefined && o.webhookSecretSetAt !== before.webhookSecretSetAt) {
    throw invalid('"webhookSecretSetAt" is assigned by viz.', 'Leave it out. Send "webhookSecret" to set or replace the secret, or null to remove it.', { field: 'webhookSecretSetAt' })
  }
  let secret: string | null | undefined
  let setAt: number | null
  if (o.webhookSecret === null || o.webhookSecret === '') {
    secret = null
    setAt = null
  } else if (o.webhookSecret !== undefined) {
    if (typeof o.webhookSecret !== 'string' || o.webhookSecret.length < SECRET_MIN || o.webhookSecret.length > SECRET_MAX) {
      throw invalid(`"webhookSecret" must be a string of ${SECRET_MIN} to ${SECRET_MAX} characters.`, 'Use a random secret the receiver verifies X-Viz-Signature with; it is never shown again.', { field: 'webhookSecret' })
    }
    if (webhookUrl === null) throw invalid('"webhookSecret" needs a "webhookUrl".', 'Set the webhook URL in the same request, or leave the secret out.', { field: 'webhookSecret' })
    secret = o.webhookSecret
    setAt = now
  } else if (webhookUrl !== null && webhookUrl === before.webhookUrl && before.webhookSecretSetAt !== null) {
    secret = undefined // kept
    setAt = before.webhookSecretSetAt
  } else {
    // No URL, or a new one: a secret does not follow a webhook to another address.
    secret = before.webhookSecretSetAt !== null ? null : undefined
    setAt = null
  }
  return { value: { email: email as string[], webhookUrl, webhookFormat: format, sendResolved: o.sendResolved !== false, webhookSecretSetAt: setAt }, secret }
}

/**
 * contracts/control.ts `notificationTarget`: the default destination as the ruler's notifier
 * needs it, secret included. The secret is used only while the stored value says it is the one
 * set with it (`webhookSecretSetAt`): a release that rewrites the value without the field (a
 * rollback) leaves requests unsigned rather than signed with a secret nobody set for that URL.
 */
export function notificationTarget(t: Tenant): NotificationTargetResult {
  const r = row(t, 'notifications')
  const value = notificationsOf(r ? (JSON.parse(r.value) as unknown) : DEFAULTS.notifications)
  if (value.webhookUrl === null) return { v: 1, status: 'ok', version: r?.version ?? 0, target: null }
  const stored = storedSecret(t)
  const secret = stored !== null && value.webhookSecretSetAt !== null && stored.setAt === value.webhookSecretSetAt ? stored.secret : null
  return { v: 1, status: 'ok', version: r?.version ?? 0, target: { url: value.webhookUrl, format: value.webhookFormat, sendResolved: value.sendResolved, secret } }
}

function validateGeneral(v: Record<string, unknown>): General {
  const o = fields(v, ['agentsMayApply', 'proposalTtlDays'], 'general value')
  if (o.agentsMayApply !== undefined && typeof o.agentsMayApply !== 'boolean') throw invalid('"agentsMayApply" must be true or false.', 'Send a boolean.', { field: 'agentsMayApply' })
  return {
    agentsMayApply: o.agentsMayApply === true,
    proposalTtlDays: o.proposalTtlDays === undefined ? PROPOSAL_TTL_DAYS : int(o.proposalTtlDays, 'proposalTtlDays', 1, 90),
  }
}

// ---- operations ----

const list: Op = (t) => ({ status: 200, body: { items: SECTIONS.map((s) => view(s, row(t, s))) } })

const get: Op = (t, c) => {
  const section = sectionOf(c)
  return { status: 200, body: view(section, row(t, section)) }
}

const put: Op = (t, c) => {
  const section = sectionOf(c)
  const b = fields(c.input.body, ['value', 'version', 'confirmShorter', 'dryRun'], 'request body')
  if (!isRecord(b.value)) throw invalid('"value" must be a JSON object.', `Send {"value": {…}} for the ${section} section.`, { field: 'value' })
  const current = row(t, section)
  const version = current?.version ?? 0
  if (b.version !== undefined && b.version !== version) {
    throw new Problem(409, 'stale-version', `The ${section} settings are at version ${version}, not ${String(b.version)}. Nothing was changed.`, 'Read the section again and resend with its current "version".', { currentVersion: version, current: view(section, current) })
  }
  const before = current ? (JSON.parse(current.value) as unknown) : null
  for (const k of Object.keys(b.value)) {
    const known = section === 'retention' ? (RETENTION_KEYS as readonly string[]) : section === 'limits' ? Object.keys(LIMIT_KEYS) : section === 'pool' ? ['pool', 'slots', 'spread', 'epoch'] : null
    if (known && !known.includes(k)) throw invalid(`Unknown ${section} setting "${k}".`, `Known: ${known.filter((x) => x !== 'epoch').join(', ')}.`, { field: k })
  }
  let value: unknown
  if (section === 'retention') value = validateRetention(b.value, (before ?? DEFAULTS.retention) as Record<string, number>, b.confirmShorter === true)
  else if (section === 'limits') value = validateLimits(t, b.value)
  else if (section === 'pool') value = validatePool(t, b.value, before as PoolValue | null)
  else if (section === 'notifications') {
    const n = validateNotifications(b.value, notificationsOf(before ?? DEFAULTS.notifications), c.now)
    value = n.value
    // In the same transaction as the value; rolled back with it on a dry run. Never in the value or the audit row.
    if (n.secret === null) t.run('DELETE FROM tenant_meta WHERE tenant = ? AND k = ?', t.tenant, SECRET_KEY)
    else if (n.secret !== undefined) {
      t.run('INSERT INTO tenant_meta (tenant, k, v) VALUES (?, ?, ?) ON CONFLICT (tenant, k) DO UPDATE SET v = excluded.v', t.tenant, SECRET_KEY, JSON.stringify({ secret: n.secret, setAt: n.value.webhookSecretSetAt }))
    }
  } else value = validateGeneral(b.value)

  const text = JSON.stringify(value)
  if (current && current.value === text) throw new NoChange({ status: 200, body: { outcome: 'unchanged', ...view(section, current) } })
  t.run(
    'INSERT INTO settings (tenant, section, version, value, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (tenant, section) DO UPDATE SET version = excluded.version, value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by',
    t.tenant, section, version + 1, text, c.now, JSON.stringify(c.actor),
  )
  if (section === 'retention' || section === 'limits' || section === 'pool') t.publish(`${section}:${t.tenant}`, value, c.now)
  t.audit(c.actor, c.now, `settings.${section}`, 'setting', section, { version, value: before }, { version: version + 1, value })
  return { status: 200, body: { outcome: 'applied', ...view(section, row(t, section)) } }
}

export const settingsOps = {
  'settings.list': list,
  'settings.get': get,
  'settings.put': put,
} satisfies Record<string, Op>
