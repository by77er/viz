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
    PUBLIC_URL?: string
    VIZ_HOST_ALIASES?: string
    VIZ_APP?: string
  }
}

/** A file's text, as Vite's `?raw` import gives it (the fixture document in app.test.ts). */
declare module '*?raw' {
  const text: string
  export default text
}
