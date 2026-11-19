# Ledger

The tenant ledger: one SQLite Durable Object per tenant (the tenant is the object's name).
It holds the tenant's live data files and one watermark per shard stream, and is the only
authority on what is visible. It implements `LedgerRpc`, `LedgerAdminRpc` and
`LedgerJanitorRpc` from `contracts/ledger.ts`, and the change log of
`contracts/LEDGER-LOG.md` (decision D36).

| File | Contents |
|---|---|
| `src/ledger.ts` | `Ledger`: register, add unit, plan, replace, expire, logged watermarks, tombstones, the segment drain, starting an incarnation, rebuild |
| `src/index.ts` | Worker entry; exports the class |
| `scripts/mutants.mjs` | Mutation check (runs only on a copy outside the git checkout) |
| `test/ledger.test.ts` | 39 tests: units, replay, registration, plan, replace, expire, names, the log's contents |
| `test/segments.test.ts` | 27 tests of the segment log: crashes, exact rebuild, checkpoints, the first layout, a rollback across this release, starting an incarnation, F10/F11, the size limit, readers |
| `test/checkpoint.test.ts` | 13 tests of checkpoints in parts (format 2) and the streaming rebuild: the state at the checkpoint's version whatever commits meanwhile, part boundaries, key order, a crash, lost answer or storage loss at every await of the checkpoint path, superseded checkpoints, tampered checkpoints, streaming, an untracked checkpoint, the release before reading this one's log and back, the format-2 golden |
| `test/compat.test.ts` | 9 tests of versioned storage and the log formats (`contracts/COMPATIBILITY.md` §8), including that the release before opens this storage |
| `test/tombstone.test.ts`, `test/precedence.test.ts` | 8 and 5 tests |
| `test/registration.test.ts` | 5 tests of registration before writes (D61): `logged` and `loggedIncarnation`, and a rollback to the release before and back on the same storage (review B-1) |
| `bench/prereg/` | The release before D61, frozen: run on the ledger's own storage by `test/registration.test.ts` (a rollback), and as the older ledger of `shard/`'s skew tests |
| `bench/` | In workerd: the admission counterfactual against the frozen as-built ledger (`bench/asbuilt/`, `dc2a1c3`); checkpoints and rebuilds against the frozen release before checkpoints in parts (`bench/before/`, `44649de`; `checkpoint.bench.test.ts`, results in `bench/results/checkpoint.txt`); `rss.mjs` samples the processes' memory |

Bindings: Durable Object `LEDGER`, R2 bucket `BUCKET`, variable `CELL` (default `cell-0`);
optional `LEDGER_DRAIN_DELAY_MS` (default 200) and `LEDGER_CHECKPOINT_EVERY` (default 256).

## What is implemented

- **One transaction per change, answered at the commit.** Each mutation changes the live
  set, bumps the version and puts the `LedgerChange` in the `outbox` table in one
  `transactionSync`, sets the alarm if none is set, and answers. Nothing waits for R2.
- **`addUnit`.** Admitted only if the stream is registered with that incarnation and
  `seqLo === watermark + 1`; all files and the watermark move together. A shard never seen
  is registered by its first unit (`seqLo === 1`); any other unit of an unknown shard gets
  `not_contiguous` with watermark 0. **Replay rule:** a unit with `seqHi <= watermark` gets
  `ok` and changes nothing; one that straddles the watermark gets `not_contiguous`.
  **`invalid`:** a malformed stream reference, range or file, a key repeated in the unit, an
  empty unit, more than 4,096 files, a key already live, a key outside
  `{cell}/data/{table}/tenant={tenant}/day={day}/` (review R-8), or a shard name outside
  `SHARD_NAME` (`contracts/TABLES.md`; D38). The unit is judged before the stream.
- **`registerStream`.** Idempotent for the same incarnation; a higher one replaces it,
  resets watermark and logged mark to 0 and returns the old one; a lower one is refused
  (an exception: the contract's return type has no refusal). A bad shard name throws.
  **Answers `logged`** (D61; `RegisterResult`): true iff the committed incarnation is the one
  asked about and its registration is in the logged prefix. Derived at call time, never
  stored (review B-1): a logged unit of that incarnation proves it at once; otherwise the
  outbox is read for a pending `register_stream` change naming it (`pendingRegistrations`:
  one pass over the outbox, parsing only rows whose body holds `"kind":"register_stream"`).
  Outbox rows leave only with the segment that holds them or with a new incarnation whose
  base is in R2 first, and every release writes and drains the same outbox, so no rollback,
  roll-forward or rebuild by any release can leave the answer stale. A fresh registration
  answers `false`.
- **`loggedWatermarks()` and `orphanCheck()` report `loggedIncarnation`** (D61;
  `LoggedWatermark`): the committed incarnation if its registration is logged; else the one
  registered before it if that registration is logged; else 0. Derived the same way, in the
  same synchronous read; the outbox is read only when some stream's logged watermark is 0.
  It is never above what the log holds, so the orphan sweep can count an older incarnation's
  files dead on it (spec F16) without bringing F15 back.
- **`logStatus()`** reports `registrationsPending` (registrations committed, not logged) and
  `pendingSince` (when the oldest change still in the outbox was committed): the signal for a
  ledger that cannot log while shards refuse its tenant's new streams (review m-1).
- **`plan`.** Files of one table overlapping the range, in ascending precedence, with every
  watermark, the ledger incarnation and the version, read with no `await` in between.
- **`replace`.** Swaps iff every input is live; otherwise `conflict` with the missing keys
  (or `blocking` keys, below). A retried swap that already happened is `ok`.
- **`expire`.** `{ table }` or `{ tables }` (review R-5, a contract change): every named
  table's files of days before `beforeDay` leave in ONE change, so a samples file and its
  series file leave together. Nothing to remove uses no version.
- **The change log** (`contracts/LEDGER-LOG.md`). The drain (the alarm, about 200 ms after
  the first unlogged commit; a commit also starts one when one is due, because under
  continuous load the runtime delivers the alarm only when the object is idle) takes the
  pending rows from the lowest version up to 4 MiB, records the segment's bounds in `meta`
  and waits for that to be durable, PUTs `seg-{first}-{last}.jsonl` with `If-None-Match: *`,
  and then, in one transaction, deletes those rows, advances each stream's `logged` mark
  (only for the incarnation that set it) and clears the record. A retry writes exactly the
  recorded segment (spec F10). An object already at that key counts as written only if its
  bytes are identical; anything else stops the drain (`logStatus().lastError`), never
  overwritten. A failed PUT backs off 1 s doubling to 60 s. A change committed while a
  segment is in flight goes in the next one. At most 16 segments per alarm. A drain that
  leaves nothing pending deletes the alarm.
- **A stuck log says so** (review S-1). A fault (an object with other bytes at a segment's
  key, a recorded segment whose rows are gone, an outbox that does not continue the written
  log) stops the drain: `logStatus()` answers phase `stuck` with the reason, nothing more
  counts as logged, the alarm retries every 60 s. The one fault with a known cause heals
  itself: an outbox that does not continue the log in an incarnation whose prefix also
  holds first-layout objects is what a rollback to the release that drains the first layout
  leaves after the roll-forward. SQLite holds every committed change, so the ledger starts
  a new incarnation from SQLite, its base in R2 first (the fix the protocol model checked).
  For any other, an operator repairs R2 or calls `restartFromSqlite()`, which does the same.
- **Checkpoints, in parts** (review S-2's full fix, D47; `contracts/LEDGER-LOG.md`,
  "Checkpoints"). After at least 256 segments AND once the segments written since the last
  checkpoint (or the base) are as large as it, when the segment being written ends at the
  committed version, the drain takes a checkpoint of the state at that version. A state of
  at most one part (1 MiB, estimated) is written as before, one object built in that step
  (format 1). A larger one is only begun there (a row in `ckpt`: version, streams, attempt);
  later drain steps write it as parts of at most 1 MiB, one PUT each, at most 8 per alarm, a
  segment first whenever one is pending; then a manifest, `If-None-Match: *`, once the log has
  reached the version (format 2). Every mutation committed meanwhile keeps, in its own
  transaction, the pre-image of each file it adds or removes ahead of the checkpoint's cursor
  (`ckpt_pre`), so every part is the state at the checkpoint's version; with no checkpoint
  reading files, a mutation runs no statement for it. A checkpoint whose `tracked` version is
  behind the ledger (a release without this code committed meanwhile) is abandoned. A failed
  part or manifest is retried after a backoff (1 s doubling to 60 s), never failing or delaying
  the log; an eviction resumes it. Once the manifest is in R2, older manifests are deleted,
  then every other part.
- **The state is bounded, by time** (review S-2). `meta.state_bytes` estimates the state as a
  base would hold it (each live file's key and index fragment plus 448 bytes, calibrated
  against checkpoints written), kept with every mutation and recomputed exactly at every start
  and every one-object checkpoint. `addUnit` answers `full` (`{ status, stateBytes,
  limitBytes }`, nothing changed, retryable) once it would pass the cap: **16 MiB by default**
  (`STATE_MAX_BYTES`, the cap of the releases before D47; `LEDGER_STATE_MAX_BYTES` sets
  another), pinned there by the review of D47/D48/D55 (P-2: a rollback to the release before
  cannot hold or checkpoint a larger state; P-3: a rebuild and a first publication above 16 MiB
  are not measured within a Durable Object's CPU limit on Cloudflare). The code itself handles
  300 MiB (`STATE_MEASURED_MAX_BYTES`, about 300,000 S4-shaped files, the largest state
  measured): memory no longer sets the bound (nothing holds the state); a rebuild's duration
  does (below). A release lifts the default only once its rollback floor has D47 and D55 and
  those two times are measured on Cloudflare.
  `replace` and `expire` are never refused, so compaction and retention make room.
- **`loggedWatermarks`.** Per stream, the watermark as of the last change in a written
  segment. Shards may discard only up to it.
- **Starting an incarnation** (a new tenant, storage loss, or storage still on the first
  log layout) runs **outside `blockConcurrencyWhile`** (review R-3): the constructor only
  opens SQLite. While it runs every request waits at most 2 s and is then refused with
  `ledger_unavailable` (retryable); `logStatus` answers meanwhile. A failed start is retried
  by the alarm every 5 s. The state comes from R2 (the newest incarnation: newest readable
  checkpoint, else the base at the head of its first segment, then every later segment,
  contiguous and strictly decoded; or the first layout, `base.json` and one object per
  change) or from SQLite (first layout). The new incarnation's **base segment is written to
  R2 before SQLite commits the incarnation** (spec F11): if it cannot be written, nothing
  commits and nothing is served. The state is loaded **into SQLite as it is read** (a
  checkpoint part at a time; a base line element by element, `readLedgerLogStream`, in
  transactions of 256 rows), and the base is written from SQLite in pieces: measured once,
  then streamed into one conditional PUT of exactly that length. With no log in R2 at all it
  starts empty only if the tenant has no data objects either; otherwise its log is not where it looks and it refuses
  (`stuck`), so no sweep runs against an empty live set (review S-5). A log that cannot be
  rebuilt from (a gap, a corrupt or unsupported object, segments and first-layout objects in
  one incarnation) is `stuck` too, never partly replayed. A checkpoint that cannot be read
  whole (a part missing, of another attempt, or not adding up to its manifest) is passed over
  and what it loaded emptied.
- **Storage that is not new and has no incarnation** (a schema version row and no
  `meta.incarnation`) is refused, never rebuilt over.
- **Versioned storage** (`contracts/COMPATIBILITY.md` §2, D24): `ledger.Ledger` through
  `contracts/schema.ts`. Version 1 adopts the pre-versioning schema unchanged and adds
  `prec`/`prec_lo` to objects from before D22. Version 2 (the segment log; `state_bytes`)
  is **forward-only** (`readableFrom` 2): versioned code that knows only version 1 refuses
  this storage instead of draining the first layout into it (review S-1). Version 3 (tables
  `ckpt` and `ckpt_pre`, a checkpoint in parts) is additive (`readableFrom` 2): the release
  before it opens this storage, ignores them, and a checkpoint it leaves untracked is
  abandoned. Storage of a newer release is refused on
  every entry point with `schema_too_new`, writing nothing, the alarm re-armed. Readers of
  the log refuse an unknown segment `v`, header `kind`, change `v` or change `kind`, in both
  layouts (`unsupportedLedgerChange`, `decodeLedgerSegment`).
- **Tenant ids** must match `TENANT_ID`; an object addressed by another name refuses
  everything.
- **In memory** only hints: whether a start is running, the alarm time this object set,
  the drain's backoff, the last error and counters for `logStatus`. Storage is the truth.

`LedgerAdminRpc`: `drain()` → `{ written }`, `outboxDepth()`, `rebuildFromLog()` (on empty
storage only; waits for a drain in flight). Also on the class: `logStatus()` (phase,
incarnation, version, logged-through, pending, the segment in flight, segments since the last
checkpoint, alarm, last error, write times, `stuck`, `stateBytes` and the limit) and
`restartFromSqlite()` (a new incarnation from this object's own committed state; waits for a
drain in flight). A drain of an incarnation that has since been replaced changes nothing
(review S-7).

## Rebuild: what it guarantees

- The live files (with index fragments, precedence and unit), streams (with previous
  incarnation), tombstones and version equal the state after the last change in a written
  segment. Tested by comparison with a second object of the same tenant that has empty
  storage and reads the same R2 log (`LedgerReplica` in the tests), and after storage loss.
- No watermark comes back lower than a logged watermark any shard was ever given.
- A `(ledgerIncarnation, version)` pair is never used for two different changes, and an
  incarnation number never for two histories (its base is in R2 first).
- It refuses, and the object serves nothing, if R2 cannot be read, the log has a gap or
  overlap, a segment is corrupt or of an unknown version or kind, an incarnation holds both
  layouts, there is no log but there are data objects, or a change does not fit the state
  before it. A checkpoint that cannot be read whole is passed over for an older one or the
  base (older checkpoints are deleted once a newer one is complete).
- It never holds the state in memory: a checkpoint part, a few segments (at most 8 MiB in
  flight) and 256 rows of a base at a time (tested: rows reach SQLite before the object holding
  them has been read to its end, for a base, a format-1 and a format-2 checkpoint).
- Changes committed but not yet in a segment are lost (one drain cycle). An unlogged unit
  must be re-sent (the shard still holds its rows; flush notices the watermark went back).

**Checkpoints and rebuilds, the release before against this one** (measured here, in local
workerd, `bench/checkpoint.bench.test.ts`, 2026-11-19; raw lines in
`bench/results/checkpoint.txt`). The counterfactual: the frozen release before checkpoints in
parts (`bench/before/`, `44649de`, its 16 MiB limit lifted as review S-2's benchmark did) and
this one are filled with the same units of S4-shaped files (4,000 files a unit, an index
fragment of about 460 characters); before any time is compared both must hold the identical
state (a SHA-256 over every row: equal at every size), each must rebuild it exactly from its
own checkpoint, and at 8,000 and 32,000 files each must rebuild it exactly from the other's
log (this one streams the older one's base line; the older one reads the base this one wrote
in pieces). "Blocked" is the longest a trivial call (`logStatus`) waited while the checkpoint
was written, sampled every 5 ms: the longest synchronous step a caller meets. Memory is the
resident size of the workerd process, sampled every 100 ms by `bench/rss.mjs` (it holds the
test, SQLite and the simulated R2 too; workerd does not enforce the 128 MB isolate limit).
The machine was shared: load average 6–10 (printed per run in the log).

| Live files | Release | Checkpoint written | Blocked at most | Objects (largest) | Process memory during it | Rebuild from its checkpoint | Memory during the rebuild | Peak |
|---|---|---|---|---|---|---|---|---|
| 8,000 | before | 0.16–0.19 s | 58–68 ms | 1 (8.4 MB) | not visible | 0.37–0.50 s | not visible | |
| 8,000 | this | 0.23–0.27 s | 2–3 ms | 9 (1.05 MB) | not visible | 0.49 s | not visible | |
| 32,000 | before | 0.71–0.78 s | 284–306 ms | 1 (33.5 MB) | +136 MB | 1.5–1.6 s | +43 MB | 624 MB |
| 32,000 | this | 0.74–0.76 s | 2–3 ms | 30 (1.05 MB) | +10 MB | 1.7–1.9 s | +5 MB | |
| 100,000 | before | 2.3 s | 928 ms | 1 (105.4 MB) | +410 MB | 3.9 s | +196 MB | 955 MB |
| 100,000 | this | 2.5 s | 2 ms | 92 (1.05 MB) | +14 MB | 5.4 s | +12 MB | 490 MB |
| 300,000 | this | 9.3 s | 3 ms | 272 (1.05 MB) | +27 MB | 20.3 s | none | 536 MB |

- **What changed.** The longest step a caller waits for during a checkpoint no longer grows
  with the state (0.93 s at 100,000 files before, 2–3 ms at every size now), and neither does
  memory (+410 MB before, +14 MB now; a rebuild +196 MB before, +12 MB now). The checkpoint's
  wall time is about the same (it is a few hundred PUTs instead of one; on Cloudflare a PUT
  takes 0.17–0.4 s whatever its size up to 1 MB, so 92 parts written one after another is
  modelled at 16–37 s there, against one 105 MB PUT before; nothing waits for it).
- **What got slower.** A rebuild: 5.4 s against 3.9 s at 100,000 files, 20 s at 300,000. Half
  of it is writing the new incarnation's base from SQLite in two passes (measure, then stream);
  the rest is reading parts and inserting rows a transaction at a time. Rows inserted outside
  a transaction made a 32,000-file base take 15.6 s; batching them (256 a transaction) made it
  2.4 s (measured, then fixed). Reading another release's base line is slower than its own
  checkpoint (2.4 s against 1.7 s at 32,000 files), the price of parsing it element by
  element.
- **Not measured:** the release before at 300,000 files (its checkpoint alone would add about
  1.2 GB, over the 1.5 GB a process may use here; extrapolated from +136 MB at 32,000 and
  +410 MB at 100,000); anything on Cloudflare.

**R2 bytes per day for a busy tenant (modelled).** The log is about 870 bytes per file admitted
(measured: 260.7 MB of segments for 300,000 files). At review S-2's busy tenant, 17 units a
second of two files, that is 2.6 GB of log a day. Both releases write a checkpoint only once the
log since the last one is as large as it, so checkpoints add at most the log's bytes: up to
2.6 GB a day, whatever the state (format 2 is about 10% smaller than format 1: 94.5 MB against
105.4 MB at 100,000 files). What changes is the count of writes: one PUT per checkpoint before,
one per MiB now (plus a manifest, a listing and two deletes): at 100,000 files about 27
checkpoints a day, 2,700 Class A operations, about $0.01 a day at $4.50 per million. Superseded
checkpoints are deleted, so storage holds one or two. **Experiment that settles it:** S4's
ledger on Cloudflare with 100,000 files at 17 units a second for an hour, R2 bytes and Class A
operations read from the analytics API.

**Time.** Measured on Cloudflare (`spikes/s4-ledger-scale/`, 2026-11-19): 5,008 changes in
104 segments, no checkpoint, rebuilt in 5.4 s; a base of 5,000 files alone in 2.8–3.5 s; the
first layout, 608 per-change objects, in 28.7 s. A checkpoint bounds the segments a rebuild
reads; a reset during a rebuild starts it again (progress is not kept). A rebuild of 300,000
files is modelled at 20–60 s on Cloudflare (20 s here; R2 reads of 272 parts four ahead at about
0.05 s each, and the base's PUT); the tenant's requests are refused, retryably, meanwhile.

## How it was verified

```
npm install
npx vitest run --maxWorkers=2     # 106 tests in workerd, 7 files
npx tsc --noEmit                  # clean
node scripts/mutants.mjs          # on a copy outside the git checkout (see the script)
npm run bench                     # the workerd counterfactuals (bench/)
BENCH=checkpoint BENCH_SIZES=100000 BENCH_VARIANTS=after node bench/rss.mjs -- npm run bench
```

Last run, 2026-11-19 (D61) on the shared machine (load average about 6): **106 passed, 0
failed**; `tsc --noEmit` clean. `test/registration.test.ts` (5):

- **spec test 4**: `registerStream` answers `logged: false` at the commit, still false while the
  segment's PUT fails and while its answer is lost after the write (the segment is in R2, its
  rows still in the outbox: low is the safe side), true once a drain removes the rows; the same
  after every eviction; `loggedIncarnation` moves only there (0 for a stream with no earlier
  incarnation, the previous incarnation while a new one is pending, 0 when two are pending, the
  new one once logged, without any unit of it); the lazy path (a first unit registers its
  stream) likewise; after a rebuild every stream left is logged and a registration that was only
  committed is gone.
- **review B-1**: release N+1 registers and logs a stream; **rollback** to the release before
  D61 (`bench/prereg/ledger.ts`, constructed on the SAME storage inside the object) which takes
  a new stream lazily by its first unit, registers another, re-registers one, and drains;
  **roll-forward**: each answers `logged: true` and `loggedIncarnation` equals its incarnation.
  One the old release committed but did not drain is pending, then logged by this release's
  drain. The old release then rebuilds the ledger from R2 (this release kept from starting):
  every stream answers `logged: true` afterwards. Mutant "logged from a stored flag" (a flag
  this release sets in its drain and its rebuild, the plan before the review): killed by this
  test.

The test count before D61 was 101 (the two answers that gained a field were updated:
`ledger.test.ts` "performs the storage-loss handshake", `tombstone.test.ts` "orphanCheck …").

**The outbox read's cost, by reading** (not measured): one pass over the outbox per
`registerStream` of a stream with no logged unit, and per `loggedWatermarks`/`orphanCheck`
when some stream has none. The outbox holds one drain cycle of rows (about 0.2–1 s of
changes); only while the drain is stuck does it grow, and then every flush's
`loggedWatermarks` reads it. A nullable `kind` column that older code leaves NULL would index
it; not added, because nothing showed the cost and a new column was what the review warned
about. `publisher/`'s suite, which pins the bytes of every log object a small
scenario writes through this `Ledger`, passed against it (78 passed); `tsc --noEmit` is clean in
edge, flush, query, stack, compact, janitor and publisher, which import this code. `stack/`'s
soak on this code (`SOAK_STEPS=3000 npx vitest run --maxWorkers=1 test/soak.test.ts`, seed
20261118, run alone among this engineer's jobs, load average 8–12): 3,000 steps, every
invariant held at every step, 246 s, peak memory 1,053 MB for the process tree and 599 MB for
the largest process (sampled every 100 ms). Its tenants' states stay small, so it exercises the
streaming rebuild and the base written in pieces, not format-2 checkpoints. Earlier: Before that run the suite failed 4 rebuild tests by timeout: they take
1–3 s alone and over 20 s while other suites run, and the default limit is 5 s; the
configuration now allows 60 s (`vitest.config.ts`). The crash property test
(`segments.test.ts`) runs three seeds of 70 random steps with failed and half-failed PUTs,
evictions and storage losses, and checks after every loss that the rebuilt state equals the
committed state at the last written segment and that no shard was told more was logged.

**Counterfactual, measured in local workerd** (`bench/admission.bench.test.ts`, results in
`bench/results/`): the same workload against the as-built ledger and this one must end in
the same state, and each log must rebuild to it, before times are compared; R2 latency is
injected. Eight writers, 400 units, no injected latency: 63.7 units/s and 120 ms median for
the as-built ledger, 200.7 units/s and 34 ms for this one; with 250 ms injected per PUT, this
one admitted 1,600 units at 212.5 units/s and 34 ms median in two segments. **Measured on
Cloudflare** (`spikes/s4-ledger-scale/`, 2026-11-19, n = 3, 20 s runs, eight writers):
234–422 units/s, median 16–31 ms, against 1.7–3.3 units/s and 2.3–4.1 s for the as-built
ledger the same day; the two ledgers agreed on a fixed workload and this one rebuilt the
as-built ledger's log exactly.

## Precedence (which file wins a duplicate sample)

`contracts/ledger.ts`, `LiveFile`; `design/DECISIONS.md` D22. Found by the query Worker's
engineer: `plan` used to list files `ORDER BY key`, readers and compaction let the later
file win, and keys sort as text, so from a stream's tenth batch on an older write could
beat a newer one. Now every file row carries `prec` and `prec_lo`, assigned here and never
taken from a caller:

- `addUnit`: `version × 4096 + position in the unit` (a flush unit has one file per table
  and day, so it is the version that orders it; the position only makes the order total
  for any unit accepted). A unit of more than 4,096 files is `invalid`.
- `replace`: each output gets `[min prec_lo, max prec]` of the removed files of its table
  and day (or a new value if none), and the swap is a `conflict` with `blocking` keys if a
  live file outside the request, of that table and day, overlapping the output in time, has
  a range that intersects it. Checked before the transaction, with no `await` in between.
- `plan` orders by `prec, key`; the log carries the assigned values in `added`; a rebuild
  restores them, and replaying a log written before they existed derives the same values.

`test/precedence.test.ts` (5): numeric order across twelve units where key order differs;
the range of a merge and of an output without inputs, and a caller's value ignored; a
merge that would jump over an overlapping file of another stream refused, one over a
non-overlapping file allowed; precedence kept across a rebuild, also from a stripped log;
the 4,096-file limit. Mutants: `stack/scripts/mutants.mjs precedence`.


## Tombstones (physical deletion)

Proposed contract addition, implemented here (`contracts/ledger.ts`, the marked block;
`design/DECISIONS.md` D20). `replace` and `expire` record every key they remove in a
`tombstone` table **in the same transaction**, with the table, the ledger version of the
change and its time (the same `at` as the logged change).

| Method | Answer |
|---|---|
| `deletable({ minAgeMs, limit })` | tombstones whose removing version is below everything in the outbox (so the removal is in R2), that are at least `minAgeMs` old by this object's clock, and whose key is not live. One synchronous read. `waiting` counts the others |
| `forget(keys)` | drops the tombstones of keys whose objects were deleted; live keys and unknown keys are ignored |
| `removedSince(version)` | every tombstone above a version, deletable or not |
| `orphanCheck(keys)` | which of the keys are live, which are tombstoned, and every stream's **logged** watermark, as one read |

Keyed by version, "logged" does not depend on the shape of the log, so the rule holds
when the log becomes segments (`contracts/LEDGER-LOG.md`). A rebuild from the log restores
the tombstones of every removal in that log (their objects may already be gone; deleting
again is harmless), and a removal that was committed but never logged is not restored,
because the rebuilt ledger lists that file again. `test/tombstone.test.ts` (7 tests).


## Mutation checks

`node scripts/mutants.mjs` on a copy of `contracts/` and `ledger/` in a scratch directory
(the script refuses to run in the git checkout: AGENTS.md); each mutant against the test files
named in the script, the source restored after each.

**Run of 2026-11-19, registration before writes (D61)**, on a copy of `contracts/`, `ledger/`,
`shard/`, `flush/`, `janitor/`, `compact/`, `publisher/` and `engine/wasm/` (the first three
are also in `scripts/mutants.mjs` as `D61:`), **4 of 4 killed**:

| Mutant | Killed by |
|---|---|
| logged from a stored flag (set by this release's drain and rebuild only: the plan before review B-1) | `registration.test.ts` "review B-1" |
| logged at the commit | `registration.test.ts` spec test 4 (two tests); `shard/` spec test 1, m-1 |
| `loggedIncarnation` is the committed incarnation | `registration.test.ts` spec test 4; `janitor/` "spec F16", "spec F15, adapted" |
| the outbox is not read (a pending registration reads as logged) | `registration.test.ts` spec test 4 (two tests) |

Re-checked with them: "loggedWatermarks returns the committed watermark" (its pattern updated
for the new read), killed.

**Run 1** (2026-11-19, the code before the segment-log review's fixes): **32 of 33 killed.**
The sixteen contracts-v2 mutants (patterns updated for the code as it now reads), and the
segment log's: F11 (a start commits without waiting for its base: killed only by the test
added for it, "if the base cannot be written, nothing commits"), F10, rows deleted before the
PUT, no `If-None-Match`, other bytes taken as written, the drain deleting rows beyond its
segment, a logged mark moving another incarnation's stream, a checkpoint for a segment that
does not end at the committed version (killed by the test added for it, a drain over 4 MiB),
a rebuild accepting a gap, a rebuild skipping an unreadable segment, R-3 (the start inside
`blockConcurrencyWhile`; an unbounded wait), R-5, R-8, the name rule, the alarm left after a
drain. **Survived:** the recorded bounds not made durable before the PUT: workerd tests
cannot crash between a local commit and its durability; it is right by reading.

**Run 2** (2026-11-19, the final code, with the segment-log review's fixes): **43 of 46
killed.** The 33 above again, and: S-1 (a rebuild skipping first-layout objects; the rollback
signature not healed from SQLite; a log fault not reported as stuck; an outbox that may skip
versions; storage readable by code that knows only version 1), S-2 (no limit; checkpoints
every N segments whatever the log's size; superseded checkpoints kept; `expire` not shrinking
the estimate), S-5 (starting empty over data objects), S-9 (`deletable` counting a recorded
but unwritten segment as logged): each killed by the test named for it above. One mutant of
run 1, "a checkpoint for a segment that does not end at the committed version", survived run
2 at first: deleting superseded checkpoints had hidden the bad one from its test. The test now
makes the newer checkpoint's write fail, and the mutant was killed on re-run. **Survived (3):**
the recorded bounds not made durable before the PUT (untestable here, as above); and the two
S-7 guards (`rebuildFromLog` waiting for a drain in flight; `segmentWritten` ignoring a
replaced incarnation): each covers the other, and no test empties storage in place while a
drain is in flight, so S-7 is right by reading, not by test.

**Run 3** (2026-11-19, checkpoints in parts and the streaming rebuild, D47; the copy also
holds `contracts/`; checkpoint mutants run with `--bail=1`): **60 of 64 killed.** The 46 above
again (patterns of six updated where the code they target was rewritten: the base's kind and
watermarks, F11, the gap check, the alarm, superseded format-1 checkpoints), and 18 new ones,
each killed by the `checkpoint.test.ts` test named in the run's output. Chunk boundaries: a
record that does not fit going in anyway; a key not live at the checkpoint's version written;
the live row winning over its pre-image; keys merged in UTF-16 order; tombstones of later
removals written; no pre-image for a removal, or for an addition, ahead of the cursor; a
checkpoint going on over untracked versions. Superseded checkpoints: deleted before the newer
manifest is written; never deleted; the new checkpoint's own parts deleted. Streaming: the base
read whole before anything is written; a base's rows all held until it ends; every part read
before any is written; parts that do not add up to the manifest accepted; what an unreadable
checkpoint loaded kept. Versions: migration 3 made forward-only (killed by the test that the
release before opens this storage, added for it). Two mutants survived at first and were
addressed: "a checkpoint for a segment that does not end at the committed version" (its test's
state had grown past one part, so it ran in format 2, where the tracking check abandons such a
checkpoint anyway; the test now runs both formats and kills it), and "S-1: storage readable by
code that knows only version 1" (flipping migration 2 alone is equivalent now that migration 3
also says `readableFrom` 2; the mutant now flips both, and is killed). **Survived (4):** the
recorded bounds not made durable before the PUT (untestable here, as before); the two S-7
guards (each covers the other, as before); and "superseded: parts deleted before their
manifests": a rebuild always reads the newest complete checkpoint first, so the order matters
only if that one later becomes unreadable; it is defensive, right by reading, and no test can
tell.

## Not implemented

- **A state larger than 300 MiB** (about 300,000 files). Nothing in the ledger holds the
  state any more; what is left is time (a rebuild of 300,000 files took 20 s here, modelled
  20–60 s on Cloudflare, with the tenant refused meanwhile). Above that: keeping rebuild
  progress (below), a base written in one pass, and the time measured on Cloudflare. Plans
  that page (below) are the other half of a large tenant.
- **A base in parts.** A new incarnation's base is still one line (it is what the publisher
  re-bases from); this ledger writes it in pieces and reads it element by element, and since
  2026-11-19 so does the publisher (`publisher/README.md`, "Re-base in bounded memory"), so a
  base in parts is not needed for memory, only, perhaps, for time.
- **Pruning the log.** No segment or old incarnation is ever deleted from R2; superseded
  checkpoints are (LEDGER-LOG.md, "Truncation").
- **Keeping rebuild progress.** A reset during a rebuild starts it again from the newest
  checkpoint (the rows it streamed into SQLite are emptied first).
- **Faster rebuilds.** Half of a rebuild is writing the new base in two passes; a rebuild could
  instead start the new incarnation from the old one's checkpoint. Not tried.
- **The alert** the design asks for when a stream changes incarnation (the boundary is
  recorded as a `register_stream` change with `previousIncarnation`; nothing is raised).
- **Paging `plan`**, and plans that reference consolidated partition indexes instead of
  carrying every index fragment (S4: 5.8 MB at 7,000 files).
- **Registration before writes** is built (D61); see `shard/README.md`. Not built here: the
  stream retirement change the review asks for (m-3: a ledger never drops a stream; a new
  `LedgerChange` kind is a log format change, readers first), and the long-poll it suggests
  (a `registerStream` that answers once logged; the shard's backoff makes it unnecessary).

## Known risks

- **F6, liveness after a shard's storage loss: closed by D61** (`shard/README.md`): a read
  naming the lost incarnation makes the shard start and register a fresh one, which the next
  plan names. F6(b) is closed only where shards run in mode `logged` (release B).
- **A ledger that cannot log refuses its tenant's new streams** (D61, shards in mode
  `logged`): until the drain works again, plus its backoff (up to 60 s). `logStatus` shows
  `registrationsPending` and `pendingSince`; nothing pages on them yet.
- **The state limit is set by time measured here, not on Cloudflare.** The default cap is
  16 MiB (above); 300 MiB of estimated state (about 300,000 files) is the largest measured:
  memory stayed flat, a rebuild took 20 s. On Cloudflare a rebuild of that size is modelled at 20–60 s, during which every
  request of the tenant is refused (retryably); the CPU a start may use there is not
  measured. A tenant that reaches the limit gets `full` until compaction or retention make
  room; flush treats `full` as an answer it does not know and retries (fail closed), so its
  shards fill and its senders get 429. Nothing alerts on it except the error log and
  `logStatus`.
- **A publisher re-base at the limit is slow, not large** (since 2026-11-19; until then the
  publisher read a new incarnation's base whole and production pinned `LEDGER_STATE_MAX_BYTES`
  at 16 MiB). The publisher now re-bases from the newest checkpoint (parts read in order, a few
  at a time) or the base, streamed into SQLite: at 300,000 files it completed with V8's heap
  capped below the isolate's 128 MB, measured in workerd (`publisher/README.md`, "Re-base in
  bounded memory"). What is left is time (why the cap is still 16 MiB, in the code and in
  `stack/wrangler.jsonc`: review P-3): a
  re-base of 300,000 files took 8–17 s here and a first publication of them 27–38 s; on
  Cloudflare neither is measured, and the CPU an invocation may use there is the bound to check.
  `verify` (the scrubber, not on the publish path) still replays a tenant into memory.
- **A rollback below this release with a state above 16 MiB** opens (the schema change is
  additive) but its rebuild holds the state in memory; such a tenant is stuck, not lost, after a
  storage loss in the rollback window.
- **Pre-images cost row writes.** While a checkpoint in parts reads files (seconds to minutes),
  each file a mutation adds or removes ahead of its cursor writes a `ckpt_pre` row, deleted
  when the checkpoint completes: about two more row writes per such file. Not measured on
  Cloudflare's bill.
- **The release record must mark this release forward-only** for code from before schema
  versioning, which cannot read the version row. If it does not and such a rollback happens,
  the roll-forward heals it (above); a storage loss in the rollback window leaves the tenant
  `stuck` (refused, not lost) until an operator repairs R2.
- **One change is one SQLite value**, capped at 2 MB on Cloudflare (training knowledge, not
  checked here). A 2,000-file unit is about 1.4 MB; a `replace` with several thousand
  outputs would not commit.
- **The drain shares the object's thread.** Encoding a segment of up to 4 MiB of JSON and
  deleting its rows runs between requests; at 422 units/s on Cloudflare the median stayed at
  16 ms, but large changes (S4's 2,000-file units) leave the log 9 s behind.
- **A broken log stops a lost ledger.** A gap, a foreign object or an unreadable segment
  makes the rebuild refuse; the tenant is unavailable until someone repairs R2. Deliberate;
  there is no repair tooling.
- **A replay answers `ok` for files the ledger does not list** (the v2 replay rule); a
  caller that wrote different bytes for an admitted range leaves orphans for the sweep.
- **Keys are unique only among live files**: a removed key could be admitted again (needs a
  caller bug; keys carry a content hash and a range).
- **A refused lower incarnation is an exception** in `registerStream`.
- **Clock.** `LedgerChange.at` and tombstone ages use `Date.now()`; nothing orders by them.

## Needed changes elsewhere

- **flush**: pass the listed incarnation and `seqHi` to `readSegment` (spec F12). Done by
  flush's engineer (`flush/src/flush.ts` `writeSegment`); the shard side is in `shard/`.
- **publisher**: read segments and the first layout. Done by the publisher's engineer
  (`publisher/src/log.ts`, `design/UPGRADES.md` §7 item 2).
- **Registration before writes** (D61): edge's mapping of `registering` to 503 and the release
  that turns the shards' mode to `logged`: `shard/README.md`, "Needed changes elsewhere".
  Nothing else in this component needs another release: `logged` and `loggedIncarnation` are
  additive answers, and the schema did not change (the release before opens this storage and
  may be rolled back to).
- **deploy**: put `schemaRelease(LEDGER_SCHEMA)` (now latest 3, compat 2) in the release
  record and refuse a rollback below compat (COMPATIBILITY.md §6; `deploy/` "Needed changes"
  7). The state cap stays 16 MiB, both as the code's default (`STATE_MAX_BYTES`) and as
  `LEDGER_STATE_MAX_BYTES` in viz-ingest's vars (`stack/wrangler.jsonc`, review P-2 and P-3).
  The release that lifts it (to at most `STATE_MEASURED_MAX_BYTES`, 300 MiB) must have a
  rollback floor with D47 and D55, deploy viz-publisher with the streaming re-base before or
  with viz-ingest (the reader first; the deploy order already does), and come after a rebuild
  and a first publication of such a state are measured within the CPU limit on Cloudflare.
- **publisher**: re-base from a new incarnation's base without holding it. **Done** (2026-11-19,
  `publisher/src/log.ts`, `publisher/README.md` "Re-base in bounded memory"): the base is read
  with `readLedgerLogStream`, and where the incarnation has a checkpoint the re-base starts
  from the newest one instead (format 1 streamed the same way; format 2 manifest first, then
  the parts in order, each checked against it); files go into SQLite and the diff against
  what is published is done there. This makes the publisher a reader of checkpoints, which
  `contracts/LEDGER-LOG.md` says nothing else is (`publisher/README.md`, "Contract issues").
  Not done: `verify`, which still replays a tenant into memory.
- **flush** may handle `full` explicitly (today it retries it as unknown, which is safe).

## Contract issues

All eight issues below were found against the first contract and are **resolved in
contracts v2**, which this component now implements: `invalid` statuses (1), the `base`
kind and `ledgerBaseKey` (2), `unit` on `add_unit` (3), `TENANT_ID` (4), `LedgerAdminRpc`
(5), the replay rules (6, 7), ordered incarnations (8).

Two things were still wrong in v2 and its comments were corrected during integration
(details in `stack/README.md`, "Contract changes made during integration"):

- `ledgerBaseKey`'s comment said the base "sorts before its first version". As a key,
  `base.json` sorts after the digits. A test asserts the real listing order.
- `registerStream` has no way to refuse a lower incarnation in its return type; it throws.

The original list, for the record:

1. **No way to refuse a unit for a bad or duplicate key.** `AddUnitResult` has `ok`,
   `not_contiguous`, `incarnation_mismatch` only. The ledger throws instead, so the caller
   sees an RPC exception, not a status. `replace` has the same gap for a duplicate output.
2. **`LedgerChange` cannot express a rebuild or a checkpoint.** Kinds are the four
   mutations. The start state of an incarnation is therefore a separate object,
   `{incarnation}/base.json`, next to the contract's version keys. A log reader that only
   follows version keys still sees one unbroken version sequence across incarnations, but
   the contract should name this object and say how readers handle an incarnation change.
3. **`add_unit` changes do not carry `seqLo`.** `watermark.seq` is `seqHi`. Rebuild infers
   `seqLo` as the previous watermark + 1, which contiguity makes correct, but a log reader
   cannot check it.
4. **`ledgerLogKey` embeds the tenant unescaped**, so a tenant named `a/1` would sit inside
   tenant `a`'s prefix and look like its incarnation 1. The ledger refuses `/` in names.
5. **`loggedWatermarks` and `rebuildFromLog`.** The first is in `LedgerRpc`; the second,
   `drain` and `outboxDepth` are not, and the contract does not say who may call them.
6. **Replay is underspecified**: what a retried unit gets once its files were compacted,
   and whether a retried `replace` is `ok` or `conflict`. Choices made here are above.
7. **Unknown shard with `seqLo !== 1`** has no fitting status; `not_contiguous` with
   watermark 0 is returned.
8. **Stream incarnations have no stated order**, so a stale lower incarnation cannot be
   refused on the contract's terms.
