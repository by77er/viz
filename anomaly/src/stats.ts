/**
 * Small robust-statistics kernel. Every function ignores non-finite inputs and never throws.
 */

/**
 * Consistency constant: for normally distributed data, 1.4826 × MAD estimates σ
 * (1 / Φ⁻¹(3/4) = 1.482602...). Methods that compare a deviation with a *standard deviation*
 * (robust z-scores, "N standard deviations" in explanations) need it; methods that report
 * "N MADs" do not. Each call site says which it is.
 */
export const MAD_TO_SIGMA = 1.4826

/** √(π/2): for normal data, 1.2533 × mean absolute deviation estimates σ. Used when MAD is 0. */
export const MEANAD_TO_SIGMA = 1.2533

export const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)

/** In-place quickselect of the k-th smallest of a[0..n). Returns it. a must hold finite numbers. */
function select(a: Float64Array, n: number, k: number): number {
  let lo = 0
  let hi = n - 1
  while (hi > lo) {
    // median-of-three pivot
    const mid = (lo + hi) >>> 1
    let x = a[lo]!, y = a[mid]!, z = a[hi]!
    const pivot = x < y ? (y < z ? y : x < z ? z : x) : x < z ? x : y < z ? z : y
    let i = lo
    let j = hi
    while (i <= j) {
      while (a[i]! < pivot) i++
      while (a[j]! > pivot) j--
      if (i <= j) {
        x = a[i]!
        a[i] = a[j]!
        a[j] = x
        i++
        j--
      }
    }
    if (k <= j) hi = j
    else if (k >= i) lo = i
    else return a[k]!
  }
  return a[k]!
}

let scratch = new Float64Array(64)
function buf(n: number): Float64Array {
  if (scratch.length < n) scratch = new Float64Array(Math.max(n, scratch.length * 2))
  return scratch
}

/** Median of the finite values; NaN if there are none. Does not modify its input. */
export function median(values: ArrayLike<number>, from = 0, to = values.length): number {
  const a = buf(to - from)
  let n = 0
  for (let i = from; i < to; i++) {
    const v = values[i]!
    if (Number.isFinite(v)) a[n++] = v
  }
  return medianInPlace(a, n)
}

/** Median of a[0..n), reordering a. */
export function medianInPlace(a: Float64Array, n: number): number {
  if (n === 0) return NaN
  const h = n >>> 1
  const hi = select(a, n, h)
  if (n % 2 === 1) return hi
  // the largest of the lower half
  let lo = -Infinity
  for (let i = 0; i < h; i++) if (a[i]! > lo) lo = a[i]!
  return (lo + hi) / 2
}

export interface Robust {
  /** Number of finite values used. */
  n: number
  median: number
  /** Median absolute deviation from the median (raw, without the 1.4826 factor). */
  mad: number
  /**
   * Robust estimate of σ: 1.4826 × MAD; if MAD is 0 (more than half the values identical),
   * 1.2533 × mean absolute deviation from the median; 0 only if every value is identical.
   */
  sigma: number
  /** Which estimator produced `sigma`. */
  sigmaFrom: 'mad' | 'meanad' | 'none'
}

/** Median, MAD and a robust σ of the finite values in values[from..to). */
export function robust(values: ArrayLike<number>, from = 0, to = values.length): Robust {
  const a = buf(2 * (to - from))
  let n = 0
  for (let i = from; i < to; i++) {
    const v = values[i]!
    if (Number.isFinite(v)) a[n++] = v
  }
  return robustOf(a, n)
}

/** As `robust`, over a[0..n) of finite numbers; reorders a and uses a[n..2n) as scratch. */
export function robustOf(a: Float64Array, n: number): Robust {
  if (n === 0) return { n: 0, median: NaN, mad: NaN, sigma: NaN, sigmaFrom: 'none' }
  const m = medianInPlace(a, n)
  let sumAbs = 0
  for (let i = 0; i < n; i++) {
    const d = Math.abs(a[i]! - m)
    a[i] = d
    sumAbs += d
  }
  const mad = medianInPlace(a, n)
  if (mad > 0) return { n, median: m, mad, sigma: MAD_TO_SIGMA * mad, sigmaFrom: 'mad' }
  const meanAd = sumAbs / n
  if (meanAd > 0) return { n, median: m, mad, sigma: MEANAD_TO_SIGMA * meanAd, sigmaFrom: 'meanad' }
  return { n, median: m, mad: 0, sigma: 0, sigmaFrom: 'none' }
}

/**
 * Weighted median: the smallest value v such that the weights of values ≤ v reach half the
 * total. With equal weights and an even count it returns the mean of the two middle values,
 * matching `median`.
 */
export function weightedMedian(values: number[], weights: number[]): number {
  const idx: number[] = []
  for (let i = 0; i < values.length; i++) if (isNum(values[i]) && isNum(weights[i]) && weights[i]! > 0) idx.push(i)
  if (idx.length === 0) return NaN
  idx.sort((x, y) => values[x]! - values[y]!)
  let total = 0
  for (const i of idx) total += weights[i]!
  const half = total / 2
  let acc = 0
  for (let j = 0; j < idx.length; j++) {
    acc += weights[idx[j]!]!
    if (Math.abs(acc - half) <= 1e-12 * total && j + 1 < idx.length) return (values[idx[j]!]! + values[idx[j + 1]!]!) / 2
    if (acc > half) return values[idx[j]!]!
  }
  return values[idx[idx.length - 1]!]!
}

/** Median of the positive differences of increasing timestamps; 0 if fewer than two. */
export function inferStep(ts: ArrayLike<number>): number {
  const d: number[] = []
  let prev = NaN
  for (let i = 0; i < ts.length; i++) {
    const t = ts[i]!
    if (!Number.isFinite(t)) continue
    if (Number.isFinite(prev) && t > prev) d.push(t - prev)
    if (!Number.isFinite(prev) || t > prev) prev = t
  }
  if (d.length === 0) return 0
  return median(d)
}

/**
 * Floor for a spread estimate: at least 1e-9 of the level (scale-relative, so scores stay
 * scale-invariant) and at least `minSpread`. Returns 0 when there is no scale at all (a history
 * of exact zeros): callers then get |diff| / 0 = Infinity → the score cap for any deviation,
 * and 0 / 0 → 0 for none (`finiteScore`). No absolute constant, which would break scale invariance.
 */
export function spreadFloor(spread: number, level: number, minSpread: number): number {
  const rel = 1e-9 * Math.abs(level)
  const s = Math.max(Number.isFinite(spread) ? spread : 0, minSpread, rel)
  return s > 0 ? s : 0
}

/** Cap for scores so they stay finite and JSON-safe. */
export const SCORE_CAP = 1e12

export function finiteScore(x: number): number {
  if (!Number.isFinite(x)) return x > 0 ? SCORE_CAP : 0
  return Math.min(Math.max(x, 0), SCORE_CAP)
}
