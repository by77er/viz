import { describe, expect, it } from 'vitest'
import { orderWords, sortRows, type TableRow } from './ResultTable'

const row = (id: string, last: number | null, service = id): TableRow => ({ id, full: id, labels: { service }, last, lastAt: last == null ? null : 100, text: String(last) })

describe('the table\'s caption states the order the rows are in', () => {
  const rows = [row('auth', 136), row('gone', null), row('catalog', 572), row('checkout', 102)]
  it('highest value first is the order it opens in; a series with no value comes last either way', () => {
    expect(sortRows(rows, { key: '#value', dir: -1 }).map((r) => r.id)).toEqual(['catalog', 'auth', 'checkout', 'gone'])
    expect(sortRows(rows, { key: '#value', dir: 1 }).map((r) => r.id)).toEqual(['checkout', 'auth', 'catalog', 'gone'])
    expect(orderWords({ key: '#value', dir: -1 })).toBe('highest value first')
    expect(orderWords({ key: '#value', dir: 1 })).toBe('lowest value first')
  })
  it('by a label, A to Z or Z to A, numbers in a label read as numbers', () => {
    expect(sortRows(rows, { key: 'service', dir: 1 }).map((r) => r.id)).toEqual(['auth', 'catalog', 'checkout', 'gone'])
    expect(sortRows([row('a', 1, 'pod-10'), row('b', 1, 'pod-9')], { key: 'service', dir: 1 }).map((r) => r.id)).toEqual(['b', 'a'])
    expect(orderWords({ key: 'service', dir: 1 })).toBe('by service, A to Z')
    expect(orderWords({ key: '__name__', dir: -1 })).toBe('by metric, Z to A')
  })
  it('sorting does not change the rows it was given', () => {
    const before = rows.map((r) => r.id)
    sortRows(rows, { key: '#value', dir: -1 })
    expect(rows.map((r) => r.id)).toEqual(before)
  })
})
