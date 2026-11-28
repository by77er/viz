# Adversarial review: D72, time bounds of span and log tail batches

Reviewer: did not build D72 and saw only what the repository says about the author's reasoning.
Read-only on the shared tree. Every reproduction ran in a copy under the scratchpad. Tests used at
most 2 workers. No Cloudflare calls and no commits.

## Scope (the commit read)

- **Branch and commit.** Development branch `claude/cloudflare-observability-platform-ibaqya` at
  **`4c9e462`**. The D72 commit is `d4fd6c2`, but its diff contains only `shard/README.md` and a
  comment in `shard/bench/prebounds/shard.ts`. The D72 code and tests reached the branch in the WIP
  snapshots `41e834b` and `acff995` ("Not a green state"), and the contract text in `514828c`. No file
  under review changed between `d4fd6c2` and `4c9e462` except `design/DECISIONS.md` (other entries)
  and `contracts/README.md` (one line).
- **Files read.**
  - `design/DECISIONS.md`: D72, plus D48, D62 and D63 for background.
  - `contracts/BATCH.md`: the whole file, including "Tail reads of spans and log records by time".
  - `contracts/COMPATIBILITY.md` §3.
  - `shard/src/tail.ts`, `shard/src/shard.ts` (schema, append, `tailRead` and `tailPage`), and
    `shard/bench/prebounds/` (checked faithful to `fd4b75a`: only the import paths differ).
  - `shard/test/bounds.test.ts` and `compat.test.ts`.
  - `shard/README.md`, including "Needed changes elsewhere": the query change D72 asks for.
  - What the skip relies on: `edge/src/{spans,logs,otel}.ts` (the real encoders),
    `query/src/{signals,tail,coordinator,sigparams,sigroutes}.ts`,
    `engine/wasm-query/src/{traces,logs}.rs` and `ledger/src/ledger.ts` `plan`.
- **The query change.** At `4c9e462` it existed in the shared working tree as an **uncommitted**
  edit of `query/src/signals.ts` by another builder. It matches the README's text. It was read as
  the proposal and not run.
- **The branch moved during the review.** HEAD reached `a913aae`, another WIP snapshot ("Not a
  green state").
  - `a913aae` **commits that query change unchanged**, so m-3 applies to the committed query.
  - It rewrites `engine/wasm-query/src/traces.rs`. The behaviour m-2 rests on is kept there: an
    unwanted later copy still hides an earlier one (`Seen::Key`, `HIDDEN`; `latest_records` and
    `traces` at about lines 292–312).
  - Nothing under `shard/` or in `contracts/BATCH.md` changed.
  - Line numbers below are at `4c9e462`.
- **Baseline.** The shard suite at `4c9e462`, in a scratch copy, gave **98 passed of 98**, and
  `tsc --noEmit` was clean. This matches the README.

## Findings

Counts: **0 blockers, 1 major, 7 minors, 1 nit.**

### M-1 (major): deciding to skip a batch reads its whole payload from storage, and nothing per call bounds that work

- **Where.**
  - `shard/src/shard.ts` 187–202: migration 3 appends `min_ts` and `max_ts` with `ADD COLUMN`, so
    they follow `payload` in every record.
  - `shard/src/shard.ts` 1118–1131: the skip SQL, and the scan budget that counts only kept batches.
  - Claims that say otherwise:
    - `design/DECISIONS.md` 3718–3719: "skips … without reading its payload".
    - `contracts/BATCH.md` 372: "skips it, without reading it".
    - `shard/src/shard.ts` 1114: "its payload never read".
    - `shard/README.md` 136: "without reading its payload".
    - `shard/README.md` 684–685: CPU in proportion to "the batches it keeps".
    - `shard/test/bounds.test.ts` 409: "skipped ones cost nothing".
- **Scenario.** SQLite stores a record's columns in order. The two bounds sit after a 0.4 to 1 MiB
  payload, so they are in the last overflow page. To test `max_ts >= ?`, SQLite follows the chain
  of overflow pages from the start, and fetches every page of the payload through the pager.
  - **Storage reads.** The skip saves the copy into a result, JavaScript and the RPC. It does not
    save the read from storage.
  - **D48's per-call bound.** D48 bounds one call's work at `TAIL_SCAN_MAX_BYTES` (32 MiB)
    examined. Skipped batches do not count against it. So one call now walks, unbounded by
    that budget, every skipped batch's pages: up to `tenantMaxBytes` (64 MiB) of tail, on top of
    the 32 MiB it examines.
  - **D72's own "Would change if".** The trigger is "deciding to skip a batch costing what reading
    it did". In bytes read from storage, that is already true here.
  - **Timing.** Migration 3 freezes the column order once released. Choosing the layout now costs
    nothing, while changing it later needs another migration.
- **Reproduction.** `rv-scripts/overflow.py`.
  - **Setup.** The shard's DDL and the same `SELECT`. 48 batches, 33.03 MB of incompressible
    payload. Python's SQLite 3.53.1 (not workerd's), mmap off, 2 MB page cache, best of 5.
    Measured here, not on Cloudflare.
  - **Results.**

    | Read | Bytes SQLite reads | Time |
    |---|---|---|
    | read every batch (no range) | 33.12 MB | 11.94 ms |
    | skip every batch, as built (bounds after the payload) | **33.12 MB** | 5.85 ms |
    | `payload IS NOT NULL` alone | 0.16 MB | 0.03 ms |
    | skip every batch, bounds before the payload | 0.16 MB | 0.03 ms |
    | covering index `(tenant, seq, min_ts, max_ts)`, planner's choice | 33.12 MB | 5.54 ms |
    | covering index forced with `INDEXED BY` (decide, then fetch kept payloads by `seq`) | < 4 KB | 0.01 ms |

  - **What this shows.** The time saving is real: about half at the storage layer, and the README
    measured about 5 times end to end, RPC included. The claim "without reading" is not true. The
    planner does not pick a covering index by itself.
- **Recommendation.**
  1. Decide before migration 3 ships:
     - **(a)** a covering index, used explicitly. This costs one index row write per append, which
       is billed, and should be recorded against D72 (c).
     - **(b)** bounds stored before the payload: a new table, or a rebuild over a tail bounded
       by `shardMaxBytes`.
     - **(c)** keep the layout, and state that a skip costs one read of the payload from storage.
  2. Whichever is chosen, correct the six texts above, and count skipped bytes against a per-call
     budget, or state that the per-call bound is now the tenant's tail.

### m-1 (minor): the walk does not refuse what the strict decoder refuses, and the contract still says shards never look inside

- **Where.**
  - `shard/src/tail.ts` 194–201: only the magic and the signal byte are checked. Flags (offset 5),
    `reserved` (6–7), padding and trailing bytes are not.
  - Stale contract text:
    - `contracts/BATCH.md` 4: "shards never look inside".
    - `contracts/BATCH.md` 78: "The shard does not parse batches".
    - `shard/src/shard.ts` 253: "The shard does not parse batches".
- **Scenario.** D72 says "a batch it knows nothing about is kept". A signal 2 or 3 batch with
  non-zero flags is such a batch, and the walk reads it anyway with the v1 layout.
  - **How it can happen.** The contract lists fields not yet carried, such as `schema_url` and the
    resource's `dropped_attributes_count`. A future revision could add them, signalled by a flag.
    Following `BATCH.md` (shards never look inside) and the reader list in COMPATIBILITY §3.3, that
    revision would update the engine and not the shard.
  - **Consequence.** The walk would land on the wrong column and record non-null bounds that miss
    rows. Queries would then skip those batches silently, until flush refuses the segment.
  - **What is safe.** A new magic (`VZB2`) or a new signal number is safe: both give NULL.
- **Reproduction.** `review-d72.test.ts`, block R2.
  - **Flags or reserved non-zero.** Setting byte 5, 6 or 7 of an edge-built span batch leaves the
    walk's bounds unchanged, while `engine.encodeSpans` throws.
  - **A modelled extension.** One u64 after the entry table, with flags = 1. Rows start at ms
    `T … T+4`, and the walk records `{0, T+3}`. A read of `[T+4, T+4]` returns **0 batches**,
    although a row is stamped T+4.
- **Recommendation.**
  1. Return null unless `payload[5..8]` are zero. The check is cheap.
  2. Fix the three texts: the shard now reads the layout.
  3. Add the shard to the readers that a VZB1 layout change must update first (COMPATIBILITY §3.3,
     BATCH.md).

### m-2 (minor): span-local reads de-duplicate before they apply the window, so skipping changes their answer

- **Where.**
  - `engine/wasm-query/src/traces.rs` 224: `latest_records`, "an unwanted later copy hides an
    earlier one". It is used by tags and tag values.
  - `engine/wasm-query/src/traces.rs` 238: `traces(.., window)`, used by span-local metrics.
    Both run with `ALL_TIME` as the bound.
  - The README's query change passes `window` to `readSignalTail` for `spansIn`.
  - `contracts/BATCH.md` 388–389 claims "a caller cannot tell from the answer whether batches were
    skipped … (the rows it selects are the same)".
- **Scenario.** A sender sends span K starting inside the window, and later re-sends K (same
  `trace_id` and `span_id`) with a start 3 h later.
  - **Unskipped tail** (the release before, or a read with no range): the later copy hides the
    earlier one, and K is not counted.
  - **With D72 and the query change:** the later copy's batch is skipped, and the earlier copy
    is counted.
  - **Why it matters.** The answer now depends on the shard's release, which the contract says it
    cannot. D72's correctness argument covers only "every row inside the range is in a returned
    batch". These paths also depend on rows outside the range.
  - **Not a regression in consistency.** After a flush, the file side already behaves like the
    skipped tail, because files are planned by window. So the change mostly makes tail and files
    agree. It does contradict the engine's stated rule, though, and nothing tests it.
- **Reproduction.** `review-d72.test.ts`, block R3. Both copies are built by edge's encoder.

  | Call | New shard (later batch skipped) | Release before (both batches) |
  |---|---|---|
  | `tqTags` | `["first.copy","service.name"]` | `[]` |
  | `{ } \| count_over_time()` | 1 | 0 |

- **Recommendation.** Do one of these and state the semantics in D72 and `BATCH.md`:
  - **(a)** pass the window as the budget's bound for span-local calls (`budget(c, window)`). The
    engine then drops out-of-window spans before de-duplication, as D62 does, and skipping cannot
    change the answer.
  - **(b)** keep "later hides earlier" and send no range for `spansIn`.

### m-3 (minor): the query change can send `minTs > maxTs`, which turns an answerable log query into a 503 on every retry

- **Where.**
  - `query/src/signals.ts` 186 at `4c9e462` (195 at `a913aae`): `logQuery` uses `hi = max(end) − 1`.
  - `query/src/sigroutes.ts` 149: `query_range` accepts `end == start`.
  - `query/src/coordinator.ts` 483–486: `invalid` from the shard becomes 503 "retry".
  - Wrong claim: `shard/README.md` 758, "`msRange` clamps … inside what `compileFilter` accepts".
- **Scenario.** A Loki `query_range` with a log selector, `start == end` on a whole millisecond.
  - The selector's range is `[S, S)`, so `msRange(S, S−1)` gives `minTs = S/10⁶`,
    `maxTs = S/10⁶ − 1`.
  - Every log shard holding the tenant's stream answers `invalid` ("minTs is after maxTs"), and the
    query answers 503 every time.
  - Today, with `{}` sent, the same query answers 200 (empty).
  - The ledger's `plan` does not refuse such a range.
- **Reproduction.** `review-d72.test.ts`, block R4. `msRange` gives `{1795089600000,
  1795089599999}`, and the shard answers `{"status":"invalid","reason":"minTs is after maxTs"}`.
  The same read without a range answers ok.
- **Recommendation.** In `readSignalTail`, when `bound.lo > bound.hi`, read no tail: no row can
  match. Add a test.

### m-4 (minor): the walk's cost depends on the batch's shape and can be 30 to 100 times the claim

- **Where.**
  - `design/DECISIONS.md` 3748: "costs microseconds at append".
  - `shard/README.md` 372: "7.5–35 µs per batch".
  - `shard/src/shard.ts` 744: the walk runs on the append path, on the object's single thread.
- **Scenario.** The column scan is microseconds. The entry-table walk dominates when a sender makes
  many distinct resources, which is in the sender's control.
- **Reproduction.**
  - **Shapes edge builds** (`review-d72.test.ts`, block R5b; measured here in the workers test
    runtime, whose clock advanced):

    | Batch | Size | Rows / entries | Walk |
    |---|---|---|---|
    | spans: every span its own resource of 128 attributes | 1,048,224 B | 1,289 / 1,289 | **1.02 ms** |
    | logs: every record its own one-label stream | 1,048,464 B | 12,465 / 12,465 | 0.25 ms |

  - **Shapes edge never builds** (`rv-scripts/walk-hostile.mts`, Node 22): 0.38 to 2.33 ms per
    1 MiB. The walk is O(length): every loop is guarded, so no shape makes it superlinear.
- **Recommendation.** State the worst case: about 1 ms per 1 MiB append, edge-built. Add the R5b
  shape to `bench/walk.node.mjs`. Nothing needs changing unless it shows on the shard's CPU.

### m-5 (minor): the commit named D72 does not contain D72

- **Where.** `d4fd6c2` against `41e834b`, `acff995` and `514828c`.
- **Scenario.**
  - The D72 commit's diff is a README section and a comment.
  - The code, the migration, the tests, the golden file and the contract arrived in WIP snapshots
    marked "Not a green state".
  - The contract change was not in a commit of its own (AGENTS.md "Contracts first"; "One logical
    change per commit").
  - Nobody can revert, bisect or review D72 as one change. It is also not shown that the snapshots
    that carried it were green: the suite is green at `4c9e462`.
- **Recommendation.** When this reaches a pull request:
  - take the shard directory from a state its owner reported green;
  - state in the pull request which commits hold D72;
  - put the contract text in a commit of its own.

### m-6 (minor): `bounds.test.ts` never runs edge's encoder, and nothing tests m-2 or m-3

- **Where.**
  - `shard/test/bounds.test.ts` 22–24: the engine's test encoder only.
  - `shard/README.md`, "Known risks", says so.
- **Disposition.** Gap closed by this review, not a defect found. R1 builds adversarial requests
  with edge's real encoders (OTLP/JSON traces, OTLP/JSON logs, Loki push JSON). The walk equalled
  the engine's flush on every batch edge built; see "What held".
- **Recommendation.** Adopt R1 and R5b into `bounds.test.ts`, and add tests for m-2 and m-3.

### m-7 (minor): the README's last-run line points at a suite of another time

- **Where.** `shard/README.md` 306: "98 passed, 0 failed (11 files)".
- **Scenario.** Correct at `4c9e462` (reproduced). But the claim is dated to a run before the
  code was committed, and that run cannot be tied to a commit.
- **Recommendation.** Name the commit the run was made at.

### n-1 (nit): with skipping, a 422 too-much answer says "at least" when the size is exact

- **Where.** `query/src/tail.ts`: `overLast = r.seq === out.through`. `through` is the stream's
  last sequence number, which can belong to a skipped batch.
- **Scenario.** The read stops at its last *kept* batch, and every later batch is skipped. The
  total is then exact, but the 422 says "at least". The message's wording only.

## Verdict

**D72 approved with changes.**

**The safety core held.** No row inside a read's range was dropped, as every test below confirms:
- the walk agrees with the engine's strict decoder on every batch edge's real encoders produced,
  adversarial content included;
- the floor is exact at the millisecond edges;
- paging, cursors, the fence and incarnations are unchanged;
- both deploy orders and the rollback below migration 3 return supersets.

**Before the query starts sending ranges:**
- fix m-3: the guard in `readSignalTail`;
- decide m-2 and record the decision;
- decide M-1's storage layout before migration 3 ships, and correct the "without reading" claims;
- add the flags and reserved check, and the contract text, of m-1.

The rest can follow.

## What held

- **The walk against edge's real encoders.** Block R1 decoded 180 random requests with edge's
  decoders and encoders, and the walk agreed with `engine.encodeSpans`/`encodeLogs` on every batch.
  - **Batches.** 284 batches holding 11,247 rows (traces 118, OTLP logs 53, Loki push 113), plus
    one at the entry limits: 30 resources of 128 attributes with 1,000-byte keys, 8,192-byte scope
    names, a 60,000-byte scope attribute. **No batch** got NULL bounds.
  - **Values.** Every AnyValue kind: string, int, double including NaN and ±Inf, bool, bytes,
    nested arrays and key-value lists, empty `{}`, empty array and list.
  - **Keys and strings.** 1,024-byte keys, 65,536-byte values, non-ASCII and NUL characters.
  - **Times.** From 0 to 2^63−1, on and next to millisecond edges.
  - **Span rows.** Ends before starts (clamped), events and links.
  - **Log records.** With `time_unix_nano`, with only `observed_time_unix_nano` (edge stores it as
    `ts`), and with both far apart.
  - **Rejections.** Edge refused 6,176 items for its own limits; those never reach a shard.
- **The column computed.** The walk reads span `start` (column 5, after `entry`, `trace_id`,
  `span_id` and `parent_span_id`) and log `ts` (column 2), matching `edge/src/spans.ts` 436–441
  and `edge/src/logs.ts` 391–393. Edge substitutes `observed` for a missing `ts`, so the walked
  `ts` is the time LogQL selects by.
- **Millisecond flooring.** It is exact: `BigInt` division of a non-negative i64. The proof that
  every `t ∈ [lo, hi]` has its batch overlapping `[⌊lo/10⁶⌋, ⌊hi/10⁶⌋]` checks out.
  - Negative times give NULL. Huge times up to `2^63−1 → 9,223,372,036,854` ms are exact.
  - `msRange` clamps to the same range.
  - The reviewer's mutant "floor through a double" was killed by 3 tests.
- **Batches whose entries span hours.** They keep a hull: correct, and they skip less. Edge's
  24-hour accept window lets one batch span a day; D72 states the effect.
- **Paging and fences (D48).**
  - Bounds are written once at insert and never updated, so the kept set is the same on every page.
  - `next` always names a kept batch above the cursor, so a read with a range neither misses nor
    duplicates a batch.
  - `page_limit` names a kept batch.
  - The fence and the incarnation are checked before `tailPage`, as before.
  - The cursor's binding is unchanged, because `minTs` and `maxTs` were already in the canonical
    text.
  - A read cannot loop: `readPages` refuses a page that does not advance.
- **Release skew in both orders.**
  - Old query with a new shard: no range is sent, so nothing is skipped.
  - New query with an old shard: the old shard returns every span and log batch. The fixed
    snapshot `prebounds/tail.ts` returns signals 2 and 3 whole.
  - A shard redeployed between two pages: the union of the pages is a superset.
- **Rollback below migration 3.** The release before opens schema 3 (`readableFrom` 1), and its
  `INSERT` names its columns, so its rows get NULL bounds and are kept. A roll-forward migrates
  once. No `UPDATE` of `batch` touches the bounds. `bench/prebounds` matches `fd4b75a`.
- **The trace paths D62 bounds.** Search, metrics over whole traces and trace by ID drop
  out-of-bound spans *before* de-duplication (`traces.rs` `each_span`), so skipping cannot change
  them.
  - The extent and hours of `tqExtent` use only in-bound tail spans.
  - The query passes the bound, not the window or the hull, for these paths.
- **Log paths.** LogQL's de-duplication key includes `ts`. `lq_labels` filters each stream by its
  rows' times (`logs.rs` 372 and 393, with `sigfiles.rs` `batch_streams` 849–864). So a skipped
  batch, which holds no row in range, cannot change either answer (m-3 aside).
- **Metric reads.** Signal 1 gets NULL bounds and is filtered row by row as before. The reviewer's
  mutant "metric batches walked" was killed.
- **Tenant naming.** Every D72 statement names the tenant: the `INSERT` and the `tailPage`
  `SELECT`. The migration is DDL only.
- **Hostile walks.** O(length), guarded on every step; see m-4 for the constant.
- **Tests have teeth.** The author's 13 mutants are listed. The reviewer ran 5 more, on a separate
  copy (`rv-d72-mut`), against `bounds.test.ts`, and all were killed:

  | Mutant | Tests that failed |
  |---|---|
  | MA: no padding after the `entry` column | 7 |
  | MB: floor through a double | 3 |
  | MC: the upper comparison dropped | 5 |
  | MD: bounds from the first and last row only | 5 |
  | ME: metric batches walked | 2 |

- **The suite.** 98 of 98 and `tsc` clean at `4c9e462`.

## Reproduction index

The scratchpad is `/tmp/claude-0/-home-user-viz/3c79101e-93fd-5a8e-90a7-fca4d8b40aab/scratchpad`.

1. **Build the copy.** From `/home/user/viz`:
   ```
   git archive 4c9e462 shard contracts ledger edge/src engine/wasm/js engine/wasm/test engine/wasm-query/js | tar -x -C $SP/rv-d72
   ```
   Then copy `engine/wasm/js/viz_engine.wasm` and `engine/wasm-query/js/viz_query.wasm` from the
   working tree (they are not committed), and symlink `shard/node_modules` and `node_modules`.
2. **Run the review's tests.** The file is `$SP/rv-d72/shard/test/review-d72.test.ts`, also kept
   at `$SP/rv-scripts/review-d72.test.ts`:
   ```
   cd $SP/rv-d72/shard && npx vitest run test/review-d72.test.ts --maxWorkers=2 --silent=false
   ```
   10 of 10 pass; each test asserts the behaviour reported.

   | Block | Finding |
   |---|---|
   | R1 | held: walk equals flush on edge's encoders |
   | R2 | m-1 |
   | R3 | m-2 |
   | R4 | m-3 |
   | R5 | hostile shapes, for m-4 |
   | R5b | edge's worst shapes, m-4 |

3. **M-1:**
   ```
   python3 -I $SP/rv-scripts/overflow.py $SP/rv-sqlite
   ```
4. **m-4, hostile shapes in Node:**
   ```
   cd $SP/rv-scripts && node --experimental-strip-types --no-warnings walk-hostile.mts
   ```
5. **Mutants MA to ME.** Applied one at a time with `sed` to `$SP/rv-d72-mut/shard/src/{tail,shard}.ts`,
   each followed by `npx vitest run test/bounds.test.ts --maxWorkers=2`, and restored after each.
   The shared tree was never mutated.
6. **Baseline:**
   ```
   cd $SP/rv-d72/shard && npx vitest run --maxWorkers=2 && npx tsc --noEmit
   ```
   98 of 98, clean (run with `review-d72.test.ts` moved out).

**Not done.** No measurement on Cloudflare: neither workerd's SQLite nor Durable Object storage
for M-1. The query's tests were not run with the uncommitted change.

## Summary row for design/REVIEW.md

| `reviews/d72-tail-bounds.md` | D72: a shard records span and log batch time bounds at append and skips batches outside a read's range (`shard/src/tail.ts`, `shard.ts` migration 3, `contracts/BATCH.md`, the query change in `shard/README.md`), on the development branch at `4c9e462` | 0 blockers, 1 major (M-1: deciding to skip reads the whole payload from storage, because the bounds follow it in the record; measured here 33.12 MB read to skip 33.03 MB, the same as reading it; "without reading" claimed in four places; D48's per-call scan bound no longer bounds it; a covering index read < 4 KB), 7 minors (m-1 the walk ignores flags and reserved while `BATCH.md` still says shards never look inside, so a flag-signalled layout change would record wrong bounds and skip rows, reproduced; m-2 span-local tags and metrics de-duplicate before the window, so skipping changes their answer and the shard's release shows in it, reproduced; m-3 the query change sends `minTs > maxTs` for a log `query_range` with `start == end`: a 503 on every retry, reproduced; m-4 the walk is up to about 1 ms per edge-built 1 MiB batch, not microseconds; m-5 the D72 commit holds none of D72, which arrived in non-green snapshots, with the contract not in its own commit; m-6 the tests did not use edge's encoder (closed: 284 edge-built batches agree with the flush); m-7 the last-run line is not tied to a commit), 1 nit. The safety core held: no row inside a range was dropped; paging, fences, skew in both orders and the rollback below migration 3 held; 5 more mutants killed. D72 approved with changes: m-3 and the m-2 decision before the query sends ranges, M-1's layout before migration 3 ships | Open |
