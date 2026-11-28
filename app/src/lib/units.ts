/**
 * The units a result can be shown in, and the guess of a query's unit. How a value is scaled and
 * written is the chart's (charts/spec.ts hands it the unit; the design system's rules format).
 */

export type UnitId = 'none' | 'seconds' | 'bytes' | 'percentunit' | 'percent' | 'rps' | 'cores' | 'bytes/s'

export const UNITS: { id: UnitId; label: string }[] = [
  { id: 'none', label: 'number' },
  { id: 'rps', label: 'per second (/s)' },
  { id: 'seconds', label: 'seconds' },
  { id: 'bytes', label: 'bytes (IEC)' },
  { id: 'bytes/s', label: 'bytes per second' },
  { id: 'percentunit', label: 'percent (0–1)' },
  { id: 'percent', label: 'percent (0–100)' },
  { id: 'cores', label: 'CPU cores' },
]

export function isUnitId(s: string): s is UnitId {
  return UNITS.some((u) => u.id === s)
}

/**
 * Guess the unit of a PromQL expression from metric-name conventions. This is a heuristic
 * for Explore (dashboard panels declare their unit); the user can always override it.
 */
export function inferUnit(query: string): UnitId {
  const q = query.replace(/"(?:[^"\\]|\\.)*"/g, '""')
  // A ratio of two expressions has no knowable unit.
  if (/\)\s*\/\s*(?:sum|avg|max|min|count|rate|increase|\()/.test(q)) return 'none'
  if (/\bcount(?:_over_time)?\s*(?:by|without)?\s*\(/.test(q) && !/_bucket/.test(q)) return 'none'
  const isRate = /\b(?:rate|irate)\s*\(/.test(q)
  if (/\bhistogram_quantile\s*\(/.test(q)) return /_seconds_bucket/.test(q) ? 'seconds' : /_bytes_bucket/.test(q) ? 'bytes' : 'none'
  if (/_bytes(?:_total)?\b/.test(q)) return isRate ? 'bytes/s' : 'bytes'
  if (/_seconds_(?:sum|count|bucket)\b/.test(q)) return isRate ? 'rps' : 'none'
  if (/_seconds(?:_total)?\b/.test(q)) return isRate ? 'none' : 'seconds'
  if (/_ratio\b/.test(q)) return 'percentunit'
  if (/_percent\b/.test(q)) return 'percent'
  if (/_cores\b/.test(q)) return 'cores'
  if (isRate) return 'rps'
  return 'none'
}
