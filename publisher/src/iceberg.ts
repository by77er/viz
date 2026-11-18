/**
 * Iceberg format-version 2 metadata for the viz tables: table schemas, the Avro schemas of
 * manifests and manifest lists, and builders for their records and for `metadata.json`.
 * Nothing here does I/O.
 *
 * Partition columns. The Parquet files hold one tenant and one UTC day each and contain
 * neither a `tenant` nor a `day` column (contracts/TABLES.md). The tables declare both as
 * OPTIONAL schema columns and partition by `identity(tenant)`, `identity(day)`. A reader
 * fills them from the partition tuple in the manifest (Iceberg spec, "Column projection":
 * a field missing from a data file takes its value from partition metadata when an
 * identity transform exists for it). They are optional, not required, because PyIceberg
 * 0.12 refuses a required field that is missing from the file before it looks at the
 * partition values; see README, "The partition columns".
 *
 * Field ids. The Parquet files carry no field ids, so the table sets
 * `schema.name-mapping.default`, which maps column names to ids.
 */
import type { FileEntry, Table } from '../../contracts/ledger'
import type { AvroSchema } from './avro'

export const TABLE_NAMES: readonly Table[] = ['metric_samples', 'metric_series']

interface Column {
  id: number
  name: string
  type: 'string' | 'long' | 'double' | 'date'
}

export interface TableDef {
  /** Columns present in the Parquet files, in file order. */
  data: Column[]
  tenant: Column
  day: Column
  /** Field ids of the sort order (all ascending), as written by the engine. */
  sort: number[]
}

export const TABLE_DEFS: Record<Table, TableDef> = {
  metric_samples: {
    data: [
      { id: 1, name: 'metric_name', type: 'string' },
      { id: 2, name: 'series_id', type: 'long' },
      { id: 3, name: 'ts', type: 'long' },
      { id: 4, name: 'value', type: 'double' },
    ],
    tenant: { id: 5, name: 'tenant', type: 'string' },
    day: { id: 6, name: 'day', type: 'date' },
    sort: [1, 2, 3],
  },
  metric_series: {
    data: [
      { id: 1, name: 'metric_name', type: 'string' },
      { id: 2, name: 'series_id', type: 'long' },
      { id: 3, name: 'labels', type: 'string' },
      { id: 4, name: 'min_ts', type: 'long' },
      { id: 5, name: 'max_ts', type: 'long' },
    ],
    tenant: { id: 6, name: 'tenant', type: 'string' },
    day: { id: 7, name: 'day', type: 'date' },
    sort: [1, 2],
  },
}

export const PARTITION_TENANT_ID = 1000
export const PARTITION_DAY_ID = 1001
export const SORT_ORDER_ID = 1

export const icebergSchema = (table: Table) => {
  const d = TABLE_DEFS[table]
  return {
    type: 'struct',
    'schema-id': 0,
    fields: [
      // Partition columns first, so `SELECT *` leads with them. Optional: see the header.
      { id: d.tenant.id, name: 'tenant', required: false, type: 'string', doc: 'Tenant id. Not stored in the data files; read from the partition tuple.' },
      { id: d.day.id, name: 'day', required: false, type: 'date', doc: 'UTC day of the rows. Not stored in the data files; read from the partition tuple.' },
      ...d.data.map((c) => ({ id: c.id, name: c.name, required: true, type: c.type })),
    ],
  }
}

export const partitionSpecFields = (table: Table) => {
  const d = TABLE_DEFS[table]
  return [
    { name: 'tenant', transform: 'identity', 'source-id': d.tenant.id, 'field-id': PARTITION_TENANT_ID },
    { name: 'day', transform: 'identity', 'source-id': d.day.id, 'field-id': PARTITION_DAY_ID },
  ]
}

const nameMapping = (table: Table) => TABLE_DEFS[table].data.map((c) => ({ 'field-id': c.id, names: [c.name] }))

// ───────────────────────────── Avro schemas (format v2) ─────────────────────────────

const idMap = (name: string, fieldId: number, keyId: number, valueId: number, valueType: string): Record<string, unknown> => ({
  name,
  type: [
    'null',
    {
      type: 'array',
      logicalType: 'map',
      items: {
        type: 'record',
        name: `k${keyId}_v${valueId}`,
        fields: [
          { name: 'key', type: 'int', 'field-id': keyId },
          { name: 'value', type: valueType, 'field-id': valueId },
        ],
      },
    },
  ],
  default: null,
  'field-id': fieldId,
})

/** `manifest_entry` with the `data_file` struct for our partition spec. */
export const MANIFEST_ENTRY_SCHEMA = {
  type: 'record',
  name: 'manifest_entry',
  fields: [
    { name: 'status', type: 'int', 'field-id': 0 },
    { name: 'snapshot_id', type: ['null', 'long'], default: null, 'field-id': 1 },
    { name: 'sequence_number', type: ['null', 'long'], default: null, 'field-id': 3 },
    { name: 'file_sequence_number', type: ['null', 'long'], default: null, 'field-id': 4 },
    {
      name: 'data_file',
      'field-id': 2,
      type: {
        type: 'record',
        name: 'r2',
        fields: [
          { name: 'content', type: 'int', 'field-id': 134 },
          { name: 'file_path', type: 'string', 'field-id': 100 },
          { name: 'file_format', type: 'string', 'field-id': 101 },
          {
            name: 'partition',
            'field-id': 102,
            type: {
              type: 'record',
              name: 'r102',
              fields: [
                { name: 'tenant', type: ['null', 'string'], default: null, 'field-id': PARTITION_TENANT_ID },
                { name: 'day', type: ['null', { type: 'int', logicalType: 'date' }], default: null, 'field-id': PARTITION_DAY_ID },
              ],
            },
          },
          { name: 'record_count', type: 'long', 'field-id': 103 },
          { name: 'file_size_in_bytes', type: 'long', 'field-id': 104 },
          idMap('column_sizes', 108, 117, 118, 'long'),
          idMap('value_counts', 109, 119, 120, 'long'),
          idMap('null_value_counts', 110, 121, 122, 'long'),
          idMap('nan_value_counts', 137, 138, 139, 'long'),
          idMap('lower_bounds', 125, 126, 127, 'bytes'),
          idMap('upper_bounds', 128, 129, 130, 'bytes'),
          { name: 'key_metadata', type: ['null', 'bytes'], default: null, 'field-id': 131 },
          { name: 'split_offsets', type: ['null', { type: 'array', items: 'long', 'element-id': 133 }], default: null, 'field-id': 132 },
          { name: 'equality_ids', type: ['null', { type: 'array', items: 'int', 'element-id': 136 }], default: null, 'field-id': 135 },
          { name: 'sort_order_id', type: ['null', 'int'], default: null, 'field-id': 140 },
        ],
      },
    },
  ],
} as unknown as AvroSchema

/** `manifest_file`, the record of a manifest list. */
export const MANIFEST_LIST_SCHEMA = {
  type: 'record',
  name: 'manifest_file',
  fields: [
    { name: 'manifest_path', type: 'string', 'field-id': 500 },
    { name: 'manifest_length', type: 'long', 'field-id': 501 },
    { name: 'partition_spec_id', type: 'int', 'field-id': 502 },
    { name: 'content', type: 'int', 'field-id': 517 },
    { name: 'sequence_number', type: 'long', 'field-id': 515 },
    { name: 'min_sequence_number', type: 'long', 'field-id': 516 },
    { name: 'added_snapshot_id', type: 'long', 'field-id': 503 },
    { name: 'added_files_count', type: 'int', 'field-id': 504 },
    { name: 'existing_files_count', type: 'int', 'field-id': 505 },
    { name: 'deleted_files_count', type: 'int', 'field-id': 506 },
    { name: 'added_rows_count', type: 'long', 'field-id': 512 },
    { name: 'existing_rows_count', type: 'long', 'field-id': 513 },
    { name: 'deleted_rows_count', type: 'long', 'field-id': 514 },
    {
      name: 'partitions',
      'field-id': 507,
      default: null,
      type: [
        'null',
        {
          type: 'array',
          'element-id': 508,
          items: {
            type: 'record',
            name: 'r508',
            fields: [
              { name: 'contains_null', type: 'boolean', 'field-id': 509 },
              { name: 'contains_nan', type: ['null', 'boolean'], default: null, 'field-id': 518 },
              { name: 'lower_bound', type: ['null', 'bytes'], default: null, 'field-id': 510 },
              { name: 'upper_bound', type: ['null', 'bytes'], default: null, 'field-id': 511 },
            ],
          },
        },
      ],
    },
    { name: 'key_metadata', type: ['null', 'bytes'], default: null, 'field-id': 519 },
  ],
} as unknown as AvroSchema

// ───────────────────────────── values ─────────────────────────────

const utf8 = new TextEncoder()
const utf8d = new TextDecoder()

export const dayToInt = (day: string): number => {
  const ms = Date.parse(`${day}T00:00:00Z`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(ms)) throw new Error(`publisher: bad day ${day}`)
  return ms / 86_400_000
}
export const intToDay = (n: number): string => new Date(n * 86_400_000).toISOString().slice(0, 10)

const longBytes = (v: number): Uint8Array => {
  const b = new Uint8Array(8)
  new DataView(b.buffer).setBigInt64(0, BigInt(v), true)
  return b
}
const intBytes = (v: number): Uint8Array => {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setInt32(0, v, true)
  return b
}

export const toHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
export const fromHex = (h: string): Uint8Array => {
  const out = new Uint8Array(h.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** Per-file statistics kept with a live file, as JSON text: bounds are hex by field id. */
export interface FileStats {
  lo: Record<string, string>
  hi: Record<string, string>
  split: number[] | null
}

/**
 * Column bounds and split offsets derived from a ledger `FileEntry`.
 *
 * - `ts` (samples) and `min_ts`/`max_ts` (series): from `minTs`/`maxTs`. For the series
 *   table both columns lie inside `[minTs, maxTs]`; that bound is valid for each column but
 *   exact only for the lower bound of `min_ts` and the upper bound of `max_ts`.
 * - `metric_name`: exact, from the engine's index fragment (min and max over row groups).
 * - split offsets: the row groups' first-page offsets, from the index fragment.
 *
 * The index fragment belongs to the engine. If it does not parse as version 1 the name
 * bounds and split offsets are left out; nothing else depends on it.
 */
export function statsFor(table: Table, f: FileEntry): FileStats {
  const lo: Record<string, string> = {}
  const hi: Record<string, string> = {}
  const tsColumns = table === 'metric_samples' ? [3] : [4, 5]
  for (const id of tsColumns) {
    lo[id] = toHex(longBytes(f.minTs))
    hi[id] = toHex(longBytes(f.maxTs))
  }
  let split: number[] | null = null
  try {
    const idx = JSON.parse(f.index) as { v?: number; rg?: { off: number; min_name: string; max_name: string }[] }
    if (idx.v === 1 && Array.isArray(idx.rg) && idx.rg.length > 0) {
      const names = idx.rg.flatMap((g) => [g.min_name, g.max_name])
      if (names.every((n) => typeof n === 'string')) {
        // Byte order, which is how the engine and Iceberg both compare strings.
        const sorted = names.map((n) => utf8.encode(n)).sort(compareBytes)
        lo[1] = toHex(sorted[0] as Uint8Array)
        hi[1] = toHex(sorted[sorted.length - 1] as Uint8Array)
      }
      const offs = idx.rg.map((g) => g.off)
      if (offs.every((o, i) => Number.isSafeInteger(o) && o >= 0 && (i === 0 || o > (offs[i - 1] as number)))) split = offs
    }
  } catch {
    // An index fragment the publisher cannot read costs only optional statistics.
  }
  return { lo, hi, split }
}

export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const d = (a[i] as number) - (b[i] as number)
    if (d !== 0) return d
  }
  return a.length - b.length
}

// ───────────────────────────── manifests ─────────────────────────────

export const STATUS_EXISTING = 0
export const STATUS_ADDED = 1
export const STATUS_DELETED = 2

/** A data file as the publisher tracks it: what one manifest entry says. */
export interface LiveFile {
  key: string
  tenant: string
  day: string
  rows: number
  bytes: number
  /** Snapshot that added the file, and its data and file sequence numbers. */
  snapshotId: number
  seq: number
  fileSeq: number
  stats: FileStats
}

export interface ManifestEntryRecord {
  status: number
  snapshot_id: number | null
  sequence_number: number | null
  file_sequence_number: number | null
  data_file: {
    content: number
    file_path: string
    file_format: string
    partition: { tenant: string | null; day: number | null }
    record_count: number
    file_size_in_bytes: number
    column_sizes: null
    value_counts: { key: number; value: number }[] | null
    null_value_counts: { key: number; value: number }[] | null
    nan_value_counts: null
    lower_bounds: { key: number; value: Uint8Array }[] | null
    upper_bounds: { key: number; value: Uint8Array }[] | null
    key_metadata: null
    split_offsets: number[] | null
    equality_ids: null
    sort_order_id: number | null
  }
}

const boundList = (m: Record<string, string>) => {
  const out = Object.entries(m)
    .map(([k, v]) => ({ key: Number(k), value: fromHex(v) }))
    .sort((a, b) => a.key - b.key)
  return out.length > 0 ? out : null
}

/**
 * One manifest entry. An ADDED entry leaves both sequence numbers null so that they are
 * inherited from the manifest list; EXISTING and DELETED entries carry them explicitly, as
 * the spec requires. A DELETED entry's `snapshot_id` is the snapshot that removed the file.
 */
export function manifestEntry(table: Table, f: LiveFile, status: number, uri: string, deletingSnapshot?: number): ManifestEntryRecord {
  const counts = TABLE_DEFS[table].data.map((c) => c.id)
  return {
    status,
    snapshot_id: status === STATUS_DELETED ? (deletingSnapshot as number) : f.snapshotId,
    sequence_number: status === STATUS_ADDED ? null : f.seq,
    file_sequence_number: status === STATUS_ADDED ? null : f.fileSeq,
    data_file: {
      content: 0,
      file_path: uri,
      file_format: 'PARQUET',
      partition: { tenant: f.tenant, day: dayToInt(f.day) + 1 },
      record_count: f.rows,
      file_size_in_bytes: f.bytes,
      column_sizes: null,
      // Every data column is required, so each has `rows` values and no nulls.
      value_counts: counts.map((key) => ({ key, value: f.rows })),
      null_value_counts: counts.map((key) => ({ key, value: 0 })),
      nan_value_counts: null,
      lower_bounds: boundList(f.stats.lo),
      upper_bounds: boundList(f.stats.hi),
      key_metadata: null,
      split_offsets: f.stats.split,
      equality_ids: null,
      sort_order_id: SORT_ORDER_ID,
    },
  }
}

/** The reverse of `manifestEntry` for a live entry read back from R2. */
export function liveFromEntry(e: ManifestEntryRecord, key: string, inherited: { snapshotId: number; seq: number }): LiveFile {
  const hexMap = (l: { key: number; value: Uint8Array }[] | null) => Object.fromEntries((l ?? []).map((x) => [String(x.key), toHex(x.value)]))
  const p = e.data_file.partition
  if (p.tenant === null || p.day === null) throw new Error(`publisher: manifest entry without a partition value: ${key}`)
  return {
    key,
    tenant: p.tenant,
    day: intToDay(p.day),
    rows: e.data_file.record_count,
    bytes: e.data_file.file_size_in_bytes,
    snapshotId: e.snapshot_id ?? inherited.snapshotId,
    seq: e.sequence_number ?? inherited.seq,
    fileSeq: e.file_sequence_number ?? inherited.seq,
    stats: { lo: hexMap(e.data_file.lower_bounds), hi: hexMap(e.data_file.upper_bounds), split: e.data_file.split_offsets },
  }
}

export const manifestHeader = (table: Table): Record<string, string> => ({
  schema: JSON.stringify(icebergSchema(table)),
  'schema-id': '0',
  'partition-spec': JSON.stringify(partitionSpecFields(table)),
  'partition-spec-id': '0',
  'format-version': '2',
  content: 'data',
})

/** One row of a manifest list, and what the publisher remembers about a manifest. */
export interface ManifestInfo {
  path: string
  length: number
  /** Sequence number of the snapshot that wrote the manifest. */
  seq: number
  minSeq: number
  addedSnapshotId: number
  addedFiles: number
  existingFiles: number
  deletedFiles: number
  addedRows: number
  existingRows: number
  deletedRows: number
  tenantLo: string
  tenantHi: string
  dayLo: number
  dayHi: number
}

export interface ManifestListRecord {
  manifest_path: string
  manifest_length: number
  partition_spec_id: number
  content: number
  sequence_number: number
  min_sequence_number: number
  added_snapshot_id: number
  added_files_count: number
  existing_files_count: number
  deleted_files_count: number
  added_rows_count: number
  existing_rows_count: number
  deleted_rows_count: number
  partitions: { contains_null: boolean; contains_nan: boolean | null; lower_bound: Uint8Array | null; upper_bound: Uint8Array | null }[] | null
  key_metadata: null
}

export const manifestListRecord = (m: ManifestInfo, uri: string): ManifestListRecord => ({
  manifest_path: uri,
  manifest_length: m.length,
  partition_spec_id: 0,
  content: 0,
  sequence_number: m.seq,
  min_sequence_number: m.minSeq,
  added_snapshot_id: m.addedSnapshotId,
  added_files_count: m.addedFiles,
  existing_files_count: m.existingFiles,
  deleted_files_count: m.deletedFiles,
  added_rows_count: m.addedRows,
  existing_rows_count: m.existingRows,
  deleted_rows_count: m.deletedRows,
  partitions: [
    { contains_null: false, contains_nan: false, lower_bound: utf8.encode(m.tenantLo), upper_bound: utf8.encode(m.tenantHi) },
    { contains_null: false, contains_nan: false, lower_bound: intBytes(m.dayLo), upper_bound: intBytes(m.dayHi) },
  ],
  key_metadata: null,
})

export function manifestInfoFromRecord(r: ManifestListRecord, path: string): ManifestInfo {
  const [t, d] = r.partitions ?? []
  if (!t?.lower_bound || !t.upper_bound || !d?.lower_bound || !d.upper_bound) throw new Error(`publisher: manifest list row without partition summaries: ${path}`)
  const int = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, 4).getInt32(0, true)
  return {
    path,
    length: r.manifest_length,
    seq: r.sequence_number,
    minSeq: r.min_sequence_number,
    addedSnapshotId: r.added_snapshot_id,
    addedFiles: r.added_files_count,
    existingFiles: r.existing_files_count,
    deletedFiles: r.deleted_files_count,
    addedRows: r.added_rows_count,
    existingRows: r.existing_rows_count,
    deletedRows: r.deleted_rows_count,
    tenantLo: utf8d.decode(t.lower_bound),
    tenantHi: utf8d.decode(t.upper_bound),
    dayLo: int(d.lower_bound),
    dayHi: int(d.upper_bound),
  }
}

/** Counts and partition ranges for a manifest about to be written. `seq` is the commit's. */
export function summarise(
  parts: { file: LiveFile; status: number }[],
  seq: number,
  snapshotId: number,
): Omit<ManifestInfo, 'path' | 'length'> {
  const m = {
    seq,
    minSeq: seq,
    addedSnapshotId: snapshotId,
    addedFiles: 0,
    existingFiles: 0,
    deletedFiles: 0,
    addedRows: 0,
    existingRows: 0,
    deletedRows: 0,
    tenantLo: '',
    tenantHi: '',
    dayLo: 0,
    dayHi: 0,
  }
  let first = true
  for (const { file, status } of parts) {
    if (status === STATUS_ADDED) {
      m.addedFiles++
      m.addedRows += file.rows
    } else if (status === STATUS_EXISTING) {
      m.existingFiles++
      m.existingRows += file.rows
    } else {
      m.deletedFiles++
      m.deletedRows += file.rows
    }
    // Minimum data sequence number over live entries; an added entry has the commit's.
    if (status === STATUS_EXISTING) m.minSeq = Math.min(m.minSeq, file.seq)
    const day = dayToInt(file.day)
    if (first || file.tenant < m.tenantLo) m.tenantLo = file.tenant
    if (first || file.tenant > m.tenantHi) m.tenantHi = file.tenant
    if (first || day < m.dayLo) m.dayLo = day
    if (first || day > m.dayHi) m.dayHi = day
    first = false
  }
  return m
}

// ───────────────────────────── metadata.json ─────────────────────────────

export interface Snapshot {
  'snapshot-id': number
  'parent-snapshot-id'?: number
  'sequence-number': number
  'timestamp-ms': number
  'manifest-list': string
  summary: Record<string, string>
  'schema-id': number
}

export interface TableMetadata {
  'format-version': 2
  'table-uuid': string
  location: string
  'last-sequence-number': number
  'last-updated-ms': number
  'last-column-id': number
  'current-schema-id': number
  schemas: unknown[]
  'default-spec-id': number
  'partition-specs': unknown[]
  'last-partition-id': number
  'default-sort-order-id': number
  'sort-orders': unknown[]
  properties: Record<string, string>
  'current-snapshot-id'?: number
  refs: Record<string, { 'snapshot-id': number; type: 'branch' }>
  snapshots: Snapshot[]
  'snapshot-log': { 'snapshot-id': number; 'timestamp-ms': number }[]
  'metadata-log': { 'metadata-file': string; 'timestamp-ms': number }[]
}

/** Summary key that points at the immutable object holding every tenant's ledger cursor. */
export const CURSORS_KEY = 'viz.ledger-cursors'

export function emptyMetadata(table: Table, location: string, cell: string, uuid: string, now: number): TableMetadata {
  const d = TABLE_DEFS[table]
  return {
    'format-version': 2,
    'table-uuid': uuid,
    location,
    'last-sequence-number': 0,
    'last-updated-ms': now,
    'last-column-id': d.day.id,
    'current-schema-id': 0,
    schemas: [icebergSchema(table)],
    'default-spec-id': 0,
    'partition-specs': [{ 'spec-id': 0, fields: partitionSpecFields(table) }],
    'last-partition-id': PARTITION_DAY_ID,
    'default-sort-order-id': SORT_ORDER_ID,
    'sort-orders': [
      { 'order-id': 0, fields: [] },
      { 'order-id': SORT_ORDER_ID, fields: d.sort.map((id) => ({ transform: 'identity', 'source-id': id, direction: 'asc', 'null-order': 'nulls-first' })) },
    ],
    properties: {
      'schema.name-mapping.default': JSON.stringify(nameMapping(table)),
      'write.format.default': 'parquet',
      // viz is the only writer and deletes data files itself, after the ledger says so.
      'gc.enabled': 'false',
      'viz.cell': cell,
      'viz.table': table,
    },
    refs: {},
    snapshots: [],
    'snapshot-log': [],
    'metadata-log': [],
  }
}

export interface Retention {
  /** Snapshots younger than this are kept. */
  snapshotWindowMs: number
  /** At least this many of the newest snapshots are kept, whatever their age. */
  minSnapshots: number
  /** Previous metadata files listed in `metadata-log`; older ones become orphans. */
  metadataLogMax: number
}

/** The snapshots that survive: inside the window, or among the newest `minSnapshots`. */
export function retained(snapshots: Snapshot[], now: number, r: Retention): Snapshot[] {
  const byAge = [...snapshots].sort((a, b) => a['sequence-number'] - b['sequence-number'])
  const keepFrom = Math.max(0, byAge.length - Math.max(2, r.minSnapshots))
  return byAge.filter((s, i) => i >= keepFrom || s['timestamp-ms'] > now - r.snapshotWindowMs)
}

/**
 * The next `metadata.json`: `prev` with `snapshot` appended and made current (if given),
 * expired snapshots dropped, and `prevFile` added to the metadata log.
 */
export function nextMetadata(prev: TableMetadata, prevFile: string | null, snapshot: Snapshot | null, now: number, r: Retention): TableMetadata {
  const all = snapshot ? [...prev.snapshots, snapshot] : prev.snapshots
  const kept = retained(all, now, r)
  const keptIds = new Set(kept.map((s) => s['snapshot-id']))
  const current = snapshot ? snapshot['snapshot-id'] : prev['current-snapshot-id']
  const next: TableMetadata = {
    ...prev,
    'last-sequence-number': snapshot ? snapshot['sequence-number'] : prev['last-sequence-number'],
    'last-updated-ms': now,
    refs: current === undefined ? {} : { main: { 'snapshot-id': current, type: 'branch' } },
    snapshots: kept,
    'snapshot-log': [...prev['snapshot-log'], ...(snapshot ? [{ 'snapshot-id': snapshot['snapshot-id'], 'timestamp-ms': snapshot['timestamp-ms'] }] : [])].filter((e) =>
      keptIds.has(e['snapshot-id']),
    ),
    'metadata-log': [...prev['metadata-log'], ...(prevFile ? [{ 'metadata-file': prevFile, 'timestamp-ms': prev['last-updated-ms'] }] : [])].slice(-r.metadataLogMax),
  }
  if (current !== undefined) next['current-snapshot-id'] = current
  return next
}
