declare namespace Cloudflare {
  interface Env {
    SHARD: DurableObjectNamespace<import('../../shard/src/shard').Shard>
    CONFIG: KVNamespace
    DEFAULT_POOL?: string
    INGEST_LIMITS?: string
    /** wrangler.jsonc: this script's `RecordedSamples` entrypoint, as the ruler, as another Worker, and with no props. */
    RULER_SINK: Service<import('../src/recorded').RecordedSamples>
    MCP_SINK: Service<import('../src/recorded').RecordedSamples>
    BARE_SINK: Service<import('../src/recorded').RecordedSamples>
  }
}

declare module 'snappyjs' {
  export function compress(input: Uint8Array): Uint8Array
  export function uncompress(input: Uint8Array): Uint8Array
}
