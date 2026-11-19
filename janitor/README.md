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
| `test/publication.test.ts` | 4 tests of the deletion gate: against the real `Publisher` (with a test clock) and against stand-ins that lie, refuse or hang |
| `test/worker.ts` | The test script's main: `src/index.ts` plus the publisher's test class (`TEST_PUBLISHER`) |

Bindings: `LEDGER`, `BUCKET`, `CONFIG` (KV), `CELL`, and optionally `PUBLISHER` (the cell's
publisher; in production viz-publisher's namespace, bound by viz-ingest).

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

**With a publisher bound, deletion also waits for publication** (DESIGN §5.2, §5.3; added
2026-11-19). An Iceberg snapshot that an external reader may still hold names data files; once
published, a file must outlive every retained snapshot that names it. So the run first asks the
cell's publisher (`PUBLISHER.get(idFromName(CELL)).safeToDelete(tenant)`,
`publisher/src/publisher.ts`) which of the tenant's keys it releases: the removal is published
(or the file was never published), no retained snapshot references it, and the publisher's own
delete grace (1 h) has passed since the last one that did expired. A key is deleted only if the
ledger calls it deletable **and** the publisher releases it:

| The publisher | What is deleted | `PurgeResult` |
|---|---|---|
| not bound | what the ledger calls deletable (as before) | `{ deleted, waiting }` |
| releases some keys | the intersection; keys the ledger offers and the publisher holds stay at the head of the ledger's answer and are skipped (the next read asks for that many more, up to the ledger's 10,000) | `unpublished`: how many of `waiting` wait only for publication |
| throws (for example `schema_too_new` during a deploy), or does not answer within `publisherTimeoutMs` (2 s) | **nothing** (fails closed) | `publisher`: why; `waiting`: every tombstone |

After deleting, the run tells the publisher (`acknowledgeDeleted(tenant, keys)`), best effort and
bounded. It also acknowledges keys the publisher releases that the ledger no longer has as live
or tombstoned (one `orphanCheck`): deleted by an earlier run whose acknowledgement was lost.
Acknowledging never deletes anything. A key the publisher releases that the ledger does not
offer is never deleted (`test/publication.test.ts`: half the tombstones, a live key and a key
the ledger never had: only the released half of the tombstones goes).

### `sweepOrphans(env, tenant, { graceMs, maxCompactStepMs, now })`: objects nothing will ever list

Stated precisely, for an independent check (the protocol model's owner models it; D30).

1. **List first.** Every object under `{cell}/data/{table}/tenant={tenant}/` for both tables,
   with its upload time and custom metadata. Call this set P. An object written after the
   listing is not a candidate in this run.
2. **Then ask the ledger,** per chunk of 1,000 listed objects, in ONE consistent read
   (`orphanCheck`): which of the chunk's keys, and which inputs of the chunk's compaction
   outputs that are NOT in P, are live; which are tombstoned; and every stream's logged
   watermark (`logged`: per stream, its committed incarnation, how far THAT incarnation
   is logged (a newly registered incarnation starts at 0), and, since D61,
   `loggedIncarnation`: the newest incarnation whose registration is in the logged prefix).
3. **Decide,** for each object O of the chunk. If O is live or tombstoned it is kept
   (tombstoned keys are `purgeTenant`'s). Otherwise:

| O | Deleted only when | Kept as |
|---|---|---|
| Flush file `L0-{shard}-{inc}-{seqLo}-{seqHi}-{hash8}` | the stream w whose name (with `/` as `_`) is `{shard}` exists in `logged`, **and** either w is incarnation `inc` with `w.seq ≥ seqHi` (a unit for that range is answered as a replay and adds no file), or `w.loggedIncarnation > inc` (D61: a newer registration is in the logged prefix, so no rebuild brings `inc` back and the ledger refuses `inc` for good: spec F15, F16); from a ledger before D61 (no `loggedIncarnation`), w is a newer incarnation than `inc` with `w.seq > 0` (a logged unit of it proves its registration logged: D30's rule); **and** O is at least `graceMs` old (default 24 h) | `unknown_stream` (no such stream), `pending_unit` (otherwise), `young` |
| Compaction output `L{n≥1}-{h##│d}-{inputs16}-{hash8}` | its inputs record (`viz-inputs`, format `r2.compaction-inputs` v1) is readable, names only keys under O's own tenant and day, and hashes to O's `inputs16`; **and** some input I is **gone for good**: not in P **and** not live in the same read as O; **and** O is at least `max(graceMs, 2 × maxCompactStepMs)` old (an age floor only) | `unknown_inputs` (record missing, of an unknown version, or not matching), `inputs_remain` (every input is live or still in R2), `young` |
| Anything else under the prefix | never | `unknown_name` |

4. Delete the chunk's doomed objects in one `delete()`.
5. **Ask the shards** (D61; spec F16), after every chunk: for each stream with a `pending_unit`
   flush file of the incarnation the ledger names (`w.incarnation === inc`) at least `graceMs`
   old, once per stream per run, `env.SHARD.get(idFromName(w.shard)).ensureStream(tenant)`,
   naming the shard by the ledger's exact name (review m-6), each call bounded by 10 s. A shard
   that holds the stream changes nothing; one that lost it starts a fresh incarnation and
   registers it, after which, once that registration is logged, the files are dead by rule
   (b) at a later run and the compaction outputs built on them follow (D30). A call that fails
   (a shard of the release before D61 has no `ensureStream`, an unanswered call) keeps the
   files, is reported in `ensured` and the error log, and the sweep goes on. Without
   `env.SHARD` nothing is asked (the files wait for the tenant's next write to that shard, as
   before D61).

**Why a deleted object can never be listed.** Every deleter in viz deletes only keys that can
never be live again: purge (rule 1 above: its removal is logged, so no rebuild brings it back),
and this sweep. A flush file dead by its own incarnation's logged watermark is answered as a
replay; one dead by a newer incarnation is refused (`incarnation_mismatch`) by any ledger
rebuilt from the log, which has that incarnation registered. A compaction output needs every
input live for `replace` to admit it, and an input gone for good was deleted by one of these
two deleters, so it is never live again, by induction. None of this rests on a clock: the
grace periods only keep the sweep off objects that are seconds old and on work an operator
may still want to inspect.

**What it does not cover.** An object whose name fits two of the tenant's streams: closed
since 2026-11-19 by the name rule (`contracts/TABLES.md`, D38), under which no two streams
share a key's shard part.

**What it reports for the caller's schedule** (review S-6, 2026-11-19, by the storage-path
engineer). `waitingSince` is the upload time of the youngest object kept for something a
write or time can still change (`young`, `pending_unit`, `unknown_stream`, `inputs_remain`).
`stack/src/maintain.ts` keeps the daily sweep due only while that is younger than seven days;
after that only a write makes it due again. Since D61 a flush file of a stream incarnation
that will never report its unit (its shard lost storage and the tenant stopped writing there)
is no longer kept for ever: step 5 gets the shard's word, and the next runs delete it (the
protocol model's `LEAK_P_sl`, `LEAK_P_sl_comp2`, `LEAK_P_llsl2` hold on their whole graphs;
reviewed in `design/reviews/registration-before-writes.md`). An `unknown_stream` file (a
stream the ledger has never registered) still stays; under registration before writes no
acknowledged row can be in one, but nothing deletes it. `ensured` lists what each shard
answered.

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

- **Releasing files whose last snapshot never expires.** The publisher keeps at least two
  snapshots per table, so a file removed by the newest commit of a cell's table is released
  only after a later commit to that table (by any tenant of the cell) and a day. In a cell where
  nothing more is published it waits for ever (storage, not correctness), and its tenant's
  maintenance looks again every `PUBLICATION_RECHECK_MS` (6 h, `stack/src/maintain.ts`).
- **Removals the publisher never saw.** Files removed before the publisher first read a
  tenant's log, or across a publisher storage loss, are never released (publisher/README.md,
  "Not implemented"): their objects stay (nothing is deleted early).
- **A remembered policy.** The reviewer's optional second step for R-1 (keep the last policy
  read successfully and never apply a shorter one without an explicit change) is not built:
  see "Known risks" for the one path it would close.
- **Tiers and signals.** One number per tenant, raw metric samples only.
- **Partial days.** Retention removes whole UTC days; a file is never rewritten to trim it.
- **Tombstones of earlier ledger incarnations.** A ledger rebuilt from its log restores the
  tombstones of that log; removals logged only in an older incarnation are found by the
  orphan sweep instead (their flush files are below the logged watermark).
- **Deleting the ledger's own log objects**, and shard-side data.
- **`unknown_stream` flush files** are still kept for ever (above).
- **Streams are never retired** (review m-3): `ensureStream` on a shard of a retired pool
  creates a stream there. No pool is retired today; see `shard/README.md`, "Not implemented".
- On Cloudflare only inside staged trials of viz-ingest (`deploy/README.md`). In Trial 3 the
  deletion gate held back 8 objects the ledger offered after its (shortened) grace, with the
  removal published and the snapshot naming them retained; their release was not waited for.
  R2's `uploaded` time and list consistency in the tests here are miniflare's.

## How it was verified

```
(cd ../engine/wasm && ./build.sh)
npm ci && npx vitest run --maxWorkers=2    # 25 tests in workerd, 4 files
npx tsc --noEmit                           # clean
npm run mutants:registration               # D61's mutants, on a copy (the script refuses the checkout)
```

Last run 2026-11-19 (D61): **25 of 25**, `tsc --noEmit` clean. The registration mutants, on a
copy of the tree in a scratch directory (`scripts/mutants.mjs`), **4 of 4 killed**, all by
`test/registration.test.ts`: the sweep counting a committed incarnation (killed by "spec F16"
and "spec F15, adapted"); D30's rule kept (by "spec F16" and the m-6 ledger test); the sweep
skipping `ensureStream` (by "spec F16" and the m-6 shard test); a shard without
`ensureStream` stopping the sweep (by the m-6 shard test). The ledger's mutant
"`loggedIncarnation` is the committed incarnation" is killed by "spec F16" and "spec F15,
adapted" too.

Last run 2026-11-19 against the real tree (the ledger draining its log asynchronously): 17 of
17, tsc clean.

**With the deletion gate (2026-11-19):** `npx vitest run --maxWorkers=2`: **21 of 21** (3 files);
`npx tsc --noEmit` clean. The three gate tests were written first and **failed against the
code before the gate** (the janitor deleted all ten removed files at once, deleted all eight
tombstones the stand-in half-released, and deleted with a refusing publisher), then passed.
The real-publisher test walks one tenant through: ten files published (snapshot 1), compacted
away (the ledger's own rules then allow deletion); (1) removal not published: nothing deleted;
(2) published as snapshot 2, snapshot 1 retained: nothing deleted, and every file snapshot 1
names is still in R2; (3) a day later a new commit expires snapshot 1, the publisher's grace not
passed: nothing deleted; (4) after the grace exactly those ten are deleted, the ledger and the
publisher forget them, and every file of every retained snapshot is still there. A fourth
test was added while writing the mutants and failed against the first version of the loop,
which stopped when the publisher held back the whole first answer of the ledger: keys held back
at the head (lowest versions) no longer starve released keys behind them.

Mutants (on a copy in a scratch directory, `MUTANT_FILES=janitor/,stack/ node scripts/mutants.mjs
publication` from the copy's `stack/`): see `stack/README.md`, "The publisher wired in". The suite pins `LEDGER_DRAIN_DELAY_MS` to 60 s (`vitest.config.ts`), as
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
| **spec F16** (D61; `registration.test.ts`), the model's `LEAK_D30_sl_comp2` with the registration first | a logged registration, two units admitted but not logged, a compaction step that plans both, the shard and the ledger lose their storage (both admissions rolled back), the step PUTs its outputs (`conflict`). Sweep 1 keeps all six objects (four flush files `pending_unit`, two outputs `inputs_remain`) and asks the shard, which registers a fresh, newer incarnation; a sweep before the drain still keeps everything (F15); after the drain the next sweep deletes the four flush files and the one after the two outputs; nothing of the tenant is left. Mutants: no `ensureStream`, D30's rule: the objects stay |
| **spec F15, adapted** (D61), `P_teeth_newer_committed` | a flush Worker PUTs a file of incarnation 1; the shard loses its storage and `ensureStream` registers incarnation 2 (committed, not logged); the sweep keeps the file; the ledger loses its storage, the rebuild rolls incarnation 2 back, and the Worker's late unit of incarnation 1 is admitted: the listed files exist and the tenant reads exactly what was sent. Mutant: count the committed incarnation: the sweep deletes the file |
| **review m-6** (D61) | a shard without `ensureStream` (the release before): files kept, the failure in `ensured`, the sweep finishes; a ledger without `loggedIncarnation`: D30's rule, files kept; with this release's ledger the same files are deleted |

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
