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
    {
      // The alarm's bookkeeping of the span and log tables, kept apart from the metric tables'
      // (design/DECISIONS.md D67): their expiry deadlines (`expire:spans`, `expire:trace_index`,
      // `expire:logs`) and the sightings of their unreferenced metadata objects. The D64 release, the
      // oldest a rollback may reach once `INGEST_SIGNALS` is on, re-arms its alarm at the earliest row
      // of `due` and its sweep at the oldest row of `orphan`, and acts only on the metric tables: a
      // row of these tables there would bring its alarm back at once, for ever (a sweep, R2 lists
      // included, on every wake). Here it never sees them. Additive: releases 1 to 4 neither read nor
      // write these tables, so each stays a rollback target.
      version: 5,
      name: 'signal_due and signal_orphan: the alarm bookkeeping of the span and log tables',
      readableFrom: 1,
      up: (sql) =>
        void sql.exec(`
CREATE TABLE IF NOT EXISTS signal_due (job TEXT PRIMARY KEY, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS signal_orphan (path TEXT PRIMARY KEY, since INTEGER NOT NULL);
`),
    },
    {
      // When a re-base of each tenant still waiting for one last started (the publisher's clock), so
      // that a publish, which starts only a few (review M-6, design/DECISIONS.md D67), takes them
      // least recently started first: a re-base that keeps failing, or that is cut off with its
      // invocation (written before it reads anything), goes to the back instead of holding every
      // other tenant's up. A row is deleted once its tenant is published. Additive: releases 1 to 5
      // neither read nor write it (the D64 release, a rollback target, re-bases every tenant at once
      // as before), so each stays a rollback target.
      version: 6,
      name: 'rebase: when each waiting re-base last started',
      readableFrom: 1,
      up: (sql) => void sql.exec(`CREATE TABLE IF NOT EXISTS rebase (tenant TEXT PRIMARY KEY, started INTEGER NOT NULL);`),
    },
    {
      // Re-bases and rebuilds kept across invocations (design/DECISIONS.md D55, D67; README, "Re-bases
      // and rebuilds in steps"), so that a tenant or a table too large for one invocation's CPU still
      // finishes. `rebase_stage`: what a re-base read, as `stage` held it; a new table because the
      // releases before this one empty `stage` at every attempt, and a rollback to one of them must not
      // leave a kept re-base with part of its rows gone. `rebase_step`: per tenant whose re-base spans
      // invocations, the checkpoint it reads and how far (parts staged, running totals, last keys, in the
      // same transaction as the rows), the tables it re-bases with their cursors when it began, then the
      // version its stage was carried to, the snapshot id its commit will have and how far each table's
      // added files are written into manifests ahead of that commit (`rebase_manifest`, which the sweep
      // treats as referenced). `rebuild`, `rebuild_manifest`: a table rebuilt from R2 after a lost
      // storage, a manifest at a time, with the manifests of the version being rebuilt and which are in.
      // Additive: releases 1 to 6 neither read nor write these tables. The release before this one (and
      // D64, the rollback floor) re-bases and rebuilds whole as before and leaves these rows alone;
      // rolled forward, this release continues them, or drops them when they no longer apply.
      version: 7,
      name: 'rebase_stage, rebase_step, rebase_manifest, rebuild, rebuild_manifest: re-bases and rebuilds in steps',
      readableFrom: 1,
      up: (sql) =>
        void sql.exec(`
CREATE TABLE IF NOT EXISTS rebase_stage (
      tenant TEXT NOT NULL, tbl TEXT NOT NULL, tomb INTEGER NOT NULL, key TEXT NOT NULL,
      day TEXT NOT NULL, rows INTEGER NOT NULL, bytes INTEGER NOT NULL, min_ts INTEGER NOT NULL, max_ts INTEGER NOT NULL, idx TEXT NOT NULL,
      stats TEXT,
      PRIMARY KEY (tenant, tbl, tomb, key));
CREATE INDEX IF NOT EXISTS rebase_stage_order ON rebase_stage (tenant, tbl, tomb, day, key);
CREATE TABLE IF NOT EXISTS rebase_step (
      tenant TEXT PRIMARY KEY, incarnation INTEGER NOT NULL, source TEXT NOT NULL, version INTEGER NOT NULL, object TEXT NOT NULL, attempt TEXT NOT NULL,
      parts INTEGER NOT NULL, done INTEGER NOT NULL, files INTEGER NOT NULL, tombstones INTEGER NOT NULL, bytes INTEGER NOT NULL,
      last_file TEXT, last_tomb TEXT, tables TEXT NOT NULL,
      target INTEGER, status TEXT, detail TEXT, gap_at INTEGER, snapshot_id INTEGER, written TEXT NOT NULL, moved INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS rebase_manifest (
      tenant TEXT NOT NULL, tbl TEXT NOT NULL, path TEXT NOT NULL, info TEXT NOT NULL,
      lo_day TEXT NOT NULL, lo_key TEXT NOT NULL, hi_day TEXT NOT NULL, hi_key TEXT NOT NULL,
      PRIMARY KEY (tenant, tbl, path));
CREATE TABLE IF NOT EXISTS rebuild (tbl TEXT PRIMARY KEY, version INTEGER NOT NULL, moved INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS rebuild_manifest (tbl TEXT NOT NULL, ord INTEGER NOT NULL, path TEXT NOT NULL, info TEXT NOT NULL, done INTEGER NOT NULL, PRIMARY KEY (tbl, path));
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
   * The same conventions for the span and log tables (`SIGNAL_DEFS`, design/DECISIONS.md D67): their
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
