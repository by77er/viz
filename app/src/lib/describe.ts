import type { QueryWindow } from './step'
import type { TimeSpec } from './time'
import { inferUnit, isUnitId, type UnitId } from './units'

/**
 * A result describes itself (design review B1).
 *
 * While a new query waits, or after it was cancelled or stopped, the previous result stays
 * on screen. Everything written about the data on screen (the query, the unit, the range, the
 * step, the age, and through them the chart's name and its text form) must then come from the
 * result that is on screen, never from the query in the editor or in the URL. So a result carries the
 * request it answers, and `describeResult` is the only place that turns a result into words.
 * It is given the current request for one purpose only: to say whether the result is still
 * the answer to it.
 */
export interface ResultRequest {
  /** The query text as it was sent. */
  q: string
  from: TimeSpec
  to: TimeSpec
  /** `auto` or a duration, as in the URL. */
  step: string
}

export interface ResultIdentity {
  request: ResultRequest
  /** The resolved, aligned window that was queried (epoch seconds). */
  window: QueryWindow
  /** The unit the query's own text implies, fixed when the result was fetched. */
  inferredUnit: UnitId
  /** Wall-clock time the response arrived (epoch ms). */
  receivedAt: number
}

export function identify(request: ResultRequest, window: QueryWindow, receivedAt: number): ResultIdentity {
  return { request, window, inferredUnit: inferUnit(request.q), receivedAt }
}

export interface ResultDescription {
  /** The query the data on screen answers. */
  q: string
  /** The unit the values on screen are shown in. */
  unit: UnitId
  /** Null when the result answers the current request. */
  stale: 'query' | 'range' | null
  /** Plain words for the panel head while stale. */
  staleText: string | null
}

/**
 * @param result  the result on screen
 * @param display the display options that apply to whatever is on screen: the unit chosen in
 *                the toolbar (`auto` means the unit the RESULT's query implies)
 * @param current the request the page now wants answered; compared, never described
 */
export function describeResult(result: ResultIdentity, display: { unit: string }, current: ResultRequest): ResultDescription {
  const { request } = result
  const unit: UnitId = display.unit !== 'auto' && isUnitId(display.unit) ? display.unit : result.inferredUnit
  const stale = request.q !== current.q ? 'query' : request.from !== current.from || request.to !== current.to || request.step !== current.step ? 'range' : null
  return {
    q: request.q,
    unit,
    stale,
    staleText: stale === 'query' ? 'Showing the previous query' : stale === 'range' ? 'Showing the previous time range' : null,
  }
}
