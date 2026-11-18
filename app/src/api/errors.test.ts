import { describe, expect, it } from 'vitest'
import { PromApiError } from './client'
import { busyLine, errorAdvice, errorKind, RETRY, retryDelayMs, shouldRetry } from './errors'

/** The real API's answers, as e2e/contract.cjs records them (query/src/index.ts, deploy/gateway). */
const REAL = {
  missingKey: new PromApiError('unauthorized', 'missing API key', 401),
  readless: new PromApiError('forbidden', 'API key lacks the read scope', 403),
  busy: new PromApiError('unavailable', 'the query service is busy; retry', 503),
  storage: new PromApiError('unavailable', 'a storage component did not answer; retry', 503, 1000),
  config: new PromApiError('unavailable', "the tenant's query limits: maxSamples must be a non-negative integer", 503, 30_000),
  gateway: new PromApiError('unavailable', 'query did not answer; retry', 502, 1000),
  rateLimited: new PromApiError('http', 'HTTP 429 Too Many Requests', 429, 10_000),
  timeout: new PromApiError('timeout', 'query timed out', 503),
  bytes: new PromApiError('execution', 'query exceeded limit max_query_bytes: 25002 bytes of query text, the limit is 16384', 422),
  unsupported: new PromApiError('unsupported', 'limitk / limit_ratio aggregations', 422),
  manyToOne: new PromApiError('execution', 'found duplicate series for the match group', 422),
  parse: new PromApiError('bad_data', 'parse error: unclosed left parenthesis', 400),
  resolution: new PromApiError('bad_data', 'exceeded maximum resolution of 11000 points per timeseries. Try decreasing the query resolution (?step=XX)', 400),
  internal: new PromApiError('internal', 'internal error', 500),
  network: new PromApiError('network', 'Cannot reach the API: Failed to fetch', 0),
  notEnvelope: new PromApiError('parse', 'The response is not a Prometheus API envelope', 200),
}

describe('what an API failure means (errors.ts)', () => {
  it('sorts every answer of the real API into its kind', () => {
    const kinds = Object.fromEntries(Object.entries(REAL).map(([k, e]) => [k, errorKind(e)]))
    expect(kinds).toEqual({
      missingKey: 'auth',
      readless: 'scope',
      busy: 'busy',
      storage: 'busy',
      config: 'busy',
      gateway: 'busy',
      rateLimited: 'busy',
      timeout: 'timeout',
      bytes: 'limit',
      unsupported: 'unsupported',
      manyToOne: 'query',
      parse: 'query',
      resolution: 'query',
      internal: 'server',
      network: 'network',
      notEnvelope: 'response',
    })
    expect(errorKind(new Error('boom'))).toBe('response')
  })

  it('asks again only when the API was busy, at most three times, and never past the stop', () => {
    const budget = 60_000
    for (const e of [REAL.busy, REAL.storage, REAL.gateway, REAL.rateLimited, REAL.config]) expect(shouldRetry(e, 0, 0, budget)).toBe(true)
    for (const e of [REAL.timeout, REAL.missingKey, REAL.readless, REAL.bytes, REAL.parse, REAL.internal, REAL.network, REAL.unsupported])
      expect(shouldRetry(e, 0, 0, budget)).toBe(false)
    expect(shouldRetry(REAL.busy, RETRY.retries - 1, 0, budget)).toBe(true)
    expect(shouldRetry(REAL.busy, RETRY.retries, 0, budget)).toBe(false)
    // Retry-After 30 s, 35 s into the wait: the retry would go after the 60 s stop.
    expect(shouldRetry(REAL.config, 0, 35_000, budget)).toBe(false)
    expect(shouldRetry(REAL.config, 0, 29_000, budget)).toBe(true)
  })

  it('waits as long as Retry-After says, and 1, 2, 4 s when it says nothing', () => {
    expect(retryDelayMs(REAL.storage, 0)).toBe(1000)
    expect(retryDelayMs(REAL.config, 2)).toBe(30_000)
    expect(retryDelayMs(REAL.rateLimited, 0)).toBe(10_000)
    expect([0, 1, 2].map((n) => retryDelayMs(REAL.busy, n))).toEqual([1000, 2000, 4000])
  })

  it('the waiting line says what happened and when the next try goes', () => {
    expect(busyLine(REAL.busy, 2400)).toBe('The API is busy (HTTP 503). Asking again in 3 s.')
    expect(busyLine(REAL.rateLimited, 9000)).toBe('The API is limiting requests (HTTP 429). Asking again in 9 s.')
    expect(busyLine(REAL.gateway, null)).toBe('The API is busy (HTTP 502). Asked again; waiting for the answer.')
    expect(busyLine(REAL.busy, 0)).toBe('The API is busy (HTTP 503). Asked again; waiting for the answer.')
  })

  it('advises by kind, never "change the query" for a key, a busy API or its time limit', () => {
    const advice = (e: PromApiError, tries = 1, ms = 0) => errorAdvice(e, tries, ms, 'Ctrl')
    for (const e of [REAL.missingKey, REAL.readless, REAL.busy, REAL.timeout, REAL.internal, REAL.network]) expect(advice(e)).not.toMatch(/Change the query/)
    expect(advice(REAL.missingKey)).toMatch(/Settings/)
    expect(advice(REAL.readless)).toMatch(/read scope/)
    expect(advice(REAL.busy, 4, 7200)).toBe('The API stayed busy: the query was sent 4 times over 8 s. Run it again in a moment.')
    expect(advice(REAL.timeout)).toMatch(/time limit/)
    expect(advice(REAL.bytes)).toMatch(/more than the API allows/)
    expect(advice(REAL.unsupported)).toMatch(/does not run this part of PromQL/)
    expect(advice(REAL.parse)).toBe('Change the query and press Ctrl Enter to run it again.')
  })
})
