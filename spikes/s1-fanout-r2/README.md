# Spike S1: fan-out limits and R2 range-read latency

Decides the query fan-out topology (`design/VERIFICATION.md` §4, S1; `design/DESIGN.md` §6.2).

## What is deployed

- Worker `viz-spike-s1-fanout-r2` (workers.dev), bound to itself through a service binding
  and to one SQLite Durable Object class, `Waiter`.
- R2 bucket `viz-spike-s1` holding one 32 MiB object of random bytes.
- Endpoints need the `x-key` header (a Worker secret, not in the repository). Nothing runs
  on a timer; idle, it costs only the stored 32 MiB.

Remove with:

```
npx wrangler delete --name viz-spike-s1-fanout-r2
npx wrangler r2 object delete viz-spike-s1/blob-32m && npx wrangler r2 bucket delete viz-spike-s1
```

## Result

Measured on Cloudflare on 2026-11-18, Worker running in colo IAD, one session, a few runs
per case. Times are wall-clock milliseconds as seen inside the Worker.

### 1. Waiting on many callees is not limited

| Callee | Parallel calls, each waiting 300 ms | Wall time |
|---|---|---|
| This Worker through a service binding | 1, 6, 7, 12, 24, 48, 96 | 300 ms in every case |
| The same, callee sends headers first | 6, 12, 48, 96 | 300 ms |
| 96 different Durable Objects (already created) | 12 / 48 / 96 | 368 / 557 / 585 ms |
| 96 different Durable Objects (first use) | 48 / 96 | about 1,300 ms |

### 2. R2 reads share one small connection budget across a service-binding tree

64 KB range reads. A single read takes about 46 ms.

| How 96 reads were issued | Wall time | Read time, median / 99th |
|---|---|---|
| 96 reads from one invocation | 958 ms | 530 / 958 ms |
| 96 service-binding leaves, 1 read each | 727–753 ms | 375–416 / 727–750 ms |
| 48 leaves × 2 reads | 744–794 ms | |
| 16 leaves × 6 reads | 855–913 ms | |
| **96 Durable Object leaves, 1 read each** | **312 ms** (594 first use) | **48 / 114 ms** |
| **16 Durable Object leaves × 6 reads** | **203 ms** (482 first use) | 68 / 139 ms |
| **32 Durable Object leaves × 6 reads (192 reads)** | **173 ms** (403 first use) | 48 / 97 ms |

96 reads at about 45 ms each, six at a time, is 16 rounds or about 720 ms, which is what the
first four rows show. So the six-connection limit applies to R2 binding reads, and a callee
reached through a service binding spends from its caller's budget. A Durable Object has its
own. A leaf that is a separate public request to the same Worker is not possible: all such
fetches failed.

### 3. R2 range-read latency (150 sequential reads at random offsets)

| Range | Time to first byte, median / 90th / 99th | Whole read, median / 90th / 99th |
|---|---|---|
| 4 KB | 39 / 48 / 81 ms | 40 / 48 / 83 ms |
| 64 KB | 46 / 58 / 94 ms | 48 / 64 / 97 ms |
| 1 MB | 42 / 54 / 84 ms | 52 / 81 / 148 ms |
| 8 MB | 61 / 97 / 148 ms | 138 / 213 / 257 ms |

Hedging a 64 KB read after 60 ms (10% of reads hedged) moved the 99th percentile from 97 to
86 ms and made the 90th worse (64 to 73 ms). Not worth it at this latency.

## Conclusions

1. **Leaves that read R2 must be Durable Objects**, not service-bound Workers. With a pool
   of warm leaf objects, 192 range reads finished in under 200 ms; through service bindings
   the same work is capped near 130 reads per second for the whole query.
2. **Read size barely matters below 1 MB.** The cost of a read is the round trip, about
   45 ms. Plan for few, coalesced reads; reading a whole 1 MB column chunk costs about the
   same as reading 4 KB of it.
3. **Keep leaves warm.** First use of a Durable Object cost roughly 250–700 ms extra.
4. **Hedging is not needed** at these latencies.

## Not measured

- A callee that is a *different* Worker script through a service binding (expected to share
  the budget too; not tested).
- Any colo other than IAD, the bucket's location relative to it, cross-region reads, and
  variation over a day.
- Contention when many queries share the same warm leaf objects.
- CPU time; these are I/O timings only.
