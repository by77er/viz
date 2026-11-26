/**
 * Committing the publisher's tables through an `IcebergCatalog`, with the retry rules that make
 * conflicts and unknown outcomes safe.
 *
 * The rules (all in `commitWithRetry`):
 *   1. One logical commit keeps one snapshot id across every attempt, so "did it land?" has an
 *      answer: the id is in the main chain or it is not.
 *   2. Every attempt requires `main` to be at the snapshot it was built on (`assert-ref-snapshot-id`;
 *      R2-native: the next metadata version must not exist). Two copies of one request in flight
 *      carry the same requirement, so at most one can apply; once `main` has moved, an older copy
 *      can never apply.
 *   3. Before every submission, and after every conflict or unknown outcome, the table is read
 *      again from the catalog and the id looked for. Found: done, never sent again.
 * Manifests and manifest lists are written with the publisher's own builders
 * (`publisher/src/iceberg.ts`, `publisher/src/avro.ts`).
 */
import type { FileEntry, Table } from '../../../contracts/ledger'
import { readAvro, writeAvro } from '../../../publisher/src/avro'
import {
  MANIFEST_ENTRY_SCHEMA,
  MANIFEST_LIST_SCHEMA,
  PARTITION_DAY_ID,
  PARTITION_TENANT_ID,
  STATUS_ADDED,
  STATUS_DELETED,
  STATUS_EXISTING,
  TABLE_DEFS,
  liveFromEntry,
  manifestEntry,
  manifestHeader,
  manifestListRecord,
  statsFor,
  summarise,
  type LiveFile,
  type ManifestEntryRecord,
  type ManifestListRecord,
  type Snapshot,
  type TableMetadata,
} from '../../../publisher/src/iceberg'
import { currentId, type CommitOutcome, type IcebergCatalog, type LoadedTable } from './catalog'

export function newSnapshotId(): number {
  const a = crypto.getRandomValues(new Uint32Array(2))
  return ((a[0] as number) & 0xfffff) * 0x100000000 + (a[1] as number) + 1
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ───────────────────────────── what is in the table ─────────────────────────────

export interface ChainReport {
  /** Snapshot ids from the current one back to the first. */
  chain: number[]
  problems: string[]
}

/** The main branch's ancestry, with every way it can fail to be one straight line. */
export function chainOf(meta: TableMetadata): ChainReport {
  const problems: string[] = []
  const byId = new Map<number, Snapshot>()
  for (const s of meta.snapshots ?? []) {
    if (byId.has(s['snapshot-id'])) problems.push(`snapshot ${s['snapshot-id']} listed twice`)
    byId.set(s['snapshot-id'], s)
  }
  const chain: number[] = []
  const seen = new Set<number>()
  let id = currentId(meta)
  let seq = Number.POSITIVE_INFINITY
  while (id !== null && id !== undefined) {
    if (seen.has(id)) {
      problems.push(`cycle at ${id}`)
      break
    }
    seen.add(id)
    const s = byId.get(id)
    if (!s) {
      // An expired ancestor ends the walk; it is not a fork.
      break
    }
    if (!(s['sequence-number'] < seq)) problems.push(`sequence number ${s['sequence-number']} of ${id} is not below its child's ${seq}`)
    seq = s['sequence-number']
    chain.push(id)
    id = s['parent-snapshot-id'] ?? null
  }
  for (const s of byId.values()) if (!seen.has(s['snapshot-id'])) problems.push(`snapshot ${s['snapshot-id']} is not on main's ancestry (a fork)`)
  return { chain, problems }
}

export const inMainChain = (meta: TableMetadata, id: number): boolean => chainOf(meta).chain.includes(id)

/** The publisher's columns, ids, partition spec and sort order, as the catalog holds them; a problem or null. */
export function checkIds(table: Table, meta: TableMetadata): string | null {
  if (meta['format-version'] !== 2) return `format-version ${meta['format-version']}`
  const d = TABLE_DEFS[table]
  const schema = (meta.schemas as { 'schema-id': number; fields: { id: number; name: string; type: string; required: boolean }[] }[]).find((s) => s['schema-id'] === meta['current-schema-id'])
  if (!schema) return 'no current schema'
  const want = [...d.data.map((c) => ({ ...c, required: true })), { ...d.tenant, required: false }, { ...d.day, required: false }]
  for (const c of want) {
    const f = schema.fields.find((x) => x.name === c.name)
    if (!f) return `column ${c.name} missing`
    if (f.id !== c.id || f.type !== c.type || f.required !== c.required) return `column ${c.name}: catalog has id ${f.id} ${f.type} ${f.required ? 'required' : 'optional'}, the publisher writes id ${c.id} ${c.type} ${c.required ? 'required' : 'optional'}`
  }
  if (schema.fields.length !== want.length) return `catalog schema has ${schema.fields.length} columns, the publisher's ${want.length}`
  const spec = (meta['partition-specs'] as { 'spec-id': number; fields: { 'source-id': number; 'field-id': number; transform: string; name: string }[] }[]).find((s) => s['spec-id'] === meta['default-spec-id'])
  const sf = spec?.fields ?? []
  const okSpec = sf.length === 2 && sf[0]?.['source-id'] === d.tenant.id && sf[0]?.['field-id'] === PARTITION_TENANT_ID && sf[0]?.transform === 'identity' && sf[1]?.['source-id'] === d.day.id && sf[1]?.['field-id'] === PARTITION_DAY_ID && sf[1]?.transform === 'identity'
  if (!okSpec || meta['default-spec-id'] !== 0) return `partition spec ${meta['default-spec-id']}: ${JSON.stringify(sf)}`
  const order = (meta['sort-orders'] as { 'order-id': number; fields: { 'source-id': number }[] }[]).find((o) => o['order-id'] === meta['default-sort-order-id'])
  if (!order || JSON.stringify(order.fields.map((f) => f['source-id'])) !== JSON.stringify(d.sort)) return `default sort order ${meta['default-sort-order-id']}: ${JSON.stringify(order)}`
  return null
}

/** The live files of the current snapshot: the manifest list's rows, and each live file with the manifest that holds it. */
export async function readCurrent(
  bucket: R2Bucket,
  keyOf: (uri: string) => string,
  meta: TableMetadata,
): Promise<{ records: ManifestListRecord[]; live: Map<string, { file: LiveFile; manifest: string }>; duplicates: string[] }> {
  const id = currentId(meta)
  const live = new Map<string, { file: LiveFile; manifest: string }>()
  const duplicates: string[] = []
  if (id === null) return { records: [], live, duplicates }
  const snap = meta.snapshots.find((s) => s['snapshot-id'] === id)
  if (!snap) throw new Error(`current snapshot ${id} is not in the metadata`)
  const lo = await bucket.get(keyOf(snap['manifest-list']))
  if (!lo) throw new Error(`manifest list ${snap['manifest-list']} is not in R2`)
  const records = (await readAvro<ManifestListRecord>(new Uint8Array(await lo.arrayBuffer()))).records
  const entries = await Promise.all(
    records.map(async (r) => {
      const o = await bucket.get(keyOf(r.manifest_path))
      if (!o) throw new Error(`manifest ${r.manifest_path} is not in R2`)
      return (await readAvro<ManifestEntryRecord>(new Uint8Array(await o.arrayBuffer()))).records
    }),
  )
  for (const [i, es] of entries.entries()) {
    const r = records[i] as ManifestListRecord
    for (const e of es) {
      if (e.status === STATUS_DELETED) continue
      const key = keyOf(e.data_file.file_path)
      if (live.has(key)) duplicates.push(key)
      live.set(key, { file: liveFromEntry(e, key, { snapshotId: r.added_snapshot_id, seq: r.sequence_number }), manifest: r.manifest_path })
    }
  }
  return { records, live, duplicates }
}

/** The manifest list of the current snapshot (empty for a table without one). */
export async function readList(bucket: R2Bucket, keyOf: (uri: string) => string, meta: TableMetadata): Promise<ManifestListRecord[]> {
  const id = currentId(meta)
  if (id === null) return []
  const snap = meta.snapshots.find((s) => s['snapshot-id'] === id)
  if (!snap) throw new Error(`current snapshot ${id} is not in the metadata`)
  const o = await bucket.get(keyOf(snap['manifest-list']))
  if (!o) throw new Error(`manifest list ${snap['manifest-list']} is not in R2`)
  return (await readAvro<ManifestListRecord>(new Uint8Array(await o.arrayBuffer()))).records
}

// ───────────────────────────── building a snapshot ─────────────────────────────

export interface Ctx {
  cat: IcebergCatalog
  bucket: R2Bucket
  keyOf: (uri: string) => string
  ns: string
  name: string
  table: Table
}

/** A data file to publish: the ledger's entry and its tenant. */
export interface Publish {
  tenant: string
  entry: FileEntry
}

const toLive = (table: Table, p: Publish, snapshotId: number, seq: number): LiveFile => ({
  key: p.entry.key,
  tenant: p.tenant,
  day: p.entry.day,
  rows: p.entry.rows,
  bytes: p.entry.bytes,
  snapshotId,
  seq,
  fileSeq: seq,
  stats: statsFor(table, p.entry),
})

async function writeManifest(c: Ctx, dir: { key: string; uri: string }, name: string, parts: { file: LiveFile; status: number }[], snapshotId: number, seq: number) {
  const records = parts.map((p) => manifestEntry(c.table, p.file, p.status, `s3://${bucketOfUri(dir.uri)}/${p.file.key}`, snapshotId))
  const bytes = await writeAvro(MANIFEST_ENTRY_SCHEMA, records, manifestHeader(c.table))
  await c.bucket.put(dir.key + name, bytes)
  return { ...summarise(parts, seq, snapshotId), path: dir.uri + name, length: bytes.length }
}

const bucketOfUri = (uri: string) => {
  const m = /^s3:\/\/([^/]+)\//.exec(uri)
  if (!m) throw new Error(`not an s3 URI: ${uri}`)
  return m[1] as string
}

async function writeList(c: Ctx, dir: { key: string; uri: string }, snapshotId: number, seq: number, parent: number | null, rows: ManifestListRecord[]) {
  const name = `snap-${snapshotId}-${seq}-${crypto.randomUUID().slice(0, 8)}.avro`
  const bytes = await writeAvro(MANIFEST_LIST_SCHEMA, rows, {
    'snapshot-id': String(snapshotId),
    'sequence-number': String(seq),
    'format-version': '2',
    ...(parent !== null ? { 'parent-snapshot-id': String(parent) } : {}),
  })
  await c.bucket.put(dir.key + name, bytes)
  return dir.uri + name
}

const sumOf = (fs: LiveFile[], k: 'rows' | 'bytes') => fs.reduce((a, f) => a + f[k], 0)

function snapshotFor(t: LoadedTable, snapshotId: number, seq: number, list: string, adds: LiveFile[], removes: LiveFile[], extra: Record<string, string>): Snapshot {
  const prev = currentId(t.metadata)
  const before = t.metadata.snapshots.find((s) => s['snapshot-id'] === prev)?.summary
  const total = (k: string) => Number(before?.[k] ?? 0)
  const s: Snapshot = {
    'snapshot-id': snapshotId,
    'sequence-number': seq,
    'timestamp-ms': Math.max(Date.now(), t.metadata['last-updated-ms'] + 1),
    'manifest-list': list,
    summary: {
      operation: removes.length === 0 ? 'append' : adds.length === 0 ? 'delete' : 'overwrite',
      'added-data-files': String(adds.length),
      'deleted-data-files': String(removes.length),
      'added-records': String(sumOf(adds, 'rows')),
      'deleted-records': String(sumOf(removes, 'rows')),
      'added-files-size': String(sumOf(adds, 'bytes')),
      'removed-files-size': String(sumOf(removes, 'bytes')),
      'changed-partition-count': String(new Set([...adds, ...removes].map((f) => `${f.tenant}/${f.day}`)).size),
      'total-data-files': String(total('total-data-files') + adds.length - removes.length),
      'total-records': String(total('total-records') + sumOf(adds, 'rows') - sumOf(removes, 'rows')),
      'total-files-size': String(total('total-files-size') + sumOf(adds, 'bytes') - sumOf(removes, 'bytes')),
      'total-delete-files': '0',
      'total-position-deletes': '0',
      'total-equality-deletes': '0',
      ...extra,
    },
    'schema-id': t.metadata['current-schema-id'],
  }
  if (prev !== null) s['parent-snapshot-id'] = prev
  return s
}

/**
 * A fast append of `files` on top of the table as loaded: one new manifest (written once per
 * snapshot id and reused by every attempt) and a new manifest list (per attempt: it carries the
 * attempt's sequence number and the parent's manifests).
 */
export function appendPlan(c: Ctx, files: Publish[], snapshotId: number, extra: Record<string, string>) {
  let manifest: { path: string; info: ReturnType<typeof summarise> & { path: string; length: number } } | null = null
  return async (t: LoadedTable) => {
    const dir = c.cat.metadataDir(t)
    const seq = t.metadata['last-sequence-number'] + 1
    const adds = files.map((p) => toLive(c.table, p, snapshotId, seq))
    if (!manifest) {
      const info = await writeManifest(c, dir, `${snapshotId}-m0-${crypto.randomUUID().slice(0, 8)}.avro`, adds.map((file) => ({ file, status: STATUS_ADDED })), snapshotId, seq)
      manifest = { path: info.path, info }
    }
    const records = await readList(c.bucket, c.keyOf, t.metadata)
    // ADDED entries inherit their sequence numbers from this row, so it is rewritten per attempt.
    const mine = manifestListRecord({ ...manifest.info, seq, minSeq: seq }, manifest.path)
    const list = await writeList(c, dir, snapshotId, seq, currentId(t.metadata), [mine, ...records])
    return { snapshot: snapshotFor(t, snapshotId, seq, list, adds, [], extra) }
  }
}

/**
 * Make the table's live set equal `want`, as the publisher does: the net difference against
 * what the catalog says is published, removed files as DELETED entries in rewritten copies of
 * the manifests that held them (survivors EXISTING with explicit sequence numbers), added files
 * in one new manifest, untouched manifests kept. Null when nothing changes.
 */
export function replacePlan(c: Ctx, want: Publish[], snapshotId: number, extra: Record<string, string>) {
  return async (t: LoadedTable) => {
    const dir = c.cat.metadataDir(t)
    const seq = t.metadata['last-sequence-number'] + 1
    const cur = await readCurrent(c.bucket, c.keyOf, t.metadata)
    if (cur.duplicates.length > 0) throw new Error(`the current snapshot lists ${cur.duplicates.length} files twice`)
    const wantKeys = new Map(want.map((p) => [p.entry.key, p]))
    const adds = want.filter((p) => !cur.live.has(p.entry.key)).map((p) => toLive(c.table, p, snapshotId, seq))
    const removes = [...cur.live.values()].filter((l) => !wantKeys.has(l.file.key))
    if (adds.length === 0 && removes.length === 0) return null
    const removing = new Map<string, Set<string>>()
    for (const r of removes) {
      if (!removing.has(r.manifest)) removing.set(r.manifest, new Set())
      ;(removing.get(r.manifest) as Set<string>).add(r.file.key)
    }
    const rows: ManifestListRecord[] = []
    let n = 0
    const tag = crypto.randomUUID().slice(0, 8)
    for (const r of cur.records) {
      const gone = removing.get(r.manifest_path)
      if (!gone) {
        if (r.added_files_count + r.existing_files_count > 0) rows.push(r)
        continue
      }
      const parts = [...cur.live.values()]
        .filter((l) => l.manifest === r.manifest_path)
        .sort((a, b) => (a.file.key < b.file.key ? -1 : 1))
        .map((l) => ({ file: l.file, status: gone.has(l.file.key) ? STATUS_DELETED : STATUS_EXISTING }))
      const info = await writeManifest(c, dir, `${snapshotId}-m${n++}-${tag}.avro`, parts, snapshotId, seq)
      rows.push(manifestListRecord(info, info.path))
    }
    if (adds.length > 0) {
      const info = await writeManifest(c, dir, `${snapshotId}-m${n++}-${tag}.avro`, adds.map((file) => ({ file, status: STATUS_ADDED })), snapshotId, seq)
      rows.push(manifestListRecord(info, info.path))
    }
    const list = await writeList(c, dir, snapshotId, seq, currentId(t.metadata), rows)
    return { snapshot: snapshotFor(t, snapshotId, seq, list, adds, removes.map((r) => r.file), extra) }
  }
}

// ───────────────────────────── committing ─────────────────────────────

export interface Attempt {
  kind: CommitOutcome['kind']
  status: number
  ms: number
  /** The snapshot `main` was at when this attempt was built. */
  parent: number | null
  loadMs: number
  buildMs: number
  detail?: string
}

export interface CommitResult {
  /** committed: by the last attempt; landed: an earlier attempt whose answer was lost or late was found in the chain. */
  status: 'committed' | 'landed' | 'nothing' | 'rejected' | 'gave-up'
  snapshotId: number
  attempts: Attempt[]
  /** Attempts that ended with a conflict, and with an unknown outcome. */
  conflicts: number
  unknowns: number
  /** Milliseconds from the first load to the answer. */
  ms: number
  /** True if the id was found after a later attempt had conflicted: an earlier request applied late. */
  landedLate: boolean
  table: LoadedTable | null
}

export interface RetryOptions {
  maxAttempts?: number
  /** Abort the first attempt this many ms after it starts. */
  abortFirstAfterMs?: number
  /** Called right after an attempt with an unknown outcome (the exercise's interfering writer). */
  afterUnknown?: (parent: number | null) => Promise<void>
  /** Send an Idempotency-Key, the same for byte-identical resubmissions. */
  idempotency?: boolean
}

export async function commitWithRetry(
  c: Ctx,
  snapshotId: number,
  plan: (t: LoadedTable) => Promise<{ snapshot: Snapshot; expire?: number[] } | null>,
  o: RetryOptions = {},
): Promise<CommitResult> {
  const t0 = Date.now()
  const attempts: Attempt[] = []
  const max = o.maxAttempts ?? 50
  let sawConflictAfterUnknown = false
  let unknownSeen = false
  let last: { parent: number | null; body: { snapshot: Snapshot; expire?: number[] }; key: string } | null = null
  const result = (status: CommitResult['status'], table: LoadedTable | null): CommitResult => ({
    status,
    snapshotId,
    attempts,
    conflicts: attempts.filter((a) => a.kind === 'conflict').length,
    unknowns: attempts.filter((a) => a.kind === 'unknown').length,
    ms: Date.now() - t0,
    landedLate: status === 'landed' && sawConflictAfterUnknown,
    table,
  })
  for (let i = 0; ; i++) {
    const tl = Date.now()
    const t = await c.cat.load(c.ns, c.name)
    const loadMs = Date.now() - tl
    if (!t) throw new Error(`${c.ns}.${c.name} does not exist`)
    // Rule 3: look before every submission. An earlier attempt may have applied.
    if (inMainChain(t.metadata, snapshotId)) return result('landed', t)
    if (i >= max) return result('gave-up', t)
    const parent = currentId(t.metadata)
    const tb = Date.now()
    // Rule 2 makes an identical resubmission safe when main has not moved; otherwise rebuild on the new head.
    const body: { snapshot: Snapshot; expire?: number[] } | null = last && last.parent === parent ? last.body : await plan(t)
    const buildMs = Date.now() - tb
    if (!body) return result('nothing', t)
    if (body.snapshot['snapshot-id'] !== snapshotId) throw new Error('a plan must keep the commit\'s snapshot id (rule 1)')
    const key: string = last && last.parent === parent ? last.key : await idemKey(snapshotId, parent, body.snapshot['sequence-number'])
    const req: Parameters<IcebergCatalog['commit']>[2] = { base: t, snapshot: body.snapshot }
    if (body.expire) req.expire = body.expire
    if (i === 0 && o.abortFirstAfterMs !== undefined) req.abortAfterMs = o.abortFirstAfterMs
    if (o.idempotency) req.idempotencyKey = key
    const out = await c.cat.commit(c.ns, c.name, req)
    const a: Attempt = { kind: out.kind, status: out.status, ms: out.ms, parent, loadMs, buildMs }
    if (out.kind !== 'committed') a.detail = out.detail
    attempts.push(a)
    last = { parent, body, key }
    if (out.kind === 'committed') return result('committed', out.table)
    if (out.kind === 'rejected') return result('rejected', null)
    if (out.kind === 'unknown') {
      unknownSeen = true
      if (o.afterUnknown) await o.afterUnknown(parent)
    }
    if (out.kind === 'conflict' && unknownSeen) sawConflictAfterUnknown = true
    if (out.kind === 'throttled') await sleep(Math.min(5_000, 100 * 2 ** Math.min(i, 5)))
  }
}

/** A UUID derived from what makes a request byte-identical (Idempotency-Key must be a UUID). */
async function idemKey(snapshotId: number, parent: number | null, seq: number): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${snapshotId}/${parent}/${seq}`))).slice(0, 16)
  h[6] = ((h[6] as number) & 0x0f) | 0x80
  h[8] = ((h[8] as number) & 0x3f) | 0x80
  const x = Array.from(h, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`
}

/** Everything that must hold of a table after the exercises: one straight chain, equal to what was intended, no file twice. */
export async function verifyTable(c: Ctx, intended?: number[]) {
  const t = await c.cat.load(c.ns, c.name)
  if (!t) return { ok: false, problems: ['no table'], chain: [] as number[], files: [] as string[], rows: 0 }
  const { chain, problems } = chainOf(t.metadata)
  const cur = await readCurrent(c.bucket, c.keyOf, t.metadata)
  for (const d of cur.duplicates) problems.push(`file listed twice in the current snapshot: ${d}`)
  if (intended) {
    const want = new Set(intended)
    if (want.size !== intended.length) problems.push('the intended list has duplicates')
    const counts = new Map<number, number>()
    for (const id of chain) counts.set(id, (counts.get(id) ?? 0) + 1)
    for (const id of want) if (!counts.has(id)) problems.push(`intended snapshot ${id} is not in the chain`)
    for (const id of chain) if (!want.has(id)) problems.push(`snapshot ${id} in the chain was not intended`)
  }
  const files = [...cur.live.keys()].sort()
  const rows = [...cur.live.values()].reduce((a, l) => a + l.file.rows, 0)
  return { ok: problems.length === 0, problems, chain, files, rows, metadataLocation: t.metadataLocation, lastSequenceNumber: t.metadata['last-sequence-number'] }
}
