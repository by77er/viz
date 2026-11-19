# Spike S11: a ledger state above 16 MiB on Cloudflare

Production keeps the ledger's state at 16 MiB (`LEDGER_STATE_MAX_BYTES` in
`stack/wrangler.jsonc`, `STATE_MAX_BYTES` in `ledger/src/ledger.ts`), although the code reaches
300 MiB in local workerd (D47, D55). The review of D47/D48/D55 (P-3) keeps that cap until "a
rebuild and a first publication above 16 MiB have been timed on Cloudflare against the CPU
limit". This spike times both, on Cloudflare, at 16, 64 and 150 MiB.

## Result in brief (measured on Cloudflare, 2026-11-19, 14:10–14:25 UTC)

Measured at 16, 64 and 150 MiB of state (the ledger's estimate; 15,936, 63,712 and 149,152
files). **300 MiB was not measured**: by the rows-written rule stated before deploying (below),
the 300 MiB step would have taken the spike to about $9 at list price, so the run stopped at
150 MiB and everything above it is extrapolated, and says so.

| State | Rebuild after a storage loss: ready after (wall) | Rebuild CPU | A publisher's first publication: wall | Its CPU |
|---|---|---|---|---|
| 16 MiB | 4.1 s | 1.2 s | 5.4 s | 2.1 s |
| 64 MiB | 27.6 s | 14.2 s | 11.6 s | 5.6 s |
| 150 MiB | 34.7 s (33.0 s with no caller) | pending (analytics not yet in) | 23.6 s | 14.0 s |
| 300 MiB (extrapolated) | | see below | about 45 s | 28–32 s |

CPU is from Cloudflare's analytics API (`durableObjectsPeriodicGroups.cpuTime`, the object's
whole CPU in the window; for the publisher it equals its one RPC invocation's CPU in
`durableObjectsInvocationsAdaptiveGroups`). The default limit is 30 s of CPU per invocation;
neither the ledger's Worker nor the publisher's sets `limits.cpu_ms` (`stack/wrangler.jsonc`,
`publisher/wrangler.jsonc`), and Cloudflare allows up to 300,000 ms (developers.cloudflare.com,
Durable Objects limits, read 2026-11-19).

Every measurement completed; no `exceededCpu` or `exceededMemory` error was recorded; the
rebuilt state equalled the original every time. Memory stayed under 50 MB everywhere
(`memoryUsageBytes`, the periodic maximum).

**Status (14:36 UTC):** every measurement is done and everything is deleted; the CPU of the two 150 MiB rebuilds has not reached the analytics API yet. The recommendation follows once it has.

## What was deployed, and removed

Code: `b237b6b` (ledger, publisher, contracts unchanged; `worker.ts` here wraps them). Worker
`viz-s11-ledger` (workers.dev, every route behind a secret header), version
`0a8747a9` at 14:10 UTC and `cbc48b80` at 14:22 UTC (two more replica classes, `LedgerR150` and
`LedgerR150B`, migration `v2`, deployed while G0 was quiet); R2 bucket `viz-s11-lake`, created
14:10 UTC. Both deleted at 14:32 UTC (Cleanup, below).

## Building the state (measured on Cloudflare, 2026-11-19, 14:10–14:22 UTC)

One tenant, G0, filled by `addUnit` with two-file units (a samples and a series file of one day,
S4's shapes, 1,055 bytes of estimated state per file), no other traffic:

| Fill | Units (files) | Writers | Wall | Units/s | `addUnit` per batch: p50 / p99 / max | Segments written | Segment PUT mean / max |
|---|---|---|---|---|---|---|---|
| 0 → 16 MiB | 7,968 (15,936) | 8 | 73.7 s | 108 | 57–69 / ≤ 264 / 3,226 ms | 191 (15.3 MB) | 272 / 496 ms |
| 16 → 64 MiB | 23,888 (47,776) | 16 | 131.8 s | 181 | 61–85 / ≤ 534 / 1,852 ms | 328 (45.9 MB) | 295 / 1,479 ms |
| 64 → 150 MiB | 42,720 (85,440) | 16 | 238.9 s | 179 | 69–83 / ≤ 719 / 3,972 ms | 582 (82.6 MB) | 310 / 4,467 ms |

At 150 MiB (157,302,228 bytes estimated, 149,152 files, version 74,592) the log was 1,101
segments, 143.8 MB: 964 bytes of log per file with two-file units (870 with S4's 2,000-file
units). One R2 PUT of a segment failed with 10043 (service unavailable) during the 64 MiB fill;
the drain's backoff retried it and nothing was lost (`logStatus().lastError` kept the message).

**Checkpoints in parts.** Every checkpoint G0 wrote, with the fill running:

| Version | State when begun | Format | Parts (bytes) | Part PUT median / max | Begun → manifest written |
|---|---|---|---|---|---|
| (first) | < 1 MiB | 1, one object | – | – | 0.3 s |
| 773 | 1.7 MB | 2 | 2 (1.4 MB) | 351 / 369 ms | 0.7 s |
| 1,540 | 3.3 MB | 2 | 3 (2.9 MB) | 346 / 404 ms | 2.1 s |
| 3,166 | 6.7 MB | 2 | 6 (5.9 MB) | 394 / 492 ms | 2.4 s |
| 6,265 | 13.2 MB | 2 | 12 (11.8 MB) | 299 / 448 ms | 11.7 s |
| 13,605 | 29.0 MB | 2 | 25 (25.6 MB) | 330 / 480 ms | 38.6 s |
| 33,999 | 72.1 MB | 2 | 62 (64.2 MB) | 368 / 729 ms | 70.2 s |

R2 calls per format-2 checkpoint: one PUT per part and one for the manifest, then one list and
two (batched) deletes of the superseded checkpoint, as `ledger/README.md` says. Under a
continuous fill a checkpoint advanced about one part per second (eight parts per alarm,
interleaved with the segments), so a checkpoint's duration grew with the state: 70 s at 72 MB,
which puts a 300 MiB checkpoint near five minutes (modelled from these rates). While the 62-part
checkpoint ran, `addUnit`'s p99 rose from about 230–290 ms to 719 ms (that batch's maximum 3,972
ms); nothing was refused. With the byte rule, checkpoints came at roughly doubling states, so a
rebuild read a checkpoint and a log since it of comparable size: at 150 MiB, a 64 MB checkpoint
(72 MB of state at version 33,999) and 40,593 changes (about 81,000 files) of segments after it.

## A publisher's first publication (measured on Cloudflare, 2026-11-19, 14:12–14:24 UTC)

A publisher on empty storage, no Iceberg metadata in R2, `publish(['s11big'])` by RPC: the
tenant's newest incarnation is the replica's, so the publication re-bases from its **base**
(the whole state in one object, streamed and parsed element by element, files into `stage`),
computes every file's statistics, writes the manifests and commits both metric tables. CPU is
the RPC invocation's (`durableObjectsInvocationsAdaptiveGroups`) and equals the object's total
in `durableObjectsPeriodicGroups` for that minute, to the millisecond; nothing else called the
object meanwhile.

| State | Files | Wall (caller) | **CPU (analytics)** | Rows written | Manifests (both tables) | Iceberg bytes |
|---|---|---|---|---|---|---|
| 16 MiB | 15,936 | 5.4 s | **2.1 s** | 143,473 | 2 | 0.24 MB |
| 64 MiB | 63,712 | 11.6 s | **5.6 s** | 573,469 | 8 | 0.88 MB |
| 150 MiB | 149,152 | 23.6 s | **14.0 s** | 1,342,445 | 16 | 1.94 MB |

About 0.07 ms of CPU per file from 16 to 64 MiB and 0.10 ms from 64 to 150 MiB: slightly more
than linear. 9.0 rows written per file. Memory at most 47 MB (`memoryUsageBytes`, periodic
maximum) at 150 MiB.

## A rebuild from R2 (measured on Cloudflare, 2026-11-19, 14:12–14:25 UTC)

G0 quiet (nothing pending, no checkpoint running); then one object of the same tenant on empty
storage, in its own namespace, receives a request. It reads the newest checkpoint's parts, then
every segment after it, and writes the new incarnation's base to R2 before it commits and
serves. "Ready" is the caller's time from the first request to the first plan answered.
Afterwards its state was compared with G0's: version, every stream's watermark, the state
estimate and the full file lists of two days of both tables (SHA-256), all equal in every run.

## Cleanup

- 14:31:42 UTC: every object of `viz-s11-lake` deleted through the Worker (`driver.mjs purge`:
  1,205 objects, 210 MB: the G0 log, its last checkpoint, the last Iceberg tables, the job
  results); a listing afterwards returned none.
- 14:32:01 UTC: `wrangler delete viz-s11-ledger`: the Worker and its ten Durable Object
  namespaces with their storage (G0's 150 MiB state, the replicas', the publishers').
- 14:32:12 UTC: `wrangler r2 bucket delete viz-s11-lake`.
- 14:32:15 UTC: inventory after (`inventory.mjs`, Workers, R2 buckets, KV namespaces, queues,
  Durable Object namespaces, custom domains), compared with the one taken at 13:54 before
  deploying: **nothing removed, and no name containing `s11` in either.** The only additions
  are S10's (`viz-s10-gateway`, `-load-client`, `-mcp`, `-query`, `-ruler` and their namespaces),
  deployed by that spike meanwhile; nothing of S10's was touched.
- The detached worktree was removed (`git worktree remove`) and the deploy key deleted.


## Plan (written before deploying)

**Code.** The ledger and the publisher exactly as committed at `b237b6b` (branch
`claude/cloudflare-observability-platform-ibaqya`, 2026-11-19 13:49 UTC), built from a detached
worktree of that commit. The publisher at that commit does **not** have resumable re-bases: a
re-base or first publication runs in one invocation, and nothing of it survives a reset.

**What runs.** `worker.ts`, one Worker:

- `Ledger` (G0): the ledger as built, its R2 calls timed (a wrapper around the binding, outside
  the ledger's code). Eight `Writer` objects, each its own stream, admit realistic flush units
  with `addUnit` (two files per unit, a samples and a series file of one day, S4's key and index
  fragment shapes: about 1,070 bytes of estimated state per file, so 300 MiB is about 294,000
  files), as `spikes/s4-ledger-scale` did. `LEDGER_STATE_MAX_BYTES` = 300 MiB, the ledger's
  measured limit. `LEDGER_CHECKPOINT_EVERY` = 8: with the production default (256) a fast fill
  writes few, large segments and the segment count would decide when checkpoints happen; at
  production's write rates (a segment every ~0.2 s of a few units) 256 segments are under 2 MiB
  of log, so the byte rule decides (a checkpoint once the log since the last one is as large as
  it). 8 makes the byte rule decide here too.
- `LedgerR16`, `LedgerR64`, `LedgerR300`, `LedgerR300B`: the same class under other names. Each
  is one object of the same tenant with **empty storage**: a ledger whose storage was lost. Its
  first request starts the rebuild from R2 (newest checkpoint, then the segments after it, then
  the new incarnation's base written to R2), exactly the path a storage loss takes. Used instead
  of `deleteAll` (S4's way) because deletes are billed as rows written. After each measurement
  the replica's new incarnation is deleted from R2, so G0's incarnation is again the newest and
  the fill goes on.
- `Publisher`: the publisher as built. `cellOf` (its test seam) maps `cell-0~p16` etc. to
  `cell-0`, so each measurement is a publisher on empty storage, and the cell's `iceberg/`
  prefix is emptied before it: a **first publication**. It reads the newest incarnation, the
  replica's base (the whole state in one object, parsed element by element: the publisher's
  heavier start; from checkpoint parts it is faster in local workerd, D55). Driven by RPC
  (`publish([tenant])`), the same code the alarm runs; its own alarm is disabled so that a
  failed publication is never retried by itself.
- `Driver`: runs one job at a time from its alarm and writes the result to R2; `driver.mjs`
  starts jobs from outside and waits for results.

**Steps.** (1) Fill to 16 MiB, wait until G0 has nothing pending and no checkpoint in progress,
rebuild in `LedgerR16` with a plan and an `addUnit` sent every second meanwhile (what queries and
flushes meet), first publication from its base. (2) The same at 64 MiB. (3) Analytics read:
rows written and CPU per file of each activity, measured. (4) The largest size the cost rule
below allows, at most 300 MiB (the fill stops at `full`), the same three measurements; the fill
passes through every size below it and each checkpoint G0 writes is recorded (parts, time, PUTs).
(5) If the rebuild at the top size uses more than about half of 30 s of CPU: rebuild again in
`LedgerR300B` with **no** request after the one that starts it (a Durable Object's CPU budget is
reset by every incoming request, so this shows whether the rebuild fits the budget of one).
(6) If a measurement does not complete within the default limit, a second deployment with
`limits.cpu_ms` raised, to see how much it needs (new class names, same code).

**CPU** comes from the analytics API (`durableObjectsPeriodicGroups.cpuTime` per object and
minute; `durableObjectsInvocationsAdaptiveGroups` CPU quantiles per invocation), never from
timers inside an object (a Durable Object's clock advances only on I/O). Wall times are taken by
the caller.

**Resource names** (all created by this spike, all deleted at the end):

| Resource | Name |
|---|---|
| Worker (workers.dev, every route needs the `x-key` header, a secret generated at deploy and set with `wrangler secret put` from stdin) | `viz-s11-ledger` |
| Durable Object namespaces | `viz-s11-ledger`: `Ledger`, `LedgerR16`, `LedgerR64`, `LedgerR300`, `LedgerR300B`, `Publisher`, `Writer`, `Driver` |
| R2 bucket | `viz-s11-lake` |

Nothing else in the account is touched; an inventory of Workers, buckets, KV namespaces, queues,
Durable Object namespaces and custom domains is taken before and after (`inventory.mjs`).
**Timers stop by themselves:** every alarm of the Worker does nothing after `S11_DEADLINE`
(2026-11-19 20:00 UTC), and no job starts after it; the ledgers' drains stop when nothing is
pending; the publisher's alarm never publishes.

### Worst-case cost, stated before deploying

List prices of Workers Paid (developers.cloudflare.com, pricing pages read 2026-11-19), **ignoring
the plan's included allowances**. Row counts are modelled from the code (every index entry
counted as a row written, D1's rule, which Durable Object SQLite billing follows; deletes are
billed as writes):

| Item | Modelled | At list price |
|---|---|---|
| SQLite rows written: the fill to 300 MiB (about 147,000 two-file units, 4 rows per file plus about 5 per unit) and checkpoint pre-images (at most 4 per file admitted while a checkpoint runs) | ≤ 2.3 M | ≤ $2.30 |
| Rows written: rebuilds at 16, 64 and 300 MiB (about 4.5 per file) | ≤ 1.7 M (+1.3 M for step 5) | ≤ $3.00 |
| Rows written: first publications at 16, 64 and 300 MiB (about 11 per file: `stage` in and out, statistics, `live`) | ≤ 4.1 M | ≤ $4.10 |
| R2 Class A (segments ~1,000; checkpoint parts ≤ 600; four bases; Iceberg writes; lists) | ≤ 5,000 | ≤ $0.03 |
| R2 Class B (rebuild and publisher reads) | ≤ 10,000 | < $0.01 |
| R2 storage (log ~260 MB, checkpoints, bases up to ~250 MB each, Iceberg; under 1.5 GB for under 6 hours) | | < $0.01 |
| Durable Object requests (`addUnit` ~150,000, status and probes) | ≤ 0.4 M | ≤ $0.06 |
| Durable Object duration (ledger, writers, replicas, publishers, driver; under 6 hours) | ≤ 10,000 GB-s | ≤ $0.13 |
| SQLite storage (under 2.5 GB for under 6 hours) | | < $0.01 |
| Workers requests and CPU (driver calls) | < 1,000 | < $0.01 |
| **Total if everything above ran** | | **≤ $9.70** |

That is more than a few dollars, so the plan scales itself down: **the run stops adding
measurements once the analytics show, or the measured rates project, more than $6 at list price
in all**. Steps 1–3 cost about $1.60 by this model; step 3 measures the real rows per file, and
step 4's size is then the largest that keeps the total under $6 (300 MiB if the model is
pessimistic, otherwise less, and the rest extrapolated, said so). Rows written dominate, and
they fall inside the plan's included allowance: the account had used 3.0 M of its 50 M included
row writes and 53,489 of its 400,000 included GB-s in November when this was written (**measured
on Cloudflare**, `durableObjectsPeriodicGroups`, 2026-11-01 to 2026-11-19), so the bill this
spike actually adds should be cents (R2 operations and requests above their allowances, if any).
