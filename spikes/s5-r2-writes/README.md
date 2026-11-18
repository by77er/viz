# Spike S5: R2 write latency and parallel write throughput

Spike S4 found an R2 write taking about 0.4 s and a ledger limited to one change per
second because it waited on one write per change. Flush, compaction, the publisher and the
deleter all write to R2, so this measures what writes cost and how they scale.

## What was deployed, and removed

Worker `viz-spike-s5-r2-writes` with a `Writer` Durable Object class and bucket
`viz-spike-s5` (`src/index.ts`). Everything was deleted after the run on 2026-11-18.

## Result (measured on Cloudflare, 2026-11-18 about 22:15 UTC, colo IAD, 20 writes per sequential row)

### One write at a time

| From | Size | Median | 90th | 99th / max |
|---|---|---|---|---|
| Worker | 100 B | 251 ms | 334 | 383 |
| Worker | 1.5 KB | 221 ms | 268 | 278 |
| Worker | 64 KB | 240 ms | 287 | 306 |
| Worker | 1 MB | 260 ms | 297 | 399 |
| Worker | 8 MB | 563 ms | 819 | 1,028 |
| Durable Object | 1.5 KB | 172 ms | 212 | 221 |
| Durable Object | 1 MB | 213 ms | 301 | 314 |
| Worker, conditional (`If-None-Match: *`) | 1.5 KB | 163 ms | 205 | 333 |

A write costs **about 0.17–0.26 s whatever its size up to 1 MB**, against about 0.05 s for a
read (S1). S4 measured 0.37 s an hour earlier; write latency varies by a factor of about
two. A conditional write costs no more than a plain one.

### Many writes at once

| How | Writes | Wall time | Writes per second | Each write, median / max |
|---|---|---|---|---|
| One Worker invocation, 6 at once | 6 | 186 ms | 32 | 151 / 186 ms |
| One Worker invocation, 12 at once | 12 | 602 ms | 20 | 494 / 602 ms |
| One Worker invocation, 48 at once | 48 | 1,592 ms | 30 | 911 / 1,592 ms |
| 1 Durable Object × 6 | 6 | 377 ms | 16 | 187 / 236 ms |
| 8 Durable Objects × 6 | 48 | 525 ms | 91 | 169 / 316 ms |
| 32 Durable Objects × 6 | 192 | 848 ms | 226 | 239 / 466 ms |
| 32 Durable Objects × 6, 1 MB each | 192 (192 MB) | 1,004 ms | 191 | 331 / 594 ms |

Writes obey the same six-in-flight limit as reads: past six, a single invocation queues
them. Spread across Durable Objects, throughput scales: 32 objects wrote 192 objects in
under a second, and 192 MB in about one second.

### Deleting

One `delete()` call with 1,000 keys took 5.5 s.

## Conclusions

1. **Budget 0.25 s per write, up to 0.6 s at the tail**, and 0.6 s for an 8 MB object.
2. **Never wait on a write per item.** The ledger fix planned in `contracts/LEDGER-LOG.md`
   (batched segments in the background) stands: at 0.25 s per write a ledger writing one
   object per change tops out near four changes per second.
3. **Parallel writes need Durable Objects**, as reads do: six at a time per request.
   Compaction that writes many outputs should spread them over objects or accept six at a
   time.
4. **Batch deletes are slow but bulk**: about 5 ms per key in batches of 1,000. Physical
   deletion belongs in the background.
