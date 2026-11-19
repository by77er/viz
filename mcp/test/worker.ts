/**
 * The test Worker's main module. It exists to host the REAL control plane's Durable Object
 * (bound as TENANT, for the tests' setup) and its OAuthIntrospection entrypoint (bound as OAUTH,
 * as production binds it), so tests reach control/ exactly as production would. Tests build the
 * agent surface with `createWorker(deps)` and call its `fetch` in-process.
 */
export { Tenant } from '../../control/src/tenant'
export { OAuthIntrospection } from '../../control/src/introspection'
export default { fetch: (): Response => new Response('viz-mcp test worker') }
