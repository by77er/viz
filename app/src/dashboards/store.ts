/**
 * What each panel of the dashboard on screen holds, and the requests that fill it.
 *
 * One store per dashboard page. Every request goes through the app's API client (`PromClient`)
 * and through one `Limiter` (six in flight, in total); a load is one generation of a `Loader`
 * (scheduler.ts), so a change of range or of a variable cancels what is in flight and nothing it
 * still answers is ever put into a panel.
 *
 * A panel's state is an immutable object, replaced when it changes, and each panel subscribes
 * to its own: an answer for one panel renders that panel and nothing else.
 */
import type { PromClient } from '../api/client'
import type { PromQueryData } from '../api/types'
import type { SampleColumns } from '../lib/series'
import type { QueryWindow } from '../lib/step'
import type { ResolvedDashboard } from './model'
import { Limiter, Loader, type PanelOutcome, type PanelRequest } from './scheduler'

/** A panel's answer, with what it answers: the dashboard as it was resolved (queries, variables) and the window. Everything a panel says about its data comes from here. */
export interface PanelResult {
  data: Record<string, readonly SampleColumns[]>
  resolved: ResolvedDashboard
  window: QueryWindow
  /** Epoch ms. */
  receivedAt: number
}

export interface PanelState {
  /** Requests for what the page now asks are waiting. */
  waiting: boolean
  /** When that wait began (`performance.now()`), for the waiting line. */
  since: number
  /** The last answer drawn. While `stale`, it answers an earlier range or earlier variable values. */
  result: PanelResult | null
  stale: boolean
  /** Why the current question has no answer: the API's refusal, a failure, or a query that cannot be sent. */
  error: unknown
  /** The wait was ended by the person (`cancelled`) or by the 60 s stop (`stopped`). */
  halted: 'cancelled' | 'stopped' | null
}

/** How far the current load is, in panels: a real numerator and denominator. */
export interface LoadSummary {
  total: number
  answered: number
  failed: number
  waiting: number
}

const IDLE: PanelState = { waiting: false, since: 0, result: null, stale: false, error: null, halted: null }
/** The waiting table's last row: stop, keep what arrived, and say so. */
export const STOP_AFTER_MS = 60_000

/** A query that is not sent: the model could not write it, or it is not PromQL. */
export class NotSent extends Error {}

/** An instant query's answer as series of one sample each. */
function columnsOf(data: PromQueryData): SampleColumns[] {
  if (data.resultType === 'matrix') return data.result.map((s) => ({ metric: s.metric, times: s.values.map((v) => v[0]), values: s.values.map((v) => Number(v[1])) }))
  if (data.resultType === 'vector') return data.result.map((s) => ({ metric: s.metric, times: [s.value[0]], values: [Number(s.value[1])] }))
  if (data.resultType === 'scalar') return [{ metric: {}, times: [data.result[0]], values: [Number(data.result[1])] }]
  return []
}

export class DashboardStore {
  readonly limiter = new Limiter()
  private readonly client: PromClient
  private readonly loader: Loader<readonly SampleColumns[]>
  private readonly states = new Map<string, PanelState>()
  private readonly listeners = new Map<string, Set<() => void>>()
  private readonly summaryListeners = new Set<() => void>()
  private readonly panelControllers = new Map<string, AbortController>()
  private current: { resolved: ResolvedDashboard; window: QueryWindow; question: string } | null = null
  private summaryNow: LoadSummary = { total: 0, answered: 0, failed: 0, waiting: 0 }
  private stopTimer: ReturnType<typeof setTimeout> | null = null

  constructor(client: PromClient) {
    this.client = client
    this.loader = new Loader<readonly SampleColumns[]>(this.limiter, (panel, outcome) => this.deliver(panel, outcome))
  }

  /** The signal of the load in progress: other requests of the page (a variable's values) are cancelled with it. */
  get signal(): AbortSignal | null {
    return this.loader.signal
  }

  /**
   * Asks every panel for `resolved` over `window`. `question` names what is asked apart from the
   * moment (the dashboard's revision, the range as written, the variable values): while it
   * differs from the question a panel's drawn answer belongs to, that answer is `stale`.
   */
  load(resolved: ResolvedDashboard, window: QueryWindow, question: string): void {
    const previous = this.current
    this.current = { resolved, window, question }
    const now = performance.now()
    const requests: PanelRequest<readonly SampleColumns[]>[] = []
    for (const id of this.panelIds()) {
      const old = this.states.get(id) ?? IDLE
      const stale = old.result !== null && (old.stale || previous?.question !== question)
      this.set(id, { waiting: true, since: now, result: old.result, stale, error: null, halted: null })
      requests.push(this.request(id))
    }
    for (const id of [...this.states.keys()]) if (!resolved.panels[id]) this.states.delete(id)
    this.loader.load(requests)
    if (this.stopTimer !== null) clearTimeout(this.stopTimer)
    this.stopTimer = setTimeout(() => this.stop(), STOP_AFTER_MS)
    this.summarise()
  }

  /** Asks one panel again (after its error, its cancellation or the stop). */
  reload(id: string): void {
    if (!this.current || !this.current.resolved.panels[id]) return
    const old = this.states.get(id) ?? IDLE
    this.set(id, { ...old, waiting: true, since: performance.now(), error: null, halted: null })
    this.loader.reload(this.request(id))
    this.summarise()
  }

  /** Ends one panel's wait at the person's request. */
  cancelPanel(id: string): void {
    this.halt(id, 'cancelled')
  }

  /** The view is left: every request in flight is aborted, and nothing is delivered afterwards. */
  dispose(): void {
    if (this.stopTimer !== null) clearTimeout(this.stopTimer)
    this.stopTimer = null
    this.loader.cancel()
  }

  get(id: string): PanelState {
    return this.states.get(id) ?? IDLE
  }
  subscribe(id: string, fn: () => void): () => void {
    let set = this.listeners.get(id)
    if (!set) this.listeners.set(id, (set = new Set()))
    set.add(fn)
    return () => void set.delete(fn)
  }
  summary(): LoadSummary {
    return this.summaryNow
  }
  subscribeSummary(fn: () => void): () => void {
    this.summaryListeners.add(fn)
    return () => void this.summaryListeners.delete(fn)
  }

  private panelIds(): string[] {
    const r = this.current!.resolved
    return [...r.order, ...Object.keys(r.panels).filter((p) => !r.order.includes(p))]
  }

  private request(id: string): PanelRequest<readonly SampleColumns[]> {
    const { resolved, window: w } = this.current!
    const panel = resolved.panels[id]!
    const controller = new AbortController()
    this.panelControllers.set(id, controller)
    const queries = panel.kind === 'text' ? [] : panel.queries
    return {
      panel: id,
      signal: controller.signal,
      queries: queries.map((qid) => ({
        id: qid,
        run: async (signal: AbortSignal): Promise<readonly SampleColumns[]> => {
          const q = resolved.queries[qid]
          if (!q) throw new NotSent(`The panel names the query "${qid}", which the dashboard does not define.`)
          if (q.error) throw new NotSent(q.error)
          if (q.lang !== 'promql') throw new NotSent(`The query is written in ${q.lang}. This app runs PromQL queries only.`)
          if (q.instant) return columnsOf((await this.client.query(q.expr, w.end, { signal })).data)
          return (await this.client.queryRangeMatrix(q.expr, w.start, w.end, w.step, { signal })).matrix.series
        },
      })),
    }
  }

  private deliver(id: string, outcome: PanelOutcome<readonly SampleColumns[]>): void {
    const now = this.current
    const old = this.states.get(id)
    if (!now || !old) return
    if (outcome.status === 'done') {
      this.set(id, { waiting: false, since: 0, result: { data: outcome.data, resolved: now.resolved, window: now.window, receivedAt: Date.now() }, stale: false, error: null, halted: null })
    } else {
      const reason = this.panelControllers.get(id)?.signal.reason as unknown
      const halted = reason === 'cancelled' || reason === 'stopped' ? reason : null
      // A failure is this panel's: what it drew before stays its own, marked as the earlier answer it is.
      this.set(id, { waiting: false, since: 0, result: old.result, stale: old.result !== null, error: halted ? null : outcome.error, halted })
    }
    this.summarise()
  }

  private halt(id: string, why: 'cancelled' | 'stopped'): void {
    if (!this.get(id).waiting) return
    this.panelControllers.get(id)?.abort(why)
  }

  private stop(): void {
    this.stopTimer = null
    for (const [id, s] of this.states) if (s.waiting) this.halt(id, 'stopped')
  }

  private set(id: string, state: PanelState): void {
    this.states.set(id, state)
    const set = this.listeners.get(id)
    if (set) for (const fn of [...set]) fn()
  }

  private summarise(): void {
    const s: LoadSummary = { total: 0, answered: 0, failed: 0, waiting: 0 }
    for (const state of this.states.values()) {
      s.total++
      if (state.waiting) s.waiting++
      else if (state.error || state.halted) s.failed++
      else s.answered++
    }
    const old = this.summaryNow
    if (old.total === s.total && old.answered === s.answered && old.failed === s.failed && old.waiting === s.waiting) return
    this.summaryNow = s
    for (const fn of [...this.summaryListeners]) fn()
  }
}
