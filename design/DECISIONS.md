# viz — decision log

Each entry: the decision, the alternatives, why, and what would change it. Evidence lives in
`research/NN`.

## D1. Two places for data, joined by a watermark

**Decision.** An acknowledged row is either in one shard's write-ahead log (the tail) or in
the current Iceberg snapshot (the lake). Each snapshot records a watermark per shard; a query
reads one snapshot and asks shards only for rows above it.

**Alternatives.** (a) A third tier of flushed-but-uncommitted files tracked in a separate
manifest that queries union in (research 05). (b) Commit to Iceberg every few seconds and
have no tail. (c) Cloudflare's managed streaming ingest.

**Why.** (a) adds a second manifest format and a second visibility rule. (b) collides with a
60-second practical commit floor and per-operation catalog billing. (c) has a 20-stream cap,
no sort or partition control, silent drops and minutes of latency (research 01, 07). The
watermark gives one rule for visibility and makes the hand-off testable as a single invariant.

**Would change if.** Tail reads starve ingest on busy shards (spike S8).

## D2. Shared tables, tenant-pure files, tenant in the partition spec

**Decision.** One table per signal per cell, partitioned `identity(tenant_id), day(ts)`; every
data file holds one tenant.

**Alternatives.** Table or namespace per tenant (research 04); shared files sorted by tenant
(research 05).

**Why.** Catalog operations are billed, so per-tenant tables cost roughly $1–3 per tenant per
month in commits alone (research 01, 05, 07, 10). Tenant-pure files make retention and
erasure metadata-only, make isolation checkable per file, and let a large tenant move to its
own cell by moving files. The cost is more, smaller files for small tenants, which compaction
absorbs.

**Would change if.** File counts for many small tenants make commits or manifests too large;
then small tenants share files within a `bucket(N, tenant_id)` partition and erasure becomes
a rewrite.

## D3. One committer per table; managed compaction off

**Decision.** A single Durable Object serialises every mutation of a table: appends,
compaction replaces, retention deletes. Cloudflare's managed compaction is disabled.

**Why.** The one documented corruption incident on the managed stack involved two mutators
disagreeing (research 11). Managed compaction is not documented to preserve sort order,
bloom filters or sidecars, all of which the read path depends on (research 03, 04, 05).

**Would change if.** Sort-aware managed compaction ships and passes the content-preservation
invariant.

## D4. Catalog behind an interface, with an R2-native implementation

**Decision.** Use the managed Iceberg REST catalog by default for interoperability; keep a
second implementation that stores Iceberg metadata on R2 with conditional writes.

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

**Would change if.** Spike S2 shows the core cannot fit; the pure-JS Parquet stack is plan B
for I/O, with evaluation still needing to be written.

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

## D7. Rules evaluated in packed ruler objects against the tail

**Decision.** About 1,000 rules per ruler object, one alarm tick, state written on
transitions only.

**Why.** Scheduling shape dominates cost: roughly $0.35–0.50 per 1,000 rules per month this
way, about $60 with an object per rule, about $690 with a Workflow per rule (research 08).

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
