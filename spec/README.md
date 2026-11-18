# spec — a formal model of the viz write/read protocol

A Quint model of client → shard stream → flush → ledger (+ R2 change log) → query seam, with
compaction, retention, physical deletion, the orphan sweeper, shard storage loss and ledger
storage loss + rebuild. Its purpose is to find design bugs before more code is written.

| File | Contents |
|---|---|
| `viz.qnt` | The model. Every protocol guard is a field of the constant `G`. |
| `experiments.mjs` | Generates one instance per experiment, runs it, writes `results/`. |
| `results/RESULTS.md` | Generated: every experiment with states, depth, time, and every counterexample step by step. |
| `results/*.json` | Generated: the same per experiment, including the exact configuration. |

```
npm install
npm run check          # everything below, about @@TOTAL@@ on 4 cores
npm run check:quick    # guard-off experiments + design-as-written + witnesses, about 20 minutes
node experiments.mjs <name> [...]      # single experiments; TRACE=1 adds action labels
```

Requirements: Node 22 and Java (17 was used). The first `quint verify` downloads Apalache
0.62.4 (which contains TLC) into `~/.quint`; that needs network access once.

## Tool, and what kind of evidence this is

- **Quint 0.33.1**, checked with **TLC** through `quint verify --backend tlc`. TLC is an
  explicit-state model checker: it enumerates every reachable state of the bounded model
  breadth-first. Results marked *exhaustive* are exhaustive **within the stated bounds**, not
  proofs for unbounded systems. TLC stores 64-bit state fingerprints, so "exhaustive" is up to
  a hash-collision probability that TLC reports (below 1e-3 for the largest run here, far
  lower for the others).
- Guard-off, design-as-written and witness experiments run TLC with one worker, which is strict
  breadth-first search, so **the counterexamples are shortest possible** in the model.
- Apalache (symbolic, `quint verify` default backend) was not used: TLC already gives an
  exhaustive result and shortest traces for this kind of model.
- The Quint **random simulator** (`quint run`, TypeScript backend; the Rust backend could not
  be downloaded in this sandbox) is used only for one configuration that is too large for
  TLC. That result is simulation, not model checking, and is labelled so.

## What is modelled

One tenant, 1–2 shards, 2–4 client batches. A batch is the unit of rows and of dedup; a `Row`
is one physical copy of a batch at `(shard, incarnation, seq)`.

| Component | Actions (model) | Source |
|---|---|---|
| Client | `clientAppend`: send or re-send any batch (up to `maxSend` times, also after a successful append: the acknowledgement may have been lost). Acked set is a ghost variable. | DESIGN §4.2 |
| Shard stream | `clientAppend` (durable, dedup by fingerprint), `seal`, `notify` (= `recorded(inc, through)`, only at the next segment boundary), `discard` (moves `disc`, the fence), `fpExpire`, `shardLoss` (new incarnation, sequences restart), `register` / `reRegister`. | `shard/src/shard.ts`: `append`, `sealStream`, `recorded`, `alarm`, `stream`, `tailRead` |
| Flush Worker | `flushRead` → `flushWrite` (PUT) → `flushReport` (`addUnit`), `flushCrash` at any point. Any segment the shard still holds can be read again, so two Workers can run for one segment, with the same or different encoder output (`variants`). | DESIGN §4.3 |
| Ledger | `addUnit` (contiguous, atomic, idempotent replay), `registerStream`, `replace` (`compRead`/`compWrite`/`compCommit`), `expire`, the outbox (`logWrite`: commit first, log later), `loggedWatermarks`, `ledgerLoss` (storage lost; state rebuilt from the logged prefix of the R2 log). | `contracts/ledger.ts`, DESIGN §4.3, §5.2 |
| Object store | `obj`; keys are content-addressed, or deterministic with `If-None-Match`, or deterministic with overwrite. `deleteRetired` (files the ledger removed) and `sweepOrphan` (the orphan sweeper). | DESIGN §4.3, §5.2, §5.3 |
| Query | `qPlan` (files + watermarks at one ledger version), then one `qTail` per shard as separate later steps, then `qFinish` (read files, merge). `stale_watermark`, `incarnation_mismatch` and an unreadable file restart from the plan. | DESIGN §2.3, §6.1, §6.2 |

Shard crash/restart needs no action of its own: the model's shard state is exactly the durable
state of `shard.ts` (its in-memory `Stream` map is rebuilt from storage by `load()`), every
multi-step interaction is a sequence of separate steps, and any of them can be abandoned
(`flushCrash`, `compCrash`, a `notify` that never happens).

### Properties (numbers from `design/VERIFICATION.md` §2)

| Name in `viz.qnt` | Statement |
|---|---|
| `I1_AckedIsDurable` (I1, I2) | Every acknowledged batch is in a shard's payload (`seq > disc`) or in a live ledger file whose object exists with the bytes the ledger describes. Exempt: batches removed by retention, and batches a shard storage loss destroyed above the ledger's *logged* watermark (the loss DESIGN §4.3 declares). |
| `I3_NoDuplicates` (I3) | A completed query returns no batch more than once. Checked on the raw merge, i.e. for signals without a `(series, ts)` key (logs, spans); for metrics the read-side de-duplication masks it. |
| `I4_NoGapAtSeam` (I2, I4) | A completed query returns every batch acknowledged before its (last) plan was read, with the exemptions of I1 evaluated at completion plus what retention had removed at the planned version. |
| `I5_DiscardOnlyLogged` (I5) | `disc ≤ rec ≤` the stream's watermark in the logged prefix of the change log, and `≤` the committed watermark. Because it is checked in every state it also says a rebuild never leaves a watermark below a discard mark. |
| `I11_LiveFilesReadable` (I11) | Every file the ledger lists exists and holds the bytes its metadata describes. |
| `I9_NoResurrection` (I9, I10) | No row removed by retention is in a live file. |
| `L1_StreamRegistered` | Liveness proxy: the ledger knows every stream that accepts writes. (False ⇒ `addUnit` and every tail read for that stream are refused for ever.) |
| `L2_NoRestart` | Liveness proxy: no query attempt is ever refused. Holds only under a timing assumption, see F5. |

### Abstracted away

- **Shard-map epoch change is not modelled** (key moving from shard A to B, draining,
  fingerprint hand-over). Routing is a fixed map. DESIGN §4.1's claims are unchecked.
- **One tenant.** All protocol state is per stream / per tenant ledger; a second tenant would be
  an independent copy. Cross-tenant isolation (I20) is not a property of this model.
- **Per-split retry** (§6.2) is not a separate mechanism here: a split is a key range that reads
  files and every shard's tail for that range from one plan, i.e. one query of this model per
  key range. The forbidden mix (files from V, watermark from V′) is experiment (k).
- **Time.** No clocks. Retention windows, TTLs and grace periods are either nondeterministic
  ("may happen at any time after it becomes legal") or an explicit assumption guard
  (`retain`, `delGrace`, `fpHorizon`).
- Rows are whole batches; one table and one partition; no index fragments, no publisher / Iceberg,
  no rollups, no hour closure, no quotas / back-pressure (I7), no group commit.
- `recorded` is one atomic read-ledger-then-tell-shard step. A delayed delivery only carries an
  older watermark, which `recorded` ignores, so nothing is lost by this.
- Retention removes one arbitrary whole file; compaction merges two arbitrary live files.
- At most one compaction and one query in flight; refusals per run are capped (`maxRestarts`).
- First sends happen in batch order (symmetry reduction); re-sends are unordered.

## Step 1 — the model has teeth

Baseline for these experiments is the *amended* protocol (all guards on, including the fixes
proposed below), which passes. Each row switches **one** guard off. Bounds: 1 shard, 2 batches,
each sent at most twice, at most 2 concurrent flushes; only the fault/maintenance actions the
row needs are enabled. Every row produced a counterexample for the expected property; none
failed to. Full step-by-step traces are in `results/RESULTS.md`.

@@TEETH@@

## Step 2 — the design as written, and the amended protocol

### 2a. DESIGN.md draft 3.1 as written

Configuration `LITERAL` in `experiments.mjs`: every guard the text states is on; where the text
is silent the charitable choice is made (`missingErr`, `logPrefix`), except where `shard.ts`
shows what happens today (`unknownStream: 'empty'`). `literal_all` (all actions, all safety
invariants) fails in 5 steps. The individual findings were then isolated one at a time against
the amended protocol:

@@LITERAL@@

### 2b. The amended protocol

`FIXED` = `LITERAL` + F1 (registration logged before writes; re-registration) + F2 (sweeper only
touches keys the change log never named) + F6 (a shard refuses a tail read for a stream it does
not hold) + the assumption that removes F3 (no client retry across a shard storage loss; F3 is
*assumed away*, not fixed). `missingErr` (F4) stays on. Checked invariants: `Safety` =
I1 ∧ I3 ∧ I4 ∧ I5 ∧ I11 ∧ I9.

@@FIXED@@

Common bounds unless the row says otherwise: 1 shard, 2 batches, ≤ 2 sends per batch,
≤ 2 flush Workers in flight and ≤ 3 flush attempts in total, ≤ 1 compaction, ≤ 1 retention
removal, ≤ 1 ledger storage loss, ≤ 1 shard storage loss, 1 query with ≤ 2 refusals,
1 encoder variant.

Not vacuous: `npm run check:witness` shows (by TLC counterexample) that in the amended protocol
each of these is reachable: a stale-watermark refusal, an incarnation-mismatch refusal, a
missing-file re-plan, an orphan sweep, a retired-file deletion, a `replace` conflict, a
re-registration, an `addUnit` replay, a query that returns every batch after a discard + a
compaction + a ledger rebuild, and a complete query after a shard storage loss.

Configurations that were tried and are **too large** for an exhaustive run here (stopped after
5–7 minutes at depth 22–23 with the frontier still growing): 1 shard / 3 batches / every action;
2 shards / 3 batches. They are covered only by simulation:

@@SIM@@

## Findings

Ordered by severity. "Trace" is the shortest counterexample TLC found; step-by-step versions
are in `results/RESULTS.md` under the experiment name.

### F1 (critical) — Stream registration is not covered by the "committed and logged" rule

- **Text.** §4.3: "A shard that loses its storage registers a new incarnation with the ledger
  before it accepts writes" and "[The ledger] tells a shard to discard only what has been both
  committed and logged." The second rule is stated for discard only.
- **Trace** (`literal_all`, `F1_registration_not_logged`; 5 steps): `register(shard 0)` commits
  in the ledger, its log entry is still in the outbox → the shard accepts and acknowledges
  batch 0 → the ledger loses its storage and is rebuilt from R2, which has no trace of the
  stream → `qPlan` returns no watermark for shard 0, so the query never asks it → the query
  completes without batch 0. Violates I4.
- **Impact.** Silent and unbounded: every acknowledged row of that stream is invisible to
  every query, with no refusal anywhere. It does not heal: the rebuilt ledger does not know the
  stream (`F1_registration_not_logged_L1`: `register`, ledger loss, 2 steps), so `addUnit` for
  it is refused, nothing in the design repeats the registration, the WAL fills and the sender
  gets 429. After a *shard* loss the same rollback leaves the ledger naming the old incarnation:
  every tail read and `addUnit` is then `incarnation_mismatch` for ever (loud, but permanent).
  The text also only requires registration after a storage loss; first use needs it too
  (experiment (j): 3 steps to a gap).
- **Fix.** A stream (first use or new incarnation) accepts writes only after its registration
  is **in the logged prefix** of the ledger's change log: `registerStream` answers only then,
  or the shard polls `loggedWatermarks()` until its incarnation appears. The shard repeats
  the (idempotent) registration whenever `addUnit` / `loggedWatermarks` shows the ledger does
  not know its incarnation. Modelled as `regLogged` + `reRegister`; passes.

### F2 (critical) — The orphan sweeper rule deletes files the ledger has removed, without the grace period and before the removal is logged

- **Text.** §4.3: "The orphan sweeper deletes only files that are unreferenced *and* belong to a
  sequence range below the stream's logged watermark." Every flush file that compaction or
  retention has taken out of the ledger satisfies this sentence.
- **Trace A — acknowledged data lost** (`F2_sweeper_unlogged_removal_I1`, 20 steps): two units
  admitted and logged; the shard is told `recorded` and discards → compaction `replace` commits
  (inputs out, output in) but its log entry is still in the outbox → the sweeper sees the two
  inputs unreferenced and below the logged watermark and deletes them → ledger storage loss;
  the rebuilt ledger lists the two inputs again; their objects are gone and the shard has
  discarded. Violates I1 and I11. §5.2/§5.3's "deleted only after the removal is published" is
  bypassed because the sweeper is a second deleter with a weaker rule.
- **Trace B — the grace period is bypassed** (`F2_sweeper_bypasses_grace`, 20 steps): a query
  plans at version V (files F1, F2) → `replace` commits → the sweeper deletes F1 at once → the
  query reads its planned files. With "missing = empty" the result silently lacks a batch
  (I4); with "missing = error" the query is refused although nothing violated the grace rule
  (`F2_sweeper_bypasses_grace_loud`). External engines reading a published snapshot hit the same
  missing object.
- **Related gap.** The sentence gives no rule for compaction outputs, which have no sequence
  range. Read literally they are never swept, so the output of a crashed or conflicting
  compaction leaks for ever (I11 "no leaked files"; reachable: `W_replaceConflict`). Read as
  "all its rows are below the watermark" the sweeper deletes an output between its PUT and its
  `replace`, and the ledger then lists a missing object (experiment (m), 18 steps).
- **Fix.** One sentence: *the sweeper may delete an object only if its key has never been named
  (added or removed) by any entry of the ledger's change log or outbox, and (for flush files)
  its sequence range is at or below the logged watermark; a file the ledger removed is deleted
  only by the retirement path of §5.2/§5.3.* Compaction outputs need the job-registration rule
  the draft-3 review proposed (register a job id in the ledger before the first PUT; sweep only
  after the job is recorded finished or abandoned). Modelled as `sweep: "fixed"`; passes.

### F6 (major) — A shard that no longer holds the stream answers a tail read with "ok, nothing"

- **Text / code.** `shard.ts` `tailRead`: `if (!s) return { status: 'ok', incarnation, through: aboveSeq, batches: [] }`.
  DESIGN says what a recreated shard does before *writes*, not what it answers to *reads*.
  (The draft-3 review, finding 8, warned about exactly this answer.)
- **Trace** (`F6_unknown_stream_reads_empty`, 12 steps): batch 0 acknowledged and sealed → a
  query plans (watermark 0, no files) → the flush unit for batch 0 is admitted and logged, so
  batch 0 is safely in the ledger → the shard loses its storage → the query's tail read
  "above 0" gets `ok` with no rows → the query completes without batch 0. Violates I4 although
  nothing was lost: the row is in a file the plan predates, and the fence that should have
  forced a re-plan vanished with the storage.
- **Impact.** A silent gap in every query in flight across a shard storage loss, including for
  rows that survived. Rule ticks evaluate on it.
- **Fix.** `tailRead(tenant, incarnation, aboveSeq)` for a stream the shard does not hold
  returns `incarnation_mismatch` (incarnation 0), never `ok`; a ledger plan only names streams
  that registered, so this case is never a legitimate "no data yet". The shard should also start
  the F1 handshake at that moment, otherwise queries for a tenant that stops sending are refused
  until its next write. Modelled as `unknownStream: "refuse"`; passes.

### F4 (major, unstated assumption) — "An unreadable planned file is an error that re-plans" is load-bearing and not in the text

- **Text.** §5.2 gives the grace period; nothing says what a reader does with a 404. The draft-3
  review asked for it to be stated ("checked and found sound … *provided* a missing object is
  always an error"); 3.1 did not add it.
- **Trace** (`F4_missing_file_must_be_error`, 16 steps, every other fix on): two flush Workers
  encode the same segment to different bytes, hence different keys K1, K2 → `addUnit(K1)`
  commits, not yet logged → a query plans at that version (file K1) → ledger storage loss and
  rebuild → the other Worker's `addUnit(K2)` is admitted and logged → K1 is a true orphan
  (never in the log, range below the logged watermark) and is swept → the query reads K1.
  If a missing file reads as empty: I4 violated. With the rule on, the query re-plans and is
  correct (this is in the exhaustive runs).
- **Fix.** State it in §6.2: a planned file that is missing or whose size/hash differs is an
  error that restarts the split from a fresh plan, never an empty input. Optionally serve plans
  only from logged versions, which removes this path at the cost of plan freshness.

### F3 (major for logs and spans; a consequence of a declared loss) — Fingerprints die with the shard's storage

- **Text.** §4.2.3: "Fingerprints are kept for longer than the documented client retry horizon,
  independently of WAL truncation." §4.3 says a storage loss loses rows and raises an alert; it
  does not say it also re-opens the dedup window.
- **Trace** (`F3_retry_after_shard_loss`, 15 steps): batch 0 acknowledged, sealed, read by a flush
  Worker → shard storage loss → the Worker's late `addUnit` is still admitted (the ledger has not
  heard of the new incarnation yet), so batch 0 is in a file → new incarnation registers →
  the client re-sends batch 0 (it never saw the acknowledgement, or is within its retry
  horizon) → accepted as new → a query returns it twice. Violates I3; permanent for signals
  without a `(series, ts)` key.
- **Fix (smallest).** Say so: the loss alert must read "rows may be missing **and duplicated**
  for one retry horizon". Real fix if wanted: flush units carry their batches' fingerprints, the
  ledger keeps them for the retry horizon, and a new incarnation is seeded with them at
  registration. The model does not implement this; the amended runs *assume* no retry across a
  storage loss (`noRetryAcrossLoss`).

### F5 (liveness, unstated timing assumption) — A query attempt is refused once per discard unless it is shorter than `retainRecordedMs`

- **Text.** §6.2: "Shards keep recorded segments for a short bounded time, and a refused split is
  retried on its own with a fresh ledger read, so a busy shard cannot make a whole query loop."
- **What the model shows.** Untimed, an adversarial schedule refuses the same query once for
  every segment the shard discards (`F5_restart_without_timing`: 3 segments, 3 refusals, 30
  steps; the pattern is plan → unit admitted, logged, recorded, discarded → `stale_watermark`,
  repeated). With unbounded ingest that is a loop, and one slow shard is enough: per-split
  retry does not help when the slow shard is the one that refuses. With the guard `retain`
  ("a segment is not discarded while an attempt planned before it was recorded is still waiting
  for that shard's tail") and no storage loss, **no attempt is ever refused**
  (`fixed_timing_no_restart`, exhaustive).
- **Why that guard is the right timing statement.** A plan read at t₀ carries watermark W. The
  shard's discard mark can exceed W only for a segment recorded after t₀ (recorded ≤ logged ≤
  committed watermark, and the plan read the committed watermark), and `alarm()` discards it no
  earlier than `recorded_at + retainRecordedMs`. So a tail read executed at the shard before
  t₀ + `retainRecordedMs` (30 s by default) is never refused.
- **Fix.** State the inequality and enforce it: *the deadline from plan read to the last tail read
  of a split is shorter than `retainRecordedMs`; a split past that deadline re-plans itself
  instead of asking.* Cursor-paginated queries re-plan per page. Under back-pressure the shard
  must not discard earlier than the window ("discards early only under pressure" in the draft-3
  review would break this).

### F7 (unstated assumption) — "Logged" must mean the contiguous prefix of ledger versions

- **Text.** §4.3 "both committed and logged"; `contracts/ledger.ts` `loggedWatermarks()`:
  "Highest sequence per stream that is both committed and durably logged to R2."
- **Trace** (experiment (i), `i_log_out_of_order_I1`): units for seq 1 and seq 2 commit as
  versions n, n+1; the outbox PUT for n+1 lands first; "the entry carrying watermark 2 is on R2"
  → `recorded(2)` → discard → ledger loss → the rebuild replays up to the gap (watermark 0, or
  watermark 2 without file 1 if it skips gaps). Violates I5 and I1.
- **Fix.** Define `logged_through` as the highest version such that it and every earlier version
  of this ledger incarnation are on R2, and `loggedWatermarks()` as the watermarks *as of*
  `logged_through`. The model's `logPrefix` guard is this rule.

### F8 (contract hazard) — `AddUnitResult.watermark` is the committed watermark

`addUnit` returns `{ status: 'ok', version, watermark }` and `Shard.recorded` cannot verify what
it is told. The obvious flush Worker ("unit admitted → tell the shard `recorded(seqHi)`") is
experiment (c): 8 steps to I5, 10 to lost data after a ledger rebuild. Fix: do not return a
watermark the caller could forward (or return `loggedWatermark` beside it and name the other
`committedWatermark`); document on `Shard.recorded` that its only legitimate source is
`LedgerRpc.loggedWatermarks()`; better, have the shard fetch it itself.

### F9 (minor) — A ledger rebuild can undo retention

An `expire` that was committed but not logged is rolled back by a rebuild; the files are live
and queryable again until retention next runs (the objects are still there, because deletion
waits for the removal to be logged). The model allows this (its `expired` ghost follows the
log). DESIGN should say retention is re-run after a rebuild; if erasure has a deadline, the
deadline must count from the logged removal.

## Implementation / model mismatches (`shard/src/shard.ts`, read-only review)

| # | `shard.ts` | Model / design | Consequence |
|---|---|---|---|
| 1 | `stream()` creates a stream on first `append` and never tells the ledger (README: "Incarnation handshake … not implemented"). | `register` before writes, logged (F1). | Experiment (j): acknowledged rows are invisible until the first unit is admitted, and `contracts/ledger.ts` does not say `addUnit` registers an unknown stream. |
| 2 | `tailRead` on an unknown stream returns `ok`, empty, echoing the caller's incarnation. | Must be `incarnation_mismatch`. | F6. |
| 3 | `readSegment(tenant, seqLo)` and `pendingSegments` are not bound to an incarnation; `readSegment` returns neither the incarnation nor `seqHi`. | `flushRead` is one atomic step that reads rows together with `(incarnation, lo, hi)`. | Outside the model, and a real hazard: a Worker that got `Segment{incarnation 1, lo 1, hi 5}` before a storage loss and calls `readSegment(tenant, 1)` after the recreated stream sealed its own segment at 1 receives incarnation 2's rows and reports them as incarnation 1's unit. Take `(incarnation, seqLo, seqHi)` and refuse a mismatch. |
| 4 | `recorded(tenant, incarnation, throughSeq)` trusts the caller. | `notify` reads `loggedWatermarks`. | F8. The boundary check itself matches the model (accepted iff `throughSeq > recordedThrough` and a segment ends at `throughSeq`; segments below the discard mark are deleted, so "a segment starts at `recordedThrough + 1`" is implied). |
| 5 | Incarnation = `Date.now() * 1024 + random(1024)`. | A counter that never repeats. | Uniqueness is probabilistic and order follows the wall clock; the ledger must compare incarnations only for equality. The draft-3 review's fix (the ledger issues incarnations) would remove both. |
| 6 | Fingerprints are forgotten `fingerprintTtlMs` after the batch's **first** append and only once its payload is discarded; a retry does not refresh the timer. | Same (`fpg ≤ disc`; `fpHorizon` is the assumption that no retry comes later). | Consistent. The retry horizon must be defined from the first send. Experiment (e) is what happens otherwise. |
| 7 | `append` seals in the same call when `sealBytes` is reached; `alarm` discards through the *highest* eligible boundary. | `seal` and `discard` are separate, nondeterministic. | The implementation's behaviours are a subset of the model's. |
| 8 | Discard is timed from `recorded_at` on the shard's own clock. | `retain` guard. | Matches the argument in F5; no cross-machine clock is involved. |
| 9 | Epoch: `append` refuses `req.epoch < stream.epoch` and adopts a higher one; no "closed for epoch", no draining, no fingerprint hand-over (README says so). | Not modelled. | Unchecked on both sides. |
| 10 | Fence: `aboveSeq < discardedThrough` → `stale_watermark`; payloads NULLed and the mark moved in one synchronous block. | `qTail` / `discard`. | Matches. |

## Limits of the evidence

- Exhaustive results hold for the bounds in the tables and no further: at most 3 batches,
  2 shards, one fault of each kind (two ledger rebuilds in one run), one query at a time,
  two refusals. A bug that needs four batches, two shard losses, or two overlapping compactions
  is outside them; the simulation run reaches such states but only samples them.
- The amended protocol *assumes* (does not implement) no retry across a shard storage loss (F3),
  retry horizon < fingerprint TTL, and grace period > query lifetime. The last two are the
  design's own assumptions, shown load-bearing by experiments (e) and (g).
- No epoch change, no publisher, one tenant, no clocks (see "Abstracted away").
- Liveness is checked only through safety proxies (L1, L2) and by exhibiting traces; no
  temporal property under fairness was model-checked.
- The model was written from the design and from reading `shard.ts`; traces have not been
  replayed against the code. The mismatches listed above come from reading, not from running.
- The fixes are modelled as guards. That they pass says the *rule* is sufficient within the
  bounds, not that an implementation of the rule is right.
