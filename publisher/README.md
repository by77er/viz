# Publisher

Turns the tenants' ledger change logs into Iceberg tables that external engines can read
(design/DESIGN.md §5.3, decisions D2, D4, D15). One SQLite Durable Object per cell, named by
the cell id, is the only writer of that cell's Iceberg metadata. viz's own queries never read
what it writes, and nothing on the ingest or query path calls it: if it is slow or stopped,
external readers see older data and physical deletes wait. Nothing else.

| File | Contents |
|---|---|
| `src/publisher.ts` | `Publisher`: publish, commit, resync, expire, sweep, `verify`, `safeToDelete`, alarm |
| `src/log.ts` | Reading a ledger's R2 log: changes after a cursor in version order up to the first hole; a strict replay for `verify` |
| `src/iceberg.ts` | Table schemas, Avro schemas of v2 manifests and manifest lists, `metadata.json`, per-file statistics |
| `src/avro.ts` | Avro object container reader and writer (about 300 lines, no dependency) |
| `test/` | 45 tests in workerd with a simulated R2, against the real `Ledger` class |
| `tools/fixtures/` | Rust: real Parquet files made with `viz_storage::encode_segment` and `merge_files` |
| `tools/verify_readers.py` | PyIceberg and DuckDB read the published tables and are compared with the ledgers |
| `tools/mutants.mjs` | Mutation checks |

Bindings: Durable Object `PUBLISHER`, R2 bucket `BUCKET`, variable `ICEBERG_LOCATION_PREFIX`
(default `s3://viz-lake`).

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

**Driving it.** `publish(tenants?)` publishes now; with no argument it lists every tenant
that has a ledger log in the cell. `notify(tenants)` records tenants as pending and sets the
alarm `publishIntervalMs` (2 min) ahead, so nudges coalesce into one commit. The alarm exists
only while something is pending: after a `notify`, after a publish that hit a hole or failed,
or while a backlog is larger than one publish reads. An idle publisher has no alarm.

What will call it (neither exists yet): a queue consumer that receives `{cell, tenant}` from
the ledger after a drain and calls `notify`; and a cron that calls `publish()` (which catches
lost nudges) and `maintain()` (snapshot expiry when no publish did it, and the orphan sweep).

**Reading the log.** For each tenant and table there is a cursor `(ledgerIncarnation,
version)`. The log is listed after the cursor, sorted by version number, and read only as
far as the versions are contiguous. A hole stops that tenant there and is reported
(`status: 'gap'`, `gapAt`); the tenant stays pending. A newer ledger incarnation makes the
publisher start again from that incarnation's `base`: it diffs the base's live set (plus
the changes after it) against what is published for the tenant, removes what is gone and adds
what is new. A change that does not fit the published state (it adds a live key, or removes
a key of this table that is not live) stops the tenant with `status: 'inconsistent'`.

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
  below `minSnapshots` (2; a lower setting is refused). `metadata-log` keeps 20 entries.
- The snapshot summary has the standard counts and `viz.ledger-cursors`, the URI of the
  cursor object. The map is not inline.

**If SQLite and R2 disagree.** R2 is the truth about what is published; SQLite caches the
current snapshot's files, which manifest holds each, and the cursors. Before a commit the
publisher reads the metadata version it believes is current and checks that the next one
does not exist. If either fails, or its conditional write loses, it rebuilds SQLite from R2
(metadata, manifest list, manifests, cursor object) and starts the publish over with a fresh
read of the logs. That one path covers a crash after the metadata write, a second writer,
and lost Durable Object storage.

**Orphan sweep.** `sweep()` lists the metadata prefix and deletes what the current metadata
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

- **Triggers.** No queue consumer, no cron handler, and the ledger sends no nudge. The
  Worker entry only exports the class.
- **Managed catalog.** Only the R2-native implementation exists. The catalog interface of
  D4 has not been extracted; a REST catalog commit would be a second implementation.
- **The deleter.** `safeToDelete` and `acknowledgeDeleted` exist; nothing calls them or
  deletes data objects.
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
npm test             # 45 tests in workerd, 5 files; fills export/
npm run typecheck
npm run readers      # PyIceberg and DuckDB on export/
npm run mutants      # about 8 minutes
```

Last run: 45 passed, 0 failed, three runs in a row; `tsc --noEmit` clean;
`wrangler deploy --dry-run` bundles the production entry.

### Fixtures and the ledger

`tools/fixtures` is a Rust binary that depends on `engine/storage` by path. For 3 tenants
(`acme`, `globex`, `initech`; 6, 9 and 15 series) over 3 UTC days it encodes 5 flush units
each with `viz_storage::encode_segment` (two batches per unit, two of the units span
midnight) and builds 2 compactions each with `viz_storage::merge_files`: 54 Parquet files,
73,105 bytes. For every file it also records row counts and sums computed from the synthetic
rows themselves, never from the Parquet file. The files are exactly what flush produces: no
`tenant` or `day` column, no field ids, snappy, v2 data pages.

Every test drives the real `Ledger` class (`ledger/src/ledger.ts`, in the same test
script), so the logs in R2 are written by it. The `Ledger` writes under `env.CELL`; so that
tests cannot see each other, all but the end-to-end test copy a tenant's log objects byte
for byte under a cell of their own (`mirror` in `test/helpers.ts`). The end-to-end test uses
the ledger's own prefix.

### Independent readers

`test/e2e.test.ts` puts the 54 Parquet files into the simulated bucket and publishes four
stages: (1) four units per tenant; (2) a compaction per tenant; (3) retention drops one
tenant's first day, a fifth unit per tenant, and one tenant compacts it away before the
publish; (4) one tenant expires a day, its ledger loses its storage and rebuilds as
incarnation 2, then compacts. It then sends every object under `cell-0/` (127 objects) to a
local sink that writes them under `export/` with the same relative paths, plus
`export/expected.json`: for each stage, each table's snapshot id and the live files of each
tenant as returned by `Ledger.plan`.

**Nothing is rewritten for the local read.** The publisher in that test is configured with
`locationPrefix = file://<absolute path of export/>`, so the URIs in `metadata.json`, the
manifest lists and the manifests are the real locations of the dumped files. The script
refuses to run if the directory has moved. What this does not show is a read through
`s3://`.

`tools/verify_readers.py export`, with PyIceberg 0.12.0 (pyarrow 26.0.1) via
`StaticTable.from_metadata` and DuckDB 2.0.0 (iceberg extension `4c0c0874c4`, avro extension
`345c3f4e82`) via `iceberg_scan`: **496 checks, 0 failed** (240 PyIceberg, 256 DuckDB). For
both tables, for each of the four stages reached by time travel from the final metadata
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

Row counts seen: `metric_samples` 3,450 rows in 18 files, then 3,450 in 12, 3,690 in 12,
3,390 in 9; `metric_series` 180, 120, 126, 81 rows.

**What a reader could not do.** DuckDB's `iceberg_scan(..., filename = true)` (the named
option) aborts with `INTERNAL Error: Attempted to access index 6 within vector of size 6`
and invalidates the connection. The virtual column `filename` without the option works. The
same abort happens on a small identity-partitioned table written by PyIceberg itself, with
the partition columns present in its data files, so it is a fault of that extension version
with identity-partitioned tables and not of how these tables are written. Everything else
attempted was readable.

### Workerd tests (45)

| Area | Tests |
|---|---|
| Avro (6) | round trip across block boundaries, both codecs; empty file; compression; unsafe long and missing field refused; corrupted file refused |
| Version order and gaps (4) | log applied in order with the cursor recorded in an immutable object; a hole stops the tenant, is reported, leaves others alone, and is finished by the alarm once filled; a change that does not fit is refused; unknown and invalid tenants |
| Net changes (3) | a file added and compacted away between publications is in no manifest of any snapshot; 2 tenants × 42 ledger versions published in one commit per table; a backlog larger than one publish is finished from the alarm |
| Idempotence (3) | a second publish writes nothing, also after eviction; a change that does not touch a table moves its cursor without a commit; state rebuilt from R2 after `deleteAll` with no new commit |
| Concurrency (2) | two publishes on one object serialise into one commit; two writers on one cell: one paused before the metadata write, the other commits, the loser's conditional write fails, it takes the winner's state and commits v2 with both tenants |
| Crash between steps (6) | a failure injected after each of: manifests written, manifest list written, cursor object written, metadata written, hint written, state saved. Checked right after the crash (the table is one of the two valid states and agrees with its cursor object; before the metadata write the publisher's cursors have not moved), then after eviction and a re-run: exactly one new metadata version, hint correct, `verify` clean, leftovers swept only after the grace period |
| `verify` (6) | data object gone; wrong size; extra file in a manifest; file missing from the manifests; duplicate; wrong partition value and row count; cursor ahead of the metadata; cursor behind the snapshot; missing manifest |
| Expiry and sweep (4) | window and minimum of two; time travel to every retained snapshot before and after the sweep; first sweep only marks; what remains is exactly what is referenced; a second writer's in-flight manifests survive a sweep and are never deleted once referenced; `maintain()` expires when idle; manifests merged above the limit with sequence numbers kept |
| `safeToDelete` (1) | empty until the removal is published, until the last referencing snapshot has expired, and until the grace period has passed; never a live key or another tenant's |
| New incarnation (2) | re-base after ledger storage loss removes and adds by diff, DELETED and EXISTING entries; a cursor from a newer incarnation than R2 has is refused |
| What is written (2) | format version, schema, partition spec, name mapping, partition values checked against the key layout, statistics, manifest list counts and ranges, summary; an unreadable index fragment |
| Driving (3) | `notify` then alarm, no alarm when idle; a nudge during a running publish is kept; `locationPrefix` cannot change |
| Smoke, end to end, measurements (3) | |

### Mutation checks

Each mutation was applied to the source alone, `test/publisher.test.ts` run, and the source
restored (`tools/mutants.mjs`). MUTANT_SUMMARY

MUTANT_TABLE

### Measurements

Measured here, in workerd on this 4-core machine with a simulated R2 and other builds
running; not on Cloudflare. Times moved by a factor of about two between runs. Ledger logs
were written by real `Ledger` objects; the data objects were not created. Source:
`test/bench.test.ts`, output in `export/bench.json`. Sizes are for `metric_samples` with the
`deflate` codec and keys of realistic length and entropy.

| Publish | Manifests | Manifest list | Cursor object | metadata.json | Total written | R2 operations (list / get / head / put) | Commit time |
|---|---|---|---|---|---|---|---|
| 1 file added, new table | 3,936 B | 1,590 B | 139 B | 2,622 B | 8.3 kB | 3 / 4 / 2 / 5 | 45–51 ms |
| 100 files added, new table | 7,387 B | 1,596 B | 139 B | 2,635 B | 11.8 kB | 3 / 4 / 2 / 5 | 43–74 ms |
| 10,000 files added, 10 tenants, 110 ledger changes | 337,200 B (1 manifest) | 1,604 B | 609 B | 2,649 B | 342 kB | 21 / 121 / 2 / 5 | 0.5–1.3 s |
| +1 file on that table | 3,941 B | 1,695 B | 609 B | 3,601 B | 9.8 kB | 2 / 2 / 2 / 5 | 50–86 ms |
| 100 removed + 1 added on that table (rewrites the 10,000-entry manifest) | 340,886 B (2 manifests) | 1,731 B | 609 B | 4,572 B | 348 kB | 2 / 2 / 2 / 6 | 0.45–1.0 s |
| Idle, 10 tenants | 0 | 0 | 0 | 0 | 0 | 21 / 0 / 0 / 0 | – |

Reading the operation counts: 1 list for the tenants (only with no argument), 2 lists per
tenant (incarnations, versions after the cursor), 1 get per unread change, and per table
with something to commit 1 get + 1 head + 5 puts (more puts only when manifests are
rewritten). `verify` of the 10,000-file table without per-object checks took 0.4–0.8 s.

A manifest costs about 3.9 kB of header (the schemas) plus about 34 bytes per file.
`metadata.json` grows by about 1 kB per retained snapshot (measured: 2.6 kB with one
snapshot, 5.7 kB with four), so at one commit every 5 minutes and a 24-hour window it is
about 290 kB per commit (modelled from that slope, not measured).

## Risks

- **Cost of discovery.** An idle `publish()` with no argument costs 1 + 2 × tenants R2 list
  operations (measured: 21 for 10 tenants). Modelled, with R2's list price taken from
  training knowledge: 10,000 tenants every 5 minutes is about 5.8 million list operations
  a day. The nudge path (`notify`) avoids it; the full scan should be rare. Settle it by
  running the cron on a real cell and reading R2 analytics.
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
- **`verify` cost.** It reads every change of every tenant since the incarnation's base and
  does one HEAD per data file. With no ledger checkpoints this grows without bound.
- **Clock.** Snapshot expiry, the orphan grace period and the delete grace period use the
  Durable Object's clock.
- **Memory and time for a very large catch-up.** All changes read in one publish are held
  in memory (bounded by `maxChangesPerTenant` = 2,000 per tenant, not across tenants).
- No adversarial review of the commit protocol has been done (AGENTS.md asks for one before
  building on it).

## Contract issues

Recorded here because this work could not change `contracts/`, `ledger/`, `engine/` or
`design/`.

1. **`LedgerChange.removed` is keys only.** A consumer that follows one table cannot tell
   which table a removed key belongs to. The publisher uses the key layout of TABLES.md
   (`{cell}/data/{table}/...`) to decide whether a removal it cannot place is an error; for
   keys that do not follow the layout it cannot check. Proposal: `removed: {table, key}[]`,
   or state in the contract that keys always follow the layout.
2. **The meaning of `base.version`** ("the version the incarnation starts from; the first
   change after it is `version + 1`") is only in a comment in `ledger/src/ledger.ts`. The
   publisher depends on it. It belongs in `contracts/ledger.ts`.
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
