/**
 * The alert state machine, as a pure function of (rule, previous alerts, query result,
 * evaluation time). It is a transcription of `AlertingRule.Eval` in prometheus/rules/alerting.go
 * (fetched 2026-11-18); the comments name the upstream step each block corresponds to.
 *
 * Purity is what makes at-least-once alarms safe: every duration is a difference of
 * timestamps, never a count of evaluations, so evaluating the same (rule, time) twice
 * yields the same state and no second transition.
 */
import type { PromScalar, PromVector } from '../../contracts/engine'
import { NO_DATA_LABEL, type Alert, type AlertingRuleV2, type RecordedSample, type RecordingRule } from '../contracts-proposal/rules.v2'
import type { CompiledAlertRule } from './rules'
import { expandTemplate } from './template'
import { byteLength, fingerprint, labelsKey, parseSampleValue, type Labels } from './util'

export const ERR_DUPLICATE_ALERT = 'vector contains metrics with the same labelset after applying alert labels'
export const ERR_DUPLICATE_SERIES = 'vector contains metrics with the same labelset after applying rule labels'

export interface Series {
  metric: Labels
  value: number
  /** The value exactly as the evaluator printed it. */
  text: string
  /**
   * Annotations that belong to this series at this evaluation, set after the rule's own
   * templates (an anomaly rule's explanation of the flagged point). Absent for query results.
   */
  annotations?: Labels
}

/** A scalar result is one sample with no labels, as in Prometheus' `EngineQueryFunc`. */
export function toSeries(r: PromVector | PromScalar): Series[] {
  if (r.resultType === 'scalar') return [{ metric: {}, value: parseSampleValue(r.result[1]), text: r.result[1] }]
  if (r.resultType !== 'vector') throw new Error(`rule result must be a vector or scalar, got ${String((r as { resultType: unknown }).resultType)}`)
  return r.result.map((s) => ({ metric: s.metric, value: parseSampleValue(s.value[1]), text: s.value[1] }))
}

export interface AlertEvalOptions {
  resolvedRetentionMs: number
  /** 0 = unlimited. */
  limit: number
  maxAnnotationBytes: number
  externalLabels: Labels
}

export interface Notification {
  fingerprint: string
  status: 'firing' | 'resolved'
}

export type AlertEvalResult =
  | {
      ok: true
      /** The rule's alerts after this evaluation. `prev` is never mutated. */
      alerts: Map<string, Alert>
      /** Alerts whose persisted form changed (a transition): upsert if still present, delete if not. */
      dirty: Set<string>
      /** Transitions the notifier must hear about. */
      notify: Notification[]
      /** The rule's no-data policy applied at this evaluation (the data was missing). */
      noData: boolean
    }
  | { ok: false; error: string }

function truncate(s: string, maxBytes: number): string {
  if (s.length <= maxBytes && byteLength(s) <= maxBytes) return s
  let out = s.slice(0, maxBytes)
  while (byteLength(out) > maxBytes - 16) out = out.slice(0, Math.floor(out.length * 0.9))
  return out + '… [truncated]'
}

function sameMap(a: Labels, b: Labels): boolean {
  const ka = Object.keys(a)
  if (ka.length !== Object.keys(b).length) return false
  for (const k of ka) if (a[k] !== b[k]) return false
  return true
}

/** True for the synthetic alert a rule with `no_data: alerting` raises while its data is missing. */
export function isNoDataAlert(a: { labels: Labels }): boolean {
  return a.labels[NO_DATA_LABEL] === 'true'
}

/**
 * `presence` is the result of the rule's no-data expression at the same evaluation time,
 * when it has one; otherwise the rule's own result decides whether data is missing.
 * This one function is the state machine for live evaluation AND for backtests.
 */
export function evalAlertingRule(
  rule: AlertingRuleV2,
  compiled: CompiledAlertRule,
  prev: ReadonlyMap<string, Alert>,
  series: Series[],
  ts: number,
  opts: AlertEvalOptions,
  presence?: Series[] | null,
): AlertEvalResult {
  const policy = rule.noData
  const noData = policy !== undefined && policy.mode !== 'ok' && (presence ?? series).length === 0
  if (noData && policy.mode === 'keep') {
    // Keep the last state: nothing is known, so nothing changes. A pending alert is not
    // promoted (no evidence that the condition still holds) and a firing one is not
    // resolved. Only resolved alerts that are merely being retained still age out.
    const next = new Map(prev)
    const dirty = new Set<string>()
    for (const [fp, a] of prev) {
      if (a.state === 'inactive' && a.resolvedAt !== null && ts - a.resolvedAt > opts.resolvedRetentionMs) {
        next.delete(fp)
        dirty.add(fp)
      }
    }
    return { ok: true, alerts: next, dirty, notify: [], noData: true }
  }
  // Alerting on no data: the missing data is itself a series, which then goes through the
  // ordinary pending -> firing path with the policy's own hold time.
  if (noData) series = [...series, { metric: { [NO_DATA_LABEL]: 'true' }, value: NaN, text: 'NaN' }]
  const holdMs = (a: Alert): number => (policy !== undefined && isNoDataAlert(a) ? policy.forMs : rule.forMs)
  // "Create pending alerts for any new vector elements in the alert expression."
  const result = new Map<string, Alert>()
  for (const s of series) {
    const data = { labels: s.metric, externalLabels: opts.externalLabels, value: s.value }
    // Label precedence: series labels minus the metric name, then rule labels over them
    // (an empty expanded value removes the label, as `labels.Builder.Set` does), then
    // `alertname`, which nothing can override.
    const labels: Labels = {}
    for (const k in s.metric) if (k !== '__name__') labels[k] = s.metric[k] as string
    for (const [name, tmpl] of compiled.labels) {
      const v = expandTemplate(tmpl, data)
      if (v === '') delete labels[name]
      else labels[name] = v
    }
    labels.alertname = rule.name
    const fp = fingerprint(labels)
    if (result.has(fp)) return { ok: false, error: ERR_DUPLICATE_ALERT }
    const annotations: Labels = {}
    for (const [name, tmpl] of compiled.annotations) annotations[name] = truncate(expandTemplate(tmpl, data), opts.maxAnnotationBytes)
    if (s.annotations) for (const [name, v] of Object.entries(s.annotations)) annotations[name] = truncate(v, opts.maxAnnotationBytes)
    result.set(fp, { fingerprint: fp, labels, annotations, state: 'pending', activeAt: ts, firedAt: null, resolvedAt: null, keepFiringSince: null, value: s.value })
  }

  const next = new Map(prev)
  const dirty = new Set<string>()

  // "Check whether we already have alerting state for the identifying label set. Update
  // the last value and annotations if so, create a new alert entry otherwise."
  for (const [fp, a] of result) {
    const existing = next.get(fp)
    if (existing && existing.state !== 'inactive') {
      // Value and annotations are refreshed in memory only: not a transition, no write.
      if (!Object.is(existing.value, a.value) || !sameMap(existing.annotations, a.annotations)) {
        next.set(fp, { ...existing, value: a.value, annotations: a.annotations })
      }
      continue
    }
    next.set(fp, a)
    dirty.add(fp)
  }

  let numActivePending = 0
  // "Check if any pending alerts should be removed or fire now."
  for (const [fp, before] of next) {
    let a = before
    if (!result.has(fp)) {
      // "Use keepFiringFor value to determine if the alert should keep firing."
      let keepFiring = false
      if (a.state === 'firing' && rule.keepFiringForMs > 0) {
        if (a.keepFiringSince === null) {
          a = { ...a, keepFiringSince: ts }
          dirty.add(fp)
        }
        if (ts - (a.keepFiringSince as number) < rule.keepFiringForMs) keepFiring = true
      }
      // "If the alert is resolved (was firing but is now inactive) keep it for at least
      // the retention period." A pending alert whose series is gone is dropped at once.
      let deleted = false
      if (a.state === 'pending' || (a.resolvedAt !== null && ts - a.resolvedAt > opts.resolvedRetentionMs)) {
        next.delete(fp)
        dirty.add(fp)
        deleted = true
      }
      if (a.state !== 'inactive' && !keepFiring) {
        a = { ...a, state: 'inactive', resolvedAt: ts }
        dirty.add(fp)
      }
      if (!deleted && a !== before) next.set(fp, a)
      if (!keepFiring) continue
    } else if (a.keepFiringSince !== null) {
      // "The alert is firing, reset keepFiringSince."
      a = { ...a, keepFiringSince: null }
      next.set(fp, a)
      dirty.add(fp)
    }
    numActivePending++

    if (a.state === 'pending' && ts - a.activeAt >= holdMs(a)) {
      a = { ...a, state: 'firing', firedAt: ts }
      next.set(fp, a)
      dirty.add(fp)
    }
    // "If the alert is firing and the active time is less than the new hold duration, set
    // the state to pending." (the rule was saved with a longer `for`)
    if (a.state === 'firing' && ts - a.activeAt < holdMs(a)) {
      a = { ...a, state: 'pending', firedAt: null, keepFiringSince: null }
      next.set(fp, a)
      dirty.add(fp)
    }
  }

  if (opts.limit > 0 && numActivePending > opts.limit) {
    return { ok: false, error: `exceeded limit of ${opts.limit} with ${numActivePending} alerts` }
  }

  const notify: Notification[] = []
  for (const fp of dirty) {
    const wasFiring = prev.get(fp)?.state === 'firing'
    const isFiring = next.get(fp)?.state === 'firing'
    if (isFiring && !wasFiring) notify.push({ fingerprint: fp, status: 'firing' })
    else if (wasFiring && !isFiring) notify.push({ fingerprint: fp, status: 'resolved' })
  }
  return { ok: true, alerts: next, dirty, notify, noData }
}

/**
 * A recording rule's samples: the metric name becomes `record`, rule labels overlay the
 * series labels, and two series that end up with the same labels are an error
 * (prometheus/rules/recording.go).
 */
export function evalRecordingRule(
  rule: RecordingRule,
  series: Series[],
  sampleTimeMs: number,
  limit: number,
): { ok: true; samples: RecordedSample[] } | { ok: false; error: string } {
  const seen = new Set<string>()
  const samples: RecordedSample[] = []
  for (const s of series) {
    const labels: Labels = { ...s.metric, __name__: rule.name }
    for (const [k, v] of Object.entries(rule.labels)) {
      if (v === '') delete labels[k]
      else labels[k] = v
    }
    const key = labelsKey(labels)
    if (seen.has(key)) return { ok: false, error: ERR_DUPLICATE_SERIES }
    seen.add(key)
    samples.push({ labels, timeMs: sampleTimeMs, value: s.text })
  }
  if (limit > 0 && samples.length > limit) return { ok: false, error: `exceeded limit of ${limit} with ${samples.length} series` }
  return { ok: true, samples }
}

/**
 * The synthetic series Prometheus writes for each pending or firing alert. Nothing in viz
 * writes these yet; the function defines them so the write path can be added later
 * without re-deriving the semantics:
 *
 *   ALERTS{alertname, alertstate="pending"|"firing", <alert labels>}  = 1
 *   ALERTS_FOR_STATE{alertname, <alert labels>}                       = activeAt, Unix seconds
 *
 * Both are stamped with the evaluation time (minus the group's query offset). Retained
 * resolved alerts (`inactive`) produce nothing. In Prometheus `ALERTS_FOR_STATE` exists to
 * restore `for` timers after a restart; the ruler persists `activeAt` itself, so here the
 * series would only be for users who query it.
 */
export function syntheticSeries(alerts: Iterable<Alert>, sampleTimeMs: number): RecordedSample[] {
  const out: RecordedSample[] = []
  for (const a of alerts) {
    if (a.state === 'inactive') continue
    out.push({ labels: { ...a.labels, __name__: 'ALERTS', alertstate: a.state }, timeMs: sampleTimeMs, value: '1' })
    out.push({ labels: { ...a.labels, __name__: 'ALERTS_FOR_STATE' }, timeMs: sampleTimeMs, value: String(Math.floor(a.activeAt / 1000)) })
  }
  return out
}
