declare namespace Cloudflare {
  interface Env {
    PUBLISHER: DurableObjectNamespace<import('./worker').TestPublisher>
    PUBLISHER_N1: DurableObjectNamespace<import('./worker').TestPublisherN1>
    LEDGER: DurableObjectNamespace<import('../../ledger/src/ledger').Ledger>
    LEDGER_ASBUILT: DurableObjectNamespace<import('../../ledger/bench/asbuilt/ledger').Ledger>
    LEDGER_BEFORE: DurableObjectNamespace<import('../../ledger/bench/before/ledger').Ledger>
    BUCKET: R2Bucket
    CELL: string
    ICEBERG_LOCATION_PREFIX: string
  }
}

/** Vite's `import.meta.glob`, used to load golden files that may not exist yet. */
interface ImportMeta {
  glob(pattern: string, options: { eager: true; import: 'default' }): Record<string, unknown>
}
