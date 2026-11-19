# Correctness re-review of DESIGN.md (draft 3)

Scope: §2–§6 and §3.3 only; only problems that are new in draft 3, or that draft 3 claims to
have fixed and has not. Paper review; nothing was run. Findings from the draft 2 review that
draft 3 does resolve are not repeated.

Summary: 4 critical, 8 major. The ledger-plus-fence core is sound for the single-tenant,
single-shard, steady-state case. The problems are at its edges: objects the ledger depends on
but does not write inside its transaction (partition index, R2 change log, the Parquet object
itself), state that is "per shard" in the text but must be per (shard, tenant, incarnation),
and three places where a time-based rule (grace period, "accept window has passed", "old
shards have sealed") stands where a recorded watermark is needed.

---

## Critical

### 1. The partition index object is updated outside the ledger transaction: lost update, silent gap

**Text.** §5.2: each partition has one index object, "content-addressed and referenced from the
ledger". §6.1: the plan call returns "the partition index objects for the time range", and the
planner prunes from them. So the planner sees files through the index, not through the ledger's
file rows.

**Scenario.** Tenant with 8 shards. Shards A and B seal within the same second; both units
touch `metric_samples` for the open hour. Each flush reads the current index `I0`, builds
`I0+fA` and `I0+fB`, PUTs it (content-addressed, so both succeed), and reports its unit. The
ledger accepts A (pointer → `I0+fA`), then B (contiguous for shard B, so accepted; pointer →
`I0+fB`). File `fA` is live in the ledger, its watermark has advanced, shard A discards the
segment. The planner reads `I0+fB`, never sees `fA`, and asks shard A only for rows above the
new watermark. The rows are in neither. No refusal fires: this is the silent gap the fence
exists to prevent. It lasts until the next unit or compaction happens to rebuild the index
from the ledger, and returns each time two units race.

**Why the text does not prevent it.** Contiguity is checked per shard; the index is per
partition and shared by all shards. Nothing says who builds the index or that the pointer swap
is conditional. If the ledger itself builds it, an R2 PUT sits inside every ledger transaction
(see finding 2).

**Smallest fix.** Do not have one mutable-by-replacement index per partition on the flush
path. Each file gets its own immutable index fragment, written by `flush` beside the file and
referenced from that file's ledger row. Only compaction (already a compare-and-swap on its
inputs) writes a consolidated index. The plan call returns consolidated index + fragments of
the not-yet-compacted files, both derived from the ledger rows at version V. Add an invariant:
files reachable from the plan response = ledger live set at V.

### 2. The R2 change log has no ordering or recovery rule against the SQLite transaction

**Text.** §2.1: "Every change to it is one SQLite transaction, and every change is also
appended to an immutable log on R2, so the ledger can be rebuilt from R2 alone."

**Scenarios.**

- *Commit, then log.* Ledger commits unit U as version 41, acknowledges `flush`, the shard
  discards. The isolate dies before the log PUT. Later the ledger is rebuilt from R2: version
  40, watermark W. The shard has discarded through D > W. Every query is refused (discarded
  above W) and re-reads the same ledger forever; `flush` can never extend W contiguously
  because the shard no longer holds (W, D]. That shard is permanently stuck, its WAL fills,
  the sender gets 429 indefinitely. U's file is on R2 but unreferenced; the orphan sweeper
  deletes it. Acknowledged data is lost.
- *Log, then commit.* The PUT is an `await`; the input gate opens. A retention removal is
  logged as 41 but not yet committed; a compaction is validated against pre-41 state ("all
  inputs live"), logged as 42, committed. Finding 12 of the draft 2 review is back. If the
  isolate dies after the PUT of 41 and before the commit, the log holds a version the ledger
  never had, and the next change is also numbered 41.
- *Either order, after any rebuild.* Version numbers are reused for different content. §13
  caches plans "by ledger version" and §5.3 records "which ledger version of each tenant" a
  snapshot reflects; both now name the wrong state.
- Serialising PUT + commit (a lock or `blockConcurrencyWhile`) puts 20–100 ms of R2 latency in
  the critical section: about 10–50 changes per second and plan calls queued behind them,
  against the S4 target of 17 units per second. This is draft 2 finding 10 again.
- The log is unbounded (one entry per seal, forever), so "rebuild" is a replay from tenant
  creation.

**Smallest fix.** State the protocol: (a) SQLite commit is the commit point and includes an
outbox row; (b) outbox rows are group-written to R2 as `log/<ledger-incarnation>/<version>`
with `If-None-Match`; (c) the acknowledgement that permits a shard to discard, and anything
handed to the publisher, is released only for versions at or below `logged_through`;
(d) on start, re-PUT the outbox tail; (e) a rebuild bumps the ledger incarnation, which is
part of every version identifier; (f) periodic checkpoint of the live set so replay is
bounded; (g) before discarding, the shard reads back the ledger's watermark for itself rather
than trusting the `flush` Worker's word.

### 3. Deterministic key + `If-None-Match` + an orphan sweeper: a referenced file can be deleted or mis-described

**Text.** §4.3.2: "Keys are deterministic and PUTs use `If-None-Match: *`, so a retry can never
overwrite a file with different bytes." §3.1: `jobs` runs an "orphan sweep".

**Scenario A (loss).** Attempt 1 PUTs the file and dies before the ledger add. The sweeper
lists the bucket, sees an object not in the ledger. Attempt 2 starts, gets 412 ("already
there, good"), reports the unit; the ledger accepts; the sweeper deletes the object; the shard
discards the segment. The ledger references a missing object and the WAL copy is gone. The
same race exists for compaction outputs. The draft gives the sweeper no rule at all.

**Scenario B (mis-description).** Two `flush` Workers run for one seal (duplicate wake, or a
retry while the first is still running), or a deploy lands between attempts. The encoder
version, zstd level or row-group sizing differs, so the bytes differ. For a unit of three
files, Worker 1 wins the PUT of files 1 and 3, Worker 2 wins file 2. Whichever report the
ledger accepts carries statistics, row-group offsets, size and index fragment computed from
that Worker's own encode, for at least one object whose stored bytes are the other Worker's.
Readers seek to wrong offsets; Iceberg readers locate the footer from `file_size_in_bytes`
and fail or misread. "Never overwrite with different bytes" is true and not sufficient: the
metadata must describe the bytes that won.

**Smallest fix.** Put the content hash in the object key (and the index fragment key). A
losing attempt then produces a different key, not a 412; the ledger's first accepted report
for `(shard, incarnation, sequence range)` is the arbiter and names exactly the bytes it
describes. Sweeper rule: delete an unreferenced flush object only if its sequence range is at
or below the shard's watermark in a ledger version read *after* the listing (no later add can
reference it); compaction outputs carry a job id registered in the ledger before the first
PUT and are swept only once that job is recorded finished or abandoned.

### 4. Shared shards: sequence, seal, unit, discard, epoch, incarnation and fingerprints are specified per shard, not per tenant stream

**Text.** §3.3: several tenants' batches land "in the same shard object, each in its own WAL
stream". Everywhere else the unit of sequence, watermark, seal, discard, epoch and
fingerprint is "the shard". The ledger is per tenant.

**Scenarios.**

- *Contiguity cannot hold.* If the shard has one sequence space, tenant A's units have holes
  where tenant B's rows are; A's ledger rejects them as non-contiguous, or accepts gaps and
  the contiguous-prefix guarantee (draft 2 finding 2) is void.
- *Cross-tenant head-of-line.* If a seal covers the shard, one unit spans several ledgers.
  There is no cross-ledger transaction. The segment can be discarded only when every ledger
  has acknowledged; tenant B's ledger being slow, over a storage limit, mid-rebuild or deleted
  pins the segment, the shared WAL reaches its bound, and every tenant in the shard gets 429.
  The same happens through §4.2.2: batches in one commit window share one transaction, so one
  tenant's failing batch fails the others' acknowledgements.
- *Fingerprints.* If the batch fingerprint does not include the tenant, tenant B sending bytes
  identical to a batch tenant A already sent is treated as a retry: B's data is acknowledged
  and dropped, and response timing tells B what A sent.
- *Tail reads.* The tail read is "a filtered scan over a shard's unsealed and unflushed
  segments". In a pooled shard the tenant must select the stream before any scan, taken from
  the credential, not be a predicate a caller supplies. `flush` reading "the sealed runs" has
  the same exposure: a Worker with a binding to a pooled shard can read any tenant's segment
  unless the read is bound to a (tenant, incarnation, range) capability.
- *Epochs.* The epoch is owned by a tenant's ledger; a pooled shard must hold one per tenant
  and seal only that tenant's stream on a map change.

**Smallest fix.** Define the *stream* `(shard, tenant, incarnation)` as the unit of sequence
numbers, seal, flush unit, watermark, discard mark, epoch and fingerprint scope. A unit never
spans tenants. Commit windows may share a storage transaction but a per-tenant rejection must
not fail it. Bounds (bytes, unflushed age) are per stream, with the shard-wide bound reached
only if the sum of per-stream bounds is mis-set. Tail and flush reads take the tenant from the
authenticated context and address one stream. Add the pooled case to the cross-tenant fuzz
suite.

---

## Major

### 5. The fence is safe but not live: refusals do not converge at high seal rates

**Scenario.** A large tenant: 30 shards, each sealing a few MB every 2–5 s. A query's seam
window (plan call, index fetch, fan-out, leaf start, tail read) is 0.5–2 s; more through a
Container. The chance that no shard has recorded a unit and discarded in that window is
roughly (1 − d/T)^30: under 1% for d = 1 s, T = 5 s. "The query re-reads the ledger" restarts
it; the second attempt has the same odds. Rule ticks hit the same wall, so alerts go stale
exactly when volume is high. A cursor-paginated log or TraceQL search resumed minutes later
is always refused.

**Why the text does not prevent it.** Discard follows the ledger acknowledgement immediately
(§4.3.4); refusal restarts at query scope (§2.3).

**Smallest fix.** Keep the fence for safety and add retention for liveness: a shard keeps
recorded segments for a bounded time (the query timeout, tens of seconds) or the last K
segments, within its byte bound, and discards early only under pressure. Make the retry
per split: the refused leaf re-reads the ledger and re-plans *its own key range* at V′ (files
and watermark from the same version). Mixed versions across key-range-disjoint splits are
safe; a leaf must never combine files from V with a watermark from V′.

### 6. Map-epoch change: "sealed" is not "recorded", shards drop out of the plan, fingerprints do not follow the key

**Text.** §4.1: "A map change takes effect only after the old shards have sealed, so no key is
ever owned by two shards."

**Scenarios.**

- *Visibility regression.* Old shard A seals for epoch 7; the map moves key K to shard B at
  epoch 8. A's last segment is sealed but not yet flushed. If the plan call returns the
  watermarks of the shards in the current map, A is not asked; rows that were visible a second
  ago disappear until A's flush is recorded, then return. A rule can resolve and re-fire.
- *Two tails.* Until A's final unit is recorded, series K has rows in A's tail and B's tail.
  Anything evaluated per shard and merged (§6.2 "`topk` is per shard then merged", §4.1 "what
  later makes per-series functions decomposable") computes two partial series for K.
- *Duplicate on retry.* A acknowledged a batch; the acknowledgement was lost; the sender
  retries after the epoch change; `edge` routes to B; B has no fingerprint; the batch is
  accepted again. Metrics are repaired by `(series, timestamp)` dedup at read. Logs and spans
  have no such key: the duplicate is permanent. If a request is split across shards, a new map
  also splits it differently, so sub-batch fingerprints do not match either.

**Smallest fix.** The ledger tracks *draining* streams (sealed for an old epoch, final unit
not yet recorded) and returns them from every plan call until that unit is recorded. The
fingerprint is computed per request and per routing key, independent of the split, and on a
map change the old shard hands the fingerprints for moved keys to the new owner before the
epoch activates (or the new shard consults the old on a miss for one retry horizon). The
shard durably records "closed for epoch e" so a write with a stale but locally current epoch
cannot land after the seal.

### 7. Sender-keyed routing does not give "a series lives in exactly one shard"

**Scenarios.**

- *Remote Write.* A Prometheus server sends batches that mix series from all its targets.
  Routing by `job`/`instance` splits every request across most shards: "one request … normally
  lands in one shard" is false for the main Prometheus path, the all-shards-must-commit rule
  of §4.2.3 applies to every request, and platform finding C1 returns. Series without those
  labels (recording rules, federation, `honor_labels`) all hash to one key.
- *Attribute drift.* With OTLP the series identity is the metric plus identifying attributes;
  the routing key is the whole resource fingerprint. An SDK upgrade, a collector processor
  adding an attribute, or a changed `k8s.pod.uid` under a stable `service.instance.id` changes
  the route but not the series. The series is now in two shards with no epoch change and no
  seal, for as long as the old tail lives (10–15 minutes for small tenants).
- *Skew.* One key cannot be split. A single large source (a CDN log stream, a gateway that
  stamps one resource) is bound to one single-threaded shard; adding shards does not help and
  the sender sees permanent 429.

**Why it matters.** Any evaluation that trusts the invariant gives wrong `rate()`, `topk` and
counts without an error.

**Smallest fix.** Treat routing as locality only. Correctness rule: a split is a key range,
and the leaf merges file rows with tail rows from *every* shard (current and draining) for
that range before evaluating; nothing is evaluated per shard. Define the routing key as the
identifying subset only (`job`+`instance`; `service.namespace`/`name`/`instance.id`), never
the full resource. For a hot key, the map may assign a sub-split by series or stream hash,
recorded in the epoch.

### 8. Shard incarnation change has no handshake: fail-closed for a seal age, then a silent gap

**Text.** §4.3: "A shard that loses its storage starts a new incarnation."

**Scenario.** A shard with empty storage cannot tell "new" from "lost"; in a pool it does not
even know which tenants it served. The ledger still holds (incarnation 1, W). A query asks the
shard for rows above (1, W). If the shard answers "none", that is a silent gap. If it refuses,
the query re-reads a ledger that will say (1, W) until incarnation 2 records its first unit:
up to the seal age, 10–15 minutes of total query and rule outage for the tenant, or forever
if that tenant sends nothing more. When the ledger does move to incarnation 2, the rows of
incarnation 1 above W are gone and nothing records it, so "never returns a silent gap" is
false from then on. A late `flush` report for a segment of incarnation 1 read before the loss
is real data and is rejected.

**Smallest fix.** Incarnations are issued by the ledger. Tail reads and writes name
(tenant, incarnation); a shard with no record of that stream asks the tenant's ledger, which
in one transaction opens incarnation n+1 at watermark 0, keeps incarnation n open for late
units for a bounded time, and records the loss interval (n, above W, wall-clock bounds). Query
results overlapping a recorded loss interval carry a warning.

### 9. A flush unit is "one file per table touched", but a segment spans partitions

**Scenario.** A segment sealed on a 15-minute age across 00:00, or any segment while the accept
window allows an hour of lateness, holds rows for two days (two hours for `spans`). One file
per table then carries rows for two partitions. Either it is filed under one of them, so the
planner's "partition index objects for the time range" and every external engine's partition
pruning skip the rows of the other, silently; or it violates the Iceberg rule that a data file
has one partition tuple and the publisher cannot commit it.

**Smallest fix.** One file per (table, partition) touched; the unit is all of them and is
still one ledger transaction. State it in §4.3 and add the invariant "every row's partition
value equals its file's".

### 10. "An hour closes when the accept window has passed" ignores rows still in the tail

**Text.** §5.2: rollups are written at close, "nothing later can change it"; hours merge into
days after the window. §6.3 caches results as final on the same rule.

**Scenario.** The accept window is checked at acknowledgement. A row for 13:59:50 is
acknowledged at 14:59 (inside a one-hour window). The tenant seals on a 15-minute age, or the
flush is failing and retrying, or the ledger was unreachable. At 15:00 the hour is "closed";
the rollup job reads the ledger's files; the row reaches a file at 15:14. The 5-minute and
1-hour rollups undercount permanently, and long-range dashboards and rollup-class rules read
them. Queries over raw data are right, so the two disagree.

**Smallest fix.** Closure is a ledger fact, not a clock: hour H is closed when
now > end(H) + window **and** every stream (current and draining) has recorded a unit whose
seal was taken after end(H) + window; idle streams record an empty unit to advance. Rollups,
hour-to-day merges and "final" caching key off that flag.

### 11. Publication through a queue: order, loss and deletion are not pinned down

**Text.** §5.3: the publisher "consumes ledger changes from a queue". §5.2: objects are
deleted "after the removal has been published and a grace period has passed".

**Scenarios.**

- *Out of order or duplicated.* v5 adds F1; v6 (compaction) removes F1 and adds F2. Delivered
  as v6, v5, or v5 redelivered after v6: the table holds F1 and F2 and external engines double
  count until the scrubber notices.
- *Lost.* The enqueue is not in the SQLite transaction. A crash between them, or a message
  that reaches the dead-letter limit, leaves a hole at v5. A publisher that waits for
  contiguity stalls that tenant's publication, and with it every physical delete, forever; one
  that does not wait diverges.
- *Deletion.* An external engine pinned to a snapshot older than the grace period gets 404s:
  the open hour is rewritten every 5–10 minutes, so files are short-lived. Erasure has the
  opposite problem: retained snapshots, their manifests' column bounds, and the immutable
  change log (file statistics) still describe the erased data.

**Smallest fix.** The queue message is only a hint "tenant T changed". The publisher keeps a
cursor per tenant, reads the logged changes after it from the ledger or the R2 log in version
order, and commits the new cursors in the same snapshot. That is idempotent and ordered, and
a lost message costs one cycle. Physical deletion is gated on snapshot expiry (state the
retention), not on publish + grace. Erasure forces expiry of affected snapshots and requires
the change log and manifests to hold no bounds for erasable columns.

### 12. `trace_index` rows hold physical file and row-group references that compaction invalidates

**Text.** §5.1 and §6.4: the row "names the files and row groups to read". §5.2: the open hour
is minor-compacted every 5–10 minutes.

**Scenario.** A trace's spans arrive from several senders, so through several shards and
units; each unit writes its own `trace_index` row for that trace, referring only to its own
`spans` file. Ten minutes later that file is compacted away. The reference is dead: trace by
ID returns 404, or, if a missing file is treated as empty, a partial trace with no error.
Rewriting `trace_index` in the same ledger transaction as every `spans` compaction would
make it correct at a fixed ledger version but means rewriting a day-grain table every few
minutes, and the draft does not say it happens.

**Smallest fix.** Store logical references: (hour partition, service/span sort-key range or a
stable file-group id) resolved through the index at the query's ledger version. Physical
references may be added only by the final hour-to-day compaction, in the same ledger
transaction that writes those `spans` files. Lookup must merge all rows for a trace id, and a
404 on a referenced object is an error, never an empty result.

---

## Checked and found sound

- **Flush unit added between ledger read and tail read.** If the shard has not discarded, the
  tail returns the rows and V's file list excludes the new file: no double count. If it has,
  the shard refuses: no gap. Safety holds; only liveness fails (finding 5).
- **Contiguous-prefix watermark with atomic units**, for a dedicated shard: a unit that
  arrives ahead of its predecessor is rejected and retried; no hole can be passed. Needs an
  owner for re-driving a failed flush (the shard, on an alarm); the text implies it.
- **Compaction and retention during a query, viz's own readers.** A query at V reads files
  that V+1 removed; they still exist until publish + grace. This is time-based, but the
  failure is a loud 404, not a wrong answer, *provided* a missing object is always an error
  that triggers a re-plan and the grace exceeds the longest query and cursor lifetime. State
  both.
- **Compaction cannot resurrect retention-removed files**, given finding 2's serialisation.
- **Series rows and samples visible together** inside viz (one transaction per unit). External
  engines still see them separately; acceptable for a publication, and should be said.
- **Map-epoch change mid-query**, once draining streams are in the plan (finding 6): a query
  at V sees the old shard's rows and none of the new shard's, a consistent earlier cut.
- **Single publisher per cell with conditional-write compare-and-swap**: one chain of
  snapshots; a crashed commit is retried against the same parent.
- **Ingest and freshness do not depend on the catalog.** A publisher outage delays external
  readers and physical deletes only.
- **Encoding outside the shard** removes the acknowledgement stall of draft 2 finding 15;
  segments of a few MB bound the worst case.
- **Fingerprints outliving WAL truncation** (draft 2 finding 14) is fixed for a fixed map.
- **Accept window at ingest** removes resurrected and immortal partitions (draft 2 finding
  11); the remaining hole is closure (finding 10).
