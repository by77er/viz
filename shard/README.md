# Shard

The first piece of viz product code: the pooled shard Durable Object and its routing.

A shard is the write-ahead log for incoming telemetry. One shard object serves several
tenants. Each tenant's log inside it is a **stream**, identified by
`(shard, tenant, incarnation)`; sequence numbers, seals, discard marks, quotas and dedup
fingerprints all belong to a stream. A dedicated tenant is a pool of its own, so pooled and
dedicated tenants run the same code.

| File | Contents |
|---|---|
| `src/shard.ts` | `Shard`: append, seal (and its notification), pending segments and tenants, read segment, recorded, tail read, active-series metering, alarm housekeeping |
| `src/sketch.ts` | `SeriesWindow`: distinct series in a sliding window: exact set, then HyperLogLog + Bloom filter |
| `src/pool.ts` | Pool maps and routing: which slots a tenant may use, which slot a sender goes to; `validPoolName` |
| `scripts/mutants.mjs` | Mutation check of the newer properties (runs only on a copy outside the git checkout) |
| `test/` | 54 tests in 7 files, run inside the Workers runtime |
| `bench/` | The counterfactual in workerd: this shard against the frozen as-built one (`bench/asbuilt/`, `dc2a1c3`) |

## What is implemented

- **Durable acknowledgement, in groups** (D37). An accepted `append` joins the open group;
  the group commits in ONE SQLite transaction at the end of the current event (or at once
  at 4 MB): a row per batch, the stream rows, any seal with its notification. Each caller is
  answered only after that transaction, with its own contiguous sequence number; if it
  throws, every member gets the error, nothing is stored, and memory is rebuilt from
  storage. A retry of a batch still waiting in the open group shares its row and answer.
- **Early refusal** (D37). With 64 appends in flight or 16 MB pending (`maxInFlight`,
  `maxPendingBytes`), `append` answers `{ status: 'backpressure', scope: 'overload',
  retryAfterMs }` (1–2 s, jittered) before it reads or writes anything, not even the
  fingerprint. `edge` answers it 503 with that `Retry-After`. `stats()` counts appends,
  groups and refusals.
- **Per-tenant sequencing and dedup.** Retries with the same fingerprint return the original
  sequence number. The same fingerprint from another tenant is a different batch.
- **Backpressure that does not cross tenants.** Each tenant has its own byte cap. When the
  whole shard is over budget, only tenants above their fair share are refused; there is a
  hard ceiling at twice the budget.
- **Seal on size or age**, per stream, with the boundary written durably.
- **Recorded marks** accepted only at the next segment boundary and for the current
  incarnation.
- **Discard with a fence.** Payloads are dropped after a retention window; a tail read
  asking about rows below the discard mark is refused rather than answered with a gap.
- **Tail reads scoped to one tenant.** A caller naming an incarnation the shard does not
  hold (it has no stream for the tenant) gets `incarnation_mismatch` with incarnation 0,
  never an empty `ok` (review R-10), so a lost stream shows.
- **Segment reads bound to what was listed** (spec F12): `readSegment(tenant, seqLo,
  incarnation, seqHi)` answers null unless the stream is still that incarnation and the
  segment is exactly that range.
- **Map-epoch fencing** per stream.
- **Batch size cap (contracts v2).** `append` answers `{ status: 'too_large', maxBytes }`
  for a payload over `maxBatchBytes` (configurable, default `MAX_BATCH_BYTES` = 1,048,576,
  the one place the number of `contracts/BATCH.md` exists in code; `edge` imports it).
  Nothing is stored and no stream is created for a tenant whose first payload is too large.
- **New incarnation after storage loss**, so sequence numbers are never silently reused.
  **Incarnations are monotonic in time**: `newIncarnation(now, random)` is
  `now_ms * 1024 + 10 random bits`, so a stream recreated at a later millisecond always
  gets a larger number (verified by test, with the worst-case random bits), and the value
  is a safe integer until the year 2248. The only ways to get a non-increasing value are
  two creations of the same stream in one millisecond or a clock that steps backwards
  across a storage loss; the ledger refuses a lower incarnation, so that fails closed.
- **Flush triggering.** See the section below.
- **Active-series metering and limit.** See the section below.
- **One alarm per shard**, set to the earliest deadline and absent when idle. The deadlines
  are: age seal, discard of recorded segments, fingerprint expiry, an unsent seal
  notification or unwritten pending marker, and an unsaved series window.
- **Shuffle-shard routing**: each tenant gets a small subset of the pool by rendezvous
  hashing, so tenants rarely share their whole subset.
- **Names** (D38, `contracts/TABLES.md`): a shard object whose name does not match
  `SHARD_NAME` (segments of `[A-Za-z0-9-]` joined by `/`) throws in its constructor and so
  serves nothing; `validPoolName` is what `edge` checks maps against; `dedicatedPool`
  turns a tenant id's `_` into `-`.
- **Versioned storage and formats** (`contracts/COMPATIBILITY.md`, D24). `shard.Shard`
  version 1 through `contracts/schema.ts`: it adopts the pre-versioning schema unchanged
  and adds `segment.sealed_at` to objects created before it. Storage of a newer release is
  refused: `append` answers retryable `overload`, every other method throws
  `schema_too_new`, nothing is written, the alarm is re-armed. The series-window bucket
  carries a format byte (`SKETCH_FORMAT`); a bucket of an unknown kind or version is not
  read as something else: that tenant's metered appends are refused (retryable) rather than
  counted against an empty window. The flush message carries `v` (`FLUSH_MESSAGE_VERSION`).
  Goldens: `test/golden/schema/v1.json`, `test/golden/formats/series-window.v1.json`,
  `queue.flush.v1.json`.

## Flush triggering

When a stream seals (on size inside `append`, on age in the alarm, or by `seal()`), the
shard inserts a row into its `notify` outbox **in the same transaction as the segment**
and then hands `{v: 1, tenant, shard}` to `announce`, which sends it to the Queue bound as
`FLUSH_QUEUE`. A send that fails leaves the row; the alarm retries it after
`notifyRetryMs` (30 s). A send that happens twice is harmless: flush is idempotent.

**Why a Queue, and how to change it** (`design/DECISIONS.md` D18): a direct call to flush
from the object would tie a multi-second run with several R2 writes to the object that
must stay free to acknowledge writes, and would have no retry of its own. The Queue gives
at-least-once delivery, backoff, batching and a dead-letter queue; what it adds (a send
that can fail, duplicates, dead letters) is covered by the outbox, by flush being
idempotent, and by the sweep. The transport is the one method `announce`: replace its
body to notify some other way; the outbox, marker and sweep do not change. Without a
`FLUSH_QUEUE` binding `announce` does nothing (callers that poll `pendingSegments`).

**The pending marker.** While a shard has sealed segments its ledger has not recorded, it
keeps the KV key `flush-pending:<shard>` (binding `CONFIG`). It is written at the first
such seal (retried by the alarm if KV refuses) and removed by `pendingTenants()` when that
finds nothing pending; recording a segment does not touch KV, so a busy shard writes the
key about once an hour, not once per seal. The sweep (`flush/src/sweep.ts`) lists these
keys, so it never wakes a shard that has nothing pending. When `pendingTenants` removes the
marker it first stops believing it is there, so a failed re-put (KV allows about one write
per second per key) leaves the shard writing it again at its next seal or alarm, never
believing in a marker that is gone (review R-6).

**`pendingTenants(olderThanMs)`** lists the tenants with unrecorded segments whose oldest
was sealed at least that long ago: what the sweep re-enqueues.

Not on this path: the acknowledgement of an append that seals waits for the queue send
and, at most once per marker period, a KV write. Both are single calls to a regional
service, not R2 writes; moving them behind the acknowledgement is a small change if they
measure slow on Cloudflare.

## Active series

`append` takes `seriesIds` (the batch's series ids, from `edge`) and `seriesLimit` (this
shard's share of the tenant's limit); see `contracts/BATCH.md`, "Active series".

- **Window.** Per stream, two rotating buckets of `seriesWindowMs / 2` (30 min): a series
  is active for 30 to 60 minutes after its last sample. Rotation is lazy, by the clock at
  the next use; no timer.
- **Exact, then a sketch.** A bucket is a set of ids up to `seriesExactMax` (4,096). Above
  that it becomes a HyperLogLog (4,096 one-byte registers = 4 KB, standard error 1.6%) for
  the count **and a Bloom filter for membership** (10 bits per expected id, 16 KB to 1 MB).
  The filter is there because the limit refuses only new series: a HyperLogLog cannot say
  whether an id was seen (only about m/n of new ids move a register, 0.4% at a million),
  so with it alone a tenant at its limit could keep adding series (`DECISIONS.md` D21).
- **The check is per series.** Ids not in either bucket are new. If the count plus the new
  ids exceeds the limit, the batch is refused whole with `series_limit` and the ids that do
  not fit; nothing is stored or counted. `edge` leaves those series out and appends the
  rest, so existing series are always accepted. Simpler than `edge` splitting a batch per
  series, and the shard still never parses a batch.
- **Cheap verification.** The only check on `seriesIds` is that its length equals the
  batch header's `n_series`; a mismatch answers `invalid` and stores nothing.
- **Persistence.** Windows are saved from the alarm at most every `seriesPersistMs` (60 s),
  two rows per stream (whole buckets), never per append, and rebuilt in the constructor. A
  window is marked for saving only when an append changed it (review R-11(a)); a tenant
  writing only series it already has costs no window writes.
  After an eviction the count is low by the new series of at most that interval.
- **`seriesCount(tenant)`** → `{ count, exact, windowMs }`, for a cardinality report.

Limits of this: above the exact threshold about 1% of new series pass as existing (Bloom
false positives; such an id sets no new bit, so the rate does not grow while a stream is
at its limit); the filter is sized when a bucket is promoted and not resized if the limit
changes, and stops being useful beyond about 800,000 ids per bucket; the limit is enforced
per shard on an even share, so an unevenly spread tenant is refused before its whole limit.

## How it was verified

```
npm install
npx vitest run --maxWorkers=2   # 54 tests in workerd, 7 files
npx tsc --noEmit                # clean
node scripts/mutants.mjs        # on a copy outside the git checkout (see the script)
npm run bench                   # the workerd counterfactual (bench/)
```

Last run, 2026-11-19: **54 passed, 0 failed**; `tsc --noEmit` clean.

- `test/shard.test.ts` (isolation, sequencing, fences, R-10), `test/pool.test.ts` (routing,
  names), `test/trigger.test.ts` (the seal notification, its outbox, the marker; the
  message's golden), `test/series.test.ts` (the active-series window and limit),
  `test/groupcommit.test.ts` (group commit, early refusal, a random property: under random
  load, evictions and refusals every acknowledged append is stored exactly once and nothing
  refused is; R-11(a)), `test/review.test.ts` (R-6, ported from the reviewer; spec F12),
  `test/compat.test.ts` (versioned storage and formats, COMPATIBILITY §8).
- Older mutants of the isolation tests (tenant filter, tenant cap, discard fence, fair
  share) and of triggering and the limit: `stack/scripts/mutants.mjs` (`trigger`, `limit`).

**Counterfactual, measured in local workerd** (`bench/saturation.bench.test.ts`, results in
`bench/results/`): one shard under C clients, as built and with early refusal and group
commit, same clients and batches; before any rate is compared each run must have stored
exactly the batches it acknowledged, each once, and none it refused. At 64 clients: as built
133 acknowledged per second, median 372 ms; this shard 1,174 per second, median 37 ms. The
workerd numbers put clients, shard and SQLite on one thread; the tuning runs (window, limits)
are in `bench/results/tuning.log` and D37.

**Measured on Cloudflare** (`spikes/s3-ingest-throughput/`, 2026-11-19, three 10-second runs
per cell, 50-series requests, one shard): at 64 clients 864–1,056 acknowledged per second,
median 50–59 ms, 99th 129–148 ms, against 301–340, 157–178 ms and 446–493 ms for the
as-built shard the same day; at 200 clients refusals came back in 0–7 ms at the median and
acknowledged requests kept a 99th of 137–276 ms. Not checked there: that the stored
batches equal the acknowledged ones (the workerd counterfactual checks it).

### Mutation checks

`node scripts/mutants.mjs` on a copy of `contracts/` and `shard/` in a scratch directory
(the script refuses to run in the git checkout); each mutant against the test files named in
the script. Run of 2026-11-19: **17 of 20 killed**, each by the test named in its line of the
run's output. Killed: early refusal without the in-flight limit, without `Retry-After`, never
releasing in-flight appends; a failed group answered `ok`; an append answered before its group
commits; a retry in the open group stored again; one transaction per append; R-6, R-10,
R-11(a); F12's incarnation and range checks; the name rule (shard and pool); the flush
message without `v`; no `sealed_at` migration; an unreadable series window starting empty.
**Survived, then addressed:** "the check reads the fingerprint first" (the test named "a
refused append reads nothing" never stored the batch it retried; it now does) and "the tenant
cap ignores bytes waiting in the group" (no test sent concurrent appends past the cap; one does
now, `groupcommit.test.ts` "the tenant cap counts what waits in the open group"). Both re-run
on the final code: see below. **Survived, equivalent:** "R-12: fingerprint expiry names no
tenant": every tenant has the same fingerprint TTL, so deleting other tenants' expired rows
changes nothing observable; the rule (every statement names its tenant) is met by reading.

## Not implemented yet

- **Map-epoch handover**: draining shards and moving fingerprints on a map change.
- **Registration before writes** (spec F1). The shard only reports a new incarnation;
  `flush/` registers it with the ledger at its first flush. Until then queries naming the old
  incarnation are refused, indefinitely for a stream that gets no new writes (spec F6;
  `ledger/README.md`, "Known risks").
- **CPU fairness.** Byte budgets and the in-flight limit are per shard; a tenant sending many
  tiny requests still shares the object's single thread with its neighbours. Not measured.
- **Tuning on Cloudflare.** The in-flight limit (64), pending bytes (16 MB) and group window
  (end of event) were chosen in workerd and confirmed, not tuned, on Cloudflare.

## Known risks

- **A sealing group's acknowledgement waits for the queue send**, and once per marker
  period for a KV write (`deliver` runs before the answers go out). Neither is R2; the S3
  re-run includes them. Moving them behind the acknowledgement is a small change if they
  measure slow.
- **The early refusal limit is per object, not per tenant**: a tenant flooding a shared
  shard gets other tenants refused as `overload` too (byte budgets stay per tenant).
