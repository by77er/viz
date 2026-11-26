import { memo, useEffect, useId, useRef, useState } from 'react'
import { absoluteSpec, parseDuration, resolveTimeSpec, stepWords, type TimeSpec } from '../lib/time'
import { LOCAL, parseSpan, parseTime, readRange, spanSpec, spanWords, timeText, type Zone } from '../lib/timeInput'

/** The ranges one press away, as Prometheus durations (the URL's form) and as they are read. */
export const PRESETS = ['15m', '1h', '6h', '24h', '7d'] as const
export const presetWords = (p: string) => p.replace(/^(\d+)([a-z]+)$/, '$1 $2').replace(/ m$/, ' min')

/** Whether two specs name the same time: the same text, or the same length before now ("now-24h" and "now-1d"). */
export function sameSpec(a: TimeSpec, b: TimeSpec): boolean {
  if (a === b) return true
  return a.startsWith('now-') && b.startsWith('now-') && parseDuration(a.slice(4)) === parseDuration(b.slice(4))
}

interface RangeProps {
  from: TimeSpec
  to: TimeSpec
  onChange: (from: TimeSpec, to: TimeSpec) => void
  zone?: Zone
}

/**
 * The time range as two typed times (design system, Field, "Time range"): "18 Nov 09:16",
 * "09:16" for today, "now", "now - 6 h". The help line echoes what was read, with the length
 * and the zone, once. A field that cannot be read keeps its text and says what it takes.
 */
export const TimeRangeField = memo(function TimeRangeField({ from, to, onChange, zone = LOCAL }: RangeProps) {
  const id = useId()
  const [now, setNow] = useState(() => Date.now())
  const [text, setText] = useState(() => ({ from: timeText(from, now, zone), to: timeText(to, now, zone) }))
  const [bad, setBad] = useState<{ field: 'from' | 'to' | 'order'; message: string } | null>(null)
  const committed = useRef({ from, to })
  // The fields follow the range when it changes elsewhere (a preset, a link, Back).
  useEffect(() => {
    const t = Date.now()
    committed.current = { from, to }
    setNow(t)
    setText({ from: timeText(from, t, zone), to: timeText(to, t, zone) })
    setBad(null)
  }, [from, to, zone])

  const commit = () => {
    const t = Date.now()
    const a = parseTime(text.from, t, zone)
    const b = parseTime(text.to, t, zone)
    const takes = 'Use a time such as "18 Nov 09:16", "09:16" for today, "now" or "now - 6 h".'
    if (a === null) return setBad({ field: 'from', message: `From was not read. ${takes}` })
    if (b === null) return setBad({ field: 'to', message: `To was not read. ${takes}` })
    if (!(resolveTimeSpec(b, t / 1000) > resolveTimeSpec(a, t / 1000))) return setBad({ field: 'order', message: 'To is not after From. Set From earlier, or To later.' })
    setBad(null)
    setNow(t)
    if (!sameSpec(a, committed.current.from) || !sameSpec(b, committed.current.to)) onChange(a, b)
    // What was typed is replaced by the form it was read as ("9:16" becomes "26 Nov 09:16").
    else setText({ from: timeText(a, t, zone), to: timeText(b, t, zone) })
  }
  const field = (which: 'from' | 'to', label: string) => (
    <label className="vz-field">
      <span className="vz-label">{label}</span>
      <input
        className="vz-input"
        data-mono=""
        value={text[which]}
        aria-invalid={bad && (bad.field === which || bad.field === 'order') ? true : undefined}
        aria-describedby={`${id}-help`}
        onChange={(e) => setText((v) => ({ ...v, [which]: e.target.value }))}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
        }}
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="off"
        data-testid={`time-${which}`}
      />
    </label>
  )
  const read = readRange(from, to, now, zone)
  return (
    <fieldset className="vz-field" data-span="6" data-testid="time-range">
      <legend className="vz-label">Time range</legend>
      <div className="vz-range">
        {field('from', 'From')}
        {field('to', 'To')}
      </div>
      {bad ? (
        <span className="vz-help" data-error="" id={`${id}-help`} role="alert" data-testid="time-error">
          <span className="vz-mark" data-state="critical" />
          {bad.message}
        </span>
      ) : (
        <span className="vz-help" id={`${id}-help`} data-testid="time-read">
          Read as {read.text}.
        </span>
      )}
    </fieldset>
  )
})

interface ShiftProps {
  from: TimeSpec
  to: TimeSpec
  onChange: (from: TimeSpec, to: TimeSpec) => void
  /** The range the chart shows after a zoom (epoch ms), when it is not the whole result; null otherwise. */
  shown: { fromMs: number; toMs: number } | null
}

/**
 * The ranges one press away, and moving the range: the last 15 min to 7 d as one segmented
 * control (the chosen one is marked while the range is that one), a step earlier and later
 * (half the range), and, while the chart is zoomed into its result, asking for that range
 * itself, which a zoom on the chart does not do (Chart: zoom never leaves the data).
 */
export const RangeControls = memo(function RangeControls({ from, to, onChange, shown }: ShiftProps) {
  const id = useId()
  const current = to === 'now' && from.startsWith('now-') ? from : null
  const shift = (dir: -1 | 1) => {
    const now = Date.now() / 1000
    const start = resolveTimeSpec(from, now)
    const end = resolveTimeSpec(to, now)
    const half = (end - start) / 2
    onChange(absoluteSpec(start + dir * half), absoluteSpec(end + dir * half))
  }
  return (
    <div className="vz-controls" data-testid="range-controls">
      <span className="vz-label" id={`${id}-last`}>
        Last
      </span>
      <div className="vz-segmented" role="group" aria-labelledby={`${id}-last`}>
        {PRESETS.map((p) => (
          <button key={p} aria-pressed={current !== null && sameSpec(current, `now-${p}`)} onClick={() => onChange(`now-${p}`, 'now')} data-testid={`preset-${p}`}>
            {presetWords(p)}
          </button>
        ))}
      </div>
      <button className="vz-button" onClick={() => shift(-1)} aria-label="Show earlier: move the time range back by half its length" data-testid="earlier">
        Show earlier
      </button>
      <button className="vz-button" onClick={() => shift(1)} aria-label="Show later: move the time range forward by half its length" data-testid="later">
        Show later
      </button>
      {/* Offered only while it would change something: its place is kept, so nothing moves when the chart is zoomed. */}
      <button
        className={shown ? 'vz-button' : 'vz-button is-reserved'}
        aria-hidden={shown ? undefined : true}
        tabIndex={shown ? undefined : -1}
        onClick={() => shown && onChange(String(Math.round(shown.fromMs)), String(Math.round(shown.toMs)))}
        data-focus-after="[data-testid=time-from]"
        data-testid="query-shown"
      >
        Query the chart's range
      </button>
    </div>
  )
})

/**
 * The step: empty for the automatic one, or a duration in any form ("30 s", "1 min", "5m").
 * The help line says the automatic step in use, or what the typed one was read as.
 */
export const StepField = memo(function StepField({ value, auto, onChange }: { value: string; auto: number | null; onChange: (v: string) => void }) {
  const id = useId()
  const shown = (v: string) => (v === 'auto' ? '' : spanWords(parseSpan(v) ?? 0))
  const [text, setText] = useState(() => shown(value))
  const [invalid, setInvalid] = useState(false)
  useEffect(() => {
    setText(shown(value))
    setInvalid(false)
  }, [value])
  const commit = () => {
    const t = text.trim()
    if (t === '' || /^auto(matic)?$/i.test(t)) {
      setInvalid(false)
      setText('')
      if (value !== 'auto') onChange('auto')
      return
    }
    const spec = spanSpec(t)
    if (spec === null) return setInvalid(true)
    setInvalid(false)
    if (spec !== value) onChange(spec)
    else setText(shown(spec))
  }
  return (
    <div className="vz-field" data-span="3">
      <label className="vz-label" htmlFor={id}>
        Step
      </label>
      <input
        id={id}
        className="vz-input"
        data-mono=""
        value={text}
        placeholder="30 s"
        aria-invalid={invalid ? true : undefined}
        aria-describedby={`${id}-help`}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
        }}
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="off"
        data-testid="step"
      />
      {invalid ? (
        <span className="vz-help" data-error="" id={`${id}-help`} role="alert" data-testid="step-error">
          <span className="vz-mark" data-state="critical" />
          Use a duration such as <span className="vz-qty">30 s</span>, <span className="vz-qty">1 min</span> or <span className="vz-qty">5 min</span>, or leave it empty.
        </span>
      ) : (
        <span className="vz-help" id={`${id}-help`} data-testid="step-read">
          {value === 'auto' ? (
            auto === null ? (
              'Empty: one value for each pixel column of the chart.'
            ) : (
              <>
                Empty: automatic, now <span className="vz-qty">{stepWords(auto)}</span>.
              </>
            )
          ) : (
            <>
              One value every <span className="vz-qty">{stepWords(parseSpan(value) ?? 0)}</span>.
            </>
          )}
        </span>
      )}
    </div>
  )
})
