# Compact

Compaction: the small per-segment files a tenant's flushes leave behind become fewer,
larger, sorted files (`design/DESIGN.md` §5.2). Stateless; the ledger is the only state.

| File | Contents |
|---|---|
| `src/compact.ts` | `chooseJob` (the policy, a pure function), `compactStep` (one merge), `compactTenant` (steps until idle), `pairFiles`, `compactedKey`, `inputsHash16`, and the inputs record every output carries (`encodeCompactionInputs`, `decodeCompactionInputs`) |
| `src/formats.ts` | `FORMATS`: what this component writes that another release reads, with its version (contracts/COMPATIBILITY.md §3.1) |
| `src/index.ts` | `Compact` entrypoint (RPC `compactTenant`), `CompactWorkflow` (the same step function as a Workflow), one engine per isolate |
| `test/compact.test.ts` | 18 tests in workerd against the real `Shard`, `Ledger`, flush and a simulated R2, 4 of them the interleavings of review R-2 and the protocol model's F13/F14 |
| `test/signals.test.ts` | 10 tests: compaction of `spans`, `trace_index` and `logs` (open hour, closed day, an engine without the merge) and D30's cases for those tables |
| `test/golden.test.ts`, `test/golden/` | 6 tests: golden files of the output key (metric and signal shapes) and the inputs record, and the record's reader (a spans output's inputs are of its own hour) |
| `test/workflow.test.ts` | 1 test: the Workflow run under `introspectWorkflowInstance` |

Bindings: `LEDGER`, `BUCKET`, `CELL`; `COMPACT` (the Workflow). `SHARD` only for tests.

## What is implemented

**One step** (`compactStep(env, engine, tenant)`):

1. `ledger.plan` for both tables at one ledger version; files are paired (a samples file
   with the series file of the same unit or merge, by key: `contracts/TABLES.md`, "Pairing").
2. `chooseJob` picks the inputs (policy below), or the step is `idle`.
3. The inputs are read from R2, six at a time, one table at a time.
4. `engine.mergeFiles` twice: samples inputs → one samples file, series inputs → one series
   file. Inputs are passed in **ascending precedence** (`contracts/ledger.ts` `LiveFile`),
   the order a read uses, so every row of the output has its latest write. (Until this
   review they went in key order; keys sort as text, so a stream's tenth flush sorted before
   its second and a merge could keep an older value: `DECISIONS.md` D22.)
5. Both outputs are PUT in parallel under content-hashed keys with `If-None-Match: *`
   (flush's `putFile`: an existing object counts only if its size and SHA-256 match). Each
   carries its **inputs record**, R2 custom metadata `viz-inputs` =
   `{"v":1,"inputs":[every input key, samples sorted then series sorted]}`: the list whose
   hash is the key's `inputs16`.
6. **One** `ledger.replace({ remove: every input of both tables, add: both outputs })`.

| `replace` answers | The step |
|---|---|
| `ok` (also as a replay: outputs live, inputs not) | `merged` |
| `conflict` (an input is no longer live, or another merge made a file the outputs would jump over) | returns `conflict` and **deletes nothing**; the caller plans again. The outputs are the orphan sweep's (below) |
| `invalid` | returns `error: invalid`; nothing changed |
| anything else (a newer ledger; `schema_too_new` during a deploy) | throws: fail closed, the maintenance run is retried. Never taken for a conflict or a success |

Three more refusals happen before `replace`: `too_many_inputs` (the input names do not fit in
6 KB of object metadata; refused before any work, never written without its record),
`row_count` (the merged file has more rows than its inputs together, fewer than its largest
input, another day or another table) and `too_slow` (the step has run longer than
`maxStepMs`: it bounds the work of one step; it is no longer what makes the sweep safe).

### Who deletes a compaction output, and when (`design/DECISIONS.md` D30)

Stated precisely, for an independent check (the protocol model's owner is modelling it).

- **Keys.** An output's key is `…/L{level}-{span}-{inputs16}-{hash8}.parquet`, `inputs16` a
  hash of its input keys, `hash8` of its bytes. Steps with the same inputs and bytes write the
  same object; a later step whose PUT finds it answers `exists` and **adopts** it.
- **A step never deletes an object.** Not after a crash, not on `too_slow`, not on
  `conflict`, not on an answer it does not know. (Before D30 a conflicted step deleted its
  outputs when the ledger neither listed nor tombstoned them: the model's F14.)
- **The orphan sweep (`janitor/src/janitor.ts` `sweepOrphans`) deletes an output O only if,
  all at once:**
  1. O was in the sweep's listing of the tenant's prefix, with a readable inputs record whose
     keys are under O's own tenant and day and hash to O's `inputs16` (otherwise O is kept
     for ever: `unknown_inputs`);
  2. in ONE ledger read (`orphanCheck`, after the listing) O is neither live nor tombstoned;
  3. some input I of O was **absent** from that listing **and** is not live in that same read;
  4. O is at least `max(orphan grace, 2 × maxStepMs)` old (an age floor; not needed for safety).
- **Why that is safe.** `replace` admits O only with every input live. An object is deleted
  only (a) by purge, after the ledger's LOGGED removal of its key and the delete grace, or
  (b) by this sweep, when it can never be listed (a flush file below its stream's logged
  watermark, or of an older incarnation whose newer one has a logged unit; or an output by this
  rule, inductively). A key whose removal is logged never becomes live again, even after a
  rebuild from the log. So I, absent and not live, is never live again, and no step, whether it
  created O, adopted it or will, can ever make O live: whatever happens between the sweep's
  read and its delete, and however old O is.
- **What it does not rest on.** Clocks (R2's upload time, the Worker's step deadline), the
  order of steps, or whether the conflicting removal is logged yet.
- **The premise it does rest on.** Every deleter deletes only keys that can never be live
  again. The flush-file rule's newer-incarnation case satisfies it only with the F15 fix
  (`janitor/README.md`). Nothing else in viz deletes data objects.

**Policy** (`chooseJob`, defaults in `DEFAULT_POLICY`):

| | Rule |
|---|---|
| Closed day | A UTC day is closed 2 h after it ends (`closeAfterMs`: the one-hour accept window plus time for the last segments to be flushed). Its pairs below level 2, and level-2 pairs under 4 MB (`smallL2Bytes`), are merged in time order into level-2 pairs. The oldest closed day goes first. A late flush file for a closed day is folded in the same way; a single remaining level-0/1 pair is rewritten as level 2 |
| Open hour | Pairs are bucketed by the UTC hour of their newest sample. A bucket is merged into one level-1 pair when it holds K = 4 level-0 pairs (`minL0Files`), or at least one and its newest sample is M = 10 min old (`maxL0AgeMs`). The bucket's level-1 pairs are merged in too, so an hour converges to one pair |
| Budget | A merge reads at most 16 MB (`maxInputBytes`, samples + series) in at most 8 pairs (`maxInputPairs`). A larger job is several merges. A pair over the budget on its own is left as it is |
| Precedence | Candidates are taken in ascending precedence, and a pair joins a group only if the group still jumps over no live file of the day (paired or not) that overlaps it in time and ranks inside its range (`jumpsOver`): the output would otherwise rank above that file with rows older than its. A closed day's groups are runs in precedence order and never jump; an open hour's may be cut short |

"Age" is data time (the newest sample), not write time: `FileEntry` carries no creation
time. Level-1 files are clustered by hour, not hour-pure: late rows travel with their file.

**Driver: both, and why.** The unit is the step function, because every step re-plans from
the ledger and so needs no memory of the previous one; that is what the property test and
the soak drive, in any order. `CompactWorkflow` wraps it (one `step.do` per merge, retried
by the Workflows runtime, each returning a few bytes) and is tested: `@cloudflare/vitest-plugin`'s
Workflow introspection works here. In `stack/` the maintenance queue's consumer calls the
step function directly (up to 8 merges per message, then a follow-up message), because a
queue retry gives the same guarantee for an idempotent step and keeps one mechanism for
compaction, retention and deletion. The Workflow is the wrapper to use for a backlog too
large for queue invocations; nothing starts it yet.

## Spans, trace_index and logs (2026-11-19, design/DECISIONS.md D68)

When the metric tables have nothing to merge, `compactStep` looks at `spans`, `trace_index` and
`logs` in turn (`SIGNAL_TABLES`), each table on its own: one `ledger.plan`, `chooseJob` over
one-file units (`signalUnit`), and the metric step's sequence for the job it finds (`signalStep`):
GET the inputs (six at a time), `engine.mergeSignalFiles(table, inputs in ascending precedence)`
(engine/wasm ABI 4), the same `row_count` refusal (and for `spans` the output's hour must be the
job's), the inputs record, `putFile` with `If-None-Match: *` (adopting an identical object), the
step deadline, ONE `replace({ remove: inputs, add: [output] })`, and the same answers (`merged`,
`conflict` with nothing deleted, `invalid`, a thrown unknown answer). `JobSummary.table` names
the table. An engine without `mergeSignalFiles` (a plain `contracts/engine.ts` `Engine`) gets
the metric behaviour only: the span and log tables are left as they are.

- **`spans` never cross an hour.** A spans unit carries its hour partition (`Unit.hour`, from the
  key's `hour=HH/`). An open hour's bucket is that hour; a closed day's candidates are grouped by
  hour, so a closed day's spans become one level-2 file per hour. The output key is
  `…/day=D/hour=HH/L{1|2}-hHH-{inputs16}-{hash8}.parquet` (`compactedKey` takes the hour for
  `spans` at both levels and refuses a spans key without it).
- **`trace_index` and `logs`** merge per day as metrics do (`L1-hHH` for an open hour's bucket,
  clamped to 23 for a trace_index file whose newest end is in the next day; `L2-d`).
- **Nothing pairs them.** A unit is one file and a merge's inputs and output are of one table;
  `inputs16` and the inputs record list that table's keys only.
- **The inputs record** keeps its format (`r2.compaction-inputs` v1). `decodeCompactionInputs`,
  which the janitor's orphan sweep calls, now reads span and log outputs: a spans output's inputs
  must lie under its own `…/day=D/hour=HH/` prefix, a trace_index or logs output's under its own
  table and day, a metric output's under the two metric tables of its day, each directly (no
  deeper `/`). A janitor of the release before reads such an output as `unknown_inputs` and keeps
  it (never deletes it): safe, and why no version changed.

## The index fragment of an output (2026-11-19)

Outputs carry the fragment `engine.mergeFiles` writes (`engine/storage`), which since
2026-11-19 holds each row group's first and last `series_id` and where the footer is
(`contracts/TABLES.md`, "The index fragment"): the read path uses them to range-read only the
row groups a query needs. Nothing in `src/` changed for it: `compactStep` passes the
fragment through to `ledger.replace` as before, so compaction preserves it, and an output
merged from flush files written before the change gets the new fields (the merge writes a
fresh fragment). The Parquet bytes of a merge are unchanged (`engine/storage`,
`the_parquet_bytes_are_those_the_previous_writer_wrote`). Checked by the first `compactStep`
test, which now also asserts that every input's and output's fragment has `sid` for every row
group and a `foot` that ends at the object's size; `engine/wasm/js/viz_engine.wasm` was
rebuilt from the new `engine/storage` for it (a build artifact; no source of `engine/wasm`
changed).

## Memory (measured here, Node 22, `engine/wasm/tools/measure_merge.mjs`)

Inputs shaped like flush files of incompressible values (random doubles, jittered
timestamps), 2,000 series; a fresh WASM instance per merge, so the figure is that merge's peak.

| Samples inputs | Rows | Peak WASM memory | Time |
|---|---|---|---|
| 4 files, 7.7 MB | 0.8 M | 39 MB | 0.46 s |
| **8 files, 15.4 MB (the largest step allowed)** | 1.6 M | **70 MB** | 0.8–1.2 s |
| 16 files, 30.9 MB | 3.2 M | 132 MB | 1.9 s |
| 2 files, 67 MB | 8 M | 150 MB | 2.8 s |

The series merge of the same step peaks at 6 MB. Peak is about inputs + output + 4 MB per
open input (one decoded row group each). Outside WASM the isolate also holds the inputs as
fetched (≤ 16 MB) and the copied-out output (≤ 16 MB): about 100 MB in all for the largest
step, under the 128 MB limit, which local workerd does not enforce. Before the merge was
changed to read inputs in place and pre-size its output, 15.4 MB of inputs peaked at 113 MB
and 62 MB at 383 MB; the task's example bound of 64 MB per call does not fit a Worker
without a streaming merge.

## R2 operations and time per merge

For n input pairs: 2n GETs (six in flight), **2 PUTs in parallel** (never more than six
requests in flight from one step), and one ledger change (`replace`). The ledger answers
`replace` when its SQLite transaction commits and writes the change to R2 later, batched with
whatever else is pending (`contracts/LEDGER-LOG.md`), so no R2 write of the ledger's is on the
step's path. A conflict costs nothing more: the step deletes nothing. Locally a step takes
20–150 ms for test-sized inputs and 0.8–1.2 s of merge at the budget.

Estimated on Cloudflare, modelled from measured parts: reads 0.05 s each (`spikes/s1-fanout-r2/`),
writes 0.17–0.26 s at the median up to 1 MB and 0.56 s for 8 MB, 0.6 s and 1 s at the tail
(`spikes/s5-r2-writes/`), and production CPU about twice this sandbox's wall time for the
engine (`DECISIONS.md` D5). A merge at the budget (8 pairs, 16 MB): reads ⌈16/6⌉ × 0.05 =
0.15 s, merge 1.6–2.4 s, two PUTs in parallel 0.3–0.6 s (outputs up to about 15 MB, more
at the tail), `replace` one Durable Object round trip and a SQLite commit (tens of
milliseconds, modelled; the batched log's `addUnit` time on Cloudflare is being re-measured in
`spikes/s4-ledger-scale/rerun/`): **about 2–3.5 s per merge at the budget; about 0.3–0.6 s for
a small hourly merge** (two small PUTs). Not measured on Cloudflare; the experiment that
settles it is a merge run in a deployed Worker (`design/VERIFICATION.md` §4).

## Not implemented

- **A Container** for merges over the Worker budget, and therefore 128 MB day files.
- **Streaming merge.** Inputs and output are whole in memory.
- **Rollups** and index-fragment consolidation. (Spans, trace_index and logs are compacted since
  2026-11-19, D68; re-aggregating `trace_index` from de-duplicated spans is not built: merged
  fragments keep counting a span retried into two units twice, as query-time merging does.)
- **A longer close for span and log days.** Their accept window is 24 h (edge's default), the
  metric one 1 h, but the policy closes every day 2 h after it ends: late span and log files for
  a closed day become small level-2 files (merged with the day's other files under 4 MB).
- **A creation time on files**, so "older than M minutes" is by data time.
- **Starting the Workflow** from the stack; it is built and tested, not wired.
- **A Parquet format marker** (`viz.format`, design/UPGRADES.md §7 item 7) in the outputs:
  that is the engine's encoding; not done here.
- **Rewriting the inputs record of an adopted object.** An object written before D30 has
  none; a step that adopts it does not add one (it would need an unconditional overwrite).
- Not run on Cloudflare.

## How it was verified

```
(cd ../engine/wasm && ./build.sh)
npm ci && npx vitest run --maxWorkers=2    # 34 tests in workerd, 4 files
npx tsc --noEmit                           # clean
```

**Spans and logs (2026-11-19).** `npx vitest run --maxWorkers=2`: **34 of 34** (10 new in
`test/signals.test.ts`, 1 new and 1 extended in `test/golden.test.ts`); `tsc --noEmit` clean; the
janitor's suite (31 of 31, it imports `decodeCompactionInputs`) and flush's (59 of 59, they share
the engine module) pass unchanged. Files are read back with **hyparquet**, which shares no code
with viz:

| Test | What it asserts |
|---|---|
| open hour: spans, then trace_index, then logs | the step takes spans first (metric tables empty): one level-1 file under `hour=12/` named `L1-h12-…`, its content hash in the key, its inputs record decoding to the job's inputs, the ledger listing it alone; then trace_index (trace 99's four fragments one row of four spans), then idle; a reader sees the same spans (the rewritten root with its later name), traces and log rows (the repeated row once, the later severity) before and after; the logs output's `tok` points at `VZT1` and equals the footer's `viz.token_filter` |
| closed day | spans over three hours become three level-2 files, `hour=HH/L2-hHH-…`; trace_index and logs one `L2-d` file each; the reader's rows never change |
| an engine without the merge | idle; the four spans files stay |
| D30, spans and logs: crash after PUT | the output exists, unlisted, rows unchanged; the retry answers `exists` with a sweep 25 h on run between its PUT and its replace (review R-2): nothing deleted, one level-1 object, rows unchanged |
| D30, spans and logs: three steps at once | every result `merged` or `conflict`, one output object, rows unchanged |
| D30, spans and logs: retention during a step | an old day's merge; retention expires the day (spans with trace_index, logs) after the PUT: `conflict`, the output left in R2, the expired day not back; the sweep keeps the output while the expired inputs exist and deletes exactly it once they are purged; nothing of that day left |
| a spans output's record under its hour | the record names that hour's files; the same record with another hour's keys is refused; the leftover is kept a year on while its inputs are live |
| golden | the key shapes of spans (both levels, under the hour), trace_index and logs outputs are pinned with the metric ones (`key.compaction-output.v1.json`, fields added; the metric fields unchanged); a spans record is refused for another hour, another table, metric keys; a logs record read back; a logs record under a spans key refused |

**Mutants** (`stack/scripts/mutants.mjs signals`, on a copy of the tree in a scratch directory):
see "Mutants of the span and log compaction" below.

Last run 2026-11-19 against the real tree, with the ledger draining its log asynchronously
(`contracts/LEDGER-LOG.md`): 24 of 24, tsc clean. The suite pins `LEDGER_DRAIN_DELAY_MS` to 60 s
(`vitest.config.ts`), as `ledger/` does, and drains the ledger where a test needs something
logged (`flushSettled` in `flush/test/helpers.ts`, `changesOf`, and `drain()` before a purge, since
a removal is deletable only once logged), so no assertion depends on when the ledger's alarm
happens to run. The R-2/F13/F14 tests were shown to fail before D30 against a stable copy of the
ledger of that time (snapshot `dc2a1c3`); the failures are quoted in the table.

| Test | What it asserts |
|---|---|
| policy (4) | pairing by key and stray files; open hour by count and by quiet time, with `nextDueAt`; closed day, budget in pairs and bytes, small level-2 files, oldest day first; precedence: no group jumps over an overlapping file (paired, a big level-2 file, or unpaired), a non-overlapping one may be jumped, a closed day is merged in precedence order whatever the key or time order |
| merges an hour into one level-1 pair | identical query result (I8), the ledger lists exactly the pair, the log holds ONE `replace` naming both tables, keys per the contract with the content hash recomputed |
| removes duplicate rows two flush files share | 96 rows in, the distinct rows out, result unchanged |
| a step that stops after its PUTs | repeated with the same keys, `exists`, no second object |
| conflict (`blocking`) | not a test of its own here: the ledger's refusal of a swap that would jump over a file is in `ledger/test/precedence.test.ts`, and `compactStep` handles it as any conflict (concurrent steps with different policies hit it in `stack/test/precedence.property.test.ts`) |
| conflict | retention expires an input between PUT and `replace`: nothing swapped, the outputs left in place, the expired day does not return; the sweep keeps them until the expired inputs are purged, then deletes them |
| conflict after an identical step won | a slow step's twin finishes, a reader takes a plan listing the twin's outputs, retention removes them; the slow step's `replace` conflicts and it deletes nothing (the reader can read every file) |
| fails closed on an unknown `replace` answer | a ledger answering `schema_too_new` from `replace`: the step throws, nothing swapped, nothing deleted |
| **R-2**, ported from the reviewer | attempt 1 crashes after its PUTs; attempt 2 adopts the objects (`exists`) and a sweep with its clock 25 h ahead runs between attempt 2's PUT and `replace`: nothing deleted, the listed outputs exist, the rows survive the purge of the inputs. Failed before D30 (the sweep deleted both outputs) |
| **R-2**, the review's exact sequence | the sweep lists the leftover and asks the ledger; before it deletes (`beforeDelete` hook) the adopting attempt commits; the sweep then deletes nothing. Failed before (a live pair with no objects) |
| **F14**, the model's trace | steps A and B, same inputs; while A is between PUT and `replace`, B runs with retention expiring the inputs unlogged, B conflicts; the ledger loses its storage and rebuilds without the expiry; A commits. Every listed file has its object. Failed before (B had deleted them) |
| a leftover is deleted once its inputs are gone for good | kept a year on while inputs are live; kept while they are expired but not purged; deleted once purged |
| golden (5) | `inputs16` and both key shapes of fixed inputs; the inputs record; every output a real step writes carries it and it decodes to the step's inputs; the reader refuses a newer version, a list that does not hash to the key, keys of another tenant, no record, not JSON |
| two (three) steps at once | one pair, one `replace` in the log, no stray object |
| closed day | several budgeted merges take every file to level 2; result never changes |
| guards | `row_count` and `too_slow` leave the ledger untouched |
| Workflow | runs to `complete` under introspection, one merge per step, files end at level 2 |

The property test for I8 and the soak are in `stack/` (`test/compaction.property.test.ts`,
`test/soak.test.ts`). Mutants: `stack/scripts/mutants.mjs compaction` and `review` (run on a
copy, never in the checkout); results in `stack/README.md`.

## Contract issues

- **`contracts/engine.ts` has no signal merge.** The merge is `SignalMergeEngine.mergeSignalFiles`,
  declared next to the binding (`engine/wasm/js/index.ts`), not in the contract, which this
  change could not edit. `compactStep` keeps taking a contract `Engine` and checks for the method
  at run time, so `stack/src/maintain.ts` (typed against the contract) is unchanged. The
  interface belongs in `contracts/engine.ts` beside `SignalFlushEngine`.

## Formats (contracts/COMPATIBILITY.md)

`src/formats.ts` lists what compaction writes for another release: `key.compaction-output` v1
(the key, `inputs16` and the content hash are derived identifiers, §3.4) and
`r2.compaction-inputs` v1 (the `viz-inputs` metadata, read by `janitor/`). Each has a golden
file in `test/golden/formats/`; `janitor/test/golden.test.ts` reads compact's golden record as
an independent reader. A reader refuses a record whose `v` it does not know by keeping the
object (§3.2).

## Known risks

- **Memory of a span or log step at the budget** is close to an isolate's: the WASM peak is 62 MB
  (spans) and 81 MB (logs whose lines carry unique ids, 16 MB in, 22 MB out), and the JS side
  holds the inputs as fetched and the copied-out output besides, about 119 MB for that logs step
  (modelled; engine/wasm/README.md). Not measured on Cloudflare.
- **A span id re-sent with a start in another hour** lies in two hours' files, which no merge
  joins; after a merge of one hour, precedence can order the older copy above the newer one
  (contracts/TRACES.md, "Compaction"). A retried OTLP request carries the same start.

- **Hours left unmerged.** The precedence rule (no merge jumps over an overlapping file)
  can stop an open hour's merges while a segment of the neighbouring hour that straddles
  the boundary was admitted in between; such files wait for their day to close. How often
  that happens on real traffic is not measured (`DECISIONS.md` D22).
- **The row-count check is a bound**, not a proof: it catches a merge that lost most rows
  or invented some, not one that dropped a few. I8 rests on the engine's tests and the
  property test.
- **Write amplification.** An hour's level-1 pair is rewritten whenever new flush files
  join it, and a late file for a closed day rewrites a level-2 pair.
- **Clock.** `closeAfterMs` and the step deadline use the Worker's clock. Since D30 no
  deletion depends on a clock (before it, the orphan sweep judged outputs by R2's upload time
  against the step deadline, which an adopted output defeated: review R-2, the model's F13).
- **F14 is fixed by D30, not by the model's step-unique keys.** A conflicted step used to
  delete its outputs when the ledger did not know them; after a ledger rebuild that undid an
  unlogged removal, an identical step could then commit the deleted objects (a live file with
  no object). Steps now delete nothing, and the sweep deletes an output only once an input is
  gone for good. Shown by the interleaving test "spec F14" (fails before the change). The
  model checks the rule within the bounds F13, F14 and F15 were found at (`spec/README.md`, C1
  and C2): bounded, not exhaustive.
- **Leftover outputs cost storage until an input is purged.** A crashed or conflicted step's
  outputs stay until an input of theirs is purged (its delete grace, then the next orphan
  sweep, at most daily), or as long as their inputs stay live (a retry adopts them). Bounded by
  retention. Not measured on real traffic.
- **An output without a readable inputs record is never deleted automatically** (objects
  written before D30, none deployed; a record of a newer version during a rollback). The sweep
  reports them as `unknown_inputs`.
