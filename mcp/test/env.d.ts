declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import('./worker')
    durableNamespaces: 'Tenant'
  }
  interface Env {
    TENANT: DurableObjectNamespace<import('../../control/src/tenant').Tenant>
    CONFIG: KVNamespace
    DEFAULT_POOL?: string
    APP_URL?: string
    PUBLIC_URL?: string
    OAUTH_CLIENT_KEY?: string
  }
}
