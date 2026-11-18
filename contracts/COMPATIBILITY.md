# Compatibility across releases

Every push to `main` deploys production. For the length of a deploy, and again during a
rollback, two releases run at once: N and N+1 (or N+1 and N). This contract is what every
component does so that they can. It is written to be followed without reading anything
else; the reasons and the evidence are in `design/UPGRADES.md`. The migration runner is
`contracts/schema.ts`.

**The promise.** Under these rules no sequence of deploys, rollbacks, evictions and
redelivered messages loses or double-counts an acknowledged sample or corrupts storage. A
rule that is broken anyway must fail *closed*: refuse, retry, stall; never guess, skip or
overwrite. §9 lists what the rules do not cover.

## 1. What the platform does (and so what you must assume)

Verified from Cloudflare's documentation; sources in `design/UPGRADES.md` §2.

1. **Callers and callees skew both ways.** Two Workers joined by a service binding "may be at
   different points in their own gradual deployment", and an RPC call cannot pin the
   callee's version. Assume any caller of release N±1 meets any callee of N.
2. **A Durable Object runs one version at a time**, keeps it for the length of a deployment,
   and is reset when it is assigned another. A **rollback is a new deployment**: an object
   that ran N+1 can run N afterwards, on the storage N+1 wrote.
3. **New code is adopted late.** By default an active object keeps running its old code for
   up to 300 s after a deploy (configurable up to 24 h; viz's deploy sets 30 s), so "promoted"
   does not mean "running everywhere". Plan for the old release still serving objects after the new one is live.
4. **Durable Object class lifecycle changes** (new, renamed, deleted, transferred classes)
   cannot be uploaded as a version, should not be rolled out gradually, and once deployed no
   rollback may go to a version before them.
5. **Queues, cron and alarms** may run on either release during a deploy (not documented;
   assume both). A queue message that exhausts its retries with no dead-letter queue is
   deleted.
6. Durable Object SQLite has no `BEGIN`; use `transactionSync`. `PRAGMA user_version` is not
   authorised (measured in local workerd); `PRAGMA table_info` and `sqlite_master` work.

## 2. Durable Object storage

### 2.1 Every class's storage carries a version

- Each Durable Object class declares a `SchemaSpec` (`contracts/schema.ts`): its component
  name (`<dir>.<Class>`, e.g. `ruler.Notifier`) and its list of migrations.
- The constructor opens storage, before anything else touches SQLite:

  ```ts
  void ctx.blockConcurrencyWhile(async () => {
    this.schema = openSchema(ctx.storage, MY_SCHEMA)
    if (this.schema.status !== 'ok') return   // refuse everything, write nothing (§2.4)
    this.load()                                // rebuild memory from SQLite as before
  })
  ```

- `openSchema` keeps one row in the table `viz_schema`: `component`, `version` (highest
  migration applied) and `compat` (the lowest version a release must know to open it). It
  applies the missing migrations and writes the row in **one** `transactionSync`: storage is
  at the old version or the new one, never between.
- **Migration 1 is the schema as it stood when versioning began**, written with `IF NOT
  EXISTS` (and, where pre-versioning code created older variants, with `columnsOf` checks), so
  it adopts storage made by code from before this contract without changing a row.

### 2.2 Writing a migration

- Append it; never edit or reorder a released one. A golden file per version pins its result
  (§8).
- Synchronous, local SQLite only: no R2, no network, no `await`, no clock other than `now`.
- Bounded: the whole open must finish well inside `blockConcurrencyWhile`'s 30 s (the object is
  reset past it, and would be again on every request). A backfill over an unbounded table is
  not a migration; do it in batches from the alarm, with its progress in a row, and make
  readers cope with rows it has not reached.
- Stored JSON and BLOBs are part of the schema. A change to the shape of a stored value is a
  migration (or an additive change readers tolerate, §2.3), with its own version.
- Memory rebuilt in the constructor must tolerate everything an additive change may leave
  absent (missing column values are `NULL`, missing JSON fields are `undefined`).

### 2.3 `readableFrom`: additive or forward-only

Each migration says the lowest schema version a release must know to open storage it has
touched. That decides whether the previous release stays a valid rollback target.

| Change | Kind | `readableFrom` |
|---|---|---|
| New table, new index, new nullable column, new column with a `DEFAULT` | additive | the previous version (older code ignores it) |
| New optional field inside a stored JSON value that older code may drop on rewrite without harm | additive | the previous version |
| Drop or rename a table or column; change a column's type, meaning or unit | breaking | its own version |
| New `NOT NULL` column without a default, new `UNIQUE`/`CHECK`/foreign key/trigger that an older writer could violate | breaking | its own version |
| A field whose loss would be wrong if an older writer rewrote the row without it (an acknowledgement, a fence, a watermark) | breaking | its own version, or every writer of that row preserves fields it does not know |
| Anything newer code *relies on* that older code does not maintain (a backfilled column, a denormalised count, an invariant across rows) | breaking | its own version |
| A change in how a stored value is encoded, or in a key derived from it (§3.4) | breaking | its own version |

A release containing a migration whose `readableFrom` equals its own version is
**forward-only** for that component (§6).

### 2.4 Newer storage: open it if allowed, else refuse and write nothing

When `viz_schema` says `version` > what this code knows:

- `compat` ≤ known: open it **as it is**. Never lower `version`. Write as usual; the newer
  release tolerates what you write (that is what `readableFrom` promised).
- `compat` > known: `openSchema` returns `{ status: 'schema_too_new', … retryAfterMs }`
  having written nothing. From then on, until the instance is replaced:

| Surface | Answer |
|---|---|
| RPC whose result is a status union | the `SchemaTooNew` value itself, as a member of the union |
| RPC whose result is not a union | throw `SchemaTooNewError` (message starts `schema_too_new`; `retryable: true`) |
| HTTP (`fetch`, a Worker in front of the object) | `503` with `Retry-After`, and an error code in the API's own spelling: `schema-too-new` (control), `schema_too_new` (monitors), `errorType: unavailable` (Prometheus API) |
| `alarm()` | `setAlarm(now + retryAfterMs)` and return. Nothing else. Never delete the alarm |
| Anything else | no read of tenant data, no write of any kind |

Callers treat `schema_too_new` like overload: retryable, nothing happened. A caller that does
not know the status must fail closed (an unknown status is never "ok", "empty" or "not
found").

## 3. Everything else that crosses a release boundary

Queue messages, R2 objects, RPC arguments and results between Workers or objects, KV
records, cursors and tokens handed to clients, and identifiers derived by hashing.

### 3.1 Every format carries a version

- **JSON**: an integer field `v`. For a format that existed before this contract, an absent
  `v` means 1, so nothing already written changes. A format whose top level is a map keyed
  by data (a tenant name could be `"v"`) carries its version beside it instead (a metadata
  property, a header field, the key).
- **Binary**: a magic number or version byte at a fixed offset (`VZB1` already does this).
- **Object keys** that *are* the format (a log segment, a file name parsed by a reader): the
  version is part of the name or of the object's metadata.
- Each component lists the formats it writes with their current versions in one place (for
  example `FORMATS` in `control/src/schema.ts`), and pins each with a golden file (§8).

### 3.2 Readers

- **Unknown optional fields are ignored.** Never refuse a record, message, stored value or RPC
  argument passed between viz's own components for a field you do not know. (Request bodies
  from outside clients may be strict, as control's and the monitors API's are; then §4's rule
  for new request fields applies.)
- **Unknown versions are refused**, explicitly, never parsed on a guess.
- **Unknown enum values** in something the reader must act on (a log entry's `kind`, a
  status) are refused like an unknown version. In something advisory (a label, a hint) they
  are ignored.
- Refusing means, by transport:

| Transport | Refuse by |
|---|---|
| Queue consumer | `message.retry({ delaySeconds })`. Never `ack`, never dead-letter for "newer than me": a dead-letter queue is for messages no release can process |
| R2 log or object read in order | stop at that object, report it (a status such as `unsupported`), leave the cursor before it. Never skip it |
| RPC | the status `unsupported_version` (or `schema_too_new` for storage) |
| KV record | do not act on it: keep the last good value or answer 503. Fall back to a default only where the default is the safe direction (never loosen a limit, never authenticate, never route) |
| HTTP request from a client | 400 naming the version; the client is the one that is ahead |

### 3.3 Readers before writers: two releases per format change

A release may start **writing** version n+1 of a format only if **every release it can be
rolled back to, and every release that may still be running, reads n+1**. In practice:

1. Release A reads n and n+1, writes n.
2. Release B (only after A is the rollback floor, §6) writes n+1.
3. Release C may stop reading n once nothing in n remains (queues drained, logs past it,
   files compacted or expired, KV rewritten) and B is the floor.

Deploy order follows the same rule: **the reader of anything new deploys first.** A new RPC
method or request field: the callee. A new response field a caller needs: the callee may add
it any time, the caller may depend on it only once every callee sends it. A new queue
message version: the consumer. A new R2 or KV format: every reader (publisher, ledger
rebuild, query, janitor, edge) before the writer. Callee-before-caller promotion is the
special case for RPC.

### 3.4 Derived identifiers are formats

A hash that names something stored or sent is a format: `series_id`, alert fingerprints,
rule keys, idempotency keys, content hashes in object keys, revision ids, index-partition and
placement hashes, cursor encodings. Changing one changes the identity of existing data
(duplicates, orphans, lost state, double notifications). It never changes within a version;
golden tests pin each one with fixed inputs. A change is a new version computed *alongside*
the old one until nothing uses the old one.

### 3.5 External formats

Remote Write, OTLP, the Prometheus and Tempo HTTP APIs, Alertmanager's webhook (`version:
"4"`), Iceberg v2, Parquet, MCP: follow their versioning. viz's own HTTP and RPC surfaces
only expand within a version (§4).

### 3.6 Worked example: the ledger's change log moving to segments

`contracts/LEDGER-LOG.md` replaces one R2 object per change with batched segments. Its
readers are the publisher and the ledger's own rebuild; both can be rolled back, and a
rebuild that cannot read what was logged loses acknowledged samples (shards discard up to
the *logged* watermark). Under §3.3 that takes three releases:

1. **Readers.** Release A: the publisher and `rebuildFromLog` read both layouts (per-change
   objects and `seg-…jsonl`), each line a `LedgerChange` that carries `v`. The ledger still
   writes per-change objects. A is deployed and becomes the rollback floor.
2. **Writer.** Release B: the ledger writes segments. B is forward-only for the ledger's
   storage if its outbox or `meta` rows change shape (§2.3), and for the log format (a
   rollback below A could not read the segments). Its release record says so.
3. **Cleanup.** Release C may drop the per-change reader once every live incarnation's log
   starts with a segment `base`.

As built (`LEDGER-LOG.md`, "Rollout"), steps 1 and 2 ship together, because no ledger had
reached production: that release is forward-only, and any deployment that ran the first
layout cannot be rolled back below it (stuck, not lost, §9). Once a ledger is in production,
the next log format change takes the three steps.

Within the segment format: `LedgerChange.removed` stays `string[]`. The `{ key, table }`
pairs the plan wants are a **new** field beside it (for example `removedFiles`), not a new
type for `removed` (§4, repurposing). A segment line or a `kind` the reader does not know
stops that tenant's log at that line (§3.2); the publisher already does this
(`publisher/src/log.ts`, status `unsupported`).

## 4. Expand, then contract

The only way to change something another release depends on:

1. **Expand**: add the new thing beside the old. Readers tolerate its absence.
2. **Migrate**: write both, or backfill, until everything has the new thing.
3. **Contract**: in a later release, once the expanding release is the rollback floor, stop
   reading and then stop writing the old thing.

Never **repurpose**: a column, JSON field, Iceberg field id, label, enum value, queue name, KV
key prefix, R2 prefix, RPC method or status keeps its meaning for ever. A retired name is not
reused. Changing a field's type in place (a string becoming an object) is repurposing.

APIs within a version: new optional request fields, new response fields, new endpoints and
methods, new statuses that callers already fail closed on. Never a new required request
field, a removed or renamed response field, or a changed meaning. A client of release N+1
must not send a new request field until the server release that accepts it is the floor
(control and the ruler refuse unknown body fields).

## 5. Parquet and Iceberg

- **Add columns only.** A new column is optional in Iceberg, is absent from every file
  written before it (files are immutable), and every reader handles its absence for as long
  as such files are live (retention can be years).
- **Field ids are never reused or reassigned.** A new column takes `last-column-id + 1` read
  from the table's current metadata, not from a constant. A dropped column's id stays
  retired. Parquet field ids, once written, equal the Iceberg ids.
- No rename in place, no type change except Iceberg's allowed promotions, and those only
  when every reader of viz's files (the engine, PyIceberg, DuckDB) is shown to read them.
- A new partition spec or sort order gets a new id; old files keep theirs.
- **The publisher carries forward what it does not understand** in table metadata (schemas,
  specs, sort orders, properties, `last-column-id`) and refuses to commit over metadata
  whose format version, current schema or `viz.format-version` property is newer than it
  knows. It never writes a commit that would drop a newer writer's schema.
- Dropping support for an old file layout needs every such file rewritten (compaction) or
  expired first, and the ledger to show none is live.
- The index fragment (`FileEntry.index`, `{"v":1,…}`) follows §3.

## 6. Rollback rules

Each release records, per Durable Object class, `schemaRelease(spec)` = `{ component,
latest, compat }`, and per format the versions it reads and writes.

- A rollback from the newest release R to release T is **safe** iff, for every class,
  `canOpen(T.latest, { version: R.latest, compat: R.compat })`, and T reads every format
  version any release since T has written, and no class lifecycle change lies between them.
  Take R as the newest release that ever ran since T, not the one running now.
- A release is **forward-only** when it fails that test against its predecessor: it has a
  migration with `readableFrom` = its own version, writes a format version its predecessor
  does not read, or changes a class's lifecycle. The rollback tool refuses to cross it. Fix
  forward.
- The **rollback floor** is the oldest release a rollback may reach; a forward-only release
  raises it to itself. Rules that say "once A is the floor" mean: the release tool will no
  longer roll back past A.
- **Bootstrapping.** The first release with versioned storage cannot protect against a
  rollback to code from before it (that code checks nothing). Version 1 equals that code's
  schema, so such a rollback is harmless; but no migration 2 may ship until the first
  versioned release is the floor.
- A gradual deployment counts as both releases running. Lowering a forward-only release's
  percentage is a rollback across it: the objects it migrated refuse (503) until it is
  raised again. Safe, not available.

## 7. What a release must not do in one step

- Change a storage schema in a breaking way when an additive change would do.
- Start writing a new format version *and* add the reader for it.
- Change a Durable Object class's lifecycle together with any other change.
- Remove a table, column, field, method, status or binding the previous release reads.
- Rename a class, queue, binding, KV prefix or R2 prefix (add the new one; retire the old).
- Change a derived identifier, a hash function or an encoding of a key.
- Change the meaning of an enum value or a unit.
- Change both sides of an RPC in a way that needs them deployed together.
- Change a default that is merged into stored configuration at read time without saying, in
  the release notes, which objects change behaviour.

## 8. Tests every component keeps

1. **Schema goldens**: `test/golden/schema/v<N>.json` = `describeSchema` after migrations
   1..N on empty storage, for every released N; the latest equals a fresh object's schema.
2. **Adoption**: storage made by the pre-versioning code (a checked-in dump with data, or the
   same DDL with rows) opens as version 1 with no row changed, and serves.
3. **Upgrade**: storage at every earlier golden version migrates to the latest, survives
   `evictDurableObject`, and is not migrated twice.
4. **Refusal**: storage at `latest + 1` with `compat = latest + 1` is refused on every entry
   point, the alarm is re-armed, and a dump of every table is identical before and after.
5. **Compatible newer**: storage at `latest + 1` with `compat ≤ latest` is served and its
   version is not lowered.
6. **Format goldens**: for each format the component writes, a file
   `test/golden/formats/<format>.v<N>.json` for its current version N, produced by the real
   code with fixed inputs; old versions' files stay and the decoders still read them.
7. **Readers**: an unknown version and an unknown enum value are refused as §3.2 says.
8. **Mutants**: a broken migration step, a removed refusal and a changed encoding each make
   a test fail (AGENTS.md, "Tests must have teeth").

## 9. What these rules do not cover

- A human lowering a forward-only release's percentage, or `wrangler rollback` without the
  release tool: safe by refusal, not available (§6).
- Storage-level corruption, or a newer release that set `readableFrom` wrong: the refusal
  only protects what the version row describes.
- Data written in a newer format by a release that is then rolled back *below* the reader
  of that format: stuck, not lost, until a reader is deployed again (shards keep segments
  they cannot get recorded; logs keep entries the reader stops at).
- A queue message one version ahead that exhausts its retries during a long rollback is
  dead-lettered by the platform whatever the consumer does. viz recovers flush and
  maintenance work from KV markers, so nothing acknowledged is lost; readers-first (§3.3)
  keeps such messages from being sent at all.
- A version row deleted by a bug: the runner would take the storage for pre-versioning
  storage and adopt it. Only the runner writes `viz_schema`.
- Times: `retryAfterMs` is 30 s; a refusal lasts as long as the rollback does.
