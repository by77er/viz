import { didYouMean } from './suggest'
import { durationSeconds } from './promql'

/**
 * Tool input schemas are plain JSON Schema (2020-12 subset). The MCP SDK validates them
 * too; this validator runs for both surfaces (MCP and REST) so the errors an agent sees
 * are the same, each with a path and, where one can be computed, a suggestion.
 */
export interface JsonSchema {
  type?: 'object' | 'string' | 'integer' | 'number' | 'boolean' | 'array' | ('string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null')[]
  description?: string
  properties?: Record<string, JsonSchema>
  required?: string[]
  additionalProperties?: boolean | JsonSchema
  enum?: unknown[]
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  pattern?: string
  items?: JsonSchema
  minItems?: number
  maxItems?: number
  default?: unknown
  examples?: unknown[]
}

export interface ArgIssue {
  path: string
  message: string
  suggestion?: string
}

function typeMatches(t: string, v: unknown): boolean {
  switch (t) {
    case 'object':
      return typeof v === 'object' && v !== null && !Array.isArray(v)
    case 'array':
      return Array.isArray(v)
    case 'integer':
      return typeof v === 'number' && Number.isInteger(v)
    case 'number':
      return typeof v === 'number' && Number.isFinite(v)
    case 'null':
      return v === null
    default:
      return typeof v === t
  }
}

export function checkArgs(schema: JsonSchema, value: unknown, path = ''): ArgIssue[] {
  const issues: ArgIssue[] = []
  const at = path || '(arguments)'
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (!types.some((t) => typeMatches(t, value))) {
      issues.push({ path: at, message: `must be ${types.join(' or ')}`, suggestion: schema.examples ? `e.g. ${JSON.stringify(schema.examples[0])}` : undefined })
      return issues
    }
  }
  if (schema.enum && !schema.enum.some((e) => e === value)) {
    const near = typeof value === 'string' ? didYouMean(value, schema.enum.filter((e): e is string => typeof e === 'string'), 1) : []
    issues.push({ path: at, message: `must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}`, suggestion: near[0] ? `did you mean ${JSON.stringify(near[0])}?` : undefined })
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) issues.push({ path: at, message: `must be at least ${schema.minimum}` })
    if (schema.maximum !== undefined && value > schema.maximum) issues.push({ path: at, message: `must be at most ${schema.maximum}` })
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) issues.push({ path: at, message: `must be at least ${schema.minLength} characters` })
    if (schema.maxLength !== undefined && value.length > schema.maxLength) issues.push({ path: at, message: `must be at most ${schema.maxLength} characters` })
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) issues.push({ path: at, message: `must match ${schema.pattern}` })
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) issues.push({ path: at, message: `must have at least ${schema.minItems} items` })
    if (schema.maxItems !== undefined && value.length > schema.maxItems) issues.push({ path: at, message: `must have at most ${schema.maxItems} items` })
    if (schema.items) value.forEach((v, i) => issues.push(...checkArgs(schema.items!, v, `${path}/${i}`)))
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>
    for (const r of schema.required ?? []) if (!(r in obj)) issues.push({ path: `${path}/${r}`, message: 'is required' })
    const props = schema.properties ?? {}
    for (const [k, v] of Object.entries(obj)) {
      if (k in props) issues.push(...checkArgs(props[k]!, v, `${path}/${k}`))
      else if (schema.additionalProperties === false) {
        const near = didYouMean(k, Object.keys(props), 1)
        issues.push({
          path: `${path}/${k}`,
          message: k === 'tenant' ? 'is not accepted: the tenant is always the one your credential belongs to' : 'is not a known argument',
          suggestion: near[0] ? `did you mean ${JSON.stringify(near[0])}?` : `known arguments: ${Object.keys(props).join(', ')}`,
        })
      } else if (typeof schema.additionalProperties === 'object') issues.push(...checkArgs(schema.additionalProperties, v, `${path}/${k}`))
    }
  }
  return issues
}

// ---- shared argument schemas ----

export const MAX_TOKENS_ARG = (dflt: number): JsonSchema => ({
  type: 'integer',
  minimum: 200,
  maximum: 32000,
  default: dflt,
  description: `Upper bound on the size of the text result, in tokens (about 4 characters each). Default ${dflt}. What does not fit is paged: the result says truncated and gives a cursor.`,
})

export const CURSOR_ARG: JsonSchema = { type: 'string', maxLength: 4096, description: 'From a previous truncated result of this tool with the same arguments: continue where it stopped.' }

export const TIME_ARG = (what: string, dflt: string): JsonSchema => ({
  type: ['string', 'number'],
  maxLength: 64,
  description: `${what}: "now", "now-1h" (any Prometheus duration), an RFC 3339 time, or Unix seconds. Default "${dflt}".`,
  examples: [dflt],
})

export const VARIABLES_ARG: JsonSchema = {
  type: 'object',
  additionalProperties: { type: ['string', 'array'], items: { type: 'string', maxLength: 200 }, maxLength: 200 },
  description: 'Dashboard variable values by name, e.g. {"env": "prod", "route": ["/a", "/b"]}. "*" means all. Unset variables use their defaults.',
}

// ---- time ----

export class ArgError extends Error {
  constructor(
    readonly path: string,
    message: string,
    readonly suggestion?: string,
  ) {
    super(message)
  }
}

/** Parse a time argument to Unix seconds. `now` is Unix milliseconds. */
export function parseTime(v: unknown, nowMs: number, path: string): number {
  const now = Math.floor(nowMs / 1000)
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v < 0) throw new ArgError(path, 'is not a valid time')
    return v > 1e11 ? Math.floor(v / 1000) : v
  }
  if (typeof v !== 'string') throw new ArgError(path, 'is not a valid time')
  const s = v.trim()
  if (s === 'now') return now
  const rel = /^now\s*-\s*((?:\d+(?:ms|s|m|h|d|w|y))+)$/.exec(s)
  if (rel) return now - durationSeconds(rel[1]!)
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s)
    return n > 1e11 ? Math.floor(n / 1000) : n
  }
  const ms = Date.parse(s)
  if (/^\d{4}-\d{2}-\d{2}T/.test(s) && Number.isFinite(ms)) return Math.floor(ms / 1000)
  throw new ArgError(path, `${JSON.stringify(s.slice(0, 40))} is not a time`, 'Use "now", "now-1h", an RFC 3339 time such as "2026-11-18T09:00:00Z", or Unix seconds.')
}

/** Parse a step argument (a duration or seconds) to seconds. */
export function parseStep(v: unknown, path: string): number {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v
  if (typeof v === 'string' && /^(?:\d+(?:ms|s|m|h|d|w|y))+$/.test(v)) return durationSeconds(v)
  if (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v) && Number(v) > 0) return Number(v)
  throw new ArgError(path, 'is not a step', 'Use a duration such as "1m" or a number of seconds.')
}

const NICE_STEPS = [15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400]

/** The smallest "nice" step giving at most `points` points over the range, never below 15 s. */
export function autoStep(start: number, end: number, points = 120): number {
  const want = Math.max(1, end - start) / points
  return NICE_STEPS.find((s) => s >= want) ?? Math.ceil(want / 86400) * 86400
}

export function formatDuration(seconds: number): string {
  if (seconds % 86400 === 0) return `${seconds / 86400}d`
  if (seconds % 3600 === 0) return `${seconds / 3600}h`
  if (seconds % 60 === 0) return `${seconds / 60}m`
  if (Number.isInteger(seconds)) return `${seconds}s`
  return `${Math.round(seconds * 1000)}ms`
}

export const isoOf = (sec: number): string => new Date(sec * 1000).toISOString().replace('.000Z', 'Z')
