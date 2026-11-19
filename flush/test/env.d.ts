declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import('../src/index')
    durableNamespaces: 'Shard' | 'Ledger'
  }
  interface Env {
    SHARD: DurableObjectNamespace<import('../../shard/src/shard').Shard>
    LEDGER: DurableObjectNamespace<import('../../ledger/src/ledger').Ledger>
    BUCKET: R2Bucket
    CONFIG: KVNamespace
    CELL: string
  }
}

/** Vite's `import.meta.glob`, used to load golden files (test/golden.ts), as in control/. */
interface ImportMeta {
  glob(pattern: string | string[], options: { eager: true; import: 'default' }): Record<string, unknown>
}
