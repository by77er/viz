import { DurableObject } from 'cloudflare:workers'

/**
 * A query leaf: a stateless Durable Object that reads data files from R2 for a
 * coordinator and hands the bytes back.
 *
 * Why an object at all (design D17, measured in spikes/s1-fanout-r2): one request may
 * have six R2 reads in flight, and a Worker reached through a service binding spends
 * from its caller's six. A Durable Object has six of its own. So the coordinator
 * spreads a query's reads over a pool of leaves, at most six per leaf per call.
 *
 * A leaf keeps NOTHING between calls: no storage, no fields, no alarm. Evicting one at
 * any moment loses nothing; the next call creates it again.
 */

/** R2 reads one call may issue. The platform's limit on connections in flight. */
export const MAX_READS_PER_CALL = 6

/**
 * Bytes one call may return. An RPC message is limited to 32 MiB; this leaves room for
 * the structure around the buffers. The coordinator packs calls to stay under it from
 * the sizes the ledger reports, and cuts a larger object into range reads.
 */
export const MAX_BYTES_PER_CALL = 24 << 20

/** One read: a whole object, or `length` bytes from `offset` (the seam for row-group reads). */
export interface ReadItem {
  key: string
  offset?: number
  length?: number
}

export type ReadResult =
  | { status: 'ok'; bytes: Uint8Array; cached: boolean }
  /** The object is not in R2. The caller's plan is stale (or the lake is damaged): never a silent gap. */
  | { status: 'missing' }

/** A call the leaf will not make is refused with a reason: an explicit status, not an exception. */
export type LeafAnswer = { status: 'ok'; results: ReadResult[] } | { status: 'refused'; reason: string }

export interface LeafEnv {
  BUCKET: R2Bucket
}

/**
 * Cache key of a read. The object key is content-hashed (contracts/TABLES.md: `hash8` of
 * the bytes, and objects are written once with `If-None-Match: *`), so the same key
 * always means the same bytes and a cached copy can never be stale. The key also holds
 * the tenant, so one tenant's entry cannot answer for another's.
 */
export function cacheUrl(item: ReadItem): string {
  const range = item.offset === undefined && item.length === undefined ? '' : `?offset=${item.offset ?? 0}&length=${item.length ?? ''}`
  return `https://viz-file-cache.invalid/${item.key.split('/').map(encodeURIComponent).join('/')}${range}`
}

/** The Workers default cache. (Typed here because the DOM library's `CacheStorage` has no `default`.) */
export const fileCache = (): Cache => (caches as unknown as { default: Cache }).default

export class Leaf extends DurableObject<LeafEnv> {
  /**
   * Read up to six items in parallel. Results are in the order of `items`.
   * `cacheTtlS` > 0: look in the Cache API first and store what was read from R2 there.
   */
  async read(items: ReadItem[], cacheTtlS: number): Promise<LeafAnswer> {
    if (items.length > MAX_READS_PER_CALL) return { status: 'refused', reason: `${items.length} reads in one call; the limit is ${MAX_READS_PER_CALL}` }
    const results = await Promise.all(items.map((item) => this.one(item, cacheTtlS)))
    let total = 0
    for (const r of results) if (r.status === 'ok') total += r.bytes.byteLength
    // Refuse rather than fail somewhere inside the RPC layer with an opaque error.
    if (total > MAX_BYTES_PER_CALL) return { status: 'refused', reason: `${total} bytes in one call; the limit is ${MAX_BYTES_PER_CALL}` }
    return { status: 'ok', results }
  }

  private async one(item: ReadItem, cacheTtlS: number): Promise<ReadResult> {
    const url = cacheUrl(item)
    if (cacheTtlS > 0) {
      const hit = await fileCache().match(url)
      if (hit) return { status: 'ok', bytes: new Uint8Array(await hit.arrayBuffer()), cached: true }
    }
    const ranged = item.offset !== undefined || item.length !== undefined
    const object = await this.env.BUCKET.get(item.key, ranged ? { range: { offset: item.offset ?? 0, length: item.length } } : undefined)
    if (!object) return { status: 'missing' }
    const bytes = new Uint8Array(await object.arrayBuffer())
    if (cacheTtlS > 0) {
      // Bounded lifetime, so that erased data ages out of the cache (design §6.3).
      await fileCache()
        .put(url, new Response(bytes, { headers: { 'Cache-Control': `public, max-age=${cacheTtlS}`, 'Content-Type': 'application/octet-stream' } }))
        .catch(() => {}) // the cache is an accelerator: failing to fill it is not an error
    }
    return { status: 'ok', bytes, cached: false }
  }
}
