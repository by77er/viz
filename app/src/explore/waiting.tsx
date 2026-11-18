import { useEffect, useRef, useState } from 'react'
import { formatDateTime } from '../lib/time'

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
    if (shown) shownAt.current = performance.now()
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

  return { shown, elapsedMs }
}

/** "12 s", "3 min", "5 h" under a day; the date and time beyond it. Under 5 s the age is "now", not a count of 0. */
export function formatAge(seconds: number, atEpochSec: number): { n: string; rest: string } {
  if (seconds < AGE_NOW_BELOW) return { n: '', rest: 'now' }
  if (seconds < 60) return { n: String(Math.floor(seconds)), rest: ' s ago' }
  if (seconds < 3600) return { n: String(Math.floor(seconds / 60)), rest: ' min ago' }
  if (seconds < 86400) return { n: String(Math.floor(seconds / 3600)), rest: ' h ago' }
  return { n: formatDateTime(atEpochSec), rest: '' }
}

/** A result younger than this many seconds was "updated now". */
export const AGE_NOW_BELOW = 5

/**
 * The panel head's meta: the unit of the values, then how old the shown data is, kept current
 * once a second. Both describe the result on screen and are handed in already derived from it
 * (lib/describe), never from the query being typed or waited for. Only this element
 * re-renders with the clock.
 */
export function Age({ at, unit }: { at: number; unit?: string }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    setNow(Date.now())
    const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(tick)
  }, [at])
  const age = formatAge((now - at) / 1000, at / 1000)
  // Only the digits are monospaced, so the figure keeps its width as it counts.
  return (
    <span className="vz-panel-meta" data-testid="age">
      {unit ? `${unit} · ` : ''}
      {age.n === '' ? (
        `updated ${age.rest}`
      ) : (
        <>
          updated <span className="app-num">{age.n}</span>
          {age.rest}
        </>
      )}
    </span>
  )
}

/** The cheaper alternative offered after 10 s of waiting: the longest preset shorter than the range asked for. */
export function shorterRange(spanSeconds: number): { preset: string; seconds: number } | null {
  for (const [preset, seconds] of [['1h', 3600], ['5m', 300]] as const) if (spanSeconds > seconds * 1.01) return { preset, seconds }
  return null
}
