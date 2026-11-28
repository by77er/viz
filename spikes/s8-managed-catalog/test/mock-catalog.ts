/**
 * An in-memory Iceberg REST catalog for the tests: the endpoints the spike uses, the commit
 * semantics of the REST spec (requirements checked and updates applied atomically; 409 when a
 * requirement fails), and faults on commit requests. It is a test double written here, not an
 * independent implementation: the real catalog is what the spike exists to measure.
 *
 * Like the Java reference (`TableMetadata.newTableMetadata`), table creation assigns fresh field
 * ids in field order and fresh partition field ids from 1000.
 *
 * Faults, per commit request (in arrival order):
 *   lose-after   apply, then lose the response (504)
 *   lose-before  lose the request (504), nothing applied
 *   late         answer 504 at once and keep the request; it is evaluated (requirements and all)
 *                when `release()` is called, as a request that reached the catalog late would be
 */
type Json = any // eslint-disable-line @typescript-eslint/no-explicit-any

export type Fault = 'none' | 'lose-after' | 'lose-before' | 'late'

export class MockCatalog {
  tables = new Map<string, { meta: Json; version: number }>()
  namespaces = new Set<string>()
  commitCalls = 0
  applied: { id: number; ok: boolean; status: number }[] = []
  faults: Fault[] = []
  private held: (() => void)[] = []
  /** A catalog that does not refuse a snapshot id it already has (so the committer alone must prevent duplicates). */
  lenientIds = false
  /** Field order used for fresh ids: as sent, or partition columns first (to show why order matters). */
  reorder: ((fields: Json[]) => Json[]) | null = null
  /** Wait this long (random up to it) before handling a request, so concurrent clients interleave. */
  jitterMs = 0
  /** When a request is aborted by the client after this long, the catalog still applies it. */
  processMs = 0
  /** Release the held requests when the next commit request arrives, before evaluating it. */
  releaseOnNextCommit = false

  release(): number {
    const n = this.held.length
    for (const h of this.held.splice(0)) h()
    return n
  }

  fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input)
    const method = init.method ?? 'GET'
    const body = init.body ? JSON.parse(init.body as string) : undefined
    const signal = init.signal ?? undefined
    if (this.jitterMs) await new Promise((r) => setTimeout(r, Math.random() * this.jitterMs))
    const path = url.pathname.replace(/^.*?\/v1\//, '')
    const json = (status: number, v: Json) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } })
    if (path === 'config') return json(200, { defaults: {}, overrides: { prefix: 'wh' }, endpoints: [] })
    const m = /^wh\/namespaces(?:\/([^/]+)(?:\/tables(?:\/([^/]+))?)?)?$/.exec(path)
    if (!m) return json(404, { error: { message: `no route ${path}`, type: 'NotFound', code: 404 } })
    const [, ns, table] = m
    if (!ns && method === 'POST') {
      const name = body.namespace[0]
      if (this.namespaces.has(name)) return json(409, { error: { message: 'exists', type: 'AlreadyExistsException', code: 409 } })
      this.namespaces.add(name)
      return json(200, { namespace: [name] })
    }
    if (ns && !table && method === 'POST') return this.create(decodeURIComponent(ns), body, json)
    if (ns && table && method === 'GET') {
      const t = this.tables.get(`${decodeURIComponent(ns)}.${decodeURIComponent(table)}`)
      if (!t) return json(404, { error: { message: 'no table', type: 'NoSuchTableException', code: 404 } })
      return json(200, { 'metadata-location': `${t.meta.location}/metadata/v${t.version}.metadata.json`, metadata: structuredClone(t.meta) })
    }
    if (ns && table && method === 'POST') {
      const key = `${decodeURIComponent(ns)}.${decodeURIComponent(table)}`
      const fault = this.faults[this.commitCalls++] ?? 'none'
      if (this.releaseOnNextCommit && this.held.length > 0) {
        this.releaseOnNextCommit = false
        this.release()
      }
      const apply = () => this.commit(key, body)
      const lost = () => json(504, { error: { message: 'Gateway timed out during commit', type: 'CommitStateUnknownException', code: 504 } })
      if (fault === 'lose-before') return lost()
      if (fault === 'late') {
        this.held.push(() => void apply())
        return lost()
      }
      if (this.processMs > 0) {
        // The catalog works for `processMs` and then applies, whether or not the client is still there.
        const done = new Promise<{ status: number; v: Json }>((r) => setTimeout(() => r(apply()), this.processMs))
        const aborted = new Promise<never>((_, rej) => signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))))
        const r = await Promise.race([done, aborted])
        return json(r.status, r.v)
      }
      const r = apply()
      if (fault === 'lose-after') return lost()
      return json(r.status, r.v)
    }
    return json(400, { error: { message: `unsupported ${method} ${path}`, type: 'BadRequestException', code: 400 } })
  }

  private create(ns: string, body: Json, json: (s: number, v: Json) => Response): Response {
    const key = `${ns}.${body.name}`
    if (this.tables.has(key)) return json(409, { error: { message: 'exists', type: 'AlreadyExistsException', code: 409 } })
    const fields = this.reorder ? this.reorder(body.schema.fields) : body.schema.fields
    const remap = new Map<number, number>()
    const fresh = fields.map((f: Json, i: number) => {
      remap.set(f.id, i + 1)
      return { ...f, id: i + 1 }
    })
    const uuid = crypto.randomUUID()
    const meta = {
      'format-version': 2,
      'table-uuid': uuid,
      location: `s3://viz-lake/__catalog/${uuid}`,
      'last-sequence-number': 0,
      'last-updated-ms': Date.now(),
      'last-column-id': fresh.length,
      'current-schema-id': 0,
      schemas: [{ type: 'struct', 'schema-id': 0, fields: fresh }],
      'default-spec-id': 0,
      'partition-specs': [{ 'spec-id': 0, fields: body['partition-spec'].fields.map((f: Json, i: number) => ({ ...f, 'source-id': remap.get(f['source-id']), 'field-id': 1000 + i })) }],
      'last-partition-id': 999 + body['partition-spec'].fields.length,
      'default-sort-order-id': 1,
      'sort-orders': [{ 'order-id': 0, fields: [] }, { 'order-id': 1, fields: body['write-order'].fields.map((f: Json) => ({ ...f, 'source-id': remap.get(f['source-id']) })) }],
      properties: body.properties ?? {},
      'current-snapshot-id': -1,
      refs: {},
      snapshots: [],
      'snapshot-log': [],
      'metadata-log': [],
    }
    this.tables.set(key, { meta, version: 0 })
    return json(200, { 'metadata-location': `${meta.location}/metadata/v0.metadata.json`, metadata: structuredClone(meta) })
  }

  /** Requirements, then updates, atomically: this function does not yield. */
  private commit(key: string, body: Json): { status: number; v: Json } {
    const t = this.tables.get(key)
    const fail = (status: number, message: string, type: string) => {
      const add = body.updates.find((u: Json) => u.action === 'add-snapshot')
      this.applied.push({ id: add?.snapshot['snapshot-id'], ok: false, status })
      return { status, v: { error: { message, type, code: status } } }
    }
    if (!t) return fail(404, 'no table', 'NoSuchTableException')
    const m = t.meta
    for (const r of body.requirements) {
      if (r.type === 'assert-table-uuid' && r.uuid !== m['table-uuid']) return fail(409, 'uuid changed', 'CommitFailedException')
      if (r.type === 'assert-ref-snapshot-id') {
        const cur = m.refs[r.ref]?.['snapshot-id'] ?? null
        if (cur !== r['snapshot-id']) return fail(409, `branch ${r.ref} has changed: expected id ${r['snapshot-id']} != ${cur}`, 'CommitFailedException')
      }
    }
    const next = structuredClone(m)
    let added: number | undefined
    for (const u of body.updates) {
      if (u.action === 'add-snapshot') {
        const s = u.snapshot
        if (!this.lenientIds && next.snapshots.some((x: Json) => x['snapshot-id'] === s['snapshot-id'])) return fail(400, `Snapshot already exists for id: ${s['snapshot-id']}`, 'BadRequestException')
        if (!this.lenientIds && s['sequence-number'] <= next['last-sequence-number']) return fail(400, 'Cannot add snapshot with sequence number older than last sequence number', 'BadRequestException')
        next.snapshots.push(s)
        next['last-sequence-number'] = Math.max(next['last-sequence-number'], s['sequence-number'])
        added = s['snapshot-id']
      } else if (u.action === 'set-snapshot-ref') {
        next.refs[u['ref-name']] = { 'snapshot-id': u['snapshot-id'], type: u.type }
        if (u['ref-name'] === 'main') {
          next['current-snapshot-id'] = u['snapshot-id']
          next['snapshot-log'].push({ 'snapshot-id': u['snapshot-id'], 'timestamp-ms': Date.now() })
        }
      } else if (u.action === 'remove-snapshots') {
        const gone = new Set(u['snapshot-ids'])
        next.snapshots = next.snapshots.filter((x: Json) => !gone.has(x['snapshot-id']))
      } else return fail(400, `unknown update ${u.action}`, 'BadRequestException')
    }
    next['last-updated-ms'] = Date.now()
    t.meta = next
    t.version++
    this.applied.push({ id: added as number, ok: true, status: 200 })
    return { status: 200, v: { 'metadata-location': `${next.location}/metadata/v${t.version}.metadata.json`, metadata: structuredClone(next) } }
  }
}
