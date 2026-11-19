# viz — platform review of DESIGN.md (draft 2)

Reviewer stance: principal engineer, has run Workers/Durable Objects and Mimir/Tempo/ClickHouse
in production. Scope: where the design is wrong, hand-wavy, self-contradictory or contradicted
by `research/`. Nothing here was measured; every number is arithmetic on figures in
`research/01, 02, 03, 04, 06, 08, 10` and is shown so it can be checked.

Reference workload used throughout ("Team" in research/10 §2): one tenant, 1M series at 15 s
(5.76 B samples/day, 14.4 GB/day at 2.5 B/sample, about 112 files of 128 MB and 450–900 row
groups per day), 100 GB/day logs (12.5 GB/day stored), 500M spans/day (about 42 GB/day stored,
about 325 files/day).

Summary of the verdict:

- The write-side invariant (tail / lake / watermark) is sound and worth keeping.
- The numbers attached to it are not. The design quotes costs from research/10 and research/08
  that were derived for a *different* architecture (rules evaluated inside the ingest buffer,
  5-minute flush, managed compaction, one DO request per ingest request, 1 s group commit) and
  then changes each of those choices.
- Three structural choices do not survive arithmetic at the stated scale: hashing every series
  across all of a tenant's shards, per-tenant-day manifests plus per-shard watermarks in a
  shared table's snapshot, and a 60 s / 5 MB/s segment that must be sorted and encoded inside a
  128 MB isolate.
- The read path meets its latency targets only for compacted, closed days with a warm cache in
  the same colo. The trailing 24 h on raw data, trace-by-ID, and log search do not.

---

## Critical

### C1. Series-hash routing turns one ingest request into N Durable Object requests, and every query into N tail reads

**Evidence.**
- DESIGN §4.1: "Rows are routed by hash: metrics by `series_id`, spans by `trace_id`".
  §6.3: "the planner asks each relevant shard for rows above the watermark".
- research/02 §1.1: "Simultaneous connections waiting for headers | 6 (shared with Workers
  called over service bindings)". research/02 §2.3: DO requests $0.15/M.
- research/10 §3.2 and §3.3 price DO requests at exactly one per ingest request
  (Team 35.3M → $5.14; Scale 1.02 B → $153).

**Problem.** A remote-write request carrying 10,000 samples from a few thousand series hashes
across *all* of the tenant's shards. Fan-out per request is min(series in batch, shard count).
- Team (8 shards per research/10): metrics 17.3M requests × 8 + spans 15M × 8 + logs 3M ≈ 261M
  DO requests → $39/month, not $5.14.
- Scale (1,000 shards): a 50,000-sample request touches hundreds of shards. DO requests go from
  $153 to the order of $15k–150k/month, and each edge invocation needs hundreds of RPCs through
  six header slots.
- The acknowledgement now depends on N independent group commits. The design has no statement
  of what the client is told when 7 of 8 shards commit and one returns 429.
- On the read side a label matcher says nothing about `series_id`, so every PromQL query is
  "relevant" to every shard of the tenant. A 1,000-shard tenant cannot run a dashboard query.
  This also keeps every shard awake (duration) and puts query load on the single-threaded
  ingest object.

**Recommended change.** Route on a coarse, sender-stable key (resource / target fingerprint),
so that one request normally lands in one shard and "a series lives in one shard" still holds.
Bound shards per tenant per region to single digits and scale large tenants by splitting into
sub-tenants or cells rather than by wider hashing. State the partial-success contract. Add
"DO requests per ingest request" and "shards touched per query" to the cost golden files.

### C2. A 60 s segment at the stated shard throughput cannot be sorted and encoded in a 128 MB isolate

**Evidence.**
- DESIGN §4.3: "A shard seals a segment when it reaches about 16–32 MB or 60 s. It sorts the
  segment by the table's sort order, encodes a tenant-pure Parquet file".
  §4.4: "about 5 MB/s per shard".
- research/02 §1.1: "Memory per isolate (JS heap + WASM) | 128 MB". §2.1: "Isolate memory
  (128 MB) may be shared by several objects of the same class." §9.2: "Treat 128 MB as about
  60-80 MB of usable working set"; "WASM linear memory counts against the limit and does not
  shrink".
- research/10 §3.3: "250 shards would cut duration ... at the price of 50 MB buffered per shard
  per minute against a 128 MB isolate". §5.2: Parquet encode 30–80 MB/s of uncompressed input.

**Problem.** The design never says whether 16–32 MB and 5 MB/s are compressed or uncompressed.
- If uncompressed: 5 MB/s reaches 32 MB in 6 s. That is 10 seals per minute per table per
  shard, not one. Team (8 shards at 2.2 MB/s each, about 3 active tables) gives roughly
  8 × 43,200 × 4–8 × 3 ≈ 4–8M PUTs/month ($19–37, against $0.17 modelled) and about 2,000–4,000
  flush files per table in the current hour.
- If compressed: 60 s at 5 MB/s is 300 MB uncompressed. A full sort needs the decoded segment,
  a permutation and the encoded output at once. That is several times the usable budget, before
  counting other shard objects packed into the same isolate.
- Either way, encode is CPU-bound in a single-threaded object. 300 MB at 30–80 MB/s is 4–10 s
  during which the shard acknowledges nothing, which breaks "p99 < 500 ms" once a minute.

**Recommended change.** Fix the unit and write the memory budget into the design. Have `edge`
emit batches already sorted by the table sort key; have the shard do a streaming k-way merge
of sorted runs with row-group-at-a-time output (memory proportional to one row group, not one
segment), chunked across events so acks interleave. Then derive shard throughput from the
128 MB ceiling instead of asserting 5 MB/s, and recompute shard count and duration cost. Spike
S2 must run with several shard objects in one isolate.

### C3. Per-tenant-day manifests and per-shard watermarks in the snapshot summary do not scale in a shared table

**Evidence.** DESIGN §4.3: "One commit appends every pending file across all tenants, writes
the new per-shard watermarks into the snapshot summary, and merges into per-day manifests ...
publishes the new table head: snapshot id, partition → manifest map, and watermarks."
§5.3: "Snapshot expiry runs at 1–3 days." §3: "Small tenants share a cell and its tables."

**Problem.**
- The manifest list has one entry per manifest. With per-tenant-day manifests that is
  tenants × retained days. 1,000 tenants × 395 days (13 months) = 395,000 entries, tens of MB of
  Avro rewritten every 60 s inside a 128 MB Durable Object. 10,000 hobby tenants is 4M entries.
- Each commit rewrites one manifest per active tenant. 1,000 active tenants × 43,200 commits
  × 5 tables × $4.50/M ≈ $970/month, about $1 per tenant-month, before data files.
- Snapshot summaries are retained for every unexpired snapshot. 1,000 shards × about 40 bytes
  × 1,440–4,320 snapshots is 58–173 MB of table metadata. Every external engine loading the
  table pays for it, and the managed catalog has "No published limits" (research/01 §2).
- The "table head" contains the partition → manifest map, so it is as large as the manifest
  list. It cannot be "cached for a few seconds" and read per query.
- DECISIONS D2 names this risk but gives no threshold. The design should not ship with it
  unquantified.

**Recommended change.** Keep watermarks in a side object named by snapshot id and referenced
from the summary by key and hash. Publish a per-tenant head, not a per-table one. Set a hard
cap on tenants per cell from the manifest-list arithmetic, or adopt the `bucket(N, tenant_id)`
fallback from D2 for small tenants now. Commit every 2–5 minutes (research/01 §15.4: "Plan for
1-5 minutes per table"); the tail already carries freshness.

### C4. The cost table quotes numbers derived for a different design

**Evidence and recomputation.**

*Hobby "≈ $5.20".* research/10 §3.1 assumes one buffer object, a 5-minute flush, rules
"evaluated in the buffer DO on its alarm", and Basin-managed compaction. It warns: "DO
duration is the tightest allotment ... A second always-on DO ... adds $4.15/month each and
nearly doubles the hobby bill."
- The design has one shard plus 5–7 committers woken every 60 s, a ruler ticking every
  interval, a tenant object and optionally scrapers.
- Whether an object woken every 60 s is billed continuously is research/10's own open P0
  benchmark #2 and research/08 §11's first open question.
- Lower bound (billed about 12 s per wake): shard 1.0 + committers 6 × 0.2 + ruler 0.2 ≈ 2.4
  object-months; minus the 1.2 included, × $4.15 ≈ +$5. Total about $10.
- Upper bound (billed continuously): 8 objects, +$28. Total about $33.
- Class A at a 60 s seal: 4 tables × 43,200 = 173k data PUTs, plus manifest, manifest list and
  footer bundle per commit, 3 × 4 × 43,200 = 518k. About 0.7M of the 1M included, for one tenant.
- So $5.20 does not follow from DESIGN.md. $10–33 does, pending the billing experiment.

*Marginal tenant.* research/10 sets the target "marginal idle tenant = $0, marginal active
hobby tenant < $0.50" and recommends "shared shards for small tenants". DESIGN §9 says
"Shards, rulers and the tenant object are per tenant" and files are tenant-pure.
- A second active hobby tenant in the same account costs one shard-month ($4.15) plus about
  0.5M Class A ($2.33): about $6.50/month.
- §11 presents "$4/month ... inside the included allowance for a single tenant" as reassurance.
  It is the per-tenant floor of a multi-tenant deployment, and it is above the plan fee.

*Team "≈ $250".* research/10 §3.2 sums to $243.37 (checked). Deltas the design introduces:

| Item | Modelled | With DESIGN.md as written | Why |
|---|---|---|---|
| DO requests | $5 | about $39 | C1 |
| SQLite rows written | $0 | $33–115 at a 250 ms window; $365+ at 50 ms | The $0 needs a "1-second group commit into a ring of reused slots". The design says "a short window", promises p50 ack < 80 ms, and deletes WAL segments (deletes bill as writes) |
| Rules (2,000) | $3.46 | $100–190 | M1 |
| Compaction | $16 (managed) | $36–72 | Managed is off. 45 TB uncompressed × 2 passes at 20–40 CPU-ms/MB |
| Query | $17 | $60–70 | 16 GETs and 50 CPU-ms per query is not a 24 h query on 1M series (M2). Plus 20M tail RPCs |
| Storage not counted | — | $25–40 | 5 m rollups for 13 months, `trace_index`, `trace_id` blooms, footer bundles, token sidecar |
| Control-plane duration | — | $10–40 | 6–8 committers, 2 rulers |
| Class A | $0.17 | $19–37 | C2, if segments are uncompressed-sized |

Realistic Team figure: about $550–800/month. Still 10–20× under any comparator in research/10
§4.2, so the business case survives. The printed number does not.

*"$0.35–0.50 per 1,000 rules".* research/08 §8.1 row A arithmetic is correct ($0.006 + $0.043
+ $0.043 + $0.18 + $0.07–0.14 + $0.026). It is the price of "batched hot-buffer evaluation"
inside the ingest shards, and it contains no evaluation CPU. research/10 prices the same work
at 2 CPU-ms per evaluation, which is $1.73 per 1,000 rules. The design's ruler goes through
the query path, so that CPU is billed, and so are the R2 reads in M1. research/08 row C ("5
object reads per evaluation ... $80 or more") is the row that matches DESIGN §7.1.

**Recommended change.** Rebuild §11 from the design as drawn, with a line per Durable Object
class, per table and per cache miss. Print ranges. State separately: (a) single-tenant
self-hosted floor, (b) marginal active tenant, (c) marginal dedicated cell (about 0.5M catalog
operations plus 6 committers ≈ $10–30/month). Run the DO-duration billing experiment before
anything else (S0 in §Sequencing).

### C5. Trace-by-ID is not a point lookup in this layout

**Evidence.**
- DESIGN §5.1: spans sorted `service_name, span_name, start_time`, partitioned by day;
  `trace_index` "makes trace-by-ID a point lookup". §10: "Trace by ID | p95 < 1 s".
- research/04 §6.3: `trace_index` returns `[min_start, max_end]`, after which "for each file:
  read the footer, then the `trace_id` bloom per row group".
- research/10 §6: "Yes if lookup is O(1–3 files) ... Partition or bucket by `hash(trace_id)`;
  sort by trace_id within files". The two research documents disagree and the design picked one
  without resolving it.

**Problem.** `trace_index` yields a time window, not file locations. With `day(ts)` partitions
the window prunes no files. One Team day is about 325 files and 1,300–2,600 row groups. A row
group of about 500k spans sorted by service holds up to 500k distinct trace ids; at 10 bits
per key that is about 0.6 MB of bloom per row group, 0.8–1.6 GB of bloom bytes and 325+ GETs
per lookup. The `start_time` page index only helps inside long `(service, span_name)` runs.
No spike in VERIFICATION §4 covers this.

**Recommended change.** Choose one:
- hour partitions for `spans` plus a per-partition trace-id → file / row-group map (binary-fuse
  filter or sorted fragment list) written with the footer bundle; or
- `bucket(N, trace_id)` in the partition spec, as research/10 proposes.

Make `trace_index` rows carry file references. Add a trace-by-ID spike at 500M spans/day.

---

## Major

### M1. "Rules rarely touch R2" contradicts the seam

**Evidence.** DESIGN §7.1: "Short windows are answered almost entirely from shard tails and
rollups, so evaluation rarely touches R2." §2: the tail is rows "not yet in a committed Iceberg
snapshot". §4.3: commit every 60 s, and after the watermark "a sealed segment is answered from
its R2 file rather than from SQLite". §5.3: rollups "are written during compaction".

**Problem.** The tail holds 60–120 s of data. `rate(x[5m])` needs five minutes. The other
three or four minutes are in uncommitted or just-committed flush files on R2, and rollups for
that period do not exist until hourly compaction. So nearly every rule reads R2. With 2,000
rules over about 300 distinct metrics, 5–10 flush files per shard and 8 shards:
300 × 40 GETs × 43,200 ticks ≈ 518M Class B ≈ $187/month, plus decode CPU. Tier-0 anomaly
detection ("seasonal baseline taken from rollups ... effectively free") has the same problem
in a different form: it reads days of rollups from R2 in the ruler tick.

**Recommended change.** Decide explicitly between two designs:
- a hot window of 10–15 minutes kept in the shard as compressed per-series state, with rules
  compiled into the shard as research/08 §3.3 describes. This is a second read engine in the
  shard and must be budgeted against C2's memory; or
- rules read the lake, with a per-ruler page cache and shared sub-expressions, priced honestly.

Whichever is chosen, classify each rule as streamable, rollup or cold at save time and show
the class and cost to the author (research/08 §3.3).

### M2. The trailing-24 h dashboard query misses its latency target on first load

**Query.** `sum by (pod) (rate(http_requests_total{namespace="x"}[5m]))`, 24 h, about 1,000
steps (step ≈ 86 s). Assume the metric has 50k series (720 MB/day) and the matcher selects
2,000 of them (11.5M samples, 29 MB).

**Walk-through.**

| Stage | Reads | Notes |
|---|---|---|
| Head, manifests, footer bundles | 1 + 4 + 4 | Two day-partitions × two tables. The bundle holds "page-index *locations*", so add one GET per file per column for the indexes themselves |
| Matcher resolution, yesterday | 3–5 | `metric_name` range, `namespace`, `pod`, `series_id` pages; 1–2 MB |
| Matcher resolution, today | tens | Today's `metric_series` rows are in flush and hourly files; the design does not say how they are read or deduplicated |
| Samples, compacted day | 25–45 row-group-sized reads | `series_id` is a hash, so the 4% of matching series are uniform across the metric. A 64–256 KB page holds 4.5–18 series-days; P(page has a match) = 1 − 0.96^4.5…18 = 17–52%. With coalescing the reader fetches most of the 720 MB to use 29 MB |
| Samples, today | 24–48 hourly ranges + about 180 flush files × 2 columns | 3 shards × 60 seals in the open hour, more under C2 |
| Tail | 3 RPCs | Each shard must resolve matchers itself (M4) |

- Total: 250–400 GETs, 0.4–1 GB transferred, 2–12 CPU-seconds of decode at research/10 §5.2
  rates (49–150M rows × 16 bytes at 200–500 MB/s).
- research/10 §5.4: "the number of GETs per query must stay in the tens"; at 64 files "the
  query p50 *is* the GET p99"; at 500 files p50 is 0.6–1.5 s and p95 2–5 s.
- DESIGN §10 promises p50 < 300 ms and p95 < 1.5 s. research/06 §7.8, the source of that
  budget, assumed 500 series, 6 h and 4 files.
- The sort key has no time component, so a 1 h query against a daily-compacted file still
  reads whole series-days (24× over-read). research/03 §7.7 lists "Time bucket in the sort
  key" as the fix; the design does not take it or reject it.

**30 days.** Step ≈ 43 min. The 1 h rollup is too coarse (research/03 §7.4: tier resolution at
most one fifth of the step), so the 5 m rollup is used: 432M rows for the metric, 17M matched.
With the same page over-read that is roughly 0.4–1.1 GB across 60–200 multi-MB GETs in 30
partitions, close to research/06 §7.6's "2 GB compressed on the Worker path" cap, after which
the design routes to a Container with a 1–3 s cold start. Matcher resolution is 30 partitions
× about 3 GETs. It is viable only if done per day inside the leaves; DESIGN §6.2 step 4 puts it
in the coordinator, sequentially before fan-out.

**Matcher resolution in general.** Per-day `metric_series` is the right shape for compacted
days and tolerates churn linearly (20M distinct series per day is about 1 GB/day, still one
metric-range read per day). It is weak in three places the design does not cover:
selectors with no metric name or a regex on it (full column scan per day); "today", before
daily compaction; and the tail.

**Recommended change.**
- Minor-compact the open hour every 5–10 minutes and state the invariant "at most K files
  per tenant-table-hour" (research/06 §6.3 asks for K ≤ 8).
- Put a locality-preserving prefix in `series_id` (hash of the promoted labels, then the full
  hash), as research/03 §6.3 and open question 11 suggest, so that a `namespace` matcher maps
  to contiguous pages.
- Put a time bucket in the sort key, or keep hourly files for N days.
- Push matcher resolution into the leaves.
- Build rollups at hourly compaction so the trailing 24 h has them.
- Restate §10 for three cases: refresh with warm partials; first load on compacted days;
  first load on today.

### M3. The six-connection rule may cap the whole query tree, and the design assumes it does not

**Evidence.** research/10 §5.3: "Service-binding callees share the caller's connection budget
according to the docs, so fanning out to stateless Workers via service bindings does **not**
obviously multiply R2 parallelism (must be measured)." research/06 §8.9: "Test the
six-connection limit behaviour before fixing the fan-out topology". DESIGN §6.3: "Fan-out
respects the six-connections-awaiting-headers rule with a two-level tree and early-header
streaming."

**Problem.** If callees share the budget, the entire tree has six R2 requests awaiting headers
at once: about 150–200 GETs/s at 30–40 ms TTFB. M2's 250–400 GETs then take 1.5–2.5 s whatever
the leaf count. The fallbacks (leaves behind DO stubs, or self-`fetch` through a route) add
duration billing or a request fee per leaf. This is listed as S4, fourth, with a remedy
("Deeper tree") that does not help if the limit is shared.

**Recommended change.** Run this spike first among the read-path spikes, measuring the four
topologies in research/10 §7 item 5. Do not fix the leaf design before the result.

### M4. Tail reads are unspecified where they are hardest

**Evidence.** DESIGN §4.4: "WAL rows are whole encoded batches". §6.3: "A shard answers with
rows from its open segment ... so the shard itself stays light." §10: "Time to queryable p99
< 10 s (served from the tail)".

**Problem.**
- A series first seen after the watermark is not in `metric_series` in the lake. The shard
  must evaluate label matchers itself, which needs a label index for its series. For a
  1M-series tenant on 3 shards that is about 333k label sets, tens of MB, in the same isolate
  as C2's segment.
- Without an index, each tail read decodes the open segment's batches. Twelve panels, several
  users, 30 s refresh, plus every rule tick, on the single thread that acknowledges writes.
- Quotas "enforced exactly in the shard" (§9) for active series are per-shard counts, not
  tenant-wide ones.

**Recommended change.** Specify the shard's in-memory head: structure, memory bound, what it
indexes, how it is rebuilt after eviction. Or drop the tail for metrics at launch and accept
the flush interval as freshness, as research/03 §7.5 suggests ("Start without the third; a
10–30 s freshness lag is acceptable"), by reading uncommitted flush files through the
committer ledger. Move spike S8 up.

### M5. The seam's safety depends on a cache age nothing bounds

**Evidence.** DESIGN §4.3: WAL segments are deleted "only after a grace period longer than the
maximum age of any cached table head". §6.2: the head "is published on each commit and cached
for a few seconds; it never requires a catalog call". The design does not say where it is
published. research/01 §8, KV: "writes visible elsewhere after ~60 s or more"; minimum
`cacheTtl` 30 s. §4.1: the shard map is in "KV, cached; stale-tolerant".

**Problem.**
- If the head is in KV, its age has no upper bound, and a head older than the grace period
  produces a silent gap: lake at snapshot S, tail already truncated past S's watermark. That
  is wrong data with no error.
- If the head is read from the committer per query, the committer is on the request path
  (contradicting §12 "Off the request path"), costs a DO request per table per query, and
  never sleeps.
- A stale shard map after a doubling sends a series to its old shard. The "each series in
  exactly one shard" invariant that `topk`, `count` and per-series functions rely on is then
  false for a window, with no detection.

**Recommended change.** Make both fail closed. A tail request carries the watermark it
assumes; the shard rejects it if that is below its truncation point, and the query re-plans.
An ingest RPC carries the shard-map epoch; the shard rejects a stale one. Name the head's
store and its staleness bound. Add both to the Quint model as stale-head and stale-map actions
with a liveness as well as a safety property.

### M6. Cache API claims ignore that it is per colo, evictable and cannot be purged

**Evidence.** research/01 §12: "per data center, not replicated, incompatible with Tiered
Cache, `cache.delete()` only purges locally ... eviction at any time. Needs a custom domain".
research/02 §1.1: "Cache API calls per request | 1,000 (shares subrequest quota)".
research/03 §7.1: "Stateless readers cache badly (Cortex's lesson)". DESIGN §6.4: a leaf
partial "is valid forever and is cached without invalidation"; §6.2: footer bundles
"(immutable, Cache API)"; §5.3: "Tenant erasure is the same operation".

**Problem.**
- The design never says where `query` and `leaf` run. At the user's edge, every colo is a cold
  cache and every R2 read crosses regions. Rulers run in the object's colo, so they share no
  cache with dashboards. Smart Placement "only affects `fetch` handlers, not RPC methods or
  named entrypoints" (research/10 §5.1).
- Today's footer bundle changes on every commit. It is either mutable under a fixed key (then
  not cacheable as immutable) or a new object each minute (then a miss each minute on the
  hottest partition, plus one more PUT per tenant per table per commit).
- Erasure and retention cannot purge cached partials or results in other colos. A label
  access-policy change does not invalidate a cached result unless the policy is in the key.
- The "step-aligned result cache for closed time ranges" is not keyed by snapshot, and the
  design has no out-of-order policy (m1), so late data makes "closed" ranges stale.

**Recommended change.** Pin `query` and `leaf` to the bucket's region with an explicit
placement hint and say so. Treat the Cache API as a best-effort L1 with hit rate as a measured
quantity. Add a durable L2 for the artefacts that matter (footer bundles and compacted-day
partials as R2 objects under a lifecycle rule). Key bundles by snapshot only for the open
partition. Put tenant, policy version and file set in every key; give result-cache entries a
TTL no longer than the erasure commitment.

### M7. Ingest acknowledgement target contradicts its own inputs

**Evidence.** DESIGN §10: "p50 < 80 ms, p99 < 500 ms for a 1 MB batch". research/10 §6: at 40
CPU-ms/MB "is too slow for p50 ... decode must be ≤ 20 ms/MB or validation must be deferred";
"group-commit wait ≤ 250 ms"; "output-gate flush ~12 ms". research/02 §1.1: "The isolate is
shared by concurrent requests, so the budget per request is less than 128 MB."

**Problem.** A 1 MB wire batch is 5–10 MB uncompressed: 200–400 CPU-ms of decode at the
planning figure, before the hop to the shard. A group-commit window short enough for an 80 ms
median writes hundreds of millions of billed rows a month (C4). Snappy remote-write bodies
cannot be stream-decoded; a 10 MB body is 100 MB or more decoded, and the design sets no body
cap (research/02 §9.1 says "cap body size (a few MB)").

**Recommended change.** State the batch size as uncompressed. Set a body cap per protocol and
a per-isolate concurrency guard. Pick the group-commit window and publish both consequences
(median ack and rows written). Use ring-slot overwrite rather than insert-then-delete.

### M8. TraceQL structural search and log search have no viable plan at the stated volume, and no targets

**Evidence.** DESIGN §6.5: structural operators "fetch the candidate traces by ID and evaluate
in memory per trace"; logs: "sort order and statistics first; the token sidecar is advisory".
§10 has no row for TraceQL search or log search. research/06 §8.13: "TraceQL needs
trace-grouped storage ... or structural operators become distributed joins". research/04 §5.4:
semi-join on `trace_id` first; child and sibling need "No extra I/O"; `>>` in metrics queries
"is unbounded, and should either be rejected above a threshold or served from nested-set
columns". research/10 §6: needle search over 24 h at Team is "12.5 GB of GETs and ~60–120
CPU-seconds".

**Problem.**
- The design's wording is worse than its own research: it fetches whole candidate traces for
  every structural operator, and each fetch is the C5 lookup. A query whose first phase
  matches millions of spans produces millions of candidate trace ids.
- The semi-join has no home. Matches for the two sides come from different files and leaves;
  the join is on `trace_id` at the coordinator. Ten million ids is 160 MB, over the isolate.
- Log needle search with no service filter: 400–800 row-group reads of 16–32 MB over 256
  leaves is 2–5 s for 24 h if M3 resolves well, and minutes for 7 or 30 days. The sidecar is
  "written at compaction", so it does not cover recent data, where people search.

**Recommended change.** Adopt research/04 §5.4 literally. Add a `trace_id`-hash shuffle stage
for the join. Reject or bound `>>` outside search. Write the token index at flush as a small
per-file bloom and say what it costs. Add targets and spikes for both. For log scans beyond a
byte budget, return partial results with a cursor.

### M9. Container fallback and the second catalog add cost and failure modes the design does not count

**Evidence.** DESIGN §6.3: Container plans are "slower to start, never different in result".
§5.4: two catalog implementations plus a scrubber plus a rebuildable ledger. research/02 §3:
cold start "often 1-3 s"; "no managed autoscaler"; "The DO and its container are not
guaranteed co-located"; egress $0.025/GB after 1 TB. research/02 §11.6: "whether
container-to-R2 traffic counts as billed egress" is open.

**Problem.**
- If container-to-R2 traffic is billed, compaction in Containers at Scale (about 320 TB/month
  read and written) is $8k–16k/month of egress, comparable to the whole modelled bill.
- "Never different in result" across WASM, native SIMD and the simulator is not true for
  floating-point sums merged in different orders. I14 and I17 as written ("equal") will fail
  or be weakened ad hoc.
- A Container pool is one more stateful component, fronted by one more DO class.
- Maintaining two catalog implementations doubles the surface of the highest-risk custom
  component (research/01 §15.2).

**Recommended change.** Make the R2-native catalog the only writer path, since it must exist
anyway for EU cells and as the fallback, costs no catalog operations and has no undocumented
limits. Publish to the managed catalog as an optional, asynchronous mirror for engines that
need a REST endpoint. Keep Containers out of the launch scope except for compaction, after the
egress question is answered. Define result equality with a stated tolerance and canonical
merge order.

### M10. Product scope: asked for, and thin or missing

| Brief item | Gap in DESIGN.md |
|---|---|
| Purely Cloudflare, easy to reason about | The design does not say whether viz is a hosted service, a deploy-to-your-account product, or both. Every cost and tenancy decision depends on it (C4) |
| PromQL and TraceQL baseline | No statement that the Prometheus HTTP API (`query_range`, `labels`, `series`, remote read) and the Tempo API are served, so that Grafana and existing tooling work. research/06 §1.8 covers it; the design says only "REST API" |
| Authenticated pull | `Scraper` has no target discovery (research/07 covers HTTP SD), no scrape-credential storage, no target limit (research/02: "about 50-100 targets per shard"), and no cost line (research/02: "each active scrape shard costs up to about $4/month ... pull ingest has a real idle cost") |
| Custom external adapters | No auth or secret model for adapters, no statement of how a query adapter composes with PromQL (what is pushed down, what happens to `rate` over a remote source), no limits. research/02 §5.5: "4 distinct dynamic Workers in flight per Worker request; 10 per Durable Object"; $0.002 per unique Worker per day beyond 1,000/month |
| Configurable retention | Per tenant and signal only. No tiered retention (raw / 5 m / 1 h), although §11's first cost lever is "rollups for long retention" and the Team figure assumes 13 months raw. No erasure deadline given snapshot expiry, 30-day DO point-in-time recovery and M6 |
| Monitors and alerting | Rules are Prometheus rules only. No log or trace monitors, no list of notification channels (research/02 §11.14: Email Service "not yet a dependable sole alert channel"), no Alertmanager API compatibility |
| Agentic monitors | No model choice or cost line in §11. "No egress" conflicts with calling a model provider that receives tenant telemetry; no consent or data-processing statement |
| Agent-first dashboards | Digest computation cost and caching are not described. Variables, folders, sharing and permissions are absent. research/10 §5.4(d) asks for one request per dashboard with shared file reads; the design issues one query per panel |
| Multi-tenancy | No global tenant directory, no organisation → tenant hierarchy, no cross-tenant query (research/07 covers federation) |
| Metrics completeness | No exemplars table (research/03 §7.2), no out-of-order window, no HA-replica dedup, no delta temporality decision, no span-metrics or service graph (research/04 §5.3) |

**Recommended change.** Add a section per row or cut the feature from the launch list. The
deployment-model question should be the first paragraph of §1.

### M11. Component count and "nothing else is stateful" are not true as written

**Evidence.** DESIGN §3: "Five Workers and five Durable Object classes. Nothing else is
stateful." The table lists four Workers plus Workflows. §8.4 uses "a hibernating WebSocket for
live tail" (needs a Durable Object). §7.3 uses "an Agents SDK object". Containers are each
fronted by a Durable Object (research/02 §3). The head and shard map live in KV or somewhere
unnamed. DESIGN.md cites `REVIEW.md`, which does not exist in `design/`.

**Problem.** The real inventory is 4 Workers, about 8 Durable Object classes, Workflows,
Containers, Dynamic Workers, KV, Cache API, AI Gateway and two catalogs. Each sleeping object
class is a duration line and a failure mode. "Easy to reason about" is a stated requirement.

**Recommended change.** Publish the true inventory with a wake cadence and a monthly duration
figure per class. Cut for launch: histogram and rollup tables as separate committers (commit
them with their parent table), LogQL subset, SQL passthrough, tier-2 anomaly models, MCP App,
tenant-supplied adapter code, managed-catalog writer. Merge `trace_index` and footer-bundle
writes into the spans commit.

---

## Minor

**m1. No out-of-order or late-data policy.** DESIGN §5.3 says rollups "cover exactly the data
that was compacted". A sample arriving for an already-compacted day invalidates that day's
rollup and any cached "closed" result. Take research/03 §7.4's window and dirty-partition
re-run.

**m2. The rollup "quantile sketch" column.** A sketch per series per 5-minute window
summarises at most 20 raw samples and is larger than they are. research/03 §7.2's rollup schema
has no sketch. Remove it; native histograms already merge.

**m3. Flush retries that "overwrite the same key with the same bytes".** This needs
byte-deterministic Parquet encoding (dictionary order, zstd, `created_by`). If bytes differ, a
leaf holding offsets from a cached bundle reads garbage. Use `If-None-Match: *` and treat
"exists" as success. R2 allows one write per second per key (research/01 §1).

**m4. WAL retained after the R2 file is durable.** During a catalog outage the WAL grows
toward the 10 GB per-object limit although the data is already on R2 and the ledger has it.
Truncate on "file durable and ledgered" and answer the tail by file reference only.

**m5. Idempotency horizon.** Batch fingerprints must outlive WAL truncation or a late client
retry duplicates rows (I3). State the retention.

**m6. Row and RPC size limits.** DO row/BLOB limit is "8 MB (docs today; 2 MB at my cutoff)"
(research/02 §2.2); RPC payload 32 MiB. A group-commit row or a decoded batch can exceed
either. Chunk explicitly and test against 2 MB.

**m7. Shard placement.** DESIGN §4.4 places shards "near the sender"; research/02 §9.1 says
"near the R2 bucket". Objects never move. A tenant sending from two continents gets one of
them at +100–250 ms per ack, and every tail read from a bucket-region query Worker crosses
regions. Pick one and state the consequence.

**m8. Workflow steps for many small tenants.** Hourly compaction per tenant per table:
1,000 tenants × 5 tables × 720 hours × about 5 steps = 18M steps ≈ $140/month. Batch small
tenants into one instance.

**m9. Self-observability.** research/10 §8.14: from 2026-12-01 Workers Logs are $0.25/GB
beyond 50 GB. C1's fan-out multiplies invocations. §11 has no line for it; set a sampling rate
in the design.

**m10. Snapshot expiry ownership.** §5.4 lists "expire" in the catalog interface and §2 says
"one mutator per table". Managed expiry also deletes data files (research/01 §2). Say whether
the committer issues expiry and who deletes files, so the orphan sweeper and the catalog never
both act.

**m11. Dynamic Worker billing for agent code execution.** Each distinct generated snippet is
a "unique Worker" at $0.002/day beyond 1,000/month. Use stable ids with code passed as data,
or budget it.

**m12. WASM instantiation on every cold object wake.** Many small tenants' shards wake often.
Give `Shard` a decoder-and-encoder-only build; keep the PromQL engine out of it unless M1/M4
decide otherwise.

**m13. `metric_series` duplication after eviction.** A shard that loses memory re-emits series
rows for the day. Say that readers deduplicate until daily compaction and what that costs on
"today".

---

## Sequencing: what to prove, in order

The current S1–S10 start with the catalog commit, which has a fallback, and leave out the
experiments that decide the topology and the cost floor. Proposed order:

| # | Spike | Decides | Kill criterion |
|---|---|---|---|
| S0 | DO duration billing: one object woken every 1, 5, 15, 60 s, with alarms and with outbound `fetch`; read billed GB-s after 24 h (research/10 §7 item 2) | The $5 floor; whether per-table committers, per-tenant shards and per-interval rulers are affordable | A 60 s wake bills more than about 25% duty → merge committers into one object per cell, share shards across small tenants |
| S1 | Connection semantics and R2 TTFB together: GET parallelism from one invocation, via service binding, via DO stub, via self-`fetch`; p50/p99 in and out of region (current S4 + S5) | Leaf topology, where `query` runs, whether M2's GET counts are survivable | Shared six-slot budget across the tree → leaves must be separate top-level requests; re-price |
| S2 | Shard flush in 128 MB: sorted-run merge and row-group streaming encode at 0.5, 2 and 5 MB/s uncompressed, with 4 shard objects in one isolate; ack latency during encode (current S2 + S3, with C2's question) | Shard throughput, shard count, duration cost, segment size, Class A count | Cannot hold p99 ack < 500 ms during flush above about 1 MB/s → 5× the shards; redo cost |
| S3 | Ingest fan-out and group commit: real remote-write and OTLP bodies through `edge` to N shards; DO requests per ingest request, rows written per month at 50 / 250 / 1,000 ms windows, median ack | C1 routing key, M7 targets | More than about 2 DO requests per ingest request → change routing key |
| S4 | Metadata at tenancy scale: 1,000 tenants × 400 days × 5 tables; manifest-list size, commit wall time and memory in a DO, head size, external engine load time (extends S9) | C3, cell size, commit interval | Commit over about 5 s or head over about 1 MB → per-tenant heads, bucketed tenants |
| S5 | One vertical read slice on synthetic Team data, before any PromQL breadth: the M2 query at 1 h, 24 h (today and yesterday) and 30 d, counting GETs, bytes, CPU and wall time; flat rows with hashed vs locality-prefixed `series_id`, with and without a time bucket (merges S6, S9, S10) | Row shape, sort key, compaction cadence, rollup placement, §10 | First-load 24 h p95 over 3 s after tuning → chunk-blob rows or a different sort |
| S6 | Trace-by-ID and one structural query at 500M spans/day; log needle at 100 GB/day over 1 h, 24 h, 7 d (not in the current list) | C5, M8, span partitioning, whether a flush-time token index is required | Trace-by-ID p95 over 1 s → `bucket(trace_id)` |
| S7 | Tail read under ingest and rule load (current S8), with matcher resolution in the shard | M1, M4, whether a tail exists for metrics at launch | Ingest p99 degrades over 2× → no metric tail; read uncommitted flush files |
| S8 | Catalog commit from a Worker (current S1), against the R2-native implementation first | M9 | — |

Decode cost per MB (current S7) falls out of S2 and S3 and does not need its own slot.
"Design accepted" in VERIFICATION §5 should require S0–S5, not S1–S5 as currently numbered.
