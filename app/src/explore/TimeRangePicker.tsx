import { useEffect, useId, useRef, useState } from 'react'
import {
  absoluteSpec,
  describeRange,
  fromDateTimeLocal,
  isRelative,
  resolveTimeSpec,
  toDateTimeLocal,
  type TimeSpec,
} from '../lib/time'

/** "15m" as it is typed, "15 m" as it is read: numbers carry their unit after a space. */
export const spacedDuration = (d: string) => d.replace(/(\d+)([a-z]+)/g, '$1 $2 ').trim()

export const PRESETS = ['5m', '15m', '30m', '1h', '3h', '6h', '12h', '24h', '2d', '7d'] as const

interface Props {
  from: TimeSpec
  to: TimeSpec
  onChange: (from: TimeSpec, to: TimeSpec) => void
}

export function TimeRangePicker({ from, to, onChange }: Props) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
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
    const half = (end - start) / 2
    const newEnd = Math.min(end + half, Date.now() / 1000)
    onChange(absoluteSpec(newEnd - 4 * half), absoluteSpec(newEnd))
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
      <button className="vz-button" onClick={() => shift(-1)} aria-label="Earlier: shift the time range back by half its length">
        Earlier
      </button>
      <button className="vz-button" onClick={() => shift(1)} aria-label="Later: shift the time range forward by half its length">
        Later
      </button>
      <button className="vz-button" onClick={zoomOut} aria-label="Zoom out: double the time range">
        Zoom out
      </button>

      {open && (
        <div id={popId} role="dialog" aria-label="Time range" className="vz-menu popover">
          <div role="menu" aria-label="Relative ranges">
            {PRESETS.map((p) => (
              <button
                key={p}
                role="menuitem"
                aria-current={current === p ? 'true' : undefined}
                onClick={() => {
                  onChange(`now-${p}`, 'now')
                  setOpen(false)
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
              <span className="vz-help">{isRelative(from) || isRelative(to) ? 'The range now follows the clock.' : 'The range now is fixed.'}</span>
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
}
