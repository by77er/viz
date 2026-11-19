declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import('./worker')
    durableNamespaces: 'Tenant'
  }
  interface Env {
    TENANT: DurableObjectNamespace<import('../../control/src/tenant').Tenant>
    OAUTH: Service<import('../../control/src/introspection').OAuthIntrospection>
    OAUTH_AS_RULER: Service<import('../../control/src/introspection').OAuthIntrospection>
    CONFIG: KVNamespace
    DEFAULT_POOL?: string
    APP_URL?: string
    PUBLIC_URL?: string
    OAUTH_CLIENT_KEY?: string
  }
}
