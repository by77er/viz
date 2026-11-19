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
