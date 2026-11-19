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
| `src/tail.ts` | Filtered, paged tail reads (D48): the filter over stored `VZB1` batches, the page cursor, `splitKeyRange` |
| `src/pool.ts` | Pool maps and routing: which slots a tenant may use, which slot a sender goes to; `validPoolName` |
| `scripts/mutants.mjs` | Mutation check of the newer properties (runs only on a copy outside the git checkout) |
| `test/` | 63 tests in 8 files, run inside the Workers runtime |
| `bench/` | The counterfactual in workerd: this shard against the frozen as-built one (`bench/asbuilt/`, `dc2a1c3`); a 20 MB tail read whole and filtered (`tail.bench.test.ts`, results in `bench/results/tail.txt`) |

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
- **Tail reads filtered and paged** (D48; query/CARDINALITY.md "What is left" 1). `tailRead`
  takes an optional fourth argument, `TailReadOptions` (`v` 1): a time range (`minTs`,
  `maxTs`), `metrics` (`__name__` values), `labels` (exact values; `''` = absent) and a
  `keyRange` of `series_id` read as unsigned (`splitKeyRange(j, n)` is the engine's split
  part `j` of `n`), plus `maxBytes` (default and at most 16 MiB) and `cursor`. The shard reads
  each stored batch above the watermark, keeps the series and rows the filter keeps and writes
  them out as a new `VZB1` batch (series entries copied as stored, rows in their order, times
  and values copied as raw bytes); a batch kept whole is returned as stored. The answer is
  `ok` with `page: { v, next, scannedBatches, scannedBytes }`; `next` continues the same read
  (bound to tenant, incarnation, watermark and filter; versioned `v1.` token) through the
  `through` of its first page, so later appends are not in it. A page never holds part of a
  batch's kept rows: if they alone pass `maxBytes` the answer is `page_limit` (nothing
  returned, never truncated). Any page after rows above the read's watermark were discarded
  is `stale_watermark` (the caller re-plans); one call examines at most `tailScanMaxBytes` (32 MiB) and continues from
  there. Bad options or a cursor of another read are `invalid`; an unknown `v` is
  `unsupported_version`. **Without options the answer is exactly as before** (no `page`), and
  an older shard ignores the options, so a caller knows the filter was applied only by `page`.
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
npx vitest run --maxWorkers=2   # 63 tests in workerd, 8 files
npx tsc --noEmit                # clean
node scripts/mutants.mjs        # on a copy outside the git checkout (see the script)
npm run bench                   # the workerd counterfactual (bench/)
BENCH=tail npm run bench        # a 20 MB tail, read whole and filtered
```

Last run, 2026-11-19: **63 passed, 0 failed**; `tsc --noEmit` clean.

- `test/tail.test.ts` (8): a tail of 24 random batches written with the engine's own test
  encoder (`engine/wasm/test/vzb1.ts`), with duplicate `(series, ts)` and staleness markers,
  read back by the engine (WASM `select`), never by the shard's filter: for one series, a
  series lacking a label, two metrics in two minutes, a time range, no filter, and the four
  key ranges of a split, the pages hold exactly what the engine selects from the whole tail,
  and the same as from the tail flushed to Parquet by the engine (storage-location
  invariance, VERIFICATION.md I17; the key ranges partition the series); a batch kept whole
  is byte-identical; refusals (`page_limit`), the scan budget, a fixed `through`, cursors of
  other reads, versions, a discard between pages, eviction.

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

**Tail reads, whole against filtered** (measured here, in local workerd,
`bench/tail.bench.test.ts`, 2026-11-19, three runs of five reads each at load average 8–11;
raw lines in `bench/results/tail.txt`). The tail: 100,000 series of one metric
(`http_requests_total{job, instance}`, 20 jobs) at 60 s for seven minutes, 22.4 MB in 23
stored batches of about 1 MB, all unsealed. "Before" is the read every caller makes today
(no options); "after" the read each query needs. Before any time was compared, the engine
selected the same samples, bit for bit, from what each read returned. Times are medians per
run, around the RPC calls, so they include building and passing the answer in one process.

| Read | Calls | Bytes returned | Series | Time (median, three runs) |
|---|---|---|---|---|
| before: the whole tail | 1 | 22,351,120 | 100,000 | 55–105 ms |
| one series, `rate(m{instance="10.0.164.66:9100"}[5m])` | 1 | 248 | 1 | 37–142 ms |
| selective, `sum(rate(m{job="job-7"}[5m]))` over the last 3 minutes | 1 | 715,616 | 5,000 | 30–74 ms |
| one split leaf of 8 (its key range) | 1 | 2,782,832 | 12,448 | 55–86 ms |
| no filter, paged (16 MiB pages) | 2 | 22,351,120 | 100,000 | 78–123 ms |

What it says: the bytes a query takes from a shard drop with its selectivity (90,000× for one
series, 31× for the selective query, 8× for a leaf of 8), so a query no longer pays for the
whole tail against `maxFetchBytes` (16 MiB), and no answer passes one RPC message (32 MiB).
Time does **not** drop here: the shard still reads every stored batch from SQLite and scans
its series table and rows, which costs about what passing the whole tail costs in one local
process (the first version decoded every label value as a string and took up to 273 ms for
one series; comparing bytes instead brought it to the table's range). On Cloudflare, where
the 22 MB would cross the network to the query Worker, the "before" read is modelled at
0.2–1 s more than here (training knowledge of Durable Object RPC bandwidth, not measured);
**experiment that settles it:** the same reads from a query Worker against a shard on
Cloudflare. Skipping whole batches by time or metric without scanning them needs per-batch
metadata at append (not built).

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
now, `groupcommit.test.ts` "the tenant cap counts what waits in the open group"). Both were
re-run on the final code and **killed** by those tests: 19 of 20 in all. **Survived, equivalent:** "R-12: fingerprint expiry names no
tenant": every tenant has the same fingerprint TTL, so deleting other tenants' expired rows
changes nothing observable; the rule (every statement names its tenant) is met by reading.

**Run of 2026-11-19, filtered and paged tail reads** (the 12 `tail:` mutants with the 20 above,
on a copy of `contracts/`, `shard/` and `engine/wasm/{js,test}`): of the 20, the same 19 killed
and R-12 survived (equivalent, above; R-10's pattern was updated for the new code). Of the tail
mutants, killed by `test/tail.test.ts`: the time range ignored; series keys compared as signed;
a label with another value, and a wanted label the series lacks, not excluding it; a page
passing its budget; a batch that does not fit an empty page dropped instead of refused; a cursor
not bound to its filter; a later page reading to the current end instead of the first page's
`through`; the scan budget ignored; the metric names ignored and a paged read not checking
the discard fence (both re-run after their first patterns proved wrong: one changed only an
initial value the loop overwrites, the other targeted a check that can never fire, because the
fence is checked against the read's watermark on every page first; that dead check was removed).
**Survived (1): "values copied as numbers"** (`getFloat64`/`setFloat64` instead of a byte
copy): V8 keeps a NaN's bits through that path, signalling NaNs included, so the test of the
staleness marker cannot tell; the byte copy is what BATCH.md asks for and is right by reading.
In all: **30 of 32 killed**, R-12 and this one surviving.

## Not implemented yet

- **Skipping stored batches without scanning them.** A filtered read decodes the series table
  of every batch above the watermark. Per-batch time bounds and metric names, written at append
  (a schema change and work on the append path), would let it skip batches outside the range.
- **Key ranges of a split that leaves labels out** (`sum without (…)`): the split key is then a
  hash of the other labels, not `series_id`; a filtered read cannot select it, and the
  coordinator keeps cutting such tails itself (`engine.splitTails`).
- **Regular-expression matchers** in the filter: only exact values, so a filter is a superset
  of what a query with `=~` selects (the engine still applies the query's matchers).

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

- **A filtered read costs the shard CPU in proportion to its whole tail** (above), once per
  query per shard, on the object that acknowledges appends. 22 MB took 30–140 ms here. A tenant
  with many concurrent queries over a large tail adds that much to its shard's thread each.
- **Concurrent paged reads have no memory bound together** (review of D47, D48 and D55, P-10).
  A page holds up to `maxBytes` (default and at most `TAIL_PAGE_MAX_BYTES`, 16 MiB) until the
  RPC result is serialized. `tailPage` is synchronous, but answers to concurrent reads (eight
  split leaves per query, several queries) can be alive at once: the default is an eighth of the
  isolate per read. It is still better than before D48, when every read returned the whole
  unpaged tail. Not changed: a smaller default (the measured selective read was 0.7 MB) or a
  per-shard budget across reads in flight would bound it.
- **A cursor can be refused for a filter given in another order** (review N-4). The cursor's
  filter binding sorts label pairs with the default `sort()`, which compares `"name,value"`
  strings (`src/tail.ts`). With commas in names or values, two orders of the same filter give
  different canonical texts, and a valid cursor is answered `invalid`. It fails closed.

- **A sealing group's acknowledgement waits for the queue send**, and once per marker
  period for a KV write (`deliver` runs before the answers go out). Neither is R2; the S3
  re-run includes them. Moving them behind the acknowledgement is a small change if they
  measure slow.
- **The early refusal limit is per object, not per tenant**: a tenant flooding a shared
  shard gets other tenants refused as `overload` too (byte budgets stay per tenant).

## Needed changes elsewhere

**`query/`** (the coordinator and the leaves; not edited here). What makes a query read only
the tail it needs, and split leaves fetch only their key range:

1. **Coordinator, `readTail`** (`query/src/coordinator.ts`). Call
   `stub.tailRead(c.tenant, incarnation, above, opts)` with `opts` from the query's selectors
   (`engine.selectors(...)` / the plan's `FetchRange`s): `minTs`/`maxTs` the hull of every
   selector's range including lookback; `metrics` the `__name__` equality values if EVERY
   selector has one (else none); `labels` only the equality matchers that ALL selectors share
   (a value `""` means absent); `maxBytes` the fetch budget still left, at most
   `TAIL_PAGE_MAX_BYTES`; then follow `r.page.next` as `cursor` until null, concatenating
   `batches` in order and counting their bytes against `maxFetchBytes` as they arrive
   (refuse with `max_fetch_bytes` as soon as it is passed). Keep the handling of
   `stale_watermark` and `incarnation_mismatch` exactly as now: they can come on any page, and
   either means re-plan from the ledger (the pages read so far are dropped). New statuses:
   `page_limit` is `max_fetch_bytes` (a single kept batch is larger than the budget left);
   `invalid` and `unsupported_version` are a retryable `unavailable`, like any status it does
   not know. **Release skew** (COMPATIBILITY.md §3.3, callee first): an `ok` WITHOUT `page`
   comes from a shard that predates this; its batches are the whole tail, unfiltered and
   unpaged, and the coordinator uses them as it does today (the engine applies the matchers and
   ranges anyway; for a split, `engine.splitTails` still cuts them). Do not rely on `page`
   until every `viz-ingest` version running sends it. **An answer without `page` in the middle
   of a paged read** (a rollback or a gradual deployment between two pages; review of D47, D48
   and D55, P-9): it is still the whole tail, so drop the pages already read and use that
   answer alone. Appending it would count every row twice against `maxFetchBytes` and the
   sample budgets. The engine's de-duplication by `(series_id, ts)` would keep the result
   right, but the query could be refused. **A new filter field** comes with `v` 2. A `v` 1 shard
   ignores fields it does not know (COMPATIBILITY.md §3.2) and still answers with `page`, so
   only a new `v` makes it answer `unsupported_version` instead of a superset that looks
   filtered.
2. **Split leaves** (`query/src/leaf.ts`, `runSplit`). When the split key has no `without`
   labels, each leaf reads the tail itself: the coordinator passes each shard's
   `(shard, incarnation, above)` it planned (including what `known` learned) to the leaf, and
   leaf `j` of `L` calls `tailRead` with the coordinator's `opts` plus
   `keyRange: splitKeyRange(j, L)` (exported by `shard/src/shard.ts`; the same bounds as the
   engine's `SplitKey::part_of`), following pages as above. The coordinator then no longer
   holds the tail at all for such queries; a leaf's `stale_watermark` or
   `incarnation_mismatch` makes the coordinator re-plan. Keep `engine.splitTails` for splits
   with `without` labels and for shards that answer without `page`.
3. **Label endpoints and the cardinality report**: pass `metrics` (when a matcher names the
   metric) and the time range, so `/label/…/values?match[]=m` and the report read only `m`'s
   tail.
4. **`query/README.md` "Needed changes" 3** (paging and a filter in `shard/`) is done on the
   shard's side by this change; items 1–3 above are what remains in `query/`.
