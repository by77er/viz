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
| `src/tail.ts` | Filtered, paged tail reads (D48): the filter over stored `VZB1` batches (by signal since stage 2), the page cursor, `splitKeyRange`; `batchTimeBounds`, a span or log batch's time bounds read at append (D72); the two statements a filtered read runs (`PLAIN_TAIL_SQL`, and `TIMED_TAIL_SQL` for a ranged read that admits spans or logs) |
| `src/pool.ts` | Pool maps and routing: which slots a tenant may use, which slot a sender goes to; `validPoolName`; `validBasePool`, the one rule for a pool map's pool that edge reads maps with and control writes them with (D66); `dedicatedPool`; the derived pools of spans and logs (`signalPool`, `enabledSignals`) |
| `scripts/mutants.mjs` | Mutation check of the newer properties (runs only on a copy outside the git checkout) |
| `test/` | 120 tests in 13 files, run inside the Workers runtime, against the real ledger in the same script (`wrangler.test.jsonc`, `test/worker.ts`), as in viz-ingest |
| `bench/` | The counterfactual in workerd: this shard against the frozen as-built one (`bench/asbuilt/`, `dc2a1c3`); a 20 MB tail read whole and filtered (`tail.bench.test.ts`, results in `bench/results/tail.txt`); registration before writes (`registration.bench.test.ts`, against the release before it frozen in `bench/prereg/`; results in `bench/results/registration.log`); a span or log query against eight hours of tail, and appends against the release before D72 frozen in `bench/prebounds/` (`signaltail.bench.test.ts`, `walk.node.mjs`; results in `bench/results/signaltail.txt`) |

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
  further; the series fields select metric rows only, and the time range selects metric rows
  and (since D72, next item) skips span and log batches by their recorded bounds. A span or log
  batch the read admits is returned whole, as stored (its times are nanoseconds in columns of their
  own; the reader filters), unless the filter names `metrics`, `labels` or `keyRange`, which
  select series such a batch does not have: then it keeps nothing. A batch of any other
  signal is skipped when `signals` leaves it out and fails the read otherwise (never guessed
  at). A filter without `signals` has the same canonical text, so the same cursors, as before.
  A metrics query passes `signals: [1]`; query's span and log reads `[2]` or `[3]`. A shard of
  an earlier release ignores the field and throws on a span or log batch under a series
  filter, so callers still read only their signal's shards by name.
- **Time bounds of span and log batches** (D72, after review m-3 of
  `design/reviews/signals-end-to-end.md`, revised after its own review
  `design/reviews/d72-shard-bounds.md`; contracts/BATCH.md "Tail reads of spans and log records
  by time"). `append` reads a span batch's `start` column or a log batch's `ts` column once
  (`batchTimeBounds`: the entry table is walked by its length fields to the column, which is
  scanned as u32 pairs, exactly; no decoding, no strings) and stores the floor in milliseconds of
  the smallest and largest value in the batch's row (`batch.min_ts`, `batch.max_ts`), which the
  partial index `batch_time` also holds. The walk accepts only BATCH.md's layout: `flags` and
  `reserved` zero, at least one entry, zero padding around the `entry` column (review m-1). Any
  other batch, a metric batch, an empty one and one whose lengths do not lead to a whole column
  inside it (or that holds a negative time) get NULL and no index entry; the append is never
  refused for that. A filtered read with `minTs`/`maxTs` skips, in its SQL, every batch whose
  bounds lie wholly outside the range, **deciding from the index, not the row**
  (`TIMED_TAIL_SQL`, `INDEXED BY batch_time`): the bounds follow the payload in the row, so reading
  them there read every skipped batch's payload from storage (review M-1; 33 MB to skip 48 batches,
  now 20 KB). **Only a read that can skip something runs that statement** (re-check of D72, r2-m-2):
  one with a time range that admits span or log batches (no `signals`, or 2 or 3 listed;
  `CompiledFilter.byBounds`). A ranged read that admits only metric batches (a metrics query's
  `signals: [1]`) runs the statement every filtered read ran before D72 (`PLAIN_TAIL_SQL`): no
  metric batch has bounds, so it could skip nothing, it examines every batch as before, and it
  reads one row per batch, not two (the cost in rows read is under "How it was verified"). It does
  not use the index at all. Every batch with NULL bounds is kept: rows from before schema 3, rows
  written by the
  release before after a rollback, rows the walk does not accept. One call considers at most
  `tailScanMaxBatches` (32,768) batches, skipped ones included, and examines at most
  `tailScanMaxBytes`; a page may hold no batch and continue. Cursors (the range is part of the
  filter they are bound to), `through`, the fence and every refusal are D48's; a skipped batch is
  not examined (`scannedBatches`/`scannedBytes` leave it out); `page_limit` names only a kept batch
  and carries `last` (review n-1): true when no batch after it up to `through` can be kept by its
  bounds (for a read that admits only metric batches, which looks at no bounds: only when it is the
  tail's last batch; "Contract issues" 2). A trace query must send the bound it reads spans in
  (its window widened by
  `traceMarginMs`, D62) as `floor(lo / 10⁶)`, `floor(hi / 10⁶)`; then every batch holding a span
  that starts inside the bound is returned (tested, below).
- **Configuration is checked** (re-check of D72, r2-m-3). `configure` refuses the whole call
  (it throws, naming the field; nothing is changed or stored) when a field is unknown or its value
  breaks its rule: sizes and counts (`maxBatchBytes`, `sealBytes`, `tenantMaxBytes`,
  `shardMaxBytes`, `seriesWindowMs`, `seriesExactMax`, `maxGroupBytes`, `tailScanMaxBatches`,
  `registerTimeoutMs`, `maxRegistrations`) are safe integers of at least 1; durations and the three
  limits whose 0 has a meaning (`maxInFlight` and `maxPendingBytes`: refuse every append,
  retryably; `tailScanMaxBytes`: examine nothing per call) are safe integers of at least 0;
  `registration` is `lazy` or `logged`. `undefined`, `NaN`, an infinity, a non-integer, a negative
  and a non-number break every numeric rule. A stored configuration is read the same way: a known
  field whose stored value breaks its rule takes the default (a field this release does not know
  is carried unchanged). Before this the object used whatever it was given, and
  `tailScanMaxBatches: undefined` or `NaN` made every filtered read answer a complete, empty `ok`
  over a tail that held rows.
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
  version 3 through `contracts/schema.ts`: version 1 adopts the pre-versioning schema
  unchanged and adds `segment.sealed_at` to objects created before it; version 2 (D61) adds
  `stream.registered` (additive, `readableFrom` 1: the release before ignores it and never
  changes a stream row's incarnation, so what this release wrote stays true and its 0 is
  only conservative); version 3 (D72) adds `batch.min_ts` and `batch.max_ts` (nullable, additive,
  `readableFrom` 1: the release before names its columns when it inserts, so its rows get NULL,
  which every time range keeps; nothing is backfilled and nothing relies on a value being there)
  and the partial index `batch_time` over them (review of D72, M-1; SQLite maintains it for every
  writer, the release before included, whose rows get no entry). Built over schema-2 rows it writes
  nothing and reads each row's header, which lies in the table's leaf page: for batches larger than
  a page that is all it reads, but a batch under about 4 KB sits whole in that page, so over a tail
  of small batches the build reads the table (re-check of D72, r2-n-2; the figures are under "How
  it was verified"). Migration 3 had not shipped when the index was added to it.
  Storage of a newer release is
  refused: `append` answers retryable `overload`, every other method throws
  `schema_too_new`, nothing is written, the alarm is re-armed. The series-window bucket
  carries a format byte (`SKETCH_FORMAT`); a bucket of an unknown kind or version is not
  read as something else: that tenant's metered appends are refused (retryable) rather than
  counted against an empty window. The flush message carries `v` (`FLUSH_MESSAGE_VERSION`).
  Goldens: `test/golden/schema/v1.json`, `v2.json`, `v3.json`, `test/golden/formats/series-window.v1.json`,
  `queue.flush.v1.json`.

## Reservations: room for a request before it appends (D77, 2026-11-28)

S10 measured on Cloudflare that a request whose batches go to two shards could be answered 429
after one shard had appended its half (`spikes/s10-signals-trial/README.md`). The shard's part of
the fix (edge's is in `edge/README.md`, same heading; the contract in `contracts/BATCH.md`, "What a
refusal stored"):

**Implemented.**
- `reserve({ tenant, epoch, batches: [{ fingerprint, bytes }], hold? })`: the checks an append makes
  for epoch (`stale_epoch`), size (`too_large`), registration in mode `logged` (`registering`, D61),
  load (`overload`, D37) and room (`tenant`, `shard`), for the batches together and with no await.
  Batches the stream holds (a row with that fingerprint) or has waiting in the open group need no
  room. Admitted: their bytes are held under a random token, counted against the tenant's cap, the
  shard's budget and fair share (their sum), and against the in-flight limits as **one append of the
  largest batch** (each live grant is one of `maxInFlight`, and its largest batch counts in
  `maxPendingBytes`: its batches arrive one at a time; review of D77, M-1), until each batch is
  appended with the token, the token is released, an append under it is refused or throws (the rest
  is dropped: M-2), or `reservationTtlMs` (new config field, default 5,000 ms) passes since its last
  use (m-3). At `reserve` a tenant holding nothing, or whose first batch fits its fair share, is
  admitted whole within its cap and the 2x ceiling (m-1); every tenant holding anything, a grant
  included, counts as a sharer (m-2). `hold: false` answers without holding anything (edge's probe
  before decoding), and for a tenant with no stream creates none (n-1).
- `append` with `reservation`: a live grant of this tenant that names the batch's fingerprint, with
  at least its bytes, admits it without the load and room checks; the batch is taken out of the
  grant whatever then happens (stored, duplicate, refused for epoch or series). Any other token is
  ignored and the append is admitted as one without a token.
- `release(tenant, token)`; `stats()` gains `reserved`, `refusedReserve`, `reservationsExpired`,
  `reservations`, `reservedBytes`.
- **Memory only, nothing stored.** Grants are a hint about room, as the open group and the
  in-flight count are (D37): nothing in them is acknowledged, they are not rebuilt after an
  eviction, and expired ones are dropped lazily on the next call (no alarm). A grant adds no SQLite
  row (measured below). The private registration-slot `release()` was renamed `releaseRegSlot()`.

**Not implemented.**
- Grants do not survive an eviction or restart. An append whose grant was lost is admitted as one
  without a token; if refused there, edge answers 503 (BATCH.md).
- `reserve` does not look at active series (it gets no `seriesIds`): a metered append can still be
  refused `series_limit` (stores nothing for that batch, by design) or `overload` for an unreadable
  window after its grant.
- No per-tenant limit on grants beyond the room they hold; a caller that reserves and never appends
  holds that room for at most `reservationTtlMs`.

**Verified** (local workerd, the Workers test runtime): `test/reserve.test.ts`, 10 tests: a grant
holds room against the tenant cap (another request and an append without a token are refused it,
another tenant is not, stats count it until it is used, a used-up token admits nothing); a refused
reserve holds nothing; grants count in the shard-wide budget; duplicates and twins need no room; a
probe holds nothing; release, and tokens of another tenant, another fingerprint or fewer bytes;
expiry; granted appends are not refused for load and grants count in the in-flight limit; stale
epoch, too large, registering, a malformed call; and the eviction case with `evictDurableObject`
(the grant is gone, nothing stored changed, the appends are admitted as without a token).
`test/bounds.recheck.test.ts` counts the new configuration field. Results and mutants:
"How it was verified", "Reservations (D77)".

**Risks.** A shard restarted between `reserve` and `append` turns a would-be 429 into a 503 with
part of the request stored (S15 measures how often on Cloudflare). A grant counts one append slot
and one batch of bytes for as long as it lives, and a second while one of its batches waits in the
group, so up to `maxInFlight` concurrent multi-batch requests share a shard's 64 slots: a small
request can be refused `overload` while many large ones are in their sequences.

## Recorded payloads give way to appends (D82, 2026-11-28)

S10 measured on Cloudflare a tenant's span shards refusing every append for about 33 s after a burst
(`spikes/s10-signals-trial/README.md`, "Ingest"). The cause was here: a recorded segment's payloads
are kept `retainRecordedMs` (30 s) so in-flight queries can still read them, and they counted against
the tenant's 64 MiB like unflushed rows, so a tenant could sustain at most about 64 MiB / 30 s per
shard however fast flush was (`design/DECISIONS.md` D82).

**Implemented.** `Stream.retainedBytes`: payload bytes of recorded batches not yet discarded, kept by
`recorded()`, the alarm's discard and the reclaim, and rebuilt from SQLite in `load()`. An append or a
`reserve` that `roomCheck` would refuse first discards recorded payloads (`discardRecorded`: for the
tenant's cap, the tenant's own; for the shard's budget, every tenant's), with the same statements as
the alarm (`discardThrough`: the fence first, in the same synchronous block), then is judged again. No
await between the check, the discard and the second check. A reader that planned before the discard
gets `stale_watermark` and re-plans. Unrecorded rows count in full; what was given up is counted in
`stats().reclaimedBytes`. `describe()` shows `retainedBytes`.

**Verified** (local workerd): `test/reclaim.test.ts`, 7 tests: a tenant whose cap is held by recorded
payloads is admitted and a stale reader re-plans; sealed-but-unrecorded rows still refuse, and a
refusal after a reclaim leaves what was given up given up; another tenant's payloads are never given
up for a tenant's own cap; for the shard's budget any tenant's are; `reserve` is judged the same way;
the count survives `evictDurableObject`; the alarm's discard keeps it right. Mutants: below
("Mutants of D82"). On Cloudflare (S18, `spikes/s18-signals-write/README.md`): one tenant 28,800
spans/s for 68 s with 5 of 245 attempts 429; the paced shape that S10 refused 99 of 149 attempts of,
none.

**Risks.** Under pressure, queries of a tenant at its cap re-plan more often. The reclaim gives up all
of a tenant's recorded payloads at once, not the oldest first (simpler; they are all already in the
log). Fair share between tenants when one reclaims another's for the shard's budget was not measured
on Cloudflare (S18 ran one tenant).

### Mutants of D82

Not run yet (paused 2026-11-28); see `spikes/s18-signals-write/README.md`, "Paused".

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
npx vitest run --maxWorkers=2   # 120 tests in workerd, 13 files (2026-11-26, after the re-check of D72)
npx tsc --noEmit                # clean
node scripts/mutants.mjs        # on a copy outside the git checkout (see the script)
npm run bench                   # the workerd counterfactual (bench/)
BENCH=tail npm run bench        # a 20 MB tail, read whole and filtered
BENCH=registration npm run bench  # registration before writes (D61)
BENCH=signaltail npm run bench    # a span or log query against eight hours of tail; appends (D72)
node --experimental-strip-types --no-warnings bench/walk.node.mjs   # the bounds walk alone (Node)
node --experimental-strip-types --no-warnings bench/skipread.node.mjs  # where the bounds are kept: bytes read to skip, rows written (workerd)
```

**Last run, 2026-11-26, after the re-check of D72
(`design/reviews/d72-shard-bounds-r2.md`): 120 passed, 0 failed (13 files); `tsc --noEmit` clean.**
Run on the working tree after commit `cb527dc`, with this change not yet committed as a whole
(snapshot commits made while it was written carry parts of it: `cb527dc` has `src/tail.ts` and the
read's choice of statement, not the configuration check, the tests, `scripts/mutants.mjs` or this
file). Before the change, same tree: 109 of 109. The components that call the shard's tail read or
`configure`, same tree after the change, one suite at a time with `npx vitest run --maxWorkers=2`:
**query 173 passed (20 files); stack 50 passed, 1 skipped (11 files)**; edge 133 (13 files); flush
59 (7 files); janitor 33 (5 files); `npx tsc --noEmit` clean in stack and in query. Not run: the
gateway suite, the benches (`npm run bench`, `BENCH=…`), and anything on Cloudflare.

- **The re-check of D72** (`test/bounds.recheck.test.ts`, 11 tests; 2026-11-26):
  - *r2-m-1, tenants in one shard* (2; the first adopted from the reviewer's block C): two tenants
    in one traces shard with the same sequence numbers and opposite times. Each ranged read
    returns its own batches only (`A` hour 0: 1 and 3; `A` hour 5: 2; `B` hour 0: 2; `B` hour 5:
    1), with and without `signals`; `page_limit.last` counts only the reader's own batches; the
    index holds five entries and agrees with the rows; the same after an eviction. The same shape
    for log batches, and for a metrics-only ranged read of a shared metrics shard (the plain
    statement).
  - *r2-m-2, rows read* (2): the table below. The count is the `rowsRead` of every cursor the read
    itself opened (the test wraps the object's `sql.exec` for the length of one `tailRead`, on the
    live instance and on the release before D72 run over the same storage), and the test also
    checks which statement ran.
  - *r2-m-2, a read that admits only metric batches* (4), in a stream mixing the three signals
    (not what edge writes): a `signals: [1]` ranged read examines all 18 batches and returns what
    the release before D72 returns on the same storage, the whole page compared (batches byte for
    byte, `through`, `scannedBatches`, `scannedBytes`, `next`); a range that cuts a batch keeps
    only the rows inside; a read that admits spans or logs as well (`[1, 2]`, `[1, 3]`, `[2, 3]`,
    `[2]`, `[3]`, none) still skips the eight bounded batches outside the range unexamined; 84
    paged reads (batch windows of 1, 2, 5, 17, 18, 19 and 32,768; a scan budget of 1 byte and of
    32 MiB; three page sizes; with and without an eviction between pages) return the same rows,
    every cursor naming a later batch, `through` fixed, no call examining more than its window; a
    cursor of another range or of other signals is `invalid`; a later append is not in the read;
    `page_limit` says `last` only for the tail's last batch; with the index `batch_time` dropped
    the metrics-only read answers the same, while a span read with a range throws (`no such index`)
    and never falls back to the rows.
  - *r2-m-3, configuration* (3): `tailScanMaxBatches` given as `undefined`, `NaN`, 0, −1, 1.5, ±∞,
    2^53, a string, `null`, `true` or an object is refused each time, and after each a ranged read,
    a filtered read without a range and the unfiltered read all return the three batches (the
    review's reproduction returned none), also after an eviction; a call with one bad field
    applies none of its fields; an unknown field and a configuration that is not an object are
    refused. Every one of the 24 numeric fields refuses those eleven values, the ten sizes and
    counts refuse 0 as well, and `registration` refuses seven values that are not `lazy` or
    `logged` (281 refusals, nothing changed by any). The fourteen fields that take 0 take it, and
    0 does what the README says: `tailScanMaxBytes` 0 answers an `ok` without a batch whose `next`
    is not null, `maxInFlight` 0 refuses an append as `overload`. A stored configuration holding
    `null` (what `NaN` was stored as), 0, a negative, a non-integer, a string, an object, an array
    or `true` for the window is read with the default; a valid stored value and an unknown stored
    field are kept.
- **Rows read by a ranged read, measured here** (local workerd, 2026-11-26, the cursor's
  `rowsRead`, one run; the numbers are counts, the same on every run of the test; tails of 200
  batches of one row each). How Cloudflare counts and bills these lookups is **not measured**.

  | Read of a 200-batch tail | The release before D72 (frozen, same storage) | As reviewed at `afd0deb` | This change |
  |---|---|---|---|
  | metrics, `signals: [1]`, a range holding every batch (200 returned) | 200 | 400 | **200** |
  | metrics, `signals: [1]`, a range a day before the tail (0 returned, 200 examined) | 200 | 400 | **200** |
  | metrics, `signals: [1]`, no range | 200 | 200 | 200 |
  | the same metric tail, `signals: [1, 2]` or no `signals`, a range | not run | 400 | 400 |
  | spans `[2]` or logs `[3]`, no range (200 returned) | not run | 200 | 200 |
  | spans or logs, a range holding every batch (200 returned) | 200 | 599 | 599 |
  | spans or logs, a range holding the first 100 (100 returned) | not run | 500 | 500 |
  | spans or logs, a range a day before the tail (0 returned) | 200 (it returns all 200, reading every payload) | 400 | 400 |

  The `afd0deb` column: for the metric tail it is `TIMED_TAIL_SQL`, which that commit ran for
  every ranged read, run over the same batches in the same test (the re-check's block K measured
  the same 400); for spans and logs it is this change's own figure, whose span and log path is the
  reviewed one (block K: 599 and 400). So: **a metrics-only read reads one row per batch, as before
  D72. A span or log read with a time range reads 2 rows per batch it skips and 3 per batch it
  keeps** (2 for a kept batch without bounds: workerd counts the lookup in `batch_time` also when
  it finds no entry), where it read 1 per batch before D72 and reads 1 without a range; one call considers at most
  `tailScanMaxBatches` batches, so at most about 98,000 rows (modelled: 3 × 32,768). What it buys
  is in the tables below: the skipped batches' payloads are not read (20 KB instead of 33 MB to
  skip 48 batches) or returned. **Modelled**, at the list price recorded in
  `research/02-cloudflare-compute-platform.md` ($0.001 per million rows read past 25 billion a
  month): one more row per batch considered is $1 per billion batches considered. The re-check's
  example (its workload is invented: 100 queries a second over 4 shards of 100 tail batches, 104
  billion batches considered a month) is about $104 a month, which is what metrics queries no
  longer pay and what span or log queries of that volume would pay once or twice over. The
  experiment that settles it: the same reads against a deployed shard, rows read taken from
  Cloudflare's analytics API (`design/VERIFICATION.md` §4).
- **What migration 3 reads when it builds `batch_time`** (re-check of D72, r2-n-2; the reviewer's
  `migrate.py`, Python's SQLite 3.53.1, **not workerd's**; bytes are the process's `rchar` and were
  identical in the reviewer's run and in one run here, times are the range of the two; tails at
  schema 2, all rows without bounds, so no entry is written):

  | Tail at schema 2 | Read by the migration | Time |
  |---|---|---|
  | 48 batches of 0.4 to 1 MB (34.5 MB) | 0.15 MB | 7–18 ms |
  | 2,000 of 20 KB (40 MB) | 8.2 MB (one page per row) | 10–16 ms |
  | 20,000 of 2 KB (40 MB) | 41.1 MB (the whole table) | 17–23 ms |
  | 200,000 of 200 B (40 MB) | 48.2 MB | 32–85 ms |

  So "it reads the rows' headers, not their payloads" holds only for batches larger than a page;
  a payload under about 4 KB sits in the page with its row's header. **Modelled** from those
  rows (linear in the tail, the file in the operating system's cache): `shardMaxBytes` (512 MiB)
  of such small batches takes about 0.2 to 1.1 s, inside the 30 s of COMPATIBILITY §2.2. Not
  measured in workerd or on Cloudflare.

**The run before it, 2026-11-26, after the review of D72: 109 passed, 0 failed (12 files); `tsc
--noEmit` clean.** Run on the working tree at commit `76e065b` with this change's later edits to
`src/tail.ts` (comments), `README.md`, `bench/` and `scripts/mutants.mjs` uncommitted; `shard/`'s
code and tests are as in `76e065b`, whose snapshot carries them (review m-7: the runs below this one
are tied to no commit). Stack, same tree: `npx tsc --noEmit` clean; `npx vitest run --maxWorkers=2`
50 passed, 1 skipped (11 files); the gateway suite 4 of 4.

- **The review of D72** (`design/reviews/d72-shard-bounds.md`; 2026-11-26):
  - *M-1, deciding a skip* (`bounds.test.ts` "deciding a skip, and what one call reads"): the
    index `batch_time` holds the bounds of exactly the span and log batches that have them (not a
    metric batch, not one the walk refuses) and is partial; the read's plan uses it as a covering
    index, and `TIMED_TAIL_SQL` never names the payload in its WHERE (there it would read every
    row's record: 140 KB instead of 20 KB, measured below). With `tailScanMaxBatches` 3 a hull
    read and an unranged read return the same batches as one call, each page only from its own
    three batches, some pages empty and still moving on.
  - *n-1*: `page_limit` carries `last` true when only skipped batches follow, false when a kept one
    does, false without a range unless the batch is `through`, false when the look stops at the
    batch window.
  - *m-1* (`bounds.test.ts` "a batch of a layout the walk does not know…", and
    `bounds.edge.test.ts` R2): flags 1, reserved 0x80 at 6 and 7, a non-zero byte in the padding
    before and after the `entry` column, `n_entries` 0 with rows (twice, once with every other
    byte zero): no bounds, the engine's strict decoder refuses each too, stored and kept by a range
    holding none of their times. The review's modelled later layout (flag 1, a u64 after the entry
    table): no bounds, and a read of exactly its last row's millisecond returns it (it returned
    nothing before); the same bytes with the flag cleared still get wrong bounds, which is why
    BATCH.md requires a later layout to signal itself.
  - *m-6* (`bounds.edge.test.ts`, adopted from the review's R1 and R5b): 180 random OTLP/JSON
    traces, OTLP/JSON logs and Loki push requests with adversarial content, decoded and encoded by
    edge's own code: the walk equals the engine's flush on every batch, none unbounded; a batch at
    the entry limits; the most expensive shapes edge builds for the walk (every span its own
    resource of 128 attributes; every record its own stream), near 1 MiB.

- **Time bounds of span and log batches** (`test/bounds.test.ts`, 11, D72). Span and log batches
  come from the engine's test encoder (no code shared with the shard or edge; a resource
  attribute of type 5 is patched in, which that encoder cannot write), and bounds are checked
  against the engine's flush (`encodeSpans`/`encodeLogs`: the files' `minNs`/`maxNs`), an
  independent reader:
  - *recorded at append*: six span and six log batches of up to 40 rows over an hour each, plus
    one whose times lie in one millisecond and one straddling a millisecond by a nanosecond:
    the stored bounds equal the flush's floors, after an eviction; a metric batch has none; 150
    random batches (1 to 3 entries, every attribute type, times from 0 to 2^63 − 1, on and next
    to millisecond edges) give the flush's bounds; a batch cut inside its entry table, one with a
    negative start, one whose `n_rows` the batch cannot hold and an empty one are stored with
    none, accepted, and kept by a hull that holds none of their times;
  - *read by a hull*: a six-hour span tail of twelve batches of this release and two written by
    the release before (frozen) in between: for 161 hulls (each bounded batch at both edges,
    touching and one millisecond off, 60 random ones, open-ended ones, far ones) the read returns
    exactly the overlapping batches and every unbounded one, in order, byte for byte;
  - *traces (D62)*: 200 random nanosecond bounds (on, one below and one above span starts, and
    anywhere), passed as `msRange` passes them: every span starting inside a bound is in a
    returned batch (the test requires more than 500 such span and bound pairs);
  - *logs*: 100 random bounds over ten batches: every record inside is in a returned batch, and
    the batches returned are exactly the overlapping ones; without a range every batch;
  - *signals with a hull*: in a stream mixing the three signals, `[2]`, `[3]` and `[2, 3]` keep
    only their overlapping batches; `[1]` keeps metric rows by `ts`, which the engine selects as
    from the metric batches alone; no `signals` applies each rule to its own signal;
  - *pages and refusals*: the same batches at page sizes of one and two batches; skipped batches
    are not counted as scanned; the scan budget (one batch a call) continues correctly; a cursor
    of another hull, or of no hull, is `invalid`; the same after eviction; `page_limit` names the
    first KEPT batch, not a larger skipped one; a discard between pages is `stale_watermark`, as
    is a read below the fence; another incarnation is `incarnation_mismatch`;
  - *rollback*: storage this release wrote (schema 3) is opened by the release before D72
    (frozen, `bench/prebounds/`, at `fd4b75a`) on the same storage without lowering its version;
    it serves every span batch whole whatever the hull, takes appends, seals and serves the
    segment to flush; after the roll-forward its batches have no bounds and every hull keeps
    them, this release's are still skipped by bounds, and new appends are bounded again;
    *upgrade*: storage at schema 2 made by that release migrates to 3 once (rows unchanged,
    bounds NULL, served, kept by every hull; not migrated again on the next open).
  - The D61 rollback test now expects the current schema version (3), and the adoption test checks
    that adopted rows have no bounds.
  - **Stack** (which bundles the shard), 2026-11-19 after this change: `npx vitest run
    --maxWorkers=2` 50 passed, 1 skipped (11 files); the gateway suite 4 of 4. Its `tsc --noEmit`
    failed in the shared tree on two lines of `publisher/src/log.ts`, which another builder had
    uncommitted edits in at the time; on a scratch copy with the committed publisher and this
    shard it was clean.
- **Measured here** (local workerd, 2026-11-19, three runs at load average 3.0 to 3.9;
  `bench/results/signaltail.txt`): eight hours of tail, one batch per ten minutes of start time,
  48 batches; spans 18.74 MB (1,500 spans a batch, about 300 B each), logs 16.79 MB (2,000
  records a batch). Before any bytes were compared, each read held, byte for byte, every batch
  in which the engine's flush finds a row inside the read's nanosecond bound, and only batches of
  the tail. Times are medians of five reads around the RPC calls, in one process.

  | One-hour query (04:00 to 05:00) | Batches | Bytes the shard returns | Read (median, three runs) |
  |---|---|---|---|
  | spans, before: what query sends today (`signals` only) | 48 | 18,736,064 (over `maxFetchBytes`, 16 MiB: refused) | 25–35 ms |
  | spans, after: span-local query (tags, span-local metrics), the hour | 6 | 2,343,888 | 8 ms |
  | spans, after: search, whole-trace metrics, by ID with a hint: the hour ± 2 h margin | 30 | 11,719,440 | 19–22 ms |
  | spans, after: an hour a day before the tail | 0 | 0 | 5–6 ms |
  | logs, before | 48 | 16,791,072 (over 16 MiB: refused) | 19–31 ms |
  | logs, after: the hour | 6 | 2,100,928 | 8 ms |
  | logs, after: an hour a day before the tail | 0 | 0 | 4–5 ms |

  Appends, as a counterfactual: the same 96 batches (35.5 MB) appended one after another to this
  release and to the release before (frozen), three runs alternating which goes first, each
  checked to have stored exactly what it was sent: 362–457 ms against 369–497 ms for the 96,
  median 3 ms each on both; no difference beyond the spread. Nothing was tuned. The walk alone,
  timed in Node 22 (workerd's clock does not move during synchronous work): 7.5–35 µs per batch of
  0.4 to 1 MB, 0.3–1 µs for a one-row batch (typical shapes only: up to 1.5 ms for edge's worst,
  review m-4, below). What these do not show: the bytes and times are for a
  tail whose batches each cover ten minutes; batches whose spans span hours (late senders, long
  spans) skip less. On Cloudflare the reads and the walk over SQLite's overflow pages to the
  bounds are not measured (experiment: the same tail and reads against a shard on Cloudflare, from
  a query Worker).
- **Measured here after the review of D72** (2026-11-26):
  - *Where the bounds are kept* (`bench/skipread.node.mjs`, local workerd through a Durable
    Object, three runs, identical in bytes, `bench/results/skipread.txt`; every layout returned the
    same batches for every read). Bytes: what the workerd process read (`rchar`) during one read
    after SQLite's page cache was filled with other pages. 48 batches of 0.4 to 1 MB:

    | Layout | Rows written per append (bounded / not) | Skip all 48 | One hour (8 kept) | Everything |
    |---|---|---|---|---|
    | as first built: in the row, after the payload | 3 / 3 | 33,004 KB, 7–10 ms | 37,532 KB | 65,870 KB |
    | **partial index `batch_time` (built)** | **4 / 3** | **20 KB, under 1 ms** (0.05–0.09 warm) | 4,568 KB | 33,006 KB |
    | the same, `payload IS NOT NULL` in the WHERE | 4 / 3 | 140 KB | 4,668 KB | 33,006 KB |
    | full covering index | 4 / 4 | 16 KB | 4,564 KB | 33,002 KB |
    | table of bounds | 4 / 3, and 2 rows per discard | 20 KB | 4,568 KB | 33,007 KB |
    | bounds before the payload (table rebuilt) | 3 / 3 | 136 KB | 4,664 KB | 33,002 KB |

    2,000 batches of about 200 B: skipping all read 580 KB as first built and 176 KB as built now,
    but took 1.3 ms warm against 0.3–0.7 ms (about 0.65 µs per batch for the index lookup). Why the
    partial index: D72 in `design/DECISIONS.md`. Billed: one more row written per span or log
    append (modelled at list price: $1.00 per million such appends past the included 50 million
    rows a month); none per metric append. Rows READ, which are billed too: one or two more per
    batch a span or log read with a time range considers, none more for a metrics read (measured
    here and modelled above, "Rows read by a ranged read"; the bench's own `rowsRead` in
    `bench/results/skipread.txt` shows the same: 50 as first built, 100 and 147 as built).
  - *End to end* (`BENCH=signaltail`, this change against the first build from a scratch copy at
    `cd41a86`, alternating, two runs each, load average 8 to 11; `bench/results/signaltail.txt`):
    an hour a day before the tail 4–9 ms → 1 ms; the hour 6–10 → 3 ms; the hour with the margin
    20–26 → 15–18 ms; appends of the 96 batches against the release before D72: 582–737 ms against
    455–1,004 ms, no difference beyond the spread. Each read held every needed batch, byte for byte.
  - *The walk* (`bench/walk.node.mjs`, Node 22, three runs; review m-4): 10–25 µs for typical 0.4 to
    1 MB batches; **1.27–1.49 ms** for the worst shape edge builds (1,289 resources of 128
    attributes, a span each, 1 MiB) and 0.19–0.23 ms for 12,465 one-label streams; shapes edge never
    builds up to 2.4 ms. Linear, paid once per append by the sender's own bytes: documented, not
    capped (a cap would only switch skipping off for such senders; D72 (i)).

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

**Run of 2026-11-19, time bounds of span and log batches (D72)**, on a copy of `contracts/`,
`shard/`, `ledger/{src,bench}` and `engine/wasm/{js,test}` in the session's scratch directory
(outside git) whose unmutated suite passed 98 of 98; `node scripts/mutants.mjs "D72:"`, each
against `test/bounds.test.ts` (the migration's against `test/compat.test.ts`): **13 of 13
killed**.

| Mutant | Killed by (`bounds.test.ts` unless named) |
|---|---|
| hull lower edge off by one (`max_ts > minTs`) | "returns exactly the batches whose bounds overlap the hull…"; "traces (D62): every span that starts inside a nanosecond bound…" |
| hull upper edge off by one (`min_ts < maxTs`) | the same two |
| recorded min one ms late | "a span or log batch's row holds the floor in ms…"; "random batches…: the walk agrees with the flush" |
| recorded max one ms early | the same two |
| recorded bounds rounded up, not floored | the same two |
| old rows (no bounds) dropped instead of kept (`min_ts IS NULL OR …` removed) | "a batch the walk cannot follow is stored without bounds…"; "returns exactly the batches…" |
| the signal filter ignored (`signals` check removed from `filterBatch`) | "signals still choose batches when the read has a hull…" |
| span bounds read from `end`, not `start` | "a span or log batch's row holds the floor…"; "a batch the walk cannot follow…" |
| log bounds read from `observed_ts`, not `ts` | "a span or log batch's row holds the floor…"; "random batches…" |
| a type-5 resource attribute not walked | the same two |
| a batch the walk cannot follow refuses the append (throws) | "a batch the walk cannot follow is stored without bounds, and accepted…" |
| bounds computed but not stored (nothing skipped) | "a span or log batch's row holds the floor…"; "returns exactly the batches…" |
| migration 3 adds no column | `compat.test.ts` "a fresh shard records shard.Shard at the latest version…", "adopts dc2a1c3 storage…" |

Run again on the same copy because their code moved: the twelve `tail:` mutants (11 killed; "values
copied as numbers" survives, as before, equivalent: above), "group commit: an append is answered
before its group commits" (its pattern re-anchored to the new `Pending` field; killed) and the three
`versions:` mutants (killed). The other mutants of the script were not re-run for this change.

**Run of 2026-11-26, the review of D72** (`design/reviews/d72-shard-bounds.md`), on a copy of
`contracts/`, `ledger/`, `edge/src/` and `engine/wasm/{js,test}` at `e90eee1` and this `shard/`, in
the session's scratch directory (outside git), whose unmutated suite passed 109 of 109;
`node scripts/mutants.mjs "D72"`, each against `test/bounds.test.ts` and, where named,
`test/bounds.edge.test.ts` or `test/compat.test.ts`. The thirteen D72 mutants above, three of them
re-anchored to the new SQL (both hull edges and "old rows dropped": now `t.max_ts <= ?`,
`t.min_ts >= ?`, and `b.min_ts IS NOT NULL` added to `TIMED_TAIL_SQL`): **13 of 13 killed**. The
review's: **13 of 13 killed**, one after a test was added.

| Mutant | Killed by (`bounds.test.ts` unless named) |
|---|---|
| M-1: migration 3 creates no index `batch_time` | `compat.test.ts` golden; every ranged read ("a batch the walk cannot follow…", others: `no such index`) |
| M-1: the index not partial (metric appends write an entry) | `compat.test.ts` golden; "the decision is made from the partial index…" |
| M-1: the skip decided from the row, as first built | "the decision is made from the partial index…" (the plan) |
| M-1: `payload IS NOT NULL` in the timed WHERE | the same (its WHERE) |
| M-1: no per-call batch window | "one call considers at most tailScanMaxBatches batches…" |
| M-1: a call ending at its window does not continue the read | the same |
| m-1: flags and reserved not checked | "a batch of a layout the walk does not know…"; `bounds.edge.test.ts` R2 (both) |
| m-1: reserved not checked (flags only) | the same |
| m-1: padding before the `entry` column not checked | "a batch of a layout the walk does not know…" |
| m-1: padding after the `entry` column not checked | the same |
| m-1: a batch with rows and no entry walked | **survived** the first run (the test's only such batch was also caught by the padding check); killed after adding one whose other bytes are all zero |
| n-1: `page_limit` always says `last` | "page_limit says whether its batch is the last…" |
| n-1: a look that stops before `through` says `last` | the same |

The twelve `tail:` mutants (one re-anchored to the new `page_limit`) and the three `versions:`
ones, run again on the same copy because `tailPage` and migration 3 changed: 11 of 12 and 3 of 3
killed; "values copied as numbers" survives, equivalent, as before. The other mutants of the
script were not re-run for this change (no code they target moved).

**Run of 2026-11-26, the re-check of D72** (`design/reviews/d72-shard-bounds-r2.md`), on a copy of
`contracts/`, `ledger/`, `edge/src/`, `engine/wasm/{js,test}` and this `shard/` in the session's
scratch directory (outside git; the shared tree was never mutated), whose unmutated suite passed
120 of 120 and whose sources equalled the tree's before and after. `node scripts/mutants.mjs`, the
whole script, on the final code: **87 mutants, 84 killed, 3 survived, all three equivalent** (R-12
and "values copied as numbers", as in every run above, and one of the new ones, below). Of those:
the 26 D72 mutants of the two runs above, **26 of 26 killed** again, by the same tests; the
re-check's 16 new ones, each against `test/bounds.recheck.test.ts` (four with
`test/bounds.test.ts` as well), **15 of 16 killed, 1 survived (equivalent)**:

| Mutant | Killed by (`bounds.recheck.test.ts` unless named) |
|---|---|
| r2-m-1: the skip's subquery does not name the tenant (one tenant's batch hides another's rows; survived the 109 tests before) | "two tenants with the same sequence numbers and opposite times…"; "the same for log batches…" |
| r2-m-1: the ranged read does not name the tenant (survived the shard's 109 tests before) | the same two |
| r2-m-1: the look for `last` does not name the tenant in its outer WHERE | **survived, equivalent** (run against the whole suite): the subquery names the tenant and decides every row the outer WHERE would add, because a stream's sequence numbers are contiguous up to `through`, so the tenant has a batch of its own at each one looked at. Right by reading; listed so that it is reported |
| r2-m-2: a metrics-only ranged read runs the timed statement again (`byBounds = timed`) | "a metrics-only ranged read reads the rows it read before D72 (one per batch), not two…"; "skips nothing: every batch above the watermark is examined…" (also "does not need the index…") |
| r2-m-2: an unranged read runs the timed statement | "a span or log read with a time range reads 2 rows per batch it skips…" (the statement and the rows read without a range); "does not need the index batch_time…" |
| r2-m-2: no read skips by bounds (`byBounds = false`) | `bounds.test.ts` "returns exactly the batches whose bounds overlap the hull…", "logs: the same, by `ts`…" |
| r2-m-2: a log read does not skip by bounds | `bounds.test.ts` "logs: the same, by `ts`…", "signals still choose batches when the read has a hull…" |
| r2-m-2: a span read does not skip by bounds | `bounds.test.ts` "returns exactly the batches…", "signals still choose batches…" |
| r2-m-2: a read without `signals` does not skip by bounds | `bounds.test.ts` "signals still choose batches…"; "two tenants with the same sequence numbers…" |
| r2-m-3: `configure` stores whatever it is given | "tailScanMaxBatches that is not a positive integer… is refused and changes nothing…"; "the sibling limits…" |
| r2-m-3: a field given as `undefined` is skipped by the check and stored | the same two |
| r2-m-3: a stored value that breaks its rule is used | "a stored configuration with a value that breaks its rule… is read with the default in its place…" |
| r2-m-3: `tailScanMaxBatches` may be 0 | "tailScanMaxBatches that is not a positive integer…"; "the sibling limits…" |
| r2-m-3: a non-integer or an infinite number passes | the same two |
| r2-m-3: a negative number passes | the same two |

Not mutated: the look for `last` in a read that admits only metric batches (`lastKept`'s
`!f.byBounds`). Looking in the index there too would change no answer in a stream of one signal,
and in a mixed stream both answers are allowed ("Contract issues" 2), so no test pins it.

### Reservations (D77, 2026-11-28)

Measured here (local workerd, the Workers test runtime). `npx tsc --noEmit` clean.

- `npx vitest run --maxWorkers=2 test/reserve.test.ts`: 10 passed.
- **The whole suite**: 130 passed on a copy of this tree outside the git worktree (the engine's
  WASM built from the same `engine/` tree, sha256 `df0ed811…`), and 120 of 120 on the same copy of
  the release before (375e9ba). **In the git worktree itself 15 tests that load the engine's WASM
  (`bounds`, `bounds.edge`, `signals`, `tail`) failed with `engine: module ABI 2, binding expects 4`**
  although the `viz_engine.wasm` there is the same file and answers ABI 4 when instantiated directly:
  the test runtime loaded a module from somewhere other than the tree (it did so even before the file
  was copied in). Not caused by this change (none of those tests touch reservations, and they pass
  outside the worktree); not explained either.
- **Rows written** (`spikes/s15-ingest-atomic/rows.test.ts`, both span shards of a tenant, every
  `sql.exec`'s `rowsWritten` summed): one realistic 8,200-span request accepted, **24 rows before and
  24 after**; its retry, 0 and 0; the same shape refused with one shard full, **10 rows before (the
  half that was stored) and 0 after**. A grant writes no row.
- **Mutants** (`scripts/mutants.mjs`, "reserve (D77)", applied to a copy in the scratch area; each
  must fail `test/reserve.test.ts`). First run: 10 of 12 killed; **S2 (grants not counted in the
  shard budget) and S10 (a granted append refused for load) survived**: the fair-share test passed
  without the grant (the tenant was over its share anyway), and a granted append's own bytes leave
  the grant before the load check, so the bound held by construction. Two cases were added (a tenant
  under the budget without the grant and over it with it; limits lowered after the grant), and the
  second run killed all 12:

| Mutant | Killed by |
|---|---|
| S1 grants not counted in the tenant's room | a grant holds room against the tenant cap |
| S2 grants not counted in the shard budget | counts grants in the shard-wide budget (after the added case) |
| S3 a token admits another tenant | release gives the room back; a token of another tenant… |
| S4 a token admits another batch | the same test |
| S5 a token admits more bytes than granted | the same test |
| S6 grants never expire | a grant expires after `reservationTtlMs` |
| S7 a probe (`hold: false`) holds | `hold: false` answers without holding anything |
| S8 duplicates need room at reserve | batches the stream holds or has waiting need no room |
| S9 grants not counted in the in-flight limit | a granted append is not refused for load; the grant counts in the in-flight limit |
| S10 a granted append refused for load | the same test (after the added case) |
| S11 release ignored | release gives the room back |
| S12 room never checked for an append without a grant | a grant holds room against the tenant cap |

### The review of D77 (2026-11-28)

Measured here (local workerd); vitest with `--no-cache` and `--fsModuleCachePath` of the tree's own
(`--no-cache` alone loaded an ABI-2 `viz_engine.wasm` from vitest's shared module cache and failed the
15 engine tests: review m-6). `npx tsc --noEmit` clean; the whole suite **138 passed of 138** (14 files; 130 before);
`test/reserve.test.ts` 18 (8 added, and the in-flight test now uses `maxInFlight: 1`, since a grant
of two batches is one append). Every added test failed on a copy of 01e2770 (9 failed there in all).

**Mutants** (`scripts/mutants.mjs 'reserve (D77'`, on a copy, against `test/reserve.test.ts`): S9 and
S10 re-anchored to the new load check; S13–S21 added for the fixes; three older early-refusal patterns
that no longer applied re-anchored (all three killed by `groupcommit`). First run: **20 of 21 killed;
S19 (the fair share checked against the whole request instead of its first batch) survived**: the m-1
test's tenants held nothing, so the held-nothing rule admitted them either way. A case was added (a
tenant holding 300 whose first batch fits its share and whole request does not), and the rerun
killed it. `node scripts/mutants.mjs --check`: all 108 patterns apply.

| Mutant | Killed by |
|---|---|
| S13 a grant loads its sum of bytes, not its largest batch (M-1) | M-1: a grant counts against the in-flight limits as one append of its largest batch… |
| S14 a grant counts every batch against `maxInFlight` (M-1) | the same; a granted append is not refused for load… |
| S15 a refusal under a grant keeps the rest of it (M-2) | M-2: a refusal under a grant drops what is left of it at once… |
| S16 a throw under a grant keeps the rest of it (M-2) | M-2: an append under a grant that throws… |
| S17 a grant expires from `reserve`, not from its last use (m-3) | m-3: a grant lives reservationTtlMs from its last use… |
| S18 a tenant holding nothing is held to its share at `reserve` (m-1) | m-1: a request larger than its fair share is admitted… |
| S19 the fair share checked against the whole request (m-1) | the same (after the added case) |
| S20 a tenant holding only a grant is not a sharer (m-2) | m-2: a tenant that holds only a grant is counted among the sharers… |
| S21 a probe of an unknown tenant creates its stream (n-1) | n-1: a probe (hold: false) of a tenant the shard does not know… |

## Not implemented yet

- **Reservations (D77) are memory only**: lost with the instance; `reserve` does not meter active
  series ("Reservations: room for a request before it appends").

- **Rows read are not measured on Cloudflare** (re-check of D72, r2-m-2): the counts above are
  local workerd's `rowsRead`. Whether Cloudflare counts an index lookup that finds no entry, and
  what a span or log read with a time range is billed, needs the experiment named there.
- **A read that admits only metric batches consults no bounds at all**, `page_limit`'s `last`
  included: in a stream that mixes signals (edge writes none) it says `last` only for the tail's
  last batch, where BATCH.md's wording would allow `true` earlier ("Contract issues" 2).
- **Configuration is checked field by field only** (r2-m-3): no rule ties fields together
  (`registerBackoffMs` may exceed `registerBackoffMaxMs`, `sealBytes` may exceed `tenantMaxBytes`),
  and there is no upper bound below 2^53. `configure` has no caller outside tests.

- **Filtering rows inside span and log batches**: a batch the range keeps is returned whole, with
  any rows it holds outside the range (the reader selects rows). Batches whose spans spread over
  hours (late senders, long spans) are kept whole for any range they touch.
- **Bounds of stored rows**: nothing is backfilled; rows from before schema 3, and rows the release
  before writes after a rollback, are read by every range until they leave the tail.

- **Skipping metric batches without scanning them.** A filtered metrics read decodes the series
  table of every batch above the watermark. The same columns could hold a metric batch's time
  bounds (its `ts` column is found from the end of the batch) and let a read skip batches outside
  the range; not done (D72 (g): D48 measured that metric batches span most of a tail's times).
  Metric names per batch are not recorded either.
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

- **Span and log bounds are only as good as the walk** (D72). The shard derives them from the
  bytes every reader decodes, and a batch it does not accept gets none (kept by every range). It
  accepts only the layout BATCH.md defines up to the time column, with flags and reserved zero; a
  later revision that changes that layout WITHOUT signalling it in the header would get wrong
  bounds and skipped rows (BATCH.md requires the signal, or the shard updated first; the reader
  list in COMPATIBILITY §3.3 does not name the shard yet: "Contract issues" 1). Tested
  against the engine's flush on 150 random batches of the engine's test encoder and 284 of edge's.
  The walk does not check label or attribute contents (empty names, UTF-8): a batch edge never
  builds can get bounds from a layout the strict decoder refuses, which then refuses it at flush.
- **Rows written, rows read and SQLite's reads are measured in local workerd only.** On Cloudflare
  neither the extra index row per span or log append, nor the rows a ranged span or log read is
  billed (2 to 3 per batch considered here, against 1 before D72), nor the bytes read to skip are
  measured (experiment: appends and reads against a deployed shard, rows written and read from the
  analytics API).
- **A span or log read with a time range fails if the index `batch_time` is missing** (it throws:
  `INDEXED BY` never falls back to the rows). Migration 3 creates it; storage at version 3 without
  it does not exist by the repository's records (the first build of migration 3 never shipped).
  Metrics reads no longer depend on it (re-check of D72, r2-m-2).
- **`configure` now throws where it used to store** (r2-m-3): a caller that passes an unknown
  field, or a field as `undefined`, is refused whole. No component calls `configure`; the tests of
  query, stack, edge, flush and janitor that do were run and pass. A stored value the check would
  refuse is read as the default without a log line.
- **A tail of many tiny span or log batches is decided about 1 ms per 2,000 batches slower** than
  as first built (the index lookup per batch), while reading a third of the bytes; bounded per call
  by `tailScanMaxBatches` (about 21 ms at most, modelled).

- **A filtered read costs the shard CPU in proportion to its whole tail** (above; for a span or
  log read with a time range, the batches it keeps, D72, plus the index entries of those it skips), once per query per shard, on the object
  that acknowledges appends. 22 MB took 30–140 ms here. A tenant
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

## Contract issues

Texts in `contracts/` that this component may not edit (AGENTS.md, "Contracts first"). Each is
the exact text proposed; none changes what the shard does.

**Both were applied on 2026-11-26**, in a contracts commit of their own before this change's commit
("contracts: the shard is a reader of the span and log batch layout; last for metric-only reads").
They are kept here as the record of what was asked.

1. **`contracts/COMPATIBILITY.md` §3.3 does not name the shard as a reader of the span and log
   batch layout** (review of D72, m-1; re-check r2-n-1; still open). `BATCH.md` ("The one layout a
   shard reads") carries the rule and points at §3.3, whose list of readers has no line for it.
   Add, after the sentence "A new R2 or KV format: every reader (publisher, ledger rebuild, query,
   janitor, edge) before the writer.":

   > A change to the `VZB1` layout of spans (signal 2) or log records (signal 3) up to the
   > `start` or `ts` column: every reader of that layout before the writer (edge), and since D72
   > the shard is one of them, with the engine in flush and in query: at append it walks the entry
   > table by its length fields and reads that column (`batchTimeBounds`). The one exception is a
   > change that signals itself in the header (a new magic, a new signal number, or a non-zero
   > `flags` or `reserved` byte): a shard of this release records no bounds for such a batch and
   > keeps it by every time range, so it needs no shard release first (`BATCH.md`, "The one layout
   > a shard reads, and how a later one must say so").

2. **`contracts/BATCH.md`, "Pages": `last` for a read that admits only metric batches** (new with
   the re-check's r2-m-2). The text says `last` is "`true` when no batch after it, up to
   `through`, can hold a row the read keeps by its time bounds". A read that admits neither spans
   nor logs no longer consults bounds, so the shard answers `last: true` for such a read only when
   the batch is the tail's last (`seq = through`). In a stream that holds one signal, which is
   every stream edge writes ("Streams per signal"), the two rules give the same answer (no metric
   batch has bounds); they differ only in a stream mixing signals, where the shard now says
   `false` ("one may") for a metric batch followed only by span or log batches outside the range.
   `false` never overstates: a reader treats it as "at least this many bytes". Add after the
   sentence that ends "`false` when one may.":

   > A read that admits only metric batches (`signals` without 2 and 3) consults no bounds: it
   > examines every batch above its watermark, as before D72, and its `page_limit` says `last`
   > only for the tail's last batch.

## Needed changes elsewhere

### The re-check of D72 (2026-11-26)

Not edited here (only `shard/` is this change's); the exact text for each owner. **Items 1 to 3 were
applied on 2026-11-26** (`design/DECISIONS.md` D72 and `design/REVIEW.md`); item 4 is true of the
page on main since pull request #9's design commit.

1. **`design/DECISIONS.md`, D72, "Cost of it", its sentence on `last`** (r2-n-1). It reads
   "`last` on `page_limit` is used only once query reads it (`shard/README.md`, "Needed changes
   elsewhere")." Query reads it. Replace with:

   > `last` on `page_limit` is read by query (`query/src/tail.ts` `readPages`, which sets
   > `overLast` from it; `query/src/coordinator.ts` keeps it), so a 422 for a tail whose later
   > batches are all skipped gives the exact size (`query/test/review-r2.test.ts`, "n-1").

2. **`design/DECISIONS.md`, D72, "Cost of it": rows read** (r2-m-2; the lead's decision to keep
   metrics reads on the statement from before D72 belongs in the entry). Add after the sentence
   that ends "rows written read from the analytics API).":

   > Rows read are billed too. Deciding from the index costs a ranged read 2 rows per batch it
   > skips and 3 per batch it keeps, where a read before D72 read 1 per batch (the cursor's
   > `rowsRead` in local workerd, `shard/test/bounds.recheck.test.ts`: 400 and 599 rows for 200
   > span batches skipped and kept, against 200; Cloudflare's count and bill are not measured). So
   > only a read that can skip something pays it: a read with a time range that admits spans or
   > logs. A read that admits only metric batches, which every metrics query sends, runs the
   > statement from before D72 and reads 1 row per batch as before (re-check r2-m-2; as first
   > reviewed every ranged read ran the index statement, which doubled the rows read of every
   > metrics query: 400 against 200). Modelled at the list price of $0.001 per million rows read
   > past 25 billion a month: $1 to $2 per billion span or log batches considered by ranged reads.

   in "Would change if", add: "rows read show in the bill (then (c2), the full covering index,
   which `shard/bench/results/skipread.txt` measured at 1 row read per batch, at the price of a
   row written on every append);". And in "Decision", replace "A filtered tail read with
   `minTs`/`maxTs` skips, in its SQL, a batch whose bounds lie wholly outside them" with:

   > A filtered tail read with `minTs`/`maxTs` that admits span or log batches (no `signals`, or
   > 2 or 3 listed) skips, in its SQL, a batch whose bounds lie wholly outside them

   and add after "A batch with NULL bounds has no entry and is always kept.": "A read that admits
   only metric batches runs the statement from before D72 and consults no bounds (re-check
   r2-m-2)."
3. **`design/REVIEW.md`, the row of `reviews/d72-shard-bounds-r2.md`**: its last cell says "Fix in
   progress in `shard/`". When this change is committed, replace that sentence with: "Fixed in
   `shard/`: r2-m-1 the reviewer's two-tenant test adopted, both mutants killed by it (the third,
   in the look for `last`, is equivalent); r2-m-2 a metrics-only ranged read runs the statement
   from before D72 (200 rows read for 200 batches, as the release before D72; a span or log read
   with a range 2 to 3 per batch, measured in local workerd, not on Cloudflare); r2-m-3 `configure`
   refuses a value that breaks its field's rule and a stored one reads as the default; r2-n-1 and
   r2-n-2 corrected in `shard/README.md` (the D72 sentence and the COMPATIBILITY §3.3 line are
   proposed there, not applied)".
4. **`design/artifact/viz-design.html`, the "Paged tail reads" row** says "The query service does
   not read it that way yet; that change is in progress". Query reads the tail in pages
   (`readPages`) and sends each span or log read's time range (D72); the row's owner should say
   so, or say what remains.

### Time bounds of span and log batches (D72; review m-3, and the review of D72)

1. **`query/`: done by its owner** (not edited here). `readSignalTail` sends each read's
   nanosecond bound as the shard's time range (`msRange`); the review's query-side findings (m-2,
   de-duplicate after the window; m-3, an empty range reads no tail) are that builder's. The
   proposal that stood here (2026-11-19) is in this file's history.
2. **`query/`: reads `last` from `page_limit`: done by its owner** (review of D72, n-1; found done
   by the re-check at `afd0deb`: `query/src/tail.ts` `readPages`, `query/src/coordinator.ts`, and
   the test "n-1" in `query/test/review-r2.test.ts`). The proposal that stood here is in this
   file's history.
3. **`contracts/COMPATIBILITY.md` §3.3**: still open; the exact line is "Contract issues" 1.

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
   until every `viz-ingest` version running sends it. **An answer without `page` in the middle
   of a paged read** (a rollback or a gradual deployment between two pages; review of D47, D48
   and D55, P-9): it is still the whole tail. A reader either drops the pages already read and
   uses that answer alone, or refuses retryably and plans again (query does the second, D54);
   never a mix. Appending it would count every row twice against `maxFetchBytes` and the
   sample budgets. **A new filter field**: the same review asked that one come with `v` 2,
   because a `v` 1 shard ignores fields it does not know (COMPATIBILITY.md §3.2) and still
   answers with `page`, a superset that looks filtered. The two fields added since, `signals`
   (D63) and the time range that skips span and log batches (D72), stayed in `v` 1
   (`TAIL_READ_VERSION`) and are made safe at the caller instead: they are sent only to the
   signal's own shards, every batch that comes back is checked by its header, and the engine
   selects the same rows whether or not the shard skipped any (D62, 4.). A field whose
   superset a caller could not tell from a filtered answer still needs `v` 2.
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
