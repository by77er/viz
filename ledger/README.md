# Ledger

The tenant ledger: one SQLite Durable Object per tenant (the tenant is the object's name).
It holds the tenant's live data files and one watermark per shard stream, and is the only
authority on what is visible. It implements `LedgerRpc` and `LedgerAdminRpc` from `contracts/ledger.ts` (v2).

| File | Contents |
|---|---|
| `src/ledger.ts` | `Ledger`: register, add unit, plan, replace, expire, logged watermarks, outbox drain, rebuild |
| `src/index.ts` | Worker entry; exports the class |
| `scripts/mutants.mjs` | Mutation check for the contracts v2 behaviour |
| `test/ledger.test.ts` | 38 tests, run inside the Workers runtime with a simulated R2 bucket |
| `test/tombstone.test.ts` | 7 tests of the tombstone surface |
| `test/precedence.test.ts` | 5 tests of file precedence |

Bindings: Durable Object `LEDGER`, R2 bucket `BUCKET`, variable `CELL` (default `cell-0`).

## What is implemented

- **One transaction per change.** Each mutation changes the live set, bumps the version and
  puts the `LedgerChange` in an outbox inside one `transactionSync`.
- **`addUnit`.** Admitted only if the stream is registered with that incarnation and
  `seqLo === watermark + 1`. All files and the watermark move together. Every file is
  validated, and every key checked against the live set, before anything is written.
  - A shard never seen before is registered by its first unit (`seqLo === 1`); any other
    unit from an unknown shard gets `not_contiguous` with watermark 0.
  - **Replay rule (v2).** Any unit with `seqHi <= watermark` for the registered incarnation
    gets `ok` and changes nothing, whether or not its files are still live (they may have
    been compacted or expired) and whatever files it names: the rows through `seqHi` are
    already in listed files. A unit that straddles the watermark gets `not_contiguous`.
  - **`invalid` (v2).** A malformed stream reference or sequence range, a malformed file, a
    key repeated inside the unit, an empty unit, or a key that is already live elsewhere
    returns `{ status: 'invalid', reason }`. Nothing is admitted and nothing throws. The
    unit is judged before the stream, so an invalid unit is `invalid` even where a valid
    one would be a replay.
- **`registerStream`.** Idempotent for the same incarnation, and a retry gets the same
  `previousIncarnation` as the first call. A **higher** incarnation replaces the old one,
  resets the watermark and the logged watermark to 0 and returns the old incarnation.
  Files of the old incarnation stay live. A **lower** incarnation is refused (v2:
  incarnations are ordered): `registerStream` throws, `addUnit` answers
  `incarnation_mismatch` with the registered one, and nothing changes.
- **`plan`.** Files of one table overlapping the inclusive range, **in ascending
  precedence** (below), all watermarks, ledger incarnation and version, read with no
  `await` in between.
- **`replace`.** Swaps iff every key in `remove` is live; otherwise `conflict` with the
  missing keys. A retry of a swap that already happened (every output live, no input live)
  gets `ok` with the current version; anything else is judged as a new request. A malformed
  request, a key in both lists, or an output key that is already live returns
  `{ status: 'invalid', reason }`.
- **`expire`.** Removes files of the table with `day < beforeDay`, returns the keys. If
  nothing matches, no version is used and nothing is logged.
- **Change log.** `drain` writes outbox rows to R2 at
  `{CELL}/` + `ledgerLogKey(tenant, ledgerIncarnation, version)`, lowest version first, and
  deletes a row only after its write returned. A failed write stops the drain there, so the
  log has no hole below its highest object. It runs after every mutation and from an alarm
  that is set with every mutation and re-set while writes fail. A mutation succeeds whether
  or not R2 is reachable.
- **`loggedWatermarks`.** Per stream, the highest watermark whose change is in R2. It is a
  separate column, advanced only by the drain.
- **Ledger incarnation.** Starts at 1 and is one more than the highest incarnation in R2.
  Each incarnation first writes, at `{CELL}/` + `ledgerBaseKey(tenant, incarnation)`, a
  **`base` `LedgerChange`** and nothing but that shape: `kind: 'base'`, `added` = the whole
  live set as `FileEntry` objects, `removed: []`, `watermarks` = every stream, and
  `version` = the version the incarnation starts from (its first change is `version + 1`).
  This happens before the object serves anything, for a brand-new tenant too.
- **`add_unit` changes carry `unit: { seqLo, seqHi }`.** Replay checks it against the
  watermark and fails on a mismatch instead of inferring `seqLo`.
- **Tenant ids** must match `TENANT_ID` (`[A-Za-z0-9_-]{1,64}`); an object addressed by any
  other name refuses every call and writes nothing.
- **Rebuild.** `rebuildFromLog()` and the automatic path on start, below.
- **No in-memory state.** Every method reads SQLite. The only non-derived field is a
  promise that serialises drains.

`LedgerAdminRpc`: `drain()` returns `{ written }`, `outboxDepth()`, `rebuildFromLog()`
(returns the contract's fields plus `source`, `changesReplayed`, `files`, `streams`).

## Rebuild: what it does and does not guarantee

When the object starts on storage that has no ledger incarnation (first use, or storage
loss), it lists R2. With no log it starts incarnation 1, empty. Otherwise it takes the
highest incarnation in R2, loads its `base` change (an incarnation with log objects but
no base is an error), applies its changes in version order, writes a `base` for a new
incarnation, and only then commits SQLite. The base holds no per-file unit references and
no `previousIncarnation`: after a rebuild those are only known for changes replayed from
the log, and nothing depends on them any more (the replay rule is the watermark).
`rebuildFromLog()` does the same on demand and refuses unless files, streams and outbox are
all empty.

It guarantees:

- The live files (with index fragments), watermarks and stream incarnations equal the state
  after the last change that reached R2.
- No watermark comes back lower than the `loggedWatermarks` value any shard was ever given.
- A `(ledgerIncarnation, version)` pair is never reused. The version continues from the
  last logged one, so logged versions form one sequence without a hole across incarnations.
- It fails, and the object serves nothing, if R2 cannot be read, the log has a hole, or a
  change does not fit the state before it. It never serves a partial ledger.

It does not guarantee:

- **Changes committed but not yet logged are lost.** An unlogged unit must be re-sent (the
  shard still holds those rows, since it may discard only up to the logged watermark, but
  it may believe they are recorded: the flush side has to notice the watermark went back).
  An unlogged `replace` leaves its inputs live and its outputs orphaned; an unlogged
  `expire` brings files back. A plan handed out at an unlogged version has no counterpart
  in the new incarnation, and the bare version number is used again there.
- **Bounded time.** One R2 read per change since the incarnation started, 6 at a time,
  inside `blockConcurrencyWhile`, which the runtime limits to about 30 seconds. There are no
  periodic checkpoints; a base is written only when an incarnation starts. A long-lived
  incarnation will need them.
- It does not look at data files in R2 and does not check that listed files exist.

## Tests

```
npm install
npm test          # 50 tests in workerd, 3 files
npm run typecheck
```

Last run: 50 passed, 0 failed; `tsc --noEmit` clean. R2 failure is
injected by swapping the object's bucket for one whose `put` throws for chosen keys.

Covered: gap, overlap, off-by-one, replay, a different unit below the watermark, stream
independence; a unit with one duplicate or malformed key admits nothing and answers `invalid`;
the replay rule (any unit at or below the watermark, also after compaction and expiry);
a lower stream incarnation refused; the `base` change's exact shape and key; tenant ids;
unit contiguity checked during replay from `unit.seqLo`; a reader rebuilding the live set
from one incarnation's base and changes; registration,
auto-registration and the storage-loss handshake; plan range and table filtering, and 50
plans interleaved with 25 adds each seeing files, watermark and version that agree; replace
success, conflict, retry and duplicate output; expire; log contents per kind; logged lagging
committed while R2 is down and catching up from the alarm; a stuck version holding back
later ones; a change written twice; per-tenant prefixes; eviction with and without a
pending outbox; rebuild after storage loss (automatic and explicit), a rebuild of a rebuilt
ledger, the unlogged tail being lost, a log with a hole.

### Mutation checks

Each mutation was applied to `src/ledger.ts` alone, the suite run, and the source restored.

**Contracts v2** (`node scripts/mutants.mjs`, run after the v2 changes): **16 of 16 killed.**
A lower stream incarnation registered; an empty unit admitted; a live key not answered
`invalid`; a malformed file throwing instead of `invalid`; a unit below the watermark not a
replay; a unit straddling the watermark taken as one; the base entry not of kind `base`;
the base without watermarks; `add_unit` without `unit`; replay not checking the unit range;
tenant ids not validated; `replace` answering `ok` for a live output; a retried `replace`
not recognised; `drain` returning a bare number; plus two of the original properties again
(`loggedWatermarks` returning the committed watermark; the contiguity check dropped).

**The table below is from before the contracts v2 changes and was not re-run after them**
as a whole (M1 and M3 are the two re-run above). M7 and M14 no longer describe the code: a
duplicate key now returns `invalid`, and "any unit at or below the watermark counts as a
replay" is now the contract's rule rather than a mutant.

| # | Mutation | Result | A test that fails |
|---|---|---|---|
| M1 | drop the `seqLo === watermark + 1` check | killed (3 tests) | admits units that extend the watermark and refuses a gap or an overlap |
| M2 | `replace` ignores missing inputs | killed (3) | reports a conflict, listing the missing inputs, and changes nothing |
| M3 | `loggedWatermarks` returns the committed watermark | killed (4) | reports a watermark as logged only once its change is in R2 |
| M4 | `expire` does not write to the outbox | killed (4) | removes whole days of one table, strictly before the day given |
| M5 | `plan` does not filter by table | killed (8) | returns only files of the table that overlap the inclusive range |
| M6 | `addUnit` ignores the stream incarnation | killed (3) | performs the storage-loss handshake |
| M7 | no duplicate-key check before writing | killed (1), weakly | admits nothing when one file key belongs to another unit |
| M8 | M7 plus `addUnit` writes outside a transaction | killed (1) | same test, on the state assertion: two of the unit's files became live |
| M9 | drain treats a failed R2 write as written | killed (4) | reports a watermark as logged only once its change is in R2 |
| M10 | drain takes the newest outbox row first | killed (1) | never writes a later change before an earlier one |
| M11 | rebuild keeps the old ledger incarnation | killed (4) | never repeats a (ledger incarnation, version), and versions keep counting up |
| M12 | re-registration keeps the old watermark | killed (3) | performs the storage-loss handshake |
| M13 | `plan` tests containment instead of overlap | killed (1) | returns only files of the table that overlap the inclusive range |
| M14 | any unit at or below the watermark counts as a replay | killed (3) | does not mistake a different unit below the watermark for a replay |
| M15 | rebuild ignores removals | killed (2) | reproduces the live set and the watermarks after storage loss |
| M16 | `replace` writes its outbox row after the transaction instead of inside it | **survived** | none |
| M17 | no drain after a commit (alarm only) | killed (19) | writes one change per version, in order, describing each mutation |

M7 is killed only by the error message: with the check removed, the primary key on
`file.key` still rejects the insert and the transaction rolls back. M16 survives because
the tests cannot crash the object between two synchronous statements; with no `await`
between them the runtime commits both together anyway. So "the outbox row is in the same
transaction" is true by reading the code, not by test.

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

## Not implemented

- **Periodic checkpoints** and any pruning of old log objects or old incarnations.
- **The alert** the design asks for when a stream changes incarnation. The boundary is
  recorded (`register_stream` change, `previousIncarnation`); nothing is raised.
- **Callers.** `flush/` calls `addUnit`, `registerStream`, `plan` and `loggedWatermarks`.
  `compact/` calls `replace`; `janitor/` calls `expire` and the tombstone methods.
  There is still no publisher. No notification is sent to the
  publisher; the R2 log is the only output.
- **Conditional writes** (`If-None-Match`) on log and base objects. One object per tenant
  and identical bytes on rewrite make them unnecessary today.
- **Load.** Nothing was run under load or on Cloudflare. Plan latency with 300k files and
  1,000 units a minute (S4 in the verification plan) are unmeasured.

## Known risks

- **The log write is on the request path.** Each mutation waits for its R2 write (or its
  failure) before answering. With R2 slow, `addUnit` is slow; it does not fail.
- **A broken log bricks a lost ledger.** If storage is lost and the log has a hole, the
  object refuses to start until someone repairs R2. That is deliberate, and has no tooling.
- **A replay answers `ok` for files the ledger does not list.** By the v2 replay rule a
  unit at or below the watermark is `ok` whatever keys it names. A caller that wrote
  different bytes for an already-admitted range has orphaned those objects; only the
  orphan sweeper (not built) would remove them.
- **Keys are unique only among live files.** A key removed by `replace` or `expire` could be
  admitted again. Keys contain a content hash and a sequence range, so this needs a caller bug.
- **A refused lower incarnation is an exception**, not a status, in `registerStream`
  (the contract's return type has no refusal).
- **Size.** `base.json` and each change are single JSON objects built in memory; plans
  return every matching file in one RPC result. No paging anywhere.
- **Clock.** `LedgerChange.at` is `Date.now()` and is not used for ordering.

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
