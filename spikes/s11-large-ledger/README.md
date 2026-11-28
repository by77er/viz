# Spike S11: a ledger state above 16 MiB on Cloudflare

Production keeps the ledger's state at 16 MiB (`LEDGER_STATE_MAX_BYTES` in
`stack/wrangler.jsonc`, `STATE_MAX_BYTES` in `ledger/src/ledger.ts`), although the code reaches
300 MiB in local workerd (D47, D55). The review of D47/D48/D55 (P-3) keeps that cap until "a
rebuild and a first publication above 16 MiB have been timed on Cloudflare against the CPU
limit". This spike timed both on Cloudflare, at 16, 64 and 150 MiB, with the ledger and the
publisher as committed at `b237b6b`. Everything it created is deleted.

## Result in brief (measured on Cloudflare, 2026-11-19, 14:10–14:25 UTC)

| State (files) | Rebuild after a storage loss: callers refused for (wall) | Rebuild CPU | A publisher's first publication: wall | Its CPU |
|---|---|---|---|---|
| 16 MiB (15,936) | 4.1 s | 1.2 s | 5.4 s | 2.1 s |
| 64 MiB (63,712) | 27.6 s | 14.2 s | 11.6 s | 5.6 s |
| 150 MiB (149,152) | 34.7 s; 33.0 s with no caller | 18.6 s; 16.4 s with no caller | 23.6 s | 14.0 s |
| 300 MiB (about 294,000): **extrapolated, not measured** | about 70 s | 32–37 s (65 s at the 64 MiB run's rate) | about 45 s | 28–32 s |

- CPU is from Cloudflare's analytics API (`durableObjectsPeriodicGroups.cpuTime`: the object's
  whole CPU; each measurement had a namespace or object of its own). The default limit is 30 s
  per invocation; neither the ledger's Worker nor the publisher's sets `limits.cpu_ms`
  (`stack/wrangler.jsonc`, `publisher/wrangler.jsonc`); Cloudflare allows up to 300,000 ms
  (Durable Objects limits page, read 2026-11-19).
- **Every measurement completed within the default limit**, the no-caller rebuild at 150 MiB
  included (16.4 s of CPU after its one request). No `exceededCpu` or `exceededMemory` error.
  Every rebuilt state equalled the original. Memory at most 51 MB (`memoryUsageBytes`).
- **300 MiB was not measured**: by the cost rule written before deploying (below), the 300 MiB
  step would have taken the spike over $6 at list price, so the run stopped at 150 MiB.

## What it means for the 16 MiB cap

**Recommendation: lift production's cap to 64 MiB (`LEDGER_STATE_MAX_BYTES` = 67108864), not
further yet, and not to 300 MiB with the code and limits measured here.** At 64 MiB the slowest
rebuild measured used 14.2 s of CPU and the first publication 5.6 s, both under half the 30 s
default, and the rebuild stays under 30 s there even with the worst log mix and no caller: 24 s
modelled from the slowest run (the log since the checkpoint at the byte rule's maximum, about
31,000 changes against the 18,267 measured, and all of the measured CPU scaled with the
changes). The review's P-2 condition still holds: the release that lifts it must have a rollback
floor with D47 and D55, and its record must say what a rollback below it does to a tenant above
16 MiB.

Why not more:

1. **150 MiB fits as measured, without margin.** The rebuilds used 16.4–18.6 s and the
   publication 14.0 s. But the same work varies a lot between runs here: the 64 MiB rebuild cost
   0.22 ms of CPU per file of state, the 150 MiB ones 0.11–0.13 ms (the 64 MiB run's base upload
   was slower too: 66 MB in 11.1 s, against 156 MB in 6.8–7.8 s). At the 64 MiB run's rate a
   150 MiB rebuild is about 33 s. And the log since the checkpoint was about 0.6 of what the byte rule allows
   (40,593 changes against about 72,000 at most at 150 MiB, for two-file units): scaled to the
   most, the 150 MiB rebuild is about 33 s at the rates measured. Modelled, both; not measured.
2. **300 MiB does not fit the default limit.** The publication extrapolates to 28–32 s (the
   cost per file rose from 0.07 ms between 16 and 64 MiB to 0.10 ms between 64 and 150 MiB) and
   the rebuild to 32–37 s at the faster rate measured, 65 s at the slower.
3. **The rebuild is the bound, and callers change it.** Cloudflare resets a Durable Object's CPU
   budget at every incoming request (limits page: "If you consume more than 30 seconds of
   compute between incoming network requests, there is a heightened chance that the individual
   Durable Object is evicted and reset"). During a rebuild every flush and query of the tenant
   is such a request, refused after about 2 s; the analytics show the 64 MiB rebuild's CPU
   charged across those requests' invocations, the largest 3.9 s. So a rebuild that callers keep
   calling may well finish above 30 s; one with nobody calling has 30 s. Above 30 s it is a risk
   the platform does not promise to take, and a rebuild that is reset starts again from nothing
   (`ledger/README.md`, "Not implemented").
4. **What callers see is the wall time**, whatever the CPU: every request to the tenant is
   refused (`ledger_unavailable`, retryable) until the new base is in R2: 4 s at 16 MiB, 28 s at
   64 MiB, 35 s at 150 MiB, measured. Flushes retry and shards keep their rows, so nothing is
   lost; the tenant's ingest and queries wait that long after a ledger storage loss.

What would let it rise further, measured as this spike did (its `rebuild` and `publish` jobs):

- **Replay the log in batched transactions.** The rebuild applies each logged change in its own
  SQLite transaction (`applyLogged`); the checkpoint and base loaders already batch rows (a part,
  or 256 rows of a base, per transaction), which locally cut a 32,000-file load from 15.6 s to
  2.4 s (`ledger/README.md`).
  The rebuilds put an upper bound of 0.4–0.8 ms of CPU on each change replayed (a rebuild's
  whole CPU divided by its changes), and a rebuild replays tens of thousands. Not measured with
  the change.
- **`limits.cpu_ms`** on `viz-ingest` and `viz-publisher` (for example 120,000). Durable Objects
  are billed by wall time, not CPU (pricing page, read 2026-11-19), so a higher limit costs
  nothing unless used. It also raises the cap of those Workers' stateless handlers, which are
  billed by CPU: a denial-of-wallet trade to weigh.
- **Resumable re-bases** in the publisher (the change being made now; `b237b6b` does not have
  it): removes the publisher's bound; then re-measure a first publication at 300 MiB.

## Runs, and where they departed from the plan

All on 2026-11-19 (UTC), one job at a time:

| Time | Job |
|---|---|
| 14:10 | deployed (`0a8747a9`); bucket created at 14:10:15 |
| 14:10:56–14:12:11 | fill to 16 MiB (8 writers) |
| 14:12:35 / 14:12:50 | rebuild in `LedgerR16` (probes every second); first publication `cell-0~p16` |
| 14:13:17–14:15:31 | fill to 64 MiB (16 writers from here: 8 managed about 108 units/s) |
| 14:16:02 / 14:16:45 | rebuild in `LedgerR64`; first publication `cell-0~p64` |
| 14:18:06–14:22:09 | fill to 150 MiB |
| 14:22:27 | redeployed (`cbc48b80`): classes `LedgerR150`, `LedgerR150B` added (migration `v2`), G0 quiet |
| 14:22:38 / 14:23:31 | rebuild in `LedgerR150`; first publication `cell-0~p150` |
| 14:24:08 | rebuild in `LedgerR150B` with **no** request after the first (step 5, at 150 MiB) |
| 14:31:42–14:32:15 | cleanup (below) |

Departures: the top size is 150 MiB, not 300. By the cost rule, the rows per file the analytics
showed at 14:29 (rebuild 4.3, first publication 9.0) projected the 300 MiB step (a fill, a
rebuild and a publication) at about $5 more, over $6 in all. So `LedgerR300` and `LedgerR300B`
were never used and the no-caller rebuild ran at 150 MiB; the fills from 64 MiB on used 16
writers. Everything was deleted before the analytics of the last
runs had arrived (Durable Object analytics for a new namespace took 15–20 minutes to appear
here); they were read afterwards, by namespace id.

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
units). At least one R2 PUT of a segment failed with 10043 (service unavailable) during the 64 MiB fill;
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

## A rebuild from R2 (measured on Cloudflare, 2026-11-19, 14:12–14:25 UTC)

G0 quiet (nothing pending, no checkpoint running); then one object of the same tenant on empty
storage, in its own namespace, receives a request. It reads the newest checkpoint's parts, then
every segment after it, and writes the new incarnation's base to R2 before it commits and
serves. "Ready" is the caller's time from the first request to the first plan answered.
Afterwards its state was compared with G0's: version, every stream's watermark, the state
estimate and the full file lists of two days of both tables (SHA-256), all equal in every run.

| State (files) | Read: checkpoint parts / segments after it (changes) | Base written | Ready after (wall) | Phases (inside, by R2 call times): parts / segments / base | **CPU (analytics)** | Rows written | Calls refused meanwhile (each waited) |
|---|---|---|---|---|---|---|---|
| 16 MiB (15,936) | 12 parts, 11.8 MB / 41 segments, 3.3 MB (1,711) | 16.5 MB | 4.1 s | 0.8 / 1.3 / 0.6 s | **1.2 s** | 65,524 | 1 (2.5 s) |
| 64 MiB (63,712) | 25 parts, 25.6 MB / 247 segments, 35.2 MB (18,267) | 66.2 MB | 27.6 s | 1.4 / 12.4 / 11.1 s | **14.2 s** | 273,208 | 9 (1.0–4.3 s) |
| 150 MiB (149,152) | 62 parts, 64.2 MB / 555 segments, 78.5 MB (40,593) | 155.6 MB | 34.7 s | 4.2 / 19.0 / 6.8 s | **18.6 s** | 637,294 | 12 (0.2–4.8 s) |
| 150 MiB, no caller | the same | 155.6 MB | 33.0 s (base in R2 after 29.7 s) | 3.0 / 17.3 / 7.8 s | **16.4 s** | 637,294 | 1 (the request that started it) |

- **What callers see.** Every request to the tenant while it rebuilds (a flush's `addUnit`, a
  query's `plan`) waits about 2 s and is refused with `ledger_unavailable: it is starting a ledger
  incarnation …; retry in 2 s`, retryable; the waits were 1.0–4.8 s, longer than the 2 s the
  code sets when the object's thread was busy replaying. Nothing else is answered until the new
  base is in R2: 4 s of refusals at 16 MiB, 28 s at 64 MiB, 35 s at 150 MiB. The `addUnit`
  probe was refused, never admitted, during the start and answered `not_contiguous` (its stream
  was unknown on purpose) once serving.
- **Where the CPU goes** cannot be split from the analytics (one total per object and minute).
  Divided by the changes replayed, a rebuild's whole CPU is 0.69 ms (16 MiB), 0.78 ms (64 MiB)
  and 0.40–0.46 ms (150 MiB) a change; by the files of the state, 0.07, 0.22 and 0.11–0.13 ms.
  The three sizes do not fit one linear model: the 64 MiB run took about 1.8 times what a fit of
  the other two predicts (its base upload was slow too: 66 MB in 11.1 s, against 156 MB in
  6.8–7.8 s at 150 MiB), and the two 150 MiB runs of the same work differed by 13%. Each logged change is applied in a
  SQLite transaction of its own (`applyLogged`), where a checkpoint is loaded a part per
  transaction and a base 256 rows per transaction; locally that difference was 15.6 s against 2.4 s for a
  32,000-file load (`ledger/README.md`).
- **The phases** are the R2 calls' times inside the object, whose clock advances only on I/O:
  they bracket the work, they do not measure CPU.
- **The CPU limit and callers.** Cloudflare resets a Durable Object's CPU budget to 30 s at every
  incoming request ("If you consume more than 30 seconds of compute between incoming network
  requests, there is a heightened chance that the individual Durable Object is evicted and
  reset", Durable Objects limits, read 2026-11-19). The analytics are consistent with it: with
  probes, the 64 MiB rebuild's 14.2 s was charged across the probes' invocations, the largest
  3.9 s. So a rebuild that callers keep calling (flushes retry; queries arrive) gets a fresh budget every
  few seconds. The no-caller run is the strict case: nothing after the request that started it;
  at 150 MiB it used 16.4 s and finished (the base in R2 29.7 s after the request, the first plan
  answered at 33.0 s).
- **Memory**: at most 28, 34, 51 and 46 MB (`memoryUsageBytes`, periodic maximum): a rebuild
  holds a part or a few segments, not the state (D47 holds on Cloudflare).

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

## Cost (measured on Cloudflare)

Read from the analytics API (`analytics.mjs`, window 14:09–14:40 UTC 2026-11-19, read at
14:41 UTC; every Durable Object namespace and the bucket of this spike), priced at Workers Paid
list prices **ignoring the included allowances**:

| Item | Used | At list price |
|---|---|---|
| SQLite rows written | 4,819,521 | $4.82 |
| SQLite rows read | 7,131,540 | $0.01 |
| Durable Object requests | about 73,600 (the dataset is sampled) | $0.01 |
| Durable Object duration | 825 GB-s | $0.01 |
| R2 Class A (PUT, list) | 1,427 | $0.01 |
| R2 Class B (GET, head) | 1,885 | < $0.01 |
| R2 storage (under 0.5 GB for 22 minutes) | | < $0.01 |
| Workers requests | 252 | < $0.01 |
| **Total** | | **$4.86** |

By activity (rows written): the fill to 150 MiB 1,146,535 (15.4 per two-file unit, 7.7 per
file, pre-images included; modelled 13 and 6.5); the four rebuilds 1,613,320 (4.1–4.3 per file;
modelled 4.5); the three first publications 2,059,387 (9.0 per file; modelled 11). The modelled
worst case stated before deploying was $9.70 for the whole plan; the stop rule kept the spike
under $6, and it came to $4.86. All of it falls inside the
plan's included allowances (50 M rows written and 400,000 GB-s a month, of which 3.0 M and 53,489
had been used in November before this spike), so the bill it adds is the R2 operations at most:
cents.

**The analytics were not stable within the first half hour.** Durable Object rows for a new
namespace appeared 15–20 minutes after its first request; G0's rows written read anywhere from
0.90 M to 1.15 M for the same window as reports arrived (per-minute and whole-window queries
disagreed); and a reading at 14:44 had lost `LedgerR150`'s row that the 14:41 reading had
(18,618 ms of CPU, 637,294 rows, 51 MB). Every figure in this README is from the 14:41 reading,
the only one with every object of the spike in it; where a figure was read more than once it was
the same each time, except G0's totals.

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

## Not measured

- **300 MiB**, and anything between 150 and 300 MiB: stopped by the cost rule (the fill, a
  rebuild and a first publication at 300 MiB were projected at about $5 more at the measured
  rows per file). Everything said above 150 MiB is extrapolated.
- **A rebuild with the worst log mix.** The byte rule lets the log since the newest checkpoint
  grow to about the checkpoint's size (plus what is logged while checkpoints are written) before
  the next one; the runs here had about 0.6 of that (by changes: 18,267 at 64 MiB and 40,593 at
  150 MiB, against about 31,000 and 72,000 at most). The worst case is modelled above from the measured
  cost per change, not measured.
- **A first publication from checkpoint parts** (format 2) rather than a base, and a re-base
  onto a new incarnation of a tenant already published: both lighter than what was measured
  (D55's local measurements), neither timed here.
- **The publisher with resumable re-bases**, the change being made now: this ran `b237b6b`, which
  does not have it.
- **The production alarm path** of the publisher: the publication ran by RPC (`publish`), the
  code the alarm calls, with the same 30 s budget per invocation; the alarm adds its lease and
  maintenance, not measured.
- **`limits.cpu_ms` raised**: not deployed, since nothing failed at the sizes measured.
- **Compaction and retention** (`replace`, `expire`): the state only grew; tombstones were none.

## How to read it, and run it again

`worker.ts` (the Worker), `wrangler.jsonc`, `driver.mjs` (jobs: `fill`, `quiesce`, `rebuild`,
`publish`, `drop`; `status`, `log`, `list`, `purge`), `analytics.mjs` (usage and CPU by class
and object), `inventory.mjs` (the account's resources by name). To repeat: a detached worktree
of the commit, `node_modules` linked from `ledger/`, these files copied to its
`spikes/s11-large-ledger/`, `wrangler r2 bucket create viz-s11-lake`, `wrangler deploy`, a key
generated into a file and set with `wrangler secret put KEY < file`, then for each size: `job
'{"op":"fill","targetBytes":…,"writers":16,"maxMs":660000}'`, `job '{"op":"quiesce","maxMs":600000}'`,
`job '{"op":"rebuild","gen":"R64","probeMs":1000,"maxMs":600000}'`, `job
'{"op":"publish","name":"cell-0~p64"}'`, `job '{"op":"drop","incarnation":2}'`. Each replica class
rebuilds once (its object then holds the state); add classes with a new migration for more
runs. Durable Object analytics for a new namespace appeared 15–20 minutes after its first
request here, and the per-minute rows kept changing for a while: read them at least 30 minutes
after a run, before drawing conclusions.

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
