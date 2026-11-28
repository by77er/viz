/**
 * Iceberg format-version 2 metadata for the viz tables: table schemas, the Avro schemas of
 * manifests and manifest lists, and builders for their records and for `metadata.json`.
 * Nothing here does I/O.
 *
 * Five tables: the metric pair (`TABLE_DEFS`, unchanged since the first release: the same bytes)
 * and, since design/DECISIONS.md D67, the span and log tables (`SIGNAL_DEFS`: `spans`,
 * `trace_index`, `logs`, contracts/TRACES.md and contracts/LOGS.md), with nested types, a field id
 * for every element, key and value, and a nested name mapping. `spans` is partitioned by
 * `identity(tenant)` and `hour(start_time)`; the others by `identity(tenant)` and `identity(day)`.
 * Sections of the Iceberg table spec used (format/spec.md, read 2026-11-19): "Nested Types",
 * "Column Projection" (name mapping, identity partition values), "Partition Transforms"
 * (`identity`, `hour`), "Manifests" (`data_file`, the partition struct by partition field ids,
 * field-level metrics), "Manifest Lists" (`field_summary`), Appendix C (JSON of schemas, name
 * mapping) and Appendix D (single-value serialization of bounds).
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
import type { FileEntry, LedgerTable, SignalTable, Table } from '../../contracts/ledger'
import type { AvroSchema } from './avro'

/**
 * Every table this publisher publishes, in commit order: the metric pair first, so that in every
 * publish their commits come first and are what they were before the span and log tables were
 * published (design/DECISIONS.md D67).
 */
export const TABLE_NAMES: readonly LedgerTable[] = ['metric_samples', 'metric_series', 'spans', 'trace_index', 'logs']
export const METRIC_TABLE_NAMES: readonly Table[] = ['metric_samples', 'metric_series']
export const SIGNAL_TABLE_NAMES: readonly SignalTable[] = ['spans', 'trace_index', 'logs']
export const isMetricTable = (t: LedgerTable): t is Table => t === 'metric_samples' || t === 'metric_series'

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

export const icebergSchema = (table: LedgerTable) => {
  if (!isMetricTable(table)) return signalSchema(table)
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

/** A span or log table's schema: `tenant` (and `day`) first, optional and filled from the partition tuple, as for metrics; then the files' columns. */
function signalSchema(table: SignalTable) {
  const d = SIGNAL_DEFS[table]
  return {
    type: 'struct',
    'schema-id': 0,
    fields: [
      { id: d.tenant, name: 'tenant', required: false, type: 'string', doc: TENANT_DOC },
      ...(d.day === null ? [] : [{ id: d.day, name: 'day', required: false, type: 'date', doc: d.dayDoc as string }]),
      ...d.data,
    ],
  }
}

export const partitionSpecFields = (table: LedgerTable) => {
  if (!isMetricTable(table)) {
    const d = SIGNAL_DEFS[table]
    return [
      { name: 'tenant', transform: 'identity', 'source-id': d.tenant, 'field-id': PARTITION_TENANT_ID },
      d.hourSource !== null
        ? { name: PARTITION_HOUR_NAME, transform: 'hour', 'source-id': d.hourSource, 'field-id': PARTITION_HOUR_ID }
        : { name: 'day', transform: 'identity', 'source-id': d.day as number, 'field-id': PARTITION_DAY_ID },
    ]
  }
  const d = TABLE_DEFS[table]
  return [
    { name: 'tenant', transform: 'identity', 'source-id': d.tenant.id, 'field-id': PARTITION_TENANT_ID },
    { name: 'day', transform: 'identity', 'source-id': d.day.id, 'field-id': PARTITION_DAY_ID },
  ]
}

const nameMapping = (table: Table) => TABLE_DEFS[table].data.map((c) => ({ 'field-id': c.id, names: [c.name] }))

// ───────────────────────────── the span and log tables (D67) ─────────────────────────────

/** Iceberg types (spec, Appendix C "Schemas"). */
export type IcebergType = 'string' | 'long' | 'int' | 'double' | 'boolean' | 'date' | 'timestamptz' | 'fixed[16]' | 'fixed[8]' | ListType | MapType | StructType
export interface ListType {
  type: 'list'
  'element-id': number
  'element-required': boolean
  element: IcebergType
}
export interface MapType {
  type: 'map'
  'key-id': number
  key: IcebergType
  'value-id': number
  'value-required': boolean
  value: IcebergType
}
export interface StructType {
  type: 'struct'
  fields: SchemaField[]
}
export interface SchemaField {
  id: number
  name: string
  required: boolean
  type: IcebergType
  doc?: string
}

/**
 * A span or log table. Field ids are pinned here, never derived, and never reused (`test/golden/
 * formats/iceberg.signal-metadata.v1.json`): the columns of the data files 1..N in file order, then
 * the partition columns that are not in the files (`tenant`, and `day` where it is a partition
 * source), then every nested id (map keys and values, list elements, the fields of a list's
 * struct element) in order of appearance.
 */
export interface SignalTableDef {
  /** The columns of the Parquet files, in file order, with their Iceberg types (required as the files say). */
  data: SchemaField[]
  /** Field id of the optional `tenant` column (filled from the partition tuple). */
  tenant: number
  /** Field id of the optional `day` column (`trace_index`, `logs`), or null (`spans`: its second partition field is `hour(start_time)`). */
  day: number | null
  /** `spans`: the field id of `start_time`, the source of the `hour` transform. */
  hourSource: number | null
  /** Field ids of the declared sort order, all ascending. */
  sort: number[]
  lastColumnId: number
  /** What the optional `day` column means, for its doc. */
  dayDoc: string | null
}

const col = (id: number, name: string, type: IcebergType, required = false): SchemaField => ({ id, name, required, type })
const strMap = (keyId: number, valueId: number, value: IcebergType): MapType => ({ type: 'map', 'key-id': keyId, key: 'string', 'value-id': valueId, 'value-required': true, value })
const listOf = (elementId: number, element: IcebergType): ListType => ({ type: 'list', 'element-id': elementId, 'element-required': true, element })
const structOf = (...fields: SchemaField[]): StructType => ({ type: 'struct', fields })

export const SIGNAL_DEFS: Record<SignalTable, SignalTableDef> = {
  // contracts/TRACES.md, "`spans`"; engine/storage/src/spans.rs writes exactly these 44 columns.
  spans: {
    data: [
      col(1, 'trace_id', 'fixed[16]', true),
      col(2, 'span_id', 'fixed[8]', true),
      col(3, 'parent_span_id', 'fixed[8]'),
      col(4, 'trace_state', 'string'),
      col(5, 'flags', 'int'),
      col(6, 'start_unix_nano', 'long', true),
      col(7, 'end_unix_nano', 'long', true),
      col(8, 'duration_nano', 'long', true),
      col(9, 'start_time', 'timestamptz', true),
      col(10, 'service_name', 'string'),
      col(11, 'span_name', 'string', true),
      col(12, 'span_kind', 'int', true),
      col(13, 'status_code', 'int', true),
      col(14, 'status_message', 'string'),
      col(15, 'scope_name', 'string'),
      col(16, 'scope_version', 'string'),
      col(17, 'resource_fp', 'long', true),
      col(18, 'r_service_namespace', 'string'),
      col(19, 'r_deployment_environment', 'string'),
      col(20, 'r_k8s_namespace_name', 'string'),
      col(21, 'r_k8s_pod_name', 'string'),
      col(22, 'r_cloud_region', 'string'),
      col(23, 's_http_request_method', 'string'),
      col(24, 's_http_response_status_code', 'long'),
      col(25, 's_http_route', 'string'),
      col(26, 's_db_system_name', 'string'),
      col(27, 's_rpc_service', 'string'),
      col(28, 's_error_type', 'string'),
      col(29, 'resource_attrs_str', strMap(46, 47, 'string')),
      col(30, 'resource_attrs_int', strMap(48, 49, 'long')),
      col(31, 'resource_attrs_dbl', strMap(50, 51, 'double')),
      col(32, 'resource_attrs_bool', strMap(52, 53, 'boolean')),
      col(33, 'resource_attrs_other', 'string'),
      col(34, 'span_attrs_str', strMap(54, 55, 'string')),
      col(35, 'span_attrs_int', strMap(56, 57, 'long')),
      col(36, 'span_attrs_dbl', strMap(58, 59, 'double')),
      col(37, 'span_attrs_bool', strMap(60, 61, 'boolean')),
      col(38, 'span_attrs_other', 'string'),
      col(39, 'scope_attrs', 'string'),
      col(40, 'events', listOf(62, structOf(col(63, 'time_unix_nano', 'long', true), col(64, 'name', 'string', true), col(65, 'attrs', 'string', true)))),
      col(41, 'links', listOf(66, structOf(col(67, 'trace_id', 'fixed[16]', true), col(68, 'span_id', 'fixed[8]', true), col(69, 'trace_state', 'string', true), col(70, 'attrs', 'string', true)))),
      col(42, 'dropped_attributes_count', 'int'),
      col(43, 'dropped_events_count', 'int'),
      col(44, 'dropped_links_count', 'int'),
    ],
    tenant: 45,
    day: null,
    hourSource: 9,
    // service_name (nulls first), span_name, start_unix_nano, then trace_id and span_id: TRACES.md.
    sort: [10, 11, 6, 1, 2],
    lastColumnId: 70,
    dayDoc: null,
  },
  // contracts/TRACES.md, "`trace_index`".
  trace_index: {
    data: [
      col(1, 'trace_id', 'fixed[16]', true),
      col(2, 'min_start_unix_nano', 'long', true),
      col(3, 'max_end_unix_nano', 'long', true),
      col(4, 'span_count', 'int', true),
      col(5, 'error_count', 'int', true),
      col(6, 'root_service_name', 'string'),
      col(7, 'root_span_name', 'string'),
      col(8, 'root_start_unix_nano', 'long'),
      col(9, 'root_span_id', 'fixed[8]'),
      col(10, 'services', listOf(15, structOf(col(16, 'name', 'string', true), col(17, 'spans', 'int', true), col(18, 'errors', 'int', true))), true),
      col(11, 'services_truncated', 'boolean', true),
      col(12, 'hours', listOf(19, 'int'), true),
    ],
    tenant: 13,
    day: 14,
    hourSource: null,
    sort: [1],
    lastColumnId: 19,
    dayDoc: "UTC day of the fragments' first span start (min_start_unix_nano). Not stored in the data files; read from the partition tuple.",
  },
  // contracts/LOGS.md §2.
  logs: {
    data: [
      col(1, 'service_name', 'string', true),
      col(2, 'stream_id', 'long', true),
      col(3, 'ts', 'long', true),
      col(4, 'labels', 'string', true),
      col(5, 'line', 'string', true),
      col(6, 'metadata', strMap(15, 16, 'string'), true),
      col(7, 'observed_ts', 'long'),
      col(8, 'severity_number', 'int'),
      col(9, 'severity_text', 'string'),
      col(10, 'trace_id', 'fixed[16]'),
      col(11, 'span_id', 'fixed[8]'),
      col(12, 'flags', 'int'),
    ],
    tenant: 13,
    day: 14,
    hourSource: null,
    // service_name, stream_id, ts, line (then metadata, which a sort order cannot name: LOGS.md §4).
    sort: [1, 2, 3, 5],
    lastColumnId: 16,
    dayDoc: 'UTC day of `ts`. Not stored in the data files; read from the partition tuple.',
  },
}

/** Name of the `hour(start_time)` partition field of `spans` (the name Iceberg's own writers give it). */
export const PARTITION_HOUR_NAME = 'start_time_hour'
/** Field id of that partition field (unique within the table's specs; `spans` has no `day` partition field). */
export const PARTITION_HOUR_ID = 1001

const TENANT_DOC = 'Tenant id. Not stored in the data files; read from the partition tuple.'

/** Every field of a schema, nested ones included, as `[id, dotted name]`: what the field-id golden check walks. */
export function flattenFields(fields: SchemaField[], prefix = ''): [number, string][] {
  const out: [number, string][] = []
  const walk = (t: IcebergType, path: string) => {
    if (typeof t === 'string') return
    if (t.type === 'struct') for (const f of t.fields) visit(f, path)
    else if (t.type === 'list') {
      out.push([t['element-id'], `${path}.element`])
      walk(t.element, `${path}.element`)
    } else {
      out.push([t['key-id'], `${path}.key`])
      walk(t.key, `${path}.key`)
      out.push([t['value-id'], `${path}.value`])
      walk(t.value, `${path}.value`)
    }
  }
  const visit = (f: SchemaField, path: string) => {
    const name = path ? `${path}.${f.name}` : f.name
    out.push([f.id, name])
    walk(f.type, name)
  }
  for (const f of fields) visit(f, prefix)
  return out
}

/**
 * The name mapping (`schema.name-mapping.default`) of a span or log table: every column of the
 * data files by name, with `fields` for the children of maps (`key`, `value`), lists (`element`)
 * and structs (spec, "Column Projection" and Appendix C, "Name Mapping Serialization"). The files
 * carry no field ids (publisher/README.md, Contract issues 4), so this is how a reader finds every
 * column, nested ones included. The partition columns are not in the files and are not mapped.
 */
export function signalNameMapping(table: SignalTable): unknown[] {
  type Mapping = { 'field-id': number; names: string[]; fields?: Mapping[] }
  const children = (t: IcebergType): Mapping[] | null => {
    if (typeof t === 'string') return null
    if (t.type === 'struct') return t.fields.map(field)
    if (t.type === 'list') return [node(t['element-id'], 'element', t.element)]
    return [node(t['key-id'], 'key', t.key), node(t['value-id'], 'value', t.value)]
  }
  const node = (id: number, name: string, t: IcebergType): Mapping => {
    const m: Mapping = { 'field-id': id, names: [name] }
    const c = children(t)
    if (c) m.fields = c
    return m
  }
  const field = (f: SchemaField): Mapping => node(f.id, f.name, f.type)
  return SIGNAL_DEFS[table].data.map(field)
}

/** Field ids of the required top-level primitive columns: each has `record_count` values and no nulls in every file. */
const requiredPrimitiveIds = (table: SignalTable): number[] => SIGNAL_DEFS[table].data.filter((c) => c.required && typeof c.type === 'string').map((c) => c.id)

/**
 * The hour partition of a `spans` file: hours since 1970-01-01 00:00 UTC (spec, "Partition
 * Transforms", `hour`: the value of `hour(start_time)` for every row of the file). From its key,
 * `…/day={day}/hour={HH}/…` (contracts/ledger.ts `dataKeyPrefix`), under which the ledger admits a
 * `spans` file only if its `[minTs, maxTs]` lies in that hour. Throws for a key without that level.
 */
export function spanHour(key: string, day: string): number {
  const m = /\/day=(\d{4}-\d{2}-\d{2})\/hour=(\d{2})\//.exec(key)
  if (!m || m[1] !== day || Number(m[2]) > 23) throw new Error(`publisher: ${key} is not a spans key of day ${day} with an hour level`)
  return dayToInt(day) * 24 + Number(m[2])
}

/**
 * Why a `spans` file cannot be published as it is listed, or null: its key has no hour level of
 * its day, or its time range (`minTs`/`maxTs`, the floors of its start times in ms) is not inside
 * that hour, so the partition value the key gives would not be `hour(start_time)` of its rows.
 */
export function spanHourProblem(f: { key: string; day: string; minTs: number; maxTs: number }): string | null {
  let h: number
  try {
    h = spanHour(f.key, f.day)
  } catch (e) {
    return (e as Error).message
  }
  const lo = Math.floor(f.minTs / 3_600_000)
  const hi = Math.floor(f.maxTs / 3_600_000)
  if (lo !== h || hi !== h) return `${f.key} is under hour ${h} of the epoch; its start times lie in hours ${lo} to ${hi}`
  return null
}

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

/** The `partition` record of `data_file` (field 102): one field per partition field, ids from the spec. */
const TENANT_PARTITION = { name: 'tenant', type: ['null', 'string'], default: null, 'field-id': PARTITION_TENANT_ID }
const DAY_PARTITION = { name: 'day', type: ['null', { type: 'int', logicalType: 'date' }], default: null, 'field-id': PARTITION_DAY_ID }
/** `hour(start_time)`: an int, hours since the epoch (spec, "Partition Transforms"). */
const HOUR_PARTITION = { name: PARTITION_HOUR_NAME, type: ['null', 'int'], default: null, 'field-id': PARTITION_HOUR_ID }

/** `manifest_entry` with the `data_file` struct for a partition struct of these fields. */
const manifestEntrySchemaWith = (partition: unknown[]) =>
  ({
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
                fields: partition,
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
  }) as unknown as AvroSchema

/** `manifest_entry` with the `data_file` struct for the `{tenant, day}` partition spec: the metric tables, `trace_index` and `logs`. */
export const MANIFEST_ENTRY_SCHEMA = manifestEntrySchemaWith([TENANT_PARTITION, DAY_PARTITION])
/** `manifest_entry` for `spans`: partition `{tenant, start_time_hour}`. */
export const SPANS_MANIFEST_ENTRY_SCHEMA = manifestEntrySchemaWith([TENANT_PARTITION, HOUR_PARTITION])
export const manifestEntrySchema = (table: LedgerTable): AvroSchema => (table === 'spans' ? SPANS_MANIFEST_ENTRY_SCHEMA : MANIFEST_ENTRY_SCHEMA)

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

const longBytes = (v: number | bigint): Uint8Array => {
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
export function statsFor(table: LedgerTable, f: FileEntry): FileStats {
  if (!isMetricTable(table)) return signalStatsFor(table, f)
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

const NS_PER_MS = 1_000_000n
const US_PER_MS = 1_000n

/**
 * Bounds and split offsets of a span or log file (spec, "Field-level Metrics and Statistics";
 * Appendix D for the bytes). Every bound is valid (no value of the column lies outside it); which
 * are exact is said per column.
 *
 * - Times, from the ledger's `minTs`/`maxTs`, the floors in milliseconds of the file's nanosecond
 *   bounds (contracts/engine.ts `EncodedSignalFile`), widened to the whole last millisecond:
 *   `spans` `start_unix_nano` (ns) and `start_time` (timestamptz, µs) lie in
 *   `[minTs·10⁶, maxTs·10⁶ + 999,999]` ns; `logs` `ts` likewise; `trace_index`'s
 *   `min_start_unix_nano` and `max_end_unix_nano` both lie between the file's smallest start and
 *   largest end, so that range bounds both (as `min_ts`/`max_ts` of the series table).
 * - `service_name` (`spans`, `logs`): the row groups' `min_name`/`max_name` of the index fragment
 *   (for `spans` a null counts as `""` there, so the lower bound may be `""`: still a valid bound).
 * - `trace_id` (`trace_index`): exact, the first and last row's (`min_tid`/`max_tid`; the file is
 *   sorted by it).
 * - Split offsets: the row groups' offsets, from the fragment.
 *
 * The fragment's 64-bit integers are never read as numbers here (TRACES.md: a JavaScript reader
 * must not). A fragment this code cannot read costs only the fragment's statistics.
 */
function signalStatsFor(table: SignalTable, f: FileEntry): FileStats {
  const lo: Record<string, string> = {}
  const hi: Record<string, string> = {}
  const nsLo = BigInt(f.minTs) * NS_PER_MS
  const nsHi = BigInt(f.maxTs) * NS_PER_MS + NS_PER_MS - 1n
  const ns = (...ids: number[]) => {
    for (const id of ids) {
      lo[id] = toHex(longBytes(nsLo))
      hi[id] = toHex(longBytes(nsHi))
    }
  }
  if (table === 'spans') {
    ns(6)
    lo[9] = toHex(longBytes(BigInt(f.minTs) * US_PER_MS))
    hi[9] = toHex(longBytes(BigInt(f.maxTs) * US_PER_MS + US_PER_MS - 1n))
  } else if (table === 'trace_index') ns(2, 3)
  else ns(3)
  let split: number[] | null = null
  try {
    const idx = JSON.parse(f.index) as { v?: number; rg?: { off: number; min_name?: unknown; max_name?: unknown; min_tid?: unknown; max_tid?: unknown }[] }
    if (idx.v === 1 && Array.isArray(idx.rg) && idx.rg.length > 0) {
      if (table === 'trace_index') {
        const first = idx.rg[0]!.min_tid
        const last = idx.rg[idx.rg.length - 1]!.max_tid
        const hex32 = (x: unknown): x is string => typeof x === 'string' && /^[0-9a-f]{32}$/.test(x)
        if (hex32(first) && hex32(last) && first <= last) {
          lo[1] = first
          hi[1] = last
        }
      } else {
        const names = idx.rg.flatMap((g) => [g.min_name, g.max_name])
        if (names.every((n) => typeof n === 'string')) {
          const sorted = (names as string[]).map((n) => utf8.encode(n)).sort(compareBytes)
          const id = table === 'spans' ? 10 : 1
          lo[id] = toHex(sorted[0] as Uint8Array)
          hi[id] = toHex(sorted[sorted.length - 1] as Uint8Array)
        }
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
  /** UTC day (`FileEntry.day`). For `spans` the partition is the hour, which the key holds (`spanHour`). */
  day: string
  rows: number
  bytes: number
  /** Snapshot that added the file, and its data and file sequence numbers. */
  snapshotId: number
  seq: number
  fileSeq: number
  stats: FileStats
}

/** The `partition` struct of a `data_file`: `{tenant, day}`, or for `spans` `{tenant, start_time_hour}`. */
export interface MetricPartition {
  tenant: string | null
  day: number | null
}
export interface SpansPartition {
  tenant: string | null
  start_time_hour: number | null
}
export type AnyPartition = MetricPartition | SpansPartition

export interface ManifestEntryRecord<P = MetricPartition> {
  status: number
  snapshot_id: number | null
  sequence_number: number | null
  file_sequence_number: number | null
  data_file: {
    content: number
    file_path: string
    file_format: string
    partition: P
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

/** The partition tuple of a file of `table` (spec, "Manifests": the partition struct, by partition field ids). */
export function partitionOf(table: LedgerTable, f: { tenant: string; day: string; key: string }): AnyPartition {
  if (table === 'spans') return { tenant: f.tenant, start_time_hour: spanHour(f.key, f.day) }
  return { tenant: f.tenant, day: dayToInt(f.day) }
}

/** Field ids whose value and null counts a manifest entry states: every data column of a metric table (all required); the required top-level primitive columns of a span or log table. */
const countedIds = (table: LedgerTable): number[] => (isMetricTable(table) ? TABLE_DEFS[table].data.map((c) => c.id) : requiredPrimitiveIds(table))

/**
 * One manifest entry. An ADDED entry leaves both sequence numbers null so that they are
 * inherited from the manifest list; EXISTING and DELETED entries carry them explicitly, as
 * the spec requires. A DELETED entry's `snapshot_id` is the snapshot that removed the file.
 */
export function manifestEntry(table: LedgerTable, f: LiveFile, status: number, uri: string, deletingSnapshot?: number): ManifestEntryRecord<AnyPartition> {
  const counts = countedIds(table)
  return {
    status,
    snapshot_id: status === STATUS_DELETED ? (deletingSnapshot as number) : f.snapshotId,
    sequence_number: status === STATUS_ADDED ? null : f.seq,
    file_sequence_number: status === STATUS_ADDED ? null : f.fileSeq,
    data_file: {
      content: 0,
      file_path: uri,
      file_format: 'PARQUET',
      partition: partitionOf(table, f),
      record_count: f.rows,
      file_size_in_bytes: f.bytes,
      column_sizes: null,
      // Counted columns are required, so each has `rows` values and no nulls. Optional and nested
      // columns are not counted: absent means unknown (spec, "Field-level Metrics and Statistics").
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

/** The day a partition tuple says (for `spans`, the day of its hour), and for `spans` the hour. */
export function partitionDay(p: AnyPartition): { tenant: string | null; day: number | null; hour: number | null } {
  if ('start_time_hour' in p) return { tenant: p.tenant, day: p.start_time_hour === null ? null : Math.floor(p.start_time_hour / 24), hour: p.start_time_hour }
  return { tenant: p.tenant, day: p.day, hour: null }
}

/** The reverse of `manifestEntry` for a live entry read back from R2. */
export function liveFromEntry(e: ManifestEntryRecord<AnyPartition>, key: string, inherited: { snapshotId: number; seq: number }): LiveFile {
  const hexMap = (l: { key: number; value: Uint8Array }[] | null) => Object.fromEntries((l ?? []).map((x) => [String(x.key), toHex(x.value)]))
  const p = partitionDay(e.data_file.partition)
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

export const manifestHeader = (table: LedgerTable): Record<string, string> => ({
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
  /** `spans` only: the range of `start_time_hour`, the second partition field. */
  hourLo?: number
  hourHi?: number
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

/** A manifest list row. Its `partitions` summarise each partition field in spec order: tenant, then day (or for `spans` the hour), as ints (spec, "Manifest Lists", `field_summary`). */
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
    m.hourLo !== undefined
      ? { contains_null: false, contains_nan: false, lower_bound: intBytes(m.hourLo), upper_bound: intBytes(m.hourHi as number) }
      : { contains_null: false, contains_nan: false, lower_bound: intBytes(m.dayLo), upper_bound: intBytes(m.dayHi) },
  ],
  key_metadata: null,
})

export function manifestInfoFromRecord(r: ManifestListRecord, path: string, table: LedgerTable = 'metric_samples'): ManifestInfo {
  const [t, d] = r.partitions ?? []
  if (!t?.lower_bound || !t.upper_bound || !d?.lower_bound || !d.upper_bound) throw new Error(`publisher: manifest list row without partition summaries: ${path}`)
  const int = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, 4).getInt32(0, true)
  const info: ManifestInfo = {
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
  if (table === 'spans') {
    info.hourLo = info.dayLo
    info.hourHi = info.dayHi
    info.dayLo = Math.floor(info.hourLo / 24)
    info.dayHi = Math.floor(info.hourHi / 24)
  }
  return info
}

/** Counts and partition ranges for a manifest about to be written. `seq` is the commit's. */
export function summarise(
  parts: { file: LiveFile; status: number }[],
  seq: number,
  snapshotId: number,
  table: LedgerTable = 'metric_samples',
): Omit<ManifestInfo, 'path' | 'length'> {
  const m: Omit<ManifestInfo, 'path' | 'length'> = {
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
  const spans = table === 'spans'
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
    if (spans) {
      const h = spanHour(file.key, file.day)
      if (first || h < (m.hourLo as number)) m.hourLo = h
      if (first || h > (m.hourHi as number)) m.hourHi = h
    }
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

/**
 * Table property naming the version of viz's conventions in this metadata
 * (contracts/COMPATIBILITY.md §5). Absent means 1: tables committed before the property existed.
 */
export const METADATA_FORMAT_PROPERTY = 'viz.format-version'
export const METADATA_FORMAT_VERSION = 1
/** Schema and partition-spec ids this code writes. A newer writer's evolution gets other ids. */
const KNOWN_SCHEMA_IDS = new Set([0])
const KNOWN_SPEC_IDS = new Set([0])

/**
 * Why this code must not commit over (or sweep against) `meta`, or null. A newer publisher
 * may have evolved the table (a column with a new field id, a new spec) or changed viz's
 * conventions; committing over it with this code's schema could drop what it added, and its
 * ids could later be handed out twice. Refusing stalls publication only: the publisher is
 * never upstream of ingest (D15).
 */
export function metadataProblem(meta: TableMetadata): string | null {
  if (meta['format-version'] !== 2) return `Iceberg format-version ${meta['format-version']}; this publisher writes 2`
  const raw = meta.properties?.[METADATA_FORMAT_PROPERTY]
  const v = raw === undefined ? 1 : Number(raw)
  if (!Number.isSafeInteger(v) || v < 1) return `unreadable ${METADATA_FORMAT_PROPERTY} ${JSON.stringify(raw)}`
  if (v > METADATA_FORMAT_VERSION) return `${METADATA_FORMAT_PROPERTY} ${v}; this publisher knows up to ${METADATA_FORMAT_VERSION}`
  if (!KNOWN_SCHEMA_IDS.has(meta['current-schema-id'])) return `current schema ${meta['current-schema-id']} was written by a newer publisher`
  if (!KNOWN_SPEC_IDS.has(meta['default-spec-id'])) return `partition spec ${meta['default-spec-id']} was written by a newer publisher`
  return null
}

/** The version of a cursors object (`{ v, table, cell, snapshotId, cursors }`); absent = 1. */
export const CURSORS_FORMAT_VERSION = 1

export function emptyMetadata(table: LedgerTable, location: string, cell: string, uuid: string, now: number): TableMetadata {
  const metric = isMetricTable(table)
  const sort = metric ? TABLE_DEFS[table].sort : SIGNAL_DEFS[table].sort
  return {
    'format-version': 2,
    'table-uuid': uuid,
    location,
    'last-sequence-number': 0,
    'last-updated-ms': now,
    'last-column-id': metric ? TABLE_DEFS[table].day.id : SIGNAL_DEFS[table].lastColumnId,
    'current-schema-id': 0,
    schemas: [icebergSchema(table)],
    'default-spec-id': 0,
    'partition-specs': [{ 'spec-id': 0, fields: partitionSpecFields(table) }],
    'last-partition-id': PARTITION_DAY_ID,
    'default-sort-order-id': SORT_ORDER_ID,
    'sort-orders': [
      { 'order-id': 0, fields: [] },
      { 'order-id': SORT_ORDER_ID, fields: sort.map((id) => ({ transform: 'identity', 'source-id': id, direction: 'asc', 'null-order': 'nulls-first' })) },
    ],
    properties: {
      'schema.name-mapping.default': JSON.stringify(metric ? nameMapping(table) : signalNameMapping(table)),
      'write.format.default': 'parquet',
      // viz is the only writer and deletes data files itself, after the ledger says so.
      'gc.enabled': 'false',
      'viz.cell': cell,
      'viz.table': table,
      [METADATA_FORMAT_PROPERTY]: String(METADATA_FORMAT_VERSION),
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
 * When `retained` would keep only the newest `max(2, minSnapshots)` snapshots of this
 * metadata: the newest of the others has then left the window, and so have all older ones
 * (snapshot timestamps grow with sequence numbers). Null if there is nothing to drop. One
 * expiry at this time drops everything that can go, in one commit.
 */
export function expiryDeadline(meta: TableMetadata, r: Retention): number | null {
  const byAge = [...meta.snapshots].sort((a, b) => a['sequence-number'] - b['sequence-number'])
  const keepFrom = byAge.length - Math.max(2, r.minSnapshots)
  if (keepFrom <= 0) return null
  return byAge[keepFrom - 1]!['timestamp-ms'] + r.snapshotWindowMs
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
