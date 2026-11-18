import { seriesKey, type Labels } from './series'

/**
 * Names for the series of one result (design review M5: "truncation never hides the part
 * that distinguishes one item from another").
 *
 * - Labels whose value is the same on every series say nothing about any one of them: they
 *   are dropped from the name and reported once, as `common`.
 * - The labels that are left are ordered by how many distinct values they take in the
 *   result, most first (ties by label name), so the most distinguishing part leads.
 * - When exactly one label distinguishes the series (often `service`, or only `__name__`),
 *   its value is the whole name: "checkout".
 * - A single series, and series with identical label sets, keep their full name.
 * - `short` shortens long values in the MIDDLE, and only if every pair of series that had
 *   different names still has different names afterwards; otherwise nothing is shortened.
 *
 * Everything depends on the set of label sets only, never on their order.
 */
export interface SeriesNaming {
  /** Prometheus form with every label: `name{a="b", c="d"}`. */
  full: string
  /** What tells this series from the others, most distinguishing label first. Never shortened. */
  name: string
  /** `name`, or a middle-truncated form of it that is still unique in the result. */
  short: string
}

export interface ResultNaming {
  /** One entry per input label set, in input order. */
  names: SeriesNaming[]
  /** Labels with the same value on every series (empty for a single series). */
  common: Labels
  /** The labels that differ, most distinct values first. */
  distinguishing: string[]
  /** The one label whose value is used as the name, when there is exactly one. */
  valueOnly: string | null
}

export const NAME_LENGTH = 40
/** Value lengths tried, longest first, when a name is over the limit. */
const VALUE_LENGTHS = [32, 24, 16, 12, 8]
const IDENTIFIER = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/
const has = (l: Labels, k: string) => Object.prototype.hasOwnProperty.call(l, k)

/** Keep the two ends: "checkout-6b7f9-x2k4p" at 12 is "checko…x2k4p". */
export function middleTruncate(text: string, max: number): string {
  if (text.length <= max || max < 3) return text
  const head = Math.ceil((max - 1) / 2)
  const tail = Math.floor((max - 1) / 2)
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`
}

/** `name{k="v", …}` over the given labels in the given order; values longer than `maxValue` are cut in the middle. */
function render(labels: Labels, keys: readonly string[], maxValue: number): string {
  const metric = keys.includes('__name__') && has(labels, '__name__') ? labels.__name__! : undefined
  // A metric name that is not an identifier is written as a label, so the form stays unambiguous.
  const prefix = metric !== undefined && IDENTIFIER.test(metric) ? middleTruncate(metric, maxValue) : ''
  const pairs: string[] = []
  for (const k of keys) {
    if (!has(labels, k) || (k === '__name__' && prefix !== '')) continue
    pairs.push(`${k}=${JSON.stringify(middleTruncate(labels[k]!, maxValue))}`)
  }
  if (pairs.length === 0) return prefix || '{}'
  return `${prefix}{${pairs.join(', ')}}`
}

/** In Prometheus a label with an empty value is the same as no label. */
export function withoutEmpty(labels: Labels): Labels {
  const out: Labels = {}
  for (const k of Object.keys(labels)) if (labels[k] !== '') out[k] = labels[k]!
  return out
}

/** Every label, the metric name first: `seriesName`, and still unambiguous for a name that is not an identifier. */
function fullName(labels: Labels): string {
  const keys = Object.keys(labels).sort()
  return render(labels, keys.includes('__name__') ? ['__name__', ...keys.filter((k) => k !== '__name__')] : keys, Infinity)
}

export function nameSeries(input: readonly Labels[], maxLength = NAME_LENGTH): ResultNaming {
  const all = input.map(withoutEmpty)
  const full = all.map(fullName)
  if (all.length === 0) return { names: [], common: {}, distinguishing: [], valueOnly: null }
  if (all.length === 1) {
    return { names: [{ full: full[0]!, name: full[0]!, short: middleTruncate(full[0]!, maxLength) }], common: {}, distinguishing: [], valueOnly: null }
  }

  // Distinct values per label; a missing label counts as a value of its own.
  const seen = new Map<string, Set<string>>()
  for (const labels of all) for (const k of Object.keys(labels)) if (!seen.has(k)) seen.set(k, new Set())
  for (const [k, values] of seen) for (const labels of all) values.add(has(labels, k) ? `=${labels[k]}` : 'missing')
  const common: Labels = {}
  const distinguishing: string[] = []
  for (const [k, values] of seen) {
    if (values.size === 1) common[k] = all[0]![k]!
    else distinguishing.push(k)
  }
  distinguishing.sort((a, b) => seen.get(b)!.size - seen.get(a)!.size || (a < b ? -1 : a > b ? 1 : 0))

  // Identical label sets: nothing distinguishes them, so they keep the full name.
  if (distinguishing.length === 0) {
    return { names: full.map((f) => ({ full: f, name: f, short: middleTruncate(f, maxLength) })), common: {}, distinguishing, valueOnly: null }
  }

  const only = distinguishing.length === 1 ? distinguishing[0]! : null
  const valueOnly = only !== null && all.every((l) => has(l, only)) ? only : null
  const at = (maxValue: number) =>
    all.map((labels) => (valueOnly !== null ? middleTruncate(labels[valueOnly]!, maxValue) : render(labels, distinguishing, maxValue)))

  const name = at(Infinity)
  // Shorten only the names that are too long, and only if no two different series end up alike.
  const keys = all.map(seriesKey)
  const unique = (candidate: string[]) => {
    const owner = new Map<string, string>()
    for (let i = 0; i < candidate.length; i++) {
      const o = owner.get(candidate[i]!)
      if (o !== undefined && o !== keys[i]) return false
      owner.set(candidate[i]!, keys[i]!)
    }
    return true
  }
  let short = name
  if (name.some((n) => n.length > maxLength)) {
    let fallback: string[] | null = null
    let fits: string[] | null = null
    for (const v of VALUE_LENGTHS) {
      const cut = at(v)
      const candidate = name.map((n, i) => (n.length > maxLength ? cut[i]! : n))
      if (!unique(candidate)) continue
      fallback = candidate
      if (candidate.every((c) => c.length <= maxLength)) {
        fits = candidate
        break
      }
    }
    short = fits ?? fallback ?? name
  }
  return { names: all.map((_l, i) => ({ full: full[i]!, name: name[i]!, short: short[i]! })), common, distinguishing, valueOnly }
}
