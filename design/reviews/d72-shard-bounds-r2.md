# Narrow re-check: D72 after its review (the partial index `batch_time`, migration 3, the skip decided from the index)

Reviewer: did not build D72 or its fix, and was not given the builder's reasoning. Read-only on
the shared tree: nothing was edited, committed, pushed or deployed. Every reproduction and every
mutant ran on copies in the scratchpad. Tests used at most 2 workers, one heavy process at a time.
No Rust build and no Cloudflare call. Date: 2026-11-26.

## Scope and what was run

- **Commit read.** `afd0deb`, taken with `git archive`, so nobody's uncommitted edits were in the
  copy. The shard-side fix is described by `c277639`, the query-side one by `0f314ea`.
- **Files read.**
  - `design/DECISIONS.md` D72, and the first review `design/reviews/d72-shard-bounds.md`.
  - `contracts/BATCH.md` ("Tail reads of spans and log records by time"), `COMPATIBILITY.md` §2
    and §3.3, `contracts/schema.ts`.
  - `shard/src/tail.ts`, `shard/src/shard.ts` (migration 3, the append, `tailRead`, `tailPage`,
    `lastKept`, `configure`), `shard/test/bounds.test.ts`, `bounds.edge.test.ts`,
    `shard/scripts/mutants.mjs`, `shard/bench/skipread.node.mjs` and its results,
    `shard/README.md`.
  - `query/src/tail.ts` (`readPages`), `query/src/signals.ts` (`readSignalTail`, `spansIn`),
    `query/test/review-r2.test.ts`.
  - The shard of production's release (`fb77292`) and of the release before D72
    (`shard/bench/prebounds/`, which equals `fd4b75a` but for its header comments and import paths).
- **Baseline at `afd0deb`, in the copy** (measured here): the shard suite **109 passed of 109**
  (12 files), `tsc --noEmit` exit 0. This matches the README.
- **Run for this re-check** (all measured here, local workerd unless said otherwise):
  - the first review's reproductions R2, R3 and R4, unchanged, against the fixed code;
  - the first review's storage probe, rewritten for the fixed layout with the shard's own
    statement text (Python's SQLite 3.53.1);
  - the author's `bench/skipread.node.mjs` once, and `bench/walk.node.mjs` once;
  - the author's 26 D72 mutants (`node scripts/mutants.mjs D72`);
  - a new test file of 13 tests (blocks A to L below) and 6 mutants of the reviewer's own;
  - the query's three D72 tests, the query's whole suite once under one mutant, and one mutant
    of the query's guard.

## The first review's findings

| Finding | Status | Evidence (measured here) |
|---|---|---|
| **M-1** deciding a skip read the whole payload; nothing per call bounded it | **closed** | Skipping 48 batches (33.03 MB) reads **8.3 KB** with the shard's `TIMED_TAIL_SQL`, against 33,120 KB with the first build's statement (Python's SQLite). The author's bench, re-run once in workerd, gives the README's figures exactly: 20 KB against 33,004 KB; one hour 4,568 against 37,532 KB; everything 33,006 against 65,870 KB. In workerd the bytecode seeks the table row only after the subquery has decided (block G). One call considers at most `tailScanMaxBatches` batches (block F). The six texts that said "without reading" are now true or rewritten. |
| **m-1** the walk ignored flags and reserved bytes; the contract said shards never look inside | **closed** | The first review's R2, re-run unchanged, now fails on both of its fault assertions: flags or reserved set gives no bounds, and the modelled later layout gives `null` and is returned by a read of its last row's millisecond. `BATCH.md` says what the shard reads and how a later layout must signal itself. `COMPATIBILITY.md` §3.3 was not changed; see r2-n-1. |
| **m-2** span-local reads de-duplicated before the window | **closed**, with the engine binary found in the tree | The first review's R3, re-run unchanged, now gives the same tags and the same count (1) with and without the later batch, so its fault assertion fails. `query/test/review-r2.test.ts` "m-2" passes. `BATCH.md` and D72 state the rule. The engine fix is Rust; it was exercised through the built `viz_query.wasm` in the working tree (ABI 8), which is not committed and was not rebuilt here. |
| **m-3** the query could send `minTs > maxTs` (503 on every retry) | **closed** | `readSignalTail` reads no tail for an empty range; the query's "m-3" test answers 200. With the guard removed on a copy the same test answers **503**, the first review's fault. The shard still answers `invalid` for such a range (R4 unchanged), as the contract now says. |
| **m-4** the walk's cost was understated | **closed** | D72 and the README give the worst case. `bench/walk.node.mjs` re-run once (Node 22): 1.35 ms for edge's worst span shape, 0.20 ms for its worst log shape, 19 to 26 µs typical, up to 2.4 ms for shapes edge never builds. |
| **m-5** the commit named D72 did not contain D72 | **open** (the same again) | `c277639` holds the README, two bench result files and 10 comment lines of `tail.ts`. The fix itself (migration 3's index, `TIMED_TAIL_SQL`, the batch window, `last`, the tests, the golden file) and the contract text arrived in "Work in progress" snapshots (`4b97004` to `76e065b`). The contract change has no commit of its own. Still to do when this reaches a pull request. |
| **m-6** the tests never ran edge's encoder; nothing tested m-2 or m-3 | **closed** | `shard/test/bounds.edge.test.ts` (7 tests, adopted from R1, R2 and R5b) and the query's two tests exist and pass. |
| **m-7** the README's last-run line was tied to no commit | **closed** | It names `76e065b`. `shard/src` and `shard/test` at `76e065b` and at `afd0deb` differ only by those 10 comment lines. |
| **n-1** a 422 said "at least" when the size was exact | **closed** | The shard's `page_limit` carries `last`; `readPages` reads it; the query's "n-1" test passes. Two sentences still say the query does not read it; see r2-n-1. |

## New findings

Counts: **0 blockers, 0 majors, 3 minors, 2 nits.**

### r2-m-1 (minor): the tenant terms of the statements the fix added are not tested; a mutant that makes one tenant's batches skip another's rows survives both suites

- **Where.**
  - `shard/src/tail.ts` 42–43, `SKIPPED_BY_BOUNDS`: `t.tenant = ? AND t.seq = b.seq`.
  - `shard/src/tail.ts` 52–53, `TIMED_TAIL_SQL`: `b.tenant = ? AND b.seq BETWEEN ? AND ?`.
  - `shard/scripts/mutants.mjs` 89–115: the 26 D72 mutants; none touches a tenant term.
  - `shard/test/bounds.test.ts`: every ranged read is of a shard that holds one tenant.
- **The code is right.** Both statements name the tenant, and block C below shows they isolate.
  The finding is that nothing would notice if they stopped.
- **Scenario.** A shared-pool shard holds tenants A and B, whose sequence numbers both start at 1.
  If the subquery lost its tenant term, the lookup for A's batch 1 would also find B's batch 1.
  When B's batch lies outside the range, A's batch is skipped although its rows are inside it:
  rows missing from A's answer, with status `ok`.
- **Reproduction** (mutants applied to a copy, restored after each).

  | Mutant | Shard suite | Query suite | Reviewer's block C |
  |---|---|---|---|
  | MT1: the skip subquery does not name the tenant (`t.tenant = ?` → `? IS NOT NULL`) | **survives**, 109 of 109 pass | **survives**, 173 of 173 pass | killed: A's read of hour 0 loses batch 1 |
  | MT3: the ranged read does not name the tenant (`b.tenant = ?` → `? IS NOT NULL`) | **survives**, 109 of 109 pass | killed by `query/test/isolation.test.ts` (2 of 3 fail: "a sees b_only_label") | killed |
  | MT2: the look for `last` does not name the tenant | survives | not run | survives: equivalent (the subquery, which names the tenant, decides every row the outer one adds) |

  The stack suite was not run under these mutants.
- **Recommendation.** Add a two-tenant test to `bounds.test.ts` (block C is one: same sequence
  numbers, opposite times, each read sees its own bounds only) and add MT1 and MT3 to
  `mutants.mjs`. AGENTS.md asks for a failing test per broken safety property, and the tenant
  in every `WHERE` is one.

### r2-m-2 (minor): every ranged read now reads two to three billed rows per batch, metric reads included, and the cost section does not say so

- **Where.**
  - `shard/src/shard.ts` 1142–1144: a read with `minTs` or `maxTs` uses `TIMED_TAIL_SQL`,
    whatever its signals.
  - `query/src/coordinator.ts` 862 and 1187: every metrics query sends a time range
    (`tailFilter(ranges)`).
  - D72 "Cost of it" and `shard/README.md` 437–439: the billed cost given is one row written per
    span or log append, "none per metric append". Rows read are not mentioned.
- **Scenario.** The correlated lookup in `batch_time` is one more row read per batch considered,
  and it runs for metric batches too, which never have an entry. So the metrics read path, which
  D72 says it leaves as before, reads twice the rows on every query.
- **Reproduction** (block K: the cursor's `rowsRead` in local workerd, 200 batches; not measured
  on Cloudflare).

  | Tail | Unranged statement | Ranged, every batch kept | Ranged, far range |
  |---|---|---|---|
  | 200 metric batches | 200 rows read | **400** | **400** (all 200 still returned) |
  | 200 span batches | 200 | **599** | 400 (none returned) |

  The author's own `bench/results/skipread.txt` records the same (`rowsRead` 50 as first built,
  100 and 147 as chosen), but the README and D72 do not carry it.
- **Size** (modelled). At the list price in `research/02-cloudflare-compute-platform.md`
  ($0.001 per million rows read past 25 billion a month), one more row per batch considered is
  about $1 per billion batches considered. A tenant at 100 queries a second over 4 shards of 100
  tail batches reads 104 billion more rows a month, about $104. The workload is invented; the
  experiment that settles it is rows read from the analytics API for the same queries on a
  deployed shard.
- **A side effect.** Metric reads now depend on `batch_time` existing (block H: without it they
  throw too).
- **Recommendation.** Either state the cost in D72 and the README, or use `TIMED_TAIL_SQL` only
  when the read admits signal 2 or 3 (no `signals`, or one of them listed). A read with
  `signals: [1]` can skip nothing by bounds, and the plain statement returns it the same
  batches.

### r2-m-3 (minor): the batch window answers an empty `ok` when its configuration value is not a number

- **Where.** `shard/src/shard.ts` 1141: `Math.max(1, this.cfg.tailScanMaxBatches)`;
  `configure` at 661–666 stores whatever it is given.
- **Scenario.** `configure({ tailScanMaxBatches: undefined })` or `NaN` (an operator's or a
  test's mistake; no component calls `configure`). `Math.max(1, NaN)` is `NaN`, so `upto` is
  `NaN`, the statement selects nothing, and `upto < through` is false: the read ends.
- **Reproduction** (block L, a tail of 3 span batches).
  - Default: `{"status":"ok","through":3,"batches":[1,2,3],"next":null}`.
  - With `undefined` or `NaN`, ranged or filtered without a range:
    `{"status":"ok","through":3,"batches":[],"next":null}`. The unfiltered read still returns 3.
  - After an eviction `undefined` becomes the default again; `NaN` is stored as `null` and
    becomes a window of 1.
- **Why it matters.** It is the one value in `tailPage` whose bad setting hides acknowledged
  rows instead of costing time (`tailScanMaxBytes: NaN` only removes the byte budget). AGENTS.md:
  "Refuse rather than guess".
- **Recommendation.** Take the default unless the value is a safe integer of at least 1. One line.

### r2-n-1 (nit): three texts are behind the code

- `shard/README.md` 821: "`query/`: read `last` from `page_limit` … not done". It is done at
  `afd0deb` (`query/src/tail.ts` 227, `coordinator.ts` 586), and the query's "n-1" test passes.
- D72 "Cost of it": "`last` on `page_limit` is used only once query reads it". It does.
- `shard/README.md`, "Needed changes elsewhere" 3: `COMPATIBILITY.md` §3.3 does not name the
  shard as a reader of the signal 2 and 3 layout. `BATCH.md` carries the rule; either add the
  line or drop the item.

### r2-n-2 (nit): "built over schema-2 rows it reads their headers" holds only for batches larger than a page

- **Where.** `shard/src/shard.ts` 206–207 and `shard/README.md` 191–193.
- **Reproduction** (`scripts/migrate.py`, Python's SQLite, 40 MB tails, measured here; modelled
  beyond that).

  | Tail at schema 2 | Migration 3 read | Time |
  |---|---|---|
  | 48 batches of 0.4 to 1 MB | 0.15 MB | 18 ms |
  | 2,000 of 20 KB | 8.2 MB | 10 ms |
  | 20,000 of 2 KB | 41.1 MB (the whole table) | 23 ms |
  | 200,000 of 200 B | 48.2 MB | 85 ms |

- **What it means.** A payload under about 4 KB sits in the same page as its row's header, so the
  build reads the table. At `shardMaxBytes` (512 MiB) of such batches that is about 0.3 to 1.1 s
  (modelled from the rows above), well inside the 30 s of COMPATIBILITY §2.2. Nothing to change
  but the sentence.

## What I attacked and found held

- **A batch with bounds, one of whose rows is inside the range, is never skipped** (block A).
  - Spans and logs, 60 batches each: 20 of one row, the rest of 1 to 6 rows. Times include 0, 1,
    both sides of a millisecond edge, `2^63 − 1` and the last whole millisecond below it.
  - 400 millisecond ranges per signal: on a row's millisecond, one below, one above, 0, −1, the
    largest millisecond and one above it, both safe-integer extremes, one-sided ranges, and
    `minTs == maxTs`. Then 300 nanosecond bounds floored as the query floors them.
  - Result per signal, over 700 reads: **0** rows inside a range in a skipped batch. Over the
    400 millisecond ranges the batches returned were exactly those whose hull overlaps (about
    11,300 batch decisions kept and 12,700 skipped per signal).
  - The stored bounds are SQL integers (block J: `typeof` is `integer`), equal to an independent
    computation of the floors. `min > max` cannot be stored: both come from one scan.
  - A range that is not two safe integers in order (1.5, NaN, a string, null, Infinity, `2^53`,
    `minTs > maxTs`) is refused `invalid`, never read as "no range" (block I).
- **A batch without bounds is never skipped** (block B). Six such batches: flags set, reserved
  set, written by `fb77292`, written by the release before D72, and two whose row was given one
  NULL bound by hand. 54 ranged reads (9 ranges including the extremes and one-sided ones, 3
  window sizes, 2 page sizes, evictions between pages) returned all six every time, and neither
  of the two bounded far batches. The index held exactly the two rows with both bounds. A metric
  batch has no bounds and no entry, and its rows are still selected one by one.
- **Tenant isolation** (block C). Two tenants in one shard with the same sequence numbers and
  opposite times: each ranged read returned its own batches only, and `page_limit.last` was right
  for each. Both statements the fix added name the tenant in the outer `WHERE` and in the
  subquery. The append's `INSERT` is unchanged in that respect. See r2-m-1 for the tests.
- **Rollback and forward again** (block D), on one object's storage.
  - Production's release (`fb77292`, which knows schema 1) opens schema 3 storage (`compat` 1),
    appends, and returns the whole tail. Forward again its two batches have NULL bounds and every
    range keeps them, including `[0, 0]`.
  - The release before D72 then appends, answers a ranged read with all seven batches, seals,
    and its own alarm discards and expires rows that have index entries. Afterwards the index
    agrees with the rows, and `PRAGMA quick_check` answers `ok`.
  - This release then appends with bounds again and reads by range above the discard; a read
    below it is refused `stale_watermark`.
  - The author's rollback and schema-2 upgrade tests also pass; the migration runs once.
- **Eviction.** Nothing the fix added lives in memory: the bounds are in the row and the index,
  and the window is configuration, reloaded from storage over the defaults (a configuration
  stored by an older release, which lacks the field, gets 32,768: block D does exactly that).
  Evicting between pages changed no answer (blocks B and F).
- **Paging** (block F): 30 batches, two kept (11 and 26), runs of skipped ones before, between
  and after, then an append.
  - 64 paged reads (windows of 1, 2, 3, 7, 29, 30, 31 and 32,768 batches; a scan budget of 1
    byte and of 32 MiB; two page sizes; with and without an eviction between pages) all returned
    `[11, 26]`. `through` stayed 30 on every page, and the last page's `next` was null.
  - 384 pages held no batch and continued. Every cursor named a later sequence number than the
    one before. A page of only skipped batches names the batch after its window.
  - No skipped batch was examined: `scannedBatches` summed to 2, or 3 when a kept batch did not
    fit a page and was examined again on the next, as under D48.
  - An append after the first page did not enter the read.
  - `page_limit` after a run of skipped batches names the kept batch; `last` is true only when
    nothing kept follows, and false when the look stops at the window.
  - The query's own `readPages` followed the empty pages (11 calls, complete, `[11, 26, 31]`),
    and took `overLast` from `last`.
  - Reviewer's mutants MT4 (the next page starts one batch late) and MT5 (the window off by one)
    are killed by the author's suite.
- **The plan** (block G, workerd's SQLite).
  - Ranged read: `SEARCH b USING INDEX sqlite_autoindex_batch_1 (tenant=? AND seq>? AND seq<?)`,
    then `SEARCH t USING COVERING INDEX batch_time (tenant=? AND seq=? AND min_ts>?)`.
  - The look for `last`: both searches use covering indexes; no row is read.
  - Bytecode: `DeferredSeek` on the table at address 14, the subquery returns at 33, and the
    first column of the table row is read at 36. No table column is read before the decision.
  - Without the index the statement fails ("no such index: batch_time"); it never falls back to
    the row (block H). Reviewer's mutant MT6 (an entry for a row with one bound) is killed.
- **Migration 3 was edited in place.** That rests on "it had not shipped". The repository's
  records agree: production runs `fb77292` (shard schema 1); spike S10 was deployed from
  `9d41dca`, whose shard has no `min_ts`, and was deleted; S13 did not run; the account inventory
  of 2026-11-26 in `spikes/s13-upgrade-trial/README.md` lists production's Workers and one static
  spike. Not checked against Cloudflare by me. Storage that did take the first build of
  migration 3 (version 3, no index) would fail every ranged read, metric ones too, loudly
  (block H).
- **The README's claims about D72.**
  - The named tests exist. Counts: `bounds.test.ts` 15, `bounds.edge.test.ts` 7; 109 in all.
  - "Mutants 26/26": the 26 patterns all apply to real lines (`--check`), and all 26 were
    **killed** in a re-run here, by the tests the README names.
  - Rows written (block J): an append with bounds 4, without 3; a discard 1; an expiry 1. As the
    README says.
  - The layout table and the walk's figures were reproduced (above).

## Verdict

**Approve with changes.** No blocker and no major.

The fix does what it says: a skip is decided from the index and reads no payload, no row inside
a range was dropped in 1,400 reads built to drop one, batches without bounds were always kept,
and the rollback to both earlier releases and forward again held.

Before the pull request:
- r2-m-1: the two-tenant test and the two mutants;
- r2-m-2: state the rows read, or keep metric reads on the plain statement;
- r2-m-3: the one-line guard;
- m-5, still open: say which commits hold D72 and its fix, and put the contract text in its own.

The nits can follow.

## Not checked, and why

- **Nothing on Cloudflare.** Bytes read, rows read and rows written are from local workerd or
  Python's SQLite. How Cloudflare bills the index lookups is not measured.
- **No Rust build** (the machine's rule for this review). The m-2 engine fix ran through the
  built `viz_query.wasm` in the working tree, which cannot be tied to `afd0deb`. The query's
  Rust and TypeScript mutant runs were not repeated, except one mutant of the m-3 guard.
- **The stack suite and the gateway suite** (README: 50 passed and 1 skipped; 4 of 4): not run.
- **`BENCH=signaltail`** (the end-to-end times): not re-run; it needs the first build as a
  second copy.
- **The query's signal fixtures** are generated, not committed; the working tree's were used.
- **Whether storage with the first build of migration 3 exists anywhere:** from the
  repository's records only.

## Reproduction index

The scratchpad is `/tmp/claude-0/-home-user-viz/3c79101e-93fd-5a8e-90a7-fca4d8b40aab/scratchpad`;
this review's directory is `$SP/rv-d72-r2` (`$R`).

1. **The copy.** From `/home/user/viz`:
   ```
   git archive afd0deb shard contracts ledger edge flush query engine/wasm engine/wasm-query/js | tar -x -C $R/copy
   git archive fb77292 shard/src contracts | tar -x -C $R/copy/fb77292
   ```
   Then `viz_engine.wasm` and `viz_query.wasm` copied from the working tree (not committed), and
   `node_modules` of `shard`, `query`, `ledger`, `edge`, `flush` linked. `$R/mut` is a second
   copy for mutants; `$R/mut/query/test/fixtures/signals` links the working tree's fixtures.
2. **Baseline.** `cd $R/copy/shard && npx vitest run --maxWorkers=2`, run before
   `test/rv2.test.ts` was added (109 of 109; output `$R/baseline.txt`), and `npx tsc --noEmit`
   with that file moved out (exit 0).
3. **The first review's reproductions.** `$R/rv1-review-d72.test.ts` (a copy of
   `$SP/rv-scripts/review-d72.test.ts`) placed in `shard/test/`, run with `-t "R2|R3|R4"`:
   output `$R/rv1-rerun.txt` (R2 twice and R3 fail on their fault assertions; R4 passes).
4. **M-1.** `python3 -I $R/scripts/skipread.py $R/sqlite $R/copy/shard/src/tail.ts` (output
   `$R/skipread-py.txt`); `node --experimental-strip-types --no-warnings bench/skipread.node.mjs 0`
   in `$R/copy/shard` (output `$R/skipread-workerd.txt`).
5. **The re-check's tests.** `$R/copy/shard/test/rv2.test.ts`:
   ```
   cd $R/copy/shard && npx vitest run test/rv2.test.ts --maxWorkers=2 --silent=false
   ```
   13 of 13 pass; output `$R/rv2-final.txt`.

   | Block | What |
   |---|---|
   | A | bounds and edges, spans and logs |
   | B | batches without bounds; a metric batch |
   | C | two tenants in one shard (r2-m-1) |
   | D | rollback to `fb77292` and to the release before D72, and forward |
   | F | paging, cursors, `last`, eviction, the query's reader |
   | G | plan and bytecode |
   | H | storage without the index |
   | I | option types |
   | J | rows written |
   | K | rows read (r2-m-2) |
   | L | the window with a bad configuration value (r2-m-3) |

6. **Mutants.** The author's: `cd $R/mut/shard && node scripts/mutants.mjs D72` (output
   `$R/mutants-author.txt`, 26 killed). The reviewer's: `node $R/scripts/rv-mutants.mjs $R/mut/shard`
   (output `$R/rv-mutants.txt`). MT1 against the query's whole suite: `$R/query-mt1.txt`
   (173 of 173 pass). MT3 against `query/test/isolation.test.ts`: 2 of 3 fail. The copy was
   compared with `$R/copy` after each (`diff -rq`): restored.
7. **The query's tests.** `cd $R/copy/query && npx vitest run test/review-r2.test.ts -t "review of D72" --maxWorkers=2`
   (3 pass; `$R/query-d72.txt`). The m-3 guard replaced by `if (false)` in `$R/mut/query`: the
   "m-3" test fails with 503.
8. **r2-n-2.** `python3 -I $R/scripts/migrate.py <an empty directory>` (output `$R/migrate-py.txt`).
9. **The walk.** `node --experimental-strip-types --no-warnings bench/walk.node.mjs` in
   `$R/copy/shard`.

## Summary row for design/REVIEW.md

| `reviews/d72-shard-bounds-r2.md` | Narrow re-check of D72 after its review, at `afd0deb`: the partial index `batch_time`, migration 3, the skip decided from the index, the per-call batch window (`shard/src/tail.ts`, `shard.ts`, `contracts/BATCH.md`), and the query-side fixes of `0f314ea` | First review: M-1, m-1, m-2, m-3, m-4, m-6, m-7 and n-1 closed (skipping 48 batches reads 8.3 KB against 33,120 KB in SQLite and 20 KB against 33,004 KB in workerd, measured here; the first review's R2 and R3 no longer show their faults; the m-3 guard removed gives the 503 again); m-5 open (the fix and its contract text arrived in snapshots again). New: 0 blockers, 0 majors, 3 minors (r2-m-1 the tenant terms of the new statements are untested: a mutant that drops the tenant from the skip subquery, so one tenant's batch hides another's rows, survives the shard's 109 and the query's 173 tests; r2-m-2 every ranged read, metric reads included, reads 2 to 3 billed rows per batch where it read 1, unstated; r2-m-3 a `tailScanMaxBatches` that is not a number answers an empty `ok`), 2 nits. Held: 0 rows inside a range in a skipped batch over 1,400 reads at the edges (0, ms edges, 2^63−1), batches without bounds always kept, two tenants in one shard isolated, rollback to `fb77292` and to the release before D72 and forward, eviction, paging over runs of skipped batches, the plan and bytecode in workerd, the author's 26 mutants killed again. Approve with changes | |
