declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import('./stack')
    durableNamespaces: 'Shard' | 'Ledger' | 'Leaf'
  }
  interface Env {
    SHARD: DurableObjectNamespace<import('../../shard/src/shard').Shard>
    LEDGER: DurableObjectNamespace<import('../../ledger/src/ledger').Ledger>
    LEAF: DurableObjectNamespace<import('../src/leaf').Leaf>
    BUCKET: R2Bucket
    CONFIG: KVNamespace
    CELL: string
    DEFAULT_POOL?: string
    INGEST_LIMITS?: string
    LEAF_POOL_SIZE?: string
    CORS_ORIGINS?: string
    FILE_CACHE_TTL_S?: string
    QUERY_LIMITS?: string
    QUERY_SIGNALS?: string
    INGEST_SIGNALS?: string
  }
}
