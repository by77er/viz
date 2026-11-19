declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import('./worker')
    durableNamespaces: 'Shard' | 'Ledger' | 'TestPublisher'
  }
  interface Env {
    SHARD: DurableObjectNamespace<import('../../shard/src/shard').Shard>
    LEDGER: DurableObjectNamespace<import('../../ledger/src/ledger').Ledger>
    /** The real publisher with a test clock (test/worker.ts). Tests pass it as `PUBLISHER`; production binds viz-publisher's. */
    TEST_PUBLISHER: DurableObjectNamespace<import('../../publisher/test/worker').TestPublisher>
    BUCKET: R2Bucket
    CONFIG: KVNamespace
    CELL: string
    DEFAULT_POOL?: string
    INGEST_LIMITS?: string
    MAINTENANCE?: string
    FLUSH_QUEUE: Queue<import('../../shard/src/shard').FlushMessage>
    MAINT_QUEUE: Queue<import('../src/maintain').MaintMessage>
  }
}

/** Vite's `import.meta.glob`, used to load golden files (test/golden.ts), as in control/. */
interface ImportMeta {
  glob(pattern: string | string[], options: { eager: true; import: 'default' }): Record<string, unknown>
}
