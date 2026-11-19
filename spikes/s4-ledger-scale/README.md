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

## Not measured (first run)

Rebuild from the log; 300,000 live files (the fill stopped near 100,000); plan latency
with compacted partitions; behaviour after the fix. The re-run below measures the
rebuild and the behaviour after the fix.

## Re-run after the segment log (2026-11-19)

`rerun/` measures the ledger as built now (`contracts/LEDGER-LOG.md`: commit to SQLite,
answer, log to R2 as segments in the background) against the frozen as-built ledger of
`dc2a1c3` (`ledger/bench/asbuilt/`, one R2 object per change on the acknowledgement path),
deployed side by side in one script, driven by the same writer objects on the same day.

**Deployed for the measurement only:** Worker `viz-spike-s4-rerun` (workers.dev, every
route needs the `x-key` header, a secret generated at deploy time) with Durable Object
classes `Ledger`, `LedgerAsBuilt`, `Writer`; R2 bucket `viz-spike-s4-rerun`. Nothing runs on
a timer: the only alarms are the ledgers' drains, which stop when nothing is pending.

**Worst-case cost, stated before deploying** (modelled from list prices as I know them,
training knowledge, ignoring the plan's included allowances; rows written at $1 per
million): at most about 60,000 two-file `addUnit` calls in all runs, about 20 SQLite rows
written each (file rows, their index entries, stream, meta, outbox) = 1.2 M rows ≈ $1.20;
the 2,000-file runs, at most 10 s each and at most 300 units per run, about 6,000 rows
each, two runs = 3.6 M rows ≈ $3.60; Durable Object requests and duration for ten objects
over at most 30 minutes ≈ $0.05; R2 Class A for segments, checkpoints and the as-built
ledger's per-change objects, under 50,000 ≈ $0.25; storage of a few hundred MB for an
hour, nil. **Under $6 in total.**

### What was created, and removed

Created 2026-11-19 00:59 UTC: Worker `viz-spike-s4-rerun` (four versions as the driver
gained `/agree`, `/replay1`, a sturdier `/rebuild` and `/purge`), its three Durable Object
namespaces, and R2 bucket `viz-spike-s4-rerun`. **Deleted 01:13 UTC**: the bucket emptied
through the Worker (2,290 objects), the Worker deleted with its namespaces (`wrangler
delete`), then the bucket; the account's lists of Workers, buckets and Durable Object
namespaces were read afterwards and hold nothing of this spike.

Usage, **measured on Cloudflare** (analytics API, `durableObjectsPeriodicGroups`, window
00:59–01:14 UTC, every run of this re-run together): the ledger as built now wrote
1,102,700 SQLite rows and read 396,356 (28.5 GB-s); the as-built ledger wrote 134,225 rows
(61.7 GB-s); the writers wrote none (506.5 GB-s). About $1.10 of rows at list price, inside
the stated worst case.

### Result (measured on Cloudflare, 2026-11-19, 01:00–01:12 UTC)

Same driver, same day, the two ledgers in one script; each run a new tenant; 20-second
runs; two files per unit; `addUnit` time as the writer object sees it. Three runs of each,
interleaved (as-built, segments, as-built, …).

| Writers | Ledger | Units per second, runs 1 / 2 / 3 | `addUnit` median (ms) | 99th (ms) | Logged watermark caught up after |
|---|---|---|---|---|---|
| 1 | as built (one PUT per change, before answering) | 2.6 / 2.9 / 1.7 | 360 / 340 / 534 | 574 / 517 / 1,033 | at once (it waits) |
| 1 | segments | 20.6 / 30.1 / 65.8 | 47 / 32 / 15 | 64 / 73 / 21 | 471 / 475 / 758 ms |
| 8 | as built | 3.3 / 3.1 / 1.7 | 2,258 / 2,327 / 4,052 | 4,059 / 4,738 / 7,953 | at once |
| 8 | segments | **234 / 422 / 330** | **31 / 16 / 21** | 90 / 89 / 64 | 403 / 791 / 196 ms |

One more as-built 8-writer run lost its HTTP connection after about a second and returned
nothing; it was run again (the third row above). With 2,000 files per unit, one writer,
10 s, one run each: as built 1.3 units/s at a median of 694 ms; segments 7.5 units/s at
127 ms, logged 9.1 s after the last unit (each change is about 1.4 MB, so a 4 MiB segment
holds two or three and the drain is the bottleneck there). A segment PUT took 180–494 ms
(last of each run) and at most 1,025 ms.

**Against the targets** (`contracts/LEDGER-LOG.md`): at least 50 units per second with eight
writers, **met** (234–422, against 1.7–3.3 for the as-built ledger the same day; n = 3
each). `addUnit` under 20 ms at the median, **met in one run of three** (16 ms; the others
21 and 31 ms). One writer is bound by its own round trip to the ledger (15–47 ms), so its
rate varies with where the two objects land.

**Precondition, checked on Cloudflare (`/agree`).** One writer, 40 units, on each ledger:
the same live set (keys with the tenant normalised), watermarks and version in both tables.
Then the ledger as built now, on empty storage under the as-built tenant's name, rebuilt
from the as-built ledger's first-layout log and listed exactly what the as-built ledger
lists (files with precedence, watermarks, version), in a new ledger incarnation (2).

**Rebuild after storage loss** (`/fill`, `/rebuild`; the review's experiment, R-3):

| Log | Changes | Time to the first plan after `deleteAll` | Refused meanwhile (retryable) | Same state |
|---|---|---|---|---|
| 104 segments, no checkpoint | 5,008 (5,000 units, 8 streams) | 5.4 s | 1 | yes |
| one base segment (the previous rebuild's) | 5,000 files | 2.8 s, 3.5 s | 0, 1 | yes |
| first layout, one object per change (written by the as-built ledger in 150 s) | 608 | **28.7 s** | 14 | yes |

The last row is the ledger as built now replaying an as-built log; the as-built ledger's own
rebuild does the same reads (one GET per change, six at a time) inside
`blockConcurrencyWhile`, where about 30 s resets the object: 608 changes already take
29 s, about 47 ms a change, against about 1 ms a change from segments. The review's model
(1,800–3,600 changes in 30 s) was optimistic by a factor of three to six. Requests during
a rebuild now wait at most 2 s and are refused with `ledger_unavailable` (retryable)
instead of being held.

**Tuning.** None on either side: the as-built ledger has nothing to tune (each change
waits for its PUT), and the segment ledger ran with its defaults (drain 200 ms after the
first unlogged commit, segments up to 4 MiB, a checkpoint every 256 segments). Two driver
faults were fixed during the run and are not results: `wipe` must `sync()` before
`ctx.abort()` (an abort discarded the unconfirmed `deleteAll`, so the first "rebuild"
measured an object that had not lost anything), and `/rebuild` must make a new stub after
the reset.

**Not measured here:** a rebuild that starts from a checkpoint on Cloudflare (no ledger
reached 256 segments; checkpoints are tested in `ledger/test/segments.test.ts`); plan
latency at 300,000 files; a drain under R2 errors.
