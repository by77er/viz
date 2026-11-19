# Adversarial review: the segment log and the compaction/orphan-sweep redesign (snapshot `58b6bbd`)

Reviewer stance: adversarial, not the author. Scope: the ledger's change log as batched
segments (`contracts/LEDGER-LOG.md`, `contracts/ledger.ts`, `ledger/src/`, and its consumers in
`flush/`, `shard/`, `query/`, `stack/`) and the compaction / orphan-sweep redesign (`compact/src/`,
`janitor/src/`, `flush/src/`, D30). The findings were formed from the code and the contracts
against `design/VERIFICATION.md` §2 and `AGENTS.md`; `DECISIONS.md` (D30), the earlier review
`write-path-completion.md` and `spec/README.md` F6–F15 were read afterwards (last sections).

Everything was run on an extracted copy of `58b6bbd` in a scratch directory, never in the shared
tree (dependencies linked from the working tree, whose lockfiles are identical; the two WASM
engines copied from the working tree, whose sources are identical apart from licence fields and
build job counts).

**Summary.** No blocker. Two majors: a rollback across this release followed by a roll-forward
leaves every ledger that drained under the old code permanently stuck, and a later rebuild then
**silently** drops what the old code logged, below what shards were told they may discard
(the contract says such an incarnation is corrupt and must be refused; the code does not check);
and checkpoints are the whole ledger state as one JSON line, built synchronously inside the drain
every 256 segments and never deleted, which at the design's own scale costs seconds of blocked
object, memory near the 128 MB limit, and tens of GB of R2 per busy tenant per day. Seven minors,
most of them documents and evidence the change claims but the snapshot does not contain.
D30's deletion rule held up: I found no sequence in which the sweep deletes an object that can
still become live, and every D30/F14/F15 mutant is killed.

| # | Severity | Invariant / rule | Where (snapshot) | Shown by |
|---|---|---|---|---|
| S-1 | major | I1, I2, I5, I11; COMPATIBILITY §3.6, §9 | `ledger/src/ledger.ts:1238-1249`, `1270-1319`, `941-943`; `contracts/LEDGER-LOG.md:111`, `:146-149` | failing test |
| S-2 | major | cost; latency (LEDGER-LOG "addUnit < 20 ms"); memory | `ledger/src/ledger.ts:163`, `951-955`, `1004-1013`, `1114-1145`; `contracts/LEDGER-LOG.md:76-84`, `:99` | measured here, rest modelled |
| S-3 | minor | AGENTS rules 2–4, "Evidence" | `ledger/README.md`, `janitor/README.md`, `design/DESIGN.md:195`, `:506`, `contracts/LEDGER-LOG.md:5`, `:130`, `:171-175`, `stack/README.md:244` | reading |
| S-4 | minor | I5 (spec F8, now on the normal path) | `contracts/ledger.ts:92`; `shard/src/shard.ts:22`, `:768` | reading |
| S-5 | minor | I9, I11 (defence in depth) | `ledger/src/ledger.ts:1163-1165`; `janitor/src/janitor.ts:248-259` | reading |
| S-6 | minor | I11 (leaks), cost (idle wake-ups) | `janitor/src/janitor.ts:182-188`; `stack/src/maintain.ts:201` | reading |
| S-7 | minor | DO rules; I5 on an operator path | `ledger/src/ledger.ts:1094-1111`, `990-1002` | reading |
| S-8 | minor | I10 (publisher contract) | `contracts/LEDGER-LOG.md:107-133` | reading |
| S-9 | minor | "Tests must have teeth" | segment-log mutants, below | mutants run here |

---

## Major

### S-1. Rollback, then forward: the drain stops for good, and a rebuild silently drops what the old release logged

`LEDGER-LOG.md:111` says each incarnation uses one layout and "Both present is corrupt", and
`:146-149` that a rollback below this release leaves ledgers "unable to rebuild from R2 until
rolled forward (stuck, not lost)". Neither holds.

- `replayIncarnation` (`ledger.ts:1238-1249`) decides "segments" from one `seg-` key and checks
  only that `base.json` is absent. `replaySegments` (`1270-1319`) lists only `ckpt-` and `seg-`.
  Per-change objects `{version:012}.json` in a segment incarnation are never looked at.
- Nothing stops the previous release from running on this release's storage: the segment log
  "needed no new table" (`ledger.ts:176-179`), `LEDGER_SCHEMA` still has the one migration, and the
  release tool checks only Cloudflare migration tags (`deploy/README.md:528`, "Schema versions in
  the rollback check" not implemented). COMPATIBILITY §3.6 step 2 asks for exactly this release to
  be forward-only for storage, because the meaning of the outbox and `meta` rows changed.

**Sequence** (tenant T, ledger incarnation N in segments):

1. This release runs. Changes v..w are committed and in the outbox (normal: one drain cycle).
2. Rollback to the previous release (the first-layout ledger; `ledger/bench/asbuilt/ledger.ts` is
   its frozen copy). The storage opens. Its alarm drains v..w as `{N}/{v:012}.json` into the
   segment incarnation's prefix, deletes the rows and advances `logged` (asbuilt `drainNow`).
   Flush tells the shards `recorded` through w; they discard after `retainRecordedMs`. Its purge
   finds removals in v..w logged (below `MIN(outbox)`) and deletes their objects.
3. Roll forward. `open()` sees `log_format = 2` and serves. The next commit makes `nextSegment`
   throw `LogFault` "the outbox starts at version w+1, the log ends at v−1" (`941-943`): the drain
   is stopped for good (retried every 60 s), `loggedWatermarks()` never moves again, T's shards
   keep every row from then on and fill. This happens to **every** ledger that committed anything
   during the rollback window, and rolling forward does not repair it.
4. T's ledger loses its storage (or an operator rebuilds it). The rebuild finds a `seg-` key, no
   `base.json`, replays the segments up to v−1, ignores v..w, and starts N+1. No error.
5. Rows of (v−1, w] were discarded by the shards in step 2: lost (I1, I2; I5: a shard discarded
   past what the rebuilt ledger holds). Files removed in v..w are live again with their objects
   purged in step 2 (I11); every query over them re-plans until it is refused.

**Test** (scratch `ledger/test/review.test.ts`, "R1"; code under "How to reproduce"). The old
release's drain is applied with its own SQL, statement for statement. Result:

```
AssertionError: expected 'rebuilt at seq 1; a shard was told 2 …' not to match /^rebuilt at/
```

The drain after the roll-forward fails with `the outbox starts at version 6, the log ends at 4`,
and R2 holds both `seg-…jsonl` and `000000000005.json` under the same incarnation.

**Why major, not blocker.** No ledger is in production, and a rollback across this release is
declared unsupported. But the tool does not refuse it, the trial deployment ran the first layout,
and the outcome is the opposite of the documented one (stuck for good after rolling forward; lost
after a rebuild).

**Fix.** (a) Enforce "both present is corrupt": in `replayIncarnation`, list the incarnation for
`{12 digits}.json` keys and refuse when a `seg-` key is also present. (b) On open, treat "the
outbox does not continue `logged_through`" as "start a new incarnation from SQLite" (the `sqlite`
mode that already exists): SQLite holds the whole committed state, so the new base heals it
instead of stopping. (c) Make the boundary real: a storage migration with `readableFrom` = its own
version (COMPATIBILITY §2.3) so a versioned predecessor answers `schema_too_new` instead of
draining in the old layout, and put the release in the rollback floor (`deploy/` "Needed changes" 7).

### S-2. A checkpoint is the whole state in one JSON line, built synchronously in the drain, every 256 segments, never deleted

`nextSegment` (`951-955`) reads every file, stream and tombstone (`stateFromSqlite`, `1114-1127`),
builds the base change (`1130-1145`) and `JSON.stringify`s it, in the same synchronous step that
records the segment's bounds; `writeCheckpoint` (`1004-1013`) then builds the body and its UTF-8
bytes. The trigger is a count of segments (`CHECKPOINT_EVERY = 256`, `163`), i.e. the write rate,
not the state size or time. Log objects are never deleted (`LEDGER-LOG.md:99`).

**Measured here** (workerd, the shared 4-core machine, 2026-11-19; ±2× between runs). A ledger with
N live files, each with a 760-character index fragment (spike S4 measured about 0.8 KB per file):

| Live files | Checkpoint object | Synchronous part (read state, JSON, body, bytes) | Drain with checkpoint | Drain without |
|---|---|---|---|---|
| 8,000 | 9.2 MB | 137–246 ms | 0.49–0.79 s | 10–44 ms |
| 32,000 | 36.9 MB | 0.93–1.6 s | 1.6–4.2 s | 11–29 ms |

Consequences:

1. **Latency (measured cost, modelled frequency).** Under continuous load the drain is started by
   a commit (`afterCommit` → `kickDrain`, `499-500`); its `nextSegment` runs in a microtask queued
   before the committing call's answer, so that `addUnit`, and everything queued behind it, waits
   for the serialisation. At 1.5–3 segments/s (a 200 ms drain delay plus a 0.17–0.4 s PUT) that is
   every 85–170 s. The median of `addUnit` is untouched; its tail is not.
2. **Memory (modelled).** The JSON, the segment body and the bytes are three copies at once, plus
   the state's objects: past about 30,000 files that is above the 128 MB isolate limit, so the
   object would be reset in the middle of a drain every 256 segments, failing calls in flight. The
   design's own target is 300,000 files (`VERIFICATION.md` S4). The base at an incarnation start has
   the same shape (as `base.json` did before), but only at a start.
3. **Cost (modelled).** 500–1,000 checkpoints a day under steady load: 4.6–9 GB/day at 8,000 files,
   18–37 GB/day at 32,000, per tenant, kept for ever. At $0.015/GB-month that is $25–200/month per
   busy tenant after a year, growing linearly. The segments are bounded by the change volume; the
   checkpoints multiply the state size by the write rate.

**Experiment that settles it.** On Cloudflare: ledgers with 10k, 30k and 100k files, checkpoint every
segment, 17 units/s; record `addUnit` p50/p99 during a checkpoint, whether the object is reset
(memory), and R2 bytes written per day.

**Fix.** Checkpoint by size and time (for example when the segments since the last checkpoint
exceed the state's size, or at most hourly), write the state as many lines (a file per line)
built across awaits and outside the commit's microtask, and delete checkpoints (and segments)
below the newest one once the publisher's cursor is past them.

---

## Minor

### S-3. The change's documents and evidence are not in the snapshot (AGENTS rules 2–4, "Evidence")

- `ledger/README.md` still describes the first layout: the drain writes `ledgerLogKey` objects,
  "Known risks: the log write is on the request path" (`:242`), "Not implemented: periodic
  checkpoints" (`:228`) and conditional writes, "50 tests, 3 files" (`:117`; the suite has 75 in 5),
  a rebuild inside `blockConcurrencyWhile`. Nothing on segments, their tests or their mutants.
- `contracts/LEDGER-LOG.md` points to evidence that is not there: "Measurements before and after
  are in ledger/README.md" (`:5`), the publisher's "Needed changes" in the same README (`:130`),
  and "50 units per second … under 20 ms at the median: spikes/s4-ledger-scale/README.md"
  (`:171-175`), which holds only the before numbers (`rerun/` has a worker and no result). The
  performance claim that motivates the change is unevidenced.
- `design/DESIGN.md:195` "(As built, it waits for that R2 write …)" and `:506` "Not yet fixed".
- No `design/DECISIONS.md` entry for the segment log (segment trigger, checkpoint policy, log
  retention, the forward-only rollout were each a choice between real alternatives).
- `janitor/README.md` states the old age rule (`:46`), "protected by clocks" (`:108`), the
  default-on-unreadable retention the code now refuses (`:17`), and "10 tests" (17).
- `compact/README.md:163`: its suites were last run against the `dc2a1c3` ledger (synchronous
  log); the promised run against the real tree is not recorded. I ran it (green, below).
- `stack/README.md:244` lists "outputs of a conflicted merge are left behind" as a killed mutant;
  since D30 that is the intended behaviour. The review mutants (R-2, F14, F15) have no recorded
  results. I ran them (all killed, below).

### S-4. F8 is still open, and is now the normal case

`AddUnitResult.watermark` (`contracts/ledger.ts:92`) is the *committed* watermark, and the shard
documents `recorded` as "the ledger has admitted every file of segments up to `throughSeq`"
(`shard/src/shard.ts:22`, `:768`). Before the segment log, an `addUnit` that returned had (almost
always) been logged; now committed and logged differ for every unit by a drain cycle, or for as long
as the log is stuck. A caller that forwards `addUnit().watermark` to `recorded` loses rows at the
next rebuild. `flush/` does it right (`loggedWatermarks`). Fix as the spec says: rename the field
or document on both sides that `loggedWatermarks()` is the only source of `recorded`.

### S-5. A lost ledger whose log is not found starts empty, and the sweep then deletes compaction outputs

A start on new storage with no log in R2 starts an empty incarnation (`ledger.ts:1163-1165`); new
storage and lost storage look the same (`374-375`). If the log is not where the ledger looks (a
mis-bound bucket, a changed `CELL`, a deleted prefix), the tenant's ledger serves an empty live
set, and 24 h later the orphan sweep deletes every compaction output whose inputs were purged
(`janitor.ts:248-259`: not live, an input absent and not live). That turns a recoverable
misconfiguration into lost data. The old age rule did the same, so this is not new; D30 does not
make it worse. Defence: refuse to start empty while `{cell}/data/*/tenant={t}/` is not empty.

### S-6. Leftovers that are kept for ever keep the tenant's daily sweep alive

`pending_unit` flush files of an incarnation whose successor never logs a unit (the shard lost its
storage and the tenant no longer writes there; `janitor.ts:186-187`), and `unknown_stream` files
(a stream whose first unit was lost with the shard), are never deleted (I11), and because they are
kept for a reason other than `unknown_*`, `sweep` stays true (`maintain.ts:201`): an otherwise
idle tenant wakes its ledger and lists its whole prefix every day for ever. Outputs written before
D30 and then adopted and conflicted are kept for ever as `unknown_inputs` (acknowledged in D30).

### S-7. `rebuildFromLog` does not wait for an in-flight drain

`rebuildFromLog` (`1094-1111`) waits for a start, not for `this.draining`. A `segmentWritten` of the
old incarnation that completes after the restart runs against the new one: it deletes outbox rows
by version number (`992`; the new incarnation reuses those numbers when changes were lost), raises
`logged` with the old rows' watermarks (`996`), sets `logged_through` and drops a freshly recorded
segment (`998-1000`). Reachable only when storage is emptied in place (the README's "an operator
who has emptied the ledger"); a real storage loss is a new instance, and the tests' `loseStorage`
evicts. Fix: await `this.draining` there, and check the incarnation in `segmentWritten`.

### S-8. A new incarnation's base can be behind the old incarnation's last segment

An R2 PUT in flight when an instance dies can land after the rebuild listed
(`research/01-cloudflare-data-services.md:79`). The rebuilt state is still right (no shard was
told), but a publisher that read that late segment of N must re-base N+1 by replacing its state,
not by assuming the base extends its cursor, and the versions of that segment recur in N+1 with
other content. One sentence in LEDGER-LOG "Readers" before the publisher is built.

### S-9. Segment-log mutants

Applied by me to a second scratch copy of `ledger/` (never the shared tree), each run against
`segments`, `ledger` and `tombstone` tests:

MUTANT_RESULTS

---

## Suspected, checked, and safe

- **F10 and F11 as built.** The bounds are recorded and made durable (`storage.sync()`) before the
  PUT; a retry reads exactly the recorded rows, so the same key and bytes; `If-None-Match` with a
  byte compare. The base is in R2 before the incarnation commits; the number is
  max(R2, SQLite) + 1, so a base left by a crashed start is skipped. A late base PUT from a dead
  instance differs (`at`), so the loser faults and the next start takes the next number.
- **Crashes and evictions at every await** of the drain (record, sync, PUT, `segmentWritten`,
  checkpoint PUT) and of a start; loss during truncation (one transaction); loss during
  checkpointing (the checkpoint is the state at its segment's end, read in the same synchronous
  step and written after that segment, so it never runs ahead of the log; a lost one is skipped).
  Two ledger losses: the crash property test does up to two per seed, and I traced the F11 cases.
- **I5.** `logged` moves only in the transaction that deletes a written segment's rows, per stream
  incarnation, over a contiguous prefix; a rebuild sets it to the replayed watermark; tombstones
  are deletable only below `MIN(outbox)`. After any rebuild the watermark is at least every logged
  value a shard was told (crash property test).
- **I4 seam.** Queries plan at the committed watermark; shards discard at most to `recorded` ≤
  logged, so after a rebuild the rows above the (lower) watermark are still in the tail. The
  coordinator and compaction compare `(ledgerIncarnation, version)`, not bare versions.
- **DO rules.** `open()` does local work only; R2 work for a start runs outside
  `blockConcurrencyWhile` and gates requests (2 s, then retryable). Each mutation and its outbox
  row are one `transactionSync`. No R2 PUT on an acknowledgement path (`kickDrain` is not awaited;
  but see S-2 for CPU). One alarm at the earliest deadline, deleted when nothing is pending
  (`876-879`, `1050-1054`); a faulted log wakes the object every 60 s, deliberately. One row per change.
- **Flush across a rebuild.** `not_contiguous` re-reads both sides; `awaitingLog` retries; a shard
  is told only the logged mark. An old flush release against this ledger during a deploy leaves
  segments pending until a retry or the sweep: delay, not loss.
- **D30.** Only two code paths delete data objects (`janitor.ts:142`, `:265`). Purge deletes only
  logged, aged, non-live removals. The sweep deletes a flush file only below its stream's logged
  watermark (a replay forever after) or of an older incarnation whose successor has a logged unit
  (a logged unit implies its registration is in the logged prefix, so no rebuild brings the older
  incarnation back: F15 holds). A compaction output's key can be admitted again only with all its
  inputs live, and they left the live set in the logged change that admitted it. So "not live and
  object gone" is permanent, the listing-before-`orphanCheck` order is safe, and concurrent
  sweeps, purges and steps (including adoption and the `beforeDelete` race) cannot dangle a key.
  A re-PUT of a purged flush file by a late flush produces only a dead orphan. R2 listing is
  strongly consistent (research/01, docs). The premise fails only when the ledger's logged history
  is itself lost or ignored (S-1, S-5).
- **Checkpoints of an unknown version** are passed over for the base (`1278-1288`). That skips an
  accelerator, not a log entry; the segments still refuse what they do not know.
- **Tenant isolation.** One ledger per tenant; output inputs must lie under the output's own
  tenant and day, and hash to its key, or the object is kept.

## Does the stated reasoning hold

- **LEDGER-LOG.md.** Holds for crashes, evictions, retries and one or two storage losses (F10,
  F11 closed, tested, and their mutants killed). Does not hold for "stuck, not lost … until
  rolled forward" (S-1), for "a checkpoint is only an accelerator" as far as cost goes (S-2), or
  for its evidence pointers (S-3).
- **D30.** Holds (above). It has not been model-checked: the spec's amended protocol models
  step-unique keys, the alternative D30 rejected (`compact/README.md` says the model's owner was
  asked). The mutants for it are killed.
- **write-path-completion.md.** R-2 is closed by D30 (its tests pass, its mutants are killed). R-3
  is closed (start outside `blockConcurrencyWhile`, retryable refusal, checkpoints), but the
  checkpoints it asked for are the shape S-2 describes.
- **spec F6–F15.** F7, F10, F11, F12, F15 fixed; F13/F14 fixed by D30 rather than by the model's
  fix; F6 fixed for a named incarnation, form (b) remains with lazy registration (as stated); F8
  open and now routine (S-4); F9 still not in DESIGN, and its window is now a drain cycle or a
  stuck log; F1 (registration logged before writes) open by design, unchanged here except that
  the commit-to-log gap is now normal.

## How the snapshot was run

All on the extracted `58b6bbd`, at most two workers: ledger 75 passed; janitor 17; compact 24;
flush 45; shard 52; query 78; stack 40 (its `e2e` needs `bench/node_modules`, linked).
D30/F14/F15 mutants (`stack/scripts/mutants.mjs review` filtered to `R-2`, `F14`, `F15`):
9 of 9 killed. Not run: anything on Cloudflare; the protocol model.

## How to reproduce

S-1, added as `ledger/test/review.test.ts` in a copy (helpers from `ledger/test/helpers.ts`):

```ts
it('a rebuild must refuse an incarnation holding both layouts, never drop what shards were told is logged', async () => {
  const tenant = tenantName('rollback')
  const { l } = open(tenant)
  await l.registerStream({ shard: S, incarnation: INC })
  await l.addUnit(pair(1, 1))
  await l.drain()
  await l.addUnit(pair(2, 2)) // committed, in the outbox
  // Rollback: the previous release's drainNow (ledger/bench/asbuilt/ledger.ts), statement for statement.
  await runInDurableObject(l, async (_i, state) => {
    const sql = state.storage.sql
    for (;;) {
      const row = sql.exec(`SELECT version, body FROM outbox ORDER BY version LIMIT 1`).toArray()[0]
      if (!row) break
      const change = JSON.parse(row.body as string) as LedgerChange
      await env.BUCKET.put(`${env.CELL}/${ledgerLogKey(tenant, change.ledgerIncarnation, change.version)}`, row.body as string)
      state.storage.transactionSync(() => {
        sql.exec(`DELETE FROM outbox WHERE version = ?`, change.version)
        const w = change.watermark
        if (w) sql.exec(`UPDATE stream SET logged = MAX(logged, ?) WHERE shard = ? AND incarnation = ?`, w.seq, w.shard, w.incarnation)
      })
    }
  })
  expect(await loggedOf(l)).toBe(2) // a shard is told 2 and may discard it
  await evictDurableObject(l) // roll forward
  await l.addUnit(pair(3, 3))
  expect(await failure(l, (i) => i.drain())).toMatch(/outbox starts at version/) // stuck for good
  await loseStorage(l)
  const seq = (await everything(l)).watermarks.find((w) => w.shard === S)!.seq // (after the start; or a refusal)
  expect(seq).toBeGreaterThanOrEqual(2) // FAILS: 1
})
```

S-2: a ledger filled with 8,000 or 32,000 files (units of 4,000 files with 760-character
`index`), then `checkpointEvery` set to 1 or 10⁶ on the instance, one unit, `drain()` timed from
outside; the synchronous part timed as one `runInDurableObject` call doing
`JSON.stringify(baseChange(1, stateFromSqlite()))`, the body and `TextEncoder.encode`.
