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
    {
      // Anomaly rules (contracts/rules.ts, contract version 2). Additive: a new table, which the
      // previous release neither reads nor needs, so it stays a valid rollback target
      // (COMPATIBILITY.md §2.3). The rules themselves live in `rule_group.spec.anomalyRules`, a new
      // optional JSON field the previous release ignores (README, "Rollback").
      // One row per (rule, chunk): a batch of series' detector state (`anomaly.ts` `stateRows`,
      // format `store.anomaly-state`), never a row per series or per sample.
      version: 2,
      name: 'anomaly rules: per-(rule, chunk) detector state',
      readableFrom: 1,
      up: (sql) =>
        void sql.exec(`
CREATE TABLE IF NOT EXISTS anomaly_state (tenant TEXT NOT NULL, grp TEXT NOT NULL, rule_key TEXT NOT NULL, chunk INTEGER NOT NULL, body TEXT NOT NULL,
  PRIMARY KEY (tenant, grp, rule_key, chunk)) WITHOUT ROWID;
`),
    },
    {
      // SLO burn-rate rules and warming from history (contracts/rules.ts, contract version 4).
      // Additive: two new tables, which earlier releases neither read nor need, so they stay valid
      // rollback targets (COMPATIBILITY.md §2.3; `compat` stays 1, as migration 2 left it). The
      // rules live in `rule_group.spec.sloRules`, a new optional JSON field earlier releases ignore.
      //   slo_state  one row per (rule, part, block): the head (slot counters, each series' labels and
      //              last outcome) and blocks of buckets for every series of the rule (`slo.ts`, format
      //              `store.slo-state`); never a row per series or per bucket
      //   warmup     one row per anomaly or SLO rule: how warming it from history went (format
      //              `store.warmup`), so a retried alarm does not read it again
      version: 3,
      name: 'SLO rules: per-(rule, part, block) bucket state; warm-up status per rule',
      readableFrom: 1,
      up: (sql) =>
        void sql.exec(`
CREATE TABLE IF NOT EXISTS slo_state (tenant TEXT NOT NULL, grp TEXT NOT NULL, rule_key TEXT NOT NULL, part TEXT NOT NULL, block INTEGER NOT NULL, body TEXT NOT NULL,
  PRIMARY KEY (tenant, grp, rule_key, part, block)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS warmup (tenant TEXT NOT NULL, grp TEXT NOT NULL, rule_key TEXT NOT NULL, body TEXT NOT NULL,
  PRIMARY KEY (tenant, grp, rule_key)) WITHOUT ROWID;
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
 * The versions of `store.anomaly-state` this release reads: version 1, and version 2, which the
 * release after it writes, so that this release is a rollback target for that one
 * (contracts/COMPATIBILITY.md §3.3, readers first).
 */
export const ANOMALY_STATE_READS = [1, 2] as const

/**
 * The version gate of `store.anomaly-state` (COMPATIBILITY.md §3.3, design D60): the version this
 * release WRITES for robust z and seasonal rules. **1 in this release**: it reads versions 1 and 2
 * and writes 1 (rows of version 2 are rewritten as 1 at their next tick). Set it to 2 in the release
 * after one with this reader has been deployed to production: that release writes the ring blocks
 * (rows of version 1 are rewritten as 2 at their next tick), and its save-time estimates, and so the
 * series caps, follow (`estimateStateBytes`). EWMA, threshold and CUSUM are written as 1 either way.
 */
export const ANOMALY_STATE_WRITE: 1 | 2 = 1

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
  /** The plain webhook body (`format: json`, `viz.notification/v1`; contracts/rules.ts version 3) and its signature. */
  'http.webhook-json': 1,
  /** The rule-file export (Prometheus' YAML, plus viz's fields when asked). */
  'file.rules-yaml': 1,
  /**
   * Anomaly rules: a rule as stored in `rule_group.spec.anomalyRules` and exported, its key, and
   * the series key of its state (contract version 2).
   */
  'store.anomaly-rule': 1,
  /**
   * `anomaly_state.body`, the version written: the gate `ANOMALY_STATE_WRITE` (1 in this release).
   * Version 1: batches of series' detector state (`{"v":1,"series":[...]}`). Version 2
   * (`anomalystore.ts`): robust z's and seasonal's windows as Float64 ring blocks and a head, read by
   * this release (`ANOMALY_STATE_READS`) and written by the next; its golden file is checked in.
   */
  'store.anomaly-state': ANOMALY_STATE_WRITE,
  /** The `anomaly_detail` annotation an anomaly alert carries to the notifier and receivers (`AnomalyDetail`, `v: 1`). */
  'annotation.anomaly-detail': 1,
  /** SLO rules (contract version 4): a rule as stored in `rule_group.spec.sloRules` and exported, its key, and its per-tick expression. */
  'store.slo-rule': 1,
  /** `slo_state.body`: the head row and the bucket blocks (`{"v":1,...}`). */
  'store.slo-state': 1,
  /** The `slo_detail` annotation an SLO alert carries (`SloDetail`, `v: 1`). */
  'annotation.slo-detail': 1,
  /** `warmup.body`: a rule's `WarmupStatus` as stored (`{"v":1,...}`). */
  'store.warmup': 1,
} as const
