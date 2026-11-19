/**
 * Min/max-preserving display downsampling.
 *
 * When a series has more points than the plot has pixel columns, the points are grouped by
 * pixel column and each column is reduced to (at most) two points per series: the column's
 * minimum and maximum, in the order they occurred. Spikes and dips therefore survive at any
 * zoom level; nothing is averaged and nothing is decimated.
 *
 * All series share one x axis, so the two output slots of a column sit at the timestamps of
 * the column's first and last input sample. A value is thus drawn at most one pixel column
 * away from where it occurred, and every output value is an input value of the same series
 * in the same column — no value is invented. A column in which a series has no samples stays
 * null in the output, so gaps wider than a pixel remain gaps.
 */

export interface DownsampleResult {
  xs: number[]
  series: (number | null)[][]
  /** True when the output differs from the input. */
  downsampled: boolean
  /** Index into the input xs for every output x (for mapping a cursor back to raw data). */
  sourceIndex: number[]
}

/** The pixel column of timestamp x for a plot `columns` wide spanning [xMin, xMax]. */
export function columnOf(x: number, xMin: number, xMax: number, columns: number): number {
  if (xMax <= xMin) return 0
  const c = Math.floor(((x - xMin) / (xMax - xMin)) * columns)
  return c < 0 ? 0 : c >= columns ? columns - 1 : c
}

/** A series as the renderer takes it: an array with null for a gap (uPlot draws NaN as a value and bridges it). */
function withNulls(s: ArrayLike<number | null>): (number | null)[] {
  const out = new Array<number | null>(s.length)
  for (let i = 0; i < s.length; i++) {
    const v = s[i]
    out[i] = v == null || v !== v ? null : v
  }
  return out
}

/** Input values: a gap is null, or NaN (the views keep series in Float64Arrays); the output always has null. */
export function downsampleMinMax(
  xs: readonly number[],
  series: readonly ArrayLike<number | null>[],
  columns: number,
): DownsampleResult {
  const n = xs.length
  const cols = Math.max(1, Math.floor(columns))
  if (n <= cols * 2) {
    return {
      xs: xs.slice(),
      series: series.map(withNulls),
      downsampled: false,
      sourceIndex: xs.map((_, i) => i),
    }
  }

  const xMin = xs[0]!
  const xMax = xs[n - 1]!
  // Column boundaries as [startIndex, endIndex) runs over the (ascending) input.
  const starts: number[] = []
  let prevCol = -1
  for (let i = 0; i < n; i++) {
    const c = columnOf(xs[i]!, xMin, xMax, cols)
    if (c !== prevCol) {
      starts.push(i)
      prevCol = c
    }
  }
  starts.push(n)

  const outXs: number[] = []
  const sourceIndex: number[] = []
  const out: (number | null)[][] = series.map(() => [])

  for (let b = 0; b + 1 < starts.length; b++) {
    const lo = starts[b]!
    const hi = starts[b + 1]!
    const two = hi - lo > 1
    outXs.push(xs[lo]!)
    sourceIndex.push(lo)
    if (two) {
      outXs.push(xs[hi - 1]!)
      sourceIndex.push(hi - 1)
    }
    for (let k = 0; k < series.length; k++) {
      const s = series[k]!
      let min = Infinity
      let max = -Infinity
      let minAt = -1
      let maxAt = -1
      for (let i = lo; i < hi; i++) {
        const v = s[i]
        if (v == null || v !== v) continue
        if (v < min) {
          min = v
          minAt = i
        }
        if (v > max) {
          max = v
          maxAt = i
        }
      }
      const o = out[k]!
      if (minAt < 0) {
        o.push(null)
        if (two) o.push(null)
      } else if (!two) {
        o.push(min)
      } else if (minAt <= maxAt) {
        o.push(min, max)
      } else {
        o.push(max, min)
      }
    }
  }
  return { xs: outXs, series: out, downsampled: true, sourceIndex }
}
