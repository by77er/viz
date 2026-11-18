/** Unit-aware number formatting for axes, legends, tables and digests. */

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

/** Trim to `sig` significant digits without exponent notation or trailing zeros. */
function sig(v: number, digits: number): string {
  if (v === 0) return '0'
  const abs = Math.abs(v)
  const mag = Math.floor(Math.log10(abs))
  const decimals = Math.max(0, Math.min(12, digits - 1 - mag))
  let s = v.toFixed(decimals)
  if (s.includes('.')) s = s.replace(/\.?0+$/, '')
  return s === '-0' ? '0' : s
}

const SI = [
  [1e15, 'P'],
  [1e12, 'T'],
  [1e9, 'G'],
  [1e6, 'M'],
  [1e3, 'k'],
] as const

function si(v: number, digits: number): string {
  const abs = Math.abs(v)
  for (const [size, suffix] of SI) if (abs >= size) return sig(v / size, digits) + suffix
  if (abs !== 0 && abs < 1e-3) {
    if (abs >= 1e-6) return sig(v * 1e6, digits) + 'µ'
    if (abs >= 1e-9) return sig(v * 1e9, digits) + 'n'
    return v.toExponential(Math.max(0, digits - 1))
  }
  return sig(v, digits)
}

const IEC = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'] as const

function bytes(v: number, digits: number): string {
  let abs = Math.abs(v)
  let i = 0
  while (abs >= 1024 && i < IEC.length - 1) {
    abs /= 1024
    i++
  }
  return `${v < 0 ? '-' : ''}${sig(abs, digits)} ${IEC[i]}`
}

function seconds(v: number, digits: number): string {
  const abs = Math.abs(v)
  if (abs === 0) return '0 s'
  if (abs < 1e-6) return `${sig(v * 1e9, digits)} ns`
  if (abs < 1e-3) return `${sig(v * 1e6, digits)} µs`
  if (abs < 1) return `${sig(v * 1e3, digits)} ms`
  if (abs < 120) return `${sig(v, digits)} s`
  if (abs < 7200) return `${sig(v / 60, digits)} min`
  if (abs < 172800) return `${sig(v / 3600, digits)} h`
  return `${sig(v / 86400, digits)} d`
}

/** Format a value in a unit. `digits` is the number of significant digits (default 3). */
export function formatValue(v: number | null | undefined, unit: UnitId = 'none', digits = 3): string {
  if (v == null) return '–'
  if (Number.isNaN(v)) return 'NaN'
  if (!Number.isFinite(v)) return v > 0 ? '+Inf' : '-Inf'
  switch (unit) {
    case 'seconds':
      return seconds(v, digits)
    case 'bytes':
      return bytes(v, digits)
    case 'bytes/s':
      return `${bytes(v, digits)}/s`
    case 'percentunit':
      return `${sig(v * 100, digits)}%`
    case 'percent':
      return `${sig(v, digits)}%`
    case 'rps':
      return `${si(v, digits)}/s`
    case 'cores':
      // Kubernetes CPU quantities: millicores below one core, plain cores above.
      return Math.abs(v) < 1 && v !== 0 ? `${sig(v * 1000, digits)}m` : si(v, digits)
    default:
      return si(v, digits)
  }
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
