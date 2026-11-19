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
| `src/iceberg.ts` | Table schemas (the metric pair; the span and log tables with nested types and pinned nested field ids, `SIGNAL_DEFS`), name mappings, partition specs (`hour(start_time)` for `spans`), Avro schemas of v2 manifests and manifest lists, `metadata.json`, per-file statistics |
| `src/avro.ts` | Avro object container reader and writer (about 300 lines, no dependency) |
| `src/schema.ts` | The publisher's storage as versioned migrations (`PUBLISHER_SCHEMA`), and `FORMATS`: the versions of what it writes and reads |
| `test/` | 125 tests in workerd with a simulated R2, against the real `Ledger` class (and the frozen as-built one for the first layout, and the frozen release before checkpoints in parts) |
| `test/d64/` | This publisher as committed at `bcfe8db`, frozen: the D64 release, which reads the span and log tables and does not publish them; release N-1 of this one, and by D64's rollout rule the oldest rollback target once `INGEST_SIGNALS` is on (`test/signals.test.ts`) |
| `test/n1/` | This publisher as committed at `9292abb`, frozen: the release before D64 (N-2 now), which stops at a span or log change; kept for the metric byte-identity counterfactual; one type-only edit, said in the file |
| `test/fixtures/signals.json` | Real `spans`, `trace_index` and `logs` Parquet files (48 files, 485 kB) made by viz's write path from stack/test's OTLP corpus (`tools/signal_fixture.mjs`) |
| `bench/` | The re-base at the ledger's state limit (`rebase.bench.test.ts`), the frozen publisher from before it streamed (`before/`, the counterfactual), `phases.mjs` (memory per phase) |
| `tools/fixtures/` | Rust: real Parquet files made with `viz_storage::encode_segment` and `merge_files` |
| `tools/verify_readers.py` | PyIceberg and DuckDB read the published metric tables and are compared with the ledgers |
| `tools/signal_fixture.mjs` | Makes `test/fixtures/signals.json`: edge's OTLP corpus through stack/'s write path in workerd (the corpus mode of `stack/test/signals.test.ts`, run, not changed) |
| `tools/verify_signal_readers.py` | PyIceberg and DuckDB read the span and log tables (every column, nested ones included, pruning by tenant, hour and day) and are compared with pyarrow on the files; writes what they read for `tools/signals-check` |
| `tools/signals-check/` | Rust: viz-storage's readers, viz-traceql and viz-logql on the same files, compared with what PyIceberg and DuckDB read |
| `tools/mutants.mjs` | Mutation checks |

Bindings: Durable Object `PUBLISHER`, R2 bucket `BUCKET`, variable `ICEBERG_LOCATION_PREFIX`
(default `s3://viz-lake`). Deployed as **viz-publisher**, before viz-ingest, which binds its
`Publisher` class (`deploy/workers.json`). The Worker answers only `GET /healthz` (200 `ok`
with both bindings, 503 naming a missing one, 404 for anything else; it calls no object), for
the deploy's record of a health route; nothing reaches the publisher over HTTP.

## What is implemented

**Tables.** One Iceberg table per viz table per cell, shared by the cell's tenants, format
version 2, with the engine's sort order declared: `metric_samples` and `metric_series`,
partitioned by `identity(tenant)` and `identity(day)`; and since design/DECISIONS.md D67 `spans`
(`identity(tenant)`, `hour(start_time)`), `trace_index` and `logs` (`identity(tenant)`,
`identity(day)`): "The span and log tables", below. They commit in that order, the metric pair
first. Metadata lives under `{cell}/iceberg/{table}/metadata/`:

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
| `publish` | `notify`; a publish that left tenants pending (a hole, a refusal, a backlog larger than one publish reads): `retryMs` (1 min); one that stopped at a per-publish cap: `continueMs` (1 s); the alarm itself just before it publishes, `retryMs` ahead (a lease: "Bounded work per publish") | publishes the pending tenants, within the per-publish caps (whenever the alarm runs) |
| `sweep` | a commit, or an attempt that failed: `orphanGraceMs` (1 h) later, unless one is due sooner; after a sweep that marked objects: their grace end | the orphan sweep of every table |
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
this publisher does not know (any table but the five of `LedgerTable`, pinned in `src/log.ts`)
stops it before that whole segment (`unsupported`, `gapAt` = the segment's first version). The
span and log tables are known and published ("The span and log tables"). Nothing after a stop is read, so nothing is ever skipped; the tenant
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

**Re-base in bounded memory** (design/DECISIONS.md D55, since 2026-11-19; it lifted production's
16 MiB pin of the ledger's state, `stack/wrangler.jsonc`). A tenant with no cursor in the newest
ledger incarnation is re-based, and nothing in it grows with the tenant's size:

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
- **Tombstones.** A checkpoint or base carries the tombstones of removed files whose objects may
  remain. Those neither published nor live in the new state are recorded as removed by the
  commit's snapshot, and released once no older snapshot is retained (the conservative rule,
  since the publisher cannot know whether an earlier publication referenced them). Without this a
  re-base from a checkpoint would never release the files added and removed before it.
- **Resync** (SQLite rebuilt from R2) fills `live_next` a manifest at a time, two in flight, and
  swaps it into `live` in one transaction, so an eviction midway leaves SQLite as it was.
- **What still grows:** `verify` (Not implemented); the changes read per publish from a cursor
  (Risks); one manifest of `manifestTargetEntries` files while it is written.

**Bounded work per publish** (review M-6 of the D67 review, since 2026-11-19; design/DECISIONS.md
D67). The upgrade to D67 leaves every tenant without a cursor in the span and log tables, so every
tenant needs a re-base. Before this, the first publish re-based all of them in one invocation and
committed only at the end; an invocation cut off by its CPU limit started again from nothing at the
next alarm, and could be cut off again, so publication could stop for the whole cell. Now:

- **Re-bases per publish.** A publish starts at most `maxRebasesPerPublish` (100) re-bases, and no
  further one once those it started have staged `maxRebaseFilesPerPublish` (100,000) files and
  tombstones; it always starts at least one, so a tenant larger than the cap is re-based alone. What
  one publish stages is therefore at most the cap plus one tenant. The re-bases it knows of from
  SQLite (a table with no cursor for the tenant) run first, one after another, least recently started
  first, then by name (storage migration 6, `rebase`). A re-base found only while reading from a
  cursor (a new ledger incarnation) takes its turn while the budget lasts; past it, the reader stops
  before reading anything of it (`BaseSink.turn` answers null; status `deferred`).
- **Progress kept.** Each publish commits what it re-based, so earlier publishes' work is never
  redone; what one publish staged and had not committed is all an invocation cut off can lose, and
  the cap bounds it. A re-base is recorded as started before anything of it is read: a tenant whose
  re-base was cut off with its invocation, or keeps failing, goes behind every tenant not yet tried,
  instead of being tried first again and holding the queue for ever. `stage` stays one scratch table
  shared by the tenants of an attempt, emptied at its start and end; nothing in it outlives an
  attempt (keeping a tenant's staged state across invocations: Not implemented). The row is deleted
  once the tenant is published.
- **Nothing starves behind the queue.** A tenant waiting for its re-base is read from the cursors it
  has: after the upgrade its metric tables keep being committed in every publish, only its span and
  log tables wait (report status `deferred`; it stays pending). Tenants already re-based, and those
  that never needed one, are read in every publish. Why this order: a re-base costs in proportion to
  the tenant's whole state, a read from a cursor in proportion to its new changes, so the cap goes on
  re-bases alone and the metric commits of the cell never wait for the queue to drain.
- **The alarm comes back.** A publish that left a tenant `deferred` sets the next publish
  `continueMs` (1 s) later instead of `retryMs` (1 min). Before it publishes, the alarm writes its own
  `publish` deadline `retryMs` ahead and sets itself there (a lease): an invocation cut off by the
  platform runs no code after it, and still has a deadline and an alarm. (The platform also retries
  an alarm whose handler failed, up to six times with backoff from 2 s: Cloudflare's documentation,
  read 2026-11-19.)
- **Tenants per publish.** A publish reads at most `maxTenantsPerPublish` (1,000) tenants' logs,
  longest waiting first (`pending.since`); a tenant read and not finished (a hole, a refusal) goes
  behind those not read yet, so stuck tenants never fill every publish. R2 calls are subrequests,
  10,000 per invocation on the Paid plan by default (Cloudflare's documentation, read 2026-11-19); a
  tenant read from its cursor costs three or four (Measurements).
- **After a lost storage.** A tenant with no cursor in a table that R2 has metadata for while SQLite
  has none (the table's `version-hint.text`, one GET per such table, only in a publish with a tenant
  to re-base): the publisher's state was lost. The publish rebuilds one such table from R2 first
  (`resync`, in one transaction) and reads no tenant; the next publish (`continueMs` later) the next
  table; then the cursors found there make the re-bases unnecessary. Before, the first publish
  re-based every tenant, conflicted on each table in turn, and re-based them all again after each
  rebuild: up to six times over in one invocation. A cell whose span and log tables were never
  committed (no span or log data) has no cursors of them in R2, so its tenants are re-based for those
  tables once, within the caps.
- **Measured here, not on Cloudflare** (Measurements, "Capped re-bases: time per publish"): a publish
  at the cap (100,000 staged files, half of them span and log files it adds) took 3.3–3.8 s of
  workerd CPU and 4.8–9.5 s of wall time on this loaded machine; a 300,000-file tenant, re-based
  alone, 10.3 s of CPU; a table rebuilt from R2, about 30 µs of CPU per file.

**The span and log tables** (design/DECISIONS.md D67, since 2026-11-19; the D64 release before it
read them and did not publish them). `PUBLISHED_TABLES` in `src/log.ts` is every `LedgerTable`;
`UNPUBLISHED_TABLES` is empty. Each of `spans`, `trace_index` and `logs` is an Iceberg table with
its own metadata, snapshots, cursor per tenant, expiry deadline and sweep, planned and committed
by the same code as the metric tables:

- **Schemas** (`SIGNAL_DEFS` in `src/iceberg.ts`; Iceberg spec "Nested Types" and Appendix C) match
  the Parquet files of contracts/TRACES.md and LOGS.md column for column, with their nullability:
  `fixed[16]`/`fixed[8]` ids, `start_time` a `timestamptz`, the attribute maps and `metadata`
  `map<string, …>` with required values, `events`, `links` and `services` lists of required
  structs, `hours` a list of required ints, `s_http_response_status_code` a `long` (the files'
  INT64). `tenant` (and `day` for `trace_index` and `logs`) come first, optional, filled from the
  partition tuple, as for metrics ("The partition columns"). `spans` has 45 top-level columns and
  70 field ids, `trace_index` 14 and 19, `logs` 14 and 16.
- **Field ids** are pinned, never derived: the files' columns 1..N in file order, then the
  partition columns, then every map key and value, list element and element struct field in order
  of appearance. `test/golden/formats/iceberg.signal-metadata.v1.json` pins them, and a test
  requires that across every golden version an id names one column, nested ones included.
- **Name mapping.** The files carry no field ids, so `schema.name-mapping.default` maps every
  column, with `fields` for map `key` and `value`, list `element` and the element struct's fields
  (spec, "Column Projection"). PyIceberg 0.12.0 and DuckDB 2.0.0 apply it to every nested field
  (Independent readers, below).
- **Partitions.** `spans`: `identity(tenant)` and `hour(start_time)`, partition field
  `start_time_hour` (field id 1001), an int of hours since the epoch (spec, "Partition Transforms").
  Its value is the file's key level `day=D/hour=HH` (`spanHour`): the ledger admits a `spans` file
  only under the hour its `[minTs, maxTs]` lies in, and the planner checks that again
  (`spanHourProblem`), from the cursor and in a re-base's `stage`: a file that disagrees stops its
  tenant (`inconsistent`), nothing of it published. `verify` compares each entry's hour with the
  key's. The manifest list summarises the hour range; a snapshot's `changed-partition-count`
  counts (tenant, hour). `trace_index`, `logs`: `identity(tenant)`, `identity(day)`, the key's day.
- **Manifests.** `spans` manifests use a `manifest_entry` Avro schema whose partition record is
  `{tenant, start_time_hour}` (`SPANS_MANIFEST_ENTRY_SCHEMA`, golden `iceberg.signal-manifest.v1`);
  `trace_index` and `logs` use the metric tables' (`{tenant, day}`).
- **Statistics** per file: record count and size; value counts (= rows) and null counts (= 0) for
  the required top-level primitive columns only (optional and nested columns: absent, which the
  spec reads as unknown); bounds (Appendix D) for `spans` `start_unix_nano` (ns) and `start_time`
  (µs), `trace_index` `min_start_unix_nano` and `max_end_unix_nano`, `logs` `ts`, all from the
  ledger's `minTs`/`maxTs` (milliseconds, floors) widened to the whole last millisecond, valid and
  not exact; `service_name` (`spans`, `logs`) from the fragment's `min_name`/`max_name` (for spans
  a null counts as `""`, still a valid lower bound); `trace_id` (`trace_index`) exact, the
  fragment's `min_tid`/`max_tid`; split offsets from the fragment. The fragment's 64-bit integers
  are never read as numbers. Not populated: column sizes, NaN counts, other bounds.
- **Removals** are released by the snapshot rule, as metric files are (`safeToDelete`); a file
  removed before it was ever published, one delete grace after the cursor passed it.
- **The upgrade from the D64 release.** Storage migration 5 (additive, `readableFrom` 1) adds
  `signal_due` and `signal_orphan` (below). A tenant D64 published has metric cursors and none for the new tables, so it is
  re-based once (D55: from the newest checkpoint or the base, streamed into `stage`, about two
  row writes per live file); the metric tables move on from their own cursors and are committed
  only if their files changed (the review P-1 path when the checkpoint is above them). The re-bases
  are spread over publishes, a few per publish, and a tenant waiting for its turn keeps its metric
  tables published from their cursors ("Bounded work per publish"). D64's
  `unpublished` records are left alone; `unpublished()` answers `[]`; reports carry no
  `unpublished` field; `status(table)` answers `published: true` for every table.
- **A rollback to the D64 release** (the oldest a rollback may reach once `INGEST_SIGNALS` is on,
  D64's rule) is served: it opens this storage (same version), publishes the metric tables from
  their cursors, leaves the span and log tables' metadata, cursors and `live` rows alone (it never
  sweeps or expires them), and releases none of their removed files (its guard: an object exists
  under `{cell}/iceberg/{table}/`). Rolled forward, this release catches up from those tables'
  cursors (`test/signals.test.ts`).
- **Why migration 5.** The alarm's bookkeeping of the span and log tables (their `expire:<table>`
  deadlines, the sightings of their unreferenced metadata objects) lives in `signal_due` and
  `signal_orphan`, not in `due` and `orphan`. The D64 release re-arms its alarm at the earliest row
  of `due` and its sweep at the oldest row of `orphan`, and acts on the metric tables only: a
  span table's deadline or sighting there, once past, would bring its alarm back at once, for ever,
  each wake a sweep with its R2 lists. Found while writing the rollback tests, not in production;
  shown with D64 on this storage, everything overdue: three forced wakes, and its alarm rests
  (with the old layout, mutant V9, it is set again at once). This release takes the earliest of
  both tables.
- **Recovery from a lost storage** rebuilt each table from R2 at its own commit (a conflict, then a
  retry), so a publish allows one conflict per table plus one (six; three before, for two tables).
  Found by the test written for it: with the old limit the first publish after a storage loss threw
  at the fourth table (`trace_index: R2 is ahead of v0`), and only the alarm's retry finished the
  rebuild. Since review M-6 a lost storage is rebuilt before any tenant is read, a table per publish
  ("Bounded work per publish"); the limit stays for two writers on one cell.
- **Cost.** A publish that moves a tenant's cursors without a commit HEADs the next metadata
  version of each such table (up to five, three more than before) to check that no other writer
  is ahead; a `spans` `metadata.json` is about 9.8 kB with one snapshot and a `spans` manifest
  header 7.8 kB (Measurements).

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

**Statistics populated per data file** (the metric tables; the span and log tables': "The span and log tables"). Record count and file size (from `FileEntry`);
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
  it runs or after an eviction in the middle of it; version 6 (review M-6) adds `rebase`, when each tenant
  waiting for a re-base last had one started, `readableFrom` 1 (releases 1 to 5 neither read nor write it); version 5 (D67) adds `signal_due` and `signal_orphan`, the
  alarm's deadlines and orphan sightings of the span and log tables, kept apart so that the D64
  release, a rollback target, never sees them ("Why migration 5"), `readableFrom` 1; version 4 adds `unpublished`, the record of the
  tables the D64 release read and did not publish (this release, D67, neither reads nor writes it), `readableFrom` 1: releases 1 to 3 neither read nor write it, and
  release 3 on this storage is shown to open it, leave it alone and publish, `test/signals.test.ts`). Storage a newer release migrated past what this code may read is refused:
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
  `metadata.json` for both metric tables (schemas, field ids, partition spec, sort order, name
  mapping, properties; unchanged by D67, so the file of version 1 still pins them byte for byte),
  the same for the span and log tables (`iceberg.signal-metadata.v1.json`, added with D67:
  nested types and every nested id, `hour(start_time)`, nested name mapping), the Avro schemas
  of manifests and manifest lists, that of a `spans` manifest (`iceberg.signal-manifest.v1.json`), the cursors object,
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

(For the span and log tables the same holds of `tenant`, and of `day` for `trace_index` and
`logs`; `spans` has no `day` column: its second partition field is `hour(start_time)`, a transform
of a column the files do hold, which a reader evaluates from a predicate on `start_time`.)

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

- **The span and log tables: what is not done** (D67 publishes them; "The span and log tables").
  - Compacted span and log files (`compact/`, built by another engineer while this was written:
    level-1/2 `spans` files per hour, merged `trace_index`, `logs` files with the token filter
    inside the Parquet object, D65) were not in the read-back: the fixture holds flush files
    only. They are published the same way (same keys, same tables); whether PyIceberg and DuckDB
    read a `logs` file with bytes between its last row group and its footer is not shown here.
  - Schema evolution: a promoted attribute (TRACES.md) or a nested-set column added later is a new
    schema id, which this release refuses to commit over (`metadataProblem`). It needs a release
    that evolves the schema.
  - Exact bounds of `start_unix_nano`, `ts` and the `trace_index` times from the fragment's
    nanosecond values (read as text), bounds of `end_unix_nano`, `duration_nano`, `stream_id`;
    counts of optional and nested columns. All need either the fragment read as text or the
    file's footer.
  - Readers other than PyIceberg 0.12.0 and DuckDB 2.0.0 (Spark, Trino), and `s3://` reads.

- **`verify` in bounded memory.** The scrubber still replays each tenant's log from its base into
  a map, reads the base segment whole, and holds the table's manifest entries: at the ledger's
  limit (300,000 files) that is not expected to fit an isolate. It is an operator's tool, not on
  the publish path; streaming it (into `live_next`, say) is not done.
- **Re-base progress across invocations, within one tenant.** A publish's re-bases are committed
  together at its end, and each tenant's re-base is read, staged and diffed in one invocation. One
  cut off (an eviction, the CPU limit) starts again from its checkpoint or base at a later publish,
  behind the tenants not yet tried ("Bounded work per publish"); what it staged is thrown away. A
  tenant whose re-base alone needs more CPU than an invocation has would never finish (then
  `limits.cpu_ms`, up to 5 minutes, or a tenant's staged state kept across invocations).
- **A rebuild from R2 in steps.** After a lost storage one table is rebuilt per publish, but each
  rebuild reads all of its table's manifests in one invocation, so its time grows with the table's
  files in the cell (Measurements, "Capped re-bases"). Not a cap: a step per manifest, with
  `live_next` kept across invocations, is not done.
- **A cap from measured CPU.** The caps are numbers in the configuration, chosen from times
  measured here; nothing measures a publish's CPU and adjusts them.
- **A fall-back to the base when a checkpoint is corrupt** (D55, alternative (e)): the tenant
  stops instead.

- **No backoff for a stuck tenant.** A tenant stopped by a hole, a corrupt or unsupported
  segment or an inconsistent change is retried every `retryMs` (1 min) for as long as it lasts.
- **Managed catalog.** Only the R2-native implementation exists. The catalog interface of
  D4 has not been extracted; a REST catalog commit would be a second implementation.
- **A release for the newest snapshot's removals in a quiet cell.** `minSnapshots` is 2, so a
  file removed by a table's newest commit is released only after a later commit to that table
  and the window; if the cell publishes nothing more, it is never released (its object stays;
  the janitor looks again every 6 h). The deleter is the janitor's purge (`janitor/README.md`).
- **Publication lag.** Cursors are available (`cursors(table)`); no lag metric or alert.
- **Removed files across a state loss.** After the publisher loses its storage, files
  removed before the loss are not reported by `safeToDelete` (they leak; nothing is
  deleted early). Files added and removed inside the unread tail of an *older* ledger
  incarnation are also never reported. A sweep of data objects against the ledgers is needed
  and does not exist.
- **Trimmed ledger logs.** If old log objects are ever deleted, `verify` cannot replay from
  the base and reports the log as unreadable.
- **Tables in one commit.** Iceberg has no multi-table commit. Each table has its own
  cursor per tenant and commits separately, in the order `metric_samples`, `metric_series`,
  `spans`, `trace_index`, `logs`. Between two commits an external reader can see samples whose
  series row is not yet in `metric_series`, or spans whose `trace_index` fragment is not yet
  published.
- **Readers not tested:** Spark, Trino, Snowflake, and any reader against real R2 with
  `s3://` URIs. Only `file://` URIs were read.
- **Schema or partition evolution**, delete files, branches and tags, rollup tables.

## Verification

```
npm install
npm run fixtures     # Rust: writes test/fixtures/fixture.json (already committed)
node tools/signal_fixture.mjs <scratch>/sigwork 1 1 6   # writes test/fixtures/signals.json (already committed)
npm test             # 120 tests in workerd, 14 files, at most 2 workers; fills export/ and export/signals/
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
<scratch>/readers-venv/bin/python tools/verify_signal_readers.py export/signals   # also writes export/signals/readback/
(cd tools/signals-check && CARGO_TARGET_DIR=<scratch>/signals-check-target cargo build --release -j 2)
<scratch>/signals-check-target/release/viz-publisher-signals-check export/signals
MUTANT_DIR=<scratch>/mutants npm run mutants   # on a copy under MUTANT_DIR; see "Mutation checks"
```

**Last run (2026-11-19, the span and log tables published, D67): 120 passed, 0 failed** (14
files, `npx vitest run --maxWorkers=2`, 122 s with load average 9–13.6 from other builds and this
component's mutation run; earlier runs of the same code before the last tests were added: 117 and
119 passed); `tsc --noEmit` clean; `wrangler deploy --dry-run` bundles the production entry (173 KiB, nothing
uploaded). New: `test/e2e-signals.test.ts` (1), `test/bench-signals.test.ts` (1), three golden
tests (`iceberg.signal-metadata`, `iceberg.signal-manifest`, the name mapping against the schema)
and two golden files (and the schema golden of version 5); `test/signals.test.ts` rewritten (13 tests, the D64 behaviour it tested is
gone: see "The span and log tables"); `test/publisher.test.ts` gained one (a new incarnation whose
versions start again below the cursor, written for mutant M15); changed: three assertions that listed the metric tables'
cursors or expiries exactly now list all five (`publisher.test.ts` 2, `segments.test.ts` 1). The
metric readers script on that run's `export/`: **504 checks, 0 failed**, the eight content hashes
unchanged. The span and log readers (`tools/verify_signal_readers.py export/signals`): **1,542
checks, 0 failed**, the content hashes as in the table there; `tools/signals-check`: **1,786
checks, 0 failed** ("Independent readers: the
span and log tables"). The components that import this one, against these sources: `janitor`,
`compact`, `stack`, `spikes/s8-managed-catalog` typecheck clean; `stack` `test/publisher.test.ts`,
`test/triggers.test.ts` and `test/signals.test.ts` 15 passed, 1 skipped (as before); `janitor` 30
passed, 1 failed (the D64 report assertion: "Needed changes" 9). Not run: the re-base bench (`npm
run bench`; the re-base now stages span and log files too, which a 300,000-file metric tenant does
not have), stack's soak, compact's suite (it imports nothing of this component).

Before (2026-11-19, the span and log tables read, D64): **111 passed, 0 failed** (12 files,
`npx vitest run --maxWorkers=2`, about 25 s); `tsc --noEmit` clean. New: `test/signals.test.ts`
(10 tests) and the v4 schema golden; changed: three tests of `compat.test.ts` (the unknown table of
the "newer ledger" rewrite is now `profiles`, since `spans` is known; `unpublished` among the methods
a refusing publisher refuses, now 12; the adoption test expects the new table empty). The readers
script (system Python here: PyIceberg 0.12.0, pyarrow 26.0.1, DuckDB 2.0.0 with its iceberg
extension) on the export that run wrote: **504 checks, 0 failed**, all eight content hashes as in
the table under "Independent readers". Typecheck of the components that import this one, after
`removedFiles` was widened: `compact`, `janitor`, `stack` clean, with no edit to compact's or the
janitor's sources (they reach `src/log.ts` through imports; the only fixes were here and in the
frozen `bench/before/log.ts`, a type-only cast). Their suites: `janitor` 31 passed (after the one
assertion of "Needed changes" 8 was updated; it failed on `status: 'unsupported'` before),
`compact` 24 passed, `stack` `test/publisher.test.ts`, `test/triggers.test.ts` and
`test/signals.test.ts` 15 passed, 1 skipped (as before). Not run: the bench (`npm run bench`;
nothing in the re-base's memory path changed except that span and log files are counted, not
staged), stack's soak.

Before (2026-11-19, the streaming re-base): **99 passed, 0 failed** (10 files, `npx vitest run
--maxWorkers=2`); `tsc --noEmit` clean; the readers script on the export of the run before the last test was
added (the end-to-end test unchanged since): **504 checks, 0 failed**, every content hash as in the table under "Independent readers" (the re-based stage
included). Against `ledger/src/ledger.ts` as on disk that day (checkpoints in parts, D47) and
the frozen release before it (`ledger/bench/before/`). `deploy/`'s `node --test
test/configure.test.mjs` (which requires `stack/wrangler.jsonc` and `wrangler.test.jsonc` to
differ only as it allows) passed 20 of 20 after the pin was removed from both. `stack/`'s own
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

### Independent readers: the span and log tables

`test/e2e-signals.test.ts` puts real `spans`, `trace_index` and `logs` files into the simulated
bucket: 48 files (485 kB) that viz's write path made from the OTLP corpus of stack/test (seed 1,
scale 1: `edge/scripts/otel-corpus.mjs`, posted through edge into the shards of `{pool}/traces`
and `{pool}/logs`, sealed at 256 KiB, flushed through `engine/wasm`, listed by the ledger: the
corpus mode of `stack/test/signals.test.ts`, run by `tools/signal_fixture.mjs`; 6 of its 8 traces
units and 6 of its 35 logs units, to keep the fixture small). Their spans start in four hours (22
and 23 of 2026-11-18, 0 and 1 of the next day). A real ledger per tenant admits them as flush units
of two tenants and the publisher publishes four stages: (1) a traces unit and a logs unit per
tenant; (2) one more each; (3) a third each, then retention of one tenant's first-day logs and the
other's first-day traces (the third units' first-day files are added and removed between two
publications and are in no snapshot); (4) the second tenant's ledger loses its storage, rebuilds as
incarnation 2 and expires its first-day logs: a re-base. Every table verifies at every stage. The
tables, the data files and `expected.json` (each stage's snapshots and each tenant's live files in
the ledger's precedence order) go to `export/signals/` with `file://` URIs of their real places.

`tools/verify_signal_readers.py export/signals`, run on 2026-11-19 with PyIceberg 0.12.0 (pyarrow
26.0.1, `StaticTable.from_metadata`, each file read through `ArrowScan` on its own) and DuckDB 2.0.0
(iceberg extension `4c0c0874c4`, avro `345c3f4e82`, `iceberg_scan` with the virtual column
`filename`; a `timestamptz` selected as `epoch_us(…)` because DuckDB's Python conversion of it
needs `pytz`, not installed here): **1,542 checks, 0 failed** (712 PyIceberg, 718 DuckDB, 24
content hashes, 88 of the schema). For each table, each stage by time travel from the final metadata and again by
opening that stage's own `vN.metadata.json`:

| Check | PyIceberg | DuckDB |
|---|---|---|
| The table's schema, partition columns aside, is each file's Parquet schema: names, order, types (`fixed[16]` for FLBA(16), `timestamptz` for TIMESTAMP(MICROS, UTC), …), nullability, nested ones included; the partition columns come first, optional, not in the files (44 files) | from `metadata.json`, against pyarrow's reading of each file's footer | |
| The files planned or scanned are exactly the ledgers' live files | `plan_files()` | `filename` |
| Every row of every file, every column (the attribute maps, `events` and `links` lists of structs, `services`, `hours`, `metadata`, fixed ids, `start_time`), equals what pyarrow reads from that Parquet file directly | yes, with one difference allowed and counted: a null list read as empty (120 of 234 file comparisons) | yes, exactly |
| `tenant` (and `day`) from the partition tuple, the file's own, never null | yes | yes |
| A SHA-256 over every row (all columns, sorted, with the tenant) is the same from both readers and from the files | yes | yes |
| `tenant = X`: exactly X's rows, only X's files | `plan_files()` | `EXPLAIN ANALYZE` "Total Files Read" |
| `spans`, `start_time` within one UTC hour (each of the four): exactly its rows, only that hour's files | yes | yes (DuckDB applies the `hour` transform: it reads only that hour's files) |
| `trace_index`, `logs`, `day = D`: exactly its rows, only that day's files | yes | yes |
| The table directory alone, through `version-hint.text`; `iceberg_metadata`'s live entries | not applicable | yes |

Content hashes (first 12 hex digits; the same from PyIceberg, DuckDB and the files):

| Table | initial | appended | expired | rebased |
|---|---|---|---|---|
| `spans` | `9004444cebcc` (266 rows) | `3abd37558ffc` (387) | `f9f738d6df7b` (672) | `f9f738d6df7b` (672) |
| `trace_index` | `b8e7aa8ced5b` (137) | `12bfe0cebf17` (216) | `18d675984709` (343) | `18d675984709` (343) |
| `logs` | `e188a49ccaf0` (29) | `7cac60adc4ca` (146) | `ea97c82e54e7` (297) | `77bebaa5aedf` (208) |

**What viz's own readers and the engines read from the same files.** The script then writes, per
stage and reader, every row it read, file by file, as the logical rows contracts/TRACES.md and
LOGS.md define (promoted columns and the five residual maps merged into one sorted typed list per
scope; "other" values cut out of their canonical JSON as `engine/storage` does). `tools/signals-check`
(Rust, built with `cargo -j 2` into the scratch directory; its span, log and engine code is
stack/tools/signals-readback's) reads each tenant's live files with viz-storage's readers
(`read_spans`, `read_trace_index`, `read_logs`) and requires, per file, the same rows; then, with
duplicates resolved by the ledger's precedence on both sides, runs 30 TraceQL queries through
viz-traceql over the reader's rows and over viz's rows (also with the engine's pruning), and 18
LogQL queries through viz-logql over the reader's rows and over the files through `LogSource`
(pruning by index fragment on and off). Run on 2026-11-19: **1,786 checks, 0 failed**: every file's
rows equal, for both readers, every stage and both tenants (16 runs); TraceQL 960 answers compared,
960 identical (394 non-empty); LogQL 576 compared, 576 identical (188 non-empty).

**Teeth.** With one `logs` file removed from one stage of `expected.json` (a copy in the scratch
directory, `--expected`), the readers script fails 20 checks and exits 1. Its schema check, given
the `spans` schema with `flags` typed `long`, or an event's `name` optional, fails each. With one attribute
removed from one row DuckDB read, `signals-check` fails 3 checks (that file's rows, and two TraceQL
answers) and exits 1. With mutant V1b (every list element mapped to the next field id), the
end-to-end test still passes, and the readers script exits 1: PyIceberg cannot read `spans`
(`KeyError: 'element'`).

**PyIceberg and null lists.** PyIceberg 0.12.0 returns `[]` for a null list. Shown on a table
PyIceberg wrote itself (an optional `list<struct>` column with a null row reads back as `[]`, a null
map stays null), so it is the reader's, not these tables'. TRACES.md's logical view and viz's
reader treat a null and an empty `events` or `links` alike.

### Workerd tests (125)

| Area | Tests |
|---|---|
| Bounded work per publish (`caps.test.ts`, 4; review M-6) | the D67 upgrade of five tenants (D64's storage installed) capped at two tenants' staged files: three alarm runs re-basing 2, 2, 1, each within the cap, each leaving the rest pending with the alarm at `continueMs`; every table then equal, as a reader sees it (every live `data_file` with its partition, counts and bounds, the snapshot totals, the cursor object, the table metadata without its history), to the same cell published by one uncapped publish, and verified; capped at one re-base per run: the tenant last in the queue has a new metric unit committed in the second run from its metric cursors (span and log cursors absent, status `deferred`), as does a tenant re-based already; an alarm run reset (`ctx.abort`, no `finally`) at the second re-base it started: nothing committed before changes, a publish deadline and the alarm remain, the next run takes the two tenants never started and the run after the two cut off, nobody re-based twice; paging at two tenants per publish: a tenant stuck on a hole goes behind those not read yet. After a lost storage, a table rebuilt from R2 per publish and no re-base at all (`signals.test.ts`, below) |
| Re-bases found while reading from a cursor (`checkpoints.test.ts`, 1) | six tenants whose ledgers started new incarnations, found while read six at a time: their checkpoints' parts read one tenant at a time, at most six R2 operations in flight |
| The span and log tables, published (`signals.test.ts`, 13; D67) | a tenant's `spans`, `trace_index` and `logs` exactly as its ledger lists them, from a first publication and from the cursor (a log day expired: a DELETED entry), every table verified, `status` published, `unpublished()` empty; each live entry against the ledger's file: the `spans` hour = the key's hour = the hour of `minTs` and of `maxTs`, the day of the others, value and null counts for exactly the required primitive columns, the time bounds widened as said, `service_name` and `trace_id` bounds, split offsets; the partition spec with `hour`, the manifest list's hour summary, `changed-partition-count`, the nested name mapping; a publish with nothing new commits nothing; **byte-identical metric output** at two stages (units, log and metric expiries, a compaction) from four publishers with fixed ids and clock: this release on the log as written, this release on the log without span and log changes, the D64 release (`test/d64/`) on the log as written, the release before it (`test/n1/`) on the log without them (and only this release writes the span and log tables, exactly the ledger's); removals released by the snapshot rule (the never-published one after the grace, the published ones only once their last referencing snapshot expired, then the grace; never a live key); a forged `spans` file outside its key's hour stops the tenant (`inconsistent`), nothing of it published, from the cursor and in a re-base from a forged base segment; SQLite rebuilt from R2 alone after a lost storage, a table per publish and then the tenant from the cursors found there, with no re-base at all: no new commit, every table and the `spans` hours as before, the next commit (a removal and an addition) right, the manifest list's hour ranges included; the tables known equal the contract's, all published, metric tables first; **re-base** from the base of a new incarnation (every table by difference), from a checkpoint in parts and in one object (a log tombstone released by the snapshot rule), and review P-1 (`spans` committed, `trace_index` failed, a checkpoint above `spans`' cursor: `spans` re-based by difference); **the upgrade from D64**: D64's storage taken over, every tenant re-based once (spread over publishes: `caps.test.ts`), the span and log tables published, the metric tables not committed again (byte-identical objects), D64's record left alone, its released log file still released; **D64 and this release side by side**: D64 on this release's storage with every span table's deadline and orphan sighting overdue rests after its wakes (migration 5), leaves them as they were, and rolled forward this release expires and sweeps them; a rollback to D64 on this release's storage publishes the metrics, leaves the span and log tables' objects, cursors and `live` rows unchanged and releases nothing of them in seven days; rolled forward, this release catches up (a log added and one removed, a span added), verified, and releases the removed log file by the snapshot rule |
| End to end, span and log tables (`e2e-signals.test.ts`, 1) | real files from the stack's write path under two tenants, four stages (units; more units; units and retention of one tenant's logs and the other's traces, with files added and removed between publications never in any snapshot; a ledger storage loss and a re-base), every table verified at each, the published files equal the ledgers'; dumped for the readers |
| Measurements, span and log tables (`bench-signals.test.ts`, 1) | Measurements |
| Avro (6) | round trip across block boundaries, both codecs; empty file; compression; unsafe long and missing field refused; corrupted file refused |
| Version order and gaps (4) | log applied in order with the cursor recorded in an immutable object; a missing segment stops the tenant, is reported, leaves others alone, stays a hole when it is right after the cursor, and is finished by the alarm once filled; a forged change that does not fit is refused; unknown and invalid tenants |
| Net changes (3) | a file added and compacted away between publications is in no manifest of any snapshot; 2 tenants with more than 40 ledger versions each published in one commit per table; a backlog larger than one publish is finished from the alarm |
| Idempotence (3) | a second publish writes nothing, also after eviction; a change that does not touch a table moves its cursor without a commit; state rebuilt from R2 after `deleteAll` with no new commit |
| Concurrency (2) | two publishes on one object serialise into one commit; two writers on one cell: one paused before the metadata write, the other commits, the loser's conditional write fails, it takes the winner's state and commits v2 with both tenants |
| Crash between steps (6) | a failure injected after each of: manifests written, manifest list written, cursor object written, metadata written, hint written, state saved. Checked right after the crash (the table is one of the two valid states and agrees with its cursor object; before the metadata write the publisher's cursors have not moved), then after eviction and a re-run: exactly one new metadata version, hint correct, `verify` clean, leftovers swept only after the grace period |
| `verify` (6) | data object gone; wrong size; extra file in a manifest; file missing from the manifests; duplicate; wrong partition value and row count; cursor ahead of the metadata; cursor behind the snapshot; missing manifest |
| Expiry and sweep (4) | window and minimum of two; time travel to every retained snapshot before and after the sweep; first sweep only marks; what remains is exactly what is referenced; a second writer's in-flight manifests survive a sweep and are never deleted once referenced; `maintain()` expires when idle; manifests merged above the limit with sequence numbers kept |
| `safeToDelete` (1) | empty until the removal is published, until the last referencing snapshot has expired, and until the grace period has passed; never a live key or another tenant's |
| New incarnation (3) | re-base after ledger storage loss removes and adds by diff, DELETED and EXISTING entries; a new incarnation whose base version starts again below the cursor (forged: the contract allows it, the ledger never writes it) is re-based all the same; a cursor from a newer incarnation than R2 has is refused |
| What is written (2) | format version, schema, partition spec, name mapping, partition values checked against the key layout, statistics, manifest list counts and ranges, summary; an unreadable index fragment |
| Driving (3) | `notify` then alarm, which leaves only the sweep's deadline and then none; a nudge during a running publish is kept; `locationPrefix` cannot change |
| Smoke, end to end, measurements (3) | |
| Versioned storage (`compat.test.ts`, 6) | a fresh object at the latest version (6 since review M-6) with the golden schema; migrations 1..N reproduce the golden of N; version 1 equals the pre-versioning `sqlite_master` (`test/fixtures/storage/v0.json`); that dump (a cell published once) adopted and migrated to 2 with every adopted row unchanged and served; a publisher left by pre-versioning code keeps publishing after adoption, verifies clean and is not migrated again after eviction; storage of a breaking N+1, with a tenant pending and due, refused by all 12 methods, alarm re-armed, every table unchanged; storage of an additive N+1 served, written, left at N+1 |
| Newer Iceberg metadata (`compat.test.ts`, 1) | a table evolved by a newer publisher (schema 1 with a new field id, `viz.format-version` 2): publish refused and the tenant left pending, sweep refused, nothing under `iceberg/` changed, SQLite not rebuilt from it, `verify` reports it |
| Versioned storage, migration 2 (`compat.test.ts`, +1) | storage at golden version 1 (no `due`) migrates to 2, keeps publishing, verifies clean, uses the new table, is not migrated twice; adoption of the pre-versioning dump now ends at version 2 with every adopted row unchanged |
| Log objects this code does not know (`compat.test.ts`, 7) | five rewrites of one real segment as a newer ledger would write it (header `v` 2, unknown header kind, change `v` 2, unknown change kind, a file of table `profiles`, which no release knows; it was `spans` until this publisher read that table): each stops the tenant before that segment, twice in a row, with the earlier segments published and the later one unread; restored, it catches up. The same for a change object of the first layout. The reader's accept and refuse rules, and its pinned versions equal the contract's |
| Segments (`segments.test.ts`, 9) | golden: the current ledger writes the checked-in segment bytes (only `at` differs); those bytes published stage by stage (two units in one segment; a compaction with a checkpoint beside it; retention and a unit in one segment; a new incarnation re-based from its base segment) and all at once; the first layout (as-built ledger) read, a hole in it stops the tenant, and the segment incarnation a current ledger starts on taking it over is followed; both layouts in one incarnation refused; whole segments only, and a cursor inside a segment (left by publishing through a `[5, 5]` holding the ledger's own line) finished from the holding segment once a later one exists, without re-applying the change at the cursor; overlapping segments refused before both; unreadable checkpoints ignored; `removedFiles` naming another table, or not matching `removed`, refused |
| Triggers (`triggers.test.ts`, 3) | `notify` writes nothing to R2 and publishes nothing, later nudges never push the deadline back; a nudge returns false within its bound from a publisher that is slow (5 s) or refuses, and with none bound; a tenant's day of flushes and a compaction, each nudged, then the alarm settles in 5 runs (sweep, two expiries, mark, delete) to no alarm and no deadline, every remaining metadata object referenced, and 48 idle hours run no alarm and write nothing |
| Golden formats (`golden.test.ts`, 8) | every format has a file for its version; `metadata.json` of both new metric tables (unchanged) and of the span and log tables; field ids permanent across versions, nested ones included; for every table the name mapping maps exactly the schema's file columns, nested ones included, to their ids, and `last-column-id` is the largest; Avro schemas (and a `spans` manifest's, `trace_index` and `logs` using the metric one); the cursors object and an `add_unit` change (now read from its segment) |
| Re-base from checkpoints (`checkpoints.test.ts`, 22) | the real ledger writing parts (format 2): re-based from them, in part order, at most 4 requested ahead, at most 6 R2 operations in flight, no segment at or before the checkpoint read, verified; the same state from parts, from a format-1 checkpoint and from the base: **byte-identical Iceberg objects** (fixed ids and clock); a published tenant re-based on a new incarnation's parts, removing and adding by difference; a staged re-base across many tiny manifests with merges, and SQLite rebuilt from R2 alone (a table per publish) equal row for row; a part deleted while the checkpoint is read (`incomplete`, nothing published, retried, published once back); a record changed with its size (bytes), a record dropped with the size made up (files), two parts swapped, a part of another attempt, records out of key order across parts, a manifest that is not one: `corrupt`, nothing published; a newer checkpoint format passed over for the base; the object reset (`ctx.abort()`) while paused at a GET mid-stream, and an R2 failure at a part then `evictDurableObject`: nothing committed, staged rows never used, the next publish complete; six tenants re-basing at once: at most six in flight, each tenant's parts in order and in one run (re-bases take turns); six tenants each with eight segments to read from their cursors: at most six in flight (36 without the slots); a checkpoint's tombstones released; the ledger release before parts (N-1) read from its format-1 checkpoint and then across its storage loss; a base segment that is not alone; golden: the ledger still writes the checked-in checkpoint bytes, which are published, and the segment golden's format-1 checkpoint is re-based from |

### Mutation checks

`tools/mutants.mjs` copies the component (with `contracts/` and the ledger sources it imports,
`node_modules` linked) to `$MUTANT_DIR` outside the shared tree, applies one mutant at a time
to the copy, runs the suites it names with at most 2 workers, and restores the copy's file.
The shared tree is only read (AGENTS.md). `DRY=1` only checks that every mutant's text occurs
exactly once in the source.

**Run on 2026-11-19 on publishing the span and log tables (D67): 12 new mutants and 2 retargeted,
14 killed, 0 survived** (`node tools/mutants.mjs M9 U2 U2b V1 V1b V2 V3 V3b V3c V4 V4b V5 V6 V7` on a
copy under the session's scratch directory, `test/signals.test.ts`, and `test/golden.test.ts` for
V1 and V1b; M9 on `test/publisher.test.ts`). The four asked for: **a wrong field id in a nested
type** (V1 in the schema, V1b in the name mapping only), **the hour transform off by one** (V2), **a
span file in the logs table** (V3, V3b, V3c: from a cursor, from the changes after a re-base's
base, from the base or checkpoint itself), **metric bytes changed** (V4, V4b). M9 (the day off by
one) and U2b were retargeted at the rewritten partition and planning code, same mutation. U1, U2c,
U3, U4 and U5 tested D64's reading without publishing and are retired with it: U1 and U3 are now
no-ops (no table is unpublished), the code U2c, U4 and U5 edit no longer exists.

| # | Mutation | Result (tests failing) | A test that fails |
|---|---|---|---|
| V1 | a wrong field id in a nested type: the `name` field of a span event struct takes an unused id (71) | killed (2) | iceberg.signal-metadata: a new table's metadata.json, for the span and log tables |
| V1b | a wrong field id in a nested type, in the name mapping only: every list element mapped to the id after its own | killed (1; 2 in the full run below, with the name-mapping test added after this run) | iceberg.signal-metadata: …; name mapping: for every table, it maps exactly the schema's fields … (and the readers script: PyIceberg cannot read `spans`) |
| V2 | the hour transform off by one: a `spans` file's `start_time_hour` is the next hour | killed (8) | a tenant's spans, trace_index and logs are published exactly as its ledger lists them, with the partition, counts and bounds of each file |
| V3 | a span file published into the logs table (from a cursor) | killed (5) | the same |
| V3b | a span file published into the logs table (a re-base: the changes after its base) | killed (8) | the same |
| V3c | a span file published into the logs table (a re-base: the files of its base or checkpoint staged as logs files too) | killed (5) | from the base of a new incarnation after the ledger lost its storage: every table by difference |
| V4 | metric bytes changed: every snapshot summary, the metric tables' too, gains a key | killed (1) | metric publication is byte-identical: this release on the log as written and without span and log changes, the D64 release on the log as written, and N-1 of D64 without them |
| V4b | metric bytes changed: every manifest's Avro header, the metric tables' too, names its table | killed (1) | the same |
| V5 | a removed span or log file released at once, not by the snapshot rule (as D64 did) | killed (2) | their removed files are released by the snapshot rule: once no retained snapshot references them, after the delete grace; never a live key |
| V6 | a re-base stages no span or log files (D64's counting, without the count) | killed (3) | from the base of a new incarnation after the ledger lost its storage: every table by difference |
| V7 | a `spans` file outside its key's hour is published (the plan-time check removed) | killed (1) | a spans file whose time range is not in its key's hour stops the tenant: nothing of that change is published |
| U2 | a span file published into the metrics table (from a cursor) | killed (4) | a tenant's spans, trace_index and logs are published exactly as its ledger lists them, … |
| U2b | a span file published into the metrics table (a re-base: the changes after its base) | killed (8) | the same |
| M9 | wrong partition value (day off by one; now in `partitionOf`) | killed (29) | applies a log in version order and records the ledger version it reflects |

V4 and V4b are caught only by the byte-identity test: the goldens pin `metadata.json` of a new
table and the Avro schemas, not snapshot summaries or manifest headers. V1 is caught by the goldens
and the id checks, not by the readers: a wrong id that the schema and the mapping agree on still
reads; what it breaks is an id's permanence across releases.

**Then every mutant again, on the code as it stood after the 14 above (a fresh copy, all suites
they name, 2026-11-19, load average 8–13.6): 59 mutants, 58 killed, 1 survived.** Every M, S, K,
C, I, U and V mutant was killed, with the counts of the table below, except M2 (now 10 tests, 31
before: with five tables fewer tests replay a log that order changes), M4 (1, was 3), M6 (9, was
10), C1 (3, was 2) and V1 (3, with the name-mapping test). **M15 survived** (a re-base ignores a new
incarnation when the cursor is in an older one). It is equivalent for the ledger as built: an
incarnation continues the version numbering, so its base is never below the cursor, and the review
P-1 clause (`log.base !== null && cursor.version < log.start`) re-bases wherever the incarnation
clause would; the D64 code has the same clause, so it would have survived there too (not run). The
contract does not promise that numbering, so a test was added for it (a forged incarnation whose
base starts again below the cursor must be re-based: `test/publisher.test.ts`), and M15 was run
again, below.

After that run three changes were made, each found by a test written then: migration 5 ("Why
migration 5"), the conflict limit ("Recovery from a lost storage") and the hour check in a
re-base's `stage` tested from a forged base. The mutants that touch what they changed (the sweep,
expiry, conflicts, the alarm, the schema, the new checks), and four new ones, were run on the final
code:

**17 mutants, 17 killed, 0 survived** (`node tools/mutants.mjs M1 M7 M10 M11 M13 M14 M15 M16 M17 M20 I3 I4 I5 V1b V7b V8 V9`, a fresh copy, 2026-11-19). New: **V7b** (the hour check removed from a re-base's `stage`), **V8** (the conflict limit of two tables kept), **V9** (the span and log tables' deadlines and sightings kept in `due` and `orphan`: D64's alarm, on that storage, is set again at once; run on its own, the test's first failure is exactly that, `D64's alarm, wake 1: -2` ms). M15 is killed by the test added for it. M7 was retargeted at the orphan table's name (same mutation).

| # | Mutation | Result (tests failing) | A test that fails |
|---|---|---|---|
| M1 | skip the conditional write (metadata is written unconditionally) | killed (1) | lets only one of two writers create a metadata version; the other takes its state and retries |
| M7 | sweep without a grace period (an unreferenced object is deleted when first seen) | killed (5) | converges after a crash right after "manifests-written" |
| M10 | sweep on a stale view (no check that R2 has a newer metadata version) | killed (1) | does not delete the files of a commit that is in flight |
| M11 | sweep treats only the current snapshot as referenced | killed (7) | converges after a crash right after "manifests-written" |
| M13 | snapshot expiry does not keep a minimum of two | killed (2) | expires snapshots from maintain() when no publish does it |
| M14 | a lost conditional write is treated as success | killed (1) | lets only one of two writers create a metadata version; the other takes its state and retries |
| M15 | re-base ignores the new base (an older incarnation cursor continues as if nothing happened) | killed (1) | re-bases on a new incarnation whose versions start again below the cursor (a base version the contract allows, which the ledger never writes) |
| M16 | the publisher serves storage a newer release wrote (guard removed) | killed (1) | refuses storage a newer release migrated past what it knows: every method throws schema_too_new, the alarm is re-armed, nothing written |
| M17 | a refusing publisher publishes from its alarm (and writes) | killed (1) | refuses storage a newer release migrated past what it knows: every method throws schema_too_new, the alarm is re-armed, nothing written |
| M20 | a released migration edited in place (version 1 loses an index) | killed (2) | a fresh publisher is at the latest version, and its schema is the golden file |
| V1b | a wrong field id in a nested type, in the name mapping only: every list element mapped to the id after its own | killed (2) | iceberg.signal-metadata: a new table's metadata.json, for the span and log tables |
| V8 | the conflict limit of two tables kept for five: a lost storage is not rebuilt in one publish | killed (1) | SQLite rebuilt from R2 alone after the publisher lost its storage: every table, the spans hours included; nothing committed again, and the next commits are right |
| V9 | the span and log tables' deadlines and orphan sightings kept with the metric tables' (no migration 5): D64, a rollback target, wakes for ever | killed (1) | the span and log tables' deadlines and orphan sightings do not wake D64's alarm for ever: they live where D64 does not look (migration 5); rolled forward, this release serves them |
| V7b | a spans file outside its key's hour is published (the check removed, in a re-base's stage) | killed (1) | a spans file whose time range is not in its key's hour stops the tenant: nothing of that change is published |
| I3 | notify publishes at once instead of leaving it to the alarm | killed (3) | notify only records the nudge: no R2 operation, nothing published until the alarm, and later nudges never push the deadline back |
| I4 | the alarm keeps itself alive when nothing is due (an hourly wake) | killed (1) | maintenance runs nudge, the alarm publishes, expires and sweeps, then is gone; 48 idle hourly ticks wake nothing and write nothing |
| I5 | a commit does not schedule the sweep of what it stopped referencing | killed (1) | maintenance runs nudge, the alarm publishes, expires and sweeps, then is gone; 48 idle hourly ticks wake nothing and write nothing |

Earlier, **on 2026-11-19 on the span and log tables (D64): 7 new mutants and S3 again, 8 killed, 0
survived** (`node tools/mutants.mjs U1 U2 U2b U2c U3 U4 U5 S3` on a copy under the session's scratch
directory; `test/signals.test.ts` for the U mutants, `test/compat.test.ts` for S3). The three asked
for: **stop on an unknown table** (U1), **a span file published into the metrics table** (U2, U2b,
U2c: from a cursor, from the changes after a re-base's base, from the base or checkpoint itself),
**`removedFiles` filtering out the new tables** (U3); and two of the release (U4, U5). The other 45
mutants were not run again: their texts all still apply (`DRY=1`: 53 mutants, 0 edits that do not
apply) and the suites they name pass on this code.

| # | Mutation | Result (tests failing) | A test that fails |
|---|---|---|---|
| U1 | stop on an unknown table: the span and log tables unknown again (a change naming one stops the tenant, metrics included) | killed (9) | a tenant with span and log changes keeps publishing its metrics, and records the other tables as not published |
| U2 | a span file published into the metrics table (a tenant read from its cursor) | killed (2) | a tenant with span and log changes keeps publishing its metrics, and records the other tables as not published |
| U2b | a span file published into the metrics table (a re-base: the changes after its base) | killed (8) | a tenant with span and log changes keeps publishing its metrics, and records the other tables as not published |
| U2c | a span file published into the metrics table (a re-base: the files of its base or checkpoint staged as metric files) | killed (4) | from the base of a new incarnation after the ledger lost its storage: metrics by difference, the record counted again from the base |
| U3 | `removedFiles` filtering out the new tables (their removals never read) | killed (3) | a tenant with span and log changes keeps publishing its metrics, and records the other tables as not published |
| U4 | their removed files released although a newer publisher has a table of that name | killed (1) | the files of those tables that the ledger removes are released to the janitor after the grace, never while a newer publisher has a table of that name |
| U5 | their removed files released at once, without the delete grace | killed (3) | the same |
| S3 | a file of a table this code does not know (`profiles`) is ignored instead of refused | killed (1) | a file of a table this code does not know stops the tenant before that segment: … |

Earlier, **on 2026-11-19 on the streaming re-base (the final code): 46 mutants, 45 killed, 1 survived
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

### Measurements: the span and log tables

Measured here (`test/bench-signals.test.ts`, output `export/bench-signals.json`), in workerd on this
4-core machine with a simulated R2, four runs on 2026-11-19 with **load average 8.5–13.6** (other
builds running, and in the last two this component's mutation run; the last three inside the full
suite; the fourth, at 13.6, gives the upper end of every time); not on Cloudflare. Shaped as the metric
bench: 10 tenants, 10 flush units each of 100 files over 10 days (`spans`: 10 hours of each day,
plus one `trace_index` file a day per unit; `logs`: 10 files a day), keys of realistic length and
entropy, index fragments of the contract's shape; ledger logs written by real Ledger objects; data
objects not created. `deflate` codec. Ranges are over the four runs; byte counts varied by a few bytes (Avro blocks compress the random ids).

| Publish | Table | Manifests | Manifest list | Cursors | metadata.json | Metadata bytes | Commit | Whole publish | R2 ops (list / get / head / put) |
|---|---|---|---|---|---|---|---|---|---|
| **10,000 `spans` files** + 1,000 `trace_index` files, first publication (110 ledger changes) | `spans` | 386,591 B (1) | 1,603 B | 656 B | 9,809 B | **398.7 kB** | **0.82–1.45 s** | 1.44–2.77 s | 31 / 22 / 15 / 10 |
| | `trace_index` | 17,492 B (1) | 1,602 B | 662 B | 4,041 B | 23.8 kB | 0.26–0.41 s | | |
| +1 unit on that table | `spans` | 7,803 B | 1,692 B | 656 B | 10,730 B | 20.9 kB | 40–173 ms | 93–302 ms | 2 / 3 / 5 / 10 |
| | `trace_index` | 4,846 B | 1,692 B | 662 B | 4,975 B | 12.2 kB | 31–83 ms | | |
| a day expired for every tenant (1,001 `spans`, 101 `trace_index` files removed) | `spans` | 394,606 B (2, the 10,000-entry one rewritten) | 1,673 B | 656 B | 11,657 B | 408.6 kB | 0.40–0.73 s | 0.62–1.02 s | 21 / 12 / 5 / 12 |
| | `trace_index` | 22,365 B (2) | 1,673 B | 662 B | 5,916 B | 30.6 kB | 0.09–0.13 s | | |
| **10,000 `logs` files**, first publication (110 ledger changes) | `logs` | 246,961 B (1) | 1,596 B | 635 B | 3,727 B | **252.9 kB** | **0.84–1.24 s** | 1.13–1.56 s | 31 / 21 / 15 / 5 |
| +1 unit on that table | `logs` | 4,501 B | 1,685 B | 635 B | 4,645 B | 11.5 kB | 32–53 ms | 43–85 ms | 2 / 2 / 5 / 5 |
| a day expired for every tenant (1,001 files removed) | `logs` | 251,721 B (2) | 1,665 B | 635 B | 5,568 B | 259.6 kB | 0.28–0.60 s | 0.37–0.80 s | 21 / 11 / 5 / 6 |

Per 10,000 files, then: **`spans` about 399 kB of metadata and 0.8–1.4 s of commit, `logs` about
253 kB and 0.8–1.2 s** (`metric_samples`: 342 kB and 0.5–1.5 s, the table above). Per file a
`spans` manifest entry is about 38 bytes, a `logs` entry about 24 (the metric samples', 34):
`spans` entries carry four bounds (two times, `service_name` twice) and ten counted columns, `logs`
entries four bounds and five counted columns. Fixed costs are larger for `spans`: a manifest's
header holds the whole schema (7.8 kB, against 3.9 kB for metrics) and `metadata.json` is 9.8 kB
with one snapshot (2.6 kB for metrics; the schema's 70 field ids and its nested name mapping).
A `trace_index` entry is about 13 bytes. Every publish HEADs the next metadata version of each
table whose cursors move, committed or not: five where there were two before D67.

### Capped re-bases: time per publish

Measured here, in local workerd (`bench/upgrade.bench.test.ts`, 2026-11-19, load average 9.1–10.6
on this 4-core machine with other builds running), not on Cloudflare. Each tenant's log is written
with the contract's encoders: a base segment of F files, one unit after it, and a checkpoint in parts
(format 2) at the unit; half of the files are metric files, half span and log files (`spans` 25%,
`trace_index` 5%, `logs` 20%), over 30 days, keys and index fragments of realistic length. **The
upgrade:** every tenant published once (all five tables, caps lifted), then the span and log
tables forgotten in SQLite and R2 (what the D64 release leaves: metrics published and cursored),
then `publish` until no tenant waits, at the default caps (100 tenants, 100,000 staged files).
**The rebuild:** the publisher's storage deleted, then `publish` until settled. **CPU** is the
workerd process's user and system time during each publish (`bench/cpu.mjs`, from `/proc`, 10 ms
ticks): the publisher, its SQLite, the simulated R2 and the test runner share that process, so it
is an upper bound on the publisher's own, taken while other builds competed for the 4 cores.

| Cell | Publish | Staged (files and tombstones) | Span and log files added | Wall | CPU (workerd) |
|---|---|---|---|---|---|
| 8 tenants × 25,000 files | upgrade 1 (4 tenants re-based) | 100,008 | 50,000 | 7.8 s | 3.5 s |
| | upgrade 2 (4 tenants) | 100,008 | 50,000 | 9.5 s | 3.8 s |
| 2 tenants × 100,000 files | upgrade 1 (1 tenant: the second would start at the cap) | 100,002 | 50,000 | 4.8 s | 3.3 s |
| | upgrade 2 (1 tenant) | 100,002 | 50,000 | 5.4 s | 3.5 s |
| 1 tenant × 300,000 files (the ledger's limit) | upgrade (alone: a publish always starts one re-base) | 300,002 | 150,000 | 17.5 s | 10.3 s |
| 8 tenants × 25,000 files, uncapped | the first publication (every file added to all five tables) | 200,016 | 100,000 | 19.5 s | 12.3 s |

An earlier run of the first cell, without the CPU sampler: 7.6 s and 6.1 s of wall time. The
rebuild, a table per publish (CPU): 50,000-file `metric_samples`, `metric_series` and `spans`
1.6–1.9 s each, 40,000-file `logs` 1.1 s, 10,000-file `trace_index` 0.3 s, then the publish from the
cursors found there 0.01 s, with no re-base; at 75,000 files a table 2.3–2.5 s. So about 35 µs of
CPU per staged file at the cap here (half of them added), and about 30 µs per file rebuilt. (These
runs had the retry path's `break` that was later made `continue`, "Bounded work per publish"; no
attempt was started over in them, so the code they ran is the same.)

**The cap, and why.** 100,000 staged files and tombstones per publish: 3.3–3.8 s of CPU here, about
an eighth of the 30 s a Durable Object invocation has by default (Cloudflare's documentation, read
2026-11-19), and at most 9.5 s of wall time under load. The margin is for what is not measured:
Cloudflare's CPU against this machine's, and work this bench does not have (tombstones, changes
after the checkpoint, the other tenants' commits in the same publish). A publish stages at most the
cap plus one tenant: at the ledger's limit a tenant alone took 10.3 s of CPU here, and the worst
case, a 99,999-file tenant and then a 300,000-file one in one publish, is about 14 s (modelled: the
two measurements added), still about half the limit. A smaller cap would not shorten that case and
would multiply publishes, each a commit and a retained snapshot per table; a larger one spends the
margin. 100 re-bases per publish bounds a cell of many small tenants: a re-base costs about eight R2
operations besides its parts (lists, a head, the checkpoint manifest, the segments after it), against
the 10,000 subrequests an invocation may make on the Paid plan by default (documentation, read
2026-11-19). 1,000 tenants read per publish is about 3,000–4,000 R2 operations (three lists per
tenant with nothing new, measured in the rebuild's last publish: 24 for 8 tenants); its CPU is not
measured.

**Modelled for the review's cell** (100 tenants × 100,000 files, half span and log): uncapped, one
invocation of about 100 × 3.4 ≈ 340 s of CPU by these measurements (the review modelled 240 s from
wall times here); capped, 100 publishes of about 3.4 s of CPU each, `continueMs` (1 s) apart, about
7–12 minutes of wall time for the whole upgrade, during which every tenant's metric tables keep
being published.

**The experiment that settles it on Cloudflare:** viz-publisher deployed on a `viz-` bucket holding
the bench's cell (its logs written by the bench's encoders from a Worker), its storage made D64's as
the bench does, the alarm left to drain the upgrade at the default caps; the CPU time of each alarm
invocation read from the analytics API (the Durable Object invocations' CPU time; the dataset's
name not checked here). Every capped publish must stay well under 30 s, and the 300,000-file
tenant's publish is the number that decides between this cap, `limits.cpu_ms`, and keeping a
tenant's staged state across invocations.

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

- **The rollout rule rests on an operator** (D64). Nothing in the release tooling stops a rollback of
  viz-publisher below the D64 release after `INGEST_SIGNALS` is on (D46 judges storage, which D64
  and this release change only additively). Such a rollback stops every tenant with a span or log
  change at that change, metrics included, until rolled forward; nothing is lost or deleted. A
  rollback to D64 itself is served (see "The span and log tables").
- **During a rollback to D64, span and log publication stops** (D64 does not publish them) and the
  removed files of those tables wait (its guard sees this release's tables). Rolled forward, this
  release catches up from their cursors.
- **The upgrade re-bases every tenant.** After deploying this release over D64's storage every
  tenant's newest checkpoint or base is read and every live file written to `stage` (about two row
  writes per file, modelled $0.60 per 300,000-file tenant at $1 per million rows, a price from
  training knowledge), spread over publishes of at most 100,000 staged files and 100 tenants each,
  one second apart ("Bounded work per publish"). A tenant at the ledger's limit is re-based alone,
  and its publish is the largest (Measurements, "Capped re-bases"; CPU on Cloudflare not measured:
  "CPU time of a re-base at the limit"). While the queue drains, a waiting tenant's span and log
  tables are not published; its metric tables are.
- **External readers depend on the nested name mapping** and on the projection rule for identity
  partitions: PyIceberg 0.12.0 and DuckDB 2.0.0 apply both; a reader that ignores the mapping reads
  no column of these files. PyIceberg 0.12.0 reads a null list (`events`, `links` of a span without
  them) as an empty list, also on a table it wrote itself; DuckDB and pyarrow read null. The
  logical view (TRACES.md) treats the two alike.
- **A `spans` file's partition is its key's hour.** Exact for every file the ledger admits (the
  ledger and the planner both check it against `minTs`/`maxTs`); a key layout that put a file
  outside its hour would stop the tenant, not mis-partition it.
- **Larger metadata.** A `spans` `metadata.json` carries 70 field ids and their name mapping, about
  9.8 kB with one snapshot, and grows by about 1 kB per retained snapshot as a metric table's; every
  `spans` manifest repeats the schema in its header (7.8 kB).

- **A change without an index fragment** (a log from before D41, or a contract violation) is
  staged with none in both `stageSink` and `planStaged` (the latter since PR #5's review), so it
  cannot fail a whole publish; no test builds such a log yet, so the parity is by reading.

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
  Cloudflare a Durable Object invocation (a request or an alarm) has 30 s of CPU by default,
  configurable to 5 minutes with `limits.cpu_ms` (Cloudflare's documentation, "Durable Objects
  limits" and "Workers limits", read 2026-11-19). The per-publish cap keeps a publish of many
  tenants under that (Measurements, "Capped re-bases"), but a single tenant is re-based whole: one
  whose re-base exceeds the limit is retried behind the others and never finishes (Not
  implemented). Not measured on Cloudflare. The experiment that settles it: viz-publisher on
  Cloudflare re-basing a tenant of 300,000 files (the bench's log, written to a `viz-` bucket), and
  the upgrade bench's cell (`bench/upgrade.bench.test.ts`) at the default caps, the CPU time of each
  publish read from the analytics API (`cpuTime` of the Durable Object's invocations).
- **A capped backlog wakes the object once a second.** `continueMs` (1 s) between capped publishes:
  an upgrade of a cell of 10,000,000 staged files is about 100 publishes, 100 alarm wakes. A
  publish that leaves only tenants stuck on a hole or a refusal waits `retryMs` as before.
- **A corrupt checkpoint stops that tenant's re-base** (explicitly: `corrupt`, retried every
  `retryMs`) until the ledger writes a newer one, which supersedes and deletes it, or an
  operator removes it. The ledger's own rebuild passes over such a checkpoint for the base; this
  publisher refuses rather than read around it (D55, "would change if").
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
- No adversarial review of the commit protocol, the segment reader, the trigger or the
  streaming re-base (D55: reading checkpoints, the staged diff, the six slots) has been done
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
8. **The span and log tables (D64), for their owners; not edited from here:**
   - `janitor/README.md`, "Span and log files go through the same gate": the publisher no longer
     stops a tenant at them; it releases their removed files after its delete grace. (One assertion
     of `janitor/test/signals.test.ts` pinned the old refusal, `status: 'unsupported'`; it was changed
     to the new answer, with the test's title, because this change makes it false. The janitor's
     code and its gate are unchanged.)
   - `edge/README.md`, "Needed changes" 2, the publisher item: done as far as passing over (reading)
     the tables; publishing them is not (Not implemented). `INGEST_SIGNALS` follows D64's rule.
   - `contracts/TRACES.md` and `contracts/LOGS.md`, Status: done with D67 (publication sections
     added, statuses updated; the only contract edits of this change).
   - `deploy/`: record, with the release that turns `INGEST_SIGNALS` on, that viz-publisher may not be
     rolled back below this release (D64, step 2 of the rule); the tooling cannot check it.
9. **The span and log tables published (D67), for their owners; not edited from here:**
   - `janitor/test/signals.test.ts`, "the real publisher reads these tables and does not publish
     them": it asserts D64's report (`unpublished: { spans: 0, trace_index: 0, logs: 0 }`) and that
     the publisher releases none of the removed span and log files within its grace. With D67 the
     report has no `unpublished` field (the assertion fails on that field), and the files, removed
     before they were ever published in that test, are still held for the delete grace (that part
     holds). The janitor's code and gate are unchanged. Run against this release (not edited, janitor/
     is not this change's): 30 passed, 1 failed, that assertion (`toMatchObject` on `unpublished`).
     The typecheck of `janitor`, `compact`, `stack` and `spikes/s8-managed-catalog` against the new
     sources is clean.
   - `deploy/`: no new binding or variable. The rollback floor stays D64's release (D64, step 2).
   - `stack/` and `edge/` READMEs say the publisher "reads" the span and log tables: it publishes
     them since D67.
7. **deploy**: viz-publisher with the streaming re-base must run before, or together with, a
   viz-ingest whose ledger is no longer pinned at 16 MiB (`stack/wrangler.jsonc` no longer pins
   it): readers first. The deploy already deploys viz-publisher before viz-ingest. Rolling
   viz-publisher back below this release while a tenant is above about 16 MiB brings back the
   old risk (a re-base that does not fit), for that tenant's re-bases only; its storage
   (migration 3, additive) is readable by the release before.

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
15. **Resolved: `LedgerChange.removedFiles[].table` is typed `LedgerTable`** (2026-11-19, with D64; it
   was `Table` while this publisher refused the other tables). The reader still checks it at run time.
16. **COMPATIBILITY.md has no floor per format.** §6 raises the rollback floor only with a forward-only
   release; a format that a writer may start once a reader is the floor (here: span and log changes,
   read by this release) has no way to say so in the release record. D64 leaves it to the operator.
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
17. **The index fragments of the span and log tables give nanosecond bounds as JSON numbers**
    (TRACES.md: "a JavaScript reader must not read them as numbers"). So the publisher takes the
    time bounds from the ledger's milliseconds, widened, valid but not exact, and does not use the
    fragments' `min_ts`/`max_ts`, `min_dur`/`max_dur` or `sid`. Proposal: decimal strings there, as
    `EncodedSignalFile.minNs` already is (contracts/engine.ts). Not changed (the engine's format).
4. **No field ids in the Parquet files.** The tables rely on `schema.name-mapping.default` (for the
   span and log tables, nested ids included: 70 for `spans`).
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
    lists each part's size and SHA-256 (format 3); readers check each part as it arrives.
14. **A base's `added` has no promised order.** Checkpoint parts are in key order (stated); a
    base's elements are written from SQLite in key order but the contract does not say so. With
    it stated, a re-base could merge a base against what is published without staging it (D55,
    "would change if").
