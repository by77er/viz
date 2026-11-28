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
 *   422 execution "query exceeded limit …"    a limit: the query asks for too much (the advice depends on which)
 *   400 bad_data "exceeded maximum resolution" the step is too small for the range (not the query)
 *   422 unsupported                           valid PromQL viz does not run
 *   400 bad_data, 422 execution (other)       the query or a parameter is wrong
 *   500 internal                              the API failed
 *   0 (no response)                           the network
 */
import { PromApiError } from './client'

export type ErrorKind = 'auth' | 'scope' | 'busy' | 'timeout' | 'limit' | 'resolution' | 'unsupported' | 'query' | 'server' | 'network' | 'response'

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
  // The engine's (and Prometheus') refusal of more than 11,000 points per series: the step, not the query.
  if (status === 400 && /^exceeded maximum resolution of \d+ points/.test(message)) return 'resolution'
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

/** The name of the limit a 422 "query exceeded limit <name>: …" names, or null. */
export function limitName(error: unknown): string | null {
  if (!(error instanceof PromApiError)) return null
  return /^query exceeded limit (\w+)/.exec(error.message)?.[1] ?? null
}

/** What to change for a limit: the query's own size, its points, or what it reads. */
function limitAdvice(name: string | null): string {
  switch (name) {
    case 'max_query_bytes':
      return 'The query text is longer than the API allows. Shorten the query.'
    case 'max_depth':
      return 'The query is nested more deeply than the API allows. Simplify the query.'
    case 'max_output_points':
    case 'max_step_points':
      return 'The result would hold more points than the API allows. Use a larger step or a shorter time range.'
    default:
      // max_samples, max_series, max_fetch_bytes, max_scan_samples, max_files and their split-query forms: what the query reads.
      return 'The query reads more data than the API allows. Narrow the time range or select fewer series.'
  }
}

/**
 * Who answered, before the advice: the API's own error type and status when it sent its
 * error envelope; otherwise what came back, never "the API answered" for an answer that was
 * not the API's (no response at all, or a page from something in front of it).
 */
export function answerLine(error: unknown): string {
  if (!(error instanceof PromApiError)) return 'The answer could not be read.'
  if (error.errorType === 'network' || error.status === 0) return 'No answer came back.'
  if (error.errorType === 'http') return `The answer was HTTP ${error.status} with no API error in it.`
  if (error.errorType === 'parse') return `The answer (HTTP ${error.status}) was not an API response.`
  return `The API answered ${error.errorType} with HTTP ${error.status}.`
}

/** What the page knows that the advice depends on. */
export interface AdviceContext {
  /** Whether this tab holds an API key (a 401 without one is not a refused key). */
  keySet?: boolean
  /** Whether the step is the automatic one (the resolution refusal then names the range). */
  autoStep?: boolean
}

/**
 * The error state's advice: what to do next, in terms of the kind of failure. `tries` is how
 * many times the query was sent, `elapsedMs` how long all of them took.
 */
export function errorAdvice(error: unknown, tries: number, elapsedMs: number, mod: string, context: AdviceContext = {}): string {
  switch (errorKind(error)) {
    case 'network':
      return 'Check the connection, then run the query again.'
    case 'auth':
      if (context.keySet === false) return 'This tab holds no API key. Sign in with a key that has the read scope.'
      return 'The API no longer accepts the key this tab signed in with: it may have been disabled, rotated or expired. Sign in again with a key that is valid now.'
    case 'scope':
      return 'The key this tab signed in with cannot read metrics. Sign in again with a key that has the read scope.'
    case 'busy':
      return tries > 1
        ? `The API stayed busy: the query was sent ${tries} times over ${seconds(elapsedMs)}. Run it again in a moment.`
        : 'The API was busy. Run the query again in a moment.'
    case 'timeout':
      return 'The API stopped the query at its time limit. Narrow the time range or select fewer series, then run it again.'
    case 'limit':
      return limitAdvice(limitName(error))
    case 'resolution': {
      const most = /maximum resolution of (\d+) points/.exec(error instanceof Error ? error.message : '')?.[1]
      const allowed = most ? `at most ${Number(most).toLocaleString('en-US')} points per series` : 'fewer points per series'
      return context.autoStep
        ? `The time range is too long for one query: the API returns ${allowed}. Choose a shorter range.`
        : `The step is too small for this time range: the API returns ${allowed}. Use a larger step, or the automatic one.`
    }
    case 'unsupported':
      return 'viz does not run this part of PromQL yet. Write the query without it.'
    case 'server':
      return 'The API failed on its side. Run the query again; if it keeps failing, note the time and report it.'
    case 'response':
      return 'The answer was not an API response: something between this page and the API answered in its place. Run the query again.'
    case 'query':
      return `Change the query and press ${mod} Enter to run it again.`
  }
}
