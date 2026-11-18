/**
 * Alertmanager's configuration model: validation of the notifier config document, the
 * routing tree, matchers, inhibition rules and silence matching. Pure; no storage.
 */
import { RECEIVER_LABEL, type InhibitRuleInput, type NotifierConfigInput, type ReceiverSummary, type RouteInput, type SilenceInput, type SilenceMatcher, type ValidationError } from '../contracts-proposal/rules.v2'
import { LABEL_NAME_RE, labelValue, parseDuration, type Labels } from './util'

export interface Matcher {
  name: string
  value: string
  /** Anchored regex for `=~` / `!~`; null for equality. */
  re: RegExp | null
  /** False for the negated forms. */
  equal: boolean
}

export interface Route {
  /** Path of matcher sets from the root, e.g. `{}/{team="db"}/1`. Part of every group key. */
  key: string
  receiver: string
  /** Label names, or 'all' for Alertmanager's `group_by: ['...']`. */
  groupBy: string[] | 'all'
  matchers: Matcher[]
  continue: boolean
  groupWaitMs: number
  groupIntervalMs: number
  repeatIntervalMs: number
  routes: Route[]
}

export interface Integration {
  /** `webhook[0]`, `slack[0]`, ... */
  key: string
  kind: 'webhook' | 'slack'
  url: string
  sendResolved: boolean
  maxAlerts: number
  channel: string | null
  /** Signs outbound requests (`signature.ts`). Never returned by any RPC. */
  secret: string | null
}

export interface InhibitRule {
  source: Matcher[]
  target: Matcher[]
  equal: string[]
}

export interface Delivery {
  maxAttempts: number
  baseBackoffMs: number
  maxBackoffMs: number
  timeoutMs: number
}

export interface CompiledConfig {
  root: Route
  receivers: Map<string, Integration[]>
  inhibit: InhibitRule[]
  externalUrl: string
  delivery: Delivery
  maxGroupIntervalMs: number
}

const MAX_REGEX_LENGTH = 1024

/** Compile a fully anchored regex, as Prometheus and Alertmanager anchor theirs. */
export function anchored(pattern: string): RegExp {
  if (pattern.length > MAX_REGEX_LENGTH) throw new Error(`regex is longer than ${MAX_REGEX_LENGTH} characters`)
  return new RegExp(`^(?:${pattern})$`, 's')
}

export function matches(m: Matcher, labels: Labels): boolean {
  const v = labelValue(labels, m.name)
  const hit = m.re ? m.re.test(v) : v === m.value
  return hit === m.equal
}

export function matchesAll(ms: Matcher[], labels: Labels): boolean {
  for (const m of ms) if (!matches(m, labels)) return false
  return true
}

function matcherText(m: Matcher): string {
  return `${m.name}${m.re ? (m.equal ? '=~' : '!~') : m.equal ? '=' : '!='}${JSON.stringify(m.value)}`
}

class Ctx {
  errors: ValidationError[] = []
  err(path: string, message: string, fix: string) {
    this.errors.push({ path, message, fix })
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function compileMatchers(c: Ctx, path: string, eq: unknown, re: unknown, list?: unknown): Matcher[] {
  const out: Matcher[] = []
  const add = (name: string, value: unknown, isRegex: boolean, equal: boolean, p: string) => {
    if (!LABEL_NAME_RE.test(name)) return c.err(p, `"${name}" is not a valid label name`, 'Label names contain only letters, digits and underscores.')
    if (typeof value !== 'string') return c.err(p, 'matcher value must be a string', 'Quote the value.')
    let compiled: RegExp | null = null
    if (isRegex) {
      try {
        compiled = anchored(value)
      } catch (e) {
        return c.err(p, `invalid regex: ${e instanceof Error ? e.message : String(e)}`, 'Fix the regular expression; it is matched against the whole label value.')
      }
    }
    out.push({ name, value, re: compiled, equal })
  }
  if (eq !== undefined) {
    if (!isObject(eq)) c.err(`${path}`, 'match must be a map of label: value', 'Write match as { "severity": "page" }.')
    else for (const [k, v] of Object.entries(eq)) add(k, v, false, true, `${path}.${k}`)
  }
  if (re !== undefined) {
    if (!isObject(re)) c.err(`${path}_re`, 'match_re must be a map of label: regex', 'Write match_re as { "service": "api|web" }.')
    else for (const [k, v] of Object.entries(re)) add(k, v, true, true, `${path}_re.${k}`)
  }
  if (list !== undefined) {
    if (!Array.isArray(list)) c.err(`${path}ers`, 'matchers must be a list of strings', 'Write matchers as ["severity=\\"page\\""].')
    else {
      list.forEach((text: unknown, i: number) => {
        const m = typeof text === 'string' ? /^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*(=~|!~|!=|=)\s*(.*?)\s*$/.exec(text) : null
        if (!m) return c.err(`${path}ers[${i}]`, 'not a matcher', 'Write name="value", name!="value", name=~"regex" or name!~"regex".')
        let value = m[3] as string
        if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
          try {
            value = JSON.parse(value) as string
          } catch {
            return c.err(`${path}ers[${i}]`, 'badly quoted matcher value', 'Use a double-quoted string.')
          }
        }
        const op = m[2] as string
        add(m[1] as string, value, op.endsWith('~'), !op.startsWith('!'), `${path}ers[${i}]`)
      })
    }
  }
  return out
}

function duration(c: Ctx, v: unknown, path: string, fallback: number, min: number): number {
  if (v === undefined) return fallback
  const ms = typeof v === 'string' ? parseDuration(v) : null
  if (ms === null) {
    c.err(path, `${JSON.stringify(v)} is not a duration`, 'Write a duration string such as "30s" or "5m".')
    return fallback
  }
  if (ms < min) {
    c.err(path, `must be at least ${min} ms`, 'Use a longer duration.')
    return fallback
  }
  return ms
}

const ROUTE_FIELDS = new Set(['receiver', 'group_by', 'match', 'match_re', 'matchers', 'continue', 'group_wait', 'group_interval', 'repeat_interval', 'routes'])

function compileRoute(c: Ctx, input: unknown, path: string, parent: Route | null, index: number, receivers: Set<string>, budget: { routes: number }): Route | null {
  if (!isObject(input)) {
    c.err(path, 'a route must be an object', 'Give the route a receiver and, for child routes, matchers.')
    return null
  }
  if (++budget.routes > 256) {
    c.err(path, 'more than 256 routes', 'Simplify the routing tree.')
    return null
  }
  const r = input as RouteInput & Record<string, unknown>
  for (const k of Object.keys(r)) if (!ROUTE_FIELDS.has(k)) c.err(`${path}.${k}`, `unknown field "${k}"`, `A route has: ${[...ROUTE_FIELDS].join(', ')}.`)
  const matchers = compileMatchers(c, `${path}.match`, r.match, r.match_re, r.matchers)
  if (!parent && matchers.length > 0) c.err(`${path}.match`, 'the root route cannot have matchers', 'The root route must match every alert; move the matchers to a child route.')
  let receiver = parent?.receiver ?? ''
  if (r.receiver !== undefined) {
    if (typeof r.receiver !== 'string' || !receivers.has(r.receiver)) c.err(`${path}.receiver`, `receiver ${JSON.stringify(r.receiver)} is not defined`, 'Add it under "receivers" or use an existing name.')
    else receiver = r.receiver
  } else if (!parent) {
    c.err(`${path}.receiver`, 'the root route needs a receiver', 'Name the default receiver.')
  }
  let groupBy: string[] | 'all' = parent?.groupBy ?? []
  if (r.group_by !== undefined) {
    if (!Array.isArray(r.group_by) || r.group_by.some((x) => typeof x !== 'string')) c.err(`${path}.group_by`, 'group_by must be a list of label names', 'Write e.g. ["alertname", "cluster"], or ["..."] to group by every label.')
    else if (r.group_by.includes('...')) {
      if (r.group_by.length > 1) c.err(`${path}.group_by`, '"..." cannot be combined with label names', 'Use ["..."] alone.')
      groupBy = 'all'
    } else {
      for (const n of r.group_by) if (!LABEL_NAME_RE.test(n)) c.err(`${path}.group_by`, `"${n}" is not a valid label name`, 'Label names contain only letters, digits and underscores.')
      groupBy = [...new Set(r.group_by)].sort()
    }
  }
  if (r.continue !== undefined && typeof r.continue !== 'boolean') c.err(`${path}.continue`, 'continue must be true or false', 'Use a boolean.')
  const route: Route = {
    key: parent ? `${parent.key}/{${matchers.map(matcherText).join(',')}}/${index}` : '{}',
    receiver,
    groupBy,
    matchers,
    continue: r.continue === true,
    groupWaitMs: duration(c, r.group_wait, `${path}.group_wait`, parent?.groupWaitMs ?? 30_000, 0),
    groupIntervalMs: duration(c, r.group_interval, `${path}.group_interval`, parent?.groupIntervalMs ?? 5 * 60_000, 1000),
    repeatIntervalMs: duration(c, r.repeat_interval, `${path}.repeat_interval`, parent?.repeatIntervalMs ?? 4 * 3_600_000, 1000),
    routes: [],
  }
  if (r.routes !== undefined) {
    if (!Array.isArray(r.routes)) c.err(`${path}.routes`, 'routes must be a list', 'List the child routes.')
    else {
      r.routes.forEach((child: unknown, i: number) => {
        const cr = compileRoute(c, child, `${path}.routes[${i}]`, route, i, receivers, budget)
        if (cr) route.routes.push(cr)
      })
    }
  }
  return route
}

function httpUrl(c: Ctx, v: unknown, path: string): string {
  try {
    const u = new URL(String(v))
    if (typeof v === 'string' && (u.protocol === 'https:' || u.protocol === 'http:')) return v
  } catch {
    // fall through
  }
  c.err(path, 'must be an http(s) URL', 'Give the full URL of the receiving endpoint.')
  return ''
}

export function compileConfig(input: unknown): { ok: true; config: CompiledConfig } | { ok: false; errors: ValidationError[] } {
  const c = new Ctx()
  if (!isObject(input)) return { ok: false, errors: [{ path: '', message: 'config must be an object', fix: 'Send { "route": {...}, "receivers": [...] }.' }] }
  const doc = input as unknown as NotifierConfigInput & Record<string, unknown>
  for (const k of Object.keys(doc)) {
    if (!['route', 'receivers', 'inhibit_rules', 'external_url', 'delivery'].includes(k)) c.err(k, `unknown field "${k}"`, 'Supported: route, receivers, inhibit_rules, external_url, delivery.')
  }
  const receivers = new Map<string, Integration[]>()
  if (!Array.isArray(doc.receivers) || doc.receivers.length === 0) c.err('receivers', 'at least one receiver is required', 'Add a receiver with a webhook_configs or slack_configs entry.')
  else if (doc.receivers.length > 64) c.err('receivers', 'more than 64 receivers', 'Remove unused receivers.')
  else {
    doc.receivers.forEach((r: unknown, i: number) => {
      const p = `receivers[${i}]`
      if (!isObject(r) || typeof r.name !== 'string' || r.name === '') return c.err(`${p}.name`, 'receiver name is required', 'Name the receiver.')
      if (receivers.has(r.name)) return c.err(`${p}.name`, `receiver "${r.name}" is defined twice`, 'Receiver names must be unique.')
      for (const k of Object.keys(r)) if (!['name', 'webhook_configs', 'slack_configs'].includes(k)) c.err(`${p}.${k}`, `unsupported receiver field "${k}"`, 'Supported integrations: webhook_configs, slack_configs.')
      const list: Integration[] = []
      const each = (v: unknown, field: string, fn: (cfg: Record<string, unknown>, path: string, idx: number) => void) => {
        if (v === undefined) return
        if (!Array.isArray(v)) return c.err(`${p}.${field}`, `${field} must be a list`, 'Wrap the config in a list.')
        v.forEach((cfg: unknown, j: number) => (isObject(cfg) ? fn(cfg, `${p}.${field}[${j}]`, j) : c.err(`${p}.${field}[${j}]`, 'must be an object', 'Give the integration its settings.')))
      }
      each(r.webhook_configs, 'webhook_configs', (cfg, path, j) => {
        const max = cfg.max_alerts === undefined ? 0 : cfg.max_alerts
        if (typeof max !== 'number' || !Number.isInteger(max) || max < 0) c.err(`${path}.max_alerts`, 'max_alerts must be a non-negative integer', 'Use 0 for no limit.')
        if (cfg.secret !== undefined && (typeof cfg.secret !== 'string' || cfg.secret.length > 512)) c.err(`${path}.secret`, 'secret must be a string of at most 512 characters', 'Give the shared secret the receiver verifies the signature with.')
        else if (typeof cfg.secret === 'string' && cfg.secret !== '' && cfg.secret.length < 16) c.err(`${path}.secret`, 'secret is shorter than 16 characters', 'Use a random secret of at least 16 characters.')
        list.push({ key: `webhook[${j}]`, kind: 'webhook', url: httpUrl(c, cfg.url, `${path}.url`), sendResolved: cfg.send_resolved !== false, maxAlerts: typeof max === 'number' ? max : 0, channel: null, secret: typeof cfg.secret === 'string' && cfg.secret !== '' ? cfg.secret : null })
      })
      each(r.slack_configs, 'slack_configs', (cfg, path, j) => {
        list.push({ key: `slack[${j}]`, kind: 'slack', url: httpUrl(c, cfg.api_url, `${path}.api_url`), sendResolved: cfg.send_resolved === true, maxAlerts: 0, channel: typeof cfg.channel === 'string' ? cfg.channel : null, secret: null })
      })
      receivers.set(r.name, list)
    })
  }
  const root = compileRoute(c, doc.route, 'route', null, 0, new Set(receivers.keys()), { routes: 0 })
  const inhibit: InhibitRule[] = []
  if (doc.inhibit_rules !== undefined) {
    if (!Array.isArray(doc.inhibit_rules) || doc.inhibit_rules.length > 64) c.err('inhibit_rules', 'inhibit_rules must be a list of at most 64 rules', 'List the inhibition rules.')
    else {
      ;(doc.inhibit_rules as unknown[]).forEach((raw, i) => {
        const p = `inhibit_rules[${i}]`
        const r = raw as InhibitRuleInput
        if (!isObject(r)) return c.err(p, 'an inhibit rule must be an object', 'Give source_match, target_match and equal.')
        const source = compileMatchers(c, `${p}.source_match`, r.source_match, r.source_match_re, r.source_matchers)
        const target = compileMatchers(c, `${p}.target_match`, r.target_match, r.target_match_re, r.target_matchers)
        if (source.length === 0) c.err(`${p}.source_match`, 'an inhibit rule needs source matchers', 'Say which alerts inhibit.')
        if (target.length === 0) c.err(`${p}.target_match`, 'an inhibit rule needs target matchers', 'Say which alerts are inhibited.')
        const equal = r.equal === undefined ? [] : r.equal
        if (!Array.isArray(equal) || equal.some((x) => typeof x !== 'string' || !LABEL_NAME_RE.test(x))) return c.err(`${p}.equal`, 'equal must be a list of label names', 'Write e.g. ["cluster"].')
        inhibit.push({ source, target, equal })
      })
    }
  }
  const d = isObject(doc.delivery) ? doc.delivery : {}
  const maxAttempts = d.max_attempts === undefined ? 8 : d.max_attempts
  if (typeof maxAttempts !== 'number' || !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 50) c.err('delivery.max_attempts', 'max_attempts must be an integer from 1 to 50', 'Use e.g. 8.')
  const delivery: Delivery = {
    maxAttempts: typeof maxAttempts === 'number' ? maxAttempts : 8,
    baseBackoffMs: duration(c, d.base_backoff, 'delivery.base_backoff', 1000, 1),
    maxBackoffMs: duration(c, d.max_backoff, 'delivery.max_backoff', 5 * 60_000, 1),
    timeoutMs: duration(c, d.timeout, 'delivery.timeout', 10_000, 100),
  }
  if (doc.external_url !== undefined && typeof doc.external_url !== 'string') c.err('external_url', 'external_url must be a string', 'Give the URL of the alerting UI.')
  if (c.errors.length > 0 || !root) return { ok: false, errors: c.errors }
  let maxGroupIntervalMs = 0
  const visit = (r: Route) => {
    maxGroupIntervalMs = Math.max(maxGroupIntervalMs, r.groupIntervalMs)
    r.routes.forEach(visit)
  }
  visit(root)
  // A rule can name its receiver directly with the `viz_receiver` label (a monitor's
  // "notify"). Those alerts are routed here, ahead of the tree, with the root's grouping
  // and timing. Alerts without the label never match, so the tree behaves as written.
  const direct: Route[] = [...receivers.keys()].map((name) => ({
    key: `{}/{${RECEIVER_LABEL}=${JSON.stringify(name)}}/viz`,
    receiver: name,
    groupBy: root.groupBy,
    matchers: [{ name: RECEIVER_LABEL, value: name, re: null, equal: true }],
    continue: false,
    groupWaitMs: root.groupWaitMs,
    groupIntervalMs: root.groupIntervalMs,
    repeatIntervalMs: root.repeatIntervalMs,
    routes: [],
  }))
  root.routes = [...direct, ...root.routes]
  return { ok: true, config: { root, receivers, inhibit, externalUrl: typeof doc.external_url === 'string' ? doc.external_url : '', delivery, maxGroupIntervalMs } }
}

/**
 * The routes an alert is delivered through (alertmanager/dispatch/route.go `Match`):
 * depth first; the first matching child wins unless it says `continue`; a route with no
 * matching child handles the alert itself.
 */
export function matchRoutes(route: Route, labels: Labels): Route[] {
  if (!matchesAll(route.matchers, labels)) return []
  const all: Route[] = []
  for (const child of route.routes) {
    const m = matchRoutes(child, labels)
    for (const r of m) all.push(r)
    if (m.length > 0 && !child.continue) break
  }
  if (all.length === 0) all.push(route)
  return all
}

/** The labels a route groups an alert by: only those the alert actually has. */
export function groupLabels(route: Route, labels: Labels): Labels {
  const out: Labels = {}
  const names = route.groupBy === 'all' ? Object.keys(labels).sort() : route.groupBy
  for (const n of names) {
    const v = labelValue(labels, n)
    if (v !== '') out[n] = v
  }
  return out
}

/** `<route key>:{a="b",c="d"}`, Alertmanager's group key shape. */
export function groupKey(route: Route, group: Labels): string {
  return `${route.key}:{${Object.keys(group).sort().map((n) => `${n}=${JSON.stringify(group[n])}`).join(',')}}`
}

/**
 * Is `target` inhibited by any of `sources` (the firing alerts)?
 * alertmanager/inhibit/inhibit.go: a source inhibits when the rule's source matchers match
 * it, the target matchers match the target, and both carry the same value for every
 * `equal` label (a label missing on both counts as equal). An alert that matches both
 * sides of a rule cannot be inhibited by a source that also matches both sides, which
 * stops an alert from inhibiting itself.
 */
export function inhibitedBy(rules: InhibitRule[], target: Labels, sources: Iterable<{ fingerprint: string; labels: Labels }>): string | null {
  let list: { fingerprint: string; labels: Labels }[] | null = null
  for (const rule of rules) {
    if (!matchesAll(rule.target, target)) continue
    const targetIsAlsoSource = matchesAll(rule.source, target)
    list ??= [...sources]
    for (const s of list) {
      if (!matchesAll(rule.source, s.labels)) continue
      if (targetIsAlsoSource && matchesAll(rule.target, s.labels)) continue
      let equal = true
      for (const n of rule.equal) {
        if (n === "\u0000") {
          equal = false
          break
        }
      }
      if (equal) return s.fingerprint
    }
  }
  return null
}

export interface CompiledSilence {
  id: string
  matchers: Matcher[]
  startsAt: number
  endsAt: number
}

export function compileSilenceMatchers(ms: SilenceMatcher[]): Matcher[] {
  return ms.map((m) => ({ name: m.name, value: m.value, re: m.isRegex ? anchored(m.value) : null, equal: m.isEqual !== false }))
}

export function validateSilence(input: unknown, now: number): ValidationError[] {
  const c = new Ctx()
  if (!isObject(input)) return [{ path: '', message: 'a silence must be an object', fix: 'Send matchers, startsAt, endsAt, createdBy and comment.' }]
  const s = input as unknown as SilenceInput
  if (!Array.isArray(s.matchers) || s.matchers.length === 0) c.err('matchers', 'a silence needs at least one matcher', 'Add a matcher such as { "name": "alertname", "value": "X", "isRegex": false }.')
  else if (s.matchers.length > 32) c.err('matchers', 'more than 32 matchers', 'Remove matchers.')
  else {
    let matchesEmpty = true
    s.matchers.forEach((m, i) => {
      const p = `matchers[${i}]`
      if (!isObject(m) || typeof m.name !== 'string' || !LABEL_NAME_RE.test(m.name)) return c.err(`${p}.name`, 'matcher name must be a label name', 'Label names contain only letters, digits and underscores.')
      if (typeof m.value !== 'string') return c.err(`${p}.value`, 'matcher value must be a string', 'Quote the value.')
      if (typeof m.isRegex !== 'boolean') return c.err(`${p}.isRegex`, 'isRegex must be true or false', 'Say whether the value is a regular expression.')
      try {
        const [compiled] = compileSilenceMatchers([m])
        if (compiled && !matches(compiled, {})) matchesEmpty = false
      } catch (e) {
        c.err(`${p}.value`, `invalid regex: ${e instanceof Error ? e.message : String(e)}`, 'Fix the regular expression.')
      }
    })
    if (matchesEmpty && c.errors.length === 0) c.err('matchers', 'the matchers would match alerts with no labels at all', 'Add a matcher that requires a non-empty label value.')
  }
  if (!Number.isFinite(s.startsAt) || !Number.isFinite(s.endsAt)) c.err('endsAt', 'startsAt and endsAt must be Unix milliseconds', 'Give both times as numbers.')
  else {
    if (s.endsAt <= s.startsAt) c.err('endsAt', 'endsAt must be after startsAt', 'Extend the silence.')
    if (s.endsAt <= now) c.err('endsAt', 'the silence has already ended', 'Choose an end time in the future.')
  }
  if (typeof s.createdBy !== 'string' || s.createdBy === '' || s.createdBy.length > 256) c.err('createdBy', 'createdBy is required (at most 256 characters)', 'Say who is creating the silence.')
  if (typeof s.comment !== 'string' || s.comment === '' || s.comment.length > 4096) c.err('comment', 'comment is required (at most 4096 characters)', 'Say why the alerts are silenced.')
  return c.errors
}

/** Ids of the silences muting `labels` at time `at`. */
export function silencedBy(silences: Iterable<CompiledSilence>, labels: Labels, at: number): string[] {
  const out: string[] = []
  for (const s of silences) if (s.startsAt <= at && at < s.endsAt && matchesAll(s.matchers, labels)) out.push(s.id)
  return out
}

/** Who a receiver is and how it notifies, with nothing secret in it. */
export function receiverSummary(config: CompiledConfig, name: string): ReceiverSummary {
  return { name, integrations: (config.receivers.get(name) ?? []).map((i) => ({ kind: i.kind, channel: i.channel, signed: i.secret !== null })) }
}

const REDACTED = '\u2026'

function redactUrl(v: unknown, whole: boolean): unknown {
  if (typeof v !== 'string') return v
  try {
    const u = new URL(v)
    if (whole) return `${u.origin}/${REDACTED}`
    if (u.username === '' && u.password === '' && u.search === '') return v
    return `${u.origin}${u.pathname}${u.search === '' ? '' : `?${REDACTED}`}`
  } catch {
    return REDACTED
  }
}

const isRedacted = (v: unknown): boolean => typeof v === 'string' && v.endsWith(REDACTED)

type RawReceiver = { name?: unknown; webhook_configs?: unknown; slack_configs?: unknown }
const configs = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isObject) : [])

/**
 * The stored config as it may be shown: webhook secrets become `has_secret`, credentials
 * in a webhook URL and the whole path of a Slack URL (it IS the credential) are cut.
 */
export function redactConfig(stored: unknown): unknown {
  if (!isObject(stored)) return stored
  const out = JSON.parse(JSON.stringify(stored)) as Record<string, unknown>
  for (const r of Array.isArray(out.receivers) ? (out.receivers as RawReceiver[]) : []) {
    for (const w of configs(r?.webhook_configs)) {
      const had = typeof w.secret === 'string' && w.secret !== ''
      delete w.secret
      w.has_secret = had
      w.url = redactUrl(w.url, false)
    }
    for (const sl of configs(r?.slack_configs)) sl.api_url = redactUrl(sl.api_url, true)
  }
  return out
}

/**
 * A config about to be saved, completed from the stored one: a webhook with no `secret`
 * field keeps the secret stored for the same receiver and position, and a URL sent back in
 * its redacted form keeps the stored URL. `secret: ""` removes a secret.
 */
export function keepSecrets(incoming: unknown, stored: unknown): unknown {
  if (!isObject(incoming)) return incoming
  const out = JSON.parse(JSON.stringify(incoming)) as Record<string, unknown>
  const old = new Map<string, RawReceiver>()
  if (isObject(stored) && Array.isArray(stored.receivers)) for (const r of stored.receivers as RawReceiver[]) if (isObject(r) && typeof r.name === 'string') old.set(r.name, r)
  for (const r of Array.isArray(out.receivers) ? (out.receivers as RawReceiver[]) : []) {
    if (!isObject(r)) continue
    const before = typeof r.name === 'string' ? old.get(r.name) : undefined
    configs(r.webhook_configs).forEach((w, i) => {
      const was = configs(before?.webhook_configs)[i]
      delete w.has_secret
      if (isRedacted(w.url) && was) w.url = was.url
      if (w.secret === undefined && was && typeof was.secret === 'string' && was.url === w.url) w.secret = was.secret
      if (w.secret === '') delete w.secret
    })
    configs(r.slack_configs).forEach((sl, i) => {
      const was = configs(before?.slack_configs)[i]
      if (isRedacted(sl.api_url) && was) sl.api_url = was.api_url
    })
  }
  return out
}
