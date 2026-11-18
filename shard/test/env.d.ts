declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import('../src/index')
    durableNamespaces: 'Shard'
  }
  interface Env {
    SHARD: DurableObjectNamespace<import('../src/shard').Shard>
    CONFIG: KVNamespace
  }
}
