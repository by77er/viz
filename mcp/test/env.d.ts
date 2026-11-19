declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import('./worker')
    durableNamespaces: 'Tenant'
  }
  interface Env {
    TENANT: DurableObjectNamespace<import('../../control/src/tenant').Tenant>
    OAUTH: Service<import('../../control/src/introspection').OAuthIntrospection>
    OAUTH_AS_RULER: Service<import('../../control/src/introspection').OAuthIntrospection>
    /** Control's entrypoint with a bearer limit of 2 a minute (D70; test/worker.ts). */
    OAUTH_LIMITED: Service<import('./worker').OAuthIntrospectionBearerLimited>
    RL_TEST_BEARER: RateLimit
    CONFIG: KVNamespace
    DEFAULT_POOL?: string
    APP_URL?: string
    PUBLIC_URL?: string
    OAUTH_CLIENT_KEY?: string
  }
}
