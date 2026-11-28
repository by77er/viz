declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import('./worker')
    durableNamespaces: 'Shard' | 'Ledger' | 'ShardPrereg' | 'LedgerPrereg'
  }
  interface Env {
    SHARD: DurableObjectNamespace<import('../src/shard').Shard>
    LEDGER: DurableObjectNamespace<import('../../ledger/src/ledger').Ledger>
    SHARD_PREREG: DurableObjectNamespace<import('../bench/prereg/shard').Shard>
    LEDGER_PREREG: DurableObjectNamespace<import('../../ledger/bench/prereg/ledger').Ledger>
    BUCKET: R2Bucket
    CONFIG: KVNamespace
    CELL: string
  }
}

/** Vite's `import.meta.glob`, used to load golden files that may not exist yet. */
interface ImportMeta {
  glob(pattern: string | string[], options: { eager: true; import: 'default' }): Record<string, unknown>
}
