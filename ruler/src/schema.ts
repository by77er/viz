import type { SchemaSpec } from '../../contracts/schema'

/**
 * The storage of the three Durable Object classes, versioned (contracts/COMPATIBILITY.md §2).
 *
 * Append a migration to change one; never edit a released one. Version 1 of each is the
 * schema exactly as the pre-versioning constructors created it (their `sqlite_master` is in
 * `test/fixtures/storage/v0.json`), written with IF NOT EXISTS so it adopts such storage.
 * `test/golden/schema/<class>.v<N>.json` pins every version.
 *
 * The JSON stored in `body`, `spec`, `updates` and `v` columns is part of each schema: its
 * shape changes under the same rules (§2.2, §2.3).
 */

export const RULER_SCHEMA: SchemaSpec = {
  component: 'ruler.Ruler',
  migrations: [
    {
      version: 1,
      name: 'the schema as it stood when versioning began',
      readableFrom: 1,
      up: (sql) =>
        void sql.exec(`
CREATE TABLE IF NOT EXISTS self (one INTEGER PRIMARY KEY CHECK (one = 1), name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS meta (tenant TEXT NOT NULL, k TEXT NOT NULL, v TEXT NOT NULL, PRIMARY KEY (tenant, k)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS rule_group (tenant TEXT NOT NULL, name TEXT NOT NULL, spec TEXT NOT NULL, not_before INTEGER NOT NULL,
  PRIMARY KEY (tenant, name)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS alert (tenant TEXT NOT NULL, grp TEXT NOT NULL, rule_key TEXT NOT NULL, fp TEXT NOT NULL, body TEXT NOT NULL,
  PRIMARY KEY (tenant, grp, rule_key, fp)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS handoff (tenant TEXT NOT NULL, seq INTEGER NOT NULL, created_at INTEGER NOT NULL, updates TEXT NOT NULL,
  PRIMARY KEY (tenant, seq)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS timeline (tenant TEXT NOT NULL, monitor TEXT NOT NULL, body TEXT NOT NULL,
  PRIMARY KEY (tenant, monitor)) WITHOUT ROWID;
`),
    },
  ],
}

export const NOTIFIER_SCHEMA: SchemaSpec = {
  component: 'ruler.Notifier',
  migrations: [
    {
      version: 1,
      name: 'the schema as it stood when versioning began',
      readableFrom: 1,
      up: (sql) =>
        void sql.exec(`
CREATE TABLE IF NOT EXISTS self (one INTEGER PRIMARY KEY CHECK (one = 1), name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS meta (tenant TEXT NOT NULL, k TEXT NOT NULL, v TEXT NOT NULL, PRIMARY KEY (tenant, k)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS alert (tenant TEXT NOT NULL, fp TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (tenant, fp)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS silence (tenant TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (tenant, id)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS agg_group (tenant TEXT NOT NULL, gkey TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (tenant, gkey)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS outbox (tenant TEXT NOT NULL, id INTEGER NOT NULL, gkey TEXT NOT NULL, receiver TEXT NOT NULL,
  integration TEXT NOT NULL, url TEXT NOT NULL, idem_key TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL,
  created_at INTEGER NOT NULL, next_attempt_at INTEGER NOT NULL, last_error TEXT, subjects TEXT, PRIMARY KEY (tenant, id)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS notify_log (tenant TEXT NOT NULL, monitor TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (tenant, monitor)) WITHOUT ROWID;
`),
    },
  ],
}

export const INDEX_SCHEMA: SchemaSpec = {
  component: 'ruler.RulerIndex',
  migrations: [
    {
      version: 1,
      name: 'the schema as it stood when versioning began',
      readableFrom: 1,
      up: (sql) =>
        void sql.exec(`
CREATE TABLE IF NOT EXISTS ruler (tenant TEXT NOT NULL, shard TEXT NOT NULL, registered_at INTEGER NOT NULL, PRIMARY KEY (tenant, shard)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS tenant_shards (tenant TEXT NOT NULL PRIMARY KEY, shards INTEGER NOT NULL) WITHOUT ROWID;
`),
    },
  ],
}

/**
 * Versions of what this component writes that another release reads (contracts/COMPATIBILITY.md
 * §3). Bump one only together with a new file in `test/golden/formats/`.
 */
export const FORMATS = {
  /** Ruler → Notifier `ingest(tenant, source, AlertUpdate[])`, and the `handoff.updates` rows that hold them. */
  'rpc.alert-update': 1,
  /** Alert fingerprints, rule keys, group offsets, monitor and bare-rule ids: hashes that name stored state. */
  'id.hashes': 1,
  /** `Idempotency-Key` of a notification: a receiver de-duplicates on it across releases. */
  'id.idempotency-key': 1,
  /** Which `index/<k>` holds a tenant, and which shard a group is placed on. */
  'id.placement': 1,
  /** The webhook body (Alertmanager's version "4") and `X-Viz-Signature: t=…,v1=…`. */
  'http.webhook': 1,
  /** The rule-file export (Prometheus' YAML, plus viz's fields when asked). */
  'file.rules-yaml': 1,
} as const
