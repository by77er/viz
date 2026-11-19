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

**Evidence on Cloudflare (2026-11-18, `spikes/s2-engine-in-worker/`).** Billed CPU per
query, net of receiving the file: 8.7 ms against 158 ms for the selective query and 70 ms
against 698 ms for the full scan. Rust is 10–18× cheaper in production, more than in the
sandbox. Production CPU is about twice the sandbox's wall time for Rust.

**Still open.** A zstd build for WASM, and sustained memory behaviour: single requests
overshot 128 MB without failing, which is not something to design to.

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

## D13. Shards are pooled from the first line of code

**Decision (project owner, 2026-11-18, replacing an earlier choice the same day to defer
pooling).** The shard is built multi-tenant: each tenant's log inside a shard object is a
stream `(shard, tenant, incarnation)`. A dedicated tenant is a pool containing only itself,
so there is one code path.

**Why now.** Retrofitting tenancy into the write-ahead log later would touch every table,
key and invariant in the most correctness-sensitive component. Building it in costs one
extra key column.

**What it buys.** A small tenant's marginal cost is a share of a shard that is already
awake, instead of roughly $4 per month for one of its own. Tenants that need full isolation
are assigned a dedicated pool.

**Implemented** in `shard/` with tests for the properties pooling puts at risk: no
cross-tenant tail reads, per-tenant sequencing and dedup, backpressure that stops at the
tenant, per-stream discard. Shuffle-shard routing limits how many tenants share a whole
slot set.

**Open.** CPU fairness on the shared single thread, and behaviour under load.

## D14. Build order

**Decision (project owner, 2026-11-18).** Metrics, then traces and rules, then logs and
detection.

## D15. The publisher is never upstream of ingest

**Decision.** Shards discard on the ledger's acknowledgement, not on publication. The
publisher's backlog is the ledgers' R2 change logs; it applies net changes, so files added
and compacted away before publication are never published. A stalled publisher delays
external readers and physical deletes, nothing else. Publication lag has its own alert.
Managed-catalog publication is deferred until there is a concrete analytics or export need.

## D16. A design system is the ground truth for the interface

**Decision (project owner, 2026-11-18).** Design changes are reviewed against
`design-system/` by an expert reviewer before merging, and pull requests show before and
after images. Merging after an approving review does not need the owner, for now.

**The system.** Neutral greys with no hue; four full-strength action colours (blue, red,
green, yellow) that are the same in both themes and double as status marks beside a word;
one sans family (Schibsted Grotesk) for interface and reading text and a monospace for
data; small radii, hairlines and a single shadow. The first version used a serif; the owner
asked to try a sans with personality, and a side-by-side render of the same screen in the
serif and nine sans candidates settled it.

**Speed and feedback are requirements.** Input is acknowledged within a frame, local view
changes finish within 100 ms with no loading state, and feedback must be meaningful,
accurate and useful: progress is drawn only when measured. Budgets are in the rules and
the review rubric.

**Why these choices.** A hue-free interface means colour on screen is always data, state
or an action. One family gives one voice from 13 to 44 px. Every
text and control pairing is checked for contrast in both themes by
`design-system/tools/check.mjs`, and the chart palette by a colour-vision validator.

**Open.** No icon set; no React component package; the app does not use the system yet.

## D17. Query leaves are Durable Objects

**Decision.** The leaves that read R2 during a query are stateless Durable Objects taken
from a warm pool per cell, not Workers reached through service bindings.

**Evidence (measured on Cloudflare, 2026-11-18, `spikes/s1-fanout-r2/`).** R2 reads are
limited to six at a time per request, and a service-bound callee spends from its caller's
budget: 96 reads took 727–958 ms however they were divided. Across Durable Object leaves
the same 96 reads took 312 ms, and 192 reads took 173 ms. Waiting on 96 callees at once is
not limited in either case. One range read costs about 45 ms regardless of size below 1 MB.

**Cost.** A leaf object bills requests and duration like any Durable Object, and first use
of an object adds a few hundred milliseconds, so the pool must stay warm under load and
empty when idle.

**Would change if.** A different Worker script reached by service binding turns out to have
its own budget (not tested), or contention on shared warm leaves is worse than the cold
start it avoids.

## D18. Seals reach flush through a Queue, with a marker-driven sweep under it

(Restored 2026-11-18: D18–D21 were lost when this file was rewritten from an older copy the
same day. A second entry numbered D18, on self-monitoring, follows D22.)

**Decision.** A shard that seals a segment writes a `{tenant, shard}` message to an outbox
table in the same transaction and hands it to a Cloudflare Queue; the flush Worker is the
queue's consumer. The hourly sweep is the safety net, and it finds work by listing KV
markers that shards maintain, never by asking shards. Finding shards from the KV pool maps,
as first asked, would wake every shard every hour; that is the operator's `full` sweep,
with its limitation in `flush/README.md`.

**Alternatives.** (a) The shard calls the flush entrypoint directly (`ctx.waitUntil` plus a
sweep). (b) A sweep only. (c) The shard's own alarm re-notifies while segments are pending.

**Why.** (a) ties a flush run, which can take seconds and several R2 writes, to the
lifetime and the connection budget of the object that must stay free to acknowledge
writes, and gives no retry: every failure would wait for the sweep. The Queue supplies
at-least-once delivery, backoff, batching and a dead-letter queue. What it adds is a send
that can fail (covered by the outbox: the alarm retries it), duplicates (flush is
idempotent) and dead letters (written to R2 and logged; the sweep re-enqueues the stream).
(b) alone delays every flush by up to the sweep period. (c) would also work and needs no
KV, but a cron that asks every shard would wake idle objects, and the owner asked for a
sweep that is cheap when idle; the marker gives that.

**Easy to revisit.** The transport is one method, `Shard.announce`. Replacing the Queue
with a direct call changes that method and the consumer's entry point; the outbox, the
marker and the sweep stay.

**Would change if.** Queue delivery latency on Cloudflare makes freshly sealed data wait
noticeably (unmeasured; the tail keeps it queryable meanwhile), or the per-message cost
matters at high seal rates.

## D19. `series_id` stays a plain hash; locality is not bought with id bits

**Decision.** `contracts/BATCH.md` is unchanged: `series_id` is FNV-1a 64 of all labels.
`DESIGN.md` §5.1 no longer says the id begins with a hash of promoted labels.

**Evidence (measured here, `engine/storage/examples/locality.rs`, re-run 2026-11-18;
200,000 series, 50 metrics, skewed namespace/job/pod/route/status labels; both encodings
return identical results for every query).** Id (b): top 12 bits from a hash of
`namespace`, next 12 from a hash of `job`, low 40 from the full hash. One samples file of
all series, at three file shapes: 30, 60 and 120 samples per series (60, 120 and 240 row
groups of 100,000 rows; at 60 the file is 16–17 MB, the size of an as-built compaction
output for such a tenant). Bytes are the compressed row groups that row-group statistics
cannot exclude, which is how the engine prunes; "pages" is what a reader with page-level
statistics would fetch, which the engine does not have. Select is whole files in memory,
median of 5.

| Query | 30 / sample | 60 / sample | 120 / sample |
|---|---|---|---|
| `{namespace="ns-15"}` (2% of series), row-group bytes, (a) → (b) | 12.1 → 9.4 MB (1.3×) | 17.2 → 10.5 MB (1.6×) | 27.6 → 10.8 MB (2.6×) |
| same, page bytes | 12.1 → 2.1 MB (5.8×) | 17.2 → 1.6 MB (10.7×) | 26.7 → 1.6 MB (16.5×) |
| same, select | 344 → 280 ms | 462 → 328 ms | 654 → 312 ms |
| `{job="job-040"}`, row-group bytes | 12.1 → 9.2 MB (1.3×) | 17.2 → 10.3 MB (1.7×) | 27.6 → 10.3 MB (2.7×) |
| `{__name__="metric_01_total"}` (full-metric scan), row groups | 7 = 7 | 13 = 13 | 26 = 26 |
| same, bytes / select | 1.39 → 1.27 MB, 113 → 127 ms | 1.84 → 1.66 MB, 123 → 149 ms | 2.97 → 2.77 MB, 147 → 159 ms |
| `namespace` on that one metric, row-group bytes | 1.39 → 0.54 MB (2.6×) | 1.84 → 0.38 MB (4.8×) | 2.97 → 0.32 MB (9.3×) |

The samples file is 6–10% smaller with (b) and the series file 30% smaller.

**Why not.** The bar set for changing the id was at least 3× fewer bytes for
`{namespace="x"}` without hurting the other queries. As the engine reads (row groups), it
is 1.3–2.6×, below the bar at every shape; it passes only with page-level pruning, which
does not exist, or for a namespace matcher combined with a metric name in larger files.
The full-metric scan reads the same row groups and its select was 8–21% slower (single
runs on a noisy machine). And the id itself gets worse: with 40 bits left to distinguish
series that share a namespace and job, the expected number of colliding pairs among n such
series is n²/2⁴¹: 0.005 at 100,000, 0.45 at 1,000,000 (the default active-series limit),
against 3·10⁻⁸ for 64 bits. Nothing downstream detects a collision: two series with one id
are merged silently in every file and every query. The same locality is available without
that by sorting on a promoted-label column ahead of `series_id` (`contracts/TABLES.md`
already plans promoted columns), which costs a schema change instead of collision
resistance.

(An earlier version of this entry quoted only the one-metric row, 9.3×, as "the namespace
query". The decision did not change; its first reason did.)

**Would change if.** The engine gains page-level pruning (a page index), so that the 6–17×
by pages becomes bytes actually not read, AND ids become wider than 64 bits or `edge` or the
shard gains a collision check that makes a narrower hash safe.

## D20. Tombstones live in the ledger

**Decision.** The keys removed by `replace` and `expire` are recorded by the ledger, in the
transaction that removes them, with the ledger version and time of the removal. The
janitor is stateless and deletes only what the ledger's `deletable` returns.

**Alternative.** A per-tenant janitor Durable Object that is told about removals, or reads
them from the ledger's R2 log.

**Why.** "Removed", "logged" and "live" are all facts the ledger already holds, and it can
answer them in one synchronous read; a second object would learn of a removal in a
separate step that can be lost or reordered, and would have to ask the ledger whether the
removal is logged anyway. Keyed by version, the rule survives the planned change of the
log to segments (`contracts/LEDGER-LOG.md`) and gives the publisher's gate a place to go.

**Cost.** One more row write per removed key in the ledger, and a table that grows until
the janitor runs.

## D21. The active-series limit refuses new series by id; the shard meters, `edge` filters

**Decision.** `edge` sends each batch's series ids with it. The shard keeps, per stream, a
two-bucket sliding window of ids: an exact set while small, above that a HyperLogLog for
the count and a Bloom filter for membership. A batch that would take the stream over its
share of the tenant's limit is refused whole with the ids that are new and do not fit;
`edge` leaves those series out, sends the rest again, and tells the sender: **400** for
Remote Write, naming the limit and how many new series and samples were refused (the
samples of existing series are written), and `partial_success` for OTLP. (This replaces
"429 for Remote Write", reversed after review R-4: a sender that retries 429 resends the
same new series for ever and falls behind on the series the tenant already has; Remote
Write senders do not retry 4xx other than 429.)

**Alternatives.** (a) `edge` splits a batch into one per series. (b) A HyperLogLog alone.
(c) Refuse the whole request at the limit.

**Why.** (a) multiplies appends and row writes by the series count. (b) cannot say whether
an id has been seen: only about m/n of new ids move a register (0.4% at a million), so a
tenant at its limit could keep adding series. (c) stops the series a tenant already has,
which punishes it for someone's cardinality mistake. Returning the refused ids keeps the
shard ignorant of the batch format and costs one extra round trip only when a limit is hit.

**Share.** The tenant's limit is divided evenly over the slots it may use; a tenant whose
senders are unevenly spread hits one shard's share early.

**Would change if.** Limits need to be exact across shards (then the count moves to a
per-tenant object), or the Bloom filter's 1 MB ceiling (about 800,000 ids per bucket at 1%)
is reached by real tenants.

## D22. Which file wins a rewritten sample: a precedence the ledger assigns

**Decision.** Every live file has a precedence range the ledger assigns
(`contracts/ledger.ts`, `LiveFile`): a flush file ranks by the version of the `add_unit` that
admitted it; a compaction output covers `[min, max]` of its inputs of the same table and
day, and the ledger admits it only if no other live file of that table and day that
overlaps it in time ranks inside that range (else `conflict` with `blocking`). `plan` lists
files in ascending precedence; readers and compaction hand files to the engine in that
order, and the later file wins. This replaces "the one later in key order wins", which the
query Worker's engineer found wrong: keys sort as text, so a stream's tenth batch sorted
before its second, an older write could beat a newer one, and compaction baked that in.

**Alternatives.** (a) Sort keys numerically (zero-pad the sequence numbers): fixes one
stream's flush files, says nothing across streams or for compaction outputs, whose keys
carry no order. (b) Precedence per row: a version column in every samples file, kept by
merges, the reader taking the highest. Exact whatever is merged with what, but a schema
change for every reader, including the other engineers' query engine, and 8 bytes a row.
(c) Precedence = the newest input's, with no rule on what may be merged: wrong as soon as
a merge skips a file in between (a budget, an hour bucket), because the output would then
outrank that newer file with rows older than it.

**Why.** Files that can share a row (same table, day and overlapping time) end up with
disjoint ranges, so one number orders them, the read path stays "sort by a field" and the
file format does not change. The rule is checked in the one place that sees every live
file, in the same transaction as the swap. Admission order is the write order within a
stream (units are contiguous) and across streams once the shard-map handover is built
(DESIGN §4.1).

**Cost.** An hourly merge may not jump over a file of a neighbouring hour that overlaps it
in time and was admitted in between (a segment straddling the hour); such files wait until
their day closes, where merges are runs in precedence order and never jump. Tested: random
rewrites across flushes and compactions always read back as the latest write
(`stack/test/precedence.property.test.ts`).

**Would change if.** Merges get blocked often enough on real data that hours stay
unmerged (then: hour buckets by admission, or per-row precedence), or two streams can
write the same series concurrently (then admission order is not write order).

## D23. Monitoring viz with viz: one deployment, for performance (proposed)

**Status.** Proposed 2026-11-18 as a future goal and revised the same day on the owner's
direction; not built. Details in `design/SELF-MONITORING.md`.

**Proposal.** viz's own telemetry goes to a `viz-internal` tenant in the same deployment:
component metrics aggregated in memory and sent every 15 s, fire-and-forget; Cloudflare's
analytics pulled every minute for billed CPU, duration and R2 operations; one freshness
prober. The aim is understanding scaling and nominal performance, with cost per unit of
work measured rather than modelled.

**Owner's direction.** Keep it simple and avoid a second deployment. The first version
proposed a separate meta cell, an outside watcher and an off-platform heartbeat to survive
viz's own outages; those are deferred until viz carries traffic someone depends on.

**Accepted cost.** Shared fate: when viz is down, its view of itself is down too.
Cloudflare's own dashboard remains available for diagnosis.

## D24. Versioned Durable Object storage: one runner in `contracts/`, a `compat` floor, refusal

**Decision.** Every Durable Object class records `{component, version, compat}` in a table
`viz_schema` and opens its storage with `openSchema` (`contracts/schema.ts`) in its
constructor, inside `blockConcurrencyWhile`: the missing migrations and the new version row
commit in one `transactionSync`. Each migration declares `readableFrom`, the lowest schema
version a release must know to open storage it has touched; `compat` is the largest of those
applied. Code that finds `version` above what it knows opens the storage as it is when
`compat` allows, and otherwise refuses on every entry point (`schema_too_new`, 503, alarm
re-armed) and writes nothing. Formats outside SQLite carry a version by the rules of
`contracts/COMPATIBILITY.md`; readers refuse what they do not know. The runner is one shared
module in `contracts/`, imported by each component, not a copy per component. Implemented in
`control/`, `ruler/` and `publisher/`; `design/UPGRADES.md` lists what the others must do.

**Alternatives.** (a) `PRAGMA user_version`: smaller, but Durable Object SQLite does not
authorise it (measured: `SQLITE_AUTH` in workerd), and it holds one number, not the owner or a
compatibility floor. (b) A copy of the runner in each component, keeping "components depend
only on `contracts/`" trivially true. (c) No floor: every migration makes its release
forward-only. (d) A hash of the schema instead of a number, compared on open. (e) Versions per
row, migrated lazily when read.

**Why.** `contracts/` already carries small pure code that every component imports (`TENANT_ID`,
`ledgerLogKey`), and the runner is a contract in the same sense: the refusal behaviour and
the meaning of `compat` must be identical everywhere, so that a release tool can decide
rollback safety from `schemaRelease` alone; copies would drift. The runner has no I/O and no
platform types. The floor (c) matters because a rollback is the normal response to a bad
deploy (Cloudflare documents that a rollback re-assigns Durable Objects to old code on the
new storage): most changes are additive (a table, a nullable column) and should leave the
previous release a valid rollback target; only breaking ones make a release forward-only. A
schema hash (d) detects a difference but cannot say whether the older code may proceed.
Per-row versions (e) spread the decision over every read path and still need a floor.

**Cost.** One table and one row per object; a constructor that reads `sqlite_master` once;
every entry point checks a field. A refusal is an outage for the refused objects until the
newer release serves them again: safe, not available. The first versioned release cannot
protect itself from a rollback to code from before it, so it must be the rollback floor before
any migration 2 ships.

**Would change if.** Cloudflare authorises a richer storage metadata API (or `user_version`)
with the same transactional guarantee; or deploys become strictly forward-only (no
rollbacks), when `readableFrom` would always equal `version`; or a component needs a
migration too large for the constructor's 30 s, when backfills move to alarm-driven batches
under the same version row.

## D25. The MCP server uses the SDK v2 handler directly, not the `agents` wrapper

**Decision.** `mcp/` serves MCP with `createMcpHandler` from `@modelcontextprotocol/server`
2.4.0 (the TypeScript SDK's v2 line, implementing the 2026-07-28 revision), on a plain
Worker. The Worker does its own routing, Origin check and authentication in front of it.

**Alternatives.** (a) `createMcpHandler` from `agents` 0.33.0 (`agents/mcp/server`), which
wraps the same SDK v2 handler and adds route matching, CORS, Origin/Host checks and an
`AsyncLocalStorage` auth context. (b) `McpAgent` from `agents`, a Durable Object per session.
(c) `@modelcontextprotocol/sdk` 1.x, the sessionful v1 line.

**Why.** All three run in workerd (checked: `mcp/` `npm run spike:libs`). The wrapper (a)
adds what this Worker already does itself, plus a dependency tree (`yaml`, `nanoid`,
`capnweb`, `partysocket`, OpenTelemetry, …) and `nodejs_compat`. `McpAgent` (b) is marked
deprecated and feature-frozen in its own types, and needs sessions this server does not
keep (D26). The v1 SDK (c) is built around sessions; its client is still used in tests as
the 2025-era client.

**Would change if.** viz adopts `@cloudflare/workers-oauth-provider` and its integration turns
out to need the wrapper (it wraps any `fetch` handler, so probably not), or the SDK v2 line
stops supporting Workers without `nodejs_compat`.

## D26. The MCP server is stateless: a server per request, no sessions

**Decision.** Every HTTP request to `/mcp` builds a fresh server; nothing is kept between
requests. Revision 2026-07-28 is served natively (per-request `_meta`, `server/discover`, no
`initialize`); 2025-11-25, 2025-06-18 and 2025-03-26 clients are served through the SDK's
stateless legacy path (`initialize` and `ping` answered, no session id). `GET` and `DELETE
/mcp` are 405. Paging state travels in cursors bound to the tool and its arguments, with the
time range and dashboard revision pinned.

**Alternatives.** (a) Sessions held in a Durable Object per session (`McpAgent`). (b)
Sessions in KV. (c) Sessionful only for the 2025 revisions.

**Why.** The spec became stateless at 2026-07-28 (research 09 §2.1, 08 §5.4), and nothing
the tools do needs server-side state: identity is checked against the control plane on
every request, and a cursor carries what a next page needs. A Durable Object per session would
put a stateful hop and a billable object on every agent call for no behaviour; KV cannot
give a session read-your-writes. Costs: no server-initiated messages (`subscriptions`,
progress, `logging/setLevel` are not offered), and every page re-runs its queries.

**Would change if.** viz needs server-to-client notifications (subscriptions to a monitor or
a dashboard), or measured re-query cost of paging dominates an agent's spend.

## D27. The JSON agent API mirrors the MCP tools, one dispatcher for both

**Decision.** `mcp/` also serves the same tools as plain JSON: `POST /api/v1/agent/tools/{name}`
with the tool's arguments as the body, plus resources and prompts under `/api/v1/agent/…`.
Both surfaces go through one dispatcher (scopes, argument schema, budget hook, counters), so
a call returns the same text and structure on either; tool errors carry their HTTP status.

**Alternatives.** (a) MCP only. (b) A REST design of its own (resources per noun, e.g.
`GET /dashboards/{id}/digest`), with MCP tools calling it. (c) Agents use the control plane
and the Prometheus API directly.

**Why.** Agent hosts without MCP, scripts, the agentic monitors' Workflows (DESIGN §7) and
tests need the same operations; one dispatcher means one place for scopes, cleaning of
untrusted text and budgets, and a test asserts the two surfaces answer identically. A REST
design of its own (b) would be a second contract to keep equal to the first. The underlying
APIs (c) return raw data with tenant text unfenced and no token budget, which is what the
tools exist to avoid.

**Would change if.** The in-app assistant or the UI needs operations that are not tools (then
they belong in the control plane or query APIs), or a tool's arguments stop being
expressible as one JSON object.

## D28. Per-identity agent budgets are returned counters, not server-side counters

**Decision.** Every agent tool result carries `usage` (queries, series, points, upstream calls,
milliseconds); the caller (an agent host, AI Gateway, or an agentic monitor's Workflow with
per-run and per-day budgets, research 08 §6.4) sums them and stops. Each single call is
bounded by the server's limits, and the query service enforces the tenant's own. A
`BudgetHook { admit, record }` in `mcp/src/session.ts` is the seam for a server-side cap.

**Alternatives.** (a) Counters in KV per identity. (b) Counters in a Durable Object per
identity or tenant.

**Why.** KV has no atomic increment, allows about one write per second per key and propagates
in tens of seconds, so a per-call counter under-counts concurrent calls by design while
costing a write per call: it would look like enforcement without being it. A Durable Object
(b) is exact but puts a stateful hop on every call of a surface that is otherwise stateless
(D26).

**Would change if.** Agents that do not budget themselves become common enough that a tenant
needs a hard server-side cap; then (b), behind the existing hook.

## D29. Agents propose and a person applies, including new dashboards

**Decision.** An agent identity's dashboard writes are proposals: named changes to an existing
dashboard, or a whole new dashboard (`POST /api/v1/control/proposals`), reviewed and applied by
a person in the control plane. `write_dashboard` mode `apply` is refused for an agent (403
with an offer to propose) rather than silently turned into a proposal; whether a caller may
apply comes from the control plane's `whoami` (`mayApply`). The agent surface has no apply,
approve, revert or delete tool, and it does not honour `admin`: agent keys get explicit
scopes. A tenant can let agents apply (`agentsMayApply`); applying a proposal that creates a
dashboard then follows the same rule as a direct create.

**Alternatives.** (a) The control plane turns an agent's apply into a proposal and says so
(its behaviour for `PATCH`), with the agent surface passing that through. (b) New dashboards
are not proposable: an agent can only describe one in text. (c) A creation proposal stored
apart from proposals (its own table), or as a JSON Patch replacing the document root.
(d) `admin` honoured on the agent surface as it is in the control plane.

**Why.** D8: agents are advisory; a person decides what changes. A silent proposal (a) leaves
an agent believing it applied something. Without creation proposals (b) the commonest agent
task, "build a dashboard for X", ends in text a person must paste. A creation is a row of
the same proposals table with an additive nullable `spec` column (control schema version 2),
so review, expiry, decline, listing and caps are shared, and the previous release stays a
valid rollback target; a separate table (c) duplicates all of that, and a root-replacing
patch hides a creation in the shape of a change, which every path that handles changes
(rebase check, partial apply, edit) would then have to recognise anyway.
`admin` is total in the control plane (keys, settings, `agentsMayApply`), so honouring it
here (d) would let an agent key escape every agent rule.

**Would change if.** People routinely approve agent changes without reading them (then the
review is theatre and the rule should be revisited with data), or `user` identities with
roles arrive and replace keys for people.

## D30. An unreferenced compaction output is deleted only once an input of it is gone for good

**Decision.** A compaction step never deletes its outputs, not even when `replace` answers
`conflict`. Every output carries the list of its inputs as R2 custom metadata (`viz-inputs`,
`{"v":1,"inputs":[…]}`, checked against the `inputs16` in its key). The orphan sweep
(`janitor/`) deletes an output that the ledger neither lists nor tombstones only when one of
its inputs is **gone for good**: not live in the same ledger read, and its object absent from
the sweep's listing. Objects are deleted only after a logged removal (purge) or once they can
never be listed (this sweep, by the same rules), so such an input never becomes live again,
and `replace` admits an output only with every input live. Compaction output keys are
unchanged. Replaces the earlier rule, which deleted an unreferenced output by its R2 upload
age (≥ max(24 h, 2 × the step deadline)) and let a conflicted step delete its outputs when the
ledger did not know them. Alongside it, for flush files (spec F15): a newer incarnation of a
stream makes an older incarnation's file dead only once that newer incarnation has a logged
unit, which proves its registration is logged.

**Why it was needed.** Output keys are a function of the inputs, so a retry ADOPTS the objects
an earlier attempt left (`exists`). The adopted object keeps its old upload time, so the
sweep could judge it by an age that says nothing about the step now holding it, and delete
it between that step's PUT and its `replace`: a live file with no object, then its inputs
purged (review R-2; the protocol model's F13). And "an input is gone, so no step can list
these outputs" was false while the input's removal was unlogged: a ledger rebuilt from its
log brings the input back and an identical step commits the very objects the conflicted
step deleted (the model's F14, critical). Both are acknowledged-row loss (I1, I11).

**Alternatives.** (a) **Step-unique output keys** (the model's fix for F13/F14): a fresh step
id in every output key, so no step adopts or deletes another's object; a conflicted step
deletes only its own outputs, and only once the conflicting removal is logged; the sweep
keeps its age rule. Sound, and checked by the model, but it changes the key format of
`contracts/TABLES.md` (a format change under `contracts/COMPATIBILITY.md` §3.4, read by query,
the publisher and the sweep), turns every retry into a new pair of objects to be cleaned up
(no adoption), and keeps the sweep's safety resting on two clocks (the Worker's step deadline
against R2's upload time). (b) **An intent in the ledger** before the PUTs (the reviewer's
suggestion), which `orphanCheck` reports as known: needs new ledger state and RPCs, and with
adopted keys still races (the sweep may judge before the retry records its intent; R2 deletes
are not conditional), so it needs (a) as well. (c) **Refresh the upload time on adoption**
(re-PUT): does not close it; the sweep decided on its earlier listing. (d) **HEAD and re-PUT
after `replace`**: narrows the window, does not close it. (e) **Never adopt; fail the step on
an existing object**: a crashed attempt then blocks its job until the sweep removes the
leftover.

**Why this one.** It closes R-2, F13 and F14 with one rule that rests on ledger facts already
monotone (a removed key whose object is gone never returns), as D20 did for removals, and on
no clock. Nothing on the step's path is added: the record rides on the PUT the step already
makes. No contract or key format changes; the only new persisted format is the versioned
metadata record, which compact writes and janitor reads (golden files in both). A retry still
adopts its predecessor's objects, so a crash costs no extra objects.

**Cost.** A leftover output lives until one of its inputs is purged (the inputs' delete grace,
then the next orphan sweep, at most daily), or for as long as its inputs stay live: R2 bytes,
not correctness, and bounded by retention. An output whose record is missing or unreadable is
never deleted automatically (reported as `unknown_inputs`). A merge whose input names exceed
6 KB of metadata is refused (`too_many_inputs`; about 25 pairs at 120-byte keys; the
budget allows 8). The sweep lists with metadata and asks the ledger about the missing inputs
of each unreferenced output in the same read.

**Would change if.** R2 offers a conditional delete (then the sweep could delete exactly the
version it judged, and age would do); the ledger gains intents or leases for other reasons;
merges need more inputs than metadata holds (then the record moves to a sidecar object or
the keys become step-unique, alternative (a)); or leftovers accumulate enough to matter.

## D31. Split execution: leaves own ranges of series keys, aggregate exactly, and are counted by samples and by series

**Decision.** A PromQL query whose every selector sits inside a decomposable aggregation
(`sum`, `avg`, `count`, `group`, `min`, `max`, `stddev`, `stdvar`, `topk`, `bottomk`,
`count_values` over a series-local argument) is split over `L` leaf Durable Objects when one
isolate is not enough. Part `j` owns the series whose key (the `series_id`, or a hash of the
labels the argument cannot change) falls in `[j·2^64/L, (j+1)·2^64/L)`, so every sample of a
series, lake and tail, reaches one leaf (I17). Leaves pull their part's rows from reader
leaves (one call per group of at most six files) and the coordinator cuts the tail by part.
Every aggregation is computed exactly and order-independently (exact sums rounded once,
total orders for `min`/`max`/`topk`), so a split answer is byte-identical to one place.
**`L` is the larger of two counts**, each at three quarters of one isolate's limit: the scan
bound (plus tail) over `maxSamples`, and the series the query loads, estimated from the
series files' row groups before any fetch, over `maxSeries`. A query splits when either is
above its threshold (`splitAboveSamples`, `splitAboveSeries`), or its files do not fit one
place. `/api/v1/plan` returns that decision from the ledger alone.

**Why.** Sized by samples alone, a query over many series with few samples each ran in one
place, or on too few leaves, and was refused by `max_series`: measured here, `sum by (job)`
over 100,000 series was refused after materialising 87 MiB, where 7 leaves answer it
(`query/CARDINALITY.md`). Exact aggregation is what makes split results comparable byte for
byte with one place; a Neumaier sum cannot be exact under a different order.

**Alternatives.** (a) Split by file or by time: a series' rows in several leaves, wrong for
`rate` across the seam and double counting. (b) Ship every series' values to the coordinator:
not compact. (c) Leaves read every file themselves: six reads in flight per object, about
100 sequential waves for a day of flush files. (d) Learn `L` from the leaves' counts after a
first round (re-split): robust to a bad estimate but pays a whole extra read; kept as the
fallback if the estimate proves unreliable. (e) Partials as Arrow IPC (DESIGN §6.2 as first
written): the binary form here is smaller and exact.

**Cost.** Every part reads every file and decodes its `series_id` column (`L`-fold reads
until row groups are cut by key range); extracts cross RPC at 20 bytes a row. A sum can
differ from Prometheus' compensated sum in the last bit (it is the correctly rounded one).
The series estimate counts whole row groups (high for a small metric among large ones), and
is low when a shard's segments are shorter than one scrape interval.

**Would change if.** Row groups are cut by `series_id` within a metric (then a part reads only
its key range and `L` costs little), or Prometheus-identical last bits matter more than split
invariance, or the estimate misleads in production (then alternative (d)).

## D32. Read-side cardinality: exact counting with caps sized to the isolate; no sketch yet

**Decision.** `/api/v1/status/tsdb` and `/api/v1/status/cardinality` count exactly, from
`metric_series` files and tail series tables (no sample is read), in one place or over
leaves that each own a range of `series_id`s. Distinct series and distinct label pairs plus
(metric, label, value) triples are capped (`maxCardinalitySeries` 1,000,000,
`maxCardinalityPairs` 400,000); above a cap the report is refused, naming it, never
approximated. The report is counted over leaves when the series files hold more than
`cardinalitySplitAboveSeries` (50,000) series. The write path keeps its approximate
active-series limit (D21: HyperLogLog and Bloom filter); that is admission, not reporting.

**Why.** Below the caps the error is zero, which is what a person cutting cardinality needs
to trust. The caps are where memory runs out: measured here, the coordinator's merge holds
about 130 bytes of WASM memory per distinct pair or triple (25.9 MiB for 200,000), and one
place 51.9 MiB for 100,000 series. The earlier pair cap of 2,000,000 would have let a merge
reach about 260 MiB before refusing, past a 128 MB isolate (natively it reached 288 MiB at
1,000,000 unique values and was then refused).

**Alternatives.** (a) HyperLogLog per label name for distinct values and pairs, and a
heavy-hitter sketch (SpaceSaving) for top pairs: memory bounded whatever the cardinality,
about 1.6 % error at 1 KiB per counter, but approximate exactly where a person decides what to
drop. (b) A streaming merge of summaries sorted by (label, value): exact, memory about the
summaries' bytes (30 MiB at 1,000,000 unique values) instead of 280 MiB of hash maps; the
first thing to build if tenants hit the cap. (c) No caps: an isolate dies instead of a 422.

**Would change if.** Tenants hit the pair cap in practice (build (b), then raise the cap), or a
report over a window wider than the caps allow is needed (then (a), labelled approximate).

## D33. Anomaly rules that do not page default to robust z with the quantile spread; pages stay on a static threshold; the other detectors explain

(Rewritten 2026-11-19. **This replaces the earlier D33**, "Anomaly rules page on EWMA or a static
threshold; the other detectors explain", which made EWMA the default for rules that do not page and
marked the quantile spread as unvalidated. Its "would change if" came true: the quantile spread held
its score on data it had not seen. Its clause that burn rate was to compile to recording rules had
already been replaced by D42: an SLO is its own rule kind.)

**Decision.** An anomaly rule (`contracts/rules.ts`, version 2; the text of its defaults changed with
no version change, since the stored form did not) that names no detector and does not page uses the
robust z-score with the quantile spread: k 2 times the 99th percentile of |x − median| over the
trailing 1,500 points, severity `ticket`. With `severity: page` and no detector it is a static
threshold, and the author gives the level. `robust_z` and `seasonal` named without a spread get the
quantile spread with the configuration frozen on NAB (robust z as above; seasonal 1 season, k 2,
adapt robust); `spread: "mad"` gets the library's own defaults, with a warning that quotes both
benchmarks. EWMA stays nameable, warned with both numbers. CUSUM defaults to `info` and may not
page; STL and PELT are not rule detectors; burn rate is the SLO rule kind (D42). The window is the
largest whose stored state fitted the per-series limit (64 KiB) for any values while state was
stored as JSON; the configuration frozen with a 4,000-point window can be named and is refused at
save over that limit, with what it is and what fits (once D60's ring blocks are written, in a later
release, it fits, and is still not the default). Defaults are resolved and written out when a rule is saved, so every rule stored
before keeps what it was saved with; a rule saved again over a stored one (the same group, and the
same monitor id, or the same name and expression) keeps, for each field it leaves out, the stored
value that was the default when it was stored, and the save says so. The guide, served at
`GET /api/v1/monitors/detectors` from one copy in `ruler/src/anomaly.ts`, labels every number with
its kind of evidence: held out, confirmed or not confirmed on unseen data, post hoc.

**Alternatives.** (a) Keep EWMA (the earlier D33). (b) The confirmed configuration as frozen, window
4,000: raise the per-series state limit to about 150 KB, or store the window incrementally (blocks
of rows, a point appended each tick) and raise the limit for this detector. (c) A window of 1,000
points (about 37 KB, 28 series a rule). (d) The window in time on 5-minute rollups (4,000 points =
14 days), which SMD did not test. (e) The window at the edge of the save-time estimate (1,781
points at 36 bytes a point). (f) Resolve defaults at evaluation, so that every rule follows today's
defaults. (g) Resolve them afresh at every save, stored rule or not. (h) The quantile spread for
pages too.

**Why.** On SMD (28 servers' metrics; every parameter frozen on NAB before SMD was fetched;
`anomaly/README.md`) the frozen robust z with the quantile spread scored 42.8 (NAB held out 44.8),
the static threshold 16.4 and EWMA 10.4: robust z − EWMA +32.4 [20.7, 48.7] (95%, machine
bootstrap), event F1 0.441 against 0.206, which is the earlier D33's condition met by a rule written
in advance. EWMA did not hold (below the threshold in every profile), so (a) keeps a default that
failed on data it had not seen. The frozen window needs about 145 KB of state a series, over the
ruler's 64 KiB. The rule the project lead set: measure, held out on NAB, the largest window that
fits, and adopt it if it beats EWMA and the threshold held out on NAB and on SMD; else keep EWMA.
1,500 points is that window by the longest number encoding (39.7 bytes a point; 60.9 KB a series
with eight labels and an explanation, measured here). Measured here (`ruler/tools/anomaly-default/`):
NAB held out (window fixed, k chosen on each half) 42.6 / 29.7 / 55.4 (standard / low FP / low FN),
against EWMA 30.1 / 3.9 / 40.8 and the threshold 21.8 / 5.5 / 32.7; SMD (window 1,500, k 2)
42.5 / 21.2 / 50.8, +32.0 [20.6, 48.1] over EWMA and +26.0 [14.6, 35.1] over the threshold. The SMD
figure is **post hoc**: only the 4,000-point window was pre-registered, and k was fixed at the frozen
2 before the run. (c) scored lower on both (NAB 39.4, SMD 37.6, post hoc) and below the threshold in
SMD's low-FP profile (9.9 against 15.5). (e) passes the save check, but values that print long reach
72 KB and are refused at run time. (b) needs a storage change and a larger budget; (d) is untested.
(f) would change stored rules at the upgrade; (g) would change a rule whenever a pipeline re-applies
an unchanged rule file. (h): on SMD the quantile spread's low-FP lead over the threshold is not
significant (+7.5 [−8.8, 19.7] at 4,000 points, +5.7 [−12.4, 19.0] at 1,500) and it raised about
eight times the threshold's unmatched alarms per machine-day (12.2 against 1.5).

**Cost.** State: about 55 KB a series as JSON (estimate; 1.4 KB for EWMA), so a default rule keeps
at most 18 series (1 MiB a rule; it was 100), and a shard holds about 16 such rules at their cap
(16 MiB). The release that turns on D60's writer (Float64 ring blocks) brings about 18.8 KB a series
(estimate; 17.8 KB measured here, whatever the values): 55 series a rule.
CPU, by the D51 model (extrapolated: its robust z prices were calibrated at 3,992 and 11,768 bytes of
state, here 55,400): 0.35 ms a point, so a warm-up costs 0.53 s a series and the 5 s budget warms
about 9 series; a rule with more starts cold and warms live (it scores after 20 points; its window is
full after 25 h at a 1-minute interval). In Node here the per-point cost grew 4.4–5.6 times from 288
to 1,500 points, the model 4.5 times; it is not measured in workerd at this size. Each tick
serialises and writes each series' state (whole batches per row: 2 rows and 879 KB a tick at 18
series, measured); with D60's writer on, the head and the current block (2 rows, 13 KB).
The 4,000-point configuration: 0.92 ms a point by the same model (3.7 s
to warm one series), at most 7 series a rule, where its limit is raised; 22 within the default
limits once D60's ring blocks are written (46.1 KB a series measured here). A rule saved again may keep EWMA indefinitely; each
such save warns. The evidence is two public benchmarks, nothing measured on viz's own data, and the
chosen window's SMD score is post hoc.

**Would change if.** viz's own labelled incidents rank the detectors differently; a third benchmark
contradicts SMD; the window's state can be stored incrementally (then the frozen 4,000 points, or a
window in time on rollups: D60 does this, read now and written from a later release, where the
4,000-point window fits; the default stays 1,500 until this decision is taken again, with the
warm-up of a 4,000-point rule measured in workerd); the CPU model, measured in workerd at 1,500 points, prices warm-ups
higher (then a smaller window or a larger budget); or a detector gains a calibrated false-alarm rate
fit to page.

## D34. The publisher is nudged by the maintenance run and driven by its own alarm; no cron, no queue

**Decision.** Every maintenance run (`stack/src/maintain.ts`, the consumer of `viz-maint`)
ends by nudging its cell's publisher with `nudge(PUBLISHER, cell, [tenant])`
(`publisher/src/nudge.ts`): one RPC to `Publisher.notify`, which writes the tenant to
`pending` and a `publish` deadline (`publishIntervalMs`, 2 min, after the first nudge, so
nudges coalesce into one commit per table). The nudge is best effort and bounded (2 s); if it
is not recorded, the run marks the tenant due an hour later, so the hourly cron runs it again
and it nudges again. The publisher's one alarm serves every deadline it has, kept as rows of
`due` (storage migration 2, additive): `publish` (and its retry after a hole, a refusal or a
backlog, `retryMs`), `sweep` (an orphan grace period after a commit or a failed attempt, then
the grace end of what it marked) and `expire:<table>` (when every snapshot beyond the newest
two has left the window, so one expiry drops them all). The alarm is set at the earliest
deadline and deleted when there is none. Nothing on the ingest or flush path, and nothing in
the cron, calls the publisher. As built in `publisher/`, and **wired since 2026-11-19**:
`stack/wrangler.jsonc` binds `PUBLISHER` (class `Publisher` of viz-publisher, which deploys
first), `maintainTenant` (`stack/src/maintain.ts`) ends with the nudge only when that binding
exists, and the janitor's purge also waits for the publisher's `safeToDelete`
(`stack/README.md`, "The publisher wired in"; on Cloudflare, `deploy/README.md`, Trial 3).
A tenant whose only waiting tombstones are held back by the publisher is looked at again after
6 h, not every delete grace (1 h): a release comes at the earliest a day after the removal is
published, and in a cell that publishes nothing more it never comes (its objects stay). Would
change if the publisher told the janitor when it releases a tenant's keys.

**Alternatives.** (a) The ledger's drain nudges after writing a segment: the exact moment a
change becomes readable, but it puts a publisher call on the drain, which shards wait on for
`logged` (D15), and on every drain (up to five a second per busy tenant), in the component
that most needs to stay simple. (b) A `viz-publish` queue fed by the ledger or by flush: a
send, three queue operations and a consumer invocation per message where one RPC does, and
the queue's retries are not needed (the publisher's `pending` row is the durable part).
(c) The hourly cron calls `publish()`: lists every tenant's log every hour and wakes the
publisher every hour while idle. (d) The flush consumer's `onFlushed` nudges: covers units
but not the ledger changes the maintenance run makes (compaction, retention). (e) No
deadlines table: the expiry and sweep schedule cannot survive the alarm being re-set for a
publish, so they would need a periodic wake.

**Why.** Every ledger change comes from a flush or a maintenance run, and every flush that
changed something already causes a maintenance run (D18, R-11(b)); a run's own `replace` or
`expire` leaves tombstones, whose purge brings another run once the removal is logged. So a
nudge at the end of each run reaches the publisher after every change is in R2, at the cost
of one RPC per run, with no new state outside the publisher and no change to the ledger. A
change logged after the publisher read the log (the drain runs 200 ms after the commit) is
published at the next nudge; the purge's run guarantees one. A ledger that starts a new
incarnation without any change starts it from what R2 holds, which is what was published, so
the re-base can wait for the next nudge. Idle cost: zero. A deployment whose maintenance
markers are not due sends no nudge (stack/test/triggers.test.ts), and after its last commit
the publisher's alarm runs a bounded number of times (5 in `publisher/test/triggers.test.ts`:
a sweep, one expiry per table, the sweep that marks and the one that deletes) and is deleted.

**Cost.** Publication lags a change by up to `publishIntervalMs` after its maintenance run,
and by up to the delete grace (1 h) in the rare case that the drain was later than the
publish. A tenant stopped by a hole, a corrupt or an unsupported segment is retried every
`retryMs` (1 min) for as long as it lasts: a wake and a few R2 operations per minute, not
backed off. One SQLite table more in the publisher (migration 2, `readableFrom` 1: release 1
on this storage publishes on nudges and loses only the expiry and sweep deadlines). The
publisher was never deployed, so the bootstrapping rule (COMPATIBILITY.md §6, no migration 2
before the first versioned release is the floor) protects no deployment here; the first
release deployed carries both migrations.

**Would change if.** Maintenance runs stop following every flush (then the flush consumer
nudges as well); publication must be fresher than a few minutes (then the ledger's drain
nudges, with the call kept off its critical path); or the nudge RPC rate to one publisher
object becomes a hot spot (then the maintenance consumer nudges once per batch).

## D35. viz is Apache-2.0; TraceQL and LogQL are clean-room

**Decision.** The owner chose Apache-2.0 for viz (2026-11-19). The query engines for TraceQL
and LogQL, whose reference implementations (Grafana Tempo and Loki) are AGPL-3.0, are written
clean-room from public documentation and checked against Tempo and Loki only as black boxes
run at test time; their test suites are fetched at test time and never stored. An earlier
TraceQL crate that transcribed Tempo's parser tables, ported its evaluator and vendored its
tests was removed from the tree and is not shipped.

**Alternatives.** AGPL-3.0 for all of viz, keeping the ported crate (simplest; every operator
of a modified viz as a service must publish its source, and permissive or closed reuse is
ruled out). Keeping TraceQL out of viz (no trace queries).

**Why.** Everything else in viz is original or permissively licensed, the parsers are
contained pieces, and differential testing against the real engines makes a clean-room
rewrite checkable. Apache-2.0 keeps every later licensing option open.

**Would change if.** A clean-room engine cannot reach useful conformance in reasonable time,
or the owner decides viz should be copyleft.

## D36. The ledger answers after its SQLite commit and logs to R2 in batched segments; an incarnation's base is in R2 before it commits

**Decision.** A ledger mutation commits its change to an outbox table in the same SQLite
transaction and answers. Its alarm (200 ms after the first unlogged commit; a commit also
starts a drain once one is due) writes every pending change as one immutable segment
object per drain, `If-None-Match: *`, after recording the segment's bounds durably, and
deletes those rows and advances each stream's *logged* watermark only once the PUT
returned; a retry writes exactly the recorded segment. Shards may still discard only up to
the logged watermark. A checkpoint (the whole state) is written after at least 256 segments
and only once the log since the last checkpoint is as large as it, and replaces the older
one; segments are kept. The state is bounded: `addUnit` answers `full` above 16 MiB of
estimated state. The release is forward-only for the ledger's storage (schema migration 2,
`readableFrom` 2); after a rollback that drained the first layout anyway, the roll-forward
restarts the incarnation from SQLite, and a rebuild refuses an incarnation holding both
layouts.
Starting an incarnation (a new tenant, storage loss, or storage still on the first layout)
runs outside `blockConcurrencyWhile`: requests wait at most 2 s and are then refused as
retryable (`ledger_unavailable`), and the incarnation's base segment is written to R2
**before** SQLite commits the incarnation, so one incarnation number never names two
histories. Contract: `contracts/LEDGER-LOG.md`; code: `ledger/src/ledger.ts`. **The checkpoint
format and the 16 MiB size limit described here are replaced by D47** (2026-11-19: alternative
(h) below, built); the rest stands.

**Alternatives.** (a) As built before: one R2 object per change, written before the
mutation answers. (b) One object per change, written in the background. (c) Group commit
on the request path: concurrent mutations share one segment PUT and are answered after it.
(d) The log in another Durable Object or in D1 instead of R2. (e) Rebuild inside
`blockConcurrencyWhile`, as before, with checkpoints only. (f) Commit the incarnation first
and write its base with the first drain (the plan before the protocol model). For
checkpoints: (g) every N segments (as first built); (h) the state written as many lines
across several drains from a snapshot, with a rebuild that streams into SQLite. For the
rollout: (i) two releases, readers first; (j) after a rollback, stay stuck until an operator
acts.

**Why.** (a) admitted about one unit per second (S4): an R2 PUT takes 0.17–0.4 s whatever
its size and AGENTS.md forbids one on the acknowledgement path. (b) keeps one Class A write
per change and a strictly ordered queue of PUTs, so the drain falls behind at the rates
that matter (17 units/s per large tenant). (c) still puts a PUT on every acknowledgement
and couples callers' latency to R2's tail. (d) moves the durability problem rather than
solving it, and a rebuild would depend on a second stateful service. The SQLite commit is
already durable; what R2 adds is survival of storage loss, and the shards' discard rule
already waits for that. (e) failed the review (R-3): a rebuild over about 600 per-change
objects already takes 29 s on Cloudflare, where about 30 s resets the object, so the
tenant could never serve again. (f) is the model's trace F11: two storage losses before a
first drain start the same incarnation number with different contents.

For checkpoints, (g) failed review S-2: a checkpoint is the whole state, so at a busy tenant's
write rate it costs seconds of blocked object and tens of GB of R2 a day per tenant; tying it
to the log's volume bounds both by the log. (h) is the real fix for large states and is not
built: until it is, the size limit keeps a base, a checkpoint and a rebuild inside one
isolate, and refuses (retryably, explicitly) rather than letting the object reset. For the
rollout, (i) had no earlier release to protect (no ledger was in production); the boundary is
made real by the version row instead. (j) is what happens for any other break in the log;
the rollback's own signature is healed at once because SQLite holds every committed change
and the protocol model checks that fix (review S-1).

**Measured** (on Cloudflare, `spikes/s4-ledger-scale/`, 2026-11-19, n = 3, 20 s runs): with
eight writers, 234–422 units per second against 1.7–3.3 for (a) the same day; `addUnit`
median 16–31 ms against 2.3–4.1 s; logged watermark caught up 0.2–0.8 s after the last
unit. Rebuild of 5,008 changes from 104 segments: 5.4 s, state identical.

**Cost of it.** Changes committed but not yet in a segment when storage is lost are lost,
as before (one drain cycle, about 0.2–1 s at load). Flush acknowledges shards a drain cycle
later, so a flush run usually ends `awaitingLog` and its queue message is retried once.
An outbox row is one SQLite value, so one change is limited to Cloudflare's 2 MB per value.

**Would change if.** R2 PUT latency fell to a few milliseconds (then (c) is simpler); a
tenant needed more than about 400 units per second from one ledger (then the drain's JSON
encoding, which shares the object's thread, is the next limit: split the tenant); a tenant
needs more live files than the size limit allows (then (h)); or losing one drain cycle of
changes on storage loss became unacceptable (then the log must be on the request path
again, and the ceiling goes with it).

## D37. A shard refuses early when it has too much in flight, and commits concurrent appends as one group

**Decision.** `append` answers `backpressure` with scope `overload` and a jittered
`Retry-After` before it reads or writes anything when the shard already has 64 appends in
flight or 16 MB pending. Accepted appends join an open group that commits in one SQLite
transaction at the end of the current event (or at 4 MB); each caller is answered only
after that transaction, with its own sequence number; a failed transaction answers every
member with the error and stores nothing. `edge` answers an overload refusal with **503**
and the shard's `Retry-After`, and refuses a tenant's next request before decoding it while
every shard it may write to is inside that wait. A full buffer (tenant or shard cap) stays
429.

**Alternatives.** (a) As built: one transaction per append, and the runtime's own overload
errors at saturation. (b) Early refusal answered 429. (c) A group window of a few
milliseconds instead of the end of the event. (d) Larger in-flight limits (256) or none.

**Why.** (a) saturated at 230–340 requests per second per shard with the 99th percentile
near 1 s under overload, and its 503s came from the runtime after the request had queued.
(b) Remote Write senders must retry 5xx and may retry 429; Prometheus does not retry 429
by default, so an overload answered 429 can be dropped by the sender (training knowledge,
the Remote Write 1.0 specification; not checked here). (c) and (d) were tried only in local
workerd, where the clients and the shard share one thread (`shard/bench/results/tuning.log`):
at 64 clients a 2 ms window raised throughput by a quarter and the 99th percentile from 243
to 409 ms; at 160 clients a limit of 256 refused nothing and gave the most throughput (821/s,
99th 270 ms), 16 the lowest latency with half the requests refused, and 64 sat between.
Those runs do not single out 64. It was kept because it bounds what an acknowledgement can
wait behind to about one group, and it held on Cloudflare (below); tuning it there is not
done.

**Measured** (on Cloudflare, `spikes/s3-ingest-throughput/`, 2026-11-19, n = 3, 10 s runs,
50 series per request): at 64 clients 864–1,056 acknowledged requests per second, median
50–59 ms, 99th 129–148 ms, against 301–340, 157–178 ms and 446–493 ms for (a) the same day;
at 200 clients the refusals took 0–7 ms at the median and acknowledged requests kept a 99th
percentile of 137–276 ms.

**Would change if.** The runtime exposed its own queue depth (then the limit could follow
it), or measured CPU per append changed enough that 64 in flight no longer bounds latency.

## D38. Pool and shard names never contain `_`

**Decision.** Pool and shard names are segments of `[A-Za-z0-9-]` joined by `/`
(`POOL_NAME`, `SHARD_NAME` in `contracts/ledger.ts`; `contracts/TABLES.md`). `edge` refuses a
pool map naming another (503), a shard object addressed by another name serves nothing,
and the ledger answers `invalid` to a unit of such a stream. `dedicatedPool` turns a
tenant id's `_` into `-`.

**Alternatives.** (a) Escape the shard part of flush-file keys so any name is encoded
one-to-one. (b) Leave names free and have the orphan sweep match a key against every
stream whose encoding equals it.

**Why.** Flush-file keys write a shard name with `/` as `_`, so pools `a/b` and `a_b` would
give two streams of one tenant the same key part, and the orphan sweep could judge a file
by the wrong stream's logged watermark and delete a file that may still be admitted. (a)
changes the key format every reader parses (a format change across janitor, compact,
publisher and the goldens) to protect names nobody uses; (b) has to guess which stream
wrote a file. Every name in use already fits the rule, so nothing written changes.

**Would change if.** Pool names have to carry characters outside the set (then (a), as a
new key format version).

## D39. The ruler reaches the engine over the query HTTP API with a service key that control issues; notifications go to a destination set in control, read over the Durable Object binding

**Decision.** Until viz-query exports an RPC entrypoint, the ruler evaluates through the
Prometheus HTTP API it already serves (`QUERY` service binding, `/api/v1/query`, `/query_range`,
and `/plan` for save-time validation) and writes recording rules through Remote Write
(`INGEST`). Both authenticate with a **service key**: an ordinary API key named
`service:viz-ruler/<shard>`, scopes `read` and `write` fixed by `contracts/control.ts`, which the
tenant's `Tenant` object issues to the Ruler object over its Durable Object binding
(`serviceKey`) and the ruler keeps in its SQLite. Each request rotates it; a refused key is
replaced only when it is older than KV propagation (3 minutes) and at most every 5 minutes; a
key a person disabled is not replaced. Every engine call of one Ruler object passes one gate
that admits a single call at a time. The tenant's default notification destination (webhook
URL, `alertmanager` or plain `json` body, write-only signing secret) is a control setting; the
notifier reads it over the same binding (`notificationTarget`) at most once a minute while it
has work, keeps a copy in its SQLite, and offers it as the reserved receiver `viz:default`.

**Alternatives.** (a) An RPC entrypoint on viz-query taking the tenant as an argument (the
ruler contract's `EVALUATOR.evaluate(tenant, requests)`): the right end state, but query/ could
not be changed here (README of ruler, "Needed changes"). (b) The ruler writes its own
`key:` record into KV: a second writer of the key store, a key the tenant cannot see or revoke.
(c) A shared internal secret plus a tenant header that query trusts from service bindings:
query takes the tenant only from the key, and changing that is a query change and a weaker
rule. (d) The tenant pastes a `read` key into the monitors API: a manual step for every tenant,
and a credential in a request body. For the destination: (e) control publishes it to KV, as it
does retention and pool maps: the signing secret would sit in a namespace every viz Worker
reads. (f) The ruler's own notifier config only (it existed): then control's `notifications`
setting stays inert, and a person sets alerting up in two places. For the six-connection
budget: (g) let groups due together query concurrently (up to `maxConcurrentGroups`, 4).

**Why.** (a) is not available today and (b)–(d) give up either "the tenant comes only from a
credential" or "keys belong to control". A service key keeps both: query, ingest and edge see
an ordinary key and take the tenant from it; control lists it, audits each issue, and a person
can disable it. The binding to `Tenant` is how the gateway already provisions tenants, and the
ruler takes the tenant from its own object name, never from a request. Reading the destination
over the binding keeps the secret in two objects' storage instead of KV, and a stored copy keeps
routing unchanged during a control outage. One call in flight: a service-bound callee spends
from its caller's six connections (AGENTS.md, spike S1), and one query of viz-query can open
several at once (ledger, then shards and leaves in parallel), so concurrency in the ruler would
only queue inside the platform; (g) is what the gate replaces.

**Cost.** A batch of N expressions is N HTTP requests in sequence, not one plan with shared
scans (DESIGN §7): a group's tick takes the sum of its queries' latencies, about 0.1–0.3 s each
(modelled from the deploy trial's query latency), so a 1,000-rule group would need minutes and
hit `groupTimeoutMs` (120 s). A rotation per refused key, and a stored bearer key per rule shard.
Recording rules land through ingest's normal path, with its quotas.

**Would change if.** viz-query exports an RPC entrypoint (`ruler/README.md`, "Needed changes"):
then `EVALUATOR` is bound, the HTTP path and the service key's `read` scope go, and a group is
one call. If the platform's connection limit for service-bound callees turns out not to be
shared (only the self-binding case was measured), the gate can admit more.

## D40. TraceQL: a hand-written parser bounded at 100 levels; Go's regex dialect, through a crate shared with LogQL; where Tempo's documentation is silent, its evaluator's observed behaviour, not its storage shortcuts

**Decision.** `engine/traceql` parses TraceQL with a hand-written lexer and recursive-descent
/ precedence-climbing parser (no parser crate or generator). Its semantics come from Tempo's
public documentation; where the documentation is silent (operator precedence, the metrics time
grid, quantile buckets, how missing, empty-array and NaN values compare, result keys), from
Tempo v3.1.1's behaviour observed as a black box. Where Tempo answers the same question two
ways depending on its query plan (its storage layer applying a condition itself versus its
evaluator), viz follows the evaluator; where Tempo contradicts its documentation (union
structural operators such as `&>>` returning only some of the left-hand spans), viz follows
the documentation. Each such difference is a named rule in the crate's differential comparison
(`engine/traceql/README.md`). `=~` and `!~` use Go's `regexp` dialect, as Tempo's
documentation says and its answers show (ASCII `\w \d \s \b`, `\Q…\E`, octal escapes, Go's
refusals), fully anchored with `.` matching a newline; patterns are translated for the Rust
`regex` crate by `engine/goregex`, the translator viz-logql uses too, and Unicode classes
(`\p{…}`) are Unsupported. Nesting is bounded where the query is parsed: deeper than 100
levels of parser recursion or of syntax-tree height (the bound viz-logql and `engine/query`'s
PromQL use), a regex nested deeper than 64 levels or compiling to more than 1 MiB, or more
than 16 regexes, and `parse` refuses the query, so no later pass can exhaust a stack (a stack
overflow traps a WASM instance; it is not an error). The bound of 100 replaces an earlier
200 (2026-11-19), and the regex dialect replaces Rust's own, which this entry left implicit.

**Alternatives.** A permissively licensed parser crate or a parser generator (none exists for
TraceQL; a generated parser carries grammar tables into the WASM module: `promql-parser` and
what it pulls in, grammar tables included, are about 90% of `viz-promql`'s module,
`engine/promql/README.md`). Reproducing every observed Tempo answer, plan artefacts included
(byte-compatible with one Tempo release, but it would copy defects: Tempo returns nothing for
a lone `{ !(status = error) }`, and `{ v = "1.0" || .b }` drops spans without `b`). Following
only the documentation (leaves precedence and the metrics grid undefined). For regexes: Rust's
dialect as it is (Unicode-aware `\w \d \s \b`, so `=~ "\w+"` matched `é` and `日本` where Tempo
does not, and it accepts patterns Go refuses, such as `(?x)`, `x{1001}` or `a)|(b`, which a
textual `^(?s:…)$` wrapper turned into a differently anchored pattern); a second copy of
viz-logql's translator inside this crate (two copies drift: the shared one gained a dozen Go
rules and a fix for a quadratic case that a copy would have left behind); translating Unicode
classes too (Go and Rust differ in the names they accept and in what a script name means, and
the tables add to the module). For nesting: explicit heap stacks in every pass (parser,
validation, conversion, planning, evaluation and an iterative `Drop`) instead of a limit,
which accepts any depth Tempo does but rewrites every recursive function; or keeping 200.

**Why.** The hand-written parser is small (no grammar tables in the module: the whole engine
is 1.28 MB raw and 0.43 MB gzipped, measured here), reports positions directly, and keeps the
clean-room record simple (D35). Tempo is the compatibility target, so its evaluator settles
what the documentation leaves open; answers that depend on Tempo's internal plan cannot be
specified and are not copied. On regexes Tempo is Go's `regexp`: of 289 probe patterns on 70
subjects, viz now gives Tempo's answer for every one but the 11 Unicode classes (before, 98 of
the other 278 differed: 28 matched differently, 37 were refused and 33 accepted against Tempo),
and the shared translator agrees with Go's own `regexp` on 100,000
generated patterns (`engine/goregex/README.md`). One bound at `parse` covers every pass. The
bound is 100 because nothing legitimate comes near it: measured with `nesting()`, Tempo's own
284 parseable examples nest at most 10 levels and the 3,600 generated differential queries at
most 12. At 100 the costliest query needs 144 KiB of native stack (278 KiB at 200), and in Node
it runs with V8's stack cut to 96 KB and the module's to 128 KiB (at 200 it trapped at 96 KB;
the defaults are about 1 MiB each); one bound for all three engines is simpler to state to
users and to the query Worker.

**Would change if.** Tempo documents a different semantics, or fixes the plan-dependent cases
differently; or clients turn out to depend on a Tempo artefact (then that one rule is copied
and recorded here). For the limits: clients send longer chains than 97 operators (generated
`||` lists are the likely case; a chain of one associative operator could then be built as a
balanced tree), or a Workers isolate turns out to have a much smaller stack than Node's. For
regexes: users need Unicode classes (then Go's names and its Script semantics are translated
and measured against the module size), or Tempo moves off Go's `regexp`.

## D41. Series-level pruning: the layout stays; the index fragment gains row-group series bounds and the footer's place; pages are skipped in memory, not fetched

**Decision.** Files keep the layout they had (row groups of at most 100,000 rows, data pages
of at most 20,000, the offset index the `parquet` crate writes, no column index): the Parquet
bytes of a flush or a merge do not change. The index fragment (`FileEntry.index`) gains, per
row group, the `series_id` of its first and last row (`"sid"`), and per file where the footer
region starts and how long it is (`"foot"`), additively within version 1
(`contracts/TABLES.md`, "The index fragment"). A reader that has resolved its matchers against
the `metric_series` files, or owns a split part's `series_id` range, fetches the footer region
and the row groups whose `(metric_name, series_id)` range can hold one of its series, joining
ranges less than 64 KiB apart and reading the whole object when the ranges would cover half
of it; inside a row group it decodes `series_id`, then skips the pages of `ts` and `value` that
hold none of its rows, by the offset index, without reading them. The query Worker resolves
first only when the fragments alone say a query does not fit one place and a matcher selects
by more than the metric name (one more round of reads); split readers read their part's id
range of each sample file; the label endpoints read series files only (item 3 of
`query/CARDINALITY.md`, same entry).

**Why (measured here, native, `engine/storage/examples/layout.rs`, one ten-minute unit of
100,000 series, load average 10 to 15).** What a one-series read fetches is one row group and
the footer whatever the row-group size: 235 KiB at 100,000 rows, 140 KiB at 50,000, 90 KiB at
25,000, 79 KiB at 10,000, always two range reads, all under the 1 MB below which a range read
costs about one round trip (AGENTS.md). Smaller row groups cost where it is scarce: the
fragment grows from 1.7 KiB a file (10 row groups) to 3.3, 6.5 and 16.2 KiB, against the
ledger's 16 MiB of state for all of a tenant's live files (`contracts/LEDGER-LOG.md`), and the
footer from 6.9 to 55 KiB. Smaller pages cost bytes (+1.3 % at 8,192 rows, +4.5 % at 4,096,
+15 % at 1,024) and did not make one-series decode measurably faster (0.5 to 0.7 ms at every
size: a row group is five pages of 20,000 rows, and four are skipped). A column index (per-page
min and max) doubled the footer region (16.7 to 34.0 KiB at 4,096-row pages) and would let a
reader skip decoding `series_id`, which is the cheap column. A selection spread over the id
space (`namespace=…`, a twentieth of the series) needs every row group at every size measured:
`series_id` is a hash of all labels (D19), and no layout of this kind changes that.

**Alternatives.** (a) Row groups of 10,000 to 50,000 rows: fewer bytes per one-series read,
same number of reads, a 2 to 10 times larger fragment in the ledger. (b) Pages of 1,000 to
8,000 rows, with or without a column index: more bytes on every read, no measured gain.
(c) Fetching pages (two round trips: footer and page index first, then pages): three ranges a
row group instead of one, for bytes that are below 1 MB anyway. (d) Row groups cut at metric
boundaries: unnecessary with first/last-row bounds, which are exact across metrics.
(e) Locality in the id (D19), or a promoted label before `series_id` in the sort key: the only
ways to make a `namespace=…` selection read less; a format change, not taken here.

**Would change if.** A range read's cost on Cloudflare grows with its size below 1 MB (then
smaller row groups, and a fragment that is not in the ledger's state); the ledger's state cap
is lifted or fragments move out of it; or label locality is added to the sort key (then pages
pay, and a column index with them).

## D42. An SLO is a rule kind evaluated from one query per tick and per-series bucket rings, not compiled to recording rules

**Decision.** An SLO burn-rate rule (`contracts/rules.ts`, version 4) is an objective, a
compliance window and an SLI written with `$window`. Each tick the ruler sends ONE expression per
rule in the group's batch: the SLI's two parts over the last interval, told apart by
`label_replace(…, "viz_slo_part", …) or …`. It keeps, per series, a ring of interval buckets as
long as the longest alert window and a ring of about 720 coarse buckets over the compliance
window, as rows (a head and blocks of 60 and 24 buckets; three rows a tick), warmed from history
when the rule is new (D43). The alerts are the SRE Workbook's (anomaly/'s `SRE_WORKBOOK_RULES`,
judged by its `evaluateWindows`), one alert per series and severity (`page`, `ticket`). A window
counts once 90% of its buckets have data (`min_coverage`). This replaces the earlier D33's "burn rate is to
compile to recording rules".

**Alternatives.** (a) Compile to recording rules, as Sloth and Pyrra do: one recording rule per
window (seven for the workbook's alerts) and alerting rules over them. (b) Query every window at
every tick: 7 to 14 expressions, the longest reading three days. (c) The library's incremental
detector (`burnRate.detect`) with its JSON state. (d) The three alerts of the workbook's Table 5-8
rather than the four of its alert expressions. (e) One alert per series carrying the most urgent
severity.

**Why.** Through the HTTP wiring (D39) every expression is one request in sequence and (b) reads
the 3-day window each minute, a rollup-class read per tick; (a) costs the same seven windowed
reads per tick through the recording rules, plus Remote Write and a read of what was written, and
the sentence would still lack the budget left. One bucket per tick is a tail-class read, and the
windows are sums over state. (c) copies its whole ring into and out of JSON at every point
(anomaly/README: 1.7 ms a tick through JSON at 1-minute buckets, 67 KB of state per series) and
would rewrite it every tick; the ruler's rings write one block and the head. The four alerts are
what the library already reproduces against every table of the chapter; the fourth (1 d / 2 h at
3×) resets a slow burn sooner. Per-severity alerts are what the workbook's expressions and Sloth
produce, so routing and inhibition (`severity=page` over `severity=ticket`) work unchanged; (e)
would resolve one alert and fire another whenever the severity changed.

**Cost.** State per series: 4,320 + 720 buckets at a 1-minute interval: about 80 KB in memory, and
40–170 KB stored depending on how the counts print (whole numbers, or extrapolated increases),
counted against the per-object state budget; a 10-second interval needs 25,920 buckets. Three rows
written a tick (measured), 0.3 ms CPU a tick at one series and about 9 ms at 100 (measured here,
`ruler/README.md`). The window sums are the ruler's own (fixed-order, block-cached), not the library's
loop: the same buckets give the same sums however they arrived, and agree with the library at
every point when the counts are whole numbers (tested), but they are a second implementation of
the summing. The budget-left figure's far edge moves an hour at a time (one coarse bucket).
`$window` must be the bucket: an author used to `rate(x[5m])` must write `[$window]`.

**Would change if.** viz-query exports an RPC entrypoint that plans a batch with shared scans
(then (b)'s reads cost little more than one); the ruler gains a cheaper store for rings than a
row per block; or SLOs need windows longer than the 100,000-bucket ring (then coarser fine
buckets, or (a)).

## D43. New anomaly and SLO rules are warmed from history before their first evaluation, under budgets checked before anything is fetched; backtests run the same evaluation under larger budgets; both read history in memory-sized windows

(Rewritten the same day: the first version fetched each read whole and bounded only the bytes read;
a 7-day backtest over 100 series then held about 0.6 GB, which would have killed the Durable Object
rather than been refused. The windows and the memory budget are new. Their CPU budget is D51.
Revised after the review of the ruler's pull request: windows sized at the rule's bound were many
small queries, each re-reading its look-back and files, while only the whole reads were planned.
Reads are now counted first and cut by the points they hold, and every window is planned as it is
fetched.)

**Decision.** When an anomaly or SLO rule is created (a new rule key: a new detector, parameter,
SLI or interval), a warm-up job is stored with it. At the rule's first tick the ruler builds the
reads its history class needs (the detector's look-back, or an SLO's longest window and compliance
window) at the rule's interval. It reads them **in time windows, one at a time, in order**,
feeding each step through the rule's own evaluation and carrying only the rule's state from one
window to the next, then commits the state rows and the status in one transaction. Windows fit a
memory model (`ruler/src/history.ts` `MEMORY`: the rule's state, its alerts and intervals, plus 768
bytes per point of one window) to a budget (16 MiB for a warm-up, 32 MiB for a backtest). When one
window per 11,000-step engine piece fits at the series bound the rule's evaluation enforces, the
windows are the pieces. Otherwise the read is first counted (`count(<expr>)` over the same range and
step: the series it has at every step) and cut into windows by the points counted. Every query is
planned with viz-query's `/api/v1/plan` before it is fetched and the sums compared with the cost
budget (3,000,000 samples and 16 MiB for a warm-up, 20,000,000 and 128 MiB for a backtest): before
anything is fetched, the whole reads (a lower bound of any windows) and the counts; after the counts,
before any window, the counts and every window as it will be fetched, or, past 32 windows, each
contiguous group's plan counted for every window in it (an upper bound: a window reads a subset of
its group's files). The run is refused when the model cannot fit (the state alone, or one step at
the bound), when the windows would take over 1,000 queries, when a sum exceeds the budget, or when a
plan carries the engine's own refusal. A count above the rule's bound, or a window holding more
points than its count said, stops the run. An engine failure is retried at the next tick while the rule waits (three attempts), then
the rule starts cold; a refused warm-up starts it cold and says why. Backtests of threshold, anomaly
and SLO rules take the same path and answer `over_budget` (with the model's peak and budget) having
fetched nothing or only the counts; an anomaly or SLO backtest starts with the state a warm-up at `fromMs` would leave.

**Alternatives.** (a) Start cold and warm live (as before). (b) Evaluate live at once and merge
history in later. (c) Fetch what fits the budget and warm partially. (d) No cost budget: the
engine's own limits refuse what is too large. (e) One budget for warm-ups and backtests. (f) Fetch
each read whole (the first version of this decision), bounded only by bytes read. (g) Size windows
by the series a plan estimates or a first window shows. (h) Size windows at the rule's bound and plan
only the whole reads (the second version). (i) Plan every window, or a sample of windows scaled by
their number.

**Why.** (a) leaves a seasonal rule silent for its k periods and an SLO's ticket windows
meaningless for three days. (b) cannot work for sequential detectors. (c) gives a detector a state
that is neither cold nor warm. (d) is per query, and the engine's limits are about its memory, not
what the tenant pays for an automatic read. (e) warm-ups run by themselves at every save; a backtest
is asked for. (f) holds the whole read: measured here, 0.4–0.6 GB for a week of 100 series, and it
cannot complete under a 128 MB V8 heap limit, where windows sized by the model do (`ruler/README.md`,
part 13 and "Streaming"). (g) would let one window outgrow the budget by the factor the estimate was
wrong by (a plan does not see the shards' tail; an alerting expression such as `up == 0` has no
series until an outage, then hundreds); the count gives every step's series before any window is
read. (h) made a week of a few series 326 queries for an alerting rule, each re-reading its
look-back and the files it touched, while only the whole read was compared with the budget:
`avg_over_time(x[1d])` read each day file about 46 times and the look-back 326 times what was
planned. (i) a sample's maximum times the number of windows is not a bound unless the sample holds
the dearest window, which only planning them all shows; planning contiguous groups is a bound
because the plan grows with its range, and caps the plan requests at 32.

**Cost.** A read the bound would cut into windows is scanned once more by its count, so it costs
about twice its scan plus what its windows re-read (each window reads its own look-back and every
file it touches: `avg_over_time(x[1d])` over 7 windows of a day reads 2 or 3 day files per window,
2,800,000 samples where the whole read is 800,000; this is planned, and refused over the budget,
not estimated). A read of many series is still many windows. Plan requests before a run: one per
11,000-step piece of each read and of its count, plus at most 32 for the windows (ledger reads,
10–70 ms each, through the object's one-call gate); past 32 windows the grouped plan can exceed
what is fetched by up to the group size, refusing runs that would fit. A week at 1 minute of a few
series is two range queries and two plans (it was 326 queries and one plan); an SLO warm-up with
two series, three of each (it was six and two). The count and the windows are read at different
moments; late data between them is allowed up to 10% and a series a step. A new rule's first tick
waits for its warm-up. 768 bytes a point is calibrated against resident memory in local workerd,
not measured on Cloudflare.

**Would change if.** The plan reports the tail and the series a read returns at each step (then no
count query); viz-query exports an RPC entrypoint that streams results (then one query per
read again); or the Durable Object memory limit changes.

## D44. MCP clients connect with OAuth served by control: signed stateless registrations, a person approves with an admin key, each grant is backed by an agent key the resource uses downstream, and every request is checked by control

**Decision.** The control plane is the authorization server for the agent surface's `/mcp`
(MCP 2026-07-28, "Authorization"; `contracts/oauth.ts`). It publishes RFC 8414 metadata at
`/.well-known/oauth-authorization-server` and serves `/oauth/register` (RFC 7591),
`/oauth/authorize`, `/oauth/token` and `/oauth/revoke` (RFC 7009). Public clients only, PKCE
`S256` only, exact redirect URIs (https, or http on a loopback host), one resource (`<public
URL>/mcp`, RFC 8707). mcp publishes RFC 9728 metadata and answers 401 and 403 with the
`WWW-Authenticate` the specification gives.

- **Registration stores nothing.** The client id is the registration (name, redirect URIs,
  issue time), signed with control's `OAUTH_CLIENT_KEY`. The tenant is not known when a client
  registers (it registers before anyone signs in), so a client is stored in a tenant only when a
  person of that tenant approves it; that is where the per-tenant bounds apply (clients, live
  grants, approvals per hour). A registration nobody approved within 24 h is refused; a bound
  client with no live grant is deleted after 30 days.
- **Consent through the control API.** There is no web UI, so `/oauth/authorize` validates the
  request and answers a plain-text page that says what is asked (client name marked unverified,
  redirect host, scopes, resource, lifetimes) and how to approve: `POST
  /api/v1/control/oauth/approve` with the request handle, by a person (kind `key` or `user`, never
  `agent`) holding `admin`; `dryRun` shows exactly what would be granted. The grant holds the
  requested scopes the approver's own key holds (admin counts for the dashboards scopes only;
  `admin`, `write`, `monitors:write|ack` are never grantable), and the grant follows that key
  afterwards: suspended while it is disabled, ended once it is deleted. The answer carries the
  redirect with the code, `state` and `iss`, which the person opens. The server never redirects
  by itself.
- **A grant is backed by an agent key.** Approval creates an ordinary key `oauth:<grantId>`
  (kind `agent`, the grant's scopes, expiring with the grant). The resource calls the query
  service, the control plane and the ruler with that key, never with the client's token. The
  key's secret is not stored: it is sealed (AES-256-GCM, key derived by HKDF from the credential)
  under each live code, access token and refresh token, which are themselves stored only as
  SHA-256. Control unseals it when it validates a token for the resource. The resource asks
  through `OAuthIntrospection`, a named entrypoint of viz-control (`contracts/oauth.ts`): one
  method, `introspectAccessToken(token, resource)`, answered only to a binding whose `props.caller`
  is `viz-mcp`, with the tenant taken from the token. viz-mcp holds no binding to control's
  `Tenant` class (review of D44, M-1: such a binding reaches every method of every tenant's object,
  `invoke` with a made-up identity included), and `deploy/configure.mjs` refuses to deploy one.
- **Every request is checked by control**: audience, expiry, grant and key state. Revocation
  takes effect at `/mcp` on the next request. Codes are single use (a second use revokes the
  grant); refresh tokens rotate on every use (presenting a used one revokes the grant).
- **Credentials name their tenant in clear** (`vza1.<tenant>.<secret>`), so the server can find
  the tenant's object; that object holds only the credential's SHA-256, so a credential edited to
  name another tenant matches nothing. Because a forged one can name any string, a `Tenant` object
  nobody provisioned no longer creates storage when it is constructed: `provision` opens it.
- **A made-up credential reaches no object** (review of D44, M-2). The secret's 43 characters are
  a 27-character body and a 16-character tag, HMAC-SHA-256 under a key derived by HKDF from
  `OAUTH_CLIENT_KEY`, over the prefix, tenant and body. `/oauth/token`, `/oauth/revoke` and
  `OAuthIntrospection` check the tag in the Worker before any tenant's object is asked; a
  credential without it gets the answer an unknown one gets. The tag does not make a credential
  valid (the object's hash does). **Since the review of D70 (B-1) the body carries the
  credential's expiry** (layout 2: the marker `e`, the expiry in minutes, 22 random characters, about
  131 bits; layout 1, issued before, was 27 random characters), so the Worker also refuses a
  credential past its expiry before any rate limit counts it or any object is asked (D70). The shape
  and the tag are unchanged, so a release that knows only layout 1 still reads layout 2, and this
  release serves layout 1 credentials until they expire in the object. And a token request or revocation that changed nothing writes
  nothing: the alarm is re-armed only after a write (each `setAlarm` is billed as a row written).
  Measured here (local workerd, three runs of 300 sequential forged `/oauth/token` requests against
  a tenant with a live grant): 1.50–1.69 ms, one object call and two `setAlarm` each before;
  0.13–0.18 ms, none and none after. The entrypoint costs every `/mcp` request one service-binding
  hop: a live token's introspection took 1.76–2.42 ms through it against 0.90–1.62 ms on the object
  directly (measured here; not on Cloudflare).
- **Only a key approves, until people can be checked.** `Tenant.invoke` accepts only an identity
  with an API key, which it checks against its own keys whatever the caller says about it; an
  approver that is not a key is refused, and a grant recorded with one counts as ended (the check
  fails closed). An approver key's expiry is an alarm deadline.

**Alternatives.** (a) `@cloudflare/workers-oauth-provider` wrapping mcp's `fetch`: grants and
tokens in KV outside the tenant's object and its audit log, revocation bounded by KV
propagation, and it still leaves the downstream credential and the tenant-bound consent to
write. (b) Pass the client's token downstream and teach the query service, control and the ruler
to accept it: forbidden by the specification (token passthrough), and the token would work
outside its audience. (c) Keep the downstream key's secret in clear in SQLite, or encrypted under
one Worker secret: a dump of the object, or one secret, would yield working credentials for
every grant. (d) Store registrations at registration time: no tenant yet, so a global registry,
which is either a new Durable Object class (a lifecycle change, its own release) or KV writes
from unauthenticated requests. (e) Client ID Metadata Documents instead of registration: the
2026-07-28 revision prefers them and deprecates registration, but they need control to fetch
arbitrary client URLs (SSRF, caching); not built yet. (f) A pending grant stored at
`/oauth/authorize`: needs the tenant before anyone has authenticated. (g) Redirect automatically
from `/oauth/authorize`: open registration makes every redirect URI untrusted, so the server
would be an open redirector (OAuth 2.1 §7.12.2).

**Why.** The tenant's object already holds keys, the audit log and the rules for agents (D29);
grants there are tenant-scoped by construction, are revoked in one transaction with their key
and its KV record, and appear in the audit log. The backing key reuses what every downstream
service already enforces (scopes, tenancy, liveness) and keeps the token's audience to `/mcp`.
Sealing means neither a database dump nor a token without control yields the downstream
credential.

**Alternatives to the tag (review of D44, M-2).** (h) A record per known tenant in KV, checked
before the object: it stops names nobody provisioned, but not the attack the review measured,
forged credentials naming a real tenant, and a record published at approval may not have reached
the location of the code exchange that follows within seconds (KV propagation, and cached misses).
(i) A negative cache in KV: the same, plus writes driven by unauthenticated requests. (j) A
Workers Rate Limiting binding as the check: approximate and per Cloudflare location by its
documentation ("Requests can exceed your configured limit"; "Other Cloudflare locations maintain
separate counts"), and keyed by the only identifiers an unauthenticated request has (IP, which the
documentation advises against, or the tenant, which hands the attacker the limit); it bounds a
source's rate, not what reaches a tenant's object. Still wanted before public exposure, for the
Worker's own CPU (`control/README.md`, Known risks); built as one layer of D70, keyed after the tag.

**Cost of the tag.** Replacing `OAUTH_CLIENT_KEY` (D53, by a deploy told to) now also ends every
code and token: clients connect again and a person approves again, rather than only registering
again. One HMAC per token, revocation and introspection request in the Worker.

**Would change if.** A sign-in exists (then `/oauth/authorize` shows a consent page to a signed-in
person and redirects, and the approver check learns to follow a person); Client ID Metadata
Documents become what clients use (then they replace registration and its signing key); KV
propagation of a new key record is measured slow enough to break the first downstream call after
approval (then the resource retries, or control publishes the key earlier); sender-constrained
tokens (DPoP) become required; or a rotation of `OAUTH_CLIENT_KEY` must keep sessions (then the tag
key becomes a generated secret of its own, or control verifies tags under two keys).

*Amended 2026-11-19 after the review of D44, D52, D53 and D60 (`reviews/d44-d52-d53-d60.md`, M-1,
M-2, m-1 to m-3, m-5, m-6): the entrypoint, the tag, no writes on no change, key-only approvers.
The decision itself stands. Amended again the same day after the review of D70
(`reviews/d70-rate-limits.md`, B-1): the credential body's layout 2, carrying its expiry under the
tag; this replaces the text under which the body was 27 random characters. The decision stands.*

## D45. The ruler writes recorded samples through a named entrypoint of viz-ingest; the service binding is the credential

**Decision.** viz-ingest exports `RecordedSamples`, a `WorkerEntrypoint` with one method,
`write(tenant, batches)` (`contracts/ingest.ts`, `edge/src/recorded.ts`). Only a Worker whose
deployed config has a service binding naming that entrypoint can call it; the binding carries
`props: { caller: "viz-ruler" }`, which only that config sets, and any other caller is refused
(`unauthorized`). The tenant is the explicit first argument, which only a binding holder can
supply; it is validated (`TENANT_ID`) and every batch id must start with `<tenant>/`. The
samples go through Remote Write's own validation, routing and appends; the promise resolves
only when everything is durably appended, and rejects with a message that starts with a
refusal word otherwise; a call with any invalid sample writes nothing. The ruler's existing
`SINK` binding path uses it unchanged; its one-line binding is in `edge/README.md`, "Needed
changes".

**Alternatives.** (a) Remote Write over HTTP with a service key control issues (D39, today): a
stored key per Ruler object, issued, rotated, propagated through KV (a fresh key may not have
reached every location) and checked on every request. (b) A shared secret or HMAC in the RPC
arguments: a secret to store and rotate again. (c) The entrypoint without a `props` check: any
viz Worker given a binding to it could write any tenant's samples. (d) A status union as the
result, the house style for RPC: the deployed ruler treats a resolved `write` as written, so a
resolved refusal would fail open. (e) The tenant in `props`: bindings are static per Worker, and
the ruler serves every tenant.

**Why.** A service binding cannot be forged from outside the account, and a named entrypoint is
not reachable over HTTP at all, so the binding is a credential nobody has to store, rotate or
leak; `props` names the caller so a binding added for another purpose does not grant this. The
explicit, validated tenant is the same rule as `contracts/control.ts` (the caller derives it
from its own binding context). Rejecting on every failure matches `Sink.write` in
`contracts/rules.ts`, which the ruler already implements.

**Cost.** One more export on viz-ingest and one more caller list to keep. The accept window
applies as for Remote Write: samples of a tick more than an hour old are `invalid`. Measured on
Cloudflare in Trial 3 (`deploy/README.md`) through a probe Worker standing in for the ruler.

**Would change if.** The platform attests the calling script itself (then `props` is not
needed); another Worker needs to write derived series (it is added to
`RECORDED_SAMPLES_CALLERS`); or query gets the same kind of entrypoint (then the ruler needs no
stored key at all, the ruler's README "Needed changes" 1).

## D46. Release records carry each Durable Object class's schema versions, stamped on every version; a rollback judges every version since its target

**Decision.** `deploy/workers.json` names, for every Durable Object class a Worker defines, its
`SchemaSpec` or why it keeps no storage. `deploy/lib/schemas.mjs` reads the specs from the
sources (esbuild bundles just them; a Node `vm` evaluates the bundle with platform modules
stubbed; `contracts/schema.ts`'s own `schemaRelease` runs on them). Each class's `{latest,
compat}` goes into the release record and into **every version's `VIZ_SCHEMAS` var**. A
release is recorded forward-only when a class's `compat` is above what the version serving
before it declares (a version that declares nothing counts as knowing version 1), or when it
changes a class's lifecycle. `release.mjs rollback` lists every version Cloudflare keeps of the
target's Workers that is newer than the target's, reads their `VIZ_SCHEMAS`, and refuses,
naming the release and migration, when any of them ran a class the target cannot open
(`canOpen`). A record or a newer version without schema versions is refused, not guessed.

**Alternatives.** (a) Each component publishes a generated `schema.json`: a change in every
component, and a second copy of the spec to keep in step. (b) `/healthz` reports the schema:
needs the version running and a request to it, and says nothing about versions no longer
serving. (c) A high-water mark the deploy writes to KV or R2: extra state outside the versions,
KV's eventual consistency, and a rollback that restores old versions must still update it. (d)
The chain of CI release records: artifacts expire after 90 days and the job would download
many. (e) Judge only the version serving now: a forward-only release that was itself rolled
back would be missed (A → B → C with C raising `compat`, back to B, then to A passes, and A
cannot open what C migrated: `deploy/test/release.test.mjs`).

**Why.** A rollback can only reach a version Cloudflare still keeps, and every such version
carries what its code knows, so the data the check needs lives exactly as long as the rollback
is possible, with no store of its own. Judging every version since the target is the rule of
contracts/COMPATIBILITY.md §6 ("the newest release that ever ran since T"), made conservative
(uploaded versions that never served count too).

**Cost.** A deploy reads one version per Worker (it already did, for the release tag); a
rollback reads one version per Worker per version since its target (tens of API calls). A spec
module that does more than define values at load time breaks the read, loudly. Format versions
(queue messages, R2 objects, KV records) were not recorded here, so the tool did not refuse a
rollback below the reader of a format; since D69 they are recorded, in a var of their own
(`VIZ_FORMATS`), and it does, judging what each Worker it restores reads against what was written
since, also by the Workers it leaves serving (D69, as revised after its review).

**Would change if.** Format versions join the record (the same var can carry them); components
start publishing their specs in a form the deploy can read directly; or Cloudflare keeps
deployment metadata that makes listing versions unnecessary.

## D47. A ledger checkpoint larger than one part is written in parts across drains from the state at its version, kept by pre-images; a rebuild streams into SQLite

This replaces the size limit of D36 as the answer to review S-2 (D36's alternative (h)).

**Decision.** A checkpoint of a state above 1 MiB (estimated) is format 2: the drain only begins
it, in the synchronous step that fixes the segment ending at the committed version (a row with
that version, the streams and a new attempt name); later drain steps write parts of at most
1 MiB, one PUT each, files in SQLite's key order then tombstones, a segment always first; then a
manifest, `If-None-Match: *`, which alone makes the checkpoint exist. Every mutation committed
meanwhile records, in its own transaction, the pre-image of each file it adds or removes ahead of
the checkpoint's cursor, and advances a `tracked` version; a part merges live rows with
pre-images, so it is the state at the checkpoint's version, and a checkpoint whose `tracked` is
behind (a release without this code committed) is abandoned. Superseded checkpoints are deleted
only once the newer manifest is in R2, manifests before parts. A state of one part or less is
still written as one object (format 1). A rebuild loads a checkpoint part by part, a base line
element by element (`readLedgerLogStream`), into SQLite in transactions of a few hundred rows,
and a new incarnation's base is written from SQLite in pieces into one conditional PUT; nothing
holds the state. The size limit becomes the largest state measured (300 MiB, about 300,000
files), bounded by rebuild time, not memory. Format 1 is still read; migration 3 is additive.

**Alternatives.** (a) Keep the 16 MiB limit (D36). (b) A snapshot: copy the state into SQLite
tables at the checkpoint's version, then write it out across drains. (c) Rows that record the
version that added and removed them (soft deletion in `file`), read as of the checkpoint's
version. (d) The checkpoint as one object written with an R2 multipart upload across drains
(format 1 unchanged). (e) Build each checkpoint from the previous checkpoint and the segments
since, outside the object. (f) Write a format-2 checkpoint at every new incarnation as well, and
never read a base whole. (g) Format 2 for every state.

**Why.** (a) caps a tenant at about 15,800 files. (b) writes every row of the state again at
every checkpoint (billed row writes, seconds of copying in one step). (c) changes what a row of
`file` means, so every reader of it changes and the release becomes forward-only. Pre-images cost
row writes only for files changed ahead of the cursor while a checkpoint is being written, and
leave `file` as it is. (d) cannot be conditional (`If-None-Match` does not apply to a multipart
completion), needs parts of 5 MiB, and a rebuild would still parse one object. (e) needs a sorted
merge of the whole state outside SQLite. (f) doubles a start's writes; a streaming reader of the
base costs one parser instead and also reads format-1 checkpoints and older bases. (g) would
change, for every small tenant, the bytes the publisher's golden scenario pins, for no benefit:
a state of one part is one part either way.

**Measured** (here, workerd, the release before on the same data; `ledger/README.md`): at
100,000 files the longest step a caller waited for during a checkpoint fell from 0.93 s to 2 ms
and the process grew by 14 MB instead of 410 MB; a rebuild grew it by 12 MB instead of 196 MB
but took 5.4 s instead of 3.9 s; at 300,000 files a checkpoint was 272 parts in 9.3 s and a
rebuild took 20 s, memory flat. Not measured on Cloudflare.

**Cost of it.** About two row writes per file changed during a checkpoint window; a few hundred
PUTs per checkpoint instead of one (about $0.01 a day for a busy tenant, modelled); slower
rebuilds; one more table pair and a `tracked` write per mutation while a checkpoint runs. The
publisher still reads a new incarnation's base whole, so deployments keep the old limit until it
streams it.

**Would change if.** A rebuild of the largest tenants takes too long on Cloudflare (then keep
rebuild progress, or start a new incarnation from the old checkpoint); R2 offered conditional
multipart completion (then (d) is simpler); or row writes during checkpoints show on the bill
(then (c), forward-only).

## D48. A shard filters and pages its tail reads itself, by reading the batches it stores; the unpaged form stays

**Decision.** `Shard.tailRead` takes optional `TailReadOptions` (`v` 1): a time range, metric
names, exact label values and a range of `series_id` (unsigned, the engine's split key), a page
budget and a cursor. The shard decodes each stored `VZB1` batch above the watermark, keeps the
series and rows the filter keeps, and returns them as new `VZB1` batches (series entries and
values copied as bytes), at most `maxBytes` a page, with `page.next` bound to the tenant,
incarnation, watermark and filter, through the end fixed by the first page. A batch whose kept
rows do not fit a page is refused (`page_limit`), never cut. Without options the answer is as
before; an older shard ignores options, so `page` in the answer is how a caller knows.

**Alternatives.** (a) Filter at the coordinator (as `engine.splitTails` does now). (b) Per-batch
metadata (time bounds, metric names) written at append and used to skip whole batches. (c) A
second, filtered RPC method instead of options on `tailRead`. (d) Run the engine (WASM) in the
shard to select rows. (e) Page without filtering.

**Why.** (a) still moves the whole tail over RPC and counts it against the query's fetch budget:
the wall CARDINALITY.md measured (20 MB of tail refused every query of a 100,000-series tenant).
(b) skips little: a batch from one sender spans most metrics and every series key; it would add
work and a schema change to the append path, which is the shard's hot path. (c) is cleaner under
skew (an old shard fails the call instead of ignoring options) but asks every caller to change;
options plus `page` keep current callers working and are additive. (d) puts a second engine
instance and its memory in the object that acknowledges writes, for a filter that needs a byte
compare. (e) bounds the answer but not what a query must fetch.

**Measured** (here, workerd; `shard/README.md`): on a 22 MB tail of 100,000 series, one series
read 248 bytes, a selective query 0.7 MB and a split leaf of 8 2.8 MB, the engine selecting
identical samples from each; times were the same as reading the whole tail locally (30–140 ms),
because the shard still scans every batch.

**Cost of it.** The shard now reads inside stored batches (only on this read path; appends do
not). CPU per filtered read is proportional to the shard's whole tail for that tenant.

**Would change if.** Filtered reads show on the shard's CPU under load (then (b)); queries need
regular-expression matchers or `without` splits pushed down; or `query/` prefers failing on an
old shard to filtering itself (then (c)).

## D49. LogQL's vector operations run on viz-promql's evaluator, through its hooks

**Decision.** `engine/logql` computes LogQL's range aggregations itself, then prints the rest of
a metric query as PromQL whose leaves are placeholder selectors, and evaluates it with
`viz-promql` (`query_range_expr` / `query_instant_expr` with an `EvalHooks::replace` that
supplies the placeholders' values). Vector aggregations, binary operators with vector matching,
`label_replace` and `vector()` therefore have one implementation for both languages. The
translation applies the two LogQL rules that differ: a comparison between two scalars returns
0 or 1 without `bool`, and `label_replace`'s regular expression is translated to the Go dialect
(by `engine/goregex`, the translator every LogQL and TraceQL regex goes through, D40).

**Alternatives.** (a) A LogQL evaluator of its own for the vector layer. (b) One logical plan for
PromQL, TraceQL and LogQL that all three lower into (§6.1), with one executor.

**Why.** LogQL's documentation defines these operations as PromQL's; `viz-promql` is already
checked against the Prometheus corpus and a Prometheus differential, and the LogQL differential
run against Loki agrees with it except where Loki's own grouping of empty-valued labels creates
duplicate series (`engine/logql/README.md`). (a) would duplicate about a thousand lines of subtle
code (matching errors, compensated sums) and drift from it. (b) is the stated direction but does
not exist yet; the hook keeps LogQL's own part small enough to move onto it later. The cost is
that `viz-logql` links `promql-parser` (most of its 2.4 MB WASM module, none of it extra inside
`engine/wasm-query`, which links it already) and evaluates a printed query.

**Would change if.** Loki's vector semantics move away from PromQL's further than the translation
can absorb, `viz-promql`'s evaluator changes in a way LogQL must not follow, or the shared plan of
§6.1 is built.

## D50. Where Loki's documentation is silent, viz-logql follows Loki's observed behaviour

**Decision.** `engine/logql` is written clean-room from Loki's documentation (Loki is AGPL-3.0).
Where the documentation does not decide a behaviour (window edges, error-label wording and
precedence, parser corner cases, label-name sanitising, filter ordering, `rate_counter`'s
arithmetic, ties at the log limit), it reproduces what Loki v3.7.10 returns when run as a black
box, and records each finding (`engine/logql/README.md`, `CLEANROOM.md`). It departs only where
Loki contradicts its own documentation or is inconsistent: metric queries whose samples carry
parser errors fail even under `sum`, entries of merged streams are sorted by time, empty-valued
labels do not produce duplicate series, and ties are broken deterministically.

**Alternatives.** (a) Implement the documented behaviour only and leave the rest to judgement.
(b) Port Loki's code. (c) Follow the documentation and Prometheus' conventions where Loki's
differ from them.

**Why.** viz serves Loki's HTTP API so that Grafana and existing queries work unchanged; a
query that returns different lines or values than Loki is a bug to the people running it, and
the documentation leaves dozens of observable details open. (a) gave 41 differences on the first
generated differential run; following observed behaviour brought the run to zero unexplained
differences over 7,895 evaluations. (b) is ruled out by the licence. (c) would be cleaner where
Loki looks wrong (`rate_counter`) but surprises users comparing the two.

**Would change if.** A Loki release changes an observed behaviour (the differential run is pinned
to a tag and would show it), or viz decides a Loki behaviour is a bug worth diverging from; each
divergence is then listed in the README's "Differences from Loki".

## D51. Warm-ups and backtests are refused on a modelled CPU cost, checked before any window is read; they are not resumed across invocations

**Decision.** A Durable Object invocation (a request, or an alarm) may use 30 s of CPU by default
and 5 minutes at most (`limits.cpu_ms`); over it the object is reset, not refused
(`ruler/README.md` part 14 cites the documentation). So the ruler prices every warm-up and backtest
with a CPU model (`ruler/src/history.ts` `CPU`: µs per point read, by rule kind and, for robust_z
and seasonal, by the state they keep per series; per window; per run) calibrated in local workerd
at 1.5 times the largest measurement. Before any window is read (after the series counts of D43),
the run projects its whole cost: a counted window at the points its count gave, a window not
counted at every step holding the rule's bound (it fits one window per engine piece, so at most
tens of thousands of points), every window's allowance. That is an upper bound, so an allowed run
is never stopped part-way; over the budget it is refused with only the counts read. (The first
version projected before each window from the most series seen so far and could stop part-way.)
Budgets: 20 s for a backtest (its own request); 5 s per alarm
for all its warm-ups together, each reserving what is left before it reads. A warm-up over the
whole 5 s is refused and its rule starts cold; one that fits the whole but not what this alarm has
left waits for the next alarm (no attempt counted) and is then warmed whole there.

**Alternatives.** (a) Resumable runs: a cursor and the rule's state persisted after each bounded
slice, continued from later alarms, with progress and the final result through the API. (b) Run
them elsewhere (a Workflow or a separate Worker with its own limits) and hand the state back. (c) A
static up-front bound from the plan and the rule's series bound alone, before any read. (d) Raise
`limits.cpu_ms` to 5 minutes and keep runs unbounded. (e) Measure CPU at run time instead of
modelling it.

**Why.** (a) writes the run's whole state as rows at every slice (an SLO rule's rings are about
80 KB a series), needs a job lifecycle (progress, cancellation, results kept and expired) and a
second deadline in an object whose single alarm is the tick schedule, and competes with the live
ticks on one thread; the refusal covers every case measured at 100 series and names its remedy.
(b) moves the evaluation away from the code live ticks run, which the backtest/live equivalence
rests on. (c) prices every rule at its bound (1,000 series for an alerting rule) however few series
it has, refusing most backtests; the counts give the points instead (a short read, not counted, is
still priced at the bound). (d) only moves the cliff: a
1,000-series week of EWMA is about 50 s measured, and alarms share their time with ticks. (e) is
impossible inside workerd: its clocks do not advance during computation, so a run cannot see its
own CPU.

**Cost.** Useful runs are refused: a week of 1,000 series at 1 minute, and the warm-up of a daily
seasonal rule over 100 series at 5 minutes, at the defaults; and a short read of a rule with a
generous `max_series`, priced at that bound although its series are few. An over-budget long run
still reads its counts. The model's prices are calibrated on this machine under load, not on Cloudflare,
and its per-run and per-window allowances are not measured. A warm-up deferred to the next alarm
delays its rule's first evaluation by an interval.

**Would change if.** People need full-resolution backtests of thousands of series over weeks (then
(a) or (b)); viz-query's plan reports the series a read returns (then the check can refuse before
any read); Cloudflare's measured `cpuTime` for the same runs disagrees with the model by more than
its margin (then the prices change); or the platform exposes CPU time to the running code.

## D52. The ruler writes recorded samples through `RecordedSamples`, and falls back to Remote Write for one release when the entrypoint does not answer by its contract

**Decision.** The ruler binds viz-ingest's `RecordedSamples` entrypoint as `SINK` (`props: {
caller: "viz-ruler" }`, D45) and sends every recording-rule flush there with the Ruler object's
own tenant; no key goes with it (`ruler/src/recorded.ts`). It treats the answer as
`contracts/ingest.ts` says: `unauthorized`, `invalid` and `series_limit` are reported on the rules
at once, never retried; `too_large` splits the call by whole batches; `backpressure`, `overloaded`
and `unavailable` are retried inside the tick, after the hint in the message (at most 5 s, and
never past the group's budget). A rejection whose message starts with **no** refusal word means
the entrypoint did not answer by its contract (the viz-ingest release serving the call lacks it,
or the platform failed the call); then, and only then, the same batches go through Remote Write
over `INGEST` with the shard's service key, the path of the release before, and the Worker logs
that it did. `INGEST` stays bound for this purpose for one release. (That a word-less rejection
means only these was not true at first: with a shard marked hot, an unreadable pool map was
rejected bare. Since 2026-11-19 every error the entrypoint sees carries a word, an unexpected one
`unavailable`; review of D52, m-8, `edge/README.md`.)

**Alternatives.** (a) No fallback: a rejection without a refusal word is retried like
`unavailable` and, after three attempts, the tick's samples are dropped (counted). Promotion is
callee first (viz-ingest before viz-ruler) and rollback caller first, but both directions of skew
remain while a deployment propagates, and a rollback leaves Ruler objects on the newer code for up
to 30 s (deferred code updates) while viz-ingest is already back on a release without the
entrypoint (contracts/COMPATIBILITY.md §1); every recording rule due in that window would lose a
tick. (b) Fall back on any rejection: a refusal says the entrypoint exists and decided; sending
the same samples by Remote Write would bypass its whole-call validation (Remote Write keeps the
valid part of a request) and double the load on an overloaded shard. (c) Recognise the platform's
"missing entrypoint" error by its text: not documented, not measured on Cloudflare (workerd
refuses to start such a binding at all), so it would be a guess; the contract's refusal words are
the one thing that is promised. (d) Two releases, entrypoint first and the binding later, with
no fallback: still loses ticks on a rollback across the second release, and the entrypoint
already shipped with D45. (e) A flag var to switch sinks: vars belong to a version, so a rollback
restores the old value with the old code; it adds a step and no safety.

**Why.** Recorded samples have no outbox: they are sent inside the tick, and a tick that cannot
deliver them drops them, so a sink that fails during an ordinary rollback would put a gap in every
recorded series, which contracts/COMPATIBILITY.md exists to prevent. Re-sending is harmless on both
paths (one value per series and timestamp), so falling back costs nothing in correctness; the
service key it uses already exists for queries (D39) and already carries `write`. Falling back
only when the contract was not followed keeps every contract answer meaningful and keeps the key
out of steady-state writes.

**Cost.** One more code path for one release, and `INGEST` kept bound. In steady state no write
uses the key (tested); in a skew window each flush is one failed RPC plus one Remote Write.
Whether Cloudflare accepts a version whose binding names an entrypoint the serving callee lacks,
and what such a call returns, is **not measured**: the fallback does not depend on the answer,
but if the upload is refused, a release adding a new entrypoint and its first caller must ship
the entrypoint one release earlier (a stage trial settles it: deploy the previous ingest, upload
this ruler, run a recording rule).

**Would change if.** Every viz-ingest release that may run (the rollback floor and later) has
`RecordedSamples`: then the fallback and `INGEST` go (callee first, contracts/COMPATIBILITY.md
§4), and once query has its own entrypoint the ruler holds no key at all; or recorded samples get
an outbox (then a failed write waits instead of falling back).

## D53. The deploy generates control's OAuth client key once, on the version it uploads for a release, and never replaces it unless a deploy is told to

**Decision.** viz-control's Worker secret `OAUTH_CLIENT_KEY` (the HMAC key that signs OAuth
client registrations, D44) is made by the deploy, not by a person: 32 bytes from Node's CSPRNG,
base64url, handed to `wrangler versions secret put` on stdin (`deploy/lib/secrets.mjs`). It is
put only when the version a release would promote does not carry it. Where: right after phase 1
uploads viz-control, on that upload (checked to be the newest version, since the command patches
the newest one), so the keyed version is the release's own code and config and serves nothing
until phase 2 promotes it in place of the upload. A viz-control that goes out with `wrangler
deploy` (new, as on the first production deploy, or applying a Durable Object migration) gets it
on the version just deployed, and the keyed version is deployed before the next Worker. Every
later upload inherits it. It is replaced only by a deploy run with `VIZ_ROTATE_SECRETS=
OAUTH_CLIENT_KEY`. If the Worker has it now (a serving version, or a version
newer than every serving one, which a rollback across the release that created the key leaves
behind) but the upload does not carry it, the release is refused before anything is promoted
(exit 3) instead of generating a new one. Every wrangler run that gets a value on stdin runs with
`WRANGLER_LOG_SANITIZE=true` and `WRANGLER_WRITE_LOGS=false`, whatever the deploy's environment
says. The release record names each such secret and what was done (kept,
created, rotated), never a value. `release.mjs plan` says it would create the key and changes
nothing.

**Alternatives.** (a) `wrangler secret put` before phase 1: Cloudflare documents that it "creates
a new version of the Worker and deploys it immediately"; it deploys outside the release (the
serving code plus the key, a deployment no record names), wrangler 4.164.0 refuses it with code
10215 whenever the newest version is not the deployed one (a failed earlier run leaves one), and
on a Worker that does not exist (the first deploy) it creates a placeholder Worker `export
default { fetch() {} }` without asking in CI. (b) `wrangler secret put` after phase 2: a second
deployment of viz-control after promotion, so its Durable Objects move twice, the new release
serves for a while without the key, and the record names a version that no longer serves. (c)
`--secrets-file` on `versions upload` or `deploy`: one version with code and key, but the value
must come from a file (or `/dev/stdin`, platform-dependent) and "process environment values
override file values". (d) The operator sets it by hand once, as for the bootstrap token: easy
to forget, and the failure is a silent 503 on `/oauth/register`. (e) Declaring the secret as
required in control's wrangler config (Cloudflare documents that deploys then fail when it is
missing): a check, not provisioning, and it would fail the first `wrangler deploy` of viz-control,
since `versions secret put` needs a version to exist.

**Why.** Cloudflare says to use `wrangler versions secret put` "if using gradual deployments": it
"will only create a new version of the Worker, that can then be deployed using `wrangler versions
deploy`" (Workers docs, Secrets, read 2026-11-19). That is exactly the upload-then-promote flow:
nothing serves early, nothing but the release's code is promoted, a failure stops before phase 2,
the release record and `previous.json` name versions as they served, and a rollback restores
versions as for any release. Never generating over a key that exists is what keeps registered
clients valid; refusing when the evidence disagrees is the fail-closed reading of
contracts/COMPATIBILITY.md's promise.

**After the review (2026-11-19, `reviews/d44-d52-d53-d60.md`).** m-10: wrangler 4.164.0 writes
every log level to a debug log file unless `WRANGLER_WRITE_LOGS` is false and redacts request
bodies only while `WRANGLER_LOG_SANITIZE` is true; with sanitising off in the deploy's
environment, the key's PATCH body was in that file (reproduced with the real wrangler). Both are
now forced for runs with stdin, which is what "never in a file" needs. m-9: after a rollback across
the key's creation, an upload that did not inherit the key was given a new one, silently. Of
refusing the rollback or detecting it at the next deploy, detecting it was chosen: a rollback is
the incident tool and must not be blocked by a key, the next deploy has to look anyway, and the
evidence is cheap (one list call, and one read per version newer than the serving one, none
normally). The release then stops with exit 3 and names the version that carries the key; the
operator promotes that release again or replaces the key on purpose. m-11 (another run of the same
release uploading between the newest-version check and the put) is fixed with D69: every version a
run uploads carries `VIZ_DEPLOY_RUN`, unique to the run, and the keyed version must carry this run's
or nothing is promoted (exit 3).

**Measured on Cloudflare, 2026-11-19, S9** (`spikes/s9-oauth-key-rollback/`; the created case run
twice, the rotated case once). A rollback across the release that **created** the key is allowed (no
10220): the restored version serves without the key, because a secret belongs to each version, so
`/oauth/register` answers 503, the metadata drops `registration_endpoint` and every registered
client is refused at `/oauth/authorize` (by reading control's code, not measured: its codes and
tokens too), until the next deploy, which keeps the key because uploads inherit the **newest**
version's secrets (m-9's exit-3 branch never fired). A rollback across a **rotation** is refused by
Cloudflare (10220, "secrets have changed"); `release.mjs` then exited 1 after `restore()` would have
moved the callers first; forced through the API the old key serves until the next release takes
the rotated one back while its record says `kept`. A version read right after it was created was
not there yet in 2 of 16 reads (a 404, a version without the secret just put). The script's secret
list names the newest version's secrets, not the serving one's. What the tool does about each (D69,
`deploy/README.md`): a rollback across the creation is refused up front (exit 3, nothing moved)
unless `--accept-secret-loss OAUTH_CLIENT_KEY`; a rollback across a rotation is refused up front
always (wrangler's `versions deploy` cannot force it); a failed promotion leaves a viz-control whose
key it created or rotated where it is; a version just created is read again for up to 10 s; the
secret list is no longer read as evidence.

**Cost.** One to three more API reads (after a rollback, one more per version newer than the
serving one) and, on the release that creates or rotates the key, one more version of viz-control.
Measured on Cloudflare, 2026-11-19, S9: uploads inherit the newest version's secrets, whatever made
it (a `versions upload` or a `versions secret put`), not the deployed version's; a rollback to a
version without the key is allowed and leaves OAuth broken for every MCP client until the next
deploy, which is why the tool refuses it unless told to accept that; a rollback to a version with a
different value is refused by Cloudflare (10220), which is why the tool refuses it before moving
any Worker, and why a rotation cannot be undone by a rollback (only by leaving viz-control out of
the rollback, or by fixing forward). Rotation needs a deploy; there is no dispatch input for it yet.
The record's `kept` compares names, not values: it means "the newest version's value".

**Would change if.** Control verifies registrations under an old and a new key (then rotation can
be automatic and overlapping, and a rollback across one stops breaking clients); wrangler can upload
a version with secrets read from stdin (then code and key go in one version); wrangler's `versions
deploy` takes `force` (then a rollback across a rotation could be offered, with the warning that the
next release takes the rotated key back); or more generated secrets appear (they join
`GENERATED_SECRETS`, and one `versions secret bulk` replaces one put per secret). The two earlier
conditions were settled by S9: uploads do inherit the key (from the newest version), and a rollback
is refused with 10220 for a rotation but not for the creation.

## D54. The query coordinator reads each shard's tail filtered and paged under one byte budget for all shards; split parts read the rest in their key range, to an end fixed before the split, only when it does not fit

*Revised 2026-11-19 after the adversarial review of D54, D56 and D59
([`reviews/d54-d56-d59.md`](reviews/d54-d56-d59.md), M-1 to M-3, m-1 to m-3, m-7). This entry
replaces the earlier D54 of the same day, which gave each shard's read the whole budget, let
parts read "to the shard's end" when the coordinator's first page did not fit, cut a tail that
fit in the engine, and did not bound the parts that read the rest.*

**Decision.** Every tail read from `query/` passes the shard's `TailReadOptions` (D48): the hull
of the read's times, its metric names when every range pins one, and the label values every
range pins (the cardinality report sends no filter: it counts a tail series by the span of its
rows in each batch, which a time filter changes at the window's edges). Pages are followed to the
end under the read's byte budget (one place: `maxFetchBytes` minus the files; split execution,
label endpoints, the report: `maxFetchBytes`), and **that budget is one for all the shards of the
read** (`readShared`): the reads start in parallel, each under an equal share of what is left;
then, one at a time in shard-name order, each read that stopped at its share goes on with what
the others left. Held together they never pass the budget, and whether they fit never depends on
which shard answered first. A refusal on any page re-plans or fails exactly as on the first; a
page that does not advance the read, and a page asked for past the query's deadline, are refused
(503). **The coordinator reads first** and cuts what it read by split key **in JavaScript**
(`cutByKey`: bytes copied; the key is the `series_id`, or, for a series that carries a label the
key leaves out, the FNV-1a hash of its other labels, as the engine computes it), letting each
batch go as it is cut. When the tail fits, each part gets its cut. When it does not, and the
query decomposes over a split key the shards can cut (`without` at most `__type__`/`__unit__`),
the query is split (from one place too): the coordinator **fixes each shard's end** (from the
read's first page; when the first page did not fit, from the shard: `Shard.describe`, the
stream's last sequence number, after checking that its incarnation is the one read and that it
has not discarded above the read's watermark, else the query re-plans), and each part reads the
rest of each shard's tail after the last batch the coordinator read **through that end**, with
the filter and its key range, under its own `maxFetchBytes` (one budget over the shards, as
above; a batch past the end neither counts nor is kept, and ends the read). It cuts its rows by
split key and refuses the query if any belong to another part (a series carrying
`__type__`/`__unit__`). **At most `maxTailReadParts` (16) parts** may read rests; past it the
query is refused (422, naming the limit). A part over its byte cap makes the split **run again
once** with `k` times as many parts (`k` ≥ 2, so the new key ranges nest in the old and the
coordinator's cut is cut again, within `maxLeaves`, the pool and `maxTailReadParts`), else the
query is refused (422). A query that cannot be split is refused with `max_fetch_bytes`. A shard of
the previous release answers with its whole tail: the coordinator uses it as before; a part (the
shard rolled back after the coordinator's read) applies the shard's own filter, key range
included, to that answer, so only its rows count. A leaf of the previous release, which ignores
the rest it is given, is refused (503). The span and log tail reads (D62) go through the same
reads: one budget over the signal's shards, resumed in the second round with the signal's
filter, and the same per-page checks. They are never split, so a span or log tail that does not
fit is refused at once (422), and no end is learned for it: the end exists only for the parts.

**Alternatives.** (a) Every split part always reads its own key range (shard/README.md "Needed
changes" 2): no coordinator cap on the tail at all. (b) The coordinator always reads the whole
tail and cuts it (before: refused above 16 MiB, and a shard's answer above 32 MiB cannot cross
RPC at all). (c) When the tail does not fit, parts re-read it from the watermark and the
coordinator drops what it read. (d) Cut in the engine (`splitTails`), as the first D54 did for a
tail that fits; or only below a measured threshold. (e) A size probe (`describe`) before every
read. (f) Learn the end from `page_limit` carrying `through` (additive in `v` 1) instead of a
`describe` call. (g) Each part says the end it read to and the coordinator refuses (503) when
they differ. (h) One budget split evenly over the shards (`cap / S` each). (i) Bound the shard's
work by running the parts' rests one shard call at a time, or by having the shard serve a key
range without scanning every batch.

**Why.** A filtered read costs the shard a scan of its whole tail per call (D48, "Cost of it"),
and the shard is the object that acknowledges writes: (a) makes every split query scan each
shard's tail `L` times where one scan serves a tail that fits, and leaves the coordinator without
the tail's size to choose `L`. (b) is the wall CARDINALITY.md measured. (c) scans and moves the
coordinator's part twice. (d) held 6.2 to 6.4 times the tail in coordinator WASM memory
(measured here, local workerd: 132.6 MiB for 21 MiB of 100,000 series; 31.63 MiB for 5.09 MiB
of 20,000 and **98.06 MiB for 15.28 MiB of 60,000**, just under the cap, on the path kept as
the safe one); the JavaScript cut is exact for every split key (tested against the engine's) and
held the coordinator at 1.63 MiB of WASM for both, with the same answers, in a third to a half less
time locally
(`query/README.md`, "Measurements"), so a threshold buys nothing. (e) costs a call
before every read; `describe` is called only when a first page did not fit. (f) changes the
shard's answer, and a shard of the previous release would not carry it, so the call is needed
during a deploy anyway; `describe` is a method of both releases. (g) fails queries that a fixed
end answers. (h) calls a tail "over" when one shard holds most of it at a fraction of the cap.
(i) does not lower the scanning: every stored batch spans the whole key space (one sender's
scrape covers all its series), so no per-batch bound skips one for a key range. Without a fixed
end, parts read different appends and a query answered a value no state held (review M-1: 110
where the store held 80, then 120); without one budget the coordinator held 1.7 to 1.9 times its
cap and a part 1.7 times its own (M-2); a split sized from a read that saw no page was refused
(m-3). Measured here (local workerd, load 7.6 to 9.3; `query/README.md`, "Measurements"): with
21 MiB unflushed, the previous release refused every call (`max_fetch_bytes`); with the cap raised
it answered the one-series query in 267 ms and this release in 149 ms with identical bodies,
reading 0.002 MiB of tail instead of 21; with 68 MiB unflushed (one scrape per request), every call
of the previous release failed (an RPC answer over 32 MiB) and this release answered all but the
label calls.

**Cost of it.** A split whose tail does not fit asks each shard once from the coordinator (plus a
`describe` when its first page did not fit, and a second round of pages when it stopped at its
share) and once per part, and each part's read is a scan of the shard's tail for the tenant from
where it starts: up to `1 + maxTailReadParts` scans of a shard per query, on the object that
acknowledges writes; a re-split counts its parts against the same bound, and D59's rerun reads the
rests again (twice the parts' scans). Measured here (local workerd, load 2.0 to 2.6): one part's
read scanned the shard's whole tail for the tenant at 390 to 815 MiB/s, 12 to 30 ms at 10.6 MiB a
shard and 45 to 69 ms at 34 MiB (two calls of at most 32 MiB, between which appends run); at the
bound, 17 scans of a 34 MiB shard tail are 0.8 to 1.2 s of the shard's thread for one query (it
was 1.5 to 2.3 s at 32 parts). On Cloudflare not measured. A tail whose series carry `__type__` or `__unit__` and does not fit is refused, not
answered. Rows outside the query's ranges travel to the parts (the shard's filter is a superset)
and are dropped there. The tail's series are estimated from the pages read.

**Would change if.** Shards skip batches without scanning them (per-batch metadata, D48 (b): then
(a) costs little and the coordinator need not read first); append latency and refusals measured
on Cloudflare while split queries read a 20 to 50 MiB tail at 8 and 16 parts (the experiment the
review names) show `maxTailReadParts` too loose or too tight; the split key stops leaving out
`__type__`/`__unit__` for series that carry them, or shards can cut by a key that leaves labels
out; or the tail contract moves into `contracts/` with an end in `page_limit` (then (f)).

## D55. The publisher re-bases a tenant from its newest checkpoint, else its base, streamed into SQLite; a re-base that cannot be read whole publishes nothing

**Decision.** When the publisher meets a ledger incarnation it has no cursor in (a new tenant, a
new incarnation after a ledger storage loss, the publisher's own storage loss), it starts from
the newest checkpoint of that incarnation whose format it reads (1: one object; 2: a manifest
and parts), else from the base at the head of the incarnation's first segment, then reads the
segments after it as before. Nothing holds the state: a base line or a format-1 checkpoint is
parsed element by element (`readLedgerLogStream`), parts are read in order with at most four
requested ahead, and every R2 operation of a publish takes one of six shared slots (a GET until
its body has been read). Files and tombstones go into a SQLite table, `stage` (publisher storage
migration 3, additive); the changes read after the starting point are applied to it; the commit
takes what the tenant adds and removes as `stage` against `live`, in SQL, and writes manifests a
page at a time, two at once. A resync from R2 fills `live_next` a manifest at a time and swaps it
in in one transaction. Each part is checked against its key and its manifest (tenant,
incarnation, version, attempt, part number, record count), records must be in strictly
ascending key order across parts, and the parts must add up to the manifest's files, tombstones
and bytes. Any disagreement stops the tenant (`corrupt`), and so does a part that is not there
(`incomplete`). Neither publishes anything of the checkpoint, and the alarm retries. A
checkpoint of a format this code does not read is passed over for the base. The tombstones a
checkpoint or base carries are recorded as removed by the commit's snapshot, so files a
checkpoint skipped are released, and only once no snapshot that could reference them is
retained. With this, production lifts the 16 MiB state pin (`stack/wrangler.jsonc`) to the
ledger's 300 MiB.

**Alternatives.** (a) Keep reading the base whole, with the 16 MiB pin (D47's interim). (b) Stream
the base only and never read checkpoints (the change `ledger/README.md` asked for). (c) A new
incarnation writes a format-2 checkpoint at start, so a re-base reads parts only (D47's (f)).
(d) Diff by merging the key-ordered input against `live` read in key order, with no staging.
(e) On a missing or mismatched part, fall back to the base in the same publish, as the ledger's
rebuild passes over a bad checkpoint. (f) Keep the published keys of the tenant in memory and
stream only the files.

**Why.** (a) caps a tenant at about 15,800 files. (b) bounds memory on its own, and is what a
re-base right after a ledger storage loss does here (a new incarnation has no checkpoint before
its 256th segment); reading the newest checkpoint is added so that a publisher that re-bases
late, or after losing its own storage, does not read every segment since the base, and because
the base is one object of about 250 MB at the limit while parts are 1 MiB reads, a few at a
time. Measured here at 300,000 files: a re-base took 8.0–8.5 s from parts, 9.6–13.4 s from the base
and about 17 s from a format-1 checkpoint of the same state, all with identical output.
(c) doubles a start's writes in the ledger, which owns that choice. (d) needs its input in key
order: parts are, a base is not promised to be (the contract says nothing of `added`'s order),
and the changes after the start must be merged in as well. (e) would hide a corrupt checkpoint,
which should be seen, and turns a missing part, which a retry heals once the newer checkpoint
is listed, into a read of the whole base; it is kept as what would change. (f) is memory in
proportion to the tenant: 300,000 keys of about 130 characters are tens of MB of the 128 MB.

**Measured** (here, local workerd, `publisher/bench/`, 2026-11-19, load average 7–9; not on
Cloudflare): at 300,000 S4-shaped files (an estimated state of 299 MiB), a first publication, a
re-base onto a new incarnation, a publish from the cursor and a resync from R2 all completed
with V8's old space capped at 32 MB (plus 12 MB of young generation; the test runner shares that
heap), from parts, from the base and from a format-1 checkpoint, with byte-identical Iceberg
output; at 24 MB the first publication ran out of heap. Two of the tuning steps that got it
there: manifest entries built as the Avro encoder reaches them, and a resync decoding manifests
record by record (each was out of heap at 48 MB before). The publisher before this change, on
the same data, needed more than 48 MB at 32,000 files and more than 128 MB at 100,000, and grew
the process by up to 226 MB there.

**Cost of it.** A re-base writes every file of the tenant to `stage` and deletes it after
(about two row writes per file, 600,000 at the limit: modelled at about $0.60 per re-base at
$1 per million rows written, a price from training knowledge); a first publication also writes
each added file's statistics into its row once. Re-bases are slower than holding the state in
memory: at 100,000 files 2.3 s from parts against 1.0 s for the publisher before (which could
not reach 300,000 in an isolate), and a first publication of 300,000 files took 27–38 s. The commit writes two
manifests at a time instead of four. A corrupt checkpoint stops that tenant's re-base until the
ledger writes a newer one or an operator removes it. The publisher becomes a reader of the
checkpoint format, which `contracts/LEDGER-LOG.md` says only the ledger reads; a newer format
is passed over, so the ledger still needs no readers-first release to change it.

**Would change if.** A re-base or first publication of the largest tenants exceeds the
publisher's CPU limit on Cloudflare (then progress kept across invocations, or a higher
`limits.cpu_ms`); corrupt checkpoints appear in practice (then (e)); the contract orders a base's
files by key (then (d), no staging); or the manifest gains per-part sizes or digests (then each
part is checked on its own as it arrives, not only the totals at the end).

## D56. The label endpoints are counted over leaves by ranges of `series_id`, each part listing its files in waves and counting distinct series by id

**Decision.** `/labels`, `/label/<name>/values` and `/series` run in one place while the series
files their window needs fit `maxFetchBytes` and the tail fits the coordinator (D54). Otherwise
they are counted over `L` parts, as the cardinality report is (D32): part `j` lists the series
whose `series_id` is in its key range, reading its row groups of every series file (from the
fragments) in waves of at most half of `maxFetchBytes`, one engine call a wave, and its part of
the tail. The engine returns, with each listing, the ids of the series it listed, so a series in
many files counts once; the coordinator merges the parts' lists in the engine's order (UTF-8
byte order) and adds their counts against `maxMetadataSeries`. The answer is byte-identical to
one place. `L` is the series in the files over `cardinalitySplitAboveSeries`, at least 2.
Prometheus' `limit` is applied to the merged list (the first `limit`, and its warning).

**Alternatives.** (a) Each part reads its row groups in one engine call under a per-part byte
cap. (b) A listing session kept in the engine (files added one by one, like a split leaf's
gathering session). (c) Raise the cap for label calls and stay in one place. (d) Parts by file
(each part some of the files): a series would be counted by several parts. (e) Cut each part's
listing at `limit` in the engine.

**Why.** A series file of under 100,000 series is one row group (D41), so (a) gives every part
every file whole, and its cap refuses exactly where one place did (measured here: 190,000 series
over an hour are 72 files and 18.71 MiB, each read whole by each of 4 parts). Waves bound what a
part holds whatever the window. (b) is the same bound with more engine code and a session that
dies with the instance; returning ids is a few lines. (c) is what the isolate cannot hold: one
place held 61 to 64 MiB of WASM for these calls with 18.71 MiB read (local workerd). (d) cannot
count distinct series without shipping them. (e) changes nothing the cap protects (the part's
whole listing is still built) and is not exact for `/series` without a merge by label set.

**Cost of it.** `L` parts read every series file of under 100,000 series `L` times (74.8 MiB for
18.7 MiB at 4 parts; Cache API hits after the first) and decode its `series_id` column; locally
the calls took 2 to 2.6 times one place with its cap raised (load 8 to 11). A part's ids live in
its memory (8 bytes and a set entry per series of the part).

**Would change if.** Series files are cut into more row groups by `series_id` (then each part
reads its own range: `partPlan` already plans it); the metadata calls get an index of their own
(label values per metric, written at flush); or Prometheus clients come to depend on `limit`
shortening the work, not only the answer (then (e)).

## D57. Spans and log records are `VZB1` signals 2 and 3, canonicalised by edge, appended to shards of their own (`{pool}/traces`, `{pool}/logs`)

**Decision.** A span batch and a log-record batch have the metrics header (magic, signal 2 or
3, `n_rows`, and the size of an entry table at offset 12), an entry table (resource and
instrumentation scope for spans; stream labels and `stream_id` for logs), fixed-width columns,
and variable-length columns as offsets plus data, every column 8-aligned
(`contracts/BATCH.md`). `edge` canonicalises before encoding: attributes typed, sorted by UTF-8
key with the last duplicate kept, arrays, key-value lists and bytes as canonical OTLP JSON,
event and link attributes as canonical OTLP JSON lists; so the flush encoder copies bytes and
both sides test against one strict format. The batches go to shards of their own: for a
tenant with pool map `{pool, slots, spread, epoch}`, spans to pool `{pool}/traces` and log
records to `{pool}/logs`, same slots, spread and epoch, routed by the sender key as metrics are,
so one sender's three signals take the same slot number. As built, `edge` appends only when
`INGEST_SIGNALS` names the signal; no flush drains those shards yet (stage 2).

**Alternatives.** (a) One stream for every signal: a shard stream holds metrics, spans and logs,
and flush splits a segment by signal. (b) A signal in the shard's stream key (a shard schema
change, and a new field in the ledger's stream identity, object keys and the orphan sweep).
(c) Another batch format: OTLP protobuf stored as received and decoded at flush, or Arrow IPC.
(d) Row-oriented records instead of columns. (e) Canonicalise in the flush encoder instead of
`edge`.

**Why.** (a) puts log bytes in every metrics tail read (the shard reads each stored payload of
the range it filters, D48; its filter throws on a batch that is not metrics, so every metrics
query would fail once a log batch was stored), and lets log volume set when a stream seals, so
metrics files would shrink to the logs' cadence. (b) gives the same separation, but changes
the shard's storage and every component that names a stream; with derived pools the shard
name already separates the streams, and everything is keyed by shard name. (c) OTLP bytes
stored as received leave validation to flush, which runs after the acknowledgement, so a
refusal could no longer reach the sender as `partial_success`; Arrow IPC adds a dependency to
`edge` and the engine for a format the shard never reads. (d) Columns are what signal 1 is and
what a shard-side tail filter (D48) would read for logs. (e) would make the Rust encoder parse
OTLP values and produce ECMAScript number text; `edge` has both already.

**Cost.** Up to three shard streams per tenant in each ledger's watermarks (only for tenants
that send spans or logs), and a base pool name at most 113 characters that does not end in
`/traces` or `/logs` (the second rule added 2026-11-19, stage 3: a metric shard of such a pool
would be the same object, under the same name, as another pool's span or log shard; edge refuses
the map, `contracts/BATCH.md`). Query, flush and the
sweeper must know the derived pools (`edge/README.md`, "Needed changes"). Measured here (Node,
load 8 to 9, not workerd): `edge` decodes and batches OTLP traces in 16 to 22 µs a span, OTLP
logs in 10 to 19 µs a record, Loki push in 3 to 5 µs an entry; `engine/storage` encodes a million
spans in 4.9 s (95.5 MB of Parquet) and a million log lines in 1.9 s (58.6 MB)
(`engine/storage/README.md`, "Spans and logs").

**Would change if.** The shard gains a signal-aware stream key for another reason (then the
pools fold back into one); a logs tail filter needs streams metered (log batches would then
carry `seriesIds` = stream ids against a stream limit); or idle per-signal shard objects or the
larger watermark lists are measured to cost more than the separation saves.

## D58. OTLP logs take Loki's documented default stream labels without `k8s.pod.name` and `service.instance.id`; everything else is structured metadata

**Decision.** For OTLP logs, the stream labels are the resource attributes `service.name`,
`service.namespace`, `deployment.environment.name`, `cloud.region`, `cloud.availability_zone`,
`k8s.cluster.name`, `k8s.namespace.name`, `k8s.container.name`, `container.name`,
`k8s.replicaset.name`, `k8s.deployment.name`, `k8s.statefulset.name`, `k8s.daemonset.name`,
`k8s.cronjob.name` and `k8s.job.name`, names mapped `[^A-Za-z0-9_]` to `_`, plus
`service_name="unknown_service"` when there is no service name. Every other resource attribute,
every scope attribute and every record attribute is structured metadata, key-value lists
flattened with `_`, colliding names joined with `;`, the more specific level winning. A record
with neither `time_unix_nano` nor `observed_time_unix_nano` is refused (`contracts/LOGS.md` §1).

**Alternatives.** (a) Every resource attribute a stream label (the proposed `LOGS.md`). (b)
Loki's full documented default list, with `k8s.pod.name` and `service.instance.id`. (c) Only
`service.name`. (d) A per-tenant choice (not built; it is the obvious next step). For the
timestamp: (e) the time of ingestion, as Loki does.

**Why.** (a) makes a stream of every process (`process.pid`, `host.id`, command lines), refuses
resources with more than 32 attributes, and streams are what the sort order, the index
fragment's stream list (at most 256 a file) and the shard's stream count grow with. (b) Loki's
documentation (read 2026-11-19) itself recommends new users move pod name and instance id to
structured metadata for cardinality; without them a stream has at most 16 OTLP labels, inside
Loki's default limit of 15 plus `service_name`. (c) loses the selectors operators use first
(`{k8s_namespace_name=…}`, `{deployment_environment_name=…}`). (e) makes a retried request a
new set of rows (a new timestamp each time), which the row key `(stream_id, ts, line,
metadata)` cannot recognise.

**Would change if.** The per-tenant setting is built (this list becomes its default); users
mostly select by pod (then (b)); or Loki's documented default changes.

## D59. Split parts read their `series_id` range of the series files too, and the split runs again with whole series files if any part sees a series whose key is not its id, or cannot say

*Revised 2026-11-19 after the adversarial review of D54, D56 and D59
([`reviews/d54-d56-d59.md`](reviews/d54-d56-d59.md), B-1, reproduced): the earlier text took a
reader's answer without `foreign` as "none", so during a deploy a split answered 200 without a
series. This entry replaces it.*

**Decision.** When a split's key is the `series_id` of every series that carries no
`__type__`/`__unit__` (D54's "the shards can cut"), its readers read the series files by the
part's id range (`part_plan`), as they read the sample files (D41). Every reader of this release
counts the series it sees whose id is in its range but whose key is another part's (`foreign`,
ABI 5) and always answers the count. A reader's answer without it (a reader of the previous
release, which ignores the request and reads by name and time) makes its split leaf's count
unknown (`foreignUnknown`), and a split leaf's statistics without a known count (a split leaf of
the previous release) are unknown too. If any part saw a foreign series **or cannot say**, the
coordinator drops the answers and runs the split again with the series files read by name and
time.

**Alternatives.** (a) Keep reading series files by name and time (every part reads every
series file). (b) Read by id range only when the key leaves nothing out (`without` empty), where
no series can be foreign: almost never for a `rate` under an aggregation, which leaves out
`__type__`/`__unit__`. (c) Read by id range and ignore the check, as no ingest path adds
`__type__` today. (d) Each part asks its neighbours for its strays. (e) Take a missing count as
0 (the earlier text): an old reader's own part is whole, and it was assumed to vouch for nothing
else.

**Why (measured here, native, `engine/query/examples/series_ranges.rs`, load 8 to 9).** At
1,000,000 series over 32 parts (a series file of ten row groups) the parts read 640.7 MiB of
series files and spent 36.4 s of reader CPU by name and time, 82.5 MiB and 9.9 s by id range,
with identical extracts; at 100,000 series (one row group a file) nothing changed, so (a) only
costs where splits are already expensive. (c) answers wrong for a tenant whose clients send
`__type__` (a part misses its own series whose id lies elsewhere: shown in
`tests/series_ranges.rs`, and in the query suite, `query/test/review-d54.test.ts` m-4, where
answering from the first run gives 2.40 for 9.07). The check is exact when every reader
reports: a series a part misses is seen by the reader of the part its id is in. (e) breaks that
during every deploy and rollback (contracts/COMPATIBILITY.md §1): the old reader of the id's part
is the only one that sees the series, and its silence was read as "none" (review B-1:
reproduced, 200 with 2.40 for 9.07); unknown fails closed. (d) is a second round of calls for a
case that is rare.

**Cost of it.** A split over series that carry `__type__`/`__unit__` reads twice (once by id
range, then whole); so does every split by id range while a reader or split leaf of the previous
release serves a part (during a deploy). Readers parse the labels of the series they see either
way.

**Would change if.** The split key stops leaving out `__type__`/`__unit__` (then nothing is
foreign), or series files are written per part (then the check is moot).

## D60. Robust z and seasonal windows are stored as Float64 values in ring blocks on the interval grid; readers first: this release reads the format and writes the old one, and writing it turns on in the release after one with this reader has been deployed to production

(Written 2026-11-19. **This replaces the first version of D60** of the same day, which shipped the
format's writer on together with its reader; the owner chose readers first, as
contracts/COMPATIBILITY.md §3.3 asks.)

**Decision.** `store.anomaly-state` version 2 (`ruler/src/anomalystore.ts`) keeps the state of a
robust z or seasonal anomaly rule, in the same `anomaly_state` rows, as a head (every series' labels,
last outcome and the detector's scalars) and blocks of 60 slots on the rule's interval grid holding
every series' values there as little-endian Float64 in base64, NaN where a slot holds no point.
Timestamps are implicit (slot n is the grid's phase + n · interval); a robust z point off the grid,
and a series with less than half a block of points, are written as explicit (time, value) pairs. A
tick writes the head and the block its points fall in; a block no series needs any more is deleted,
or rewritten without the series that left it. The head lists the blocks the rows hold (ranges of
block numbers) and how many series entries they hold in all; a block row missing or extra, or one
holding fewer or more entries, is refused when read (`state_unreadable`, rows kept), never read as
a smaller window (added after the review of D60, m-12, before any release wrote version 2, so the
format is still version 2). **Readers first**: this release reads versions 1 and 2
(`ANOMALY_STATE_READS`) and writes version 1; the version gate `ANOMALY_STATE_WRITE` in
`ruler/src/schema.ts` is 1, and `FORMATS['store.anomaly-state']` follows it. **Writing version 2
turns on in the release after one with this reader has been deployed to production**, by setting
that constant to 2 (a code change, so it goes out as a release, never mid-release). That release
rewrites a rule's version 1 rows as version 2 at its next tick; its save-time estimates, and so the
series caps, follow the gate (a default robust z rule: 18 series now, 55 then). EWMA, threshold and
CUSUM stay version 1. The CPU and memory models of warm-ups and backtests price the window by its
JSON size, against which they were calibrated, whatever is written.

**Alternatives.** (a) Keep JSON (version 1). (b) Float32 values: half the bytes, but scores and
explanations change. (c) Raw Float64 in a BLOB column or a new table: 8 bytes a slot instead of
10.7, but a schema change older releases cannot follow without a forward-only migration, and the
shard-move bundle (`GroupBundle.anomalyState`, strings) would change type. (d) One row per series and
block: row writes are billed, 100 a tick at 100 series. (e) Explicit timestamps always: 16 bytes a
point. (f) Compressed JSON: sizes that depend on the values, and CPU at every tick. (g) The whole
state in binary, rewritten every tick. (h) Forward-only with a schema migration (`readableFrom` its
own version). (i) Reader and writer in one release, the gate on (the first version of this
decision). (j) The gate as a Worker var rather than a constant.

**Why.** The window was the cost: about 37 bytes a point as JSON, 39.7 at the longest number
encoding, so the window was set by the storage (1,500 points, D33) and a default rule holds 18
series; every tick serialises and rewrites all of it. Float64 keeps the scores bit for bit, which (b)
does not; with base64 the size is 10.7 bytes a slot whatever the values, so the save-time estimate is
the stored size up to labels and explanations. Blocks on the interval grid make timestamps free and
the per-tick write one block for every series, the SLO rings' layout (D42), which (d) and (g) are
not. (c) would save a quarter of the bytes for a migration and a contract change; base64 inside the
existing JSON body keeps the table, the column and the bundle. (h) raises the rollback floor of the
whole ruler for one format. (i) breaks §3.3: the release before reads only version 1, so a rollback
to it would leave rewritten rules unscored until rolled forward, and the release record, which does
not carry format versions (D46), would not refuse that rollback (since D69 it carries them and
does). Readers first costs one release,
and nothing is deployed to production yet. (j) would let one deployment flip it without a release,
which is exactly the step §3.3 orders; a constant ships in a release, with the release's tests. Measured
here (workerd, 1,500 points, `ruler/README.md` part 8), what the writer brings: 48.8 KB a series as
JSON against 17.8 KB as blocks; bytes written a tick 879 KB → 12.7 KB at 18 series, 4.9 MB → 70 KB at
100; rows a tick 2 → 2 at 18 series, 10 → 2 at 100; CPU a tick 15 → 9 ms at 18 series, 92 → 43 ms at
100. Scores, alerts and state are the same as with JSON over the anomaly fixtures and a long random
sequence with gaps, evictions and replays, and the ruler's whole suite passes with the gate in either
position (tested).

**Cost.** One release in which the reader is shipped and unused but for a rollback, and the caps stay
JSON's (18 series a default rule). Version 2's reader is tested against rows this code writes with
the gate on, not against a deployed next release. Once the gate is on: a rollback below this release
(to one without the reader) leaves rewritten rules `state_unreadable` until rolled forward (since D69 the
release tooling refuses that rollback); the head (labels and last outcomes of every series) is
still rewritten every tick, 13 KB at 18 series and 70 KB at 100; a third row about once an hour when
a block leaves the window; base64 costs a third more than raw Float64; a seasonal series with few
points in a block costs a full block; more series a rule means more of them start cold (the warm-up
budget still warms about 9 at the default window, D51).

**Would change if.** The release record carries format versions (then the rollback tool can refuse a
rollback below the reader, and the gate can be checked by it); heads grow large enough to matter
(then labels move to a row of their own, written when the series set changes); or a detector's state
stops being a window of values on the grid.

## D61. Registration before writes: a shard accepts a new stream only once its registration is LOGGED, derived by the ledger from its outbox; registration runs in the background; reads and the janitor re-register a lost stream

**Decision.** Variant R2 of spec/README.md "Proposed fixes", with the F16 fix and the changes
of the adversarial review (`design/reviews/registration-before-writes.md`, verdict "build R2
with changes"). A shard in registration mode `logged` accepts no write to a NEW stream (first
use, or after it lost its storage) until the tenant's ledger answers its registration as
logged (`RegisterResult.logged`); a stream that already holds acknowledged rows keeps
accepting while it is confirmed. The ledger DERIVES `logged`, and each stream's
`loggedIncarnation`, at call time from its outbox (a committed registration is logged exactly
when no pending `register_stream` change names it), never from a stored flag (B-1). An append
to an unconfirmed new stream is refused at once, `backpressure` scope `registering` with
`Retry-After` 0.5–1 s, nothing stored or held; the registration runs in the background, one
call per stream at a time, at most four per shard, retried with backoff from the shard's one
alarm (M-1). Edge answers `registering` 503 with `Retry-After`, never 429 (M-2; edge's
change is its owner's, `shard/README.md` "Needed changes elsewhere"). A tail read naming an
incarnation the shard lost starts a fresh, newer stream, registers it and names it, so a query
can finish (F6 liveness). The janitor asks a stream's shard (`ensureStream`) when its flush
files wait for a unit, and counts a newer incarnation's files dead only once its registration
is logged (F16, F15 kept). Mode `lazy` (the default) is the append path as before; production
turns `logged` on with the Worker var `SHARD_REGISTRATION` in a second release, once every
edge maps the new scope.

**Alternatives.** R1: the registration committed (not logged) before the first write. R3:
logged before writes, and the coordinator settles a lost incarnation by taking its tail as
empty. R4: committed before writes, and the coordinator re-reads the ledger after its tail
reads when it read a shard the plan did not name. Within R2: a `logged_inc` column the ledger
maintains (the plan before the review); an append that awaits the ledger before refusing (the
plan before the review); turning `logged` on in the same release as edge's mapping.

**Why.** R1 fails: a ledger rebuild rolls a committed registration back and F6(b) returns
(the model's `R1_safety`, I4 in 15 steps; reproduced against the code in
`flush/test/registration.test.ts` by its own mutant). R3 changes the coordinator (another
component, being edited), leaves every query of a tenant refused once per plan while the
ledger names a lost incarnation, and still needs `ensureStream` for F16. R4 re-reads only
shards it read without a watermark, so a shard that has left the pool after a map change is
never read and a rolled-back registration hides its rows; closing that is a ledger round trip
on every query. R2 pays only when a stream is new, and one mechanism (the shard registering a
fresh incarnation) serves appends, reads and the janitor. A stored `logged_inc` is maintained
only by the new release, so a rollback and roll-forward leaves streams refused for ever (B-1;
its mutant is killed by the rollback test in `ledger/test/registration.test.ts`); deriving it
costs one outbox read, which holds a drain cycle of rows. Awaiting the ledger on the append
path holds payloads outside D37's bound or fills it, so one tenant's slow ledger blocks the
shard's other tenants (M-1; its mutant is killed by `shard/test/registration.test.ts`). All
five components are one Worker whose Durable Objects take new code up to 30 s late, so the
shard may send the new scope only once every edge that can run maps it: two releases
(COMPATIBILITY.md §3.3).

**Measured** (here, local workerd, load average 2.6–3.4; `shard/bench/results/registration.log`):
a new stream's first acknowledgement, the ledger draining on its own, 519–1007 ms (median 702)
with the shard's `Retry-After` and 1006–1013 ms with it rounded up to whole seconds as edge
writes it, one refusal each (n = 30 each; local R2 PUTs take milliseconds, so a lower bound);
appends per second of established streams unchanged against the release before (1, 16 and 64
clients, three runs each, within the run-to-run spread). **Modelled** for Cloudflare: 1–2 s to
the first acknowledgement (180–494 ms segment PUT, edge's whole-second `Retry-After`), against
the proposal's 0.5–1.5 s; the shard→ledger round trip is not measured. The model's results
(spec/README.md) and the review's runs are bounded-depth for safety, whole-graph for liveness
and leaks.

**Cost of it.** About a second before a new stream's first acknowledgement (a new tenant, a
new slot, a shard that lost its storage), 1–3 ledger calls per stream lifetime, one row write
per confirmed stream, one outbox read per registration call and per `loggedWatermarks` while
some stream has no logged unit. While a tenant's ledger cannot log, its new streams take no
writes (fails closed, retryable, reported after 60 s by the shard and in `logStatus`).
Streams are never retired (review m-3) and a forgotten registration is not re-registered
(m-2); both are recorded as open in `shard/README.md`.

**Would change if.** The first refused append is measured to matter on Cloudflare (then R4's
committed registration with its re-check, or registration ahead of map changes and at tenant
creation, which `ensureStream` allows, m-4); the outbox read shows in the ledger's CPU (then a
nullable `kind` column older code leaves NULL); or pool retirement or tenant deletion is built
(then a stream-retirement change in the ledger, and both creating paths fenced).

## D62. Traces and logs are read in one place under a byte budget the engine counts; a trace the answer names is read whole within a margin around the window, the same with pruning on or off; each tail read asks only its signal's shards by name and checks every batch's header

(Rewritten 2026-11-19 after the adversarial review `design/reviews/signals-end-to-end.md`
rejected the first text (M-1, M-2). This entry replaces it; "Replaces" at the end lists what
changed. `QUERY_SIGNALS` stays off until this text has been reviewed again, as the review asks,
and the Cloudflare and Grafana runs named under "Cost of it" and in `query/README.md` have run.)

**Decision.** The query Worker answers Tempo's and Loki's APIs (behind `QUERY_SIGNALS`,
`query/README.md` "Traces and logs") in one place: files through the leaf pool, the signal's
shard tails, one engine call.

1. **Memory is bounded by bytes, counted by the engine.** Every span and log call carries the
   tenant's `maxDecodedBytes` (32 MiB). The engine charges each row it holds a fixed overhead
   plus the length of every string it keeps; a span's resource is held once per distinct
   resource of the call (shared by every span that carries it, from files and tail alike) and
   charged once; a metric query's series are charged per point; the answer is charged four
   times its length (twice in WASM, once more as a JavaScript string). Past the budget the call
   is refused: 422 `max_decoded_bytes`. The row caps, `maxSpans` (18,000) and `maxLogRows`
   (30,000), are checked from the fragments before the span or log files are fetched and again
   by the engine on the rows it holds (a span outside the bound below, or a log row no selector
   reads, is not held and not counted; `trace_index` fragments are not spans and are held under
   the byte budget alone); they are derived from the budget and the memory a realistic row
   takes, so that a realistic query meets the cheap refusal before the budget.
2. **A trace the answer names is whole within a margin.** A search, a TraceQL metrics query
   that needs whole traces, and trace by ID with a time hint have a bound: the window widened by
   the tenant's `traceMarginMs` (2 h) on each side. `trace_index` is planned over the bound; the
   engine merges, per trace, every fragment and tail span that lies inside it, finds the traces
   whose merged extent overlaps the window, and gives the hull of their extents cut to the
   bound; `spans` is planned over that hull at the same ledger version; and the engine drops
   every span whose start lies outside the bound, before de-duplication. So every trace the
   answer names is evaluated over exactly its spans that start inside the bound: all of them
   when the trace starts and ends within the margin of the window, wherever its spans were
   flushed or whether they are still in a tail, and with pruning on or off (both read every
   such span; the engine sees no other). A span that starts outside the bound is not part of
   the answer: a trace longer than the margin is answered from its part inside it, the same
   part every time. Trace by ID without a hint is bounded by all time: the whole trace. Its
   summary (root, duration, per-service counts) is computed from the spans by the engine;
   `trace_index` counts are upper bounds (a span retried into two units is counted twice, D68)
   and are used only to plan.
3. **Tails by signal.** A tail read asks the shards of its signal by name (`…/traces/{slot}`,
   `…/logs/{slot}`, the rest metrics), sends `signals`, and checks every batch it gets back by
   its header: a batch of another signal refuses the query (503); none is read as the wrong
   signal or dropped. A span or log tail is read whole, whatever the window: the time fields are
   not sent. (Since D72 the shard can skip span and log batches by time bounds it records at
   append, when a read sends a time range; the query does not send one yet, shard/README.md
   "Needed changes elsewhere".)

**Alternatives.** Completeness: (a) the first text: `trace_index` over the window only;
(b) a second `trace_index` round by trace id for the traces found, by the fragments' id ranges
or the bloom filters, over a bounded lookback; (c) retract the claim and document a Tempo-like
partiality (Tempo's API documentation, read 2026-11-19: trace by ID with a range "can result in
trace not being found or partial results"; search makes no claim either way); (d) no bound: read
every `trace_index` file of the tenant. Memory: (e) estimate decoded bytes from the fragments and
refuse before reading; (f) lower row caps alone; (g) hold each resource once and keep the row
caps. Earlier alternatives, still rejected: summaries from `trace_index` alone (they over-count
retried spans, 43 to 52 of 300 traces of the read-back corpus); split execution by trace-id hash
(the engines expose no exact partials yet); skipping batches of another signal silently.

**Why.** (a) is false (review M-1, reproduced: a trace's `durationMs` 300,000 against
7,260,000 over every span; `{ trace:duration > 1h }` empty; structural operators across units
wrong). (b) selects traces by "a fragment overlaps the window", which depends on how spans fell
into flush units, while the engine's in-memory source (the tests' reference) puts a trace in a
window when its extent overlaps it; and it prunes nothing on flush output, whose `trace_index`
file per unit is one row group whose random trace ids span the id space (bloom filters are written
on `spans.trace_id`, not on `trace_index`, and not read yet), so it reads the same files as one
round over the bound. (c) is what Tempo documents, but a trace summarised from part of its spans
is an answer the engine over the same data does not give; a bound makes it right for every trace
that fits, at a measured cost, and `traceMarginMs: 0` is exactly the window-only answer, made
deterministic. (d) costs every `trace_index` file the tenant holds. Two hours covers the review's
case (a child 1 h 50 min after the window) and costs, for a one-hour search, `trace_index` over
five hours instead of one: about 5 % of the span bytes per hour in the benchmark data (measured
here: 180,576 of 3,569,847 bytes), so about a fifth of the hour's span bytes, and one more
`trace_index` file per flush unit (six per shard and hour at the 10-minute seal; modelled: 24 S
more R2 reads for S shards, until compaction folds a day into one file). (e) is not possible
with what the fragments carry, and Parquet's own uncompressed sizes count a dictionary value
once: the review's 0.18 MiB of span files decoded to 176 MiB. (f) leaves one fat row (a line or
an attribute of up to 256 KiB, within edge's limits) unbounded, and (g) leaves lines and span
attributes unbounded.

**Measured** (here; Node 22 through the binding, `query/README.md` "Memory"; and workerd through
the Worker, `query/test/memory.test.ts`). The review's inputs: 1,000 and 2,000 spans with a
180 KB resource, 176 and 349 MiB of WASM memory before, 4.8 and 6.0 MiB after; 400 log lines of
200 KB, 158 MiB and a 19 MiB answer before, refused (422) at a 38.7 MiB peak after (the default budget, 32 MiB). Realistic
rows (an OTel-like resource of about 3 KiB, 12 to 14 attributes: the shape is training
knowledge): 1.64 KiB of WASM memory held per span and 1.72 KiB charged (40,000 spans: 66.3 MiB);
log rows of 150 to 400 bytes, 0.64 KiB held and 0.8 KiB charged. The review's M-1 reproduction
mirrored on the new planner: all six queries equal the engine over every span with the 2-hour
margin; with a 1-hour margin the four that depend on the late child differ, as the bound says.

**Cost of it.** Each trace query reads `trace_index` over the window and twice the margin (above;
the reads on Cloudflare are not measured: the experiment is a search over a tenant with S span
shards and uncompacted recent hours at margins of 0, 1 and 2 hours, timing files read and wall
time). A trace longer than the margin is answered in part, deterministically. The row caps halve
(from 40,000 and 60,000): tenants with more than about 18,000 spans or 30,000 log rows in a query's
window are refused until split execution exists (about 5 spans a second over Tempo's default
one-hour search). A span or log query reads the signal's whole tail under `maxFetchBytes`
(16 MiB) whatever its window (review m-3, modelled: a shard seals at 4 MiB or 10 minutes, so a
tenant whose spread S is 4 or more and whose segments are near the seal size is refused 422 on
every trace or log query; rows of the tail outside the query cost no row and no byte of the
budget). Answers are charged four times their length, so a log query asking for 5,000 lines of
400 bytes uses about 8 MiB of the 32. Without this release's ABI 7 module the query refuses
(`EngineLoadError`, 500), as for every ABI change.

**Would change if.** `trace_index` gains an id-sorted, bloom-filtered layout at flush (then a
second round by id over a longer reach, instead of a margin read whole); the engines gain exact
partials (then split execution, and the caps become per part); projection by the plan's columns
cuts the memory per span (then larger row caps); the shard keeps per-batch time bounds for signals
2 and 3 (then tails are read by window, and m-3's limit goes); Cloudflare shows the margin's reads
cost too much (then a smaller default, or the second round above).

**Replaces.** "Every trace the answer can name is then complete" (it was not: M-1) is now
"complete within `traceMarginMs`", with the bound applied by the planner and by the engine.
"The caps make one place safe meanwhile (about 1.5 KiB of WASM memory per span held and 1 KiB
per log row)" (they bounded rows and compressed bytes, not memory: M-2) is now the engine's
decoded-bytes budget, with resources held once. `maxSpans` 40,000 and `maxLogRows` 60,000 are
now 18,000 and 30,000, counting rows held rather than rows decoded. Trace by ID with a hint
reads `trace_index` over the hint and the margin, not the hint alone. The Loki and Tempo
compatibility points of the review (m-4) are in `query/README.md` ("Grafana"): Loki integers of
ten or fewer digits are seconds, Loki errors are plain text, and Tempo's `/api/echo` answers.

## D63. Span and log files enter the ledger as metric files do: one unit per segment, millisecond bounds, a `spans` key under its hour; `Table` keeps its meaning and the ledger's tables are `LedgerTable`; a tail read chooses batches by signal and returns span and log batches whole

(Written 2026-11-19, stage 2 of traces and logs, the write side. The read side is D62.)

**Decision.** Flush chooses the encoder by the batches' signal byte and reports a span or log
segment as ONE unit, exactly as a metric segment: `spans` files (one per hour of start time,
keyed `…/day=D/hour=HH/`) with `trace_index` files (one per day), or `logs` files (one per day).
The ledger lists them with `minTs`/`maxTs` in milliseconds, the floor of the files' nanosecond
bounds, so plans, precedence, `replace` and `expire` are unchanged; it admits a `spans` key only
under the hour its `[minTs, maxTs]` lies in. In `contracts/ledger.ts` the table names a ledger
lists are a new union, `LedgerTable`; `Table` stays the metric pair (and
`LedgerChange.removedFiles` stays typed `Table`, with a note) until the publisher reads the new
tables. A filtered tail read takes `signals` (the header byte); the time range and series fields
select metric rows only, and a span or log batch it admits is returned whole. (Replaced in part by
D72, 2026-11-19: the time range also skips a span or log batch whose bounds, recorded at append,
lie outside it; an admitted batch is still returned whole, and the series fields still keep
nothing of one.) Retention reads
`trace_days` and `log_days` from the record control already writes, 30 days each when absent,
and expires them in ledger requests of their own after the metric one.

**Retention, revised 2026-11-19 after review B-1 and m-1** (`design/reviews/signals-end-to-end.md`).
This replaces two parts of the first D63: a present but unreadable `trace_days` or `log_days`
refused the whole record (metrics included), and control's "shorter" check compared only the
fields a new value named, so a PUT that left a field out dropped it to the default unconfirmed.
Now: (1) the janitor reads each signal field on its own. One that is present but not a positive
integer stops that signal only: its tables expire nothing until it is fixed, the metric tables and
the other signal expire as usual, and the run reports the field as `refused` (looked at hourly,
shown in the maintenance marker, as a refused record is). A bad `metric_samples_days` still refuses
the whole record (review R-1). (2) Control's `PUT /settings/retention` stays a replace, like every
section's. A shortening is judged on what the readers keep, before and after, with each absent field
at its reader's default: 30 days for spans and logs (the janitor's `DEFAULT_SIGNAL_DAYS`); a rollup
tier, which has no reader yet, counts as shortened when it was set and is left out. So a PUT that
leaves out `trace_days` or `log_days`, or sets one below the default for the first time, needs
`confirmShorter` like any other shortening, and the refusal names the fields left out (`leftOut`).

**Alternatives.** Time: (a) nanoseconds in `FileEntry` as decimal strings or a second pair of
fields. Units: (b) one unit per hour of a span segment. Types: (c) widen `Table` in place;
(d) make `FileEntry` and `LedgerChange` generic over the table. Tails: (e) filter span and log
rows by time inside the shard; (f) a `signals` field only, other fields refusing span batches.
Retention: (g) traces and logs inherit `metric_samples_days` when the record does not name them.
Control's check (revised): (h) merge the fields a PUT leaves out from the stored value, so PUT
becomes a patch for this section; (i) merge and compare effective policies both. A bad signal field
(revised): (j) refuse the whole record (the first D63); (k) read it as the default.

**Why.** (a) A Unix nanosecond does not fit a JS number, and every reader of the ledger (query's
planner, compaction's pairing, the publisher) would need a second time model; the floor is exact
for overlap (a millisecond range `[a, b]` covers nanoseconds `[a·10⁶, b·10⁶ + 999,999]`), and
`query/` had already planned in milliseconds (`msRange`). (b) would break "everything one sealed
segment produced is admitted atomically" and the watermark's contiguity for no gain: a unit's
files are few (at most 26 for a segment across the 24 h accept window). (c) is what the change
means, but the publisher maps every `Table` (`Record<Table, TableDef>`), so widening it failed
the publisher's typecheck and, through their imports of its sources, compact's and the janitor's
(tried); the publisher is not this change's to edit. `LedgerTable` fails none, and
`removedFiles` is the one field the publisher's log reader pushes into its own `Table`-typed
list. (d) carries the same lie as the note, with more
machinery. (e) means rewriting span and log batches (variable-length columns, entry tables) on
the shard's thread for a filter the reader applies anyway; whole batches keep the shard opaque to
them, as it is on append. (f) would make an older caller's metric filter throw on a span batch,
as before: keeping nothing is the answer a series filter gives a batch with no series. (g) ties
the volume a tenant keeps of its largest signals to a number chosen for metrics (a tenant keeping
metrics for 400 days would keep logs as long); control already writes separate fields. (h) alone
leaves a hole of the same kind: a signal set for the first time below the 30-day default has no
stored field to compare with, so it shortens what the janitor keeps with nothing asked (reproduced
before the fix: a stored `{metric_samples_days: 45}` took `trace_days: 7` unconfirmed). It would
also make retention the one section whose PUT is a patch, leave no way to return a field to its
default, and change the documented behaviour of an existing route. The effective comparison closes
both holes alone, so (i) adds the patch for no safety; a caller that leaves fields out gets a 422
that names them. (j) let one optional field stop metric expiry, against this entry's own "the
metric expiry never depends on them". (k) is R-1's mistake again: the default can be shorter than
what was meant.

**Measured** (here, workerd, load average 8; `flush/README.md`, "Spans and logs"): a ~3.3 MB
segment flushes in 134–388 ms (spans) and 86–218 ms (logs); 94 bytes in R2 per span (with its
trace_index share) and 158 per log record for the test workloads. End to end through edge and
three OTLP corpora: every row and every TraceQL (60) and LogQL (36) answer identical to the
in-memory engines' (`stack/README.md`, "Traces and logs end to end").

**Cost of it.** `removedFiles`' static type is narrower than what the ledger writes until the
publisher is updated (readers check it at run time, as the publisher does). A span or log read
gets every batch of its signal above the watermark, whatever its time range (until D72, and until
the query sends a time range). `INGEST_SIGNALS`
must stay off in any deployment with a publisher until the publisher reads these tables (it
stops a tenant at the first change naming one). (Since 2026-11-19 the publisher reads them and
`removedFiles` is typed `LedgerTable`: D64, which also gives the rule for turning the flag on.)
Control holds its own copy of the readers' defaults (`KEPT_WHEN_ABSENT` in
`control/src/ops-settings.ts`), not the janitor's constant: importing the janitor's source would
bring compaction and flush into control's Worker, and `contracts/` has no type for the record yet
(control README, "Contract issues"). A control test runs random PUT sequences, with days on both
sides of the default, through the janitor's own `readRetention` and `parseRetention`, and fails if
the two disagree on any shortening. A partly unreadable record expires metrics and the readable
signal, so `refused` no longer always means "nothing expired" (`beforeDay` says which).

**Would change if.** The publisher reads the span and log tables (then `removedFiles` and
`Table` are retyped, and `Table` may become the full union); span tails grow large enough that
per-batch time bounds at append pay (then (e) at batch granularity: done, D72, after review m-3); or tenants ask for traces
and logs to follow their metric retention (then (g), or a control-side default). The retention
record gets a type in `contracts/` with its defaults (then control and the janitor import them and
the copy goes); the rollup tiers get a reader (then its default replaces "left out counts as
shortened"); or operators want partial updates (then a PATCH of its own, not a change to PUT).

## D64. The publisher reads the span and log tables and does not publish them yet: it records them per tenant, releases their removed files to the janitor, and never stops a tenant for them; `INGEST_SIGNALS` goes on only once this publisher release is the oldest a rollback can reach

(Written 2026-11-19. Step 1 of publishing traces and logs; publishing them as Iceberg tables is
the next step, not done: `publisher/README.md`, "Not implemented". **Since D67 the release after
this one publishes them**: its record and its release of removed files are replaced there by the
tables' Iceberg state and the snapshot rule. The rollout rule below stands: this release stays the
oldest viz-publisher a rollback may reach once `INGEST_SIGNALS` is on, and D67 is shown to roll
back to it. **Since D69 the release tooling enforces the rule** (it no longer rests on an operator),
widened by the review of traces and logs (M-4) to viz-query (D62) and viz-ingest (D63).)

**Decision.** The publisher's log reader knows every table the ledger lists (`LedgerTable`): it
publishes `metric_samples` and `metric_series` as before and reads `spans`, `trace_index` and
`logs` without publishing them (`PUBLISHED_TABLES`, `UNPUBLISHED_TABLES` in
`publisher/src/log.ts`, pinned there and tested equal to the contract's `TABLES`). A change, a
base or a checkpoint that names them no longer stops the tenant; a table no release knows still
does (`unsupported`, COMPATIBILITY.md §3.2). A re-base counts their files and does not stage
them; their tombstones are staged as tombstones. After the metric commits, in SQLite only, the
publisher records per tenant and table (`unpublished`, storage migration 4, `readableFrom` 1):
the ledger version through which it counted, the live files counted, where the count started
(`base`: a re-base's base or checkpoint; `log`: the first change it read that named the table),
and when the table was first and last named. Each publish reports the counts per tenant;
`unpublished()` returns the records; `status(table)` answers `published: false` with the tenants
and files counted. The files of those tables that a change removes, and a re-base's tombstones of
them, are recorded as removed before they were ever published and released to the janitor
`deleteGraceMs` later, as such metric files already are; not while the cell holds an object under
`{cell}/iceberg/{table}/` (only a newer publisher, one that publishes the table, writes there).
`LedgerChange.removedFiles` is typed `LedgerTable` (contracts/ledger.ts). Metric publication is
unchanged: the same Iceberg bytes.

**The rollout rule.** The publisher is the reader that must act on every file of the ledger's
log, so it goes first and `INGEST_SIGNALS` (edge, the writer of span and log changes) goes last
(COMPATIBILITY.md §3.3):

1. Deploy viz-publisher at this release. It is additive (migration 4 has `readableFrom` 1; it
   writes no new format; its Iceberg output is unchanged), so the release before stays a
   rollback target, and nothing in the release tooling stops a rollback to it (D46 judges
   storage, not the log tables a release reads).
2. Set `INGEST_SIGNALS` in a deployment with a publisher only after viz-publisher at this release
   or later has served there and the operator treats it as viz-publisher's rollback floor: from
   then on a rollback of viz-publisher may only go to this release or later. Without a publisher
   bound, the flag needs no publisher release at all.
3. If viz-publisher is rolled back below this release while any tenant's log names a span or log
   table: the release before opens this storage, publishes every tenant up to its first change
   naming one, and stops it there, metrics included (`unsupported`, retried every `retryMs`), and
   releases none of that tenant's files, so the janitor deletes nothing of it. Stuck, not lost
   (COMPATIBILITY.md §9); rolled forward, this release catches up. Turning the flag off does not
   unstick it: the changes are in the log already. Shown with the release before frozen beside
   this one (`publisher/test/n1/`, `test/signals.test.ts`, "releases N and N-1 side by side").

**Alternatives.** (a) Publish the tables in this release (Iceberg tables with hour partitions
from `start_time`, contracts/TRACES.md, LOGS.md). (b) Pass over their changes with no record
(the least D63 asked for). (c) Record every span and log file (a `live` row each). (d) Release
none of their removed files until they are published. (e) Make this release forward-only
(migration 4 `readableFrom` 4), so the release tooling enforces the floor. (f) Keep stopping at
any table the publisher does not publish (as before).

**Why.** (a) is the larger change (nested schemas, a partition transform the metric tables do
not use, per-table manifest schemas, a re-base of every tenant on the upgrade, and readers shown
to read all of it), and the flag waits on the publisher only for this much: never stopping a
tenant. (b) makes span and log data invisible: neither published nor said to be unpublished. (c)
pays a row write per file for tables that are not published; counts say what is unpublished. (d)
holds those files for ever with a publisher bound (the janitor's purge deletes only what the
publisher releases), and past 10,000 held-back tombstones at the head of the ledger's answer the
purge stops reaching the tenant's metric files as well (`janitor/src/janitor.ts`, the `held`
window); no snapshot of this publisher can reference them, which is exactly the rule for metric
files removed before they were published. (e) would make a rollback below this release refuse
the publisher's storage for every tenant, and the janitor's purge fail closed for the whole cell,
to protect tenants whose logs name tables a rollback target cannot read; the rollback that (e)
refuses costs, without it, only those tenants' publication, retried until rolled forward. (f)
makes `INGEST_SIGNALS` unusable wherever a publisher runs.

**Measured** (here, workerd; `publisher/README.md`, "Tables it does not publish"): with the
same fixed ids and clock, the Iceberg objects published from a log with span and log changes,
from the same log with them removed, and by the release before from the log without them are
byte-identical, at two stages (units, expiries of logs and metrics, a compaction). The readers'
export (PyIceberg 0.12.0, DuckDB 2.0.0) reads 504 checks, 0 failed, with the eight content hashes
of the metric tables as before. A publish costs one R2 list more per span or log table only when
it reads a removal of one (the check for a newer publisher's table); none for a metric-only log.

**Cost of it.** One SQLite table, a row per tenant and span or log table, written by a publish
that reads a change naming one (at most three rows a tenant). A count that started at a cursor
(`origin: log`) misses files added before it if this publisher has lost its storage since (it
then restarts at the cursors restored from R2) until the tenant's next re-base; a release before
this one never passes such a change, so nothing else is missed. A removal read while a newer
publisher's table of that name exists is never released by this release. The rollout rule rests
on an operator, not on the release tooling. Span and log data reach no Iceberg reader yet.

**Would change if.** The publisher publishes the tables (then the record is replaced by their
Iceberg state, their removals are released by the snapshot rule, and every tenant is re-based once
for the new tables' cursors); the release tooling learns per-format floors (then step 2 of the
rule is enforced); or counts must be exact across a publisher storage loss (then a re-base of
every tenant after a resync).

## D65. A `logs` file's token filter lives inside its Parquet object, between the last row group and the footer; its place is in the fragment (`tok`) and the file's metadata

(Written 2026-11-19, with compaction of the span and log tables, D68. Replaces the placement
`contracts/LOGS.md` §6 gave before, which was never built; the filter's bytes are unchanged.)

**Decision.** Compaction writes a `logs` output's token filter (`VZT1`, contracts/LOGS.md §6)
into the output's own Parquet bytes: after the last row group's column chunks and bloom filter,
before the page indexes and the footer metadata, through the `parquet` crate's
`SerializedFileWriter::write_all` (which keeps the writer's offsets right). Its offset and
length are in the index fragment (`"tok":[off,len]`) and in the footer's key-value metadata
(`viz.token_filter`). The fragment's `foot` then starts where the filter ends. A file with more
than 2^19 distinct tokens gets no filter (the builder holds about 33 bytes a token).

**Alternatives.** (a) The settled text: a separate object `….tokens` next to the file, with its
size and SHA-256 in the ledger. (b) The filter as a footer key-value entry. (c) The filter before
the first row group. (d) A filter in the ledger's index fragment.

**Why.** (a) needs every deleter to know the second object: the orphan sweep keeps any key it
cannot parse for ever (`unknown_name`), and purge deletes only keys the ledger removed, so every
`.tokens` object would outlive retention, holding the tokens of expired log lines; the ledger has
no field for its size or hash (`contracts/ledger.ts`, not this change's to edit) and would need a
format change and its readers first (COMPATIBILITY.md §3.3); D30's adoption and sweep rules would
need restating for a pair of objects; and a merge would cost a third PUT. Inside the object it is
covered by the object's hash, written by the PUT the step already makes, and deleted with the file
by rules already proven. (b) Every reader reads the footer; a filter of hundreds of kilobytes
there taxes every read of the file, including the ones that never use it. (c) needs all of the
file's tokens before its first row group is written, which a streaming merge does not have. (d)
Fragments are capped (ledger state is 16 MiB a tenant) and the filter grows with distinct tokens.
Parquet readers locate everything through the footer, and writers already put bloom filters and
page indexes between row groups and the footer; PyArrow 26.0.1 and DuckDB 2.0.0 read every merged
file whole (`engine/storage/README.md`).

**Cost.** A reader that wants only the filter first needs the fragment (or the footer) to find it.
A file's bytes grow by its filter (measured in `engine/storage/README.md`, "Compaction of spans and
logs"). `foot` no longer starts at the last row group's end for these files; readers before this
change never read the bytes between, so they are unaffected.

**Would change if.** A Parquet reader viz must support refuses bytes no footer field references;
filters are wanted for files that are never compacted (flush files); or the ledger gains per-file
side objects for other reasons.

## D66. Control refuses every pool map edge would refuse, with edge's own function (`validBasePool`: `POOL_NAME`, and no `/traces` or `/logs` suffix); a tenant's dedicated pool is `dedicatedPool(tenant)`; tenant ids stay as they are

(Rewritten 2026-11-19 after review M-5, `design/reviews/signals-end-to-end.md`. It replaces the
first D66, which checked only the derived suffixes and accepted the dedicated pool `tenant/<id>`
verbatim: for a tenant id with `_`, which `TENANT_ID` allows and `POOL_NAME` does not, control
published a map edge refuses, and every write of that tenant, metrics included, was a 503.)

**Decision.** `PUT /settings/pool` refuses (422 `invalid`, field `pool`) any pool that is not a
valid base pool by `validBasePool` (`shard/src/pool.ts`): a valid pool name (`POOL_NAME`: segments
of `[A-Za-z0-9-]` joined by `/`, at most 120 characters) that does not end in `/traces` or
`/logs`, the suffixes of the derived span and log pools (`DERIVED_SIGNALS`). The function moved
there from `edge/src/route.ts`, and edge reads every map with it (`parseMap`), so control and
edge cannot disagree. A tenant's dedicated pool is D38's `dedicatedPool(tenant)`: `tenant/<id>`
with `_` written `-`. Control offers and accepts only that one; asked for `tenant/<id>` verbatim
with a `_`, it refuses and names the right pool. A shared pool (`DEFAULT_POOL`) that breaks the
rule is refused too, with a fix for the operator. A tenant whose id is `traces` or `logs` can still
be created and uses the shared pool. Its dedicated pool breaks the suffix rule and is refused, as
edge would refuse it (503 for every signal: `contracts/BATCH.md`, "Streams per signal"; D57, D63).

**Alternatives.** (a) Refuse the tenant ids `traces` and `logs` at `provision` (a change to
`TENANT_ID`'s meaning in `contracts/ledger.ts`, which every component checks). (b) Give such a
tenant a dedicated pool under another name (for example `tenant/<id>-t`). (c) Do nothing in
control, and let edge's refusal show. (d) Control's own copy of the rule (the first D66). (e) No
dedicated pool for tenant ids with `_`. (f) An injective naming of dedicated pools: escape `-` as
well as `_`, or write `_` as `/`.

**Why.** The narrower rule: (a) would refuse two names that work everywhere on the shared pool,
and a tenant created before the rule would still exist; the pool rule refuses exactly the maps
edge refuses and nothing else, at the moment one is written. (b) needs a second naming rule for
dedicated pools that every operator and reader must know, for two names. (c) publishes a map
that turns every one of the tenant's writes into a 503, with nothing in the response that says
why. (d) drifted at once: the copy checked the suffix and not `POOL_NAME` (M-5), which is what
one function shared by the writer and the reader prevents. (e) refuses for a reason the data path
does not have: `dedicatedPool` already names those tenants' pool. Two ids that differ only in
`_` and `-` then share their dedicated objects, which D38 recorded as safe: streams and epochs
are per tenant, and keys lie under each tenant's own `tenant=` prefix. (f) either renames every
existing dedicated pool whose id has a `-`, or produces names that break the rule (`_` as `/`
turns `a_traces` into `tenant/a/traces` and `a__b` into an empty segment).

**Cost of it.** Tenants `a_b` and `a-b` share their dedicated shard objects, so a noisy one slows
the other, as in a shared pool. A map published by an earlier control that breaks the rule is
not withdrawn: edge refuses it, and replacing it is a pool change (409 until the drain-and-handover
protocol of DESIGN §4.1 exists). None is known to exist. Edge's and the stack's mutants of the rule
must name `shard/src/pool.ts` now (`edge/scripts/mutants.mjs`, `stack/scripts/mutants.mjs`).

**Would change if.** Dedicated pools get another naming (then `dedicatedPool` changes and control
follows it), another derived pool suffix is added (`DERIVED_SIGNALS` carries it to both sides),
or the drain-and-handover protocol exists (then a stored map that edge refuses can be replaced).

## D67. The publisher publishes `spans`, `trace_index` and `logs` as Iceberg v2 tables of their own: every nested field has a pinned id and a nested name mapping, `spans` is partitioned by `hour(start_time)` with the value taken from the key's hour level, every tenant is re-based once on the upgrade, a few per publish, and the metric tables' bytes do not change

(Written 2026-11-19. Step 2 of publishing traces and logs; step 1 was D64, whose release read the
tables without publishing them. Replaces D64's "record and release": `publisher/README.md`,
"The span and log tables". Amended the same day after review M-6 of the spans-and-logs review: the
upgrade's re-bases, and everything else a publish does in proportion to the cell's tenants, are
bounded per publish (`publisher/README.md`, "Bounded work per publish"). This replaces the earlier
text, under which the first publish after the upgrade re-based every tenant in one invocation.)

**Decision.** `PUBLISHED_TABLES` is every `LedgerTable`, in commit order `metric_samples`,
`metric_series`, `spans`, `trace_index`, `logs`; each is one Iceberg v2 table per cell with its
own metadata, snapshots, cursors per tenant, expiry deadline and sweep, under
`{cell}/iceberg/{table}/`. Schemas match the Parquet files of contracts/TRACES.md and LOGS.md
column for column (required where the files are, `fixed[16]`/`fixed[8]` ids, `timestamptz`
`start_time`, maps with required values, lists of required structs and of ints), with `tenant`
(and `day` for `trace_index` and `logs`) first, optional, filled from the partition tuple, as for
metrics. Field ids are pinned in `publisher/src/iceberg.ts` (`SIGNAL_DEFS`): the files' columns
1..N in file order, then the partition columns, then every map key and value, list element and
struct field in order of appearance; `schema.name-mapping.default` maps every one of them,
`element`, `key` and `value` included (spec, "Column Projection"), because the files carry no
field ids. Partition specs: `spans` `identity(tenant)` and `hour(start_time)` (field
`start_time_hour`, an int of hours since the epoch); `trace_index` and `logs` `identity(tenant)`
and `identity(day)`. A `spans` file's hour is read from its key (`…/day=D/hour=HH/`, under which
the ledger admits it only if its `[minTs, maxTs]` lies in that hour) and checked against
`minTs`/`maxTs` when it is planned: a file that disagrees stops its tenant (`inconsistent`).
Statistics: value and null counts only for required top-level primitive columns; bounds for the
time columns from `minTs`/`maxTs` widened by the last millisecond, for `service_name` and
`trace_id` from the index fragment, never reading its 64-bit integers as numbers. Removals are
released by the snapshot rule, as metric files are. After an upgrade from D64's release every tenant
is re-based once (D55; the new tables have no cursor), spread over publishes: a publish starts at
most 100 re-bases (`maxRebasesPerPublish`) and no further one once those it started have staged
100,000 files and tombstones (`maxRebaseFilesPerPublish`), always at least one, least recently started
first (storage migration 6, `rebase`, written before a re-base reads anything, so one cut off with its
invocation goes to the back); each publish commits what it re-based. A tenant waiting for its re-base
is read from the cursors it has, so its metric tables keep being published; the alarm continues
after `continueMs` (1 s), and before publishing sets its own deadline `retryMs` ahead (a lease that an
invocation cut off by the platform keeps). A publish reads at most 1,000 tenants
(`maxTenantsPerPublish`), longest waiting first, a tenant read and not finished going behind. After a
lost storage, a table whose metadata R2 has is rebuilt from it, one per publish, before any tenant is
read, so no tenant is re-based for a table R2 holds its cursor for. The metric tables move on from
their cursors and are committed only if their files changed. D64's `unpublished` records are
left alone. The alarm's deadlines and orphan sightings of the new tables live in tables of their own
(storage migration 5, additive), because the D64 release, the rollback floor, re-arms at the earliest
row of `due` and `orphan` and would wake for ever on rows of tables it does not publish. New golden formats `iceberg.signal-metadata` and `iceberg.signal-manifest`;
`viz.format-version` stays 1, so a metric table's `metadata.json` is unchanged.

**Alternatives.** Partitioning `spans`: (a) `identity(day)` plus an optional `hour` int column
filled from the partition tuple, like `day`: a reader would prune only on a predicate over that
column, not over `start_time`; (b) `day(start_time)`: a day's 24 hours in one partition, and
readers filtering an hour read them all. The hour's source: (c) `floor(minTs / 1 h)`, equal to the
key's hour under the ledger's rule, but `live` keeps no `minTs`, and a rewrite or a resync would
need it (a storage migration on `live`, which the release before cannot read back through its
resync's column-less `INSERT … SELECT`). Ids: (d) nested ids right after their parent; (e) field
ids written into the Parquet files instead of a name mapping (contract issue 4: `engine/storage`'s,
not this component's). Counts: (f) per-column counts read from each file's footer at publish (a
range read per file). The upgrade: (g) start the new tables' cursors from D64's `unpublished`
records: they hold counts, not files; (i) every re-base in the first publish (the text this
amendment replaces); (j) a higher `limits.cpu_ms` alone (up to 5 minutes, Cloudflare's documentation);
(k) a commit after every re-based tenant; (l) a tenant's staged state kept across invocations;
(m) a tenant waiting for its re-base not read at all until then. Removals: (h) keep D64's immediate release: wrong once a
snapshot can reference the file.

**Why.** `hour(start_time)` is the partitioning contracts/TRACES.md and DESIGN §5.1 name, and the
one a reader can prune with from a time predicate: measured, PyIceberg 0.12.0 and DuckDB 2.0.0
(iceberg extension `4c0c0874c4`) plan or read only the files of the hour asked for. The key's hour is
exact for every file the ledger admits and needs no storage; the plan-time check refuses a log that
breaks the rule rather than publishing a wrong partition. Field ids in a fixed table, golden-pinned
and checked never to be reused, keep a column's id across releases whatever a later schema adds.
Re-basing on the upgrade reuses D55's bounded-memory path, which every tenant takes anyway after a
storage loss; nothing new is written for it. (i) adds the cell's re-bases up in one invocation, which
has 30 s of CPU by default (Cloudflare's documentation, read 2026-11-19): about 340 s for 100 tenants
of 100,000 files by the times measured here (modelled), and a publish cut off was retried from
nothing, so the alarm could fail for ever and stop metric publication for the whole cell. (j) moves
the wall without removing it, and is still the answer for one tenant too large for an invocation.
(k) loses less in a cut-off but writes a snapshot per tenant per table; a publish commits what it
re-based instead, and the cap bounds what one cut off loses. (l) needs `stage` to record, per tenant
and table, the version it was diffed to; not done. (m) is simpler but holds every waiting tenant's
metrics back for the whole queue, which D64's release did not. The started mark keeps a re-base that
cannot finish, or keeps failing, from being taken first every time and holding the queue. Metric commits first, and unchanged code paths for
them, keep metric publication byte-identical, which the counterfactual below requires.

**Measured** (here, workerd, `publisher/README.md`): with the same ids and clock, the metric tables'
Iceberg objects are byte-identical whether published by this release from a log with span and log
changes, by this release from the same log without them, by D64's release from the log as written,
or by the release before D64 from the log without them, at two stages. Real span and log files from
the stack's write path, four stages: PyIceberg and DuckDB read every row and column of every file
as pyarrow does, under a schema equal to the files' (1,542 checks, 0 failed; PyIceberg reads a null
list as empty, counted), prune by
tenant, hour and day, and give rows that viz-storage's readers read identically and on which
viz-traceql and viz-logql answer identically (1,786 checks, 960 TraceQL and 576 LogQL answers, 0
different). A first publication of 10,000 `spans` files took 0.8–1.4 s of commit and 399 kB of
metadata, 10,000 `logs` files 0.8–1.2 s and 253 kB (four runs, load average 8.5–13.6). The capped
upgrade (`publisher/bench/upgrade.bench.test.ts`, load average 9–10.6): a publish at the cap, 100,000
staged files of which 50,000 span and log files added, took 3.3–3.8 s of workerd CPU and 4.8–9.5 s of
wall time; a 300,000-file tenant re-based alone 10.3 s of CPU; a table rebuilt from R2 about 30 µs of
CPU per file. In workerd tests, a cell of five tenants capped at two tenants' staged files is
upgraded over three alarm runs, each within the cap, and ends with every table as one uncapped
publish leaves it (live data files with partitions, counts and bounds, totals, cursors, metadata);
waiting tenants' metric files are committed meanwhile; an invocation reset in the middle of a re-base
loses nothing committed, keeps the alarm, and the next run takes the tenants never started; 12
mutants of these rules killed. Not measured on Cloudflare.

**Cost of it.** A publish that moves a tenant's cursors without a commit costs one R2 HEAD per
table (up to five, three more than before) to check that no other writer is ahead. A `spans`
`metadata.json` is about 9.8 kB with one snapshot (2.6 kB for a metric table: the schema has 70
field ids and the name mapping all of them), and each of its manifests carries a 7.8 kB header.
The upgrade re-bases every tenant once: about two `stage` row writes per live file of every table,
spread over about (the cell's files ÷ 100,000) publishes a second apart, each a commit (and a
retained snapshot, about 1 kB of `metadata.json` each for 24 hours) of every span and log table;
until a tenant's turn its span and log tables are not published. Storage migration 6, additive. A
publish with a tenant to re-base GETs the version hint of each table SQLite has no metadata for (up
to five). A lost storage takes a publish per table before tenants are read again; each rebuild reads
its whole table (about 30 µs of CPU per file here, so about 1,000,000 files per table before it
alone reaches 30 s, modelled). A publish still gives up after six conflicts (one per table plus one:
with three, before the rebuild came first, the first publish after a loss threw at the fourth
table), which now serves a lost storage whose version hints are gone too.
External readers that ignore the name mapping, or the projection rule for identity partitions, see
nothing or nulls; PyIceberg 0.12.0 shows a span without events as an empty list rather than null.

**Would change if.** `engine/storage` writes Parquet field ids (then the name mapping is a
fallback only); a promoted attribute is added (a schema change: this release refuses metadata with
a schema id it did not write, so that needs a release that evolves the schema); compaction of
`spans` ever merges across hours (then the hour comes from the files' bounds, not the key); or
readers that matter turn out to ignore the name mapping. For the caps: a capped publish's CPU,
measured on Cloudflare, far from the limit (then larger caps) or near it (smaller ones, or
`limits.cpu_ms`); one tenant's re-base, or one table's rebuild from R2, near the limit by itself
(then (l), or a rebuild a manifest at a time across invocations).

## D68. Spans, `trace_index` and logs are compacted by the metric step, each table on its own: spans per hour and never across one, `trace_index` and logs per day; merges stream their inputs and cut row groups at 2 MiB

(Written 2026-11-19. Contracts: `contracts/TRACES.md` and `LOGS.md`, "Compaction"; the token
filter's place is D65.)

**Decision.** `compactStep` (compact/) looks at the metric tables first and, when they have no
job, at `spans`, `trace_index` and `logs` in turn, each with the metric policy (open-hour level-1
merges, closed-day level-2 merges, 8 inputs and 16 MB a step, the step deadline), the metric
keys (`L{level}-{span}-{inputs16}-{hash8}`), D30's inputs record, one `replace`, and nothing ever
deleted by a step. A unit of the policy is one file; nothing pairs the trace tables (a fragment
names hours, never files). `spans` files stay hour-pure: an open hour's bucket is the file's hour,
a closed day's spans become one level-2 file per hour, and an output's key is under its hour and
named after it at both levels (`hour=HH/L2-hHH-…`). The engine merges them (`engine/storage`
`merge_signal_files`, engine/wasm ABI 4 `mergeSignalFiles`): `spans` rows equal on
`(trace_id, span_id)` and `logs` rows equal on their row key keep the later input's, `trace_index`
rows of one trace are merged as the contract merges fragments (the later input's root on a tie,
at most 64 services). Each input is read row by row and the output written one row group at a
time, in 1 MiB chunks the binding copies out one by one, with row groups cut at 2 MiB of data
(flush keeps 16 MiB). An engine without the merge compacts metrics only.

**Alternatives.** (a) Pair `spans` with `trace_index` like a metric pair (one job, both tables,
one `replace`). (b) Merge spans per day like metrics (files no longer hour-pure). (c)
Re-aggregate `trace_index` from the merged spans (exact counts, no over-count of retried spans).
(d) Decode whole inputs into memory and re-run flush's encoder over them. (e) Keep 16 MiB row
groups and lower the step budget for these tables. (f) A separate compactor for traces and logs.

**Why.** (a) would tie two partitionings (hour and day) into one job for no reader's benefit:
nothing reads the two tables as a pair, and both are expired by each file's own day. (b) breaks
the hour partitions the key, the ledger's `spans` admission rule, the publisher's `hour(start_time)`
partition (D67) and the read path's hour hull rely on. (c) needs every span of a trace, which lie
in up to 24 hour files and other days: a step would read most of a day. Query summaries are
computed from spans already (D62); the fragments' extents and hours, which queries use, are exact
either way. (d) and 16 MiB groups were measured: a merge at the step budget peaked at 193 MB of
WASM memory (spans) with whole output row groups of 16 MiB decoded, 87 MB for one 1.9 MB input;
with streamed inputs, 2 MiB groups, interned span entries, a chunked output and a token builder
of about 12 bytes a token, the largest step peaks at 62 MB (spans) and 81 MB (logs, 16 MB in,
22 MB out with its filter), against metrics' 70 (`engine/storage/README.md`, "Compaction of spans
and logs"). (e) was not wanted: the task fixed the step budget; and smaller row groups cost only
fragment bytes. (f) would duplicate D30's machinery and its proofs.

**Cost.** More row groups per merged file (49 in a 16 MB spans file instead of 7; about 130 bytes
of ledger state each). The isolate holds the inputs and the output on the JS side besides the
WASM peak: about 81 + 16 + 22 MB for the largest logs step (modelled; not measured on
Cloudflare). A span id re-sent with a start in another hour is two rows in two hours' files,
which no merge brings together; after a merge of one hour a reader's precedence order between the
two can change (`contracts/TRACES.md`, "Compaction"). The token filter adds about a quarter to a
logs file whose lines carry unique ids (25% measured on the benchmark's lines). Merges are
CPU-bound at about 5 MB/s (spans) and 9 MB/s (logs) natively here, so a step at the budget takes
3–4 s natively and 4–6 s in WASM (measured here, not on Cloudflare).

**Would change if.** A Container takes merges over the Worker budget (then 16 MiB row groups and
larger steps); the binding streams the output to JS during the merge (then the WASM peak drops by
the output); `trace_index` must count retried spans once (then (c), at the cost above); or reads
need traces across hours together (then hour-pure spans would be revisited with the publisher's
partition).

## D69. Release records carry format versions; `INGEST_SIGNALS` puts a rollback floor under every Worker that reads what it lets in, enforced at deploy and rollback; each run marks its uploads; a rollback across the OAuth key's creation or rotation is refused before anything moves

(Written 2026-11-19 for the owner's ask that "care goes into how the system can be updated or
redeployed in place". Closes three open risks of `deploy/README.md`: D64's floor, m-13 of the review
of D60, m-11 of the review of D53; widened by the review of traces and logs, M-4 and m-5; and folds
in spike S9, measured on Cloudflare. Code: `deploy/lib/formats.mjs`, `deploy/lib/floors.mjs`,
`deploy/lib/secrets.mjs`, `deploy/release.mjs`, `deploy/configure.mjs`, `deploy/workers.json`.
Revised the same day after its adversarial review, `design/reviews/d69-deploy-safety.md` (approve
with changes): points 1 to 4 below are rewritten where the review found the code or the text short,
and point 5 is new; each change says "review of D69". The entry as first written is in git.)

**Decision.**

1. **Format versions** (contracts/COMPATIBILITY.md §6 already asks for them; D46 left them out).
   `workers.json` names, per Worker, the `FORMATS` maps its components keep (§3.1) and the read
   lists they keep (`READS` maps; `reads_of` for one format, the ruler's `ANOMALY_STATE_READS`).
   `lib/formats.mjs` reads them from the sources as schemas are read (esbuild, a `vm`): for each
   format, the version the Worker writes and the versions it reads, a Worker reading what it writes
   unless a list says more, two lists intersected, a Worker that writes what it does not read
   refused. They go into the manifest, the release record (`formats: { worker: { format: { writes,
   reads } } }`) and every version's `VIZ_FORMATS` var. **Every deployed Worker declares what it
   reads, completely** (review of D69, M-1 (c)): its components' read lists and version constants
   (edge's `KEY_RECORD_VERSION`; `contracts/control.ts`'s `CONTROL_SERVICE_VERSION`;
   `contracts/oauth.ts`'s `OAUTH_VERSION`), and, where its code reads a format with no version of its
   own (control's KV records in edge, shard routing and query; the API key's and the OAuth
   credential's layouts), `reads_v1` in `workers.json`, version 1 only, with where; a Worker that reads
   none declares `{}`; configure refuses a deployed Worker without a declaration, and the record and
   var say `complete`. A test bundles each Worker as wrangler does and fails if its sources read one of
   control's KV records, the two layouts or control's RPC answers without declaring it. What a release
   reads of a format is then judged **per Worker**: a Worker that declares nothing (a version without
   the var, a record without its entry) reads version 1 of every format; a declaration from before
   they were complete (D69's first records and vars) reads version 1 of every format it does not list;
   a complete one reads exactly what it lists. A release that writes a version that some Worker
   serving now does not read is **forward-only** (kind `format`; no automatic rollback); every Worker
   the deploy reads is asked, not only those declaring the format. A rollback is **refused** when a
   Worker it restores does not read a version that (a) any version newer than the target's, of a
   restored Worker that writes formats, wrote (the gate of D60, `store.anomaly-state` 2, is the case
   at hand), or (b) **a Worker the record leaves out** wrote or writes: it keeps serving, so every
   version Cloudflare keeps of it since its version in the record (all of them when the record does
   not name it), its serving one always, is judged against the restored Workers (review of D69, M-1:
   before, a record without viz-control, the README's own way round the rotation refusal, put
   viz-ingest's janitor back to a `kv.settings` reader of version 1 while viz-control kept writing 2).
   A record entry of a Worker left out is no reader. `release.mjs rollback --only` names the Workers to
   restore from a whole record. **Old records** (no `formats`) are taken to read version 1 only (§3.1
   "absent means 1"; §6 Bootstrapping), the side that refuses more. A version that declares no formats,
   of a Worker that writes them, is refused as unknown, as D46 does for schemas.
2. **Rollback floors raised by a switch.** `workers.json` `rollback_floors` has one rule today,
   `signal-data`: once a version of viz-ingest whose `INGEST_SIGNALS` names anything has existed,
   viz-publisher must be at its floor (`publisher.Publisher` schema 4, D64; D67's migration 5 is
   additive), viz-query at its floor (D62: it asks each signal's shards by name and checks every
   batch's header), and viz-ingest at its floor (D63: flush, the ledger and the janitor flush, list
   and expire span and log files). A floor is expressed one of two ways: by the Worker's **storage
   schema version**, when one marks it (the publisher's, in every version's `VIZ_SCHEMAS` since D46,
   so versions and records from before this change are judged with no new data), or by
   **evidence**: exports the code at the floor has (`query/src/shards.ts#checkSignal`,
   `#signalOfShard`; `janitor/src/janitor.ts#DEFAULT_SIGNAL_DAYS`, `contracts/ledger.ts#TRACE_TABLES`,
   `#LOG_TABLES`), checked by configure, which then stamps every version of the Worker with
   `VIZ_FLOORS`; an unstamped version is below the floor. "Has existed" means: is among the versions
   Cloudflare keeps (the 100 newest); the switch is seen as a binding of any type with its name, a
   plain or JSON var, or a secret, whose value cannot be read (review of D69, m-2). Refused (exit 3,
   before anything is uploaded or moved): a release with `INGEST_SIGNALS` on, unless each of the
   three, in this release **and as it serves now**, is at its floor, a floor Worker this release does
   not deploy judged as it serves (review of D69, m-3) ("every release a rollback could reach": the
   serving one, which deploy.sh's automatic rollback and phase 2's restore put back without asking,
   and this one; an older one is reached only through `release.mjs rollback`, which refuses it from
   the moment this release's viz-ingest is uploaded; asking every version Cloudflare keeps to be at
   the floor would hold the switch off for about 100 releases); a release with one of its own below
   its floor while any viz-ingest version Cloudflare keeps set the switch (older code in a new
   commit); a release while viz-ingest's serving or newest version carries the switch as a secret
   (every upload inherits it, whatever the release's config says: review of D69, m-2); a rollback, of
   the whole release or of any Workers a record names (the others judged as they serve), that would
   leave one below its floor while any kept viz-ingest version set the switch. The record says what
   each floor saw. With the switch on, one floor Worker off its floor as it serves refuses every
   release; the way out is restoring that Worker alone (`--only`), not turning the switch off (review
   of D69, m-8).
3. **Each run marks its uploads** (m-11). Every version a run uploads or deploys carries
   `VIZ_DEPLOY_RUN` (`--var`), a UUID per run. `versions secret put` patches whatever version is
   newest when Cloudflare applies it, and the keyed version keeps that version's vars: before the
   put the newest version must be this run's upload and carry its mark; after it, the keyed version
   must carry this run's mark. For a viz-control uploaded in phase 1 (every release once it exists)
   that refusal comes before anything is promoted (exit 3). For one that goes out with `wrangler
   deploy` in phase 2 (new, or applying a migration) there is no version before phase 2: the same
   refusals come after the Workers before it were promoted and while viz-control serves its deployed
   version without the key, so the release fails in phase 2 (exit 1), and the messages say so
   (review of D69, m-5: they said "nothing is promoted").
4. **Generated secrets and rollbacks** (measured on Cloudflare, S9). A rollback whose target version
   lacks the key that a newer version carries (across the key's creation) is refused before any
   Worker moves, naming what it breaks, unless `--accept-secret-loss OAUTH_CLIENT_KEY`. One across a
   rotation (a newer version made by the deploy's put, by its message) is refused always. A failed
   promotion leaves a viz-control whose key it created or rotated on that version. A version just
   created is read again, backing off from 250 ms, for up to 10 s of wall-clock time, and an upload
   until the key it inherited shows, not only until it exists (review of D69, m-7); an empty
   `VIZ_FRESH_READ_MS` is the default, and every Cloudflare API request times out after 30 s and is
   retried. The secret list is not evidence. A key set but missing from the upload has no way out but
   rotation, and the refusal says so (review of D69, m-6; "Known risks").
   The phase-2 restore after a failed promotion also no longer crosses a forward-only release
   (schema or format) for a Worker already promoted: it was a rollback no check judged.
5. **Only main is deployed, with main's own tooling** (review of D69, M-2). Every refusal above lives
   in the tooling of the commit that runs it, and "redeploy an older commit" (the README's advice, the
   workflow's own when no record exists) ran that commit's `deploy/`: for a commit from before D69, no
   floor, format or key check at all (the review deployed a viz-query from before D62 over span and
   log data with `b322599`'s tooling). The Deploy workflow now refuses any ref but `refs/heads/main`
   as the first step of both jobs that hold the Cloudflare credentials; the `production` environment
   allows deployments from main only (a repository setting, in `deploy/README.md`'s one-time setup),
   which is what stops an older commit's workflow, since it has no such step. Older code goes out
   again either as a recorded release (`rollback_to`, judged by main's tooling) or as a new commit on
   main that restores it, which main's tooling judges like any release. `deploy.sh` run by hand from an
   older checkout cannot be refused from here.

**How the floor is expressed: the alternatives.** (a) In the publisher's own spec: make migration
4 forward-only (`readableFrom` 4): rejected in D64 (e), it refuses every tenant's storage on a
rollback to protect only those with span or log changes, and says nothing for viz-query, which keeps
no storage. (b) A constant in each component (`READS_SIGNAL_DATA`) read like `FORMATS`: the cleanest
end state, but it needs edits in publisher/, query/ and the write path that this change does not own,
and versions from before it would be unmarked either way. (c) A format version (`ingest.signal-data`
2 written by viz-ingest when the switch is on, read by the floor Workers): the generic rollback rule
judges versions since the target of the target's Workers, which misses the cross-Worker case of a
record naming only viz-query; and the writer's version is a var, not a code constant. (d) A floor
release recorded in KV or R2: D46 (c)'s objections. (e) Schema versions alone: viz-query has none and
D63 changed no schema of viz-ingest's. Chosen: the rule in `workers.json` (writer, switch, Worker,
floor, why), judged by schema where one marks the floor and by an evidence stamp otherwise.

**Which of the review's two shapes (M-4).** It offered: refuse a rollback below the release that
first set `INGEST_SIGNALS`, or mark that release forward-only for those Workers. Neither as such; the
floors are per Worker. Since a release that sets the switch is refused unless every floor Worker is at
its floor in it and as it serves, the first release with the switch on is at or above every floor, so
"below that release" is at least as strict as "below the floor" and is stricter only for rollbacks
that are safe: to a release whose Workers are all at their floors with the switch off (the release
just before the switch, whose automatic rollback this keeps), and the publisher from D67 to D64, which
`publisher/test/signals.test.ts` shows is served. Marking forward-only would also stop deploy.sh's
automatic rollback of the release that sets the switch, although its target is at every floor; and
in this tool a forward-only mark is not what a rollback reads (it reads the versions), so a floor has
to be judged from the versions anyway.

**m-5 (D64 must ship as its own release).** The floor is "schema 4 or later", whatever served. If D64
and D67 reach a deployment in one release, no publisher at exactly 4 ever serves there: the oldest
reachable publisher once the switch is on is the first with D67, the D67→D64 rollback shown by the
publisher's tests does not exist there, and nothing is lost by that. The tool cannot make D64 ship
alone (it deploys whatever commit it is given, and both are on the same branch now); D64 serves first
only if a release of a commit that has D64 and not D67 is deployed, and nothing in production has
been. `deploy/README.md`, "Rollback floors", says so.

**Alternatives the review of D69 raised.** Formats across Workers (M-1): (l) judge only the serving
version of a Worker a record leaves out (the review's suggestion): misses one rolled back since, whose
newer kept versions wrote what its serving one no longer does; (m) refuse records that leave Workers
out: loses the only way round the rotation refusal and the one-Worker way out of m-8; (n) keep "a
Worker that does not declare a format does not read it" (D69's): edge, shard routing and query read
control's KV records without declaring them, so no rollback or release ever asked them; (o) have the
components declare their reads: the end state, but it needs edits in edge/, query/, stack/ and
contracts/ that this change does not own; until then `workers.json` declares them and a test holds it
to the bundled sources. Older commits (M-2): (q) run main's tooling on the older commit's components
in one checkout: `workers.json` from main names sources, evidence exports and Workers an older commit
may lack, so configure would refuse many commits for reasons that have nothing to do with safety, and
the gateway (in `deploy/`) would come from main; (r) refuse a commit that does not descend from the
floors' commit (`git merge-base --is-ancestor`): it depends on history's shape (a squash merge into
main loses the development branch's commits), and a descendant may still lack later fixes, this
review's among them; (s) a release-safety level in the tooling that the workflow compares with
main's: right only if every change that refuses more bumps it by hand. Chosen: main only, older code
back through a commit on main. Floors: (t) carry the switch's evidence forward in every later
version (m-1) and (u) re-check the floors before each restore step (m-4): not built, recorded as
known risks with the review's scenarios.

**Alternatives for the rest.** Formats: (f) record only the formats whose read and write sets differ
(the gate): a later bump of any other format would go unjudged; recording every `FORMATS` map, with a
test that no map in a deployed component is left out, costs a var of under 1 KB per Worker. (g)
Treat an old record as reading every version: a guess in the unsafe direction. (h) Refuse old records
outright as D46 does: it would also refuse the rollbacks that are safe today. Run marks: (i) put the
mark in the tag or message: `versions secret put` overwrites both on the keyed version, so they cannot
say which upload it was built on. (j) A lock in KV: another store, eventual. Secrets: (k) force the
rotation rollback through the API (`?force=true`): the old key serves only until the next release
takes the rotated one back (S9), and the clients registered after the rotation break meanwhile.

**Why.** Each refusal is computed from what Cloudflare keeps for every version (vars) and from the
release record, as D46's, so the evidence lasts as long as a rollback is possible and needs no store
of its own; each happens before anything is uploaded or moved. Per-Worker floors refuse exactly the
states the reviews reproduced (a pre-D62 query handing span batches to a metrics read; a pre-D64
publisher stopping tenants; a pre-D63 write path stalling flush and retention) and allow every
rollback that keeps each Worker at its floor.

**Verified** (here, nothing deployed, the Cloudflare API not called; fakes of wrangler and the API that
model S9's measurements: `deploy/README.md`, "How it was verified"): 36 new tests; of the 35 tests in
the two files that drive the real deploy, plan and rollback, 23 fail against the release tool as it
was before this change (the rest are the earlier secrets tests and a negative control; the other 13
new tests are unit tests of new functions); mutants in a scratch copy: release 41 of 41 killed, secrets 31 of 31 (first runs 40 of 41 and 30 of
31; each survivor was fixed by a test or a corrected mutant, as listed there). After the review of
D69: its reproductions are regression tests (`deploy/test/review-d69.test.mjs`, 12, and
`deploy/test/workflow.test.mjs`, 2); against the tool as the review read it, 13 of the 14 fail (12
on their assertions, one, the API timeout, by hanging until the event loop drained), and the one that
passes is RV-3's half that already held (the current tool refuses the release `b322599` would make);
all pass now. Mutants of the fixes: see `deploy/README.md`, "How it was verified".

**Cost of it.** Configure bundles more source (the `FORMATS` maps). A rollback reads one more version
per format-bearing Worker per version since its target; a rollback below a floor, and a release
whose Worker is below one, read the writer's versions until one with the switch (up to 100). The
first release with format records over a deployment without them is forward-only (viz-ingest writes
`r2.dead-letters` 2, which a release without records is taken not to read), and rollbacks to records
from before this change across a viz-ingest upload are refused; nothing is in production, so that is
paid on stages only. The switch needs a release with this change (stamps) to have served first.
Since the review of D69: a deploy and a rollback read the live state of every Worker in
`workers.json` (one deployment read and one version read each); a deploy reads viz-ingest's version
list and one or two versions for a secret switch; a rollback that leaves a Worker that writes formats
out reads its versions since the record (up to 100); and the first release with complete read
declarations over a deployment with D69's is forward-only again, as is a rollback to a D69 record
across a viz-ingest upload (stages only).
Evidence is a guard against a declaration outliving its code, not proof of behaviour: the floor of
viz-query and viz-ingest rests on the declaration in `workers.json`, added with this change, after
D62 and D63. A forced rollback outside the tool (wrangler, the dashboard) is not checked.

**Would change if.** Components declare their own floors or read versions (then `workers.json`
points at them, and evidence and `reads_v1` go); a second switch appears (another rule); Cloudflare
keeps deployment history the tool can read (then "the switch was on" need not be found among
versions, and m-1 goes); the key can be rotated with overlap (D53); GitHub lets a repository refuse a
ref for every workflow file, old ones included (then the environment rule is not the only guard of
point 5); or an upload can inherit a secret from a version named by id through wrangler (then m-6 has
a way out that keeps the key).

## D70. OAuth is rate-limited in two layers: Cloudflare's Rate Limiting binding before any object, counting each presented credential and then its tenant (a fuse near one object's capacity), and a network only where no genuine credential is involved, failing open within 100 ms; codes and tokens carry an expiry the Worker checks under their tag; and an exact per-grant refresh limit in the tenant's object

(Written 2026-11-19 for the review of D44, M-2: "a rate limit in front of `/oauth/token`,
`/oauth/revoke`, `/oauth/register`, `/oauth/authorize` and OAuth bearers before public exposure".
**Rewritten the same day after its adversarial review**, `reviews/d70-rate-limits.md`, which
rejected layer 1 as built (B-1, M-1, M-2, m-1 to m-8). **This replaces the first version of D70.**
That version keyed the token endpoint per presented `client_id` and then per tenant, and
revocation per tenant only. It set the tenant budgets at 5 and 50 a second, counted every request
by network, and gave each check 1 s. So one dead credential of a tenant could refuse all of that
tenant's OAuth in a location. Layer 2, the refusal and the contract status stand as first written.)

**What needs limiting, from the code** (costs measured here, `control/test/oauth-cost.test.ts`:
local workerd, sequential, three runs; `control/README.md` has the table). Since the tag (D44) a
made-up credential reaches no object. Registration (0.18–0.41 ms), the authorization page
(0.23–0.52 ms) and a forged code (0.16–0.33 ms) cost the Worker alone and write nothing; anyone can
send them. What reaches a tenant's object is a credential this deployment made:
- a code exchange or a refresh: 4.3–8.4 ms, 9 rows and 2 `setAlarm`, so about 11 billed row writes
  each;
- a revocation: 1 to 18 rows;
- an introspection: 0.9–1.5 ms, no write;
- a **replay** of a spent, rotated or revoked credential: 0.75–2.1 ms, one object request, no write.

The review showed what the first version missed: a credential's tag never expired. A dead
credential was therefore as good as a live one for spending any budget keyed after the tag. And
anyone may hold dead credentials: a former client, a debug log, a code left in shell history. An
approval (17 rows, 2 alarm writes, 1 KV write) needs a person's admin key and was already bounded
exactly (20 a tenant an hour).

**Decision.**

- **Credentials carry their expiry** (`contracts/oauth.ts`, layout 2 of format version 1). The 27
  characters before the tag are now the marker `e`, the expiry, and 22 characters from a CSPRNG
  (about 131 bits). The expiry is in whole minutes since 2026-11-01, rounded up, so it is never
  earlier than the expiry the tenant's object stores. The tag covers it, as before.
  - `/oauth/token`, `/oauth/revoke` and introspection refuse a tagged credential once its expiry and
    60 s more have passed. They answer as the object would (`invalid_grant`, 200, `inactive`
    `expired`), before any limit counts the request and before any object is asked.
  - Codes die in the Worker 10 minutes after issue and access tokens after an hour. A former
    client's stock of dead credentials shrinks to its refresh tokens (30 days) and to the access
    tokens of its last hour.
  - The shape and the tag are unchanged, so every earlier reader of version 1 reads layout 2: the
    previous release's control and the agent surface's `parseCredential` see 27 opaque characters.
  - Layout 1 credentials, issued by the previous release, carry no expiry. They go to the object as
    before until they expire there. Both skews are tested (`test/ratelimit-review.test.ts`). None
    had been issued in production.
- **Layer 1, approximate, before any object: the Workers Rate Limiting binding**
  (developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/, read 2026-11-19, page
  modified 2026-11-12). Six bindings, period 60 s each. The limits are deploy configuration,
  proposed here (`control/README.md`, "Needed changes elsewhere"):

  | Binding | Key | Proposed limit per 60 s, per Cloudflare location | Where | What it bounds |
  |---|---|---|---|---|
  | `OAUTH_RL_SOURCE` | client network: IPv4 address or IPv6 /64, from `CF-Connecting-IP` | 120 | `/oauth/register` (POST) and `/oauth/authorize` (GET, HEAD) before the body is read; `/oauth/token` and `/oauth/revoke` only for a request the Worker refuses by itself | one network's Worker CPU: 2 a second |
  | `OAUTH_RL_SOURCE_48` | IPv6 /48 | 1,200 | the same, after the /64 | one host's routed /48 (65,536 /64s): ten networks' worth |
  | `OAUTH_RL_CREDENTIAL` | the presented code, refresh token or access token (SHA-256 prefix), tagged and not expired | 5 | `/oauth/token` and `/oauth/revoke` | one credential's object requests: a code or token is presented once, plus retries |
  | `OAUTH_RL_TENANT` | its tenant | 6,000 | the same, after the credential | a fuse: OAuth token traffic on one object, 100 a second |
  | `OAUTH_RL_BEARER` | the access token (SHA-256 prefix), tagged and not expired | 1,200 | introspection (`OAuthIntrospection`) | one agent's `/mcp` requests: 20 a second |
  | `OAUTH_RL_BEARER_TENANT` | its tenant | 30,000 | introspection, after the token | a fuse: introspection on one object, 500 a second |

  - **The narrower key is asked first**, and a refused call does not count. So one credential
    spends its own allowance and at most that much of its tenant's fuse a minute, in each location.
    A request refused by a fuse has still been counted against its credential.
  - **Spending a fuse takes many distinct credentials that are tagged and unexpired**: the fuse
    divided by the per-credential limit. That is 1,200 at the token endpoint and 25 at
    introspection.
  - **No per-client key.** The first version's was keyed on text the request chose (R1). A key on
    a `client_id` whose MAC verifies would be no better: client ids are public, so any dead
    credential sent with the victim's id would spend that client's allowance (R1b).
  - **The fuses are sized** to protect the object, not to meter clients:
    - The token fuse is 20 times the most live traffic layer 2 lets a whole tenant make: 6 refreshes
      a minute times 50 grants, 300 a minute from all locations together. 100 a second is 8–21% of
      one object busy with replays at 0.75–2.1 ms each (measured here).
    - The bearer fuse is 10 times 50 grants calling `/mcp` once a second (review m-5). It is 45–75% of
      the 670–1,100 introspections a second one object served here (0.9–1.5 ms each).
    - Per bearer, 20 a second leaves room for an agent's parallel tool calls (m-5).
    - These ratios are modelled, not measured on traffic.
  - **Networks.** A genuine credential is never counted by where it comes from (review M-1). Every
    MCP client hosted on Cloudflare Workers arrives from one address. Brokers concentrate all their
    users' refreshes behind a few egress addresses.
  - **The Workers address is not counted at all**, at any endpoint. Every cross-zone Worker
    subrequest arrives from `2a06:98c0:3600::103` (developers.cloudflare.com/fundamentals/reference/
    http-headers/, read 2026-11-19, page modified 2026-11-15; verified there). Counting it would let
    anyone with a Workers account refuse every Worker-hosted client. Its requests then cost this
    Worker's CPU only: registration and the authorization page store nothing. Their senders pay for
    their own Worker requests.
  - **IPv6 is counted by /64 and by /48** (m-6). A tunnel broker hands one host a routed /48, which
    is 65,536 /64s; a /56 home allocation is 256 of them (training knowledge). One host with a /48
    gets 1,200 a minute, not 7.8 million.
- **Every binding check fails open**, for every endpoint, when the binding is absent, throws, does
  not answer `{ success: boolean }`, or has not answered in time.
  - **Time**: all of one request's checks share 100 ms. A binding that failed is skipped by that
    isolate for 10 s.
  - **Brownout cost** (m-1): the review measured a refresh at 3,035 ms and an introspection at
    2,005 ms with hanging limiters. Now one request per binding, per isolate, every 10 s, waits up to
    100 ms. Measured here (local workerd, limiters that never answer): the first two refreshes
    105–129 ms, then 14 ms; introspections 104–105 ms, then 2 ms.
  - **Logs**: an absent or failing binding is logged once per isolate, never per request (m-2).
    `/healthz` lists each limiter as `bound`, `absent` or `skipped`, and whether `OAUTH_CLIENT_KEY`
    is set.
  - **Why open, per endpoint.**
    - Registration and the authorization page store nothing and reach no object. A closed failure
      would refuse onboarding and protect nothing.
    - At the token endpoint, revocation and introspection, the tag and the expiry still keep
      made-up and expired credentials from every object, and layer 2 still bounds writes exactly.
      What an open failure lets through is object requests from holders of unexpired genuine
      credentials, for as long as the fault lasts.
    - A closed failure would end every agent's access within the hour its access token lasts. It
      would also block revocations, which a client sends to end access.
  - **The exact limits** in layer 2 cannot fail open: they are statements in the request's own
    transaction.
  - **The deploy enforces that the bindings exist**, not the Worker: it is to refuse a production
    viz-control without them (a needed change, restated in `control/README.md`).
- **Layer 2, exact, in the tenant's object, where rows are written:** at most 6 refresh tokens per
  grant in any 60 s (`OAUTH_LIMITS.refreshesPerGrantPerMinute`, the code exchange's included).
  - It is counted from the `oauth_tokens` rows the object already keeps: no new state, one read.
  - It is checked after reuse detection and before the presented token is spent.
  - With the approvals, clients and live grants D44 bounds, this is what bounds writes, from any
    number of locations.
  - **Worst case per tenant** (m-7; modelled, list prices as training knowledge): 50 grants × 6
    refreshes a minute × about 11 billed rows is 3,300 row writes a minute. That is about 4.75
    million a day, about $4.75 a day per tenant, plus about 432,000 rotated refresh-token rows kept a
    day. Per grant it is $0.10 a day. Only the tenant's own approved clients can drive it.
- **Refusal**: 429 with `Retry-After`, `Cache-Control: no-store`, the endpoints' CORS headers, and
  `{ "error": "too_many_requests", "error_description": … }`.
  - `Retry-After` is 60 for a binding, which does not say where in its window it is. For the
    per-grant limit it is the exact time.
  - The authorization page answers a plain-text page with the same code.
  - No credential is spent, and nothing in the object changes. A request the token endpoint or
    revocation refused by itself has had its body read.
  - RFC 6749 §5.2 has no rate-limit code. `too_many_requests` is what the MCP TypeScript SDK's own
    authorization server sends with 429 on these endpoints. That SDK's client maps it to
    `TooManyRequestsError` and keeps its credentials (verified in `@modelcontextprotocol/sdk`
    1.32.2): an unknown code becomes a `ServerError`, after which that client starts a new
    authorization, and `invalid_grant` makes it discard its tokens.
  - **The Python SDK** (`mcp` 2.3.0, `_handle_refresh_response`; read by the review and again
    here) discards its tokens on any refresh answer that is not 200. For its clients no refusal code
    is safe: any refusal of a live refresh means a person approves again. That is why the limits are set so that only the client itself, or someone
    holding many of the tenant's unexpired credentials, can make the Worker refuse a live refresh.
  - Introspection answers the status `rate_limited` with `retryAfterMs` (`contracts/oauth.ts`,
    additive within version 1). The agent surface maps it to 429 with `Retry-After`.
- **Not limited**: the RFC 8414 metadata (static, `max-age=300`), CORS preflights, and requests with
  a method an endpoint does not serve (m-3: the first version counted a preflight of the
  authorization page).
- **Assumed**: viz-control and viz-mcp run without Smart Placement (m-8). With placement their
  invocations gather in a few locations, and the per-location budgets become nearly global, the
  fuses with them. A control test checks both Workers' `wrangler.jsonc`. A check in the deploy's
  configure is a needed change.

**What an attacker can still do** (modelled unless marked):
- **Someone holding unexpired dead credentials** of a tenant gets 5 object requests a minute per
  credential at the token endpoint, and 1,200 at introspection, in each location they reach.
  - To trip the tenant's token fuse in one location they need about 1,200 distinct refresh tokens
    or codes within their lifetime. To trip its bearer fuse they need 25 access tokens less than an
    hour old.
  - A client that refreshed hourly for a month holds about 720 refresh tokens. Making 1,200 takes 3
    hours and 20 minutes at layer 2's maximum, and 25 access tokens take about 4 minutes. Only a
    client the tenant approved can do that, and while approved it could spend the fuse with live
    tokens anyway.
  - The effect, while it lasts, is that tenant's refreshes and revocations (or `/mcp` calls) in that
    location are refused. TypeScript-SDK clients keep their tokens; Python-SDK clients need a person
    to approve again. Revoking the client ends it within the hour for `/mcp`; for the token endpoint
    it lasts until its refresh tokens expire, 30 days.
- **Layout 1 credentials** (none in production) carry no expiry. Until they expire they still spend
  their allowance and the fuse, as before.
- **A host with many /48s, or many hosts**, gets 1,200 registrations and authorization pages a
  minute per /48 and 120 per IPv4 address. **Worker-hosted senders** are not counted at all. Either
  way this costs the Worker's CPU (0.2–0.5 ms each), never an object or a row.
- **A Worker in the same zone** (`bitcru.sh` holds unrelated hostnames) sets `CF-Connecting-IP` from
  its own `x-real-ip` (the headers page; verified there) (m-4). It can therefore evade the source
  limit, or spend a chosen network's registration and authorization budget, such as a broker's
  egress.
  - Neither the gateway nor control reads `x-real-ip` (checked in `deploy/gateway/src` and
    `control/src`).
  - Since M-1, genuine credentials are not counted by network, so this cannot refuse a refresh.
  - A future internal caller by service binding sends no `CF-Connecting-IP` and shares one key,
    `none`.
- **A flood spread over N locations** gets N times every per-location limit ("Other Cloudflare
  locations maintain separate counts"; "Requests can exceed your configured limit before those
  updates arrive"). NAT and carrier-grade NAT share one network's budget at the two endpoints that
  count networks.

**Alternatives, with what each costs and what an attacker can still do** (cost per request
modelled: Cloudflare list prices as training knowledge, Workers $0.30 a million requests, Durable
Objects $0.15 a million requests and $1.00 a million rows written; a service-binding call is not
billed as a request).

- (a) **The binding alone**, keyed as above. Cost: the page names no price and says a check "uses a
  locally cached count"; modelled $0 to unknown, 0.01–1 ms. Measured here only through miniflare,
  whose binding is a SQLite-backed object: 2.1–4.0 ms for a registration with the source limit asked,
  against 0.18–0.41 ms without, and 0.62–0.99 ms for one it refuses. That is an upper bound for
  local workerd, not Cloudflare. Still possible: per location and approximate (above). Every refused
  request is still a billed Worker request. Its `namespace_id` is account-wide in an account with
  unrelated Workers.
- (b) **A Durable Object counter** (exact, global). Cost per check: $0.15–1.15 a million (a request,
  and a stored row if every count must survive), on every request; 1–10 ms in the object's region,
  50–300 ms from another continent. A counter object is single-threaded, so a flood moves to it.
  Rejected as the first layer; kept where it is free, inside the tenant's object (layer 2).
- (c) **A WAF rate-limiting rule on the zone** (`vis.bitcru.sh` only): the only layer that saves the
  request charge. But it counts by IP and the like and cannot see a credential, and it is outside
  the release. Recommended in addition, by hand, as the volumetric layer; not built.
- (d) **A binding keyed by tenant before the tag check**: it hands any tenant's budget to whoever
  writes its name into a made-up credential. Rejected.
- (e) **Fail closed** on a limiter fault, for all or some endpoints: rejected above.
- (f) **Per presented `client_id`**, then per tenant at 5 and 50 a second (the first version): any
  one dead credential spends the tenant's budgets (R1, R2, R3) or a named client's (R1b), at 5
  requests a second. Replaced.
- (g) **Per `client_id` whose MAC verifies**: still spent by any dead credential sent with the
  victim's public client id (R1b). Rejected.
- (h) **No tenant keys at all** (the review's option (b), first half). An attacker holding many
  unexpired dead credentials then loads the tenant's object without bound. A month of one client's
  refresh tokens at 5 a minute each is 60 replays a second, 4.5–13% of the object per location at
  0.75–2.1 ms each, and all of it from enough locations. That slows the tenant's whole control plane, not
  only its OAuth. Fuses near capacity refuse only when the object would be loaded anyway.
- (i) **A per-location cache of credentials found dead** (the review's option (a), second half;
  Cache API keyed by the credential's hash). It would cut each dead credential to one object request
  per location per cache lifetime, and so remove the farming residual above. Not built:
  - the Cache API page (read 2026-11-19) says Workers on custom domains have functional cache
    operations, and says nothing of a Worker reached only through service bindings, as viz-control
    is;
  - it would add a cache lookup to every token request and every `/mcp` introspection;
  - revocation's RPC result does not say whether the token was known.
- (j) **Per-isolate memory of dead credentials**: free, but an isolate is a small share of a
  location. Not built.
- (k) **A new credential version** (`vza2`, …): a release that reads only version 1 would refuse it.
  On a rollback, or during a gradual deployment, the previous control release and the agent
  surface's `parseCredential` would refuse it, and clients discard tokens refused as `invalid_grant`
  or 401. So it needs readers first, which is two releases (COMPATIBILITY.md §3.3).
  - Layout 2 within version 1 needs neither: the previous release's checks accept layout 2
    (tested).
  - The cost: 22 random characters instead of 27, which is 131 bits instead of 160. RFC 6749 §10.10
    asks for at most 2^-128, and the 16-character tag, which only `OAUTH_CLIENT_KEY` makes, adds to
    it for anyone without the key.
  - A layout 1 body begins with `e` one time in 62 and is then read with an expiry uniform over 28
    years. So about 1 in 13,000 layout 1 credentials could be refused as expired early, in the month
    they can live after the change.
- (l) **An issue time instead of an expiry**: every reader would need the lifetimes, which a later
  release may change. Rejected.
- (m) **A 1 s timeout per check** (the first version): a brownout added 3 s to each refresh and 2 s
  to each `/mcp` request. Replaced by one budget per request and the skip.

**Why.** The properties that matter are exact:
- no made-up credential reaches an object (the tag);
- no expired credential does either (the expiry under the tag);
- what a tenant's object stores is bounded inside it (approvals, clients, grants, refreshes per
  grant).

What remains is cost, which is approximate by nature, and the cheapest approximate counter is the
binding. Keying the narrow limits on the credential itself means each credential spends only its own
allowance. So a tenant's OAuth can be refused in a location only by someone holding many of its
unexpired credentials, which in practice means a client it approved. The fuses then refuse only
where one object would be loaded anyway. Counting networks only where no genuine credential is
involved keeps shared egress addresses, Cloudflare's own and brokers', from refusing anyone's
refresh. The expiry inside version 1 gets the Worker its check without the two releases a new
version would take.

**Would change if.**
- **Bindings and the Cache API**:
  - the Cache API is shown to work, and to be cheap, for a Worker reached only through service
    bindings (then (i), keyed by the credential's hash, for the token endpoint and revocation first);
  - the farming residual is seen in practice (then (i) or (j));
  - `limit()` is measured on Cloudflare above about 50 ms (then a larger budget, or the checks in
    parallel);
  - the binding is billed per call at a price that matters;
  - the per-location counts are measured to let a flood that matters through (then a WAF rule in
    front, or an exact counter for the fuses).
- **Platform and clients**:
  - Cloudflare changes the address of Worker subrequests, or documents more of them;
  - viz-control or viz-mcp is given Smart Placement (then the fuses become nearly global and must be
    raised, or the placement refused);
  - MCP clients converge on another rate-limit code, or the Python SDK stops discarding tokens on a
    429.
- **viz itself**:
  - a version 2 of the credential is needed for another reason (then the expiry moves into it and
    layout 1's reading ends);
  - viz moves to a plan or product where zone rules are managed with the release (then (c) carries
    the source limit);
  - a sign-in replaces approval by API key (the authorization page becomes a form and may need its
    own limits).

## D71. Edge counts what it builds while decoding: an item (span, resource and scope, log record, data point) of more than 65,536 key-value entries and array elements is refused at the limit, not built; a request decodes into at most 16 MiB and a JSON body has at most 2^20 structural characters (413 otherwise); a body is at most 8 MiB decompressed

(Written 2026-11-19 for the review of spans and logs end to end, M-3: "count attributes, array
items and value bytes while decoding, and refuse at the limit before materialising. Lower
`maxDecompressedBytes`. Measure in workerd.")

**What was wrong, measured here** (`edge/bench/memory.mjs`: local workerd 2026-11-17, V8 heap
from `--trace-gc`, peak = the largest heap any GC saw, one run per case; Node 22 alongside). Every
decoder built every key-value entry and array element of an item as JavaScript objects and
checked the limits afterwards, so a body of two-byte entries cost 25 to 40 bytes of heap per byte:
a 4 MiB resource of empty `KeyValue`s peaked at 139 MiB in workerd (245 MiB in Node), a span of
empty attributes at 159 MiB, OTLP logs and metrics alike (113 to 124 MiB), a Loki entry of empty
metadata at 120 MiB, JSON of empty attributes at 76 to 135 MiB (one run each; an earlier run of
the same bodies differed by up to 12%). At the old default of 32 MiB
decompressed, which a 32 KB gzip body reaches, that is about 1.2 GB (extrapolated). Found while
fixing it: a resource's labels are copied into every series of it, so a valid 157 KiB OTLP
metrics body (one 96 KiB resource, 2,000 points) built a 498 MiB series table (Node, ArrayBuffers;
2.1 GB at 350 KiB), live on `main`; 4 MiB of empty `ScopeSpans` took 17 to 20 s to decode in Node (each scope
re-encoded its resource); offset arrays grew with every child message; each accepted span or log
record was a JavaScript object of about 290 / 100 bytes (30 / 19 MiB retained for 107,546 minimal
spans and 200,000 minimal records); a 4 MiB span name grew the row buffer to 12 MiB; a data point's
attribute names were matched with `indexOf` (quadratic: 0.5 s for 229 KiB).

**Decision.**

- **Values per item, counted before building** (`edge/src/meter.ts`). Every key-value entry and
  every array element, at any depth, as received, is counted against its item before it is
  built: a span with its events and links, a resource with one scope (spans), a log resource, a
  log scope, a log record, a Loki entry or label set, a metric resource, a data point. At 65,536
  the item is refused on its own (OTLP `partial_success`, Loki 400; a metric point as "label set
  too large to fit one batch"), its remainder is read only to check the wire (lengths, wire
  types, nesting, UTF-8 for metrics), and the rest of the request is decoded as before. Events and
  links past the 128th are read and not built. Contract: `contracts/BATCH.md`, "Decode limits".
- **Per request: 413, nothing appended**, when the decoded series table (metrics) or entries and
  rows (spans, logs) pass `maxDecodedBytes` (16 MiB), or a JSON body has more than
  `maxJsonTokens` (1,048,576) structural characters, counted before `JSON.parse`.
- **`maxDecompressedBytes` 32 → 8 MiB.**
- **Shape of the decoders:** a protobuf level is read twice (what its children need, then the
  children) instead of keeping an offset per child; a resource is encoded once for all its scopes
  and an entry is found again by resource and scope bytes; rows are bytes in one buffer (no
  object per row), the buffer doubles only up to the decoded limit; a request's body is released
  once decoded; a point's attribute names are found in a `Map`. Decoded batches are identical
  (`edge/bench/differential.mjs`: 1,294 requests against the tree before, 605 metrics requests
  against `main`).

**After, measured here** (same harness): the same hostile 4 MiB protobuf bodies peak at 0.1 to
6.0 MiB in workerd (the worst, 65,536 nested key-value lists in one span) and every protobuf body
measured at 6.9 MiB or less; hostile JSON is 413 before parsing, and JSON just under the token
limit peaks at 28.2 MiB (the worst JSON shape found); the metrics fan-out is 413 at 16 MiB; 2
million empty scopes, spans or records take 29 to 465 ms in Node (wall time). Realistic bodies of 8,200
items peak at 1.4 to 3.2 MiB (protobuf) and 8.1 to 17.1 MiB (JSON) in workerd, against 3.1 to 7.6
and 8.3 to 28.6 before. `edge/README.md`, "Memory per request", has the table and the model.

**Why 8 MiB.** Realistic batches of 8,200 items measured here are 0.4 MiB (Loki, snappy) to 3.4 MiB
(traces) as protobuf and 1.6 to 7.1 MiB as JSON; they decode into 1.9 to 3.7 MiB. Clients' defaults
(training knowledge, not verified here): the OpenTelemetry Collector's batch processor sends 8,192
items (`send_batch_size`) and does not cap a batch unless `send_batch_max_size` is set; SDKs export
512 spans or records at a time; gRPC's default largest message is 4 MiB; the Collector's HTTP
server refuses bodies over 20 MiB by default; Prometheus sends 2,000 samples (625 KB measured here)
and Promtail and Alloy 1 MiB of log lines. 8 MiB holds the Collector's default batch twice over as
protobuf and once as JSON spans; the README's earlier advice was 8 to 16 MiB.

**Why 65,536 values.** It bounds an item's objects to what was measured above (6.0 MiB at worst)
while every item real senders make has tens to a few thousand values; items with more were valid
but absurd (a log body that is an array of 100,000 numbers). An item of exactly 65,536 values can
still be stored, and is, in the tests, for each signal.

**Why 16 MiB decoded.** About four times the realistic batches above (3.7 MiB for 8,200 spans); a
Kubernetes resource of about 25 attributes (about 1.4 KiB a series, modelled) makes 8,192 points
about 11.5 MiB. It is what stops a resource's copies: the 157 KiB body above.

**Alternatives.**

- *Count after building* (as before): the measurements above.
- *A byte budget per item* (a lower bound of the stored size against the 256 KiB row and entry,
  64 KiB metadata and series limits) instead of a count: exact for well-formed input, but one
  lower bound must hold for five mappings (typed attributes, canonical JSON, plain JSON, flattened
  log metadata whose names are shorter than their keys, metric labels that drop empty values), and
  it still needs a count for entries that map to nothing. Would change if the count refuses items
  real senders make.
- *Build nothing: write each mapping straight from the wire*: the least memory, but every mapping
  re-implemented over the wire, the live metrics one included. Would change if 6 MiB per item is too
  much.
- *Refuse the whole request (413) for an item over the limit*: simpler, but one bad span would drop
  a sender's batch, against the per-item refusals the contract and OTLP's `partial_success` define.
- *One budget per request*: a large honest request would be refused for the sum of its items; the
  body and decoded limits already govern a request's size.
- *A streaming JSON parser* counted like protobuf: no pre-scan, more code; `JSON.parse` is native,
  the pre-scan costs about 3 ms per MiB (Node).
- *`maxDecompressedBytes` 16 MiB*: holds JSON batches of 16,000 spans, at twice the memory (modelled);
  *4 MiB* would refuse a default Collector batch of spans as JSON (7.1 MiB measured).

**Would change if.** Cloudflare measurements of isolate memory per request differ from these local
ones (`design/VERIFICATION.md` §4: run the hostile and realistic bodies against a deployed edge and
read the isolate's memory from Workers analytics); senders' bodies seen on Cloudflare are larger
than 8 MiB, or metrics with wide resources reach 16 MiB decoded (then resource attributes go to
`target_info` instead of every series, or the series table becomes chunks); OTLP clients learn to
split on 413; a real sender's item passes 65,536 values.


## D72. A shard records each span and log batch's time bounds when it appends it, in the batch's row; a filtered tail read with a time range skips a span or log batch whose bounds lie outside it, and keeps every batch without bounds

(Written 2026-11-19 by the shard engineer, after review finding m-3 of
`design/reviews/signals-end-to-end.md`. It replaces one part of D63, "the time range and series
fields select metric rows only, and a span or log batch it admits is returned whole", which was
D63's alternative (e) at batch granularity, named in its "Would change if".)

**Decision.** At append, the shard reads a span batch's `start` column, or a log batch's `ts`
column, by walking the entry table's length fields (no decoding, no strings), and stores the floor
in milliseconds of the smallest and largest value in two new nullable columns of the batch's row
(`batch.min_ts`, `batch.max_ts`, schema 3, additive, `readableFrom` 1). A metric batch, an empty one
and one the walk cannot follow get NULL, and the append is never refused for it. A filtered tail
read with `minTs`/`maxTs` skips, in its SQL, a batch whose bounds lie wholly outside them, without
reading its payload; a batch with NULL bounds is always kept. Everything else of D48 stands:
pages, cursors (the range is in the filter they are bound to), `through`, the fence, refusals; a
kept span or log batch is returned whole. The contract text is `contracts/BATCH.md`, "Tail reads
of spans and log records by time". The batch format does not change.

**Alternatives.** (a) The bounds in the batch header, written by `edge` (a new `VZB1` field, or the
reserved bytes): a format change readers must know first (two releases, COMPATIBILITY §3.3), and a
shard that trusts what edge wrote, where now it derives the bounds from the column every reader
decodes. (b) The bounds as arguments of `append`, from `edge`, as `seriesIds` are: a contract change
on the ingest path and a trusted value no reader can check. (c) A table of bounds, one row per batch:
a second row write on every append (billed per row, AGENTS.md) for what fits in the batch's row.
(d) A new filter field in nanoseconds (decimal strings) instead of the existing `minTs`/`maxTs`: exact
to the nanosecond, but the stored bounds are milliseconds either way (a nanosecond does not fit a JS
number or, safely, the SQL API's integers) and the floor is exact for overlap (D63), so it would add a
second time model and a second canonical form for cursors for no batch kept or skipped differently.
(e) Filter rows inside span and log batches (D63's (e) as written): rewriting batches with entry tables
and variable-length columns on the thread that acknowledges writes, for rows the reader filters anyway.
(f) Backfill the bounds of stored rows: a migration over an unbounded table (COMPATIBILITY §2.2) for
rows that leave the tail within minutes; NULL is the safe reading of "unknown".
(g) The same columns for metric batches (their `ts` column can be found from the end of the batch):
it would let a metrics read skip batches without scanning their series tables, but D48 measured
that a metric batch spans most of a tail's times, and the rows are filtered anyway; not done here.

**Why.** Review m-3: a span or log query read the signal's whole tail whatever its window, and the
tail's bytes count against `maxFetchBytes` (16 MiB), so a tenant with four or more span or log
shards near the seal size was refused 422 on every trace or log query (modelled). The bounds come
from the bytes every reader decodes, so they cannot disagree with the rows; skipping is only ever by
bounds the shard computed itself, and a batch it knows nothing about is kept, so the only effect of
a wrong or missing value is a read that returns more, never less. One read of a column of at most
1 MiB costs microseconds at append (below), against milliseconds for the append's transaction.

**Correctness for traces.** A query that needs every span starting in the nanosecond bound
`[lo, hi]` (the window widened by `traceMarginMs`, D62) passes `floor(lo / 10⁶)` and
`floor(hi / 10⁶)`, as `msRange` already computes. For a span at `t ∈ [lo, hi]`, `floor(t / 10⁶)`
lies in that range and in its batch's bounds, so the batch overlaps and is returned. Tested over 200
random nanosecond bounds against six hours of spans, with bounds on and next to span starts and
millisecond edges (`shard/test/bounds.test.ts`), and killed when either comparison is off by one.

**Measured** (here, local workerd, 2026-11-19, three runs at load average 3.0 to 3.9;
`shard/bench/results/signaltail.txt`). Eight hours of tail, one batch per ten minutes of start time,
48 batches: spans 18.74 MB, logs 16.79 MB. Bytes a one-hour query takes from the shard: spans, the
read query makes today, 18,736,064 (over the 16 MiB budget: refused); a span-local hour, 2,343,888
(6 batches); a search with the 2-hour margin, 11,719,440 (30 batches); an hour a day before the
tail, 0. Logs: 16,791,072 today (over the budget), 2,100,928 for the hour, 0 a day before. In each
case the read held, byte for byte, every batch in which the engine's flush finds a row inside the
bound. Time per read, medians of five: 19 to 35 ms whole, 8 ms for the hour, 19 to 22 ms with the
margin. Appends, the same 96 batches (35.5 MB) to this release and to the release before (frozen),
three runs alternating: 362 to 457 ms against 369 to 497 ms in all, no difference beyond the spread;
the walk alone, timed in Node 22, 7.5 to 35 µs per batch of 0.4 to 1 MB.

**Cost of it.** One more pass over one column per span or log append, and two integers in its row.
Rows written before this release, or by the release before it after a rollback, are read whatever
the range until they leave the tail. The query does not send a time range for span and log reads
yet (`query/src/signals.ts` `readSignalTail` passes `{}`; the change is in `shard/README.md`,
"Needed changes elsewhere"): until it does, nothing is skipped and m-3 stands. A query whose bound
covers the tail still takes all of it: the 2-hour margin makes a one-hour search read five hours, so
a backlog of more than about 16 MiB within any five hours still refuses a search (modelled from the
measurement above: 11.7 MB for five hours here). The two columns follow the payload in SQLite's
record, so deciding to skip a batch walks the payload's overflow pages without copying it (training
knowledge of SQLite's record format); here a read that skipped all 48 batches took 4 to 6 ms, the
RPC included. Not measured on Cloudflare.

**Would change if.** A query needs another time than a span's start or a log's `ts` (then that
column's bounds too); senders' late spans make most batches span hours, so bounds skip little (then
per-batch metadata finer than a hull); filtered metric reads show on the shard's CPU (then (g));
Cloudflare shows deciding to skip a batch costing what reading it did (then the bounds in a table of
their own, (c), with its row write).
