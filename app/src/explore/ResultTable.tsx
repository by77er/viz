import { memo, useMemo, useState } from 'react'
import { countRender } from '../lib/renders'
import { formatDateTime } from '../lib/time'
import { columnFormat, headWithUnit, type UnitId } from '../lib/units'
import type { LegendRow } from './Legend'
import { SortHead } from './Legend'

interface Row extends LegendRow {
  labels: Record<string, string>
}

/** Rows rendered at once; the rest come with "Show more", so a 200-series result costs what a 50-series one does. */
export const TABLE_PAGE = 50

interface Props {
  rows: Row[]
  unit: UnitId
  /** Labels that differ between the series, most distinguishing first: the columns, in this order. */
  columns: string[]
  /** Labels every series shares: said once above the table, not repeated in a column. */
  common: Record<string, string>
}

/** Instant value per series: the last sample of each series in the window, by label. */
export const ResultTable = memo(function ResultTable({ rows, unit, columns, common }: Props) {
  countRender('ResultTable')
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 }>({ key: '', dir: 1 })
  const [limit, setLimit] = useState(TABLE_PAGE)

  const sorted = useMemo(() => {
    if (!sort.key) return rows
    const out = [...rows]
    out.sort((a, b) => {
      if (sort.key === '#value') {
        const av = a.stats.last
        const bv = b.stats.last
        if (av == null) return bv == null ? 0 : 1
        if (bv == null) return -1
        return sort.dir * (av - bv)
      }
      const av = a.labels[sort.key] ?? ''
      const bv = b.labels[sort.key] ?? ''
      return sort.dir * av.localeCompare(bv, undefined, { numeric: true })
    })
    return out
  }, [rows, sort])

  // The unit goes in the head once when the column has one scale; otherwise each value keeps it.
  const value = useMemo(() => columnFormat(rows.map((r) => r.stats.last), unit), [rows, unit])
  // One timestamp for every row is said once, in the caption; a column only when they differ.
  const at = useMemo(() => {
    const first = rows.find((r) => r.stats.lastAt != null)?.stats.lastAt ?? null
    return rows.every((r) => r.stats.lastAt == null || r.stats.lastAt === first) ? first : undefined
  }, [rows])
  const shared = Object.keys(common).sort()

  const head = (key: string, label: string, numeric = false) => {
    const active = sort.key === key
    return (
      <SortHead
        key={key}
        label={label}
        active={active}
        dir={sort.dir}
        numeric={numeric}
        onSort={() => setSort({ key, dir: active ? (sort.dir === 1 ? -1 : 1) : numeric ? -1 : 1 })}
      />
    )
  }

  return (
    <div data-testid="result-table" className="region-part">
      <p className="vz-panel-desc" data-testid="table-caption">
        The latest value of each series in the range
        {at != null ? (
          <>
            , at <span className="app-num">{formatDateTime(at)}</span>
          </>
        ) : null}
        .
        {shared.length > 0 && columns.length > 0 && (
          <>
            {' '}
            Every series has{' '}
            {shared.map((k, i) => (
              <span key={k}>
                {i > 0 ? ', ' : ''}
                <span className="app-num">{k === '__name__' ? common[k] : `${k}=${JSON.stringify(common[k])}`}</span>
              </span>
            ))}
            .
          </>
        )}
        {sorted.length > limit ? ` Showing ${limit} of ${sorted.length} series.` : ''}
      </p>
      <div className="vz-table-wrap">
        <table className="vz-table">
          <caption className="sr-only">Latest value of each series in the selected time range</caption>
          <thead>
            <tr>
              {columns.length === 0 && (
                <th scope="col" className="vz-label">
                  Series
                </th>
              )}
              {columns.map((c) => head(c, c === '__name__' ? 'Metric' : c))}
              {head('#value', headWithUnit('Value', value.unit), true)}
              {at === undefined && (
                <th scope="col" className="vz-label vz-right">
                  At
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {sorted.slice(0, limit).map((r) => (
              <tr key={r.id}>
                {columns.length === 0 && <td className="vz-num">{r.full}</td>}
                {columns.map((c) => (
                  <td key={c} className="vz-num">
                    {r.labels[c] ?? <span className="cell-quiet">none</span>}
                  </td>
                ))}
                <td className="vz-num vz-right">{value.cell(r.stats.last)}</td>
                {at === undefined && <td className="vz-num vz-right cell-quiet">{r.stats.lastAt == null ? 'none' : formatDateTime(r.stats.lastAt)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {sorted.length > limit && (
        <div className="caption-row">
          <button
            className="vz-button"
            data-size="sm"
            onClick={() => setLimit((n) => n + TABLE_PAGE)}
            data-focus-after="[data-testid=result-table] .th-button"
            data-testid="table-more"
          >
            Show {Math.min(TABLE_PAGE, sorted.length - limit)} more of {sorted.length}
          </button>
        </div>
      )}
    </div>
  )
})
