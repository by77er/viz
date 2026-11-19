import { columnsOf, type SchemaSpec } from '../../contracts/schema'

/**
 * The `Tenant` object's storage, versioned (contracts/COMPATIBILITY.md §2).
 *
 * Append a migration to change it; never edit one that has been released. Version 1 is the
 * schema exactly as the pre-versioning code created it (`test/fixtures/storage-v0.json` holds
 * that code's `sqlite_master`), written with IF NOT EXISTS so it also adopts such storage.
 * `test/golden/schema/v<N>.json` pins the result of every version; `test/compat.test.ts`
 * fails if the SQL of a released version changes.
 */
const V1 = `
CREATE TABLE IF NOT EXISTS tenant_meta (tenant TEXT NOT NULL, k TEXT NOT NULL, v TEXT NOT NULL, PRIMARY KEY (tenant, k));
CREATE TABLE IF NOT EXISTS keys (
  tenant TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, scopes TEXT NOT NULL,
  key_id TEXT NOT NULL, created_at INTEGER NOT NULL, created_by TEXT NOT NULL, expires_at INTEGER,
  disabled INTEGER NOT NULL DEFAULT 0, rotated_at INTEGER, last_used_at INTEGER,
  PRIMARY KEY (tenant, id));
CREATE UNIQUE INDEX IF NOT EXISTS keys_name ON keys (tenant, name);
CREATE TABLE IF NOT EXISTS key_secrets (
  tenant TEXT NOT NULL, key_id TEXT NOT NULL, key TEXT NOT NULL, secret_sha256 TEXT NOT NULL, valid_until INTEGER,
  PRIMARY KEY (tenant, key_id));
CREATE TABLE IF NOT EXISTS key_usage (
  tenant TEXT NOT NULL, key TEXT NOT NULL, hour INTEGER NOT NULL, samples INTEGER NOT NULL,
  PRIMARY KEY (tenant, key, hour));
CREATE TABLE IF NOT EXISTS dashboards (
  tenant TEXT NOT NULL, id TEXT NOT NULL, head INTEGER NOT NULL, revision TEXT NOT NULL,
  title TEXT NOT NULL, intent TEXT NOT NULL, tags TEXT NOT NULL, owner TEXT, panel_count INTEGER NOT NULL,
  created_at INTEGER NOT NULL, created_by TEXT NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL,
  deleted_at INTEGER, deleted_by TEXT, purge_at INTEGER,
  PRIMARY KEY (tenant, id));
CREATE TABLE IF NOT EXISTS revisions (
  tenant TEXT NOT NULL, dashboard TEXT NOT NULL, number INTEGER NOT NULL, revision TEXT NOT NULL,
  spec TEXT NOT NULL, bytes INTEGER NOT NULL, at INTEGER NOT NULL, by TEXT NOT NULL, message TEXT NOT NULL,
  kind TEXT NOT NULL, summary TEXT NOT NULL, proposal TEXT, proposed_by TEXT, reverted_to INTEGER,
  PRIMARY KEY (tenant, dashboard, number));
CREATE TABLE IF NOT EXISTS proposals (
  tenant TEXT NOT NULL, id TEXT NOT NULL, dashboard TEXT NOT NULL, base_revision TEXT NOT NULL, base_number INTEGER NOT NULL,
  message TEXT NOT NULL, changes TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, by TEXT NOT NULL,
  editors TEXT NOT NULL, expires_at INTEGER NOT NULL, resolved_at INTEGER, resolved_by TEXT, reason TEXT,
  applied_number INTEGER, applied_changes TEXT, bytes INTEGER NOT NULL,
  PRIMARY KEY (tenant, id));
CREATE INDEX IF NOT EXISTS proposals_open ON proposals (tenant, status, expires_at);
CREATE TABLE IF NOT EXISTS settings (
  tenant TEXT NOT NULL, section TEXT NOT NULL, version INTEGER NOT NULL, value TEXT NOT NULL,
  updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL,
  PRIMARY KEY (tenant, section));
CREATE TABLE IF NOT EXISTS audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, tenant TEXT NOT NULL, id TEXT NOT NULL UNIQUE, at INTEGER NOT NULL,
  subject TEXT NOT NULL, kind TEXT NOT NULL, name TEXT, action TEXT NOT NULL,
  target_type TEXT NOT NULL, target_id TEXT NOT NULL, before TEXT, after TEXT);
CREATE TABLE IF NOT EXISTS outbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, tenant TEXT NOT NULL, kv_key TEXT NOT NULL, value TEXT, expiration INTEGER,
  created_at INTEGER NOT NULL);
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT, 'the audit log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT, 'the audit log is append-only'); END;
`

/**
 * Version 2: a proposal may create a dashboard. Such a proposal is a row of `proposals`
 * with `base_number` 0, `base_revision` '', `changes` '[]', `dashboard` = the new id, and
 * the whole proposed spec in the new nullable column `spec` (NULL on every other row).
 *
 * Additive (`readableFrom: 1`, COMPATIBILITY.md §2.3): release 1 never reads or writes the
 * column, and every path of release 1 that meets such a row fails closed rather than acting
 * on it: list and decline treat it as a proposal with no changes; get, apply and edit answer
 * 404 (no dashboard of that id, or no revision 0 when one has appeared); expiry closes it.
 * An edit by release 1 (possible only once a dashboard of that id exists) rewrites the row
 * as an ordinary proposal with `base_number` ≥ 1, which this code then reads as one: a row
 * is a creation only while `base_number` is 0 AND `spec` is set. README, "Versioned storage".
 */
const V2 = 'ALTER TABLE proposals ADD COLUMN spec TEXT'

export const TENANT_SCHEMA: SchemaSpec = {
  component: 'control.Tenant',
  migrations: [
    { version: 1, name: 'the schema as it stood when versioning began', readableFrom: 1, up: (sql) => void sql.exec(V1) },
    {
      version: 2,
      name: 'proposals.spec: proposals that create a dashboard',
      readableFrom: 1,
      up: (sql) => {
        if (!columnsOf(sql, 'proposals').has('spec')) sql.exec(V2)
      },
    },
  ],
}

/**
 * Versions of everything this component writes that another release reads
 * (contracts/COMPATIBILITY.md §3). Bump one only together with a new fixture in
 * `test/golden/`; `test/golden.test.ts` fails if an encoding changes while its number stays.
 * The KV records are read by edge, shard routing, janitor and query, which do not check a
 * version yet; until they do, these records may only gain optional fields.
 */
export const FORMATS = {
  /** `key:<keyId>` → `{ tenant, secretSha256, scopes, disabled }` (edge's `KeyRecord`). */
  'kv.key': 1,
  /** `revocation:<tenant>` → `{ generation, revokedBefore }`. */
  'kv.revocation': 1,
  /** `retention:<tenant>`, `limits:<tenant>`: the setting's value as stored. */
  'kv.settings': 1,
  /** `pool:<tenant>` → `{ pool, slots, spread, epoch }` (shard's `PoolMap`). */
  'kv.pool': 1,
  /** The API key a person is given: `viz_<keyId 16>_<secret 40>`, base62. */
  'credential.api-key': 1,
  /** List cursors handed to clients (`next`): base64url of a JSON array. */
  'cursor.list': 1,
  /** A dashboard revision id (`revisionOf`, the ETag): content hash of the canonical spec. */
  'id.revision': 1,
} as const
