import { memo, useMemo, useState } from 'react'
import { countRender } from '../lib/renders'
import { additiveToggle } from '../lib/pointer'
import type { SeriesStats } from '../lib/series'
import { columnFormat, headWithUnit, type UnitId } from '../lib/units'

export interface LegendRow {
  id: string
  /** What tells this series from the others, shortened in the middle where that keeps it unique (lib/naming). */
  name: string
  /** The full label set: the row's title (its accessible description), and shown under the table for the row that has focus. */
  full: string
  /** CSS custom property holding the series colour; a neutral ink for series folded into Other. */
  colorVar: string
  /** True when the series has no colour of its own: a member of the Other group. */
  other: boolean
  stats: SeriesStats
}

type SortKey = 'name' | 'last' | 'min' | 'max'

interface Props {
  rows: LegendRow[]
  /** Ids drawn on the chart. */
  drawn: ReadonlySet<string>
  /** True when `drawn` is what the view draws by itself: nothing was hidden or added by the person. */
  isDefault: boolean
  onToggle: (id: string, additive: boolean) => void
  onShowAll: () => void
  unit: UnitId
  /** The primary pointer is a finger: a tap toggles, and the hint does not mention Shift. */
  coarse: boolean
}

/** Members of Other listed at once; the rest come with "Show more". */
export const OTHER_PAGE = 50

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

function sortRows(rows: LegendRow[], key: SortKey, dir: 1 | -1): LegendRow[] {
  const out = [...rows]
  out.sort((a, b) => {
    if (key === 'name') return dir * (a.full < b.full ? -1 : a.full > b.full ? 1 : 0)
    const av = a.stats[key]
    const bv = b.stats[key]
    if (av == null && bv == null) return 0
    if (av == null) return 1
    if (bv == null) return -1
    return dir * (av - bv)
  })
  return out
}

/**
 * The legend: one row per coloured series, then ONE row for the Other group, which opens to
 * list its members (a window of them at a time). Each of the three value columns states its
 * unit once, in its head.
 */
export const Legend = memo(function Legend({ rows, drawn, isDefault, onToggle, onShowAll, unit, coarse }: Props) {
  countRender('Legend')
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'name', dir: 1 })
  const [open, setOpen] = useState(false)
  const [limit, setLimit] = useState(OTHER_PAGE)
  const [focused, setFocused] = useState<string | null>(null)

  const coloured = useMemo(() => sortRows(rows.filter((r) => !r.other), sort.key, sort.dir), [rows, sort])
  const others = useMemo(() => sortRows(rows.filter((r) => r.other), sort.key, sort.dir), [rows, sort])
  // One scale for the three value columns, from every value in them: Last, Min and Max are
  // compared across a row, so they share a scale. Each head carries the unit, once.
  const formats = useMemo(() => {
    const all = columnFormat(rows.flatMap((r) => [r.stats.last, r.stats.min, r.stats.max]), unit)
    return { last: all, min: all, max: all }
  }, [rows, unit])
  const otherRange = useMemo(() => {
    let min: number | null = null
    let max: number | null = null
    for (const r of others) {
      if (r.stats.min != null && (min === null || r.stats.min < min)) min = r.stats.min
      if (r.stats.max != null && (max === null || r.stats.max > max)) max = r.stats.max
    }
    return { min, max }
  }, [others])

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

  const shownCount = rows.filter((r) => drawn.has(r.id)).length
  const focusedRow = focused === null ? undefined : rows.find((r) => r.id === focused)
  const row = (r: LegendRow) => (
    <tr key={r.id}>
      <td>
        <button
          className="series-toggle"
          aria-pressed={drawn.has(r.id)}
          title={r.full}
          onClick={(e) => onToggle(r.id, additiveToggle({ ...modifiers(e), pointerType: (e.nativeEvent as PointerEvent).pointerType }, coarse))}
          data-series={r.full}
          data-series-id={r.id}
        >
          <Swatch colorVar={r.colorVar} />
          <span className="vz-num">{r.name}</span>
        </button>
      </td>
      <td className="vz-num vz-right">{formats.last.cell(r.stats.last)}</td>
      <td className="vz-num vz-right">{formats.min.cell(r.stats.min)}</td>
      <td className="vz-num vz-right">{formats.max.cell(r.stats.max)}</td>
    </tr>
  )

  return (
    <div data-testid="legend" className="region-part">
      <div className="caption-row">
        <p className="vz-panel-desc" data-testid="legend-caption">
          {!isDefault
            ? `Showing ${shownCount} of ${rows.length} series. `
            : others.length > 0
              ? `${coloured.length} of ${rows.length} series are drawn, the largest by their mean. The other ${others.length} are listed under Other and drawn when selected. `
              : ''}
          {coarse ? 'Tap a series to hide or show it.' : 'Select a series to show it alone, or with Shift to add or remove it.'}
        </p>
        {!isDefault && (
          <button className="vz-button" data-size="sm" onClick={onShowAll} data-focus-after="[data-testid=legend] .series-toggle" data-testid="show-all">
            {others.length > 0 ? 'Show the coloured series' : 'Show all series'}
          </button>
        )}
      </div>
      <div className="vz-table-wrap">
        <table className="vz-table legend-table">
          <thead>
            <tr>
              {head('name', 'Series', false)}
              {head('last', headWithUnit('Last', formats.last.unit), true)}
              {head('min', headWithUnit('Min', formats.min.unit), true)}
              {head('max', headWithUnit('Max', formats.max.unit), true)}
            </tr>
          </thead>
          <tbody
            onFocus={(e) => {
              const id = (e.target as HTMLElement).closest('[data-series-id]')?.getAttribute('data-series-id') ?? null
              setFocused((cur) => (cur === id ? cur : id))
            }}
          >
            {coloured.map(row)}
            {others.length > 0 && (
              <tr>
                <td>
                  <button className="series-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)} data-testid="legend-other">
                    <Swatch colorVar="--ink-muted" />
                    <span>
                      Other, <span className="vz-num">{others.length}</span> series
                    </span>
                    <span className="cell-quiet">{open ? 'Hide them' : 'List them'}</span>
                  </button>
                </td>
                <td className="vz-num vz-right cell-quiet">–</td>
                <td className="vz-num vz-right">{formats.min.cell(otherRange.min)}</td>
                <td className="vz-num vz-right">{formats.max.cell(otherRange.max)}</td>
              </tr>
            )}
            {open && others.slice(0, limit).map(row)}
            {open && others.length > limit && (
              <tr>
                <td colSpan={4}>
                  <button
                    className="vz-button"
                    data-size="sm"
                    onClick={() => setLimit((n) => n + OTHER_PAGE)}
                    data-focus-after="[data-testid=legend-other]"
                    data-testid="legend-more"
                  >
                    Show {Math.min(OTHER_PAGE, others.length - limit)} more of {others.length}
                  </button>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {/* Under the table, so that showing it never moves a row away from the pointer. */}
      {focusedRow && focusedRow.full !== focusedRow.name && (
        <p className="vz-panel-desc" data-testid="legend-full">
          Full name: <span className="app-num">{focusedRow.full}</span>
        </p>
      )}
    </div>
  )
})

const modifiers = (e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) => ({ shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey })
