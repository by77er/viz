import type { SchemaSpec } from '../../contracts/schema'

/**
 * The publisher's storage, versioned (contracts/COMPATIBILITY.md §2). SQLite here is a cache
 * of what R2 holds plus the publisher's own bookkeeping; a release that cannot read it must
 * still not write it. Append a migration to change it; never edit a released one. Version 1
 * is the schema exactly as the pre-versioning code created it (`test/fixtures/storage/v0.json`).
 */
export const PUBLISHER_SCHEMA: SchemaSpec = {
  component: 'publisher.Publisher',
  migrations: [
    {
      version: 1,
      name: 'the schema as it stood when versioning began',
      readableFrom: 1,
      up: (sql) =>
        void sql.exec(`
CREATE TABLE IF NOT EXISTS config (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tbl (name TEXT PRIMARY KEY, version INTEGER NOT NULL, snapshot_id INTEGER, seq INTEGER NOT NULL, uuid TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cursor (tbl TEXT NOT NULL, tenant TEXT NOT NULL, incarnation INTEGER NOT NULL, version INTEGER NOT NULL, PRIMARY KEY (tbl, tenant));
CREATE TABLE IF NOT EXISTS live (
      tbl TEXT NOT NULL, key TEXT NOT NULL, tenant TEXT NOT NULL, day TEXT NOT NULL, rows INTEGER NOT NULL, bytes INTEGER NOT NULL,
      snapshot_id INTEGER NOT NULL, seq INTEGER NOT NULL, file_seq INTEGER NOT NULL, stats TEXT NOT NULL, manifest TEXT NOT NULL,
      PRIMARY KEY (tbl, key));
CREATE INDEX IF NOT EXISTS live_tenant ON live (tbl, tenant);
CREATE INDEX IF NOT EXISTS live_manifest ON live (tbl, manifest);
CREATE TABLE IF NOT EXISTS manifest (tbl TEXT NOT NULL, path TEXT NOT NULL, info TEXT NOT NULL, PRIMARY KEY (tbl, path));
CREATE TABLE IF NOT EXISTS snap (tbl TEXT NOT NULL, snapshot_id INTEGER NOT NULL, seq INTEGER NOT NULL, files TEXT NOT NULL, PRIMARY KEY (tbl, snapshot_id));
CREATE TABLE IF NOT EXISTS removed (tbl TEXT NOT NULL, tenant TEXT NOT NULL, key TEXT NOT NULL, removed_seq INTEGER NOT NULL, free_at INTEGER, PRIMARY KEY (tbl, key));
CREATE INDEX IF NOT EXISTS removed_tenant ON removed (tenant);
CREATE TABLE IF NOT EXISTS orphan (path TEXT PRIMARY KEY, since INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS pending (tenant TEXT PRIMARY KEY, since INTEGER NOT NULL);
`),
    },
    {
      // The deadlines the one alarm serves (design/DECISIONS.md D34): `publish`, `sweep`,
      // `expire:<table>`, each in the publisher's clock. Additive: a new table that release 1
      // neither reads nor needs. Release 1 on this storage publishes only from `notify` and
      // drops the other deadlines when it deletes its alarm; the next commit by a release that
      // knows the table sets them again. So release 1 stays a valid rollback target.
      version: 2,
      name: 'due: the deadlines of the alarm-driven jobs',
      readableFrom: 1,
      up: (sql) => void sql.exec(`CREATE TABLE IF NOT EXISTS due (job TEXT PRIMARY KEY, at INTEGER NOT NULL);`),
    },
    {
      // Scratch for state that must not be held in memory (D55). `stage`: what a re-base read (a
      // ledger checkpoint or base, streamed a part at a time), then the changes after it, which a
      // commit diffs against `live` in SQL. `live_next`: a table's files as R2 says, filled a
      // manifest at a time by a resync and swapped into `live` in one transaction. Both are
      // emptied by the operation that fills them, at its start and its end. Additive: releases
      // 1 and 2 neither read nor write them, so both stay rollback targets.
      version: 3,
      name: 'stage and live_next: re-base and resync in bounded memory',
      readableFrom: 1,
      up: (sql) =>
        void sql.exec(`
CREATE TABLE IF NOT EXISTS stage (
      tenant TEXT NOT NULL, tbl TEXT NOT NULL, tomb INTEGER NOT NULL, key TEXT NOT NULL,
      day TEXT NOT NULL, rows INTEGER NOT NULL, bytes INTEGER NOT NULL, min_ts INTEGER NOT NULL, max_ts INTEGER NOT NULL, idx TEXT NOT NULL,
      stats TEXT,
      PRIMARY KEY (tenant, tbl, tomb, key));
CREATE INDEX IF NOT EXISTS stage_order ON stage (tenant, tbl, tomb, day, key);
CREATE TABLE IF NOT EXISTS live_next (
      tbl TEXT NOT NULL, key TEXT NOT NULL, tenant TEXT NOT NULL, day TEXT NOT NULL, rows INTEGER NOT NULL, bytes INTEGER NOT NULL,
      snapshot_id INTEGER NOT NULL, seq INTEGER NOT NULL, file_seq INTEGER NOT NULL, stats TEXT NOT NULL, manifest TEXT NOT NULL,
      PRIMARY KEY (tbl, key));
`),
    },
    {
      // The tables this publisher reads and does not publish (`UNPUBLISHED_TABLES`: spans,
      // trace_index, logs; design/DECISIONS.md D64): per tenant and table, how far the ledger log
      // has been counted (`incarnation`, `version`), the live files counted at that point, where the
      // count started (`origin`: 'base', a re-base's base or checkpoint, exact; 'log', the first
      // change this publisher read that named the table), and when the table was first and last
      // named. Additive: releases 1 to 3 neither read nor write it (and stop a tenant whose log
      // names those tables), so each stays a rollback target of storage this release wrote.
      version: 4,
      name: 'unpublished: the ledger tables read and not published',
      readableFrom: 1,
      up: (sql) =>
        void sql.exec(`
CREATE TABLE IF NOT EXISTS unpublished (
      tbl TEXT NOT NULL, tenant TEXT NOT NULL, incarnation INTEGER NOT NULL, version INTEGER NOT NULL,
      files INTEGER NOT NULL, origin TEXT NOT NULL, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL,
      PRIMARY KEY (tbl, tenant));
`),
    },
  ],
}

/**
 * Versions of what the publisher writes that another release (or another engine) reads, and
 * of what it reads from others (contracts/COMPATIBILITY.md §3, §5). Bump one only together
 * with a new file in `test/golden/formats/`.
 */
export const FORMATS = {
  /**
   * viz's conventions inside Iceberg `metadata.json` (table property `viz.format-version`;
   * absent = 1): the schemas and field ids of `TABLE_DEFS`, the partition spec, sort order,
   * name mapping and the `viz.ledger-cursors` summary key. A publisher refuses to commit
   * over metadata with a higher number, or with a schema or spec id it does not know.
   */
  'iceberg.metadata': 1,
  /** The Avro schemas of manifests and manifest lists (Iceberg v2, with their field ids). */
  'iceberg.manifest': 1,
  /**
   * The same conventions for the span and log tables (`SIGNAL_DEFS`, design/DECISIONS.md D65): their
   * `metadata.json` when new (schemas with nested types and every nested field id, partition specs,
   * `hour(start_time)` for `spans`, sort orders, nested name mapping, properties; `viz.format-version`
   * 1, as the metric tables). Added beside `iceberg.metadata`, which keeps pinning the metric
   * tables byte for byte.
   */
  'iceberg.signal-metadata': 1,
  /** The Avro schema of a `spans` manifest (partition `{tenant, start_time_hour}`); `trace_index` and `logs` manifests use `iceberg.manifest`'s. */
  'iceberg.signal-manifest': 1,
  /** `cursors-<snapshot>-<tag>.json`: `{ v, table, cell, snapshotId, cursors }` (absent `v` = 1). */
  'r2.cursors': 1,
  /** The ledger change log as the publisher READS it (`LedgerChange`, absent `v` = 1, the known kinds). */
  'read.ledger-change': 1,
  /**
   * The ledger's segment log as the publisher READS it (contracts/LEDGER-LOG.md: segment header
   * `v` 1, kind `viz.ledger.segment`, base-first). Pinned by `test/fixtures/ledger-log/`, real
   * segment bytes written by the ledger, and by `test/golden/formats/read.ledger-segment.v1.json`.
   */
  'read.ledger-segment': 1,
  /**
   * The ledger's checkpoints as the publisher READS them for a re-base (contracts/LEDGER-LOG.md,
   * "Checkpoints": format 1, one object; format 2, a manifest and parts). Pinned by
   * `test/golden/formats/read.ledger-checkpoint.v2.json`, a real log with a checkpoint in parts
   * written by the ledger. Format 1 is pinned by `read.ledger-segment.v1.json`, which holds one.
   */
  'read.ledger-checkpoint': 2,
} as const
