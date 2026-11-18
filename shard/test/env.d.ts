declare namespace Cloudflare {
  interface Env {
    SHARD: DurableObjectNamespace<import('../src/shard').Shard>
  }
}
