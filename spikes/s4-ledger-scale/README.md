# Spike S4: the tenant ledger at scale

How fast does a ledger admit flush units, and how long does a plan take when it lists many
files? (`design/VERIFICATION.md` §4, S4.) The answer found a real defect.

## What was deployed, and removed

The ledger at commit `51bac3e` with a driver (`driver.ts`): writer clients, each its own
Durable Object and its own stream, calling `addUnit` on one tenant's ledger; an R2 bucket
for the ledger's change log. Worker and bucket were deleted after the run on 2026-11-18.

## Result (measured on Cloudflare, 2026-11-18)

### Admitting units: about one per second

| Writers | Files per unit | Units per second | `addUnit` time, median |
|---|---|---|---|
| 1 | 2 | 1.1 | 715 ms |
| 8 | 2 | 0.8 in total | 4,480 ms |
| 1 | 2,000 | 1.0 | 916 ms |
| 1 (ledger holding about 100,000 files) | 2 | 0.7 | 1,513 ms |

**The ledger admits roughly one flush unit per second, however many writers there are.**
The cause is in the code: `addUnit` commits to SQLite and then waits for the change to be
written to R2 before answering, one R2 object per change, strictly in order. An R2 write
measured here takes far longer than a read:

| R2 PUT of | Median | 90th | Max |
|---|---|---|---|
| 1.5 KB | 371 ms | 797 ms | 1,250 ms |
| 1.8 MB | 438 ms | 974 ms | 1,467 ms |

(A range read is about 46 ms; spike S1.) So write latency is nearly independent of size,
and one PUT per change caps the ledger at one or two changes per second.

**This is a defect, not a tuning matter.** The design needs about 17 units per second per
large tenant (1,000 a minute), and even a small tenant with ten shards sealing every ten
seconds reaches one per second.

### Planning

| Range | Files returned | Response size | `plan` time, median / 90th |
|---|---|---|---|
| 1 day | 7,001 | 5.8 MB | 276 / 832 ms |
| 2 days | 8,001 | 6.6 MB | 219 / 342 ms |
| 3 days | 16,001 | 13.2 MB | 369 / 734 ms |

About 0.8 KB and 25–40 µs per file returned, because each entry carries its index
fragment inline. A compacted tenant-day (tens of files) would plan in a few milliseconds;
an uncompacted or very large one does not, and a week of 5,000-file days would exceed the
32 MB limit on a single call.

## What has to change

1. **Batch the change log and take it off the acknowledgement path.** `addUnit` should
   answer once the SQLite transaction commits (that is already durable). A background drain
   then writes every pending change as **one** R2 object per cycle (a segment covering
   versions a to b). Shards already discard only up to the *logged* watermark, so safety is
   unchanged; discard just lags by one drain cycle. This changes the log's key format, so
   the publisher and the rebuild path change with it.
2. **Keep index fragments out of large plans.** Return them inline only below a size
   threshold; otherwise return a reference to the partition's consolidated index object,
   which compaction writes.
3. **Page `plan`**, or bound it by partitions, so no single call can approach the message
   limit.

## Also learned

- **R2 writes cost about 0.4 s each.** Anything that waits on a PUT per item (flush, the
  publisher's commit, compaction) should batch or run PUTs in parallel, and must never sit
  on a request's acknowledgement path.

## Not measured

Rebuild from the log; 300,000 live files (the fill stopped near 100,000); plan latency
with compacted partitions; behaviour after the fix.
