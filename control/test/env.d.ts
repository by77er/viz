declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import('../src/index')
    durableNamespaces: 'Tenant'
  }
  interface Env {
    TENANT: DurableObjectNamespace<import('../src/tenant').Tenant>
    CONFIG: KVNamespace
    CORS_ALLOW_ORIGINS?: string
    DEFAULT_POOL?: string
    CONTROL_CAPS?: string
    LIMIT_CEILINGS?: string
    PUBLIC_URL?: string
    OAUTH_CLIENT_KEY?: string
    /** Tests only (vitest.config.ts): control's OAuthIntrospection entrypoint, bound as three callers. */
    MCP_OAUTH: Service<import('../src/introspection').OAuthIntrospection>
    RULER_OAUTH: Service<import('../src/introspection').OAuthIntrospection>
    BARE_OAUTH: Service<import('../src/introspection').OAuthIntrospection>
    /** Tests only (vitest.config.ts): Rate Limiting bindings with small limits, put in place of OAUTH_RL_* by test/ratelimit.test.ts. */
    RL_TEST_SOURCE: RateLimit
    RL_TEST_CLIENT: RateLimit
    RL_TEST_TENANT: RateLimit
    RL_TEST_BEARER: RateLimit
    RL_TEST_BEARER_TENANT: RateLimit
    RL_TEST_10S: RateLimit
  }
}

declare module '*?raw' {
  const text: string
  export default text
}

/** Vite's `import.meta.glob`, used to load golden files that may not exist yet. */
interface ImportMeta {
  glob(pattern: string, options: { eager: true; import: 'default' }): Record<string, unknown>
}
