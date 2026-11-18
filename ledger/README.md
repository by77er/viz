# Ledger

The tenant ledger: one SQLite Durable Object per tenant (the tenant is the object's name).
It holds the tenant's live data files and one watermark per shard stream, and is the only
authority on what is visible. It implements `LedgerRpc` from `contracts/ledger.ts`.

| File | Contents |
|---|---|
| `src/ledger.ts` | `Ledger`: register, add unit, plan, replace, expire, logged watermarks, outbox drain, rebuild |
| `src/index.ts` | Worker entry; exports the class |
| `test/ledger.test.ts` | 31 tests, run inside the Workers runtime with a simulated R2 bucket |

Bindings: Durable Object `LEDGER`, R2 bucket `BUCKET`, variable `CELL` (default `cell-0`).

## What is implemented

- **One transaction per change.** Each mutation changes the live set, bumps the version and
  puts the `LedgerChange` in an outbox inside one `transactionSync`.
- **`addUnit`.** Admitted only if the stream is registered with that incarnation and
  `seqLo === watermark + 1`. All files and the watermark move together. Every file is
  validated, and every key checked against the live set, before anything is written.
  - A shard never seen before is registered by its first unit (`seqLo === 1`); any other
    unit from an unknown shard gets `not_contiguous` with watermark 0.
  - A replay (`seqHi <= watermark`, and every file is live and was admitted with this same
    stream and range) gets `ok` and changes nothing. Anything else at or below the watermark
    gets `not_contiguous`.
  - A key that is already live elsewhere, a malformed file or a key repeated inside the
    unit makes the call throw; nothing is admitted.
- **`registerStream`.** Idempotent for the same incarnation, and a retry gets the same
  `previousIncarnation` as the first call. A different incarnation replaces the old one,
  resets the watermark and the logged watermark to 0 and returns the old incarnation.
  Files of the old incarnation stay live.
- **`plan`.** Files of one table overlapping the inclusive range, all watermarks, ledger
  incarnation and version, read with no `await` in between.
- **`replace`.** Swaps iff every key in `remove` is live; otherwise `conflict` with the
  missing keys. A retry of a swap that already happened (all inputs gone, all outputs live)
  gets `ok` with the current version. An output key that is already live throws.
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
  Each incarnation first writes `{CELL}/ledger/tenant={t}/{incarnation}/base.json` (the
  whole state it starts from), so R2 knows every incarnation that ever existed.
- **Rebuild.** `rebuildFromLog()` and the automatic path on start, below.
- **No in-memory state.** Every method reads SQLite. The only non-derived field is a
  promise that serialises drains.

Two extra methods, not in the contract: `outboxDepth()` and `drain()`.

## Rebuild: what it does and does not guarantee

When the object starts on storage that has no ledger incarnation (first use, or storage
loss), it lists R2. With no log it starts incarnation 1, empty. Otherwise it takes the
highest incarnation in R2, loads its `base.json`, applies its changes in version order,
writes a `base.json` for a new incarnation, and only then commits SQLite.
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
npm test          # 31 tests in workerd, 1 file
npm run typecheck
```

Last run: 31 passed, 0 failed, three runs in a row; `tsc --noEmit` clean. R2 failure is
injected by swapping the object's bucket for one whose `put` throws for chosen keys.

Covered: gap, overlap, off-by-one, replay, a different unit below the watermark, stream
independence; a unit with one duplicate or malformed key admits nothing; registration,
auto-registration and the storage-loss handshake; plan range and table filtering, and 50
plans interleaved with 25 adds each seeing files, watermark and version that agree; replace
success, conflict, retry and duplicate output; expire; log contents per kind; logged lagging
committed while R2 is down and catching up from the alarm; a stuck version holding back
later ones; a change written twice; per-tenant prefixes; eviction with and without a
pending outbox; rebuild after storage loss (automatic and explicit), a rebuild of a rebuilt
ledger, the unlogged tail being lost, a log with a hole.

### Mutation checks

Each mutation was applied to `src/ledger.ts` alone, the suite run, and the source restored.

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

## Not implemented

- **Periodic checkpoints** and any pruning of old log objects or old incarnations.
- **The alert** the design asks for when a stream changes incarnation. The boundary is
  recorded (`register_stream` change, `previousIncarnation`); nothing is raised.
- **Callers.** Nothing calls this yet: no flush Worker, no shard handshake, no publisher,
  no orphan sweeper. No notification is sent to the publisher; the R2 log is the only output.
- **Conditional writes** (`If-None-Match`) on log and base objects. One object per tenant
  and identical bytes on rewrite make them unnecessary today.
- **Load.** Nothing was run under load or on Cloudflare. Plan latency with 300k files and
  1,000 units a minute (S4 in the verification plan) are unmeasured.

## Known risks

- **The log write is on the request path.** Each mutation waits for its R2 write (or its
  failure) before answering. With R2 slow, `addUnit` is slow; it does not fail.
- **A broken log bricks a lost ledger.** If storage is lost and the log has a hole, the
  object refuses to start until someone repairs R2. That is deliberate, and has no tooling.
- **Replay after compaction.** A unit re-sent after its files were compacted or expired is
  not recognised and gets `not_contiguous` with a watermark at or above its `seqHi`. The
  caller must read that as already recorded.
- **Keys are unique only among live files.** A key removed by `replace` or `expire` could be
  admitted again. Keys contain a content hash and a sequence range, so this needs a caller bug.
- **Any different incarnation replaces a stream**, including a lower, stale one, as
  specified. Shard incarnations are time-based, so the ledger could refuse lower ones; it
  does not, because the contract does not say incarnations are ordered.
- **Size.** `base.json` and each change are single JSON objects built in memory; plans
  return every matching file in one RPC result. No paging anywhere.
- **Tenant names** are used unescaped in R2 keys. Names containing `/` are refused; other
  characters are not checked.
- **Clock.** `LedgerChange.at` is `Date.now()` and is not used for ordering.

## Contract issues

Found against `contracts/ledger.ts`; the contract was not edited.

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
