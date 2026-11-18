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
  }
}

declare module '*?raw' {
  const text: string
  export default text
}
