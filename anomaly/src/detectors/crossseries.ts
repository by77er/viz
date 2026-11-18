/**
 * Tier 1 (stateless, cheap enough for tier 0): cross-series outliers — one member of a group
 * behaving unlike its peers at the same time (research 08 §4.3; Datadog's MAD outliers).
 *
 *   score_i = |x_i − median(group)| / σ̂,   σ̂ = 1.4826 · MAD(group)
 *
 * Median and MAD, not mean and standard deviation: with one pod far out of fifty, the mean
 * and σ are dragged towards it and the outlier hides; the median and MAD barely move.
 * If MAD is 0 (most members identical, e.g. 49 pods with zero errors) σ̂ falls back to
 * 1.2533 · mean absolute deviation. Members with a missing value are reported as missing and
 * do not take part. Fewer than `minMembers` present: nothing is scored.
 *
 * `detectGroupWindow` applies this at every common timestamp of a short range and flags a
 * member only if it was an outlier at `minFraction` of the timestamps where it was present
 * (Datadog's "sustained for a fraction of the window").
 */
import type { Point, Series } from '../types.ts'
import { COMMON_DEFAULTS, type CommonParams, length, merge, sideOk, val } from '../base.ts'
import { deviation } from '../explain.ts'
import { finiteScore, robust, spreadFloor } from '../stats.ts'

export interface GroupParams extends CommonParams {
  /** Cut-off in robust standard deviations. */
  k: number
  minMembers: number
}

export const groupDefaults: GroupParams = { ...COMMON_DEFAULTS, k: 3.5, minMembers: 5 }

export interface MemberPoint extends Point { id: string }

export interface GroupResult {
  status: 'ok' | 'not_enough_history'
  members: MemberPoint[]
  median: number | null
  sigma: number | null
  present: number
  outliers: string[]
  message?: string
}

export function detectGroup(members: { id: string; value: number }[], params?: Partial<GroupParams>, ts = 0): GroupResult {
  const p = merge(groupDefaults, params)
  members = (members ?? []).map((m) => ({ id: m?.id, value: val(m?.value) }))
  const vals: number[] = []
  for (const m of members) if (Number.isFinite(m.value)) vals.push(m.value)
  const present = vals.length
  if (present < Math.max(2, p.minMembers)) {
    return {
      status: 'not_enough_history',
      members: (members ?? []).map((m) => ({ id: String(m?.id), ts, value: Number.isFinite(m?.value) ? m.value : null, expected: null, lower: null, upper: null, score: 0, anomalous: false, status: Number.isFinite(m?.value) ? 'warming' : 'missing' })),
      median: null,
      sigma: null,
      present,
      outliers: [],
      message: `needs ${Math.max(2, p.minMembers)} members with a value, has ${present}`,
    }
  }
  const rb = robust(vals)
  const sd = spreadFloor(rb.sigma, rb.median, p.minSpread)
  const outliers: string[] = []
  const out: MemberPoint[] = members.map((m) => {
    const id = String(m.id)
    if (!Number.isFinite(m.value)) return { id, ts, value: null, expected: null, lower: null, upper: null, score: 0, anomalous: false, status: 'missing' }
    const diff = m.value - rb.median
    const score = finiteScore(Math.abs(diff) / sd)
    const anomalous = score > p.k && Math.abs(diff) >= p.minDeviation && sideOk(p.direction, diff)
    const pt: MemberPoint = { id, ts, value: m.value, expected: rb.median, lower: rb.median - p.k * sd, upper: rb.median + p.k * sd, score, anomalous, status: 'ok' }
    if (anomalous) {
      outliers.push(id)
      const e = deviation({
        detector: 'cross_series',
        kind: 'group_outlier',
        value: m.value,
        reference: rb.median,
        referenceLabel: `the median of its ${present} peers at the same time`,
        deviations: score,
        spread: sd,
        spreadLabel: rb.sigmaFrom === 'mad' ? '1.4826 × MAD across the group' : '1.2533 × mean absolute deviation across the group (MAD was 0)',
        spreadWord: 'robust standard deviations',
        at: ts,
        unit: p.unit,
        facts: { member: id, groupSize: present, mad: rb.mad },
      })
      e.text = `${id}: ${e.text}`
      pt.explanation = e
    }
    return pt
  })
  return { status: 'ok', members: out, median: rb.median, sigma: sd, present, outliers }
}

export interface GroupWindowParams extends GroupParams {
  /** Fraction of a member's present timestamps at which it must be an outlier. */
  minFraction: number
}

export interface GroupWindowResult {
  status: 'ok' | 'not_enough_history'
  /** Per member: fraction of its timestamps flagged, and its worst point. */
  members: { id: string; fraction: number; present: number; outlier: boolean; worst: MemberPoint | null }[]
  outliers: string[]
  timestamps: number
}

/** Cross-series outliers over a short range: series are aligned by exact timestamp. */
export function detectGroupWindow(group: { id: string; series: Series }[], params?: Partial<GroupWindowParams>): GroupWindowResult {
  const p = merge({ ...groupDefaults, minFraction: 0.5 } as GroupWindowParams, params)
  const byTs = new Map<number, { id: string; value: number }[]>()
  for (const g of group ?? []) {
    const n = length(g.series)
    for (let i = 0; i < n; i++) {
      const t = g.series.ts[i]!
      if (!Number.isFinite(t)) continue
      let row = byTs.get(t)
      if (!row) byTs.set(t, (row = []))
      row.push({ id: String(g.id), value: g.series.values[i]! })
    }
  }
  const stats = new Map<string, { flagged: number; present: number; worst: MemberPoint | null }>()
  for (const g of group ?? []) stats.set(String(g.id), { flagged: 0, present: 0, worst: null })
  let scoredTimestamps = 0
  for (const t of [...byTs.keys()].sort((a, b) => a - b)) {
    const r = detectGroup(byTs.get(t)!, p, t)
    if (r.status !== 'ok') continue
    scoredTimestamps++
    for (const m of r.members) {
      const s = stats.get(m.id)!
      if (m.status !== 'ok') continue
      s.present++
      if (m.anomalous) s.flagged++
      if (!s.worst || m.score > s.worst.score) s.worst = m
    }
  }
  const members = [...stats.entries()].map(([id, s]) => {
    const fraction = s.present ? s.flagged / s.present : 0
    return { id, fraction, present: s.present, outlier: s.present > 0 && fraction >= p.minFraction && s.flagged > 0, worst: s.worst }
  })
  return { status: scoredTimestamps ? 'ok' : 'not_enough_history', members, outliers: members.filter((m) => m.outlier).map((m) => m.id), timestamps: scoredTimestamps }
}
