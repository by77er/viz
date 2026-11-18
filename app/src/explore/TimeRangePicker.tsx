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
    <div ref={rootRef} className="relative flex items-center">
      <button className="btn btn-icon rounded-r-none" onClick={() => shift(-1)} aria-label="Shift time range back" title="Shift back by half the range">
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M7.5 2.5 4 6l3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <button
        ref={buttonRef}
        className="btn tnum -ml-px rounded-none"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popId : undefined}
        onClick={() => setOpen((o) => !o)}
        data-testid="time-range"
      >
        <svg width="13" height="13" viewBox="0 0 14 14" aria-hidden="true" className="text-fg-3">
          <circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <path d="M7 4v3.2l2 1.3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="sr-only">Time range: </span>
        {describeRange(from, to, now)}
      </button>
      <button className="btn btn-icon -ml-px rounded-none" onClick={() => shift(1)} aria-label="Shift time range forward" title="Shift forward by half the range">
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M4.5 2.5 8 6 4.5 9.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <button className="btn btn-icon -ml-px rounded-l-none" onClick={zoomOut} aria-label="Zoom out time range" title="Zoom out (2×)">
        <svg width="13" height="13" viewBox="0 0 14 14" aria-hidden="true">
          <circle cx="6" cy="6" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <path d="M9.2 9.2 12.5 12.5M4 6h4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      </button>

      {open && (
        <div
          id={popId}
          role="dialog"
          aria-label="Time range"
          className="absolute left-0 top-[calc(100%+4px)] z-30 flex w-[min(440px,calc(100vw-24px))] flex-col rounded-md bg-surface sm:flex-row"
          style={{ boxShadow: 'var(--shadow)' }}
        >
          <div className="flex flex-col gap-0.5 border-b border-line p-2 sm:w-[150px] sm:border-b-0 sm:border-r">
            <div className="label px-2 pb-1">Relative</div>
            <div className="grid grid-cols-5 gap-0.5 sm:grid-cols-1">
              {PRESETS.map((p) => (
                <button
                  key={p}
                  className={`flex h-7 items-center justify-between rounded px-2 text-left hover:bg-surface-2 ${current === p ? 'bg-accent-soft font-semibold' : ''}`}
                  aria-current={current === p ? 'true' : undefined}
                  onClick={() => {
                    onChange(`now-${p}`, 'now')
                    setOpen(false)
                  }}
                >
                  <span>
                    <span className="hidden sm:inline">Last </span>
                    {p}
                  </span>
                  {current === p && (
                    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" className="hidden sm:block">
                      <path d="M2.5 6.5 5 9l4.5-6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </button>
              ))}
            </div>
          </div>
          <form
            className="flex flex-1 flex-col gap-2 p-3"
            onSubmit={(e) => {
              e.preventDefault()
              const a = fromDateTimeLocal(absFrom)
              const b = fromDateTimeLocal(absTo)
              if (a === null || b === null) return setError('Enter both a start and an end time.')
              if (b <= a) return setError('The end must be after the start.')
              onChange(absoluteSpec(a), absoluteSpec(b))
              setOpen(false)
            }}
          >
            <div className="label">Absolute (local time)</div>
            <label className="flex flex-col gap-1 text-[12px] text-fg-2">
              From
              <input className="input tnum" type="datetime-local" step="1" value={absFrom} onChange={(e) => setAbsFrom(e.target.value)} />
            </label>
            <label className="flex flex-col gap-1 text-[12px] text-fg-2">
              To
              <input className="input tnum" type="datetime-local" step="1" value={absTo} onChange={(e) => setAbsTo(e.target.value)} />
            </label>
            {error && (
              <div role="alert" className="text-[12px] text-danger">
                {error}
              </div>
            )}
            <div className="mt-1 flex items-center justify-between gap-2">
              <span className="text-[11.5px] text-fg-3">{isRelative(from) || isRelative(to) ? 'Currently relative to now' : 'Currently absolute'}</span>
              <button type="submit" className="btn btn-primary">
                Apply
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}
