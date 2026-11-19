# The ledger's change log: segments

Status: **built** (`ledger/src/ledger.ts`, 2026-11-18; revised 2026-11-19 after the review
`design/reviews/segment-log-and-compaction.md`: checkpoint policy, the size limit, refusal of
mixed layouts, the forward-only boundary; and again on 2026-11-19 for S-2's full fix:
checkpoints in parts, a rebuild that streams into SQLite, the size limit raised, D47). It replaces the first layout, one R2 object per
change, which made every mutation wait for its own R2 write and limited a ledger to about one
flush unit per second. Measured before and after on Cloudflare in
`spikes/s4-ledger-scale/README.md` ("Re-run after the segment log"); decision D36. Two
findings of the protocol model (`spec/README.md`, F10 and F11) are fixed in this text; the
plan before them is in git history.

## What changes

| | First layout | Segments |
|---|---|---|
| When a mutation answers | after its change is written to R2 | after its SQLite transaction commits |
| What is written to R2 | one object per change | one **segment** per drain, holding every pending change |
| Who waits on R2 | the caller of every mutation | nobody; the object's alarm |
| What a shard may discard | up to the logged watermark | unchanged |

## Segments

A segment is one immutable R2 object holding consecutive changes of one ledger incarnation
(keys in `contracts/ledger.ts`; all keys are under `{cell}/`):

```
ledger/tenant={tenant}/{ledgerIncarnation}/seg-{firstVersion:012}-{lastVersion:012}.jsonl
```

- The body is JSON Lines. Line 1 is a header, `LedgerSegmentHeader`:
  `{"v":1,"kind":"viz.ledger.segment","tenant":…,"ledgerIncarnation":…,"firstVersion":…,"lastVersion":…,"changes":…}`.
  Then one `LedgerChange` per line, in version order, `firstVersion` to `lastVersion` with no
  gap. Every line ends in `\n`. `encodeLedgerSegment` / `decodeLedgerSegment` are the codec.
- A segment is written with `If-None-Match: *`. If the key exists its bytes must be
  identical; anything else is a fault to report, never to overwrite.
- Segments of one incarnation never overlap and never leave a gap: the next segment's
  `firstVersion` is the previous `lastVersion + 1`. Listing the prefix in key order gives the
  changes in version order.
- A segment holds at most 4 MiB of changes (`LEDGER_SEGMENT_MAX_BYTES`); a drain with more
  pending writes several, in order. One change larger than that is a segment on its own.

## The base, and when an incarnation starts

- The first line of an incarnation's first segment is its `base` (kind `base`): the whole
  live set and every stream's watermark at `version`, the version the incarnation starts
  from. Its first change is `version + 1`. There is no `base.json`.
- **The base segment is in R2 before the incarnation commits or serves anything.** It is
  written alone, as `seg-{v}-{v}`, when the object starts on storage that has no
  incarnation (a new tenant, or storage loss), or on storage whose incarnation uses the
  first layout. Otherwise two storage losses before a first drain could start the same
  incarnation number twice with different contents (`spec/README.md` F11).
- A base carries, optionally, what a rebuild needs to come back exactly: each stream's
  `previousIncarnations`, the `tombstones` of removed files, and the flush `units` files came
  from. Readers that do not need them ignore them.

## Drain

- A mutation commits its change to the outbox table in the same transaction as the
  mutation, sets the object's alarm if none is set (`drainDelayMs` ahead, default 200 ms),
  and answers. The alarm is the only one the ledger keeps; it is deleted when nothing is
  pending.
- The drain (alarm, or `drain()`; one at a time) takes the pending rows from the lowest
  version up to 4 MiB, **records the segment's `[first, last]` in SQLite and waits for that
  to be durable**, writes the segment, and then, in one transaction, deletes those rows,
  advances each stream's `logged` mark and clears the record. It repeats while rows are
  pending (at most 16 segments per alarm, then it re-arms).
- **A retry writes exactly the recorded segment first**, whatever has committed since. The
  key and the bytes are functions of the recorded rows, so it is the same object and
  `If-None-Match` finds it identical. (Taking "every pending row" again would write an
  overlapping segment, which a strict rebuild refuses: `spec/README.md` F10.)
- A failed write leaves rows and record in place and re-arms the alarm with backoff (1 s
  doubling to 60 s). An existing object with other bytes, a record whose rows are gone, or an
  outbox that does not continue the written log stops the drain: nothing is overwritten,
  `logStatus()` reports phase `stuck` and why, the alarm retries every 60 s, and
  `loggedWatermarks()` stops advancing, so shards keep their rows. One such case is healed
  at once: the outbox does not continue the log AND the incarnation's prefix holds
  first-layout objects, the signature of a rollback to the release that drains the first
  layout (below, "Versions"). SQLite holds every committed change, so the ledger starts a new
  incarnation from SQLite, its base in R2 first, and loses nothing a shard was told (the
  protocol model checks this fix, `spec/README.md`). Otherwise an operator repairs R2 or calls
  `restartFromSqlite()`, which does the same.
- While a drain is in flight new mutations keep committing; they go in the next segment.

## Checkpoints

- **When.** After at least 256 segments of an incarnation, **and** once the segments written
  since the last checkpoint (or the base) are at least as large as it, the drain takes a
  checkpoint of the state at `version`, the `lastVersion` of the segment it is writing, which
  must end at the committed version. Tying checkpoints to the log's volume, not to the write
  rate, keeps their R2 bytes at most those of the log (review S-2). One checkpoint at a time.
- **Format 1** (a state no larger than one part, `LEDGER_CHECKPOINT_PART_MAX_BYTES`, 1 MiB,
  estimated): `ckpt-{version:012}.jsonl`, a header of kind `viz.ledger.checkpoint` with `v` 1
  and one line, a `base`-kind change holding the whole state. Built in the synchronous step
  that fixes the segment's bounds and written after that segment, as before.
- **Format 2** (any larger state; D47). Nothing builds the state at once:
  - The drain only **begins** the checkpoint in that synchronous step: it records the version,
    the streams at that version and a new 8-hex-digit `attempt` in SQLite (table `ckpt`).
  - Later drain steps write **parts**, `ckpt-{version:012}-{attempt}/{part:06}.jsonl`, one
    PUT each, at most 8 per alarm and always after any pending segment: a header
    (`LedgerCheckpointPartHeader`, kind `viz.ledger.checkpoint.part`, `v` 2) and up to 1 MiB
    of record lines, each `{"file": LiveFile with its unit}` or `{"tombstone": Tombstone}`;
    a single larger record goes alone. Files come first, in SQLite's key order (UTF-8 bytes),
    then tombstones of removals at or below `version`, in key order. Each part is built in one
    synchronous step from SQLite; its cursor is recorded only after its PUT returned.
  - **The state at `version`, not now.** A mutation committed while a checkpoint is reading
    files records, in its own transaction, the pre-image of every file it removes or adds
    ahead of the checkpoint's cursor (table `ckpt_pre`: the row as it was, or "not live then");
    a part reads live rows and pre-images merged by key. Every mutation also advances
    `ckpt.tracked`; a checkpoint whose `tracked` is behind the committed version (a release
    that does not know this ran on the storage) is **abandoned**, never written.
  - Once every part is written and the log has reached `version`, the drain writes the
    **manifest**, `ckpt-{version:012}.jsonl` with `If-None-Match: *`: a header (`v` 2) and one
    `LedgerCheckpointManifest` line naming the attempt, the number of parts, the files and
    tombstones they hold, and the streams. **A checkpoint without a manifest does not exist.**
    The manifest's bytes are a function of SQLite, so a retry after a lost answer writes the
    same bytes.
  - A failed part or manifest write never fails or delays the log: it is retried from where it
    stood after a backoff (1 s doubling to 60 s). An eviction resumes it from SQLite.
- A checkpoint is only an accelerator for a rebuild. Nothing else reads it, and a log with no
  checkpoint, or with a bad one, rebuilds from an older checkpoint or the base.

## Size

Nothing holds the whole state: checkpoints are written in parts (above), a new incarnation's
base is written from SQLite in pieces (measured once, then streamed into one conditional PUT of
that length), and a rebuild streams the base or a checkpoint into SQLite (below). What grows
with the state is **time**: a rebuild or a new incarnation reads and writes the whole state
while requests are refused, retryably. `addUnit` answers `full` (nothing changed, retryable)
once the state, estimated as each live file's key and index fragment plus 448 bytes, would
exceed 300 MiB (`STATE_MAX_BYTES`; about 300,000 files of S4's shape, the largest state
measured). `replace` and `expire` are never refused, so compaction and retention make room.
Measured in workerd (2026-11-19, `ledger/bench/checkpoint.bench.test.ts`, the release before as
the counterfactual on the same data): at 100,000 files a checkpoint blocked the object for
2 ms at a time instead of 0.93 s and added 14 MB of process memory instead of 410 MB; at
300,000 files (this release only) a checkpoint took 9.3 s in 272 parts, a rebuild 20 s, and the
process peaked at 536 MB (`ledger/README.md`). Not measured on Cloudflare. **The publisher
still reads a new incarnation's base whole** (`publisher/src/log.ts`): until it reads it with
`readLedgerLogStream`, a state above about 16 MiB can make a publisher re-base fail
(`ledger/README.md`, "Needed changes elsewhere").

## Logged

`loggedWatermarks()` is, per stream, the watermark as of the highest version all of whose
predecessors are in a written segment (the contiguous prefix). Segments are written in
order and a row is deleted only with its segment, so "logged" is "every version below the
first outbox row". It lags the committed watermark by up to one drain cycle.

## Truncation: what may be dropped, and when

- **Outbox rows** are deleted only in the transaction that records their segment as
  written: its PUT returned, or an identical object was found. Never before, never by age,
  never after a failure. The segment record goes in the same transaction.
- **On a new incarnation** every outbox row is dropped in the transaction that commits the
  incarnation: a rebuilt ledger has none, and a ledger converted from the first layout has
  their effect in the new base, which is already in R2.
- **Checkpoints** are deleted once a newer checkpoint of their incarnation is complete, its
  manifest in R2 (only the ledger's rebuild reads them): first the older manifests, then every
  part that is not the new checkpoint's (older checkpoints' parts, and abandoned attempts'), so
  no listed manifest ever names a part that is gone. Never before: while a newer one is being
  written, the older one is what a rebuild uses. A failure leaves the rest for the next one.
- **Other R2 log objects** are never deleted by the ledger. A segment of an incarnation below
  its newest checkpoint is needed only by readers whose cursor is below that checkpoint, and
  an old incarnation only by readers that have not re-based on a newer one. Deleting those
  (when every reader's cursor is past them) is not built.
- What shards may discard (up to `loggedWatermarks()`) and what the janitor may delete
  (tombstones whose removing version is below the first outbox row) follow from "logged"
  above and do not change.

## Readers of the log

Each incarnation uses one layout. A reader lists `{incarnation}/seg-` (one key is enough):
any segment means segments; otherwise the incarnation is in the first layout (`base.json`
and `{version}.json`, read as before). Both present is corrupt, and is checked, not assumed:
`{version}.json` keys sort before `base.json`, `ckpt-` and `seg-`, so the first key under the
incarnation's prefix says whether any is there. The ledger's rebuild refuses such an
incarnation (phase `stuck`), never replays one layout and skips the other (review S-1).

- **Rebuild** (the ledger, on storage with no incarnation): take the newest incarnation in
  R2. In the first layout, replay `base.json` and its changes as before. With segments,
  start from the newest checkpoint that can be read whole (format 2: the manifest, then every
  part, checked against it; one that cannot is passed over, and what it loaded is emptied), else
  the first segment, whose first line must be the base; list the segments that start after it,
  require each to begin at the previous end + 1, decode each strictly, and replay. All of it
  goes **into SQLite as it is read**, never into a state held in memory: a part at a time, a
  base line element by element (`readLedgerLogStream`, `JsonObjectStream`), in transactions of
  a few hundred rows; segments a few ahead, at most 8 MiB in flight. A gap, a corrupt object or an unsupported one
  refuses the rebuild: the object serves nothing rather than a guess. Then a new
  incarnation starts, with its base segment. Changes committed but not yet in a segment
  when storage was lost are lost, as before; the window is one drain cycle. With NO log in
  R2 the ledger starts empty only if the tenant has no data objects either; otherwise the log
  is not where it looks (a changed cell, a wrong bucket) and it refuses (review S-5).
- **The publisher** keeps a cursor `(ledgerIncarnation, version)`. On a newer incarnation it
  re-bases from that incarnation's base (first line of the first segment). Otherwise it
  lists with `startAfter: ledgerSegmentsStartingAfter(tenant, incarnation, version)`, which
  returns exactly the segments that start after the cursor. If the first one starts above
  `version + 1`, the cursor is inside a segment (or there is a gap): list again from the
  incarnation's first segment and find the one with `first ≤ version + 1 ≤ last`; if none, it
  is a gap. It applies the changes above the cursor, in order, and advances only over whole
  segments. A gap, a corrupt or an unsupported segment stops that tenant before it; it is
  never skipped. (Built: `publisher/src/log.ts`, `publisher/README.md`.) A new incarnation's
  base can be behind the last segment of the incarnation before it: a PUT in flight when an
  instance died can land after the rebuild listed (review S-8). So a publisher re-bases on a
  new incarnation by replacing its state with the base, never by assuming the base extends
  its cursor; versions of such a late segment recur in the new incarnation with other
  content.
- Readers verify each segment against its key (`decodeLedgerSegment(body, parseLedgerLogKey(key))`).

## Versions

- The segment header's `v` is the format version: 1 here (`LEDGER_SEGMENT_VERSION`). A
  checkpoint's is 1 or 2 (`LEDGER_CHECKPOINT_VERSION`, above); this release writes both
  (format 1 for a state of one part or less) and reads both. **Format 2 needed no
  readers-first release:** a reader that knows only format 1 (the release before) sees its
  manifest as `unsupported` and passes over it for an older checkpoint or the base, which is
  always there, so it still rebuilds exactly (tested, `ledger/test/checkpoint.test.ts`); the
  publisher never reads checkpoints, and part keys parse as nothing to an older
  `parseLedgerLogKey`. The schema change that goes with it (migration 3: tables `ckpt` and
  `ckpt_pre`) is additive (`readableFrom` 2), so the release before stays a rollback target;
  a checkpoint it leaves untracked is abandoned. A state above 16 MiB cannot be rebuilt by that
  release in one isolate, so after a rollback such a tenant is stuck, not lost, until rolled
  forward. Each change line is a `LedgerChange` whose own version is `v`
  on the line, absent meaning 1 (`LEDGER_CHANGE_VERSION`). A reader refuses an unknown
  segment `v`, change `v`, header `kind` or change `kind` (`unsupported`), and ignores fields
  it does not know (contracts/COMPATIBILITY.md §3.2).
- New optional fields (on the header, on a change, on a base) are additive. A change in how
  a line or a key is encoded is a new `v`, written only after every reader of the log reads
  it (§3.3: the ledger's own rebuild and the publisher).
- **Rollout of this layout.** The ledger reads both layouts and writes segments in the same
  release. COMPATIBILITY.md §3.3 and §7 ask for two releases (readers first) where an older
  release could be rolled back to; on 2026-11-18 no release of the ledger had reached
  production (the account's Worker list had no `viz-ingest`), so there was none. Any
  deployment that ran the first layout (the trial stage) crosses a forward-only boundary.
  The boundary is in the storage: schema migration 2 (`ledger.Ledger`) has `readableFrom`
  2, so versioned code that knows only version 1 refuses this storage (`schema_too_new`).
  Code from before versioning cannot read a version row; keeping it out is the release
  record's job (COMPATIBILITY.md §6; `deploy/` must mark this release forward-only). If such
  a rollback happens anyway, it drains per-change objects into a segment incarnation and
  tells shards they are logged; after the roll-forward the drain heals it from SQLite (Drain,
  above), and a rebuild before that refuses the mixed incarnation: stuck, not lost (review
  S-1). The publisher reads segments (built).

## What callers see

- `addUnit`, `replace`, `expire` and `registerStream` return as soon as the change is
  committed. Their `version` is the committed version.
- `loggedWatermarks()` keeps its meaning (above). `flush` acknowledges the shard with
  whatever it says, which may not include the unit just admitted; the run then ends
  `awaitingLog` and its queue message is retried (flush/README.md), which records it.
- Physical deletion of removed files waits for the removal to be in a written segment, as
  before.

## Also changing with this

- `LedgerChange.removedFiles` lists each removed key with its table (reported by the
  publisher's builder). It is added beside `removed`, not in place of it: changing
  `removed`'s type would repurpose a field (COMPATIBILITY.md §4).
- Not done here: `plan` returning index fragments inline only for small plans, with
  references to consolidated partition indexes otherwise, and a `cursor`. That changes the
  query Worker's side too and is a separate change (`design/DESIGN.md` §13).

## What has to be shown, and where it is

- A ledger admits at least 50 units per second on Cloudflare with eight writers, and
  `addUnit` answers in under 20 ms at the median: `spikes/s4-ledger-scale/README.md`.
  **Measured 2026-11-19** (three 20 s runs): 234–422 units per second, met; median 16, 21
  and 31 ms, met in one run of three. A rebuild of 5,008 changes from 104 segments took
  5.4 s.
- Under injected crashes between commit, segment write and row deletion, replaying the
  segments reproduces the committed state up to the last written segment, and no shard is
  ever told to discard past it: `ledger/test/segments.test.ts`. Shown, with mutants of each
  rule (`ledger/README.md`).
- A fresh object with empty storage reconstructs exactly the state of a live one:
  `ledger/test/segments.test.ts`. Shown, also from checkpoints and past an unreadable one.
- The publisher and an independent reader see the same table before and after the change
  of log format: not shown here. The publisher now reads both layouts
  (`publisher/README.md`, "Reading the log"); the comparison is the publisher's to show.
