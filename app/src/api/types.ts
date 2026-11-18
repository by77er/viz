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

export interface MetricMetadata {
  type: string
  help: string
  unit?: string
}

export interface ApiResult<T> {
  data: T
  warnings: string[]
}
