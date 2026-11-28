/**
 * How a dashboard's requests are sent. Pure: no page, no client.
 *
 * - **At most six requests in flight** (`Limiter`, api/limiter.ts): a dashboard's panels and
 *   variables share one limiter of six, and every request the app sends, these included, goes
 *   through the API client's own limiter of six (api/client.ts), so the page as a whole never
 *   has more in flight. The rest wait in the order they were asked.
 * - **A new load cancels the one before it** (`Loader.load`): its requests in flight are aborted
 *   through their `AbortSignal`, and its requests still waiting are never sent.
 * - **A superseded answer is never delivered** (`Loader`): every load has a generation, and an
 *   answer (or a failure) that arrives for an earlier generation is dropped, also when the
 *   request ignored its abort signal. So what is painted is always the answer to what is on
 *   screen now, whatever order the answers arrive in.
 * - **A panel's failure is that panel's**: each panel's queries settle on their own, and one
 *   panel's error is delivered as that panel's outcome and nothing else's.
 */

import { Limiter } from '../api/limiter'

export { Limiter, MAX_IN_FLIGHT } from '../api/limiter'

const aborted = () => new DOMException('The operation was aborted.', 'AbortError')

/** One panel's requests: every query it names, each as a function of the signal that cancels it. */
export interface PanelRequest<T> {
  panel: string
  /** Ends this panel's wait alone (Cancel, the 60 s stop): its outcome is then an error, delivered as any other. */
  signal?: AbortSignal
  queries: { id: string; run: (signal: AbortSignal) => Promise<T> }[]
}

/** How a panel's requests ended: every query's answer by query id, or the first failure. */
export type PanelOutcome<T> = { status: 'done'; data: Record<string, T> } | { status: 'error'; error: unknown }

export class Loader<T> {
  private generation = 0
  private controller: AbortController | null = null
  private readonly limiter: Limiter
  private readonly deliver: (panel: string, outcome: PanelOutcome<T>, generation: number) => void

  /** `deliver` is called once per panel of the current load, and never for a load that was superseded or cancelled. */
  constructor(limiter: Limiter, deliver: (panel: string, outcome: PanelOutcome<T>, generation: number) => void) {
    this.limiter = limiter
    this.deliver = deliver
  }

  /** The signal of the current load, for other requests that belong to it (a variable's values). Aborted when the load is superseded. */
  get signal(): AbortSignal | null {
    return this.controller?.signal ?? null
  }

  /** Starts a load: the one before it is cancelled and whatever it still answers is dropped. Returns the new generation. */
  load(panels: readonly PanelRequest<T>[]): number {
    this.controller?.abort()
    const controller = new AbortController()
    this.controller = controller
    const generation = ++this.generation
    for (const p of panels) void this.runPanel(p, generation, controller.signal)
    return generation
  }

  /** Asks one panel again within the current load (after its error). */
  reload(panel: PanelRequest<T>): void {
    if (!this.controller) this.controller = new AbortController()
    void this.runPanel(panel, this.generation, this.controller.signal)
  }

  /** The view is left: everything in flight is aborted and nothing more is delivered. */
  cancel(): void {
    this.controller?.abort()
    this.controller = null
    this.generation++
  }

  private async runPanel(p: PanelRequest<T>, generation: number, load: AbortSignal): Promise<void> {
    const signal = p.signal ? AbortSignal.any([load, p.signal]) : load
    let outcome: PanelOutcome<T>
    try {
      // The wait ends when the signal says so, also for a request that does not listen to it.
      const stopped = new Promise<never>((_, reject) => {
        if (signal.aborted) reject(aborted())
        else signal.addEventListener('abort', () => reject(aborted()), { once: true })
      })
      const answers = await Promise.race([Promise.all(p.queries.map(async (q) => [q.id, await this.limiter.run(q.run, signal)] as const)), stopped])
      outcome = { status: 'done', data: Object.fromEntries(answers) }
    } catch (error) {
      outcome = { status: 'error', error }
    }
    // Superseded or cancelled while it waited: not delivered, whatever it is.
    if (generation !== this.generation || load.aborted) return
    this.deliver(p.panel, outcome, generation)
  }
}
