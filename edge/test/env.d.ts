declare namespace Cloudflare {
  interface Env {
    SHARD: DurableObjectNamespace<import('../../shard/src/shard').Shard>
    CONFIG: KVNamespace
    DEFAULT_POOL?: string
    INGEST_LIMITS?: string
  }
}

declare module 'snappyjs' {
  export function compress(input: Uint8Array): Uint8Array
  export function uncompress(input: Uint8Array): Uint8Array
}
