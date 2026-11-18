declare namespace Cloudflare {
  interface Env {
    PUBLISHER: DurableObjectNamespace<import('./worker').TestPublisher>
    LEDGER: DurableObjectNamespace<import('../../ledger/src/ledger').Ledger>
    BUCKET: R2Bucket
    CELL: string
    ICEBERG_LOCATION_PREFIX: string
  }
}

/** Vite's `import.meta.glob`, used to load golden files that may not exist yet. */
interface ImportMeta {
  glob(pattern: string, options: { eager: true; import: 'default' }): Record<string, unknown>
}
