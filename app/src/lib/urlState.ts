import { isValidTimeSpec, parseDuration, type TimeSpec } from './time'

/**
 * Everything that defines an Explore view lives in the URL so any view is a shareable link.
 * Credentials never do (see shell/settings.ts).
 */
export const RESULT_VIEWS = ['chart', 'table', 'text', 'json'] as const
export type ResultView = (typeof RESULT_VIEWS)[number]

export interface ExploreSearch {
  /** PromQL expression. */
  q: string
  from: TimeSpec
  to: TimeSpec
  /** `auto` or a Prometheus duration. */
  step: string
  /** `auto` or a unit id from lib/units. */
  unit: string
  /** The form the result is shown in. */
  view: ResultView
}

export const DEFAULT_SEARCH: ExploreSearch = {
  q: '',
  from: 'now-1h',
  to: 'now',
  step: 'auto',
  unit: 'auto',
  view: 'chart',
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : undefined

/** Validate untrusted search params (strings or JSON-parsed values) into a full state. */
export function parseExploreSearch(raw: Record<string, unknown>): ExploreSearch {
  const from = str(raw.from)
  const to = str(raw.to)
  const step = str(raw.step)
  const unit = str(raw.unit)
  return {
    q: str(raw.q) ?? DEFAULT_SEARCH.q,
    from: from && isValidTimeSpec(from) ? from : DEFAULT_SEARCH.from,
    to: to && isValidTimeSpec(to) ? to : DEFAULT_SEARCH.to,
    step: step && (step === 'auto' || parseDuration(step)) ? step : DEFAULT_SEARCH.step,
    unit: unit && /^[a-z0-9/_-]{1,16}$/i.test(unit) ? unit : DEFAULT_SEARCH.unit,
    // Links from before the three forms shared one control carried `tab=json`.
    view: RESULT_VIEWS.includes(raw.view as ResultView) ? (raw.view as ResultView) : raw.tab === 'json' ? 'json' : 'chart',
  }
}

/** Only the fields that differ from the defaults. */
export function withoutDefaults(s: ExploreSearch): Partial<ExploreSearch> {
  const out: Record<string, string> = {}
  for (const key of Object.keys(DEFAULT_SEARCH) as (keyof ExploreSearch)[]) {
    if (s[key] !== DEFAULT_SEARCH[key]) out[key] = s[key]
  }
  return out as Partial<ExploreSearch>
}

/** Plain `URLSearchParams` form; defaults are omitted to keep links short. */
export function exploreSearchToParams(s: ExploreSearch): URLSearchParams {
  const p = new URLSearchParams()
  for (const key of Object.keys(DEFAULT_SEARCH) as (keyof ExploreSearch)[]) {
    if (s[key] !== DEFAULT_SEARCH[key]) p.set(key, s[key])
  }
  return p
}

export function exploreSearchFromParams(p: URLSearchParams): ExploreSearch {
  return parseExploreSearch(Object.fromEntries(p.entries()))
}

/** Router adapters: flat string params, no JSON quoting, defaults dropped. */
export function parseSearchString(searchStr: string): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(searchStr.replace(/^\?/, '')).entries())
}

export function stringifySearch(search: Record<string, unknown>): string {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(search)) {
    const s = str(v)
    if (s === undefined) continue
    if (k in DEFAULT_SEARCH && DEFAULT_SEARCH[k as keyof ExploreSearch] === s) continue
    p.set(k, s)
  }
  const out = p.toString()
  return out ? `?${out}` : ''
}
