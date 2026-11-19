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
`edge` leaves those series out, sends the rest again, and tells the sender (429 for Remote
Write, `partial_success` for OTLP).

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
