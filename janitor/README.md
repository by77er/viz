# Janitor

Retention and physical deletion for one tenant: three stateless jobs. What was removed,
when, and whether that removal is durably logged is kept by the tenant's ledger
(tombstones; `contracts/ledger.ts`, "PROPOSED ADDITION"; `design/DECISIONS.md` D20).

| File | Contents |
|---|---|
| `src/janitor.ts` | `parseRetention`, `readRetention`, `retentionCutoffDay`, `expireTenant`, `purgeTenant`, `sweepOrphans` |
| `src/formats.ts` | `READS`: the formats the janitor reads, by version (it writes none) |
| `test/janitor.test.ts` | 15 tests in workerd against the real `Shard`, `Ledger`, flush and compaction, and a simulated R2; 3 of them the review's R-1 and the protocol model's F15 |
| `test/golden.test.ts` | 2 tests: the retention record (control's golden files) and the compaction inputs record (compact's) read as an independent reader |

Bindings: `LEDGER`, `BUCKET`, `CONFIG` (KV), `CELL`.

## What is implemented

### `expireTenant(env, tenant, now)`: retention

Reads `retention:<tenant>` from KV (format `kv.settings` v1, written by `control/`:
`{"metric_samples_days": N, …}`; `v` absent means 1; other fields are ignored).

| The record | Result |
|---|---|
| absent | the default policy, 30 days. The default IS the policy of a tenant that has none |
| version 1 with `metric_samples_days` a positive safe integer | that policy |
| anything else: not JSON, not an object, a `v` other than 1, `metric_samples_days` missing, 0, negative, fractional or a string | **refused**: nothing is expired for this tenant, the result carries `refused: <reason>`, and an error is logged. Never the default, which could be shorter than what the tenant asked for (review R-1) |

With a policy of N days it calls **one** `ledger.expire({ tables: [samples, series], beforeDay })`,
`beforeDay` = the UTC day of `now − N days` (`retentionCutoffDay`; a policy reaching before
1970 keeps everything): today and the N days before it are kept, and a samples file and its
series file leave the ledger in the same change (review R-5, `contracts/TABLES.md`, "Pairing").
No object is touched. It returns the cutoff and `keepDays`: day D expires at 00:00 UTC on day
D + keepDays + 1, which is how `stack/` knows when an idle tenant next has anything to expire.

A refusal is visible in three places: the error log of the run; `stack/`'s maintenance marker
(`retention: <reason>`), which the hourly cron lists and logs every hour; and the run is due
again within the hour, so a fixed record is applied within the hour (`stack/src/maintain.ts`).

### `purgeTenant(env, tenant, { graceMs, maxKeys })`: physical deletion of removed files

Deletes the objects of keys the ledger removed, by `expire` or by compaction's `replace`,
exactly those `ledger.deletable({ minAgeMs: graceMs })` returns. The ledger returns a key only
when, in one read:

1. the change that removed it is in the ledger's R2 log, i.e. its version is below the first
   unlogged one (a ledger rebuilt from its log would otherwise list the file again, and the
   object must then still exist);
2. it was removed at least `graceMs` ago by the ledger's own clock (default one hour: a
   query holding a plan from before the removal may still be reading the file);
3. the key is not live.

A removal that is committed but not yet logged is not returned; a later run finds it. The
ledger writes its log in the background (`contracts/LEDGER-LOG.md`), so a removal becomes
deletable one drain cycle (about 200 ms) after it is committed, plus the grace. Deletes go to
R2 as one `delete()` per 1,000 keys; tombstones are forgotten only after the delete returned
(a crash in between deletes again, harmlessly). At most `maxKeys` (10,000) per run.

### `sweepOrphans(env, tenant, { graceMs, maxCompactStepMs, now })`: objects nothing will ever list

Stated precisely, for an independent check (the protocol model's owner models it; D30).

1. **List first.** Every object under `{cell}/data/{table}/tenant={tenant}/` for both tables,
   with its upload time and custom metadata. Call this set P. An object written after the
   listing is not a candidate in this run.
2. **Then ask the ledger,** per chunk of 1,000 listed objects, in ONE consistent read
   (`orphanCheck`): which of the chunk's keys, and which inputs of the chunk's compaction
   outputs that are NOT in P, are live; which are tombstoned; and every stream's logged
   watermark (`logged`: per stream, its committed incarnation and how far THAT incarnation
   is logged; a newly registered incarnation starts at 0).
3. **Decide,** for each object O of the chunk. If O is live or tombstoned it is kept
   (tombstoned keys are `purgeTenant`'s). Otherwise:

| O | Deleted only when | Kept as |
|---|---|---|
| Flush file `L0-{shard}-{inc}-{seqLo}-{seqHi}-{hash8}` | the stream w whose name (with `/` as `_`) is `{shard}` exists in `logged`, **and** either w is incarnation `inc` with `w.seq ≥ seqHi` (a unit for that range is answered as a replay and adds no file), or w is a newer incarnation than `inc` with `w.seq > 0` (that incarnation has a logged unit, so its registration is in the logged prefix of the log, and a rebuild cannot roll it back: spec F15); **and** O is at least `graceMs` old (default 24 h) | `unknown_stream` (no such stream), `pending_unit` (otherwise), `young` |
| Compaction output `L{n≥1}-{h##│d}-{inputs16}-{hash8}` | its inputs record (`viz-inputs`, format `r2.compaction-inputs` v1) is readable, names only keys under O's own tenant and day, and hashes to O's `inputs16`; **and** some input I is **gone for good**: not in P **and** not live in the same read as O; **and** O is at least `max(graceMs, 2 × maxCompactStepMs)` old (an age floor only) | `unknown_inputs` (record missing, of an unknown version, or not matching), `inputs_remain` (every input is live or still in R2), `young` |
| Anything else under the prefix | never | `unknown_name` |

4. Delete the chunk's doomed objects in one `delete()`.

**Why a deleted object can never be listed.** Every deleter in viz deletes only keys that can
never be live again: purge (rule 1 above: its removal is logged, so no rebuild brings it back),
and this sweep. A flush file dead by its own incarnation's logged watermark is answered as a
replay; one dead by a newer incarnation is refused (`incarnation_mismatch`) by any ledger
rebuilt from the log, which has that incarnation registered. A compaction output needs every
input live for `replace` to admit it, and an input gone for good was deleted by one of these
two deleters, so it is never live again, by induction. None of this rests on a clock: the
grace periods only keep the sweep off objects that are seconds old and on work an operator
may still want to inspect.

**What it does not cover.** An object whose name fits two of the tenant's streams (below,
"Contract issues").

## R2 operations per maintenance run

`expireTenant`: none by the janitor; the ledger commits one change, which its next drain
writes to R2 together with whatever else is pending (no R2 write on the call's path).
`purgeTenant`: one `delete()` per 1,000 keys, sequential, plus a ledger read per batch.
`sweepOrphans`: one LIST per page of the tenant's prefix per table (at most 1,000 objects a
page; fewer when metadata is included, as R2 may truncate a page by size: training
knowledge), one `orphanCheck` and at most one `delete()` per 1,000 listed objects. No PUT
anywhere.

Locally a run takes a few milliseconds. On Cloudflare (modelled from `spikes/s5-r2-writes/`:
one `delete()` of 1,000 keys 5.5 s): deletion is about **5.5 s per 1,000 keys**, so a purge at
its default cap of 10,000 keys is about a minute of one maintenance run. Background work,
never on a write or query path; the cap keeps a run inside a queue consumer's time limit.
Not measured on Cloudflare; the experiment is a deployed purge of 10,000 keys
(`design/VERIFICATION.md` §4).

## Not implemented

- **The wait for publication.** `DESIGN.md` §5.2 deletes after the removal is *published*;
  there is no publisher on this path yet. Tombstones carry the ledger version so that gate
  can be added to `deletable`.
- **A remembered policy.** The reviewer's optional second step for R-1 (keep the last policy
  read successfully and never apply a shorter one without an explicit change) is not built:
  see "Known risks" for the one path it would close.
- **Tiers and signals.** One number per tenant, raw metric samples only.
- **Partial days.** Retention removes whole UTC days; a file is never rewritten to trim it.
- **Tombstones of earlier ledger incarnations.** A ledger rebuilt from its log restores the
  tombstones of that log; removals logged only in an older incarnation are found by the
  orphan sweep instead (their flush files are below the logged watermark).
- **Deleting the ledger's own log objects**, and shard-side data.
- Not run on Cloudflare; R2's `uploaded` time and list consistency are miniflare's here.

## How it was verified

```
(cd ../engine/wasm && ./build.sh)
npm ci && npx vitest run --maxWorkers=2    # 17 tests in workerd, 2 files
npx tsc --noEmit                           # clean
```

Last run 2026-11-19 against the real tree (the ledger draining its log asynchronously): 17 of
17, tsc clean. The suite pins `LEDGER_DRAIN_DELAY_MS` to 60 s (`vitest.config.ts`), as
`ledger/` does, and drains the ledger where a test needs a removal or a unit logged
(`ledger.drain()`, `flushSettled` in `flush/test/helpers.ts`), so no assertion depends on when
the ledger's alarm happens to run.

| Test | What it asserts |
|---|---|
| retention policy | no record: the default; a record: its number; ten kinds of unreadable record (not JSON, a trailing comma, 0, −3, a string, 1.5, null, an array, `{}`, `v: 2`) are all refused, never the default; cutoff arithmetic at day boundaries and before 1970 |
| control's golden record | read as an independent reader |
| an unreadable record refuses the whole run | `v: 2` refuses with the reason and expires nothing; deleting the record is an explicit return to the default |
| **R-1**, ported from the reviewer | a 365-day record with a trailing comma, a file 100 days old: nothing is expired. Failed before the fix (both files of that day removed) |
| expires whole days | both tables, right days, no object touched, the remaining rows read exactly, idempotent, the default policy removes nothing |
| grace, with a reader holding the old plan | compaction replaces every file of a plan; within the grace nothing is deleted and the old plan reads completely; after the grace and the log the inputs go and the live outputs stay |
| committed but not logged | with the ledger's log broken, nothing is deleted even with no grace (one outbox row: both tables in one change); after the log catches up the same call deletes |
| `maxKeys` | stops and continues |
| pending unit (the race) | a flush stopped between PUT and `addUnit`: the sweep, with no grace and a clock a year ahead, keeps its files; the flush then finds them (`exists`) and they are live. Same for a stream's first unit (`unknown_stream`) |
| logged, not committed, watermark | a stray object for a range that is committed but not logged is kept; deleted once logged |
| true orphans | a superseded flush file and a file of an older incarnation are kept while young and deleted when old; a crashed merge's outputs are kept a year on while their inputs are live, kept while the inputs are expired but not purged, and deleted (after the age floor) once purged; an unknown name is never deleted |
| a live input whose object is missing | does not release a leftover output (`inputs_remain`) |
| merge in flight | the sweep, no grace and a year ahead, runs between a step's PUTs and its `replace` and keeps the outputs |
| live, tombstoned, other tenants | untouched with no grace at all |
| **F15**, the model's trace | worker 1 PUTs and dies; worker 2 adopts the files; a newer incarnation registers, committed, not logged; the sweep runs a day later; the ledger loses its storage and the rebuild rolls the registration back; worker 2's unit is admitted and every listed file has its object. Failed before (the sweep deleted both) |
| golden: compaction inputs record | compact's golden record decodes; a newer version keeps the object |

The interleavings of R-2 and F13/F14 (compaction outputs against this sweep) are in
`compact/test/compact.test.ts`. Mutants: `MUTANT_FILES=janitor/ node scripts/mutants.mjs all`
from a copy of `stack/` (never in the checkout); results in `stack/README.md`.

## Contract issues

- **Key names are not one-to-one with streams.** `contracts/TABLES.md` names a flush file
  after its shard with `/` replaced by `_`, and pool names are not restricted, so `a/b/1` and
  `a_b/1` give the same name. If one tenant writes to two such shards (pools `a/b` and `a_b`,
  or a dedicated pool `tenant/x_y` beside a pool `tenant_x_y`), the sweep judges a file of one
  by the watermark of the other (the first that matches), and could delete a file whose unit
  is about to be admitted. The janitor cannot fix this alone: the colliding stream may not be
  registered with the ledger yet. Needed in `contracts/` and `shard/`: either an injective
  name in the key (escape `_` as well) or a rule that pool names contain no `_`. Not reachable
  with the pool names in use: shared pools are `shared/<cell>` and dedicated ones
  `tenant/<id>` (tenant ids contain no `/`), and no two such names map to the same string
  unless a cell name contains `_` or `/`. An operator-made pool name could.

## Known risks

- **The grace is a time, not a lease.** A query that runs longer than the delete grace can
  lose a file under it. The default is one hour; nothing enforces a query time limit yet.
- **A just-created retention record can read as absent** at another KV location for a short
  time (KV is eventually consistent; about a minute, training knowledge), and absent means
  the default. That matters only for a tenant that has data older than 30 days and no record
  before; a changed record reads as its previous value, not as absent. A remembered policy
  ("Not implemented") would close it.
- **A retention shortened by mistake** removes data at the next run; the delete grace is
  the only window in which the ledger's log could still be used to restore the listing.
- **Leftover compaction outputs** stay until an input of theirs is purged (D30): storage, not
  correctness. An output without a readable inputs record is never deleted automatically.
- **Listing a large prefix** is one request per page; a tenant with millions of files needs
  the sweep split by day. It runs at most daily per tenant, and only while objects may have
  been written since the last sweep that found nothing to wait for (`stack/`).
