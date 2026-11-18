/**
 * The ruler's HTTP API. Two faces over the same objects:
 *
 *   /api/v1/rules, /api/v1/alerts     Prometheus' own response shapes, read-only, so
 *                                     Grafana's alerting views and promtool-style clients work.
 *   /api/v1/monitors/...              viz's API: monitors, rule groups, rule files,
 *                                     acknowledge, silence, backtest, notifier config.
 *
 * Authentication is edge's API-key verification, imported, not copied. The tenant is the
 * one in the key record and nothing else: no path segment, query parameter, header or
 * body field is read for it. Every route names the scope it needs in `ROUTES`, which is
 * also what `openapi.json` is checked against.
 */
import { authenticate } from '../../edge/src/auth'
import { HttpError } from '../../edge/src/errors'
import type {
  AlertingRuleV2,
  DescribeItem,
  DescribeResult,
  GroupBundle,
  GroupSnapshot,
  MonitorMeta,
  MonitorView,
  NotifierRpcV2,
  RuleGroup,
  RulerIndexRpc,
  RulerRpcV2,
  RuleSnapshot,
  SaveGroupsResult,
  Timeline,
  ValidationError,
} from '../contracts-proposal/rules.v2'
import { adoptMonitors, defaultGroup, mergeTimelines, MONITOR_GROUP_CAP, monitorIdOf, monitorPaths, monitorView, planMonitor, routingLabels } from './monitors'
import { assign, DEFAULT_PLACEMENT, shardOf, type GroupSize, type PlacementLimits } from './placement'
import { indexName } from './registry'
import { exportRuleFile, importRuleFile, ruleFileDocument } from './rulefile'
import { DEADMAN_GROUP } from './rules'
import { mapLimit, parseDuration, rfc3339 } from './util'

export type Scope = 'monitors:read' | 'monitors:write' | 'monitors:ack'

export interface ApiEnv {
  /** edge's key store: `key:<keyId>` → { tenant, secretSha256, scopes }. */
  CONFIG: KVNamespace
  RULER: DurableObjectNamespace
  NOTIFIER: DurableObjectNamespace
  RULER_INDEX: DurableObjectNamespace
}

export interface ApiOptions {
  placement?: PlacementLimits
  now?: () => number
}

type RulerStub = RulerRpcV2
type NotifierStub = NotifierRpcV2 & { expireSilence(tenant: string, id: string, by?: string, dryRun?: boolean): Promise<{ status: 'ok' } | { status: 'not_found' } | { status: 'wrong_tenant' }> }

const MAX_BODY_BYTES = 4 << 20
const ZERO_TIME = '0001-01-01T00:00:00Z'

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } })
}

/** An error of viz's own API. `problems` carries validation errors, each with a path and a fix. */
class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly problems?: ValidationError[],
  ) {
    super(message)
  }
}

const invalid = (problems: ValidationError[]): ApiError => new ApiError(422, 'invalid', `${problems.length} problem${problems.length === 1 ? '' : 's'} found; nothing was saved`, problems)
const notFound = (what: string): ApiError => new ApiError(404, 'not_found', `${what} not found`)

/** Unwrap an object's answer. `wrong_tenant` here would mean this layer addressed another tenant's object: a bug, never the caller's fault. */
function ok<T extends { status: string }>(r: T): Exclude<T, { status: 'wrong_tenant' }> {
  if (r.status === 'wrong_tenant') throw new ApiError(500, 'internal', 'an object refused its own tenant')
  return r as Exclude<T, { status: 'wrong_tenant' }>
}

/** One authenticated request: the tenant and actor from the credential, and the tenant's objects. */
class Call {
  readonly url: URL
  private shardCount: number | null = null
  constructor(
    readonly req: Request,
    readonly env: ApiEnv,
    /** From the API key record. The only source of the tenant in this file. */
    readonly tenant: string,
    readonly by: string,
    readonly params: Record<string, string>,
    readonly opts: Required<ApiOptions>,
  ) {
    this.url = new URL(req.url)
  }

  ruler(shard: number | string): RulerStub {
    return this.env.RULER.get(this.env.RULER.idFromName(`${this.tenant}/${shard}`)) as unknown as RulerStub
  }
  notifier(): NotifierStub {
    return this.env.NOTIFIER.get(this.env.NOTIFIER.idFromName(this.tenant)) as unknown as NotifierStub
  }
  index(): RulerIndexRpc {
    return this.env.RULER_INDEX.get(this.env.RULER_INDEX.idFromName(indexName(this.tenant))) as unknown as RulerIndexRpc
  }
  async shards(): Promise<number> {
    this.shardCount ??= (await this.index().shardCount(this.tenant)).shards
    return this.shardCount
  }
  setShards(n: number): void {
    this.shardCount = n
  }

  /** Every group of the tenant with the shard that holds it. A group found on two shards (a move in progress) is read from the one it is assigned to. */
  async groups(): Promise<{ shard: string; group: GroupSnapshot }[]> {
    const n = await this.shards()
    // A Worker has six outbound connections; stay under them.
    const snaps = await mapLimit(Array.from({ length: n }, (_, i) => i), 4, async (i) => ok(await this.ruler(i).snapshot(this.tenant)))
    const out = new Map<string, { shard: string; group: GroupSnapshot }>()
    for (const s of snaps) {
      for (const group of s.groups) {
        const seen = out.get(group.name)
        if (!seen || String(shardOf(group.name, n)) === s.shard) out.set(group.name, { shard: s.shard, group })
      }
    }
    return [...out.values()].sort((a, b) => Number(a.shard) - Number(b.shard) || (a.group.name < b.group.name ? -1 : 1))
  }

  /** Where every group is now, including strays, for placement. */
  async locations(): Promise<{ name: string; shard: number; rules: number }[]> {
    const n = await this.shards()
    const snaps = await mapLimit(Array.from({ length: n }, (_, i) => i), 4, async (i) => ok(await this.ruler(i).listGroups(this.tenant)).groups.map((g: RuleGroup) => ({ name: g.name, shard: i, rules: g.rules.length })))
    return snaps.flat().filter((g) => g.name !== DEADMAN_GROUP)
  }

  dryRun(body?: unknown): boolean {
    const q = this.url.searchParams.get('dryRun')
    if (q !== null) return q === 'true' || q === '1'
    return typeof body === 'object' && body !== null && (body as { dryRun?: unknown }).dryRun === true
  }

  async body(): Promise<unknown> {
    const text = await this.text()
    if (text.trim() === '') return {}
    try {
      return JSON.parse(text)
    } catch {
      throw new ApiError(400, 'bad_request', 'the request body is not valid JSON')
    }
  }

  async text(): Promise<string> {
    const bytes = await this.req.arrayBuffer()
    if (bytes.byteLength > MAX_BODY_BYTES) throw new ApiError(413, 'too_large', `the request body is larger than ${MAX_BODY_BYTES} bytes`)
    return new TextDecoder().decode(bytes)
  }
}

// ───────────────────────────── placement and moves ─────────────────────────────

/** Move one group to another shard with its alert state: copy, then release. Idempotent; safe to repeat after a crash in the middle. */
async function moveGroup(c: Call, name: string, from: number, to: number, targetHasIt: boolean): Promise<void> {
  if (!targetHasIt) {
    const exported = ok(await c.ruler(from).exportGroup(c.tenant, name))
    if (exported.status === 'not_found') return
    const imported = ok(await c.ruler(to).importGroup(c.tenant, exported.bundle as GroupBundle))
    if (imported.status !== 'ok') throw invalid(imported.errors)
  }
  ok(await c.ruler(from).releaseGroup(c.tenant, name))
}

/**
 * Decide where groups live once `changes` (group → new rule count; 0 removes) are applied,
 * grow the shard count if a shard would exceed its limit, and, unless `dryRun`, move every
 * group that is not on its assigned shard. Returns the assignment.
 */
async function place(c: Call, changes: Map<string, number>, dryRun: boolean): Promise<Map<string, number>> {
  const current = await c.locations()
  const sizes = new Map<string, number>(current.map((g) => [g.name, g.rules]))
  for (const [name, rules] of changes) {
    if (rules === 0) sizes.delete(name)
    else sizes.set(name, rules)
  }
  const list: GroupSize[] = [...sizes].map(([name, rules]) => ({ name, rules }))
  const n = await c.shards()
  const a = assign(list, n, c.opts.placement)
  if (!a.ok) throw invalid([a.error])
  if (dryRun) return a.placement
  if (a.shards > n) c.setShards((await c.index().growShards(c.tenant, a.shards)).shards)
  for (const g of current) {
    const target = a.placement.get(g.name)
    if (target === undefined || target === g.shard) continue
    await moveGroup(c, g.name, g.shard, target, current.some((x) => x.name === g.name && x.shard === target))
  }
  return a.placement
}

/** Save a rule-file document: each group on its assigned shard, validated everywhere before anything is written. */
async function saveDocument(c: Call, file: unknown, dryRun: boolean): Promise<unknown> {
  const groups = typeof file === 'object' && file !== null && Array.isArray((file as { groups?: unknown }).groups) ? ((file as { groups: unknown[] }).groups as unknown[]) : null
  if (groups === null || Object.keys(file as object).some((k) => k !== 'groups')) {
    // Not even the outer shape: let the validator say what is wrong.
    const r = ok(await c.ruler(0).checkGroups(c.tenant, file))
    throw invalid(r.status === 'invalid' ? r.errors : [{ path: 'groups', message: 'a rule file is an object with a "groups" list', fix: 'Send { "groups": [...] }.' }])
  }
  const named = (g: unknown): g is { name: string; rules: unknown[] } => typeof g === 'object' && g !== null && typeof (g as { name?: unknown }).name === 'string' && Array.isArray((g as { rules?: unknown }).rules)
  const changes = new Map<string, number>()
  for (const g of groups) if (named(g) && g.rules.length > 0) changes.set(g.name, g.rules.length)
  const placement = await place(c, changes, true)
  const byShard = new Map<number, number[]>()
  groups.forEach((g, i) => {
    const shard = named(g) ? (placement.get(g.name) ?? 0) : 0
    byShard.set(shard, [...(byShard.get(shard) ?? []), i])
  })
  const remap = (errors: ValidationError[], indexes: number[]) => errors.map((e) => ({ ...e, path: e.path.replace(/^groups\[(\d+)\]/, (_m, k: string) => `groups[${indexes[Number(k)]}]`) }))
  const run = async (how: 'checkGroups' | 'saveGroups') => {
    const problems: ValidationError[] = []
    const warnings: ValidationError[] = []
    const saved: unknown[] = []
    for (const [shard, indexes] of byShard) {
      const r: SaveGroupsResult = await c.ruler(shard)[how](c.tenant, { groups: indexes.map((i) => groups[i]) })
      const res = ok(r)
      if (res.status === 'invalid') problems.push(...remap(res.errors, indexes))
      else {
        warnings.push(...remap(res.warnings, indexes))
        for (const g of res.groups) saved.push({ ...g, shard: String(shard) })
      }
    }
    if (problems.length > 0) throw invalid(problems)
    return { groups: saved, warnings }
  }
  const checked = await run('checkGroups')
  if (dryRun) return { dryRun: true, ...checked }
  await place(c, changes, false)
  return { dryRun: false, ...(await run('saveGroups')) }
}

// ───────────────────────────── monitors ─────────────────────────────

interface Found {
  shard: string
  group: GroupSnapshot
  snap: RuleSnapshot
  rule: AlertingRuleV2
}

function alertingRules(groups: { shard: string; group: GroupSnapshot }[]): Found[] {
  const out: Found[] = []
  for (const { shard, group } of groups) {
    if (group.name === DEADMAN_GROUP) continue
    for (const snap of group.rules) if (snap.rule.kind === 'alert') out.push({ shard, group, snap, rule: snap.rule })
  }
  return out
}

async function findMonitor(c: Call): Promise<Found> {
  const id = c.params.id as string
  const hit = alertingRules(await c.groups()).find((f) => monitorIdOf(f.group.name, f.rule) === id)
  if (!hit) throw notFound(`monitor ${id}`)
  return hit
}

async function views(c: Call, found: Found[]): Promise<MonitorView[]> {
  const items: DescribeItem[] = found.map((f) => ({ ref: monitorIdOf(f.group.name, f.rule), labels: routingLabels(f.rule), fingerprints: f.snap.alerts.filter((a) => a.state === 'firing').map((a) => a.fingerprint) }))
  const described = items.length > 0 ? ok(await c.notifier().describe(c.tenant, items)).results : []
  const byRef = new Map<string, DescribeResult>(described.map((d) => [d.ref, d]))
  return found.map((f) => monitorView(f.group, f.shard, f.snap, byRef.get(monitorIdOf(f.group.name, f.rule))))
}

const NEEDS_ATTENTION = new Set(['firing', 'pending', 'no_data', 'error'])

async function listMonitors(c: Call): Promise<Response> {
  const groups = await c.groups()
  const all = await views(c, alertingRules(groups))
  const filter = c.url.searchParams.get('filter') ?? 'all'
  if (!['all', 'attention', 'silenced'].includes(filter)) throw new ApiError(400, 'bad_request', 'filter must be all, attention or silenced')
  const monitors = all.filter((m) => (filter === 'attention' ? NEEDS_ATTENTION.has(m.state) : filter === 'silenced' ? m.silencedUntil !== null : true))
  const counts: Record<string, number> = { firing: 0, pending: 0, no_data: 0, error: 0, ok: 0, unknown: 0 }
  for (const m of all) counts[m.state] = (counts[m.state] ?? 0) + 1
  const evaluated = groups.map((g) => g.group.lastEvaluationMs).filter((t): t is number => t !== null)
  const watchdog = groups.find((g) => g.group.name === DEADMAN_GROUP)
  return json(200, {
    monitors,
    counts,
    total: all.length,
    lastEvaluationMs: evaluated.length > 0 ? Math.max(...evaluated) : null,
    watchdog: watchdog ? { lastEvaluationMs: watchdog.group.lastEvaluationMs, firing: watchdog.group.rules.some((r) => r.alerts.some((a) => a.state === 'firing')) } : null,
    nowMs: c.opts.now(),
  })
}

async function history(c: Call, id: string): Promise<Timeline> {
  const n = await c.shards()
  const parts = await mapLimit(Array.from({ length: n }, (_, i) => i), 4, async (i) => ok(await c.ruler(i).timeline(c.tenant, id)))
  const sent = ok(await c.notifier().notificationLog(c.tenant, id))
  return mergeTimelines([...parts, sent])
}

async function getMonitor(c: Call): Promise<Response> {
  const f = await findMonitor(c)
  const [view] = await views(c, [f])
  return json(200, { monitor: view, history: await history(c, (view as MonitorView).id), nowMs: c.opts.now() })
}

function newMonitorId(): string {
  return `mon_${[...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('')}`
}

async function receiverNames(c: Call): Promise<string[] | null> {
  const cfg = ok(await c.notifier().getConfig(c.tenant))
  return cfg.config === null ? null : cfg.receivers.map((r) => r.name)
}

/** The default group for an interval: the first `monitors/<interval>[/<n>]` with room, or the one that already holds the monitor. */
function pickGroup(found: { group: GroupSnapshot }[], interval: string, id: string): string {
  for (let n = 1; ; n++) {
    const name = defaultGroup(interval, n)
    const g = found.find((f) => f.group.name === name)?.group
    if (!g || g.rules.length < MONITOR_GROUP_CAP || g.rules.some((r) => r.rule.kind === 'alert' && r.rule.monitor?.id === id)) return name
  }
}

async function writeMonitor(c: Call, existing: Found | null): Promise<Response> {
  const body = await c.body()
  const dryRun = c.dryRun(body)
  const now = c.opts.now()
  if (existing && !existing.rule.monitor) {
    throw new ApiError(409, 'not_a_monitor', 'this rule was saved without monitor metadata; save its group through /api/v1/monitors/groups to edit it as a monitor')
  }
  const meta: MonitorMeta = existing?.rule.monitor
    ? { ...existing.rule.monitor, updatedAt: now, updatedBy: c.by }
    : { id: newMonitorId(), owner: '', startInvestigation: false, condition: null, createdAt: now, createdBy: c.by, updatedAt: now, updatedBy: c.by }
  const planned = planMonitor(body, meta, await receiverNames(c))
  if (!planned.ok) throw invalid(planned.errors)
  const { rule, interval } = planned.plan
  const viaCondition = rule.monitor?.condition !== null && rule.monitor?.condition !== undefined
  const groups = await c.groups()
  const sameInterval = existing !== null && parseDuration(interval) === existing.group.intervalMs
  const group = planned.plan.group ?? (sameInterval ? (existing as Found).group.name : pickGroup(groups, interval, meta.id))
  if (group === DEADMAN_GROUP) throw invalid([{ path: 'group', message: 'group names starting with "viz:" are reserved', fix: 'Choose another name.' }])
  const size = groups.find((g) => g.group.name === group)?.group.rules.length ?? 0
  const adds = existing !== null && existing.group.name === group ? 0 : 1
  const placement = await place(c, new Map([[group, size + adds]]), dryRun)
  const shard = placement.get(group) ?? 0
  const saved = ok(await c.ruler(shard).saveRule(c.tenant, { name: group, interval }, rule, dryRun))
  if (saved.status === 'invalid') throw invalid(monitorPaths(saved.errors, saved.ruleIndex ?? 0, viaCondition))
  if (existing && existing.group.name !== group && !dryRun) {
    // The monitor changed group (a new interval): its `for` timers start again there.
    ok(await c.ruler(existing.shard).removeRule(c.tenant, existing.group.name, meta.id))
  }
  const savedRule = saved.groups[0]?.rules[saved.ruleIndex ?? 0]
  return json(existing || dryRun ? 200 : 201, {
    dryRun,
    id: meta.id,
    group,
    shard: String(shard),
    cost: savedRule?.cost ?? null,
    expr: rule.expr,
    warnings: monitorPaths(saved.warnings, saved.ruleIndex ?? 0, viaCondition),
  })
}

async function deleteMonitor(c: Call): Promise<Response> {
  const f = await findMonitor(c)
  const dryRun = c.dryRun()
  const id = monitorIdOf(f.group.name, f.rule)
  const r = ok(await c.ruler(f.shard).removeRule(c.tenant, f.group.name, id, dryRun))
  if (r.status === 'invalid') throw invalid(r.errors)
  if (!dryRun) await forget(c, [id])
  return json(200, { dryRun, deleted: r.removed, id, firingAlertsResolved: f.snap.alerts.filter((a) => a.state === 'firing').length })
}

/** Delete the history of monitors that no longer exist. */
async function forget(c: Call, ids: string[]): Promise<void> {
  if (ids.length === 0) return
  const n = await c.shards()
  await mapLimit(Array.from({ length: n }, (_, i) => i), 4, async (i) => ok(await c.ruler(i).dropTimelines(c.tenant, ids)))
  ok(await c.notifier().dropLogs(c.tenant, ids))
}

/** The monitor's firing alerts, or the one named in the body. Pending alerts have not reached the notifier and cannot be acted on. */
async function targetAlerts(c: Call, body: unknown): Promise<{ id: string; fingerprints: string[] }> {
  const f = await findMonitor(c)
  const firing = f.snap.alerts.filter((a) => a.state === 'firing').map((a) => a.fingerprint)
  const one = (body as { fingerprint?: unknown } | null)?.fingerprint
  if (one !== undefined) {
    if (typeof one !== 'string' || !firing.includes(one)) throw new ApiError(404, 'not_found', 'the monitor has no firing alert with that fingerprint')
    return { id: monitorIdOf(f.group.name, f.rule), fingerprints: [one] }
  }
  return { id: monitorIdOf(f.group.name, f.rule), fingerprints: firing }
}

async function acknowledge(c: Call, on: boolean): Promise<Response> {
  const body = await c.body()
  const dryRun = c.dryRun(body)
  const t = await targetAlerts(c, body)
  const r = ok(on ? await c.notifier().acknowledge(c.tenant, t.fingerprints, c.by, dryRun) : await c.notifier().unacknowledge(c.tenant, t.fingerprints, c.by, dryRun))
  return json(200, { dryRun, id: t.id, [on ? 'acknowledged' : 'unacknowledged']: r.applied, notYetHandedOff: r.skipped, by: c.by, at: c.opts.now() })
}

async function silence(c: Call): Promise<Response> {
  const body = (await c.body()) as { duration?: unknown; comment?: unknown }
  const dryRun = c.dryRun(body)
  const ms = typeof body.duration === 'string' ? parseDuration(body.duration) : null
  if (ms === null) throw invalid([{ path: 'duration', message: 'duration is required', fix: 'Give how long to silence the alert, e.g. "15m", "1h" or "4h".' }])
  if (body.comment !== undefined && (typeof body.comment !== 'string' || body.comment.length > 4096)) throw invalid([{ path: 'comment', message: 'comment must be a string of at most 4096 characters', fix: 'Shorten it.' }])
  const t = await targetAlerts(c, body)
  const comment = typeof body.comment === 'string' && body.comment !== '' ? body.comment : `Silenced from monitor ${t.id}`
  const r = ok(await c.notifier().silenceAlerts(c.tenant, t.fingerprints, ms, c.by, comment, dryRun))
  if (r.status === 'invalid') throw invalid(r.errors)
  return json(200, {
    dryRun, id: t.id, silences: r.silences, silenced: r.applied, notYetHandedOff: r.skipped,
    // The token undoes exactly this call while the window is open. It is returned once, here.
    undoToken: r.undoToken === '' ? null : r.undoToken, undoUntil: r.undoToken === '' && !dryRun ? null : r.undoUntil,
  })
}

async function undoSilence(c: Call): Promise<Response> {
  const body = (await c.body()) as { undoToken?: unknown }
  const dryRun = c.dryRun(body)
  if (typeof body.undoToken !== 'string' || body.undoToken === '') throw invalid([{ path: 'undoToken', message: 'undoToken is required', fix: 'Send the token the silence call returned.' }])
  const r = ok(await c.notifier().undoSilence(c.tenant, body.undoToken, c.by, dryRun))
  if (r.status === 'not_found') throw notFound('undo token')
  if (r.status === 'expired') throw new ApiError(410, 'undo_expired', `the undo window closed at ${rfc3339(r.undoUntil)}; expire the silence instead`)
  return json(200, { dryRun, removed: r.removed })
}

async function listSilences(c: Call): Promise<Response> {
  return json(200, { silences: ok(await c.notifier().listSilences(c.tenant)).silences, nowMs: c.opts.now() })
}

async function expireSilence(c: Call): Promise<Response> {
  const dryRun = c.dryRun()
  const r = ok(await c.notifier().expireSilence(c.tenant, c.params.silenceId as string, c.by, dryRun))
  if (r.status === 'not_found') throw notFound('silence')
  return json(200, { dryRun, expired: c.params.silenceId })
}

// ───────────────────────────── groups and rule files ─────────────────────────────

async function fullSpecs(c: Call): Promise<{ spec: RuleGroup; shard: string }[]> {
  const n = await c.shards()
  const lists = await mapLimit(Array.from({ length: n }, (_, i) => i), 4, async (i) => ok(await c.ruler(i).listGroups(c.tenant)).groups.map((spec: RuleGroup) => ({ spec, shard: String(i) })))
  const seen = new Map<string, { spec: RuleGroup; shard: string }>()
  for (const g of lists.flat()) {
    if (g.spec.name === DEADMAN_GROUP) continue
    if (!seen.has(g.spec.name) || String(shardOf(g.spec.name, n)) === g.shard) seen.set(g.spec.name, g)
  }
  return [...seen.values()].sort((a, b) => (a.spec.name < b.spec.name ? -1 : 1))
}

async function listGroups(c: Call): Promise<Response> {
  const all = await fullSpecs(c)
  const doc = ruleFileDocument(all.map((g) => g.spec), { extensions: true }).file
  return json(200, { groups: doc.groups.map((g, i) => ({ ...g, shard: (all[i] as { shard: string }).shard })) })
}

async function existingMonitors(c: Call): Promise<Map<string, AlertingRuleV2>> {
  const out = new Map<string, AlertingRuleV2>()
  for (const f of alertingRules(await c.groups())) if (f.rule.monitor) out.set(f.rule.monitor.id, f.rule)
  return out
}

async function putGroup(c: Call): Promise<Response> {
  const body = (await c.body()) as Record<string, unknown>
  const dryRun = c.dryRun(body)
  const { dryRun: _d, ...group } = body
  const name = c.params.name as string
  if (group.name !== undefined && group.name !== name) throw invalid([{ path: 'name', message: 'the group name in the body differs from the one in the path', fix: 'Remove "name" from the body, or make the two agree.' }])
  const file = { groups: [{ ...group, name }] }
  adoptMonitors(file, await existingMonitors(c), c.by, c.opts.now())
  return json(200, await saveDocument(c, file, dryRun))
}

async function deleteGroup(c: Call): Promise<Response> {
  const name = c.params.name as string
  const dryRun = c.dryRun()
  if (name === DEADMAN_GROUP) throw new ApiError(409, 'reserved', 'the built-in watchdog group cannot be deleted; turn it off in the ruler config')
  const held = (await c.groups()).filter((g) => g.group.name === name)
  if (held.length === 0) throw notFound(`group ${name}`)
  const ids = held.flatMap((g) => g.group.rules.flatMap((r) => (r.rule.kind === 'alert' && r.rule.monitor ? [r.rule.monitor.id] : [])))
  if (!dryRun) {
    for (const g of (await c.locations()).filter((x) => x.name === name)) ok(await c.ruler(g.shard).deleteGroup(c.tenant, name))
    await forget(c, ids)
  }
  return json(200, { dryRun, deleted: name, monitors: ids.length })
}

async function importFile(c: Call): Promise<Response> {
  const type = (c.req.headers.get('content-type') ?? '').toLowerCase()
  let file: unknown
  let dryRun = c.dryRun()
  if (type.includes('json')) {
    const body = (await c.body()) as Record<string, unknown>
    dryRun = c.dryRun(body)
    const { dryRun: _d, ...rest } = body
    file = rest
  } else {
    const parsed = importRuleFile(await c.text())
    if (!parsed.ok) throw invalid(parsed.errors)
    file = parsed.file
  }
  adoptMonitors(file, await existingMonitors(c), c.by, c.opts.now())
  return json(200, await saveDocument(c, file, dryRun))
}

async function exportFile(c: Call): Promise<Response> {
  const ext = c.url.searchParams.get('extensions')
  const out = exportRuleFile((await fullSpecs(c)).map((g) => g.spec), { extensions: ext === null ? true : ext === 'true' || ext === '1' })
  const note = out.dropped.length > 0 ? `# Left out because Prometheus has no such field (${out.dropped.length}):\n${out.dropped.map((d) => `#   ${d}`).join('\n')}\n` : ''
  return new Response(note + out.yaml, { status: 200, headers: { 'content-type': 'application/yaml; charset=utf-8', 'x-viz-dropped-fields': String(out.dropped.length) } })
}

async function backtest(c: Call): Promise<Response> {
  const body = (await c.body()) as { monitor?: unknown; rule?: unknown; fromMs?: unknown; toMs?: unknown; step?: unknown; interval?: unknown }
  let rule = body.rule
  let interval = typeof body.interval === 'string' ? body.interval : undefined
  if (body.monitor !== undefined) {
    const planned = planMonitor(body.monitor, { id: 'mon_0000000000000000', owner: '', startInvestigation: false, condition: null, createdAt: 0, createdBy: c.by, updatedAt: 0, updatedBy: c.by }, await receiverNames(c))
    if (!planned.ok) throw invalid(planned.errors.map((e) => ({ ...e, path: `monitor.${e.path}` })))
    rule = planned.plan.rule
    interval ??= planned.plan.interval
  } else if (rule === undefined) {
    throw invalid([{ path: 'monitor', message: 'give "monitor" (a monitor document) or "rule" (an alerting rule)', fix: 'Send the monitor you are about to save.' }])
  }
  const stepMs = typeof body.step === 'string' ? parseDuration(body.step) : null
  const intervalMs = interval === undefined ? undefined : (parseDuration(interval) ?? undefined)
  if (stepMs === null) throw invalid([{ path: 'step', message: 'step is required', fix: 'Give the resolution as a duration, e.g. "1m"; the monitor\'s interval is the most faithful choice.' }])
  const r = ok(await c.ruler(0).backtest(c.tenant, rule, body.fromMs as number, body.toMs as number, stepMs, intervalMs))
  if (r.status === 'invalid') throw invalid(r.errors)
  if (r.status === 'failed') throw new ApiError(502, 'evaluation_failed', r.error)
  const { status: _s, ...result } = r
  return json(200, result)
}

async function getNotifier(c: Call): Promise<Response> {
  const r = ok(await c.notifier().getConfig(c.tenant))
  return json(200, { config: r.config, receivers: r.receivers })
}

async function putNotifier(c: Call): Promise<Response> {
  const body = (await c.body()) as Record<string, unknown>
  const dryRun = c.dryRun(body)
  const { dryRun: _d, ...config } = body
  if (dryRun) {
    // Validation only: compile it the way the notifier would, without the stored secrets.
    const { compileConfig } = await import('./amconfig')
    const compiled = compileConfig(config)
    if (!compiled.ok) throw invalid(compiled.errors)
    return json(200, { dryRun: true, receivers: [...compiled.config.receivers.keys()] })
  }
  const r = ok(await c.notifier().setConfig(c.tenant, config))
  if (r.status === 'invalid') throw invalid(r.errors)
  const now = ok(await c.notifier().getConfig(c.tenant))
  return json(200, { dryRun: false, receivers: now.receivers })
}

// ───────────────────────────── Prometheus-compatible, read-only ─────────────────────────────

/** Go's `strconv.FormatFloat(v, 'e', -1, 64)`, which is how Prometheus prints an alert's value. */
export function promFloat(v: number): string {
  if (Number.isNaN(v)) return 'NaN'
  if (v === Infinity) return '+Inf'
  if (v === -Infinity) return '-Inf'
  return v.toExponential().replace(/e([+-])(\d)$/, 'e$10$2')
}

const promTime = (ms: number | null): string => (ms === null ? ZERO_TIME : rfc3339(ms))

class PromError extends Error {
  constructor(
    readonly status: number,
    readonly errorType: string,
    message: string,
  ) {
    super(message)
  }
}

function promAlerts(snap: RuleSnapshot): Record<string, unknown>[] {
  return snap.alerts
    .filter((a) => a.state !== 'inactive')
    .map((a) => {
      const out: Record<string, unknown> = { labels: a.labels, annotations: a.annotations, state: a.state, activeAt: rfc3339(a.activeAt) }
      if (a.keepFiringSince !== null) out.keepFiringSince = rfc3339(a.keepFiringSince)
      out.value = promFloat(a.value)
      return out
    })
}

const fileOf = (shard: string): string => `shard-${shard}`

async function promRules(c: Call): Promise<Response> {
  const q = c.url.searchParams
  const type = (q.get('type') ?? '').toLowerCase()
  if (type !== '' && type !== 'alert' && type !== 'record') throw new PromError(400, 'bad_data', `invalid parameter "type": not supported value "${type}"`)
  const flag = (q.get('exclude_alerts') ?? '').toLowerCase()
  if (!['', 'true', 'false', '1', '0', 't', 'f'].includes(flag)) throw new PromError(400, 'bad_data', 'invalid parameter "exclude_alerts": not a boolean')
  const excludeAlerts = ['true', '1', 't'].includes(flag)
  if (q.getAll('match[]').length > 0) throw new PromError(400, 'bad_data', 'invalid parameter "match[]": label selectors on rules are not supported by viz; filter with rule_name[] or rule_group[]')
  const names = new Set(q.getAll('rule_name[]'))
  const groupNames = new Set(q.getAll('rule_group[]'))
  const files = new Set(q.getAll('file[]'))
  const limitText = q.get('group_limit')
  const nextToken = q.get('group_next_token') ?? ''
  let maxGroups = 0
  if (limitText !== null && limitText !== '') {
    maxGroups = Number(limitText)
    if (!Number.isInteger(maxGroups) || maxGroups <= 0) throw new PromError(400, 'bad_data', 'invalid parameter "group_limit": must be a positive integer')
  }
  if (nextToken !== '' && maxGroups === 0) throw new PromError(400, 'bad_data', 'invalid parameter "group_limit": must be set when group_next_token is given')
  const token = (file: string, name: string) => [...new TextEncoder().encode(`${file};${name}`)].map((b) => b.toString(16).padStart(2, '0')).join('')

  const out: Record<string, unknown>[] = []
  let groupNextToken: string | undefined
  let found = nextToken === ''
  for (const { shard, group } of await c.groups()) {
    const file = fileOf(shard)
    if (!found) {
      if (token(file, group.name) !== nextToken) continue
      found = true
    }
    if (groupNames.size > 0 && !groupNames.has(group.name)) continue
    if (files.size > 0 && !files.has(file)) continue
    const rules: Record<string, unknown>[] = []
    for (const snap of group.rules) {
      const r = snap.rule
      if (names.size > 0 && !names.has(r.name)) continue
      const tail: Record<string, unknown> = { health: snap.health }
      if (snap.lastError !== null && snap.lastError !== '') tail.lastError = snap.lastError
      tail.evaluationTime = (snap.lastDurationMs ?? 0) / 1000
      tail.lastEvaluation = promTime(snap.lastEvaluationMs)
      if (r.kind === 'alert') {
        if (type === 'record') continue
        const states = snap.alerts.map((a) => a.state)
        rules.push({
          state: states.includes('firing') ? 'firing' : states.includes('pending') ? 'pending' : 'inactive',
          name: r.name,
          query: r.expr,
          duration: r.forMs / 1000,
          keepFiringFor: r.keepFiringForMs / 1000,
          labels: r.labels,
          annotations: r.annotations,
          alerts: excludeAlerts ? null : promAlerts(snap),
          ...tail,
          type: 'alerting',
        })
      } else {
        if (type === 'alert') continue
        rules.push({ name: r.name, query: r.expr, labels: r.labels, ...tail, type: 'recording' })
      }
    }
    // "If the rule group response has no rules, skip it": every rule was filtered out.
    if (rules.length === 0) continue
    if (maxGroups > 0 && out.length === maxGroups) {
      groupNextToken = token(file, group.name)
      break
    }
    out.push({ name: group.name, file, rules, interval: group.intervalMs / 1000, limit: group.limit, evaluationTime: (group.lastDurationMs ?? 0) / 1000, lastEvaluation: promTime(group.lastEvaluationMs) })
  }
  if (!found) throw new PromError(400, 'bad_data', `invalid parameter "group_next_token": invalid group_next_token '${nextToken}'. were rule groups changed?`)
  const data: Record<string, unknown> = { groups: out }
  if (groupNextToken !== undefined) data.groupNextToken = groupNextToken
  return json(200, { status: 'success', data })
}

async function promAlertsRoute(c: Call): Promise<Response> {
  const alerts: Record<string, unknown>[] = []
  for (const { group } of await c.groups()) for (const snap of group.rules) if (snap.rule.kind === 'alert') alerts.push(...promAlerts(snap))
  return json(200, { status: 'success', data: { alerts } })
}

// ───────────────────────────── routing ─────────────────────────────

export interface RouteDef {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  /** OpenAPI path template. */
  path: string
  scope: Scope
  /** Writes accept `dryRun` (query parameter or body field). */
  dryRun: boolean
  /** Answers in Prometheus' envelope, errors included. */
  prometheus: boolean
  handler: (c: Call) => Promise<Response>
}

const route = (method: RouteDef['method'], path: string, scope: Scope, handler: RouteDef['handler'], dryRun = false, prometheus = false): RouteDef => ({ method, path, scope, dryRun, prometheus, handler })

/** Literal paths come before the `{id}` paths they would otherwise be swallowed by. */
export const ROUTES: RouteDef[] = [
  route('GET', '/api/v1/rules', 'monitors:read', promRules, false, true),
  route('GET', '/api/v1/alerts', 'monitors:read', promAlertsRoute, false, true),
  route('GET', '/api/v1/monitors', 'monitors:read', listMonitors),
  route('POST', '/api/v1/monitors', 'monitors:write', (c) => writeMonitor(c, null), true),
  route('GET', '/api/v1/monitors/groups', 'monitors:read', listGroups),
  route('PUT', '/api/v1/monitors/groups/{name}', 'monitors:write', putGroup, true),
  route('DELETE', '/api/v1/monitors/groups/{name}', 'monitors:write', deleteGroup, true),
  route('GET', '/api/v1/monitors/rulefile', 'monitors:read', exportFile),
  route('POST', '/api/v1/monitors/rulefile', 'monitors:write', importFile, true),
  route('POST', '/api/v1/monitors/backtest', 'monitors:read', backtest),
  route('GET', '/api/v1/monitors/notifier', 'monitors:read', getNotifier),
  route('PUT', '/api/v1/monitors/notifier', 'monitors:write', putNotifier, true),
  route('GET', '/api/v1/monitors/silences', 'monitors:read', listSilences),
  route('POST', '/api/v1/monitors/silences/undo', 'monitors:ack', undoSilence, true),
  route('DELETE', '/api/v1/monitors/silences/{silenceId}', 'monitors:ack', expireSilence, true),
  route('GET', '/api/v1/monitors/{id}', 'monitors:read', getMonitor),
  route('PUT', '/api/v1/monitors/{id}', 'monitors:write', async (c) => writeMonitor(c, await findMonitor(c)), true),
  route('DELETE', '/api/v1/monitors/{id}', 'monitors:write', deleteMonitor, true),
  route('POST', '/api/v1/monitors/{id}/acknowledge', 'monitors:ack', (c) => acknowledge(c, true), true),
  route('POST', '/api/v1/monitors/{id}/unacknowledge', 'monitors:ack', (c) => acknowledge(c, false), true),
  route('POST', '/api/v1/monitors/{id}/silence', 'monitors:ack', silence, true),
]

const RESERVED = new Set(['groups', 'rulefile', 'backtest', 'notifier', 'silences'])
const ID_RE = /^(mon|r)_[0-9a-f]{16}$/

function match(def: RouteDef, segments: string[]): Record<string, string> | null {
  const want = def.path.split('/').slice(1)
  if (want.length !== segments.length) return null
  const params: Record<string, string> = {}
  for (let i = 0; i < want.length; i++) {
    const w = want[i] as string
    const s = segments[i] as string
    if (w.startsWith('{')) {
      let value: string
      try {
        value = decodeURIComponent(s)
      } catch {
        return null
      }
      if (value === '') return null
      const name = w.slice(1, -1)
      if (name === 'id' && (RESERVED.has(value) || !ID_RE.test(value))) return null
      params[name] = value
    } else if (w !== s) return null
  }
  return params
}

function errorResponse(e: unknown, prometheus: boolean): Response {
  if (e instanceof PromError) return json(e.status, { status: 'error', errorType: e.errorType, error: e.message })
  let status = 500
  let code = 'internal'
  let message = 'internal error'
  let headers: Record<string, string> = {}
  let problems: ValidationError[] | undefined
  if (e instanceof HttpError) {
    status = e.status
    code = e.status === 401 ? 'unauthorized' : e.status === 403 ? 'forbidden' : 'bad_request'
    message = e.message
    headers = e.headers
  } else if (e instanceof ApiError) {
    ;({ status, code, message, problems } = e)
  }
  if (prometheus) {
    const errorType = status === 400 || status === 422 ? 'bad_data' : status === 404 ? 'not_found' : status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : 'internal'
    return json(status, { status: 'error', errorType, error: message }, headers)
  }
  return json(status, problems ? { error: { code, message }, problems } : { error: { code, message } }, headers)
}

export function createApi(options: ApiOptions = {}) {
  const opts: Required<ApiOptions> = { placement: options.placement ?? DEFAULT_PLACEMENT, now: options.now ?? (() => Date.now()) }
  return {
    async fetch(req: Request, env: ApiEnv): Promise<Response> {
      const url = new URL(req.url)
      const segments = url.pathname.split('/').slice(1)
      const prometheus = url.pathname === '/api/v1/rules' || url.pathname === '/api/v1/alerts'
      let def: RouteDef | undefined
      let params: Record<string, string> = {}
      let pathKnown = false
      for (const d of ROUTES) {
        const p = match(d, segments)
        if (!p) continue
        pathKnown = true
        if (d.method === req.method) {
          def = d
          params = p
          break
        }
      }
      try {
        if (!def) {
          if (pathKnown) throw new ApiError(405, 'method_not_allowed', `${req.method} is not supported on this path`)
          throw new ApiError(404, 'not_found', 'no such route')
        }
        // Who is asking, and for whom: both come from the key record.
        const principal = await authenticate(req, env.CONFIG, def.scope as never)
        const call = new Call(req, env, principal.tenant, `key:${principal.keyId}`, params, opts)
        return await def.handler(call)
      } catch (e) {
        return errorResponse(e, def?.prometheus ?? prometheus)
      }
    },
  }
}
