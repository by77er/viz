import { useEffect, useRef, useState } from 'react'
import { momentText } from '../lib/timeInput'

/**
 * The design system's waiting table (design-system/project/README.md, "Responsiveness and
 * feedback"), in milliseconds. Durations of waiting, not of motion, so they are not tokens.
 */
export const WAIT = {
  /** Under this, nothing but the busy control. */
  showAfter: 400,
  /** Once shown, the progress line stays at least this long, so it never flashes. */
  minShown: 300,
  /** Cancel is offered from here. */
  cancelAfter: 2000,
  /** From here the line names the cheaper alternative. */
  alternativeAfter: 10_000,
  /** Stop, keep what arrived, and say so. */
  stopAfter: 60_000,
} as const

/**
 * Whether the progress line is shown for a wait, and how long the wait has run.
 * `shown` turns true after `showAfter` ms of continuous waiting and stays true for at least
 * `minShown` ms.
 */
export function useWaiting(active: boolean): { shown: boolean; elapsedMs: number } {
  const [shown, setShown] = useState(false)
  const [elapsedMs, setElapsedMs] = useState(0)
  const startedAt = useRef(0)
  const shownAt = useRef(0)

  useEffect(() => {
    if (!active) return
    startedAt.current = performance.now()
    const show = setTimeout(() => {
      setElapsedMs(performance.now() - startedAt.current)
      setShown(true)
    }, WAIT.showAfter)
    return () => clearTimeout(show)
  }, [active])

  // The minimum is counted from the moment the line is in the document, not from the timer.
  useEffect(() => {
    shownAt.current = shown ? performance.now() : 0
  }, [shown])

  // Hide when the wait is over, but not before the line has been up for minShown.
  useEffect(() => {
    if (active || !shown) return
    let hide: ReturnType<typeof setTimeout>
    const tryHide = () => {
      const left = WAIT.minShown - (performance.now() - shownAt.current)
      if (left <= 0) setShown(false)
      else hide = setTimeout(tryHide, left + 1) // timers may fire a little early; check again
    }
    tryHide()
    return () => clearTimeout(hide)
  }, [active, shown])

  // The running time, ten times a second, only while the line is up and the wait is on.
  useEffect(() => {
    if (!active || !shown) return
    const tick = setInterval(() => setElapsedMs(performance.now() - startedAt.current), 100)
    return () => clearInterval(tick)
  }, [active, shown])

  // The wait is over and the line has been up for minShown: it goes in the render that shows
  // the result, not in one after it. Left to the effect above, the line stayed for one more
  // frame over the new result, and the page rendered twice for one answer (15 to 20 ms at 4x
  // CPU: design-system/reviews/chart-speed). The effect still hides a line that has to stay
  // a little longer. `shownAt` is 0 until the line is in the document.
  if (!active && shown && shownAt.current > 0 && performance.now() - shownAt.current >= WAIT.minShown) {
    setShown(false)
    return { shown: false, elapsedMs }
  }
  return { shown, elapsedMs }
}

/**
 * An age as the system writes it (Number, "Age of data"): "just now" under 5 s, then seconds,
 * minutes and hours, and the absolute time beyond a day. Never "0 s ago".
 */
export function formatAge(seconds: number, atEpochSec: number, nowMs = Date.now()): { n: string; rest: string } {
  if (seconds < AGE_NOW_BELOW) return { n: '', rest: 'just now' }
  if (seconds < 60) return { n: `${Math.floor(seconds)} s`, rest: ' ago' }
  if (seconds < 3600) return { n: `${Math.floor(seconds / 60)} min`, rest: ' ago' }
  if (seconds < 86400) return { n: `${Math.floor(seconds / 3600)} h`, rest: ' ago' }
  return { n: momentText(atEpochSec, nowMs), rest: '' }
}

/** A result younger than this many seconds was updated "just now". */
export const AGE_NOW_BELOW = 5

/**
 * The last part of the panel head's meta: how old the data on screen is, kept current once a
 * second. It is the age of the result that is drawn, handed in from that result, never from
 * the query being typed or waited for. Only this element re-renders with the clock.
 */
export function Age({ at }: { at: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    setNow(Date.now())
    const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(tick)
  }, [at])
  const age = formatAge((now - at) / 1000, at / 1000, now)
  return (
    <span data-testid="age">
      · updated {age.n === '' ? age.rest : <span className="vz-qty">{age.n}</span>}
      {age.n === '' ? '' : age.rest}
    </span>
  )
}

/** The cheaper alternative offered after 10 s of waiting: the longest preset shorter than the range asked for. */
export function shorterRange(spanSeconds: number): { preset: string; seconds: number } | null {
  for (const [preset, seconds] of [['1h', 3600], ['15m', 900]] as const) if (spanSeconds > seconds * 1.01) return { preset, seconds }
  return null
}
