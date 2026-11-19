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
| `src/tail.ts` | Filtered, paged tail reads (D48): the filter over stored `VZB1` batches (by signal since stage 2), the page cursor, `splitKeyRange` |
| `src/pool.ts` | Pool maps and routing: which slots a tenant may use, which slot a sender goes to; `validPoolName`; `validBasePool`, the one rule for a pool map's pool that edge reads maps with and control writes them with (D66); `dedicatedPool`; the derived pools of spans and logs (`signalPool`, `enabledSignals`) |
| `scripts/mutants.mjs` | Mutation check of the newer properties (runs only on a copy outside the git checkout) |
| `test/` | 85 tests in 10 files, run inside the Workers runtime, against the real ledger in the same script (`wrangler.test.jsonc`, `test/worker.ts`), as in viz-ingest |
| `bench/` | The counterfactual in workerd: this shard against the frozen as-built one (`bench/asbuilt/`, `dc2a1c3`); a 20 MB tail read whole and filtered (`tail.bench.test.ts`, results in `bench/results/tail.txt`); registration before writes (`registration.bench.test.ts`, against the release before it frozen in `bench/prereg/`; results in `bench/results/registration.log`) |

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
  hold (it has no stream for the tenant) gets `incarnation_mismatch`, never an empty `ok`
  (review R-10), so a lost stream shows. Since D61 it names a fresh stream the shard started
  and registered for that read (below); without a `LEDGER` binding, incarnation 0 as before.
- **Registration before writes** (D61; spec/README.md "Proposed fixes", R2, with the changes
  of `design/reviews/registration-before-writes.md`). The shard registers each stream with
  the tenant's ledger (`env.LEDGER`, `idFromName(tenant)`; in viz-ingest the same script) and,
  in registration mode `logged`, accepts no write to a NEW stream (first use, or after the
  shard lost its storage) until the ledger answers the registration as LOGGED
  (`RegisterResult.logged`, derived by the ledger from its outbox). So every plan names every
  stream that holds acknowledged rows, whatever the ledger loses (spec F6(b), F1). How:
  - `append` to a stream that is not confirmed: the stream row is created (fresh incarnation,
    `registered = 0`), a registration call is started in the background if none is in flight
    and its backoff is over, and the append is answered at once `{ status: 'backpressure',
    scope: 'registering', retryAfterMs }` (500–1000 ms, jittered): before any quota, metering
    or group, with no await; nothing is stored, counted or held (review M-1; D37's bound is
    unchanged). A stream that already holds acknowledged rows (made by the release before D61,
    or in `lazy` mode) keeps accepting while it is confirmed in the background: refusing it
    would remove no exposure.
  - The registration: at most one call per stream at a time (single-flight), at most
    `maxRegistrations` (4) calls per shard in flight over all tenants (review m-5: a shard's
    six outbound connections), each waiting at most `registerTimeoutMs` (5 s), retried with
    backoff from 250 ms doubling to 30 s by the shard's one alarm (its deadline joins `arm()`;
    the alarm is set before each call, so a call lost with the instance is made again). On
    `logged: true` the incarnation is written to `stream.registered` (one row write) and the
    schedule dropped. What must be registered is rebuilt from storage in `load()`. An answer
    without `logged` (a ledger of the release before) is not logged.
  - `tailRead` naming an incarnation the shard has lost: it starts a fresh stream (the row
    first, before any await, so concurrent reads get the same one; newer than the one named,
    whatever the clock), awaits one registration call, and answers `incarnation_mismatch`
    naming it; the next plan names it, read from 0 it is empty (spec F6 liveness, `LIVE_impl`).
  - `ensureStream(tenant)` (new RPC): what an append does before it is accepted, without a
    batch: for the janitor (spec F16) and a map change or a new tenant (review m-4).
  - **Alert** (review m-1): a stream whose registration has not been logged after
    `registerAlertMs` (60 s) is an error line (`shard <name>: the registration of <tenant>'s
    stream … has not been logged …`), and `stats()` reports `registering` (streams waiting)
    and `registeringForMs` (the longest wait) with `refusedRegistering` and `registerCalls`.
    The ledger's `logStatus()` reports `registrationsPending` and `pendingSince`.
  - **S5 heals** (review m-7): a registration refused because the ledger has a higher
    incarnation (a clock stepped back across a storage loss) is checked against
    `loggedWatermarks()`; a new stream that holds nothing acknowledged is renumbered above
    the ledger's incarnation and registered. One that holds rows (from before D61) is never
    renumbered: it stays refused by the ledger, as before, and is reported.
  - Mode: `ShardConfig.registration` (`lazy` by default), overridden by the Worker var
    `SHARD_REGISTRATION` (`logged` or `lazy`). Without a `LEDGER` binding the shard is lazy
    whatever the mode. `lazy` is the append path as before D61; reads and `ensureStream`
    register in either mode. See "Rollout".
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
- **Spans and log records** (stage 2 of traces and logs, 2026-11-19; contracts/BATCH.md
  "Streams per signal", D57). The shards of the derived pools `{pool}/traces/{slot}` and
  `{pool}/logs/{slot}` are ordinary shards: `append` stores a span or log batch as it stores a
  metric one (opaque, at most `MAX_BATCH_BYTES`, sent without `seriesIds` so not metered), and
  seal, the flush notification, the pending marker, `readSegment`, `recorded`, discard and
  registration before writes (D61) work on their streams unchanged. `signalPool(map, signal)`
  is the one derivation of those pool names (edge, flush's sweep and the stack use it).
  **Tail reads by signal** (`TailFilter.signals`, an additive field of `TailReadOptions` v1):
  a filtered read keeps only batches whose header's signal byte is listed, without reading
  further; the time range and the series fields select metric rows only. A span or log batch
  the read admits is returned whole, as stored (its times are nanoseconds in columns of their
  own; the reader filters), unless the filter names `metrics`, `labels` or `keyRange`, which
  select series such a batch does not have: then it keeps nothing. A batch of any other
  signal is skipped when `signals` leaves it out and fails the read otherwise (never guessed
  at). A filter without `signals` has the same canonical text, so the same cursors, as before.
  A metrics query passes `signals: [1]`; query's span and log reads `[2]` or `[3]`. A shard of
  an earlier release ignores the field and throws on a span or log batch under a series
  filter, so callers still read only their signal's shards by name.
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
  notification or unwritten pending marker, an unsaved series window, and a registration's
  next call (D61).
- **Shuffle-shard routing**: each tenant gets a small subset of the pool by rendezvous
  hashing, so tenants rarely share their whole subset.
- **Names** (D38, `contracts/TABLES.md`): a shard object whose name does not match
  `SHARD_NAME` (segments of `[A-Za-z0-9-]` joined by `/`) throws in its constructor and so
  serves nothing; `validPoolName` is what `edge` checks maps against; `dedicatedPool`
  turns a tenant id's `_` into `-`. `validBasePool` (moved here from `edge/src/route.ts` after
  review M-5 of `design/reviews/signals-end-to-end.md`): a valid pool name that does not end in
  `/traces` or `/logs` (`contracts/BATCH.md`, "Streams per signal"). Edge refuses a map whose
  pool breaks it (503) and control refuses to publish one (422), with this one function, and
  control's dedicated pool is `dedicatedPool` (D66).
- **Versioned storage and formats** (`contracts/COMPATIBILITY.md`, D24). `shard.Shard`
  version 2 through `contracts/schema.ts`: version 1 adopts the pre-versioning schema
  unchanged and adds `segment.sealed_at` to objects created before it; version 2 (D61) adds
  `stream.registered` (additive, `readableFrom` 1: the release before ignores it and never
  changes a stream row's incarnation, so what this release wrote stays true and its 0 is
  only conservative). Storage of a newer release is
  refused: `append` answers retryable `overload`, every other method throws
  `schema_too_new`, nothing is written, the alarm is re-armed. The series-window bucket
  carries a format byte (`SKETCH_FORMAT`); a bucket of an unknown kind or version is not
  read as something else: that tenant's metered appends are refused (retryable) rather than
  counted against an empty window. The flush message carries `v` (`FLUSH_MESSAGE_VERSION`).
  Goldens: `test/golden/schema/v1.json`, `v2.json`, `test/golden/formats/series-window.v1.json`,
  `queue.flush.v1.json`.

## Rollout (D61)

Shard, ledger, flush, janitor and edge are one Worker, viz-ingest (`deploy/workers.json`), so
they deploy together; but Durable Objects take new code lazily (`durable_objects_code_update`:
"deferred 30s") and a gradual deployment runs two versions, so for a while edge isolates,
shards and ledgers run mixed releases in every combination (COMPATIBILITY.md §1). What must
hold, and why each combination is safe:

| Caller (release) | Callee (release) | What happens |
|---|---|---|
| shard D61 | ledger before D61 | `registerStream` answers without `logged`: taken as not logged. In mode `lazy` nothing waits on it; in mode `logged` a new stream is refused until the ledger runs D61 (at most the code-update delay). Tested: `registration.test.ts` "a ledger of the release before D61" |
| shard before D61 | ledger D61 | as before D61 (lazy registration by flush) |
| janitor D61 | shard before D61 | `ensureStream` is missing: the files are kept, the failure is in `ensured`, the sweep goes on (review m-6). Tested in janitor/ |
| janitor D61 | ledger before D61 | no `loggedIncarnation`: D30's rule (files kept longer, never deleted on a guess). Tested in janitor/ |
| edge before the mapping | shard in mode `logged` | `registering` would be answered **429**, which Remote Write senders may drop (review M-2). **Must not happen**: hence the two releases below |
| shard (either) | storage of the other | schema 2 is additive (compat 1). Rollback and roll-forward on the same storage, with the release before running as the old code, tested: every stream accepts afterwards, a confirmed registration stays confirmed (`registration.test.ts`) |

So the order is two releases (readers before writers, COMPATIBILITY.md §3.3):

1. **Release A** (this code): the ledger answers `logged` and `loggedIncarnation`; the shard
   registers on reads and `ensureStream`, has the `logged` mode, and runs `lazy` (no new
   status is sent); the janitor's F16 fix; and **edge maps `registering` to 503** ("Needed
   changes elsewhere" 1, being done in edge/ by its owner). A is safe to roll back: no format
   or status reaches a reader that does not know it, and schema 2 is additive.
2. **Release B**: viz-ingest's vars get `"SHARD_REGISTRATION": "logged"` ("Needed changes
   elsewhere" 3). Only once A is live everywhere and is the rollback floor (D46): a rollback
   below A would put an edge that answers 429 in front of shards that may still run B for the
   code-update delay. Rolling B back to A is safe at any time (the var goes; streams keep
   their `registered` value; appends are lazy again).

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
npx vitest run --maxWorkers=2   # 87 tests in workerd, 10 files (2026-11-19, review M-5)
npx tsc --noEmit                # clean
node scripts/mutants.mjs        # on a copy outside the git checkout (see the script)
npm run bench                   # the workerd counterfactual (bench/)
BENCH=tail npm run bench        # a 20 MB tail, read whole and filtered
BENCH=registration npm run bench  # registration before writes (D61)
```

Last run, 2026-11-19: **78 passed, 0 failed**; `tsc --noEmit` clean. The suite now runs with
the ledger in the same script (`wrangler.test.jsonc`; its drain only when a test asks).

- **Stage 2, spans and logs** (`test/signals.test.ts`, 7, 2026-11-19; batches written by the
  engine's test encoders `engine/wasm/test/signal.ts` and `vzb1.ts`, metric pages read back by
  the engine): a `…/traces/0` and a `…/logs/0` shard store, deduplicate, seal, list, serve
  (`readSegment`, unfiltered and filtered reads) and record span and log batches; a filtered
  read with their signal returns them whole and in order whatever the time range, one with
  `signals: [1]` or a series filter returns nothing; registration before writes (D61) refuses a
  new `…/traces/1` stream until the ledger has logged it, then accepts; in a stream mixing all
  three signals (not what edge writes) a metrics read gets only metric rows, which the engine
  selects exactly as from the metric batches alone, with and without a time range, a metric
  name and small pages, and a metric filter without `signals` drops the span and log batches;
  several signals at once and pages; a cursor bound to its signals; malformed `signals` refused
  `invalid`; a filter without `signals` keeps its pre-stage-2 cursor binding; a batch of an
  unknown signal (9) skipped by `signals: [1, 2, 3]` and failing a read that admits it, after
  eviction too, while the unfiltered form returns it as before.
  **Last run (2026-11-19): 85 passed, 0 failed (10 files); `tsc --noEmit` clean.**
- `test/registration.test.ts` (16, D61), each tied to a trace of the protocol model or a
  finding of `design/reviews/registration-before-writes.md`:
  - **spec test 1, shard half** (`R1_safety`): a new stream's appends are refused
    `registering`, nothing stored, while the ledger has only committed the registration; the
    retry is accepted once it is logged; the shard and the ledger are evicted between every
    step; a ledger rebuild that rolls a committed registration back is re-registered and still
    refused until logged; after the shard is accepted the ledger, emptied and rebuilt, still
    names the stream.
  - **review M-1**: with one tenant's ledger hanging (3 s per call), 40 appends of that tenant
    are all refused within 1.5 s and 40 appends of another tenant of the same shard are all
    acknowledged meanwhile; one ledger call for the 40; nothing in flight, pending or stored. A
    sender hammering a new stream with the default backoff makes at most 2 calls in 100 appends;
    concurrent reads after a loss and concurrent `ensureStream` calls share one call.
  - **review M-2, the shard's side**: the refusal is `backpressure` / `registering` with a
    `Retry-After` of 500–1000 ms, never a scope edge answers 429.
  - **spec test 3, shard half** (`LIVE_R2`): after a storage loss a read naming the lost
    stream is answered with a fresh, newer stream that the ledger already has; concurrent reads
    get the same one; read from 0 it is empty; once logged it takes writes. A registration call
    lost with the instance is made again by the alarm, from storage.
  - **review m-1** (alert), **m-5** (at most `maxRegistrations` calls in flight), **m-7** (S5
    heals a stream holding nothing; one holding rows is never renumbered).
  - **skew and rollback**: a ledger of the release before D61 (frozen,
    `ledger/bench/prereg/`) answers without `logged` and is never taken as logged; the shard
    release before D61 (frozen, `bench/prereg/`) run on the same storage (schema 2 opened by
    code that knows 1), then the roll-forward: every stream accepts, a confirmed registration
    stays confirmed. Without a `LEDGER` binding the shard is lazy and answers as before.
- The integration traces (shard + ledger + flush + a reader following the coordinator's
  protocol) are in `flush/test/registration.test.ts`; the F16 and F15 traces with the janitor
  in `janitor/test/registration.test.ts`; the soak in `stack/test/soak.test.ts` runs the
  shards in mode `logged` (400 steps, seeds 20261118, 1, 7, 42: passed).

**Measured here** (local workerd, 2026-11-19, load average 2.6–3.4 on 4 cores;
`bench/results/registration.log`):

- **A new stream's first acknowledgement**, from the sender's first send, the ledger draining
  on its own (200 ms after a commit), 30 streams each: with the shard's `Retry-After`
  (500–1000 ms), **519–1007 ms, median 702** (one refusal each); with it rounded up to whole
  seconds, as edge writes the header, **1006–1013 ms** (one refusal each). Local R2 PUTs take
  milliseconds, so these are lower bounds for Cloudflare: the spec's **modelled** 0.5–1.5 s
  assumed a 180–494 ms segment PUT and a 0.5 s Retry-After; with edge's whole seconds the
  modelled figure is **1–2 s** (review m-9), each refusal one shard→ledger round trip that is
  **not measured from a shard** (15–47 ms Worker→ledger on Cloudflare, s4). The experiment that
  settles it: fresh streams started on Cloudflare, first send to first acknowledgement, n ≥ 30,
  idle ledger and one under eight writers (spec "What remains unproven").
- **Appends per second of established streams**, this release in mode `logged` (streams
  confirmed) against the release before (frozen, `bench/prereg/`), same clients and batches,
  4 s, three runs each, every run storing exactly what it acknowledged: 1 client 748 / 771 /
  703 against 767 / 806 / 708; 16 clients 2,866 / 2,815 / 2,525 against 2,788 / 2,838 / 2,742;
  64 clients 3,452 / 2,977 / 3,035 against 3,427 / 3,025 / 3,027. No difference beyond the
  run-to-run spread (the path adds one boolean test per append). Nothing was tuned: no
  parameter of this release touches that path.

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

**Run of 2026-11-19, stage 2 of traces and logs** (a scratch copy of the tree; against
`test/signals.test.ts`): **"metrics tail reads returning span batches"** (the `signals` check
removed from `filterBatch`, so a read with `signals: [1]` keeps span and log batches) is
**killed** by "a metrics read (`signals: [1]`) gets only metric rows…" and by both derived-pool
tests ("a traces shard … like a metrics shard", "a logs shard …"). 1 of 1.

**Run of 2026-11-19, registration before writes (D61)**, on a copy of `contracts/`, `shard/`,
`ledger/`, `flush/`, `janitor/`, `compact/`, `publisher/` and `engine/wasm/` in a scratch
directory, each mutant against the registration tests of the components named (the shard's are
in `scripts/mutants.mjs` as `D61:`; the others in `ledger/` and `janitor/`'s scripts):

| Mutant | Killed by |
|---|---|
| acknowledge before logged: a committed registration taken as logged | shard spec test 1 (both); flush "spec R1" |
| acknowledge before logged: a new stream accepted unregistered | shard spec test 1; flush "spec R1", "spec F6(b)" |
| an append parks on the registration instead of being refused | shard M-1 (both) |
| 429 instead of a retryable scope (`tenant`) | shard spec test 1, M-2 |
| a read naming a lost stream does not start and register a fresh one (as before D61) | shard spec test 3; flush "spec R1", "spec F6(b)" |
| an answer without `logged` (an older ledger) taken as logged | shard skew |
| no single-flight | **survived** the first run (appends alone cannot see it: `kick` has its own guard); killed after adding "concurrent reads … share one ledger call" |
| no cap on registration calls in flight (m-5) | shard m-5 |
| S5 not healed (m-7) | shard m-7 |
| the alarm does not retry registrations | shard spec test 1 (both) |
| a new stream's registration not rebuilt from storage | shard spec test 1, spec test 3 |
| R-10's pattern, updated for the new code (a read of a lost stream answers an empty `ok`) | shard.test.ts |

**11 of 11 D61 mutants killed** (one after a test was added), plus R-10 re-checked. The
ledger's and the janitor's D61 mutants are listed in their READMEs.

**Run of 2026-11-19, review M-5 (the base-pool rule shared with edge and control)**, on a copy of
the tree in a scratch directory outside git whose unmutated suite passed 87 of 87, against
`test/pool.test.ts` (`node scripts/mutants.mjs "names:"`): **3 of 3 new mutants killed**, and
the two older `names:` mutants run again, killed. "A base pool ending in /logs is valid" (the
suffix check narrowed to `/traces`): killed by "a base pool is a valid pool name that does not
end in a derived pool's suffix" and "the dedicated pool of every tenant id is a valid base pool,
except for the ids traces and logs". "A base pool may contain `_`" (`POOL_NAME` dropped from the
rule): killed by the first. "`dedicatedPool` keeps `_`": killed by "treats a dedicated tenant as a
pool of its own" and the second. The same rule is mutated from control's suite (control README,
94–97 and 144–145) and from edge's: edge's three base-pool mutants, pointed at
`../shard/src/pool.ts` in the copy, were killed by edge's own tests (a pool outside `POOL_NAME`,
and a base pool ending in `/traces` or `/logs`, refused with 503).

## Not implemented yet

- **Filtering span and log batches inside**: a span or log read gets every batch of its signal
  above the watermark whole; a time range does not skip any of them (only metric rows are
  filtered by time). Per-batch time bounds at append would let it skip batches.

- **Skipping stored batches without scanning them.** A filtered read decodes the series table
  of every batch above the watermark. Per-batch time bounds and metric names, written at append
  (a schema change and work on the append path), would let it skip batches outside the range.
- **Key ranges of a split that leaves labels out** (`sum without (…)`): the split key is then a
  hash of the other labels, not `series_id`; a filtered read cannot select it, and the
  coordinator keeps cutting such tails itself (`engine.splitTails`).
- **Regular-expression matchers** in the filter: only exact values, so a filter is a superset
  of what a query with `=~` selects (the engine still applies the query's matchers).

- **Map-epoch handover**: draining shards and moving fingerprints on a map change.
- **Registration before writes is OFF in production until release B** ("Rollout"): the
  default mode is `lazy`, so F6(b) stays possible for appends until edge maps `registering`
  and `SHARD_REGISTRATION` is `logged`. What IS on in every mode: reads and the janitor
  register a lost stream's fresh incarnation (spec F6 liveness, F16).
- **A forgotten registration is not re-registered** (review m-2). `stream.registered` is kept
  for ever; it can be wrong only if the ledger forgets a LOGGED registration, which the
  protocol never does: only a lost or replaced log (a tenant deleted and created again under
  the same id, a point-in-time restore of the ledger, a log looked for under another cell).
  None is built. Re-registering the same incarnation would not recover (the ledger would
  start it at 0 against the shard's recorded prefix: `not_contiguous` for ever), and starting a
  fresh incarnation drops the stream's unrecorded rows, a declared loss for an operator to
  decide. Out of scope, stated in DESIGN §4.3; the code before D61 is stuck the same way.
- **Streams are never retired** (review m-3). A read naming a lost stream, and the janitor,
  create a stream row and a ledger registration; nothing drops a stream. After a pool is
  retired the first query of each tenant that wrote there creates a stream in the retired
  shard, and every query wakes it. Not built because pool retirement and tenant deletion are
  not built; the fix is a stream-retirement change in the ledger (a new `LedgerChange` kind:
  a log format change, readers first, two releases), after which the read path no longer
  creates anything for a stream the ledger has dropped, and deletion must fence both paths.
- **Registration ahead of map changes and at tenant creation** (review m-4): `ensureStream`
  exists for it; the callers (the map-change procedure and tenant creation, in control/ and
  edge/) do not call it yet ("Needed changes elsewhere" 4). Until they do, every (tenant, new
  slot) pair is refused for about a second when senders first write to it.
- **Long-poll** (the review's suggestion that the ledger answer once logged): not done. The
  shard's backoff (250 ms, doubling) already makes one or two calls per stream, and the
  sender's `Retry-After` dominates the first acknowledgement.
- **CPU fairness.** Byte budgets and the in-flight limit are per shard; a tenant sending many
  tiny requests still shares the object's single thread with its neighbours. Not measured.
- **Tuning on Cloudflare.** The in-flight limit (64), pending bytes (16 MB) and group window
  (end of event) were chosen in workerd and confirmed, not tuned, on Cloudflare.

## Known risks

- **A filtered read costs the shard CPU in proportion to its whole tail** (above), once per
  query per shard, on the object that acknowledges appends. 22 MB took 30–140 ms here. A tenant
  with many concurrent queries over a large tail adds that much to its shard's thread each.

- **A sealing group's acknowledgement waits for the queue send**, and once per marker
  period for a KV write (`deliver` runs before the answers go out). Neither is R2; the S3
  re-run includes them. Moving them behind the acknowledgement is a small change if they
  measure slow.
- **The early refusal limit is per object, not per tenant**: a tenant flooding a shared
  shard gets other tenants refused as `overload` too (byte budgets stay per tenant).
- **A ledger that cannot log refuses its tenant's new streams without bound** (D61, mode
  `logged`): a new tenant cannot write, a shard that lost its storage takes nothing for that
  tenant, a map change stops the moved keys. Fails closed and retryable, reported (the alert
  after 60 s; `logStatus().registrationsPending`), and after R2 recovers the drain's backoff
  (up to 60 s) is added. Existing streams keep accepting, as before.
- **Whether concurrent calls into one Durable Object share its six outbound connections is
  not measured** (review m-5). The cap of 4 registration calls per shard keeps them within six
  with the seal notification (one queue send) and the marker (one KV write) either way.
- **The registration's round trip from a pooled shard to a ledger elsewhere is not
  measured**: a pooled shard serves tenants whose ledgers may be on another continent.

## Needed changes elsewhere

### Registration before writes (D61)

1. **Done (edge/README.md, "Registration before writes").** **`edge/`: answer `registering` with 503, never 429** (review M-2; must ship in release A,
   before anything sets `SHARD_REGISTRATION`). In `edge/src/route.ts`, where the per-shard
   results are folded (the loop over `results` that reads `scope === 'overload'`):

   ```ts
   // An overloaded shard, or a stream whose registration is not yet logged (D61), is a 5xx:
   // Remote Write senders MUST retry 5xx and MAY drop 429. A full buffer stays 429.
   if ((r as { scope: string }).scope === 'overload' || (r as { scope: string }).scope === 'registering') overloadMs = Math.max(overloadMs, r.retryAfterMs, 1)
   else retryAfterMs = Math.max(retryAfterMs, r.retryAfterMs, 1)
   ```

   and do NOT call `noteOverload` for `registering` (it is one stream, not the shard: the
   early refusal of the tenant's next request must stay keyed to overload). The answer is then
   `edge/src/index.ts`'s 503 with `Retry-After` (whole seconds, `retryAfter`), and the ruler's
   entrypoint (`edge/src/recorded.ts`) refuses it as `overloaded` (retryable). A message of its
   own ("ingest stream is being registered; retry the whole request") is better than
   "overloaded" if the outcome gets its own status. **Test** (`edge/test/overload.test.ts`):

   ```ts
   it('a stream being registered (D61) is 503 with Retry-After, never 429; nothing is stored; the retry once registered is stored once', async () => {
     const t = await tenant()
     const proto = Shard.prototype as unknown as { append: Shard['append'] }
     const real = proto.append
     let refuse = true
     proto.append = async function (this: Shard, req) { return refuse ? { status: 'backpressure', scope: 'registering', retryAfterMs: 700 } : real.call(this, req) }
     try {
       for (const res of [await postWrite(t.key, series(3)), await postOtlp(t.key, otlp(), 'application/x-protobuf')]) {
         expect(res.status).toBe(503)
         expect(res.headers.get('Retry-After')).toBe('1')
       }
       expect((await tailOfSlot(t.map, 0, t.tenant)).batches).toEqual([])
       refuse = false
       clearCaches()
       expect((await postWrite(t.key, series(3))).status).toBe(204)
       expect((await postWrite(t.key, series(3))).status).toBe(204) // a retry: stored once
       expect((await tailOfSlot(t.map, 0, t.tenant)).batches).toHaveLength(1)
     } finally {
       proto.append = real
     }
   })
   ```

   (in the file's `describe('an overloaded shard', …)`, whose `tenant()`, `series()` and
   `otlp()` it uses). Mutant: map `registering` like `tenant` (429): the test fails on the
   status. A Remote Write request split over two shards of which one refuses `registering`
   is refused whole (503) after the other stored its batch; the sender's retry is deduplicated
   by fingerprint, as for any partial refusal (contracts/BATCH.md).
2. **`query/`: no code change for R2.** The coordinator as built already learns a newer
   incarnation from `incarnation_mismatch`, re-plans, and reads a learned stream from 0; it
   answers a shard that names a LOWER incarnation as "behind the ledger" (503), which a fresh
   stream never is (it is started above the incarnation the read names). **Tests to add** in
   `query/test/fence.test.ts`, against the real coordinator (the same traces run in
   `flush/test/registration.test.ts` against a reader that follows `readTail`):
   - *spec F6(b)*: shard configured `{ registration: 'logged' }`; ingest (retry the request
     until 204); seal; `hooks.afterPlan` on the first attempt: flush the tenant until logged
     (`flushAll` and the ledger's `drain()`), then `deleteAll` and evict the shard; expect the
     exact answer, `Plan-Attempts` 2. Mutant: shard in mode `lazy`: the answer lacks the rows.
   - *spec F6 liveness*: ingest (registered, logged), do not flush, `deleteAll` and evict the
     shard; the query answers 200 (without those rows: the declared loss) with `Plan-Attempts`
     2, and the next query 1. Mutant: the shard's read path answering `incarnation_mismatch(0)`
     (as before D61): 503 after 4 attempts.
   The existing test "a shard whose stream was recreated … a shard behind the ledger is 503"
   is unchanged by D61 (it rewrites an existing stream's incarnation in memory; the read path
   creates a stream only when the shard holds none).
3. **Release B** (`stack/wrangler.jsonc` `vars`, or `deploy/workers.json` for viz-ingest):
   `"SHARD_REGISTRATION": "logged"`, only once release A (with item 1) is live everywhere and
   is the rollback floor (D46). Its release record must say that a rollback below A is
   refused.
4. **`control/` (or wherever pool maps are written) and tenant creation** (review m-4): call
   `ensureStream(tenant)` on every slot of the tenant's new pool map, and publish the map's new
   epoch only once each answers `registered: true` (retry while it does not; the shard's own
   backoff paces the ledger calls). Then a refusal happens only after a shard loses its
   storage.

### Filtered and paged tail reads (D48)

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
   until every `viz-ingest` version running sends it.
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
