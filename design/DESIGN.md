# viz — system design

Status: draft 3.1, 2026-11-18. Draft 2 was reviewed by two independent reviewers (57
findings) and rewritten as draft 3; draft 3 was re-reviewed (12 findings) and amended here.
`REVIEW.md` lists what changed and what is still open.

Status (2026-11-28, `main` after pull request #9, D75 and the web app): the backend described here is built and
on `main`. Production has been live since 2026-11-19: it ran fb77292 (pull request #8, deployed by
the owner) from 2026-11-19 to 2026-11-28, and 375e9ba (pull request #9) from 2026-11-28, deployed by
the Deploy workflow (run 46125868615, 08:27–08:36 UTC; `/healthz` then reported 375e9ba with every
backend healthy, OAuth metadata answered 200 and `/oauth/register` 201: measured on Cloudflare); every
push to `main` deploys since. Its address is `viz.bitcru.sh` from the release that carries D75; until
that release, it was `vis.bitcru.sh`, which stays attached for data senders during a transition
(D75). Spikes S0–S5, the S3/S4 re-runs and S9–S11 were measured on
Cloudflare, and staged copies of the deployment were trialled and destroyed (`VERIFICATION.md`,
`deploy/README.md`). Figures not marked as measured are models, printed as ranges, and
`VERIFICATION.md` names the experiment that would confirm or kill each.

Spans and logs are on `main` end to end: ingest decoding, shards, flush, the ledger, compaction
(D68), Iceberg publication (D67) and the Tempo and Loki read APIs (D62), built behind
`INGEST_SIGNALS` and `QUERY_SIGNALS`, both off in production. Their adversarial review
(`reviews/signals-end-to-end.md`) found a blocker and six majors, all fixed; D62 was reviewed
again (`reviews/signals-end-to-end-r2.md`, approve with changes), its four findings fixed, and
the fixes re-checked on 2026-11-26 (`reviews/signals-end-to-end-r3.md`: D62 approved, measured
here, not on Cloudflare). `QUERY_SIGNALS` stays off until spike S10's realistic and fat shapes are
run again on Cloudflare with this build, Grafana has run against a staged gateway, and the owner
accepts the stated ceilings for the tenants in question (§6.4).

The first release over fb77292, which put six Rate Limiting bindings on viz-control (D70), was run
on a stage before #9 merged (`spikes/s13-upgrade-trial/`, 2026-11-28, measured on Cloudflare):
Cloudflare accepted the bindings at upload and its version API lists them as `type: ratelimit`
with `namespace_id`, as the deploy reads them (review of D69, round 2, M2-2, settled; §11b, §13).

The interface (`app/`, `design-system/`, §8) is on `main` and served by viz-gateway at
`https://viz.bitcru.sh/` from the release that carries D74 (on `vis.bitcru.sh` its pages are a 308
to viz, D75). That release was the first with the app, refused until a stage run of the same serving
code was recorded (D74 point 6). The app's design reviews are in `design-system/reviews/`. One budget
row is not met: a result of many series in Explore paints more than 100 ms after it arrives (blocker
B1 of the app's review). A second reviewer offered a waiver on conditions, with rules that reopen it
(`chart-speed/second-review.md`), and its state at the merge is recorded in that directory and in the
pull request that brought the app to `main`. Self-monitoring is proposed, not built.

## 1. What viz is, and how it is deployed

viz is an observability store and frontend that runs entirely in one Cloudflare account:

- metrics, logs and traces in Parquet files on R2, published as Apache Iceberg tables;
- PromQL and TraceQL, with the Prometheus and Tempo HTTP APIs so existing tools can point at
  it, and LogQL for logs (`engine/logql`: most of Loki's language, with Loki's result shapes);
- authenticated push (OTLP/HTTP, Prometheus Remote Write) and pull (scrape, adapters);
- dashboards that agents and people both write and read;
- monitors: rules, anomaly detection, agent-run investigations.

**Where it runs.** One Cloudflare account, served under `viz.bitcru.sh`; `vis.bitcru.sh`, the
earlier address, is kept on the gateway during a transition: data senders and data sources are
served there as before, with `Deprecation` headers, and everything else is redirected to viz with a
308 (D75). Every resource viz creates there is named `viz-…`.

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
| `app` | Worker + static assets | UI, REST and Prometheus/Tempo-compatible APIs, OAuth. As built, this is the gateway (`deploy/gateway`, viz-gateway on `viz.bitcru.sh`, with `vis.bitcru.sh` kept for data senders, D75): it routes each API path to the Worker that serves it and serves the web app's build, the hashed files as its own static assets without running, the document itself (D74) | per request |
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
is wired (stage 3, 2026-11-19): the gateway (then on `vis.bitcru.sh`, now `viz.bitcru.sh`) routes `/v1/traces`, `/v1/logs`
and `/loki/api/v1/push` to viz-ingest by exact path, as it routes `/v1/metrics`; edge answers
them 404 while `INGEST_SIGNALS` does not name the signal. A pool map's own pool never ends in
`/traces` or `/logs` (edge refuses such a map, 503, metrics included; control refuses to assign
one, so tenants `traces` and `logs` keep the shared pool, D66; control and edge check a map with
one function, `validBasePool`, which also requires `POOL_NAME`, and a dedicated pool is
`dedicatedPool`'s `tenant/<id>` with `_` written `-`), so a shard named
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

1. `edge` verifies the API key, decodes the body to a columnar batch, and forwards it. What it
   builds while decoding is bounded whatever the body's shape (D71): every key-value entry and
   array element is counted before it is built and an item of more than 65,536 is refused on its
   own; a request whose JSON structure or decoded size passes its limit, or whose body is over
   8 MiB decompressed, is refused whole with 413 before anything is appended
   (`contracts/BATCH.md`, "Decode limits").
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
capped at 16 MiB by default, and production keeps that (`stack/wrangler.jsonc`): it is the cap
of the releases before D47, kept until a release whose rollback floor has D47 and D55 lifts it
(`design/reviews/d47-d48-d55.md`, P-2 and P-3). A rebuild and a first publication above it have
since been measured on Cloudflare (S11, `spikes/s11-large-ledger/`): both fit the 30 s CPU limit
at 64 MiB with margin and at 150 MiB without, and 300 MiB extrapolates over it, so the cap can
rise to 64 MiB; that is not done (D47). The code's own limit is the largest measured locally
(300 MiB, about 300,000 files; 20 s): above the cap `addUnit` answers `full`, retryably, until
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
`QUERY_SIGNALS` (D62, §6.4; off, and to stay off until spike S10 is run again on this build, a
Grafana run, and the owner's acceptance of the stated ceilings: `design/reviews/signals-end-to-end-r3.md`),
and both halves are joined through the gateway (stage 3), and they
are compacted (D68, §5.2). The publisher publishes them as Iceberg tables of their own (D67, §5.3;
before it, D64's release read them without publishing them): `INGEST_SIGNALS` may go on in a
deployment only once viz-publisher (D64's release or later), viz-query (D62's or later) and
viz-ingest (D63's or later) are each at that floor, in the release and as they serve (one the release
does not deploy included); from then on no release or rollback may put one of them below it. The
release tooling enforces both (D69, `deploy/README.md` "Rollback floors"), widening D64's rollout
rule, within three limits its review left (`design/reviews/d69-deploy-safety.md`): "from then on" is
as long as a version with the switch on is among the 100 Cloudflare keeps of viz-ingest; a local
rollback that overlaps a deploy turning the switch on is not caught; and only main's tooling is
held to it, so production deploys only from main (an older commit's own tooling predates the
check; older code goes out again as a new commit on main).

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
  through the same purge and the same publisher gate. A `trace_days` or `log_days` that is
  present but unreadable stops that signal only, reported the same way; the metric tables never
  wait for it (D63). Control asks for confirmation of any change that shortens what the janitor
  keeps, including a field a replacing PUT leaves out, which returns to its default (D63).
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
commit first and are byte for byte what they were before. After the upgrade from D64's
release every tenant is re-based once (the new tables have no cursor), a few per publish: at most
100 tenants and 100,000 units of work (files staged, added files written into manifests ahead of
a commit, entries rebuilt), least recently started first, while waiting tenants keep their metric
tables published from their cursors (D67, after review M-6). A tenant larger than that budget is
re-based across publishes, its stage and progress kept in SQLite, and committed once (D55's
amendment); a table lost with the publisher's storage is rebuilt from R2 the same way, a manifest
at a time. A table whose cursor is below the checkpoint or base its tenant was read from is
re-based with it, never planned from its cursor, so no change between the two is skipped
(`design/reviews/d47-d48-d55.md`, P-1). A table no
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
  the tail it needs. The coordinator reads it under one byte budget for all the shards, and cuts
  it by split key in JavaScript, never in the engine. When it does not fit and the query splits by
  `series_id`, the coordinator fixes each shard's end (from the first page, or from the shard when
  that page did not fit), and each part reads the rest in its own key range through that end, so
  every part answers the same moment of each shard; at most `maxTailReadParts` parts read rests,
  since each read scans the shard's tail on the object that acknowledges writes (D54). Span and
  log tails (§6.4) are read the same way, under one budget over their signal's shards, and are
  never split. A shard of the previous release answers unfiltered and is read as before. Split readers read their id range
  of the series files and the split runs again by name and time when any part saw a series whose
  key is not its id, or cannot say (a reader of the previous release, during a deploy: D59). Shards
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
Tempo's and Loki's HTTP APIs behind `QUERY_SIGNALS` (off by default). The adversarial review of
the first version (`design/reviews/signals-end-to-end.md`) rejected it: a found trace's spans
outside the window were never read (M-1), and the caps bounded rows and compressed bytes, not
memory (M-2). Both were fixed as D62 describes, with the review's inputs as tests. The re-review
(`design/reviews/signals-end-to-end-r2.md`, approve with changes) found the budget missing from the
Loki label calls (R2-M1) and charged after the fact for derived structures and answers (R2-M2), the
margin's cost larger than stated (R2-M3) and trace by ID refused for ordinary tenants (R2-M4a);
all four are fixed as D62's second rewrite (2026-11-19) describes, with its reproductions as tests.
The narrow re-check of those four (`design/reviews/signals-end-to-end-r3.md`, 2026-11-26; measured
here on the ABI 8 module, not on Cloudflare) closes all four and approves D62, with four corrections
to stated ceilings (below, and D62 "Corrections from the narrow re-check"). `QUERY_SIGNALS` stays off
until S10's realistic and fat shapes are run again on Cloudflare with ABI 8, Grafana has run against
a staged gateway, and the owner accepts those ceilings for the tenants in question (`query/README.md`,
"Traces and logs", "What remains before the flag"). Spike S10 (measured on Cloudflare, 2026-11-19, on the build before those fixes) found the memory
budget held (isolate at most 70.8 MiB) but every trace query refused at about 690,000 spans in five
minutes, by `maxFetchBytes` against one hour's bytes: one place serves trace by ID up to about
240,000 spans in the trace's hour, and searches up to about 620,000 spans in the window plus four
hours. D62 "What volume this serves" has the ceilings and the follow-up design (bloom filters on
`spans.trace_id`, `trace_index` read in waves, smaller row groups), not built.
The write side of stage 2
(D63) flushes and lists the `spans`, `trace_index` and `logs` tables, and tail reads choose
batches by signal (`signals`) and, given a time range, skip span and log batches whose time
bounds, recorded by the shard at append, lie outside it (D72). Stage 3 (2026-11-19) wired the halves together: the gateway routes
Tempo's documented read paths (`/api/traces/<id>`, `/api/v2/traces/<id>`, `/api/search`, the tag
and tag-value paths in v1 and v2, `/api/metrics/query_range`, `/api/metrics/query`) and Loki's
(`/loki/api/v1/query`, `/query_range`, `/labels`, `/label/<name>/values`, `/series`) to viz-query
by exact path, one segment per path parameter; their other paths stay 404 at the gateway, and
viz-query answers these 404 while its flag is off. Tested through the gateway in front of the real
ingest and query Workers (`stack/README.md`, "Through the gateway"); answers equal to the
engines' in-memory ones over whole corpora through edge, flush and the ledger are query's own
end-to-end test (`query/test/signals.e2e.test.ts`). The engines (`engine/traceql`,
`engine/logql`, clean-room, D35, D40, D50) are linked into the read path's one WASM module
(`engine/wasm-query`, ABI 8), which reads the files `engine/storage` writes and the span and log
tail batches through the engines' read seams. The seam with the tail is the metrics one (§2):
one ledger version per query, tails strictly after the plan and above its watermarks, refusals
re-planned. Every read sends its signal to the shards (`signals`), asks only its signal's shards
(by name, for shards of a release before D63; a name is unambiguous since edge refuses base pools
ending in `/traces` or `/logs`, §4.1) and checks every tail batch's header (a batch of
another signal refuses the query, never misread).

- **A trace the answer names is whole within a margin** (D62). A search, a TraceQL metrics
  query that needs whole traces, and trace by ID with a time hint read `trace_index` over the
  window widened by the tenant's `traceMarginMs` (2 h) on each side (the bound); the engine finds
  the traces whose extent, merged over their pieces in the bound (fragments and tail spans),
  overlaps the window, in passes over the pieces' id and time columns that hold the window's
  traces and the ids of those after it, not every trace of the bound; it gives their hull and the
  ranges their pieces cover; the `spans` row groups that overlap those ranges are read at the
  same ledger version (a long trace costs the flush units its far pieces lie in, not the hull),
  and the engine drops every span that starts outside the bound before de-duplication. Measured
  ceilings (here): a one-minute search answers at 72 traces a second in a window that ended hours
  ago, and holds nothing for the margin in a window that ends now. Every trace the answer names is evaluated over exactly its spans
  that start inside the bound, wherever they were flushed and with pruning on or off: all of
  them when the trace lies within the margin of the window; a longer trace is answered from its
  part inside the bound, deterministically. A trace's summary is computed from its spans
  (`trace_index` counts are upper bounds: a retried span is counted twice). Metrics queries
  whose pipeline is span-local, tag names and tag values read only the spans that start in the
  window, cut before de-duplication (D62; review of D72 m-2): what lies outside the window cannot
  change their answers. One exception, from the narrow re-check
  (r3-m4): a span re-sent with a moved start has two copies, and these calls count the copy that
  starts in the window while search uses the later write, so the two can disagree for one window.
  Only a sender that changes a span's start between retries reaches it. Structural operators are evaluated per trace in one place.
- **Trace by ID:** the `trace_index` row groups whose trace-id range (from the index fragment)
  holds the id are read, over all time without a hint and over the hint and the margin with one;
  the trace's fragments name its extent and the `spans` hours that hold it, and only those hours'
  files are read, their row groups chosen by the trace's pieces. Inside them a flush unit's row
  group is decoded whole to find the trace (the bloom filters are not used yet): the cost of a
  call is the unit's spans, but only the trace's are held and counted against `maxSpans`, so a
  large unit does not refuse it (R2-M4a). Without a time hint every day is planned (newest-first
  waves are not built): modelled, every uncompacted `trace_index` file is read whole and a
  compacted one by a row group of up to 2 MiB, so `maxFetchBytes` refuses a hintless lookup past
  about 8 days of compacted retention above about 2.7 spans a second (D62, "Cost of it").
- **Memory is bounded by bytes, charged before each thing is made** (D62). The engine charges what
  each span or log call holds (rows, a span's resource once per distinct resource) and what it
  derives as it grows (metric series with every point, histogram buckets and one output series
  per bucket or quantile, tag and label sets, LogQL label sets from `regexp` or `label_format`,
  trace extents), against the tenant's `maxDecodedBytes` (32 MiB), the Loki label calls included,
  and the answer four times before it is written; it refuses (422) before the thing that would
  pass the budget is made. A call's peak WASM memory is then the budget plus what it was handed
  plus a constant measured under 12 MiB (it reached 0.1 to 0.9 GB on a few hundred rows before);
  for fat rows in flush's 16 MiB row groups the constant is up to one row group's decoded pages
  (70.8 MiB measured where the bound says 53.8; the isolate still fits, with a thinner margin:
  r3-m1). A LogQL query that makes a series per line is refused well under the row cap: `sum by
  (level) (count_over_time({…} | logfmt [1m]))` over lines with a unique field at about 6,000 rows
  in the window, and at 30,000 with `| keep level` (r3-m2).
  The row caps (`maxSpans` 18,000, `maxLogRows` 30,000) count rows held and are checked from the
  fragments before any fetch (trace by ID by bytes). Split execution by trace-id hash, partial
  results with a cursor, and pushing predicates to sorted and promoted columns are not built. A
  span or log query sends its range to the shards, which skip span and log batches outside it
  (D72; measured here: a one-hour query takes 2.3 MB instead of 18.7 MB from an eight-hour span
  tail, 11.7 MB with the trace margin); a backlog over `maxFetchBytes` inside one range is still
  refused.
- **Tables and engine:** the `spans` and `trace_index` tables are specified in
  `contracts/TRACES.md` and written by `engine/storage`; flush writes them (stage 2, D63).
- **Logs:** row groups are chosen from each file's stream list and times; rows of streams no
  selector matches, or outside every selector's range, are dropped before they are held. One
  place, bounded by `maxLogRows` and the engine's byte budget; the per-file token filter
  (compaction writes it inside the file, D65) is not read by the query path (it would skip row
  groups for line filters such as `|=`; not built); split execution and partial results with
  a cursor are not built either. Labels and series come from the fragments'
  stream lists without reading data where the lists exist, under the byte budget; past it they
  are refused, never cut short (Loki's API documents no `limit` for them).

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
  nothing writes nothing (M-2). A code or token also carries its expiry under that tag, so the
  Worker refuses an expired one the same way (D70, after its review). When the tenant's object
  says a token is dead (a refresh or access token of an ended grant, or one it never knew), the
  Worker lists it, in the isolate at once and in KV until the credential expires, and afterwards
  refuses it after its own rate limit and before its tenant's fuse or object; so a stock of refresh
  tokens collected while a grant was live is good for about a minute after its first replay, not for
  the 30 days they would otherwise last (D70, after its second review). Nothing is listed whose
  later presentation must still reach the object: never a rotated refresh token of a live grant,
  whose other holder presenting it is what makes reuse detection end a stolen grant (D70, third look). Rate limits sit in front
  (D70): Cloudflare's Rate Limiting binding, approximate and per location, counts the presented
  credential and then its tenant, as a fuse near what one object serves, before the tenant's
  object, so a credential spends only its own allowance; the tenant's fuse is asked only when the
  credential's own limit was, so a limiter fault never leaves the fuse alone to count a dead
  credential; it counts a client's network only at registration and the authorization page, and for
  requests without a genuine credential, never a genuine one, expired included (every client on
  Cloudflare Workers shares one address, which is not counted); the object itself bounds refreshes
  per grant exactly, and the grant view shows how many a grant made in its last day; a refusal is
  429 `too_many_requests` with `Retry-After` and spends nothing; a limiter or the list that fails
  lets requests through within 100 ms (each check its own share; a slow list read affects its own
  key only) and is reported by `/healthz`. The
  fuses are per location: floods from several locations add up on one object. These limits assume
  no Smart Placement for control and mcp, which the deploy refuses on both. The deploy also refuses
  a production control without the six bindings (each deployment gets namespace ids of its own,
  never one another script of the account binds), and will not put control's OAuth key on a version
  without them (D70's gate). Until a sign-in
  exists the consent step is a call to the control API, and only an API key may approve.
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
  Query; CodeMirror 6 with PromQL and TraceQL grammars; the design system's own chart behind
  an internal chart interface (as built; uPlot was the plan and was removed when the app moved
  onto design system v9, `app/README.md`); custom canvas for heatmap, flame graph and trace
  waterfall. Arrow IPC for large results. Coarse data first, refined in place.
- **Serving, as built (D74, 2026-11-26; on `main` with the web app).** `app/serve.json` says how the
  build is served and the gateway serves by it: files under `/assets/` (content-hashed, kept
  for good) and the icon are viz-gateway's static assets, answered by Cloudflare by exact path
  without invoking the Worker; the documents serve.json lists come from the Worker with the
  content security policy and `no-cache`; the API's paths come first, for static files too (the
  API's part of the path space is one file both the gateway and the deploy read), and every
  other path, an unknown API path and a missing asset included, is the JSON 404, never the
  document. A release carries the build it was made with: built by a job that holds no secret,
  handed to the job that holds the Cloudflare token as data, and verified there against the
  release's sources and file by file before upload; and the files of the three builds before
  it, for at most thirty days, for pages still open. A rollback of the gateway brings back the
  build its version held. The first production release with the app is refused until a stage is
  recorded to have gone before it, or the owner overrides with a reason
  (`deploy/README.md`, "The web app", "Who can read the Cloudflare token", "A stage before
  production"; review: `design/reviews/d74-gateway-app.md`). The app is served on `viz.bitcru.sh`
  only: on `vis.bitcru.sh` its documents and a missing asset are a 308 to viz, and its files, which
  Cloudflare's asset layer answers before the Worker runs on every hostname, are served as on viz
  (D75, "The web app on vis.bitcru.sh").

## 9. Auth, tenancy, limits

- **Machines:** opaque prefixed API keys, hashed at rest, scoped, cached at the edge,
  revocable at the shard.
- **People and agents:** OAuth and OIDC single sign-on; roles plus label-matcher policies
  applied in the planner. Built so far: OAuth for agents (MCP clients), with the control
  plane as authorization server and grants that a person with an admin key approves (D44);
  sign-in for people, roles and policies are not built. Until sign-in exists, the control
  plane accepts only API-key identities, and a grant whose approver is not a key ends. The
  authorization server has one issuer, the public origin (`https://viz.bitcru.sh`), and issues
  tokens for one resource, `<issuer>/mcp`; OAuth is not answered on `vis.bitcru.sh`, which
  redirects there, and a grant approved for the earlier resource is not refreshed, so its client
  connects again (D75).
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
| Single small deployment (10k series, 1 GB logs/day, 1M spans/day, 20 rules) | about $5, the plan fee, plus storage | Measured on Cloudflare (`spikes/s0-do-billing/`, 24 hours, 2026-11-18 to 19): an object that wakes once a minute bills 20–34 ms per wake and ran at 0.03–0.06% duty, about $0.002 a month of duration at list price, so periodic ticks do not threaten the floor. Each wake also wrote 3 SQLite rows, which at list price is about $0.13 a month for a once-a-minute object (modelled from the measured count; 50 million rows a month are included): more than its duration. What remains unmeasured is the work done inside each tick |
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
target wrote storage the target cannot open (D46; `deploy/README.md`). It records format versions
the same way (`VIZ_FORMATS`, each Worker's written and read versions from its components'
`FORMATS` maps and read lists; every Worker declares what it reads, completely, and one that declares
nothing is taken to read version 1 of everything), marks a release that writes a version some
serving Worker does not read forward-only, and refuses a rollback that would leave a Worker it
restores under a version it does not read: one written since by a restored Worker, or one that a
Worker the rollback leaves serving wrote or writes (D69, revised after its review). A switch that
lets new data in (`INGEST_SIGNALS`) raises a rollback floor under every Worker that must read that
data (D69). Every production control carries `OAUTH_PUBLIC`, which holds control at the release whose
credentials carry their expiry and whose dead credentials are listed (D70); a release that sets it
over an older control is forward-only rather than refused, so the production first deployed before
this rule can take it (D69, point 6). Only main is deployed, with main's own deploy tooling: the tooling of an older commit
cannot judge rules added since. Every version a deploy run uploads carries a mark unique to the run, so the OAuth
key is never promoted on another run's upload; a rollback across the key's creation or rotation is
refused before anything moves (measured on Cloudflare in S9: the first leaves OAuth broken until
the next deploy, the second Cloudflare refuses). Secrets the deploy generates (control's OAuth client key) are put on the
version a release uploads, before anything is promoted, only when that version lacks them, and
are never replaced except by a deploy told to (D53). A key seen on the serving version or on a
version newer than the serving one (left by a rollback) but missing from the upload stops the
release rather than being made anew; wrangler runs that get a secret on
stdin write no debug log and redact request bodies whatever the environment says.

**Where production stands (2026-11-28).** The release described next was deployed on 2026-11-28
(375e9ba, pull request #9, Deploy run 46125868615), after spike S13 ran it on a stage and settled
the Rate Limiting bindings on Cloudflare; what follows is the analysis made before it. Production was first deployed on 2026-11-19 from `main`
at fb77292 with that commit's own tooling, which predates D69 and D70: its versions carry no
format versions, floors or run marks, and its viz-control has the OAuth key and no rate limits.
The first release of this tree over it is forward-only for viz-control (the `oauth-public` floor)
and so for the release as a whole: a failed smoke test does not roll it back, and a rollback of the
whole release or of viz-control to fb77292 is refused. The other six Workers (viz-publisher,
viz-ingest, viz-query, viz-ruler, viz-mcp, viz-gateway) can each be rolled back alone with
`--only`. It needs no Durable Object migration and keeps the OAuth key. All of this was checked
against fakes holding production as fb77292's tooling leaves it, not on Cloudflare
(`deploy/README.md`, "The first release over the 2026-11-19 production"). **Not verified on
Cloudflare:** whether Cloudflare accepts viz-control's six Rate Limiting bindings at upload, and
under which field names its version API lists them (the deploy reads `type: ratelimit` and
`namespace_id`, from training knowledge). If the names differ, every deploy after the first stops
when it allocates ids (review of D69, round 2, M2-2). The stage trial that settles both,
`spikes/s13-upgrade-trial/`, ran on 2026-11-28 and settled both: Cloudflare accepted the bindings,
and its version API lists them as `type: ratelimit` with `namespace_id`.

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
| Per-minute wakes bill as continuous duration | Measured not to: a wake bills 20–47 ms, and objects woken every 60 s ran at 0.03–0.06% duty over 24 hours against a 25% threshold (`spikes/s0-do-billing/`, measured on Cloudflare 2026-11-18 to 19) |
| First-load query latency on flat rows | Read-slice spike before any PromQL breadth; chunk-blob rows are the fallback |
| PromQL compliance is a long tail | Port from the reference with the upstream corpus; publish the supported subset |
| ~~The ledger admits about one flush unit per second~~ (measured, `spikes/s4-ledger-scale/`) | **Fixed** (D36): it answers after the SQLite commit and logs in batched background segments; 234–422 units per second with eight writers, measured on Cloudflare 2026-11-19 |
| A shard that lost its storage and gets no new writes is never registered in its new incarnation, so queries naming the old one are refused indefinitely (spec F6); a stream registered lazily can hide acknowledged rows from a query after a storage loss (F6(b)) | **Built** (D61): a read naming a lost incarnation registers a fresh one; registration logged before a new stream's first write, which production turns on in the release after edge maps the refusal to 503. Cost: about a second before a new stream's first acknowledgement; a tenant whose ledger cannot log takes no writes on new streams |
| Plans grow with file count: 276 ms and 5.8 MB at 7,000 files | Not yet fixed. Index fragments inline only for small plans; consolidated partition indexes; paging |
| A tenant's ledger holds at most 300 MiB of state, about 300,000 live files: memory no longer bounds it (checkpoints in parts, a rebuild that streams; D47), the time a rebuild takes does (20 s here at that size, modelled 20–60 s on Cloudflare, the tenant refused meanwhile) | `addUnit` answers `full`, retryably, above it; compaction and retention make room. The publisher re-bases such a tenant streaming, from its newest checkpoint or its base, in bounded memory (measured at 300,000 files under a capped heap, `publisher/README.md`), but production keeps 16 MiB: a rollback to a release before D47 must not meet a larger state, and the time is the bound. Measured on Cloudflare since (S11, `spikes/s11-large-ledger/`, 2026-11-19): a rebuild used 14.2 s of CPU at 64 MiB and 16.4–18.6 s at 150 MiB, a first publication 5.6 s and 14.0 s, against the 30 s default; 300 MiB was not run and extrapolates over it. S11 recommends 64 MiB; not lifted yet (D47; `design/reviews/d47-d48-d55.md`, P-2, P-3) |
| The first release over production carries viz-control's six Rate Limiting bindings, which have never been uploaded to Cloudflare or read back from its version API (review of D69, round 2, M2-2); that release is forward-only for viz-control | **Closed** (2026-11-28). `spikes/s13-upgrade-trial/` ran the release on a stage: Cloudflare accepted the six bindings and lists them as `type: ratelimit`, `namespace_id` (measured on Cloudflare). The release was deployed to production the same day (375e9ba, Deploy run 46125868615). The other six Workers can be rolled back alone (`--only`) |
| Moving the address to `viz.bitcru.sh` (D75): OAuth clients connected through `vis.bitcru.sh` must reconnect, and scripts calling control, monitors or the agent API on vis must change their base URL (a 308; most clients drop `Authorization` across hosts) | vis keeps the data paths, served with `Deprecation` and a successor `Link`; the deploy refuses to detach vis or touch another hostname; the transition ends only on the owner's word, from analytics, as a change of its own |
| Spans and logs on Cloudflare (S10, `spikes/s10-signals-trial/`, measured 2026-11-19): a compaction run was killed at the 30 s CPU limit (8 merges at 2.6–3.6 s each; retried successfully); every trace query is refused above about 240,000 spans in an hour (`maxFetchBytes` against one hour's files); a 4 KB body of empty spans costs 1.4–3.4 s of edge CPU to decode; flush throughput bounds span ingest at about 2.5 requests a second of 8,200 spans; a stage's cron and maintenance timers run on after its expiry | **Open**, none fixed. Both flags are off in production. Compaction: bound merges per run by CPU spent, or raise `limits.cpu_ms` (D68). Trace queries: bloom filters on `spans.trace_id`, `trace_index` read in waves, smaller row groups (D62, not built). Decode CPU: not bounded by D71. D62's second review fixes were re-checked and approved on 2026-11-26 (measured here); `QUERY_SIGNALS` still waits for a rerun of S10 on this build, a Grafana run and the owner's acceptance of the stated ceilings |
| Cloudflare ships an overlapping product | Open formats, PromQL/TraceQL, external sources, agent surface |
| Platform-wide outage | Accepted for a Cloudflare-only product; data remains plain Parquet and Iceberg |
