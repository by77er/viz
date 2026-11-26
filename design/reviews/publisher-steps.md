# Adversarial review: the publisher's work in steps (800b926, a4d3475)

Reviewer: did not build it; had only what the repository says of the author's reasoning.
Date: 2026-11-26. Read-only on the shared tree; everything below was run in a copy.

## Scope (the commit read)

- **Tree read:** `publisher/` as committed at `a4d3475` (the last commit that touches `publisher/src` or
  `publisher/test`; the shared tree was at `0e92418` while I worked and `git status` showed `publisher/`,
  `contracts/` and `ledger/` clean before and after). `sha256(src/publisher.ts)` = `89adcdec…f800`, the
  same in the tree and in my copy at the end (mutants restored).
- **What the two commits are.** `800b926` and `a4d3475` themselves change only `README.md`, `DESIGN.md`
  and four lines of `log.ts`; the code they describe landed in the "Work in progress" snapshot commits
  before each. So I reviewed the code as it stands at `a4d3475`, against `test/m6/` (verified equal to
  `800b926:publisher/src/*` but for the header comment and import paths) and against `origin/main`.
- **Files:** `src/publisher.ts` (all), `src/log.ts` (the re-base reader and `BaseSink`), `src/schema.ts`,
  `test/steps.test.ts`, `caps.test.ts`, `compat.test.ts`, `test/worker.ts`, `test/storage.ts`,
  `test/m6/`, `test/d64/`, `test/n1/`; `README.md`; `design/DECISIONS.md` D55 and D67 amendments;
  `janitor/src/janitor.ts` (`purgeTenant`, the delete gate's caller); `ledger/src/ledger.ts` (when a
  checkpoint is written and superseded).
- **Copy:** `/tmp/claude-0/-home-user-viz/3c79101e-93fd-5a8e-90a7-fca4d8b40aab/scratchpad/rv-pub/`
  (`publisher/`, `contracts/`, `ledger/`, `node_modules` symlinked). At most 2 test workers, one heavy
  job at a time. No Cloudflare call, no commit.
- **Baseline, measured here in the copy:** `npx vitest run` 17 files, **139/139 passed** (60 s);
  `npx tsc --noEmit` clean; `steps`+`caps`+`compat` alone 31/31. The cut-off test reported 95 cuts in
  my run (the commit message says 96).
- **Not re-run:** the external readers (PyIceberg, DuckDB: "504 + 1,542 + 1,542 checks"), the benches
  (every CPU figure below is the README's, not mine), `tools/mutants.mjs` (37 mutants). **Nothing here
  was measured on Cloudflare.**

Kinds of number used below: *measured here* (local workerd, my copy), *README, measured here* (the
author's bench figures, not re-run), *modelled* (said so, with the experiment that would settle it).

## Findings by severity

**0 blockers, 5 majors, 6 minors.**

### Blockers

None found. No interleaving I tried made a committed snapshot list a removed file, miss a live one,
reference a missing manifest, reuse a snapshot id or sequence number, or name an old incarnation (see
"What was attacked and held"). M-2 is the one way I found to commit a wrong snapshot; it needs an
operator action that cannot happen on a cell that already has a commit, so it does not block the
production upgrade.

### Major

**M-1. The commit of a re-base in steps is not "the only work of its publish": the same publish then
admits other re-bases up to the whole budget.** *Reproduced (RV-1).*

- **Where.** `src/publisher.ts:1374` (`if (budget.finishing !== tenant && budget.work > 0)`) looks only
  backwards: it keeps a commit out of a publish that has *already* done bounded work. Once
  `budget.finishing = tenant` is set (`:1380`) with `budget.work === 0`, the candidate loop goes on
  (`:1141`) and `admit` (`:1051`) admits further tenants exactly as in any publish, since the commit
  adds nothing to `budget.work`.
- **Claims it contradicts.** README `:273` ("The commit, in a publish of its own"), `:585` ("It is the
  only work of its publish"), `:1390` ("Each under half the 30 s default"), the tuning step (3) at the
  end of "Re-bases in steps"; `design/DECISIONS.md:2051` ("the commit, first in a publish of its own").
- **Scenario.** The production upgrade: every tenant needs a re-base, so candidates are always waiting.
  A large tenant finishes writing ahead; at the next publish it sorts first, is chosen to commit, and
  then up to 100 further tenants / 100,000 units are staged, written ahead and (those read whole)
  committed in the same invocation. The bench that set the budget has one tenant, so it never shows.
- **Reproduction.** `run.sh rv12 rv-body-1.ts`, test RV-1 (9 tenants, budget 20):
  `perRun(big phase/bounded work) … 7:writing/20 8:committed/20 9:-/20 …`,
  `"commitRun":8, … "othersSteppedInCommitPublish":[{"tenant":"s2","phase":"writing","staged":5,"written":12},{"tenant":"s3","phase":"staging","staged":3}],"otherWork":20`
  → `expected 20 to be +0`. The committing publish did a full budget of other tenants' work.
- **Size, modelled from the README's own unit costs** (not measured by me): commit of 300,000 added
  files 2.3–3.7 s here / 3–6 s on Cloudflare, plus a publish at the budget 3.3–5.4 s here / 9–13 s on
  Cloudflare → 12–19 s on Cloudflare in one invocation, where the text promises each under 15 s. A
  survivor confirms nothing tests the rule at all: with the `budget.work` gate disabled every suite
  passes (M-5, X7). The experiment that settles it is the one the README already names (the 300 MiB
  tenant on Cloudflare), run with other tenants waiting.
- **Change asked for.** Either stop admitting once a commit is chosen (and test it), or count the
  commit's added files against the budget, or restate the bound as "commit + budget" and measure that.

**M-2. `locationPrefix` can still be changed while manifests are written ahead; the commit then lists
data files under the old prefix in a table whose location is the new one, and the publisher can never
rebuild that table from R2.** *Reproduced (RV-11).*

- **Where.** `configure` refuses a new prefix only "once a table has been committed"
  (`src/publisher.ts:641–646`). Manifests written ahead carry absolute URIs built with the prefix of the
  publish that wrote them (`:1436–1439`). `aheadIntact` (`:1465–1479`) checks size and count, not what
  they say. Before this change one publish read its config once, so the window did not exist; now it
  lasts from the first manifest written ahead to the commit (publishes, or longer across a rollback).
- **Scenario.** A new cell (nothing committed). The first tenant is larger than the budget, or crosses
  it. During its first publication the operator corrects the prefix, which the guard exists to allow.
- **Reproduction.** `run.sh rv1011 rv-body-5.ts`, test RV-11: `configureError: null`;
  `metric_samples: location s3://other-lake/…, entriesUnderOldPrefix 7 of 7`; `metric_series: 3 of 7`;
  then `verify('metric_samples')` and a rebuild by a second object on the cell both throw
  `publisher: s3://viz-lake/…parquet is not under the configured location s3://other-lake`. After a
  conflict or a lost storage that table cannot be resynced, and the rebuild-first rule then reads no
  tenant: the cell stops publishing.
- **Reach.** Not the production upgrade (its tables have commits, so the guard holds). Any new cell.
  `ICEBERG_LOCATION_PREFIX` changed by a deploy takes the same path when no prefix is stored (by
  reading; not reproduced).
- **Change asked for.** Refuse the change while `rebase_manifest` has rows (or record the prefix with
  the step and drop the manifests when it differs), with a test.

**M-3. A commit cut off after its metadata write never records the tombstones its re-base staged: those
removed files are never released (a leak), in steps and whole alike.** *Reproduced (RV-9), both paths.*

- **Where.** `recordStagedTombstones` runs only inside the SQLite transaction after the commit point
  (`src/publisher.ts:2147`, and `:1841` on the no-change path). If the invocation ends between the
  metadata PUT (`:2102`) and that transaction, the next publish finds R2 ahead and `resync`s (`:2227`):
  the cursor is now there, so `stillApplies` (`:1004–1026`) lets the table leave the step "committed by
  this re-base's own commit" and nothing ever records the tombstones, though the stage that holds them
  is still in SQLite at that moment.
- **Why it matters more now.** The heavy part of a commit in steps is that transaction (the `live`
  rows of every added file), and it comes *after* the metadata write: a CPU cut during the commit of a
  large tenant lands in exactly this window. The cut-off test (`steps.test.ts`, 95 cuts, 15 in the
  commit) compares reader views and `verify`, never `removed` or `safeToDelete`, so it cannot see this.
- **Reproduction.** `run.sh rv9 rv-body-4.ts`: three cells, same log, same clock (three days, a unit, a
  publish and maintenance each). Twin (whole, no cut): `safeToDelete` returns the 2 expired `logs` files
  the checkpoint carried as tombstones. In steps with `failAt('metadata-written','logs')`: **0**. Whole
  with the same cut: **0** (so the mechanism predates these commits; they inherit and widen it).
  `neverReleasedBySteps: [logs/…/L0-pool_logs_0-7001-3-3-…, …-6-6-…]`.
- **Consequence.** The janitor deletes a key only when the publisher releases it
  (`janitor/src/janitor.ts`, `purgeTenant`): these objects stay in R2 for good, past their retention.
  Held-back keys stay at the head of the ledger's answer and the purge reads at most 10,000: enough
  never-released keys stall that tenant's deletions altogether (by reading; not reproduced). The same
  window also loses `transient` keys of an ordinary publish (by reading; not reproduced).
- **Not stated.** "Not implemented" lists removed files across a *state loss* (`README.md:610`), not
  across a cut-off commit.
- **Change asked for.** Record a table's staged tombstones when it leaves a step because its own commit
  moved the cursor (the stage is still there), or say it under "Not implemented" with the janitor's
  consequence; add `removed`/`safeToDelete` to what the cut-off test compares with its twin.

**M-4. The frozen-release tests do not model the release in production.** *The missing cases, run here,
held (RV-3); the gap is in the repository's evidence and text.*

- **Where.** README `:20` and `:313` call `test/m6/` (`800b926`) "the release before this one" and D64
  "the floor"; `steps.test.ts:459` tests rollback to m6 only; `upgraded()` starts from D64's storage.
  Neither was ever released: `origin/main` at PR #8 (`fb77292`) has `publisher/src/schema.ts` at
  **storage version 3**, and its `publisher.ts`, `log.ts`, `schema.ts` equal `test/n1/` (frozen at
  `9292abb`) but for 10, 8 and 4 lines (the frozen-file header, import paths, one type cast, one defensive `typeof`). `test/n1/`
  is used once, for metric byte-identity (`signals.test.ts:310`).
- **So in production** the deploy migrates 3 → 7 in one step (migrations 4–7 together), and a rollback
  lands on n1, not m6; with `INGEST_SIGNALS` off no rollback floor applies. The stepped path does run
  there at once: the tenant that crosses the budget in each capped publish goes on in steps (by
  reading, `afterRead`, `:1250`).
- **What I ran** (`run.sh rv3 rv-body-2.ts`, metric-only logs as production has; 3/3 passed):
  A. n1 publishes (storage 3) → this release installed (3 → 7) → capped re-base stopped mid-staging →
  rollback to n1 on version-7 storage (it publishes new units of both tenants, expires, sweeps; kept
  rows untouched) → rolled forward → equal to an uncapped twin, `verify` clean, nothing kept.
  B. A new ledger incarnation re-based in steps with manifests written ahead in the *metric* tables →
  rollback to n1, which (i) sweeps them, or (ii) re-bases the tenant whole itself → rolled forward →
  equal to the twin; current snapshot names incarnation 2.
- **Change asked for.** Put these three tests in the suite; name the production release in the README
  and D67 as the upgrade source and rollback target; say that m6 was never deployed.

**M-5. Four mutants of the new protocol survive the whole suite (139/139 pass with each).** *Reproduced;
applied in my copy only, source restored and hash checked.* AGENTS.md: "A mutant that survives is
reported." The README reports 37/37; none of these is on its list (P1–P7).

| # | Mutation (`src/publisher.ts`) | Result | What it means |
|---|---|---|---|
| X2 | `aheadIntact` (`:1470`) no longer compares the manifests' added files with what the stage adds now (HEAD only) | **survived** | One of "the checks before reusing what was kept" has no test |
| X5 | `catchUp` (`:1289`) stages no tombstone for a key removed after the re-base's start | **survived** | README: such a key "becomes a tombstone, released by the snapshot rule": untested; the mutant leaks it |
| X7 | the `budget.work` gate before a commit (`:1374`) disabled | **survived** | The "publish of its own" rule is untested (and see M-1) |
| X11 | `resumeKey` (`:1538`) always null: a kept staging is never continued when a newer checkpoint exists | **survived** | The defence against "the ledger checkpoints faster than the re-base" is untested |
| X1 | `stillApplies` never notices a moved cursor | killed (2) | cut-off test; m6 "re-bases the tenant whole itself" |
| X14 | a kept staging that stopped on its checkpoint is not dropped | killed (6+) | `checkpoints.test.ts` |

Command: `python3 mutate.py X1 X2 X5 X11 X14 X7` (four suites), then `python3 mutate-full.py X2 X5 X11 X7`
(all 17 files); output in `mutants-full.out`. Each script writes the mutant into the copy's
`src/publisher.ts`, runs, restores the file and prints its hash.

### Minor

**m-1. "Its metric tables keep being committed in every publish" is not true of the tenant whose re-base
is in steps.** *Reproduced (RV-2).* README `:207–213` and `:1346` ("every tenant's metric tables keep
being published") against Risks `:1596` ("Its other tables wait for it"), which is what the code does
(`:1133–1147`: an admitted candidate is never read from its cursors). RV-2, the D67 upgrade: a metric
change already in R2 stayed unpublished for the stepped tenant for 10 of 14 publishes (until its
commit); the waiting tenant's was published in the first. By reading, not reproduced: if the re-base is
refused in `catchUp` (`inconsistent`, all tables or none) that wait has no end, where a whole re-base
refuses per table. Make the two passages agree.

**m-2. Rows of an overtaken rebuild are left behind.** *Reproduced (RV-10).* The clean-up
(`src/publisher.ts:1100–1106`) runs only in a publish that reads a tenant without a cursor. After m6
rebuilt the tables during a rollback, the rolled-forward release kept
`rebuild {metric_series: version 1, done 1 of 6}` and its `rebuild_manifest` rows. README `:313–316`
says such rows are continued or dropped. I found no path that reads them wrongly (they are used only
when the table has no `tbl` row and R2 is still at that version). The tables themselves held: m6 over
the partial rows ended equal to a reference m6 rebuild, and `verify` was clean after rolling forward.

**m-3. The cut-off test covers one start.** `steps.test.ts` cuts only the D67 upgrade: adds only, no
removals, no rewritten manifests, three tables in the step. I ran its loop unchanged on a new ledger
incarnation (removals, all five tables) and on a new tenant: **181 and 157 cuts, both end as the twin**
(RV-12). Worth keeping in the suite. It asserts `cuts > 30`; the commit message's "96" is a log line
(95 in my run).

**m-4. Manifests written ahead for a table that never gets a commit are never swept** once their
re-base is dropped: `sweepTable` returns at version 0 (`src/publisher.ts:2504`). *Not reproduced; by
reading.* A few orphan objects; on a rollback to D64 they also satisfy its "an object exists under the
table" guard, so it would release none of that table's removed files.

**m-5. A staging kept for a tenant whose log is gone is never dropped.** `no_log` is not among the
stops that drop it (`:1246`), the tenant counts as done and leaves `pending`, and the incarnation check
that would drop it runs only past staging. *Not reproduced; by reading.* Nothing deletes a tenant's log
today; the cost would be its `rebase_stage` rows kept for good.

**m-6. `publisher/mutants.out` is an old run** (M1–M15 only), beside a README that reports 37. Replace
it or remove it.

## Verdict

**Approve with changes.**

The stepped protocol's published output held under everything I threw at it (below), and the release
actually in production opens, ignores and survives the new storage in both directions. What is wrong
is around it: a budget rule the text states and the code does not keep (M-1), a guard that did not
follow the protocol's longer window (M-2), release bookkeeping lost at the one place a large commit is
likeliest to be cut (M-3), and evidence that names releases production never ran and leaves four
mutants alive (M-4, M-5).

Before this runs over production storage:

1. M-4: the three n1 tests in the suite, and the text corrected (they pass today; this is cheap).
2. M-1: stop admitting after a commit is chosen, or restate and measure the bound.
3. M-5: tests that kill X2, X5, X7, X11.
4. M-3: fix, or record under "Not implemented" with the janitor's consequence.
5. M-2: before any *new* cell is brought up on this release.

Still open by the author's own account and unchanged by this review: nothing measured on Cloudflare;
a base staged in one step; the commit and a `resync` after a conflict each one invocation; one
unexplained test timeout (I did not see it in 1 full run, 4 full runs under mutation and 7 runs of the
steps suite alone, 6 of them under mutation).

## What was attacked and held

Reproduced in the copy unless marked "by reading".

- **Published correctness, twin-compared** (reader view of every table, `verify`, each tenant's files
  against its ledger, every ADDED entry's snapshot id against its manifest-list row):
  - cut off at every R2 operation of every step, on three starts (95, 181, 157 cuts; RV-12 and the
    suite's own): nothing committed lost, kept progress never backwards, ends as the twin;
  - another writer on the cell committing while manifests are written ahead, for another tenant and
    for the same tenant whole (RV-6): 5 conflicts absorbed each time; each snapshot id has one
    sequence number, sequence numbers unique per table, no duplicate, ends as the twin; in the second
    case the step is dropped and commits nothing;
  - the ledger checkpointing again mid-staging (RV-5): kept checkpoint deleted → starts over from the
    newer one; parts gone under a listed manifest → `incomplete`, step dropped, then the newer one;
  - a new incarnation mid-staging and mid-writing (the suite's tests; X1 and P3 kill the checks).
- **Snapshot id and sequence number reuse** (by reading, and RV-6): a commit whose metadata landed and
  whose SQLite did not is found by the HEAD of the next version on both commit paths, resynced, and the
  table leaves the step before its id could be used again; `aheadIntact` runs again on every attempt.
- **Manifests written ahead and the sweeps:** this release's sweep keeps them (suite); m6's and n1's
  delete them after the grace and the commit then finds them missing and writes them again (suite,
  RV-3 B); once committed they are in `snap.files`, also on the resync path (by reading).
- **The delete gate mid-re-base** (RV-8): asked after every one of 16 publishes of a new-incarnation
  re-base with the clock moved past the grace each time: never a key that a retained snapshot
  references or the ledger lists; at the end it releases exactly what the uncapped twin releases, all
  6 published-then-removed files included.
- **Release skew:** production's n1 on version-7 storage mid-staging and mid-writing, both directions
  (RV-3); m6 mid-re-base both ways (suite); m6 over a half-done rebuild (RV-10, tables equal to a
  reference rebuild). Migrations 6 and 7 are additive in fact: n1, D64 and m6 never touch the new tables
  (kept rows byte-equal before and after each rollback).
- **Progress.** A commit that keeps failing or manifests that keep being rewritten fall behind tenants
  not yet tried (`rank`), and only one publish in two (by reading). The ledger cannot checkpoint faster
  than a large staging in practice: a checkpoint needs 256 segments *and* as many log bytes as the last
  checkpoint (`ledger.ts:1316`); that is the ledger's rule, not a bound in the publisher, and the
  publisher's own defence is untested (X11).
- **The alarm:** a lease `retryMs` ahead before publishing, `continueMs` after a capped publish; a
  stepped tenant always stays in `pending` (every non-`ok` status re-inserts it); none left clears the
  deadline (by reading; the suite's alarm-driven tests end with nothing pending).
- **Durable Object rules:** nothing in memory across invocations but the single-flight queue (the
  budget lives one publish; cuts reset the object); `blockConcurrencyWhile` only around `openSchema`;
  each step re-reads its row; the statements without a tenant (`scratch`, the sweep's
  `rebase_manifest` read, `STAGED_ADD`'s look-up in `live`) are cell-level by design and the README
  says so; a key of another tenant cannot reach `live` because the ledger admits only keys under its
  own tenant's prefix (`ledger.ts:408`).
- **Budget accounting:** admissions stop at the cap; overshoot is one part or one manifest
  (`manifestTargetEntries`); two re-bases cannot both be chosen to commit (the only concurrent callers
  always have `budget.work > 0`) (by reading).

Not attacked: the D64 → D67 hand-over of span and log deletions (D67's review); the Avro and Iceberg
encoders; the readers; anything on Cloudflare.

## Reproduction index

All under `/tmp/claude-0/-home-user-viz/3c79101e-93fd-5a8e-90a7-fca4d8b40aab/scratchpad/rv-pub/`.
`run.sh <name> <body>` prepends the helpers of `test/steps.test.ts` (its first 270 lines) to the body,
runs `npx vitest run test/<name>.test.ts` (2 workers) and writes `<name>.out`. Assembled tests are kept
in `rvtests/`. A test that "fails" below asserts the README's claim.

| Id | Command | Result (measured here) |
|---|---|---|
| baseline | `cd publisher && npx vitest run && npx tsc --noEmit` | 139/139; clean (`full.out`, `tsc.out`) |
| RV-1 (M-1) | `./run.sh rv12 rv-body-1.ts` | fails: other tenants' work in the commit publish 20 of budget 20 |
| RV-2 (m-1) | same file | fails: stepped tenant's metric cursor stale in 10 of 14 publishes; waiting tenant's in 0 |
| RV-3 A, B×2 (M-4) | `./run.sh rv3 rv-body-2.ts` | 3/3 pass: production's release, both directions |
| RV-5 ×2 | `./run.sh rv568 rv-body-3.ts` | pass: step versions `[27]` and `[20, 27]`, ends as twin |
| RV-6 ×2 | same file | pass: 5 conflicts; 1 commit / 0 commits by the step |
| RV-8 | same file | pass: 16 asks, most released midway 2, final 8 = twin's 8 |
| RV-9 (M-3) | `./run.sh rv9 rv-body-4.ts` | fails: twin releases 2, steps+cut 0, whole+cut 0 |
| RV-10 (m-2) | `./run.sh rv1011 rv-body-5.ts` | fails on left-over `rebuild` rows only; tables and `verify` hold |
| RV-11 (M-2) | same file | fails: 10 entries under the old prefix; `verify` and a rebuild throw |
| RV-12 ×2 (m-3) | `./run.sh rv12cut rv-body-6.ts` | pass: 181 and 157 cuts |
| mutants (M-5) | `python3 mutate.py X1 X2 X5 X11 X14 X7`; `python3 mutate-full.py X2 X5 X11 X7` | X1, X14 killed; X2, X5, X7, X11 survive 139/139 |
| cut count | `npx vitest run test/steps.test.ts -t "cut off at every R2 operation" --silent=false` | `CUTS {"runs":97,"cuts":95,…}` |

Not reproduced, by reading only: M-2 through the environment variable; M-3's janitor stall and
`transient` keys; m-1's endless wait when refused; m-4; m-5.

## One-row summary for design/REVIEW.md

| Review | Scope | Findings | Disposition |
|---|---|---|---|
| `publisher/` re-bases and rebuilds in steps (800b926, a4d3475; code at a4d3475), adversarial, 2026-11-26 | The marker and stage, the write ahead under a reserved snapshot id, the commit in a publish of its own, the checks that drop kept state, the rebuild in steps, the caps, storage migrations 6 and 7 and release skew | 0 blockers, 5 majors (M-1 the commit shares its publish with a full budget of other re-bases; M-2 `locationPrefix` changeable while manifests are written ahead; M-3 a commit cut after its metadata write never releases the stage's tombstones, whole path too; M-4 frozen-release tests model m6 and D64, production runs storage 3 (= `test/n1/`): the missing cases held when run; M-5 four mutants survive), 6 minors. Verdict: approve with changes | Open. Held: 433 cut-offs on three starts, a second writer, a newer checkpoint and incarnation mid-way, the delete gate at every step, production's release both directions. Not measured on Cloudflare |
