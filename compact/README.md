# Compact

Compaction: the small per-segment files a tenant's flushes leave behind become fewer,
larger, sorted files (`design/DESIGN.md` §5.2). Stateless; the ledger is the only state.

| File | Contents |
|---|---|
| `src/compact.ts` | `chooseJob` (the policy, a pure function), `compactStep` (one merge), `compactTenant` (steps until idle), `pairFiles`, `compactedKey` |
| `src/index.ts` | `Compact` entrypoint (RPC `compactTenant`), `CompactWorkflow` (the same step function as a Workflow), one engine per isolate |
| `test/compact.test.ts` | 13 tests in workerd against the real `Shard`, `Ledger`, flush and a simulated R2 |
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
   (flush's `putFile`: an existing object counts only if its size and SHA-256 match).
6. **One** `ledger.replace({ remove: every input of both tables, add: both outputs })`.

| `replace` answers | The step |
|---|---|
| `ok` (also as a replay: outputs live, inputs not) | `merged` |
| `conflict` (an input is no longer live: retention or another merge took it) | deletes its two outputs, after the ledger confirms in one read that it knows neither (not live, not tombstoned), and returns `conflict`; the caller plans again. Outputs the ledger knows were made by an identical step that won (keys are a function of the inputs); if they have been removed since, they are tombstoned, a reader holding an older plan may still read them, and only the janitor deletes them after the grace |
| `invalid` | returns `error: invalid`; nothing changed |

Two more refusals happen before `replace`: `row_count` (the merged file has more rows than
its inputs together, fewer than its largest input, another day or another table) and
`too_slow` (the step has run longer than `maxStepMs`; the orphan sweep relies on this, see
`janitor/README.md`).

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
requests in flight from one step), and one ledger change (`replace`; today one more PUT on
the ledger's side). A conflict adds one DELETE request for both outputs. Locally a step
takes 20–150 ms for test-sized inputs and 0.8–1.2 s of merge at the budget.

Estimated on Cloudflare, modelled from measured parts: reads 0.05 s each (`spikes/s1-fanout-r2/`),
writes 0.17–0.26 s at the median up to 1 MB and 0.56 s for 8 MB, 0.6 s and 1 s at the tail
(`spikes/s5-r2-writes/`), and production CPU about twice this sandbox's wall time for the
engine (`DECISIONS.md` D5). A merge at the budget (8 pairs, 16 MB): reads ⌈16/6⌉ × 0.05 =
0.15 s, merge 1.6–2.4 s, two PUTs in parallel 0.3–0.6 s (outputs up to about 15 MB, more
at the tail), `replace` 0.17–0.26 s until the ledger's log is batched: **about 2–3.5 s per
merge at the budget; about 0.5–0.8 s for a small hourly merge** (two small PUTs and the
ledger's write). Not measured on Cloudflare; the experiment that settles it is a merge run
in a deployed Worker (`design/VERIFICATION.md` §4).

## Not implemented

- **A Container** for merges over the Worker budget, and therefore 128 MB day files.
- **Streaming merge.** Inputs and output are whole in memory.
- **Rollups**, index-fragment consolidation, and anything for tables other than metrics.
- **A creation time on files**, so "older than M minutes" is by data time.
- **Starting the Workflow** from the stack; it is built and tested, not wired.
- Not run on Cloudflare.

## How it was verified

```
(cd ../engine/wasm && ./build.sh)
npm ci && npm test       # 14 tests in workerd, 2 files
npx tsc --noEmit         # clean
```

| Test | What it asserts |
|---|---|
| policy (4) | pairing by key and stray files; open hour by count and by quiet time, with `nextDueAt`; closed day, budget in pairs and bytes, small level-2 files, oldest day first; precedence: no group jumps over an overlapping file (paired, a big level-2 file, or unpaired), a non-overlapping one may be jumped, a closed day is merged in precedence order whatever the key or time order |
| merges an hour into one level-1 pair | identical query result (I8), the ledger lists exactly the pair, the log holds ONE `replace` naming both tables, keys per the contract with the content hash recomputed |
| removes duplicate rows two flush files share | 96 rows in, the distinct rows out, result unchanged |
| a step that stops after its PUTs | repeated with the same keys, `exists`, no second object |
| conflict (`blocking`) | not a test of its own here: the ledger's refusal of a swap that would jump over a file is in `ledger/test/precedence.test.ts`, and `compactStep` handles it as any conflict (concurrent steps with different policies hit it in `stack/test/precedence.property.test.ts`) |
| conflict | retention expires an input between PUT and `replace`: nothing swapped, both outputs deleted, the expired day does not return |
| conflict after an identical step won | a slow step's twin finishes, a reader takes a plan listing the twin's outputs, retention removes them; the slow step's `replace` conflicts and it deletes nothing (the objects are tombstoned and the reader can read every file). Found in this review: the step used to delete them, because it asked only whether they were live |
| two (three) steps at once | one pair, one `replace` in the log, no stray object |
| closed day | several budgeted merges take every file to level 2; result never changes |
| guards | `row_count` and `too_slow` leave the ledger untouched |
| Workflow | runs to `complete` under introspection, one merge per step, files end at level 2 |

The property test for I8 and the soak are in `stack/` (`test/compaction.property.test.ts`,
`test/soak.test.ts`). Mutants: `stack/scripts/mutants.mjs compaction`; results in `stack/README.md`.

## Known risks

- **Hours left unmerged.** The precedence rule (no merge jumps over an overlapping file)
  can stop an open hour's merges while a segment of the neighbouring hour that straddles
  the boundary was admitted in between; such files wait for their day to close. How often
  that happens on real traffic is not measured (`DECISIONS.md` D22).
- **The row-count check is a bound**, not a proof: it catches a merge that lost most rows
  or invented some, not one that dropped a few. I8 rests on the engine's tests and the
  property test.
- **Write amplification.** An hour's level-1 pair is rewritten whenever new flush files
  join it, and a late file for a closed day rewrites a level-2 pair.
- **Clock.** `closeAfterMs` and the step deadline use the Worker's clock.
