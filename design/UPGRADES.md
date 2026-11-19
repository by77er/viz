# Updating viz in place

Status: 2026-11-18. The contract is `contracts/COMPATIBILITY.md`; the shared migration runner
is `contracts/schema.ts`; the decision is D24. The deploy mechanics (upload every Worker,
promote callees first, release records, rollback, the upgrade-under-load trial) are the
release engineer's, in `deploy/` and `.github/workflows/`. This file is the data and
protocol side they depend on: what is persisted or sent where, what the platform does during
a deploy, how a release moves, what may be rolled back, and what each component still has to
change.

Every push to `main` deploys production. So for minutes on every deploy, and for as long as
a rollback lasts, two releases of every component run against the same storage and the same
messages. Nothing in viz recorded a schema or format version before this work: Durable
Objects created their tables with `CREATE TABLE IF NOT EXISTS` (a release that adds a
column never reaches an existing object, and an older release opening newer storage would
not notice), and no reader defined what to do with a format it had not seen.

## 1. Summary

- **Storage.** Every Durable Object class keeps `viz_schema` = `{component, version, compat}`
  and opens its storage with `openSchema` in the constructor, inside
  `blockConcurrencyWhile`: missing migrations run in one `transactionSync`; storage newer
  than the code is opened only if its `compat` says this code may read it, else every entry
  point refuses with `schema_too_new` (RPC status, `SchemaTooNewError`, or HTTP 503 +
  `Retry-After`) and nothing is written but the alarm, which is re-armed.
- **Formats.** Everything that crosses a release boundary carries a version; readers ignore
  unknown optional fields and refuse unknown versions and kinds (a queue retries, a log
  reader stops, never skips). A new format version is written only once every release that
  can still run reads it: two releases per format change, readers first.
- **Rollback.** A release is forward-only for a class when a migration in it has
  `readableFrom` equal to its own version; `canOpen(target.latest, {version, compat})` is the
  whole test. Additive changes keep the previous release a valid rollback target.
- **Implemented** in `control/` (Tenant), `ruler/` (Ruler, Notifier, RulerIndex) and
  `publisher/` (Publisher, plus its R2 formats and its reading of the ledger log), with
  migration, refusal and golden-format tests and 26 mutants, all killed (§8).
- **Implemented on the write path** (2026-11-19) in `ledger/` (Ledger, its log formats and
  their readers), `shard/` (Shard, the series-window format, the flush message) and `edge/`
  (unknown shard statuses, versioned KV records): §7 items 1, 3 and 4, §8.
- **Not yet, or only in part,** in query, flush, janitor, compact: §7 lists what each must do,
  in priority order.

## 2. What the platform does (verified 2026-11-18)

Read on developers.cloudflare.com on 2026-11-18. "Measured" means in local workerd here;
"not documented" means the docs were searched and say nothing, so viz assumes the worst.

| # | Fact | Source |
|---|---|---|
| F1 | Two Workers joined by a service binding "may be at different points in their own gradual deployment". Version overrides "only apply to `fetch()`-based service binding calls"; "there is currently no way to specify version overrides when calling a service binding via RPC" | [Gradual deployments](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/gradual-deployments/), [Version overrides](https://developers.cloudflare.com/workers/versions-and-deployments/version-overrides/) |
| F2 | Only one version of a Durable Object runs at a time. In a gradual deployment each object is assigned a version by the percentages; "This version will not change until you create a new deployment"; "For a given deployment, requests to each Durable Object will always use the same Worker version"; an object "will only be reset when it is assigned a different version" | [With Durable Objects](https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/with-durable-objects/) |
| F3 | A rollback "will immediately create a new deployment with the specified version", so an object that ran N+1 can be assigned N again, on the storage N+1 wrote. Rollbacks reach "the 100 most recently published versions"; "Resources connected to your Worker will not be changed during a rollback"; "Errors could occur if using code for a prior version if the structure of data has changed" | [Rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/), [wrangler commands](https://developers.cloudflare.com/workers/wrangler/commands/workers/) |
| F4 | Code updates are **deferred** by default (changelog 2026-10-30): an active object "can continue serving requests, storage operations, and Hibernation API WebSockets on its current code" until it hibernates or `max_delay` passes (default 300 s, at most 86,400 s); "Deferral is best effort". The deployment itself "completes immediately". `deploy/workers.json` sets `deferred 30s` | [Changelog](https://developers.cloudflare.com/changelog/post/2026-10-30-durable-objects-deferred-code-updates/), [Lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/), [Code updates](https://developers.cloudflare.com/durable-objects/deployments/durable-objects-code-updates/) |
| F5 | In-flight requests "are allowed to finish if they do not access a Durable Object's storage"; one that does "will be stopped immediately". The first request or event, "like an alarm", runs the constructor of the new instance | [Lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/) |
| F6 | Class lifecycle changes (new, renamed, deleted, transferred classes; `exports` or the legacy `migrations` array): versions that contain one "cannot be uploaded" (apply with `wrangler deploy`); they should not be rolled out gradually; "Once a lifecycle change is deployed, rollbacks cannot take place to any version prior to the one that included the change". Rollback is also blocked when a bound R2 bucket, KV namespace or queue no longer exists | [With Durable Objects](https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/with-durable-objects/), [Rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/) |
| F7 | `blockConcurrencyWhile` blocks every other event until the callback completes; it has a 30 s timeout after which the object is reset; "If the callback throws an exception, the object will be terminated and reset"; the docs recommend it in the constructor "to run schema migrations" | [State API](https://developers.cloudflare.com/durable-objects/api/state/) |
| F8 | `sql.exec()` "cannot execute transaction-related statements like `BEGIN TRANSACTION` or `SAVEPOINT`"; `transactionSync` rolls back if the callback throws. **Measured**: `PRAGMA user_version` (read or write) fails with `SQLITE_AUTH`; `PRAGMA table_info` and `sqlite_master` work; DDL inside `transactionSync` rolls back with it; `sqlite_master` stores the CREATE text without `IF NOT EXISTS` | [SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/); measured in `control/` tests |
| F9 | Alarms: "guaranteed at-least-once execution", retried when `alarm()` throws, "exponential backoff starting at a 2 second delay … up to 6 retries"; `setAlarm` may be called inside `alarm()` | [Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/) |
| F10 | Queues: content type `json` is the default; when a consumer throws "the entire batch will be considered a failure and will be retried"; "Without a DLQ configured, messages that reach the retry limit are deleted permanently"; default retries 3 | [JavaScript APIs](https://developers.cloudflare.com/queues/configuration/javascript-apis/), [Dead letter queues](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/) |
| F11 | Storage state "such as KV, R2, Durable Objects, and D1" is not tracked with versions. Routes, domains and Cron Triggers are applied by `wrangler triggers deploy`, outside a version | [Versions & deployments](https://developers.cloudflare.com/workers/versions-and-deployments/), [wrangler commands](https://developers.cloudflare.com/workers/wrangler/commands/workers/) |
| U1 | **Not documented**: which version a queue consumer or a Cron Trigger runs during a gradual deployment, and whether producers and consumers may differ. Assumed: either, independently | searched; nothing found |
| U2 | **Not documented**: whether an alarm handler that is running when a deployment changes is interrupted and re-run on the new code. Assumed: an alarm can run on the old code until the object adopts the new one (F4), and may run twice (F9) | searched; nothing found |
| U3 | **Not documented**: what a caller sees, exactly, when an object resets for a code update mid-request (the troubleshooting page names the message "Durable Object reset because its code was updated"). The release engineer's trial measures it | [Troubleshooting](https://developers.cloudflare.com/durable-objects/observability/troubleshooting/) |
| U4 | **Training knowledge, not checked**: Durable Object global uniqueness means no two instances of one object write storage at once, including across a code update | — |

What follows from them: callers and callees skew in both directions (F1, F4), an object goes
back to older code after a rollback (F3), "promoted" does not mean "running" (F4), and only
class lifecycle changes are fenced by the platform (F6). Everything else is viz's to fence.

## 3. Inventory: every persisted and wire format (write path as of `dc2a1c3`)

"Older reader" means the reader is one release behind the writer (the writer was promoted
first, or a rollback put the reader back); "newer reader" the opposite. Status column:
**versioned** = carries a version and its readers act on it (this work or before);
**none** = no version anywhere.

### 3.1 Durable Object storage (SQLite)

| Class (script) | Defined in | Version | Writer = reader | Older code on newer storage | Newer code on older storage |
|---|---|---|---|---|---|
| `Shard` (viz-ingest) | `shard/src/shard.ts` constructor: `config`, `stream`, `batch` (payload = `VZB1` BLOB), `segment`, `notify`, `series_window` (sketch BLOB) | none | the shard | ignores new columns; misreads a new sketch kind (byte 0 other than 1 is read as an exact id list), so the series limit would be wrong; no check at all | `segment.sealed_at` already shows the gap: added to `CREATE TABLE IF NOT EXISTS`, so a shard created before it has no such column and every statement naming it fails (`shard/README.md`, "A schema migration") |
| `Ledger` (viz-ingest) | `ledger/src/ledger.ts` `schema()`: `meta` (incarnation, version), `file` (incl. `prec`, `prec_lo`), `stream`, `outbox` (body = `LedgerChange` JSON), `tombstone` | none | the ledger | **dangerous**: `init()` treats "no `meta.incarnation`" as new or lost storage and rebuilds from R2 into a NEW incarnation; a newer layout of `meta` read by older code would re-base every reader and the publisher | an object created before D22 lacks `prec`/`prec_lo`; `IF NOT EXISTS` never adds them, and `plan` fails |
| `Tenant` (viz-control) | `control/src/schema.ts` | **versioned** (v1) | Tenant | refused unless `compat` allows | migrated in the constructor |
| `Ruler`, `Notifier`, `RulerIndex` (viz-ruler, not deployed) | `ruler/src/schema.ts`; stored JSON: `rule_group.spec`, `alert.body`, `handoff.updates` (`AlertUpdate[]`), `timeline.body`, `meta.v` (config, cursor), notifier bodies | **versioned** (v1 each) | the objects | refused unless `compat` allows | migrated |
| `Publisher` (viz-publisher, deployed first since 2026-11-19) | `publisher/src/schema.ts` | **versioned** (v2; v2 adds the `due` table, additive) | the publisher | refused unless `compat` allows | migrated |
| `Leaf` (viz-query) | `query/src/leaf.ts` | stateless: no storage | — | — | — |
| janitor, compact, flush | functions in viz-ingest | no Durable Object | — | — | — |

### 3.2 R2 objects (bucket `viz-lake`, under `{cell}/`)

| Object | Defined in | Version | Writer | Readers | Older reader of newer | Newer reader of older |
|---|---|---|---|---|---|---|
| Data files `data/{table}/tenant=/day=/L{level}-….parquet` | `contracts/TABLES.md`, `engine/storage` | none in the file (`created_by: viz-storage`, no key-value metadata, no field ids) | flush (L0), compact (L1, L2) | query leaves (engine), compact (engine), external engines via Iceberg | a new or changed column is invisible or misread; nothing in the file says what it is | must read every layout still live, for the whole retention (files are immutable) |
| Index fragment `FileEntry.index` (in ledger rows and log) | `engine/storage/src/pq.rs` `FileIndex` | **versioned** `{"v":1,…}`; the engine refuses another `v` | flush, compact (engine) | engine; publisher (stats) | engine refuses; publisher leaves the stats out | reads v1 |
| Ledger change log `ledger/tenant=/{inc}/{version:012}.json`, `base.json` | `contracts/ledger.ts` `LedgerChange`, `ledgerLogKey` | none | ledger (outbox drain) | ledger `rebuildFromLog`, publisher | rebuild applies an unknown `kind` as a plain add/remove; the publisher now refuses it (this work) | tolerates absent `precedence` (derives it): an example of expand done right |
| **Changing now**: log segments `seg-{first:012}-{last:012}.jsonl`, checkpoints `ckpt-…jsonl` | `contracts/LEDGER-LOG.md`, codec in `contracts/ledger.ts` (contract written by the ledger builder after COMPATIBILITY.md; `ledger/src` not yet switched at the time of writing) | **versioned**: header `v` and `kind`, `v` per change line (absent = 1); `removedFiles` added beside `removed`, not in place of it | ledger | rebuild, publisher | readers refuse an unknown `v` or `kind` and stop there. The ledger reads both layouts and writes segments in one release, accepted as forward-only because no ledger had reached production (LEDGER-LOG.md "Rollout"); a deployment that ran the first layout cannot roll back below it (stuck, not lost) | the publisher reads segments (base-first, whole segments, refusing an unknown header `v`/`kind` or change `v`/`kind`/table) and still reads the first layout (`publisher/README.md`, "Reading the log") |
| Iceberg `iceberg/{table}/metadata/v{N}.metadata.json`, `version-hint.text` | `publisher/src/iceberg.ts` | Iceberg format-version 2; **versioned** viz conventions: property `viz.format-version` (absent = 1) (this work) | publisher | publisher (resync), external engines | the publisher now refuses to commit, rebuild or sweep over newer metadata (this work) | reads it |
| Manifests, manifest lists (Avro) | `publisher/src/iceberg.ts`, Iceberg v2 field ids | Iceberg's | publisher | publisher, external engines | — | — |
| `cursors-{snapshot}-{tag}.json` | `publisher/src/publisher.ts` | **versioned** `v: 1` (absent = 1) (this work) | publisher | publisher (resync) | refused (this work) | reads it |
| Dead letters `dead-letters/{queue}/{iso}-{id}.json` | `flush/src/consumer.ts` `DeadLetter` | none | flush and maintenance consumers | operators (`listDeadLetters`) | operator tooling only | — |

### 3.3 Queue messages (`stack/wrangler.jsonc`; content type `json`)

| Queue | Body | Version | Producer | Consumer | Older consumer of newer message | Newer consumer of older |
|---|---|---|---|---|---|---|
| `viz-flush` | `FlushMessage {tenant, shard}` (`shard/src/shard.ts`) | none | Shard (outbox, alarm) | `consumeFlushBatch` | unknown fields ignored; a renamed or missing field is "not a {tenant, shard} message": **dead-lettered and acknowledged**, recovered only by the hourly sweep of KV markers | fine |
| `viz-maint` | `MaintMessage {tenant, wrote?}` (`stack/src/maintain.ts`) | none | flush `onFlushed`, cron `enqueueDue` | `consumeMaintBatch` | same: dead-lettered; the tenant's KV marker brings it back at its `due` | fine |
| `viz-flush-dlq`, `viz-maint-dlq` | any | — | the platform | `consumeDeadLetters` (writes R2, acks) | records whatever arrives | — |

### 3.4 RPC between Workers and objects (no version on any of them)

| Interface | Defined in | Caller → callee (scripts) | Skew in practice | What breaks |
|---|---|---|---|---|
| `Shard.append(AppendRequest)` → `AppendResult`; payload `VZB1` | `shard/src/shard.ts`, `contracts/BATCH.md` | edge → Shard (viz-ingest → viz-ingest) | yes: one script, but the shard object adopts new code up to 30 s later (F4) | `VZB1` has magic and strict decoders (good); a status the edge does not know must never be counted as stored (I7) |
| `Shard.tailRead` → `TailResult` | same | query → Shard (viz-query → viz-ingest, `script_name`) | yes (F1) | query treats any status but `ok`/`stale_watermark` as `incarnation_mismatch`: fails closed today by accident, and loops |
| `Ledger.plan/addUnit/registerStream/replace/expire/…` | `contracts/ledger.ts` | flush, compact, janitor (viz-ingest); query (viz-query) | yes | unions without a version; unknown statuses are not handled explicitly |
| `Flush.flushTenant` | `flush/src/index.ts` | queue consumer (same script) | deferral only | — |
| `Leaf.read(items, ttl)` → `LeafAnswer` | `query/src/leaf.ts` | coordinator → Leaf (same script) | yes: Worker on N+1, leaf object on N for up to 30 s | a union with `refused`; additive changes only |
| Ruler → `Notifier.ingest(AlertUpdate[])`; ruler → `RulerIndex` | `contracts/rules.ts`, `ruler/contracts-proposal/rules.v2.ts` | within viz-ruler | deferral | **versioned** answers now: `Refused` = `wrong_tenant` or `schema_too_new`; pinned by golden `rpc.alert-update` |
| `Tenant.provision/resolveKey/recordUsage/invoke` | `control/src/tenant.ts` | control Worker; gateway calls `provision` (`script_name` viz-control) | yes | `resolveKey` and `recordUsage` may now answer `schema_too_new`; `provision` throws it |
| Engine JS face | `contracts/engine.ts` | compiled into each script | none within a script; across scripts the *data* it reads (Parquet, `VZB1`) crosses releases | see §3.2 |
| mcp → viz-query, viz-control, viz-ruler; gateway → viz-ingest, viz-query, viz-control | service bindings, `fetch` | yes (F1); overrides work for `fetch` | HTTP contracts below |

### 3.5 KV records (namespace `viz-config`, binding `CONFIG`)

| Key | Shape | Version | Writer | Readers | Older reader of newer | 
|---|---|---|---|---|---|
| `key:<keyId>` | `{tenant, secretSha256, scopes, disabled}` | none (golden-pinned in control) | control (outbox) | edge `authenticate` (used by edge, control, ruler, mcp) | unknown fields ignored; a changed meaning would authenticate wrongly |
| `revocation:<tenant>` | `{generation, revokedBefore}` | none (pinned) | control | none yet | — |
| `pool:<tenant>` | `{pool, slots, spread, epoch}` | none (pinned) | control | edge routing (invalid → 503), flush `full` sweep | a changed meaning routes rows to shards readers do not look at |
| `limits:<tenant>` | `{active_series, query_*…}` | none (pinned) | control | edge (`active_series`; unreadable → default), query (unknown fields ignored, bad values → 503) | a changed unit loosens or tightens limits silently |
| `retention:<tenant>` | `{metric_samples_days, …}` | none (pinned) | control | janitor (unreadable → default, never shorter) | a changed unit expires the wrong days |
| `flush-pending:<shard>` | `{since}` (presence matters) | none | Shard | flush sweep (lists the prefix) | — |
| `maint:<tenant>` | value `1`, metadata `{due, orphansAt, sweep}` | none; absent `sweep` = true (expand done right) | maintenance run | cron `enqueueDue` | — |
| `DEFAULT_POOL`, `CELL` | Worker vars, set per deployment (`deploy/workers.json` `shared_vars`) | — | deploy | every script | a version that bound a different value would route differently; `shared_vars` keeps them equal |

### 3.6 Public APIs, credentials and identifiers

| Surface | Defined in | Version | Notes for skew |
|---|---|---|---|
| Remote Write, OTLP/HTTP | `edge/` | external (protobuf) | external clients; only expand |
| Prometheus HTTP API | `query/`, ruler `/api/v1/rules`, `/alerts` | external; checked by Prometheus' own code (`ruler/tools/promcheck`) | 503 `unavailable` for a refused object (this work) |
| Control API `/api/v1/control/…` | `control/openapi.json` | path `v1`; unknown body fields are **refused** | a client one release ahead must not send new fields until control accepts them (COMPATIBILITY §4); every route may now answer 503 `schema-too-new` |
| Monitors API `/api/v1/monitors…` | `ruler/openapi.json` | path `v1`; unknown fields refused | same; 503 `schema_too_new` |
| `viz.dashboard/v1` | `dashboard/schema`, `dashboard/src/schema.ts` | `apiVersion` const; **closed** schema (`additionalProperties: false`) | an optional field added in N+1 is refused by N's validator: the validator must ship one release before any writer (app, mcp, control) emits it |
| MCP tools | `mcp/src` | protocol version negotiated at `initialize`; cursors `c1.` (versioned) | — |
| Webhook (Alertmanager `version: "4"`), `X-Viz-Signature: t=…,v1=…`, `Idempotency-Key` | `ruler/src/payload.ts`, `signature.ts`, `notifier.ts` | external / `v1` / pinned (golden) | a changed idempotency key derivation would make receivers process a retried notification twice: pinned by golden and mutant 57 |
| Rule files (YAML) | `ruler/src/rulefile.ts` | Prometheus' format | pinned (golden) |
| API key `viz_<keyId>_<secret>` | control mints; edge parses | none in the string (edge accepts id 1–64, secret 8–256 base62) | pinned (golden shape) |
| Control list cursors | `control/src/util.ts` | none; refused (400) unless shape matches | pinned |
| Derived ids: `series_id` (FNV-1a), batch fingerprint, file key `hash8`/`inputs16`, stream incarnation, alert fingerprint, rule key, index partition, jump-hash placement, revision id | `contracts/BATCH.md`, `TABLES.md`, ruler, dashboard | none | COMPATIBILITY §3.4; ruler's and control's are pinned by golden tests; the write path's are pinned only by contract text |
| Cache API entries `viz-file-cache.invalid/{key}` | `query/src/leaf.ts` | content-addressed by object key | safe across releases while the cached value is the object's bytes; a cached *derived* value must put its format version in the key |

## 4. How a release moves through the system

```
 t0  upload all versions (nothing serves)
 t1  promote callees first: viz-ingest, viz-control, viz-query, viz-gateway   (deploy/workers.json)
       each promotion: new requests to stateless Workers run N+1 at once;
       each active Durable Object keeps N until it hibernates or 30 s pass (F4);
       queue consumers and crons: either release (U1)
 t2  every object has adopted N+1 (about 30 s after the last promotion)
 rollback: a new deployment of N, callers first; objects adopt N the same way
```

**The skew window** is from the first promotion until the last object adopts the new code:
seconds to minutes on a normal deploy, unbounded during a rollback or a gradual deployment.
Inside it, in both directions:

| What | N must tolerate from N+1 | N+1 must tolerate from N |
|---|---|---|
| RPC | unknown optional request fields (ignored), never a required one | absent new fields; old statuses |
| Results | new optional fields, new statuses it fails closed on | — |
| Queue messages | a `v` it does not know → retry, not dead-letter | absent `v` = 1 |
| R2 objects, logs | a version or kind it does not know → stop there | every older version still live |
| KV records | unknown fields ignored; unknown `v` → last good value or 503 | absent `v` = 1 |
| Storage | `compat` ≤ its version: use as is; else refuse | migrate in the constructor |

Callee-before-caller promotion handles new RPC methods; it does not help with responses, with
data at rest, or with the deferral of F4. The general order is **readers before writers**
(COMPATIBILITY §3.3).

## 5. Rollback rules

COMPATIBILITY §6 states them; here is how they apply today.

- Release records should carry, per Durable Object class, `schemaRelease(spec)` =
  `{component, latest, compat}` (exported by each `src/schema.ts`), and per format the version
  written and the versions read (`FORMATS` in each `src/schema.ts`). Since 2026-11-19 the
  deploy records the first (every class's `{latest, compat}`, also on every Worker version as
  `VIZ_SCHEMAS`), marks a release forward-only by it, and refuses a rollback across it (D46,
  `deploy/README.md`, "Release record"); and since D69 the second: each Worker's written and read
  version of every format in its components' `FORMATS` maps and read lists (`VIZ_FORMATS` on every
  version), a release forward-only when it writes a version some serving Worker does not read, and a
  rollback refused when a Worker it restores does not read a version written since, or one that a
  Worker it leaves serving wrote or writes. Since the review of D69 every Worker declares what it
  reads, completely (where its code has no version for a format it reads, `deploy/workers.json` says
  version 1 on its behalf); a Worker that declares nothing, and a record from before format
  versions, are taken to read version 1 of every format.
- **Rollback floors raised by a switch** (D69; COMPATIBILITY §6, "A floor raised by a switch"): once
  a viz-ingest version with `INGEST_SIGNALS` on is among the versions Cloudflare keeps, no release or
  rollback may leave viz-publisher, viz-query or viz-ingest below the release that first reads span
  and log data (D64, D62, D63); every release with the switch on needs all three at their floors in
  the release and as they serve. The tooling that enforces it is main's: production deploys only
  from main, and older code goes out again as a new commit there (review of D69, M-2).
- **Forward-only** for a class when `canOpen(target.latest, newest)` fails, when a format
  version is written that the target does not read, or across a class lifecycle change (F6).
- Today every versioned class is at version 1 with `compat` 1, so every release since this
  one is rollback-safe for them. The first versioned release becomes the floor before any
  migration 2 ships (bootstrapping, COMPATIBILITY §6).
- A rollback across a forward-only release is refused by the tool; a person who forces one
  (or lowers a gradual deployment) gets objects that answer 503 until it is undone. Safe,
  not available.

## 6. The upgrade-under-load trial and the invariants

The release engineer's trial (`deploy/README.md`, `deploy/load.mjs`) drives steady write and
read load across a deploy and a rollback. Mapped to `design/VERIFICATION.md`:

| Invariant | What the trial must observe across the cutover | What makes it hold under these rules |
|---|---|---|
| I1 an acknowledged row is in shard storage or a listed file | every acknowledged sample is read back after the cutover and after the rollback | storage is never rewritten by a release that cannot read it (refusal); migrations are atomic; a shard object that resets mid-append either committed before answering or the client got an error and retries |
| I2 no acknowledged row is lost | the count of acknowledged samples equals the count read back, per tenant, after both transitions | the ledger log is written in a format every possible rollback target can rebuild from (§3.6 of the contract); shards discard only up to the logged watermark |
| I4 no gap or double count at the tail/lake seam | queries during the cutover return either the exact answer or an explicit retryable error, never a short one | a refusing shard or ledger answers a status; query must fail closed on any status it does not know (§7, query) |
| I7 overload or refusal is retryable, never acknowledge-and-drop | every non-2xx the load client sees is 429 or 503 with `Retry-After`, and resending succeeds | `schema_too_new` maps to 503; edge must treat any unknown shard status as a failure (§7, edge) |

What the trial cannot show by itself, and the tests here do: a *forward-only* release rolled
back (refusal, nothing written), storage from the pre-versioning release (adoption), and a
format one release ahead (readers refuse). The trial should add one run where release N+1
carries an additive migration (a nullable column) on the shard or ledger, then rolls back to
N under load, with I1, I2 and I4 checked; that exercises `compat` on Cloudflare.

## 7. Needed changes in components owned by others (priority order)

1. **ledger: done** (2026-11-19; `ledger/README.md`, "Versioned storage" in "What is
   implemented"; `ledger/test/compat.test.ts`, goldens `schema/v1`, `formats/ledger.segment.v1`,
   `formats/ledger.checkpoint.v1`). What was asked: (risk: I1/I2, a wrong rebuild re-bases every reader). Version the storage with
   `openSchema` (`ledger.Ledger`); migration 1 = today's schema plus `columnsOf` checks that
   add `prec`/`prec_lo` to objects created before D22. Change "storage is new" from "no
   `meta.incarnation`" to "no tables and no `viz_schema`"; storage with a version row and no
   incarnation is corrupt and refused, never rebuilt. Rebuild refuses a `LedgerChange` with an
   unknown `v` or `kind` instead of applying it (the segment contract now says so; the first
   layout's replay in `ledger/src/ledger.ts` still applies an unknown kind). Answer
   `schema_too_new` from every RPC. The segment log itself already follows COMPATIBILITY
   §3.1–§3.6 on paper (`LEDGER-LOG.md` "Versions"); its one-release rollout is a recorded,
   accepted exception to readers-first.
2. **publisher: done** (2026-11-19). It reads the segment layout as `LEDGER-LOG.md` "Readers
   of the log" says, and the first layout for incarnations that use it; an unknown segment
   header `v` or `kind`, change `v` or `kind`, or file table stops that tenant before the
   segment (`publisher/src/log.ts`, `publisher/README.md`). Golden: real segment bytes from the
   ledger (`publisher/test/golden/formats/read.ledger-segment.v1.json`).
3. **shard: done** (2026-11-19; `shard/README.md`; `shard/test/compat.test.ts`, goldens
   `schema/v1`, `formats/series-window.v1`, `formats/queue.flush.v1`; the flush message now
   carries `v`). What was asked: (risk: I1/I7). Version the storage (`shard.Shard`); migration 1 adds
   `segment.sealed_at` where missing (the known gap). The sketch BLOB gets a version byte
   (byte 0 is a kind today; refuse an unknown one instead of reading it as an exact list).
   Under refusal, `append` answers a retryable status (as `backpressure`), never `ok`.
4. **edge: done** (2026-11-19; `edge/README.md`; `edge/test/overload.test.ts`). What was
   asked: (risk: I7, I3). Treat any `AppendResult` status it does not know as a failure of
   the whole request (503), never as stored. KV readers check `v` (absent = 1) and refuse a
   newer one (keep the last good value or 503; never authenticate, never loosen a limit). A
   new `VZB` version is encoded only after flush's and query's decoders read it.
5. **query** (risk: I4, a silent gap or a retry loop). Switch exhaustively on
   `TailResult` and plan answers; an unknown status (including `schema_too_new`) is a refusal
   with its reason, surfaced as 503 after the existing retry budget. Leaf calls skew within the
   script (F4): keep `LeafAnswer` additive. Reject Parquet files whose (future) viz format
   marker is unknown.
6. **flush and the queue messages** (risk: a message acknowledged into the dead-letter queue
   during a deploy; recovered only by the hourly sweep). Add `v` to `FlushMessage` and
   `MaintMessage` (absent = 1). The consumers `retry()` a message whose `v` they do not know
   and keep dead-lettering only for bodies invalid in every version.
7. **R2 data files (flush, compact, engine/storage)** (risk: an older reader silently
   misreading a newer file for the whole retention). Write a Parquet key-value entry
   `viz.format` and Parquet field ids equal to the Iceberg ids (publisher contract issue 4);
   readers refuse an unknown `viz.format`. New columns optional, ids never reused
   (COMPATIBILITY §5). Compaction keeps the newest format it can read for its output.
8. **janitor, compact** (risk: low; they act only on what the ledger says). Retention KV
   parsing by `v`; handle `schema_too_new` from the ledger as retryable in the maintenance
   run (the queue retries it).
9. **deploy** (the release engineer). Put `schemaRelease` and `FORMATS` of each component in
   the release record and extend the rollback check from migration tags to COMPATIBILITY §6.
   *Schemas done 2026-11-19 (D46); `FORMATS` done 2026-11-19 (D69), with the floors of
   `INGEST_SIGNALS`.*
   The gateway's bootstrap should answer 503 (not 500) when `provision` throws
   `schema_too_new`.
10. **dashboard, app, mcp** (risk: users' edits refused). The closed `viz.dashboard/v1`
   validator ships each new optional field one release before anything writes it. app and
   mcp treat 503 `schema-too-new` / `schema_too_new` as retryable.

## 8. What was implemented here, and how it was checked

| Component | Versioned | Refusal | Golden formats | Tests added | Mutants (all killed) |
|---|---|---|---|---|---|
| `contracts/schema.ts` | the runner: `openSchema`, `canOpen`, `schemaRelease`, `columnsOf`, `describeSchema` | `SchemaTooNew`, `SchemaTooNewError` | — | exercised from the three components | 5 runner mutants, run in control |
| `control/` | `control.Tenant` v1 | 503 `schema-too-new` on every route, `resolveKey`/`recordUsage` statuses, `provision` throws, alarm re-armed | `kv.key`, `kv.revocation`, `kv.settings`, `kv.pool`, `credential.api-key`, `cursor.list`, `id.revision` | `compat.test.ts` (9), `golden.test.ts` (6) | 10 |
| `ruler/` | `ruler.Ruler`, `ruler.Notifier`, `ruler.RulerIndex` v1 | `Refused` status on every Ruler/Notifier RPC, registry throws, HTTP 503 (`unavailable` in the Prometheus API), alarms re-armed | `rpc.alert-update`, `id.hashes`, `id.idempotency-key`, `id.placement`, `http.webhook`, `file.rules-yaml` | `compat.test.ts` (14), `golden.test.ts` (3) | 9 |
| `publisher/` | `publisher.Publisher` v2 (2026-11-19; v1 at the time of this table) | every method throws `schema_too_new`; never commits, rebuilds from or sweeps against newer Iceberg metadata; stops (never skips) at a ledger change of unknown `v` or `kind`, and (since 2026-11-19) at a segment of unknown header `v` or `kind` | `iceberg.metadata` (+ field-id permanence), `iceberg.manifest`, `r2.cursors`, `read.ledger-change`, `read.ledger-segment` | `compat.test.ts` (9, now 15), `golden.test.ts` (5) | 7 (then; see `publisher/README.md` for the current list) |
| `ledger/` (2026-11-19) | `ledger.Ledger` v2 (v1 adopts the pre-versioning schema and adds `prec`/`prec_lo`; v2, forward-only, marks the segment log) | every method throws `schema_too_new`, the alarm re-armed, nothing written; storage with a version row and no incarnation refused, never rebuilt over; a log it cannot rebuild from is `stuck`, never partly replayed | `ledger.segment`, `ledger.checkpoint`; schema `v1`, `v2` | `compat.test.ts` (8), and the log readers in `segments.test.ts` | 46 run: 43 killed, 3 survive (one untestable, two guards that cover each other; `ledger/README.md`) |
| `shard/` (2026-11-19) | `shard.Shard` v1 (adopts the pre-versioning schema, adds `segment.sealed_at`) | `append` answers retryable `overload`, never `ok`; every other method throws; alarm re-armed; nothing written. A series-window bucket of an unknown kind or version refuses that tenant's metered appends | `series-window` (format byte), `queue.flush` (`v`); schema `v1` | `compat.test.ts` (9), `trigger.test.ts` | 20 run: 19 killed (2 after new tests), 1 equivalent (`shard/README.md`) |
| `edge/` (2026-11-19) | — (stateless) | an `AppendResult` status it does not know is 503, never stored; key records, pool maps and limits records of a newer `v` are 503 unless the isolate holds the last good value; a limit is never loosened to the default | — | `overload.test.ts` (7) | 43 run, 41 killed, 2 equivalent (`edge/README.md`) |

Each component's README lists commands, results and the mutants with the test that caught
each. The pre-versioning storage fixtures (`*/test/fixtures/storage*`) were dumped by the
three components' code as committed before this work changed it, by driving each object
through a short scenario and reading every table.

## 9. Adversarial self-review of the contract

Read as an adversary: find a sequence of deploys, rollbacks, evictions and redelivered
messages that loses or double-counts an acknowledged sample, or corrupts storage, under the
rules as written. What was found, and what was done:

1. **An older writer drops fields it does not know.** A "compatible" (additive) JSON field
   in a stored row is lost when an older release rewrites the row during a rollback; if the
   field was an acknowledgement or a fence, behaviour silently regresses. *Fixed*: §2.3 makes
   such a field breaking unless every writer preserves unknown fields.
2. **The ledger's log changes format and the rollback target cannot rebuild from it.**
   Rollback to a ledger that only reads per-change objects, then storage loss: the rebuild
   misses everything logged as segments, while shards have already discarded those rows.
   Acknowledged samples lost. *Fixed*: §3.3 readers-first and the worked example §3.6; §6
   counts a format written that the target cannot read as forward-only.
3. **`LedgerChange.removed` changing type** (`string[]` to objects, as LEDGER-LOG.md plans):
   an older publisher would fail on it; an older rebuild would try to delete `[object
   Object]`. *Fixed*: §4 forbids repurposing; §3.6 names the new field instead.
4. **A refusing shard answering a status the edge does not know.** If the edge counted it as
   stored, I7 breaks. *Rule*: §2.4 "an unknown status is never ok"; *gap until* edge change 3.
5. **A queue message one version ahead exhausts its retries** (8, backoff to 5 minutes)
   during a long rollback and the platform dead-letters it; the dead-letter consumer acks it.
   Flush work comes back with the hourly KV-marker sweep, maintenance with its marker, so
   nothing acknowledged is lost, but the rule "never dead-letter for newer" cannot be honoured
   against the platform's retry limit. *Listed*; readers-first means such a message is never
   sent while an old consumer can run.
6. **Lowering a gradual deployment of a forward-only release.** Migrated objects refuse.
   Nothing is written or lost; those tenants are unavailable until it is raised again.
   *Listed* (contract §9).
7. **A lost or deleted version row.** The runner would take newer storage for
   pre-versioning storage and run migration 1 over it (`IF NOT EXISTS` changes nothing), then
   older code would serve newer storage. Only a bug can delete the row (nothing but the runner
   writes it). *Listed*; a stricter adoption that compares the existing schema with migration 1
   before adopting is a possible follow-up.
8. **A migration longer than 30 s** resets the object on every request (F7): unavailable, not
   corrupt. *Fixed*: §2.2 bounds migrations and moves backfills to the alarm.
9. **Alarm re-armed under refusal for ever.** Bounded cost (one alarm per 30 s per refusing
   object) while the refusal lasts; a refusing ledger stops draining, its logged watermark
   stops, shards keep their segments: no loss. *Accepted*.
10. **Double counting across engine versions.** A flush retried by N+1 after N wrote files
    with other bytes gives other keys, but the ledger admits units by sequence range (a replay
    is `ok` without its files), so the second set is never live and the orphan sweep removes
    it. Compaction re-runs conflict on their inputs. *No change needed*.
11. **Pre-versioning code rolled back onto versioned storage.** It ignores `viz_schema` and
    writes. Harmless while version 1 equals its schema; would be corruption after a migration
    2. *Fixed*: §6 bootstrapping rule (the first versioned release is the floor before any
    migration 2).
