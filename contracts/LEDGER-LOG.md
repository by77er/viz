# The ledger's change log: segments

Status: **built** (`ledger/src/ledger.ts`, 2026-11-18). It replaces the first layout, one R2
object per change, which made every mutation wait for its own R2 write and limited a ledger
to about one flush unit per second (`spikes/s4-ledger-scale/`). Measurements before and after
are in `ledger/README.md`. Two findings of the protocol model (`spec/README.md`, F10 and
F11) are fixed in this text; the plan before them is in git history.

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
  doubling to 60 s). An existing object with other bytes, or a record whose rows are gone,
  stops the drain: nothing is overwritten, `logStatus()` reports it, the alarm retries
  every 60 s, and `loggedWatermarks()` stops advancing, so shards keep their rows.
- While a drain is in flight new mutations keep committing; they go in the next segment.

## Checkpoints

- After every 256 segments of an incarnation, the drain also writes
  `ckpt-{version:012}.jsonl`: a header of kind `viz.ledger.checkpoint` and one line, a
  `base`-kind change holding the whole state at `version`, which is the `lastVersion` of the
  segment just written. The state is read in the same synchronous step that fixes that
  segment's bounds, so it is exactly the state at that version.
- A checkpoint is only an accelerator for a rebuild. Nothing else reads it, and a log with
  no checkpoint, or with a bad one, rebuilds from the base.

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
- **R2 log objects** are never deleted by the ledger. A segment or checkpoint of an
  incarnation below its newest checkpoint is needed only by readers whose cursor is below
  that checkpoint, and an old incarnation only by readers that have not re-based on a newer
  one. Deleting those (when every reader's cursor is past them) is not built.
- What shards may discard (up to `loggedWatermarks()`) and what the janitor may delete
  (tombstones whose removing version is below the first outbox row) follow from "logged"
  above and do not change.

## Readers of the log

Each incarnation uses one layout. A reader lists `{incarnation}/seg-` (one key is enough):
any segment means segments; otherwise the incarnation is in the first layout (`base.json`
and `{version}.json`, read as before). Both present is corrupt.

- **Rebuild** (the ledger, on storage with no incarnation): take the newest incarnation in
  R2. In the first layout, replay `base.json` and its changes as before. With segments,
  start from the newest checkpoint (if any; else the first segment, whose first line must be
  the base), list the segments that start after it, require each to begin at the previous
  end + 1, decode each strictly, and replay. A gap, a corrupt object or an unsupported one
  refuses the rebuild: the object serves nothing rather than a guess. Then a new
  incarnation starts, with its base segment. Changes committed but not yet in a segment
  when storage was lost are lost, as before; the window is one drain cycle.
- **The publisher** keeps a cursor `(ledgerIncarnation, version)`. On a newer incarnation it
  re-bases from that incarnation's base (first line of the first segment). Otherwise it
  lists with `startAfter: ledgerSegmentsStartingAfter(tenant, incarnation, version)`, which
  returns exactly the segments that start after the cursor. If the first one starts above
  `version + 1`, the cursor is inside a segment (or there is a gap): list again from the
  incarnation's first segment and find the one with `first ≤ version + 1 ≤ last`; if none, it
  is a gap. It applies the changes above the cursor, in order, and advances only over whole
  segments. A gap, a corrupt or an unsupported segment stops that tenant before it; it is
  never skipped. The exact change to `publisher/src/log.ts` is in `ledger/README.md`,
  "Needed changes".
- Readers verify each segment against its key (`decodeLedgerSegment(body, parseLedgerLogKey(key))`).

## Versions

- The segment and checkpoint header's `v` is the format version: 1 here
  (`LEDGER_SEGMENT_VERSION`). Each change line is a `LedgerChange` whose own version is `v`
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
  deployment that ran the first layout (the trial stage) crosses a forward-only boundary:
  rolling it back below this release leaves its ledgers unable to rebuild from R2 until
  rolled forward (stuck, not lost: COMPATIBILITY.md §9). The publisher must read segments
  before it is deployed (it is not deployed yet).

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
- Under injected crashes between commit, segment write and row deletion, replaying the
  segments reproduces the committed state up to the last written segment, and no shard is
  ever told to discard past it: `ledger/test/segments.test.ts`.
- A fresh object with empty storage reconstructs exactly the state of a live one:
  `ledger/test/segments.test.ts`.
- The publisher and an independent reader see the same table before and after the change
  of log format: not shown; it needs the publisher's reader (`ledger/README.md`, "Needed
  changes").
