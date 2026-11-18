import { useMemo, useState } from 'react'
import { formatDateTime } from '../lib/time'
import type { LegendRow } from './Legend'
import { SortHead } from './Legend'

interface Row extends LegendRow {
  labels: Record<string, string>
}

const MAX_ROWS = 500

/** Instant value per series: the last sample of each series in the window, by label. */
export function ResultTable({ rows, format }: { rows: Row[]; format: (v: number | null) => string }) {
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 }>({ key: '', dir: 1 })

  const columns = useMemo(() => {
    const set = new Set<string>()
    for (const r of rows) for (const k of Object.keys(r.labels)) set.add(k)
    const names = [...set].sort()
    // The metric name first, when present.
    return names.includes('__name__') ? ['__name__', ...names.filter((n) => n !== '__name__')] : names
  }, [rows])

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
      <p className="vz-panel-desc">
        The latest value of each series in the range.
        {sorted.length > MAX_ROWS ? ` Showing the first ${MAX_ROWS} of ${sorted.length} series; narrow the query to see the rest.` : ''}
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
              {head('#value', 'Value', true)}
              <th scope="col" className="vz-label vz-right">
                At
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.slice(0, MAX_ROWS).map((r) => (
              <tr key={r.id}>
                {columns.length === 0 && <td className="vz-num">{r.name}</td>}
                {columns.map((c) => (
                  <td key={c} className="vz-num">
                    {r.labels[c] ?? <span className="cell-quiet">none</span>}
                  </td>
                ))}
                <td className="vz-num vz-right">{format(r.stats.last)}</td>
                <td className="vz-num vz-right cell-quiet">{r.stats.lastAt == null ? 'none' : formatDateTime(r.stats.lastAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
