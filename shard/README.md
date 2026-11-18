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
| `src/pool.ts` | Pool maps and routing: which slots a tenant may use, which slot a sender goes to |
| `test/` | 34 tests in 4 files, run inside the Workers runtime |

## What is implemented

- **Durable acknowledgement.** `append` returns after the batch is written to SQLite; the
  runtime holds the response until the write is durable.
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
- **Tail reads scoped to one tenant.**
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

## Flush triggering

When a stream seals (on size inside `append`, on age in the alarm, or by `seal()`), the
shard inserts a row into its `notify` outbox **in the same transaction as the segment**
and then hands `{tenant, shard}` to `announce`, which sends it to the Queue bound as
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
keys, so it never wakes a shard that has nothing pending.

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
  two rows per stream (whole buckets), never per append, and rebuilt in the constructor.
  After an eviction the count is low by the new series of at most that interval.
- **`seriesCount(tenant)`** → `{ count, exact, windowMs }`, for a cardinality report.

Limits of this: above the exact threshold about 1% of new series pass as existing (Bloom
false positives; such an id sets no new bit, so the rate does not grow while a stream is
at its limit); the filter is sized when a bucket is promoted and not resized if the limit
changes, and stops being useful beyond about 800,000 ids per bucket; the limit is enforced
per shard on an even share, so an unevenly spread tenant is refused before its whole limit.

## Tests

```
npm install
npm test          # 34 tests in workerd, 4 files
npx tsc --noEmit  # clean
npm run typecheck
```

The isolation tests were checked by breaking the code on purpose. Each of these mutations
makes at least one test fail: dropping the tenant filter from tail reads; applying the
tenant cap to the shard total; removing the discard fence; removing the fair-share check.

`test/trigger.test.ts` (7): one notification per seal on size, age and by hand, none
otherwise; an unsent notification survives eviction and is retried; `pendingTenants` by
age and per tenant; the marker's life; a marker KV refused is retried; an idle shard has
no alarm, no outbox row and no marker. `test/series.test.ts` (9): sketch accuracy within
5% from 5,000 to 1,000,000 ids for random, sequential and prefix-clustered ids; exact
counting across buckets and forgetting; the switch to the sketch (no false negatives, at
least 97% of new ids recognised, save/load); the limit refusing only new ids that do not
fit, per tenant; unmetered and inconsistent requests; retries; persistence from the alarm
only; the limit above the exact threshold. Mutants for both: `stack/scripts/mutants.mjs`
(`trigger`, `limit`), results in `stack/README.md`.

## Not implemented yet

- **Group commit.** Each append is one SQLite row. Batching several requests into one row
  to cut billed row writes is not done.
- **A schema migration.** `segment.sealed_at` and the new tables are created with the
  object; a shard created by older code would need an `ALTER TABLE` (none exists).
- **Map-epoch handover**: draining shards and moving fingerprints on a map change.
- **Incarnation handshake** from the shard's side. The shard only reports mismatches;
  `flush/` registers a new incarnation with the ledger when `addUnit` reports one.
- **CPU fairness.** Byte budgets are isolated; a tenant sending many tiny requests still
  shares the object's single thread with its neighbours. Not measured.
- **Load behaviour.** Nothing here has been run under load or on Cloudflare.
