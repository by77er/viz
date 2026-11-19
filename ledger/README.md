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
| `test/segments.test.ts` | 21 tests of the segment log: crashes, exact rebuild, checkpoints, the first layout, starting an incarnation, F10/F11, readers |
| `test/compat.test.ts` | 7 tests of versioned storage and the log formats (`contracts/COMPATIBILITY.md` §8) |
| `test/tombstone.test.ts`, `test/precedence.test.ts` | 7 and 5 tests |
| `bench/` | The counterfactual in workerd: this ledger against the frozen as-built one (`bench/asbuilt/`, `dc2a1c3`) |

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
- **Checkpoints.** After every 256 segments, when the segment just written ends at the
  committed version, the drain also writes `ckpt-{version}.jsonl`: the whole state at that
  version, read in the same synchronous step that fixed the segment's bounds.
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
  commits and nothing is served.
- **Storage that is not new and has no incarnation** (a schema version row and no
  `meta.incarnation`) is refused, never rebuilt over.
- **Versioned storage** (`contracts/COMPATIBILITY.md` §2, D24): `ledger.Ledger` version 1
  through `contracts/schema.ts`; it adopts the pre-versioning schema unchanged and adds
  `prec`/`prec_lo` to objects from before D22. Storage of a newer release is refused on
  every entry point with `schema_too_new`, writing nothing, the alarm re-armed. Readers of
  the log refuse an unknown segment `v`, header `kind`, change `v` or change `kind`, in both
  layouts (`unsupportedLedgerChange`, `decodeLedgerSegment`).
- **Tenant ids** must match `TENANT_ID`; an object addressed by another name refuses
  everything.
- **In memory** only hints: whether a start is running, the alarm time this object set,
  the drain's backoff, the last error and counters for `logStatus`. Storage is the truth.

`LedgerAdminRpc`: `drain()` → `{ written }`, `outboxDepth()`, `rebuildFromLog()` (on empty
storage only), `logStatus()` (phase, incarnation, version, logged-through, pending, the
segment in flight, segments since the last checkpoint, alarm, last error, write times).

## Rebuild: what it guarantees

- The live files (with index fragments, precedence and unit), streams (with previous
  incarnation), tombstones and version equal the state after the last change in a written
  segment. Tested by comparison with a second object of the same tenant that has empty
  storage and reads the same R2 log (`LedgerReplica` in the tests), and after storage loss.
- No watermark comes back lower than a logged watermark any shard was ever given.
- A `(ledgerIncarnation, version)` pair is never used for two different changes, and an
  incarnation number never for two histories (its base is in R2 first).
- It refuses, and the object serves nothing, if R2 cannot be read, the log has a gap or
  overlap, a segment is corrupt or of an unknown version or kind, or a change does not fit
  the state before it. An unreadable checkpoint is passed over for an older one or the base.
- Changes committed but not yet in a segment are lost (one drain cycle). An unlogged unit
  must be re-sent (the shard still holds its rows; flush notices the watermark went back).

**Time.** Measured on Cloudflare (`spikes/s4-ledger-scale/`, 2026-11-19): 5,008 changes in
104 segments, no checkpoint, rebuilt in 5.4 s; a base of 5,000 files alone in 2.8–3.5 s; the
first layout, 608 per-change objects, in 28.7 s. A checkpoint every 256 segments bounds the
segments a rebuild reads; a reset during a rebuild starts it again (progress is not kept).

## How it was verified

```
npm install
npx vitest run --maxWorkers=2     # 79 tests in workerd, 5 files
npx tsc --noEmit                  # clean
node scripts/mutants.mjs          # on a copy outside the git checkout (see the script)
npm run bench                     # the workerd counterfactual (bench/)
```

Last run, 2026-11-19 on the shared machine (load average 5 to 23): **79 passed, 0 failed**;
`tsc --noEmit` clean. Before that run the suite failed 4 rebuild tests by timeout: they take
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


<<MUTANTS>>

## Not implemented

- **Pruning the log.** No segment, checkpoint or old incarnation is ever deleted from R2
  (LEDGER-LOG.md, "Truncation").
- **Keeping rebuild progress.** A reset during a rebuild starts it again from the newest
  checkpoint.
- **The alert** the design asks for when a stream changes incarnation (the boundary is
  recorded as a `register_stream` change with `previousIncarnation`; nothing is raised).
- **Paging `plan`**, and plans that reference consolidated partition indexes instead of
  carrying every index fragment (S4: 5.8 MB at 7,000 files).
- **Registration before the first write** (spec F1); see the F6 risk below.

## Known risks

- **F6, liveness after a shard's storage loss.** A shard that lost its storage starts a
  new incarnation, but the ledger hears of it only when flush registers it at that
  incarnation's first flush. Until then a query names the old incarnation and the shard
  answers `incarnation_mismatch`; a shard that gets no new writes is never flushed, so the
  refusal lasts indefinitely. Closing it needs registration before writes (spec F1): the
  shard registers its new incarnation with each tenant's ledger before acknowledging the
  first append of the stream, the ledger records it, flush stops being the registrar, and
  query treats a registered incarnation with watermark 0 as empty. That touches shard,
  ledger, flush and query; it is described here, not built.
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
- **shard, flush, query**: registration before writes, for F6 (above).

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
