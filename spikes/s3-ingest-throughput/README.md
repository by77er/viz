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
