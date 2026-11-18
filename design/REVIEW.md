# viz — design review and response

Draft 2 of `DESIGN.md` was given to two reviewers who had not seen its reasoning, with
instructions to break it. Their full reports are in `reviews/`. Neither ran code; both are
paper reviews.

| Review | Lens | Findings |
|---|---|---|
| [`reviews/correctness.md`](reviews/correctness.md) | Distributed-systems correctness: interleavings that lose, duplicate or hide data | 6 critical, 13 major, 9 minor |
| [`reviews/platform.md`](reviews/platform.md) | Platform limits, query realism, cost arithmetic, scope | 5 critical, 11 major, 13 minor |

## What changed in draft 3

| Finding | Draft 2 | Draft 3 |
|---|---|---|
| Visibility state lived in Iceberg snapshots: a catalog outage stalls ingest in minutes; metadata grows with tenants × days; 60 s freshness floor (correctness 7–10, platform C3) | Per-table committer; watermarks in snapshot summaries | Per-tenant ledger is the authority; Iceberg is an asynchronous publication |
| WAL truncation guarded by a grace period; a slow query or stale cached head sees a silent hole (correctness 1, platform M5) | Grace period | Fence: shards record how far they have discarded and refuse stale watermarks; the query re-reads the ledger |
| Watermark "highest sequence contained" can pass uncommitted rows; storage reset reuses sequence numbers (correctness 2) | Highest sequence | Contiguous-prefix watermark; atomic flush units; shard incarnations |
| Seal boundary not durable; retries could overwrite a committed file with different bytes (correctness 3) | Deterministic key, overwrite | Seal persisted first; `If-None-Match: *` PUTs |
| Shard-map changes had no boundary: dual ownership, missed tails (correctness 5) | "Takes effect at a sequence boundary" | Map epochs owned by the ledger; shards reject stale epochs; change only after old shards seal |
| Tail evaluated as a separate leaf: wrong `rate()` across the seam, double counts (correctness 6) | Tail as "one more leaf input" | Lake and tail rows for a key range merged and de-duplicated in one evaluator |
| Series-hash routing fans every request and every query to all shards (platform C1) | Hash by `series_id` | Route by sender-stable resource key; shards per tenant bounded |
| Sorting and encoding a 60 s segment in a 128 MB object, blocking acknowledgements (platform C2, correctness 15) | Shard encodes 16–32 MB or 60 s | Seal on decoded bytes; stateless `flush` Worker encodes |
| Cost table quoted figures derived for a different design (platform C4) | $5.20 / $250 / $18–25k | Ranges recomputed for the design as drawn; hosted and self-deployed floors stated separately |
| Trace-by-ID read hundreds of bloom filters (platform C5) | `trace_index` gives a time window | `trace_index` rows carry file and row-group references; hour partitions for spans |
| "Rules rarely touch R2" contradicted the seam (platform M1) | One cost figure | Rules classified tail / recent / rollup at save time, cost shown |
| Series row and samples could become visible separately (correctness 13) | Separate table commits | One ledger transaction per flush unit across tables |
| Late data invalidates rollups and cached results (correctness 11, platform m1) | Unstated | Accept window; hours close after it; rollups written at close |
| Compaction could resurrect files removed by retention (correctness 12) | Replace commit | Compaction succeeds only if all inputs are still live |
| "Ledger + R2 can rebuild" was not true (correctness 16) | Asserted | Every ledger change appended to an immutable R2 log |
| Shared tables readable by external engines expose other tenants (correctness 17) | "Readable by any Iceberg engine" | Direct Iceberg access only for dedicated cells |
| Cache API treated as global and permanent (platform M6, correctness 18–19) | "Cached forever" | Accelerator only; content-addressed keys; bounded lifetime; "closed" defined by the accept window |
| Marginal hosted tenant cost about $6.50 (platform C4) | Shards per tenant | Shared shard pools for small tenants |
| Component count understated (platform M11) | "Five Workers and five Durable Object classes" | Full inventory with wake cadence |
| Scope gaps: deployment model, Prometheus/Tempo APIs, scrape discovery and credentials, tiered retention, log and trace monitors (platform M10) | Missing | Added; launch scope cut into phases |
| Spike order started with the catalog, which has a fallback (platform sequencing) | Catalog first | Billing behaviour, connection semantics, flush-in-isolate and a vertical read slice first |

## Still open after draft 3

These were raised and are not resolved by design text alone.

1. **Durable Object duration billing for periodic wakes.** Decides the floor. Unmeasured.
2. **Six-connection semantics across service bindings.** Decides the leaf topology.
3. **First-load latency on flat rows.** The reviewer's walk-through of a 24-hour query on a
   1M-series tenant counted 250–400 object reads on first load, against "tens" in the
   research. Draft 3 adds minor compaction, locality-prefixed series ids and hourly rollups,
   but the result has to be measured.
4. **TraceQL structural search and unindexed log search at 100 GB/day.** Draft 3 bounds them
   and returns partial results; it does not show they are fast.
5. **Ledger throughput for a very large tenant.** Draft 3 names the escape (ledger per shard
   group) without specifying it.
6. **Shared shard pools** trade some isolation for cost. The noisy-neighbour behaviour inside
   a pooled shard is unspecified beyond per-tenant quotas.
7. The minor findings in the two draft-2 reports were not individually dispositioned.

## Re-review of draft 3

A third reviewer attacked only what was new in draft 3
([`reviews/draft3-correctness.md`](reviews/draft3-correctness.md): 4 critical, 8 major). It
judged the core sound: the fenced seam, the contiguous watermark, compaction against
retention, the single publisher chain and catalog independence. The problems were at the
edges, and draft 3.1 amends the text for each:

| Finding | Amendment in draft 3.1 |
|---|---|
| A per-partition index updated outside the ledger transaction could drop a file while its watermark advanced | Index fragments live in the ledger row, admitted in the same transaction; only compaction consolidates |
| The ledger's R2 log had no ordering or recovery rule | Outbox; shards discard only what is committed and logged; ledger incarnations; checkpoints |
| Deterministic keys plus the orphan sweeper could describe the wrong bytes or delete a file mid-retry | Content hash in the key; sweeper bound to the logged watermark |
| In shared shards, sequences and fingerprints were per shard, not per tenant | Everything is per stream `(shard, tenant, incarnation)` |
| The fence could livelock at high seal rates | Bounded retention after recording; per-split retry |
| Map change on "sealed" rather than "recorded"; fingerprints did not move | Change takes effect after final units are recorded and fingerprints handed over; draining shards stay in plans |
| Sender routing does not guarantee one series, one shard | Stated as locality only; evaluation groups by key range across shards |
| Incarnation change had no handshake | New incarnation registers first; the loss boundary is recorded and alerted |
| One file per table, but segments span partitions | One file per table-partition |
| An hour "closed" by clock while rows sat in a tail | Close also requires every stream's watermark past the hour |
| Publisher queue ordering, loss, deletion against pinned snapshots | Queue is a nudge; apply in ledger-version order from the R2 log; delete after snapshot expiry |
| `trace_index` physical references die at compaction | Logical references to hour partitions |

These amendments are text. They have not been re-reviewed, and the protocol now has enough
moving parts (streams, incarnations, epochs, outbox) that the Quint model in
`VERIFICATION.md` is the next real check, not another reading.
