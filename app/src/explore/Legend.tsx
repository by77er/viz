import { useMemo, useState } from 'react'
import type { SeriesStats } from '../lib/series'

export interface LegendRow {
  id: string
  name: string
  /** CSS custom property holding the series colour; a neutral ink for series folded into Other. */
  colorVar: string
  /** True when the series has no colour of its own (a ninth series and beyond). */
  other: boolean
  stats: SeriesStats
}

type SortKey = 'name' | 'last' | 'min' | 'max'

interface Props {
  rows: LegendRow[]
  /** Ids drawn on the chart; null = all. */
  visible: ReadonlySet<string> | null
  onToggle: (id: string, additive: boolean) => void
  onShowAll: () => void
  format: (v: number | null) => string
}

/** A sample of the line: the series colour never appears anywhere else. */
export function Swatch({ colorVar }: { colorVar: string }) {
  return <i className="swatch" aria-hidden="true" style={{ background: `var(${colorVar})` }} />
}

/** Column head that sorts. The arrow is text; the direction is also in aria-sort. */
export function SortHead({
  label,
  active,
  dir,
  numeric,
  onSort,
}: {
  label: string
  active: boolean
  dir: 1 | -1
  numeric?: boolean
  onSort: () => void
}) {
  return (
    <th scope="col" className={numeric ? 'vz-label vz-right' : 'vz-label'} aria-sort={active ? (dir === 1 ? 'ascending' : 'descending') : undefined}>
      <button className="th-button" onClick={onSort}>
        {label}
        {active && <span aria-hidden="true"> {dir === 1 ? '↑' : '↓'}</span>}
      </button>
    </th>
  )
}

export function Legend({ rows, visible, onToggle, onShowAll, format }: Props) {
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

  const head = (key: SortKey, label: string, numeric: boolean) => {
    const active = sort.key === key
    return (
      <SortHead
        label={label}
        active={active}
        dir={sort.dir}
        numeric={numeric}
        onSort={() => setSort({ key, dir: active ? (sort.dir === 1 ? -1 : 1) : numeric ? -1 : 1 })}
      />
    )
  }

  const shownCount = visible ? rows.filter((r) => visible.has(r.id)).length : rows.length
  const otherCount = rows.filter((r) => r.other).length

  return (
    <div data-testid="legend" className="region-part">
      <div className="caption-row">
        <p className="vz-panel-desc">
          {shownCount < rows.length ? `Showing ${shownCount} of ${rows.length} series. ` : ''}
          {otherCount > 0 ? `${rows.length - otherCount} series have a colour; the other ${otherCount} are drawn in grey. ` : ''}
          Select a series to show it alone, or with Shift to add or remove it.
        </p>
        {shownCount < rows.length && (
          <button className="vz-button" data-size="sm" onClick={onShowAll}>
            Show all series
          </button>
        )}
      </div>
      <div className="vz-table-wrap">
        <table className="vz-table legend-table">
          <thead>
            <tr>
              {head('name', 'Series', false)}
              {head('last', 'Last', true)}
              {head('min', 'Min', true)}
              {head('max', 'Max', true)}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => {
              const on = !visible || visible.has(r.id)
              return (
                <tr key={r.id}>
                  <td>
                    <button
                      className="series-toggle"
                      aria-pressed={on}
                      onClick={(e) => onToggle(r.id, e.metaKey || e.ctrlKey || e.shiftKey)}
                      data-series={r.name}
                    >
                      <Swatch colorVar={r.colorVar} />
                      <span className="vz-num">{r.name}</span>
                      {r.other && <span className="cell-quiet">Other</span>}
                    </button>
                  </td>
                  <td className="vz-num vz-right">{format(r.stats.last)}</td>
                  <td className="vz-num vz-right">{format(r.stats.min)}</td>
                  <td className="vz-num vz-right">{format(r.stats.max)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
