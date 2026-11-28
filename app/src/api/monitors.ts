/**
 * The ruler's monitors API (ruler/README.md, "2. HTTP API"; ruler/openapi.json), as this app
 * reads and writes it: the list, one monitor with its history, and the two on-call actions,
 * acknowledge (and its opposite) and silence for a duration with its undo.
 *
 * Every request goes through the app's one client (`PromClient.json`): the key in the
 * Authorization header and nowhere else, the page's limit of six requests in flight. `dryRun`
 * is never sent: the UI acts or it does not.
 */
import { PromApiError, type PromClient, type RequestOptions } from './client'

export const MONITOR_STATES = ['firing', 'pending', 'no_data', 'error', 'ok', 'unknown', 'warming'] as const
export type MonitorState = (typeof MONITOR_STATES)[number]
export type MonitorFilter = 'all' | 'attention' | 'silenced'

/** The scope the two actions need (ruler/src/http.ts ROUTES). */
export const ACK_SCOPE = 'monitors:ack'
export const READ_SCOPE = 'monitors:read'

export interface Acknowledgement {
  by: string
  at: number
}
export interface Receiver {
  name: string
  integrations: { kind?: string; channel?: string | null; signed?: boolean }[]
}
export interface MonitorAlert {
  fingerprint: string
  labels: Record<string, string>
  state: 'pending' | 'firing'
  activeAt: number
  firingSince: number | null
  firesAt: number | null
  value: number | null
  noData: boolean
  acknowledged: Acknowledgement | null
  silencedUntil: number | null
  lastNotifiedAt: number | null
  nextRepeatAt: number | null
  handedOff: boolean
}
export interface Monitor {
  id: string
  name: string
  state: MonitorState
  firingSince: number | null
  activeAt: number | null
  value: number | null
  thresholdText: string | null
  expr: string
  query: string | null
  condition: { op: string; threshold: number; unit?: string } | null
  forMs: number
  intervalMs: number
  description: string
  message: string
  runbookUrl: string
  owner: string
  notify: string | null
  notifies: Receiver[]
  noData: string
  noDataForMs: number
  health: string
  lastError: string | null
  lastEvaluationMs: number | null
  acknowledged: Acknowledgement | null
  silencedUntil: number | null
  alerts: MonitorAlert[]
}
export interface MonitorList {
  monitors: Monitor[]
  counts: Record<string, number>
  total: number
  lastEvaluationMs: number | null
  nowMs: number
}
export interface TimelineEntry {
  at: number
  source: 'ruler' | 'notifier'
  kind: string
  by?: string
  fingerprint?: string
  fingerprints?: string[]
  labels?: Record<string, string>
  value?: number | null
  noData?: boolean
  receiver?: string
  integration?: string
  channel?: string | null
  status?: string
  repeat?: boolean
  deliveredAt?: number | null
  failed?: string | null
  until?: number
  silenceIds?: string[]
}
export interface MonitorDocument {
  monitor: Monitor
  history: { entries: TimelineEntry[]; dropped: number }
  nowMs: number
}
export interface AckResult {
  id: string
  fingerprints: string[]
  by: string
  at: number
}
export interface SilenceResult {
  id: string
  silenced: string[]
  /** When the silences end (the earliest of them), from the answer's silences. */
  until: number | null
  /** Returned once by the API, valid until `undoUntil`; null when nothing was silenced. */
  undoToken: string | null
  undoUntil: number | null
}

/**
 * A refusal by the ruler: viz's error body `{error: {code, message}, problems?}`. `errorType`
 * is the code ("forbidden", "undo_expired", "not_found"), the message the ruler's own words.
 */
export class RulerApiError extends PromApiError {
  readonly problems: { path: string; message: string; fix: string }[]
  constructor(code: string, message: string, status: number, problems: { path: string; message: string; fix: string }[] = [], retryAfterMs: number | null = null) {
    super(code, message, status, retryAfterMs)
    this.name = 'RulerApiError'
    this.problems = problems
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

function readAck(v: unknown): Acknowledgement | null {
  return isObject(v) && typeof v.by === 'string' && typeof v.at === 'number' ? { by: v.by, at: v.at } : null
}
function readLabels(v: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (isObject(v)) for (const [k, x] of Object.entries(v)) if (typeof x === 'string') out[k] = x
  return out
}
function readAlert(v: unknown): MonitorAlert | null {
  if (!isObject(v) || typeof v.fingerprint !== 'string' || (v.state !== 'pending' && v.state !== 'firing') || typeof v.activeAt !== 'number') return null
  return {
    fingerprint: v.fingerprint,
    labels: readLabels(v.labels),
    state: v.state,
    activeAt: v.activeAt,
    firingSince: num(v.firingSince),
    firesAt: num(v.firesAt),
    value: num(v.value),
    noData: v.noData === true,
    acknowledged: readAck(v.acknowledged),
    silencedUntil: num(v.silencedUntil),
    lastNotifiedAt: num(v.lastNotifiedAt),
    nextRepeatAt: num(v.nextRepeatAt),
    handedOff: v.handedOff === true,
  }
}
/** A monitor as the API answered it, or null when the answer is not one. */
export function readMonitor(v: unknown): Monitor | null {
  if (!isObject(v) || typeof v.id !== 'string' || typeof v.name !== 'string' || typeof v.expr !== 'string' || !Array.isArray(v.alerts)) return null
  const state = (MONITOR_STATES as readonly string[]).includes(v.state as string) ? (v.state as MonitorState) : 'unknown'
  const alerts: MonitorAlert[] = []
  for (const a of v.alerts) {
    const r = readAlert(a)
    if (!r) return null
    alerts.push(r)
  }
  const c = isObject(v.condition) && typeof v.condition.op === 'string' && typeof v.condition.threshold === 'number' ? { op: v.condition.op, threshold: v.condition.threshold, ...(typeof v.condition.unit === 'string' && v.condition.unit ? { unit: v.condition.unit } : {}) } : null
  return {
    id: v.id,
    name: v.name,
    state,
    firingSince: num(v.firingSince),
    activeAt: num(v.activeAt),
    value: num(v.value),
    thresholdText: typeof v.thresholdText === 'string' ? v.thresholdText : null,
    expr: v.expr,
    query: typeof v.query === 'string' ? v.query : null,
    condition: c,
    forMs: num(v.forMs) ?? 0,
    intervalMs: num(v.intervalMs) ?? 0,
    description: str(v.description),
    message: str(v.message),
    runbookUrl: str(v.runbookUrl),
    owner: str(v.owner),
    notify: typeof v.notify === 'string' ? v.notify : null,
    notifies: Array.isArray(v.notifies)
      ? v.notifies.filter(isObject).map((r) => ({ name: str(r.name), integrations: Array.isArray(r.integrations) ? r.integrations.filter(isObject).map((i) => ({ kind: str(i.kind), channel: typeof i.channel === 'string' ? i.channel : null, signed: i.signed === true })) : [] }))
      : [],
    noData: str(v.noData) || 'ok',
    noDataForMs: num(v.noDataForMs) ?? 0,
    health: str(v.health) || 'unknown',
    lastError: typeof v.lastError === 'string' ? v.lastError : null,
    lastEvaluationMs: num(v.lastEvaluationMs),
    acknowledged: readAck(v.acknowledged),
    silencedUntil: num(v.silencedUntil),
    alerts,
  }
}
function readEntry(v: unknown): TimelineEntry | null {
  if (!isObject(v) || typeof v.at !== 'number' || (v.source !== 'ruler' && v.source !== 'notifier') || typeof v.kind !== 'string') return null
  return { ...(v as unknown as TimelineEntry), labels: v.labels === undefined ? undefined : readLabels(v.labels) }
}

const bad = (what: string, status: number) => new PromApiError('parse', `The answer is not ${what}`, status)

/** The answer's JSON, or the ruler's refusal as a `RulerApiError` (another body: `PromApiError` 'http'). */
async function call(client: PromClient, method: 'GET' | 'POST', path: string, body: unknown, opts?: RequestOptions): Promise<unknown> {
  const r = await client.json(method, path, body, opts)
  if (r.status >= 200 && r.status < 300) {
    if (!isObject(r.body)) throw bad('JSON', r.status)
    return r.body
  }
  const e = isObject(r.body) && isObject(r.body.error) ? r.body.error : null
  if (e && typeof e.code === 'string' && typeof e.message === 'string') {
    const problems = isObject(r.body) && Array.isArray(r.body.problems) ? r.body.problems.filter(isObject).map((p) => ({ path: str(p.path), message: str(p.message), fix: str(p.fix) })) : []
    throw new RulerApiError(e.code, e.message, r.status, problems, r.retryAfterMs)
  }
  throw new PromApiError('http', `HTTP ${r.status} ${r.statusText}`.trim(), r.status, r.retryAfterMs)
}

const PATH = '/api/v1/monitors'
const one = (id: string) => `${PATH}/${encodeURIComponent(id)}`

/** `GET /api/v1/monitors?filter=…` (monitors:read). */
export async function listMonitors(client: PromClient, filter: MonitorFilter, opts?: RequestOptions): Promise<MonitorList> {
  const v = (await call(client, 'GET', `${PATH}?filter=${filter}`, undefined, opts)) as Record<string, unknown>
  if (!Array.isArray(v.monitors) || typeof v.total !== 'number') throw bad('a list of monitors', 200)
  const monitors: Monitor[] = []
  for (const m of v.monitors) {
    const r = readMonitor(m)
    if (!r) throw bad('a list of monitors', 200)
    monitors.push(r)
  }
  const counts: Record<string, number> = {}
  if (isObject(v.counts)) for (const [k, n] of Object.entries(v.counts)) if (typeof n === 'number') counts[k] = n
  return { monitors, counts, total: v.total, lastEvaluationMs: num(v.lastEvaluationMs), nowMs: num(v.nowMs) ?? Date.now() }
}

/** `GET /api/v1/monitors/{id}` (monitors:read): the monitor and its merged history, oldest first. */
export async function getMonitor(client: PromClient, id: string, opts?: RequestOptions): Promise<MonitorDocument> {
  const v = (await call(client, 'GET', one(id), undefined, opts)) as Record<string, unknown>
  const monitor = readMonitor(v.monitor)
  const h = isObject(v.history) ? v.history : null
  if (!monitor || !h || !Array.isArray(h.entries)) throw bad('a monitor', 200)
  const entries: TimelineEntry[] = []
  for (const e of h.entries) {
    const r = readEntry(e)
    if (r) entries.push(r)
  }
  return { monitor, history: { entries, dropped: num(h.dropped) ?? 0 }, nowMs: num(v.nowMs) ?? Date.now() }
}

/** `POST …/acknowledge` or `…/unacknowledge` (monitors:ack): every firing alert, or the one named. */
export async function setAcknowledged(client: PromClient, id: string, on: boolean, fingerprint?: string, opts?: RequestOptions): Promise<AckResult> {
  const v = (await call(client, 'POST', `${one(id)}/${on ? 'acknowledge' : 'unacknowledge'}`, fingerprint ? { fingerprint } : {}, opts)) as Record<string, unknown>
  const list = v[on ? 'acknowledged' : 'unacknowledged']
  if (typeof v.by !== 'string' || typeof v.at !== 'number' || !Array.isArray(list)) throw bad('an acknowledgement', 200)
  return { id: str(v.id), fingerprints: list.filter((x): x is string => typeof x === 'string'), by: v.by, at: v.at }
}

/** `POST …/silence` (monitors:ack): one silence per firing alert for `duration` (a Prometheus duration, "1h"). */
export async function silenceMonitor(client: PromClient, id: string, duration: string, opts?: RequestOptions): Promise<SilenceResult> {
  const v = (await call(client, 'POST', `${one(id)}/silence`, { duration }, opts)) as Record<string, unknown>
  if (!Array.isArray(v.silenced)) throw bad('a silence', 200)
  const ends = Array.isArray(v.silences) ? v.silences.filter(isObject).map((s) => num(s.endsAt)).filter((x): x is number => x !== null) : []
  return {
    id: str(v.id),
    silenced: v.silenced.filter((x): x is string => typeof x === 'string'),
    until: ends.length ? Math.min(...ends) : null,
    undoToken: typeof v.undoToken === 'string' && v.undoToken !== '' ? v.undoToken : null,
    undoUntil: num(v.undoUntil),
  }
}

/** `POST /api/v1/monitors/silences/undo` (monitors:ack): the silences of one silence call, as if never made. 410 after the window. */
export async function undoSilence(client: PromClient, undoToken: string, opts?: RequestOptions): Promise<string[]> {
  const v = (await call(client, 'POST', `${PATH}/silences/undo`, { undoToken }, opts)) as Record<string, unknown>
  return Array.isArray(v.removed) ? v.removed.filter((x): x is string => typeof x === 'string') : []
}
