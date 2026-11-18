import { useMemo, useState } from 'react'
import { formatDateTime } from '../lib/time'
import type { LegendRow } from './Legend'
import { Swatch } from './Legend'

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

  const th = (key: string, label: string, numeric = false) => {
    const active = sort.key === key
    return (
      <th key={key} scope="col" className={numeric ? 'num' : ''} aria-sort={active ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined}>
        <button onClick={() => setSort({ key, dir: active ? (sort.dir === 1 ? -1 : 1) : numeric ? -1 : 1 })}>
          {label}
          <span aria-hidden="true" className="inline-block w-3 text-[9px]">
            {active ? (sort.dir === 1 ? '▲' : '▼') : ''}
          </span>
        </button>
      </th>
    )
  }

  return (
    <div className="max-h-[420px] overflow-auto" data-testid="result-table">
      <table className="dt">
        <caption className="sr-only">Latest value of each series in the selected time range</caption>
        <thead>
          <tr>
            <th scope="col" className="w-[1%]">
              <span className="sr-only">Colour</span>
            </th>
            {columns.map((c) => th(c, c === '__name__' ? 'metric' : c))}
            {th('#value', 'Value', true)}
            <th scope="col" className="num">
              <span>At</span>
            </th>
            <th aria-hidden="true" className="w-full" />
          </tr>
        </thead>
        <tbody>
          {sorted.slice(0, MAX_ROWS).map((r) => (
            <tr key={r.id}>
              <td className="!pr-0">
                <Swatch color={r.color} dash={r.dash} />
              </td>
              {columns.map((c) => (
                <td key={c} className="mono">
                  {r.labels[c] ?? <span className="text-fg-3">–</span>}
                </td>
              ))}
              <td className="num">{format(r.stats.last)}</td>
              <td className="num text-fg-3">{r.stats.lastAt == null ? '–' : formatDateTime(r.stats.lastAt)}</td>
              <td aria-hidden="true" />
            </tr>
          ))}
        </tbody>
      </table>
      {sorted.length > MAX_ROWS && (
        <div className="border-t border-line px-2.5 py-1.5 text-[12px] text-fg-3">
          Showing the first {MAX_ROWS} of {sorted.length} series. Narrow the query to see the rest.
        </div>
      )}
    </div>
  )
}
