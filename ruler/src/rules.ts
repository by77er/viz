/**
 * Validation of the Prometheus rule-file shape (as JSON) into normalized rule groups.
 * Every problem is reported with the path of the offending field and what to change;
 * nothing is saved unless the whole document is valid.
 */
import {
  ANOMALY_ANNOTATION,
  ANOMALY_DETAIL_ANNOTATION,
  NO_DATA_LABEL,
  SLO_ANNOTATION,
  SLO_DETAIL_ANNOTATION,
  type AlertingRuleV2 as AlertingRule,
  type AnomalyRuleV2,
  type MonitorMeta,
  type NoDataMode,
  type RecordingRule,
  type Rule,
  type RuleGroup,
  type RulerConfig,
  type SloRuleV2,
  type ValidationError,
} from '../contracts-proposal/rules.v2'
import { anomalyKeyText, maxClass, parseAnomalySpec } from './anomaly'
import { parseSloSpec, sloKeyText } from './slo'
import { classify, PromqlTextError } from './classify'
import { parseTemplate, type Template } from './template'
import { byteLength, formatDuration, hash64, LABEL_NAME_RE, labelsKey, METRIC_NAME_RE, parseDuration } from './util'

export const DEADMAN_GROUP = 'viz:deadman'
export const DEADMAN_ALERT = 'DeadMansSwitch'

const GROUP_FIELDS = new Set(['name', 'interval', 'query_offset', 'limit', 'labels', 'rules'])
const ALERT_FIELDS = new Set(['alert', 'expr', 'for', 'keep_firing_for', 'labels', 'annotations', 'no_data', 'no_data_for', 'no_data_expr', 'monitor', 'anomaly', 'slo'])
const NO_DATA_MODES: NoDataMode[] = ['ok', 'alerting', 'keep']
export const MONITOR_ID_RE = /^mon_[0-9a-f]{16}$/
const RECORD_FIELDS = new Set(['record', 'expr', 'labels'])

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export interface ParsedGroups {
  groups: RuleGroup[]
  errors: ValidationError[]
  warnings: ValidationError[]
  /** Where each anomaly rule was in the document (`groups[i].rules[j]`), for errors found after parsing. */
  anomalyPaths?: Map<AnomalyRuleV2, string>
  /** The same for SLO rules. */
  sloPaths?: Map<SloRuleV2, string>
}

class Ctx {
  errors: ValidationError[] = []
  warnings: ValidationError[] = []
  err(path: string, message: string, fix: string) {
    this.errors.push({ path, message, fix })
  }
  warn(path: string, message: string, fix: string) {
    this.warnings.push({ path, message, fix })
  }
}

function duration(c: Ctx, v: unknown, path: string, what: string): number | null {
  if (v === undefined) return null
  if (typeof v !== 'string') {
    c.err(path, `${what} must be a duration string`, 'Write a Prometheus duration in quotes, e.g. "5m" or "1h30m".')
    return null
  }
  const ms = parseDuration(v)
  if (ms === null) {
    c.err(path, `"${v}" is not a valid duration`, 'Use units y, w, d, h, m, s, ms in that order, e.g. "5m" or "1h30m".')
    return null
  }
  return ms
}

function stringMap(c: Ctx, v: unknown, path: string, what: string): Record<string, string> {
  if (v === undefined || v === null) return {}
  if (!isObject(v)) {
    c.err(path, `${what} must be a map of strings`, `Write ${what} as key: value pairs.`)
    return {}
  }
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(v)) {
    if (!LABEL_NAME_RE.test(k)) {
      c.err(`${path}.${k}`, `"${k}" is not a valid name`, 'Names start with a letter or underscore and contain only letters, digits and underscores.')
      continue
    }
    if (typeof val !== 'string') {
      c.err(`${path}.${k}`, 'value must be a string', 'Quote the value.')
      continue
    }
    out[k] = val
  }
  return out
}

function template(c: Ctx, text: string, path: string): void {
  const r = parseTemplate(text)
  if (!r.ok) c.err(path, `${r.error.message} (at character ${r.error.offset})`, r.error.fix)
}

function expr(c: Ctx, v: unknown, path: string, cfg: RulerConfig) {
  if (typeof v !== 'string' || v.trim() === '') {
    c.err(path, 'expr is required', 'Give the PromQL expression to evaluate.')
    return null
  }
  if (byteLength(v) > 16_384) {
    c.err(path, 'expr is longer than 16384 bytes', 'Split the expression with recording rules.')
    return null
  }
  try {
    return classify(v, { hotWindowMs: cfg.hotWindowMs, recentWindowMs: cfg.recentWindowMs, lookbackMs: cfg.lookbackMs })
  } catch (e) {
    if (e instanceof PromqlTextError) {
      c.err(path, e.message, e.fix)
      return null
    }
    throw e
  }
}

/** viz's no-data fields on an alerting rule. Absent or `ok` is Prometheus' behaviour and stores nothing. */
function noDataPolicy(c: Ctx, r: Record<string, unknown>, rp: string, cfg: RulerConfig): AlertingRule['noData'] | null {
  const mode = r.no_data === undefined ? 'ok' : r.no_data
  if (typeof mode !== 'string' || !NO_DATA_MODES.includes(mode as NoDataMode)) {
    c.err(`${rp}.no_data`, `no_data must be one of ${NO_DATA_MODES.join(', ')}`, 'Use "ok" (no data means no alert), "alerting" (fire after no_data_for) or "keep" (leave the state as it is).')
    return null
  }
  const forMs = duration(c, r.no_data_for, `${rp}.no_data_for`, 'no_data_for')
  let exprText: string | null = null
  if (r.no_data_expr !== undefined) {
    if (expr(c, r.no_data_expr, `${rp}.no_data_expr`, cfg) === null) return null
    exprText = r.no_data_expr as string
  }
  if (mode === 'ok') {
    if (forMs !== null || exprText !== null) c.warn(`${rp}.no_data`, 'no_data_for and no_data_expr have no effect while no_data is "ok"', 'Set no_data to "alerting" or "keep", or remove the two fields.')
    return null
  }
  if (mode === 'keep' && forMs !== null) c.warn(`${rp}.no_data_for`, 'no_data_for has no effect with no_data "keep"', 'Remove it.')
  if (exprText === null) {
    c.warn(`${rp}.no_data`, 'without no_data_expr, "no data" means the rule expression itself returned nothing; for a comparison that is also what a healthy system returns', 'Give the bare query (without the comparison) as no_data_expr.')
  }
  return { mode: mode as NoDataMode, forMs: mode === 'alerting' ? (forMs ?? 0) : 0, expr: exprText }
}

const MONITOR_FIELDS = ['id', 'owner', 'startInvestigation', 'condition', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy']
const CONDITION_OPS = ['>', '>=', '<', '<=', '==', '!=']

/** The presentation block of a monitor. Written by the HTTP API; checked here because rule files can carry it too. */
function monitorMeta(c: Ctx, v: unknown, path: string): MonitorMeta | null {
  if (v === undefined) return null
  if (!isObject(v)) {
    c.err(path, 'monitor must be an object', 'Remove the field; it is written by the monitors API.')
    return null
  }
  const before = c.errors.length
  for (const k of Object.keys(v)) if (!MONITOR_FIELDS.includes(k)) c.err(`${path}.${k}`, `unknown field "${k}"`, `A monitor block has: ${MONITOR_FIELDS.join(', ')}.`)
  if (typeof v.id !== 'string' || !MONITOR_ID_RE.test(v.id)) c.err(`${path}.id`, 'monitor id must be "mon_" and 16 hex digits', 'Let the monitors API assign the id.')
  const text = (k: string, max: number): string => {
    const x = v[k] === undefined ? '' : v[k]
    if (typeof x !== 'string' || byteLength(x) > max) {
      c.err(`${path}.${k}`, `${k} must be a string of at most ${max} bytes`, 'Shorten it.')
      return ''
    }
    return x
  }
  const time = (k: string): number => {
    const x = v[k]
    if (typeof x !== 'number' || !Number.isFinite(x)) {
      c.err(`${path}.${k}`, `${k} must be a time in Unix milliseconds`, 'Let the monitors API set it.')
      return 0
    }
    return x
  }
  let condition: MonitorMeta['condition'] = null
  if (v.condition !== undefined && v.condition !== null) {
    const k = v.condition
    if (!isObject(k) || typeof k.query !== 'string' || typeof k.op !== 'string' || !CONDITION_OPS.includes(k.op) || typeof k.threshold !== 'number' || !Number.isFinite(k.threshold) || (k.unit !== undefined && typeof k.unit !== 'string')) {
      c.err(`${path}.condition`, 'condition must be { query, op, threshold, unit }', `Use one of ${CONDITION_OPS.join(' ')} and a finite number.`)
    } else {
      condition = { query: k.query, op: k.op as NonNullable<MonitorMeta['condition']>['op'], threshold: k.threshold, unit: typeof k.unit === 'string' ? k.unit : '' }
    }
  }
  if (v.startInvestigation !== undefined && typeof v.startInvestigation !== 'boolean') c.err(`${path}.startInvestigation`, 'startInvestigation must be true or false', 'Use a boolean.')
  const meta: MonitorMeta = {
    id: v.id as string,
    owner: text('owner', 256),
    startInvestigation: v.startInvestigation === true,
    condition,
    createdAt: time('createdAt'),
    createdBy: text('createdBy', 256),
    updatedAt: time('updatedAt'),
    updatedBy: text('updatedBy', 256),
  }
  return c.errors.length === before ? meta : null
}

/** Key of a rule inside its group: what must stay the same for alert state to carry over a save. */
export function ruleKey(kind: 'alert' | 'record' | 'anomaly' | 'slo', name: string, exprText: string, labels: Record<string, string>): string {
  return hash64(`${kind}\u0000${name}\u0000${exprText}\u0000${labelsKey(labels)}`)
}

/** The anomaly rules stored in a group, for an entry saved over one of them (`priorAnomaly`). */
export type StoredAnomalyRules = (group: string) => readonly AnomalyRuleV2[] | undefined

/**
 * The stored anomaly rule an entry is saved over: in the same group, the one with the entry's
 * monitor id; without a monitor id, the only one with the same alert name and expression. Its
 * defaults are kept for what the entry leaves out (`parseAnomalySpec`).
 */
export function priorAnomaly(stored: readonly AnomalyRuleV2[] | undefined, name: string, exprText: unknown, monitorId: string | null): AnomalyRuleV2 | null {
  if (!stored) return null
  if (monitorId !== null) return stored.find((r) => r.monitor?.id === monitorId) ?? null
  const same = stored.filter((r) => r.name === name && r.expr === exprText)
  return same.length === 1 ? (same[0] as AnomalyRuleV2) : null
}

/**
 * Validate a rule file. `cfg` supplies limits, the default interval and the classification
 * thresholds. Group-level limits that depend on what is already stored (max groups) are
 * checked by the caller. `stored` gives what is stored now, so that an anomaly rule saved again
 * keeps the defaults it was stored with.
 */
export function parseRuleFile(doc: unknown, cfg: RulerConfig, stored?: StoredAnomalyRules): ParsedGroups {
  const c = new Ctx()
  const groups: RuleGroup[] = []
  const anomalyPaths = new Map<AnomalyRuleV2, string>()
  const sloPaths = new Map<SloRuleV2, string>()
  if (!isObject(doc) || !Array.isArray(doc.groups)) {
    c.err('groups', 'a rule file is an object with a "groups" list', 'Wrap the groups as { "groups": [ { "name": ..., "rules": [...] } ] }.')
    return { groups, errors: c.errors, warnings: c.warnings }
  }
  for (const k of Object.keys(doc)) if (k !== 'groups') c.err(k, `unknown field "${k}"`, 'Only "groups" is allowed at the top level.')
  const seen = new Set<string>()
  const monitorIds = new Set<string>()
  doc.groups.forEach((g: unknown, gi: number) => {
    const gp = `groups[${gi}]`
    if (!isObject(g)) {
      c.err(gp, 'a group must be an object', 'Give the group a name and a rules list.')
      return
    }
    for (const k of Object.keys(g)) if (!GROUP_FIELDS.has(k)) c.err(`${gp}.${k}`, `unknown field "${k}"`, `A group has: ${[...GROUP_FIELDS].join(', ')}.`)
    const name = g.name
    if (typeof name !== 'string' || name === '') {
      c.err(`${gp}.name`, 'group name is required', 'Give the group a non-empty name.')
      return
    }
    const storedAnomaly = stored?.(name)
    if (byteLength(name) > 256) c.err(`${gp}.name`, 'group name is longer than 256 bytes', 'Shorten the name.')
    if (name.startsWith('viz:')) c.err(`${gp}.name`, 'group names starting with "viz:" are reserved', 'Choose another name.')
    if (seen.has(name)) c.err(`${gp}.name`, `group name "${name}" is repeated in this file`, 'Group names must be unique.')
    seen.add(name)

    let intervalMs = duration(c, g.interval, `${gp}.interval`, 'interval') ?? cfg.defaultIntervalMs
    if (intervalMs < cfg.limits.minIntervalMs) {
      c.err(`${gp}.interval`, `interval ${formatDuration(intervalMs)} is below the minimum ${formatDuration(cfg.limits.minIntervalMs)}`, `Use an interval of at least ${formatDuration(cfg.limits.minIntervalMs)}.`)
      intervalMs = cfg.limits.minIntervalMs
    }
    const queryOffsetMs = duration(c, g.query_offset, `${gp}.query_offset`, 'query_offset') ?? 0
    let limit = 0
    if (g.limit !== undefined) {
      if (typeof g.limit !== 'number' || !Number.isInteger(g.limit)) c.err(`${gp}.limit`, 'limit must be an integer', 'Use a whole number; 0 means no group limit.')
      else limit = Math.max(0, g.limit)
    }
    const groupLabels = stringMap(c, g.labels, `${gp}.labels`, 'labels')
    if (!Array.isArray(g.rules)) {
      c.err(`${gp}.rules`, 'rules must be a list', 'List the alerting and recording rules of the group.')
      return
    }
    if (g.rules.length > cfg.limits.maxRulesPerGroup) {
      c.err(`${gp}.rules`, `group has ${g.rules.length} rules; the limit is ${cfg.limits.maxRulesPerGroup}`, 'Split the group.')
      return
    }
    const rules: Rule[] = []
    const anomalyRules: AnomalyRuleV2[] = []
    const sloRules: SloRuleV2[] = []
    const keys = new Set<string>()
    g.rules.forEach((r: unknown, ri: number) => {
      const rp = `${gp}.rules[${ri}]`
      if (!isObject(r)) {
        c.err(rp, 'a rule must be an object', 'Give either "alert" or "record", and "expr".')
        return
      }
      const isAlert = r.alert !== undefined
      const isRecord = r.record !== undefined
      if (isAlert === isRecord) {
        c.err(rp, isAlert ? 'a rule cannot have both "alert" and "record"' : 'a rule needs "alert" or "record"', 'Keep exactly one of "alert" (alerting rule) or "record" (recording rule).')
        return
      }
      const allowed = isAlert ? ALERT_FIELDS : RECORD_FIELDS
      for (const k of Object.keys(r)) {
        if (!allowed.has(k)) {
          c.err(`${rp}.${k}`, `unknown field "${k}" for ${isAlert ? 'an alerting' : 'a recording'} rule`, isAlert ? `An alerting rule has: ${[...ALERT_FIELDS].join(', ')}.` : `A recording rule has: ${[...RECORD_FIELDS].join(', ')}; "for" and "annotations" belong to alerting rules.`)
        }
      }
      // An SLO entry has no expr: its SLI is the expression (contract version 4).
      const isSlo = isAlert && r.slo !== undefined
      if (isSlo && r.expr !== undefined) c.err(`${rp}.expr`, 'an SLO rule has no expr: the SLI in slo.sli is its expression', 'Remove expr; give the good (or bad) and total events in slo.sli.')
      const cost = isSlo ? null : expr(c, r.expr, `${rp}.expr`, cfg)
      const labels = { ...groupLabels, ...stringMap(c, r.labels, `${rp}.labels`, 'labels') }
      for (const [k, v] of Object.entries(labels)) {
        if (k === '__name__') c.err(`${rp}.labels.${k}`, 'a rule cannot set __name__', 'Remove the label; the name comes from "alert" or "record".')
        if (isAlert && k === 'alertname') c.err(`${rp}.labels.${k}`, 'a rule cannot set alertname', 'Remove the label; it is always the rule\'s "alert" name.')
        if (k === NO_DATA_LABEL) c.err(`${rp}.labels.${k}`, `${NO_DATA_LABEL} is reserved for the no-data alert`, 'Remove the label.')
        if (byteLength(v) > 1024) c.err(`${rp}.labels.${k}`, 'label value template is longer than 1024 bytes', 'Shorten the value; put long text in an annotation.')
        if (isAlert) template(c, v, `${rp}.labels.${k}`)
      }
      if (Object.keys(labels).length > 64) c.err(`${rp}.labels`, 'more than 64 labels', 'Remove labels.')
      if (isAlert) {
        const name = r.alert
        if (typeof name !== 'string' || name === '') {
          c.err(`${rp}.alert`, 'alert name must be a non-empty string', 'Name the alert, e.g. "HighErrorRate".')
          return
        }
        if (byteLength(name) > 256) c.err(`${rp}.alert`, 'alert name is longer than 256 bytes', 'Shorten the name.')
        const forMs = duration(c, r.for, `${rp}.for`, 'for') ?? 0
        const keepFiringForMs = duration(c, r.keep_firing_for, `${rp}.keep_firing_for`, 'keep_firing_for') ?? 0
        const annotations = stringMap(c, r.annotations, `${rp}.annotations`, 'annotations')
        for (const [k, v] of Object.entries(annotations)) {
          if (byteLength(v) > cfg.limits.maxAnnotationBytes) {
            c.err(`${rp}.annotations.${k}`, `annotation is ${byteLength(v)} bytes; the limit is ${cfg.limits.maxAnnotationBytes}`, 'Shorten the annotation or link to a runbook.')
          }
          template(c, v, `${rp}.annotations.${k}`)
        }
        if (Object.keys(annotations).length > 32) c.err(`${rp}.annotations`, 'more than 32 annotations', 'Remove annotations.')
        if (forMs > 0 && forMs < intervalMs) {
          c.warn(`${rp}.for`, `for (${formatDuration(forMs)}) is shorter than the group interval (${formatDuration(intervalMs)}); the alert fires on the second matching evaluation, ${formatDuration(intervalMs)} after the first`, 'Raise "for" to at least the interval, or shorten the interval.')
        }
        const noData = noDataPolicy(c, r, rp, cfg)
        const monitor = monitorMeta(c, r.monitor, `${rp}.monitor`)
        if (isSlo) {
          // An SLO burn-rate rule (contract version 4): the burn-rate alerts are the condition.
          if (r.anomaly !== undefined) c.err(`${rp}.anomaly`, 'a rule is an anomaly rule or an SLO rule, not both', 'Remove one of anomaly and slo.')
          for (const k of [SLO_ANNOTATION, SLO_DETAIL_ANNOTATION]) {
            if (k in annotations) c.err(`${rp}.annotations.${k}`, `the ${k} annotation is written by the SLO rule`, 'Remove it; use description or summary for your own text.')
          }
          if (monitor?.condition) c.err(`${rp}.monitor.condition`, 'an SLO rule has no threshold condition', 'Remove the condition; the burn-rate alerts decide.')
          const parsed = parseSloSpec(c, r.slo, `${rp}.slo`, intervalMs, labels, cfg)
          if (!parsed) return
          const rule: SloRuleV2 = {
            kind: 'slo',
            name,
            expr: parsed.expr,
            slo: parsed.spec,
            forMs,
            keepFiringForMs,
            labels,
            annotations,
            key: ruleKey('slo', name, sloKeyText(parsed.spec), labels),
            cost: { class: parsed.tickCost.class, windowMs: parsed.tickCost.windowMs, reason: `${parsed.tickCost.reason}; ${parsed.spec.history.reason}` },
          }
          if (noData) rule.noData = noData
          if (monitor) {
            if (monitorIds.has(monitor.id)) c.err(`${rp}.monitor.id`, `monitor id ${monitor.id} is used twice in this file`, 'Give each monitor its own id.')
            monitorIds.add(monitor.id)
            rule.monitor = monitor
          }
          if (keys.has(rule.key)) {
            c.err(rp, `SLO rule "${name}" is repeated with the same SLI, objective, alerts and labels`, 'Remove the duplicate.')
            return
          }
          keys.add(rule.key)
          sloRules.push(rule)
          sloPaths.set(rule, rp)
          return
        }
        if (r.anomaly !== undefined) {
          // An anomaly rule (contract version 2): the detector's flag is the condition.
          for (const k of [ANOMALY_ANNOTATION, ANOMALY_DETAIL_ANNOTATION]) {
            if (k in annotations) c.err(`${rp}.annotations.${k}`, `the ${k} annotation is written by the detector`, 'Remove it; use description or summary for your own text.')
          }
          if (monitor?.condition) c.err(`${rp}.monitor.condition`, 'an anomaly rule has no threshold condition', 'Remove the condition; the detector decides.')
          const prior = priorAnomaly(storedAnomaly, name, r.expr, monitor?.id ?? null)
          const spec = parseAnomalySpec(c, r.anomaly, `${rp}.anomaly`, intervalMs, forMs, labels, cfg, prior?.anomaly ?? null)
          if (!cost || !spec) return
          const ruleLabels = { ...labels, severity: spec.severity }
          const rule: AnomalyRuleV2 = {
            kind: 'anomaly',
            name,
            expr: r.expr as string,
            anomaly: spec,
            forMs,
            keepFiringForMs,
            labels: ruleLabels,
            annotations,
            key: ruleKey('anomaly', name, anomalyKeyText(r.expr as string, spec), ruleLabels),
            cost: { class: maxClass(cost.class, spec.history.tick), windowMs: Math.max(cost.windowMs, spec.history.tickLookbackMs), reason: `${cost.reason}; the detector: ${spec.history.reason}` },
          }
          if (noData) rule.noData = noData
          if (monitor) {
            if (monitorIds.has(monitor.id)) c.err(`${rp}.monitor.id`, `monitor id ${monitor.id} is used twice in this file`, 'Give each monitor its own id.')
            monitorIds.add(monitor.id)
            rule.monitor = monitor
          }
          if (keys.has(rule.key)) {
            c.err(rp, `anomaly rule "${name}" is repeated with the same expression, detector, parameters and labels`, 'Remove the duplicate.')
            return
          }
          keys.add(rule.key)
          anomalyRules.push(rule)
          anomalyPaths.set(rule, rp)
          return
        }
        if (!cost) return
        const rule: AlertingRule = { kind: 'alert', name, expr: r.expr as string, forMs, keepFiringForMs, labels, annotations, key: ruleKey('alert', name, r.expr as string, labels), cost }
        if (noData) rule.noData = noData
        if (monitor) {
          if (monitorIds.has(monitor.id)) c.err(`${rp}.monitor.id`, `monitor id ${monitor.id} is used twice in this file`, 'Give each monitor its own id.')
          monitorIds.add(monitor.id)
          rule.monitor = monitor
        }
        if (keys.has(rule.key)) {
          c.err(rp, `alerting rule "${name}" is repeated with the same expression and labels`, 'Remove the duplicate.')
          return
        }
        keys.add(rule.key)
        rules.push(rule)
      } else {
        const name = r.record
        if (typeof name !== 'string' || !METRIC_NAME_RE.test(name)) {
          c.err(`${rp}.record`, `"${String(name)}" is not a valid metric name`, 'Use letters, digits, underscores and colons, e.g. "job:http_requests:rate5m".')
          return
        }
        if (!cost) return
        const rule: RecordingRule = { kind: 'record', name, expr: r.expr as string, labels, key: ruleKey('record', name, r.expr as string, labels), cost }
        if (keys.has(rule.key)) {
          c.err(rp, `recording rule "${name}" is repeated with the same expression and labels`, 'Remove the duplicate.')
          return
        }
        keys.add(rule.key)
        rules.push(rule)
      }
    })
    const group: RuleGroup = { name, intervalMs, queryOffsetMs, limit, rules }
    // Only when there are any, so a group without anomaly rules is stored exactly as before.
    if (anomalyRules.length > 0) group.anomalyRules = anomalyRules
    if (sloRules.length > 0) group.sloRules = sloRules
    groups.push(group)
  })
  return { groups, errors: c.errors, warnings: c.warnings, anomalyPaths, sloPaths }
}

/** The built-in always-firing rule (dead-man's switch). */
export function deadmanGroup(cfg: RulerConfig): RuleGroup {
  const exprText = 'vector(1)'
  const labels = { severity: 'none' }
  return {
    name: DEADMAN_GROUP,
    intervalMs: cfg.deadmanIntervalMs,
    queryOffsetMs: 0,
    limit: 0,
    rules: [
      {
        kind: 'alert',
        name: DEADMAN_ALERT,
        expr: exprText,
        forMs: 0,
        keepFiringForMs: 0,
        labels,
        annotations: {
          summary: 'Always firing. Proves that rule evaluation, routing and delivery work; alert on its absence.',
        },
        key: ruleKey('alert', DEADMAN_ALERT, exprText, labels),
        cost: classify(exprText, { hotWindowMs: cfg.hotWindowMs, recentWindowMs: cfg.recentWindowMs, lookbackMs: cfg.lookbackMs }),
      },
    ],
  }
}

/** Parsed templates of one alerting rule, built once per group load. */
export interface CompiledAlertRule {
  labels: [string, Template][]
  annotations: [string, Template][]
}

export function compileAlertRule(rule: AlertingRule): CompiledAlertRule {
  const compile = (m: Record<string, string>): [string, Template][] =>
    Object.entries(m).map(([k, v]) => {
      const r = parseTemplate(v)
      // Stored rules were validated at save time; a template that no longer parses (an
      // older build accepted it) degrades to its literal text rather than failing the rule.
      return [k, r.ok ? r.template : { nodes: [{ t: 'text', v }], constant: true, source: v }]
    })
  return { labels: compile(rule.labels), annotations: compile(rule.annotations) }
}
