declare namespace Cloudflare {
  interface Env {
    BUCKET: R2Bucket
    COMMITTER: DurableObjectNamespace<import('../src/index').Committer>
    KEY: string
    CATALOG_TOKEN: string
    CATALOG_URI: string
    WAREHOUSE: string
    BUCKET_NAME: string
  }
}
