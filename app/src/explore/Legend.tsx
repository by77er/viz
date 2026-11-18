import { useMemo, useState } from 'react'
import type { SeriesStats } from '../lib/series'

export interface LegendRow {
  id: string
  name: string
  color: string
  dash: readonly number[]
  stats: SeriesStats
}

type SortKey = 'name' | 'last' | 'min' | 'max'

interface Props {
  rows: LegendRow[]
  /** Ids drawn on the chart; null = all. */
  visible: ReadonlySet<string> | null
  onToggle: (id: string, additive: boolean) => void
  onShowAll: () => void
  onHover: (id: string | null) => void
  format: (v: number | null) => string
}

/** A line sample that shows both the colour and the dash pattern (the secondary encoding). */
export function Swatch({ color, dash }: { color: string; dash: readonly number[] }) {
  return (
    <svg width="18" height="8" viewBox="0 0 18 8" aria-hidden="true" className="shrink-0">
      <line x1="1" y1="4" x2="17" y2="4" stroke={color} strokeWidth="2.5" strokeLinecap="butt" strokeDasharray={dash.length ? dash.map((d) => d * 0.7).join(' ') : undefined} />
    </svg>
  )
}

export function Legend({ rows, visible, onToggle, onShowAll, onHover, format }: Props) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'name', dir: 1 })

  const sorted = useMemo(() => {
    const out = [...rows]
    const { key, dir } = sort
    out.sort((a, b) => {
      if (key === 'name') return dir * (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
      const av = a.stats[key]
      const bv = b.stats[key]
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      return dir * (av - bv)
    })
    return out
  }, [rows, sort])

  const header = (key: SortKey, label: string, numeric: boolean) => {
    const active = sort.key === key
    return (
      <th scope="col" className={numeric ? 'num w-[1%]' : ''} aria-sort={active ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined}>
        <button
          onClick={() => setSort({ key, dir: active ? (sort.dir === 1 ? -1 : 1) : numeric ? -1 : 1 })}
          title={`Sort by ${label}`}
        >
          {label}
          <span aria-hidden="true" className="inline-block w-3 text-[9px]">
            {active ? (sort.dir === 1 ? '▲' : '▼') : ''}
          </span>
        </button>
      </th>
    )
  }

  const hiddenCount = visible ? rows.length - rows.filter((r) => visible.has(r.id)).length : 0

  return (
    <div data-testid="legend">
      <div className="flex items-center justify-between gap-2 border-y border-line px-2.5 py-1 text-[11.5px] text-fg-3">
        <span>
          <span className="tnum">{rows.length}</span> series
          {hiddenCount > 0 && (
            <>
              {' · '}
              <span className="tnum">{rows.length - hiddenCount}</span> shown
            </>
          )}
          <span className="hidden sm:inline"> · click to isolate, Ctrl/⌘-click to toggle</span>
        </span>
        {hiddenCount > 0 && (
          <button className="font-medium text-fg-2 underline hover:text-fg" onClick={onShowAll}>
            Show all
          </button>
        )}
      </div>
      <div className="max-h-[236px] overflow-auto" onMouseLeave={() => onHover(null)}>
        <table className="dt">
          <thead>
            <tr>
              {header('name', 'Series', false)}
              {header('last', 'Last', true)}
              {header('min', 'Min', true)}
              {header('max', 'Max', true)}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => {
              const on = !visible || visible.has(r.id)
              return (
                <tr key={r.id} onMouseEnter={() => onHover(on ? r.id : null)} className={on ? '' : 'opacity-45'}>
                  <td className="!p-0">
                    <button
                      className="flex min-h-[25px] w-full items-center gap-2 px-2.5 py-[3px] text-left"
                      aria-pressed={on}
                      title={`${r.name}\nClick to isolate; Ctrl/⌘-click to toggle`}
                      onClick={(e) => onToggle(r.id, e.metaKey || e.ctrlKey || e.shiftKey)}
                      data-series={r.name}
                    >
                      <Swatch color={r.color} dash={r.dash} />
                      <span className="mono">{r.name}</span>
                    </button>
                  </td>
                  <td className="num">{format(r.stats.last)}</td>
                  <td className="num">{format(r.stats.min)}</td>
                  <td className="num">{format(r.stats.max)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
