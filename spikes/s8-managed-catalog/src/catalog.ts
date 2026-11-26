/**
 * The catalog seam of the publisher, made explicit (design/DECISIONS.md D4), with two
 * implementations: the managed Iceberg REST catalog (Basin Catalog, formerly R2 Data Catalog)
 * and the R2-native conditional write the publisher uses today.
 *
 * The publisher has no such interface yet (publisher/README.md, "Not implemented"). Its commit
 * path uses three things a catalog must provide, all in `publisher/src/publisher.ts`:
 *
 *   currentMetadata  the table's current metadata, and proof that nothing newer exists
 *   putMetadata      make the next snapshot current only if the table is still where the
 *                    caller read it (the compare-and-swap); a loss is a `Conflict`
 *   resync           after a loss, or after an attempt whose outcome is not known, read the
 *                    table again and take what it says as the truth
 *
 * `IcebergCatalog` below is those three, plus `create`. The R2-native implementation builds the
 * whole next `metadata.json` itself (the publisher's `nextMetadata`); the REST one sends the
 * changes (`add-snapshot`, `set-snapshot-ref`, `remove-snapshots`) and the catalog builds it. So
 * the interface takes a snapshot and the ids to expire, not a metadata document: that is the
 * change the publisher needs to share it (README, "Needed changes").
 */
import { nextMetadata, type Snapshot, type TableMetadata } from '../../../publisher/src/iceberg'

export interface LoadedTable {
  metadata: TableMetadata
  /** Where the current metadata.json is. R2-native: `{prefix}/v{N}.metadata.json`, or '' before the first commit. */
  metadataLocation: string
}

/**
 * What became of a commit.
 *
 *   committed  the catalog says it applied it
 *   conflict   a requirement failed: nothing was applied (Iceberg REST 409)
 *   unknown    it may or may not have been applied: 5xx, a network error, or an abort after
 *              the request was sent (the REST spec's CommitStateUnknownException is 500/502/504)
 *   rejected   refused for a reason that a retry will not change (400, 401, 403, 404); nothing applied
 *   throttled  refused before it was looked at (429); nothing applied, try again later
 */
export type CommitOutcome =
  | { kind: 'committed'; status: number; ms: number; table: LoadedTable }
  | { kind: 'conflict' | 'unknown' | 'rejected' | 'throttled'; status: number; ms: number; detail: string }

export interface CommitRequest {
  /** The table as the caller read it. The commit applies only if `main` still points where it did. */
  base: LoadedTable
  snapshot: Snapshot
  /** Snapshot ids dropped by the same commit (retention). */
  expire?: number[]
  /** Abort the request this many ms after it starts (the unknown-outcome exercise). */
  abortAfterMs?: number
  /** Sent as `Idempotency-Key` (Iceberg REST, optional; a UUID). */
  idempotencyKey?: string
}

export interface IcebergCatalog {
  readonly kind: 'rest' | 'r2-native'
  /** The table, or null if it does not exist. */
  load(ns: string, table: string): Promise<LoadedTable | null>
  /** Create the table if it does not exist (from `init`: schema, spec, sort order, properties); return it either way. */
  create(ns: string, table: string, init: TableMetadata): Promise<LoadedTable>
  commit(ns: string, table: string, req: CommitRequest): Promise<CommitOutcome>
  /** Where manifests and manifest lists of this table go: an R2 key prefix and the URI readers see for it. */
  metadataDir(t: LoadedTable): { key: string; uri: string }
  /** Every request this object sent, for the report. */
  readonly calls: { op: string; status: number; ms: number }[]
}

/** The snapshot `main` points at, or null. Java writes `current-snapshot-id: -1` for a table without one. */
export const currentId = (m: TableMetadata): number | null => {
  const id = m.refs?.main?.['snapshot-id'] ?? m['current-snapshot-id']
  return id === undefined || id === null || id < 0 ? null : id
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>

// ───────────────────────────── Iceberg REST (Basin Catalog) ─────────────────────────────

export interface RestOptions {
  /** Catalog URI as `basin catalog enable` prints it, e.g. https://catalog.cloudflarestorage.com/{account}/{bucket}. */
  uri: string
  warehouse: string
  token: string
  /** The bucket that holds the warehouse: URIs `s3://{bucket}/{key}` are R2 keys of `BUCKET`. */
  bucket: string
  fetch?: Fetch
}

export class RestCatalog implements IcebergCatalog {
  readonly kind = 'rest' as const
  readonly calls: { op: string; status: number; ms: number }[] = []
  private prefix: string | null = null
  private readonly f: Fetch

  constructor(private readonly o: RestOptions) {
    this.f = o.fetch ?? ((i, r) => fetch(i, r))
  }

  private async request(op: string, method: string, path: string, body?: unknown, extra: { signal?: AbortSignal; headers?: Record<string, string> } = {}) {
    const headers: Record<string, string> = { authorization: `Bearer ${this.o.token}`, ...extra.headers }
    if (body !== undefined) headers['content-type'] = 'application/json'
    const init: RequestInit = { method, headers }
    if (body !== undefined) init.body = JSON.stringify(body)
    if (extra.signal) init.signal = extra.signal
    const t0 = Date.now()
    try {
      const res = await this.f(`${this.o.uri.replace(/\/$/, '')}/v1/${path}`, init)
      const text = await res.text()
      const ms = Date.now() - t0
      this.calls.push({ op, status: res.status, ms })
      return { status: res.status, text, ms }
    } catch (e) {
      const ms = Date.now() - t0
      this.calls.push({ op, status: 0, ms })
      throw Object.assign(new Error(`${op}: ${String(e)}`), { ms })
    }
  }

  /** `GET /v1/config`: the catalog's prefix for this warehouse (and what else it advertises). */
  async config(): Promise<{ status: number; body: unknown; ms: number }> {
    const r = await this.request('config', 'GET', `config?warehouse=${encodeURIComponent(this.o.warehouse)}`)
    let body: unknown = r.text
    try {
      body = JSON.parse(r.text)
    } catch {}
    if (r.status === 200) {
      const c = body as { overrides?: Record<string, string>; defaults?: Record<string, string> }
      this.prefix = c.overrides?.prefix ?? c.defaults?.prefix ?? ''
    }
    return { status: r.status, body, ms: r.ms }
  }

  private async path(rest: string): Promise<string> {
    if (this.prefix === null) {
      const c = await this.config()
      if (c.status !== 200) throw new Error(`config: ${c.status} ${JSON.stringify(c.body).slice(0, 300)}`)
    }
    return this.prefix ? `${this.prefix}/${rest}` : rest
  }

  async ensureNamespace(ns: string): Promise<void> {
    const r = await this.request('create-namespace', 'POST', await this.path('namespaces'), { namespace: [ns], properties: {} })
    if (r.status !== 200 && r.status !== 409) throw new Error(`create namespace ${ns}: ${r.status} ${r.text.slice(0, 300)}`)
  }

  async load(ns: string, table: string): Promise<LoadedTable | null> {
    const r = await this.request('load-table', 'GET', await this.path(`namespaces/${encodeURIComponent(ns)}/tables/${encodeURIComponent(table)}`))
    if (r.status === 404) return null
    if (r.status !== 200) throw new Error(`load ${ns}.${table}: ${r.status} ${r.text.slice(0, 300)}`)
    const b = JSON.parse(r.text) as { 'metadata-location': string; metadata: TableMetadata }
    return { metadata: b.metadata, metadataLocation: b['metadata-location'] }
  }

  async create(ns: string, table: string, init: TableMetadata): Promise<LoadedTable> {
    await this.ensureNamespace(ns)
    const schema = init.schemas[0] as { fields: { id: number }[] }
    const spec = init['partition-specs'][0] as { 'spec-id': number; fields: unknown[] }
    const order = init['sort-orders'].find((o) => (o as { 'order-id': number })['order-id'] === init['default-sort-order-id'])
    const r = await this.request('create-table', 'POST', await this.path(`namespaces/${encodeURIComponent(ns)}/tables`), {
      name: table,
      // A catalog may assign fresh field ids in field order (the Java reference does). Fields are
      // sent in id order so that a fresh assignment gives the publisher's ids; `checkIds` refuses otherwise.
      schema: { ...(schema as object), fields: [...schema.fields].sort((a, b) => a.id - b.id) },
      'partition-spec': spec,
      'write-order': order,
      properties: init.properties,
    })
    if (r.status === 409) {
      const t = await this.load(ns, table)
      if (t) return t
    }
    if (r.status !== 200) throw new Error(`create ${ns}.${table}: ${r.status} ${r.text.slice(0, 300)}`)
    const b = JSON.parse(r.text) as { 'metadata-location': string; metadata: TableMetadata }
    return { metadata: b.metadata, metadataLocation: b['metadata-location'] }
  }

  async commit(ns: string, table: string, req: CommitRequest): Promise<CommitOutcome> {
    const id = req.snapshot['snapshot-id']
    const body = {
      identifier: { namespace: [ns], name: table },
      requirements: [
        { type: 'assert-table-uuid', uuid: req.base.metadata['table-uuid'] },
        { type: 'assert-ref-snapshot-id', ref: 'main', 'snapshot-id': currentId(req.base.metadata) },
      ],
      updates: [
        { action: 'add-snapshot', snapshot: req.snapshot },
        { action: 'set-snapshot-ref', 'ref-name': 'main', type: 'branch', 'snapshot-id': id },
        ...(req.expire && req.expire.length > 0 ? [{ action: 'remove-snapshots', 'snapshot-ids': req.expire }] : []),
      ],
    }
    const ac = new AbortController()
    const timer = req.abortAfterMs !== undefined ? setTimeout(() => ac.abort(), req.abortAfterMs) : null
    const headers: Record<string, string> = {}
    if (req.idempotencyKey) headers['idempotency-key'] = req.idempotencyKey
    let r: { status: number; text: string; ms: number }
    try {
      r = await this.request('commit-table', 'POST', await this.path(`namespaces/${encodeURIComponent(ns)}/tables/${encodeURIComponent(table)}`), body, { signal: ac.signal, headers })
    } catch (e) {
      // Sent or not, the client cannot tell: the response is lost.
      return { kind: 'unknown', status: 0, ms: (e as { ms?: number }).ms ?? 0, detail: String(e).slice(0, 300) }
    } finally {
      if (timer) clearTimeout(timer)
    }
    if (r.status === 200) {
      const b = JSON.parse(r.text) as { 'metadata-location': string; metadata: TableMetadata }
      return { kind: 'committed', status: 200, ms: r.ms, table: { metadata: b.metadata, metadataLocation: b['metadata-location'] } }
    }
    const kind = r.status === 409 ? 'conflict' : r.status === 429 ? 'throttled' : r.status >= 500 ? 'unknown' : 'rejected'
    return { kind, status: r.status, ms: r.ms, detail: r.text.slice(0, 300) }
  }

  async drop(ns: string, table: string, purge: boolean): Promise<number> {
    const r = await this.request('drop-table', 'DELETE', await this.path(`namespaces/${encodeURIComponent(ns)}/tables/${encodeURIComponent(table)}?purgeRequested=${purge}`))
    return r.status
  }

  async dropNamespace(ns: string): Promise<number> {
    const r = await this.request('drop-namespace', 'DELETE', await this.path(`namespaces/${encodeURIComponent(ns)}`))
    return r.status
  }

  metadataDir(t: LoadedTable): { key: string; uri: string } {
    const uri = `${t.metadata.location.replace(/\/$/, '')}/metadata/`
    return { key: keyOfUri(uri, this.o.bucket), uri }
  }
}

/** `s3://{bucket}/{key}` → key. Anything else is refused: this spike writes through the R2 binding only. */
export function keyOfUri(uri: string, bucket: string): string {
  const p = `s3://${bucket}/`
  if (!uri.startsWith(p)) throw new Error(`not in bucket ${bucket}: ${uri}`)
  return uri.slice(p.length)
}

// ───────────────────────────── R2-native (what the publisher does) ─────────────────────────────

/**
 * The publisher's commit: `v{N+1}.metadata.json` written with `If-None-Match: *`, then
 * `version-hint.text`. Same layout as `publisher/` (`{root}/{table}/metadata/`), kept here so the
 * same workload runs against both implementations.
 */
export class R2NativeCatalog implements IcebergCatalog {
  readonly kind = 'r2-native' as const
  readonly calls: { op: string; status: number; ms: number }[] = []

  /** `init`: what a table that has no commit yet looks like (the publisher starts from `emptyMetadata`). */
  constructor(
    private readonly bucket: R2Bucket,
    private readonly bucketName: string,
    private readonly root: string,
    private init: TableMetadata | null = null,
  ) {}

  private dir(ns: string, table: string) {
    return `${this.root}/${ns}/${table}/metadata/`
  }

  private async timed<T>(op: string, fn: () => Promise<T>, status: (v: T) => number): Promise<T> {
    const t0 = Date.now()
    try {
      const v = await fn()
      this.calls.push({ op, status: status(v), ms: Date.now() - t0 })
      return v
    } catch (e) {
      this.calls.push({ op, status: 0, ms: Date.now() - t0 })
      throw e
    }
  }

  async load(ns: string, table: string): Promise<LoadedTable | null> {
    const dir = this.dir(ns, table)
    const t0 = Date.now()
    const hint = await this.bucket.get(`${dir}version-hint.text`)
    let v = hint ? Number((await hint.text()).trim()) || 0 : 0
    // The hint is written after the commit and may be behind: probe upwards, as the publisher does.
    while (await this.bucket.head(`${dir}v${v + 1}.metadata.json`)) v++
    if (v === 0) {
      this.calls.push({ op: 'load-table', status: 404, ms: Date.now() - t0 })
      // Nothing is written before the first commit, as in the publisher: the table is its initial metadata.
      return this.init ? { metadata: { ...this.init, location: `s3://${this.bucketName}/${this.root}/${ns}/${table}` }, metadataLocation: '' } : null
    }
    const o = await this.bucket.get(`${dir}v${v}.metadata.json`)
    if (!o) throw new Error(`r2-native: v${v} vanished`)
    const metadata = await o.json<TableMetadata>()
    this.calls.push({ op: 'load-table', status: 200, ms: Date.now() - t0 })
    return { metadata, metadataLocation: `s3://${this.bucketName}/${dir}v${v}.metadata.json` }
  }

  /** Nothing is written until the first commit, as in the publisher: the first commit is v1. */
  async create(ns: string, table: string, init: TableMetadata): Promise<LoadedTable> {
    this.init = init
    return (await this.load(ns, table)) as LoadedTable
  }

  async commit(ns: string, table: string, req: CommitRequest): Promise<CommitOutcome> {
    const dir = this.dir(ns, table)
    const m = /\/v(\d+)\.metadata\.json$/.exec(req.base.metadataLocation)
    const version = m ? Number(m[1]) : 0
    const now = Date.now()
    // The publisher's own builder; retention is the caller's `expire`, so nothing else is dropped here.
    const keepAll = { snapshotWindowMs: Number.MAX_SAFE_INTEGER / 2, minSnapshots: 2, metadataLogMax: 20 }
    let next = nextMetadata(req.base.metadata, version > 0 ? req.base.metadataLocation : null, req.snapshot, now, keepAll)
    if (req.expire && req.expire.length > 0) {
      const gone = new Set(req.expire)
      next = { ...next, snapshots: next.snapshots.filter((s) => !gone.has(s['snapshot-id'])), 'snapshot-log': next['snapshot-log'].filter((e) => !gone.has(e['snapshot-id'])) }
    }
    const key = `${dir}v${version + 1}.metadata.json`
    const t0 = Date.now()
    let put: R2Object | null
    try {
      put = await this.timed('commit-table', () => this.bucket.put(key, JSON.stringify(next), { onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'application/json' } }), (p) => (p ? 200 : 412))
    } catch (e) {
      return { kind: 'unknown', status: 0, ms: Date.now() - t0, detail: String(e).slice(0, 300) }
    }
    const ms = Date.now() - t0
    if (put === null) return { kind: 'conflict', status: 412, ms, detail: `v${version + 1} exists` }
    // Best effort, as in the publisher: readers that use the hint probe upwards anyway.
    await this.bucket.put(`${dir}version-hint.text`, String(version + 1)).catch(() => undefined)
    return { kind: 'committed', status: 200, ms, table: { metadata: next, metadataLocation: `s3://${this.bucketName}/${key}` } }
  }

  metadataDir(t: LoadedTable): { key: string; uri: string } {
    const uri = `${t.metadata.location.replace(/\/$/, '')}/metadata/`
    return { key: keyOfUri(uri, this.bucketName), uri }
  }
}
