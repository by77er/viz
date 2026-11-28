/**
 * At most six requests in flight. A browser gives one origin six connections (HTTP/1.1), and
 * the API behind it has the same budget of six outbound connections per request (AGENTS.md,
 * "Durable Objects"): a page that asks for more at once only makes the others wait where
 * nobody can see or cancel them. Here the rest wait in the order they were asked, and a
 * request cancelled while it waits is never sent. Pure: no page, no client.
 */

/** The most requests a page has in flight at once. */
export const MAX_IN_FLIGHT = 6

const aborted = () => new DOMException('The operation was aborted.', 'AbortError')

export class Limiter {
  readonly max: number
  private running = 0
  private readonly waiting: (() => void)[] = []
  /** The most that ran at once since this limiter was made (for tests and measurements). */
  peak = 0

  constructor(max: number = MAX_IN_FLIGHT) {
    this.max = max
  }

  get inFlight(): number {
    return this.running
  }
  get queued(): number {
    return this.waiting.length
  }

  /** Runs `task` when fewer than `max` are running. A task whose signal is aborted while it waits is never started. */
  run<T>(task: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (signal.aborted) return reject(aborted())
      const start = () => {
        signal.removeEventListener('abort', onAbort)
        this.running++
        if (this.running > this.peak) this.peak = this.running
        let p: Promise<T>
        try {
          p = task(signal)
        } catch (e) {
          p = Promise.reject(e)
        }
        p.then(resolve, reject).finally(() => {
          this.running--
          this.pump()
        })
      }
      const onAbort = () => {
        const i = this.waiting.indexOf(start)
        if (i >= 0) this.waiting.splice(i, 1)
        reject(aborted())
      }
      if (this.running < this.max) start()
      else {
        this.waiting.push(start)
        signal.addEventListener('abort', onAbort, { once: true })
      }
    })
  }

  private pump(): void {
    while (this.running < this.max && this.waiting.length > 0) this.waiting.shift()!()
  }
}
