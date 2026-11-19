declare namespace Cloudflare {
  interface Env {
    LEDGER: DurableObjectNamespace<import('../src/ledger').Ledger>
    LEDGER_ASBUILT: DurableObjectNamespace<import('../bench/asbuilt/ledger').Ledger>
    LEDGER_REPLICA: DurableObjectNamespace<import('./worker').LedgerReplica>
    BUCKET: R2Bucket
    CELL: string
    LEDGER_DRAIN_DELAY_MS: string
  }
}
