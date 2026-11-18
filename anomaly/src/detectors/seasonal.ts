/**
 * Tier 0: seasonal baseline with robust bands.
 *
 * Expected value at time t: a blend of the values at the same phase in the k most recent
 * seasons, x(t − j·P) for j = 1..k (median by default; a weighted median or weighted mean
 * with weight decay^(j−1) if asked). Spread: 1.4826 × MAD of the recent residuals
 * r(s) = x(s) − expected(s) over `residualWindowMs` (default one period), i.e. "how well the
 * seasonal baseline has been predicting lately". Score = |x − expected| / spread.
 *
 * Input is one series at one resolution: the caller passes rollup-resolution points (e.g.
 * 1-hour rollups for weekly seasonality, 5-minute for daily). The period must be a multiple of
 * the step. Points are placed on slots round((ts − origin) / step); a missing slot is a gap,
 * not a zero, and a season whose slot is missing is simply left out of the blend.
 *
 * `adapt: 'agile'` adds a level correction (median residual over the last `agileWindowMs`),
 * so a level shift stops alerting within that window — Datadog's agile/robust trade-off.
 * Contamination: an anomalous value is stored clipped to the band, so one bad day does not
 * become next week's baseline at full strength.
 *
 * State: (k·P/step + 1) values plus (residual window / step + 1) residuals. For weekly
 * seasonality at 1-hour rollups with k = 4: 673 + 169 numbers (measured size in README).
 * No trend term: a steadily growing series drifts above its own past seasons.
 */
import type { Detector, DetectResult, Point, Series } from '../types.ts'
import { COMMON_DEFAULTS, type CommonParams, length, merge, missingPoint, mod, resolveStep, sideOk, slotOf, summarize, warmingPoint } from '../base.ts'
import { deviation, duration, fmt, phaseName, withUnit } from '../explain.ts'
import { finiteScore, median, robust, spreadFloor, weightedMedian } from '../stats.ts'

export interface SeasonalParams extends CommonParams {
  /** Season length. Required (see `detectSeasonality`); must be a multiple of the step. */
  periodMs: number
  /** k: how many previous seasons to blend. */
  seasons: number
  /** Weight of season j (1 = most recent) is decay^(j−1). 1 = all equal. */
  decay: number
  blend: 'median' | 'mean'
  /** Band half-width in robust standard deviations of the residuals. */
  k: number
  /** Seasons that must be present before a point is scored. */
  minSeasons: number
  /** Residuals used for the spread. 0 = one period. */
  residualWindowMs: number
  minResiduals: number
  adapt: 'robust' | 'agile'
  /** Agile level-correction window. 0 = period / 24. */
  agileWindowMs: number
  contamination: 'clip' | 'keep'
}

export interface SeasonalState {
  v: 1
  periodMs: number
  stepMs: number
  seasons: number
  origin: number
  lastTs: number | null
  lastSlot: number | null
  /** Ring of seasons·P + 1 values (null = missing). */
  vals: (number | null)[]
  /** Ring of R + 1 residuals. */
  res: (number | null)[]
}

export const seasonalDefaults: SeasonalParams = {
  ...COMMON_DEFAULTS,
  periodMs: 0,
  seasons: 4,
  decay: 1,
  blend: 'median',
  k: 4,
  minSeasons: 2,
  residualWindowMs: 0,
  minResiduals: 12,
  adapt: 'robust',
  agileWindowMs: 0,
  contamination: 'clip',
}

function geometry(p: SeasonalParams, stepMs: number) {
  const P = stepMs > 0 ? Math.round(p.periodMs / stepMs) : 0
  const seasons = Math.max(1, Math.floor(p.seasons))
  const Rr = Math.max(1, Math.round((p.residualWindowMs > 0 ? p.residualWindowMs : p.periodMs) / Math.max(stepMs, 1)))
  const A = Math.max(1, Math.round((p.agileWindowMs > 0 ? p.agileWindowMs : p.periodMs / 24) / Math.max(stepMs, 1)))
  return { P, seasons, R: seasons * P + 1, Rr: Rr + 1, A }
}

export const seasonal: Detector<SeasonalParams, SeasonalState> = {
  name: 'seasonal',
  tier: 0,
  mode: 'incremental',
  defaults: seasonalDefaults,
  history(params, stepMs) {
    const p = merge(seasonalDefaults, params)
    const g = geometry(p, stepMs)
    const resid = p.residualWindowMs > 0 ? p.residualWindowMs : p.periodMs
    return {
      lookbackMs: g.seasons * p.periodMs + resid,
      resolutionMs: stepMs,
      minPoints: Math.min(g.seasons, Math.max(1, p.minSeasons)) * g.P,
      incremental: true,
      tickLookbackMs: 0,
      reason: `Same phase in the last ${g.seasons} × ${duration(p.periodMs)} at ${duration(stepMs)} resolution, plus ${duration(resid)} of residuals; state holds ${g.R + g.Rr} numbers.`,
    }
  },
  detect(series: Series, params?: Partial<SeasonalParams>, state?: SeasonalState | null): DetectResult<SeasonalState> {
    const p = merge(seasonalDefaults, params)
    const stepMs = resolveStep(p.stepMs, state?.stepMs, series, state?.lastTs)
    const n = length(series)
    const g = geometry(p, stepMs)
    if (!(p.periodMs > 0) || g.P < 2) {
      const points = Array.from({ length: n }, (_, i) =>
        Number.isFinite(series.values[i]!) && Number.isFinite(series.ts[i]!) ? warmingPoint(series.ts[i]!, series.values[i]!) : missingPoint(series.ts[i]!, series.values[i]!))
      return { points, state: null, summary: summarize('seasonal', points, null, undefined, 'a season length (periodMs) of at least two steps is required; see detectSeasonality') }
    }
    const minSeasons = Math.min(g.seasons, Math.max(1, Math.floor(p.minSeasons)))
    const compatible = state && state.v === 1 && state.periodMs === p.periodMs && state.stepMs === stepMs && state.seasons === g.seasons && state.vals.length === g.R && state.res.length === g.Rr
    let firstTs = NaN
    for (let i = 0; i < n; i++) if (Number.isFinite(series.ts[i]!)) { firstTs = series.ts[i]!; break }
    const st: SeasonalState = compatible
      ? { ...state, vals: state.vals.slice(), res: state.res.slice() }
      : { v: 1, periodMs: p.periodMs, stepMs, seasons: g.seasons, origin: Number.isFinite(firstTs) ? firstTs : 0, lastTs: null, lastSlot: null, vals: new Array(g.R).fill(null), res: new Array(g.Rr).fill(null) }
    const { phase, season } = phaseName(p.periodMs, stepMs)
    const weights: number[] = []
    for (let j = 1; j <= g.seasons; j++) weights.push(Math.pow(p.decay > 0 ? p.decay : 1, j - 1))
    const points: Point[] = new Array(n)
    const vj: number[] = []
    const wj: number[] = []
    const resBuf: number[] = []
    for (let i = 0; i < n; i++) {
      const ts = series.ts[i]!
      const x = series.values[i]!
      if (!Number.isFinite(ts) || !Number.isFinite(x) || (st.lastTs !== null && ts <= st.lastTs)) {
        points[i] = missingPoint(ts, x)
        continue
      }
      st.lastTs = ts
      const s = slotOf(ts, st.origin, stepMs)
      // advance: slots skipped since the last point are gaps
      if (st.lastSlot !== null && s > st.lastSlot) {
        const gap = s - st.lastSlot - 1
        if (gap >= g.R) st.vals.fill(null)
        else for (let q = st.lastSlot + 1; q < s; q++) st.vals[mod(q, g.R)] = null
        if (gap >= g.Rr) st.res.fill(null)
        else for (let q = st.lastSlot + 1; q < s; q++) st.res[mod(q, g.Rr)] = null
      }
      st.lastSlot = st.lastSlot === null ? s : Math.max(st.lastSlot, s)
      // blend of previous seasons
      vj.length = 0
      wj.length = 0
      for (let j = 1; j <= g.seasons; j++) {
        const v = st.vals[mod(s - j * g.P, g.R)]
        if (v !== null && v !== undefined) {
          vj.push(v)
          wj.push(weights[j - 1]!)
        }
      }
      let pt: Point
      let resid: number | null = null
      let stored = x
      if (vj.length < minSeasons) {
        pt = warmingPoint(ts, x)
      } else {
        let base: number
        if (p.blend === 'mean') {
          let a = 0, b = 0
          for (let q = 0; q < vj.length; q++) { a += vj[q]! * wj[q]!; b += wj[q]! }
          base = a / b
        } else {
          base = p.decay === 1 ? median(vj) : weightedMedian(vj, wj)
        }
        resid = x - base
        resBuf.length = 0
        const self = mod(s, g.Rr)
        for (let q = 0; q < g.Rr; q++) {
          if (q === self) continue
          const r = st.res[q]
          if (r !== null && r !== undefined) resBuf.push(r)
        }
        if (resBuf.length < p.minResiduals) {
          pt = warmingPoint(ts, x, base)
        } else {
          let level = 0
          if (p.adapt === 'agile') {
            const recent: number[] = []
            for (let q = 1; q <= Math.min(g.A, g.Rr - 1); q++) {
              const r = st.res[mod(s - q, g.Rr)]
              if (r !== null && r !== undefined) recent.push(r)
            }
            if (recent.length > 0) level = median(recent)
          }
          const expected = base + level
          const rb = robust(resBuf)
          const sd = spreadFloor(rb.sigma, expected, p.minSpread)
          const diff = x - expected
          const score = finiteScore(Math.abs(diff) / sd)
          const anomalous = score > p.k && Math.abs(diff) >= p.minDeviation && sideOk(p.direction, diff)
          pt = { ts, value: x, expected, lower: expected - p.k * sd, upper: expected + p.k * sd, score, anomalous, status: 'ok' }
          if (anomalous) {
            if (p.contamination === 'clip') stored = base + Math.min(Math.max(x - base, level - p.k * sd), level + p.k * sd)
            const blendWord = p.blend === 'mean' ? 'weighted mean' : p.decay === 1 ? 'median' : 'weighted median'
            const span = vj.length === g.seasons ? `over the last ${vj.length} ${season}s` : `in ${vj.length} of the last ${g.seasons} ${season}s`
            const levelText = p.adapt === 'agile' ? `, shifted by ${withUnit(level, p.unit)} to follow the last ${duration(g.A * stepMs)}` : ''
            pt.explanation = deviation({
              detector: 'seasonal',
              kind: 'seasonal',
              value: x,
              reference: expected,
              referenceLabel: `the ${blendWord} of the ${phase} ${span}${levelText}`,
              deviations: score,
              spread: sd,
              spreadLabel: `1.4826 × MAD of the residuals over the last ${duration(Math.max(1, g.Rr - 1) * stepMs)}`,
              spreadWord: 'robust standard deviations',
              at: ts,
              unit: p.unit,
              facts: { seasonsUsed: vj.length, seasons: g.seasons, periodMs: p.periodMs, seasonalBaseline: base, levelCorrection: level, residuals: resBuf.length },
            })
          }
        }
      }
      st.vals[mod(s, g.R)] = stored
      st.res[mod(s, g.Rr)] = resid === null ? null : stored - (x - resid)
      points[i] = pt
    }
    const out: SeasonalState = { ...st }
    return {
      points,
      state: out,
      summary: summarize('seasonal', points, out, { periodMs: p.periodMs, stepMs }, `needs ${minSeasons} previous ${season}s (${duration(minSeasons * p.periodMs)}) at this phase and ${p.minResiduals} residuals before scoring`),
    }
  },
}

void fmt
