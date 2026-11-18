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

/**
 * Adapter from the app's API client to the interface the PromQL editor's autocomplete uses,
 * so completion requests go through the same base URL and bearer token as queries. Results
 * are cached per client instance; failures yield empty lists (autocomplete must never throw).
 */
export function completionClient(client: PromClient): CompletionClient {
  const cache = new Map<string, Promise<unknown>>()
  const cached = <T,>(key: string, load: () => Promise<T>, fallback: T): Promise<T> => {
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
  return {
    labelNames: (metricName) => {
      const sel = selector(metricName)
      return cached(`labels:${sel}`, () => client.labels(sel ? { match: [sel] } : {}), [])
    },
    labelValues: (labelName, metricName, matchers) => {
      const sel = selector(metricName, matchers as Matcher[] | undefined)
      return cached(`values:${labelName}:${sel}`, () => client.labelValues(labelName, sel ? { match: [sel] } : {}), [])
    },
    metricMetadata: () => cached('metadata', () => client.metadata(), {}),
    series: (metricName, matchers) => {
      const sel = selector(metricName, matchers as Matcher[] | undefined) ?? metricName
      return cached(
        `series:${sel}`,
        async () => (await client.series([sel])).map((labels) => new Map(Object.entries(labels))),
        [],
      )
    },
    metricNames: () => cached('names', () => client.labelValues('__name__'), []),
    flags: () => Promise.resolve({}),
  }
}
