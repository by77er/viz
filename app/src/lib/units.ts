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

/**
 * A scale of a unit: values are divided by `factor` and carry `symbol`. A value and its unit
 * are separate outputs everywhere in this module; the caller decides where the unit goes
 * (once in a column head or on an axis, or after the number when it stands alone).
 */
export interface Scale {
  factor: number
  /** The unit as written after a number or in a head: "ms", "MiB", "/s", "%", "cores". Empty for plain numbers. */
  symbol: string
}

/** A formatted value and its unit, apart. `unit` is empty for plain numbers and for null, NaN and ±Inf. */
export interface Parts {
  value: string
  unit: string
}

const RATE_SCALES: Scale[] = [
  { factor: 1e15, symbol: 'P/s' },
  { factor: 1e12, symbol: 'T/s' },
  { factor: 1e9, symbol: 'G/s' },
  { factor: 1e6, symbol: 'M/s' },
  { factor: 1e3, symbol: 'k/s' },
]

/** The scale a magnitude reads best in. `abs` is the largest magnitude that has to be shown. */
export function scaleFor(unit: UnitId, abs: number): Scale {
  const a = Number.isFinite(abs) ? Math.abs(abs) : 0
  switch (unit) {
    case 'seconds':
      if (a === 0) return { factor: 1, symbol: 's' }
      if (a < 1e-6) return { factor: 1e-9, symbol: 'ns' }
      if (a < 1e-3) return { factor: 1e-6, symbol: 'µs' }
      if (a < 1) return { factor: 1e-3, symbol: 'ms' }
      if (a < 120) return { factor: 1, symbol: 's' }
      if (a < 7200) return { factor: 60, symbol: 'min' }
      if (a < 172800) return { factor: 3600, symbol: 'h' }
      return { factor: 86400, symbol: 'd' }
    case 'bytes':
    case 'bytes/s': {
      let i = 0
      let rest = a
      while (rest >= 1024 && i < IEC.length - 1) {
        rest /= 1024
        i++
      }
      return { factor: 1024 ** i, symbol: unit === 'bytes' ? IEC[i]! : `${IEC[i]}/s` }
    }
    case 'percentunit':
      return { factor: 0.01, symbol: '%' }
    case 'percent':
      return { factor: 1, symbol: '%' }
    case 'rps':
      for (const s of RATE_SCALES) if (a >= s.factor) return s
      if (a !== 0 && a < 1e-3 && a >= 1e-9) return a >= 1e-6 ? { factor: 1e-6, symbol: 'µ/s' } : { factor: 1e-9, symbol: 'n/s' }
      return { factor: 1, symbol: '/s' }
    case 'cores':
      // Kubernetes CPU quantities: millicores below one core, cores above. The unit is written out.
      return a < 1 && a !== 0 ? { factor: 1e-3, symbol: 'millicores' } : { factor: 1, symbol: 'cores' }
    default:
      return { factor: 1, symbol: '' }
  }
}

/** The number alone, in a given scale. Plain numbers and core counts keep an SI prefix; nothing else needs one. */
export function formatInScale(v: number, unit: UnitId, scale: Scale, digits = 3): string {
  if (unit === 'none' || ((unit === 'cores' || unit === 'rps') && scale.factor === 1)) return si(v, digits)
  return sig(v / scale.factor, digits)
}

/** A value and its unit, apart, each value in the scale that suits it. */
export function formatParts(v: number | null | undefined, unit: UnitId = 'none', digits = 3): Parts {
  if (v == null) return { value: '–', unit: '' }
  if (Number.isNaN(v)) return { value: 'NaN', unit: '' }
  if (!Number.isFinite(v)) return { value: v > 0 ? '+Inf' : '-Inf', unit: '' }
  const scale = scaleFor(unit, v)
  return { value: formatInScale(v, unit, scale, digits), unit: scale.symbol }
}

/** A number followed by its unit: "42.5 ms", "1.5 KiB", "453/s", "4.21%", "250 millicores". */
export function joinParts(p: Parts): string {
  if (p.unit === '') return p.value
  return /^[/%]/.test(p.unit) || /^[kMGTPµn]\/s$/.test(p.unit) ? `${p.value}${p.unit}` : `${p.value} ${p.unit}`
}

/** Format a value with its unit, for a number that stands alone. `digits` is the number of significant digits (default 3). */
export function formatValue(v: number | null | undefined, unit: UnitId = 'none', digits = 3): string {
  return joinParts(formatParts(v, unit, digits))
}

/**
 * How a column (or an axis) of values in one unit is written.
 * `unit` is the text for the head, stated once: values are then numbers alone, all in one scale.
 * `unit` is null when the column mixes scales that one head cannot describe (2 ms beside 3 h):
 * every value then keeps its own unit. It is '' for plain numbers, which have no unit to state.
 */
export interface ColumnFormat {
  unit: string | null
  cell: (v: number | null | undefined) => string
}

/** Below this fraction of the column's scale a value would print as a row of zeros (0.000488); the column is then mixed. */
export const MIXED_BELOW = 0.001

/**
 * Decide where the unit of a column goes. One scale is chosen from the largest magnitude; if
 * every other value is still readable in it, the unit goes in the head and the cells are
 * numbers. Otherwise each cell keeps its unit. `mixed: false` forces one scale (axis ticks).
 */
export function columnFormat(values: readonly (number | null | undefined)[], unit: UnitId, digits = 3, mixed = true): ColumnFormat {
  let max = 0
  let min = Infinity
  for (const v of values) {
    if (v == null || !Number.isFinite(v) || v === 0) continue
    const a = Math.abs(v)
    if (a > max) max = a
    if (a < min) min = a
  }
  if (unit === 'none') return { unit: '', cell: (v) => formatValue(v, 'none', digits) }
  const scale = scaleFor(unit, max)
  if (mixed && max > 0 && min / scale.factor < MIXED_BELOW) return { unit: null, cell: (v) => formatValue(v, unit, digits) }
  return {
    unit: scale.symbol,
    cell: (v) => (v == null || !Number.isFinite(v) ? formatParts(v, unit).value : formatInScale(v, unit, scale, digits)),
  }
}

/** A column head with its unit, stated once: "Last, /s". No unit, or a mixed column: the label alone. */
export function headWithUnit(label: string, unit: string | null): string {
  return unit ? `${label}, ${unit}` : label
}

/** The unit of a chart's value axis as the panel head states it, once: "seconds, in ms". Undefined for plain numbers. */
export function axisUnitLabel(unit: UnitId, scale: Scale): string | undefined {
  switch (unit) {
    case 'none':
      return undefined
    case 'seconds':
      return scale.symbol === 's' ? 'seconds' : `seconds, in ${scale.symbol}`
    case 'bytes':
      return scale.symbol === 'B' ? 'bytes' : `bytes, in ${scale.symbol}`
    case 'bytes/s':
      return scale.symbol === 'B/s' ? 'bytes per second' : `bytes per second, in ${scale.symbol}`
    case 'percentunit':
    case 'percent':
      return 'percent (%)'
    case 'rps':
      return scale.symbol === '/s' ? 'per second (/s)' : `per second, in ${scale.symbol}`
    case 'cores':
      return scale.symbol === 'cores' ? 'CPU cores' : `CPU cores, in ${scale.symbol}`
  }
}

/** Tick increments for a byte axis: powers of two, so ticks land on 256, 512, 768 MiB and not on 667.6. */
export const BINARY_INCREMENTS: number[] = Array.from({ length: 61 }, (_, i) => 2 ** i)

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
