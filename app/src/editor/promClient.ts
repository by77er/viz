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
 * fallback and is not cached. The two whole-backend lists (metric names, metadata) are
 * fetched once and kept.
 */
export function completionClient(client: PromClient, options: CompletionOptions = {}): CompletionClient {
  const debounceMs = options.debounceMs ?? COMPLETION_DEBOUNCE_MS
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
      return latest('labels', `labels:${sel}`, (signal) => client.labels(sel ? { match: [sel] } : {}, { signal }), [])
    },
    labelValues: (labelName, metricName, matchers) => {
      const sel = selector(metricName, matchers as Matcher[] | undefined)
      return latest('values', `values:${labelName}:${sel}`, (signal) => client.labelValues(labelName, sel ? { match: [sel] } : {}, { signal }), [])
    },
    metricMetadata: () => once('metadata', () => client.metadata(), {}),
    series: (metricName, matchers) => {
      const sel = selector(metricName, matchers as Matcher[] | undefined) ?? metricName
      return latest(
        'series',
        `series:${sel}`,
        async (signal) => (await client.series([sel], {}, { signal })).map((labels) => new Map(Object.entries(labels))),
        [],
      )
    },
    metricNames: () => once('names', () => client.labelValues('__name__'), []),
    flags: () => Promise.resolve({}),
  }
}
