# The ledger's change log: segments (planned; replaces one object per change)

Status: **planned, not built.** The ledger as built writes one R2 object per change and
waits for it before answering, which limits it to about one flush unit per second
(`spikes/s4-ledger-scale/`). This file is the contract for the replacement, so the ledger,
the publisher and the rebuild path can change together.

## What changes

| | As built | Planned |
|---|---|---|
| When a mutation answers | after its change is written to R2 | after its SQLite transaction commits |
| What is written to R2 | one object per change | one **segment** per drain, holding every pending change |
| Who waits on R2 | the caller of every mutation | nobody; a background drain |
| What a shard may discard | up to the logged watermark | unchanged |

## Segments

A segment is one immutable R2 object holding consecutive changes of one ledger incarnation:

```
{cell}/ledger/tenant={tenant}/{ledgerIncarnation}/seg-{firstVersion:012}-{lastVersion:012}.jsonl
```

- The body is JSON Lines: one `LedgerChange` (`contracts/ledger.ts`) per line, in version
  order, with no gaps between `firstVersion` and `lastVersion`.
- A segment is written with `If-None-Match: *`. If the key exists, its content must be
  identical; anything else is a fault to report, not to overwrite.
- Segments of one incarnation never overlap and never leave a gap: the next segment's
  `firstVersion` is the previous `lastVersion + 1`. Listing the prefix in key order gives
  the changes in version order.
- The first change of an incarnation is its `base`. There is no separate `base.json`.
- A segment is at most 4 MiB. A drain with more pending than that writes several, in order.

## Drain

- A mutation commits its change to the outbox table in the same transaction as the
  mutation, sets the object's alarm if none is set (a few hundred milliseconds ahead), and
  answers.
- The drain (alarm, or an explicit `drain()`) reads every pending row, writes one segment,
  and in one transaction deletes those rows and advances each stream's `logged` mark. Only
  one drain runs at a time.
- A failed write leaves the rows in place and re-arms the alarm with backoff. Because the
  key is derived from the versions it holds and the body from the rows, a retry writes the
  same object.
- While a drain is in flight, new mutations keep committing; they go in the next segment.
  Under load the ledger therefore writes about two segments a second regardless of how
  many mutations arrive.

## What callers see

- `addUnit`, `replace` and `expire` return as soon as the change is committed. Their
  `version` is the committed version.
- `loggedWatermarks()` is unchanged in meaning: the highest sequence per stream whose
  change is in a written segment. It now lags the committed watermark by up to one drain
  cycle.
- `flush` no longer learns the logged watermark in the same call. It acknowledges the
  shard with whatever `loggedWatermarks()` says, which may be the previous unit; the shard
  simply keeps the newest segment a little longer. A shard with recorded-but-unlogged
  segments is told again on the next flush, or by the sweep.
- Physical deletion of removed files waits for the removal to be in a written segment, as
  now.

## Readers of the log

- **Rebuild** lists the newest incarnation's segments, replays them in order, and refuses
  on a gap. Changes committed but not yet in a segment when storage was lost are lost, as
  now; the window is one drain cycle instead of one change.
- **The publisher** keeps a cursor `(ledgerIncarnation, version)`. It lists segments whose
  `lastVersion` is above the cursor, and applies the changes above it in order. A gap
  stops that tenant, as now.
- Old per-change objects (`{version:012}.json`) are read by neither. A ledger that has them
  writes a fresh `base` in a new incarnation on first start under the new code.

## Also changing with this

- `LedgerChange.removed` becomes a list of `{ key, table }`, so a reader does not have to
  remember which table a removed key belonged to (reported by the publisher's builder).
- `plan` returns index fragments inline only when the plan holds at most 200 files;
  otherwise each file carries a reference to its partition's consolidated index object,
  and `plan` takes a `cursor` so no call can approach the message limit.

## What has to be shown

- A ledger admits at least 50 units per second on Cloudflare with eight writers, and
  `addUnit` answers in under 20 ms at the median.
- Under injected crashes between commit, segment write and row deletion, replaying the
  segments reproduces the committed state up to the last written segment, and no shard is
  ever told to discard past it.
- The publisher and an independent reader see the same table before and after the change
  of log format.
