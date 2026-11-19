declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import('../src/index')
    durableNamespaces: 'Shard'
  }
  interface Env {
    SHARD: DurableObjectNamespace<import('../src/shard').Shard>
    CONFIG: KVNamespace
  }
}

/** Vite's `import.meta.glob`, used to load golden files that may not exist yet. */
interface ImportMeta {
  glob(pattern: string, options: { eager: true; import: 'default' }): Record<string, unknown>
}
