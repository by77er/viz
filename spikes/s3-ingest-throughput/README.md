# Spike S3: ingest acknowledgement latency and shard throughput

How fast is a durable acknowledgement on Cloudflare, and how much can one shard take?
(`design/VERIFICATION.md` §4, S3; targets in `design/DESIGN.md` §10.)

## What was deployed, and removed

The integrated write path at commit `51bac3e` (edge, shard, ledger, flush as one script) as
`viz-dev-stack`, with an R2 bucket and a KV namespace, plus `viz-dev-loadgen`. All four were
deleted after the run on 2026-11-18. Nothing from this spike is still deployed.

`loadgen.ts` is the in-platform generator: each client is its own Durable Object sending
real Remote Write requests one after another through a service binding. `external-load.ts`
is the first attempt, run from outside Cloudflare.

Every tenant had a dedicated pool of one shard, so each row below is **one shard**. Flush
was not running (nothing triggers it yet), so a tenant could buffer 64 MB before the shard
pushed back.

## Result

Measured on Cloudflare, 2026-11-18, 10-second runs. Latency is the full request as the
client object sees it: edge authentication and decode, routing, the shard's durable write,
and the response.

| Clients | Series per request | Acknowledged per second | Samples per second | Latency, median / 90th / 99th |
|---|---|---|---|---|
| 1 | 50 | 13.6 | 680 | 60 / 70 / 382 ms |
| 16 | 50 | 229 | 11,500 | 63 / 80 / 113 ms |
| 32 | 50 | 286 | 14,300 | 67 / 219 / 340 ms |
| 64 | 50 | 209 | 10,400 | 211 / 519 / 692 ms |
| 4 | 2,000 | 25 | 50,000 | 80 / 140 / 343 ms |
| 16 | 2,000 | 67 | 133,000 | 94 / 191 / 725 ms |

- **One acknowledgement takes about 60 ms** at the median when the shard is not saturated.
- **One shard saturates at roughly 230–290 requests per second.** Past that, latency climbs
  and throughput falls (209/s at 64 clients).
- **Throughput in samples is set by batch size, not by the shard.** With 2,000-series
  requests one shard took 133,000 samples per second (about 12 MB/s uncompressed) at a
  median of 94 ms, and was not obviously at its limit.

### Overload behaviour

- At 200 clients on one shard, 3,986 requests were acknowledged and 4,571 got **503**: the
  runtime refused calls to an overloaded object and `edge` reported it as retryable.
  Nothing was acknowledged and lost, but the shard itself never said 429.
- With flush not running, tenants hit the 64 MB buffer cap and got **429** from then on, as
  designed (for example 325 acknowledged, then 1,594 refused).

### What did not work as a measurement

- **From outside Cloudflare** the test topped out at about 165 requests per second whether
  it targeted one shard or two at once, so that ceiling was the client, not the shard.
- **One Worker invocation fanning out through a service binding** stalled badly (64
  parallel requests took 15 s each). A callee shares its caller's connection budget
  (spike S1), and each ingest request makes several calls of its own.

## Against the targets

| Target | Result |
|---|---|
| Acknowledgement p50 under 80 ms | Met: 60–67 ms below saturation |
| Acknowledgement p99 under 500 ms | Met up to 32 clients (113–340 ms); missed at 64 (692 ms) |
| A shard sustains 300 acknowledgements per second | **Not met**: 230–290 |
| A shard sustains 5 MB/s | Met with large batches: about 12 MB/s for the 4 seconds the buffer cap allowed |

## Conclusions

1. Budget **200 requests per second per shard**, and split a tenant's shards before that.
2. **Senders should batch.** Request count, not data volume, is what exhausts a shard.
3. **The shard should refuse early.** It should track its own queue and answer 429 with a
   real `Retry-After` before the runtime starts returning overload errors.
4. Each append currently makes several storage calls (insert, alarm check). Group commit,
   which is not built, is the obvious next lever on both the ceiling and row-write cost.

## Not measured

Sustained load over minutes; throughput with flush running; billed rows written; more than
one shard per tenant; pooled shards with several tenants; OTLP; where the 60 ms goes.

## Re-run after early refusal and group commit (2026-11-19)

`rerun/` measures the edge Worker as built now in front of two shards, deployed as two
scripts on the same day and driven by the same load generator: `viz-spike-s3-new` (the
shard as built now: early refusal before anything is read or written, group commit) and
`viz-spike-s3-asbuilt` (the frozen shard of `dc2a1c3`, `shard/bench/asbuilt/`). The edge
code is the same in both, so the comparison isolates the shard. Each client is its own
Durable Object in `viz-spike-s3-loadgen`, calling a target through a service binding (the
original method; a single Worker fanning out measures the client). A refused client waits
for the response's `Retry-After`, capped at 1 s, as a sender would. Every run uses a fresh
tenant (its own API key) with a pool of its own, so every run starts on a fresh shard and no
run inherits another's buffer; flush is not running, as in the first run.

**Deployed for the measurement only:** Workers `viz-spike-s3-new`, `viz-spike-s3-asbuilt`
(no public route; reached only through the service bindings) and `viz-spike-s3-loadgen`
(workers.dev, every route needs the `x-key` header, a secret generated at deploy time); KV
namespace `viz-spike-s3-kv` holding the runs' API key records (SHA-256 of secrets generated
at deploy time) and pool maps. Nothing runs on a timer; the shards' alarms (age seal,
discard) stop when their data is gone.

**Worst-case cost, stated before deploying** (modelled from list prices as I know them,
training knowledge, ignoring included allowances): 34 runs of 10 s; at most about 1,500
requests a second per run = 510,000 Worker requests ≈ $0.15, as many Durable Object
requests to the shards plus the load generator's ≈ $0.15; at most 5 SQLite rows written per
append (batch row, its fingerprint index entry, stream row, segment and notification rows
at a seal) = 2.6 M rows ≈ $2.60; Durable Object duration for up to 200 clients and one
shard per run, under 10,000 GB-s ≈ $0.15; KV: 70 writes, reads cached per isolate, nil;
SQLite storage of at most 64 MB per run's shard for an hour, nil. **Under $4 in total.**

### What was created, and removed

Created 2026-11-19 01:13–01:15 UTC: KV namespace `viz-spike-s3-kv` (68 entries: one API key
record and one pool map per run), Workers `viz-spike-s3-new`, `viz-spike-s3-asbuilt` and
`viz-spike-s3-loadgen` with their Durable Object namespaces, and the load generator's `KEY`
secret. **Deleted 01:23 UTC** (`wrangler delete` for each Worker, with its namespaces;
`wrangler kv namespace delete`); the account's lists of Workers, KV namespaces and Durable
Object namespaces were read afterwards and hold nothing of this spike. The per-run API keys
existed only in a scratch file, removed with the deployment. The deploy-time configs with
the KV id were temporary; the committed `target-*.jsonc` keep the `KV_ID` placeholder.

### Result (measured on Cloudflare, 2026-11-19, 01:15:53–01:22:46 UTC)

10-second runs, 50 series (one sample each) per Remote Write request, one shard per run, the
two shards interleaved (new, as built, new, …); three runs of each. Latency is the full
request as the client object sees it (edge authentication and decode, routing, the shard's
durable write, the response), for acknowledged requests.

| Clients | Shard | Acknowledged per second, runs 1 / 2 / 3 | Median (ms) | 90th (ms) | 99th (ms) | Refused |
|---|---|---|---|---|---|---|
| 1 | as built | 27.7 / 17.3 / 30.9 | 33 / 52 / 30 | 36 / 57 / 32 | 53 / 70 / 36 | none |
| 1 | new | 24.7 / 22.8 / 23.4 | 37 / 39 / 38 | 45 / 43 / 47 | 86 / 107 / 93 | none |
| 16 | as built | 262 / 264 / 241 | 46 / 49 / 56 | 99 / 82 / 87 | 189 / 287 / 225 | none |
| 16 | new | 434 / 367 / 321 | 30 / 35 / 45 | 44 / 55 / 61 | 134 / 122 / 152 | none |
| 32 | as built | 323 / 274 / 316 | 80 / 93 / 83 | 161 / 201 / 166 | 341 / 398 / 272 | none |
| 32 | new | 622 / 562 / 753 | 41 / 46 / 34 | 63 / 79 / 50 | 144 / 199 / 137 | none |
| 64 | as built | 325 / 340 / 301 | 157 / 159 / 178 | 314 / 293 / 343 | 493 / 446 / 485 | none |
| 64 | new | **979 / 864 / 1,056** | **51 / 59 / 50** | 88 / 93 / 72 | **129 / 148 / 129** | none |
| 200 | as built | 283 / 289 / 298 | 413 / 288 / 291 | 691 / 1,003 / 820 | 931 / 1,178 / 1,019 | 440 / 459 / 595 × 503 (the runtime's overload errors, relayed) |
| 200 | new | 926 / 920 / 911 | 71 / 68 / 59 | 108 / 102 / 79 | 276 / 153 / 137 | 821 / 1,029 / 1,152 × 503 (early refusal, answered in 0–7 ms at the median); 199 / 29 / 36 × 429 |

- **The ceiling moved from about 300 to about 900–1,050 acknowledgements per second per
  shard**, with the 99th percentile under 150 ms at 64 clients where the as-built shard was
  near 500 ms. The as-built numbers reproduce the first run (230–290/s then).
- **Overload is now the shard's answer, early and cheap.** At 200 clients the new shard
  refused with `overload` before reading or writing anything, and the edge, once the
  tenant's shard had refused, refuses before decoding until the shard's `Retry-After` has
  passed: those 503s took 0–7 ms at the median (99th 72–104 ms; which of the two refused
  each one was not recorded), and the acknowledged requests kept a 99th percentile of
  137–276 ms. The as-built shard's 503s came from the runtime, and its acknowledged
  requests waited 0.9–1.2 s at the 99th.
- **The 200-client runs of the new shard filled the tenant's 64 MB buffer** (13,212
  acknowledged in each, then 429 `tenant`): flush was not running. Their rate is an
  average over a run that ended against that cap, so it understates the shard.
- **2,000-series requests** (4 and 16 clients, one run each) filled the same 64 MB buffer
  after 325 acknowledgements in every run, new and as built alike (about 57,000 samples a
  second over the run, then 429): these runs measure the buffer cap, not the shard, and do
  not compare the two.

**Against the targets** (`design/DESIGN.md` §10): a shard sustains 300 acknowledgements per
second, **met** (864–1,056 at 64 clients; n = 3); p50 under 80 ms, met at every
concurrency (59–71 ms at 200 clients); p99 under 500 ms, met at every concurrency (at most
276 ms).

**Identical results.** Not checked on Cloudflare: the load generator does not read the
shards back. The local counterfactual (`shard/bench/saturation.bench.test.ts`, measured in
workerd) requires each run to have stored exactly the batches it acknowledged, each once,
and none it refused, before any rate is compared; and `shard/test/compat.test.ts` has the
new shard adopt and serve storage written by the as-built shard. **Tuning** was done
locally (`shard/bench/results/tuning.log`: group commit alone; in-flight limits 16, 64,
256; a 2 ms group window); the deployment ran the defaults (limit 64, window 0, 16 MB of
pending bytes). Nothing was tuned on Cloudflare.

**Not measured:** where the 30–40 ms of an unloaded acknowledgement goes; billed rows
written per request (the analytics API's `durableObjectsPeriodicGroups` returned nothing for
these namespaces and this window, asked at 01:30 and 03:03 UTC, after they were deleted; S4's
namespaces, also deleted, did report);
several tenants on one pooled shard; OTLP; sustained load with flush running.
