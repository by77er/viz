/**
 * Tier 0: static threshold with hysteresis (Datadog's "recovery thresholds").
 *
 * Fires when the value goes above `above` (or below `below`); once firing, stays firing until
 * the value crosses back over `recoverAbove` (≤ above) or `recoverBelow` (≥ below). With the
 * recovery levels equal to the thresholds there is no hysteresis.
 *
 * Score: relative exceedance beyond the firing threshold, |x − threshold| / |threshold|
 * (0 inside). Scale-invariant when thresholds scale with the data.
 * Missing points change nothing. A gap longer than `staleAfterMs` clears the firing state
 * (the series went stale; the next point is judged afresh).
 */
import type { Detector, DetectResult, Point, Series } from '../types.ts'
import { COMMON_DEFAULTS, type CommonParams, length, merge, missingPoint, resolveStep, summarize } from '../base.ts'
import { fmt, withUnit, duration } from '../explain.ts'
import { finiteScore } from '../stats.ts'

export interface ThresholdParams extends CommonParams {
  above: number | null
  below: number | null
  /** Default: `above` (no hysteresis). */
  recoverAbove: number | null
  /** Default: `below`. */
  recoverBelow: number | null
  /** Gap that clears the firing state. Default: never. */
  staleAfterMs: number
}

export interface ThresholdState {
  v: 1
  /** 1 firing high, -1 firing low, 0 not firing. */
  firing: 0 | 1 | -1
  lastTs: number | null
  stepMs: number
}

export const thresholdDefaults: ThresholdParams = {
  ...COMMON_DEFAULTS,
  above: null,
  below: null,
  recoverAbove: null,
  recoverBelow: null,
  staleAfterMs: Number.MAX_VALUE,
}

const rel = (x: number, t: number) => Math.abs(x - t) / Math.max(Math.abs(t), 1e-12)

export const threshold: Detector<ThresholdParams, ThresholdState> = {
  name: 'threshold',
  tier: 0,
  mode: 'incremental',
  defaults: thresholdDefaults,
  history: () => ({
    lookbackMs: 0,
    resolutionMs: 0,
    minPoints: 1,
    incremental: true,
    tickLookbackMs: 0,
    reason: 'Compares each new point with fixed numbers; needs no history.',
  }),
  detect(series: Series, params?: Partial<ThresholdParams>, state?: ThresholdState | null): DetectResult<ThresholdState> {
    const p = merge(thresholdDefaults, params)
    const above = typeof p.above === 'number' && Number.isFinite(p.above) ? p.above : null
    const below = typeof p.below === 'number' && Number.isFinite(p.below) ? p.below : null
    const recA = above === null ? null : typeof p.recoverAbove === 'number' && Number.isFinite(p.recoverAbove) ? Math.min(p.recoverAbove, above) : above
    const recB = below === null ? null : typeof p.recoverBelow === 'number' && Number.isFinite(p.recoverBelow) ? Math.max(p.recoverBelow, below) : below
    const st: ThresholdState = state && state.v === 1 ? { ...state } : { v: 1, firing: 0, lastTs: null, stepMs: 0 }
    st.stepMs = resolveStep(p.stepMs, st.stepMs, series, st.lastTs)
    const n = length(series)
    const points: Point[] = new Array(n)
    for (let i = 0; i < n; i++) {
      const ts = series.ts[i]!
      const x = series.values[i]!
      if (!Number.isFinite(ts) || !Number.isFinite(x) || (st.lastTs !== null && ts <= st.lastTs)) {
        points[i] = missingPoint(ts, x)
        continue
      }
      if (st.lastTs !== null && ts - st.lastTs > p.staleAfterMs) st.firing = 0
      st.lastTs = ts
      const was = st.firing
      if (st.firing === 1 && recA !== null && x < recA) st.firing = 0
      else if (st.firing === -1 && recB !== null && x > recB) st.firing = 0
      if (st.firing === 0) {
        if (above !== null && x > above) st.firing = 1
        else if (below !== null && x < below) st.firing = -1
      }
      const anomalous = st.firing !== 0
      let score = 0
      if (above !== null && x > above) score = rel(x, above)
      else if (below !== null && x < below) score = rel(x, below)
      const pt: Point = { ts, value: x, expected: null, lower: below, upper: above, score: finiteScore(score), anomalous, status: 'ok' }
      if (anomalous) {
        const high = st.firing === 1
        const t = (high ? above : below)!
        const r = (high ? recA : recB)!
        const outside = high ? x > t : x < t
        const word = high ? 'above' : 'below'
        const back = high ? 'below' : 'above'
        const hyst = r !== t ? `fires ${word} ${withUnit(t, p.unit)}, recovers ${back} ${withUnit(r, p.unit)}` : `fires and recovers at ${withUnit(t, p.unit)}`
        const text = outside
          ? `${withUnit(x, p.unit)} is ${word} the threshold ${withUnit(t, p.unit)} by ${fmt(100 * score)}% (${hyst})`
          : `${withUnit(x, p.unit)} is back ${back} the threshold ${withUnit(t, p.unit)} but not yet ${back} the recovery level ${withUnit(r, p.unit)}, so the alert holds (${hyst})`
        pt.explanation = {
          text,
          detector: 'threshold',
          kind: 'threshold',
          direction: high ? 'above' : 'below',
          value: x,
          reference: t,
          referenceLabel: 'threshold',
          at: ts,
          facts: { threshold: t, recovery: r, exceedancePercent: 100 * score, onset: was === 0 ? 1 : 0, ...(p.staleAfterMs < Number.MAX_VALUE ? { staleAfter: duration(p.staleAfterMs) } : {}) },
        }
      }
      points[i] = pt
    }
    const out: ThresholdState = { v: 1, firing: st.firing, lastTs: st.lastTs, stepMs: st.stepMs }
    return { points, state: out, summary: summarize('threshold', points, out, undefined, above === null && below === null ? 'no threshold set' : undefined) }
  },
}

void fmt
