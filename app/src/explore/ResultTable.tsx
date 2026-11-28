import { memo, useMemo, useState } from 'react'
import { countRender } from '../lib/renders'
import { momentText } from '../lib/timeInput'

export interface TableRow {
  id: string
  /** The series' full name, for a result of one series with no label to tell it by. */
  full: string
  labels: Record<string, string>
  /** The latest value in the range, and when it was sampled (epoch seconds). */
  last: number | null
  lastAt: number | null
  /** `last` in the chart's unit and number format (charts/spec.ts, `figureFormat`): the legend's figure. */
  text: string
}

/** Rows rendered at once; the rest come with "Show more", so a 200-series result costs what a 50-series one does. */
export const TABLE_PAGE = 50

interface Props {
  rows: TableRow[]
  /** The unit of the value column, said once in its head. Empty for plain numbers. */
  unit: string
  /** Labels that differ between the series, most distinguishing first: the columns, in this order. */
  columns: string[]
  /** Labels every series shares: said once under the table, not repeated in a column. */
  common: Record<string, string>
  nowMs: number
}

type Sort = { key: string; dir: 1 | -1 }
const VALUE = '#value'

/** The order as the caption states it (Table: "how many rows of how many and in what order"). */
export function orderWords(sort: Sort): string {
  if (sort.key === VALUE) return sort.dir === -1 ? 'highest value first' : 'lowest value first'
  return `by ${sort.key === '__name__' ? 'metric' : sort.key}, ${sort.dir === 1 ? 'A to Z' : 'Z to A'}`
}

export function sortRows(rows: readonly TableRow[], sort: Sort): TableRow[] {
  const out = [...rows]
  out.sort((a, b) => {
    if (sort.key === VALUE) {
      // A series with no value in the range comes last, whichever way the column is sorted.
      if (a.last == null) return b.last == null ? 0 : 1
      if (b.last == null) return -1
      return sort.dir * (a.last - b.last)
    }
    return sort.dir * (a.labels[sort.key] ?? '').localeCompare(b.labels[sort.key] ?? '', undefined, { numeric: true })
  })
  return out
}

/** The latest value of each series in the range, one column per label that tells the series apart. */
export const ResultTable = memo(function ResultTable({ rows, unit, columns, common, nowMs }: Props) {
  countRender('ResultTable')
  const [sort, setSort] = useState<Sort>({ key: VALUE, dir: -1 })
  const [limit, setLimit] = useState(TABLE_PAGE)
  const sorted = useMemo(() => sortRows(rows, sort), [rows, sort])
  const visible = sorted.slice(0, limit)
  // One timestamp for every row is said once, in the caption; a column only when they differ.
  const at = useMemo(() => {
    const first = rows.find((r) => r.lastAt != null)?.lastAt ?? null
    return rows.every((r) => r.lastAt == null || r.lastAt === first) ? first : undefined
  }, [rows])
  const shared = Object.keys(common)
    .filter((k) => k !== '__name__')
    .sort()

  const head = (key: string, label: string, numeric = false) => {
    const active = sort.key === key
    return (
      <th key={key} scope="col" className={numeric ? 'vz-label vz-right' : 'vz-label'} aria-sort={active ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined}>
        <button className="vz-sort" onClick={() => setSort({ key, dir: active ? (sort.dir === 1 ? -1 : 1) : numeric ? -1 : 1 })}>
          {label}
        </button>
      </th>
    )
  }

  return (
    <div data-testid="result-table">
      <p className="vz-table-caption" data-testid="table-caption">
        <span className="vz-qty">{visible.length}</span> of <span className="vz-qty">{sorted.length}</span> series, {orderWords(sort)}
        {at != null ? (
          <>
            . The latest value of each, at <span className="vz-qty">{momentText(at, nowMs)}</span>
          </>
        ) : (
          '. The latest value of each in the range'
        )}
        .
      </p>
      {/* A stack: what follows the table (the shared labels, "Show 50 more") stands clear of its last row, so the button's 44 px hit area is its own with a coarse pointer (design review B2). */}
      <div className="vz-stack">
      <div className="vz-table-wrap">
        <table className="vz-table">
          <thead>
            <tr>
              {columns.length === 0 && (
                <th scope="col" className="vz-label">
                  Series
                </th>
              )}
              {columns.map((c) => head(c, c === '__name__' ? 'Metric' : c))}
              {head(VALUE, unit ? `Value, ${unit}` : 'Value', true)}
              {at === undefined && (
                <th scope="col" className="vz-label">
                  At
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr key={r.id}>
                {columns.length === 0 && <td className="vz-num">{r.full}</td>}
                {columns.map((c) => (
                  <td key={c} className="vz-num">
                    {r.labels[c] ?? 'none'}
                  </td>
                ))}
                <td className="vz-num vz-right">{r.text}</td>
                {at === undefined && <td className="vz-num">{r.lastAt == null ? 'no value' : momentText(r.lastAt, nowMs)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {shared.length > 0 && columns.length > 0 && (
        <p className="vz-secondary" data-size="sm" data-testid="table-common">
          All series: <span className="vz-qty">{shared.map((k) => `${k}=${JSON.stringify(common[k])}`).join(', ')}</span>
        </p>
      )}
      {sorted.length > limit && (
        <div className="vz-controls">
          <button className="vz-button" data-size="sm" onClick={() => setLimit((n) => n + TABLE_PAGE)} data-focus-after="[data-testid=result-table] .vz-sort" data-testid="table-more">
            Show {Math.min(TABLE_PAGE, sorted.length - limit)} more of {sorted.length}
          </button>
        </div>
      )}
      </div>
    </div>
  )
})
