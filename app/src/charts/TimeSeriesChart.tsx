import { useEffect, useLayoutEffect, useRef, useState } from 'react'
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

/**
 * Line chart for time series, rendered with uPlot.
 *
 * - null values are gaps (`spanGaps: false`); nothing is interpolated.
 * - when there are more points than pixel columns, min/max-per-column downsampling is
 *   applied (lib/downsample), so extremes survive.
 * - horizontal drag selects a range and reports it via `onZoom`; the chart itself does not
 *   zoom, the owner changes the time range (and so the URL).
 */
export function TimeSeriesChart(props: TimeSeriesChartProps) {
  const { xs, series, xRange, height, visible, highlightId, formatValue, onZoom, onRenderInfo, syncKey, theme, ariaLabel } = props
  const wrapRef = useRef<HTMLDivElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const tipRef = useRef<HTMLDivElement>(null)
  const liveRef = useRef<HTMLDivElement>(null)
  const plotRef = useRef<uPlot | null>(null)
  const [width, setWidth] = useState(0)

  // Latest callbacks without re-creating the plot.
  const cb = useRef({ onZoom, onRenderInfo, formatValue })
  cb.current = { onZoom, onRenderInfo, formatValue }

  useLayoutEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const measure = () => setWidth(Math.floor(el.clientWidth))
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const host = hostRef.current
    const wrap = wrapRef.current
    const tip = tipRef.current
    if (!host || !wrap || !tip || width < 40) return

    const css = getComputedStyle(wrap)
    const token = (name: string) => css.getPropertyValue(name).trim()
    const axisColor = token('--chart-axis')
    const gridColor = token('--chart-grid')
    const font = `11px ${css.fontFamily}`

    const shown = series.filter((s) => !visible || visible.has(s.id))
    const dpr = window.devicePixelRatio || 1
    // The y axis takes ~56 CSS px; the estimate only decides how aggressively to downsample.
    const columns = Math.max(50, Math.round((width - 56) * dpr))
    const ds = downsampleMinMax(xs, shown.map((s) => s.values), columns)
    cb.current.onRenderInfo?.({ rawPoints: xs.length, drawnPoints: ds.xs.length, columns, downsampled: ds.downsampled })

    let focused: number | null = null

    const renderTip = (u: uPlot) => {
      const idx = u.cursor.idx
      const left = u.cursor.left ?? -1
      if (idx == null || left < 0) {
        tip.style.display = 'none'
        return
      }
      const rows: { name: string; color: string; value: number; focus: boolean }[] = []
      shown.forEach((s, i) => {
        const v = ds.series[i]![idx]
        if (v != null) rows.push({ name: s.label, color: s.color, value: v, focus: focused === i + 1 })
      })
      rows.sort((a, b) => b.value - a.value)
      let list = rows.slice(0, TIP_ROWS)
      const f = rows.find((r) => r.focus)
      if (f && !list.includes(f)) list = [...list.slice(0, TIP_ROWS - 1), f]

      tip.replaceChildren()
      const time = document.createElement('div')
      time.className = 'tip-time'
      time.textContent = fullTime(ds.xs[idx]!)
      tip.append(time)
      if (rows.length === 0) {
        const none = document.createElement('div')
        none.className = 'tip-more'
        none.textContent = 'no data at this time'
        tip.append(none)
      }
      for (const r of list) {
        const row = document.createElement('div')
        row.className = r.focus ? 'tip-row focus' : 'tip-row'
        const sw = document.createElement('span')
        sw.style.cssText = `width:10px;height:3px;border-radius:1px;background:${r.color}`
        const name = document.createElement('span')
        name.className = 'tip-name'
        name.textContent = r.name
        const val = document.createElement('span')
        val.className = 'tip-val'
        val.textContent = cb.current.formatValue(r.value)
        row.append(sw, name, val)
        tip.append(row)
      }
      if (rows.length > list.length) {
        const more = document.createElement('div')
        more.className = 'tip-more'
        more.textContent = `+${rows.length - list.length} more series`
        tip.append(more)
      }
      tip.style.display = 'block'
      const plotLeft = u.over.offsetLeft
      const x = plotLeft + left
      const tw = tip.offsetWidth
      const flip = x + 14 + tw > width
      tip.style.left = `${Math.max(0, flip ? x - 14 - tw : x + 14)}px`
      tip.style.top = `${u.over.offsetTop + 6}px`
    }

    const opts: uPlot.Options = {
      width,
      height,
      padding: [10, 12, 0, 0],
      legend: { show: false },
      focus: { alpha: 0.3 },
      cursor: {
        x: true,
        y: false,
        points: { size: 7, width: 1.5 },
        drag: { x: true, y: false, setScale: false },
        focus: { prox: 24 },
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
          stroke: axisColor,
          font,
          grid: { show: false },
          ticks: { stroke: gridColor, width: 1, size: 4 },
          values: timeTicks,
          space: 64,
          size: 38,
        },
        {
          stroke: axisColor,
          font,
          grid: { stroke: gridColor, width: 1 },
          ticks: { show: false },
          values: (_u, splits) => splits.map((v) => cb.current.formatValue(v)),
          gap: 6,
          size(self, values, axisIdx, cycleNum) {
            const axis = self.axes[axisIdx] as uPlot.Axis & { _size?: number }
            if (cycleNum > 1) return axis._size ?? 50
            let longest = ''
            for (const v of values ?? []) if (v.length > longest.length) longest = v
            self.ctx.font = `${11 * dpr}px ${css.fontFamily}`
            return Math.ceil(self.ctx.measureText(longest).width / dpr) + 14
          },
        },
      ],
      series: [
        {},
        ...shown.map(
          (s): uPlot.Series => ({
            label: s.label,
            stroke: s.color,
            width: 1.5,
            dash: s.dash.length ? [...s.dash] : undefined,
            spanGaps: false,
            points: { size: 4 },
          }),
        ),
      ],
      hooks: {
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
            if (w < 4) return
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
    const canvas = host.querySelector('canvas')
    canvas?.setAttribute('aria-hidden', 'true')

    return () => {
      plotRef.current = null
      tip.style.display = 'none'
      u.destroy()
    }
    // formatValue / callbacks are read through refs; xRange is compared by value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [xs, series, visible, width, height, theme, syncKey, xRange[0], xRange[1]])

  // Legend hover -> emphasise one series without rebuilding.
  useEffect(() => {
    const u = plotRef.current
    if (!u) return
    const shown = series.filter((s) => !visible || visible.has(s.id))
    const i = highlightId ? shown.findIndex((s) => s.id === highlightId) : -1
    u.setSeries(i >= 0 ? i + 1 : null, { focus: true })
  }, [highlightId, series, visible])

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
      className="relative w-full select-none"
      style={{ height }}
      tabIndex={0}
      role="group"
      aria-label={ariaLabel}
      aria-roledescription="time series chart"
      onKeyDown={onKeyDown}
      data-testid="chart"
    >
      <div ref={hostRef} />
      <div ref={tipRef} className="chart-tip" style={{ display: 'none' }} aria-hidden="true" />
      <div ref={liveRef} className="sr-only" aria-live="polite" />
    </div>
  )
}
