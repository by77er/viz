# Publisher

Turns the tenants' ledger change logs into Iceberg tables that external engines can read
(design/DESIGN.md §5.3, decisions D2, D4, D15). One SQLite Durable Object per cell, named by
the cell id, is the only writer of that cell's Iceberg metadata. viz's own queries never read
what it writes, and nothing on the ingest or query path calls it (the maintenance run nudges
it, best effort and bounded: D34): if it is slow or stopped, external readers see older data
and physical deletes wait. Nothing else.

| File | Contents |
|---|---|
| `src/publisher.ts` | `Publisher`: publish, commit, resync, expire, sweep, `verify`, `safeToDelete`; the one alarm and its deadlines |
| `src/log.ts` | Reading a ledger's R2 log, segments and the first layout: changes after a cursor in version order, in whole segments, up to the first hole or unreadable object; a re-base from the newest checkpoint (one object, or parts) or the base, streamed into SQLite; the six-connection slots; a strict replay for `verify` |
| `src/nudge.ts` | `nudge(PUBLISHER, cell, tenants)`: what the maintenance run calls; bounded, never throws (D34) |
| `src/iceberg.ts` | Table schemas, Avro schemas of v2 manifests and manifest lists, `metadata.json`, per-file statistics |
| `src/avro.ts` | Avro object container reader and writer (about 300 lines, no dependency) |
| `src/schema.ts` | The publisher's storage as versioned migrations (`PUBLISHER_SCHEMA`), and `FORMATS`: the versions of what it writes and reads |
| `test/` | 99 tests in workerd with a simulated R2, against the real `Ledger` class (and the frozen as-built one for the first layout, and the frozen release before checkpoints in parts) |
| `bench/` | The re-base at the ledger's state limit (`rebase.bench.test.ts`), the frozen publisher from before it streamed (`before/`, the counterfactual), `phases.mjs` (memory per phase) |
| `tools/fixtures/` | Rust: real Parquet files made with `viz_storage::encode_segment` and `merge_files` |
| `tools/verify_readers.py` | PyIceberg and DuckDB read the published tables and are compared with the ledgers |
| `tools/mutants.mjs` | Mutation checks |

Bindings: Durable Object `PUBLISHER`, R2 bucket `BUCKET`, variable `ICEBERG_LOCATION_PREFIX`
(default `s3://viz-lake`). Deployed as **viz-publisher**, before viz-ingest, which binds its
`Publisher` class (`deploy/workers.json`). The Worker answers only `GET /healthz` (200 `ok`
with both bindings, 503 naming a missing one, 404 for anything else; it calls no object), for
the deploy's record of a health route; nothing reaches the publisher over HTTP.

## What is implemented

**Tables.** One Iceberg table per viz table per cell (`metric_samples`, `metric_series`),
shared by the cell's tenants, format version 2, partitioned by `identity(tenant)` and
`identity(day)`, with the engine's sort order declared. Metadata lives under
`{cell}/iceberg/{table}/metadata/`:

```
v{N}.metadata.json                 one per commit, written with If-None-Match: *
version-hint.text                  N of the newest metadata file
snap-{snapshot}-{tag}.avro         manifest list of a snapshot
{snapshot}-m{i}-{tag}.avro         manifests
cursors-{snapshot}-{tag}.json      {tenant: {ledgerIncarnation, version}} for every tenant
```

**Driving it: nobody has to (design/DECISIONS.md D34).** Every maintenance run (the
`viz-maint` consumer in `stack/`, which every flush that changed something already causes, and
which itself makes the ledger's compactions and expiries) ends with `nudge(PUBLISHER, cell,
[tenant])`. `nudge` waits at most 2 s and never throws; it returns false if the nudge may not
have been recorded, and the run then marks the tenant due in an hour so the cron runs it
again. (Wired in `stack/src/maintain.ts` since 2026-11-19; `stack/README.md`, "The publisher
wired in".) `notify`
writes the tenants to `pending` and a `publish` deadline `publishIntervalMs` (2 min) after the
first nudge, so nudges coalesce into one commit per table; it writes nothing to R2 and never
publishes itself.

The object has one alarm, set at the earliest of its deadlines (table `due`, migration 2) and
deleted when there is none:

| Deadline | Set by | What the alarm does |
|---|---|---|
| `publish` | `notify`; a publish that left tenants pending (a hole, a refusal, a backlog larger than one publish reads): `retryMs` (1 min) | publishes every pending tenant (whenever the alarm runs) |
| `sweep` | a commit, or an attempt that failed: `orphanGraceMs` (1 h) later, unless one is due sooner; after a sweep that marked objects: their grace end | the orphan sweep of both tables |
| `expire:<table>` | every commit: the time at which every snapshot beyond the newest `max(2, minSnapshots)` is outside the window | a metadata-only commit that drops them all at once (none if a publish already did) |

Each job reads what is due from SQLite and is idempotent, so a repeated or early alarm is
harmless. `publish(tenants?)`, `maintain()` and `sweep()` still run on demand (with no
argument, `publish` lists every tenant with a log in the cell). Measured here
(`test/triggers.test.ts`): after a tenant's last commit the alarm ran 5 times (a sweep that
found nothing, one expiry per table, the sweep that marked what they dropped, the one that
deleted it) and was then deleted; 48 simulated idle hours ran no alarm and wrote nothing. The
publisher has no queue binding and no cron.

**Reading the log** (`src/log.ts`, contracts/LEDGER-LOG.md "Readers of the log"). For each
tenant and table there is a cursor `(ledgerIncarnation, version)`; the log is read once per
tenant from the lower of the two. Each incarnation uses one layout:

- **Segments** (what the ledger writes): the publisher lists
  `startAfter: ledgerSegmentsStartingAfter(tenant, incarnation, version)`, which gives the
  segments that start after the cursor. If the first starts above `version + 1`, it lists the
  incarnation from its first segment and takes the one holding `version + 1` (the cursor is
  inside it); if none does, that is a hole. It reads whole segments only, contiguous, until
  about `maxChangesPerTenant` changes (at least one segment; the rest is `more`), decodes each
  with the contract's codec against its key and tenant, then checks it against what this
  publisher reads (below). A newer incarnation (or a tenant with no cursor) is **re-based**: from
  its newest checkpoint this code reads, else from the first line of its first segment, which
  must be its `base`, then the segments after it; streamed, never held ("Re-base in bounded
  memory", below). An incarnation that also has a `base.json` is corrupt.
- **The first layout** (`base.json` and one `{version}.json` per change): read as before, for
  incarnations a trial deployment may still hold (COMPATIBILITY.md §3.6, step 3). A ledger
  that takes such a tenant over starts a new incarnation in segments, which the publisher
  re-bases on (`test/segments.test.ts`).

A hole stops the tenant before it (`gap`, `gapAt`); two segments that overlap stop it before
both (`corrupt`; the shape of spec/README.md F10); a segment header `v` or `kind`, a change `v` or `kind`, or a file of a table
this publisher does not know stops it before that whole segment (`unsupported`, `gapAt` = the
segment's first version). Nothing after a stop is read, so nothing is ever skipped; the tenant
stays pending and the alarm retries. A newer ledger incarnation makes the publisher diff the
base's live set (plus the changes after it) against what is published for the tenant. A
change that does not fit the published state stops the tenant with `inconsistent`: it adds a
live key, removes a key of this table that is not live, or removes a live key as another
table's file. Which table a removed key belongs to comes from `LedgerChange.removedFiles`;
for a log written before it, from the key layout of contracts/TABLES.md. `removedFiles` that
does not list `removed` key for key is `corrupt`.

R2 operations per tenant read: one list (incarnations), one list (segments after the cursor;
a second only when the cursor is inside a segment), one get per segment read; a re-base adds
one list (the incarnation's checkpoints, with a delimiter so each checkpoint's parts are one
prefix), one head, and the get of its checkpoint's manifest and each part, or of the base
segment. When nothing is new, one more list looks for the first layout. A cursor inside the
newest segment (this reader never leaves one; another release might) waits until the ledger
writes the next segment, which the "starts above `version + 1`" rule then catches.

**Re-base in bounded memory** (design/DECISIONS.md D55, since 2026-11-19). A tenant with no
cursor in the newest ledger incarnation is re-based, and nothing in it grows with the tenant's
size. This is what lets the ledger's own 300 MiB limit apply, but production keeps
`LEDGER_STATE_MAX_BYTES` at 16 MiB for this release (`stack/wrangler.jsonc`; review of D47, D48
and D55, P-2 and P-3, `design/reviews/d47-d48-d55.md`). The ledger release before cannot hold or
checkpoint a larger state, so a rollback must not meet one. And a rebuild and a first
publication above 16 MiB have not been measured within a Durable Object's CPU limit on
Cloudflare. The limit is lifted in a later release whose rollback floor is this one, once those
are measured.

- **Where it starts.** The incarnation's newest checkpoint whose format this code reads: format 1
  (`ckpt-{version}.jsonl`, one `base` line) or format 2 (that key is a manifest naming parts
  `ckpt-{version}-{attempt}/{part}.jsonl` of at most 1 MiB). A checkpoint of a format it does not
  read is passed over (it is only a shortcut; `rebase.passedOver` in the report says so). Without
  one, the base, the first line of the first segment. Then the segments after it, as from a
  cursor at its version. Each tenant's report says what it started from (`rebase`: source,
  format, version, files, tombstones, objects read, the most parts in flight).
- **How it is read.** A base line or a format-1 checkpoint with `readLedgerLogStream`
  (`contracts/ledger.ts`): one element at a time, files and tombstones into SQLite (`stage`) 256
  per transaction, every other member parsed an element at a time and dropped. Format 2: the
  manifest, then the parts in order, at most `PART_WINDOW` (4) requested ahead of the one being
  applied, a part per transaction.
- **Six connections.** Every R2 operation of a publish, sweep, maintenance or verify takes a slot
  of one `Slots` of `R2_CONNECTIONS` (6) per invocation, a GET until its body has been read or
  cancelled. So the tenants read six at a time, the segments of each six at a time, the parts
  window and the commit's writes never have more than six in flight together. Re-bases of one
  publish take turns reading their checkpoint or base (`BaseSink.turn`), so the parts held at once
  are one window whatever the number of tenants. Tested from under the store
  (`test/checkpoints.test.ts`): six tenants re-basing from parts at once, at most six in flight,
  each tenant's part reads one unbroken run.
- **What is checked of parts.** Each part's header against its key and manifest (tenant,
  incarnation, version, attempt, part number) and its record count against its lines (the
  contract's decoder); every record one file or one tombstone; files in strictly ascending key
  order (SQLite's, UTF-8 bytes) across parts, then tombstones likewise; at the end the files,
  tombstones and bytes (as R2 stored them) of all parts against the manifest's. The format has no
  per-part size or digest (Contract issues 13).
- **When it cannot be read whole.** A part the manifest names that is not there: `incomplete`.
  The ledger deletes a superseded checkpoint's parts once the newer manifest is in R2, so a
  reader that listed the older manifest can meet this; the next publish lists again and starts
  from the newer one. A manifest or part that is not what it should be: `corrupt`. Either way
  the reader returns no base: nothing of the tenant is committed, its cursors do not move, it
  stays pending and the alarm retries every `retryMs`. What was staged is deleted at the end
  of the attempt, and at the start of the next one if an eviction cut it short.
- **The difference.** The changes read after the start are applied to `stage`, checked as
  ever (`inconsistent` for a removal of a key not live or an addition of a live one). The commit
  then takes what the tenant adds (`stage` not in `live`) and removes (`live` not in `stage`) in
  SQL: counts and sums by aggregate, the manifests to rewrite by `DISTINCT`, the added files a
  page of 1,000 at a time in `(day, key)` order into manifests of `manifestTargetEntries`, two
  manifests written at once, each entry built as the Avro encoder reaches it. Statistics are
  computed only for added files and kept in their `stage` row; after the commit point one
  transaction inserts and deletes `live` rows by key range, in SQL. A tenant read from its cursor
  is planned as before, but with a point lookup in `live` per key the changes touch instead of
  loading its published keys; merges of small manifests read `live` a page at a time.
- **Tables whose cursors differ** (review of D47, D48 and D55, P-1). A tenant's log is read
  once per publish, from the lower of its two tables' cursors; when either table has no cursor
  in the newest incarnation, from the newest checkpoint or base instead. A table whose cursor is
  below the version the log was read from (`log.start`, when it was read from a base or
  checkpoint) is then re-based as well, never planned from its cursor: the changes between its
  cursor and that version are not in what was read. Before this rule such a table skipped them,
  its cursor moved past them and the publish said `ok` (one table committed, the other's commit
  cut off, then a checkpoint above the first table's cursor; `test/review-skip.test.ts`).
  `planFromCursor` also refuses a log that starts above its cursor, so the tenant stops instead
  of skipping. With the first rule that refusal cannot be reached; it is defence in depth.
- **Tombstones.** A checkpoint or base carries the tombstones of removed files whose objects may
  remain. Those neither published nor live in the new state are recorded as removed by the
  commit's snapshot, and released once no older snapshot is retained (the conservative rule,
  since the publisher cannot know whether an earlier publication referenced them). Without this a
  re-base from a checkpoint would never release the files added and removed before it.
- **Resync** (SQLite rebuilt from R2) fills `live_next` a manifest at a time, two in flight, and
  swaps it into `live` in one transaction, so an eviction midway leaves SQLite as it was.
- **What still grows:** `verify` (Not implemented); the changes read per publish from a cursor
  (Risks); one manifest of `manifestTargetEntries` files while it is written.

**Net changes.** A commit holds the difference between what is published and the ledgers'
live sets after the changes read. A file added and removed between two publications is in
no manifest of any snapshot. Catching up after any number of ledger versions is one commit
per table.

**Commit.** In order: manifests, manifest list, cursor object, `v{N+1}.metadata.json` with
`onlyIf: { etagDoesNotMatch: '*' }`, `version-hint.text`, then one SQLite transaction. The
conditional write is the commit. Every object before it has a fresh name, so a commit that
does not reach it leaves only unreferenced objects.

- Added files go into one new manifest (split above 10,000 entries).
- Removed files: only the manifests that hold them are rewritten. The rewritten manifest
  lists the removed files with status DELETED (snapshot id of the removing snapshot, their
  original sequence numbers) and the others as EXISTING with explicit sequence numbers.
  **Why DELETED entries rather than only a rewritten manifest:** the spec asks for them in
  the snapshot that removes a file, readers that compute what a snapshot changed use them,
  and they cost one entry each. A manifest left with no live file is dropped by the next
  commit.
- When a commit would leave more than `maxManifests` (16) manifests, the untouched
  manifests with fewer than 5,000 live files are merged into manifests ordered by
  `(tenant, day, key)`, entries EXISTING.
- Snapshots older than `snapshotWindowMs` (24 h) are dropped by each commit, but never
  below `minSnapshots` (2; a lower setting is refused); when no commit comes, by the alarm's
  `expire` deadline. `metadata-log` keeps 20 entries.
- The snapshot summary has the standard counts and `viz.ledger-cursors`, the URI of the
  cursor object. The map is not inline.

**If SQLite and R2 disagree.** R2 is the truth about what is published; SQLite caches the
current snapshot's files, which manifest holds each, and the cursors. Before a commit the
publisher reads the metadata version it believes is current and checks that the next one
does not exist. If either fails, or its conditional write loses, it rebuilds SQLite from R2
(metadata, manifest list, manifests, cursor object) and starts the publish over with a fresh
read of the logs. That one path covers a crash after the metadata write, a second writer,
and lost Durable Object storage.

**Orphan sweep.** The alarm (at its `sweep` deadline) or `sweep()` lists the metadata prefix and deletes what the current metadata
does not reference (through any retained snapshot or the metadata log), but only on a later
sweep at least `orphanGraceMs` (1 h) after the sweep that first saw it. It first checks that
SQLite is not behind R2, and never touches a metadata file with a version above the current
one. It never touches data files.

**`verify(table)`.** Reads the newest metadata, the manifest list and the manifests from R2,
replays each tenant's ledger log from its incarnation's base to the published cursor with
every change checked, and compares. It reports: files in a ledger and not in the snapshot,
files in the snapshot and in no ledger, duplicates, entries whose tenant, day, row count or
size differ from the ledger's, referenced objects that are missing or have the wrong size
(data files, manifests, manifest list, cursor object), a cursor behind the snapshot's, and
SQLite at a different version than R2. `cursors: 'snapshot'` checks against the cursor
object in R2 instead of SQLite.

**`safeToDelete(tenant)`.** Keys removed from the ledger whose removal is published, that
no retained snapshot references, for at least `deleteGraceMs` (1 h), and that are not live
now. A file removed by the snapshot with sequence number *s* is released when the oldest
retained snapshot is *s* or newer. Files that were removed before they were ever published
are released one grace period after the cursor passes them. `acknowledgeDeleted` forgets
keys the deleter has deleted.

**Statistics populated per data file.** Record count and file size (from `FileEntry`);
value counts (= rows) and null counts (= 0) for every data column, which are all required;
lower and upper bounds for `ts` (samples) from `minTs`/`maxTs`, exact; for `min_ts` and
`max_ts` (series) the range `[minTs, maxTs]`, which is a valid bound for both columns and
exact only for the lower bound of `min_ts` and the upper bound of `max_ts`; bounds for
`metric_name` and the split offsets from the engine's index fragment. Not populated: column
sizes, NaN counts, bounds for `series_id`, `value`, `labels`. If the index fragment does not
parse, the name bounds and split offsets are left out and nothing else changes.

**Avro.** Written here: a schema-driven encoder and decoder for object container files,
codecs `null` and `deflate` (raw DEFLATE through `CompressionStream('deflate-raw')`).
Default `deflate`. No `eval`, no `new Function`, no Node API, no network.

**URIs.** Iceberg metadata holds absolute URIs. The publisher writes
`{locationPrefix}/{R2 key}`; `locationPrefix` comes from `ICEBERG_LOCATION_PREFIX` or
`configure()` and cannot change once a table has a commit.

## Versioned storage and formats (`contracts/COMPATIBILITY.md`)

- **Storage.** The constructor opens SQLite with `openSchema` (`contracts/schema.ts`) inside
  `blockConcurrencyWhile` (`publisher.Publisher`, version 1 = the schema the pre-versioning
  code created; version 2 adds `due`, the alarm's deadlines, `readableFrom` 1, so release 1
  stays a rollback target: on this storage it publishes on nudges and drops the expiry and
  sweep deadlines until the next commit by a release that knows them; version 3 adds `stage` and
  `live_next`, the scratch of a re-base and of a resync, `readableFrom` 1: releases 1 and 2 never
  touch them, and each is emptied by the operation that fills it, so they hold rows only while
  it runs or after an eviction in the middle of it). Storage a newer release migrated past what this code may read is refused:
  every method throws `SchemaTooNewError` (message `schema_too_new: …`; its results are reports,
  not status unions, and its future callers, a queue consumer and a cron, retry on an
  exception), and the alarm only re-arms itself.
- **Iceberg metadata from a newer publisher.** New tables carry the property
  `viz.format-version` = `1` (absent means 1). Before committing, when rebuilding SQLite from
  R2, and before sweeping, the publisher refuses (`metadata_too_new: …`) metadata whose
  `format-version` is not 2, whose `viz.format-version` is higher than it knows, or whose
  current schema or partition spec id it did not write. A newer publisher's schema evolution
  is therefore never overwritten, its field ids never handed out again, and its objects never
  swept by an older one; the tenants stay pending and the alarm retries. `verify` reports such
  metadata as a problem instead of checking it.
- **Cursors objects** carry `v: 1`; a higher one is refused when rebuilding.
- **The ledger log.** A segment whose header `v` or `kind`, or one of whose changes' `v`
  (absent = 1), `kind` or file table, this code does not know stops that tenant before the
  segment (`status: 'unsupported'`); in the first layout, before the change. The segments
  before it are published, it is never skipped, and the tenant stays pending. `verify`'s replay
  throws on it. The versions this reader applies are pinned in `src/log.ts`, not taken from
  the contract, and a test requires them to equal the contract's: a version bump in
  `contracts/ledger.ts` fails here until this reader is taught it (readers first, §3.3).
- **Formats** (`FORMATS` in `src/schema.ts`), pinned by `test/golden/formats/`: a new table's
  `metadata.json` for both tables (schemas, field ids, partition spec, sort order, name
  mapping, properties), the Avro schemas of manifests and manifest lists, the cursors object,
  an `add_unit` change as the ledger logs it today, and `read.ledger-segment.v1.json`: every
  log object of a scenario written by the current `Ledger` through this test pool (two
  incarnations, a checkpoint, a compaction with `removedFiles`, retention and a unit in one
  segment), with what each stage must publish. One test publishes those checked-in bytes stage
  by stage; another re-runs the scenario on the current ledger and requires the same bytes
  (only `at` differs), so a change of segment format without a new version fails here. And
  `read.ledger-checkpoint.v2.json`: a real log with a checkpoint in parts (17 parts, files,
  tombstones) written by the current `Ledger`; one test re-base-publishes those bytes, another
  requires the ledger to still write them (only `at` and the attempt name differ). The format-1
  checkpoint in `read.ledger-segment.v1.json` is re-based from too. A further test requires that, across
  every golden version and the code, a column keeps its field id and an id names one column.

## The partition columns

The Parquet files contain neither `tenant` nor `day` (contracts/TABLES.md). The tables
declare both as **optional** schema columns (`tenant: string`, `day: date`), make them the
sources of the identity partition fields, and record each file's values in the partition
tuple of its manifest entry. The Iceberg spec's column projection rules say a field missing
from a data file takes its value from partition metadata when an identity transform exists
for it. The Parquet files carry no field ids, so the tables set
`schema.name-mapping.default`.

Evidence, measured here:

| Reader | `required` partition columns | `optional` partition columns |
|---|---|---|
| PyIceberg 0.12.0 (pyarrow 26.0.1) | **fails**: `ResolveError: Field is required, and could not be found in the file: 5: tenant: required string` | reads; values come from the partition tuple; filters prune files |
| DuckDB 2.0.0, iceberg extension `4c0c0874c4` | reads | reads; filters prune files |

PyIceberg only consults the partition values for a missing field after it has decided the
field may be missing (`pyiceberg/io/pyarrow.py`, `ArrowProjectionVisitor.struct`), so
`required` is not usable. Hence optional. The cost: a reader that implements neither the
projection rule nor a required check would show NULL in those columns. Both readers tested
return the values, and the reader script asserts that no row has a NULL `tenant` or `day`.
Spark and Trino were not tested (they are expected to behave like the Java reference
implementation, which builds identity partition columns from metadata; that is training
knowledge, not something measured here).

Alternatives not taken: leaving the columns out of the schema (then no engine can filter on
tenant, which is the point of the partitioning); having flush write the two columns (a
contract change; see "Contract issues").

## Not implemented

- **`verify` in bounded memory.** The scrubber still replays each tenant's log from its base into
  a map, reads the base segment whole, and holds the table's manifest entries: at the ledger's
  limit (300,000 files) that is not expected to fit an isolate. It is an operator's tool, not on
  the publish path; streaming it (into `live_next`, say) is not done.
- **Re-base progress across invocations.** A re-base that is cut off (an eviction, a CPU limit)
  starts again from its checkpoint or base at the next attempt; what it staged is thrown away.
- **A fall-back to the base when a checkpoint is corrupt** (D55, alternative (e)): the tenant
  stops instead.
- **A status or alert for a stopped re-base** (review of D47, D48 and D55, P-8). A tenant whose
  re-base is `corrupt` or `incomplete` shows only in that publish's tenant report; nothing in
  the publisher's status counts it and nothing alerts. `incomplete` can recur if the ledger
  completes checkpoints faster than a re-base reads one (unlikely at the current cadence).

- **No backoff for a stuck tenant.** A tenant stopped by a hole, a corrupt or unsupported
  segment or an inconsistent change is retried every `retryMs` (1 min) for as long as it lasts.
- **Managed catalog.** Only the R2-native implementation exists. The catalog interface of
  D4 has not been extracted; a REST catalog commit would be a second implementation.
- **A release for the newest snapshot's removals in a quiet cell.** `minSnapshots` is 2, so a
  file removed by a table's newest commit is released only after a later commit to that table
  and the window; if the cell publishes nothing more, it is never released (its object stays;
  the janitor looks again every 6 h). The deleter is the janitor's purge (`janitor/README.md`).
- **Paging over tenants.** One `publish()` reads every requested tenant's log in one
  invocation. A cell with thousands of tenants needs the publish split across invocations
  (R2 calls are subrequests).
- **Publication lag.** Cursors are available (`cursors(table)`); no lag metric or alert.
- **Removed files across a state loss.** After the publisher loses its storage, files
  removed before the loss are not reported by `safeToDelete` (they leak; nothing is
  deleted early). Files added and removed inside the unread tail of an *older* ledger
  incarnation are also never reported. A sweep of data objects against the ledgers is needed
  and does not exist.
- **Trimmed ledger logs.** If old log objects are ever deleted, `verify` cannot replay from
  the base and reports the log as unreadable.
- **Both tables in one commit.** Iceberg has no multi-table commit. Each table has its own
  cursor per tenant and commits separately, samples first. Between the two commits an
  external reader can see samples whose series row is not yet in `metric_series`.
- **Readers not tested:** Spark, Trino, Snowflake, and any reader against real R2 with
  `s3://` URIs. Only `file://` URIs were read.
- **Schema or partition evolution**, delete files, branches and tags, rollup tables.

## Verification

```
npm install
npm run fixtures     # Rust: writes test/fixtures/fixture.json (already committed)
npm test             # 101 tests in workerd, 11 files, at most 2 workers; fills export/
npm run typecheck
# the re-base at scale (Measurements); one size and variant per process for clean memory figures:
MINIFLARE_WORKERD_V8_FLAGS="--max-old-space-size=32 --max-semi-space-size=4" \
  BENCH_SIZES=300000 BENCH_VARIANTS=parts RSS_LOG=<scratch>/rss.log \
  node ../ledger/bench/rss.mjs -- npm run bench -- --silent=false > <scratch>/bench.out
node bench/phases.mjs <scratch>/bench.out <scratch>/rss.log
# the readers, in a scratch virtualenv (versions as measured):
python3 -m venv <scratch>/readers-venv
<scratch>/readers-venv/bin/pip install pyiceberg==0.12.0 duckdb==2.0.0 pyarrow==26.0.1
<scratch>/readers-venv/bin/python tools/verify_readers.py export
MUTANT_DIR=<scratch>/mutants npm run mutants   # on a copy under MUTANT_DIR; see "Mutation checks"
```

**Last run (2026-11-19, with the fix for review P-1): 101 passed, 0 failed** (11 files, `npx
vitest run --maxWorkers=2`). The review's test, `test/review-skip.test.ts`, was added unchanged;
it failed 2 of 2 before the fix (three samples files missing from Iceberg, the report `ok`) and
passes after. `tsc --noEmit` and the readers script are not recorded for this run.

Before that (2026-11-19, the streaming re-base): **99 passed, 0 failed** (10 files, `npx vitest run
--maxWorkers=2`); `tsc --noEmit` clean; the readers script on the export of the run before the last test was
added (the end-to-end test unchanged since): **504 checks, 0 failed**, every content hash as in the table under "Independent readers" (the re-based stage
included). Against `ledger/src/ledger.ts` as on disk that day (checkpoints in parts, D47) and
the frozen release before it (`ledger/bench/before/`). `deploy/`'s `node --test
test/configure.test.mjs` (which requires `stack/wrangler.jsonc` and `wrangler.test.jsonc` to
differ only as it allows) passed 20 of 20 with the 16 MiB limit removed from both; the limit is
back in both since (review P-2, P-3), the same in each, and no run with it restored is recorded
here. `stack/`'s own
suite was not run for this change (its tenants are small; it imports nothing changed here).

What changed in the tests besides the new file: `TestPublisher` gained a probe under the store
(R2 operations in flight, the order of GETs, a pause, a failure or a deletion at a GET), fixed
ids and clock, `ctx.abort()`, and the `stage`/`live_next` row counts; the test worker binds the
ledger release before checkpoints in parts (`LEDGER_BEFORE`). Because a re-base now starts from
the newest checkpoint, four tests about how SEGMENTS are read (a hole; a segment, change or file
of a newer version, five cases; a backlog read change by change) drop the checkpoints from their
copy of the log (`dropCheckpoints`), with a comment saying why; two that compared a report
exactly also expect its new `rebase` field; "never reads a checkpoint, even an unreadable one"
is replaced by "a manifest that is not a checkpoint: corrupt, explicitly" (the opposite
behaviour, on purpose); the adoption test also expects `stage` and `live_next` empty.

Earlier (2026-11-19, segment reader and triggers): **77 passed, 0 failed**; `tsc --noEmit`
clean.

With the health route (2026-11-19): **78 passed, 0 failed** (9 files, `npx vitest run --maxWorkers=2`); `tsc --noEmit` clean. The one test added
(`test/smoke.test.ts`, "the Worker") calls `src/index.ts`'s `fetch`: `GET` and `HEAD /healthz` 200
`ok`, 503 `misconfigured: no BUCKET binding` without the bucket, `POST` 405, `/` and `/publish`
404. The publisher's interface did not change. Run against `ledger/src/ledger.ts` as committed at `54cc31f` (segments, base first,
checkpoints). The pool sets `LEDGER_DRAIN_DELAY_MS` to 60 s, so a ledger drains when a test
says (`drain()`, `mirror`), and `LEDGER_CHECKPOINT_EVERY` to 3, so most logs carry checkpoints
(which, since the streaming re-base, a first publication starts from). Before this change, against that ledger, 45 of 59 tests failed:
the ledger writes no per-change objects any more, and it admits only keys under its own cell,
which the tests' file keys were not. `wrangler deploy --dry-run` bundles the production entry
(111 KiB then; 157 KiB with the streaming re-base, 2026-11-19; nothing uploaded).

### Fixtures and the ledger

`tools/fixtures` is a Rust binary that depends on `engine/storage` by path. For 3 tenants
(`acme`, `globex`, `initech`; 6, 9 and 15 series) over 3 UTC days it encodes 5 flush units
each with `viz_storage::encode_segment` (two batches per unit, two of the units span
midnight) and builds 2 compactions each with `viz_storage::merge_files`: 54 Parquet files,
73,105 bytes. For every file it also records row counts and sums computed from the synthetic
rows themselves, never from the Parquet file. The files are exactly what flush produces: no
`tenant` or `day` column, no field ids, snappy, v2 data pages.

Every test drives the real `Ledger` class (`ledger/src/ledger.ts`, in the same test
script), so the logs in R2 are written by it; the first-layout tests drive the frozen as-built
ledger (`ledger/bench/asbuilt/`), the last writer of that layout. The `Ledger` writes under
`env.CELL` and admits only data keys under that cell; so that tests cannot see each other, all
but the end-to-end test copy a tenant's log objects byte for byte under a cell of their own
(`mirror` in `test/helpers.ts`), while the data keys stay under `env.CELL` (tenant names are
unique per test). The end-to-end test uses the ledger's own prefix.

Regenerated on 2026-11-19 with `engine/storage` at `0dae242` (into a scratch path, not over the
committed file): the same 54 files, byte for byte, so the same content hashes in every key.

### Independent readers

`test/e2e.test.ts` puts the 54 Parquet files into the simulated bucket and publishes four
stages, the ledgers writing their logs as segments: (1) four units per tenant; (2) a compaction per tenant; (3) retention drops one
tenant's first day, a fifth unit per tenant, and one tenant compacts it away before the
publish; (4) one tenant expires a day, its ledger loses its storage and rebuilds as
incarnation 2 (from its segments, starting incarnation 2 with a base segment), then compacts.
It then sends every object under `cell-0/` (114 objects) to a
local sink that writes them under `export/` with the same relative paths, plus
`export/expected.json`: for each stage, each table's snapshot id and the live files of each
tenant as returned by `Ledger.plan`.

**Nothing is rewritten for the local read.** The publisher in that test is configured with
`locationPrefix = file://<absolute path of export/>`, so the URIs in `metadata.json`, the
manifest lists and the manifests are the real locations of the dumped files. The script
refuses to run if the directory has moved. What this does not show is a read through
`s3://`.

`tools/verify_readers.py export`, run on 2026-11-19 on the export of the streaming re-base (and before it on that of the segment-reading
publisher), in a fresh virtualenv with PyIceberg 0.12.0 (pyarrow 26.0.1) via
`StaticTable.from_metadata` and DuckDB 2.0.0 (iceberg and avro extensions as installed for
DuckDB 2.0.0) via `iceberg_scan`: **504 checks, 0 failed** (240 PyIceberg, 256 DuckDB, 8
content hashes). For both tables, for each of the four stages (after a compaction, after a
retention expiry, after a re-base) reached by time travel from the final metadata
(`snapshot_id` / `snapshot_from_id`) and again by opening that stage's own
`vN.metadata.json`:

| Check | PyIceberg | DuckDB |
|---|---|---|
| Data files scanned are exactly the ledgers' live files | `plan_files()` | virtual column `filename`; also `iceberg_metadata` for the current snapshot |
| Rows per tenant and day equal the fixture's | yes | yes |
| Checksums per tenant and day equal the fixture's: `sum(ts)`, `sum(value)`; for series `sum(min_ts)`, `sum(max_ts)` | yes | yes |
| `tenant = X` returns exactly X's rows | yes | yes |
| `tenant = X` touches only X's files | `plan_files()` returns only X's files, fewer than all | `EXPLAIN ANALYZE`: "Total Files Read" equals X's file count and every file named is X's |
| `day = D` returns exactly D's rows and touches only D's files | yes | yes |
| No row has a NULL `tenant` or `day` | yes | (covered by the group comparison) |
| Opening the table directory alone finds the current metadata through `version-hint.text` | not applicable | yes |
| A SHA-256 over every row (all columns, sorted) is identical from PyIceberg, from DuckDB, and from the ledgers' live Parquet files read directly with pyarrow | yes | yes |

Content hashes (sha256 over every row, all columns, sorted; the same from both readers and from
the Parquet files), first 12 hex digits:

| Table | initial | compacted | expired | rebased |
|---|---|---|---|---|
| `metric_samples` | `b4a95a8a8c71` (3,450 rows) | `b4a95a8a8c71` (3,450) | `f5526a4e32d1` (3,690) | `9a5881afc385` (3,390) |
| `metric_series` | `37d07b565ec3` (180) | `a314ee83e768` (120) | `8ee872fe777a` (126) | `51e6163aea9b` (81) |

The samples hash is the same before and after compaction: the merge kept every row.

Row counts seen: `metric_samples` 3,450 rows in 18 files, then 3,450 in 12, 3,690 in 12,
3,390 in 9; `metric_series` 180, 120, 126, 81 rows.

**What a reader could not do.** DuckDB's `iceberg_scan(..., filename = true)` (the named
option) aborts with `INTERNAL Error: Attempted to access index 6 within vector of size 6`
and invalidates the connection. The virtual column `filename` without the option works. The
same abort happens on a small identity-partitioned table written by PyIceberg itself, with
the partition columns present in its data files, so it is a fault of that extension version
with identity-partitioned tables and not of how these tables are written. Everything else
attempted was readable.

### Workerd tests (101)

| Area | Tests |
|---|---|
| Avro (6) | round trip across block boundaries, both codecs; empty file; compression; unsafe long and missing field refused; corrupted file refused |
| Version order and gaps (4) | log applied in order with the cursor recorded in an immutable object; a missing segment stops the tenant, is reported, leaves others alone, stays a hole when it is right after the cursor, and is finished by the alarm once filled; a forged change that does not fit is refused; unknown and invalid tenants |
| Net changes (3) | a file added and compacted away between publications is in no manifest of any snapshot; 2 tenants with more than 40 ledger versions each published in one commit per table; a backlog larger than one publish is finished from the alarm |
| Idempotence (3) | a second publish writes nothing, also after eviction; a change that does not touch a table moves its cursor without a commit; state rebuilt from R2 after `deleteAll` with no new commit |
| Concurrency (2) | two publishes on one object serialise into one commit; two writers on one cell: one paused before the metadata write, the other commits, the loser's conditional write fails, it takes the winner's state and commits v2 with both tenants |
| Crash between steps (6) | a failure injected after each of: manifests written, manifest list written, cursor object written, metadata written, hint written, state saved. Checked right after the crash (the table is one of the two valid states and agrees with its cursor object; before the metadata write the publisher's cursors have not moved), then after eviction and a re-run: exactly one new metadata version, hint correct, `verify` clean, leftovers swept only after the grace period |
| `verify` (6) | data object gone; wrong size; extra file in a manifest; file missing from the manifests; duplicate; wrong partition value and row count; cursor ahead of the metadata; cursor behind the snapshot; missing manifest |
| Expiry and sweep (4) | window and minimum of two; time travel to every retained snapshot before and after the sweep; first sweep only marks; what remains is exactly what is referenced; a second writer's in-flight manifests survive a sweep and are never deleted once referenced; `maintain()` expires when idle; manifests merged above the limit with sequence numbers kept |
| `safeToDelete` (1) | empty until the removal is published, until the last referencing snapshot has expired, and until the grace period has passed; never a live key or another tenant's |
| New incarnation (2) | re-base after ledger storage loss removes and adds by diff, DELETED and EXISTING entries; a cursor from a newer incarnation than R2 has is refused |
| What is written (2) | format version, schema, partition spec, name mapping, partition values checked against the key layout, statistics, manifest list counts and ranges, summary; an unreadable index fragment |
| Driving (3) | `notify` then alarm, which leaves only the sweep's deadline and then none; a nudge during a running publish is kept; `locationPrefix` cannot change |
| Smoke, end to end, measurements (3) | |
| Versioned storage (`compat.test.ts`, 6) | a fresh object at the latest version (2) with the golden schema; migrations 1..N reproduce the golden of N; version 1 equals the pre-versioning `sqlite_master` (`test/fixtures/storage/v0.json`); that dump (a cell published once) adopted and migrated to 2 with every adopted row unchanged and served; a publisher left by pre-versioning code keeps publishing after adoption, verifies clean and is not migrated again after eviction; storage of a breaking N+1, with a tenant pending and due, refused by all 11 methods, alarm re-armed, every table unchanged; storage of an additive N+1 served, written, left at N+1 |
| Newer Iceberg metadata (`compat.test.ts`, 1) | a table evolved by a newer publisher (schema 1 with a new field id, `viz.format-version` 2): publish refused and the tenant left pending, sweep refused, nothing under `iceberg/` changed, SQLite not rebuilt from it, `verify` reports it |
| Versioned storage, migration 2 (`compat.test.ts`, +1) | storage at golden version 1 (no `due`) migrates to 2, keeps publishing, verifies clean, uses the new table, is not migrated twice; adoption of the pre-versioning dump now ends at version 2 with every adopted row unchanged |
| Log objects this code does not know (`compat.test.ts`, 7) | five rewrites of one real segment as a newer ledger would write it (header `v` 2, unknown header kind, change `v` 2, unknown change kind, a file of table `spans`): each stops the tenant before that segment, twice in a row, with the earlier segments published and the later one unread; restored, it catches up. The same for a change object of the first layout. The reader's accept and refuse rules, and its pinned versions equal the contract's |
| Segments (`segments.test.ts`, 9) | golden: the current ledger writes the checked-in segment bytes (only `at` differs); those bytes published stage by stage (two units in one segment; a compaction with a checkpoint beside it; retention and a unit in one segment; a new incarnation re-based from its base segment) and all at once; the first layout (as-built ledger) read, a hole in it stops the tenant, and the segment incarnation a current ledger starts on taking it over is followed; both layouts in one incarnation refused; whole segments only, and a cursor inside a segment (left by publishing through a `[5, 5]` holding the ledger's own line) finished from the holding segment once a later one exists, without re-applying the change at the cursor; overlapping segments refused before both; unreadable checkpoints ignored; `removedFiles` naming another table, or not matching `removed`, refused |
| Triggers (`triggers.test.ts`, 3) | `notify` writes nothing to R2 and publishes nothing, later nudges never push the deadline back; a nudge returns false within its bound from a publisher that is slow (5 s) or refuses, and with none bound; a tenant's day of flushes and a compaction, each nudged, then the alarm settles in 5 runs (sweep, two expiries, mark, delete) to no alarm and no deadline, every remaining metadata object referenced, and 48 idle hours run no alarm and write nothing |
| Golden formats (`golden.test.ts`, 5) | every format has a file for its version; `metadata.json` of both new tables; field ids permanent across versions; Avro schemas; the cursors object and an `add_unit` change (now read from its segment) |
| Review of D55 (`review-skip.test.ts`, 2) | the reviewer's: a tenant's `metric_samples` commits and `metric_series` fails after writing its manifests; the ledger admits more units and writes a checkpoint (format 2, then format 1) above the first table's cursor; the next publish must leave no ledger file out of Iceberg in either table |
| Re-base from checkpoints (`checkpoints.test.ts`, 22) | the real ledger writing parts (format 2): re-based from them, in part order, at most 4 requested ahead, at most 6 R2 operations in flight, no segment at or before the checkpoint read, verified; the same state from parts, from a format-1 checkpoint and from the base: **byte-identical Iceberg objects** (fixed ids and clock); a published tenant re-based on a new incarnation's parts, removing and adding by difference; a staged re-base across many tiny manifests with merges, and SQLite rebuilt from R2 alone equal row for row; a part deleted while the checkpoint is read (`incomplete`, nothing published, retried, published once back); a record changed with its size (bytes), a record dropped with the size made up (files), two parts swapped, a part of another attempt, records out of key order across parts, a manifest that is not one: `corrupt`, nothing published; a newer checkpoint format passed over for the base; the object reset (`ctx.abort()`) while paused at a GET mid-stream, and an R2 failure at a part then `evictDurableObject`: nothing committed, staged rows never used, the next publish complete; six tenants re-basing at once: at most six in flight, each tenant's parts in order and in one run (re-bases take turns); six tenants each with eight segments to read from their cursors: at most six in flight (36 without the slots); a checkpoint's tombstones released; the ledger release before parts (N-1) read from its format-1 checkpoint and then across its storage loss; a base segment that is not alone; golden: the ledger still writes the checked-in checkpoint bytes, which are published, and the segment golden's format-1 checkpoint is re-based from |

### Mutation checks

`tools/mutants.mjs` copies the component (with `contracts/` and the ledger sources it imports,
`node_modules` linked) to `$MUTANT_DIR` outside the shared tree, applies one mutant at a time
to the copy, runs the suites it names with at most 2 workers, and restores the copy's file.
The shared tree is only read (AGENTS.md). `DRY=1` only checks that every mutant's text occurs
exactly once in the source.

**Run on 2026-11-19 on the streaming re-base (the final code): 46 mutants, 45 killed, 1 survived
at first; the survivor was then killed by a test added for it** (all suites the mutants name, 18
minutes, load average 8–11). Five earlier mutants (M2, M4, M5, M6, S5) were re-targeted at the
rewritten plan, commit and gap code, same mutation, same property; all killed. The twelve new ones,
asked for with the re-base: **skip the size/digest check** (K1, K2), **publish after a missing
part** (K3, K4, K8), **read parts out of order** (K5, K6), **unbounded concurrency** (C1, C2, C3,
C4), and the tombstones a checkpoint carries (K7):

| # | Mutation | Result (tests failing) | A test that fails |
|---|---|---|---|
| K1 | skip the size check: parts that do not add up to the bytes the manifest names are used | killed (1) | a record changed, its size with it (rows 10 → 100): the parts do not add up to the bytes the manifest names |
| K2 | skip the record check: parts that do not hold the files and tombstones the manifest names are used | killed (1) | a record dropped, the bytes made up with spaces: the parts do not hold the files the manifest names |
| K3 | a missing part is skipped (the checks after it still see the shortfall) | killed (1) | a part deleted while the checkpoint is read: incomplete, retried, and published once readable |
| K4 | publish after a missing part: skipped, with no check left to notice | killed (3) | a part deleted while the checkpoint is read: incomplete, retried, and published once readable |
| K8 | a re-base that stopped still hands on its base: what it staged is published | killed (7) | a part deleted while the checkpoint is read: incomplete, retried, and published once readable |
| K5 | read parts out of order (last to first, each checked against its own key) | killed (16) | is re-based from the parts: in order, a window at a time, with every R2 operation within six, and verified |
| K6 | parts applied without the key-order check (as a reader applying them as they arrive would need) | killed (1) | records out of key order across parts (a reader that applies parts as they arrive would not see it otherwise) |
| C1 | unbounded concurrency: every part requested at once, and no connection limit | killed (2) | is re-based from the parts: in order, a window at a time, with every R2 operation within six, and verified |
| C2 | no connection limit (the window of parts kept) | **survived**, then killed (1) | six tenants with a backlog of segments, read from their cursors at once: never more than six R2 operations in flight |
| C3 | no window of parts (the connection limit kept): every part read ahead into memory | killed (1) | is re-based from the parts: in order, a window at a time, with every R2 operation within six, and verified |
| C4 | re-bases of one publish read their checkpoints all at once (no turns): a window of parts per tenant | killed (1) | six tenants re-basing at once, each from parts: never more than six R2 operations in flight, and one tenant's parts at a time |
| K7 | the tombstones of a checkpoint are not recorded (the files it skipped leak) | killed (1) | files added and removed before the checkpoint, never published, are released once no snapshot can reference them |

**C2 survived the full run.** Once re-bases took turns, the only test of the limit (six tenants
re-basing at once) never had more than six operations in flight without it: one tenant's window
of four parts, the others waiting their turn. The limit matters most on the ordinary path, six
tenants read from their cursors at once, each fetching up to six segments. A test of exactly that
was added (36 GETs in flight without the slots); C2 was run again on its own and killed. The
concurrency tests compare with literal 6 and 4, not the constants they test, so a mutant that
raises a constant raises nothing in the test.

**The fix for review P-1** (2026-11-19; not run through `tools/mutants.mjs`):

| # | Mutation | Result (tests failing) | A test that fails |
|---|---|---|---|
| P1 | both halves of the fix removed (the code before it): a table with a cursor below the checkpoint read is planned from its cursor, and nothing refuses | killed (2) | review D55: a table with a cursor below the newest checkpoint (parts, one) does not skip the changes in between |
| P2 | the refusal in `planFromCursor` removed, the `plan()` rule kept | **equivalent** | none can: with the `plan()` rule, a log read from a base or checkpoint re-bases every table below `log.start`, and a log read from a cursor starts at the lower of the two cursors, so `planFromCursor` never gets a log that starts above its cursor. Kept as defence in depth |

Earlier, on the segment reader: **34 mutants, 34 killed, 0 survived** (2026-11-19, 01:39 to
01:48). The three properties asked for with the segment reader: **stop at an unknown version** (S1,
S2, S3, M19), **never skip a hole** (S4, S5, S6, M3), **never block ingest** (I1, I2, I3; I4 and
I5 for "nothing while idle").

| # | Mutation | Result (tests failing) | A test that fails |
|---|---|---|---|
| M1 | skip the conditional write (metadata is written unconditionally) | killed (1) | lets only one of two writers create a metadata version; the other takes its state and retries |
| M2 | apply log entries out of order (changes replayed newest first) | killed (31) | applies a log in version order and records the ledger version it reflects |
| M3 | ignore a gap in the versions (first layout) | killed (1) | is still read, and a current ledger that takes the tenant over is followed into segments |
| M4 | publish gross instead of net changes (a removal of a not-yet-published file is ignored) | killed (3) | applies a log in version order and records the ledger version it reflects |
| M5 | drop DELETED handling (a removed file stays a live entry in the rewritten manifest) | killed (10) | never publishes a file that was added and removed between two publications |
| M6 | removed files are not taken out of the manifests at all | killed (10) | never publishes a file that was added and removed between two publications |
| M7 | sweep without a grace period (an unreferenced object is deleted when first seen) | killed (5) | converges after a crash right after "manifests-written" |
| M8 | cursor saved before the metadata is written | killed (2) | converges after a crash right after "metadata-written" |
| M9 | wrong partition value (day off by one) | killed (29) | applies a log in version order and records the ledger version it reflects |
| M10 | sweep on a stale view (no check that R2 has a newer metadata version) | killed (1) | does not delete the files of a commit that is in flight |
| M11 | sweep treats only the current snapshot as referenced | killed (7) | converges after a crash right after "manifests-written" |
| M12 | a removed file is handed to deletion while a retained snapshot references it | killed (2) | never publishes a file that was added and removed between two publications |
| M13 | snapshot expiry does not keep a minimum of two | killed (2) | expires snapshots from maintain() when no publish does it |
| M14 | a lost conditional write is treated as success | killed (1) | lets only one of two writers create a metadata version; the other takes its state and retries |
| M15 | re-base ignores the new base (an older incarnation cursor continues as if nothing happened) | killed (1) | re-bases from the base of the new incarnation: removes what is gone, adds what is new |
| M16 | the publisher serves storage a newer release wrote (guard removed) | killed (1) | refuses storage a newer release migrated past what it knows: every method throws schema_too_new, the alarm is re-armed, nothing written |
| M17 | a refusing publisher publishes from its alarm (and writes) | killed (1) | refuses storage a newer release migrated past what it knows: every method throws schema_too_new, the alarm is re-armed, nothing written |
| M18 | rebuilds its view from metadata a newer publisher wrote (no check in resync) | killed (1) | is never committed over, rebuilt from or swept against; publication waits and nothing in R2 changes |
| M19 | a ledger change of an unknown version is applied as if it were known (first layout) | killed (1) | in the first layout too: a change object of a newer version stops the tenant before it |
| M20 | a released migration edited in place (version 1 loses an index) | killed (2) | a fresh publisher is at the latest version, and its schema is the golden file |
| M21 | a field id reassigned (tenant of metric_samples takes the next id) | killed (2) | iceberg.metadata: a new table's metadata.json, for both tables |
| M22 | the cursors object changes shape without a format version | killed (1) | r2.cursors and read.ledger-change: the cursors object a commit writes, and the change the ledger logs |
| S1 | a segment of an unknown version or kind is skipped and the segments after it applied | killed (5) | a segment header of version 2 stops the tenant before that segment: the segments before it are published, nothing after, and it is retried until readable |
| S2 | the reader claims a segment version it was not taught (its pin raised to 2) | killed (1) | what the reader accepts, and that it reads exactly what the contract writes (a version bump there fails here until this reader is taught it) |
| S3 | a file of a table this code does not know is ignored instead of refused | killed (1) | a file of a table this code does not know stops the tenant before that segment: the segments before it are published, nothing after, and it is retried until readable |
| S4 | a hole between two segments is read past | killed (1) | stops at a hole in the versions, reports it, and continues once the hole is filled |
| S5 | a hole right after the cursor is read past (no segment holds cursor + 1) | killed (1) | stops at a hole in the versions, reports it, and continues once the hole is filled |
| S6 | overlapping segments are accepted | killed (1) | refuses overlapping segments (a retried drain that took other rows) and stops before them |
| S7 | a cursor inside a segment re-reads that segment from its start (changes at or below the cursor applied again) | killed (1) | advances over whole segments only, and finishes a cursor that sits inside one |
| I1 | a nudge waits for the publisher however long it takes | killed (1) | a nudge never holds or fails its caller: a slow publisher, a refusing one, none at all |
| I2 | a refused nudge throws into its caller (the maintenance run): both the rejection handler and the catch removed | killed (1) | a nudge never holds or fails its caller: a slow publisher, a refusing one, none at all |
| I3 | notify publishes at once instead of leaving it to the alarm | killed (3) | notify only records the nudge: no R2 operation, nothing published until the alarm, and later nudges never push the deadline back |
| I4 | the alarm keeps itself alive when nothing is due (an hourly wake) | killed (1) | maintenance runs nudge, the alarm publishes, expires and sweeps, then is gone; 48 idle hourly ticks wake nothing and write nothing |
| I5 | a commit does not schedule the sweep of what it stopped referencing | killed (1) | maintenance runs nudge, the alarm publishes, expires and sweeps, then is gone; 48 idle hourly ticks wake nothing and write nothing |

**What did not die at first, and what was done** (first full run of this set, before the last
test changes: 31 of 34 killed):

- **M17** (a refusing publisher runs its alarm) survived: the refusal test's storage had
  nothing pending or due, and the alarm now keeps the sweep's deadline, so running the alarm
  changed nothing visible. The test now nudges a tenant before the newer release takes over,
  so a refusing alarm that ran would publish and clear it. Killed.
- **S7** (a cursor inside a segment re-reads that segment from its start) survived twice. The
  first time the change at the cursor added no file; the test now puts a unit there (through a
  segment `[5, 5]` holding the ledger's own line, then the ledger's `[5, 6]`). The second time it
  survived because `plan()` also skips changes at or below the cursor, so publication was right
  anyway: equivalent at the level of the table. The reader's own promise (changes start at
  `start + 1`) is now asserted on `readTenantLog` directly. Killed.
- **I2** as first written (only the rejection handler rethrows) was equivalent: the outer
  `catch` in `nudge` turns the rejection into `false` as well. Redefined to remove both layers;
  killed.

Before this change (the versioning work), M18 survived its first run until the test required
that the publisher's own SQLite is not rebuilt from metadata it does not understand.

M8 is caught by the crash injected after the metadata write, not by one before it: the test
seams sit after each step, and the mutant saves the cursor between two of them. M2 and M9
fail almost every test because every publish replays a log and writes partition values.

The reader script has teeth too: with one file removed from one stage of one table (a copy
of `expected.json` in a scratch directory, passed with `--expected`), 25 of its 504 checks fail,
the content hash among them, and it exits 1.

### Measurements

Measured here, in workerd on this 4-core machine with a simulated R2 and other builds
running; not on Cloudflare. Times moved by a factor of about two between runs. Ledger logs
were written by real `Ledger` objects; the data objects were not created. Source:
`test/bench.test.ts`, output in `export/bench.json`. Sizes are for `metric_samples` with the
`deflate` codec and keys of realistic length and entropy.

| Publish | Manifests | Manifest list | Cursor object | metadata.json | Total written | R2 operations (list / get / head / put) | Commit time |
|---|---|---|---|---|---|---|---|
| 1 file added, new table | 3,938 B | 1,590 B | 145 B | 2,647 B | 8.3 kB | 3 / 3 / 3 / 5 | 45–95 ms |
| 100 files added, new table | 7,389 B | 1,596 B | 145 B | 2,660 B | 11.8 kB | 3 / 3 / 3 / 5 | 43–143 ms |
| 10,000 files added, 10 tenants, 110 ledger changes | 337,580 B (1 manifest) | 1,602 B | 614 B | 2,668 B | 342 kB | 21 / 21 / 12 / 5 (first layout: 21 / 121 / 2 / 5) | 0.5–1.5 s |
| +1 file on that table | 3,942 B | 1,693 B | 615 B | 3,621 B | 9.9 kB | 2 / 2 / 2 / 5 | 50–86 ms |
| 100 removed + 1 added on that table (rewrites the 10,000-entry manifest) | 341,268 B (2 manifests) | 1,731 B | 615 B | 4,592 B | 348 kB | 2 / 2 / 2 / 6 | 0.45–1.5 s |
| Idle `publish()` of every tenant, 10 tenants | 0 | 0 | 0 | 0 | 0 | 31 / 0 / 0 / 0 (first layout: 21) | – |

Ranges span the runs before and after the segment reader (the last run, 2026-11-19, is the
upper end of each, with other suites running on the machine). Reading the operation counts: 1
list for the tenants (only with no argument); per tenant 2 lists (incarnations, segments after
the cursor), 1 get per segment read (here 2 per tenant: the base segment and one segment of 11
changes, against one get per change before), 1 head on a re-base, and a third list when there
is nothing new (the first-layout check); per table with something to commit 1 get + 1 head +
5 puts (more puts only when manifests are rewritten). `verify` of the 10,000-file table
without per-object checks took 0.4–1.1 s. The idle full scan is the operator's path; nudged
publication reads only nudged tenants, and an idle cell is not published at all (D34).

A manifest costs about 3.9 kB of header (the schemas) plus about 34 bytes per file.
`metadata.json` grows by about 1 kB per retained snapshot (measured: 2.6 kB with one
snapshot, 5.7 kB with four), so at one commit every 5 minutes and a 24-hour window it is
about 290 kB per commit (modelled from that slope, not measured).

### Re-base: memory and time

Measured here, in local workerd (`bench/rebase.bench.test.ts`, 2026-11-19, load average 5–11 on
the shared machine, printed per run): not on Cloudflare. The bench writes a tenant's log with
the contract's encoders, S4-shaped (keys of about 130 characters, a version-1 index fragment of
three row groups, about 500 characters; half samples, half series, over 30 days; tombstones for
1% of the files), so that N files have the ledger's estimated state N × (key + fragment + 448
bytes): **300,000 files is 299 MiB**, the limit. Incarnation 1 is a base of N files, a segment
adding a unit, and a checkpoint at that version in the variant's format: **parts** (format 2, 246
parts at 300,000), **one** (format 1, one object; the ledger writes it only up to 1 MiB, written
here at every size to compare), **base** (no checkpoint: the 254 MB base segment, streamed),
**before** (the base, published by the frozen publisher from before this change, `bench/before/`).
Steps: the tenant's first publication (N + 2 files added), a re-base onto incarnation 2 (the
same files and a unit, a checkpoint of the same format), one unit from the cursor, and a resync
(the publisher's SQLite deleted: the re-base read again, R2's tables rebuilt into SQLite, the
attempt restarted, nothing to commit).

**The counterfactual: same data, one object or parts.** Every after-variant publishes with fixed
ids and clock (`random()` and `now()` seams) and prints a SHA-256 of every Iceberg object it
wrote: at 600, 32,040, 100,020 and 300,000 files the three variants wrote **byte-identical**
manifests, manifest lists, cursor objects, `metadata.json` and hints (one distinct digest set per
size), and every tuning step below kept them identical. `test/checkpoints.test.ts` shows the
same on the real ledger's parts, format-1 checkpoint and base.

**Memory: the isolate's heap capped.** workerd does not enforce the 128 MB isolate limit, and in
this pool the publisher shares one V8 heap with the test runner (which also writes the log), so
resident memory says little. Each variant ran in its own process with V8's heap capped
(`MINIFLARE_WORKERD_V8_FLAGS="--max-old-space-size=<MB> --max-semi-space-size=4"`, young
generation 3 × 4 MB on top); a run that does not fit dies with "JavaScript heap out of memory".

| Files (estimated state) | Publisher, read from | Old space 24 MB | 32 MB | 48 MB | 100 MB | 128 MB | 512 MB |
|---|---|---|---|---|---|---|---|
| 8,040 (8 MiB) | before, base | | completes | | | | |
| 32,040 (32 MiB) | before, base | | | out of heap (first publication) | | completes | |
| 100,020 (100 MiB) | before, base | | | | | out of heap (first publication) | completes |
| 8,040 | this, parts | completes | | | | | |
| 32,040 | this, parts | completes | completes | | | | |
| 300,000 (299 MiB) | this, parts | out of heap (first publication) | **completes** | | completes | | |
| 300,000 | this, base | | **completes** | | completes | | |
| 300,000 | this, one object | | **completes** | | completes | | |

So **the publisher's peak for a 299 MiB state is under 32 MB of old space plus 12 MB of young
generation, with the test runner in the same heap**: under the isolate's 128 MB with room to
spare, every step, every format. Some growth with size is left: at 8,040 and 32,040 files the
first publication fits in 24 MB, at 300,000 it does not (what grows was not found; it is under
8 MB across a ninefold larger state). The publisher before this change needed more than 128 MB
at 100,020 files.

Resident memory of the workerd process, sampled every 100 ms (`../ledger/bench/rss.mjs`,
`bench/phases.mjs`), growth during each phase, uncapped: this publisher at most +28 MB at 100,020
files (+0 to +22 MB from parts), at most +3 MB at 300,000 (capped runs); the publisher before,
+63 MB (first publication), +27 MB (re-base) and +88 MB (resync) at 32,040 files, and +190 MB,
+153 MB and +138 MB at 100,020.

**Time** (seconds, wall, from outside the object; the uncapped pass at 32,040 and 100,020 files,
load 7–8; at 300,000 the capped runs, the range over two or three runs, load 5–10):

| Files | Publisher, read from | First publication | Re-base | One unit from the cursor | Resync |
|---|---|---|---|---|---|
| 32,040 | this, parts | 2.7 | 0.7 | 0.02 | 2.7 |
| 32,040 | this, base | 2.9 | 2.3 | 0.08 | 4.7 |
| 32,040 | this, one object | 3.8 | 1.4 | 0.05 | 4.5 |
| 32,040 | before | 2.7 | 0.3 | 0.14 | 2.8 |
| 100,020 | this, parts | 8.8 | 2.4 | 0.08 | 10.5 |
| 100,020 | this, base | 12.0 | 6.4 | 0.05 | 17.7 |
| 100,020 | this, one object | 10.6 | 4.3 | 0.02 | 15.5 |
| 100,020 | before | 12.1 | 1.3 | 0.23 | 8.5 |
| 300,000 | this, parts | 27.5–32.1 | 8.0–8.5 | 0.17–0.30 | 28.5–31.8 |
| 300,000 | this, base | 30.3–34.1 | 9.6–13.4 | 0.16–0.28 | 30.9–48.3 |
| 300,000 | this, one object | 37.7–38.3 | 16.9–17.0 | 0.23 | 42.9–50.7 |
| 300,000 | before | does not fit an isolate | | | |

- **What got slower.** A re-base: the state is written to SQLite and diffed there instead of in a
  map (2.4 s against 1.3 s at 100,020 files, from parts; from the base, which is parsed a
  character at a time, 6.4 s). A resync step reads the re-base twice (once before the conflict
  that sends it to R2, once after) and then rebuilds through `live_next`. A first publication
  is about as fast as before (8.8 s against 12.1 s at 100,020).
- **Parts are the fastest start**: their lines are parsed whole (`JSON.parse`), a base's elements
  by `JsonObjectStream`; four parts are read while one is applied.
- **Tuning steps, in order, each measured on the same data and required to keep the output
  identical:** (1) statistics computed only for added files, at their manifest, not for every
  staged file (the re-base at 100,020 files from parts 6.4 s → 2.3 s, the resync step 22.7 s →
  9.2 s; a re-base that publishes few files computes few); (2) manifest entries built as the
  Avro encoder reaches them instead of all 10,000 of a manifest first (the first publication at
  300,000 files went from out of heap at 48 MB to fitting 32 MB); (3) a resync decodes manifests
  record by record into `live_next`, 500 per transaction (the resync step went from out of heap
  at 48 MB to fitting 32 MB). Not tried: one manifest in flight instead of two, keeping a base's
  members other than files out of the parser. The cap search at 300,000 was rerun after each.
- **The last change** (re-bases of one publish take turns reading their checkpoint or base) came
  after most of these runs. It does nothing for a single tenant, which is what the bench measures;
  parts and base at 300,000 files were run once more on the final code under the 32 MB cap:
  completed, same digests (their times are in the ranges above).
- **On Cloudflare** none of this is measured: R2 reads there take tens of milliseconds each (a
  re-base from parts is 247 GETs, four at a time) and the CPU an invocation may use is limited
  (Risks). Modelled, the reads add 3–12 s to a 300,000-file re-base from parts (247 reads of
  about 0.05 s, four at a time to one at a time); the CPU time is the open question.

## Risks

- **Refusals stall publication, not ingest.** A refusing publisher (newer storage) or a table
  a newer publisher evolved leaves external readers on older snapshots until the newer release
  runs again (D15: the publisher is never upstream of ingest). The alarm retries every
  `retryMs`, so a long rollback costs one R2 list per pending tenant per minute.

- **Cost of discovery.** An idle `publish()` with no argument costs 1 + 3 × tenants R2 list
  operations (measured: 31 for 10 tenants; the third list per tenant looks for the first
  layout). Nothing calls it on a schedule any more (D34): the nudge path reads only nudged
  tenants, and an idle cell is not read at all. If an operator ran it every 5 minutes on
  10,000 tenants it would be about 8.6 million list operations a day (modelled from the
  measured count).
- **Nudges are the only trigger.** If the stack's maintenance run stops following every flush,
  or stops nudging, publication stops (external readers see old snapshots; nothing upstream is
  affected). A nudge that is not recorded is retried through the maintenance marker (an hour);
  one that is recorded but whose changes were not yet logged when the publish read the log is
  caught by the next run of that tenant, which the purge of the change's tombstones brings
  (by the delete grace, 1 h). Wired in `stack/` since 2026-11-19 and run on Cloudflare in
  Trial 3 (`deploy/README.md`): every maintenance run nudged (`notify` and `safeToDelete` the
  only calls the publisher saw), and its alarm committed both tables 2 minutes after the first
  nudges, and again after each later round, with nobody calling `publish`.
- **A stuck tenant costs a wake a minute.** A hole, a corrupt or unsupported segment, or an
  inconsistent change keeps the tenant pending and the alarm retrying every `retryMs`, not
  backed off: about 1,440 wakes and a few thousand R2 operations a day for as long as it lasts
  (modelled from the per-publish counts above).
- **A cursor inside the newest segment waits.** This reader advances over whole segments only,
  so it never leaves one; a cursor left inside the newest segment by another release is
  finished only when the ledger writes the next segment (`test/segments.test.ts`).
- **Rewriting large manifests.** Removing one file from a 10,000-entry manifest rewrites
  all of it (0.45–1.0 s here). Compaction touches many files of a tenant-day; manifests are
  ordered by tenant and day when appended or merged, but a manifest written by one large
  append still mixes tenants. Smaller `manifestTargetEntries` trades more manifests for
  cheaper rewrites; not tuned.
- **One SQLite row per live data file** in the publisher (and one write per file added or
  moved to another manifest). Fine at 10,000; at millions of files per cell it is a storage
  and billing cost that has not been measured.
- **Optional partition columns.** A reader that ignores the projection rule shows NULLs
  rather than failing. See "The partition columns".
- **Name mapping.** Readers must honour `schema.name-mapping.default`. PyIceberg 0.12.0 and
  DuckDB 2.0.0 do; others untested.
- **Two writers.** The conditional write makes a second writer safe for the table, and the
  loser converges. But the hint is an unconditional write, so with two writers it can
  briefly name an older (still valid) version, and a sweep by a writer with a stale view
  is protected only by its staleness check and the grace period.
- **`verify` cost.** It reads every segment of every tenant since the incarnation's base and
  does one HEAD per data file, and it holds each tenant's replayed live set and the table's
  manifest entries in memory (Not implemented). It does not start from a checkpoint, so this
  grows with the incarnation.
- **Clock.** Snapshot expiry, the orphan grace period and the delete grace period use the
  Durable Object's clock.
- **Memory and time for a very large catch-up.** All changes read in one publish are held
  in memory (bounded by `maxChangesPerTenant` = 2,000 per tenant, not across tenants), and so
  are the files they add (a tenant read from its cursor is planned in memory; a re-based one is
  not). A change is one ledger SQLite value (at most 2 MB), so this is up to the changes' size,
  not the state's; with S4's 2,000-file units it could be large, and it is not measured.
- **CPU time of a re-base at the limit.** At 300,000 files a re-base took 8–17 s and a first
  publication 27–38 s here (Measurements), wall time on a loaded machine with a local R2. On
  Cloudflare an invocation's CPU is limited (30 s by default for a Durable Object, raised with
  `limits.cpu_ms`; training knowledge, not checked here); a publish that is cut off is retried
  by the alarm and would be cut off again. Not measured on Cloudflare. The experiment that
  settles it: viz-publisher on Cloudflare re-basing a tenant of 300,000 files (the bench's log,
  written to a `viz-` bucket), its CPU time read from the analytics API.
- **A corrupt checkpoint stops that tenant's re-base** (explicitly: `corrupt`, retried every
  `retryMs`) until the ledger writes a newer one, which supersedes and deletes it, or an
  operator removes it. The ledger's own rebuild passes over such a checkpoint for the base; this
  publisher refuses rather than read around it (D55, "would change if"). Only the tenant report
  shows it (Not implemented).
- **Row writes of a re-base.** Every file of a re-based tenant is written to `stage` and deleted
  after (about two row writes per file; a first publication also updates each added row with
  its statistics): about 600,000 at the limit, modelled at $0.60 per re-base at $1 per million
  rows written (the price is training knowledge). A re-base happens at a ledger storage loss,
  a new tenant, or a publisher storage loss.
- **Key order.** Manifests are filled in `(tenant, day, key)` order; `stage` is read in SQLite's
  order and in-memory adds in JavaScript's. They agree for ASCII, which tenant ids, days and the
  key layout are; for other keys the order of entries in a manifest could differ, not what it
  holds.
- **House rule not followed to the letter.** AGENTS.md wants every SQL statement that
  touches tenant data to name the tenant. The publisher is a cell-level object whose
  manifests are shared by tenants, so the statements that rewrite or merge a manifest and
  the ones that rebuild state select by table and manifest, not by tenant. Statements about
  one file or one tenant's files do name the tenant. Its callers are internal; a tenant id
  passed to it is not a credential check.
- **Reviews.** The streaming re-base (D55: reading checkpoints, the staged diff, the six slots)
  was reviewed adversarially on 2026-11-19 (`design/reviews/d47-d48-d55.md`). It found one
  blocker, P-1, fixed above with the review's test; P-8 is open (Not implemented). No
  adversarial review of the commit protocol, the segment reader or the trigger has been done
  (AGENTS.md asks for one before building on it), and the publisher is not in the protocol model
  (spec/README.md, "Not modelled").

## Needed changes

In components others own; not edited from here. **1, 2 and 3 are done** (2026-11-19: `stack/`,
`deploy/`, `janitor/`; their READMEs say how and how it was tested); kept below as asked.

1. **stack: nudge the publisher from every maintenance run** (D34). In the Worker that consumes
   `viz-maint`, bind the publisher's namespace, `{ "name": "PUBLISHER", "class_name":
   "Publisher", "script_name": "viz-publisher" }` (and the same in `deploy/`). At the end of
   `maintainTenant` (`stack/src/maintain.ts`), after the run's own ledger changes and before the
   marker is settled:

   ```ts
   import { nudge } from '../../publisher/src/nudge'
   // ...
   if (env.PUBLISHER && !(await nudge(env.PUBLISHER, env.CELL ?? 'cell-0', [tenant]))) due.push(Date.now() + HOUR_MS)
   ```

   `nudge` waits at most 2 s and never throws. Only with the binding: a deployment without a
   publisher must not mark every tenant due hourly. In `stack/test/triggers.test.ts`, count
   `PUBLISHER.get` in `counting(...)` and require 0 across the idle deployment's crons, and add
   one test where a flush leads to a maintenance run and the tenant pending in the publisher.
2. **deploy: the publisher before its caller.** Deploy `viz-publisher` (this Worker: the
   `Publisher` class with migration tag v1, the cell's bucket as `BUCKET`,
   `ICEBERG_LOCATION_PREFIX`) before the stack binds it (callee first, COMPATIBILITY.md §3.3).
   Nothing was deployed here.
3. **janitor: physical deletion waits for publication** (DESIGN §5.2, §5.3). `purgeTenant`
   releases a removed file on the ledger's tombstone rules alone, so once publication runs it
   can delete a file that a retained Iceberg snapshot still references, and external readers of
   that snapshot fail. It should also require the publisher's `safeToDelete(tenant)` to list the
   key (removal published, no retained snapshot references it, grace passed), and report what
   it deleted with `acknowledgeDeleted`. Until the nudge is wired this cannot happen, because
   nothing is published.
4. **contracts/LEDGER-LOG.md** (the ledger's owner): mark the publisher's read-back as shown,
   drop the pointer to a "Needed changes" section of `ledger/README.md` that does not exist,
   and say how a cursor inside the newest segment is finished (Contract issues 10, 11).
5. **ledger/README.md** still describes one R2 object per change, with no segments, checkpoints
   or `removedFiles`; the publisher was written against `contracts/LEDGER-LOG.md` and
   `ledger/src/ledger.ts` instead. (Since done by the ledger's engineer.)
6. **contracts/LEDGER-LOG.md** (the ledger's owner): the publisher now reads checkpoints, and no
   longer reads a base whole (Contract issues 12–14). Not edited from here.
7. **deploy**: viz-publisher with the streaming re-base must run before, or together with, any
   viz-ingest whose ledger allows more than 16 MiB: readers first. This release keeps
   `LEDGER_STATE_MAX_BYTES` at 16 MiB (`stack/wrangler.jsonc`; review P-2 and P-3); the limit is
   lifted in a later release whose rollback floor is this one. The deploy already deploys
   viz-publisher before viz-ingest. Once the limit is lifted, rolling viz-publisher back below
   this release while a tenant is above about 16 MiB brings back the old risk (a re-base that
   does not fit), for that tenant's re-bases only; its storage (migration 3, additive) is
   readable by the release before.

## Contract issues

Recorded here because this work could not change `contracts/`, `ledger/`, `engine/` or
`design/` (except `design/DECISIONS.md` D34 and small edits to `DESIGN.md` §3.1, §5.3 and
`UPGRADES.md`, made with this change).

1. **Resolved: `LedgerChange.removed` is keys only.** The segment contract adds
   `removedFiles` (`{key, table}`) beside it, and the reader uses it: a removal is placed by its
   table, and one that names another table than the live file's is refused. For logs written
   before it (the first layout), the key layout of TABLES.md is still the fallback.
2. **Resolved: the meaning of `base.version`** is now in contracts/LEDGER-LOG.md ("The base":
   the incarnation's first change is `version + 1`).
10. **contracts/LEDGER-LOG.md is behind this work in two places** (not edited from here). Its
    "What has to be shown" says the publisher and an independent reader seeing the same table
    across the change of log format is "not shown"; it is now (`test/segments.test.ts` with the
    as-built ledger for the first layout; `tools/verify_readers.py` on segments). And "The exact
    change to `publisher/src/log.ts` is in `ledger/README.md`, 'Needed changes'" points at a
    section that does not exist (`ledger/README.md` still describes the first layout).
11. **The contract does not cover a cursor inside the newest segment.** "Readers of the log"
    says what to do when the first segment after the cursor starts above `version + 1`; when no
    segment starts after the cursor, a reader cannot tell "at a segment end" from "inside the
    last segment" without listing the incarnation. This reader waits for the next segment
    (Risks). Proposal: say that readers advance over whole segments only, so the case arises
    only across releases, and that it is finished by the next segment.
3. **`tenant` and `day` are not columns of the data files.** This works (see above) but
   forces the two columns to be optional in the Iceberg schema, because PyIceberg rejects
   missing required fields. If flush wrote both columns (one distinct value per file, so a
   few bytes with dictionary encoding), they could be required and no reader would depend on
   the projection rule. Proposal to consider, not made.
4. **No field ids in the Parquet files.** The tables rely on `schema.name-mapping.default`.
   Writing Parquet field ids (`metric_name` 1, `series_id` 2, ... as in `src/iceberg.ts`)
   would remove that dependency. Proposal for `engine/storage`.
5. **`FileEntry.index` is declared opaque** ("produced and read only by the engine"), yet it
   is the only source of `metric_name` bounds and row-group offsets. The publisher parses
   version 1 of it and tolerates anything else. Either the contract exposes those values or
   it names the fragment format as something the publisher may read.
6. **`ts` is an INT64 of Unix milliseconds, not a timestamp type.** External engines see a
   `long`, and Iceberg cannot derive `day` from it (no hidden partitioning), which is why
   `day` is a separate identity-partitioned column. DESIGN §5.1 says "Iceberg format v2
   types"; this is the one place the tables do not use the Iceberg type an analyst expects.
7. **The cell is configured twice.** The ledger takes it from `env.CELL`, the publisher from
   its object name. Nothing ties them together.
8. **DESIGN §5.3 text to update** (not edited from here): cursors are per table as well as
   per tenant, and the two tables commit separately; the partition columns are optional
   schema columns filled from partition metadata; a snapshot is written only when a table's
   file set changes, so a cursor can be ahead of the newest cursor object when the changes
   in between did not touch that table.
9. The partition-column choice and the DELETED-entry choice are decisions between real
   alternatives and should get entries in `design/DECISIONS.md`.
12. **The publisher now reads checkpoints; contracts/LEDGER-LOG.md says nothing but the ledger
    does** (not edited from here: the contract is the ledger's). "Checkpoints": "A checkpoint is
    only an accelerator for a rebuild. Nothing else reads it"; "Truncation": "(only the ledger's
    rebuild reads them)"; "Versions": "the publisher never reads checkpoints"; "Size": "The
    publisher still reads a new incarnation's base whole ... until it reads it with
    `readLedgerLogStream`". Proposed text: a re-base (the publisher) starts from the newest
    checkpoint it reads, else the base, both streamed; a checkpoint of a format a reader does not
    know is passed over for the base (so checkpoint formats still need no readers-first
    release); the ledger may delete a superseded checkpoint's parts while a reader reads them,
    and the reader then stops (`incomplete`) and lists again. And in "Readers of the log": the
    publisher's re-base is from the newest checkpoint or the base.
13. **A checkpoint manifest names no per-part size or digest.** It carries `parts`, `files`,
    `tombstones` and `bytes` (all parts, called "informational"). The publisher checks every part
    against its key and these totals, `bytes` included (the ledger writes it from each PUT's
    stored size, so it is exact), but a change inside one record that keeps its length is not
    detectable, and a part can only be judged once all have been read. Proposal: the manifest
    lists each part's size and SHA-256 (format 3); readers check each part as it arrives. Also
    (review of D47, D48 and D55, N-3): `contracts/ledger.ts` calls `bytes` informational, yet this
    reader refuses a mismatch as `corrupt` (`src/log.ts`). One of the two should change: the
    contract making `bytes` binding, or the reader ignoring it.
14. **A base's `added` has no promised order.** Checkpoint parts are in key order (stated); a
    base's elements are written from SQLite in key order but the contract does not say so. With
    it stated, a re-base could merge a base against what is published without staging it (D55,
    "would change if").
