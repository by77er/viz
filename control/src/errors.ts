import type { SchemaTooNew } from '../../contracts/schema'

/**
 * Problem details (RFC 9457) with two additions every viz error carries: a stable `code`
 * and a `fix` that says what the caller should do next. Agents read `fix`.
 */
export interface ProblemBody {
  type: string
  title: string
  status: number
  code: string
  detail: string
  fix: string
  [extra: string]: unknown
}

const TITLES: Record<number, string> = {
  400: 'Bad request', 401: 'Not authenticated', 403: 'Not allowed', 404: 'Not found', 405: 'Method not allowed',
  409: 'Conflict', 412: 'Precondition failed', 413: 'Too large', 415: 'Unsupported media type',
  422: 'Not valid', 428: 'Precondition required', 429: 'Too many requests', 500: 'Internal error', 503: 'Unavailable',
}

export class Problem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    detail: string,
    readonly fix: string,
    readonly extra: Record<string, unknown> = {},
    readonly headers: Record<string, string> = {},
  ) {
    super(detail)
  }

  body(): ProblemBody {
    return {
      type: `https://viz.bitcru.sh/problems/${this.code}`,
      title: TITLES[this.status] ?? 'Error',
      status: this.status,
      code: this.code,
      detail: this.message,
      fix: this.fix,
      ...this.extra,
    }
  }
}

/**
 * The object's storage was written by a newer release than this code (contracts/COMPATIBILITY.md
 * §2.4). Nothing was read or changed; the same request will work once that release serves it.
 */
export const schemaProblem = (r: SchemaTooNew): Problem =>
  new Problem(
    503,
    'schema-too-new',
    `This tenant's data was last written by a newer release of the service (storage version ${r.found}; this release knows up to ${r.known}). Nothing was changed.`,
    'Retry after the number of seconds in Retry-After. A deployment is in progress or was rolled back.',
    {},
    { 'Retry-After': String(Math.ceil(r.retryAfterMs / 1000)) },
  )

export const notFound = (what: string): Problem =>
  new Problem(404, 'not-found', `No such ${what}.`, `List the ${what}s you can see and use an id from that list. Ids from another tenant never resolve.`)

export const invalid = (detail: string, fix: string, extra: Record<string, unknown> = {}): Problem => new Problem(422, 'invalid', detail, fix, extra)
