declare namespace Cloudflare {
  interface Env {
    LEDGER: DurableObjectNamespace<import('../src/ledger').Ledger>
    BUCKET: R2Bucket
    CELL: string
    LEDGER_DRAIN_DELAY_MS: string
  }
}
