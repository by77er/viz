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
  422: 'Not valid', 428: 'Precondition required', 500: 'Internal error', 503: 'Unavailable',
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
      type: `https://vis.bitcru.sh/problems/${this.code}`,
      title: TITLES[this.status] ?? 'Error',
      status: this.status,
      code: this.code,
      detail: this.message,
      fix: this.fix,
      ...this.extra,
    }
  }
}

export const notFound = (what: string): Problem =>
  new Problem(404, 'not-found', `No such ${what}.`, `List the ${what}s you can see and use an id from that list. Ids from another tenant never resolve.`)

export const invalid = (detail: string, fix: string, extra: Record<string, unknown> = {}): Problem => new Problem(422, 'invalid', detail, fix, extra)
