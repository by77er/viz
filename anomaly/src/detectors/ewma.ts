/**
 * Tier 0: exponentially weighted mean and variance with ±k·σ bands.
 *
 * One-step-ahead: each point is compared with the mean and σ from the points before it, then
 * folded in. Weight per point: α = 1 − 2^(−Δsteps / halfLifePoints), so a gap of g steps
 * decays the old mean as g points would (irregular series are handled by time, not count).
 * Variance update is West's incremental EW form: diff = x − μ; μ += α·diff;
 * var = (1 − α)(var + α·diff²).
 *
 * Contamination control (research 08 §4.2): with `clip` (default) an anomalous value is
 * clipped to the band before it is folded in, so one spike cannot drag the mean or inflate σ.
 * After `acceptAfter` consecutive anomalous points the values are folded in unclipped: the
 * level has changed, and clipping forever would pin the mean (on flat data σ → 0 and the band
 * closes, so without this a single level change scores at the cap for ever after — measured
 * on NAB before this rule existed: 8,432 points at the score cap).
 *
 * Staleness: a gap longer than `staleAfterMs` restarts the warm-up.
 * State: five numbers. Scale-invariant (score is in σ units).
 */
import type { Detector, DetectResult, Point, Series } from '../types.ts'
import { COMMON_DEFAULTS, type CommonParams, length, merge, missingPoint, resolveStep, sideOk, summarize, warmingPoint, val, tsv } from '../base.ts'
import { deviation, duration, count } from '../explain.ts'
import { finiteScore, spreadFloor } from '../stats.ts'

export interface EwmaParams extends CommonParams {
  halfLifePoints: number
  /** Band half-width in standard deviations. */
  k: number
  /** Valid points before scoring starts. */
  minPoints: number
  clip: boolean
  /** Consecutive anomalous points after which a new level is accepted (folded in unclipped). */
  acceptAfter: number
  staleAfterMs: number
}

export interface EwmaState {
  v: 1
  n: number
  mean: number
  var: number
  /** Consecutive anomalous points so far. */
  run: number
  lastTs: number | null
  stepMs: number
}

export const ewmaDefaults: EwmaParams = {
  ...COMMON_DEFAULTS,
  halfLifePoints: 30,
  k: 4,
  minPoints: 30,
  clip: true,
  acceptAfter: 5,
  staleAfterMs: Number.MAX_VALUE,
}

const fresh = (stepMs: number): EwmaState => ({ v: 1, n: 0, mean: 0, var: 0, run: 0, lastTs: null, stepMs })

export const ewma: Detector<EwmaParams, EwmaState> = {
  name: 'ewma',
  tier: 0,
  mode: 'incremental',
  defaults: ewmaDefaults,
  history(params, stepMs) {
    const p = merge(ewmaDefaults, params)
    const warm = Math.max(p.minPoints, 2 * p.halfLifePoints)
    return {
      lookbackMs: warm * stepMs,
      resolutionMs: 0,
      minPoints: p.minPoints,
      incremental: true,
      tickLookbackMs: 0,
      reason: `Five numbers of state; a cold start needs about ${warm} points (${duration(warm * stepMs)}) to settle.`,
    }
  },
  detect(series: Series, params?: Partial<EwmaParams>, state?: EwmaState | null): DetectResult<EwmaState> {
    const p = merge(ewmaDefaults, params)
    const st: EwmaState = state && state.v === 1 ? { ...fresh(0), ...state } : fresh(0)
    st.stepMs = resolveStep(p.stepMs, st.stepMs, series, st.lastTs)
    const hl = Math.max(p.halfLifePoints, 1e-9)
    const n = length(series)
    const points: Point[] = new Array(n)
    for (let i = 0; i < n; i++) {
      const ts = tsv(series.ts[i]!)
      const x = val(series.values[i]!)
      if (!Number.isFinite(ts) || !Number.isFinite(x) || (st.lastTs !== null && ts <= st.lastTs)) {
        points[i] = missingPoint(ts, x)
        continue
      }
      if (st.lastTs !== null && ts - st.lastTs > p.staleAfterMs) Object.assign(st, fresh(st.stepMs))
      const steps = st.lastTs === null ? 1 : st.stepMs > 0 ? (ts - st.lastTs) / st.stepMs : 1
      st.lastTs = ts
      if (st.n === 0) {
        st.n = 1
        st.mean = x
        st.var = 0
        points[i] = warmingPoint(ts, x)
        continue
      }
      const sd = spreadFloor(Math.sqrt(Math.max(st.var, 0)), st.mean, p.minSpread)
      const diff0 = x - st.mean
      const warm = st.n < p.minPoints
      let pt: Point
      if (warm) {
        pt = warmingPoint(ts, x, st.mean)
      } else {
        const score = finiteScore(Math.abs(diff0) / sd)
        const anomalous = score > p.k && Math.abs(diff0) >= p.minDeviation && sideOk(p.direction, diff0)
        pt = { ts, value: x, expected: st.mean, lower: st.mean - p.k * sd, upper: st.mean + p.k * sd, score, anomalous, status: 'ok' }
        if (anomalous) {
          pt.explanation = deviation({
            detector: 'ewma',
            kind: 'deviation',
            value: x,
            reference: st.mean,
            referenceLabel: `the exponentially weighted mean (half-life ${st.stepMs > 0 ? duration(hl * st.stepMs) : count(hl, 'point')})`,
            deviations: score,
            spread: sd,
            spreadLabel: 'exponentially weighted standard deviation',
            spreadWord: 'standard deviations',
            at: ts,
            unit: p.unit,
            facts: { halfLifePoints: hl, k: p.k, pointsSeen: st.n },
          })
        }
      }
      points[i] = pt
      // fold in (clipped to the band once warm)
      st.run = pt.anomalous ? st.run + 1 : 0
      const xu = p.clip && !warm && st.run > 0 && st.run <= p.acceptAfter ? Math.min(Math.max(x, st.mean - p.k * sd), st.mean + p.k * sd) : x
      const alpha = 1 - Math.pow(2, -Math.max(steps, 1e-9) / hl)
      const diff = xu - st.mean
      const incr = alpha * diff
      st.mean += incr
      st.var = (1 - alpha) * (st.var + diff * incr)
      st.n++
    }
    const out: EwmaState = { v: 1, n: st.n, mean: state?.mean ?? st.mean, var: st.var, run: st.run, lastTs: st.lastTs, stepMs: st.stepMs }
    return { points, state: out, summary: summarize('ewma', points, out, undefined, `needs ${p.minPoints} points before scoring`) }
  },
}
