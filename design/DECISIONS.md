# viz — decision log

Each entry: the decision, the alternatives, why, and what would change it. Evidence lives in
`research/NN`.

## D1. A per-tenant ledger is the authority; the tail is joined to it by a fenced watermark

**Decision.** One Durable Object per tenant lists the live files of all that tenant's tables
and a watermark per shard. Rows not yet in a listed file are in exactly one shard. A query
reads one ledger version and asks shards for rows above the watermark; a shard that has
discarded past that watermark refuses and the query retries.

**Alternatives.** (a) Draft 2: visibility state inside Iceberg snapshots, one committer per
table. (b) Commit to Iceberg every few seconds and have no tail. (c) Cloudflare's managed
streaming ingest.

**Why.** Review showed (a) stalls ingest during a catalog outage, grows metadata with
tenants × days, cannot commit across tables atomically, and guarded truncation with a timer
rather than a fence (`REVIEW.md`). (b) collides with a 60-second practical commit floor and
per-operation billing. (c) has a 20-stream cap, no sort control and silent drops. The ledger
is one tenant's worth of state in one transactional store, which is the smallest thing that
can be proven correct.

**Would change if.** A single tenant's ledger cannot keep up (then: one ledger per shard
group).

## D2. Iceberg is a publication, not the write path

**Decision.** A per-cell publisher turns ledger changes into Iceberg snapshots every few
minutes. viz's own queries never read Iceberg metadata.

**Why.** External interoperability is the reason to have Iceberg; it does not need
second-level freshness. Decoupling means a slow, costly or broken catalog cannot lose data,
delay queries or stall ingest, and the publication can be checked against the ledgers.

**Accepted by the project owner on 2026-11-18** as a worthwhile compromise.

**Cost.** Two metadata forms exist. The ledger is authoritative; the scrubber proves the
Iceberg view equals it.

## D3. Tenant-pure files in shared tables; dedicated cells for direct access

**Decision.** Every data file holds one tenant. Small tenants share a cell's tables; a
tenant that needs direct Iceberg access, residency or scale gets a dedicated cell.

**Alternatives.** Table or namespace per tenant (research 04); shared files sorted by tenant
(research 05).

**Why.** Catalog operations are billed, so per-tenant tables cost dollars per tenant per
month in commits alone. Tenant-pure files make retention and erasure file drops and make
isolation checkable per file. Shared tables cannot be handed to a tenant's own engine
without exposing other tenants, hence dedicated cells for that.

## D3a. viz is the only writer; managed compaction off

**Why.** The one documented corruption incident on the managed stack involved two writers
disagreeing (research 11), and managed compaction is not documented to preserve sort order
or indexes.

## D4. Catalog behind an interface, with an R2-native implementation

**Decision.** Publish Iceberg metadata directly to R2 with conditional writes first; add
commits to the managed Iceberg REST catalog as a second implementation of the same interface.

**Why.** Interoperability with DuckDB, Spark, Trino and Snowflake is a product feature. The
managed catalog has no published limits, does not support jurisdiction buckets, and has an
open corruption report (research 01, 11). The ledger in the committer makes either
implementation rebuildable.

## D5. Rust core, TypeScript shell

**Decision.** Parsing, planning, Parquet encode/decode and evaluation live in a Rust crate
with no I/O. TypeScript owns bindings, HTTP, Iceberg metadata plumbing and orchestration.

**Alternatives.** Pure JS/TS with `hyparquet` and `icebird` (research 05); DataFusion or
DuckDB in WASM.

**Why.** No reusable PromQL evaluator exists in TS; the Rust `promql-parser` crate does
(research 06). A sans-I/O core is what makes deterministic simulation possible on a platform
with no first-party simulator (research 12), and the same code can run in a Container for
plans that exceed isolate limits. DataFusion and DuckDB are too large for a 128 MB isolate
with a 1 s startup limit.

**Evidence (2026-11-18, `bench/README.md`).** The same encode and rate-and-sum query
implemented both ways, each tuned, reading each other's files with identical results: Rust
compiled to WASM was 4–9× faster (encode 240 ms vs 1,030 ms; full-scan query 32 ms vs
291 ms), used 18–20 MB of WASM memory per query, and instantiated in under 10 ms. It stayed
about 4× ahead on a file encoded to favour JS. Measured in a sandbox, not on Cloudflare.

**Still open.** Behaviour under the enforced 128 MB limit, billed CPU, a zstd build for
WASM, and the size of a full engine rather than one query.

**Would change if.** Those checks fail; the pure-JS Parquet stack is plan B for I/O, with
evaluation still needing to be written.

## D6. Flat rows for samples and spans

**Decision.** One row per sample; one row per span; a separate per-day series table and a
trace index.

**Alternatives.** Chunk blobs per series-window (Cortex, Thanos, Mimir trials); nested
row-per-trace (Tempo).

**Why.** Flat rows are readable by any Iceberg engine, need no write-time assembly, and keep
row groups small. The estimated storage premium is a few dollars per million series per
month (research 03). Sorting spans by service and time measured far better for search, and
a trace index plus bloom filters covers lookups (research 04).

**Would change if.** Spike S6 shows flat samples above ~3 bytes each or too slow to decode.

## D7. Rules in packed ruler objects, classified by what they read

**Decision.** Many rules per ruler object, one tick, shared scans, state written on
transitions only. Each rule is classified at save time as tail, recent or rollup, and its
cost is shown.

**Why.** Scheduling shape dominates cost: an object per rule is about $60 per 1,000 rules
per month and a Workflow per rule about $690 (research 08). The often-quoted $0.35–0.50
applies only to rules answered from shard tails; review showed rules that read objects cost
dollars per thousand, so the design says which is which.

## D8. Agents are advisory, read-only and guard-triggered

**Decision.** Agentic monitors never page, never write to tenant systems, and run only when
a deterministic guard fires or a person asks.

**Why.** Published root-cause accuracy is 25–60% with material hallucination rates, and
log-borne prompt injection is demonstrated (research 08, 12).

## D9. Own dashboard spec, patch-based, digest-first

**Decision.** `viz.dashboard/v1`: small closed schema, stable panel ids, JSON Patch edits
with dry-run against real data, text digests as the agent-readable and accessible form.

**Alternative.** Adopt Perses verbatim.

**Why.** Perses is pre-1.0 with its spec being reorganised (research 09). The shape is kept
close enough that import and export are mechanical.

## D10. Per-signal tables

**Decision.** Separate tables for metrics, spans and logs, sharing resource attributes.

**Why.** Every production system examined stores signals separately, including those that
market a unified model (research 11). Profiles are deferred until the OpenTelemetry signal
is stable.

## D11. Route by sender, not by series

**Decision.** The shard key is the resource fingerprint (target labels or OTLP resource).

**Why.** Hashing by series sends one request to every shard and makes every query tail-read
every shard (review, platform C1). A sender-stable key keeps one request in one shard while
still giving each series exactly one home.

## D12. Encode outside the shard

**Decision.** Shards seal small segments; a stateless Worker sorts and encodes them.

**Why.** Sorting and encoding tens of MB inside a single-threaded 128 MB object blocks
acknowledgements and risks out-of-memory loops (review, platform C2, correctness 15).

## D13. Shared shard pools for small tenants

**Decision.** In hosted deployments small tenants share shard objects, with separate WAL
streams, tenant-pure files and per-tenant quotas.

**Why.** A dedicated always-warm shard per small tenant costs about $4 per month in duration
alone. Pools trade some isolation for a marginal cost near zero.

**Open.** Noisy-neighbour behaviour inside a pooled shard.
