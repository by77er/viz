import { describe, expect, it } from 'vitest'
import { PromApiError } from './client'
import { answerLine, busyLine, errorAdvice, errorKind, limitName, RETRY, retryDelayMs, shouldRetry } from './errors'

/** The real API's answers, as e2e/contract.cjs records them (query/src/index.ts, deploy/gateway). */
const REAL = {
  missingKey: new PromApiError('unauthorized', 'missing API key', 401),
  readless: new PromApiError('forbidden', 'API key lacks the read scope', 403),
  // Retry-After: 1 since query/ answers every `unavailable` with it (2026-11-19).
  busy: new PromApiError('unavailable', 'the query service is busy; retry', 503, 1000),
  // Not the viz API: the platform's own 503 page when a Worker fails (no envelope, no Retry-After).
  platform: new PromApiError('http', 'HTTP 503 Service Unavailable', 503),
  storage: new PromApiError('unavailable', 'a storage component did not answer; retry', 503, 1000),
  config: new PromApiError('unavailable', "the tenant's query limits: maxSamples must be a non-negative integer", 503, 30_000),
  gateway: new PromApiError('unavailable', 'query did not answer; retry', 502, 1000),
  rateLimited: new PromApiError('http', 'HTTP 429 Too Many Requests', 429, 10_000),
  timeout: new PromApiError('timeout', 'query timed out', 503),
  bytes: new PromApiError('execution', 'query exceeded limit max_query_bytes: 25002 bytes of query text, the limit is 16384', 422),
  depth: new PromApiError('execution', 'query exceeded limit max_depth: 101 levels of nesting (brackets and operators), the limit is 100', 422),
  samples: new PromApiError('execution', 'query exceeded limit max_samples: 2000001 samples loaded, the limit is 2000000', 422),
  points: new PromApiError('execution', 'query exceeded limit max_output_points: 500001 points in the result, the limit is 500000', 422),
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
      platform: 'busy',
      storage: 'busy',
      config: 'busy',
      gateway: 'busy',
      rateLimited: 'busy',
      timeout: 'timeout',
      bytes: 'limit',
      depth: 'limit',
      samples: 'limit',
      points: 'limit',
      unsupported: 'unsupported',
      manyToOne: 'query',
      parse: 'query',
      resolution: 'resolution',
      internal: 'server',
      network: 'network',
      notEnvelope: 'response',
    })
    expect(errorKind(new Error('boom'))).toBe('response')
  })

  it('asks again only when the API was busy, at most three times, and never past the stop', () => {
    const budget = 60_000
    for (const e of [REAL.busy, REAL.platform, REAL.storage, REAL.gateway, REAL.rateLimited, REAL.config]) expect(shouldRetry(e, 0, 0, budget)).toBe(true)
    for (const e of [REAL.timeout, REAL.missingKey, REAL.readless, REAL.bytes, REAL.parse, REAL.resolution, REAL.internal, REAL.network, REAL.unsupported])
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
    expect([0, 1, 2].map((n) => retryDelayMs(REAL.busy, n))).toEqual([1000, 1000, 1000])
    expect([0, 1, 2].map((n) => retryDelayMs(REAL.platform, n))).toEqual([1000, 2000, 4000])
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
    expect(advice(REAL.bytes)).toMatch(/longer than the API allows/)
    expect(advice(REAL.unsupported)).toMatch(/does not run this part of PromQL/)
    expect(advice(REAL.parse)).toBe('Change the query and press Ctrl Enter to run it again.')
  })

  it('says what to change for each limit: the text, the nesting, the points, or what the query reads', () => {
    const advice = (e: PromApiError) => errorAdvice(e, 1, 0, 'Ctrl')
    expect(limitName(REAL.bytes)).toBe('max_query_bytes')
    expect(advice(REAL.bytes)).toBe('The query text is longer than the API allows. Shorten the query.')
    expect(advice(REAL.depth)).toBe('The query is nested more deeply than the API allows. Simplify the query.')
    expect(advice(REAL.points)).toBe('The result would hold more points than the API allows. Use a larger step or a shorter time range.')
    expect(advice(REAL.samples)).toBe('The query reads more data than the API allows. Narrow the time range or select fewer series.')
    for (const e of [REAL.bytes, REAL.depth]) expect(advice(e)).not.toMatch(/time range/)
  })

  it('a step too small for the range is about the step, not the query', () => {
    const advice = (autoStep: boolean) => errorAdvice(REAL.resolution, 1, 0, 'Ctrl', { autoStep })
    expect(advice(false)).toBe('The step is too small for this time range: the API returns at most 11,000 points per series. Use a larger step, or the automatic one.')
    expect(advice(true)).toBe('The time range is too long for one query: the API returns at most 11,000 points per series. Choose a shorter range.')
    expect(advice(false)).not.toMatch(/Change the query/)
  })

  it('a 401 with no key set asks for a key; with one, for a valid one', () => {
    expect(errorAdvice(REAL.missingKey, 1, 0, 'Ctrl', { keySet: false })).toBe('No API key is set. Enter a key with the read scope in Settings.')
    expect(errorAdvice(REAL.missingKey, 1, 0, 'Ctrl', { keySet: true })).toBe('The API did not accept the API key. Enter a valid key in Settings.')
  })

  it('says "the API answered" only for the API\'s own error envelope', () => {
    expect(answerLine(REAL.parse)).toBe('The API answered bad_data with HTTP 400.')
    expect(answerLine(REAL.network)).toBe('No answer came back.')
    expect(answerLine(REAL.platform)).toBe('The answer was HTTP 503 with no API error in it.')
    expect(answerLine(REAL.notEnvelope)).toBe('The answer (HTTP 200) was not an API response.')
  })
})
