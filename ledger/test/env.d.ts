declare namespace Cloudflare {
  interface Env {
    LEDGER: DurableObjectNamespace<import('../src/ledger').Ledger>
    LEDGER_ASBUILT: DurableObjectNamespace<import('../bench/asbuilt/ledger').Ledger>
    LEDGER_REPLICA: DurableObjectNamespace<import('./worker').LedgerReplica>
    LEDGER_BEFORE: DurableObjectNamespace<import('../bench/before/ledger').Ledger>
    BUCKET: R2Bucket
    CELL: string
    LEDGER_DRAIN_DELAY_MS: string
  }
}

/** Vite's `import.meta.glob`, used to load golden files that may not exist yet. */
interface ImportMeta {
  glob(pattern: string, options: { eager: true; import: 'default' }): Record<string, unknown>
}
