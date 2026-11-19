/**
 * Prometheus rule files as YAML: import to the JSON document `parseRuleFile` validates, and
 * export of stored groups back to YAML.
 *
 * Import applies the rule-file schema to the YAML tree the way Prometheus' typed decoder
 * does: `expr: 1` is the string "1", a label value `true` is the string "true", `limit` is
 * an integer. Everything else (unknown fields included) goes through unchanged so that
 * validation reports it with its path.
 */
import type { AnomalyRuleV2, RuleGroup, RuleV2, ValidationError } from '../contracts-proposal/rules.v2'
import { formatDuration } from './util'
import { core, parseYaml, toYaml, YamlError, type YamlNode } from './yaml'

const STRING_FIELDS = new Set(['name', 'interval', 'query_offset', 'alert', 'record', 'expr', 'for', 'keep_firing_for', 'no_data', 'no_data_for', 'no_data_expr'])
const STRING_MAP_FIELDS = new Set(['labels', 'annotations'])

function text(n: YamlNode): unknown {
  return n.k === 'scalar' ? n.v : core(n)
}

function stringMap(n: YamlNode): unknown {
  if (n.k === 'scalar' && n.plain && n.v === '') return undefined
  if (n.k !== 'map') return core(n)
  const out: Record<string, unknown> = {}
  for (const [k, v] of n.entries) Object.defineProperty(out, k, { value: text(v), enumerable: true, writable: true, configurable: true })
  return out
}

function fields(n: YamlNode, child: (key: string, v: YamlNode) => unknown): unknown {
  if (n.k !== 'map') return core(n)
  const out: Record<string, unknown> = {}
  for (const [k, v] of n.entries) {
    const value = STRING_FIELDS.has(k) ? text(v) : STRING_MAP_FIELDS.has(k) ? stringMap(v) : child(k, v)
    if (value !== undefined) Object.defineProperty(out, k, { value, enumerable: true, writable: true, configurable: true })
  }
  return out
}

const list = (n: YamlNode, item: (v: YamlNode) => unknown): unknown => (n.k === 'seq' ? n.items.map(item) : n.k === 'scalar' && n.plain && n.v === '' ? [] : core(n))

/** YAML text to the rule-file document. A YAML problem is reported like a validation problem, with its line. */
export function importRuleFile(yaml: string): { ok: true; file: unknown } | { ok: false; errors: ValidationError[] } {
  let root: YamlNode
  try {
    root = parseYaml(yaml)
  } catch (e) {
    if (e instanceof YamlError) return { ok: false, errors: [{ path: `line ${e.line}`, message: e.message, fix: e.fix }] }
    throw e
  }
  if (root.k !== 'map') return { ok: false, errors: [{ path: 'groups', message: 'a rule file is a mapping with a "groups" list', fix: 'Start the file with "groups:".' }] }
  const rule = (r: YamlNode) => fields(r, (_k, v) => core(v))
  const group = (g: YamlNode) => fields(g, (k, v) => (k === 'rules' ? list(v, rule) : core(v)))
  const file: Record<string, unknown> = {}
  for (const [k, v] of root.entries) file[k] = k === 'groups' ? list(v, group) : core(v)
  return { ok: true, file }
}

export interface ExportOptions {
  /**
   * Keep viz's own fields (`no_data*`, `monitor`) and anomaly rules. With false the output is a
   * file Prometheus loads, and `dropped` lists what was left out: an anomaly rule is left out
   * whole, because without its detector it would be an alerting rule that fires for every series.
   */
  extensions: boolean
}

/** Stored groups back to the rule-file document. Group labels were merged into each rule at save time, so they come out on the rules. */
export function ruleFileDocument(groups: RuleGroup[], opts: ExportOptions): { file: { groups: Record<string, unknown>[] }; dropped: string[] } {
  const dropped: string[] = []
  const out = groups.map((g) => {
    const group: Record<string, unknown> = { name: g.name, interval: formatDuration(g.intervalMs) }
    if (g.queryOffsetMs > 0) group.query_offset = formatDuration(g.queryOffsetMs)
    if (g.limit > 0) group.limit = g.limit
    group.rules = (g.rules as RuleV2[]).map((r) => {
      const rule: Record<string, unknown> = r.kind === 'alert' ? { alert: r.name, expr: r.expr } : { record: r.name, expr: r.expr }
      if (r.kind === 'alert') {
        if (r.forMs > 0) rule.for = formatDuration(r.forMs)
        if (r.keepFiringForMs > 0) rule.keep_firing_for = formatDuration(r.keepFiringForMs)
      }
      if (Object.keys(r.labels).length > 0) rule.labels = r.labels
      if (r.kind === 'alert') {
        if (Object.keys(r.annotations).length > 0) rule.annotations = r.annotations
        if (r.noData) {
          if (opts.extensions) {
            rule.no_data = r.noData.mode
            if (r.noData.mode === 'alerting') rule.no_data_for = formatDuration(r.noData.forMs)
            if (r.noData.expr !== null) rule.no_data_expr = r.noData.expr
          } else dropped.push(`${g.name}/${r.name}: no_data ${r.noData.mode}`)
        }
        if (r.monitor) {
          if (opts.extensions) rule.monitor = r.monitor
          else dropped.push(`${g.name}/${r.name}: monitor ${r.monitor.id}`)
        }
      }
      return rule
    })
    // Anomaly rules come after the group's other rules, as they are stored and evaluated.
    for (const r of (g.anomalyRules ?? []) as AnomalyRuleV2[]) {
      if (!opts.extensions) {
        dropped.push(`${g.name}/${r.name}: anomaly rule (${r.anomaly.detector})`)
        continue
      }
      const rule: Record<string, unknown> = { alert: r.name, expr: r.expr }
      if (r.forMs > 0) rule.for = formatDuration(r.forMs)
      if (r.keepFiringForMs > 0) rule.keep_firing_for = formatDuration(r.keepFiringForMs)
      // The severity label is written once, in the anomaly block.
      const { severity: _s, ...labels } = r.labels
      if (Object.keys(labels).length > 0) rule.labels = labels
      if (Object.keys(r.annotations).length > 0) rule.annotations = r.annotations
      if (r.noData) {
        rule.no_data = r.noData.mode
        if (r.noData.mode === 'alerting') rule.no_data_for = formatDuration(r.noData.forMs)
        if (r.noData.expr !== null) rule.no_data_expr = r.noData.expr
      }
      if (r.monitor) rule.monitor = r.monitor
      // Every parameter, defaults included, so re-importing the file under a later release with
      // other defaults still means the same rule; `given` keeps which ones the author chose.
      const a = r.anomaly
      const block: Record<string, unknown> = { detector: a.detector, params: a.params, given: a.given, severity: a.severity, max_series: a.maxSeries }
      if (a.unit !== '') block.unit = a.unit
      rule.anomaly = block
      ;(group.rules as unknown[]).push(rule)
    }
    return group
  })
  return { file: { groups: out }, dropped }
}

export function exportRuleFile(groups: RuleGroup[], opts: ExportOptions): { yaml: string; dropped: string[] } {
  const { file, dropped } = ruleFileDocument(groups, opts)
  return { yaml: toYaml(file), dropped }
}
