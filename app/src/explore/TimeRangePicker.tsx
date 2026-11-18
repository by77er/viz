import { memo, useEffect, useId, useRef, useState } from 'react'
import {
  absoluteSpec,
  describeRange,
  fromDateTimeLocal,
  isRelative,
  resolveTimeSpec,
  toDateTimeLocal,
  type TimeSpec,
} from '../lib/time'

/**
 * "15m" as it is typed, "15 min" as it is read: numbers carry their unit after a space, and
 * minutes are "min", which cannot be read as metres (design review m3, as `stepWords`).
 */
export const spacedDuration = (d: string) =>
  d
    .replace(/(\d+)([a-z]+)/g, '$1 $2 ')
    .trim()
    .replace(/(\d+) m\b/g, '$1 min')

export const PRESETS = ['5m', '15m', '30m', '1h', '3h', '6h', '12h', '24h', '2d', '7d'] as const

interface Props {
  from: TimeSpec
  to: TimeSpec
  onChange: (from: TimeSpec, to: TimeSpec) => void
  /** Zoom in or out: the same as a drag on the chart, for touch and keyboard. */
  onZoom: (from: TimeSpec, to: TimeSpec) => void
  /** Back to the range before the first zoom (or the default range when nothing was zoomed). */
  onResetZoom: () => void
}

/** The range half as long around the same centre, never shorter than `minSeconds`. */
export function zoomedIn(start: number, end: number, minSeconds = 60): [number, number] {
  const span = end - start
  const next = Math.max(Math.min(span, minSeconds), span / 2)
  const mid = (start + end) / 2
  return [mid - next / 2, mid + next / 2]
}

/** The range twice as long around the same centre, moved back so that it does not end after `now`. */
export function zoomedOut(start: number, end: number, now: number): [number, number] {
  const half = (end - start) / 2
  const newEnd = Math.min(end + half, now)
  return [newEnd - 4 * half, newEnd]
}

export const TimeRangePicker = memo(function TimeRangePicker({ from, to, onChange, onZoom, onResetZoom }: Props) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const popId = useId()
  const now = Date.now() / 1000
  const start = resolveTimeSpec(from, now)
  const end = resolveTimeSpec(to, now)
  const [absFrom, setAbsFrom] = useState('')
  const [absTo, setAbsTo] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    setAbsFrom(toDateTimeLocal(start))
    setAbsTo(toDateTimeLocal(end))
    setError('')
    // Focus moves into the popover: to the current preset, or the first one.
    const items = menuRef.current?.querySelectorAll<HTMLElement>('[role=menuitem]')
    ;(menuRef.current?.querySelector<HTMLElement>('[aria-current]') ?? items?.[0])?.focus()
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        buttonRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
    // Initialise the form when the popover opens, not on every tick of "now".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const shift = (dir: -1 | 1) => {
    const half = (end - start) / 2
    onChange(absoluteSpec(start + dir * half), absoluteSpec(end + dir * half))
  }
  const zoomOut = () => {
    const [a, b] = zoomedOut(start, end, Date.now() / 1000)
    onZoom(absoluteSpec(a), absoluteSpec(b))
  }
  const zoomIn = () => {
    const [a, b] = zoomedIn(start, end)
    onZoom(absoluteSpec(a), absoluteSpec(b))
  }

  const current = to === 'now' && from.startsWith('now-') ? from.slice(4) : null

  return (
    <div className="vz-field">
      <span className="vz-label" id={`${popId}-label`}>
        Time range
      </span>
      <div ref={rootRef} className="toolbar-group" role="group" aria-labelledby={`${popId}-label`}>
      <button
        ref={buttonRef}
        className="vz-button range-button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popId : undefined}
        onClick={() => setOpen((o) => !o)}
        data-testid="time-range"
      >
        <span className="sr-only">Time range: </span>
        {current ? `Last ${spacedDuration(current)}` : <span className="vz-num">{describeRange(from, to, now)}</span>}
      </button>
      <button className="vz-button" onClick={() => shift(-1)} aria-label="Show earlier: shift the time range back by half its length">
        Show earlier
      </button>
      <button className="vz-button" onClick={() => shift(1)} aria-label="Show later: shift the time range forward by half its length">
        Show later
      </button>
      {/* Zoom by button: a drag on the chart cannot be the only way (touch, keyboard). Placement is provisional. */}
      <button className="vz-button" onClick={zoomIn} aria-label="Zoom in: halve the time range around its middle" data-testid="zoom-in">
        Zoom in
      </button>
      <button className="vz-button" onClick={zoomOut} aria-label="Zoom out: double the time range" data-testid="zoom-out">
        Zoom out
      </button>
      <button className="vz-button" onClick={onResetZoom} aria-label="Reset zoom: go back to the time range before zooming" data-testid="zoom-reset">
        Reset zoom
      </button>

      {open && (
        <div id={popId} role="dialog" aria-label="Time range" className="vz-menu popover">
          <div
            ref={menuRef}
            role="menu"
            aria-label="Relative ranges"
            onKeyDown={(e) => {
              // Arrow keys move through the presets, as in any menu.
              const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0
              if (!step) return
              e.preventDefault()
              const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[role=menuitem]')]
              items[(items.indexOf(document.activeElement as HTMLElement) + step + items.length) % items.length]?.focus()
            }}
          >
            {PRESETS.map((p) => (
              <button
                key={p}
                role="menuitem"
                aria-current={current === p ? 'true' : undefined}
                onClick={() => {
                  onChange(`now-${p}`, 'now')
                  setOpen(false)
                  // The menu item that had focus is gone; the button that opened the menu takes it.
                  buttonRef.current?.focus()
                }}
              >
                Last {spacedDuration(p)}
              </button>
            ))}
          </div>
          <div role="separator" />
          <form
            className="popover-form"
            onSubmit={(e) => {
              e.preventDefault()
              const a = fromDateTimeLocal(absFrom)
              const b = fromDateTimeLocal(absTo)
              if (a === null || b === null) return setError('Enter both a start and an end time.')
              if (b <= a) return setError('Set the end after the start.')
              onChange(absoluteSpec(a), absoluteSpec(b))
              setOpen(false)
              buttonRef.current?.focus()
            }}
          >
            <div className="vz-field">
              <label className="vz-label" htmlFor={`${popId}-from`}>
                From (local time)
              </label>
              <input id={`${popId}-from`} className="vz-input" data-mono="" type="datetime-local" step="1" value={absFrom} onChange={(e) => setAbsFrom(e.target.value)} />
            </div>
            <div className="vz-field">
              <label className="vz-label" htmlFor={`${popId}-to`}>
                To (local time)
              </label>
              <input
                id={`${popId}-to`}
                className="vz-input"
                data-mono=""
                type="datetime-local"
                step="1"
                value={absTo}
                onChange={(e) => setAbsTo(e.target.value)}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? `${popId}-error` : undefined}
              />
              {error && (
                <span className="vz-help" data-error="" id={`${popId}-error`} role="alert">
                  <span className="vz-mark" data-state="critical" />
                  {error}
                </span>
              )}
            </div>
            <div className="popover-actions">
              <span className="vz-help">{isRelative(from) || isRelative(to) ? 'This range follows the clock.' : 'This range is fixed.'}</span>
              <button type="submit" className="vz-button">
                Apply range
              </button>
            </div>
          </form>
        </div>
      )}
      </div>
    </div>
  )
})
