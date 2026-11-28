/**
 * Monitors, as the views say them: the order of the list, each state as a mark and words, the
 * one time each event has, the history as sentences, the text forms, and the rules the two
 * actions follow (who may act, when an undo is still open, which answer may be painted).
 * Pure: the views and the tests use the same functions.
 */
import { ACK_SCOPE, type Monitor, type MonitorDocument, type MonitorFilter, type MonitorState, type TimelineEntry } from '../api/monitors'
import { LOCAL, spanWords, type Zone } from '../lib/timeInput'
import { inferUnit, type UnitId } from '../lib/units'

export interface MonitorsSearch {
  id?: string
  filter?: MonitorFilter
  from?: string
  to?: string
}

const FILTERS: MonitorFilter[] = ['all', 'attention', 'silenced']
const ID = /^(mon|r)_[0-9a-f]{16}$/
const SPEC = /^(now(-\d+[smhdwy])*|\d{10,14})$/

/** The address of the monitors views: `filter` for the list (the default, "attention", is left out), `id`, `from` and `to` for one monitor. */
export function parseMonitorsSearch(raw: Record<string, unknown>): MonitorsSearch {
  const out: MonitorsSearch = {}
  if (typeof raw.id === 'string' && ID.test(raw.id)) out.id = raw.id
  if (typeof raw.filter === 'string' && (FILTERS as string[]).includes(raw.filter) && raw.filter !== 'attention') out.filter = raw.filter as MonitorFilter
  for (const k of ['from', 'to'] as const) {
    const v = raw[k]
    const s = typeof v === 'number' ? String(v) : v
    if (typeof s === 'string' && SPEC.test(s)) out[k] = s
  }
  return out
}
export const filterOf = (s: MonitorsSearch): MonitorFilter => s.filter ?? 'attention'
/** The range around now a monitor's chart shows unless the address says otherwise. */
export const DEFAULT_RANGE = { from: 'now-3h', to: 'now' } as const

/** Attention first: what nobody has, then what someone has, then what is quiet (ruler: NEEDS_ATTENTION). */
const RANK: Record<MonitorState, number> = { firing: 0, no_data: 1, error: 2, pending: 3, warming: 4, unknown: 5, ok: 6 }
export const NEEDS_ATTENTION = new Set<MonitorState>(['firing', 'pending', 'no_data', 'error'])

/** Whether someone has the monitor: every firing alert acknowledged, or every alert silenced. */
export const handled = (m: Monitor) => m.acknowledged !== null || m.silencedUntil !== null

export function sortMonitors(list: readonly Monitor[]): Monitor[] {
  return [...list].sort((a, b) => RANK[a.state] - RANK[b.state] || Number(handled(a)) - Number(handled(b)) || (a.firingSince ?? a.activeAt ?? Infinity) - (b.firingSince ?? b.activeAt ?? Infinity) || a.name.localeCompare(b.name, 'en'))
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** One time for one event, everywhere: "13:07" today, "18 Nov 13:07" another day (with the year another year). To the minute. */
export function when(ms: number, nowMs: number, zone: Zone = LOCAL): string {
  const wall = (t: number) => new Date(t + zone.offsetMin(t) * 60_000)
  const d = wall(ms)
  const n = wall(nowMs)
  const hm = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
  if (d.getUTCFullYear() === n.getUTCFullYear() && d.getUTCMonth() === n.getUTCMonth() && d.getUTCDate() === n.getUTCDate()) return hm
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}${d.getUTCFullYear() === n.getUTCFullYear() ? '' : ` ${d.getUTCFullYear()}`} ${hm}`
}
/** How long, at most two parts: "2 h 9 min", "40 s". */
export const lasted = (ms: number) => spanWords(Math.max(1, Math.round(ms / 1000)) >= 60 ? Math.floor(ms / 60_000) * 60 : Math.max(1, Math.round(ms / 1000)))

/** A key as the API names who did something ("key:dana"), and "you" for this tab's key. */
export function who(by: string, me: string | null): string {
  return me !== null && by === me ? 'you' : by
}

export interface StatusWords {
  /** The status component's `data-state`: severity (critical, warn, ok, info), disposition (ack, silenced), or none (the dash: unknown). */
  mark: 'critical' | 'warn' | 'ok' | 'info' | 'ack' | 'silenced' | ''
  /** The word or words, never coloured; parts in `qty` are times or durations (`vz-qty`). */
  parts: { text: string; qty?: boolean }[]
}
const words = (mark: StatusWords['mark'], ...parts: (string | [string])[]): StatusWords => ({ mark, parts: parts.map((p) => (Array.isArray(p) ? { text: p[0], qty: true } : { text: p })) })
export const plain = (s: StatusWords) => s.parts.map((p) => p.text).join('')

/**
 * A monitor's state as the list says it, in its row: the mark and the words. Someone's
 * acknowledgement or silence takes the mark (neutral) and the row says both facts
 * ("Acknowledged, firing since 13:07"); the red marks are exactly the ones nobody has.
 * `page`: the monitor's own state line, which keeps its own words and only takes the mark.
 */
export function stateWords(m: Monitor, nowMs: number, page = false): StatusWords {
  const since = m.firingSince ?? m.activeAt
  const dur: (string | [string])[] = page && since !== null ? [' (', [lasted(nowMs - since)], ')'] : []
  const disposition: StatusWords['mark'] = m.silencedUntil !== null ? 'silenced' : m.acknowledged !== null ? 'ack' : ''
  const prefix: (string | [string])[] = page || !disposition ? [] : disposition === 'silenced' ? ['Silenced until ', [when(m.silencedUntil!, nowMs)] as [string], ', '] : ['Acknowledged, ']
  const lower = (s: string) => (prefix.length ? s[0]!.toLowerCase() + s.slice(1) : s)
  switch (m.state) {
    case 'firing':
      return words(disposition || 'critical', ...prefix, lower('Firing since '), [when(since!, nowMs)], ...dur)
    case 'no_data': {
      const firing = m.alerts.some((a) => a.state === 'firing')
      return words(disposition || (firing ? 'critical' : 'warn'), ...prefix, lower(`No data${firing ? ', firing' : ''} since `), [when(since ?? nowMs, nowMs)], ...dur)
    }
    case 'pending': {
      const fires = m.alerts.map((a) => a.firesAt).filter((t): t is number => t !== null)
      return words('warn', 'Pending since ', [when(since!, nowMs)], ...(fires.length ? ['. Fires at ', [when(Math.min(...fires), nowMs)] as [string], ' if it holds'] : []))
    }
    case 'error':
      // A monitor that cannot watch is not known to be firing: the unknown dash, with its words (o3; Status).
      return words('', 'Cannot be evaluated')
    case 'ok':
      return words('ok', 'Not firing')
    case 'warming':
      return words('info', 'Warming up')
    default:
      return words('', 'Not evaluated yet')
  }
}

/** Who is told, in words: "checkout-oncall (Slack #checkout-oncall)", or that nobody is. */
export function receiverWords(m: Monitor): string {
  if (m.notifies.length === 0) return m.notify ? `${m.notify} (not configured in the notifier)` : 'nobody: the monitor names no receiver'
  return m.notifies
    .map((r) => {
      const ways = r.integrations.map((i) => `${i.kind === 'slack' ? 'Slack' : i.kind === 'webhook' ? 'a webhook' : i.kind || 'an integration'}${i.channel ? ` ${i.channel}` : ''}`)
      return ways.length ? `${r.name} (${ways.join(', ')})` : r.name
    })
    .join(', ')
}

/** The API's words as a sentence on the page: a capital first, a full stop last (o5). */
export function sentence(text: string): string {
  const t = text.trim()
  if (t === '') return t
  return t[0]!.toUpperCase() + t.slice(1) + (/[.!?]$/.test(t) ? '' : '.')
}

/**
 * A message template as it was sent (o2): Prometheus's `{{ $value }}` (with `humanizePercentage`,
 * `humanizeDuration`, `humanize1024` or `humanize`) and `{{ $labels.<name> }}` filled in; null
 * when it holds anything else, which is then shown as the template it is.
 */
export function renderMessage(template: string, value: number | null, labels: Record<string, string>): string | null {
  let unread = false
  const out = template.replace(/\{\{\s*([^}]*?)\s*\}\}/g, (_, inner: string) => {
    const v = /^\$value(?:\s*\|\s*(humanizePercentage|humanizeDuration|humanize1024|humanize))?$/.exec(inner)
    if (v && value !== null) {
      const f = v[1]
      return f === 'humanizePercentage' ? unitValue(value, 'percentunit') : f === 'humanizeDuration' ? unitValue(value, 'seconds') : f === 'humanize1024' ? unitValue(value, 'bytes') : unitValue(value, 'none')
    }
    const l = /^\$labels\.([a-zA-Z_][a-zA-Z0-9_]*)$/.exec(inner)
    if (l && labels[l[1]!] !== undefined) return labels[l[1]!]!
    unread = true
    return ''
  })
  return unread ? null : out
}

// ---- the unit (M-M2 of the third design review)

/** The units a condition may name (ruler's `condition.unit`, free text), as the app's units. */
const CONDITION_UNIT: Record<string, UnitId> = { s: 'seconds', seconds: 'seconds', bytes: 'bytes', B: 'bytes', '/s': 'rps', '%': 'percent', percent: 'percent', ratio: 'percentunit', cores: 'cores', 'bytes/s': 'bytes/s', 'B/s': 'bytes/s' }

/** The index of the division at the top of an expression (outside every bracket and string), or -1. */
function topDivision(q: string): number {
  let depth = 0
  let quote: string | null = null
  for (let i = 0; i < q.length; i++) {
    const c = q[i]!
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = null
    } else if (c === '"' || c === "'" || c === '`') quote = c
    else if (c === '(' || c === '{' || c === '[') depth++
    else if (c === ')' || c === '}' || c === ']') depth--
    else if (c === '/' && depth === 0) return i
  }
  return -1
}
/** The metric names an expression reads (a name followed by its matchers or its range). */
const metricsOf = (q: string) => new Set([...q.replace(/"(?:[^"\\]|\\.)*"/g, '""').matchAll(/([a-zA-Z_:][a-zA-Z0-9_:]*)\s*[{[]/g)].map((m) => m[1]!))

/** A query that divides part of one metric by all of the same metric: a share, from 0 to 1 ("the 500s of all requests"). */
export function isShare(query: string): boolean {
  const at = topDivision(query)
  if (at < 0) return false
  const a = metricsOf(query.slice(0, at))
  const b = metricsOf(query.slice(at + 1))
  return a.size === 1 && b.size === 1 && [...a][0] === [...b][0]
}

/**
 * The unit of a monitor's values: the one its condition names; else the one its message
 * template formats its value in (`humanizePercentage` is a share, `humanizeDuration` seconds,
 * `humanize1024` bytes); else a share when its query divides part of a metric by all of it;
 * else what Explore's "Automatic" unit guesses from the query (lib/units `inferUnit`).
 */
export function monitorUnit(m: Pick<Monitor, 'condition' | 'message' | 'query' | 'expr'>): UnitId {
  const named = m.condition?.unit
  if (named && CONDITION_UNIT[named]) return CONDITION_UNIT[named]
  const msg = m.message ?? ''
  if (/\|\s*humanizePercentage\b/.test(msg)) return 'percentunit'
  if (/\|\s*humanizeDuration\b/.test(msg)) return 'seconds'
  if (/\|\s*humanize1024\b/.test(msg)) return 'bytes'
  const q = m.query ?? m.expr
  if (isShare(q)) return 'percentunit'
  return inferUnit(q)
}

const sig = (n: number, p = 3) => String(Number(n.toPrecision(p)))
const BINARY = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
function binary(v: number): string {
  let i = 0
  while (i < BINARY.length - 1 && Math.abs(v) >= 1024 ** (i + 1)) i++
  return `${sig(v / 1024 ** i)} ${BINARY[i]}`
}
/** A percentage as it is read: one decimal place, none when it is whole ("8.4%", "2%"), two digits when it is below 0.1. */
const percent = (n: number) => `${n !== 0 && Math.abs(n) < 0.1 ? sig(n, 2) : String(Number(n.toFixed(1)))}%`

/** A value in a unit, as the monitor's views write it everywhere: "8.4%", "312 ms", "1.5 GiB", "0.8/s". */
export function unitValue(v: number, unit: UnitId): string {
  switch (unit) {
    case 'percentunit':
      return percent(v * 100)
    case 'percent':
      return percent(v)
    case 'seconds': {
      const a = Math.abs(v)
      return a >= 1 || a === 0 ? `${sig(v)} s` : a >= 1e-3 ? `${sig(v * 1e3)} ms` : `${sig(v * 1e6)} µs`
    }
    case 'bytes':
      return binary(v)
    case 'bytes/s':
      return `${binary(v)}/s`
    case 'rps':
      return `${sig(v)}/s`
    case 'cores':
      return `${sig(v)} cores`
    default:
      return Math.abs(v) >= 1000 || (Math.abs(v) < 0.001 && v !== 0) ? v.toPrecision(3) : sig(v)
  }
}

/** A value as the history, the alerts and the list say it, in the monitor's unit. */
export function valueWords(v: number | null | undefined, m: Pick<Monitor, 'condition' | 'message' | 'query' | 'expr'>): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return 'no value'
  return unitValue(v, monitorUnit(m))
}

/** The threshold as the app writes it ("> 2% for 5 min", o1), from the condition; the ruler's text when there is no condition. */
export function thresholdWords(m: Pick<Monitor, 'condition' | 'message' | 'query' | 'expr' | 'forMs' | 'thresholdText'>, withFor = true): string | null {
  if (!m.condition) return m.thresholdText
  return `${m.condition.op} ${valueWords(m.condition.threshold, m)}${withFor && m.forMs > 0 ? ` for ${lasted(m.forMs)}` : ''}`
}

/** A condition's comparison after "Went". */
const OP_WORDS: Record<string, string> = { '>': 'above', '>=': 'to or above', '<': 'below', '<=': 'to or below', '==': 'to', '!=': 'away from' }

export interface HistoryLine {
  at: number
  mark: 'critical' | 'warn' | 'ok' | 'info' | 'ack' | 'silenced' | ''
  sentence: string
}

/** The merged history (oldest first from the API) as the timeline says it: newest first, a page about now. */
export function historyLines(doc: MonitorDocument, me: string | null): HistoryLine[] {
  const m = doc.monitor
  const out: HistoryLine[] = []
  for (const e of doc.history.entries) {
    const by = e.by ? who(e.by, me) : 'someone'
    const many = (e.fingerprints?.length ?? 0) > 1 ? ` (${e.fingerprints!.length} alerts)` : ''
    const line = (mark: HistoryLine['mark'], sentence: string) => out.push({ at: e.at, mark, sentence })
    switch (e.kind) {
      case 'created':
        line('info', `Created by ${by}.`)
        break
      case 'edited':
        line('info', `Changed by ${by}.`)
        break
      case 'pending':
        // "Went above 2% (8.4%)": the comparison as a word where the sentence's verb takes it (review round 4, n-o5).
        line('warn', e.noData ? 'No data. Pending.' : `Went ${m.condition ? `${OP_WORDS[m.condition.op] ?? m.condition.op} ${valueWords(m.condition.threshold, m)}` : 'past the condition'} (${valueWords(e.value, m)}). Pending${m.forMs ? ` for ${lasted(m.forMs)}` : ''}.`)
        break
      case 'firing':
        line('critical', e.noData ? 'Fired: no data.' : `Fired at ${valueWords(e.value, m)}.`)
        break
      case 'resolved':
        line('ok', 'Resolved.')
        break
      case 'cleared':
        line('ok', 'Cleared before it fired.')
        break
      case 'notified':
        line('info', `${e.status === 'resolved' ? 'Told' : e.repeat ? 'Reminded' : 'Notified'} ${e.receiver ?? 'a receiver'}${e.channel ? ` in ${e.channel}` : ''}${e.status === 'resolved' ? ' that it resolved' : ''}${e.failed ? `. Delivery failed: ${e.failed}` : e.deliveredAt ? '' : '. Not delivered yet'}.`)
        break
      case 'acknowledged':
        line('ack', `Acknowledged by ${by}${many}. Repeats stop until it resolves.`)
        break
      case 'unacknowledged':
        line('info', `Acknowledgement taken back by ${by}${many}. Repeats resume.`)
        break
      case 'silenced':
        line('silenced', `Silenced by ${by} until ${e.until ? when(e.until, doc.nowMs) : 'a later time'}.`)
        break
      case 'silence_undone':
        line('info', `Silence undone by ${by}, as if it was never made.`)
        break
      case 'silence_expired':
        line('info', `Silence ended by ${by}.`)
        break
      default:
        line('', `${e.kind}.`)
    }
  }
  return out.reverse()
}

/** The last silence of this monitor's history, for who silenced it. */
export function lastSilencer(doc: MonitorDocument): string | null {
  for (let i = doc.history.entries.length - 1; i >= 0; i--) {
    const e = doc.history.entries[i]!
    if (e.kind === 'silenced') return e.by ?? null
    if (e.kind === 'silence_undone' || e.kind === 'silence_expired') return null
  }
  return null
}
/** The definition's last change (created or edited) from the history: the list API does not carry it. */
export function lastChange(entries: readonly TimelineEntry[]): TimelineEntry | null {
  for (let i = entries.length - 1; i >= 0; i--) if (entries[i]!.kind === 'created' || entries[i]!.kind === 'edited') return entries[i]!
  return null
}

/** Whether this tab's key may act: true, false, or null when the API has not said what the key may do. */
export function mayAct(scopes: readonly string[] | null): boolean | null {
  return scopes === null ? null : scopes.includes(ACK_SCOPE)
}

/** An undo the API gave: open while the API's clock (estimated from this tab's) is before `undoUntil`. */
export interface Undo {
  monitor: string
  token: string
  /** The API's time (ms) the window closes. */
  undoUntil: number
  /** What the silences end at. */
  until: number | null
  /** The API's clock minus this tab's when the token arrived. */
  skewMs: number
}
export function undoOpen(u: Undo | null, monitorId: string, localNowMs: number): boolean {
  return u !== null && u.monitor === monitorId && localNowMs + u.skewMs < u.undoUntil
}
/** Milliseconds of the window left, by this tab's clock. */
export const undoLeftMs = (u: Undo, localNowMs: number) => Math.max(0, u.undoUntil - (localNowMs + u.skewMs))

/**
 * Reads and writes of one monitor: a read that started before the latest write began or ended
 * describes the monitor as it was, so its answer is not painted (the read after the write is).
 */
export class ReadGuard {
  private generation = 0
  /** A write starts or ends: every read in flight is superseded. */
  bump(): void {
    this.generation++
  }
  /** Stamp a read as it starts; `current(stamp)` says whether its answer may be painted. */
  stamp(): number {
    return this.generation
  }
  current(stamp: number): boolean {
    return stamp === this.generation
  }
}

/** The list as text: the same facts as its rows. */
export function listText(list: readonly Monitor[], filter: MonitorFilter, total: number, nowMs: number): string {
  const head = filter === 'all' ? `${total} monitors, attention first.` : filter === 'attention' ? `${list.length} of ${total} monitors need attention, firing first.` : `${list.length} of ${total} monitors are silenced.`
  const rows = list.map((m) => `${m.name}: ${plain(stateWords(m, nowMs))}. Threshold ${thresholdWords(m) ?? 'none'}. Owner ${m.owner || 'nobody'}. Notifies ${receiverWords(m)}.`)
  return [head, ...rows].join('\n')
}

/** One monitor as text: the head, the definition, the alerts and the history, in that order. */
export function monitorText(doc: MonitorDocument, me: string | null, nowMs: number, done: string | null): string {
  const m = doc.monitor
  const lines = [`${m.name}. ${plain(stateWords(m, nowMs, true))}.${done ? ` ${done}.` : ''}`]
  if (m.message) lines.push(`${m.message.includes('{{') ? 'Message template' : 'Message'}: ${m.message}`)
  if (m.description) lines.push(`Description: ${m.description}`)
  lines.push(`Query: ${m.query ?? m.expr}`)
  lines.push(`Threshold: ${thresholdWords(m) ?? 'none (the query is the condition)'}. Evaluated every ${lasted(m.intervalMs || 60_000)}${m.lastEvaluationMs ? `, last at ${when(m.lastEvaluationMs, nowMs)}` : ''}.`)
  lines.push(`Notifies ${receiverWords(m)}. Owner ${m.owner || 'nobody'}.${m.runbookUrl ? ` Runbook ${m.runbookUrl}.` : ''}`)
  if (m.lastError) lines.push(`Last error: ${m.lastError}`)
  lines.push(m.alerts.length ? `${m.alerts.length} alert${m.alerts.length === 1 ? '' : 's'}:` : 'No alerts.')
  for (const a of m.alerts) {
    const labels = Object.entries(a.labels).map(([k, v]) => `${k}=${v}`).join(', ')
    lines.push(`- ${a.state === 'firing' ? 'Firing' : 'Pending'} since ${when(a.firingSince ?? a.activeAt, nowMs)}, ${a.noData ? 'no data' : valueWords(a.value, m)}. ${a.acknowledged ? `Acknowledged by ${who(a.acknowledged.by, me)} at ${when(a.acknowledged.at, nowMs)}.` : 'Not acknowledged.'}${a.silencedUntil ? ` Silenced until ${when(a.silencedUntil, nowMs)}.` : ''} Labels: ${labels}.`)
  }
  const hist = historyLines(doc, me)
  lines.push(`History, newest first${doc.history.dropped ? ` (${doc.history.dropped} older entries were dropped by the API)` : ''}:`)
  for (const h of hist) lines.push(`- ${when(h.at, nowMs)} ${h.sentence}`)
  return lines.join('\n')
}
