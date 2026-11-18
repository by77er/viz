import { memo, useLayoutEffect, useRef, useState } from 'react'
import uPlot from 'uplot'
import { downsampleMinMax } from '../lib/downsample'
import type { TimeSeriesChartProps } from './types'

const pad = (n: number) => String(n).padStart(2, '0')

/** 24-hour local time ticks; the date appears on a second line when it changes. */
function timeTicks(_u: uPlot, splits: number[], _axisIdx: number, _space: number, incr: number): string[] {
  let prevDay = ''
  return splits.map((t, i) => {
    const d = new Date(t * 1000)
    const day = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    const time = incr < 60 ? `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` : `${pad(d.getHours())}:${pad(d.getMinutes())}`
    const showDay = day !== prevDay && (i === 0 || prevDay !== '')
    prevDay = day
    if (incr >= 86400) return day
    return showDay ? `${time}\n${day}` : time
  })
}

function fullTime(t: number): string {
  const d = new Date(t * 1000)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

const TIP_ROWS = 10
/** The design system labels up to this many series directly, at the end of their lines. */
const DIRECT_LABELS = 4

/** A canvas font string with its size multiplied for device pixels. */
const deviceFont = (font: string, dpr: number) => font.replace(/([\d.]+)px/, (_m, n: string) => `${Math.round(Number(n) * dpr)}px`)

/**
 * Line chart for time series, rendered with uPlot at the size of its container, in device
 * pixels. Every colour, width and size is read from the design system's custom properties.
 *
 * - null values are gaps (`spanGaps: false`); nothing is interpolated.
 * - when there are more points than pixel columns, min/max-per-column downsampling is
 *   applied (lib/downsample), so extremes survive.
 * - horizontal drag selects a range and reports it via `onZoom`; the chart itself does not
 *   zoom, the owner changes the time range (and so the URL).
 * - the crosshair readout moves by transform and reuses its rows, so following the pointer
 *   does not lay out the page.
 */
export const TimeSeriesChart = memo(function TimeSeriesChart(props: TimeSeriesChartProps) {
  const { xs, series, xRange, visible, formatValue, onZoom, onRenderInfo, syncKey, theme, ariaLabel } = props
  const wrapRef = useRef<HTMLDivElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const tipRef = useRef<HTMLDivElement>(null)
  const liveRef = useRef<HTMLDivElement>(null)
  const plotRef = useRef<uPlot | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })

  // Latest callbacks without re-creating the plot.
  const cb = useRef({ onZoom, onRenderInfo, formatValue })
  cb.current = { onZoom, onRenderInfo, formatValue }

  useLayoutEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const measure = () =>
      setSize((prev) => {
        const next = { width: Math.floor(el.clientWidth), height: Math.floor(el.clientHeight) }
        return prev.width === next.width && prev.height === next.height ? prev : next
      })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // A layout effect: the lines are on the canvas in the same frame as the rest of the result.
  useLayoutEffect(() => {
    const host = hostRef.current
    const wrap = wrapRef.current
    const tip = tipRef.current
    const { width, height } = size
    if (!host || !wrap || !tip || width < 40 || height < 40) return

    const css = getComputedStyle(wrap)
    const token = (name: string) => css.getPropertyValue(name).trim()
    const length = (name: string) => parseFloat(token(name)) || 0
    const ink = { muted: token('--ink-muted'), secondary: token('--ink-secondary') }
    const rule = token('--rule')
    const hairline = length('--hairline')
    const stroke = length('--stroke')
    // The container is set in the `micro` style; direct labels use `small`.
    const axisFont = `${css.fontWeight} ${css.fontSize} ${css.fontFamily}`
    const labelFont = `400 ${token('--text-small-size')} ${token('--font-sans')}`

    const drawn = series.filter((s) => !visible || visible.has(s.id))
    // Series folded into Other go underneath the coloured ones.
    const shown = [...drawn.filter((s) => s.other), ...drawn.filter((s) => !s.other)]
    const colors = shown.map((s) => token(s.colorVar))
    const dpr = window.devicePixelRatio || 1
    // The estimate of the y axis width only decides how aggressively to downsample.
    const columns = Math.max(50, Math.round((width - length('--space-12')) * dpr))
    const ds = downsampleMinMax(xs, shown.map((s) => s.values), columns)
    cb.current.onRenderInfo?.({ rawPoints: xs.length, drawnPoints: ds.xs.length, columns, downsampled: ds.downsampled })

    // ---- crosshair readout: rows are created once and reused on every move.
    tip.replaceChildren()
    const tipTime = document.createElement('div')
    tipTime.className = 'tip-time'
    const tipRows = Array.from({ length: Math.min(TIP_ROWS, Math.max(1, shown.length)) }, () => {
      const row = document.createElement('div')
      row.className = 'tip-row'
      const swatch = document.createElement('i')
      swatch.className = 'swatch'
      const name = document.createElement('span')
      name.className = 'tip-name'
      const value = document.createElement('span')
      value.className = 'tip-value'
      row.append(swatch, name, value)
      return { row, swatch, name, value }
    })
    const tipMore = document.createElement('div')
    tipMore.className = 'tip-more'
    tip.append(tipTime, ...tipRows.map((r) => r.row), tipMore)
    tip.hidden = false
    const tipWidth = tip.offsetWidth // read once, not on every move
    tip.hidden = true
    const tipGap = length('--space-3')

    let focused: number | null = null
    const renderTip = (u: uPlot) => {
      const idx = u.cursor.idx
      const left = u.cursor.left ?? -1
      if (idx == null || left < 0) {
        tip.hidden = true
        return
      }
      const rows: { i: number; value: number }[] = []
      shown.forEach((_s, i) => {
        const v = ds.series[i]![idx]
        if (v != null) rows.push({ i, value: v })
      })
      rows.sort((a, b) => b.value - a.value)
      let list = rows.slice(0, tipRows.length)
      const f = rows.find((r) => focused === r.i + 1)
      if (f && !list.includes(f)) list = [...list.slice(0, tipRows.length - 1), f]

      tipTime.textContent = fullTime(ds.xs[idx]!)
      tipRows.forEach((el, n) => {
        const r = list[n]
        el.row.hidden = !r
        if (!r) return
        const s = shown[r.i]!
        el.swatch.style.background = `var(${s.colorVar})`
        el.name.textContent = s.shortLabel ?? s.label
        el.value.textContent = cb.current.formatValue(r.value)
        if (focused === r.i + 1) el.row.dataset.focus = ''
        else delete el.row.dataset.focus
      })
      tipMore.textContent = rows.length === 0 ? 'No data at this time' : rows.length > list.length ? `and ${rows.length - list.length} more series` : ''
      tipMore.hidden = tipMore.textContent === ''
      tip.hidden = false
      const x = u.over.offsetLeft + left
      const flip = x + tipGap + tipWidth > width
      tip.style.transform = `translate(${Math.max(0, flip ? x - tipGap - tipWidth : x + tipGap)}px, ${u.over.offsetTop + tipGap}px)`
    }

    // ---- direct labels for up to four series: right-aligned at the plot's edge, above the
    // highest point the line reaches underneath the text, so a label never crosses its line.
    const drawLabels = (u: uPlot) => {
      if (shown.length === 0 || shown.length > DIRECT_LABELS) return
      const ctx = u.ctx
      ctx.save()
      ctx.font = deviceFont(labelFont, dpr)
      ctx.textAlign = 'right'
      ctx.textBaseline = 'bottom'
      ctx.fillStyle = ink.secondary
      const lineHeight = Math.round(parseFloat(token('--text-small-size')) * 1.3 * dpr)
      const right = u.bbox.left + u.bbox.width
      const gap = (stroke + hairline) * dpr
      const labels = shown
        .map((s, i) => {
          const text = s.directLabel ?? s.shortLabel ?? s.label
          const from = Math.max(0, u.posToIdx((right - ctx.measureText(text).width - gap - u.bbox.left) / dpr))
          // Where each line runs under the label's width: [highest, lowest] in canvas pixels.
          const spans = ds.series.map((values) => {
            let top = Infinity
            let bottom = -Infinity
            for (let k = from; k < values.length; k++) {
              const v = values[k]
              if (v == null) continue
              const y = u.valToPos(v, 'y', true)
              top = Math.min(top, y)
              bottom = Math.max(bottom, y)
            }
            return { top, bottom }
          })
          return Number.isFinite(spans[i]!.top) ? { text, y: spans[i]!.top - gap, spans } : null
        })
        .filter((l) => l !== null)
        .sort((a, b) => b.y - a.y)
      // From the bottom up: each label sits above its own line, clear of every line that
      // passes under its width, and at least one text line above the label below it.
      let below = Infinity
      for (const l of labels) {
        let y = Math.min(l.y, below - lineHeight)
        for (let pass = 0; pass < l.spans.length; pass++) {
          const hit = l.spans.find((sp) => sp.top - gap < y && sp.bottom + gap > y - lineHeight)
          if (!hit) break
          y = hit.top - gap
        }
        y = Math.max(u.bbox.top + lineHeight, y)
        below = y
        ctx.fillText(l.text, right, y)
      }
      ctx.restore()
    }

    const opts: uPlot.Options = {
      width,
      height,
      padding: [length('--space-2'), length('--space-6'), 0, 0],
      legend: { show: false },
      focus: { alpha: 1 },
      cursor: {
        x: true,
        y: false,
        points: { size: length('--mark'), width: stroke },
        drag: { x: true, y: false, setScale: false },
        focus: { prox: length('--space-6') },
        sync: syncKey ? { key: syncKey } : undefined,
      },
      scales: {
        x: { time: true, range: () => xRange },
        y: {
          range: (_u, min, max) => {
            if (min === max) {
              const d = Math.abs(min) > 0 ? Math.abs(min) * 0.1 : 1
              return [min - d, max + d]
            }
            const r = uPlot.rangeNum(min, max, 0.08, true)
            return [r[0], r[1]]
          },
        },
      },
      axes: [
        {
          stroke: ink.muted,
          font: axisFont,
          grid: { show: false },
          ticks: { show: false },
          // The baseline: the one chart line that has to be seen.
          border: { show: true, stroke: token('--rule-control'), width: hairline },
          values: timeTicks,
          space: length('--space-12') + length('--space-4'),
          size: length('--space-8') + length('--space-2'),
          gap: length('--space-2'),
        },
        {
          stroke: ink.muted,
          font: axisFont,
          grid: { stroke: rule, width: hairline },
          ticks: { show: false },
          values: (_u, splits) => splits.map((v) => cb.current.formatValue(v)),
          gap: length('--space-2'),
          size(self, values, axisIdx, cycleNum) {
            const axis = self.axes[axisIdx] as uPlot.Axis & { _size?: number }
            if (cycleNum > 1) return axis._size ?? length('--space-12')
            let longest = ''
            for (const v of values ?? []) if (v.length > longest.length) longest = v
            self.ctx.font = deviceFont(axisFont, dpr)
            return Math.ceil(self.ctx.measureText(longest).width / dpr) + length('--space-3')
          },
        },
      ],
      series: [
        {},
        ...shown.map(
          (s, i): uPlot.Series => ({
            label: s.shortLabel ?? s.label,
            stroke: colors[i],
            width: s.other ? hairline : stroke,
            spanGaps: false,
            points: { size: length('--space-1') + stroke },
          }),
        ),
      ],
      hooks: {
        draw: [drawLabels],
        setCursor: [renderTip],
        setSeries: [
          (u, sidx) => {
            focused = sidx
            renderTip(u)
          },
        ],
        setSelect: [
          (u) => {
            const { left, width: w } = u.select
            if (w < length('--space-1')) return
            const from = u.posToVal(left, 'x')
            const to = u.posToVal(left + w, 'x')
            u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false)
            if (to - from >= 1) cb.current.onZoom?.(from, to)
          },
        ],
      },
    }

    const data: uPlot.AlignedData = [ds.xs, ...(ds.series as (number | null)[][])]
    const u = new uPlot(opts, data, host)
    plotRef.current = u
    host.querySelector('canvas')?.setAttribute('aria-hidden', 'true')

    // Touch: a drag moves the crosshair (uPlot itself listens to the mouse only). Vertical
    // drags still scroll the page (touch-action: pan-y on the container).
    const onTouch = (e: PointerEvent) => {
      if (e.pointerType === 'mouse') return
      const r = u.over.getBoundingClientRect()
      u.setCursor({ left: e.clientX - r.left, top: e.clientY - r.top })
    }
    u.over.addEventListener('pointerdown', onTouch)
    u.over.addEventListener('pointermove', onTouch)

    // The canvas cannot wait for the fonts; redraw once they are in.
    let alive = true
    if (document.fonts.status !== 'loaded') void document.fonts.ready.then(() => alive && u.redraw(false))

    return () => {
      alive = false
      plotRef.current = null
      tip.hidden = true
      u.destroy()
    }
    // formatValue / callbacks are read through refs; xRange is compared by value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [xs, series, visible, size, theme, syncKey, xRange[0], xRange[1]])

  // Keyboard: arrows move the crosshair; values are announced politely.
  const onKeyDown = (e: React.KeyboardEvent) => {
    const u = plotRef.current
    if (!u) return
    const n = u.data[0]!.length
    if (n === 0) return
    if (e.key === 'Escape') {
      u.setCursor({ left: -10, top: -10 })
      return
    }
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return
    e.preventDefault()
    const stepBy = e.shiftKey ? 10 : 1
    const cur = u.cursor.idx ?? (e.key === 'ArrowLeft' ? n : -1)
    const idx =
      e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : Math.max(0, Math.min(n - 1, cur + (e.key === 'ArrowLeft' ? -stepBy : stepBy)))
    u.setCursor({ left: u.valToPos(u.data[0]![idx]!, 'x'), top: u.over.clientHeight / 2 })
    if (liveRef.current) {
      const parts: string[] = []
      for (let i = 1; i < u.data.length && parts.length < 3; i++) {
        const v = u.data[i]![idx]
        if (v != null) parts.push(`${u.series[i]!.label}: ${cb.current.formatValue(v)}`)
      }
      liveRef.current.textContent = `${fullTime(u.data[0]![idx]!)}. ${parts.join('; ') || 'no data'}`
    }
  }

  return (
    <div
      ref={wrapRef}
      className="plot"
      tabIndex={0}
      role="group"
      aria-label={ariaLabel}
      aria-roledescription="time series chart"
      onKeyDown={onKeyDown}
      data-testid="chart"
    >
      <div ref={hostRef} />
      <div ref={tipRef} className="vz-menu chart-tip" hidden aria-hidden="true" />
      <div ref={liveRef} className="sr-only" aria-live="polite" />
    </div>
  )
})
