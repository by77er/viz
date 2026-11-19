declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import('./worker')
    durableNamespaces: 'Shard' | 'Ledger' | 'TestPublisher'
  }
  interface Env {
    SHARD: DurableObjectNamespace<import('../../shard/src/shard').Shard>
    LEDGER: DurableObjectNamespace<import('../../ledger/src/ledger').Ledger>
    /** The real publisher with a test clock (test/worker.ts); passed as `PUBLISHER` by the deletion gate's tests. */
    TEST_PUBLISHER: DurableObjectNamespace<import('../../publisher/test/worker').TestPublisher>
    BUCKET: R2Bucket
    CONFIG: KVNamespace
    CELL: string
    /** Set by vitest.config.ts: the ledger drains when a test asks. */
    LEDGER_DRAIN_DELAY_MS: string
  }
}

/** Vite's `import.meta.glob`, used to load golden files (test/golden.ts), as in control/. */
interface ImportMeta {
  glob(pattern: string | string[], options: { eager: true; import: 'default' }): Record<string, unknown>
}
