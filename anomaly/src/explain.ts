/**
 * Explanations: one short sentence built only from numbers the detector computed, plus the
 * same numbers in structured form. Formatting is deterministic (UTC, no locale).
 */
import type { Explanation } from './types.ts'

/** Three significant figures, no exponent below 1e21, "-0" printed as "0". */
export function fmt(x: number): string {
  if (!Number.isFinite(x)) return String(x)
  if (x === 0) return '0'
  const r = Number(x.toPrecision(3))
  return Object.is(r, -0) ? '0' : String(r)
}

export function withUnit(x: number, unit: string | undefined): string {
  return unit ? `${fmt(x)} ${unit}` : fmt(x)
}

const UNITS: [number, string][] = [
  [7 * 86_400_000, 'week'],
  [86_400_000, 'day'],
  [3_600_000, 'hour'],
  [60_000, 'minute'],
  [1000, 'second'],
]

/** "4 weeks", "1 day", "90 minutes", "1.5 seconds". */
export function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0 seconds'
  for (const [size, name] of UNITS) {
    if (ms >= size && ms % size === 0) {
      const n = ms / size
      return `${n} ${name}${n === 1 ? '' : 's'}`
    }
  }
  for (const [size, name] of UNITS) {
    if (ms >= size) {
      const n = Number((ms / size).toPrecision(3))
      return `${n} ${name}${n === 1 ? '' : 's'}`
    }
  }
  return `${fmt(ms)} ms`
}

/** "2026-11-18 13:02 UTC" (seconds shown only when not zero). */
export function time(ts: number): string {
  if (!Number.isFinite(ts) || Math.abs(ts) > 8.64e15) return String(ts)
  const iso = new Date(ts).toISOString() // YYYY-MM-DDTHH:MM:SS.sssZ
  const date = iso.slice(0, 10)
  const hm = iso.slice(11, 16)
  const s = iso.slice(17, 19)
  return `${date} ${hm}${s === '00' ? '' : ':' + s} UTC`
}

/** Names the seasonal phase: "same hour of the week", "same time of day". */
export function phaseName(periodMs: number, stepMs: number): { phase: string; season: string } {
  const unit = stepMs >= 3_600_000 && stepMs % 3_600_000 === 0 ? 'hour' : 'time'
  if (periodMs === 7 * 86_400_000) return { phase: unit === 'hour' ? 'same hour of the week' : 'same time of the week', season: 'week' }
  if (periodMs === 86_400_000) return { phase: unit === 'hour' ? 'same hour of the day' : 'same time of day', season: 'day' }
  if (periodMs === 3_600_000) return { phase: 'same minute of the hour', season: 'hour' }
  return { phase: `same phase of the ${duration(periodMs)} cycle`, season: `${duration(periodMs)} cycle` }
}

/** "1 week", "4 weeks", "3 days". */
export function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}

/**
 * The common "deviation from a reference" sentence:
 *   "<value> is <d> <spreadWord> above <referenceLabel> <reference>".
 * Every number in the text is a field of the returned object.
 */
export function deviation(args: {
  detector: string
  kind: Explanation['kind']
  value: number
  reference: number
  referenceLabel: string
  deviations: number
  spread: number
  spreadLabel: string
  /** e.g. "robust standard deviations" */
  spreadWord: string
  at: number
  unit?: string
  facts?: Record<string, number | string>
  suffix?: string
}): Explanation {
  const direction = args.value >= args.reference ? 'above' : 'below'
  const text =
    `${withUnit(args.value, args.unit)} is ${fmt(args.deviations)} ${args.spreadWord} ${direction} ` +
    `${args.referenceLabel} (${withUnit(args.reference, args.unit)})` +
    (args.suffix ? `; ${args.suffix}` : '')
  return {
    text,
    detector: args.detector,
    kind: args.kind,
    direction,
    value: args.value,
    reference: args.reference,
    referenceLabel: args.referenceLabel,
    deviations: args.deviations,
    spread: args.spread,
    spreadLabel: args.spreadLabel,
    at: args.at,
    facts: { ...(args.facts ?? {}) },
  }
}

/** "mean shifted from 120 ms to 310 ms at 2026-11-18 13:02 UTC (8.1 standard deviations)". */
export function levelShift(args: {
  detector: string
  from: number
  to: number
  changeAt: number
  sigma: number
  unit?: string
  facts?: Record<string, number | string>
}): Explanation {
  const deviations = Math.abs(args.to - args.from) / (args.sigma > 0 ? args.sigma : 1)
  const direction = args.to >= args.from ? 'above' : 'below'
  const text =
    `mean shifted from ${withUnit(args.from, args.unit)} to ${withUnit(args.to, args.unit)} at ${time(args.changeAt)}` +
    ` (${fmt(deviations)} standard deviations)`
  return {
    text,
    detector: args.detector,
    kind: 'level_shift',
    direction,
    value: args.to,
    reference: args.from,
    referenceLabel: 'mean before the change',
    deviations,
    spread: args.sigma,
    spreadLabel: 'standard deviation of the noise',
    at: args.changeAt,
    facts: { ...(args.facts ?? {}) },
  }
}
