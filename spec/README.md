# spec — a formal model of the viz write/read protocol

Two independent models of client → shard stream → flush → ledger (+ R2 change log) → query
seam, with compaction, retention, physical deletion, the orphan sweeper, shard storage loss
and ledger storage loss + rebuild, checked exhaustively within small bounds. Their purpose is
to find design and implementation bugs before more code is written on top of them.

| File | Contents |
|---|---|
| `viz.qnt` | Quint model (design level). Every protocol guard is a field of the constant `G`. |
| `viz_test.qnt` | Quint scenario tests (`quint test`): four replayed interleavings. |
| `experiments.mjs` | Generates one Quint instance per experiment, runs TLC / the Quint simulator, writes `results/*.json` and `results/RESULTS.md`. |
| `bfs/model.ts` | Second model, written independently, at the granularity of the implementation's methods (`shard.ts`, `ledger.ts`, `flush.ts`, `compact.ts`, `janitor.ts`, `query/coordinator.ts`), including the PLANNED segment log of `contracts/LEDGER-LOG.md` and two tenants. |
| `bfs/check.ts` | Explicit-state breadth-first model checker for it (TypeScript, no dependencies); also checks liveness as AG EF on the whole state graph. |
| `bfs/run.ts` | Its experiments; writes `results/bfs/*.json` and `results/BFS.md`. |
| `fill-readme.mjs` | Regenerates every result table in this README from `results/` (`--write`). |
| `results/RESULTS.md`, `results/BFS.md` | Every experiment with states, depth, time and every counterexample step by step. |

```
npm install
npm run check          # everything: typecheck, Quint tests, explicit-state checker, TLC, simulation; then the tables here
npm run check:quick    # typecheck, Quint tests, explicit-state guard-off + findings, TLC guard-off + design-as-written (~30 min)
npm run check:bfs      # explicit-state checker only;   node bfs/run.ts <name|teeth|finding|amended|liveness> ...
npm run check:tlc      # TLC only;                      node experiments.mjs <name|teeth|literal|witness|fixed> ...
npm run test:quint     # the Quint scenario tests
```

Requirements: Node 22 (it runs `bfs/*.ts` directly) and Java 17. The first `quint verify`
downloads Apalache 0.62.4 (which bundles TLC) into `~/.quint`; that needs network access once.
Every run is capped for a shared machine: the explicit-state checker keeps its frontier on
disk (`build/`), runs under `--max-old-space-size=1024` and stops at 19 million states
(it says so in its result; none of the runs below hit that bound); TLC gets `-Xmx900m` and a
400 MB off-heap fingerprint set, and two workers. Run TLC and the explicit-state checker one
after the other, not together.

## Which protocol is checked

- **The ledger's change log.** Both models check the PLANNED log of `contracts/LEDGER-LOG.md`:
  a mutation answers after its SQLite commit, changes reach R2 later, and shards discard only
  up to the LOGGED watermark. `viz.qnt` abstracts the log as an outbox written to R2 a prefix
  at a time. `bfs/model.ts` models it literally: a drain PUTs one segment holding every pending
  change, then deletes those outbox rows and advances `logged` in one transaction, and can die
  between the two; the rebuild lists the segments in key order and replays them. The as-built
  log (one object per change, `ledger.ts` `drainNow`) is the `log: 'perChange'` setting of
  `bfs/model.ts` and is used for the "as built" runs. Both are checked; the README says which
  for every run.
- **Design text vs. code.** "As written" runs take `design/DESIGN.md` (draft 3.1) and
  `contracts/LEDGER-LOG.md` literally. "As built" runs (explicit-state checker only) follow
  the code read on 2026-11-18: lazy stream registration by `flush.ts`, the coordinator asking
  every pool shard, `tailRead`'s answer for an unknown stream, `readSegment(tenant, seqLo)`,
  `compact.ts` keys and conflict handling, `janitor.ts` purge and orphan sweep. "Amended" runs
  add the fixes proposed under Findings.

## Tools, and what kind of evidence each result is

| Result | Tool | Kind |
|---|---|---|
| Guard-off, design-as-written, witnesses, amended runs of `viz.qnt` | Quint 0.33.1 → TLC 2 (bundled in Apalache 0.62.4) via `quint verify --backend tlc` | **Exhaustive** explicit-state search within the stated bounds (64-bit state fingerprints; TLC's collision estimate is in the table). One worker = strict BFS, so those counterexamples are shortest. |
| Every row of the `bfs/` tables | `bfs/check.ts`, written for this task | **Exhaustive** breadth-first search within the stated bounds; 64-bit fingerprints (collision probability in each row, at most 1e-5); every counterexample is a shortest one. Liveness is AG EF on the complete graph. |
| `sim_*` rows | Quint random simulator (`quint run`, TypeScript backend) | **Simulation, not exhaustive.** Larger bounds, sampled. |
| `viz_test.qnt` | `quint test` (TypeScript backend) | Deterministic scenario tests. |

Apalache's symbolic mode (`quint verify` without `--backend tlc`) was not used: Java and the
Apalache jar are present, but TLC already gives exhaustive results and shortest traces for
models of this shape, and the second, independent checker is a better cross-check than a
second engine on the same model. The Quint Rust backend could not be downloaded in this
sandbox (GitHub release fetch is forbidden), so `quint run` / `quint test` use the TypeScript
backend.

The two models were written independently (the explicit-state one without reusing
`viz.qnt`'s code) and at different granularity: `viz.qnt` makes a flush one read + one PUT +
one `addUnit`; `bfs/model.ts` adds `pendingSegments`, the incarnation-mismatch / register /
retry path of `flush.ts`, the two-step drain, the registration handshake and two tenants.
Where they overlap they agree: every guard-off experiment fails in both, with traces that
differ only by those extra steps, and the amended protocol passes in both.

## What is modelled

| Component | Actions (explicit-state model; `viz.qnt` equivalent in brackets) | Source |
|---|---|---|
| Client | `append(b)`: send or re-send any batch, also after a success (the acknowledgement may have been lost); first sends in batch order (symmetry). | DESIGN §4.2 |
| Shard stream `(shard, tenant, incarnation)` | `append` (durable, dedup on fingerprint), `seal`, `recorded(inc, through)` (only at a segment boundary, only with the ledger's `loggedWatermarks()`), `discard` (alarm step 2: moves the fence), `fingerprintsExpire` (alarm step 3, nondeterministic), `SHARD STORAGE LOSS` (every stream of the shard; a new incarnation on next use), registration handshake `registerStream` → `registration logged` → accepts writes, `reRegister` (fix F1). | `shard/src/shard.ts` `append`, `sealStream`, `recorded`, `alarm`, `stream`, `tailRead` |
| Flush Worker (≤ 2 at once, any number of attempts) | `pendingSegments` → `readSegment` + encode (1 or 2 encoder outputs) → `PUT` (content-addressed, If-None-Match; or deterministic key, or overwrite) → `addUnit` → on `incarnation_mismatch` with an older ledger incarnation: `registerStream` → `addUnit` once more; a crash between any two steps. Two Workers can hold the same segment. | `flush/src/flush.ts` `flushTenant`, `writeSegment`, `report` |
| Ledger (one per tenant) | `registerStream`, `addUnit` (contiguous, atomic, idempotent replay, unknown stream admitted only at `seqLo = 1`), `replace` (inputs-live check, replay rule), `expire` (whole file), versions, tombstones, `loggedWatermarks`, `deletable`, `orphanCheck`, the change log (drain PUT, drain commit, drain crash between them), `LEDGER STORAGE LOSS` → rebuild from R2 into a new ledger incarnation. | `contracts/ledger.ts`, `contracts/LEDGER-LOG.md`, `ledger/src/ledger.ts` |
| Compaction (≤ 1 or 2 steps at once) | read two live inputs → PUT the output → `replace`; on `conflict` delete the output unless it is live (as built); crash at any point. | `compact/src/compact.ts` `compactStep` |
| Physical deletion | `purge`: `deletable` (removal logged, grace passed = no query in flight holds a plan naming it, not live) → R2 delete → `forget`. `orphan sweep` under one of four rules (below). | `janitor/src/janitor.ts`, DESIGN §4.3, §5.2 |
| Query (one at a time) | `plan` (files + watermarks at one ledger version), then one `tailRead` per shard as separate later steps in any order, then read the planned files and merge. `stale_watermark`, `incarnation_mismatch` and a missing planned file restart from a fresh plan. As built, the coordinator also asks every pool shard the ledger has not registered, from sequence 0, and remembers incarnations it has learned across re-plans. | DESIGN §2.3, §6.1, §6.2; `query/src/coordinator.ts` `gather`, `readTail` |

Shard and ledger crash/restart need no action of their own: both models' state is exactly the
durable state (`shard.ts` and `ledger.ts` rebuild everything else from SQLite), every
multi-step interaction is a sequence of separate steps, and any of them can be abandoned.

### Properties (numbers from `design/VERIFICATION.md` §2)

| Property | Statement | In |
|---|---|---|
| `I1_AckedIsDurable` (I1, I2) | Every acknowledged batch is in a shard payload (`seq > discarded_through`) or in a live ledger file whose object exists with the bytes the ledger describes. Exempt: batches retention removed, and batches a shard storage loss destroyed above the ledger's *logged* watermark (the loss DESIGN §4.3 declares). | both |
| `I3_NoDuplicates` (I3) | A completed query returns no batch more than once (the raw merge, i.e. logs and spans; for metrics the `(series, ts)` de-duplication masks it). | both |
| `I4_NoGapAtSeam` (I2, I4) | A completed query returns every batch acknowledged before its (last) plan, with the exemptions of I1. | both |
| `I5_DiscardOnlyLogged` (I5) | `discarded ≤ recorded ≤` the stream's watermark that survives a ledger rebuild (what R2 holds) `≤` the committed watermark. Checked in every state, so it also says *a rebuild never leaves a watermark below a discard mark*. | both |
| `I9_NoResurrection` (I9) | No row retention removed is in a live file again (compaction never resurrects). | both |
| `I11_LiveFilesReadable` (I11) | Every file the ledger lists exists and holds the bytes its metadata describes. | both |
| `I20_TenantIsolation` (I20) | A query of one tenant returns only that tenant's rows. | `bfs` |
| `LOG_SegmentsDisjoint` | LEDGER-LOG.md: "segments of one incarnation never overlap and never leave a gap". | `bfs` |
| `AV_RebuildSucceeds` | A rebuild from R2 never refuses (otherwise the tenant's ledger serves nothing, for ever). | `bfs` |
| `V_IncarnationNotReused` | DESIGN §4.3: "a rebuilt ledger starts a new ledger incarnation, so versions are never reused". | `bfs` |
| `LIVE_QueryCanComplete` | **Liveness.** AG EF (query done) on the complete state graph, with refusals unbounded: from every reachable state the query can still complete. In a finite graph this plus strong fairness implies every query completes; a violation is a state from which no schedule completes it (refusals for ever). | `bfs` |
| `L1_StreamRegistered`, `L2_NoRestart`, `L2_NoRefusal` | Liveness proxies (safety properties): the ledger knows every stream that accepts writes; no query attempt is refused. | as named |

### Abstracted away

- **Shard-map epoch change is not modelled** (keys moving between shards, draining streams,
  fingerprint hand-over). Routing is fixed. The state space of the explicit-state model is
  already 10⁶–10⁷ states at 2 batches; an epoch change needs at least two shards, a key
  moving, and a hand-over protocol, which did not fit. DESIGN §4.1's claims are unchecked, and
  `shard.ts` implements only "refuse a lower epoch".
- **File precedence** (`contracts/ledger.ts` `LiveFile.precedence`, the `blocking` conflict
  of `replace`, added to the contract and to `ledger.ts` while this work ran) is not modelled:
  rows are whole batches with unique identities, so "latest write wins" has nothing to decide.
  A `blocking` conflict only makes `replace` refuse more often, which the model's compaction
  conflict path covers.
- Rows are whole batches; one table, one partition, no index fragments, no publisher or
  Iceberg, no rollups, no hour closure, no quotas / back-pressure (I7), no group commit.
- **Time.** No clocks. Grace periods and TTLs are either nondeterministic ("may happen any time
  after it becomes legal") or an explicit assumption: `delGrace` (no query holds a plan naming
  the file), `fpHorizon`, `retain`, and the sweeper's age rule (the object's uploader is no
  longer in flight).
- Retention removes one whole file; compaction merges two live files; a drain writes every
  pending change in one segment (the 4 MiB split is not modelled).
- At most one query in flight; one tenant except where a row says two. In the two-tenant runs
  both tenants share one pooled shard.
- `recorded` is one step that reads the ledger's logged watermark and tells the shard. A late
  delivery carries an older value, which `recorded` ignores.

## Step 1 — the model has teeth

Baseline: the amended protocol, which passes (Step 2). Each row switches **one** rule off.
Bounds unless the row says otherwise: 1 tenant, 1 shard, 2 batches, ≤ 2 sends each, ≤ 2 flush
Workers at once, no faults or maintenance except what the row names.

**Explicit-state checker** (`bfs/`; abbreviations: `list` = `pendingSegments`, `drainPUT` /
`drainCommit` = the two drain steps, `regLogged` = the registration is in R2, `∅` = nothing):

<!-- BEGIN BFS_TEETH -->
<!-- END BFS_TEETH -->

(a)–(h), the guards the task names, each produce a counterexample in both checkers. One
further guard does **not**: (o), a flush read not bound to the incarnation. With the
amended registration rule a stale unit is refused as `incarnation_mismatch`, so in the amended
protocol that rule is redundant (11 million states, no counterexample). It does bite in the code
as built, where registration is lazy: finding F12.

**TLC on `viz.qnt`** (same baseline and bounds in that model's terms):

<!-- BEGIN TLC_TEETH -->
<!-- END TLC_TEETH -->

## Step 2 — the faithful model, run as hard as the tooling allows

### 2a. The design as written, and the code as built: "peeling"

Each run below checks every safety property with every action (1 compaction, 1 retention
removal, 1 ledger storage loss, 1 shard storage loss, client retries, two flush Workers, one
query). Breadth-first search stops at the shortest violation; the next run adds the fix for
that finding and searches again, until a run passes. Findings found that way are then isolated
one at a time against the amended protocol (the `F…` rows).

<!-- BEGIN BFS_FINDINGS -->
<!-- END BFS_FINDINGS -->

The same idea in `viz.qnt` (DESIGN as written, `literal_*`; TLC):

<!-- BEGIN TLC_LITERAL -->
<!-- END TLC_LITERAL -->

### 2b. The amended protocol, exhaustive

`AMENDED` (`bfs/run.ts`) = DESIGN + LEDGER-LOG as written + the fixes for F1 (registration
logged before writes, repeated when the ledger does not know the stream), F2 (sweeper as in
`janitor.ts`: not live, not tombstoned, below the logged watermark) with F15's correction (a
newer incarnation counts once its registration is logged), F6 (refuse an unknown stream named
by incarnation), F10 (a retried drain writes the same segment), F11 (base in R2 first),
F12 (flush reads bound to the incarnation), F13/F14 (step-unique compaction keys), and the
assumption that removes F3 (no client retry across a shard storage loss; *assumed*, not
fixed).

<!-- BEGIN BFS_AMENDED -->
<!-- END BFS_AMENDED -->

`viz.qnt`, amended protocol (`FIXED` in `experiments.mjs`), TLC. Common bounds: 1 shard,
2 batches, ≤ 2 sends per batch, ≤ 2 flush Workers in flight and ≤ 3 flush attempts in total,
≤ 1 compaction, ≤ 1 retention removal, ≤ 1 ledger storage loss, ≤ 1 shard storage loss,
1 query with ≤ 2 refusals, 1 encoder variant:

<!-- BEGIN TLC_FIXED -->
<!-- END TLC_FIXED -->

Not vacuous: in the amended `viz.qnt` each of these is reachable (TLC, shortest path):

<!-- BEGIN TLC_WITNESS -->
<!-- END TLC_WITNESS -->

Larger bounds, by random simulation only (not exhaustive):

<!-- BEGIN TLC_SIM -->
<!-- END TLC_SIM -->

Total: <!-- BEGIN TOTAL -->
<!-- END TOTAL -->

## Findings

Ordered by severity. "Trace" is the shortest counterexample the explicit-state checker found
(step by step in `results/BFS.md`; the `viz.qnt`/TLC trace, where there is one, in
`results/RESULTS.md`). Findings against the design quote the sentence; findings against the
code name the file. F1–F9 were found by the earlier pass on `viz.qnt` and are re-confirmed by
the second checker (F4, F5, F7 by TLC only); F10–F15 are new.

### F1 (critical, design) — Stream registration is not covered by "committed and logged"

- **Text.** §4.3: "A shard that loses its storage registers a new incarnation with the ledger
  before it accepts writes" and "[The ledger] tells a shard to discard only what has been both
  committed and logged". The second rule is stated for discard only.
- **Trace** (`F1_registration_rolled_back`, 5 steps; TLC `F1_registration_not_logged`, 5):
  `registerStream` commits, its change still in the outbox → the shard accepts and acknowledges
  batch 0 → the ledger loses its storage; the rebuild from R2 has no trace of the stream → the
  plan has no watermark for that shard, so the query never asks it → it completes without
  batch 0 (I4).
- **Impact.** Silent: every acknowledged row of that stream is invisible to every query. After
  a *shard* loss the same rollback leaves the ledger naming the old incarnation and nothing in
  the design repeats the registration: `LIVE_design` reaches a state from which no schedule
  completes a query.
- **As built** the gap does not occur for a fixed shard map: `flush.ts` registers lazily and
  the coordinator asks every pool shard the ledger does not know, from sequence 0 (`LIVE_impl`
  holds). A map change, which moves keys to shards outside the plan, would bring it back.
- **Fix.** A stream (first use or new incarnation) accepts writes only once its registration
  is **in the logged prefix** of the change log, and repeats the idempotent registration
  whenever `addUnit` / `loggedWatermarks` shows the ledger does not know its incarnation.
  Modelled as `reg: 'logged'` + `reRegister`; passes.

### F2 (critical, design) — The orphan-sweeper sentence deletes files the ledger removed, before the removal is logged and without the grace period

- **Text.** §4.3: "The orphan sweeper deletes only files that are unreferenced *and* belong to
  a sequence range below the stream's logged watermark." Every flush file that compaction or
  retention has taken out of the ledger satisfies it.
- **Trace** (`F2_sweeper_spec_I1`, 25 steps; TLC `F2_sweeper_unlogged_removal_I1`, 20): two
  units admitted, logged, recorded, discarded → `replace` commits (inputs out, output in), not
  yet logged → the sweeper deletes both inputs → the ledger loses its storage; the rebuild lists
  the inputs again, their objects are gone and the shard has discarded the rows (I1, I11).
  `F2_sweeper_spec_grace` (25 steps): the sweeper deletes a removed input under a query that
  planned before the removal (I4 if a missing file reads as empty, a refusal otherwise).
- **As built** `janitor.ts` implements the fix (skips tombstoned keys; `orphanCheck` reads live,
  tombstoned and logged in one instant), except for F15. DESIGN §4.3 was not updated.
- **Fix (text).** *The sweeper deletes an object only if its key is neither live nor tombstoned
  and (for a flush file) its range is at or below the logged watermark; a removed file is
  deleted only by the retirement path of §5.2/§5.3; a newer incarnation makes an older one's
  files dead only once its registration is logged (F15).* Compaction outputs: F13, F14.

### F14 (critical, code: `compact/src/compact.ts`) — A compaction step deletes its output on `conflict`; a ledger rebuild then lets an identical step list it with no object

- **Code.** `compactStep` on `conflict`: "an input is gone for good, so these outputs can never
  be listed by THIS step. Delete them, unless the ledger … knows them" (live or tombstoned).
  Output keys are a hash of the input keys and of the bytes, so two steps with the same inputs
  write the same object, and steps "can run … twice at once".
- **Trace** (`F14_impl_comp_conflict_delete`, 25 steps): units for batches 0 and 1 admitted and
  logged → two compaction steps read the same two inputs → retention expires input 1
  (committed, not yet logged) → both steps PUT the same output → step B's `replace` is
  `conflict`; the output is neither live nor tombstoned, so B deletes it → the ledger loses its
  storage; the rebuild rolls the expiry back, input 1 is live again → step A's `replace`
  commits: the output is live and has no object (I11). Its inputs are now tombstoned and will
  be purged, and the shard discarded the rows long ago: the acknowledged rows are lost (I1),
  and every query over the range is refused.
- **Why.** "An input is gone for good" is false while its removal is unlogged: a rebuild
  brings it back and an identical step can then commit. A `blocking` conflict (precedence, new
  in `ledger.ts`) takes the same path with every input still live. (The check of tombstones,
  added to `compact.ts` while this work ran, fixed the grace-period variant of this finding,
  not this one; the model follows the current code.)
- **Fix (smallest).** A fresh step id in compaction output keys, so no two steps ever share an
  object; a step then deletes on conflict only objects no other step can make live. Modelled
  as `compKey: 'unique'` (a never-reused step id); `IMPL_6`, `DESIGN_7` and the `A_*` runs check it.

### F12 (major, code: `shard/src/shard.ts` with lazy registration) — A flush that spans a shard storage loss files the new incarnation's rows under the old one

- **Code.** `pendingSegments` labels segments with the current incarnation; `readSegment(tenant,
  seqLo)` takes no incarnation and returns whichever stream holds that `seqLo` now; `flush.ts`
  checks only the count and the sequence numbers.
- **Trace** (`F12_impl_read_unbound`, 13 steps; the same as peel step `IMPL_2`): batch 0
  acknowledged and sealed; a flush Worker lists `inc 1, 1..1` → the shard loses its storage →
  batch 1 arrives, incarnation 2, seq 1, sealed → the Worker's `readSegment(tenant, 1)` returns
  batch 1, which it encodes as `inc 1 1..1` → `addUnit(inc 1, 1..1)` is admitted (and registers
  incarnation 1) → a query plans (file `inc 1 1..1`, watermark inc 1 @ 1), is told
  `incarnation_mismatch(2)`, re-plans, reads incarnation 2 from 0 → batch 1 twice (I3); once
  incarnation 2 is flushed, permanently (logs, spans).
- **Impact.** Permanent duplicates, and a false loss record: the ledger says incarnation 1 was
  recorded through seq 1, so the row really lost (batch 0) is not visible as a loss, which
  §4.3 requires.
- **Masked by F1's fix:** with registration before writes the stale unit is refused as
  `incarnation_mismatch` (guard (o): 2.5 M states, no counterexample).
- **Fix.** `readSegment(tenant, incarnation, seqLo, seqHi)` returns null unless the stream has
  that incarnation and exactly that segment (`readBound`).

### F6 (major, code: `shard/src/shard.ts`, and lazy registration) — `tailRead` answers "ok, nothing" for a stream the shard no longer holds

- **Code.** `if (!s) return { status: 'ok', incarnation, through: aboveSeq, batches: [] }`.
  DESIGN says what a recreated shard does before *writes*, not what it answers to *reads*
  (draft-3 review, finding 8). Two forms:
- **(a) A registered stream** (guard (n), 15 steps; TLC `F6_unknown_stream_reads_empty`, 12):
  batch 0 acknowledged and sealed → a query plans (watermark inc 1 @ 0) → the unit for batch 0
  is admitted and logged → the shard loses its storage → the tail read "inc 1, above 0" gets
  `ok`, nothing → the query completes without batch 0 (I4), though batch 0 is safe in a file
  the plan predates.
- **(b) As built, an unregistered stream** (`F6_impl_unknown_stream`, 13 steps; peel step
  `IMPL_3`): the stream's first segment is flushed but not yet admitted when the query plans,
  so the plan has no watermark for that shard and the coordinator asks it with incarnation 0
  → the unit is admitted and logged → the shard loses its storage → "incarnation 0, above 0"
  gets `ok`, nothing → batch 0 missed (I4). The shard cannot tell "never held this tenant"
  from "lost it", so no answer to incarnation 0 is right: this form exists only because
  registration is lazy.
- **Fix.** Register before accepting writes (F1's fix, applied to `shard.ts`): then an
  unregistered stream has no acknowledged rows and need not be asked, and a stream the shard
  does not hold is answered `incarnation_mismatch(0)`, never `ok`. **Refusing without
  re-registering is not enough:** `LIVE_impl_F6_refuse_only` reaches a state from which no
  query ever completes (the tenant sends nothing more to that shard, nothing recreates the
  stream, the ledger keeps naming the lost incarnation); with registration the refusing shard
  re-registers and the next plan names the new incarnation (`LIVE_impl_F6_fixed`).

### F10 (major, planned contract: `contracts/LEDGER-LOG.md`) — A retried drain writes an overlapping segment; a strict rebuild then refuses the log

- **Text.** "Segments of one incarnation never overlap and never leave a gap" and "A failed
  write leaves the rows in place … Because the key is derived from the versions it holds and
  the body from the rows, a retry writes the same object", while "new mutations keep
  committing; they go in the next segment".
- **Trace** (`F10_segments_overlap`, 11 steps; `F10_rebuild_refuses` and guard (p), 12): a drain
  PUTs `seg-1-1` → the object dies (or the PUT's answer is lost) before the delete transaction
  → `addUnit` commits version 2 → the retried drain reads the pending rows v1..v2 and PUTs
  `seg-1-2`: a different key, so `If-None-Match` does not stop it → R2 holds overlapping
  segments → the ledger loses its storage → the rebuild, which like `ledger.ts`'s `replay`
  accepts only `version + 1`, refuses.
- **Impact.** The tenant's ledger cannot be rebuilt: `init()` fails and the object serves
  nothing, for ever, exactly when it is needed. (The overlapping bodies are identical, so a
  reader that skipped versions it already has would be right; the contract says it need not.)
- **Fix (one sentence).** *Before its PUT a drain records the segment's `[first, last]` in
  SQLite; a retry writes exactly that segment again before taking newer rows* (modelled as
  `drainRetrySame`; passes). Or: readers skip versions already applied after checking the
  bodies agree, and the contract says segments may overlap.

### F13 (major, code: `compact.ts` + `janitor.ts`) — A compaction step adopts an old output that the sweeper deletes by its old upload time

- **Code.** `putFile` accepts an existing object with the same hash as written ("exists");
  `sweepOrphans` deletes an unreferenced compaction output once its *upload* is older than
  max(24 h, 2 × `maxStepMs`).
- **Trace** (`F13_impl_comp_adopts_old_output`, 19 steps): two units admitted → step A reads
  both, PUTs the output, crashes (or gives up `too_slow`) → later step B picks the same inputs,
  hence the same key; its PUT finds A's object ("exists") → the sweeper, judging the object by
  A's upload, deletes it → B's `replace` commits a live file with no object (I11); once the
  inputs are purged the rows are gone (I1).
- **Timing.** Needs the inputs to stay uncompacted for 24 h after A gave up, and the sweep to
  fall between B's PUT and B's `replace`: rare (a merge that keeps failing `too_slow`, a ledger
  outage), but the comment "it can never delete an output a step is about to make live" is
  false.
- **Fix.** As F14: a step-unique key, so a step never relies on an object another step wrote
  (or re-PUT unconditionally, which resets the upload time).

### F15 (major, rare; code: `janitor.ts` `flushFileState`, `contracts/ledger.ts` `orphanCheck`) — The sweeper calls an old incarnation dead on a registration that is not yet logged

- **Code.** `flushFileState`: `if (w.incarnation > Number(inc)) return 'dead'`, with `w` from
  `orphanCheck().logged`, whose incarnation is the stream's *committed* incarnation. The
  contract's reason, "a lower one is refused", holds only until a rebuild rolls that
  registration back.
- **Trace** (found by peel step `DESIGN_6`, the design with every earlier fix and the
  as-built sweeper, 17 steps; isolated in `F15_sweeper_trusts_unlogged_registration`): two
  flush Workers list incarnation 1's segment 1..1 → Worker 1 reads, PUTs file K, crashes →
  Worker 2 reads → the shard loses its storage → incarnation 2 registers (committed, not
  logged) → Worker 2's PUT finds K ("exists") → the sweeper: K is unreferenced and of
  incarnation 1 < 2, so dead → deleted → the ledger loses its storage; the rebuild rolls
  incarnation 2's registration back → Worker 2's `addUnit(inc 1, 1..1)` is admitted: a live
  file with no object (I11). Every query over that range is refused from then on.
- **Timing.** As F13: the sweeper's 24 h age rule must pass for Worker 1's upload while
  Worker 2, which read the segment before the loss, has still to report. Rare.
- **Fix.** Count a newer incarnation only once its registration is logged (`orphanCheck`
  returns, per stream, the incarnation as of the logged prefix). Modelled as
  `sweepIncLogged`; `DESIGN_7` and `IMPL_5`/`IMPL_6` check it. It also surfaced in the as-built
  peel (`IMPL_4`, 17 steps).

### F4 (major, unstated assumption) — "A missing planned file is an error that re-plans" is load-bearing and not in the text

- §5.2 gives the grace period; nothing says what a reader does with a 404. TLC
  `F4_missing_file_must_be_error` (16 steps): with every other fix on, a plan from an unlogged
  version names a file that a rebuild and a legitimate orphan sweep remove; read as empty, the
  query misses a batch. `query/src/coordinator.ts` implements the rule (`MissingFile` →
  re-plan). **Fix:** state it in §6.2.

### F3 (major for logs and spans; consequence of a declared loss) — Fingerprints die with the shard's storage

- §4.2.3 keeps fingerprints "longer than the documented client retry horizon"; §4.3 says a
  storage loss loses rows, not that it re-opens the dedup window. Trace
  (`F3_retry_after_shard_loss`, 18 steps; TLC 15): batch 0 acknowledged and read by a flush
  Worker → shard storage loss → the Worker's late `addUnit` is admitted → the new incarnation
  registers → the client re-sends batch 0 (its acknowledgement was lost) → stored again → a
  query returns it twice (I3). **Fix (smallest):** the loss alert says rows may be missing
  *and duplicated* for one retry horizon. Real fix: units carry their batches' fingerprints,
  the ledger keeps them for the retry horizon and seeds a new incarnation with them. The
  amended runs *assume* no retry across a loss.

### F5 (liveness, unstated timing assumption) — A query attempt is refused once per discard unless it is shorter than `retainRecordedMs`

- §6.2: "Shards keep recorded segments for a short bounded time, and a refused split is
  retried on its own…". Untimed, an adversarial schedule refuses one query once per discarded
  segment (TLC `F5_restart_without_timing`: 3 refusals in 30 steps); with unbounded ingest that
  is a livelock. With bounded ingest AG EF holds (`LIVE_amended`), and with the rule "a segment
  is not discarded while an attempt planned before it was recorded still waits for that shard"
  no attempt is ever refused (TLC `fixed_timing_no_restart`, exhaustive). **Fix:** state
  *plan-to-last-tail-read deadline < `retainRecordedMs`* and enforce it; today both are 30 s by
  default, by coincidence (`query/src/config.ts`, `shard.ts`).

### F7 (unstated assumption) — "Logged" must mean the contiguous prefix of versions

- TLC (i): if "logged" means "this change's object is in R2", out-of-order PUTs let a shard
  discard rows a rebuild loses (I5, then I1). `ledger.ts` drains in order and satisfies it;
  `loggedWatermarks()`'s contract should say "as of the highest version all of whose
  predecessors are in R2".

### F8 (contract hazard) — `AddUnitResult.watermark` is the committed watermark

- Forwarding it to `Shard.recorded` is guard (c): data lost after a rebuild in 12 steps.
  `flush.ts` correctly uses `loggedWatermarks()`. Rename it `committedWatermark` or drop it, and
  say on `Shard.recorded` that its only legitimate source is `loggedWatermarks()`.

### F11 (minor, planned contract) — Without `base.json` a ledger incarnation number can be reused

- LEDGER-LOG.md: "The first change of an incarnation is its base. There is no separate
  `base.json`." The base then reaches R2 only with the first drain. Trace
  (`F11_incarnation_reused`, 2 steps): a ledger commits a change → loses its storage before any
  drain → R2 holds nothing of that incarnation, so the restarted ledger takes the same number
  and re-issues the same versions with other content. DESIGN §4.3's "versions are never reused"
  fails. Only in-memory comparisons are affected (the coordinator's two-plan check, plan
  caches); the publisher reads only R2. **Fix:** keep "the base is in R2 before the incarnation
  commits anything" (as built).

### F9 (minor) — A ledger rebuild can undo retention

- An `expire` committed but not logged is rolled back by a rebuild; the files are live again
  until retention re-runs (`viz.qnt`, and the first steps of F14). DESIGN should say retention
  re-runs after a rebuild, and erasure deadlines count from the logged removal.

## Implementation / model mismatches

Read-only comparison of the model's actions with the code as of 2026-11-18 evening
(`shard/src/shard.ts` 612 lines, `ledger/src/ledger.ts` 800 lines; `flush.ts`,
`compact.ts`, `janitor.ts`, `query/src/coordinator.ts` where they decide behaviour). The
"as built" configuration of the explicit-state model (`IMPL` in `bfs/run.ts`) encodes the
code's choice for every row marked *modelled*.

### `shard/src/shard.ts`

| # | Code | Model / design | Consequence |
|---|---|---|---|
| S1 | `stream()` creates a stream (new incarnation) on the first `append` and never tells the ledger; the stream is registered later by `flush.ts` (first unit with `seqLo = 1`, or `registerStream` after `incarnation_mismatch`). | Design: register before accepting writes (§4.3). Modelled both ways (`reg: 'impl'` / `'design'` / `'logged'`). | Mostly safe for a fixed map because the coordinator also asks every pool shard the ledger does not know, from incarnation 0 (experiment (k) shows the gap otherwise); but a shard storage loss turns that read into F6(b), and lazy registration makes F12 possible. |
| S2 | `tailRead` for a tenant with no stream returns `ok`, empty, echoing the caller's incarnation. | Must refuse when the caller names an incarnation (`unknownStream`); with registration before writes an unregistered stream is never asked. | **F6** (a) and (b) (modelled). |
| S3 | `pendingSegments` labels segments with the *current* incarnation; `readSegment(tenant, seqLo)` takes no incarnation and returns the current stream's rows. | A read bound to `(incarnation, seqLo, seqHi)` (`readBound`). | **F12** (modelled). |
| S4 | `recorded(tenant, inc, through)` trusts its caller; the only caller (`flush.ts`) passes `loggedWatermarks()`. Boundary check: `through > recordedThrough`, a segment starts at `recordedThrough + 1`, one ends at `through`, `through ≤ sealedThrough`. | Same (`recorded` step reads the logged watermark). | Matches. The contract hazard is F8. |
| S5 | Incarnation = `Date.now() × 1024 + random(1024)`. | A counter that never repeats. | The ledger and `flush.ts` rely on "larger is newer" (refuse lower, register higher). A clock step back across a storage loss gives a lower number: the ledger refuses it for ever (fails closed, not modelled). |
| S6 | Fingerprints are deleted `fingerprintTtlMs` (15 min) after the batch's first append, only once its payload is discarded; a retry does not refresh the timer. | `fingerprintsExpire` moves the forgotten prefix to the discard mark; `fpHorizon` = no retry after that. | Matches; the retry horizon must be counted from the first send. (e) is what happens otherwise. |
| S7 | `append` seals in the same call at `sealBytes`; `alarm` discards through the highest eligible boundary. | `seal` and `discard` separate and nondeterministic. | Code behaviours are a subset of the model's. |
| S8 | Discard waits `retainRecordedMs` = 30 s from `recorded_at`; the coordinator's query timeout is also 30 s (`query/src/config.ts`). | `retain` timing assumption (F5). | F5's inequality holds today by coincidence of two defaults; nothing ties them. |
| S9 | Epoch: refuse `epoch < stream.epoch`, adopt a higher one; no "closed for epoch", no draining, no fingerprint hand-over. | Not modelled. | Unchecked on both sides. |
| S10 | Fence: `aboveSeq < discardedThrough` → `stale_watermark`; payloads NULLed and the mark moved in one synchronous block. | `tailRead`, `discard`. | Matches. |

### `ledger/src/ledger.ts`

| # | Code | Model / design | Consequence |
|---|---|---|---|
| L1 | Change log: one R2 object per change, drained lowest version first, outbox row deleted and `logged` advanced (incarnation-checked) only after its PUT. The mutation awaits one drain attempt, but answers `ok` even if R2 failed. | `log: 'perChange'` (as built). The PLANNED segments of LEDGER-LOG.md are `log: 'segments'`. | As built, "logged" is the version prefix (F7 satisfied) and a retried PUT rewrites the same key, so F10 cannot happen; it appears with the planned segments. |
| L2 | `addUnit` for an unknown shard registers it in the same transaction when `seqLo = 1`; different incarnation → `incarnation_mismatch`; `seqHi ≤ watermark` → `ok` replay; `seqLo ≠ watermark + 1` → `not_contiguous`; a live key → `invalid`. | Same. | Matches. `AddUnitResult.watermark` is the committed one (F8). |
| L3 | `registerStream`: same incarnation is a no-op, a lower one throws, a higher one resets watermark and `logged` to 0 and keeps `prev_incarnation`. | Same. | Matches. DESIGN §4.3 "the ledger records the boundary and raises an alert" is only `prev_incarnation`: no loss interval, no alert (not modelled). |
| L4 | `replace`: replay rule, `conflict` on a missing input, `invalid` on a live output; since this evening also `conflict` with `blocking` on overlapping precedence ranges. | Same except `blocking` (not modelled). | A `blocking` conflict sends `compact.ts` down the same delete-on-conflict path as F14. |
| L5 | Tombstones written in the removing transaction; `deletable` = removing version below the first unlogged version, older than `minAgeMs` by the ledger's clock, key not live; `forget` after the delete. | `purge` with `delLogged` + `delGrace` + not live. | Matches. Grace is time; the model assumes it exceeds every query (DESIGN 1 h vs 30 s query timeout). |
| L6 | `orphanCheck`: live keys, tombstoned keys and `logged` watermarks in one synchronous read; the incarnation it reports per stream is the *committed* one. | `sweep: 'impl'` (`sweepIncLogged: false`). | Fixes F2 in code (DESIGN §4.3's sentence was not updated); the committed incarnation is **F15**. |
| L7 | Rebuild replays only the NEWEST ledger incarnation (`base.json` + its changes), strictly (`version + 1` or throw); tombstones are rebuilt only from that incarnation's changes; `base.json` is PUT before the SQLite commit. | Same (`rebuild: 'strict'`, `baseFirst`). | Tombstones of removals made before the last rebuild are dropped: those objects are left to the orphan sweeper (flush files by logged watermark, compaction outputs by age). With strict replay and the planned segments, F10 makes the rebuild throw, and `init()` then leaves the object serving nothing. |
| L8 | Versions continue across incarnations (`base.version`); `plan` returns every registered stream and the files of a time range. | Relative versions; whole live set. | No effect on the properties checked. |

### Other code the model follows

| # | Code | Consequence |
|---|---|---|
| C1 | `compact.ts`: output key = hash(input keys) + hash(bytes); `putFile` accepts an existing object with the same hash as written ("exists"); on `conflict` it deletes its outputs unless one is live (tombstones are not consulted). | **F13**, **F14**. |
| C2 | `janitor.ts` `sweepOrphans`: compaction outputs are judged by the object's upload time only (≥ max(24 h, 2 × 5 min)); a flush file is dead if its stream's logged watermark covers it or the ledger has a newer (committed) incarnation. | F13 (an output adopted by a later step keeps its old upload time); F15. |
| C3 | `query/src/coordinator.ts`: asks every pool shard plus every registered stream; an unregistered stream is read from 0 at the incarnation the shard names; a learned newer incarnation is kept across re-plans; a missing planned file re-plans (F4 implemented); at most 3 refusals per shard or file, then 503. | Modelled (`query: 'impl'`). The 3-refusal cap turns F5's livelock into an error after 4 attempts. |
| C4 | `flush.ts`: tells the shard `recorded(loggedWatermarks())`, never the committed watermark (F8 handled by the caller). | Modelled. |

## Limits of the evidence

- **Bounds.** Exhaustive results hold for the bounds in each row and no further: at most
  3 batches, 2 shards, 2 tenants, one fault of each kind (two ledger rebuilds in two runs),
  one query at a time, two encoder outputs. A bug that needs four batches, two shard losses
  in one run, or overlapping compactions over three files is outside them; the simulation
  rows reach some such states but only sample them.
- **Two models, one reader.** Both models were written by reading the same design and code.
  Their agreement rules out many encoding slips, not a shared misreading of the text.
- **Not replayed against the code.** No trace has been executed against `shard.ts`,
  `ledger.ts` or the Workers. The as-built configuration and the mismatch tables come from
  reading the code. F6, F12, F13 and F14 should each become a failing integration test
  (`@cloudflare/vitest-plugin`, `evictDurableObject`, hooks in `flush.ts`/`compact.ts`) before
  they are fixed.
- **Assumed, not fixed.** The amended protocol *assumes* no client retry across a shard
  storage loss (F3), retry horizon < fingerprint TTL, grace period > query lifetime, and (for
  the liveness proxy L2 only) query attempt < `retainRecordedMs`. (e), (g) and F5 show each is
  load-bearing.
- **Time is abstract.** Every timing rule is either nondeterministic or an assumption. F13's
  precondition (an output abandoned ≥ 24 h earlier with the same inputs) is a real but slow
  path that the model reaches in a few steps.
- **Liveness.** Checked as AG EF on the finite graph (with unbounded refusals), which with
  strong fairness implies termination; no temporal formula under weak fairness was checked, and
  the bounded environment (finite batches, finite faults) eventually stops changing, which is
  what makes the stale-watermark refusals finite. F5 is the unbounded-ingest case.
- **Not modelled:** shard-map epochs, file precedence, partitions and index fragments, the
  publisher and Iceberg, rollups and hour closure, quotas and back-pressure, cross-tenant
  quotas. Two tenants are modelled only in one pooled shard with tiny bounds.
- **Fixes are modelled as rules.** That an amended run passes says the rule is sufficient
  within the bounds, not that an implementation of the rule is right.
