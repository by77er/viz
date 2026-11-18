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
