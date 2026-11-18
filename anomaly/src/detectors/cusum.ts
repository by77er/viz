/**
 * Tier 1 (cheap enough for tier 0): two-sided tabular CUSUM for mean shifts (Page 1954;
 * the tabular form in Montgomery, Introduction to Statistical Quality Control).
 *
 *   z  = (x − μ₀) / σ₀
 *   S⁺ = max(0, S⁺ + z − k)      S⁻ = max(0, S⁻ − z − k)
 *   alarm when S⁺ > h or S⁻ > h
 *
 * μ₀ and σ₀ come from the first `warmupPoints` valid points (median and 1.4826 × MAD of the
 * first differences / √2, which is not inflated by a slow drift during warm-up). Defaults
 * k = 0.5, h = 5 (in σ units) target a 1σ shift; for known μ₀ and σ₀ and independent normal
 * data the two-sided in-control average run length is about 465 points (Montgomery; Siegmund's
 * approximation gives 469). Estimating μ₀ and σ₀ from a short warm-up shortens it, and
 * autocorrelated metrics shorten it further: the README reports the measured value.
 *
 * At an alarm the change time is estimated as the first point of the current excursion (the
 * last time the statistic was 0), the new mean as the mean since then; the point is flagged
 * with "mean shifted from μ₀ to μ₁ at T". The reference level is then re-learned from the
 * next `relearnPoints` points (median, σ kept), so a lasting shift alarms once, not forever.
 * Only alarm points are anomalous.
 * Score: max(S⁺, S⁻) / h (≥ 1 at an alarm). State: about a dozen numbers plus the warm-up
 * buffer while warming. A gap longer than `staleAfterMs` restarts the warm-up.
 */
import type { Detector, DetectResult, Point, Series } from '../types.ts'
import { COMMON_DEFAULTS, type CommonParams, length, merge, missingPoint, resolveStep, sideOk, summarize, warmingPoint, val, tsv } from '../base.ts'
import { levelShift } from '../explain.ts'
import { finiteScore, median, MAD_TO_SIGMA, spreadFloor } from '../stats.ts'

export interface CusumParams extends CommonParams {
  /** Allowance, in σ. */
  k: number
  /** Decision interval, in σ. */
  h: number
  warmupPoints: number
  /** Points used to re-learn the reference level after an alarm. */
  relearnPoints: number
  staleAfterMs: number
}

export interface CusumState {
  v: 1
  lastTs: number | null
  stepMs: number
  /** Warm-up buffer; emptied once the reference is learned. */
  warm: number[]
  ready: boolean
  relearning: boolean
  mu: number
  sigma: number
  hi: number
  lo: number
  /** Excursion start time and running sum/count since it began, per side. */
  hiStart: number | null
  hiSum: number
  hiN: number
  loStart: number | null
  loSum: number
  loN: number
}

export const cusumDefaults: CusumParams = { ...COMMON_DEFAULTS, k: 0.5, h: 5, warmupPoints: 60, relearnPoints: 30, staleAfterMs: Number.MAX_VALUE }

const fresh = (stepMs: number): CusumState => ({ v: 1, lastTs: null, stepMs, warm: [], ready: false, relearning: false, mu: 0, sigma: 0, hi: 0, lo: 0, hiStart: null, hiSum: 0, hiN: 0, loStart: null, loSum: 0, loN: 0 })

/** σ from first differences: 1.4826 · MAD(Δx) / √2. Robust to level shifts and slow drift. */
export function diffSigma(x: number[]): number {
  if (x.length < 3) return 0
  const d: number[] = []
  for (let i = 1; i < x.length; i++) d.push(x[i]! - x[i - 1]!)
  const m = median(d)
  const ad = d.map((v) => Math.abs(v - m))
  return (MAD_TO_SIGMA * median(ad)) / Math.SQRT2
}

export const cusum: Detector<CusumParams, CusumState> = {
  name: 'cusum',
  tier: 1,
  mode: 'incremental',
  defaults: cusumDefaults,
  history(params, stepMs) {
    const p = merge(cusumDefaults, params)
    return { lookbackMs: p.warmupPoints * stepMs, resolutionMs: 0, minPoints: p.warmupPoints, incremental: true, tickLookbackMs: 0, reason: `About a dozen numbers of state; ${p.warmupPoints} points to learn the reference level.` }
  },
  detect(series: Series, params?: Partial<CusumParams>, state?: CusumState | null): DetectResult<CusumState> {
    const p = merge(cusumDefaults, params)
    const st: CusumState = state && state.v === 1 ? { ...state, warm: state.warm.slice() } : fresh(0)
    st.stepMs = resolveStep(p.stepMs, st.stepMs, series, st.lastTs)
    const warmupPoints = Math.max(3, Math.floor(p.warmupPoints))
    const n = length(series)
    const points: Point[] = new Array(n)
    for (let i = 0; i < n; i++) {
      const ts = tsv(series.ts[i]!), x = val(series.values[i]!)
      if (!Number.isFinite(ts) || !Number.isFinite(x) || (st.lastTs !== null && ts <= st.lastTs)) { points[i] = missingPoint(ts, x); continue }
      if (st.lastTs !== null && ts - st.lastTs > p.staleAfterMs) Object.assign(st, fresh(st.stepMs))
      st.lastTs = ts
      if (!st.ready || st.relearning) {
        st.warm.push(x)
        const need = st.relearning ? Math.max(1, Math.floor(p.relearnPoints)) : warmupPoints
        if (st.warm.length >= need) {
          st.mu = median(st.warm)
          if (!st.ready) st.sigma = diffSigma(st.warm)
          st.warm = []
          st.ready = true
          st.relearning = false
        }
        points[i] = warmingPoint(ts, x, st.ready && !st.relearning ? st.mu : null)
        continue
      }
      const sd = spreadFloor(st.sigma, st.mu, p.minSpread)
      // clamped so a flat warm-up (σ at its floor) cannot put Infinity into state
      const z = Math.max(-1e12, Math.min(1e12, (x - st.mu) / sd))
      st.hi = Math.max(0, st.hi + z - p.k)
      st.lo = Math.max(0, st.lo - z - p.k)
      if (st.hi > 0) { if (st.hiStart === null) { st.hiStart = ts; st.hiSum = 0; st.hiN = 0 } st.hiSum += x; st.hiN++ } else { st.hiStart = null; st.hiSum = 0; st.hiN = 0 }
      if (st.lo > 0) { if (st.loStart === null) { st.loStart = ts; st.loSum = 0; st.loN = 0 } st.loSum += x; st.loN++ } else { st.loStart = null; st.loSum = 0; st.loN = 0 }
      const stat = Math.max(st.hi, st.lo)
      const score = finiteScore(stat / p.h)
      let anomalous = false
      const pt: Point = { ts, value: x, expected: st.mu, lower: null, upper: null, score, anomalous, status: 'ok' }
      if (stat > p.h) {
        const up = st.hi >= st.lo
        const newMu = up ? st.hiSum / st.hiN : st.loSum / st.loN
        const at = (up ? st.hiStart : st.loStart) ?? ts
        const diff = newMu - st.mu
        anomalous = Math.abs(diff) >= p.minDeviation && sideOk(p.direction, diff)
        if (anomalous) {
          pt.anomalous = true
          pt.explanation = levelShift({
            detector: 'cusum', from: st.mu, to: newMu, changeAt: at, sigma: sd, unit: p.unit,
            facts: { statistic: stat, h: p.h, k: p.k, pointsSinceChange: up ? st.hiN : st.loN },
          })
        }
        // re-learn the level either way, so a lasting shift alarms once
        st.mu = newMu
        st.relearning = p.relearnPoints > 0
        st.hi = 0; st.lo = 0
        st.hiStart = null; st.hiSum = 0; st.hiN = 0
        st.loStart = null; st.loSum = 0; st.loN = 0
      }
      points[i] = pt
    }
    const out: CusumState = { ...st, warm: st.warm.slice() }
    return { points, state: out, summary: summarize('cusum', points, out, undefined, `needs ${warmupPoints} points to learn the reference level`) }
  },
}
