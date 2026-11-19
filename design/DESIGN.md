# viz — system design

Status: draft 3.1, 2026-11-18. Draft 2 was reviewed by two independent reviewers (57
findings) and rewritten as draft 3; draft 3 was re-reviewed (12 findings) and amended here.
`REVIEW.md` lists what changed and what is still open.

Status (2026-11-19): the backend described here is built and merged to `main`, with the
clean-room TraceQL and LogQL engines (not yet wired into storage or the query Worker); its first
production deploy is pending. Spikes S0–S5 and the S3/S4 re-runs were measured on Cloudflare,
and staged copies of the deployment were trialled and destroyed (`VERIFICATION.md`,
`deploy/README.md`). Figures not marked as measured are models, printed as ranges, and
`VERIFICATION.md` names the experiment that would confirm or kill each. Spans and logs: their
batches, ingest decoding (behind a flag) and Parquet writers are built (stage 1, 2026-11-19);
flushing, recording and querying them is not (stage 2). Self-monitoring is proposed, not built.

## 1. What viz is, and how it is deployed

viz is an observability store and frontend that runs entirely in one Cloudflare account:

- metrics, logs and traces in Parquet files on R2, published as Apache Iceberg tables;
- PromQL and TraceQL, with the Prometheus and Tempo HTTP APIs so existing tools can point at
  it, and LogQL for logs (`engine/logql`: most of Loki's language, with Loki's result shapes);
- authenticated push (OTLP/HTTP, Prometheus Remote Write) and pull (scrape, adapters);
- dashboards that agents and people both write and read;
- monitors: rules, anomaly detection, agent-run investigations.

**Where it runs.** One Cloudflare account, served under `vis.bitcru.sh`. Every resource
viz creates there is named `viz-…`.

**Deployment model.** The primary target is *deploy to your own account*: one organisation,
many tenants (teams, environments, customers of that organisation). The same design hosts
unrelated tenants as a service by adding cells (§3.3). Where the two differ, this document
says so; the cost floor in particular is a different number for each.

## 2. The shape

**For each tenant, one small ledger says which files exist. Everything else follows it.**

1. **Ledger.** One Durable Object per tenant holds the list of live data files across all of
   that tenant's tables, and a watermark per shard. It is the only authority on what is
   visible. Every change to it is one SQLite transaction, and every change is also appended
   to an immutable log on R2, so the ledger can be rebuilt from R2 alone.
2. **Tail.** Rows that have been acknowledged but are not yet in a file the ledger knows are
   held by exactly one shard (a Durable Object with a write-ahead log).
3. **Seam.** A query reads one ledger version, gets the file list and the watermarks, and asks
   each shard only for rows above its watermark. A shard that has already discarded rows
   above the watermark it is asked about refuses, and the query re-reads the ledger. The seam
   fails closed; it never returns a silent gap.
4. **Iceberg is a publication.** A publisher turns ledger changes into Iceberg snapshots every
   few minutes. External engines read the Iceberg tables. viz's own queries read the ledger,
   so neither freshness nor ingest depends on the catalog being fast, cheap or up.

```
 senders ─► edge ─► Shard ──seal──► flush ──► R2 Parquet ──► Ledger ══► Publisher ─► Iceberg
           auth,    WAL,           encode     immutable      per tenant   per cell     tables
           decode   tail           (stateless)               live files,  (async,      (external
                      ▲                                      watermarks   minutes)      engines)
                      │ rows above watermark                     ▲
 UI / API / MCP ─► query ─► leaves ──────────────────────────────┘ file list + watermarks
```

What draft 2 got wrong, and why this is the fix: it put visibility state inside Iceberg
snapshots. That made a catalog outage stall ingest within minutes, made table metadata grow
with tenants × days, tied freshness to a 60-second commit floor, and could not commit a
metric's series row and its samples atomically because Iceberg has no multi-table commit. A
per-tenant ledger has none of those problems and is a far smaller thing to prove correct.

## 3. Components

### 3.1 Inventory

| Component | Kind | Responsibility | Wakes |
|---|---|---|---|
| `edge` | Worker | Authenticate, decode to columnar batches (WASM), route, render protocol responses | per ingest request |
| `Shard` | Durable Object | WAL, dedup, quotas, tail reads, sealing | per ingest request |
| `flush` | Worker | Read a sealed segment from its shard, sort-merge, encode Parquet, PUT, report to the ledger | per seal |
| `Ledger` | Durable Object, one per tenant | Live files, watermarks, shard-map epoch, R2 change log | per seal, per compaction, per uncached query plan |
| `Publisher` | Durable Object, one per cell | Iceberg commits for every table in the cell | every few minutes, only when ledgers changed |
| `query` | Worker | Parse, plan, prune, fan out, merge | per query |
| `Leaf` | Durable Object, a warm pool per cell | Scan row groups and tail rows, evaluate, return partials. Stateless; an object only because that gives each leaf its own connection budget | per split |
| `Ruler` | Durable Object, one per tenant rule shard | Rule ticks (one batch evaluation per group), alert state machine, acknowledgements, backtests, hands transitions to the notifier. Serves the Prometheus `/api/v1/rules` and `/api/v1/alerts` shapes and viz's `/api/v1/monitors` | every rule interval |
| `Notifier` | Durable Object, one per tenant | Routing, grouping, inhibition, silences, and the delivery outbox. One per tenant because grouping spans that tenant's rulers | when alerts change, and on its group timers |
| `Scraper` | Durable Object, one per target group | Pull ingest | every scrape interval |
| `Tenant` | Durable Object, one per tenant | Keys, dashboards and revisions, proposed changes, settings (retention, limits, pool, notifications), audit log; publishes what the data path needs to KV; issues service keys to the ruler and gives it the default notification destination over its binding (`contracts/control.ts`, D39); OAuth grants and tokens (D44), which the agent surface checks through control's `OAuthIntrospection` entrypoint, never through this object's binding. Rule groups are held by the `Ruler` | per control-plane request; the data path reads its KV records, never the object; the ruler asks it when it has no key and at most once a minute while notifying |
| `app` | Worker + static assets | UI, REST and Prometheus/Tempo-compatible APIs, OAuth | per request |
| `mcp` | Worker | The agent surface: a stateless MCP server and the same tools as JSON under `/api/v1/agent/…`; no Durable Object (§8, D25–D27) | per agent call |
| `LiveTail` | Durable Object | Hibernating WebSockets for live log tail | while a viewer is connected |
| `jobs` | Workflows | Compaction, rollups, retention, orphan sweep, scrubbing, investigations. As built, compaction, retention and deletion are a per-tenant maintenance run on a queue (§5.2) | scheduled or triggered |
| Heavy worker | Container (fronted by a Durable Object) | The same engine for work that exceeds isolate limits | on demand |

Supporting services: Queues (seals → flush, maintenance, notification fan-out), KV (API-key and
shard-map cache, read stale-tolerantly), Cache API (accelerator only), AI Gateway, Secrets
Store, and later Dynamic Workers for tenant-supplied adapter code.

That is four stateful roles on the data path (shard, ledger, publisher, ruler). Only the
ledger and the shard need deep correctness work; the publisher is a derived view and the
ruler is at-least-once by design.

### 3.2 One engine

A Rust core does parsing, planning, Parquet encode and decode, and evaluation, with no I/O
of its own. It runs as WASM in `edge`, `flush`, `query` and the leaf objects, natively in Containers,
and inside a seeded simulator in CI. TypeScript owns bindings, HTTP and orchestration.
Whether the core fits a 128 MB isolate with a 1 s startup limit is the second spike.

### 3.3 Cells and shard pools

- A **cell** is one R2 bucket, one publisher and one set of Iceberg tables. Every object name
  carries its cell. A single-organisation deployment is normally one cell. A hosted service
  uses many, with an enforced budget of tenants and live partitions per cell.
- A **dedicated cell** holds one tenant. Only dedicated cells give direct Iceberg access to
  that tenant, because a shared cell's tables contain other tenants' rows. Dedicated cells
  can use an EU-jurisdiction bucket.
- Shards come from **pools**. A pool is a fixed set of shard objects; each tenant is given
  a small subset of it by rendezvous hashing, so tenants rarely share their whole subset.
  Several tenants' batches land in the same object, each in its own stream, with its own
  sequence numbers, quotas, fingerprints and discard mark. A tenant that needs full
  isolation gets a pool of its own; the code path is the same. Implemented in `shard/`.

## 4. Write path

### 4.1 Routing

Rows are routed by a **sender-stable key**: the resource fingerprint (for Prometheus, the
target labels such as `job` and `instance`; for OTLP, the resource attributes). One request
from one sender normally lands in one shard. This is a locality property, not a guarantee:
Remote Write batches can mix targets, resource attributes drift, and map changes move keys.
The read path therefore never evaluates "per shard"; it groups rows by key range across
every shard's contribution (§6.2).

Spans and log records route by the same sender key (for OTLP, the resource's service name,
namespace and instance id; for Loki push, the stream's `job` and `instance`), to shards of
their own: the pools `{pool}/traces` and `{pool}/logs`, so a shard stream holds one signal
(`contracts/BATCH.md`, D57). Built end to end on the write side behind `INGEST_SIGNALS` (off by
default; stage 2, 2026-11-19): edge appends there, those shards seal, register (D61) and are
flushed and recorded like any other, and their files are listed by the ledger (§4.3, §5.1).
A tail read names the signals it wants by the batches' header byte (`signals: [1]` for a
metrics query), so a span or log batch never reaches the metrics engine (D48). The public path
is wired (stage 3, 2026-11-19): the gateway on `vis.bitcru.sh` routes `/v1/traces`, `/v1/logs`
and `/loki/api/v1/push` to viz-ingest by exact path, as it routes `/v1/metrics`; edge answers
them 404 while `INGEST_SIGNALS` does not name the signal. A pool map's own pool never ends in
`/traces` or `/logs` (edge refuses such a map, 503, metrics included; control refuses to assign
one, so tenants `traces` and `logs` keep the shared pool, D66), so a shard named
`…/traces/{slot}` or `…/logs/{slot}` is always a span or log shard and no metric shard shares
an object or a name with another pool's span or log shard (`contracts/BATCH.md`).

Draft 2 hashed by series id, which sent every request to every shard and made every query
tail-read every shard. Shard count per tenant is bounded to tens; beyond that a tenant is
split across cells.

Measured on Cloudflare (`spikes/s3-ingest-throughput/`): one shard as first built
saturated at roughly 230–340 requests per second whatever the batch size, and took 133,000
samples per second when requests carried 2,000 series. With early refusal and group commit
(D37) the same shard acknowledged 864–1,056 requests per second at 64 clients, with a 99th
percentile under 150 ms (2026-11-19, three 10-second runs). Plan for 500 requests per second
per shard, and expect senders to batch.

The shard map has an **epoch**, owned by the ledger. Every write carries the epoch it was
routed with; a shard rejects a stale epoch and `edge` refetches. A map change takes effect
only after the old shards' final units are *recorded in the ledger*, their dedup
fingerprints have been handed to the new owners, and draining shards stay in query plans
until then. No key is ever accepted by two shards.

### 4.2 Acknowledgement

1. `edge` verifies the API key, decodes the body to a columnar batch, and forwards it.
2. The shard appends the batch to its WAL. Batches arriving within a commit window share
   one transaction. The response is sent only after that transaction is durable.
3. A request that spans shards succeeds only if every shard commits. Otherwise the sender
   gets a retryable status for the whole request (429 or 503) and retries all of it.
   `partial_success` is used only for rows rejected by validation, which a retry would not
   fix. Retries are safe in two layers: a batch fingerprint stops a shard storing an
   identical batch twice, and every reader and writer de-duplicates on the row key, so a
   retry that was split differently and stored again is invisible in results and removed
   at flush (`contracts/BATCH.md`).
4. At its bounds the shard refuses with `Retry-After` and never acknowledges and drops: a
   full buffer (the tenant's or the shard's) is 429; too much in flight is refused before
   anything is read or written and answered 503, which every sender retries, and `edge`
   then refuses that tenant's requests before decoding them until the wait has passed
   (D37). A new stream whose registration is not yet logged (§4.3) is refused the same
   way, at once and holding nothing, and answered 503 (D61).
5. Timestamps outside the **accept window** (per signal, configurable; for example one hour
   back and five minutes ahead for metrics) are rejected with a reason.

### 4.3 Seal, flush, record

1. The shard **seals** a segment on decoded bytes (a few MB, so it can always be sorted in
   memory) or on age. Low-volume tenants seal on a long age, 10–15 minutes: freshness comes
   from the tail, so sealing sooner would only create small files. The seal boundary is
   written durably before anything else happens.
2. `flush`, a stateless Worker, reads the sealed runs, merges them in sort order, and writes
   one tenant-pure Parquet file per table touched. Keys are deterministic and PUTs use
   `If-None-Match: *`, so a retry can never overwrite a file with different bytes.
   Encoding happens outside the shard, so it does not block acknowledgements. A segment
   that spans partitions yields one file per table-partition. File keys include a content
   hash, so two attempts that produce different bytes produce different keys, and the ledger
   records exactly the bytes it admitted.
3. `flush` reports the **unit** (all files from one seal, with their statistics and sequence
   range) to the ledger. The ledger accepts it only if it extends that stream's watermark
   contiguously, and adds every file, with each file's index fragment, in one transaction.
   A metric's series rows and samples therefore become visible together, and there is no
   separately-updated index that could miss a file. A segment of a span stream becomes one
   unit of `spans` files (one per hour of start time) and `trace_index` files (one per day),
   a segment of a log stream one unit of `logs` files (one per day); flush chooses the encoder
   by the batches' signal byte and refuses a segment that mixes signals. The ledger lists these
   tables' files in milliseconds (the floor of their nanosecond bounds), so plans and
   precedence work for them unchanged.
4. The shard discards a segment once the ledger has acknowledged the unit, and records how
   far it has discarded.

Nothing in this chain is called by hand. A seal writes a `{tenant, shard}` message to an
outbox in the same transaction as the segment boundary and hands it to a queue; the queue's
consumer runs `flush` for that stream and retries it until every sealed segment is recorded
(D18). A message that is lost or dead-lettered does not lose the flush: the shard keeps a
marker in KV while it has unrecorded segments, and an hourly sweep re-enqueues the streams
of marked shards. A successful flush asks for the tenant's maintenance (§5.2) the same way.
An idle deployment has no flush marker, and every tenant's maintenance marker names a time
in the future (as built, the day its oldest data expires), so the hourly cron reads KV and
wakes no object and sends nothing.

Every step is idempotent and keyed by a **stream**: `(shard, tenant, incarnation)`.
Sequence numbers, seals, units, watermarks, discard marks and fingerprints are all per
stream, so one tenant's ledger being slow never blocks another tenant in the same shard
and nothing crosses tenants.

**Registration before writes** (D61). A stream is new when a tenant first writes to a shard,
and again when the shard loses its storage and starts a new incarnation. The shard registers
it with the tenant's ledger and accepts its first write only once the ledger answers that the
registration is **logged**: in the ledger's R2 log, so no rebuild can lose it. Then every
plan names every stream that holds acknowledged rows, whatever the ledger loses (a
registration that is only committed is not enough: a rebuild rolls it back and a query
misses rows, spec F6(b)). The ledger derives "logged" from its outbox (no pending
`register_stream` change names it), never from a stored flag, so no rollback leaves it
stale. Until then the shard refuses the stream's appends at once, holding nothing, and
registers in the background, one call per stream at a time and a few per shard, so one
tenant's slow ledger never blocks another; `edge` answers the refusal 503. A stream that
already holds acknowledged rows (made by an earlier release) keeps accepting while it is
confirmed. The ledger records the boundary between incarnations (`previousIncarnation`),
because rows between the old watermark and a loss are gone and that must be visible; no
alert is raised for it yet. While a tenant's ledger cannot log, its new streams take no
writes (fails closed, retryable, reported after a minute). A ledger that forgets a logged
registration is outside the protocol (a lost or replaced log: tenant re-creation, a restore);
the shard does not re-register then. As built, production turns this on in the release after
the one in which `edge` maps the refusal (`shard/README.md`, "Rollout"); until then appends
register lazily, at the stream's first flush.

**Ledger durability** (D36, `contracts/LEDGER-LOG.md`). The ledger commits each change to
SQLite together with an outbox row and answers; it does not wait for R2. Its alarm writes
the pending changes as one immutable segment per drain, about 0.2 s after the first unlogged
commit, and only then deletes those rows and advances each stream's *logged* watermark. A
shard is told to discard only what is logged, so the loss of the ledger's storage can cost
the changes of one drain cycle, never a row a shard has discarded. A rebuilt ledger starts a
new ledger incarnation, whose base segment is in R2 before it commits anything, so an
incarnation number is never used for two histories and versions are never reused.
Checkpoints, taken once the log since the last one is as large as it, bound a rebuild, which
runs outside `blockConcurrencyWhile`: requests meanwhile wait at most 2 s and are refused as
retryable. A checkpoint of a state larger than 1 MiB is written in parts across drains, from
the state at its version (changes committed meanwhile keep pre-images), and a rebuild streams
checkpoints and bases into SQLite, so nothing holds the whole state (D47). The bound left is
time: a rebuild reads and writes the whole state while the tenant is refused. The state is
capped at 16 MiB by default (the cap of the releases before D47, kept until a release whose
rollback floor has D47 and D55 lifts it after a rebuild and a first publication are measured
within the CPU limit on Cloudflare; review P-2, P-3), at most at the largest measured (300 MiB,
about 300,000 files; 20 s locally): above it `addUnit` answers `full`, retryably, until
compaction or retention makes room (`contracts/LEDGER-LOG.md`, "Size").
Measured on Cloudflare: 234–422 units per second with eight writers, and a rebuild of
5,008 changes in 5.4 s (`spikes/s4-ledger-scale/`). The orphan sweeper deletes an object only if the
ledger neither lists nor tombstones it and it can never be listed: a flush file once its
stream's *logged* watermark covers its sequence range, or once a newer incarnation's
registration is logged (a committed one proves nothing: a rebuild can roll it back, spec
F15); a compaction output once one of its inputs is gone for good, that is, not live and its
object already deleted, which happens only after a logged removal. When a flush file waits
past its grace for a unit of the incarnation the ledger names, the sweeper asks that shard to
hold a registered stream: a shard that lost the stream registers a fresh incarnation, and the
old files become dead once that is logged, so nothing leaks after a storage loss even if the
tenant never writes there again (spec F16; D61). A compaction step never deletes an output, not even
on conflict, because an identical step may adopt the same object. No clock and no ledger
rebuild can make the sweeper delete a file that may still become live (D30).

### 4.4 Pull and adapters

- **Scrape.** A `Scraper` object per target group, on an alarm. Static targets and HTTP
  service discovery at launch. Target credentials are stored encrypted with the tenant.
  Staleness markers are synthesised. Private targets use a pushing agent.
- **Adapters.** One contract in both directions, with Arrow as the currency. *Ingest
  adapters* poll an external system and emit batches; the platform owns cursors. *Query
  adapters* expose an external store at query time through `schema()` and
  `scan(pushdown)`. First-party adapters ship first (Prometheus remote-read, Cloudflare
  Logpush, an S3-compatible bucket). Tenant-supplied adapter code in Dynamic Workers comes
  later.

## 5. Storage

### 5.1 Tables

Parquet with zstd; Iceberg format v2 types. Files are tenant-pure. Partitioning is by tenant
and time.

| Table | Grain | Sort order | Notes |
|---|---|---|---|
| `metric_series` | series per day | `metric_name, series_id` | promoted label columns + full label map |
| `metric_samples` | sample | `metric_name, series_id, ts` | `series_id` is a plain 64-bit hash of all labels (`contracts/BATCH.md`). Putting hashes of `namespace` and `job` in its top 24 bits was measured on 200,000 series: a `{namespace=…}` query reads 1.3–2.6× fewer bytes by row group (6–17× only with page-level pruning, which the engine does in memory but does not fetch, D41), a full-metric scan is no better, and 40 bits are left to tell series apart, which is not enough (D19). Locality is to come from the sort key instead: a promoted-label column before `series_id` |
| `metric_rollup_5m`, `_1h` | series per window | same | count, sum, min, max, last, reset-aware increase |
| `spans` | span | `service_name` (nulls first), `span_name`, `start_unix_nano` | hour partitions (keys `…/day=D/hour=HH/`); promoted attributes + typed residual maps; bloom filter on `trace_id` (`contracts/TRACES.md`; written by flush through `engine/wasm`, listed by the ledger: stage 2) |
| `trace_index` | trace per flush unit (a fragment), files per day | `trace_id` | root, start, end, counts, and the **hour partitions** that hold its spans (logical references survive compaction); fragments merge at read and compaction |
| `logs` | record | `service_name, stream_id, ts, line, metadata` | day partitions; `stream_id` hashes the stream labels as `series_id` does; labels as canonical JSON per row (dictionary-encoded), structured metadata, OTLP severity and trace ids; OTLP stream labels from a fixed list of resource attributes (D58); an advisory per-file token filter written at compaction, inside the Parquet object between the last row group and the footer (`contracts/LOGS.md` §6, D65; built, not yet read by query) |

The span and log tables are written and listed as built on the write side (stage 2, behind
`INGEST_SIGNALS`): flush, the ledger, retention and deletion; `query` reads them behind
`QUERY_SIGNALS` (D62, §6.4), and both halves are joined through the gateway (stage 3), and they
are compacted (D68, §5.2). The publisher publishes them as Iceberg tables of their own (D67, §5.3;
before it, D64's release read them without publishing them): `INGEST_SIGNALS` may go on in a
deployment with a publisher once a publisher release that reads them (D64's or later) is the
oldest one a rollback of viz-publisher can reach (the rollout rule in D64).

Native histograms share the samples layout and are added after float samples work. Flat
rows are chosen over chunk blobs for openness and simplicity, pending the read-slice spike.

### 5.2 Compaction, rollups, retention

- **Compaction** is time-clustered and sort-preserving. An open hour is minor-compacted
  when it holds four flush files or has been quiet for ten minutes, so that a
  tenant-table-hour never has more than a small fixed number of files. Hours merge into
  days once the accept window has passed. Small merges run in Workers; large ones in a
  Container. As built, a merge in a Worker reads at most 16 MB in at most eight file pairs
  (measured: 70 MB of WASM memory), so a day file is at most about 16 MB and a busy day has
  several, not the one 128 MB file a Container merge will produce; the Container is not
  built. A compaction is a ledger transaction that succeeds only if every input is still
  live, so it cannot resurrect files that retention removed, and it swaps the samples and
  series files together. When files hold the same sample, the one with the higher
  precedence wins: the ledger ranks a flush file by when it admitted it and gives a merge's
  output its inputs' range, refusing a merge that would jump over an overlapping file
  (D22).
- **Spans, `trace_index` and logs** (D68) are compacted by the same step and policy, each table
  on its own, after the metric tables: spans per hour and never across one (a closed day's spans
  become one file per hour, keyed under the hour), `trace_index` and logs per day. Spans and log
  rows keep the later input's version of a row key; a trace's `trace_index` rows merge into one.
  Every logs output carries its token filter (D65). Those merges stream their inputs and cut row
  groups at 2 MiB of data, so the largest step peaks at 62 MB (spans) and 81 MB (logs) of WASM
  memory (measured locally).
- **When it runs (as built).** Compaction, retention, deletion and the orphan sweep are one
  per-tenant maintenance run, consumed from a queue. A flush that changed something
  (admitted a unit, wrote an object, or saw a segment recorded) asks for one; so does the
  hourly cron, for tenants whose KV marker says time alone has made work (an hour
  gone quiet, a day closed, the oldest day reaching its retention, a grace ending, an orphan
  sweep still needed after objects were written). The compaction Workflow is built but not
  started.
- **Rollups** are written when an hour closes, so the trailing day already has them. An hour
  closes when the accept window has passed *and* every stream's watermark is past the end
  of the hour, so no row for it is still in a tail. Nothing later can change it.
- **Retention** is per tenant, per signal and per tier (raw, 5-minute, 1-hour). Expiry
  removes whole files from the ledger. Objects are deleted after the removal has been
  published and a grace period has passed. As built (raw tier only, one policy per tenant):
  the ledger keeps a tombstone per removed key and releases it for deletion once the
  removal is in its R2 log and a grace period has passed by its own clock; with a publisher
  bound (as viz-ingest is), the janitor also waits for the cell's publisher to release the key
  (`safeToDelete`: removal published, no retained snapshot references the file, the
  publisher's grace passed). A publisher that cannot answer releases nothing.
  A tenant without a policy record gets the default (30 days); a record that cannot be read
  (malformed, or of a version the janitor does not know) expires nothing for that tenant and
  is reported every hour until fixed, never replaced by the default. Spans (with their
  `trace_index` files) and logs expire by the record's `trace_days` and `log_days`, each 30 days
  when absent, in ledger changes of their own after the metric one; their tombstones go
  through the same purge and the same publisher gate.
- **Index fragments.** Each file's row-group offsets, key statistics and page-index
  locations are stored with its ledger row. Compaction consolidates the fragments of a
  partition into one content-addressed index object. Planning never issues one footer read
  per file and never reads an index that disagrees with the ledger.

### 5.3 Iceberg publication

The publisher applies ledger changes to the cell's Iceberg tables every few minutes, only
when something changed. As built and wired (D34): viz-ingest binds the cell's publisher
(viz-publisher, deployed first) and every maintenance run ends with a nudge to it, at most 2 s
and never on an ingest or flush acknowledgement path; a nudge that may not have been recorded
makes the tenant due again within the hour. The publisher publishes from its own alarm a
couple of minutes later; an idle cell has no alarm and nothing calls it. The nudge is only
that: changes are applied strictly in ledger
version order per tenant, read from the ledger's R2 log (segments, in whole segments; a hole
or a segment it cannot read stops that tenant there, never skipped). A tenant it has no cursor
for in the newest ledger incarnation is re-based from that incarnation's newest checkpoint, or
its base, streamed into SQLite and diffed against what is published there, so the publisher's
memory does not grow with a tenant's size (D55). It publishes all five tables the ledger lists,
each as its own Iceberg v2 table with its own cursor per tenant (D67): the metric pair, and
`spans` (partitioned by `identity(tenant)` and `hour(start_time)`), `trace_index` and `logs`
(by `identity(tenant)` and `identity(day)`), whose nested columns (attribute maps, events and
links, a fragment's services and hours, structured metadata) carry a field id for every key,
value and element and are found in the files through a nested name mapping. The metric tables
commit first and are byte for byte what they were before. The first publish after the upgrade
from D64's release re-bases every tenant once (the new tables have no cursor). A table no
release knows still stops a tenant. A removed
file is physically deleted only after the removal is published and every snapshot that
referenced it has expired (the janitor asks the publisher before each purge). Each snapshot
points at an object
recording which ledger version of each tenant it reflects. A scrubber checks continuously
that the Iceberg live set equals the union of the ledgers at those versions.

The publisher is never upstream of ingest. Shards discard on the ledger's acknowledgement,
so a slow or stopped publisher delays only external readers and physical deletes. Its
backlog is the ledgers' R2 logs, and it applies net changes, so catching up is one commit
rather than a replay. Publication lag has its own alert.

The first implementation writes Iceberg metadata directly to R2, using conditional writes as
the compare-and-swap; any engine can read it as a static table. Committing to Cloudflare's
managed catalog is a second implementation of the same interface, added once a spike shows a
Worker can do it reliably. Managed compaction stays off: viz is the only writer.

### 5.4 Services not on the main path

| Service | Why not | Where it may fit |
|---|---|---|
| Managed streaming ingest (Pipelines) | 20 streams per account, no sort or partition control, 60 s floor, silent drops, per-GB price | none at launch |
| Managed SQL | 10,000-row cap, per-query minimum, HTTP only | ad-hoc SQL over dedicated cells |
| Managed compaction | not documented to preserve sort order or indexes; a second writer | none |
| D1, Analytics Engine | wrong shape or limits for telemetry at this scale | none |

## 6. Read path

### 6.1 Plan

PromQL, TraceQL and LogQL each parse to their own AST and lower to one logical
plan (LogQL's vector operations run on the PromQL evaluator, D49). The tenant comes from the authenticated session and is injected into every scan, along
with label-based access rules. A caller cannot omit it.

1. One call to the tenant's ledger returns the ledger version, the partition index objects
   for the time range, and the shard watermarks. The plan names every stream that holds
   acknowledged rows (§4.3, registration before writes); the coordinator also asks every
   shard of the tenant's pool, from sequence 0, for a stream the plan does not name. A shard
   asked about an incarnation it has lost does not answer "nothing": it starts and registers
   a fresh one and names it, the coordinator re-plans, and the fresh stream is read from 0
   (empty). The lost rows are a declared loss; the query finishes (D61).
2. Index objects are fetched (immutable; cached).
3. The planner prunes files and row groups by name and time from the index fragments, and
   reads a file as its footer and the row groups needed (byte ranges). When that does not fit
   one place and a matcher selects by more than the metric name, it resolves the matchers
   against `metric_series` first and reads only the row groups whose `(metric, series_id)`
   range holds a selected series (one more round of reads); split leaves resolve their own
   part. Pages are skipped in memory, not fetched (D41). The label endpoints read
   `metric_series` and the tail only, in one place or, when those do not fit it, over leaves
   that each list a range of `series_id`s (D56).

### 6.2 Execute

- A leaf receives a split: a set of row groups **and** the tail rows for the same key range.
  It merges them, removes duplicates on `(series, timestamp)`, and only then evaluates. A
  `rate()` window that straddles lake and tail is therefore computed over one ordered stream.
- Leaves return partial aggregates (D31). As built: a query whose selectors all sit inside
  decomposable aggregations is split over `L` leaves, each owning a range of series keys, so
  all rows of a series reach one leaf whichever shards they came through; leaves pull their
  part's rows from reader leaves (one call per group of at most six files) and the
  coordinator cuts the tail by part (or, when it does not fit, each part reads the rest of it
  in its own key range: below). Every aggregation is exact and order-independent (exact
  sums rounded once; `avg` as sum and count; `topk` per part then merged), so a split answer
  is byte-identical to one place. Partials travel in the engine's own binary form, not Arrow
  IPC. `L` covers both the samples (scan bound) and the series (estimated from the series
  files) at three quarters of one isolate's limits. Queries that do not decompose run in one
  place. Approximate quantiles are not built.
- A tail read is a filtered scan over a shard's unsealed and unflushed segments. Segments
  are bounded by seal size, so the shard needs no query engine and no second index. The
  filter (time range, metric names, exact label values, a range of series keys) is applied
  by the shard and the answer comes in pages with a continuation (D48), so a query takes only
  the tail it needs. The coordinator reads it under its byte budget; when it does not fit and
  the query splits by `series_id`, each part reads the rest in its own key range (D54). A
  shard of the previous release answers unfiltered and is read as before. Shards
  keep recorded segments for a short bounded time, and a refused split is retried on its
  own with a fresh ledger read, so a busy shard cannot make a whole query loop.
- **Leaves are Durable Objects.** Measured on Cloudflare (`spikes/s1-fanout-r2/`): R2 reads
  are limited to six at a time per request, and a Worker reached through a service binding
  spends from its caller's budget, so 96 reads take about 750 ms however they are spread
  over service-bound leaves. A Durable Object has its own budget: 192 reads across 32 leaf
  objects finished in under 200 ms. Each cell keeps a pool of warm, stateless leaf objects;
  the coordinator picks leaves from the pool per split and gives each at most six reads at
  a time. A single R2 range read costs about 45 ms whatever its size below 1 MB, so the
  planner coalesces reads instead of minimising bytes.
- A plan that will not fit an isolate goes to a Container running the identical engine.

### 6.3 Caching

Cache API is per location, evictable and cannot be purged, so it is treated strictly as an
accelerator. Keys include tenant, access policy and content hashes. Leaf partials over
immutable files are cached with a bounded lifetime so that erased data ages out. A result is
cached as final only when its range ended before `now − accept window`. The `query` Worker
is pinned near the bucket so that hits concentrate.

### 6.4 Traces and logs

As built (2026-11-19, `query/README.md` "Traces and logs", D62): the query Worker answers
Tempo's and Loki's HTTP APIs behind `QUERY_SIGNALS` (off by default); the write side of stage 2
(D63) flushes and lists the `spans`, `trace_index` and `logs` tables, and tail reads choose
batches by signal (`signals`). Stage 3 (2026-11-19) wired the halves together: the gateway routes
Tempo's documented read paths (`/api/traces/<id>`, `/api/v2/traces/<id>`, `/api/search`, the tag
and tag-value paths in v1 and v2, `/api/metrics/query_range`, `/api/metrics/query`) and Loki's
(`/loki/api/v1/query`, `/query_range`, `/labels`, `/label/<name>/values`, `/series`) to viz-query
by exact path, one segment per path parameter; their other paths stay 404 at the gateway, and
viz-query answers these 404 while its flag is off. Tested through the gateway in front of the real
ingest and query Workers (`stack/README.md`, "Through the gateway"); answers equal to the
engines' in-memory ones over whole corpora through edge, flush and the ledger are query's own
end-to-end test (`query/test/signals.e2e.test.ts`). The engines (`engine/traceql`,
`engine/logql`, clean-room, D35, D40, D50) are linked into the read path's one WASM module
(`engine/wasm-query`, ABI 6), which reads the files `engine/storage` writes and the span and log
tail batches through the engines' read seams. The seam with the tail is the metrics one (§2):
one ledger version per query, tails strictly after the plan and above its watermarks, refusals
re-planned. Every read sends its signal to the shards (`signals`), asks only its signal's shards
(by name, for shards of a release before D63; a name is unambiguous since edge refuses base pools
ending in `/traces` or `/logs`, §4.1) and checks every tail batch's header (a batch of
another signal refuses the query, never misread).

- **Trace by ID:** the `trace_index` row groups whose trace-id range (from the index fragment)
  holds the id are read; the trace's fragments name its extent and the `spans` hours that hold
  it, and only those hours' files are read, their row groups chosen by time. Without a time hint
  every day is planned (newest-first waves are not built). Inside an hour a flush unit's row
  group is decoded whole to find the trace (the bloom filters are not used yet; measured: the
  cost of a call is the hour's spans, not the trace's).
- **TraceQL search** reads `trace_index` over the window, finds the traces whose extent overlaps
  it and reads every span of them (the hull of their extents), so a trace's summary is computed
  from its spans; metrics queries whose pipeline is span-local read only the spans that start in
  the window. Structural operators are evaluated per trace in one place. Queries are bounded by
  files, bytes and rows decoded (`maxSpans`); split execution by trace-id hash, partial results
  with a cursor, and pushing predicates to sorted and promoted columns are not built.
- **Tables and engine:** the `spans` and `trace_index` tables are specified in
  `contracts/TRACES.md` and written by `engine/storage`; flush writes them (stage 2, D63).
- **Logs:** row groups are chosen from each file's stream list and times; rows of streams no
  selector matches, or outside every selector's range, are dropped before they are held. One
  place, bounded by `maxLogRows`; using the per-file token filter (compaction writes it, D65; no
  query reads it yet), split execution
  and partial results with a cursor are not built. Labels and series come from the fragments'
  stream lists without reading data where the lists exist.

### 6.5 Cost visibility

Bytes to scan and shards touched are known after planning. They are returned with every
result, limited per tenant, and exposed to agents through `validate_query`. As built, the
query Worker returns them as `X-Viz-*` headers on every answer, and `/api/v1/plan` returns
what a query would read (files, bytes, scan bound, series estimate, split and leaves, the
refusal it would get) from one ledger read, touching no shard, leaf or R2 object.

## 7. Monitors

- **Rules** follow Prometheus semantics, extended to LogQL metric queries and TraceQL
  metrics, so logs and traces can alert. A tenant's rules are packed into `Ruler` objects;
  one tick evaluates a group as a single plan with shared scans; state is written only on
  transitions.
- **Each rule is classified when it is saved**: *tail* (its window fits inside what shards
  hold), *recent* (reads flush files) or *rollup*. The class and its estimated cost are
  shown to the author. For small tenants, which seal every 10–15 minutes, most rules are
  tail-class and close to free. Larger tenants pay for object reads: roughly dollars, not
  cents, per thousand rules per month.
- **Notifications** use a transactional outbox with deterministic ids. Grouping, inhibition
  and silences keep Alertmanager's semantics. A sweeper re-arms missed rulers, and a
  dead-man's-switch alert is built in. A tenant's default destination is set in the control
  plane (webhook URL, Alertmanager's JSON or viz's plain `viz.notification/v1`, a write-only
  signing secret); the notifier reads it over the `Tenant` binding and offers it as the
  receiver `viz:default` (D39). Bodies are built once, at the decision, and every attempt
  sends the same bytes under the same `Idempotency-Key`.
- **As built, until query exports an RPC entrypoint** (D39), a tick sends its group's
  expressions to viz-query's Prometheus HTTP API one at a time (one engine call in flight per
  `Ruler` object: a service-bound callee shares its caller's six connections), authenticated
  with a service key the tenant's control plane issues (`service:viz-ruler/<shard>`, visible
  and revocable there). Recording rules write through viz-ingest's `RecordedSamples`
  entrypoint (`contracts/ingest.ts`, D45), which the ruler binds as `SINK`: the binding is the
  credential (no key), the tenant an explicit, validated argument, and each refusal is handled
  as the contract says. For one release, a call the entrypoint does not answer by its contract
  (an ingest release without it, during a rollback or while a deploy propagates) goes through
  Remote Write with the service key instead (D52); in steady state no write uses the key.
- **Anomaly detection** is statistics first. An *anomaly rule* is a rule kind
  (`contracts/rules.ts`, version 2): each tick the ruler feeds every series of one PromQL
  expression to that series' detector, through the same batch call as other rules, and the
  flagged series become alerts carrying the detector's sentence and numbers. Detector state
  lives in the ruler's SQLite per (rule, series), written as whole batches per row in the
  transaction that commits the alerts, and is rebuilt from there after eviction; a per-rule
  series cap and state limits refuse an evaluation rather than drop series. The windows of the
  robust z-score and the seasonal baseline can be kept as Float64 values in ring blocks on the
  rule's interval grid (D60), like an SLO's buckets, a tick writing a head row (which lists the
  blocks, so a missing one is refused, not read as a shorter window) and the block its
  points fall in: about 18 KB a series at the default window instead of about 50 KB of JSON, 55
  series a default rule instead of 18. Readers first: the current release reads that form and
  writes JSON; the release after it is in production writes the blocks. Defaults follow
  evidence on data they were not chosen on (D33): a rule that does not page uses the robust
  z-score with a tail-aware spread (the 99th percentile of |x − median| over 1,500 points),
  which beat EWMA and a static threshold held out on NAB and on a second benchmark of server
  metrics never used to choose it, where EWMA, the earlier default, fell below the threshold;
  pages use a static threshold; the seasonal baseline is opt-in, for values wrong for their
  time of day; with the MAD spread, robust z and the seasonal baseline both scored below a
  static threshold; STL, CUSUM and PELT explain changes and do not page.
  Defaults are written out when a rule is saved, so a changed default never changes a stored
  rule, and a rule saved again keeps the defaults it was stored with. Seasonal
  decomposition, changepoint detection and log-template frequency shifts are scheduled jobs
  (not built). Foundation models in a Container are an opt-in later tier.
- **SLOs** are a rule kind too (`contracts/rules.ts`, version 4): an objective, a compliance
  window and an SLI (good or bad, and total events, or an error ratio). The ruler raises the SRE
  Workbook's multi-window, multi-burn-rate alerts (page 1 h / 5 m at 14.4× and 6 h / 30 m at 6×,
  ticket 1 d / 2 h at 3× and 3 d / 6 h at 1×) from **one query per rule per tick**, the last
  interval's events, and keeps each series' buckets for the longest window and coarser ones for
  the compliance window as state (D42), so every alert says which windows burned, how fast, and
  how much budget is left. A new anomaly or SLO rule is **warmed from history** before its first
  evaluation: its look-back is read at its interval, its series counted first when the rule's
  bound would cut it into windows, every query it fetches planned first (viz-query's
  `/api/v1/plan`) and the run refused whole over a budget, never fetched in part, then fed through
  the rule's own evaluation in time windows cut by the points they hold to fit a memory budget,
  only the rule's state carried between them (D43). **Backtests** of threshold, anomaly and SLO rules run the same
  evaluation over a past range in time order, under a larger budget, and return when each alert
  would have fired and resolved with the explanation it would have carried. Both are also priced
  in CPU (a model calibrated per point read) and refused whole over a budget under the Durable
  Object's per-invocation limit, rather than cut off by it; warm-ups share a budget per alarm, and
  one that does not fit what is left waits for the next alarm (D51).
- **Agentic monitors** are a natural-language objective with a deterministic guard and a
  budget. They run as a Workflow when a rule fires, an anomaly is detected, a schedule
  comes due or a person asks. They use the same read-only, tenant-scoped tools as external
  agents. They never decide whether to page. Every claim in a report links to the query
  behind it. Published root-cause accuracy for such agents is 25–60%, so reports are
  advisory and rated by people. Telemetry is untrusted input: agents have no write tools,
  no cross-tenant handles and no egress, and an injection corpus runs in CI.

## 8. Frontend and agent surface

- **Dashboard model, `viz.dashboard/v1`.** A small closed JSON Schema: panels keyed by
  stable id, a separate layout tree, named queries, variables, reusable fragments. Panels
  require a unit and a description; dashboards require an intent. Edits are JSON Patch
  against a base revision, dry-run against real data before saving. Revisions record who or
  what made them. Grafana and Perses importers.
- **One model, three readers.** Every view has a visual form, a text digest and a structured
  form, generated from the same spec and data. Agents read digests (value, range, trend,
  outliers, threshold state per panel) instead of raw series or screenshots; the digest is
  also the accessible view.
- **Agent tools.** A stateless MCP endpoint (its own Worker, `mcp/`; D25, D26) with
  scoped, tenant-bound credentials: API keys, or OAuth 2.1 access tokens (D44) that MCP
  clients get as the specification describes (protected resource metadata, registration,
  PKCE S256, resource indicators), from the control plane as authorization server. A person
  approves each client with a key that holds `admin`; the grant never holds a scope that key
  lacks, and is backed by an agent key the MCP server acts with downstream, so the client's
  token never leaves `/mcp`. Control checks the token on every request, so revocation is
  immediate there; the MCP server asks through a named entrypoint of control that answers only
  that question and takes the tenant from the token, never through control's `Tenant` objects
  (review of D44, M-1). A code or token carries a tag made with control's key, so a made-up one
  is refused in the Worker before any tenant's object is asked, and a request that changes
  nothing writes nothing (M-2). Until a sign-in exists the consent step is a call to the control
  API, and only an API key may approve.
  Fourteen tools: search telemetry, describe a metric, validate a query (with the query
  service's own plan: files, bytes, scan bound, refusal), run a query,
  search / get / read dashboards, the dashboard schema, write a dashboard, list revisions,
  list and get monitors, backtest a monitor (when it would have fired and resolved, read-only,
  under the ruler's budgets, refusals passed through with their numbers), annotate (refused
  until an annotation store exists). Results are
  compact text within a token budget, with tenant text fenced as data, and the same page as
  structured content; each result returns its usage counters, and budgets per identity are
  the caller's to keep (D28). A JSON API (`/api/v1/agent/…`) serves the same tools through
  the same dispatcher (D27); the in-app assistant, not built yet, is to call them too. Writes
  by agents are dry runs and proposals, for a new dashboard or a change to one; a person
  applies them (D29). Rendering a live panel inside an agent host (MCP Apps) comes after
  launch.
- **Compatibility.** The Prometheus and Tempo HTTP APIs are served, so Grafana and existing
  tooling work against viz from day one.
- **Stack.** React 19 single-page app on Workers static assets; Hono; TanStack Router and
  Query; CodeMirror 6 with PromQL and TraceQL grammars; uPlot behind an internal chart
  interface; custom canvas for heatmap, flame graph and trace waterfall. Arrow IPC for large
  results. Coarse data first, refined in place.

## 9. Auth, tenancy, limits

- **Machines:** opaque prefixed API keys, hashed at rest, scoped, cached at the edge,
  revocable at the shard.
- **People and agents:** OAuth and OIDC single sign-on; roles plus label-matcher policies
  applied in the planner. Built so far: OAuth for agents (MCP clients), with the control
  plane as authorization server and grants that a person with an admin key approves (D44);
  sign-in for people, roles and policies are not built. Until sign-in exists, the control
  plane accepts only API-key identities, and a grant whose approver is not a key ends.
- **Service-to-service:** a Worker that needs one answer from another binds a named entrypoint
  that answers only that, with the caller in the binding's `props` (D45; the MCP server's token
  introspection, review of D44). A Durable Object class of another Worker is bound only where
  `deploy/workers.json` lists it with why (`binds_classes`), because such a binding reaches every
  method of every object of the class; today the ruler and the gateway still hold control's.
- **Isolation:** tenant id comes only from the credential; files are tenant-pure; the ledger
  is per tenant. Cross-tenant reads are an invariant with its own fuzz suite.
- **Quotas:** enforced in the shard, per tenant; rejection reasons are visible. Byte budgets
  are exact. The active-series limit is not (D21): each shard enforces an even share of the
  tenant's limit, counting exactly up to 4,096 series per half-hour bucket and with a
  HyperLogLog (1.6% standard error) and a Bloom filter (about 1% of new series pass as
  known) above that.
- **Cardinality on the read path:** reported exactly, with caps sized to the isolate (D32);
  what a metric with 10,000, 100,000 and 1,000,000 series costs to store, count and query,
  and where each limit bites, is in `query/CARDINALITY.md`.

## 10. Targets

Hypotheses until the read-slice spike measures them.

| Path | Target |
|---|---|
| Ingest acknowledgement | p50 < 80 ms, p99 < 500 ms. Measured on Cloudflare: 60 ms and 113–340 ms below shard saturation as first built; with group commit and early refusal, 30–71 ms and 86–276 ms from 1 to 200 clients per shard (2026-11-19) |
| Time to queryable | p99 < 10 s |
| Dashboard refresh, warm partials | p50 < 300 ms |
| First load, 24 h on compacted days | p95 < 1.5 s |
| First load, 24 h including today | p95 < 3 s |
| Trace by ID with a time hint | p95 < 1 s |
| Rule evaluation delay | interval + 15 s |

## 11. Cost

Ranges, at list price, from the reviewers' recomputation of the research model against this
design. None is measured.

| Case | Range per month | What decides where in the range |
|---|---|---|
| Single small deployment (10k series, 1 GB logs/day, 1M spans/day, 20 rules) | about $5, the plan fee, plus storage | Measured (`spikes/s0-do-billing/`, first hour): an object that wakes once a minute bills about 20–40 ms per wake, roughly $0.002 a month, so periodic ticks do not threaten the floor. What remains unmeasured is the work done inside each tick |
| Additional small active tenant | under $1 pooled; about $6 with a dedicated pool | Pool assignment; seal age |
| Team (1M series, 100 GB logs/day, 500M spans/day, 2k rules) | $400–800 | Compaction CPU, commit window, rule classes, first-load query reads |
| Scale (100M series, 10 TB logs/day, 50B spans/day) | tens of thousands | Long-retention storage; shard duration |

Even at the top of these ranges the team figure is more than ten times below the list
prices of hosted alternatives in the research. The main levers are rollups for long
retention, batching WAL writes, seal age, and keeping rules in the tail class.

## 11a. Monitoring viz itself

Proposed, not built: `design/SELF-MONITORING.md` (decision D23). viz's own metrics, Cloudflare's
analytics for its Workers, and a freshness prober go to a `viz-internal` tenant in the same
deployment, to understand scaling, nominal performance and cost per unit of work.

## 11b. Updating in place

Every push to `main` deploys, so two releases always share storage and messages for a
while: callers and callees skew both ways, a Durable Object adopts new code up to 30 s late,
and a rollback puts old code on new storage. `contracts/COMPATIBILITY.md` is the contract
for that: every Durable Object records a schema version and migrates in its constructor
(`contracts/schema.ts`, D24); storage newer than the code is refused, never guessed at;
every format that crosses a release boundary carries a version; readers deploy before
writers; changes expand, then contract; a release with a breaking migration is
forward-only. `design/UPGRADES.md` has the inventory of formats, the verified platform
facts, the rollback rules and what each component still has to change. As built, control,
the ruler, the publisher, and on the write path the ledger, the shard and edge follow it,
as do the flush and maintenance messages; `UPGRADES.md` §7 lists what the others still
have to change. The deploy records each class's schema version in every release record and
on every Worker version, marks a release forward-only when a class's `readableFrom` is above
what the release before it knew, and refuses a rollback when any version that ran since the
target wrote storage the target cannot open (D46; `deploy/README.md`). Format versions are not
in that check yet. Secrets the deploy generates (control's OAuth client key) are put on the
version a release uploads, before anything is promoted, only when that version lacks them, and
are never replaced except by a deploy told to (D53). A key seen on the serving version, in the
secret list, or on a version newer than the serving one (left by a rollback) but missing from
the upload stops the release rather than being made anew; wrangler runs that get a secret on
stdin write no debug log and redact request bodies whatever the environment says.

## 12. Launch scope

| Phase | Contents |
|---|---|
| 0. Spikes | The nine experiments in `VERIFICATION.md` §4, in order |
| 1. Metrics | Remote Write and OTLP metrics, shard / flush / ledger, PromQL subset, Prometheus HTTP API, R2-native Iceberg publication, minimal UI |
| 2. Traces and rules | Spans, trace index, TraceQL subset, Tempo API, rulers, notifications, dashboards and the MCP tools |
| 3. Logs and detection | Logs, LogQL, scrape, anomaly tiers, agentic monitors |
| Later | Managed catalog publication, SQL passthrough, tenant adapter code, native histograms, foundation models, MCP Apps |

## 13. Risks

| Risk | Mitigation |
|---|---|
| The engine does not fit an isolate | Second spike; split Workers by role; Container fallback; pure-JS Parquet as plan B |
| Per-minute wakes bill as continuous duration | Measured not to: a wake bills 20–40 ms (`spikes/s0-do-billing/`, first hour; 24-hour read pending) |
| First-load query latency on flat rows | Read-slice spike before any PromQL breadth; chunk-blob rows are the fallback |
| PromQL compliance is a long tail | Port from the reference with the upstream corpus; publish the supported subset |
| ~~The ledger admits about one flush unit per second~~ (measured, `spikes/s4-ledger-scale/`) | **Fixed** (D36): it answers after the SQLite commit and logs in batched background segments; 234–422 units per second with eight writers, measured on Cloudflare 2026-11-19 |
| A shard that lost its storage and gets no new writes is never registered in its new incarnation, so queries naming the old one are refused indefinitely (spec F6); a stream registered lazily can hide acknowledged rows from a query after a storage loss (F6(b)) | **Built** (D61): a read naming a lost incarnation registers a fresh one; registration logged before a new stream's first write, which production turns on in the release after edge maps the refusal to 503. Cost: about a second before a new stream's first acknowledgement; a tenant whose ledger cannot log takes no writes on new streams |
| Plans grow with file count: 276 ms and 5.8 MB at 7,000 files | Not yet fixed. Index fragments inline only for small plans; consolidated partition indexes; paging |
| A tenant's ledger holds at most 300 MiB of state, about 300,000 live files: memory no longer bounds it (checkpoints in parts, a rebuild that streams; D47), the time a rebuild takes does (20 s here at that size, modelled 20–60 s on Cloudflare, the tenant refused meanwhile) | `addUnit` answers `full`, retryably, above it; compaction and retention make room. The publisher re-bases such a tenant streaming, from its newest checkpoint or its base, in bounded memory (measured at 300,000 files under a capped heap, `publisher/README.md`), so production runs at the full limit since 2026-11-19 (before, 16 MiB) |
| Cloudflare ships an overlapping product | Open formats, PromQL/TraceQL, external sources, agent surface |
| Platform-wide outage | Accepted for a Cloudflare-only product; data remains plain Parquet and Iceberg |
