/**
 * What an API failure means for the person waiting on it, and whether to ask again.
 *
 * The statuses and error types are the real viz API's (query/README.md, "The envelope";
 * deploy/gateway for 502), plus what a proxy or rate limit in front of it can send (429
 * without an envelope). e2e/contract.cjs checks the mock against the real API on each.
 *
 *   401 unauthorized, 403 forbidden          the key: not accepted / lacks the read scope
 *   429, 502, 504, 503 other than `timeout`  busy: retryable, after Retry-After when given
 *   503 timeout                               the API stopped the query at its time limit
 *   422 execution "query exceeded limit …"    a limit: the query asks for too much
 *   422 unsupported                           valid PromQL viz does not run
 *   400 bad_data, 422 execution (other)       the query or a parameter is wrong
 *   500 internal                              the API failed
 *   0 (no response)                           the network
 */
import { PromApiError } from './client'

export type ErrorKind = 'auth' | 'scope' | 'busy' | 'timeout' | 'limit' | 'unsupported' | 'query' | 'server' | 'network' | 'response'

export function errorKind(error: unknown): ErrorKind {
  if (!(error instanceof PromApiError)) return 'response'
  const { status, errorType, message } = error
  if (errorType === 'network' || status === 0) return 'network'
  if (status === 401) return 'auth'
  if (status === 403) return 'scope'
  if (errorType === 'timeout') return 'timeout'
  if (status === 429 || status === 502 || status === 503 || status === 504) return 'busy'
  if (errorType === 'unsupported') return 'unsupported'
  if (errorType === 'execution' && /^query exceeded limit /.test(message)) return 'limit'
  if (status === 400 || status === 422 || errorType === 'bad_data' || errorType === 'execution') return 'query'
  if (errorType === 'parse') return 'response'
  return 'server'
}

/** Asking again: at most this many retries (so four tries), and never past the waiting table's 60 s stop. */
export const RETRY = {
  /** Retries after the first try. */
  retries: 3,
  /** Without Retry-After: 1 s, then 2 s, then 4 s. */
  firstDelayMs: 1000,
} as const

/** How long to wait before retry number `failures + 1` (failures counted from 0): the API's Retry-After when it gave one. */
export function retryDelayMs(error: unknown, failures: number): number {
  if (error instanceof PromApiError && error.retryAfterMs !== null) return error.retryAfterMs
  return RETRY.firstDelayMs * 2 ** Math.max(0, failures)
}

/**
 * Whether to ask again after `failures + 1` failed tries, `elapsedMs` into a wait that is
 * stopped at `budgetMs`: only when the API said it was busy, at most `RETRY.retries` times,
 * and only when the retry would be sent before the stop.
 */
export function shouldRetry(error: unknown, failures: number, elapsedMs: number, budgetMs: number): boolean {
  if (errorKind(error) !== 'busy') return false
  if (failures >= RETRY.retries) return false
  return elapsedMs + retryDelayMs(error, failures) < budgetMs
}

/** "HTTP 503", or "HTTP 429" for the busy line and the error state. */
const http = (error: unknown) => (error instanceof PromApiError && error.status ? `HTTP ${error.status}` : 'no HTTP status')

/** Whole seconds, at least one: "3 s". */
export const seconds = (ms: number) => `${Math.max(1, Math.ceil(ms / 1000))} s`

/**
 * The waiting line while a busy answer is being retried: what happened, and when the next
 * try goes (or that it has gone). `untilRetryMs` is null once the retry has been sent.
 */
export function busyLine(error: unknown, untilRetryMs: number | null): string {
  const what = error instanceof PromApiError && error.status === 429 ? 'The API is limiting requests' : 'The API is busy'
  return untilRetryMs !== null && untilRetryMs > 0
    ? `${what} (${http(error)}). Asking again in ${seconds(untilRetryMs)}.`
    : `${what} (${http(error)}). Asked again; waiting for the answer.`
}

/**
 * The error state's advice: what to do next, in terms of the kind of failure. `tries` is how
 * many times the query was sent, `elapsedMs` how long all of them took.
 */
export function errorAdvice(error: unknown, tries: number, elapsedMs: number, mod: string): string {
  switch (errorKind(error)) {
    case 'network':
      return 'Check the connection and the API address in Settings, then run the query again.'
    case 'auth':
      return 'The API did not accept the API key. Enter a valid key in Settings.'
    case 'scope':
      return 'The API key in Settings cannot read metrics. Use a key with the read scope.'
    case 'busy':
      return tries > 1
        ? `The API stayed busy: the query was sent ${tries} times over ${seconds(elapsedMs)}. Run it again in a moment.`
        : 'The API was busy. Run the query again in a moment.'
    case 'timeout':
      return 'The API stopped the query at its time limit. Narrow the time range or select fewer series, then run it again.'
    case 'limit':
      return 'The query asks for more than the API allows. Narrow the time range or select fewer series.'
    case 'unsupported':
      return 'viz does not run this part of PromQL yet. Write the query without it.'
    case 'server':
      return 'The API failed on its side. Run the query again; if it keeps failing, note the time and report it.'
    case 'response':
      return 'The answer was not a Prometheus API response. Check the API address in Settings.'
    case 'query':
      return `Change the query and press ${mod} Enter to run it again.`
  }
}
