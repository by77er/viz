declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import('./worker')
    durableNamespaces: 'Tenant'
  }
  interface Env {
    INGEST: Fetcher
    QUERY: Fetcher
    CONTROL: Fetcher
    RULER: Fetcher
    MCP: Fetcher
    TENANT: DurableObjectNamespace<import('../../../control/src/tenant').Tenant>
    CONFIG: KVNamespace
    DEFAULT_POOL?: string
    VIZ_RELEASE?: string
    VIZ_BOOTSTRAP?: string
  }
}
