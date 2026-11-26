/** Prometheus HTTP API shapes (mirrors contracts/engine.ts PromMatrix / PromVector / PromScalar). */

export type Metric = Record<string, string>

export interface PromMatrixData {
  resultType: 'matrix'
  result: { metric: Metric; values: [number, string][] }[]
}
export interface PromVectorData {
  resultType: 'vector'
  result: { metric: Metric; value: [number, string] }[]
}
export interface PromScalarData {
  resultType: 'scalar'
  result: [number, string]
}
export interface PromStringData {
  resultType: 'string'
  result: [number, string]
}
export type PromQueryData = PromMatrixData | PromVectorData | PromScalarData | PromStringData

export interface PromSuccess<T> {
  status: 'success'
  data: T
  warnings?: string[]
  infos?: string[]
}
export interface PromFailure {
  status: 'error'
  errorType: string
  error: string
}
export type PromEnvelope<T> = PromSuccess<T> | PromFailure

export interface BuildInfo {
  version: string
  revision?: string
  /** Set by the development mock so the UI can say so. Real backends omit it. */
  mock?: boolean
}

/** Who an API key is, as control's `GET /whoami` answers (control/README.md, "Who is calling"). */
export interface Identity {
  tenant: string
  subject: string
  /** `key` or `agent`. */
  kind: string
  name: string | null
  scopes: string[]
  /** Set by the development mock, so the UI can say what it is talking to from its first frame. The real API omits it. */
  mock?: boolean
}

export interface MetricMetadata {
  type: string
  help: string
  unit?: string
}

/**
 * What the viz API says a request cost, as it says it: its `X-Viz-*` response headers
 * (query/README.md, "What the query cost"), names in lower case. Empty from a backend that
 * sends none (Prometheus), and when a browser is not allowed to read them (CORS).
 */
export type ApiCost = Record<string, string>

export interface ApiResult<T> {
  data: T
  /** Prometheus `warnings`: the result may be incomplete or approximate. */
  warnings: string[]
  /** Prometheus `infos` (Prometheus 3): notes about the query that do not put the result in doubt. */
  infos: string[]
  cost: ApiCost
}
