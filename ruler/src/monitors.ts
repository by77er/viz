/**
 * Monitors: the mapping between what the Monitor screens show and what the ruler and the
 * notifier hold. Pure: no storage, no I/O.
 *
 * A monitor IS one alerting rule. Its message, description and runbook are the rule's
 * `summary`, `description` and `runbook_url` annotations (so an imported Prometheus rule
 * file already has them); its receiver is the `viz_receiver` label; the rest (id, owner,
 * the threshold as the author wrote it, who changed it) is the rule's `monitor` block.
 */
import {
  RECEIVER_LABEL,
  type Acknowledgement,
  type AlertingRuleInputV2,
  type AlertingRuleV2,
  type AlertNotifyState,
  type ConditionOp,
  type DescribeResult,
  type GroupSnapshot,
  type MonitorAlertView,
  type MonitorInput,
  type MonitorMeta,
  type MonitorState,
  type MonitorView,
  type NoDataMode,
  type RuleSnapshot,
  type Timeline,
  type TimelineEntry,
  type ValidationError,
} from '../contracts-proposal/rules.v2'
import { bareRuleId } from './ruler'
import { DEADMAN_GROUP, ruleKey } from './rules'
import { isNoDataAlert } from './statemachine'
import { formatDuration, hash64, labelsKey, parseDuration } from './util'

const OPS: ConditionOp[] = ['>', '>=', '<', '<=', '==', '!=']
const MODES: NoDataMode[] = ['ok', 'alerting', 'keep']
const FIELDS = ['name', 'expr', 'query', 'condition', 'for', 'keepFiringFor', 'interval', 'group', 'description', 'message', 'runbookUrl', 'owner', 'notify', 'noData', 'noDataFor', 'startInvestigation', 'labels', 'annotations', 'dryRun']

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export const DEFAULT_MONITOR_INTERVAL = '1m'
/** Monitors with the same interval share a group (one batch per tick) until it holds this many. */
export const MONITOR_GROUP_CAP = 500

export function defaultGroup(interval: string, n: number): string {
  const ms = parseDuration(interval)
  const base = `monitors/${ms === null ? interval : formatDuration(ms)}`
  return n <= 1 ? base : `${base}/${n}`
}

/** A stable id for a rule that arrives without one (a rule file): the same rule gets the same id at every import. */
export function derivedMonitorId(group: string, name: string, labels: Record<string, string>): string {
  return `mon_${hash64(`viz-monitor\n${group}\n${name}\n${labelsKey(labels)}`)}`
}

export interface MonitorPlan {
  rule: AlertingRuleInputV2
  /** Null: the caller picks the default group for `interval`. */
  group: string | null
  interval: string
}

/**
 * Check a monitor document and turn it into the alerting rule that implements it.
 * Problems are addressed by the monitor's own field names.
 */
export function planMonitor(input: unknown, meta: MonitorMeta, receivers: string[] | null): { ok: true; plan: MonitorPlan } | { ok: false; errors: ValidationError[] } {
  const errors: ValidationError[] = []
  const err = (path: string, message: string, fix: string) => void errors.push({ path, message, fix })
  if (!isObject(input)) return { ok: false, errors: [{ path: '', message: 'a monitor is an object', fix: 'Send { "name": ..., "query": ..., "condition": { "op": ">", "threshold": 0.5 } }.' }] }
  const m = input as MonitorInput & Record<string, unknown>
  for (const k of Object.keys(m)) if (!FIELDS.includes(k)) err(k, `unknown field "${k}"`, `A monitor has: ${FIELDS.filter((f) => f !== 'dryRun').join(', ')}.`)
  const str = (k: string, max: number, required = false): string | undefined => {
    const v = m[k]
    if (v === undefined || v === null) {
      if (required) err(k, `${k} is required`, `Give the monitor a ${k}.`)
      return undefined
    }
    if (typeof v !== 'string' || v.length > max || (required && v.trim() === '')) {
      err(k, `${k} must be ${required ? 'a non-empty' : 'a'} string of at most ${max} characters`, required ? `Give the monitor a ${k}.` : 'Shorten it.')
      return undefined
    }
    return v
  }
  const name = str('name', 256, true)
  const exprText = str('expr', 16_384)
  const query = str('query', 16_000)
  let condition: MonitorMeta['condition'] = null
  if (exprText !== undefined && (query !== undefined || m.condition !== undefined)) err('expr', 'give either "expr", or "query" with "condition", not both', 'Remove one of them.')
  else if (exprText === undefined && query === undefined) err('query', 'a monitor needs "query" with "condition", or "expr"', 'Give the query from Explore and the threshold to compare it with.')
  else if (query !== undefined) {
    const c = m.condition
    if (!isObject(c)) err('condition', 'a monitor written as a query needs a condition', 'Add { "op": ">", "threshold": 0.5 }.')
    else {
      if (typeof c.op !== 'string' || !OPS.includes(c.op as ConditionOp)) err('condition.op', `op must be one of ${OPS.join(' ')}`, 'Use ">" for "above" and "<" for "below".')
      if (typeof c.threshold !== 'number' || !Number.isFinite(c.threshold)) err('condition.threshold', 'threshold must be a number', 'Give the threshold in the unit the query returns: a ratio of 1% is 0.01.')
      if (c.unit !== undefined && (typeof c.unit !== 'string' || c.unit.length > 32)) err('condition.unit', 'unit must be a string of at most 32 characters', 'Use e.g. "ms" or "%".')
      for (const k of Object.keys(c)) if (!['op', 'threshold', 'unit'].includes(k)) err(`condition.${k}`, `unknown field "${k}"`, 'A condition has: op, threshold, unit.')
      if (errors.length === 0) condition = { query, op: c.op as ConditionOp, threshold: c.threshold as number, unit: typeof c.unit === 'string' ? c.unit : '' }
    }
  }
  const noData = m.noData === undefined ? 'ok' : m.noData
  if (typeof noData !== 'string' || !MODES.includes(noData as NoDataMode)) err('noData', `noData must be one of ${MODES.join(', ')}`, 'Use "ok" (resolve), "alerting" (fire after noDataFor) or "keep" (keep the last state).')
  const notify = str('notify', 256)
  if (notify !== undefined) {
    if (receivers === null) err('notify', 'no notifier config is set, so there is nobody to notify', 'Save the notifier config (receivers and routes) first, or leave "notify" out.')
    else if (!receivers.includes(notify)) err('notify', `receiver "${notify}" is not defined`, receivers.length > 0 ? `Use one of: ${receivers.join(', ')}.` : 'Add a receiver to the notifier config.')
  }
  const runbookUrl = str('runbookUrl', 2048)
  if (runbookUrl !== undefined && runbookUrl !== '' && !/^https?:\/\/\S+$/.test(runbookUrl)) err('runbookUrl', 'runbookUrl must be an http(s) URL', 'Give the full link to the runbook.')
  if (m.startInvestigation !== undefined && typeof m.startInvestigation !== 'boolean') err('startInvestigation', 'startInvestigation must be true or false', 'Use a boolean.')
  const map = (k: 'labels' | 'annotations'): Record<string, string> => {
    const v = m[k]
    if (v === undefined || v === null) return {}
    if (!isObject(v)) {
      err(k, `${k} must be a map of strings`, 'Write key: value pairs.')
      return {}
    }
    return v as Record<string, string>
  }
  const labels = { ...map('labels') }
  const annotations = { ...map('annotations') }
  if (RECEIVER_LABEL in labels) err(`labels.${RECEIVER_LABEL}`, `${RECEIVER_LABEL} is set from "notify"`, 'Remove the label and use "notify".')
  const interval = str('interval', 32) ?? DEFAULT_MONITOR_INTERVAL
  const group = str('group', 256) ?? null
  const owner = str('owner', 256) ?? ''
  const description = str('description', 4096)
  const message = str('message', 4096)
  const forText = str('for', 32)
  const keep = str('keepFiringFor', 32)
  const noDataFor = str('noDataFor', 32)
  if (errors.length > 0 || name === undefined) return { ok: false, errors }

  if (notify !== undefined) labels[RECEIVER_LABEL] = notify
  if (message !== undefined && message !== '') annotations.summary = message
  if (description !== undefined && description !== '') annotations.description = description
  if (runbookUrl !== undefined && runbookUrl !== '') annotations.runbook_url = runbookUrl
  const rule: AlertingRuleInputV2 = {
    alert: name,
    expr: condition ? `(${condition.query}) ${condition.op} ${condition.threshold}` : (exprText as string),
  }
  if (forText !== undefined) rule.for = forText
  if (keep !== undefined) rule.keep_firing_for = keep
  if (Object.keys(labels).length > 0) rule.labels = labels
  if (Object.keys(annotations).length > 0) rule.annotations = annotations
  if (noData !== 'ok') {
    rule.no_data = noData as NoDataMode
    if (noData === 'alerting') rule.no_data_for = noDataFor ?? '0s'
    // The comparison is empty whenever the system is healthy; only the bare query tells "no data" apart.
    if (condition) rule.no_data_expr = condition.query
  }
  rule.monitor = { ...meta, owner, startInvestigation: m.startInvestigation === true, condition }
  return { ok: true, plan: { rule, group, interval } }
}

const RULE_PATHS: [RegExp, (m: RegExpExecArray, viaCondition: boolean) => string][] = [
  [/^expr$/, (_m, c) => (c ? 'query' : 'expr')],
  [/^no_data_expr$/, () => 'query'],
  [/^alert$/, () => 'name'],
  [/^for$/, () => 'for'],
  [/^keep_firing_for$/, () => 'keepFiringFor'],
  [/^no_data_for$/, () => 'noDataFor'],
  [/^no_data$/, () => 'noData'],
  [/^annotations\.summary$/, () => 'message'],
  [/^annotations\.description$/, () => 'description'],
  [/^annotations\.runbook_url$/, () => 'runbookUrl'],
  [new RegExp(`^labels\\.${RECEIVER_LABEL}$`), () => 'notify'],
]

/** Rewrite the ruler's rule-file paths (`groups[0].rules[3].for`) into the monitor's field names. */
export function monitorPaths(errors: ValidationError[], ruleIndex: number, viaCondition: boolean): ValidationError[] {
  const prefix = `groups[0].rules[${ruleIndex}]`
  return errors.map((e) => {
    if (e.path === 'groups[0].interval') return { ...e, path: 'interval' }
    if (e.path === 'groups[0].name') return { ...e, path: 'group' }
    if (!e.path.startsWith(prefix)) return e
    const rest = e.path.slice(prefix.length).replace(/^\./, '')
    for (const [re, to] of RULE_PATHS) {
      const m = re.exec(rest)
      if (m) return { ...e, path: to(m, viaCondition) }
    }
    return { ...e, path: rest }
  })
}

// ───────────────────────────── views ─────────────────────────────

export function monitorIdOf(group: string, rule: AlertingRuleV2): string {
  return rule.monitor?.id ?? bareRuleId(group, rule.key)
}

export function thresholdText(rule: AlertingRuleV2): string | null {
  const c = rule.monitor?.condition
  if (!c) return null
  return `${c.op} ${c.threshold}${c.unit ? ` ${c.unit}` : ''}${rule.forMs > 0 ? ` for ${formatDuration(rule.forMs)}` : ''}`
}

/** The static part of a rule's alert labels: where its alerts are routed when their templates add nothing. */
export function routingLabels(rule: AlertingRuleV2, externalLabels: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = { ...externalLabels }
  for (const [k, v] of Object.entries(rule.labels)) if (!v.includes('{{') && v !== '') out[k] = v
  out.alertname = rule.name
  return out
}

function monitorState(snap: RuleSnapshot, alerts: MonitorAlertView[]): MonitorState {
  if (alerts.some((a) => a.state === 'firing' && !a.noData)) return 'firing'
  if (snap.noData || alerts.some((a) => a.noData)) return 'no_data'
  if (snap.health === 'err') return 'error'
  if (alerts.length > 0) return 'pending'
  if (snap.health === 'unknown') return 'unknown'
  return 'ok'
}

export function monitorView(group: GroupSnapshot, shard: string, snap: RuleSnapshot, notify: DescribeResult | undefined): MonitorView {
  const rule = snap.rule as AlertingRuleV2
  const states = new Map<string, AlertNotifyState>((notify?.alerts ?? []).map((a) => [a.fingerprint, a]))
  const alerts: MonitorAlertView[] = snap.alerts
    .filter((a) => a.state !== 'inactive')
    .map((a) => {
      const n = states.get(a.fingerprint)
      const noData = isNoDataAlert(a)
      const hold = noData ? (rule.noData?.forMs ?? 0) : rule.forMs
      return {
        fingerprint: a.fingerprint,
        labels: a.labels,
        state: a.state as 'pending' | 'firing',
        activeAt: a.activeAt,
        firingSince: a.state === 'firing' ? a.firedAt : null,
        firesAt: a.state === 'pending' ? a.activeAt + hold : null,
        value: a.value,
        noData,
        acknowledged: n?.acknowledged ?? null,
        silencedUntil: n?.silencedUntil ?? null,
        inhibited: n?.inhibited ?? false,
        lastNotifiedAt: n?.lastNotifiedAt ?? null,
        nextRepeatAt: n?.nextRepeatAt ?? null,
        handedOff: n?.known ?? false,
      }
    })
    .sort((a, b) => a.activeAt - b.activeAt || (a.fingerprint < b.fingerprint ? -1 : 1))
  const firing = alerts.filter((a) => a.state === 'firing')
  const acks = firing.map((a) => a.acknowledged)
  const allAcked = firing.length > 0 && acks.every((a) => a !== null)
  const silences = alerts.map((a) => a.silencedUntil)
  const allSilenced = alerts.length > 0 && silences.every((s) => s !== null)
  const min = (xs: number[]): number | null => (xs.length > 0 ? Math.min(...xs) : null)
  const c = rule.monitor?.condition ?? null
  return {
    id: monitorIdOf(group.name, rule),
    name: rule.name,
    group: group.name,
    shard,
    state: monitorState(snap, alerts),
    firingSince: min(firing.map((a) => a.firingSince as number)),
    activeAt: min(alerts.map((a) => a.activeAt)),
    value: alerts[0]?.value ?? null,
    thresholdText: thresholdText(rule),
    expr: rule.expr,
    query: c?.query ?? null,
    condition: c ? { op: c.op, threshold: c.threshold, unit: c.unit } : null,
    forMs: rule.forMs,
    keepFiringForMs: rule.keepFiringForMs,
    intervalMs: group.intervalMs,
    description: rule.annotations.description ?? '',
    message: rule.annotations.summary ?? '',
    runbookUrl: rule.annotations.runbook_url ?? '',
    owner: rule.monitor?.owner ?? '',
    notify: rule.labels[RECEIVER_LABEL] ?? null,
    notifies: notify?.receivers ?? [],
    noData: rule.noData?.mode ?? 'ok',
    noDataForMs: rule.noData?.forMs ?? 0,
    startInvestigation: rule.monitor?.startInvestigation ?? false,
    labels: rule.labels,
    annotations: rule.annotations,
    cost: rule.cost,
    health: snap.health,
    lastError: snap.lastError,
    lastEvaluationMs: snap.lastEvaluationMs,
    acknowledged: allAcked ? (acks as Acknowledgement[]).reduce((a, b) => (a.at <= b.at ? a : b)) : null,
    silencedUntil: allSilenced ? Math.min(...(silences as number[])) : null,
    alerts,
    historyRecorded: rule.monitor !== undefined,
  }
}

const ORDER: Record<string, number> = { ruler: 0, notifier: 1 }

/** One history from the ruler's transition logs (one per shard that ever held the monitor) and the notifier's log. */
export function mergeTimelines(parts: Timeline[]): Timeline {
  const entries: TimelineEntry[] = []
  const seen = new Set<string>()
  let dropped = 0
  for (const p of parts) {
    dropped += p.dropped
    for (const e of p.entries) {
      const key = JSON.stringify(e)
      if (seen.has(key)) continue
      seen.add(key)
      entries.push(e)
    }
  }
  entries.sort((a, b) => a.at - b.at || (ORDER[a.source] as number) - (ORDER[b.source] as number))
  return { entries, dropped }
}

/**
 * Give every alerting rule of a rule-file document a monitor block, so that rules saved
 * through the API have a history. A rule that already exists keeps who created it; it is
 * marked as edited only if something that changes its behaviour or text changed.
 */
export function adoptMonitors(file: unknown, existing: Map<string, AlertingRuleV2>, by: string, now: number): void {
  const groups = isObject(file) && Array.isArray(file.groups) ? file.groups : []
  for (const g of groups) {
    if (!isObject(g) || typeof g.name !== 'string' || !Array.isArray(g.rules) || g.name === DEADMAN_GROUP) continue
    const groupLabels = isObject(g.labels) ? (g.labels as Record<string, string>) : {}
    for (const r of g.rules) {
      if (!isObject(r) || typeof r.alert !== 'string' || typeof r.expr !== 'string') continue
      const labels = { ...groupLabels, ...(isObject(r.labels) ? (r.labels as Record<string, string>) : {}) }
      if (Object.values(labels).some((v) => typeof v !== 'string')) continue
      const given = isObject(r.monitor) ? (r.monitor as Partial<MonitorMeta>) : null
      const id = typeof given?.id === 'string' ? given.id : derivedMonitorId(g.name, r.alert, labels)
      const old = existing.get(id)
      const same =
        old !== undefined &&
        old.key === ruleKey('alert', r.alert, r.expr, labels) &&
        old.forMs === (typeof r.for === 'string' ? (parseDuration(r.for) ?? -1) : 0) &&
        JSON.stringify(old.annotations) === JSON.stringify(isObject(r.annotations) ? r.annotations : {})
      r.monitor = {
        id,
        owner: given?.owner ?? old?.monitor?.owner ?? '',
        startInvestigation: given?.startInvestigation ?? old?.monitor?.startInvestigation ?? false,
        condition: given?.condition ?? old?.monitor?.condition ?? null,
        createdAt: old?.monitor?.createdAt ?? given?.createdAt ?? now,
        createdBy: old?.monitor?.createdBy ?? given?.createdBy ?? by,
        updatedAt: same ? (old.monitor?.updatedAt ?? now) : now,
        updatedBy: same ? (old.monitor?.updatedBy ?? by) : by,
      }
    }
  }
}
