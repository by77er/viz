/**
 * The route table: the one place a method and path are bound to an operation and to the
 * scopes that may call it. The Worker dispatches from it, the Tenant object authorises
 * from it, and `test/openapi.test.ts` holds it equal to `openapi.json`.
 *
 * No path, query or body ever carries a tenant. The tenant is the credential's.
 *
 * `SCOPES` is every scope a key can be created with, not only the ones this API checks:
 * `write` and `read` are edge's and the query service's, and `monitors:read`,
 * `monitors:write`, `monitors:ack` are the ruler's (ruler/src/http.ts `Scope`). Each service
 * checks its own scopes literally; here they only reach `whoami`.
 */
export const SCOPES = ['admin', 'dashboards:read', 'dashboards:write', 'dashboards:apply', 'write', 'read', 'monitors:read', 'monitors:write', 'monitors:ack'] as const
export type Scope = (typeof SCOPES)[number]

export const PREFIX = '/api/v1/control'

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export interface Route {
  method: Method
  /** Below `PREFIX`; `{name}` is a path parameter. */
  path: string
  op: string
  /** Any one of these scopes is enough. */
  scopes: readonly Scope[]
  /** A mutation runs in one transaction with its audit row and supports `dryRun`. */
  mutation: boolean
}

const ANY: readonly Scope[] = SCOPES
const ADMIN: readonly Scope[] = ['admin']
const D_READ: readonly Scope[] = ['admin', 'dashboards:read', 'dashboards:write', 'dashboards:apply']
const D_WRITE: readonly Scope[] = ['admin', 'dashboards:write', 'dashboards:apply']
const D_APPLY: readonly Scope[] = ['admin', 'dashboards:apply']

const r = <O extends string>(method: Method, path: string, op: O, scopes: readonly Scope[], mutation = method !== 'GET'): Route & { op: O } => ({ method, path, op, scopes, mutation })

export const ROUTES = [
  r('GET', '/whoami', 'whoami', ANY),

  r('GET', '/keys', 'keys.list', ADMIN),
  r('POST', '/keys', 'keys.create', ADMIN),
  r('GET', '/keys/{key}', 'keys.get', ADMIN),
  r('POST', '/keys/{key}/disable', 'keys.disable', ADMIN),
  r('POST', '/keys/{key}/enable', 'keys.enable', ADMIN),
  r('POST', '/keys/{key}/rotate', 'keys.rotate', ADMIN),
  r('DELETE', '/keys/{key}', 'keys.delete', ADMIN),

  r('GET', '/dashboards', 'dashboards.list', D_READ),
  r('POST', '/dashboards', 'dashboards.create', D_WRITE),
  r('GET', '/dashboards/{dashboard}', 'dashboards.get', D_READ),
  r('PATCH', '/dashboards/{dashboard}', 'dashboards.patch', D_WRITE),
  r('DELETE', '/dashboards/{dashboard}', 'dashboards.delete', D_APPLY),
  r('POST', '/dashboards/{dashboard}/restore', 'dashboards.restore', D_APPLY),
  r('PUT', '/dashboards/{dashboard}/owner', 'dashboards.setOwner', D_APPLY),
  r('GET', '/dashboards/{dashboard}/revisions', 'revisions.list', D_READ),
  r('GET', '/dashboards/{dashboard}/revisions/{number}', 'revisions.get', D_READ),
  r('POST', '/dashboards/{dashboard}/revisions/{number}/revert', 'revisions.revert', D_APPLY),
  r('POST', '/dashboards/{dashboard}/proposals', 'proposals.create', D_WRITE),

  r('GET', '/proposals', 'proposals.list', D_READ),
  r('POST', '/proposals', 'proposals.createDashboard', D_WRITE),
  r('GET', '/proposals/{proposal}', 'proposals.get', D_READ),
  r('PUT', '/proposals/{proposal}', 'proposals.edit', D_WRITE),
  r('POST', '/proposals/{proposal}/apply', 'proposals.apply', D_APPLY),
  r('POST', '/proposals/{proposal}/decline', 'proposals.decline', D_WRITE),

  r('GET', '/settings', 'settings.list', ADMIN),
  r('GET', '/settings/{section}', 'settings.get', ADMIN),
  r('PUT', '/settings/{section}', 'settings.put', ADMIN),

  r('GET', '/audit', 'audit.list', ADMIN),
  r('GET', '/audit/{entry}', 'audit.get', ADMIN),
] as const satisfies readonly Route[]

export type OpName = (typeof ROUTES)[number]['op']

export const routeOf = (op: OpName): Route => ROUTES.find((x) => x.op === op)!

/** What the Worker hands the Tenant object for one request. */
export interface OpInput {
  params: Record<string, string>
  /** Query parameters; repeated names keep every value. */
  query: Record<string, string[]>
  body: unknown
  /** The revision in `If-Match`, unquoted, if the header was sent. */
  ifMatch?: string
}

export interface OpResult {
  status: number
  body: unknown
  headers?: Record<string, string>
}

interface Compiled {
  route: Route
  re: RegExp
  names: string[]
}

const compiled: Compiled[] = ROUTES.map((route) => {
  const names: string[] = []
  const re = new RegExp(
    '^' +
      route.path.replace(/\{([a-z]+)\}/g, (_m, name: string) => {
        names.push(name)
        return '([^/]+)'
      }) +
      '$',
  )
  return { route, re, names }
})

export type Match = { kind: 'route'; route: Route; params: Record<string, string> } | { kind: 'method'; allow: Method[] } | { kind: 'none' }

/** Match a path below `PREFIX`. Path parameters are percent-decoded; a parameter that does not decode matches nothing. */
export function matchRoute(method: string, path: string): Match {
  const allow: Method[] = []
  for (const c of compiled) {
    const m = c.re.exec(path)
    if (!m) continue
    if (c.route.method !== method) {
      allow.push(c.route.method)
      continue
    }
    const params: Record<string, string> = {}
    try {
      c.names.forEach((n, i) => (params[n] = decodeURIComponent(m[i + 1]!)))
    } catch {
      return { kind: 'none' }
    }
    return { kind: 'route', route: c.route, params }
  }
  return allow.length ? { kind: 'method', allow } : { kind: 'none' }
}
