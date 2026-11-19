# Spike S11: a ledger state above 16 MiB on Cloudflare

Production keeps the ledger's state at 16 MiB (`LEDGER_STATE_MAX_BYTES` in
`stack/wrangler.jsonc`, `STATE_MAX_BYTES` in `ledger/src/ledger.ts`), although the code reaches
300 MiB in local workerd (D47, D55). The review of D47/D48/D55 (P-3) keeps that cap until "a
rebuild and a first publication above 16 MiB have been timed on Cloudflare against the CPU
limit". This spike times both, on Cloudflare, at 16, 64 and 150 MiB.

RESULTS-PLACEHOLDER

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
