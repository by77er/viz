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
| `bfs/replay.ts` | Replays a recorded counterexample step by step against another configuration and says where it stops; writes `results/REPLAY.md`. With `--deadend`, replays a liveness counterexample in another configuration and searches forward from its last state for the goal. |
| `fill-readme.mjs` | Regenerates every result table in this README from `results/` (`--write`). |
| `results/RESULTS.md`, `results/BFS.md`, `results/REPLAY.md` | Every experiment with states, depth, time and every counterexample step by step; the replays. |

```
npm install
npm run check          # everything: typecheck, Quint tests, explicit-state checker, TLC, simulation; then the tables here
npm run check:quick    # typecheck, Quint tests, explicit-state guard-off + findings, TLC guard-off + design-as-written (~30 min)
npm run check:bfs      # explicit-state checker only;   node bfs/run.ts <name|teeth|finding|d30|log|amended|liveness|proposed> ...
node bfs/replay.ts     # the recorded F13, F14, F15, IMPL_PLANNED and F6(b) traces against the code as built and the proposed fixes
node bfs/replay.ts --deadend <trace> <cfg>   # is a liveness counterexample's last state a dead end in <cfg> too?
npm run check:tlc      # TLC only;                      node experiments.mjs <name|teeth|literal|witness|fixed> ...
npm run test:quint     # the Quint scenario tests
```

Requirements: Node 22 (it runs `bfs/*.ts` directly) and Java 17. The first `quint verify`
downloads Apalache 0.62.4 (which bundles TLC) into `~/.quint`; that needs network access once.
Every run is capped for a shared machine: the explicit-state checker keeps its frontier on
disk (`build/`, compressed), runs under `--max-old-space-size=1024` and stops at 19 million
states, or at a lower bound a row names; a run that stops says so and reports the depth up to
which every state was checked. TLC gets `-Xmx900m`, a 400 MB off-heap fingerprint set and two
workers. Run TLC and the explicit-state checker one after the other, not together.

## Which protocol is checked

- **The ledger's change log.** Both models check the batched log of `contracts/LEDGER-LOG.md`:
  a mutation answers after its SQLite commit, changes reach R2 later, and shards discard only
  up to the LOGGED watermark. `viz.qnt` abstracts the log as an outbox written to R2 a prefix
  at a time. `bfs/model.ts` models it literally: a drain PUTs one segment holding the pending
  changes, then deletes those outbox rows and advances `logged` in one transaction, and can die
  between the two; the rebuild lists the segments in key order and replays them strictly.
  When this work started the segment log was PLANNED and `ledger.ts` wrote one object per
  change (`log: 'perChange'` in the model). The "as written" runs check the plan as it stood
  then, which is where F10 and F11 come from. During this work LEDGER-LOG.md adopted both fixes
  and `ledger.ts` was rebuilt on segments; the "as built" runs follow the new code
  (`drainRetrySame`, `baseFirst`, `baseTombstones`).
- **The compaction fix as built (D30, 2026-11-19).** `compact.ts` and `janitor.ts` fixed F13,
  F14 and F15 differently from the model's proposal (step-unique keys): output keys are
  unchanged, each output carries its inputs as R2 metadata `viz-inputs`, a step never deletes
  an output, and the orphan sweep deletes an unreferenced output only when one of its inputs is
  absent from its listing and not live in its one ledger read; a newer incarnation kills old
  flush files only once it has a logged watermark above 0. The `d30` runs check that rule
  as the code runs it: the sweep is three kinds of step (list R2; one `orphanCheck`; one delete
  per doomed key) that any other step can come between, **with no clock at all** (no age
  floor, which the code keeps but says is not what makes it safe), purge is delete then forget,
  and the ledger's start is two steps (base segment PUT, then commit, nothing served in
  between, storage can be lost again in between). Configuration `D30` in `bfs/run.ts`.
- **Proposed fixes (2026-11-19, model only).** Registration before writes in four variants
  (R1–R4) against the code as built, and a fix for F16; R2 with the F16 fix is recommended. See
  "Proposed fixes" below; configurations `R1`–`R4`, `F16FIX`, `PROPOSED` in `bfs/run.ts`.
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
| Ledger (one per tenant) | `registerStream`, `addUnit` (contiguous, atomic, idempotent replay, unknown stream admitted only at `seqLo = 1`), `replace` (inputs-live check, replay rule), `expire` (whole file), versions, tombstones, `loggedWatermarks`, `deletable`, `orphanCheck`, the change log (drain PUT, drain commit, drain crash between them), `LEDGER STORAGE LOSS` → rebuild from R2 into a new ledger incarnation; as built (`startSteps`) the start is two steps, PUT the base segment, then commit, with every request gated in between and a second loss possible in between. | `contracts/ledger.ts`, `contracts/LEDGER-LOG.md`, `ledger/src/ledger.ts` |
| Compaction (≤ 1 or 2 steps at once) | read two live inputs → PUT the output (an existing object with the same key is adopted, keeping its uploader) → `replace`; on `conflict` delete the output unless it is live (before D30) or delete nothing (D30); crash at any point. | `compact/src/compact.ts` `compactStep` |
| Physical deletion | `purge`: `deletable` (removal logged, grace passed = no query in flight holds a plan naming it, not live) → R2 delete → `forget` (one step, or two with `purgeSteps`). `orphan sweep` under one of five rules (DESIGN §4.3 as written, `janitor.ts` before D30, D30, and two teeth), as one atomic step or (`sweepSteps`) as `janitor.ts` runs it: list, one `orphanCheck`, one delete per doomed key. | `janitor/src/janitor.ts`, DESIGN §4.3, §5.2 |
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
| `V_IncarnationNotReused` | DESIGN §4.3: "a rebuilt ledger starts a new ledger incarnation, so versions are never reused". With `startSteps`: no base segment is PUT for a number R2 already has; otherwise: no incarnation commits a change that R2 does not hold before its storage is lost. | `bfs` |
| `W_NoLeakBehindLostFlush`, `W_NoChainedOutputLive` | Witnesses, expected to be violated: F16's state, and a live output built from an output (non-vacuity of `D30_chain`). | `bfs` |
| `LIVE_QueryCanComplete` | **Liveness.** AG EF (query done) on the complete state graph, with refusals unbounded: from every reachable state the query can still complete. In a finite graph this plus strong fairness implies every query completes; a violation is a state from which no schedule completes it (refusals for ever). | `bfs` |
| `LIVE_NoLeak` | **Liveness, I11's no-leak half.** AG EF (every object in R2 is live) on the complete graph, with retention allowed to remove any file and no query: from every reachable state some continuation deletes, or makes live, every object no ledger lists. A violation is an object that nothing will ever delete. `LIVE_NoLeakComp` is the same for compaction outputs only (what D30 changed). | `bfs` |
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
| Experiment | Checked | Result | Steps | Distinct states | Time | Shortest counterexample |
|---|---|---|---|---|---|---|
| `a_no_fence` (a) tail read without the fence | I4_NoGapAtSeam | **I4_NoGapAtSeam** violated | 17 | 57,644 | 5.4 s | register(inc 1) → drainPUT(v1) → regLogged → append(b0) → seal(..1) → list(inc1 1..1) → read(inc1 1..1) → put(1..1) → drainCommit → plan → addUnit(inc1 1..1) → drainPUT(v2) → drainCommit → recorded(1) → discard(1) → tail(inc1 >0)=∅ → done{} |
| `b_highest_seq` (b) watermark = highest seq seen, not the contiguous prefix | I4_NoGapAtSeam | **I4_NoGapAtSeam** violated | 14 | 15,605 | 0.9 s | register(inc 1) → drainPUT(v1) → regLogged → append(b0) → seal(..1) → append(b1) → seal(..2) → list(inc1 2..2) → read(inc1 2..2) → put(2..2) → addUnit(inc1 2..2) → plan → tail(inc1 >2)=∅ → done{b1} |
| `b_highest_seq_I1` (b) same, as data loss | I1_AckedIsDurable | **I1_AckedIsDurable** violated | 16 | 40,413 | 2.2 s | register(inc 1) → drainPUT(v1) → regLogged → append(b0) → seal(..1) → append(b1) → seal(..2) → list(inc1 2..2) → read(inc1 2..2) → put(2..2) → addUnit(inc1 2..2) → drainCommit → drainPUT(v2) → drainCommit → recorded(2) → discard(1) |
| `c_recorded_at_committed` (c) shard told `recorded` at the committed watermark; ledger loss + rebuild | I5_DiscardOnlyLogged | **I5_DiscardOnlyLogged** violated | 10 | 2,158 | 0.1 s | register(inc 1) → drainPUT(v1) → regLogged → append(b0) → seal(..1) → list(inc1 1..1) → read(inc1 1..1) → put(1..1) → addUnit(inc1 1..1) → recorded(1) |
| `c_recorded_at_committed_I1` (c) same, carried through to data loss | I1_AckedIsDurable | **I1_AckedIsDurable** violated | 12 | 8,506 | 0.5 s | register(inc 1) → drainPUT(v1) → regLogged → append(b0) → seal(..1) → list(inc1 1..1) → read(inc1 1..1) → put(1..1) → addUnit(inc1 1..1) → recorded(1) → discard(1) → LEDGER-LOSS+rebuild |
| `d_no_dedup` (d) no dedup fingerprints, client retry | I3_NoDuplicates | **I3_NoDuplicates** violated | 8 | 276 | 0 s | register(inc 1) → drainPUT(v1) → regLogged → append(b0) → retry(b0) → plan → tail(inc1 >0)=b0,b0 → done{b0x2} |
| `e_fp_expiry` (e) fingerprint TTL shorter than the retry horizon | I3_NoDuplicates | **I3_NoDuplicates** violated | 19 | 106,504 | 5.4 s | register(inc 1) → drainPUT(v1) → regLogged → append(b0) → seal(..1) → list(inc1 1..1) → read(inc1 1..1) → put(1..1) → addUnit(inc1 1..1) → drainCommit → drainPUT(v2) → drainCommit → recorded(1) → discard(1) → fpExpire(1) → retry(b0) → plan → tail(inc1 >1)=b0 → done{b0x2} |
| `f_replace_not_live` (f) replace without the inputs-live check, racing retention | I9_NoResurrection | **I9_NoResurrection** violated | 19 | 157,708 | 8.6 s | register(inc 1) → drainPUT(v1) → regLogged → append(b0) → seal(..1) → append(b1) → seal(..2) → list(inc1 1..1) → list(inc1 2..2) → read(inc1 1..1) → put(1..1) → addUnit(inc1 1..1) → read(inc1 2..2) → put(2..2) → addUnit(inc1 2..2) → compRead → expire(L0(s0 inc1 1..1)) → compPut → replace |
| `g_delete_no_grace` (g) physical deletion without waiting for queries holding an old plan; missing file read as empty | I4_NoGapAtSeam | **I4_NoGapAtSeam** violated | 25 | 578,871 | 40.6 s | register(inc 1) → drainPUT(v1) → regLogged → append(b0) → seal(..1) → append(b1) → seal(..2) → list(inc1 1..1) → list(inc1 2..2) → read(inc1 1..1) → put(1..1) → addUnit(inc1 1..1) → read(inc1 2..2) → put(2..2) → addUnit(inc1 2..2) → drainCommit → compRead → compPut → plan → replace → drainPUT(v2-v4) → drainCommit → purge(L0(s0 inc1 1..1)) → tail(inc1 >2)=∅ → done{b1} (file unreadable, read as empty) |
| `g_delete_no_grace_loud` (g) same, missing file is an error: the query is refused (with the `retain` timing assumption no other refusal exists) | L2_NoRefusal | **L2_NoRefusal** violated | 25 | 565,377 | 38.7 s | register(inc 1) → drainPUT(v1) → regLogged → append(b0) → seal(..1) → append(b1) → seal(..2) → list(inc1 1..1) → list(inc1 2..2) → read(inc1 1..1) → put(1..1) → addUnit(inc1 1..1) → read(inc1 2..2) → put(2..2) → addUnit(inc1 2..2) → drainCommit → compRead → compPut → plan → replace → drainPUT(v2-v4) → drainCommit → purge(L0(s0 inc1 1..1)) → tail(inc1 >2)=∅ → file missing → re-plan |
| `h_overwrite` (h) flush key deterministic and the PUT overwrites; two encoder outputs | I11_LiveFilesReadable | **I11_LiveFilesReadable** violated | 12 | 7,223 | 0.4 s | register(inc 1) → drainPUT(v1) → regLogged → append(b0) → seal(..1) → list(inc1 1..1) → list(inc1 1..1) → read(inc1 1..1) → put(1..1v1) → addUnit(inc1 1..1) → read(inc1 1..1) → put(1..1v2) |
| `h_if_none_match` (h2) deterministic key + If-None-Match (draft 3): the ledger describes the loser | I11_LiveFilesReadable | **I11_LiveFilesReadable** violated | 12 | 7,243 | 0.3 s | register(inc 1) → drainPUT(v1) → regLogged → append(b0) → seal(..1) → list(inc1 1..1) → list(inc1 1..1) → read(inc1 1..1) → put(1..1v1) → read(inc1 1..1) → put(1..1v2) → addUnit(inc1 1..1) |
| `i_fingerprint_per_shard` (i) fingerprints scoped per shard, not per stream; 2 tenants send identical bytes | I1_AckedIsDurable | **I1_AckedIsDurable** violated | 8 | 689 | 0 s | register(t0 inc 1) → register(t1 inc 1) → drainPUT t0(v1) → regLogged → append(b0) → drainPUT t1(v1) → regLogged → append(b1)=dup |
| `j_tail_read_per_shard` (j) tail read not scoped to the tenant; 2 tenants in one pooled shard | I20_TenantIsolation | **I20_TenantIsolation** violated | 8 | 703 | 0 s | register(t0 inc 1) → register(t1 inc 1) → drainPUT t0(v1) → regLogged → append(b0) → plan t1 → tail(inc1 >0)=b0 → done{b0} |
| `k_no_handshake` (k) no registration before writes, query asks only streams in the plan | I4_NoGapAtSeam | **I4_NoGapAtSeam** violated | 3 | 20 | 0 s | append(b0) → plan → done{} |
| `l_sweep_any` (l) orphan sweeper deletes any unreferenced object | I11_LiveFilesReadable | **I11_LiveFilesReadable** violated | 10 | 1,361 | 0.1 s | register(inc 1) → drainPUT(v1) → regLogged → append(b0) → seal(..1) → list(inc1 1..1) → read(inc1 1..1) → put(1..1) → sweep(L0(s0 inc1 1..1)) → addUnit(inc1 1..1) |
| `m_delete_before_logged` (m) removed file deleted before its removal is logged; ledger loss + rebuild | I11_LiveFilesReadable | **I11_LiveFilesReadable** violated | 22 | 542,904 | 29.7 s | register(inc 1) → drainPUT(v1) → regLogged → append(b0) → seal(..1) → append(b1) → seal(..2) → list(inc1 1..1) → list(inc1 2..2) → read(inc1 1..1) → put(1..1) → addUnit(inc1 1..1) → read(inc1 2..2) → put(2..2) → addUnit(inc1 2..2) → drainCommit → drainPUT(v2-v3) → compRead → compPut → replace → purge(L0(s0 inc1 1..1)) → LEDGER-LOSS+rebuild |
| `n_unknown_stream_empty` (n) tailRead on a stream the shard does not hold answers ok/empty | I4_NoGapAtSeam | **I4_NoGapAtSeam** violated | 15 | 82,807 | 3.6 s | register(inc 1) → drainPUT(v1) → regLogged → append(b0) → seal(..1) → list(inc1 1..1) → read(inc1 1..1) → put(1..1) → drainCommit → plan → addUnit(inc1 1..1) → drainPUT(v2) → SHARD-LOSS → tail(inc1 >0)=∅ → done{} |
| `o_read_unbound` (o) flush reads readSegment(tenant, seqLo) unbound to the incarnation. NO counterexample: with registration before writes (F1 fix) the stale unit is refused as incarnation_mismatch; it bites only with lazy registration (F12) | I3_NoDuplicates | holds (exhaustive) |  | 2,491,630 | 138.3 s |  |
| `p_drain_retry_new_bounds` (p) a retried drain writes all pending changes (new bounds); strict replay | AV_RebuildSucceeds | **AV_RebuildSucceeds** violated | 12 | 8,452 | 0.2 s | register(inc 1) → drainPUT(v1) → regLogged → append(b0) → seal(..1) → list(inc1 1..1) → read(inc1 1..1) → put(1..1) → addUnit(inc1 1..1) → DRAIN-CRASH → drainPUT(v1-v2) → LEDGER-LOSS+rebuild REFUSED |
<!-- END BFS_TEETH -->

(a)–(h), the guards the task names, each produce a counterexample in both checkers. One
further guard does **not**: (o), a flush read not bound to the incarnation. With the
amended registration rule a stale unit is refused as `incarnation_mismatch`, so in the amended
protocol that rule is redundant (11 million states, no counterexample). It does bite in the code
as built, where registration is lazy: finding F12.

**TLC on `viz.qnt`** (same baseline and bounds in that model's terms):

<!-- BEGIN TLC_TEETH -->
| Experiment | Property | Result | Steps | Distinct states | Run | Shortest counterexample |
|---|---|---|---|---|---|---|
| `a_no_fence` (a) tail read without the fence check | I4_NoGapAtSeam | violated | 13 | 18,764 | re-run | register(inc 1) → log → append(b0) → seal(..1) → flushRead(..1) → put(..1) → plan → addUnit(..1) → log → recorded(1) → discard(1) → tail(>0)=ok → done |
| `b_highest_seq` (b) watermark = highest seq seen (no contiguity check) | I4_NoGapAtSeam | violated | 12 | 10,282 | re-run | register(inc 1) → log → append(b0) → seal(..1) → append(b1) → seal(..2) → flushRead(..2) → put(..2) → addUnit(..2) → plan → tail(>2)=ok → done |
| `b_highest_seq_I1` (b) same guard, storage property | I1_AckedIsDurable | violated | 12 | 10,266 | re-run | register(inc 1) → log → append(b0) → seal(..1) → append(b1) → seal(..2) → flushRead(..2) → put(..2) → addUnit(..2) → log → recorded(2) → discard(1) |
| `c_recorded_at_committed` (c) shard told `recorded` at the committed, not logged, watermark; ledger loss + rebuild | I5_DiscardOnlyLogged | violated | 8 | 567 | re-run | register(inc 1) → log → append(b0) → seal(..1) → flushRead(..1) → put(..1) → addUnit(..1) → recorded(1) |
| `c_recorded_at_committed_I1` (c) same guard, carried through to data loss | I1_AckedIsDurable | violated | 10 | 3,202 | re-run | register(inc 1) → log → append(b0) → seal(..1) → flushRead(..1) → put(..1) → addUnit(..1) → recorded(1) → discard(1) → LEDGER-LOSS+REBUILD |
| `d_no_dedup` (d) no dedup fingerprints, client retry | I3_NoDuplicates | violated | 7 | 156 | re-run | register(inc 1) → log → append(b0) → append(b0) → plan → tail(>0)=ok → done |
| `e_fp_expiry` (e) fingerprint TTL shorter than the client retry horizon | I3_NoDuplicates | violated | 15 | 40,108 | re-run | register(inc 1) → log → append(b0) → seal(..1) → flushRead(..1) → put(..1) → addUnit(..1) → log → recorded(1) → discard(1) → fpExpire(1) → append(b0) → plan → tail(>1)=ok → done |
| `f_replace_not_live` (f) replace without the inputs-live check, racing retention | I9_NoResurrection | violated | 16 | 95,651 | re-run | register(inc 1) → log → append(b0) → seal(..1) → append(b1) → seal(..2) → flushRead(..1) → flushRead(..2) → put(..1) → addUnit(..1) → put(..2) → addUnit(..2) → compRead → expire → compWrite → replace |
| `g_delete_no_grace_silent` (g) physical deletion without waiting; a missing file reads as empty | I4_NoGapAtSeam | violated | 22 | 213,823 | re-run | register(inc 1) → log → append(b0) → seal(..1) → append(b1) → seal(..2) → flushRead(..1) → flushRead(..2) → put(..1) → addUnit(..1) → put(..2) → addUnit(..2) → log → log → compRead → compWrite → plan → tail(>2)=ok → replace → log → deleteRetired → done |
| `g_delete_no_grace_loud` (g) physical deletion without waiting; a missing file is an error (re-plan) | L2_NoRestart | violated | 22 | 186,856 | re-run | register(inc 1) → log → append(b0) → seal(..1) → append(b1) → seal(..2) → flushRead(..1) → flushRead(..2) → put(..1) → addUnit(..1) → put(..2) → addUnit(..2) → log → log → compRead → compWrite → plan → tail(>2)=ok → replace → log → deleteRetired → file missing → re-plan |
| `g_delete_before_logged` (g2) retired file deleted before its removal is logged; ledger loss + rebuild | I11_LiveFilesReadable | violated | 18 | 138,655 | re-run | register(inc 1) → log → append(b0) → seal(..1) → append(b1) → seal(..2) → flushRead(..1) → flushRead(..2) → put(..1) → addUnit(..1) → put(..2) → addUnit(..2) → log → compRead → compWrite → replace → deleteRetired → LEDGER-LOSS+REBUILD |
| `h_overwrite` (h) deterministic key, PUT overwrites (two encoder variants) | I11_LiveFilesReadable | violated | 9 | 2,174 | re-run | register(inc 1) → log → append(b0) → seal(..1) → flushRead(..1) → flushRead(..1) → put(..1) → put(..1) → addUnit(..1) |
| `h_if_none_match` (h2) deterministic key + If-None-Match (draft 3): metadata describes the loser | I11_LiveFilesReadable | violated | 9 | 2,176 | re-run | register(inc 1) → log → append(b0) → seal(..1) → flushRead(..1) → flushRead(..1) → put(..1) → put(..1) → addUnit(..1) |
| `h_overwrite_I4` (h) same guard, carried through to a query (unreadable file reads as empty) | I4_NoGapAtSeam | violated | 12 | 30,793 | re-run | register(inc 1) → log → append(b0) → seal(..1) → flushRead(..1) → flushRead(..1) → put(..1) → put(..1) → addUnit(..1) → plan → tail(>1)=ok → done |
| `i_log_out_of_order` (i) outbox entries reach R2 out of order; "logged" = own entry is on R2 | I5_DiscardOnlyLogged | violated | 14 | 36,862 | re-run | register(inc 1) → log → append(b0) → seal(..1) → append(b1) → seal(..2) → flushRead(..1) → flushRead(..2) → put(..1) → addUnit(..1) → put(..2) → addUnit(..2) → log[1] → recorded(2) |
| `i_log_out_of_order_I1` (i) same guard, carried through to data loss | I1_AckedIsDurable | violated | 16 | 78,446 | re-run | register(inc 1) → log → append(b0) → seal(..1) → append(b1) → seal(..2) → flushRead(..1) → flushRead(..2) → put(..1) → addUnit(..1) → put(..2) → addUnit(..2) → log[1] → recorded(2) → discard(1) → LEDGER-LOSS+REBUILD |
| `j_no_handshake` (j) stream accepts writes without registering with the ledger (shard.ts today) | I4_NoGapAtSeam | violated | 3 | 24 | re-run | append(b0) → plan → done |
| `k_replan_watermark_only` (k) refused tail read refreshes the watermark but keeps the old file list | I4_NoGapAtSeam | violated | 14 | 28,689 | re-run | register(inc 1) → log → append(b0) → seal(..1) → flushRead(..1) → put(..1) → plan → addUnit(..1) → log → recorded(1) → discard(1) → tail(>0)=STALE → tail(>1)=ok → done |
| `l_sweep_any` (l) orphan sweeper deletes any unreferenced object | I11_LiveFilesReadable | violated | 8 | 528 | re-run | register(inc 1) → log → append(b0) → seal(..1) → flushRead(..1) → put(..1) → sweepOrphan → addUnit(..1) |
| `m_sweep_compaction_output` (m) sweeper treats a compaction output as "below the logged watermark" | I11_LiveFilesReadable | violated | 18 | 83,806 | re-run | register(inc 1) → log → append(b0) → seal(..1) → append(b1) → seal(..2) → flushRead(..1) → flushRead(..2) → put(..1) → addUnit(..1) → put(..2) → addUnit(..2) → log → log → compRead → compWrite → sweepOrphan → replace |
<!-- END TLC_TEETH -->

## Step 2 — the faithful model, run as hard as the tooling allows

### 2a. The design as written, and the code as built: "peeling"

Each run below checks every safety property with every action (1 compaction, 1 retention
removal, 1 ledger storage loss, 1 shard storage loss, client retries, two flush Workers, one
query). Breadth-first search stops at the shortest violation; the next run adds the fix for
that finding and searches again, until a run passes. Findings found that way are then isolated
one at a time against the amended protocol (the `F…` rows).

In short. **Design as written** (`DESIGN_1`–`7`): F11 (2 steps) → with it fixed, F1 (5) → F10
(6) → F2 (15, through a retention removal; still the shortest after F3 is assumed away) →
with the as-built sweeper, F15 (17) → with every fix: no violation among the 19 million
states reachable in at most 23 steps (`DESIGN_7`, recorded before this pass and not re-run;
bounded-depth, not complete). **Code as built at 6488856** (`IMPL_1`–`3`, with D30, the segment log as
built and the F12 fix): F6(b) at 11 steps, also with F3 assumed away (`IMPL_2`); with
registration before writes as well (`IMPL_3`): no violation among the 4 million states
reachable in at most 19 steps (bounded). F3 is shadowed by F6(b) and isolated below; F12, F13,
F14 and F15 are isolated against the code of 2026-11-18 (`IMPL_V1`), where they were found.

<!-- BEGIN BFS_FINDINGS -->
| Experiment | Checked | Result | Steps | Distinct states | Time | Shortest counterexample |
|---|---|---|---|---|---|---|
| `DESIGN_1_as_written` DESIGN.md 3.1 + LEDGER-LOG.md as written; every action (1 compaction, 1 retention removal, 1 ledger loss, 1 shard loss), every safety property | all safety | **V_IncarnationNotReused** violated | 2 | 8 | 0 s | register(inc 1) → LEDGER-LOSS+rebuild (incarnation reused) |
| `DESIGN_2_fix_F11` DESIGN.md 3.1 + LEDGER-LOG.md + baseFirst; every action (1 compaction, 1 retention removal, 1 ledger loss, 1 shard loss), every safety property | all safety | **I4_NoGapAtSeam** violated | 5 | 218 | 0 s | register(inc 1) → append(b0) → LEDGER-LOSS+rebuild → plan → done{} |
| `DESIGN_3_fix_F1` DESIGN.md 3.1 + LEDGER-LOG.md + baseFirst, reg; every action (1 compaction, 1 retention removal, 1 ledger loss, 1 shard loss), every safety property | all safety | **LOG_SegmentsDisjoint** violated | 6 | 183 | 0.1 s | register(inc 1) → SHARD-LOSS → drainPUT(v1) → register(inc 2) → DRAIN-CRASH → drainPUT(v1-v2) |
| `DESIGN_4_fix_F10` DESIGN.md 3.1 + LEDGER-LOG.md + baseFirst, reg, drainRetrySame; every action (1 compaction, 1 retention removal, 1 ledger loss, 1 shard loss), every safety property | all safety | **I11_LiveFilesReadable** violated | 15 | 159,186 | 8.4 s | register(inc 1) → drainPUT(v1) → regLogged → append(b0) → seal(..1) → list(inc1 1..1) → read(inc1 1..1) → put(1..1) → addUnit(inc1 1..1) → drainCommit → drainPUT(v2) → drainCommit → expire(L0(s0 inc1 1..1)) → sweep(L0(s0 inc1 1..1)) → LEDGER-LOSS+rebuild |
| `DESIGN_5_assume_F3` DESIGN.md 3.1 + LEDGER-LOG.md + baseFirst, reg, drainRetrySame, noRetryAcrossLoss; every action (1 compaction, 1 retention removal, 1 ledger loss, 1 shard loss), every safety property | all safety | **I11_LiveFilesReadable** violated | 15 | 153,781 | 8.7 s | register(inc 1) → drainPUT(v1) → regLogged → append(b0) → seal(..1) → list(inc1 1..1) → read(inc1 1..1) → put(1..1) → addUnit(inc1 1..1) → drainCommit → drainPUT(v2) → drainCommit → expire(L0(s0 inc1 1..1)) → sweep(L0(s0 inc1 1..1)) → LEDGER-LOSS+rebuild |
| `DESIGN_6_fix_F2` DESIGN.md 3.1 + LEDGER-LOG.md + baseFirst, reg, drainRetrySame, noRetryAcrossLoss, sweep; every action (1 compaction, 1 retention removal, 1 ledger loss, 1 shard loss), every safety property | all safety | **I11_LiveFilesReadable** violated | 17 | 498,252 | 23.3 s | register(inc 1) → drainPUT(v1) → regLogged → append(b0) → seal(..1) → list(inc1 1..1) → list(inc1 1..1) → read(inc1 1..1) → put(1..1) → flushCrash → read(inc1 1..1) → SHARD-LOSS → register(inc 2) → put(1..1) → sweep(L0(s0 inc1 1..1)) → LEDGER-LOSS+rebuild → addUnit(inc1 1..1) |
| `DESIGN_7_fix_F15` DESIGN.md 3.1 + LEDGER-LOG.md + baseFirst, reg, drainRetrySame, noRetryAcrossLoss, sweep, sweepIncLogged; every action (1 compaction, 1 retention removal, 1 ledger loss, 1 shard loss), every safety property | all safety | stopped: memory bound: stopped at 19,000,001 states; every state reachable in at most 23 steps checked, no violation |  | 19,000,001 | 1595.1 s |  |
| `F1_registration_rolled_back` F1: registration committed, not logged; ledger rebuild forgets the stream (design reg, others fixed) | I4_NoGapAtSeam | **I4_NoGapAtSeam** violated | 5 | 153 | 0 s | register(inc 1) → append(b0) → LEDGER-LOSS+rebuild → plan → done{} |
| `F2_sweeper_spec_I1` F2: orphan sweeper as DESIGN §4.3 states it; ledger rebuild | I1_AckedIsDurable | **I1_AckedIsDurable** violated | 25 | 1,850,080 | 86.5 s | register(inc 1) → drainPUT(v1) → regLogged → append(b0) → seal(..1) → append(b1) → seal(..2) → list(inc1 1..1) → list(inc1 2..2) → read(inc1 1..1) → put(1..1) → addUnit(inc1 1..1) → read(inc1 2..2) → put(2..2) → addUnit(inc1 2..2) → drainCommit → drainPUT(v2-v3) → drainCommit → recorded(2) → discard(1) → compRead → compPut → replace → sweep(L0(s0 inc1 1..1)) → LEDGER-LOSS+rebuild |
| `F2_sweeper_spec_grace` F2: same sweeper deletes a removed file under a running query (missing read as empty) | I4_NoGapAtSeam | **I4_NoGapAtSeam** violated | 25 | 748,957 | 50.6 s | register(inc 1) → drainPUT(v1) → regLogged → append(b0) → seal(..1) → append(b1) → seal(..2) → list(inc1 1..1) → list(inc1 2..2) → read(inc1 1..1) → put(1..1) → addUnit(inc1 1..1) → read(inc1 2..2) → put(2..2) → addUnit(inc1 2..2) → drainCommit → drainPUT(v2-v3) → drainCommit → compRead → compPut → plan → replace → sweep(L0(s0 inc1 1..1)) → tail(inc1 >2)=∅ → done{b1} (file unreadable, read as empty) |
| `F3_retry_after_shard_loss` F3: fingerprints die with the shard storage; a retry is stored again | I3_NoDuplicates | **I3_NoDuplicates** violated | 18 | 410,871 | 14.6 s | register(inc 1) → drainPUT(v1) → regLogged → append(b0) → seal(..1) → list(inc1 1..1) → read(inc1 1..1) → SHARD-LOSS → put(1..1) → addUnit(inc1 1..1) → register(inc 2) → drainCommit → drainPUT(v2-v3) → regLogged → retry(b0) → plan → tail(inc2 >0)=b0 → done{b0x2} |
| `F10_segments_overlap` F10 (LEDGER-LOG.md): drain PUTs v1..vk, dies before deleting the rows, a change commits, the retry PUTs v1..vk+1 | LOG_SegmentsDisjoint | **LOG_SegmentsDisjoint** violated | 11 | 2,679 | 0.2 s | register(inc 1) → drainPUT(v1) → regLogged → append(b0) → seal(..1) → list(inc1 1..1) → read(inc1 1..1) → put(1..1) → addUnit(inc1 1..1) → DRAIN-CRASH → drainPUT(v1-v2) |
| `F10_rebuild_refuses` F10: same, then the ledger loses its storage: a strict replay refuses the log | AV_RebuildSucceeds | **AV_RebuildSucceeds** violated | 12 | 8,452 | 1 s | register(inc 1) → drainPUT(v1) → regLogged → append(b0) → seal(..1) → list(inc1 1..1) → read(inc1 1..1) → put(1..1) → addUnit(inc1 1..1) → DRAIN-CRASH → drainPUT(v1-v2) → LEDGER-LOSS+rebuild REFUSED |
| `F11_incarnation_reused` F11 (LEDGER-LOG.md): base is an ordinary first change; two ledger losses before it is drained | V_IncarnationNotReused | **V_IncarnationNotReused** violated | 2 | 6 | 0 s | register(inc 1) → LEDGER-LOSS+rebuild (incarnation reused) |
| `IMPL_1_as_built` code at 6488856 (shard.ts, ledger.ts, flush.ts, compact.ts + janitor.ts with D30, coordinator.ts); every action (1 compaction, 1 retention removal, 1 ledger loss, 1 shard loss), every safety property | all safety | **I4_NoGapAtSeam** violated | 11 | 56,177 | 5.8 s | append(b0) → seal(..1) → list(inc1 1..1) → read(inc1 1..1) → put(1..1) → plan → addUnit(inc1 1..1, registers) → drainPUT(v1-v2) → SHARD-LOSS → tail(inc0 >0)=∅ → done{} |
| `IMPL_2_assume_F3` code at 6488856 (shard.ts, ledger.ts, flush.ts, compact.ts + janitor.ts with D30, coordinator.ts) + noRetryAcrossLoss; every action (1 compaction, 1 retention removal, 1 ledger loss, 1 shard loss), every safety property | all safety | **I4_NoGapAtSeam** violated | 11 | 29,837 | 5 s | append(b0) → seal(..1) → list(inc1 1..1) → read(inc1 1..1) → put(1..1) → plan → addUnit(inc1 1..1, registers) → drainPUT(v1-v2) → SHARD-LOSS → tail(inc0 >0)=∅ → done{} |
| `IMPL_3_fix_F6b` code at HEAD + F3 assumed + registration before writes, logged (F1/F6 fix in shard.ts); every action, every safety property | all safety | stopped: memory bound: stopped at 4,000,002 states; every state reachable in at most 19 steps checked, no violation |  | 4,000,002 | 336 s |  |
| `F6_impl_unknown_stream` F6: shard.ts (2026-11-18) tailRead answers ok/empty for a stream it lost (no client retry across the loss) | I4_NoGapAtSeam | **I4_NoGapAtSeam** violated | 11 | 12,978 | 0.6 s | append(b0) → seal(..1) → list(inc1 1..1) → read(inc1 1..1) → put(1..1) → plan → addUnit(inc1 1..1, registers) → drainPUT(v1-v2) → SHARD-LOSS → tail(inc0 >0)=∅ → done{} |
| `F6b_impl_now` F6(b) in the code at HEAD: tailRead still answers ok/empty to incarnation 0, which the coordinator sends for a stream the ledger has not registered (lazy registration) | I4_NoGapAtSeam | **I4_NoGapAtSeam** violated | 11 | 14,978 | 2 s | append(b0) → seal(..1) → list(inc1 1..1) → read(inc1 1..1) → put(1..1) → plan → addUnit(inc1 1..1, registers) → drainPUT(v1-v2) → SHARD-LOSS → tail(inc0 >0)=∅ → done{} |
| `F12_impl_read_unbound` F12: shard.ts (2026-11-18) readSegment(tenant, seqLo) ignores the incarnation; a flush across a shard loss (no client retry across the loss) | I3_NoDuplicates | **I3_NoDuplicates** violated | 13 | 40,478 | 1.8 s | append(b0) → seal(..1) → list(inc1 1..1) → SHARD-LOSS → append(b1) → seal(..1) → read(inc1 1..1, gets inc2's rows) → put(1..1) → addUnit(inc1 1..1, registers) → plan → tail(inc1 >1)=INCARNATION_MISMATCH(2) → re-plan → tail(inc2 >0)=b1 → done{b1x2} |
| `F13_impl_comp_adopts_old_output` F13: compaction adopts an earlier step's output ("exists"); the sweeper judges it by the earlier upload | I11_LiveFilesReadable | **I11_LiveFilesReadable** violated | 19 | 132,735 | 6 s | append(b0) → seal(..1) → append(b1) → seal(..2) → list(inc1 1..1) → list(inc1 2..2) → read(inc1 1..1) → put(1..1) → addUnit(inc1 1..1, registers) → read(inc1 2..2) → put(2..2) → addUnit(inc1 2..2) → compRead → compPut → compCrash → compRead → compPut → sweep(L1(L0(s0 inc1 1..1)+L0(s0 inc1 2..2))) → replace |
| `F14_impl_comp_conflict_delete` F14: compaction deletes its output on conflict although an identical step made it live and it has been removed since (removal not yet logged); ledger rebuild | I11_LiveFilesReadable | **I11_LiveFilesReadable** violated | 21 | 41,961 | 1.7 s | append(b0) → seal(..1) → append(b1) → seal(..2) → list(inc1 1..1) → read(inc1 1..1) → put(1..1) → addUnit(inc1 1..1, registers) → list(inc1 2..2) → read(inc1 2..2) → put(2..2) → addUnit(inc1 2..2) → drainPUT(v1-v3) → compRead → compRead → expire(L0(s0 inc1 1..1)) → compPut → compPut → replace=conflict, output deleted → LEDGER-LOSS+rebuild → replace |
| `F15_sweeper_trusts_unlogged_registration` F15: janitor.ts (first version) calls an old-incarnation flush file dead because the ledger has a newer incarnation, whose registration is not yet logged; ledger rebuild | I11_LiveFilesReadable | **I11_LiveFilesReadable** violated | 17 | 518,127 | 17.3 s | register(inc 1) → drainPUT(v1) → regLogged → append(b0) → seal(..1) → list(inc1 1..1) → list(inc1 1..1) → read(inc1 1..1) → put(1..1) → flushCrash → read(inc1 1..1) → SHARD-LOSS → register(inc 2) → put(1..1) → sweep(L0(s0 inc1 1..1)) → LEDGER-LOSS+rebuild → addUnit(inc1 1..1) |
| `IMPL_PLANNED_fixed` As built with the fixes above (F6, F12, F13/F14, F15, F3 assumed), but the segment log as LEDGER-LOG.md stated it at the start of this work; ledger loss, compaction | all safety | **V_IncarnationNotReused** violated | 7 | 758 | 0.2 s | append(b0) → seal(..1) → list(inc1 1..1) → read(inc1 1..1) → put(1..1) → addUnit(inc1 1..1, registers) → LEDGER-LOSS+rebuild (incarnation reused) |
<!-- END BFS_FINDINGS -->

The same idea in `viz.qnt` (DESIGN as written, `literal_*`; TLC):

<!-- BEGIN TLC_LITERAL -->
| Experiment | Property | Result | Steps | Distinct states | Run | Shortest counterexample |
|---|---|---|---|---|---|---|
| `F1_registration_not_logged` F1: stream registration lost in a ledger rebuild | I4_NoGapAtSeam | violated | 5 | 168 | re-run | register(inc 1) → append(b0) → LEDGER-LOSS+REBUILD → plan → done |
| `F1_registration_not_logged_L1` F1: same, stuck-forever variant (re-registration after a shard loss) | L1_StreamRegistered | violated | 2 | 7 | re-run | register(inc 1) → LEDGER-LOSS+REBUILD |
| `F2_sweeper_unlogged_removal` F2: sweeper (as specified) deletes inputs of an unlogged compaction; ledger rebuild | I11_LiveFilesReadable | violated | 18 | 138,502 | re-run | register(inc 1) → log → append(b0) → seal(..1) → append(b1) → seal(..2) → flushRead(..1) → flushRead(..2) → put(..1) → addUnit(..1) → put(..2) → addUnit(..2) → log → compRead → compWrite → replace → sweepOrphan → LEDGER-LOSS+REBUILD |
| `F2_sweeper_unlogged_removal_I1` F2: same, as acknowledged-data loss | I1_AckedIsDurable | violated | 20 | 232,855 | re-run | register(inc 1) → log → append(b0) → seal(..1) → append(b1) → seal(..2) → flushRead(..1) → flushRead(..2) → put(..1) → addUnit(..1) → put(..2) → addUnit(..2) → log → recorded(1) → discard(1) → compRead → compWrite → replace → sweepOrphan → LEDGER-LOSS+REBUILD |
| `F2_sweeper_bypasses_grace` F2: sweeper (as specified) deletes a retired file under a running query; missing = empty | I4_NoGapAtSeam | violated | 20 | 135,536 | re-run | register(inc 1) → log → append(b0) → seal(..1) → append(b1) → seal(..2) → flushRead(..1) → flushRead(..2) → put(..1) → addUnit(..1) → put(..2) → addUnit(..2) → log → compRead → compWrite → plan → tail(>2)=ok → replace → sweepOrphan → done |
| `F2_sweeper_bypasses_grace_loud` F2: same with missing = error: the query is refused although the grace rule was respected | L2_NoRestart | violated | 20 | 123,961 | re-run | register(inc 1) → log → append(b0) → seal(..1) → append(b1) → seal(..2) → flushRead(..1) → flushRead(..2) → put(..1) → addUnit(..1) → put(..2) → addUnit(..2) → log → compRead → compWrite → plan → tail(>2)=ok → replace → sweepOrphan → file missing → re-plan |
| `F3_retry_after_shard_loss` F3: fingerprints die with the shard storage; a retry is accepted twice | I3_NoDuplicates | violated | 15 | 139,820 | re-run | register(inc 1) → log → append(b0) → seal(..1) → flushRead(..1) → SHARD-LOSS → put(..1) → addUnit(..1) → register(inc 2) → log → log → append(b0) → plan → tail(>0)=ok → done |
| `F6_unknown_stream_reads_empty` F6: tailRead on a stream the shard no longer holds answers ok/empty (shard.ts) instead of refusing | I4_NoGapAtSeam | violated | 12 | 21,634 | re-run | register(inc 1) → log → append(b0) → seal(..1) → flushRead(..1) → put(..1) → plan → addUnit(..1) → log → SHARD-LOSS → tail(>0)=ok → done |
| `F4_missing_file_must_be_error` F4: with every fix on, a planned file can still vanish (plan from an unlogged version); missing = empty | I4_NoGapAtSeam | violated | 16 | 371,486 | re-run | register(inc 1) → log → append(b0) → seal(..1) → flushRead(..1) → flushRead(..1) → put(..1) → put(..1) → addUnit(..1) → plan → tail(>1)=ok → LEDGER-LOSS+REBUILD → addUnit(..1) → log → sweepOrphan → done |
| `F5_restart_without_timing` F5: untimed, a query attempt is refused once per discard | L2_RestartsBelow3 | violated | 30 | 185,978 | re-run | register(inc 1) → log → append(b0) → seal(..1) → append(b1) → seal(..2) → append(b2) → seal(..3) → flushRead(..1) → flushRead(..2) → put(..1) → put(..2) → plan → addUnit(..1) → flushRead(..3) → put(..3) → log → recorded(1) → discard(1) → tail(>0)=STALE → addUnit(..2) → log → recorded(2) → discard(2) → tail(>1)=STALE → addUnit(..3) → log → recorded(3) → discard(3) → tail(>2)=STALE |
| `literal_all` DESIGN 3.1 as written, all actions, all safety invariants | Safety | violated | 5 | 243 | re-run | register(inc 1) → append(b0) → LEDGER-LOSS+REBUILD → plan → done |
<!-- END TLC_LITERAL -->

### 2b. The compaction fix (D30) and the segment log, as built (2026-11-19)

**D30** (`compact.ts`, `janitor.ts` at 6488856, unchanged at 6ee76c8; configuration `D30`):
the sweep is modelled as `janitor.ts` runs it, three kinds of step any other step can come
between (list the tenant's objects with their `viz-inputs`; one `orphanCheck`; one delete
per doomed key), with **no clock**: no age floor at all, so nothing rests on an upload time.
Purge is delete, then forget. A compaction step adopts an existing object with its old
uploader and never deletes anything. Results (every safety property, shortest counterexample
first; "stopped" = every state reachable in at most that many steps was checked):

<!-- BEGIN BFS_D30 -->
| Experiment | Checked | Result | Steps | Distinct states | Time | Shortest counterexample |
|---|---|---|---|---|---|---|
| `D30_F13` F13's bounds (code of 2026-11-18, 1 compaction, sweeper on) with D30 | all safety | stopped: memory bound: stopped at 6,000,001 states; every state reachable in at most 23 steps checked, no violation |  | 6,000,001 | 336.1 s |  |
| `D30_F13x` F13's bounds with D30, no client retry, ≤ 2 sweep runs | all safety | stopped: memory bound: stopped at 6,000,001 states; every state reachable in at most 25 steps checked, no violation |  | 6,000,001 | 324.1 s |  |
| `D30_F14x` F14's bounds (two compaction steps at once, retention, ledger loss) with D30, the sweeper ON (F14 had it off), ≤ 2 sweep runs, the ledger log as built (two-step start) | all safety | stopped: memory bound: stopped at 19,000,001 states; every state reachable in at most 31 steps checked, no violation |  | 19,000,001 | 2186.8 s |  |
| `D30_F15x` F15's bounds (amended protocol, 2 flush Workers, shard loss + ledger loss) with D30's sweeper, no client retry, ≤ 2 sweep runs | all safety | stopped: memory bound: stopped at 6,000,003 states; every state reachable in at most 23 steps checked, no violation |  | 6,000,003 | 324.8 s |  |
| `D30_retries_faults` amended protocol + D30 + log as built: client retries + two flush Workers, ledger loss + shard loss | all safety | stopped: memory bound: stopped at 6,000,005 states; every state reachable in at most 21 steps checked, no violation |  | 6,000,005 | 349.5 s |  |
| `D30_maintenance_faults` amended + D30 + log as built: two compaction steps at once + retention + ledger loss + shard loss, no client retry | all safety | stopped: memory bound: stopped at 6,000,003 states; every state reachable in at most 22 steps checked, no violation |  | 6,000,003 | 372.8 s |  |
| `D30_maintenance_2LL` amended + D30 + log as built: two compaction steps at once + retention + two ledger losses, no client retry, one flush Worker, ≤ 2 sweep runs | all safety | stopped: memory bound: stopped at 6,000,001 states; every state reachable in at most 26 steps checked, no violation |  | 6,000,001 | 399.9 s |  |
| `D30_3batches` amended + D30 + log as built: 3 batches, ledger loss + shard loss + compaction, no client retry, ≤ 2 sweep runs | all safety | stopped: memory bound: stopped at 6,000,004 states; every state reachable in at most 20 steps checked, no violation |  | 6,000,004 | 265.5 s |  |
| `D30_2shards` amended + D30 + log as built: 2 shards, ledger loss + shard loss + compaction, no client retry, ≤ 2 sweep runs | all safety | stopped: memory bound: stopped at 6,000,001 states; every state reachable in at most 19 steps checked, no violation |  | 6,000,001 | 372.3 s |  |
| `D30_2tenants` amended + D30 + log as built: 2 tenants in one pooled shard sending identical bytes, ledger loss + shard loss + compaction, no client retry, ≤ 2 sweep runs | all safety | stopped: memory bound: stopped at 6,000,005 states; every state reachable in at most 19 steps checked, no violation |  | 6,000,005 | 402.7 s |  |
| `D30_variants` amended + D30 + log as built: two encoder outputs per segment, ledger loss + compaction + retention, no client retry, ≤ 2 sweep runs | all safety | stopped: memory bound: stopped at 6,000,003 states; every state reachable in at most 21 steps checked, no violation |  | 6,000,003 | 296.2 s |  |
| `D30_chain` amended + D30 + log as built: 3 batches, 2 compactions, so an output is an input of the next (the rule applied inductively), retention, ledger loss, no client retry, one flush Worker, no query, ≤ 2 sweep runs | all safety | stopped: memory bound: stopped at 6,000,005 states; every state reachable in at most 31 steps checked, no violation |  | 6,000,005 | 379.2 s |  |
| `W_chain_reachable` non-vacuity of D30_chain: a level-2 output (built from a compaction output) becomes live within its bounds | W_NoChainedOutputLive | **W_NoChainedOutputLive** violated | 27 | 651,781 | 47.9 s | register(inc 1) → drainPUT(v1) → regLogged → append(b0) → seal(..1) → append(b1) → seal(..2) → append(b2) → seal(..3) → list(inc1 1..1) → read(inc1 1..1) → put(1..1) → addUnit(inc1 1..1) → list(inc1 2..2) → read(inc1 2..2) → put(2..2) → addUnit(inc1 2..2) → list(inc1 3..3) → read(inc1 3..3) → put(3..3) → addUnit(inc1 3..3) → compRead → compPut → replace → compRead → compPut → replace |
| `D30_teeth_not_live_only` D30 teeth: an input counts as gone when it is merely not live (its object may still exist) | I11_LiveFilesReadable | **I11_LiveFilesReadable** violated | 27 | 406,920 | 24.7 s | register(inc 1) → drainPUT(v1) → regLogged → append(b0) → seal(..1) → append(b1) → seal(..2) → list(inc1 1..1) → read(inc1 1..1) → put(1..1) → addUnit(inc1 1..1) → list(inc1 2..2) → read(inc1 2..2) → put(2..2) → addUnit(inc1 2..2) → drainCommit → drainPUT(v2-v3) → compRead → expire(L0(s0 inc1 1..1)) → compPut → sweepList → sweepRead→doomed L1(L0(s0 inc1 1..1)+L0(s0 inc1 2..2)) → LEDGER-LOSS+rebuild → inc 2 → start: PUT base(inc 2) → start: commit(inc 2) → replace → sweep(L1(L0(s0 inc1 1..1)+L0(s0 inc1 2..2))) |
| `D30_teeth_absent_only` D30 with the live test dropped (absent from the listing alone): expected to hold, since an object is deleted only once its key can never be live | all safety | stopped: memory bound: stopped at 6,000,002 states; every state reachable in at most 31 steps checked, no violation |  | 6,000,002 | 277.7 s |  |
| `D30_teeth_read_first` D30 teeth: the sweep reads the ledger BEFORE it lists R2 | I11_LiveFilesReadable | **I11_LiveFilesReadable** violated | 25 | 247,867 | 10.2 s | register(inc 1) → drainPUT(v1) → regLogged → append(b0) → seal(..1) → append(b1) → seal(..2) → list(inc1 1..1) → read(inc1 1..1) → put(1..1) → addUnit(inc1 1..1) → list(inc1 2..2) → read(inc1 2..2) → put(2..2) → drainCommit → sweepRead → addUnit(inc1 2..2) → compRead → compPut → replace → drainPUT(v2-v4) → drainCommit → purge(L0(s0 inc1 2..2)) → sweepList → sweep(L1(L0(s0 inc1 1..1)+L0(s0 inc1 2..2))) |
| `D30_teeth_newer_unlogged` D30 teeth: a newer incarnation kills old flush files as soon as it is committed (no logged-watermark > 0 test); F15's bounds | I11_LiveFilesReadable | **I11_LiveFilesReadable** violated | 15 | 198,438 | 12.9 s | register(inc 1) → drainPUT(v1) → regLogged → append(b0) → seal(..1) → list(inc1 1..1) → read(inc1 1..1) → SHARD-LOSS → register(inc 2) → put(1..1) → sweepList → sweepRead→doomed L0(s0 inc1 1..1) → LEDGER-LOSS+rebuild → addUnit(inc1 1..1) → sweep(L0(s0 inc1 1..1)) |
| `D30_teeth_conflict_delete` D30 teeth: the step deletes its outputs on conflict again (F14 back); sweeper on | I11_LiveFilesReadable | **I11_LiveFilesReadable** violated | 21 | 122,006 | 6.2 s | append(b0) → seal(..1) → append(b1) → seal(..2) → list(inc1 1..1) → read(inc1 1..1) → put(1..1) → addUnit(inc1 1..1, registers) → list(inc1 2..2) → read(inc1 2..2) → put(2..2) → addUnit(inc1 2..2) → drainPUT(v1-v3) → compRead → compRead → expire(L0(s0 inc1 1..1)) → compPut → compPut → replace=conflict, output deleted → LEDGER-LOSS+rebuild → replace |
| `D30_teeth_purge_unlogged` D30 teeth: purge deletes a removed file before its removal is logged | I11_LiveFilesReadable | **I11_LiveFilesReadable** violated | 14 | 1,127 | 0.1 s | register(inc 1) → drainPUT(v1) → regLogged → append(b0) → seal(..1) → list(inc1 1..1) → read(inc1 1..1) → put(1..1) → addUnit(inc1 1..1) → drainCommit → drainPUT(v2) → expire(L0(s0 inc1 1..1)) → purge(L0(s0 inc1 1..1)) → LEDGER-LOSS+rebuild → inc 2 |
| `W_leak_behind_lost_flush` F16 witness: an unlisted compaction output kept because an input is an unlisted flush file of an incarnation its shard lost, which the sweep keeps (D30 + log as built, ledger loss + shard loss, compaction) | W_NoLeakBehindLostFlush | **W_NoLeakBehindLostFlush** violated | 19 | 819,601 | 71.4 s | register(inc 1) → drainPUT(v1) → regLogged → append(b0) → seal(..1) → append(b1) → seal(..2) → list(inc1 1..1) → list(inc1 2..2) → read(inc1 1..1) → put(1..1) → addUnit(inc1 1..1) → read(inc1 2..2) → SHARD-LOSS → put(2..2) → addUnit(inc1 2..2) → compRead → LEDGER-LOSS+rebuild → inc 2 → compPut |
<!-- END BFS_D30 -->

- **F13, F14 and F15 no longer occur.** At F14's bounds (two compaction steps at once,
  retention, ledger loss, the sweeper on, which F14's own run had off) no state reachable in
  31 steps violates anything (19 million states); F14's trace is 21 steps. F13's exact bounds
  (client retries, two flush Workers): 23 steps clean; its trace is 19. F15's bounds: 23
  steps clean; its trace is 17. Bounded depth, not exhaustive: each run stopped at its state
  cap (the machine's load average was 15–23 on 4 cores during this pass).
- **The whole safety suite with D30 and the segment log as built** (amended protocol
  otherwise): no violation among all states reachable in 21 steps with client retries and
  both faults, 22 with two compaction steps at once + retention + both faults, 26 with two
  ledger losses, 20 with 3 batches, 19 with 2 shards, 19 with 2 tenants sharing a shard, 21
  with two encoder outputs, and 31 with two compactions in a row (`D30_chain`: an output is
  itself compacted, which first happens at step 27, `W_chain_reachable`). 6 million states
  each, bounded-depth.
- **The recorded traces, replayed** (`results/REPLAY.md`): F13's and F15's stop at the sweep
  step, which D30 does not allow (the adopted output's inputs are live and present; the newer
  incarnation's logged watermark is 0); F14's runs to its end with `conflict` deleting
  nothing, and step A's `replace` lists a file whose object exists.
- **Each part of the rule is load-bearing** (teeth, each a counterexample): the step deleting
  on conflict again (F14, 21 steps, with the sweeper on); a newer incarnation counting before
  it has a logged unit (F15, 15 steps — shorter than F15's 17 because no age rule has to pass:
  the sweep judges the flush Worker's file dead, a rebuild rolls the registration back, the
  Worker's `addUnit` makes the file live, the sweep deletes it); "gone" meaning only "not
  live" (27 steps: the input's removal is unlogged, the sweep judges, a rebuild brings the
  input back, the identical step commits, the sweep deletes the live output); purge before the
  removal is logged (14). The order "list, then read the ledger" is load-bearing too
  (`D30_teeth_read_first`, 25 steps, no rebuild needed: the sweep reads the ledger before an
  input is admitted, the input is then admitted, compacted, the removal logged and purged; the
  listing taken afterwards shows the input absent, and the stale read says the output is not
  live: a live output is deleted). `janitor.ts` lists first, and its comment says why. The live test is not: with "absent from the listing" alone no
  state reachable in 31 steps violates anything (`D30_teeth_absent_only`, 6 million states),
  because an object is deleted only once its key can never be live; `janitor.ts` keeps both, which costs nothing.
- **Leaks (I11's no-leak half):** see `LEAK_*` in 2c and the finding **F16**.

**The segment log as built** (`LEDGER-LOG.md`, `ledger.ts` `startIncarnation`): the start is
two steps (PUT the base segment with If-None-Match, then commit; every request waits in
between; storage can be lost again in between), numbered max(newest in R2, the storage's own)
+ 1. Review S-1 (`design/reviews/segment-log-and-compaction.md`) is modelled as two more
steps, a rollback to the first-layout ledger (whose drain writes `{version}.json` objects into
the segment incarnation's prefix and advances `logged`, but not `logged_through`) and the
roll-forward (`maxRB`, `rbFix`).

<!-- BEGIN BFS_LOG -->
| Experiment | Checked | Result | Steps | Distinct states | Time | Shortest counterexample |
|---|---|---|---|---|---|---|
| `LOG_as_built` IMPL_PLANNED_fixed's bounds with the segment log as built (base PUT before the commit, two-step start, F10 fix, tombstones in the base) and the code at HEAD; F3 assumed; ≤ 2 sweep runs | all safety | stopped: memory bound: stopped at 6,000,002 states; every state reachable in at most 22 steps checked, no violation |  | 6,000,002 | 336.3 s |  |
| `LOG_as_built_2LL` as LOG_as_built, two ledger losses (F11 needed two), compaction, one flush Worker; ≤ 2 sweep runs | all safety | stopped: memory bound: stopped at 6,000,001 states; every state reachable in at most 25 steps checked, no violation |  | 6,000,001 | 275.4 s |  |
| `LOG_as_built_3LL` as LOG_as_built, three ledger losses, no compaction, one flush Worker; ≤ 2 sweep runs | all safety | holds (exhaustive) |  | 3,386,220 | 167.1 s |  |
| `LOG_as_built_faults` as LOG_as_built, + retention + shard loss, registration logged before writes (so F6(b) does not mask the log); ≤ 2 sweep runs | all safety | stopped: memory bound: stopped at 6,000,001 states; every state reachable in at most 20 steps checked, no violation |  | 6,000,001 | 230.2 s |  |
| `LOG_teeth_commit_first` segment log teeth: the incarnation commits before its base is in R2 (the plan before F11) | V_IncarnationNotReused | **V_IncarnationNotReused** violated | 7 | 693 | 0.1 s | append(b0) → seal(..1) → list(inc1 1..1) → read(inc1 1..1) → put(1..1) → addUnit(inc1 1..1, registers) → LEDGER-LOSS+rebuild (incarnation reused) |
| `LOG_teeth_retry_new_bounds` segment log teeth: a retried drain takes every pending row (F10) | AV_RebuildSucceeds | **AV_RebuildSucceeds** violated | 16 | 160,162 | 9.1 s | append(b0) → seal(..1) → append(b1) → seal(..2) → list(inc1 1..1) → list(inc1 2..2) → read(inc1 1..1) → put(1..1) → addUnit(inc1 1..1, registers) → read(inc1 2..2) → put(2..2) → drainPUT(v1-v2) → addUnit(inc1 2..2) → DRAIN-CRASH → drainPUT(v1-v3) → LEDGER-LOSS+rebuild REFUSED → inc 2 |
| `LOG_S1_rollback` review S-1, as built: one rollback to the first-layout ledger and back, one ledger loss, retention, compaction, registration logged before writes; ≤ 2 sweep runs | all safety | **I5_DiscardOnlyLogged** violated | 14 | 30,553 | 3.6 s | register(inc 1) → drainPUT(v1) → regLogged → append(b0) → seal(..1) → list(inc1 1..1) → read(inc1 1..1) → put(1..1) → addUnit(inc1 1..1) → drainCommit → RELEASE ROLLBACK: the first-layout ledger runs on segment storage → ledger first-layout drain: PUT change v2 as a per-change object → drainCommit → recorded(1) |
| `LOG_S1_rollback_I1` review S-1, as built, carried through to acknowledged-row loss; ≤ 2 sweep runs | I1_AckedIsDurable | **I1_AckedIsDurable** violated | 17 | 126,352 | 14 s | register(inc 1) → drainPUT(v1) → regLogged → append(b0) → seal(..1) → list(inc1 1..1) → read(inc1 1..1) → put(1..1) → addUnit(inc1 1..1) → drainCommit → RELEASE ROLLBACK: the first-layout ledger runs on segment storage → ledger first-layout drain: PUT change v2 as a per-change object → drainCommit → recorded(1) → discard(1) → RELEASE ROLL-FORWARD → LEDGER-LOSS+rebuild → inc 2 |
| `LOG_S1_rollback_I11` review S-1, as built, carried through to a listed file with no object (a removal the first-layout drain logged, purged, then undone by the rebuild); ≤ 2 sweep runs | I11_LiveFilesReadable | **I11_LiveFilesReadable** violated | 19 | 458,026 | 42.9 s | register(inc 1) → drainPUT(v1) → regLogged → append(b0) → seal(..1) → list(inc1 1..1) → read(inc1 1..1) → put(1..1) → addUnit(inc1 1..1) → drainCommit → drainPUT(v2) → drainCommit → RELEASE ROLLBACK: the first-layout ledger runs on segment storage → expire(L0(s0 inc1 1..1)) → ledger first-layout drain: PUT change v3 as a per-change object → drainCommit → RELEASE ROLL-FORWARD → purge(L0(s0 inc1 1..1)) → LEDGER-LOSS+rebuild → inc 2 |
| `LOG_S1_heal_1batch` review S-1 with fix (b), one batch, one ledger loss, one flush Worker (small enough to be exhaustive); ≤ 2 sweep runs | all safety | holds (exhaustive) |  | 130,718 | 5.2 s |  |
| `LOG_S1_heal` review S-1 with fix (b): on roll-forward an outbox that does not continue the segment log starts a new incarnation from SQLite; same bounds; ≤ 2 sweep runs | all safety | stopped: memory bound: stopped at 6,000,001 states; every state reachable in at most 23 steps checked, no violation |  | 6,000,001 | 330.6 s |  |
<!-- END BFS_LOG -->

- **V_IncarnationNotReused and every other property hold**: **exhaustively** with three
  ledger losses (`LOG_as_built_3LL`: 2 batches with retries, one flush Worker, no compaction,
  3.4 million states, depth 45); at IMPL_PLANNED_fixed's bounds (22 steps clean) and with two
  ledger losses and compaction (25 steps clean); the 7-step reuse of the plan as it
  stood (F11) is gone (`results/REPLAY.md`). With the base committed before it is in R2 the
  reuse comes back at once (`LOG_teeth_commit_first`, 7 steps), and a retried drain that takes
  new bounds makes the rebuild refuse (`LOG_teeth_retry_new_bounds`, F10).
- **S-1 is confirmed by the model** (`LOG_S1_rollback`): after a rollback the first-layout
  drain logs a change only as a per-change object, flush tells the shard `recorded` through it,
  and the segment rebuild would not read it: I5 fails in 14 steps (what the shard discarded is
  above what a rebuild keeps), the first step of the review's data loss; carried on, a ledger
  loss then loses acknowledged rows (`LOG_S1_rollback_I1`, I1 in 17 steps) and lists a file
  whose object the first-layout purge deleted (`LOG_S1_rollback_I11`, I11 in 19 steps). In the
  model, as in the review, the drain then stops with `LogFault` for good. With fix (b)
  (on roll-forward an outbox that does not continue the segment log starts a new incarnation
  from SQLite) no violation among all states reachable in 23 steps (`LOG_S1_heal`, 6 million
  states; exhaustive with one batch: `LOG_S1_heal_1batch`). Fix (a) alone (refuse a rebuild of
  an incarnation holding both layouts) would turn the silent loss into a refused rebuild; not
  modelled.

### 2c. The amended protocol, exhaustive

`AMENDED` (`bfs/run.ts`) = DESIGN + LEDGER-LOG as written + the fixes for F1 (registration
logged before writes, repeated when the ledger does not know the stream), F2 (sweeper as in
`janitor.ts`: not live, not tombstoned, below the logged watermark) with F15's correction (a
newer incarnation counts once its registration is logged), F6 (refuse an unknown stream named
by incarnation), F10 (a retried drain writes the same segment), F11 (base in R2 first),
F12 (flush reads bound to the incarnation), F13/F14 (step-unique compaction keys), and the
assumption that removes F3 (no client retry across a shard storage loss; *assumed*, not
fixed). The code fixed F13/F14 with D30 instead; the same suite with D30 and the segment log
as built is in 2b (`D30_*` rows). The `A_*` rows were recorded before this pass and not re-run
(their configuration is unchanged); the liveness and no-leak rows were run in this pass.

<!-- BEGIN BFS_AMENDED -->
| Run | Bounds | Checked | Result | Distinct states | Transitions | Depth | Wall time | P(collision) |
|---|---|---|---|---|---|---|---|---|
| `A_retries_faults` client retries + two flush Workers, ledger loss + shard loss | 1 tenant, 1 shard, 2 batches × ≤ 2 sends, ≤ 2 flush Workers and ≤ 1 compaction steps at once, 1 encoder output, ≤ 0 compaction / 0 retention / 1 ledger loss / 1 shard loss, 1 query, ≤ 2 refusals | all safety | stopped: memory bound: stopped at 4,000,004 states; every state reachable in at most 21 steps checked, no violation | 4,000,004 | 18,992,755 | 21 | 241.7 s | 4.3e-7 |
| `A_maintenance_faults` compaction (2 steps at once) + retention + ledger loss + shard loss, no client retry | 1 tenant, 1 shard, 2 batches × ≤ 1 sends, ≤ 2 flush Workers and ≤ 2 compaction steps at once, 1 encoder output, ≤ 1 compaction / 1 retention / 1 ledger loss / 1 shard loss, 1 query, ≤ 2 refusals | all safety | stopped: memory bound: stopped at 4,000,002 states; every state reachable in at most 22 steps checked, no violation | 4,000,002 | 16,708,394 | 22 | 216.1 s | 4.3e-7 |
| `A_3batches` 3 batches, ledger loss + shard loss, no client retry | 1 tenant, 1 shard, 3 batches × ≤ 1 sends, ≤ 2 flush Workers and ≤ 1 compaction steps at once, 1 encoder output, ≤ 0 compaction / 0 retention / 1 ledger loss / 1 shard loss, 1 query, ≤ 2 refusals | all safety | stopped: memory bound: stopped at 4,000,002 states; every state reachable in at most 21 steps checked, no violation | 4,000,002 | 17,738,142 | 21 | 166.4 s | 4.3e-7 |
| `A_2shards` 2 shards, ledger loss + shard loss + compaction, no client retry | 1 tenant, 2 shards, 2 batches × ≤ 1 sends, ≤ 2 flush Workers and ≤ 1 compaction steps at once, 1 encoder output, ≤ 1 compaction / 0 retention / 1 ledger loss / 1 shard loss, 1 query, ≤ 2 refusals | all safety | stopped: memory bound: stopped at 4,000,002 states; every state reachable in at most 18 steps checked, no violation | 4,000,002 | 15,538,809 | 18 | 152.2 s | 4.3e-7 |
| `A_2tenants` 2 tenants in one pooled shard sending identical bytes, ledger loss + shard loss, no client retry | 2 tenants, 1 shard, 2 batches × ≤ 1 sends, ≤ 2 flush Workers and ≤ 1 compaction steps at once, 1 encoder output, ≤ 0 compaction / 0 retention / 1 ledger loss / 1 shard loss, 1 query, ≤ 2 refusals | all safety | stopped: memory bound: stopped at 4,000,002 states; every state reachable in at most 18 steps checked, no violation | 4,000,002 | 18,169,174 | 18 | 222.4 s | 4.3e-7 |
| `LIVE_amended` amended protocol, ledger loss + shard loss + compaction (1 send per batch) | 1 tenant, 1 shard, 2 batches × ≤ 1 sends, ≤ 1 flush Workers and ≤ 1 compaction steps at once, 1 encoder output, ≤ 1 compaction / 0 retention / 1 ledger loss / 1 shard loss, 1 query, unbounded refusals | AG EF query done | stopped: memory bound: stopped at 3,000,001 states (depth 29); the graph is incomplete, so AG EF is NOT decided | 3,000,001 | 12,002,784 | 29 | 188.3 s | 2.4e-7 |
| `LIVE_amended_ll` amended protocol, ledger loss, compaction, no shard loss (1 send per batch) | 1 tenant, 1 shard, 2 batches × ≤ 1 sends, ≤ 1 flush Workers and ≤ 1 compaction steps at once, 1 encoder output, ≤ 1 compaction / 0 retention / 1 ledger loss / 0 shard loss, 1 query, unbounded refusals | AG EF query done | stopped: memory bound: stopped at 3,000,002 states (depth 36); the graph is incomplete, so AG EF is NOT decided | 3,000,002 | 15,730,125 | 36 | 371.4 s | 2.4e-7 |
| `LIVE_amended_sl` amended protocol, shard loss, no ledger loss, no compaction (1 send per batch) | 1 tenant, 1 shard, 2 batches × ≤ 1 sends, ≤ 1 flush Workers and ≤ 1 compaction steps at once, 1 encoder output, ≤ 0 compaction / 0 retention / 0 ledger loss / 1 shard loss, 1 query, unbounded refusals | AG EF query done | holds (exhaustive) | 162,812 | 640,662 | 38 | 24.5 s | 7.2e-10 |
| `LIVE_design` DESIGN as written, ledger loss + shard loss (1 send per batch) | 1 tenant, 1 shard, 2 batches × ≤ 1 sends, ≤ 1 flush Workers and ≤ 1 compaction steps at once, 1 encoder output, ≤ 0 compaction / 0 retention / 1 ledger loss / 1 shard loss, 1 query, unbounded refusals | AG EF query done | **LIVE_QueryCanComplete** violated in 5 steps | 1,124,318 | 4,573,766 | 36 | 98.6 s | 3.4e-8 |
| `LIVE_impl_V1` code of 2026-11-18 (tailRead ok/empty for a lost stream), ledger loss + shard loss, no compaction (1 send per batch) | 1 tenant, 1 shard, 2 batches × ≤ 1 sends, ≤ 1 flush Workers and ≤ 1 compaction steps at once, 1 encoder output, ≤ 0 compaction / 0 retention / 1 ledger loss / 1 shard loss, 1 query, unbounded refusals | AG EF query done | holds (exhaustive) | 233,906 | 924,430 | 40 | 24.3 s | 1.5e-9 |
| `LIVE_impl` code at HEAD: tailRead refuses an incarnation it lost, but nothing re-registers the stream; shard loss (1 send per batch) | 1 tenant, 1 shard, 2 batches × ≤ 1 sends, ≤ 1 flush Workers and ≤ 1 compaction steps at once, 1 encoder output, ≤ 0 compaction / 0 retention / 0 ledger loss / 1 shard loss, 1 query, unbounded refusals | AG EF query done | **LIVE_QueryCanComplete** violated in 8 steps | 43,849 | 160,307 | 34 | 6.7 s | 5.2e-11 |
| `LIVE_impl_F6_fixed` code at HEAD + F6 fixed completely (register before writes, so a refusing shard re-registers); ledger loss + shard loss (1 send per batch) | 1 tenant, 1 shard, 2 batches × ≤ 1 sends, ≤ 1 flush Workers and ≤ 1 compaction steps at once, 1 encoder output, ≤ 0 compaction / 0 retention / 1 ledger loss / 1 shard loss, 1 query, unbounded refusals | AG EF query done | holds (exhaustive) | 688,379 | 2,776,255 | 42 | 77.4 s | 1.3e-8 |
| `LEAK_D30_maintenance` no leak, D30 + log as built: compaction (2 steps at once), retention of every file, ledger loss, no client retry; sweep, purge and ledger start as single steps (they only delete; the graph must fit in memory) | 1 tenant, 1 shard, 2 batches × ≤ 1 sends, ≤ 1 flush Workers and ≤ 2 compaction steps at once, 1 encoder output, ≤ 1 compaction / 4 retention / 1 ledger loss / 0 shard loss, 0 query, unbounded refusals | AG EF no leak | stopped: memory bound: stopped at 3,000,002 states (depth 31); the graph is incomplete, so AG EF is NOT decided | 3,000,002 | 16,323,879 | 31 | 319.6 s | 2.4e-7 |
| `LEAK_D30_shardloss` no leak, D30 + log as built: shard loss, ledger loss, retention of every file, compaction, no client retry; sweep, purge and ledger start as single steps (they only delete; the graph must fit in memory) | 1 tenant, 1 shard, 2 batches × ≤ 1 sends, ≤ 1 flush Workers and ≤ 1 compaction steps at once, 1 encoder output, ≤ 1 compaction / 4 retention / 1 ledger loss / 1 shard loss, 0 query, unbounded refusals | AG EF no leak | stopped: memory bound: stopped at 3,000,002 states (depth 32); the graph is incomplete, so AG EF is NOT decided | 3,000,002 | 14,725,070 | 32 | 286.2 s | 2.4e-7 |
| `LEAK_V1_shardloss` no leak, the rules before D30 (age-swept outputs, committed newer incarnation): same bounds as LEAK_D30_shardloss; sweep, purge and ledger start as single steps (they only delete; the graph must fit in memory) | 1 tenant, 1 shard, 2 batches × ≤ 1 sends, ≤ 1 flush Workers and ≤ 1 compaction steps at once, 1 encoder output, ≤ 1 compaction / 4 retention / 1 ledger loss / 1 shard loss, 0 query, unbounded refusals | AG EF no leak | stopped: memory bound: stopped at 3,000,001 states (depth 32); the graph is incomplete, so AG EF is NOT decided | 3,000,001 | 14,861,377 | 32 | 284.7 s | 2.4e-7 |
| `LEAK_D30_ll` no leak, D30 + log as built: compaction, retention (2 removals), ledger loss, no shard loss; sweep, purge and ledger start as single steps (they only delete; the graph must fit in memory) | 1 tenant, 1 shard, 2 batches × ≤ 1 sends, ≤ 1 flush Workers and ≤ 1 compaction steps at once, 1 encoder output, ≤ 1 compaction / 2 retention / 1 ledger loss / 0 shard loss, 0 query, unbounded refusals | AG EF no leak | holds (exhaustive) | 1,640,059 | 10,097,949 | 56 | 172.4 s | 7.3e-8 |
| `LEAK_D30_sl` no leak, D30 + log as built: compaction, retention (2 removals), shard loss, no ledger loss; sweep, purge and ledger start as single steps (they only delete; the graph must fit in memory) | 1 tenant, 1 shard, 2 batches × ≤ 1 sends, ≤ 1 flush Workers and ≤ 1 compaction steps at once, 1 encoder output, ≤ 1 compaction / 2 retention / 0 ledger loss / 1 shard loss, 0 query, unbounded refusals | AG EF no leak | **LIVE_NoLeak** violated in 11 steps; left: L0(s0 inc1 1..2) (sweep keeps it) | 1,090,381 | 6,619,573 | 52 | 130.1 s | 3.2e-8 |
| `LEAK_V1_sl` no leak, the rules before D30: same bounds as LEAK_D30_sl; sweep, purge and ledger start as single steps (they only delete; the graph must fit in memory) | 1 tenant, 1 shard, 2 batches × ≤ 1 sends, ≤ 1 flush Workers and ≤ 1 compaction steps at once, 1 encoder output, ≤ 1 compaction / 2 retention / 0 ledger loss / 1 shard loss, 0 query, unbounded refusals | AG EF no leak | **LIVE_NoLeak** violated in 11 steps; left: L0(s0 inc1 1..2) (sweep keeps it) | 1,226,068 | 7,552,989 | 53 | 135.9 s | 4.1e-8 |
| `LEAK_D30_sl_comp` no leaked compaction output, D30 + log as built: compaction, retention (1 removal), ledger loss + shard loss; sweep, purge and ledger start as single steps (they only delete; the graph must fit in memory) | 1 tenant, 1 shard, 2 batches × ≤ 1 sends, ≤ 1 flush Workers and ≤ 1 compaction steps at once, 1 encoder output, ≤ 1 compaction / 1 retention / 1 ledger loss / 1 shard loss, 0 query, unbounded refusals | AG EF no leaked compaction output | **LIVE_NoLeakComp** violated in 19 steps; left: L0(s0 inc1 1..1) (sweep keeps it); L0(s0 inc1 2..2) (sweep keeps it); L1(L0(s0 inc1 1..1)+L0(s0 inc1 2..2)) (sweep keeps it) | 1,359,944 | 7,442,170 | 51 | 55 s | 5e-8 |
| `LEAK_V1_sl_comp` no leaked compaction output, the rules before D30: same bounds as LEAK_D30_sl_comp; sweep, purge and ledger start as single steps (they only delete; the graph must fit in memory) | 1 tenant, 1 shard, 2 batches × ≤ 1 sends, ≤ 1 flush Workers and ≤ 1 compaction steps at once, 1 encoder output, ≤ 1 compaction / 1 retention / 1 ledger loss / 1 shard loss, 0 query, unbounded refusals | AG EF no leaked compaction output | holds (exhaustive) | 1,860,278 | 10,440,988 | 54 | 83.3 s | 9.4e-8 |
<!-- END BFS_AMENDED -->

`viz.qnt`, amended protocol (`FIXED` in `experiments.mjs`), TLC. Common bounds: 1 shard,
2 batches, ≤ 2 sends per batch, ≤ 2 flush Workers in flight and ≤ 3 flush attempts in total,
≤ 1 compaction, ≤ 1 retention removal, ≤ 1 ledger storage loss, ≤ 1 shard storage loss,
1 query with ≤ 2 refusals, 1 encoder variant:

<!-- BEGIN TLC_FIXED -->
| Run | Bounds that differ from the common ones | Checked | Result | Distinct states | States generated | Depth | Wall time | Workers | P(fingerprint collision) | Run |
|---|---|---|---|---|---|---|---|---|---|---|
| `fixed_1shard` | — | Safety | holds, exhaustive | 11,584,656 | 68,176,316 | 45 | 398.2 s | auto (4) | 3.6E-5 | earlier pass only |
| `fixed_1shard_variants` | 2 encoder variants, 0 shard losses, 0 retention removals | Safety | holds, exhaustive | 1,872,496 | 13,614,670 | 38 | 85.6 s | auto (4) | 1.2E-6 | earlier pass only |
| `fixed_1shard_3batches` | 3 batches, 0 shard losses, 0 retention removals | Safety | holds, exhaustive | 4,088,964 | 30,737,756 | 44 | 208.8 s | auto (4) | 5.9E-6 | earlier pass only |
| `fixed_2shards` | 2 shards, 0 retention removals, 2 flush attempts | Safety | holds, exhaustive | 2,821,410 | 14,689,338 | 42 | 162 s | auto (4) | 1.8E-6 | earlier pass only |
| `fixed_3batches_shardloss` | 3 batches, 0 retention removals, 0 compactions | Safety | holds, exhaustive | 7,312,626 | 42,169,510 | 41 | 405.5 s | auto (4) | 1.4E-5 | earlier pass only |
| `fixed_2ledgerlosses` | 2 ledger losses, 0 shard losses, 0 retention removals | Safety | holds, exhaustive | 367,455 | 2,398,388 | 40 | 27.9 s | auto (4) | 4.0E-8 | earlier pass only |
| `fixed_2queries` | 0 shard losses, 0 compactions, 2 queries | Safety | holds, exhaustive | 715,474 | 4,814,954 | 37 | 39.8 s | auto (4) | 1.6E-7 | earlier pass only |
| `fixed_timing_no_restart` | 0 ledger losses, 0 shard losses, timing assumption `retain` | L2_NoRestart | holds, exhaustive | 391,137 | 2,848,430 | 36 | 39.9 s | auto (4) | 5.2E-8 | earlier pass only |
<!-- END TLC_FIXED -->

Not vacuous: in the amended `viz.qnt` each of these is reachable (TLC, shortest path):

<!-- BEGIN TLC_WITNESS -->
| Witness (reachable in the amended protocol) | Steps to reach | Distinct states | Time | Run |
|---|---|---|---|---|
| `W_stale` | 12 | 71,761 | 16 s | earlier pass only |
| `W_mismatch` | 4 | 37 | 12.6 s | earlier pass only |
| `W_fileMissing` | 16 | 1,149,834 | 66.5 s | earlier pass only |
| `W_sweep` | 11 | 27,923 | 13 s | earlier pass only |
| `W_deleteRetired` | 19 | 4,375,744 | 253.3 s | earlier pass only |
| `W_replaceConflict` | 16 | 1,100,630 | 74.2 s | earlier pass only |
| `W_reRegister` | 3 | 17 | 11.4 s | earlier pass only |
| `W_addUnitReplay` | 9 | 3,376 | 12.8 s | earlier pass only |
| `W_fullQuery` | 23 | 2,468,241 | 195.4 s | earlier pass only |
| `W_queryAfterShardLoss` | 10 | 5,996 | 18.9 s | earlier pass only |
<!-- END TLC_WITNESS -->

Larger bounds, by random simulation only (not exhaustive):

<!-- BEGIN TLC_SIM -->
| Run | Bounds | Checked | Runs | Trace length | Result | Wall time | Runs that reached … | Run |
|---|---|---|---|---|---|---|---|---|
| `sim_fixed_big` | 2 shards, 4 batches, ≤ 3 sends, 2 variants, ≤ 8 flushes, 3 compactions, 2 retention removals, 2 ledger losses, 2 shard losses, 4 queries | Safety | 60,000 | ≤ 120 (longest 110, mean 68) | no violation found (simulation, not exhaustive) | 1416.8 s | queryDone: 58986, queryDoneAfterDiscard: 39776, ledgerRebuilt: 58594, shardLost: 60000, compacted: 298, queryRefused: 42845 | earlier pass only |
| `sim_fixed_maintenance` | 2 shards, 4 batches, ≤ 2 sends, 1 variants, ≤ 8 flushes, 4 compactions, 2 retention removals, 1 ledger losses, 0 shard losses, 4 queries | Safety | 40,000 | ≤ 120 (longest 89, mean 54) | no violation found (simulation, not exhaustive) | 448.2 s | queryDone: 40000, queryDoneAfterDiscard: 25425, ledgerRebuilt: 35700, shardLost: 0, compacted: 119, queryRefused: 1092 | earlier pass only |
| `sim_literal_big` | 2 shards, 4 batches, ≤ 3 sends, 2 variants, ≤ 8 flushes, 3 compactions, 2 retention removals, 2 ledger losses, 2 shard losses, 4 queries | Safety | 60,000 | ≤ 120  | violated (random, unminimised 32-step trace) | 4 s | queryDone: 14, queryDoneAfterDiscard: 0, ledgerRebuilt: 12, shardLost: 14, compacted: 0, queryRefused: 4 | earlier pass only |
<!-- END TLC_SIM -->

Total: <!-- BEGIN TOTAL -->
412 minutes of wall time in total (sum over all runs recorded in results/)
<!-- END TOTAL -->

## Findings

Ordered by severity. "Trace" is the shortest counterexample the explicit-state checker found
(step by step in `results/BFS.md`; the `viz.qnt`/TLC trace, where there is one, in
`results/RESULTS.md`). Findings against the design quote the sentence; findings against the
code name the file. F1–F9 were found by the earlier pass on `viz.qnt` and are re-confirmed by
the second checker (F4, F5, F7 by TLC only); F10–F15 are new; F16 is against D30 (2026-11-19).

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
- **As built** the registration rollback does not hide rows for a fixed shard map: `flush.ts`
  registers lazily and the coordinator asks every pool shard the ledger does not know, from
  sequence 0 (`LIVE_impl_V1`, the code of 2026-11-18, holds). A map change, which moves keys
  to shards outside the plan, would bring it back. Lazy registration is also what leaves
  F6(b) and, since `tailRead` refuses a lost incarnation, the liveness gap `LIVE_impl` (F6).
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
- **Trace** (`F14_impl_comp_conflict_delete`, 21 steps): units for batches 0 and 1 admitted and
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
  as `compKey: 'unique'` (a never-reused step id); `DESIGN_7` and the `A_*` runs check it.
- **Status: fixed in code by D30** (`DECISIONS.md`), not by step-unique keys: a step deletes
  nothing, and the sweep deletes an output only once an input is absent and not live. Checked
  in 2b (`D30_F14x`: 31 steps clean, sweeper on; the trace replays to its end without a
  violation; `D30_teeth_conflict_delete` brings it back). Code test: `compact/test/compact.test.ts`
  "spec F14".

### F12 (major, code: `shard/src/shard.ts` with lazy registration) — A flush that spans a shard storage loss files the new incarnation's rows under the old one

- **Code.** `pendingSegments` labels segments with the current incarnation; `readSegment(tenant,
  seqLo)` takes no incarnation and returns whichever stream holds that `seqLo` now; `flush.ts`
  checks only the count and the sequence numbers.
- **Trace** (`F12_impl_read_unbound`, 13 steps): batch 0
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
- **Status: fixed in code** (`shard.ts` `readSegment(tenant, seqLo, incarnation, seqHi)`,
  used so by `flush.ts`; code tests "spec F12" in `shard/test/review.test.ts` and
  `flush/test/flush.test.ts`). The as-built configuration has `readBound`.

### F6 (major, code: `shard/src/shard.ts`, and lazy registration) — `tailRead` answers "ok, nothing" for a stream the shard no longer holds

- **Code.** `if (!s) return { status: 'ok', incarnation, through: aboveSeq, batches: [] }`.
  DESIGN says what a recreated shard does before *writes*, not what it answers to *reads*
  (draft-3 review, finding 8). Two forms:
- **(a) A registered stream** (guard (n), 15 steps; TLC `F6_unknown_stream_reads_empty`, 12):
  batch 0 acknowledged and sealed → a query plans (watermark inc 1 @ 0) → the unit for batch 0
  is admitted and logged → the shard loses its storage → the tail read "inc 1, above 0" gets
  `ok`, nothing → the query completes without batch 0 (I4), though batch 0 is safe in a file
  the plan predates.
- **(b) As built, an unregistered stream** (`F6_impl_unknown_stream`, 11 steps; the shortest
  violation of the code as built, peel step `IMPL_1`): the stream's first segment is flushed but not yet admitted when the query plans,
  so the plan has no watermark for that shard and the coordinator asks it with incarnation 0
  → the unit is admitted and logged → the shard loses its storage → "incarnation 0, above 0"
  gets `ok`, nothing → batch 0 missed (I4). The shard cannot tell "never held this tenant"
  from "lost it", so no answer to incarnation 0 is right: this form exists only because
  registration is lazy.
- **Fix.** Register before accepting writes (F1's fix, applied to `shard.ts`): then an
  unregistered stream has no acknowledged rows and need not be asked, and a stream the shard
  does not hold is answered `incarnation_mismatch(0)`, never `ok`. **Refusing without
  re-registering is not enough:** with refusal alone (`LIVE_impl`) a state is reachable from
  which no query ever completes (the tenant sends nothing more to that shard, nothing recreates
  the stream, the ledger keeps naming the lost incarnation); with registration the refusing
  shard re-registers and the next plan names the new incarnation (`LIVE_impl_F6_fixed`).
- **Status at 6488856 (= 6ee76c8): (a) fixed, (b) not.** `shard.ts` `tailRead` now refuses
  an incarnation it does not hold (review R-10), but still answers `ok`/empty to incarnation
  0, which is what the coordinator sends for a stream the ledger has not registered, and
  registration is still lazy. `F6b_impl_now` and the as-built peel (`IMPL_1_as_built`,
  `IMPL_2_assume_F3`) find (b) at 11 steps: a query plans before the stream's first unit is
  admitted → the unit is admitted and logged → the shard loses its storage → "incarnation 0,
  above 0" is `ok`, nothing → batch 0, safe in a file the plan predates, is missing from that
  query's answer (I4). One wrong answer, not lost data; silent. Rare (a shard storage loss
  inside one query's window, on a stream's first unit). And the refusal of (a) without
  re-registration is the liveness gap above, now in the code (`LIVE_impl`). Both go with
  registration before writes (`IMPL_3_fix_F6b`, `LIVE_impl_F6_fixed`).
- **Proposed fix, checked:** variant R2 under "Proposed fixes" (registration logged before
  the first acknowledged write; a shard asked about an incarnation it lost starts and registers
  a fresh one). A registration that is only committed does not close F6(b) (R1: I4 in 15 steps
  through a ledger rebuild).

### F10 (major in the plan as it stood; fixed during this work: `contracts/LEDGER-LOG.md`, `ledger.ts`) — A retried drain writes an overlapping segment; a strict rebuild then refuses the log

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
  `drainRetrySame`; passes). **Status:** LEDGER-LOG.md now says exactly this, and `ledger.ts`
  `nextSegment`/`drainNow` implement it (bounds in `meta`, `storage.sync()` before the PUT,
  a record whose rows are gone stops the drain). Checked by reading; the as-built runs model it.

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
- **Status: fixed in code by D30**: no deletion depends on an upload time. Checked in 2b with no
  clock at all (`D30_F13`, `D30_F13x`; the trace stops at its sweep step). Code tests:
  `compact/test/compact.test.ts`, review R-2.

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
  `sweepIncLogged`; `DESIGN_7` checks it.
- **Status: fixed in code** (`janitor.ts` `flushFileState`): a newer incarnation counts only
  once its logged watermark is above 0, which proves its registration is logged (a unit's
  version is above its stream's registration and the log is a prefix). Checked in 2b
  (`D30_F15x`, 23 steps clean, no clock); without the "> 0" the finding comes back in 15
  steps with no age rule needed (`D30_teeth_newer_unlogged`). Code test:
  `janitor/test/janitor.test.ts` "spec F15". Cost: F16 (b).

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
  is a livelock. With bounded ingest AG EF holds (`LIVE_amended_sl`, whole graph, with a shard
  loss; with a ledger loss and compaction the graph passed the 3-million cap, undecided:
  `LIVE_amended`, `LIVE_amended_ll`), and with the rule "a segment
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

### F16 (minor, D30: `janitor.ts` + `compact.ts`) — An unlisted compaction output built on a never-swept flush file is never deleted either

- **Code.** Since D30 the sweep deletes an unlisted output only once one of its inputs is
  absent from R2. A flush file of a shard incarnation that was lost before its unit stayed
  admitted is kept for ever (`pending_unit`) while the ledger still names that incarnation
  (or a newer one whose logged watermark is 0). That flush-file leak is older than D30: the
  same 11-step trace leaks under both rules (`LEAK_D30_sl`, `LEAK_V1_sl`: a flush Worker
  PUTs, the shard loses its storage, the Worker dies; the tenant writes nothing more there).
  D30 adds the outputs built on such a file: they are kept as long as it is.
- **Witness** (`W_leak_behind_lost_flush`, 19 steps): units 1..1 and 2..2 admitted, not yet
  logged → a compaction step reads both → the shard loses its storage (rows above the logged
  watermark: a declared loss) → the ledger loses its storage; the rebuild drops both
  admissions → the step PUTs its output. The two flush files and the output are unlisted; the
  sweep keeps both flush files (the ledger's incarnation of the stream is still 1, logged
  watermark 0), so it keeps the output. Before D30 the output went by age.
- **Decided on the whole graph:** with compaction, one retention removal, a ledger loss and a
  shard loss, `LEAK_D30_sl_comp` finds a state from which no continuation deletes the output
  (the same 19 steps; 1.4 million states), and with the rules before D30 every output is
  always eventually deleted (`LEAK_V1_sl_comp` holds, 1.9 million states). So this leak is
  what D30 adds; the flush-file leak under it is older.
- **Bound.** The objects in flight when a shard loss coincides with a ledger rollback, for
  as long as the tenant writes nothing to that shard: the next write starts a new
  incarnation, its first logged unit makes the old files dead, and the outputs follow.
  Also kept for ever, by design: an output whose `viz-inputs` cannot be read (written before
  D30, or in a newer format: `unknown_inputs`). No leak without a shard loss:
  `LEAK_D30_ll` (compaction, retention, ledger loss) holds, the whole graph checked.
- **Fix (optional).** Report `pending_unit` objects older than a day in the sweep's result
  and the maintenance report, so an operator sees them; deleting them needs the shard's word
  that it no longer holds the incarnation, which the sweep does not ask today.
- **Proposed fix, checked:** under "Proposed fixes": the janitor asks the shard
  (`ensureStream`), a shard that lost the stream registers a fresh incarnation, and the sweep
  counts a newer incarnation once its registration is logged (`orphanCheck` reports the logged
  incarnation). Closes this leak and the older flush-file leak without the tenant writing
  again; F15 stays fixed.

### F11 (minor in the plan as it stood; fixed during this work) — Without `base.json` a ledger incarnation number can be reused

- LEDGER-LOG.md: "The first change of an incarnation is its base. There is no separate
  `base.json`." The base then reaches R2 only with the first drain. Trace
  (`F11_incarnation_reused`, 2 steps): a ledger commits a change → loses its storage before any
  drain → R2 holds nothing of that incarnation, so the restarted ledger takes the same number
  and re-issues the same versions with other content. DESIGN §4.3's "versions are never reused"
  fails. Only in-memory comparisons are affected (the coordinator's two-plan check, plan
  caches); the publisher reads only R2. **Fix:** "the base is in R2 before the incarnation
  commits anything". **Status:** LEDGER-LOG.md now requires the base segment to be written
  alone before the incarnation commits or serves anything, and `ledger.ts` does so.

### F9 (minor) — A ledger rebuild can undo retention

- An `expire` committed but not logged is rolled back by a rebuild; the files are live again
  until retention re-runs (`viz.qnt`, and the first steps of F14). DESIGN should say retention
  re-runs after a rebuild, and erasure deadlines count from the logged removal.

## Proposed fixes: registration before writes (F6, F6(b)) and the lost-incarnation leak (F16)

**Status: built (2026-11-19), as R2 with the F16 fix and the review's changes:
`design/DECISIONS.md` D61; the code and its tests by model trace in `shard/README.md`
("Registration before writes", "Rollout"), `ledger/`, `flush/` and `janitor/README.md`;
the review's dispositions in `design/REVIEW.md`. On in production only from the release after
edge maps the new refusal (`shard/README.md`, "Rollout").** The text below is the proposal as
it was checked. Configurations: `R1`–`R4`,
`F16FIX` and `PROPOSED` in `bfs/run.ts`; model options `reg: 'committed'`, `regOnRead`,
`regOnSweep`, `sweepNewerReg`, `lostEmpty`, `recheck` in `bfs/model.ts` (all optional: every
configuration recorded before them is unchanged, checked by re-running nine of them, after the last
change to the model, to the same state counts and trace lengths).

### What has to become true

Three statements, each false in the code as built:

1. **Every plan names every stream that holds acknowledged rows** (or a newer incarnation of
   it). Then a shard asked about a stream the plan does not name can answer "nothing" and be
   right, which is what F6(b) needs: as built the coordinator asks such a shard with
   incarnation 0 and a shard that lost its storage answers `ok`, empty. Lazy registration
   breaks the statement (F6(b)); so does a registration that is only *committed*, because a
   ledger rebuild rolls it back (R1 below, 15 steps). A registration in the **logged** prefix
   survives every rebuild.
2. **A query that names an incarnation the shard has lost can finish.** Either something makes
   the shard start and register a fresh incarnation, which the next plan names, or the
   coordinator, told of the loss before its current plan, takes that stream's tail as empty.
   As built nothing does either (`LIVE_impl`, 8 steps).
3. **The ledger learns, durably, that an incarnation is gone, even if the tenant never writes
   there again** (F16). Then the sweep can call that incarnation's unlisted flush files dead,
   and D30 lets the compaction outputs built on them follow.

Statements 1 and 2 are what "registration before writes" has to deliver; the variants differ
in how. Statement 1 can also be obtained after the fact, by the coordinator (R4).

### The variants

All four keep what is built: the shard creates the incarnation (`newIncarnation`, a stream
row), `registerStream` is idempotent and refuses a lower incarnation, `addUnit` admits an
unknown stream only at `seqLo = 1`, and `flush.ts` registers on `incarnation_mismatch` (both
paths kept for shards of earlier releases during a rolling upgrade; in R2 and R3 they are
unreachable for shards of this release). "A round trip" is one Durable Object RPC from the
shard to the tenant's ledger: measured on Cloudflare at 15–47 ms from a Worker to a ledger
(`spikes/s4-ledger-scale/`, one writer), not measured from a shard.

| | R1: committed | R2: logged, shard re-registers | R3: logged, coordinator settles | R4: committed + re-check |
|---|---|---|---|---|
| Who registers what with whom | the shard: `registerStream({shard: its name, incarnation})` with `LEDGER.idFromName(tenant)` | same | same | same |
| When | before it acknowledges the first append of a new stream (first use, or after a storage loss) | before it acknowledges ANY append of a stream whose registration it has not seen logged; each attempt repeats the call (which re-registers if a ledger rebuild lost it) | as R2 | as R1 |
| What it needs from the ledger | the commit (the call's answer) | the registration in the ledger's **logged** prefix (`registerStream` answers `logged: true`) | as R2 | as R1 |
| An append before that | waits for the one round trip (nothing acknowledged before the answer; a failed call: `backpressure`, nothing stored) | refused at once: `backpressure`, scope `registering`, Retry-After 0.5 s, nothing stored; the shard never holds an append across the ledger's R2 write | as R2 | as R1 |
| `tailRead` naming an incarnation the shard does not hold | creates a fresh incarnation, registers it, answers `incarnation_mismatch(fresh)` | same | `incarnation_mismatch(0)`, as built (no registration on the read path) | as R1 |
| `tailRead` with incarnation 0, no stream | `ok`, empty (as built) | same | same | same |
| Coordinator | as built: a newer incarnation is learned and the attempt re-planned; the next plan names it, or the learned one is read from 0 | as built | **new**: remembers per shard the newest incarnation the shard said it does not hold; a later plan that names nothing newer gets an empty tail from that shard (everything of the stream the ledger has is in that plan's files; the rest was lost with the shard, a declared loss) | **new**: after its tail reads, if it read any shard the plan did not name, it reads the ledger's watermarks once more (`plan` with an empty range); if one of those shards is now registered, the attempt is refused and re-planned |
| Re-registration after a shard storage loss, triggered by | the next append, or a tail read naming the lost incarnation | the same, or the janitor (F16 fix) | the next append only (or the janitor, with the F16 fix) | as R1 |
| Acknowledgement path, per stream lifetime | 1 round trip on the first append | 1 + k round trips, k = refused attempts until the drain has logged the registration (drain 200 ms after the commit + one segment PUT, 180–494 ms measured on Cloudflare, at most 1,025 ms seen; with Retry-After 0.5 s, k = 1–2, 3 at the slowest PUT seen): the first acknowledgement of a stream comes 0.5–1.5 s after its first append (**modelled** from those measured parts, not measured end to end) | as R2 | as R1 |
| Acknowledgement path, per append after that | 0 | 0 | 0 | 0 |
| R2 PUT on any acknowledgement path | no | no | no | no |
| Read path | as built | as built; one shard→ledger round trip inside the first tail read after a loss | one refused attempt and re-plan per query while the ledger names a lost incarnation (per isolate if cached; not modelled) | +1 ledger round trip per query attempt that read a shard the plan did not name |
| New dependency | a new stream needs the ledger to commit | a new stream needs the ledger to **log**: while the tenant's ledger cannot write R2 a new stream takes no writes (fails closed, retryable) | as R2 | as R1 |

### Results

Every run on the code as built (`IMPL`: D30, the segment log as built, `readSegment` bound,
`tailRead` refusing a named incarnation it does not hold) with F3 assumed away, as `IMPL_3`.
"Stopped" = every state reachable within that many steps checked, no violation (bounded
depth, not exhaustive). Liveness rows decide AG EF on the whole graph.

<!-- BEGIN BFS_PROPOSED -->
| Experiment | Checked | Result | Steps | Distinct states | Depth | Time | Shortest counterexample |
|---|---|---|---|---|---|---|---|
| `R1_safety` R1 (registration committed before writes): client retries, two flush Workers, 1 compaction, 1 retention removal, ledger loss + shard loss | all safety | **I4_NoGapAtSeam** violated | 15 | 855,875 | 15 | 47.4 s | register(inc 1) → append(b0) → seal(..1) → list(inc1 1..1) → read(inc1 1..1) → put(1..1) → LEDGER-LOSS+rebuild → inc 2 → start: PUT base(inc 2) → start: commit(inc 2) → plan → addUnit(inc1 1..1, registers) → drainPUT(v1-v2) → SHARD-LOSS → tail(inc0 >0)=∅ → done{} |
| `LIVE_R1_sl` R1 (registration committed before writes): shard loss (1 send per batch) | AG EF query done | holds (exhaustive) |  | 315,394 | 36 | 17.3 s |  |
| `LIVE_R1_llsl` R1 (registration committed before writes): ledger loss + shard loss (1 send per batch) | AG EF query done | holds (exhaustive) |  | 1,167,703 | 40 | 54.3 s |  |
| `R2_safety` R2 (registration logged before writes; shard registers on a read naming a lost incarnation): client retries, two flush Workers, 1 compaction, 1 retention removal, ledger loss + shard loss | all safety | stopped: memory bound: stopped at 4,000,002 states; every state reachable in at most 19 steps checked, no violation |  | 4,000,002 | 19 | 159.3 s |  |
| `R2_2shards` R2 (registration logged before writes; shard registers on a read naming a lost incarnation): 2 shards, ledger loss + shard loss + compaction, no client retry, ≤ 2 sweep runs | all safety | stopped: memory bound: stopped at 4,000,003 states; every state reachable in at most 18 steps checked, no violation |  | 4,000,003 | 18 | 150.9 s |  |
| `R2_2tenants` R2 (registration logged before writes; shard registers on a read naming a lost incarnation): 2 tenants in one pooled shard sending identical bytes, ledger loss + shard loss + compaction, no client retry, ≤ 2 sweep runs | all safety | stopped: memory bound: stopped at 4,000,002 states; every state reachable in at most 18 steps checked, no violation |  | 4,000,002 | 18 | 186.2 s |  |
| `LIVE_R2_sl` R2 (registration logged before writes; shard registers on a read naming a lost incarnation): shard loss (1 send per batch) | AG EF query done | holds (exhaustive) |  | 156,911 | 38 | 7.2 s |  |
| `LIVE_R2_llsl` R2 (registration logged before writes; shard registers on a read naming a lost incarnation): ledger loss + shard loss (1 send per batch) | AG EF query done | holds (exhaustive) |  | 667,064 | 42 | 24.2 s |  |
| `R3_safety` R3 (registration logged before writes; coordinator settles a lost incarnation): client retries, two flush Workers, 1 compaction, 1 retention removal, ledger loss + shard loss | all safety | stopped: memory bound: stopped at 4,000,001 states; every state reachable in at most 20 steps checked, no violation |  | 4,000,001 | 20 | 207.1 s |  |
| `R3_2shards` R3 (registration logged before writes; coordinator settles a lost incarnation): 2 shards, ledger loss + shard loss + compaction, no client retry, ≤ 2 sweep runs | all safety | stopped: memory bound: stopped at 4,000,001 states; every state reachable in at most 18 steps checked, no violation |  | 4,000,001 | 18 | 157.1 s |  |
| `R3_2tenants` R3 (registration logged before writes; coordinator settles a lost incarnation): 2 tenants in one pooled shard sending identical bytes, ledger loss + shard loss + compaction, no client retry, ≤ 2 sweep runs | all safety | stopped: memory bound: stopped at 4,000,001 states; every state reachable in at most 19 steps checked, no violation |  | 4,000,001 | 19 | 266.5 s |  |
| `LIVE_R3_sl` R3 (registration logged before writes; coordinator settles a lost incarnation): shard loss (1 send per batch) | AG EF query done | holds (exhaustive) |  | 152,052 | 38 | 8.6 s |  |
| `LIVE_R3_llsl` R3 (registration logged before writes; coordinator settles a lost incarnation): ledger loss + shard loss (1 send per batch) | AG EF query done | holds (exhaustive) |  | 645,027 | 42 | 35.7 s |  |
| `R4_safety` R4 (registration committed before writes; coordinator re-checks unregistered shards after its tail reads): client retries, two flush Workers, 1 compaction, 1 retention removal, ledger loss + shard loss | all safety | stopped: memory bound: stopped at 4,000,001 states; every state reachable in at most 16 steps checked, no violation |  | 4,000,001 | 16 | 224.4 s |  |
| `R4_2shards` R4 (registration committed before writes; coordinator re-checks unregistered shards after its tail reads): 2 shards, ledger loss + shard loss + compaction, no client retry, ≤ 2 sweep runs | all safety | stopped: memory bound: stopped at 4,000,002 states; every state reachable in at most 15 steps checked, no violation |  | 4,000,002 | 15 | 185 s |  |
| `R4_2tenants` R4 (registration committed before writes; coordinator re-checks unregistered shards after its tail reads): 2 tenants in one pooled shard sending identical bytes, ledger loss + shard loss + compaction, no client retry, ≤ 2 sweep runs | all safety | stopped: memory bound: stopped at 4,000,002 states; every state reachable in at most 15 steps checked, no violation |  | 4,000,002 | 15 | 177.7 s |  |
| `LIVE_R4_sl` R4 (registration committed before writes; coordinator re-checks unregistered shards after its tail reads): shard loss (1 send per batch) | AG EF query done | holds (exhaustive) |  | 446,490 | 37 | 26.8 s |  |
| `LIVE_R4_llsl` R4 (registration committed before writes; coordinator re-checks unregistered shards after its tail reads): ledger loss + shard loss (1 send per batch) | AG EF query done | holds (exhaustive) |  | 1,641,569 | 41 | 96.4 s |  |
| `F6b_bounds_R1` F6(b)'s bounds (code as built, shard loss) with R1 (registration committed before writes) | I4_NoGapAtSeam | stopped: memory bound: stopped at 4,000,001 states; every state reachable in at most 19 steps checked, no violation |  | 4,000,001 | 19 | 294.5 s |  |
| `F6b_bounds_R2` F6(b)'s bounds (code as built, shard loss) with R2 (registration logged before writes; shard registers on a read naming a lost incarnation) | I4_NoGapAtSeam | stopped: memory bound: stopped at 4,000,002 states; every state reachable in at most 23 steps checked, no violation |  | 4,000,002 | 23 | 393.4 s |  |
| `F6b_bounds_R3` F6(b)'s bounds (code as built, shard loss) with R3 (registration logged before writes; coordinator settles a lost incarnation) | I4_NoGapAtSeam | stopped: memory bound: stopped at 4,000,003 states; every state reachable in at most 23 steps checked, no violation |  | 4,000,003 | 23 | 400.5 s |  |
| `F6b_bounds_R4` F6(b)'s bounds (code as built, shard loss) with R4 (registration committed before writes; coordinator re-checks unregistered shards after its tail reads) | I4_NoGapAtSeam | stopped: memory bound: stopped at 4,000,002 states; every state reachable in at most 18 steps checked, no violation |  | 4,000,002 | 18 | 267.1 s |  |
| `LIVE_R2_teeth_no_read_trigger` R2 teeth: nothing registers a fresh incarnation on a read (only a write does): shard loss | AG EF query done | **LIVE_QueryCanComplete** violated | 6 | 143,799 | 38 | 6.8 s | register(inc 1) → drainPUT(v1) → regLogged → append(b0) → append(b1) → SHARD-LOSS |
| `LIVE_R3_teeth_no_settle` R3 teeth: the coordinator does not settle a lost incarnation: shard loss | AG EF query done | **LIVE_QueryCanComplete** violated | 6 | 143,799 | 38 | 6 s | register(inc 1) → drainPUT(v1) → regLogged → append(b0) → append(b1) → SHARD-LOSS |
| `R_teeth_lost_read_as_empty` R2/R3 teeth: tailRead answers ok/empty to an incarnation it does not hold (no refusal, so no re-plan); shard loss | I4_NoGapAtSeam | **I4_NoGapAtSeam** violated | 15 | 95,270 | 15 | 5.5 s | register(inc 1) → drainPUT(v1) → regLogged → append(b0) → seal(..1) → list(inc1 1..1) → read(inc1 1..1) → put(1..1) → drainCommit → plan → addUnit(inc1 1..1) → drainPUT(v2) → SHARD-LOSS → tail(inc1 >0)=∅ → done{} |
| `P_safety` proposed (as built + R2 + F16 fix): client retries, two flush Workers, 1 compaction, 1 retention removal, ledger loss + shard loss | all safety | stopped: memory bound: stopped at 4,000,001 states; every state reachable in at most 19 steps checked, no violation |  | 4,000,001 | 19 | 155.5 s |  |
| `P_maintenance` proposed: two compaction steps at once + retention + ledger loss + shard loss, no client retry, ≤ 2 sweep runs | all safety | stopped: memory bound: stopped at 4,000,002 states; every state reachable in at most 21 steps checked, no violation |  | 4,000,002 | 21 | 167.9 s |  |
| `P_F13x` proposed at F13's bounds (1 compaction, sweeper on), no client retry, ≤ 2 sweep runs | all safety | stopped: memory bound: stopped at 6,000,002 states; every state reachable in at most 28 steps checked, no violation |  | 6,000,002 | 28 | 356.3 s |  |
| `P_F14x` proposed at F14's bounds (two compaction steps at once, retention, ledger loss), sweeper on, ≤ 2 sweep runs | all safety | stopped: memory bound: stopped at 6,000,002 states; every state reachable in at most 31 steps checked, no violation |  | 6,000,002 | 31 | 282.4 s |  |
| `P_F15x` proposed at F15's bounds (2 flush Workers, shard loss + ledger loss), no client retry, ≤ 2 sweep runs | all safety | stopped: memory bound: stopped at 6,000,001 states; every state reachable in at most 23 steps checked, no violation |  | 6,000,001 | 23 | 233.3 s |  |
| `P_teeth_newer_committed` F16 fix teeth: a newer incarnation kills old flush files once COMMITTED (not logged); F15's bounds | I11_LiveFilesReadable | **I11_LiveFilesReadable** violated | 17 | 247,553 | 17 | 11.5 s | register(inc 1) → drainPUT(v1) → regLogged → append(b0) → seal(..1) → list(inc1 1..1) → read(inc1 1..1) → SHARD-LOSS → register(inc 2) → put(1..1) → sweepList → sweepRead→doomed L0(s0 inc1 1..1) → LEDGER-LOSS+rebuild → inc 2 → start: PUT base(inc 2) → start: commit(inc 2) → addUnit(inc1 1..1) → sweep(L0(s0 inc1 1..1)) |
| `LEAK_P_sl` no leak, proposed: compaction, retention (2 removals), shard loss, no ledger loss (LEAK_D30_sl's bounds); sweep, purge and ledger start as single steps | AG EF no leak | holds (exhaustive) |  | 1,093,981 | 52 | 67.2 s |  |
| `LEAK_P_sl_comp` no leaked compaction output, proposed: compaction, retention (1 removal), ledger loss + shard loss (LEAK_D30_sl_comp's bounds). Expected to stop at the retention bound, not at F16: the one removal is undone by the rebuild and not refunded; sweep, purge and ledger start as single steps | AG EF no leaked compaction output | **LIVE_NoLeakComp** violated; left: L0(s0 inc2 1..1) (sweep keeps it); L0(s0 inc2 2..2) (sweep keeps it); L1(L0(s0 inc2 1..1)+L0(s0 inc2 2..2)) (sweep keeps it) | 22 | 1,455,431 | 51 | 81.4 s | register(inc 1) → SHARD-LOSS → register(inc 2) → drainPUT(v1-v2) → regLogged → append(b0) → seal(..1) → append(b1) → seal(..2) → list(inc2 1..1) → read(inc2 1..1) → put(1..1) → addUnit(inc2 1..1) → list(inc2 2..2) → read(inc2 2..2) → put(2..2) → addUnit(inc2 2..2) → compRead → compPut → replace → expire(L1(L0(s0 inc2 1..1)+L0(s0 inc2 2..2))) → LEDGER-LOSS+rebuild |
| `LEAK_P_llsl` no leak of any object, proposed: compaction, retention (1 removal), ledger loss + shard loss. As LEAK_P_sl_comp: the retention bound; sweep, purge and ledger start as single steps | AG EF no leak | **LIVE_NoLeak** violated; left: L0(s0 inc2 1..1) (sweep keeps it); L0(s0 inc2 2..2) (sweep keeps it); L1(L0(s0 inc2 1..1)+L0(s0 inc2 2..2)) (sweep keeps it) | 22 | 1,455,431 | 51 | 57.7 s | register(inc 1) → SHARD-LOSS → register(inc 2) → drainPUT(v1-v2) → regLogged → append(b0) → seal(..1) → append(b1) → seal(..2) → list(inc2 1..1) → read(inc2 1..1) → put(1..1) → addUnit(inc2 1..1) → list(inc2 2..2) → read(inc2 2..2) → put(2..2) → addUnit(inc2 2..2) → compRead → compPut → replace → expire(L1(L0(s0 inc2 1..1)+L0(s0 inc2 2..2))) → LEDGER-LOSS+rebuild |
| `LEAK_P_sl_comp2` no leaked compaction output, proposed: compaction, retention (2 removals), ledger loss + shard loss; sweep, purge and ledger start as single steps | AG EF no leaked compaction output | holds (exhaustive) |  | 6,258,237 | 58 | 372.8 s |  |
| `LEAK_P_llsl2` no leak of any object, proposed: compaction, retention (2 removals), ledger loss + shard loss; sweep, purge and ledger start as single steps | AG EF no leak | holds (exhaustive) |  | 6,258,237 | 58 | 319.4 s |  |
| `LEAK_D30_sl_comp2` no leaked compaction output, D30 + log as built (amended protocol, as LEAK_D30_sl_comp): compaction, retention (2 removals), ledger loss + shard loss; sweep, purge and ledger start as single steps | AG EF no leaked compaction output | **LIVE_NoLeakComp** violated; left: L0(s0 inc1 1..1) (sweep keeps it); L0(s0 inc1 2..2) (sweep keeps it); L1(L0(s0 inc1 1..1)+L0(s0 inc1 2..2)) (sweep keeps it) | 19 | 6,061,928 | 58 | 325.5 s | register(inc 1) → drainPUT(v1) → regLogged → append(b0) → seal(..1) → append(b1) → seal(..2) → list(inc1 1..1) → read(inc1 1..1) → put(1..1) → addUnit(inc1 1..1) → list(inc1 2..2) → read(inc1 2..2) → SHARD-LOSS → put(2..2) → addUnit(inc1 2..2) → compRead → LEDGER-LOSS+rebuild → compPut |
| `LEAK_P_teeth_no_trigger` F16 fix teeth: the janitor does not ask the shard (the rule alone); LEAK_P_sl_comp2's bounds; sweep, purge and ledger start as single steps | AG EF no leaked compaction output | **LIVE_NoLeakComp** violated; left: L0(s0 inc1 1..1) (sweep keeps it); L0(s0 inc1 2..2) (sweep keeps it); L1(L0(s0 inc1 1..1)+L0(s0 inc1 2..2)) (sweep keeps it) | 19 | 6,062,003 | 58 | 305.1 s | register(inc 1) → drainPUT(v1) → regLogged → append(b0) → seal(..1) → append(b1) → seal(..2) → list(inc1 1..1) → read(inc1 1..1) → put(1..1) → addUnit(inc1 1..1) → list(inc1 2..2) → read(inc1 2..2) → SHARD-LOSS → put(2..2) → addUnit(inc1 2..2) → compRead → LEDGER-LOSS+rebuild → compPut |
| `LEAK_P_teeth_wm_rule` F16 fix teeth: the sweep keeps the rule as built (a newer incarnation counts once it has a logged UNIT); LEAK_P_sl_comp2's bounds; sweep, purge and ledger start as single steps | AG EF no leaked compaction output | **LIVE_NoLeakComp** violated; left: L0(s0 inc1 1..1) (sweep keeps it); L0(s0 inc1 2..2) (sweep keeps it); L1(L0(s0 inc1 1..1)+L0(s0 inc1 2..2)) (sweep keeps it) | 19 | 6,205,134 | 58 | 311.9 s | register(inc 1) → drainPUT(v1) → regLogged → append(b0) → seal(..1) → append(b1) → seal(..2) → list(inc1 1..1) → read(inc1 1..1) → put(1..1) → addUnit(inc1 1..1) → list(inc1 2..2) → read(inc1 2..2) → SHARD-LOSS → put(2..2) → addUnit(inc1 2..2) → compRead → LEDGER-LOSS+rebuild → compPut |
<!-- END BFS_PROPOSED -->

- **R1 fails.** `R1_safety`: I4 in 15 steps, F6(b) again by another road: the registration is
  committed, b0 acknowledged, a flush Worker writes its file; the ledger loses its storage and
  the rebuild has no trace of the stream; a query plans (no watermark for s0); the flush
  Worker's `addUnit` is admitted at `seqLo = 1` and re-registers the stream; it is logged; the
  shard loses its storage; the tail read with incarnation 0 gets `ok`, empty; b0, logged in a
  file the plan predates, is missing. Without a ledger loss R1 holds (`F6b_bounds_R1`), and it
  is live (`LIVE_R1_*`). So "committed" is not enough; this is also the tooth for R2's
  "logged".
- **R2, R3 and R4 pass every safety property** within their bounds: no violation among all
  states reachable in 19 (R2), 20 (R3) and 16 (R4) steps with client retries, two flush
  Workers, compaction, retention, a ledger loss and a shard loss; in 18, 18 and 15 steps with
  two shards, and 18, 19 and 15 with two tenants sharing a shard (4 million states each). At
  F6(b)'s own bounds I4 holds to 19 (R1), 23 (R2, R3) and 18 (R4) steps; F6(b)'s trace is
  11. R4's depth is the shallowest (its committed registration and the lazy paths it keeps
  allow more interleavings per step); it still covers R1's 15-step trace, and replaying that
  trace against R4 (`results/REPLAY.md`) shows the re-check refusing the attempt at its last
  step.
- **All four are live** (AG EF query done, whole graph): with a shard loss, and with a ledger
  loss and a shard loss (`LIVE_R*_sl`, `LIVE_R*_llsl`). `LIVE_impl`'s dead end (8 steps) is
  gone.
- **F6(b)'s recorded trace** (`results/REPLAY.md`, with the registration each variant needs put
  in front): in every variant the plan names the stream (`inc1@0`), so the tail read after the
  storage loss asks for incarnation 1 and is refused; the query re-plans instead of completing
  without b0.
- **Teeth.** Each step of R2 and R3, removed alone, brings a finding back: acceptance at the
  commit (R1: I4, 15 steps); no registration on a read (`LIVE_R2_teeth_no_read_trigger`) or no
  settling in the coordinator (`LIVE_R3_teeth_no_settle`): the query can never complete, 6
  steps (`LIVE_impl` back); a shard answering `ok`, empty to an incarnation it does not hold
  (`R_teeth_lost_read_as_empty`): I4 in 15 steps (F6(a) back).
- **The F16 fix** (`PROPOSED` = as built + R2 + `F16FIX`). Safety, I11's safety half
  included: no violation within 19 steps (client retries, both faults), 21 (two compaction
  steps at once, retention, both faults), and 28, 31 and 23 at F13's, F14's and F15's bounds,
  whose traces are 19, 21 and 17 steps (4 or 6 million states; bounded depth). The old
  flush-file leak is closed (`LEAK_P_sl` holds on its whole graph where `LEAK_D30_sl` leaked in
  11 steps), and so is F16: with two retention removals `LEAK_P_sl_comp2` (no compaction
  output leaks) and `LEAK_P_llsl2` (no object of any kind leaks) hold on their whole graphs
  (6.3 million states each), where D30 as built leaks at the same bounds
  (`LEAK_D30_sl_comp2`: F16's 19-step trace). Each half of the fix is load-bearing: without
  the janitor's call to the shard (`LEAK_P_teeth_no_trigger`), or with the sweep's rule as
  built (`LEAK_P_teeth_wm_rule`), F16's 19-step trace is back; counting a newer incarnation
  once merely committed brings F15 back (`P_teeth_newer_committed`, I11 in 17 steps: the
  registration of incarnation 2, made for the tenant's next write, is rolled back by a ledger
  rebuild after the sweep judged incarnation 1's file dead, and a flush Worker's late `addUnit`
  lists it with no object).
- **A bounds artefact, reported as found.** At `LEAK_D30_sl_comp`'s bounds (one retention
  removal) the proposal still has a dead end, at 22 steps (`LEAK_P_sl_comp`, `LEAK_P_llsl`):
  the one removal is spent on the compaction output, the ledger rebuild undoes it (it was not
  logged) but the model does not refund the budget, and compaction's one step is spent too, so
  the output's inputs, admitted again, can never be removed and D30 rightly keeps the output
  while its inputs remain. It is not a leak of the protocol: the same state is a dead end under
  D30 as built (`node bfs/replay.ts --deadend LEAK_P_sl_comp LEAK_D30_sl_comp`: goal
  unreachable, 294 states, complete), where F16's shorter 19-step trace hid it; and F16's own
  dead end is escapable under the proposal (`--deadend LEAK_D30_sl_comp LEAK_P_sl_comp`: goal
  reached). With a second removal, which a real retention always has, the proposal holds.

### Recommendation

**R2 with the F16 fix.** R2 and R3 cost the same on the acknowledgement path and both pass;
R2 changes fewer components (shard, ledger, janitor; the coordinator and flush stay as built),
and the call that lets a query finish after a storage loss (the shard starting and
registering a fresh incarnation) is the same call the janitor needs for F16, and the same
code as an append to a new stream: one mechanism, three callers. R3 needs a coordinator change
and still needs the shard's `ensureStream` for F16, and it leaves the ledger naming a lost
incarnation (one refused attempt per query) until the tenant writes there again.

R4 is the cheapest on writes (one round trip on the first append of a stream, no refused
append, no dependency on the ledger's R2 writes) and passes within its (shallower) bounds. It
pays on reads, one extra ledger round trip per query attempt that reads a shard its plan does
not name, and it restores statement 1 only after the fact: a stream whose registration a
rebuild rolled back is found because the coordinator asks every shard of the tenant's pool.
Across a shard-map change (not modelled) a shard that has left the pool would not be asked at
all; R2 makes every plan name it. Choose R4 only if the refused first append of R2 is measured
to matter.

**Cost of R2 on the acknowledgement path:** per stream lifetime (a tenant's first write to a
shard, or the first after that shard lost its storage), 1 + k shard→ledger round trips, k the
number of refused attempts until the registration is logged (1–2 at the measured PUT times,
3 at the slowest seen), and a first acknowledgement 0.5–1.5 s after the first append
(modelled); per append afterwards, none. No R2 PUT on any acknowledgement path. The F16 fix
adds nothing there: one shard RPC per stream with a pending flush file of its named
incarnation, per sweep run.

### Contract changes this implies (not made; for `contracts/`, in their own commit)

`contracts/ledger.ts`:

1. `LedgerRpc.registerStream` answers `{ version, previousIncarnation, logged: boolean }`.
   `logged`: the change that registered `ref.incarnation` (or a later change of the stream
   naming it) is in the logged prefix, so no rebuild can lose it. Additive; a caller that gets
   no `logged` (a ledger of an earlier release) must treat it as `false`, so ledgers are
   upgraded before shards (COMPATIBILITY.md §3.3, callee first).
2. Every `Watermark` that `loggedWatermarks()` returns, and every entry of
   `OrphanCheck.logged`, carries `loggedIncarnation: number`: the stream's incarnation as of the
   logged prefix (at most `incarnation`; equal once the registration of `incarnation` is
   logged). `seq` keeps its meaning (the logged watermark of `incarnation`).
3. `OrphanCheck` (and its comment): a flush file that is neither live nor tombstoned is dead
   when its range is at or below the logged watermark of its incarnation, **or when
   `loggedIncarnation` is newer than its incarnation** (replacing "a newer committed
   incarnation whose logged watermark is above 0", the F15 fix as built, which cost F16).
4. The replay-rules comment: "a unit for a shard the ledger has never seen is admitted only
   with `seqLo === 1`" stays, marked as the path of shards that do not register before writes.

The shard's surface (`shard/src/shard.ts`; it is not in `contracts/`):

5. `AppendResult` `backpressure.scope` gains `'registering'` (additive: a caller that does not
   know a scope treats it like the others).
6. `tailRead(tenant, incarnation ≠ 0, …)` for a stream it does not hold: the shard first starts
   a fresh incarnation and registers it, and the answer `incarnation_mismatch` names the fresh
   incarnation (today: 0). Answers to incarnation 0 are unchanged.
7. New `ensureStream(tenant): Promise<{ incarnation: number; registered: boolean }>`: what an
   append does before it is accepted, without a batch (for the janitor).
8. `ShardEnv.LEDGER` (the ledger namespace) becomes a binding of the shard; `JanitorEnv.SHARD`
   (the shard namespace) of the janitor.

### Code changes per component (for the owners; R2 + the F16 fix)

- **`shard/`.** Schema version 2: `stream.registered INTEGER NOT NULL DEFAULT 0` (1 once the
  ledger answered `logged: true` for this incarnation), rebuilt into memory in `load()`.
  `ensureRegistered(tenant, epoch)`: if no stream row, insert one (fresh incarnation,
  `registered = 0`) and let it commit; if `registered = 0`, call `registerStream` (outside any
  transaction; one call in flight per tenant, later callers await it); on `logged: true` set
  `registered = 1`. `append` calls it before joining a group and answers `backpressure` /
  `registering` unless the stream is registered; `commitGroup`'s `stream()` no longer creates
  streams. `tailRead` naming an incarnation the shard does not hold calls it and answers
  `incarnation_mismatch(current)`. `ensureStream` = `ensureRegistered` without a batch. A
  thrown `registerStream` (a lower incarnation: S5's clock step back) leaves the stream
  unregistered, so its writes are refused until an operator acts (fails closed). Existing
  streams at the upgrade start with `registered = 0` and are confirmed by their next append
  (one round trip each, a refusal only if the ledger's drain is behind).
- **`ledger/`.** `stream.logged_inc` (schema change): in `segmentWritten`, for each drained
  change with a watermark, `logged_inc = MAX(logged_inc, watermark.incarnation)` for its shard
  (no incarnation filter); a rebuild or restore sets `logged_inc = incarnation`; `register`
  does not touch it. Migration: `logged_inc = incarnation` if the outbox holds no change
  naming `(shard, incarnation)` (exact: a committed change not in the outbox is logged);
  otherwise `prev_incarnation ?? 0` (conservative: a value too low only keeps old flush files
  longer and makes a shard wait for the drain). `registerStream` returns
  `logged = logged_inc >= ref.incarnation`; `loggedWatermarks` and `orphanCheck` return
  `loggedIncarnation`.
- **`janitor/`.** `flushFileState`: dead iff `loggedIncarnation > inc`, or
  `incarnation === inc && seq >= seqHi` (old rule only when `loggedIncarnation` is absent: an
  older ledger). For each `pending_unit` file whose incarnation is the one the ledger names,
  call `SHARD.get(idFromName(shard with '_' → '/')).ensureStream(tenant)` once per stream per
  run; the file is judged again by a later run. D30's output rule is unchanged.
- **`flush/`, `query/`.** No change for R2. (R3 would change `readTail`; R4 would add the
  re-check after the tail reads.)
- **`edge/`.** None needed (an unknown backpressure scope is backpressure); it may surface
  `registering` as its own reason.

### Tests that would show it (each tied to a model trace)

Each is a model trace to replay against the code, in the Workers runtime (`cloudflare:test`,
storage loss as `deleteAll` and eviction), and each has a mutant that must make it fail
(AGENTS.md: break the rule in a scratch copy, confirm a test fails, list the mutants).

1. **"spec R1: a committed registration is not enough"** (`shard/` + `ledger/`), the 15 steps
   of `R1_safety`: with the ledger's drain held back, a fresh stream's first append is answered
   `backpressure` / `registering` and nothing is stored (R1 would acknowledge it: its step 2);
   once the ledger has drained, the retry is accepted. Then the rest of the trace with a ledger
   rebuild: the query's plan names the stream, and the query never completes without b0.
   Mutant: accept on `logged: false`.
2. **"spec F6(b)"** (integration, as the "spec F12" tests: shard + ledger + flush +
   coordinator), `F6b_impl_now` with the registration first (its replay against R2 in
   `results/REPLAY.md`, 15 steps): the query plans before the stream's first unit is admitted
   and the plan names the stream (`inc 1 @ 0`); the unit is admitted and logged; the shard loses
   its storage; the tail read is refused, never `ok`, empty; the re-planned attempt returns b0
   from the file. F6(b) has no code test today. Mutant: lazy registration (today's code).
3. **"spec F6 liveness"** (`shard/` + coordinator), `LIVE_R2_teeth_no_read_trigger`'s 6 steps
   (register, log, two appends, shard loss, no further write): the query's first attempt is
   refused; the shard now holds a fresh incarnation that the ledger has registered; the second
   attempt completes, without b0 and b1 (the declared loss). Mutant: `tailRead` does not start
   and register a fresh incarnation (today's code): every attempt is refused until the cap.
4. **`ledger/`**: `registerStream` answers `logged: false` until `segmentWritten` has committed
   the segment holding the registration, then `true`; `loggedIncarnation` moves only there,
   never at the commit; after `rebuildFromLog` it equals `incarnation`; the migration rule on a
   ledger whose outbox still holds a registration. Mutant: set `logged_inc` at the commit (test
   6 must fail too).
5. **"spec F16"** (`janitor/` + shard + ledger), the 19 steps of `LEAK_D30_sl_comp2` (F16's
   witness with the registration first): two units admitted, not yet logged, a compaction step
   reads both, the shard loses its storage, the ledger loses its storage (both admissions rolled
   back), the step PUTs its output. Sweep 1 keeps all three objects and
   calls `ensureStream` (the shard registers a fresh incarnation); after the drain, a later
   sweep deletes both flush files and then the output (an input absent and not live). Mutants:
   no `ensureStream` call (`LEAK_P_teeth_no_trigger`), the rule as built
   (`LEAK_P_teeth_wm_rule`): the three objects stay.
6. **"spec F15", adapted** (`janitor/`), `P_teeth_newer_committed`'s trace: an old-incarnation
   flush file is kept while a newer incarnation's registration (in the trace, for the tenant's
   next write; `ensureStream` makes the same one) is only committed; a rebuild then rolls the
   registration back and the flush Worker's late `addUnit` makes the file live with its object.
   Mutant: count the committed incarnation.

### What remains unproven

- **Bounded depth.** The safety rows stopped at their state caps (4 or 6 million states;
  every state within 15 to 31 steps checked, depending on the row). Only the liveness and leak
  rows covered their whole graphs, at small bounds: one send per batch, one flush Worker, no
  compaction in the `LIVE_*` rows, no query in the `LEAK_*` rows. AG EF with strong fairness,
  not a temporal formula under weak fairness.
- **Write availability is not checked**: that an append is eventually accepted. The model
  repeats a registration whenever the ledger does not know it; the code repeats it on each
  append attempt, tail read and `ensureStream`. A registration that is never logged (the
  ledger's drain stuck, `LogFault`) refuses that stream's writes for good: fails closed, and new.
- **Granularity.** The model creates a stream and commits its registration in one step; the
  code creates the row, then calls the ledger. Every interleaving of the two is equivalent to a
  modelled one (a stream with `registered = 0` only refuses writes). For the shard's
  acceptance the model calls a registration logged once its segment is in R2; the code once the
  drain's transaction has committed, which is later, so the code's behaviours are a subset. For
  the sweep the model uses the code's notion (`loggedIncs`).
- **Not modelled:** shard-map epochs and key moves (statement 1 is what a map change can rely
  on under R2; under R4 a stream whose registration was rolled back and whose shard has left the
  tenant's pool is not asked at all), S5 (a lower incarnation after a clock step back: the
  shard's registration throws), a rolling upgrade with shards of both releases, more than one
  shard storage loss in a run.
- **Not run:** R3 and R4 with the F16 fix; R1, R3 and R4 at the compaction-heavy bounds of
  `P_F13x`–`P_F15x`.
- **Costs are modelled**, from parts measured on Cloudflare (s4: 15–47 ms Worker→ledger round
  trip, 180–494 ms segment PUT) and the drain delay set in code (200 ms). The experiment that
  settles them: a spike that starts fresh streams on Cloudflare and times first append → first
  acknowledgement and the shard→ledger round trip (n ≥ 30, with an idle ledger and one under
  eight writers).

## Implementation / model mismatches

Read-only comparison of the model's actions with the code, first as of 2026-11-18 evening
(`IMPL_V1` in `bfs/run.ts`), then as of commit 6488856 on 2026-11-19 (`IMPL`; the protocol
paths are unchanged at 6ee76c8: the later diffs to `ledger.ts`, `shard.ts` and
`coordinator.ts` add shard-name validation, an alarm deletion, a flush-message version and
query splitting/explain). Rows say which version they describe. `IMPL` encodes the code's
choice for every row marked *modelled*.

### `shard/src/shard.ts`

| # | Code | Model / design | Consequence |
|---|---|---|---|
| S1 | `stream()` creates a stream (new incarnation) on the first `append` and never tells the ledger; the stream is registered later by `flush.ts` (first unit with `seqLo = 1`, or `registerStream` after `incarnation_mismatch`). | Design: register before accepting writes (§4.3). Modelled both ways (`reg: 'impl'` / `'design'` / `'logged'`). | Mostly safe for a fixed map because the coordinator also asks every pool shard the ledger does not know, from incarnation 0 (experiment (k) shows the gap otherwise); but a shard storage loss turns that read into F6(b), and lazy registration makes F12 possible. |
| S2 | `tailRead` for a tenant with no stream. On 2026-11-18: `ok`, empty, echoing the caller's incarnation. **At 6488856** (review R-10): `incarnation_mismatch(0)` when the caller names an incarnation, still `ok`/empty for incarnation 0. | `unknownStream: 'refuse'` answers exactly so (ok to incarnation 0). With registration before writes an unregistered stream is never asked. | **F6** (a) fixed; **F6(b) remains** while registration is lazy (`F6b_impl_now`); and nothing re-registers a stream the shard lost, so a query naming it is refused until the tenant writes to that shard again (`LIVE_impl`). |
| S3 | `pendingSegments` labels segments with the *current* incarnation. On 2026-11-18 `readSegment(tenant, seqLo)` took no incarnation. **At HEAD** `readSegment(tenant, seqLo, incarnation, seqHi)` returns null unless the stream is that incarnation and the segment exactly that range, and `flush.ts` passes both. | `readBound`. | **F12** fixed (code tests: `shard/test/review.test.ts`, `flush/test/flush.test.ts` "spec F12"). |
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
| L1 | Change log: at the start of this work one R2 object per change; now segments (`nextSegment`, `drainNow`, `segmentWritten`): bounds recorded and synced before the PUT, a retry writes exactly them, `logged` advanced (incarnation-checked) and rows deleted in one transaction after the PUT; mutations answer after the commit. | `log: 'segments'`, `drainRetrySame`. | Matches. "Logged" is the version prefix (F7 satisfied); F10 fixed. A record whose rows are gone stops the drain for good (fails closed; `loggedWatermarks` stops, shards keep rows): not modelled. |
| L2 | `addUnit` for an unknown shard registers it in the same transaction when `seqLo = 1`; different incarnation → `incarnation_mismatch`; `seqHi ≤ watermark` → `ok` replay; `seqLo ≠ watermark + 1` → `not_contiguous`; a live key → `invalid`. | Same. | Matches. `AddUnitResult.watermark` is the committed one (F8). |
| L3 | `registerStream`: same incarnation is a no-op, a lower one throws, a higher one resets watermark and `logged` to 0 and keeps `prev_incarnation`. | Same. | Matches. DESIGN §4.3 "the ledger records the boundary and raises an alert" is only `prev_incarnation`: no loss interval, no alert (not modelled). |
| L4 | `replace`: replay rule, `conflict` on a missing input, `invalid` on a live output; since this evening also `conflict` with `blocking` on overlapping precedence ranges. | Same except `blocking` (not modelled). | A `blocking` conflict sends `compact.ts` down the same delete-on-conflict path as F14. |
| L5 | Tombstones written in the removing transaction; `deletable` = removing version below the first unlogged version, older than `minAgeMs` by the ledger's clock, key not live; `forget` after the delete. | `purge` with `delLogged` + `delGrace` + not live. | Matches. Grace is time; the model assumes it exceeds every query (DESIGN 1 h vs 30 s query timeout). |
| L6 | `orphanCheck`: live keys, tombstoned keys and `logged` watermarks in one synchronous read; the incarnation it reports per stream is the *committed* one, with that incarnation's logged watermark (reset to 0 by a registration). | `sweep: 'impl'` (`sweepIncLogged: false`) before D30; `sweep: 'inputs'` (`sweepNewerLogged`) now. | Fixes F2 in code (DESIGN §4.3's sentence was not updated). The committed incarnation was **F15**; `janitor.ts` now counts a newer incarnation only when its logged watermark is above 0, which proves its registration is logged (the fix is in the reader, not in `orphanCheck`). |
| L7 | Rebuild replays only the NEWEST ledger incarnation (checkpoint or base segment, then the segments), strictly (each must start at the previous end + 1, or the rebuild refuses); the base carries tombstones, previous incarnations and unit refs. `startIncarnation`: number = max(newest in R2, the storage's own) + 1; the base segment is PUT (If-None-Match) **before** SQLite commits the incarnation, and every request waits in `gate()` until then; an interrupted start leaves a base-only incarnation in R2, which the next start replays and skips past. | `rebuild: 'strict'`, `baseFirst`, `baseTombstones`, `startSteps` (two steps, nothing served between, a second loss possible between). | Matches. Checkpoints and the conversion from the first layout (`mode 'sqlite'`) are not modelled. |
| L8 | Versions continue across incarnations (`base.version`); `plan` returns every registered stream and the files of a time range. | Relative versions; whole live set. | No effect on the properties checked. |

### Other code the model follows

| # | Code | Consequence |
|---|---|---|
| C1 | `compact.ts`. **First version** (`IMPL_V1`): output key = hash(input keys) + hash(bytes); `putFile` accepts an existing object with the same hash as written ("exists"); on `conflict` the step deleted its outputs unless one was live (later also unless tombstoned). **D30** (6488856): same keys; each output carries its inputs as R2 metadata `viz-inputs` (an adopted object keeps whatever metadata it has: none if written before D30); a step never deletes an output, not on conflict, `too_slow` or an unknown answer. | V1: **F13**, **F14**. D30: `compKey: 'inputs'`, `compConflictDelete: false`; checked in 2b. |
| C2 | `janitor.ts` `sweepOrphans`. **First version**: compaction outputs deleted by upload age only (≥ max(24 h, 2 × 5 min)); a flush file dead if its stream's logged watermark covers it or the ledger has a newer *committed* incarnation. **D30**: list the prefix (with metadata), then one `orphanCheck` for the listed keys and the absent inputs, then delete; a compaction output is doomed only if not live, not tombstoned, its inputs record readable and one input absent from the listing and not live; a newer incarnation makes old flush files dead only once its logged watermark is above 0; age floors remain (24 h; outputs max(24 h, 2 × `maxStepMs`)) but are not needed for safety. | V1: F13, **F15**. D30: `sweep: 'inputs'`, `sweepSteps`, `sweepAge: false`; checked in 2b with no clock. Leaks: F16. `janitor/README.md` still describes the first version (age rule for outputs). |
| C3 | `query/src/coordinator.ts`: asks every pool shard plus every registered stream; an unregistered stream is read from 0 at the incarnation the shard names; a learned newer incarnation is kept across re-plans; a missing planned file re-plans (F4 implemented); at most 3 refusals per shard or file, then 503. | Modelled (`query: 'impl'`). The 3-refusal cap turns F5's livelock into an error after 4 attempts. |
| C4 | `flush.ts`: tells the shard `recorded(loggedWatermarks())`, never the committed watermark (F8 handled by the caller). | Modelled. |

## Not implemented

- **Not modelled:** shard-map epochs and key moves (DESIGN §4.1), file precedence and the
  `blocking` conflict, partitions and index fragments, the publisher and Iceberg, rollups and
  hour closure, quotas and back-pressure, ledger checkpoints (review S-2 is about their cost,
  not their logic), the conversion of a first-layout ledger to segments (`startIncarnation`
  mode `sqlite`) other than as S-1's fix (b), the 4 MiB segment split, pairs of files
  (samples and series) as one unit.
- **Not in `viz.qnt`:** D30, the stepwise sweep, purge and ledger start, S-1 (see Limits).
- **Not run in this pass:** TLC on `viz.qnt` and the Quint tests (the model did not change;
  their results are the earlier pass's), `DESIGN_7` and the `A_*` runs (configurations
  unchanged; recorded before this pass), the components' own code-level replays of F12–F15
  (the coordinator reports CI green), S-1's fix (a) alone, exhaustive versions of the D30 and
  segment-log runs at the bounds of 2b (beyond 19 million states, or 1 GB, on this machine).

## Limits of the evidence

- **Bounds.** Exhaustive results hold for the bounds in each row and no further: at most
  3 batches, 2 shards, 2 tenants, one fault of each kind (two ledger rebuilds in two runs),
  one query at a time, two encoder outputs. A bug that needs four batches, two shard losses
  in one run, or overlapping compactions over three files is outside them; the simulation
  rows reach some such states but only sample them.
- **Two models, one reader.** Both models were written by reading the same design and code.
  Their agreement rules out many encoding slips, not a shared misreading of the text.
- **D30, the stepwise sweep, purge and ledger start, and S-1 are in the explicit-state model
  only.** `viz.qnt` was not extended (its compaction allows one step at a time and its "fixed"
  sweeper never deletes compaction outputs), so for these the second model is the adversarial
  review (`design/reviews/segment-log-and-compaction.md`), which found D30 safe independently.
- **Most of this pass's safety results are bounded-depth.** The D30 and segment-log runs
  stopped at their state caps (6 or 19 million) at depths 20–31; only `LOG_as_built_3LL`, the
  liveness runs marked "holds" and `LEAK_D30_ll` covered their whole graphs. The machine's
  load average was 7–23 on 4 cores during the runs, which set the caps.
- **Replayed against the code: partly, by the components' owners.** The F12 trace is an
  integration test in `shard/test/review.test.ts` and `flush/test/flush.test.ts` ("spec
  F12"); F13 (as review R-2) and F14 in `compact/test/compact.test.ts`; F15 in
  `janitor/test/janitor.test.ts`; F6(a) (review R-10) in `shard/test/shard.test.ts`. Each
  failed before its fix, according to those READMEs; this pass did not re-run them (the
  coordinator reports CI green). **F6(b) has no code test**: it is still present at HEAD
  (`F6b_impl_now`). Within the model, `bfs/replay.ts` re-runs each recorded counterexample
  against the configuration of the code as built (`results/REPLAY.md`).
- **Assumed, not fixed.** The amended protocol *assumes* no client retry across a shard
  storage loss (F3), retry horizon < fingerprint TTL, grace period > query lifetime, and (for
  the liveness proxy L2 only) query attempt < `retainRecordedMs`. (e), (g) and F5 show each is
  load-bearing.
- **Time is abstract.** Every timing rule is either nondeterministic or an assumption. F13's
  precondition (an output abandoned ≥ 24 h earlier with the same inputs) is a real but slow
  path that the model reaches in a few steps.
- **Liveness.** Checked as AG EF on the finite graph (with unbounded refusals), which with
  strong fairness implies termination; a run that stops at its cap decides nothing (several
  did: `LIVE_amended`, `LIVE_amended_ll`, the larger `LEAK_*`). The no-leak runs give
  retention a budget of removals and no new client writes, so "never deleted" there means
  "never, unless the tenant writes again"; that is what F16 says; no temporal formula under weak fairness was checked, and
  the bounded environment (finite batches, finite faults) eventually stops changing, which is
  what makes the stale-watermark refusals finite. F5 is the unbounded-ingest case.
- **Not modelled:** shard-map epochs, file precedence, partitions and index fragments, the
  publisher and Iceberg, rollups and hour closure, quotas and back-pressure, cross-tenant
  quotas. Two tenants are modelled only in one pooled shard with tiny bounds.
- **Fixes are modelled as rules.** That an amended run passes says the rule is sufficient
  within the bounds, not that an implementation of the rule is right. The same holds for
  "Proposed fixes" (R1–R4, the F16 fix): model only, nothing built; what they leave unproven
  is listed at the end of that section.
