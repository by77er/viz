declare namespace Cloudflare {
  interface Env {
    PUBLISHER: DurableObjectNamespace<import('./worker').TestPublisher>
    LEDGER: DurableObjectNamespace<import('../../ledger/src/ledger').Ledger>
    BUCKET: R2Bucket
    CELL: string
    ICEBERG_LOCATION_PREFIX: string
  }
}
