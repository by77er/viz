# Spike S15: a 429 stores nothing, and a known refusal is not decoded (D77)

The verification D77 asks for: S10's two ingest findings (`spikes/s10-signals-trial/README.md`,
"Ingest": a request refused at the end could be partly stored; a 429 cost a full decode), fixed in
`edge/` and `shard/` (D77), measured before and after.

**Status (2026-11-28): measured here (local workerd) and on Cloudflare** (the stage run, after the
review's fixes: "Stage run: results"). The stage and the load Worker were deleted the same hour;
the account's inventory after equals the one before.

## Files

| File | What it is |
|---|---|
| `local-bench.mjs` | Before/after on two local `wrangler dev` instances (the release at 375e9ba and this one): CPU and client time per refused request under a full buffer, acknowledgement latency of accepted requests, alternating between the builds. S10's body generator (`../s10-signals-trial/load/bodies.mjs`) |
| `local-run.sh` | Starts the two builds with `wrangler dev --local`, runs `local-bench.mjs` against them, stops them and deletes their state (paths in `BEFORE`, `AFTER`, `STATE`). Written from the scratch script that produced the numbers below; not re-run in this form |
| `rows.test.ts` | Rows written per request in the Workers test runtime, before and after: copied into `edge/test/` of each tree, run alone, deleted |
| `refused.mjs` | The stage run's item 1: the first trace of every refused (and of some accepted) traces request, by ID, through the stage from inside Cloudflare |
| `../s10-signals-trial/driver.mjs` | The stage run's load and its load Worker, with `SPIKE_STAGE=s15 SPIKE_TENANTS=s15-load` (every name follows the stage); `tails.mjs`, `analytics.mjs` from the same directory |

## Measured here (local workerd, this machine, 2026-11-28)

Two `wrangler dev --local` instances on this machine (4 cores, shared with other jobs; the edge
Worker with its shard, `INGEST_SIGNALS=traces,logs`, a config without the self service bindings, so
both could run at once): the release before (375e9ba) and this branch, each with its own state, the
tenants' keys and pool maps (2 shards, spread 2) written to local KV. Requests alternate between the
builds. Raw results: the scratch area's `result-run1.json` (client times and the acknowledgement
phase; its CPU column read one workerd process of the two `wrangler dev` runs and is discarded) and
`result-run2.json` (the refused phases again, CPU summed over every workerd process of each build).

**Defect 1, rows written** (`rows.test.ts`, both span shards, every `sql.exec`'s `rowsWritten`):

| Request (8,200 realistic spans, protobuf, gzip) | Before | After |
|---|---|---|
| accepted (two shards, several batches) | 24 | 24 |
| the same body again (duplicates) | 0 | 0 |
| refused, one shard full | **10 (its half stored)** | **0** |

**Defect 2, a refused request under a full buffer** (each build's two span shards filled with S10's
bodies until they refused: 37 bodies each):

| Shape | Before: client p50 / p90 ms, CPU ms per request | After |
|---|---|---|
| the same body retried at once (n = 200 each) | 135.5 / 196.8, **189.6** | 8.3 / 13.3, **9.0** |
| the same body retried after its `Retry-After` (1.05 s; n = 20) | 133.3 / 191.6, 164.0 | 16.6 / 20.7, 17.0 |
| a new body each time (n = 30) | 126.0 / 215.3, 173.0 | 145.7 / 199.6, 208.7 |

A new body is decoded by both builds (it was never refused); the difference is within the spread
of n = 30 here and includes the hash (the tenant is suspect) and the reserve and release round
trips; not separated. **What one isolate buys** is the first two rows, for retries that reach the
isolate that refused them; locally there is one isolate, so every retry did. On Cloudflare the share
of retries that land on the same isolate is the thing the stage run must measure.

**Acknowledgement latency, accepted requests** (client, alternating request by request, after 20 of
warm-up; fresh tenants as buffers filled):

| Body | Before p50 / p90 ms | After p50 / p90 ms |
|---|---|---|
| 2,000 spans over two shards, several batches (reserve path), n = 199 | 51.6 / 69.8 | 55.4 / 73.7 |
| 40 spans, one batch (no reserve), n = 200 | 10.2 / 13.6 | 10.1 / 13.0 |

The reserve round trip: about 3.8 ms at the median locally, on multi-batch requests only. Modelled
on Cloudflare: one Durable Object round trip in the same colo, a few to tens of milliseconds
against S10's 723 ms median acknowledgement of an 8,200-span request; to be measured by the stage
run.

Tuning steps: none on either side; the first local run's CPU read the wrong process (`wrangler dev`
runs the Worker and its proxy in separate workerd processes) and was redone summing both. The local
state (about 0.7 GB) was deleted after each run.

## The stage run: plan, names and worst-case cost (written 2026-11-28 12:55 UTC, before anything was deployed)

This replaces the plan written with D77; it now deploys the branch with the review's fixes (M-1, M-2
and the minors: `design/reviews/d77-ingest-reservations.md`, "Dispositions").

**Worst-case cost, modelled** (Workers Paid list prices as S10 read them on 2026-11-19, **ignoring the
included allowances**): at most S10's bound for its stage and load, and S15 runs about half of S10's
load (no query, fat, marker or hostile phases): **under US$2.50**. S10's whole trial measured
US$0.064 (analytics), so the expectation is a few cents.

**Expiry.** `--expires` (`VIZ_STAGE_EXPIRES_AT`, and the load Worker's `DEADLINE`) **2026-11-28T15:45:00Z**,
under 3 hours after the deploy. The load Worker has no alarm or cron and refuses every request after
its deadline; the stage's ruler stops evaluating at it; everything is deleted at the end of the run.

**From where.** The branch's worktree in the scratch area (this commit's parent tree, the fixes
committed), `node_modules` linked from the shared tree where `package.json` and `package-lock.json`
match (all 18 components did). No Rust build: `engine/` does not differ from `main` (5255b39;
`git diff --stat origin/main -- engine` is empty), so the engines built for main's tree are used,
copied in as `VIZ_WASM_PREBUILT=1` expects: `viz_engine.wasm` sha256 `df0ed8117e6123c2…`,
`viz_query.wasm` `ad27d8a88b2d0ba2…`. Deployed with `deploy/deploy.sh --stage s15`
(`VIZ_SKIP_NPM_CI=1`, `VIZ_WASM_PREBUILT=1`, `VIZ_STAGE_VARS` with `INGEST_SIGNALS=traces,logs` for
viz-ingest and `QUERY_SIGNALS=traces,logs` for viz-query), so only this worktree's
`deploy/resources.json` is written (not committed).

**Exact names.** Only `viz-s15-*`: the stage's Workers (`viz-s15-publisher`, `-ingest`, `-control`,
`-query`, `-ruler`, `-mcp`, `-gateway`; only the gateway on workers.dev, no route, no custom domain,
`vis.bitcru.sh` untouched), their Durable Object namespaces, `viz-s15-lake`, `viz-s15-config`, the
four `viz-s15-*` queues, and the load Worker **`viz-s15-load-client`** (S10's `load/worker.mjs`, deployed
by S10's `driver.mjs` with `SPIKE_STAGE=s15`, which names everything after the stage: a service
binding to `viz-s15-gateway`, a Durable Object class `Client`, one object per client). Tenant
`s15-load`. Secrets: viz-s15-control's generated `OAUTH_CLIENT_KEY`, viz-s15-gateway's `VIZ_BOOTSTRAP`
(deleted by `bootstrap.mjs`), viz-s15-load-client's `LOAD_KEY` and `TENANT_KEYS`: all generated here,
in 0600 files in the scratch area, set on wrangler's stdin, never printed, shredded at the end.
Inventory of the account before and after (`spikes/s11-large-ledger/inventory.mjs`); before: no
`viz-s15-` name of any kind.

**Load.** S10's run-1 shape from inside Cloudflare (one Durable Object per client): 4 clients × 12
requests of 8,200 items, closed loop, a 429 or 503 retried with the same body after its
`Retry-After` (at most 2 s), at most 8 attempts; OTLP traces protobuf (gzip) with every span new
(`--uniq`, `lcg32`), then OTLP logs protobuf and Loki protobuf, 70 s apart. `wrangler tail` on
viz-s15-ingest throughout.

**What is read, and what would count.**
1. **Partial storage after refusals (expect none).** For each request whose attempts were all
   429, its first trace by ID through the gateway: expected not found (S10: 4 of 10 found).
2. **The 503 rate**: attempts answered 503, by message (expected none, or a few, each a grant lost to
   an eviction or a refusal after a stored part).
3. **CPU per refused attempt** (tail: viz-s15-ingest's fetch by status; S10: refused p50 198 ms,
   accepted 204 ms), and the share of refused attempts answered before decoding (under 20 ms of CPU).
4. **Durable Object requests** for the window (analytics API, `analytics.mjs`), against S10's run 1.
5. **The reserve round trip**: the shard's `reserve` invocations' wall time (tail, Durable Object
   RPC events), and the acknowledgement latency of accepted requests against S10's run 1 (p50 723 ms).

**Delete.** `driver.mjs load-down`, `deploy/resources.mjs destroy --stage s15` (its leftover check
must find nothing named `viz-s15-`), the inventory difference must be exactly nothing, then the keys,
tails and state shredded or removed from the scratch area.

## Stage run: results (measured on Cloudflare, 2026-11-28)

**What ran.** Release `e8cea6f` (this branch with the review's fixes) deployed as stage `s15` at
12:56 UTC (`deploy.sh` exit 0 in 66 s after a first run refused, as designed, for the five
unacknowledged Durable Object migrations of a fresh stage, having created the stage's bucket, KV
namespace, queues and rate-limit ids first; smoke `/healthz` healthy); tenant
`s15-load` bootstrapped (default pool, 2 slots per signal); `viz-s15-load-client` with 4 client
objects. Load: S10's run-1 shape with `--uniq` bodies, `driver.mjs heavy --variants traces,logs,loki
--clients 4 --requests 12 --tenant s15-load --uniq` (`SPIKE_STAGE=s15`). Windows (UTC): traces
12:57:53–12:58:39, logs 12:59:49–13:00:19, Loki 13:01:29–13:01:35. `wrangler tail viz-s15-ingest`
throughout (a sample: Cloudflare's tail drops events under load).

**Accepted and refused** (client; closed loop, a 429 or 503 retried with the same body after its
`Retry-After`, at most 8 attempts):

| Body (8,200 items, every one new) | Requests | Accepted | Refused at the end | Attempts: 200/204, 429, **503** | Ack ms p50 / p90 / p99 | S10 (same shape) |
|---|---|---|---|---|---|---|
| OTLP traces protobuf, gzip (563 KB) | 48 | 33 | 15 | 33, 138, **0** | 752 / 1,176 / 1,445 | run 1: 33 of 48, 132 of 165 attempts 429, 723 / 1,340 / 2,386; run 2 (distinct ids, 3 clients): 708 / 1,608 / 1,897 |
| OTLP logs protobuf, gzip (471 KB) | 48 | 40 | 8 | 40, 64, **0** | 700 / 849 / 1,336 | run 1: 40 of 48, 69 of 109 attempts 429, 728 / 1,362 / 1,729 |
| Loki protobuf, snappy (586 KB) | 48 | 48 | 0 | 48, 0, **0** | 374 / 493 / 936 | run 1: 48 of 48, 326 / 526 / 736 |

1. **Partial storage after refusals: none found.** For each of the 15 traces requests refused at the
   end (all 8 attempts 429), its first trace by ID through the stage (`refused.mjs`, from inside
   Cloudflare, 13:01:56–13:02:22): **15 of 15 answered 404** (not found). S10 found 4 of 10 such traces.
   The control, the first trace of 15 accepted requests, answered **422 "query exceeded limit
   max_fetch_bytes: the data files to read are 17.7–19.2 MB"** for all 15: the query found files
   holding each of those traces and refused to read that much, so the control shows the trace was
   located, not that it was served. A finer check (counting the stored spans against the accepted
   ones, S10's `count_over_time`) was not run.
2. **The 503 rate: 0** of 323 attempts (and no 5xx of any kind). No grant was lost to an eviction in
   a way that showed.
3. **CPU per refused attempt** (tail, viz-s15-ingest's fetch events): traces refused 429 **p50 4 ms**,
   p90 6, p99 287 (n = 77 sampled; S10: p50 198 ms); **70 of the 77** under 20 ms, that is answered
   from this isolate's memory of the body or its probe, without a decode; the 7 others were decoded
   (a body's first refusal, or a retry that reached another isolate). Logs refused 429 p50 5 ms, 6 of 7
   under 20 ms. Accepted: traces p50 222 ms (S10: 204), logs 152 ms, Loki 95 ms.
4. **Durable Object requests** (analytics API, `durableObjectsInvocationsAdaptiveGroups`, window
   12:57:50–13:01:40, read 13:18): **1,389** in all: the shards 982 RPCs (appends, reserves, releases,
   and flush's and the ledger's calls) and 81 alarms, the ledgers 249 RPCs and 50 alarms, the
   publisher 17, the load clients 10. Shard rows written 2,467, read 11,814; shard CPU 2.5 s. S10
   published no per-run figure to compare with (its 17,628 cover the whole trial with queries); the
   modelled extra of D77, one `reserve` per shard per multi-batch request (review, "Cost"), is at
   most 2 × 323 = 646 requests for this load, under US$0.0001.
5. **The reserve round trip** (tail, the shard's `reserve` RPC, wall time inside the object): traces
   p50 **3 ms**, p90 74, max 190 (n = 24); logs p50 4, p90 158 (n = 17); Loki p50 7, p90 38 (n = 5).
   Acknowledgement latency of accepted requests is within S10's spread (table above); the round trip
   is not visible in it at n = 33 to 48.

**Cost** (analytics API, list prices as S10 read them, ignoring allowances; measured on Cloudflare):
the stage's life, 12:54–13:06 UTC (read 13:18): 1,647 Durable Object requests, 48.8 GB-s, 5,423 SQLite
rows written, 24,926 read, R2 224 class A and 203 class B, 366 queue operations: **US$0.0075**. Worker
invocations were read once, at 13:03 for 12:57–13:03, before the scripts were deleted (afterwards the
query by script name returns nothing): 808 invocations, 64.8 s of CPU, US$0.0015. **Total about
US$0.009**, against the stated worst case of US$2.50. No bill was read.

**Deleted** (13:03:33–13:04:44 UTC): `driver.mjs load-down` (viz-s15-load-client and its namespace;
"still listed: false"), `resources.mjs destroy --stage s15`: the seven Workers and their queue
consumers, the four queues, `viz-s15-config`, `viz-s15-lake` (208 objects), the six rate-limit ids
freed; its leftover check found nothing named `viz-s15-`. Inventory after (13:04:48) against before
(12:54:10): **no difference** in Workers, R2 buckets, KV namespaces, queues, Durable Object namespaces or
custom domains. The keys, tails and state in the scratch area were shredded afterwards; the
generated stage configs (which name the account's workers.dev subdomain) were deleted and are not in
the repository.
