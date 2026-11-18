# Correctness review of DESIGN.md (draft 2)

Reviewer stance: adversarial; sections 2–6. Section numbers refer to DESIGN.md.
Facts about platform limits are taken from `research/01`, `02`, `05`, `07`.

Summary: the seam invariant ("lake ∪ tail is exact") is the right idea, but as written it rests
on (a) a timing assumption instead of a fence, (b) an under-specified watermark, and (c) "same
bytes on retry", none of which hold under crash, deploy, slow query or shard-map change. Seven
findings can lose or double-count acknowledged data silently. The committer and
`identity(tenant_id)` layout also have scaling cliffs that are reached at a few hundred active
tenants, well before the "Scale" row of §11.

---

## Critical

### 1. Truncation is guarded by a grace period, not a fence: silent gap in query results

**Scenario.** Commit S+1 lands with watermark W'=200 for shard A (S had W=100).
- (a) A query Worker reads head S, plans, and runs for a long time (Container route in §6.3,
  hedged/retried leaf, two-level fan-out). Its tail request `seq > 100` reaches shard A after A
  has deleted segments ≤ 200 and the "answer from the R2 file" window has also ended. A returns
  only seq > 200. Rows 101–200 are in neither the lake at S nor the tail answer. The query
  succeeds with missing data.
- (b) Committer commits S+1, tells shards (or shards learn through a report reply), then crashes
  before step 4 publishes the head. Nothing is pending ("if nothing is pending it does nothing"),
  so nothing wakes it. The *published* head stays at S indefinitely; shards truncate after the
  grace period; every query for that tenant has a permanent hole 101–200 until the next ingest.
- (c) If the head is published through KV (the design does not say where), KV can serve an older
  value after a newer one for ~60 s or more; "maximum age of any cached table head" is unbounded.

**Why the text does not prevent it.** §4.3 step 5 bounds only the *cache age* of a head. It does
not bound query duration, request delay, publication failure, or the propagation of the
publication medium. A shard asked for `seq > W` with W below its truncation point is not
specified to refuse.

**Fix.** Make it a fence; keep the grace period only as a performance knob.
- Shard persists `truncated_below`. A tail request with `W < truncated_below` (and no R2 file
  reference still held for the range) returns `STALE_HEAD`; the coordinator re-reads the head and
  re-plans. Never a partial answer.
- Heads carry a monotonically increasing `head_epoch`. A shard may truncate to watermark W' only
  after it has been told that a head with epoch ≥ that commit was *published* (publication ack,
  not commit ack).
- Publish the head to a strongly consistent place (R2 object with conditional PUT, or the
  committer DO itself), not KV. On every wake the committer reconciles "committed but not
  published" before anything else, and sets an alarm whenever that state exists.

### 2. "Highest sequence number it contains" is not a safe watermark

**Scenario A (segment spans files).** The flush key contains `{day}` and a shard feeds several
tables. One sealed segment [101–200] therefore produces several files (day D and D−1 for late
samples or across midnight; `metric_samples`, `metric_series`, `trace_index`, ...). The PUT/report
for day D arrives; the one for D−1 is still retrying. The committer commits the D file and writes
W=200. Rows of [101–200] in the D−1 file are now excluded from the tail (`seq > 200`) and absent
from the lake: a gap. If the shard then truncates ≤ 200 (it is allowed to), and the D−1 PUT is
never retried because the WAL rows are gone, acknowledged data is lost.

**Scenario B (out-of-order reports).** Report for segment [201–300] arrives before the retried
report for [101–200]. "Highest seq contained" = 300. Same gap, same loss.

**Scenario C (sequence reset).** A shard's storage is reset or a shard name is reused (tenant
deleted and recreated, operator `deleteAll`, restore). Its seq restarts at 1 while the snapshot
says W=5000. All new rows are ≤ W: invisible to tail queries, treated as already committed by the
committer's dedup-by-range, and eligible for WAL deletion. Total silent loss for that shard.

**Scenario D (multi-table).** `metric_samples` and `metric_series` have different committers and
different watermarks. A shard that truncates on the samples watermark deletes series rows the
series table has not committed yet.

**Why.** §2 and §4.3 define the watermark as a max and treat a report as one file.

**Fix.**
- The unit of flush, report and commit is a **flush unit** = one `(shard, incarnation, seq_lo,
  seq_hi, table)` with the complete list of its files (all days). The shard persists the unit
  record before any PUT; the committer commits all files of a unit in one snapshot or none.
- Watermark = **contiguous committed prefix**. The committer accepts a unit only if
  `seq_lo == W + 1`; anything else is held or rejected. An empty unit (no rows for that table in
  the range) is still reported so every table's watermark advances.
- Watermarks are keyed by `(shard_uuid, incarnation)`; shard ids are minted by the `Tenant` DO and
  never reused. The shard truncates at `min` over the watermarks of all tables it feeds.

### 3. Seal boundaries are not durable, and "same key, same bytes" is not true

**Scenario A (double count).** Shard PUTs `A-101-200.parquet`, reports it, and is evicted before
recording the seal. On restart it replays the WAL, sees an open segment starting at 101, accepts
more data, seals [101–260], PUTs, reports. The committer holds [101–200] and [101–260]; both are
"keyed by (shard, seq range)" and both are distinct keys. Rows 101–200 are committed twice.

**Scenario B (overwrite after commit).** Alarms are at-least-once. The flush alarm runs, PUTs,
reports; the committer commits; the alarm is redelivered (or the report reply was lost) and the
shard re-encodes and overwrites the same key. Between the two runs any of these changed: a deploy
of the WASM encoder / zstd / parquet writer, a `created_by` or timestamp field, sort tie-breaking,
a tenant scrub/relabel/quota rule if applied at encode, the row-group size setting. The object
now has different length and row-group offsets from those in the manifest, the footer bundle, the
ledger, and every Cache API entry. §6.4 caches leaf results over this file "forever". Readers
using recorded offsets read garbage or fail; the scrubber reports corruption.

**Why.** §4.3 asserts idempotence but nothing makes the encoding deterministic across versions,
and nothing stops a PUT on an already-committed key.

**Fix.**
- Persist the flush-unit record (range, file keys) in the same SQLite transaction that seals, so a
  replay re-uses the boundary.
- PUT with `If-None-Match: *`. On 412, HEAD the object and compare length and checksum with the
  locally recorded values; if they match, done; if the shard has no recorded values, adopt the
  existing object's footer rather than re-encoding. Never overwrite.
- Record a content checksum in the ledger and manifest; the committer rejects overlapping ranges
  for a shard (follows from finding 2's `seq_lo == W + 1` rule).

### 4. Commit-outcome resolution and summary carry-forward can duplicate everything or hide everything

**Scenario A (late-applied commit).** Commit C1 (base S0) times out. The committer reads the
catalog: still S0 (C1 is in flight inside the catalog, or the load is stale). It concludes C1
failed, builds C2 with the same files plus new ones. C1 lands, then C2 gets a 409. `research/07`
row 10 says "refresh and retry (appends rebase trivially)". A trivial rebase re-appends C1's
files: every row of that batch is in the lake twice, permanently.

**Scenario B (snapshot without watermarks).** §4.3 says append commits write watermarks. §5.3
compaction `replace` and retention `delete` snapshots are not said to. Also any other actor with
catalog write access (an external engine, catalog-side maintenance such as snapshot expiry or
manifest rewrite, an operator) can create a snapshot. The next reader of "the snapshot summary"
finds no watermarks. If absent means 0: the head tells queries to ask `seq > 0` (shards have
truncated: gap; or have not: double count), and the committer re-commits the whole ledger.

**Why.** "Resolved by reading the snapshot summary" assumes one writer, linearizable reads and
that every snapshot carries the map.

**Fix.**
- Every commit uses `assert-ref-snapshot-id` and puts a unique `viz.commit_id` in the summary.
  Outcome is decided by searching the ancestry for the commit id, and a 409 always recomputes the
  pending set against the new head's watermarks; no blind rebase.
- Persist a commit intent (file set, commit id, manifest keys) in the ledger before any I/O.
- Every viz snapshot type copies the watermark pointer forward. A current snapshot without it is a
  hard stop (alert, no commit, no head publication), never "zero".
- External engines get read-only credentials.

### 5. Shard-map changes have no global boundary: dual ownership, missed tails, broken dedup

**Scenario.** §4.4: "a new map takes effect at a sequence boundary". Sequences are per shard;
there is no cross-shard sequence. The map is read from KV, "cached; stale-tolerant". During a
doubling, edge isolate X (old map) routes series s to shard A while isolate Y (new map) routes it
to A'. Both acknowledge.
- A client retry of the same request through the other isolate is split differently, so the
  sub-batch fingerprint differs and A' has never seen it: duplicate (permanent for logs/spans).
- A query planner with a stale map does not know A' exists and never asks it: rows acknowledged
  by A' are invisible until committed, then appear (flicker; breaks the 10 s SLO and rules).
- A' has no entry in the snapshot's watermark map; "missing" is undefined.
- "Each series lives in exactly one shard" (§4.1), on which `topk` and per-series functions
  depend, is false across the boundary; per-shard exact quotas count the series twice.

**Why.** The boundary is described but no mechanism enforces it at the shards.

**Fix.** Map epochs with fencing: the `Tenant` DO is the authority; each write carries the map
epoch; a shard that has been told about epoch N+1 rejects writes routed under ≤ N for keys it no
longer owns (`STALE_MAP`, edge refetches from the `Tenant` DO, not KV). New shards are registered
with the committer (watermark 0, new incarnation) before the epoch is activated. Queries take the
shard list from the table head / `Tenant` DO and ask the union of shards of all epochs that may
still hold uncommitted rows. On split, the child inherits the parent's fingerprint window, and the
fingerprint is computed over the request body (map-independent), not the sub-batch.

### 6. Tail as a separate leaf breaks per-series evaluation and exact aggregation

**Scenario A.** `rate(x[5m])` at now: four minutes of series s are in the lake, one minute in the
tail. If "the tail is one more leaf input" (§6.3) means the tail is evaluated as its own leaf
returning partial aggregates, neither leaf sees the full window; the merge of two partial rates
is wrong (and counter resets at the seam are missed). The same applies to time splits (§6.2 step
5) for any range-vector window crossing a split boundary.

**Scenario B.** A sample `(s, t)` exists in the lake and again in the tail (re-batched client
retry, HA pair, replay after finding 5). `research/07` relies on last-write-wins on `(series, ts)`
at query time. Sum/count computed independently by a lake leaf and a tail leaf and then added
double-counts it. "sum/count decompose exactly" holds only over disjoint row sets.

**Why.** The decomposition unit is not stated. The design never says where `(series, ts)`
dedup happens or which copy wins.

**Fix.** State the invariant: all rows for a `(series-hash bucket, evaluation window + lookback +
range)` from lake files *and* tail are merged, deduplicated by `(series_id, ts)` with highest
`(file sequence, seq)` winning, in one evaluator before any aggregation. Tail shards return raw
sorted rows (or file references) for the bucket to that leaf; they never aggregate. Time splits
overlap by range + lookback.

---

## Major

### 7. Watermarks in the snapshot summary make metadata grow as shards × retained snapshots

**Scenario.** The summary lives in `metadata.json`, which lists every retained snapshot and is
rewritten in full on each commit and returned by every `loadTable`. With 1,000 shards at ~40
bytes each, one summary is 40 KB; at one commit per minute and 1-day expiry that is 1,440 × 40 KB
≈ 58 MB per commit, per table. 10,000 shards with 3-day expiry is ~1.7 GB. The committer (128 MB)
cannot load its own table. Catalog limits on summary size are undocumented.

**Fix.** The summary holds one property: the key and checksum of an immutable watermark object on
R2 (full map, or base + delta chain compacted every N commits). Snapshot retention in hours, not
days, for hot tables.

### 8. `identity(tenant_id)` + tenant-day manifests: per-commit work and the head grow with tenants × days

**Scenario.** One cell, 1,000 active tenants, 30-day retention, 7 tables.
- Each commit rewrites one manifest per active tenant-day per table: ~1,000 PUTs per table per
  minute ≈ 10 M Class A/day ≈ $45/day for manifests alone, before data files, footer bundles and
  the head.
- The manifest list has one entry per live tenant-day: 30,000 entries (several MB) rewritten per
  commit; at 10,000 tenants × 90 days it is ~900,000 entries and no longer fits an isolate.
- The table head carries the same partition → manifest map, is rebuilt and published every commit
  and fetched by every query Worker every few seconds.
- With six concurrent connections, 10,000 manifest rewrites do not finish inside the 60 s cadence;
  the committer falls permanently behind (livelock: each commit takes longer than the interval
  that feeds it).
- Each active tenant emits at least one flush file per table per minute regardless of volume: a
  tenant trickling 1 KB/min produces ~7,000 near-empty Parquet files per day, plus 24 hourly
  compaction outputs per table per day.

"Idle costs nothing" holds only for a tenant that sends nothing. A tenant with one 15 s scraper
is never idle and costs roughly 1 M Class A operations a month by itself, which is the whole free
allowance.

**Fix.** (a) Seal on bytes or a long age (10–15 min) for low-volume shards; freshness already
comes from the tail, so the 60 s seal buys nothing. (b) Per-tenant head objects, so a query reads
only its tenant's slice and a commit rewrites only touched slices. (c) Manifest granularity per
day (multi-tenant manifests) for the current day, tenant-day only after compaction; or bucket
tenants. (d) An explicit, enforced cell budget (active tenants, live partitions, shards) with
automatic cell split. (e) Skip the hourly tier for partitions below a size threshold.

### 9. Committer slow or down: unbounded ledger, WAL bound hit in minutes, query cliff

**Scenario.** Catalog outage of 30 minutes.
- Shards keep flushed-but-uncommitted segments in SQLite (§4.3 step 5 deletes only below the
  watermark). At 5 MB/s a shard reaches a 1–2 GB ceiling in about five minutes and 10 GB in about
  half an hour: cell-wide 429s caused by a component that is "off the request path" (§12).
- Every query now receives a reference list of all uncommitted files per shard (30+ per table).
  These files have no footer bundle, so each costs a footer read: queries get slower exactly when
  the system is degraded.
- The ledger "knows every file viz ever wrote": at 1,000 tenants × 5 tables × 1,440 files/day that
  is ~7 M rows/day (≈ $7/day in row writes, ~1 GB/day), reaching the 10 GB DO cap in about a week
  even without an outage.

**Fix.** Once a PUT is verified, the shard drops the payload and keeps only the unit record with
the file's footer/stats inline; SQLite growth is then bounded by R2 availability, not by the
committer. Backpressure on *uncommitted unit count* is separate and much looser. The ledger holds
pending and live files only; history goes to immutable R2 log objects (see finding 16). One ledger
row per flush unit, not per file.

### 10. Commit critical section: `blockConcurrencyWhile` or an in-memory lock both fail

**Scenario.** A commit is seconds to tens of seconds of R2 and catalog I/O. If it runs under
`blockConcurrencyWhile`, every shard report queues behind it; reports time out, shards retry, the
queue deepens, the DO returns overloaded errors, and flushes stall cell-wide. If it runs with a
plain in-memory "committing" flag, the input gate opens on each `fetch`; a report arriving
mid-commit mutates the pending set being committed; and an eviction mid-commit loses the flag, so
the alarm retry starts a second commit over an overlapping set.

**Fix.** A persisted state machine: `intent` row (frozen list of unit ids, commit id, parent
snapshot) written first; reports during a commit go to the next batch; single-flight is decided by
the persisted row; restart resumes or resolves the intent (finding 4). No `blockConcurrencyWhile`
outside initialisation.

### 11. Late, out-of-order and future timestamps: stale rollups, resurrected and immortal partitions

**Scenario A.** Hour H of day D−2 is compacted and its 5 m / 1 h rollups written. A sender
replays a buffer; samples for H are acknowledged, flushed into partition D−2 and committed. Raw
and rollup now disagree forever; queries pick one by resolution and return different answers for
the same range. "They cover exactly the data that was compacted" is true and is the problem.

**Scenario B.** Raw retention is 15 days, rollups 13 months. A sample for day D−20 is accepted.
Its file lands in an already-expired partition, which reappears and is never expired again if
retention walks forward by day; the rollup never includes it.

**Scenario C.** A client with a broken clock sends ts in 2099, or a batch spanning 400 days. One
segment produces 400 files in 400 partitions per table; future partitions never age out.

**Scenario D.** Compaction workflow step is retried (at-least-once) after its commit succeeded:
rollup rows are appended twice (rollups and samples are different tables, different commits);
merging rollup sums double-counts.

**Fix.** Per-signal accept window enforced in the shard (reject older than a configured
out-of-order bound and newer than now + a few minutes, with a visible reason); a separate
backfill API that writes through the compaction path. Compaction of a window starts only after
`window_end + accept window + commit lag` and with no pending unit for that partition. Each
rollup file records the raw input set it covers; an append to a partition with a rollup marks it
dirty, queries fall back to raw until re-rolled. Compaction outputs are keyed by a hash of the
input file set and the committer deduplicates on it.

### 12. Compaction `replace` and retention/erasure are not validated against the live set

**Scenario A.** A compaction of (tenant T, day D) runs for minutes. Meanwhile retention or
erasure deletes the partition. The replace commit arrives: "remove A, B; add C". If the committer
applies it without checking that A and B are still live, C is added and the erased tenant's data
is back in the table. Same with two overlapping compactions (duplicate Workflow run): the second
adds C′, duplicating C.

**Scenario B.** Erasure commits. A shard still holds T's tail, a flushed-but-uncommitted file, or
a retry arrives; the next append re-adds T's rows. Leaf and result caches (§6.4, "valid forever")
keep serving T's data; files stay on R2 until snapshot expiry (1–3 days) plus sweep.

**Fix.** Replace is conditional on `inputs ⊆ live set` checked in the ledger transaction, else
rejected; one compaction lease per partition. Retention is a persistent predicate in the
committer (`tenant, signal, min_day`, erase epoch): pending units below it are dropped, and shards
are told to reject. Erasure includes shard tails, pending units, cache purge by tenant-scoped
cache key prefix, and an immediate snapshot expiry for the cell or a documented delay.

### 13. `metric_series` and `metric_samples` are not consistent across the seam

**Scenario A.** New series s arrives. §6.2 step 4 resolves matchers "against `metric_series`",
i.e. the lake. The series row is still in the tail, so s is not in the id set and its tail
samples are filtered out: a new series is invisible for up to seal + commit time (minutes), not
10 s. Then the samples table commits before the series table: samples are in the lake, the series
row is in a different table's tail; depending on which watermark the tail read uses, s appears
and disappears between refreshes.

**Scenario B.** A shard is evicted after ~70–140 s idle and loses its in-memory "series already
written today" set. A tenant that scrapes every five minutes re-emits every series row on every
scrape: `metric_series` grows as fast as `metric_samples`. Persisting the set per series costs a
billed row write each.

**Scenario C.** "Per day" by wall clock versus by sample timestamp: a late sample for D−1 arrives
at 00:01; if the seen-set is keyed by today, no series row exists in partition D−1 for a series
first seen then, and the sample can never be matched. Retention deleting the series partition
before the samples partition leaves a window of unmatched samples.

**Fix.** Series resolution = lake `metric_series` at its own watermark ∪ tail series rows above
that watermark, from every shard; tail reads are per table with that table's watermark. Seen-set
is keyed by (series, sample day), persisted as one compact blob per sealed unit and reloaded on
wake. Duplicates are legal and collapsed at compaction. Retention deletes samples before series.

### 14. Fingerprint dedup dies with WAL truncation

**Scenario.** `research/07` keeps the fingerprint as the WAL row's primary key. A batch is
acknowledged but the ack is lost. The row is committed and truncated ~2 minutes later. The
collector's retry (backoff up to 5 min by default; Prometheus retries indefinitely) arrives after
truncation and is accepted as new. Logs and spans are duplicated permanently; metrics rely on
finding 6's dedup.

**Fix.** A fingerprint store with its own retention (≥ 15 min, longer than the documented client
retry horizon), independent of WAL truncation: one blob row of fingerprints per sealed unit keeps
the row-write cost flat. Document that retries later than the window may duplicate, and add
content-derived row ids for spans (`trace_id, span_id`) and logs at compaction.

### 15. Shard DO memory and single thread: poison segments and ingest stalls

**Scenario A (memory).** Sealing 16–32 MB of *encoded* batches means decoding to columns (several
times larger), a sort (permutation plus copy), dictionary and page buffers, zstd, and the output
object, while group commit holds incoming batches (up to 8–32 MB each) and a tail read
materialises the open segment as Arrow. `research/02` budgets 60–80 MB usable, and the isolate may
be shared with other shards of the same class. The flush OOMs; the isolate resets, taking
co-located tenants' shards with it; the alarm retries the same segment and OOMs again. After six
retries the alarm is dropped. Nothing re-arms it; the WAL fills; the shard answers 429 forever.

**Scenario B (CPU).** Sort + encode of a 32 MB segment is seconds of uninterrupted WASM. At the
budgeted 5 MB/s a segment fills every ~6 s, so the shard spends a large fraction of its time
unable to acknowledge writes (p99 < 500 ms fails) or answer tail reads. Conversely every dashboard
panel that touches "now", and every rule, issues a tail read to every shard of the tenant; each
decodes the open segment. Read load directly reduces write availability of the same tenant.

**Fix.** Bound the seal by decoded bytes; sort small runs at append time and k-way merge into
streamed row groups with multipart upload; on failure persist an attempt counter and halve the
unit. The alarm handler re-arms itself first. Prefer moving encode out of the shard: a stateless
Worker pulls the sealed unit as a stream, encodes and PUTs, and returns the footer. Tail reads:
admission limit per shard, writes prioritised, and a 1–2 s memo of the tail answer keyed by
`(W, max_seq, projection)`. Admission on in-flight bytes before a body is read.

### 16. "Ledger + R2 can rebuild the table" is not true as stated

**Scenario.** The ledger is one DO's SQLite. If it is lost, corrupted, or pruned (finding 9 forces
pruning), an R2 listing cannot tell committed files from orphans, compaction inputs from outputs,
or live partitions from retention-deleted ones. A rebuild from the listing double-counts every
compacted range and resurrects every erased tenant. Separately, switching to the R2-native
catalog during an incident leaves two candidates for "current snapshot" with no epoch to choose.

**Fix.** The committer appends each commit's delta (added, removed, watermark pointer, parent) as
an immutable, sequence-numbered R2 object with put-if-absent *before* the catalog commit. That log
is the rebuild source and is also the CAS log of the R2-native catalog, so the two paths share one
truth. The head carries a catalog epoch; a switch bumps it.

### 17. Shared tables plus "readable by any Iceberg engine" is a cross-tenant read

**Scenario.** A small tenant in a shared cell is given catalog credentials for an external engine
(the headline of §1). `research/01`: the managed catalog has no per-table authorisation, let alone
per-partition. The planner-injected tenant predicate (§6.1) does not exist in Spark or DuckDB.
The tenant reads every tenant's rows. The same applies to SQL passthrough if it reaches Basin SQL
with table-level credentials.

**Fix.** State that direct Iceberg access exists only for single-tenant cells; shared-cell
tenants get it through viz's query surface or a per-tenant export. SQL passthrough is planned by
viz with the tenant predicate injected, never forwarded verbatim.

### 18. Footer bundle is described as both per-partition and immutable

**Scenario.** "One small object per tenant-day partition" (§5.2) changes on every commit that
touches the partition, yet §6.2 caches it as immutable. A query at snapshot S reads a cached
bundle from S−3 (missing files: rows silently skipped if the bundle drives pruning) or a bundle
from S+1 after compaction (lists files not in S and omits files that are). Writing it before the
commit leaves a bundle describing a commit that failed; after, a head that points to nothing.
Rewriting it every minute is quadratic over the day.

**Fix.** Bundle keys are content-addressed and referenced from the head beside the manifest;
written before the commit; a file in the manifest but missing from the bundle falls back to a
footer read (never skipped). Use a base + delta layout for the current day.

### 19. Step-aligned result cache has no definition of "closed"

**Scenario.** A range ending two minutes ago is cached. A late batch within the accept window, a
slow shard's flush, or a retention/erasure commit changes the truth; the cached result is served
indefinitely. With finding 3B, a cached leaf result over an overwritten file is wrong forever.

**Fix.** Closed = `end < now − accept window − margin`. Cache keys include tenant, access policy
hash, and a per-tenant retention/erase epoch. Leaf cache keys include the file checksum.

---

## Minor

20. **`trace_index` → "files and row groups"** (§6.5). Physical locations in one table go stale
    when `spans` is compacted in a separate commit. Store only day, time bounds and service;
    locate by sort order and bloom filter. Also define how per-segment partial trace rows (root
    span arriving later, duration, counts) are merged at read time before compaction.
21. **Orphan sweep liveness.** "Unreferenced" must mean: not in any retained snapshot, not pending
    in the ledger, not held by a shard as a tail reference. Otherwise a long committer outage plus
    the sweep deletes the only copy of acknowledged data once finding 9's fix is applied.
22. **Shard maps only grow, and all three signals share one map.** A log burst doubles metric
    shards; afterwards every query wakes every shard (requests and duration billed; six-connection
    limit) forever. Use per-signal maps, allow merge at an epoch boundary, and let a shard declare
    "empty above seq N" in the head (revoked before its next ack) so planners can skip it.
23. **Shared isolate.** Several shard DOs of different tenants can share one isolate. A
    module-global WASM instance with reused arenas is a cross-tenant bleed risk and one tenant's
    OOM evicts others. One WASM instance per object, zeroed arenas, and a fuzz case for it.
24. **Committer trusts shard reports.** Derive tenant and partition from the authenticated shard
    identity and verify the key prefix; do not take the partition tuple from the report body.
25. **Row size.** A WAL row is at most 8 MB (2 MB in older docs); a group-commit blob must be
    chunked within one transaction.
26. **Confirm-by-reload doubles catalog operations** (2 per commit per table ≈ 600k/month per
    cell at 1/min across 7 tables). Fine for one cell; the second cell is no longer free. Adaptive
    cadence (60–300 s) from `research/05` was dropped; restore it.
27. **Counter-reset-aware rollups across day partitions and shard-map epochs** need the previous
    window's last sample; specify where it comes from.
28. **Partial success.** One request fans out to several shards; one returns 429. Specify the
    protocol response (OTLP partial success, PRW retry) and that the retry is absorbed by the
    shards that already accepted (depends on finding 5's body-level fingerprint).

---

## Checked and found sound

- **Single mutator per table with managed compaction off** removes append/compaction pointer
  races, provided findings 4, 10 and 12 are adopted.
- **Reading an older cached head is still exact** as long as the shard fence exists: lake(S) ∪
  tail(> W_S) is complete for any retained S, so different isolates on different snapshots do not
  cause flicker by themselves.
- **Compaction and in-flight queries.** A query on S keeps reading S's files after a replace
  commit; snapshot expiry in hours to days comfortably exceeds query duration.
- **Leaf partial-result cache keyed by immutable file set** is correct once files are truly
  immutable (finding 3) and the key includes the access policy.
- **Ack after durable group commit, 429 rather than drop.** The output gate gives this; no
  acknowledged-then-lost path found in the shard's own append.
- **WAL rows as whole batches** is the right cost shape; hash routing by series / trace / stream
  is right for decomposition within one map epoch.
- **Tenant id from the credential, injected by the planner** is sound for viz's own query path
  (the gap is external engines, finding 17).
- **Keeping the catalog off the query path** is correct and necessary; only the publication
  medium and its fence need specifying (finding 1).
- **Double delivery of a report or alarm** is harmless at the committer when keyed by flush unit;
  the harm is only on the PUT side (finding 3).
