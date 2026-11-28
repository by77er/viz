/**
 * The test Worker's main module. It exists to host the REAL control plane's Durable Object
 * (bound as TENANT, for the tests' setup) and its OAuthIntrospection entrypoint (bound as OAUTH,
 * as production binds it), so tests reach control/ exactly as production would. Tests build the
 * agent surface with `createWorker(deps)` and call its `fetch` in-process.
 */
import { type IntrospectionEnv, OAuthIntrospection } from '../../control/src/introspection'

export { Tenant } from '../../control/src/tenant'
export { OAuthIntrospection }

/**
 * Control's real entrypoint, unchanged, with the test limiter RL_TEST_BEARER (2 a minute,
 * wrangler.test.jsonc) as its `OAUTH_RL_BEARER` (D70): what a deployment with that binding runs.
 * Bound as OAUTH_LIMITED; only the rate-limit tests use it.
 */
export class OAuthIntrospectionBearerLimited extends OAuthIntrospection {
  constructor(ctx: ExecutionContext, env: IntrospectionEnv & { RL_TEST_BEARER: RateLimit }) {
    super(ctx, { ...env, OAUTH_RL_BEARER: env.RL_TEST_BEARER })
  }
}

export default { fetch: (): Response => new Response('viz-mcp test worker') }
