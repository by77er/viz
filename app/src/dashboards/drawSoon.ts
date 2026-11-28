/**
 * When a dashboard's charts are drawn (D-B2 of the third design review, D-B3 of the fourth).
 *
 * The rule (the fourth review's reading of "Receives a result: paint it within 100 ms", adopted
 * by the lead): **a chart may wait while it is off screen, but it is painted within 100 ms of
 * coming into view.** So:
 *
 * - **Near** (within ten screens of the window, `NEAR`): a chart is drawn in the task its answer
 *   arrives, as on screen. Where its place is is read in that answer's render, not taken from an
 *   observer's last word (a jump in that task has not reached it). So a jump during the load
 *   finds the charts it brings into view drawn already: measured, drawing them only once they
 *   came near or into view could not meet the rule at 4x CPU, because the charts a jump to the
 *   end brings into view (three or four at 1440 x 900) are answered in the same burst as the one
 *   jumped to and each costs 20 to 45 ms to draw (README, "Speed (fourth review)").
 * - **Further**: it waits in its reserved place (the height it draws) as a job here, and is
 *   drawn when it comes near (an IntersectionObserver with the same margin: a task of its own,
 *   nearest first, one per task), when the page is idle (one per idle period, nearest first), or
 *   **when it comes into view**, in the frame that first shows it: the page's scroll event is
 *   dispatched in that frame's rendering steps, before its layout and paint, so a chart drawn
 *   synchronously there is in the frame. When a jump brings several into view, the one nearest
 *   the window's middle is drawn in that frame and the others one per following frame. The
 *   observer of the viewport is the last path (a change of layout that brings a chart into view
 *   without a scroll), in the task after that frame.
 *
 * Every draw is `flushSync` in the job's own task or frame, so a draw is never left to React's
 * scheduler, which could put it after the frame.
 */

export interface DrawJob {
  /** The element in the chart's reserved place: what is watched. */
  el: Element
  /** Draws the chart, synchronously. */
  draw: () => void
  near: boolean
}

/** How far outside the window "near" reaches, in screens, above and below. */
export const NEAR = 10
/** The same as an IntersectionObserver's margin (every side; only above and below matter: the page does not scroll sideways). */
const NEAR_MARGIN = `${NEAR * 100}%`

const jobs = new Set<DrawJob>()
const byElement = new WeakMap<Element, DrawJob>()
let posted = false
let idlePosted = false
let viewport: IntersectionObserver | null = null
let nearby: IntersectionObserver | null = null
let listening = false

const hasObserver = () => typeof IntersectionObserver !== 'undefined'

function run(job: DrawJob): void {
  if (!jobs.delete(job)) return
  viewport?.unobserve(job.el)
  nearby?.unobserve(job.el)
  byElement.delete(job.el)
  if (jobs.size === 0) unlisten()
  job.draw()
}

function inView(el: Element, height: number): boolean {
  const r = el.getBoundingClientRect()
  return r.bottom > 0 && r.top < height && r.width > 0
}

/** Distance of an element's middle from the window's middle: what is drawn first when several come into view at once. */
function offCentre(el: Element, height: number): number {
  const r = el.getBoundingClientRect()
  return Math.abs((r.top + r.bottom) / 2 - height / 2)
}
let framePosted = false
/**
 * The scroll steps of a frame: the job this frame brings into view nearest the window's middle (where a jump puts what it jumps
 * to) is drawn now, into this frame; any others in view are drawn one per following frame, in their animation callbacks (before
 * those frames' layout and paint), nearest the middle first. One chart per frame, so the first is painted after one chart's work,
 * not after all of theirs.
 */
function onScroll(): void {
  drawOneInView()
}
function drawOneInView(): void {
  const h = window.innerHeight
  const seen = [...jobs].filter((j) => inView(j.el, h))
  if (!seen.length) return
  seen.sort((a, b) => offCentre(a.el, h) - offCentre(b.el, h))
  run(seen[0]!)
  if (seen.length > 1 && !framePosted) {
    framePosted = true
    // An animation callback asked for in a frame's scroll steps runs in that same frame: the next frame's is asked for from it.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        framePosted = false
        drawOneInView()
      }),
    )
  }
}
function listen(): void {
  if (listening) return
  listening = true
  // Capture: a scroll of the window or of any scrolling ancestor.
  addEventListener('scroll', onScroll, { capture: true, passive: true })
}
function unlisten(): void {
  if (!listening) return
  listening = false
  removeEventListener('scroll', onScroll, { capture: true })
}

/** The job nearest the window among `from`. */
function nearest(from: DrawJob[]): DrawJob | undefined {
  const h = window.innerHeight
  let best: DrawJob | undefined
  let bestD = Infinity
  for (const j of from) {
    const r = j.el.getBoundingClientRect()
    const d = r.top >= h ? r.top - h : r.bottom <= 0 ? -r.bottom : 0
    if (d < bestD) {
      bestD = d
      best = j
    }
  }
  return best
}

const post = (fn: () => void) => {
  const ch = new MessageChannel()
  ch.port1.onmessage = () => fn()
  ch.port2.postMessage(0)
}

/** Draws the nearest near job in a task of its own; then the next. */
function pump(): void {
  if (posted) return
  if (![...jobs].some((j) => j.near)) return
  posted = true
  post(() => {
    posted = false
    const job = nearest([...jobs].filter((j) => j.near))
    if (job) run(job)
    pump()
  })
}

/** Draws the nearest job, near or not, when the page is idle, one per idle period. */
function idle(): void {
  if (idlePosted || jobs.size === 0) return
  idlePosted = true
  const ric = (window as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback
  const next = () => {
    idlePosted = false
    const near = [...jobs].filter((j) => j.near)
    const job = nearest(near.length ? near : [...jobs])
    if (job) run(job)
    idle()
  }
  if (ric) ric(next, { timeout: 1000 })
  else setTimeout(next, 50)
}

function observers(): void {
  // A change of layout that brings a chart into view without a scroll: drawn in the observer's task, after that frame.
  viewport ??= new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting && byElement.has(e.target))) drawOneInView()
  })
  nearby ??= new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const job = byElement.get(e.target)
        if (job) job.near = e.isIntersecting
      }
      pump()
    },
    { rootMargin: NEAR_MARGIN },
  )
}

/** Whether the element is near the window now (within `NEAR` screens): an answer's render asks this. True without observers. */
export function nearNow(el: Element | null): boolean {
  if (!hasObserver() || el === null) return true
  const r = el.getBoundingClientRect()
  const h = window.innerHeight
  return r.bottom > -NEAR * h && r.top < (NEAR + 1) * h
}

/**
 * A chart waits to be drawn. Returns the function that withdraws it (the panel went away), or
 * null when it must be drawn now, by the caller, in this task: it is near after all (it came near
 * between its render and this call), or the browser has no observer.
 */
export function drawSoon(el: Element, draw: () => void): (() => void) | null {
  if (nearNow(el)) return null
  const job: DrawJob = { el, draw, near: false }
  observers()
  jobs.add(job)
  byElement.set(el, job)
  viewport!.observe(el)
  nearby!.observe(el)
  listen()
  idle()
  return () => {
    if (!jobs.delete(job)) return
    viewport?.unobserve(el)
    nearby?.unobserve(el)
    byElement.delete(el)
    if (jobs.size === 0) unlisten()
  }
}

/** For checks: how many charts wait. */
export const waitingCharts = () => jobs.size
