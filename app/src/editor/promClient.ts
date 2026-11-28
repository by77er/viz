import type { PrometheusClient } from '@prometheus-io/codemirror-promql'
import type { PromClient } from '../api/client'

type Matcher = { name: string; type: unknown; value: string; matchesEmpty(): boolean }
type CompletionClient = PrometheusClient

function selector(metricName: string | undefined, matchers?: Matcher[]): string | undefined {
  const parts: string[] = []
  for (const m of matchers ?? []) {
    if (m.name === '__name__' || m.value === '') continue
    // Autocomplete only needs to narrow candidates; equality matchers are enough.
    parts.push(`${m.name}=${JSON.stringify(m.value)}`)
  }
  if (!metricName && parts.length === 0) return undefined
  return `${metricName ?? ''}${parts.length || !metricName ? `{${parts.join(',')}}` : ''}`
}

export interface CompletionOptions {
  /** How long a lookup waits for a newer one before it is sent, in ms. */
  debounceMs?: number
  /**
   * The time range lookups cover, in epoch seconds: the page's query window. Without one the
   * real API looks through all time, reading every data file of the tenant, or refuses with
   * 422 at its limits (query/README.md, "Cheap label endpoints"), so lookups always send one.
   */
  range?: () => { start: number; end: number } | null
}

/** Lookups cover whole hours around the window, so the cache serves every run within the same hours. */
export const LOOKUP_GRAIN = 3600

/** The window of a lookup: the page's range widened to whole hours, or null when the page has none yet. */
export function lookupWindow(range: { start: number; end: number } | null | undefined): { start: number; end: number } | null {
  if (!range) return null
  return { start: Math.floor(range.start / LOOKUP_GRAIN) * LOOKUP_GRAIN, end: Math.ceil(range.end / LOOKUP_GRAIN) * LOOKUP_GRAIN }
}

/** Wait this long before asking the API, so a lookup for every keystroke is never sent. */
export const COMPLETION_DEBOUNCE_MS = 150

/**
 * Adapter from the app's API client to the interface the PromQL editor's autocomplete uses,
 * so completion requests go through the same base URL and bearer token as queries. Results
 * are cached per client instance; failures yield empty lists (autocomplete must never throw).
 *
 * Lookups that depend on what is being typed (label names, label values, series of a
 * selector) are debounced and cancelled: a lookup waits `debounceMs` before it is sent, and a
 * newer lookup of the same kind replaces it. One that has not been sent is never sent; one in
 * flight is aborted through its AbortSignal. A replaced lookup answers with the empty
 * fallback and is not cached. Metadata is fetched once and kept; metric names once per
 * lookup window. Every lookup is bounded by the page's time range, widened to whole hours.
 */
export function completionClient(client: PromClient, options: CompletionOptions = {}): CompletionClient {
  const debounceMs = options.debounceMs ?? COMPLETION_DEBOUNCE_MS
  /** The window to send, and the part of a cache key that names it. */
  const win = () => {
    const w = lookupWindow(options.range?.())
    return { params: w ?? {}, key: w ? `@${w.start}-${w.end}` : '@all' }
  }
  const cache = new Map<string, Promise<unknown>>()
  const pending = new Map<string, { key: string; cancel: () => void }>()

  const once = <T,>(key: string, load: () => Promise<T>, fallback: T): Promise<T> => {
    let p = cache.get(key) as Promise<T> | undefined
    if (!p) {
      p = load().catch(() => {
        cache.delete(key)
        return fallback
      })
      cache.set(key, p)
    }
    return p
  }

  const latest = <T,>(kind: string, key: string, load: (signal: AbortSignal) => Promise<T>, fallback: T): Promise<T> => {
    const hit = cache.get(key) as Promise<T> | undefined
    if (hit) return hit
    pending.get(kind)?.cancel()
    const controller = new AbortController()
    const p = new Promise<T>((resolve) => {
      let settled = false
      const finish = (value: T, keep: boolean) => {
        if (settled) return
        settled = true
        if (!keep) cache.delete(key)
        if (pending.get(kind)?.key === key) pending.delete(kind)
        resolve(value)
      }
      const timer = setTimeout(() => {
        load(controller.signal).then(
          (value) => finish(value, !controller.signal.aborted),
          () => finish(fallback, false),
        )
      }, debounceMs)
      pending.set(kind, {
        key,
        cancel: () => {
          clearTimeout(timer)
          controller.abort()
          finish(fallback, false)
        },
      })
    })
    cache.set(key, p)
    return p
  }

  return {
    labelNames: (metricName) => {
      const sel = selector(metricName)
      const w = win()
      return latest('labels', `labels:${sel}${w.key}`, (signal) => client.labels({ ...(sel ? { match: [sel] } : {}), ...w.params }, { signal }), [])
    },
    labelValues: (labelName, metricName, matchers) => {
      const sel = selector(metricName, matchers as Matcher[] | undefined)
      const w = win()
      return latest(
        'values',
        `values:${labelName}:${sel}${w.key}`,
        (signal) => client.labelValues(labelName, { ...(sel ? { match: [sel] } : {}), ...w.params }, { signal }),
        [],
      )
    },
    metricMetadata: () => once('metadata', () => client.metadata(), {}),
    series: (metricName, matchers) => {
      const sel = selector(metricName, matchers as Matcher[] | undefined) ?? metricName
      const w = win()
      return latest(
        'series',
        `series:${sel}${w.key}`,
        async (signal) => (await client.series([sel], w.params, { signal })).map((labels) => new Map(Object.entries(labels))),
        [],
      )
    },
    metricNames: () => {
      const w = win()
      return once(`names${w.key}`, () => client.labelValues('__name__', w.params), [])
    },
    flags: () => Promise.resolve({}),
  }
}
